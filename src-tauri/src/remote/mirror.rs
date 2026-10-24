//! Mirrors: a local task whose agent runs on another computer (docs/remote-access.md).
//! The row, its messages and the UI are ordinary; commands that act on the agent go to
//! the host, its events are re-emitted here under the local id, and its messages are
//! copied here after each run.
use super::{client, host, remote, start::git};
use crate::{providers::AgentEvent, storage::Store, AppState, Result};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;
use tauri::{Emitter, Manager};

/// Cloning and checking out can take a while on the host: its worst case plus margin.
const START_TIMEOUT: Duration = Duration::from_secs(super::start::WORST_CASE.as_secs() + 3 * 60);
/// Pages per sync; a longer history continues at the next run end or subscription.
const MAX_PAGES: usize = 50;
const NO_REPO: &str = "This project has no GitHub origin, so it can't run on another computer. Add a GitHub remote named origin first.";

#[derive(Debug)]
pub(crate) struct Mirror {
    pub device: String,
    pub session: String,
}

impl Mirror {
    /// Whether a local task is a mirror (an error while it is still starting there).
    pub(crate) fn is(state: &AppState, local: &str) -> Result<bool> {
        Ok(of(&*lock(state)?, local)?.is_some())
    }
}

fn lock(state: &AppState) -> Result<std::sync::MutexGuard<'_, Store>> {
    state.store.lock().map_err(|e| e.to_string())
}

/// The host and host task behind a local task, or None for an ordinary task.
pub(crate) fn of(store: &Store, local: &str) -> Result<Option<Mirror>> {
    let row: Option<(Option<String>, Option<String>)> = store.db.query_row("SELECT remote_device,remote_session FROM sessions WHERE id=?1", [local], |r| Ok((r.get(0)?, r.get(1)?))).optional().map_err(|e| e.to_string())?;
    let Some((Some(device), session)) = row else { return Ok(None) };
    let session = session.ok_or_else(|| format!("This task is still starting on {}.", super::device_label(&device)))?;
    Ok(Some(Mirror { device, session }))
}

fn local_id(store: &Store, device: &str, session: &str) -> Option<String> {
    store.db.query_row("SELECT id FROM sessions WHERE remote_device=?1 AND remote_session=?2", [device, session], |r| r.get(0)).optional().ok().flatten()
}

/// Sends a mirror's command to its host, with the host's task id. None for a local task,
/// which the caller then handles as always.
pub(crate) async fn route(app: &tauri::AppHandle, state: &AppState, local: &str, method: &str, params: Value) -> Result<Option<Value>> {
    let Some(routed) = prepare(&*lock(state)?, local, method, params)? else { return Ok(None) };
    let result = client::call(app, &routed.device, method, routed.params).await;
    if let (Err(_), Some(status)) = (&result, routed.before) {
        lock(state)?.status(local, &status)?;
    }
    result.map(Some)
}

/// A command bound for a host: where it goes, its params, and the status to restore if
/// the host refuses a prompt.
#[derive(Debug, PartialEq)]
pub(crate) struct Routed {
    device: String,
    params: Value,
    before: Option<String>,
}

/// Swaps in the host's task id. A prompt marks the mirror running before the host answers,
/// so a run that ends first is never left spinning.
pub(crate) fn prepare(store: &Store, local: &str, method: &str, mut params: Value) -> Result<Option<Routed>> {
    let Some(mirror) = of(store, local)? else { return Ok(None) };
    params["sessionId"] = json!(mirror.session);
    let before = (method == "task.send").then(|| start_turn(store, local)).transpose()?;
    Ok(Some(Routed { device: mirror.device, params, before }))
}

/// Marks a mirror running for a new prompt; returns the status it had.
fn start_turn(store: &Store, local: &str) -> Result<String> {
    let status: String = store.db.query_row("SELECT status FROM sessions WHERE id=?1", [local], |r| r.get(0)).map_err(|e| e.to_string())?;
    store.db.execute("UPDATE sessions SET status='running',task_stage='in_progress',completed_at=NULL,last_prompt_at=?2,updated_at=?2 WHERE id=?1", params![local, crate::storage::now()]).map_err(|e| e.to_string())?;
    Ok(status)
}

