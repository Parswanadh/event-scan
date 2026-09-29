/**
 * regno.test.js — unit tests for public/js/regno.js
 *
 * Run with:  node --test tests/regno.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import * as regno from '../public/js/regno.js';
import { normalizeRegNo, isValidRegNo, REGNO_PATTERN, repairConfusables } from '../public/js/regno.js';

const CANONICAL = 'BL.EN.U4EAC24012';

/** Safe label for assertion messages: Symbol/String edge cases must not throw. */
function label(value) {
  try {
    return `${typeof value}:${String(value)}`;
  } catch {
    return typeof value;
  }
}


/** Every payload that should normalize to the canonical value. */
const ACCEPTED_SAMPLES = [
  CANONICAL,
  'bl.en.u4eac24012',
  '  BL.EN.U4EAC24012  ',
  'BL.EN.U4EAC24012\r\n',
  '\tBL.EN.U4EAC24012\t',
  '\r\n  bl.en.u4eac24012  \r\n',
  '\u0000BL.EN.U4EAC24012\u0000',
  'BL.EN.U4EAC24012\u001d', // GS
  'BL.EN.U4EAC24012\u001e', // RS
  'BL.EN.U4EAC24012\u001c', // FS
  'BL.EN.U4EAC24012\u001f', // US
  '\u001dBL.EN.U4EAC24012\u001d',
  'BL\tEN\tU4EAC24012',
  'BL\u0000EN\u0000U4EAC24012',
  '\uFEFFBL.EN.U4EAC24012', // UTF-8 BOM survived into the payload
  '*BL.EN.U4EAC24012*',
  '*bl.en.u4eac24012*\r\n',
  'bl-en-u4eac24012',
  'BL EN U4EAC24012',
  'BL/EN/U4EAC24012',
  'BL_EN_U4EAC24012',
  'BL\\EN\\U4EAC24012',
  'BLENU4EAC24012',
  'bl en u4eac24012',
  '1|BL.EN.U4EAC24012|2024-2028|AMRITA',
  'ROLL:BL.EN.U4EAC24012;YEAR:2024',
  '{"reg":"BL.EN.U4EAC24012","year":2024}',
  'BL.EN.U4EAC24012 AMRITA',
  '1|BL.EN.U4EAC24012|BL.EN.U4EAC24013',
  'BL  EN  U4EAC24012', // doubled spaces still fold to a single separator
  'BL EN U4EAC24O I2', // number split across whitespace with a confused tail
  '^^^BL.EN.U4EAC24012~~~',
  "'BL.EN.U4EAC24012'",
  '#BL.EN.U4EAC24012#;',
  '`BL.EN.U4EAC24012`',
  ',BL.EN.U4EAC24012,',
  '|BL.EN.U4EAC24012|',
  '.BL.EN.U4EAC24012.',
  '^bl.en.u4eac24012~\r\n',
  'BL.EN.U4EAC24OI2', // confused digit run, repaired
  'bl.en.u4eac24oi2',
  'BL-EN-U4EAC24OI2',
  '1|BL.EN.U4EAC24OI2|2024-2028|AMRITA',
];

/**
 * Other *valid* registration numbers: they must survive normalization verbatim
 * (their programme code is a different length), not collapse to CANONICAL.
 */
const ALT_VALID_SAMPLES = [
  'BL.EN.U4CS24012', // 2-letter programme code
  'BL.EN.U4EACSE24012', // 5-letter programme code
  'BL.EN.U4ISO24012', // programme code made of confusable-looking letters
];

/**
 * Payloads that are not registration numbers. They must still be *recorded*
 * (cleaned up) rather than dropped, except when nothing meaningful is left.
 */
const FALLBACK_SAMPLES = [
  ['AMRITA/2024/XYZ', 'AMRITA/2024/XYZ'],
  ['BL.EN.U4EAC2401', 'BL.EN.U4EAC2401'], // truncated tail
  ['BL.EN.U4EAC240123', 'BL.EN.U4EAC240123'], // over-long tail
  ['BL.EN.U4EAC24012X', 'BL.EN.U4EAC24012X'], // trailing junk character
  ['roll no 42', 'ROLLNO42'],
];

