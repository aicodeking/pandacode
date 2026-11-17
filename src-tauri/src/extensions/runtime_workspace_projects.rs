//! Projects, worktrees, branches, tasks and pull requests for a trusted service, and the project checks
//! (`workspace.manage` and `projects.checks.run`, runtime phase R4, slice R0405).
//!
//! A service manages the workspace with `panda.workspace.projects.*`, `worktrees.*`, `branches.*`, `tasks.*` and
//! `pulls.*`, and runs a project's check script with `panda.projects.checks.run({ taskId })`. Every call is a thin
//! adapter over the command the interface already uses (`add_project`, `remove_project`, `relink_project`,
//! `create_worktree`, `remove_worktree`, `recreate_worktree`, `merge_worktree`, `git_switch_branch`, `update_session`,
//! `delete_session`, `github_link_pull_request`, `github_pull_request`, `github_merge_pull_request` and
//! `run_turn_checks`); the three that have no command of their own (a project's name, a branch's create, rename and
//! delete, a task's project) are small bounded operations on the same store and the same bounded Git runner.
//!
//! Permissions (ADR-0005). `workspace.manage` covers the nineteen calls and is project scoped: it is checked against
//! the grants file on every request, against the project the call touches (the task's project for a task, worktree or
//! pull call, the destination too for `tasks.move`), and once more right before anything changes, so a revoke or a
//! narrowing between the two changes nothing. `projects.add` has no project yet: only a grant for every project covers
//! it. `projects.checks.run` is a separate permission with the same rules: the project's check script runs in the task's
//! checkout through the existing runner (`checks::turn_report`), with no per-run prompt after the grant. A revoke while
//! it runs withdraws the report. Fixed shapes, in the frozen order of refusals (the id shapes, the permission, the rest
//! of the shape, then what must exist):
//!
//! | call | input | answer |
//! |---|---|---|
//! | `projects.add` | `{path}` | `{projectId, name}` |
//! | `projects.remove` | `{projectId}` | `null` |
//! | `projects.rename` | `{projectId, name}` | `{projectId, name}` |
//! | `projects.relink` | `{projectId, path}` | `{projectId, name}` |
//! | `worktrees.create` | `{taskId, branch, base?, existing?}` | `{worktreeId, taskId, projectId, branch}` |
//! | `worktrees.remove` | `{worktreeId, deleteBranch?}` | `{removed, branch, branchDeleted, note}` |
//! | `worktrees.recreate` | `{worktreeId}` | `{worktreeId, branch}` |
//! | `worktrees.merge` | `{worktreeId}` | `{branch, target, commits, switchedFrom}` |
//! | `branches.create` | `{projectId, taskId?, name, from?, switch?}` | `{current, branches, defaultBranch}` |
//! | `branches.switch` | `{projectId, taskId?, branch}` | `{current, branches, defaultBranch}` |
//! | `branches.rename` | `{projectId, taskId?, from, to}` | `{current, branches, defaultBranch}` |
//! | `branches.remove` | `{projectId, taskId?, branch, force?}` | `{current, branches, defaultBranch}` |
//! | `tasks.remove` | `{taskId}` | `{taskIds}` |
//! | `tasks.rename` | `{taskId, title}` | `null` |
//! | `tasks.move` | `{taskId, projectId}` | `{taskId, projectId}` |
//! | `pulls.link` | `{taskId, reference}` | `{number, url, title, state}` |
//! | `pulls.unlink` | `{taskId}` | `null` |
//! | `pulls.check` | `{taskId}` | the pull request's state, checks and review |
//! | `pulls.merge` | `{taskId, method?}` | `{number, url, title, state}` |
//! | `projects.checks.run` | `{taskId}` | `{schemaVersion: 1, report}` (no plan is a report, not an error) |
//!
//! A worktree is identified by the task that works in it (`worktreeId` is that task's id); a branch by its name.
//!
//! Irreversible actions keep the host's confirmation by default (`runtime_family_consents`): `projects.remove`,
//! `tasks.remove`, `worktrees.remove`, `branches.remove` and `pulls.merge` ask the main window, which shows the
//! package's name and what goes. A refusal answers `Cancelled` and changes nothing; the user can turn the confirmation
//! off for one package. Merging a worktree into its project is not on the frozen irreversible list (Git keeps the
//! history, and the merge refuses a dirty or conflicting checkout), so it acts at once. Pairing a machine and granting
//! remote access have no call here: they stay with the user. `projects.add` takes a path; the folder chooser is the
//! user's own tool.
//!
//! What is for predictability and fault isolation only: bounded text and paths, four confirmations waiting per package,
//! five minutes for the user's answer, two checks running at once per package, and Git calls with the runner's own
//! output and time bounds. The state is pure (an injected world), so the rules are deterministic to test; the app half
//! (`serve`) only adds the grants file, the store, the window and the commands.
use serde_json::{json, Map, Value};
use std::{collections::BTreeMap, sync::Mutex, time::Duration};
use tokio::sync::oneshot;

pub const MANAGE: &str = "workspace.manage";
pub const CHECKS: &str = "projects.checks.run";
pub const SCHEMA_VERSION: u64 = 1;
/// Confirmations per package that may wait for the window at once.
pub const MAX_WAITING: usize = 4;
/// How long the user has to answer one confirmation.
pub const CONFIRM_WAIT: Duration = Duration::from_secs(300);
/// Checks per package that may run at once.
pub const MAX_CHECKS: usize = 2;
pub const MAX_PATH: usize = 4096;
pub const MAX_NAME: usize = 200;
pub const MAX_BRANCH: usize = 120;
pub const MAX_REF: usize = 200;
pub const MAX_REFERENCE: usize = 512;
pub const METHODS: [&str; 3] = ["squash", "merge", "rebase"];

/// A refusal in the broker envelope: `code`, the `path` it names and the `ids` it carries.
pub fn failure_with(code: &str, path: &str, ids: &[String]) -> Value { json!({"ok": false, "error": {"schemaVersion": 1, "code": code, "path": path, "ids": ids}}) }
pub fn failure(code: &str) -> Value { failure_with(code, "$", &[]) }
fn ok(value: Value) -> Value { json!({"ok": true, "value": value}) }
fn ident(text: &str) -> bool { !text.is_empty() && text.chars().count() <= 128 && !text.chars().any(char::is_control) }

/// What admission may refuse: the code, the path it names and the ids it carries.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Refusal { pub code: String, pub path: String, pub ids: Vec<String> }
impl Refusal {
    pub fn new(code: &str) -> Self { Self { code: code.into(), path: "$".into(), ids: vec![] } }
    pub fn denied(permission: &str) -> Self { Self { code: "PermissionDenied".into(), path: permission.into(), ids: vec![] } }
    pub fn envelope(&self) -> Value { failure_with(&self.code, &self.path, &self.ids) }
}
impl From<&str> for Refusal { fn from(code: &str) -> Self { Self::new(code) } }

// ---- The calls ---------------------------------------------------------------------------------------------------------

/// Which project a call touches.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scope { None, Project(&'static str), Task(&'static str) }

