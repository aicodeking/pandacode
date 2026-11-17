//! Speed tiers and warm spares of declared package harnesses (runtime phase R8, slice R0807).
//!
//! **Speed tiers.** A provider's models publish `speedTiers` (S0606). The model picker persists the user's choice in the
//! task's saved settings (`serviceTier`, `task_controls::set_task_preference`, which validates it here against the
//! provider's own catalog). A send resolves the selection once (`selection`): the tier survives only when the selected
//! model still lists it, so a model switch can never carry a stale tier. The declared ACP launch receives the model,
//! the effort and the tier in `session/new` `_meta.pandacode` together with the package id (`meta`), and every launch
//! and every tier decision is recorded as an attributed event (`record_launch`, `events`): the extension's name, the
//! provider, the task, never a value of a secret.
//!
//! **Warm spares.** The default is demand only: a package process starts when a task sends, never earlier (the zero-start
//! baseline of S0606 and R0806 stays true for every package that did nothing else). A package takes part only when ALL
//! of these hold, checked again at every start and every adoption:
//!
//! 1. its provider declares `launch.warmSpare: true` (the declaration);
//! 2. the user opted the package in (`extensions_provider_speed_optin`, file backed, default off), bound to the package's
//!    executable digest: an update, a new trust review or an opt-out revokes it;
//! 3. the package is enabled, trusted, not in safe mode and its provider is ready (`dynamic_harness::warm_context`);
//! 4. "Start agents ahead" (the user's own global setting) is on.
//!
//! A spare is one initialized ACP process (the same state as `providers/handshake_warm.rs`: stopped after `initialize`, no
//! conversation state), so a model, effort or tier switch keeps it (they are delivered by `session/new`); a changed folder,
//! command or executable digest discards it. One spare per task, at most `LIMIT` in total, each at most `IDLE` old.
//! A send adopts it (`take`) and replays its `initialize` reply; the spare's process, counters and `State` are the
//! package's one `runtime_provider_launch::State`, never a second one. Disable, uninstall, trust loss, rollback, safe
//! mode, opt-out, switching the task to another harness and turning "Start agents ahead" off end the package's spares.
//!
//! **Locks (audit note for the final phase).** This module owns one `std::sync::Mutex` (`STORE`). It is only ever held for
//! map operations: never across an `.await`, a process spawn, a file write, a wait or a call into another lock. Processes
//! are removed from the map under the lock and dropped or ended after it is released. It touches NO lock of
//! `providers/warm.rs`, `warm_state.rs`, `warm_switch.rs` or `handshake_warm.rs` (upstream's warm-spare code, the prime
//! suspect of the upstream #382 deadlock): the only hooks into that area are the pure reads `participates`/`present`
//! (this module's lock only) and the sinks `discard_session`/`discard_all`, called from `providers.rs` next to the upstream
//! discards, never from inside one of them.
use crate::extensions::runtime_provider_launch as launch;
use crate::providers::{ModelInfo, RunConfig};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, VecDeque},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

/// A spare older than this is never adopted (the upstream spare's own bound).
pub const IDLE: Duration = Duration::from_secs(10 * 60);
/// A spare that has not answered `initialize` by then is dropped.
pub const INITIALIZE: Duration = Duration::from_secs(20);
/// Idle spares across every package: each one is an idle executable the user did not ask for yet.
pub const LIMIT: usize = 2;
const RECORDER: usize = 128;
const FILE_MAX: u64 = 64 * 1024;
const MAX_OPT_INS: usize = 64;

/// An initialized process a send adopts (`take`).
pub(crate) struct Adopted { pub started: launch::Started, pub reply: Value }

struct Spare { owner: String, key: String, born: Instant, generation: u64, adopted: Adopted }
enum Slot {
    /// A start is in flight for this key; only a start still holding this generation may store its process.
    Starting { generation: u64, owner: String, key: String },
    Ready(Spare),
}
impl Slot {
    fn owner(&self) -> &str { match self { Slot::Starting { owner, .. } => owner, Slot::Ready(spare) => &spare.owner } }
    fn key(&self) -> &str { match self { Slot::Starting { key, .. } => key, Slot::Ready(spare) => &spare.key } }
}

#[derive(Default)]
struct Store {
    directory: Option<PathBuf>,
    /// Owner -> the executable digest the user opted in for.
    opt_in: BTreeMap<String, String>,
    corrupt: bool,
    slots: BTreeMap<String, Slot>,
    next: u64,
    seq: u64,
    recorder: VecDeque<Value>,
}
fn store() -> &'static Mutex<Store> {
    static STORE: OnceLock<Mutex<Store>> = OnceLock::new();
    STORE.get_or_init(Default::default)
}
/// Runs `change` under the lock. The closure must be short, must not wait and must not call another lock.
fn with<T>(change: impl FnOnce(&mut Store) -> T) -> T { change(&mut store().lock().unwrap_or_else(|poisoned| poisoned.into_inner())) }

fn note_in(store: &mut Store, owner: &str, what: &str, mut detail: Value) {
    store.seq += 1;
    if store.recorder.len() >= RECORDER { store.recorder.pop_front(); }
    detail["seq"] = json!(store.seq);
    detail["extension"] = json!(owner);
    detail["what"] = json!(what);
    store.recorder.push_back(detail);
}
fn note(owner: &str, what: &str, detail: Value) { with(|store| note_in(store, owner, what, detail)); }
fn clip(text: &str) -> String { text.chars().filter(|c| !c.is_control()).take(300).collect() }

