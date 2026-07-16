// Clipboard test: emit OSC 52 from inside the tmux session and expect a
// MSG_CLIPBOARD (type 5) message with the decoded text.
const URL = process.env.TACHYON_URL || 'ws://localhost:7861/ws';
const ws = new WebSocket(URL);
ws.binaryType = 'arraybuffer';

const EXPECT = 'tachyon-clip-' + process.pid;
const b64 = Buffer.from(EXPECT).toString('base64');
let sent = false;

setTimeout(() => { console.error('TIMEOUT: no clipboard message'); process.exit(1); }, 8000);

ws.onmessage = (ev) => {
  const bytes = new Uint8Array(ev.data);
  if (bytes[0] === 1 && !sent) {
    sent = true;
    const cmd = `printf '\\033]52;c;${b64}\\007'\r`;
    const payload = new TextEncoder().encode(cmd);
    const msg = new Uint8Array(5 + payload.length);
    msg[0] = 1;
    new DataView(msg.buffer).setUint32(1, 1, true);
    msg.set(payload, 5);
    ws.send(msg);
  }
  if (bytes[0] === 5) {
    const text = new TextDecoder().decode(bytes.slice(1));
    if (text === EXPECT) {
      console.log('PASS clipboard OSC52 ->', JSON.stringify(text));
      process.exit(0);
    } else {
      console.error('FAIL clipboard text mismatch:', JSON.stringify(text));
      process.exit(1);
    }
  }
};
