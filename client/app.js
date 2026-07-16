'use strict';

// ---- protocol constants (keep in sync with server/src/engine.rs) ----
const MSG_FRAME = 1, MSG_PONG = 2, MSG_CLOSED = 4, MSG_CLIPBOARD = 5;
const IN_INPUT = 1, IN_RESIZE = 2, IN_PING = 3;
const ATTR_BOLD = 1, ATTR_ITALIC = 2, ATTR_UNDERLINE = 4, ATTR_DIM = 8,
      ATTR_STRIKEOUT = 16, ATTR_WIDE = 32, ATTR_SPACER = 64;
const MODE_APP_CURSOR = 1, MODE_BRACKETED_PASTE = 2, MODE_MOUSE = 4,
      MODE_SGR_MOUSE = 8, MODE_MOUSE_MOTION = 16, MODE_ALT_SCREEN = 32,
      MODE_MOUSE_DRAG = 64;

const params = new URLSearchParams(location.search);
const simLag = Math.max(0, +(params.get('lag') || 0)); // simulated extra RTT, ms

const canvas = document.getElementById('term');
const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
const hud = document.getElementById('hud');

const FONT_SIZE = 14;
const FONT_STACK = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const DEFAULT_BG = '#121212';

// ---- font metrics ----
let cellW, cellH, baseline, dpr;
function measureFont() {
  dpr = window.devicePixelRatio || 1;
  ctx.font = `${FONT_SIZE}px ${FONT_STACK}`;
  cellW = ctx.measureText('M').width;
  cellH = Math.ceil(FONT_SIZE * 1.3);
  baseline = Math.round(FONT_SIZE * 1.02);
}
measureFont();

// ---- grid model ----
const grid = {
  cols: 0, rows: 0,
  cp: null, fg: null, bg: null, attr: null,
  curRow: 0, curCol: 0, curVisible: true,
  modes: 0,
  alloc(cols, rows) {
    this.cols = cols; this.rows = rows;
    const n = cols * rows;
    this.cp = new Uint32Array(n).fill(32);
    this.fg = new Uint32Array(n);
    this.bg = new Uint32Array(n);
    this.attr = new Uint16Array(n);
    clearSelection();
    flushPredictions();
  },
};

// ---- prediction engine (port of mosh's frontend/terminaloverlay.cc) ----
// Epochs: a prediction is "tentative" (hidden) until some prediction from its
// epoch is confirmed by the server; risky input (control chars) starts a new
// epoch. Adaptive display: predictions only show when the link is slow enough
// to need them. Flagging: underline predictions when the link is bad or a
// prediction has been outstanding too long. Validation is ack-gated: a
// prediction is judged only against frames whose input-ack covers it.
const SRTT_TRIGGER_LOW = 20, SRTT_TRIGGER_HIGH = 30;   // show predictions
const FLAG_TRIGGER_LOW = 50, FLAG_TRIGGER_HIGH = 80;   // underline them
const GLITCH_THRESHOLD = 250, GLITCH_FLAG_THRESHOLD = 5000;
const GLITCH_REPAIR_COUNT = 10, GLITCH_REPAIR_MININTERVAL = 150;
const ACK_ECHO_GRACE = 150; // our ack = "reached the pty", echo may lag a beat

const CURSOR_ADOPT_GRACE = 50; // ms after ack before trusting the server cursor again

const predict = {
  mode: ['adaptive', 'always', 'never'].includes(params.get('predict')) ? params.get('predict') : 'adaptive',
  cells: [],        // {row, col, cp, epoch, inputSeq, sentAt, ackedAt}
  cursor: null,     // {row, col, epoch, inputSeq, sentAt, ackedAt}
  predictionEpoch: 1,
  confirmedEpoch: 0,
  srtt: null,
  srttTrigger: false,
  glitchTrigger: 0,
  flagging: false,
  lastQuickConfirmation: 0,
};

function predictActive() {
  if (predict.mode === 'never') return false;
  if (predict.mode === 'always') return true;
  return predict.srttTrigger || predict.glitchTrigger > 0;
}

