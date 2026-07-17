import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 600 } });
// point the page's app at an explicit ws endpoint via ?ws=
await page.goto('http://localhost:7861/?ws=' + encodeURIComponent('ws://localhost:7861/ws?session=demo'));
await page.waitForFunction(() => typeof haveFull !== 'undefined' && haveFull, null, { timeout: 8000 });
const ok = await page.evaluate(() => ({ session: sessionName, cols: grid.cols, connected }));
console.log('via ?ws= override:', JSON.stringify(ok));
// also test window.RMTE_WS_URL injection (the router's mechanism)
const page2 = await browser.newPage({ viewport: { width: 1000, height: 600 } });
await page2.addInitScript(() => { window.RMTE_WS_URL = 'ws://localhost:7861/ws?session=demo'; });
await page2.goto('http://localhost:7861/');
await page2.waitForFunction(() => typeof haveFull !== 'undefined' && haveFull, null, { timeout: 8000 });
const ok2 = await page2.evaluate(() => ({ session: sessionName, connected }));
console.log('via window.RMTE_WS_URL:', JSON.stringify(ok2));
await browser.close();
console.log(ok.connected && ok2.connected ? 'WS-OVERRIDE PASS' : 'WS-OVERRIDE FAIL');
process.exit(ok.connected && ok2.connected ? 0 : 1);
