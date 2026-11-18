//! Attributed task start for background services (`tasks.start`, runtime phase R4, slice R0401).
//!
//! A trusted service starts a task with `panda.tasks.start({projectId, prompt, ...})`. The host starts it the way the
//! user's own New task does: the harness, model, effort and mode default to what the user would get for a new task in
//! that project (the main window owns those choices and answers them), the worktree is the current checkout, a new
//! one the host creates, or an existing branch, and the prompt is sent as the first message. A `target` names a machine
//! that is already paired: starting a task there is part of `tasks.start`, while pairing a machine and granting remote
//! access are not package operations and have no call here.
//!
//! The permission `tasks.start` is project scoped. It is rechecked against the grants file on every request, twice (at
//! admission and again before anything is created), so a revoke or a narrowing between the two creates nothing. A
//! package that holds it is never asked again per action (ADR-0005). The refusals are the frozen ones:
//! - no grant, a revoked grant, a disabled package or a project outside the narrowed scope: `PermissionDenied`, with
//!   the permission name in `path`;
//! - an unknown project, harness or target: `NotFound`;
//! - a harness that is signed out or not installed: `HostUnavailable`, `ids` carrying the readiness state;
//! - a shape the call does not take: `InvalidShape`; a size or concurrency bound: `LimitExceeded`.
//!
//! A refused start creates no task, no worktree and no mirror row.
//!
//! Every task started this way is attributed: `TaskOrigins` keeps the package id and its display name next to the task
//! id (file-backed, independent of SQLite, so the label survives the package and the schema stays as it is). The
//! sidebar, the thread header and the history rows read it through `extensions_runtime_task_origins`, and the
//! `task.created` workspace event carries `startedBy: {package}`.
//!
//! Rules that are for predictability and fault isolation, never for trust: four starts waiting for the window's defaults
//! per package, a 15 s bound on that answer, bounded prompt, title and attachment lists, and an origins ledger of at most
//! 10,000 tasks (the oldest label goes first). The state is pure (an injected world) so the rules are deterministic to
//! test; the app half (`serve`) only adds the grants file, the store and the window.
use serde_json::{json, Map, Value};
use std::{collections::{BTreeMap, VecDeque}, path::{Path, PathBuf}, sync::Mutex, time::Duration};
use tokio::sync::oneshot;

/// The named permission (project scoped, granted with the trust decision, rechecked on every request).
pub const PERMISSION: &str = "tasks.start";
pub const PROMPT_BYTES: usize = 200_000;
pub const TITLE_CHARS: usize = 200;
pub const MAX_ATTACHMENTS: usize = 16;
/// Starts per package that may wait for the window's defaults at once.
pub const MAX_WAITING: usize = 4;
/// How long the window has to answer the defaults of one start.
pub const DEFAULTS_WAIT: Duration = Duration::from_secs(15);
pub const MAX_ORIGINS: usize = 10_000;
pub const MODES: [&str; 5] = ["ask", "auto", "review", "plan", "full"];
const KEYS: [&str; 10] = ["projectId", "prompt", "harness", "model", "effort", "mode", "title", "worktree", "target", "attachments"];

/// A refusal in the broker envelope: `code`, the `path` it names and the `ids` it carries.
pub fn failure_with(code: &str, path: &str, ids: &[String]) -> Value { json!({"ok": false, "error": {"schemaVersion": 1, "code": code, "path": path, "ids": ids}}) }
pub fn failure(code: &str) -> Value { failure_with(code, "$", &[]) }
fn ok(value: Value) -> Value { json!({"ok": true, "value": value}) }
fn ident(text: &str) -> bool { !text.is_empty() && text.chars().count() <= 128 && !text.chars().any(char::is_control) }

/// Which checkout the task works in.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Worktree { Current, New, Existing(String) }

/// A validated `tasks.start` request.
#[derive(Clone, Debug, PartialEq)]
pub struct Spec {
    pub project_id: String, pub prompt: String, pub title: Option<String>,
    pub harness: Option<String>, pub model: Option<String>, pub effort: Option<String>, pub mode: Option<String>,
    pub worktree: Worktree, pub target: Option<String>, pub attachments: Vec<String>,
}

/// What admission may refuse: the code, the path it names and the ids it carries.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Refusal { pub code: String, pub path: String, pub ids: Vec<String> }
impl Refusal {
    pub fn new(code: &str) -> Self { Self { code: code.into(), path: "$".into(), ids: vec![] } }
    pub fn denied() -> Self { Self { code: "PermissionDenied".into(), path: PERMISSION.into(), ids: vec![] } }
    pub fn envelope(&self) -> Value { failure_with(&self.code, &self.path, &self.ids) }
}
impl From<&str> for Refusal { fn from(code: &str) -> Self { Self::new(code) } }

