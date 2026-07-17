# Rmte wire protocol — version 1

Rmte speaks a compact binary protocol over a single WebSocket. All integers
are **little-endian**. The protocol is deliberately transport-agnostic: both
directions are opaque byte messages, so any relay that can move binary
WebSocket frames (a reverse proxy, an authenticated router, a tunnel) can sit
between the client and the server without understanding the contents.

## Listening

By default rmte serves HTTP + WebSocket on a TCP port (`--port`, `--bind`).
For embedding behind an auth layer on the same host, `--listen unix:<path>`
serves on a Unix domain socket created with 0600 permissions instead: no TCP
port is opened and only the owning user can connect, so the OS filesystem
permissions are the access control. rmte itself performs no authentication in
either mode — bind it privately and put your auth layer in front.

## Connection

```
GET /ws[?session=<name>][&ro=1]   (WebSocket upgrade)
```

- `session` — tmux session name to attach to (created via `tmux new-session -A`
  if it doesn't exist). Must match `[A-Za-z0-9._-]{1,64}`. Defaults to the
  server's `--session` value.
- `ro` — `1` or `true` makes the connection **read-only**: the server ignores
  `input` and `resize` messages from it. Read-only is a property of the
  connection, chosen by whoever establishes it; an auth layer in front of
  rmte decides which clients may open writable connections.

Multiple simultaneous connections to one session mirror the same screen
(equivalent to two `tmux attach`es). The most recent `resize` from any
writable connection wins.

A second endpoint, `GET /text[?session=<name>]`, returns the current screen as
plain text — useful for tests and health checks.

## Server → client messages

First byte of every message is the type.

### 0 — hello (sent once, immediately after upgrade)

| field   | type | notes                              |
|---------|------|------------------------------------|
| type    | u8   | `0`                                |
| version | u8   | protocol version, currently `1`    |
| flags   | u8   | bit 0: connection is read-only     |
| session | utf8 | session name, to end of message    |

Clients should verify `version == 1` and disable input locally when the
read-only flag is set.

### 1 — frame (screen update)

| field    | type | notes                                          |
|----------|------|------------------------------------------------|
| type     | u8   | `1`                                            |
| flags    | u8   | bit 0: full frame (complete screen repaint)    |
| seq      | u32  | monotonically increasing frame counter         |
| cols     | u16  | current grid width                             |
| rows     | u16  | current grid height                            |
| cur_row  | u16  | cursor row                                     |
| cur_col  | u16  | cursor column                                  |
| cur_vis  | u8   | 1 if the cursor should be drawn                |
| modes    | u32  | terminal mode bits (below)                     |
| ack      | u32  | highest client input `seq` handed to the PTY   |
| n_lines  | u16  | number of damaged line records that follow     |

Each line record:

| field     | type | notes                       |
|-----------|------|-----------------------------|
| row       | u16  | row index                   |
| start_col | u16  | first damaged column        |
| n_records | u16  | run-length records follow   |

Each run-length record describes 1–255 consecutive identical cells:

| field  | type | notes                                        |
|--------|------|----------------------------------------------|
| repeat | u8   | number of cells this record covers (1–255)   |
| cp     | u32  | Unicode codepoint (0 for wide-char spacers)  |
| fg     | u32  | foreground as 0x00RRGGBB, inverse pre-swapped|
| bg     | u32  | background as 0x00RRGGBB                     |
| attrs  | u16  | attribute bits (below)                       |

Clients apply frames to a local grid model in order. A frame whose dimensions
differ from the current grid must have the full flag; partial frames for stale
dimensions are dropped. On join (and on demand) the server broadcasts a full
frame.

**`ack` semantics:** `ack >= N` means input message `N` had been written toward
the PTY before this frame was built. It does *not* guarantee the application
has echoed it yet — prediction engines should confirm matches at ack but allow
an echo grace period before judging a prediction wrong.

Attribute bits: `1` bold, `2` italic, `4` underline, `8` dim, `16` strikeout,
`32` wide char (occupies 2 cells), `64` wide-char spacer (skip glyph, paint bg).

Mode bits: `1` application cursor keys, `2` bracketed paste, `4` any mouse
reporting, `8` SGR mouse encoding, `16` report-all-motion, `32` alternate
screen, `64` mouse drag reporting.

### 2 — pong

Echo of a `ping` payload: `[2][client payload bytes]`.

### 4 — session closed

`[4]` — the tmux client exited (session killed or server shut down). The
server replaces the dead engine on the next connection to that session.

### 5 — clipboard

`[5][utf8 text]` — an application inside the session set the clipboard via
OSC 52 (rmte runs tmux with `set-clipboard on`). Clients should write the
text to the system clipboard if permitted.

## Client → server messages

### 1 — input

`[1][u32 seq][bytes]` — raw bytes to write to the PTY (key encodings, paste
contents, mouse reports). `seq` must increase by 1 per message; it is echoed
back in frame `ack` fields. Ignored on read-only connections.

### 2 — resize

`[2][u16 cols][u16 rows]` — resize the PTY and emulator. Clamped server-side
to 10–500 × 4–300. Ignored on read-only connections.

### 3 — ping

`[3][payload]` — server echoes the payload back as a pong. The reference
client sends `[3][f64 timestamp]` every 2s to measure RTT.

## Embedding the client

The bundled `client/app.js` dials its own origin's `/ws` by default. An
embedder that vendors the client and relays frames from elsewhere can redirect
it without modification by setting `window.RMTE_WS_URL` (before the script
runs) or passing `?ws=<url>` — an absolute `ws(s)://` URL, an origin-relative
path, or a page-relative URL. When an override is set the embedder owns the
full endpoint including `session`/`ro` routing, so the client does not append
those itself; a relay maps its own token to the right session and read-only
state. With no override the client behaves standalone and appends
`session`/`ro` from its own query.

## Versioning

Breaking changes bump the `version` byte in the hello message; clients must
refuse versions they don't know. Additive changes (new message types, new
mode/attr bits) do not bump the version — clients should ignore unknown
message types and bits.
