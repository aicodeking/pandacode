//! Live Colab runtime status per thread, for the conversation pane's floating indicator.
//!
//! Whatever a thread does with Colab (the native `pandacode_colab_*` tools, the
//! `pandacode_vm_*` tools on a `colab:*` machine, a Cloud Agent on Colab) is recorded here
//! in memory, keyed by session ID, and every change is sent as a `colab-runtime` event
//! (`{sessionId, runtimes}`) holding the thread's full list. Listing is local: the tracked
//! entries plus the thread's Colab Cloud Agent machine, read from `sessions.cloud` and
//! `colab-sessions.json`, so a reopened app shows a cloud agent's runtime at once.
//! Only an explicit refresh asks Colab which runtimes still exist.
use serde::Serialize;
use serde_json::json;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager};

use super::hardware_label;
use super::store::{self, Records, SessionRecord};

pub const EVENT: &str = "colab-runtime";
const PENDING: &str = "colab:pending-";
/// The pending entry of a Cloud Agent whose runtime is still being assigned.
const AGENT_PENDING: &str = "colab:pending-agent";
const ENDED: &str = "Ended on Google Colab";
const INTERRUPTED: &str = "Creating the runtime was interrupted.";
/// States in which the runtime is doing something, so `busy_since` is set.
const BUSY_STATES: [&str; 4] = ["creating", "busy", "restarting", "stopping"];
/// States an operation on a live runtime puts it in; only these end `ready`.
const OP_STATES: [&str; 3] = ["busy", "restarting", "stopping"];
/// Cloud Agent states that say more than a stale `stopped` or `error` entry.
const LIVE_STATES: [&str; 3] = ["creating", "busy", "restarting"];
/// `colab-sessions.json` keeps creation times in whole seconds: a runtime that started
/// within this long before a list was asked for may be newer than the list.
const RECORD_GRAIN_MS: u64 = 1000;
/// How many deleted threads and remembered runtimes are kept before starting over.
const MEMORY_CAP: usize = 4096;

type Result<T> = std::result::Result<T, String>;

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ColabThreadRuntime {
    /// `colab:<endpoint>`, or `colab:pending-<n>` while creating.
    pub id: String,
    /// The bare endpoint, or empty while creating.
    pub endpoint: String,
    pub name: String,
    /// For example `CPU`, `T4 GPU`, `A100 GPU`, `v5e-1 TPU`.
    pub hardware: String,
    pub high_mem: bool,
    /// `creating` | `ready` | `busy` | `restarting` | `stopping` | `stopped` | `error`.
    pub state: String,
    pub activity: Option<String>,
    pub browser_url: Option<String>,
    /// Unix epoch milliseconds.
    pub started_at: u64,
    /// Unix epoch milliseconds, while creating, busy, restarting or stopping.
    pub busy_since: Option<u64>,
    pub error: Option<String>,
}

/// What is known about a runtime besides its endpoint.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Info {
    pub name: String,
    pub hardware: String,
    pub high_mem: bool,
    /// When it was created (epoch ms), if known.
    pub started_at: Option<u64>,
}

impl Info {
    pub fn from_record(record: &SessionRecord) -> Info {
        Info {
            name: if record.name.is_empty() { record.endpoint.clone() } else { record.name.clone() },
            hardware: hardware_label(&record.accelerator),
            high_mem: record.machine_shape == "HIGH_RAM",
            started_at: (record.created_at > 0).then(|| record.created_at as u64 * 1000),
        }
    }
}

impl Info {
    /// Says something beyond the endpoint: a real name or hardware.
    fn is_real(&self, endpoint: &str) -> bool {
        !self.hardware.is_empty() || (!self.name.is_empty() && self.name != endpoint)
    }
    /// What a runtime entry says about itself.
    fn of(runtime: &ColabThreadRuntime) -> Info {
        Info { name: runtime.name.clone(), hardware: runtime.hardware.clone(), high_mem: runtime.high_mem, started_at: Some(runtime.started_at) }
    }
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or_default()
}

/// Whether a runtime of this accelerator is High-RAM: asked for, or the only shape it has.
fn high_mem_of(accelerator: &str, high_mem: bool) -> bool {
    high_mem || super::HIGH_MEM_ONLY.contains(&accelerator)
}

