//! Opt-in authenticated browser gateway. HTTP never constructs or accepts a Tauri `Invoke`;
//! reviewed commands cross a finite broker to the already-running main Webview and therefore use
//! the same typed command wrappers and single application state as the desktop.
pub mod auth;
pub mod browser;
pub mod commands;
pub mod console_lifecycle;
pub mod consoles;
pub mod dock;
pub mod documents;
pub mod events;
pub mod files;
pub mod preferences;
mod server;
pub mod terminal;

use commands::{BrokerRequest, CommandPolicy, Exposure, Guard};
use serde::Serialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    hash::{Hash, Hasher},
    net::{Ipv4Addr, SocketAddr},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{Emitter, EventTarget, Listener, Manager};
use tokio::sync::{oneshot, OwnedSemaphorePermit, Semaphore};

const COMMAND_TIMEOUT: Duration = Duration::from_secs(45);
const GITHUB_CLONE_TIMEOUT: Duration = Duration::from_secs(620);
const MAX_PENDING: usize = 64;
const MAX_LATE_TERMINAL_CREATES: usize = MAX_PENDING;
const MAX_FILE_OPERATIONS: usize = 4;
const MAX_CONSOLE_OPERATIONS: usize = 4;
const DEDUPE_TTL: Duration = Duration::from_secs(5 * 60);
// Typed terminal input is conservatively treated as mutating. Keep five minutes of identities for
// sustained interactive typing while the independent byte cap bounds retained response bodies.
const MAX_DEDUPE_ENTRIES: usize = 32 * 1024;
const MAX_DEDUPE_RESULT_BYTES: usize = 32 * 1024 * 1024;
const TERMINAL_RECONNECT_GRACE: Duration = Duration::from_secs(2 * 60);

#[derive(Clone, Debug)]
pub struct Config {
    pub enabled: bool,
    pub port: u16,
    pub origin: String,
    pub host: String,
    pub root_specs: Vec<String>,
}

impl Config {
    fn from_args() -> Result<Self, String> {
        let mut enabled = false;
        let mut port = 6082u16;
        let mut origin = None;
        let mut root_specs = Vec::new();
        for argument in std::env::args().skip(1) {
            if argument == "--web-gateway" {
                enabled = true;
            }
            if let Some(value) = argument.strip_prefix("--web-gateway-port=") {
                port = value
                    .parse()
                    .map_err(|_| "Invalid --web-gateway-port.".to_owned())?;
            }
            if let Some(value) = argument.strip_prefix("--web-gateway-origin=") {
                origin = Some(value.to_owned());
            }
            if let Some(value) = argument.strip_prefix("--web-root=") {
                root_specs.push(value.to_owned());
            }
        }
        if !enabled {
            return Ok(Self {
                enabled: false,
                port,
                origin: String::new(),
                host: String::new(),
                root_specs,
            });
        }
        let origin = origin.unwrap_or_else(|| format!("http://127.0.0.1:{port}"));
        let url =
            tauri::Url::parse(&origin).map_err(|_| "Invalid --web-gateway-origin.".to_owned())?;
        if !matches!(url.scheme(), "http" | "https")
            || url.username() != ""
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.path() != "/"
        {
            return Err("Web gateway origin must be an HTTP(S) origin without credentials, path, query or fragment.".into());
        }
        let host = url
            .host_str()
            .ok_or("Web gateway origin requires a host.")?;
        let host = match url.port() {
            Some(port) => format!("{host}:{port}"),
            None => host.to_owned(),
        };
        Ok(Self {
            enabled,
            port,
            origin: url.origin().ascii_serialization(),
            host,
            root_specs,
        })
    }
}

struct Pending {
    sender: oneshot::Sender<Result<serde_json::Value, DispatchFailure>>,
    session_id: String,
    policy: &'static CommandPolicy,
    dedupe: Option<DedupeKey>,
    terminal_id: Option<String>,
    uploads: Vec<files::Upload>,
    terminal_create_permit: Option<OwnedSemaphorePermit>,
}

struct LateTerminalCreate {
    session_id: String,
    _permit: OwnedSemaphorePermit,
}

#[derive(Default)]
struct SocketState {
    count: usize,
    epoch: u64,
}

#[derive(Clone, Debug)]
struct DedupeKey {
    session: String,
    command: String,
    request: String,
    fingerprint: [u8; 32],
}

impl PartialEq for DedupeKey {
    fn eq(&self, other: &Self) -> bool {
        self.session == other.session
            && self.command == other.command
            && self.request == other.request
    }
}

impl Eq for DedupeKey {}

impl Hash for DedupeKey {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.session.hash(state);
        self.command.hash(state);
        self.request.hash(state);
    }
}

enum DedupeEntry {
    InFlight,
    Complete {
        expires: Instant,
        outcome: Option<DedupeOutcome>,
    },
    Uncertain,
}

enum DedupeOutcome {
    Success(Arc<[u8]>),
    Failure(DispatchFailure),
}

impl DedupeOutcome {
    fn from_result(result: Result<serde_json::Value, DispatchFailure>) -> Self {
        match result {
            Ok(value) => match serde_json::to_vec(&value) {
                Ok(bytes) => Self::Success(bytes.into()),
                Err(_) => Self::Failure(DispatchFailure::Internal),
            },
            Err(error) => Self::Failure(error),
        }
    }

    fn replay(&self) -> Result<serde_json::Value, DispatchFailure> {
        match self {
            Self::Success(bytes) => {
                serde_json::from_slice(bytes).map_err(|_| DispatchFailure::Internal)
            }
            Self::Failure(error) => Err(error.clone()),
        }
    }

    fn bytes(&self) -> usize {
        match self {
            Self::Success(bytes) => bytes.len(),
            Self::Failure(_) => 0,
        }
    }
}

struct DedupeStore {
    entries: HashMap<DedupeKey, DedupeEntry>,
    result_bytes: usize,
    max_entries: usize,
    max_result_bytes: usize,
}

impl Default for DedupeStore {
    fn default() -> Self {
        Self {
            entries: HashMap::new(),
            result_bytes: 0,
            max_entries: MAX_DEDUPE_ENTRIES,
            max_result_bytes: MAX_DEDUPE_RESULT_BYTES,
        }
    }
}

impl DedupeStore {
    #[cfg(test)]
    fn with_limits(max_entries: usize, max_result_bytes: usize) -> Self {
        Self {
            entries: HashMap::new(),
            result_bytes: 0,
            max_entries,
            max_result_bytes,
        }
    }

    fn claim(
        &mut self,
        key: &DedupeKey,
    ) -> Result<Option<Result<serde_json::Value, DispatchFailure>>, DispatchFailure> {
        self.prune(Instant::now());
        let existing = match self.entries.get_key_value(key) {
            Some((existing, _)) if existing.fingerprint != key.fingerprint => {
                return Err(DispatchFailure::Conflict(
                    "request ID was already used with different input",
                ));
            }
            Some((
                _,
                DedupeEntry::Complete {
                    outcome: Some(outcome),
                    ..
                },
            )) => Some(outcome.replay()),
            Some((_, DedupeEntry::Complete { outcome: None, .. })) => {
                Some(Err(DispatchFailure::Conflict(
                    "request completed but its response is no longer retained; refresh state",
                )))
            }
            Some((_, DedupeEntry::InFlight)) => Some(Err(DispatchFailure::Conflict(
                "request already in progress",
            ))),
            Some((_, DedupeEntry::Uncertain)) => Some(Err(DispatchFailure::Conflict(
                "previous request outcome is uncertain; refresh state",
            ))),
            None => None,
        };
        if existing.is_none() {
            if self.entries.len() >= self.max_entries {
                return Err(DispatchFailure::Busy);
            }
            self.entries.insert(key.clone(), DedupeEntry::InFlight);
        }
        Ok(existing)
    }

    fn complete(
        &mut self,
        key: DedupeKey,
        result: Result<serde_json::Value, DispatchFailure>,
        ttl: Duration,
    ) {
        self.remove(&key);
        let outcome = DedupeOutcome::from_result(result);
        self.result_bytes = self.result_bytes.saturating_add(outcome.bytes());
        self.entries.insert(
            key,
            DedupeEntry::Complete {
                expires: Instant::now() + ttl,
                outcome: Some(outcome),
            },
        );
        self.shed_results();
    }

    fn uncertain(&mut self, key: DedupeKey) {
        self.remove(&key);
        self.entries.insert(key, DedupeEntry::Uncertain);
    }

    fn remove(&mut self, key: &DedupeKey) {
        if let Some(entry) = self.entries.remove(key) {
            self.result_bytes = self.result_bytes.saturating_sub(entry.result_bytes());
        }
    }

    fn remove_session(&mut self, session: &str) {
        let keys = self
            .entries
            .keys()
            .filter(|key| key.session == session)
            .cloned()
            .collect::<Vec<_>>();
        for key in keys {
            self.remove(&key);
        }
    }

    fn prune(&mut self, now: Instant) {
        let expired = self
            .entries
            .iter()
            .filter(|(_, entry)| entry.expires().is_some_and(|expires| expires <= now))
            .map(|(key, _)| key.clone())
            .collect::<Vec<_>>();
        for key in expired {
            self.remove(&key);
        }
    }

    /// Shed only response bodies. The completed request identity remains as a tombstone until its
    /// TTL, so byte pressure can never make the same mutation request executable again.
    fn shed_results(&mut self) {
        while self.result_bytes > self.max_result_bytes {
            let candidate = self
                .entries
                .iter()
                .filter_map(|(key, entry)| match entry {
                    DedupeEntry::Complete {
                        expires,
                        outcome: Some(outcome),
                    } if outcome.bytes() > 0 => Some((key.clone(), *expires)),
                    _ => None,
                })
                .min_by_key(|(_, expires)| *expires)
                .map(|(key, _)| key);
            let Some(key) = candidate else {
                break;
            };
            if let Some(DedupeEntry::Complete { outcome, .. }) = self.entries.get_mut(&key) {
                if let Some(outcome) = outcome.take() {
                    self.result_bytes = self.result_bytes.saturating_sub(outcome.bytes());
                }
            }
        }
    }
}

impl DedupeEntry {
    fn expires(&self) -> Option<Instant> {
        match self {
            Self::Complete { expires, .. } => Some(*expires),
            Self::InFlight | Self::Uncertain => None,
        }
    }

    fn result_bytes(&self) -> usize {
        match self {
            Self::Complete {
                outcome: Some(outcome),
                ..
            } => outcome.bytes(),
            _ => 0,
        }
    }
}

