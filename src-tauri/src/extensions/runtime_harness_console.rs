//! Harness consoles and command-center actions (`harness.console`, runtime phase R4, slice R0408).
//!
//! A trusted service opens the interactive console of a task's harness with `panda.harnesses.console.open`, lists the
//! commands a harness offers with `panda.harnesses.commands.list` and runs one on a task with
//! `panda.harnesses.commands.run`. Nothing here is a second implementation: the console is the one the user opens (the
//! terminal panel with the harness CLI), the list is the slash catalog the command center shows, and a command runs through
//! the same `resolve_slash_command` and the same action path as a command the user typed, with the same arguments. The
//! action carries the package name, so the window says who did it.
//!
//! The permission `harness.console` is project scoped and rechecked natively on every request; a package that holds it is
//! never asked again per action (ADR-0005). The refusals are the frozen ones:
//! - no grant, a revoked grant, a disabled package or a project outside the narrowed scope: `PermissionDenied`, with the
//!   permission name in `path`; a package that holds the permission for no project learns nothing about tasks;
//! - an unknown or removed task, project or command: `NotFound`;
//! - a harness without an interactive console (a package provider has none, `docs/extensions/providers.md`): `UnsupportedCapability`;
//! - a command or arguments the call does not take: `InvalidShape`; a size bound: `LimitExceeded`;
//! - a running task (the console needs it stopped, as for the user): `Busy`.
//!
//! The console and the command live in the main window, so `open` and `run` are one round answered by the window after the
//! host has checked the grant, the task, the harness and the command. The permission is read again just before the round
//! is sent: a revoke or a disable in between opens no console and runs nothing. `list` is answered natively from the cached
//! catalog (no harness is started). Rules for predictability and fault isolation, never for trust: four rounds waiting for
//! the window per package and a 15 s bound on its answer. The state is pure (an injected world) so the rules are
//! deterministic to test.
use serde_json::{json, Map, Value};
use std::{collections::BTreeMap, sync::Mutex, time::Duration};
use tokio::sync::oneshot;

use super::runtime_tasks_start::{failure, Refusal};

/// The named permission for every call (project scoped).
pub const PERMISSION: &str = "harness.console";
pub const COMMAND_CHARS: usize = 128;
pub const ARGUMENT_CHARS: usize = 4096;
pub const MAX_WAITING: usize = 4;
pub const WAIT: Duration = Duration::from_secs(15);
/// Refusal codes a window answer may carry; anything else is read as `InvalidShape`.
const WINDOW_CODES: [&str; 8] = ["NotFound", "Busy", "StaleContext", "InvalidShape", "HostUnavailable", "UnsupportedCapability", "Revoked", "Timeout"];

fn ident(text: &str) -> bool { !text.is_empty() && text.chars().count() <= 128 && !text.chars().any(char::is_control) }
fn denied() -> Refusal { Refusal { code: "PermissionDenied".into(), path: PERMISSION.into(), ids: vec![] } }

/// Which console to open: the one of a task, or one of a harness for a project.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Open { Task(String), Harness { harness: String, project: String } }

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Request {
    Open(Open),
    List { harness: String },
    Run { task: String, command: String, arguments: String },
}
impl Request {
    pub fn name(&self) -> &'static str { match self { Request::Open(_) => "open", Request::List { .. } => "list", Request::Run { .. } => "run" } }
}

fn only(object: &Map<String, Value>, keys: &[&str]) -> Result<(), Refusal> {
    if object.keys().any(|key| key != "op" && !keys.contains(&key.as_str())) { Err("InvalidShape".into()) } else { Ok(()) }
}
fn id(object: &Map<String, Value>, key: &str) -> Result<Option<String>, Refusal> {
    match object.get(key) { None => Ok(None), Some(Value::String(text)) if ident(text) => Ok(Some(text.clone())), Some(_) => Err("InvalidShape".into()) }
}

/// A command is one slash command name, as the catalog lists it (`/compact`); the slash may be left out.
pub fn read_command(text: &str) -> Result<String, Refusal> {
    let name = text.strip_prefix('/').unwrap_or(text);
    if name.is_empty() || name.chars().any(|c| !(c.is_alphanumeric() || matches!(c, '_' | ':' | '.' | '-'))) { return Err("InvalidShape".into()); }
    if name.chars().count() > COMMAND_CHARS { return Err("LimitExceeded".into()); }
    Ok(format!("/{name}"))
}

