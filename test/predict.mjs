// Prediction engine test (mosh row-overlay port), run in a real browser with
// ?lag=300. Checks: (1) first char is tracked and displayed immediately,
// marked unconfirmed; (2) after the epoch confirms, subsequent keystrokes
// display instantly; (3) backspace predicts the shift-left erase and steps
// the cursor back; (4) everything reconciles to empty against server truth.
import { chromium } from 'playwright';

const URL = (process.env.URL || 'http://localhost:7861/') + '?lag=300';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 620 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

await page.goto(URL);
await page.waitForFunction(() => typeof haveFull !== 'undefined' && haveFull, null, { timeout: 8000 });
await page.waitForTimeout(2500); // let pings land so srtt (incl. sim lag) is known

const pre = await page.evaluate(() => ({
  active: predictActive(), srtt: predict.srtt, mode: predict.mode,
}));

// (1) first char: tracked, displayed immediately, unconfirmed
await page.keyboard.type('e');
const t0 = await page.evaluate(() => {
  let typed = null;
  for (const row of predict.overlays.values()) {
    for (const c of row) if (c.active && !c.unknown && c.cp === 101) typed = c;
  }
  return {
    tracked: !!typed,
    shown: !!typed && typed.tue <= predict.confirmedEpoch + 1,
    unconfirmed: !!typed && typed.tue > predict.confirmedEpoch,
  };
});

await page.waitForFunction(() => predict.confirmedEpoch >= 1, null, { timeout: 5000 });

// (2) post-confirmation typing displays instantly
await page.keyboard.type('cho predicted');
const t1 = await page.evaluate(() => {
  let active = 0, visible = 0;
  for (const row of predict.overlays.values()) {
    for (const c of row) {
      if (!c.active) continue;
      active += 1;
      if (!c.unknown && c.tue <= predict.confirmedEpoch + 1) visible += 1;
    }
  }
  const dc = displayedCursor();
  const drow = predict.overlays.get(dc.row);
  const lastChar = drow && drow[dc.col - 1];
  return {
    active, visible,
    cursorAhead: !!lastChar && lastChar.active && lastChar.cp === 100, // 'd'
  };
});

await page.waitForFunction(() => predictPendingCount() === 0, null, { timeout: 5000 });

// (3) backspace: shift-left erase predicted, cursor steps back instantly
const beforeCol = await page.evaluate(() => displayedCursor().col);
await page.keyboard.press('Backspace');
const bs = await page.evaluate((beforeCol) => {
  const dc = displayedCursor();
  const row = predict.overlays.get(dc.row);
  const cell = row && row[dc.col];
  return {
    cursorSteppedBack: dc.col === beforeCol - 1,
    erasePredicted: !!cell && cell.active && cell.cp === 32,
  };
}, beforeCol);
await page.waitForFunction(() => predictPendingCount() === 0, null, { timeout: 5000 });
await page.keyboard.type('d'); // restore deleted char
await page.waitForFunction(() => predictPendingCount() === 0, null, { timeout: 5000 });

// (4) run the command; everything reconciles
await page.keyboard.press('Enter');
await page.waitForTimeout(1500);
const final = await page.evaluate(() => {
  let text = '';
  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++) text += String.fromCodePoint(grid.cp[r * grid.cols + c] || 32);
    text += '\n';
  }
  return {
    hasOutput: text.includes('predicted'),
    pending: predictPendingCount(),
    cursorReleased: predict.cursors.length === 0,
  };
});

await browser.close();

console.log('srtt(sim):', Math.round(pre.srtt), 'active:', pre.active, 'mode:', pre.mode);
console.log('first char: tracked:', t0.tracked, 'shown:', t0.shown, 'unconfirmed:', t0.unconfirmed);
console.log('after confirm: active', t1.active, 'visible:', t1.visible, 'cursor ahead:', t1.cursorAhead);
console.log('backspace: erase predicted:', bs.erasePredicted, 'cursor stepped back:', bs.cursorSteppedBack);
console.log('final: echoed:', final.hasOutput, 'pending:', final.pending, 'cursor released:', final.cursorReleased);
console.log('errors:', errors.length ? errors : 'none');

const pass = pre.active && t0.tracked && t0.shown && t0.unconfirmed &&
             t1.visible > 0 && t1.cursorAhead && bs.erasePredicted && bs.cursorSteppedBack &&
             final.hasOutput && final.pending === 0 && final.cursorReleased && !errors.length;
console.log(pass ? 'PREDICT PASS' : 'PREDICT FAIL');
process.exit(pass ? 0 : 1);
