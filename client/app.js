'use strict';

// ---- protocol constants (keep in sync with server/src/engine.rs) ----
const MSG_HELLO = 0, MSG_FRAME = 1, MSG_PONG = 2, MSG_CLOSED = 4, MSG_CLIPBOARD = 5;
const IN_INPUT = 1, IN_RESIZE = 2, IN_PING = 3;
const ATTR_BOLD = 1, ATTR_ITALIC = 2, ATTR_UNDERLINE = 4, ATTR_DIM = 8,
      ATTR_STRIKEOUT = 16, ATTR_WIDE = 32, ATTR_SPACER = 64;
const MODE_APP_CURSOR = 1, MODE_BRACKETED_PASTE = 2, MODE_MOUSE = 4,
      MODE_SGR_MOUSE = 8, MODE_MOUSE_MOTION = 16, MODE_ALT_SCREEN = 32,
      MODE_MOUSE_DRAG = 64;

const params = new URLSearchParams(location.search);
const simLag = Math.max(0, +(params.get('lag') || 0)); // simulated extra RTT, ms
const SESSION = params.get('session'); // null = server default
let readOnly = ['1', 'true'].includes(params.get('ro')); // confirmed by server hello
let sessionName = SESSION || '';

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
    predictReset(); // mosh resets all predictions on resize
  },
};

// ---- prediction engine: port of mosh's frontend/terminaloverlay.cc ----
// Row overlays: each predicted row is a full array of conditional cells.
// Typing inserts (shifting the rest of the row right); backspace shifts the
// rest of the row left; boundary cells whose contents we can't know are
// marked `unknown` and never validate or kill (mosh's model — this is what
// makes delete instant and prevents stale echoes from ghosting back).
// Validation is ack-gated (mosh's late_ack): a cell is judged only against
// frames whose input-ack covers the keystroke that made it, plus a small
// grace because our ack means "reached the pty", not "echoed".
//
// Deliberate display deviation from stock mosh (user preference): cells
// render one epoch past the confirmed epoch, underlined until confirmed,
// instead of hiding a fresh epoch for a full round-trip.
const SRTT_TRIGGER_LOW = 20, SRTT_TRIGGER_HIGH = 30;   // gate on send_interval ≈ srtt/2
const FLAG_TRIGGER_LOW = 50, FLAG_TRIGGER_HIGH = 80;
const GLITCH_THRESHOLD = 250, GLITCH_FLAG_THRESHOLD = 5000;
const GLITCH_REPAIR_COUNT = 10, GLITCH_REPAIR_MININTERVAL = 150;
const ACK_ECHO_GRACE = 150;

const predict = {
  mode: ['adaptive', 'always', 'never'].includes(params.get('predict')) ? params.get('predict') : 'adaptive',
  overlays: new Map(),   // rowNum -> array[cols] of conditional overlay cells
  cursors: [],           // {row, col, tue, expirationSeq, ackedAt, predictionTime}
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
  updateTriggers();
}

// trigger hysteresis; mosh gates on send_interval ≈ srtt/2
function updateTriggers() {
  const sendInterval = predict.srtt == null ? 0 : predict.srtt / 2;
  if (sendInterval > SRTT_TRIGGER_HIGH) predict.srttTrigger = true;
  else if (predict.srttTrigger && sendInterval <= SRTT_TRIGGER_LOW && !anyPending()) predict.srttTrigger = false;
  if (sendInterval > FLAG_TRIGGER_HIGH) predict.flagging = true;
  else if (sendInterval <= FLAG_TRIGGER_LOW) predict.flagging = false;
  if (predict.glitchTrigger > GLITCH_REPAIR_COUNT) predict.flagging = true;
}

function predictPendingCount() {
  let n = 0;
  for (const row of predict.overlays.values()) {
    for (const c of row) if (c.active) n += 1;
  }
  return n;
}

function anyPending() {
  return predictPendingCount() > 0 || predict.cursors.length > 0;
}

function freshCell(col) {
  return {
    col, active: false, unknown: false, cp: 32, fg: 0xd4d4d4, bg: 0x121212,
    tue: 0, expirationSeq: 0, ackedAt: 0, predictionTime: 0, origCps: [],
  };
}

