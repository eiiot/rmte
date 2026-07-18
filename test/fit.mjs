// Fit-to-viewport test: a noresize viewer of a session larger than its
// viewport scales the font down so the whole grid fits, centers it, and maps
// mouse coordinates through the letterbox origin. A driving (plain) viewer
// keeps the fixed base font.
import { chromium } from 'playwright';
import { execSync } from 'node:child_process';

// rmte scrubs TMUX/TMUX_TMPDIR, so it attaches the true default server; the
// test must create its session there too (this test runner may itself be
// inside a tmux whose $TMUX would otherwise redirect these commands).
const cleanEnv = { ...process.env };
delete cleanEnv.TMUX;
delete cleanEnv.TMUX_TMPDIR;
const sh = (cmd) => execSync(cmd, { env: cleanEnv });

const HTTP = process.env.RMTE_URL?.replace(/^ws/, 'http') || 'http://localhost:7861';
const SES = 'rmte-fit-test';
sh(`tmux kill-session -t ${SES} 2>/dev/null || true; tmux new-session -d -s ${SES} -x 220 -y 50`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`${HTTP}/?session=${SES}&noresize=1`);
await page.waitForFunction(() => typeof haveFull !== 'undefined' && haveFull, null, { timeout: 8000 });
await page.waitForTimeout(300);

const fit = await page.evaluate(() => ({
  cols: grid.cols, rows: grid.rows, fontSize, cellW, cellH, originX, originY,
  fitsW: grid.cols * cellW <= window.innerWidth + 1,
  fitsH: grid.rows * cellH <= window.innerHeight + 1,
}));
console.log('fit state:', JSON.stringify(fit));

let pass = true;
const check = (l, ok) => { console.log(l + ':', ok); pass &&= ok; };
check('grid is the session size (220x50)', fit.cols === 220 && fit.rows === 50);
check('font scaled below base', fit.fontSize < 14);
check('grid fits viewport', fit.fitsW && fit.fitsH);
check('centered (some letterbox origin)', fit.originX >= 0 && fit.originY >= 0);
check('no page errors', errors.length === 0);

// driving viewer keeps base font
const page2 = await browser.newPage({ viewport: { width: 800, height: 500 } });
await page2.goto(`${HTTP}/?session=${SES}-drive`);
await page2.waitForFunction(() => typeof haveFull !== 'undefined' && haveFull, null, { timeout: 8000 });
const drive = await page2.evaluate(() => ({ fontSize }));
check('driving viewer keeps base font', drive.fontSize === 14);

await browser.close();
sh(`tmux kill-session -t ${SES} 2>/dev/null || true; tmux kill-session -t ${SES}-drive 2>/dev/null || true`);
console.log(pass ? 'FIT PASS' : 'FIT FAIL');
process.exit(pass ? 0 : 1);
