/**
 * App controller: view routing, the scan -> confirm -> record flow, the period
 * ruler, and the attendance sheet.
 *
 * There is one working mode. Anybody can scan on behalf of anybody — a volunteer
 * at the door takes a stack of ID cards and works through them. The PIN guards
 * only *reading* the sheet: viewing and exporting it. It never gates scanning,
 * because a queue at the door must never be blocked on a password.
 *
 * No framework and no client-side URL router — views are toggled with the
 * `hidden` attribute, which keeps the Worker's asset routing trivial.
 */

import { api, getToken, setToken, getEventName, setEventName } from './api.js';
import { createScanner } from './scanner.js';
import { normalizeRegNo } from './regno.js';
import { listVideoInputs, rankCameras, hasLabels } from './camera.js';

const $ = (id) => document.getElementById(id);

const el = {
  sheetBtn: $('sheetBtn'),
  sheetLabel: $('sheetLabel'),

  pinForm: $('pinForm'),
  pinInput: $('pinInput'),
  pinError: $('pinError'),
  pinSubmit: $('pinSubmit'),

  video: $('video'),
  scanStatus: $('scanStatus'),
  scanError: $('scanError'),
  camLabel: $('camLabel'),
  engineLabel: $('engineLabel'),
  btnSwitch: $('btnSwitch'),
  btnTorch: $('btnTorch'),
  btnManual: $('btnManual'),
  manualForm: $('manualForm'),
  manualInput: $('manualInput'),

  confirmHero: $('confirmHero'),
  confirmRegNo: $('confirmRegNo'),
  confirmRaw: $('confirmRaw'),
  eventName: $('eventName'),
  eventList: $('eventList'),
  statusBanner: $('statusBanner'),
  statusTitle: $('statusTitle'),
  statusSub: $('statusSub'),
  dirToggle: $('dirToggle'),
  dirInMeta: $('dirInMeta'),
  dirOutMeta: $('dirOutMeta'),
  dirHint: $('dirHint'),
  periodChips: $('periodChips'),
  periodHint: $('periodHint'),
  hoursOut: $('hoursOut'),
  confirmError: $('confirmError'),
  btnSubmit: $('btnSubmit'),

  resultBox: $('resultBox'),
  resultMark: $('resultMark'),
  resultTitle: $('resultTitle'),
  resultSub: $('resultSub'),
  resultFacts: $('resultFacts'),
  btnScanNext: $('btnScanNext'),

  dashStats: $('dashStats'),
  statStudents: $('statStudents'),
  statInside: $('statInside'),
  dashSearch: $('dashSearch'),
  btnRefresh: $('btnRefresh'),
  btnExport: $('btnExport'),
  btnExportJson: $('btnExportJson'),
  dashUpdated: $('dashUpdated'),
  dashList: $('dashList'),
  dashEmpty: $('dashEmpty'),
  btnSignOut: $('btnSignOut'),

  debugTable: $('debugTable'),
  debugCaps: $('debugCaps'),

  toast: $('toast'),
};

const state = {
  eventName: getEventName() || 'General',
  pending: null, // { raw, regNo, format, via }
  lastResult: null,
  periods: new Set(), // selected period numbers, 1..8
  direction: 'in', // 'in' | 'out' — what the next submit will record
  status: null, // last /api/status response for the scanned card
  minGapMinutes: 40, // replaced by /api/config on load
  forceNext: false, // set when the server refused and a second tap overrides
  scanCount: 0,
};

let scanner = null;
let wakeLock = null;
let toastTimer = null;

/* ------------------------------------------------------------------- chrome */

const VIEWS = ['pin', 'scan', 'confirm', 'done', 'dash', 'debug'];

function showView(name) {
  for (const v of VIEWS) {
    const node = $(`view-${v}`);
    if (!node) continue;
    const active = v === name;
    node.hidden = !active;
    node.classList.toggle('is-active', active);
  }
  window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
}

function showError(node, message) {
  if (!node) return;
  node.textContent = message || '';
  node.hidden = !message;
}

function toast(message) {
  if (!el.toast) return;
  el.toast.textContent = message;
  el.toast.hidden = false;
  el.toast.classList.add('is-active');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.toast.classList.remove('is-active');
    el.toast.hidden = true;
  }, 2600);
}

function setSheetState(unlocked) {
  el.sheetLabel.textContent = unlocked ? 'Sheet' : 'Sheet';
  el.sheetBtn.classList.toggle('is-unlocked', Boolean(unlocked));
  el.sheetBtn.title = unlocked
    ? 'View and export the attendance sheet'
    : 'Enter the PIN to view the attendance sheet';
}