/// What the app answers about the world; tests give fixed answers.
pub struct World<'a> {
    /// The package holds `tasks.start` for this project now (the grants file, narrowing included).
    pub granted: &'a dyn Fn(&str) -> bool,
    pub project_exists: &'a dyn Fn(&str) -> bool,
    /// A machine that is already paired and accepts remote control (`remote_targets`).
    pub target_paired: &'a dyn Fn(&str) -> bool,
}

fn text_field(object: &Map<String, Value>, key: &str) -> Result<Option<String>, Refusal> {
    match object.get(key) { None | Some(Value::Null) => Ok(None), Some(Value::String(text)) if ident(text) => Ok(Some(text.clone())), Some(_) => Err("InvalidShape".into()) }
}

/// Reads a request and checks it against the world, in the order the refusals are frozen: the shape of the project id,
/// the permission, the rest of the shape, then what must exist.
pub fn admit(world: &World, raw: &Value) -> Result<Spec, Refusal> {
    let object = raw.as_object().ok_or("InvalidShape")?;
    let project_id = object.get("projectId").and_then(Value::as_str).filter(|id| ident(id)).ok_or("InvalidShape")?.to_owned();
    if !(world.granted)(&project_id) { return Err(Refusal::denied()); }
    if object.keys().any(|key| !KEYS.contains(&key.as_str())) { return Err("InvalidShape".into()); }
    let prompt = object.get("prompt").and_then(Value::as_str).ok_or("InvalidShape")?;
    if prompt.trim().is_empty() { return Err("InvalidShape".into()); }
    if prompt.len() > PROMPT_BYTES { return Err("LimitExceeded".into()); }
    let title = match object.get("title") {
        None | Some(Value::Null) => None,
        Some(Value::String(title)) if title.chars().any(char::is_control) || title.trim().is_empty() => return Err("InvalidShape".into()),
        Some(Value::String(title)) if title.chars().count() > TITLE_CHARS => return Err("LimitExceeded".into()),
        Some(Value::String(title)) => Some(title.trim().to_owned()),
        Some(_) => return Err("InvalidShape".into()),
    };
    let (harness, model, effort) = (text_field(object, "harness")?, text_field(object, "model")?, text_field(object, "effort")?);
    let mode = text_field(object, "mode")?;
    if mode.as_deref().is_some_and(|mode| !MODES.contains(&mode)) { return Err("InvalidShape".into()); }
    let worktree = match object.get("worktree") {
        None | Some(Value::Null) => Worktree::Current,
        Some(Value::String(text)) if text == "current" => Worktree::Current,
        Some(Value::String(text)) if text == "new" => Worktree::New,
        Some(Value::String(text)) if ident(text) && text.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '/' | '.')) && !text.contains("..") && !text.starts_with('-') => Worktree::Existing(text.clone()),
        Some(_) => return Err("InvalidShape".into()),
    };
    let target = text_field(object, "target")?;
    let attachments = match object.get("attachments") {
        None | Some(Value::Null) => vec![],
        Some(Value::Array(items)) => {
            if items.len() > MAX_ATTACHMENTS { return Err("LimitExceeded".into()); }
            items.iter().map(|item| item.as_str().filter(|id| ident(id)).map(str::to_owned).ok_or_else(|| Refusal::from("InvalidShape"))).collect::<Result<Vec<_>, _>>()?
        }
        Some(_) => return Err("InvalidShape".into()),
    };
    if !(world.project_exists)(&project_id) { return Err("NotFound".into()); }
    if target.as_deref().is_some_and(|target| !(world.target_paired)(target)) { return Err("NotFound".into()); }
    Ok(Spec { project_id, prompt: prompt.to_owned(), title, harness, model, effort, mode, worktree, target, attachments })
}

/// What the window resolved for a start: the user's defaults with the request's own choices laid over them.
#[derive(Clone, Debug, PartialEq)]
pub struct Defaults { pub harness: String, pub model: String, pub mode: String, pub effort: Option<String> }

/// Reads the window's answer: `{ok: true, harness, model, mode, effort?}`, or `{ok: false, code, state?}` where `code` is
/// `NotFound` (unknown harness), `HostUnavailable` (`state` is the readiness: `signedOut` or `unavailable`) or `InvalidShape`.
pub fn read_defaults(answer: &Value) -> Result<Defaults, Refusal> {
    if answer["ok"] == true {
        let text = |key: &str| answer[key].as_str().filter(|value| ident(value)).map(str::to_owned);
        let (harness, model, mode) = (text("harness").ok_or("InvalidShape")?, text("model").ok_or("InvalidShape")?, text("mode").ok_or("InvalidShape")?);
        if !MODES.contains(&mode.as_str()) { return Err("InvalidShape".into()); }
        return Ok(Defaults { harness, model, mode, effort: text("effort") });
    }
    match answer["code"].as_str() {
        Some("HostUnavailable") => Err(Refusal { code: "HostUnavailable".into(), path: "$".into(), ids: vec![match answer["state"].as_str() { Some("signedOut") => "signedOut".to_owned(), _ => "unavailable".to_owned() }] }),
        Some("NotFound") => Err("NotFound".into()),
        _ => Err("InvalidShape".into()),
    }
}

