//! Browser sign-in for trusted packages (`auth.signIn`, runtime slice R0803, contract G24).
//!
//! A package that needs an authorization code from an identity provider asks the host to run the browser part:
//! the host listens on numeric loopback for one request at the callback path, opens the authorization address in the
//! system browser, answers the browser with a short page and hands the package the whole callback address. The host
//! never interprets the query: checking the state value, the proof key and the code exchange are the package's, and
//! the package keeps what it gets through its own secrets (`secrets.private`, `runtime_private_secrets.rs`). No
//! credential PandaCode holds takes part (ADR-0006).
//!
//! Rules (docs/extensions/runtime-sign-in.md):
//! - Service only (the answer carries an authorization code); a panel is `UnsupportedCapability`.
//! - The grant is rechecked natively when the call starts and while it waits: revoke, narrowing, untrust, disable
//!   (archive), a stale version and safe mode end the flow (`PermissionDenied`), free the port and close the notice.
//! - A flow ends with a status (`completed`, `cancelled`, `timeout`), not an error. Errors: `Conflict` (a second
//!   sign-in of the same package while one waits, or a callback port that is taken), `InvalidArguments`,
//!   `InvalidShape` (a malformed request on the callback), `HostUnavailable` (no browser and no manual path),
//!   `PermissionDenied`, `UnsupportedCapability`.
//! - The browser is opened by one function, `open_browser`. Only tests replace it, by passing another opener.
//! - Nothing of the flow is logged: the callback address, which carries the code, is returned to the caller and kept
//!   nowhere else. The webview's projection lists package, title, phase and time left, never an address with a query.
//!   Cancel and every other end free the listener (it is owned by the waiting call and dropped with it).
use crate::extensions::runtime_grants::{RuntimeGrants, Target};
use serde_json::{json, Map, Value};
use std::{
    collections::HashMap,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex},
    time::{Duration, Instant},
};

type Result<T> = std::result::Result<T, String>;

/// The permission a package must hold.
pub const PERMISSION: &str = "auth.signIn";
/// `timeoutMs` default and bounds.
pub const DEFAULT_TIMEOUT_MS: u64 = 120_000;
pub const MAX_TIMEOUT_MS: u64 = 900_000;
/// After the wait ends, a flow with `manual: true` keeps accepting a pasted address for this long.
pub const PASTE_WINDOW: Duration = Duration::from_secs(120);
const MAX_URL: usize = 8192;
const MAX_TITLE: usize = 120;
const MAX_PATH: usize = 256;
const POLL: Duration = Duration::from_millis(10);

/// Who is calling. Only a background service may sign in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Caller { Service, Panel }

#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase { Waiting, Paste }

struct Flow {
    title: String,
    redirect_uri: String,
    path: String,
    manual: bool,
    cancel: AtomicBool,
    pasted: Mutex<Option<String>>,
    phase: Mutex<Phase>,
    /// Set only when the browser could not be opened: the address the user copies by hand.
    copy_address: Mutex<Option<String>>,
    ends: Mutex<Instant>,
}

/// Native owner of the sign-in flows in flight (at most one per package). Managed as Tauri state.
pub struct SignIns { flows: Mutex<HashMap<String, Arc<Flow>>>, paste_window: Duration }
impl Default for SignIns { fn default() -> Self { Self { flows: Mutex::new(HashMap::new()), paste_window: PASTE_WINDOW } } }

/// Removes the flow from the registry when the call ends, however it ends.
struct Registration<'a> { owner: &'a SignIns, id: String, flow: Arc<Flow> }
impl Drop for Registration<'_> {
    fn drop(&mut self) {
        if let Ok(mut flows) = self.owner.flows.lock() {
            if flows.get(&self.id).is_some_and(|current| Arc::ptr_eq(current, &self.flow)) { flows.remove(&self.id); }
        }
    }
}

fn fields<'a>(value: &'a Value, allowed: &[&str]) -> Result<&'a Map<String, Value>> {
    let Value::Object(map) = value else { return Err("InvalidArguments".into()) };
    if map.keys().any(|name| !allowed.contains(&name.as_str())) { return Err("InvalidArguments".into()); }
    Ok(map)
}

/// Everything except the unreserved characters is escaped, so the address survives as one query value.
fn encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len() * 3);
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') { out.push(byte as char); } else { out.push_str(&format!("%{byte:02X}")); }
    }
    out
}

struct Options { authorize: String, path: String, port: Option<u16>, host: &'static str, timeout: Duration, manual: bool, title: String }

fn http_address(text: &str) -> Result<tauri::Url> {
    let parsed = tauri::Url::parse(text).map_err(|_| "InvalidArguments")?;
    if text.len() > MAX_URL || !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() || !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("InvalidArguments".into());
    }
    Ok(parsed)
}

fn parse(params: &Value) -> Result<Options> {
    let map = fields(params, &["authorizeUrl", "callback", "timeoutMs", "manual", "title"])?;
    let authorize = map.get("authorizeUrl").and_then(Value::as_str).ok_or("InvalidArguments")?.to_owned();
    // The template must be an http(s) address once the placeholder is filled; the final address is checked again.
    http_address(&authorize.replace("{redirect_uri}", &encode("http://127.0.0.1:1/callback")))?;
    let callback = fields(map.get("callback").ok_or("InvalidArguments")?, &["path", "port", "host"])?;
    let path = callback.get("path").and_then(Value::as_str).ok_or("InvalidArguments")?.to_owned();
    if !path.starts_with('/') || path.len() > MAX_PATH || path.chars().any(|c| c.is_control() || c.is_whitespace() || matches!(c, '?' | '#' | '\\')) { return Err("InvalidArguments".into()); }
    let port = match callback.get("port") {
        None | Some(Value::Null) => None,
        Some(value) => Some(value.as_u64().filter(|port| (1..=65535).contains(port)).ok_or("InvalidArguments")? as u16),
    };
    let host = match callback.get("host") {
        None | Some(Value::Null) => "127.0.0.1",
        Some(value) => match value.as_str() { Some("127.0.0.1") => "127.0.0.1", Some("localhost") => "localhost", _ => return Err("InvalidArguments".into()) },
    };
    let timeout_ms = match map.get("timeoutMs") {
        None | Some(Value::Null) => DEFAULT_TIMEOUT_MS,
        Some(value) => value.as_u64().filter(|ms| (1..=MAX_TIMEOUT_MS).contains(ms)).ok_or("InvalidArguments")?,
    };
    let manual = match map.get("manual") { None | Some(Value::Null) => false, Some(value) => value.as_bool().ok_or("InvalidArguments")? };
    let title = match map.get("title") {
        None | Some(Value::Null) => String::new(),
        Some(value) => value.as_str().filter(|title| title.chars().count() <= MAX_TITLE && !title.chars().any(char::is_control)).ok_or("InvalidArguments")?.to_owned(),
    };
    Ok(Options { authorize, path, port, host, timeout: Duration::from_millis(timeout_ms), manual, title })
}