// ---- the user's opt-in (file backed, independent of SQLite, default off) ----

fn file(directory: &Path) -> PathBuf { directory.join("extension-provider-speed-v1").join("opt-in.json") }

/// Loads `<dir>/extension-provider-speed-v1/opt-in.json`. A missing file is an empty store; an unreadable or malformed
/// one is kept as it is, opts nobody in and refuses a new opt-in. Nothing starts from loading it.
pub fn configure(directory: Option<&Path>) {
    let Some(directory) = directory else { return };
    let path = file(directory);
    let (opt_in, corrupt) = match std::fs::metadata(&path) {
        Err(_) => (BTreeMap::new(), false),
        Ok(meta) if meta.len() > FILE_MAX => (BTreeMap::new(), true),
        Ok(_) => match std::fs::read(&path).ok().and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok()).and_then(parse_file) {
            Some(opt_in) => (opt_in, false),
            None => (BTreeMap::new(), true),
        },
    };
    with(|store| { store.directory = Some(directory.to_path_buf()); store.opt_in = opt_in; store.corrupt = corrupt; });
}
fn parse_file(value: Value) -> Option<BTreeMap<String, String>> {
    if value["schemaVersion"] != 1 { return None; }
    let object = value["optIn"].as_object()?;
    if object.len() > MAX_OPT_INS { return None; }
    object.iter().map(|(owner, digest)| Some((owner.clone(), digest.as_str().filter(|digest| !digest.is_empty() && digest.len() <= 128)?.to_owned()))).collect()
}
fn write_file(directory: &Path, opt_in: &BTreeMap<String, String>) -> Result<(), String> {
    let path = file(directory);
    let parent = path.parent().ok_or("StorageUnavailable")?;
    std::fs::create_dir_all(parent).map_err(|_| "StorageUnavailable")?;
    let stage = path.with_extension("stage");
    std::fs::write(&stage, serde_json::to_vec(&json!({"schemaVersion": 1, "optIn": opt_in})).map_err(|_| "MalformedData")?).map_err(|_| "StorageUnavailable")?;
    std::fs::rename(&stage, &path).map_err(|_| "StorageUnavailable".to_owned())
}

/// Opts a package in (`Some(digest)`, the installed executable digest) or out (`None`). The file is written after the lock
/// is released; a failed write puts the previous value back and reports `StorageUnavailable`.
fn set_opt_in(owner: &str, digest: Option<&str>) -> Result<bool, String> {
    let (changed, previous, directory, snapshot) = with(|store| {
        if store.corrupt && digest.is_some() { return Err("MalformedData".to_owned()); }
        if digest.is_some() && !store.opt_in.contains_key(owner) && store.opt_in.len() >= MAX_OPT_INS { return Err("LimitExceeded".to_owned()); }
        let previous = store.opt_in.get(owner).cloned();
        match digest { Some(digest) => { store.opt_in.insert(owner.to_owned(), digest.to_owned()); } None => { store.opt_in.remove(owner); } }
        let changed = previous.as_deref() != digest;
        if changed { note_in(store, owner, if digest.is_some() { "optIn" } else { "optOut" }, json!({})); }
        Ok((changed, previous, store.directory.clone(), store.opt_in.clone()))
    })?;
    if !changed { return Ok(false); }
    if let Some(directory) = directory {
        if let Err(error) = write_file(&directory, &snapshot) {
            with(|store| match previous { Some(previous) => { store.opt_in.insert(owner.to_owned(), previous); } None => { store.opt_in.remove(owner); } });
            return Err(error);
        }
    }
    Ok(true)
}
fn opted_in_digest(owner: &str) -> Option<String> { with(|store| store.opt_in.get(owner).cloned()) }

/// The package of `provider` has an opt-in record. A cheap read of this module's own state (no package list, no file), so
/// the picker's reply never waits on anything; every real condition is checked again by `prewarm`.
pub fn participates(provider: &str) -> bool {
    crate::extensions::providers::extension_owner(provider).is_some_and(|owner| with(|store| store.opt_in.contains_key(owner)))
}
/// The task has a spare ready or starting.
pub fn present(session_id: &str) -> bool { with(|store| store.slots.contains_key(session_id)) }

// ---- the selected tier ----

/// What a launch carries from the task's picks.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Selection { pub model: String, pub effort: Option<String>, pub tier: Option<String>, pub dropped_tier: Option<String> }

