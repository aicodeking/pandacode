//! A small HTTP/1.1 server on 127.0.0.1 for the web chat page and WhatsApp's
//! webhook. It reads one bounded request per connection and closes it. Web chat
//! routes require the channel's bearer token and a loopback Host header (against
//! DNS rebinding); webhook routes are verified by Meta's signature instead, so they
//! can sit behind a tunnel such as cloudflared or Tailscale Funnel.

use super::{web, whatsapp};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU16, Ordering};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// Preferred port, so web chat links and webhook URLs survive restarts.
pub(crate) const PREFERRED_PORT: u16 = 47_321;
const MAX_HEAD: usize = 16 * 1024;
const MAX_BODY: usize = 256 * 1024;

static PORT: AtomicU16 = AtomicU16::new(0);

#[derive(Debug, Default)]
pub(crate) struct Request {
    pub method: String,
    pub path: String,
    pub query: HashMap<String, String>,
    pub headers: HashMap<String, String>,
    pub body: Vec<u8>,
}

impl Request {
    pub(crate) fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(&name.to_ascii_lowercase()).map(String::as_str)
    }

    pub(crate) fn bearer(&self) -> Option<&str> {
        self.header("authorization").and_then(|value| value.strip_prefix("Bearer ")).map(str::trim)
    }

    /// True when the browser addressed this computer, not a rebound domain name.
    pub(crate) fn loopback_host(&self) -> bool {
        let host = self.header("host").unwrap_or_default();
        let name = host.rsplit_once(':').map_or(host, |(name, _)| name);
        matches!(name, "127.0.0.1" | "localhost" | "[::1]")
    }
}

pub(crate) struct Response {
    pub status: u16,
    pub content_type: &'static str,
    pub body: Vec<u8>,
}

impl Response {
    pub(crate) fn json(status: u16, value: &serde_json::Value) -> Self {
        Self { status, content_type: "application/json", body: value.to_string().into_bytes() }
    }
    pub(crate) fn text(status: u16, text: &str) -> Self {
        Self { status, content_type: "text/plain; charset=utf-8", body: text.as_bytes().to_vec() }
    }
    /// The Enriched Markdown parser (md4c as WebAssembly), shared with the desktop app.
    pub(crate) fn markdown_engine() -> Self {
        Self { status: 200, content_type: "text/javascript; charset=utf-8", body: include_str!("../../../../src/vendor/enriched-markdown/md4c.js").as_bytes().to_vec() }
    }
    pub(crate) fn html(body: String) -> Self {
        Self { status: 200, content_type: "text/html; charset=utf-8", body: body.into_bytes() }
    }
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        413 => "Payload Too Large",
        429 => "Too Many Requests",
        _ => "Error",
    }
}

fn decode(component: &str) -> String {
    let bytes = component.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < bytes.len() => match std::str::from_utf8(&bytes[i + 1..i + 3]).ok().and_then(|hex| u8::from_str_radix(hex, 16).ok()) {
                Some(byte) => {
                    out.push(byte);
                    i += 2;
                }
                None => out.push(b'%'),
            },
            byte => out.push(byte),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Parses a request head; `None` when it is malformed.
pub(crate) fn parse_head(head: &str) -> Option<Request> {
    let mut lines = head.split("\r\n");
    let mut first = lines.next()?.split(' ');
    let method = first.next()?.to_owned();
    let target = first.next()?;
    if !first.next()?.starts_with("HTTP/1.") {
        return None;
    }
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    let query = query.split('&').filter(|pair| !pair.is_empty()).map(|pair| pair.split_once('=').unwrap_or((pair, ""))).map(|(k, v)| (decode(k), decode(v))).collect();
    let mut headers = HashMap::new();
    for line in lines.filter(|line| !line.is_empty()) {
        let (name, value) = line.split_once(':')?;
        headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_owned());
    }
    Some(Request { method, path: path.to_owned(), query, headers, body: Vec::new() })
}

