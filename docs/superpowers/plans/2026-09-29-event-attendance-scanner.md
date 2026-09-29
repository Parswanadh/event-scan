# Event Attendance Scanner — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Spec:** `docs/superpowers/specs/2026-09-29-event-attendance-scanner.md`
**Status:** all tasks complete and verified in production.

## Frozen interfaces

Agreed before any lane started, so parallel work could not silently diverge.

```js
// public/js/regno.js — pure, testable in Node, imported by BOTH the UI and the Worker
export function normalizeRegNo(raw: string): string
export function isValidRegNo(s: string): boolean
export function repairConfusables(s: string): string
export const REGNO_PATTERN: RegExp           // non-global, so .test() is stateless

// public/js/camera.js
export function scoreDevice(d): { score: number, reasons: string[] }
export function rankCameras(devices): Ranked[]
export async function openBestCamera(opts?): { stream, track, deviceId, label, ranked, settings, applied }
export async function applySafeConstraints(track, wanted): string[]

// public/js/scanner.js
export function createScanner({video, onResult, onStatus, onEngine, onDebug}): Scanner
// Scanner: start() stop() pause() resume() switchCamera() torchAvailable() setTorch() getState()
```

## Tasks

- [x] **Task 1 — Normalizer + unit tests** (agent lane: `public/js/regno.js`, `tests/regno.test.js`)
  - Verify: `node --test tests/regno.test.js` → **19 passed, 0 failed**
- [x] **Task 2 — Worker API + schema** (lane: `src/index.js`, `schema.sql`, `wrangler.jsonc`)
  - Verify: `wrangler deploy` succeeds; `curl /api/health` → `{"ok":true,"tables":4}`
- [x] **Task 3 — Mobile UI** (lane: `public/index.html`, `public/styles.css`)
  - Verify: every class in the HTML resolves in the CSS; `/styles.css` → 200
- [x] **Task 4 — Camera selection + dual-engine decode** (lane: `public/js/camera.js`, `public/js/scanner.js`, `public/vendor/`)
  - Verify: camera-ranking probe ranks the main rear lens first and the front last
- [x] **Task 5 — Integration suite** (lane: `tests/integration.sh`)
  - Verify: `bash tests/integration.sh` → **56 passed, 0 failed**, both locally and live
- [x] **Task 6 — Deploy + custom domain**
  - Verify: `https://scan.parswanadh.dev/api/health` → 200, all 10 assets → 200
- [x] **Task 7 — Ledger + repo**
  - Verify: `gh repo view Parswanadh/event-scan`; `PROGRESS.md` committed

## Parallel-lane discipline

Four subagents were dispatched, capped at **2 concurrent** because only ~2.5 GB
RAM was available on this machine (see `machine-resource-guard`). Lanes were
file-disjoint: the normalizer lane never touched the UI lane's files, and the
research lanes wrote no files at all.

## What the research lanes changed

Two audit subagents overturned assumptions that would otherwise have shipped:

1. `"camera2 0, facing back"` is not a real label — Chromium emits
   `"camera 0, facing back"`. The original regex was a no-op on every Android
   device. **Fixed in Task 4.**
2. ZXing's `setHints()` checks `ASSUME_CODE_39_CHECK_DIGIT` by presence, so
   setting it to `false` enabled it and would have broken plain Code39.
   **Fixed in Task 4.**
3. `@zxing/*` ESM builds cannot run unbundled (691 extensionless imports), which
   confirmed the vendored UMD choice.
4. `BarcodeDetector` is absent on Firefox and flag-gated on iOS Safari, which
   promoted the ZXing fallback from nice-to-have to load-bearing.

## Verification gate (run on the merged result)

```bash
node --test tests/regno.test.js                                   # 19/19
bash tests/integration.sh                                         # 56/56 local
BASE=https://scan.parswanadh.dev PIN=<pin> bash tests/integration.sh   # 56/56 live
curl -s https://scan.parswanadh.dev/api/health
```