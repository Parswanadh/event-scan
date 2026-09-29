/**
 * Camera selection.
 *
 * The requirement that matters here: open the phone's MAIN rear camera, not the
 * telephoto and not the ultra-wide. `facingMode: 'environment'` alone does NOT
 * guarantee that — on several Android devices the platform hands back whichever
 * rear sensor enumerates first, which can be the ultra-wide or the telephoto.
 *
 * Two-phase strategy:
 *   1. Open *something* rear-facing with `ideal` (never `exact`, which throws
 *      OverconstrainedError on devices whose rear camera is unlabelled).
 *   2. Device labels are empty until permission is granted, so only now can we
 *      enumerate and score. If the best-scoring device is not the one we opened,
 *      reopen on it.
 */

/** Labels that mean "not the main lens". Order matters only for readability. */
const FRONT_RE = /\b(front|face|user|selfie)\b/i;
const TELE_RE = /\b(tele|telephoto|telefoto)\b/i;
const ULTRAWIDE_RE = /\b(ultra[\s-]?wide|ultrawide|wide[\s-]?angle|0\.5x?)\b/i;
const EXOTIC_RE = /\b(macro|depth|monochrome|mono|truedepth|infrared|ir|tof|fisheye|aux)\b/i;
const REAR_RE = /\b(back|rear|environment|world)\b/i;

/**
 * Score a video input device. Higher is more likely the main rear camera.
 * Exported so the `?debug=camera` panel can show the same ranking the scanner uses.
 *
 * @param {{deviceId?: string, label?: string, index?: number}} device
 * @returns {{score: number, reasons: string[]}}
 */
export function scoreDevice(device) {
  const label = String(device?.label || '');
  const reasons = [];
  let score = 0;

  if (!label) {
    // Unlabelled entries are common for the "default" pseudo-device; treat as a
    // weak rear candidate rather than discarding it.
    return { score: 1, reasons: ['unlabelled (weak candidate)'] };
  }

  if (FRONT_RE.test(label)) {
    score -= 200;
    reasons.push('-200 front-facing');
  }
  if (TELE_RE.test(label)) {
    score -= 90;
    reasons.push('-90 telephoto');
  }
  if (ULTRAWIDE_RE.test(label)) {
    score -= 70;
    reasons.push('-70 ultra-wide');
  }
  if (EXOTIC_RE.test(label)) {
    score -= 45;
    reasons.push('-45 auxiliary sensor');
  }
  if (REAR_RE.test(label) && !FRONT_RE.test(label)) {
    score += 100;
    reasons.push('+100 rear-facing');
  }

  // Android Chrome exposes "camera2 <n>, facing back". Camera 0 is the primary
  // sensor on essentially every device; higher indices are the extras.
  const cam2 = /camera2\s+(\d+)/i.exec(label);
  if (cam2) {
    const idx = Number(cam2[1]);
    const bonus = Math.max(0, 30 - idx * 12);
    score += bonus;
    if (bonus) reasons.push(`+${bonus} camera2 index ${idx}`);
  }

  // iOS Safari names: "Back Camera" (main), "Back Dual Wide Camera" (main),
  // "Back Ultra Wide Camera" / "Back Telephoto Camera" (already penalised).
  if (/^back (dual )?(wide )?camera$/i.test(label.trim())) {
    score += 25;
    reasons.push('+25 iOS main back camera');
  }
  if (/^back camera$/i.test(label.trim())) {
    score += 35;
    reasons.push('+35 iOS "Back Camera" exact');
  }

  // A device that reports a zoom range starting well above 1x is a telephoto.
  const zoomMin = Number(device?.zoomMin);
  if (Number.isFinite(zoomMin) && zoomMin > 1.4) {
    score -= 60;
    reasons.push(`-60 zoom starts at ${zoomMin}x`);
  }

  return { score, reasons };
}

/**
 * Rank video inputs best-first. `index` is preserved so the debug panel can show
 * the original enumeration order.
 * @param {MediaDeviceInfo[]} devices
 */
export function rankCameras(devices) {
  return (devices || [])
    .map((d, index) => ({ deviceId: d.deviceId, label: d.label, index }))
    .map((d) => ({ ...d, ...scoreDevice(d) }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
}

/** True when enumerateDevices() is actually giving us labels yet. */
export function hasLabels(devices) {
  return (devices || []).some((d) => d.label && d.label.trim());
}

export async function listVideoInputs() {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const all = await navigator.mediaDevices.enumerateDevices();
  return all.filter((d) => d.kind === 'videoinput');
}

const BASE_CONSTRAINTS = {
  width: { ideal: 1920 },
  height: { ideal: 1080 },
  frameRate: { ideal: 30 },
  // `ideal` never throws; `exact` throws OverconstrainedError on devices that
  // report no environment-facing camera at all.
  facingMode: { ideal: 'environment' },
};

export function stopStream(stream) {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      /* already ended */
    }
  }
}

