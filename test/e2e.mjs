// End-to-end test: connect to tachyon, keep a grid model from binary diffs,
// type a command, verify it appears, and measure keystroke->frame latency.
const URL = process.env.TACHYON_URL || 'ws://localhost:7861/ws';

const ws = new WebSocket(URL);
ws.binaryType = 'arraybuffer';

const grid = { cols: 0, rows: 0, cp: null };
let haveFull = false;

function apply(buf) {
  const v = new DataView(buf);
  let o = 0;
  const type = v.getUint8(o); o += 1;
  if (type !== 1) return false;
  const flags = v.getUint8(o); o += 1;
  o += 4; // seq
  const cols = v.getUint16(o, true); o += 2;
  const rows = v.getUint16(o, true); o += 2;
  o += 2 + 2 + 1 + 4 + 4; // cursor, visible, modes, input-ack
  const lineCount = v.getUint16(o, true); o += 2;
  const full = !!(flags & 1);
  if (!haveFull && !full) return false;
  if (cols !== grid.cols || rows !== grid.rows) {
    if (!full) return false;
    grid.cols = cols; grid.rows = rows;
    grid.cp = new Uint32Array(cols * rows).fill(32);
  }
  haveFull = true;
  for (let l = 0; l < lineCount; l++) {
    const row = v.getUint16(o, true); o += 2;
    let c = v.getUint16(o, true); o += 2;
    const recCount = v.getUint16(o, true); o += 2;
    for (let r = 0; r < recCount; r++) {
      const repeat = v.getUint8(o); o += 1;
      const cp = v.getUint32(o, true); o += 4;
      o += 4 + 4 + 2; // fg, bg, attr
      for (let k = 0; k < repeat && c < cols; k++, c++) grid.cp[row * cols + c] = cp;
    }
  }
  return true;
}

function screenText() {
  let out = '';
  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++) out += String.fromCodePoint(grid.cp[r * grid.cols + c] || 32);
    out = out.trimEnd() + '\n';
  }
  return out;
}

let inputSeq = 0;
function sendInput(str) {
  const payload = new TextEncoder().encode(str);
  const msg = new Uint8Array(5 + payload.length);
  msg[0] = 1;
  new DataView(msg.buffer).setUint32(1, ++inputSeq, true);
  msg.set(payload, 5);
  ws.send(msg);
}

const MARKER = 'tachyon-e2e-' + process.pid;
let typedAt = null;
let firstEchoAt = null;
let done = false;

const fail = setTimeout(() => {
  console.error('TIMEOUT. Screen:\n' + screenText());
  process.exit(1);
}, 10000);

ws.onopen = () => {
  // request a sane size
  const msg = new Uint8Array(5);
  msg[0] = 2;
  new DataView(msg.buffer).setUint16(1, 120, true);
  new DataView(msg.buffer).setUint16(3, 30, true);
  ws.send(msg);
};

ws.onmessage = (ev) => {
  if (!apply(ev.data)) return;
  if (haveFull && typedAt === null) {
    typedAt = performance.now();
    sendInput(`echo ${MARKER}\r`);
    return;
  }
  const text = screenText();
  if (typedAt && firstEchoAt === null && text.includes(MARKER)) {
    firstEchoAt = performance.now();
  }
  // command echoed AND executed (marker appears twice: typed line + output line)
  if (!done && text.split(MARKER).length >= 3) {
    done = true;
    clearTimeout(fail);
    console.log(`PASS grid=${grid.cols}x${grid.rows}`);
    console.log(`keystrokes->first-echo-frame: ${(firstEchoAt - typedAt).toFixed(1)}ms`);
    console.log('--- screen tail ---');
    console.log(text.trimEnd().split('\n').slice(-6).join('\n'));
    process.exit(0);
  }
};

ws.onerror = (e) => { console.error('WS error', e.message || e); process.exit(1); };