/// The branch a `worktree: 'new'` start makes: from the title or the prompt, with a short suffix of the task id.
pub fn branch_name(seed: &str, task_id: &str) -> String {
    let mut slug = String::new();
    for word in seed.to_lowercase().split(|c: char| !c.is_ascii_alphanumeric()).filter(|word| !word.is_empty()) {
        if !slug.is_empty() && slug.len() + 1 + word.len() > 40 { break; }
        if !slug.is_empty() { slug.push('-'); }
        slug.push_str(&word.chars().take(40).collect::<String>());
    }
    let suffix: String = task_id.chars().filter(char::is_ascii_alphanumeric).take(6).collect();
    let name = [slug, suffix].iter().filter(|part| !part.is_empty()).cloned().collect::<Vec<_>>().join("-");
    format!("pandacode/{}", if name.is_empty() { "task".to_owned() } else { name })
}

/// Maps the text of a failed host operation to the frozen code. Nothing of the text reaches the package.
pub fn code_of(error: &str) -> &'static str {
    let error = error.to_lowercase();
    if error.contains("already exists") || error.contains("already checked out") || error.contains("destination") { "Conflict" }
    else if error.contains("permission mode") || error.contains("too long") || error.contains("effort") { "InvalidShape" }
    else if error.contains("does not exist") || error.contains("not found") || error.contains("unknown") { "NotFound" }
    else { "HostUnavailable" }
}

// ---- Attribution ---------------------------------------------------------------------------------------------------

/// Who started a task: the package id and the name it showed, kept after the package is gone.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Origin { pub owner: String, pub package: String, pub project_id: String, pub at: u64 }

#[derive(Default)]
struct Ledger { entries: BTreeMap<String, Origin>, order: VecDeque<String>, revision: u64 }

/// Every task a package started, with its label. Persisted next to the grants so the label survives a restart.
pub struct TaskOrigins { inner: Mutex<Ledger>, file: Option<PathBuf> }
impl Default for TaskOrigins { fn default() -> Self { Self { inner: Mutex::new(Ledger::default()), file: None } } }

impl TaskOrigins {
    /// Opens (or starts) the ledger in `dir`; an unreadable file starts empty and is replaced on the next record.
    pub fn open(dir: &Path) -> Self {
        let file = dir.join("task-origins.json");
        let mut ledger = Ledger::default();
        if let Ok(text) = std::fs::read_to_string(&file) {
            if let Ok(Value::Object(entries)) = serde_json::from_str::<Value>(&text).map(|value| value["tasks"].clone()) {
                let mut rows: Vec<(String, Origin)> = entries.iter().filter_map(|(id, row)| Some((id.clone(), Origin { owner: row["owner"].as_str()?.to_owned(), package: row["package"].as_str()?.to_owned(), project_id: row["projectId"].as_str().unwrap_or_default().to_owned(), at: row["at"].as_u64().unwrap_or(0) }))).collect();
                rows.sort_by_key(|(_, origin)| origin.at);
                for (id, origin) in rows { ledger.order.push_back(id.clone()); ledger.entries.insert(id, origin); }
            }
        }
        Self { inner: Mutex::new(ledger), file: Some(file) }
    }
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Ledger>, &'static str> { self.inner.lock().map_err(|_| "HostUnavailable") }
    fn save(&self, ledger: &Ledger) {
        let Some(file) = &self.file else { return };
        let tasks: Map<String, Value> = ledger.order.iter().filter_map(|id| ledger.entries.get(id).map(|origin| (id.clone(), json!({"owner": origin.owner, "package": origin.package, "projectId": origin.project_id, "at": origin.at})))).collect();
        let temporary = file.with_extension("json.tmp");
        if std::fs::write(&temporary, json!({"schemaVersion": 1, "tasks": tasks}).to_string()).is_ok() { let _ = std::fs::rename(&temporary, file); }
    }
    /// Labels a task. A second record of the same task keeps the first (a task has one starter).
    pub fn record(&self, task_id: &str, origin: Origin) -> Result<(), &'static str> {
        let mut ledger = self.lock()?;
        if ledger.entries.contains_key(task_id) { return Ok(()); }
        ledger.entries.insert(task_id.to_owned(), origin);
        ledger.order.push_back(task_id.to_owned());
        while ledger.order.len() > MAX_ORIGINS { if let Some(oldest) = ledger.order.pop_front() { ledger.entries.remove(&oldest); } }
        ledger.revision += 1;
        self.save(&ledger);
        Ok(())
    }
    /// A deleted task loses its label.
    pub fn forget(&self, task_id: &str) -> bool {
        let Ok(mut ledger) = self.inner.lock() else { return false };
        if ledger.entries.remove(task_id).is_none() { return false; }
        ledger.order.retain(|id| id != task_id);
        ledger.revision += 1;
        self.save(&ledger);
        true
    }
    pub fn get(&self, task_id: &str) -> Option<Origin> { self.inner.lock().ok().and_then(|ledger| ledger.entries.get(task_id).cloned()) }
    pub fn revision(&self) -> u64 { self.inner.lock().map_or(0, |ledger| ledger.revision) }
    pub fn len(&self) -> usize { self.inner.lock().map_or(0, |ledger| ledger.entries.len()) }
    pub fn is_empty(&self) -> bool { self.len() == 0 }
    /// What the interface reads: task id to `{owner, package}`, and the revision that changes with every record.
    pub fn snapshot(&self) -> Value {
        let Ok(ledger) = self.inner.lock() else { return json!({"revision": 0, "origins": {}}) };
        let origins: Map<String, Value> = ledger.entries.iter().map(|(id, origin)| (id.clone(), json!({"owner": origin.owner, "package": origin.package, "projectId": origin.project_id}))).collect();
        json!({"revision": ledger.revision, "origins": origins})
    }
}

