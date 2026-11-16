//! Background services of trusted packages (`runtime.service`, runtime phase R1, slice R0104).
//!
//! A package that declares `"runtime": { ..., "service": { "start": "onEnable" } }` and holds the native
//! `runtime.service` grant gets one long-lived Node process: started at app start and on enable, only for an
//! enabled package whose executable content is trusted; stopped on disable, uninstall, a changed archive digest
//! (update), loss of trust or of the grant, safe mode and quit. The host asks the service to stop, gives its
//! `onStop` handlers at most two seconds, then ends the whole process tree (the job object).
//!
//! What this slice does NOT do (named owners): crash restart with backoff and parking (R0106), the Running list
//! and the quit confirmation (R0107), the user's environment, code folders and the data directory (R0105), the
//! duplex channel that dispatches owned commands, context queries and host events into the service (R0201).
//!
//! Services live here, not in `ExtensionRuntime::active`: they never take one of the eight short-activation slots
//! and a short activation of the same package is never refused because its service runs. They are not owned by a
//! window or a captured context, so a task switch, a released handle or a closed main window leaves them running.
//! Nothing here waits for a service: `reconcile` only spawns, so a starting, hanging or broken service never
//! delays the app.
use super::{packages::Packages, runtime_grants::{RuntimeGrants, Target, Work}, supervisor};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::BTreeMap, path::PathBuf, process::Stdio, sync::{Arc, Mutex}, time::Duration};
use tokio::{io::AsyncReadExt, sync::{mpsc, watch, Notify}};

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
}
#[derive(Default)]
struct Counters { starts: BTreeMap<&'static str, u64>, stops: BTreeMap<&'static str, u64>, last_stop: Option<(&'static str, bool)> }
/// A start that waits for the previous process of the same package to end (one service per package).
struct Queued { want: Want, source: String, reason: StartReason, work: Work }
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
}

impl ServiceLifetime {
    pub fn new(runtimes: Vec<PathBuf>) -> Self {
        Self { inner: Arc::default(), changed: Arc::default(), runtimes: Arc::new(runtimes), env: Arc::default() }
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
            let Ok(work) = grants.begin(&id, &want.version, PERMISSION, &Target::default()) else { continue };
            if inner.entries.contains_key(&id) { inner.queued.insert(id, Queued { want, source, reason, work }); }
            else { self.start(&mut inner, id, Queued { want, source, reason, work }); }
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
        *inner.counters.entry(id.clone()).or_default().starts.entry(queued.reason.as_str()).or_default() += 1;
        inner.entries.insert(id.clone(), Entry { generation, version: queued.want.version.clone(), digest: queued.want.digest.clone(), reason: queued.reason, restarts: 0, state: State::Starting, status: None, error: None, stop });
        let manager = Self { inner: self.inner.clone(), changed: self.changed.clone(), runtimes: self.runtimes.clone(), env: self.env.clone() };
        tauri::async_runtime::spawn(async move { manager.supervise(id, generation, queued, stopped).await });
    }