test('module exports exactly the four documented names', () => {
  assert.deepEqual(Object.keys(regno).sort(), [
    'REGNO_PATTERN',
    'isValidRegNo',
    'normalizeRegNo',
    'repairConfusables',
  ]);
  assert.equal(typeof normalizeRegNo, 'function');
  assert.equal(typeof isValidRegNo, 'function');
  assert.equal(typeof repairConfusables, 'function');
  assert.ok(REGNO_PATTERN instanceof RegExp);
});

test('exact canonical input is returned unchanged', () => {
  assert.equal(normalizeRegNo(CANONICAL), CANONICAL);
  assert.equal(normalizeRegNo('BL.EN.U4CS24012'), 'BL.EN.U4CS24012');
  assert.equal(normalizeRegNo('BL.EN.U4EACSE24012'), 'BL.EN.U4EACSE24012');
});

test('lowercase input is uppercased', () => {
  assert.equal(normalizeRegNo('bl.en.u4eac24012'), CANONICAL);
  assert.equal(normalizeRegNo('Bl.En.U4Eac24012'), CANONICAL);
  assert.equal(normalizeRegNo('*bl.en.u4eac24012*'), CANONICAL);
});

test('surrounding whitespace, CRLF, tabs and NUL/GS control characters are stripped', () => {
  assert.equal(normalizeRegNo('  BL.EN.U4EAC24012  '), CANONICAL);
  assert.equal(normalizeRegNo('\r\nBL.EN.U4EAC24012\r\n'), CANONICAL);
  assert.equal(normalizeRegNo('\t\tBL.EN.U4EAC24012\t'), CANONICAL);
  assert.equal(normalizeRegNo('\u0000BL.EN.U4EAC24012\u0000'), CANONICAL);
  assert.equal(normalizeRegNo('\u001dBL.EN.U4EAC24012\u001e'), CANONICAL); // GS / RS
  assert.equal(normalizeRegNo('\u007fBL.EN.U4EAC24012\u007f'), CANONICAL); // DEL
  assert.equal(normalizeRegNo('BL.EN.U4EAC24012\u001d'), CANONICAL);
  assert.equal(normalizeRegNo('\uFEFFBL.EN.U4EAC24012'), CANONICAL); // BOM
  // Controls *inside* the payload act as field separators, never as glue.
  assert.equal(normalizeRegNo('BL\u0000EN\u0000U4EAC24012'), CANONICAL);
  assert.equal(normalizeRegNo('BL\tEN\tU4EAC24012'), CANONICAL);
  assert.equal(normalizeRegNo('BL\u0000.EN\u0000.U4EAC24012'), CANONICAL);
});

test('Code39 asterisk wrapping is stripped', () => {
  assert.equal(normalizeRegNo('*BL.EN.U4EAC24012*'), CANONICAL);
  assert.equal(normalizeRegNo('*BL.EN.U4EAC24012*\r\n'), CANONICAL);
  assert.equal(normalizeRegNo('*bl.en.u4eac24012*'), CANONICAL);
});

test('delimiter variants all canonicalize to dots', () => {
  assert.equal(normalizeRegNo('bl-en-u4eac24012'), CANONICAL);
  assert.equal(normalizeRegNo('BL EN U4EAC24012'), CANONICAL);
  assert.equal(normalizeRegNo('BL/EN/U4EAC24012'), CANONICAL);
  assert.equal(normalizeRegNo('BL_EN_U4EAC24012'), CANONICAL);
  assert.equal(normalizeRegNo('BL\\EN\\U4EAC24012'), CANONICAL);
  // Deliberate interpretation: separators may be absent entirely (a re-printed
  // card whose barcode drops the dots); boundary guards keep this safe.
  assert.equal(normalizeRegNo('BLENU4EAC24012'), CANONICAL);
  assert.equal(normalizeRegNo('BLENU4EAC24012'), CANONICAL);
});