/// One call: its permission, what it touches, its keys and the irreversible action it confirms.
#[derive(Clone, Copy, Debug)]
pub struct Spec { pub call: &'static str, pub permission: &'static str, pub scope: Scope, pub required: &'static [&'static str], pub optional: &'static [&'static str], pub confirm: Option<&'static str> }

const fn spec(call: &'static str, scope: Scope, required: &'static [&'static str], optional: &'static [&'static str], confirm: Option<&'static str>) -> Spec { Spec { call, permission: MANAGE, scope, required, optional, confirm } }

pub const SPECS: [Spec; 20] = [
    spec("projects.add", Scope::None, &["path"], &[], None),
    spec("projects.remove", Scope::Project("projectId"), &["projectId"], &[], Some("projects.remove")),
    spec("projects.rename", Scope::Project("projectId"), &["projectId", "name"], &[], None),
    spec("projects.relink", Scope::Project("projectId"), &["projectId", "path"], &[], None),
    spec("worktrees.create", Scope::Task("taskId"), &["taskId", "branch"], &["base", "existing"], None),
    spec("worktrees.remove", Scope::Task("worktreeId"), &["worktreeId"], &["deleteBranch"], Some("worktrees.remove")),
    spec("worktrees.recreate", Scope::Task("worktreeId"), &["worktreeId"], &[], None),
    spec("worktrees.merge", Scope::Task("worktreeId"), &["worktreeId"], &[], None),
    spec("branches.create", Scope::Project("projectId"), &["projectId", "name"], &["taskId", "from", "switch"], None),
    spec("branches.switch", Scope::Project("projectId"), &["projectId", "branch"], &["taskId"], None),
    spec("branches.rename", Scope::Project("projectId"), &["projectId", "from", "to"], &["taskId"], None),
    spec("branches.remove", Scope::Project("projectId"), &["projectId", "branch"], &["taskId", "force"], Some("branches.remove")),
    spec("tasks.remove", Scope::Task("taskId"), &["taskId"], &[], Some("tasks.remove")),
    spec("tasks.rename", Scope::Task("taskId"), &["taskId", "title"], &[], None),
    spec("tasks.move", Scope::Task("taskId"), &["taskId", "projectId"], &[], None),
    spec("pulls.link", Scope::Task("taskId"), &["taskId", "reference"], &[], None),
    spec("pulls.unlink", Scope::Task("taskId"), &["taskId"], &[], None),
    spec("pulls.check", Scope::Task("taskId"), &["taskId"], &[], None),
    spec("pulls.merge", Scope::Task("taskId"), &["taskId"], &["method"], Some("pulls.merge")),
    Spec { call: "projects.checks.run", permission: CHECKS, scope: Scope::Task("taskId"), required: &["taskId"], optional: &[], confirm: None },
];
const ID_KEYS: [&str; 3] = ["projectId", "taskId", "worktreeId"];

pub fn spec_of(call: &str) -> Option<&'static Spec> { SPECS.iter().find(|spec| spec.call == call) }

/// What the app answers about the world; tests give fixed answers.
pub struct World<'a> {
    /// The package holds `permission` for this project now (`None`: for every project, the grants file, narrowing included).
    pub granted: &'a dyn Fn(&str, Option<&str>) -> bool,
    pub task_project: &'a dyn Fn(&str) -> Option<String>,
    pub project_exists: &'a dyn Fn(&str) -> bool,
}

/// A validated request: the call, its permission, the project it touches and its input.
#[derive(Clone, Debug, PartialEq)]
pub struct Admitted { pub call: &'static str, pub permission: &'static str, pub project: Option<String>, pub confirm: Option<&'static str>, pub input: Map<String, Value> }

/// A branch name Git accepts and no option can pose as.
pub fn branch_ok(name: &str) -> bool {
    !name.is_empty() && name.len() <= MAX_BRANCH && !name.contains("..") && !name.contains("//") && !name.starts_with(['-', '/', '.']) && !name.ends_with(['/', '.']) && !name.ends_with(".lock")
        && name.bytes().all(|c| c.is_ascii_alphanumeric() || b"/-_.".contains(&c))
}
/// A start point for a new branch: a branch, tag or commit name.
pub fn ref_ok(name: &str) -> bool {
    !name.is_empty() && name.len() <= MAX_REF && !name.contains("..") && !name.starts_with('-') && name.bytes().all(|c| c.is_ascii_alphanumeric() || b"/-_.".contains(&c))
}

fn id_of(input: &Map<String, Value>, key: &str) -> String { input.get(key).and_then(Value::as_str).unwrap_or_default().to_owned() }
fn text_in(input: &Map<String, Value>, key: &str, limit: usize) -> Result<(), Refusal> {
    let text = input.get(key).and_then(Value::as_str).ok_or("InvalidShape")?;
    if text.trim().is_empty() || text.chars().any(char::is_control) { return Err("InvalidShape".into()); }
    if text.chars().count() > limit { return Err("LimitExceeded".into()); }
    Ok(())
}
fn flag_in(input: &Map<String, Value>, key: &str) -> Result<(), Refusal> {
    match input.get(key) { None | Some(Value::Null) | Some(Value::Bool(_)) => Ok(()), Some(_) => Err("InvalidShape".into()) }
}
fn branch_in(input: &Map<String, Value>, key: &str) -> Result<(), Refusal> {
    if input.get(key).and_then(Value::as_str).is_some_and(branch_ok) { Ok(()) } else { Err("InvalidShape".into()) }
}
fn ref_in(input: &Map<String, Value>, key: &str) -> Result<(), Refusal> {
    match input.get(key) { None | Some(Value::Null) => Ok(()), Some(Value::String(text)) if ref_ok(text) => Ok(()), Some(_) => Err("InvalidShape".into()) }
}

/// The rest of the shape of a call, after the permission.
fn check_values(call: &str, input: &Map<String, Value>) -> Result<(), Refusal> {
    match call {
        "projects.add" | "projects.relink" => text_in(input, "path", MAX_PATH),
        "projects.rename" => text_in(input, "name", MAX_NAME),
        "worktrees.create" => { branch_in(input, "branch")?; ref_in(input, "base")?; flag_in(input, "existing") }
        "worktrees.remove" => flag_in(input, "deleteBranch"),
        "branches.create" => { branch_in(input, "name")?; ref_in(input, "from")?; flag_in(input, "switch") }
        "branches.switch" => branch_in(input, "branch"),
        "branches.rename" => { branch_in(input, "from")?; branch_in(input, "to")?; if input["from"] == input["to"] { return Err("InvalidShape".into()); } Ok(()) }
        "branches.remove" => { branch_in(input, "branch")?; flag_in(input, "force") }
        "tasks.rename" => text_in(input, "title", MAX_NAME),
        "pulls.link" => text_in(input, "reference", MAX_REFERENCE),
        "pulls.merge" => match input.get("method") { None | Some(Value::Null) => Ok(()), Some(Value::String(method)) if METHODS.contains(&method.as_str()) => Ok(()), Some(_) => Err("InvalidShape".into()) },
        _ => Ok(()),
    }
}

/// Reads a request and checks it against the world, in the frozen order: the id shapes, the permission (for the project
/// the call touches), the rest of the shape, then what must exist. A task or project the package may not touch is
/// `PermissionDenied` before it is ever `NotFound`.
pub fn admit(world: &World, call: &str, raw: &Value) -> Result<Admitted, Refusal> {
    let spec = spec_of(call).ok_or("UnsupportedCapability")?;
    let input = raw.as_object().ok_or("InvalidShape")?;
    if input.keys().any(|key| !spec.required.contains(&key.as_str()) && !spec.optional.contains(&key.as_str())) || spec.required.iter().any(|key| !input.contains_key(*key)) { return Err("InvalidShape".into()); }
    for key in ID_KEYS { if let Some(value) = input.get(key) { if !value.as_str().is_some_and(ident) { return Err("InvalidShape".into()); } } }
    let project = match spec.scope {
        Scope::None => None,
        Scope::Project(key) => Some(id_of(input, key)),
        Scope::Task(key) => match (world.task_project)(&id_of(input, key)) {
            Some(project) => Some(project),
            None => return Err(if (world.granted)(spec.permission, None) { "NotFound".into() } else { Refusal::denied(spec.permission) }),
        },
    };
    if !(world.granted)(spec.permission, project.as_deref()) { return Err(Refusal::denied(spec.permission)); }
    check_values(call, input)?;
    if call == "tasks.move" {
        let destination = id_of(input, "projectId");
        if !(world.granted)(spec.permission, Some(&destination)) { return Err(Refusal::denied(spec.permission)); }
        if !(world.project_exists)(&destination) { return Err("NotFound".into()); }
    }
    if let (Scope::Project(_), Some(project)) = (spec.scope, &project) { if !(world.project_exists)(project) { return Err("NotFound".into()); } }
    Ok(Admitted { call: spec.call, permission: spec.permission, project, confirm: spec.confirm, input: input.clone() })
}

/// Maps the text of a failed host operation to the frozen code. Nothing of the text reaches the package.
pub fn code_of(error: &str) -> &'static str {
    let error = error.to_lowercase();
    if error.contains("runs on") { "UnsupportedCapability" }
    else if ["already exists", "already checked out", "already uses", "another project", "stop this", "stop the agent", "stop it", "wait for", "finish before", "agents first", "teams first", "already started", "own worktree", "is used by", "checked out", "not fully merged", "uncommitted", "commit or stash", "would be overwritten", "pause this", "close this", "conflict", "destination"].iter().any(|part| error.contains(part)) { "Conflict" }
    else if ["does not exist", "not found", "no local branch", "unknown", "no linked", "uses the main checkout", "not a valid", "no github remote", "no such"].iter().any(|part| error.contains(part)) { "NotFound" }
    else if ["choose squash", "enter a pull", "invalid", "use a branch name", "too long", "1–200", "must be", "choose a folder", "cannot open folder"].iter().any(|part| error.contains(part)) { "InvalidShape" }
    else { "HostUnavailable" }
}

// ---- Confirmations waiting for the window -------------------------------------------------------------------------------

struct Waiting { owner: String, sender: Option<oneshot::Sender<bool>> }
#[derive(Default)]
struct Slots { waiting: BTreeMap<String, Waiting>, serial: u64 }

/// The irreversible actions that wait for the user's answer in the main window.
#[derive(Default)]
pub struct ConfirmSlots { inner: Mutex<Slots> }
impl ConfirmSlots {
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Slots>, &'static str> { self.inner.lock().map_err(|_| "HostUnavailable") }
    /// A confirmation waits: its id and the receiver the answer arrives on. A fifth one of the package is `LimitExceeded`.
    pub fn begin(&self, owner: &str) -> Result<(String, oneshot::Receiver<bool>), &'static str> {
        let mut slots = self.lock()?;
        if slots.waiting.values().filter(|waiting| waiting.owner == owner).count() >= MAX_WAITING { return Err("LimitExceeded"); }
        slots.serial += 1;
        let id = format!("{owner}#confirm-{}", slots.serial);
        let (sender, receiver) = oneshot::channel();
        slots.waiting.insert(id.clone(), Waiting { owner: owner.to_owned(), sender: Some(sender) });
        Ok((id, receiver))
    }
    /// The window answers confirmation `id`. An answer for one that is gone (answered, timed out, ended) is `NotFound`.
    pub fn answer(&self, id: &str, accepted: bool) -> Result<(), &'static str> {
        let mut slots = self.lock()?;
        let mut waiting = slots.waiting.remove(id).ok_or("NotFound")?;
        if let Some(sender) = waiting.sender.take() { let _ = sender.send(accepted); }
        Ok(())
    }
    /// The package's service ended: its waiting confirmations resolve as refused and change nothing.
    pub fn cancel_owner(&self, owner: &str) -> Vec<String> {
        let Ok(mut slots) = self.inner.lock() else { return vec![] };
        let ids: Vec<String> = slots.waiting.iter().filter(|(_, waiting)| waiting.owner == owner).map(|(id, _)| id.clone()).collect();
        for id in &ids { if let Some(mut waiting) = slots.waiting.remove(id) { if let Some(sender) = waiting.sender.take() { let _ = sender.send(false); } } }
        ids
    }
    pub fn forget(&self, id: &str) -> bool { self.inner.lock().is_ok_and(|mut slots| slots.waiting.remove(id).is_some()) }
    pub fn count(&self, owner: &str) -> usize { self.inner.lock().map_or(0, |slots| slots.waiting.values().filter(|waiting| waiting.owner == owner).count()) }
}

