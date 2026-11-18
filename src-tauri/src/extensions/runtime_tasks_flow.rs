//! Councils, workers and usage-limit pauses for background services (`tasks.control`, runtime phase R4, slice R0404B).
//!
//! A trusted service decides a Council with `panda.tasks.council` (`accept`, `dismiss`, `keepFixing`), steers one worker of a
//! team with `panda.tasks.worker` (`retry`, `resume`, `skip`, `stop`) and answers a usage-limit pause with
//! `panda.tasks.limit` (`continue`, `resume`, `dismiss`). Each call is a thin adapter over the operation the interface runs
//! for the same choice, and is labelled with the package's name in the control ledger of R0404:
//! - `accept`: `architect_council_accept` (the strip's "Accept and finish");
//! - `keepFixing`: the follow-up to the lead the strip's "Keep fixing" sends, and `dismiss`: the strip's close button. Both
//!   belong to the main window (the queue and the per-cycle dismissal live there), which answers each round;
//! - `worker`: `architect_worker_control` (see `runtime_tasks_flow_workers.rs`) for stop and skip, and for retry and resume of
//!   a worker of a running team; the team's own Resume (`architect_control`) when the team is paused, failed or interrupted;
//! - `limit`: `continue` is the banner's Continue (the window sends the follow-up, on another connection when `connection`
//!   names one), `resume` the "Resume at reset" switch (`set_resume_at_reset`), `dismiss` the banner's dismissal
//!   (`clear_usage_limit`).
//!
//! [`plan`] is that mapping as plain data, so a recording of the interface's own calls compares equal to what an action runs.
//!
//! The permission is `tasks.control`, project scoped (the task's project), checked on every request and again just before
//! anything changes, so a revoke or a narrowing in between changes nothing and revocation never touches another task. A
//! package that holds it is never asked per action (ADR-0005): none of these six operations is an irreversible deletion, and
//! the interface asks no confirmation for any of them, so no host confirmation stands between the call and the operation.
//! The refusals are the frozen ones (see `runtime_tasks_control.rs`); those that remain are for predictability and fault
//! isolation: a task that is not in the state the interface requires for the same button (no team, a worker that is not
//! failed, a pause that is not a limit) answers `Conflict`, and a worker or connection that does not exist `NotFound`.
use serde_json::{json, Map, Value};

use super::runtime_tasks_control::{log, Entry, Refusal};

/// The named permission (project scoped, granted with the trust decision, rechecked on every request).
pub const PERMISSION: &str = super::runtime_tasks_control::PERMISSION;
pub const ACTIONS: [&str; 3] = ["council", "worker", "limit"];
pub const DECISIONS: [&str; 3] = ["accept", "dismiss", "keepFixing"];
pub const WORKER_OPS: [&str; 4] = ["retry", "resume", "skip", "stop"];
pub const LIMIT_OPS: [&str; 3] = ["continue", "resume", "dismiss"];
/// The text the strip's Keep fixing sends to the lead, and the banner's Continue to the task.
pub const KEEP_FIXING_TEXT: &str = "Keep fixing until every reviewer reaches the target.";
pub const CONTINUE_TEXT: &str = "Continue where you left off.";
/// The window's event for a round only it can run, and the slot answer command it reuses (`runtime_tasks_start`).
pub const FLOW_EVENT: &str = "extensions-runtime-task-flow";
const KEYS: [&str; 7] = ["action", "taskId", "decision", "workerId", "op", "options", "source"];
const OPTION_KEYS: [&str; 2] = ["connection", "harness"];

