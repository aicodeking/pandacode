//! Remote projects: another computer's projects and tasks, shown on this one
//! (docs/remote-access.md, "Remote projects").
//!
//! Showing a computer asks it for `tasks.list` and keeps a local row for each of its projects
//! (`projects.remote_device`/`remote_project`, a placeholder `path` never read from disk) and a
//! mirror for each of its tasks. Mirrors made here are *deferred*: their messages are copied
//! only once the task is opened, so following a computer with hundreds of tasks never copies
//! their histories. The list is asked again with each subscribe round while the computer is
//! online, so tasks started there appear here.
use super::{client, host, remote};
use crate::{storage::Store, AppState, Result};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

/// Tasks asked for per list: the host's most recent (its default), so a busy computer never
/// crowds this one's own tasks out of the sidebar's 500.
const LIST_LIMIT: usize = 200;
const MAX_NAME: usize = 200;
/// A shown computer's list is asked again at most this often with the subscribe rounds.
pub(super) const REFRESH_EVERY: Duration = Duration::from_secs(30);

/// The `path` of a remote project: unique per computer and project, and never a real folder.
pub(crate) fn placeholder_path(device: &str, project: &str) -> String {
    format!("pandacode-remote://{device}/{project}")
}

/// What one `tasks.list` reply changed here.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct Applied {
    pub projects: bool,
    pub sessions: bool,
    /// Mirrors made for tasks not shown here before.
    pub adopted: usize,
}

fn text(value: &Value, limit: usize) -> Option<&str> {
    value.as_str().map(str::trim).filter(|text| !text.is_empty() && text.chars().count() <= limit)
}

fn id_of(value: &Value) -> Option<&str> {
    value.as_str().filter(|id| host::valid_id(id).is_ok())
}

/// A host status as a mirror's; anything else reads as idle. The subscribe that follows
/// brings a running task's live state.
fn status_of(value: &Value) -> &'static str {
    match value.as_str() {
        Some("running") => "running",
        Some("waiting") => "waiting",
        Some("interrupted") => "interrupted",
        Some("error") => "error",
        _ => "idle",
    }
}

fn stage_of(task: &Value) -> &'static str {
    if task["archived"] == true {
        return "completed";
    }
    match task["stage"].as_str() {
        Some("pending") => "pending",
        Some("in_progress") => "in_progress",
        Some("completed") => "completed",
        _ => "review",
    }
}