/// Reads a call: `{op: "open", taskId | harness + projectId}`, `{op: "list", harness}` or `{op: "run", taskId, command, arguments?}`.
/// Nothing is looked up here.
pub fn read_request(raw: &Value) -> Result<Request, Refusal> {
    let object = raw.as_object().ok_or("InvalidShape")?;
    match object.get("op").and_then(Value::as_str) {
        Some("open") => {
            only(object, &["taskId", "harness", "projectId"])?;
            match (id(object, "taskId")?, id(object, "harness")?, id(object, "projectId")?) {
                (Some(task), None, None) => Ok(Request::Open(Open::Task(task))),
                (None, Some(harness), Some(project)) => Ok(Request::Open(Open::Harness { harness, project })),
                _ => Err("InvalidShape".into()),
            }
        }
        Some("list") => { only(object, &["harness"])?; Ok(Request::List { harness: id(object, "harness")?.ok_or("InvalidShape")? }) }
        Some("run") => {
            only(object, &["taskId", "command", "arguments"])?;
            let command = read_command(object.get("command").and_then(Value::as_str).ok_or("InvalidShape")?)?;
            let arguments = match object.get("arguments") {
                None | Some(Value::Null) => String::new(),
                Some(Value::String(text)) => text.trim().to_owned(),
                Some(_) => return Err("InvalidShape".into()),
            };
            if arguments.chars().any(char::is_control) { return Err("InvalidShape".into()); }
            if arguments.chars().count() > ARGUMENT_CHARS { return Err("LimitExceeded".into()); }
            Ok(Request::Run { task: id(object, "taskId")?.ok_or("InvalidShape")?, command, arguments })
        }
        _ => Err("InvalidShape".into()),
    }
}

/// The grant for the project of the target. `holds` is "the package holds this permission for any project": without it
/// the answer is the permission itself whatever the target, so a refusal never says whether a task exists.
pub fn gate(holds: bool, project: Option<&str>, granted: &dyn Fn(&str) -> bool) -> Result<String, Refusal> {
    if !holds { return Err(denied()); }
    match project { None => Err("NotFound".into()), Some(project) if granted(project) => Ok(project.to_owned()), Some(_) => Err(denied()) }
}

/// Whether the harness has an interactive console. A package provider has none: `UnsupportedCapability`, and an unknown id
/// is `NotFound`. `known` and `console` are the providers' own answers (`validate_identity`, `require_console`).
pub fn console_support(known: Result<(), String>, console: Result<(), String>) -> Result<(), Refusal> {
    if known.is_err() { return Err("NotFound".into()); }
    console.map_err(|_| Refusal::new("UnsupportedCapability"))
}

/// What a failed resolution of a command means: a console-only command of a package provider is `UnsupportedCapability`
/// (the core-managed console it would need does not exist); anything else the catalog does not know is `NotFound`.
pub fn resolution_refusal(error: &str) -> Refusal {
    if error.starts_with("UnsupportedCapability") { Refusal::new("UnsupportedCapability") } else { Refusal::new("NotFound") }
}

/// The list the command center shows, as `{id, title}`: the catalog's own names, without the ones that cannot run.
pub fn list_value(commands: &[(String, String, String)]) -> Value {
    Value::Array(commands.iter().filter(|(_, _, kind)| kind != "unsupported").map(|(name, description, _)| {
        json!({"id": name, "title": if description.trim().is_empty() { name.as_str() } else { description.trim() }})
    }).collect())
}

/// Reads the window's refusal; a code outside the frozen list is `InvalidShape`.
pub fn read_refusal(answer: &Value) -> Refusal {
    match answer["code"].as_str() { Some(code) if WINDOW_CODES.contains(&code) => Refusal::new(code), _ => Refusal::new("InvalidShape") }
}

/// The round for the window: `open` of a console or `run` of a command, with the package that asked.
pub fn round_payload(request: &Request, task: Option<&str>, project: &str, provider: &str, owner: &str) -> Value {
    let mut payload = json!({"op": request.name(), "projectId": project, "harness": provider, "package": owner});
    if let Some(task) = task { payload["taskId"] = json!(task); }
    if let Request::Run { command, arguments, .. } = request { payload["command"] = json!(command); payload["arguments"] = json!(arguments); }
    payload
}

/// What the window answered: `null` for an opened console or a command that ran.
pub fn read_answer(answer: &Value) -> Result<Value, Refusal> {
    if answer["ok"] == true { Ok(Value::Null) } else { Err(read_refusal(answer)) }
}

// ---- Rounds waiting for the window -----------------------------------------------------------------------------------

