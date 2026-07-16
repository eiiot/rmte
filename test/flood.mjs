// Flood test: run `seq 300000` in the session and measure what reaches the
// client vs. what the raw byte stream would have been (~2MB for seq 300000).
const URL = process.env.TACHYON_URL || 'ws://localhost:7861/ws';
const ws = new WebSocket(URL);
ws.binaryType = 'arraybuffer';

let bytes = 0, frames = 0, started = null, lastFrame = null;

let inputSeq = 0;
function sendInput(str) {
  const payload = new TextEncoder().encode(str);
  const msg = new Uint8Array(5 + payload.length);
  msg[0] = 1;
  new DataView(msg.buffer).setUint32(1, ++inputSeq, true);
  msg.set(payload, 5);
  ws.send(msg);
}

ws.onopen = () => {
  setTimeout(() => {
    started = performance.now();
    sendInput('time seq 300000\r');
  }, 300);
};

ws.onmessage = (ev) => {
  if (started === null) return;
  bytes += ev.data.byteLength;
  frames += 1;
  lastFrame = performance.now();
};

setInterval(() => {
  if (started && lastFrame && performance.now() - lastFrame > 1500) {
    const dur = (lastFrame - started) / 1000;
    console.log(`frames=${frames} bytes=${(bytes / 1024).toFixed(0)}KB over ${dur.toFixed(2)}s`);
    console.log(`avg frame rate: ${(frames / dur).toFixed(0)}/s, avg bandwidth: ${(bytes / 1024 / dur).toFixed(0)} KB/s`);
    console.log(`raw seq output would be ~2000KB+; diff stream sent ${(bytes / 1024).toFixed(0)}KB`);
    process.exit(0);
  }
}, 200);
