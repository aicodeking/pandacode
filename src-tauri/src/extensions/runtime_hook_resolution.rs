//! Hook chains across packages: the user's order, budgets, late answers, failure policies and failure notices
//! (runtime phase R5, slice R0506).
//!
//! * **Order.** Every awaited chain (R0504's `prompt.submit`, `tool.after`, `compaction`; R0505's `tool.before`) asks
//!   its packages in one order, held natively in `extension-grants-v1/_hooks.json`
//!   (`{ "schema": 1, "order": ["<package id>"], "firstEnabled": ["<package id>"] }`). `order` is the user's, set in
//!   Settings -> Extensions (`extensions_hook_order_change`); `firstEnabled` is the frozen default the host keeps: a
//!   package is appended once, the first time it is seen enabled (several at once: by id), and keeps its place when it
//!   is disabled or updated. Uninstall removes the id from both lists, so a reinstall starts at the end. The effective
//!   order is [`resolve`]: the user's ids first (a repeated id counts once, at its first place), then the default, then
//!   anything else by id. Safe mode reads and writes nothing. [`HookRegistry::attached`] returns hooks in this order,
//!   so both chains and the ask-at-host holders follow it.
//! * **Members.** [`ask_member`] asks one package of a chain: it checks first that the hook is still attached, the
//!   receiving grant still holds and the service was not stopped by the user ([`admitted`]); a hook removed by
//!   revoke, disable, uninstall, a user's stop or safe mode is skipped (no failure policy, no receipt), also when that
//!   happens while it is being asked. A service that crashed or was parked keeps its hooks as failing members
//!   ([`service_ended`] marks them down), so its declared `onFailure` applies until it runs again.
//! * **Budgets.** [`budget`] clamps the declaration's `budgetMs` to the event's ceiling (30 s for tool events, 10 s
//!   for `prompt.submit`, 120 s for `compaction`) and to what is left of the chain's 60 s; a member not reached by then
//!   fails with `Timeout` without being asked.
//! * **Late answers.** An answer that arrives after the budget is never applied: the package gets a receipt
//!   `{ applied: false, code: 'Timeout' }` ([`late_receipt`]).
//! * **Failures.** A throw, an invalid return, a timeout or a service that is not running follows `onFailure`
//!   (`continue`, `ask`, `deny`; never approve). Three failures in a row of one package's hook give one notice in the
//!   task ([`Streaks`]); a success starts the count again.
//!
//! Everything here is for predictability and fault isolation (ADR-0004, ADR-0005).
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    sync::{atomic::{AtomicBool, Ordering}, Arc, LazyLock, Mutex},
    time::Duration,
};
use tokio::{sync::oneshot, time::Instant};

use crate::extensions::runtime_hook_context::{Ask, CHAIN_MS};
use crate::extensions::runtime_hook_registration::{self as hooks, Deliver, HookRegistry, Occurrence, Target};

/// The folder of the grants file; the order file lives beside it.
pub const FOLDER: &str = "extension-grants-v1";
pub const FILE: &str = "_hooks.json";
/// Most ids the user's order may list.
pub const MAX_ORDER: usize = 256;
/// Most ids the default ledger keeps.
const MAX_LEDGER: usize = 4_096;
const MAX_FILE: u64 = 1024 * 1024;
/// Failures in a row of one hook that give one notice.
pub const NOTICE_AFTER: u32 = 3;

type Result<T> = std::result::Result<T, &'static str>;

// ---------------------------------------------------------------------------------------------------------------
// The order
// ---------------------------------------------------------------------------------------------------------------

/// The effective order of `ids`: the user's order first (a repeated id at its first place), then the default
/// (first enabled), then any other id by id.
pub fn resolve(user: &[String], first_enabled: &[String], ids: &[String]) -> Vec<String> {
    let position = |list: &[String], id: &str| list.iter().position(|entry| entry == id);
    let mut out: Vec<String> = ids.to_vec();
    out.sort();
    out.dedup();
    out.sort_by_key(|id| match position(user, id) {
        Some(at) => (0, at, 0, String::new()),
        None => (1, 0, position(first_enabled, id).unwrap_or(usize::MAX), id.clone()),
    });
    out
}

fn id_ok(id: &str) -> bool { !id.is_empty() && id.len() <= 128 && !id.chars().any(char::is_control) }
fn dedup_keep_first(list: &mut Vec<String>) {
    let mut seen = BTreeSet::new();
    list.retain(|id| seen.insert(id.clone()));
}

