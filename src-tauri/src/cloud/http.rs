//! JSON over HTTPS for cloud sandbox APIs, with bounded responses and readable errors.
//! Credentials go in headers only and never appear in errors.
use serde_json::Value;
use std::time::Duration;

const LIMIT: usize = 16 * 1024 * 1024;
/// A word this long in a 401/403 message may be a key, so the message is not shown.
const TOKEN_LIKE: usize = 20;

pub fn client(timeout: Duration) -> Result<reqwest::Client, String> {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    reqwest::Client::builder()
        // Tests talk to a loopback server; everything else must be HTTPS.
        .https_only(!cfg!(test))
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(timeout)
        .user_agent(concat!("PandaCode/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| format!("Could not prepare a network client: {e}"))
}

/// The service's own message from an error body, else the status.
pub fn error_message(service: &str, status: u16, body: &str) -> String {
    let parsed: Option<Value> = serde_json::from_str(body).ok();
    let structured = parsed.as_ref().and_then(|v| v["message"].as_str().or(v["error"]["message"].as_str()).or(v["error"].as_str()).or(v["errors"][0]["message"].as_str())).map(str::to_string);
    if matches!(status, 401 | 403) {
        return match structured.as_deref().and_then(refusal_detail) {
            Some(detail) => format!("{service} refused the credentials (HTTP {status}): {detail}. Check them in Settings → Cloud."),
            None => format!("{service} refused the credentials (HTTP {status}). Check them in Settings → Cloud."),
        };
    }
    match structured.or_else(|| Some(body.trim().chars().take(300).collect::<String>()).filter(|s| !s.is_empty() && !s.starts_with('<'))) {
        Some(message) => format!("{service}: {message}"),
        None => format!("{service} returned HTTP {status}."),
    }
}

/// A refusal's own message, as one bounded line, unless it could be echoing a credential.
/// ponytail: any long word counts as a token, since this has no access to the secret itself;
/// a refusal naming a long ID or URL falls back to the generic text.
fn refusal_detail(message: &str) -> Option<String> {
    if message.split_whitespace().any(|word| word.chars().count() >= TOKEN_LIKE) {
        return None;
    }
    let line = message.split_whitespace().collect::<Vec<_>>().join(" ");
    let line: String = line.chars().take(300).collect();
    Some(line.trim_end_matches('.').to_string()).filter(|detail| !detail.is_empty())
}

pub async fn send(service: &str, request: reqwest::RequestBuilder) -> Result<Value, String> {
    let response = request.send().await.map_err(|e| {
        if e.is_timeout() { format!("{service} did not answer in time.") } else if e.is_connect() { format!("Could not reach {service}. Check your connection.") } else { format!("{service} request failed.") }
    })?;
    let status = response.status().as_u16();
    if response.content_length().is_some_and(|n| n > LIMIT as u64) {
        return Err(format!("{service} sent a response that is too large."));
    }
    let bytes = response.bytes().await.map_err(|_| format!("{service} response was cut off."))?;
    if bytes.len() > LIMIT {
        return Err(format!("{service} sent a response that is too large."));
    }
    let text = String::from_utf8_lossy(&bytes);
    if !(200..300).contains(&status) {
        return Err(error_message(service, status, &text));
    }
    if text.trim().is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(&text).map_err(|_| format!("{service} returned an unreadable response."))
}

/// Run an async request from a blocking worker thread.
pub fn block<T>(future: impl std::future::Future<Output = T>) -> T {
    tauri::async_runtime::block_on(future)
}

#[cfg(test)]
pub mod mock {
    //! A loopback HTTP server that answers from a routing function and records requests.
    use std::{
        io::{BufRead, BufReader, Read, Write},
        net::TcpListener,
        sync::{Arc, Mutex},
        thread,
    };

    #[derive(Clone, Debug)]
    pub struct Request {
        pub method: String,
        pub path: String,
        pub authorization: Option<String>,
        pub headers: Vec<(String, String)>,
        pub body: String,
    }
    pub type Seen = Arc<Mutex<Vec<Request>>>;

    /// Serve until the test ends; `route` gets each request and the server's base URL
    /// and returns (status, body).
    pub fn serve<R: Into<Vec<u8>>>(route: impl Fn(&Request, &str) -> (u16, R) + Send + 'static) -> (String, Seen) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let seen: Seen = Arc::default();
        let log = seen.clone();
        let own = base.clone();
        thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { return };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                if reader.read_line(&mut line).is_err() || line.is_empty() { continue; }
                let mut parts = line.split_whitespace();
                let (method, path) = (parts.next().unwrap_or("").to_string(), parts.next().unwrap_or("").to_string());
                let mut headers = Vec::new();
                let mut length = 0;
                loop {
                    let mut header = String::new();
                    reader.read_line(&mut header).unwrap();
                    let header = header.trim_end();
                    if header.is_empty() { break; }
                    if let Some((name, value)) = header.split_once(':') {
                        let (name, value) = (name.trim().to_ascii_lowercase(), value.trim().to_string());
                        if name == "content-length" { length = value.parse().unwrap_or(0); }
                        headers.push((name, value));
                    }
                }
                let mut body = vec![0; length];
                reader.read_exact(&mut body).unwrap();
                let request = Request { authorization: headers.iter().find(|(n, _)| n == "authorization").map(|(_, v)| v.clone()), method, path, headers, body: String::from_utf8_lossy(&body).into_owned() };
                let (status, reply) = route(&request, &own);
                let reply: Vec<u8> = reply.into();
                log.lock().unwrap().push(request);
                let _ = write!(stream, "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", reply.len());
                let _ = stream.write_all(&reply);
            }
        });
        (base, seen)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errors_name_the_service_and_never_echo_html() {
        assert_eq!(error_message("Daytona", 400, r#"{"message":"Snapshot not found"}"#), "Daytona: Snapshot not found");
        assert!(error_message("AWS", 403, "denied").contains("refused the credentials"));
        assert_eq!(error_message("Cloudflare", 502, "<html>bad gateway</html>"), "Cloudflare returned HTTP 502.");
        assert_eq!(error_message("Cloudflare", 400, r#"{"errors":[{"message":"Bad token"}]}"#), "Cloudflare: Bad token");
    }

    #[test]
    fn refusals_keep_the_providers_message_and_the_hint_but_never_a_token() {
        assert_eq!(error_message("Blaxel", 403, r#"{"error":"Workspace mismatch."}"#), "Blaxel refused the credentials (HTTP 403): Workspace mismatch. Check them in Settings → Cloud.");
        let generic = "Blaxel refused the credentials (HTTP 401). Check them in Settings → Cloud.";
        assert_eq!(error_message("Blaxel", 401, r#"{"message":"Invalid key bl_abcdefghijklmnopqrstuvwxyz"}"#), generic);
        // Only a structured message counts: a raw body could hold anything.
        assert_eq!(error_message("Blaxel", 401, "denied for this key"), generic);
        assert_eq!(error_message("Blaxel", 401, r#"{"message":"  "}"#), generic);
    }
}
