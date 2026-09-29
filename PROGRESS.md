# PROGRESS

## 2026-09-29 (later) — Remove the participant role; PIN guards reading only

**Did:** The first deploy had a Participant/Organizer picker on the landing
screen. The user corrected the requirement: **everyone scans on behalf of
everyone else** — a volunteer works through a stack of ID cards — so a
"scan your own ID" mode does not describe the event and the picker was pure
friction. Reworked so that:

- The **scanner is the app**. Landing goes straight to the camera; there is no
  role screen and no `localStorage` role. Nobody signs in to scan.
- The PIN now guards **reading, not writing** — the top-right chip is a **Sheet**
  button that opens the attendance list and export after the PIN. Scanning was
  already public server-side; the client just stopped gating it.
- `scan_type` is uniformly `check-in` (the organizer/participant distinction is
  gone from the data as well as the UI).
- Deleted the now-dead `.choices` / `.choice*` CSS (1,156 bytes) and the
  `getRole`/`setRole` helpers, so nothing is left claiming a role exists.

**Found:** Removing a role from a single-page app is mostly a *deletion* problem,
and the risk is a dangling reference rather than a logic error. Added a static
contract check that is worth keeping:

```
every $("id") in the JS resolves to a real element
views:      ['confirm','dash','debug','done','pin','scan']
data-goto:  ['scan']  — dangling targets: none
VIEWS in app.js == views in index.html
```

That check would have caught the failure mode this refactor invites: a view ID
removed from the HTML while `showView()` still names it, which throws only at the
moment a user taps the thing.

**Passed / Failed:**

| Command | Result |
|---|---|
| `node --check` on all 5 modules + the Worker | all parse |
| `npx csstree-validator public/styles.css` | clean (exit 0) |
| DOM-contract static check | 60 ids, 0 dangling |
| `POST /api/scan` with no credentials | **201** (scanning is open) |
| `GET /api/scans` with no credentials | **401** (sheet is protected) |
| `BASE=https://scan.parswanadh.dev bash tests/integration.sh` | **56/56** |
| deployed HTML contains `data-role`/`view-role` | 0 occurrences |

**Next:** unchanged — scan a real card and read `scans.raw_code` from D1.

**Safety:** the smoke-test row written while verifying (`event_name =
'SmokeTest'`) was deleted from production D1. The sheet PIN is unchanged
(`919148`) and is stored only as a Worker secret.

---

## 2026-09-29 — Build and deploy the barcode attendance scanner (2-hour budget)

**Did:** Built and deployed a complete mobile barcode attendance scanner for
Amrita Bengaluru events on the user's own Cloudflare zone. One Worker
(`event-scan`) serves a no-build vanilla-JS front end plus a JSON API, backed by
a new D1 database (`event-scan-db`, APAC, id `ea2de699-3156-49f4-a2c6-b8722935fefc`).
The scanner opens the phone's main rear camera, decodes the ID-card barcode,
normalizes the registration number, takes the attendance duration as a period
range P1–P8, and records `(reg_no, periods, hours, timestamp, raw_code, device)`
to D1. An organizer view is gated by a 6-digit PIN and offers a live sheet plus
an Excel-compatible CSV export.

**Live:** <https://scan.parswanadh.dev>
**Repo:** <https://github.com/Parswanadh/event-scan>

**Found:**

- `wrangler zones list` does not exist in wrangler 4.x; the zone list had to come
  from the Cloudflare API with the OAuth token out of
  `~/.wrangler/config/default.toml`. That token was past expiry but carries
  `offline_access` and refreshed silently, so every `wrangler` command worked
  non-interactively.
- `compatibility_date: "2026-08-01"` was **rejected** — the installed workerd
  binary's newest supported date is `2026-07-29`. The runtime refused to start
  with a clear error. Pinned to 2026-07-29.
- The Android Chrome camera label is `"camera 0, facing back"`, **not**
  `"camera2 0, facing back"` — Chromium builds it in
  `VideoCaptureCamera2.getName()` as `"camera " + index + ", facing " + facing`.
  "camera2" is the Android API name and never appears in the label, so a
  `camera2\s+(\d+)` regex is a silent no-op on every real device. Caught by a
  subagent reading the Chromium source rather than by testing, because no
  Android device was available to test on.
- ZXing's `MultiFormatReader.setHints()` checks `TRY_HARDER` and
  `ASSUME_CODE_39_CHECK_DIGIT` by **presence** (`!== undefined`), so
  `hints.set(ASSUME_CODE_39_CHECK_DIGIT, false)` *enables* it. Removed.
- `BarcodeDetector` is absent on Firefox entirely and behind an off-by-default
  flag on iOS Safari, so the ZXing fallback is load-bearing, not decorative.
  The `@zxing/*` ESM builds cannot run unbundled (691 extensionless relative
  imports in `@zxing/library/esm`), so the UMD bundle is vendored at
  `/vendor/zxing.min.js` as the `ZXing` global.
- The `--local` D1 and the remote D1 are separate databases; the schema had to be
  applied twice, once with `--local` and once with `--remote`.