function getOrMakeRow(rowNum) {
  let row = predict.overlays.get(rowNum);
  if (!row || row.length !== grid.cols) {
    row = Array.from({ length: grid.cols }, (_, i) => freshCell(i));
    predict.overlays.set(rowNum, row);
  }
  return row;
}

function becomeTentative() {
  predict.predictionEpoch += 1;
}

function predictDirty() {
  for (const rowNum of predict.overlays.keys()) dirtyRows.add(rowNum);
  for (const cur of predict.cursors) dirtyRows.add(cur.row);
  dirtyRows.add(grid.curRow);
  schedulePaint();
}

function predictReset() {
  const hadState = anyPending();
  predictDirty();
  predict.overlays.clear();
  predict.cursors = [];
  // only start a new epoch if there was state to invalidate; a no-op reset
  // (e.g. the initial resize) must not push fresh predictions out of the
  // display grace window
  if (hadState) becomeTentative();
}

function resetCell(cell) {
  cell.active = false;
  cell.unknown = false;
  cell.origCps = [];
}

function lastCursor() {
  return predict.cursors.length ? predict.cursors[predict.cursors.length - 1] : null;
}

function displayedCursor() {
  const pcur = predictActive() ? lastCursor() : null;
  if (pcur) return { row: pcur.row, col: pcur.col, tentative: pcur.tue > predict.confirmedEpoch };
  return { row: grid.curRow, col: grid.curCol, tentative: false };
}

// what the user actually sees at (r,c): the prediction overlay composited
// over server truth — selection/copy must read this, not just the grid
function displayedCp(r, c) {
  if (predictActive()) {
    const orow = predict.overlays.get(r);
    const p = orow && orow[c];
    if (p && p.active && !p.unknown && p.tue <= predict.confirmedEpoch + 1) return p.cp;
  }
  return grid.cp[r * grid.cols + c];
}

function pushCursorPrediction(row, col, seq) {
  predict.cursors.push({
    row, col, tue: predict.predictionEpoch,
    expirationSeq: seq, ackedAt: 0, predictionTime: performance.now(),
  });
  dirtyRows.add(row);
  schedulePaint();
}

function initCursor(seq) {
  const cur = lastCursor();
  if (!cur) {
    pushCursorPrediction(grid.curRow, grid.curCol, seq);
  } else if (cur.tue !== predict.predictionEpoch) {
    pushCursorPrediction(cur.row, cur.col, seq);
  }
}

function killEpoch(epoch) {
  predictDirty();
  predict.cursors = predict.cursors.filter((c) => c.tue < epoch);
  pushCursorPrediction(grid.curRow, grid.curCol, inputSeq); // snap to server truth
  for (const row of predict.overlays.values()) {
    for (const cell of row) {
      if (cell.active && cell.tue >= epoch) resetCell(cell);
    }
  }
  becomeTentative();
}

function gridCp(r, c) { return grid.cp[r * grid.cols + c]; }
function gridFg(r, c) { return grid.fg[r * grid.cols + c]; }
function gridBg(r, c) { return grid.bg[r * grid.cols + c]; }

// rough single-width check (mosh predicts only wcwidth == 1 characters)
function isNarrow(cp) {
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return false;
  if (cp >= 0x1100 && (
    cp <= 0x115f || cp === 0x2329 || cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) ||
    cp >= 0x1f300)) return false;
  return true;
}

function stampCell(cell, seq, now) {
  if (!cell.active) cell.origCps = [];
  cell.active = true;
  cell.tue = predict.predictionEpoch;
  cell.expirationSeq = seq;
  cell.ackedAt = 0;
  cell.predictionTime = now;
}

function newlineCarriageReturn(seq) {
  initCursor(seq);
  const cur = lastCursor();
  dirtyRows.add(cur.row);
  cur.col = 0;
  cur.expirationSeq = seq;
  cur.ackedAt = 0;
  // mosh doesn't predict the scroll on the last row; neither do we
  if (cur.row < grid.rows - 1) cur.row += 1;
  dirtyRows.add(cur.row);
  schedulePaint();
}