/// Checks running per package (two at once).
#[derive(Default)]
pub struct CheckGate { running: Mutex<BTreeMap<String, usize>> }
impl CheckGate {
    pub fn enter(&self, owner: &str) -> Result<(), &'static str> {
        let mut running = self.running.lock().map_err(|_| "HostUnavailable")?;
        let count = running.entry(owner.to_owned()).or_insert(0);
        if *count >= MAX_CHECKS { return Err("LimitExceeded"); }
        *count += 1;
        Ok(())
    }
    pub fn leave(&self, owner: &str) {
        if let Ok(mut running) = self.running.lock() {
            if let Some(count) = running.get_mut(owner) { *count = count.saturating_sub(1); if *count == 0 { running.remove(owner); } }
        }
    }
    pub fn count(&self, owner: &str) -> usize { self.running.lock().map_or(0, |running| running.get(owner).copied().unwrap_or(0)) }
}

/// The app's state of this slice: the waiting confirmations and the running checks.
#[derive(Default)]
pub struct WorkspaceProjects { pub confirms: ConfirmSlots, pub checks: CheckGate }

// ---- Operations on the store that have no command of their own ------------------------------------------------------------

/// Gives a project another name. The name is a label: a later relink takes the folder's name again.
pub fn rename_project(store: &crate::storage::Store, project_id: &str, name: &str) -> Result<crate::storage::Project, String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > MAX_NAME || name.chars().any(char::is_control) { return Err("The name must be 1–200 characters.".into()); }
    store.project(project_id)?;
    store.db.execute("UPDATE projects SET name=?2 WHERE id=?1", rusqlite::params![project_id, name]).map_err(|error| error.to_string())?;
    store.project(project_id)
}

