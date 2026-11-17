//! Attributed task control for background services (`tasks.control`, runtime phase R4, slice R0404).
//!
//! A trusted service stops a task, sets its mode, configures it or compacts its context with `panda.tasks.stop`,
//! `setMode`, `configure` and `compact`. Each call is a thin adapter over the operation the interface already runs, with
//! the same arguments and the same refusals: `stop_session` (`architect_control` for a team, as the Stop button does),
//! `update_session`, `configure_session`, `set_reasoning_effort`, `architect_configure`, `connection_assign`,
//! `bot_assign_task`, `set_task_stage` and a `/compact` message sent as the composer sends it. [`plan`] is that mapping as
//! pure data, so a recording of the interface's own calls can be compared with what an action runs (the parity fixture).
//! Councils, workers and usage-limit pauses are a later slice (R0404B) and have no call here.
//!
//! The permission `tasks.control` is project scoped (the task's project). It is rechecked against the grants file on
//! every request, twice (at admission and again before anything changes), so a revoke or a narrowing between the two
//! changes nothing. A package that holds it is never asked again per action (ADR-0005). The refusals are the frozen ones:
//! - no grant, a revoked grant, a disabled package, a project outside the narrowed scope: `PermissionDenied`, naming the
//!   permission in `path`; a task that does not exist answers `PermissionDenied` too while the package holds the
//!   permission for no project at all (an id is never confirmed to a package that has no business with tasks);
//! - an unknown task, harness, model, connection, bot, team profile or machine: `NotFound`;
//! - a harness that is signed out or not installed: `HostUnavailable`, `ids` carrying the readiness state;
//! - a change the task cannot take now (a running agent, a conversation not started yet): `Conflict`;
//! - an operation the harness lacks (compaction, a mode the harness does not offer): `UnsupportedCapability`;
//! - a shape the call does not take: `InvalidShape`.
//!
//! A hook cannot silently change a task's mode (PLAN.md, Decisions): a `setMode` that comes from inside a hook handler is
//! refused, and every mode a service sets is recorded with the package's name where the user sees it. Every successful
//! control is recorded in [`ControlLog`] with the package id and its name, and a stop by a package reaches the
//! `task.stopped` event as `by: {package}`.
//!
//! The state is pure (an injected world) so the rules are deterministic to test; the app half (`serve`) only adds the
//! grants file, the store and the window.
use serde_json::{json, Map, Value};
use std::{collections::{BTreeMap, VecDeque}, sync::Mutex};

/// The named permission (project scoped, granted with the trust decision, rechecked on every request).
pub const PERMISSION: &str = "tasks.control";
pub const MODES: [&str; 5] = ["ask", "auto", "review", "plan", "full"];
pub const STAGES: [&str; 2] = ["active", "completed"];
pub const ACTIONS: [&str; 4] = ["stop", "setMode", "configure", "compact"];
/// The machine name that means this computer.
pub const LOCAL: &str = "local";
/// Fields `configure` takes; council, workers and limit pauses belong to R0404B.
pub const CONFIGURE_KEYS: [&str; 8] = ["harness", "model", "effort", "team", "connection", "bot", "target", "stage"];
pub const MAX_LOG: usize = 1_000;
/// How long a stop by a package keeps its label waiting for the run to end.
pub const STOP_LABEL_MS: u64 = 60_000;
const KEYS: [&str; 5] = ["action", "taskId", "mode", "change", "source"];
/// The text the composer sends to compact a task's context.
pub const COMPACT_COMMAND: &str = "/compact";

fn ident(text: &str) -> bool { !text.is_empty() && text.chars().count() <= 128 && !text.chars().any(char::is_control) }
fn ok(value: Value) -> Value { json!({"ok": true, "value": value}) }

/// A refusal in the broker envelope: `code`, the `path` it names and the `ids` it carries.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Refusal { pub code: String, pub path: String, pub ids: Vec<String> }
impl Refusal {
    pub fn new(code: &str) -> Self { Self { code: code.into(), path: "$".into(), ids: vec![] } }
    pub fn at(code: &str, path: &str) -> Self { Self { code: code.into(), path: path.into(), ids: vec![] } }
    pub fn denied() -> Self { Self::at("PermissionDenied", PERMISSION) }
    pub fn with_ids(mut self, ids: Vec<String>) -> Self { self.ids = ids; self }
    pub fn envelope(&self) -> Value { super::runtime_tasks_start::failure_with(&self.code, &self.path, &self.ids) }
}
impl From<&str> for Refusal { fn from(code: &str) -> Self { Self::new(code) } }

/// Where a request comes from: the service's own code, or a hook handler running inside it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source { Service, Hook }

/// A validated `configure` change. For the nullable fields `Some(None)` clears and `None` leaves alone.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Change {
    pub harness: Option<String>, pub model: Option<String>, pub effort: Option<Option<String>>, pub team: Option<Option<String>>,
    pub connection: Option<Option<String>>, pub bot: Option<Option<String>>, pub target: Option<String>, pub stage: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Action { Stop, SetMode(String), Configure(Change), Compact }
impl Action {
    pub fn name(&self) -> &'static str { match self { Action::Stop => "stop", Action::SetMode(_) => "setMode", Action::Configure(_) => "configure", Action::Compact => "compact" } }
}

/// A validated request: the task, the project it belongs to and what to do.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Spec { pub task_id: String, pub project_id: String, pub action: Action }

/// What the app answers about the world; tests give fixed answers.
pub struct World<'a> {
    /// The project of a task, when the task exists.
    pub task_project: &'a dyn Fn(&str) -> Option<String>,
    /// The package holds `tasks.control` for this project now (the grants file, narrowing included).
    pub granted: &'a dyn Fn(&str) -> bool,
    /// The package holds `tasks.control` for at least one project.
    pub holds_any: &'a dyn Fn() -> bool,
    /// A machine that is already paired and accepts remote control (`remote_targets`).
    pub target_paired: &'a dyn Fn(&str) -> bool,
}

