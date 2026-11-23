//! A Colab runtime's Jupyter server, reached through its runtime proxy with the proxy token:
//! one persistent Python kernel per runtime (`/api/kernels`, messages over the kernel's
//! WebSocket channels, protocol 5.3), and files through the Contents API (`/api/contents`,
//! the same requests as `google-colab-cli`'s `contents.py`; the server's root is `/`).
use base64::{engine::general_purpose::STANDARD, Engine};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use tauri::Url;
use tokio_tungstenite::tungstenite::Message;

use super::store::SessionRecord;
use super::tunnel::{open, proxy_base, Refused};
use super::{parse, send_text, Failure, CLIENT_AGENT};

type Result<T> = std::result::Result<T, String>;

const SERVICE: &str = "The Colab runtime";
/// Text kept per stream; a long training log keeps its end.
const TEXT_CAP: usize = 256 * 1024;
const IMAGES_MAX: usize = 8;
/// Raw bytes per Contents API save, so each request stays well under proxy limits.
const CHUNK: usize = 8 << 20;
/// The largest file moved through the Contents API.
pub const FILE_MAX: usize = 256 << 20;
/// Headless runs cannot answer Colab's own prompts (Drive mounts, auth, `input()`).
pub const INTERACTIVE: &str = "Interactive Colab prompts such as drive.mount() or auth are not supported in headless runs. Use a service account, gsutil or a public URL instead.";

#[derive(Clone, Debug, Default, PartialEq)]
pub struct KernelError {
    pub name: String,
    pub value: String,
    pub traceback: Vec<String>,
}

/// What one execution produced.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Output {
    pub stdout: String,
    pub stderr: String,
    /// `text/plain` of execute results (and of displays without an image).
    pub results: Vec<String>,
    /// PNG bytes of plots and other image displays.
    pub images: Vec<Vec<u8>>,
    pub error: Option<KernelError>,
    pub timed_out: bool,
}

/// `{proxy}/api/<segments…>?authuser=0&colab-runtime-proxy-token=…[&params]`.
/// The proxy must be HTTPS on a Colab domain (`tunnel::proxy_base`): the token goes with it.
fn proxy_url(record: &SessionRecord, segments: &[&str], params: &[(&str, &str)]) -> Result<Url> {
    let mut url = proxy_base(&record.url)?;
    url.path_segments_mut().map_err(|_| "Google Colab sent an invalid runtime URL.".to_string())?.pop_if_empty().push("api").extend(segments);
    url.query_pairs_mut().append_pair("authuser", "0").append_pair("colab-runtime-proxy-token", &record.token).extend_pairs(params);
    Ok(url)
}

async fn call(record: &SessionRecord, method: reqwest::Method, url: Url, body: Option<Value>, limit: usize, timeout: Duration) -> std::result::Result<Value, Failure> {
    let client = super::super::http::client(timeout)?;
    let mut request = client.request(method, url).header("X-Colab-Client-Agent", CLIENT_AGENT).header("X-Colab-Runtime-Proxy-Token", &record.token).header(reqwest::header::ACCEPT, "application/json");
    if let Some(body) = body {
        request = request.json(&body);
    }
    parse(SERVICE, &send_text(SERVICE, request, limit).await?)
}

/// The runtime's kernel: the remembered one while it lives, else a new Python kernel.
pub async fn ensure_kernel(record: &SessionRecord) -> Result<String> {
    if let Some(id) = record.kernel_id.as_deref().filter(|id| valid_id(id)) {
        match call(record, reqwest::Method::GET, proxy_url(record, &["kernels", id], &[])?, None, 1 << 20, Duration::from_secs(30)).await {
            Ok(_) => return Ok(id.to_string()),
            Err(Failure { status: Some(404), .. }) => {}
            Err(failure) => return Err(failure.message),
        }
    }
    let reply = call(record, reqwest::Method::POST, proxy_url(record, &["kernels"], &[])?, Some(json!({"name": "python3"})), 1 << 20, Duration::from_secs(120)).await?;
    reply["id"].as_str().filter(|id| valid_id(id)).map(str::to_string).ok_or_else(|| "The Colab runtime did not start a kernel.".into())
}

