// predict_overwrite test: embedded viewers (noresize) stamp only typed cells,
// so ghost text after the cursor (TUI suggestions) is never shifted; driving
// viewers keep mosh's shift model (row tail becomes predicted cells).
import { chromium } from 'playwright';
import { execSync } from 'node:child_process';

const HTTP = (process.env.RMTE_URL || 'ws://localhost:7861').replace(/^ws/, 'http');
const cleanEnv = { ...process.env };
delete cleanEnv.TMUX; delete cleanEnv.TMUX_TMPDIR;
const sh = (c) => execSync(c, { env: cleanEnv });
const SES = 'rmte-overwrite-test';
sh(`tmux kill-session -t ${SES} 2>/dev/null || true; tmux new-session -d -s ${SES} -x 120 -y 30`);

const browser = await chromium.launch();
let pass = true;
const check = (l, ok) => { console.log(l + ':', ok); pass &&= ok; };

async function typedFootprint(url) {
  const page = await browser.newPage({ viewport: { width: 900, height: 500 } });
  await page.goto(url);
  await page.waitForFunction(() => typeof haveFull !== 'undefined' && haveFull, null, { timeout: 8000 });
  await page.waitForTimeout(2500);
  await page.keyboard.type('x');
  await page.waitForFunction(() => predict.confirmedEpoch >= 1, null, { timeout: 5000 });
  await page.waitForFunction(() => predictPendingCount() === 0, null, { timeout: 5000 });
  await page.keyboard.type('abcd');
  const res = await page.evaluate(() => ({
    pending: predictPendingCount(),
    overwrite: predict.overwrite,
  }));
  await page.close();
  return res;
}

const emb = await typedFootprint(`${HTTP}/?session=${SES}&noresize=1&lag=300`);
console.log('embedded (noresize):', JSON.stringify(emb));
check('embedded uses overwrite', emb.overwrite === true);
check('embedded stamps only typed cells', emb.pending <= 5);

const drv = await typedFootprint(`${HTTP}/?session=${SES}&lag=300`);
console.log('driving:', JSON.stringify(drv));
check('driving uses shift', drv.overwrite === false);
check('driving activates the row tail', drv.pending > 20);

await browser.close();
sh(`tmux kill-session -t ${SES} 2>/dev/null || true`);
console.log(pass ? 'OVERWRITE PASS' : 'OVERWRITE FAIL');
process.exit(pass ? 0 : 1);
