//! Local web UI: serves the live PandaCode session over HTTP + WebSocket on a chosen port,
//! so a browser drives the same session as the desktop window (or a `pandacode serve`
//! host). Off unless explicitly turned on: a saved `enabled: true`, Settings, the desktop
//! `--port`/`--web-port` flags or `PANDACODE_WEB_PORT`, or `pandacode serve --port`.
//!
//! Every API call carries the session token (a fresh 256-bit value per start, compared in
//! constant time, failures rate limited per peer). A loopback listener only answers to a
//! loopback `Host` (DNS rebinding), and `/api/*` refuses a cross-site `Origin` (CSRF and
//! cross-site WebSocket hijacking). `POST /api/invoke` runs a command exactly as the main
//! webview would, through `Webview::on_message`, so the same handler and ACL apply.

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, RwLock};
use std::time::{Duration, Instant};
use tauri::{Emitter, Listener, Manager};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpSocket, TcpStream};
use tokio::sync::{broadcast, oneshot, watch, Semaphore};
use tokio_tungstenite::tungstenite::handshake::derive_accept_key;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::{CloseFrame, Role, WebSocketConfig};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;

/// Port used until the user picks another (next to the bots' web chat on 47321).
pub(crate) const DEFAULT_PORT: u16 = 47_322;
const CONFIG_FILE: &str = "web-server.json";
/// Emitted (with a [`WebServerStatus`]) whenever the server starts, stops, rotates its
/// token or gains or loses a client.
const CHANGED_EVENT: &str = "web-server-changed";
const MAX_HEAD: usize = 32 * 1024;
const MAX_BODY: usize = 32 * 1024 * 1024;
/// Opt-in trusted `Host` names: enough for a few MagicDNS and proxy names, small enough that
/// every request's check stays trivial.
const MAX_ALLOWED_HOSTS: usize = 32;
const MAX_ALLOWED_HOST_LEN: usize = 253;
/// Client frames are tiny control messages (auth, subscribe, unsubscribe, ping); this
/// bounds what an unauthenticated socket can make the server buffer.
const MAX_WS_MESSAGE: usize = 16 * 1024;
const MAX_EVENT_NAMES: usize = 128;
const MAX_EVENT_NAME_LEN: usize = 128;
const MAX_COMMAND_LEN: usize = 256;
const MAX_CONNECTIONS: usize = 256;
const MAX_CONNECTIONS_PER_IP: usize = 32;
/// Loopback is every local user plus every SSH-tunnelled session, so it gets a bigger share
/// (still inside [`MAX_CONNECTIONS`]): one local process holding sockets can't starve tunnels.
const MAX_LOOPBACK_CONNECTIONS: usize = 128;
/// Hard bound on the failed-auth table, however many addresses fail within one window.
const MAX_AUTH_LIMITER_ENTRIES: usize = 4096;
const DEFAULT_HOST: IpAddr = IpAddr::V4(Ipv4Addr::LOCALHOST);
const MAX_FAILURES: u32 = 20;
const FAILURE_WINDOW: Duration = Duration::from_secs(60);
const AUTH_TIMEOUT: Duration = Duration::from_secs(10);
const PING_EVERY: Duration = Duration::from_secs(25);
/// Whole request head, from the first byte awaited (not reset per chunk: no slowloris).
const HEAD_TIMEOUT: Duration = Duration::from_secs(10);
/// Whole request body, read only for an authorized `POST /api/invoke`.
const BODY_TIMEOUT: Duration = Duration::from_secs(30);
/// Whole response: a client that won't read can't hold a connection slot.
const WRITE_TIMEOUT: Duration = Duration::from_secs(15);
/// How long a stop waits for the old listener to let go of its port.
const RELEASE_TIMEOUT: Duration = Duration::from_secs(2);
/// Lets the tab that rotated the token get its reply before old sockets are closed.
/// Longest a web request waits for one command, so a hung command can't pin a connection.
const INVOKE_TIMEOUT: Duration = Duration::from_secs(300);
const ROTATE_DELAY: Duration = Duration::from_millis(250);
/// How long a stop waits for clients to take their close frames before cutting them off.
const STOP_GRACE: Duration = Duration::from_secs(2);
const CLOSE_DRAIN: Duration = Duration::from_secs(1);
const EVENT_BUFFER: usize = 1024;
const CLOSE_AWAY: u16 = 1001;
const CLOSE_UNAUTHORIZED: u16 = 4001;
const WEB_META: &str = r#"<meta name="pandacode-web" content="1"/>"#;

/// The page's policy: sockets only back to this server's own authority.
fn csp(authority: &str) -> String {
    format!(
        "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws://{authority} wss://{authority}; font-src 'self' data:; worker-src 'self'; object-src 'none'; base-uri 'self'; frame-src 'none'"
    )
}

type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;
/// One app event for the WebSocket clients: (name, raw JSON payload).
type HubEvent = Arc<(String, String)>;

// ---- Saved configuration ----

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
struct Config {
    enabled: bool,
    port: u16,
    /// The bind address to use on the next start; `None` is loopback, which keeps old files
    /// and the common case clean.
    #[serde(skip_serializing_if = "Option::is_none")]
    host: Option<IpAddr>,
    /// Opt-in extra `Host` names that a loopback or bound listener may answer to (for
    /// example a MagicDNS name behind Tailscale Serve). Never a substitute for the token.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    allowed_hosts: Vec<String>,
}

impl Default for Config {
    fn default() -> Self {
        Self { enabled: false, port: DEFAULT_PORT, host: None, allowed_hosts: Vec::new() }
    }
}

impl Config {
    fn bind_host(&self) -> IpAddr {
        self.host.unwrap_or(DEFAULT_HOST)
    }
}

/// A missing or unreadable file is the default: off. Trusted names are normalized on load so
/// a hand-edited file can never put a scheme, port or upper-case name into live checks.
fn load_config(dir: &Path) -> Config {
    let mut config: Config = std::fs::read(dir.join(CONFIG_FILE))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    let mut names = Vec::new();
    for entry in &config.allowed_hosts {
        let Ok(name) = normalize_allowed_host(entry) else { continue };
        if names.len() < MAX_ALLOWED_HOSTS && !names.contains(&name) {
            names.push(name);
        }
    }
    config.allowed_hosts = names;
    config
}

/// A bare DNS name or IP literal, lowercased, as compared against a `Host` name. An IPv6
/// literal is kept bracketed, the form [`split_host`] returns.
fn normalize_allowed_host(entry: &str) -> Result<String, String> {
    let text = entry.trim().to_ascii_lowercase();
    if text.is_empty() {
        return Err("A trusted host name cannot be empty.".into());
    }
    if text.len() > MAX_ALLOWED_HOST_LEN {
        return Err(format!("`{text}` is too long for a host name."));
    }
    let bare = text.strip_prefix('[').and_then(|rest| rest.strip_suffix(']')).unwrap_or(&text);
    if let Ok(ip) = bare.parse::<IpAddr>() {
        return Ok(match ip.to_canonical() {
            IpAddr::V4(ip) => ip.to_string(),
            IpAddr::V6(ip) => format!("[{ip}]"),
        });
    }
    if text.contains(':') {
        return Err(format!("`{entry}` must be a host name without a port."));
    }
    // No scheme, path, userinfo, query or fragment can survive a DNS-label check.
    let label = |part: &str| {
        !part.is_empty()
            && part.len() <= 63
            && !part.starts_with('-')
            && !part.ends_with('-')
            && part.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    };
    if !text.split('.').all(label) {
        return Err(format!("`{entry}` is not a bare host name (for example my-mac.tail1234.ts.net)."));
    }
    Ok(text)
}

/// A whole trusted-name list: each entry normalized, no duplicates, bounded in count.
pub(crate) fn validate_allowed_hosts(entries: &[String]) -> Result<Vec<String>, String> {
    if entries.len() > MAX_ALLOWED_HOSTS {
        return Err(format!("At most {MAX_ALLOWED_HOSTS} trusted host names are allowed."));
    }
    let mut seen = HashSet::new();
    let mut names = Vec::with_capacity(entries.len());
    for entry in entries {
        let name = normalize_allowed_host(entry)?;
        if !seen.insert(name.clone()) {
            return Err(format!("`{name}` is listed twice."));
        }
        names.push(name);
    }
    Ok(names)
}

/// Temp file + rename, so a crash never leaves a half-written file; 0600 on Unix.
fn save_config(dir: &Path, config: Config) -> Result<(), String> {
    let mut config = config;
    if config.host == Some(DEFAULT_HOST) {
        config.host = None;
    }
    config.allowed_hosts = validate_allowed_hosts(&config.allowed_hosts)?;
    let path = dir.join(CONFIG_FILE);
    let temp = dir.join(format!(".{CONFIG_FILE}.{}.tmp", uuid::Uuid::new_v4().simple()));
    let data = serde_json::to_vec_pretty(&config).map_err(|error| error.to_string())?;
    let written = (|| -> std::io::Result<()> {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let mut file = options.open(&temp)?;
        std::io::Write::write_all(&mut file, &data)?;
        file.sync_all()?;
        std::fs::rename(&temp, &path)
    })();
    written.map_err(|error| {
        let _ = std::fs::remove_file(&temp);
        format!("Could not save the web server settings: {error}")
    })
}

// ---- CLI ----

/// A port, an optional address and optional trusted `Host` names asked for on the command
/// line or in the environment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CliWeb {
    pub port: u16,
    pub host: Option<IpAddr>,
    pub allowed_hosts: Vec<String>,
}

pub(crate) fn parse_port(text: &str) -> Result<u16, String> {
    text.trim().parse::<u16>().map_err(|_| format!("`{text}` is not a port (0-65535; 0 picks a free one)."))
}

pub(crate) fn parse_host(text: &str) -> Result<IpAddr, String> {
    let trimmed = text.trim();
    let bare = trimmed.strip_prefix('[').and_then(|rest| rest.strip_suffix(']')).unwrap_or(trimmed);
    bare.parse::<IpAddr>().map_err(|_| format!("`{text}` is not an IP address (for example 127.0.0.1 or ::1)."))
}

/// The desktop's `--port`/`--web-port <PORT>`, `--host`/`--web-host <ADDR>` and repeatable
/// `--allowed-host <NAME>` (also `--flag=value`), falling back to `PANDACODE_WEB_PORT`,
/// `PANDACODE_WEB_HOST` and comma-separated `PANDACODE_WEB_ALLOWED_HOSTS`. Other arguments
/// are not ours and are skipped. `None` when no port was asked for.
pub(crate) fn parse_cli(
    args: &[String],
    env_port: Option<&str>,
    env_host: Option<&str>,
    env_allowed: Option<&str>,
) -> Result<Option<CliWeb>, String> {
    let mut port: Option<u16> = None;
    let mut host: Option<IpAddr> = None;
    let mut allowed_hosts: Vec<String> = Vec::new();
    let mut allowed_from_flag = false;
    let mut index = 0;
    while index < args.len() {
        let arg = args[index].as_str();
        let (flag, inline) = match arg.split_once('=') {
            Some((flag, value)) if flag.starts_with("--") => (flag, Some(value)),
            _ => (arg, None),
        };
        let is_port = matches!(flag, "--port" | "--web-port");
        let is_host = matches!(flag, "--host" | "--web-host");
        let is_allowed = flag == "--allowed-host";
        if is_port || is_host || is_allowed {
            let value = match inline {
                Some(value) => value,
                None => {
                    index += 1;
                    args.get(index).map(String::as_str).ok_or_else(|| format!("{flag} needs a value."))?
                }
            };
            if is_port {
                port = Some(parse_port(value)?);
            } else if is_host {
                host = Some(parse_host(value)?);
            } else {
                allowed_hosts.push(normalize_allowed_host(value)?);
                allowed_from_flag = true;
            }
        }
        index += 1;
    }
    let port_from_flag = port.is_some();
    if port.is_none() {
        port = env_port.filter(|value| !value.trim().is_empty()).map(parse_port).transpose()?;
    }
    if host.is_some() && port.is_none() {
        return Err("--host requires --port.".into());
    }
    if allowed_from_flag && port.is_none() {
        return Err("--allowed-host requires --port.".into());
    }
    // The environment's host and trusted names go only with the environment's port: a stale
    // `PANDACODE_WEB_HOST=0.0.0.0` must never expose an explicit `--port` (loopback then).
    if !port_from_flag {
        if host.is_none() {
            host = env_host.filter(|value| !value.trim().is_empty()).map(parse_host).transpose()?;
        }
        if !allowed_from_flag {
            allowed_hosts = parse_allowed_env(env_allowed)?;
        }
    }
    let allowed_hosts = validate_allowed_hosts(&allowed_hosts)?;
    Ok(port.map(|port| CliWeb { port, host, allowed_hosts }))
}

/// `PANDACODE_WEB_ALLOWED_HOSTS`, comma-separated; blank entries are not names.
fn parse_allowed_env(value: Option<&str>) -> Result<Vec<String>, String> {
    let Some(value) = value else { return Ok(Vec::new()) };
    let entries: Vec<String> =
        value.split(',').map(str::trim).filter(|entry| !entry.is_empty()).map(str::to_owned).collect();
    validate_allowed_hosts(&entries)
}

/// [`parse_cli`] over this process's arguments and environment.
pub(crate) fn cli_from_env() -> Result<Option<CliWeb>, String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let port = std::env::var("PANDACODE_WEB_PORT").ok();
    let host = std::env::var("PANDACODE_WEB_HOST").ok();
    let allowed = std::env::var("PANDACODE_WEB_ALLOWED_HOSTS").ok();
    parse_cli(&args, port.as_deref(), host.as_deref(), allowed.as_deref())
}

// ---- What the server needs from the app ----

#[derive(Debug, PartialEq)]
enum Reply {
    Json(String),
    Bytes(Vec<u8>),
    Error(Value),
    Unknown,
    NotReady,
    TimedOut,
    /// The caller's token was rotated away before its request could act.
    Unauthorized,
}

struct StaticAsset {
    bytes: Vec<u8>,
    mime: String,
}

/// The app side of the server; a fake stands in for it in tests.
trait Backend: Send + Sync + 'static {
    fn invoke(&self, command: String, args: Value) -> BoxFuture<Reply>;
    /// `web_server_rotate_token` from a tab: rotates only if `expected` is still the token
    /// (see [`WebServer::rotate_if_token`]), never through the main window's queue.
    fn rotate_if_token(&self, expected: String) -> BoxFuture<Reply>;
    /// `web_server_configure` from a tab: applies only if `expected` is still the running
    /// server's token (see [`WebServer::configure`]), never through the main window's queue.
    fn configure_if_token(&self, expected: String, args: Value) -> BoxFuture<Reply>;
    /// `dev_proxy`: whether a `tauri dev` build may fetch a missing asset from the dev
    /// server (only for a loopback listener and a plain bundle path).
    fn asset(&self, path: String, dev_proxy: bool) -> BoxFuture<Option<StaticAsset>>;
    /// Forwards every app event named `name` to `sink` until [`Backend::unlisten`].
    fn listen(&self, name: &str, sink: broadcast::Sender<HubEvent>) -> ListenerId;
    fn unlisten(&self, id: ListenerId);
    fn changed(&self);
    /// Whether [`invoke`] refuses commands missing from `WEB_ALLOWED_COMMANDS`. Every real
    /// backend keeps the default; only test fakes that answer synthetic commands opt out.
    fn enforces_allowlist(&self) -> bool {
        true
    }
}

type ListenerId = tauri::EventId;

/// App events WebSocket clients asked for: one Tauri listener per name while at least one
/// client wants it (so the name cap can't be used up for good), fanned out to every client.
pub(crate) struct EventHub {
    tx: broadcast::Sender<HubEvent>,
    /// Name -> (Tauri listener, subscribed clients).
    names: Mutex<HashMap<String, (ListenerId, usize)>>,
}

impl EventHub {
    fn new() -> Self {
        Self { tx: broadcast::channel(EVENT_BUFFER).0, names: Mutex::new(HashMap::new()) }
    }

    /// One more client for `name`; the first one registers the app listener.
    fn subscribe(&self, backend: &dyn Backend, name: &str) -> Result<(), &'static str> {
        if !valid_event_name(name) {
            return Err("Invalid event name.");
        }
        if web_blocked_event(name) {
            return Err("This event is only available in the desktop app.");
        }
        let mut names = lock(&self.names);
        if let Some((_, count)) = names.get_mut(name) {
            *count += 1;
            return Ok(());
        }
        if names.len() >= MAX_EVENT_NAMES {
            return Err("Too many distinct events.");
        }
        let id = backend.listen(name, self.tx.clone());
        names.insert(name.to_owned(), (id, 1));
        Ok(())
    }

    /// One client fewer for `name`; the last one removes the app listener.
    fn unsubscribe(&self, backend: &dyn Backend, name: &str) {
        let mut names = lock(&self.names);
        let Some((id, count)) = names.get_mut(name) else { return };
        *count = count.saturating_sub(1);
        if *count == 0 {
            let id = *id;
            names.remove(name);
            backend.unlisten(id);
        }
    }

    #[cfg(test)]
    fn active(&self) -> usize {
        lock(&self.names).len()
    }
}

/// One client's subscriptions; every one is given back to the hub however the session ends.
struct Subscriptions {
    shared: Arc<Shared>,
    names: HashSet<String>,
}

impl Subscriptions {
    fn new(shared: Arc<Shared>) -> Self {
        Self { shared, names: HashSet::new() }
    }

    fn contains(&self, name: &str) -> bool {
        self.names.contains(name)
    }

    fn add(&mut self, name: String) -> Result<(), &'static str> {
        if self.names.contains(&name) {
            return Ok(());
        }
        if self.names.len() >= MAX_EVENT_NAMES {
            return Err("Too many subscriptions.");
        }
        self.shared.hub.subscribe(self.shared.backend.as_ref(), &name)?;
        self.names.insert(name);
        Ok(())
    }

    fn remove(&mut self, name: &str) {
        if self.names.remove(name) {
            self.shared.hub.unsubscribe(self.shared.backend.as_ref(), name);
        }
    }
}

impl Drop for Subscriptions {
    fn drop(&mut self) {
        for name in self.names.drain() {
            self.shared.hub.unsubscribe(self.shared.backend.as_ref(), &name);
        }
    }
}

/// Events aimed at the desktop window itself (its embedded browser, overlay, menu bar, the
/// quit and second-launch notices): app-wide listeners would see them too, so no tab may
/// subscribe.
fn web_blocked_event(name: &str) -> bool {
    const DESKTOP_ONLY: [&str; 9] = [
        "agent-ui-action",
        "overlay-open-task",
        "tray-open-session",
        "browser-state",
        "browser-element",
        "jev-frame",
        "app-quitting",
        "web-server-cli-started",
        "web-server-cli-failed",
    ];
    DESKTOP_ONLY.contains(&name)
}

/// Tauri's own rule (EventName::new panics on anything else), plus a length bound.
fn valid_event_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_EVENT_NAME_LEN
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'/' | b':' | b'_' | b'-'))
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

// ---- Server state ----

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebServerStatus {
    pub enabled: bool,
    pub running: bool,
    pub host: String,
    pub port: u16,
    pub configured_port: u16,
    /// The persisted bind address (`127.0.0.1` when the setting never picked one).
    pub configured_host: String,
    pub allowed_hosts: Vec<String>,
    pub url: Option<String>,
    pub token_url: Option<String>,
    /// Not secret: 0 when stopped, 1 at start, +1 on every rotation, so other windows and
    /// tabs (which only see redacted statuses) know to fetch the new link.
    pub token_generation: u64,
    pub clients: usize,
    pub error: Option<String>,
}

struct Running {
    shutdown_tx: watch::Sender<bool>,
    /// Fires [`ROTATE_DELAY`] after a rotation to close sockets on the retired token.
    rotate_tx: Arc<watch::Sender<u64>>,
    /// Bumped at once on rotation (see [`WebServerStatus::token_generation`]).
    token_generation: u64,
    bound_addr: SocketAddr,
    token: Arc<RwLock<String>>,
    /// The live trusted `Host` names; a Settings change writes here in place, so no restart
    /// and no token rotation is needed.
    allowed: Arc<RwLock<Vec<String>>>,
    /// Set once this server is stopped or replaced: its token then fails every check, so a
    /// request still in flight on it can't read the next server's link.
    retired: Arc<AtomicBool>,
    clients: Arc<AtomicUsize>,
    /// Fires once the accept loop has dropped its listener (the port is free); in-flight
    /// connections then drain in the background.
    listener_dropped: oneshot::Receiver<()>,
}

struct State {
    config: Config,
    host: IpAddr,
    running: Option<Running>,
    last_error: Option<String>,
    /// The last token generation handed out; every start and rotation takes the next, so
    /// it only ever grows, across restarts too.
    next_token_generation: u64,
}

impl State {
    fn next_generation(&mut self) -> u64 {
        self.next_token_generation += 1;
        self.next_token_generation
    }
}