function predictSrttSample(ms) {
  predict.srtt = predict.srtt == null ? ms : 0.875 * predict.srtt + 0.125 * ms;
  if (predict.srtt > SRTT_TRIGGER_HIGH) predict.srttTrigger = true;
  else if (predict.srttTrigger && predict.srtt <= SRTT_TRIGGER_LOW && !predict.cells.length) predict.srttTrigger = false;
  if (predict.srtt > FLAG_TRIGGER_HIGH) predict.flagging = true;
  else if (predict.flagging && predict.srtt <= FLAG_TRIGGER_LOW && !predict.glitchTrigger) predict.flagging = false;
}

function predictDirty() {
  for (const p of predict.cells) dirtyRows.add(p.row);
  if (predict.cursor) dirtyRows.add(predict.cursor.row);
  dirtyRows.add(grid.curRow);
  schedulePaint();
}

function becomeTentative() {
  predict.predictionEpoch += 1;
}

function flushPredictions() {
  if (!predict.cells.length && !predict.cursor) return;
  predictDirty();
  predict.cells = [];
  predict.cursor = null;
  becomeTentative();
}

function killEpoch(epoch) {
  predictDirty();
  predict.cells = predict.cells.filter((p) => p.epoch < epoch);
  predict.cursor = null;
  becomeTentative();
  predict.glitchTrigger = GLITCH_REPAIR_COUNT * 2; // mispredicted: stay watchful
}

function setCursorPrediction(row, col, inputSeq, now) {
  if (predict.cursor) dirtyRows.add(predict.cursor.row);
  predict.cursor = {
    row, col, epoch: predict.predictionEpoch,
    inputSeq, sentAt: now, ackedAt: 0,
  };
  dirtyRows.add(row);
  schedulePaint();
}

function predictInput(str, inputSeq) {
  if (predict.mode === 'never' || !haveFull) return;
  const now = performance.now();
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    if (cp === 0x7f) { // backspace: retract our own pending prediction only
      if (predict.cells.length) {
        const p = predict.cells.pop();
        setCursorPrediction(p.row, p.col, inputSeq, now);
      } else {
        becomeTentative();
      }
      continue;
    }
    if (cp === 0x0d) { // Enter: predict cursor to column 0 of the next row (as mosh does)
      becomeTentative();
      const base = predict.cursor || { row: grid.curRow, col: grid.curCol };
      setCursorPrediction(Math.min(base.row + 1, grid.rows - 1), 0, inputSeq, now);
      continue;
    }
    if (cp < 32) { // other control: risky — new epoch, keep whatever cursor we have current
      becomeTentative();
      continue;
    }
    const base = predict.cursor || { row: grid.curRow, col: grid.curCol };
    if (!grid.curVisible || base.row >= grid.rows || base.col >= grid.cols - 1) {
      becomeTentative();
      continue; // no wrap prediction
    }
    predict.cells.push({
      row: base.row, col: base.col, cp,
      epoch: predict.predictionEpoch, inputSeq, sentAt: now, ackedAt: 0,
    });
    setCursorPrediction(base.row, base.col + 1, inputSeq, now);
  }
}