// ---- Starts waiting for the window's defaults -----------------------------------------------------------------------

struct Waiting { owner: String, sender: Option<oneshot::Sender<Value>> }
#[derive(Default)]
struct Slots { waiting: BTreeMap<String, Waiting>, serial: u64 }

/// The starts that wait for the main window to answer which harness, model and mode to use.
#[derive(Default)]
pub struct StartSlots { inner: Mutex<Slots> }
impl StartSlots {
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Slots>, &'static str> { self.inner.lock().map_err(|_| "HostUnavailable") }
    /// A start waits: its id and the receiver the answer arrives on. A fifth one of the package is `LimitExceeded`.
    pub fn begin(&self, owner: &str) -> Result<(String, oneshot::Receiver<Value>), &'static str> {
        let mut slots = self.lock()?;
        if slots.waiting.values().filter(|waiting| waiting.owner == owner).count() >= MAX_WAITING { return Err("LimitExceeded"); }
        slots.serial += 1;
        let id = format!("{owner}#start-{}", slots.serial);
        let (sender, receiver) = oneshot::channel();
        slots.waiting.insert(id.clone(), Waiting { owner: owner.to_owned(), sender: Some(sender) });
        Ok((id, receiver))
    }
    /// The window answers start `id`. An answer for a start that is gone (answered, timed out, ended) is `NotFound`.
    pub fn answer(&self, id: &str, answer: &Value) -> Result<(), &'static str> {
        let mut slots = self.lock()?;
        let mut waiting = slots.waiting.remove(id).ok_or("NotFound")?;
        if let Some(sender) = waiting.sender.take() { let _ = sender.send(answer.clone()); }
        Ok(())
    }
    /// The package's service ended: its waiting starts resolve as revoked and create nothing.
    pub fn cancel_owner(&self, owner: &str) -> usize {
        let Ok(mut slots) = self.inner.lock() else { return 0 };
        let ids: Vec<String> = slots.waiting.iter().filter(|(_, waiting)| waiting.owner == owner).map(|(id, _)| id.clone()).collect();
        for id in &ids { if let Some(mut waiting) = slots.waiting.remove(id) { if let Some(sender) = waiting.sender.take() { let _ = sender.send(json!({"ok": false, "code": "Revoked"})); } } }
        ids.len()
    }
    pub fn forget(&self, id: &str) -> bool { self.inner.lock().is_ok_and(|mut slots| slots.waiting.remove(id).is_some()) }
    pub fn count(&self, owner: &str) -> usize { self.inner.lock().map_or(0, |slots| slots.waiting.values().filter(|waiting| waiting.owner == owner).count()) }
}

// ---- The app ---------------------------------------------------------------------------------------------------------

pub fn state(app: &tauri::AppHandle) -> Option<tauri::State<'_, StartSlots>> { use tauri::Manager; app.try_state::<StartSlots>() }
pub fn origins(app: &tauri::AppHandle) -> Option<tauri::State<'_, TaskOrigins>> { use tauri::Manager; app.try_state::<TaskOrigins>() }
fn origins_changed(app: &tauri::AppHandle) { use tauri::Emitter; let _ = app.emit("extensions-runtime-task-origins", origins(app).map_or(0, |ledger| ledger.revision())); }

