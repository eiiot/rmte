# tachyon

Fast tmux streaming to the browser. The goal is for a remote tmux session to
feel like a local terminal — mosh-grade responsiveness, in a browser tab.

```
tmux ⇄ PTY ⇄ [ tachyon: alacritty emulation → damage diffs → frames ] ⇄ WebSocket ⇄ canvas client
```

## Why it's fast

- **Server-side terminal emulation.** A PTY runs `tmux attach`; the byte
  stream feeds [alacritty_terminal] in-process. The browser never parses an
  escape code.
- **State sync, not byte sync.** Only damaged cells ship, run-length encoded,
  coalesced to at most one frame per ~2ms. A `seq 300000` flood reaches the
  client as a bounded stream of small diffs (~270KB instead of ~2MB) — output
  volume cannot clog the pipe.
- **Local echo prediction**, ported from mosh's `terminaloverlay.cc` row-overlay
  engine: epochs, adaptive activation, flagging underlines, insert/backspace
  row shifts, ack-gated validation. Typing feels instant at any RTT.
- **Dependency-free canvas client.** One JS file. No xterm.js, no framework,
  no build step. Mode-aware keyboard/mouse/paste (app cursor keys, bracketed
  paste, SGR mouse, alt-screen wheel), text selection with copy-on-select,
  OSC 52 clipboard passthrough.

## Usage

```sh
cargo build --release
./target/release/tachyon --session main --port 7861
# open http://localhost:7861
```

- `?session=<name>` — attach to (or create) a specific tmux session; engines
  spawn lazily per session
- `?ro=1` — read-only connection (input and resize ignored server-side)
- `?lag=150` — simulate 150ms of extra RTT to feel the prediction engine work
- `?predict=always|adaptive|never` — prediction display mode (default
  adaptive, like mosh)

The RTT / session / prediction status HUD lives in the bottom-right corner.

## Protocol

Binary WebSocket protocol, documented in [PROTOCOL.md](PROTOCOL.md). Both
directions are opaque bytes end-to-end, so an authenticated relay or tunnel
can sit in the middle without understanding the contents. Tachyon itself does
no auth — bind it to localhost and put your auth layer in front.

## Tests

Node ≥ 22 and Playwright (for the browser tests):

```sh
node test/e2e.mjs        # keystroke -> frame latency through the full stack
node test/flood.mjs      # output flood coalescing
node test/clip.mjs       # OSC 52 clipboard passthrough
node test/sessions.mjs   # multi-session isolation + read-only enforcement
node test/predict.mjs    # prediction engine semantics under 300ms lag
node test/cursor.mjs     # displayed cursor never moves backward under lag
node test/clear.mjs      # prediction ghosts don't outlive a screen clear
node test/copy-predicted.mjs  # selection copies the displayed (predicted) screen
```

## License

GPL-3.0-or-later. The client's prediction engine is a JavaScript port of the
prediction engine in [mosh] (`src/frontend/terminaloverlay.cc`, GPL-3.0),
Copyright Keith Winstein and the mosh contributors; the port keeps their
algorithms, constants, and validation semantics. Server and protocol design
also draw on mosh's State Synchronization Protocol ideas and on [sshx] for
prior art.

[alacritty_terminal]: https://crates.io/crates/alacritty_terminal
[mosh]: https://github.com/mobile-shell/mosh
[sshx]: https://github.com/ekzhang/sshx
