/**
 * App controller: view routing, the scan -> confirm -> record flow, the period
 * ruler, and the organizer dashboard.
 *
 * No framework and no client-side URL router — views are toggled with the
 * `hidden` attribute, which keeps the Worker's asset routing trivial.
 */

import { api, getToken, setToken, getRole, setRole, getEventName, setEventName } from './api.js';
import { createScanner } from './scanner.js';
import { normalizeRegNo } from './regno.js';
import { listVideoInputs, rankCameras, hasLabels } from './camera.js';

const $ = (id) => document.getElementById(id);

const el = {
  roleChip: $('roleChip'),
  roleChipLabel: $('roleChipLabel'),
  roleHint: $('roleHint'),

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

  confirmRegNo: $('confirmRegNo'),
  confirmRaw: $('confirmRaw'),
  eventName: $('eventName'),
  eventList: $('eventList'),
  hoursOut: $('hoursOut'),
  periodRuler: $('periodRuler'),
  rulerFill: $('rulerFill'),
  handleStart: $('handleStart'),
  handleEnd: $('handleEnd'),
  periodTicks: $('periodTicks'),
  periodFrom: $('periodFrom'),
  periodTo: $('periodTo'),
  confirmError: $('confirmError'),
  btnSubmit: $('btnSubmit'),

  resultBox: $('resultBox'),
  resultMark: $('resultMark'),
  resultTitle: $('resultTitle'),
  resultSub: $('resultSub'),
  resultFacts: $('resultFacts'),
  btnScanNext: $('btnScanNext'),
  btnForce: $('btnForce'),

  dashStats: $('dashStats'),
  statStudents: $('statStudents'),
  statScans: $('statScans'),
  statHours: $('statHours'),
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
  role: getRole() || null,
  eventName: getEventName() || 'General',
  pending: null, // { raw, regNo, format, via }
  lastResult: null,
  periodStart: 1,
  periodEnd: 3,
  scanCount: 0,
};

let scanner = null;
let wakeLock = null;
let toastTimer = null;

/* ------------------------------------------------------------------- chrome */

const VIEWS = ['role', 'pin', 'scan', 'confirm', 'done', 'dash', 'debug'];

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