/// What the service request needs from the installed package: its version and the name it shows.
fn package(app: &tauri::AppHandle, owner: &str) -> Result<(String, String), &'static str> {
    use tauri::Manager;
    let packages = app.state::<crate::extensions::packages::ExtensionPackages>();
    let packages = packages.0.try_lock().map_err(|_| "Timeout")?;
    let version = super::runtime_service_lifetime::runtime_usage_resources::enabled_version(&packages, owner).ok_or("PermissionDenied")?;
    let snapshot = serde_json::to_value(packages.snapshot()).unwrap_or(Value::Null);
    let name = snapshot["packages"].as_array().into_iter().flatten().find(|package| package["manifest"]["id"] == owner).and_then(|package| package["manifest"]["name"].as_str().filter(|name| !name.trim().is_empty()).map(str::to_owned)).unwrap_or_else(|| owner.to_owned());
    Ok((version, name))
}

fn granted(app: &tauri::AppHandle, owner: &str, version: &str, project: &str) -> bool {
    use tauri::Manager;
    app.try_state::<super::runtime_grants::RuntimeGrants>().is_some_and(|grants| grants.check(owner, version, PERMISSION, &super::runtime_grants::Target::project(project)).is_ok())
}

/// Removes the waiting start when its request is dropped (the service ended while it waited).
struct Guard { app: tauri::AppHandle, id: String }
impl Drop for Guard { fn drop(&mut self) { if let Some(slots) = state(&self.app) { slots.forget(&self.id); } } }

/// Serves `tasksStart` of the service of `request.owner`.
pub async fn serve(app: tauri::AppHandle, request: super::runtime_service_lifetime::DispatchRequest) -> Value {
    use tauri::{Emitter, Manager};
    let owner = request.owner.clone();
    let Some(slots) = state(&app) else { return failure("UnsupportedCapability") };
    let found = { let app = app.clone(); let owner = owner.clone(); tauri::async_runtime::spawn_blocking(move || package(&app, &owner)).await.unwrap_or(Err("HostUnavailable")) };
    let (version, name) = match found { Ok(found) => found, Err(code) => return if code == "PermissionDenied" { Refusal::denied().envelope() } else { failure(code) } };
    // Admission: the grant (narrowing included), the project and the paired target. Nothing exists yet.
    let paired: Vec<String> = if request.params["target"].is_string() { crate::remote::remote_targets(app.clone()).await.iter().filter_map(|row| row["deviceId"].as_str().map(str::to_owned)).collect() } else { vec![] };
    let spec = {
        let project_exists = |id: &str| app.try_state::<crate::AppState>().is_some_and(|state| state.store.lock().is_ok_and(|store| store.project(id).is_ok()));
        let world = World { granted: &|project: &str| granted(&app, &owner, &version, project), project_exists: &project_exists, target_paired: &|target| paired.iter().any(|device| device == target) };
        match admit(&world, &request.params) { Ok(spec) => spec, Err(refusal) => return refusal.envelope() }
    };
    // The window owns the user's defaults and the catalog: it answers the harness, model, mode and readiness.
    if crate::headless::active() { return failure("UnsupportedCapability"); }
    let (id, receiver) = match slots.begin(&owner) { Ok(opened) => opened, Err(code) => return failure(code) };
    let _guard = Guard { app: app.clone(), id: id.clone() };
    let _ = app.emit("extensions-runtime-task-defaults", json!({"id": id, "owner": owner, "projectId": spec.project_id, "harness": spec.harness, "model": spec.model, "effort": spec.effort, "mode": spec.mode, "target": spec.target}));
    let answer = match tokio::time::timeout(DEFAULTS_WAIT, receiver).await { Ok(Ok(answer)) => answer, Ok(Err(_)) => return failure("Revoked"), Err(_) => return failure("Timeout") };
    if answer["code"] == "Revoked" { return failure("Revoked"); }
    let defaults = match read_defaults(&answer) { Ok(defaults) => defaults, Err(refusal) => return refusal.envelope() };
    // The permission is read again just before anything is created: a revoke or a narrowing in between creates nothing.
    if !granted(&app, &owner, &version, &spec.project_id) || package(&app, &owner).is_err() { return Refusal::denied().envelope(); }
    match launch(&app, &owner, &name, &spec, &defaults).await {
        Ok(started) => ok(started),
        Err(code) => failure(code),
    }
}

