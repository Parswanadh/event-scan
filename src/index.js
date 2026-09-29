/**
 * Event attendance scanner — Cloudflare Worker API.
 *
 * Routes (all JSON unless noted):
 *   GET  /api/health              liveness + D1 reachability            (public)
 *   POST /api/auth                exchange organizer PIN for a token     (public, rate limited)
 *   POST /api/scan                record one attendance entry            (public)
 *   GET  /api/scans               list scans, newest first               (organizer)
 *   GET  /api/summary             headline counts + total hours          (organizer)
 *   GET  /api/events              list event names                       (organizer)
 *   POST /api/roster              bulk upsert reg_no -> name             (organizer)
 *   GET  /api/export.csv          Excel-compatible CSV download          (organizer)
 *
 * Everything that is not /api/* is served from the ./public asset directory;
 * wrangler.jsonc routes only /api/* through this script.
 *
 * The registration-number normalizer is imported from the front-end module on
 * purpose: one implementation, used by both the scanner UI and the server, so
 * the two can never disagree about what a scanned barcode means.
 */

import { normalizeRegNo, isValidRegNo } from '../public/js/regno.js';

const enc = new TextEncoder();

/* ------------------------------------------------------------------ config */

const AUTH_WINDOW_SEC = 900; // rate-limit window
const AUTH_MAX_FAILS = 8; // failures per IP per window before 429
const SESSION_TTL_SEC = 60 * 60 * 12; // organizer session length

const MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

/**
 * Minimum minutes between marking someone IN and letting a scan mark them OUT.
 *
 * The door rule: the first scan of the day is an arrival. A scan 40+ minutes
 * later is a departure. Anything sooner is almost always the organizer
 * double-tapping or a student walking back past the desk, so it is refused
 * unless the client explicitly forces it after showing the organizer the
 * elapsed time.
 */
const MIN_SESSION_MINUTES = 40;

/** Bound in SQL as a literal so the rule is identical everywhere it is reported. */
const FIRST_PERIOD = 1;
const LAST_PERIOD = 8;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Max-Age': '86400',
};

/* ------------------------------------------------------------------ helpers */

const json = (data, status = 200, extraHeaders = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...CORS,
      ...extraHeaders,
    },
  });

const fail = (status, error, detail) =>
  json(detail === undefined ? { ok: false, error } : { ok: false, error, detail }, status);

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}

/** Length-independent, branch-free byte comparison. */
function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Compare two secrets without leaking their length through timing: hash both
 * first, so the compared values are always 32 bytes.
 */
async function secretEquals(a, b) {
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(String(a))),
    crypto.subtle.digest('SHA-256', enc.encode(String(b))),
  ]);
  return constantTimeEqual(new Uint8Array(ha), new Uint8Array(hb));
}

async function issueToken(secret) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SEC;
  const payload = `org.${exp}`;
  return { token: `${exp}.${b64url(await hmac(secret, payload))}`, exp };
}

async function verifyToken(request, env) {
  const header = request.headers.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token || !env.SESSION_SECRET) return false;
  const dot = token.indexOf('.');
  if (dot < 1) return false;
  const expRaw = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
  const expected = await hmac(env.SESSION_SECRET, `org.${exp}`);
  let given;
  try {
    given = b64urlDecode(sig);
  } catch {
    return false;
  }
  return constantTimeEqual(expected, given);
}

async function readJson(request) {
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > MAX_BODY_BYTES) throw new HttpError(413, 'payload_too_large');
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, 'payload_too_large');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'invalid_json');
  }
}

class HttpError extends Error {
  constructor(status, error, detail) {
    super(error);
    this.status = status;
    this.error = error;
    this.detail = detail;
  }
}

const clientIp = (request) =>
  request.headers.get('CF-Connecting-IP') ||
  request.headers.get('x-forwarded-for')?.split(',')[0].trim() ||
  'unknown';

/* -------------------------------------------------------------- validation */

const asInt = (v) => {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
  return Number.isInteger(n) ? n : null;
};

const cleanText = (v, max) => {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return s ? s.slice(0, max) : null;
};

/** Normalize an ISO timestamp that came from a browser, rejecting nonsense. */
function safeIso(value, now = Date.now()) {
  if (typeof value === 'string') {
    const t = Date.parse(value);
    // Accept anything within 48h either side of now; a wildly wrong device clock
    // must not poison the sheet with a 1970 or year-3000 timestamp.
    if (Number.isFinite(t) && Math.abs(t - now) < 48 * 3600 * 1000) {
      return new Date(t).toISOString();
    }
  }
  return new Date(now).toISOString();
}