/// Resolves the task's model, effort and speed tier against the provider's own catalog. The saved tier is kept only
/// when the selected model lists it (a model switch drops a stale one and says so in the attributed record).
pub(crate) fn selection(config: &RunConfig, models: &[ModelInfo]) -> Selection {
    let model = models.iter().find(|model| model.id == config.model);
    let saved = config.codex_settings.as_ref().and_then(|settings| settings["serviceTier"].as_str()).map(str::to_owned);
    let (tier, dropped_tier) = match saved {
        Some(saved) if model.is_some_and(|model| model.speed_tiers.iter().any(|tier| tier.id == saved)) => (Some(saved), None),
        Some(saved) => (None, Some(saved)),
        None => (None, None),
    };
    Selection { model: config.model.clone(), effort: config.reasoning_effort.clone(), tier, dropped_tier }
}
/// The `_meta.pandacode` object of `session/new`: the pick and who it is for. No credential, no path.
pub(crate) fn meta(owner: &str, selection: &Selection) -> Value {
    json!({"extension": owner, "model": selection.model, "effort": selection.effort, "speedTier": selection.tier})
}
/// Records the launch of a send (cold or from an adopted spare) as an attributed event.
pub(crate) fn record_launch(owner: &str, provider: &str, session: &str, selection: &Selection, warm: bool) {
    with(|store| {
        if let Some(dropped) = &selection.dropped_tier { note_in(store, owner, "tierDropped", json!({"provider": provider, "session": session, "model": selection.model, "speedTier": clip(dropped)})); }
        note_in(store, owner, "launch", json!({"provider": provider, "session": session, "model": selection.model, "effort": selection.effort, "speedTier": selection.tier, "warm": warm}));
    });
}
/// The tier the picker may persist for `model` of `provider`: `None` is the standard speed; any other id must be listed
/// by that model of that provider's catalog.
pub(crate) fn validated_tier(provider: &str, model: &str, tier: Option<String>) -> Result<Option<String>, String> {
    let Some(tier) = tier else { return Ok(None) };
    let models = crate::providers::dynamic_adapter::models(provider)?;
    let listed = models.iter().find(|entry| entry.id == model).is_some_and(|entry| entry.speed_tiers.iter().any(|entry| entry.id == tier));
    if listed { Ok(Some(tier)) } else { Err("Choose a valid speed.".into()) }
}
/// Records the user's tier pick of a task as an attributed event (it takes effect with the next send).
pub(crate) fn record_pick(provider: &str, session: &str, model: &str, tier: Option<&str>) {
    if let Some(owner) = crate::extensions::providers::extension_owner(provider) {
        note(owner, "tierSelected", json!({"provider": provider, "session": session, "model": model, "speedTier": tier}));
    }
}

// ---- spares ----

/// The key a spare is adopted by: everything that shapes the process (command, environment, folder, executable
/// digest). Models, efforts and tiers are not in it: they are delivered by `session/new`.
pub(crate) fn key(provider: &str, digest: &str, resolved: &launch::Resolved, cwd: &Path) -> String {
    json!({"provider": provider, "digest": digest, "program": resolved.program.to_string_lossy(), "arguments": resolved.arguments, "env": resolved.env, "cwd": cwd.to_string_lossy()}).to_string()
}

enum Claim { Exists, Start { generation: u64, replaced: Vec<Slot>, evicted: Vec<Slot> } }

/// Starts (or keeps) the task's spare for the launch its next send would use. Idempotent: the same key is a no-op, so the
/// picker, a model switch and every keystroke may call it freely. Returns `Ok` without starting anything unless every
/// condition of the module doc holds.
pub(crate) async fn prewarm(config: RunConfig) -> Result<(), String> {
    let provider = config.provider.clone();
    let Some(owner) = crate::extensions::providers::extension_owner(&provider).map(str::to_owned) else { return Ok(()) };
    if !participates(&provider) { return Ok(()); }
    let (session, cwd) = (config.session_id.clone(), config.cwd.clone());
    let probe = {
        let (provider, cwd) = (provider.clone(), cwd.clone());
        crate::blocking(move || crate::providers::dynamic_adapter::warm_context(&provider, &cwd)).await
    };
    let context = match probe {
        Ok(context) => context,
        Err(reason) => {
            // Disabled, untrusted, not ready or not declaring warmSpare: nothing starts, and a spare left over goes.
            discard_session(&session, "ineligible");
            note(&owner, "spareSkipped", json!({"provider": provider, "session": session, "reason": clip(&reason)}));
            return Ok(());
        }
    };
    match opted_in_digest(&owner) {
        Some(digest) if digest == context.digest => {}
        Some(_) => {
            // The package changed since the user opted in: the opt-in does not carry over to new executable content.
            let _ = set_opt_in(&owner, None);
            discard_owner_for(Some(&owner), "optInRevoked");
            return Ok(());
        }
        None => return Ok(()),
    }
    let claim = with(|store| {
        if store.slots.get(&session).is_some_and(|slot| slot.key() == context.key && slot.owner() == owner) { return Claim::Exists; }
        let replaced: Vec<Slot> = store.slots.remove(&session).into_iter().collect();
        store.next += 1;
        let generation = store.next;
        store.slots.insert(session.clone(), Slot::Starting { generation, owner: owner.clone(), key: context.key.clone() });
        let mut evicted = Vec::new();
        while store.slots.len() > LIMIT {
            let oldest = store.slots.iter().filter(|(id, _)| **id != session).filter_map(|(id, slot)| match slot { Slot::Ready(spare) => Some((spare.born, id.clone())), Slot::Starting { .. } => None }).min().map(|(_, id)| id);
            let Some(id) = oldest else { break };
            if let Some(slot) = store.slots.remove(&id) { evicted.push(slot); }
        }
        Claim::Start { generation, replaced, evicted }
    });
    let Claim::Start { generation, replaced, evicted } = claim else { return Ok(()) };
    for slot in replaced.iter().chain(evicted.iter()) { discarded(slot.owner(), "replaced"); }
    drop((replaced, evicted));
    match launch::start_initialized(&owner, &context.resolved, &cwd, INITIALIZE).await {
        Err(error) => {
            with(|store| { if matches!(store.slots.get(&session), Some(Slot::Starting { generation: current, .. }) if *current == generation) { store.slots.remove(&session); } });
            launch::update(&owner, |state| state.warm_failed += 1);
            note(&owner, "spareFailed", json!({"provider": provider, "session": session, "reason": clip(&error)}));
            Err(error)
        }
        Ok((started, reply)) => {
            let spare = Spare { owner: owner.clone(), key: context.key.clone(), born: Instant::now(), generation, adopted: Adopted { started, reply } };
            let rejected = with(|store| {
                let wanted = matches!(store.slots.get(&session), Some(Slot::Starting { generation: current, .. }) if *current == generation);
                if wanted { store.slots.insert(session.clone(), Slot::Ready(spare)); None }
                // A send, a switch or a disable came first: this process was never wanted any more.
                else { Some(spare) }
            });
            match rejected {
                Some(spare) => {
                    spare.adopted.started.end().await;
                    discarded(&owner, "late");
                }
                None => {
                    launch::update(&owner, |state| state.warm_started += 1);
                    note(&owner, "spareStarted", json!({"provider": provider, "session": session}));
                    tokio::spawn(async move { tokio::time::sleep(IDLE).await; expire(&session, generation); });
                }
            }
            Ok(())
        }
    }
}