test('registration number embedded in a longer delimited payload', () => {
  assert.equal(normalizeRegNo('1|BL.EN.U4EAC24012|2024-2028|AMRITA'), CANONICAL);
  assert.equal(normalizeRegNo('ROLL:BL.EN.U4EAC24012;YEAR:2024'), CANONICAL);
  assert.equal(normalizeRegNo('{"reg":"BL.EN.U4EAC24012","year":2024}'), CANONICAL);
  assert.equal(normalizeRegNo('BL.EN.U4EAC24012 AMRITA'), CANONICAL);
  // First match wins when a payload somehow carries two numbers.
  assert.equal(normalizeRegNo('1|BL.EN.U4EAC24012|BL.EN.U4EAC24013'), CANONICAL);
  // A number glued to other alphanumerics is *not* extracted (never invent).
  assert.equal(normalizeRegNo('ROLLNOBL.EN.U4EAC24012'), 'ROLLNOBL.EN.U4EAC24012');
});

test('noisy prefix/suffix punctuation is stripped', () => {
  assert.equal(normalizeRegNo('^^^BL.EN.U4EAC24012~~~'), CANONICAL);
  assert.equal(normalizeRegNo('^bl.en.u4eac24012~\r\n'), CANONICAL);
  assert.equal(normalizeRegNo("'BL.EN.U4EAC24012'"), CANONICAL);
  assert.equal(normalizeRegNo('"BL.EN.U4EAC24012"'), CANONICAL);
  assert.equal(normalizeRegNo('`BL.EN.U4EAC24012`'), CANONICAL);
  assert.equal(normalizeRegNo(',BL.EN.U4EAC24012,'), CANONICAL);
  assert.equal(normalizeRegNo(';BL.EN.U4EAC24012;'), CANONICAL);
  assert.equal(normalizeRegNo('|BL.EN.U4EAC24012|'), CANONICAL);
  assert.equal(normalizeRegNo('#BL.EN.U4EAC24012#'), CANONICAL);
  assert.equal(normalizeRegNo('*^~BL.EN.U4EAC24012~^*'), CANONICAL);
  assert.equal(normalizeRegNo('.BL.EN.U4EAC24012.'), CANONICAL);
});

test('every accepted sample normalizes to the canonical value', () => {
  for (const sample of ACCEPTED_SAMPLES) {
    assert.equal(normalizeRegNo(sample), CANONICAL, `sample: ${JSON.stringify(sample)}`);
  }
});

test('empty, whitespace-only and non-string input returns ""', () => {
  for (const input of ['', '   ', '\t\r\n', '\u0000\u001d', null, undefined, 42, 0, NaN, {}, [], true, false, () => {}]) {
    assert.equal(normalizeRegNo(input), '', `input: ${label(input)}`);
  }
  assert.equal(normalizeRegNo(), '');
  // Deliberate interpretation: a boxed String is an object, so it is "not a
  // string" per the frozen contract and yields "".
  assert.equal(normalizeRegNo(new String(CANONICAL)), '');
  // A value that is obviously not an ID is dropped rather than recorded.
  assert.equal(normalizeRegNo('ab'), '');
  assert.equal(normalizeRegNo('^^^'), '');
  assert.equal(normalizeRegNo('12'), '');
});

test('normalizeRegNo never throws and always returns a string', () => {
  const hostile = [
    null,
    undefined,
    0,
    -1,
    NaN,
    Infinity,
    Symbol('reg'),
    10n,
    {},
    { toString() { throw new Error('boom'); } },
    [],
    [CANONICAL],
    new Map(),
    new Uint8Array(8),
    () => {},
    '\uD800', // lone surrogate
    '\uDC00\uD800',
    'ß'.repeat(1000),
    '💥'.repeat(100),
  ];
  for (const input of hostile) {
    let out;
    assert.doesNotThrow(() => {
      out = normalizeRegNo(input);
    }, `threw for ${label(input)}`);
    assert.equal(typeof out, 'string');
  }
});

