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
  confirm screen
      │   GET /api/status  →  are they currently IN or OUT?
      │   ├─ no open session  → arm IN
      │   ├─ open session ≥40min → arm OUT
      │   └─ open session <40min → arm OUT but warn "too soon"
      │   organizer may override with the IN/OUT toggle
      ▼  pick periods P1–P8 (tap to toggle) + POST /api/scan
  Worker ──▶ D1: scans(reg_no, direction, periods, hours, session_minutes, …)
      │
      ▼
  sheet (PIN) ──▶ GET /api/export.csv  (UTF-8 BOM, opens in Excel)
```

### IN / OUT attendance

The first scan of a student for an event is an **IN**. A later scan closes that
session as an **OUT** and records how long it lasted. The rule lives on the
server, not the client, so a tampered request cannot write an impossible state:

| Situation | Result |
|---|---|
| No open session | IN recorded |
| Open session, ≥ 40 min elapsed | OUT recorded, `session_minutes` set |
| Open session, < 40 min elapsed | **409 `too_soon`** — the organizer taps again to force it |
| IN while already IN | 409 `already_in` |
| OUT with no open session | 409 `no_open_session` |
| After an OUT | the next scan is a fresh IN |

The client asks `GET /api/status` as soon as a card is read and **arms the
direction the server implies**, showing why ("Currently IN · 52 min"). The
IN/OUT toggle is always visible so the organizer can deliberately override; the
option the server would reject is disabled rather than hidden, so it is obvious
*why* only one direction is available.

### Periods

Eight chips, tap to toggle — not a range slider. Tapping is easier one-handed
while holding a card, and it is strictly more expressive: **P1+P2+P5** is now
representable, which a range never was. `hours` is the count of selected
periods, derived server-side and never trusted from the client. Periods are
optional: an IN can be recorded without them.

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
npm test                           # 21 unit tests for the normalizer
npm run test:integration           # 87 assertions against the dev server
npm run test:ui                    # 32 assertions driving the real page in Chrome
```

`test:ui` needs `puppeteer-core` and a Chrome binary; it is the only test that
exercises the controller, the period chips, the IN/OUT toggle and the view
routing. It uses the manual-entry path, which funnels into the same
`handleScanResult()` code as a successful barcode read, so the flow is covered
without a camera or a card:

```bash
npm install --prefix /tmp/pptr puppeteer-core
node tests/ui.mjs https://scan.parswanadh.dev
```

It caught a real bug that every other test missed: `renderStatus()` cleared the
`forceNext` flag *after* it had been set, so the "record OUT anyway" override
never appeared and a second tap simply repeated the refused request.

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
| GET | `/api/config` | — | PIN length, the IN→OUT gap, period bounds |
| GET | `/api/status` | — | Current IN/OUT state for one card (`?reg_no=`, `?event=`) |
| POST | `/api/auth` | PIN body | Exchange the PIN for a signed session token |
| POST | `/api/scan` | — | Record an IN or OUT (`direction`, `periods[]`) |
| GET | `/api/scans` | organizer | List scans (`?q=`, `?event=`, `?limit=`) |
| GET | `/api/summary` | organizer | Students, who is inside now, totals |
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
