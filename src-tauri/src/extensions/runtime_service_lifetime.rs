//! Background services of trusted packages (`runtime.service`, runtime phase R1, slice R0104).
//!
//! A package that declares `"runtime": { ..., "service": { "start": "onEnable" } }` and holds the native
//! `runtime.service` grant gets one long-lived Node process: started at app start and on enable, only for an
//! enabled package whose executable content is trusted; stopped on disable, uninstall, a changed archive digest
//! (update), loss of trust or of the grant, safe mode and quit. The host asks the service to stop, gives its
//! `onStop` handlers at most two seconds, then ends the whole process tree (the job object).
//!
//! The Running list, the user's Stop (`held` until Retry or enable) and the quit confirmation are R0107
//! (`runtime_service_status.rs`, `ServiceLifetime::stop`). Crash restart with
//! backoff, parking, the start state and memory measurement are R0106 (`runtime_service_supervision.rs`, applied in
//! `supervise` and `run` below).
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
// Package settings and the content resources of tasks, served to the service natively (R0203).
#[path = "runtime_content_resources.rs"]
pub mod runtime_content_resources;
// Usage per turn, limits, accounts and metrics, served to the service natively (R0204).
#[path = "runtime_usage_resources.rs"]
pub mod runtime_usage_resources;
// Held credentials used without being read, the activity list and account switching (R0805).
#[path = "runtime_held_credentials.rs"]
pub mod runtime_held_credentials;
// Crash restart with backoff, parking, the start state and memory measurement (R0106).
#[path = "runtime_service_supervision.rs"]
pub mod runtime_service_supervision;
use self::runtime_service_supervision::{self as supervision, Clock, CrashHistory, Decision, Memory};
// The Running list of the Extensions page, its Stop/Retry/Data size controls and the extension part of the quit
// account (R0107).
#[path = "runtime_service_status.rs"]
pub mod runtime_service_status;
// Services placed beside remote and headless executors, their Connect methods and the desktop's view of them (R0108).
#[path = "runtime_executor_placement.rs"]
pub mod runtime_executor_placement;
// The app's own workspace settings, read and changed by services with `workspace.settings` (R0407).
#[path = "runtime_workspace_settings.rs"]
pub mod runtime_workspace_settings;
// Bots and shared channels, managed by services with `workspace.manage` (R0406).
#[path = "runtime_workspace_automation.rs"]
pub mod runtime_workspace_automation;
#[path = "runtime_workspace_schedules.rs"]
pub mod runtime_workspace_schedules;
use super::{packages::Packages, runtime_grants::{RuntimeGrants, Target, Work}, supervisor};
use serde_json::{json, Value};
use super::packages::runtime_code_folders;
use std::{collections::{BTreeMap, BTreeSet}, ffi::OsString, future::Future, path::PathBuf, pin::Pin, process::Stdio, sync::{Arc, Mutex}, time::{Duration, Instant}};
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
enum State { Starting, Running, Stopping, Failed, Restarting, Parked }
impl State {
    fn as_str(self) -> &'static str {
        match self { Self::Starting => "starting", Self::Running => "running", Self::Stopping => "stopping", Self::Failed => "failed", Self::Restarting => "restarting", Self::Parked => "parked" }
    }
    /// No process belongs to the entry: a start that never reached a process, a scheduled crash restart or a parked
    /// service (R0106).
    fn idle(self) -> bool { matches!(self, Self::Failed | Self::Restarting | Self::Parked) }
}
struct Entry {
    generation: u64, version: String, digest: String, reason: StartReason, restarts: u32, state: State,
    status: Option<(String, bool)>, error: Option<String>, stop: watch::Sender<Option<StopReason>>,
    /// The package's own `runCommand` ids (the only commands that may be dispatched into this service).
    commands: Vec<String>, calls: mpsc::Sender<HostCall>,
    /// Supervision (R0106): the crashes since the user last started it, when this process started and became ready
    /// (clock time), the scheduled restart `(delay, at)` and whether it is due, the parking explanation and the
    /// measured memory.
    history: CrashHistory, started_at: Duration, ready_at: Option<Duration>, restart: Option<(Duration, Duration)>, due: bool, parked: Option<String>, memory: Option<Memory>,
}
#[derive(Default)]
struct Counters { starts: BTreeMap<&'static str, u64>, stops: BTreeMap<&'static str, u64>, last_stop: Option<(&'static str, bool)> }
/// A start that waits for the previous process of the same package to end (one service per package).
/// `restarts` and `history` carry a crash restart's count and crash history into the next process (R0106).
struct Queued { want: Want, source: String, reason: StartReason, work: Work, code: Code, restarts: u32, history: CrashHistory }
/// What the service's code directory and data directory need (R0105): the app data directory, the archive checksum,
/// the entry point and code folders read from the stored archive, and the `storage.private` grant work (absent when
/// the grant is not held; cancelled when it is revoked).
struct Code { app_data: PathBuf, checksum: String, files: Vec<(String, Vec<u8>)>, storage: Option<Work> }
/// `held` (R0107): services the user stopped; nothing starts them until `retry` (Retry, enable, development reload)
/// clears them, or their package is disabled or uninstalled.
#[derive(Default)]
struct Inner { launched: bool, quitting: bool, next: u64, entries: BTreeMap<String, Entry>, counters: BTreeMap<String, Counters>, queued: BTreeMap<String, Queued>, held: BTreeSet<String> }

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
    /// The supervisor's time source (a `ManualClock` in tests, R0106).
    clock: Arc<dyn Clock>,
    /// What runs when a crash restart is due: the app reconciles (tests reconcile their own packages).
    restart_hook: Arc<Mutex<Option<RestartHook>>>,
    /// What runs, with the owner, whenever a service process ends for any reason (R0205: its live items go).
    ended_hook: Arc<Mutex<Option<EndedHook>>>,
}
/// Runs when a scheduled crash restart is due.
pub type RestartHook = Arc<dyn Fn() + Send + Sync>;
/// Runs with the package id when its service process has ended.
pub type EndedHook = Arc<dyn Fn(&str) + Send + Sync>;
fn millis(duration: Duration) -> u64 { u64::try_from(duration.as_millis()).unwrap_or(u64::MAX) }

impl ServiceLifetime {
    pub fn new(runtimes: Vec<PathBuf>) -> Self {
        Self { inner: Arc::default(), changed: Arc::default(), runtimes: Arc::new(runtimes), env: Arc::default(), parent: Arc::default(), dispatch: Arc::default(), events: Arc::default(), clock: Arc::new(supervision::SystemClock::default()), restart_hook: Arc::default(), ended_hook: Arc::default() }
    }
    /// Replaces the supervisor's clock (tests: backoff and the crash window on a controlled clock).
    #[cfg(test)]
    pub fn with_clock(mut self, clock: Arc<dyn Clock>) -> Self {
        self.clock = clock;
        self
    }
    /// Installs what runs when a crash restart is due (the app reconciles).
    pub fn set_restart_hook(&self, hook: RestartHook) { if let Ok(mut slot) = self.restart_hook.lock() { *slot = Some(hook); } }
    /// Installs what runs when a service process ends (the app clears the package's live items).
    pub fn set_ended_hook(&self, hook: EndedHook) { if let Ok(mut slot) = self.ended_hook.lock() { *slot = Some(hook); } }
    /// Another handle on the same manager, for the tasks it spawns.
    fn share(&self) -> Self {
        Self { inner: self.inner.clone(), changed: self.changed.clone(), runtimes: self.runtimes.clone(), env: self.env.clone(), parent: self.parent.clone(), dispatch: self.dispatch.clone(), events: self.events.clone(), clock: self.clock.clone(), restart_hook: self.restart_hook.clone(), ended_hook: self.ended_hook.clone() }
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
    /// Hands a panel message or event to the running service of `id` (host call `panel`, R0303). The same bounds as an
    /// owned command (64 pending); settled when the process ends.
    pub async fn call_panel(&self, id: &str, params: Value) -> Result<Value, String> {
        let calls = {
            let inner = self.inner.lock().map_err(|_| "HostUnavailable".to_owned())?;
            inner.entries.get(id).filter(|entry| entry.state == State::Running).ok_or("HostUnavailable")?.calls.clone()
        };
        let (reply, answer) = oneshot::channel();
        calls.try_send(HostCall { method: "panel", params, handle: None, reply }).map_err(|error| match error { mpsc::error::TrySendError::Full(_) => "LimitExceeded", mpsc::error::TrySendError::Closed(_) => "HostUnavailable" })?;
        answer.await.unwrap_or_else(|_| Err("HostUnavailable".into()))
    }
    /// Hands one hook delivery (R0503) to the running service of `id` as a host call, in the order of the calls, and
    /// returns without waiting: the node host answers it at once and runs the handlers in order; nobody reads what a
    /// handler returns. `HostUnavailable` when no process runs, `LimitExceeded` when the channel is full.
    pub fn send_hook(&self, id: &str, params: Value) -> Result<oneshot::Receiver<Result<Value, String>>, &'static str> {
        let inner = self.inner.lock().map_err(|_| "HostUnavailable")?;
        let entry = inner.entries.get(id).filter(|entry| entry.state == State::Running).ok_or("HostUnavailable")?;
        let (reply, answer) = oneshot::channel();
        entry.calls.try_send(HostCall { method: "hook", params, handle: None, reply }).map_err(|error| match error { mpsc::error::TrySendError::Full(_) => "LimitExceeded", mpsc::error::TrySendError::Closed(_) => "HostUnavailable" })?;
        Ok(answer)
    }
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
    /// restarts with `update`. A failed start and a parked service are not restarted here; `retry` (enable,
    /// development reload) or an update does it. A crash restart whose backoff has passed starts with `restart` (R0106).
    pub fn reconcile(&self, packages: &Packages, grants: &RuntimeGrants) {
        let snapshot = serde_json::to_value(packages.snapshot()).unwrap_or(Value::Null);
        let Ok(mut inner) = self.inner.lock() else { return };
        if inner.quitting { return; }
        let first = !std::mem::replace(&mut inner.launched, true);
        // Package-state reasons first, before the grants sync cancels the services' grant work, so that a disable,
        // an untrust or an update is reported as itself and not as a grant loss.
        let mut updated = Self::stop_where(&mut inner, &snapshot, |_: &str, _: &str| true);
        // Safe mode loads no package, so its snapshot is empty: never let that erase the grants file.
        if snapshot["safeMode"] != true { let _ = grants.sync(&snapshot); }
        // Placement (R0108): a desktop runs every kind; a headless host runs only workspace-kind services, beside
        // its executor (a `ui` package's code belongs to a window).
        let here = runtime_executor_placement::services_here(&snapshot, runtime_executor_placement::this_executor());
        let granted = |id: &str, version: &str| here.contains(id) && grants.check(id, version, PERMISSION, &Target::default()).is_ok();
        updated.extend(Self::stop_where(&mut inner, &snapshot, granted));
        let wanted = desired(&snapshot, granted);
        // A user's stop (R0107) lasts until Retry or enable; a disable or an uninstall ends it, so the next enable or
        // install starts the service normally. Anything else (a grant change, an update, another reconcile) keeps it.
        let installed_enabled = |id: &String| snapshot["packages"].as_array().into_iter().flatten().any(|package| package["manifest"]["id"] == id.as_str() && package["enabled"] == true);
        // Safe mode loads no package: its empty snapshot ends nothing.
        if snapshot["safeMode"] != true { inner.held.retain(installed_enabled); }
        let held = inner.held.clone();
        inner.queued.retain(|id, queued| !held.contains(id) && wanted.get(id).is_some_and(|want| want.digest == queued.want.digest));
        for (id, want) in wanted.into_iter().filter(|(id, _)| !held.contains(id)) {
            // A start behind a process that is still stopping waits for it (one service per package).
            let (reason, restarts, history) = match inner.entries.get(&id) {
                None if updated.contains(&id) => (StartReason::Update, 0, CrashHistory::default()),
                None => (if first { StartReason::AppStart } else { StartReason::Enable }, 0, CrashHistory::default()),
                Some(entry) if entry.state == State::Stopping && !inner.queued.contains_key(&id) => (if entry.digest != want.digest { StartReason::Update } else { StartReason::Enable }, 0, CrashHistory::default()),
                // A crash restart whose backoff has passed, of the same content: the crash history goes on (R0106).
                Some(entry) if entry.state == State::Restarting && entry.due && entry.digest == want.digest => (StartReason::Restart, entry.restarts.saturating_add(1), entry.history.clone()),
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
            let queued = Queued { want, source, reason, work, code, restarts, history };
            if inner.entries.get(&id).is_some_and(|entry| entry.state == State::Stopping) { inner.queued.insert(id, queued); }
            else { self.start(&mut inner, id, queued); }
        }
        drop(inner);
        self.changed.notify_waiters();
    }

    /// Returns the packages whose idle entry (no process) was removed for an update: their next start is `update`.
    fn stop_where(inner: &mut Inner, snapshot: &Value, granted: impl Fn(&str, &str) -> bool + Copy) -> Vec<String> {
        let stopping: Vec<(String, StopReason)> = inner.entries.iter()
            .filter(|(_, entry)| entry.state != State::Stopping)
            .filter_map(|(id, entry)| stop_reason(snapshot, id, &entry.digest, granted).map(|reason| (id.clone(), reason)))
            .collect();
        let mut updated = Vec::new();
        for (id, reason) in stopping {
            let Some(entry) = inner.entries.get_mut(&id) else { continue };
            // No process: a failed start, a parked service or a scheduled restart, which is cancelled here (its timer
            // finds nothing to restart).
            if entry.state.idle() { inner.entries.remove(&id); if reason == StopReason::Update { updated.push(id); } continue; }
            entry.state = State::Stopping;
            let _ = entry.stop.send(Some(reason));
        }
        updated
    }

    /// Clears a failed start, a scheduled crash restart or a parked service so the next `reconcile` starts it again
    /// at once, with a clean crash history (the explicit retry of enable and development reload).
    /// It also ends a user's stop (R0107).
    pub fn retry(&self, id: &str) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.held.remove(id);
            if inner.entries.get(id).is_some_and(|entry| entry.state.idle()) { inner.entries.remove(id); }
        }
    }