pub struct WebServer {
    dir: PathBuf,
    state: Mutex<State>,
    /// Serializes start/stop so a port switch never races another.
    ops: tokio::sync::Mutex<()>,
    hub: Arc<EventHub>,
    /// Runs once right after the next settings save (tests land a rotation there).
    #[cfg(test)]
    after_save: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

/// Whether `expected` (a tab's token; `None` from the desktop) still belongs to the running
/// server. Checked under the state lock at the moment a change commits: rotation takes
/// that lock too, so nothing can rotate between this check and the commit.
fn caller_current(state: &State, expected: Option<&str>) -> bool {
    let Some(expected) = expected else { return true };
    state.running.as_ref().is_some_and(|running| {
        !running.retired.load(Ordering::Acquire) && same(expected, &running.token.read().unwrap_or_else(|poisoned| poisoned.into_inner()))
    })
}

/// Takes the running server out of `state` and retires it (its token fails from now on);
/// the receiver fires once its port is free.
fn take_running(state: &mut State) -> Option<oneshot::Receiver<()>> {
    let running = state.running.take()?;
    running.retired.store(true, Ordering::Release);
    let _ = running.shutdown_tx.send(true);
    Some(running.listener_dropped)
}

/// Waits (bounded) for a taken server's listener to go.
async fn released(listener_dropped: Option<oneshot::Receiver<()>>) {
    if let Some(listener_dropped) = listener_dropped {
        if tokio::time::timeout(RELEASE_TIMEOUT, listener_dropped).await.is_err() {
            eprintln!("Web server: the listener took too long to stop.");
        }
    }
}

const NOT_RUNNING: &str = "The web server is not running.";

/// Why a rotation didn't happen.
#[derive(Debug, PartialEq, Eq)]
enum RotateRefused {
    NotRunning,
    /// The caller's token is no longer the current one.
    Stale,
}

/// The arguments of `web_server_configure` (camelCase, as Tauri takes them).
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Configure {
    enabled: bool,
    port: Option<u16>,
    host: Option<String>,
    allowed_hosts: Option<Vec<String>>,
    persist: Option<bool>,
}

/// Why a Settings change didn't happen.
#[derive(Debug, PartialEq, Eq)]
enum ConfigureRefused {
    /// From a tab whose token no longer belongs to the running server.
    Stale,
    Failed(String),
}

/// A tab's `web_server_configure`, as an `/api/invoke` reply: the compare-and-swap on its
/// token, then the change, whose status (with the new link) goes to this caller alone.
async fn configure_reply(server: &WebServer, backend: Arc<dyn Backend>, expected: &str, args: Value) -> Reply {
    let change = match serde_json::from_value::<Configure>(args) {
        Ok(change) => change,
        Err(error) => return Reply::Error(Value::String(format!("Invalid arguments: {error}"))),
    };
    match server.configure(backend, change, Some(expected)).await {
        Ok(status) => serde_json::to_string(&status).map_or_else(|error| Reply::Error(Value::String(error.to_string())), Reply::Json),
        Err(ConfigureRefused::Stale) => Reply::Unauthorized,
        Err(ConfigureRefused::Failed(error)) => Reply::Error(Value::String(error)),
    }
}

/// A tab's rotation, as an `/api/invoke` reply.
fn rotate_reply(result: Result<WebServerStatus, RotateRefused>) -> Reply {
    match result {
        Ok(status) => serde_json::to_string(&status).map_or_else(|error| Reply::Error(Value::String(error.to_string())), Reply::Json),
        Err(RotateRefused::Stale) => Reply::Unauthorized,
        Err(RotateRefused::NotRunning) => Reply::Error(Value::String(NOT_RUNNING.to_owned())),
    }
}

/// 256 bits from the OS CSPRNG, as 64 lowercase hex characters.
fn new_token() -> String {
    use chacha20poly1305::aead::{rand_core::RngCore, OsRng};
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// `host:port` for a URL; an unspecified bind is browsed through loopback.
fn url_authority(addr: SocketAddr) -> String {
    match addr.ip().to_canonical() {
        IpAddr::V4(ip) if ip.is_unspecified() => format!("127.0.0.1:{}", addr.port()),
        IpAddr::V6(ip) if ip.is_unspecified() => format!("[::1]:{}", addr.port()),
        IpAddr::V4(ip) => format!("{ip}:{}", addr.port()),
        IpAddr::V6(ip) => format!("[{ip}]:{}", addr.port()),
    }
}

fn bind_error(ip: IpAddr, port: u16, error: &std::io::Error) -> String {
    match error.kind() {
        std::io::ErrorKind::AddrInUse => format!("Port {port} is already in use."),
        std::io::ErrorKind::PermissionDenied => format!("Permission denied for port {port}; pick a port above 1023."),
        std::io::ErrorKind::AddrNotAvailable => format!("Address {ip} is not available on this computer."),
        _ => format!("Could not listen on {}: {error}", url_authority(SocketAddr::new(ip, port))),
    }
}

/// SO_REUSEADDR on Unix so a just-stopped port (connections in TIME_WAIT) rebinds at once;
/// never on Windows, where it would let another process take the port over.
fn bind(ip: IpAddr, port: u16) -> Result<TcpListener, String> {
    let addr = SocketAddr::new(ip, port);
    let socket = if ip.is_ipv4() { TcpSocket::new_v4() } else { TcpSocket::new_v6() }.map_err(|error| bind_error(ip, port, &error))?;
    #[cfg(unix)]
    socket.set_reuseaddr(true).map_err(|error| bind_error(ip, port, &error))?;
    socket.bind(addr).map_err(|error| bind_error(ip, port, &error))?;
    socket.listen(1024).map_err(|error| bind_error(ip, port, &error))
}

impl WebServer {
    pub fn new(dir: PathBuf) -> Self {
        let config = load_config(&dir);
        let host = config.bind_host();
        Self {
            dir,
            state: Mutex::new(State { config, host, running: None, last_error: None, next_token_generation: 0 }),
            ops: tokio::sync::Mutex::new(()),
            hub: Arc::new(EventHub::new()),
            #[cfg(test)]
            after_save: Mutex::new(None),
        }
    }

    fn save(&self, config: Config) -> Result<(), String> {
        let saved = save_config(&self.dir, config);
        #[cfg(test)]
        if let Some(hook) = lock(&self.after_save).take() {
            hook();
        }
        saved
    }

    /// Puts back the saved setting a refused change had already written.
    fn restore_saved(&self, previous: Config) {
        if let Err(error) = save_config(&self.dir, previous) {
            eprintln!("Web server: could not restore the previous settings: {error}");
        }
    }

    pub fn status(&self) -> WebServerStatus {
        status_of(&lock(&self.state), None)
    }

    /// The status without the token, for anything broadcast (app events reach every
    /// subscribed WebSocket, including one whose token was just rotated out).
    pub fn status_redacted(&self) -> WebServerStatus {
        WebServerStatus { token_url: None, ..self.status() }
    }

    /// The address a Settings change binds: the one given, else the current one (a CLI
    /// `--host` while it runs, else the saved/default address).
    fn configure_ip(&self, host: Option<&str>) -> Result<IpAddr, String> {
        match host.map(str::trim).filter(|host| !host.is_empty()) {
            Some(host) => parse_host(host),
            None => Ok(lock(&self.state).host),
        }
    }

    /// Shows `message` as the status error (Settings -> Web access) without starting
    /// anything, as for a bad `--port` or `PANDACODE_WEB_*` at launch.
    pub fn record_error(&self, message: impl Into<String>) {
        lock(&self.state).last_error = Some(message.into());
    }

    fn fail(&self, error: String) -> String {
        lock(&self.state).last_error = Some(error.clone());
        error
    }

    /// Starts (or keeps) the server on `ip:port`. `persist` saves `enabled: true`; a start
    /// from the command line is for this session only.
    async fn start(&self, backend: Arc<dyn Backend>, ip: IpAddr, port: u16, persist: bool) -> Result<WebServerStatus, String> {
        self.start_allowed(backend, ip, port, persist, Vec::new()).await
    }

    /// [`WebServer::start`] with command-line trusted names; an empty list keeps the saved
    /// ones (a CLI start never rewrites the saved setting).
    async fn start_allowed(
        &self,
        backend: Arc<dyn Backend>,
        ip: IpAddr,
        port: u16,
        persist: bool,
        allowed: Vec<String>,
    ) -> Result<WebServerStatus, String> {
        let _op = self.ops.lock().await;
        let allowed = (!allowed.is_empty()).then_some(allowed);
        self.start_locked(backend, ip, port, persist, allowed, None).await.map_err(|refused| match refused {
            ConfigureRefused::Stale => "The access token changed.".to_owned(),
            ConfigureRefused::Failed(error) => error,
        })
    }

    /// [`WebServer::start`] with `ops` already held.
    async fn start_locked(
        &self,
        backend: Arc<dyn Backend>,
        ip: IpAddr,
        port: u16,
        persist: bool,
        allowed_hosts: Option<Vec<String>>,
        expected: Option<&str>,
    ) -> Result<WebServerStatus, ConfigureRefused> {
        let (current, previous) = {
            let state = lock(&self.state);
            (state.running.as_ref().map(|running| running.bound_addr), state.config.clone())
        };
        let allowed = allowed_hosts.unwrap_or_else(|| previous.allowed_hosts.clone());
        // Port 0 always asks the OS for a fresh port, even while running.
        let same = current.is_some_and(|addr| addr.ip() == ip && port != 0 && addr.port() == port);
        // Plain loopback is stored as `None`, keeping old files and the common case clean.
        let config = Config { enabled: true, port, host: (ip != DEFAULT_HOST).then_some(ip), allowed_hosts: allowed.clone() };
        if same {
            if persist {
                self.save(config.clone()).map_err(|error| ConfigureRefused::Failed(self.fail(error)))?;
            }
            let mut state = lock(&self.state);
            if !caller_current(&state, expected) {
                drop(state);
                if persist {
                    self.restore_saved(previous);
                }
                return Err(ConfigureRefused::Stale);
            }
            if persist {
                state.config = config;
            }
            // Trusted names apply in place, without a restart or a new token.
            if let Some(running) = state.running.as_ref() {
                *running.allowed.write().unwrap_or_else(|poisoned| poisoned.into_inner()) = allowed;
            }
            state.last_error = None;
            return Ok(status_of(&state, None));
        }
        // Bind the new address and save the setting first, so a busy port or a failed save
        // leaves the running server alone. Only a host change on the same port must release
        // the old socket before binding.
        let same_port_host_change = current.is_some_and(|addr| port != 0 && addr.port() == port);
        if same_port_host_change {
            let taken = {
                let mut state = lock(&self.state);
                if !caller_current(&state, expected) {
                    return Err(ConfigureRefused::Stale);
                }
                take_running(&mut state)
            };
            released(taken).await;
        }
        // Every failure from here on: when the old listener already stopped, nothing runs, so
        // a later Settings "on" (no host) binds the saved/default address, never an earlier
        // CLI `--host`.
        let failed = |error: String| {
            ConfigureRefused::Failed(if same_port_host_change {
                let fallback = lock(&self.state).config.bind_host();
                lock(&self.state).host = fallback;
                self.fail(format!("{error} The previous listener was stopped."))
            } else {
                self.fail(error)
            })
        };
        let listener = bind(ip, port).map_err(&failed)?;
        let bound_addr = listener.local_addr().map_err(|error| failed(error.to_string()))?;
        if persist {
            // On failure `listener` drops here and the old server (if still up) keeps running.
            self.save(config.clone()).map_err(&failed)?;
        }
        // Commit point: the caller is checked and the old server retired under one lock.
        let taken = {
            let mut state = lock(&self.state);
            if !same_port_host_change && !caller_current(&state, expected) {
                drop(state);
                drop(listener);
                if persist {
                    self.restore_saved(previous);
                }
                return Err(ConfigureRefused::Stale);
            }
            take_running(&mut state)
        };
        released(taken).await;
        let running = {
            let mut state = lock(&self.state);
            let generation = state.next_generation();
            launch(listener, bound_addr, backend, self.hub.clone(), generation, allowed)
        };
        let token = running.token.read().unwrap_or_else(|poisoned| poisoned.into_inner()).clone();
        let mut state = lock(&self.state);
        state.running = Some(running);
        state.host = ip;
        if persist {
            state.config = config;
        }
        state.last_error = None;
        // Built before the lock goes, from this start's own token: a rotation right after
        // can't put a newer token in this reply.
        Ok(status_of(&state, Some(&token)))
    }

    /// Stops the server; `persist` saves `enabled: false` with `port`.
    #[cfg(test)]
    async fn stop_and_save(&self, port: Option<u16>, persist: bool) -> Result<WebServerStatus, String> {
        let _op = self.ops.lock().await;
        self.stop_and_save_locked(port, persist, None, None, None).await.map_err(|refused| match refused {
            ConfigureRefused::Stale => "The access token changed.".to_owned(),
            ConfigureRefused::Failed(error) => error,
        })
    }

    /// [`WebServer::stop_and_save`] with `ops` already held. `host`: an address this change
    /// explicitly picked; otherwise the saved address is kept.
    async fn stop_and_save_locked(
        &self,
        port: Option<u16>,
        persist: bool,
        expected: Option<&str>,
        host: Option<IpAddr>,
        allowed_hosts: Option<Vec<String>>,
    ) -> Result<WebServerStatus, ConfigureRefused> {
        // Commit point: the caller is checked and the server retired under one lock.
        let taken = {
            let mut state = lock(&self.state);
            if !caller_current(&state, expected) {
                return Err(ConfigureRefused::Stale);
            }
            // A later "on" in Settings binds the saved address again, never an earlier
            // session-only CLI `--host`.
            state.host = state.config.bind_host();
            take_running(&mut state)
        };
        released(taken).await;
        let (port, host, allowed) = {
            let state = lock(&self.state);
            let allowed = allowed_hosts.unwrap_or_else(|| state.config.allowed_hosts.clone());
            (port.unwrap_or(state.config.port), host.or(state.config.host), allowed)
        };
        if persist {
            let config = Config { enabled: false, port, host, allowed_hosts: allowed };
            self.save(config.clone()).map_err(|error| ConfigureRefused::Failed(self.fail(error)))?;
            lock(&self.state).config = config;
        }
        let mut state = lock(&self.state);
        state.host = state.config.bind_host();
        state.last_error = None;
        Ok(status_of(&state, None))
    }

    /// A Settings change. `expected`: from a tab, the caller's token, checked against the
    /// running server under `ops` so a request queued behind the owner's own stop, restart
    /// or rotation changes nothing (and can't read the new link); `None` from the desktop.
    async fn configure(&self, backend: Arc<dyn Backend>, change: Configure, expected: Option<&str>) -> Result<WebServerStatus, ConfigureRefused> {
        let _op = self.ops.lock().await;
        // Checked now (nothing happens for a stale caller), and again where each change
        // commits, since a rotation doesn't wait for `ops`.
        if !caller_current(&lock(&self.state), expected) {
            return Err(ConfigureRefused::Stale);
        }
        // `false`: a change for this session only (a CLI-started server keeps its saved "off").
        let persist = change.persist.unwrap_or(true);
        let ip = self.configure_ip(change.host.as_deref()).map_err(ConfigureRefused::Failed)?;
        let host_given = change.host.as_deref().is_some_and(|host| !host.trim().is_empty());
        let allowed_hosts = match change.allowed_hosts {
            Some(entries) => Some(validate_allowed_hosts(&entries).map_err(ConfigureRefused::Failed)?),
            None => None,
        };
        if change.enabled {
            let port = change.port.unwrap_or_else(|| lock(&self.state).config.port);
            self.start_locked(backend, ip, port, persist, allowed_hosts, expected).await
        } else {
            self.stop_and_save_locked(change.port, persist, expected, host_given.then_some(ip), allowed_hosts).await
        }
    }

    /// Signals the accept loop and every client, then waits (bounded) only until the
    /// listener is dropped; in-flight requests finish their replies in the background.
    #[cfg(test)]
    async fn stop(&self) {
        let _op = self.ops.lock().await;
        let taken = take_running(&mut lock(&self.state));
        released(taken).await;
    }

    /// From the desktop window: always rotates.
    fn rotate(&self) -> Result<WebServerStatus, String> {
        self.rotate_checked(None).map_err(|refused| match refused {
            RotateRefused::NotRunning => NOT_RUNNING.to_owned(),
            RotateRefused::Stale => "The access token changed.".to_owned(),
        })
    }

    /// From a tab: a compare-and-swap on the caller's token, so a request queued behind the
    /// owner's own rotation can't rotate again and read the newer token.
    fn rotate_if_token(&self, expected: &str) -> Result<WebServerStatus, RotateRefused> {
        self.rotate_checked(Some(expected))
    }

    fn rotate_checked(&self, expected: Option<&str>) -> Result<WebServerStatus, RotateRefused> {
        {
            let mut state = lock(&self.state);
            let generation = state.next_token_generation + 1;
            let running = state.running.as_mut().ok_or(RotateRefused::NotRunning)?;
            // The check and the swap happen under one write lock: nothing rotates in between.
            let mut token = running.token.write().unwrap_or_else(|poisoned| poisoned.into_inner());
            if expected.is_some_and(|expected| !same(expected, &token)) {
                return Err(RotateRefused::Stale);
            }
            // The old token stops working now, for every new request and every event.
            let fresh = new_token();
            *token = fresh.clone();
            drop(token);
            running.token_generation = generation;
            // Open sockets close a moment later, so the tab that asked gets its reply (with
            // the new token) before its own socket sees 4001, even over a slow tunnel.
            let rotate_tx = running.rotate_tx.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(ROTATE_DELAY).await;
                rotate_tx.send_modify(|generation| *generation += 1);
            });
            state.next_token_generation = generation;
            // Built before the lock goes, from the token this call wrote: a rotation right
            // after can't put its newer token in this caller's reply.
            Ok(status_of(&state, Some(&fresh)))
        }
    }

    /// On app exit: stop listening and close every client; never blocks.
    pub fn shutdown(&self) {
        if let Some(running) = lock(&self.state).running.take() {
            running.retired.store(true, Ordering::Release);
            let _ = running.shutdown_tx.send(true);
        }
    }
}

/// The browsable link for a bound address. A loopback bind uses the address itself; with a
/// trusted name configured it uses the first name with `https://` instead, because a name can
/// only reach a loopback listener through a TLS terminator in front of it (Tailscale Serve),
/// which speaks HTTPS. A non-loopback bind keeps its plain-HTTP address.
fn status_url(bound: SocketAddr, allowed: &[String]) -> String {
    match allowed.first() {
        Some(name) if bound.ip().to_canonical().is_loopback() => format!("https://{name}:{}", bound.port()),
        _ => format!("http://{}", url_authority(bound)),
    }
}

/// The status as of `state` (whose lock the caller holds). `token`: the exact token a
/// rotation just wrote, so its reply never shows a later one; else the current token.
fn status_of(state: &State, token: Option<&str>) -> WebServerStatus {
    let running = state.running.as_ref();
    let allowed_hosts = match running {
        Some(running) => running.allowed.read().unwrap_or_else(|poisoned| poisoned.into_inner()).clone(),
        None => state.config.allowed_hosts.clone(),
    };
    let url = running.map(|running| status_url(running.bound_addr, &allowed_hosts));
    let token_url = running.zip(url.as_ref()).map(|(running, url)| match token {
        Some(token) => format!("{url}/#token={token}"),
        None => format!("{url}/#token={}", running.token.read().unwrap_or_else(|poisoned| poisoned.into_inner())),
    });
    WebServerStatus {
        enabled: state.config.enabled,
        running: running.is_some(),
        host: running.map_or(state.host, |running| running.bound_addr.ip()).to_string(),
        port: running.map_or(0, |running| running.bound_addr.port()),
        configured_port: state.config.port,
        configured_host: state.config.bind_host().to_string(),
        allowed_hosts,
        url,
        token_url,
        token_generation: running.map_or(0, |running| running.token_generation),
        clients: running.map_or(0, |running| running.clients.load(Ordering::SeqCst)),
        error: state.last_error.clone(),
    }
}

fn launch(
    listener: TcpListener,
    bound_addr: SocketAddr,
    backend: Arc<dyn Backend>,
    hub: Arc<EventHub>,
    token_generation: u64,
    allowed: Vec<String>,
) -> Running {
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let (rotate_tx, rotate_rx) = watch::channel(0u64);
    let token = Arc::new(RwLock::new(new_token()));
    let clients = Arc::new(AtomicUsize::new(0));
    let retired = Arc::new(AtomicBool::new(false));
    let allowed = Arc::new(RwLock::new(allowed));
    let shared = Arc::new(Shared {
        backend,
        hub,
        token: token.clone(),
        allowed: allowed.clone(),
        retired: retired.clone(),
        clients: clients.clone(),
        bound: bound_addr,
        limiter: Limiter::default(),
        shutdown: shutdown_rx,
        rotate: rotate_rx,
    });
    let (dropped_tx, listener_dropped) = oneshot::channel();
    tokio::spawn(accept_loop(listener, shared, dropped_tx));
    Running { shutdown_tx, rotate_tx: Arc::new(rotate_tx), token_generation, bound_addr, token, allowed, retired, clients, listener_dropped }
}

// ---- Tauri side ----

struct TauriBackend {
    app: tauri::AppHandle,
}

/// The URL a request from the bundled frontend carries, so `is_local_url` holds and the
/// main webview's local capabilities apply, exactly as for its own calls.
fn local_tauri_url() -> tauri::Url {
    tauri::Url::parse(if cfg!(windows) { "http://tauri.localhost/" } else { "tauri://localhost/" }).expect("static URL")
}

fn reply_from(command: &str, response: tauri::ipc::InvokeResponse) -> Reply {
    use tauri::ipc::{InvokeResponse, InvokeResponseBody};
    match response {
        InvokeResponse::Ok(InvokeResponseBody::Json(raw)) => Reply::Json(raw),
        InvokeResponse::Ok(InvokeResponseBody::Raw(bytes)) => Reply::Bytes(bytes),
        // Tauri's own wording for a command no handler took.
        InvokeResponse::Err(tauri::ipc::InvokeError(Value::String(message)))
            if message == format!("Command {command} not found") =>
        {
            Reply::Unknown
        }
        InvokeResponse::Err(tauri::ipc::InvokeError(value)) => Reply::Error(value),
    }
}

impl Backend for TauriBackend {
    fn configure_if_token(&self, expected: String, args: Value) -> BoxFuture<Reply> {
        let app = self.app.clone();
        Box::pin(async move {
            let Some(server) = app.try_state::<WebServer>() else { return Reply::NotReady };
            let reply = configure_reply(&server, backend(&app), &expected, args).await;
            if !matches!(reply, Reply::Unauthorized) {
                emit_changed(&app);
            }
            reply
        })
    }

    fn rotate_if_token(&self, expected: String) -> BoxFuture<Reply> {
        let app = self.app.clone();
        Box::pin(async move {
            let Some(server) = app.try_state::<WebServer>() else { return Reply::NotReady };
            let result = server.rotate_if_token(&expected);
            if result.is_ok() {
                emit_changed(&app);
            }
            rotate_reply(result)
        })
    }

    fn invoke(&self, command: String, args: Value) -> BoxFuture<Reply> {
        let app = self.app.clone();
        Box::pin(async move {
            let Some(webview) = app.get_webview_window("main") else { return Reply::NotReady };
            let (tx, rx) = oneshot::channel();
            let request = tauri::webview::InvokeRequest {
                cmd: command.clone(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: local_tauri_url(),
                body: tauri::ipc::InvokeBody::Json(args),
                headers: Default::default(),
                invoke_key: app.invoke_key().to_owned(),
            };
            let responder: Box<tauri::ipc::OwnedInvokeResponder<tauri::Wry>> = Box::new(move |_, _, response, _, _| {
                let _ = tx.send(response);
            });
            // Sync commands run where the window's own calls do: on the main thread.
            if app.run_on_main_thread(move || webview.on_message(request, responder)).is_err() {
                return Reply::NotReady;
            }
            // A dropped responder (never resolved) means nothing handled the command.
            match tokio::time::timeout(INVOKE_TIMEOUT, rx).await {
                Ok(received) => received.map_or(Reply::Unknown, |response| reply_from(&command, response)),
                Err(_) => Reply::TimedOut,
            }
        })
    }

    fn asset(&self, path: String, dev_proxy: bool) -> BoxFuture<Option<StaticAsset>> {
        let app = self.app.clone();
        Box::pin(async move {
            let resolver = app.clone();
            let lookup = path.clone();
            let found = tauri::async_runtime::spawn_blocking(move || resolver.asset_resolver().get(lookup)).await.ok().flatten();
            if let Some(asset) = found {
                return Some(StaticAsset { bytes: asset.bytes, mime: asset.mime_type });
            }
            if !dev_proxy {
                return None;
            }
            dev_asset(&app, &path).await
        })
    }

    fn listen(&self, name: &str, sink: broadcast::Sender<HubEvent>) -> ListenerId {
        let owned = name.to_owned();
        self.app.listen_any(name.to_owned(), move |event| {
            // No receiver (no client connected) is fine.
            let _ = sink.send(Arc::new((owned.clone(), event.payload().to_owned())));
        })
    }

    fn unlisten(&self, id: ListenerId) {
        self.app.unlisten(id);
    }

    fn changed(&self) {
        emit_changed(&self.app);
    }
}

/// Whether a missing asset may come from the dev server: only for a loopback listener,
/// and never Vite's file-system and module routes (`@fs/`, `@id/`), which reach outside
/// the frontend.
fn dev_proxyable(path: &str, bound: SocketAddr) -> bool {
    let vite_route = ["@fs/", "@id/"].iter().any(|route| path.starts_with(route) || path.contains(&format!("/{route}")));
    bound.ip().to_canonical().is_loopback() && !vite_route
}

/// `tauri dev` without a built `dist/`: fetch the asset from the (loopback) dev server.
#[cfg(dev)]
async fn dev_asset(app: &tauri::AppHandle, path: &str) -> Option<StaticAsset> {
    let base = app.config().build.dev_url.clone()?;
    let host = base.host_str()?.trim_start_matches('[').trim_end_matches(']').to_owned();
    if host != "localhost" && !host.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback()) {
        return None;
    }
    let url = base.join(path).ok()?;
    if url.origin() != base.origin() || !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    let client = reqwest::Client::builder().timeout(Duration::from_secs(5)).build().ok()?;
    let response = client.get(url).send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    let mime = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_owned();
    let bytes = response.bytes().await.ok()?.to_vec();
    Some(StaticAsset { bytes, mime })
}

#[cfg(not(dev))]
async fn dev_asset(_app: &tauri::AppHandle, _path: &str) -> Option<StaticAsset> {
    None
}

fn emit_changed(app: &tauri::AppHandle) {
    if let Some(server) = app.try_state::<WebServer>() {
        // Never the token: app events reach every subscribed WebSocket.
        if let Err(error) = app.emit(CHANGED_EVENT, server.status_redacted()) {
            eprintln!("Web server: could not announce a status change: {error}");
        }
    }
}

fn backend(app: &tauri::AppHandle) -> Arc<dyn Backend> {
    Arc::new(TauriBackend { app: app.clone() })
}

#[tauri::command]
pub(crate) fn web_server_status(state: tauri::State<'_, WebServer>) -> WebServerStatus {
    state.status()
}

#[tauri::command]
pub(crate) async fn web_server_configure(
    app: tauri::AppHandle,
    state: tauri::State<'_, WebServer>,
    enabled: bool,
    port: Option<u16>,
    host: Option<String>,
    allowed_hosts: Option<Vec<String>>,
    persist: Option<bool>,
) -> Result<WebServerStatus, String> {
    let change = Configure { enabled, port, host, allowed_hosts, persist };
    let result = state.configure(backend(&app), change, None).await.map_err(|refused| match refused {
        ConfigureRefused::Stale => "The access token changed.".to_owned(),
        ConfigureRefused::Failed(error) => error,
    });
    emit_changed(&app);
    result
}

#[tauri::command]
pub(crate) fn web_server_rotate_token(app: tauri::AppHandle, state: tauri::State<'_, WebServer>) -> Result<WebServerStatus, String> {
    let status = state.rotate()?;
    emit_changed(&app);
    Ok(status)
}

#[tauri::command]
pub(crate) fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_owned()
}

/// Starts on `port` for this session (CLI or environment); the saved setting is untouched.
pub(crate) async fn start_cli(app: &tauri::AppHandle, port: u16, host: Option<IpAddr>, allowed_hosts: &[String]) -> Result<WebServerStatus, String> {
    let state = app.try_state::<WebServer>().ok_or("The web server is not set up.")?;
    let result = state.start_allowed(backend(app), host.unwrap_or(DEFAULT_HOST), port, false, allowed_hosts.to_vec()).await;
    emit_changed(app);
    result
}

/// Where a command-line start listens, plus a warning when that is plain HTTP off loopback.
pub(crate) fn print_start_notice(status: &WebServerStatus, host: Option<IpAddr>) {
    println!("PandaCode web UI listening on {}", status.token_url.as_deref().unwrap_or_default());
    let ip = host.or_else(|| status.host.parse().ok());
    if ip.is_some_and(|ip| !ip.to_canonical().is_loopback()) {
        eprintln!(
            "{}",
            non_loopback_warning(status.port)
        );
    }
}

fn non_loopback_warning(port: u16) -> String {
    format!(
        "Warning: the web UI is plain HTTP on a non-loopback address; the access token and everything you do \
         travel unencrypted. Prefer 127.0.0.1 over an SSH tunnel (ssh -L {port}:127.0.0.1:{port} <host>), or bind \
         a private WireGuard/Tailscale interface IP. Tailscale Serve in front of 127.0.0.1 plus --allowed-host \
         <name> gives HTTPS without a non-loopback bind."
    )
}

/// [`start_cli`] from synchronous code outside the async runtime (setup).
pub(crate) fn start_from_cli(app: &tauri::AppHandle, port: u16, host: Option<IpAddr>, allowed_hosts: &[String]) -> Result<WebServerStatus, String> {
    tauri::async_runtime::block_on(start_cli(app, port, host, allowed_hosts))
}

/// At launch: starts only when the user left it on, on the saved bind address.
pub(crate) fn start_if_saved(app: &tauri::AppHandle) {
    let Some(state) = app.try_state::<WebServer>() else { return };
    let config = lock(&state.state).config.clone();
    if !config.enabled {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<WebServer>();
        if let Err(error) = state.start(backend(&app), config.bind_host(), config.port, false).await {
            eprintln!("Web server could not start: {error}");
        }
        emit_changed(&app);
    });
}

// ---- Connections ----

struct Shared {
    backend: Arc<dyn Backend>,
    hub: Arc<EventHub>,
    token: Arc<RwLock<String>>,
    /// Trusted `Host` names; read on every request, so a configure changes access live.
    allowed: Arc<RwLock<Vec<String>>>,
    retired: Arc<AtomicBool>,
    clients: Arc<AtomicUsize>,
    bound: SocketAddr,
    limiter: Limiter,
    shutdown: watch::Receiver<bool>,
    rotate: watch::Receiver<u64>,
}

impl Shared {
    fn token_ok(&self, given: Option<&str>) -> bool {
        if self.retired.load(Ordering::Acquire) {
            return false;
        }
        let token = self.token.read().unwrap_or_else(|poisoned| poisoned.into_inner());
        given.is_some_and(|given| same(given, &token))
    }

    fn host_ok(&self, host: Option<&str>) -> bool {
        let allowed = self.allowed.read().unwrap_or_else(|poisoned| poisoned.into_inner());
        host_allowed(host, self.bound, &allowed)
    }
}

/// Constant time in the shared length: no early exit on the first differing byte.
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |diff, (x, y)| diff | (x ^ y)) == 0
}

/// The address a peer is counted under: canonical, and a whole IPv6 /64 for anything off
/// loopback (one host usually owns the entire /64, so per-address counting is no limit).
fn rate_key(ip: IpAddr) -> IpAddr {
    match ip.to_canonical() {
        IpAddr::V6(v6) if !v6.is_loopback() => IpAddr::V6(Ipv6Addr::from(u128::from(v6) & (!0u128 << 64))),
        ip => ip,
    }
}

/// Failed token attempts per peer address (see [`rate_key`]) in a fixed window.
#[derive(Default)]
struct Limiter {
    failures: Mutex<HashMap<IpAddr, (Instant, u32)>>,
}

impl Limiter {
    fn blocked(&self, ip: IpAddr, now: Instant) -> bool {
        lock(&self.failures)
            .get(&rate_key(ip))
            .is_some_and(|(start, count)| now.duration_since(*start) < FAILURE_WINDOW && *count >= MAX_FAILURES)
    }

    fn fail(&self, ip: IpAddr, now: Instant) {
        let key = rate_key(ip);
        let mut failures = lock(&self.failures);
        if failures.len() >= MAX_AUTH_LIMITER_ENTRIES && !failures.contains_key(&key) {
            failures.retain(|_, (start, _)| now.duration_since(*start) < FAILURE_WINDOW);
            if failures.len() >= MAX_AUTH_LIMITER_ENTRIES {
                // Still full of live windows: forget the oldest.
                let oldest = failures.iter().min_by_key(|(_, (start, _))| *start).map(|(key, _)| *key);
                if let Some(oldest) = oldest {
                    failures.remove(&oldest);
                }
            }
        }
        let entry = failures.entry(key).or_insert((now, 0));
        if now.duration_since(entry.0) >= FAILURE_WINDOW {
            *entry = (now, 0);
        }
        entry.1 = entry.1.saturating_add(1);
    }
}

/// Resolves once the server is stopping (or its handle is gone).
async fn stopped(shutdown: &mut watch::Receiver<bool>) {
    let _ = shutdown.wait_for(|stopping| *stopping).await;
}

type PerIp = Arc<Mutex<HashMap<IpAddr, usize>>>;

/// One connection's share of its address's cap; given back on drop, however it ends.
struct IpSlot {
    counts: PerIp,
    ip: IpAddr,
}

impl IpSlot {
    fn take(counts: &PerIp, ip: IpAddr) -> Option<Self> {
        let ip = rate_key(ip);
        let cap = if ip.is_loopback() { MAX_LOOPBACK_CONNECTIONS } else { MAX_CONNECTIONS_PER_IP };
        let mut map = lock(counts);
        let count = map.entry(ip).or_insert(0);
        if *count >= cap {
            return None;
        }
        *count += 1;
        Some(Self { counts: counts.clone(), ip })
    }
}

impl Drop for IpSlot {
    fn drop(&mut self) {
        let mut map = lock(&self.counts);
        if let Some(count) = map.get_mut(&self.ip) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                map.remove(&self.ip);
            }
        }
    }
}

/// Connection caps: per address, and one pool for remote peers and another for loopback
/// (local users and SSH tunnels), so remote peers can never use up the owner's way in.
struct Gates {
    remote: Arc<Semaphore>,
    loopback: Arc<Semaphore>,
    per_ip: PerIp,
}

