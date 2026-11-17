//! Moodboards and already configured cloud machines (`workspace.manage`, runtime phase R4, slice R0406C).
//!
//! A trusted service manages the content of a project's moodboards with `panda.workspace.moodboards.create | rename | remove |
//! addImage | removeImage` and provisions and controls cloud machines with `panda.workspace.cloud.provision | sync | retry |
//! open | stop | remove`. Every method is a thin, characterized adapter over the seam the original controls already use
//! (the table `SEAMS`), so a package and the user's own click reach the same native code and the same limits:
//!
//! | Method | Native seam |
//! |---|---|
//! | `moodboards.create` | `create_moodboard` |
//! | `moodboards.rename` | `rename_moodboard` |
//! | `moodboards.remove` | `delete_moodboard` (irreversible) |
//! | `moodboards.addImage` | `add_moodboard_image` |
//! | `moodboards.removeImage` | `remove_moodboard_image` |
//! | `cloud.provision` | `cloud_create` (a provider the user already connected) |
//! | `cloud.sync`, `retry`, `open` | `cloud_agent_action` of the task that owns the machine |
//! | `cloud.stop` | `cloud_agent_action` (the owning task) or `cloud_power` |
//! | `cloud.remove` | `cloud_agent_action` `delete` or `cloud_power` `delete` (irreversible) |
//!
//! The permission `workspace.manage` is project scoped, granted with the trust decision, rechecked natively on every call
//! and once more right before the effect (and after a confirmation), so a revoke, a narrowing, a disable or a stopped
//! service in between changes nothing. A package that holds it is never asked per action (ADR-0005); the only host
//! confirmation is the default one of the two irreversible removals (`moodboards.remove`, `cloud.machines.remove`), which
//! the user can turn off per package (`runtime_family_consents`), and a declined one answers `Cancelled` and removes
//! nothing. A moodboard call is gated on the board's project (an unknown board is `NotFound` only to a package that holds
//! the grant, so a refusal never says whether a board exists). A machine that a cloud task owns is gated on that task's
//! project; a machine no task owns, and `provision`, are not about a project and need the grant for every project.
//!
//! What stays with the user, and is not a method: connecting a provider (its key), pairing a machine, granting remote
//! access, and approving access. `provision` uses only a provider the user already connected (a provider that is not
//! answers `UnsupportedCapability`), and no call takes or returns a credential: the fields `credentials`, `token`,
//! `apiKey`, `path` and `prompt` are unknown fields and answer `InvalidShape` (ADR-0006). Native error text never reaches a
//! package: it is mapped to a frozen code (`code_of`).
//!
//! Every call is recorded with the package that made it (`Activity`): who, which method, which board or machine and the
//! outcome, never a value. Rules for predictability and fault isolation, never for trust: four confirmations waiting per
//! package, a two minute bound on the user's answer, 120 character names and a 17 MiB image data URL.
//!
//! The state is pure (parsers, code mapping, the waiting rounds and the activity log) so the rules are deterministic to
//! test; the app half (`serve` and the two commands) only adds the grants file, the store, the machines and the window.
use serde_json::{json, Map, Value};
use std::{collections::{BTreeMap, VecDeque}, sync::Mutex, time::Duration};
use tokio::sync::oneshot;

use super::runtime_tasks_start::{failure, Refusal};

/// The named permission for every call (project scoped).
pub const PERMISSION: &str = "workspace.manage";
pub const MOODBOARD_OPS: [&str; 5] = ["create", "rename", "remove", "addImage", "removeImage"];
pub const CLOUD_OPS: [&str; 6] = ["provision", "sync", "retry", "open", "stop", "remove"];
/// Frozen method to the native seam it adapts (a test checks every frozen method is here).
pub const SEAMS: [(&str, &str); 11] = [
    ("workspace.moodboards.create", "create_moodboard"), ("workspace.moodboards.rename", "rename_moodboard"), ("workspace.moodboards.remove", "delete_moodboard"),
    ("workspace.moodboards.addImage", "add_moodboard_image"), ("workspace.moodboards.removeImage", "remove_moodboard_image"),
    ("workspace.cloud.provision", "cloud_create"), ("workspace.cloud.sync", "cloud_agent_action"), ("workspace.cloud.retry", "cloud_agent_action"),
    ("workspace.cloud.open", "cloud_agent_action"), ("workspace.cloud.stop", "cloud_agent_action|cloud_power"), ("workspace.cloud.remove", "cloud_agent_action|cloud_power"),
];
/// Names of the two irreversible actions, as the family consents know them.
pub const REMOVE_BOARD: &str = "moodboards.remove";
pub const REMOVE_MACHINE: &str = "cloud.machines.remove";
pub const MAX_NAME_CHARS: usize = 120;
pub const MAX_IMAGE_NAME_CHARS: usize = 255;
pub const MAX_DATA_URL_BYTES: usize = 17 * 1024 * 1024;
pub const MAX_WAITING: usize = 4;
pub const CONFIRM_WAIT: Duration = Duration::from_secs(120);
pub const ACTIVITY_MAX: usize = 200;