/// Applies a host's `tasks.list` reply: its projects (bot workspaces and chats are left out)
/// become remote projects here, renamed as they are there, and each of their tasks not yet
/// mirrored becomes a deferred mirror. A project no longer listed is removed with its copies,
/// unless the reply may have been cut to fit a frame. All or nothing.
pub(crate) fn apply(store: &Store, device: &str, reply: &Value) -> Result<Applied> {
    super::valid_device_id(device)?;
    let tasks = reply["tasks"].as_array().map(Vec::as_slice).unwrap_or_default();
    let chats: HashSet<&str> = tasks.iter().filter(|task| task["chat"] == true).filter_map(|task| task["projectId"].as_str()).collect();
    let listed: Vec<(&str, &str)> = reply["projects"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .filter_map(|project| Some((id_of(&project["id"])?, text(&project["name"], MAX_NAME)?)))
        .filter(|(id, _)| !chats.contains(id))
        .collect();
    let mut applied = Applied::default();
    let transaction = store.db.unchecked_transaction().map_err(|e| e.to_string())?;
    let mut local: HashMap<String, String> = HashMap::new();
    for (remote_project, name) in &listed {
        let existing: Option<(String, String)> = store.db.query_row("SELECT id,name FROM projects WHERE remote_device=?1 AND remote_project=?2", [device, remote_project], |r| Ok((r.get(0)?, r.get(1)?))).optional().map_err(|e| e.to_string())?;
        let id = match existing {
            Some((id, current)) => {
                if current != *name {
                    store.db.execute("UPDATE projects SET name=?2 WHERE id=?1", params![id, name]).map_err(|e| e.to_string())?;
                    applied.projects = true;
                }
                id
            }
            None => {
                let id = uuid::Uuid::new_v4().to_string();
                store.db.execute("INSERT INTO projects(id,name,path,remote_device,remote_project) VALUES (?1,?2,?3,?4,?5)", params![id, name, placeholder_path(device, remote_project), device, remote_project]).map_err(|e| e.to_string())?;
                applied.projects = true;
                id
            }
        };
        local.insert((*remote_project).to_owned(), id);
    }
    // A reply near the frame budget may have dropped projects from its tail.
    if reply.to_string().len() < host::PAGE_BUDGET / 2 {
        let gone: Vec<String> = {
            let mut statement = store.db.prepare("SELECT id,remote_project FROM projects WHERE remote_device=?1").map_err(|e| e.to_string())?;
            let rows = statement.query_map([device], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).map_err(|e| e.to_string())?;
            rows.filter_map(std::result::Result::ok).filter(|(_, remote_project)| !local.contains_key(remote_project)).map(|(id, _)| id).collect()
        };
        for id in gone {
            store.db.execute("DELETE FROM projects WHERE id=?1", [&id]).map_err(|e| e.to_string())?;
            applied.projects = true;
            applied.sessions = true;
        }
    }
    for task in tasks {
        if task["botId"].is_string() || task["chat"] == true {
            continue;
        }
        let (Some(session), Some(project)) = (id_of(&task["sessionId"]), task["projectId"].as_str().and_then(|id| local.get(id))) else { continue };
        let title = text(&task["title"], MAX_NAME).unwrap_or("New conversation");
        let existing: Option<(String, bool)> = store.db.query_row("SELECT id,remote_deferred FROM sessions WHERE remote_device=?1 AND remote_session=?2", [device, session], |r| Ok((r.get(0)?, r.get(1)?))).optional().map_err(|e| e.to_string())?;
        match existing {
            // Message deferral controls history downloads, not host-owned task metadata.
            Some((id, _)) => {
                let changed = store.db.execute(
                    "UPDATE sessions SET title=?2,task_stage=?3,pinned=?4,archived=?5,
                     completed_at=CASE WHEN ?3='completed' THEN COALESCE(completed_at,?6) ELSE NULL END
                     WHERE id=?1 AND (title<>?2 OR task_stage<>?3 OR pinned<>?4 OR archived<>?5)",
                    params![id, title, stage_of(task), task["pinned"] == true, task["archived"] == true, task["updatedAt"].as_i64().unwrap_or_else(crate::storage::now)],
                ).map_err(|e| e.to_string())?;
                applied.sessions |= changed > 0;
            }
            // Settled there before it was ever shown here: history, not work to follow.
            None if stage_of(task) == "completed" => {}
            None => {
                if adopt(store, device, session, project, title, task).is_ok() {
                    applied.adopted += 1;
                    applied.sessions = true;
                }
            }
        }
    }
    transaction.commit().map_err(|e| e.to_string())?;
    Ok(applied)
}

/// Makes a deferred mirror of host task `session` in local project `project`. A harness or
/// mode this build does not know is refused, and the task is not shown.
fn adopt(store: &Store, device: &str, session: &str, project: &str, title: &str, task: &Value) -> Result<()> {
    let provider = task["provider"].as_str().ok_or("Missing provider.")?;
    let model = text(&task["model"], MAX_NAME).unwrap_or("default");
    let mode = task["mode"].as_str().filter(|mode| crate::storage::valid_permission_mode(mode)).unwrap_or("ask");
    let at = |key: &str| task[key].as_i64().filter(|at| *at > 0);
    let updated = at("updatedAt").unwrap_or_else(crate::storage::now);
    let stage = stage_of(task);
    let effort = text(&task["effort"], 32);
    // Inside `apply`'s transaction: a savepoint, so a refused task leaves no half-made row.
    store.db.execute_batch("SAVEPOINT adopt").map_err(|e| e.to_string())?;
    let made = store.create_session(project, provider, model, mode).and_then(|made| {
        store
            .db
            .execute(
                "UPDATE sessions SET title=?2,status=?3,task_stage=?4,created_at=?5,updated_at=?5,last_prompt_at=?6,completed_at=CASE WHEN ?4='completed' THEN ?5 END,reasoning_effort=?7,pinned=?8,remote_device=?9,remote_session=?10,remote_synced_id=0,remote_deferred=1,draft=0 WHERE id=?1",
                params![made.id, title, status_of(&task["status"]), stage, updated, at("lastPromptAt"), effort, task["pinned"] == true, device, session],
            )
            .map_err(|e| e.to_string())
    });
    let end = if made.is_ok() { "RELEASE adopt" } else { "ROLLBACK TO adopt; RELEASE adopt" };
    store.db.execute_batch(end).map_err(|e| e.to_string())?;
    made.map(drop)
}

/// How long a computer's answer to whether it takes `checkout: "current"` is kept.
const HELLO_FOR: Duration = Duration::from_secs(10 * 60);

/// Whether a `host.hello` reply says the host runs a task in a project's folder as it is
/// (`projectCheckout`). A host too old to answer `host.hello` at all does not.
pub(crate) fn takes_project_checkout(hello: &Result<Value>) -> bool {
    hello.as_ref().is_ok_and(|reply| reply["features"].as_array().is_some_and(|features| features.iter().any(|feature| feature == super::methods::PROJECT_CHECKOUT)))
}

/// The refusal for a start in a remote project's folder on a host too old to keep it there.
pub(crate) fn older_host(name: &str) -> String {
    format!("{name} runs an older PandaCode, which would start this task in a new worktree instead of the project folder. Update PandaCode on {name}, or choose Runs in → New worktree.")
}

/// Whether `device` runs projects by id (`projectCheckout`: a project folder as it is, and
/// `git.branches` by project). Each host's answer is kept for [`HELLO_FOR`]; a failed ask is not
/// kept and fails the caller (offline or a lost reply says nothing about the host's version).
pub(crate) async fn takes_projects(app: &tauri::AppHandle, device: &str) -> Result<bool> {
    static KNOWN: OnceLock<Mutex<HashMap<String, (bool, Instant)>>> = OnceLock::new();
    let known = KNOWN.get_or_init(Default::default);
    if let Some(takes) = known.lock().unwrap_or_else(|e| e.into_inner()).get(device).filter(|(_, at)| at.elapsed() < HELLO_FOR).map(|(takes, _)| *takes) {
        return Ok(takes);
    }
    let hello = client::call(app, device, "host.hello", json!({})).await;
    if let Err(error) = &hello {
        if error != "Unknown method." && !error.contains("not allowed") && !error.contains("Unknown remote method") {
            return Err(error.clone());
        }
    }
    let takes = takes_project_checkout(&hello);
    known.lock().unwrap_or_else(|e| e.into_inner()).insert(device.to_owned(), (takes, Instant::now()));
    Ok(takes)
}

/// Refuses a start in a remote project's folder (`checkout: "current"`) on a host that would
/// ignore it, so the task never lands in a worktree unasked.
pub(crate) async fn require_project_checkout(app: &tauri::AppHandle, device: &str) -> Result<()> {
    if takes_projects(app, device).await? {
        Ok(())
    } else {
        Err(older_host(&super::device_label(device)))
    }
}

/// A remote project's branches on its computer (`git.branches` by project id), for the branch
/// a New worktree there starts from: `{ current, branches, defaultBranch }`.
#[tauri::command]
pub async fn remote_project_branches(app: tauri::AppHandle, project_id: String) -> Result<Value> {
    let project = app.state::<AppState>().store.lock().map_err(|e| e.to_string())?.project_entry(&project_id)?;
    let (Some(device), Some(remote_project)) = (project.remote_device, project.remote_project) else { return Err("That project is on this computer.".into()) };
    if !takes_projects(&app, &device.id).await? {
        return Err(format!("{} runs an older PandaCode, which can't list a project's branches. Update PandaCode there to choose one.", device.name));
    }
    let reply = client::call(&app, &device.id, "git.branches", json!({"projectId": remote_project})).await?;
    Ok(json!({"current": reply["current"], "branches": reply["branches"], "defaultBranch": reply["defaultBranch"]}))
}

/// Whether a mirror's messages wait for it to be opened.
pub(crate) fn deferred(store: &Store, local: &str) -> bool {
    store.db.query_row("SELECT remote_deferred FROM sessions WHERE id=?1", [local], |r| r.get(0)).unwrap_or(false)
}

/// Clears a mirror's deferral; true if it was deferred.
pub(crate) fn take_deferred(store: &Store, local: &str) -> Result<bool> {
    let changed = store.db.execute("UPDATE sessions SET remote_deferred=0 WHERE id=?1 AND remote_deferred=1", [local]).map_err(|e| e.to_string())?;
    Ok(changed > 0)
}

/// A thread was opened: a deferred mirror copies its messages now (newest page first).
pub(crate) fn opened(app: &tauri::AppHandle, local: &str) {
    let state = app.state::<AppState>();
    let taken = state.store.lock().map_err(|e| e.to_string()).and_then(|store| take_deferred(&store, local));
    if !matches!(taken, Ok(true)) {
        return;
    }
    let (app, local) = (app.clone(), local.to_owned());
    tauri::async_runtime::spawn(async move {
        if let Err(error) = super::mirror::sync(&app, &local).await {
            eprintln!("PandaCode Connect: could not copy a remote task's messages: {error}");
            // Copied at the next subscribe round instead.
            if let Ok(store) = app.state::<AppState>().store.lock() {
                let _ = store.db.execute("UPDATE sessions SET remote_deferred=0 WHERE id=?1", [&local]);
            }
        }
    });
}

/// Whether `local` is a mirror in a remote project: its host deleting the task removes it here.
pub(crate) fn in_remote_project(store: &Store, local: &str) -> bool {
    store.db.query_row("SELECT EXISTS(SELECT 1 FROM sessions s JOIN projects p ON p.id=s.project_id WHERE s.id=?1 AND p.remote_device IS NOT NULL)", [local], |r| r.get(0)).unwrap_or(false)
}

/// Removes the copy of a task its host no longer has.
pub(crate) fn forget(app: &tauri::AppHandle, local: &str) -> Result<()> {
    let state = app.state::<AppState>();
    forget_state(&state, local)?;
    let _ = app.emit("sessions-deleted", json!({"sessionIds": [local]}));
    let _ = app.emit("sessions-changed", ());
    Ok(())
}

fn forget_state(state: &AppState, local: &str) -> Result<()> {
    {
        let store = state.store.lock().map_err(|e| e.to_string())?;
        if super::mirror::of(&store, local)?.is_none() {
            return Err("Only a remote task's copy can be forgotten.".into());
        }
        super::mirror::finish_once(&store, local, false, true)?;
    }
    crate::task_deletion::delete_state(state, local).map(drop)
}

fn browsed(app: &tauri::AppHandle) -> Vec<String> {
    remote(app).lock().settings.browsed.iter().cloned().collect()
}

/// Serialize hide/show and background listings so a late reply cannot recreate hidden rows.
type DeviceGate = std::sync::Arc<tokio::sync::Mutex<()>>;
fn device_gate(device: &str) -> DeviceGate {
    static GATES: OnceLock<Mutex<HashMap<String, DeviceGate>>> = OnceLock::new();
    GATES.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner())
        .entry(device.to_owned()).or_default().clone()
}

