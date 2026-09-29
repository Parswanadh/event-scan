# Event Attendance Scanner — Design

**Date:** 2026-09-29
**Domain:** `scan.parswanadh.dev`
**Status:** agreed with user (all five open decisions confirmed before implementation)

## Goal

Students at Amrita Vishwa Vidyapeetham Bengaluru hold ID cards carrying a barcode that
encodes their registration number (e.g. `BL.EN.U4EAC24012`). Event organizers currently
have no fast way to record who attended and for how long. Build a mobile-first web app
that opens the phone's **main rear camera**, scans that barcode, extracts the registration
number, asks for the attendance duration as a **period range P1–P8**, and records
`(reg_no, periods, hours, timestamp)` into a Cloudflare D1 database — with an organizer
view that shows the live attendance sheet and exports it to Excel.

The whole thing is deployed as one Cloudflare Worker on the user's own domain. No
separate backend, no third-party SaaS in the request path.

## Success criteria

1. `https://scan.parswanadh.dev` loads over HTTPS and renders a usable UI at a 360 px
   viewport width without horizontal scroll.
2. `curl -s https://scan.parswanadh.dev/api/health` returns `{"ok":true,...}` with the D1
   binding reported as reachable.
3. Tapping **Scan** requests the camera with `facingMode: environment`, and the stream
   that is actually opened is the **main rear** camera — verified by reading back
   `track.getSettings()` / chosen `deviceId` label and asserting the label is not
   telephoto/ultra-wide/front. A `?debug=camera` panel shows the ranked device list.
4. Scanning a Code128 barcode whose payload is `BL.EN.U4EAC24012` yields exactly
   `BL.EN.U4EAC24012` after normalization; a payload wrapped in noise
   (e.g. `^BL.EN.U4EAC24012~`, lowercase, trailing `\r\n`) normalizes to the same value.
   Proven by unit tests, not by eye.
5. Submitting a scan with periods `P1`–`P3` writes one row to D1 with `hours = 3`,
   `period_start = 1`, `period_end = 3`, and a UTC ISO timestamp.
6. The organizer dashboard lists that row after a reload, and `GET /api/export.csv`
   downloads a UTF-8-BOM CSV whose header row and data row are correct.
7. `POST /api/scan` without a valid organizer session still works (participant self
   check-in), but `GET /api/scans` and `GET /api/export.csv` return **401** without a
   valid session. A wrong PIN returns 401 and is rate-limited.
8. `wrangler deploy` succeeds, and `https://scan.parswanadh.dev` serves the built
   `index.html` — the custom domain route is live on the Free-plan zone.
9. A GitHub repository exists under the user's account with the full history pushed.

## Non-goals

- No student login, no college SSO, no OTP. Attendance is barcode-possession-based.
- No offline mode / service-worker queue. The venue is assumed to have connectivity;
  a failed POST shows a visible retryable error instead of silently dropping a scan.
- No face recognition, no photo capture of the student, no storage of camera imagery.
- No multi-tenant org model. One deployment serves one club/organizer. `event` is a
  label the organizer types, not a first-class tenant.
- No native `.xlsx` binary generation in v1 — CSV with a UTF-8 BOM is what Excel opens
  natively. (Tracked as a possible follow-up.)
- No admin UI for editing/deleting individual scans in v1 (the D1 console does that).

## Constraints

- **Stack:** Cloudflare Worker + Workers Assets + D1. Vanilla ES-module JS, no bundler,
  no `npm install` in the critical path — vendor the barcode library as a static file
  so the build is `wrangler deploy` and nothing else.
- **Machine budget:** ~2.5 GB RAM available. Max 2 concurrent subagents; `-j` fan-out
  and any Node build must stay small. See `machine-resource-guard`.
- **Time budget:** a hard 2-hour timer started at 19:38 local, deadline 21:38.
- **Domain:** exactly one zone exists (`parswanadh.dev`, Free plan). The app goes on the
  `scan` hostname so the root domain stays free.
- **Secrets:** `ORGANIZER_PIN` and `SESSION_SECRET` are Worker secrets, never committed.
  `.dev.vars` is git-ignored; a `.dev.vars.example` is committed instead.
- **No PII beyond the registration number.** The registration number is the only
  identifier stored; no names unless the organizer imports an optional roster.

## Design

### Roles

A single page with two entry points:

- **Participant / self check-in** — the default. Scan → confirm reg no → pick periods →
  submit. No login.
- **Organizer** — PIN gate. Scan on behalf of a student *and* view/export the sheet.

The user asked that "for the initial scan the scanner should be able to opt as
organizer", so the role choice is the first thing on the screen and is remembered in
`localStorage`. Choosing Organizer the first time prompts for the PIN; a wrong PIN does
not lock the participant path.

### Camera selection (the part most likely to be got wrong)

`facingMode: 'environment'` alone is **not** a guarantee of the main lens on Android,
because the platform may hand back the first enumerated rear sensor, which on some
devices is the ultra-wide or telephoto. Therefore:

1. Request `facingMode: { ideal: 'environment' }` (never `exact`, which throws
   `OverconstrainedError` on devices without a labelled rear camera).
2. Only *after* permission is granted does `enumerateDevices()` expose labels.
   Re-enumerate at that point and score every `videoinput`:
   - strong positive for `back` / `rear` / `environment` / `main` / `camera2 0`
   - strong negative for `front` / `user` / `face`
   - negative for `tele`, `telephoto`, `ultra`, `ultrawide`, `wide angle`, `macro`,
     `depth`, `monochrome`, `truedepth`
   - prefer the highest-resolution capability as a tie-break