fn ident(text: &str) -> bool { !text.is_empty() && text.chars().count() <= 128 && !text.chars().any(char::is_control) }
fn denied() -> Refusal { Refusal { code: "PermissionDenied".into(), path: PERMISSION.into(), ids: vec![] } }

// ---- Requests --------------------------------------------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Mood {
    Create { project_id: String, name: String },
    Rename { board_id: String, name: String },
    Remove { board_id: String },
    AddImage { board_id: String, name: String, data_url: String },
    RemoveImage { board_id: String, image_id: String },
}
impl Mood {
    pub fn op(&self) -> &'static str {
        match self { Mood::Create { .. } => "create", Mood::Rename { .. } => "rename", Mood::Remove { .. } => "remove", Mood::AddImage { .. } => "addImage", Mood::RemoveImage { .. } => "removeImage" }
    }
    pub fn board_id(&self) -> Option<&str> {
        match self { Mood::Create { .. } => None, Mood::Rename { board_id, .. } | Mood::Remove { board_id } | Mood::AddImage { board_id, .. } | Mood::RemoveImage { board_id, .. } => Some(board_id) }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Cloud {
    Provision { provider: String, name: String },
    Sync { machine_id: String },
    Retry { machine_id: String },
    Open { machine_id: String },
    Stop { machine_id: String },
    Remove { machine_id: String },
}
impl Cloud {
    pub fn op(&self) -> &'static str {
        match self { Cloud::Provision { .. } => "provision", Cloud::Sync { .. } => "sync", Cloud::Retry { .. } => "retry", Cloud::Open { .. } => "open", Cloud::Stop { .. } => "stop", Cloud::Remove { .. } => "remove" }
    }
    pub fn machine_id(&self) -> Option<&str> {
        match self { Cloud::Provision { .. } => None, Cloud::Sync { machine_id } | Cloud::Retry { machine_id } | Cloud::Open { machine_id } | Cloud::Stop { machine_id } | Cloud::Remove { machine_id } => Some(machine_id) }
    }
}

fn required_id(map: &Map<String, Value>, key: &str) -> Result<String, Refusal> {
    match map.get(key) { Some(Value::String(text)) if ident(text) => Ok(text.clone()), _ => Err("InvalidShape".into()) }
}
/// A trimmed, printable name of 1 to `max` characters. Too long is `LimitExceeded`; empty or with a control character `InvalidShape`.
fn label(map: &Map<String, Value>, key: &str, max: usize) -> Result<String, Refusal> {
    let text = map.get(key).and_then(Value::as_str).ok_or("InvalidShape")?.trim();
    if text.is_empty() || text.chars().any(char::is_control) { return Err("InvalidShape".into()); }
    if text.chars().count() > max { return Err("LimitExceeded".into()); }
    Ok(text.to_owned())
}
/// The object under `key` with only `allowed` fields: any other field (a path, a token, a credential, a prompt) is `InvalidShape`.
fn input<'a>(map: &'a Map<String, Value>, allowed: &[&str]) -> Result<&'a Map<String, Value>, Refusal> {
    let object = map.get("input").and_then(Value::as_object).ok_or("InvalidShape")?;
    if object.keys().any(|key| !allowed.contains(&key.as_str())) { return Err("InvalidShape".into()); }
    Ok(object)
}
fn only(map: &Map<String, Value>, allowed: &[&str]) -> Result<(), Refusal> {
    if map.keys().any(|key| !allowed.contains(&key.as_str())) { Err("InvalidShape".into()) } else { Ok(()) }
}

/// Reads a moodboard call: `{op, input?, boardId?, imageId?, name?}`. Nothing is looked up here.
pub fn read_moodboard(params: &Value) -> Result<Mood, Refusal> {
    let map = params.as_object().ok_or("InvalidShape")?;
    let op = map.get("op").and_then(Value::as_str).filter(|op| MOODBOARD_OPS.contains(op)).ok_or("InvalidShape")?;
    match op {
        "create" => {
            only(map, &["op", "input"])?;
            let object = input(map, &["projectId", "name"])?;
            Ok(Mood::Create { project_id: required_id(object, "projectId")?, name: label(object, "name", MAX_NAME_CHARS)? })
        }
        "rename" => { only(map, &["op", "boardId", "name"])?; Ok(Mood::Rename { board_id: required_id(map, "boardId")?, name: label(map, "name", MAX_NAME_CHARS)? }) }
        "remove" => { only(map, &["op", "boardId"])?; Ok(Mood::Remove { board_id: required_id(map, "boardId")? }) }
        "addImage" => {
            only(map, &["op", "boardId", "input"])?;
            let board_id = required_id(map, "boardId")?;
            let object = input(map, &["name", "dataUrl"])?;
            let name = label(object, "name", MAX_IMAGE_NAME_CHARS)?;
            let data_url = object.get("dataUrl").and_then(Value::as_str).ok_or("InvalidShape")?;
            if !data_url.starts_with("data:image/") { return Err("InvalidShape".into()); }
            if data_url.len() > MAX_DATA_URL_BYTES { return Err("LimitExceeded".into()); }
            Ok(Mood::AddImage { board_id, name, data_url: data_url.to_owned() })
        }
        _ => { only(map, &["op", "boardId", "imageId"])?; Ok(Mood::RemoveImage { board_id: required_id(map, "boardId")?, image_id: required_id(map, "imageId")? }) }
    }
}