/// Moves a task to another project. A task that is running, mirrored from another machine, a cloud task, a team's task or
/// one that works in its own worktree stays where it is: its checkout belongs to its project.
pub fn move_task(store: &crate::storage::Store, task_id: &str, project_id: &str) -> Result<(), String> {
    let task = store.session(task_id)?;
    store.project(project_id)?;
    if task.project_id == project_id { return Ok(()); }
    crate::architect::check_manual(store, task_id)?;
    if matches!(task.status.as_str(), "running" | "waiting") { return Err("Stop this task before moving it to another project.".into()); }
    if task.remote_device.is_some() { return Err("This task runs on another computer.".into()); }
    if task.cloud.is_some() { return Err("This task runs in the cloud and keeps its project.".into()); }
    if task.worktree_path.is_some() { return Err("This task works in its own worktree; it stays in its project.".into()); }
    store.db.execute("UPDATE sessions SET project_id=?2 WHERE id=?1", rusqlite::params![task_id, project_id]).map_err(|error| error.to_string())?;
    Ok(())
}

/// Whether a task of the project works on `branch` in its own worktree (renaming or deleting it would break that task).
pub fn branch_in_use(store: &crate::storage::Store, project_id: &str, branch: &str) -> bool {
    store.db.query_row("SELECT EXISTS(SELECT 1 FROM sessions WHERE project_id=?1 AND worktree_branch=?2)", rusqlite::params![project_id, branch], |row| row.get::<_, bool>(0)).unwrap_or(false)
}

// ---- The app -------------------------------------------------------------------------------------------------------------

pub fn state(app: &tauri::AppHandle) -> Option<tauri::State<'_, WorkspaceProjects>> { use tauri::Manager; app.try_state::<WorkspaceProjects>() }

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

fn granted(app: &tauri::AppHandle, owner: &str, version: &str, permission: &str, project: Option<&str>) -> bool {
    use tauri::Manager;
    let target = project.map_or_else(super::runtime_grants::Target::default, super::runtime_grants::Target::project);
    app.try_state::<super::runtime_grants::RuntimeGrants>().is_some_and(|grants| grants.check(owner, version, permission, &target).is_ok())
}

/// Admission against the real world: the grants file, the store.
fn admit_app(app: &tauri::AppHandle, owner: &str, version: &str, call: &str, raw: &Value) -> Result<(Admitted, String), Refusal> {
    use tauri::Manager;
    let Some(state) = app.try_state::<crate::AppState>() else { return Err("UnsupportedCapability".into()) };
    let task_project = |id: &str| state.store.lock().ok().and_then(|store| store.session(id).ok().map(|task| task.project_id));
    let project_exists = |id: &str| state.store.lock().is_ok_and(|store| store.project(id).is_ok());
    let allowed = |permission: &str, project: Option<&str>| granted(app, owner, version, permission, project);
    let admitted = admit(&World { granted: &allowed, task_project: &task_project, project_exists: &project_exists }, call, raw)?;
    let what = state.store.lock().map(|store| describe(&store, &admitted)).unwrap_or_default();
    Ok((admitted, what))
}

/// What the confirmation tells the user is about to go.
fn describe(store: &crate::storage::Store, admitted: &Admitted) -> String {
    let text = |key: &str| admitted.input.get(key).and_then(Value::as_str).unwrap_or_default();
    let task = |id: &str| store.session(id).map_or_else(|_| id.to_owned(), |task| task.title);
    match admitted.call {
        "projects.remove" => format!("Remove the project {} from PandaCode (its folder stays)", store.project(text("projectId")).map_or_else(|_| text("projectId").to_owned(), |project| project.name)),
        "tasks.remove" => format!("Delete the task {} and its history", task(text("taskId"))),
        "worktrees.remove" => format!("Remove the worktree of the task {}", task(text("worktreeId"))),
        "branches.remove" => format!("Delete the branch {}", text("branch")),
        "pulls.merge" => format!("Merge the pull request linked to the task {} ({})", task(text("taskId")), admitted.input.get("method").and_then(Value::as_str).unwrap_or("merge")),
        other => other.to_owned(),
    }
}

/// Removes the waiting confirmation when its request is dropped (the service ended while it waited).
struct Guard { app: tauri::AppHandle, id: String }
impl Drop for Guard { fn drop(&mut self) { if let Some(state) = state(&self.app) { state.confirms.forget(&self.id); } } }

/// Releases a running check slot when the request ends.
struct Running { app: tauri::AppHandle, owner: String }
impl Drop for Running { fn drop(&mut self) { if let Some(state) = state(&self.app) { state.checks.leave(&self.owner); } } }