3. Open the winning `deviceId`. If the device reports a `zoom` capability whose range
   starts well above 1×, that is a telephoto signal — down-rank it.
4. Apply `focusMode: 'continuous'` and `torch` defensively: read
   `track.getCapabilities()` first and only `applyConstraints` for keys that exist, so
   an unsupported constraint never rejects and kills the stream.
5. Offer a manual "switch camera" control so a bad automatic pick is recoverable in the
   field, and a `?debug=camera` view that prints the ranked list for diagnosis.

### Decoding

Two engines, best-first, because the failure of one should not fail the scan:

- Native `BarcodeDetector` when `'BarcodeDetector' in window` and
  `getSupportedFormats()` includes the needed symbologies (fast, hardware-assisted,
  present on Android Chrome).
- Vendored ZXing (`@zxing/browser` + `@zxing/library` as static files under
  `/vendor/`) as the universal fallback for iOS Safari/Firefox, and as a second attempt
  when the native detector returns nothing for several seconds.

Decode is driven off the `<video>` element with a throttled loop (not every frame), and
a hit is debounced so the same barcode is not submitted thirty times a second. A manual
text field is always available — a laminated card with glare must not be a dead end.

### Normalization

`normalizeRegNo(raw)` uppercases, strips control characters and surrounding punctuation,
collapses internal whitespace, then extracts the first token matching a permissive
`[A-Z]{2}\.[A-Z]{2}\.[A-Z]\d[A-Z]{3}\d{5}`-style pattern, falling back to "the whole
trimmed string" when nothing matches so that unanticipated formats are still recorded
rather than rejected. The raw decoded payload is stored alongside the normalized value,
so a parser mistake is diagnosable after the event instead of being lost.

Character-confusion repair (`O`↔`0`, `I`↔`1`, `S`↔`5`) is applied **only inside the
numeric tail** of an otherwise well-formed candidate, never to the alphabetic prefix —
over-eager repair silently invents a different student's registration number, which is
worse than recording nothing.

### Data model (D1)

```sql
events(id, name, created_at)                 -- organizer-created label
scans(id, reg_no, raw_code, event_id, scan_type,
      period_start, period_end, hours,
      scanned_at, scanned_at_local, device, ua, created_at)
roster(reg_no PRIMARY KEY, name)             -- optional CSV import, name lookup only
```

`hours` is derived at write time as `period_end - period_start + 1` (P1–P3 ⇒ 3), and
also recomputed server-side so a tampered client cannot write an inconsistent pair.
`scanned_at` is stored as an ISO-8601 UTC string; `scanned_at_local` keeps the device's
own offset so an organizer reading the sheet at the venue sees wall-clock time.
Indexes on `scans(reg_no)` and `scans(scanned_at)`.

Duplicate handling: a second scan of the same `reg_no` for the same `event_id` within a
short window returns `409` with the existing record so the UI can say "already recorded
at 14:32 — update?" instead of creating a silent double entry. The organizer can force
an update.

### API

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET  | `/api/health` | none | liveness + D1 reachability |
| POST | `/api/auth` | PIN body | exchange PIN for a signed session token |
| POST | `/api/scan` | none (organizer token optional) | record a scan |
| GET  | `/api/scans` | organizer | list/filter recent scans |
| GET  | `/api/summary` | organizer | counts + total hours |
| GET  | `/api/export.csv` | organizer | Excel-compatible export |

Sessions are stateless: `HMAC-SHA256(SESSION_SECRET, exp)` via WebCrypto, carried in an
`Authorization: Bearer` header and mirrored in `localStorage`. PIN comparison is
constant-time and failed attempts are rate-limited per IP using a D1 counter so a
4-digit PIN is not brute-forceable from a script.

### Front-end

Single `index.html`, one stylesheet, a handful of ES modules. Dark, high-contrast,
thumb-reachable: the primary action is a large bottom-anchored button. Period selection
is a two-handle P1–P8 range presentation with the derived hour count shown live, because
the user's requirement was explicitly "periods 1 to 8". No framework, no web fonts, no
network requests to third parties — so the app stays fast on venue wifi.

## Assumptions

- **[A1]** The barcode payload contains the registration number, possibly with extra
  delimiters. (User-confirmed; parser is defensive and stores `raw_code`.)
- **[A2]** Code128 is the symbology. Unverified — no decoder was available locally to
  read the sample card. Mitigated by enabling Code128/39/93/QR/EAN and by the manual
  fallback. *This is the single assumption most likely to be wrong.*
- **[A3]** Participants are trusted to self-report; the organizer view is the control.
- **[A4]** Organizers use modern Android Chrome; iOS is a supported fallback, not the
  primary target.
- **[A5]** `wrangler` OAuth login with the existing scope set can create a D1 database,
  deploy a Worker, and attach a custom domain non-interactively.

## Risks

| Risk | Mitigation |
|---|---|
| Barcode symbology differs from Code128 | Enable all plausible formats; vendor ZXing; manual entry; store `raw_code` |
| Camera picks telephoto on some Android | Label scoring + zoom-range check + manual switcher + `?debug=camera` |
| Free-plan zone rejects a custom domain route | Fall back to the `workers.dev` URL and report it; verify with `curl` before declaring success |
| Session token forgeable if `SESSION_SECRET` leaks | Secret is set via `wrangler secret put`, never committed, `.dev.vars` ignored |
| 2-hour budget overrun | Timer gates scope: a deployed, verified core beats an unfinished richer app. Stretch items are explicitly marked in the plan and dropped first. |
| Wrong registration number silently recorded | Normalization never guesses outside the numeric tail; `raw_code` retained; UI shows the parsed value for confirmation before submit |