/* --------------------------------------------------------------- wake lock */

async function keepAwake() {
  try {
    if ('wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => {
        wakeLock = null;
      });
    }
  } catch {
    /* unsupported or denied — the scan still works */
  }
}

async function releaseAwake() {
  try {
    await wakeLock?.release?.();
  } catch {
    /* ignore */
  }
  wakeLock = null;
}

/* ------------------------------------------------------- periods & direction */

/**
 * Period selection: eight independent chips, tap to toggle.
 *
 * This replaced a two-handle range slider. Tapping is simpler one-handed — the
 * operator is holding an ID card in the other hand — and it is strictly more
 * expressive: P1+P2+P5 is representable, which a range never was.
 */
function buildPeriodChips() {
  el.periodChips.innerHTML = '';
  for (let p = 1; p <= 8; p++) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'period';
    b.dataset.period = String(p);
    b.textContent = `P${p}`;
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => {
      if (state.periods.has(p)) state.periods.delete(p);
      else state.periods.add(p);
      renderPeriods();
    });
    el.periodChips.appendChild(b);
  }
}

function renderPeriods() {
  for (const b of el.periodChips.children) {
    const p = Number(b.dataset.period);
    const on = state.periods.has(p);
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-pressed', String(on));
  }
  const n = state.periods.size;
  el.hoursOut.textContent = `${n} ${n === 1 ? 'hour' : 'hours'}`;
  el.periodHint.textContent = n
    ? `Selected ${periodsLabel()} · hours = number of selected periods`
    : 'Tap the periods this student attended.';
}

/** Collapse runs so P1,P2,P3,P4 reads as "P1–P4" rather than four numbers. */
function periodsLabel(list) {
  const nums = (list || [...state.periods]).slice().sort((a, b) => a - b);
  if (!nums.length) return '—';
  const parts = [];
  let start = nums[0];
  let prev = nums[0];
  for (let i = 1; i <= nums.length; i++) {
    const cur = nums[i];
    if (cur !== prev + 1) {
      parts.push(start === prev ? `P${start}` : `P${start}–P${prev}`);
      start = cur;
    }
    prev = cur;
  }
  return parts.join(', ');
}

/* ------------------------------------------------------------ IN / OUT state */

const DIR_LABEL = { in: 'IN', out: 'OUT' };

function timeOnly(stamp) {
  const m = /(\d{2}:\d{2})/.exec(String(stamp || ''));
  return m ? m[1] : '—';
}

function selectDirection(dir, { userChosen = false } = {}) {
  state.direction = dir;
  for (const b of el.dirToggle.children) {
    const on = b.dataset.dir === dir;
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-pressed', String(on));
  }
  if (userChosen) el.dirHint.textContent = 'manual override';
  const label = DIR_LABEL[dir];
  el.confirmHero.textContent = `Mark ${label}`;
  if (!state.forceNext) el.btnSubmit.textContent = `Record ${label}`;
}

/**
 * Show what the server says about this student's current presence, and arm the
 * direction it implies. The organizer can always override with the toggle.
 */
function renderStatus(st) {
  state.status = st;
  state.forceNext = false;
  const banner = el.statusBanner;
  banner.classList.remove('status--in', 'status--out', 'status--new', 'status--warn');

  const mins = st.minutes;
  const minsText = mins === null || mins === undefined ? '' : `${mins} min`;
  const since = st.state === 'in' && st.open
    ? timeOnly(st.open.scanned_at_local || st.open.scanned_at)
    : null;

  if (st.state === 'new') {
    banner.classList.add('status--new');
    el.statusTitle.textContent = 'First scan for this event';
    el.statusSub.textContent = 'Nothing recorded yet — this will be an IN.';
  } else if (st.state === 'in') {
    banner.classList.add(st.too_soon ? 'status--warn' : 'status--in');
    el.statusTitle.textContent = st.too_soon
      ? `Already IN · only ${minsText} ago`
      : `Currently IN · ${minsText}`;
    el.statusSub.textContent = `since ${since}${st.periods ? ` · marked ${st.periods}` : ''}`;
  } else {
    banner.classList.add('status--out');
    el.statusTitle.textContent = 'Currently OUT';
    el.statusSub.textContent = st.last
      ? `last scanned ${timeOnly(st.last.scanned_at_local || st.last.scanned_at)}`
      : 'no previous session';
  }

  // Only one direction is ever legal, but the toggle stays visible so the
  // operator can see why and force the other one deliberately.
  const inOpt = el.dirToggle.querySelector('[data-dir="in"]');
  const outOpt = el.dirToggle.querySelector('[data-dir="out"]');
  inOpt.disabled = st.state === 'in';
  outOpt.disabled = st.state !== 'in';
  el.dirInMeta.textContent = st.state === 'in' ? 'already in' : 'arrival';
  el.dirOutMeta.textContent = st.state === 'in' ? (minsText || 'departure') : 'needs an IN';

  selectDirection(st.suggest || 'in');
  el.dirHint.textContent = st.too_soon
    ? `under ${state.minGapMinutes} min — OUT will ask to confirm`
    : 'tap to override';
}

