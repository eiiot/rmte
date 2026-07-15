'use strict';

// ---- protocol constants (keep in sync with server/src/engine.rs) ----
const MSG_FRAME = 1, MSG_PONG = 2, MSG_CLOSED = 4;
const IN_INPUT = 1, IN_RESIZE = 2, IN_PING = 3;
const ATTR_BOLD = 1, ATTR_ITALIC = 2, ATTR_UNDERLINE = 4, ATTR_DIM = 8,
      ATTR_STRIKEOUT = 16, ATTR_WIDE = 32, ATTR_SPACER = 64;
const MODE_APP_CURSOR = 1, MODE_BRACKETED_PASTE = 2, MODE_MOUSE = 4,
      MODE_SGR_MOUSE = 8, MODE_MOUSE_MOTION = 16, MODE_ALT_SCREEN = 32,
      MODE_MOUSE_DRAG = 64;

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
  },
};

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

  // background runs
  let runStart = 0, runBg = grid.bg[base];
  for (let c = 1; c <= grid.cols; c++) {
    const bg = c < grid.cols ? grid.bg[base + c] : -1;
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

  // cursor overlay
  if (grid.curVisible && grid.curRow === r && grid.curCol < grid.cols) {
    const i = base + grid.curCol;
    const x = grid.curCol * cellW;
    if (focused) {
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
    updateHud();
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
  ws.onmessage = (ev) => applyFrame(ev.data);
  ws.onclose = () => {
    connected = false;
    hud.textContent = 'reconnecting…';
    hud.classList.add('bad');
    setTimeout(connect, 500);
  };
}

function send(bytes) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(bytes);
}

const utf8 = new TextEncoder();
function sendInput(str) {
  const payload = utf8.encode(str);
  const msg = new Uint8Array(1 + payload.length);
  msg[0] = IN_INPUT;
  msg.set(payload, 1);
  send(msg);
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
  hud.textContent = `${ms}ms · ${grid.cols}×${grid.rows}`;
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

window.addEventListener('keydown', (e) => {
  if (e.metaKey) return; // cmd combos stay with the browser
  const seq = encodeKey(e);
  if (seq !== null) {
    e.preventDefault();
    sendInput(seq);
  }
});

window.addEventListener('paste', (e) => {
  const text = e.clipboardData.getData('text');
  if (!text) return;
  e.preventDefault();
  if (grid.modes & MODE_BRACKETED_PASTE) {
    sendInput('\x1b[200~' + text + '\x1b[201~');
  } else {
    sendInput(text);
  }
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
  if (sendMouse(e.button, e, false)) {
    mouseButton = e.button;
    e.preventDefault();
  }
});
canvas.addEventListener('mouseup', (e) => {
  if (sendMouse(e.button, e, true)) {
    mouseButton = -1;
    e.preventDefault();
  }
});
let lastMove = { x: -1, y: -1 };
canvas.addEventListener('mousemove', (e) => {
  const wantDrag = mouseButton >= 0 && (grid.modes & (MODE_MOUSE_DRAG | MODE_MOUSE_MOTION));
  const wantMotion = grid.modes & MODE_MOUSE_MOTION;
  if (!wantDrag && !wantMotion) return;
  const cell = mouseCell(e);
  if (cell.x === lastMove.x && cell.y === lastMove.y) return;
  lastMove = cell;
  const btn = mouseButton >= 0 ? mouseButton : 3;
  sendMouse(btn + 32, e, false);
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