impl Gates {
    fn new() -> Self {
        Self {
            remote: Arc::new(Semaphore::new(MAX_CONNECTIONS)),
            loopback: Arc::new(Semaphore::new(MAX_LOOPBACK_CONNECTIONS)),
            per_ip: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// A connection's permit and per-address slot, both given back on drop; `None` over a cap.
    fn admit(&self, ip: IpAddr) -> Option<(tokio::sync::OwnedSemaphorePermit, IpSlot)> {
        let pool = if rate_key(ip).is_loopback() { &self.loopback } else { &self.remote };
        let permit = pool.clone().try_acquire_owned().ok()?;
        let slot = IpSlot::take(&self.per_ip, ip)?;
        Some((permit, slot))
    }
}

async fn accept_loop(listener: TcpListener, shared: Arc<Shared>, listener_dropped: oneshot::Sender<()>) {
    let mut shutdown = shared.shutdown.clone();
    let gates = Gates::new();
    let mut connections = tokio::task::JoinSet::new();
    loop {
        tokio::select! {
            _ = stopped(&mut shutdown) => break,
            accepted = listener.accept() => match accepted {
                Ok((stream, peer)) => {
                    // Over a cap: drop the connection rather than queue it.
                    let Some((permit, slot)) = gates.admit(peer.ip()) else { continue };
                    let shared = shared.clone();
                    connections.spawn(async move {
                        let _permit = permit;
                        let _slot = slot;
                        connection(stream, peer, shared).await;
                    });
                }
                Err(error) => {
                    eprintln!("Web server: accept failed: {error}");
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            },
            Some(_) = connections.join_next(), if !connections.is_empty() => {}
        }
    }
    // Release the port first and say so; clients then get a moment for their replies and
    // close frames, with nobody waiting on it.
    drop(listener);
    let _ = listener_dropped.send(());
    let drained = tokio::time::timeout(STOP_GRACE, async { while connections.join_next().await.is_some() {} }).await;
    if drained.is_err() {
        connections.shutdown().await;
    }
}

#[derive(Debug, Default)]
struct Request {
    method: String,
    target: String,
    version: String,
    headers: HashMap<String, String>,
    /// Declared body length; the body itself is read only when a route accepts it.
    content_length: usize,
    body: Vec<u8>,
}

impl Request {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).map(String::as_str)
    }

    fn bearer(&self) -> Option<&str> {
        let value = self.header("authorization")?;
        let (scheme, token) = value.split_once(' ')?;
        scheme.eq_ignore_ascii_case("bearer").then(|| token.trim())
    }

    fn path(&self) -> &str {
        self.target.split(['?', '#']).next().unwrap_or_default()
    }

    fn keep_alive(&self) -> bool {
        let close = self.header("connection").is_some_and(|value| has_token(value, "close"));
        self.version == "HTTP/1.1" && !close
    }

    fn is_upgrade(&self) -> bool {
        self.header("upgrade").is_some_and(|value| value.trim().eq_ignore_ascii_case("websocket"))
    }
}

fn has_token(list: &str, token: &str) -> bool {
    list.split(',').any(|item| item.trim().eq_ignore_ascii_case(token))
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|window| window == needle)
}

/// Reads one request head (bounded to MAX_HEAD, all of it within HEAD_TIMEOUT); the body
/// stays unread. Bytes past the head stay in `buf`. `Ok(None)`: the peer left or stalled.
async fn read_request_head<S: AsyncRead + Unpin>(stream: &mut S, buf: &mut Vec<u8>) -> Result<Option<Request>, Response> {
    let deadline = tokio::time::Instant::now() + HEAD_TIMEOUT;
    let mut chunk = [0u8; 8192];
    let end = loop {
        if let Some(end) = find(buf, b"\r\n\r\n") {
            break end;
        }
        if buf.len() > MAX_HEAD {
            return Err(Response::text(431, "Request headers are too large."));
        }
        match tokio::time::timeout_at(deadline, stream.read(&mut chunk)).await {
            Ok(Ok(0)) | Ok(Err(_)) | Err(_) => return Ok(None),
            Ok(Ok(read)) => buf.extend_from_slice(&chunk[..read]),
        }
    };
    if end > MAX_HEAD {
        return Err(Response::text(431, "Request headers are too large."));
    }
    let head = String::from_utf8(buf[..end].to_vec()).map_err(|_| Response::text(400, "Malformed request."))?;
    buf.drain(..end + 4);
    parse_head(&head).map(Some)
}

/// Reads the declared body (the caller checked it against MAX_BODY), all of it within
/// BODY_TIMEOUT. `false`: the peer left or stalled.
async fn read_request_body<S: AsyncRead + Unpin>(stream: &mut S, buf: &mut Vec<u8>, request: &mut Request) -> bool {
    let deadline = tokio::time::Instant::now() + BODY_TIMEOUT;
    let length = request.content_length;
    let mut chunk = [0u8; 8192];
    while buf.len() < length {
        match tokio::time::timeout_at(deadline, stream.read(&mut chunk)).await {
            Ok(Ok(0)) | Ok(Err(_)) | Err(_) => return false,
            Ok(Ok(read)) => buf.extend_from_slice(&chunk[..read]),
        }
    }
    request.body = buf.drain(..length).collect();
    true
}

/// Headers that must appear once: a second copy could split what the checks and the
/// handler see.
const SINGLE_HEADERS: [&str; 6] = ["host", "origin", "authorization", "content-length", "upgrade", "sec-websocket-key"];

fn parse_head(head: &str) -> Result<Request, Response> {
    let bad = || Response::text(400, "Malformed request.");
    // CRLF only: a bare CR or LF could split the head differently for us and a proxy.
    if head.split("\r\n").any(|line| line.contains(['\n', '\r'])) {
        return Err(bad());
    }
    let mut lines = head.split("\r\n");
    let mut parts = lines.next().ok_or_else(bad)?.split(' ');
    let (method, target, version) = (parts.next().ok_or_else(bad)?, parts.next().ok_or_else(bad)?, parts.next().ok_or_else(bad)?);
    if parts.next().is_some() || method.is_empty() || !target.starts_with('/') || !matches!(version, "HTTP/1.1" | "HTTP/1.0") {
        return Err(bad());
    }
    let mut headers = HashMap::new();
    for line in lines {
        // Obsolete line folding: a continuation line could smuggle a header past the checks.
        if line.starts_with([' ', '\t']) {
            return Err(bad());
        }
        let (name, value) = line.split_once(':').ok_or_else(bad)?;
        // RFC 9110 token, untrimmed: `Host : x` or a tab in a name is malformed.
        if name.is_empty() || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b)) {
            return Err(bad());
        }
        let name = name.to_ascii_lowercase();
        if name == "transfer-encoding" {
            return Err(Response::text(501, "Chunked request bodies are not supported."));
        }
        if headers.insert(name.clone(), value.trim_matches([' ', '\t']).to_owned()).is_some() && SINGLE_HEADERS.contains(&name.as_str()) {
            return Err(bad());
        }
    }
    let content_length = match headers.get("content-length") {
        // Digits only: no sign, no spaces inside, nothing a proxy might read differently.
        Some(value) if !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit()) => value.parse::<usize>().unwrap_or(usize::MAX),
        Some(_) => return Err(Response::text(400, "Malformed Content-Length.")),
        None => 0,
    };
    Ok(Request { method: method.to_owned(), target: target.to_owned(), version: version.to_owned(), headers, content_length, body: Vec::new() })
}

/// Splits a `Host` value into a lowercased name (brackets kept for IPv6) and its port.
fn split_host(host: &str) -> Option<(String, Option<u16>)> {
    let host = host.trim().to_ascii_lowercase();
    if host.is_empty() {
        return None;
    }
    let (name, port) = if host.starts_with('[') {
        let close = host.find(']')?;
        let rest = &host[close + 1..];
        let port = if rest.is_empty() { None } else { Some(rest.strip_prefix(':')?) };
        (host[..=close].to_owned(), port)
    } else {
        match host.rsplit_once(':') {
            Some((name, port)) => (name.to_owned(), Some(port)),
            None => (host.clone(), None),
        }
    };
    let port = port.map(|port| port.parse::<u16>().ok()).map_or(Some(None), |port| port.map(Some))?;
    if name.is_empty() || name.contains(['/', '@', ' ']) {
        return None;
    }
    Some((name, port))
}

/// DNS rebinding: a request must name the listener by something a rebound DNS name can't
/// be. Loopback listeners take `localhost` or a loopback literal; one bound to a specific
/// address takes that address (or loopback, as through a tunnel); one on every interface
/// takes any address literal or `localhost`. Any port but 0 (an `ssh -L 9000:127.0.0.1:8787`
/// tunnel arrives with the local port; Origin must still match Host exactly). A configured
/// trusted name is accepted in addition, on any bind, but only for that exact name.
fn host_allowed(host: Option<&str>, bound: SocketAddr, allowed: &[String]) -> bool {
    let Some((name, port)) = host.and_then(split_host) else { return false };
    if port == Some(0) {
        return false;
    }
    // An address literal can't come from a rebound name; `::ffff:127.0.0.1` counts as loopback.
    let literal = host_literal(&name);
    let loopback = name == "localhost" || literal.is_some_and(|ip| ip.is_loopback());
    let bound_ip = bound.ip().to_canonical();
    let usual = if bound_ip.is_loopback() || loopback {
        loopback
    } else if bound_ip.is_unspecified() {
        // Every interface: any address literal, never a DNS name.
        literal.is_some()
    } else {
        // One interface (a LAN or Tailscale address): that address only.
        literal == Some(bound_ip)
    };
    usual || allowed.iter().any(|trusted| trusted == &name || literal.is_some_and(|ip| host_literal(trusted) == Some(ip)))
}

/// The canonical address in a Host name: dotted IPv4, or IPv6 in brackets; never a DNS name.
fn host_literal(name: &str) -> Option<IpAddr> {
    let ip = match name.strip_prefix('[').and_then(|inner| inner.strip_suffix(']')) {
        Some(inner) => IpAddr::V6(inner.parse().ok()?),
        None => IpAddr::V4(name.parse().ok()?),
    };
    Some(ip.to_canonical())
}

/// The authority the page was loaded from, for its CSP: the validated Host when it is a
/// plain `name[:port]`, else the bound address.
fn page_authority(host: Option<&str>, bound: SocketAddr) -> String {
    let plain = |text: &str| !text.is_empty() && text.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b':' | b'[' | b']'));
    match host.map(|host| host.trim().to_ascii_lowercase()) {
        Some(host) if plain(&host) && split_host(&host).is_some() => host,
        _ => url_authority(bound),
    }
}

/// CSRF and cross-site WebSockets: a present Origin must be http(s) on this very host.
fn origin_allowed(origin: Option<&str>, host: Option<&str>) -> bool {
    let Some(origin) = origin else { return true };
    let Some(host) = host else { return false };
    let lower = origin.trim().to_ascii_lowercase();
    let Some(authority) = lower.strip_prefix("http://").or_else(|| lower.strip_prefix("https://")) else { return false };
    let authority = authority.strip_suffix('/').unwrap_or(authority);
    match (split_host(authority), split_host(host)) {
        (Some(origin), Some(host)) => !authority.contains(['/', '?', '#']) && origin == host,
        _ => false,
    }
}

struct Response {
    status: u16,
    content_type: String,
    body: Vec<u8>,
    /// For HTML: the authority its CSP lets sockets reach.
    html: Option<String>,
    no_store: bool,
}

impl Response {
    fn new(status: u16, content_type: &str, body: Vec<u8>) -> Self {
        Self { status, content_type: content_type.to_owned(), body, html: None, no_store: false }
    }

    fn text(status: u16, text: &str) -> Self {
        Self::new(status, "text/plain; charset=utf-8", text.as_bytes().to_vec())
    }

    fn json(status: u16, value: &Value) -> Self {
        Self::new(status, "application/json", value.to_string().into_bytes())
    }

    fn error(status: u16, message: &str) -> Self {
        Self::json(status, &serde_json::json!({ "error": message }))
    }
}

fn reason(status: u16) -> &'static str {
    match status {
        101 => "Switching Protocols",
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        413 => "Payload Too Large",
        426 => "Upgrade Required",
        429 => "Too Many Requests",
        431 => "Request Header Fields Too Large",
        501 => "Not Implemented",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        _ => "Error",
    }
}

fn response_head(response: &Response, keep_alive: bool) -> String {
    let mut head = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nX-Content-Type-Options: nosniff\r\nX-Frame-Options: DENY\r\nReferrer-Policy: no-referrer\r\nConnection: {}\r\n",
        response.status,
        reason(response.status),
        response.content_type,
        response.body.len(),
        if keep_alive { "keep-alive" } else { "close" },
    );
    if response.no_store {
        head.push_str("Cache-Control: no-store\r\n");
    }
    if let Some(authority) = &response.html {
        head.push_str("Cache-Control: no-cache\r\n");
        head.push_str(&format!("Content-Security-Policy: {}\r\n", csp(authority)));
    }
    head.push_str("\r\n");
    head
}

/// Writes a whole response within WRITE_TIMEOUT.
async fn write_response<S: AsyncWrite + Unpin>(stream: &mut S, response: &Response, keep_alive: bool) -> std::io::Result<()> {
    let write = async {
        stream.write_all(response_head(response, keep_alive).as_bytes()).await?;
        stream.write_all(&response.body).await?;
        stream.flush().await
    };
    tokio::time::timeout(WRITE_TIMEOUT, write)
        .await
        .unwrap_or_else(|_| Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "response write timed out")))
}

/// After refusing a request we did not read in full: stop writing, then discard what the
/// peer is still sending (bounded), so closing doesn't reset the connection and lose the
/// response.
async fn linger(stream: &mut TcpStream) {
    let _ = stream.shutdown().await;
    let mut chunk = [0u8; 8192];
    let mut discarded = 0usize;
    let deadline = tokio::time::Instant::now() + Duration::from_millis(500);
    while discarded < 256 * 1024 {
        match tokio::time::timeout_at(deadline, stream.read(&mut chunk)).await {
            Ok(Ok(read)) if read > 0 => discarded += read,
            _ => break,
        }
    }
}

/// What a request head earns before any body is read.
enum Gate {
    Respond(Response),
    /// An authorized `POST /api/invoke` whose body may now be read.
    Invoke,
}

async fn connection(mut stream: TcpStream, peer: SocketAddr, shared: Arc<Shared>) {
    let mut buf = Vec::new();
    let mut shutdown = shared.shutdown.clone();
    let ip = peer.ip().to_canonical();
    loop {
        let head = tokio::select! {
            head = read_request_head(&mut stream, &mut buf) => head,
            _ = stopped(&mut shutdown) => return,
        };
        let mut request = match head {
            Ok(Some(request)) => request,
            Ok(None) => return,
            Err(response) => return refuse(&mut stream, &response, true).await,
        };
        if request.path() == "/api/events" && request.is_upgrade() {
            if request.content_length != 0 {
                return refuse(&mut stream, &Response::error(400, "Unexpected request body."), true).await;
            }
            websocket(stream, buf, request, ip, shared).await;
            return;
        }
        let keep_alive = request.keep_alive();
        let response = match route(&request, ip, &shared).await {
            Gate::Respond(response) => {
                // Whatever body was declared is never read: answer and close.
                if request.content_length != 0 {
                    return refuse(&mut stream, &response, true).await;
                }
                response
            }
            Gate::Invoke => {
                let body = tokio::select! {
                    read = read_request_body(&mut stream, &mut buf, &mut request) => read,
                    _ = stopped(&mut shutdown) => return,
                };
                if !body {
                    return;
                }
                let mut response = invoke(&request, &shared).await;
                response.no_store = true;
                response
            }
        };
        // Stopping meanwhile (this very request may have asked for it): finish this reply,
        // then close.
        let keep_alive = keep_alive && !*shutdown.borrow();
        if write_response(&mut stream, &response, keep_alive).await.is_err() || !keep_alive {
            return;
        }
    }
}

/// Answers a request whose body stays unread, then closes without a reset.
/// Answers and closes. `unread`: the client may still be sending (a declared body or bytes
/// past a bad head), so drain briefly lest closing with unread data reset away the reply;
/// otherwise close at once and give the connection slot back.
async fn refuse(stream: &mut TcpStream, response: &Response, unread: bool) {
    if write_response(stream, response, false).await.is_ok() {
        if unread {
            linger(stream).await;
        } else {
            let _ = stream.shutdown().await;
        }
    }
}

/// Host, Origin, route and token are all settled from the head alone.
async fn route(request: &Request, ip: IpAddr, shared: &Shared) -> Gate {
    if !shared.host_ok(request.header("host")) {
        return Gate::Respond(Response::text(403, "Forbidden"));
    }
    let path = request.path();
    if path == "/api" || path.starts_with("/api/") {
        return match api(request, path, ip, shared) {
            Gate::Respond(mut response) => {
                response.no_store = true;
                Gate::Respond(response)
            }
            invoke => invoke,
        };
    }
    if request.content_length != 0 {
        return Gate::Respond(Response::text(400, "Unexpected request body."));
    }
    Gate::Respond(static_file(request, path, shared).await)
}

fn api(request: &Request, path: &str, ip: IpAddr, shared: &Shared) -> Gate {
    if !origin_allowed(request.header("origin"), request.header("host")) {
        return Gate::Respond(Response::error(403, "Forbidden"));
    }
    if (request.method.as_str(), path) == ("POST", "/api/invoke") {
        // The token first: an unauthorized client never gets a byte of its body read.
        return match authorize(request, ip, shared) {
            Some(refused) => Gate::Respond(refused),
            None if request.content_length > MAX_BODY => Gate::Respond(Response::error(413, "Request body is too large.")),
            None => Gate::Invoke,
        };
    }
    if request.content_length != 0 {
        return Gate::Respond(Response::error(400, "Unexpected request body."));
    }
    Gate::Respond(match (request.method.as_str(), path) {
        ("POST", "/api/auth") => match authorize(request, ip, shared) {
            Some(refused) => refused,
            None => Response::json(
                200,
                &serde_json::json!({
                    "ok": true,
                    "version": env!("CARGO_PKG_VERSION"),
                    "host": shared.bound.ip().to_canonical().to_string(),
                    "port": shared.bound.port(),
                }),
            ),
        },
        (_, "/api/auth" | "/api/invoke") => Response::error(405, "Use POST."),
        (_, "/api/events") => Response::error(426, "WebSocket upgrade required."),
        _ => Response::error(404, "Not found."),
    })
}

/// `None` when the bearer token is right; otherwise the refusal (counted per address).
/// The right token always passes, so failures from a page or process sharing the owner's
/// address can never lock the owner out; only wrong guesses are throttled.
fn authorize(request: &Request, ip: IpAddr, shared: &Shared) -> Option<Response> {
    if shared.token_ok(request.bearer()) {
        return None;
    }
    let now = Instant::now();
    if shared.limiter.blocked(ip, now) {
        return Some(Response::error(429, "Too many failed attempts. Try again in a minute."));
    }
    shared.limiter.fail(ip, now);
    Some(Response::error(401, "Invalid access token."))
}

#[derive(Deserialize)]
struct InvokeCall {
    command: String,
    #[serde(default)]
    args: Value,
}

/// Commands that drive the desktop window or the host computer itself (the embedded
/// browser, clipboard, native drags, window chrome, overlays, the menu bar, the host's
/// microphone, Finder/Explorer and its default apps, Tauri plugins): never from a browser
/// tab, whatever the frontend asks. `tray_seen` stays allowed, so a task opened in a tab
/// clears its unseen badge in the menu bar.
fn web_blocked_command(command: &str) -> bool {
    const DESKTOP_ONLY: [&str; 36] = [
        "browser_open",
        "browser_inspect",
        "browser_bounds",
        "browser_action",
        "browser_pick",
        "browser_capture",
        "browser_close",
        "read_clipboard_image",
        "dragged_file_paths",
        "configure_window_appearance",
        "agents_dock_pin",
        "local_sign_app",
        "open_third_party_notices",
        "tray_snapshot",
        "tray_open",
        "tray_refresh_usage",
        "tray_show_app",
        "tray_hide",
        "tray_quit",
        "tray_resize",
        "voice_start",
        "voice_stop",
        "voice_retry",
        "voice_cancel",
        "voice_mic_devices",
        "voice_mic_test_start",
        "voice_mic_test_stop",
        "voice_mic_test_cancel",
        "open_workspace_file",
        "reveal_path",
        "crash_report_reveal",
        "open_support",
        "open_external_url",
        "save_debug_bundle",
        // These return a bridge channel's bearer token. A web tab must not be able to read
        // a credential that lets anyone post messages as a paired sender.
        "bot_bridge_setup",
        "bot_bridge_new_token",
    ];
    DESKTOP_ONLY.contains(&command) || ["overlay_", "plugin:"].iter().any(|prefix| command.starts_with(prefix))
}

/// Every command the main window registers (in `main_invoke_handler`) that was reviewed
/// as fine from a browser tab, by the WIRE name a tab invokes. A `#[tauri::command(rename = "...")]`
/// exposes its wire name to the frontend, not the Rust function name, so both this list and
/// `web_blocked_command` must use the wire name. Default-deny: [`invoke`] refuses anything not
/// listed here (and everything `web_blocked_command` names), so a new command can't reach tabs
/// unreviewed. `every_main_window_command_is_reviewed_for_web` resolves the renames and keeps
/// the two lists covering every command.
const WEB_ALLOWED_COMMANDS: &[&str] = &[
    "bot_set_capabilities", "bot_assign_task", "bot_task_links",
    "voice_configuration", "voice_save_profile", "voice_select_profile", "voice_delete_profile",
    "voice_local_catalog", "voice_local_download", "voice_local_cancel_download", "voice_local_delete",
    "voice_local_select", "voice_local_test_model", "voice_preferences", "voice_update_preferences",
    "agents_dock_snapshot", "agents_dock_preferences", "agents_dock_save_preferences", "support_details",
    "model_routing_status", "model_routing_exclusions", "model_routing_set_exclusions",
    "model_routing_configure", "model_routing_prepare", "model_routing_route", "model_routing_tiers",
    "model_routing_set_tiers", "model_routing_tier_models", "model_health_list", "model_health_clear",
    "crash_recovery_take", "crash_recovery_shown", "crash_restart_enabled", "set_crash_restart_enabled",
    "sessions_missing", "app_update_install_supported", "check_agent_updates", "update_agent",
    "list_moodboards", "create_moodboard", "read_moodboard", "rename_moodboard", "delete_moodboard",
    "add_moodboard_image", "import_moodboard_images", "update_moodboard_image", "remove_moodboard_image",
    "moodboard_image", "remote_status", "remote_sign_in_start", "remote_sign_in_finish",
    "remote_sign_in_cancel", "remote_sign_out", "remote_set_host_enabled", "remote_set_notify_enabled",
    "remote_devices", "remote_revoke_device", "remote_targets", "remote_start_task", "orchestration_status",
    "orchestration_set_enabled", "orchestration_set_link", "orchestration_pending",
    "orchestration_link_respond", "orchestration_children", "orchestration_threads", "remote_team",
    "remote_worker_messages", "remote_cancel_start", "remote_reconnect", "remote_device_grants",
    "remote_set_device_grant", "remote_pair_code", "remote_pair_code_cancel", "remote_pair_redeem",
    "remote_diagnostics", "remote_diagnostics_export", "remote_resubscribe", "remote_workspace_image",
    "cloud_agent_targets", "cloud_agent_start", "cloud_agent_action", "cloud_agent_set_claude_token",
    "remote_repo_check", "provider_configuration", "connections_list", "connection_save", "connection_delete",
    "connection_assign", "connection_pool_set", "connection_new_account", "connection_pool_member_set",
    "account_pool_status", "account_pool_clear", "account_sign_in_start", "account_sign_in_code",
    "account_sign_in_cancel", "agent_usage", "agent_usage_asking_claude", "tray_seen", "usage_ledger",
    "capabilities_inventory", "cache_alignment", "prompt_activity", "set_resume_at_reset", "clear_usage_limit",
    "discard_draft", "queue_list", "queue_holds", "queue_add", "queue_update", "queue_remove", "queue_take_steered",
    "queue_reorder", "queue_take", "queue_restore", "set_queue_hold", "steer_task", "bots_list", "bot_desktop_thread",
    "bot_detail", "bot_create", "bot_update", "bot_set_paused", "bot_reset", "bot_delete", "bot_remember",
    "bot_forget", "bot_activity", "bot_project_ids", "bot_message", "bot_shared_channels",
    "bot_shared_channel_detail", "bot_shared_channel_create", "bot_shared_channel_update",
    "bot_shared_channel_archive", "bot_shared_channel_post", "bot_shared_channel_stop",
    "bot_shared_channel_continue", "bot_shared_channel_reassign", "bot_message_markers", "bot_failover_decide",
    "bot_failover_pending", "bot_model_switches", "bot_task_brief", "bot_schedule_create",
    "bot_schedule_set_enabled", "bot_schedule_delete", "bot_run_schedule_now", "schedules_list",
    "schedule_create", "schedule_update", "schedule_set_enabled", "schedule_delete", "schedule_run_now",
    "schedule_snooze", "schedule_runs", "scheduler_settings", "scheduler_set_settings", "bot_channel_add",
    "bot_channel_test", "bot_channel_configure", "bot_channel_set_enabled", "bot_channel_remove",
    "bot_pairing_decide", "bot_web_link", "bot_web_new_link", "bot_rule_add", "bot_rule_delete",
    "list_importable_conversations", "import_conversations", "provider_set_claude_connection_mode",
    "provider_set_claude_cli_refresh", "harness_privacy", "harness_privacy_set", "provider_claude_status",
    "list_opencode_models", "save_opencode_models", "provider_set_executable",
    "provider_set_environment_variable", "provider_remove_environment_variable",
    "provider_set_global_environment_variable", "provider_remove_global_environment_variable",
    "provider_set_use_global_environment", "provider_save_glm_key", "provider_remove_glm_key",
    "provider_save_mimo_key", "provider_remove_mimo_key", "provider_save_alibaba_key",
    "provider_remove_alibaba_key", "provider_save_deepseek_key", "provider_remove_deepseek_key",
    "provider_save_commandcode_key", "provider_remove_commandcode_key", "provider_set_mimo_endpoint",
    "architect_profiles", "architect_set_lead_guidance", "architect_save_profile", "architect_delete_profile",
    "architect_get", "architect_configure", "architect_set_council", "architect_council_accept",
    "architect_start", "architect_control", "architect_worker_messages", "architect_team_messages", "task_goal",
    "codex_command", "codex_jobs", "set_task_preference", "fork_codex_task", "fork_session_at_message",
    "get_message_content", "archive_codex_task", "export_task", "save_task_export", "export_debug_bundle", "start_harness_terminal",
    "list_projects", "add_project", "remove_project", "relink_project", "list_sessions", "pin_session",
    "dismiss_error_messages", "reorder_sessions", "get_task", "create_session", "create_board_task",
    "update_task_details", "set_task_stage", "start_task", "configure_session", "set_reasoning_effort",
    "update_session", "delete_session", "chat_create", "chat_cleanup", "get_messages",
    "turn_change_diff", "turn_change_summary", "list_subagents", "get_subagent", "send_message",
    "list_slash_commands", "recipes_list", "recipes_save", "recipes_delete", "recipes_dry_run",
    "provider_check_connection", "resolve_slash_command", "stop_session", "respond_approval",
    "respond_user_input", "list_agent_integrations", "list_app_tools", "agent_ui_request_active",
    "resolve_agent_ui_action", "list_providers", "list_provider_models", "git_status", "git_diff", "jj_status",
    "jj_diff", "jj_describe", "jj_new", "jj_commit", "jj_log", "git_stage", "git_commit", "git_branches",
    "git_switch_branch", "git_push", "create_worktree", "attach_worktree", "worktree_status", "remove_worktree",
    "merge_worktree", "recreate_worktree", "github_status", "github_repos", "project_icon", "github_repo_pulls",
    "github_repo_issues", "github_repo_runs", "github_run_details", "github_project_repos", "github_clone_repo",
    "github_search", "github_issues", "github_resolve", "github_refresh_links", "github_create_pull_request",
    "github_pull_request", "github_pull_request_diff", "github_merge_pull_request",
    "github_detect_pull_request", "github_link_pull_request", "simulator_status", "simulator_select",
    "simulator_create_duo", "simulator_pose", "simulator_power", "simulator_frame", "simulator_input",
    "simulator_appearance", "simulator_capture", "android_setup", "vm_status", "vm_show", "vm_create",
    "vm_power", "vm_frame", "vm_input", "vm_desktop", "vm_setup", "cloud_connections", "cloud_connect",
    "cloud_colab_config", "cloud_colab_install_cli", "cloud_colab_runtime_action", "cloud_colab_set_config",
    "cloud_colab_sign_in_cancel", "cloud_colab_sign_in_start", "cloud_colab_sign_in_status",
    "cloud_colab_thread_runtimes", "cloud_colab_usage", "cloud_digitalocean_catalog",
    "cloud_digitalocean_set_options",
    "cloud_disconnect", "cloud_set_inherit_environment", "cloud_setup_sandboxes", "cloud_instabox_images",
    "cloud_instabox_set_image", "cloud_machines", "cloud_create", "cloud_power", "cloud_frame", "cloud_input",
    "themes_list", "theme_import", "theme_install", "theme_remove", "token_saver_tools", "token_saver_install",
    "task_token_usage", "skill_manager_list", "skill_manager_set", "skill_manager_reset",
    "skill_manager_restore", "skill_manager_uninstall", "skill_manager_undo_uninstall", "skill_manager_preview",
    "skill_manager_add", "skill_manager_add_library", "skills_list", "skills_import_folder",
    "skills_import_github", "skills_activate", "skills_deactivate", "skills_deactivate_all", "skills_matrix",
    "skills_scan", "skills_remove", "set_task_link", "import_prompt_image", "prompt_image", "read_document",
    "describe_folder", "list_files", "manage_workspace_entry", "write_workspace_file", "workspace_file_stamp",
    "search_files", "search_text", "read_file", "read_document_file", "design_list", "design_read",
    "design_comments", "design_save_comments", "progress_list", "progress_media", "progress_thumb",
    "progress_clear", "workspace_image", "tool_image", "resolve_workspace_files", "prepare_file_preview",
    "get_run_script", "get_run_script_preview", "run_turn_checks", "start_run_script_terminal",
    "start_terminal", "write_terminal", "resize_terminal", "close_terminal", "get_terminal_activity",
    "read_terminal_output", "get_terminal_preferences", "get_metrics", "list_local_servers",
    "jev_configuration", "jev_save_configuration", "jev_decision_models", "jev_doctor", "jev_install_runtime",
    "jev_start", "jev_watch_run", "jev_cancel", "jev_list_runs", "jev_read_run", "jev_assist_prepare",
    "jev_assist_run", "jev_assist_list", "jev_assist_save_rules", "web_server_status", "web_server_configure",
    "web_server_rotate_token", "app_version",
];