/// A machine id is `<provider>:<native id>` of a known provider (the one native parse the controls use).
fn machine_id(map: &Map<String, Value>) -> Result<String, Refusal> {
    let id = required_id(map, "machineId")?;
    if crate::cloud::split(&id).is_none() { return Err("InvalidShape".into()); }
    Ok(id)
}
/// A provider id as the native create takes it: lowercase letters, digits and dashes.
fn provider_id(map: &Map<String, Value>) -> Result<String, Refusal> {
    let text = map.get("provider").and_then(Value::as_str).ok_or("InvalidShape")?;
    if text.is_empty() || text.len() > 32 || !text.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-') { return Err("InvalidShape".into()); }
    Ok(text.to_owned())
}
/// A machine name: letters, digits, dot, dash and underscore (it goes into provider URLs and commands).
fn machine_name(map: &Map<String, Value>) -> Result<String, Refusal> {
    let text = map.get("name").and_then(Value::as_str).ok_or("InvalidShape")?;
    if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_')) || text.starts_with('.') { return Err("InvalidShape".into()); }
    if text.len() > 63 { return Err("LimitExceeded".into()); }
    Ok(text.to_owned())
}

/// Reads a cloud call: `{op, input?, machineId?}`.
pub fn read_cloud(params: &Value) -> Result<Cloud, Refusal> {
    let map = params.as_object().ok_or("InvalidShape")?;
    let op = map.get("op").and_then(Value::as_str).filter(|op| CLOUD_OPS.contains(op)).ok_or("InvalidShape")?;
    if op == "provision" {
        only(map, &["op", "input"])?;
        let object = input(map, &["provider", "name"])?;
        return Ok(Cloud::Provision { provider: provider_id(object)?, name: machine_name(object)? });
    }
    only(map, &["op", "machineId"])?;
    let machine_id = machine_id(map)?;
    Ok(match op { "sync" => Cloud::Sync { machine_id }, "retry" => Cloud::Retry { machine_id }, "open" => Cloud::Open { machine_id }, "stop" => Cloud::Stop { machine_id }, _ => Cloud::Remove { machine_id } })
}

/// The frozen code for the text a native seam failed with. Nothing of the text reaches a package.
pub fn code_of(text: &str) -> &'static str {
    let text = text.to_lowercase();
    let has = |needles: &[&str]| needles.iter().any(|needle| text.contains(needle));
    if has(&["wait for the agent", "stop it first"]) { "Busy" }
    else if has(&["24 moodboards", "up to eight", "between one and eight", "too large", "at most", "limit", "under 2,000"]) { "LimitExceeded" }
    else if has(&["connect", "set up", "sign in", "not configured", "no credentials", "api key", "token", "cli is not installed"]) { "UnsupportedCapability" }
    else if has(&["between 1 and", "use a name", "not an image", "unsupported image", "could not decode", "invalid", "unknown cloud action"]) { "InvalidShape" }
    else if has(&["unavailable", "not found", "no such", "unknown cloud machine", "no longer", "does not run on a cloud", "no cloud machine", "lost its local checkout"]) { "NotFound" }
    else if has(&["already"]) { "Conflict" }
    else { "HostUnavailable" }
}
fn native(error: impl std::fmt::Display) -> Refusal { Refusal::new(code_of(&error.to_string())) }

// ---- Confirmations waiting for the window ----------------------------------------------------------------------------------

struct Waiting { owner: String, sender: Option<oneshot::Sender<Value>> }
#[derive(Default)]
struct Slots { waiting: BTreeMap<String, Waiting>, serial: u64 }