function reconcilePredictions(ackSeq) {
  if (!predict.cells.length && !predict.cursor) return;
  const now = performance.now();
  const surviving = [];
  let killAt = -1;
  let i = 0;
  for (; i < predict.cells.length; i++) {
    const p = predict.cells[i];
    if (ackSeq != null && !p.ackedAt && ackSeq >= p.inputSeq) p.ackedAt = now;
    if (p.row < grid.rows && p.col < grid.cols && grid.cp[p.row * grid.cols + p.col] === p.cp) {
      // confirmed correct
      if (p.epoch > predict.confirmedEpoch) {
        predict.confirmedEpoch = p.epoch;
        predictDirty(); // newly-confirmed epoch may unhide siblings
      }
      if (now - p.sentAt < GLITCH_THRESHOLD &&
          now - predict.lastQuickConfirmation >= GLITCH_REPAIR_MININTERVAL) {
        if (predict.glitchTrigger > 0) predict.glitchTrigger -= 1;
        predict.lastQuickConfirmation = now;
      }
      dirtyRows.add(p.row);
      continue;
    }
    if (p.ackedAt && now - p.ackedAt > ACK_ECHO_GRACE) {
      // frame provably includes this keystroke and the cell disagrees
      killAt = p.epoch;
      i++;
      break;
    }
    if (now - p.sentAt > GLITCH_THRESHOLD) {
      predict.glitchTrigger = Math.max(predict.glitchTrigger, GLITCH_REPAIR_COUNT * 2);
      if (now - p.sentAt > GLITCH_FLAG_THRESHOLD) predict.flagging = true;
    }
    surviving.push(p);
  }
  for (; i < predict.cells.length; i++) surviving.push(predict.cells[i]);
  predict.cells = surviving;
  if (killAt >= 0) {
    killEpoch(killAt);
    schedulePaint();
    return;
  }
  // Cursor handoff: adopt the server cursor only once a frame provably
  // reflects the keystroke that placed the predicted cursor (plus a small
  // echo grace) — never snap back to a stale position.
  if (predict.cursor) {
    const cur = predict.cursor;
    if (ackSeq != null && !cur.ackedAt && ackSeq >= cur.inputSeq) cur.ackedAt = now;
    if (cur.ackedAt && now - cur.ackedAt > CURSOR_ADOPT_GRACE && !predict.cells.length) {
      dirtyRows.add(cur.row);
      dirtyRows.add(grid.curRow);
      predict.cursor = null;
    }
  }
  schedulePaint();
}

// no-echo contexts (password prompts, vim normal mode) may never produce a
// frame; expire outstanding predictions on a timer too
setInterval(() => {
  const now = performance.now();
  const limit = Math.max(2 * (predict.srtt || 100), 500) + GLITCH_THRESHOLD;
  if (predict.cells.length && now - predict.cells[0].sentAt > limit) {
    killEpoch(predict.cells[0].epoch);
    schedulePaint();
  } else if (!predict.cells.length && predict.cursor && now - predict.cursor.sentAt > limit) {
    dirtyRows.add(predict.cursor.row);
    dirtyRows.add(grid.curRow);
    predict.cursor = null;
    schedulePaint();
  }
}, 250);

// ---- selection ----
const SEL_BG = 0x2f5a8f;
const sel = { active: false, dragging: false, startR: 0, startC: 0, endR: 0, endC: 0 };

function normSel() {
  let { startR: sr, startC: sc, endR: er, endC: ec } = sel;
  if (sr > er || (sr === er && sc > ec)) [sr, sc, er, ec] = [er, ec, sr, sc];
  return [sr, sc, er, ec];
}

function inSel(r, c) {
  if (!sel.active) return false;
  const [sr, sc, er, ec] = normSel();
  if (r < sr || r > er) return false;
  if (sr === er) return c >= sc && c <= ec;
  if (r === sr) return c >= sc;
  if (r === er) return c <= ec;
  return true;
}

function markRows(a, b) {
  const lo = Math.max(0, Math.min(a, b));
  const hi = Math.min(grid.rows - 1, Math.max(a, b));
  for (let r = lo; r <= hi; r++) dirtyRows.add(r);
  schedulePaint();
}

function clearSelection() {
  if (!sel.active) return;
  const [sr, , er] = normSel();
  sel.active = false;
  sel.dragging = false;
  markRows(sr, er);
}

function selectionText() {
  if (!sel.active) return '';
  const [sr, sc, er, ec] = normSel();
  const lines = [];
  for (let r = sr; r <= er; r++) {
    const from = r === sr ? sc : 0;
    const to = r === er ? ec : grid.cols - 1;
    let line = '';
    for (let c = from; c <= to && c < grid.cols; c++) {
      const i = r * grid.cols + c;
      if (grid.attr[i] & ATTR_SPACER) continue;
      line += String.fromCodePoint(grid.cp[i] || 32);
    }
    lines.push(line.replace(/\s+$/, ''));
  }
  return lines.join('\n');
}