test('unanticipated-but-plausible formats are recorded, not dropped', () => {
  for (const [input, expected] of FALLBACK_SAMPLES) {
    assert.equal(normalizeRegNo(input), expected, `input: ${JSON.stringify(input)}`);
  }
  // The fallback keeps the payload verbatim apart from cleanup.
  assert.equal(normalizeRegNo('  amrita/2024/xyz  '), 'AMRITA/2024/XYZ');
  assert.equal(normalizeRegNo('roll no 42'), 'ROLLNO42');
});

test('100000-character inputs finish quickly and return a string', () => {
  const longInputs = [
    'A'.repeat(100000),                                   // single huge alphanumeric run
    'A'.repeat(99999) + '-',                              // ditto, non-matching tail
    ' ^'.repeat(50000),                                   // huge padding run
    '\u0000'.repeat(100000),                              // all controls
    '|'.repeat(100000 - CANONICAL.length) + CANONICAL,    // huge padding then the number
    'X'.repeat(50000) + '|' + CANONICAL + '|' + 'Y'.repeat(49982),
    'AB|'.repeat(33334).slice(0, 100000),                 // many tiny delimiter-separated tokens
    'A'.repeat(99995) + '2401O',                          // confused tail at the very end
  ];

  for (const long of longInputs) {
    assert.equal(long.length, 100000);
    const started = performance.now();
    const out = normalizeRegNo(long);
    const elapsed = performance.now() - started;
    assert.equal(typeof out, 'string');
    assert.ok(
      elapsed < 1000,
      `took ${elapsed.toFixed(1)}ms for a 100000-char input (${JSON.stringify(long.slice(0, 12))}...)`,
    );
  }

  // The number is still found when it is buried in 100k of noise.
  assert.equal(normalizeRegNo('|'.repeat(99999) + CANONICAL), CANONICAL);
  assert.equal(
    normalizeRegNo('X'.repeat(50000) + '|' + CANONICAL + '|' + 'Y'.repeat(49990)),
    CANONICAL,
  );
  // All-noise input has nothing left to record.
  assert.equal(normalizeRegNo(' ^'.repeat(50000)), '');
  assert.equal(normalizeRegNo('\u0000'.repeat(100000)), '');
});

test('isValidRegNo accepts only the strict canonical shape', () => {
  assert.equal(isValidRegNo(CANONICAL), true);
  assert.equal(isValidRegNo('BL.EN.U4CS24012'), true);
  assert.equal(isValidRegNo('BL.EN.U4EACSE24012'), true);

  assert.equal(isValidRegNo(''), false);
  assert.equal(isValidRegNo('BL.EN.U4EAC2401'), false); // partial tail
  assert.equal(isValidRegNo('BL.EN.U4EAC240'), false); // shorter partial tail
  assert.equal(isValidRegNo('BL.EN.U4EAC240123'), false); // over-long tail
  assert.equal(isValidRegNo('bl.en.u4eac24012'), false); // case matters here
  assert.equal(isValidRegNo(`${CANONICAL} `), false);
  assert.equal(isValidRegNo(` ${CANONICAL}`), false);
  assert.equal(isValidRegNo('BL-EN-U4EAC24012'), false); // separators are canonicalized by normalize
  assert.equal(isValidRegNo('BL.EN.U4ABCDEF24012'), false); // 6-letter programme code
  assert.equal(isValidRegNo('BL.EN.U4EAC24OI2'), false); // unrepaired confusion
  for (const input of [null, undefined, 42, {}, []]) {
    assert.equal(isValidRegNo(input), false, `input: ${String(input)}`);
  }
});

test('isValidRegNo agrees with normalizeRegNo on every accepted sample', () => {
  for (const sample of [...ACCEPTED_SAMPLES, ...ALT_VALID_SAMPLES]) {
    const normalized = normalizeRegNo(sample);
    assert.equal(isValidRegNo(normalized), true, `sample: ${JSON.stringify(sample)}`);
  }
});

