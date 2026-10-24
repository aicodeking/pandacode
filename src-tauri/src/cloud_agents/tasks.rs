//! Cloud tasks: the rows, the machine behind each, and what happens before and after every
//! run (docs/cloud-agents.md → How it works, IPC).
use super::{bridge, credentials, setup, stage, sync, update, State};
use crate::cloud::sandbox::{self, Sandbox, AGENT_PROVIDERS};
use crate::{storage::Session, storage::Store, workspace, AppState, Result};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

/// Starting or creating a machine can take a while on some providers.
const MACHINE_WAIT: Duration = Duration::from_secs(10 * 60);
/// After a run, the machine may stop on its own after this many idle minutes.
const IDLE_MINUTES: u32 = 15;
/// How long a run may take to exit once its input closed before it is killed.
const EXIT_GRACE: Duration = Duration::from_secs(30);
/// Providers whose machines can't run commands, so never run agents.
const NO_AGENTS: [&str; 2] = ["agentcore", "railway"];

pub(crate) fn harness_refusal(harness: &str) -> String {
    format!("{harness} can't run on a cloud machine. Choose Claude Code, GLM, MiMo, Codex or OpenCode, or run this task on this computer.")
}

fn with_store<T>(app: &tauri::AppHandle, f: impl FnOnce(&Store) -> Result<T>) -> Result<T> {
    let state = app.state::<AppState>();
    let store = state.store.lock().map_err(|e| e.to_string())?;
    f(&store)
}

fn label(provider: &str) -> &str {
    AGENT_PROVIDERS.iter().find(|(id, _)| *id == provider).map_or(provider, |(_, label)| label)
}

/// What the bridge needs for one run.
pub(crate) struct Prepared {
    pub provider: String,
    pub native: String,
    pub remote_dir: String,
    pub program: String,
    pub env: Vec<(String, String)>,
    pub run_id: String,
}

struct Ready {
    sandbox: Box<dyn Sandbox>,
    native: String,
    remote_dir: String,
    program: String,
}

fn wait_running(sandbox: &dyn Sandbox, native: &str) -> Result<()> {
    let started = Instant::now();
    loop {
        match sandbox.state(native)?.as_str() {
            "running" => return Ok(()),
            "error" => return Err("The cloud machine failed to start.".into()),
            _ if started.elapsed() > MACHINE_WAIT => return Err("The cloud machine did not start in time.".into()),
            _ => std::thread::sleep(Duration::from_secs(3)),
        }
    }
}

/// The task's machine, running: started if stopped, recreated if gone (or stopped and not
/// persistent). True when it is new, so it needs the checkout and saved state again.
fn ensure_machine(app: &tauri::AppHandle, sid: &str, sandbox: &dyn Sandbox, state: &State) -> Result<(String, bool)> {
    if let Some(native) = state.native() {
        match sandbox.state(native).as_deref() {
            Ok("running") => return Ok((native.to_owned(), false)),
            Ok(current) if sandbox.info().persistent && current != "error" => {
                stage(app, sid, "creating", Some("Starting the cloud machine…"));
                if current != "starting" {
                    sandbox.power(native, "start")?;
                }
                wait_running(sandbox, native)?;
                return Ok((native.to_owned(), false));
            }
            Ok(_) => {
                let _ = sandbox.power(native, "delete");
            }
            Err(_) => {}
        }
    }
    stage(app, sid, "creating", Some(&format!("Creating a {} machine…", label(&state.provider))));
    let machine = sandbox.create(&format!("pc-{}", sid.chars().take(8).collect::<String>()))?;
    let native = crate::cloud::split(&machine.id).map(|(_, native)| native.to_owned()).ok_or("The cloud provider returned a machine ID PandaCode cannot use.")?;
    update(app, sid, |state| {
        state.machine = Some(format!("{}:{native}", state.provider));
        state.remote_dir = None;
        state.base = None;
    })?;
    wait_running(sandbox, &native)?;
    Ok((native, true))
}