/// The host confirmations that wait for the main window's answer, and the activity log of every call.
#[derive(Default)]
pub struct WorkspaceCloud { slots: Mutex<Slots>, activity: Mutex<VecDeque<Value>> }
impl WorkspaceCloud {
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Slots>, &'static str> { self.slots.lock().map_err(|_| "HostUnavailable") }
    /// A confirmation waits: its id and the receiver the answer arrives on. A fifth one of the package is `LimitExceeded`.
    pub fn begin(&self, owner: &str) -> Result<(String, oneshot::Receiver<Value>), &'static str> {
        let mut slots = self.lock()?;
        if slots.waiting.values().filter(|waiting| waiting.owner == owner).count() >= MAX_WAITING { return Err("LimitExceeded"); }
        slots.serial += 1;
        let id = format!("{owner}#workspace-{}", slots.serial);
        let (sender, receiver) = oneshot::channel();
        slots.waiting.insert(id.clone(), Waiting { owner: owner.to_owned(), sender: Some(sender) });
        Ok((id, receiver))
    }
    /// The window answers confirmation `id`. An answer for one that is gone (answered, timed out, ended) is `NotFound`.
    pub fn answer(&self, id: &str, answer: &Value) -> Result<(), &'static str> {
        let mut slots = self.lock()?;
        let mut waiting = slots.waiting.remove(id).ok_or("NotFound")?;
        if let Some(sender) = waiting.sender.take() { let _ = sender.send(answer.clone()); }
        Ok(())
    }
    /// The package's service ended: its waiting confirmations resolve as revoked and remove nothing.
    pub fn cancel_owner(&self, owner: &str) -> usize {
        let Ok(mut slots) = self.slots.lock() else { return 0 };
        let ids: Vec<String> = slots.waiting.iter().filter(|(_, waiting)| waiting.owner == owner).map(|(id, _)| id.clone()).collect();
        for id in &ids { if let Some(mut waiting) = slots.waiting.remove(id) { if let Some(sender) = waiting.sender.take() { let _ = sender.send(json!({"ok": false, "code": "Revoked"})); } } }
        ids.len()
    }
    pub fn forget(&self, id: &str) -> bool { self.slots.lock().is_ok_and(|mut slots| slots.waiting.remove(id).is_some()) }
    pub fn count(&self, owner: &str) -> usize { self.slots.lock().map_or(0, |slots| slots.waiting.values().filter(|waiting| waiting.owner == owner).count()) }

    /// Records one call: who, which method, which board or machine and the outcome (`ok` or a code), never a value.
    pub fn record(&self, owner: &str, method: &str, subject: &str, outcome: &str) {
        let Ok(mut log) = self.activity.lock() else { return };
        let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_millis() as u64);
        log.push_back(json!({"at": at, "owner": owner, "method": method, "subject": subject, "outcome": outcome}));
        while log.len() > ACTIVITY_MAX { log.pop_front(); }
    }
    /// The recorded calls, oldest first, optionally of one package.
    pub fn activity(&self, owner: Option<&str>) -> Vec<Value> {
        self.activity.lock().map(|log| log.iter().filter(|entry| owner.is_none_or(|owner| entry["owner"] == owner)).cloned().collect()).unwrap_or_default()
    }
}

// ---- The app ---------------------------------------------------------------------------------------------------------------

pub fn state(app: &tauri::AppHandle) -> Option<tauri::State<'_, WorkspaceCloud>> { use tauri::Manager; app.try_state::<WorkspaceCloud>() }

/// The enabled version of the package, or why it may not call.
fn version_of(app: &tauri::AppHandle, owner: &str) -> Result<String, &'static str> {
    use tauri::Manager;
    let packages = app.state::<super::packages::ExtensionPackages>();
    let packages = packages.0.try_lock().map_err(|_| "Timeout")?;
    super::runtime_service_lifetime::runtime_usage_resources::enabled_version(&packages, owner).ok_or("PermissionDenied")
}
/// The display name of the package, for the confirmation ("Name wants to remove ...").
fn name_of(app: &tauri::AppHandle, owner: &str) -> String {
    use tauri::Manager;
    let Some(packages) = app.try_state::<super::packages::ExtensionPackages>() else { return owner.to_owned() };
    let Ok(packages) = packages.0.try_lock() else { return owner.to_owned() };
    packages.snapshot().packages.iter().find(|package| package.manifest["id"] == owner).and_then(|package| package.manifest["name"].as_str().map(str::to_owned)).unwrap_or_else(|| owner.to_owned())
}
/// The package holds `workspace.manage` for some project now (the grants file, narrowing included).
fn holds(app: &tauri::AppHandle, owner: &str, version: &str) -> bool {
    use tauri::Manager;
    app.try_state::<super::runtime_grants::RuntimeGrants>().is_some_and(|grants| grants.projection()["packages"].as_array().into_iter().flatten().any(|package| {
        package["id"] == owner && package["version"] == version && package["authorized"] == true && package["grants"].as_array().into_iter().flatten().any(|grant| grant["permission"] == PERMISSION)
    }))
}
fn target_of(project: Option<&str>) -> super::runtime_grants::Target { project.map_or_else(super::runtime_grants::Target::default, super::runtime_grants::Target::project) }
fn granted(app: &tauri::AppHandle, owner: &str, version: &str, project: Option<&str>) -> bool {
    use tauri::Manager;
    app.try_state::<super::runtime_grants::RuntimeGrants>().is_some_and(|grants| grants.check(owner, version, PERMISSION, &target_of(project)).is_ok())
}

/// The project a moodboard belongs to.
fn board_project(app: &tauri::AppHandle, board: &str) -> Option<String> {
    use tauri::Manager;
    let state = app.try_state::<crate::AppState>()?;
    let store = state.store.try_lock().ok()?;
    store.db.query_row("SELECT project_id FROM moodboards WHERE id=?1", [board], |row| row.get::<_, String>(0)).ok()
}
/// The cloud task that owns a machine: its id and its project.
fn owning_task(app: &tauri::AppHandle, machine: &str) -> Option<(String, String)> {
    use tauri::Manager;
    let state = app.try_state::<crate::AppState>()?;
    let store = state.store.try_lock().ok()?;
    let mut statement = store.db.prepare("SELECT id,project_id,cloud FROM sessions WHERE cloud IS NOT NULL").ok()?;
    let rows = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))).ok()?;
    let found = rows.filter_map(std::result::Result::ok).find(|(_, _, cloud)| serde_json::from_str::<Value>(cloud).is_ok_and(|state| state["machine"] == machine)).map(|(id, project, _)| (id, project));
    found
}