function setRoleLabel(role) {
  el.roleChipLabel.textContent = role === 'organizer' ? 'Organizer' : 'Participant';
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

/* ------------------------------------------------------------ period ruler */

function renderRuler() {
  const { periodStart: s, periodEnd: e } = state;
  const slot = 100 / 8;
  const center = (p) => (p - 0.5) * slot;

  el.handleStart.style.left = `${center(s)}%`;
  el.handleEnd.style.left = `${center(e)}%`;
  el.handleStart.textContent = String(s);
  el.handleEnd.textContent = String(e);
  el.handleStart.setAttribute('aria-valuenow', String(s));
  el.handleEnd.setAttribute('aria-valuenow', String(e));

  el.rulerFill.style.left = `${(s - 1) * slot}%`;
  el.rulerFill.style.width = `${(e - s + 1) * slot}%`;

  [...el.periodTicks.children].forEach((tick, i) => {
    const p = i + 1;
    tick.classList.toggle('is-active', p >= s && p <= e);
    tick.classList.toggle('is-edge', p === s || p === e);
  });

  const hours = e - s + 1;
  el.hoursOut.textContent = `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  el.periodFrom.textContent = String(s);
  el.periodTo.textContent = String(e);
}

function buildTicks() {
  el.periodTicks.innerHTML = '';
  for (let p = 1; p <= 8; p++) {
    const t = document.createElement('span');
    t.className = 'ticks__tick';
    t.textContent = String(p);
    el.periodTicks.appendChild(t);
  }
}

function periodFromPointer(clientX) {
  const rect = el.periodRuler.getBoundingClientRect();
  const ratio = (clientX - rect.left) / rect.width;
  return Math.min(8, Math.max(1, Math.round(ratio * 8 + 0.5)));
}

function setupRuler() {
  let dragging = null;

  const begin = (which) => (event) => {
    dragging = which;
    event.preventDefault();
    event.target.setPointerCapture?.(event.pointerId);
    el.periodRuler.classList.add('is-dragging');
  };

  const move = (event) => {
    if (!dragging) return;
    const p = periodFromPointer(event.clientX);
    if (dragging === 'start') {
      state.periodStart = Math.min(p, state.periodEnd);
    } else {
      state.periodEnd = Math.max(p, state.periodStart);
    }
    renderRuler();
  };

  const end = (event) => {
    if (!dragging) return;
    dragging = null;
    el.periodRuler.classList.remove('is-dragging');
    event.target.releasePointerCapture?.(event.pointerId);
  };

  el.handleStart.addEventListener('pointerdown', begin('start'));
  el.handleEnd.addEventListener('pointerdown', begin('end'));
  el.periodRuler.addEventListener('pointermove', move);
  el.periodRuler.addEventListener('pointerup', end);
  el.periodRuler.addEventListener('pointercancel', end);

  // Tapping the track jumps the nearest handle there — much easier one-handed
  // than hitting a 40 px circle while holding an ID card.
  el.periodRuler.addEventListener('click', (event) => {
    if (event.target === el.handleStart || event.target === el.handleEnd) return;
    if (el.periodRuler.classList.contains('is-dragging')) return;
    const p = periodFromPointer(event.clientX);
    if (Math.abs(p - state.periodStart) <= Math.abs(p - state.periodEnd)) {
      state.periodStart = Math.min(p, state.periodEnd);
    } else {
      state.periodEnd = Math.max(p, state.periodStart);
    }
    renderRuler();
  });

  const key = (which) => (event) => {
    const delta = event.key === 'ArrowRight' || event.key === 'ArrowUp' ? 1
      : event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -1 : 0;
    if (!delta) return;
    event.preventDefault();
    if (which === 'start') {
      state.periodStart = Math.min(8, Math.max(1, Math.min(state.periodStart + delta, state.periodEnd)));
    } else {
      state.periodEnd = Math.min(8, Math.max(1, Math.max(state.periodEnd + delta, state.periodStart)));
    }
    renderRuler();
  };
  el.handleStart.addEventListener('keydown', key('start'));
  el.handleEnd.addEventListener('keydown', key('end'));

  renderRuler();
}

/* ------------------------------------------------------------------- flows */

async function gotoScan() {
  if (state.role === 'organizer' && !getToken()) {
    showView('pin');
    el.pinInput.focus();
    return;
  }
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

function handleScanResult({ raw, regNo, format, via }) {
  state.pending = { raw, regNo, format, via };
  el.confirmRegNo.value = regNo;
  el.confirmRaw.textContent = raw && raw !== regNo
    ? `raw barcode: ${raw.length > 60 ? `${raw.slice(0, 60)}…` : raw} · ${format} · ${via}`
    : `read via ${via} · ${format}`;
  showError(el.confirmError, '');
  el.eventName.value = state.eventName || 'General';
  state.periodStart = 1;
  state.periodEnd = 3;
  renderRuler();
  showView('confirm');
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

  el.btnSubmit.disabled = true;
  el.btnSubmit.textContent = 'Recording…';

  try {
    const res = await api.scan({
      reg_no: regNo,
      raw_code: state.pending?.raw || '',
      event_name: state.eventName,
      scan_type: state.role === 'organizer' ? 'organizer-scan' : 'self check-in',
      period_start: state.periodStart,
      period_end: state.periodEnd,
      scanned_at: new Date().toISOString(),
      scanned_at_local: localStamp(),
      device: scanner?.getState?.().camera || navigator.userAgent.slice(0, 80),
    }, { force });

    state.scanCount++;
    state.lastResult = res;
    renderResult(res, { force });
    showView('done');
  } catch (err) {
    if (err.status === 409) {
      const existing = err.payload?.existing || {};
      renderResult(
        { ...existing, reg_no: regNo, duplicate: true },
        { duplicate: true },
      );
      showView('done');
    } else {
      showError(el.confirmError, err.message || 'Could not record the scan.');
    }
  } finally {
    el.btnSubmit.disabled = false;
    el.btnSubmit.textContent = 'Record attendance';
  }
}

function renderResult(res, { force = false, duplicate = false } = {}) {
  const hours = res.hours ?? (state.periodEnd - state.periodStart + 1);
  const isDupe = duplicate || res.duplicate;

  el.resultBox.classList.toggle('is-warn', Boolean(isDupe));
  el.resultMark.textContent = isDupe ? '!' : '✓';
  el.resultTitle.textContent = isDupe ? 'Already recorded' : 'Recorded';
  el.resultSub.textContent = isDupe
    ? 'This card was scanned a moment ago for the same event.'
    : `${state.scanCount} scan${state.scanCount === 1 ? '' : 's'} this session`;

  const when = res.scanned_at_local || localStamp();
  const facts = [
    ['Registration', res.reg_no || el.confirmRegNo.value],
    ['Event', state.eventName],
    ['Periods', res.period_start ? `P${res.period_start} – P${res.period_end}` : '—'],
    ['Hours', String(hours)],
    ['Time', when],
  ];
  el.resultFacts.innerHTML = '';
  for (const [k, v] of facts) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    el.resultFacts.append(dt, dd);
  }

  el.btnForce.hidden = !isDupe;
  el.btnForce.disabled = Boolean(force);
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
    meta.textContent = row.period_start
      ? `P${row.period_start}–P${row.period_end} · ${row.hours}h`
      : '—';

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
    el.statScans.textContent = String(summary.scans ?? 0);
    el.statHours.textContent = String(summary.hours ?? 0);
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
  document.querySelectorAll('[data-role]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const role = btn.dataset.role;
      state.role = role;
      setRole(role);
      setRoleLabel(role);
      if (role === 'organizer') {
        if (getToken()) {
          showView('dash');
          await loadDashboard();
          startDashPolling();
        } else {
          showView('pin');
          el.pinInput.focus();
        }
      } else {
        gotoScan();
      }
    });
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

  el.roleChip.addEventListener('click', () => {
    scanner?.stop();
    releaseAwake();
    el.roleHint.hidden = !state.role;
    if (state.role) {
      el.roleHint.textContent = `Currently signed in as ${state.role}. Pick a different mode below.`;
    }
    showView('role');
  });

  el.pinForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    showError(el.pinError, '');
    el.pinSubmit.disabled = true;
    el.pinSubmit.textContent = 'Checking…';
    try {
      const res = await api.auth(el.pinInput.value.trim());
      setToken(res.token);
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

  el.confirmRegNo.addEventListener('input', () => {
    el.confirmRegNo.value = el.confirmRegNo.value.toUpperCase();
  });

  el.btnSubmit.addEventListener('click', () => submitScan());
  el.btnForce.addEventListener('click', () => submitScan({ force: true }));

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
    clearInterval(dashTimer);
    state.role = null;
    setRole('');
    setRoleLabel('Participant');
    toast('Signed out of organizer view.');
    showView('role');
  });

  // A backgrounded tab must not hold the camera; iOS will kill the stream anyway.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      scanner?.stop();
      releaseAwake();
    } else if (!$('view-scan').hidden && state.role) {
      startScanner();
    }
  });
}

async function init() {
  buildTicks();
  setupRuler();
  wireEvents();
  setRoleLabel(state.role || 'participant');

  const params = new URLSearchParams(location.search);
  if (params.get('debug') === 'camera') {
    await showDebugView();
    return;
  }

  if (state.role === 'organizer' && getToken()) {
    showView('dash');
    await loadDashboard();
    startDashPolling();
  } else if (state.role) {
    gotoScan();
  } else {
    showView('role');
  }
}

init();