struct Waiting { owner: String, sender: Option<oneshot::Sender<Value>> }
#[derive(Default)]
struct Slots { waiting: BTreeMap<String, Waiting>, serial: u64 }

/// The rounds that wait for the main window to answer.
#[derive(Default)]
pub struct ConsoleSlots { inner: Mutex<Slots> }
impl ConsoleSlots {
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Slots>, &'static str> { self.inner.lock().map_err(|_| "HostUnavailable") }
    /// A round waits: its id and the receiver the answer arrives on. A fifth one of the package is `LimitExceeded`.
    pub fn begin(&self, owner: &str) -> Result<(String, oneshot::Receiver<Value>), &'static str> {
        let mut slots = self.lock()?;
        if slots.waiting.values().filter(|waiting| waiting.owner == owner).count() >= MAX_WAITING { return Err("LimitExceeded"); }
        slots.serial += 1;
        let id = format!("{owner}#console-{}", slots.serial);
        let (sender, receiver) = oneshot::channel();
        slots.waiting.insert(id.clone(), Waiting { owner: owner.to_owned(), sender: Some(sender) });
        Ok((id, receiver))
    }
    /// The window answers round `id`. An answer for a round that is gone (answered, timed out, ended) is `NotFound`.
    pub fn answer(&self, id: &str, answer: &Value) -> Result<(), &'static str> {
        let mut slots = self.lock()?;
        let mut waiting = slots.waiting.remove(id).ok_or("NotFound")?;
        if let Some(sender) = waiting.sender.take() { let _ = sender.send(answer.clone()); }
        Ok(())
    }
    /// The package's service ended: its waiting rounds resolve as revoked and change nothing.
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

pub fn state(app: &tauri::AppHandle) -> Option<tauri::State<'_, ConsoleSlots>> { use tauri::Manager; app.try_state::<ConsoleSlots>() }

/// The enabled version of the package, or why it may not call.
fn version_of(app: &tauri::AppHandle, owner: &str) -> Result<String, &'static str> {
    use tauri::Manager;
    let packages = app.state::<crate::extensions::packages::ExtensionPackages>();
    let packages = packages.0.try_lock().map_err(|_| "Timeout")?;
    super::runtime_service_lifetime::runtime_usage_resources::enabled_version(&packages, owner).ok_or("PermissionDenied")
}

fn holds(app: &tauri::AppHandle, owner: &str, version: &str) -> bool {
    use tauri::Manager;
    app.try_state::<super::runtime_grants::RuntimeGrants>().is_some_and(|grants| grants.projection()["packages"].as_array().into_iter().flatten().any(|package| {
        package["id"] == owner && package["version"] == version && package["authorized"] == true && package["grants"].as_array().into_iter().flatten().any(|grant| grant["permission"] == PERMISSION)
    }))
}

fn granted(app: &tauri::AppHandle, owner: &str, version: &str, project: &str) -> bool {
    use tauri::Manager;
    app.try_state::<super::runtime_grants::RuntimeGrants>().is_some_and(|grants| grants.check(owner, version, PERMISSION, &super::runtime_grants::Target::project(project)).is_ok())
}

/// What the store knows of a task: its project, harness and the folder it works in.
struct TaskRow { project: String, provider: String, cwd: std::path::PathBuf, running: bool }

fn task_row(app: &tauri::AppHandle, task: &str) -> Option<TaskRow> {
    use tauri::Manager;
    let state = app.try_state::<crate::AppState>()?;
    let store = state.store.try_lock().ok()?;
    let row = store.session(task).ok()?;
    let cwd = store.workspace_root(&row.project_id, Some(task)).ok()?;
    let running = row.status == "running";
    Some(TaskRow { project: row.project_id, provider: row.provider, cwd, running })
}

fn project_exists(app: &tauri::AppHandle, project: &str) -> bool {
    use tauri::Manager;
    app.try_state::<crate::AppState>().is_some_and(|state| state.store.try_lock().is_ok_and(|store| store.project(project).is_ok()))
}

/// The newest tasks of a harness whose project the package may use, with the folder each works in.
fn recent_task_of(app: &tauri::AppHandle, harness: &str, allowed: &dyn Fn(&str) -> bool) -> Option<std::path::PathBuf> {
    use tauri::Manager;
    let state = app.try_state::<crate::AppState>()?;
    let store = state.store.try_lock().ok()?;
    let mut statement = store.db.prepare("SELECT id, project_id FROM sessions WHERE provider=?1 AND archived=0 ORDER BY updated_at DESC LIMIT 50").ok()?;
    let rows: Vec<(String, String)> = statement.query_map([harness], |row| Ok((row.get(0)?, row.get(1)?))).ok()?.filter_map(Result::ok).collect();
    rows.into_iter().find(|(_, project)| allowed(project)).and_then(|(id, project)| store.workspace_root(&project, Some(&id)).ok())
}