/* ------------------------------------------------------------------- flows */

async function gotoScan() {
  showError(el.scanError, '');
  el.manualForm.hidden = true;
  showView('scan');
  await startScanner();
}

async function startScanner() {
  if (!scanner) {
    scanner = createScanner({
      video: el.video,
      onStatus: (text, tone) => {
        el.scanStatus.textContent = text;
        el.scanStatus.dataset.tone = tone || '';
      },
      onEngine: (name) => {
        el.engineLabel.textContent = `engine: ${name}`;
      },
      onResult: (result) => {
        releaseAwake();
        scanner?.pause();
        handleScanResult(result);
      },
      onDebug: (info) => {
        el.camLabel.textContent = `camera: ${info.label}`;
        renderDebug(info);
      },
    });
  }
  try {
    await scanner.start();
    keepAwake();
    el.btnTorch.hidden = !scanner.torchAvailable();
  } catch (err) {
    showError(el.scanError, err?.message || 'Camera unavailable.');
  }
}

/**
 * A card was read. Before showing the confirm screen, ask the server what this
 * student's current presence is, because that decides whether this scan is an
 * arrival or a departure.
 */
async function handleScanResult({ raw, regNo, format, via }) {
  state.pending = { raw, regNo, format, via };
  state.forceNext = false;
  el.confirmRegNo.value = regNo;
  el.confirmRaw.textContent = raw && raw !== regNo
    ? `raw barcode: ${raw.length > 60 ? `${raw.slice(0, 60)}…` : raw} · ${format} · ${via}`
    : `read via ${via} · ${format}`;
  showError(el.confirmError, '');
  el.eventName.value = state.eventName || 'General';

  // Nothing is preselected: the periods are a deliberate choice, not a default.
  state.periods.clear();
  renderPeriods();

  el.statusBanner.classList.remove('status--in', 'status--out', 'status--new', 'status--warn');
  el.statusTitle.textContent = 'Checking current status…';
  el.statusSub.textContent = '';
  selectDirection('in');
  el.btnSubmit.disabled = true;

  showView('confirm');

  try {
    const st = await api.status(regNo, state.eventName);
    renderStatus(st);
  } catch (err) {
    // A status lookup failure must not block recording — assume a fresh arrival
    // and let the server arbitrate, since it re-checks the same rule on write.
    el.statusTitle.textContent = 'Status unavailable';
    el.statusSub.textContent = err.message || 'will be decided when you record';
    selectDirection('in');
  } finally {
    el.btnSubmit.disabled = false;
  }
}

function localStamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const off = -date.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const oh = pad(Math.floor(Math.abs(off) / 60));
  const om = pad(Math.abs(off) % 60);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
         `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${sign}${oh}:${om}`;
}

