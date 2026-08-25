// Relay-channel test: one display socket receives every shared frame while
// two control sockets receive only their own pong/input acknowledgements.
// The legacy combined channel remains wire-compatible.
import { execFileSync } from 'node:child_process';

const BASE = process.env.RMTE_URL || 'ws://localhost:7861';
const HTTP = BASE.replace(/^ws/, 'http');
const SESSION = `rmte-channels-${process.pid}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function connect(channel) {
  const ws = new WebSocket(`${BASE}/ws?session=${SESSION}&channel=${channel}`);
  ws.binaryType = 'arraybuffer';
  const state = {
    ws,
    hello: null,
    frames: [],
    acks: [],
    pongs: [],
    other: [],
  };
  ws.onmessage = (event) => {
    const bytes = new Uint8Array(event.data);
    const view = new DataView(event.data);
    switch (bytes[0]) {
      case 0:
        state.hello = {
          version: bytes[1],
          readOnly: !!(bytes[2] & 1),
          separateAck: !!(bytes[2] & 2),
          session: new TextDecoder().decode(bytes.slice(3)),
        };
        break;
      case 1:
        state.frames.push({
          seq: view.getUint32(2, true),
          ack: view.getUint32(19, true),
          full: !!(bytes[1] & 1),
        });
        break;
      case 2:
        state.pongs.push(Array.from(bytes.slice(1)));
        break;
      case 6:
        state.acks.push({
          inputSeq: view.getUint32(1, true),
          frameSeq: view.getUint32(5, true),
        });
        break;
      default:
        state.other.push(bytes[0]);
    }
  };
  return state;
}

async function waitFor(label, predicate, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(20);
  }
  throw new Error(`timeout waiting for ${label}`);
}

function sendInput(ws, seq, text) {
  const payload = new TextEncoder().encode(text);
  const message = new Uint8Array(5 + payload.length);
  message[0] = 1;
  new DataView(message.buffer).setUint32(1, seq, true);
  message.set(payload, 5);
  ws.send(message);
}

function sendPing(ws, marker) {
  ws.send(Uint8Array.from([3, marker]));
}

let pass = true;
const check = (label, ok) => {
  console.log(`${label}:`, ok);
  pass &&= ok;
};

const display = connect('display');
const controlA = connect('control');
const controlB = connect('control');

try {
  await waitFor('channel hellos and initial display frame', () =>
    display.hello && controlA.hello && controlB.hello &&
    display.frames.some((frame) => frame.full));

  check('display is read-only and separate-ack capable',
    display.hello.readOnly && display.hello.separateAck);
  check('controls are writable and separate-ack capable',
    !controlA.hello.readOnly && controlA.hello.separateAck &&
    !controlB.hello.readOnly && controlB.hello.separateAck);
  check('all channels name the same session',
    [display, controlA, controlB].every((state) => state.hello.session === SESSION));

  await sleep(200);
  check('control channels receive no display frames',
    controlA.frames.length === 0 && controlB.frames.length === 0);

  const blockedMarker = `display-write-${process.pid}`;
  sendInput(display.ws, 99, `printf '${blockedMarker}\\n'\r`);
  await sleep(200);
  const screenAfterDisplayInput = await (await fetch(
    `${HTTP}/text?session=${SESSION}`,
  )).text();
  check('display channel is read-only server-side',
    !screenAfterDisplayInput.includes(blockedMarker));

  sendPing(controlA.ws, 0xa1);
  await waitFor('control A pong', () => controlA.pongs.some((pong) => pong[0] === 0xa1));
  await sleep(100);
  check('pong stays on its viewer control channel',
    !controlB.pongs.some((pong) => pong[0] === 0xa1));

  // Both viewers deliberately use input sequence 1. Each must receive only
  // its own acknowledgement, tied to a frame on the shared display stream.
  sendInput(controlA.ws, 1, `printf 'channel-a-${process.pid}\\n'\r`);
  await waitFor('control A ack', () => controlA.acks.some((ack) => ack.inputSeq === 1));
  const ackA = controlA.acks.find((ack) => ack.inputSeq === 1);
  await waitFor('A ack frame on display', () =>
    display.frames.some((frame) => frame.seq >= ackA.frameSeq));
  check('A ack does not leak to B', controlB.acks.length === 0);

  sendInput(controlB.ws, 1, `printf 'channel-b-${process.pid}\\n'\r`);
  await waitFor('control B ack', () => controlB.acks.some((ack) => ack.inputSeq === 1));
  const ackB = controlB.acks.find((ack) => ack.inputSeq === 1);
  await waitFor('B ack frame on display', () =>
    display.frames.some((frame) => frame.seq >= ackB.frameSeq));
  check('overlapping client sequences remain isolated',
    controlA.acks.length === 1 && controlB.acks.length === 1);

  const combined = connect('combined');
  await waitFor('legacy combined full frame', () =>
    combined.hello && combined.frames.some((frame) => frame.full));
  check('combined hello remains legacy-compatible',
    !combined.hello.separateAck && !combined.hello.readOnly);
  sendInput(combined.ws, 73, `printf 'legacy-${process.pid}\\n'\r`);
  await waitFor('embedded legacy ack', () =>
    combined.frames.some((frame) => frame.ack === 73));
  check('combined input still uses frame-embedded ack', combined.acks.length === 0);
  combined.ws.close();
} finally {
  display.ws.close();
  controlA.ws.close();
  controlB.ws.close();
  try {
    execFileSync('tmux', ['kill-session', '-t', SESSION], { stdio: 'ignore' });
  } catch {}
}

console.log(pass ? 'CHANNELS PASS' : 'CHANNELS FAIL');
process.exit(pass ? 0 : 1);