fn web_allowed_command(command: &str) -> bool {
    WEB_ALLOWED_COMMANDS.contains(&command)
}

/// The token checked on the head may have been rotated while the body trickled in or the
/// command ran: a held-open request on the old token must never run a command or read a
/// reply (say, a `web_server_status` carrying the new link) after the owner revoked it.
fn rotated_away() -> Response {
    Response::error(401, "Invalid access token.")
}

/// The reply to a command that ran, or 401 when the token was rotated meanwhile. A tab's
/// own rotation never comes here: it is a compare-and-swap on its token instead.
///
/// That 401 says `"ran": true`, unlike a refusal before running: the command already took
/// effect, so a client must not retry it (a resent `send_message` would send twice).
fn guard_reply(token_current: bool, response: Response) -> Response {
    if token_current {
        response
    } else {
        Response::json(401, &serde_json::json!({ "error": "Access token rotated while request was running.", "ran": true }))
    }
}

async fn invoke(request: &Request, shared: &Shared) -> Response {
    if !shared.token_ok(request.bearer()) {
        return rotated_away();
    }
    let Ok(call) = serde_json::from_slice::<InvokeCall>(&request.body) else {
        return Response::error(400, "Expected {\"command\": string, \"args\": object}.");
    };
    if call.command.is_empty() || call.command.len() > MAX_COMMAND_LEN || !call.command.bytes().all(|b| b.is_ascii_graphic()) {
        return Response::error(400, "Invalid command name.");
    }
    let args = match call.args {
        Value::Null => Value::Object(Default::default()),
        args @ Value::Object(_) => args,
        _ => return Response::error(400, "`args` must be an object."),
    };
    if web_blocked_command(&call.command) || (shared.backend.enforces_allowlist() && !web_allowed_command(&call.command)) {
        return Response::error(403, "This command is only available in the desktop app.");
    }
    // A tab may switch the port, never the listen address or trusted names (both could
    // expose the session to a new host).
    let host_given = args.get("host").is_some_and(|host| !host.is_null() && host.as_str().is_none_or(|host| !host.trim().is_empty()));
    if call.command == "web_server_configure" && host_given {
        return Response::error(403, "The listen address can only be changed on the host machine.");
    }
    if call.command == "web_server_configure" && args.get("allowedHosts").is_some_and(|hosts| !hosts.is_null()) {
        return Response::error(403, "The trusted host names can only be changed on the host machine.");
    }
    // These replies carry a new token: the token check and the change must be one step,
    // and the reply goes straight to the caller that made it.
    let expected = request.bearer().unwrap_or_default().to_owned();
    let reply = if call.command == "web_server_rotate_token" {
        return reply_response(shared.backend.rotate_if_token(expected).await);
    } else if call.command == "web_server_configure" {
        return reply_response(shared.backend.configure_if_token(expected, args).await);
    } else {
        shared.backend.invoke(call.command, args).await
    };
    guard_reply(shared.token_ok(request.bearer()), reply_response(reply))
}

fn reply_response(reply: Reply) -> Response {
    match reply {
        Reply::Json(raw) => Response::new(200, "application/json", raw.into_bytes()),
        Reply::Bytes(bytes) => Response::new(200, "application/octet-stream", bytes),
        Reply::Error(value) => Response::json(400, &serde_json::json!({ "error": value })),
        Reply::Unknown => Response::error(404, "Unknown command."),
        Reply::NotReady => Response::error(503, "PandaCode session is not ready."),
        Reply::TimedOut => Response::error(504, "Command timed out."),
        Reply::Unauthorized => rotated_away(),
    }
}

// ---- Static files ----

fn percent_decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = std::str::from_utf8(bytes.get(index + 1..index + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// The asset key for a request path, or `None` for anything that could step outside the
/// frontend bundle (`..`, backslashes, NUL — before or after percent decoding) or, joined
/// onto the dev server's URL, name another origin (`:` as in `/http://…`).
fn asset_path(path: &str) -> Option<String> {
    let decoded = percent_decode(path)?;
    // `?`/`#` only arrive percent-encoded (the raw ones were split off); decoded they would
    // become a query or fragment on the dev proxy (Vite's `?raw`, `?import`...).
    // A `%` left after decoding is double encoding (`%2540fs` -> `%40fs`): it would slip past
    // the `@fs/` check and be decoded again by Vite or Tauri's asset lookup.
    if [path, decoded.as_str()].iter().any(|text| text.contains("..") || text.contains(['\\', '\0', ':', '?', '#']))
        || decoded.contains('%')
        || !decoded.starts_with('/')
    {
        return None;
    }
    let rel = decoded.trim_start_matches('/');
    Some(if rel.is_empty() { "index.html".to_owned() } else { rel.to_owned() })
}

fn extension(path: &str) -> Option<String> {
    let name = path.rsplit('/').next().unwrap_or(path);
    name.rsplit_once('.').map(|(_, ext)| ext.to_ascii_lowercase())
}

fn mime_for(path: &str) -> Option<&'static str> {
    Some(match extension(path)?.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "ico" => "image/x-icon",
        "wasm" => "application/wasm",
        "json" | "map" => "application/json",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "txt" => "text/plain; charset=utf-8",
        _ => return None,
    })
}

/// Marks the page as the web build: right after `<head …>`, else before `</head>`, else first.
fn inject_meta(html: &[u8]) -> Vec<u8> {
    let Ok(text) = std::str::from_utf8(html) else { return html.to_vec() };
    let lower = text.to_ascii_lowercase();
    let mut from = 0;
    while let Some(found) = lower[from..].find("<head") {
        let start = from + found;
        let next = lower.as_bytes().get(start + 5).copied();
        if matches!(next, Some(b'>') | Some(b' ') | Some(b'\t') | Some(b'\n') | Some(b'\r')) {
            if let Some(close) = lower[start..].find('>') {
                let at = start + close + 1;
                return [&text[..at], WEB_META, &text[at..]].concat().into_bytes();
            }
        }
        from = start + 5;
    }
    if let Some(at) = lower.find("</head>") {
        return [&text[..at], WEB_META, &text[at..]].concat().into_bytes();
    }
    [WEB_META, text].concat().into_bytes()
}

/// An HTML document, whatever it was labelled: `<!doctype html` or `<html` first.
fn looks_like_html(bytes: &[u8]) -> bool {
    let start = bytes.iter().position(|b| !b.is_ascii_whitespace()).unwrap_or(bytes.len());
    let head = String::from_utf8_lossy(&bytes[start..bytes.len().min(start + 16)]).to_ascii_lowercase();
    head.starts_with("<!doctype html") || head.starts_with("<html")
}

async fn static_file(request: &Request, path: &str, shared: &Shared) -> Response {
    if request.method != "GET" {
        return Response::text(405, "Method not allowed.");
    }
    let Some(rel) = asset_path(path) else { return Response::text(400, "Bad request path.") };
    let dev_proxy = dev_proxyable(&rel, shared.bound);
    let Some(asset) = shared.backend.asset(rel.clone(), dev_proxy).await else { return Response::text(404, "Not found.") };
    let is_index = rel == "index.html";
    let ext = extension(&rel);
    // The resolver answers unknown paths with index.html (typed by the requested path, so
    // the bytes tell); only `/` and real pages get HTML.
    let html_body = asset.mime.starts_with("text/html") || looks_like_html(&asset.bytes);
    if !is_index && !matches!(ext.as_deref(), Some("html" | "htm")) && html_body {
        return Response::text(404, "Not found.");
    }
    let mime = mime_for(&rel).map(str::to_owned).unwrap_or(asset.mime);
    if mime.starts_with("text/html") {
        let mut response = Response::new(200, &mime, inject_meta(&asset.bytes));
        response.html = Some(page_authority(request.header("host"), shared.bound));
        return response;
    }
    Response::new(200, &mime, asset.bytes)
}

// ---- WebSocket ----

fn ws_config() -> WebSocketConfig {
    WebSocketConfig::default().max_message_size(Some(MAX_WS_MESSAGE)).max_frame_size(Some(MAX_WS_MESSAGE))
}

/// Upgrades after the same Host and Origin checks as the API, answering the handshake
/// from the already-parsed request.
async fn websocket(mut stream: TcpStream, leftover: Vec<u8>, request: Request, ip: IpAddr, shared: Arc<Shared>) {
    let refusal = if !shared.host_ok(request.header("host")) || !origin_allowed(request.header("origin"), request.header("host")) {
        Some(Response::error(403, "Forbidden"))
    } else if request.method != "GET" {
        Some(Response::error(405, "Use GET."))
    } else if request.header("sec-websocket-version") != Some("13")
        || !request.header("connection").is_some_and(|value| has_token(value, "upgrade"))
        || request.header("sec-websocket-key").is_none_or(str::is_empty)
        || !leftover.is_empty()
    {
        Some(Response::error(400, "Malformed WebSocket handshake."))
    } else {
        None
    };
    if let Some(mut response) = refusal {
        response.no_store = true;
        // A handshake carries no body: only stray bytes after the head mean unread data.
        let unread = !leftover.is_empty();
        return refuse(&mut stream, &response, unread).await;
    }
    let accept = derive_accept_key(request.header("sec-websocket-key").unwrap_or_default().as_bytes());
    let head = format!("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n");
    let handshake = async { stream.write_all(head.as_bytes()).await.and(stream.flush().await) };
    if !matches!(tokio::time::timeout(WRITE_TIMEOUT, handshake).await, Ok(Ok(()))) {
        return;
    }
    let ws = WebSocketStream::from_raw_socket(stream, Role::Server, Some(ws_config())).await;
    session(ws, ip, shared).await;
}

/// Counts a client while it lives; the count always goes back down, however it ends.
struct ClientGuard(Arc<Shared>);

impl ClientGuard {
    fn new(shared: Arc<Shared>) -> Self {
        shared.clients.fetch_add(1, Ordering::SeqCst);
        shared.backend.changed();
        Self(shared)
    }
}

