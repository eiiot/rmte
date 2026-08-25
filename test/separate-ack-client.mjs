// Browser-client coverage for split relay acknowledgements. Control ACKs may
// arrive before or after their shared display frame; embedded frame ACKs must
// be ignored once the control hello advertises separate acknowledgements.
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';

const HTTP = (process.env.RMTE_URL || 'ws://localhost:7861').replace(/^ws/, 'http');
const SESSION = `separate-ack-client-${process.pid}`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 500 } });

await page.goto(`${HTTP}/?session=${SESSION}`);
await page.waitForFunction(() => typeof haveFull !== 'undefined' && haveFull, null, {
  timeout: 8000,
});

const result = await page.evaluate(() => {
  const hello = new Uint8Array([0, 1, 2, 116, 101, 115, 116]);
  applyFrame(hello.buffer);

  const initial = ackForAppliedFrame(10, 999);

  const earlyAck = new Uint8Array(9);
  earlyAck[0] = MSG_INPUT_ACK;
  new DataView(earlyAck.buffer).setUint32(1, 7, true);
  new DataView(earlyAck.buffer).setUint32(5, 12, true);
  applyFrame(earlyAck.buffer);

  const beforeRequiredFrame = ackForAppliedFrame(11, 999);
  const atRequiredFrame = ackForAppliedFrame(12, 999);

  const lateAck = new Uint8Array(9);
  lateAck[0] = MSG_INPUT_ACK;
  new DataView(lateAck.buffer).setUint32(1, 8, true);
  new DataView(lateAck.buffer).setUint32(5, 12, true);
  applyFrame(lateAck.buffer);

  return {
    separateInputAcks,
    initial,
    beforeRequiredFrame,
    atRequiredFrame,
    lateAck: separateAckSeq,
    ignoresEmbeddedAck: ackForAppliedFrame(13, 999),
  };
});

await browser.close();
try {
  execFileSync('tmux', ['kill-session', '-t', SESSION], { stdio: 'ignore' });
} catch {}

console.log(JSON.stringify(result));
const pass = result.separateInputAcks &&
  result.initial === 0 &&
  result.beforeRequiredFrame === 0 &&
  result.atRequiredFrame === 7 &&
  result.lateAck === 8 &&
  result.ignoresEmbeddedAck === 8;
console.log(pass ? 'SEPARATE-ACK-CLIENT PASS' : 'SEPARATE-ACK-CLIENT FAIL');
process.exit(pass ? 0 : 1);