/// A host's events as this computer's: each gets its mirror's local id, and events for
/// tasks not mirrored here (or that are not events) are dropped. Run ends come separately.
pub(crate) fn relabel(events: &[Value], mut local: impl FnMut(&str) -> Option<String>) -> Vec<Value> {
    events
        .iter()
        .filter(|event| event["kind"].as_str().is_some_and(|kind| kind != "done") && event["text"].is_string())
        .filter_map(|event| {
            let id = local(event["sessionId"].as_str()?)?;
            let mut event = event.clone();
            event["sessionId"] = json!(id);
            Some(event)
        })
        .collect()
}

/// The status an event moves a mirror to, if any.
fn status_after(current: &str, kind: &str) -> Option<&'static str> {
    let next = match kind {
        "approval" | "input_request" => "waiting",
        "approval_cancelled" | "input_cancelled" => "running",
        _ if matches!(current, "running" | "waiting") => return None,
        _ => "running",
    };
    (next != current).then_some(next)
}

/// `agent.events` from a trusted host.
pub(crate) fn events(app: &tauri::AppHandle, from: &str, data: &Value) {
    let Some(list) = data["events"].as_array() else { return };
    let state = app.state::<AppState>();
    let (events, changed) = {
        let Ok(store) = state.store.lock() else { return };
        let mut ids: HashMap<String, Option<String>> = HashMap::new();
        let events = relabel(list, |remote| ids.entry(remote.to_owned()).or_insert_with(|| local_id(&store, from, remote)).clone());
        let mut changed = false;
        for event in &events {
            let (Some(id), Some(kind)) = (event["sessionId"].as_str(), event["kind"].as_str()) else { continue };
            let current: String = store.db.query_row("SELECT status FROM sessions WHERE id=?1", [id], |r| r.get(0)).unwrap_or_default();
            if let Some(next) = status_after(&current, kind) {
                changed |= store.status(id, next).is_ok();
            }
        }
        (events, changed)
    };
    for event in events {
        let _ = app.emit("agent-event", event);
    }
    if changed {
        let _ = app.emit("sessions-changed", ());
    }
}

/// `run.finished` from a trusted host: copy the run's messages, then end the local turn.
pub(crate) fn finished(app: &tauri::AppHandle, from: &str, data: &Value) {
    let Some(session) = data["sessionId"].as_str() else { return };
    let Some(local) = app.state::<AppState>().store.lock().ok().and_then(|store| local_id(&store, from, session)) else { return };
    let (successful, stopped) = (data["successful"].as_bool().unwrap_or(false), data["stopped"].as_bool().unwrap_or(false));
    let text: String = data["text"].as_str().unwrap_or("Turn complete").chars().take(200).collect();
    let app = app.clone();
    tauri::async_runtime::spawn(async move { end_turn(&app, &local, successful, stopped, &text).await });
}

async fn end_turn(app: &tauri::AppHandle, local: &str, successful: bool, stopped: bool, text: &str) {
    if !active(&app.state::<AppState>(), local) {
        return;
    }
    if let Err(error) = sync(app, local).await {
        eprintln!("PandaCode Connect: could not copy a remote task's messages: {error}");
    }
    finish(app, local, successful, stopped, text);
}

fn active(state: &AppState, local: &str) -> bool {
    lock(state).is_ok_and(|store| store.db.query_row("SELECT status IN ('running','waiting') FROM sessions WHERE id=?1", [local], |r| r.get(0)).unwrap_or(false))
}

/// Ends a running mirror's turn once: false (and nothing changes) when it already ended.
fn finish_once(store: &Store, local: &str, successful: bool, stopped: bool) -> Result<bool> {
    let running: bool = store.db.query_row("SELECT status IN ('running','waiting') FROM sessions WHERE id=?1", [local], |r| r.get(0)).map_err(|e| e.to_string())?;
    if running {
        store.finish_task_turn(local, successful, stopped)?;
    }
    Ok(running)
}