function copySelection() {
  const text = selectionText();
  if (!text.trim()) return;
  navigator.clipboard.writeText(text).catch(() => {});
}

let haveFull = false;
let dirtyRows = new Set();
let paintScheduled = false;

function fitCanvas() {
  canvas.width = Math.round(window.innerWidth * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
  canvas.style.width = window.innerWidth + 'px';
  canvas.style.height = window.innerHeight + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = DEFAULT_BG;
  ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);
}

function viewportGrid() {
  return {
    cols: Math.max(10, Math.floor(window.innerWidth / cellW)),
    rows: Math.max(4, Math.floor(window.innerHeight / cellH)),
  };
}

// ---- rendering ----
const css = new Map();
function color(rgb) {
  let c = css.get(rgb);
  if (!c) {
    c = '#' + rgb.toString(16).padStart(6, '0');
    css.set(rgb, c);
  }
  return c;
}

function paintRow(r) {
  if (r >= grid.rows) return;
  const y = r * cellH;
  const base = r * grid.cols;

  // background runs (selection overrides cell bg)
  const bgAt = (c) => (inSel(r, c) ? SEL_BG : grid.bg[base + c]);
  let runStart = 0, runBg = bgAt(0);
  for (let c = 1; c <= grid.cols; c++) {
    const bg = c < grid.cols ? bgAt(c) : -1;
    if (bg !== runBg) {
      ctx.fillStyle = color(runBg);
      ctx.fillRect(runStart * cellW, y, (c - runStart) * cellW + 0.5, cellH);
      runStart = c; runBg = bg;
    }
  }

  // glyphs
  for (let c = 0; c < grid.cols; c++) {
    const i = base + c;
    const cp = grid.cp[i];
    const attr = grid.attr[i];
    if (attr & ATTR_SPACER) continue;
    const x = c * cellW;
    const fg = grid.fg[i];
    const wide = attr & ATTR_WIDE;
    const w = wide ? cellW * 2 : cellW;
    if (attr & (ATTR_UNDERLINE | ATTR_STRIKEOUT)) {
      ctx.fillStyle = color(fg);
      if (attr & ATTR_UNDERLINE) ctx.fillRect(x, y + cellH - 2, w, 1);
      if (attr & ATTR_STRIKEOUT) ctx.fillRect(x, y + Math.round(cellH / 2), w, 1);
    }
    if (cp === 32 || cp === 0) continue;
    let font = `${FONT_SIZE}px ${FONT_STACK}`;
    if (attr & ATTR_BOLD) font = '600 ' + font;
    if (attr & ATTR_ITALIC) font = 'italic ' + font;
    ctx.font = font;
    ctx.globalAlpha = (attr & ATTR_DIM) ? 0.55 : 1;
    ctx.fillStyle = color(fg);
    ctx.fillText(String.fromCodePoint(cp), x, y + baseline, w);
    ctx.globalAlpha = 1;
  }

  // prediction overlay (hidden while tentative; underlined when flagging)
  if (predictActive()) {
    for (const p of predict.cells) {
      if (p.row !== r || p.epoch > predict.confirmedEpoch) continue;
      const x = p.col * cellW;
      ctx.fillStyle = color(grid.bg[base + p.col]);
      ctx.fillRect(x, y, cellW, cellH);
      ctx.font = `${FONT_SIZE}px ${FONT_STACK}`;
      ctx.fillStyle = color(grid.fg[base + p.col] || 0xd4d4d4);
      ctx.fillText(String.fromCodePoint(p.cp), x, y + baseline, cellW);
      if (predict.flagging) ctx.fillRect(x, y + cellH - 2, cellW, 1);
    }
  }

  // cursor overlay: predicted position while predictions are in flight
  // (outline while the epoch is tentative, solid once confirmed) — the
  // displayed cursor never snaps back to a stale server position
  const predCursor = predictActive() && predict.cursor;
  const dc = predCursor ? predict.cursor : { row: grid.curRow, col: grid.curCol };
  const tentativeCursor = predCursor && predict.cursor.epoch > predict.confirmedEpoch;
  if (grid.curVisible && dc.row === r && dc.col < grid.cols) {
    const i = base + dc.col;
    const x = dc.col * cellW;
    if (focused && !tentativeCursor) {
      ctx.fillStyle = color(grid.fg[i]);
      ctx.fillRect(x, y, cellW, cellH);
      const cp = grid.cp[i];
      if (cp > 32) {
        ctx.fillStyle = color(grid.bg[i]);
        ctx.fillText(String.fromCodePoint(cp), x, y + baseline, cellW);
      }
    } else {
      ctx.strokeStyle = color(grid.fg[i]);
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, cellW - 1, cellH - 1);
    }
  }
}