/// Creates the task, attributes it, and sends the prompt as its first message. Answers `{id, projectId, worktree}`.
async fn launch(app: &tauri::AppHandle, owner: &str, name: &str, spec: &Spec, defaults: &Defaults) -> Result<Value, &'static str> {
    use tauri::{Emitter, Manager};
    let state = app.state::<crate::AppState>();
    let title = spec.title.clone();
    // A paired machine: the task runs there and its mirror row is the local task (identity and defaults carried over).
    if let Some(device) = &spec.target {
        let (worktree, branch) = match &spec.worktree { Worktree::Current => (false, None), Worktree::New => (true, None), Worktree::Existing(branch) => (true, Some(branch.clone())) };
        let started = crate::remote::mirror::remote_start_task(app.clone(), app.state::<crate::AppState>(), device.clone(), spec.project_id.clone(), spec.prompt.clone(), defaults.harness.clone(), defaults.model.clone(), Some(defaults.mode.clone()), defaults.effort.clone(), Some(worktree), branch, None, None, Some(spec.attachments.clone())).await.map_err(|error| code_of(&error))?;
        let task = started["sessionId"].as_str().or_else(|| started["id"].as_str()).ok_or("HostUnavailable")?.to_owned();
        attribute(app, owner, name, &task, &spec.project_id);
        if let Some(title) = title { let _ = state.store.lock().map_err(|_| "HostUnavailable")?.update(&task, Some(title), None, None, None); }
        let _ = app.emit("sessions-changed", ());
        return Ok(json!({"id": task, "projectId": spec.project_id, "worktree": started["worktreeBranch"].as_str()}));
    }
    // Local: the task exists only once every part that can fail has passed (a worktree that cannot be made removes it).
    let created = {
        let store = state.store.lock().map_err(|_| "HostUnavailable")?;
        let task = crate::architect::profiles::create_task_without_team(&store, &spec.project_id, &defaults.harness, &defaults.model, Some(defaults.mode.as_str()), None).map_err(|error| code_of(&error))?;
        if let Some(effort) = defaults.effort.as_deref() { if let Err(error) = store.set_reasoning_effort(&task.id, Some(effort)) { if spec.effort.is_some() { drop(store); discard(&state, &task.id); return Err(code_of(&error)); } } }
        if let Some(title) = &title { if let Err(error) = store.update(&task.id, Some(title.clone()), None, None, None) { drop(store); discard(&state, &task.id); return Err(code_of(&error)); } }
        task
    };
    let mut worktree = None;
    if spec.worktree != Worktree::Current {
        let (branch, existing) = match &spec.worktree { Worktree::Existing(branch) => (branch.clone(), true), _ => (branch_name(title.as_deref().unwrap_or(&spec.prompt), &created.id), false) };
        match crate::attach_worktree(app.state::<crate::AppState>(), created.id.clone(), branch, None, Some(existing)).await {
            Ok(attached) => worktree = attached.worktree_branch.clone(),
            Err(error) => { discard(&state, &created.id); return Err(code_of(&error)); }
        }
    }
    attribute(app, owner, name, &created.id, &spec.project_id);
    super::runtime_service_lifetime::runtime_workspace_events::publish_app(app, &json!({"kind": "task.created", "taskId": created.id, "projectId": spec.project_id, "harness": defaults.harness, "startedBy": {"package": owner}}), None);
    let _ = app.emit("sessions-changed", ());
    let images = if spec.attachments.is_empty() { None } else { Some(spec.attachments.clone()) };
    // The prompt is the first message, sent as the composer sends it. A failed send leaves the labelled task for the user to see.
    crate::send_prompt(app.clone(), app.state::<crate::AppState>(), created.id.clone(), spec.prompt.clone(), images).await.map_err(|error| code_of(&error))?;
    Ok(json!({"id": created.id, "projectId": spec.project_id, "worktree": worktree}))
}

/// A task that could not be completed leaves nothing behind.
fn discard(state: &crate::AppState, task: &str) { let _ = crate::task_deletion::delete_state(state, task); }

fn attribute(app: &tauri::AppHandle, owner: &str, name: &str, task: &str, project: &str) {
    if let Some(ledger) = origins(app) { let _ = ledger.record(task, Origin { owner: owner.to_owned(), package: name.to_owned(), project_id: project.to_owned(), at: super::runtime_notifications::now_millis() }); }
    origins_changed(app);
}

/// The service of `owner` stopped (disable, revoke, uninstall, safe mode, crash, quit): its waiting starts create nothing.
pub fn service_stopped(app: &tauri::AppHandle, owner: &str) { if let Some(slots) = state(app) { slots.cancel_owner(owner); } }

/// The main window answers the defaults a start waits for.
#[tauri::command]
pub fn extensions_runtime_task_defaults_answer(window: tauri::WebviewWindow, app: tauri::AppHandle, id: String, answer: Value) -> Result<(), String> {
    if crate::headless::active() || window.label() != "main" { return Err("PermissionDenied".into()); }
    let Some(slots) = state(&app) else { return Err("UnsupportedCapability".into()) };
    slots.answer(&id, &answer).map_err(str::to_owned)
}
/// The interface reads which package started each task (sidebar, thread header, history).
#[tauri::command]
pub fn extensions_runtime_task_origins(app: tauri::AppHandle) -> Value { origins(&app).map_or_else(|| json!({"revision": 0, "origins": {}}), |ledger| ledger.snapshot()) }
/// A deleted task loses its label.
pub fn task_removed(app: &tauri::AppHandle, task: &str) { if origins(app).is_some_and(|ledger| ledger.forget(task)) { origins_changed(app); } }

#[cfg(test)]
mod tests {
    use super::*;
    const OWNER: &str = "sample.runtime-tasks-start";