#[derive(Clone, Debug)]
pub enum DispatchFailure {
    BadRequest(&'static str),
    Forbidden,
    NotReady,
    Busy,
    Blocked(&'static str),
    Conflict(&'static str),
    Timeout,
    CommandFailed,
    ResponseTooLarge,
    Internal,
}

trait NativeBroker: Send + Sync {
    fn command(&self, request: BrokerRequest) -> Result<(), ()>;
    fn terminal_close(&self, _terminal_id: &str) -> Result<(), ()> {
        // HTTP fixture brokers do not own OS PTYs, so acknowledging their synthetic terminal is
        // sufficient to exercise journal cleanup. Every production broker must explicitly prove
        // native teardown; the default therefore fails closed outside tests.
        #[cfg(test)]
        {
            Ok(())
        }
        #[cfg(not(test))]
        {
            Err(())
        }
    }
    fn preferences(&self, id: &str, preferences: &preferences::PreferenceMap) -> Result<(), ()>;
    fn document(&self, request: documents::DocumentRequest) -> documents::ReadFuture;
    fn console_validate(
        &self,
        kind: consoles::Kind,
        target: String,
    ) -> consoles::OperationFuture<()>;
    fn console_frame(
        &self,
        kind: consoles::Kind,
        target: String,
        after: u64,
    ) -> consoles::OperationFuture<consoles::Frame>;
    fn console_input(
        &self,
        kind: consoles::Kind,
        target: String,
        input: serde_json::Value,
    ) -> consoles::OperationFuture<String>;
    fn console_lifecycle(
        &self,
        lease: consoles::Lease,
        action: console_lifecycle::Action,
    ) -> console_lifecycle::OperationFuture<serde_json::Value>;
    fn console_capture(
        &self,
        lease: consoles::Lease,
    ) -> console_lifecycle::OperationFuture<Vec<u8>>;
    fn dock(&self, action: dock::Action) -> dock::OperationFuture;
    fn browser(
        &self,
        request: browser::NativeRequest,
    ) -> browser::OperationFuture<browser::NativeResponse>;
}

struct TauriBroker {
    app: tauri::AppHandle,
}
impl NativeBroker for TauriBroker {
    fn command(&self, request: BrokerRequest) -> Result<(), ()> {
        self.app
            .emit_to(
                EventTarget::webview_window("main"),
                "web-gateway-request",
                request,
            )
            .map_err(|_| ())
    }
    fn terminal_close(&self, terminal_id: &str) -> Result<(), ()> {
        let state = self.app.state::<crate::AppState>();
        crate::terminal::close(&state.terminals, terminal_id).map_err(|_| ())
    }
    fn preferences(&self, id: &str, preferences: &preferences::PreferenceMap) -> Result<(), ()> {
        self.app
            .emit_to(
                EventTarget::webview_window("main"),
                "web-gateway-preferences",
                serde_json::json!({ "id": id, "preferences": preferences }),
            )
            .map_err(|_| ())
    }
    fn document(&self, request: documents::DocumentRequest) -> documents::ReadFuture {
        documents::read(self.app.clone(), request)
    }
    fn console_validate(
        &self,
        kind: consoles::Kind,
        target: String,
    ) -> consoles::OperationFuture<()> {
        consoles::validate_native(self.app.clone(), kind, target)
    }
    fn console_frame(
        &self,
        kind: consoles::Kind,
        target: String,
        after: u64,
    ) -> consoles::OperationFuture<consoles::Frame> {
        consoles::frame_native(self.app.clone(), kind, target, after)
    }
    fn console_input(
        &self,
        kind: consoles::Kind,
        target: String,
        input: serde_json::Value,
    ) -> consoles::OperationFuture<String> {
        consoles::input_native(self.app.clone(), kind, target, input)
    }
    fn console_lifecycle(
        &self,
        lease: consoles::Lease,
        action: console_lifecycle::Action,
    ) -> console_lifecycle::OperationFuture<serde_json::Value> {
        console_lifecycle::run_native(self.app.clone(), lease, action)
    }
    fn console_capture(
        &self,
        lease: consoles::Lease,
    ) -> console_lifecycle::OperationFuture<Vec<u8>> {
        console_lifecycle::capture_native(self.app.clone(), lease)
    }
    fn dock(&self, action: dock::Action) -> dock::OperationFuture {
        dock::run_native(self.app.clone(), action)
    }
    fn browser(
        &self,
        request: browser::NativeRequest,
    ) -> browser::OperationFuture<browser::NativeResponse> {
        browser::native(self.app.clone(), request)
    }
}

pub struct Gateway {
    broker: Arc<dyn NativeBroker>,
    pub(crate) assets: Option<tauri::AssetResolver<tauri::Wry>>,
    pub(crate) config: Config,
    ready: AtomicBool,
    address: Mutex<Option<SocketAddr>>,
    pub(crate) sessions: Mutex<auth::SessionStore>,
    session_revocations: tokio::sync::broadcast::Sender<String>,
    pub(crate) pairing: Mutex<auth::Pairing>,
    pub(crate) password_hash: Option<[u8; 32]>,
    pending: Mutex<HashMap<String, Pending>>,
    late_terminal_creates: Mutex<HashMap<String, LateTerminalCreate>>,
    dedupe: Mutex<DedupeStore>,
    admission: Arc<Semaphore>,
    terminal_create_admission: Arc<Semaphore>,
    pub(crate) file_admission: Arc<Semaphore>,
    console_admission: Arc<Semaphore>,
    browser_admission: Arc<Semaphore>,
    command_timeout: Duration,
    clone_timeout: Duration,
    pub(crate) events: events::EventHub,
    pub(crate) terminals: Mutex<terminal::TerminalOwners>,
    pub(crate) terminal_journal: Mutex<terminal::TerminalJournal>,
    socket_counts: Mutex<HashMap<String, SocketState>>,
    pub(crate) files: Mutex<files::FileAccess>,
    pub(crate) consoles: Mutex<consoles::ConsoleLeases>,
    pub(crate) browsers: Mutex<browser::BrowserLeases>,
    pub(crate) preferences: Mutex<preferences::Snapshot>,
    preference_waiters: Mutex<HashMap<String, oneshot::Sender<preferences::Snapshot>>>,
}

impl Gateway {
    fn new(app: tauri::AppHandle, config: Config, files: files::FileAccess) -> Self {
        let (session_revocations, _) = tokio::sync::broadcast::channel(32);
        Self {
            broker: Arc::new(TauriBroker { app: app.clone() }),
            assets: Some(app.asset_resolver()),
            config,
            ready: AtomicBool::new(false),
            address: Mutex::new(None),
            sessions: Mutex::new(auth::SessionStore::default()),
            session_revocations,
            pairing: Mutex::new(auth::Pairing::default()),
            password_hash: None,
            pending: Mutex::new(HashMap::new()),
            late_terminal_creates: Mutex::new(HashMap::new()),
            dedupe: Mutex::new(DedupeStore::default()),
            admission: Arc::new(Semaphore::new(MAX_PENDING)),
            terminal_create_admission: Arc::new(Semaphore::new(MAX_LATE_TERMINAL_CREATES)),
            file_admission: Arc::new(Semaphore::new(MAX_FILE_OPERATIONS)),
            console_admission: Arc::new(Semaphore::new(MAX_CONSOLE_OPERATIONS)),
            browser_admission: Arc::new(Semaphore::new(4)),
            command_timeout: COMMAND_TIMEOUT,
            clone_timeout: GITHUB_CLONE_TIMEOUT,
            events: events::EventHub::default(),
            terminals: Mutex::new(terminal::TerminalOwners::default()),
            terminal_journal: Mutex::new(terminal::TerminalJournal::default()),
            socket_counts: Mutex::new(HashMap::new()),
            files: Mutex::new(files),
            consoles: Mutex::new(consoles::ConsoleLeases::default()),
            browsers: Mutex::new(browser::BrowserLeases::default()),
            preferences: Mutex::new(preferences::Snapshot::default()),
            preference_waiters: Mutex::new(HashMap::new()),
        }
    }

    #[cfg(test)]
    fn with_broker(
        config: Config,
        broker: Arc<dyn NativeBroker>,
        command_timeout: Duration,
        clone_timeout: Duration,
    ) -> Self {
        let (session_revocations, _) = tokio::sync::broadcast::channel(32);
        Self {
            broker,
            assets: None,
            config,
            ready: AtomicBool::new(true),
            address: Mutex::new(None),
            sessions: Mutex::new(auth::SessionStore::default()),
            session_revocations,
            pairing: Mutex::new(auth::Pairing::default()),
            password_hash: None,
            pending: Mutex::new(HashMap::new()),
            late_terminal_creates: Mutex::new(HashMap::new()),
            dedupe: Mutex::new(DedupeStore::default()),
            admission: Arc::new(Semaphore::new(MAX_PENDING)),
            terminal_create_admission: Arc::new(Semaphore::new(MAX_LATE_TERMINAL_CREATES)),
            file_admission: Arc::new(Semaphore::new(MAX_FILE_OPERATIONS)),
            console_admission: Arc::new(Semaphore::new(MAX_CONSOLE_OPERATIONS)),
            browser_admission: Arc::new(Semaphore::new(4)),
            command_timeout,
            clone_timeout,
            events: events::EventHub::default(),
            terminals: Mutex::new(terminal::TerminalOwners::default()),
            terminal_journal: Mutex::new(terminal::TerminalJournal::default()),
            socket_counts: Mutex::new(HashMap::new()),
            files: Mutex::new(files::FileAccess::empty()),
            consoles: Mutex::new(consoles::ConsoleLeases::default()),
            browsers: Mutex::new(browser::BrowserLeases::default()),
            preferences: Mutex::new(preferences::Snapshot::default()),
            preference_waiters: Mutex::new(HashMap::new()),
        }
    }

    pub(crate) fn enabled(&self) -> bool {
        self.config.enabled
    }
    pub(crate) fn is_ready(&self) -> bool {
        self.ready.load(Ordering::SeqCst)
    }
    pub(crate) fn session_revocations(&self) -> tokio::sync::broadcast::Receiver<String> {
        self.session_revocations.subscribe()
    }
    pub(crate) fn revoke_session(&self, session: &str) -> Result<(), &'static str> {
        lock(&self.sessions).remove(session)?;
        self.release_session_resources(session);
        Ok(())
    }

    fn release_session_resources(&self, session: &str) {
        // Request identities are scoped by the unguessable session id. Once the session has been
        // revoked it can no longer retry, so its permanent uncertain tombstones may be reclaimed
        // without making a live mutation replayable.
        lock(&self.dedupe).remove_session(session);
        lock(&self.socket_counts).remove(session);
        self.close_session_terminals(session);
        lock(&self.files).release_session(session);
        lock(&self.consoles).release_session(session);
        let browsers = lock(&self.browsers).release_session(session);
        for lease in browsers {
            let broker = self.broker.clone();
            tauri::async_runtime::spawn(async move {
                let _ = broker
                    .browser(browser::NativeRequest::Close { label: lease.label })
                    .await;
            });
        }
        let _ = self.session_revocations.send(session.to_owned());
    }
    fn close_session_terminals(&self, session: &str) {
        let terminals = lock(&self.terminals).begin_close_session(session);
        for terminal_id in terminals {
            // This is a direct native close, not a fire-and-forget main-webview event. Keep the
            // closing owner record when native teardown fails, so the PTY never becomes an
            // untracked process and no later session can claim or write it.
            let native_closed = self.broker.terminal_close(&terminal_id).is_ok();
            if native_closed
                && lock(&self.terminals)
                    .finish_close(&terminal_id, session)
                    .is_ok()
            {
                lock(&self.terminal_journal).remove(&terminal_id);
            }
        }
    }

    fn record_native_event(&self, name: &str, mut payload: serde_json::Value) {
        if name == "terminal-event" {
            if let Some(sequence) = lock(&self.terminal_journal).append_event(&payload) {
                if let Some(object) = payload.as_object_mut() {
                    object.insert("terminalSequence".into(), sequence.into());
                }
            }
        }
        self.events.push(name, payload);
    }
    pub(crate) fn socket_open(&self, session: &str) {
        let mut counts = lock(&self.socket_counts);
        let state = counts.entry(session.to_owned()).or_default();
        state.count = state.count.saturating_add(1);
        state.epoch = state.epoch.wrapping_add(1);
    }
    pub(crate) fn socket_closed(self: &Arc<Self>, session: String) {
        let epoch = {
            let mut counts = lock(&self.socket_counts);
            let Some(state) = counts.get_mut(&session) else {
                return;
            };
            state.count = state.count.saturating_sub(1);
            if state.count == 0 {
                Some(state.epoch)
            } else {
                None
            }
        };
        if let Some(epoch) = epoch {
            let gateway = self.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(TERMINAL_RECONNECT_GRACE).await;
                let should_close = lock(&gateway.socket_counts)
                    .get(&session)
                    .is_some_and(|state| state.count == 0 && state.epoch == epoch);
                if should_close {
                    gateway.close_session_terminals(&session);
                    lock(&gateway.socket_counts).remove(&session);
                }
            });
        }
    }
    fn set_address(&self, address: SocketAddr) {
        *lock(&self.address) = Some(address);
    }