- **The barcode is high-density.** The reference photo of the real card was
  attacked with two independent decoders — `zxing-cpp` (try-harder, all four
  binarizers, ±10° rotation sweep, 1–8× LANCZOS upscaling, Otsu and adaptive
  thresholds, and a single-scanline reconstruction that removes vertical blur)
  and `zbar` via `pyzbar` — and **neither read it**. The band was located
  correctly and the bars are individually resolvable to the eye (verified by
  cropping and rendering it), so this is not a cropping error: the photograph is
  soft enough that module-width *ratios* are destroyed, which is exactly what a
  width-modulated 1D symbology encodes. Two strong decoders agreeing on "no
  read" is the evidence; "I could not decode it" alone would not have been.
  Practical consequence: the dominant field failure will be **standing too far
  away**, so the scanner now coaches it ("Move closer — fill the box with the
  barcode" at 7 s, then a tilt/glare hint pointing at manual entry at 16 s).

**Passed / Failed:**

| Command | Result |
|---|---|
| `node --test tests/regno.test.js` | **19/19 pass** |
| `bash tests/integration.sh` (wrangler dev) | **56/56 pass** |
| `BASE=https://scan.parswanadh.dev PIN=… bash tests/integration.sh` | **56/56 pass** |
| `curl https://scan.parswanadh.dev/api/health` | `{"ok":true,"db":"reachable","tables":4}` |
| all 10 static assets | 200, correct content-types |
| `wrangler deploy` | success; `scan.parswanadh.dev (custom domain)` attached |
| camera ranking unit probe | main rear ranked 1st (130), front last (−182) |

Three integration assertions failed on the first local run: one was a real
missing artifact (`styles.css` had not been delivered yet), two were **a bug in
my own test** — `"$${RANDOM}"` in bash is the PID plus a literal `{RANDOM}`, so
both "distinct" registration numbers were identical and the second POST was
correctly rejected as a duplicate. The test was fixed, not the code.

**Next:**

1. **Scan the real ID card once and read `scans.raw_code` from D1.** The payload
   is still unknown: the reference *photograph* could not be decoded (see above),
   so the symbology and the exact payload string remain unverified. Everything is
   defensive around that unknown. Scanning with the phone's own camera at close
   range is a fundamentally better signal than this photo. Command:
   `wrangler d1 execute event-scan-db --remote --command "SELECT reg_no, raw_code, device FROM scans ORDER BY id DESC LIMIT 5"`
2. Open `https://scan.parswanadh.dev/?debug=camera` on the actual Android phone
   and confirm the highlighted device is the main lens in the venue lighting.
3. Change the organizer PIN from the generated one (see Safety below).
4. Optional: import a roster CSV so the sheet shows names instead of only
   registration numbers.

**Safety:**

- The generated organizer PIN is `919148`. It is stored only as a Worker secret;
  change it with
  `printf 'NEWPIN' | wrangler secret put ORGANIZER_PIN && wrangler deploy`.
- `SESSION_SECRET` is a fresh 32-byte random value, set as a Worker secret.
  `.dev.vars` holds the local-dev values and is git-ignored; only
  `.dev.vars.example` is committed.
- The custom domain `scan.parswanadh.dev` was free and unclaimed. Three sibling
  hostnames on the same Free-plan zone already run Workers, so this was a
  low-risk attach. No pre-existing DNS record was touched.
- Integration tests ran against **production** D1 and wrote real rows. All test
  rows (events `Integration`, `Ranges`, `DupTest`, the roster entry, and every
  `auth_attempts` row) were deleted afterwards; `SELECT COUNT(*) FROM scans`
  now returns **0**.
- No long-running or background jobs were left running. `wrangler dev` on port
  8787 may still be alive from testing — stop it with
  `pkill -f 'wrangler dev'`.
- The 2-hour deadline timer ran under `.timer/` (git-ignored). Work completed
  with time to spare.

## Known broken / open

- **Unverified: the barcode symbology and payload.** The reference photograph is
  undecodable by two independent decoders (see "Found" above), so the symbology
  and payload string are still unconfirmed. This remains the highest-risk
  unknown. See Next #1.
- **Untested on real hardware.** No Android or iOS device was available, so the
  camera behaviour, decode reliability, and touch interactions are verified by
  unit probes and code review only — never on a phone. The `?debug=camera` panel
  exists precisely to close this gap in one tap.
- **The dense barcode may need a closer working distance than is comfortable**,
  and the reference photo suggests the printed module width is small. If field
  testing shows it is still unreliable at close range, the fix is a tighter
  reticle plus digital zoom via the `zoom` capability (currently unused), not a
  decoder change.
- **`data_matrix` / `pdf417` native formats** are requested from
  `BarcodeDetector` but are not in ZXing's `POSSIBLE_FORMATS` list here; a QR or
  DataMatrix ID card would decode natively on Android but fall back to the
  generic ZXing path elsewhere.
- **The vendored ZXing is `@zxing/library`'s UMD (global `ZXing`), not
  `@zxing/browser`'s.** The research lane flagged the former as the legacy
  browser layer. It works — `BrowserMultiFormatReader` and
  `decodeFromVideoElementContinuously` were both confirmed present at runtime
  and are what the code uses — but `@zxing/browser@0.1.5/umd/zxing-browser.min.js`
  (global `ZXingBrowser`) is the maintained equivalent and a sensible future swap.
- **No offline queue.** A scan requires connectivity; a failed POST shows a
  retryable error rather than queueing.
- **No UI for editing or deleting scans.** Corrections currently need the D1
  console.
- **`not_found_handling: "none"`** means a mistyped URL returns a bare 404 with
  no branded page. Deliberate — SPA fallback would have masked typo'd asset
  paths as `200 index.html`, which is far harder to debug. A `404.html` plus
  `"404-page"` would be the friendlier upgrade.
- **`.timer/` is git-ignored**, so the deadline timer and the scratch decode
  artifacts under `.timer/scan/` are not in the repository.