/// Asks `device` for its projects and tasks and applies them.
async fn refresh_one(app: &tauri::AppHandle, device: &str) -> Result<Applied> {
    let reply = client::call(app, device, "tasks.list", json!({"limit": LIST_LIMIT})).await?;
    let state = app.state::<AppState>();
    let applied = apply(&*state.store.lock().map_err(|e| e.to_string())?, device, &reply)?;
    if applied.projects {
        let _ = app.emit("projects-changed", ());
    }
    if applied.sessions {
        let _ = app.emit("sessions-changed", ());
    }
    Ok(applied)
}

/// Whether `device` was listed less than [`REFRESH_EVERY`] ago; otherwise notes it is now.
fn listed_recently(device: &str) -> bool {
    static LISTED: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
    let mut listed = LISTED.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner());
    if listed.get(device).is_some_and(|at| at.elapsed() < REFRESH_EVERY) {
        return true;
    }
    listed.insert(device.to_owned(), Instant::now());
    false
}

/// Asks every shown computer that is online for its list again, beside a subscribe round (at
/// most every [`REFRESH_EVERY`] each, since presence bursts start rounds); whether any task
/// appeared that the round should follow.
pub(crate) async fn refresh(app: &tauri::AppHandle) -> bool {
    let online: HashSet<String> = remote(app).lock().devices.iter().filter(|d| d.online && d.host).map(|d| d.id.clone()).collect();
    let devices: Vec<String> = browsed(app).into_iter().filter(|device| online.contains(device) && !listed_recently(device)).collect();
    let rounds = devices.iter().map(|device| async move {
        let gate = device_gate(device);
        let _guard = gate.lock().await;
        if !browsed(app).iter().any(|shown| shown == device) { return false; }
        match refresh_one(app, device).await {
            Ok(applied) => applied.adopted > 0,
            Err(error) => {
                eprintln!("PandaCode Connect: could not list the tasks on {}: {error}", super::device_label(device));
                false
            }
        }
    });
    futures_util::future::join_all(rounds).await.into_iter().any(|adopted| adopted)
}

