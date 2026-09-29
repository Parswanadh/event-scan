/**
 * regno.js — turn an arbitrary decoded barcode payload into a canonical
 * Amrita Vishwa Vidyapeetham registration number.
 *
 * Canonical shape: `AA.AA.A9AAAAA99999` — e.g. `BL.EN.U4EAC24012`
 *
 *     BL     campus code           2 letters
 *     EN     school code           2 letters
 *     U4     1 letter + 1 digit
 *     EAC    programme code        2..5 letters
 *     24     admission year        2 digits  \
 *     012    roll number           3 digits  / -> the tail is always 5 digits
 *
 * The trailing five characters of a well-formed number are therefore *always*
 * digits, and that positional fact is what makes character-confusion repair
 * decidable at all.
 *
 * SAFETY RULE — "never guess outside the numeric tail"
 * ---------------------------------------------------
 * A registration number is an identity key, not free text. Rewriting `BL` as
 * `B1` or `EN` as `EM` does not recover a student, it *invents a different
 * student* — a silently wrong attendance row, attributed to somebody who was
 * not there, is worse than no row at all. So repair is allowed to touch only
 * the trailing five-character numeric run, and only when:
 *
 *   1. the candidate ends in an alphanumeric run with at least one character
 *      of prefix before that 5-character tail (so the tail is positionally
 *      identifiable),
 *   2. the tail already contains at least one real digit (an all-letter tail is
 *      programme code — `...U4EIS24012` must never be "repaired"), and
 *   3. the *fully repaired* candidate still matches the whole structure
 *      (2-letter campus, 2-letter school, letter+digit, 2..5 programme
 *      letters, 5 digits).
 *
 * If any of those fail, the input is returned byte-for-byte unchanged and the
 * caller records it verbatim instead of guessing. The raw payload is stored by
 * the caller alongside the normalized value, so a misparse stays diagnosable.
 *
 * normalizeRegNo is also idempotent: it either returns a canonical number (which
 * re-normalizes to itself) or a fallback string that contains nothing further to
 * extract, so re-reading a stored value can never change what it means.
 *
 * Dependency-free ES module: no imports, no `require`, no Node or DOM globals,
 * so the exact same file is loaded by the browser page and by `node --test`.
 * All scanning is done with index loops rather than trailing-anchored regular
 * expressions, which would backtrack quadratically on long payloads.
 */

/* ================================================================== *
 * Shapes
 * ================================================================== */

/**
 * Canonical shape as a RegExp (no /g flag, so it is safe to reuse with .test()).
 * @type {RegExp}
 */
export const REGNO_PATTERN = /^[A-Z]{2}\.[A-Z]{2}\.[A-Z][0-9][A-Z]{2,5}[0-9]{5}$/;

/**
 * Permissive *search* shape used by {@link normalizeRegNo}: the canonical
 * structure with a flexible separator where each canonical dot sits, and a
 * non-alphanumeric guard on both ends so a match can never start or stop in the
 * middle of a longer alphanumeric run (that would fabricate a number).
 *
 * The separator is optional on purpose: a Code39/Code128 payload may carry the
 * registration number without the printed dots (`BLENU4EAC24012`, seen on some
 * re-printed cards). Accepting it keeps one canonical spelling in the database
 * instead of two. The boundary guard is what makes that safe.
 *
 * Capture groups: 1 campus, 2 school, 3 letter+digit, 4 programme, 5 tail.
 */
const SEARCH_PATTERN =
  /(?:^|[^A-Z0-9])([A-Z]{2})[.\-_/\\ ]?([A-Z]{2})[.\-_/\\ ]?([A-Z][0-9])([A-Z]{2,5})([0-9]{5})(?![0-9A-Z])/;

/**
 * Whole-candidate shape used by {@link repairConfusables}. Same structure as
 * the canonical shape but separator-flexible and case-insensitive, because the
 * repair runs before case folding is meaningful to the caller.
 */
const CANDIDATE_PATTERN =
  /^[A-Za-z]{2}[.\-_/\\ ]?[A-Za-z]{2}[.\-_/\\ ]?[A-Za-z][0-9][A-Za-z]{2,5}[0-9]{5}$/;

/** Length of the numeric tail (admission year + roll number). */
const TAIL_LENGTH = 5;

/** Shortest leftover string worth recording from the fallback path. */
const MIN_FALLBACK_LENGTH = 4;

/* ================================================================== *
 * Character classes (index-loop friendly, so no regex backtracking)
 * ================================================================== */

const CODE_0 = 0x30;
const CODE_9 = 0x39;
const CODE_UPPER_A = 0x41;
const CODE_UPPER_Z = 0x5a;
const CODE_LOWER_A = 0x61;
const CODE_LOWER_Z = 0x7a;