fn expire(session: &str, generation: u64) {
    let victim = with(|store| {
        let current = matches!(store.slots.get(session), Some(Slot::Ready(spare)) if spare.generation == generation);
        if current { store.slots.remove(session) } else { None }
    });
    if let Some(slot) = victim { discarded(slot.owner(), "expired"); }
}

/// Counts and records a discarded spare (always called with no lock held). Dropping the slot kills a still-running
/// process (`kill_on_drop`).
fn discarded(owner: &str, reason: &str) {
    launch::update(owner, |state| state.warm_discarded += 1);
    note(owner, "spareDiscarded", json!({"reason": reason}));
}

/// A send's own launch adopts the task's spare when it is for exactly this launch and still alive; any other spare of
/// the task is discarded, and a send never waits for one that is still starting (it starts cold, and the late process is
/// discarded when it arrives). Called by `dynamic_harness::run`, once per send.
pub(crate) fn take(session: &str, owner: &str, key: &str) -> Option<Adopted> {
    let slot = with(|store| store.slots.remove(session))?;
    match slot {
        Slot::Starting { owner: starting, .. } => {
            note(&starting, "spareNotReady", json!({"session": session}));
            None
        }
        Slot::Ready(mut spare) => {
            let reason = if spare.owner != owner { Some("foreignOwner") }
                else if spare.key != key { Some("launchChanged") }
                else if spare.born.elapsed() >= IDLE { Some("expired") }
                else if !spare.adopted.started.alive() { Some("exited") }
                else { None };
            match reason {
                Some(reason) => { discarded(&spare.owner, reason); None }
                None => {
                    launch::update(owner, |state| state.warm_adopted += 1);
                    note(owner, "spareAdopted", json!({"session": session}));
                    Some(spare.adopted)
                }
            }
        }
    }
}

/// Ends the spares of one package (`Some`) or of every package (`None`): disable, uninstall, trust loss, rollback and safe
/// mode (`dynamic_harness::stop`).
pub(crate) fn discard_owner(owner: Option<&str>) { discard_owner_for(owner, "packageStopped"); }
fn discard_owner_for(owner: Option<&str>, reason: &str) {
    let victims: Vec<Slot> = with(|store| {
        let ids: Vec<String> = store.slots.iter().filter(|(_, slot)| owner.is_none_or(|owner| slot.owner() == owner)).map(|(id, _)| id.clone()).collect();
        ids.into_iter().filter_map(|id| store.slots.remove(&id)).collect()
    });
    for slot in &victims { discarded(slot.owner(), reason); }
}
/// Ends a task's spare (the task switched harness, model folder or was deleted).
pub fn discard_session(session: &str, reason: &str) {
    let victim = with(|store| store.slots.remove(session));
    if let Some(slot) = victim { discarded(slot.owner(), reason); }
}
/// Ends every spare ("Start agents ahead" turned off).
pub fn discard_all() { discard_owner_for(None, "startAheadOff"); }

// ---- what the interface reads and does ----

/// The secret-free projection: per declaring package its opt-in and the one state's counters, plus the attributed events.
fn projection(packages: &[Value]) -> Value {
    let rows: Vec<Value> = packages.iter().filter_map(|package| {
        let id = package["manifest"]["id"].as_str()?;
        let providers: Vec<&str> = package["manifest"]["contributes"]["providers"].as_array()?.iter().filter(|provider| provider["launch"]["warmSpare"] == true).filter_map(|provider| provider["id"].as_str()).collect();
        if providers.is_empty() { return None; }
        let digest = package["executable"]["digest"].as_str().unwrap_or_default();
        let (opted, spares) = with(|store| (store.opt_in.get(id).is_some_and(|saved| saved == digest), store.slots.values().filter(|slot| slot.owner() == id).count()));
        let state = launch::current(id);
        Some(json!({"id": id, "providers": providers, "enabled": package["enabled"] == true, "trusted": package["executable"]["trusted"] == true, "optedIn": opted, "spares": spares,
            "counters": {"spawns": state.spawns, "warmStarted": state.warm_started, "warmAdopted": state.warm_adopted, "warmDiscarded": state.warm_discarded, "warmFailed": state.warm_failed, "handshakes": state.handshakes, "tokens": state.tokens_issued}}))
    }).collect();
    let (events, available) = with(|store| (store.recorder.iter().cloned().collect::<Vec<_>>(), !store.corrupt));
    json!({"schemaVersion": 1, "available": available, "limit": LIMIT, "idleSeconds": IDLE.as_secs(), "packages": rows, "events": events})
}