/// Removes the waiting confirmation when its request is dropped (the service ended while it waited).
struct Guard { app: tauri::AppHandle, id: String }
impl Drop for Guard { fn drop(&mut self) { if let Some(slots) = state(&self.app) { slots.forget(&self.id); } } }

/// The host confirmation of an irreversible removal: shown by the main window with the package's name, answered by the user.
async fn confirm(app: &tauri::AppHandle, owner: &str, action: &str, what: &str) -> Result<bool, Refusal> {
    use tauri::Emitter;
    let Some(slots) = state(app) else { return Err("UnsupportedCapability".into()) };
    if crate::headless::active() { return Err("UnsupportedCapability".into()); }
    let (id, receiver) = slots.begin(owner).map_err(Refusal::new)?;
    let _guard = Guard { app: app.clone(), id: id.clone() };
    let _ = app.emit("extensions-runtime-workspace-cloud", json!({"id": id, "owner": owner, "name": name_of(app, owner), "phase": "confirm", "action": action, "what": what}));
    let answer = match tokio::time::timeout(CONFIRM_WAIT, receiver).await { Ok(Ok(answer)) => answer, Ok(Err(_)) => return Err("Revoked".into()), Err(_) => return Err("Timeout".into()) };
    if answer["code"] == "Revoked" { return Err("Revoked".into()); }
    Ok(answer["accepted"] == true)
}

/// Serves `workspaceMoodboards` and `workspaceCloud` of the service of `request.owner`.
pub async fn serve(app: tauri::AppHandle, request: super::runtime_service_lifetime::DispatchRequest) -> Value {
    let owner = request.owner.clone();
    let version = { let app = app.clone(); let owner = owner.clone(); tauri::async_runtime::spawn_blocking(move || version_of(&app, &owner)).await.unwrap_or(Err("HostUnavailable")) };
    let version = match version { Ok(version) => version, Err("PermissionDenied") => return denied().envelope(), Err(code) => return failure(code) };
    let (result, subject) = run(&app, &owner, &version, &request.method, &request.params).await;
    let outcome = match &result { Ok(_) => "ok".to_owned(), Err(refusal) => refusal.code.clone() };
    if let Some(log) = state(&app) { log.record(&owner, &request.method, &subject, &outcome); }
    match result { Ok(value) => json!({"ok": true, "value": value}), Err(refusal) => refusal.envelope() }
}

enum Call { Mood(Mood), Cloud(Cloud) }

/// The call, and the board or machine it is about (for the activity log).
async fn run(app: &tauri::AppHandle, owner: &str, version: &str, method: &str, params: &Value) -> (Result<Value, Refusal>, String) {
    let mut subject = String::new();
    let result = run_inner(app, owner, version, method, params, &mut subject).await;
    (result, subject)
}