fn state_store(app: &tauri::AppHandle, sid: &str) -> Result<PathBuf> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("cloud-agents").join(sid);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Makes the machine ready for a run: running, runtime installed, checkout current.
fn prepare_machine(app: &tauri::AppHandle, sid: &str) -> Result<Ready> {
    let (state, task) = with_store(app, |store| Ok((super::load(store, sid)?.ok_or("This task does not run on a cloud machine.")?, store.session(sid)?)))?;
    if !setup::HARNESSES.contains(&task.provider.as_str()) {
        return Err(harness_refusal(&task.provider));
    }
    let local = PathBuf::from(task.worktree_path.clone().ok_or("This cloud task has lost its local checkout.")?);
    let sandbox = sandbox::connected(&state.provider)?;
    let (native, fresh) = ensure_machine(app, sid, &*sandbox, &state)?;
    let remote_dir = match (&state.remote_dir, fresh) {
        (Some(dir), false) => dir.clone(),
        _ => format!("{}/pandacode/{sid}", bridge::home(&*sandbox, &native)?),
    };
    stage(app, sid, "installing", Some(&format!("Installing {}…", task.provider)));
    let program = setup::ensure_runtime(&*sandbox, &native, &task.provider, &|detail| stage(app, sid, "installing", Some(detail)))?;
    let state = with_store(app, |store| super::load(store, sid))?.unwrap_or(state);
    if fresh || state.base.is_none() || state.remote_dir.is_none() {
        stage(app, sid, "uploading", Some("Uploading the checkout…"));
        let branch = task.worktree_branch.clone().unwrap_or_else(|| format!("pandacode/cloud-{}", sid.chars().take(8).collect::<String>()));
        let base = sync::upload_checkout(&*sandbox, &native, &local, &remote_dir, &branch)?;
        sync::restore_harness_state(&*sandbox, &native, &task.provider, &remote_dir, &state_store(app, sid)?)?;
        update(app, sid, |state| {
            state.base = Some(base);
            state.remote_dir = Some(remote_dir.clone());
        })?;
    } else {
        stage(app, sid, "uploading", Some("Sending local commits…"));
        sync::push_local(&*sandbox, &native, &remote_dir, &local)?;
    }
    Ok(Ready { sandbox, native, remote_dir, program })
}

/// Before every run (blocking): the machine, credentials and checkout, then a new run ID.
/// An attach only needs to know where the run is.
pub(crate) fn before_run(app: &tauri::AppHandle, sid: &str, harness: &str, attach: bool) -> Result<Prepared> {
    if attach {
        let state = with_store(app, |store| super::load(store, sid))?.ok_or("This task does not run on a cloud machine.")?;
        let (Some(native), Some(run_id), Some(remote_dir)) = (state.native(), state.run_id.clone(), state.remote_dir.clone()) else {
            return Err("This cloud run can't be reached any more.".into());
        };
        stage(app, sid, "reconnecting", Some("Catching up with the cloud run…"));
        return Ok(Prepared { provider: state.provider.clone(), native: native.to_owned(), remote_dir, program: String::new(), env: Vec::new(), run_id });
    }
    let result = (|| -> Result<Prepared> {
        if with_store(app, |store| super::load(store, sid))?.is_some_and(|state| state.run_id.is_some()) {
            return Err("This task is still finishing its last cloud run. Try again in a moment.".into());
        }
        let ready = prepare_machine(app, sid)?;
        stage(app, sid, "credentials", Some("Signing in…"));
        let env = credentials::push(&*ready.sandbox, &ready.native, harness)?;
        ready.sandbox.keep_alive(&ready.native, ready.sandbox.info().max_unattended_minutes)?;
        let run_id = uuid::Uuid::new_v4().to_string();
        let turn = with_store(app, |store| {
            store.db.query_row("SELECT COALESCE(MAX(id),0) FROM messages WHERE session_id=?1 AND role IN ('user','coordination')", [sid], |r| r.get(0)).map_err(|e| e.to_string())
        })?;
        let state = update(app, sid, |state| {
            state.run_id = Some(run_id.clone());
            state.stage = "running".into();
            state.detail = None;
            state.offset = 0;
            state.inbox_lines = 0;
            state.turn_message = turn;
        })?;
        Ok(Prepared { provider: state.provider, native: ready.native, remote_dir: ready.remote_dir, program: ready.program, env, run_id })
    })();
    if let Err(error) = &result {
        stage(app, sid, "error", Some(error));
    }
    result
}