fn ident(text: &str) -> bool { !text.is_empty() && text.chars().count() <= 128 && !text.chars().any(char::is_control) }
fn ok(value: Value) -> Value { json!({"ok": true, "value": value}) }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision { Accept, Dismiss, KeepFixing }
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WorkerOp { Retry, Resume, Skip, Stop }
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LimitOp { Continue, Resume, Dismiss }

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Action {
    Council(Decision),
    Worker { id: String, op: WorkerOp },
    /// `connection` is the id of another connection of the task's harness to continue on; `harness` must be the task's own.
    Limit { op: LimitOp, connection: Option<String>, harness: Option<String> },
}
impl Action {
    pub fn name(&self) -> &'static str { match self { Action::Council(_) => "council", Action::Worker { .. } => "worker", Action::Limit { .. } => "limit" } }
    /// What the ledger keeps of the call: the choice, never a prompt text.
    pub fn detail(&self) -> Value {
        match self {
            Action::Council(decision) => json!({"decision": decision.name()}),
            Action::Worker { id, op } => json!({"workerId": id, "op": op.name()}),
            Action::Limit { op, connection, .. } => json!({"op": op.name(), "connection": connection}),
        }
    }
}
impl Decision { pub fn name(self) -> &'static str { match self { Decision::Accept => "accept", Decision::Dismiss => "dismiss", Decision::KeepFixing => "keepFixing" } } }
impl WorkerOp { pub fn name(self) -> &'static str { match self { WorkerOp::Retry => "retry", WorkerOp::Resume => "resume", WorkerOp::Skip => "skip", WorkerOp::Stop => "stop" } } }
impl LimitOp { pub fn name(self) -> &'static str { match self { LimitOp::Continue => "continue", LimitOp::Resume => "resume", LimitOp::Dismiss => "dismiss" } } }

/// A validated request: the task, the project it belongs to and what to do.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Spec { pub task_id: String, pub project_id: String, pub action: Action }

/// What the app answers about the world; tests give fixed answers.
pub struct World<'a> {
    pub task_project: &'a dyn Fn(&str) -> Option<String>,
    pub granted: &'a dyn Fn(&str) -> bool,
    pub holds_any: &'a dyn Fn() -> bool,
}

fn text_of(object: &Map<String, Value>, key: &str) -> Result<Option<String>, Refusal> {
    match object.get(key) { None => Ok(None), Some(Value::String(text)) if ident(text) => Ok(Some(text.clone())), Some(_) => Err(Refusal::at("InvalidShape", key)) }
}

/// Reads a request and checks it against the world, in the order the refusals are frozen: the shape of the task id and the
/// action name, the permission (the task's project), then the rest of the shape.
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
    if !matches!(object.get("source").and_then(Value::as_str), None | Some("service") | Some("hook")) { return Err("InvalidShape".into()); }
    let extra = |keys: &[&str]| keys.iter().any(|key| object.contains_key(*key));
    let action = match name {
        "council" => {
            if extra(&["workerId", "op", "options"]) { return Err("InvalidShape".into()); }
            let decision = match object.get("decision").and_then(Value::as_str).filter(|decision| DECISIONS.contains(decision)) {
                Some("accept") => Decision::Accept, Some("dismiss") => Decision::Dismiss, Some(_) => Decision::KeepFixing,
                None => return Err(Refusal::at("InvalidShape", "decision")),
            };
            Action::Council(decision)
        }
        "worker" => {
            if extra(&["decision", "options"]) { return Err("InvalidShape".into()); }
            let id = text_of(object, "workerId")?.ok_or_else(|| Refusal::at("InvalidShape", "workerId"))?;
            let op = match object.get("op").and_then(Value::as_str).filter(|op| WORKER_OPS.contains(op)) {
                Some("retry") => WorkerOp::Retry, Some("resume") => WorkerOp::Resume, Some("skip") => WorkerOp::Skip, Some(_) => WorkerOp::Stop,
                None => return Err(Refusal::at("InvalidShape", "op")),
            };
            Action::Worker { id, op }
        }
        _ => {
            if extra(&["decision", "workerId"]) { return Err("InvalidShape".into()); }
            let op = match object.get("op").and_then(Value::as_str).filter(|op| LIMIT_OPS.contains(op)) {
                Some("continue") => LimitOp::Continue, Some("resume") => LimitOp::Resume, Some(_) => LimitOp::Dismiss,
                None => return Err(Refusal::at("InvalidShape", "op")),
            };
            let (mut connection, mut harness) = (None, None);
            if let Some(options) = object.get("options") {
                // Only a continue moves to another connection; the other two answer the pause itself.
                let options = options.as_object().filter(|_| op == LimitOp::Continue).ok_or_else(|| Refusal::at("InvalidShape", "options"))?;
                if let Some(key) = options.keys().find(|key| !OPTION_KEYS.contains(&key.as_str())) { return Err(Refusal::at("InvalidShape", key)); }
                connection = text_of(options, "connection")?;
                harness = text_of(options, "harness")?;
            }
            Action::Limit { op, connection, harness }
        }
    };
    Ok(Spec { task_id, project_id, action })
}

// ---- What the interface requires of the task -------------------------------------------------------------------------------

/// What the checks need of one worker.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WorkerFact { pub id: String, pub status: String, pub abandoned: bool, pub reviewer: bool }

/// What the checks and the plan need to know of the task.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TaskFacts {
    pub harness: String,
    /// A mirror of a task that runs on another computer: its team and its pauses are that computer's.
    pub remote: bool,
    pub team: bool,
    /// The team's lead or a worker is running or waiting (`running`, `waiting`).
    pub team_active: bool,
    /// The team is paused, failed or interrupted, so its own Resume applies (`architect::can_resume`).
    pub team_resumable: bool,
    /// Council is on for the team.
    pub council: bool,
    pub workers: Vec<WorkerFact>,
    pub running: bool,
    pub limited: bool,
    /// The pause carries the time the limit resets, which "Resume at reset" needs.
    pub reset_known: bool,
}