    /// The user's Stop (R0107): a starting or running service gets `onStop("stop")` and ends; a scheduled crash
    /// restart is cancelled; a stopping one loses the start queued behind it. In every case the service stays stopped
    /// (`held`) until `retry` (Retry, enable) or a disable or uninstall. `NotFound` for a package with no service;
    /// `Conflict` when nothing runs or is scheduled (stopped, failed, parked).
    pub fn stop(&self, id: &str) -> Result<(), &'static str> {
        let mut inner = self.inner.lock().map_err(|_| "HostUnavailable")?;
        let state = match inner.entries.get(id) {
            Some(entry) => entry.state,
            None if inner.counters.contains_key(id) => return Err("Conflict"),
            None => return Err("NotFound"),
        };
        match state {
            State::Starting | State::Running => {
                if let Some(entry) = inner.entries.get_mut(id) { entry.state = State::Stopping; let _ = entry.stop.send(Some(StopReason::Stop)); }
            }
            State::Restarting => {
                // No process: the timer finds nothing to restart. No `onStop` ran.
                inner.entries.remove(id);
                let counters = inner.counters.entry(id.to_owned()).or_default();
                *counters.stops.entry(StopReason::Stop.as_str()).or_default() += 1;
                counters.last_stop = Some((StopReason::Stop.as_str(), false));
            }
            State::Stopping => {}
            State::Failed | State::Parked => return Err("Conflict"),
        }
        inner.queued.remove(id);
        inner.held.insert(id.to_owned());
        drop(inner);
        self.changed.notify_waiters();
        Ok(())
    }

    /// Asks every service to stop with `reason`; after `quit` nothing starts again in this manager.
    /// Returns at once; see `wait_idle`.
    pub fn stop_all(&self, reason: StopReason) {
        if let Ok(mut inner) = self.inner.lock() {
            if reason == StopReason::Quit { inner.quitting = true; }
            inner.queued.clear();
            inner.entries.retain(|_, entry| !entry.state.idle());
            for entry in inner.entries.values_mut() { if entry.state != State::Stopping { entry.state = State::Stopping; let _ = entry.stop.send(Some(reason)); } }
        }
        self.changed.notify_waiters();
    }

    /// Waits until no service process is left, at most `limit`. `true` when none is left.
    pub async fn wait_idle(&self, limit: Duration) -> bool {
        let deadline = tokio::time::Instant::now() + limit;
        loop {
            let notified = self.changed.notified();
            if self.inner.lock().map(|inner| inner.entries.values().all(|entry| entry.state.idle())).unwrap_or(true) { return true; }
            if tokio::time::timeout_at(deadline, notified).await.is_err() { return false; }
        }
    }

    /// The read projection (`extensions_service_lifetime`): state, start reason, status line, last error and the
    /// start/stop counters of every lifetime reason, and the supervision object (R0106: crashes in the window, the
    /// scheduled restart, the parking explanation, the start state and the measured memory). Nothing secret, no
    /// package output beyond its status line.
    pub fn projection(&self) -> Value {
        let now = self.clock.now();
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
                "held": inner.held.contains(id.as_str()),
                "reason": entry.map(|entry| entry.reason.as_str()),
                "restarts": entry.map_or(0, |entry| entry.restarts),
                "status": entry.and_then(|entry| entry.status.as_ref()).map(|(text, working)| json!({"text": text, "working": working})),
                "error": entry.and_then(|entry| entry.error.clone()),
                "starts": counters.map(|counters| json!(counters.starts)).unwrap_or_else(|| json!({})),
                "stops": counters.map(|counters| json!(counters.stops)).unwrap_or_else(|| json!({})),
                "lastStop": counters.and_then(|counters| counters.last_stop).map(|(reason, acknowledged)| json!({"reason": reason, "acknowledged": acknowledged})),
                "supervision": entry.map(|entry| {
                    let restart = entry.restart.filter(|_| entry.state == State::Restarting);
                    json!({
                        "crashes": entry.history.recent(now),
                        "backoffMs": restart.map(|(delay, _)| millis(delay)),
                        "restartInMs": restart.map(|(_, at)| millis(at.saturating_sub(now))),
                        "parked": entry.parked,
                        "startup": matches!(entry.state, State::Starting | State::Running).then(|| supervision::start_state(entry.state == State::Starting, entry.started_at, entry.ready_at, now)),
                        "memory": entry.memory.map(|memory| memory.projection()),
                    })
                }),
            })
        }).collect();
        json!({"schemaVersion":1,"available":true,"services":services})
    }

    fn start(&self, inner: &mut Inner, id: String, mut queued: Queued) {
        inner.next += 1;
        let generation = inner.next;
        let (stop, stopped) = watch::channel(None);
        let (calls, incoming_calls) = mpsc::channel(CALL_QUEUE);
        *inner.counters.entry(id.clone()).or_default().starts.entry(queued.reason.as_str()).or_default() += 1;
        inner.entries.insert(id.clone(), Entry { generation, version: queued.want.version.clone(), digest: queued.want.digest.clone(), reason: queued.reason, restarts: queued.restarts, state: State::Starting, status: None, error: None, stop, commands: queued.want.commands.clone(), calls,
            history: std::mem::take(&mut queued.history), started_at: self.clock.now(), ready_at: None, restart: None, due: false, parked: None, memory: None });
        let manager = self.share();
        tauri::async_runtime::spawn(async move { manager.supervise(id, generation, queued, stopped, incoming_calls).await });
    }

    async fn supervise(self, id: String, generation: u64, queued: Queued, stopped: watch::Receiver<Option<StopReason>>, mut calls: mpsc::Receiver<HostCall>) {
        let Queued { want, source, reason, work, code, restarts, .. } = queued;
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
                let init = json!({"lifetime": {"reason": reason.as_str(), "restarts": restarts, "commands": want.commands}});
                let parent: Vec<(OsString, OsString)> = match self.parent.as_ref() { Some(parent) => parent.clone(), None => std::env::vars_os().collect() };
                let code = ServiceCode { directory, entry, parent, app_data: app_data.clone(), storage: storage.as_ref() };
                // The subscription lives exactly as long as the process: a stop, crash, disable or safe mode leaves no listener.
                let wake = self.events.attach(&id, &want.version, generation);
                let outcome = run(&runtime, &source, init, stopped, &work, Wiring { owner: id.clone(), dispatch, calls: &mut calls, env: &self.env, subscriptions: self.events.clone(), wake, code }, events).await;
                self.events.detach(&id, generation);
                outcome
            }
            (None, _) => Outcome::Unstarted("UnsupportedRuntime"),
            (Some(_), Err(code)) => Outcome::Unstarted(code),
        };
        drop(storage);
        // Whatever ended the process, the live items it registered end with it.
        if let Some(hook) = self.ended_hook.lock().ok().and_then(|hook| hook.clone()) { hook(&id); }
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
                Outcome::Unstarted(code) => {
                    // No process was reached: the package stays enabled with a visible error until enable retries it.
                    let counters = inner.counters.entry(id.clone()).or_default();
                    *counters.stops.entry("crash").or_default() += 1;
                    if let Some(entry) = inner.entries.get_mut(&id) { entry.state = State::Failed; entry.error = Some(code.to_owned()); }
                    if let Some(next) = inner.queued.remove(&id) { inner.entries.remove(&id); self.start(&mut inner, id, next); }
                }
                Outcome::Failed(code) => {
                    // A crash (R0106): restart after the backoff, or park after five crashes in ten minutes. The
                    // package stays enabled; nothing else waits for it.
                    let now = self.clock.now();
                    *inner.counters.entry(id.clone()).or_default().stops.entry("crash").or_default() += 1;
                    if let Some(next) = inner.queued.remove(&id) { inner.entries.remove(&id); self.start(&mut inner, id, next); }
                    else {
                        let decision = inner.entries.get_mut(&id).map(|entry| { entry.error = Some(code.to_owned()); entry.memory = None; entry.history.record(&id, now, code) });
                        match decision {
                            Some(Decision::Restart { delay, at }) => {
                                if let Some(entry) = inner.entries.get_mut(&id) { entry.state = State::Restarting; entry.restart = Some((delay, at)); entry.due = false; }
                                let manager = self.share();
                                tauri::async_runtime::spawn(async move { manager.clock.sleep_until(at).await; manager.restart_due(&id, generation); });
                            }
                            Some(Decision::Park { explanation }) => {
                                if let Some(entry) = inner.entries.get_mut(&id) { entry.state = State::Parked; entry.parked = Some(explanation); entry.restart = None; }
                                let counters = inner.counters.entry(id).or_default();
                                *counters.stops.entry("park").or_default() += 1;
                                // The process already ended: no `onStop` ran for the parking.
                                counters.last_stop = Some((StopReason::Park.as_str(), false));
                            }
                            None => {}
                        }
                    }
                }
            }
        }
        drop(inner);
        self.changed.notify_waiters();
    }

    /// A crash restart's backoff has passed: mark it due and run the restart hook, which reconciles and so starts it
    /// when it is still wanted. A disable, safe mode or retry in between removed the entry: nothing happens.
    fn restart_due(&self, id: &str, generation: u64) {
        let due = self.inner.lock().ok().is_some_and(|mut inner| inner.entries.get_mut(id).filter(|entry| entry.generation == generation && entry.state == State::Restarting).map(|entry| entry.due = true).is_some());
        self.changed.notify_waiters();
        if !due { return; }
        let hook = self.restart_hook.lock().ok().and_then(|hook| hook.clone());
        if let Some(hook) = hook { hook(); }
    }

    fn event(&self, id: &str, generation: u64, event: Event) {
        let now = self.clock.now();
        if let Ok(mut inner) = self.inner.lock() {
            if let Some(entry) = inner.entries.get_mut(id).filter(|entry| entry.generation == generation) {
                match event {
                    Event::Ready => if entry.state == State::Starting { entry.state = State::Running; entry.ready_at = Some(now); },
                    Event::Status(text, working) => entry.status = Some((text, working)),
                    Event::Memory(bytes) => entry.memory.get_or_insert_with(Memory::default).sample(bytes),
                }
            }
        }
        self.changed.notify_waiters();
    }
}