async function submitScan({ force = false } = {}) {
  showError(el.confirmError, '');
  const regNo = normalizeRegNo(el.confirmRegNo.value);
  if (!regNo) {
    showError(el.confirmError, 'Enter a registration number first.');
    return;
  }

  state.eventName = el.eventName.value.trim() || 'General';
  setEventName(state.eventName);

  const usingForce = force || state.forceNext === true;
  const dir = state.direction;
  const periods = [...state.periods].sort((a, b) => a - b);

  el.btnSubmit.disabled = true;
  el.btnSubmit.textContent = 'Recording…';

  try {
    const res = await api.scan({
      reg_no: regNo,
      raw_code: state.pending?.raw || '',
      event_name: state.eventName,
      direction: dir,
      periods,
      scanned_at: new Date().toISOString(),
      scanned_at_local: localStamp(),
      device: scanner?.getState?.().camera || navigator.userAgent.slice(0, 80),
    }, { force: usingForce });

    state.forceNext = false;
    state.scanCount++;
    state.lastResult = res;
    renderResult(res);
    showView('done');
  } catch (err) {
    state.forceNext = false;
    // The server owns the IN/OUT rule. When it refuses, say exactly why and
    // offer the deliberate override rather than silently retrying.
    if (err.status === 409) {
      // Re-render the status FIRST: renderStatus() clears forceNext, so the
      // override flag must be set after it. Setting it before meant the
      // "record anyway" button never appeared and the next tap simply repeated
      // the same refused request — caught by the headless UI test.
      if (err.payload?.state) renderStatus({ ...err.payload, suggest: err.payload.suggest || dir });

      if (err.code === 'too_soon') {
        state.forceNext = true;
        showError(
          el.confirmError,
          `${err.detail || 'Too soon to mark OUT'}. Tap again to record OUT anyway.`,
        );
      } else if (err.code === 'already_in') {
        showError(el.confirmError, `Already marked IN ${err.payload?.minutes ?? ''} min ago. Nothing to record.`);
      } else if (err.code === 'no_open_session') {
        showError(el.confirmError, 'No open IN to close — mark them IN instead.');
      } else {
        showError(el.confirmError, err.message || 'The server rejected this scan.');
      }
    } else {
      showError(el.confirmError, err.message || 'Could not record the scan.');
    }
  } finally {
    el.btnSubmit.disabled = false;
    if (state.forceNext) el.btnSubmit.textContent = `Record ${DIR_LABEL[state.direction]} anyway`;
    else el.btnSubmit.textContent = `Record ${DIR_LABEL[state.direction]}`;
  }
}

function renderResult(res) {
  const dir = res.direction || state.direction;
  const hours = res.hours ?? state.periods.size;
  const label = DIR_LABEL[dir] || 'IN';
  const isOut = dir === 'out';

  el.resultBox.classList.toggle('is-warn', false);
  el.resultMark.textContent = isOut ? '←' : '→';
  el.resultTitle.textContent = `Marked ${label}`;
  el.resultSub.textContent = isOut && res.session_minutes != null
    ? `Session length ${res.session_minutes} min`
    : `${state.scanCount} scan${state.scanCount === 1 ? '' : 's'} this session`;

  const periodsTxt = Array.isArray(res.periods) && res.periods.length
    ? periodsLabel(res.periods)
    : (state.periods.size ? periodsLabel([...state.periods]) : '—');

  const facts = [
    ['Registration', res.reg_no || el.confirmRegNo.value],
    ['Direction', label],
    ['Event', state.eventName],
    ['Periods', periodsTxt],
    ['Hours', hours ? String(hours) : '—'],
    ['Time', res.scanned_at_local || localStamp()],
  ];
  if (isOut && res.session_minutes != null) {
    facts.splice(5, 0, ['Session', `${res.session_minutes} min`]);
  }

  el.resultFacts.innerHTML = '';
  for (const [k, v] of facts) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    el.resultFacts.append(dt, dd);
  }

}

/* --------------------------------------------------------------- dashboard */

function fmtTime(row) {
  const raw = row.scanned_at_local || row.scanned_at || '';
  const m = /(\d{2}:\d{2})/.exec(raw);
  return m ? m[1] : raw.slice(11, 16);
}

function renderDashList(rows) {
  el.dashList.innerHTML = '';
  if (!rows.length) {
    el.dashEmpty.hidden = false;
    return;
  }
  el.dashEmpty.hidden = true;

  const frag = document.createDocumentFragment();
  for (const row of rows) {
    const li = document.createElement('li');
    li.className = 'list__item';
    if (row.id > (renderDashList.lastId || 0)) li.classList.add('list__item--new');
    renderDashList.lastId = Math.max(renderDashList.lastId || 0, row.id);

    const main = document.createElement('div');
    main.className = 'list__main';
    const reg = document.createElement('span');
    reg.className = 'list__reg';
    reg.textContent = row.reg_no;
    main.appendChild(reg);
    if (row.name) {
      const nm = document.createElement('span');
      nm.className = 'list__name';
      nm.textContent = row.name;
      main.appendChild(nm);
    }

    const meta = document.createElement('div');
    meta.className = 'list__meta';
    const dirPill = document.createElement('span');
    dirPill.className = `list__dir list__dir--${row.direction === 'out' ? 'out' : 'in'}`;
    dirPill.textContent = (row.direction || 'in').toUpperCase();
    meta.appendChild(dirPill);
    const detail = document.createElement('span');
    if (row.direction === 'out' && row.session_minutes != null) {
      detail.textContent = ` ${row.session_minutes} min`;
    } else if (row.periods) {
      detail.textContent = ` ${periodsLabel(String(row.periods).split(',').map(Number))}`;
    } else {
      detail.textContent = row.period_start ? ` P${row.period_start}–P${row.period_end}` : '';
    }
    meta.appendChild(detail);

    const time = document.createElement('time');
    time.className = 'list__time';
    time.textContent = fmtTime(row);

    li.append(main, meta, time);
    frag.appendChild(li);
  }
  el.dashList.appendChild(frag);
}