function schedulePaint() {
  if (paintScheduled) return;
  paintScheduled = true;
  queueMicrotask(() => {
    paintScheduled = false;
    for (const r of dirtyRows) paintRow(r);
    dirtyRows.clear();
  });
}

function paintAll() {
  fitCanvas();
  for (let r = 0; r < grid.rows; r++) paintRow(r);
  dirtyRows.clear();
}

// ---- frame decoding ----
function applyFrame(buf) {
  const v = new DataView(buf);
  let o = 0;
  const type = v.getUint8(o); o += 1;
  if (type === MSG_PONG) {
    const sent = v.getFloat64(1, true);
    rtt = performance.now() - sent;
    predictSrttSample(rtt);
    updateHud();
    return;
  }
  if (type === MSG_CLIPBOARD) {
    const text = new TextDecoder().decode(new Uint8Array(buf, 1));
    if (text) navigator.clipboard.writeText(text).catch(() => {});
    return;
  }
  if (type === MSG_CLOSED) {
    hud.textContent = 'session ended';
    hud.classList.add('bad');
    return;
  }
  if (type !== MSG_FRAME) return;

  const flags = v.getUint8(o); o += 1;
  o += 4; // seq
  const cols = v.getUint16(o, true); o += 2;
  const rows = v.getUint16(o, true); o += 2;
  const curRow = v.getUint16(o, true); o += 2;
  const curCol = v.getUint16(o, true); o += 2;
  const curVisible = !!v.getUint8(o); o += 1;
  const modes = v.getUint32(o, true); o += 4;
  const ack = v.getUint32(o, true); o += 4;
  const lineCount = v.getUint16(o, true); o += 2;

  const full = !!(flags & 1);
  if (!haveFull && !full) return; // wait for first snapshot
  if (cols !== grid.cols || rows !== grid.rows) {
    if (!full) return; // stale partial for old dims
    grid.alloc(cols, rows);
    haveFull = true;
    grid.modes = modes;
    decodeLines(v, o, lineCount);
    grid.curRow = curRow; grid.curCol = curCol; grid.curVisible = curVisible;
    paintAll();
    updateHud();
    return;
  }
  haveFull = true;
  grid.modes = modes;

  const prevCurRow = grid.curRow;
  decodeLines(v, o, lineCount, dirtyRows);
  grid.curRow = curRow; grid.curCol = curCol; grid.curVisible = curVisible;
  dirtyRows.add(prevCurRow);
  dirtyRows.add(curRow);
  if (full) { for (let r = 0; r < grid.rows; r++) dirtyRows.add(r); }
  reconcilePredictions(ack);
  schedulePaint();
}

function decodeLines(v, o, lineCount, dirty) {
  for (let l = 0; l < lineCount; l++) {
    const row = v.getUint16(o, true); o += 2;
    let c = v.getUint16(o, true); o += 2;
    const recCount = v.getUint16(o, true); o += 2;
    const base = row * grid.cols;
    for (let rec = 0; rec < recCount; rec++) {
      const repeat = v.getUint8(o); o += 1;
      const cp = v.getUint32(o, true); o += 4;
      const fg = v.getUint32(o, true); o += 4;
      const bg = v.getUint32(o, true); o += 4;
      const attr = v.getUint16(o, true); o += 2;
      for (let k = 0; k < repeat && c < grid.cols; k++, c++) {
        const i = base + c;
        grid.cp[i] = cp; grid.fg[i] = fg; grid.bg[i] = bg; grid.attr[i] = attr;
      }
    }
    if (dirty) dirty.add(row);
  }
  return o;
}