fn conflict(path: &str, reason: &str) -> Refusal { Refusal::at("Conflict", path).with_ids(vec![reason.to_owned()]) }

/// The state the interface needs for the same button: refused before anything changes, as `Conflict` (or the code named).
pub fn check(spec: &Spec, facts: &TaskFacts) -> Result<(), Refusal> {
    match &spec.action {
        Action::Council(decision) => {
            if facts.remote { return Err(Refusal::at("UnsupportedCapability", "council")); }
            if !facts.team { return Err(conflict("council", "noTeam")); }
            if !facts.council { return Err(conflict("council", "councilOff")); }
            // The strip's Keep fixing is a follow-up to the lead: it waits for the lead to be idle, as the card does.
            if *decision == Decision::KeepFixing && facts.running { return Err(conflict("council", "running")); }
            Ok(())
        }
        Action::Worker { id, op } => {
            if facts.remote { return Err(Refusal::at("UnsupportedCapability", "worker")); }
            if !facts.team { return Err(conflict("worker", "noTeam")); }
            let worker = facts.workers.iter().find(|worker| &worker.id == id).ok_or_else(|| Refusal::at("NotFound", "workerId"))?;
            let working = matches!(worker.status.as_str(), "queued" | "running" | "waiting" | "parked");
            let allowed = match op {
                WorkerOp::Stop => working,
                WorkerOp::Skip => worker.status != "completed" && !worker.abandoned,
                WorkerOp::Retry => worker.status == "failed" && !worker.abandoned,
                WorkerOp::Resume => worker.status == "stopped" && !worker.abandoned,
            };
            if !allowed { return Err(conflict("op", "workerState")); }
            if matches!(op, WorkerOp::Retry | WorkerOp::Resume) {
                // A reviewer is replaced by a fresh one, never followed up (the lead is told the same).
                if worker.reviewer { return Err(conflict("workerId", "reviewer")); }
                if !facts.team_active && !facts.team_resumable { return Err(conflict("worker", "teamFinished")); }
            }
            Ok(())
        }
        Action::Limit { op, connection, harness } => {
            if !facts.limited { return Err(conflict("limit", "notLimited")); }
            if *op == LimitOp::Resume && !facts.reset_known { return Err(conflict("limit", "noReset")); }
            if *op == LimitOp::Continue {
                if facts.remote && connection.is_some() { return Err(Refusal::at("UnsupportedCapability", "connection")); }
                // The interface offers another connection of this harness, never another harness, on a limit.
                if harness.as_deref().is_some_and(|harness| harness != facts.harness) { return Err(Refusal::at("UnsupportedCapability", "harness")); }
                if facts.running && !facts.team { return Err(conflict("limit", "running")); }
            }
            Ok(())
        }
    }
}

// ---- The native operations an action runs ----------------------------------------------------------------------------------

