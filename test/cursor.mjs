// Regression test for "cursor bounces around at high latency": sample the
// DISPLAYED cursor at 20ms intervals while typing through an Enter under
// 400ms simulated lag, and assert it never moves backward.
import { chromium } from 'playwright';

const URL = (process.env.URL || 'http://localhost:7861/') + '?lag=400';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 620 } });
await page.goto(URL);
await page.waitForFunction(() => typeof haveFull !== 'undefined' && haveFull, null, { timeout: 8000 });
await page.waitForTimeout(2500);

// warm the epoch so predictions display
await page.keyboard.type('x');
await page.waitForFunction(() => predict.confirmedEpoch >= 1, null, { timeout: 5000 });
await page.keyboard.press('Backspace');
await page.waitForTimeout(1200);

await page.evaluate(() => {
  window.__samples = [];
  window.__timer = setInterval(() => {
    const predCursor = predictActive() && predict.cursor;
    const dc = predCursor ? predict.cursor : { row: grid.curRow, col: grid.curCol };
    window.__samples.push({ r: dc.row, c: dc.col, t: performance.now() });
  }, 20);
});

await page.keyboard.type('echo one', { delay: 40 });
await page.keyboard.press('Enter');
await page.keyboard.type('echo two', { delay: 40 });
await page.waitForTimeout(2000);

const result = await page.evaluate(() => {
  clearInterval(window.__timer);
  const s = window.__samples;
  const regressions = [];
  for (let i = 1; i < s.length; i++) {
    const a = s[i - 1], b = s[i];
    // backward = row decreased, or same row and column decreased
    if (b.r < a.r || (b.r === a.r && b.c < a.c)) {
      regressions.push({ from: a, to: b });
    }
  }
  return { samples: s.length, regressions };
});

await browser.close();
console.log('samples:', result.samples, 'backward moves:', result.regressions.length);
if (result.regressions.length) console.log(JSON.stringify(result.regressions.slice(0, 5), null, 1));
console.log(result.regressions.length === 0 ? 'CURSOR PASS' : 'CURSOR FAIL');
process.exit(result.regressions.length === 0 ? 0 : 1);
