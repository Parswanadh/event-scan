# Event Attendance Scanner

Mobile-first barcode attendance scanner for Amrita Vishwa Vidyapeetham Bengaluru
events. Point a phone at the barcode on a college ID card, it reads the
registration number, asks for the attendance duration as a period range (P1–P8),
and records it. Organizers get a live sheet and an Excel-compatible export.

**Live:** <https://scan.parswanadh.dev>

- **Runtime:** one Cloudflare Worker + Workers Assets (no build step)
- **Data:** Cloudflare D1 (`event-scan-db`, APAC)
- **Front end:** vanilla ES modules, no framework, no bundler, no web fonts,
  no third-party requests at runtime

## How it works

```
  phone camera
      │  getUserMedia(facingMode: ideal environment)   ← main lens, see camera.js
      ▼
  BarcodeDetector  ──(or──▶  vendored ZXing)           ← dual engine
      │
      ▼  normalizeRegNo()  ── one implementation, imported by BOTH
  confirm screen: reg no + period ruler P1–P8 → hours
      │
      ▼  POST /api/scan
  Worker ──▶ D1: scans(reg_no, periods, hours, scanned_at, raw_code, device)
      │
      ▼
  organizer dashboard ──▶ GET /api/export.csv  (UTF-8 BOM, opens in Excel)
```

### Camera selection

`facingMode: 'environment'` does **not** guarantee the main lens on Android — the
platform may hand back the ultra-wide or the telephoto sensor. The scanner
therefore opens with `ideal` (never `exact`, which throws `OverconstrainedError`),
then re-enumerates once permission has revealed the device labels, scores every
input, and upgrades if the best candidate is not what it opened. Scoring
penalises `tele` / `ultra-wide` / `macro` / `depth` / `front` labels and any
device whose zoom range starts above 1×.

Open <https://scan.parswanadh.dev/?debug=camera> to see the ranked list on a
real phone, with the chosen device highlighted.

### One mode: scan

Anyone with the link can scan, on behalf of anyone. A volunteer at the door works
through a stack of ID cards — nobody signs in to be scanned.

| Action | Auth |
|---|---|
| Scan a card and record attendance | **none** |
| View the attendance sheet and export CSV/JSON | PIN (`Sheet` button, top right) |

The PIN guards **reading, not writing**: it protects the sheet, and never blocks a
queue at the door.

## Development

```bash
cp .dev.vars.example .dev.vars     # set ORGANIZER_PIN and SESSION_SECRET
npm run db:local                   # apply schema.sql to the local D1
npm run dev                        # http://localhost:8787
npm run test:integration           # 56 assertions against the dev server
npm test                           # 19 unit tests for the normalizer
```

## Deploy

```bash
wrangler d1 execute event-scan-db --remote --file=./schema.sql   # once
wrangler secret put ORGANIZER_PIN
wrangler secret put SESSION_SECRET
wrangler deploy
```

Change the sheet PIN at any time:

```bash
printf 'YOURNEWPIN' | wrangler secret put ORGANIZER_PIN && wrangler deploy
```

Verify the live deployment:

```bash
curl -s https://scan.parswanadh.dev/api/health
BASE=https://scan.parswanadh.dev PIN=<your-pin> bash tests/integration.sh
```

## API

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/health` | — | Liveness + D1 reachability |
| POST | `/api/auth` | PIN body | Exchange the PIN for a signed session token |
| POST | `/api/scan` | — | Record one attendance entry |
| GET | `/api/scans` | organizer | List scans (`?q=`, `?event=`, `?limit=`) |
| GET | `/api/summary` | organizer | Counts, distinct students, total hours |
| GET | `/api/events` | organizer | Event names |
| POST | `/api/roster` | organizer | Bulk upsert `reg_no → name` so the sheet shows names |
| GET | `/api/export.csv` | organizer | Excel-compatible download |

Sessions are stateless HMAC-SHA256 tokens (`Authorization: Bearer <exp>.<sig>`),
valid 12 hours. The PIN is compared as SHA-256 digests in constant time, and
failed attempts are rate limited per IP in D1 (8 per 15 minutes).

## Design notes

- **Hours are derived server-side** from `period_start`/`period_end`; the client's
  number is ignored, so a tampered request cannot write `hours` inconsistent with
  its own period range.
- **The normalizer is shared.** `src/index.js` imports `public/js/regno.js`, so
  there is exactly one definition of what a barcode means.
- **The raw payload is always stored** in `scans.raw_code`. If a future card
  encodes something unexpected, the mistake is diagnosable after the event
  rather than lost.
- **Character-confusion repair never touches the alphabetic prefix** — silently
  turning `BL.EN` into a different campus code would attribute attendance to the
  wrong student, which is worse than recording nothing.

## Known limitations

- **The barcode symbology on the sample card is unverified.** The reference
  *photograph* could not be decoded by either `zxing-cpp` (try-harder, all
  binarizers, rotation sweep, up to 8× upscaling) or `zbar` — the image is soft
  enough that the module-width ratios a 1D symbology encodes are destroyed. So
  Code128/39/93, Codabar, ITF, EAN/UPC, QR, DataMatrix and PDF417 are all
  enabled, with manual entry as a fallback. The first real scan will settle it:
  `raw_code` in D1 will show the truth.
- **The barcode is high-density**, so working distance matters more than usual.
  The scanner coaches the user ("Move closer — fill the box") after 7 seconds
  without a read, and points at manual entry after 16.
- Camera selection is heuristic. Labels are the only reliable signal the web
  platform exposes — and on Android they carry no lens information at all — so
  there is a manual switch button and the `?debug=camera` panel as the escape
  hatch.
- The vendored ZXing is `@zxing/library`'s UMD (global `ZXing`) rather than the
  maintained `@zxing/browser` build; swapping it is a drop-in future change.
- No offline queue: a scan needs connectivity, and a failed POST shows a visible,
  retryable error rather than dropping the record silently.
- No admin UI for editing or deleting individual scans; use the D1 console.
- Not yet tested on real phone hardware — see `PROGRESS.md`.

See `PROGRESS.md` for the session ledger and
`docs/superpowers/specs/` for the design rationale.