const isDigitCode = (c) => c >= CODE_0 && c <= CODE_9;
const isLetterCode = (c) =>
  (c >= CODE_UPPER_A && c <= CODE_UPPER_Z) || (c >= CODE_LOWER_A && c <= CODE_LOWER_Z);
const isAlnumCode = (c) => isDigitCode(c) || isLetterCode(c);

/**
 * Padding a scanner or wrapper may add around a payload: C0 controls
 * (CR/LF, NUL, GS 0x1D, RS 0x1E, FS 0x1C, US 0x1F, tab), DEL, ASCII space and
 * the usual punctuation fringe, including the `*` that wraps Code39.
 */
const NOISE_TABLE = (() => {
  const table = new Uint8Array(128);
  for (let c = 0x00; c <= 0x20; c += 1) table[c] = 1;
  table[0x7f] = 1;
  for (const ch of '^~*#"\'`,;|') table[ch.charCodeAt(0)] = 1;
  return table;
})();

/** Characters that may legitimately stand where a canonical `.` sits. */
const SEPARATOR_TABLE = (() => {
  const table = new Uint8Array(128);
  for (const ch of '.-_/\\ ') table[ch.charCodeAt(0)] = 1;
  return table;
})();

const isNoiseCode = (c) => c < 128 && NOISE_TABLE[c] === 1;
const isSeparatorCode = (c) => c < 128 && SEPARATOR_TABLE[c] === 1;

/**
 * Strippable from the *ends* of a payload. Separators count as padding too:
 * `-BL.EN.U4EAC24012.` is a delimiter-fringed payload, and dropping the fringe
 * only ever tidies the fallback value — it cannot change a matched result,
 * because the search shape tolerates a leading separator anyway.
 */
const isPaddingCode = (c) => isNoiseCode(c) || isSeparatorCode(c);

/**
 * Digit/letter confusions a cheap CCD scanner, a thermal reprint or a human
 * typing the number off a card will actually produce. `D`->`0`, `Q`->`0`,
 * `L`->`1`, `B`->`8`, `Z`->`2` and `G`->`6` are included because inside a
 * known-numeric run there is no legal alternative reading of those glyphs.
 */
const CONFUSABLE_TO_DIGIT = new Map([
  ['O', '0'],
  ['Q', '0'],
  ['D', '0'],
  ['I', '1'],
  ['L', '1'],
  ['S', '5'],
  ['B', '8'],
  ['Z', '2'],
  ['G', '6'],
]);

const CONTROL_RE = /[\u0000-\u001F\u007F]/g;
const WHITESPACE_RUN_RE = /\s+/g;
const WHITESPACE_RE = /\s/g;
const HAS_DIGIT_RE = /[0-9]/;

/**
 * Characters that can never occur inside a registration number, and therefore
 * delimit the reg-shaped tokens of a longer record. Space is deliberately *not*
 * a separator here: it may legitimately stand in for a canonical dot.
 */
const NON_CANDIDATE_RE = /[^A-Z0-9.\-_/\\ ]+/;

/* ================================================================== *
 * Internals
 * ================================================================== */

/**
 * Upper-case the payload, turn control characters into spaces, fold whitespace
 * runs, then trim padding from both ends.
 *
 * A barcode field separator (GS 0x1D / RS 0x1E / CR / LF) becomes a space rather
 * than being spliced out: deleting it would glue neighbouring fields together and
 * change the digit run — `BL.EN.U4EAC24012<GS>2024` spliced becomes the
 * unmatchable `...240122024`, while as a space the number still parses.
 *
 * @param {unknown} raw
 * @returns {string} cleaned payload, or "" when there is nothing usable
 */
function cleanPayload(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return '';

  const upper = raw.toUpperCase();
  const folded = upper.replace(CONTROL_RE, ' ').replace(WHITESPACE_RUN_RE, ' ').trim();

  let start = 0;
  let end = folded.length;
  while (start < end && isPaddingCode(folded.charCodeAt(start))) start += 1;
  while (end > start && isPaddingCode(folded.charCodeAt(end - 1))) end -= 1;
  return folded.slice(start, end);
}

/**
 * First canonical-shape match in an already-cleaned string, re-emitted with
 * canonical dots.
 *
 * @param {string} s
 * @returns {string} canonical registration number, or "" when none is present
 */
function extractCanonical(s) {
  const match = SEARCH_PATTERN.exec(s);
  if (match === null) return '';
  return `${match[1]}.${match[2]}.${match[3]}${match[4]}${match[5]}`;
}

/**
 * End index of the trailing alphanumeric run of `s[start..end)`, or `start`
 * when there is none. Deliberately an index loop: `/([A-Za-z0-9]+)$/` retries
 * from every position and gives up one character at a time, which is quadratic
 * on long non-matching payloads.
 *
 * @param {string} s
 * @param {number} start
 * @param {number} end
 * @returns {number}
 */
