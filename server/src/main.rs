mod engine;
mod palette;

use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Html;
use axum::routing::get;
use axum::Router;
use bytes::{BufMut, BytesMut};
use clap::Parser;
use futures_util::{SinkExt, StreamExt};

use engine::Engine;

#[derive(Parser)]
#[command(name = "tachyon", about = "Fast tmux streaming to the browser")]
struct Args {
    /// tmux session name (created if it doesn't exist)
    #[arg(short, long, default_value = "main")]
    session: String,
    /// Port to listen on
    #[arg(short, long, default_value = "7861")]
    port: u16,
    /// Bind address
    #[arg(long, default_value = "127.0.0.1")]
    bind: String,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt::init();
    let args = Args::parse();

    let tmux_args: Vec<String> = [
        "new-session", "-A", "-s", &args.session,
        // OSC 52 passthrough so tmux copy-mode / in-app copies reach the browser clipboard
        ";", "set-option", "-s", "set-clipboard", "on",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    let engine = Engine::spawn(tmux_args, 120, 32)?;

    let app = Router::new()
        .route("/", get(index))
        .route("/app.js", get(app_js))
        .route("/ws", get(ws_upgrade))
        .route("/text", get(text_dump))
        .with_state(engine);

    let addr = format!("{}:{}", args.bind, args.port);
    tracing::info!("tachyon listening on http://{addr} (session: {})", args.session);
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

async fn index() -> Html<&'static str> {
    Html(include_str!("../../client/index.html"))
}

async fn app_js() -> ([(&'static str, &'static str); 1], &'static str) {
    (
        [("content-type", "application/javascript")],
        include_str!("../../client/app.js"),
    )
}

async fn text_dump(State(engine): State<Arc<Engine>>) -> String {
    engine.screen_text()
}

async fn ws_upgrade(ws: WebSocketUpgrade, State(engine): State<Arc<Engine>>) -> axum::response::Response {
    ws.on_upgrade(move |socket| client_loop(socket, engine))
}

const IN_INPUT: u8 = 1;
const IN_RESIZE: u8 = 2;
const IN_PING: u8 = 3;

async fn client_loop(socket: WebSocket, engine: Arc<Engine>) {
    let (mut tx, mut rx) = socket.split();
    let mut frames = engine.frames.subscribe();
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
                            IN_INPUT => engine.write_input(&data[1..]),
                            IN_RESIZE if data.len() >= 5 => {
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