/** Derive hours from a period selection. Authoritative — the client's number is ignored. */
function parsePeriods(body) {
  let raw = body.periods;

  if (typeof raw === 'string') raw = raw.split(/[^0-9]+/);

  if (Array.isArray(raw)) {
    // A period outside 1..8 is a client bug, not something to silently drop.
    for (const v of raw) {
      const n = asInt(v);
      if (n !== null && (n < FIRST_PERIOD || n > LAST_PERIOD)) {
        throw new HttpError(400, 'invalid_periods', `periods must be between ${FIRST_PERIOD} and ${LAST_PERIOD}`);
      }
    }
  } else {
    raw = [];
  }

  const nums = [...new Set(raw.map(asInt).filter((n) => n !== null && n >= FIRST_PERIOD && n <= LAST_PERIOD))]
    .sort((a, b) => a - b);

  // Accept a range too, so an older client (or a curled request) still works.
  if (!nums.length && body.periods === undefined) {
    const start = asInt(body.period_start);
    const end = asInt(body.period_end);
    if (start !== null && end !== null) {
      if (start < FIRST_PERIOD || end > LAST_PERIOD || start > end) {
        throw new HttpError(400, 'invalid_period_range', `periods must satisfy ${FIRST_PERIOD} <= start <= end <= ${LAST_PERIOD}`);
      }
      for (let p = start; p <= end; p++) nums.push(p);
    }
  }

  if (!nums.length) return { periods: [], hours: null };
  return { periods: nums, hours: nums.length };
}

/**
 * Current presence state for one student in one event.
 *
 * A student's rows for an event are strictly sequential, so "the latest row"
 * answers everything: an `in` row means they are currently inside, an `out` row
 * (or no row) means they are not.
 */
async function getState(env, regNo, eventId) {
  const last = await env.DB
    .prepare(
      `SELECT id, direction, scanned_at, scanned_at_local, periods,
              period_start, period_end, hours
         FROM scans
        WHERE reg_no = ? AND event_id = ?
        ORDER BY id DESC LIMIT 1`,
    )
    .bind(regNo, eventId)
    .first();

  if (!last) {
    return { state: 'new', open: null, last: null, minutes: null, suggest: 'in' };
  }

  if (last.direction === 'in') {
    const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(last.scanned_at)) / 60000));
    return {
      state: 'in',
      open: { ...last, minutes },
      last,
      minutes,
      suggest: 'out',
      too_soon: minutes < MIN_SESSION_MINUTES,
      min_gap_minutes: MIN_SESSION_MINUTES,
    };
  }

  return { state: 'out', open: null, last, minutes: null, suggest: 'in' };
}

async function handleStatus(request, env, url) {
  const regNo = normalizeRegNo(url.searchParams.get('reg_no') ?? '');
  if (!regNo) throw new HttpError(400, 'missing_reg_no');
  const event = await ensureEvent(env, url.searchParams.get('event'));
  const st = await getState(env, regNo, event.id);
  return json({ ok: true, reg_no: regNo, event: event.name, ...st });
}

/* ------------------------------------------------------------------- routes */

async function handleAuth(request, env) {
  if (!env.ORGANIZER_PIN || !env.SESSION_SECRET) {
    return fail(500, 'server_not_configured', 'ORGANIZER_PIN / SESSION_SECRET secrets are not set');
  }
  const body = await readJson(request);
  const pin = cleanText(body.pin, 64) ?? '';

  // Rate limit: count recent failures for this IP before doing any work.
  const ip = clientIp(request);
  const since = Math.floor(Date.now() / 1000) - AUTH_WINDOW_SEC;
  const recent = await env.DB
    .prepare('SELECT COUNT(*) AS n FROM auth_attempts WHERE ip = ? AND attempted_at > ?')
    .bind(ip, since)
    .first();
  if ((recent?.n ?? 0) >= AUTH_MAX_FAILS) {
    return json(
      { ok: false, error: 'too_many_attempts', detail: `try again in ${AUTH_WINDOW_SEC / 60} minutes` },
      429,
      { 'Retry-After': String(AUTH_WINDOW_SEC) },
    );
  }

  if (!(await secretEquals(pin, env.ORGANIZER_PIN))) {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO auth_attempts (ip, attempted_at) VALUES (?, ?)')
        .bind(ip, Math.floor(Date.now() / 1000)),
      env.DB.prepare('DELETE FROM auth_attempts WHERE attempted_at < ?')
        .bind(Math.floor(Date.now() / 1000) - AUTH_WINDOW_SEC * 4),
    ]);
    const left = Math.max(0, AUTH_MAX_FAILS - (recent?.n ?? 0) - 1);
    return json({ ok: false, error: 'invalid_pin', attempts_left: left }, 401);
  }

  await env.DB.prepare('DELETE FROM auth_attempts WHERE ip = ?').bind(ip).run();
  const { token, exp } = await issueToken(env.SESSION_SECRET);
  return json({ ok: true, token, exp, role: 'organizer' });
}