    fn timeout_for(&self, command: &str) -> Duration {
        if command == "github_clone_repo" {
            self.clone_timeout
        } else {
            self.command_timeout
        }
    }

    pub(crate) async fn dispatch(
        &self,
        session_id: &str,
        policy: &'static CommandPolicy,
        mut args: serde_json::Value,
        request_id: Option<&str>,
    ) -> Result<serde_json::Value, DispatchFailure> {
        if policy.exposure == Exposure::Blocked {
            return Err(DispatchFailure::Blocked(policy.reason));
        }
        if !self.is_ready() {
            return Err(DispatchFailure::NotReady);
        }
        if serde_json::to_vec(&args)
            .map_err(|_| DispatchFailure::BadRequest("invalid command arguments"))?
            .len()
            > commands::MAX_JSON_BYTES
        {
            return Err(DispatchFailure::BadRequest(
                "command arguments exceed limit",
            ));
        }
        self.guard_before(session_id, policy.guard, &args)?;
        let terminal_id = matches!(policy.guard, Guard::TerminalUse | Guard::TerminalClose)
            .then(|| commands::terminal_id(&args).map(str::to_owned))
            .transpose()
            .map_err(DispatchFailure::BadRequest)?;
        let dedupe_key = request_id
            .filter(|id| valid_request_id(id))
            .map(|request| DedupeKey {
                session: session_id.to_owned(),
                command: policy.name.to_owned(),
                request: request.to_owned(),
                fingerprint: fingerprint(&args),
            });
        if (policy.guard == Guard::Decision || policy.mutation) && dedupe_key.is_none() {
            return Err(DispatchFailure::BadRequest("x-request-id required"));
        }
        let id = auth::random_token().map_err(|_| DispatchFailure::Internal)?;
        let _permit = self
            .admission
            .clone()
            .try_acquire_owned()
            .map_err(|_| DispatchFailure::Busy)?;
        if let Some(key) = &dedupe_key {
            if let Some(result) = self.dedupe_claim(key)? {
                return result;
            }
        }
        let terminal_create_permit = if policy.guard == Guard::TerminalCreate {
            match self.terminal_create_admission.clone().try_acquire_owned() {
                Ok(permit) => Some(permit),
                Err(_) => {
                    if let Some(key) = &dedupe_key {
                        lock(&self.dedupe).remove(key);
                    }
                    return Err(DispatchFailure::Busy);
                }
            }
        } else {
            None
        };
        let uploads = match self.materialize_grants(session_id, policy, &mut args) {
            Ok(uploads) => uploads,
            Err(error) => {
                if let Some(key) = &dedupe_key {
                    lock(&self.dedupe).remove(key);
                }
                return Err(error);
            }
        };
        let (sender, receiver) = oneshot::channel();
        lock(&self.pending).insert(
            id.clone(),
            Pending {
                sender,
                session_id: session_id.to_owned(),
                policy,
                dedupe: dedupe_key.clone(),
                terminal_id,
                uploads,
                terminal_create_permit,
            },
        );
        let emitted = self.broker.command(BrokerRequest {
            id: id.clone(),
            command: policy.name.to_owned(),
            args,
        });
        if emitted.is_err() {
            if let Some(pending) = lock(&self.pending).remove(&id) {
                let mut files = lock(&self.files);
                for upload in pending.uploads {
                    files.release_upload(upload);
                }
            }
            if let Some(key) = dedupe_key {
                lock(&self.dedupe).remove(&key);
            }
            return Err(DispatchFailure::NotReady);
        }
        match tokio::time::timeout(self.timeout_for(policy.name), receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(DispatchFailure::Internal),
            Err(_) => {
                // Hold the late-result map while removing a terminal-create pending record. A
                // concurrent resolver can therefore observe either the original pending request
                // or its cleanup tombstone, never the gap between them.
                let mut late = lock(&self.late_terminal_creates);
                let mut pending = lock(&self.pending).remove(&id);
                if let Some(pending) = pending.as_mut() {
                    let mut files = lock(&self.files);
                    for upload in pending.uploads.drain(..) {
                        files.retire_upload(upload);
                    }
                    if pending.policy.guard == Guard::TerminalCreate {
                        if let Some(permit) = pending.terminal_create_permit.take() {
                            late.insert(
                                id,
                                LateTerminalCreate {
                                    session_id: pending.session_id.clone(),
                                    _permit: permit,
                                },
                            );
                        }
                    }
                }
                drop(late);
                if let Some(key) = dedupe_key {
                    self.dedupe_uncertain(key);
                }
                Err(DispatchFailure::Timeout)
            }
        }
    }

    fn guard_before(
        &self,
        session: &str,
        guard: Guard,
        args: &serde_json::Value,
    ) -> Result<(), DispatchFailure> {
        match guard {
            Guard::RelativePath => files::validate_relative_arg(args, "path", false)
                .map_err(DispatchFailure::BadRequest),
            Guard::OptionalRelativePath => files::validate_relative_arg(args, "path", true)
                .map_err(DispatchFailure::BadRequest),
            Guard::RelativePaths => {
                files::validate_relative_args(args, "paths").map_err(DispatchFailure::BadRequest)
            }
            Guard::InlineOrGrantedImage => {
                match args.get("path").and_then(serde_json::Value::as_str) {
                    Some(path) if path.starts_with("webgrant_") => Ok(()),
                    _ => files::validate_inline_image(args).map_err(DispatchFailure::BadRequest),
                }
            }
            Guard::UiAction => {
                commands::validate_ui_action(args).map_err(DispatchFailure::BadRequest)
            }
            Guard::GrantedPath | Guard::GrantedPaths => Ok(()),
            Guard::TerminalUse | Guard::TerminalClose => lock(&self.terminals)
                .check(
                    commands::terminal_id(args).map_err(DispatchFailure::BadRequest)?,
                    session,
                )
                .map_err(|_| DispatchFailure::Forbidden),
            Guard::None | Guard::TerminalCreate | Guard::Decision => Ok(()),
        }
    }