fn runtime_id(endpoint: &str) -> String {
    format!("colab:{endpoint}")
}

/// True when an error says the runtime no longer exists.
pub fn is_gone(error: &str) -> bool {
    error.starts_with(super::MACHINE_GONE) || error.contains(super::GONE)
}
fn clean(error: &str) -> String {
    error.strip_prefix(super::MACHINE_GONE).unwrap_or(error).to_string()
}

/// A stopped, failed or still-pending entry can be dismissed; a live one is stopped instead.
fn dismissable(runtime: &ColabThreadRuntime) -> bool {
    matches!(runtime.state.as_str(), "stopped" | "error") || runtime.endpoint.is_empty()
}

fn ready_entry(endpoint: &str, info: &Info, now: u64) -> ColabThreadRuntime {
    ColabThreadRuntime {
        id: runtime_id(endpoint),
        endpoint: endpoint.to_string(),
        name: if info.name.is_empty() { endpoint.to_string() } else { info.name.clone() },
        hardware: if info.hardware.is_empty() { "CPU".into() } else { info.hardware.clone() },
        high_mem: info.high_mem,
        state: "ready".into(),
        activity: None,
        browser_url: Some(super::browser_url(endpoint)),
        started_at: info.started_at.unwrap_or(now),
        busy_since: None,
        error: None,
    }
}

/// How a Cloud Agent's stage reads on the indicator: state, activity, error.
fn cloud_stage(stage: &str, detail: Option<&str>) -> (&'static str, Option<String>, Option<String>) {
    let detail = detail.map(str::trim).filter(|d| !d.is_empty());
    let text = |fallback: &str| Some(detail.unwrap_or(fallback).to_string());
    match stage {
        "creating" => ("creating", text("Allocating runtime…"), None),
        "installing" => ("busy", text("Installing the agent…"), None),
        "credentials" => ("busy", text("Signing in…"), None),
        "uploading" => ("busy", text("Uploading the checkout…"), None),
        "running" => ("busy", text("Agent running"), None),
        "syncing" => ("busy", text("Bringing changes back…"), None),
        "reconnecting" => ("busy", text("Catching up with the cloud run…"), None),
        "stopped" => ("stopped", None, None),
        "error" => ("error", None, text("The cloud agent stopped with an error.").map(|e| clean(&e))),
        _ => ("ready", None, None),
    }
}

/// The runtime a Colab Cloud Agent task shows, from its `sessions.cloud` state: none for
/// other providers, or before a machine exists unless it is being created. While creating
/// it is always the pending entry: a machine still on the state is the released old one.
pub(crate) fn from_cloud(state: &crate::cloud_agents::State, info: &Info, now: u64) -> Option<ColabThreadRuntime> {
    if state.provider != super::PROVIDER {
        return None;
    }
    let (kind, activity, error) = cloud_stage(&state.stage, state.detail.as_deref());
    let mut runtime = match state.native() {
        _ if kind == "creating" => ColabThreadRuntime { id: AGENT_PENDING.into(), endpoint: String::new(), browser_url: None, started_at: now, ..ready_entry("", info, now) },
        Some(native) => ready_entry(native, info, now),
        None => return None,
    };
    runtime.state = kind.into();
    runtime.activity = activity;
    runtime.error = error;
    runtime.busy_since = BUSY_STATES.contains(&kind).then_some(now);
    if kind == "stopped" {
        runtime.browser_url = None;
    }
    Some(runtime)
}