/**
 * Make sure `name` exists in `events` and return its id. Cheap upsert; the
 * common case is a single organizer hammering one event name all day.
 */
async function ensureEvent(env, name) {
  const clean = cleanText(name, 120) || 'General';
  await env.DB.prepare('INSERT OR IGNORE INTO events (name) VALUES (?)').bind(clean).run();
  const row = await env.DB.prepare('SELECT id FROM events WHERE name = ?').bind(clean).first();
  return { id: row?.id ?? null, name: clean };
}

async function handleScan(request, env) {
  const body = await readJson(request);
  const rawCode = cleanText(body.raw_code, 512);

  // Prefer the explicit field, but fall back to normalizing the raw payload:
  // a client that only sends raw_code still lands on the correct reg number.
  let regNo = normalizeRegNo(body.reg_no ?? '');
  if (!regNo && rawCode) regNo = normalizeRegNo(rawCode);
  if (!regNo) return fail(400, 'missing_reg_no', 'no registration number could be read from the scan');
  if (regNo.length < 4) return fail(400, 'invalid_reg_no', 'registration number is too short');

  const { periods, hours } = parsePeriods(body);
  const periodStart = periods.length ? periods[0] : null;
  const periodEnd = periods.length ? periods[periods.length - 1] : null;
  const now = Date.now();
  const scannedAt = safeIso(cleanText(body.scanned_at, 40), now);
  const scannedAtLocal = cleanText(body.scanned_at_local, 40);
  const event = await ensureEvent(env, body.event_name);
  const force = body.force === true;

  // ── the IN/OUT state machine ──────────────────────────────────────────────
  const st = await getState(env, regNo, event.id);

  let direction = cleanText(body.direction, 8)?.toLowerCase() || null;
  if (direction !== 'in' && direction !== 'out') direction = st.suggest;

  if (direction === 'in' && st.state === 'in') {
    return json(
      {
        ok: false, error: 'already_in',
        detail: `marked IN ${st.minutes} min ago`,
        state: 'in', open: st.open, minutes: st.minutes, suggest: 'out',
      },
      409,
    );
  }
  if (direction === 'out' && st.state !== 'in') {
    return json(
      {
        ok: false, error: 'no_open_session',
        detail: 'no open IN to close — mark them IN first',
        state: st.state, suggest: 'in',
      },
      409,
    );
  }

  // Closing a session: refuse an implausibly short one unless forced, so a
  // double-tap at the desk cannot record a zero-minute attendance.
  let sessionMinutes = null;
  if (direction === 'out') {
    sessionMinutes = Math.max(0, Math.round((now - Date.parse(st.open.scanned_at)) / 60000));
    if (sessionMinutes < MIN_SESSION_MINUTES && !force) {
      return json(
        {
          ok: false, error: 'too_soon',
          detail: `marked IN only ${sessionMinutes} min ago — ${MIN_SESSION_MINUTES} min minimum`,
          state: 'in', open: st.open, minutes: sessionMinutes,
          min_gap_minutes: MIN_SESSION_MINUTES, suggest: 'out',
        },
        409,
      );
    }
  }

  const scanType = cleanText(body.scan_type, 24) || (direction === 'in' ? 'check-in' : 'check-out');

  const res = await env.DB
    .prepare(
      `INSERT INTO scans
         (reg_no, raw_code, event_id, event_name, direction, scan_type,
          periods, period_start, period_end, hours, session_minutes,
          scanned_at, scanned_at_local, device, ua, note)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .bind(
      regNo, rawCode, event.id, event.name, direction, scanType,
      periods.join(',') || null, periodStart, periodEnd, hours, sessionMinutes,
      scannedAt, scannedAtLocal,
      cleanText(body.device, 120), cleanText(request.headers.get('User-Agent'), 250),
      cleanText(body.note, 250),
    )
    .run();

  return json(
    {
      ok: true,
      id: res.meta?.last_row_id ?? null,
      reg_no: regNo,
      valid_reg_no: isValidRegNo(regNo),
      raw_code: rawCode,
      event: event.name,
      direction,
      state: direction, // after this write, the student is in this state
      periods,
      period_start: periodStart,
      period_end: periodEnd,
      hours,
      session_minutes: sessionMinutes,
      scanned_at: scannedAt,
      scanned_at_local: scannedAtLocal,
    },
    201,
  );
}

async function requireOrganizer(request, env) {
  if (!(await verifyToken(request, env))) throw new HttpError(401, 'unauthorized');
}

function parseListQuery(url) {
  const p = url.searchParams;
  const limit = Math.min(MAX_LIMIT, Math.max(1, asInt(p.get('limit')) ?? DEFAULT_LIMIT));
  const q = cleanText(p.get('q'), 120);
  const eventName = cleanText(p.get('event'), 120);
  return { limit, q, eventName, offset: Math.max(0, asInt(p.get('offset')) ?? 0) };
}

async function handleScans(request, env, url) {
  await requireOrganizer(request, env);
  const { limit, q, eventName, offset } = parseListQuery(url);

  const where = [];
  const binds = [];
  if (q) {
    where.push('(s.reg_no LIKE ? OR r.name LIKE ?)');
    binds.push(`%${q}%`, `%${q}%`);
  }
  if (eventName) {
    where.push('s.event_name = ?');
    binds.push(eventName);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const rows = await env.DB
    .prepare(
      `SELECT s.id, s.reg_no, s.event_name, s.scan_type, s.direction,
              s.periods, s.period_start, s.period_end, s.hours, s.session_minutes,
              s.scanned_at, s.scanned_at_local, s.device, r.name
         FROM scans s
         LEFT JOIN roster r ON r.reg_no = s.reg_no
         ${clause}
        ORDER BY s.scanned_at DESC, s.id DESC
        LIMIT ? OFFSET ?`,
    )
    .bind(...binds, limit, offset)
    .all();

  const total = await env.DB
    .prepare(
      `SELECT COUNT(*) AS n FROM scans s LEFT JOIN roster r ON r.reg_no = s.reg_no ${clause}`,
    )
    .bind(...binds)
    .first();

  return json({ ok: true, count: rows.results?.length ?? 0, total: total?.n ?? 0, scans: rows.results ?? [] });
}

async function handleSummary(request, env, url) {
  await requireOrganizer(request, env);
  const eventName = cleanText(url.searchParams.get('event'), 120);
  const clause = eventName ? 'WHERE event_name = ?' : '';
  const binds = eventName ? [eventName] : [];

  const totals = await env.DB
    .prepare(
      `SELECT COUNT(*) AS scans,
              COUNT(DISTINCT reg_no) AS students,
              COALESCE(SUM(hours), 0) AS hours,
              COALESCE(SUM(session_minutes), 0) AS session_minutes,
              MAX(scanned_at) AS last_scan
         FROM scans ${clause}`,
    )
    .bind(...binds)
    .first();

  // "Who is inside right now": a student's rows are sequential, so take each
  // student's newest row and count the ones that are still an open `in`.
  const insideWhere = eventName ? 'WHERE s.event_name = ?' : '';
  const inside = await env.DB
    .prepare(
      `SELECT COUNT(*) AS in_now
         FROM (SELECT reg_no, event_id, MAX(id) AS mid
                 FROM scans ${clause}
                GROUP BY reg_no, event_id) t
         JOIN scans s ON s.id = t.mid
         ${insideWhere} AND s.direction = 'in'`,
    )
    .bind(...binds, ...binds)
    .first();

  const events = await env.DB
    .prepare('SELECT name, (SELECT COUNT(*) FROM scans WHERE event_id = events.id) AS scans FROM events ORDER BY name')
    .all();

  return json({
    ok: true,
    ...totals,
    in_now: inside?.in_now ?? 0,
    min_gap_minutes: MIN_SESSION_MINUTES,
    events: events.results ?? [],
  });
}

/** Public, non-secret UI hints. The PIN length is not the protection — rate limiting is. */
function handleConfig(env) {
  const pin = String(env.ORGANIZER_PIN ?? '');
  return json({
    ok: true,
    pin_length: pin.length || 6,
    min_gap_minutes: MIN_SESSION_MINUTES,
    periods: { first: FIRST_PERIOD, last: LAST_PERIOD },
  });
}

async function handleEvents(request, env) {
  await requireOrganizer(request, env);
  const rows = await env.DB
    .prepare('SELECT id, name, created_at FROM events ORDER BY name')
    .all();
  return json({ ok: true, events: rows.results ?? [] });
}

async function handleRoster(request, env) {
  await requireOrganizer(request, env);
  const body = await readJson(request);
  const entries = Array.isArray(body.entries) ? body.entries.slice(0, 5000) : [];
  if (!entries.length) throw new HttpError(400, 'empty_roster');

  const stmts = [];
  for (const e of entries) {
    const reg = normalizeRegNo(e?.reg_no ?? '');
    if (!reg) continue;
    stmts.push(
      env.DB
        .prepare(
          `INSERT INTO roster (reg_no, name) VALUES (?, ?)
             ON CONFLICT(reg_no) DO UPDATE SET name = excluded.name`,
        )
        .bind(reg, cleanText(e?.name, 120)),
    );
  }
  if (!stmts.length) throw new HttpError(400, 'no_valid_entries');
  await env.DB.batch(stmts);
  return json({ ok: true, imported: stmts.length });
}

/** RFC-4180 quoting, plus a UTF-8 BOM so Excel opens it as UTF-8 rather than ANSI. */
function csvCell(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function handleExport(request, env, url) {
  await requireOrganizer(request, env);
  const eventName = cleanText(url.searchParams.get('event'), 120);
  const clause = eventName ? 'WHERE s.event_name = ?' : '';
  const binds = eventName ? [eventName] : [];

  const rows = await env.DB
    .prepare(
      `SELECT s.id, s.reg_no, COALESCE(r.name, '') AS name, s.event_name, s.scan_type,
              s.direction, s.periods, s.period_start, s.period_end, s.hours,
              s.session_minutes, s.scanned_at, s.scanned_at_local, s.device, s.raw_code
         FROM scans s
         LEFT JOIN roster r ON r.reg_no = s.reg_no
         ${clause}
        ORDER BY s.scanned_at ASC, s.id ASC`,
    )
    .bind(...binds)
    .all();

  const header = [
    'ID', 'Registration No', 'Name', 'Event', 'Type', 'Direction',
    'Periods', 'Period From', 'Period To', 'Hours',
    'Session Minutes', 'Scanned At (UTC)', 'Scanned At (Local)', 'Device', 'Raw Barcode',
  ];
  const lines = [header.join(',')];
  for (const r of rows.results ?? []) {
    lines.push([
      r.id, r.reg_no, r.name, r.event_name, r.scan_type, r.direction,
      r.periods, r.period_start, r.period_end, r.hours,
      r.session_minutes, r.scanned_at, r.scanned_at_local, r.device, r.raw_code,
    ].map(csvCell).join(','));
  }

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const slug = (eventName || 'all').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 40);

  return new Response('\ufeff' + lines.join('\r\n') + '\r\n', {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="attendance-${slug}-${stamp}.csv"`,
      'Cache-Control': 'no-store',
      ...CORS,
    },
  });
}