    fn materialize_grants(
        &self,
        session: &str,
        policy: &'static CommandPolicy,
        args: &mut serde_json::Value,
    ) -> Result<Vec<files::Upload>, DispatchFailure> {
        let mut uploads = Vec::new();
        let mut access = lock(&self.files);
        match policy.guard {
            Guard::GrantedPath => {
                // An empty executable asks the native provider to return to automatic discovery;
                // only a custom host executable path requires an opaque file grant.
                if provider_executable_reset(policy.name, args) {
                    return Ok(uploads);
                }
                let field = if policy.name == "github_clone_repo" {
                    "parent"
                } else {
                    "path"
                };
                let token = args
                    .get(field)
                    .and_then(serde_json::Value::as_str)
                    .ok_or(DispatchFailure::BadRequest("file grant required"))?;
                let selected = access
                    .materialize(session, policy.name, token)
                    .map_err(DispatchFailure::BadRequest)?;
                args[field] =
                    serde_json::Value::String(selected.path.to_string_lossy().into_owned());
                if let Some(upload) = selected.upload {
                    uploads.push(upload);
                }
            }
            Guard::GrantedPaths => {
                let tokens = args
                    .get("paths")
                    .and_then(serde_json::Value::as_array)
                    .ok_or(DispatchFailure::BadRequest("file grants required"))?
                    .iter()
                    .map(|value| {
                        value
                            .as_str()
                            .ok_or(DispatchFailure::BadRequest("file grants required"))
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                let selected = access
                    .materialize_many(session, policy.name, &tokens)
                    .map_err(DispatchFailure::BadRequest)?;
                let mut paths = Vec::with_capacity(selected.len());
                for selected in selected {
                    paths.push(serde_json::Value::String(
                        selected.path.to_string_lossy().into_owned(),
                    ));
                    if let Some(upload) = selected.upload {
                        uploads.push(upload);
                    }
                }
                args["paths"] = serde_json::Value::Array(paths);
            }
            Guard::InlineOrGrantedImage => {
                if let Some(token) = args
                    .get("path")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned)
                    .filter(|path| path.starts_with("webgrant_"))
                {
                    let selected = access
                        .materialize(session, policy.name, &token)
                        .map_err(DispatchFailure::BadRequest)?;
                    args["path"] =
                        serde_json::Value::String(selected.path.to_string_lossy().into_owned());
                    if let Some(upload) = selected.upload {
                        uploads.push(upload);
                    }
                }
            }
            _ => {}
        }
        Ok(uploads)
    }

    /// Checks and claims a request ID while holding one lock so concurrent requests cannot both
    /// pass the lookup before either records its in-flight state.
    fn dedupe_claim(
        &self,
        key: &DedupeKey,
    ) -> Result<Option<Result<serde_json::Value, DispatchFailure>>, DispatchFailure> {
        // An idle expired session may have no WebSocket tick or follow-up HTTP request to trigger
        // normal revocation. Reap it before admission so its permanent uncertain identities cannot
        // consume the global cap forever. Revocation also closes its other session-owned resources.
        let expired = lock(&self.sessions).remove_expired(Instant::now());
        for session in expired {
            let _ = self.revoke_session(&session);
        }

        // Keep the session lock until the identity is claimed. Revocation follows the same
        // session-then-dedupe lock order, so it either clears this claim or happens before it; a
        // revoked session can never recreate a request identity after cleanup.
        let sessions = lock(&self.sessions);
        if sessions.authenticate(&key.session, Instant::now()).is_err() {
            return Err(DispatchFailure::Forbidden);
        }
        lock(&self.dedupe).claim(key)
    }

    fn dedupe_complete(
        &self,
        key: DedupeKey,
        result: Result<serde_json::Value, DispatchFailure>,
        ttl: Duration,
    ) {
        // Hold the session lock through the dedupe write. Revocation takes the same lock first and
        // then clears the session's entries, so a late native result cannot resurrect an identity
        // after logout or expiry.
        let sessions = lock(&self.sessions);
        let active = sessions.authenticate(&key.session, Instant::now()).is_ok();
        let mut dedupe = lock(&self.dedupe);
        if active {
            dedupe.complete(key, result, ttl);
        } else {
            dedupe.remove(&key);
        }
    }

    fn dedupe_uncertain(&self, key: DedupeKey) {
        let sessions = lock(&self.sessions);
        let active = sessions.authenticate(&key.session, Instant::now()).is_ok();
        let mut dedupe = lock(&self.dedupe);
        if active {
            dedupe.uncertain(key);
        } else {
            dedupe.remove(&key);
        }
    }

    fn resolve(
        &self,
        id: &str,
        result: Option<serde_json::Value>,
        error: Option<serde_json::Value>,
    ) {
        let pending = { lock(&self.pending).remove(id) };
        let Some(pending) = pending else {
            if let Some(late) = lock(&self.late_terminal_creates).remove(id) {
                if error.is_none() {
                    if let Some(terminal) = result.as_ref().and_then(serde_json::Value::as_str) {
                        self.close_created_terminal(terminal, &late.session_id);
                    }
                }
            }
            return;
        };
        let mut outcome = if error.is_some() {
            Err(DispatchFailure::CommandFailed)
        } else {
            Ok(result.unwrap_or(serde_json::Value::Null))
        };
        if let Ok(value) = &outcome {
            let valid = match pending.policy.exposure {
                Exposure::BinaryBroker => commands::validate_binary_envelope(value)
                    .map_err(|_| DispatchFailure::ResponseTooLarge),
                Exposure::Broker => serde_json::to_vec(value)
                    .map_err(|_| DispatchFailure::Internal)
                    .and_then(|bytes| {
                        if bytes.len() <= commands::MAX_RESPONSE_BYTES {
                            Ok(())
                        } else {
                            Err(DispatchFailure::ResponseTooLarge)
                        }
                    }),
                Exposure::Blocked => Err(DispatchFailure::Blocked(pending.policy.reason)),
            };
            if let Err(error) = valid {
                outcome = Err(error);
            }
        }
        if pending.policy.guard == Guard::TerminalCreate && outcome.is_ok() {
            let terminal = outcome
                .as_ref()
                .ok()
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned);
            outcome = terminal
                .ok_or(DispatchFailure::CommandFailed)
                .and_then(|terminal| {
                    // Session validity and owner creation are one ordered critical section.
                    // Revocation takes the session lock before closing owners, so it either sees
                    // this new terminal or wins first and forces immediate native cleanup below.
                    let sessions = lock(&self.sessions);
                    if sessions
                        .authenticate(&pending.session_id, Instant::now())
                        .is_err()
                    {
                        drop(sessions);
                        self.close_created_terminal(&terminal, &pending.session_id);
                        return Err(DispatchFailure::Forbidden);
                    }
                    let claimed = lock(&self.terminals).claim(&terminal, &pending.session_id);
                    drop(sessions);
                    if claimed.is_ok() {
                        if lock(&self.terminal_journal).reserve(&terminal).is_ok() {
                            Ok(serde_json::Value::String(terminal))
                        } else {
                            self.close_created_terminal(&terminal, &pending.session_id);
                            Err(DispatchFailure::Busy)
                        }
                    } else {
                        self.close_created_terminal(&terminal, &pending.session_id);
                        Err(DispatchFailure::Conflict("terminal already owned"))
                    }
                });
        } else if pending.policy.guard == Guard::TerminalClose && outcome.is_ok() {
            if let Some(terminal) = &pending.terminal_id {
                if lock(&self.terminals)
                    .release(terminal, &pending.session_id)
                    .is_ok()
                {
                    lock(&self.terminal_journal).remove(terminal);
                }
            }
        }
        let dedupe = pending.dedupe.clone();
        if let Some(key) = dedupe.clone() {
            self.dedupe_complete(key, outcome.clone(), DEDUPE_TTL);
        }
        {
            let mut files = lock(&self.files);
            for upload in pending.uploads {
                files.release_upload(upload);
            }
        }
        if let Err(undelivered) = pending.sender.send(outcome) {
            // A timeout can drop the receiver just after resolve removes Pending but before this
            // send. If native creation succeeded, close the now-unobservable PTY and keep the
            // request identity uncertain rather than replaying a stale terminal id.
            if pending.policy.guard == Guard::TerminalCreate {
                if let Ok(serde_json::Value::String(terminal)) = &undelivered {
                    self.close_created_terminal(terminal, &pending.session_id);
                }
            }
            if let Some(key) = dedupe {
                self.dedupe_uncertain(key);
            }
        }
    }

    /// Adopts a native terminal into a durable closing state before teardown. A failed native
    /// close keeps the owner and closing marker, preventing future writes or another session from
    /// claiming a still-live PTY.
    fn close_created_terminal(&self, terminal_id: &str, session: &str) {
        let marked = {
            let mut terminals = lock(&self.terminals);
            terminals.adopt_closing(terminal_id, session).is_ok()
        };
        if marked
            && self.broker.terminal_close(terminal_id).is_ok()
            && lock(&self.terminals)
                .finish_close(terminal_id, session)
                .is_ok()
        {
            lock(&self.terminal_journal).remove(terminal_id);
        }
    }

    pub(crate) async fn request_preferences(
        &self,
        preferences: preferences::PreferenceMap,
    ) -> Result<preferences::Snapshot, DispatchFailure> {
        if !self.is_ready() {
            return Err(DispatchFailure::NotReady);
        }
        let preferences =
            preferences::sanitize(preferences).map_err(DispatchFailure::BadRequest)?;
        let id = auth::random_token().map_err(|_| DispatchFailure::Internal)?;
        let (sender, receiver) = oneshot::channel();
        lock(&self.preference_waiters).insert(id.clone(), sender);
        if self.broker.preferences(&id, &preferences).is_err() {
            lock(&self.preference_waiters).remove(&id);
            return Err(DispatchFailure::NotReady);
        }
        match tokio::time::timeout(self.command_timeout, receiver).await {
            Ok(Ok(snapshot)) => Ok(snapshot),
            _ => {
                lock(&self.preference_waiters).remove(&id);
                Err(DispatchFailure::Timeout)
            }
        }
    }

    pub(crate) async fn read_document(
        &self,
        request: documents::DocumentRequest,
    ) -> Result<Vec<u8>, DispatchFailure> {
        request
            .validate()
            .map_err(|_| DispatchFailure::BadRequest("invalid document request"))?;
        match tokio::time::timeout(self.command_timeout, self.broker.document(request)).await {
            Ok(Ok(bytes)) if bytes.len() <= documents::MAX_BYTES => Ok(bytes),
            Ok(Ok(_)) => Err(DispatchFailure::ResponseTooLarge),
            Ok(Err(_)) => Err(DispatchFailure::CommandFailed),
            Err(_) => Err(DispatchFailure::Timeout),
        }
    }

    fn direct_key(
        &self,
        session: &str,
        operation: &str,
        request_id: &str,
        payload: &serde_json::Value,
    ) -> Result<DedupeKey, DispatchFailure> {
        if !valid_request_id(request_id) {
            return Err(DispatchFailure::BadRequest("valid x-request-id required"));
        }
        Ok(DedupeKey {
            session: session.to_owned(),
            command: operation.to_owned(),
            request: request_id.to_owned(),
            fingerprint: fingerprint(payload),
        })
    }

    fn finish_direct(
        &self,
        key: DedupeKey,
        result: Result<serde_json::Value, DispatchFailure>,
    ) -> Result<serde_json::Value, DispatchFailure> {
        self.finish_direct_for(key, result, DEDUPE_TTL)
    }

    fn finish_direct_for(
        &self,
        key: DedupeKey,
        result: Result<serde_json::Value, DispatchFailure>,
        ttl: Duration,
    ) -> Result<serde_json::Value, DispatchFailure> {
        self.dedupe_complete(key, result.clone(), ttl);
        result
    }

    pub(crate) async fn open_console(
        &self,
        session: &str,
        request: consoles::OpenRequest,
        request_id: &str,
    ) -> Result<serde_json::Value, DispatchFailure> {
        request.validate().map_err(DispatchFailure::BadRequest)?;
        let key = self.direct_key(
            session,
            "web_console_open",
            request_id,
            &json!({"kind": request.kind, "target": &request.target, "control": request.control}),
        )?;
        if let Some(result) = self.dedupe_claim(&key)? {
            return result;
        }
        let _permit = match self.console_admission.clone().try_acquire_owned() {
            Ok(permit) => permit,
            Err(_) => {
                lock(&self.dedupe).remove(&key);
                return Err(DispatchFailure::Busy);
            }
        };
        let validated = tokio::time::timeout(
            self.command_timeout,
            self.broker
                .console_validate(request.kind, request.target.clone()),
        )
        .await;
        let result = match validated {
            Ok(Ok(())) => {
                // Keep session validity and lease insertion under the same lock order used by
                // revocation (sessions, then consoles). A delayed validator can never recreate a
                // lease after logout has cleared that session's resources.
                let sessions = lock(&self.sessions);
                if sessions.authenticate(session, Instant::now()).is_err() {
                    Err(DispatchFailure::Forbidden)
                } else {
                    lock(&self.consoles)
                        .open(session, &request)
                        .map_err(|reason| {
                            if reason == "console lease limit reached" {
                                DispatchFailure::Busy
                            } else {
                                DispatchFailure::Conflict(reason)
                            }
                        })
                        .and_then(|info| {
                            serde_json::to_value(info).map_err(|_| DispatchFailure::Internal)
                        })
                }
            }
            Ok(Err(_)) => Err(DispatchFailure::CommandFailed),
            Err(_) => Err(DispatchFailure::Timeout),
        };
        // Never replay an open response after its lease may have expired.
        self.finish_direct_for(key, result, consoles::LEASE_TTL)
    }