fn nullable(object: &Map<String, Value>, key: &str) -> Result<Option<Option<String>>, Refusal> {
    match object.get(key) {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(None)),
        Some(Value::String(text)) if ident(text) => Ok(Some(Some(text.clone()))),
        Some(_) => Err(Refusal::at("InvalidShape", key)),
    }
}
fn text(object: &Map<String, Value>, key: &str) -> Result<Option<String>, Refusal> {
    match object.get(key) { None => Ok(None), Some(Value::String(text)) if ident(text) => Ok(Some(text.clone())), Some(_) => Err(Refusal::at("InvalidShape", key)) }
}

/// Reads the `configure` change: only the eight fields, at least one, each in its shape.
fn read_change(world: &World, raw: &Value) -> Result<Change, Refusal> {
    let object = raw.as_object().ok_or_else(|| Refusal::at("InvalidShape", "change"))?;
    if object.is_empty() { return Err(Refusal::at("InvalidShape", "change")); }
    if let Some(key) = object.keys().find(|key| !CONFIGURE_KEYS.contains(&key.as_str())) { return Err(Refusal::at("InvalidShape", key)); }
    let mut change = Change { harness: text(object, "harness")?, model: text(object, "model")?, target: text(object, "target")?, ..Change::default() };
    // The picker always names the model with the harness: a harness change without one has no model to start from.
    if change.harness.is_some() && change.model.is_none() { return Err(Refusal::at("InvalidShape", "model")); }
    change.effort = nullable(object, "effort")?;
    change.team = nullable(object, "team")?;
    change.connection = nullable(object, "connection")?;
    change.bot = nullable(object, "bot")?;
    change.stage = text(object, "stage")?;
    if change.stage.as_deref().is_some_and(|stage| !STAGES.contains(&stage)) { return Err(Refusal::at("InvalidShape", "stage")); }
    if change.target.as_deref().is_some_and(|target| target != LOCAL && !(world.target_paired)(target)) { return Err(Refusal::at("NotFound", "target")); }
    Ok(change)
}

/// Reads a request and checks it against the world, in the order the refusals are frozen: the shape of the task id and
/// the action name, the permission (the task's project), the rest of the shape, then what must exist.
pub fn admit(world: &World, raw: &Value) -> Result<Spec, Refusal> {
    let object = raw.as_object().ok_or("InvalidShape")?;
    let task_id = object.get("taskId").and_then(Value::as_str).filter(|id| ident(id)).ok_or("InvalidShape")?.to_owned();
    let name = object.get("action").and_then(Value::as_str).filter(|name| ACTIONS.contains(name)).ok_or("InvalidShape")?;
    let project_id = match (world.task_project)(&task_id) {
        Some(project) if (world.granted)(&project) => project,
        Some(_) => return Err(Refusal::denied()),
        None if (world.holds_any)() => return Err("NotFound".into()),
        None => return Err(Refusal::denied()),
    };
    if object.keys().any(|key| !KEYS.contains(&key.as_str())) { return Err("InvalidShape".into()); }
    let source = match object.get("source").and_then(Value::as_str) { None | Some("service") => Source::Service, Some("hook") => Source::Hook, Some(_) => return Err("InvalidShape".into()) };
    let extra = |key: &str| object.contains_key(key);
    let action = match name {
        "stop" | "compact" => {
            if extra("mode") || extra("change") { return Err("InvalidShape".into()); }
            if name == "stop" { Action::Stop } else { Action::Compact }
        }
        "setMode" => {
            if extra("change") { return Err("InvalidShape".into()); }
            let mode = object.get("mode").and_then(Value::as_str).filter(|mode| MODES.contains(mode)).ok_or_else(|| Refusal::at("InvalidShape", "mode"))?;
            // A hook decides about a call; it never moves the task to another mode behind the user's back.
            if source == Source::Hook { return Err(Refusal::at("PermissionDenied", "setMode").with_ids(vec!["hook".into()])); }
            Action::SetMode(mode.to_owned())
        }
        _ => {
            if extra("mode") { return Err("InvalidShape".into()); }
            Action::Configure(read_change(world, object.get("change").unwrap_or(&Value::Null))?)
        }
    };
    Ok(Spec { task_id, project_id, action })
}

// ---- The harness catalog ---------------------------------------------------------------------------------------------------

/// What the checks need of one harness: the catalog row the model picker reads.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ProviderView {
    pub id: String, pub installed: bool,
    /// `ready`, `signedOut` or `unavailable`; `None` for a harness that reports none.
    pub readiness: Option<String>,
    /// Model ids with the reasoning efforts each offers; an empty list means the catalog does not enumerate models.
    pub models: Vec<(String, Vec<String>)>,
    /// Modes the harness offers; empty means every mode.
    pub modes: Vec<String>,
    /// The harness has a `/compact` command or request.
    pub compacts: bool,
}

fn unavailable(provider: &ProviderView) -> Option<Refusal> {
    if !provider.installed { return Some(Refusal::new("HostUnavailable").with_ids(vec!["unavailable".into()])); }
    match provider.readiness.as_deref() {
        None | Some("ready") => None,
        Some("signedOut") => Some(Refusal::new("HostUnavailable").with_ids(vec!["signedOut".into()])),
        Some(_) => Some(Refusal::new("HostUnavailable").with_ids(vec!["unavailable".into()])),
    }
}

/// The harness, model and effort a `configure` lands on, checked against the catalog. `current` is the task's harness.
pub fn check_choice(catalog: &[ProviderView], current: &str, change: &Change) -> Result<(), Refusal> {
    let wanted = change.harness.as_deref().unwrap_or(current);
    let provider = catalog.iter().find(|provider| provider.id == wanted).ok_or_else(|| Refusal::at("NotFound", "harness"))?;
    if change.harness.is_some() || change.model.is_some() { if let Some(refusal) = unavailable(provider) { return Err(refusal); } }
    if let Some(model) = &change.model {
        if !provider.models.is_empty() && !provider.models.iter().any(|(id, _)| id == model) { return Err(Refusal::at("NotFound", "model")); }
    }
    if let Some(Some(effort)) = &change.effort {
        let model = change.model.clone();
        let offered = provider.models.iter().find(|(id, _)| model.as_deref().map_or(true, |model| model == id)).map(|(_, efforts)| efforts);
        if let (Some(offered), Some(_)) = (offered, &model) { if !offered.is_empty() && !offered.contains(effort) { return Err(Refusal::at("InvalidShape", "effort")); } }
    }
    Ok(())
}