/// Removes the waiting round when its request is dropped (the service ended while it waited).
struct Guard { app: tauri::AppHandle, id: String }
impl Drop for Guard { fn drop(&mut self) { if let Some(slots) = state(&self.app) { slots.forget(&self.id); } } }

/// One round with the window: sends `payload` under a fresh id and waits for the answer.
async fn ask(app: &tauri::AppHandle, owner: &str, mut payload: Value) -> Result<Value, Refusal> {
    use tauri::Emitter;
    let Some(slots) = state(app) else { return Err("UnsupportedCapability".into()) };
    if crate::headless::active() { return Err("UnsupportedCapability".into()); }
    let (id, receiver) = slots.begin(owner).map_err(Refusal::new)?;
    let _guard = Guard { app: app.clone(), id: id.clone() };
    payload["id"] = json!(id);
    let _ = app.emit("extensions-runtime-console", payload);
    let answer = match tokio::time::timeout(WAIT, receiver).await { Ok(Ok(answer)) => answer, Ok(Err(_)) => return Err("Revoked".into()), Err(_) => return Err("Timeout".into()) };
    if answer["code"] == "Revoked" { return Err("Revoked".into()); }
    Ok(answer)
}

/// Serves `harnessConsole` of the service of `request.owner`.
pub async fn serve(app: tauri::AppHandle, request: super::runtime_service_lifetime::DispatchRequest) -> Value {
    let owner = request.owner.clone();
    let version = { let app = app.clone(); let owner = owner.clone(); tauri::async_runtime::spawn_blocking(move || version_of(&app, &owner)).await.unwrap_or(Err("HostUnavailable")) };
    let version = match version { Ok(version) => version, Err("PermissionDenied") => return denied().envelope(), Err(code) => return failure(code) };
    match run(&app, &owner, &version, &request.params).await { Ok(value) => json!({"ok": true, "value": value}), Err(refusal) => refusal.envelope() }
}

async fn run(app: &tauri::AppHandle, owner: &str, version: &str, params: &Value) -> Result<Value, Refusal> {
    let any = holds(app, owner, version);
    if !any { return Err(denied()); }
    let request = read_request(params)?;
    let check = |project: &str| granted(app, owner, version, project);
    match &request {
        Request::List { harness } => {
            crate::extensions::providers::validate_identity(harness).map_err(|_| Refusal::new("NotFound"))?;
            let (app2, harness2) = (app.clone(), harness.clone());
            let owner2 = owner.to_owned(); let version2 = version.to_owned();
            let cwd = tauri::async_runtime::spawn_blocking(move || recent_task_of(&app2, &harness2, &|project| granted(&app2, &owner2, &version2, project))).await.unwrap_or(None);
            // A harness the package has no task of, in a project it may use, has no commands to show it.
            let Some(cwd) = cwd else { return Ok(json!([])) };
            let catalog = crate::slash_commands::snapshot(harness, &cwd).await.map_err(|_| Refusal::new("HostUnavailable"))?;
            let rows: Vec<(String, String, String)> = catalog.commands.iter().map(|command| (command.name.clone(), command.description.clone(), command.kind.clone())).collect();
            Ok(list_value(&rows))
        }
        Request::Open(Open::Harness { harness, project }) => {
            let project = { let app = app.clone(); let project = project.clone(); tauri::async_runtime::spawn_blocking(move || project_exists(&app, &project).then_some(project)).await.unwrap_or(None) };
            let project = gate(any, project.as_deref(), &check)?;
            console_support(crate::extensions::providers::validate_identity(harness), crate::extensions::providers::require_console(harness))?;
            deliver(app, owner, version, &request, None, &project, harness).await
        }
        Request::Open(Open::Task(task)) | Request::Run { task, .. } => {
            let row = { let app = app.clone(); let task = task.clone(); tauri::async_runtime::spawn_blocking(move || task_row(&app, &task)).await.unwrap_or(None) };
            let project = gate(any, row.as_ref().map(|row| row.project.as_str()), &check)?;
            let row = row.ok_or("NotFound")?;
            if let Request::Run { command, arguments, .. } = &request {
                // The command must be one the harness offers, resolved the way a typed command is.
                let text = if arguments.is_empty() { command.clone() } else { format!("{command} {arguments}") };
                if let Err(error) = crate::slash_commands::resolve(&row.provider, &row.cwd, &text).await { return Err(resolution_refusal(&error)); }
            } else {
                console_support(crate::extensions::providers::validate_identity(&row.provider), crate::extensions::providers::require_console(&row.provider))?;
                if row.running { return Err("Busy".into()); }
            }
            deliver(app, owner, version, &request, Some(task), &project, &row.provider).await
        }
    }
}

