// Verifies rmte serving over a Unix domain socket: checks the socket exists
// with 0600 perms, then bridges a local TCP port to it and runs a real
// WebSocket session (hello + full frame + input echo) through the bridge —
// proving the HTTP/WS stack works identically over the socket.
import net from 'node:net';
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const SOCK = process.env.RMTE_SOCK || '/tmp/rmte-test.sock';

// 1. socket exists and is owner-only (srw-------)
const st = fs.statSync(SOCK);
const mode = st.mode & 0o777;
console.log('socket mode:', mode.toString(8));
if (mode !== 0o600) { console.log('UNIX FAIL: socket not 0600'); process.exit(1); }

// 2. bridge a TCP port -> the unix socket so the browser WebSocket client works
const bridge = net.createServer((tcp) => {
  const ux = net.connect(SOCK);
  tcp.pipe(ux); ux.pipe(tcp);
  const kill = () => { tcp.destroy(); ux.destroy(); };
  tcp.on('error', kill); ux.on('error', kill);
});
await new Promise((r) => bridge.listen(0, '127.0.0.1', r));
const port = bridge.address().port;

// 3. run a WS session through the bridge
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?session=demo`);
ws.binaryType = 'arraybuffer';
let hello = null, gotFull = false;
let seq = 0;
const send = (str) => {
  const p = new TextEncoder().encode(str);
  const m = new Uint8Array(5 + p.length);
  m[0] = 1; new DataView(m.buffer).setUint32(1, ++seq, true); m.set(p, 5);
  ws.send(m);
};
const marker = 'unix-sock-' + process.pid;
const fail = setTimeout(() => { console.log('UNIX FAIL: timeout'); process.exit(1); }, 8000);

ws.onmessage = async (ev) => {
  const b = new Uint8Array(ev.data);
  if (b[0] === 0) hello = { version: b[1], ro: !!(b[2] & 1), session: new TextDecoder().decode(b.slice(3)) };
  if (b[0] === 1 && (b[1] & 1)) gotFull = true;
  if (hello && gotFull && seq === 0) send(`echo ${marker}\r`);
};

// poll /text over the bridge (HTTP works on the same socket)
async function textDump() {
  return await new Promise((resolve) => {
    const req = net.connect(port, '127.0.0.1', () => {
      req.write('GET /text?session=demo HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
    });
    let buf = '';
    req.on('data', (d) => (buf += d));
    req.on('end', () => resolve(buf.split('\r\n\r\n').slice(1).join('\r\n\r\n')));
    req.on('error', () => resolve(''));
  });
}

setTimeout(async () => {
  const text = await textDump();
  clearTimeout(fail);
  const ok = hello && hello.version === 1 && hello.session === 'demo' && text.includes(marker);
  console.log('hello:', JSON.stringify(hello), '| echo visible:', text.includes(marker));
  console.log(ok ? 'UNIX PASS' : 'UNIX FAIL');
  bridge.close(); ws.close();
  process.exit(ok ? 0 : 1);
}, 2500);