    async fn supervise(self, id: String, generation: u64, queued: Queued, stopped: watch::Receiver<Option<StopReason>>) {
        let Queued { want, source, reason, work } = queued;
        let directories = self.runtimes.clone();
        let runtime = tauri::async_runtime::spawn_blocking(move || directories.iter().find_map(|directory| supervisor::Runtime::packaged(directory).ok())).await.ok().flatten();
        let init = json!({"lifetime": {"reason": reason.as_str(), "restarts": 0, "commands": want.commands}});
        let events = |event: Event| self.event(&id, generation, event);
        let outcome = match runtime {
            Some(runtime) => run(&runtime, &source, init, stopped, &work, &self.env, events).await,
            None => Outcome::Failed("UnsupportedRuntime"),
        };
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

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Message { schema_version: u8, token: String, id: u32, method: String, params: Value }

/// One service process: no deadline, no heap flag, no message budget (the frame size bound stays). Ends when the
/// host asks it to stop (after at most `STOP_GRACE`), when its grant work is cancelled, or when it exits or breaks
/// the protocol. The whole job is always terminated and the child reaped before this returns.
async fn run(runtime: &supervisor::Runtime, source: &str, init: Value, mut stop: watch::Receiver<Option<StopReason>>, work: &Work, env: &[(String, String)], mut events: impl FnMut(Event)) -> Outcome {
    let mut command = tokio::process::Command::new(&runtime.binary);
    command.args(["--input-type=commonjs", "--eval", supervisor::BOOTSTRAP]).current_dir(&runtime.directory)
        .env_clear().stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    // The service's environment is still the short activation's cleared one; R0105 gives it the user's environment.
    for name in ["SystemRoot", "WINDIR", "TEMP", "TMP"] { if let Some(value) = std::env::var_os(name) { command.env(name, value); } }
    for (name, value) in env { command.env(name, value); }
    #[cfg(windows)]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    let Ok(mut child) = command.spawn() else { return Outcome::Failed("HostUnavailable") };
    #[cfg(windows)]
    let job = match supervisor::job::Job::attach_with(&child, None) { Ok(job) => job, Err(error) => { let _ = child.kill().await; let _ = child.wait().await; return Outcome::Failed(error); } };
    let (Some(mut stdin), Some(mut stdout), Some(mut stderr)) = (child.stdin.take(), child.stdout.take(), child.stderr.take()) else { let _ = child.kill().await; return Outcome::Failed("HostUnavailable") };
    // Frames are read by their own task so that a stop or a grant change never cuts a frame in half.
    let (frames, mut incoming) = mpsc::channel::<supervisor::Result<Value>>(8);
    let reader = tauri::async_runtime::spawn(async move { loop { let frame = supervisor::read_frame(&mut stdout).await; let end = frame.is_err(); if frames.send(frame).await.is_err() || end { break; } } });
    // Package output is never shown; drain stderr so the service cannot block on a full pipe.
    let noise = tauri::async_runtime::spawn(async move { let mut chunk = [0; 4096]; while stderr.read(&mut chunk).await.is_ok_and(|count| count > 0) {} });
    let token = uuid::Uuid::new_v4().to_string();
    let mut requested: Option<StopReason> = *stop.borrow();
    let mut acknowledged = false;
    let mut grace = Box::pin(tokio::time::sleep(Duration::from_secs(365 * 24 * 3600)));
    let mut poll = tokio::time::interval(GRANT_POLL);
    let mut failure: Option<&'static str> = None;
    if supervisor::write_frame(&mut stdin, &json!({"token": token, "source": source, "context": init}), 300_000).await.is_err() { failure = Some("HostUnavailable"); }
    if let (Some(reason), None) = (requested, failure) { if supervisor::write_frame(&mut stdin, &json!({"stop": reason.as_str()}), supervisor::MAX_FRAME).await.is_err() { failure = Some("HostUnavailable"); } grace.as_mut().reset(tokio::time::Instant::now() + STOP_GRACE); }
    let mut expected = 1u32;
    while failure.is_none() {
        let mut ask = None;
        tokio::select! {
            frame = incoming.recv() => {
                let message = match frame { Some(Ok(raw)) => serde_json::from_value::<Message>(raw).map_err(|_| "InvalidShape"), Some(Err(code)) => Err(code), None => Err("HostUnavailable") };
                let message = match message { Ok(message) => message, Err(code) => { failure = Some(code); break; } };
                if message.schema_version != 1 { failure = Some("IncompatibleApi"); break; }
                if message.token != token || message.id != expected { failure = Some("PermissionDenied"); break; }
                expected = expected.wrapping_add(1);
                match message.method.as_str() {
                    "serviceReady" if message.params.is_null() => events(Event::Ready),
                    "serviceStatus" => {
                        let text = message.params["text"].as_str().unwrap_or_default().chars().take(200).collect::<String>();
                        events(Event::Status(text, message.params["working"] == true));
                    }
                    "serviceStopped" if requested.is_some() => acknowledged = true,
                    "failed" if message.params.is_null() => { failure = Some("HostUnavailable"); break; }
                    _ => { failure = Some("UnsupportedCapability"); break; }
                }
                if supervisor::write_frame(&mut stdin, &json!({"id": message.id, "reply": {"ok": true, "value": null}}), supervisor::MAX_FRAME).await.is_err() && requested.is_none() { failure = Some("HostUnavailable"); }
            }
            changed = stop.changed(), if requested.is_none() => { ask = if changed.is_ok() { *stop.borrow() } else { Some(StopReason::Quit) }; }
            // A cancelled grant work is a grant or trust loss, unless the host already named the reason.
            _ = poll.tick(), if requested.is_none() => { if work.is_cancelled() { ask = Some(stop.borrow().unwrap_or(StopReason::Trust)); } }
            () = &mut grace, if requested.is_some() => break,
        }
        if let (Some(reason), None) = (ask, requested) {
            requested = Some(reason);
            grace.as_mut().reset(tokio::time::Instant::now() + STOP_GRACE);
            // A process that already left still counts as stopped for this reason.
            let _ = supervisor::write_frame(&mut stdin, &json!({"stop": reason.as_str()}), supervisor::MAX_FRAME).await;
        }
    }
    drop(stdin);
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
        let Ok(packages) = packages.0.lock() else { return };
        services.reconcile(&packages, &grants);
    });
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