function trailingAlnumStart(s, start, end) {
  let i = end;
  while (i > start && isAlnumCode(s.charCodeAt(i - 1))) i -= 1;
  return i;
}

/* ================================================================== *
 * Public API
 * ================================================================== */

/**
 * Full extraction cascade for one already-cleaned string: a plain structural
 * match, then the same match after a tail repair of the whole candidate, then
 * the same match after a tail repair of each reg-shaped token — a payload is
 * often a delimited record, so the number is rarely at the end of the string.
 *
 * @param {string} s
 * @returns {string} canonical registration number, or "" when none is present
 */
function extractAny(s) {
  const direct = extractCanonical(s);
  if (direct !== '') return direct;

  const repaired = repairConfusables(s);
  if (repaired !== s) {
    const fromRepaired = extractCanonical(repaired);
    if (fromRepaired !== '') return fromRepaired;
  }

  for (const token of s.split(NON_CANDIDATE_RE)) {
    if (token === s) continue;
    const fixed = repairConfusables(token);
    if (fixed === token) continue;
    const fromToken = extractCanonical(fixed);
    if (fromToken !== '') return fromToken;
  }

  return '';
}

/**
 * Extract + canonicalize a registration number from an arbitrary decoded payload.
 * Never throws. Returns "" for empty/unusable input.
 * @param {string} raw
 * @returns {string}
 */
export function normalizeRegNo(raw) {
  const cleaned = cleanPayload(raw);
  if (cleaned === '') return '';

  const found = extractAny(cleaned);
  if (found !== '') return found;

  // Whitespace inside a payload is a field separator, not content, so a number
  // split across it (`BL EN U4EAC24O I2`, doubled spaces) is still recoverable.
  // Running the *entire* cascade again on the compacted string is also what
  // makes the fallback below idempotent: a value that is itself extractable can
  // never be handed back as an unparsed fallback, so re-normalizing a stored
  // value is always a no-op.
  const compact = cleaned.replace(WHITESPACE_RE, '');
  if (compact !== cleaned) {
    const foundCompact = extractAny(compact);
    if (foundCompact !== '') return foundCompact;
  }

  // Unanticipated format: record the cleaned payload rather than dropping the
  // scan. Short leftovers are noise, not identifiers.
  return compact.length >= MIN_FALLBACK_LENGTH ? compact : '';
}

/**
 * True when the value matches the strict canonical registration-number shape.
 * @param {string} s
 * @returns {boolean}
 */
export function isValidRegNo(s) {
  return typeof s === 'string' && REGNO_PATTERN.test(s);
}

/**
 * Repair likely OCR/barcode character confusions, but ONLY inside the trailing
 * numeric run. Returns the input unchanged when it is not a plausible reg number.
 * @param {string} s
 * @returns {string}
 */
export function repairConfusables(s) {
  // Identity for anything that is not a string: this function never throws and
  // never invents a value.
  if (typeof s !== 'string' || s.length === 0) return s;

  // Surrounding padding is preserved verbatim; it only marks the candidate's
  // extent, so `*BL.EN.U4EAC24OI2*` still repairs.
  let start = 0;
  let end = s.length;
  while (start < end && isPaddingCode(s.charCodeAt(start))) start += 1;
  while (end > start && isPaddingCode(s.charCodeAt(end - 1))) end -= 1;
  if (start >= end) return s;

  // The tail must be the end of the trailing alphanumeric run, with at least
  // one character of prefix ahead of it. Otherwise the split is ambiguous.
  const runStart = trailingAlnumStart(s, start, end);
  if (end - runStart < TAIL_LENGTH + 1) return s;

  const tailStart = end - TAIL_LENGTH;
  const tail = s.slice(tailStart, end);

  // A tail without digits is programme code, not a numeric run: refuse.
  if (!HAS_DIGIT_RE.test(tail)) return s;

  let repairedTail = '';
  let changed = false;
  for (let i = 0; i < tail.length; i += 1) {
    const ch = tail[i];
    const upper = ch.toUpperCase();
    const digit = CONFUSABLE_TO_DIGIT.get(upper);
    if (digit === undefined) {
      repairedTail += ch;
    } else {
      repairedTail += digit;
      changed = true;
    }
  }
  if (!changed) return s;

  // The repair is only accepted if the whole candidate is still well formed.
  // This is the guard that rejects a "repair" that would eat programme letters
  // (e.g. `BL.EN.U4E24OI2` -> programme would shrink to a single letter).
  const candidate = s.slice(start, tailStart) + repairedTail;
  if (!CANDIDATE_PATTERN.test(candidate)) return s;

  return s.slice(0, start) + candidate + s.slice(end);
}
