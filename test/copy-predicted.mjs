import { chromium } from 'playwright';
const browser = await chromium.launch();
const ctx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
const page = await ctx.newPage({ viewport: { width: 1100, height: 620 } });
await page.goto('http://localhost:7861/?lag=600');
await page.waitForFunction(() => typeof haveFull !== 'undefined' && haveFull);
await page.waitForTimeout(2500);
// warm epoch
await page.keyboard.type('x'); await page.waitForFunction(() => predict.confirmedEpoch >= 1);
await page.keyboard.press('Backspace'); await page.waitForTimeout(1500);
// type text and IMMEDIATELY select it (still unconfirmed at 600ms lag)
await page.keyboard.type('freshly-typed');
const dc = await page.evaluate(() => ({ ...displayedCursor(), cw: cellW, ch: cellH }));
const y = dc.row * dc.ch + dc.ch / 2;
await page.mouse.move((dc.col - 13) * dc.cw + 2, y);
await page.mouse.down();
await page.mouse.move(dc.col * dc.cw - 2, y, { steps: 4 });
await page.mouse.up();
const selText = await page.evaluate(() => selectionText());
console.log('selection of just-typed text:', JSON.stringify(selText));
await browser.close();