/// A mode the task's harness offers.
pub fn check_mode(catalog: &[ProviderView], harness: &str, mode: &str) -> Result<(), Refusal> {
    let Some(provider) = catalog.iter().find(|provider| provider.id == harness) else { return Ok(()) };
    if !provider.modes.is_empty() && !provider.modes.iter().any(|offered| offered == mode) { return Err(Refusal::at("UnsupportedCapability", "mode")); }
    Ok(())
}

/// A compaction the task's harness can run: its own request or its compact command.
pub fn check_compact(catalog: &[ProviderView], harness: &str) -> Result<(), Refusal> {
    match catalog.iter().find(|provider| provider.id == harness) {
        Some(provider) if provider.compacts => Ok(()),
        Some(_) => Err(Refusal::at("UnsupportedCapability", "compact")),
        None => Err(Refusal::at("NotFound", "harness")),
    }
}

// ---- The native operations an action runs ------------------------------------------------------------------------------------

/// What the plan needs to know of the task.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TaskFacts { pub harness: String, pub model: String, pub team: bool, pub remote: bool }

/// One call of the interface's own command set, by the name and arguments the interface uses.
#[derive(Clone, Debug, PartialEq)]
pub struct Command { pub name: &'static str, pub args: Value }
impl Command { pub fn to_json(&self) -> Value { json!({"command": self.name, "args": self.args}) } }

/// The commands an action runs, in order: the same ones, with the same arguments, the interface runs for the same
/// choice (Stop button, mode and model pickers, effort picker, team menu, connection menu, bot menu, Run on, stage menu,
/// and a typed `/compact`). Pure, so a recording of the interface compares equal to it.
pub fn plan(spec: &Spec, facts: &TaskFacts) -> Vec<Command> {
    let id = &spec.task_id;
    match &spec.action {
        Action::Stop if facts.team && !facts.remote => vec![Command { name: "architect_control", args: json!({"sessionId": id, "action": "stop"}) }],
        Action::Stop => vec![Command { name: "stop_session", args: json!({"sessionId": id}) }],
        Action::SetMode(mode) => vec![Command { name: "update_session", args: json!({"sessionId": id, "mode": mode, "warm": true}) }],
        Action::Compact => vec![Command { name: "send_message", args: json!({"sessionId": id, "text": COMPACT_COMMAND}) }],
        Action::Configure(change) => {
            let mut commands = vec![];
            if let Some(model) = &change.model {
                let harness = change.harness.clone().unwrap_or_else(|| facts.harness.clone());
                commands.push(Command { name: "configure_session", args: json!({"sessionId": id, "provider": harness, "model": model, "projectId": null, "warm": true}) });
            }
            if let Some(effort) = &change.effort { commands.push(Command { name: "set_reasoning_effort", args: json!({"sessionId": id, "reasoningEffort": effort, "warm": true}) }); }
            // A team profile brings its own setup (the team menu passes the profile's config and architect); `null` removes the team.
            if let Some(team) = &change.team {
                let setup = team.as_ref().map_or(Value::Null, |profile| json!({"fromProfile": profile}));
                commands.push(Command { name: "architect_configure", args: json!({"sessionId": id, "config": setup, "architect": setup, "profileId": team}) });
            }
            if let Some(connection) = &change.connection { commands.push(Command { name: "connection_assign", args: json!({"sessionId": id, "connectionId": connection}) }); }
            if let Some(bot) = &change.bot { commands.push(Command { name: "bot_assign_task", args: json!({"sessionId": id, "botId": bot}) }); }
            if let Some(target) = &change.target { commands.push(Command { name: "run_on", args: json!({"sessionId": id, "target": target}) }); }
            if let Some(stage) = &change.stage { commands.push(Command { name: "set_task_stage", args: json!({"sessionId": id, "stage": stage}) }); }
            commands
        }
    }
}

/// Maps the text of a failed host operation to the frozen code. Nothing of the text reaches the package.
pub fn code_of(error: &str) -> &'static str {
    let lower = error.to_lowercase();
    if lower.contains("stop the agent") || lower.contains("start a conversation") || lower.contains("already running") || lower.contains("is running") { "Conflict" }
    else if lower.contains("not available") && lower.contains("compact") { "UnsupportedCapability" }
    else { super::runtime_tasks_start::code_of(error) }
}

// ---- Attribution ---------------------------------------------------------------------------------------------------------

/// One control a package made: who, on which task, what, and when.
#[derive(Clone, Debug, PartialEq)]
pub struct Entry { pub task_id: String, pub action: String, pub detail: Value, pub owner: String, pub package: String, pub at: u64 }
impl Entry {
    pub fn to_json(&self) -> Value { json!({"taskId": self.task_id, "action": self.action, "detail": self.detail, "owner": self.owner, "package": self.package, "at": self.at}) }
}

#[derive(Default)]
struct Ledger { entries: VecDeque<Entry>, revision: u64 }