function predictInput(str, seq) {
  if (predict.mode === 'never' || !haveFull) return;
  const now = performance.now();

  // left/right arrows are predicted cursor moves (mosh: CSI C / CSI D)
  if (str === '\x1b[C' || str === '\x1bOC' || str === '\x1b[D' || str === '\x1bOD') {
    initCursor(seq);
    const cur = lastCursor();
    const dc = str.endsWith('C') ? 1 : -1;
    if ((dc > 0 && cur.col < grid.cols - 1) || (dc < 0 && cur.col > 0)) {
      dirtyRows.add(cur.row);
      cur.col += dc;
      cur.expirationSeq = seq;
      cur.ackedAt = 0;
      schedulePaint();
    }
    return;
  }
  if (str.length > 1 && str.charCodeAt(0) === 0x1b) { // other escape sequence
    becomeTentative();
    return;
  }

  for (const ch of str) {
    const cp = ch.codePointAt(0);

    if (cp === 0x7f) { // backspace: shift the rest of the row left (mosh model)
      initCursor(seq);
      const cur = lastCursor();
      if (cur.row >= grid.rows) { becomeTentative(); continue; }
      const row = getOrMakeRow(cur.row);
      if (cur.col > 0) {
        cur.col -= 1;
        cur.expirationSeq = seq;
        cur.ackedAt = 0;
        for (let i = cur.col; i < grid.cols; i++) {
          const cell = row[i];
          stampCell(cell, seq, now);
          cell.origCps.push(gridCp(cur.row, i));
          if (i + 2 < grid.cols) {
            const next = row[i + 1];
            if (next.active) {
              cell.unknown = next.unknown;
              if (!next.unknown) { cell.cp = next.cp; cell.fg = next.fg; cell.bg = next.bg; }
            } else {
              cell.unknown = false;
              cell.cp = gridCp(cur.row, i + 1);
              cell.fg = gridFg(cur.row, i + 1);
              cell.bg = gridBg(cur.row, i + 1);
            }
          } else {
            cell.unknown = true;
          }
        }
        dirtyRows.add(cur.row);
        schedulePaint();
      }
      continue;
    }

    if (cp === 0x0d) { // CR
      becomeTentative();
      newlineCarriageReturn(seq);
      continue;
    }

    if (!isNarrow(cp)) { // control chars and wide chars: unknown effect
      becomeTentative();
      continue;
    }

    // printable single-width char: insert with shift-right (mosh model)
    initCursor(seq);
    const cur = lastCursor();
    if (cur.row >= grid.rows || cur.col >= grid.cols) { becomeTentative(); continue; }
    const row = getOrMakeRow(cur.row);
    if (cur.col + 1 >= grid.cols) becomeTentative(); // last column is tricky

    for (let i = grid.cols - 1; i > cur.col; i--) {
      const cell = row[i];
      stampCell(cell, seq, now);
      cell.origCps.push(gridCp(cur.row, i));
      if (i === grid.cols - 1) {
        cell.unknown = true;
      } else {
        const prev = row[i - 1];
        if (prev.active) {
          cell.unknown = prev.unknown;
          if (!prev.unknown) { cell.cp = prev.cp; cell.fg = prev.fg; cell.bg = prev.bg; }
        } else {
          cell.unknown = false;
          cell.cp = gridCp(cur.row, i - 1);
          cell.fg = gridFg(cur.row, i - 1);
          cell.bg = gridBg(cur.row, i - 1);
        }
      }
    }

    const cell = row[cur.col];
    stampCell(cell, seq, now);
    cell.unknown = false;
    cell.origCps.push(gridCp(cur.row, cur.col));
    cell.cp = cp;
    // heuristic (mosh): match renditions of the character to the left
    if (cur.col > 0) {
      const prev = row[cur.col - 1];
      if (prev.active && !prev.unknown) { cell.fg = prev.fg; cell.bg = prev.bg; }
      else { cell.fg = gridFg(cur.row, cur.col - 1); cell.bg = gridBg(cur.row, cur.col - 1); }
    } else {
      cell.fg = gridFg(cur.row, cur.col); cell.bg = gridBg(cur.row, cur.col);
    }
    dirtyRows.add(cur.row);

    cur.expirationSeq = seq;
    cur.ackedAt = 0;
    if (cur.col < grid.cols - 1) {
      cur.col += 1;
    } else {
      becomeTentative();
      newlineCarriageReturn(seq);
    }
    schedulePaint();
  }
}