async fn run_inner(app: &tauri::AppHandle, owner: &str, version: &str, method: &str, params: &Value, subject: &mut String) -> Result<Value, Refusal> {
    use tauri::Manager;
    if !holds(app, owner, version) { return Err(denied()); }
    let call = match method { "workspaceMoodboards" => Call::Mood(read_moodboard(params)?), "workspaceCloud" => Call::Cloud(read_cloud(params)?), _ => return Err("UnsupportedCapability".into()) };
    // Which project the call is about, and the cloud task that owns the machine (if any).
    let (project, session): (Option<String>, Option<String>) = match &call {
        Call::Mood(Mood::Create { project_id, .. }) => { *subject = project_id.clone(); (Some(project_id.clone()), None) }
        Call::Mood(mood) => {
            let board = mood.board_id().unwrap_or_default().to_owned();
            *subject = board.clone();
            let found = { let app = app.clone(); tauri::async_runtime::spawn_blocking(move || board_project(&app, &board)).await.unwrap_or(None) };
            // The package holds the grant for some project (checked above), so it may be told a board does not exist; a board
            // of a project outside its grant is `PermissionDenied`, decided by the project below.
            match found { Some(project) => (Some(project), None), None => return Err("NotFound".into()) }
        }
        Call::Cloud(Cloud::Provision { .. }) => { *subject = "provision".into(); (None, None) }
        Call::Cloud(cloud) => {
            let machine = cloud.machine_id().unwrap_or_default().to_owned();
            *subject = machine.clone();
            let found = { let app = app.clone(); tauri::async_runtime::spawn_blocking(move || owning_task(&app, &machine)).await.unwrap_or(None) };
            match found { Some((session, project)) => (Some(project), Some(session)), None => (None, None) }
        }
    };
    let check = |project: Option<&str>| granted(app, owner, version, project);
    if !check(project.as_deref()) { return Err(denied()); }
    let grants = app.try_state::<super::runtime_grants::RuntimeGrants>().ok_or("HostUnavailable")?;
    let work = grants.begin(owner, version, PERMISSION, &target_of(project.as_deref())).map_err(|_| denied())?;
    let still = || version_of(app, owner).is_ok() && check(project.as_deref()) && !work.is_cancelled();
    // The two irreversible removals keep the host confirmation unless the user turned it off for this package.
    let removal = match &call { Call::Mood(Mood::Remove { .. }) => Some((REMOVE_BOARD, format!("Delete moodboard {subject} and its images"))), Call::Cloud(Cloud::Remove { .. }) => Some((REMOVE_MACHINE, format!("Delete cloud machine {subject}"))), _ => None };
    if let Some((action, what)) = removal {
        let consents = app.try_state::<super::runtime_family_consents::FamilyConsents>().ok_or("HostUnavailable")?;
        match consents.delete(&grants, owner, action, project.as_deref(), &what).map_err(|error| if error == "PermissionDenied" { denied() } else { Refusal::new("HostUnavailable") })? {
            super::runtime_family_consents::Delete::Proceed => {}
            super::runtime_family_consents::Delete::Confirm { ticket, what } => {
                let accepted = confirm(app, owner, action, &what).await?;
                // The authority is checked again because it may have been revoked while the dialog was open.
                consents.answer(&grants, &ticket, accepted).map_err(|error| match error.as_str() { "Cancelled" => Refusal::new("Cancelled"), "PermissionDenied" => denied(), _ => Refusal::new("HostUnavailable") })?;
            }
        }
    }
    // The permission is read again just before anything changes: a revoke, a narrowing or a disable in between changes nothing.
    if !still() { return Err(denied()); }
    match call { Call::Mood(mood) => exec_mood(app, mood, project.as_deref().unwrap_or_default()).await, Call::Cloud(cloud) => exec_cloud(app, cloud, session).await }
}

async fn exec_mood(app: &tauri::AppHandle, mood: Mood, project: &str) -> Result<Value, Refusal> {
    use tauri::{Emitter, Manager};
    let state = app.state::<crate::AppState>();
    let project = project.to_owned();
    let event_project = project.clone();
    let (board, value) = match mood {
        Mood::Create { project_id, name } => { let created = crate::moodboards::create_moodboard(state, project_id, name).await.map_err(native)?; (created.id.clone(), serde_json::to_value(created).map_err(|_| Refusal::new("HostUnavailable"))?) }
        Mood::Rename { board_id, name } => { let renamed = crate::moodboards::rename_moodboard(state, project, board_id.clone(), name).await.map_err(native)?; (board_id, serde_json::to_value(renamed).map_err(|_| Refusal::new("HostUnavailable"))?) }
        Mood::Remove { board_id } => { crate::moodboards::delete_moodboard(state, project, board_id.clone()).await.map_err(native)?; (board_id, Value::Null) }
        Mood::AddImage { board_id, name, data_url } => { let detail = crate::moodboards::add_moodboard_image(state, project, board_id.clone(), name, data_url).await.map_err(native)?; (board_id, serde_json::to_value(detail).map_err(|_| Refusal::new("HostUnavailable"))?) }
        Mood::RemoveImage { board_id, image_id } => { crate::moodboards::remove_moodboard_image(state, project, board_id.clone(), image_id).await.map_err(native)?; (board_id, Value::Null) }
    };
    // The open moodboard panel reloads on this event, as it does for the user's own change.
    let _ = app.emit("moodboards-changed", json!({"projectId": event_project, "boardId": board}));
    Ok(value)
}

async fn exec_cloud(app: &tauri::AppHandle, cloud: Cloud, session: Option<String>) -> Result<Value, Refusal> {
    use tauri::Emitter;
    let action = |name: &'static str, session: String| { let app = app.clone(); async move { crate::cloud_agents::tasks::cloud_agent_action(app, session, name.to_owned()).await } };
    let op = cloud.op();
    match cloud {
        Cloud::Provision { provider, name } => {
            let machine = crate::cloud::commands::cloud_create(app.clone(), provider, name).await.map_err(native)?;
            serde_json::to_value(machine).map_err(|_| Refusal::new("HostUnavailable"))
        }
        // The cloud strip's own actions run on the task that owns the machine; a machine no task owns has none of them.
        Cloud::Sync { .. } | Cloud::Retry { .. } => {
            let session = session.ok_or("NotFound")?;
            action(if op == "sync" { "sync" } else { "retry" }, session).await.map_err(native)?;
            Ok(Value::Null)
        }
        Cloud::Open { machine_id } => {
            if let Some(session) = session { action("open", session).await.map_err(native)?; }
            crate::vm::commands::vm_show(app.clone(), Some(machine_id)).await.map_err(native)?;
            let _ = app.emit("vm-changed", json!({"show": true}));
            Ok(Value::Null)
        }
        Cloud::Stop { machine_id } | Cloud::Remove { machine_id } => {
            let name = if op == "stop" { "stop" } else { "delete" };
            match session { Some(session) => { action(name, session).await.map_err(native)?; } None => { crate::cloud::commands::cloud_power(app.clone(), machine_id, name.to_owned()).await.map_err(native)?; } }
            Ok(Value::Null)
        }
    }
}