/// After every run (blocking), once its messages are saved: wait for the remote run to
/// exit (killing it after a grace period), then bring the changes back. Until the pull is
/// done or failed with a note, `run_id` stays, so a quit or an unreachable machine leaves
/// the run re-attachable and it is finalized later.
pub(crate) fn after_run(app: &tauri::AppHandle, sid: &str) -> Result<()> {
    let Some(state) = with_store(app, |store| super::load(store, sid))? else { return Ok(()) };
    // No run started (preparation failed and said why): nothing to bring back.
    let (Some(run_id), Some(native)) = (state.run_id.clone(), state.native().map(str::to_owned)) else {
        return Ok(());
    };
    let sandbox = sandbox::connected(&state.provider)?;
    bridge::finish(&*sandbox, &native, &run_id, EXIT_GRACE)?;
    pull(app, sid)
}

/// Brings the machine's changes back now (also the Sync action).
fn pull(app: &tauri::AppHandle, sid: &str) -> Result<()> {
    let (state, task) = with_store(app, |store| Ok((super::load(store, sid)?, store.session(sid)?)))?;
    let Some(state) = state else { return Ok(()) };
    let (Some(native), Some(remote_dir)) = (state.native().map(str::to_owned), state.remote_dir.clone()) else {
        return Ok(());
    };
    stage(app, sid, "syncing", Some("Bringing changes back…"));
    let result = (|| {
        let sandbox = sandbox::connected(&state.provider)?;
        let local = PathBuf::from(task.worktree_path.clone().ok_or("This cloud task has lost its local checkout.")?);
        let pulled = sync::pull_changes(&*sandbox, &native, &remote_dir, &local, sid, &task.title)?;
        if let Err(error) = sync::save_harness_state(&*sandbox, &native, &task.provider, &remote_dir, &state_store(app, sid)?) {
            eprintln!("Cloud agents: could not save the harness state: {error}");
        }
        let _ = sandbox.keep_alive(&native, IDLE_MINUTES);
        Ok::<_, String>(pulled)
    })();
    let (next, detail) = match &result {
        Ok(pulled) => ("ready", pulled.note.clone()),
        Err(error) => ("error", Some(format!("Could not bring the changes back: {error}"))),
    };
    update(app, sid, |state| {
        state.run_id = None;
        state.stage = next.into();
        state.detail = detail.clone();
    })?;
    if let Some(note) = detail {
        let _ = app.emit("agent-event", crate::event(sid, "status", &note));
    }
    result.map(drop)
}

/// Stop: kills the remote run's process group (best effort, in the background).
pub(crate) fn stop_run(app: &tauri::AppHandle, sid: &str) {
    let Ok(Some(state)) = with_store(app, |store| super::load(store, sid)) else { return };
    let (Some(native), Some(run_id)) = (state.native().map(str::to_owned), state.run_id.clone()) else { return };
    std::thread::spawn(move || {
        if let Err(error) = sandbox::connected(&state.provider).and_then(|sandbox| bridge::kill(&*sandbox, &native, &run_id)) {
            eprintln!("Cloud agents: could not stop a cloud run: {error}");
        }
    });
}

/// A deleted task's machine goes too (best effort, in the background).
pub(crate) fn forget_machine(state: Option<State>) {
    let Some(state) = state else { return };
    let Some(native) = state.native().map(str::to_owned) else { return };
    std::thread::spawn(move || {
        if let Err(error) = sandbox::connected(&state.provider).and_then(|sandbox| sandbox.power(&native, "delete")) {
            eprintln!("Cloud agents: could not delete a task's machine: {error}");
        }
    });
}