/// Shows (or stops showing) another computer's projects and tasks here. Showing asks it at
/// once and fails if it can't be reached; stopping removes its projects and their copies.
#[tauri::command]
pub async fn remote_browse(app: tauri::AppHandle, device_id: String, show: bool) -> Result<Value> {
    super::valid_device_id(&device_id)?;
    let gate = device_gate(&device_id);
    let _guard = gate.lock().await;
    if !show {
        // Validate and remove every copy before changing the saved refresh preference.
        hide(&app, &device_id)?;
        let removed = {
            let state = remote(&app);
            let mut inner = state.lock();
            inner.settings.browsed.remove(&device_id)
        };
        if removed {
            remote(&app).save();
        }
        return Ok(json!({"projects": 0, "tasks": 0}));
    }
    {
        let state = remote(&app);
        let inner = state.lock();
        inner.callable(&device_id)?;
        if !inner.devices.iter().any(|d| d.id == device_id && d.host) {
            return Err(format!("{} does not allow remote control.", super::device_label(&device_id)));
        }
    }
    refresh_one(&app, &device_id).await?;
    let added = remote(&app).lock().settings.browsed.insert(device_id.clone());
    if added {
        remote(&app).save();
    }
    super::mirror::subscribe_soon(&app);
    let store = app.state::<AppState>();
    let store = store.store.lock().map_err(|e| e.to_string())?;
    let projects: i64 = store.db.query_row("SELECT COUNT(*) FROM projects WHERE remote_device=?1", [&device_id], |r| r.get(0)).map_err(|e| e.to_string())?;
    let tasks: i64 = store.db.query_row("SELECT COUNT(*) FROM sessions s JOIN projects p ON p.id=s.project_id WHERE p.remote_device=?1", [&device_id], |r| r.get(0)).map_err(|e| e.to_string())?;
    Ok(json!({"projects": projects, "tasks": tasks}))
}