/**
 * Apply only the constraints the track actually advertises.
 * Calling applyConstraints with an unsupported key rejects and can leave the
 * stream unusable, so every key is checked against getCapabilities() first.
 *
 * @returns {Promise<string[]>} the constraint keys that were applied
 */
export async function applySafeConstraints(track, wanted) {
  const applied = [];
  if (!track || typeof track.getCapabilities !== 'function') return applied;
  let caps = {};
  try {
    caps = track.getCapabilities() || {};
  } catch {
    return applied;
  }
  for (const [key, value] of Object.entries(wanted)) {
    if (!(key in caps)) continue;
    try {
      await track.applyConstraints({ [key]: value });
      applied.push(key);
    } catch {
      /* capability advertised but rejected — ignore, it is not essential */
    }
  }
  return applied;
}

/**
 * Open the best available rear camera.
 *
 * @param {{deviceId?: string}} [opts] force a specific device (manual switch)
 * @returns {Promise<{stream, track, deviceId, label, ranked, settings, applied}>}
 */
export async function openBestCamera(opts = {}) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw Object.assign(new Error('This browser cannot access the camera.'), { code: 'unsupported' });
  }

  let stream;
  let ranked = [];

  if (opts.deviceId) {
    // Manual override: honour it, and do not second-guess the user.
    stream = await navigator.mediaDevices.getUserMedia({
      video: { ...BASE_CONSTRAINTS, deviceId: { exact: opts.deviceId } },
      audio: false,
    });
  } else {
    // Phase 1 — ask for a rear camera without naming one.
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: BASE_CONSTRAINTS, audio: false });
    } catch (err) {
      if (err?.name === 'NotAllowedError' || err?.name === 'SecurityError') {
        throw Object.assign(new Error('Camera permission was blocked.'), { code: 'denied', cause: err });
      }
      if (err?.name === 'NotFoundError' || err?.name === 'OverconstrainedError') {
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      } else {
        throw err;
      }
    }

    // Phase 2 — labels exist only now. Re-rank and upgrade if we can do better.
    const devices = await listVideoInputs();
    if (hasLabels(devices)) {
      ranked = rankCameras(devices);
      const currentId = stream.getVideoTracks()[0]?.getSettings?.().deviceId;
      const best = ranked.find((d) => d.score > 0 && d.deviceId && d.deviceId !== currentId);
      if (best) {
        try {
          const better = await navigator.mediaDevices.getUserMedia({
            video: { ...BASE_CONSTRAINTS, deviceId: { exact: best.deviceId } },
            audio: false,
          });
          stopStream(stream);
          stream = better;
        } catch {
          /* keep the working stream rather than failing the scan */
        }
      }
    }
  }

  const track = stream.getVideoTracks()[0] || null;
  if (!track) {
    stopStream(stream);
    throw Object.assign(new Error('No video track was returned by the camera.'), { code: 'no_track' });
  }

  // Focus and exposure: continuous AF is the single biggest win for reading a
  // small barcode on a glossy laminated card.
  const applied = await applySafeConstraints(track, {
    focusMode: 'continuous',
    exposureMode: 'continuous',
    whiteBalanceMode: 'continuous',
  });

  // If we skipped ranking earlier (no labels), still produce a list for the UI.
  if (!ranked.length) {
    const devices = await listVideoInputs();
    ranked = hasLabels(devices) ? rankCameras(devices) : [];
  }

  const settings = typeof track.getSettings === 'function' ? track.getSettings() : {};
  const match = ranked.find((d) => d.deviceId && d.deviceId === settings.deviceId);

  return {
    stream,
    track,
    deviceId: settings.deviceId || '',
    label: match?.label || track.label || 'camera',
    ranked,
    settings,
    applied,
  };
}

/** Torch is only available on some rear cameras; probe rather than assume. */
export function torchSupported(track) {
  try {
    return track?.getCapabilities?.()?.torch === true;
  } catch {
    return false;
  }
}

export async function setTorch(track, on) {
  const applied = await applySafeConstraints(track, { torch: Boolean(on) });
  return applied.includes('torch');
}