/// One call of the interface's own command set, by the name and arguments the interface uses. The window's own functions
/// (the strip's dismissal, the follow-up it sends, the banner's move to another connection) carry the names the window uses.
pub fn plan(spec: &Spec, facts: &TaskFacts) -> Vec<super::runtime_tasks_control::Command> {
    use super::runtime_tasks_control::Command;
    let id = &spec.task_id;
    match &spec.action {
        Action::Council(Decision::Accept) => vec![Command { name: "architect_council_accept", args: json!({"sessionId": id}) }],
        Action::Council(Decision::Dismiss) => vec![Command { name: "council_dismiss", args: json!({"sessionId": id}) }],
        Action::Council(Decision::KeepFixing) => vec![Command { name: "send_message", args: json!({"sessionId": id, "text": KEEP_FIXING_TEXT}) }],
        Action::Worker { op: WorkerOp::Retry | WorkerOp::Resume, .. } if !facts.team_active && facts.team_resumable => vec![Command { name: "architect_control", args: json!({"sessionId": id, "action": "resume"}) }],
        Action::Worker { id: worker, op } => vec![Command { name: "architect_worker_control", args: json!({"sessionId": id, "workerId": worker, "action": op.name()}) }],
        Action::Limit { op: LimitOp::Continue, connection: Some(connection), .. } => vec![Command { name: "continue_on_connection", args: json!({"sessionId": id, "connectionId": connection}) }],
        Action::Limit { op: LimitOp::Continue, .. } => vec![Command { name: "send_message", args: json!({"sessionId": id, "text": CONTINUE_TEXT}) }],
        Action::Limit { op: LimitOp::Resume, .. } => vec![Command { name: "set_resume_at_reset", args: json!({"sessionId": id, "enabled": true}) }],
        Action::Limit { op: LimitOp::Dismiss, .. } => vec![Command { name: "clear_usage_limit", args: json!({"sessionId": id}) }],
    }
}

/// Maps the text of a failed host operation to the frozen code. Nothing of the text reaches the package.
pub fn code_of(error: &str) -> &'static str {
    let lower = error.to_lowercase();
    if ["stop the agent", "already working", "wait for", "not running", "already settled", "resume the team", "not waiting", "skipped", "no usage limit", "has no team", "team is unavailable", "council is off"].iter().any(|part| lower.contains(part)) { "Conflict" }
    else if lower.contains("does not belong") || lower.contains("this task is gone") { "NotFound" }
    else if lower.contains("team runs on") { "UnsupportedCapability" }
    else { super::runtime_tasks_control::code_of(error) }
}

fn refusal_of(error: &str) -> Refusal {
    let code = match error { "PermissionDenied" | "NotFound" | "Conflict" | "UnsupportedCapability" | "HostUnavailable" | "Timeout" | "Revoked" | "LimitExceeded" => error, other => code_of(other) };
    Refusal::new(code)
}

// ---- The app ---------------------------------------------------------------------------------------------------------------

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
            && package["grants"].as_array().into_iter().flatten().any(|grant| grant["permission"] == PERMISSION && grant["scope"]["projects"].as_array().is_none_or(|projects| !projects.is_empty()))
    })
}

fn facts_of(state: &crate::AppState, task: &str) -> Result<TaskFacts, Refusal> {
    let running = crate::run_requests::lock_agents(&state.agents).map_or(true, |agents| agents.contains_key(task));
    let store = state.store.lock().map_err(|_| Refusal::new("HostUnavailable"))?;
    let session = store.session(task).map_err(|_| Refusal::new("NotFound"))?;
    let team = crate::architect::load(&store, task).ok().flatten();
    Ok(TaskFacts {
        harness: session.provider, remote: session.remote_device.is_some(), running,
        team: team.is_some(),
        team_active: team.as_ref().is_some_and(|team| matches!(team.status.as_str(), "running" | "waiting")),
        team_resumable: team.as_ref().is_some_and(|team| crate::architect::can_resume(&team.status)),
        council: team.as_ref().is_some_and(|team| team.config.council.is_some()),
        workers: team.iter().flat_map(|team| team.workers.iter()).map(|worker| WorkerFact { id: worker.id.clone(), status: worker.status.clone(), abandoned: worker.abandoned, reviewer: worker.council.is_some() }).collect(),
        limited: session.limited_at.is_some(), reset_known: session.limited_until.is_some(),
    })
}

fn log_changed(app: &tauri::AppHandle) { use tauri::Emitter; let _ = app.emit("extensions-runtime-task-controls", log(app).map_or(0, |ledger| ledger.revision())); }