// mosh Validity: pending / correct / correct-nocredit / incorrect.
// Asymmetric grace: a match confirms as soon as the ack covers it (the ack
// frame usually IS the echo frame), but declaring a prediction *wrong* waits
// ACK_ECHO_GRACE past the ack, because our ack means "reached the pty" and
// the echo can trail it by a beat.
function cellValidity(cell, rowNum, ackSeq, now, grace) {
  if (!cell.active) return 'inactive';
  if (rowNum >= grid.rows || cell.col >= grid.cols) return 'incorrect';
  if (ackSeq != null && !cell.ackedAt && ackSeq >= cell.expirationSeq) cell.ackedAt = now;
  if (!cell.ackedAt) return 'pending';
  if (cell.unknown) return 'correct-nocredit';
  if (cell.cp === 32) return 'correct-nocredit'; // blank: "too easy for this to trigger falsely"
  if (gridCp(rowNum, cell.col) === cell.cp) {
    return cell.origCps.includes(cell.cp) ? 'correct-nocredit' : 'correct';
  }
  if (now - cell.ackedAt < grace) return 'pending';
  return 'incorrect';
}

function reconcilePredictions(ackSeq, fullRedraw) {
  const now = performance.now();
  updateTriggers();
  // A full server redraw (clear, alt-screen switch, resync) is a complete
  // statement of the screen: anything it acks but contradicts is judged with
  // zero grace, so ghosts vanish with the redraw instead of lingering.
  const grace = fullRedraw ? 0 : ACK_ECHO_GRACE;

  for (const [rowNum, row] of predict.overlays) {
    if (rowNum >= grid.rows) { predict.overlays.delete(rowNum); continue; }
    for (const cell of row) {
      switch (cellValidity(cell, rowNum, ackSeq, now, grace)) {
        case 'incorrect':
          if (cell.tue > predict.confirmedEpoch) {
            killEpoch(cell.tue); // cull only the tentative epoch
          } else {
            predictReset(); // a confirmed-epoch prediction was wrong: start over
            return;
          }
          break;
        case 'correct':
          if (cell.tue > predict.confirmedEpoch) {
            predict.confirmedEpoch = cell.tue;
            predictDirty(); // may unhide siblings from the same epoch
          }
          if (now - cell.predictionTime < GLITCH_THRESHOLD &&
              predict.glitchTrigger > 0 &&
              now - predict.lastQuickConfirmation >= GLITCH_REPAIR_MININTERVAL) {
            predict.glitchTrigger -= 1;
            predict.lastQuickConfirmation = now;
          }
          { // mosh: match the rest of the row to the actual renditions
            const fg = gridFg(rowNum, cell.col), bg = gridBg(rowNum, cell.col);
            for (let k = cell.col; k < grid.cols; k++) {
              if (row[k].active) { row[k].fg = fg; row[k].bg = bg; }
            }
          }
          dirtyRows.add(rowNum);
          resetCell(cell);
          break;
        case 'correct-nocredit':
          dirtyRows.add(rowNum);
          resetCell(cell);
          break;
        case 'pending':
          // long-outstanding predictions force display (and eventually underline)
          if (now - cell.predictionTime >= GLITCH_FLAG_THRESHOLD) {
            predict.glitchTrigger = GLITCH_REPAIR_COUNT * 2;
          } else if (now - cell.predictionTime >= GLITCH_THRESHOLD &&
                     predict.glitchTrigger < GLITCH_REPAIR_COUNT) {
            predict.glitchTrigger = GLITCH_REPAIR_COUNT;
          }
          break;
      }
    }
  }

  // cursor: judge only the latest; an acked mismatch resets everything (mosh)
  const cur = lastCursor();
  if (cur) {
    if (ackSeq != null && !cur.ackedAt && ackSeq >= cur.expirationSeq) cur.ackedAt = now;
    if (cur.ackedAt && cur.row === grid.curRow && cur.col === grid.curCol) {
      dirtyRows.add(cur.row);
      predict.cursors = []; // settled and correct: server truth takes over
    } else if (cur.ackedAt && now - cur.ackedAt >= grace) {
      predictReset();
      return;
    } else {
      // drop older settled cursors, keep the pending chain
      predict.cursors = predict.cursors.filter((c, i) =>
        i === predict.cursors.length - 1 || !c.ackedAt);
    }
  }
  schedulePaint();
}