/// `_hooks.json`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OrderFile {
    pub schema: u8,
    pub order: Vec<String>,
    #[serde(default, rename = "firstEnabled", skip_serializing_if = "Vec::is_empty")]
    pub first_enabled: Vec<String>,
}
impl OrderFile {
    fn empty() -> Self { Self { schema: 1, ..Self::default() } }
    fn valid(&self) -> bool {
        self.schema == 1 && self.order.len() <= MAX_ORDER && self.first_enabled.len() <= MAX_LEDGER
            && self.order.iter().chain(&self.first_enabled).all(|id| id_ok(id))
    }
    /// Every id the file knows, in the effective order.
    pub fn effective(&self) -> Vec<String> {
        let ids: Vec<String> = self.order.iter().chain(&self.first_enabled).cloned().collect();
        resolve(&self.order, &self.first_enabled, &ids)
    }
    /// Brings the default ledger in line with an `extensions_snapshot`: uninstalled ids leave both lists, newly enabled
    /// ids are appended (by id when several appear at once). Safe mode changes nothing. Answers whether it changed.
    pub fn sync(&mut self, snapshot: &Value) -> bool {
        if snapshot["safeMode"] == true { return false; }
        let Some(packages) = snapshot["packages"].as_array() else { return false };
        let before = self.clone();
        let installed: BTreeSet<String> = packages.iter().filter_map(|package| package["manifest"]["id"].as_str()).map(str::to_owned).collect();
        self.order.retain(|id| installed.contains(id));
        self.first_enabled.retain(|id| installed.contains(id));
        let enabled: BTreeSet<String> = packages.iter().filter(|package| package["enabled"] == true).filter_map(|package| package["manifest"]["id"].as_str()).filter(|id| id_ok(id)).map(str::to_owned).collect();
        for id in enabled {
            if self.first_enabled.len() >= MAX_LEDGER { break; }
            if !self.first_enabled.contains(&id) { self.first_enabled.push(id); }
        }
        *self != before
    }
    /// The user's change: `{ op: 'set', order }`, `{ op: 'move', id, to }` (a place in [`hook_packages`]'s list) or
    /// `{ op: 'reset' }`. `UnknownReference` for an id that is not installed, `DuplicateId` for a repeated one,
    /// `InvalidArguments` for anything else malformed. Nothing changes on a refusal.
    pub fn change(&mut self, request: &Value, snapshot: &Value) -> Result<()> {
        if snapshot["safeMode"] == true { return Err("Unavailable"); }
        let installed: BTreeSet<String> = snapshot["packages"].as_array().into_iter().flatten().filter_map(|package| package["manifest"]["id"].as_str()).map(str::to_owned).collect();
        let object = request.as_object().ok_or("InvalidArguments")?;
        let next = match object.get("op").and_then(Value::as_str) {
            Some("reset") => { if object.len() != 1 { return Err("InvalidArguments"); } vec![] }
            Some("set") => {
                if object.len() != 2 { return Err("InvalidArguments"); }
                let list = object.get("order").and_then(Value::as_array).ok_or("InvalidArguments")?;
                if list.len() > MAX_ORDER { return Err("LimitExceeded"); }
                let mut seen = BTreeSet::new();
                let mut next = Vec::with_capacity(list.len());
                for entry in list {
                    let id = entry.as_str().filter(|id| id_ok(id)).ok_or("InvalidArguments")?;
                    if !installed.contains(id) { return Err("UnknownReference"); }
                    if !seen.insert(id.to_owned()) { return Err("DuplicateId"); }
                    next.push(id.to_owned());
                }
                next
            }
            Some("move") => {
                if object.len() != 3 { return Err("InvalidArguments"); }
                let id = object.get("id").and_then(Value::as_str).ok_or("InvalidArguments")?;
                let to = object.get("to").and_then(Value::as_u64).ok_or("InvalidArguments")? as usize;
                let mut shown: Vec<String> = hook_packages(snapshot).into_iter().map(|(id, _)| id).collect();
                shown = resolve(&self.order, &self.first_enabled, &shown);
                let from = shown.iter().position(|entry| entry == id).ok_or("UnknownReference")?;
                if to >= shown.len() { return Err("InvalidArguments"); }
                let moved = shown.remove(from);
                shown.insert(to, moved);
                // The user's order becomes the whole list as shown, so every package keeps the place the user saw.
                let mut next = shown;
                next.extend(self.order.iter().filter(|other| !hook_packages(snapshot).iter().any(|(id, _)| id == *other)).cloned());
                dedup_keep_first(&mut next);
                next.truncate(MAX_ORDER);
                next
            }
            _ => return Err("InvalidArguments"),
        };
        self.order = next;
        Ok(())
    }
}

/// Installed packages that declare hooks, with their declared events (the list the settings control orders).
pub fn hook_packages(snapshot: &Value) -> Vec<(String, Vec<String>)> {
    snapshot["packages"].as_array().into_iter().flatten().filter_map(|package| {
        let id = package["manifest"]["id"].as_str()?;
        let events: Vec<String> = package["manifest"]["contributes"]["hooks"].as_array().into_iter().flatten().filter_map(|hook| hook["event"].as_str()).map(str::to_owned).collect();
        (!events.is_empty()).then(|| (id.to_owned(), events))
    }).collect()
}