/// Every control a package made, newest last, bounded. The thread, the sidebar and the history read it.
#[derive(Default)]
pub struct ControlLog { inner: Mutex<Ledger> }
impl ControlLog {
    pub fn record(&self, entry: Entry) -> Result<u64, &'static str> {
        let mut ledger = self.inner.lock().map_err(|_| "HostUnavailable")?;
        ledger.entries.push_back(entry);
        while ledger.entries.len() > MAX_LOG { ledger.entries.pop_front(); }
        ledger.revision += 1;
        Ok(ledger.revision)
    }
    pub fn forget(&self, task_id: &str) -> bool {
        let Ok(mut ledger) = self.inner.lock() else { return false };
        let before = ledger.entries.len();
        ledger.entries.retain(|entry| entry.task_id != task_id);
        if ledger.entries.len() == before { return false; }
        ledger.revision += 1;
        true
    }
    pub fn for_task(&self, task_id: &str) -> Vec<Entry> { self.inner.lock().map_or_else(|_| vec![], |ledger| ledger.entries.iter().filter(|entry| entry.task_id == task_id).cloned().collect()) }
    pub fn revision(&self) -> u64 { self.inner.lock().map_or(0, |ledger| ledger.revision) }
    pub fn len(&self) -> usize { self.inner.lock().map_or(0, |ledger| ledger.entries.len()) }
    pub fn is_empty(&self) -> bool { self.len() == 0 }
    /// What the interface reads: the latest control per task, and the revision that changes with every record.
    pub fn snapshot(&self) -> Value {
        let Ok(ledger) = self.inner.lock() else { return json!({"revision": 0, "controls": {}}) };
        let mut latest: BTreeMap<&str, &Entry> = BTreeMap::new();
        for entry in &ledger.entries { latest.insert(&entry.task_id, entry); }
        let controls: Map<String, Value> = latest.into_iter().map(|(id, entry)| (id.to_owned(), json!({"action": entry.action, "detail": entry.detail, "owner": entry.owner, "package": entry.package, "at": entry.at}))).collect();
        json!({"revision": ledger.revision, "controls": controls})
    }
}

/// Stops a package asked for and the run has not yet reported: the run's end reads it for `task.stopped` (`by`).
static STOPPERS: Mutex<BTreeMap<String, (String, u64)>> = Mutex::new(BTreeMap::new());
fn mark_stopper(task: &str, owner: &str) { if let Ok(mut stoppers) = STOPPERS.lock() { if stoppers.len() > 256 { stoppers.clear(); } stoppers.insert(task.to_owned(), (owner.to_owned(), super::runtime_notifications::now_millis())); } }
fn unmark_stopper(task: &str) { if let Ok(mut stoppers) = STOPPERS.lock() { stoppers.remove(task); } }
/// The `by` of a `task.stopped` event: the package that stopped the run a moment ago, or the user.
pub fn take_stopper(task: &str) -> Value {
    let found = STOPPERS.lock().ok().and_then(|mut stoppers| stoppers.remove(task));
    match found { Some((owner, at)) if super::runtime_notifications::now_millis().saturating_sub(at) <= STOP_LABEL_MS => json!({"package": owner}), _ => json!("user") }
}

// ---- The app -------------------------------------------------------------------------------------------------------------

pub fn log(app: &tauri::AppHandle) -> Option<tauri::State<'_, ControlLog>> { use tauri::Manager; app.try_state::<ControlLog>() }
fn log_changed(app: &tauri::AppHandle) { use tauri::Emitter; let _ = app.emit("extensions-runtime-task-controls", log(app).map_or(0, |ledger| ledger.revision())); }

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

/// The package holds the permission for some project (any scope that is not an empty list).
fn holds_any(app: &tauri::AppHandle, owner: &str, version: &str) -> bool {
    use tauri::Manager;
    let Some(grants) = app.try_state::<super::runtime_grants::RuntimeGrants>() else { return false };
    let projection = grants.projection();
    projection["packages"].as_array().into_iter().flatten().any(|package| {
        package["id"] == owner && package["version"] == version && package["authorized"] == true
            && package["grants"].as_array().into_iter().flatten().any(|grant| grant["permission"] == PERMISSION && grant["scope"]["projects"].as_array().map_or(true, |projects| !projects.is_empty()))
    })
}

fn view_of(info: &crate::providers::ProviderInfo) -> ProviderView {
    let metadata = info.metadata.clone().unwrap_or(Value::Null);
    ProviderView {
        id: info.id.clone(), installed: info.installed,
        readiness: metadata["readiness"]["state"].as_str().map(str::to_owned),
        models: info.models.iter().map(|model| (model.id.clone(), model.reasoning_efforts.iter().map(|effort| effort.id.clone()).collect())).collect(),
        modes: metadata["modes"].as_array().into_iter().flatten().filter_map(|mode| mode.as_str().or_else(|| mode["id"].as_str()).map(str::to_owned)).collect(),
        // An installed harness may take `/compact`; whether it answers it is decided by its command catalog when the request runs.
        compacts: info.installed,
    }
}

fn facts_of(state: &crate::AppState, task: &str) -> Result<TaskFacts, Refusal> {
    let store = state.store.lock().map_err(|_| Refusal::new("HostUnavailable"))?;
    let session = store.session(task).map_err(|_| Refusal::new("NotFound"))?;
    let team = crate::architect::load(&store, task).ok().flatten().is_some();
    Ok(TaskFacts { harness: session.provider, model: session.model, team, remote: session.remote_device.is_some() })
}

fn running(state: &crate::AppState, task: &str) -> bool { crate::run_requests::lock_agents(&state.agents).map_or(true, |agents| agents.contains_key(task)) }

