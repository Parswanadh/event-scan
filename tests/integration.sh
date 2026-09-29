#!/usr/bin/env bash
# End-to-end integration test against a locally running `wrangler dev`.
#
#   terminal 1:  wrangler dev --port 8787
#   terminal 2:  bash tests/integration.sh
#
# Exercises the real Worker, the real D1 binding and the real default export —
# not mocks. Fails loudly on the first broken contract.

set -uo pipefail

BASE="${BASE:-http://127.0.0.1:8787}"
PIN="${PIN:-1234}"
PASS=0
FAIL=0

pass() { PASS=$((PASS + 1)); printf '  \033[32mPASS\033[0m %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf '  \033[31mFAIL\033[0m %s\n' "$1"; [ -n "${2:-}" ] && printf '       %s\n' "$2"; }

# assert_eq <label> <expected> <actual>
assert_eq() {
  if [ "$2" = "$3" ]; then pass "$1"; else fail "$1" "expected [$2] got [$3]"; fi
}

# assert_contains <label> <needle> <haystack>
assert_contains() {
  case "$3" in *"$2"*) pass "$1" ;; *) fail "$1" "expected to contain [$2] in [${3:0:200}]" ;; esac
}

code() { # code <method> <path> [data] [auth]
  local method="$1" path="$2" data="${3:-}" auth="${4:-}"
  local args=(-s -o /tmp/ev-body -w '%{http_code}' -X "$method" "$BASE$path")
  [ -n "$data" ] && args+=(-H 'Content-Type: application/json' -d "$data")
  [ -n "$auth" ] && args+=(-H "Authorization: Bearer $auth")
  curl "${args[@]}"
}
body() { cat /tmp/ev-body; }

echo
echo "Integration tests against $BASE"
echo "──────────────────────────────────────────────────────────"

# ── 1. health ────────────────────────────────────────────────────────────
echo "· health"
assert_eq "GET /api/health -> 200" "200" "$(code GET /api/health)"
assert_contains "health reports ok:true" '"ok":true' "$(body)"
assert_contains "all 4 tables present" '"tables":4' "$(body)"

# ── 2. static assets ─────────────────────────────────────────────────────
echo "· static assets"
assert_eq "GET / -> 200" "200" "$(code GET /)"
assert_contains "index.html is the app shell" 'Attendance Scanner' "$(body)"
assert_eq "GET /styles.css -> 200" "200" "$(code GET /styles.css)"
assert_eq "GET /js/app.js -> 200" "200" "$(code GET /js/app.js)"
assert_eq "GET /js/camera.js -> 200" "200" "$(code GET /js/camera.js)"
assert_eq "GET /js/scanner.js -> 200" "200" "$(code GET /js/scanner.js)"
assert_eq "GET /js/regno.js -> 200" "200" "$(code GET /js/regno.js)"
assert_eq "GET /vendor/zxing.min.js -> 200" "200" "$(code GET /vendor/zxing.min.js)"
assert_eq "missing asset -> 404" "404" "$(code GET /js/nope.js)"
assert_eq "unknown api route -> 404" "404" "$(code GET /api/nope)"

# ── 3. auth ──────────────────────────────────────────────────────────────
echo "· organizer auth"
assert_eq "wrong PIN -> 401" "401" "$(code POST /api/auth '{"pin":"0000"}')"
assert_contains "wrong PIN reports invalid_pin" 'invalid_pin' "$(body)"

assert_eq "correct PIN -> 200" "200" "$(code POST /api/auth "{\"pin\":\"$PIN\"}")"
TOKEN="$(python3 -c "import json;print(json.load(open('/tmp/ev-body')).get('token',''))")"
if [ -n "$TOKEN" ]; then pass "auth returns a token"; else fail "auth returns a token" "empty"; fi

assert_eq "protected route without token -> 401" "401" "$(code GET /api/scans)"
assert_eq "protected route with bad token -> 401" "401" "$(code GET /api/scans '' 'nope.zzz')"
assert_eq "protected route with token -> 200" "200" "$(code GET /api/scans '' "$TOKEN")"
assert_eq "export without token -> 401" "401" "$(code GET /api/export.csv)"

# ── 4. config + status ───────────────────────────────────────────────────
echo "· public config"
assert_eq "GET /api/config -> 200" "200" "$(code GET /api/config)"
assert_contains "config reports the PIN length" '"pin_length":6' "$(body)"
assert_contains "config reports the IN->OUT gap" '"min_gap_minutes":40' "$(body)"

regno() { printf 'BL.EN.U4EAC24%03d' "$(( (RANDOM % 900) + 100 ))"; }

echo "· status on an unknown card"
NEW="$(regno)"
assert_eq "GET /api/status -> 200" "200" "$(code GET "/api/status?reg_no=$NEW&event=InOut")"
assert_contains "unknown card is 'new'" '"state":"new"' "$(body)"
assert_contains "unknown card suggests IN" '"suggest":"in"' "$(body)"
assert_eq "status without reg_no -> 400" "400" "$(code GET '/api/status?event=InOut')"

# ── 5. the IN / OUT state machine ────────────────────────────────────────
echo "· first scan is an IN"
assert_eq "POST /api/scan -> 201" "201" \
  "$(code POST /api/scan "{\"reg_no\":\"$NEW\",\"raw_code\":\"^$NEW~\",\"event_name\":\"InOut\",\"periods\":[1,2,5]}")"
assert_contains "direction is in" '"direction":"in"' "$(body)"
assert_contains "hours = count of selected periods" '"hours":3' "$(body)"
assert_contains "reg no echoed back" "$NEW" "$(body)"
assert_contains "server marks it a valid reg no" '"valid_reg_no":true' "$(body)"
assert_contains "periods kept verbatim" '"periods":[1,2,5]' "$(body)"

echo "· status now reports them inside"
assert_eq "GET /api/status -> 200" "200" "$(code GET "/api/status?reg_no=$NEW&event=InOut")"
assert_contains "state is in" '"state":"in"' "$(body)"
assert_contains "suggests OUT next" '"suggest":"out"' "$(body)"
assert_contains "flags too_soon" '"too_soon":true' "$(body)"

echo "· the 40-minute rule"
assert_eq "immediate OUT -> 409" "409" "$(code POST /api/scan "{\"reg_no\":\"$NEW\",\"event_name\":\"InOut\",\"direction\":\"out\"}")"
assert_contains "409 explains too_soon" 'too_soon' "$(body)"
assert_contains "409 carries the elapsed minutes" '"minutes":0' "$(body)"
assert_eq "second IN while already IN -> 409" "409" "$(code POST /api/scan "{\"reg_no\":\"$NEW\",\"event_name\":\"InOut\",\"direction\":\"in\"}")"
assert_contains "409 explains already_in" 'already_in' "$(body)"

echo "· forced OUT closes the session"
assert_eq "POST force OUT -> 201" "201" \
  "$(code POST /api/scan "{\"reg_no\":\"$NEW\",\"event_name\":\"InOut\",\"direction\":\"out\",\"force\":true}")"
assert_contains "direction is out" '"direction":"out"' "$(body)"
assert_contains "session_minutes recorded" '"session_minutes":0' "$(body)"

echo "· after OUT they can come back IN"
assert_eq "GET /api/status -> 200" "200" "$(code GET "/api/status?reg_no=$NEW&event=InOut")"
assert_contains "state is out" '"state":"out"' "$(body)"
assert_contains "suggests IN next" '"suggest":"in"' "$(body)"
assert_eq "OUT with no open session -> 409" "409" "$(code POST /api/scan "{\"reg_no\":\"$NEW\",\"event_name\":\"InOut\",\"direction\":\"out\"}")"
assert_contains "409 explains no_open_session" 'no_open_session' "$(body)"
assert_eq "re-entry IN -> 201" "201" "$(code POST /api/scan "{\"reg_no\":\"$NEW\",\"event_name\":\"InOut\",\"direction\":\"in\",\"periods\":[3]}")"

echo "· an unknown direction is inferred, not trusted"
INF="$(regno)"
assert_eq "garbage direction -> 201" "201" \
  "$(code POST /api/scan "{\"reg_no\":\"$INF\",\"event_name\":\"InOut\",\"direction\":\"sideways\"}")"
assert_contains "inferred as in" '"direction":"in"' "$(body)"

echo "· period selection"
assert_eq "periods outside 1-8 -> 400" "400" \
  "$(code POST /api/scan "{\"reg_no\":\"$(regno)\",\"event_name\":\"InOut\",\"periods\":[1,9]}")"
assert_contains "400 names invalid_periods" 'invalid_periods' "$(body)"
assert_eq "non-contiguous periods accepted" "201" \
  "$(code POST /api/scan "{\"reg_no\":\"$(regno)\",\"event_name\":\"InOut\",\"periods\":[1,2,3,7,8]}")"
assert_contains "5 selected -> 5 hours" '"hours":5' "$(body)"
assert_eq "no periods at all -> 201" "201" \
  "$(code POST /api/scan "{\"reg_no\":\"$(regno)\",\"event_name\":\"InOut\"}")"
assert_contains "hours null when nothing selected" '"hours":null' "$(body)"
assert_eq "legacy range still works -> 201" "201" \
  "$(code POST /api/scan "{\"reg_no\":\"$(regno)\",\"event_name\":\"InOut\",\"period_start\":4,\"period_end\":7}")"
assert_contains "range P4-P7 -> 4 hours" '"hours":4' "$(body)"
assert_eq "bad legacy range -> 400" "400" \
  "$(code POST /api/scan "{\"reg_no\":\"$(regno)\",\"event_name\":\"InOut\",\"period_start\":5,\"period_end\":2}")"

echo "· normalization is server-side too"
LOWER="$(regno | tr 'A-Z' 'a-z')"
assert_eq "lowercase + noisy payload -> 201" "201" \
  "$(code POST /api/scan "{\"reg_no\":\"$LOWER\",\"event_name\":\"Normalize\"}")"
assert_contains "normalized to uppercase" "$(echo "$LOWER" | tr 'a-z' 'A-Z')" "$(body)"

echo "· validation"
assert_eq "empty reg_no -> 400" "400" "$(code POST /api/scan '{"periods":[1,2]}')"
assert_eq "malformed JSON -> 400" "400" "$(code POST /api/scan '{not json')"

# ── 5. reading it back ───────────────────────────────────────────────────
echo "· organizer reads"
assert_eq "GET /api/scans -> 200" "200" "$(code GET /api/scans '?limit=5' "$TOKEN")"
assert_contains "list contains our reg no" "$NEW" "$(body)"
assert_eq "GET /api/summary -> 200" "200" "$(code GET /api/summary '' "$TOKEN")"
assert_contains "summary has student count" '"students"' "$(body)"
assert_contains "summary has hours" '"hours"' "$(body)"
assert_contains "summary counts who is inside" '"in_now"' "$(body)"
assert_contains "summary reports the gap rule" '"min_gap_minutes":40' "$(body)"
assert_eq "GET /api/events -> 200" "200" "$(code GET /api/events '' "$TOKEN")"
assert_contains "events include InOut" 'InOut' "$(body)"

echo "· CSV export"
assert_eq "GET /api/export.csv -> 200" "200" "$(code GET /api/export.csv '' "$TOKEN")"
CSV="$(body)"
assert_contains "csv has header" 'Registration No' "$CSV"
assert_contains "csv has our row" "$NEW" "$CSV"
assert_contains "csv has Hours column" 'Hours' "$CSV"
assert_contains "csv has Direction column" 'Direction' "$CSV"
assert_contains "csv has Session Minutes column" 'Session Minutes' "$CSV"
assert_contains "csv has Periods column" 'Periods' "$CSV"
head -c 3 /tmp/ev-body | od -An -tx1 | grep -q 'ef bb bf' \
  && pass "csv starts with a UTF-8 BOM for Excel" \
  || fail "csv starts with a UTF-8 BOM for Excel" "$(head -c 3 /tmp/ev-body | od -An -tx1)"

echo "· roster"
assert_eq "POST /api/roster -> 200" "200" \
  "$(code POST /api/roster "{\"entries\":[{\"reg_no\":\"$NEW\",\"name\":\"Integration Test\"}]}" "$TOKEN")"
assert_contains "roster name joins into the list" 'Integration Test' "$(code GET /api/scans '?limit=5' "$TOKEN"; body)"

# ── 6. CORS preflight ────────────────────────────────────────────────────
echo "· CORS"
assert_eq "OPTIONS preflight -> 204" "204" "$(curl -s -o /dev/null -w '%{http_code}' -X OPTIONS "$BASE/api/scan")"

# ── summary ──────────────────────────────────────────────────────────────
echo "──────────────────────────────────────────────────────────"
printf 'Result: \033[32m%d passed\033[0m, ' "$PASS"
if [ "$FAIL" -gt 0 ]; then printf '\033[31m%d failed\033[0m\n\n' "$FAIL"; exit 1; fi
printf '0 failed\n\n'
