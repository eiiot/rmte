use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;

use alacritty_terminal::event::{Event, EventListener};
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::cell::Flags;
use alacritty_terminal::term::{Config as TermConfig, Term, TermDamage, TermMode};
use alacritty_terminal::vte::ansi::Processor;
use bytes::{BufMut, Bytes, BytesMut};
use parking_lot::Mutex;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use tokio::sync::{broadcast, Notify};

use crate::palette;

pub const MSG_FRAME: u8 = 1;
pub const MSG_PONG: u8 = 2;
pub const MSG_CLOSED: u8 = 4;
pub const MSG_CLIPBOARD: u8 = 5;

pub const ATTR_BOLD: u16 = 1;
pub const ATTR_ITALIC: u16 = 2;
pub const ATTR_UNDERLINE: u16 = 4;
pub const ATTR_DIM: u16 = 8;
pub const ATTR_STRIKEOUT: u16 = 16;
pub const ATTR_WIDE: u16 = 32;
pub const ATTR_SPACER: u16 = 64;

pub const MODE_APP_CURSOR: u32 = 1;
pub const MODE_BRACKETED_PASTE: u32 = 2;
pub const MODE_MOUSE: u32 = 4;
pub const MODE_SGR_MOUSE: u32 = 8;
pub const MODE_MOUSE_MOTION: u32 = 16;
pub const MODE_ALT_SCREEN: u32 = 32;
pub const MODE_MOUSE_DRAG: u32 = 64;

#[derive(Clone)]
pub struct EventProxy {
    pty_writes: std::sync::mpsc::Sender<Vec<u8>>,
    frames: broadcast::Sender<Bytes>,
}

impl EventListener for EventProxy {
    fn send_event(&self, event: Event) {
        match event {
            Event::PtyWrite(text) => {
                let _ = self.pty_writes.send(text.into_bytes());
            }
            // OSC 52 from apps/tmux: forward to the browser clipboard.
            Event::ClipboardStore(_, text) => {
                let mut msg = BytesMut::with_capacity(1 + text.len());
                msg.put_u8(MSG_CLIPBOARD);
                msg.put_slice(text.as_bytes());
                let _ = self.frames.send(msg.freeze());
            }
            // OSC 52 read: we can't read the browser clipboard; reply empty.
            Event::ClipboardLoad(_, format) => {
                let _ = self.pty_writes.send(format("").into_bytes());
            }
            _ => {}
        }
    }
}

pub struct Engine {
    pub term: Mutex<Term<EventProxy>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    input_tx: std::sync::mpsc::Sender<Vec<u8>>,
    pub frames: broadcast::Sender<Bytes>,
    dirty: Notify,
    full_needed: AtomicBool,
    seq: AtomicU32,
    last_cursor: Mutex<(u16, u16)>,
}