/// Serves `tasksControl` of the service of `request.owner`.
pub async fn serve(app: tauri::AppHandle, request: super::runtime_service_lifetime::DispatchRequest) -> Value {
    use tauri::Manager;
    let owner = request.owner.clone();
    if log(&app).is_none() { return Refusal::new("UnsupportedCapability").envelope(); }
    let found = { let app = app.clone(); let owner = owner.clone(); tauri::async_runtime::spawn_blocking(move || package(&app, &owner)).await.unwrap_or(Err("HostUnavailable")) };
    let (version, name) = match found { Ok(found) => found, Err(code) => return if code == "PermissionDenied" { Refusal::denied().envelope() } else { Refusal::new(code).envelope() } };
    // Admission: the grant (narrowing included), the task and the paired machine. Nothing has changed yet.
    let paired: Vec<String> = if request.params["change"]["target"].is_string() { crate::remote::remote_targets(app.clone()).await.iter().filter_map(|row| row["deviceId"].as_str().map(str::to_owned)).collect() } else { vec![] };
    let spec = {
        let task_project = |id: &str| app.try_state::<crate::AppState>().and_then(|state| state.store.lock().ok().and_then(|store| store.session(id).ok().map(|session| session.project_id)));
        let world = World { task_project: &task_project, granted: &|project: &str| granted(&app, &owner, &version, project), holds_any: &|| holds_any(&app, &owner, &version), target_paired: &|target| paired.iter().any(|device| device == target) };
        match admit(&world, &request.params) { Ok(spec) => spec, Err(refusal) => return refusal.envelope() }
    };
    let state = app.state::<crate::AppState>();
    let facts = match facts_of(&state, &spec.task_id) { Ok(facts) => facts, Err(refusal) => return refusal.envelope() };
    let catalog: Vec<ProviderView> = if facts.remote { vec![] } else { crate::local_providers(false).await.iter().map(view_of).collect() };
    if !facts.remote {
        let checked = match &spec.action {
            Action::Configure(change) => check_choice(&catalog, &facts.harness, change),
            Action::SetMode(mode) => check_mode(&catalog, &facts.harness, mode),
            Action::Compact => check_compact(&catalog, &facts.harness),
            Action::Stop => Ok(()),
        };
        if let Err(refusal) = checked { return refusal.envelope(); }
    }
    // The permission is read again just before anything changes: a revoke or a narrowing in between changes nothing.
    if !granted(&app, &owner, &version, &spec.project_id) || package(&app, &owner).is_err() { return Refusal::denied().envelope(); }
    match apply(&app, &owner, &spec, &facts).await {
        // Stopping an idle task changes nothing, so nothing is recorded.
        Ok(detail) if detail["stopped"] == false => ok(Value::Null),
        Ok(detail) => {
            let entry = Entry { task_id: spec.task_id.clone(), action: spec.action.name().to_owned(), detail, owner: owner.clone(), package: name, at: super::runtime_notifications::now_millis() };
            if let Some(ledger) = log(&app) { let _ = ledger.record(entry); }
            log_changed(&app);
            ok(Value::Null)
        }
        Err(refusal) => refusal.envelope(),
    }
}

/// A failed command as the frozen refusal: a code the host already uses passes through, any other text is mapped. `ids`
/// names the commands of the plan that had already run.
fn refusal_of(error: &str, done: &[String]) -> Refusal {
    let code = match error { "PermissionDenied" | "NotFound" | "Conflict" | "UnsupportedCapability" | "HostUnavailable" | "Timeout" | "Revoked" | "LimitExceeded" => error, other => code_of(other) };
    Refusal::new(code).with_ids(done.to_vec())
}

/// Runs the plan of an action through the host's own operations. A failure names, in `ids`, the commands that already ran.
async fn apply(app: &tauri::AppHandle, owner: &str, spec: &Spec, facts: &TaskFacts) -> Result<Value, Refusal> {
    use tauri::{Emitter, Manager};
    let state = app.state::<crate::AppState>();
    let id = spec.task_id.clone();
    let commands = plan(spec, facts);
    let mut done: Vec<String> = vec![];
    for command in &commands {
        let outcome: Result<(), String> = match (command.name, &spec.action) {
            ("stop_session", _) | ("architect_control", _) => {
                // Stop is for a run: an idle local task has nothing to stop (and is left exactly as it is).
                let live = running(&state, &id) || facts.remote || facts.team || state.store.lock().map(|store| store.session(&id).ok().is_some_and(|session| session.cloud.is_some())).unwrap_or(false);
                if !live { return Ok(json!({"stopped": false})); }
                mark_stopper(&id, owner);
                let result = if command.name == "architect_control" { crate::architect::architect_control(app.clone(), app.state::<crate::AppState>(), id.clone(), "stop".into()).await.map(|_| ()) } else { crate::stop_session(app.clone(), app.state::<crate::AppState>(), id.clone()).await };
                if result.is_err() { unmark_stopper(&id); }
                result
            }
            ("update_session", Action::SetMode(mode)) => crate::warm_launch::update_session(app.clone(), app.state::<crate::AppState>(), id.clone(), None, None, None, Some(mode.clone()), Some(true)).await,
            ("configure_session", Action::Configure(change)) => {
                let harness = change.harness.clone().unwrap_or_else(|| facts.harness.clone());
                crate::warm_launch::configure_session(app.clone(), app.state::<crate::AppState>(), id.clone(), harness, change.model.clone().unwrap_or_else(|| facts.model.clone()), None, Some(true)).await.map(|_| ())
            }
            ("set_reasoning_effort", Action::Configure(change)) => crate::warm_launch::set_reasoning_effort(app.clone(), app.state::<crate::AppState>(), id.clone(), change.effort.clone().flatten(), Some(true)).await.map(|_| ()),
            ("architect_configure", Action::Configure(change)) => {
                let team = change.team.clone().flatten();
                let (config, architect) = match &team {
                    None => (None, None),
                    Some(profile) => match state.store.lock().map_err(|e| e.to_string()).and_then(|store| crate::architect::profiles::read(&store)) {
                        Ok(library) => match library.profiles.into_iter().find(|entry| &entry.id == profile) { Some(found) => (Some(found.setup.config), Some(found.setup.architect)), None => return Err(refusal_of("NotFound", &done)) },
                        Err(error) => return Err(refusal_of(&error, &done)),
                    },
                };
                crate::architect::architect_configure(app.clone(), app.state::<crate::AppState>(), id.clone(), config, architect, team).await.map(|_| ())
            }
            ("connection_assign", Action::Configure(change)) => crate::connections::connection_assign(app.state::<crate::AppState>(), id.clone(), change.connection.clone().flatten()).await.map(|_| ()),
            ("bot_assign_task", Action::Configure(change)) => {
                let result = state.store.lock().map_err(|e| e.to_string()).and_then(|store| crate::bots::assign_task(&store, &id, change.bot.clone().flatten().as_deref()).map(|_| ()));
                if result.is_ok() { let _ = app.emit("bots-changed", ()); let _ = app.emit("sessions-changed", ()); }
                result
            }
            ("set_task_stage", Action::Configure(change)) => {
                // A reopened task leaves the archive, as the stage menu does before it changes the stage.
                let stage = change.stage.clone().unwrap_or_default();
                let archived = state.store.lock().ok().and_then(|store| store.session(&id).ok()).is_some_and(|session| session.archived);
                if stage != "completed" && archived { let _ = crate::warm_launch::update_session(app.clone(), app.state::<crate::AppState>(), id.clone(), None, Some(false), None, None, None).await; }
                crate::set_task_stage(app.clone(), app.state::<crate::AppState>(), id.clone(), stage).await.map(|_| ())
            }
            ("run_on", Action::Configure(change)) => run_on(app, owner, &id, change.target.as_deref().unwrap_or(LOCAL)).await,
            ("send_message", Action::Compact) => compact(app, &id, facts).await,
            _ => Err("Unsupported control.".to_owned()),
        };
        match outcome { Ok(()) => done.push(command.name.to_owned()), Err(error) => return Err(refusal_of(&error, &done)) }
    }
    let _ = app.emit("sessions-changed", ());
    Ok(json!({"commands": done}))
}