/// Ends the local turn and emits the window's ordinary `done`, unless it already ended.
fn finish(app: &tauri::AppHandle, local: &str, successful: bool, stopped: bool, text: &str) {
    match lock(&app.state::<AppState>()).and_then(|store| finish_once(&store, local, successful, stopped)) {
        Ok(true) => {}
        Ok(false) => return,
        Err(error) => eprintln!("PandaCode Connect: could not end a remote task's turn: {error}"),
    }
    let done = AgentEvent { session_id: local.to_owned(), kind: "done".into(), text: text.to_owned(), request_id: None, data: None, tool: None };
    let _ = app.emit("agent-event", done);
    let _ = app.emit("sessions-changed", ());
}

/// Whether a failed call means the host can't be reached at all.
fn unreachable(error: &str, online: bool) -> bool {
    !online || error == super::socket::OFFLINE
}

/// Stops a mirror's run. When its host is offline the run can't be reached, so the local
/// turn ends as stopped and the spinner clears. None for a local task.
pub(crate) async fn stop(app: &tauri::AppHandle, state: &AppState, local: &str) -> Result<Option<()>> {
    let device = { of(&*lock(state)?, local)?.map(|mirror| mirror.device) };
    let Some(device) = device else { return Ok(None) };
    match route(app, state, local, "task.stop", json!({})).await {
        Ok(_) => Ok(Some(())),
        Err(error) => {
            let online = remote(app).lock().devices.iter().any(|d| d.id == device && d.online);
            if !unreachable(&error, online) {
                return Err(error);
            }
            finish(app, local, false, true, "Turn stopped");
            Ok(Some(()))
        }
    }
}

/// Copies the host's messages after the last one copied, page by page.
pub(crate) async fn sync(app: &tauri::AppHandle, local: &str) -> Result<()> {
    let state = app.state::<AppState>();
    for _ in 0..MAX_PAGES {
        let (mirror, after) = {
            let store = lock(&state)?;
            let mirror = of(&store, local)?.ok_or("That task does not run on another computer.")?;
            let after: i64 = store.db.query_row("SELECT remote_synced_id FROM sessions WHERE id=?1", [local], |r| r.get(0)).map_err(|e| e.to_string())?;
            (mirror, after)
        };
        let page = client::call(app, &mirror.device, "task.messages", json!({"sessionId": mirror.session, "afterId": after})).await?;
        if !store_page(&*lock(&state)?, local, after, &page)? {
            break;
        }
    }
    Ok(())
}

// ponytail: copies only new ids; a host message rewritten in place after the copy stays stale.
// Add an updated_at column to messages if that shows up.
/// Stores one `task.messages` page copied after `after` and advances the mirror's
/// position, all or nothing. Returns whether to ask for the next page. A page that no
/// longer starts at the stored position (another sync got there first) is skipped.
pub(crate) fn store_page(store: &Store, local: &str, after: i64, page: &Value) -> Result<bool> {
    let transaction = store.db.unchecked_transaction().map_err(|e| e.to_string())?;
    let current: i64 = store.db.query_row("SELECT remote_synced_id FROM sessions WHERE id=?1", [local], |r| r.get(0)).map_err(|e| e.to_string())?;
    if current != after {
        return Ok(false);
    }
    let mut last = after;
    for message in page["messages"].as_array().map(Vec::as_slice).unwrap_or_default() {
        let (Some(id), Some(role), Some(content), Some(created_at)) = (message["id"].as_i64(), message["role"].as_str(), message["content"].as_str(), message["createdAt"].as_i64()) else { return Err("The other computer sent an invalid message.".into()) };
        if id <= last || role.is_empty() || role.len() > 32 || !role.bytes().all(|b| b.is_ascii_lowercase() || b == b'_') {
            return Err("The other computer sent an invalid message.".into());
        }
        store.db.execute("INSERT INTO messages(session_id,role,content,created_at,turn_duration_ms) VALUES (?1,?2,?3,?4,?5)", params![local, role, content, created_at, message["turnDurationMs"].as_i64()]).map_err(|e| e.to_string())?;
        last = id;
    }
    if let Some(title) = page["title"].as_str().map(str::trim).filter(|title| !title.is_empty() && title.chars().count() <= 200) {
        store.db.execute("UPDATE sessions SET title=?2 WHERE id=?1 AND title<>?2", params![local, title]).map_err(|e| e.to_string())?;
    }
    store.db.execute("UPDATE sessions SET remote_synced_id=?2 WHERE id=?1", params![local, last]).map_err(|e| e.to_string())?;
    transaction.commit().map_err(|e| e.to_string())?;
    Ok(page["hasMore"] == true && last > after)
}