    pub(crate) async fn console_frame(
        &self,
        session: &str,
        lease_id: &str,
        after: u64,
    ) -> Result<(consoles::Frame, u64), DispatchFailure> {
        if lease_id.len() > 128 {
            return Err(DispatchFailure::BadRequest("invalid console lease"));
        }
        let (lease, expires_at) = lock(&self.consoles)
            .use_lease(session, lease_id, false)
            .map_err(|_| DispatchFailure::Forbidden)?;
        let _permit = self
            .console_admission
            .clone()
            .try_acquire_owned()
            .map_err(|_| DispatchFailure::Busy)?;
        match tokio::time::timeout(
            self.command_timeout,
            self.broker.console_frame(lease.kind, lease.target, after),
        )
        .await
        {
            Ok(Ok(frame)) if frame.bytes.len() <= consoles::FRAME_LIMIT => Ok((frame, expires_at)),
            Ok(Ok(_)) => Err(DispatchFailure::ResponseTooLarge),
            Ok(Err(_)) => Err(DispatchFailure::CommandFailed),
            Err(_) => Err(DispatchFailure::Timeout),
        }
    }

    pub(crate) async fn console_input(
        &self,
        session: &str,
        request: consoles::InputRequest,
        request_id: &str,
    ) -> Result<serde_json::Value, DispatchFailure> {
        if request.lease.len() > 128 {
            return Err(DispatchFailure::BadRequest("invalid console lease"));
        }
        let key = self.direct_key(
            session,
            "web_console_input",
            request_id,
            &json!({"lease": &request.lease, "input": &request.input}),
        )?;
        if let Some(result) = self.dedupe_claim(&key)? {
            return result;
        }
        let (lease, expires_at) =
            match lock(&self.consoles).use_lease(session, &request.lease, true) {
                Ok(lease) => lease,
                Err(_) => return self.finish_direct(key, Err(DispatchFailure::Forbidden)),
            };
        if let Err(reason) = consoles::validate_input(lease.kind, &request.input) {
            return self.finish_direct(key, Err(DispatchFailure::BadRequest(reason)));
        }
        let _permit = match self.console_admission.clone().try_acquire_owned() {
            Ok(permit) => permit,
            Err(_) => {
                lock(&self.dedupe).remove(&key);
                return Err(DispatchFailure::Busy);
            }
        };
        match tokio::time::timeout(
            self.command_timeout,
            self.broker
                .console_input(lease.kind, lease.target, request.input),
        )
        .await
        {
            Ok(Ok(result)) => self.finish_direct(
                key,
                serde_json::to_value(consoles::InputResult { result, expires_at })
                    .map_err(|_| DispatchFailure::Internal),
            ),
            Ok(Err(_)) => self.finish_direct(key, Err(DispatchFailure::CommandFailed)),
            Err(_) => {
                self.dedupe_uncertain(key);
                Err(DispatchFailure::Timeout)
            }
        }
    }

    pub(crate) async fn console_lifecycle(
        &self,
        session: &str,
        request: console_lifecycle::Request,
        request_id: &str,
    ) -> Result<serde_json::Value, DispatchFailure> {
        if request.lease.len() > 128 {
            return Err(DispatchFailure::BadRequest("invalid console lease"));
        }
        let key = self.direct_key(
            session,
            "web_console_lifecycle",
            request_id,
            &json!({"lease": &request.lease, "action": &request.action}),
        )?;
        if let Some(result) = self.dedupe_claim(&key)? {
            return result;
        }
        let (lease, expires_at) =
            match lock(&self.consoles).use_lease(session, &request.lease, true) {
                Ok(v) => v,
                Err(_) => return self.finish_direct(key, Err(DispatchFailure::Forbidden)),
            };
        if let Err(reason) = request.action.validate_for(&lease) {
            return self.finish_direct(key, Err(DispatchFailure::BadRequest(reason)));
        }
        let timeout = request.action.timeout();
        let _permit = match self.console_admission.clone().try_acquire_owned() {
            Ok(v) => v,
            Err(_) => {
                lock(&self.dedupe).remove(&key);
                return Err(DispatchFailure::Busy);
            }
        };
        match tokio::time::timeout(
            timeout,
            self.broker.console_lifecycle(lease, request.action),
        )
        .await
        {
            Ok(Ok(result)) => self.finish_direct(
                key,
                Ok(serde_json::json!({"result":result,"expiresAt":expires_at})),
            ),
            Ok(Err(_)) => self.finish_direct(key, Err(DispatchFailure::CommandFailed)),
            Err(_) => {
                self.dedupe_uncertain(key);
                Err(DispatchFailure::Timeout)
            }
        }
    }

    pub(crate) async fn console_capture(
        &self,
        session: &str,
        lease_id: &str,
    ) -> Result<Vec<u8>, DispatchFailure> {
        if lease_id.len() > 128 {
            return Err(DispatchFailure::BadRequest("invalid console lease"));
        }
        let (lease, _) = lock(&self.consoles)
            .use_lease(session, lease_id, false)
            .map_err(|_| DispatchFailure::Forbidden)?;
        let _permit = self
            .console_admission
            .clone()
            .try_acquire_owned()
            .map_err(|_| DispatchFailure::Busy)?;
        match tokio::time::timeout(self.command_timeout, self.broker.console_capture(lease)).await {
            Ok(Ok(bytes)) if bytes.len() <= console_lifecycle::CAPTURE_LIMIT => Ok(bytes),
            Ok(Ok(_)) => Err(DispatchFailure::ResponseTooLarge),
            Ok(Err(_)) => Err(DispatchFailure::CommandFailed),
            Err(_) => Err(DispatchFailure::Timeout),
        }
    }

    pub(crate) async fn dock_action(
        &self,
        session: &str,
        request: dock::Request,
        request_id: &str,
    ) -> Result<serde_json::Value, DispatchFailure> {
        if matches!(&request.action, dock::Action::Pin) {
            return Err(DispatchFailure::Blocked(
                "native dock pinning creates an operating-system window and is unavailable in the web UI",
            ));
        }
        let dock_payload = match &request.action {
            dock::Action::Save {
                enabled,
                keep_on_screen,
            } => json!({"action":"save","enabled":enabled,"keepOnScreen":keep_on_screen}),
            dock::Action::Pin => json!({"action":"pin"}),
        };
        let key = self.direct_key(session, "web_dock_preferences", request_id, &dock_payload)?;
        if let Some(result) = self.dedupe_claim(&key)? {
            return result;
        }
        match tokio::time::timeout(self.command_timeout, self.broker.dock(request.action)).await {
            Ok(Ok(value)) => self.finish_direct(key, Ok(value)),
            Ok(Err(_)) => self.finish_direct(key, Err(DispatchFailure::CommandFailed)),
            Err(_) => {
                self.dedupe_uncertain(key);
                Err(DispatchFailure::Timeout)
            }
        }
    }

    pub(crate) fn close_console(
        &self,
        session: &str,
        lease: &str,
        request_id: &str,
    ) -> Result<serde_json::Value, DispatchFailure> {
        if lease.len() > 128 {
            return Err(DispatchFailure::BadRequest("invalid console lease"));
        }
        let key = self.direct_key(
            session,
            "web_console_close",
            request_id,
            &json!({"lease": lease}),
        )?;
        if let Some(result) = self.dedupe_claim(&key)? {
            return result;
        }
        let result = lock(&self.consoles)
            .close(session, lease)
            .map(|_| serde_json::Value::Null)
            .map_err(|_| DispatchFailure::Forbidden);
        self.finish_direct(key, result)
    }