/// Compaction: the harness's own command, sent as the composer sends it, on an idle task whose harness answers it. The
/// `task.compacted` event is the host's record of the finished step (`runtime_workspace_events::observe_tool`).
async fn compact(app: &tauri::AppHandle, task: &str, facts: &TaskFacts) -> Result<(), String> {
    use tauri::Manager;
    let state = app.state::<crate::AppState>();
    if running(&state, task) { return Err("Stop the agent before compacting its context.".into()); }
    if !facts.remote {
        let cwd = { let store = state.store.lock().map_err(|e| e.to_string())?; let project = store.session(task)?.project_id; store.workspace_root(&project, Some(task))? };
        match crate::slash_commands::resolve(&facts.harness, &cwd, COMPACT_COMMAND).await {
            Ok(resolution) if resolution.maintenance && resolution.action.is_none() => {}
            Ok(_) => return Err("UnsupportedCapability".into()),
            Err(error) if error.to_lowercase().contains("unknown command") || error.contains("extension-native") => return Err("UnsupportedCapability".into()),
            Err(error) => return Err(error),
        }
    }
    crate::send_prompt(app.clone(), app.state::<crate::AppState>(), task.to_owned(), COMPACT_COMMAND.to_owned(), None).await
}

/// The Run on choice of a new conversation lives in the window: it applies it and answers whether it could.
async fn run_on(app: &tauri::AppHandle, owner: &str, task: &str, target: &str) -> Result<(), String> {
    use tauri::Emitter;
    if crate::headless::active() { return Err("UnsupportedCapability".into()); }
    let Some(slots) = super::runtime_tasks_start::state(app) else { return Err("UnsupportedCapability".into()) };
    let (id, receiver) = slots.begin(owner).map_err(str::to_owned)?;
    struct Guard { app: tauri::AppHandle, id: String }
    impl Drop for Guard { fn drop(&mut self) { if let Some(slots) = super::runtime_tasks_start::state(&self.app) { slots.forget(&self.id); } } }
    let _guard = Guard { app: app.clone(), id: id.clone() };
    let _ = app.emit("extensions-runtime-task-target", json!({"id": id, "owner": owner, "taskId": task, "target": target}));
    let answer = match tokio::time::timeout(super::runtime_tasks_start::DEFAULTS_WAIT, receiver).await { Ok(Ok(answer)) => answer, Ok(Err(_)) => return Err("Revoked".into()), Err(_) => return Err("Timeout".into()) };
    if answer["ok"] == true { return Ok(()); }
    Err(match answer["code"].as_str() { Some("NotFound") => "NotFound", Some("Conflict") => "Conflict", Some("Revoked") => "Revoked", _ => "HostUnavailable" }.to_owned())
}

/// The interface reads which package last controlled each task (sidebar, thread header, history).
#[tauri::command]
pub fn extensions_runtime_task_controls(app: tauri::AppHandle) -> Value { log(&app).map_or_else(|| json!({"revision": 0, "controls": {}}), |ledger| ledger.snapshot()) }
/// A deleted task loses its control records.
pub fn task_removed(app: &tauri::AppHandle, task: &str) { if log(app).is_some_and(|ledger| ledger.forget(task)) { log_changed(app); } }

#[cfg(test)]
mod tests {
    use super::*;
    const OWNER: &str = "sample.runtime-tasks-control";

    struct Fixture { tasks: Vec<(&'static str, &'static str)>, allowed: Vec<&'static str>, paired: Vec<&'static str> }
    impl Fixture {
        fn admit(&self, raw: Value) -> Result<Spec, Refusal> {
            let task_project = |id: &str| self.tasks.iter().find(|(task, _)| *task == id).map(|(_, project)| (*project).to_owned());
            let granted = |project: &str| self.allowed.contains(&project);
            let holds_any = || !self.allowed.is_empty();
            let paired = |target: &str| self.paired.contains(&target);
            admit(&World { task_project: &task_project, granted: &granted, holds_any: &holds_any, target_paired: &paired }, &raw)
        }
    }
    fn make_fixture() -> Fixture { Fixture { tasks: vec![("t1", "A"), ("t2", "B")], allowed: vec!["A"], paired: vec!["studio"] } }
    fn code(result: Result<Spec, Refusal>) -> String { result.unwrap_err().code }

    #[test]
    fn each_action_reads_its_shape_and_belongs_to_the_task_project() {
        let fixture = make_fixture();
        assert_eq!(fixture.admit(json!({"action": "stop", "taskId": "t1"})).unwrap(), Spec { task_id: "t1".into(), project_id: "A".into(), action: Action::Stop });
        assert_eq!(fixture.admit(json!({"action": "compact", "taskId": "t1"})).unwrap().action, Action::Compact);
        assert_eq!(fixture.admit(json!({"action": "setMode", "taskId": "t1", "mode": "plan"})).unwrap().action, Action::SetMode("plan".into()));
        let full = fixture.admit(json!({"action": "configure", "taskId": "t1", "change": {"harness": "codex", "model": "m", "effort": "high", "team": null, "connection": "c1", "bot": "b1", "target": "studio", "stage": "completed"}})).unwrap();
        assert_eq!(full.action, Action::Configure(Change { harness: Some("codex".into()), model: Some("m".into()), effort: Some(Some("high".into())), team: Some(None), connection: Some(Some("c1".into())), bot: Some(Some("b1".into())), target: Some("studio".into()), stage: Some("completed".into()) }));
        assert_eq!(fixture.admit(json!({"action": "configure", "taskId": "t1", "change": {"target": "local"}})).unwrap().action, Action::Configure(Change { target: Some("local".into()), ..Change::default() }));
    }