// ---- websocket ----
let ws = null, connected = false, rtt = null;
let focused = document.hasFocus();

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => {
    connected = true;
    haveFull = false;
    sendResize();
    updateHud();
  };
  ws.onmessage = simLag
    ? (ev) => setTimeout(() => applyFrame(ev.data), simLag / 2)
    : (ev) => applyFrame(ev.data);
  ws.onclose = () => {
    connected = false;
    hud.textContent = 'reconnecting…';
    hud.classList.add('bad');
    setTimeout(connect, 500);
  };
}

function send(bytes) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (simLag) setTimeout(() => { if (ws.readyState === WebSocket.OPEN) ws.send(bytes); }, simLag / 2);
  else ws.send(bytes);
}

const utf8 = new TextEncoder();
let inputSeq = 0;
function sendInput(str) {
  inputSeq += 1;
  const payload = utf8.encode(str);
  const msg = new Uint8Array(5 + payload.length);
  msg[0] = IN_INPUT;
  new DataView(msg.buffer).setUint32(1, inputSeq, true);
  msg.set(payload, 5);
  send(msg);
  return inputSeq;
}

function sendResize() {
  const { cols, rows } = viewportGrid();
  const msg = new Uint8Array(5);
  msg[0] = IN_RESIZE;
  new DataView(msg.buffer).setUint16(1, cols, true);
  new DataView(msg.buffer).setUint16(3, rows, true);
  send(msg);
}

setInterval(() => {
  const msg = new Uint8Array(9);
  msg[0] = IN_PING;
  new DataView(msg.buffer).setFloat64(1, performance.now(), true);
  send(msg);
}, 2000);

function updateHud() {
  if (!connected) return;
  hud.classList.remove('bad');
  const ms = rtt == null ? '–' : rtt < 10 ? rtt.toFixed(1) : Math.round(rtt);
  const parts = [`${ms}ms`, `${grid.cols}×${grid.rows}`];
  if (simLag) parts.push(`+${simLag}ms lag`);
  if (predict.mode !== 'adaptive') parts.push(`pred:${predict.mode}`);
  else if (predictActive()) parts.push('pred:on');
  hud.textContent = parts.join(' · ');
}

// ---- keyboard ----
const CODE_CHARS = {};
for (let i = 0; i < 26; i++) CODE_CHARS['Key' + String.fromCharCode(65 + i)] = String.fromCharCode(97 + i);
for (let i = 0; i < 10; i++) CODE_CHARS['Digit' + i] = String(i);