struct Loaded { file: OrderFile, corrupt: bool }
/// The order file. The app has one (managed state); tests open their own.
pub struct HookOrder { path: PathBuf, state: Mutex<Loaded> }
impl HookOrder {
    /// Opens `<dir>/extension-grants-v1/_hooks.json`. A missing file is the default order; an unreadable or malformed
    /// one is kept on disk untouched and answers the default order (ids by first enabled in this launch) until the
    /// user's next change replaces it. A repeated id in a hand-edited file counts at its first place.
    pub fn open(dir: &Path) -> Self {
        let path = dir.join(FOLDER).join(FILE);
        let loaded = match std::fs::metadata(&path) {
            Err(_) => Loaded { file: OrderFile::empty(), corrupt: false },
            Ok(meta) if meta.len() > MAX_FILE => Loaded { file: OrderFile::empty(), corrupt: true },
            Ok(_) => match std::fs::read(&path).ok().and_then(|bytes| serde_json::from_slice::<OrderFile>(&bytes).ok()).filter(OrderFile::valid) {
                Some(mut file) => { dedup_keep_first(&mut file.order); dedup_keep_first(&mut file.first_enabled); Loaded { file, corrupt: false } }
                None => Loaded { file: OrderFile::empty(), corrupt: true },
            },
        };
        Self { path, state: Mutex::new(loaded) }
    }
    fn lock(&self) -> std::sync::MutexGuard<'_, Loaded> { self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) }
    fn write(&self, file: &OrderFile) -> Result<()> {
        let parent = self.path.parent().ok_or("StorageUnavailable")?;
        std::fs::create_dir_all(parent).map_err(|_| "StorageUnavailable")?;
        let stage = self.path.with_extension("stage");
        std::fs::write(&stage, serde_json::to_vec_pretty(file).map_err(|_| "MalformedData")?).map_err(|_| "StorageUnavailable")?;
        std::fs::rename(&stage, &self.path).map_err(|_| "StorageUnavailable")
    }
    pub fn file(&self) -> OrderFile { self.lock().file.clone() }
    pub fn corrupt(&self) -> bool { self.lock().corrupt }
    /// [`OrderFile::sync`], written when it changed (never over a damaged file).
    pub fn sync(&self, snapshot: &Value) -> Result<bool> {
        let mut state = self.lock();
        let mut next = state.file.clone();
        if !next.sync(snapshot) { return Ok(false); }
        if !state.corrupt { self.write(&next)?; }
        state.file = next;
        Ok(true)
    }
    /// [`OrderFile::change`], written before it takes effect; a damaged file is replaced by the user's change.
    pub fn change(&self, request: &Value, snapshot: &Value) -> Result<()> {
        let mut state = self.lock();
        let mut next = state.file.clone();
        next.sync(snapshot);
        next.change(request, snapshot)?;
        self.write(&next)?;
        state.file = next;
        state.corrupt = false;
        Ok(())
    }
    /// The effective order of every id the file knows.
    pub fn effective(&self) -> Vec<String> { self.lock().file.effective() }
    /// What the settings control draws: the packages that declare hooks, in the order the chains use.
    pub fn projection(&self, snapshot: &Value, streaks: &Streaks) -> Value {
        let state = self.lock();
        let listed = hook_packages(snapshot);
        let ids: Vec<String> = listed.iter().map(|(id, _)| id.clone()).collect();
        let ordered = resolve(&state.file.order, &state.file.first_enabled, &ids);
        let packages: Vec<Value> = ordered.iter().enumerate().map(|(index, id)| {
            let package = snapshot["packages"].as_array().into_iter().flatten().find(|package| package["manifest"]["id"] == id.as_str()).cloned().unwrap_or(Value::Null);
            let name = package["manifest"]["name"].as_str().filter(|name| !name.trim().is_empty()).unwrap_or(id.as_str()).to_owned();
            let events = listed.iter().find(|(owner, _)| owner == id).map(|(_, events)| events.clone()).unwrap_or_default();
            json!({
                "id": id, "name": name, "position": index + 1, "enabled": package["enabled"] == true,
                "placed": if state.file.order.contains(id) { "user" } else { "default" },
                "events": events, "failures": streaks.of(id),
            })
        }).collect();
        json!({"schemaVersion": 1, "available": !state.corrupt, "safeMode": snapshot["safeMode"] == true, "custom": !state.file.order.is_empty(), "packages": packages})
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Budgets, members and late answers
// ---------------------------------------------------------------------------------------------------------------

/// What one member may wait: its `budgetMs` inside the event's ceiling, inside what is left of the 60 s chain.
pub fn budget(event: &str, declared_ms: u64, elapsed: Duration) -> Duration {
    let own = match hooks::budget_range(event) { Some((low, high)) => declared_ms.clamp(low, high), None => declared_ms.min(hooks::DEFAULT_BUDGET_MS) };
    Duration::from_millis(own).min(Duration::from_millis(CHAIN_MS).saturating_sub(elapsed))
}

/// `(owner)`: is the package's service present, that is not stopped or stopping at the user's request (a running,
/// starting, restarting, failed or parked service is present: its hooks still answer for it).
pub type Presence = Arc<dyn Fn(&str) -> bool + Send + Sync>;
static PRESENCE: Mutex<Option<Presence>> = Mutex::new(None);
fn presence() -> Option<Presence> { PRESENCE.lock().ok().and_then(|slot| slot.clone()) }

/// Whether a member of a chain is still part of it: attached (running or down), its receiving grant holds for the
/// occurrence's project, and its service is present. A down hook whose service is gone is removed here.
pub fn admitted_with(registry: &HookRegistry, target: &Target, occurrence: &Occurrence, present: Option<&Presence>) -> bool {
    if !registry.listeners(&target.owner).iter().any(|event| event == occurrence.event) { return false; }
    if !registry.holds(&target.owner, &target.version, hooks::permission_of(occurrence.event), Some(&occurrence.project)) { return false; }
    if present.is_some_and(|present| !present(&target.owner)) {
        if registry.down(&target.owner) { registry.remove_owner(&target.owner); }
        return false;
    }
    true
}
/// [`admitted_with`] with the app's presence check.
pub fn admitted(registry: &HookRegistry, target: &Target, occurrence: &Occurrence) -> bool { admitted_with(registry, target, occurrence, presence().as_ref()) }

/// Where a late answer's receipt goes.
#[derive(Clone, Debug)]
pub struct Late { pub hook_id: String, pub event: String, pub task: String, pub call: Option<String> }
/// The receipt of an answer that came after the budget: never applied.
pub fn late_receipt(late: &Late) -> Value {
    let mut receipt = json!({"schemaVersion": 1, "hookId": late.hook_id, "event": late.event, "taskId": late.task, "applied": false, "code": "Timeout"});
    if let Some(call) = &late.call { receipt["callId"] = json!(call); }
    json!({"schemaVersion": 1, "receipt": receipt})
}
/// Waits for the late answer (at most a chain's length) and tells the package it was not applied.
fn dispose_late(receiver: oneshot::Receiver<std::result::Result<Value, String>>, deliver: Option<Deliver>, owner: String, late: Late) {
    let work = async move {
        if let Ok(Ok(Ok(value))) = tokio::time::timeout(Duration::from_millis(CHAIN_MS), receiver).await {
            if !value.is_null() { if let Some(deliver) = deliver { let _ = deliver(&owner, late_receipt(&late)); } }
        }
    };
    if tokio::runtime::Handle::try_current().is_ok() { tokio::spawn(work); } else { tauri::async_runtime::spawn(work); }
}

/// One member asked.
#[derive(Debug)]
pub enum Asked {
    /// Removed by the user (revoke, disable, uninstall, stop, safe mode) before or while it was asked: no policy, no
    /// receipt.
    Removed,
    /// Its answer or its failure code; `asked: false` when the chain's 60 s were gone before it was reached.
    Answered { answer: std::result::Result<Value, String>, asked: bool },
}

/// Asks one member of a chain inside its budget ([`budget`]), after checking it still belongs to the chain, and checks
/// again after a failure (a hook removed while it was asked is skipped, not failed). An answer after the budget is a
/// `Timeout`; the package gets a receipt saying it was not applied if it still answers.
pub async fn ask_member(registry: &HookRegistry, ask: &Ask, target: &Target, occurrence: &Occurrence, frame: Value, started: Instant, late: Late) -> Asked {
    ask_member_with(registry, ask, target, occurrence, frame, started, late, presence().as_ref()).await
}
#[allow(clippy::too_many_arguments)]
pub async fn ask_member_with(registry: &HookRegistry, ask: &Ask, target: &Target, occurrence: &Occurrence, frame: Value, started: Instant, late: Late, present: Option<&Presence>) -> Asked {
    if !admitted_with(registry, target, occurrence, present) { return Asked::Removed; }
    let wait = budget(occurrence.event, target.declaration.budget_ms, started.elapsed());
    if wait.is_zero() { return Asked::Answered { answer: Err("Timeout".into()), asked: false }; }
    let answer = match ask(&target.owner, frame) {
        Err(code) => Err(code.to_owned()),
        Ok(mut receiver) => match tokio::time::timeout(wait, &mut receiver).await {
            Ok(Ok(answer)) => answer,
            Ok(Err(_)) => Err("HostUnavailable".to_owned()),
            Err(_) => { dispose_late(receiver, registry.deliverer(), target.owner.clone(), late); Err("Timeout".to_owned()) }
        },
    };
    if answer.is_err() && !admitted_with(registry, target, occurrence, present) { return Asked::Removed; }
    Asked::Answered { answer, asked: true }
}

/// The failure a step was, for the streak: its error, or an invalid return (`InvalidShape`, `LimitExceeded`).
pub fn failure_of(answer: &std::result::Result<Value, String>, new_codes: &[Option<String>]) -> Option<String> {
    match answer {
        Err(code) => Some(code.clone()),
        Ok(_) => new_codes.iter().flatten().find(|code| matches!(code.as_str(), "InvalidShape" | "LimitExceeded")).cloned(),
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Failure streaks and the notice
// ---------------------------------------------------------------------------------------------------------------

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Streak { pub consecutive: u32, pub code: Option<String>, pub noticed: bool }
/// Consecutive failures per `(package, event)`.
#[derive(Default)]
pub struct Streaks(Mutex<BTreeMap<(String, String), Streak>>);
impl Streaks {
    fn lock(&self) -> std::sync::MutexGuard<'_, BTreeMap<(String, String), Streak>> { self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) }
    /// Records one asked member: a failure code or a success. Answers `true` exactly once per streak, at the
    /// [`NOTICE_AFTER`]th failure in a row; a success ends the streak.
    pub fn record(&self, owner: &str, event: &str, failure: Option<&str>) -> bool {
        let mut map = self.lock();
        let key = (owner.to_owned(), event.to_owned());
        let Some(code) = failure else { map.remove(&key); return false };
        if map.len() >= 4_096 && !map.contains_key(&key) { map.clear(); }
        let streak = map.entry(key).or_default();
        streak.consecutive = streak.consecutive.saturating_add(1);
        streak.code = Some(code.to_owned());
        if streak.consecutive >= NOTICE_AFTER && !streak.noticed { streak.noticed = true; return true; }
        false
    }
    pub fn get(&self, owner: &str, event: &str) -> Option<Streak> { self.lock().get(&(owner.to_owned(), event.to_owned())).cloned() }
    /// The failing hooks of a package for the settings control: `[{ event, consecutive, code }]`, or `null`.
    pub fn of(&self, owner: &str) -> Value {
        let list: Vec<Value> = self.lock().iter().filter(|((id, _), _)| id == owner).map(|((_, event), streak)| json!({"event": event, "consecutive": streak.consecutive, "code": streak.code})).collect();
        if list.is_empty() { Value::Null } else { json!(list) }
    }
    /// A package was removed: its streaks go.
    pub fn forget(&self, owner: &str) { self.lock().retain(|(id, _), _| id != owner); }
}
static STREAKS: LazyLock<Streaks> = LazyLock::new(Streaks::default);
/// The app's streaks.
pub fn streaks() -> &'static Streaks { &STREAKS }

/// The notice text: names the package, the hook, the last code and what its declared policy does meanwhile.
pub fn notice_text(name: &str, event: &str, code: &str, policy: &str) -> String {
    let meanwhile = match policy {
        "deny" if event == "prompt.submit" => "messages are not sent while it fails",
        "deny" => "tool calls are denied while it fails",
        "ask" => "you are asked to decide while it fails",
        _ => "it is left out while it fails",
    };
    format!("{name}'s {event} hook failed {NOTICE_AFTER} times in a row ({code}). As it declared, {meanwhile}. Check it in Settings > Extensions.")
}

/// One failure notice, for the app's notifier.
#[derive(Clone, Debug, PartialEq)]
pub struct Notice { pub owner: String, pub name: String, pub event: String, pub code: String, pub policy: String, pub task: String }
pub type Notifier = Arc<dyn Fn(&Notice) + Send + Sync>;
static NOTIFIER: Mutex<Option<Notifier>> = Mutex::new(None);

/// Records what one asked member did in the app's streaks and gives the notice when it is due. A member the chain
/// never reached (`asked: false`) changes nothing.
pub fn settle(target: &Target, event: &str, name: &str, task: &str, failure: Option<&str>, asked: bool) -> Option<Notice> {
    if !asked { return None; }
    if !STREAKS.record(&target.owner, event, failure) { return None; }
    let notice = Notice { owner: target.owner.clone(), name: name.to_owned(), event: event.to_owned(), code: failure.unwrap_or("Timeout").to_owned(), policy: target.declaration.on_failure.clone(), task: task.to_owned() };
    if let Some(notifier) = NOTIFIER.lock().ok().and_then(|slot| slot.clone()) { notifier(&notice); }
    Some(notice)
}

// ---------------------------------------------------------------------------------------------------------------
// The app
// ---------------------------------------------------------------------------------------------------------------

/// The service of `owner` ended. Asked by the user (stop, disable, uninstall, update, trust, safe mode, quit; the
/// lifetime marked it stopping first): its hooks are removed. A crash (the service was still running or starting):
/// its hooks stay as failing members until it registers them again or the user removes it.
pub fn service_ended(app: &tauri::AppHandle, owner: &str) {
    if crashed(app, owner) { hooks::registry().mark_down(owner); } else { hooks::registry().remove_owner(owner); STREAKS.forget(owner); }
}
fn service_state(app: &tauri::AppHandle, owner: &str) -> Option<String> {
    use tauri::Manager;
    let services = app.try_state::<crate::extensions::runtime_service_lifetime::ServiceLifetime>()?;
    let projection = services.projection();
    let state = projection["services"].as_array()?.iter().find(|service| service["id"] == owner)?["state"].as_str()?.to_owned();
    Some(state)
}
fn crashed(app: &tauri::AppHandle, owner: &str) -> bool { matches!(service_state(app, owner).as_deref(), Some("running" | "starting")) }

fn snapshot(app: &tauri::AppHandle) -> Option<Value> {
    use tauri::Manager;
    let packages = app.try_state::<crate::extensions::packages::ExtensionPackages>()?;
    let snapshot = serde_json::to_value(packages.0.lock().ok()?.snapshot()).ok()?;
    Some(snapshot)
}
fn system_line(app: &tauri::AppHandle, task: &str, text: &str) {
    use tauri::{Emitter, Manager};
    let Some(state) = app.try_state::<crate::AppState>() else { return };
    let saved = state.store.lock().ok().map(|store| store.insert_message(task, "system", text));
    if saved.is_some() { let _ = app.emit("sessions-changed", ()); }
}

static INSTALLED: AtomicBool = AtomicBool::new(false);
/// Wires the app's presence check and failure notifier once.
fn install(app: &tauri::AppHandle) {
    if INSTALLED.swap(true, Ordering::AcqRel) { return; }
    let present = app.clone();
    if let Ok(mut slot) = PRESENCE.lock() {
        *slot = Some(Arc::new(move |owner: &str| {
            use tauri::Manager;
            if present.try_state::<crate::extensions::runtime_service_lifetime::ServiceLifetime>().is_none() { return true; }
            !matches!(service_state(&present, owner).as_deref(), None | Some("stopping" | "stopped"))
        }));
    }
    let notify = app.clone();
    if let Ok(mut slot) = NOTIFIER.lock() {
        *slot = Some(Arc::new(move |notice: &Notice| {
            use tauri::Emitter;
            system_line(&notify, &notice.task, &notice_text(&notice.name, &notice.event, &notice.code, &notice.policy));
            let _ = notify.emit("extension-hook-notice", json!({"package": notice.owner, "name": notice.name, "event": notice.event, "code": notice.code, "policy": notice.policy}));
        }));
    }
}
/// Syncs the order with the packages and hands it to the registry.
fn apply(app: &tauri::AppHandle) {
    use tauri::Manager;
    let Some(order) = app.try_state::<HookOrder>() else { return };
    if let Some(snapshot) = snapshot(app) { let _ = order.sync(&snapshot); }
    hooks::registry().set_order(order.effective());
}
/// A hook was registered (`panda.hooks.on`): the order knows every enabled package, and the registry uses it.
pub fn registered(app: &tauri::AppHandle) {
    install(app);
    apply(app);
}

/// The settings control's read: the packages that declare hooks in the order the chains use.
#[tauri::command]
pub fn extensions_hook_order(app: tauri::AppHandle, order: tauri::State<'_, HookOrder>) -> std::result::Result<Value, String> {
    install(&app);
    apply(&app);
    let snapshot = snapshot(&app).ok_or("Extension manager unavailable.")?;
    Ok(order.projection(&snapshot, &STREAKS))
}
/// The user's change (`{ op: 'set' | 'move' | 'reset', ... }`); answers the new projection. The next chain asked uses it.
#[tauri::command]
pub fn extensions_hook_order_change(app: tauri::AppHandle, order: tauri::State<'_, HookOrder>, request: Value) -> std::result::Result<Value, String> {
    install(&app);
    let snapshot = snapshot(&app).ok_or("Extension manager unavailable.")?;
    order.change(&request, &snapshot).map_err(str::to_owned)?;
    hooks::registry().set_order(order.effective());
    Ok(order.projection(&snapshot, &STREAKS))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::extensions::runtime_hook_context::{Fold, PromptFold, Step};
    use crate::extensions::runtime_hook_decisions::{DecisionFold, Outcome};
    use crate::extensions::runtime_hook_registration::{Declaration, Match};
    use std::sync::Mutex as StdMutex;

    const ORDER: &str = include_str!("../../../tests/fixtures/extensions/runtime-hook-resolution/order.json");
    const CHAINS: &str = include_str!("../../../tests/fixtures/extensions/runtime-hook-resolution/chains.json");
    const STREAK: &str = include_str!("../../../tests/fixtures/extensions/runtime-hook-resolution/streaks.json");

    fn strings(value: &Value) -> Vec<String> { value.as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect() }
    struct Dir(PathBuf);
    impl Drop for Dir { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }
    fn dir(label: &str) -> Dir {
        let path = std::env::temp_dir().join(format!("pandacode-hook-order-{label}-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&path).unwrap();
        Dir(path)
    }

    #[test]
    fn the_order_corpus_resolves_like_the_twin() {
        let corpus: Value = serde_json::from_str(ORDER).unwrap();
        for case in corpus["resolve"].as_array().unwrap() {
            let got = resolve(&strings(&case["user"]), &strings(&case["firstEnabled"]), &strings(&case["ids"]));
            assert_eq!(json!(got), case["expect"], "{}", case["id"]);
        }
    }

    /// The scripted life of the order file: syncs with snapshots, the user's changes and their refusals, a restart
    /// (the file opened again), uninstall and reinstall, safe mode and a damaged file.
    #[test]
    fn the_order_file_lives_through_the_script() {
        let corpus: Value = serde_json::from_str(ORDER).unwrap();
        let home = dir("script");
        let mut order = HookOrder::open(&home.0);
        for step in corpus["script"].as_array().unwrap() {
            let label = step["id"].as_str().unwrap();
            match step["do"].as_str().unwrap() {
                "sync" => { order.sync(&step["snapshot"]).unwrap(); }
                "change" => {
                    let result = order.change(&step["request"], &step["snapshot"]);
                    assert_eq!(json!(result.err()), step["error"], "{label}");
                }
                "restart" => { order = HookOrder::open(&home.0); }
                "damage" => { std::fs::write(home.0.join(FOLDER).join(FILE), b"{ not json").unwrap(); order = HookOrder::open(&home.0); }
                other => panic!("unknown step {other}"),
            }
            let file = order.file();
            if let Some(expected) = step.get("order") { assert_eq!(json!(file.order), *expected, "{label}: order"); }
            if let Some(expected) = step.get("firstEnabled") { assert_eq!(json!(file.first_enabled), *expected, "{label}: firstEnabled"); }
            if let Some(expected) = step.get("effective") { assert_eq!(json!(order.effective()), *expected, "{label}: effective"); }
            if let Some(expected) = step.get("available") { assert_eq!(json!(!order.corrupt()), *expected, "{label}: available"); }
            if let Some(expected) = step.get("shown") {
                let projection = order.projection(&step["snapshot"], &Streaks::default());
                let shown: Vec<Value> = projection["packages"].as_array().unwrap().iter().map(|package| json!([package["id"], package["placed"]])).collect();
                assert_eq!(json!(shown), *expected, "{label}: shown");
            }
            // What is on disk is exactly the contract's shape (plus the default ledger) whenever the file is healthy.
            if !order.corrupt() && home.0.join(FOLDER).join(FILE).exists() {
                let disk: Value = serde_json::from_slice(&std::fs::read(home.0.join(FOLDER).join(FILE)).unwrap()).unwrap();
                assert_eq!(disk["schema"], 1, "{label}");
                assert_eq!(disk["order"], json!(file.order), "{label}");
            }
        }
    }

    #[test]
    fn budgets_keep_the_event_ceiling_and_the_chain() {
        assert_eq!(budget("tool.before", 45_000, Duration::ZERO), Duration::from_millis(30_000));
        assert_eq!(budget("prompt.submit", 45_000, Duration::ZERO), Duration::from_millis(10_000));
        assert_eq!(budget("compaction", 120_000, Duration::ZERO), Duration::from_millis(60_000));
        assert_eq!(budget("tool.before", 50, Duration::ZERO), Duration::from_millis(100));
        assert_eq!(budget("tool.before", 2_000, Duration::from_millis(59_000)), Duration::from_millis(1_000));
        assert_eq!(budget("tool.before", 2_000, Duration::from_millis(60_000)), Duration::ZERO);
    }

    #[test]
    fn streaks_give_one_notice_per_run_of_failures() {
        let corpus: Value = serde_json::from_str(STREAK).unwrap();
        for case in corpus["cases"].as_array().unwrap() {
            let streaks = Streaks::default();
            let notices: Vec<bool> = case["steps"].as_array().unwrap().iter().map(|step| streaks.record("sample.hook-a", "tool.before", step.as_str())).collect();
            assert_eq!(json!(notices), case["notices"], "{}", case["id"]);
        }
        assert_eq!(notice_text("Alpha", "tool.before", "Timeout", "deny"), "Alpha's tool.before hook failed 3 times in a row (Timeout). As it declared, tool calls are denied while it fails. Check it in Settings > Extensions.");
    }

    // -----------------------------------------------------------------------------------------------------------
    // Chains with a controlled clock
    // -----------------------------------------------------------------------------------------------------------

    fn declaration(member: &Value, event: &str) -> Declaration {
        Declaration { id: member["hookId"].as_str().unwrap().into(), event: event.into(), on_failure: member["onFailure"].as_str().unwrap_or("continue").into(), budget_ms: member["budgetMs"].as_u64().unwrap_or(2_000), matcher: Match::default() }
    }
    /// A registry with the case's members attached, ordered by the case's order file; a member `down` crashed before.
    fn chain_registry(case: &Value, event: &str) -> (Arc<HookRegistry>, Arc<StdMutex<Vec<Value>>>) {
        let hub = Arc::new(HookRegistry::default());
        hub.set_gate(Arc::new(|_, _, _, _| true));
        let delivered: Arc<StdMutex<Vec<Value>>> = Arc::default();
        { let sink = delivered.clone(); hub.set_deliver(Arc::new(move |owner, frame| { sink.lock().unwrap().push(json!({"owner": owner, "frame": frame})); Ok(()) })); }
        for member in case["members"].as_array().unwrap() {
            hub.register(member["owner"].as_str().unwrap(), "1.0.0", &[declaration(member, event)], event).unwrap();
            if member["down"] == true { hub.mark_down(member["owner"].as_str().unwrap()); }
        }
        let ids: Vec<String> = case["members"].as_array().unwrap().iter().map(|member| member["owner"].as_str().unwrap().to_owned()).collect();
        let file = OrderFile { schema: 1, order: strings(&case["order"]["user"]), first_enabled: strings(&case["order"]["firstEnabled"]) };
        hub.set_order(resolve(&file.order, &file.first_enabled, &ids));
        (hub, delivered)
    }
    /// The stand-in service: answers each member as scripted after `afterMs` of the paused clock; `removes` takes
    /// packages out (a disable or revoke while this member is asked); a down member's service is not running.
    fn stand_in(case: &Value, hub: Arc<HookRegistry>, asked: Arc<StdMutex<Vec<String>>>) -> Ask {
        let members = case["members"].clone();
        Arc::new(move |owner: &str, frame: Value| {
            let member = members.as_array().unwrap().iter().find(|member| member["owner"] == owner).unwrap().clone();
            if member["down"] == true { return Err("HostUnavailable"); }
            asked.lock().unwrap().push(owner.to_owned());
            for removed in strings(&member["answer"]["removes"]) { hub.remove_owner(&removed); }
            let (sender, receiver) = oneshot::channel();
            if strings(&member["answer"]["removes"]).iter().any(|removed| removed == owner) { drop(sender); return Ok(receiver); }
            let after = Duration::from_millis(member["answer"]["afterMs"].as_u64().unwrap_or(0));
            let answer = &member["answer"];
            let reply: std::result::Result<Value, String> = match answer["error"].as_str() {
                Some(code) => Err(code.to_owned()),
                None => {
                    // A rewriting member reads the input as the earlier members left it.
                    let input = frame["payload"]["input"]["command"].as_str().unwrap_or_default().to_owned();
                    match answer.get("rewrite").and_then(Value::as_object) {
                        Some(rule) => match input.strip_prefix(rule["from"].as_str().unwrap()) {
                            Some(rest) => Ok(json!({"decision": "rewrite", "input": {"command": format!("{}{rest}", rule["to"].as_str().unwrap())}})),
                            None => Ok(Value::Null),
                        },
                        None => Ok(answer["value"].clone()),
                    }
                }
            };
            if answer["never"] == true { std::mem::forget(sender); return Ok(receiver); }
            tokio::spawn(async move { tokio::time::sleep(after).await; let _ = sender.send(reply); });
            Ok(receiver)
        })
    }
    fn name_of(case: &Value, owner: &str) -> String {
        case["members"].as_array().unwrap().iter().find(|member| member["owner"] == owner).and_then(|member| member["name"].as_str()).unwrap_or(owner).to_owned()
    }
    fn grants_of(case: &Value, owner: &str) -> BTreeSet<String> {
        case["members"].as_array().unwrap().iter().find(|member| member["owner"] == owner).map(|member| strings(&member["grants"]).into_iter().collect()).unwrap_or_default()
    }

    /// Runs one case's chain the way both chain loops do (`drive` and `run_chain` ask through [`ask_member`]), on
    /// the paused clock, and answers what the case expects to compare.
    async fn run_case(case: &Value) -> Value {
        let event = case["event"].as_str().unwrap();
        let event: &'static str = if event == "tool.before" { "tool.before" } else { "prompt.submit" };
        let (hub, delivered) = chain_registry(case, event);
        let asked: Arc<StdMutex<Vec<String>>> = Arc::default();
        let ask = stand_in(case, hub.clone(), asked.clone());
        let occurrence = Occurrence { event, project: "A".into(), harness: "claude".into(), run: "task".into(), tool_kind: Some("shell".into()), paths: vec![], payload: case["payload"].clone() };
        let can: Vec<&str> = case["can"].as_array().map(|can| can.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
        let mut decisions = DecisionFold::new(&can);
        let mut prompt = PromptFold::new(case["payload"]["text"].as_str().unwrap_or_default());
        let started = Instant::now();
        let (mut removed, mut failures, mut notices) = (vec![], BTreeMap::new(), vec![]);
        let streaks = Streaks::default();
        for target in hub.attached(event) {
            let stopped = if event == "tool.before" { decisions.stopped() } else { prompt.stopped() };
            if stopped { break; }
            let payload = if event == "tool.before" { decisions.payload(&occurrence.payload) } else { prompt.payload(&occurrence.payload) };
            let frame = json!({"schemaVersion": 1, "hookId": target.declaration.id, "event": event, "observeOnly": false, "payload": payload});
            let late = Late { hook_id: target.declaration.id.clone(), event: event.into(), task: "t1".into(), call: None };
            let (answer, reached) = match ask_member_with(&hub, &ask, &target, &occurrence, frame, started, late, None).await {
                Asked::Removed => { removed.push(target.owner.clone()); continue; }
                Asked::Answered { answer, asked } => (answer, asked),
            };
            let step = Step { owner: target.owner.clone(), name: name_of(case, &target.owner), on_failure: target.declaration.on_failure.clone(), grants: grants_of(case, &target.owner), answer: answer.clone() };
            let codes: Vec<Option<String>> = if event == "tool.before" {
                let before = decisions.receipts.len(); decisions.step(&step); decisions.receipts[before..].iter().map(|receipt| receipt.code.clone()).collect()
            } else {
                let before = prompt.receipts.len(); prompt.step(&step); prompt.receipts[before..].iter().map(|receipt| receipt.code.clone()).collect()
            };
            let failure = failure_of(&answer, &codes);
            if let Some(code) = &failure { failures.insert(target.owner.clone(), code.clone()); }
            if reached && streaks.record(&target.owner, event, failure.as_deref()) { notices.push(target.owner.clone()); }
        }
        let elapsed = started.elapsed().as_millis() as u64;
        // Late answers still arrive on the paused clock.
        tokio::time::sleep(Duration::from_millis(CHAIN_MS)).await;
        let late: Vec<Value> = delivered.lock().unwrap().iter().filter(|entry| entry["frame"]["receipt"]["code"] == "Timeout").map(|entry| entry["owner"].clone()).collect();
        let asked_owners = asked.lock().unwrap().clone();
        let mut out = json!({"asked": asked_owners, "removed": removed, "failures": failures, "late": late, "notices": notices, "elapsedMs": elapsed});
        if event == "tool.before" {
            out["outcome"] = match decisions.outcome() {
                Outcome::None => json!({"kind": "none"}),
                Outcome::Approve { by, input } => json!({"kind": "approve", "by": by.owner, "failed": by.failed, "input": input}),
                Outcome::Deny(by) => json!({"kind": "deny", "by": by.owner, "failed": by.failed, "reason": by.reason}),
                Outcome::Ask(by) => json!({"kind": "ask", "by": by.owner, "failed": by.failed, "reason": by.reason}),
            };
            out["receipts"] = json!(decisions.settled().iter().map(|receipt| json!({"owner": receipt.owner, "applied": receipt.applied, "code": receipt.code, "overriddenBy": receipt.overridden_by})).collect::<Vec<_>>());
        } else {
            out["prompt"] = json!({"text": prompt.text, "blocked": prompt.blocked.as_ref().map(|blocked| json!({"by": blocked.by, "failed": blocked.failed, "message": blocked.message()}))});
        }
        out
    }

    #[tokio::test(start_paused = true)]
    async fn chains_resolve_by_the_order_and_apply_the_declared_policies() {
        let corpus: Value = serde_json::from_str(CHAINS).unwrap();
        for case in corpus["cases"].as_array().unwrap() {
            let label = case["id"].as_str().unwrap();
            let got = run_case(case).await;
            for (key, expected) in case["expect"].as_object().unwrap() {
                assert_eq!(got[key.as_str()], *expected, "{label}: {key}");
            }
            // A failure never approves.
            if !case["expect"]["failures"].as_object().is_none_or(|failures| failures.is_empty()) && got["outcome"]["kind"] == "approve" {
                assert_eq!(got["outcome"]["failed"], false, "{label}");
            }
        }
    }

    #[test]
    fn the_registry_asks_in_the_order_it_is_given_and_keeps_a_crashed_hook() {
        let hub = HookRegistry::default();
        hub.set_gate(Arc::new(|_, _, _, _| true));
        let declare = |owner: &str| vec![Declaration { id: format!("{owner}/before"), event: "tool.before".into(), on_failure: "deny".into(), budget_ms: 2_000, matcher: Match::default() }];
        for owner in ["sample.c", "sample.a", "sample.b"] { hub.register(owner, "1.0.0", &declare(owner), "tool.before").unwrap(); }
        let owners = |hub: &HookRegistry| hub.attached("tool.before").into_iter().map(|target| target.owner).collect::<Vec<_>>();
        assert_eq!(owners(&hub), ["sample.a", "sample.b", "sample.c"]);
        hub.set_order(vec!["sample.c".into(), "sample.a".into()]);
        assert_eq!(owners(&hub), ["sample.c", "sample.a", "sample.b"]);
        // A crash keeps the hook (down): it stays a member and its policy applies; a user removal takes it out.
        assert_eq!(hub.mark_down("sample.a"), 1);
        assert!(hub.down("sample.a"));
        assert_eq!(owners(&hub), ["sample.c", "sample.a", "sample.b"]);
        let occurrence = Occurrence { event: "tool.before", project: "A".into(), harness: "claude".into(), run: "task".into(), tool_kind: Some("shell".into()), paths: vec![], payload: json!({}) };
        let target = hub.attached("tool.before").into_iter().find(|target| target.owner == "sample.a").unwrap();
        assert!(admitted_with(&hub, &target, &occurrence, None));
        // Its service is gone at the user's request (disabled while parked): the down hook is removed, not failed.
        let gone: Presence = Arc::new(|owner: &str| owner != "sample.a");
        assert!(!admitted_with(&hub, &target, &occurrence, Some(&gone)));
        assert_eq!(owners(&hub), ["sample.c", "sample.b"]);
        // The restarted service registers again: the hook is live with one handler.
        hub.register("sample.c", "1.0.0", &declare("sample.c"), "tool.before").unwrap();
        hub.mark_down("sample.c");
        hub.register("sample.c", "1.0.0", &declare("sample.c"), "tool.before").unwrap();
        assert!(!hub.down("sample.c"));
        hub.unregister("sample.c", "tool.before").unwrap();
        assert_eq!(owners(&hub), ["sample.b"]);
        // A revoked receiving grant removes the member as well.
        let revoked = HookRegistry::default();
        revoked.set_gate(Arc::new(|_, _, _, _| false));
        assert!(!admitted_with(&revoked, &target, &occurrence, None));
    }

    #[test]
    fn the_two_fixture_packages_declare_their_policies() {
        for (manifest, policy, budget) in [(include_str!("../../../tests/fixtures/extensions/runtime-hook-resolution/alpha/extension.json"), "deny", 1_000), (include_str!("../../../tests/fixtures/extensions/runtime-hook-resolution/beta/extension.json"), "ask", 2_000)] {
            let declarations = hooks::check(&serde_json::from_str(manifest).unwrap()).unwrap();
            assert_eq!(declarations.len(), 1);
            assert_eq!((declarations[0].event.as_str(), declarations[0].on_failure.as_str(), declarations[0].budget_ms), ("tool.before", policy, budget));
        }
    }

    #[test]
    fn a_late_receipt_says_timeout_and_is_never_applied() {
        let receipt = late_receipt(&Late { hook_id: "sample.hook-a/before".into(), event: "tool.before".into(), task: "t1".into(), call: Some("c1".into()) });
        assert_eq!(receipt, json!({"schemaVersion": 1, "receipt": {"schemaVersion": 1, "hookId": "sample.hook-a/before", "event": "tool.before", "taskId": "t1", "applied": false, "code": "Timeout", "callId": "c1"}}));
    }
}