/// Brings an entry in line with Colab's list (`live`, asked for at `fetched_at`): hardware
/// and shape from it, a `stopped` entry Colab still has is ready again, and one Colab no
/// longer has reads as stopped, unless it started after the list was asked for. False when
/// nothing changed.
fn reconcile_entry(runtime: &mut ColabThreadRuntime, live: &Records, fetched_at: u64) -> bool {
    if runtime.endpoint.is_empty() || runtime.state == "creating" {
        return false;
    }
    let before = runtime.clone();
    match live.get(&runtime.endpoint) {
        Some(record) => {
            let info = Info::from_record(record);
            runtime.hardware = info.hardware;
            runtime.high_mem = info.high_mem;
            if runtime.name.is_empty() || runtime.name == runtime.endpoint {
                runtime.name = info.name;
            }
            if runtime.state == "stopped" {
                runtime.state = "ready".into();
                runtime.activity = None;
                runtime.error = None;
                runtime.busy_since = None;
                runtime.browser_url = Some(super::browser_url(&runtime.endpoint));
            }
        }
        None if runtime.state == "stopped" || runtime.started_at.saturating_add(RECORD_GRAIN_MS) > fetched_at => {}
        None => {
            runtime.state = "stopped".into();
            runtime.activity = Some(ENDED.into());
            runtime.error = None;
            runtime.busy_since = None;
            runtime.browser_url = None;
        }
    }
    *runtime != before
}

pub(crate) use tracker::Tracker;

fn tracker() -> &'static Tracker {
    static TRACKER: OnceLock<Tracker> = OnceLock::new();
    TRACKER.get_or_init(Tracker::default)
}

/// The runtimes PandaCode knows, from `colab-sessions.json` (a local read).
fn local_records() -> Records {
    store::path().map(|path| store::load(&path)).unwrap_or_default()
}
fn info_for(endpoint: &str, records: &Records) -> Info {
    tracker().info_for(endpoint, records)
}

/// The runtimes saved as `session_id`'s in `records`, as ready entries.
fn saved_for(records: &Records, session_id: &str, now: u64) -> Vec<ColabThreadRuntime> {
    records.values().filter(|r| r.session_id.as_deref() == Some(session_id) && crate::cloud::valid_native(&r.endpoint)).map(|r| ready_entry(&r.endpoint, &Info::from_record(r), now)).collect()
}

/// Saves that `session_id` uses `endpoint` (when no thread has it yet and it is not a Cloud
/// Agent's own runtime), so the thread still shows it after PandaCode restarts.
fn claim(app: &tauri::AppHandle, session_id: &str, endpoint: &str, records: &Records) {
    let unclaimed = records.get(endpoint).is_some_and(|record| record.session_id.is_none());
    if !unclaimed || tracker().is_forgotten(session_id) || crate::cloud_agents::tasks::colab_agent_runtime(app, endpoint) {
        return;
    }
    if let Err(error) = store::path().and_then(|path| store::claim(&path, endpoint, session_id)) {
        eprintln!("Colab: could not save which thread uses a runtime: {error}");
    }
}

/// The thread's Colab Cloud Agent runtime, if it has one.
fn cloud_runtime(app: &tauri::AppHandle, session_id: &str, records: &Records, now: u64) -> Option<ColabThreadRuntime> {
    let state = {
        let app_state = app.try_state::<crate::AppState>()?;
        let store = app_state.store.lock().ok()?;
        crate::cloud_agents::load(&store, session_id).ok().flatten()?
    };
    if state.provider != super::PROVIDER {
        return None;
    }
    // While creating, a machine still on the state is the old, released one.
    let info = match state.native().filter(|_| state.stage != "creating") {
        Some(native) => info_for(native, records),
        None => {
            let (accelerator, high_mem) = super::default_hardware();
            Info { name: format!("pc-{}", session_id.chars().take(8).collect::<String>()), hardware: hardware_label(&accelerator), high_mem: high_mem_of(&accelerator, high_mem), started_at: None }
        }
    };
    from_cloud(&state, &info, now)
}

/// The thread's runtimes, from memory and local files only: never a network call.
pub fn list_for_session(app: &tauri::AppHandle, session_id: &str) -> Vec<ColabThreadRuntime> {
    let now = now_ms();
    let records = local_records();
    tracker().adopt_saved(session_id, saved_for(&records, session_id, now));
    let derived = cloud_runtime(app, session_id, &records, now);
    tracker().merge(session_id, derived, now)
}

fn send(app: &tauri::AppHandle, session_id: &str, runtimes: &[ColabThreadRuntime]) {
    let _ = app.emit(EVENT, json!({"sessionId": session_id, "runtimes": runtimes}));
}