/// Kernel IDs are UUIDs; anything else never goes into a URL path.
fn valid_id(id: &str) -> bool {
    (1..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

pub async fn restart(record: &SessionRecord, kernel: &str) -> Result<()> {
    call(record, reqwest::Method::POST, proxy_url(record, &["kernels", kernel, "restart"], &[])?, Some(json!({})), 1 << 20, Duration::from_secs(120)).await.map(|_| ()).map_err(String::from)
}

async fn interrupt(record: &SessionRecord, kernel: &str) {
    if let Ok(url) = proxy_url(record, &["kernels", kernel, "interrupt"], &[]) {
        let _ = call(record, reqwest::Method::POST, url, Some(json!({})), 1 << 20, Duration::from_secs(15)).await;
    }
}

/// `wss://<proxy>/api/kernels/<id>/channels?…`.
pub fn channels_url(record: &SessionRecord, kernel: &str, session: &str) -> Result<String> {
    let mut url = proxy_url(record, &["kernels", kernel, "channels"], &[("session_id", session)])?;
    let scheme = if url.scheme() == "https" { "wss" } else { "ws" };
    url.set_scheme(scheme).map_err(|_| "Google Colab sent an invalid runtime URL.".to_string())?;
    Ok(url.to_string())
}

pub fn execute_request(code: &str, msg_id: &str, session: &str) -> Value {
    json!({
        "header": {"msg_id": msg_id, "username": "pandacode", "session": session, "msg_type": "execute_request", "version": "5.3", "date": chrono::Utc::now().to_rfc3339()},
        "parent_header": {},
        "metadata": {},
        "content": {"code": code, "silent": false, "store_history": true, "user_expressions": {}, "allow_stdin": false, "stop_on_error": true},
        "channel": "shell",
        "buffers": [],
    })
}

/// Gathers the replies to one `execute_request`.
pub struct Collector {
    msg_id: String,
    pub output: Output,
}

fn push_capped(text: &mut String, more: &str) {
    text.push_str(more);
    if text.len() > TEXT_CAP {
        let cut = text.len() - TEXT_CAP;
        let boundary = (cut..text.len()).find(|&i| text.is_char_boundary(i)).unwrap_or(text.len());
        text.replace_range(..boundary, "");
    }
}

fn strip_ansi(text: &str) -> String {
    static ANSI: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    ANSI.get_or_init(|| regex::Regex::new(r"\x1b\[[0-9;]*[A-Za-z]").expect("static regex")).replace_all(text, "").into_owned()
}

impl Collector {
    pub fn new(msg_id: &str) -> Self {
        Collector { msg_id: msg_id.to_string(), output: Output::default() }
    }

    /// Take one kernel message; true once the kernel is idle again after this request. A
    /// dead or restarting kernel (whoever's request it was) and prompts a headless run cannot
    /// answer end the wait at once with an error.
    pub fn feed(&mut self, message: &Value) -> Result<bool> {
        let kind = message["header"]["msg_type"].as_str().or(message["msg_type"].as_str()).unwrap_or_default();
        let content = &message["content"];
        if kind == "status" {
            match content["execution_state"].as_str() {
                Some("dead") => return Err("The Colab kernel died (often out of memory). Run the code again to start a new kernel.".into()),
                Some("restarting") => return Err("The Colab kernel restarted while the code ran (often out of memory). Run the code again.".into()),
                _ => {}
            }
        }
        let parent = message["parent_header"]["msg_id"].as_str().filter(|id| !id.is_empty());
        if matches!(kind, "colab_request" | "input_request") && parent.is_none_or(|id| id == self.msg_id) {
            return Err(INTERACTIVE.into());
        }
        if parent != Some(self.msg_id.as_str()) {
            return Ok(false);
        }
        match kind {
            "stream" => {
                let text = content["text"].as_str().unwrap_or_default();
                if content["name"] == "stderr" { push_capped(&mut self.output.stderr, text) } else { push_capped(&mut self.output.stdout, text) }
            }
            "execute_result" | "display_data" => {
                let data = &content["data"];
                let image = data["image/png"].as_str().and_then(|b64| STANDARD.decode(b64.split_whitespace().collect::<String>()).ok());
                let had_image = image.is_some();
                if let Some(png) = image.filter(|_| self.output.images.len() < IMAGES_MAX) {
                    self.output.images.push(png);
                }
                if let Some(text) = data["text/plain"].as_str().filter(|_| kind == "execute_result" || !had_image) {
                    self.output.results.push(text.chars().take(TEXT_CAP).collect());
                }
            }
            "error" => self.output.error = Some(kernel_error(content)),
            "execute_reply" if content["status"] == "error" && self.output.error.is_none() => self.output.error = Some(kernel_error(content)),
            "status" => return Ok(content["execution_state"] == "idle"),
            _ => {}
        }
        Ok(false)
    }
}

fn kernel_error(content: &Value) -> KernelError {
    KernelError {
        name: content["ename"].as_str().unwrap_or("Error").to_string(),
        value: content["evalue"].as_str().unwrap_or_default().to_string(),
        traceback: content["traceback"].as_array().into_iter().flatten().filter_map(Value::as_str).map(strip_ansi).take(200).collect(),
    }
}

/// Run `code` on the kernel and collect its output until it is idle or `timeout` passes
/// (then the kernel is interrupted, so the next call finds it free).
pub async fn execute(record: &SessionRecord, kernel: &str, code: &str, timeout: Duration) -> Result<Output> {
    let session = uuid::Uuid::new_v4().simple().to_string();
    let url = channels_url(record, kernel, &session)?;
    let output = execute_at(&url, &[("X-Colab-Runtime-Proxy-Token", &record.token)], code, &session, timeout).await;
    // Code left waiting (out of time, or on a prompt) is interrupted so the kernel is free.
    if output.as_ref().map_or_else(|error| error == INTERACTIVE, |output| output.timed_out) {
        interrupt(record, kernel).await;
    }
    output
}

pub async fn execute_at(url: &str, headers: &[(&str, &str)], code: &str, session: &str, timeout: Duration) -> Result<Output> {
    let mut socket = open(url, headers).await.map_err(|refused| match refused {
        Refused::Status(404, _) => "The Colab kernel is gone. Try again to start a new one.".to_string(),
        Refused::Status(status, _) => format!("The Colab runtime refused the kernel connection (HTTP {status})."),
        Refused::Other(message) => message,
    })?;
    let msg_id = uuid::Uuid::new_v4().simple().to_string();
    socket.send(Message::text(execute_request(code, &msg_id, session).to_string())).await.map_err(|_| "Could not send code to the Colab kernel.".to_string())?;
    let mut collector = Collector::new(&msg_id);
    let deadline = Instant::now() + timeout;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        let next = match tokio::time::timeout(left, socket.next()).await {
            Err(_) => {
                collector.output.timed_out = true;
                break;
            }
            Ok(next) => next,
        };
        let text = match next {
            Some(Ok(Message::Text(text))) => text.to_string(),
            Some(Ok(Message::Binary(bytes))) => String::from_utf8_lossy(&bytes).into_owned(),
            Some(Ok(Message::Close(_))) | None => return Err("The Colab kernel connection closed before the code finished.".into()),
            Some(Ok(_)) => continue,
            Some(Err(_)) => return Err("The Colab kernel connection failed.".into()),
        };
        let Ok(message) = serde_json::from_str::<Value>(&text) else { continue };
        match collector.feed(&message) {
            Ok(true) => break,
            Ok(false) => {}
            Err(error) => {
                let _ = socket.close(None).await;
                return Err(error);
            }
        }
    }
    let _ = socket.close(None).await;
    Ok(collector.output)
}

/// A remote path as the Contents API wants it: relative to `/`, no `..`.
pub fn contents_path(remote: &str) -> Result<String> {
    let trimmed = remote.trim().trim_matches('/');
    if remote.contains('\0') || trimmed.split('/').any(|part| part == "..") || remote.len() > 4096 {
        return Err("Use an absolute runtime path such as /content/data.csv.".into());
    }
    Ok(trimmed.split('/').filter(|part| !part.is_empty() && *part != ".").collect::<Vec<_>>().join("/"))
}

fn contents_url(record: &SessionRecord, remote: &str, params: &[(&str, &str)]) -> Result<Url> {
    let path = contents_path(remote)?;
    let mut segments = vec!["contents"];
    segments.extend(path.split('/').filter(|part| !part.is_empty()));
    proxy_url(record, &segments, params)
}

fn missing(remote: &str) -> impl Fn(Failure) -> String + '_ {
    move |failure| if failure.status == Some(404) { format!("{remote} does not exist on the Colab runtime.") } else { failure.message }
}