    fn world<'a>(allowed: &'a [&'a str], projects: &'a [&'a str], paired: &'a [&'a str]) -> (impl Fn(&str) -> bool + 'a, impl Fn(&str) -> bool + 'a, impl Fn(&str) -> bool + 'a) {
        (move |project: &str| allowed.contains(&project), move |project: &str| projects.contains(&project), move |target: &str| paired.contains(&target))
    }
    fn admit_with(raw: Value, allowed: &[&str], projects: &[&str], paired: &[&str]) -> Result<Spec, Refusal> {
        let (granted, exists, target) = world(allowed, projects, paired);
        admit(&World { granted: &granted, project_exists: &exists, target_paired: &target }, &raw)
    }
    fn code(result: Result<Spec, Refusal>) -> String { result.unwrap_err().code }

    #[test]
    fn a_granted_start_reads_prompt_title_and_worktree_and_leaves_the_rest_to_the_defaults() {
        let spec = admit_with(json!({"projectId": "A", "prompt": "Fix T-12", "title": " Fix T-12 ", "worktree": "new"}), &["A"], &["A"], &[]).unwrap();
        assert_eq!((spec.title.as_deref(), spec.worktree.clone(), spec.harness.clone(), spec.model.clone(), spec.mode.clone()), (Some("Fix T-12"), Worktree::New, None, None, None));
        let full = admit_with(json!({"projectId": "A", "prompt": "go", "harness": "fake/agent", "model": "m", "effort": "high", "mode": "plan", "worktree": "feature/x", "target": "studio", "attachments": ["img-1"]}), &["A"], &["A"], &["studio"]).unwrap();
        assert_eq!((full.worktree, full.target.as_deref(), full.attachments, full.mode.as_deref()), (Worktree::Existing("feature/x".into()), Some("studio"), vec!["img-1".to_owned()], Some("plan")));
        assert_eq!(admit_with(json!({"projectId": "A", "prompt": "go", "worktree": "current"}), &["A"], &["A"], &[]).unwrap().worktree, Worktree::Current);
    }

    #[test]
    fn no_grant_or_a_narrowed_project_is_permission_denied_naming_the_permission_and_nothing_else_is_checked() {
        for allowed in [&[][..], &["B"][..]] {
            let refusal = admit_with(json!({"projectId": "A", "prompt": "go"}), allowed, &["A"], &[]).unwrap_err();
            assert_eq!((refusal.code.as_str(), refusal.path.as_str()), ("PermissionDenied", "tasks.start"));
            // The grant answers first: a missing project or a bad target never leaks through a refusal.
            assert_eq!(code(admit_with(json!({"projectId": "ghost", "prompt": "go", "target": "nobody"}), allowed, &[], &[])), "PermissionDenied");
        }
    }

    #[test]
    fn unknown_project_or_unpaired_target_is_not_found_and_shapes_are_refused_with_their_reason() {
        assert_eq!(code(admit_with(json!({"projectId": "A", "prompt": "go"}), &["A"], &[], &[])), "NotFound");
        assert_eq!(code(admit_with(json!({"projectId": "A", "prompt": "go", "target": "stranger"}), &["A"], &["A"], &["studio"])), "NotFound");
        for (raw, expected) in [
            (json!("text"), "InvalidShape"), (json!({"prompt": "go"}), "InvalidShape"), (json!({"projectId": "A"}), "InvalidShape"), (json!({"projectId": "A", "prompt": "  "}), "InvalidShape"),
            (json!({"projectId": "A", "prompt": "go", "mode": "yolo"}), "InvalidShape"), (json!({"projectId": "A", "prompt": "go", "worktree": "../x"}), "InvalidShape"), (json!({"projectId": "A", "prompt": "go", "worktree": 3}), "InvalidShape"),
            (json!({"projectId": "A", "prompt": "go", "pair": "studio"}), "InvalidShape"), (json!({"projectId": "A", "prompt": "go", "remoteAccess": true}), "InvalidShape"), (json!({"projectId": "A", "prompt": "go", "attachments": "a"}), "InvalidShape"),
            (json!({"projectId": "A", "prompt": "x".repeat(PROMPT_BYTES + 1)}), "LimitExceeded"), (json!({"projectId": "A", "prompt": "go", "title": "t".repeat(TITLE_CHARS + 1)}), "LimitExceeded"),
            (json!({"projectId": "A", "prompt": "go", "attachments": vec!["a"; MAX_ATTACHMENTS + 1]}), "LimitExceeded"),
        ] { assert_eq!(code(admit_with(raw.clone(), &["A"], &["A"], &[])), expected, "{raw}"); }
    }

    #[test]
    fn the_windows_answer_is_the_defaults_or_the_frozen_harness_error() {
        let ok = read_defaults(&json!({"ok": true, "harness": "claude", "model": "sonnet", "mode": "full", "effort": "high"})).unwrap();
        assert_eq!((ok.harness.as_str(), ok.mode.as_str(), ok.effort.as_deref()), ("claude", "full", Some("high")));
        assert_eq!(read_defaults(&json!({"ok": false, "code": "NotFound"})).unwrap_err().code, "NotFound");
        let signed_out = read_defaults(&json!({"ok": false, "code": "HostUnavailable", "state": "signedOut"})).unwrap_err();
        assert_eq!((signed_out.code.as_str(), signed_out.ids), ("HostUnavailable", vec!["signedOut".to_owned()]));
        assert_eq!(read_defaults(&json!({"ok": false, "code": "HostUnavailable"})).unwrap_err().ids, vec!["unavailable".to_owned()]);
        for bad in [json!({"ok": true, "harness": "claude", "model": "m", "mode": "yolo"}), json!({"ok": true, "harness": "claude"}), json!({"ok": false, "code": "Explode"}), json!(null)] { assert_eq!(read_defaults(&bad).unwrap_err().code, "InvalidShape", "{bad}"); }
        assert_eq!(Refusal::new("NotFound").envelope()["error"]["ids"], json!([]));
    }

    #[test]
    fn a_new_worktree_branch_is_safe_short_and_unique_per_task() {
        let branch = branch_name("Fix the T-12 flaky login test, please!", "ab12-cd34-ef56");
        assert_eq!(branch, "pandacode/fix-the-t-12-flaky-login-test-please-ab12cd");
        assert!(branch.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '-')));
        assert_eq!(branch_name("!!!", "xyz"), "pandacode/xyz");
        assert!(branch_name(&"word ".repeat(40), "id").len() <= "pandacode/".len() + 40 + 3);
        assert_ne!(branch_name("same", "aaaaaa"), branch_name("same", "bbbbbb"));
    }

