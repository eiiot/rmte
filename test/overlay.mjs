// Status overlay + first-content watchdog: a connection that opens but never
// delivers content must (a) tell the user what's happening on screen, and
// (b) auto-reconnect to re-roll a dud path. Verified against a deliberately
// silent WebSocket server.
import { chromium } from 'playwright';
import http from 'node:http';
import crypto from 'node:crypto';

const HTTP = (process.env.RMTE_URL || 'ws://localhost:7861').replace(/^ws/, 'http');

// minimal WS server that accepts the upgrade and then stays silent forever
let upgrades = 0;
const silent = http.createServer();
silent.on('upgrade', (req, socket) => {
  upgrades += 1;
  const key = req.headers['sec-websocket-key'];
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  // never send a frame
});
await new Promise((r) => silent.listen(0, '127.0.0.1', r));
const silentPort = silent.address().port;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 500 } });
await page.goto(`${HTTP}/?ws=${encodeURIComponent('ws://127.0.0.1:' + silentPort + '/x')}`);
await page.waitForTimeout(2500);

const mid = await page.evaluate(() => ({
  state: overlayState,
  text: overlayPill.textContent,
  visible: overlay.style.display !== 'none',
}));

// wait past the watchdog window for at least one reconnect cycle
await page.waitForTimeout(9000);
const later = await page.evaluate(() => ({ attempts: reconnectAttempts, state: overlayState }));

let pass = true;
const check = (l, ok) => { console.log(l + ':', ok); pass &&= ok; };
check('overlay visible while waiting', mid.visible);
check('overlay explains state', /waiting for content|connecting/.test(mid.text));
check('watchdog reconnected (server saw multiple upgrades)', upgrades >= 2);
check('attempt counter grows', later.attempts >= 2);

// healthy path: overlay disappears once content arrives
const page2 = await browser.newPage({ viewport: { width: 900, height: 500 } });
await page2.goto(`${HTTP}/?session=overlay-healthy-${Date.now()}`);
await page2.waitForFunction(() => typeof haveFull !== 'undefined' && haveFull, null, { timeout: 8000 });
const healthy = await page2.evaluate(() => ({ state: overlayState, visible: overlay.style.display !== 'none' }));
check('overlay hidden once content renders', healthy.state === 'hidden' && !healthy.visible);

await browser.close();
silent.close();
console.log(pass ? 'OVERLAY PASS' : 'OVERLAY FAIL');
process.exit(pass ? 0 : 1);