/// Serves `workspaceProjects` `{call, input}` of the service of `request.owner`.
pub async fn serve(app: tauri::AppHandle, request: super::runtime_service_lifetime::DispatchRequest) -> Value {
    use tauri::{Emitter, Manager};
    let owner = request.owner.clone();
    let Some(state) = state(&app) else { return failure("UnsupportedCapability") };
    let Some(call) = request.params["call"].as_str().map(str::to_owned) else { return failure("InvalidShape") };
    let input = request.params["input"].clone();
    let found = { let app = app.clone(); let owner = owner.clone(); tauri::async_runtime::spawn_blocking(move || package(&app, &owner)).await.unwrap_or(Err("HostUnavailable")) };
    let (version, name) = match found { Ok(found) => found, Err(code) => return if code == "PermissionDenied" { Refusal::denied(spec_of(&call).map_or(MANAGE, |spec| spec.permission)).envelope() } else { failure(code) } };
    let admission = { let (app, owner, version, call) = (app.clone(), owner.clone(), version.clone(), call.clone()); tauri::async_runtime::spawn_blocking(move || admit_app(&app, &owner, &version, &call, &input)).await.unwrap_or(Err("HostUnavailable".into())) };
    let (admitted, what) = match admission { Ok(admitted) => admitted, Err(refusal) => return refusal.envelope() };
    let _running = if admitted.call == "projects.checks.run" {
        if let Err(code) = state.checks.enter(&owner) { return failure(code); }
        Some(Running { app: app.clone(), owner: owner.clone() })
    } else { None };
    // An irreversible action asks the user in the main window, unless the user turned the confirmation off for this package.
    if let Some(action) = admitted.confirm {
        let decision = match app.try_state::<super::runtime_grants::RuntimeGrants>().zip(app.try_state::<super::runtime_family_consents::FamilyConsents>()) {
            Some((grants, consents)) => consents.delete(&grants, &owner, action, admitted.project.as_deref(), &what),
            None => return failure("UnsupportedCapability"),
        };
        match decision {
            Err(error) => return if error == "PermissionDenied" { Refusal::denied(MANAGE).envelope() } else { failure("HostUnavailable") },
            Ok(super::runtime_family_consents::Delete::Proceed) => {}
            Ok(super::runtime_family_consents::Delete::Confirm { ticket, what }) => {
                if crate::headless::active() { return failure("HostUnavailable"); }
                let (id, receiver) = match state.confirms.begin(&owner) { Ok(opened) => opened, Err(code) => return failure(code) };
                let _guard = Guard { app: app.clone(), id: id.clone() };
                let _ = app.emit("extensions-runtime-workspace-confirm", json!({"id": id, "owner": owner, "package": name, "action": action, "what": what}));
                let accepted = match tokio::time::timeout(CONFIRM_WAIT, receiver).await { Ok(Ok(accepted)) => accepted, Ok(Err(_)) => false, Err(_) => return failure("Timeout") };
                let answered = match app.try_state::<super::runtime_grants::RuntimeGrants>().zip(app.try_state::<super::runtime_family_consents::FamilyConsents>()) {
                    Some((grants, consents)) => consents.answer(&grants, &ticket, accepted),
                    None => return failure("UnsupportedCapability"),
                };
                if let Err(error) = answered { return if error == "Cancelled" { failure("Cancelled") } else { Refusal::denied(MANAGE).envelope() }; }
            }
        }
    }
    // The permission is read again just before anything changes: a revoke or a narrowing in between changes nothing.
    let recheck = { let (app, owner, version, admitted) = (app.clone(), owner.clone(), version.clone(), admitted.clone()); tauri::async_runtime::spawn_blocking(move || package(&app, &owner).is_ok() && granted(&app, &owner, &version, admitted.permission, admitted.project.as_deref()) && (admitted.call != "tasks.move" || granted(&app, &owner, &version, admitted.permission, admitted.input.get("projectId").and_then(Value::as_str)))).await.unwrap_or(false) };
    if !recheck { return Refusal::denied(admitted.permission).envelope(); }
    let work = app.try_state::<super::runtime_grants::RuntimeGrants>().and_then(|grants| grants.begin(&owner, &version, admitted.permission, &admitted.project.as_deref().map_or_else(super::runtime_grants::Target::default, super::runtime_grants::Target::project)).ok());
    let result = execute(&app, &admitted).await;
    // A revoke while a check ran withdraws its report: a package without the grant never sees it.
    if admitted.call == "projects.checks.run" && work.as_ref().is_none_or(|work| work.is_cancelled()) { return Refusal::denied(CHECKS).envelope(); }
    match result {
        Ok(value) => { changed(&app, &admitted); ok(value) }
        Err(error) => failure(code_of(&error)),
    }
}

/// The interface reads the workspace again after a package changed it.
fn changed(app: &tauri::AppHandle, admitted: &Admitted) {
    use tauri::Emitter;
    if admitted.call == "projects.checks.run" || admitted.call == "pulls.check" { return; }
    let projects = admitted.call.starts_with("projects.");
    let _ = app.emit("extensions-runtime-workspace-changed", json!({"call": admitted.call, "projects": projects}));
    if !projects { let _ = app.emit("sessions-changed", ()); }
}

fn link_json(link: Option<crate::storage::TaskLink>) -> Value {
    link.map_or(Value::Null, |link| json!({"number": link.number, "url": link.url, "title": link.title, "state": link.state}))
}

fn branches_json(list: crate::workspace::BranchList) -> Value { serde_json::to_value(list).unwrap_or(Value::Null) }

/// Runs git for a branch operation through the bounded runner.
fn git(root: &std::path::Path, args: &[&str]) -> Result<(), String> {
    let output = crate::workspace::run_git_bounded(root, args, 64 * 1024, false, Duration::from_secs(30))?;
    crate::workspace::checked(output).map(|_| ())
}

/// Branch operations that have no command of their own: create, rename and delete (blocking).
fn branch_operation(app: &tauri::AppHandle, admitted: &Admitted) -> Result<Value, String> {
    use tauri::Manager;
    let state = app.state::<crate::AppState>();
    let text = |key: &str| admitted.input.get(key).and_then(Value::as_str).unwrap_or_default().to_owned();
    let flag = |key: &str| admitted.input.get(key).and_then(Value::as_bool).unwrap_or(false);
    let project = text("projectId");
    let task = admitted.input.get("taskId").and_then(Value::as_str).map(str::to_owned);
    let root = state.root(&project, task.as_deref())?;
    let trust = crate::workspace::Trust::Desktop;
    let list = crate::workspace::git_branches(&root, trust)?;
    match admitted.call {
        "branches.create" => {
            let name = text("name");
            if list.branches.contains(&name) { return Err(format!("A branch named {name} already exists.")); }
            match admitted.input.get("from").and_then(Value::as_str) { Some(from) => git(&root, &["branch", &name, from])?, None => git(&root, &["branch", &name])? }
        }
        "branches.rename" => {
            let (from, to) = (text("from"), text("to"));
            if !list.branches.contains(&from) { return Err(format!("There is no local branch named {from}.")); }
            if list.branches.contains(&to) { return Err(format!("A branch named {to} already exists.")); }
            let in_use = { let store = state.store.lock().map_err(|error| error.to_string())?; branch_in_use(&store, &project, &from) };
            if in_use { return Err(format!("The branch {from} is used by a task's worktree.")); }
            git(&root, &["branch", "-m", &from, &to])?;
        }
        _ => {
            let branch = text("branch");
            if !list.branches.contains(&branch) { return Err(format!("There is no local branch named {branch}.")); }
            if list.current == branch { return Err(format!("The branch {branch} is checked out.")); }
            let in_use = { let store = state.store.lock().map_err(|error| error.to_string())?; branch_in_use(&store, &project, &branch) };
            if in_use { return Err(format!("The branch {branch} is used by a task's worktree.")); }
            git(&root, &["branch", if flag("force") { "-D" } else { "-d" }, &branch])?;
        }
    }
    Ok(branches_json(crate::workspace::git_branches(&root, trust)?))
}

