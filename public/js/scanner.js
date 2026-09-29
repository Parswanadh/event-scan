/**
 * Barcode scanning engine.
 *
 * Two decoders, tried in order of quality on the target platform:
 *   1. The native `BarcodeDetector` (hardware-assisted, present on Android
 *      Chrome) — fast and cheap, so it runs as the primary loop.
 *   2. ZXing, vendored at /vendor/zxing.min.js as a UMD global — the universal
 *      fallback for iOS Safari and Firefox, and a second opinion when the native
 *      detector finds nothing within a few seconds.
 *
 * Only one engine runs at a time unless the native one is failing, so a phone
 * held over a barcode for a minute does not cook itself.
 */

import { normalizeRegNo } from './regno.js';
import { openBestCamera, stopStream, torchSupported, setTorch } from './camera.js';

/** Symbologies worth trying: a college ID could plausibly use any of these. */
const ZXING_FORMATS = [
  'CODE_128', 'CODE_39', 'CODE_93', 'CODABAR', 'ITF',
  'EAN_13', 'EAN_8', 'UPC_A', 'UPC_E', 'QR_CODE', 'DATA_MATRIX', 'PDF_417',
];

const NATIVE_FORMATS = [
  'code_128', 'code_39', 'code_93', 'codabar', 'itf',
  'ean_13', 'ean_8', 'upc_a', 'upc_e', 'qr_code', 'data_matrix', 'pdf417',
];

/** How long the native detector gets alone before ZXing joins in. */
const ZXING_GRACE_MS = 3500;
/** Minimum gap between decode attempts — a phone screen does not need 60 fps. */
const NATIVE_INTERVAL_MS = 110;
const ZXING_INTERVAL_MS = 180;
/** Same payload twice inside this window is treated as one scan. */
const HIT_DEBOUNCE_MS = 2500;

export function nativeFormats() {
  const Detector = globalThis.BarcodeDetector;
  if (!Detector) return [];
  if (typeof Detector.getSupportedFormats !== 'function') return NATIVE_FORMATS;
  return null; // resolved asynchronously in start()
}