/// A folder's entries (name, path, type, size, modified).
pub async fn list(record: &SessionRecord, remote: &str) -> Result<Value> {
    let reply = call(record, reqwest::Method::GET, contents_url(record, remote, &[])?, None, 16 << 20, Duration::from_secs(60)).await.map_err(missing(remote))?;
    Ok(summarize(&reply))
}

pub fn summarize(reply: &Value) -> Value {
    let entry = |item: &Value| json!({"name": item["name"], "path": format!("/{}", item["path"].as_str().unwrap_or_default()), "type": item["type"], "size": item["size"], "modified": item["last_modified"]});
    match reply["content"].as_array() {
        Some(items) if reply["type"] == "directory" => json!({"path": format!("/{}", reply["path"].as_str().unwrap_or_default()), "type": "directory", "entries": items.iter().map(entry).collect::<Vec<_>>()}),
        _ => entry(reply),
    }
}

/// The save requests for a file: one, or numbered chunks with the last as -1 (Jupyter's
/// large-file protocol: chunk 1 creates, later chunks append).
pub fn upload_bodies(bytes: &[u8], remote: &str) -> Result<Vec<Value>> {
    let path = contents_path(remote)?;
    let name = path.rsplit('/').next().filter(|n| !n.is_empty()).ok_or("Name the file to write, such as /content/data.csv.")?.to_string();
    let pieces: Vec<&[u8]> = if bytes.is_empty() { vec![&[][..]] } else { bytes.chunks(CHUNK).collect() };
    let count = pieces.len();
    Ok(pieces.into_iter().enumerate().map(|(index, piece)| {
        let chunk: i64 = if count > 1 && index + 1 == count { -1 } else { index as i64 + 1 };
        json!({"name": name, "path": path, "type": "file", "format": "base64", "content": STANDARD.encode(piece), "chunk": chunk})
    }).collect())
}

