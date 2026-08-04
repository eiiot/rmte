import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium, devices } from 'playwright';

const browser = await chromium.launch({
  headless: true,
  ...(process.env.RMTE_CHROMIUM_PATH ? { executablePath: process.env.RMTE_CHROMIUM_PATH } : {}),
});
const context = await browser.newContext({ ...devices['iPhone 13'] });
const page = await context.newPage();

await page.setContent('<canvas id="term"></canvas><div id="hud"></div>');
await page.evaluate(() => {
  class MockWebSocket {
    static OPEN = 1;
    static sent = [];
    readyState = MockWebSocket.OPEN;
    constructor() { queueMicrotask(() => this.onopen?.()); }
    send(bytes) { MockWebSocket.sent.push(Array.from(bytes)); }
    close() {}
  }
  window.WebSocket = MockWebSocket;
});
await page.addScriptTag({ content: await readFile(new URL('../client/app.js', import.meta.url), 'utf8') });

await page.locator('#term').tap();
assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Terminal input');

await page.keyboard.insertText('hello');
await page.waitForFunction(() => WebSocket.sent.some((message) => message[0] === 1));
const input = await page.evaluate(() => {
  const message = WebSocket.sent.find((candidate) => candidate[0] === 1);
  return new TextDecoder().decode(new Uint8Array(message.slice(5)));
});
assert.equal(input, 'hello');

await page.evaluate(() => {
  const textarea = document.querySelector('textarea[aria-label="Terminal input"]');
  textarea.dispatchEvent(new InputEvent('input', { inputType: 'deleteContentBackward', bubbles: true }));
  textarea.dispatchEvent(new InputEvent('input', { inputType: 'insertLineBreak', bubbles: true }));
});
const controls = await page.evaluate(() => WebSocket.sent
  .filter((message) => message[0] === 1)
  .slice(-2)
  .map((message) => new TextDecoder().decode(new Uint8Array(message.slice(5)))));
assert.deepEqual(controls, ['\x7f', '\r']);

await browser.close();
console.log('mobile keyboard input: ok');