function encodeKey(e) {
  const appCursor = grid.modes & MODE_APP_CURSOR;
  const mod = 1 + (e.shiftKey ? 1 : 0) + (e.altKey ? 2 : 0) + (e.ctrlKey ? 4 : 0);
  const csi = (code, suffix) =>
    mod > 1 ? `\x1b[${code === '' ? '1' : code};${mod}${suffix}` : null;
  const cursor = (suffix) =>
    mod > 1 ? `\x1b[1;${mod}${suffix}` : (appCursor ? `\x1bO${suffix}` : `\x1b[${suffix}`);
  const tilde = (num) => (mod > 1 ? `\x1b[${num};${mod}~` : `\x1b[${num}~`);

  switch (e.key) {
    case 'Enter': return '\r';
    case 'Backspace': return e.altKey ? '\x1b\x7f' : '\x7f';
    case 'Tab': return e.shiftKey ? '\x1b[Z' : '\t';
    case 'Escape': return '\x1b';
    case 'ArrowUp': return cursor('A');
    case 'ArrowDown': return cursor('B');
    case 'ArrowRight': return cursor('C');
    case 'ArrowLeft': return cursor('D');
    case 'Home': return csi('1', 'H') || (appCursor ? '\x1bOH' : '\x1b[H');
    case 'End': return csi('1', 'F') || (appCursor ? '\x1bOF' : '\x1b[F');
    case 'PageUp': return tilde(5);
    case 'PageDown': return tilde(6);
    case 'Insert': return tilde(2);
    case 'Delete': return tilde(3);
    case 'F1': return mod > 1 ? '\x1b[1;' + mod + 'P' : '\x1bOP';
    case 'F2': return mod > 1 ? '\x1b[1;' + mod + 'Q' : '\x1bOQ';
    case 'F3': return mod > 1 ? '\x1b[1;' + mod + 'R' : '\x1bOR';
    case 'F4': return mod > 1 ? '\x1b[1;' + mod + 'S' : '\x1bOS';
    case 'F5': return tilde(15);
    case 'F6': return tilde(17);
    case 'F7': return tilde(18);
    case 'F8': return tilde(19);
    case 'F9': return tilde(20);
    case 'F10': return tilde(21);
    case 'F11': return tilde(23);
    case 'F12': return tilde(24);
  }

  if (e.key.length !== 1) return null;

  if (e.ctrlKey && !e.altKey) {
    const c = e.key.toUpperCase().charCodeAt(0);
    if (e.key === ' ') return '\x00';
    if (c >= 63 && c < 128) return String.fromCharCode(c & 0x1f);
    return null;
  }
  if (e.altKey) {
    const base = CODE_CHARS[e.code] || e.key;
    return '\x1b' + (e.shiftKey ? base.toUpperCase() : base);
  }
  return e.key;
}

function sendPaste(text) {
  if (!text) return;
  if (grid.modes & MODE_BRACKETED_PASTE) {
    sendInput('\x1b[200~' + text + '\x1b[201~');
  } else {
    sendInput(text);
  }
}

function pasteFromClipboard() {
  navigator.clipboard.readText().then(sendPaste).catch(() => {});
}

window.addEventListener('keydown', (e) => {
  // copy/paste: cmd+c/cmd+v (mac), ctrl+shift+c/v (elsewhere)
  const copyCombo = (e.metaKey && !e.ctrlKey && e.key === 'c') ||
                    (e.ctrlKey && e.shiftKey && e.key === 'C');
  const pasteCombo = (e.metaKey && !e.ctrlKey && e.key === 'v') ||
                     (e.ctrlKey && e.shiftKey && e.key === 'V');
  if (copyCombo && sel.active) {
    e.preventDefault();
    copySelection();
    return;
  }
  if (pasteCombo) {
    e.preventDefault();
    pasteFromClipboard();
    return;
  }
  if (e.metaKey) return; // other cmd combos stay with the browser
  const seq = encodeKey(e);
  if (seq !== null) {
    e.preventDefault();
    const s = sendInput(seq);
    // predict only typing-like input; escape sequences (arrows etc.) move the
    // cursor in ways we don't model, so they just start a new epoch
    const typing = seq === '\r' || seq === '\x7f' ||
      (Array.from(seq).length === 1 && seq.codePointAt(0) >= 32);
    if (typing) predictInput(seq, s);
    else becomeTentative();
  }
});

window.addEventListener('paste', (e) => {
  const text = e.clipboardData.getData('text');
  if (!text) return;
  e.preventDefault();
  sendPaste(text);
});

// ---- mouse ----
function mouseCell(e) {
  return {
    x: Math.min(grid.cols, Math.max(1, Math.floor(e.clientX / cellW) + 1)),
    y: Math.min(grid.rows, Math.max(1, Math.floor(e.clientY / cellH) + 1)),
  };
}

function sendMouse(btn, e, release) {
  if (!(grid.modes & MODE_MOUSE)) return false;
  const { x, y } = mouseCell(e);
  let b = btn;
  if (e.shiftKey) b |= 4;
  if (e.altKey) b |= 8;
  if (e.ctrlKey) b |= 16;
  if (grid.modes & MODE_SGR_MOUSE) {
    sendInput(`\x1b[<${b};${x};${y}${release ? 'm' : 'M'}`);
  } else {
    const enc = release ? 3 : b;
    if (x < 224 && y < 224) {
      sendInput('\x1b[M' + String.fromCharCode(32 + enc, 32 + x, 32 + y));
    }
  }
  return true;
}