enum Served { Callback(String), Ignored, Malformed }

fn reply(stream: &mut TcpStream, status: &str, body: &str) {
    let text = format!("HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{body}", body.len());
    let _ = stream.write_all(text.as_bytes());
    let _ = stream.flush();
    let _ = stream.shutdown(std::net::Shutdown::Write);
}

/// Reads the request line of one connection. A connection that sends nothing (a browser's speculative connect) and a
/// request for another path are ignored; anything that is not a `GET` request line is malformed.
fn serve(mut stream: TcpStream, path: &str) -> Served {
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_read_timeout(Some(Duration::from_millis(400)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(1)));
    let mut buffer = [0u8; 8192];
    let mut length = 0;
    let started = Instant::now();
    while length < buffer.len() && started.elapsed() < Duration::from_secs(1) && !buffer[..length].contains(&b'\n') {
        match stream.read(&mut buffer[length..]) { Ok(0) | Err(_) => break, Ok(count) => length += count }
    }
    if length == 0 { return Served::Ignored; }
    let head = String::from_utf8_lossy(&buffer[..length]);
    let Some(line) = head.split('\n').next().filter(|_| buffer[..length].contains(&b'\n')) else { reply(&mut stream, "400 Bad Request", "Bad request."); return Served::Malformed };
    let mut parts = line.trim_end_matches('\r').split(' ');
    let (Some(method), Some(target), Some(version), None) = (parts.next(), parts.next(), parts.next(), parts.next()) else { reply(&mut stream, "400 Bad Request", "Bad request."); return Served::Malformed };
    if !version.starts_with("HTTP/1.") || !target.starts_with('/') { reply(&mut stream, "400 Bad Request", "Bad request."); return Served::Malformed; }
    if method != "GET" { reply(&mut stream, "405 Method Not Allowed", "Method not allowed."); return Served::Malformed; }
    if target.split(['?', '#']).next() != Some(path) { reply(&mut stream, "404 Not Found", "Not found."); return Served::Ignored; }
    reply(&mut stream, "200 OK", "<!doctype html><meta charset=\"utf-8\"><title>PandaCode</title><p>Sign-in finished. You can close this tab and return to PandaCode.</p>");
    Served::Callback(target.to_owned())
}

fn completed(url: String, redirect_uri: &str, via: &str) -> Value { json!({"status": "completed", "url": url, "redirectUri": redirect_uri, "via": via}) }

impl SignIns {
    /// Test seam: a short paste window.
    #[cfg(test)]
    fn with_paste_window(paste_window: Duration) -> Self { Self { flows: Mutex::new(HashMap::new()), paste_window } }