/// Sends the thread's current list.
pub fn emit(app: &tauri::AppHandle, session_id: &str) -> Vec<ColabThreadRuntime> {
    if tracker().is_forgotten(session_id) {
        return Vec::new();
    }
    let runtimes = list_for_session(app, session_id);
    send(app, session_id, &runtimes);
    runtimes
}

/// A Cloud Agent task's stage changed: its Colab runtime's status follows.
pub fn cloud_agent_changed(app: &tauri::AppHandle, session_id: &str) {
    let colab = app.try_state::<crate::AppState>().and_then(|state| {
        let store = state.store.lock().ok()?;
        crate::cloud_agents::load(&store, session_id).ok().flatten()
    });
    if colab.is_some_and(|state| state.provider == super::PROVIDER) {
        emit(app, session_id);
    }
}

pub fn begin_create(app: &tauri::AppHandle, session_id: &str, name: &str, accelerator: &str, high_mem: bool) -> Creating {
    let high_mem = high_mem_of(accelerator, high_mem);
    let id = tracker().begin_create(session_id, name, accelerator, high_mem, now_ms());
    emit(app, session_id);
    Creating { app: app.clone(), session_id: session_id.to_string(), pending_id: id, done: false }
}

/// Replaces the pending entry with the created runtime (`Ok(endpoint)`) or an error.
pub fn finish_create(app: &tauri::AppHandle, session_id: &str, pending_id: &str, outcome: std::result::Result<&str, &str>) {
    let records = local_records();
    let info = outcome.ok().and_then(|endpoint| records.get(endpoint)).map(Info::from_record).unwrap_or_default();
    tracker().finish_create(session_id, pending_id, outcome.map(|endpoint| (endpoint, &info)), now_ms());
    if let Ok(endpoint) = outcome {
        claim(app, session_id, endpoint, &records);
    }
    emit(app, session_id);
}

/// A runtime being created; dropped unfinished (an early return, a panic) it reads as failed.
pub struct Creating {
    app: tauri::AppHandle,
    session_id: String,
    pending_id: String,
    done: bool,
}
impl Creating {
    /// `Ok` holds the new machine's ID (`colab:<endpoint>`) or bare endpoint.
    pub fn finish(mut self, outcome: std::result::Result<&str, &str>) {
        self.done = true;
        finish_create(&self.app, &self.session_id, &self.pending_id, outcome.map(|id| id.strip_prefix("colab:").unwrap_or(id)));
    }
}
impl Drop for Creating {
    fn drop(&mut self) {
        if !self.done {
            finish_create(&self.app, &self.session_id, &self.pending_id, Err(INTERRUPTED));
        }
    }
}

/// The runtime enters `state` (`busy`, `restarting`, `stopping`) for `activity` until the
/// returned guard finishes or drops.
pub fn begin_busy(app: &tauri::AppHandle, session_id: &str, endpoint: &str, state: &str, activity: &str) -> Busy {
    let records = local_records();
    let info = info_for(endpoint, &records);
    let op = tracker().begin_busy(session_id, endpoint, &info, state, activity, now_ms());
    if state != "stopping" {
        claim(app, session_id, endpoint, &records);
    }
    emit(app, session_id);
    Busy { app: app.clone(), session_id: session_id.to_string(), endpoint: endpoint.to_string(), op, done: false }
}

fn finish_busy(app: &tauri::AppHandle, session_id: &str, endpoint: &str, op: u64, outcome: std::result::Result<(), &str>) {
    tracker().finish_busy(session_id, endpoint, op, outcome);
    emit(app, session_id);
}

/// One operation on a runtime. Dropped unfinished, the operation ends: an error or panic
/// never leaves the runtime `busy`. Only an error saying the runtime is gone reads as
/// `error`; any other failure leaves a live runtime ready (and the caller reports it).
pub struct Busy {
    app: tauri::AppHandle,
    session_id: String,
    endpoint: String,
    op: u64,
    done: bool,
}
impl Busy {
    pub fn finish<T>(mut self, outcome: &std::result::Result<T, String>) {
        self.done = true;
        finish_busy(&self.app, &self.session_id, &self.endpoint, self.op, outcome.as_ref().map(drop).map_err(String::as_str));
    }
    /// The runtime was released: it leaves every thread.
    pub fn released(mut self) {
        self.done = true;
        released(&self.app, &self.endpoint);
    }
}
impl Drop for Busy {
    fn drop(&mut self) {
        if !self.done {
            finish_busy(&self.app, &self.session_id, &self.endpoint, self.op, Ok(()));
        }
    }
}