fn git(root: &Path, index: Option<&Path>, args: &[&str]) -> Result<String> {
    let mut command = Command::new("git");
    command.arg("-C").arg(root).args(args);
    if let Some(index) = index {
        command.env("GIT_INDEX_FILE", index);
    }
    let output = workspace::checked(workspace::run_process(command, "git", 64 * 1024, Duration::from_secs(120))?)?;
    Ok(String::from_utf8_lossy(&output.bytes).trim().to_owned())
}

/// A commit holding the checkout's uncommitted (and untracked, not ignored) changes on top
/// of HEAD, made with a private index so the user's staging stays untouched. None when clean.
fn snapshot(root: &Path) -> Result<Option<String>> {
    let index = std::env::temp_dir().join(format!("pandacode-cloud-index-{}", uuid::Uuid::new_v4()));
    let result = (|| {
        git(root, Some(&index), &["read-tree", "HEAD"])?;
        git(root, Some(&index), &["add", "-A"])?;
        let tree = git(root, Some(&index), &["write-tree"])?;
        if tree == git(root, None, &["rev-parse", "HEAD^{tree}"])? {
            return Ok(None);
        }
        git(root, None, &["commit-tree", &tree, "-p", "HEAD", "-m", "Uncommitted changes for a cloud task"]).map(Some)
    })();
    let _ = std::fs::remove_file(&index);
    result
}

/// The mirror worktree on `pandacode/cloud-<short>`, from the current branch plus its
/// uncommitted changes as a first commit.
fn mirror_worktree(root: &Path, short: &str) -> Result<workspace::Worktree> {
    let base = snapshot(root).map_err(|error| format!("Could not copy the uncommitted changes: {error}"))?;
    workspace::create_worktree_with(root, &format!("pandacode/cloud-{short}"), base.as_deref(), false)
}

/// The empty New task draft, converted, or a new row; published with its settings.
#[allow(clippy::too_many_arguments)]
fn task_row(store: &Store, draft: Option<&str>, project_id: &str, harness: &str, model: &str, mode: Option<&str>, effort: Option<&str>) -> Result<(String, bool)> {
    let reuse = draft.filter(|id| store.is_empty_draft(id).unwrap_or(false) && store.session(id).is_ok_and(|task| task.project_id == project_id && task.worktree_path.is_none()));
    let (id, created) = match reuse {
        Some(id) => (id.to_owned(), false),
        None => (crate::architect::profiles::create_user_task(store, project_id, harness, model, mode, None)?.id, true),
    };
    if !created {
        store.configure(&id, harness, model, None)?;
        if let Some(mode) = mode {
            store.update(&id, None, None, None, Some(mode.to_owned()))?;
        }
    }
    if effort.is_some() {
        store.set_reasoning_effort(&id, effort)?;
    }
    Ok((id, created))
}

#[tauri::command]
pub(crate) async fn cloud_agent_targets() -> Result<Vec<Value>> {
    crate::blocking(|| Ok(targets(sandbox::ready))).await
}

/// Every provider that can run agents, whether or not it is connected.
fn targets(ready: impl Fn(&str) -> bool) -> Vec<Value> {
    AGENT_PROVIDERS.iter().filter(|(id, _)| !NO_AGENTS.contains(id)).map(|(id, label)| json!({"provider": id, "label": label, "ready": ready(id)})).collect()
}