enum Event { Ready, Status(String, bool), Memory(u64) }
/// `Failed` is a crash of a process that ran (supervised, R0106); `Unstarted` never reached a process.
#[derive(Debug, PartialEq)]
enum Outcome { Stopped(StopReason, bool), Failed(&'static str), Unstarted(&'static str) }

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
    let Ok(mut child) = command.spawn() else { return Outcome::Unstarted("HostUnavailable") };
    #[cfg(windows)]
    let job = match supervisor::job::Job::attach_with(&child, None) { Ok(job) => job, Err(error) => { let _ = child.kill().await; let _ = child.wait().await; return Outcome::Unstarted(error); } };
    let (Some(mut stdin), Some(mut stdout), Some(mut stderr)) = (child.stdin.take(), child.stdout.take(), child.stderr.take()) else { let _ = child.kill().await; return Outcome::Unstarted("HostUnavailable") };
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
    // Memory is measured, never capped (R0106): the resident set of the whole job (the host process elsewhere).
    let pid = child.id();
    let mut sample = tokio::time::interval(supervision::MEMORY_SAMPLE);
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
                                    let handle = if method == "context" || method == "storageDirectory" || method == "connectionsRequest" { params.get("invocation").and_then(Value::as_u64).and_then(|call| handles.get(&call).cloned()) } else { None };
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
            _ = sample.tick(), if requested.is_none() => {
                #[cfg(windows)]
                let pids = { let mut pids = job.process_ids(); if pids.is_empty() { pids.extend(pid); } pids };
                #[cfg(not(windows))]
                let pids: Vec<u32> = pid.into_iter().collect();
                if let Some(bytes) = supervision::resident_bytes(&pids) { events(Event::Memory(bytes)); }
            }
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
        { let app = app.clone(); services.set_restart_hook(Arc::new(move || reconcile_app(&app))); }
        { let app = app.clone(); services.set_ended_hook(Arc::new(move |owner: &str| { super::runtime_dynamic_items::service_stopped(&app, owner); super::runtime_dialog_navigation::service_stopped(&app, owner); super::runtime_notifications::service_stopped(&app, owner); super::runtime_tasks_start::service_stopped(&app, owner); super::runtime_tasks_drafts::service_stopped(&app, owner); super::runtime_terminals::service_stopped(&app, owner); super::runtime_harness_console::service_stopped(&app, owner);super::runtime_workspace_cloud::service_stopped(&app, owner);super::runtime_workspace_projects::service_stopped(&app, owner);super::runtime_provider_state::service_stopped(&app, owner); super::runtime_hook_registration::service_stopped(&app, owner); super::runtime_model_tools::service_stopped(owner); super::runtime_model_call::service_stopped(owner); })); }
        // Hook deliveries (R0503) go into the running service as one-way host calls.
        { let app = app.clone(); super::runtime_hook_registration::registry().set_deliver(Arc::new(move |owner: &str, frame: Value| { use tauri::Manager; app.try_state::<ServiceLifetime>().ok_or("HostUnavailable")?.send_hook(owner, frame).map(drop) })); }
        services.events().set_gate(runtime_workspace_events::grants_gate(&app));
        // Panel instances (R0303): the host call `panel` into a running service, the server of a panel's proxied
        // calls, and the main window's appearance (listened for once per app).
        { let dispatch = app_dispatch(&app); let app = app.clone(); super::rich_views::runtime_rich_channel::connect(super::rich_views::runtime_rich_channel::Hooks { call: Arc::new(move |owner: String, params: Value| { let app = app.clone(); Box::pin(async move { match app.try_state::<ServiceLifetime>() { Some(services) => services.call_panel(&owner, params).await, None => Err("HostUnavailable".to_owned()) } }) as Pin<Box<dyn Future<Output = Result<Value, String>> + Send>> }), dispatch }); }
        super::rich_views::runtime_rich_channel::install(&app);
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
            // Declared connection requests (R0804): the grant, the declaration and the credential are resolved natively per call.
            if request.method == "connectionsRequest" {
                return tauri::async_runtime::spawn_blocking(move || {
                    let mut params = request.params;
                    let op = params.as_object_mut().and_then(|object| object.remove("op")).and_then(|op| op.as_str().map(str::to_owned)).unwrap_or_default();
                    super::runtime_connection_adapters::serve(&app, &request.owner, request.handle.as_deref(), &format!("connections.{op}"), &params)
                }).await.unwrap_or_else(|_| super::context::failure("HostUnavailable"));
            }
            // `panda.harnesses.switchAccount` (R0805): `credentials.use` for the account's item is checked natively per call.
            if request.method == "accountSwitch" {
                return tauri::async_runtime::spawn_blocking(move || runtime_held_credentials::serve(&app, request)).await.unwrap_or_else(|_| super::context::failure("HostUnavailable"));
            }
            // `panda.ui.register`, `update`, `updateView` and a handle's `update` / `dispose` (R0205).
            if request.method == "ui" {
                return tauri::async_runtime::spawn_blocking(move || super::runtime_dynamic_items::serve_app(&app, &request.owner, &request.params)).await.unwrap_or_else(|_| super::context::failure("HostUnavailable"));
            }
            // `panda.ui.notify` and `panda.ui.withdraw` (R0207): `ui.notify` is checked natively per call.
            // `panda.tasks.start` (R0401, tasks.start): the grant, the project and the harness are resolved natively per call.
            if request.method == "tasksStart" { return super::runtime_tasks_start::serve(app, request).await; }
            // `panda.hooks.on` / dispose and `panda.hooks.input` (R0503): declaration and `harness.hooks.observe` checked natively.
            // `panda.harnesses.list` (R0509, harnesses.inventory): the grant is checked natively per call.
            if request.method == "harnessesList" { return super::runtime_harness_coverage::serve(app, request).await; }
            if matches!(request.method.as_str(), "hooks" | "hooksInput") { return super::runtime_hook_registration::serve(app, request).await; }
            // `panda.hooks.pending` (R0507): the open approvals and questions, filtered like a live delivery, checked now.
            if request.method == "hooksPending" { return super::runtime_pending_requests::serve(app, request).await; }
            // `panda.modelTools.register` and dispose (R0701, tools.model): the declaration and the grant are checked natively per call.
            if request.method == "modelTools" { return super::runtime_model_tools::serve(app, request).await; }
            // `panda.models.call` (R0704, models.call): the grant is rechecked natively per call; a call may wait, so it is awaited here.
            if request.method == "modelsCall" { return super::runtime_model_call::serve(app, request).await; }
            // Messages, notes and the revisioned queue (R0402, tasks.message): the grant and the task are resolved natively per call.
            if matches!(request.method.as_str(), "tasksMessage" | "tasksNote" | "tasksQueue") { return super::runtime_tasks_messages::serve(app, request).await; }
            // `panda.views.post` and `instances` (R0303, ui.richViews): the instances and the grant are resolved natively per call.
            if request.method == "views" { return super::rich_views::runtime_rich_channel::serve(app, request).await; }
            // `panda.workspace.recipes.*` and `panda.workspace.wakeups.*` (R0406B): `workspace.manage` is checked natively per call.
            if matches!(request.method.as_str(), "workspaceRecipes" | "workspaceWakeups") { return runtime_workspace_schedules::serve(app, request).await; }
            // `panda.workspace.bots.*` and `panda.workspace.channels.*` (R0406): `workspace.manage` is checked natively per call; removals confirm by default.
            if request.method == "workspaceAutomation" { return runtime_workspace_automation::serve(app, request).await; }
            // `panda.workspace.settings.list`, `get` and `set` (R0407): `workspace.settings` is checked natively per call.
            if request.method == "workspaceSettings" {
                return tauri::async_runtime::spawn_blocking(move || runtime_workspace_settings::serve(&app, request)).await.unwrap_or_else(|_| super::context::failure("HostUnavailable"));
            }
            // `panda.tasks.draft.*` (R0403, tasks.draft) and `panda.tasks.attachments.read` (tasks.transcript.read): the grant is checked natively per call.
            // `panda.workspace.moodboards.*` and `panda.workspace.cloud.*` (R0406C, workspace.manage): the grant is checked natively per call.
            if matches!(request.method.as_str(), "workspaceMoodboards" | "workspaceCloud") { return super::runtime_workspace_cloud::serve(app, request).await; }
            // `panda.workspace.projects|worktrees|branches|tasks|pulls.*` and `panda.projects.checks.run` (R0405, workspace.manage and projects.checks.run): the grant is checked natively per call.
            if request.method == "workspaceProjects" { return super::runtime_workspace_projects::serve(app, request).await; }
            if request.method == "tasksControl" { return super::runtime_tasks_control::serve(app, request).await; }
            // `panda.tasks.council`, `worker` and `limit` (R0404B): `tasks.control` is checked natively per call.
            if request.method == "tasksFlow" { return super::runtime_tasks_flow::serve(app, request).await; }
            if request.method == "tasksDraft" { return super::runtime_tasks_drafts::serve(app, request).await; }
            // `panda.terminals.*` (R0409): `terminals.read` and `terminals.write` are checked natively per call.
            if request.method == "terminals" { return super::runtime_terminals::serve(app, request).await; }
            if request.method == "tasksAttachmentsRead" { return super::runtime_tasks_drafts::serve_attachment(app, request).await; }
            // `panda.guests.list`, `capture`, `input` and `control` (R0410, guests.control): the grant is checked natively per call.
            if request.method == "guests" { return super::runtime_guests::serve(app, request).await; }
            if request.method == "harnessConsole" { return super::runtime_harness_console::serve(app, request).await; }
            if request.method == "notice" {
                return tauri::async_runtime::spawn_blocking(move || super::runtime_notifications::serve_app(&app, &request.owner, &request.params)).await.unwrap_or_else(|_| super::context::failure("HostUnavailable"));
            }
            // `panda.providers.update` (R0806): `ui.dynamic` and the provider's owner are checked natively per call.
            if request.method == "providerUpdate" {
                return tauri::async_runtime::spawn_blocking(move || super::runtime_provider_state::serve_app(&app, &request.owner, &request.params)).await.unwrap_or_else(|_| super::context::failure("HostUnavailable"));
            }
            // `panda.ui.showDialog` (waits for the user's answer) and `panda.ui.reveal` (R0206): `ui.dynamic` is checked natively per call.
            if matches!(request.method.as_str(), "uiDialog" | "uiReveal") { return super::runtime_dialog_navigation::serve(app, request).await; }
            // `panda.settings.get` and the task content reads: answered from the grants file, no captured context needed.
            if matches!(request.method.as_str(), "settingsGet" | "contentQuery") {
                return tauri::async_runtime::spawn_blocking(move || runtime_content_resources::serve(&app, request)).await.unwrap_or_else(|_| super::context::failure("HostUnavailable"));
            }
            // Usage per turn, limits, accounts, metrics and the limits refresh (R0204): the grant is checked natively per call.
            if matches!(request.method.as_str(), "usageQuery" | "limitsRefresh") { return runtime_usage_resources::serve(app, request).await; }
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

    const SUPERVISION_MANIFEST: &str = include_str!("../../../tests/fixtures/extensions/runtime-service-supervision/extension.json");
    /// R0106: the supervision fixture is a valid service package.
    #[test]
    fn the_supervision_fixture_is_a_valid_service_package() {
        let manifest: Value = serde_json::from_str(SUPERVISION_MANIFEST).unwrap();
        let checked = super::super::contracts::validate_contract("packages", &json!([manifest]));
        assert_eq!(checked["ok"], true, "{checked}");
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
        assert_eq!(failed["supervision"]["crashes"], 0, "a start that never reached a process is not a supervised crash (R0106)");
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
            assert!((1..400).contains(&turns), "the oldest were dropped: {turns}");
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
            let clock = supervision::ManualClock::new();
            let hanging = ServiceLifetime::new(vec![runtime_dir()]).with_env(&[("PANDA_FIXTURE_MODE", "hang")]).with_clock(clock.clone());
            reconcile(&hanging);
            grants.grant(ID, PERMISSION, Scope::default()).unwrap();
            assert!(reconcile(&hanging) < Duration::from_millis(500));
            wait_for(&hanging, "the status line of a hanging service", |service| service["status"].is_object()).await;
            tokio::time::sleep(Duration::from_millis(1500)).await;
            assert_eq!(service(&hanging)["state"], "starting", "a service function that never settles is never waited for");
            // R0106: still starting after 10 s on the controlled clock is a slow start, reported and never waited for.
            assert_eq!(service(&hanging)["supervision"]["startup"], json!({"elapsedMs": 0, "slow": false, "readyMs": null}));
            clock.advance(Duration::from_millis(9_999));
            assert_eq!(service(&hanging)["supervision"]["startup"]["slow"], false);
            clock.advance(Duration::from_millis(1));
            let slow = service(&hanging);
            assert_eq!((slow["state"].as_str(), slow["supervision"]["startup"].clone()), (Some("starting"), json!({"elapsedMs": 10_000, "slow": true, "readyMs": null})));
            assert!(reconcile(&hanging) < Duration::from_millis(500), "a slow start never delays reconcile");
            // The same package's short activation runs beside its service: services hold no activation slot.
            let source = packages.0.lock().unwrap().executable_source(ID).unwrap().1;
            let context = json!({"schemaVersion":1,"windowId":"main","surfaceId":"panda.workspace.header.actions","commandId":"sample.service-lifetime/long","revision":1});
            assert_eq!(supervisor::run(&runtime, &source, context, Arc::new(AtomicBool::new(false)), |_, _| json!({"ok":true,"value":null})).await.unwrap(), Vec::<Value>::new());
            hanging.stop_all(StopReason::Quit); assert!(hanging.wait_idle(STOP_GRACE + Duration::from_secs(1)).await);
            assert_eq!(service(&hanging)["lastStop"], json!({"reason": "quit", "acknowledged": true}));

            // A service that throws is a crash (R0106): a restart is scheduled after 1 s on the controlled clock.
            let clock = supervision::ManualClock::new();
            let broken = ServiceLifetime::new(vec![runtime_dir()]).with_env(&[("PANDA_FIXTURE_MODE", "throw")]).with_clock(clock.clone());
            assert!(reconcile(&broken) < Duration::from_millis(500));
            let crashed = wait_for(&broken, "a broken service", |service| service["state"] == "restarting").await;
            assert_eq!(crashed["error"], "HostUnavailable"); assert_eq!(crashed["starts"], json!({"appStart": 1}));
            assert_eq!((crashed["supervision"]["backoffMs"].as_u64(), crashed["supervision"]["crashes"].as_u64()), (Some(1_000), Some(1)));
            assert_eq!(serde_json::to_value(packages.0.lock().unwrap().snapshot()).unwrap()["packages"][0]["enabled"], true);
            reconcile(&broken); assert_eq!(service(&broken)["starts"], json!({"appStart": 1}), "no restart before its backoff");
            broken.retry(ID); reconcile(&broken);
            wait_for(&broken, "the explicit retry", |service| service["state"] == "restarting" && service["starts"] == json!({"appStart": 1, "enable": 1})).await;
            broken.stop_all(StopReason::Quit); assert!(broken.wait_idle(Duration::from_secs(1)).await);
        }

        const SUPERVISION_SOURCE: &str = include_str!("../../../tests/fixtures/extensions/runtime-service-supervision/main.cjs");
        const SUPERVISED: &str = "sample.service-supervision";
        const CRASH: &str = "sample.service-supervision/crash";
        fn entry_of(manager: &ServiceLifetime, id: &str) -> Value {
            manager.projection()["services"].as_array().unwrap().iter().find(|service| service["id"] == id).cloned().unwrap_or(Value::Null)
        }
        async fn wait_id(manager: &ServiceLifetime, id: &str, what: &str, check: impl Fn(&Value) -> bool) -> Value {
            let deadline = Instant::now() + Duration::from_secs(20);
            loop {
                let notified = manager.changed.notified();
                let current = entry_of(manager, id);
                if check(&current) { return current; }
                assert!(Instant::now() < deadline, "timed out waiting for {what}: {current}");
                let _ = tokio::time::timeout(Duration::from_millis(100), notified).await;
            }
        }
        fn digest_of(packages: &Packages, id: &str) -> String {
            serde_json::to_value(packages.snapshot()).unwrap()["packages"].as_array().unwrap().iter().find(|package| package["manifest"]["id"] == id).unwrap()["executable"]["digest"].as_str().unwrap().to_owned()
        }
        /// A running process of the supervised fixture, `restarts` crash restarts in, with its status line written.
        async fn live(manager: &ServiceLifetime, restarts: u64, what: &str) -> Value {
            wait_id(manager, SUPERVISED, what, |service| service["state"] == "running" && service["restarts"] == restarts && service["status"].is_object()).await
        }
        async fn crash(manager: &ServiceLifetime) { let _ = manager.call_command(SUPERVISED, CRASH, json!({}), None).await; }
        async fn settle() { tokio::time::sleep(Duration::from_millis(300)).await; }

        /// R0106 acceptance: crashes of a real service on a controlled clock back off 1, 2, 4 and 8 s and the fifth
        /// inside ten minutes parks it with a named explanation; no process survives a crash (Q035); an unrelated
        /// service keeps running and is measured; retry, enable and update restart a parked service; disable and safe
        /// mode cancel a scheduled restart.
        #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
        async fn crashes_back_off_on_a_controlled_clock_park_after_five_and_restart_on_retry_enable_and_update() {
            let dir = Dir::new();
            let packages = Arc::new(ExtensionPackages::new(&dir.0, false));
            let grants = Arc::new(RuntimeGrants::open(&dir.0));
            let clock = supervision::ManualClock::new();
            let manager = Arc::new(ServiceLifetime::new(vec![runtime_dir()]).with_env(&[("PANDA_FIXTURE_HELPER", "1")]).with_clock(clock.clone()));
            // The app's restart hook reconciles; here it reconciles the test's own packages and grants.
            {
                let (weak, packages, grants) = (Arc::downgrade(&manager), packages.clone(), grants.clone());
                manager.set_restart_hook(Arc::new(move || if let Some(manager) = weak.upgrade() { let packages = packages.0.lock().unwrap(); manager.reconcile(&packages, &grants); }));
            }
            let reconcile = || { let packages = packages.0.lock().unwrap(); manager.reconcile(&packages, &grants); };
            {
                let packages = packages.0.lock().unwrap();
                packages.install(&archive(SUPERVISION_MANIFEST, SUPERVISION_SOURCE)).unwrap();
                packages.install(&archive(MANIFEST, SOURCE)).unwrap();
                for id in [SUPERVISED, ID] { let digest = digest_of(&packages, id); packages.trust(id, &digest, true).unwrap(); packages.enable(id, true).unwrap(); }
            }
            reconcile();
            for id in [SUPERVISED, ID] { grants.grant(id, PERMISSION, Scope::default()).unwrap(); }
            reconcile();
            let other = wait_for(&manager, "the unrelated service", |service| service["state"] == "running" && service["status"].is_object()).await;

            // Four crashes: each restart waits exactly its backoff on the clock; every crash ends host and helper.
            for (index, delay) in [1_000u64, 2_000, 4_000, 8_000].into_iter().enumerate() {
                let index = index as u64;
                let running = live(&manager, index, "a supervised start").await;
                let status: Value = serde_json::from_str(running["status"]["text"].as_str().unwrap()).unwrap();
                assert_eq!((status["restarts"].as_u64(), status["reason"].as_str()), (Some(index), Some(if index == 0 { "enable" } else { "restart" })), "lifetime.reason and lifetime.restarts");
                let handles = processes(&running);
                crash(&manager).await;
                let crashed = wait_id(&manager, SUPERVISED, "a scheduled restart", |service| service["state"] == "restarting").await;
                assert_eq!((crashed["supervision"]["backoffMs"].as_u64(), crashed["supervision"]["restartInMs"].as_u64()), (Some(delay), Some(delay)));
                assert_eq!((crashed["supervision"]["crashes"].as_u64(), crashed["error"].as_str(), crashed["restarts"].as_u64()), (Some(index + 1), Some("HostUnavailable"), Some(index)));
                gone(handles, "crash").await;
                clock.advance(Duration::from_millis(delay - 1)); settle().await;
                let waiting = entry_of(&manager, SUPERVISED);
                assert_eq!((waiting["state"].as_str(), waiting["starts"]["restart"].as_u64().unwrap_or(0)), (Some("restarting"), index), "nothing starts before the backoff");
                clock.advance(Duration::from_millis(1));
            }
            let running = live(&manager, 4, "the fourth restart").await;
            let handles = processes(&running);
            crash(&manager).await;
            let parked = wait_id(&manager, SUPERVISED, "parking", |service| service["state"] == "parked").await;
            gone(handles, "the parking crash").await;
            assert_eq!(parked["supervision"]["parked"], "The service of sample.service-supervision was parked after 5 crashes in 10 minutes (HostUnavailable x5). Retry, enable or update the package to start it again.");
            assert_eq!(parked["starts"], json!({"enable": 1, "restart": 4})); assert_eq!(parked["stops"], json!({"crash": 5, "park": 1}));
            assert_eq!(parked["lastStop"], json!({"reason": "park", "acknowledged": false})); assert_eq!(parked["restarts"], 4);
            // No loop: an hour on the clock and another reconcile leave it parked.
            clock.advance(Duration::from_secs(3600)); settle().await; reconcile();
            let still = entry_of(&manager, SUPERVISED);
            assert_eq!((still["state"].as_str(), still["starts"].clone()), (Some("parked"), json!({"enable": 1, "restart": 4})));
            // The unrelated service never noticed: same process, no stop, and its memory is measured (not capped).
            let unrelated = wait_for(&manager, "a memory sample", |service| service["supervision"]["memory"]["samples"].as_u64().unwrap_or(0) >= 1).await;
            assert_eq!((unrelated["state"].as_str(), unrelated["status"].clone(), unrelated["stops"].clone(), unrelated["restarts"].as_u64()), (Some("running"), other["status"].clone(), json!({}), Some(0)));
            let memory = &unrelated["supervision"]["memory"];
            assert!(memory["residentBytes"].as_u64().unwrap() > 1024 * 1024 && memory["peakBytes"].as_u64() >= memory["residentBytes"].as_u64(), "{memory}");
            println!("SERVICE_SUPERVISION_MEMORY {memory}");

            // Retry (enable) restarts the parked service with a clean history.
            manager.retry(SUPERVISED); reconcile();
            let retried = live(&manager, 0, "the retried start").await;
            assert_eq!((retried["reason"].as_str(), retried["supervision"]["crashes"].as_u64(), retried["supervision"]["parked"].clone()), (Some("enable"), Some(0), Value::Null));
            assert!(retried["supervision"]["startup"]["readyMs"].is_u64(), "{retried}");
            // Disable cancels a scheduled restart.
            crash(&manager).await;
            wait_id(&manager, SUPERVISED, "a scheduled restart", |service| service["state"] == "restarting").await;
            packages.0.lock().unwrap().enable(SUPERVISED, false).unwrap(); reconcile();
            assert_eq!(entry_of(&manager, SUPERVISED)["state"], "stopped");
            clock.advance(Duration::from_secs(120)); settle().await; reconcile();
            assert_eq!(entry_of(&manager, SUPERVISED)["state"], "stopped", "disable cancelled the restart");
            packages.0.lock().unwrap().enable(SUPERVISED, true).unwrap(); reconcile();
            live(&manager, 0, "enable after disable").await;
            // Safe mode cancels a scheduled restart.
            crash(&manager).await;
            wait_id(&manager, SUPERVISED, "a scheduled restart", |service| service["state"] == "restarting").await;
            packages.0.lock().unwrap().safe = true; reconcile();
            assert_eq!(entry_of(&manager, SUPERVISED)["state"], "stopped");
            wait_for(&manager, "safe mode stops the unrelated service", |service| service["state"] == "stopped").await;
            clock.advance(Duration::from_secs(120)); settle().await;
            assert_eq!(entry_of(&manager, SUPERVISED)["state"], "stopped", "safe mode cancelled the restart");
            packages.0.lock().unwrap().safe = false; reconcile();
            live(&manager, 0, "after safe mode").await;
            // Park again, then an update restarts the parked service.
            for (index, delay) in [1_000u64, 2_000, 4_000, 8_000].into_iter().enumerate() {
                live(&manager, index as u64, "a restart before parking again").await;
                crash(&manager).await;
                wait_id(&manager, SUPERVISED, "a scheduled restart", |service| service["state"] == "restarting").await;
                clock.advance(Duration::from_millis(delay));
            }
            live(&manager, 4, "the last restart before parking again").await;
            crash(&manager).await;
            wait_id(&manager, SUPERVISED, "parked again", |service| service["state"] == "parked").await;
            let mut next: Value = serde_json::from_str(SUPERVISION_MANIFEST).unwrap(); next["version"] = json!("1.1.0");
            let staged = dir.0.join("update.zip"); std::fs::write(&staged, archive(&next.to_string(), SUPERVISION_SOURCE)).unwrap();
            {
                let packages = packages.0.lock().unwrap(); packages.stage_update(SUPERVISED, &staged).unwrap();
                let snapshot = serde_json::to_value(packages.snapshot()).unwrap();
                let digest = snapshot["packages"].as_array().unwrap().iter().find(|package| package["manifest"]["id"] == SUPERVISED).unwrap()["update"]["digest"].as_str().unwrap().to_owned();
                packages.review_update(SUPERVISED, &digest).unwrap();
            }
            reconcile();
            let updated = live(&manager, 0, "the update start").await;
            assert_eq!((updated["reason"].as_str(), updated["version"].as_str(), updated["supervision"]["parked"].clone()), (Some("update"), Some("1.1.0"), Value::Null));
            println!("SERVICE_SUPERVISION {}", json!({"starts": updated["starts"], "stops": updated["stops"]}));
            manager.stop_all(StopReason::Quit); assert!(manager.wait_idle(STOP_GRACE + Duration::from_secs(1)).await);
        }

        const DYNAMIC_MANIFEST: &str = include_str!("../../../tests/fixtures/extensions/runtime-dynamic-items/extension.json");
        const DYNAMIC_SOURCE: &str = include_str!("../../../tests/fixtures/extensions/runtime-dynamic-items/main.cjs");
        const DYNAMIC_ID: &str = "sample.dynamic-items";
        const DYNAMIC_OPEN: &str = "sample.dynamic-items/open";

        impl B1 {
            /// A signal whose payload tells the fixture service what to do (`{op: "add" | "change" | ...}`).
            async fn order(&self, payload: Value) { self.http("POST", "/control/signal", &json!({"name": "order", "payload": payload})).await; }
        }

        /// R0205 acceptance: an installed service, told by B1 signals, adds, changes and removes a status item and a
        /// table row; every field is reflected in the layer the interface reads, a click delivers its arguments
        /// exactly once, and the layer is empty once the process ends.
        #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
        async fn dynamic_items_installed_service_adds_changes_and_removes_a_status_item_and_a_table_row_by_signal() {
            use crate::extensions::runtime_dynamic_items::{failure, now_millis, serve, Checks, DynamicItems};
            let runtime = supervisor::Runtime::packaged(&runtime_dir()).unwrap();
            let b1 = B1::start(&runtime).await;
            let dir = Dir::new();
            let packages = ExtensionPackages::new(&dir.0, false);
            let grants = RuntimeGrants::open(&dir.0);
            let items = Arc::new(DynamicItems::default());
            let manifest: Value = serde_json::from_str(DYNAMIC_MANIFEST).unwrap();
            let dispatch: Dispatch = { let (items, manifest) = (items.clone(), manifest.clone()); Arc::new(move |request: DispatchRequest| {
                let (items, manifest) = (items.clone(), manifest.clone());
                Box::pin(async move {
                    if request.method != "ui" { return failure("UnsupportedCapability"); }
                    let checks = Checks { granted: true, manifest: &manifest, scope_exists: &|_| true, version: "1.0.0", now_ms: now_millis() };
                    serve(&items, &request.owner, &checks, &request.params)
                }) as Pin<Box<dyn Future<Output = Value> + Send>>
            }) };
            { let packages = packages.0.lock().unwrap(); packages.install(&archive(DYNAMIC_MANIFEST, DYNAMIC_SOURCE)).unwrap(); let digest = digest(&packages); packages.trust(DYNAMIC_ID, &digest, true).unwrap(); packages.enable(DYNAMIC_ID, true).unwrap(); }
            let env = [("PANDA_FIXTURE_B1", b1.socket.as_str())];
            let manager = ServiceLifetime::new(vec![runtime_dir()]).with_env(&env);
            manager.set_dispatch(dispatch);
            { let items = items.clone(); manager.set_ended_hook(Arc::new(move |owner: &str| items.clear(owner))); }
            { let packages = packages.0.lock().unwrap(); manager.reconcile(&packages, &grants); }
            grants.grant(DYNAMIC_ID, PERMISSION, Scope::default()).unwrap();
            { let packages = packages.0.lock().unwrap(); manager.reconcile(&packages, &grants); }
            let deadline = Instant::now() + Duration::from_secs(20);
            while !manager.serves(DYNAMIC_ID, DYNAMIC_OPEN) { assert!(Instant::now() < deadline, "the service never became ready"); tokio::time::sleep(Duration::from_millis(25)).await; }

            // What the interface reads, waited for (the product is told by an event, never polls).
            let layer = |what: &'static str, check: Box<dyn Fn(&Value) -> bool>| { let items = items.clone(); async move {
                let deadline = Instant::now() + Duration::from_secs(10);
                loop {
                    let snapshot = items.snapshot();
                    if check(&snapshot["owners"][DYNAMIC_ID]) { return snapshot["owners"][DYNAMIC_ID].clone(); }
                    assert!(Instant::now() < deadline, "timed out waiting for {what}: {snapshot}");
                    tokio::time::sleep(Duration::from_millis(25)).await;
                }
            } };
            let status = |owner: &Value| owner["menus"].as_array().into_iter().flatten().find(|menu| menu["id"] == "sample.dynamic-items/alert").cloned();
            let board = |owner: &Value| owner["overrides"]["sample.dynamic-items/board"]["controls"][0]["rows"].clone();

            // Add: a status item appears with its text, tone, tooltip and progress.
            b1.order(json!({"op": "add"})).await;
            let owner = layer("the status item", Box::new(move |owner| owner["menus"].as_array().is_some_and(|menus| menus.len() == 1))).await;
            let added = status(&owner).unwrap();
            assert_eq!((added["text"].as_str(), added["tone"].as_str(), added["tooltip"].as_str(), added["progress"].as_u64()), (Some("3 builds failed"), Some("warning"), Some("Three builds failed"), Some(10)), "{added}");
            assert_eq!(added["location"], "panda.status.items");
            // Change: text, badge, tone, tooltip, progress, enabled and visible are reflected.
            b1.order(json!({"op": "change"})).await;
            let owner = layer("the changed item", Box::new(|owner| owner["menus"][0]["text"] == "4 builds failed")).await;
            let changed = status(&owner).unwrap();
            assert_eq!((changed["badge"].as_str(), changed["tone"].as_str(), changed["tooltip"].as_str(), changed["progress"].as_u64(), changed["enabled"].as_bool(), changed["visible"].as_bool()), (Some("4"), Some("danger"), Some("Four builds failed"), Some(80), Some(false), Some(true)), "{changed}");
            // A table row with a command and arguments.
            b1.order(json!({"op": "table"})).await;
            let owner = layer("the table row", Box::new(move |owner| owner["overrides"]["sample.dynamic-items/board"]["controls"][0]["rows"].as_array().is_some_and(|rows| rows.len() == 1))).await;
            assert_eq!(board(&owner), json!([{"cells": ["tracks"], "command": DYNAMIC_OPEN, "args": {"table": "tracks"}}]));
            // A click delivers its arguments to the owning command exactly once.
            let click = manager.call_command(DYNAMIC_ID, DYNAMIC_OPEN, json!({"table": "tracks"}), None).await.unwrap();
            assert_eq!(click, json!({"delivered": 1}));
            let delivered = wait_for(&manager, "the click was delivered", |service| service["status"]["text"].as_str().and_then(|text| serde_json::from_str::<Value>(text).ok()).is_some_and(|status| status["opened"] == json!([{"table": "tracks"}]))).await;
            assert_eq!(delivered["state"], "running");
            tokio::time::sleep(Duration::from_millis(200)).await;
            let once = service(&manager)["status"]["text"].as_str().and_then(|text| serde_json::from_str::<Value>(text).ok()).unwrap();
            assert_eq!(once["opened"], json!([{"table": "tracks"}]), "delivered exactly once");
            // Remove: the status item and the table row go.
            b1.order(json!({"op": "remove"})).await; b1.order(json!({"op": "untable"})).await;
            let owner = layer("the removals", Box::new(move |owner| owner["menus"].as_array().is_some_and(Vec::is_empty) && owner["overrides"]["sample.dynamic-items/board"]["controls"][0]["rows"].as_array().is_some_and(Vec::is_empty))).await;
            assert_eq!(board(&owner), json!([]));
            // The process ends: nothing of the layer stays.
            b1.order(json!({"op": "add"})).await;
            layer("the second status item", Box::new(|owner| owner["menus"].as_array().is_some_and(|menus| menus.len() == 1))).await;
            manager.stop_all(StopReason::Quit); assert!(manager.wait_idle(STOP_GRACE + Duration::from_secs(1)).await);
            assert_eq!(items.count(DYNAMIC_ID), 0, "the layer ends with the process");
            assert!(items.snapshot()["owners"].get(DYNAMIC_ID).is_none() || items.snapshot()["owners"][DYNAMIC_ID]["menus"] == json!([]));
            b1.stop().await;
        }

        const NOTICES_MANIFEST: &str = include_str!("../../../tests/fixtures/extensions/runtime-notifications/extension.json");
        const NOTICES_SOURCE: &str = include_str!("../../../tests/fixtures/extensions/runtime-notifications/main.cjs");
        const NOTICES_ID: &str = "sample.runtime-notifications";
        const NOTICES_CONTROL: &str = "sample.runtime-notifications/control";

        /// R0207 acceptance: an installed service, told by B1 signals, raises a notice that names its package, replaces it by
        /// key (one notice), withdraws it (gone from the recorder and the list), merges a burst past six a minute, and loses
        /// every notice when `ui.notify` is revoked or the process ends.
        #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
        async fn notifications_installed_service_raises_replaces_withdraws_merges_and_loses_them_on_revoke_and_stop() {
            use crate::extensions::runtime_grants::Target;
            use crate::extensions::runtime_notifications::{failure, now_millis, serve, Checks, Notice, Notices, Os, OsChannel};
            struct Delivers;
            impl OsChannel for Delivers { fn show(&self, _: &str, _: &Notice) -> Os { Os::Delivered } fn withdraw(&self, _: &str, _: &str) -> Os { Os::Delivered } }
            let runtime = supervisor::Runtime::packaged(&runtime_dir()).unwrap();
            let b1 = B1::start(&runtime).await;
            let dir = Dir::new();
            let packages = ExtensionPackages::new(&dir.0, false);
            let grants = Arc::new(RuntimeGrants::open(&dir.0));
            let notices = Arc::new(Notices::new(Box::new(Delivers)));
            let dispatch: Dispatch = { let (notices, grants) = (notices.clone(), grants.clone()); Arc::new(move |request: DispatchRequest| {
                let (notices, grants) = (notices.clone(), grants.clone());
                Box::pin(async move {
                    if request.method != "notice" { return failure("UnsupportedCapability"); }
                    let granted = grants.check(&request.owner, "1.0.0", "ui.notify", &Target::default()).is_ok();
                    serve(&notices, &request.owner, &Checks { granted, package: &request.owner, now_ms: now_millis() }, &request.params)
                }) as Pin<Box<dyn Future<Output = Value> + Send>>
            }) };
            { let packages = packages.0.lock().unwrap(); packages.install(&archive(NOTICES_MANIFEST, NOTICES_SOURCE)).unwrap(); let digest = digest(&packages); packages.trust(NOTICES_ID, &digest, true).unwrap(); packages.enable(NOTICES_ID, true).unwrap(); }
            let env = [("PANDA_FIXTURE_B1", b1.socket.as_str())];
            let manager = ServiceLifetime::new(vec![runtime_dir()]).with_env(&env);
            manager.set_dispatch(dispatch);
            { let notices = notices.clone(); manager.set_ended_hook(Arc::new(move |owner: &str| { notices.clear(owner, "service-stopped"); })); }
            { let packages = packages.0.lock().unwrap(); manager.reconcile(&packages, &grants); }
            grants.grant(NOTICES_ID, PERMISSION, Scope::default()).unwrap();
            grants.grant(NOTICES_ID, "ui.notify", Scope::default()).unwrap();
            { let packages = packages.0.lock().unwrap(); manager.reconcile(&packages, &grants); }
            let deadline = Instant::now() + Duration::from_secs(20);
            while !manager.serves(NOTICES_ID, NOTICES_CONTROL) { assert!(Instant::now() < deadline, "the service never became ready"); tokio::time::sleep(Duration::from_millis(25)).await; }

            // What the interface reads, waited for (the product is told by an event, never polls).
            let list = |what: &'static str, check: Box<dyn Fn(&[Value]) -> bool>| { let notices = notices.clone(); async move {
                let deadline = Instant::now() + Duration::from_secs(10);
                loop {
                    let snapshot = notices.snapshot();
                    let rows = snapshot["notices"].as_array().cloned().unwrap_or_default();
                    if check(&rows) { return rows; }
                    assert!(Instant::now() < deadline, "timed out waiting for {what}: {snapshot}");
                    tokio::time::sleep(Duration::from_millis(25)).await;
                }
            } };
            let ops = |notices: &Notices| notices.recorder().as_array().unwrap().iter().map(|entry| entry["op"].as_str().unwrap().to_owned()).collect::<Vec<_>>();

            // Raise: the notice names the package and reaches the OS channel.
            b1.order(json!({"op": "alert"})).await;
            let rows = list("the notice", Box::new(|rows| rows.len() == 1)).await;
            assert_eq!((rows[0]["package"].as_str(), rows[0]["text"].as_str(), rows[0]["tone"].as_str(), rows[0]["os"].as_str()), (Some(NOTICES_ID), Some("3 builds failed"), Some("danger"), Some("delivered")), "{}", rows[0]);
            // Replace: the same key is one notice with the new text.
            b1.order(json!({"op": "replace"})).await;
            let rows = list("the replacement", Box::new(|rows| rows.len() == 1 && rows[0]["text"] == "4 builds failed")).await;
            assert_eq!(rows.len(), 1);
            assert_eq!(ops(&notices), ["show", "replace"]);
            // Withdraw: gone from the list and recorded.
            b1.order(json!({"op": "withdraw"})).await;
            list("the withdrawal", Box::new(|rows| rows.is_empty())).await;
            assert_eq!(ops(&notices), ["show", "replace", "withdraw"]);
            // A burst of nine: six notices and one merged notice that counts the other three.
            b1.order(json!({"op": "burst", "count": 9})).await;
            let rows = list("the merge", Box::new(|rows| rows.iter().any(|row| row["merged"] == true && row["count"] == 3))).await;
            assert_eq!(rows.len(), 7, "six notices and the merged one: {rows:?}");
            // Revoke `ui.notify`: the sweep removes every notice of the package and the service can raise no more.
            grants.revoke(NOTICES_ID, "ui.notify").unwrap();
            assert!(notices.sweep(&|owner| grants.check(owner, "1.0.0", "ui.notify", &Target::default()).is_ok(), "revoked-or-disabled"));
            list("the revoke", Box::new(|rows| rows.is_empty())).await;
            b1.order(json!({"op": "alert"})).await;
            tokio::time::sleep(Duration::from_millis(300)).await;
            assert_eq!(notices.count(NOTICES_ID), 0, "a revoked grant raises nothing");
            // Granted again, one more notice, and the process ending takes it with it.
            grants.grant(NOTICES_ID, "ui.notify", Scope::default()).unwrap();
            b1.order(json!({"op": "alert"})).await;
            list("the second notice", Box::new(|rows| rows.len() == 1)).await;
            manager.stop_all(StopReason::Quit); assert!(manager.wait_idle(STOP_GRACE + Duration::from_secs(1)).await);
            assert_eq!(notices.count(NOTICES_ID), 0, "the notices end with the process");
            b1.stop().await;
        }

        const NAVIGATION_MANIFEST: &str = include_str!("../../../tests/fixtures/extensions/runtime-dialog-navigation/extension.json");
        const NAVIGATION_SOURCE: &str = include_str!("../../../tests/fixtures/extensions/runtime-dialog-navigation/main.cjs");
        const NAVIGATION_ID: &str = "sample.dialog-navigation";

        /// R0206 acceptance: an installed service, told by B1 signals, asks a dialog that waits for the host's answer (a second
        /// one answers Conflict), receives the answer, and reveals a task (an unknown one is NotFound and nothing moves); the
        /// process ending resolves a pending dialog as cancelled.
        #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
        async fn dialog_navigation_installed_service_receives_the_answer_conflicts_a_second_dialog_and_reveals_by_signal() {
            use crate::extensions::runtime_dialog_navigation::{check_reveal, failure, DialogSlots, World};
            let runtime = supervisor::Runtime::packaged(&runtime_dir()).unwrap();
            let b1 = B1::start(&runtime).await;
            let dir = Dir::new();
            let packages = ExtensionPackages::new(&dir.0, false);
            let grants = RuntimeGrants::open(&dir.0);
            let slots = Arc::new(DialogSlots::default());
            let revealed: Arc<Mutex<Vec<Value>>> = Arc::default();
            let dispatch: Dispatch = { let (slots, revealed) = (slots.clone(), revealed.clone()); Arc::new(move |request: DispatchRequest| {
                let (slots, revealed) = (slots.clone(), revealed.clone());
                Box::pin(async move {
                    match request.method.as_str() {
                        "uiDialog" => match slots.begin(&request.owner, request.params.clone()) { Ok((_, answer)) => json!({"ok": true, "value": answer.await.unwrap_or_else(|_| json!({"status": "cancelled"}))}), Err(code) => failure(code) },
                        "uiReveal" => {
                            let (views, pages) = (vec![format!("{NAVIGATION_ID}/board")], vec![format!("{NAVIGATION_ID}/settings")]);
                            let world = World { granted: true, views: &views, settings_pages: &pages, task_exists: &|id| id == "t1", project_dir: &|_| None, file_exists: &|_| false };
                            match check_reveal(&request.owner, &world, &request.params) { Ok(target) => { revealed.lock().unwrap().push(target); json!({"ok": true, "value": null}) } Err(code) => failure(code) }
                        }
                        _ => failure("UnsupportedCapability"),
                    }
                }) as Pin<Box<dyn Future<Output = Value> + Send>>
            }) };
            { let packages = packages.0.lock().unwrap(); packages.install(&archive(NAVIGATION_MANIFEST, NAVIGATION_SOURCE)).unwrap(); let digest = digest(&packages); packages.trust(NAVIGATION_ID, &digest, true).unwrap(); packages.enable(NAVIGATION_ID, true).unwrap(); }
            let env = [("PANDA_FIXTURE_B1", b1.socket.as_str())];
            let manager = ServiceLifetime::new(vec![runtime_dir()]).with_env(&env);
            manager.set_dispatch(dispatch);
            { let slots = slots.clone(); manager.set_ended_hook(Arc::new(move |owner: &str| { slots.cancel_owner(owner); })); }
            { let packages = packages.0.lock().unwrap(); manager.reconcile(&packages, &grants); }
            grants.grant(NAVIGATION_ID, "ui.dynamic", Scope::default()).unwrap();
            { let packages = packages.0.lock().unwrap(); manager.reconcile(&packages, &grants); }
            let deadline = Instant::now() + Duration::from_secs(20);
            while !manager.serves(NAVIGATION_ID, "sample.dialog-navigation/control") { assert!(Instant::now() < deadline, "the service never became ready"); tokio::time::sleep(Duration::from_millis(25)).await; }
            let held = |text: &Value| text.as_str().and_then(|text| serde_json::from_str::<Value>(text).ok()).unwrap_or(Value::Null);

            // Ask: the dialog is open for the interface and the service waits.
            b1.order(json!({"op": "ask"})).await;
            let deadline = Instant::now() + Duration::from_secs(10);
            while slots.count(NAVIGATION_ID) == 0 { assert!(Instant::now() < deadline, "the dialog never opened"); tokio::time::sleep(Duration::from_millis(25)).await; }
            // A second dialog of the same owner is a Conflict; the first stays open.
            b1.order(json!({"op": "ask"})).await;
            wait_for(&manager, "the second dialog was refused", |service| held(&service["status"]["text"])["refused"] == json!(["Conflict"])).await;
            assert_eq!(slots.count(NAVIGATION_ID), 1);
            // The answer reaches the awaiting service exactly once.
            let id = slots.pending()[0]["id"].as_str().unwrap().to_owned();
            slots.answer(&id, &json!({"status": "confirmed", "values": {"name": "Ada", "sure": true}})).unwrap();
            wait_for(&manager, "the answer arrived", |service| held(&service["status"]["text"])["answers"] == json!([{"status": "confirmed", "values": {"name": "Ada", "sure": true}}])).await;
            assert_eq!(slots.answer(&id, &json!({"status": "cancelled"})), Err("NotFound"));

            // Reveal: a task that exists is sent to the window; an unknown one is NotFound and nothing is sent.
            b1.order(json!({"op": "reveal", "target": {"taskId": "t1"}})).await;
            b1.order(json!({"op": "reveal", "target": {"taskId": "ghost"}})).await;
            wait_for(&manager, "the refusal was recorded", |service| held(&service["status"]["text"])["refused"] == json!(["Conflict", "NotFound"])).await;
            assert_eq!(*revealed.lock().unwrap(), vec![json!({"taskId": "t1"})]);

            // The process ends while a dialog waits: it resolves as cancelled and the slot is free.
            b1.order(json!({"op": "ask"})).await;
            let deadline = Instant::now() + Duration::from_secs(10);
            while slots.count(NAVIGATION_ID) == 0 { assert!(Instant::now() < deadline, "the dialog never opened"); tokio::time::sleep(Duration::from_millis(25)).await; }
            manager.stop_all(StopReason::Quit); assert!(manager.wait_idle(STOP_GRACE + Duration::from_secs(1)).await);
            assert_eq!(slots.count(NAVIGATION_ID), 0, "the dialog ends with the process");
            b1.stop().await;
        }

        // R1201: the Work board acceptance, pasted here to share this module's B1 driver and helpers.
        include!("runtime_live_board_acceptance.rs");
    }
}
