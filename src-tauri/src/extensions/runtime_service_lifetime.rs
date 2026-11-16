//! Background services of trusted packages (`runtime.service`, runtime phase R1, slice R0104).
//!
//! A package that declares `"runtime": { ..., "service": { "start": "onEnable" } }` and holds the native
//! `runtime.service` grant gets one long-lived Node process: started at app start and on enable, only for an
//! enabled package whose executable content is trusted; stopped on disable, uninstall, a changed archive digest
//! (update), loss of trust or of the grant, safe mode and quit. The host asks the service to stop, gives its
//! `onStop` handlers at most two seconds, then ends the whole process tree (the job object).
//!
//! What this slice does NOT do (named owners): crash restart with backoff and parking (R0106), the Running list
//! and the quit confirmation (R0107), the duplex channel that dispatches owned commands, context queries and host
//! events into the service (R0201).
//!
//! R0105 runs the service from its checksum-qualified code directory (`runtime.files`), with the user's environment
//! minus `NODE_OPTIONS` and the host's `PANDACODE_*` variables, and serves `storage.directory`
//! (`packages/runtime_code_folders.rs`).
//!
//! Services live here, not in `ExtensionRuntime::active`: they never take one of the eight short-activation slots
//! and a short activation of the same package is never refused because its service runs. They are not owned by a
//! window or a captured context, so a task switch, a released handle or a closed main window leaves them running.
//! Nothing here waits for a service: `reconcile` only spawns, so a starting, hanging or broken service never
//! delays the app.
//!
//! The duplex channel (R0201, `runtime_duplex_channel.rs`) runs over the same pipe: the host dispatches owned
//! commands into the service (`ServiceLifetime::call_command`) while the service's own requests (context queries
//! and subscriptions) are served concurrently, each direction bounded and every outstanding call settled when the
//! process ends.
#[path = "runtime_duplex_channel.rs"]
pub mod runtime_duplex_channel;
use self::runtime_duplex_channel as duplex;
// Ordered, scoped workspace events pushed into the service over the same pipe (R0202).
#[path = "runtime_workspace_events.rs"]
pub mod runtime_workspace_events;
use self::runtime_workspace_events::WorkspaceEvents;
use super::{packages::Packages, runtime_grants::{RuntimeGrants, Target, Work}, supervisor};
use serde_json::{json, Value};
use super::packages::runtime_code_folders;
use std::{collections::BTreeMap, ffi::OsString, future::Future, path::PathBuf, pin::Pin, process::Stdio, sync::{Arc, Mutex}, time::{Duration, Instant}};
use tokio::{io::AsyncReadExt, sync::{mpsc, oneshot, watch, Notify}, task::JoinSet};

/// A request the service made to the host, after the channel admitted it.
pub struct DispatchRequest {
    pub owner: String,
    pub method: String,
    pub params: Value,
    /// The captured context handle of the command invocation the request was made from (never chosen by the package).
    pub handle: Option<String>,
}
/// Serves service requests other than the lifecycle ones; resolves to the broker envelope `{ok, value|error}`.
pub type Dispatch = Arc<dyn Fn(DispatchRequest) -> Pin<Box<dyn Future<Output = Value> + Send>> + Send + Sync>;
/// One host to service call waiting for its turn on the channel.
struct HostCall { method: &'static str, params: Value, handle: Option<String>, reply: oneshot::Sender<Result<Value, String>> }
/// Calls queued for the channel loop; the 64-pending bound is the channel's, so this never fills first.
const CALL_QUEUE: usize = 128;
/// Writer slots kept free for answers and calls while events drain (the writer holds 512 frames).
const EVENT_RESERVE: usize = 64;

/// The permission a package must hold for its service to start.
pub const PERMISSION: &str = "runtime.service";
/// How long the host waits for `onStop` handlers before it ends the process.
pub const STOP_GRACE: Duration = Duration::from_secs(2);
/// How often the service loop rechecks its grant (revoke, narrowing, untrust and archive cancel the work).
const GRANT_POLL: Duration = Duration::from_millis(50);

/// `ServiceLifetime.reason` of the SDK.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StartReason { AppStart, Enable, Restart, Update }
impl StartReason {
    pub fn as_str(self) -> &'static str { match self { Self::AppStart => "appStart", Self::Enable => "enable", Self::Restart => "restart", Self::Update => "update" } }
}
/// The reason passed to `onStop` handlers. A revoked `runtime.service` grant is a loss of trust (`trust`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StopReason { Disable, Uninstall, Update, Trust, SafeMode, Quit, Stop, Park }
impl StopReason {
    pub fn as_str(self) -> &'static str {
        match self { Self::Disable => "disable", Self::Uninstall => "uninstall", Self::Update => "update", Self::Trust => "trust", Self::SafeMode => "safeMode", Self::Quit => "quit", Self::Stop => "stop", Self::Park => "park" }
    }
}

/// `true` when the manifest declares a background service (`runtime.service.start` is `"onEnable"`).
pub fn declares_service(manifest: &Value) -> bool { manifest["runtime"]["service"]["start"] == "onEnable" }

/// A service the current package state asks for.
#[derive(Clone, Debug, PartialEq)]
pub struct Want { pub version: String, pub digest: String, pub commands: Vec<String> }

/// The one rule (mirrored by `desiredServices` in `src/extensions/runtime-service-lifetime.ts`): no service in safe
/// mode; otherwise one per installed package that is enabled, whose executable content is trusted, that declares a
/// service and that holds the `runtime.service` grant. `snapshot` is `extensions_snapshot` JSON.
pub fn desired(snapshot: &Value, granted: impl Fn(&str, &str) -> bool) -> BTreeMap<String, Want> {
    let mut wanted = BTreeMap::new();
    if snapshot["safeMode"] == true { return wanted; }
    for package in snapshot["packages"].as_array().into_iter().flatten() {
        let manifest = &package["manifest"];
        let (Some(id), Some(version), Some(digest)) = (manifest["id"].as_str(), manifest["version"].as_str(), package["executable"]["digest"].as_str()) else { continue };
        if package["enabled"] != true || package["executable"]["trusted"] != true || !declares_service(manifest) || !granted(id, version) { continue; }
        let commands = manifest["contributes"]["commands"].as_array().into_iter().flatten()
            .filter(|command| command["action"]["kind"] == "runCommand").filter_map(|command| command["id"].as_str().map(str::to_owned)).collect();
        wanted.insert(id.to_owned(), Want { version: version.to_owned(), digest: digest.to_owned(), commands });
    }
    wanted
}