    #[test]
    fn no_grant_a_narrowed_project_or_an_unrelated_package_is_permission_denied_naming_the_permission() {
        let fixture = make_fixture();
        let refusal = fixture.admit(json!({"action": "stop", "taskId": "t2"})).unwrap_err();
        assert_eq!((refusal.code.as_str(), refusal.path.as_str()), ("PermissionDenied", "tasks.control"));
        let none = Fixture { allowed: vec![], ..make_fixture() };
        for task in ["t1", "t2", "ghost"] { assert_eq!(code(none.admit(json!({"action": "stop", "taskId": task}))), "PermissionDenied", "{task}"); }
        // A package that holds the permission for some project may learn a task does not exist; one that holds none may not.
        assert_eq!(code(fixture.admit(json!({"action": "stop", "taskId": "ghost"}))), "NotFound");
    }

    #[test]
    fn shapes_are_refused_with_their_reason_and_the_hook_cannot_change_the_mode() {
        let fixture = make_fixture();
        for (raw, expected) in [
            (json!("text"), "InvalidShape"), (json!({"action": "stop"}), "InvalidShape"), (json!({"taskId": "t1"}), "InvalidShape"), (json!({"action": "council", "taskId": "t1"}), "InvalidShape"),
            (json!({"action": "worker", "taskId": "t1"}), "InvalidShape"), (json!({"action": "limit", "taskId": "t1"}), "InvalidShape"),
            (json!({"action": "stop", "taskId": "t1", "mode": "plan"}), "InvalidShape"), (json!({"action": "compact", "taskId": "t1", "change": {}}), "InvalidShape"), (json!({"action": "stop", "taskId": "t1", "extra": 1}), "InvalidShape"),
            (json!({"action": "setMode", "taskId": "t1"}), "InvalidShape"), (json!({"action": "setMode", "taskId": "t1", "mode": "yolo"}), "InvalidShape"), (json!({"action": "setMode", "taskId": "t1", "mode": "plan", "change": {}}), "InvalidShape"),
            (json!({"action": "configure", "taskId": "t1"}), "InvalidShape"), (json!({"action": "configure", "taskId": "t1", "change": {}}), "InvalidShape"), (json!({"action": "configure", "taskId": "t1", "change": {"mode": "plan"}}), "InvalidShape"),
            (json!({"action": "configure", "taskId": "t1", "change": {"council": "accept"}}), "InvalidShape"), (json!({"action": "configure", "taskId": "t1", "change": {"harness": "codex"}}), "InvalidShape"),
            (json!({"action": "configure", "taskId": "t1", "change": {"model": null}}), "InvalidShape"), (json!({"action": "configure", "taskId": "t1", "change": {"stage": "archived"}}), "InvalidShape"),
            (json!({"action": "configure", "taskId": "t1", "change": {"stage": null}}), "InvalidShape"), (json!({"action": "configure", "taskId": "t1", "change": {"effort": 3}}), "InvalidShape"),
            (json!({"action": "configure", "taskId": "t1", "change": {"target": "stranger"}}), "NotFound"), (json!({"action": "stop", "taskId": "t1", "source": "other"}), "InvalidShape"),
        ] { assert_eq!(code(fixture.admit(raw.clone())), expected, "{raw}"); }
        let refusal = fixture.admit(json!({"action": "setMode", "taskId": "t1", "mode": "full", "source": "hook"})).unwrap_err();
        assert_eq!((refusal.code.as_str(), refusal.path.as_str(), refusal.ids), ("PermissionDenied", "setMode", vec!["hook".to_owned()]));
        // A hook may still stop or compact through its package's grant: only the mode is kept out of a hook's hands.
        assert!(fixture.admit(json!({"action": "stop", "taskId": "t1", "source": "hook"})).is_ok());
    }

    fn catalog() -> Vec<ProviderView> {
        vec![
            ProviderView { id: "claude".into(), installed: true, readiness: Some("ready".into()), models: vec![("sonnet".into(), vec!["low".into(), "high".into()]), ("haiku".into(), vec![])], modes: vec!["ask".into(), "plan".into()], compacts: true },
            ProviderView { id: "codex".into(), installed: true, readiness: Some("signedOut".into()), models: vec![("gpt".into(), vec![])], modes: vec![], compacts: true },
            ProviderView { id: "kimi".into(), installed: false, readiness: None, models: vec![], modes: vec![], compacts: false },
            ProviderView { id: "plain".into(), installed: true, readiness: None, models: vec![], modes: vec![], compacts: false },
        ]
    }

    #[test]
    fn the_catalog_decides_harness_model_effort_mode_and_compaction() {
        let catalog = catalog();
        let change = |harness: Option<&str>, model: Option<&str>, effort: Option<&str>| Change { harness: harness.map(str::to_owned), model: model.map(str::to_owned), effort: effort.map(|effort| Some(effort.to_owned())), ..Change::default() };
        assert!(check_choice(&catalog, "claude", &change(None, Some("haiku"), None)).is_ok());
        assert_eq!(check_choice(&catalog, "claude", &change(Some("ghost"), Some("m"), None)).unwrap_err().code, "NotFound");
        assert_eq!(check_choice(&catalog, "claude", &change(None, Some("opus"), None)).unwrap_err().path, "model");
        let signed_out = check_choice(&catalog, "claude", &change(Some("codex"), Some("gpt"), None)).unwrap_err();
        assert_eq!((signed_out.code.as_str(), signed_out.ids), ("HostUnavailable", vec!["signedOut".to_owned()]));
        assert_eq!(check_choice(&catalog, "claude", &change(Some("kimi"), Some("m"), None)).unwrap_err().ids, vec!["unavailable".to_owned()]);
        assert_eq!(check_choice(&catalog, "claude", &change(None, Some("sonnet"), Some("max"))).unwrap_err().path, "effort");
        assert!(check_choice(&catalog, "claude", &change(None, Some("sonnet"), Some("high"))).is_ok());
        assert!(check_mode(&catalog, "claude", "plan").is_ok());
        assert_eq!(check_mode(&catalog, "claude", "full").unwrap_err().code, "UnsupportedCapability");
        assert!(check_mode(&catalog, "codex", "full").is_ok());
        assert!(check_compact(&catalog, "claude").is_ok());
        assert_eq!(check_compact(&catalog, "plain").unwrap_err().code, "UnsupportedCapability");
        assert_eq!(check_compact(&catalog, "ghost").unwrap_err().code, "NotFound");
    }

