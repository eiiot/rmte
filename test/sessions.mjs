// Multi-session + read-only test: two sessions are isolated, the hello
// message reports session/flags, and read-only connections can't type.
const BASE = process.env.RMTE_URL || 'ws://localhost:7861';
const HTTP = BASE.replace(/^ws/, 'http');

const SES_A = 'rmte-test-a';
const SES_B = 'rmte-test-b';

function connect(session, ro) {
  const ws = new WebSocket(`${BASE}/ws?session=${session}${ro ? '&ro=1' : ''}`);
  ws.binaryType = 'arraybuffer';
  return new Promise((resolve, reject) => {
    const state = { ws, hello: null, gotFull: false };
    ws.onmessage = (ev) => {
      const b = new Uint8Array(ev.data);
      if (b[0] === 0) {
        state.hello = {
          version: b[1],
          readOnly: !!(b[2] & 1),
          session: new TextDecoder().decode(b.slice(3)),
        };
      }
      if (b[0] === 1 && (b[1] & 1)) state.gotFull = true;
      if (state.hello && state.gotFull) resolve(state);
    };
    ws.onerror = () => reject(new Error('ws error'));
    setTimeout(() => reject(new Error('connect timeout')), 8000);
  });
}

let seq = 0;
function sendInput(ws, str) {
  const payload = new TextEncoder().encode(str);
  const msg = new Uint8Array(5 + payload.length);
  msg[0] = 1;
  new DataView(msg.buffer).setUint32(1, ++seq, true);
  msg.set(payload, 5);
  ws.send(msg);
}

const text = async (session) => (await fetch(`${HTTP}/text?session=${session}`)).text();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const a = await connect(SES_A, false);
const b = await connect(SES_B, false);

console.log('hello A:', JSON.stringify(a.hello), '| hello B:', JSON.stringify(b.hello));
if (a.hello.session !== SES_A || b.hello.session !== SES_B ||
    a.hello.version !== 1 || a.hello.readOnly || b.hello.readOnly) {
  console.log('SESSIONS FAIL (hello)');
  process.exit(1);
}

// isolation: type in A, must appear in A and not in B
sendInput(a.ws, `echo marker-${process.pid}-A\r`);
await sleep(800);
const [ta, tb] = [await text(SES_A), await text(SES_B)];
const isolated = ta.includes(`marker-${process.pid}-A`) && !tb.includes(`marker-${process.pid}-A`);
console.log('isolation (A has marker, B does not):', isolated);

// read-only: connect ro to B, type, must NOT appear
const roB = await connect(SES_B, true);
console.log('hello roB:', JSON.stringify(roB.hello));
sendInput(roB.ws, `echo marker-${process.pid}-RO\r`);
await sleep(800);
const tb2 = await text(SES_B);
const roEnforced = roB.hello.readOnly && !tb2.includes(`marker-${process.pid}-RO`);
console.log('read-only enforced (no RO marker in B):', roEnforced);

a.ws.close(); b.ws.close(); roB.ws.close();

// cleanup test sessions
const { execSync } = await import('node:child_process');
for (const s of [SES_A, SES_B]) {
  try { execSync(`tmux kill-session -t ${s}`); } catch {}
}

const pass = isolated && roEnforced;
console.log(pass ? 'SESSIONS PASS' : 'SESSIONS FAIL');
process.exit(pass ? 0 : 1);
