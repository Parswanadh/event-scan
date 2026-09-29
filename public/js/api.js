/**
 * Thin API client for the attendance Worker.
 *
 * The organizer token is a stateless HMAC blob minted by POST /api/auth; it is
 * kept in localStorage so a refresh at the venue does not force a re-entry of
 * the PIN. It carries no personal data and expires server-side.
 */

const TOKEN_KEY = 'attendance.token.v1';
const EVENT_KEY = 'attendance.event.v1';

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private mode — the app still works, the organizer just re-enters the PIN */
  }
}

export function getEventName() {
  try {
    return localStorage.getItem(EVENT_KEY) || '';
  } catch {
    return '';
  }
}

export function setEventName(name) {
  try {
    localStorage.setItem(EVENT_KEY, name || '');
  } catch {
    /* ignore */
  }
}

async function request(path, { method = 'GET', body, auth = false, raw = false } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth) {
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  let res;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    const e = new Error('Network unreachable — check the connection and try again.');
    e.offline = true;
    e.cause = err;
    throw e;
  }

  if (raw) {
    if (!res.ok) {
      const e = new Error(`Request failed (${res.status})`);
      e.status = res.status;
      throw e;
    }
    return res;
  }

  let data = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { ok: false, error: 'bad_response', detail: text.slice(0, 200) };
    }
  }

  if (!res.ok) {
    const e = new Error(
      data?.detail || data?.error || `Request failed (${res.status})`,
    );
    e.status = res.status;
    e.code = data?.error;
    e.payload = data;
    throw e;
  }
  return data;
}

export const api = {
  health: () => request('/api/health'),

  auth: (pin) => request('/api/auth', { method: 'POST', body: { pin } }),

  scan: (payload, { force = false } = {}) =>
    request('/api/scan', { method: 'POST', body: { ...payload, force } }),

  scans: ({ q = '', event = '', limit = 200 } = {}) => {
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    if (event) p.set('event', event);
    p.set('limit', String(limit));
    return request(`/api/scans?${p}`, { auth: true });
  },

  summary: ({ event = '' } = {}) => {
    const p = new URLSearchParams();
    if (event) p.set('event', event);
    const qs = p.toString();
    return request(`/api/summary${qs ? `?${qs}` : ''}`, { auth: true });
  },

  events: () => request('/api/events', { auth: true }),

  roster: (entries) => request('/api/roster', { method: 'POST', body: { entries }, auth: true }),

  exportUrl: ({ event = '' } = {}) => {
    const p = new URLSearchParams();
    if (event) p.set('event', event);
    const qs = p.toString();
    return `/api/export.csv${qs ? `?${qs}` : ''}`;
  },

  /** Export needs the Authorization header, so it cannot be a plain <a href>. */
  downloadExport: async ({ event = '' } = {}) => {
    const res = await request(api.exportUrl({ event }), { auth: true, raw: true });
    const blob = await res.blob();
    const disposition = res.headers.get('Content-Disposition') || '';
    const match = /filename="([^"]+)"/.exec(disposition);
    const name = match ? match[1] : 'attendance.csv';
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    return name;
  },
};