/// The service of `owner` stopped (disable, revoke, uninstall, safe mode, crash, quit): its waiting confirmations remove nothing.
pub fn service_stopped(app: &tauri::AppHandle, owner: &str) {
    use tauri::Emitter;
    if let Some(slots) = state(app) { slots.cancel_owner(owner); }
    let _ = app.emit("extensions-runtime-workspace-cloud-end", json!({"owner": owner}));
}

/// The main window answers a confirmation: `{accepted: bool}`.
#[tauri::command]
pub fn extensions_runtime_workspace_cloud_answer(window: tauri::WebviewWindow, app: tauri::AppHandle, id: String, answer: Value) -> Result<(), String> {
    if crate::headless::active() || window.label() != "main" { return Err("PermissionDenied".into()); }
    let Some(slots) = state(&app) else { return Err("UnsupportedCapability".into()) };
    slots.answer(&id, &answer).map_err(str::to_owned)
}

/// What packages did to moodboards and machines (`owner` narrows to one package); no values, no credentials.
#[tauri::command]
pub fn extensions_runtime_workspace_cloud_activity(app: tauri::AppHandle, owner: Option<String>) -> Vec<Value> {
    state(&app).map_or_else(Vec::new, |log| log.activity(owner.as_deref()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn code(result: Result<impl std::fmt::Debug, Refusal>) -> String { result.unwrap_err().code }

    #[test]
    fn every_frozen_method_has_a_native_seam_and_a_parser() {
        let frozen = ["moodboards.create", "moodboards.rename", "moodboards.remove", "moodboards.addImage", "moodboards.removeImage", "cloud.provision", "cloud.sync", "cloud.retry", "cloud.open", "cloud.stop", "cloud.remove"];
        for method in frozen { assert!(SEAMS.iter().any(|(name, seam)| *name == format!("workspace.{method}") && !seam.is_empty()), "{method}"); }
        assert_eq!(SEAMS.len(), frozen.len());
        assert_eq!(MOODBOARD_OPS.len() + CLOUD_OPS.len(), frozen.len());
    }

    #[test]
    fn moodboard_calls_read_with_their_exact_fields() {
        assert_eq!(read_moodboard(&json!({"op": "create", "input": {"projectId": "p1", "name": " Ideas "}})).unwrap(), Mood::Create { project_id: "p1".into(), name: "Ideas".into() });
        assert_eq!(read_moodboard(&json!({"op": "rename", "boardId": "b1", "name": "New"})).unwrap(), Mood::Rename { board_id: "b1".into(), name: "New".into() });
        assert_eq!(read_moodboard(&json!({"op": "remove", "boardId": "b1"})).unwrap(), Mood::Remove { board_id: "b1".into() });
        assert_eq!(read_moodboard(&json!({"op": "removeImage", "boardId": "b1", "imageId": "i1"})).unwrap(), Mood::RemoveImage { board_id: "b1".into(), image_id: "i1".into() });
        let added = read_moodboard(&json!({"op": "addImage", "boardId": "b1", "input": {"name": "a.png", "dataUrl": "data:image/png;base64,AAAA"}})).unwrap();
        assert_eq!(added, Mood::AddImage { board_id: "b1".into(), name: "a.png".into(), data_url: "data:image/png;base64,AAAA".into() });
        assert_eq!((added.op(), added.board_id()), ("addImage", Some("b1")));
    }

    #[test]
    fn moodboard_refusals_name_their_reason() {
        for (params, expected) in [
            (json!({"op": "create", "input": {"projectId": "p1", "name": ""}}), "InvalidShape"), (json!({"op": "create", "input": {"projectId": "p1", "name": "a\nb"}}), "InvalidShape"),
            (json!({"op": "create", "input": {"projectId": "p1", "name": "x".repeat(MAX_NAME_CHARS + 1)}}), "LimitExceeded"),
            (json!({"op": "create", "input": {"projectId": "p1", "name": "a", "path": "C:/x"}}), "InvalidShape"), (json!({"op": "create", "input": {"name": "a"}}), "InvalidShape"),
            (json!({"op": "create", "projectId": "p1", "name": "a"}), "InvalidShape"), (json!({"op": "rename", "boardId": "b1"}), "InvalidShape"),
            (json!({"op": "remove", "boardId": "b1", "confirmed": true}), "InvalidShape"), (json!({"op": "remove"}), "InvalidShape"),
            (json!({"op": "addImage", "boardId": "b1", "input": {"name": "a", "dataUrl": "file:///etc/passwd"}}), "InvalidShape"),
            (json!({"op": "addImage", "boardId": "b1", "input": {"name": "a", "dataUrl": format!("data:image/png;base64,{}", "A".repeat(MAX_DATA_URL_BYTES))}}), "LimitExceeded"),
            (json!({"op": "addImage", "boardId": "b1", "input": {"name": "a", "dataUrl": "data:image/png;base64,AA", "token": "x"}}), "InvalidShape"),
            (json!({"op": "list"}), "InvalidShape"), (json!("create"), "InvalidShape"),
        ] { assert_eq!(code(read_moodboard(&params)), expected, "{params}"); }
    }

    #[test]
    fn cloud_calls_read_with_their_exact_fields() {
        assert_eq!(read_cloud(&json!({"op": "provision", "input": {"provider": "daytona", "name": "box-1"}})).unwrap(), Cloud::Provision { provider: "daytona".into(), name: "box-1".into() });
        for op in ["sync", "retry", "open", "stop", "remove"] {
            let read = read_cloud(&json!({"op": op, "machineId": "daytona:abc-1"})).unwrap();
            assert_eq!((read.op(), read.machine_id()), (op, Some("daytona:abc-1")));
        }
    }

    #[test]
    fn cloud_refusals_name_their_reason_and_credentials_are_not_fields() {
        for (params, expected) in [
            (json!({"op": "provision", "input": {"provider": "daytona", "name": "a", "apiKey": "k"}}), "InvalidShape"), (json!({"op": "provision", "input": {"provider": "daytona", "name": "a", "credentials": {}}}), "InvalidShape"),
            (json!({"op": "provision", "input": {"provider": "Daytona", "name": "a"}}), "InvalidShape"), (json!({"op": "provision", "input": {"provider": "daytona", "name": "a b"}}), "InvalidShape"),
            (json!({"op": "provision", "input": {"provider": "daytona", "name": "x".repeat(64)}}), "LimitExceeded"), (json!({"op": "provision", "input": {"provider": "daytona"}}), "InvalidShape"),
            (json!({"op": "sync", "machineId": "nowhere:abc"}), "InvalidShape"), (json!({"op": "sync", "machineId": "daytona:../x"}), "InvalidShape"), (json!({"op": "stop"}), "InvalidShape"),
            (json!({"op": "remove", "machineId": "daytona:abc", "prompt": "x"}), "InvalidShape"), (json!({"op": "pair", "machineId": "daytona:abc"}), "InvalidShape"),
            (json!({"op": "remoteAccess"}), "InvalidShape"),
        ] { assert_eq!(code(read_cloud(&params)), expected, "{params}"); }
    }

    #[test]
    fn native_text_maps_to_frozen_codes_and_never_passes_through() {
        for (text, expected) in [
            ("Wait for the agent to finish, or stop it first.", "Busy"), ("This project has 24 moodboards. Remove one before adding another.", "LimitExceeded"),
            ("Connect Daytona first.", "UnsupportedCapability"), ("Use a name between 1 and 120 characters.", "InvalidShape"), ("Moodboard is unavailable in this project.", "NotFound"),
            ("Unknown cloud machine.", "NotFound"), ("Image is no longer available.", "NotFound"), ("a socket exploded", "HostUnavailable"),
        ] { assert_eq!(code_of(text), expected, "{text}"); }
        assert!(!native("secret token abc123").path.contains("abc123"));
    }

    #[test]
    fn confirmations_wait_per_package_and_end_with_their_service() {
        let slots = WorkspaceCloud::default();
        let mut receivers = Vec::new();
        for _ in 0..MAX_WAITING { receivers.push(slots.begin("a.pkg").unwrap()); }
        assert_eq!(slots.begin("a.pkg").unwrap_err(), "LimitExceeded");
        assert!(slots.begin("b.pkg").is_ok(), "another package has its own room");
        assert_eq!(slots.count("a.pkg"), MAX_WAITING);
        let (id, mut receiver) = receivers.remove(0);
        slots.answer(&id, &json!({"accepted": true})).unwrap();
        assert_eq!(receiver.try_recv().unwrap(), json!({"accepted": true}));
        assert_eq!(slots.answer(&id, &json!({"accepted": true})).unwrap_err(), "NotFound", "an answer is used once");
        assert_eq!(slots.cancel_owner("a.pkg"), MAX_WAITING - 1);
        let (_, mut waiting) = receivers.remove(0);
        assert_eq!(waiting.try_recv().unwrap()["code"], "Revoked");
        assert_eq!(slots.count("a.pkg"), 0);
    }

    #[test]
    fn the_activity_log_keeps_the_newest_calls_without_values() {
        let log = WorkspaceCloud::default();
        for index in 0..(ACTIVITY_MAX + 5) { log.record(if index % 2 == 0 { "a.pkg" } else { "b.pkg" }, "workspaceCloud", &format!("daytona:{index}"), "ok"); }
        let all = log.activity(None);
        assert_eq!(all.len(), ACTIVITY_MAX);
        assert_eq!(all[0]["subject"], "daytona:5");
        assert!(log.activity(Some("a.pkg")).iter().all(|entry| entry["owner"] == "a.pkg"));
        assert!(all.iter().all(|entry| entry.as_object().unwrap().keys().all(|key| ["at", "owner", "method", "subject", "outcome"].contains(&key.as_str()))));
    }
}