/// The folders above a file, outermost first (`a/b/c.txt` → `a`, `a/b`).
pub fn parent_dirs(path: &str) -> Vec<String> {
    let parts: Vec<&str> = path.split('/').filter(|part| !part.is_empty()).collect();
    (1..parts.len()).map(|n| parts[..n].join("/")).collect()
}

/// Make the file's folder when it is missing (the Contents API will not), outermost
/// first; saving a folder that exists changes nothing.
async fn ensure_parents(record: &SessionRecord, remote: &str) -> Result<()> {
    let dirs = parent_dirs(&contents_path(remote)?);
    let Some(parent) = dirs.last() else { return Ok(()) };
    let probe = call(record, reqwest::Method::GET, contents_url(record, parent, &[("content", "0")])?, None, 1 << 20, Duration::from_secs(60)).await;
    match probe {
        Ok(reply) if reply["type"] == "directory" => return Ok(()),
        Ok(_) => return Err(format!("/{parent} is a file on the Colab runtime, not a folder.")),
        Err(Failure { status: Some(404), .. }) => {}
        Err(failure) => return Err(failure.message),
    }
    for dir in &dirs {
        let body = json!({"type": "directory"});
        call(record, reqwest::Method::PUT, contents_url(record, dir, &[])?, Some(body), 1 << 20, Duration::from_secs(60)).await.map_err(|failure| format!("Could not create /{dir} on the Colab runtime: {}", failure.message))?;
    }
    Ok(())
}