/// What a host's status means for a mirror that shows `local`.
#[derive(Debug, PartialEq)]
enum Reconcile {
    Same,
    Set(String),
    /// The run ended while this computer was not listening.
    Ended { successful: bool, stopped: bool },
}

fn reconcile(local: &str, host: &str) -> Reconcile {
    let active = |status: &str| matches!(status, "running" | "waiting");
    if active(host) {
        return if local == host { Reconcile::Same } else { Reconcile::Set(host.to_owned()) };
    }
    if active(local) {
        return Reconcile::Ended { successful: host == "idle", stopped: host == "interrupted" };
    }
    Reconcile::Same
}

/// Asks every online host for the events of the tasks mirrored from it, and catches up on
/// what changed meanwhile. Run on each presence change and every 9 minutes.
pub(crate) async fn subscribe_all(app: tauri::AppHandle) {
    let mirrors: Vec<(String, String)> = {
        let state = app.state::<AppState>();
        let Ok(store) = state.store.lock() else { return };
        let Ok(mut statement) = store.db.prepare("SELECT remote_device,remote_session FROM sessions WHERE remote_session IS NOT NULL AND archived=0 ORDER BY updated_at DESC") else { return };
        statement.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).map(|rows| rows.filter_map(std::result::Result::ok).collect()).unwrap_or_default()
    };
    let mut hosts: HashMap<String, Vec<String>> = HashMap::new();
    for (device, session) in mirrors {
        let sessions = hosts.entry(device).or_default();
        if sessions.len() < host::MAX_IDS {
            sessions.push(session);
        }
    }
    for (device, sessions) in hosts {
        let online = remote(&app).lock().devices.iter().any(|d| d.id == device && d.online);
        if !online {
            continue;
        }
        match client::call(&app, &device, "subscribe", json!({"sessionIds": sessions})).await {
            Ok(reply) => catch_up(&app, &device, reply["tasks"].as_array().map(Vec::as_slice).unwrap_or_default()).await,
            Err(error) => eprintln!("PandaCode Connect: could not follow tasks on {}: {error}", super::device_label(&device)),
        }
    }
}

async fn catch_up(app: &tauri::AppHandle, device: &str, tasks: &[Value]) {
    let mut changed = false;
    for task in tasks {
        let (Some(session), Some(status)) = (task["sessionId"].as_str(), task["status"].as_str()) else { continue };
        let row = app.state::<AppState>().store.lock().ok().and_then(|store| {
            let local = local_id(&store, device, session)?;
            store.db.query_row("SELECT status,remote_synced_id FROM sessions WHERE id=?1", [&local], |r| Ok((local.clone(), r.get::<_, String>(0)?, r.get::<_, i64>(1)?))).ok()
        });
        let Some((local, current, synced)) = row else { continue };
        match reconcile(&current, status) {
            Reconcile::Ended { successful, stopped } => {
                end_turn(app, &local, successful, stopped, if successful { "Turn complete" } else if stopped { "Turn stopped" } else { "Turn failed" }).await;
                continue;
            }
            Reconcile::Set(status) => changed |= lock(&app.state::<AppState>()).and_then(|store| store.status(&local, &status)).is_ok(),
            Reconcile::Same => {}
        }
        if task["lastId"].as_i64().is_some_and(|last| last > synced) {
            changed |= sync(app, &local).await.is_ok();
        }
    }
    if changed {
        let _ = app.emit("sessions-changed", ());
    }
}

/// `{repo, branch, ahead, dirty, pushed}` for a checkout, from git's own output.
pub(crate) fn repo_summary(origin: &str, branch: &str, status: &str, ahead: Option<&str>, pushed: bool) -> Value {
    json!({
        "repo": crate::github_hub::repo_from_remote(origin),
        "branch": branch.trim(),
        "ahead": ahead.and_then(|count| count.trim().parse::<u64>().ok()).unwrap_or(0),
        "dirty": !status.trim().is_empty(),
        "pushed": pushed,
    })
}