let dashTimer = null;

async function loadDashboard({ quiet = false } = {}) {
  if (!getToken()) {
    showView('pin');
    return;
  }
  try {
    const [summary, list] = await Promise.all([
      api.summary({ event: '' }),
      api.scans({ q: el.dashSearch.value.trim(), event: '', limit: 300 }),
    ]);

    el.statStudents.textContent = String(summary.students ?? 0);
    el.statInside.textContent = String(summary.in_now ?? 0);
    renderDashList(list.scans || []);
    el.dashUpdated.textContent = `Updated ${new Date().toLocaleTimeString()} · showing ${list.count} of ${list.total}`;

    el.eventList.innerHTML = '';
    for (const ev of summary.events || []) {
      const opt = document.createElement('option');
      opt.value = ev.name;
      el.eventList.appendChild(opt);
    }
  } catch (err) {
    if (err.status === 401) {
      setToken(null);
      setSheetState(false);
      toast('Session expired — enter the PIN again.');
      showView('pin');
      el.pinInput.focus();
      return;
    }
    if (!quiet) toast(err.message || 'Could not load the dashboard.');
  }
}

function startDashPolling() {
  clearInterval(dashTimer);
  dashTimer = setInterval(() => {
    if (!$('view-dash').hidden && !document.hidden) loadDashboard({ quiet: true });
  }, 15000);
}

/* -------------------------------------------------------------------- debug */