pub async fn upload(record: &SessionRecord, bytes: &[u8], remote: &str) -> Result<()> {
    if bytes.len() > FILE_MAX {
        return Err(format!("Files over {} MiB do not go through the Contents API; use pandacode_colab_exec with curl or gsutil instead.", FILE_MAX >> 20));
    }
    ensure_parents(record, remote).await?;
    let url = contents_url(record, remote, &[])?;
    for body in upload_bodies(bytes, remote)? {
        call(record, reqwest::Method::PUT, url.clone(), Some(body), 1 << 20, Duration::from_secs(600)).await.map_err(missing(remote))?;
    }
    Ok(())
}

pub fn decode_download(reply: &Value) -> Result<Vec<u8>> {
    if reply["type"] == "directory" {
        return Err("That path is a folder; list it, or download one file at a time.".into());
    }
    let content = &reply["content"];
    match reply["format"].as_str() {
        Some("base64") => STANDARD.decode(content.as_str().unwrap_or_default().split_whitespace().collect::<String>()).map_err(|_| "The Colab runtime sent a file PandaCode could not read.".into()),
        Some("json") => serde_json::to_vec_pretty(content).map_err(|e| e.to_string()),
        _ => Ok(content.as_str().map_or_else(|| content.to_string(), str::to_string).into_bytes()),
    }
}

/// The file's exact bytes: `type=file&format=base64` makes Jupyter send notebooks and text
/// as stored, never re-serialized.
pub async fn download(record: &SessionRecord, remote: &str) -> Result<Vec<u8>> {
    let reply = call(record, reqwest::Method::GET, contents_url(record, remote, &[("type", "file"), ("format", "base64"), ("content", "1")])?, None, FILE_MAX / 3 * 4 + (1 << 20), Duration::from_secs(600)).await.map_err(missing(remote))?;
    decode_download(&reply)
}

