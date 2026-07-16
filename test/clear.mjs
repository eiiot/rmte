import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 620 } });
await page.goto('http://localhost:7861/?lag=400');
await page.waitForFunction(() => typeof haveFull !== 'undefined' && haveFull);
await page.waitForTimeout(2500);
// fill the screen first so "cleared" is detectable
await page.keyboard.type('seq 100');
await page.keyboard.press('Enter');
await page.waitForTimeout(1500);

const filled = await page.evaluate(() => {
  let nonEmpty = 0;
  for (let r = 0; r < grid.rows - 1; r++) {
    for (let c = 0; c < grid.cols; c++) if (grid.cp[r * grid.cols + c] !== 32) { nonEmpty++; break; }
  }
  return nonEmpty;
});

await page.evaluate(() => {
  window.__clearAt = null; window.__ghostGoneAt = null;
  window.__watch = setInterval(() => {
    let nonEmpty = 0;
    for (let r = 0; r < grid.rows - 1; r++) {
      for (let c = 0; c < grid.cols; c++) if (grid.cp[r * grid.cols + c] !== 32) { nonEmpty++; break; }
    }
    if (nonEmpty <= 2 && window.__clearAt == null) window.__clearAt = performance.now();
    if (window.__clearAt != null && window.__ghostGoneAt == null && predictPendingCount() === 0) {
      window.__ghostGoneAt = performance.now();
    }
  }, 10);
});
await page.keyboard.type('clear');
await page.keyboard.press('Enter');
await page.waitForTimeout(2500);
const r = await page.evaluate(() => {
  clearInterval(window.__watch);
  return { clearSeen: window.__clearAt != null, ghostMs: window.__ghostGoneAt != null ? Math.round(window.__ghostGoneAt - window.__clearAt) : null };
});
await browser.close();
console.log('filled rows before clear:', filled);
console.log('clear frame seen:', r.clearSeen, '| overlay ghosts survived past clear:', r.ghostMs, 'ms');
const pass = r.clearSeen && r.ghostMs != null && r.ghostMs <= 60;
console.log(pass ? 'CLEAR PASS' : 'CLEAR FAIL');
process.exit(pass ? 0 : 1);