/// What another computer would see of this checkout. Reads only local refs (no fetch).
fn repo_status(root: &Path) -> Result<Value> {
    let quick = Duration::from_secs(10);
    let origin = git(root, &["config", "--get", "remote.origin.url"], quick).unwrap_or_default();
    let branch = git(root, &["symbolic-ref", "--quiet", "--short", "HEAD"], quick).unwrap_or_default();
    let status = git(root, &["status", "--porcelain"], quick)?;
    let ahead = git(root, &["rev-list", "--count", "@{u}..HEAD"], quick).ok();
    let pushed = !branch.is_empty() && git(root, &["rev-parse", "--verify", "--quiet", &format!("refs/remotes/origin/{branch}")], quick).is_ok();
    Ok(repo_summary(&origin, &branch, &status, ahead.as_deref(), pushed))
}

async fn project_status(state: &AppState, project_id: &str) -> Result<Value> {
    let root = lock(state)?.workspace_root(project_id, None)?;
    tauri::async_runtime::spawn_blocking(move || repo_status(&root)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn remote_repo_check(state: tauri::State<'_, AppState>, project_id: String) -> Result<Value> {
    project_status(&state, &project_id).await
}

/// Starts a task on another computer and returns its local mirror, like `create_session`
/// (the session, plus `sessionId`). An empty New task draft given as `sessionId` becomes
/// the mirror.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn remote_start_task(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    device_id: String,
    project_id: String,
    prompt: String,
    provider: String,
    model: String,
    mode: Option<String>,
    effort: Option<String>,
    worktree: Option<bool>,
    branch: Option<String>,
    session_id: Option<String>,
) -> Result<Value> {
    super::valid_device_id(&device_id)?;
    {
        let state = remote(&app);
        let inner = state.lock();
        inner.callable(&device_id)?;
        if !inner.devices.iter().any(|d| d.id == device_id && d.host) {
            return Err(format!("{} does not allow remote control.", super::device_label(&device_id)));
        }
    }
    super::catalog::check(&app, &device_id, &provider, &model)?;
    let prompt = prompt.trim().to_owned();
    if prompt.is_empty() || prompt.len() > host::MAX_TEXT {
        return Err("Send between 1 byte and 100 KB of text.".into());
    }
    let check = project_status(&state, &project_id).await?;
    let repo = check["repo"].as_str().ok_or(NO_REPO)?.to_owned();
    let branch = branch.filter(|b| !b.trim().is_empty()).or_else(|| check["branch"].as_str().filter(|b| !b.is_empty()).map(str::to_owned));
    let (local, created) = mirror_row(&*lock(&state)?, &device_id, &project_id, &provider, &model, mode.as_deref(), effort.as_deref(), session_id.as_deref())?;
    let request = json!({"repo": repo, "branch": branch, "worktree": worktree.unwrap_or(false), "prompt": prompt, "provider": provider, "model": model, "mode": mode, "effort": effort});
    let started = client::call_within(&app, &device_id, "task.start", request, START_TIMEOUT).await.and_then(|reply| reply["sessionId"].as_str().filter(|id| host::valid_id(id).is_ok()).map(str::to_owned).ok_or_else(|| "The other computer did not start the task.".to_string()));
    let saved = started.and_then(|session| {
        lock(&state)?.db.execute("UPDATE sessions SET remote_session=?2 WHERE id=?1", params![local, session]).map_err(|e| e.to_string())
    });
    if let Err(error) = saved {
        // Leave nothing behind: a new row goes, a reused draft is a local draft again.
        if created {
            let _ = crate::task_deletion::delete_state(&state, &local);
        } else if let Ok(store) = lock(&state) {
            let _ = store.db.execute("UPDATE sessions SET remote_device=NULL,remote_session=NULL,draft=1,status='idle' WHERE id=?1", [&local]);
        }
        let _ = app.emit("sessions-changed", ());
        return Err(error);
    }
    tauri::async_runtime::spawn(subscribe_all(app.clone()));
    let _ = app.emit("sessions-changed", ());
    let mut session = serde_json::to_value(lock(&state)?.session(&local)?).map_err(|e| e.to_string())?;
    session["sessionId"] = json!(local);
    Ok(session)
}

/// Makes (or converts an empty draft into) the local mirror row, published and running.
#[allow(clippy::too_many_arguments)]
fn mirror_row(store: &Store, device: &str, project_id: &str, provider: &str, model: &str, mode: Option<&str>, effort: Option<&str>, draft: Option<&str>) -> Result<(String, bool)> {
    // A draft with its own local worktree keeps it; the mirror gets a fresh row.
    let reuse = draft.filter(|id| store.is_empty_draft(id).unwrap_or(false) && store.session(id).is_ok_and(|task| task.project_id == project_id && task.worktree_path.is_none()));
    // `create_user_task` commits its own transaction, so a new row is made before this one.
    let (id, created) = match reuse {
        Some(id) => (id.to_owned(), false),
        None => (crate::architect::profiles::create_user_task(store, project_id, provider, model, mode, None)?.id, true),
    };
    let transaction = store.db.unchecked_transaction().map_err(|e| e.to_string())?;
    if !created {
        store.configure(&id, provider, model, None)?;
        if let Some(mode) = mode {
            store.update(&id, None, None, None, Some(mode.to_owned()))?;
        }
    }
    if effort.is_some() {
        store.set_reasoning_effort(&id, effort)?;
    }
    store.db.execute("UPDATE sessions SET remote_device=?2,remote_session=NULL,remote_synced_id=0,draft=0 WHERE id=?1", params![id, device]).map_err(|e| e.to_string())?;
    start_turn(store, &id)?;
    transaction.commit().map_err(|e| e.to_string())?;
    Ok((id, created))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (Store, String) {
        let store = Store::open(Path::new(":memory:")).unwrap();
        let project = store.add_project(&std::env::temp_dir()).unwrap();
        let task = store.create_session(&project.id, "claude", "sonnet", "full").unwrap();
        store.db.execute("UPDATE sessions SET remote_device='host',remote_session='h1' WHERE id=?1", [&task.id]).unwrap();
        (store, task.id)
    }

    #[test]
    fn version_26_adds_the_mirror_columns() {
        let path = std::env::temp_dir().join(format!("pandacode-mirror-{}.sqlite3", uuid::Uuid::new_v4()));
        {
            let store = Store::open(&path).unwrap();
            store.db.execute_batch("DROP INDEX sessions_remote; ALTER TABLE sessions DROP COLUMN remote_device; ALTER TABLE sessions DROP COLUMN remote_session; ALTER TABLE sessions DROP COLUMN remote_synced_id; PRAGMA user_version=25;").unwrap();
        }
        let store = Store::open(&path).unwrap();
        assert_eq!((crate::storage::SCHEMA_VERSION, store.db.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0)).unwrap()), (27, 27));
        let columns: i64 = store.db.query_row("SELECT COUNT(*) FROM pragma_table_info('sessions') WHERE name IN ('remote_device','remote_session','remote_synced_id')", [], |r| r.get(0)).unwrap();
        assert_eq!(columns, 3);
        let project = store.add_project(&std::env::temp_dir()).unwrap();
        let task = store.create_session(&project.id, "claude", "sonnet", "full").unwrap();
        let synced: i64 = store.db.query_row("SELECT remote_synced_id FROM sessions WHERE id=?1", [&task.id], |r| r.get(0)).unwrap();
        assert_eq!((synced, task.remote_device), (0, None));
        drop(store);
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    }

    #[test]
    fn a_mirror_knows_its_host_task() {
        let (store, local) = store();
        let mirror = of(&store, &local).unwrap().unwrap();
        assert_eq!((mirror.device.as_str(), mirror.session.as_str()), ("host", "h1"));
        assert_eq!(local_id(&store, "host", "h1"), Some(local.clone()));
        assert_eq!(local_id(&store, "other", "h1"), None, "only the host that runs it");
        let task = store.session(&local).unwrap();
        assert_eq!(task.remote_device.map(|d| d.id), Some("host".into()));
        assert_eq!(serde_json::to_value(store.session(&local).unwrap()).unwrap()["remoteDevice"]["name"], "another computer");
        // The checkout is on the host: git and worktree commands never reach this disk.
        assert_eq!(store.workspace_root(&task.project_id, Some(&local)), Err("This task runs on another computer.".into()));
        store.db.execute("UPDATE sessions SET remote_session=NULL WHERE id=?1", [&local]).unwrap();
        assert!(of(&store, &local).unwrap_err().contains("still starting"));
        let plain = store.create_session(&task.project_id, "claude", "sonnet", "full").unwrap();
        assert!(of(&store, &plain.id).unwrap().is_none());
        assert!(serde_json::to_value(plain).unwrap().get("remoteDevice").is_none());
    }

    #[test]
    fn a_mirror_send_goes_to_its_host_task() {
        let (store, local) = store();
        let routed = prepare(&store, &local, "task.send", json!({"text": "hi"})).unwrap().unwrap();
        assert_eq!(routed, Routed { device: "host".into(), params: json!({"text": "hi", "sessionId": "h1"}), before: Some("idle".into()) });
        let task = store.session(&local).unwrap();
        assert_eq!((task.status.as_str(), task.task_stage.as_str()), ("running", "in_progress"), "running before the host answers");
        // Other commands carry the host id and leave the status alone.
        let stop = prepare(&store, &local, "task.stop", json!({})).unwrap().unwrap();
        assert_eq!((stop.params, stop.before), (json!({"sessionId": "h1"}), None));
        // A local task is not routed: the command runs here as always.
        let plain = store.create_session(&task.project_id, "claude", "sonnet", "full").unwrap();
        assert_eq!(prepare(&store, &plain.id, "task.send", json!({"text": "hi"})).unwrap(), None);
        assert_eq!(store.session(&plain.id).unwrap().status, "idle");
    }

    #[test]
    fn events_take_the_local_id() {
        let events = [
            json!({"sessionId": "h1", "kind": "text", "text": "Hel", "requestId": null, "data": null}),
            json!({"sessionId": "h2", "kind": "text", "text": "other task", "requestId": null, "data": null}),
            json!({"sessionId": "h1", "kind": "done", "text": "Turn complete"}),
            json!({"sessionId": "h1", "kind": "approval", "text": "Run ls", "requestId": "run:r1", "data": null}),
            json!({"kind": "text", "text": "no id"}),
        ];
        let out = relabel(&events, |id| (id == "h1").then(|| "local".to_string()));
        assert_eq!(out, vec![json!({"sessionId": "local", "kind": "text", "text": "Hel", "requestId": null, "data": null}), json!({"sessionId": "local", "kind": "approval", "text": "Run ls", "requestId": "run:r1", "data": null})]);
    }

    #[test]
    fn only_an_empty_draft_without_a_worktree_becomes_the_mirror() {
        let store = Store::open(Path::new(":memory:")).unwrap();
        let project = store.add_project(&std::env::temp_dir()).unwrap();
        let draft = store.create_session(&project.id, "claude", "sonnet", "full").unwrap();
        store.mark_draft(&draft.id).unwrap();
        let (id, created) = mirror_row(&store, "host", &project.id, "codex", "gpt", None, None, Some(&draft.id)).unwrap();
        assert_eq!((id.as_str(), created), (draft.id.as_str(), false));
        let mirror = store.session(&id).unwrap();
        assert_eq!((mirror.provider.as_str(), mirror.status.as_str(), mirror.draft), ("codex", "running", false));
        let other = store.create_session(&project.id, "claude", "sonnet", "full").unwrap();
        store.mark_draft(&other.id).unwrap();
        store.attach_worktree(&other.id, &std::env::temp_dir(), "pandacode/x").unwrap();
        let (fresh, created) = mirror_row(&store, "host", &project.id, "claude", "sonnet", None, None, Some(&other.id)).unwrap();
        assert!(created && fresh != other.id);
        assert_eq!(store.session(&other.id).unwrap().remote_device, None, "the worktree draft stays local");
    }

    #[test]
    fn a_turn_ends_once() {
        let (store, local) = store();
        store.status(&local, "running").unwrap();
        assert!(finish_once(&store, &local, false, true).unwrap());
        assert_eq!(store.session(&local).unwrap().status, "interrupted");
        assert!(!finish_once(&store, &local, true, false).unwrap(), "a second end changes nothing");
        assert_eq!(store.session(&local).unwrap().status, "interrupted");
    }

    #[test]
    fn a_stop_ends_locally_only_when_the_host_is_unreachable() {
        assert!(unreachable(super::super::socket::OFFLINE, true));
        assert!(unreachable("anything", false));
        assert!(!unreachable("That computer did not answer in time.", true));
        assert!(!unreachable("This agent is no longer running.", true));
    }

    #[test]
    fn events_move_the_status() {
        assert_eq!(status_after("idle", "text"), Some("running"));
        assert_eq!(status_after("running", "text"), None);
        assert_eq!(status_after("running", "approval"), Some("waiting"));
        assert_eq!(status_after("waiting", "tool"), None);
        assert_eq!(status_after("waiting", "approval_cancelled"), Some("running"));
        assert_eq!(reconcile("idle", "running"), Reconcile::Set("running".into()));
        assert_eq!(reconcile("running", "running"), Reconcile::Same);
        assert_eq!(reconcile("running", "idle"), Reconcile::Ended { successful: true, stopped: false });
        assert_eq!(reconcile("interrupted", "idle"), Reconcile::Same);
    }

    #[test]
    fn pages_are_stored_once_and_advance_the_sync() {
        let (host, host_task) = store();
        let (viewer, local) = store();
        for i in 0..5 {
            host.message(&host_task, if i % 2 == 0 { "user" } else { "assistant" }, &format!("{i}{}", "x".repeat(60 * 1024))).unwrap();
        }
        host.db.execute("UPDATE sessions SET title='Fix the build' WHERE id=?1", [&host_task]).unwrap();
        let first = host::messages_page(&host.db, &host_task, 0).unwrap();
        assert_eq!((first["messages"].as_array().unwrap().len(), first["hasMore"].as_bool()), (2, Some(true)), "a page fits one frame");
        assert!(first.to_string().len() <= host::PAGE_BUDGET);
        assert!(store_page(&viewer, &local, 0, &first).unwrap());
        let synced: i64 = viewer.db.query_row("SELECT remote_synced_id FROM sessions WHERE id=?1", [&local], |r| r.get(0)).unwrap();
        assert_eq!(synced, first["messages"][1]["id"].as_i64().unwrap());
        // A page from a stale position (a concurrent sync) is skipped, never duplicated.
        assert!(!store_page(&viewer, &local, 0, &first).unwrap());
        let mut after = synced;
        loop {
            let page = host::messages_page(&host.db, &host_task, after).unwrap();
            let more = store_page(&viewer, &local, after, &page).unwrap();
            after = viewer.db.query_row("SELECT remote_synced_id FROM sessions WHERE id=?1", [&local], |r| r.get(0)).unwrap();
            if !more {
                break;
            }
        }
        let copied = viewer.messages(&local, None).unwrap();
        assert_eq!(copied.iter().map(|m| m.content.chars().next().unwrap()).collect::<String>(), "01234");
        assert_eq!(copied[0].role, "user");
        assert_eq!(viewer.session(&local).unwrap().title, "Fix the build");
        let empty = host::messages_page(&host.db, &host_task, after).unwrap();
        assert_eq!((empty["messages"].as_array().unwrap().len(), empty["hasMore"].as_bool()), (0, Some(false)));
        assert!(store_page(&viewer, &local, after, &json!({"messages": [{"id": 1, "role": "user", "content": "old", "createdAt": 0}]})).is_err(), "ids only move forward");
    }

    #[test]
    fn the_repo_check_reads_git_output() {
        assert_eq!(repo_summary("git@github.com:orbit-labs/orbit.git\n", "feature\n", " M src/a.rs\n", Some("3\n"), true), json!({"repo": "orbit-labs/orbit", "branch": "feature", "ahead": 3, "dirty": true, "pushed": true}));
        assert_eq!(repo_summary("", "", "", None, false), json!({"repo": null, "branch": "", "ahead": 0, "dirty": false, "pushed": false}));
        assert_eq!(repo_summary("https://gitlab.com/a/b.git", "main", "", Some("x"), false)["repo"], Value::Null);
    }
}