/// The computers shown here, for Settings and the project menu.
#[tauri::command]
pub async fn remote_browsed(app: tauri::AppHandle) -> Result<Vec<String>> {
    Ok(browsed(&app))
}

/// Removes a computer's remote projects and every copy in them.
fn hide(app: &tauri::AppHandle, device: &str) -> Result<()> {
    let state = app.state::<AppState>();
    let ids: Vec<String> = {
        let store = state.store.lock().map_err(|e| e.to_string())?;
        let mut statement = store.db.prepare("SELECT s.id FROM sessions s JOIN projects p ON p.id=s.project_id WHERE p.remote_device=?1").map_err(|e| e.to_string())?;
        let rows = statement.query_map([device], |r| r.get(0)).map_err(|e| e.to_string())?;
        rows.filter_map(std::result::Result::ok).collect()
    };
    let deleted = crate::task_deletion::delete_states(&state, &ids)?;
    let _ = app.emit("sessions-deleted", json!({"sessionIds": deleted.deleted_session_ids}));
    state.store.lock().map_err(|e| e.to_string())?.db.execute("DELETE FROM projects WHERE remote_device=?1", [device]).map_err(|e| e.to_string())?;
    let _ = app.emit("projects-changed", ());
    let _ = app.emit("sessions-changed", ());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> Store {
        Store::open(std::path::Path::new(":memory:")).unwrap()
    }

    fn reply(projects: Value, tasks: Value) -> Value {
        json!({"projects": projects, "tasks": tasks})
    }

    fn task(id: &str, project: &str) -> Value {
        json!({"sessionId": id, "projectId": project, "title": format!("Task {id}"), "status": "idle", "provider": "github-copilot", "model": "gpt-5", "mode": "ask", "updatedAt": 1_700_000_000_000_i64, "lastPromptAt": 1_699_999_999_000_i64, "pending": []})
    }

    #[test]
    fn a_hosts_projects_and_tasks_become_remote_projects_and_deferred_mirrors() {
        let store = store();
        let applied = apply(&store, "linux", &reply(json!([{"id": "p1", "name": "orbit", "repo": null}]), json!([task("t1", "p1"), task("t2", "p1")]))).unwrap();
        assert_eq!(applied, Applied { projects: true, sessions: true, adopted: 2 });
        let all = store.all_projects().unwrap();
        assert_eq!(all.len(), 1);
        let project = &all[0];
        assert_eq!((project.name.as_str(), project.remote_device.as_ref().map(|d| d.id.as_str()), project.remote_project.as_deref()), ("orbit", Some("linux"), Some("p1")));
        assert!(store.projects().unwrap().is_empty(), "remote projects are not this computer's");
        assert_eq!(store.project(&project.id).unwrap_err(), "orbit is on another computer.");
        let rows: Vec<(String, String, String, bool, String)> = {
            let mut statement = store.db.prepare("SELECT remote_session,title,provider,remote_deferred,project_id FROM sessions ORDER BY remote_session").unwrap();
            statement.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))).unwrap().map(|row| row.unwrap()).collect()
        };
        assert_eq!(rows, vec![("t1".into(), "Task t1".into(), "github-copilot".into(), true, project.id.clone()), ("t2".into(), "Task t2".into(), "github-copilot".into(), true, project.id.clone())]);
        assert!(store.workspace_root(&project.id, None).is_err(), "nothing reads a remote project's folder");
    }

    #[test]
    fn listing_again_adopts_only_new_tasks_and_follows_renames() {
        let store = store();
        apply(&store, "linux", &reply(json!([{"id": "p1", "name": "orbit"}]), json!([task("t1", "p1")]))).unwrap();
        let mut renamed = task("t1", "p1");
        renamed["title"] = json!("Renamed");
        let applied = apply(&store, "linux", &reply(json!([{"id": "p1", "name": "orbit-2"}]), json!([renamed, task("t2", "p1")]))).unwrap();
        assert_eq!(applied, Applied { projects: true, sessions: true, adopted: 1 });
        let title: String = store.db.query_row("SELECT title FROM sessions WHERE remote_session='t1'", [], |r| r.get(0)).unwrap();
        assert_eq!(title, "Renamed");
        assert_eq!(store.all_projects().unwrap()[0].name, "orbit-2");
        assert_eq!(apply(&store, "linux", &reply(json!([{"id": "p1", "name": "orbit-2"}]), json!([task("t1", "p1"), task("t2", "p1")]))).unwrap().adopted, 0);
    }

    #[test]
    fn an_opened_mirror_follows_host_metadata() {
        let store = store();
        apply(&store, "linux", &reply(json!([{"id": "p1", "name": "orbit"}]), json!([task("t1", "p1")]))).unwrap();
        let local: String = store.db.query_row("SELECT id FROM sessions WHERE remote_session='t1'", [], |r| r.get(0)).unwrap();
        assert!(deferred(&store, &local));
        assert!(take_deferred(&store, &local).unwrap());
        assert!(!take_deferred(&store, &local).unwrap());
        let mut renamed = task("t1", "p1");
        renamed["title"] = json!("Renamed");
        apply(&store, "linux", &reply(json!([{"id": "p1", "name": "orbit"}]), json!([renamed]))).unwrap();
        let title: String = store.db.query_row("SELECT title FROM sessions WHERE id=?1", [&local], |r| r.get(0)).unwrap();
        assert_eq!(title, "Renamed", "opening must not freeze host metadata");
    }

    #[test]
    fn opened_mirrors_follow_settle_reopen_pin_and_archive_without_downloading_messages() {
        let store = store();
        let projects = json!([{"id": "p1", "name": "orbit"}]);
        apply(&store, "linux", &reply(projects.clone(), json!([task("t1", "p1")]))).unwrap();
        let local: String = store.db.query_row("SELECT id FROM sessions WHERE remote_session='t1'", [], |r| r.get(0)).unwrap();
        take_deferred(&store, &local).unwrap();
        let mut host = task("t1", "p1");
        host["stage"] = json!("completed");
        host["pinned"] = json!(true);
        host["title"] = json!("Host title");
        assert!(apply(&store, "linux", &reply(projects.clone(), json!([host.clone()]))).unwrap().sessions);
        let settled = store.session(&local).unwrap();
        assert_eq!(settled.task_stage, "completed");
        assert!(settled.completed_at.is_some() && settled.pinned);
        assert_eq!(settled.title, "Host title");
        host["stage"] = json!("review");
        host["pinned"] = json!(false);
        apply(&store, "linux", &reply(projects.clone(), json!([host.clone()]))).unwrap();
        let reopened = store.session(&local).unwrap();
        assert_eq!(reopened.task_stage, "review");
        assert!(reopened.completed_at.is_none() && !reopened.pinned);
        host["archived"] = json!(true);
        apply(&store, "linux", &reply(projects, json!([host]))).unwrap();
        assert!(store.session(&local).unwrap().archived);
        assert!(store.messages(&local, None).unwrap().is_empty());
    }

    #[test]
    fn missing_host_tasks_are_removed_even_if_the_local_copy_still_says_running() {
        let (state, local_project) = crate::concurrent_task_tests::test_state();
        let (remote, local) = {
            let store = state.store.lock().unwrap();
            apply(&store, "linux", &reply(json!([{"id": "p1", "name": "orbit"}]), json!([task("t1", "p1")]))).unwrap();
            let remote: String = store.db.query_row("SELECT id FROM sessions WHERE remote_session='t1'", [], |r| r.get(0)).unwrap();
            store.status(&remote, "waiting").unwrap();
            let local = store.create_session(&local_project, "claude", "default", "ask").unwrap().id;
            (remote, local)
        };
        assert!(forget_state(&state, &local).is_err(), "never finish or delete a local task");
        forget_state(&state, &remote).unwrap();
        let store = state.store.lock().unwrap();
        assert!(store.session(&remote).is_err());
        assert!(store.session(&local).is_ok());
    }

    #[test]
    fn a_project_gone_from_its_host_goes_with_its_copies() {
        let store = store();
        apply(&store, "linux", &reply(json!([{"id": "p1", "name": "orbit"}, {"id": "p2", "name": "comet"}]), json!([task("t1", "p1"), task("t2", "p2")]))).unwrap();
        apply(&store, "linux", &reply(json!([{"id": "p2", "name": "comet"}]), json!([task("t2", "p2")]))).unwrap();
        assert_eq!(store.all_projects().unwrap().iter().map(|p| p.name.as_str()).collect::<Vec<_>>(), ["comet"]);
        let left: i64 = store.db.query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get(0)).unwrap();
        assert_eq!(left, 1);
    }

    #[test]
    fn bots_chats_and_unknown_harnesses_are_left_out() {
        let store = store();
        let mut bot = task("b1", "p1");
        bot["botId"] = json!("bot");
        let mut chat = task("c1", "chat-folder");
        chat["chat"] = json!(true);
        let mut unknown = task("u1", "p1");
        unknown["provider"] = json!("someday-cli");
        let applied = apply(&store, "linux", &reply(json!([{"id": "p1", "name": "orbit"}, {"id": "chat-folder", "name": "Chat"}]), json!([bot, chat, unknown, task("t1", "p1")]))).unwrap();
        assert_eq!(applied.adopted, 1);
        assert_eq!(store.all_projects().unwrap().iter().map(|p| p.name.as_str()).collect::<Vec<_>>(), ["orbit"]);
    }

    #[test]
    fn a_task_settled_before_it_was_shown_is_not_copied() {
        let store = store();
        let mut settled = task("t1", "p1");
        settled["stage"] = json!("completed");
        let mut archived = task("t2", "p1");
        archived["archived"] = json!(true);
        assert_eq!(apply(&store, "linux", &reply(json!([{"id": "p1", "name": "orbit"}]), json!([settled, archived, task("t3", "p1")]))).unwrap().adopted, 1);
        // One shown while open follows the host when it is settled there.
        let mut later = task("t3", "p1");
        later["stage"] = json!("completed");
        apply(&store, "linux", &reply(json!([{"id": "p1", "name": "orbit"}]), json!([later]))).unwrap();
        let stage: String = store.db.query_row("SELECT task_stage FROM sessions WHERE remote_session='t3'", [], |r| r.get(0)).unwrap();
        assert_eq!(stage, "completed");
    }

    #[test]
    fn only_a_host_that_says_so_runs_a_task_in_the_project_folder() {
        assert!(takes_project_checkout(&Ok(json!({"features": ["packedFrames", "projectCheckout"]}))));
        assert!(!takes_project_checkout(&Ok(json!({"features": ["packedFrames"]}))), "a host before it");
        assert!(!takes_project_checkout(&Err("Unknown method.".into())), "a host before host.hello");
        assert!(older_host("Linux box").contains("Update PandaCode on Linux box"));
        // This build's own hello says so.
        assert!(takes_project_checkout(&Ok(crate::remote::methods::hello_reply("1.0.0", false, Some("full")))));
    }

    #[test]
    fn two_computers_keep_their_projects_apart() {
        let store = store();
        apply(&store, "linux", &reply(json!([{"id": "p1", "name": "orbit"}]), json!([task("t1", "p1")]))).unwrap();
        apply(&store, "mac", &reply(json!([{"id": "p1", "name": "orbit"}]), json!([task("t1", "p1")]))).unwrap();
        assert_eq!(store.all_projects().unwrap().len(), 2);
        let mirrors: i64 = store.db.query_row("SELECT COUNT(*) FROM sessions WHERE remote_session='t1'", [], |r| r.get(0)).unwrap();
        assert_eq!(mirrors, 2);
    }

    #[test]
    fn a_host_task_already_mirrored_here_is_not_copied_twice() {
        let store = store();
        apply(&store, "linux", &reply(json!([{"id": "p1", "name": "orbit"}]), json!([]))).unwrap();
        let local_project = store.add_project(&std::env::temp_dir()).unwrap();
        let started = store.create_session(&local_project.id, "claude", "sonnet", "ask").unwrap();
        store.db.execute("UPDATE sessions SET remote_device='linux',remote_session='t1' WHERE id=?1", [&started.id]).unwrap();
        assert_eq!(apply(&store, "linux", &reply(json!([{"id": "p1", "name": "orbit"}]), json!([task("t1", "p1")]))).unwrap().adopted, 0);
    }

    #[test]
    fn a_reply_that_may_be_cut_removes_nothing() {
        let store = store();
        apply(&store, "linux", &reply(json!([{"id": "p1", "name": "orbit"}]), json!([]))).unwrap();
        let filler: Vec<Value> = (0..800).map(|n| json!({"sessionId": format!("x{n}"), "projectId": "elsewhere", "title": "x".repeat(150)})).collect();
        apply(&store, "linux", &reply(json!([]), json!(filler))).unwrap();
        assert_eq!(store.all_projects().unwrap().len(), 1);
    }
}