/// The interface reads the opt-ins, counters and events (main window only).
#[tauri::command]
pub fn extensions_provider_speed(window: tauri::WebviewWindow, app: tauri::AppHandle) -> Result<Value, String> {
    if crate::headless::active() || window.label() != "main" { return Err("PermissionDenied".into()); }
    let snapshot = launch::package_snapshot(&app)?;
    Ok(projection(snapshot["packages"].as_array().map(Vec::as_slice).unwrap_or_default()))
}

/// The user's opt-in or opt-out of a package's warm spares (main window only; nothing a package can call). Opting in needs
/// an enabled, trusted package that declares `launch.warmSpare`; opting out is always possible and ends its spares.
#[tauri::command]
pub fn extensions_provider_speed_optin(window: tauri::WebviewWindow, app: tauri::AppHandle, id: String, enabled: bool) -> Result<Value, String> {
    if crate::headless::active() || window.label() != "main" { return Err("PermissionDenied".into()); }
    let snapshot = launch::package_snapshot(&app)?;
    let packages = snapshot["packages"].as_array().map(Vec::as_slice).unwrap_or_default();
    if enabled {
        if snapshot["safeMode"] == true { return Err("PermissionDenied".into()); }
        let package = packages.iter().find(|package| package["manifest"]["id"] == id.as_str() && package["enabled"] == true).ok_or("NotFound")?;
        let declares = package["manifest"]["contributes"]["providers"].as_array().is_some_and(|providers| providers.iter().any(|provider| provider["launch"]["warmSpare"] == true));
        if !declares { return Err("UnsupportedCapability: this extension declares no warm-spare harness.".into()); }
        if package["executable"]["trusted"] != true { return Err(launch::TRUST_REQUIRED.into()); }
        let digest = package["executable"]["digest"].as_str().filter(|digest| !digest.is_empty()).ok_or("NotFound")?;
        set_opt_in(&id, Some(digest))?;
    } else if set_opt_in(&id, None)? {
        discard_owner_for(Some(&id), "optOut");
    }
    Ok(projection(packages))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::ReasoningEffortInfo;

    fn model(id: &str, tiers: &[&str]) -> ModelInfo {
        ModelInfo { id: id.into(), name: id.into(), description: String::new(), reasoning_efforts: vec![], default_reasoning_effort: None, context_window: None,
            speed_tiers: tiers.iter().map(|tier| ReasoningEffortInfo { id: (*tier).into(), name: (*tier).into(), description: String::new() }).collect() }
    }
    fn config(model: &str, tier: Option<&str>) -> RunConfig {
        RunConfig { session_id: "speed-unit".into(), provider: "sample.speed-agent/fake".into(), model: model.into(), reasoning_effort: Some("high".into()), mode: "ask".into(), cwd: std::env::temp_dir(),
            resume_id: None, prompt: String::new(), instructions: String::new(), skill: None, goal: None, codex_settings: tier.map(|tier| json!({"serviceTier": tier})), images: vec![] }
    }
    struct Dir(PathBuf);
    impl Dir { fn new() -> Self { let path = std::env::temp_dir().join(format!("pandacode-speed-test-{}", uuid::Uuid::new_v4())); std::fs::create_dir(&path).unwrap(); Self(path) } }
    impl Drop for Dir { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }

    #[test]
    fn the_selected_tier_survives_only_when_the_selected_model_lists_it() {
        let models = [model("large", &["fast", "ultrafast"]), model("small", &[])];
        assert_eq!(selection(&config("large", Some("fast")), &models), Selection { model: "large".into(), effort: Some("high".into()), tier: Some("fast".into()), dropped_tier: None });
        let switched = selection(&config("small", Some("fast")), &models);
        assert_eq!((switched.tier.as_deref(), switched.dropped_tier.as_deref()), (None, Some("fast")), "a model switch drops a stale tier");
        assert_eq!(selection(&config("large", None), &models).tier, None);
        assert_eq!(selection(&config("gone", Some("fast")), &models).tier, None, "an unknown model carries no tier");
        let sent = meta("sample.speed-agent", &selection(&config("large", Some("ultrafast")), &models));
        assert_eq!(sent, json!({"extension": "sample.speed-agent", "model": "large", "effort": "high", "speedTier": "ultrafast"}));
    }

    #[test]
    fn the_spare_key_follows_the_process_and_ignores_model_effort_and_tier() {
        let resolved = launch::Resolved { program: PathBuf::from("agent"), arguments: vec!["x".into()], env: BTreeMap::from([("A".to_owned(), "1".to_owned())]) };
        let base = key("p/a", "digest-1", &resolved, Path::new("work"));
        assert_eq!(base, key("p/a", "digest-1", &resolved, Path::new("work")));
        assert_ne!(base, key("p/a", "digest-2", &resolved, Path::new("work")), "an updated executable never adopts the old spare");
        assert_ne!(base, key("p/a", "digest-1", &resolved, Path::new("other")), "another folder starts another process");
        let mut changed = resolved.clone();
        changed.env.insert("A".into(), "2".into());
        assert_ne!(base, key("p/a", "digest-1", &changed, Path::new("work")));
        assert!(!base.contains("model") && !base.contains("tier"));
    }

    #[test]
    fn the_opt_in_is_file_backed_default_off_digest_bound_and_revocable() {
        let dir = Dir::new();
        let owner = "sample.speed-optin";
        configure(Some(&dir.0));
        assert!(!participates("sample.speed-optin/fake"), "default off");
        assert!(set_opt_in(owner, Some("digest-1")).unwrap());
        assert!(!set_opt_in(owner, Some("digest-1")).unwrap(), "a repeat changes nothing");
        assert!(participates("sample.speed-optin/fake"));
        assert!(!participates("sample.other/fake"), "another package is not opted in");
        // A restart reads the file back.
        with(|store| store.opt_in.clear());
        configure(Some(&dir.0));
        assert_eq!(opted_in_digest(owner).as_deref(), Some("digest-1"));
        assert!(set_opt_in(owner, None).unwrap());
        configure(Some(&dir.0));
        assert!(!participates("sample.speed-optin/fake"), "opt-out is persisted");
        // A malformed file opts nobody in and refuses a new opt-in.
        std::fs::write(file(&dir.0), b"{not json").unwrap();
        configure(Some(&dir.0));
        assert!(!participates("sample.speed-optin/fake"));
        assert_eq!(set_opt_in(owner, Some("digest-1")).unwrap_err(), "MalformedData");
        assert_eq!(std::fs::read(file(&dir.0)).unwrap(), b"{not json", "the file is kept as it is");
        with(|store| { store.directory = None; store.opt_in.clear(); store.corrupt = false; });
    }

    #[test]
    fn events_are_attributed_bounded_and_carry_no_secret_shaped_field() {
        let owner = "sample.speed-events";
        let models = [model("large", &["fast"])];
        for index in 0..(RECORDER + 10) {
            record_launch(owner, "sample.speed-events/fake", &format!("task-{index}"), &selection(&config("large", Some("fast")), &models), index % 2 == 0);
        }
        let events = with(|store| store.recorder.iter().cloned().collect::<Vec<_>>());
        assert!(events.len() <= RECORDER);
        let last = events.last().unwrap();
        assert_eq!((last["extension"].as_str(), last["what"].as_str(), last["speedTier"].as_str()), (Some(owner), Some("launch"), Some("fast")));
        assert!(events.iter().all(|event| event["extension"].is_string() && event["seq"].is_u64()));
        let text = serde_json::to_string(&events).unwrap();
        assert!(!text.contains("token") && !text.contains("secret") && !text.contains("credential"));
        with(|store| store.recorder.clear());
    }

    #[test]
    fn the_projection_lists_only_declaring_packages_and_never_the_key_or_the_digest() {
        let owner = "sample.speed-projection";
        with(|store| { store.opt_in.insert(owner.into(), "digest-9".into()); });
        let package = |declares: bool, digest: &str| json!({"enabled": true, "executable": {"trusted": true, "digest": digest}, "manifest": {"id": owner, "contributes": {"providers": [{"id": "sample.speed-projection/fake", "launch": {"warmSpare": declares}}]}}});
        let shown = projection(&[package(true, "digest-9")]);
        assert_eq!(shown["packages"][0]["optedIn"], true);
        assert_eq!(shown["packages"][0]["id"], owner);
        assert_eq!(projection(&[package(true, "digest-10")])["packages"][0]["optedIn"], false, "a changed digest is not opted in");
        assert!(projection(&[package(false, "digest-9")])["packages"].as_array().unwrap().is_empty());
        let text = shown.to_string();
        assert!(!text.contains("digest-9") && !text.contains("\"key\""));
        with(|store| { store.opt_in.remove(owner); });
    }

    /// A really installed package (archive, trust, enable) launches the canonical Node fake agent (the adopted B5 state
    /// machine): demand-only default, opt-in, spawn counters, model and tier switch, failure and restart, opt-out,
    /// revoke and cleanup.
    #[cfg(all(feature = "extension-runtime-native-tests", target_os = "windows", target_arch = "x86_64"))]
    mod installed {
        use super::super::*;
        use crate::{extensions::packages::ExtensionPackages, providers};
        use std::{io::Write, os::windows::process::CommandExt, sync::Arc};

        const MANIFEST: &str = include_str!("../../../tests/fixtures/extensions/runtime-provider-speed/extension.json");
        const AGENT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/fixtures/extensions/backends/fake-agent.mjs");
        const ID: &str = "sample.speed-agent";
        const PROVIDER: &str = "sample.speed-agent/fake";

        struct Dir(PathBuf);
        impl Dir { fn new() -> Self { let path = std::env::temp_dir().join(format!("pandacode-speed-installed-{}", uuid::Uuid::new_v4())); std::fs::create_dir(&path).unwrap(); Self(path) } }
        impl Drop for Dir { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }

        fn archive(manifest: &str) -> Vec<u8> {
            let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
            writer.start_file("extension.json", zip::write::SimpleFileOptions::default()).unwrap();
            writer.write_all(manifest.as_bytes()).unwrap();
            writer.finish().unwrap().into_inner()
        }
        fn digest(packages: &ExtensionPackages) -> String {
            launch::support::digest(packages)
        }
        fn config(dir: &Path, session: &str, model: &str, tier: Option<&str>, prompt: &str) -> providers::RunConfig {
            providers::RunConfig { session_id: session.into(), provider: PROVIDER.into(), model: model.into(), reasoning_effort: None, mode: "ask".into(), cwd: dir.to_path_buf(), resume_id: None, prompt: prompt.into(),
                instructions: String::new(), skill: None, goal: None, codex_settings: tier.map(|tier| json!({"serviceTier": tier})), images: vec![] }
        }
        async fn send(config: providers::RunConfig) -> (Result<(), String>, Vec<providers::AgentEvent>) {
            let (_input, rx) = tokio::sync::mpsc::unbounded_channel();
            let (events, mut output) = tokio::sync::mpsc::unbounded_channel();
            let result = tokio::time::timeout(Duration::from_secs(60), providers::run(config, Arc::new(move |event| { let _ = events.send(event); }), rx)).await.expect("the run finishes");
            let mut seen = Vec::new();
            while let Ok(event) = output.try_recv() { seen.push(event); }
            (result, seen)
        }
        fn frames(packages: &ExtensionPackages) -> Vec<Value> {
            let data = packages.0.lock().unwrap().launch_data_directory(ID).unwrap();
            std::fs::read_to_string(data.join("frames.log")).unwrap_or_default().lines().filter_map(|line| serde_json::from_str::<Value>(line).ok()).collect()
        }
        fn count(frames: &[Value], method: &str) -> usize { frames.iter().filter(|frame| frame["method"] == method).count() }
        fn launches(session: &str) -> Vec<Value> { with(|store| store.recorder.iter().filter(|event| event["what"] == "launch" && event["session"] == session).cloned().collect()) }

        #[tokio::test]
        async fn tiers_reach_the_launch_and_an_opted_in_package_prewarms_with_counters_failure_restart_and_cleanup() {
            let dir = Dir::new();
            let packages = ExtensionPackages::new(&dir.0, false);
            providers::dynamic_adapter::configure(&packages.0, Some(Path::new(env!("CARGO_MANIFEST_DIR")).join("../_work/00-tmp/extensibility-trusted-runtime")));
            configure(Some(&dir.0));
            launch::forget(ID);
            let mut manifest: Value = serde_json::from_str(MANIFEST).unwrap();
            manifest["contributes"]["providers"][0]["launch"]["command"][1] = json!(AGENT);
            launch::support::install(&packages, &archive(&manifest.to_string()));
            // Installed but not trusted: opting in is not possible and prewarm starts nothing.
            assert!(set_opt_in(ID, Some("digest")).is_ok(), "the store itself only records; the interface command checks trust");
            set_opt_in(ID, None).unwrap();
            launch::support::trust_and_enable(&packages, ID);
            let found = providers::dynamic_adapter::discover().into_iter().find(|provider| provider.id == PROVIDER).unwrap();
            assert_eq!(found.models[0].speed_tiers.iter().map(|tier| tier.id.as_str()).collect::<Vec<_>>(), ["fast", "ultrafast"], "the declared harness publishes its tiers");
            assert!(found.models[1].speed_tiers.is_empty());
            assert!(validated_tier(PROVIDER, "fixture-large", Some("fast".into())).is_ok());
            assert!(validated_tier(PROVIDER, "fixture-small", Some("fast".into())).is_err(), "a model without the tier refuses it");
            assert!(validated_tier(PROVIDER, "fixture-large", Some("warp".into())).is_err());
            // Demand-only default: a declaration alone, picks and keystrokes start nothing.
            assert!(!participates(PROVIDER));
            prewarm(config(&dir.0, "speed-default", "fixture-large", None, "")).await.unwrap();
            assert_eq!(launch::current(ID).spawns, 0, "no process before the first send");
            // The first send starts one process, carries the selected tier, and is attributed.
            let first = send(config(&dir.0, "speed-default", "fixture-large", Some("fast"), "#reply cold")).await;
            assert!(first.0.is_ok(), "{first:?}");
            assert_eq!((launch::current(ID).spawns, launch::current(ID).warm_started), (1, 0));
            let log = frames(&packages);
            let session_new = log.iter().find(|frame| frame["method"] == "session/new").expect("session/new reached the fake agent");
            assert_eq!(session_new["params"]["_meta"]["pandacode"], json!({"extension": ID, "model": "fixture-large", "effort": null, "speedTier": "fast"}));
            let recorded = launches("speed-default");
            assert_eq!((recorded[0]["speedTier"].as_str(), recorded[0]["warm"].as_bool(), recorded[0]["extension"].as_str()), (Some("fast"), Some(false), Some(ID)));
            // A stale tier after a model switch is dropped at launch, and the drop is recorded.
            assert!(send(config(&dir.0, "speed-default", "fixture-small", Some("fast"), "#reply small")).await.0.is_ok());
            assert!(with(|store| store.recorder.iter().any(|event| event["what"] == "tierDropped" && event["session"] == "speed-default")));
            // Opt in: still nothing runs, and a revoked-looking digest never starts one.
            set_opt_in(ID, Some("not-the-installed-digest")).unwrap();
            prewarm(config(&dir.0, "speed-warm", "fixture-large", None, "")).await.unwrap();
            assert_eq!(launch::current(ID).warm_started, 0, "an opt-in bound to another digest is revoked, not honored");
            assert!(!participates(PROVIDER));
            set_opt_in(ID, Some(&digest(&packages))).unwrap();
            let before = launch::current(ID);
            assert_eq!(before.warm_started, 0, "opting in alone starts nothing");
            // Prewarm starts one process; repeats, a model switch and a tier switch keep it.
            prewarm(config(&dir.0, "speed-warm", "fixture-large", None, "")).await.unwrap();
            prewarm(config(&dir.0, "speed-warm", "fixture-large", None, "")).await.unwrap();
            prewarm(config(&dir.0, "speed-warm", "fixture-small", Some("fast"), "")).await.unwrap();
            let after = launch::current(ID);
            assert_eq!((after.warm_started, after.spawns), (1, before.spawns + 1), "one spare for the task across repeats and switches");
            assert_eq!(after.handshakes, before.handshakes, "the spare's initialize is counted when a send adopts it");
            assert!(present("speed-warm"));
            // The send adopts it: no new process, the handshake is replayed once, the tier arrives.
            let adopted = send(config(&dir.0, "speed-warm", "fixture-large", Some("ultrafast"), "#reply warm")).await;
            assert!(adopted.0.is_ok() && adopted.1.iter().any(|event| event.kind == "text" && event.text == "warm"), "{adopted:?}");
            let state = launch::current(ID);
            assert_eq!((state.spawns, state.warm_adopted, state.handshakes), (after.spawns, 1, before.handshakes + 1), "{state:?}");
            assert!(!present("speed-warm"));
            assert_eq!(launches("speed-warm")[0]["warm"], true);
            let log = frames(&packages);
            assert_eq!(count(&log, "initialize"), count(&log, "session/prompt"), "every conversation's initialize reached the agent exactly once");
            // Failure and restart: a spare whose process died is not adopted, the send starts cold, the next prewarm restarts it.
            prewarm(config(&dir.0, "speed-fail", "fixture-large", None, "")).await.unwrap();
            let pid = with(|store| match store.slots.get("speed-fail") { Some(Slot::Ready(spare)) => spare.adopted.started.pid(), _ => None }).expect("the spare runs");
            let ended = std::process::Command::new("taskkill").args(["/PID", &pid.to_string(), "/F"]).creation_flags(0x08000000).status().unwrap();
            assert!(ended.success());
            for _ in 0..50 {
                if !with(|store| match store.slots.get_mut("speed-fail") { Some(Slot::Ready(spare)) => spare.adopted.started.alive(), _ => false }) { break; }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            let before_failure = launch::current(ID);
            let restarted_cold = send(config(&dir.0, "speed-fail", "fixture-large", None, "#reply cold again")).await;
            assert!(restarted_cold.0.is_ok(), "a dead spare never fails the send: {restarted_cold:?}");
            let after_failure = launch::current(ID);
            assert_eq!((after_failure.warm_adopted, after_failure.warm_discarded, after_failure.spawns), (before_failure.warm_adopted, before_failure.warm_discarded + 1, before_failure.spawns + 1));
            prewarm(config(&dir.0, "speed-fail", "fixture-large", None, "")).await.unwrap();
            assert!(present("speed-fail"), "the next prewarm starts the spare again");
            // Another folder is another launch: the spare is discarded and the send starts cold.
            let other = Dir::new();
            let cold = send(config(&other.0, "speed-fail", "fixture-large", None, "#reply moved")).await;
            assert!(cold.0.is_ok(), "{cold:?}");
            assert!(!present("speed-fail"));
            // Opt-out and disable end the spares and start nothing.
            prewarm(config(&dir.0, "speed-out", "fixture-large", None, "")).await.unwrap();
            assert!(present("speed-out"));
            set_opt_in(ID, None).unwrap();
            discard_owner_for(Some(ID), "optOut");
            assert!(!present("speed-out") && !participates(PROVIDER));
            let counted = launch::current(ID).warm_started;
            prewarm(config(&dir.0, "speed-out", "fixture-large", None, "")).await.unwrap();
            assert_eq!(launch::current(ID).warm_started, counted, "an opted-out package never prewarms");
            set_opt_in(ID, Some(&digest(&packages))).unwrap();
            prewarm(config(&dir.0, "speed-disabled", "fixture-large", None, "")).await.unwrap();
            assert!(present("speed-disabled"));
            launch::support::disable(&packages, ID);
            providers::dynamic_adapter::stop(Some(ID));
            assert!(!present("speed-disabled"), "disable ends the spare");
            let counted = launch::current(ID).warm_started;
            prewarm(config(&dir.0, "speed-disabled", "fixture-large", None, "")).await.unwrap();
            assert_eq!(launch::current(ID).warm_started, counted, "a disabled package never starts");
            // Cleanup: nothing left running, one state, no secret in the record.
            let state = launch::current(ID);
            assert_eq!(state.active, 0);
            assert!(with(|store| store.slots.is_empty()));
            let text = serde_json::to_string(&with(|store| store.recorder.iter().cloned().collect::<Vec<_>>())).unwrap();
            assert!(!text.contains("secret") && !text.contains("credential"));
            set_opt_in(ID, None).unwrap();
            launch::forget(ID);
        }
    }
}