/// Performs an admitted call through the commands the interface uses.
async fn execute(app: &tauri::AppHandle, admitted: &Admitted) -> Result<Value, String> {
    use tauri::Manager;
    let text = |key: &str| admitted.input.get(key).and_then(Value::as_str).unwrap_or_default().to_owned();
    let optional = |key: &str| admitted.input.get(key).and_then(Value::as_str).map(str::to_owned);
    let flag = |key: &str| admitted.input.get(key).and_then(Value::as_bool).unwrap_or(false);
    let project_json = |project: crate::storage::Project| json!({"projectId": project.id, "name": project.name});
    match admitted.call {
        "projects.add" => crate::add_project(app.clone(), app.state(), text("path")).await.map(project_json),
        "projects.remove" => crate::remove_project(app.clone(), app.state(), text("projectId")).await.map(|()| Value::Null),
        "projects.rename" => {
            let (app, id, name) = (app.clone(), text("projectId"), text("name"));
            crate::blocking(move || {
                let state = app.state::<crate::AppState>();
                let store = state.store.lock().map_err(|error| error.to_string())?;
                let renamed = rename_project(&store, &id, &name).map(project_json);
                renamed
            }).await
        }
        "projects.relink" => crate::relink_project(app.state(), text("projectId"), text("path")).await.map(project_json),
        "worktrees.create" => {
            let created = crate::create_worktree(app.state(), text("taskId"), text("branch"), optional("base"), Some(flag("existing"))).await?;
            Ok(json!({"worktreeId": created.id, "taskId": created.id, "projectId": created.project_id, "branch": created.worktree_branch}))
        }
        "worktrees.remove" => {
            let removed = crate::remove_task_worktree(&app.state::<crate::AppState>(), text("worktreeId"), flag("deleteBranch"), crate::workspace::Trust::Desktop).await?;
            serde_json::to_value(removed).map_err(|error| error.to_string())
        }
        "worktrees.recreate" => { let task = crate::recreate_worktree(app.state(), text("worktreeId")).await?; Ok(json!({"worktreeId": task.id, "branch": task.worktree_branch})) }
        "worktrees.merge" => serde_json::to_value(crate::merge_worktree(app.state(), text("worktreeId")).await?).map_err(|error| error.to_string()),
        "branches.switch" => {
            let task = optional("taskId");
            let list = crate::switch_branch(&app.state::<crate::AppState>(), &text("projectId"), task.as_deref(), text("branch"), crate::workspace::Trust::Desktop).await?;
            Ok(branches_json(list))
        }
        "branches.create" | "branches.rename" | "branches.remove" => {
            let (app_handle, owned) = (app.clone(), admitted.clone());
            let list = crate::blocking(move || branch_operation(&app_handle, &owned)).await?;
            if admitted.call == "branches.create" && flag("switch") {
                let task = optional("taskId");
                return crate::switch_branch(&app.state::<crate::AppState>(), &text("projectId"), task.as_deref(), text("name"), crate::workspace::Trust::Desktop).await.map(branches_json);
            }
            Ok(list)
        }
        "tasks.remove" => match app.get_webview_window("main") { Some(window) => crate::delete_session_with_attachment_cleanup(app.clone(), window, text("taskId")).await, None => Err("The main window is not available.".into()) }.map(|deleted| json!({"taskIds": deleted.deleted_session_ids})),
        "tasks.rename" => crate::update_session(app.clone(), app.state(), text("taskId"), Some(text("title").trim().to_owned()), None, None, None).await.map(|()| Value::Null),
        "tasks.move" => {
            let (app_handle, task, project) = (app.clone(), text("taskId"), text("projectId"));
            crate::blocking(move || {
                let state = app_handle.state::<crate::AppState>();
                let store = state.store.lock().map_err(|error| error.to_string())?;
                move_task(&store, &task, &project)?;
                drop(store);
                crate::providers::discard_warm_agent(&task);
                Ok(json!({"taskId": task, "projectId": project}))
            }).await
        }
        "pulls.link" => crate::github_link_pull_request(app.state(), text("taskId"), text("reference")).await.map(|task| link_json(task.pull_request)),
        "pulls.unlink" => {
            let (app_handle, task) = (app.clone(), text("taskId"));
            crate::blocking(move || {
                let state = app_handle.state::<crate::AppState>();
                let store = state.store.lock().map_err(|error| error.to_string())?;
                let unlinked = store.set_task_link(&task, "pull", None).map(|_| Value::Null);
                unlinked
            }).await
        }
        "pulls.check" => {
            let detail = serde_json::to_value(crate::github_pull_request(app.state(), text("taskId")).await?).map_err(|error| error.to_string())?;
            let pick: Map<String, Value> = ["number", "title", "state", "url", "base", "head", "mergeable", "reviewDecision", "mergedAt", "checks"].iter().filter_map(|key| detail.get(*key).map(|value| ((*key).to_owned(), value.clone()))).collect();
            Ok(Value::Object(pick))
        }
        "pulls.merge" => crate::github_merge_pull_request(app.state(), text("taskId"), optional("method").unwrap_or_else(|| "merge".into())).await.map(|task| link_json(task.pull_request)),
        "projects.checks.run" => crate::run_turn_checks(app.state(), text("taskId")).await.map(|report| json!({"schemaVersion": SCHEMA_VERSION, "report": report})),
        _ => Err("Unsupported call.".into()),
    }
}

/// The service of `owner` stopped (disable, revoke, uninstall, safe mode, crash, quit): its waiting confirmations change
/// nothing and leave the window.
pub fn service_stopped(app: &tauri::AppHandle, owner: &str) {
    use tauri::Emitter;
    if let Some(state) = state(app) { for id in state.confirms.cancel_owner(owner) { let _ = app.emit("extensions-runtime-workspace-confirm-close", json!({"id": id})); } }
}