/// Why the service of `id` started from `digest` must stop now, or `None` while it may keep running.
pub fn stop_reason(snapshot: &Value, id: &str, digest: &str, granted: impl Fn(&str, &str) -> bool) -> Option<StopReason> {
    if snapshot["safeMode"] == true { return Some(StopReason::SafeMode); }
    let Some(package) = snapshot["packages"].as_array().into_iter().flatten().find(|package| package["manifest"]["id"] == id) else { return Some(StopReason::Uninstall) };
    let manifest = &package["manifest"];
    if package["executable"]["digest"].as_str() != Some(digest) || !declares_service(manifest) { return Some(StopReason::Update); }
    if package["executable"]["trusted"] != true { return Some(StopReason::Trust); }
    if package["enabled"] != true { return Some(StopReason::Disable); }
    if !granted(id, manifest["version"].as_str().unwrap_or_default()) { return Some(StopReason::Trust); }
    None
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum State { Starting, Running, Stopping, Failed }
impl State {
    fn as_str(self) -> &'static str { match self { Self::Starting => "starting", Self::Running => "running", Self::Stopping => "stopping", Self::Failed => "failed" } }
}
struct Entry {
    generation: u64, version: String, digest: String, reason: StartReason, restarts: u32, state: State,
    status: Option<(String, bool)>, error: Option<String>, stop: watch::Sender<Option<StopReason>>,
    /// The package's own `runCommand` ids (the only commands that may be dispatched into this service).
    commands: Vec<String>, calls: mpsc::Sender<HostCall>,
}
#[derive(Default)]
struct Counters { starts: BTreeMap<&'static str, u64>, stops: BTreeMap<&'static str, u64>, last_stop: Option<(&'static str, bool)> }
/// A start that waits for the previous process of the same package to end (one service per package).
struct Queued { want: Want, source: String, reason: StartReason, work: Work, code: Code }
/// What the service's code directory and data directory need (R0105): the app data directory, the archive checksum,
/// the entry point and code folders read from the stored archive, and the `storage.private` grant work (absent when
/// the grant is not held; cancelled when it is revoked).
struct Code { app_data: PathBuf, checksum: String, files: Vec<(String, Vec<u8>)>, storage: Option<Work> }
#[derive(Default)]
struct Inner { launched: bool, quitting: bool, next: u64, entries: BTreeMap<String, Entry>, counters: BTreeMap<String, Counters>, queued: BTreeMap<String, Queued> }

/// Native owner of every background service. Managed as Tauri state; independent of windows and captured contexts.
pub struct ServiceLifetime {
    inner: Arc<Mutex<Inner>>,
    changed: Arc<Notify>,
    /// Fixed app-owned runtime directories, tried in order (never PATH or a package path).
    runtimes: Arc<Vec<PathBuf>>,
    /// Extra variables for the service process. Only tests set them (to hand a fixture its fake back end).
    env: Arc<Vec<(String, String)>>,
    /// The user environment the service inherits (R0105); `None` is the app's own environment at spawn time. Only
    /// tests replace it.
    parent: Arc<Option<Vec<(OsString, OsString)>>>,
    /// Serves the service's requests (context queries and subscriptions); installed by the app, a fake in tests.
    dispatch: Arc<Mutex<Option<Dispatch>>>,
    /// Subscriptions and queues of the workspace events of every running service.
    events: Arc<WorkspaceEvents>,
}

impl ServiceLifetime {
    pub fn new(runtimes: Vec<PathBuf>) -> Self {
        Self { inner: Arc::default(), changed: Arc::default(), runtimes: Arc::new(runtimes), env: Arc::default(), parent: Arc::default(), dispatch: Arc::default(), events: Arc::default() }
    }
    /// Replaces the user environment the service inherits (tests: canary variables without touching the process).
    #[cfg(test)]
    pub fn with_parent_env(mut self, parent: Vec<(OsString, OsString)>) -> Self {
        self.parent = Arc::new(Some(parent));
        self
    }
    /// Where the app reports workspace events (`publish`) and where the grant gate is installed.
    pub fn events(&self) -> Arc<WorkspaceEvents> { self.events.clone() }
    /// Installs the server of service requests. Services started before it only see `UnsupportedCapability` replies.
    pub fn set_dispatch(&self, dispatch: Dispatch) { if let Ok(mut slot) = self.dispatch.lock() { *slot = Some(dispatch); } }

    /// `true` while the service of `id` is running and `command_id` is one of its owned commands.
    pub fn serves(&self, id: &str, command_id: &str) -> bool {
        self.inner.lock().is_ok_and(|inner| inner.entries.get(id).is_some_and(|entry| entry.state == State::Running && entry.commands.iter().any(|command| command == command_id)))
    }
    /// Dispatches an owned command into the running service, where it reaches the state the service built (`args`
    /// arrive as `context.args`). Never queues behind another call: calls interleave with each other and with the
    /// service's own requests, bounded to 64 pending. Settled with an error code when the service stops, crashes or
    /// is disconnected. `handle` is the captured context the command runs for; the service's context queries made
    /// while it runs are answered against it.
    pub async fn call_command(&self, id: &str, command_id: &str, args: Value, handle: Option<String>) -> Result<Value, String> {
        let calls = {
            let inner = self.inner.lock().map_err(|_| "HostUnavailable".to_owned())?;
            let entry = inner.entries.get(id).filter(|entry| entry.state == State::Running).ok_or("HostUnavailable")?;
            if !entry.commands.iter().any(|command| command == command_id) { return Err("PermissionDenied".into()); }
            entry.calls.clone()
        };
        let (reply, answer) = oneshot::channel();
        calls.try_send(HostCall { method: "command", params: json!({"commandId": command_id, "args": args}), handle, reply }).map_err(|error| match error { mpsc::error::TrySendError::Full(_) => "LimitExceeded", mpsc::error::TrySendError::Closed(_) => "HostUnavailable" })?;
        answer.await.unwrap_or_else(|_| Err("HostUnavailable".into()))
    }
    #[cfg(test)]
    pub fn with_env(mut self, env: &[(&str, &str)]) -> Self {
        self.env = Arc::new(env.iter().map(|(name, value)| ((*name).to_owned(), (*value).to_owned())).collect());
        self
    }

    /// Brings the running services in line with the package state and the grants. Stops what may no longer run
    /// (with the matching reason), starts what should run and is not running yet. Never waits for a process.
    /// The first call of a manager is the app start (`appStart`); later starts are `enable`, and a changed digest
    /// restarts with `update`. A failed service is not restarted here; `retry` (enable, development reload) does it.
    pub fn reconcile(&self, packages: &Packages, grants: &RuntimeGrants) {
        let snapshot = serde_json::to_value(packages.snapshot()).unwrap_or(Value::Null);
        let Ok(mut inner) = self.inner.lock() else { return };
        if inner.quitting { return; }
        let first = !std::mem::replace(&mut inner.launched, true);
        // Package-state reasons first, before the grants sync cancels the services' grant work, so that a disable,
        // an untrust or an update is reported as itself and not as a grant loss.
        Self::stop_where(&mut inner, &snapshot, |_: &str, _: &str| true);
        // Safe mode loads no package, so its snapshot is empty: never let that erase the grants file.
        if snapshot["safeMode"] != true { let _ = grants.sync(&snapshot); }
        let headless = crate::headless::active();
        let granted = |id: &str, version: &str| !headless && grants.check(id, version, PERMISSION, &Target::default()).is_ok();
        Self::stop_where(&mut inner, &snapshot, granted);
        let wanted = desired(&snapshot, granted);
        inner.queued.retain(|id, queued| wanted.get(id).is_some_and(|want| want.digest == queued.want.digest));
        for (id, want) in wanted {
            // A start behind a process that is still stopping waits for it (one service per package).
            let reason = match inner.entries.get(&id) {
                None => if first { StartReason::AppStart } else { StartReason::Enable },
                Some(entry) if entry.state == State::Stopping && !inner.queued.contains_key(&id) => if entry.digest != want.digest { StartReason::Update } else { StartReason::Enable },
                Some(_) => continue,
            };
            let Ok((digest, source)) = packages.executable_source(&id) else { continue };
            if digest != want.digest { continue; }
            // The code the service runs from: the entry point and its declared code folders, of the same archive.
            let Ok((checksum, files)) = packages.code_files(&id) else { continue };
            if checksum != want.digest { continue; }
            let Ok(work) = grants.begin(&id, &want.version, PERMISSION, &Target::default()) else { continue };
            let storage = grants.begin(&id, &want.version, runtime_code_folders::STORAGE_PERMISSION, &Target::default()).ok();
            let code = Code { app_data: packages.app_data(), checksum, files, storage };
            if inner.entries.contains_key(&id) { inner.queued.insert(id, Queued { want, source, reason, work, code }); }
            else { self.start(&mut inner, id, Queued { want, source, reason, work, code }); }
        }
        drop(inner);
        self.changed.notify_waiters();
    }

    fn stop_where(inner: &mut Inner, snapshot: &Value, granted: impl Fn(&str, &str) -> bool + Copy) {
        let stopping: Vec<(String, StopReason)> = inner.entries.iter()
            .filter(|(_, entry)| entry.state != State::Stopping)
            .filter_map(|(id, entry)| stop_reason(snapshot, id, &entry.digest, granted).map(|reason| (id.clone(), reason)))
            .collect();
        for (id, reason) in stopping {
            let Some(entry) = inner.entries.get_mut(&id) else { continue };
            if entry.state == State::Failed { inner.entries.remove(&id); continue; }
            entry.state = State::Stopping;
            let _ = entry.stop.send(Some(reason));
        }
    }

    /// Clears a failed service so the next `reconcile` starts it again (the explicit retry of enable).
    pub fn retry(&self, id: &str) {
        if let Ok(mut inner) = self.inner.lock() { if inner.entries.get(id).is_some_and(|entry| entry.state == State::Failed) { inner.entries.remove(id); } }
    }

    /// Asks every service to stop with `reason`; after `quit` nothing starts again in this manager.
    /// Returns at once; see `wait_idle`.
    pub fn stop_all(&self, reason: StopReason) {
        if let Ok(mut inner) = self.inner.lock() {
            if reason == StopReason::Quit { inner.quitting = true; }
            inner.queued.clear();
            inner.entries.retain(|_, entry| entry.state != State::Failed);
            for entry in inner.entries.values_mut() { if entry.state != State::Stopping { entry.state = State::Stopping; let _ = entry.stop.send(Some(reason)); } }
        }
        self.changed.notify_waiters();
    }

    /// Waits until no service process is left, at most `limit`. `true` when none is left.
    pub async fn wait_idle(&self, limit: Duration) -> bool {
        let deadline = tokio::time::Instant::now() + limit;
        loop {
            let notified = self.changed.notified();
            if self.inner.lock().map(|inner| inner.entries.values().all(|entry| entry.state == State::Failed)).unwrap_or(true) { return true; }
            if tokio::time::timeout_at(deadline, notified).await.is_err() { return false; }
        }
    }

    /// The read projection (`extensions_service_lifetime`): state, start reason, status line, last error and the
    /// start/stop counters of every lifetime reason. Nothing secret, no package output beyond its status line.
    pub fn projection(&self) -> Value {
        let Ok(inner) = self.inner.lock() else { return json!({"schemaVersion":1,"available":false,"services":[]}) };
        let mut ids: Vec<&String> = inner.entries.keys().chain(inner.counters.keys()).collect();
        ids.sort(); ids.dedup();
        let services: Vec<Value> = ids.into_iter().map(|id| {
            let entry = inner.entries.get(id);
            let counters = inner.counters.get(id);
            json!({
                "id": id,
                "version": entry.map(|entry| entry.version.clone()),
                "state": entry.map_or("stopped", |entry| entry.state.as_str()),
                "reason": entry.map(|entry| entry.reason.as_str()),
                "restarts": entry.map_or(0, |entry| entry.restarts),
                "status": entry.and_then(|entry| entry.status.as_ref()).map(|(text, working)| json!({"text": text, "working": working})),
                "error": entry.and_then(|entry| entry.error.clone()),
                "starts": counters.map(|counters| json!(counters.starts)).unwrap_or_else(|| json!({})),
                "stops": counters.map(|counters| json!(counters.stops)).unwrap_or_else(|| json!({})),
                "lastStop": counters.and_then(|counters| counters.last_stop).map(|(reason, acknowledged)| json!({"reason": reason, "acknowledged": acknowledged})),
            })
        }).collect();
        json!({"schemaVersion":1,"available":true,"services":services})
    }

    fn start(&self, inner: &mut Inner, id: String, queued: Queued) {
        inner.next += 1;
        let generation = inner.next;
        let (stop, stopped) = watch::channel(None);
        let (calls, incoming_calls) = mpsc::channel(CALL_QUEUE);
        *inner.counters.entry(id.clone()).or_default().starts.entry(queued.reason.as_str()).or_default() += 1;
        inner.entries.insert(id.clone(), Entry { generation, version: queued.want.version.clone(), digest: queued.want.digest.clone(), reason: queued.reason, restarts: 0, state: State::Starting, status: None, error: None, stop, commands: queued.want.commands.clone(), calls });
        let manager = Self { inner: self.inner.clone(), changed: self.changed.clone(), runtimes: self.runtimes.clone(), env: self.env.clone(), parent: self.parent.clone(), dispatch: self.dispatch.clone(), events: self.events.clone() };
        tauri::async_runtime::spawn(async move { manager.supervise(id, generation, queued, stopped, incoming_calls).await });
    }

    async fn supervise(self, id: String, generation: u64, queued: Queued, stopped: watch::Receiver<Option<StopReason>>, mut calls: mpsc::Receiver<HostCall>) {
        let Queued { want, source, reason, work, code } = queued;
        let Code { app_data, checksum, files, storage } = code;
        let directories = self.runtimes.clone();
        let runtime = tauri::async_runtime::spawn_blocking(move || directories.iter().find_map(|directory| supervisor::Runtime::packaged(directory).ok())).await.ok().flatten();
        // The checksum-qualified code directory, verified against the stored archive (rebuilt when anything differs).
        let materialized = { let (app_data, id) = (app_data.clone(), id.clone()); tauri::async_runtime::spawn_blocking(move || runtime_code_folders::materialize(&app_data, &id, &checksum, &files)).await.unwrap_or(Err("StorageUnavailable")) };
        let events = |event: Event| self.event(&id, generation, event);
        let dispatch = self.dispatch.lock().ok().and_then(|slot| slot.clone());
        let outcome = match (runtime, materialized) {
            (Some(runtime), Ok(directory)) => {
                let entry = directory.join("main.cjs");
                let init = json!({"lifetime": {"reason": reason.as_str(), "restarts": 0, "commands": want.commands}});
                let parent: Vec<(OsString, OsString)> = match self.parent.as_ref() { Some(parent) => parent.clone(), None => std::env::vars_os().collect() };
                let code = ServiceCode { directory, entry, parent, app_data: app_data.clone(), storage: storage.as_ref() };
                // The subscription lives exactly as long as the process: a stop, crash, disable or safe mode leaves no listener.
                let wake = self.events.attach(&id, &want.version, generation);
                let outcome = run(&runtime, &source, init, stopped, &work, Wiring { owner: id.clone(), dispatch, calls: &mut calls, env: &self.env, subscriptions: self.events.clone(), wake, code }, events).await;
                self.events.detach(&id, generation);
                outcome
            }
            (None, _) => Outcome::Failed("UnsupportedRuntime"),
            (Some(_), Err(code)) => Outcome::Failed(code),
        };
        drop(storage);
        // Uninstall removed the record while this process ran from its code directory: remove the code now.
        // A reinstall queued behind this stop starts afterwards and writes its directory again.
        if matches!(outcome, Outcome::Stopped(StopReason::Uninstall, _)) {
            let (app_data, id) = (app_data, id.clone());
            let _ = tauri::async_runtime::spawn_blocking(move || runtime_code_folders::remove_code(&app_data, &id)).await;
        }
        // Whatever the outcome, no caller of this process is left waiting.
        calls.close();
        while let Ok(call) = calls.try_recv() { let _ = call.reply.send(Err("HostUnavailable".into())); }
        drop(work);
        let Ok(mut inner) = self.inner.lock() else { return };
        if inner.entries.get(&id).is_some_and(|entry| entry.generation == generation) {
            match outcome {
                Outcome::Stopped(reason, acknowledged) => {
                    inner.entries.remove(&id);
                    let counters = inner.counters.entry(id.clone()).or_default();
                    *counters.stops.entry(reason.as_str()).or_default() += 1;
                    counters.last_stop = Some((reason.as_str(), acknowledged));
                    if let Some(next) = inner.queued.remove(&id) { self.start(&mut inner, id, next); }
                }
                Outcome::Failed(code) => {
                    // The package stays enabled with a visible error; enable retries (R0106 adds backoff and parking).
                    let counters = inner.counters.entry(id.clone()).or_default();
                    *counters.stops.entry("crash").or_default() += 1;
                    if let Some(entry) = inner.entries.get_mut(&id) { entry.state = State::Failed; entry.error = Some(code.to_owned()); }
                    if let Some(next) = inner.queued.remove(&id) { inner.entries.remove(&id); self.start(&mut inner, id, next); }
                }
            }
        }
        drop(inner);
        self.changed.notify_waiters();
    }

    fn event(&self, id: &str, generation: u64, event: Event) {
        if let Ok(mut inner) = self.inner.lock() {
            if let Some(entry) = inner.entries.get_mut(id).filter(|entry| entry.generation == generation) {
                match event {
                    Event::Ready => if entry.state == State::Starting { entry.state = State::Running; },
                    Event::Status(text, working) => entry.status = Some((text, working)),
                }
            }
        }
        self.changed.notify_waiters();
    }
}

enum Event { Ready, Status(String, bool) }
#[derive(Debug, PartialEq)]
enum Outcome { Stopped(StopReason, bool), Failed(&'static str) }

/// What the process loop needs besides the process: who the service is, who serves its requests and the queue of
/// host to service calls.
struct Wiring<'a> { owner: String, dispatch: Option<Dispatch>, calls: &'a mut mpsc::Receiver<HostCall>, env: &'a [(String, String)], subscriptions: Arc<WorkspaceEvents>, wake: Arc<Notify>, code: ServiceCode<'a> }
/// Where the service runs and what it may keep (R0105): its code directory and entry point, the user environment it
/// inherits, and the app data directory with the `storage.private` grant work for `storage.directory`.
struct ServiceCode<'a> { directory: PathBuf, entry: PathBuf, parent: Vec<(OsString, OsString)>, app_data: PathBuf, storage: Option<&'a Work> }

/// One service process: no deadline, no heap flag, no message budget (the 2 MiB frame bound and the 64-pending
/// and rate bounds of the duplex channel stay). Ends when the host asks it to stop (after at most `STOP_GRACE`),
/// when its grant work is cancelled, or when it exits or breaks the protocol. The whole job is always terminated
/// and the child reaped before this returns, and every call still outstanding is settled first.
async fn run(runtime: &supervisor::Runtime, source: &str, init: Value, mut stop: watch::Receiver<Option<StopReason>>, work: &Work, wiring: Wiring<'_>, mut events: impl FnMut(Event)) -> Outcome {
    let Wiring { owner, dispatch, calls, env, subscriptions, wake, code } = wiring;
    let ServiceCode { directory, entry, parent, app_data, storage } = code;
    let mut command = tokio::process::Command::new(&runtime.binary);
    command.args(["--input-type=commonjs", "--eval", supervisor::BOOTSTRAP]).current_dir(&directory)
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    // The user's environment without NODE_OPTIONS and the host's PANDACODE_* variables (R0105, ADR-0006).
    runtime_code_folders::apply_service_environment(&mut command, parent);
    for (name, value) in env { command.env(name, value); }
    #[cfg(windows)]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    let Ok(mut child) = command.spawn() else { return Outcome::Failed("HostUnavailable") };
    #[cfg(windows)]
    let job = match supervisor::job::Job::attach_with(&child, None) { Ok(job) => job, Err(error) => { let _ = child.kill().await; let _ = child.wait().await; return Outcome::Failed(error); } };
    let (Some(mut stdin), Some(mut stdout), Some(mut stderr)) = (child.stdin.take(), child.stdout.take(), child.stderr.take()) else { let _ = child.kill().await; return Outcome::Failed("HostUnavailable") };
    // Frames are read by their own task so that a stop or a grant change never cuts a frame in half.
    let (frames, mut incoming) = mpsc::channel::<supervisor::Result<Value>>(8);
    let reader = tauri::async_runtime::spawn(async move { loop { let frame = duplex::read_frame(&mut stdout).await; let end = frame.is_err(); if frames.send(frame).await.is_err() || end { break; } } });
    // Package output is never shown; drain stderr so the service cannot block on a full pipe.
    let noise = tauri::async_runtime::spawn(async move { let mut chunk = [0; 4096]; while stderr.read(&mut chunk).await.is_ok_and(|count| count > 0) {} });
    let token = uuid::Uuid::new_v4().to_string();
    let mut requested: Option<StopReason> = *stop.borrow();
    let mut acknowledged = false;
    let mut grace = Box::pin(tokio::time::sleep(Duration::from_secs(365 * 24 * 3600)));
    let mut poll = tokio::time::interval(GRANT_POLL);
    let mut failure: Option<&'static str> = None;
    if supervisor::write_frame(&mut stdin, &json!({"token": token, "source": source, "entry": entry.to_string_lossy(), "context": init}), 300_000).await.is_err() { failure = Some("HostUnavailable"); }
    // Every later frame goes through one writer task, so a service that stops reading never blocks this loop.
    let (out, mut outgoing) = mpsc::channel::<Vec<u8>>(512);
    let writer = tauri::async_runtime::spawn(async move {
        use tokio::io::AsyncWriteExt;
        while let Some(frame) = outgoing.recv().await { if stdin.write_all(&frame).await.is_err() || stdin.flush().await.is_err() { break; } }
    });
    let send = |value: &Value| duplex::encode(value).is_ok_and(|frame| out.try_send(frame).is_ok());
    // An answer too large for a frame becomes a `LimitExceeded` refusal of that one request.
    let answer = |id: u64, reply: &Value| {
        let frame = duplex::encode(&duplex::answer_frame(id, reply)).or_else(|_| duplex::encode(&duplex::answer_frame(id, &super::context::failure("LimitExceeded"))));
        frame.is_ok_and(|frame| out.try_send(frame).is_ok())
    };
    if let (Some(reason), None) = (requested, failure) { if !send(&json!({"stop": reason.as_str()})) { failure = Some("HostUnavailable"); } grace.as_mut().reset(tokio::time::Instant::now() + STOP_GRACE); }
    let mut channel = duplex::Channel::<oneshot::Sender<Result<Value, String>>>::default();
    // The captured context each in-flight command runs for, by host call id.
    let mut handles: BTreeMap<u64, String> = BTreeMap::new();
    let mut serving: JoinSet<(u64, Value)> = JoinSet::new();
    let mut calls_open = true;
    let mut expected = 1u64;
    while failure.is_none() {
        let mut ask = None;
        tokio::select! {
            frame = incoming.recv() => {
                let message = match frame { Some(Ok(raw)) => duplex::classify(&raw), Some(Err(code)) => Err(code), None => Err("HostUnavailable") };
                match message {
                    Err(code) => { failure = Some(code); break; }
                    Ok(duplex::Incoming::Reply { schema_version, token: sent, id, result }) => {
                        if schema_version != 1 { failure = Some("IncompatibleApi"); break; }
                        if sent != token { failure = Some("PermissionDenied"); break; }
                        handles.remove(&id);
                        // A late, repeated or unknown id resolves nothing; it never settles another call.
                        if let Some(reply) = channel.settle(id) { let _ = reply.send(result); }
                    }
                    Ok(duplex::Incoming::Request { schema_version, token: sent, id, method, params }) => {
                        if schema_version != 1 { failure = Some("IncompatibleApi"); break; }
                        if sent != token || id != expected { failure = Some("PermissionDenied"); break; }
                        expected += 1;
                        let ok = json!({"ok": true, "value": null});
                        match method.as_str() {
                            "serviceReady" if params.is_null() => { events(Event::Ready); if !answer(id, &ok) && requested.is_none() { failure = Some("HostUnavailable"); } }
                            "serviceStatus" => {
                                let text = params["text"].as_str().unwrap_or_default().chars().take(200).collect::<String>();
                                events(Event::Status(text, params["working"] == true));
                                if !answer(id, &ok) && requested.is_none() { failure = Some("HostUnavailable"); }
                            }
                            "serviceStopped" if requested.is_some() => { acknowledged = true; let _ = answer(id, &ok); }
                            "failed" if params.is_null() => { failure = Some("HostUnavailable"); break; }
                            // `events.on` / dispose: the service's own subscription, checked against its grant here.
                            "events" => {
                                let reply = match (params["op"].as_str(), params["kind"].as_str()) {
                                    (Some("subscribe"), Some(kind)) => subscriptions.subscribe(&owner, kind),
                                    (Some("unsubscribe"), Some(kind)) => subscriptions.unsubscribe(&owner, kind),
                                    _ => Err("InvalidShape"),
                                };
                                let envelope = match reply { Ok(()) => ok.clone(), Err(code) => super::context::failure(code) };
                                if !answer(id, &envelope) && requested.is_none() { failure = Some("HostUnavailable"); }
                            }
                            _ => match channel.begin_request(id, Instant::now()) {
                                // Over a bound the one request is refused; the service keeps running.
                                Err(code) => { if !answer(id, &super::context::failure(code)) && requested.is_none() { failure = Some("HostUnavailable"); } }
                                Ok(()) => {
                                    // Context requests run for the command they were made from, never for a handle the package names.
                                    let handle = if method == "context" || method == "storageDirectory" { params.get("invocation").and_then(Value::as_u64).and_then(|call| handles.get(&call).cloned()) } else { None };
                                    let mut params = params;
                                    if let Some(object) = params.as_object_mut() { object.remove("invocation"); }
                                    // `storage.directory` (R0105): the live `storage.private` grant of this service. With
                                    // the captured context of an owned command the app resolves its project (and checks
                                    // the grant again); without one it is answered here, and `project` is `StaleContext`.
                                    if method == "storageDirectory" && (handle.is_none() || dispatch.is_none() || !storage.is_some_and(|work| !work.is_cancelled())) {
                                        let (granted, app_data, owner, params) = (storage.is_some_and(|work| !work.is_cancelled()), app_data.clone(), owner.clone(), params);
                                        serving.spawn(async move { (id, tauri::async_runtime::spawn_blocking(move || runtime_code_folders::storage_directory_reply(&app_data, &owner, &params, granted, None)).await.unwrap_or_else(|_| super::context::failure("HostUnavailable"))) });
                                    } else {
                                        let served = dispatch.as_ref().map(|dispatch| dispatch(DispatchRequest { owner: owner.clone(), method, params, handle }));
                                        serving.spawn(async move { (id, match served { Some(served) => served.await, None => super::context::failure("UnsupportedCapability") }) });
                                    }
                                }
                            },
                        }
                    }
                }
            }
            call = calls.recv(), if requested.is_none() && calls_open => {
                match call {
                    None => calls_open = false,
                    Some(call) => match channel.begin_call(Instant::now(), call.reply) {
                        Err((code, reply)) => { let _ = reply.send(Err(code.into())); }
                        Ok(id) => match duplex::encode(&duplex::call_frame(id, call.method, &call.params)) {
                            Err(code) => { if let Some(reply) = channel.settle(id) { let _ = reply.send(Err(code.into())); } }
                            Ok(frame) => {
                                if let Some(handle) = call.handle { handles.insert(id, handle); }
                                if out.try_send(frame).is_err() { failure = Some("HostUnavailable"); break; }
                            }
                        },
                    },
                }
            }
            done = serving.join_next(), if !serving.is_empty() => {
                if let Some(Ok((id, reply))) = done {
                    channel.finish_request(id);
                    if !answer(id, &reply) && requested.is_none() { failure = Some("HostUnavailable"); }
                }
            }
            // An event was queued for this service; the pass below writes it.
            _ = wake.notified(), if requested.is_none() => {}
            changed = stop.changed(), if requested.is_none() => { ask = if changed.is_ok() { *stop.borrow() } else { Some(StopReason::Quit) }; }
            // A cancelled grant work is a grant or trust loss, unless the host already named the reason.
            _ = poll.tick(), if requested.is_none() => { if work.is_cancelled() { ask = Some(stop.borrow().unwrap_or(StopReason::Trust)); } }
            () = &mut grace, if requested.is_some() => break,
        }
        // Events leave the queue in order, one frame each, while the writer has room (calls and answers keep a
        // reserve); a service that stops reading leaves them queued, where the 256 bound and the gap apply.
        if requested.is_none() && failure.is_none() {
            while out.capacity() > EVENT_RESERVE {
                let Some(envelope) = subscriptions.next_frame(&owner) else { break };
                if let Ok(frame) = duplex::encode(&runtime_workspace_events::event_frame(&envelope)) { if out.try_send(frame).is_err() { failure = Some("HostUnavailable"); break; } }
            }
        }
        if let (Some(reason), None) = (ask, requested) {
            requested = Some(reason);
            grace.as_mut().reset(tokio::time::Instant::now() + STOP_GRACE);
            // A process that already left still counts as stopped for this reason.
            let _ = send(&json!({"stop": reason.as_str()}));
        }
    }
    // Disconnect, disable and trust loss settle every outstanding call and refuse the queued ones: nothing hangs.
    let settled = if requested.is_some() { "Cancelled" } else { "HostUnavailable" };
    for (_, reply) in channel.settle_all() { let _ = reply.send(Err(settled.into())); }
    calls.close();
    while let Ok(call) = calls.try_recv() { let _ = call.reply.send(Err(settled.into())); }
    serving.abort_all();
    writer.abort();
    #[cfg(windows)]
    let disposed = job.terminate();
    #[cfg(not(windows))]
    let disposed: supervisor::Result<()> = Ok(());
    let _ = child.start_kill();
    let reaped = tokio::time::timeout(Duration::from_secs(1), child.wait()).await;
    reader.abort(); noise.abort();
    match (requested, failure) {
        (Some(reason), _) => Outcome::Stopped(reason, acknowledged),
        _ if disposed.is_err() || !matches!(reaped, Ok(Ok(_))) => Outcome::Failed("HostUnavailable"),
        (None, Some(code)) => Outcome::Failed(code),
        (None, None) => Outcome::Failed("HostUnavailable"),
    }
}

/// The fixed runtime directories of the app: the packaged resource and, in a debug build only, the
/// explicit checkout-local developer packaging (the same fallback as short activations).
pub fn runtime_directories(app: &tauri::AppHandle) -> Vec<PathBuf> {
    use tauri::Manager;
    let mut directories: Vec<PathBuf> = app.path().resource_dir().ok().map(|path| path.join("extension-runtime")).into_iter().collect();
    if cfg!(debug_assertions) { directories.push(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../_work/00-tmp/extensibility-trusted-runtime")); }
    directories
}

/// Reconciles on a blocking thread: callers (IPC handlers, app start) never wait for package reads or processes.
pub fn reconcile_app(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let (Some(services), Some(packages), Some(grants)) = (app.try_state::<ServiceLifetime>(), app.try_state::<super::packages::ExtensionPackages>(), app.try_state::<RuntimeGrants>()) else { return };
        services.set_dispatch(app_dispatch(&app));
        services.events().set_gate(runtime_workspace_events::grants_gate(&app));
        let Ok(packages) = packages.0.lock() else { return };
        services.reconcile(&packages, &grants);
    });
}

/// Serves the service's context queries and subscriptions exactly as a short activation's are: against the
/// captured context of the command the request was made from, through the same broker call, so the public behaviour
/// (limits, scope, stale handles) and the job events are the legacy ones, recorded once. Nothing else is served here:
/// other methods stay with their own slices and answer `UnsupportedCapability`.
fn app_dispatch(app: &tauri::AppHandle) -> Dispatch {
    let app = app.clone();
    Arc::new(move |request: DispatchRequest| {
        let app = app.clone();
        Box::pin(async move {
            use tauri::Manager;
            if request.method == "storageDirectory" { return storage_directory(&app, request); }
            if request.method != "context" { return super::context::failure("UnsupportedCapability"); }
            let Some(handle) = request.handle else { return super::context::failure("StaleContext") };
            let result = (|| {
                let packages = app.state::<super::packages::ExtensionPackages>(); let packages = packages.0.try_lock().map_err(|_| "Timeout")?;
                let snapshot = packages.snapshot();
                let broker = app.state::<super::context::ContextBroker>();
                let (owner, _, _) = broker.local_binding(&app, &snapshot, &handle)?;
                if owner != request.owner { return Err("PermissionDenied"); }
                let state = app.state::<crate::AppState>(); let store = state.store.try_lock().map_err(|_| "Timeout")?;
                Ok(broker.runtime_call(&snapshot, &store, &handle, request.params))
            })();
            result.unwrap_or_else(super::context::failure)
        }) as Pin<Box<dyn Future<Output = Value> + Send>>
    })
}
/// `storage.directory` made while an owned command runs (R0105): the project is the one of the captured context the
/// command was invoked from, and the `storage.private` grant is checked again for the owner's installed version.
fn storage_directory(app: &tauri::AppHandle, request: DispatchRequest) -> Value {
    use tauri::Manager;
    let Some(handle) = request.handle else { return super::context::failure("StaleContext") };
    let result = (|| {
        let packages = app.state::<super::packages::ExtensionPackages>(); let packages = packages.0.try_lock().map_err(|_| "Timeout")?;
        let snapshot = packages.snapshot();
        let (owner, version, context) = app.state::<super::context::ContextBroker>().local_binding(app, &snapshot, &handle)?;
        if owner != request.owner { return Err("PermissionDenied"); }
        let granted = app.state::<RuntimeGrants>().check(&owner, &version, runtime_code_folders::STORAGE_PERMISSION, &Target::default()).is_ok();
        Ok(runtime_code_folders::storage_directory_reply(&packages.app_data(), &owner, &request.params, granted, context["projectId"].as_str()))
    })();
    result.unwrap_or_else(super::context::failure)
}
/// Enable and development reload: clear a failed service, then reconcile.
pub fn retry_app(app: &tauri::AppHandle, owner: &str) {
    use tauri::Manager;
    if let Some(services) = app.try_state::<ServiceLifetime>() { services.retry(owner); }
    reconcile_app(app);
}
/// Quit: ask every service to stop now; `quit_wait` bounds how long the exit waits for them.
pub fn quit(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Some(services) = app.try_state::<ServiceLifetime>() { services.stop_all(StopReason::Quit); }
}
pub async fn quit_wait(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Some(services) = app.try_state::<ServiceLifetime>() { services.wait_idle(STOP_GRACE + Duration::from_millis(500)).await; }
}

#[tauri::command]
pub fn extensions_service_lifetime(window: tauri::WebviewWindow, services: tauri::State<'_, ServiceLifetime>) -> Result<Value, String> {
    if crate::headless::active() || window.label() != "main" { return Err("PermissionDenied".into()); }
    Ok(services.projection())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::extensions::{packages::ExtensionPackages, runtime_grants::Scope};
    use std::{io::Write, time::Instant};
    pub(super) const MANIFEST: &str = include_str!("../../../tests/fixtures/extensions/runtime-service-lifetime/extension.json");
    pub(super) const SOURCE: &str = include_str!("../../../tests/fixtures/extensions/runtime-service-lifetime/main.cjs");
    pub(super) const ID: &str = "sample.service-lifetime";
    pub(super) struct Dir(pub(super) PathBuf);
    impl Dir { pub(super) fn new() -> Self { let path = std::env::temp_dir().join(format!("pandacode-service-test-{}", uuid::Uuid::new_v4())); std::fs::create_dir(&path).unwrap(); Self(path) } }
    impl Drop for Dir { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }
    pub(super) fn archive(manifest: &str, source: &str) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        for (name, bytes) in [("extension.json", manifest.as_bytes()), ("main.cjs", source.as_bytes())] {
            writer.start_file(name, zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated)).unwrap();
            writer.write_all(bytes).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }
    pub(super) fn digest(packages: &Packages) -> String { serde_json::to_value(packages.snapshot()).unwrap()["packages"][0]["executable"]["digest"].as_str().unwrap().to_owned() }
    pub(super) fn service(manager: &ServiceLifetime) -> Value {
        manager.projection()["services"].as_array().unwrap().iter().find(|service| service["id"] == ID).cloned().unwrap_or(Value::Null)
    }
    /// Waits for a projection condition (tests only; the product never polls).
    pub(super) async fn wait_for(manager: &ServiceLifetime, what: &str, check: impl Fn(&Value) -> bool) -> Value {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            let notified = manager.changed.notified();
            let current = service(manager);
            if check(&current) { return current; }
            assert!(Instant::now() < deadline, "timed out waiting for {what}: {current}");
            let _ = tokio::time::timeout(Duration::from_millis(100), notified).await;
        }
    }
    fn package(enabled: bool, trusted: bool, digest: &str, service: bool) -> Value {
        let mut manifest: Value = serde_json::from_str(MANIFEST).unwrap();
        if !service { manifest["runtime"].as_object_mut().unwrap().remove("service"); }
        json!({"manifest": manifest, "enabled": enabled, "executable": {"digest": digest, "trusted": trusted}})
    }

    #[test]
    fn desired_and_stop_reasons_follow_safe_mode_install_digest_trust_enable_and_grant() {
        let all = |_: &str, _: &str| true;
        let snapshot = |packages: Vec<Value>| json!({"safeMode": false, "packages": packages});
        let wanted = desired(&snapshot(vec![package(true, true, "a", true)]), all);
        assert_eq!(wanted.get(ID), Some(&Want { version: "1.0.0".into(), digest: "a".into(), commands: vec!["sample.service-lifetime/long".into()] }));
        // Nothing before trust, enable and the grant; a package without a service stays lazy (Q120).
        for (package, granted) in [(package(true, false, "a", true), true), (package(false, true, "a", true), true), (package(true, true, "a", true), false), (package(true, true, "a", false), true)] {
            assert!(desired(&snapshot(vec![package]), |_: &str, _: &str| granted).is_empty());
        }
        assert!(desired(&json!({"safeMode": true, "packages": [package(true, true, "a", true)]}), all).is_empty());
        let reason = |snapshot: Value, granted: bool| stop_reason(&snapshot, ID, "a", |_: &str, _: &str| granted);
        assert_eq!(reason(snapshot(vec![package(true, true, "a", true)]), true), None);
        assert_eq!(reason(json!({"safeMode": true, "packages": []}), true), Some(StopReason::SafeMode));
        assert_eq!(reason(snapshot(vec![]), true), Some(StopReason::Uninstall));
        assert_eq!(reason(snapshot(vec![package(true, true, "b", true)]), true), Some(StopReason::Update));
        assert_eq!(reason(snapshot(vec![package(true, true, "a", false)]), true), Some(StopReason::Update));
        assert_eq!(reason(snapshot(vec![package(false, false, "a", true)]), true), Some(StopReason::Trust));
        assert_eq!(reason(snapshot(vec![package(false, true, "a", true)]), true), Some(StopReason::Disable));
        assert_eq!(reason(snapshot(vec![package(true, true, "a", true)]), false), Some(StopReason::Trust));
        let names: Vec<&str> = [StopReason::Disable, StopReason::Uninstall, StopReason::Update, StopReason::Trust, StopReason::SafeMode, StopReason::Quit, StopReason::Stop, StopReason::Park].iter().map(|reason| reason.as_str()).collect();
        assert_eq!(names, ["disable", "uninstall", "update", "trust", "safeMode", "quit", "stop", "park"]);
        let starts: Vec<&str> = [StartReason::AppStart, StartReason::Enable, StartReason::Restart, StartReason::Update].iter().map(|reason| reason.as_str()).collect();
        assert_eq!(starts, ["appStart", "enable", "restart", "update"]);
    }

    /// Q021/Q022/Q040 (R0104 part): the `runtime.service` descriptor is the permissioned shape; the legacy
    /// top-level `entrypoint` and install `scripts` stay refused (stability: one runtime descriptor; consent before
    /// any code runs), and a service without the `runtime.service` permission declared is refused.
    #[test]
    fn the_service_descriptor_validates_while_the_legacy_shapes_stay_refused() {
        let manifest: Value = serde_json::from_str(MANIFEST).unwrap();
        let checked = super::super::contracts::validate_contract("packages", &json!([manifest]));
        assert_eq!(checked["ok"], true, "{checked}");
        let mut undeclared = manifest.clone(); undeclared["permissions"] = json!(["ui.contribute"]);
        assert_eq!(super::super::contracts::validate_contract("packages", &json!([undeclared]))["error"]["code"], "PermissionDenied");
        let mut start = manifest.clone(); start["runtime"]["service"]["start"] = json!("onLaunch");
        assert_eq!(super::super::contracts::validate_contract("packages", &json!([start]))["ok"], false);
        for key in ["entrypoint", "scripts"] {
            let mut legacy = manifest.clone(); legacy[key] = json!("main.js");
            assert_eq!(super::super::contracts::validate_contract("packages", &json!([legacy]))["error"]["code"], "UnsupportedRuntime");
        }
        assert!(super::super::runtime::unsupported_reason().starts_with("Declarative-only:"));
        let dir = Dir::new(); let packages = ExtensionPackages::new(&dir.0, false); let packages = packages.0.lock().unwrap();
        packages.install(&archive(MANIFEST, SOURCE)).unwrap();
        let mut legacy = manifest; legacy["entrypoint"] = json!("main.js"); legacy["id"] = json!("sample.service-legacy");
        assert!(packages.install(&archive(&legacy.to_string(), SOURCE)).unwrap_err().starts_with("UnsupportedRuntime: Declarative-only:"));
    }

    /// R0201 (Q120 retained refusals): a service package needs no `activationEvents`; a listed set must still match the
    /// executable commands, and without a service the events stay required.
    #[test]
    fn activation_events_are_optional_only_for_a_service_package() {
        let manifest: Value = serde_json::from_str(include_str!("../../../tests/fixtures/extensions/runtime-duplex-channel/extension.json")).unwrap();
        let check = |manifest: &Value| super::super::contracts::validate_contract("packages", &json!([manifest]));
        assert_eq!(check(&manifest)["ok"], true, "{}", check(&manifest));
        let mut listed = manifest.clone(); listed["runtime"]["activationEvents"] = json!(["sample.duplex-channel/echo", "sample.duplex-channel/other"]);
        assert_eq!(check(&listed)["ok"], true);
        let mut partial = manifest.clone(); partial["runtime"]["activationEvents"] = json!(["sample.duplex-channel/echo"]);
        assert_eq!(check(&partial)["error"]["code"], "UnsupportedRuntime");
        let mut plain = manifest.clone(); plain["runtime"].as_object_mut().unwrap().remove("service");
        assert_eq!(check(&plain)["error"]["code"], "UnsupportedRuntime");
        let mut undeclared = manifest; undeclared["permissions"] = json!(["ui.contribute"]);
        assert_eq!(check(&undeclared)["error"]["code"], "PermissionDenied");
    }

    #[tokio::test]
    async fn nothing_starts_before_trust_enable_and_grant_and_reconcile_never_waits_for_a_failed_start() {
        let dir = Dir::new();
        let packages = ExtensionPackages::new(&dir.0, false);
        let grants = RuntimeGrants::open(&dir.0);
        // No runtime here: the start fails at once, which is the "broken service" of this platform-neutral test.
        let manager = ServiceLifetime::new(vec![dir.0.join("no-runtime")]);
        let reconcile = || { let packages = packages.0.lock().unwrap(); let started = Instant::now(); manager.reconcile(&packages, &grants); started.elapsed() };
        packages.0.lock().unwrap().install(&archive(MANIFEST, SOURCE)).unwrap();
        reconcile(); assert_eq!(service(&manager), Value::Null, "installed: nothing starts");
        assert!(packages.0.lock().unwrap().enable(ID, true).unwrap_err().starts_with("ExecutableTrustRequired"));
        { let packages = packages.0.lock().unwrap(); let digest = digest(&packages); packages.trust(ID, &digest, true).unwrap(); }
        reconcile(); assert_eq!(service(&manager), Value::Null, "trusted but disabled: nothing starts");
        packages.0.lock().unwrap().enable(ID, true).unwrap();
        reconcile(); assert_eq!(service(&manager), Value::Null, "enabled without the runtime.service grant: nothing starts");
        grants.grant(ID, PERMISSION, Scope::default()).unwrap();
        assert!(reconcile() < Duration::from_millis(500), "reconcile only spawns");
        let failed = wait_for(&manager, "a failed start", |service| service["state"] == "failed").await;
        assert_eq!(failed["error"], "UnsupportedRuntime"); assert_eq!(failed["starts"], json!({"enable": 1})); assert_eq!(failed["stops"], json!({"crash": 1}));
        let snapshot = serde_json::to_value(packages.0.lock().unwrap().snapshot()).unwrap();
        assert_eq!(snapshot["packages"][0]["enabled"], true, "a service that does not start leaves the package enabled");
        reconcile(); assert_eq!(service(&manager)["starts"], json!({"enable": 1}), "a failed service is not restarted by another change");
        manager.retry(ID); reconcile();
        wait_for(&manager, "the retried start", |service| service["starts"] == json!({"enable": 2}) && service["state"] == "failed").await;
        packages.0.lock().unwrap().safe = true; reconcile();
        assert_eq!(service(&manager)["state"], "stopped", "safe mode clears even a failed service");
        packages.0.lock().unwrap().safe = false;
        grants.check(ID, "1.0.0", PERMISSION, &Target::default()).unwrap();
    }

    #[cfg(all(feature = "extension-runtime-native-tests", target_os = "windows", target_arch = "x86_64"))]
    mod installed {
        use super::*;
        use crate::extensions::context::ContextBroker;
        use std::sync::atomic::AtomicBool;
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
        use windows::Win32::{Foundation::{CloseHandle, HANDLE}, System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION}};

        fn runtime_dir() -> PathBuf { std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../_work/00-tmp/extensibility-trusted-runtime") }

        /// The canonical B1 fake daemon (tests/fixtures/extensions/backends/fake-daemon), run by the pinned runtime.
        struct B1 { child: tokio::process::Child, stdin: Option<tokio::process::ChildStdin>, socket: String, control: String }
        impl B1 {
            async fn start(runtime: &supervisor::Runtime) -> Self {
                let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/extensions/backends/fake-daemon/fake-daemon.mjs");
                let mut child = tokio::process::Command::new(&runtime.binary).arg(script).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true).creation_flags(0x08000000).spawn().unwrap();
                let mut lines = tokio::io::BufReader::new(child.stdout.take().unwrap()).lines();
                let ready: Value = serde_json::from_str(&tokio::time::timeout(Duration::from_secs(10), lines.next_line()).await.unwrap().unwrap().unwrap()).unwrap();
                assert_eq!(ready["ready"], true);
                Self { stdin: child.stdin.take(), child, socket: ready["socket"].as_str().unwrap().to_owned(), control: ready["control"].as_str().unwrap().to_owned() }
            }
            async fn http(&self, method: &str, path: &str, body: &Value) -> Value {
                let address = self.control.trim_start_matches("http://").trim_end_matches('/');
                let mut stream = tokio::net::TcpStream::connect(address).await.unwrap();
                let body = if method == "GET" { String::new() } else { body.to_string() };
                // HTTP/1.0: one plain body up to EOF, never chunked.
                stream.write_all(format!("{method} {path} HTTP/1.0\r\nHost: {address}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
                let mut response = Vec::new(); stream.read_to_end(&mut response).await.unwrap();
                let text = String::from_utf8(response).unwrap();
                serde_json::from_str(text.split_once("\r\n\r\n").unwrap().1).unwrap()
            }
            async fn signal(&self, n: u64) { self.http("POST", "/control/signal", &json!({"name": "ping", "payload": {"n": n}})).await; }
            /// The `start:`/`stop:` issue titles the service wrote, in order.
            async fn reasons(&self) -> Vec<String> {
                self.http("GET", "/control/log", &Value::Null).await.as_array().unwrap().iter()
                    .filter(|entry| entry["transport"] == "tcp" && entry["request"]["op"] == "issues.create")
                    .filter_map(|entry| entry["request"]["params"]["title"].as_str().map(str::to_owned)).collect()
            }
            async fn stop(mut self) {
                drop(self.stdin.take());
                assert!(tokio::time::timeout(Duration::from_secs(5), self.child.wait()).await.is_ok(), "B1 ends on stdin EOF");
            }
        }
        /// Opens the service host and its helper while they run; `gone` later proves both ended.
        fn processes(status: &Value) -> Vec<HANDLE> {
            let status: Value = serde_json::from_str(status["status"]["text"].as_str().unwrap()).unwrap();
            ["host", "helper"].iter().map(|key| unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, status[key].as_u64().unwrap() as u32) }.unwrap()).collect()
        }
        async fn gone(handles: Vec<HANDLE>, step: &str) {
            for handle in handles {
                let deadline = Instant::now() + Duration::from_secs(3);
                loop {
                    let mut exit = 259; unsafe { GetExitCodeProcess(handle, &mut exit).unwrap(); }
                    if exit != 259 { break; }
                    assert!(Instant::now() < deadline, "{step}: an owned process survived");
                    tokio::time::sleep(Duration::from_millis(25)).await;
                }
                unsafe { CloseHandle(handle).unwrap(); }
            }
        }
        async fn running(manager: &ServiceLifetime, what: &str) -> Value { wait_for(manager, what, |service| service["state"] == "running").await }
        async fn stopped(manager: &ServiceLifetime, reason: &str, count: u64) -> Value {
            wait_for(manager, reason, |service| service["state"] == "stopped" && service["stops"][reason] == count && service["lastStop"] == json!({"reason": reason, "acknowledged": true})).await
        }
        fn signals(service: &Value) -> u64 { service["status"]["text"].as_str().and_then(|text| serde_json::from_str::<Value>(text).ok()).and_then(|status| status["signals"].as_u64()).unwrap_or(0) }

        /// R0104 acceptance: install the B1-backed fixture, signal B1, switch task, run a long command, then stop it
        /// by each lifetime reason and inspect the start/stop counters, the acknowledged `onStop` reasons recorded
        /// in B1, and that no host or helper process survives any stop.
        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn installed_b1_service_lives_across_a_task_switch_and_a_long_command_and_stops_for_every_reason() {
            let runtime = supervisor::Runtime::packaged(&runtime_dir()).unwrap();
            let b1 = B1::start(&runtime).await;
            let dir = Dir::new();
            let packages = ExtensionPackages::new(&dir.0, false);
            let grants = RuntimeGrants::open(&dir.0);
            let env = [("PANDA_FIXTURE_B1", b1.socket.as_str()), ("PANDA_FIXTURE_HELPER", "1")];
            let reconcile = |manager: &ServiceLifetime| { let packages = packages.0.lock().unwrap(); manager.reconcile(&packages, &grants); };

            // First launch: nothing before trust, enable and grant.
            let first = ServiceLifetime::new(vec![runtime_dir()]).with_env(&env);
            packages.0.lock().unwrap().install(&archive(MANIFEST, SOURCE)).unwrap();
            reconcile(&first); assert_eq!(service(&first), Value::Null);
            let digest_a = { let packages = packages.0.lock().unwrap(); let digest = digest(&packages); packages.trust(ID, &digest, true).unwrap(); packages.enable(ID, true).unwrap(); digest };
            reconcile(&first); assert_eq!(service(&first), Value::Null, "no runtime.service grant yet");
            grants.grant(ID, PERMISSION, Scope::default()).unwrap();
            reconcile(&first);
            let live = running(&first, "enable start").await; assert_eq!(live["reason"], "enable");
            let handles = processes(&live);
            // Quit, then the next app launch starts it with `appStart`.
            first.stop_all(StopReason::Quit); assert!(first.wait_idle(STOP_GRACE + Duration::from_secs(1)).await);
            assert_eq!(service(&first)["lastStop"], json!({"reason": "quit", "acknowledged": true}));
            gone(handles, "quit").await;
            reconcile(&first); assert_eq!(service(&first)["state"], "stopped", "nothing starts again after quit");

            let manager = ServiceLifetime::new(vec![runtime_dir()]).with_env(&env);
            let started = Instant::now(); reconcile(&manager); assert!(started.elapsed() < Duration::from_millis(500), "app launch never waits for a service");
            let live = running(&manager, "app start").await; assert_eq!(live["reason"], "appStart");
            let handles = processes(&live);
            b1.signal(1).await; wait_for(&manager, "signal 1", |service| signals(service) == 1).await;

            // A task switch: the captured context of task A is released and task B is captured; a long command of
            // the same package runs as a short activation in task B while the service keeps receiving B1 signals.
            let store = crate::storage::Store::open(std::path::Path::new(":memory:")).unwrap();
            store.db.execute("INSERT INTO projects(id,name,path) VALUES ('project-1','one','/one'),('project-2','two','/two')", []).unwrap();
            let broker = ContextBroker::default();
            let snapshot = packages.0.lock().unwrap().snapshot();
            let capture = |project: &str| broker.test_call(&snapshot, &store, json!({"op":"capture","id":"sample.service-lifetime/header","version":"1.0.0","context":{"schemaVersion":1,"windowId":"main","surfaceId":"panda.workspace.header.actions","projectId":project,"revision":1}}))["value"]["handle"].as_str().unwrap().to_owned();
            let task_a = capture("project-1");
            assert_eq!(broker.test_call(&snapshot, &store, json!({"op":"release","handle":task_a}))["ok"], true);
            let task_b = capture("project-2");
            let (_, _, context) = broker.runtime_binding(&snapshot, &task_b).unwrap();
            let (long_runtime, long_source) = (runtime.clone(), packages.0.lock().unwrap().executable_source(ID).unwrap().1);
            let long = tokio::spawn(async move { supervisor::run(&long_runtime, &long_source, context, Arc::new(AtomicBool::new(false)), |_, _| json!({"ok":true,"value":null})).await });
            tokio::time::sleep(Duration::from_millis(800)).await;
            b1.signal(2).await; wait_for(&manager, "signal 2 during the long command", |service| signals(service) == 2).await;
            assert!(!long.is_finished(), "the long command is still running");
            assert_eq!(long.await.unwrap().unwrap(), Vec::<Value>::new());
            broker.runtime_release(&task_b);
            b1.signal(3).await;
            let live = wait_for(&manager, "signal 3 after the long command", |service| signals(service) == 3).await;
            assert_eq!(live["state"], "running"); assert_eq!(live["starts"], json!({"appStart": 1})); assert_eq!(live["stops"], json!({}));

            // Disable, then enable.
            packages.0.lock().unwrap().enable(ID, false).unwrap(); reconcile(&manager);
            stopped(&manager, "disable", 1).await; gone(handles, "disable").await;
            packages.0.lock().unwrap().enable(ID, true).unwrap(); reconcile(&manager);
            let handles = processes(&running(&manager, "enable").await);
            // Grant loss: revoking runtime.service stops the service by itself, before any other reconcile.
            grants.revoke(ID, PERMISSION).unwrap();
            stopped(&manager, "trust", 1).await; gone(handles, "grant revoked").await;
            grants.grant(ID, PERMISSION, Scope::default()).unwrap(); reconcile(&manager);
            let handles = processes(&running(&manager, "re-granted").await);
            // Trust loss (which also disables), then trust and enable again.
            packages.0.lock().unwrap().trust(ID, &digest_a, false).unwrap(); reconcile(&manager);
            stopped(&manager, "trust", 2).await; gone(handles, "untrusted").await;
            { let packages = packages.0.lock().unwrap(); packages.trust(ID, &digest_a, true).unwrap(); packages.enable(ID, true).unwrap(); }
            reconcile(&manager);
            let handles = processes(&running(&manager, "re-trusted").await);
            // Update: a reviewed new archive (changed digest) stops the old process, then starts the new one.
            let mut next: Value = serde_json::from_str(MANIFEST).unwrap(); next["version"] = json!("1.1.0");
            let staged = dir.0.join("update.zip"); std::fs::write(&staged, archive(&next.to_string(), SOURCE)).unwrap();
            { let packages = packages.0.lock().unwrap(); packages.stage_update(ID, &staged).unwrap(); let digest = serde_json::to_value(packages.snapshot()).unwrap()["packages"][0]["update"]["digest"].as_str().unwrap().to_owned(); packages.review_update(ID, &digest).unwrap(); }
            reconcile(&manager);
            let live = wait_for(&manager, "update restart", |service| service["state"] == "running" && service["reason"] == "update").await;
            assert_eq!(live["version"], "1.1.0"); assert_eq!(live["stops"]["update"], 1); assert_eq!(live["lastStop"], json!({"reason": "update", "acknowledged": true}));
            gone(handles, "update").await;
            let handles = processes(&live);
            // Safe mode, then leaving it.
            packages.0.lock().unwrap().safe = true; reconcile(&manager);
            stopped(&manager, "safeMode", 1).await; gone(handles, "safe mode").await;
            packages.0.lock().unwrap().safe = false; reconcile(&manager);
            let handles = processes(&running(&manager, "after safe mode").await);
            // Uninstall.
            packages.0.lock().unwrap().uninstall(ID).unwrap(); reconcile(&manager);
            let last = stopped(&manager, "uninstall", 1).await; gone(handles, "uninstall").await;
            assert_eq!(last["starts"], json!({"appStart": 1, "enable": 4, "update": 1}));
            assert_eq!(last["stops"], json!({"disable": 1, "trust": 2, "update": 1, "safeMode": 1, "uninstall": 1}));
            assert_eq!(b1.reasons().await, [
                "start:enable", "stop:quit", "start:appStart", "stop:disable", "start:enable", "stop:trust", "start:enable", "stop:trust",
                "start:enable", "stop:update", "start:update", "stop:safeMode", "start:enable", "stop:uninstall",
            ]);
            println!("SERVICE_LIFETIME {}", json!({"starts": last["starts"], "stops": last["stops"], "elapsedMs": started.elapsed().as_millis()}));
            manager.stop_all(StopReason::Quit); assert!(manager.wait_idle(Duration::from_secs(1)).await);
            b1.stop().await;
        }

        const DUPLEX_MANIFEST: &str = include_str!("../../../tests/fixtures/extensions/runtime-duplex-channel/extension.json");
        const DUPLEX_SOURCE: &str = include_str!("../../../tests/fixtures/extensions/runtime-duplex-channel/main.cjs");
        const DUPLEX_ID: &str = "sample.duplex-channel";
        const ECHO: &str = "sample.duplex-channel/echo";

        /// The host's fake answer to context requests: waits `hostMs`, echoes the request and the command handle it was
        /// made for, and refuses a request made outside any command like the broker does for a stale handle.
        fn fake_context() -> (Dispatch, Arc<Mutex<Vec<String>>>) {
            let seen = Arc::new(Mutex::new(Vec::new()));
            let log = seen.clone();
            let dispatch: Dispatch = Arc::new(move |request: DispatchRequest| {
                let log = log.clone();
                Box::pin(async move {
                    let Some(handle) = request.handle else { return crate::extensions::context::failure("StaleContext") };
                    tokio::time::sleep(Duration::from_millis(request.params["hostMs"].as_u64().unwrap_or(0))).await;
                    log.lock().unwrap().push(format!("{}:{}", request.params["tag"].as_str().unwrap_or(""), handle));
                    json!({"ok": true, "value": {"tag": request.params["tag"], "handle": handle, "owner": request.owner}})
                }) as Pin<Box<dyn Future<Output = Value> + Send>>
            });
            (dispatch, seen)
        }
        async fn duplex_service(dir: &Dir, dispatch: Dispatch) -> (ServiceLifetime, ExtensionPackages, RuntimeGrants) {
            let packages = ExtensionPackages::new(&dir.0, false);
            let grants = RuntimeGrants::open(&dir.0);
            { let packages = packages.0.lock().unwrap(); packages.install(&archive(DUPLEX_MANIFEST, DUPLEX_SOURCE)).unwrap(); let digest = digest(&packages); packages.trust(DUPLEX_ID, &digest, true).unwrap(); packages.enable(DUPLEX_ID, true).unwrap(); }
            let manager = ServiceLifetime::new(vec![runtime_dir()]);
            manager.set_dispatch(dispatch);
            // The first reconcile syncs the grants file with the installed package; only then can the grant be given.
            { let packages = packages.0.lock().unwrap(); manager.reconcile(&packages, &grants); }
            grants.grant(DUPLEX_ID, PERMISSION, Scope::default()).unwrap();
            { let packages = packages.0.lock().unwrap(); manager.reconcile(&packages, &grants); }
            let deadline = Instant::now() + Duration::from_secs(20);
            while !manager.serves(DUPLEX_ID, ECHO) { assert!(Instant::now() < deadline, "the service never became ready"); tokio::time::sleep(Duration::from_millis(25)).await; }
            (manager, packages, grants)
        }

        /// R0201 acceptance: the fixture service answers two interleaved calls in either direction, receives its owned
        /// command with `context.args` in the one state it keeps, and every bound and shutdown behaves.
        #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
        async fn duplex_channel_interleaves_commands_and_host_requests_and_enforces_every_bound() {
            let dir = Dir::new();
            let (dispatch, seen) = fake_context();
            let (manager, packages, grants) = duplex_service(&dir, dispatch).await;
            let manager = Arc::new(manager);
            let call = |manager: &Arc<ServiceLifetime>, args: Value, handle: &str| { let manager = manager.clone(); let handle = handle.to_owned(); tokio::spawn(async move { manager.call_command(DUPLEX_ID, ECHO, args, Some(handle)).await }) };

            // Only the package's own commands, and only while running.
            assert_eq!(manager.call_command(DUPLEX_ID, "sample.duplex-channel/missing", json!({}), None).await, Err("PermissionDenied".into()));
            assert_eq!(manager.call_command("other.package", ECHO, json!({}), None).await, Err("HostUnavailable".into()));

            // args arrive as context.args in the shared state; the startup query was refused as stale.
            let first = manager.call_command(DUPLEX_ID, ECHO, json!({"op": "delay", "ms": 1, "tag": "one"}), Some("h1".into())).await.unwrap();
            assert_eq!(first, json!({"tag": "one", "ran": 1, "commandId": ECHO}));
            let other = manager.call_command(DUPLEX_ID, "sample.duplex-channel/other", json!({"k": [1, 2]}), None).await.unwrap();
            assert_eq!(other, json!({"other": true, "ran": 1, "args": {"k": [1, 2]}}));
            let state = manager.call_command(DUPLEX_ID, ECHO, json!({"op": "state"}), None).await.unwrap();
            assert_eq!((state["ran"].as_u64(), state["startup"].as_str()), (Some(2), Some("StaleContext")), "{state}");

            // Direction 1: a command that asks the host (400 ms) does not hold back a command started after it.
            let slow = call(&manager, json!({"op": "ask", "hostMs": 400, "tag": "slow"}), "h-slow");
            tokio::time::sleep(Duration::from_millis(100)).await;
            let started = Instant::now();
            let quick = manager.call_command(DUPLEX_ID, ECHO, json!({"op": "delay", "ms": 5, "tag": "quick"}), Some("h-quick".into())).await.unwrap();
            assert_eq!(quick["tag"], "quick"); assert!(started.elapsed() < Duration::from_millis(300), "the second call waited for the first: {:?}", started.elapsed());
            assert!(!slow.is_finished(), "the slow call is still waiting for the host");
            let slow = slow.await.unwrap().unwrap();
            assert_eq!(slow["answer"]["handle"], "h-slow", "the request was answered for the command it was made from");
            assert_eq!(slow["answer"]["owner"], DUPLEX_ID);
            // Direction 2: two requests of one command resolve in the order the host answers them, not the order sent.
            let two = manager.call_command(DUPLEX_ID, ECHO, json!({"op": "two", "first": 300, "second": 5}), Some("h-two".into())).await.unwrap();
            assert_eq!(two["resolved"], json!(["second", "first"]));
            assert!(seen.lock().unwrap().iter().any(|entry| entry == "first:h-two"));
            // Several commands in flight at once.
            let many: Vec<_> = (0..5).map(|index| call(&manager, json!({"op": "delay", "ms": 200, "tag": format!("m{index}")}), "h-many")).collect();
            for task in many { task.await.unwrap().unwrap(); }
            let state = manager.call_command(DUPLEX_ID, ECHO, json!({"op": "state"}), None).await.unwrap();
            assert!(state["peak"].as_u64().unwrap() >= 5, "{state}");

            // The 2 MiB boundary: a result of 1 MiB passes, an argument or a result over 2 MiB is LimitExceeded and the service lives.
            let big = manager.call_command(DUPLEX_ID, ECHO, json!({"op": "big", "size": 1024 * 1024}), None).await.unwrap();
            assert_eq!(big.as_str().unwrap().len(), 1024 * 1024);
            assert_eq!(manager.call_command(DUPLEX_ID, ECHO, json!({"op": "delay", "pad": "x".repeat(duplex::MAX_FRAME_BYTES)}), None).await, Err("LimitExceeded".into()));
            assert_eq!(manager.call_command(DUPLEX_ID, ECHO, json!({"op": "big", "size": duplex::MAX_FRAME_BYTES + 10}), None).await, Err("LimitExceeded".into()));
            assert_eq!(manager.call_command(DUPLEX_ID, ECHO, json!({"op": "delay", "ms": 0, "tag": "alive"}), None).await.unwrap()["tag"], "alive");

            // 64 pending service requests: 70 concurrent context requests from one command, 6 are refused by the service's own bound.
            let flood = manager.call_command(DUPLEX_ID, ECHO, json!({"op": "flood", "count": 70, "hostMs": 300}), Some("h-flood".into())).await.unwrap();
            assert_eq!(flood, json!({"ok": 64, "LimitExceeded": 6}));

            // 64 pending calls: 70 hanging commands, exactly 6 refused at once.
            let hung: Vec<_> = (0..70).map(|_| call(&manager, json!({"op": "hang"}), "h-hang")).collect();
            tokio::time::sleep(Duration::from_millis(800)).await;
            let refused = hung.iter().filter(|task| task.is_finished()).count();
            assert_eq!(refused, 6, "the 65th and later pending calls are LimitExceeded at once");

            // Disable settles every outstanding call without hanging, and nothing can be dispatched afterwards.
            packages.0.lock().unwrap().enable(DUPLEX_ID, false).unwrap();
            { let packages = packages.0.lock().unwrap(); manager.reconcile(&packages, &grants); }
            let mut codes = BTreeMap::new();
            for task in hung { let code = tokio::time::timeout(Duration::from_secs(8), task).await.expect("a call hung after disable").unwrap().unwrap_err(); *codes.entry(code).or_insert(0) += 1; }
            assert_eq!(codes, BTreeMap::from([("Cancelled".to_owned(), 64), ("LimitExceeded".to_owned(), 6)]));
            assert!(manager.wait_idle(Duration::from_secs(5)).await);
            assert_eq!(manager.call_command(DUPLEX_ID, ECHO, json!({}), None).await, Err("HostUnavailable".into()));
        }

        /// Loss of the `runtime.service` grant (trust loss) settles a pending call the same way.
        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn duplex_channel_settles_calls_when_the_grant_is_revoked() {
            let dir = Dir::new();
            let (dispatch, _) = fake_context();
            let (manager, _packages, grants) = duplex_service(&dir, dispatch).await;
            let manager = Arc::new(manager);
            let pending = { let manager = manager.clone(); tokio::spawn(async move { manager.call_command(DUPLEX_ID, ECHO, json!({"op": "hang"}), None).await }) };
            tokio::time::sleep(Duration::from_millis(300)).await;
            grants.revoke(DUPLEX_ID, PERMISSION).unwrap();
            assert_eq!(tokio::time::timeout(Duration::from_secs(8), pending).await.expect("hung").unwrap(), Err("Cancelled".into()));
            assert!(manager.wait_idle(Duration::from_secs(5)).await);
        }

        const EVENTS_MANIFEST: &str = include_str!("../../../tests/fixtures/extensions/runtime-workspace-events/extension.json");
        const EVENTS_SOURCE: &str = include_str!("../../../tests/fixtures/extensions/runtime-workspace-events/main.cjs");
        const EVENTS_ID: &str = "sample.workspace-events";
        const CONTROL: &str = "sample.workspace-events/control";

        async fn events_service(dir: &Dir) -> (ServiceLifetime, ExtensionPackages, Arc<RuntimeGrants>) {
            let packages = ExtensionPackages::new(&dir.0, false);
            let grants = Arc::new(RuntimeGrants::open(&dir.0));
            { let packages = packages.0.lock().unwrap(); packages.install(&archive(EVENTS_MANIFEST, EVENTS_SOURCE)).unwrap(); let digest = digest(&packages); packages.trust(EVENTS_ID, &digest, true).unwrap(); packages.enable(EVENTS_ID, true).unwrap(); }
            let manager = ServiceLifetime::new(vec![runtime_dir()]);
            let (dispatch, _) = fake_context();
            manager.set_dispatch(dispatch);
            let gated = grants.clone();
            manager.events().set_gate(Arc::new(move |owner, version, project| crate::extensions::runtime_service_lifetime::runtime_workspace_events::allowed(&gated, owner, version, project)));
            { let packages = packages.0.lock().unwrap(); manager.reconcile(&packages, &grants); }
            let projects = |names: &[&str]| Scope { projects: Some(names.iter().map(|name| (*name).to_owned()).collect()), ..Scope::default() };
            grants.grant(EVENTS_ID, PERMISSION, Scope::default()).unwrap();
            grants.grant(EVENTS_ID, "events.workspace", projects(&["A", "B"])).unwrap();
            { let packages = packages.0.lock().unwrap(); manager.reconcile(&packages, &grants); }
            let deadline = Instant::now() + Duration::from_secs(20);
            while !manager.serves(EVENTS_ID, CONTROL) || manager.events().listeners(EVENTS_ID) < 14 { assert!(Instant::now() < deadline, "the service never subscribed"); tokio::time::sleep(Duration::from_millis(25)).await; }
            (manager, packages, grants)
        }
        async fn control(manager: &ServiceLifetime, args: Value) -> Value { manager.call_command(EVENTS_ID, CONTROL, args, None).await.unwrap() }
        async fn wait_received(manager: &ServiceLifetime, what: &str, enough: impl Fn(&[Value]) -> bool) -> Vec<Value> {
            let deadline = Instant::now() + Duration::from_secs(20);
            loop {
                let seen = control(manager, json!({"op": "received"})).await["received"].as_array().cloned().unwrap_or_default();
                if enough(&seen) { return seen; }
                assert!(Instant::now() < deadline, "timed out waiting for {what}: {} events", seen.len());
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }

        /// R0202 acceptance: a real service sees the thirteen events in sequence, an out-of-grant project delivers
        /// nothing, a paused consumer overflows into a gap and resynchronizes, and stop leaves no listener.
        #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
        async fn workspace_events_arrive_in_order_scoped_bounded_and_leave_no_listener() {
            let dir = Dir::new();
            let (manager, packages, grants) = events_service(&dir).await;
            let hub = manager.events();
            let script = [
                json!({"kind": "project.opened", "projectId": "A"}),
                json!({"kind": "task.created", "taskId": "t1", "projectId": "A", "harness": "claude", "startedBy": "user"}),
                json!({"kind": "task.shown", "windowId": "w1", "taskId": "t1", "projectId": "A"}),
                json!({"kind": "turn.started", "taskId": "t1", "projectId": "A", "index": 1}),
                json!({"kind": "turn.finished", "taskId": "t1", "projectId": "A", "index": 1}),
                json!({"kind": "turn.failed", "taskId": "t1", "projectId": "A", "index": 2}),
                json!({"kind": "task.idle", "taskId": "t1", "projectId": "A"}),
                json!({"kind": "task.compacted", "taskId": "t1", "projectId": "A"}),
                json!({"kind": "task.stopped", "taskId": "t1", "projectId": "A", "by": "user"}),
                json!({"kind": "task.removed", "taskId": "t1", "projectId": "A"}),
                json!({"kind": "settings.changed", "page": "main", "revision": 2}),
                json!({"kind": "app.focus", "focused": true}),
                json!({"kind": "project.closed", "projectId": "A"}),
            ];
            for (position, event) in script.iter().enumerate() {
                // Events of a project outside the grant, interleaved, are never delivered.
                assert_eq!(hub.publish(&json!({"kind": "task.idle", "taskId": "x", "projectId": "C"}), None, 1).unwrap(), crate::extensions::runtime_service_lifetime::runtime_workspace_events::Published::default());
                assert_eq!(hub.publish(event, None, 100 + position as u64).unwrap().queued, 1, "{event}");
            }
            let seen = wait_received(&manager, "the thirteen events", |seen| seen.len() >= script.len()).await;
            assert_eq!(seen.len(), 13);
            assert_eq!(seen.iter().map(|event| event["kind"].as_str().unwrap()).collect::<Vec<_>>(), script.iter().map(|event| event["kind"].as_str().unwrap()).collect::<Vec<_>>());
            assert_eq!(seen.iter().map(|event| event["sequence"].as_u64().unwrap()).collect::<Vec<_>>(), (1..=13).collect::<Vec<_>>());
            assert!(seen.iter().all(|event| event["schemaVersion"] == 1 && event.get("projectId") != Some(&json!("C"))));
            assert_eq!(control(&manager, json!({"op": "received"})).await["overlap"], 1, "handlers never overlap: order is the order of the pipe");

            // Unsubscribing one kind leaves the others; nothing of that kind is queued any more.
            assert_eq!(control(&manager, json!({"op": "off", "kind": "task.idle"})).await["listening"].as_array().unwrap().len(), 13);
            assert_eq!(hub.listeners(EVENTS_ID), 13);
            assert_eq!(hub.publish(&json!({"kind": "task.idle", "taskId": "t2", "projectId": "A"}), None, 1).unwrap().queued, 0);
            control(&manager, json!({"op": "on", "kind": "task.idle"})).await;
            for _ in 0..200 { if hub.listeners(EVENTS_ID) == 14 { break; } tokio::time::sleep(Duration::from_millis(25)).await; }
            assert_eq!(hub.listeners(EVENTS_ID), 14);

            // A consumer that cannot keep up: 400 events overflow the bounded queues into a gap, the newest survive.
            control(&manager, json!({"op": "reset"})).await; control(&manager, json!({"op": "pause"})).await;
            for index in 0..400u64 { hub.publish(&json!({"kind": "turn.started", "taskId": "t3", "projectId": "B", "index": index}), None, 1_000 + index).unwrap(); }
            for _ in 0..200 { if hub.pending(EVENTS_ID) == 0 { break; } tokio::time::sleep(Duration::from_millis(25)).await; }
            tokio::time::sleep(Duration::from_millis(500)).await;
            control(&manager, json!({"op": "resume"})).await;
            let seen = wait_received(&manager, "the gap and the newest event", |seen| seen.iter().any(|event| event["kind"] == "gap") && seen.iter().any(|event| event["index"] == 399)).await;
            let gaps: Vec<&Value> = seen.iter().filter(|event| event["kind"] == "gap").collect();
            assert!(!gaps.is_empty() && gaps.iter().all(|gap| gap["dropped"].as_u64().unwrap() > 0), "{gaps:?}");
            let turns = seen.iter().filter(|event| event["kind"] == "turn.started").count();
            assert!(turns >= 1 && turns < 400, "the oldest were dropped: {turns}");
            let sequences: Vec<u64> = seen.iter().map(|event| event["sequence"].as_u64().unwrap()).collect();
            assert!(sequences.windows(2).all(|pair| pair[0] < pair[1]), "order holds across the loss: {sequences:?}");
            // Resynchronized: a new event arrives right after the gap.
            hub.publish(&json!({"kind": "app.focus", "focused": false}), None, 5_000).unwrap();
            wait_received(&manager, "the event after the gap", |seen| seen.last().is_some_and(|event| event["kind"] == "app.focus" && event["focused"] == false)).await;

            // Narrowing the grant to A stops B at once; revoking the grant stops everything.
            let only_a = Scope { projects: Some(["A".to_owned()].into_iter().collect()), ..Scope::default() };
            grants.narrow(EVENTS_ID, "events.workspace", only_a).unwrap();
            assert_eq!(hub.publish(&json!({"kind": "project.opened", "projectId": "B"}), None, 1).unwrap().queued, 0);
            assert_eq!(hub.publish(&json!({"kind": "project.opened", "projectId": "A"}), None, 1).unwrap().queued, 1);

            // Disable ends the service and its listeners; enabling starts a new one with a fresh, empty subscription.
            packages.0.lock().unwrap().enable(EVENTS_ID, false).unwrap();
            { let packages = packages.0.lock().unwrap(); manager.reconcile(&packages, &grants); }
            assert!(manager.wait_idle(Duration::from_secs(5)).await);
            assert_eq!((hub.attached(), hub.listeners(EVENTS_ID), hub.pending(EVENTS_ID)), (0, 0, 0), "a stopped service leaves zero listeners");
            assert_eq!(hub.publish(&json!({"kind": "project.opened", "projectId": "A"}), None, 1).unwrap().queued, 0);
            packages.0.lock().unwrap().enable(EVENTS_ID, true).unwrap();
            { let packages = packages.0.lock().unwrap(); manager.reconcile(&packages, &grants); }
            let deadline = Instant::now() + Duration::from_secs(20);
            while hub.listeners(EVENTS_ID) < 14 { assert!(Instant::now() < deadline, "the restarted service never subscribed"); tokio::time::sleep(Duration::from_millis(25)).await; }
            assert_eq!(hub.pending(EVENTS_ID), 0);
            assert_eq!(control(&manager, json!({"op": "received"})).await["received"].as_array().unwrap().len(), 0, "a restart starts from nothing");
            manager.stop_all(StopReason::Quit);
            assert!(manager.wait_idle(Duration::from_secs(5)).await);
            assert_eq!(hub.attached(), 0);
        }

        /// A service whose function never settles stays "starting" and is not waited for; a service that throws is
        /// a visible failure that leaves the package enabled. Neither takes a short-activation slot of its package.
        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn hanging_and_broken_services_never_delay_reconcile_or_take_a_short_activation_slot() {
            let runtime = supervisor::Runtime::packaged(&runtime_dir()).unwrap();
            let dir = Dir::new();
            let packages = ExtensionPackages::new(&dir.0, false);
            let grants = RuntimeGrants::open(&dir.0);
            { let packages = packages.0.lock().unwrap(); packages.install(&archive(MANIFEST, SOURCE)).unwrap(); let digest = digest(&packages); packages.trust(ID, &digest, true).unwrap(); packages.enable(ID, true).unwrap(); }
            let reconcile = |manager: &ServiceLifetime| { let packages = packages.0.lock().unwrap(); let started = Instant::now(); manager.reconcile(&packages, &grants); started.elapsed() };
            let hanging = ServiceLifetime::new(vec![runtime_dir()]).with_env(&[("PANDA_FIXTURE_MODE", "hang")]);
            reconcile(&hanging);
            grants.grant(ID, PERMISSION, Scope::default()).unwrap();
            assert!(reconcile(&hanging) < Duration::from_millis(500));
            wait_for(&hanging, "the status line of a hanging service", |service| service["status"].is_object()).await;
            tokio::time::sleep(Duration::from_millis(1500)).await;
            assert_eq!(service(&hanging)["state"], "starting", "a service function that never settles is never waited for");
            // The same package's short activation runs beside its service: services hold no activation slot.
            let source = packages.0.lock().unwrap().executable_source(ID).unwrap().1;
            let context = json!({"schemaVersion":1,"windowId":"main","surfaceId":"panda.workspace.header.actions","commandId":"sample.service-lifetime/long","revision":1});
            assert_eq!(supervisor::run(&runtime, &source, context, Arc::new(AtomicBool::new(false)), |_, _| json!({"ok":true,"value":null})).await.unwrap(), Vec::<Value>::new());
            hanging.stop_all(StopReason::Quit); assert!(hanging.wait_idle(STOP_GRACE + Duration::from_secs(1)).await);
            assert_eq!(service(&hanging)["lastStop"], json!({"reason": "quit", "acknowledged": true}));

            let broken = ServiceLifetime::new(vec![runtime_dir()]).with_env(&[("PANDA_FIXTURE_MODE", "throw")]);
            assert!(reconcile(&broken) < Duration::from_millis(500));
            let failed = wait_for(&broken, "a broken service", |service| service["state"] == "failed").await;
            assert_eq!(failed["error"], "HostUnavailable"); assert_eq!(failed["starts"], json!({"appStart": 1}));
            assert_eq!(serde_json::to_value(packages.0.lock().unwrap().snapshot()).unwrap()["packages"][0]["enabled"], true);
            reconcile(&broken); assert_eq!(service(&broken)["starts"], json!({"appStart": 1}), "no automatic restart in this slice (R0106)");
            broken.retry(ID); reconcile(&broken);
            wait_for(&broken, "the explicit retry", |service| service["state"] == "failed" && service["starts"] == json!({"appStart": 1, "enable": 1})).await;
        }
    }
}