    fn register(&self, id: &str, flow: &Arc<Flow>) -> Result<Registration<'_>> {
        let mut flows = self.flows.lock().map_err(|_| "HostUnavailable")?;
        if flows.contains_key(id) { return Err("Conflict".into()); }
        flows.insert(id.to_owned(), flow.clone());
        Ok(Registration { owner: self, id: id.to_owned(), flow: flow.clone() })
    }

    /// The one entry of the dispatcher. `id` and `version` are the caller's identity, never read from `params`.
    /// Blocks until the flow ends, so the dispatcher runs it on a blocking task. `opener` opens the authorization
    /// address in the browser (`open_browser` in the product).
    pub fn sign_in(&self, grants: &RuntimeGrants, id: &str, version: &str, caller: Caller, params: &Value, opener: &dyn Fn(&str) -> Result<()>) -> Result<Value> {
        if caller != Caller::Service { return Err("UnsupportedCapability".into()); }
        let work = grants.begin(id, version, PERMISSION, &Target::default())?;
        let options = parse(params)?;
        if self.flows.lock().map_err(|_| "HostUnavailable")?.contains_key(id) { return Err("Conflict".into()); }
        let listener = match TcpListener::bind(("127.0.0.1", options.port.unwrap_or(0))) {
            Ok(listener) => listener,
            Err(error) if error.kind() == std::io::ErrorKind::AddrInUse || error.kind() == std::io::ErrorKind::PermissionDenied => return Err("Conflict".into()),
            Err(_) => return Err("HostUnavailable".into()),
        };
        listener.set_nonblocking(true).map_err(|_| "HostUnavailable")?;
        let port = listener.local_addr().map_err(|_| "HostUnavailable")?.port();
        let redirect_uri = format!("http://{}:{port}{}", options.host, options.path);
        let authorize = options.authorize.replace("{redirect_uri}", &encode(&redirect_uri));
        http_address(&authorize)?;
        let deadline = Instant::now() + options.timeout;
        let flow = Arc::new(Flow {
            title: if options.title.is_empty() { id.to_owned() } else { options.title.clone() },
            redirect_uri: redirect_uri.clone(), path: options.path.clone(), manual: options.manual,
            cancel: AtomicBool::new(false), pasted: Mutex::new(None), phase: Mutex::new(Phase::Waiting), copy_address: Mutex::new(None), ends: Mutex::new(deadline),
        });
        let _registration = self.register(id, &flow)?;
        if opener(&authorize).is_err() {
            if !options.manual { return Err("HostUnavailable".into()); }
            *flow.copy_address.lock().map_err(|_| "HostUnavailable")? = Some(authorize);
        }
        let mut listener = Some(listener);
        loop {
            if work.is_cancelled() { return Err("PermissionDenied".into()); }
            if flow.cancel.load(Ordering::SeqCst) { return Ok(json!({"status": "cancelled"})); }
            if let Some(url) = flow.pasted.lock().map_err(|_| "HostUnavailable")?.take() { return Ok(completed(url, &redirect_uri, "manual")); }
            let ends = *flow.ends.lock().map_err(|_| "HostUnavailable")?;
            if Instant::now() >= ends {
                if flow.manual && listener.is_some() {
                    // The wait is over: close the listener, free the port and keep only the paste dialog.
                    listener = None;
                    *flow.phase.lock().map_err(|_| "HostUnavailable")? = Phase::Paste;
                    *flow.ends.lock().map_err(|_| "HostUnavailable")? = Instant::now() + self.paste_window;
                    continue;
                }
                return Ok(json!({"status": "timeout"}));
            }
            let Some(open) = listener.as_ref() else { std::thread::sleep(POLL); continue };
            match open.accept() {
                Ok((stream, _)) => match serve(stream, &options.path) {
                    Served::Callback(target) => return Ok(completed(format!("http://{}:{port}{target}", options.host), &redirect_uri, "callback")),
                    Served::Malformed => return Err("InvalidShape".into()),
                    Served::Ignored => {}
                },
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(POLL),
                Err(_) => return Err("HostUnavailable".into()),
            }
        }
    }

    /// The user pressed Cancel. Returns whether a flow of that package was waiting.
    pub fn cancel(&self, id: &str) -> bool {
        let Some(flow) = self.flows.lock().ok().and_then(|flows| flows.get(id).cloned()) else { return false };
        flow.cancel.store(true, Ordering::SeqCst);
        true
    }

    /// The user pasted the redirect address of a flow that offered it. The address must be the callback address.
    pub fn paste(&self, id: &str, url: &str) -> Result<()> {
        let flow = self.flows.lock().map_err(|_| "HostUnavailable")?.get(id).cloned().ok_or("NotFound")?;
        if !flow.manual { return Err("UnsupportedCapability".into()); }
        let parsed = http_address(url.trim())?;
        let expected = tauri::Url::parse(&flow.redirect_uri).map_err(|_| "HostUnavailable")?;
        // The same loopback listener address as the one the host wrote into `redirectUri`, at the callback path.
        if parsed.scheme() != "http" || !matches!(parsed.host_str(), Some("127.0.0.1" | "localhost")) || parsed.port() != expected.port() || parsed.path() != flow.path {
            return Err("InvalidArguments".into());
        }
        *flow.pasted.lock().map_err(|_| "HostUnavailable")? = Some(url.trim().to_owned());
        Ok(())
    }

    /// What the webview may see: which packages wait, with title, phase and time left. Never an address with a query.
    pub fn projection(&self) -> Value {
        let Ok(flows) = self.flows.lock() else { return json!({"schemaVersion": 1, "available": false, "flows": []}) };
        let mut items: Vec<Value> = flows.iter().filter_map(|(id, flow)| {
            let phase = *flow.phase.lock().ok()?;
            let ends = *flow.ends.lock().ok()?;
            let copy = flow.copy_address.lock().ok()?.clone();
            Some(json!({
                "id": id, "title": flow.title, "notice": format!("Waiting for sign-in: {}", flow.title),
                "phase": if phase == Phase::Waiting { "waiting" } else { "paste" }, "manual": flow.manual,
                "remainingMs": ends.saturating_duration_since(Instant::now()).as_millis() as u64, "copyAddress": copy,
            }))
        }).collect();
        items.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
        json!({"schemaVersion": 1, "available": true, "flows": items})
    }
}