// judgments that need wall-clock time (echo grace elapsing, no-echo contexts
// like password prompts) can't rely on a next frame arriving — re-reconcile
// periodically and expire predictions that outlive any plausible echo
setInterval(() => {
  if (anyPending()) reconcilePredictions(null);
  const now = performance.now();
  const limit = Math.max(2 * (predict.srtt || 100), 500) + GLITCH_THRESHOLD;
  let oldest = null;
  for (const row of predict.overlays.values()) {
    for (const c of row) {
      if (c.active && (oldest == null || c.predictionTime < oldest.predictionTime)) oldest = c;
    }
  }
  if (oldest && now - oldest.predictionTime > limit) {
    killEpoch(oldest.tue);
  } else if (!oldest && predict.cursors.length && now - lastCursor().predictionTime > limit) {
    predictDirty();
    predict.cursors = [];
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
      line += String.fromCodePoint(displayedCp(r, c) || 32);
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

  // prediction overlay: mosh paints only cells whose replacement differs
  // from the framebuffer. Underline marks flagging (mosh) or unconfirmed
  // (our deviation: cells show one epoch past confirmed instead of hiding).
  if (predictActive()) {
    const orow = predict.overlays.get(r);
    if (orow) {
      for (let c = 0; c < grid.cols; c++) {
        const p = orow[c];
        if (!p.active || p.unknown || p.tue > predict.confirmedEpoch + 1) continue;
        const i = base + c;
        if (p.cp === grid.cp[i] && p.fg === grid.fg[i] && p.bg === grid.bg[i]) continue;
        const x = c * cellW;
        ctx.fillStyle = color(p.bg);
        ctx.fillRect(x, y, cellW, cellH);
        ctx.font = `${FONT_SIZE}px ${FONT_STACK}`;
        ctx.fillStyle = color(p.fg);
        if (p.cp > 32) ctx.fillText(String.fromCodePoint(p.cp), x, y + baseline, cellW);
        if (predict.flagging || p.tue > predict.confirmedEpoch) {
          ctx.fillRect(x, y + cellH - 2, cellW, 1);
        }
      }
    }
  }

  // cursor overlay: predicted position while predictions are in flight
  // (outline while the epoch is tentative, solid once confirmed) — the
  // displayed cursor never snaps back to a stale server position
  const dc = displayedCursor();
  const tentativeCursor = dc.tentative;
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
  if (type === MSG_HELLO) {
    // [version][flags][utf8 session name]
    const flags = v.getUint8(2);
    readOnly = !!(flags & 1);
    if (readOnly) predict.mode = 'never';
    sessionName = new TextDecoder().decode(new Uint8Array(buf, 3));
    document.title = `${sessionName}${readOnly ? ' (read-only)' : ''} — rmte`;
    updateHud();
    return;
  }
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
  // a clear/alt-screen switch may arrive as all-rows partial damage rather
  // than a flagged full frame — treat a near-total redraw the same way
  const redraw = full || lineCount >= Math.max(4, Math.floor(grid.rows * 0.8));
  reconcilePredictions(ack, redraw);
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
  const wsParams = new URLSearchParams();
  if (SESSION) wsParams.set('session', SESSION);
  if (readOnly) wsParams.set('ro', '1');
  const qs = wsParams.toString();
  ws = new WebSocket(`${proto}://${location.host}/ws${qs ? '?' + qs : ''}`);
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
  if (readOnly) return 0;
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
  if (readOnly) return;
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
  if (sessionName) parts.unshift(sessionName);
  if (readOnly) parts.push('read-only');
  if (simLag) parts.push(`+${simLag}ms lag`);
  if (!readOnly && predict.mode !== 'adaptive') parts.push(`pred:${predict.mode}`);
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
    // the engine routes everything like mosh's new_user_byte: printables
    // insert, backspace shifts left, CR predicts the newline, left/right
    // arrows move the predicted cursor, everything else becomes tentative
    predictInput(seq, s);
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
  const at = (c) => String.fromCodePoint(displayedCp(r, c) || 32);
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