    pub(crate) async fn open_browser(
        self: &Arc<Self>,
        session: &str,
        request: browser::OpenRequest,
        request_id: &str,
    ) -> Result<serde_json::Value, DispatchFailure> {
        request.validate().map_err(DispatchFailure::BadRequest)?;
        self.purge_browsers();
        let key = self.direct_key(session, "web_browser_open", request_id, &json!({"url": &request.url, "taskId": &request.task_id, "sessionId": &request.session_id}))?;
        if let Some(result) = self.dedupe_claim(&key)? {
            return result;
        }
        let _permit = match self.browser_admission.clone().try_acquire_owned() {
            Ok(v) => v,
            Err(_) => {
                lock(&self.dedupe).remove(&key);
                return Err(DispatchFailure::Busy);
            }
        };
        let lease = match lock(&self.browsers).reserve(session) {
            Ok(v) => v,
            Err(e) => {
                return self.finish_direct(
                    key,
                    Err(if e.contains("limit") {
                        DispatchFailure::Busy
                    } else {
                        DispatchFailure::Internal
                    }),
                )
            }
        };
        let mut opened = false;
        let result = match tokio::time::timeout(
            self.command_timeout,
            self.broker.browser(browser::NativeRequest::Open {
                label: lease.label.clone(),
                url: request.url,
            }),
        )
        .await
        {
            Ok(Ok(browser::NativeResponse::Status(status))) => {
                opened = true;
                if lock(&self.browsers).use_lease(session, &lease.id).is_err() {
                    Err(DispatchFailure::Forbidden)
                } else {
                    serde_json::to_value(browser::OpenResponse {
                        lease: lease.id.clone(),
                        expires_at: auth::unix_seconds() + browser::LEASE_TTL.as_secs(),
                        status: status.into(),
                    })
                    .map_err(|_| DispatchFailure::Internal)
                }
            }
            Ok(Err(_)) => Err(DispatchFailure::CommandFailed),
            Err(_) => Err(DispatchFailure::Timeout),
            _ => Err(DispatchFailure::Internal),
        };
        if result.is_err() {
            lock(&self.browsers).remove_id(&lease.id);
            let _ = tokio::time::timeout(
                self.command_timeout,
                self.broker.browser(browser::NativeRequest::Close {
                    label: lease.label.clone(),
                }),
            )
            .await;
        } else if opened {
            let gateway = self.clone();
            let id = lease.id.clone();
            tauri::async_runtime::spawn(async move {
                gateway.expire_browser(id).await;
            });
        }
        self.finish_direct_for(key, result, browser::LEASE_TTL)
    }
    async fn browser_lease(
        &self,
        session: &str,
        id: &str,
    ) -> Result<(browser::Lease, u64), DispatchFailure> {
        self.purge_browsers();
        if id.len() > 128 {
            return Err(DispatchFailure::BadRequest("invalid browser lease"));
        }
        lock(&self.browsers)
            .use_lease(session, id)
            .map_err(|_| DispatchFailure::Forbidden)
    }
    fn purge_browsers(&self) {
        for lease in lock(&self.browsers).purge_expired() {
            let broker = self.broker.clone();
            tauri::async_runtime::spawn(async move {
                let _ = broker
                    .browser(browser::NativeRequest::Close { label: lease.label })
                    .await;
            });
        }
    }
    async fn expire_browser(self: Arc<Self>, id: String) {
        loop {
            let expiry = lock(&self.browsers).expiry(&id);
            match expiry {
                browser::Expiry::Missing => return,
                browser::Expiry::Wait(wait) => tokio::time::sleep(wait).await,
                browser::Expiry::Expired(lease) => {
                    let _ = self
                        .broker
                        .browser(browser::NativeRequest::Close { label: lease.label })
                        .await;
                    return;
                }
            }
        }
    }
    pub(crate) async fn browser_status(
        &self,
        session: &str,
        id: &str,
    ) -> Result<(browser::Status, u64), DispatchFailure> {
        let (lease, expires) = self.browser_lease(session, id).await?;
        match tokio::time::timeout(
            self.command_timeout,
            self.broker
                .browser(browser::NativeRequest::Status { label: lease.label }),
        )
        .await
        {
            Ok(Ok(browser::NativeResponse::Status(v))) => Ok((v.into(), expires)),
            Ok(Err(_)) => Err(DispatchFailure::CommandFailed),
            Err(_) => Err(DispatchFailure::Timeout),
            _ => Err(DispatchFailure::Internal),
        }
    }
    pub(crate) async fn browser_frame(
        &self,
        session: &str,
        id: &str,
    ) -> Result<(browser::Frame, u64), DispatchFailure> {
        let (lease, expires) = self.browser_lease(session, id).await?;
        let _permit = self
            .browser_admission
            .clone()
            .try_acquire_owned()
            .map_err(|_| DispatchFailure::Busy)?;
        match tokio::time::timeout(
            self.command_timeout,
            self.broker
                .browser(browser::NativeRequest::Frame { label: lease.label }),
        )
        .await
        {
            Ok(Ok(browser::NativeResponse::Frame(v))) if v.bytes.len() <= browser::FRAME_LIMIT => {
                Ok((
                    browser::Frame {
                        bytes: v.bytes,
                        width: v.width,
                        height: v.height,
                        sequence: v.sequence,
                    },
                    expires,
                ))
            }
            Ok(Ok(_)) => Err(DispatchFailure::ResponseTooLarge),
            Ok(Err(_)) => Err(DispatchFailure::CommandFailed),
            Err(_) => Err(DispatchFailure::Timeout),
        }
    }
    pub(crate) async fn browser_operation(
        &self,
        session: &str,
        id: &str,
        operation: &str,
        payload: serde_json::Value,
        request_id: &str,
    ) -> Result<serde_json::Value, DispatchFailure> {
        let key = self.direct_key(session, operation, request_id, &payload)?;
        if let Some(v) = self.dedupe_claim(&key)? {
            return v;
        }
        let (lease, _) = match self.browser_lease(session, id).await {
            Ok(v) => v,
            Err(e) => return self.finish_direct(key, Err(e)),
        };
        let native = (|| -> Result<browser::NativeRequest, DispatchFailure> {
            Ok(match operation {
                "web_browser_action" => {
                    let v: browser::ActionRequest = serde_json::from_value(payload)
                        .map_err(|_| DispatchFailure::BadRequest("invalid browser action"))?;
                    v.validate().map_err(DispatchFailure::BadRequest)?;
                    browser::NativeRequest::Action {
                        label: lease.label,
                        request: v,
                    }
                }
                "web_browser_input" => {
                    let v: browser::InputRequest = serde_json::from_value(payload.clone())
                        .map_err(|_| DispatchFailure::BadRequest("invalid browser input"))?;
                    v.validate().map_err(DispatchFailure::BadRequest)?;
                    browser::NativeRequest::Input {
                        label: lease.label,
                        input: payload,
                    }
                }
                "web_browser_inspect" => {
                    let v: browser::InspectRequest = serde_json::from_value(payload)
                        .map_err(|_| DispatchFailure::BadRequest("invalid browser inspection"))?;
                    v.validate().map_err(DispatchFailure::BadRequest)?;
                    browser::NativeRequest::Inspect {
                        label: lease.label,
                        request: v,
                    }
                }
                "web_browser_pick" => {
                    let v: browser::PickRequest = serde_json::from_value(payload)
                        .map_err(|_| DispatchFailure::BadRequest("invalid browser coordinates"))?;
                    v.validate().map_err(DispatchFailure::BadRequest)?;
                    browser::NativeRequest::Pick {
                        label: lease.label,
                        x: v.x,
                        y: v.y,
                    }
                }
                _ => return Err(DispatchFailure::BadRequest("invalid browser operation")),
            })
        })();
        let native = match native {
            Ok(value) => value,
            Err(error) => return self.finish_direct(key, Err(error)),
        };
        match tokio::time::timeout(self.command_timeout, self.broker.browser(native)).await {
            Ok(Ok(browser::NativeResponse::Status(v))) => self.finish_direct(
                key,
                serde_json::to_value(browser::Status::from(v))
                    .map_err(|_| DispatchFailure::Internal),
            ),
            Ok(Ok(browser::NativeResponse::Value(v))) => {
                self.finish_direct(key, bounded_response_value(v))
            }
            Ok(Err(_)) => self.finish_direct(key, Err(DispatchFailure::CommandFailed)),
            Err(_) => {
                self.dedupe_uncertain(key);
                Err(DispatchFailure::Timeout)
            }
            _ => self.finish_direct(key, Err(DispatchFailure::Internal)),
        }
    }
    pub(crate) async fn close_browser(
        &self,
        session: &str,
        id: &str,
        request_id: &str,
    ) -> Result<(), DispatchFailure> {
        let key = self.direct_key(
            session,
            "web_browser_close",
            request_id,
            &json!({"lease": id}),
        )?;
        if let Some(v) = self.dedupe_claim(&key)? {
            return v.map(|_| ());
        };
        let lease = match lock(&self.browsers).use_lease(session, id) {
            Ok((v, _)) => v,
            Err(_) => {
                return self
                    .finish_direct(key, Err(DispatchFailure::Forbidden))
                    .map(|_| ())
            }
        };
        match tokio::time::timeout(
            self.command_timeout,
            self.broker
                .browser(browser::NativeRequest::Close { label: lease.label }),
        )
        .await
        {
            Ok(Ok(_)) => {
                lock(&self.browsers).remove_id(id);
                self.finish_direct(key, Ok(serde_json::Value::Null))
                    .map(|_| ())
            }
            Ok(Err(_)) => self
                .finish_direct(key, Err(DispatchFailure::CommandFailed))
                .map(|_| ()),
            Err(_) => {
                self.dedupe_uncertain(key);
                Err(DispatchFailure::Timeout)
            }
        }
    }

