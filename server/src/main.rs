mod engine;
mod palette;

use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{Html, IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use bytes::{BufMut, BytesMut};
use clap::Parser;
use futures_util::{SinkExt, StreamExt};

use engine::Engine;

#[derive(Parser)]
#[command(name = "rmte", version, about = "Fast tmux streaming to the browser")]
struct Args {
    /// Default tmux session when the client doesn't specify ?session=
    #[arg(short, long, default_value = "main")]
    session: String,
    /// Port to listen on (TCP mode)
    #[arg(short, long, default_value = "7861")]
    port: u16,
    /// Bind address (TCP mode)
    #[arg(long, default_value = "127.0.0.1")]
    bind: String,
    /// Listen on a Unix domain socket instead of TCP, e.g.
    /// `--listen unix:/run/rmte.sock`. The socket is created with 0600
    /// permissions, so only the owning user can connect — filesystem
    /// permissions become the access control and no TCP port is opened.
    /// Overrides --bind/--port when set.
    #[arg(long)]
    listen: Option<String>,
    /// Allow connections to select a tmux server via `?socket=<abs path>`
    /// (`tmux -S`). For embedders whose sessions live on a non-default tmux
    /// server (or several, during a migration). Off by default: with it
    /// disabled, a `socket` parameter is rejected, so untrusted clients can't
    /// point rmte at arbitrary sockets. Enable only when everyone who can
    /// reach the listener is trusted (e.g. a 0600 unix-socket listener).
    #[arg(long)]
    allow_socket_param: bool,
}

struct AppState {
    /// Engines keyed by (tmux server socket, session name); `None` socket is
    /// the environment-default server.
    sessions: parking_lot::Mutex<HashMap<(Option<String>, String), Arc<Engine>>>,
    default_session: String,
    allow_socket_param: bool,
}

fn valid_session(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 200
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// A `?socket=` value must be an absolute path to an existing socket file —
/// this selects a tmux server, it never creates one.
fn valid_tmux_socket(path: &str) -> bool {
    let p = std::path::Path::new(path);
    p.is_absolute() && p.exists()
}

/// Get the live engine for a tmux session, lazily attaching (and creating the
/// session) on first use. A dead engine (tmux client exited) is replaced.
/// `socket` selects the tmux server (`tmux -S`); `None` uses the
/// environment-default server.
fn get_or_spawn(
    state: &AppState,
    socket: Option<&str>,
    name: &str,
) -> anyhow::Result<Arc<Engine>> {
    let key = (socket.map(str::to_string), name.to_string());
    let mut map = state.sessions.lock();
    if let Some(existing) = map.get(&key) {
        if !existing.is_closed() {
            return Ok(existing.clone());
        }
    }
    let mut tmux_args: Vec<String> = Vec::new();
    if let Some(socket) = socket {
        tmux_args.push("-S".to_string());
        tmux_args.push(socket.to_string());
    }
    tmux_args.extend(
        [
            "new-session", "-A", "-s", name,
            // OSC 52 passthrough so tmux copy-mode / in-app copies reach the browser clipboard
            ";", "set-option", "-s", "set-clipboard", "on",
        ]
        .iter()
        .map(|s| s.to_string()),
    );
    let engine = Engine::spawn(tmux_args, 120, 32)?;
    map.insert(key, engine.clone());
    tracing::info!(
        "attached engine to tmux session '{name}'{}",
        socket.map(|s| format!(" (server {s})")).unwrap_or_default()
    );
    Ok(engine)
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt::init();
    let args = Args::parse();

    let state = Arc::new(AppState {
        sessions: parking_lot::Mutex::new(HashMap::new()),
        default_session: args.session.clone(),
        allow_socket_param: args.allow_socket_param,
    });

    let app = Router::new()
        .route("/", get(index))
        .route("/app.js", get(app_js))
        .route("/ws", get(ws_upgrade))
        .route("/text", get(text_dump))
        .with_state(state);

    match &args.listen {
        Some(spec) => {
            let path = spec.strip_prefix("unix:").ok_or_else(|| {
                anyhow::anyhow!("--listen must be of the form unix:/path/to/socket")
            })?;
            serve_unix(app, path, &args.session).await
        }
        None => {
            let addr = format!("{}:{}", args.bind, args.port);
            tracing::info!(
                "rmte listening on http://{addr} (default session: {})",
                args.session
            );
            let listener = tokio::net::TcpListener::bind(&addr).await?;
            axum::serve(listener, app).await?;
            Ok(())
        }
    }
}

/// Serve on a Unix domain socket locked to the owning user (0600). A stale
/// socket file from a previous run is removed first. Because the socket is
/// only reachable through the filesystem, the OS permission bits are the
/// access control — there is no port for other hosts or (with 0600) other
/// local users to reach.
async fn serve_unix(app: Router, path: &str, default_session: &str) -> anyhow::Result<()> {
    use std::os::unix::fs::PermissionsExt;

    match std::fs::remove_file(path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(anyhow::anyhow!("could not remove stale socket {path}: {e}")),
    }
    // Restrict the socket to the owner before anyone can connect: create it
    // under a 0177 umask so it is born 0600, then assert the mode explicitly.
    let prev_umask = unsafe { libc::umask(0o177) };
    let listener = tokio::net::UnixListener::bind(path);
    unsafe { libc::umask(prev_umask) };
    let listener = listener?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;

    tracing::info!(
        "rmte listening on unix:{path} (0600, default session: {default_session})"
    );
    axum::serve(listener, app).await?;
    Ok(())
}

const APP_JS: &str = include_str!("../../client/app.js");

/// index.html with the app.js URL content-hashed, so edge caches (Cloudflare
/// sits in front of tuft.host) can never serve a stale client.
fn index_html() -> &'static str {
    static INDEX: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    INDEX.get_or_init(|| {
        let mut h: u64 = 0xcbf29ce484222325;
        for b in APP_JS.bytes() {
            h ^= b as u64;
            h = h.wrapping_mul(0x100000001b3);
        }
        include_str!("../../client/index.html").replace("__V__", &format!("{h:016x}"))
    })
}

async fn index() -> ([(&'static str, &'static str); 1], Html<&'static str>) {
    ([("cache-control", "no-store")], Html(index_html()))
}

async fn app_js() -> ([(&'static str, &'static str); 2], &'static str) {
    (
        [
            ("content-type", "application/javascript"),
            ("cache-control", "no-store"),
        ],
        APP_JS,
    )
}

/// Extract and validate the optional `?socket=` tmux server selector.
/// Returns `Err(response)` when the parameter is present but disallowed or
/// invalid.
fn tmux_socket_param<'q>(
    state: &AppState,
    q: &'q HashMap<String, String>,
) -> Result<Option<&'q str>, Response> {
    let Some(socket) = q.get("socket") else {
        return Ok(None);
    };
    if !state.allow_socket_param {
        return Err((
            StatusCode::BAD_REQUEST,
            "socket parameter not allowed (start rmte with --allow-socket-param)",
        )
            .into_response());
    }
    if !valid_tmux_socket(socket) {
        return Err((
            StatusCode::BAD_REQUEST,
            "socket must be an absolute path to an existing tmux server socket",
        )
            .into_response());
    }
    Ok(Some(socket.as_str()))
}