    #[test]
    fn host_failures_map_to_frozen_codes_without_their_text() {
        for (text, expected) in [("Branch x already exists. Use the existing branch.", "Conflict"), ("Branch x does not exist yet. Create it instead.", "NotFound"), ("Unknown permission mode.", "InvalidShape"), ("Unknown provider.", "NotFound"), ("Model name is too long.", "InvalidShape"), ("disk on fire", "HostUnavailable")] { assert_eq!(code_of(text), expected, "{text}"); }
    }

    #[test]
    fn waiting_starts_are_bounded_per_package_answered_once_and_end_with_the_service() {
        let slots = StartSlots::default();
        let mut open = vec![];
        for _ in 0..MAX_WAITING { open.push(slots.begin(OWNER).unwrap()); }
        assert_eq!(slots.begin(OWNER).err(), Some("LimitExceeded"));
        assert!(slots.begin("sample.other").is_ok());
        let (id, mut receiver) = open.remove(0);
        slots.answer(&id, &json!({"ok": true})).unwrap();
        assert_eq!(receiver.try_recv().unwrap(), json!({"ok": true}));
        // A second answer, or an answer for a start that is gone, reaches nobody.
        assert_eq!(slots.answer(&id, &json!({"ok": true})).unwrap_err(), "NotFound");
        assert_eq!(slots.count(OWNER), MAX_WAITING - 1);
        assert_eq!(slots.cancel_owner(OWNER), MAX_WAITING - 1);
        for (_, mut receiver) in open { assert_eq!(receiver.try_recv().unwrap()["code"], "Revoked"); }
        assert_eq!((slots.count(OWNER), slots.count("sample.other")), (0, 1));
    }

    #[test]
    fn origins_label_a_task_once_survive_a_restart_and_are_bounded() {
        let directory = std::env::temp_dir().join(format!("panda-task-origins-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let origin = |at: u64| Origin { owner: OWNER.into(), package: "Starter".into(), project_id: "A".into(), at };
        let ledger = TaskOrigins::open(&directory);
        ledger.record("t1", origin(1)).unwrap();
        ledger.record("t1", Origin { package: "Other".into(), ..origin(2) }).unwrap();
        ledger.record("t2", origin(3)).unwrap();
        assert_eq!((ledger.get("t1").unwrap().package.as_str(), ledger.len(), ledger.revision()), ("Starter", 2, 2));
        let reopened = TaskOrigins::open(&directory);
        assert_eq!(reopened.snapshot()["origins"]["t2"], json!({"owner": OWNER, "package": "Starter", "projectId": "A"}));
        assert!(reopened.forget("t2") && !reopened.forget("t2"));
        assert_eq!(TaskOrigins::open(&directory).len(), 1);
        let many = TaskOrigins::default();
        for index in 0..MAX_ORIGINS + 5 { many.record(&format!("t{index}"), origin(index as u64)).unwrap(); }
        assert_eq!((many.len(), many.get("t0").is_none(), many.get(&format!("t{}", MAX_ORIGINS + 4)).is_some()), (MAX_ORIGINS, true, true));
        let _ = std::fs::remove_dir_all(&directory);
    }
}