let mouseButton = -1;
canvas.addEventListener('mousedown', (e) => {
  window.focus();
  // Local selection: plain drag when mouse reporting is off, shift+drag to override it.
  if (e.button === 0 && (e.shiftKey || !(grid.modes & MODE_MOUSE))) {
    e.preventDefault();
    clearSelection();
    const { x, y } = mouseCell(e);
    sel.active = true;
    sel.dragging = true;
    sel.startR = sel.endR = y - 1;
    sel.startC = sel.endC = x - 1;
    return;
  }
  clearSelection();
  if (sendMouse(e.button, e, false)) {
    mouseButton = e.button;
    e.preventDefault();
  }
});
canvas.addEventListener('mouseup', (e) => {
  if (sel.dragging) {
    sel.dragging = false;
    if (sel.startR === sel.endR && sel.startC === sel.endC) {
      clearSelection();
    } else {
      copySelection(); // copy-on-select
    }
    return;
  }
  if (sendMouse(e.button, e, true)) {
    mouseButton = -1;
    e.preventDefault();
  }
});
let lastMove = { x: -1, y: -1 };
canvas.addEventListener('mousemove', (e) => {
  if (sel.dragging) {
    const { x, y } = mouseCell(e);
    const r = y - 1, c = x - 1;
    if (r === sel.endR && c === sel.endC) return;
    const oldEnd = sel.endR;
    sel.endR = r;
    sel.endC = c;
    markRows(Math.min(sel.startR, oldEnd, r), Math.max(sel.startR, oldEnd, r));
    return;
  }
  const wantDrag = mouseButton >= 0 && (grid.modes & (MODE_MOUSE_DRAG | MODE_MOUSE_MOTION));
  const wantMotion = grid.modes & MODE_MOUSE_MOTION;
  if (!wantDrag && !wantMotion) return;
  const cell = mouseCell(e);
  if (cell.x === lastMove.x && cell.y === lastMove.y) return;
  lastMove = cell;
  const btn = mouseButton >= 0 ? mouseButton : 3;
  sendMouse(btn + 32, e, false);
});
canvas.addEventListener('dblclick', (e) => {
  if ((grid.modes & MODE_MOUSE) && !e.shiftKey) return;
  e.preventDefault();
  const { x, y } = mouseCell(e);
  const r = y - 1;
  const at = (c) => String.fromCodePoint(grid.cp[r * grid.cols + c] || 32);
  const isWord = (ch) => !/[\s|"'`()\[\]{}<>,;]/.test(ch);
  let c1 = x - 1, c2 = x - 1;
  if (!isWord(at(c1))) return;
  while (c1 > 0 && isWord(at(c1 - 1))) c1--;
  while (c2 < grid.cols - 1 && isWord(at(c2 + 1))) c2++;
  sel.active = true;
  sel.dragging = false;
  sel.startR = sel.endR = r;
  sel.startC = c1;
  sel.endC = c2;
  markRows(r, r);
  copySelection();
});
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const up = e.deltaY < 0;
  if (grid.modes & MODE_MOUSE) {
    sendMouse(up ? 64 : 65, e, false);
  } else if (grid.modes & MODE_ALT_SCREEN) {
    const seq = (grid.modes & MODE_APP_CURSOR)
      ? (up ? '\x1bOA' : '\x1bOB')
      : (up ? '\x1b[A' : '\x1b[B');
    sendInput(seq.repeat(3));
  }
}, { passive: false });
canvas.addEventListener('contextmenu', (e) => {
  if (grid.modes & MODE_MOUSE) e.preventDefault();
});

// ---- resize / focus ----
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    measureFont();
    sendResize();
  }, 120);
});
window.addEventListener('focus', () => { focused = true; if (haveFull) { dirtyRows.add(grid.curRow); schedulePaint(); } });
window.addEventListener('blur', () => { focused = false; if (haveFull) { dirtyRows.add(grid.curRow); schedulePaint(); } });

fitCanvas();
connect();