function renderDebug(info) {
  const tbody = el.debugTable.querySelector('tbody');
  tbody.innerHTML = '';
  const ranked = info.ranked?.length ? info.ranked : [];
  if (!ranked.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 4;
    td.textContent = 'No labelled devices yet — grant camera permission, then reload.';
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
  ranked.forEach((d, i) => {
    const tr = document.createElement('tr');
    if (d.deviceId === info.deviceId) tr.classList.add('is-chosen');
    const cells = [
      String(i + 1),
      d.label || '(no label)',
      `${d.score}`,
      `${(d.deviceId || '').slice(0, 12)}…`,
    ];
    for (const c of cells) {
      const td = document.createElement('td');
      td.textContent = c;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  });
  el.debugCaps.textContent = JSON.stringify(
    { chosen: info.label, deviceId: info.deviceId, settings: info.settings, applied: info.applied },
    null,
    2,
  );
}

async function showDebugView() {
  showView('debug');
  const devices = await listVideoInputs();
  const ranked = hasLabels(devices) ? rankCameras(devices) : [];
  renderDebug({ ranked, label: '(none open)', deviceId: '', settings: {}, applied: [] });
  if (!ranked.length) {
    el.debugCaps.textContent =
      'Device labels are hidden until camera permission is granted.\n' +
      'Open the scan view once and allow the camera, then return here.';
  }
}

/* --------------------------------------------------------------------- init */

function wireEvents() {
  // The sheet is the only PIN-gated thing in the app.
  el.sheetBtn.addEventListener('click', async () => {
    scanner?.stop();
    releaseAwake();
    if (getToken()) {
      showView('dash');
      await loadDashboard();
      startDashPolling();
    } else {
      showError(el.pinError, '');
      showView('pin');
      el.pinInput.focus();
    }
  });

  document.querySelectorAll('[data-goto]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.goto;
      if (target !== 'scan') {
        scanner?.stop();
        releaseAwake();
      }
      if (target === 'scan') gotoScan();
      else if (target === 'dash') { showView('dash'); loadDashboard(); }
      else showView(target);
    });
  });

  el.pinForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    showError(el.pinError, '');
    el.pinSubmit.disabled = true;
    el.pinSubmit.textContent = 'Checking…';
    try {
      const res = await api.auth(el.pinInput.value.trim());
      setToken(res.token);
      setSheetState(true);
      el.pinInput.value = '';
      showView('dash');
      await loadDashboard();
      startDashPolling();
    } catch (err) {
      const left = err.payload?.attempts_left;
      showError(el.pinError, left !== undefined && left > 0
        ? `${err.message} (${left} attempt${left === 1 ? '' : 's'} left)`
        : err.message || 'Incorrect PIN.');
    } finally {
      el.pinSubmit.disabled = false;
      el.pinSubmit.textContent = 'Unlock';
    }
  });

  el.btnManual.addEventListener('click', () => {
    el.manualForm.hidden = !el.manualForm.hidden;
    if (!el.manualForm.hidden) el.manualInput.focus();
  });

  el.manualForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const regNo = normalizeRegNo(el.manualInput.value);
    if (!regNo) {
      showError(el.scanError, 'That does not look like a registration number.');
      return;
    }
    el.manualInput.value = '';
    el.manualForm.hidden = true;
    scanner?.pause();
    handleScanResult({ raw: '', regNo, format: 'manual', via: 'typed' });
  });

  el.btnSwitch.addEventListener('click', async () => {
    const ok = await scanner?.switchCamera();
    if (!ok) toast('No other camera available.');
  });

  el.btnTorch.addEventListener('click', async () => {
    const on = el.btnTorch.dataset.on !== 'true';
    const applied = await scanner?.setTorch(on);
    if (applied) {
      el.btnTorch.dataset.on = String(on);
      el.btnTorch.classList.toggle('is-on', on);
    } else {
      toast('Torch is not available on this camera.');
    }
  });

  el.dirToggle.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-dir]');
    if (!btn || btn.disabled) return;
    selectDirection(btn.dataset.dir, { userChosen: true });
    if (state.forceNext) {
      state.forceNext = false;
      showError(el.confirmError, '');
    }
  });

  el.confirmRegNo.addEventListener('input', () => {
    el.confirmRegNo.value = el.confirmRegNo.value.toUpperCase();
  });

  el.btnSubmit.addEventListener('click', () => submitScan());

  el.btnScanNext.addEventListener('click', () => {
    state.pending = null;
    gotoScan();
    // The scanner is already running in the background; just resume watching.
    setTimeout(() => scanner?.resume?.(), 250);
  });

  el.dashSearch.addEventListener('input', () => {
    clearTimeout(el.dashSearch._t);
    el.dashSearch._t = setTimeout(() => loadDashboard({ quiet: true }), 250);
  });

  el.btnRefresh.addEventListener('click', () => loadDashboard());

  el.btnExport.addEventListener('click', async (event) => {
    event.preventDefault();
    try {
      const name = await api.downloadExport({ event: '' });
      toast(`Downloaded ${name}`);
    } catch (err) {
      toast(err.message || 'Export failed.');
    }
  });

  el.btnExportJson.addEventListener('click', async () => {
    try {
      const data = await api.scans({ limit: 1000 });
      const blob = new Blob([JSON.stringify(data.scans, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `attendance-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      toast('JSON downloaded');
    } catch (err) {
      toast(err.message || 'Export failed.');
    }
  });

  el.btnSignOut.addEventListener('click', () => {
    setToken(null);
    setSheetState(false);
    clearInterval(dashTimer);
    renderDashList.lastId = 0;
    toast('Sheet locked.');
    gotoScan();
  });

  // A backgrounded tab must not hold the camera; iOS will kill the stream anyway.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      scanner?.stop();
      releaseAwake();
    } else if (!$('view-scan').hidden) {
      startScanner();
    }
  });
}

async function init() {
  buildPeriodChips();
  renderPeriods();
  wireEvents();
  setSheetState(Boolean(getToken()));

  // The PIN field must not advertise the wrong number of digits, and the
  // IN->OUT minimum gap is a server rule the UI only reports.
  api.config().then((cfg) => {
    const n = Number(cfg.pin_length) || 6;
    el.pinInput.maxLength = n;
    el.pinInput.placeholder = '\u2022'.repeat(n);
    if (cfg.min_gap_minutes) state.minGapMinutes = cfg.min_gap_minutes;
  }).catch(() => { /* defaults already match the deployment */ });

  const params = new URLSearchParams(location.search);
  if (params.get('debug') === 'camera') {
    await showDebugView();
    return;
  }

  // The scanner is the app. Nobody has to sign in to use it.
  gotoScan();
}

init();