/// A thread was deleted: its runtimes are no longer tracked (the runtimes themselves live on).
pub fn forget_session(session_id: &str) {
    forget_sessions(&[session_id.to_string()]);
}

/// Threads were deleted (one, or a whole project's): they leave the tracker, and every
/// runtime saved as theirs in `colab-sessions.json` is free for another thread to claim.
pub fn forget_sessions(session_ids: &[String]) {
    session_ids.iter().for_each(|sid| tracker().forget(sid));
    if session_ids.is_empty() {
        return;
    }
    if let Err(error) = store::path().and_then(|path| disown_saved(&path, session_ids)) {
        eprintln!("Colab: could not forget which deleted thread used a runtime: {error}");
    }
}

/// Frees the runtimes saved as any of `session_ids`' in the file at `path`. A thread that
/// owned none (the usual case) never takes the file lock or rewrites the file.
fn disown_saved(path: &std::path::Path, session_ids: &[String]) -> Result<()> {
    let owned = store::load(path).values().any(|r| r.session_id.as_ref().is_some_and(|sid| session_ids.contains(sid)));
    if owned {
        store::disown_sessions(path, session_ids)?;
    }
    Ok(())
}

/// Whether the thread shows runtime `endpoint` as live, so it can be opened, restarted or
/// stopped (a local read). A stopped runtime has nothing left to act on.
pub fn shows(app: &tauri::AppHandle, session_id: &str, endpoint: &str) -> bool {
    shown(&list_for_session(app, session_id), endpoint)
}
fn shown(list: &[ColabThreadRuntime], endpoint: &str) -> bool {
    !endpoint.is_empty() && list.iter().any(|r| r.endpoint == endpoint && r.state != "stopped")
}

/// A runtime was released (stopped or deleted), from anywhere: it leaves every thread, an
/// idle Colab Cloud Agent task on it reads as stopped, and every thread affected hears.
pub fn released(app: &tauri::AppHandle, endpoint: &str) {
    let mut sessions = tracker().release(endpoint);
    sessions.extend(crate::cloud_agents::tasks::colab_runtime_released(app, endpoint));
    sessions.sort();
    sessions.dedup();
    for session_id in sessions {
        emit(app, &session_id);
    }
}

/// Dismisses a stopped, failed or pending entry by ID or endpoint; a dismissed runtime is
/// no longer saved as the thread's.
pub fn dismiss(app: &tauri::AppHandle, session_id: &str, key: &str) -> Result<Vec<ColabThreadRuntime>> {
    tracker().dismiss(session_id, key, &list_for_session(app, session_id))?;
    let endpoint = key.strip_prefix("colab:").unwrap_or(key);
    if local_records().get(endpoint).is_some_and(|record| record.session_id.as_deref() == Some(session_id)) {
        if let Err(error) = store::path().and_then(|path| store::disown(&path, endpoint, session_id)) {
            eprintln!("Colab: could not forget which thread used a runtime: {error}");
        }
    }
    Ok(emit(app, session_id))
}

/// Folds Colab's live list (`live`, asked for at `fetched_at`) into the thread's runtimes:
/// hardware is updated, runtimes Colab no longer has read as stopped (unless created after
/// the list was asked for) and stopped ones it still has are ready again.
pub fn reconcile_live(app: &tauri::AppHandle, session_id: &str, live: &Records, fetched_at: u64) -> Vec<ColabThreadRuntime> {
    tracker().reconcile(session_id, live, fetched_at);
    for mut runtime in list_for_session(app, session_id) {
        let tracked = tracker().snapshot(session_id).iter().any(|r| r.id == runtime.id);
        if !tracked && reconcile_entry(&mut runtime, live, fetched_at) && runtime.state == "stopped" {
            tracker().adopt(session_id, runtime);
        }
    }
    emit(app, session_id)
}

mod tracker;

#[cfg(test)]
mod tests;