async fn text_dump(
    State(state): State<Arc<AppState>>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let session = q
        .get("session")
        .cloned()
        .unwrap_or_else(|| state.default_session.clone());
    if !valid_session(&session) {
        return (StatusCode::BAD_REQUEST, "invalid session name").into_response();
    }
    let socket = match tmux_socket_param(&state, &q) {
        Ok(socket) => socket,
        Err(response) => return response,
    };
    match get_or_spawn(&state, socket, &session) {
        Ok(engine) => engine.screen_text().into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("spawn failed: {e}")).into_response(),
    }
}

async fn ws_upgrade(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let session = q
        .get("session")
        .cloned()
        .unwrap_or_else(|| state.default_session.clone());
    if !valid_session(&session) {
        return (StatusCode::BAD_REQUEST, "invalid session name").into_response();
    }
    let socket = match tmux_socket_param(&state, &q) {
        Ok(socket) => socket,
        Err(response) => return response,
    };
    // Read-only is a property of the connection, decided by whoever
    // establishes it (an auth layer / relay in front of rmte).
    let read_only = matches!(q.get("ro").map(String::as_str), Some("1") | Some("true"));
    let engine = match get_or_spawn(&state, socket, &session) {
        Ok(engine) => engine,
        Err(e) => {
            return (StatusCode::INTERNAL_SERVER_ERROR, format!("spawn failed: {e}"))
                .into_response()
        }
    };
    ws.on_upgrade(move |socket| client_loop(socket, engine, session, read_only))
}

const IN_INPUT: u8 = 1;
const IN_RESIZE: u8 = 2;
const IN_PING: u8 = 3;

const PROTOCOL_VERSION: u8 = 1;
const HELLO_FLAG_READ_ONLY: u8 = 1;

async fn client_loop(socket: WebSocket, engine: Arc<Engine>, session: String, read_only: bool) {
    let (mut tx, mut rx) = socket.split();
    let mut frames = engine.frames.subscribe();

    // hello: [0][protocol version][flags][utf8 session name]
    let mut hello = BytesMut::with_capacity(3 + session.len());
    hello.put_u8(engine::MSG_HELLO);
    hello.put_u8(PROTOCOL_VERSION);
    hello.put_u8(if read_only { HELLO_FLAG_READ_ONLY } else { 0 });
    hello.put_slice(session.as_bytes());
    if tx.send(Message::Binary(hello.freeze())).await.is_err() {
        return;
    }

    engine.request_full();

    loop {
        tokio::select! {
            frame = frames.recv() => {
                match frame {
                    Ok(bytes) => {
                        if tx.send(Message::Binary(bytes)).await.is_err() {
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        // Client fell behind; resync with a full frame.
                        frames = frames.resubscribe();
                        engine.request_full();
                    }
                    Err(_) => break,
                }
            }
            msg = rx.next() => {
                match msg {
                    Some(Ok(Message::Binary(data))) => {
                        if data.is_empty() {
                            continue;
                        }
                        match data[0] {
                            // [1][u32 input seq][utf8 payload]
                            IN_INPUT if data.len() >= 5 && !read_only => {
                                let seq = u32::from_le_bytes([data[1], data[2], data[3], data[4]]);
                                engine.write_input(seq, &data[5..]);
                            }
                            IN_RESIZE if data.len() >= 5 && !read_only => {
                                let cols = u16::from_le_bytes([data[1], data[2]]);
                                let rows = u16::from_le_bytes([data[3], data[4]]);
                                engine.resize(cols, rows);
                            }
                            IN_PING => {
                                let mut pong = BytesMut::with_capacity(data.len());
                                pong.put_u8(engine::MSG_PONG);
                                pong.put_slice(&data[1..]);
                                if tx.send(Message::Binary(pong.freeze())).await.is_err() {
                                    break;
                                }
                            }
                            _ => {}
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Err(_)) => break,
                    _ => {}
                }
            }
        }
    }
}