/// Serves `tasksFlow` of the service of `request.owner`.
pub async fn serve(app: tauri::AppHandle, request: super::runtime_service_lifetime::DispatchRequest) -> Value {
    use tauri::Manager;
    let owner = request.owner.clone();
    if log(&app).is_none() { return Refusal::new("UnsupportedCapability").envelope(); }
    let found = { let app = app.clone(); let owner = owner.clone(); tauri::async_runtime::spawn_blocking(move || package(&app, &owner)).await.unwrap_or(Err("HostUnavailable")) };
    let (version, name) = match found { Ok(found) => found, Err(code) => return if code == "PermissionDenied" { Refusal::denied().envelope() } else { Refusal::new(code).envelope() } };
    // Admission: the grant (narrowing included) and the task. Nothing has changed yet.
    let spec = {
        let task_project = |id: &str| app.try_state::<crate::AppState>().and_then(|state| state.store.lock().ok().and_then(|store| store.session(id).ok().map(|session| session.project_id)));
        let world = World { task_project: &task_project, granted: &|project: &str| granted(&app, &owner, &version, project), holds_any: &|| holds_any(&app, &owner, &version) };
        match admit(&world, &request.params) { Ok(spec) => spec, Err(refusal) => return refusal.envelope() }
    };
    let state = app.state::<crate::AppState>();
    let facts = match facts_of(&state, &spec.task_id) { Ok(facts) => facts, Err(refusal) => return refusal.envelope() };
    if let Err(refusal) = check(&spec, &facts) { return refusal.envelope(); }
    // The permission is read again just before anything changes: a revoke or a narrowing in between changes nothing.
    if !granted(&app, &owner, &version, &spec.project_id) || package(&app, &owner).is_err() { return Refusal::denied().envelope(); }
    match apply(&app, &owner, &spec, &facts).await {
        Ok(()) => {
            let entry = Entry { task_id: spec.task_id.clone(), action: spec.action.name().to_owned(), detail: json!({"call": spec.action.detail(), "commands": plan(&spec, &facts).iter().map(|command| command.name).collect::<Vec<_>>()}), owner: owner.clone(), package: name, at: super::runtime_notifications::now_millis() };
            if let Some(ledger) = log(&app) { let _ = ledger.record(entry); }
            log_changed(&app);
            ok(Value::Null)
        }
        Err(refusal) => refusal.envelope(),
    }
}

/// Runs the plan of an action through the host's own operations (or the window's, for the rounds only it can run).
async fn apply(app: &tauri::AppHandle, owner: &str, spec: &Spec, facts: &TaskFacts) -> Result<(), Refusal> {
    use tauri::{Emitter, Manager};
    let id = spec.task_id.clone();
    for command in plan(spec, facts) {
        let outcome: Result<(), String> = match command.name {
            "architect_council_accept" => crate::architect::architect_council_accept(app.clone(), app.state::<crate::AppState>(), id.clone()).await.map(|_| ()),
            "architect_control" => crate::architect::architect_control(app.clone(), app.state::<crate::AppState>(), id.clone(), "resume".into()).await.map(|_| ()),
            "architect_worker_control" => {
                let (worker, op) = match &spec.action { Action::Worker { id: worker, op } => (worker.clone(), op.name()), _ => return Err(Refusal::new("InvalidShape")) };
                crate::architect::flow_workers::worker_control(app.clone(), app.state::<crate::AppState>(), id.clone(), worker, op.to_owned()).await.map(|_| ())
            }
            "clear_usage_limit" => crate::clear_usage_limit(app.clone(), app.state::<crate::AppState>(), id.clone()).await,
            "set_resume_at_reset" => crate::set_resume_at_reset(app.state::<crate::AppState>(), id.clone(), true).await.map(|_| ()),
            "council_dismiss" => window_round(app, owner, &id, "councilDismiss", None).await,
            "send_message" if matches!(spec.action, Action::Council(_)) => window_round(app, owner, &id, "councilKeepFixing", None).await,
            "send_message" => window_round(app, owner, &id, "limitContinue", None).await,
            "continue_on_connection" => window_round(app, owner, &id, "limitContinue", command.args["connectionId"].as_str()).await,
            _ => Err("Unsupported control.".to_owned()),
        };
        outcome.map_err(|error| refusal_of(&error))?;
    }
    let _ = app.emit("sessions-changed", ());
    Ok(())
}