    #[test]
    fn an_action_runs_the_commands_the_interface_runs_for_the_same_choice() {
        let facts = TaskFacts { harness: "claude".into(), model: "sonnet".into(), team: false, remote: false };
        let spec = |action| Spec { task_id: "t1".into(), project_id: "A".into(), action };
        let names = |action, facts: &TaskFacts| plan(&spec(action), facts).iter().map(|command| command.name).collect::<Vec<_>>();
        assert_eq!(names(Action::Stop, &facts), ["stop_session"]);
        assert_eq!(names(Action::Stop, &TaskFacts { team: true, ..facts.clone() }), ["architect_control"]);
        assert_eq!(names(Action::Stop, &TaskFacts { team: true, remote: true, ..facts.clone() }), ["stop_session"]);
        assert_eq!(plan(&spec(Action::SetMode("plan".into())), &facts)[0].args, json!({"sessionId": "t1", "mode": "plan", "warm": true}));
        assert_eq!(plan(&spec(Action::Compact), &facts)[0].args, json!({"sessionId": "t1", "text": "/compact"}));
        let change = Change { harness: Some("codex".into()), model: Some("gpt".into()), effort: Some(None), team: Some(Some("p1".into())), connection: Some(None), bot: Some(Some("b1".into())), target: Some("local".into()), stage: Some("active".into()), ..Change::default() };
        assert_eq!(names(Action::Configure(change.clone()), &facts), ["configure_session", "set_reasoning_effort", "architect_configure", "connection_assign", "bot_assign_task", "run_on", "set_task_stage"]);
        assert_eq!(plan(&spec(Action::Configure(change)), &facts)[0].args, json!({"sessionId": "t1", "provider": "codex", "model": "gpt", "projectId": null, "warm": true}));
        // A model alone keeps the task's own harness.
        assert_eq!(plan(&spec(Action::Configure(Change { model: Some("haiku".into()), ..Change::default() })), &facts)[0].args["provider"], "claude");
    }

    #[test]
    fn the_parity_recording_of_the_interface_equals_the_plan_of_every_action() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/extensions/runtime-tasks-control/parity.json");
        let recording: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let cases = recording["cases"].as_array().unwrap();
        assert!(cases.len() >= 15);
        let task_project = |id: &str| (id == "t1").then(|| "A".to_owned());
        let granted = |_: &str| true;
        let holds_any = || true;
        let paired = |target: &str| target == "studio";
        for case in cases {
            let spec = admit(&World { task_project: &task_project, granted: &granted, holds_any: &holds_any, target_paired: &paired }, &case["request"]).unwrap();
            let facts = TaskFacts { harness: case["task"]["harness"].as_str().unwrap().into(), model: case["task"]["model"].as_str().unwrap().into(), team: case["task"]["team"] == true, remote: case["task"]["remote"] == true };
            let planned: Vec<Value> = plan(&spec, &facts).iter().map(Command::to_json).collect();
            assert_eq!(Value::Array(planned), case["commands"], "{}", case["name"]);
        }
    }

    #[test]
    fn host_failures_map_to_frozen_codes_without_their_text() {
        for (text, expected) in [("Stop the agent before changing its connection.", "Conflict"), ("Start a conversation before compacting its context.", "Conflict"), ("Unknown permission mode.", "InvalidShape"), ("Unknown task.", "NotFound"), ("disk on fire", "HostUnavailable")] { assert_eq!(code_of(text), expected, "{text}"); }
    }

    #[test]
    fn controls_are_recorded_with_their_package_bounded_and_forgotten_with_the_task() {
        let ledger = ControlLog::default();
        let entry = |task: &str, action: &str, at: u64| Entry { task_id: task.into(), action: action.into(), detail: json!({"commands": [action]}), owner: OWNER.into(), package: "Controller".into(), at };
        ledger.record(entry("t1", "stop", 1)).unwrap();
        ledger.record(entry("t1", "setMode", 2)).unwrap();
        ledger.record(entry("t2", "compact", 3)).unwrap();
        assert_eq!((ledger.len(), ledger.revision(), ledger.for_task("t1").len()), (3, 3, 2));
        let snapshot = ledger.snapshot();
        assert_eq!((snapshot["controls"]["t1"]["action"].as_str(), snapshot["controls"]["t1"]["package"].as_str(), snapshot["controls"]["t2"]["owner"].as_str()), (Some("setMode"), Some("Controller"), Some(OWNER)));
        assert!(ledger.forget("t1") && !ledger.forget("t1"));
        assert_eq!(ledger.len(), 1);
        let many = ControlLog::default();
        for index in 0..MAX_LOG + 5 { many.record(entry("t", "stop", index as u64)).unwrap(); }
        assert_eq!(many.len(), MAX_LOG);
    }

    #[test]
    fn a_stop_by_a_package_labels_the_next_task_stopped_event_once() {
        mark_stopper("stopped-task", OWNER);
        assert_eq!(take_stopper("stopped-task"), json!({"package": OWNER}));
        assert_eq!(take_stopper("stopped-task"), json!("user"));
        mark_stopper("failed-stop", OWNER);
        unmark_stopper("failed-stop");
        assert_eq!(take_stopper("failed-stop"), json!("user"));
    }
}