async fn read_request(stream: &mut tokio::net::TcpStream) -> Result<Request, u16> {
    let mut buffer = Vec::with_capacity(4096);
    let mut chunk = [0u8; 4096];
    let head_end = loop {
        let read = stream.read(&mut chunk).await.map_err(|_| 400u16)?;
        if read == 0 {
            return Err(400);
        }
        buffer.extend_from_slice(&chunk[..read]);
        if let Some(end) = buffer.windows(4).position(|w| w == b"\r\n\r\n") {
            break end;
        }
        if buffer.len() > MAX_HEAD {
            return Err(413);
        }
    };
    let mut request = parse_head(std::str::from_utf8(&buffer[..head_end]).map_err(|_| 400u16)?).ok_or(400u16)?;
    let length: usize = request.header("content-length").map_or(Ok(0), str::parse).map_err(|_| 400u16)?;
    if length > MAX_BODY {
        return Err(413);
    }
    let mut body = buffer[head_end + 4..].to_vec();
    while body.len() < length {
        let read = stream.read(&mut chunk).await.map_err(|_| 400u16)?;
        if read == 0 {
            return Err(400);
        }
        body.extend_from_slice(&chunk[..read]);
    }
    body.truncate(length);
    request.body = body;
    Ok(request)
}

async fn write_response(stream: &mut tokio::net::TcpStream, response: Response) {
    let head = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nX-Frame-Options: DENY\r\nContent-Security-Policy: default-src 'none'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'\r\nConnection: close\r\n\r\n",
        response.status,
        reason(response.status),
        response.content_type,
        response.body.len()
    );
    let _ = stream.write_all(head.as_bytes()).await;
    let _ = stream.write_all(&response.body).await;
    let _ = stream.shutdown().await;
}

async fn route(app: &tauri::AppHandle, request: Request) -> Response {
    let segments: Vec<&str> = request.path.trim_matches('/').split('/').collect();
    match segments.as_slice() {
        ["chat", channel] => web::page(channel, request.header("accept-language")),
        ["api", "chat", channel, action] => web::api(app, channel, action, &request).await,
        ["whatsapp", channel] => whatsapp::webhook(app, channel, &request).await,
        ["assets", "md4c.js"] => Response::markdown_engine(),
        [""] => Response::text(200, "PandaCode bots are running on this computer."),
        _ => Response::text(404, "Not found."),
    }
}

async fn serve(app: tauri::AppHandle, listener: tokio::net::TcpListener) {
    loop {
        let Ok((mut stream, _)) = listener.accept().await else { continue };
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            // Long polls wait up to 25 seconds, so allow a little longer overall.
            let work = async {
                let response = match read_request(&mut stream).await {
                    Ok(request) => route(&app, request).await,
                    Err(status) => Response::text(status, reason(status)),
                };
                write_response(&mut stream, response).await;
            };
            let _ = tokio::time::timeout(Duration::from_secs(40), work).await;
        });
    }
}

/// Starts the server once and returns its port (0 if it could not start).
pub(crate) fn ensure_server(app: tauri::AppHandle) -> u16 {
    static START: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = START.lock();
    let port = PORT.load(Ordering::SeqCst);
    if port != 0 {
        return port;
    }
    let listener = std::net::TcpListener::bind(("127.0.0.1", PREFERRED_PORT)).or_else(|_| std::net::TcpListener::bind(("127.0.0.1", 0)));
    let Ok(listener) = listener else { return 0 };
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
    if listener.set_nonblocking(true).is_err() {
        return 0;
    }
    tauri::async_runtime::spawn(async move {
        if let Ok(listener) = tokio::net::TcpListener::from_std(listener) {
            serve(app, listener).await;
        }
    });
    PORT.store(port, Ordering::SeqCst);
    port
}

pub(crate) fn port() -> u16 {
    PORT.load(Ordering::SeqCst)
}

/// Compares secrets without leaking where they differ.
pub(crate) fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}