/// The one function that opens the system browser (T1). Tests pass another opener to `SignIns::sign_in`.
pub fn open_browser(url: &str) -> Result<()> {
    http_address(url).map_err(|_| "InvalidArguments".to_owned())?;
    #[cfg(target_os = "macos")]
    let mut command = std::process::Command::new("/usr/bin/open");
    #[cfg(target_os = "windows")]
    let mut command = { let mut command = std::process::Command::new("rundll32"); command.arg("url.dll,FileProtocolHandler"); command };
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let mut command = std::process::Command::new("xdg-open");
    #[cfg(target_os = "windows")]
    { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
    let mut child = command.arg(url).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn().map_err(|_| "HostUnavailable".to_owned())?;
    std::thread::spawn(move || { let _ = child.wait(); });
    Ok(())
}

/// The duplex channel's entry (`runtime_service_lifetime::app_dispatch`). Blocks until the flow ends, so the dispatcher
/// runs it on a blocking task. The caller's identity comes from the connection; the grant is rechecked natively while
/// the flow waits. Answers the broker envelope `{ok, value|error}`; the redirected address is only in the reply.
pub fn serve_request(app: &tauri::AppHandle, owner: &str, params: &Value) -> Value {
    use tauri::Manager;
    let result = super::runtime_private_secrets::installed_version(app, owner).and_then(|version| app.state::<SignIns>().sign_in(&app.state::<RuntimeGrants>(), owner, &version, Caller::Service, params, &open_browser));
    match result { Ok(value) => json!({"ok": true, "value": value}), Err(code) => super::context::failure(&code) }
}

/// The service ended (stop, crash, disable, trust loss): its waiting sign-in ends as `cancelled` and frees the port,
/// so the restarted service is not met with `Conflict`.
pub fn service_stopped(app: &tauri::AppHandle, owner: &str) {
    use tauri::Manager;
    if let Some(flows) = app.try_state::<SignIns>() { flows.cancel(owner); }
}

fn main_window(window: &tauri::WebviewWindow) -> Result<()> {
    if crate::headless::active() || window.label() != "main" { return Err("PermissionDenied".into()); }
    Ok(())
}

/// The waiting notices (main window only).
#[tauri::command]
pub fn extensions_sign_in(window: tauri::WebviewWindow, flows: tauri::State<'_, SignIns>) -> Result<Value> { main_window(&window)?; Ok(flows.projection()) }
/// The Cancel button of the notice.
#[tauri::command]
pub fn extensions_sign_in_cancel(window: tauri::WebviewWindow, flows: tauri::State<'_, SignIns>, id: String) -> Result<Value> { main_window(&window)?; Ok(json!({"cancelled": flows.cancel(&id)})) }
/// The "Paste the redirect address" dialog.
#[tauri::command]
pub fn extensions_sign_in_paste(window: tauri::WebviewWindow, flows: tauri::State<'_, SignIns>, id: String, url: String) -> Result<Value> { main_window(&window)?; flows.paste(&id, &url)?; Ok(Value::Null) }

#[cfg(test)]
mod tests {
    use super::*;
    use crate::extensions::{runtime_grants::Scope, runtime_private_secrets::{self, PrivateSecrets}};
    use std::path::PathBuf;

    const MANIFEST: &str = include_str!("../../../tests/fixtures/extensions/runtime-sign-in/extension.json");
    const SOURCE: &str = include_str!("../../../tests/fixtures/extensions/runtime-sign-in/main.cjs");
    const A: &str = "sample.sign-in";
    const B: &str = "sample.other-package";
    struct Dir(PathBuf);
    impl Dir { fn new() -> Self { let path = std::env::temp_dir().join(format!("pandacode-sign-in-{}", uuid::Uuid::new_v4())); std::fs::create_dir(&path).unwrap(); Self(path) } }
    impl Drop for Dir { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }

    fn setup(dir: &Dir) -> RuntimeGrants {
        let grants = RuntimeGrants::open(&dir.0);
        for id in [A, B] {
            grants.register_package(id, "1.0.0", &["runtime.service", PERMISSION, runtime_private_secrets::PERMISSION], Some("digest")).unwrap();
            grants.trust(id, true).unwrap();
            grants.grant(id, PERMISSION, Scope::default()).unwrap();
            grants.grant(id, runtime_private_secrets::PERMISSION, Scope::default()).unwrap();
        }
        grants
    }
    fn options(extra: Value) -> Value {
        let mut base = json!({"authorizeUrl": "http://127.0.0.1:9/authorize?client_id=sample&redirect_uri={redirect_uri}&state=s1", "callback": {"path": "/callback"}, "timeoutMs": 5000});
        for (name, value) in extra.as_object().unwrap() { base[name] = value.clone(); }
        base
    }
    /// The loopback address the host substituted into the authorization address.
    fn redirect_of(authorize: &str) -> String {
        tauri::Url::parse(authorize).unwrap().query_pairs().find(|(name, _)| name == "redirect_uri").unwrap().1.into_owned()
    }
    fn host_port(address: &str) -> (String, String) {
        let parsed = tauri::Url::parse(address).unwrap();
        (format!("{}:{}", parsed.host_str().unwrap(), parsed.port().unwrap()), parsed.path().to_owned())
    }
    /// A stand-in browser: one raw request to the callback listener, answered text returned on join.
    fn browser(address: &str, raw_request: String) -> std::thread::JoinHandle<String> {
        let (host, _) = host_port(address);
        std::thread::spawn(move || {
            let mut stream = TcpStream::connect(host).unwrap();
            stream.write_all(raw_request.as_bytes()).unwrap();
            let mut answer = String::new();
            let _ = stream.read_to_string(&mut answer);
            answer
        })
    }
    /// Several requests of one stand-in browser, one after the other on the same thread, so each is answered before the next.
    fn browser_in_order(address: &str, raw_requests: Vec<String>) -> std::thread::JoinHandle<Vec<String>> {
        let (host, _) = host_port(address);
        std::thread::spawn(move || raw_requests.iter().map(|raw| {
            let mut stream = TcpStream::connect(&host).unwrap();
            stream.write_all(raw.as_bytes()).unwrap();
            let mut answer = String::new();
            let _ = stream.read_to_string(&mut answer);
            answer
        }).collect())
    }
    fn get(path_and_query: &str) -> String { format!("GET {path_and_query} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n") }
    fn wait_for(flows: &SignIns, present: bool) {
        let started = Instant::now();
        while flows.projection()["flows"].as_array().unwrap().is_empty() == present { assert!(started.elapsed() < Duration::from_secs(5), "flow state never became {present}"); std::thread::sleep(Duration::from_millis(5)); }
    }
    fn port_is_free(address: &str) -> bool { let (host, _) = host_port(address); TcpListener::bind(host).is_ok() }
    fn never_open(_: &str) -> Result<()> { Err("no browser".into()) }

    #[test]
    fn the_fixture_manifest_is_valid_and_declares_both_permissions() {
        let manifest: Value = serde_json::from_str(MANIFEST).unwrap();
        assert_eq!(manifest["id"], A);
        for name in [PERMISSION, "secrets.private"] { assert!(manifest["permissions"].as_array().unwrap().iter().any(|item| item == name), "{name}"); }
        assert_eq!(crate::extensions::contracts::validate_contract("packages", &json!([manifest]))["ok"], true);
        assert!(SOURCE.contains("panda.auth.signIn") && SOURCE.contains("panda.secrets.set"));
        assert!(!crate::extensions::runtime_grants::PERMISSIONS.contains(&"credentials.read"));
    }

    #[test]
    fn a_callback_completes_the_flow_with_the_whole_address_and_frees_the_port() {
        let dir = Dir::new();
        let grants = setup(&dir);
        let flows = SignIns::default();
        let seen = Mutex::new(None::<(String, std::thread::JoinHandle<String>)>);
        let result = flows.sign_in(&grants, A, "1.0.0", Caller::Service, &options(json!({})), &|authorize: &str| {
            let redirect = redirect_of(authorize);
            assert!(authorize.starts_with("http://127.0.0.1:9/authorize?client_id=sample&redirect_uri=http%3A%2F%2F127.0.0.1%3A"), "{authorize}");
            assert!(redirect.ends_with("/callback"));
            let handle = browser(&redirect, get("/callback?code=canary-code&state=s1"));
            *seen.lock().unwrap() = Some((redirect, handle)); Ok(())
        }).unwrap();
        let (redirect, handle) = seen.lock().unwrap().take().unwrap();
        assert_eq!(result, json!({"status": "completed", "url": format!("{}?code=canary-code&state=s1", redirect), "redirectUri": redirect, "via": "callback"}));
        let page = handle.join().unwrap();
        assert!(page.starts_with("HTTP/1.1 200 OK") && page.contains("close this tab") && !page.contains("canary-code"), "{page}");
        assert!(flows.projection()["flows"].as_array().unwrap().is_empty());
        assert!(port_is_free(&redirect), "the listener is gone");
    }

    #[test]
    fn a_stray_request_does_not_end_the_flow_and_localhost_only_changes_the_written_address() {
        let dir = Dir::new();
        let grants = setup(&dir);
        let flows = SignIns::default();
        let strays = Mutex::new(None::<std::thread::JoinHandle<Vec<String>>>);
        let result = flows.sign_in(&grants, A, "1.0.0", Caller::Service, &options(json!({"callback": {"path": "/callback", "host": "localhost"}})), &|authorize: &str| {
            let redirect = redirect_of(authorize);
            assert!(redirect.starts_with("http://localhost:"), "{redirect}");
            let numeric = redirect.replace("localhost", "127.0.0.1");
            *strays.lock().unwrap() = Some(browser_in_order(&numeric, vec![get("/favicon.ico"), get("/callback-other?code=x"), get("/callback?code=real")]));
            Ok(())
        }).unwrap();
        assert_eq!(result["status"], "completed");
        assert!(result["url"].as_str().unwrap().starts_with("http://localhost:") && result["url"].as_str().unwrap().ends_with("/callback?code=real"));
        let answers = strays.lock().unwrap().take().unwrap().join().unwrap();
        assert!(answers[0].starts_with("HTTP/1.1 404") && answers[1].starts_with("HTTP/1.1 404") && answers[2].starts_with("HTTP/1.1 200"), "{answers:?}");
    }

    #[test]
    fn cancel_and_timeout_return_their_statuses_and_free_the_port() {
        let dir = Dir::new();
        let grants = setup(&dir);
        let flows = SignIns::default();
        let port = Mutex::new(String::new());
        std::thread::scope(|scope| {
            let call = scope.spawn(|| flows.sign_in(&grants, A, "1.0.0", Caller::Service, &options(json!({"title": "Sample cloud"})), &|authorize: &str| { *port.lock().unwrap() = redirect_of(authorize); Ok(()) }));
            wait_for(&flows, true);
            let notice = flows.projection();
            assert_eq!(notice["flows"][0]["notice"], "Waiting for sign-in: Sample cloud");
            assert_eq!(notice["flows"][0]["phase"], "waiting");
            assert!(!notice.to_string().contains("redirect_uri") && !notice.to_string().contains("state=s1"), "{notice}");
            assert!(!flows.cancel("sample.nobody"));
            assert!(flows.cancel(A));
            assert_eq!(call.join().unwrap().unwrap(), json!({"status": "cancelled"}));
        });
        assert!(flows.projection()["flows"].as_array().unwrap().is_empty());
        assert!(port_is_free(&port.lock().unwrap()));
        // Timeout, with and without the manual path.
        let started = Instant::now();
        assert_eq!(flows.sign_in(&grants, A, "1.0.0", Caller::Service, &options(json!({"timeoutMs": 150})), &|authorize: &str| { *port.lock().unwrap() = redirect_of(authorize); Ok(()) }).unwrap(), json!({"status": "timeout"}));
        assert!(started.elapsed() >= Duration::from_millis(150) && started.elapsed() < Duration::from_secs(3));
        assert!(port_is_free(&port.lock().unwrap()));
        assert!(flows.projection()["flows"].as_array().unwrap().is_empty());
    }

    #[test]
    fn the_manual_path_takes_a_pasted_address_after_the_wait_and_ends_as_timeout_without_one() {
        let dir = Dir::new();
        let grants = setup(&dir);
        let flows = SignIns::with_paste_window(Duration::from_millis(300));
        let port = Mutex::new(String::new());
        std::thread::scope(|scope| {
            let call = scope.spawn(|| flows.sign_in(&grants, A, "1.0.0", Caller::Service, &options(json!({"manual": true, "timeoutMs": 200})), &|authorize: &str| { *port.lock().unwrap() = redirect_of(authorize); Ok(()) }));
            wait_for(&flows, true);
            let started = Instant::now();
            while flows.projection()["flows"][0]["phase"] != "paste" { assert!(started.elapsed() < Duration::from_secs(3)); std::thread::sleep(Duration::from_millis(5)); }
            assert!(port_is_free(&port.lock().unwrap()), "the wait is over: the listener is closed while the dialog is open");
            let redirect = port.lock().unwrap().clone();
            assert_eq!(flows.paste(A, "not an address").unwrap_err(), "InvalidArguments");
            assert_eq!(flows.paste(A, &redirect.replace("/callback", "/elsewhere")).unwrap_err(), "InvalidArguments");
            assert_eq!(flows.paste(A, "https://example.com/callback?code=x").unwrap_err(), "InvalidArguments");
            assert_eq!(flows.paste(B, &redirect).unwrap_err(), "NotFound");
            flows.paste(A, &format!("{redirect}?code=pasted")).unwrap();
            assert_eq!(call.join().unwrap().unwrap(), json!({"status": "completed", "url": format!("{redirect}?code=pasted"), "redirectUri": redirect, "via": "manual"}));
        });
        assert_eq!(flows.sign_in(&grants, A, "1.0.0", Caller::Service, &options(json!({"manual": true, "timeoutMs": 100})), &|_: &str| Ok(())).unwrap(), json!({"status": "timeout"}));
        // Without manual, there is nothing to paste.
        std::thread::scope(|scope| {
            let call = scope.spawn(|| flows.sign_in(&grants, A, "1.0.0", Caller::Service, &options(json!({})), &|_: &str| Ok(())));
            wait_for(&flows, true);
            assert_eq!(flows.paste(A, "http://127.0.0.1:1/callback").unwrap_err(), "UnsupportedCapability");
            flows.cancel(A); call.join().unwrap().unwrap();
        });
    }

    #[test]
    fn a_second_flow_and_a_taken_port_are_conflicts_that_leak_no_listener() {
        let dir = Dir::new();
        let grants = setup(&dir);
        let flows = SignIns::default();
        let first = Mutex::new(String::new());
        std::thread::scope(|scope| {
            let call = scope.spawn(|| flows.sign_in(&grants, A, "1.0.0", Caller::Service, &options(json!({})), &|authorize: &str| { *first.lock().unwrap() = redirect_of(authorize); Ok(()) }));
            wait_for(&flows, true);
            // Same package: Conflict, and the second call opened no browser and bound nothing.
            let opened = AtomicBool::new(false);
            assert_eq!(flows.sign_in(&grants, A, "1.0.0", Caller::Service, &options(json!({})), &|_: &str| { opened.store(true, Ordering::SeqCst); Ok(()) }).unwrap_err(), "Conflict");
            assert!(!opened.load(Ordering::SeqCst));
            // Another package may sign in at the same time on its own port.
            std::thread::scope(|inner| {
                let other = inner.spawn(|| flows.sign_in(&grants, B, "1.0.0", Caller::Service, &options(json!({"timeoutMs": 100})), &|_: &str| Ok(())));
                assert_eq!(other.join().unwrap().unwrap(), json!({"status": "timeout"}));
            });
            assert!(flows.cancel(A));
            assert_eq!(call.join().unwrap().unwrap()["status"], "cancelled");
        });
        // A fixed port that something else holds is a Conflict; once it is free the same call works.
        let holder = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = holder.local_addr().unwrap().port();
        let fixed = options(json!({"callback": {"path": "/callback", "port": port}, "timeoutMs": 100}));
        let opened = AtomicBool::new(false);
        assert_eq!(flows.sign_in(&grants, A, "1.0.0", Caller::Service, &fixed, &|_: &str| { opened.store(true, Ordering::SeqCst); Ok(()) }).unwrap_err(), "Conflict");
        assert!(!opened.load(Ordering::SeqCst) && flows.projection()["flows"].as_array().unwrap().is_empty());
        drop(holder);
        assert_eq!(flows.sign_in(&grants, A, "1.0.0", Caller::Service, &fixed, &|_: &str| Ok(())).unwrap(), json!({"status": "timeout"}));
        assert!(TcpListener::bind(("127.0.0.1", port)).is_ok(), "the fixed port is free again");
        // A flow of one package never blocks cancel or paste of another.
        assert!(!flows.cancel(B));
    }

    #[test]
    fn revoke_disable_untrust_stale_version_and_a_malformed_callback_dispose_the_flow() {
        let dir = Dir::new();
        let grants = setup(&dir);
        let flows = SignIns::default();
        let port = Mutex::new(String::new());
        let record = |authorize: &str| { *port.lock().unwrap() = redirect_of(authorize); Ok(()) };
        // Denied before anything opens: no grant, a panel, a stale version, an unknown package.
        let opened = AtomicBool::new(false);
        let probe = |_: &str| { opened.store(true, Ordering::SeqCst); Ok(()) };
        assert_eq!(flows.sign_in(&grants, A, "1.0.0", Caller::Panel, &options(json!({})), &probe).unwrap_err(), "UnsupportedCapability");
        assert_eq!(flows.sign_in(&grants, A, "0.9.0", Caller::Service, &options(json!({})), &probe).unwrap_err(), "PermissionDenied");
        assert_eq!(flows.sign_in(&grants, "sample.unknown", "1.0.0", Caller::Service, &options(json!({})), &probe).unwrap_err(), "PermissionDenied");
        grants.revoke(B, PERMISSION).unwrap();
        assert_eq!(flows.sign_in(&grants, B, "1.0.0", Caller::Service, &options(json!({})), &probe).unwrap_err(), "PermissionDenied");
        grants.grant(B, PERMISSION, Scope::default()).unwrap();
        assert!(!opened.load(Ordering::SeqCst));
        // Each way the authority goes away while the flow waits ends it and frees the port.
        for (name, end) in [
            ("revoke", Box::new(|| grants.revoke(A, PERMISSION).unwrap()) as Box<dyn Fn() + Sync>),
            ("disable", Box::new(|| grants.archive(A, true).unwrap()) as Box<dyn Fn() + Sync>),
            ("untrust", Box::new(|| grants.trust(A, false).unwrap()) as Box<dyn Fn() + Sync>),
        ] {
            std::thread::scope(|scope| {
                let call = scope.spawn(|| flows.sign_in(&grants, A, "1.0.0", Caller::Service, &options(json!({})), &record));
                wait_for(&flows, true);
                end();
                assert_eq!(call.join().unwrap().unwrap_err(), "PermissionDenied", "{name}");
            });
            assert!(flows.projection()["flows"].as_array().unwrap().is_empty(), "{name}");
            assert!(port_is_free(&port.lock().unwrap()), "{name}");
            grants.archive(A, false).unwrap(); grants.trust(A, true).unwrap(); grants.grant(A, PERMISSION, Scope::default()).unwrap();
        }
        // Malformed callbacks: garbage, a wrong method, an absolute-form target.
        for raw in ["\u{1}\u{2}garbage\r\n\r\n", "POST /callback HTTP/1.1\r\n\r\n", "GET http://evil.example/callback HTTP/1.1\r\n\r\n", "GET /callback\r\n\r\n", "no line terminator"] {
            let raw = raw.to_owned();
            let result = flows.sign_in(&grants, A, "1.0.0", Caller::Service, &options(json!({})), &|authorize: &str| { let redirect = redirect_of(authorize); *port.lock().unwrap() = redirect.clone(); let _ = browser(&redirect, raw.clone()); Ok(()) });
            assert_eq!(result.unwrap_err(), "InvalidShape", "{raw:?}");
            assert!(flows.projection()["flows"].as_array().unwrap().is_empty() && port_is_free(&port.lock().unwrap()), "{raw:?}");
        }
        // The flow can start again afterwards.
        assert_eq!(flows.sign_in(&grants, A, "1.0.0", Caller::Service, &options(json!({"timeoutMs": 50})), &|_: &str| Ok(())).unwrap(), json!({"status": "timeout"}));
    }

    #[test]
    fn options_are_validated_before_anything_binds_or_opens() {
        let dir = Dir::new();
        let grants = setup(&dir);
        let flows = SignIns::default();
        let opened = AtomicBool::new(false);
        let probe = |_: &str| { opened.store(true, Ordering::SeqCst); Ok(()) };
        for (params, why) in [
            (json!({}), "nothing"), (json!("x"), "not an object"), (options(json!({"extra": 1})), "extra field"),
            (options(json!({"authorizeUrl": "file:///etc/passwd"})), "file scheme"), (options(json!({"authorizeUrl": "javascript:alert(1)"})), "script scheme"),
            (options(json!({"authorizeUrl": "http://user:pw@127.0.0.1/a"})), "userinfo"), (options(json!({"authorizeUrl": "not an address"})), "not an address"),
            (options(json!({"authorizeUrl": 5})), "non-string address"), (options(json!({"callback": "/callback"})), "callback not an object"),
            (options(json!({"callback": {}})), "no path"), (options(json!({"callback": {"path": "callback"}})), "relative path"),
            (options(json!({"callback": {"path": "/a?b=1"}})), "query in path"), (options(json!({"callback": {"path": "/a b"}})), "space in path"),
            (options(json!({"callback": {"path": "/c", "port": 0}})), "port 0"), (options(json!({"callback": {"path": "/c", "port": 70000}})), "port too large"),
            (options(json!({"callback": {"path": "/c", "host": "evil.example"}})), "other host"), (options(json!({"callback": {"path": "/c", "extra": 1}})), "extra callback field"),
            (options(json!({"timeoutMs": 0})), "zero timeout"), (options(json!({"timeoutMs": MAX_TIMEOUT_MS + 1})), "timeout above 900000"), (options(json!({"timeoutMs": "5"})), "string timeout"),
            (options(json!({"manual": "yes"})), "manual not boolean"), (options(json!({"title": "x".repeat(121)})), "long title"), (options(json!({"title": "bad\ntitle"})), "control in title"),
        ] { assert_eq!(flows.sign_in(&grants, A, "1.0.0", Caller::Service, &params, &probe).unwrap_err(), "InvalidArguments", "{why}"); }
        assert!(!opened.load(Ordering::SeqCst));
        // The maximum timeout and an address without a placeholder are accepted (cancelled at once).
        for params in [options(json!({"timeoutMs": MAX_TIMEOUT_MS})), options(json!({"authorizeUrl": "https://login.example.com/authorize?client_id=x"}))] {
            std::thread::scope(|scope| {
                let call = scope.spawn(|| flows.sign_in(&grants, A, "1.0.0", Caller::Service, &params, &|_: &str| Ok(())));
                wait_for(&flows, true); flows.cancel(A);
                assert_eq!(call.join().unwrap().unwrap()["status"], "cancelled");
            });
        }
    }

    #[test]
    fn with_no_browser_the_notice_carries_the_address_to_copy_and_only_the_manual_path_continues() {
        let dir = Dir::new();
        let grants = setup(&dir);
        let flows = SignIns::default();
        assert_eq!(flows.sign_in(&grants, A, "1.0.0", Caller::Service, &options(json!({})), &never_open).unwrap_err(), "HostUnavailable");
        assert!(flows.projection()["flows"].as_array().unwrap().is_empty());
        std::thread::scope(|scope| {
            let call = scope.spawn(|| flows.sign_in(&grants, A, "1.0.0", Caller::Service, &options(json!({"manual": true})), &never_open));
            wait_for(&flows, true);
            let notice = flows.projection();
            let copy = notice["flows"][0]["copyAddress"].as_str().unwrap().to_owned();
            assert!(copy.starts_with("http://127.0.0.1:9/authorize?") && copy.contains("redirect_uri=http%3A%2F%2F127.0.0.1%3A"));
            let redirect = redirect_of(&copy);
            flows.paste(A, &format!("{redirect}?code=by-hand")).unwrap();
            assert_eq!(call.join().unwrap().unwrap()["via"], "manual");
        });
        let opened_ok = open_browser("file:///etc/passwd");
        assert_eq!(opened_ok.unwrap_err(), "InvalidArguments", "the one opener refuses a non-http address before running anything");
    }

    #[cfg(windows)]
    mod with_fake_backends {
        use super::*;
        use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
        use sha2::{Digest, Sha256};
        use std::{io::BufRead, os::windows::process::CommandExt, process::{Child, Command, Stdio}};

        fn script(name: &str) -> PathBuf { std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/extensions/backends").join(name) }
        fn node(args: &[&std::ffi::OsStr], env: &[(&str, &str)]) -> Child {
            let mut command = Command::new("node");
            command.args(args).envs(env.iter().copied()).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).creation_flags(0x08000000);
            command.spawn().expect("Node is required for the fake backends")
        }
        /// B3: the identity listener address of a started fake cloud.
        struct Cloud { child: Child, identity: String }
        impl Cloud {
            fn start() -> Self {
                let mut child = node(&[script("fake-cloud/fake-cloud.mjs").as_os_str()], &[]);
                let mut line = String::new();
                std::io::BufReader::new(child.stdout.take().unwrap()).read_line(&mut line).unwrap();
                let ready: Value = serde_json::from_str(&line).unwrap();
                assert_eq!(ready["ready"], true);
                Self { identity: ready["identity"].as_str().unwrap().trim_end_matches('/').to_owned(), child }
            }
            fn post_form(&self, path: &str, body: &str) -> Value {
                let address = self.identity.trim_start_matches("http://");
                let mut stream = TcpStream::connect(address).unwrap();
                stream.write_all(format!("POST {path} HTTP/1.0\r\nHost: {address}\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).unwrap();
                let mut text = String::new(); stream.read_to_string(&mut text).unwrap();
                serde_json::from_str(text.split_once("\r\n\r\n").unwrap().1).unwrap()
            }
        }
        impl Drop for Cloud {
            fn drop(&mut self) {
                drop(self.child.stdin.take());
                let started = Instant::now();
                while self.child.try_wait().ok().flatten().is_none() { if started.elapsed() > Duration::from_secs(5) { let _ = self.child.kill(); break; } std::thread::sleep(Duration::from_millis(20)); }
                let _ = self.child.wait();
            }
        }
        /// The browser finishes on its own with stdin open (EOF would abort it); only a hang is stopped by closing it.
        fn finish(mut child: Child) {
            let started = Instant::now();
            loop {
                if let Some(status) = child.try_wait().unwrap() { assert!(status.success(), "the fake browser followed the redirects"); return; }
                if started.elapsed() > Duration::from_secs(10) { drop(child.stdin.take()); let _ = child.kill(); let _ = child.wait(); panic!("the fake browser did not exit"); }
                std::thread::sleep(Duration::from_millis(20));
            }
        }

        #[test]
        fn the_fake_browser_and_the_fake_identity_server_complete_the_flow_and_the_package_stores_the_token_in_its_own_secrets() {
            let dir = Dir::new();
            let grants = setup(&dir);
            let flows = SignIns::default();
            let secrets = PrivateSecrets::open(&dir.0);
            let cloud = Cloud::start();
            let verifier = ["canary", "verifier", "r0803", "0123456789abcdefghijklmnopqrstuvwxyz"].join("-");
            let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
            let authorize = format!("{}/authorize?response_type=code&client_id=sample&redirect_uri={{redirect_uri}}&state=s-1&code_challenge={challenge}&code_challenge_method=S256&scope=read", cloud.identity);
            let browsers = Mutex::new(vec![]);
            let result = flows.sign_in(&grants, A, "1.0.0", Caller::Service, &options(json!({"authorizeUrl": authorize})), &|url: &str| {
                browsers.lock().unwrap().push(node(&[script("fake-browser/fake-browser.mjs").as_os_str(), std::ffi::OsStr::new(url)], &[("FAKE_BROWSER", "follow")]));
                Ok(())
            }).unwrap();
            for child in browsers.lock().unwrap().drain(..) { finish(child); }
            assert_eq!(result["status"], "completed");
            assert_eq!(result["via"], "callback");
            let redirect = result["redirectUri"].as_str().unwrap().to_owned();
            let url = tauri::Url::parse(result["url"].as_str().unwrap()).unwrap();
            let query: HashMap<String, String> = url.query_pairs().into_owned().collect();
            assert_eq!(query["state"], "s-1");
            // The package, not the host, exchanges the code and keeps the token through its own secrets.
            let token = cloud.post_form("/token", &format!("grant_type=authorization_code&code={}&client_id=sample&redirect_uri={}&code_verifier={verifier}", encode(&query["code"]), encode(&redirect)));
            let access = token["access_token"].as_str().expect("the identity server answered a token").to_owned();
            assert!(access.starts_with("tok-"));
            assert_eq!(secrets.handle(&grants, A, "1.0.0", runtime_private_secrets::Caller::Service, "secrets.set", &json!({"key": "access-token", "value": access})).unwrap(), Value::Null);
            assert_eq!(secrets.handle(&grants, A, "1.0.0", runtime_private_secrets::Caller::Service, "secrets.get", &json!({"key": "access-token"})).unwrap(), json!({"value": access}));
            assert_eq!(secrets.handle(&grants, B, "1.0.0", runtime_private_secrets::Caller::Service, "secrets.get", &json!({"key": "access-token"})).unwrap(), json!({"value": null}));
            // Nothing a panel or the webview can read carries the code or the token.
            for visible in [flows.projection().to_string(), secrets.projection().to_string(), format!("{:?}", flows.projection())] {
                assert!(!visible.contains(&access) && !visible.contains(&query["code"]) && !visible.contains(&verifier), "{visible}");
            }
            assert_eq!(secrets.handle(&grants, A, "1.0.0", runtime_private_secrets::Caller::Panel, "secrets.get", &json!({"key": "access-token"})).unwrap_err(), "UnsupportedCapability");
            assert!(port_is_free(&redirect), "no listener is left");
            // A used code does not work twice: the flow is one-shot and the host kept nothing to replay.
            assert!(cloud.post_form("/token", &format!("grant_type=authorization_code&code={}&client_id=sample&redirect_uri={}&code_verifier={verifier}", encode(&query["code"]), encode(&redirect))).get("access_token").is_none());
        }

        #[test]
        fn a_user_who_never_finishes_ends_as_timeout_with_the_fake_browser_ignoring_the_address() {
            let dir = Dir::new();
            let grants = setup(&dir);
            let flows = SignIns::default();
            let cloud = Cloud::start();
            let authorize = format!("{}/authorize?response_type=code&client_id=sample&redirect_uri={{redirect_uri}}&state=s-2&code_challenge=abc&code_challenge_method=S256&scope=read", cloud.identity);
            let log = dir.0.join("browser.log");
            let browsers = Mutex::new(vec![]);
            let result = flows.sign_in(&grants, A, "1.0.0", Caller::Service, &options(json!({"authorizeUrl": authorize, "timeoutMs": 300})), &|url: &str| {
                browsers.lock().unwrap().push(node(&[script("fake-browser/fake-browser.mjs").as_os_str(), std::ffi::OsStr::new(url)], &[("FAKE_BROWSER", "record"), ("FAKE_BROWSER_LOG", log.to_str().unwrap())]));
                Ok(())
            }).unwrap();
            for child in browsers.lock().unwrap().drain(..) { finish(child); }
            assert_eq!(result, json!({"status": "timeout"}));
            let recorded = std::fs::read_to_string(&log).unwrap();
            assert!(recorded.contains("/authorize?") && recorded.contains("redirect_uri=http%3A%2F%2F127.0.0.1%3A") && recorded.contains("state=s-2"), "{recorded}");
        }
    }
}
