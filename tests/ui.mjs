/**
 * Headless UI test for the deployed attendance scanner.
 *
 * This drives the REAL page in Chrome — it is the only test that exercises the
 * controller, the period chips, the IN/OUT toggle and the view routing, none of
 * which the curl-based integration suite can reach. It uses the manual-entry
 * path, which funnels into exactly the same handleScanResult() code as a
 * successful barcode read, so the flow is covered without a camera or a card.
 *
 * Run:  node tests/ui.mjs [baseUrl]
 * Deps: puppeteer-core (installed outside the repo, see below)
 */

import { createRequire } from 'node:module';

const require = createRequire('/tmp/pptr/');
const puppeteer = require('puppeteer-core');

const BASE = process.argv[2] || 'https://scan.parswanadh.dev';
const CHROME = '/home/parshu/.cache/puppeteer/chrome/linux-154.0.8037.57/chrome-linux64/chrome';

let pass = 0;
let fail = 0;
const ok = (m) => { pass++; console.log(`  \x1b[32mPASS\x1b[0m ${m}`); };
const no = (m, d) => { fail++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); if (d) console.log(`       ${d}`); };
const eq = (m, a, b) => (String(a) === String(b) ? ok(m) : no(m, `expected [${b}] got [${a}]`));

// A registration number unique to this run so repeated runs never collide with
// an existing open session (the IN/OUT state machine is per student).
const REG = `BL.EN.U4EAC24${String(Math.floor(Math.random() * 900) + 100)}`;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'shell',
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    // A synthetic camera so scanner.start() can succeed without hardware.
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
  ],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true });

  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  console.log(`\nUI test against ${BASE}`);
  console.log('─'.repeat(58));
  console.log(`· load (card ${REG})`);

  await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise((r) => setTimeout(r, 1200));

  // ── the scanner is the landing view; there is no role picker ────────────
  eq('no role picker in the DOM', await page.$('#view-role'), null);
  eq('scanner view is the active one',
    await page.$eval('#view-scan', (n) => !n.hidden), true);
  eq('sheet button present', await page.$eval('#sheetLabel', (n) => n.textContent.trim()), 'Sheet');

  // ── camera actually opened (fake device) ────────────────────────────────
  const camPill = await page.$eval('#camLabel', (n) => n.textContent);
  ok(`camera reported: ${camPill.trim()}`);
  eq('a live video track is attached',
    await page.$eval('#video', (v) => Boolean(v.srcObject && v.srcObject.getVideoTracks().length)), true);

  // ── the hint escalates if nothing is read ───────────────────────────────
  console.log('· distance coaching');
  const hinted = await page.evaluate(async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 9000) {
      const s = document.getElementById('scanStatus').textContent;
      if (/move closer/i.test(s)) return s;
      await new Promise((r) => setTimeout(r, 250));
    }
    return null;
  });
  hinted ? ok(`hint appeared: "${hinted}"`) : no('"Move closer" hint never appeared within 9s');

  // ── manual entry feeds the same path as a scan ──────────────────────────
  console.log('· scan -> confirm');
  await page.click('#btnManual');
  await page.waitForSelector('#manualForm:not([hidden])');
  await page.type('#manualInput', REG.toLowerCase()); // lowercase on purpose
  await page.click('#manualForm button[type=submit]');
  await page.waitForFunction(() => !document.getElementById('view-confirm').hidden, { timeout: 8000 });

  eq('registration normalized to uppercase',
    await page.$eval('#confirmRegNo', (n) => n.value), REG);

  // ── the status banner came from the server ──────────────────────────────
  console.log('· server status drives the toggle');
  await page.waitForFunction(
    () => !/checking/i.test(document.getElementById('statusTitle').textContent),
    { timeout: 8000 },
  );
  eq('fresh card reads as first scan',
    await page.$eval('#statusTitle', (n) => n.textContent), 'First scan for this event');
  eq('IN is armed', await page.$eval('[data-dir="in"]', (n) => n.classList.contains('is-active')), true);
  eq('OUT is disabled before any IN',
    await page.$eval('[data-dir="out"]', (n) => n.disabled), true);

  // ── period chips ────────────────────────────────────────────────────────
  console.log('· period selection');
  eq('eight period chips built', await page.$$eval('.period', (n) => n.length), 8);
  eq('nothing preselected', await page.$$eval('.period.is-active', (n) => n.length), 0);
  eq('hours start at zero', await page.$eval('#hoursOut', (n) => n.textContent), '0 hours');

  await page.click('.period[data-period="1"]');
  await page.click('.period[data-period="2"]');
  await page.click('.period[data-period="5"]');
  eq('three chips active', await page.$$eval('.period.is-active', (n) => n.length), 3);
  eq('hours follow the count', await page.$eval('#hoursOut', (n) => n.textContent), '3 hours');
  eq('non-contiguous selection labelled correctly',
    await page.$eval('#periodHint', (n) => n.textContent.includes('P1–P2, P5')), true);

  await page.click('.period[data-period="2"]'); // toggle one back off
  eq('toggle off works', await page.$$eval('.period.is-active', (n) => n.length), 2);

  // ── record the IN ───────────────────────────────────────────────────────
  console.log('· record IN');
  eq('submit button names the direction',
    await page.$eval('#btnSubmit', (n) => n.textContent.trim()), 'Record IN');
  await page.click('#btnSubmit');
  await page.waitForFunction(() => !document.getElementById('view-done').hidden, { timeout: 10000 });
  eq('result says Marked IN', await page.$eval('#resultTitle', (n) => n.textContent), 'Marked IN');
  const facts = await page.$$eval('#resultFacts dt, #resultFacts dd', (n) => n.map((x) => x.textContent));
  eq('result shows the periods', facts.includes('P1, P5'), true);
  eq('result shows 2 hours', facts.includes('2'), true);

  // ── rescan: must now offer OUT, and refuse it as too soon ───────────────
  console.log('· rescan offers OUT');
  await page.click('#btnScanNext');
  await page.waitForFunction(() => !document.getElementById('view-scan').hidden, { timeout: 8000 });
  await page.click('#btnManual');
  await page.type('#manualInput', REG);
  await page.click('#manualForm button[type=submit]');
  await page.waitForFunction(() => !document.getElementById('view-confirm').hidden, { timeout: 8000 });
  await page.waitForFunction(
    () => !/checking/i.test(document.getElementById('statusTitle').textContent),
    { timeout: 8000 },
  );

  const title = await page.$eval('#statusTitle', (n) => n.textContent);
  /only 0 min ago/i.test(title) ? ok(`status warns it is too soon: "${title}"`)
                                : no('status did not warn about the 40-minute rule', title);
  eq('OUT is now armed',
    await page.$eval('[data-dir="out"]', (n) => n.classList.contains('is-active')), true);
  eq('IN is now disabled',
    await page.$eval('[data-dir="in"]', (n) => n.disabled), true);

  console.log('· the 40-minute rule is enforced, then overridable');
  await page.click('#btnSubmit');
  await page.waitForFunction(
    () => !document.getElementById('confirmError').hidden, { timeout: 10000 },
  );
  const err = await page.$eval('#confirmError', (n) => n.textContent);
  /too soon/i.test(err) ? ok(`server refused: "${err.slice(0, 72)}…"`) : no('no too-soon error shown', err);
  eq('button offers the deliberate override',
    await page.$eval('#btnSubmit', (n) => n.textContent.trim()), 'Record OUT anyway');

  await page.click('#btnSubmit');
  await page.waitForFunction(() => !document.getElementById('view-done').hidden, { timeout: 10000 });
  eq('result says Marked OUT', await page.$eval('#resultTitle', (n) => n.textContent), 'Marked OUT');

  // ── the sheet stays PIN-gated ───────────────────────────────────────────
  console.log('· sheet is still gated');
  await page.click('#sheetBtn');
  await page.waitForFunction(() => !document.getElementById('view-pin').hidden, { timeout: 5000 });
  eq('PIN field advertises six digits',
    await page.$eval('#pinInput', (n) => n.placeholder.length), 6);
  eq('PIN maxlength matches',
    await page.$eval('#pinInput', (n) => n.maxLength), 6);
  ok('sheet asked for the PIN without a token');

  // ── no JS errors anywhere in that journey ───────────────────────────────
  console.log('· console hygiene');
  const real = pageErrors.filter((e) => !/favicon/i.test(e));
  eq('no uncaught page errors', real.length, 0);
  if (real.length) real.forEach((e) => console.log(`       ${e}`));
  // Chrome logs every non-2xx fetch as a console error, and this test
  // deliberately provokes a 409 from the 40-minute rule. Filter that out —
  // what matters is that nothing *unexpected* was logged.
  const noisy = consoleErrors.filter(
    (e) => !/favicon|NotFoundError|NotFoundException|status of 409/i.test(e),
  );
  eq('no unexpected console errors', noisy.length, 0);
  if (noisy.length) noisy.slice(0, 5).forEach((e) => console.log(`       ${e}`));
} finally {
  await browser.close();
}

console.log('─'.repeat(58));
console.log(`Result: \x1b[32m${pass} passed\x1b[0m, ${fail ? `\x1b[31m${fail} failed\x1b[0m` : '0 failed'}\n`);
process.exit(fail ? 1 : 0);
