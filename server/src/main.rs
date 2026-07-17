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
#[command(name = "tachyon", about = "Fast tmux streaming to the browser")]
struct Args {
    /// Default tmux session when the client doesn't specify ?session=
    #[arg(short, long, default_value = "main")]
    session: String,
    /// Port to listen on
    #[arg(short, long, default_value = "7861")]
    port: u16,
    /// Bind address
    #[arg(long, default_value = "127.0.0.1")]
    bind: String,
}

struct AppState {
    sessions: parking_lot::Mutex<HashMap<String, Arc<Engine>>>,
    default_session: String,
}

fn valid_session(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// Get the live engine for a tmux session, lazily attaching (and creating the
/// session) on first use. A dead engine (tmux client exited) is replaced.
fn get_or_spawn(state: &AppState, name: &str) -> anyhow::Result<Arc<Engine>> {
    let mut map = state.sessions.lock();
    if let Some(existing) = map.get(name) {
        if !existing.is_closed() {
            return Ok(existing.clone());
        }
    }
    let tmux_args: Vec<String> = [
        "new-session", "-A", "-s", name,
        // OSC 52 passthrough so tmux copy-mode / in-app copies reach the browser clipboard
        ";", "set-option", "-s", "set-clipboard", "on",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    let engine = Engine::spawn(tmux_args, 120, 32)?;
    map.insert(name.to_string(), engine.clone());
    tracing::info!("attached engine to tmux session '{name}'");
    Ok(engine)
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt::init();
    let args = Args::parse();

    let state = Arc::new(AppState {
        sessions: parking_lot::Mutex::new(HashMap::new()),
        default_session: args.session.clone(),
    });

    let app = Router::new()
        .route("/", get(index))
        .route("/app.js", get(app_js))
        .route("/ws", get(ws_upgrade))
        .route("/text", get(text_dump))
        .with_state(state);

    let addr = format!("{}:{}", args.bind, args.port);
    tracing::info!(
        "tachyon listening on http://{addr} (default session: {})",
        args.session
    );
    let listener = tokio::net::TcpListener::bind(&addr).await?;
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
    match get_or_spawn(&state, &session) {
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
    // Read-only is a property of the connection, decided by whoever
    // establishes it (an auth layer / relay in front of tachyon).
    let read_only = matches!(q.get("ro").map(String::as_str), Some("1") | Some("true"));
    let engine = match get_or_spawn(&state, &session) {
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