    fn publish_preferences(
        &self,
        preferences: preferences::PreferenceMap,
        wallpaper_accent_seed: Option<String>,
        request_id: Option<String>,
    ) -> Result<preferences::Snapshot, String> {
        let (snapshot, changed) = {
            let mut current = lock(&self.preferences);
            let revision = current.revision;
            let snapshot = preferences::publish(&mut current, preferences, wallpaper_accent_seed)
                .map_err(str::to_owned)?;
            let changed = snapshot.revision != revision;
            (snapshot, changed)
        };
        if changed {
            self.events.push(
                "web-gateway-preferences-changed",
                serde_json::to_value(&snapshot).unwrap_or(serde_json::Value::Null),
            );
        }
        if let Some(id) = request_id {
            if let Some(sender) = lock(&self.preference_waiters).remove(&id) {
                let _ = sender.send(snapshot.clone());
            }
        }
        Ok(snapshot)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayInfo {
    enabled: bool,
    ready: bool,
    paired: bool,
    origin: Option<String>,
    address: Option<String>,
    version: &'static str,
    session_limit_seconds: Option<u64>,
    password_mode: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingInfo {
    token: String,
    expires_at: u64,
}

#[tauri::command]
pub fn web_gateway_info(state: tauri::State<'_, Arc<Gateway>>) -> GatewayInfo {
    GatewayInfo {
        enabled: state.enabled(),
        ready: state.is_ready(),
        paired: lock(&state.pairing).paired(),
        origin: state.enabled().then(|| state.config.origin.clone()),
        address: lock(&state.address).as_ref().map(ToString::to_string),
        session_limit_seconds: lock(&state.sessions).limit_seconds(),
        password_mode: state.password_hash.is_some(),
        version: env!("CARGO_PKG_VERSION"),
    }
}

#[tauri::command]
pub fn web_gateway_sessions(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<Gateway>>,
) -> Result<Vec<auth::SessionSummary>, String> {
    require_main(&window)?;
    lock(&state.sessions).list(Instant::now())
}

#[tauri::command]
pub fn web_gateway_set_session_limit(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<Gateway>>,
    setting: String,
) -> Result<(), String> {
    require_main(&window)?;
    lock(&state.sessions).set_limit(&setting)
}

#[tauri::command]
pub fn web_gateway_revoke_session(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<Gateway>>,
    id: String,
) -> Result<(), String> {
    require_main(&window)?;
    let active = lock(&state.sessions).revoke_by_id(&id)?;
    if let Some(raw) = active {
        state.release_session_resources(&raw);
    }
    Ok(())
}

#[tauri::command]
pub fn web_gateway_pair(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<Gateway>>,
) -> Result<PairingInfo, String> {
    require_main(&window)?;
    if !state.enabled() {
        return Err("Web gateway is disabled.".into());
    }
    if state.password_hash.is_some() {
        return Err("This instance uses password sign-in.".into());
    }
    let (token, expires_at) = lock(&state.pairing).issue().map_err(str::to_owned)?;
    Ok(PairingInfo { token, expires_at })
}

#[tauri::command]
pub fn web_gateway_ready(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<Gateway>>,
    ready: bool,
) -> Result<(), String> {
    require_main(&window)?;
    state
        .ready
        .store(state.enabled() && ready, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub fn web_gateway_resolve(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<Gateway>>,
    id: String,
    result: Option<serde_json::Value>,
    error: Option<serde_json::Value>,
) -> Result<(), String> {
    require_main(&window)?;
    state.resolve(&id, result, error);
    Ok(())
}

#[tauri::command]
pub fn web_gateway_preferences_publish(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<Gateway>>,
    preferences: preferences::PreferenceMap,
    wallpaper_accent_seed: Option<String>,
    request_id: Option<String>,
) -> Result<preferences::Snapshot, String> {
    require_main(&window)?;
    state.publish_preferences(preferences, wallpaper_accent_seed, request_id)
}

fn require_main(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("Only the main window may control the web gateway.".into())
    }
}

pub fn setup(app: &tauri::AppHandle) -> Result<(), String> {
    let config = Config::from_args()?;
    let projects = app
        .state::<crate::AppState>()
        .store
        .lock()
        .map_err(|error| error.to_string())?
        .projects()?
        .into_iter()
        .map(|project| (project.name, std::path::PathBuf::from(project.path)))
        .collect::<Vec<_>>();
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?
        .join("web-gateway-uploads");
    let files = files::FileAccess::new(&config.root_specs, projects, cache)?;
    let mut gateway = Gateway::new(app.clone(), config.clone(), files);
    if config.enabled {
        if let Some(path) = std::env::var_os("PANDACODE_WEB_PASSWORD_FILE") {
            gateway.password_hash = Some(auth::read_password_file(&config.origin, std::path::Path::new(&path))?);
        }
    }
    if config.enabled {
        let setting = std::env::var("PANDACODE_WEB_SESSION_LIMIT").or_else(|error| match error {
            std::env::VarError::NotPresent => Ok("12h".to_owned()),
            _ => Err("PANDACODE_WEB_SESSION_LIMIT must be valid text."),
        })?;
        let ttl = auth::session_ttl(&setting)?;
        let path = app.path().app_data_dir().map_err(|error| error.to_string())?.join("web-sessions.sqlite3");
        gateway.sessions = Mutex::new(auth::SessionStore::configured(
            ttl, &path, &config.origin, gateway.password_hash.as_ref(),
        )?);
    }
    let gateway = Arc::new(gateway);
    app.manage(gateway.clone());
    for event_name in events::ALLOWED_EVENTS {
        let gateway = gateway.clone();
        let name = (*event_name).to_owned();
        app.listen_any(*event_name, move |event| {
            if let Ok(payload) = serde_json::from_str(event.payload()) {
                gateway.record_native_event(&name, payload);
            }
        });
    }
    if !config.enabled {
        return Ok(());
    }
    let listener = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, config.port))
        .map_err(|error| format!("Could not bind web gateway: {error}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|error| format!("Could not configure web gateway: {error}"))?;
    let address = listener.local_addr().map_err(|error| error.to_string())?;
    gateway.set_address(address);
    #[cfg(debug_assertions)]
    write_e2e_pairing_code(&gateway)?;
    tauri::async_runtime::spawn(async move {
        match tokio::net::TcpListener::from_std(listener) {
            Ok(listener) => {
                if let Err(error) = server::serve(gateway, listener).await {
                    eprintln!("PandaCode web gateway stopped: {error}");
                }
            }
            Err(error) => eprintln!("PandaCode web gateway could not start: {error}"),
        }
    });
    Ok(())
}

/// Debug builds only: the end-to-end harness (`scripts/web-e2e/`) pairs a browser without driving
/// the native Settings UI. When `PANDACODE_WEB_E2E_PAIRING_FILE` names a path, a fresh one-time
/// code is written there (0600, created new). Release builds compile none of this.
#[cfg(debug_assertions)]
fn write_e2e_pairing_code(gateway: &Gateway) -> Result<(), String> {
    use std::io::Write;
    let Some(path) = std::env::var_os("PANDACODE_WEB_E2E_PAIRING_FILE") else {
        return Ok(());
    };
    if gateway.password_hash.is_some() {
        return Err("Pairing fixture cannot be used with password sign-in.".into());
    }
    let (token, _) = lock(&gateway.pairing).issue().map_err(str::to_owned)?;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut file = options
        .open(&path)
        .map_err(|error| format!("Could not write e2e pairing file: {error}"))?;
    file.write_all(token.as_bytes())
        .map_err(|error| format!("Could not write e2e pairing file: {error}"))
}

fn valid_request_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn fingerprint(value: &serde_json::Value) -> [u8; 32] {
    Sha256::digest(serde_json::to_vec(value).expect("JSON values are serializable")).into()
}

fn bounded_response_value(value: serde_json::Value) -> Result<serde_json::Value, DispatchFailure> {
    let bytes = serde_json::to_vec(&value).map_err(|_| DispatchFailure::Internal)?;
    if bytes.len() > commands::MAX_RESPONSE_BYTES {
        Err(DispatchFailure::ResponseTooLarge)
    } else {
        Ok(value)
    }
}

fn provider_executable_reset(command: &str, args: &serde_json::Value) -> bool {
    command == "provider_set_executable"
        && args
            .get("path")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|path| path.trim().is_empty())
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|error| error.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::mpsc;

    struct DelayedBroker {
        commands: mpsc::UnboundedSender<BrokerRequest>,
        terminal_closes: Arc<Mutex<Vec<String>>>,
        console_gate: Mutex<Option<oneshot::Receiver<()>>>,
        console_started: Arc<tokio::sync::Notify>,
    }

    type DelayedFixture = (
        Arc<Gateway>,
        mpsc::UnboundedReceiver<BrokerRequest>,
        Arc<Mutex<Vec<String>>>,
        Arc<tokio::sync::Notify>,
    );

    impl NativeBroker for DelayedBroker {
        fn command(&self, request: BrokerRequest) -> Result<(), ()> {
            self.commands.send(request).map_err(|_| ())
        }

        fn terminal_close(&self, terminal_id: &str) -> Result<(), ()> {
            lock(&self.terminal_closes).push(terminal_id.to_owned());
            Ok(())
        }

        fn preferences(
            &self,
            _id: &str,
            _preferences: &preferences::PreferenceMap,
        ) -> Result<(), ()> {
            Ok(())
        }

        fn document(&self, _request: documents::DocumentRequest) -> documents::ReadFuture {
            Box::pin(async { Err("unused fixture document".into()) })
        }

        fn console_validate(
            &self,
            _kind: consoles::Kind,
            _target: String,
        ) -> consoles::OperationFuture<()> {
            self.console_started.notify_one();
            let gate = lock(&self.console_gate).take();
            Box::pin(async move {
                if let Some(gate) = gate {
                    gate.await.map_err(|_| "fixture gate closed")?;
                }
                Ok(())
            })
        }

        fn console_frame(
            &self,
            _kind: consoles::Kind,
            _target: String,
            _after: u64,
        ) -> consoles::OperationFuture<consoles::Frame> {
            Box::pin(async { Err("unused fixture frame".into()) })
        }

        fn console_input(
            &self,
            _kind: consoles::Kind,
            _target: String,
            _input: serde_json::Value,
        ) -> consoles::OperationFuture<String> {
            Box::pin(async { Err("unused fixture input".into()) })
        }

        fn console_lifecycle(
            &self,
            _lease: consoles::Lease,
            _action: console_lifecycle::Action,
        ) -> console_lifecycle::OperationFuture<serde_json::Value> {
            Box::pin(async { Err("unused fixture lifecycle".into()) })
        }

        fn console_capture(
            &self,
            _lease: consoles::Lease,
        ) -> console_lifecycle::OperationFuture<Vec<u8>> {
            Box::pin(async { Err("unused fixture capture".into()) })
        }

        fn dock(&self, _action: dock::Action) -> dock::OperationFuture {
            Box::pin(async { Err("unused fixture dock".into()) })
        }

        fn browser(
            &self,
            _request: browser::NativeRequest,
        ) -> browser::OperationFuture<browser::NativeResponse> {
            Box::pin(async { Err("unused fixture browser".into()) })
        }
    }

    fn delayed_gateway(
        timeout: Duration,
        console_gate: Option<oneshot::Receiver<()>>,
    ) -> DelayedFixture {
        let (commands, receiver) = mpsc::unbounded_channel();
        let terminal_closes = Arc::new(Mutex::new(Vec::new()));
        let console_started = Arc::new(tokio::sync::Notify::new());
        let broker = Arc::new(DelayedBroker {
            commands,
            terminal_closes: terminal_closes.clone(),
            console_gate: Mutex::new(console_gate),
            console_started: console_started.clone(),
        });
        let gateway = Arc::new(Gateway::with_broker(
            Config {
                enabled: true,
                port: 0,
                origin: "http://panda.test".into(),
                host: "panda.test".into(),
                root_specs: Vec::new(),
            },
            broker,
            timeout,
            timeout,
        ));
        (gateway, receiver, terminal_closes, console_started)
    }

    fn dedupe_key(request: &str) -> DedupeKey {
        DedupeKey {
            session: "session-1".to_owned(),
            command: "command-1".to_owned(),
            request: request.to_owned(),
            fingerprint: fingerprint(&serde_json::json!({"request": request})),
        }
    }

    fn session_dedupe_key(session: &str, request: &str) -> DedupeKey {
        DedupeKey {
            session: session.to_owned(),
            command: "command-1".to_owned(),
            request: request.to_owned(),
            fingerprint: fingerprint(&serde_json::json!({"request": request})),
        }
    }

    #[test]
    fn only_an_empty_provider_executable_bypasses_a_file_grant() {
        assert!(provider_executable_reset(
            "provider_set_executable",
            &serde_json::json!({"path":"  "})
        ));
        assert!(!provider_executable_reset(
            "provider_set_executable",
            &serde_json::json!({"path":null})
        ));
        assert!(!provider_executable_reset(
            "provider_set_executable",
            &serde_json::json!({"path":"/usr/bin/provider"})
        ));
        assert!(!provider_executable_reset(
            "theme_import",
            &serde_json::json!({"path":""})
        ));
    }

    #[test]
    fn clone_gateway_deadline_outlives_the_native_clone_bound() {
        assert_eq!(COMMAND_TIMEOUT, Duration::from_secs(45));
        assert_eq!(GITHUB_CLONE_TIMEOUT, Duration::from_secs(620));
        assert!(GITHUB_CLONE_TIMEOUT > Duration::from_secs(600));
    }

    #[test]
    fn dedupe_replays_the_serialized_result() {
        let mut store = DedupeStore::with_limits(4, 1024);
        let key = dedupe_key("request-1");
        assert!(store.claim(&key).unwrap().is_none());
        let value = serde_json::json!({"ok": true, "value": [1, 2, 3]});
        store.complete(key.clone(), Ok(value.clone()), DEDUPE_TTL);

        match store.claim(&key).unwrap() {
            Some(Ok(replayed)) => assert_eq!(replayed, value),
            other => panic!("expected a replayed success, got {other:?}"),
        }
    }

    #[test]
    fn dedupe_rejects_request_id_reuse_with_different_input_before_and_after_completion() {
        let mut store = DedupeStore::with_limits(8, 1024);
        let first = DedupeKey {
            session: "session-1".into(),
            command: "send_message".into(),
            request: "same-id".into(),
            fingerprint: fingerprint(&serde_json::json!({"text":"first"})),
        };
        let second = DedupeKey {
            fingerprint: fingerprint(&serde_json::json!({"text":"second"})),
            ..first.clone()
        };
        assert!(store.claim(&first).unwrap().is_none());
        assert!(matches!(
            store.claim(&second),
            Err(DispatchFailure::Conflict(
                "request ID was already used with different input"
            ))
        ));
        store.complete(
            first.clone(),
            Ok(serde_json::json!({"accepted":true})),
            DEDUPE_TTL,
        );
        assert!(matches!(
            store.claim(&second),
            Err(DispatchFailure::Conflict(
                "request ID was already used with different input"
            ))
        ));
        assert!(
            matches!(store.claim(&first).unwrap(), Some(Ok(value)) if value["accepted"] == true)
        );
    }

    #[test]
    fn dedupe_byte_pressure_keeps_completed_identity() {
        let mut store = DedupeStore::with_limits(4, 8);
        let first = dedupe_key("request-1");
        assert!(store.claim(&first).unwrap().is_none());
        store.complete(
            first.clone(),
            Ok(serde_json::json!("response larger than cap")),
            DEDUPE_TTL,
        );

        assert_eq!(store.entries.len(), 1);
        assert_eq!(store.result_bytes, 0);
        match store.claim(&first).unwrap() {
            Some(Err(DispatchFailure::Conflict(message))) => {
                assert!(message.contains("no longer retained"));
            }
            other => panic!("expected a completed tombstone, got {other:?}"),
        }
        assert_eq!(store.entries.len(), 1);
    }

    #[test]
    fn dedupe_entry_cap_prunes_only_completed_identities() {
        let mut store = DedupeStore::with_limits(2, 1024);
        let first = dedupe_key("request-1");
        let second = dedupe_key("request-2");
        let third = dedupe_key("request-3");
        assert!(store.claim(&first).unwrap().is_none());
        store.complete(first.clone(), Ok(serde_json::Value::Null), DEDUPE_TTL);
        assert!(store.claim(&second).unwrap().is_none());
        assert!(matches!(store.claim(&third), Err(DispatchFailure::Busy)));
        if let Some(DedupeEntry::Complete { expires, .. }) = store.entries.get_mut(&first) {
            *expires = Instant::now() - Duration::from_secs(1);
        }
        assert!(store.claim(&third).unwrap().is_none());
        assert_eq!(store.entries.len(), 2);
    }

    #[test]
    fn default_dedupe_capacity_handles_five_minutes_of_sustained_terminal_input() {
        let mut store = DedupeStore::default();
        for index in 0..2_500 {
            let key = dedupe_key(&format!("terminal-write-{index}"));
            assert!(store.claim(&key).unwrap().is_none());
            store.complete(key, Ok(serde_json::Value::Null), DEDUPE_TTL);
        }
        let first = dedupe_key("terminal-write-0");
        assert!(matches!(store.claim(&first).unwrap(), Some(Ok(value)) if value.is_null()));
        assert!(store.result_bytes <= MAX_DEDUPE_RESULT_BYTES);
        assert_eq!(store.entries.len(), 2_500);
    }

    #[test]
    fn dedupe_pressure_and_time_never_evict_inflight_or_uncertain_entries() {
        let mut store = DedupeStore::with_limits(4, 1);
        let inflight = dedupe_key("request-inflight");
        let uncertain = dedupe_key("request-uncertain");
        let complete = dedupe_key("request-complete");
        assert!(store.claim(&inflight).unwrap().is_none());
        store.uncertain(uncertain.clone());
        assert!(store.claim(&complete).unwrap().is_none());
        store.complete(
            complete,
            Ok(serde_json::json!("large response")),
            DEDUPE_TTL,
        );

        store.prune(Instant::now() + Duration::from_secs(365 * 24 * 60 * 60));
        assert!(matches!(
            store.claim(&inflight).unwrap(),
            Some(Err(DispatchFailure::Conflict(
                "request already in progress"
            )))
        ));
        assert!(matches!(
            store.claim(&uncertain).unwrap(),
            Some(Err(DispatchFailure::Conflict(
                "previous request outcome is uncertain; refresh state"
            )))
        ));
        assert_eq!(store.entries.len(), 2);
    }

    #[test]
    fn revocation_reclaims_only_that_sessions_permanent_identities() {
        let mut sessions = auth::SessionStore::default();
        let (old_session, _) = sessions.create().unwrap();
        let (new_session, _) = sessions.create().unwrap();
        let mut store = DedupeStore::with_limits(2, 1024);
        let old_a = session_dedupe_key(&old_session.id, "old-a");
        let old_b = session_dedupe_key(&old_session.id, "old-b");
        let new = session_dedupe_key(&new_session.id, "new");
        store.uncertain(old_a.clone());
        store.uncertain(old_b);
        assert!(matches!(
            store.claim(&old_a).unwrap(),
            Some(Err(DispatchFailure::Conflict(
                "previous request outcome is uncertain; refresh state"
            )))
        ));
        assert!(matches!(store.claim(&new), Err(DispatchFailure::Busy)));

        sessions.remove(&old_session.id).unwrap();
        store.remove_session(&old_session.id);
        assert!(sessions
            .authenticate(&old_session.id, Instant::now())
            .is_err());
        assert!(store
            .entries
            .keys()
            .all(|key| key.session != old_session.id));
        assert!(store.claim(&new).unwrap().is_none());
    }

    #[test]
    fn direct_native_values_are_bounded_before_dedupe_and_http_serialization() {
        let accepted = serde_json::Value::String("x".repeat(commands::MAX_RESPONSE_BYTES - 2));
        assert!(bounded_response_value(accepted).is_ok());
        let oversized = serde_json::Value::String("x".repeat(commands::MAX_RESPONSE_BYTES - 1));
        assert!(matches!(
            bounded_response_value(oversized),
            Err(DispatchFailure::ResponseTooLarge)
        ));
    }

    #[tokio::test]
    async fn delayed_terminal_create_after_logout_is_closed_instead_of_reowned() {
        let (gateway, mut native_commands, terminal_closes, _console_started) =
            delayed_gateway(Duration::from_secs(2), None);
        let (session, _) = lock(&gateway.sessions).create().unwrap();
        let policy = commands::policy("start_terminal").unwrap();
        let dispatch_gateway = gateway.clone();
        let session_id = session.id.clone();
        let dispatch = tokio::spawn(async move {
            dispatch_gateway
                .dispatch(
                    &session_id,
                    policy,
                    serde_json::json!({}),
                    Some("late-terminal-logout"),
                )
                .await
        });
        let native = native_commands.recv().await.unwrap();

        gateway.revoke_session(&session.id).unwrap();
        gateway.resolve(
            &native.id,
            Some(serde_json::Value::String("terminal-after-logout".into())),
            None,
        );

        assert!(matches!(
            dispatch.await.unwrap(),
            Err(DispatchFailure::Forbidden)
        ));
        assert_eq!(
            lock(&terminal_closes).clone(),
            vec!["terminal-after-logout".to_owned()]
        );
        assert!(lock(&gateway.terminals)
            .check("terminal-after-logout", &session.id)
            .is_err());
    }

    #[tokio::test]
    async fn timed_out_terminal_create_keeps_a_bounded_cleanup_tombstone_for_late_success() {
        let (gateway, mut native_commands, terminal_closes, _console_started) =
            delayed_gateway(Duration::from_millis(10), None);
        let (session, _) = lock(&gateway.sessions).create().unwrap();
        let policy = commands::policy("start_terminal").unwrap();
        let dispatch_gateway = gateway.clone();
        let session_id = session.id.clone();
        let dispatch = tokio::spawn(async move {
            dispatch_gateway
                .dispatch(
                    &session_id,
                    policy,
                    serde_json::json!({}),
                    Some("late-terminal-timeout"),
                )
                .await
        });
        let native = native_commands.recv().await.unwrap();
        assert!(matches!(
            dispatch.await.unwrap(),
            Err(DispatchFailure::Timeout)
        ));
        assert_eq!(lock(&gateway.late_terminal_creates).len(), 1);

        gateway.resolve(
            &native.id,
            Some(serde_json::Value::String("terminal-after-timeout".into())),
            None,
        );

        assert!(lock(&gateway.late_terminal_creates).is_empty());
        assert_eq!(
            lock(&terminal_closes).clone(),
            vec!["terminal-after-timeout".to_owned()]
        );
        assert!(lock(&gateway.terminals)
            .check("terminal-after-timeout", &session.id)
            .is_err());
    }

    #[tokio::test]
    async fn terminal_created_beyond_the_session_limit_is_closed_before_conflict_returns() {
        let (gateway, mut native_commands, terminal_closes, _console_started) =
            delayed_gateway(Duration::from_secs(2), None);
        let (session, _) = lock(&gateway.sessions).create().unwrap();
        for index in 0..terminal::MAX_OWNED_TERMINALS_PER_SESSION {
            lock(&gateway.terminals)
                .claim(&format!("existing-terminal-{index}"), &session.id)
                .unwrap();
        }
        let policy = commands::policy("start_terminal").unwrap();
        let dispatch_gateway = gateway.clone();
        let session_id = session.id.clone();
        let dispatch = tokio::spawn(async move {
            dispatch_gateway
                .dispatch(
                    &session_id,
                    policy,
                    serde_json::json!({}),
                    Some("terminal-over-session-limit"),
                )
                .await
        });
        let native = native_commands.recv().await.unwrap();
        gateway.resolve(
            &native.id,
            Some(serde_json::Value::String("terminal-over-limit".into())),
            None,
        );

        assert!(matches!(
            dispatch.await.unwrap(),
            Err(DispatchFailure::Conflict("terminal already owned"))
        ));
        assert_eq!(
            lock(&terminal_closes).clone(),
            vec!["terminal-over-limit".to_owned()]
        );
        assert!(lock(&gateway.terminals)
            .check("terminal-over-limit", &session.id)
            .is_err());
    }

    #[test]
    fn terminal_result_that_loses_its_waiting_receiver_is_closed() {
        let (gateway, _commands, terminal_closes, _console_started) =
            delayed_gateway(Duration::from_secs(2), None);
        let (session, _) = lock(&gateway.sessions).create().unwrap();
        let (sender, receiver) = oneshot::channel();
        drop(receiver);
        lock(&gateway.pending).insert(
            "receiver-closed-before-resolve".into(),
            Pending {
                sender,
                session_id: session.id.clone(),
                policy: commands::policy("start_terminal").unwrap(),
                dedupe: None,
                terminal_id: None,
                uploads: Vec::new(),
                terminal_create_permit: Some(
                    gateway
                        .terminal_create_admission
                        .clone()
                        .try_acquire_owned()
                        .unwrap(),
                ),
            },
        );

        gateway.resolve(
            "receiver-closed-before-resolve",
            Some(serde_json::Value::String(
                "terminal-without-receiver".into(),
            )),
            None,
        );

        assert_eq!(
            lock(&terminal_closes).clone(),
            vec!["terminal-without-receiver".to_owned()]
        );
        assert!(lock(&gateway.terminals)
            .check("terminal-without-receiver", &session.id)
            .is_err());
    }

    #[tokio::test]
    async fn delayed_console_validation_cannot_recreate_a_revoked_sessions_lease() {
        let (gate_send, gate_receive) = oneshot::channel();
        let (gateway, _commands, _terminal_closes, console_started) =
            delayed_gateway(Duration::from_secs(2), Some(gate_receive));
        let (session, _) = lock(&gateway.sessions).create().unwrap();
        let request = consoles::OpenRequest {
            kind: consoles::Kind::Vm,
            target: "fixture-vm".into(),
            control: true,
        };
        let dispatch_gateway = gateway.clone();
        let session_id = session.id.clone();
        let opening = tokio::spawn(async move {
            dispatch_gateway
                .open_console(&session_id, request, "delayed-console-open")
                .await
        });
        console_started.notified().await;
        gateway.revoke_session(&session.id).unwrap();
        gate_send.send(()).unwrap();
        assert!(matches!(
            opening.await.unwrap(),
            Err(DispatchFailure::Forbidden)
        ));

        let (replacement, _) = lock(&gateway.sessions).create().unwrap();
        let replacement_open = gateway
            .open_console(
                &replacement.id,
                consoles::OpenRequest {
                    kind: consoles::Kind::Vm,
                    target: "fixture-vm".into(),
                    control: true,
                },
                "replacement-console-open",
            )
            .await;
        assert!(replacement_open.is_ok());
    }
}