export function createScanner({ video, onResult, onStatus, onEngine, onDebug }) {
  let stream = null;
  let track = null;
  let running = false;
  let paused = false;
  let lastHit = { value: '', at: 0 };
  let nativeTimer = null;
  let zxingTimer = null;
  let zxingReader = null;
  let zxingControls = null;
  let detector = null;
  let startedAt = 0;
  let attempts = 0;
  let engineName = 'idle';
  let camLabel = '';
  let forcedDeviceId = '';

  const setStatus = (text, tone) => onStatus?.(text, tone);
  const setEngine = (name) => {
    engineName = name;
    onEngine?.(name);
  };

  function accept(value, format, via) {
    const raw = String(value ?? '');
    const regNo = normalizeRegNo(raw);
    const now = Date.now();

    if (!regNo) return false;
    if (regNo === lastHit.value && now - lastHit.at < HIT_DEBOUNCE_MS) return false;

    lastHit = { value: regNo, at: now };
    paused = true; // stop feeding the same card in thirty times a second
    onResult?.({ raw, regNo, format: format || 'unknown', via });
    return true;
  }

  /* ------------------------------------------------------------ native loop */

  async function initNative() {
    const Detector = globalThis.BarcodeDetector;
    if (!Detector) return false;
    let formats = NATIVE_FORMATS;
    try {
      if (typeof Detector.getSupportedFormats === 'function') {
        const supported = await Detector.getSupportedFormats();
        formats = NATIVE_FORMATS.filter((f) => supported.includes(f));
        if (!formats.length) return false;
      }
      detector = new Detector({ formats });
      return true;
    } catch {
      detector = null;
      return false;
    }
  }

  async function nativeTick() {
    if (!running || paused) return;
    if (video.readyState >= 2 && video.videoWidth) {
      attempts++;
      try {
        const codes = await detector.detect(video);
        if (codes?.length) {
          const c = codes[0];
          if (accept(c.rawValue, c.format, 'native')) return;
        }
      } catch {
        /* a transient detect() failure must not kill the loop */
      }
    }
    if (running && !paused) nativeTimer = setTimeout(nativeTick, NATIVE_INTERVAL_MS);
  }

  /* ------------------------------------------------------------ zxing loop */

  function zxingHints() {
    const Z = globalThis.ZXing;
    if (!Z) return undefined;
    const hints = new Map();
    hints.set(
      Z.DecodeHintType.POSSIBLE_FORMATS,
      ZXING_FORMATS.map((f) => Z.BarcodeFormat[f]).filter((v) => v !== undefined),
    );
    hints.set(Z.DecodeHintType.TRY_HARDER, true);
    // Deliberately NOT setting ASSUME_CODE_39_CHECK_DIGIT: ZXing's setHints()
    // tests that hint by *presence* (`!== undefined`), so setting it to false
    // would still switch it on and break plain Code39 without a check digit.
    return hints;
  }

  function startZXing() {
    const Z = globalThis.ZXing;
    if (!Z || zxingReader) return false;
    try {
      zxingReader = new Z.BrowserMultiFormatReader(zxingHints(), {
        delayBetweenScanAttempts: ZXING_INTERVAL_MS,
        delayBetweenScanSuccess: 500,
      });
    } catch {
      zxingReader = null;
      return false;
    }

    setEngine(engineName === 'idle' ? 'zxing' : `${engineName}+zxing`);

    // decodeFromVideoElementContinuously drives its own loop and returns
    // controls whose .stop() must be called, or the canvas keeps being read.
    zxingReader
      .decodeFromVideoElementContinuously(video, (result, err) => {
        if (!running || paused) return;
        if (result) {
          attempts++;
          const fmt = Z.BarcodeFormat[result.getBarcodeFormat()] || 'unknown';
          accept(result.getText(), fmt, 'zxing');
        } else if (err && !(err instanceof Z.NotFoundException)) {
          // Checksum/format errors are normal noise while the camera is moving.
        }
      })
      .then((controls) => {
        zxingControls = controls;
        if (!running) controls?.stop?.();
      })
      .catch(() => {
        zxingReader = null;
      });
    return true;
  }

  function stopZXing() {
    try {
      zxingControls?.stop?.();
    } catch {
      /* already stopped */
    }
    zxingControls = null;
    try {
      zxingReader?.reset?.();
    } catch {
      /* ignore */
    }
    zxingReader = null;
  }

  /* --------------------------------------------------------------- lifecycle */

  async function open(deviceId) {
    const cam = await openBestCamera(deviceId ? { deviceId } : {});
    stream = cam.stream;
    track = cam.track;
    camLabel = cam.label || 'camera';
    forcedDeviceId = cam.deviceId || '';

    if (video.srcObject !== stream) video.srcObject = stream;
    video.setAttribute('playsinline', '');
    video.muted = true;
    try {
      await video.play();
    } catch {
      /* autoplay policies — the tap that opened this view satisfies the gesture */
    }

    onDebug?.({
      label: camLabel,
      deviceId: cam.deviceId,
      settings: cam.settings,
      ranked: cam.ranked,
      applied: cam.applied,
    });
    return cam;
  }

  return {
    async start() {
      if (running) return;
      running = true;
      paused = false;
      attempts = 0;
      startedAt = Date.now();
      setStatus('Requesting camera…');

      try {
        await open(forcedDeviceId || undefined);
      } catch (err) {
        running = false;
        setStatus(err?.message || 'Could not open the camera.', 'error');
        throw err;
      }
      if (!running) return;

      setStatus('Point the camera at the barcode');

      const usingNative = await initNative();
      if (usingNative) {
        setEngine('native');
        nativeTimer = setTimeout(nativeTick, NATIVE_INTERVAL_MS);
        // Give the native detector a head start; if it has not read anything by
        // then, run ZXing alongside it.
        nativeTimer = nativeTimer; // eslint-disable-line no-self-assign
        zxingTimer = setTimeout(() => {
          if (running && !paused && !zxingReader) startZXing();
        }, ZXING_GRACE_MS);
      } else {
        if (!globalThis.ZXing) {
          setStatus('No barcode engine loaded — use manual entry.', 'error');
        } else {
          startZXing();
        }
      }
    },

    /** Resume watching after a result was consumed. */
    resume() {
      paused = false;
      lastHit = { value: '', at: 0 };
      if (!running) return;
      setStatus('Point the camera at the barcode');
      if (detector && !nativeTimer) nativeTimer = setTimeout(nativeTick, NATIVE_INTERVAL_MS);
      if (!zxingReader && globalThis.ZXing && Date.now() - startedAt > ZXING_GRACE_MS) startZXing();
    },

    pause() {
      paused = true;
    },

    stop() {
      running = false;
      paused = true;
      if (nativeTimer) clearTimeout(nativeTimer);
      if (zxingTimer) clearTimeout(zxingTimer);
      nativeTimer = null;
      zxingTimer = null;
      stopZXing();
      stopStream(stream);
      stream = null;
      track = null;
      try {
        video.srcObject = null;
      } catch {
        /* ignore */
      }
      setEngine('idle');
    },

    /** Cycle to the next camera in the ranked list (manual override). */
    async switchCamera() {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const cams = devices.filter((d) => d.kind === 'videoinput');
      if (cams.length < 2) return false;

      const currentIndex = cams.findIndex((d) => d.deviceId === forcedDeviceId);
      const next = cams[(currentIndex + 1) % cams.length];

      const wasRunning = running;
      this.stop();
      running = wasRunning;
      paused = false;
      try {
        await open(next.deviceId);
        if (running) {
          lastHit = { value: '', at: 0 };
          if (detector) nativeTimer = setTimeout(nativeTick, NATIVE_INTERVAL_MS);
          if (globalThis.ZXing) startZXing();
        }
        setStatus(`Switched to ${camLabel}`);
        return true;
      } catch (err) {
        setStatus(err?.message || 'Could not switch camera.', 'error');
        return false;
      }
    },

    torchAvailable: () => torchSupported(track),
    setTorch: (on) => setTorch(track, on),

    getState: () => ({
      running,
      paused,
      engine: engineName,
      camera: camLabel,
      deviceId: forcedDeviceId,
      attempts,
      elapsedMs: startedAt ? Date.now() - startedAt : 0,
    }),
  };
}