/// A round only the main window can run: the strip's per-cycle dismissal and the follow-up the strip and the banner send
/// live in its state. It answers whether it could, through the answer command of `runtime_tasks_start`.
async fn window_round(app: &tauri::AppHandle, owner: &str, task: &str, kind: &str, connection: Option<&str>) -> Result<(), String> {
    use tauri::Emitter;
    if crate::headless::active() { return Err("UnsupportedCapability".into()); }
    let Some(slots) = super::runtime_tasks_start::state(app) else { return Err("UnsupportedCapability".into()) };
    let (id, receiver) = slots.begin(owner).map_err(str::to_owned)?;
    struct Guard { app: tauri::AppHandle, id: String }
    impl Drop for Guard { fn drop(&mut self) { if let Some(slots) = super::runtime_tasks_start::state(&self.app) { slots.forget(&self.id); } } }
    let _guard = Guard { app: app.clone(), id: id.clone() };
    let _ = app.emit(FLOW_EVENT, json!({"id": id, "owner": owner, "taskId": task, "kind": kind, "connection": connection}));
    let answer = match tokio::time::timeout(super::runtime_tasks_start::DEFAULTS_WAIT, receiver).await { Ok(Ok(answer)) => answer, Ok(Err(_)) => return Err("Revoked".into()), Err(_) => return Err("Timeout".into()) };
    if answer["ok"] == true { return Ok(()); }
    Err(match answer["code"].as_str() { Some("NotFound") => "NotFound", Some("Conflict") => "Conflict", Some("Revoked") => "Revoked", _ => "HostUnavailable" }.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture { tasks: Vec<(&'static str, &'static str)>, allowed: Vec<&'static str> }
    impl Fixture {
        fn admit(&self, raw: Value) -> Result<Spec, Refusal> {
            let task_project = |id: &str| self.tasks.iter().find(|(task, _)| *task == id).map(|(_, project)| (*project).to_owned());
            let granted = |project: &str| self.allowed.contains(&project);
            let holds_any = || !self.allowed.is_empty();
            admit(&World { task_project: &task_project, granted: &granted, holds_any: &holds_any }, &raw)
        }
    }
    fn make_fixture() -> Fixture { Fixture { tasks: vec![("t1", "A"), ("t2", "B")], allowed: vec!["A"] } }
    fn code(result: Result<Spec, Refusal>) -> String { result.unwrap_err().code }
    fn worker(id: &str, status: &str) -> WorkerFact { WorkerFact { id: id.into(), status: status.into(), abandoned: false, reviewer: false } }
    fn facts() -> TaskFacts {
        TaskFacts {
            harness: "claude".into(), remote: false, team: true, team_active: true, team_resumable: false, council: true, running: false, limited: true, reset_known: true,
            workers: vec![worker("run", "running"), worker("bad", "failed"), worker("stop", "stopped"), worker("done", "completed"), WorkerFact { reviewer: true, ..worker("seat", "failed") }, WorkerFact { abandoned: true, ..worker("gone", "stopped") }],
        }
    }
    fn spec(action: Action) -> Spec { Spec { task_id: "t1".into(), project_id: "A".into(), action } }
    fn refusal(action: Action, facts: &TaskFacts) -> (String, String, Vec<String>) { let refusal = check(&spec(action), facts).unwrap_err(); (refusal.code, refusal.path, refusal.ids) }

    #[test]
    fn each_action_reads_its_shape_and_belongs_to_the_task_project() {
        let fixture = make_fixture();
        assert_eq!(fixture.admit(json!({"action": "council", "taskId": "t1", "decision": "keepFixing"})).unwrap().action, Action::Council(Decision::KeepFixing));
        assert_eq!(fixture.admit(json!({"action": "worker", "taskId": "t1", "workerId": "w1", "op": "skip"})).unwrap().action, Action::Worker { id: "w1".into(), op: WorkerOp::Skip });
        assert_eq!(fixture.admit(json!({"action": "limit", "taskId": "t1", "op": "continue", "options": {"connection": "c1", "harness": "claude"}})).unwrap().action, Action::Limit { op: LimitOp::Continue, connection: Some("c1".into()), harness: Some("claude".into()) });
        assert_eq!(fixture.admit(json!({"action": "limit", "taskId": "t1", "op": "dismiss"})).unwrap().action, Action::Limit { op: LimitOp::Dismiss, connection: None, harness: None });
    }

    #[test]
    fn no_grant_a_narrowed_project_or_an_unrelated_package_is_permission_denied_naming_the_permission() {
        let fixture = make_fixture();
        let refusal = fixture.admit(json!({"action": "council", "taskId": "t2", "decision": "accept"})).unwrap_err();
        assert_eq!((refusal.code.as_str(), refusal.path.as_str()), ("PermissionDenied", "tasks.control"));
        let none = Fixture { allowed: vec![], ..make_fixture() };
        for task in ["t1", "t2", "ghost"] { assert_eq!(code(none.admit(json!({"action": "limit", "taskId": task, "op": "dismiss"}))), "PermissionDenied", "{task}"); }
        assert_eq!(code(fixture.admit(json!({"action": "limit", "taskId": "ghost", "op": "dismiss"}))), "NotFound");
    }

    #[test]
    fn shapes_are_refused_with_their_reason() {
        let fixture = make_fixture();
        for (raw, expected, path) in [
            (json!("text"), "InvalidShape", "$"), (json!({"action": "council"}), "InvalidShape", "$"), (json!({"action": "stop", "taskId": "t1"}), "InvalidShape", "$"),
            (json!({"action": "council", "taskId": "t1"}), "InvalidShape", "decision"), (json!({"action": "council", "taskId": "t1", "decision": "yes"}), "InvalidShape", "decision"),
            (json!({"action": "council", "taskId": "t1", "decision": "accept", "op": "stop"}), "InvalidShape", "$"),
            (json!({"action": "worker", "taskId": "t1", "op": "stop"}), "InvalidShape", "workerId"), (json!({"action": "worker", "taskId": "t1", "workerId": "w", "op": "kill"}), "InvalidShape", "op"),
            (json!({"action": "worker", "taskId": "t1", "workerId": "w", "op": "stop", "decision": "accept"}), "InvalidShape", "$"),
            (json!({"action": "limit", "taskId": "t1"}), "InvalidShape", "op"), (json!({"action": "limit", "taskId": "t1", "op": "wait"}), "InvalidShape", "op"),
            (json!({"action": "limit", "taskId": "t1", "op": "dismiss", "options": {}}), "InvalidShape", "options"), (json!({"action": "limit", "taskId": "t1", "op": "continue", "options": "c1"}), "InvalidShape", "options"),
            (json!({"action": "limit", "taskId": "t1", "op": "continue", "options": {"model": "m"}}), "InvalidShape", "model"), (json!({"action": "limit", "taskId": "t1", "op": "continue", "options": {"connection": null}}), "InvalidShape", "connection"),
            (json!({"action": "limit", "taskId": "t1", "op": "dismiss", "source": "other"}), "InvalidShape", "$"),
        ] {
            let refusal = fixture.admit(raw.clone()).unwrap_err();
            assert_eq!((refusal.code.as_str(), refusal.path.as_str()), (expected, path), "{raw}");
        }
    }

    #[test]
    fn the_interface_state_each_button_needs_is_checked_before_anything_changes() {
        let facts = facts();
        for decision in [Decision::Accept, Decision::Dismiss, Decision::KeepFixing] { assert!(check(&spec(Action::Council(decision)), &facts).is_ok(), "{decision:?}"); }
        assert_eq!(refusal(Action::Council(Decision::KeepFixing), &TaskFacts { running: true, ..facts.clone() }).2, ["running"]);
        assert!(check(&spec(Action::Council(Decision::Accept)), &TaskFacts { running: true, ..facts.clone() }).is_ok());
        assert_eq!(refusal(Action::Council(Decision::Accept), &TaskFacts { team: false, ..facts.clone() }).2, ["noTeam"]);
        assert_eq!(refusal(Action::Council(Decision::Accept), &TaskFacts { council: false, ..facts.clone() }).2, ["councilOff"]);
        assert_eq!(refusal(Action::Council(Decision::Accept), &TaskFacts { remote: true, ..facts.clone() }).0, "UnsupportedCapability");
        let worker = |id: &str, op| Action::Worker { id: id.into(), op };
        assert!(check(&spec(worker("run", WorkerOp::Stop)), &facts).is_ok());
        assert!(check(&spec(worker("bad", WorkerOp::Retry)), &facts).is_ok());
        assert!(check(&spec(worker("stop", WorkerOp::Resume)), &facts).is_ok());
        assert!(check(&spec(worker("bad", WorkerOp::Skip)), &facts).is_ok());
        assert_eq!(refusal(worker("ghost", WorkerOp::Stop), &facts).1, "workerId");
        for (id, op) in [("done", WorkerOp::Stop), ("run", WorkerOp::Retry), ("bad", WorkerOp::Resume), ("done", WorkerOp::Skip), ("gone", WorkerOp::Skip), ("gone", WorkerOp::Resume)] { assert_eq!(refusal(worker(id, op), &facts).0, "Conflict", "{id} {op:?}"); }
        assert_eq!(refusal(worker("seat", WorkerOp::Retry), &facts).2, ["reviewer"]);
        assert_eq!(refusal(worker("bad", WorkerOp::Retry), &TaskFacts { team_active: false, ..facts.clone() }).2, ["teamFinished"]);
        assert!(check(&spec(worker("bad", WorkerOp::Retry)), &TaskFacts { team_active: false, team_resumable: true, ..facts.clone() }).is_ok());
        let limit = |op, connection: Option<&str>, harness: Option<&str>| Action::Limit { op, connection: connection.map(str::to_owned), harness: harness.map(str::to_owned) };
        for op in [LimitOp::Continue, LimitOp::Resume, LimitOp::Dismiss] { assert!(check(&spec(limit(op, None, None)), &facts).is_ok(), "{op:?}"); assert_eq!(refusal(limit(op, None, None), &TaskFacts { limited: false, ..facts.clone() }).2, ["notLimited"]); }
        assert_eq!(refusal(limit(LimitOp::Resume, None, None), &TaskFacts { reset_known: false, ..facts.clone() }).2, ["noReset"]);
        assert_eq!(refusal(limit(LimitOp::Continue, None, Some("codex")), &facts), ("UnsupportedCapability".into(), "harness".into(), vec![]));
        assert!(check(&spec(limit(LimitOp::Continue, Some("c1"), Some("claude"))), &facts).is_ok());
        assert_eq!(refusal(limit(LimitOp::Continue, Some("c1"), None), &TaskFacts { remote: true, ..facts.clone() }).1, "connection");
        assert_eq!(refusal(limit(LimitOp::Continue, None, None), &TaskFacts { running: true, team: false, ..facts.clone() }).2, ["running"]);
        // A team held by the limit may continue while its lead is between turns.
        assert!(check(&spec(limit(LimitOp::Continue, None, None)), &TaskFacts { running: true, ..facts.clone() }).is_ok());
    }

    #[test]
    fn the_parity_recording_of_the_interface_equals_the_plan_of_every_action() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/extensions/runtime-tasks-flow/parity.json");
        let recording: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let cases = recording["cases"].as_array().unwrap();
        assert!(cases.len() >= 12);
        let task_project = |id: &str| (id == "t1").then(|| "A".to_owned());
        let granted = |_: &str| true;
        let holds_any = || true;
        for case in cases {
            let spec = admit(&World { task_project: &task_project, granted: &granted, holds_any: &holds_any }, &case["request"]).unwrap();
            let task = &case["task"];
            let facts = TaskFacts { team_active: task["teamActive"] == true, team_resumable: task["teamResumable"] == true, ..TaskFacts::default() };
            let planned: Vec<Value> = plan(&spec, &facts).iter().map(super::super::runtime_tasks_control::Command::to_json).collect();
            assert_eq!(Value::Array(planned), case["commands"], "{}", case["name"]);
        }
    }

    #[test]
    fn host_failures_map_to_frozen_codes_without_their_text() {
        for (text, expected) in [
            ("The team is already working.", "Conflict"), ("This worker is not running.", "Conflict"), ("Resume the team first.", "Conflict"), ("This task has no team.", "Conflict"),
            ("This task has no usage limit with a known reset time.", "Conflict"), ("Worker does not belong to this team.", "NotFound"), ("This task is gone.", "NotFound"),
            ("This task's team runs on Studio.", "UnsupportedCapability"), ("Stop the agent before changing its connection.", "Conflict"), ("disk on fire", "HostUnavailable"),
        ] { assert_eq!(code_of(text), expected, "{text}"); }
        assert_eq!(refusal_of("Timeout").code, "Timeout");
    }
}