/// Settings → Cloud: a long-lived Claude token (`claude setup-token`) for cloud agents,
/// used instead of copying this computer's Claude Code login.
#[tauri::command]
pub(crate) async fn cloud_agent_set_claude_token(token: String) -> Result<()> {
    let token = token.trim().to_owned();
    if token.is_empty() || token.len() > 4096 || token.chars().any(char::is_whitespace) {
        return Err("Paste the token from claude setup-token.".into());
    }
    crate::blocking(move || crate::cloud::set_secret("claude_setup_token", &token)).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn cloud_agent_start(
    app: tauri::AppHandle,
    session_id: Option<String>,
    project_id: String,
    provider: String,
    prompt: String,
    harness: String,
    model: String,
    mode: Option<String>,
    effort: Option<String>,
) -> Result<Session> {
    if NO_AGENTS.contains(&provider.as_str()) || !AGENT_PROVIDERS.iter().any(|(id, _)| *id == provider) {
        return Err("This provider can't run cloud agents.".into());
    }
    if !setup::HARNESSES.contains(&harness.as_str()) {
        return Err(harness_refusal(&harness));
    }
    let prompt = prompt.trim().to_owned();
    if prompt.is_empty() || prompt.len() > 128 * 1024 {
        return Err("Write a message under 128 KiB first.".into());
    }
    let worker = app.clone();
    let session = crate::blocking(move || {
        if !sandbox::ready(&provider) {
            return Err(format!("Connect {} in Settings → Cloud first.", label(&provider)));
        }
        let (root, id, created) = with_store(&worker, |store| {
            let root = store.workspace_root(&project_id, None)?;
            let (id, created) = task_row(store, session_id.as_deref(), &project_id, &harness, &model, mode.as_deref(), effort.as_deref())?;
            Ok((root, id, created))
        })?;
        let worktree = mirror_worktree(&root, &id.chars().take(8).collect::<String>());
        with_store(&worker, |store| {
            let worktree = match worktree {
                Ok(worktree) => worktree,
                Err(error) => {
                    if created {
                        let _ = store.db.execute("DELETE FROM sessions WHERE id=?1", [&id]);
                    }
                    return Err(error);
                }
            };
            store.attach_worktree(&id, &worktree.path, &worktree.branch)?;
            let state = State { provider: provider.clone(), stage: "creating".into(), detail: Some(format!("Creating a {} machine…", label(&provider))), pending_prompt: Some(prompt), ..State::default() };
            super::save(store, &id, Some(&state))?;
            store.db.execute("UPDATE sessions SET draft=0,updated_at=?2 WHERE id=?1", rusqlite::params![id, crate::storage::now()]).map_err(|e| e.to_string())?;
            store.session(&id)
        })
    })
    .await?;
    let _ = app.emit("sessions-changed", ());
    prepare_and_send(app, session.id.clone());
    Ok(session)
}

/// Prepares the machine in the background, then sends the waiting first prompt.
fn prepare_and_send(app: tauri::AppHandle, sid: String) {
    tauri::async_runtime::spawn(async move {
        let worker = app.clone();
        let id = sid.clone();
        let prepared = crate::blocking(move || prepare_machine(&worker, &id).map(drop)).await;
        if let Err(error) = prepared {
            stage(&app, &sid, "error", Some(&error));
            return;
        }
        stage(&app, &sid, "ready", None);
        let prompt = with_store(&app, |store| super::load(store, &sid)).ok().flatten().and_then(|state| state.pending_prompt);
        let Some(prompt) = prompt else { return };
        let _ = update(&app, &sid, |state| state.pending_prompt = None);
        if let Err(error) = crate::launch_task_in_project(app.clone(), app.state::<AppState>(), sid.clone(), Some(prompt.clone()), None, None).await {
            let _ = update(&app, &sid, |state| {
                state.pending_prompt = Some(prompt);
                state.stage = "error".into();
                state.detail = Some(error);
            });
        }
    });
}

#[tauri::command]
pub(crate) async fn cloud_agent_action(app: tauri::AppHandle, session_id: String, action: String) -> Result<Value> {
    let state = with_store(&app, |store| super::load(store, &session_id))?.ok_or("This task does not run on a cloud machine.")?;
    let running = app.state::<AppState>().agents.lock().map_err(|e| e.to_string())?.contains_key(&session_id);
    if action == "open" {
        return Ok(json!({"machine": state.machine}));
    }
    if running || state.active() {
        return Err("Wait for the agent to finish, or stop it first.".into());
    }
    match action.as_str() {
        "retry" => prepare_and_send(app, session_id),
        "sync" => {
            let worker = app.clone();
            crate::blocking(move || pull(&worker, &session_id)).await?;
        }
        "stop" | "delete" => {
            let native = state.native().ok_or("This task has no cloud machine yet.")?.to_owned();
            let worker = app.clone();
            let provider = state.provider.clone();
            let power = action.clone();
            crate::blocking(move || sandbox::connected(&provider)?.power(&native, &power)).await?;
            update(&worker, &session_id, |state| {
                state.stage = "stopped".into();
                if action == "delete" {
                    state.machine = None;
                    state.remote_dir = None;
                    state.base = None;
                    state.detail = Some("Your next message creates a new machine.".into());
                } else {
                    state.detail = Some("Your next message starts it again.".into());
                }
            })?;
        }
        _ => return Err("Unknown cloud action.".into()),
    }
    Ok(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo() -> PathBuf {
        let root = std::env::temp_dir().join(format!("pandacode-cloud-repo-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        for args in [
            &["init", "-q", "-b", "main"][..],
            &["config", "user.email", "t@example.com"],
            &["config", "user.name", "T"],
            // The test compares bytes; a global autocrlf must not rewrite them.
            &["config", "core.autocrlf", "false"],
        ] {
            git(&root, None, args).unwrap();
        }
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        git(&root, None, &["add", "a.txt"]).unwrap();
        git(&root, None, &["commit", "-q", "-m", "first"]).unwrap();
        root
    }

    #[test]
    fn the_mirror_worktree_carries_uncommitted_changes_without_touching_the_index() {
        let root = repo();
        assert_eq!(snapshot(&root).unwrap(), None);
        std::fs::write(root.join("a.txt"), "two\n").unwrap();
        std::fs::write(root.join("new.txt"), "new\n").unwrap();
        let worktree = mirror_worktree(&root, "abcd1234").unwrap();
        assert_eq!(worktree.branch, "pandacode/cloud-abcd1234");
        assert_eq!(std::fs::read_to_string(worktree.path.join("a.txt")).unwrap(), "two\n");
        assert_eq!(std::fs::read_to_string(worktree.path.join("new.txt")).unwrap(), "new\n");
        assert_eq!(git(&worktree.path, None, &["status", "--porcelain"]).unwrap(), "");
        // The user's checkout is exactly as it was: nothing staged, the new file untracked.
        assert_eq!(git(&root, None, &["status", "--porcelain"]).unwrap(), "M a.txt\n?? new.txt");
        let _ = std::fs::remove_dir_all(&worktree.path);
        let _ = std::fs::remove_dir_all(root.parent().unwrap().join(format!("{}-worktrees", root.file_name().unwrap().to_string_lossy())));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn targets_leave_out_providers_that_cannot_run_agents() {
        let list = targets(|id| id == "e2b");
        let ids: Vec<&str> = list.iter().filter_map(|t| t["provider"].as_str()).collect();
        assert!(!ids.contains(&"railway") && !ids.contains(&"agentcore"));
        assert!(ids.contains(&"daytona") && ids.contains(&"boat"));
        assert_eq!(list.iter().filter(|t| t["ready"] == true).count(), 1);
    }

    #[test]
    fn a_new_task_draft_becomes_the_cloud_task() {
        let store = Store::open(Path::new(":memory:")).unwrap();
        let project = store.add_project(&std::env::temp_dir()).unwrap();
        let draft = store.create_session(&project.id, "claude", "default", "ask").unwrap();
        store.db.execute("UPDATE sessions SET draft=1 WHERE id=?1", [&draft.id]).unwrap();
        let (id, created) = task_row(&store, Some(&draft.id), &project.id, "codex", "gpt", Some("full"), None).unwrap();
        assert_eq!((id.as_str(), created), (draft.id.as_str(), false));
        let task = store.session(&id).unwrap();
        assert_eq!((task.provider.as_str(), task.model.as_str(), task.mode.as_str()), ("codex", "gpt", "full"));
        let (other, created) = task_row(&store, None, &project.id, "claude", "default", None, None).unwrap();
        assert!(created && other != id);
    }
}