impl Engine {
    pub fn spawn(tmux_args: Vec<String>, cols: u16, rows: u16) -> anyhow::Result<Arc<Engine>> {
        let pty_system = native_pty_system();
        let pair = pty_system.openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;

        let mut cmd = CommandBuilder::new("tmux");
        cmd.args(tmux_args.iter().map(|s| s.as_str()));
        cmd.env("TERM", "xterm-256color");
        let mut child = pair.slave.spawn_command(cmd)?;
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader()?;
        let mut writer = pair.master.take_writer()?;

        let (input_tx, input_rx) = std::sync::mpsc::channel::<Vec<u8>>();
        let (frames, _) = broadcast::channel(256);
        let proxy = EventProxy {
            pty_writes: input_tx.clone(),
            frames: frames.clone(),
        };

        let config = TermConfig {
            scrolling_history: 0,
            ..Default::default()
        };
        let size = alacritty_terminal::term::test::TermSize::new(cols as usize, rows as usize);
        let term = Term::new(config, &size, proxy);

        let engine = Arc::new(Engine {
            term: Mutex::new(term),
            master: Mutex::new(pair.master),
            input_tx,
            frames,
            dirty: Notify::new(),
            full_needed: AtomicBool::new(false),
            seq: AtomicU32::new(0),
            last_cursor: Mutex::new((0, 0)),
        });

        // PTY writer thread: browser input + terminal query replies (DSR etc.)
        std::thread::spawn(move || {
            while let Ok(data) = input_rx.recv() {
                if writer.write_all(&data).is_err() {
                    break;
                }
                let _ = writer.flush();
            }
        });

        // PTY reader thread: bytes -> emulator, then wake the render loop.
        let reader_engine = engine.clone();
        std::thread::spawn(move || {
            let mut parser: Processor = Processor::new();
            let mut buf = [0u8; 65536];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        {
                            let mut term = reader_engine.term.lock();
                            parser.advance(&mut *term, &buf[..n]);
                        }
                        reader_engine.dirty.notify_one();
                    }
                }
            }
            let _ = child.wait();
            let mut msg = BytesMut::with_capacity(1);
            msg.put_u8(MSG_CLOSED);
            let _ = reader_engine.frames.send(msg.freeze());
            tracing::info!("tmux client exited");
        });

        // Render loop: coalesce damage into at most one frame per ~2ms.
        let render_engine = engine.clone();
        tokio::spawn(async move {
            loop {
                render_engine.dirty.notified().await;
                tokio::time::sleep(std::time::Duration::from_millis(2)).await;
                let full = render_engine.full_needed.swap(false, Ordering::Relaxed);
                let frame = render_engine.build_frame(full);
                let _ = render_engine.frames.send(frame);
            }
        });

        Ok(engine)
    }

    pub fn request_full(&self) {
        self.full_needed.store(true, Ordering::Relaxed);
        self.dirty.notify_one();
    }

    pub fn write_input(&self, data: &[u8]) {
        let _ = self.input_tx.send(data.to_vec());
    }

    pub fn resize(&self, cols: u16, rows: u16) {
        let cols = cols.clamp(10, 500);
        let rows = rows.clamp(4, 300);
        {
            let mut term = self.term.lock();
            let size =
                alacritty_terminal::term::test::TermSize::new(cols as usize, rows as usize);
            term.resize(size);
        }
        let _ = self.master.lock().resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        });
        self.request_full();
    }

    pub fn screen_text(&self) -> String {
        let term = self.term.lock();
        let cols = term.columns();
        let rows = term.screen_lines();
        let mut out = String::new();
        for r in 0..rows {
            for c in 0..cols {
                let cell = &term.grid()[Line(r as i32)][Column(c)];
                if !cell.flags.contains(Flags::WIDE_CHAR_SPACER) {
                    out.push(cell.c);
                }
            }
            while out.ends_with(' ') {
                out.pop();
            }
            out.push('\n');
        }
        out
    }

    fn build_frame(&self, full: bool) -> Bytes {
        let mut term = self.term.lock();
        let cols = term.columns();
        let rows = term.screen_lines();

        // row -> (left, right), merged
        let mut damage: BTreeMap<u16, (u16, u16)> = BTreeMap::new();
        let mut add = |row: usize, left: usize, right: usize| {
            if row >= rows {
                return;
            }
            let right = right.min(cols.saturating_sub(1));
            let e = damage.entry(row as u16).or_insert((left as u16, right as u16));
            e.0 = e.0.min(left as u16);
            e.1 = e.1.max(right as u16);
        };

        let mut is_full = full;
        if !is_full {
            let mut bounds = Vec::new();
            match term.damage() {
                TermDamage::Full => is_full = true,
                TermDamage::Partial(iter) => {
                    for b in iter {
                        bounds.push((b.line, b.left, b.right));
                    }
                }
            }
            for (line, left, right) in bounds {
                add(line, left, right);
            }
        }
        term.reset_damage();

        if is_full {
            damage.clear();
            for r in 0..rows {
                damage.insert(r as u16, (0, cols.saturating_sub(1) as u16));
            }
        }

        // Cursor movement dirties old + new cell rows even without content damage.
        let cursor = term.grid().cursor.point;
        let (cur_row, cur_col) = (cursor.line.0.max(0) as u16, cursor.column.0 as u16);
        {
            let mut last = self.last_cursor.lock();
            if *last != (cur_row, cur_col) && !is_full {
                let (lr, lc) = *last;
                let e = damage.entry(lr).or_insert((lc, lc));
                e.0 = e.0.min(lc);
                e.1 = e.1.max(lc);
                let e = damage.entry(cur_row).or_insert((cur_col, cur_col));
                e.0 = e.0.min(cur_col);
                e.1 = e.1.max(cur_col);
            }
            *last = (cur_row, cur_col);
        }

        let mode = term.mode();
        let mut modes: u32 = 0;
        if mode.contains(TermMode::APP_CURSOR) {
            modes |= MODE_APP_CURSOR;
        }
        if mode.contains(TermMode::BRACKETED_PASTE) {
            modes |= MODE_BRACKETED_PASTE;
        }
        if mode.intersects(
            TermMode::MOUSE_REPORT_CLICK | TermMode::MOUSE_DRAG | TermMode::MOUSE_MOTION,
        ) {
            modes |= MODE_MOUSE;
        }
        if mode.contains(TermMode::SGR_MOUSE) {
            modes |= MODE_SGR_MOUSE;
        }
        if mode.contains(TermMode::MOUSE_MOTION) {
            modes |= MODE_MOUSE_MOTION;
        }
        if mode.contains(TermMode::ALT_SCREEN) {
            modes |= MODE_ALT_SCREEN;
        }
        if mode.contains(TermMode::MOUSE_DRAG) {
            modes |= MODE_MOUSE_DRAG;
        }
        let cursor_visible = mode.contains(TermMode::SHOW_CURSOR);

        let seq = self.seq.fetch_add(1, Ordering::Relaxed) + 1;

        let mut buf = BytesMut::with_capacity(64 + damage.len() * 64);
        buf.put_u8(MSG_FRAME);
        buf.put_u8(if is_full { 1 } else { 0 });
        buf.put_u32_le(seq);
        buf.put_u16_le(cols as u16);
        buf.put_u16_le(rows as u16);
        buf.put_u16_le(cur_row);
        buf.put_u16_le(cur_col);
        buf.put_u8(cursor_visible as u8);
        buf.put_u32_le(modes);
        buf.put_u16_le(damage.len() as u16);

        for (&row, &(left, right)) in &damage {
            buf.put_u16_le(row);
            buf.put_u16_le(left);
            let count_pos = buf.len();
            buf.put_u16_le(0); // record count, patched below

            let mut records: u16 = 0;
            let mut prev: Option<(u32, u32, u32, u16, usize)> = None; // cp,fg,bg,attr,repeat_pos
            for c in (left as usize)..=(right as usize) {
                let cell = &term.grid()[Line(row as i32)][Column(c)];
                let f = cell.flags;
                let mut attr: u16 = 0;
                if f.contains(Flags::BOLD) {
                    attr |= ATTR_BOLD;
                }
                if f.contains(Flags::ITALIC) {
                    attr |= ATTR_ITALIC;
                }
                if f.intersects(Flags::UNDERLINE | Flags::DOUBLE_UNDERLINE) {
                    attr |= ATTR_UNDERLINE;
                }
                if f.contains(Flags::DIM) {
                    attr |= ATTR_DIM;
                }
                if f.contains(Flags::STRIKEOUT) {
                    attr |= ATTR_STRIKEOUT;
                }
                if f.contains(Flags::WIDE_CHAR) {
                    attr |= ATTR_WIDE;
                }
                if f.contains(Flags::WIDE_CHAR_SPACER) {
                    attr |= ATTR_SPACER;
                }
                let mut fg = palette::resolve(cell.fg, true);
                let mut bg = palette::resolve(cell.bg, false);
                if f.contains(Flags::INVERSE) {
                    std::mem::swap(&mut fg, &mut bg);
                }
                let cp = if f.contains(Flags::HIDDEN) {
                    ' ' as u32
                } else {
                    cell.c as u32
                };

                match prev {
                    Some((pcp, pfg, pbg, pattr, rpos))
                        if (pcp, pfg, pbg, pattr) == (cp, fg, bg, attr)
                            && buf[rpos] < 255 =>
                    {
                        buf[rpos] += 1;
                    }
                    _ => {
                        let rpos = buf.len();
                        buf.put_u8(1);
                        buf.put_u32_le(cp);
                        buf.put_u32_le(fg);
                        buf.put_u32_le(bg);
                        buf.put_u16_le(attr);
                        records += 1;
                        prev = Some((cp, fg, bg, attr, rpos));
                    }
                }
            }
            let count_bytes = records.to_le_bytes();
            buf[count_pos] = count_bytes[0];
            buf[count_pos + 1] = count_bytes[1];
        }

        buf.freeze()
    }
}