/* -------------------------------------------------------------- entry point */

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  if (!path.startsWith('/api/')) {
    // Only reachable if run_worker_first is misconfigured; still serve assets
    // correctly rather than 404-ing the whole site.
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return fail(404, 'not_found');
  }

  switch (`${request.method} ${path}`) {
    case 'GET /api/health': {
      const started = Date.now();
      const row = await env.DB.prepare('SELECT 1 AS ok').first();
      const tables = await env.DB
        .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('scans','events','roster','auth_attempts')")
        .first();
      return json({
        ok: row?.ok === 1,
        db: 'reachable',
        tables: tables?.n ?? 0,
        time: new Date().toISOString(),
        latency_ms: Date.now() - started,
      });
    }
    case 'POST /api/auth':
      return handleAuth(request, env);
    case 'GET /api/config':
      return handleConfig(env);
    case 'GET /api/status':
      return handleStatus(request, env, url);
    case 'POST /api/scan':
      return handleScan(request, env);
    case 'GET /api/scans':
      return handleScans(request, env, url);
    case 'GET /api/summary':
      return handleSummary(request, env, url);
    case 'GET /api/events':
      return handleEvents(request, env);
    case 'POST /api/roster':
      return handleRoster(request, env);
    case 'GET /api/export.csv':
    case 'GET /api/export':
      return handleExport(request, env, url);
    default:
      return fail(404, 'no_such_route', `${request.method} ${path}`);
  }
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env);
    } catch (err) {
      if (err instanceof HttpError) return fail(err.status, err.error, err.detail);
      console.error('unhandled', err && err.stack ? err.stack : String(err));
      return fail(500, 'internal_error', err && err.message ? String(err.message).slice(0, 200) : undefined);
    }
  },
};