pub async fn delete(record: &SessionRecord, remote: &str) -> Result<()> {
    call(record, reqwest::Method::DELETE, contents_url(record, remote, &[])?, None, 1 << 20, Duration::from_secs(60)).await.map(|_| ()).map_err(missing(remote))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud::http::mock;

    fn record(url: &str) -> SessionRecord {
        SessionRecord { endpoint: "gpu-t4-s-1".into(), url: url.into(), token: "proxy/tok".into(), ..SessionRecord::default() }
    }
    fn reply(kind: &str, parent: &str, content: Value) -> Value {
        json!({"header": {"msg_type": kind}, "parent_header": {"msg_id": parent}, "content": content})
    }

    #[test]
    fn builds_proxy_urls_with_the_token() {
        let r = record("https://8080-gpu.prod.colab.dev");
        assert_eq!(proxy_url(&r, &["kernels"], &[]).unwrap().as_str(), "https://8080-gpu.prod.colab.dev/api/kernels?authuser=0&colab-runtime-proxy-token=proxy%2Ftok");
        assert_eq!(channels_url(&r, "k-1", "s1").unwrap(), "wss://8080-gpu.prod.colab.dev/api/kernels/k-1/channels?authuser=0&colab-runtime-proxy-token=proxy%2Ftok&session_id=s1");
        assert_eq!(contents_url(&r, "/content/my file.txt", &[]).unwrap().path(), "/api/contents/content/my%20file.txt");
        assert!(proxy_url(&record("file:///etc"), &["kernels"], &[]).is_err());
        assert!(proxy_url(&record("https://attacker.example"), &["kernels"], &[]).is_err(), "the proxy token never leaves Colab's domains");
    }

    #[test]
    fn execute_requests_follow_protocol_5_3() {
        let request = execute_request("print(1)", "m1", "s1");
        assert_eq!(request["header"]["msg_type"], "execute_request");
        assert_eq!(request["header"]["version"], "5.3");
        assert_eq!(request["content"]["code"], "print(1)");
        assert_eq!(request["channel"], "shell");
    }

    #[test]
    fn collects_streams_results_images_and_errors_for_its_own_request() {
        let png = STANDARD.encode(b"\x89PNG fake");
        let mut collector = Collector::new("m1");
        assert!(!collector.feed(&reply("stream", "other", json!({"name": "stdout", "text": "not mine"}))).unwrap());
        assert!(!collector.feed(&reply("status", "other", json!({"execution_state": "idle"}))).unwrap());
        assert!(!collector.feed(&reply("input_request", "other", json!({"prompt": "?"}))).unwrap(), "another client's prompt");
        for message in [
            reply("status", "m1", json!({"execution_state": "busy"})),
            reply("stream", "m1", json!({"name": "stdout", "text": "loss 0.1\n"})),
            reply("stream", "m1", json!({"name": "stderr", "text": "warning\n"})),
            reply("display_data", "m1", json!({"data": {"image/png": format!("{}\n", png), "text/plain": "<Figure>"}})),
            reply("execute_result", "m1", json!({"data": {"text/plain": "42"}})),
            reply("error", "m1", json!({"ename": "ValueError", "evalue": "bad", "traceback": ["\u{1b}[31mValueError\u{1b}[0m: bad"]})),
        ] {
            assert!(!collector.feed(&message).unwrap());
        }
        assert!(collector.feed(&reply("status", "m1", json!({"execution_state": "idle"}))).unwrap());
        let output = collector.output;
        assert_eq!(output.stdout, "loss 0.1\n");
        assert_eq!(output.stderr, "warning\n");
        assert_eq!(output.images, vec![b"\x89PNG fake".to_vec()]);
        assert_eq!(output.results, vec!["42".to_string()]);
        assert_eq!(output.error.unwrap().traceback, vec!["ValueError: bad".to_string()]);
    }

    #[test]
    fn dead_kernels_and_interactive_prompts_end_the_wait() {
        let mut collector = Collector::new("m1");
        // Jupyter reports a dead kernel without our request as its parent.
        assert!(collector.feed(&reply("status", "", json!({"execution_state": "dead"}))).unwrap_err().contains("kernel died"));
        assert!(collector.feed(&reply("status", "other", json!({"execution_state": "restarting"}))).unwrap_err().contains("restarted"));
        assert_eq!(collector.feed(&reply("colab_request", "m1", json!({"request": {"authType": "dfs_ephemeral"}}))).unwrap_err(), INTERACTIVE);
        assert_eq!(collector.feed(&json!({"msg_type": "colab_request", "content": {}})).unwrap_err(), INTERACTIVE);
        assert_eq!(collector.feed(&reply("input_request", "m1", json!({"prompt": "Enter code"}))).unwrap_err(), INTERACTIVE);
    }

    #[test]
    fn parent_folders_are_listed_outermost_first() {
        assert_eq!(parent_dirs("content/a/b/c.txt"), vec!["content", "content/a", "content/a/b"]);
        assert!(parent_dirs("top.txt").is_empty());
    }

    #[tokio::test]
    async fn uploads_create_missing_folders_first() {
        let (base, seen) = mock::serve(|request, _| -> (u16, String) {
            match (request.method.as_str(), request.path.split('?').next().unwrap()) {
                ("GET", "/api/contents/content/new/deep") => (404, r#"{"message":"No such file"}"#.into()),
                ("PUT", _) => (201, r#"{"type":"directory"}"#.into()),
                ("GET", "/api/contents/content/file.txt") => (200, r#"{"type":"file"}"#.into()),
                _ => (500, "{}".into()),
            }
        });
        let r = record(&base);
        upload(&r, b"x", "/content/new/deep/a.txt").await.unwrap();
        assert!(upload(&r, b"x", "/content/file.txt/a.txt").await.unwrap_err().contains("is a file"));
        let log = seen.lock().unwrap();
        let puts: Vec<(&str, Value)> = log.iter().filter(|r| r.method == "PUT").map(|r| (r.path.split('?').next().unwrap(), serde_json::from_str(&r.body).unwrap())).collect();
        let paths: Vec<&str> = puts.iter().map(|(path, _)| *path).collect();
        assert_eq!(paths, ["/api/contents/content", "/api/contents/content/new", "/api/contents/content/new/deep", "/api/contents/content/new/deep/a.txt"]);
        assert_eq!(puts[0].1, json!({"type": "directory"}));
        assert_eq!(puts[3].1["type"], "file");
    }

    #[tokio::test]
    async fn an_interactive_prompt_fails_fast_over_the_websocket() {
        let server = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = server.local_addr().unwrap();
        tokio::spawn(async move {
            let (stream, _) = server.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            let Some(Ok(Message::Text(text))) = socket.next().await else { return };
            let request: Value = serde_json::from_str(&text).unwrap();
            let id = request["header"]["msg_id"].as_str().unwrap().to_string();
            socket.send(Message::text(reply("colab_request", &id, json!({"request": {"authType": "dfs_ephemeral"}})).to_string())).await.unwrap();
            while socket.next().await.is_some() {}
        });
        let started = Instant::now();
        let error = execute_at(&format!("ws://{address}/k"), &[], "from google.colab import drive; drive.mount('/content/drive')", "s", Duration::from_secs(30)).await.unwrap_err();
        assert_eq!(error, INTERACTIVE);
        assert!(started.elapsed() < Duration::from_secs(5), "no waiting out the timeout");
    }

    #[test]
    fn long_streams_keep_their_end() {
        let mut text = String::new();
        push_capped(&mut text, &"é".repeat(TEXT_CAP));
        push_capped(&mut text, "end");
        assert!(text.len() <= TEXT_CAP && text.ends_with("end"));
    }

    #[test]
    fn contents_paths_stay_rooted_and_uploads_chunk() {
        assert_eq!(contents_path("/content/a/b.csv").unwrap(), "content/a/b.csv");
        assert_eq!(contents_path("/content/./x//y").unwrap(), "content/x/y");
        assert!(contents_path("/content/../etc/passwd").is_err());
        let small = upload_bodies(b"hi", "/content/x.txt").unwrap();
        assert_eq!(small.len(), 1);
        assert_eq!(small[0]["chunk"], 1);
        assert_eq!(small[0]["name"], "x.txt");
        assert_eq!(small[0]["content"], "aGk=");
        let big = upload_bodies(&vec![1u8; CHUNK * 2 + 1], "/content/big.bin").unwrap();
        assert_eq!(big.iter().map(|b| b["chunk"].as_i64().unwrap()).collect::<Vec<_>>(), vec![1, 2, -1]);
        assert!(upload_bodies(b"x", "/").is_err());
    }

    #[test]
    fn decodes_downloads_by_format() {
        assert_eq!(decode_download(&json!({"type": "file", "format": "base64", "content": "aGk="})).unwrap(), b"hi");
        assert_eq!(decode_download(&json!({"type": "file", "format": "text", "content": "plain"})).unwrap(), b"plain");
        assert!(decode_download(&json!({"type": "notebook", "format": "json", "content": {"cells": []}})).unwrap().starts_with(b"{"));
        assert!(decode_download(&json!({"type": "directory", "content": []})).is_err());
    }

    #[tokio::test]
    async fn kernels_and_contents_go_through_the_proxy() {
        let (base, seen) = mock::serve(|request, _| -> (u16, String) {
            match (request.method.as_str(), request.path.split('?').next().unwrap()) {
                ("GET", "/api/kernels/old") => (404, r#"{"message":"Kernel does not exist"}"#.into()),
                ("POST", "/api/kernels") => (201, r#"{"id":"4c5d-new","name":"python3"}"#.into()),
                ("POST", "/api/kernels/4c5d-new/restart") => (200, r#"{"id":"4c5d-new"}"#.into()),
                ("GET", "/api/contents/content") => (200, r#"{"type":"directory","path":"content","content":[{"name":"a.csv","path":"content/a.csv","type":"file","size":3,"last_modified":"2026-01-01"}]}"#.into()),
                ("GET", "/api/contents/content/a.csv") => (200, r#"{"type":"file","format":"base64","content":"YWJj"}"#.into()),
                ("GET", "/api/contents/content/missing") => (404, r#"{"message":"No such file"}"#.into()),
                ("PUT", "/api/contents/content/b.txt") => (201, r#"{"type":"file"}"#.into()),
                ("DELETE", "/api/contents/content/b.txt") => (204, String::new()),
                _ => (500, "{}".into()),
            }
        });
        let r = SessionRecord { kernel_id: Some("old".into()), ..record(&base) };
        let kernel = ensure_kernel(&r).await.unwrap();
        assert_eq!(kernel, "4c5d-new");
        restart(&r, &kernel).await.unwrap();
        let listing = list(&r, "/content").await.unwrap();
        assert_eq!(listing["entries"][0]["path"], "/content/a.csv");
        assert_eq!(download(&r, "/content/a.csv").await.unwrap(), b"abc");
        assert!(download(&r, "/content/missing").await.unwrap_err().contains("does not exist"));
        upload(&r, b"hello", "/content/b.txt").await.unwrap();
        delete(&r, "/content/b.txt").await.unwrap();
        let log = seen.lock().unwrap();
        assert!(log.iter().all(|request| request.path.contains("colab-runtime-proxy-token=proxy%2Ftok") && request.path.contains("authuser=0")));
        assert!(log.iter().all(|request| request.headers.iter().any(|(n, v)| n == "x-colab-runtime-proxy-token" && v == "proxy/tok")));
        let put = log.iter().find(|request| request.method == "PUT").unwrap();
        let body: Value = serde_json::from_str(&put.body).unwrap();
        assert_eq!((body["format"].as_str(), body["content"].as_str(), body["path"].as_str()), (Some("base64"), Some("aGVsbG8="), Some("content/b.txt")));
        let get = log.iter().find(|request| request.path.starts_with("/api/contents/content/a.csv?")).unwrap();
        assert!(get.path.contains("type=file") && get.path.contains("format=base64") && get.path.contains("content=1"), "{}", get.path);
    }

    #[tokio::test]
    async fn executes_over_the_kernel_websocket_until_idle() {
        let server = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = server.local_addr().unwrap();
        tokio::spawn(async move {
            let (stream, _) = server.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            let Some(Ok(Message::Text(text))) = socket.next().await else { return };
            let request: Value = serde_json::from_str(&text).unwrap();
            let id = request["header"]["msg_id"].as_str().unwrap().to_string();
            let png = STANDARD.encode(b"PNG");
            for message in [
                reply("status", &id, json!({"execution_state": "busy"})),
                reply("stream", "someone-else", json!({"name": "stdout", "text": "ignored"})),
                reply("stream", &id, json!({"name": "stdout", "text": "hello\n"})),
                reply("display_data", &id, json!({"data": {"image/png": png}})),
                reply("execute_result", &id, json!({"data": {"text/plain": "3"}})),
                reply("status", &id, json!({"execution_state": "idle"})),
            ] {
                socket.send(Message::text(message.to_string())).await.unwrap();
            }
            let _ = socket.next().await;
        });
        let output = execute_at(&format!("ws://{address}/api/kernels/k/channels"), &[], "print('hello'); 1+2", "s", Duration::from_secs(10)).await.unwrap();
        assert_eq!(output.stdout, "hello\n");
        assert_eq!(output.results, vec!["3".to_string()]);
        assert_eq!(output.images, vec![b"PNG".to_vec()]);
        assert!(!output.timed_out);
    }

    #[tokio::test]
    async fn a_silent_kernel_times_out() {
        let server = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = server.local_addr().unwrap();
        tokio::spawn(async move {
            let (stream, _) = server.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            while socket.next().await.is_some() {}
        });
        let output = execute_at(&format!("ws://{address}/k"), &[], "while True: pass", "s", Duration::from_millis(200)).await.unwrap();
        assert!(output.timed_out);
    }
}