impl Drop for ClientGuard {
    fn drop(&mut self) {
        self.0.clients.fetch_sub(1, Ordering::SeqCst);
        // A retired server's clients leave as it stops or is replaced: announcing that would
        // flash "off" in Settings mid port switch (the stop or start announces itself).
        if !self.0.retired.load(Ordering::Acquire) {
            self.0.backend.changed();
        }
    }
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum ClientFrame {
    Auth { token: String },
    Subscribe { event: String },
    Unsubscribe { event: String },
    Ping,
}

/// One frame, bounded by [`WRITE_TIMEOUT`] so a client that stops reading can't stall its
/// session past a rotation or a stop; `false` ends the session.
async fn send<S: AsyncRead + AsyncWrite + Unpin>(ws: &mut WebSocketStream<S>, message: Message) -> bool {
    matches!(tokio::time::timeout(WRITE_TIMEOUT, ws.send(message)).await, Ok(Ok(())))
}

async fn close<S: AsyncRead + AsyncWrite + Unpin>(mut ws: WebSocketStream<S>, code: u16, reason: &'static str) {
    let frame = CloseFrame { code: CloseCode::from(code), reason: reason.into() };
    if send(&mut ws, Message::Close(Some(frame))).await {
        // Let the peer answer the close so the frame isn't lost to a reset.
        let _ = tokio::time::timeout(CLOSE_DRAIN, async { while let Some(Ok(_)) = ws.next().await {} }).await;
    }
}

/// The first text frame, skipping control frames; `None` for anything else.
async fn first_text<S: AsyncRead + AsyncWrite + Unpin>(ws: &mut WebSocketStream<S>) -> Option<String> {
    loop {
        match ws.next().await? {
            Ok(Message::Text(text)) => return Some(text.to_string()),
            Ok(Message::Ping(_) | Message::Pong(_)) => continue,
            _ => return None,
        }
    }
}

fn event_frame(name: &str, payload: &str) -> String {
    let payload = if payload.trim().is_empty() { "null" } else { payload };
    let name = serde_json::to_string(name).unwrap_or_else(|_| "\"\"".into());
    format!(r#"{{"type":"event","name":{name},"payload":{payload}}}"#)
}

/// Answers one client frame; `Some` is the reply to send.
fn client_frame(text: &str, subscriptions: &mut Subscriptions) -> Option<String> {
    let error = |message: &str| Some(serde_json::json!({ "type": "error", "message": message }).to_string());
    match serde_json::from_str::<ClientFrame>(text) {
        Ok(ClientFrame::Ping) => Some(r#"{"type":"pong"}"#.into()),
        Ok(ClientFrame::Subscribe { event }) => {
            let reply = serde_json::json!({ "type": "subscribed", "event": event }).to_string();
            match subscriptions.add(event) {
                Ok(()) => Some(reply),
                Err(message) => error(message),
            }
        }
        Ok(ClientFrame::Unsubscribe { event }) => {
            subscriptions.remove(&event);
            None
        }
        Ok(ClientFrame::Auth { .. }) => None,
        Err(_) => error("Unknown message."),
    }
}

async fn session<S: AsyncRead + AsyncWrite + Unpin>(mut ws: WebSocketStream<S>, ip: IpAddr, shared: Arc<Shared>) {
    let mut rotate = shared.rotate.clone();
    let first = tokio::time::timeout(AUTH_TIMEOUT, first_text(&mut ws)).await.ok().flatten();
    rotate.mark_unchanged();
    // The right token always gets in (throttling never locks the owner out); only a wrong
    // or missing one counts, and a throttled address is refused without counting more.
    // Kept: once a rotation retires it, this socket gets no more events, even in the
    // moment before its 4001 close goes out.
    let authed_token = first.and_then(|text| match serde_json::from_str::<ClientFrame>(&text) {
        Ok(ClientFrame::Auth { token }) if shared.token_ok(Some(&token)) => Some(token),
        _ => None,
    });
    let Some(authed_token) = authed_token else {
        let now = Instant::now();
        if shared.limiter.blocked(ip, now) {
            close(ws, CLOSE_UNAUTHORIZED, "Too many failed attempts").await;
            return;
        }
        shared.limiter.fail(ip, now);
        close(ws, CLOSE_UNAUTHORIZED, "Unauthorized").await;
        return;
    };
    if !send(&mut ws, Message::text(r#"{"type":"ready"}"#)).await {
        return;
    }
    let _client = ClientGuard::new(shared.clone());
    let mut events = shared.hub.tx.subscribe();
    let mut subscriptions = Subscriptions::new(shared.clone());
    let mut shutdown = shared.shutdown.clone();
    let mut ping = tokio::time::interval_at(tokio::time::Instant::now() + PING_EVERY, PING_EVERY);
    let ending = loop {
        tokio::select! {
            _ = stopped(&mut shutdown) => break Some((CLOSE_AWAY, "Server stopped")),
            changed = rotate.changed() => {
                if changed.is_err() { break Some((CLOSE_AWAY, "Server stopped")); }
                // Only sockets on a retired token go; one that already signed in with the new
                // token (inside the delay before this signal) stays.
                if !shared.token_ok(Some(&authed_token)) { break Some((CLOSE_UNAUTHORIZED, "Token rotated")); }
            }
            _ = ping.tick() => {
                if !send(&mut ws, Message::Ping(Default::default())).await { break None; }
            }
            event = events.recv() => match event {
                Ok(event) if subscriptions.contains(&event.0) => {
                    if !shared.token_ok(Some(&authed_token)) { continue; }
                    if !send(&mut ws, Message::text(event_frame(&event.0, &event.1))).await { break None; }
                }
                Ok(_) => {}
                // Events were dropped: tell the page so it reloads its state.
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    if !send(&mut ws, Message::text(r#"{"type":"lagged"}"#)).await { break None; }
                }
                Err(broadcast::error::RecvError::Closed) => break Some((CLOSE_AWAY, "Server stopped")),
            },
            message = ws.next() => match message {
                Some(Ok(Message::Text(text))) => {
                    if let Some(reply) = client_frame(text.as_str(), &mut subscriptions) {
                        if !send(&mut ws, Message::text(reply)).await { break None; }
                    }
                }
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break None,
                Some(Ok(_)) => {}
            },
        }
    };
    drop(subscriptions);
    if let Some((code, reason)) = ending {
        close(ws, code, reason).await;
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;

    const LOCAL: IpAddr = IpAddr::V4(Ipv4Addr::LOCALHOST);
    const INDEX: &str = "<!doctype html><html><head><title>PandaCode</title></head><body></body></html>";

    /// Stands in for the app: echoes invokes, serves two files (index.html for anything else,
    /// like Tauri's resolver) and lets a test emit events to whatever was listened to.
    #[derive(Default)]
    struct Fake {
        sinks: Mutex<Vec<(ListenerId, String, broadcast::Sender<HubEvent>)>>,
        next_id: AtomicUsize,
        changes: AtomicUsize,
        invoked: Mutex<Vec<String>>,
    }

    impl Fake {
        fn emit(&self, name: &str, payload: &str) {
            for (_, listened, sink) in lock(&self.sinks).iter() {
                if listened == name {
                    let _ = sink.send(Arc::new((name.to_owned(), payload.to_owned())));
                }
            }
        }
        fn listeners(&self, name: &str) -> usize {
            lock(&self.sinks).iter().filter(|(_, listened, _)| listened == name).count()
        }
    }

    impl Backend for Fake {
        /// Answers synthetic commands (`echo`, `hang`, ...) that no real backend registers.
        fn enforces_allowlist(&self) -> bool {
            false
        }
        fn rotate_if_token(&self, _expected: String) -> BoxFuture<Reply> {
            Box::pin(async { Reply::Unknown })
        }
        fn configure_if_token(&self, _expected: String, args: Value) -> BoxFuture<Reply> {
            lock(&self.invoked).push("web_server_configure".into());
            Box::pin(async move { Reply::Json(args.to_string()) })
        }
        fn invoke(&self, command: String, args: Value) -> BoxFuture<Reply> {
            lock(&self.invoked).push(command.clone());
            let reply = match command.as_str() {
                "echo" | "web_server_configure" | "tray_seen" => Reply::Json(args.to_string()),
                "bytes" => Reply::Bytes(vec![1, 2, 3]),
                "fail" => Reply::Error(Value::String("nope".into())),
                "gone" => Reply::NotReady,
                "hang" => Reply::TimedOut,
                _ => Reply::Unknown,
            };
            Box::pin(async move { reply })
        }
        fn asset(&self, path: String, _dev_proxy: bool) -> BoxFuture<Option<StaticAsset>> {
            let asset = match path.as_str() {
                "assets/app.js" => StaticAsset { bytes: b"console.log(1)".to_vec(), mime: "text/javascript".into() },
                "icon.svg" => StaticAsset { bytes: b"<svg/>".to_vec(), mime: "image/svg+xml".into() },
                // Tauri types its index.html fallback by the requested path.
                "assets/fallback.js" => StaticAsset { bytes: INDEX.as_bytes().to_vec(), mime: "text/javascript".into() },
                _ => StaticAsset { bytes: INDEX.as_bytes().to_vec(), mime: "text/html".into() },
            };
            Box::pin(async move { Some(asset) })
        }
        fn listen(&self, name: &str, sink: broadcast::Sender<HubEvent>) -> ListenerId {
            let id = self.next_id.fetch_add(1, Ordering::SeqCst) as ListenerId;
            lock(&self.sinks).push((id, name.to_owned(), sink));
            id
        }
        fn unlisten(&self, id: ListenerId) {
            lock(&self.sinks).retain(|(listened, _, _)| *listened != id);
        }
        fn changed(&self) {
            self.changes.fetch_add(1, Ordering::SeqCst);
        }
    }

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pandacode-web-server-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    struct Harness {
        server: WebServer,
        fake: Arc<Fake>,
        addr: SocketAddr,
        token: String,
    }

    fn token_of(status: &WebServerStatus) -> String {
        status.token_url.as_deref().unwrap().split_once("#token=").unwrap().1.to_owned()
    }

    async fn harness() -> Harness {
        let fake = Arc::new(Fake::default());
        let server = WebServer::new(temp_dir());
        let status = server.start(fake.clone(), LOCAL, 0, false).await.unwrap();
        let addr = SocketAddr::new(LOCAL, status.port);
        Harness { token: token_of(&status), server, fake, addr }
    }

    struct HttpReply {
        status: u16,
        head: String,
        body: Vec<u8>,
    }

    impl HttpReply {
        fn header(&self, name: &str) -> Option<String> {
            self.head.lines().find_map(|line| {
                let (key, value) = line.split_once(':')?;
                key.eq_ignore_ascii_case(name).then(|| value.trim().to_owned())
            })
        }
        fn text(&self) -> String {
            String::from_utf8_lossy(&self.body).into_owned()
        }
    }

    async fn send_raw(addr: SocketAddr, raw: &[u8]) -> HttpReply {
        let mut stream = TcpStream::connect(addr).await.unwrap();
        stream.write_all(raw).await.unwrap();
        let mut out = Vec::new();
        tokio::time::timeout(Duration::from_secs(5), stream.read_to_end(&mut out)).await.unwrap().unwrap();
        let end = find(&out, b"\r\n\r\n").expect("a response head");
        let head = String::from_utf8(out[..end].to_vec()).unwrap();
        let status = head.split(' ').nth(1).unwrap().parse().unwrap();
        HttpReply { status, head, body: out[end + 4..].to_vec() }
    }

    async fn request(addr: SocketAddr, method: &str, path: &str, headers: &[(&str, String)], body: &str) -> HttpReply {
        let mut raw = format!("{method} {path} HTTP/1.1\r\nConnection: close\r\nContent-Length: {}\r\n", body.len());
        for (name, value) in headers {
            raw.push_str(&format!("{name}: {value}\r\n"));
        }
        raw.push_str("\r\n");
        raw.push_str(body);
        send_raw(addr, raw.as_bytes()).await
    }

    fn host(addr: SocketAddr) -> (&'static str, String) {
        ("Host", format!("127.0.0.1:{}", addr.port()))
    }

    fn bearer(token: &str) -> (&'static str, String) {
        ("Authorization", format!("Bearer {token}"))
    }

    // ---- Pure checks ----

    #[test]
    fn loopback_host_check_stops_dns_rebinding() {
        let bound: SocketAddr = "127.0.0.1:47322".parse().unwrap();
        // Any port: an `ssh -L 9000:127.0.0.1:47322` tunnel arrives as 127.0.0.1:9000.
        for host in ["127.0.0.1", "127.0.0.1:47322", "localhost", "LOCALHOST:47322", "[::1]", "[::1]:47322", "127.0.0.1:9000", "localhost:9000", "[::1]:9000", "127.0.0.1:80"] {
            assert!(host_allowed(Some(host), bound, &[]), "{host}");
        }
        // IPv4-mapped loopback is loopback, as a Host literal and as the bound address.
        assert!(host_allowed(Some("[::ffff:127.0.0.1]:47322"), bound, &[]));
        let mapped: SocketAddr = "[::ffff:127.0.0.1]:47322".parse().unwrap();
        assert!(host_allowed(Some("localhost:47322"), mapped, &[]));
        assert!(!host_allowed(Some("evil.com:47322"), mapped, &[]));
        assert_eq!(url_authority(mapped), "127.0.0.1:47322");
        for host in ["evil.com", "evil.com:47322", "evil.com:8787", "localhost:0", "127.0.0.1:99999", "127.0.0.1.evil.com", "[::1]x", "", "a@127.0.0.1"] {
            assert!(!host_allowed(Some(host), bound, &[]), "{host}");
        }
        assert!(!host_allowed(None, bound, &[]));
        // Off loopback a Host is still required, and it must be an address, not a DNS name.
        let lan: SocketAddr = "0.0.0.0:47322".parse().unwrap();
        assert!(host_allowed(Some("192.168.1.5:47322"), lan, &[]));
        assert!(!host_allowed(Some("my-box.local:47322"), lan, &[]));
        assert!(!host_allowed(None, lan, &[]));
        assert!(!host_allowed(Some(""), lan, &[]));
    }

    #[test]
    fn origin_must_match_host() {
        assert!(origin_allowed(None, Some("127.0.0.1:1")));
        assert!(origin_allowed(Some("http://127.0.0.1:1"), Some("127.0.0.1:1")));
        assert!(origin_allowed(Some("HTTP://LocalHost:1"), Some("localhost:1")));
        assert!(origin_allowed(Some("https://[::1]:1"), Some("[::1]:1")));
        assert!(origin_allowed(Some("http://localhost"), Some("localhost")));
        for origin in ["http://evil.com", "http://localhost:2", "http://127.0.0.1:1.evil.com", "null", "file://", "ws://127.0.0.1:1", "http://127.0.0.1:1/x"] {
            assert!(!origin_allowed(Some(origin), Some("127.0.0.1:1")), "{origin}");
        }
        assert!(!origin_allowed(Some("http://127.0.0.1:1"), None));
    }

    #[test]
    fn token_comparison_and_generation() {
        assert!(same("abc", "abc"));
        assert!(!same("abc", "abd"));
        assert!(!same("abc", "abcd"));
        let token = new_token();
        assert_eq!(token.len(), 64);
        assert!(token.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)), "{token}");
        assert_ne!(token, new_token());
    }

    #[test]
    fn paths_cannot_leave_the_bundle() {
        assert_eq!(asset_path("/").as_deref(), Some("index.html"));
        assert_eq!(asset_path("/index.html").as_deref(), Some("index.html"));
        assert_eq!(asset_path("/assets/app-1.js").as_deref(), Some("assets/app-1.js"));
        assert_eq!(asset_path("/a%20b.png").as_deref(), Some("a b.png"));
        for path in ["/../etc/passwd", "/assets/..", "/%2e%2e/x", "/%2E%2E%2Fx", "/a\\b", "/a%5cb", "/a%00b", "/%zz", "/%", "/http://169.254.169.254/x", "/http%3A//169.254.169.254/x", "/a:b"] {
            assert_eq!(asset_path(path), None, "{path}");
        }
    }

    #[test]
    fn meta_goes_into_the_head() {
        let out = String::from_utf8(inject_meta(INDEX.as_bytes())).unwrap();
        assert!(out.starts_with(&format!("<!doctype html><html><head>{WEB_META}<title>")));
        let out = String::from_utf8(inject_meta(b"<HEAD lang=\"en\"><x>")).unwrap();
        assert_eq!(out, format!("<HEAD lang=\"en\">{WEB_META}<x>"));
        // `<header>` is not the head.
        let out = String::from_utf8(inject_meta(b"<header></header></head>")).unwrap();
        assert_eq!(out, format!("<header></header>{WEB_META}</head>"));
        assert!(String::from_utf8(inject_meta(b"plain")).unwrap().starts_with(WEB_META));
    }

    #[test]
    fn mime_types_and_event_names() {
        assert_eq!(mime_for("a/b.MJS"), Some("text/javascript; charset=utf-8"));
        assert_eq!(mime_for("x.wasm"), Some("application/wasm"));
        assert_eq!(mime_for("x.woff2"), Some("font/woff2"));
        assert_eq!(mime_for("x.map"), Some("application/json"));
        assert_eq!(mime_for("noext"), None);
        assert!(valid_event_name("session-update"));
        assert!(valid_event_name("plugin:x/y_z"));
        for name in ["", "a b", "a.b", "é", &"x".repeat(129)] {
            assert!(!valid_event_name(name), "{name}");
        }
    }

    #[test]
    fn event_payloads_are_spliced_not_reencoded() {
        let frame: Value = serde_json::from_str(&event_frame("e\"v", r#"{"a":[1,2]}"#)).unwrap();
        assert_eq!(frame, serde_json::json!({ "type": "event", "name": "e\"v", "payload": { "a": [1, 2] } }));
        let frame: Value = serde_json::from_str(&event_frame("e", "")).unwrap();
        assert_eq!(frame["payload"], Value::Null);
    }

    #[test]
    fn cli_flags_and_environment() {
        let args = |text: &str| text.split_whitespace().map(str::to_owned).collect::<Vec<_>>();
        let web = |port: u16, host: Option<&str>, allowed: &[&str]| CliWeb {
            port,
            host: host.map(|host| host.parse().unwrap()),
            allowed_hosts: allowed.iter().map(|name| (*name).to_owned()).collect(),
        };
        assert_eq!(parse_cli(&args(""), None, None, None), Ok(None));
        assert_eq!(parse_cli(&args("--port 8080"), None, None, None), Ok(Some(web(8080, None, &[]))));
        assert_eq!(parse_cli(&args("--web-port=9 --web-host ::1"), None, None, None), Ok(Some(web(9, Some("::1"), &[]))));
        assert_eq!(parse_cli(&args("--host [::1] --port 1"), None, None, None).unwrap().unwrap().host, Some("::1".parse().unwrap()));
        assert_eq!(parse_cli(&args("--other x"), Some("7000"), Some("0.0.0.0"), None), Ok(Some(web(7000, Some("0.0.0.0"), &[]))));
        // Flags win over the environment; an empty variable is unset.
        assert_eq!(parse_cli(&args("--port 1"), Some("2"), None, None).unwrap().unwrap().port, 1);
        assert_eq!(parse_cli(&args(""), Some(" "), None, None), Ok(None));
        assert_eq!(parse_cli(&args("--host 0.0.0.0"), None, None, None), Err("--host requires --port.".into()));
        assert_eq!(parse_cli(&args("--web-host=::1"), None, None, None), Err("--host requires --port.".into()));
        assert_eq!(parse_cli(&args("--host 0.0.0.0"), Some("5"), None, None).unwrap().unwrap().port, 5);
        // An environment host alone is ignored, not an error.
        assert_eq!(parse_cli(&args(""), None, Some("0.0.0.0"), None), Ok(None));
        // ...and never applies to an explicit `--port`: that one stays on loopback.
        assert_eq!(parse_cli(&args("--port 8787"), None, Some("0.0.0.0"), None), Ok(Some(web(8787, None, &[]))));
        assert_eq!(parse_cli(&args("--web-port=8787"), Some("9000"), Some("0.0.0.0"), None), Ok(Some(web(8787, None, &[]))));
        // The environment's port takes the environment's host...
        assert_eq!(parse_cli(&args(""), Some("8787"), Some("0.0.0.0"), None), Ok(Some(web(8787, Some("0.0.0.0"), &[]))));
        // ...unless a `--host` flag says otherwise, with either kind of port.
        assert_eq!(parse_cli(&args("--host ::1"), Some("8787"), Some("0.0.0.0"), None).unwrap().unwrap().host, Some("::1".parse().unwrap()));
        assert_eq!(parse_cli(&args("--port 1 --host ::1"), None, Some("0.0.0.0"), None).unwrap().unwrap().host, Some("::1".parse().unwrap()));
        // A bad environment host is not read (so not an error) once `--port` was given.
        assert!(parse_cli(&args("--port 1"), None, Some("nope"), None).is_ok());
        assert!(parse_cli(&args(""), Some("1"), Some("nope"), None).is_err());
        for bad in ["--port", "--port x", "--port 65536", "--host nope --port 1", "--web-port=-1"] {
            assert!(parse_cli(&args(bad), None, None, None).is_err(), "{bad}");
        }
        assert!(parse_cli(&args(""), Some("abc"), None, None).is_err());
    }

    #[test]
    fn cli_accepts_trusted_host_names_from_flags_and_the_environment() {
        let args = |text: &str| text.split_whitespace().map(str::to_owned).collect::<Vec<_>>();
        let names = |web: CliWeb| web.allowed_hosts;
        // Repeatable, both spellings, any order, normalized case.
        let web = parse_cli(&args("--port 1 --allowed-host My-Mac.Tail1234.ts.net --allowed-host=box.local"), None, None, None)
            .unwrap()
            .unwrap();
        assert_eq!((web.port, names(web)), (1, vec!["my-mac.tail1234.ts.net".to_owned(), "box.local".to_owned()]));
        // An IP literal is kept in the form Host checks compare against.
        let web = parse_cli(&args("--allowed-host [FD7A:115C:A1E0::5] --port 2"), None, None, None).unwrap().unwrap();
        assert_eq!(names(web), ["[fd7a:115c:a1e0::5]"]);
        // It needs a port, from a flag or the environment.
        assert_eq!(parse_cli(&args("--allowed-host box.local"), None, None, None), Err("--allowed-host requires --port.".into()));
        assert!(parse_cli(&args("--allowed-host box.local"), Some("5"), None, None).is_ok());
        // The environment list pairs only with the environment port; flags win.
        let web = parse_cli(&args(""), Some("8787"), None, Some(" my-mac.tail.ts.net, ,box.local ,")).unwrap().unwrap();
        assert_eq!(names(web), ["my-mac.tail.ts.net", "box.local"]);
        let web = parse_cli(&args("--port 1"), None, None, Some("ignored.ts.net")).unwrap().unwrap();
        assert!(names(web).is_empty());
        let web = parse_cli(&args("--port 1 --allowed-host flag.ts.net"), None, None, Some("env.ts.net")).unwrap().unwrap();
        assert_eq!(names(web), ["flag.ts.net"]);
        assert_eq!(parse_cli(&args(""), None, None, Some("env.ts.net")), Ok(None));
        // Bad names are refused wherever they come from.
        for entry in ["", " ", "https://x.ts.net", "x.ts.net:443", "x/y", "a@b", "a b"] {
            let args = vec!["--port".to_owned(), "1".to_owned(), "--allowed-host".to_owned(), entry.to_owned()];
            assert!(parse_cli(&args, None, None, None).is_err(), "{entry:?}");
        }
        assert!(parse_cli(&args(""), Some("1"), None, Some("bad/name")).is_err());
        assert!(parse_cli(&args("--port 1 --allowed-host a.ts.net --allowed-host A.ts.net"), None, None, None).is_err());
    }

    #[test]
    fn config_round_trips_and_defaults_off() {
        let dir = temp_dir();
        assert_eq!(load_config(&dir), Config { enabled: false, port: DEFAULT_PORT, host: None, allowed_hosts: Vec::new() });
        save_config(&dir, Config { enabled: true, port: 8123, ..Config::default() }).unwrap();
        assert_eq!(load_config(&dir), Config { enabled: true, port: 8123, ..Config::default() });
        let saved: Value = serde_json::from_slice(&std::fs::read(dir.join(CONFIG_FILE)).unwrap()).unwrap();
        assert_eq!(saved, serde_json::json!({ "enabled": true, "port": 8123 }));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.join(CONFIG_FILE)).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        // No temp files left behind; garbage reads as the default.
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        std::fs::write(dir.join(CONFIG_FILE), b"{oops").unwrap();
        assert_eq!(load_config(&dir), Config::default());
        assert!(!WebServer::new(dir).status().running);
    }

    #[test]
    fn config_round_trips_a_bind_address_and_trusted_names() {
        let dir = temp_dir();
        let config = Config {
            enabled: true,
            port: 8787,
            host: Some("100.64.1.5".parse().unwrap()),
            allowed_hosts: vec!["my-mac.tail1234.ts.net".into(), "box.local".into()],
        };
        save_config(&dir, config.clone()).unwrap();
        assert_eq!(load_config(&dir), config);
        let saved: Value = serde_json::from_slice(&std::fs::read(dir.join(CONFIG_FILE)).unwrap()).unwrap();
        assert_eq!(saved["host"], "100.64.1.5");
        assert_eq!(saved["allowed_hosts"], serde_json::json!(["my-mac.tail1234.ts.net", "box.local"]));
        // A loopback bind and an empty list stay out of the file entirely.
        save_config(&dir, Config { enabled: true, port: 8787, host: Some(DEFAULT_HOST), allowed_hosts: Vec::new() }).unwrap();
        let saved: Value = serde_json::from_slice(&std::fs::read(dir.join(CONFIG_FILE)).unwrap()).unwrap();
        assert!(saved.get("host").is_none() && saved.get("allowed_hosts").is_none(), "{saved}");
        assert_eq!(load_config(&dir), Config { enabled: true, port: 8787, ..Config::default() });
    }

    #[test]
    fn old_format_configs_load_as_loopback_with_no_trusted_names() {
        let dir = temp_dir();
        std::fs::write(dir.join(CONFIG_FILE), br#"{"enabled":true,"port":8123}"#).unwrap();
        let config = load_config(&dir);
        assert_eq!(config, Config { enabled: true, port: 8123, host: None, allowed_hosts: Vec::new() });
        assert_eq!(config.bind_host(), DEFAULT_HOST);
        // A hand-edited file is normalized on load rather than trusted.
        std::fs::write(dir.join(CONFIG_FILE), br#"{"enabled":false,"port":8123,"allowed_hosts":["My-Mac.Tail.ts.net","bad/name","[FD7A::5]"]}"#).unwrap();
        let config = load_config(&dir);
        assert_eq!(config.allowed_hosts, ["my-mac.tail.ts.net", "[fd7a::5]"]);
        assert_eq!(config.bind_host(), DEFAULT_HOST);
    }

    #[test]
    fn trusted_host_names_are_validated() {
        assert_eq!(
            validate_allowed_hosts(&["My-Mac.Tail1234.ts.net".into(), " box.local ".into()]).unwrap(),
            ["my-mac.tail1234.ts.net", "box.local"]
        );
        assert_eq!(validate_allowed_hosts(&["100.64.1.5".into(), "[FD7A::5]".into()]).unwrap(), ["100.64.1.5", "[fd7a::5]"]);
        for bad in [
            "", " ", "https://my-mac.tail.ts.net", "my-mac.tail.ts.net:443", "my-mac.tail.ts.net/path", "a?b", "a#b",
            "a@b", "a b", "a\tb", ".box.local", "box.local.", "a..b", "-box.local", "box-.local", "é.local", "[::1]x",
        ] {
            assert!(validate_allowed_hosts(&[bad.into()]).is_err(), "{bad:?}");
        }
        assert!(validate_allowed_hosts(&["box.local".into(), "BOX.local".into()]).is_err(), "duplicates are refused");
        assert!(validate_allowed_hosts(&["a".repeat(MAX_ALLOWED_HOST_LEN + 1)]).is_err());
        let many: Vec<String> = (0..=MAX_ALLOWED_HOSTS).map(|index| format!("box{index}.local")).collect();
        assert!(validate_allowed_hosts(&many).is_err(), "count is bounded");
        let most: Vec<String> = (0..MAX_ALLOWED_HOSTS).map(|index| format!("box{index}.local")).collect();
        assert_eq!(validate_allowed_hosts(&most).unwrap().len(), MAX_ALLOWED_HOSTS);
    }

    #[test]
    fn trusted_host_names_are_accepted_only_where_listed() {
        let bound: SocketAddr = "127.0.0.1:8787".parse().unwrap();
        let allowed = ["my-mac.tail1234.ts.net".to_owned(), "[fd7a::5]".to_owned()];
        assert!(host_allowed(Some("my-mac.tail1234.ts.net:8787"), bound, &allowed));
        assert!(host_allowed(Some("MY-MAC.tail1234.ts.net"), bound, &allowed));
        assert!(host_allowed(Some("[FD7A::5]:8787"), bound, &allowed));
        // An IP literal is compared by address, so any spelling of it matches.
        assert!(host_allowed(Some("[fd7a:0:0:0:0:0:0:5]:8787"), bound, &allowed));
        // The usual loopback names still work, and unlisted DNS names still don't.
        assert!(host_allowed(Some("localhost:8787"), bound, &allowed));
        assert!(!host_allowed(Some("other.tail1234.ts.net:8787"), bound, &allowed));
        assert!(!host_allowed(Some("my-mac.tail1234.ts.net:0"), bound, &allowed));
        assert!(!host_allowed(None, bound, &allowed));
        // A trusted name also reaches a listener bound to one non-loopback address...
        let tailscale: SocketAddr = "100.64.1.5:8787".parse().unwrap();
        assert!(host_allowed(Some("my-mac.tail1234.ts.net:8787"), tailscale, &allowed));
        assert!(!host_allowed(Some("other.tail1234.ts.net:8787"), tailscale, &allowed));
        assert!(!host_allowed(Some("my-box.local:8787"), tailscale, &allowed));
        // ...but never widens an unlisted name on the wildcard bind.
        let any: SocketAddr = "0.0.0.0:8787".parse().unwrap();
        assert!(!host_allowed(Some("my-box.local:8787"), any, &allowed));
        // No list: exactly the old behaviour.
        assert!(!host_allowed(Some("my-mac.tail1234.ts.net:8787"), bound, &[]));
    }

    #[test]
    fn status_urls() {
        assert_eq!(url_authority("127.0.0.1:5".parse().unwrap()), "127.0.0.1:5");
        assert_eq!(url_authority("[::1]:5".parse().unwrap()), "[::1]:5");
        assert_eq!(url_authority("0.0.0.0:5".parse().unwrap()), "127.0.0.1:5");
        let status = WebServer::new(temp_dir()).status();
        assert_eq!((status.running, status.port, status.configured_port, status.url.clone(), status.token_url.clone()), (false, 0, DEFAULT_PORT, None, None));
        assert_eq!((status.configured_host.as_str(), status.allowed_hosts.clone()), ("127.0.0.1", Vec::new()));
        let json = serde_json::to_value(&status).unwrap();
        for key in ["enabled", "running", "host", "port", "configuredPort", "configuredHost", "allowedHosts", "url", "tokenUrl", "clients", "error"] {
            assert!(json.get(key).is_some(), "{key}");
        }
    }

    #[test]
    fn a_loopback_link_uses_the_first_trusted_name_over_https() {
        let loopback: SocketAddr = "127.0.0.1:8787".parse().unwrap();
        assert_eq!(status_url(loopback, &[]), "http://127.0.0.1:8787");
        let names = ["my-mac.tail1234.ts.net".to_owned(), "second.ts.net".to_owned()];
        assert_eq!(status_url(loopback, &names), "https://my-mac.tail1234.ts.net:8787");
        // A non-loopback bind keeps its plain-HTTP address even with a trusted name.
        let tailscale: SocketAddr = "100.64.1.5:8787".parse().unwrap();
        assert_eq!(status_url(tailscale, &names), "http://100.64.1.5:8787");
    }

    // ---- Over TCP ----

    #[tokio::test]
    async fn auth_needs_the_token_and_brute_force_is_throttled() {
        let h = harness().await;
        let none = request(h.addr, "POST", "/api/auth", &[host(h.addr)], "").await;
        assert_eq!(none.status, 401);
        assert_eq!(none.text(), r#"{"error":"Invalid access token."}"#);
        assert_eq!(none.header("cache-control").as_deref(), Some("no-store"));
        assert!(none.header("access-control-allow-origin").is_none());
        let ok = request(h.addr, "POST", "/api/auth", &[host(h.addr), bearer(&h.token)], "").await;
        assert_eq!(ok.status, 200);
        let body: Value = serde_json::from_slice(&ok.body).unwrap();
        assert_eq!(body["ok"], true);
        assert_eq!(body["port"], h.addr.port());
        assert_eq!(body["version"], env!("CARGO_PKG_VERSION"));
        for _ in 1..MAX_FAILURES {
            assert_eq!(request(h.addr, "POST", "/api/auth", &[host(h.addr), bearer("wrong")], "").await.status, 401);
        }
        // Wrong guesses are throttled now; the right token still always works.
        assert_eq!(request(h.addr, "POST", "/api/auth", &[host(h.addr), bearer("wrong")], "").await.status, 429);
        assert_eq!(request(h.addr, "POST", "/api/auth", &[host(h.addr)], "").await.status, 429);
        assert_eq!(request(h.addr, "POST", "/api/auth", &[host(h.addr), bearer(&h.token)], "").await.status, 200);
        let invoke = request(h.addr, "POST", "/api/invoke", &[host(h.addr), bearer(&h.token)], r#"{"command":"echo"}"#).await;
        assert_eq!(invoke.status, 200);
        // So does the WebSocket, while a wrong token there is refused.
        let mut ws = authed(h.addr, &h.token).await;
        ws.send(Message::text(r#"{"type":"ping"}"#)).await.unwrap();
        assert_eq!(next_text(&mut ws).await["type"], "pong");
        let mut wrong = ws_connect(h.addr, None).await.unwrap();
        wrong.send(Message::text(r#"{"type":"auth","token":"nope"}"#)).await.unwrap();
        assert_eq!(close_code(&mut wrong).await.0, 4001);
        h.server.stop().await;
    }

    #[tokio::test]
    async fn host_and_origin_are_enforced_over_the_wire() {
        let h = harness().await;
        let evil = request(h.addr, "POST", "/api/auth", &[("Host", "evil.com".into()), bearer(&h.token)], "").await;
        assert_eq!(evil.status, 403);
        assert_eq!(request(h.addr, "GET", "/", &[("Host", "evil.com".into())], "").await.status, 403);
        assert_eq!(request(h.addr, "GET", "/", &[], "").await.status, 403);
        let cross = request(h.addr, "POST", "/api/invoke", &[host(h.addr), bearer(&h.token), ("Origin", "http://evil.com".into())], r#"{"command":"echo"}"#).await;
        assert_eq!(cross.status, 403);
        let same_origin = (("Origin"), format!("http://127.0.0.1:{}", h.addr.port()));
        let ok = request(h.addr, "POST", "/api/invoke", &[host(h.addr), bearer(&h.token), same_origin], r#"{"command":"echo"}"#).await;
        assert_eq!(ok.status, 200);
        let localhost = ("Host", format!("localhost:{}", h.addr.port()));
        assert_eq!(request(h.addr, "POST", "/api/auth", &[localhost, bearer(&h.token)], "").await.status, 200);
        h.server.stop().await;
    }

    #[tokio::test]
    async fn a_trusted_host_name_is_served_live_and_still_needs_the_token() {
        let h = harness().await;
        let change = Configure {
            enabled: true,
            port: Some(h.addr.port()),
            allowed_hosts: Some(vec!["my-mac.tail1234.ts.net".into()]),
            persist: Some(false),
            ..Default::default()
        };
        let configured = h.server.configure(h.fake.clone(), change, None).await.unwrap();
        assert_eq!(configured.port, h.addr.port(), "the allowlist changed in place, no restart");
        assert_eq!(configured.allowed_hosts, ["my-mac.tail1234.ts.net"]);
        assert_eq!(token_of(&configured), h.token, "changing trusted names never rotates the token");
        let named = ("Host", format!("my-mac.tail1234.ts.net:{}", h.addr.port()));
        // With the token: served where the old rules gave 403.
        assert_eq!(request(h.addr, "POST", "/api/auth", &[named.clone(), bearer(&h.token)], "").await.status, 200);
        // Without it: still 401.
        assert_eq!(request(h.addr, "POST", "/api/auth", std::slice::from_ref(&named), "").await.status, 401);
        // An unlisted name stays 403 even with the token.
        let other = ("Host", format!("other.tail1234.ts.net:{}", h.addr.port()));
        assert_eq!(request(h.addr, "POST", "/api/auth", &[other, bearer(&h.token)], "").await.status, 403);
        // Origin must still match Host exactly, over https too.
        let mismatch = ("Origin", "https://other.tail1234.ts.net".to_owned());
        let reply = request(h.addr, "POST", "/api/invoke", &[named.clone(), bearer(&h.token), mismatch], r#"{"command":"echo"}"#).await;
        assert_eq!(reply.status, 403);
        let same = ("Origin", format!("https://my-mac.tail1234.ts.net:{}", h.addr.port()));
        let reply = request(h.addr, "POST", "/api/invoke", &[named.clone(), bearer(&h.token), same], r#"{"command":"echo"}"#).await;
        assert_eq!(reply.status, 200);
        // Clearing the live list is the same in-place path, still with the same token.
        let cleared = Configure {
            enabled: true,
            port: Some(h.addr.port()),
            allowed_hosts: Some(Vec::new()),
            persist: Some(false),
            ..Default::default()
        };
        let cleared = h.server.configure(h.fake.clone(), cleared, None).await.unwrap();
        assert!(cleared.allowed_hosts.is_empty());
        assert_eq!(token_of(&cleared), h.token);
        assert_eq!(request(h.addr, "POST", "/api/auth", &[named, bearer(&h.token)], "").await.status, 403);
        h.server.stop().await;
    }

    #[tokio::test]
    async fn settings_persist_the_bind_address_and_trusted_names_across_a_stop() {
        let dir = temp_dir();
        let fake = Arc::new(Fake::default());
        let server = WebServer::new(dir.clone());
        let port = free_port();
        let change = Configure {
            enabled: true,
            port: Some(port),
            host: Some("::1".into()),
            allowed_hosts: Some(vec!["My-Mac.Tail1234.ts.net".into()]),
            persist: Some(true),
        };
        let started = server.configure(fake.clone(), change, None).await.unwrap();
        assert_eq!((started.host.as_str(), started.configured_host.as_str()), ("::1", "::1"));
        assert_eq!(started.allowed_hosts, ["my-mac.tail1234.ts.net"]);
        let saved = load_config(&dir);
        assert_eq!((saved.enabled, saved.port, saved.host), (true, port, Some("::1".parse().unwrap())));
        assert_eq!(saved.allowed_hosts, ["my-mac.tail1234.ts.net"]);
        // ::1 is loopback, so the link prefers the trusted name over https.
        assert!(started.url.as_deref().unwrap().starts_with("https://my-mac.tail1234.ts.net:"), "{:?}", started.url);
        // A stop keeps the saved address instead of forgetting it.
        let off = server.stop_and_save(None, true).await.unwrap();
        assert_eq!(off.configured_host, "::1");
        assert_eq!(lock(&server.state).host, "::1".parse::<IpAddr>().unwrap());
        assert_eq!(load_config(&dir).host, Some("::1".parse().unwrap()));
        // Settings "on" with no host binds the saved address again.
        let restarted = server.start(fake.clone(), server.configure_ip(None).unwrap(), load_config(&dir).port, true).await.unwrap();
        assert_eq!(restarted.host, "::1");
        assert_eq!(restarted.configured_host, "::1");
        assert_eq!(restarted.allowed_hosts, ["my-mac.tail1234.ts.net"]);
        server.stop().await;
        // A fresh process (start_if_saved's path) starts on the saved address and names.
        let reopened = WebServer::new(dir.clone());
        let saved = lock(&reopened.state).config.clone();
        assert!(saved.enabled);
        let status = reopened.start(fake.clone(), saved.bind_host(), saved.port, false).await.unwrap();
        assert_eq!((status.host.as_str(), status.configured_host.as_str()), ("::1", "::1"));
        assert_eq!(status.allowed_hosts, ["my-mac.tail1234.ts.net"]);
        reopened.stop().await;
    }

    #[tokio::test]
    async fn invoke_maps_replies() {
        let h = harness().await;
        let (addr, token) = (h.addr, h.token.clone());
        let call = |body: &'static str| {
            let headers = [host(addr), bearer(&token)];
            async move { request(addr, "POST", "/api/invoke", &headers, body).await }
        };
        let echo = call(r#"{"command":"echo","args":{"sessionId":"s1"}}"#).await;
        assert_eq!((echo.status, echo.text().as_str()), (200, r#"{"sessionId":"s1"}"#));
        assert_eq!(echo.header("content-type").as_deref(), Some("application/json"));
        assert_eq!(call(r#"{"command":"echo"}"#).await.text(), "{}");
        let bytes = call(r#"{"command":"bytes"}"#).await;
        assert_eq!((bytes.status, bytes.body.clone()), (200, vec![1, 2, 3]));
        assert_eq!(bytes.header("content-type").as_deref(), Some("application/octet-stream"));
        let fail = call(r#"{"command":"fail"}"#).await;
        assert_eq!((fail.status, fail.text().as_str()), (400, r#"{"error":"nope"}"#));
        let unknown = call(r#"{"command":"nope"}"#).await;
        assert_eq!((unknown.status, unknown.text().as_str()), (404, r#"{"error":"Unknown command."}"#));
        let gone = call(r#"{"command":"gone"}"#).await;
        assert_eq!((gone.status, gone.text().as_str()), (503, r#"{"error":"PandaCode session is not ready."}"#));
        assert_eq!(call("not json").await.status, 400);
        assert_eq!(call(r#"{"command":"echo","args":[1]}"#).await.status, 400);
        assert_eq!(call(r#"{"command":""}"#).await.status, 400);
        let get = request(h.addr, "GET", "/api/invoke", &[host(h.addr), bearer(&h.token)], "").await;
        assert_eq!(get.status, 405);
        assert_eq!(request(h.addr, "GET", "/api/nothing", &[host(h.addr)], "").await.status, 404);
        h.server.stop().await;
    }

    #[test]
    fn tauri_replies_map_to_http_outcomes() {
        use tauri::ipc::{InvokeError, InvokeResponse, InvokeResponseBody};
        assert_eq!(reply_from("x", InvokeResponse::Ok(InvokeResponseBody::Json("[1]".into()))), Reply::Json("[1]".into()));
        assert_eq!(reply_from("x", InvokeResponse::Ok(InvokeResponseBody::Raw(vec![9]))), Reply::Bytes(vec![9]));
        assert_eq!(reply_from("x", InvokeResponse::Err(InvokeError(Value::String("Command x not found".into())))), Reply::Unknown);
        assert_eq!(reply_from("x", InvokeResponse::Err(InvokeError(Value::String("bad".into())))), Reply::Error(Value::String("bad".into())));
        assert!(local_tauri_url().scheme() == "tauri" || local_tauri_url().as_str() == "http://tauri.localhost/");
    }

    #[tokio::test]
    async fn static_files_get_meta_and_security_headers() {
        let h = harness().await;
        let index = request(h.addr, "GET", "/", &[host(h.addr)], "").await;
        assert_eq!(index.status, 200);
        assert!(index.text().contains(&format!("<head>{WEB_META}")));
        let policy = index.header("content-security-policy").unwrap();
        let authority = format!("127.0.0.1:{}", h.addr.port());
        assert_eq!(policy, csp(&authority));
        assert!(policy.contains(&format!("connect-src 'self' ws://{authority} wss://{authority};")), "{policy}");
        assert!(!policy.contains("blob:") && !policy.contains(" ws: ") && !policy.contains(" wss:;"), "{policy}");
        let named = request(h.addr, "GET", "/", &[("Host", format!("localhost:{}", h.addr.port()))], "").await;
        assert!(named.header("content-security-policy").unwrap().contains(&format!("ws://localhost:{}", h.addr.port())));
        assert_eq!(index.header("x-frame-options").as_deref(), Some("DENY"));
        assert_eq!(index.header("x-content-type-options").as_deref(), Some("nosniff"));
        assert_eq!(index.header("referrer-policy").as_deref(), Some("no-referrer"));
        assert!(index.header("content-type").unwrap().starts_with("text/html"));
        let script = request(h.addr, "GET", "/assets/app.js?v=1", &[host(h.addr)], "").await;
        assert_eq!((script.status, script.text().as_str()), (200, "console.log(1)"));
        assert_eq!(script.header("content-type").as_deref(), Some("text/javascript; charset=utf-8"));
        assert!(script.header("content-security-policy").is_none());
        assert_eq!(script.header("x-content-type-options").as_deref(), Some("nosniff"));
        assert_eq!(request(h.addr, "GET", "/icon.svg", &[host(h.addr)], "").await.header("content-type").as_deref(), Some("image/svg+xml"));
        // The resolver's index.html fallback never stands in for a missing file or route.
        assert_eq!(request(h.addr, "GET", "/assets/missing.js", &[host(h.addr)], "").await.status, 404);
        assert_eq!(request(h.addr, "GET", "/assets/fallback.js", &[host(h.addr)], "").await.status, 404);
        assert_eq!(request(h.addr, "GET", "/settings", &[host(h.addr)], "").await.status, 404);
        assert!(request(h.addr, "GET", "/index.html", &[host(h.addr)], "").await.text().contains(WEB_META));
        for path in ["/../etc/passwd", "/assets/%2e%2e/secret", "/a\\b", "/x/..", "/%2E%2E/x"] {
            assert_eq!(request(h.addr, "GET", path, &[host(h.addr)], "").await.status, 400, "{path}");
        }
        assert_eq!(request(h.addr, "POST", "/", &[host(h.addr)], "").await.status, 405);
        h.server.stop().await;
    }

    #[tokio::test]
    async fn oversized_and_malformed_requests_are_refused() {
        let h = harness().await;
        let port = h.addr.port();
        // No token: refused from the head alone, the (never sent) body is not awaited.
        let big = format!("POST /api/invoke HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Length: {}\r\n\r\n", MAX_BODY + 1);
        let started = Instant::now();
        assert_eq!(send_raw(h.addr, big.as_bytes()).await.status, 401);
        let huge = format!("POST /api/invoke HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Length: 99999999999999999999999\r\n\r\n");
        assert_eq!(send_raw(h.addr, huge.as_bytes()).await.status, 401);
        assert!(started.elapsed() < Duration::from_secs(3), "the body was awaited");
        // With the token, an oversized body is refused before reading it.
        let authed_big = format!("POST /api/invoke HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {}\r\nContent-Length: {}\r\n\r\n", h.token, MAX_BODY + 1);
        assert_eq!(send_raw(h.addr, authed_big.as_bytes()).await.status, 413);
        // Bodies anywhere else are refused unread.
        let get_body = format!("GET / HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Length: 5\r\n\r\nhello");
        assert_eq!(send_raw(h.addr, get_body.as_bytes()).await.status, 400);
        let auth_body = format!("POST /api/auth HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {}\r\nContent-Length: 2\r\n\r\n{{}}", h.token);
        assert_eq!(send_raw(h.addr, auth_body.as_bytes()).await.status, 400);
        // Folded header lines and signed or spaced lengths are malformed.
        let folded = format!("GET / HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nX-A: 1\r\n  continued\r\n\r\n");
        assert_eq!(send_raw(h.addr, folded.as_bytes()).await.status, 400);
        let tabbed = format!("GET / HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\tX-A: 1\r\n\r\n");
        assert_eq!(send_raw(h.addr, tabbed.as_bytes()).await.status, 400);
        for length in ["+5", "-1", "5 5", "0x5", ""] {
            let signed = format!("POST /api/invoke HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Length: {length}\r\n\r\n");
            assert_eq!(send_raw(h.addr, signed.as_bytes()).await.status, 400, "{length:?}");
        }
        let huge_head = format!("GET / HTTP/1.1\r\nX-Pad: {}\r\n\r\n", "a".repeat(MAX_HEAD + 10));
        assert_eq!(send_raw(h.addr, huge_head.as_bytes()).await.status, 431);
        assert_eq!(send_raw(h.addr, b"NONSENSE\r\n\r\n").await.status, 400);
        let doubled = format!("GET / HTTP/1.1\r\nHost: 127.0.0.1:{0}\r\nHost: evil.com\r\n\r\n", h.addr.port());
        assert_eq!(send_raw(h.addr, doubled.as_bytes()).await.status, 400);
        let chunked = format!("POST /api/auth HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nTransfer-Encoding: chunked\r\n\r\n", h.addr.port());
        assert_eq!(send_raw(h.addr, chunked.as_bytes()).await.status, 501);
        h.server.stop().await;
    }

    #[tokio::test]
    async fn keep_alive_serves_several_requests() {
        let h = harness().await;
        let mut stream = TcpStream::connect(h.addr).await.unwrap();
        let one = format!("GET /icon.svg HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n\r\n", h.addr.port());
        let two = format!("GET /icon.svg HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n", h.addr.port());
        stream.write_all(format!("{one}{two}").as_bytes()).await.unwrap();
        let mut out = Vec::new();
        tokio::time::timeout(Duration::from_secs(5), stream.read_to_end(&mut out)).await.unwrap().unwrap();
        let text = String::from_utf8_lossy(&out);
        assert_eq!(text.matches("HTTP/1.1 200 OK").count(), 2, "{text}");
        h.server.stop().await;
    }

    // ---- WebSocket ----

    type Client = WebSocketStream<TcpStream>;

    async fn ws_connect(addr: SocketAddr, origin: Option<&str>) -> Result<Client, String> {
        let mut request = format!("ws://127.0.0.1:{}/api/events", addr.port()).into_client_request().unwrap();
        if let Some(origin) = origin {
            request.headers_mut().insert("Origin", origin.parse().unwrap());
        }
        let stream = TcpStream::connect(addr).await.unwrap();
        tokio_tungstenite::client_async(request, stream).await.map(|(ws, _)| ws).map_err(|error| error.to_string())
    }

    async fn next_text(ws: &mut Client) -> Value {
        loop {
            match tokio::time::timeout(Duration::from_secs(5), ws.next()).await.unwrap().unwrap().unwrap() {
                Message::Text(text) => return serde_json::from_str(text.as_str()).unwrap(),
                Message::Ping(_) | Message::Pong(_) => continue,
                other => panic!("expected text, got {other:?}"),
            }
        }
    }

    async fn close_code(ws: &mut Client) -> (u16, String) {
        loop {
            match tokio::time::timeout(Duration::from_secs(5), ws.next()).await.unwrap() {
                Some(Ok(Message::Close(Some(frame)))) => return (u16::from(frame.code), frame.reason.as_str().to_owned()),
                Some(Ok(Message::Close(None))) | None | Some(Err(_)) => panic!("closed without a code"),
                Some(Ok(_)) => continue,
            }
        }
    }

    async fn authed(addr: SocketAddr, token: &str) -> Client {
        let mut ws = ws_connect(addr, Some(&format!("http://127.0.0.1:{}", addr.port()))).await.unwrap();
        ws.send(Message::text(serde_json::json!({ "type": "auth", "token": token }).to_string())).await.unwrap();
        assert_eq!(next_text(&mut ws).await, serde_json::json!({ "type": "ready" }));
        ws
    }

    async fn wait_clients(server: &WebServer, want: usize) {
        for _ in 0..200 {
            if server.status().clients == want {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("clients stayed at {}, wanted {want}", server.status().clients);
    }

    #[tokio::test]
    async fn websocket_auth_events_rotation_and_stop() {
        let h = harness().await;
        // A cross-site page can't even open the socket.
        assert!(ws_connect(h.addr, Some("http://evil.com")).await.unwrap_err().contains("403"));

        let mut wrong = ws_connect(h.addr, None).await.unwrap();
        wrong.send(Message::text(r#"{"type":"auth","token":"nope"}"#)).await.unwrap();
        assert_eq!(close_code(&mut wrong).await, (4001, "Unauthorized".into()));

        let mut ws = authed(h.addr, &h.token).await;
        wait_clients(&h.server, 1).await;
        assert!(h.fake.changes.load(Ordering::SeqCst) >= 1);
        ws.send(Message::text(r#"{"type":"ping"}"#)).await.unwrap();
        assert_eq!(next_text(&mut ws).await, serde_json::json!({ "type": "pong" }));
        ws.send(Message::text(r#"{"type":"subscribe","event":"session-update"}"#)).await.unwrap();
        assert_eq!(next_text(&mut ws).await["type"], "subscribed");
        ws.send(Message::text(r#"{"type":"subscribe","event":"bad name"}"#)).await.unwrap();
        assert_eq!(next_text(&mut ws).await["type"], "error");
        h.fake.emit("other-event", "1");
        h.fake.emit("session-update", r#"{"id":"s1","n":2}"#);
        assert_eq!(next_text(&mut ws).await, serde_json::json!({ "type": "event", "name": "session-update", "payload": { "id": "s1", "n": 2 } }));

        // A second client on the same event shares the one app listener.
        let mut other = authed(h.addr, &h.token).await;
        other.send(Message::text(r#"{"type":"subscribe","event":"session-update"}"#)).await.unwrap();
        assert_eq!(next_text(&mut other).await["type"], "subscribed");
        assert_eq!(h.fake.listeners("session-update"), 1);
        wait_clients(&h.server, 2).await;

        // Unsubscribed: no more events (the next frame is the pong, not the event). The
        // first ping makes sure the server took the unsubscribe before the emit.
        ws.send(Message::text(r#"{"type":"unsubscribe","event":"session-update"}"#)).await.unwrap();
        ws.send(Message::text(r#"{"type":"ping"}"#)).await.unwrap();
        assert_eq!(next_text(&mut ws).await["type"], "pong");
        h.fake.emit("session-update", "3");
        assert_eq!(next_text(&mut other).await["payload"], 3);
        ws.send(Message::text(r#"{"type":"ping"}"#)).await.unwrap();
        assert_eq!(next_text(&mut ws).await["type"], "pong");

        // Rotation kicks every client and retires the old token.
        let rotated = h.server.rotate().unwrap();
        assert_eq!(close_code(&mut ws).await, (4001, "Token rotated".into()));
        assert_eq!(close_code(&mut other).await, (4001, "Token rotated".into()));
        wait_clients(&h.server, 0).await;
        let fresh = token_of(&rotated);
        assert_ne!(fresh, h.token);
        assert_eq!(request(h.addr, "POST", "/api/auth", &[host(h.addr), bearer(&h.token)], "").await.status, 401);
        assert_eq!(request(h.addr, "POST", "/api/auth", &[host(h.addr), bearer(&fresh)], "").await.status, 200);

        // Stopping says goodbye with 1001 and frees the port for an immediate rebind.
        let mut last = authed(h.addr, &fresh).await;
        h.server.stop().await;
        assert_eq!(close_code(&mut last).await, (1001, "Server stopped".into()));
        assert!(!h.server.status().running);
        assert!(h.server.rotate().is_err());
        let again = h.server.start(h.fake.clone(), LOCAL, h.addr.port(), false).await.unwrap();
        assert_eq!(again.port, h.addr.port());
        h.server.stop().await;
    }

    #[tokio::test]
    async fn a_busy_port_leaves_the_running_server_alive() {
        let h = harness().await;
        let blocker = std::net::TcpListener::bind((LOCAL, 0)).unwrap();
        let busy = blocker.local_addr().unwrap().port();
        let error = h.server.start(h.fake.clone(), LOCAL, busy, true).await.unwrap_err();
        assert_eq!(error, format!("Port {busy} is already in use."));
        let status = h.server.status();
        assert!(status.running);
        assert_eq!(status.port, h.addr.port());
        assert_eq!(token_of(&status), h.token);
        assert_eq!(status.error.as_deref(), Some(error.as_str()));
        assert!(!status.enabled, "the failed switch saved nothing");
        assert_eq!(request(h.addr, "POST", "/api/auth", &[host(h.addr), bearer(&h.token)], "").await.status, 200);
        // A later good switch clears the error.
        drop(blocker);
        let moved = h.server.start(h.fake.clone(), LOCAL, 0, false).await.unwrap();
        assert!(moved.running && moved.error.is_none());
        h.server.stop().await;
        assert_eq!(h.server.status().port, 0);
    }

    #[tokio::test]
    async fn slow_heads_time_out_and_one_address_cannot_take_every_slot() {
        let h = harness().await;
        // A head that trickles in never finishes within the overall deadline.
        let mut slow = TcpStream::connect(h.addr).await.unwrap();
        slow.write_all(b"GET / HTTP/1.1\r\n").await.unwrap();
        let started = Instant::now();
        let mut out = Vec::new();
        let closed = tokio::time::timeout(HEAD_TIMEOUT + Duration::from_secs(5), async {
            loop {
                tokio::time::sleep(Duration::from_secs(1)).await;
                if slow.write_all(b"X-Drip: 1\r\n").await.is_err() {
                    break;
                }
                match tokio::time::timeout(Duration::from_millis(10), slow.read_to_end(&mut out)).await {
                    Ok(_) => break,
                    Err(_) => continue,
                }
            }
        })
        .await;
        assert!(closed.is_ok(), "the server kept a trickling head open");
        assert!(started.elapsed() >= HEAD_TIMEOUT - Duration::from_secs(1));
        // Per-address cap: the slots come back when connections close.
        let counts: PerIp = Arc::new(Mutex::new(HashMap::new()));
        let slots: Vec<IpSlot> = (0..MAX_LOOPBACK_CONNECTIONS).map(|_| IpSlot::take(&counts, LOCAL).unwrap()).collect();
        assert!(IpSlot::take(&counts, LOCAL).is_none());
        assert!(IpSlot::take(&counts, "::ffff:127.0.0.1".parse().unwrap()).is_none(), "mapped addresses share the cap");
        assert!(IpSlot::take(&counts, "10.0.0.1".parse().unwrap()).is_some());
        drop(slots);
        assert!(lock(&counts).get(&LOCAL).is_none());
        assert!(IpSlot::take(&counts, LOCAL).is_some());
        h.server.stop().await;
    }

    #[tokio::test]
    async fn a_lagging_client_is_told_to_resync() {
        let h = harness().await;
        let mut ws = authed(h.addr, &h.token).await;
        ws.send(Message::text(r#"{"type":"subscribe","event":"flood"}"#)).await.unwrap();
        assert_eq!(next_text(&mut ws).await["type"], "subscribed");
        // Synchronously, so the client task can't keep up: the buffer overflows.
        for n in 0..EVENT_BUFFER * 3 {
            h.fake.emit("flood", &n.to_string());
        }
        let mut lagged = false;
        for _ in 0..EVENT_BUFFER * 2 {
            if next_text(&mut ws).await["type"] == "lagged" {
                lagged = true;
                break;
            }
        }
        assert!(lagged, "no lagged frame after an overflow");
        h.server.stop().await;
    }

    #[tokio::test]
    async fn stopping_resets_the_address_to_loopback() {
        let fake = Arc::new(Fake::default());
        let server = WebServer::new(temp_dir());
        // A CLI `--host` other than 127.0.0.1 (IPv6 loopback, so no firewall prompt in tests).
        let v6: IpAddr = "::1".parse().unwrap();
        assert_eq!(server.start(fake.clone(), v6, 0, false).await.unwrap().host, "::1");
        assert_eq!(lock(&server.state).host, v6);
        // A non-loopback address left behind is reset the same way.
        server.stop_and_save(None, false).await.unwrap();
        assert_eq!(lock(&server.state).host, LOCAL);
        lock(&server.state).host = "0.0.0.0".parse().unwrap();
        let off = server.stop_and_save(None, true).await.unwrap();
        assert_eq!(off.host, "127.0.0.1");
        assert_eq!(lock(&server.state).host, LOCAL);
        // A CLI `--host` was session-only: stopping persists the saved loopback default.
        assert_eq!(load_config(&server.dir).host, None);
    }

    #[test]
    fn page_authority_comes_from_a_plain_host() {
        let bound: SocketAddr = "127.0.0.1:9".parse().unwrap();
        assert_eq!(page_authority(Some("LocalHost:9"), bound), "localhost:9");
        assert_eq!(page_authority(Some("[::1]:9"), bound), "[::1]:9");
        assert_eq!(page_authority(Some("a; script-src *"), bound), "127.0.0.1:9");
        assert_eq!(page_authority(None, bound), "127.0.0.1:9");
    }

    /// A backend whose commands reconfigure the very server they arrived on, as
    /// `web_server_configure` does when a browser tab switches the port or turns it off.
    /// Runs the real server commands. A call with `"hold": true` waits, after it got in,
    /// until the test opens the gate (so a test can stop, restart or switch meanwhile).
    #[derive(Default)]
    struct SelfConfig {
        server: std::sync::OnceLock<std::sync::Weak<WebServer>>,
        me: std::sync::OnceLock<std::sync::Weak<SelfConfig>>,
        entered: Arc<tokio::sync::Notify>,
        gate: Arc<tokio::sync::Notify>,
    }

    impl SelfConfig {
        fn hold(&self, args: &Value) -> Option<(Arc<tokio::sync::Notify>, Arc<tokio::sync::Notify>)> {
            (args["hold"] == true).then(|| (self.entered.clone(), self.gate.clone()))
        }
    }

    async fn held(hold: Option<(Arc<tokio::sync::Notify>, Arc<tokio::sync::Notify>)>) {
        if let Some((entered, gate)) = hold {
            entered.notify_one();
            gate.notified().await;
        }
    }

    impl Backend for SelfConfig {
        /// Answers synthetic commands (`echo`, `hang`, ...) that no real backend registers.
        fn enforces_allowlist(&self) -> bool {
            false
        }
        fn rotate_if_token(&self, _expected: String) -> BoxFuture<Reply> {
            Box::pin(async { Reply::Unknown })
        }
        fn configure_if_token(&self, expected: String, args: Value) -> BoxFuture<Reply> {
            let server = self.server.get().and_then(std::sync::Weak::upgrade);
            let me = self.me.get().and_then(std::sync::Weak::upgrade);
            let hold = self.hold(&args);
            Box::pin(async move {
                let (Some(server), Some(me)) = (server, me) else { return Reply::NotReady };
                held(hold).await;
                configure_reply(&server, me, &expected, args).await
            })
        }
        fn invoke(&self, command: String, args: Value) -> BoxFuture<Reply> {
            let server = self.server.get().and_then(std::sync::Weak::upgrade);
            let me = self.me.get().and_then(std::sync::Weak::upgrade);
            let hold = self.hold(&args);
            Box::pin(async move {
                let (Some(server), Some(me)) = (server, me) else { return Reply::NotReady };
                held(hold).await;
                let result = match command.as_str() {
                    "web_server_status" => Ok(server.status()),
                    "switch" => {
                        let port = args["port"].as_u64().unwrap_or(0) as u16;
                        server.start(me, LOCAL, port, false).await
                    }
                    "stop" => server.stop_and_save(None, false).await,
                    // A command during which the owner rotates the token (on the desktop).
                    "rotates" => server.rotate(),
                    _ => return Reply::Unknown,
                };
                match result {
                    Ok(status) => Reply::Json(serde_json::to_string(&status).unwrap()),
                    Err(error) => Reply::Error(Value::String(error)),
                }
            })
        }
        fn asset(&self, _path: String, _dev_proxy: bool) -> BoxFuture<Option<StaticAsset>> {
            Box::pin(async { None })
        }
        fn listen(&self, _name: &str, _sink: broadcast::Sender<HubEvent>) -> ListenerId {
            0
        }
        fn unlisten(&self, _id: ListenerId) {}
        fn changed(&self) {}
    }

    fn free_port() -> u16 {
        std::net::TcpListener::bind((LOCAL, 0)).unwrap().local_addr().unwrap().port()
    }

    #[tokio::test]
    async fn port_switch_and_stop_over_http_invoke_return_replies() {
        let server = Arc::new(WebServer::new(temp_dir()));
        let backend = Arc::new(SelfConfig::default());
        backend.server.set(Arc::downgrade(&server)).unwrap();
        backend.me.set(Arc::downgrade(&backend)).unwrap();
        let first = server.start(backend.clone(), LOCAL, 0, false).await.unwrap();
        let old = SocketAddr::new(LOCAL, first.port);
        let token = token_of(&first);

        // Switch the port from a request on the old port: a full reply, quickly.
        let target = free_port();
        let started = Instant::now();
        let body = format!(r#"{{"command":"web_server_configure","args":{{"enabled":true,"port":{target},"persist":false}}}}"#);
        let reply = request(old, "POST", "/api/invoke", &[host(old), bearer(&token)], &body).await;
        assert!(started.elapsed() < Duration::from_secs(1), "the switch reply stalled: {:?}", started.elapsed());
        assert_eq!(reply.status, 200, "{}", reply.text());
        assert_eq!(reply.header("connection").as_deref(), Some("close"));
        let status: Value = serde_json::from_slice(&reply.body).unwrap();
        assert_eq!(status["port"], target);
        assert_eq!(status["running"], true);
        // The new port answers at once (with the new token); the old one is gone.
        let new = SocketAddr::new(LOCAL, target);
        let fresh = status["tokenUrl"].as_str().unwrap().split_once("#token=").unwrap().1.to_owned();
        assert_eq!(request(new, "POST", "/api/auth", &[host(new), bearer(&fresh)], "").await.status, 200);
        assert!(TcpStream::connect(old).await.is_err(), "the old port still accepts");

        // Stop from a request on the new port: a full reply, quickly, port released.
        let started = Instant::now();
        let reply = request(new, "POST", "/api/invoke", &[host(new), bearer(&fresh)], r#"{"command":"web_server_configure","args":{"enabled":false,"persist":false}}"#).await;
        assert!(started.elapsed() < Duration::from_secs(1), "the stop reply stalled: {:?}", started.elapsed());
        assert_eq!(reply.status, 200, "{}", reply.text());
        let status: Value = serde_json::from_slice(&reply.body).unwrap();
        assert_eq!((status["running"].clone(), status["port"].clone()), (Value::Bool(false), Value::from(0)));
        assert!(!server.status().running);
        let again = server.start(backend.clone(), LOCAL, target, false).await.unwrap();
        assert_eq!(again.port, target, "the exact port rebinds at once");

        // The token rotates while a command runs: its reply is withheld, flagged as having run.
        let token = token_of(&again);
        let reply = request(new, "POST", "/api/invoke", &[host(new), bearer(&token)], r#"{"command":"rotates"}"#).await;
        assert_eq!(reply.status, 401);
        let body: Value = serde_json::from_slice(&reply.body).unwrap();
        assert_eq!(body["ran"], true);
        assert!(!reply.text().contains("token="), "{}", reply.text());
        server.stop().await;
    }

    #[test]
    fn strict_header_parsing() {
        let parse = |head: &str| parse_head(head).map(|_| ()).map_err(|response| response.status);
        assert_eq!(parse("GET / HTTP/1.1\r\nHost: x\r\nX-Y: a b"), Ok(()));
        // Bare LF or CR inside a line.
        assert_eq!(parse("GET / HTTP/1.1\r\nHost: x\nX-Evil: 1"), Err(400));
        assert_eq!(parse("GET / HTTP/1.1\nHost: x"), Err(400));
        assert_eq!(parse("GET / HTTP/1.1\r\nHost: x\rX: 1"), Err(400));
        // Header names are untrimmed RFC 9110 tokens.
        for head in ["GET / HTTP/1.1\r\nHost : x", "GET / HTTP/1.1\r\nHo\tst: x", "GET / HTTP/1.1\r\nHo(st: x", "GET / HTTP/1.1\r\n: x", "GET / HTTP/1.1\r\nHo\u{1}st: x"] {
            assert_eq!(parse(head), Err(400), "{head:?}");
        }
        assert_eq!(parse("GET / HTTP/1.1\r\nX-Odd_Name.1~: \tv\t"), Ok(()));
        assert_eq!(parse_head("GET / HTTP/1.1\r\nX-A: \t v \t").ok().unwrap().header("x-a"), Some("v"));
    }

    #[tokio::test]
    async fn spaced_header_names_are_refused_over_the_wire() {
        let h = harness().await;
        let raw = format!("GET / HTTP/1.1\r\nHost : 127.0.0.1:{}\r\n\r\n", h.addr.port());
        assert_eq!(send_raw(h.addr, raw.as_bytes()).await.status, 400);
        let raw = format!("GET / HTTP/1.1\r\nHost: 127.0.0.1:{}\nX: 1\r\n\r\n", h.addr.port());
        assert_eq!(send_raw(h.addr, raw.as_bytes()).await.status, 400);
        h.server.stop().await;
    }

    #[test]
    fn dev_proxy_stays_on_loopback_bundle_paths() {
        let local: SocketAddr = "127.0.0.1:1".parse().unwrap();
        let mapped: SocketAddr = "[::ffff:127.0.0.1]:1".parse().unwrap();
        let lan: SocketAddr = "0.0.0.0:1".parse().unwrap();
        assert!(dev_proxyable("src/main.ts", local));
        assert!(dev_proxyable("index.html", mapped));
        assert!(!dev_proxyable("src/main.ts", lan));
        for path in ["@fs/etc/passwd", "@id/x", "node_modules/@fs/etc/passwd", "a/@id/b"] {
            assert!(!dev_proxyable(path, local), "{path}");
        }
    }

    #[test]
    fn remote_guidance_is_accurate() {
        let warning = non_loopback_warning(8080);
        assert!(warning.contains("ssh -L 8080:127.0.0.1:8080 <host>"), "{warning}");
        assert!(warning.contains("WireGuard/Tailscale"));
        assert!(!warning.contains("TLS proxy"));
        assert_eq!(MAX_CONNECTIONS_PER_IP, 32);
        assert_eq!(MAX_LOOPBACK_CONNECTIONS, 128);
        const { assert!(MAX_LOOPBACK_CONNECTIONS < MAX_CONNECTIONS); }
    }

    #[tokio::test]
    async fn rotation_answers_before_closing_sockets() {
        let h = harness().await;
        let mut ws = authed(h.addr, &h.token).await;
        let rotated = h.server.rotate().unwrap();
        // The old token is refused at once, while the socket closes only after the delay.
        assert_eq!(request(h.addr, "POST", "/api/auth", &[host(h.addr), bearer(&h.token)], "").await.status, 401);
        let started = Instant::now();
        assert_eq!(close_code(&mut ws).await, (4001, "Token rotated".into()));
        assert!(started.elapsed() < Duration::from_secs(2));
        assert_eq!(request(h.addr, "POST", "/api/auth", &[host(h.addr), bearer(&token_of(&rotated))], "").await.status, 200);
        h.server.stop().await;
    }

    #[tokio::test]
    async fn port_switches_persistence_and_bind_errors() {
        let fake = Arc::new(Fake::default());
        let dir = temp_dir();
        let server = WebServer::new(dir.clone());
        let first = server.start(fake.clone(), LOCAL, 0, true).await.unwrap();
        assert!(first.running && first.enabled);
        assert_eq!(load_config(&dir), Config { enabled: true, port: 0, ..Config::default() });
        // Same address again keeps the server and its token.
        let same_again = server.start(fake.clone(), LOCAL, first.port, false).await.unwrap();
        assert_eq!(same_again.token_url, first.token_url);
        // Switch to another port: the old one is released.
        let blocker = std::net::TcpListener::bind((LOCAL, 0)).unwrap();
        let busy = blocker.local_addr().unwrap().port();
        drop(blocker);
        let moved = server.start(fake.clone(), LOCAL, busy, false).await.unwrap();
        assert_eq!(moved.port, busy);
        assert!(std::net::TcpListener::bind((LOCAL, first.port)).is_ok(), "old port released");
        // A taken port fails cleanly: nothing half-started, saved state untouched.
        server.stop().await;
        let blocker = std::net::TcpListener::bind((LOCAL, 0)).unwrap();
        let taken = blocker.local_addr().unwrap().port();
        let error = server.start(fake.clone(), LOCAL, taken, true).await.unwrap_err();
        assert_eq!(error, format!("Port {taken} is already in use."));
        let status = server.status();
        assert!(!status.running);
        assert_eq!(status.error.as_deref(), Some(error.as_str()));
        assert_eq!(load_config(&dir), Config { enabled: true, port: 0, ..Config::default() });
        drop(blocker);
        // Turning it off saves `enabled: false` and clears the error.
        let off = server.stop_and_save(Some(9999), true).await.unwrap();
        assert!(!off.running && !off.enabled && off.error.is_none());
        assert_eq!(off.configured_port, 9999);
        assert_eq!(load_config(&dir), Config { enabled: false, port: 9999, ..Config::default() });
        // A session-only start leaves the saved "off" alone.
        server.start(fake.clone(), LOCAL, 0, false).await.unwrap();
        assert_eq!(load_config(&dir), Config { enabled: false, port: 9999, ..Config::default() });
        server.shutdown();
        assert!(!server.status().running);
    }

    #[test]
    fn ipv6_peers_are_counted_per_64() {
        let a: IpAddr = "2001:db8:1:2:aaaa::1".parse().unwrap();
        let b: IpAddr = "2001:db8:1:2:ffff:1:2:3".parse().unwrap();
        let other: IpAddr = "2001:db8:1:3::1".parse().unwrap();
        assert_eq!(rate_key(a), rate_key(b));
        assert_eq!(rate_key(a), "2001:db8:1:2::".parse::<IpAddr>().unwrap());
        assert_ne!(rate_key(a), rate_key(other));
        // Loopback and IPv4 (also IPv4-mapped) stay whole addresses.
        assert_eq!(rate_key("::1".parse().unwrap()), "::1".parse::<IpAddr>().unwrap());
        assert_eq!(rate_key("::ffff:10.0.0.7".parse().unwrap()), "10.0.0.7".parse::<IpAddr>().unwrap());
        assert_ne!(rate_key("10.0.0.7".parse().unwrap()), rate_key("10.0.0.8".parse().unwrap()));
        // One /64 shares a failure budget and a connection cap.
        let limiter = Limiter::default();
        let now = Instant::now();
        for _ in 0..MAX_FAILURES {
            limiter.fail(a, now);
        }
        assert!(limiter.blocked(b, now));
        assert!(!limiter.blocked(other, now));
        let counts: PerIp = Arc::new(Mutex::new(HashMap::new()));
        let slots: Vec<_> = (0..MAX_CONNECTIONS_PER_IP).map(|_| IpSlot::take(&counts, a).unwrap()).collect();
        assert!(IpSlot::take(&counts, b).is_none());
        assert!(IpSlot::take(&counts, other).is_some());
        drop(slots);
        assert!(IpSlot::take(&counts, b).is_some());
    }

    #[tokio::test]
    async fn event_names_are_freed_when_no_client_wants_them() {
        let h = harness().await;
        let hub = h.server.hub.clone();
        let fake: &dyn Backend = h.fake.as_ref();
        // Fill every slot, then free them all: the cap is never used up for good.
        for round in 0..2 {
            for index in 0..MAX_EVENT_NAMES {
                hub.subscribe(fake, &format!("event-{round}-{index}")).unwrap();
            }
            assert_eq!(hub.subscribe(fake, "one-too-many"), Err("Too many distinct events."));
            for index in 0..MAX_EVENT_NAMES {
                hub.unsubscribe(fake, &format!("event-{round}-{index}"));
            }
            assert_eq!(hub.active(), 0);
            assert_eq!(lock(&h.fake.sinks).len(), 0, "app listeners removed");
        }
        // Shared names stay until the last subscriber leaves.
        hub.subscribe(fake, "shared").unwrap();
        hub.subscribe(fake, "shared").unwrap();
        hub.unsubscribe(fake, "shared");
        assert_eq!(h.fake.listeners("shared"), 1);
        hub.unsubscribe(fake, "shared");
        assert_eq!(h.fake.listeners("shared"), 0);
        hub.unsubscribe(fake, "never-subscribed");

        // A client's subscriptions go back when it unsubscribes, disconnects or is kicked.
        let mut ws = authed(h.addr, &h.token).await;
        for name in ["a", "b", "c"] {
            ws.send(Message::text(serde_json::json!({ "type": "subscribe", "event": name }).to_string())).await.unwrap();
            assert_eq!(next_text(&mut ws).await["type"], "subscribed");
        }
        ws.send(Message::text(r#"{"type":"unsubscribe","event":"a"}"#)).await.unwrap();
        ws.send(Message::text(r#"{"type":"ping"}"#)).await.unwrap();
        assert_eq!(next_text(&mut ws).await["type"], "pong");
        assert_eq!(hub.active(), 2);
        drop(ws);
        wait_clients(&h.server, 0).await;
        assert_eq!(hub.active(), 0);
        let mut kicked = authed(h.addr, &h.token).await;
        kicked.send(Message::text(r#"{"type":"subscribe","event":"d"}"#)).await.unwrap();
        assert_eq!(next_text(&mut kicked).await["type"], "subscribed");
        h.server.rotate().unwrap();
        assert_eq!(close_code(&mut kicked).await.0, 4001);
        wait_clients(&h.server, 0).await;
        assert_eq!(hub.active(), 0);
        assert_eq!(lock(&h.fake.sinks).len(), 0);
        h.server.stop().await;
    }

    #[tokio::test]
    async fn rotation_never_leaks_new_token_to_old_websocket() {
        let h = harness().await;
        let mut ws = authed(h.addr, &h.token).await;
        ws.send(Message::text(serde_json::json!({ "type": "subscribe", "event": CHANGED_EVENT }).to_string())).await.unwrap();
        assert_eq!(next_text(&mut ws).await["type"], "subscribed");
        // The second-launch notice is for the desktop window only: no tab may subscribe.
        ws.send(Message::text(r#"{"type":"subscribe","event":"web-server-cli-started"}"#)).await.unwrap();
        assert_eq!(next_text(&mut ws).await["type"], "error");
        let rotated = h.server.rotate().unwrap();
        let fresh = token_of(&rotated);
        // What the app broadcasts on a change (emit_changed and the CLI-started event).
        let redacted = h.server.status_redacted();
        assert!(redacted.token_url.is_none() && redacted.url.is_some());
        let payload = serde_json::to_string(&redacted).unwrap();
        h.fake.emit(CHANGED_EVENT, &payload);
        h.fake.emit("web-server-cli-started", &payload);
        let mut frames = Vec::new();
        let code = loop {
            match tokio::time::timeout(Duration::from_secs(5), ws.next()).await.unwrap() {
                Some(Ok(Message::Close(Some(frame)))) => break u16::from(frame.code),
                Some(Ok(Message::Text(text))) => frames.push(text.to_string()),
                Some(Ok(_)) => continue,
                other => panic!("closed without a code: {other:?}"),
            }
        };
        assert_eq!(code, 4001);
        // A retired socket gets no events at all, even before its close.
        assert!(frames.is_empty(), "events reached a revoked socket: {frames:?}");
        // A client on the new token gets the broadcast, and it carries no token either.
        let mut current = authed(h.addr, &fresh).await;
        for name in [CHANGED_EVENT] {
            current.send(Message::text(serde_json::json!({ "type": "subscribe", "event": name }).to_string())).await.unwrap();
            assert_eq!(next_text(&mut current).await["type"], "subscribed");
            h.fake.emit(name, &payload);
            let frame = next_text(&mut current).await;
            assert_eq!(frame["name"], name);
            let text = frame.to_string();
            assert!(!text.contains(&fresh) && !text.contains("#token="), "{text}");
            assert!(frame["payload"]["tokenUrl"].is_null());
        }
        let old = request(h.addr, "POST", "/api/invoke", &[host(h.addr), bearer(&h.token)], r#"{"command":"web_server_status"}"#).await;
        assert_eq!(old.status, 401);
        h.server.stop().await;
    }

    #[tokio::test]
    async fn a_failed_save_never_stops_a_server_that_was_already_running() {
        let dir = temp_dir();
        let fake = Arc::new(Fake::default());
        let server = WebServer::new(dir.clone());
        let running = server.start(fake.clone(), LOCAL, 0, false).await.unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
        // Same address, settings can't be saved: the running server stays up.
        let error = server.start(fake.clone(), LOCAL, running.port, true).await.unwrap_err();
        assert!(error.starts_with("Could not save"), "{error}");
        let status = server.status();
        assert!(status.running);
        assert_eq!(status.port, running.port);
        assert_eq!(token_of(&status), token_of(&running));
        let addr = SocketAddr::new(LOCAL, running.port);
        assert_eq!(request(addr, "POST", "/api/auth", &[host(addr), bearer(&token_of(&running))], "").await.status, 200);
        // A server this call started is undone when its settings can't be saved.
        server.stop().await;
        assert!(server.start(fake.clone(), LOCAL, 0, true).await.is_err());
        assert!(!server.status().running);
    }

    #[tokio::test]
    async fn desktop_only_commands_are_refused_even_with_the_token() {
        let h = harness().await;
        for command in ["browser_open", "browser_capture", "read_clipboard_image", "dragged_file_paths", "configure_window_appearance", "agents_dock_pin", "local_sign_app", "open_third_party_notices", "overlay_show", "tray_quit", "tray_snapshot", "voice_start", "voice_mic_devices", "reveal_path", "open_workspace_file", "open_external_url", "crash_report_reveal", "plugin:dialog|open", "plugin:event|listen"] {
            let body = serde_json::json!({ "command": command }).to_string();
            let reply = request(h.addr, "POST", "/api/invoke", &[host(h.addr), bearer(&h.token)], &body).await;
            assert_eq!(reply.status, 403, "{command}");
            assert_eq!(reply.text(), r#"{"error":"This command is only available in the desktop app."}"#, "{command}");
        }
        // Ordinary commands still go through; a near-miss name isn't blocked, and opening a
        // task in a tab may still clear its unseen badge in the menu bar.
        assert!(!web_blocked_command("browser_opener_settings") && !web_blocked_command("list_sessions"));
        let reply = request(h.addr, "POST", "/api/invoke", &[host(h.addr), bearer(&h.token)], r#"{"command":"tray_seen","args":{"id":"s1"}}"#).await;
        assert_eq!(reply.status, 200);
        assert_eq!(reply.text(), r#"{"id":"s1"}"#);
        let reply = request(h.addr, "POST", "/api/invoke", &[host(h.addr), bearer(&h.token)], r#"{"command":"echo","args":{"a":1}}"#).await;
        assert_eq!(reply.status, 200);
        // Without the token it is still a 401, not a hint about the command.
        let reply = request(h.addr, "POST", "/api/invoke", &[host(h.addr), bearer("nope")], r#"{"command":"browser_open"}"#).await;
        assert_eq!(reply.status, 401);
        h.server.stop().await;
    }

    #[tokio::test]
    async fn a_client_signed_in_with_the_new_token_survives_the_rotation_signal() {
        let h = harness().await;
        let rotated = h.server.rotate().unwrap();
        // Inside the delay before the rotation signal goes out.
        let mut ws = authed(h.addr, &token_of(&rotated)).await;
        tokio::time::sleep(ROTATE_DELAY * 4).await;
        ws.send(Message::text(r#"{"type":"ping"}"#)).await.unwrap();
        assert_eq!(next_text(&mut ws).await["type"], "pong");
        h.server.stop().await;
    }

    #[tokio::test]
    async fn a_failed_same_port_host_switch_says_the_old_listener_stopped() {
        let fake = Arc::new(Fake::default());
        let server = WebServer::new(temp_dir());
        let first = server.start(fake.clone(), LOCAL, 0, false).await.unwrap();
        // TEST-NET-1 is never a local address, so the bind fails after the old one stopped.
        let error = server.start(fake.clone(), "192.0.2.1".parse().unwrap(), first.port, false).await.unwrap_err();
        assert!(error.ends_with(" The previous listener was stopped."), "{error}");
        assert!(!server.status().running);
        // A failed switch to another port never stops it, so it never says so.
        let again = server.start(fake.clone(), LOCAL, 0, false).await.unwrap();
        let blocker = std::net::TcpListener::bind((LOCAL, 0)).unwrap();
        let taken = blocker.local_addr().unwrap().port();
        let error = server.start(fake.clone(), LOCAL, taken, false).await.unwrap_err();
        assert_eq!(error, format!("Port {taken} is already in use."));
        assert_eq!(server.status().port, again.port);
        server.stop().await;
    }

    #[tokio::test]
    async fn a_tab_may_change_the_port_but_never_the_listen_address_or_trusted_names() {
        let h = harness().await;
        let call = |args: Value| serde_json::json!({ "command": "web_server_configure", "args": args }).to_string();
        for args in [
            serde_json::json!({ "enabled": true, "host": "0.0.0.0" }),
            serde_json::json!({ "enabled": true, "port": 8080, "host": "127.0.0.1" }),
            serde_json::json!({ "enabled": true, "host": 0 }),
        ] {
            let reply = request(h.addr, "POST", "/api/invoke", &[host(h.addr), bearer(&h.token)], &call(args.clone())).await;
            assert_eq!(reply.status, 403, "{args}");
            assert_eq!(reply.text(), r#"{"error":"The listen address can only be changed on the host machine."}"#);
        }
        // A trusted name is the same class of exposure change: a tab can't touch the list.
        for args in [
            serde_json::json!({ "enabled": true, "port": 8080, "allowedHosts": ["my-mac.tail1234.ts.net"] }),
            serde_json::json!({ "enabled": false, "allowedHosts": [] }),
        ] {
            let reply = request(h.addr, "POST", "/api/invoke", &[host(h.addr), bearer(&h.token)], &call(args.clone())).await;
            assert_eq!(reply.status, 403, "{args}");
            assert_eq!(reply.text(), r#"{"error":"The trusted host names can only be changed on the host machine."}"#);
        }
        // No address or trusted list, a null one or an empty address: the port-only change goes through.
        for args in [
            serde_json::json!({ "enabled": true, "port": 8080 }),
            serde_json::json!({ "enabled": true, "port": 8080, "host": null, "allowedHosts": null }),
            serde_json::json!({ "enabled": false, "host": "  " }),
        ] {
            let reply = request(h.addr, "POST", "/api/invoke", &[host(h.addr), bearer(&h.token)], &call(args.clone())).await;
            assert_eq!(reply.status, 200, "{args}");
        }
        h.server.stop().await;
    }

    #[tokio::test]
    async fn token_generation_counts_rotations_and_survives_redaction() {
        let server = WebServer::new(temp_dir());
        assert_eq!(server.status().token_generation, 0);
        let started = server.start(Arc::new(Fake::default()), LOCAL, 0, false).await.unwrap();
        assert_eq!(started.token_generation, 1);
        // Bumped at once, before old sockets are told to close.
        let rotated = server.rotate().unwrap();
        assert_eq!(rotated.token_generation, 2);
        assert_eq!(server.status_redacted().token_generation, 2);
        assert!(server.status_redacted().token_url.is_none());
        let json = serde_json::to_value(server.status_redacted()).unwrap();
        assert_eq!(json["tokenGeneration"], 2);
        assert_eq!(server.rotate().unwrap().token_generation, 3);
        server.stop().await;
        assert_eq!(server.status().token_generation, 0);
        // It never goes back: a restart (even on the same port) counts on from the last one.
        let restarted = server.start(Arc::new(Fake::default()), LOCAL, 0, false).await.unwrap();
        assert_eq!(restarted.token_generation, 4);
        let port = restarted.port;
        server.stop().await;
        let again = server.start(Arc::new(Fake::default()), LOCAL, port, false).await.unwrap();
        assert_eq!(again.token_generation, 5);
        assert_eq!(server.rotate().unwrap().token_generation, 6);
        server.stop().await;
    }

    #[tokio::test]
    async fn client_frames_are_capped_small() {
        assert_eq!(MAX_WS_MESSAGE, 16 * 1024);
        let h = harness().await;
        let mut ws = ws_connect(h.addr, None).await.unwrap();
        let huge = serde_json::json!({ "type": "auth", "token": "x".repeat(MAX_WS_MESSAGE) }).to_string();
        let _ = ws.send(Message::text(huge)).await;
        // The server drops the socket instead of buffering the frame.
        let ended = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                match ws.next().await {
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    Some(Ok(_)) => continue,
                }
            }
        })
        .await;
        assert!(ended.is_ok());
        // A refused cross-site handshake is still answered.
        let raw = format!(
            "GET /api/events HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nOrigin: http://evil.com\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
            h.addr.port()
        );
        let reply = send_raw(h.addr, raw.as_bytes()).await;
        assert_eq!(reply.status, 403);
        h.server.stop().await;
    }

    #[tokio::test]
    async fn switching_to_port_zero_rebinds_to_a_fresh_port() {
        let dir = temp_dir();
        let fake = Arc::new(Fake::default());
        let server = WebServer::new(dir.clone());
        let free = std::net::TcpListener::bind((LOCAL, 0)).unwrap().local_addr().unwrap().port();
        let fixed = server.start(fake.clone(), LOCAL, free, true).await.unwrap();
        assert_eq!((fixed.port, fixed.configured_port), (free, free));
        let auto = server.start(fake.clone(), LOCAL, 0, true).await.unwrap();
        assert!(auto.running);
        assert_ne!(auto.port, 0);
        assert_ne!(auto.port, free, "a fresh port, not the old one");
        assert_eq!(auto.configured_port, 0);
        assert_eq!(load_config(&dir), Config { enabled: true, port: 0, ..Config::default() });
        assert_ne!(token_of(&auto), token_of(&fixed));
        assert!(std::net::TcpListener::bind((LOCAL, free)).is_ok(), "old port released");
        let addr = SocketAddr::new(LOCAL, auto.port);
        assert_eq!(request(addr, "POST", "/api/auth", &[host(addr), bearer(&token_of(&auto))], "").await.status, 200);
        server.stop().await;
    }

    #[tokio::test]
    async fn a_failed_save_during_port_switch_keeps_the_old_server_alive() {
        // The settings "directory" is a file, so every save fails.
        let dir = temp_dir().join("not-a-directory");
        std::fs::write(&dir, b"x").unwrap();
        let fake = Arc::new(Fake::default());
        let server = WebServer::new(dir.clone());
        let old = server.start(fake.clone(), LOCAL, 0, false).await.unwrap();
        let next = std::net::TcpListener::bind((LOCAL, 0)).unwrap().local_addr().unwrap().port();
        let error = server.start(fake.clone(), LOCAL, next, true).await.unwrap_err();
        assert!(error.starts_with("Could not save"), "{error}");
        let status = server.status();
        assert!(status.running);
        assert_eq!(status.port, old.port);
        assert_eq!(token_of(&status), token_of(&old));
        assert_eq!(status.error.as_deref(), Some(error.as_str()));
        let addr = SocketAddr::new(LOCAL, old.port);
        assert_eq!(request(addr, "POST", "/api/auth", &[host(addr), bearer(&token_of(&old))], "").await.status, 200);
        // The new port was never kept.
        assert!(std::net::TcpListener::bind((LOCAL, next)).is_ok(), "new port not held");
        server.stop().await;
    }

    #[test]
    fn non_loopback_listeners_only_answer_to_their_address() {
        let tailscale: SocketAddr = "100.64.1.5:8787".parse().unwrap();
        for host in ["100.64.1.5:8787", "100.64.1.5", "127.0.0.1:8787", "localhost:8787", "[::1]:8787", "[::ffff:100.64.1.5]:8787"] {
            assert!(host_allowed(Some(host), tailscale, &[]), "{host}");
        }
        for host in ["evil.com:8787", "192.168.1.9:8787", "100.64.1.6:8787", "100.64.1.5:0", "my-box.ts.net:8787", "1684275461:8787"] {
            assert!(!host_allowed(Some(host), tailscale, &[]), "{host}");
        }
        let v6: SocketAddr = "[fd7a:115c:a1e0::5]:8787".parse().unwrap();
        assert!(host_allowed(Some("[fd7a:115c:a1e0::5]:8787"), v6, &[]));
        assert!(host_allowed(Some("[FD7A:115C:A1E0:0::5]:8787"), v6, &[]));
        assert!(!host_allowed(Some("[fd7a:115c:a1e0::6]:8787"), v6, &[]));

        for any in ["0.0.0.0:8787", "[::]:8787"] {
            let any: SocketAddr = any.parse().unwrap();
            for host in ["192.168.1.5:8787", "localhost:8787", "127.0.0.1:8787", "100.64.1.5", "[fd7a:115c:a1e0::5]:8787"] {
                assert!(host_allowed(Some(host), any, &[]), "{host}");
            }
            for host in ["evil.com:8787", "my-box.local:8787", "192.168.1.5.nip.io:8787", "192.168.1.5:0", ""] {
                assert!(!host_allowed(Some(host), any, &[]), "{host}");
            }
            assert!(!host_allowed(None, any, &[]));
        }
    }

    #[test]
    fn timed_out_commands_are_a_gateway_timeout() {
        assert_eq!(INVOKE_TIMEOUT, Duration::from_secs(300));
        assert_eq!(reason(504), "Gateway Timeout");
    }

    #[tokio::test]
    async fn a_hung_command_gets_504() {
        let h = harness().await;
        let reply = request(h.addr, "POST", "/api/invoke", &[host(h.addr), bearer(&h.token)], r#"{"command":"hang"}"#).await;
        assert_eq!(reply.status, 504);
        assert_eq!(reply.text(), r#"{"error":"Command timed out."}"#);
        h.server.stop().await;
    }

    fn main_window_commands() -> Vec<String> {
        let source = include_str!("lib.rs");
        let start = source.find("pub(crate) fn main_invoke_handler").expect("main_invoke_handler in lib.rs");
        let rest = &source[start..];
        let open = rest.find("generate_handler![").expect("generate_handler! list") + "generate_handler![".len();
        let close = open + rest[open..].find("];").expect("end of the list");
        rest[open..close]
            .lines()
            .map(|line| line.split("//").next().unwrap_or_default().trim())
            .filter(|line| !line.is_empty() && !line.starts_with('#'))
            .flat_map(|line| line.split(','))
            .map(str::trim)
            .filter(|path| !path.is_empty())
            .map(|path| path.rsplit("::").next().unwrap_or(path).to_owned())
            .collect()
    }

    /// The wire name each `#[tauri::command(rename = "...")]` exposes, keyed by the Rust
    /// function name after it. A browser tab invokes the wire name, so the allowlists must
    /// carry that, not the Rust name. This is a pure source scan: Tauri expands the macro at
    /// compile time and `main_invoke_handler` only names the Rust functions.
    fn command_renames() -> std::collections::BTreeMap<String, String> {
        use std::collections::BTreeMap;
        use std::path::{Path, PathBuf};

        fn rust_files(dir: &Path, found: &mut Vec<PathBuf>) {
            let Ok(entries) = std::fs::read_dir(dir) else { return };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    rust_files(&path, found);
                } else if path.extension().and_then(|extension| extension.to_str()) == Some("rs") {
                    found.push(path);
                }
            }
        }

        /// End (exclusive) of the `#[...]` attribute starting at `start`, skipping string
        /// literals so a `]` inside one does not end it early.
        fn attribute_end(source: &str, start: usize) -> Option<usize> {
            let bytes = source.as_bytes();
            let mut depth = 0usize;
            let mut in_string = false;
            let mut escaped = false;
            let mut at = start;
            while at < bytes.len() {
                let byte = bytes[at];
                if in_string {
                    if escaped {
                        escaped = false;
                    } else if byte == b'\\' {
                        escaped = true;
                    } else if byte == b'"' {
                        in_string = false;
                    }
                } else {
                    match byte {
                        b'"' => in_string = true,
                        b'[' => depth += 1,
                        b']' => {
                            depth = depth.checked_sub(1)?;
                            if depth == 0 {
                                return Some(at + 1);
                            }
                        }
                        _ => {}
                    }
                }
                at += 1;
            }
            None
        }

        fn skip_whitespace(source: &str, mut at: usize) -> usize {
            while at < source.len() && source.as_bytes()[at].is_ascii_whitespace() {
                at += 1;
            }
            at
        }

        /// Whitespace, comments and further attributes between the command attribute and
        /// the `fn` it decorates.
        fn skip_trivia(source: &str, mut at: usize) -> usize {
            loop {
                at = skip_whitespace(source, at);
                if source[at..].starts_with("//") {
                    at = source[at..].find('\n').map_or(source.len(), |offset| at + offset + 1);
                } else if source[at..].starts_with("/*") {
                    at = source[at + 2..].find("*/").map_or(source.len(), |offset| at + 2 + offset + 2);
                } else if source[at..].starts_with('#') {
                    // `#` and `[` are separate tokens; whitespace between them is legal.
                    let bracket = skip_whitespace(source, at + 1);
                    if source[bracket..].starts_with('[') {
                        at = attribute_end(source, at).unwrap_or(source.len());
                    } else {
                        at += 1;
                    }
                } else {
                    return at;
                }
            }
        }

        /// Name of the `fn` this attribute decorates (`pub async fn` and friends included).
        fn decorated_fn(source: &str, attribute_end: usize) -> Option<String> {
            let limit = (attribute_end + 64 * 1024).min(source.len());
            let mut at = attribute_end;
            loop {
                at = skip_trivia(source, at);
                if at >= limit {
                    return None;
                }
                let first = source[at..].chars().next()?;
                if !(first.is_ascii_alphabetic() || first == '_') {
                    at += first.len_utf8();
                    continue;
                }
                let start = at;
                while at < source.len() {
                    let c = source[at..].chars().next()?;
                    if c.is_ascii_alphanumeric() || c == '_' {
                        at += c.len_utf8();
                    } else {
                        break;
                    }
                }
                if &source[start..at] == "fn" {
                    let name = skip_trivia(source, at);
                    let mut end = name;
                    while end < source.len() {
                        let c = source[end..].chars().next()?;
                        if c.is_ascii_alphanumeric() || c == '_' {
                            end += c.len_utf8();
                        } else {
                            break;
                        }
                    }
                    return (end > name).then(|| source[name..end].to_owned());
                }
            }
        }

        /// `rename = "..."` from a `#[tauri::command(...)]` attribute body.
        fn renamed_to(attribute: &str) -> Option<String> {
            fn word(c: Option<char>) -> bool {
                c.is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
            }
            let mut at = 0;
            while let Some(offset) = attribute[at..].find("rename") {
                let start = at + offset;
                at = start + "rename".len();
                let before = attribute[..start].chars().next_back();
                let after = attribute[at..].chars().next();
                if word(before) || word(after) || before == Some(':') || after == Some(':') {
                    continue;
                }
                let equals = skip_whitespace(attribute, at);
                if attribute.as_bytes().get(equals) != Some(&b'=') {
                    continue;
                }
                let quote = skip_whitespace(attribute, equals + 1);
                if attribute.as_bytes().get(quote) != Some(&b'"') {
                    continue;
                }
                let mut value = String::new();
                let mut chars = attribute[quote + 1..].chars();
                while let Some(c) = chars.next() {
                    match c {
                        '"' => return Some(value),
                        '\\' => value.push(chars.next()?),
                        _ => value.push(c),
                    }
                }
                return None;
            }
            None
        }

        let mut files = Vec::new();
        rust_files(&Path::new(env!("CARGO_MANIFEST_DIR")).join("src"), &mut files);
        let mut renames = BTreeMap::new();
        for path in files {
            let Ok(source) = std::fs::read_to_string(&path) else { continue };
            let mut at = 0;
            while let Some(offset) = source[at..].find("#[tauri::command") {
                let start = at + offset;
                let Some(end) = attribute_end(&source, start) else { break };
                at = end;
                let Some(wire) = renamed_to(&source[start..end]) else { continue };
                let Some(name) = decorated_fn(&source, end) else { continue };
                renames.insert(name, wire);
            }
        }
        renames
    }

    #[test]
    fn every_main_window_command_is_reviewed_for_web() {
        let rust_commands = main_window_commands();
        assert!(rust_commands.len() > 300, "parsed only {} commands", rust_commands.len());
        assert!(rust_commands.iter().all(|name| name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')), "{rust_commands:?}");
        // Review the wire name a tab sends, not the Rust name Tauri registers.
        let renames = command_renames();
        let commands: Vec<String> = rust_commands.iter().map(|name| renames.get(name).cloned().unwrap_or_else(|| name.clone())).collect();
        assert!(commands.iter().all(|name| name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')), "{commands:?}");
        let unreviewed: Vec<_> = commands
            .iter()
            .filter(|name| !web_blocked_command(name) && !WEB_ALLOWED_COMMANDS.contains(&name.as_str()))
            .collect();
        assert!(unreviewed.is_empty(), "review these for web tabs (allow in WEB_ALLOWED_COMMANDS or block in web_blocked_command): {unreviewed:?}");
        let contradictory: Vec<_> = WEB_ALLOWED_COMMANDS.iter().filter(|name| web_blocked_command(name)).collect();
        assert!(contradictory.is_empty(), "allowed and blocked: {contradictory:?}");
        let stale: Vec<_> = WEB_ALLOWED_COMMANDS.iter().filter(|name| !commands.iter().any(|command| command.as_str() == **name)).collect();
        assert!(stale.is_empty(), "no longer registered: {stale:?}");
        // The shipped renames must resolve, and the allowlist must carry the wire name, so
        // reverting any one of these three to its Rust name fails here.
        for (rust, wire) in [
            ("delete_session_with_attachment_cleanup", "delete_session"),
            ("model_routing_status_command", "model_routing_status"),
            ("model_routing_configure_command", "model_routing_configure"),
        ] {
            assert_eq!(renames.get(rust).map(String::as_str), Some(wire), "wire name for {rust}");
            assert!(commands.iter().any(|command| command == wire), "{wire} is not registered");
            assert!(WEB_ALLOWED_COMMANDS.contains(&wire), "{wire} must be allowed for web tabs");
            assert!(!WEB_ALLOWED_COMMANDS.contains(&rust), "{rust} is a Rust name, not a wire name");
        }
        // Spot checks on the review itself.
        for name in ["browser_inspect", "voice_start", "overlay_toggle", "reveal_path"] {
            assert!(commands.iter().any(|command| command == name) && web_blocked_command(name), "{name}");
        }
        assert!(WEB_ALLOWED_COMMANDS.contains(&"tray_seen") && WEB_ALLOWED_COMMANDS.contains(&"send_message"));
    }

    /// The fake's answers behind the trait's default allowlist, as every real backend runs.
    struct Strict(Fake);

    impl Backend for Strict {
        fn rotate_if_token(&self, expected: String) -> BoxFuture<Reply> {
            self.0.rotate_if_token(expected)
        }
        fn configure_if_token(&self, expected: String, args: Value) -> BoxFuture<Reply> {
            self.0.configure_if_token(expected, args)
        }
        fn invoke(&self, command: String, _args: Value) -> BoxFuture<Reply> {
            let reply = match command.as_str() {
                "list_sessions" => Reply::Json("[]".into()),
                _ => Reply::Unknown,
            };
            lock(&self.0.invoked).push(command);
            Box::pin(async move { reply })
        }
        fn asset(&self, path: String, dev_proxy: bool) -> BoxFuture<Option<StaticAsset>> {
            self.0.asset(path, dev_proxy)
        }
        fn listen(&self, name: &str, sink: broadcast::Sender<HubEvent>) -> ListenerId {
            self.0.listen(name, sink)
        }
        fn unlisten(&self, id: ListenerId) {
            self.0.unlisten(id)
        }
        fn changed(&self) {
            self.0.changed()
        }
    }

    #[tokio::test]
    async fn the_default_allowlist_refuses_unreviewed_commands() {
        let backend = Arc::new(Strict(Fake::default()));
        assert!(backend.enforces_allowlist());
        let server = WebServer::new(temp_dir());
        let status = server.start(backend.clone(), LOCAL, 0, false).await.unwrap();
        let (addr, token) = (SocketAddr::new(LOCAL, status.port), token_of(&status));
        for body in [r#"{"command":"echo"}"#, r#"{"command":"unreviewed_command"}"#] {
            assert!(!web_allowed_command(serde_json::from_str::<Value>(body).unwrap()["command"].as_str().unwrap()));
            let reply = request(addr, "POST", "/api/invoke", &[host(addr), bearer(&token)], body).await;
            assert_eq!(reply.status, 403, "{body}");
            assert_eq!(reply.text(), r#"{"error":"This command is only available in the desktop app."}"#);
        }
        assert!(lock(&backend.0.invoked).is_empty(), "a refused command reached the backend");
        assert!(web_allowed_command("list_sessions"));
        let reply = request(addr, "POST", "/api/invoke", &[host(addr), bearer(&token)], r#"{"command":"list_sessions"}"#).await;
        assert_eq!(reply.status, 200);
        assert_eq!(reply.text(), "[]");
        assert_eq!(*lock(&backend.0.invoked), ["list_sessions"]);
        server.stop().await;
    }

    #[tokio::test]
    async fn a_failed_host_switch_falls_back_to_loopback_for_the_next_start() {
        let fake = Arc::new(Fake::default());
        let server = WebServer::new(temp_dir());
        // Stands in for a CLI `--host` (any address but 127.0.0.1 shows the reset; `::1`
        // avoids the firewall prompt that listening on every interface can raise).
        let other: IpAddr = "::1".parse().unwrap();
        let first = server.start(fake.clone(), other, 0, false).await.unwrap();
        assert_eq!(server.configure_ip(None).unwrap(), other, "port-only edits keep a running --host");
        // Same port, an address this computer doesn't have: the old listener had to stop first.
        let error = server.start(fake.clone(), "192.0.2.1".parse().unwrap(), first.port, false).await.unwrap_err();
        assert!(error.ends_with(" The previous listener was stopped."), "{error}");
        assert!(!server.status().running);
        // Settings "Serve in browser" with no host now binds loopback, not the old address.
        let ip = server.configure_ip(None).unwrap();
        assert_eq!(ip, DEFAULT_HOST);
        assert_eq!(server.configure_ip(Some("  ")).unwrap(), DEFAULT_HOST);
        let again = server.start(fake.clone(), ip, 0, false).await.unwrap();
        assert_eq!(again.host, "127.0.0.1");
        server.stop().await;
    }

    #[test]
    fn encoded_query_and_fragment_never_reach_the_dev_proxy() {
        for path in ["/src/x.ts%3Fraw", "/src/x.ts%3fimport", "/a%23b", "/index.html%23", "/x?y", "/x#y"] {
            assert_eq!(asset_path(path), None, "{path}");
        }
        assert_eq!(asset_path("/assets/app%20x.js").as_deref(), Some("assets/app x.js"));
    }

    #[test]
    fn loopback_gets_a_bigger_connection_share_than_remote_peers() {
        let counts: PerIp = Arc::new(Mutex::new(HashMap::new()));
        let remote: IpAddr = "100.64.1.9".parse().unwrap();
        let remote_slots: Vec<_> = (0..MAX_CONNECTIONS_PER_IP).map(|_| IpSlot::take(&counts, remote).unwrap()).collect();
        assert!(IpSlot::take(&counts, remote).is_none(), "remote cap is {MAX_CONNECTIONS_PER_IP}");
        let local: Vec<_> = (0..MAX_LOOPBACK_CONNECTIONS).map(|_| IpSlot::take(&counts, LOCAL).unwrap()).collect();
        assert!(IpSlot::take(&counts, LOCAL).is_none(), "loopback cap is {MAX_LOOPBACK_CONNECTIONS}");
        // `::1` is its own loopback bucket with the same larger share.
        let v6: Vec<_> = (0..MAX_LOOPBACK_CONNECTIONS).map(|_| IpSlot::take(&counts, "::1".parse().unwrap()).unwrap()).collect();
        assert!(IpSlot::take(&counts, "::1".parse().unwrap()).is_none());
        drop((remote_slots, local, v6));
        assert!(lock(&counts).is_empty());
    }

    #[test]
    fn the_auth_failure_table_stays_bounded() {
        let limiter = Limiter::default();
        let start = Instant::now();
        let total = MAX_AUTH_LIMITER_ENTRIES + 500;
        for index in 0..total as u32 {
            // Every failure inside one window, each from a fresh address.
            limiter.fail(IpAddr::V4(Ipv4Addr::from(0x0a00_0000 + index)), start + Duration::from_millis(u64::from(index)));
            assert!(lock(&limiter.failures).len() <= MAX_AUTH_LIMITER_ENTRIES);
        }
        assert_eq!(lock(&limiter.failures).len(), MAX_AUTH_LIMITER_ENTRIES);
        // The oldest went first; the newest are kept.
        let failures = lock(&limiter.failures);
        assert!(!failures.contains_key(&IpAddr::V4(Ipv4Addr::from(0x0a00_0000u32))));
        assert!(failures.contains_key(&IpAddr::V4(Ipv4Addr::from(0x0a00_0000 + total as u32 - 1))));
        drop(failures);
        // A known key at capacity just counts up; nothing is evicted for it.
        let last = IpAddr::V4(Ipv4Addr::from(0x0a00_0000 + total as u32 - 1));
        limiter.fail(last, start + Duration::from_secs(5));
        assert_eq!(lock(&limiter.failures).len(), MAX_AUTH_LIMITER_ENTRIES);
        assert_eq!(lock(&limiter.failures)[&last].1, 2);
        // Expired windows are pruned before anything live is evicted.
        let later = start + FAILURE_WINDOW + Duration::from_secs(10);
        limiter.fail("192.0.2.7".parse().unwrap(), later);
        assert!(lock(&limiter.failures).len() < 10, "expired entries pruned");
    }

    #[test]
    fn desktop_window_events_never_reach_tabs() {
        for name in [
            "agent-ui-action",
            "overlay-open-task",
            "tray-open-session",
            "browser-state",
            "browser-element",
            "jev-frame",
            "app-quitting",
            "web-server-cli-started",
            "web-server-cli-failed",
        ] {
            assert!(web_blocked_event(name), "{name}");
        }
        for name in ["sessions-changed", "agent-event", "web-server-changed"] {
            assert!(!web_blocked_event(name), "{name}");
        }
        // The hub refuses them without registering an app listener.
        let fake = Fake::default();
        let hub = EventHub::new();
        assert_eq!(hub.subscribe(&fake, "browser-state"), Err("This event is only available in the desktop app."));
        assert_eq!(hub.active(), 0);
        assert_eq!(fake.listeners("browser-state"), 0);
        assert!(hub.subscribe(&fake, "sessions-changed").is_ok());
    }

    #[test]
    fn double_encoded_paths_are_refused() {
        for path in ["/%2540fs/etc/passwd", "/%252e%252e/secret", "/assets/%2541.js", "/%25"] {
            assert_eq!(asset_path(path), None, "{path}");
        }
        assert_eq!(asset_path("/assets/a%20b.js").as_deref(), Some("assets/a b.js"));
    }

    #[test]
    fn replies_are_withheld_once_the_token_rotated() {
        let ok = || Response::new(200, "application/json", br#"{"tokenUrl":"http://127.0.0.1:1/#token=new"}"#.to_vec());
        assert_eq!(guard_reply(true, ok()).status, 200);
        let withheld = guard_reply(false, ok());
        assert_eq!(withheld.status, 401);
        assert!(!String::from_utf8_lossy(&withheld.body).contains("token="));
        // It ran: the client must not retry it.
        let body: Value = serde_json::from_slice(&withheld.body).unwrap();
        assert_eq!(body, serde_json::json!({ "error": "Access token rotated while request was running.", "ran": true }));
        // A refusal before running says nothing of the sort.
        let before: Value = serde_json::from_slice(&rotated_away().body).unwrap();
        assert_eq!(before, serde_json::json!({ "error": "Invalid access token." }));
        // No exemptions: a tab's rotation is a compare-and-swap that never reaches the guard.
        assert_eq!(reply_response(rotate_reply(Err(RotateRefused::Stale))).status, 401);
        assert_eq!(reply_response(rotate_reply(Err(RotateRefused::NotRunning))).status, 400);
    }

    #[tokio::test]
    async fn a_held_open_invoke_on_the_old_token_is_refused_after_rotation() {
        let h = harness().await;
        let body = r#"{"command":"web_server_status"}"#;
        let head = format!(
            "POST /api/invoke HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            h.addr.port(),
            h.token,
            body.len()
        );
        let mut stream = TcpStream::connect(h.addr).await.unwrap();
        stream.write_all(head.as_bytes()).await.unwrap();
        // The head passed with the old token; the owner rotates before the body arrives.
        tokio::time::sleep(Duration::from_millis(200)).await;
        let rotated = h.server.rotate().unwrap();
        let fresh = token_of(&rotated);
        stream.write_all(body.as_bytes()).await.unwrap();
        let mut out = Vec::new();
        tokio::time::timeout(Duration::from_secs(5), stream.read_to_end(&mut out)).await.unwrap().unwrap();
        let text = String::from_utf8_lossy(&out);
        assert!(text.starts_with("HTTP/1.1 401 "), "{text}");
        assert!(!text.contains(&fresh));
        // Refused before running: safe to retry, so no `"ran"` flag.
        assert!(!text.contains("\"ran\""), "{text}");
        assert!(text.ends_with(r#"{"error":"Invalid access token."}"#), "{text}");
        assert!(!lock(&h.fake.invoked).iter().any(|command| command == "web_server_status"), "the command never ran");
        // The new token works as usual.
        let reply = request(h.addr, "POST", "/api/invoke", &[host(h.addr), bearer(&fresh)], r#"{"command":"echo"}"#).await;
        assert_eq!(reply.status, 200);
        h.server.stop().await;
    }

    /// Rotates through the real compare-and-swap, but only once the test opens the gate.
    struct GatedRotate {
        server: std::sync::OnceLock<std::sync::Weak<WebServer>>,
        entered: Arc<tokio::sync::Notify>,
        gate: Arc<tokio::sync::Notify>,
    }

    impl Backend for GatedRotate {
        fn configure_if_token(&self, _expected: String, _args: Value) -> BoxFuture<Reply> {
            Box::pin(async { Reply::Unknown })
        }
        fn invoke(&self, _command: String, _args: Value) -> BoxFuture<Reply> {
            Box::pin(async { Reply::Unknown })
        }
        fn rotate_if_token(&self, expected: String) -> BoxFuture<Reply> {
            let server = self.server.get().and_then(std::sync::Weak::upgrade);
            let (entered, gate) = (self.entered.clone(), self.gate.clone());
            Box::pin(async move {
                let Some(server) = server else { return Reply::NotReady };
                // Hold the request between its token check and the swap.
                entered.notify_one();
                gate.notified().await;
                rotate_reply(server.rotate_if_token(&expected))
            })
        }
        fn asset(&self, _path: String, _dev_proxy: bool) -> BoxFuture<Option<StaticAsset>> {
            Box::pin(async { None })
        }
        fn listen(&self, _name: &str, _sink: broadcast::Sender<HubEvent>) -> ListenerId {
            0
        }
        fn unlisten(&self, _id: ListenerId) {}
        fn changed(&self) {}
    }

    #[tokio::test]
    async fn a_queued_rotation_on_a_retired_token_cannot_rotate_again() {
        let server = Arc::new(WebServer::new(temp_dir()));
        let backend = Arc::new(GatedRotate { server: Default::default(), entered: Default::default(), gate: Default::default() });
        backend.server.set(Arc::downgrade(&server)).unwrap();
        let started = server.start(backend.clone(), LOCAL, 0, false).await.unwrap();
        let addr = SocketAddr::new(LOCAL, started.port);
        let token_a = token_of(&started);

        // The attacker's rotation, authorized with A, waits between its check and the swap...
        let attacker = tokio::spawn({
            let token_a = token_a.clone();
            async move { request(addr, "POST", "/api/invoke", &[host(addr), bearer(&token_a)], r#"{"command":"web_server_rotate_token"}"#).await }
        });
        tokio::time::timeout(Duration::from_secs(5), backend.entered.notified()).await.expect("the request reached the swap");
        // ...while the owner rotates A to B.
        let owner = server.rotate().unwrap();
        let token_b = token_of(&owner);
        assert_eq!(owner.token_generation, 2);
        backend.gate.notify_one();

        let reply = tokio::time::timeout(Duration::from_secs(5), attacker).await.unwrap().unwrap();
        assert_eq!(reply.status, 401, "{}", reply.text());
        assert!(!reply.text().contains("token="), "{}", reply.text());
        // B was not rotated to C: still current, same generation, still accepted.
        let after = server.status();
        assert_eq!(token_of(&after), token_b);
        assert_eq!(after.token_generation, 2);
        assert_eq!(request(addr, "POST", "/api/auth", &[host(addr), bearer(&token_b)], "").await.status, 200);

        // The owner's tab, on the current token, still rotates through the same path.
        let owner_tab = tokio::spawn({
            let token_b = token_b.clone();
            async move { request(addr, "POST", "/api/invoke", &[host(addr), bearer(&token_b)], r#"{"command":"web_server_rotate_token"}"#).await }
        });
        tokio::time::timeout(Duration::from_secs(5), backend.entered.notified()).await.unwrap();
        backend.gate.notify_one();
        let reply = tokio::time::timeout(Duration::from_secs(5), owner_tab).await.unwrap().unwrap();
        assert_eq!(reply.status, 200, "{}", reply.text());
        let status: Value = serde_json::from_slice(&reply.body).unwrap();
        assert_eq!(status["tokenGeneration"], 3);
        let token_c = status["tokenUrl"].as_str().unwrap().split_once("#token=").unwrap().1.to_owned();
        assert_eq!(token_of(&server.status()), token_c);
        assert_ne!(token_c, token_b);
        server.stop().await;
    }

    #[test]
    fn rotate_if_token_is_a_compare_and_swap() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let server = WebServer::new(temp_dir());
            assert_eq!(server.rotate_if_token("x").unwrap_err(), RotateRefused::NotRunning);
            let started = server.start(Arc::new(Fake::default()), LOCAL, 0, false).await.unwrap();
            let a = token_of(&started);
            assert_eq!(server.rotate_if_token("not-the-token").unwrap_err(), RotateRefused::Stale);
            assert_eq!(token_of(&server.status()), a, "a stale caller changes nothing");
            let b = server.rotate_if_token(&a).unwrap();
            assert_ne!(token_of(&b), a);
            assert_eq!(b.token_generation, 2);
            assert_eq!(server.rotate_if_token(&a).unwrap_err(), RotateRefused::Stale);
            assert_eq!(server.status().token_generation, 2);
            server.stop().await;
        });
    }

    #[tokio::test]
    async fn every_failure_after_a_host_switch_stop_resets_the_address() {
        // Settings can't be saved here, so the switch fails after the old listener stopped
        // and after the new bind succeeded.
        let dir = temp_dir().join("not-a-directory");
        std::fs::write(&dir, b"x").unwrap();
        let fake = Arc::new(Fake::default());
        let server = WebServer::new(dir);
        let other: IpAddr = "::1".parse().unwrap();
        let first = server.start(fake.clone(), other, 0, false).await.unwrap();
        assert_eq!(lock(&server.state).host, other);
        let error = server.start(fake.clone(), LOCAL, first.port, true).await.unwrap_err();
        assert!(error.starts_with("Could not save") && error.ends_with(" The previous listener was stopped."), "{error}");
        assert!(!server.status().running);
        assert_eq!(lock(&server.state).host, DEFAULT_HOST);
        assert_eq!(server.configure_ip(None).unwrap(), DEFAULT_HOST);
    }

    #[test]
    fn remote_peers_cannot_use_up_the_loopback_pool() {
        let gates = Gates::new();
        // 8 remote addresses x 32 slots fill the whole remote pool.
        let remote: Vec<_> = (0..MAX_CONNECTIONS)
            .map(|index| gates.admit(IpAddr::V4(Ipv4Addr::new(10, 0, 0, (index / MAX_CONNECTIONS_PER_IP) as u8 + 1))).expect("remote slot"))
            .collect();
        assert!(gates.admit("10.0.0.200".parse().unwrap()).is_none(), "remote pool full");
        assert!(gates.admit("2001:db8::1".parse().unwrap()).is_none());
        // Loopback has its own pool.
        let local: Vec<_> = (0..MAX_LOOPBACK_CONNECTIONS).map(|_| gates.admit(LOCAL).expect("loopback slot")).collect();
        assert!(gates.admit(LOCAL).is_none(), "loopback per-address cap");
        assert!(gates.admit("::1".parse().unwrap()).is_none(), "loopback pool full");
        drop(remote);
        assert!(gates.admit("10.0.0.200".parse().unwrap()).is_some(), "remote slots come back");
        drop(local);
        assert!(gates.admit(LOCAL).is_some());
    }

    #[test]
    fn a_rotation_reply_carries_the_token_it_wrote() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let server = Arc::new(WebServer::new(temp_dir()));
            let started = server.start(Arc::new(Fake::default()), LOCAL, 0, false).await.unwrap();
            // The tab swaps T0 -> T1; the desktop rotates T1 -> T2 right after.
            let tab = server.rotate_if_token(&token_of(&started)).unwrap();
            let desktop = server.rotate().unwrap();
            assert_eq!((tab.token_generation, desktop.token_generation), (2, 3));
            assert_ne!(token_of(&tab), token_of(&desktop));
            assert_eq!(token_of(&server.status()), token_of(&desktop));
            // Under contention: every rotation's reply is its own (generation, token) pair,
            // never one written by a later rotation.
            let threads: Vec<_> = (0..8)
                .map(|index| {
                    let server = server.clone();
                    std::thread::spawn(move || {
                        let mut replies = Vec::new();
                        for _ in 0..200 {
                            let reply = if index % 2 == 0 {
                                server.rotate().ok()
                            } else {
                                let current = token_of(&server.status());
                                server.rotate_if_token(&current).ok()
                            };
                            replies.extend(reply.map(|status| (status.token_generation, token_of(&status))));
                        }
                        replies
                    })
                })
                .collect();
            let replies: Vec<(u64, String)> = threads.into_iter().flat_map(|thread| thread.join().unwrap()).collect();
            let generations: HashSet<u64> = replies.iter().map(|(generation, _)| *generation).collect();
            let tokens: HashSet<&String> = replies.iter().map(|(_, token)| token).collect();
            assert_eq!(generations.len(), replies.len(), "two rotations reported the same generation");
            assert_eq!(tokens.len(), replies.len(), "two rotations reported the same token");
            let last = server.status();
            assert_eq!(last.token_generation, 3 + replies.len() as u64);
            assert!(replies.iter().any(|(generation, token)| *generation == last.token_generation && *token == token_of(&last)));
            server.stop().await;
        });
    }

    #[test]
    fn launch_errors_show_in_the_status_without_starting() {
        let server = WebServer::new(temp_dir());
        server.record_error("--port needs a value.");
        let status = server.status();
        assert_eq!(status.error.as_deref(), Some("--port needs a value."));
        assert!(!status.running && !status.enabled);
        assert_eq!(load_config(&server.dir), Config::default(), "nothing saved");
    }

    fn self_config() -> (Arc<WebServer>, Arc<SelfConfig>) {
        let server = Arc::new(WebServer::new(temp_dir()));
        let backend = Arc::new(SelfConfig::default());
        backend.server.set(Arc::downgrade(&server)).unwrap();
        backend.me.set(Arc::downgrade(&backend)).unwrap();
        (server, backend)
    }

    fn invoke_on(addr: SocketAddr, token: &str, body: &'static str) -> tokio::task::JoinHandle<HttpReply> {
        let token = token.to_owned();
        tokio::spawn(async move { request(addr, "POST", "/api/invoke", &[host(addr), bearer(&token)], body).await })
    }

    #[tokio::test]
    async fn requests_in_flight_on_a_stopped_server_never_read_the_next_link() {
        let (server, backend) = self_config();
        // Stop + start on the same port, and a port switch: either way the old server's
        // in-flight status call ran, but its reply is withheld.
        for switch_port in [false, true] {
            let first = server.start(backend.clone(), LOCAL, 0, false).await.unwrap();
            let old = SocketAddr::new(LOCAL, first.port);
            let pending = invoke_on(old, &token_of(&first), r#"{"command":"web_server_status","args":{"hold":true}}"#);
            tokio::time::timeout(Duration::from_secs(5), backend.entered.notified()).await.expect("the status call is running");
            let next = if switch_port {
                server.start(backend.clone(), LOCAL, 0, false).await.unwrap()
            } else {
                server.stop().await;
                server.start(backend.clone(), LOCAL, first.port, false).await.unwrap()
            };
            assert!(next.token_generation > first.token_generation);
            let new_token = token_of(&next);
            backend.gate.notify_one();
            let reply = tokio::time::timeout(Duration::from_secs(5), pending).await.unwrap().unwrap();
            assert_eq!(reply.status, 401, "{}", reply.text());
            let body: Value = serde_json::from_slice(&reply.body).unwrap();
            assert_eq!(body["ran"], true);
            assert!(!reply.text().contains(&new_token) && !reply.text().contains("token="), "{}", reply.text());
            server.stop().await;
        }
    }

    #[tokio::test]
    async fn only_the_callers_own_configure_gets_the_new_link() {
        let (server, backend) = self_config();
        let first = server.start(backend.clone(), LOCAL, 0, false).await.unwrap();
        let old = SocketAddr::new(LOCAL, first.port);
        let token = token_of(&first);
        // A second configure on the same token, queued behind the first...
        let queued = invoke_on(old, &token, r#"{"command":"web_server_configure","args":{"enabled":true,"port":0,"persist":false,"hold":true}}"#);
        tokio::time::timeout(Duration::from_secs(5), backend.entered.notified()).await.unwrap();
        // ...while the caller's own port switch goes through and returns the new link.
        let target = free_port();
        let body = format!(r#"{{"command":"web_server_configure","args":{{"enabled":true,"port":{target},"persist":false}}}}"#);
        let reply = request(old, "POST", "/api/invoke", &[host(old), bearer(&token)], &body).await;
        assert_eq!(reply.status, 200, "{}", reply.text());
        let status: Value = serde_json::from_slice(&reply.body).unwrap();
        assert_eq!(status["port"], target);
        let fresh = status["tokenUrl"].as_str().unwrap().split_once("#token=").unwrap().1.to_owned();
        assert_eq!(token_of(&server.status()), fresh);
        // The queued one: refused, nothing changed, no new link.
        backend.gate.notify_one();
        let reply = tokio::time::timeout(Duration::from_secs(5), queued).await.unwrap().unwrap();
        assert_eq!(reply.status, 401, "{}", reply.text());
        assert!(!reply.text().contains(&fresh) && !reply.text().contains("token="), "{}", reply.text());
        let after = server.status();
        assert_eq!((after.port, token_of(&after)), (target, fresh.clone()));
        // A configure (here a stop) on the current token still works, from the new port.
        let new = SocketAddr::new(LOCAL, target);
        let reply = request(new, "POST", "/api/invoke", &[host(new), bearer(&fresh)], r#"{"command":"web_server_configure","args":{"enabled":false,"persist":false}}"#).await;
        assert_eq!(reply.status, 200, "{}", reply.text());
        assert!(!server.status().running);
        // From the desktop (no token) a configure always applies.
        let desktop = server.configure(backend.clone(), Configure { enabled: true, port: Some(0), persist: Some(false), ..Default::default() }, None).await.unwrap();
        assert!(desktop.running);
        assert_eq!(server.configure(backend.clone(), Configure { enabled: false, persist: Some(false), ..Default::default() }, Some("stale")).await.unwrap_err(), ConfigureRefused::Stale);
        assert!(server.status().running, "a stale caller stops nothing");
        server.stop().await;
    }

    /// The next settings save lands a desktop rotation (the window a tab's change must
    /// survive); returns the slot the rotated status is put in.
    fn rotate_during_next_save(server: &Arc<WebServer>) -> Arc<Mutex<Option<WebServerStatus>>> {
        let rotated = Arc::new(Mutex::new(None));
        let (weak, slot) = (Arc::downgrade(server), rotated.clone());
        *lock(&server.after_save) = Some(Box::new(move || {
            let server = weak.upgrade().expect("server alive");
            *lock(&slot) = Some(server.rotate().expect("rotates"));
        }));
        rotated
    }

    #[tokio::test]
    async fn a_rotation_during_the_save_refuses_a_tabs_change() {
        let dir = temp_dir();
        let fake: Arc<dyn Backend> = Arc::new(Fake::default());
        let saved_before = Config { enabled: false, port: 1234, ..Config::default() };
        save_config(&dir, saved_before.clone()).unwrap();
        let server = Arc::new(WebServer::new(dir.clone()));
        let first = server.start(fake.clone(), LOCAL, 0, false).await.unwrap();
        let old_token = token_of(&first);

        // Same port: the save succeeds, the owner rotates meanwhile, the tab gets nothing.
        let rotated = rotate_during_next_save(&server);
        let change = Configure { enabled: true, port: Some(first.port), persist: Some(true), ..Default::default() };
        let result = server.configure(fake.clone(), change, Some(&old_token)).await;
        assert_eq!(result.unwrap_err(), ConfigureRefused::Stale);
        let rotated = lock(&rotated).take().expect("rotated during the save");
        let now = server.status();
        assert_eq!(token_of(&now), token_of(&rotated));
        assert_eq!(now.port, first.port);
        assert_eq!(load_config(&dir), saved_before, "the refused change's save was put back");
        assert_eq!(now.configured_port, 1234);

        // Port switch: bound and saved, then refused at the commit; the rotated server stays.
        let token_b = token_of(&rotated);
        let rotated = rotate_during_next_save(&server);
        let target = free_port();
        let change = Configure { enabled: true, port: Some(target), persist: Some(true), ..Default::default() };
        let result = server.configure(fake.clone(), change, Some(&token_b)).await;
        assert_eq!(result.unwrap_err(), ConfigureRefused::Stale);
        let rotated = lock(&rotated).take().expect("rotated during the save");
        let now = server.status();
        assert!(now.running);
        assert_eq!(now.port, first.port, "still on its original port");
        assert_eq!(token_of(&now), token_of(&rotated));
        assert!(std::net::TcpListener::bind((LOCAL, target)).is_ok(), "the new port was let go");
        assert_eq!(load_config(&dir), saved_before);
        let addr = SocketAddr::new(LOCAL, now.port);
        assert_eq!(request(addr, "POST", "/api/auth", &[host(addr), bearer(&token_of(&now))], "").await.status, 200);

        // Stop: a stale token never stops the rotated server.
        let change = Configure { enabled: false, persist: Some(true), ..Default::default() };
        assert_eq!(server.configure(fake.clone(), change, Some(&token_b)).await.unwrap_err(), ConfigureRefused::Stale);
        assert!(server.status().running);
        assert_eq!(load_config(&dir), saved_before);

        // On the current token every path still works.
        let current = token_of(&server.status());
        let change = Configure { enabled: true, port: Some(target), persist: Some(true), ..Default::default() };
        let moved = server.configure(fake.clone(), change, Some(&current)).await.unwrap();
        assert_eq!(moved.port, target);
        assert_eq!(load_config(&dir), Config { enabled: true, port: target, ..Config::default() });
        let change = Configure { enabled: false, persist: Some(true), ..Default::default() };
        let off = server.configure(fake.clone(), change, Some(&token_of(&moved))).await.unwrap();
        assert!(!off.running);
        assert_eq!(load_config(&dir), Config { enabled: false, port: target, ..Config::default() });
    }

    #[tokio::test]
    async fn clients_of_a_retired_server_leave_without_announcing() {
        let h = harness().await;
        // A client leaving a live server is announced.
        let ws = authed(h.addr, &h.token).await;
        wait_clients(&h.server, 1).await;
        let before = h.fake.changes.load(Ordering::SeqCst);
        drop(ws);
        wait_clients(&h.server, 0).await;
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(h.fake.changes.load(Ordering::SeqCst), before + 1);
        // Clients leaving because the server stopped are not.
        let mut ws = authed(h.addr, &h.token).await;
        wait_clients(&h.server, 1).await;
        let before = h.fake.changes.load(Ordering::SeqCst);
        h.server.stop().await;
        assert_eq!(close_code(&mut ws).await.0, 1001);
        drop(ws);
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(h.fake.changes.load(Ordering::SeqCst), before, "no change announced for a retired server");
    }
}
