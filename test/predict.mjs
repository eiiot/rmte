// Prediction engine test (mosh port), run in a real browser with ?lag=300.
// Checks: (1) epoch warm-up: first char is tracked but hidden until confirmed;
// (2) once the epoch is confirmed, subsequent keystrokes display instantly
// (long before the server round-trip); (3) predictions reconcile to empty and
// the grid matches what was typed.
import { chromium } from 'playwright';

const URL = (process.env.URL || 'http://localhost:7861/') + '?lag=300';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 620 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

await page.goto(URL);
await page.waitForFunction(() => typeof haveFull !== 'undefined' && haveFull, null, { timeout: 8000 });
await page.waitForTimeout(2500); // let a ping land so srtt (incl. sim lag) is known

const pre = await page.evaluate(() => ({
  active: predictActive(), srtt: predict.srtt, mode: predict.mode,
}));

// first char: tracked, displayed immediately (one epoch of grace), but
// marked unconfirmed (underline) until the round-trip lands
await page.keyboard.type('e');
const t0 = await page.evaluate(() => ({
  cells: predict.cells.length,
  shown: predict.cells.every((p) => p.epoch <= predict.confirmedEpoch + 1),
  unconfirmed: predict.cells.every((p) => p.epoch > predict.confirmedEpoch),
}));

// wait for the round-trip to confirm the epoch
await page.waitForFunction(() => predict.confirmedEpoch >= 1, null, { timeout: 5000 });

// now type more: these must display instantly (visible = epoch confirmed)
await page.keyboard.type('cho predicted');
const t1 = await page.evaluate(() => ({
  cells: predict.cells.length,
  visible: predict.cells.filter((p) => p.epoch <= predict.confirmedEpoch).length,
  cursorAhead: !!predict.cursor && predict.cursor.col === predict.cells[predict.cells.length - 1].col + 1,
}));

// let everything confirm, then test backspace: it must predict the erase
// (blank cell one column left) instead of doing nothing for a round-trip
await page.waitForFunction(() => predict.cells.length === 0, null, { timeout: 5000 });
await page.keyboard.press('Backspace');
const bs = await page.evaluate(() => ({
  erasePredicted: predict.cells.length === 1 && predict.cells[0].cp === 32,
  cursorSteppedBack: !!predict.cursor && predict.cursor.col === predict.cells[0].col,
}));
await page.waitForFunction(() => predict.cells.length === 0, null, { timeout: 5000 });
await page.keyboard.type('d'); // restore the char we deleted
await page.waitForFunction(() => predict.cells.length === 0, null, { timeout: 5000 });
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
    pending: predict.cells.length,
    cursorReleased: predict.cursor === null,
  };
});

await browser.close();

console.log('srtt(sim):', Math.round(pre.srtt), 'active:', pre.active, 'mode:', pre.mode);
console.log('first char: tracked', t0.cells, 'shown:', t0.shown, 'unconfirmed:', t0.unconfirmed);
console.log('after confirm: tracked', t1.cells, 'instantly visible:', t1.visible, 'cursor ahead:', t1.cursorAhead);
console.log('backspace: erase predicted:', bs.erasePredicted, 'cursor stepped back:', bs.cursorSteppedBack);
console.log('final: echoed:', final.hasOutput, 'pending:', final.pending, 'cursor released:', final.cursorReleased);
console.log('errors:', errors.length ? errors : 'none');

const pass = pre.active && t0.cells === 1 && t0.shown && t0.unconfirmed &&
             t1.visible > 0 && t1.cursorAhead && bs.erasePredicted && bs.cursorSteppedBack &&
             final.hasOutput && final.pending === 0 && final.cursorReleased && !errors.length;
console.log(pass ? 'PREDICT PASS' : 'PREDICT FAIL');
process.exit(pass ? 0 : 1);