/// The permission is read again just before the window is asked: a revoke, a narrowing or a disable in between opens and
/// runs nothing.
async fn deliver(app: &tauri::AppHandle, owner: &str, version: &str, request: &Request, task: Option<&String>, project: &str, provider: &str) -> Result<Value, Refusal> {
    use tauri::Manager;
    let work = app.try_state::<super::runtime_grants::RuntimeGrants>().ok_or("HostUnavailable")?.begin(owner, version, PERMISSION, &super::runtime_grants::Target::project(project)).map_err(|_| denied())?;
    if version_of(app, owner).is_err() || !granted(app, owner, version, project) || work.is_cancelled() { return Err(denied()); }
    let answer = ask(app, owner, round_payload(request, task.map(String::as_str), project, provider, owner)).await?;
    read_answer(&answer)
}

/// The service of `owner` stopped (disable, revoke, uninstall, safe mode, crash, quit): its waiting rounds change nothing.
pub fn service_stopped(app: &tauri::AppHandle, owner: &str) {
    if let Some(slots) = state(app) { slots.cancel_owner(owner); }
}

/// The main window answers a round (`open`, `run`).
#[tauri::command]
pub fn extensions_runtime_console_answer(window: tauri::WebviewWindow, app: tauri::AppHandle, id: String, answer: Value) -> Result<(), String> {
    if crate::headless::active() || window.label() != "main" { return Err("PermissionDenied".into()); }
    let Some(slots) = state(&app) else { return Err("UnsupportedCapability".into()) };
    slots.answer(&id, &answer).map_err(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn code<T: std::fmt::Debug>(result: Result<T, Refusal>) -> String { result.unwrap_err().code }

    #[test]
    fn every_call_reads_its_target_and_refuses_the_rest_as_invalid_shape() {
        assert_eq!(read_request(&json!({"op": "open", "taskId": "t1"})).unwrap(), Request::Open(Open::Task("t1".into())));
        assert_eq!(read_request(&json!({"op": "open", "harness": "codex", "projectId": "p1"})).unwrap(), Request::Open(Open::Harness { harness: "codex".into(), project: "p1".into() }));
        assert_eq!(read_request(&json!({"op": "list", "harness": "codex"})).unwrap(), Request::List { harness: "codex".into() });
        assert_eq!(read_request(&json!({"op": "run", "taskId": "t1", "command": "/compact"})).unwrap(), Request::Run { task: "t1".into(), command: "/compact".into(), arguments: String::new() });
        assert_eq!(read_request(&json!({"op": "run", "taskId": "t1", "command": "model", "arguments": "  gpt-5 "})).unwrap(), Request::Run { task: "t1".into(), command: "/model".into(), arguments: "gpt-5".into() });
        for raw in [
            json!("x"), json!({}), json!({"op": "close", "taskId": "t1"}), json!({"op": "open"}), json!({"op": "open", "taskId": "t1", "harness": "codex"}), json!({"op": "open", "harness": "codex"}),
            json!({"op": "open", "taskId": "t1", "send": true}), json!({"op": "list"}), json!({"op": "list", "harness": "codex", "taskId": "t1"}), json!({"op": "run", "taskId": "t1"}),
            json!({"op": "run", "command": "/x"}), json!({"op": "run", "taskId": "t1", "command": ""}), json!({"op": "run", "taskId": "t1", "command": "/a b"}), json!({"op": "run", "taskId": "t1", "command": "/x; rm"}),
            json!({"op": "run", "taskId": "t1", "command": "/x", "arguments": 3}), json!({"op": "run", "taskId": "t1", "command": "/x", "arguments": "a\nb"}), json!({"op": "open", "taskId": ""}),
        ] { assert_eq!(code(read_request(&raw)), "InvalidShape", "{raw}"); }
        assert_eq!(code(read_request(&json!({"op": "run", "taskId": "t1", "command": format!("/{}", "c".repeat(COMMAND_CHARS + 1))}))), "LimitExceeded");
        assert_eq!(code(read_request(&json!({"op": "run", "taskId": "t1", "command": "/x", "arguments": "a".repeat(ARGUMENT_CHARS + 1)}))), "LimitExceeded");
    }

    #[test]
    fn the_grant_answers_first_and_an_unknown_task_is_not_found_only_to_a_holder() {
        let all = |_: &str| true;
        let only_b = |project: &str| project == "B";
        let none = gate(false, None, &all).unwrap_err();
        assert_eq!((none.code.as_str(), none.path.as_str()), ("PermissionDenied", "harness.console"));
        assert_eq!(gate(false, Some("A"), &all).unwrap_err().code, "PermissionDenied");
        assert_eq!(gate(true, None, &all).unwrap_err().code, "NotFound");
        assert_eq!(gate(true, Some("A"), &only_b).unwrap_err().path, "harness.console");
        assert_eq!(gate(true, Some("B"), &only_b).unwrap(), "B");
    }

    #[test]
    fn a_package_provider_has_no_console_but_an_unknown_harness_is_not_found() {
        assert!(console_support(Ok(()), Ok(())).is_ok());
        assert_eq!(code(console_support(Ok(()), Err("UnsupportedCapability: no console".into()))), "UnsupportedCapability");
        assert_eq!(code(console_support(Err("Unknown provider.".into()), Ok(()))), "NotFound");
        assert_eq!(resolution_refusal("UnsupportedCapability: this provider has no core-managed interactive console.").code, "UnsupportedCapability");
        assert_eq!(resolution_refusal("Unknown command /nope").code, "NotFound");
    }

    #[test]
    fn the_list_is_the_command_centers_own_names_without_the_commands_that_cannot_run() {
        let rows = vec![
            ("/compact".to_owned(), "Free up context".to_owned(), "native".to_owned()),
            ("/hooks".to_owned(), String::new(), "action".to_owned()),
            ("/console".to_owned(), "Open a console".to_owned(), "unsupported".to_owned()),
        ];
        assert_eq!(list_value(&rows), json!([{"id": "/compact", "title": "Free up context"}, {"id": "/hooks", "title": "/hooks"}]));
        assert_eq!(list_value(&[]), json!([]));
    }

    #[test]
    fn the_round_carries_the_package_name_the_command_and_the_arguments_unchanged() {
        let run = Request::Run { task: "t1".into(), command: "/model".into(), arguments: "gpt-5".into() };
        assert_eq!(round_payload(&run, Some("t1"), "A", "codex", "sample.console"), json!({"op": "run", "projectId": "A", "harness": "codex", "package": "sample.console", "taskId": "t1", "command": "/model", "arguments": "gpt-5"}));
        let open = Request::Open(Open::Harness { harness: "codex".into(), project: "A".into() });
        assert_eq!(round_payload(&open, None, "A", "codex", "sample.console"), json!({"op": "open", "projectId": "A", "harness": "codex", "package": "sample.console"}));
        assert_eq!(read_answer(&json!({"ok": true})).unwrap(), Value::Null);
        assert_eq!(read_answer(&json!({"ok": false, "code": "Busy"})).unwrap_err().code, "Busy");
        assert_eq!(read_answer(&json!({"ok": false, "code": "Explode"})).unwrap_err().code, "InvalidShape");
        assert_eq!(read_answer(&json!(null)).unwrap_err().code, "InvalidShape");
    }

    #[test]
    fn waiting_rounds_are_bounded_per_package_answered_once_and_end_with_the_service() {
        let slots = ConsoleSlots::default();
        let mut open = vec![];
        for _ in 0..MAX_WAITING { open.push(slots.begin("sample.console").unwrap()); }
        assert_eq!(slots.begin("sample.console").err(), Some("LimitExceeded"));
        assert!(slots.begin("sample.other").is_ok());
        let (id, mut receiver) = open.remove(0);
        slots.answer(&id, &json!({"ok": true})).unwrap();
        assert_eq!(receiver.try_recv().unwrap(), json!({"ok": true}));
        assert_eq!(slots.answer(&id, &json!({"ok": true})).unwrap_err(), "NotFound");
        assert_eq!(slots.cancel_owner("sample.console"), MAX_WAITING - 1);
        for (_, mut receiver) in open { assert_eq!(receiver.try_recv().unwrap()["code"], "Revoked"); }
        assert_eq!((slots.count("sample.console"), slots.count("sample.other")), (0, 1));
    }
}