/// The main window answers a confirmation: `accepted` is the user's choice.
#[tauri::command]
pub fn extensions_runtime_workspace_confirm_answer(window: tauri::WebviewWindow, app: tauri::AppHandle, id: String, accepted: bool) -> Result<(), String> {
    if crate::headless::active() || window.label() != "main" { return Err("PermissionDenied".into()); }
    let Some(state) = state(&app) else { return Err("UnsupportedCapability".into()) };
    state.confirms.answer(&id, accepted).map_err(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    const OWNER: &str = "sample.runtime-workspace-projects";

    struct Fixed { allowed: Vec<(&'static str, Option<&'static str>)>, tasks: Vec<(&'static str, &'static str)>, projects: Vec<&'static str> }
    fn admit_with(fixed: &Fixed, call: &str, raw: Value) -> Result<Admitted, Refusal> {
        let granted = |permission: &str, project: Option<&str>| fixed.allowed.iter().any(|(name, scope)| *name == permission && (scope.is_none() || *scope == project));
        let task_project = |id: &str| fixed.tasks.iter().find(|(task, _)| *task == id).map(|(_, project)| (*project).to_owned());
        let project_exists = |id: &str| fixed.projects.contains(&id);
        admit(&World { granted: &granted, task_project: &task_project, project_exists: &project_exists }, call, &raw)
    }
    fn everything() -> Fixed { Fixed { allowed: vec![(MANAGE, None), (CHECKS, None)], tasks: vec![("t1", "A"), ("t2", "B")], projects: vec!["A", "B"] } }
    fn only(project: &'static str) -> Fixed { Fixed { allowed: vec![(MANAGE, Some(project)), (CHECKS, Some(project))], ..everything() } }
    fn code(result: Result<Admitted, Refusal>) -> String { result.unwrap_err().code }

    /// One allowed call per method with the input the native shape takes.
    fn sample(call: &str) -> Value {
        match call {
            "projects.add" => json!({"path": "C:/work/new-project"}),
            "projects.remove" => json!({"projectId": "A"}),
            "projects.rename" => json!({"projectId": "A", "name": "Renamed"}),
            "projects.relink" => json!({"projectId": "A", "path": "C:/work/moved"}),
            "worktrees.create" => json!({"taskId": "t1", "branch": "feature/x", "base": "main", "existing": false}),
            "worktrees.remove" => json!({"worktreeId": "t1", "deleteBranch": true}),
            "worktrees.recreate" | "worktrees.merge" => json!({"worktreeId": "t1"}),
            "branches.create" => json!({"projectId": "A", "taskId": "t1", "name": "topic", "from": "main", "switch": true}),
            "branches.switch" => json!({"projectId": "A", "branch": "main"}),
            "branches.rename" => json!({"projectId": "A", "from": "topic", "to": "topic-2"}),
            "branches.remove" => json!({"projectId": "A", "branch": "topic", "force": false}),
            "tasks.rename" => json!({"taskId": "t1", "title": "A new title"}),
            "tasks.move" => json!({"taskId": "t1", "projectId": "B"}),
            "pulls.link" => json!({"taskId": "t1", "reference": "#12"}),
            "pulls.merge" => json!({"taskId": "t1", "method": "squash"}),
            _ => json!({"taskId": "t1"}),
        }
    }

    #[test]
    fn every_call_has_one_allowed_shape_and_none_is_left_to_the_host() {
        assert_eq!(SPECS.len(), 20);
        for spec in SPECS {
            let admitted = admit_with(&everything(), spec.call, sample(spec.call)).unwrap_or_else(|refusal| panic!("{}: {refusal:?}", spec.call));
            assert_eq!((admitted.call, admitted.permission), (spec.call, spec.permission));
        }
        // The check is its own permission; every other call is workspace.manage.
        assert!(SPECS.iter().all(|spec| (spec.call == "projects.checks.run") == (spec.permission == CHECKS)));
        assert_eq!(code(admit_with(&everything(), "projects.pair", json!({}))), "UnsupportedCapability");
        for name in ["pairing", "remote.access", "workspace.pair", "projects.trust"] { assert_eq!(code(admit_with(&everything(), name, json!({}))), "UnsupportedCapability", "{name}"); }
    }

    #[test]
    fn the_project_a_call_touches_decides_the_permission_and_a_missing_grant_names_it() {
        let fixed = only("A");
        assert_eq!(admit_with(&fixed, "tasks.rename", sample("tasks.rename")).unwrap().project.as_deref(), Some("A"));
        for (call, raw) in [("tasks.rename", json!({"taskId": "t2", "title": "x"})), ("projects.remove", json!({"projectId": "B"})), ("branches.switch", json!({"projectId": "B", "branch": "main"})), ("pulls.check", json!({"taskId": "t2"})), ("projects.checks.run", json!({"taskId": "t2"}))] {
            let refusal = admit_with(&fixed, call, raw).unwrap_err();
            assert_eq!(refusal.code, "PermissionDenied", "{call}");
            assert_eq!(refusal.path, spec_of(call).unwrap().permission, "{call}");
        }
        // A project that is not there is only NotFound for a package that may touch every project: the grant answers first.
        assert_eq!(code(admit_with(&everything(), "projects.remove", json!({"projectId": "ghost"}))), "NotFound");
        assert_eq!(code(admit_with(&fixed, "projects.remove", json!({"projectId": "ghost"}))), "PermissionDenied");
        assert_eq!(code(admit_with(&everything(), "tasks.remove", json!({"taskId": "ghost"}))), "NotFound");
        assert_eq!(code(admit_with(&fixed, "tasks.remove", json!({"taskId": "ghost"}))), "PermissionDenied");
        // Adding a project has no project yet: only a grant for every project covers it.
        assert_eq!(code(admit_with(&fixed, "projects.add", sample("projects.add"))), "PermissionDenied");
        // Moving a task needs both projects.
        assert_eq!(code(admit_with(&fixed, "tasks.move", json!({"taskId": "t1", "projectId": "B"}))), "PermissionDenied");
        assert_eq!(code(admit_with(&everything(), "tasks.move", json!({"taskId": "t1", "projectId": "ghost"}))), "NotFound");
        // The checks permission is independent of workspace.manage and the other way round.
        let manage_only = Fixed { allowed: vec![(MANAGE, None)], ..everything() };
        assert_eq!(admit_with(&manage_only, "projects.checks.run", json!({"taskId": "t1"})).unwrap_err().path, CHECKS);
        let checks_only = Fixed { allowed: vec![(CHECKS, None)], ..everything() };
        assert_eq!(admit_with(&checks_only, "projects.checks.run", json!({"taskId": "t1"})).unwrap().permission, CHECKS);
        assert_eq!(code(admit_with(&checks_only, "tasks.rename", sample("tasks.rename"))), "PermissionDenied");
    }

    #[test]
    fn shapes_are_refused_with_their_reason_and_a_pairing_or_trust_key_is_never_read() {
        let fixed = everything();
        for (call, raw, expected) in [
            ("projects.add", json!("C:/x"), "InvalidShape"), ("projects.add", json!({}), "InvalidShape"), ("projects.add", json!({"path": 3}), "InvalidShape"), ("projects.add", json!({"path": "  "}), "InvalidShape"),
            ("projects.add", json!({"path": "C:/x", "pair": "studio"}), "InvalidShape"), ("projects.add", json!({"path": "C:/x", "remoteAccess": true}), "InvalidShape"), ("projects.add", json!({"path": "C:/x", "trusted": true}), "InvalidShape"),
            ("projects.add", json!({"path": "x".repeat(MAX_PATH + 1)}), "LimitExceeded"), ("projects.rename", json!({"projectId": "A", "name": "a\nb"}), "InvalidShape"), ("projects.rename", json!({"projectId": "A", "name": "n".repeat(MAX_NAME + 1)}), "LimitExceeded"),
            ("projects.remove", json!({"projectId": ""}), "InvalidShape"), ("projects.remove", json!({"projectId": 7}), "InvalidShape"), ("projects.remove", json!({"projectId": "A", "confirmed": true}), "InvalidShape"),
            ("worktrees.create", json!({"taskId": "t1", "branch": "../evil"}), "InvalidShape"), ("worktrees.create", json!({"taskId": "t1", "branch": "ok", "base": "--upload-pack=x"}), "InvalidShape"), ("worktrees.create", json!({"taskId": "t1", "branch": "ok", "existing": "yes"}), "InvalidShape"),
            ("worktrees.remove", json!({"worktreeId": "t1", "deleteBranch": 1}), "InvalidShape"),
            ("branches.create", json!({"projectId": "A", "name": "-D"}), "InvalidShape"), ("branches.create", json!({"projectId": "A", "name": "a b"}), "InvalidShape"), ("branches.create", json!({"projectId": "A", "name": "x.lock"}), "InvalidShape"),
            ("branches.rename", json!({"projectId": "A", "from": "a", "to": "a"}), "InvalidShape"), ("branches.remove", json!({"projectId": "A", "branch": "a", "force": "yes"}), "InvalidShape"),
            ("tasks.rename", json!({"taskId": "t1", "title": " "}), "InvalidShape"), ("tasks.rename", json!({"taskId": "t1", "title": "t".repeat(MAX_NAME + 1)}), "LimitExceeded"),
            ("pulls.link", json!({"taskId": "t1", "reference": "r".repeat(MAX_REFERENCE + 1)}), "LimitExceeded"), ("pulls.merge", json!({"taskId": "t1", "method": "fast-forward"}), "InvalidShape"),
            ("projects.checks.run", json!({"taskId": "t1", "command": "rm -rf /"}), "InvalidShape"), ("projects.checks.run", json!({}), "InvalidShape"),
        ] { assert_eq!(code(admit_with(&fixed, call, raw.clone())), expected, "{call} {raw}"); }
    }

    #[test]
    fn only_the_irreversible_actions_confirm_and_each_names_the_frozen_action() {
        let confirming: Vec<(&str, Option<&str>)> = SPECS.iter().map(|spec| (spec.call, spec.confirm)).filter(|(_, confirm)| confirm.is_some()).collect();
        assert_eq!(confirming, vec![("projects.remove", Some("projects.remove")), ("worktrees.remove", Some("worktrees.remove")), ("branches.remove", Some("branches.remove")), ("tasks.remove", Some("tasks.remove")), ("pulls.merge", Some("pulls.merge"))]);
        assert!(admit_with(&everything(), "worktrees.merge", sample("worktrees.merge")).unwrap().confirm.is_none());
        assert!(admit_with(&everything(), "projects.checks.run", sample("projects.checks.run")).unwrap().confirm.is_none());
    }

    #[test]
    fn host_failures_map_to_frozen_codes_and_nothing_of_the_text_survives() {
        for (text, expected) in [
            ("Stop this project's agents first.", "Conflict"), ("A branch named x already exists.", "Conflict"), ("The branch main is checked out.", "Conflict"), ("error: the branch 'x' is not fully merged", "Conflict"), ("Stop the agent before removing its worktree.", "Conflict"),
            ("There is no local branch named x.", "NotFound"), ("Unknown", "NotFound"), ("This task has no linked pull request.", "NotFound"), ("This task uses the main checkout.", "NotFound"), ("fatal: not a valid object name", "NotFound"),
            ("This task runs on Studio.", "UnsupportedCapability"), ("Choose squash, merge or rebase.", "InvalidShape"), ("Choose a folder.", "InvalidShape"), ("The name must be 1–200 characters.", "InvalidShape"),
            ("disk exploded", "HostUnavailable"),
        ] { assert_eq!(code_of(text), expected, "{text}"); }
        assert_eq!(Refusal::new("NotFound").envelope()["error"]["ids"], json!([]));
        assert_eq!(failure_with("PermissionDenied", MANAGE, &[]), json!({"ok": false, "error": {"schemaVersion": 1, "code": "PermissionDenied", "path": "workspace.manage", "ids": []}}));
    }

    #[test]
    fn branch_and_reference_names_cannot_pose_as_options_or_leave_the_namespace() {
        for good in ["main", "feature/x", "pandacode/fix-12", "release_1.2"] { assert!(branch_ok(good), "{good}"); }
        for bad in ["", "-x", "--help", "/x", ".x", "x/", "x.", "a..b", "a//b", "a b", "a:b", "a~1", "x.lock", &"x".repeat(MAX_BRANCH + 1)] { assert!(!branch_ok(bad), "{bad}"); }
        assert!(ref_ok("origin/main") && ref_ok("v1.2.3") && !ref_ok("-x") && !ref_ok("a..b") && !ref_ok("HEAD~2"));
    }

    #[test]
    fn a_confirmation_waits_once_answers_once_and_ends_with_the_service() {
        let slots = ConfirmSlots::default();
        let mut opened = vec![];
        for _ in 0..MAX_WAITING { opened.push(slots.begin(OWNER).unwrap()); }
        assert_eq!(slots.begin(OWNER).unwrap_err(), "LimitExceeded");
        assert!(slots.begin("sample.other").is_ok(), "another package has its own four");
        let (first, mut receiver) = opened.remove(0);
        slots.answer(&first, false).unwrap();
        assert_eq!(receiver.try_recv().unwrap(), false);
        assert_eq!(slots.answer(&first, true).unwrap_err(), "NotFound", "an answer is taken once");
        let ids = slots.cancel_owner(OWNER);
        assert_eq!(ids.len(), 3);
        for (_, mut receiver) in opened { assert_eq!(receiver.try_recv().unwrap(), false, "a service that ends changes nothing"); }
        assert_eq!(slots.count(OWNER), 0);
        let (id, _receiver) = slots.begin(OWNER).unwrap();
        assert!(slots.forget(&id) && !slots.forget(&id));
    }

    #[test]
    fn two_checks_run_at_once_per_package_and_the_slot_is_given_back() {
        let gate = CheckGate::default();
        gate.enter(OWNER).unwrap(); gate.enter(OWNER).unwrap();
        assert_eq!(gate.enter(OWNER).unwrap_err(), "LimitExceeded");
        gate.enter("sample.other").unwrap();
        gate.leave(OWNER);
        assert_eq!((gate.count(OWNER), gate.enter(OWNER).is_ok()), (1, true));
        gate.leave(OWNER); gate.leave(OWNER); gate.leave(OWNER);
        assert_eq!(gate.count(OWNER), 0);
    }

    #[test]
    fn a_project_is_renamed_and_a_task_moves_only_where_its_checkout_allows() {
        let (state, first) = crate::concurrent_task_tests::test_state();
        let store = state.store.lock().unwrap();
        let second_dir = std::env::temp_dir().join(format!("pandacode-r0405-{}", std::process::id()));
        std::fs::create_dir_all(&second_dir).unwrap();
        let second = store.add_project(&second_dir).unwrap();
        let renamed = rename_project(&store, &first, "  Renamed  ").unwrap();
        assert_eq!((renamed.name.as_str(), store.project(&first).unwrap().name.as_str()), ("Renamed", "Renamed"));
        for bad in ["", "   ", "a\nb", &"n".repeat(MAX_NAME + 1)] { assert!(rename_project(&store, &first, bad).is_err(), "{bad:?}"); }
        assert!(rename_project(&store, "ghost", "x").is_err());
        let task = store.create_session(&first, "codex", "default", "ask").unwrap().id;
        move_task(&store, &task, &second.id).unwrap();
        assert_eq!(store.session(&task).unwrap().project_id, second.id);
        move_task(&store, &task, &second.id).unwrap();
        assert!(move_task(&store, &task, "ghost").is_err());
        assert!(move_task(&store, "ghost", &first).is_err());
        store.db.execute("UPDATE sessions SET worktree_path='C:/wt',worktree_branch='pandacode/x' WHERE id=?1", [&task]).unwrap();
        assert!(move_task(&store, &task, &first).unwrap_err().contains("own worktree"));
        assert!(branch_in_use(&store, &second.id, "pandacode/x") && !branch_in_use(&store, &first, "pandacode/x") && !branch_in_use(&store, &second.id, "main"));
        store.db.execute("UPDATE sessions SET worktree_path=NULL,worktree_branch=NULL,status='running' WHERE id=?1", [&task]).unwrap();
        assert!(move_task(&store, &task, &first).unwrap_err().contains("Stop this task"));
        drop(store);
        let _ = std::fs::remove_dir_all(&second_dir);
    }
}
