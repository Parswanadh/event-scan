# PROGRESS

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

1. **Scan the real ID card once and read `scans.raw_code` from D1.** The barcode
   symbology and payload format were never verified — no decoder existed on the
   build machine. Everything else is defensive around that one unknown. Command:
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

- **Unverified: the barcode symbology and payload.** See Next #1. This is the
  single highest-risk unknown in the build.
- **Untested on real hardware.** No Android or iOS device was available, so the
  camera behaviour, decode reliability, and touch interactions are verified by
  unit probes and code review only — never on a phone. The `?debug=camera` panel
  exists precisely to close this gap in one tap.
- **`data_matrix` / `pdf417` native formats** are requested from
  `BarcodeDetector` but are not in ZXing's `POSSIBLE_FORMATS` list here; a QR or
  DataMatrix ID card would decode natively on Android but fall back to the
  generic ZXing path elsewhere.
- **No offline queue.** A scan requires connectivity; a failed POST shows a
  retryable error rather than queueing.
- **No UI for editing or deleting scans.** Corrections currently need the D1
  console.
- **`not_found_handling: "none"`** means a mistyped URL returns a bare 404 with
  no branded page. Deliberate — SPA fallback would have masked typo'd asset
  paths as `200 index.html`, which is far harder to debug.