test('repairConfusables fixes a digit-run confusion but never the alphabetic prefix', () => {
  assert.equal(repairConfusables('BL.EN.U4EAC24OI2'), CANONICAL);
  assert.equal(repairConfusables('BL.EN.U4EAC24OIZ'), CANONICAL);
  assert.equal(repairConfusables('BL.EN.U4EAC2S0I2'), 'BL.EN.U4EAC25012');
  assert.equal(repairConfusables('BL.EN.U4EAC2D0I2'), 'BL.EN.U4EAC20012');
  assert.equal(repairConfusables('BL.EN.U4EAC2Z0G2'), 'BL.EN.U4EAC22062');
  // The prefix keeps even its most confusable-looking letters (ISO: I, S, O).
  assert.equal(repairConfusables('BL.EN.U4ISO24OI2'), 'BL.EN.U4ISO24012');
  assert.equal(repairConfusables('bl.en.u4iso24oi2'), 'bl.en.u4iso24012');
  // A confused tail behind a delimiter still repairs.
  assert.equal(repairConfusables('BL-EN-U4EAC24OI2'), 'BL-EN-U4EAC24012');
  assert.equal(repairConfusables('*BL.EN.U4EAC24OI2*'), `*${CANONICAL}*`);
  assert.equal(repairConfusables('BL EN U4EAC24OI2'), 'BL EN U4EAC24012');
  // Repair output is canonical-shaped, so normalizeRegNo can finish the job.
  assert.equal(isValidRegNo(repairConfusables('BL.EN.U4EAC24OI2')), true);
});

test('repairConfusables refuses to touch ambiguous or malformed input', () => {
  // Already valid: byte-for-byte identity, no gratuitous rewriting.
  assert.equal(repairConfusables(CANONICAL), CANONICAL);
  assert.equal(repairConfusables('BL.EN.U4ISO24012'), 'BL.EN.U4ISO24012');
  // All-letter tails are programme code, not digits.
  assert.equal(repairConfusables('BL.EN.U4EACOILZS'), 'BL.EN.U4EACOILZS');
  assert.equal(repairConfusables('BL.EN.U4EIS'), 'BL.EN.U4EIS');
  // Repairing would leave fewer than 2 programme letters: refuse.
  assert.equal(repairConfusables('BL.EN.U4E24OI2'), 'BL.EN.U4E24OI2');
  // Not enough characters to place a 5-digit tail.
  assert.equal(repairConfusables('BL.EN.U4EAC24OI'), 'BL.EN.U4EAC24OI');
  assert.equal(repairConfusables('24OI2'), '24OI2');
  // Not a candidate at all.
  assert.equal(repairConfusables('hello world'), 'hello world');
  assert.equal(repairConfusables(''), '');
  assert.equal(repairConfusables('   '), '   ');
  // Identity for non-strings; never throws.
  for (const input of [null, undefined, 42, {}, []]) {
    assert.equal(repairConfusables(input), input);
  }
});

test('REGNO_PATTERN is non-global and stateless across repeated .test() calls', () => {
  assert.equal(REGNO_PATTERN.global, false);
  assert.equal(REGNO_PATTERN.flags, '');
  assert.equal(REGNO_PATTERN.lastIndex, 0);

  assert.equal(REGNO_PATTERN.test(CANONICAL), true);
  assert.equal(REGNO_PATTERN.test(CANONICAL), true);
  assert.equal(REGNO_PATTERN.test('nope'), false);
  assert.equal(REGNO_PATTERN.test(CANONICAL), true);
  assert.equal(REGNO_PATTERN.lastIndex, 0);

  assert.equal(isValidRegNo(CANONICAL), true);
  assert.equal(isValidRegNo(CANONICAL), true);
});

test('normalizeRegNo is idempotent for every sample', () => {
  const inputs = [
    ...ACCEPTED_SAMPLES,
    ...ALT_VALID_SAMPLES,
    ...FALLBACK_SAMPLES.map(([input]) => input),
    '',
    '   ',
    'ab',
    '^^^',
    'roll no 42',
    '  amrita/2024/xyz  ',
    'zz',
  ];
  for (const input of inputs) {
    const once = normalizeRegNo(input);
    const twice = normalizeRegNo(once);
    assert.equal(twice, once, `not idempotent for ${JSON.stringify(input)} -> ${JSON.stringify(once)}`);
  }
});
