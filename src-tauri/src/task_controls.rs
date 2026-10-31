//! Task-scoped native command workflows. Remote IDs and checkouts come from saved tasks.
use super::*;
use crate::goal_state::{GoalRequest, GoalState};
use rusqlite::OptionalExtension;
use serde_json::{json, Value};
use tokio::sync::oneshot;

pub(super) struct GoalLaunch {
    pub request: GoalRequest,
    pub reply: oneshot::Sender<Result<Option<GoalState>>>,
}

fn context(state: &AppState, sid: &str) -> Result<(Session, PathBuf)> {
    let store = state.store.lock().map_err(|e| e.to_string())?;
    let task = store.session(sid)?;
    if task.provider != "codex" {
        return Err("Use the Codex harness for this command.".into());
    }
    let cwd = store.workspace_root(&task.project_id, Some(sid))?;
    Ok((task, cwd))
}

async fn live_request(state: &AppState, sid: &str, method: &str, params: Value) -> Result<Value> {
    let (task, _) = context(state, sid)?;
    task.resume_id
        .ok_or("The agent has not opened its Codex task yet.")?;
    let (tx, rx) = oneshot::channel();
    state
        .agents
        .lock()
        .map_err(|e| e.to_string())?
        .get(sid)
        .ok_or("This task has no running Codex process.")?
        .input
        .send(RunInput::CodexRequest {
            method: method.into(),
            params,
            reply: tx,
        })
        .map_err(|_| "The agent is stopping. Try again after it finishes.".to_string())?;
    tokio::time::timeout(std::time::Duration::from_secs(35), rx)
        .await
        .map_err(|_| "Codex did not acknowledge the command in time.".to_string())?
        .map_err(|_| "The Codex process stopped.".to_string())?
}

async fn live_goal(
    input: UnboundedSender<RunInput>,
    request: GoalRequest,
) -> Result<Option<GoalState>> {
    let (tx, rx) = oneshot::channel();
    input
        .send(RunInput::Goal { request, reply: tx })
        .map_err(|_| "The agent is stopping.".to_string())?;
    tokio::time::timeout(std::time::Duration::from_secs(35), rx)
        .await
        .map_err(|_| "Codex did not acknowledge the goal in time.".to_string())?
        .map_err(|_| "The agent stopped.".to_string())?
}

#[tauri::command]
pub(super) async fn task_goal(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    request: GoalRequest,
) -> Result<Option<GoalState>> {
    if !matches!(request, GoalRequest::Get) {
        let store = state.store.lock().map_err(|e| e.to_string())?;
        if crate::architect::load(&store, &session_id)?.is_some()
            || crate::architect::parent_of(&store, &session_id)?.is_some()
        {
            return Err(
                "Native goals cannot run inside an architect team. Use the team controls.".into(),
            );
        }
    }
    let (task, cwd) = context(&state, &session_id)?;
    if let GoalRequest::Set {
        objective,
        token_budget,
    } = &request
    {
        if objective.trim().is_empty()
            || objective.len() > 32 * 1024
            || token_budget.is_some_and(|n| n == 0 || n > 9_007_199_254_740_991)
        {
            return Err("Enter a goal under 32 KiB and an optional positive token budget.".into());
        }
    }
    let running = state
        .agents
        .lock()
        .map_err(|e| e.to_string())?
        .get(&session_id)
        .map(|a| a.input.clone());
    if let Some(input) = running {
        return live_goal(input, request).await;
    }
    if matches!(request, GoalRequest::Get) {
        let Some(remote) = task.resume_id.as_deref() else {
            return Ok(None);
        };
        let goal = command_operations::read_goal(&cwd, remote).await?;
        // An agent may have started or the selected harness may have changed
        // while the independent metadata process was reading its snapshot.
        let running = {
            let agents = state.agents.lock().map_err(|error| error.to_string())?;
            let store = state.store.lock().map_err(|error| error.to_string())?;
            let current = store.session(&session_id)?;
            if current.provider != "codex" || current.resume_id.as_deref() != Some(remote) {
                return Err(
                    "This task changed while its goal was being refreshed. Open the goal again."
                        .into(),
                );
            }
            if let Some(agent) = agents.get(&session_id) {
                Some(agent.input.clone())
            } else {
                store.record_goal(&session_id, goal.as_ref())?;
                let mut refreshed = event(&session_id, "goal", "");
                refreshed.data = serde_json::to_value(&goal).ok();
                let _ = app.emit("agent-event", refreshed);
                None
            }
        };
        return if let Some(input) = running {
            live_goal(input, GoalRequest::Get).await
        } else {
            Ok(goal)
        };
    }
    if !matches!(request, GoalRequest::Set { .. }) && task.resume_id.is_none() {
        return Err("This task has no native Codex conversation yet.".into());
    }
    let text = match &request {
        GoalRequest::Set { objective, .. } => objective.clone(),
        _ => "Goal control".into(),
    };
    let (tx, rx) = oneshot::channel();
    launch_operation(
        app,
        state,
        session_id,
        Some(text),
        None,
        None,
        Some(GoalLaunch { request, reply: tx }),
    )
    .await?;
    tokio::time::timeout(std::time::Duration::from_secs(45), rx)
        .await
        .map_err(|_| {
            "Codex is taking longer to open this goal. Its status will update in the task."
                .to_string()
        })?
        .map_err(|_| "The agent stopped before acknowledging the goal.".to_string())?
}

#[tauri::command]
pub(super) async fn codex_command(
    state: State<'_, AppState>,
    session_id: String,
    request: command_operations::Request,
) -> Result<Value> {
    let (_, cwd) = context(&state, &session_id)?;
    if matches!(request, command_operations::Request::Logout)
        && !state.agents.lock().map_err(|e| e.to_string())?.is_empty()
    {
        return Err("Stop running tasks before signing out.".into());
    }
    command_operations::execute(&cwd, request).await
}

#[tauri::command]
pub(super) async fn codex_jobs(
    state: State<'_, AppState>,
    session_id: String,
    stop_id: Option<String>,
) -> Result<Value> {
    context(&state, &session_id)?;
    if !state
        .agents
        .lock()
        .map_err(|e| e.to_string())?
        .contains_key(&session_id)
    {
        if stop_id.is_some() {
            return Err("This task has no running background commands.".into());
        }
        return Ok(
            json!({"kind":"jobs","jobs":[],"notes":["Background commands exist only while this task's agent process is running."]}),
        );
    }
    let response = live_request(
        &state,
        &session_id,
        "thread/backgroundTerminals/list",
        json!({"limit":100}),
    )
    .await?;
    let rows = response["data"]
        .as_array()
        .ok_or("Codex returned an invalid process list.")?;
    if let Some(id) = stop_id {
        if !rows
            .iter()
            .any(|row| row["processId"].as_str() == Some(&id))
        {
            return Err("That background command has already ended. Refresh the list.".into());
        }
        live_request(
            &state,
            &session_id,
            "thread/backgroundTerminals/terminate",
            json!({"processId":id}),
        )
        .await?;
        return Ok(
            json!({"kind":"result","title":"Command stopped","description":"The selected background command was stopped."}),
        );
    }
    let jobs:Vec<_>=rows.iter().take(100).filter_map(|row|Some(json!({"id":row["processId"].as_str()?,"title":row["command"].as_str().unwrap_or("Background command").chars().take(500).collect::<String>(),"status":"Running","canStop":true}))).collect();
    Ok(json!({"kind":"jobs","jobs":jobs}))
}

#[derive(serde::Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
pub(super) enum TaskPreference {
    Plan { enabled: bool },
    Fast { enabled: bool },
}
#[tauri::command]
pub(super) async fn set_task_preference(
    state: State<'_, AppState>,
    session_id: String,
    request: TaskPreference,
) -> Result<Session> {
    {
        let store = state.store.lock().map_err(|e| e.to_string())?;
        crate::architect::check_manual(&store, &session_id)?;
    }
    let gate = preference_gate(&session_id)?;
    let _preference = gate.lock().await;
    if state.shutdown.load(Ordering::SeqCst) != 0 {
        return Err("PandaCode is shutting down.".into());
    }
    if terminal::harness_running(&state.terminals, &session_id)? {
        return Err("Close this task's harness console before changing its settings here.".into());
    }
    let running = state
        .agents
        .lock()
        .map_err(|e| e.to_string())?
        .contains_key(&session_id);
    // An idle task is reserved through catalog discovery and persistence. Live
    // tasks already reject model changes and receive only the selected delta.
    let _lease = if running {
        None
    } else {
        Some(TaskLease::acquire(&state, &session_id)?)
    };
    let (task, cwd) = context(&state, &session_id)?;
    let delta = match request {
        TaskPreference::Plan { enabled } => {
            let model = command_operations::resolved_model(&cwd, &task.model).await?;
            json!({"collaborationMode":{"mode":if enabled {"plan"} else {"default"},"settings":{"model":model,"reasoning_effort":task.reasoning_effort,"developer_instructions":null}}})
        }
        TaskPreference::Fast { enabled } => {
            let tier = if enabled {
                json!(command_operations::fast_service_tier(&cwd, &task.model).await?)
            } else {
                Value::Null
            };
            json!({"serviceTier":tier})
        }
    };
    if running {
        live_request(&state, &session_id, "thread/settings/update", delta.clone()).await?;
    }
    let store = state.store.lock().map_err(|e| e.to_string())?;
    let current = store.session(&session_id)?;
    if current.provider != task.provider
        || current.model != task.model
        || current.reasoning_effort != task.reasoning_effort
    {
        return Err("The task's model changed. Open its settings again.".into());
    }
    let settings = merge_preference(current.codex_settings, &delta)?;
    store
        .db
        .execute(
            "UPDATE sessions SET codex_settings=?2 WHERE id=?1",
            rusqlite::params![session_id, settings.to_string()],
        )
        .map_err(|e| e.to_string())?;
    store.session(&session_id)
}

// Per-task gates serialize acknowledgements and writes without blocking other
// running agents or holding a native mutex across network work. Weak entries
// disappear on the next lookup once the last operation releases its guard.
fn preference_gate(sid: &str) -> Result<Arc<tokio::sync::Mutex<()>>> {
    type Gates = Mutex<HashMap<String, std::sync::Weak<tokio::sync::Mutex<()>>>>;
    static GATES: std::sync::OnceLock<Gates> = std::sync::OnceLock::new();
    let mut gates = GATES
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|_| "Preference controls are unavailable")?;
    gates.retain(|_, gate| gate.strong_count() > 0);
    if let Some(gate) = gates.get(sid).and_then(std::sync::Weak::upgrade) {
        return Ok(gate);
    }
    let gate = Arc::new(tokio::sync::Mutex::new(()));
    gates.insert(sid.into(), Arc::downgrade(&gate));
    Ok(gate)
}
fn merge_preference(current: Option<Value>, delta: &Value) -> Result<Value> {
    let mut settings = current.unwrap_or_else(|| json!({}));
    let target = settings
        .as_object_mut()
        .ok_or("The saved Codex settings are invalid.")?;
    let patch = delta.as_object().ok_or("Invalid Codex preference change")?;
    for (key, value) in patch {
        if !matches!(key.as_str(), "collaborationMode" | "serviceTier") {
            return Err("Unknown task preference.".into());
        }
        target.insert(key.clone(), value.clone());
    }
    Ok(settings)
}

// Reserve the task across a remote mutation without holding a mutex across await.
struct TaskLease {
    agents: Agents,
    sid: String,
    run_id: String,
}
impl TaskLease {
    fn acquire(state: &AppState, sid: &str) -> Result<Self> {
        let mut agents = state.agents.lock().map_err(|e| e.to_string())?;
        crate::agent_updates::ensure_not_installing()?;
        if state.shutdown.load(Ordering::SeqCst) != 0 {
            return Err("PandaCode is shutting down.".into());
        }
        if agents.contains_key(sid) || terminal::harness_running(&state.terminals, sid)? {
            return Err(
                "Stop this task and close its harness console before changing its conversation."
                    .into(),
            );
        }
        {
            let store = state.store.lock().map_err(|e| e.to_string())?;
            crate::architect::check_manual(&store, sid)?;
        }
        let (tx, _rx) = unbounded_channel();
        let agent = RunningAgent::new(tx, Arc::new(AtomicBool::new(false)));
        let lease = Self {
            agents: state.agents.clone(),
            sid: sid.into(),
            run_id: agent.run_id.clone(),
        };
        agents.insert(sid.into(), agent);
        Ok(lease)
    }
}
impl Drop for TaskLease {
    fn drop(&mut self) {
        if let Ok(mut agents) = self.agents.lock() {
            if agents
                .get(&self.sid)
                .is_some_and(|a| a.run_id == self.run_id)
            {
                agents.remove(&self.sid);
            }
        }
    }
}

#[tauri::command]
pub(super) async fn fork_session_at_message(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    message_id: i64,
    exclusive: Option<bool>,
) -> Result<Session> {
    let store = state.store.clone();
    let task = blocking(move || {
        let store = store.lock().map_err(|e| e.to_string())?;
        if exclusive == Some(true) {
            crate::conversation_fork::before_message(&store, &session_id, message_id)
        } else {
            crate::conversation_fork::at_message(&store, &session_id, message_id)
        }
    })
    .await?;
    let _ = app.emit("sessions-changed", ());
    Ok(task)
}

#[tauri::command]
pub(super) async fn get_message_content(
    state: State<'_, AppState>,
    session_id: String,
    message_id: i64,
) -> Result<String> {
    let store = state.store.clone();
    blocking(move || {
        let store = store.lock().map_err(|e| e.to_string())?;
        store.message_content(&session_id, message_id)
    })
    .await
}

#[tauri::command]
pub(super) async fn fork_codex_task(
    state: State<'_, AppState>,
    session_id: String,
    remote_id: Option<String>,
) -> Result<Session> {
    let _lease = TaskLease::acquire(&state, &session_id)?;
    let (source, cwd) = context(&state, &session_id)?;
    let adopting = remote_id.is_some();
    if !adopting {
        let store = state.store.lock().map_err(|e| e.to_string())?;
        if crate::context_recovery::pending(&store, &source)? {
            return Err(crate::context_recovery::RECOVERY_REQUIRED.into());
        }
    }
    let remote = remote_id
        .or(source.resume_id.clone())
        .ok_or("Start the conversation before forking it.")?;
    let fork = if adopting {
        command_operations::validate_conversation(&cwd, &remote).await?
    } else {
        command_operations::fork_thread(&cwd, &remote).await?
    };
    let history = if adopting {
        command_operations::conversation_messages(&cwd, &fork.id).await?
    } else {
        Vec::new()
    };
    let store = state.store.lock().map_err(|e| e.to_string())?;
    if adopting {
        if let Some(existing) = existing_codex_task(&store, &fork.id)? {
            return store.session(&existing);
        }
    }
    let current = store.session(&session_id)?;
    if current.project_id != source.project_id
        || current.worktree_path != source.worktree_path
        || current.provider != source.provider
    {
        return Err("The source task changed projects. Open its commands again.".into());
    }
    let tx = store
        .db
        .unchecked_transaction()
        .map_err(|e| e.to_string())?;
    let task = store.create_session(
        &source.project_id,
        "codex",
        fork.model.as_deref().unwrap_or(&source.model),
        &source.mode,
    )?;
    store.db.execute("UPDATE sessions SET resume_id=?2,worktree_path=?3,reasoning_effort=?4,title=?5,codex_settings=?6,task_stage='in_progress' WHERE id=?1",rusqlite::params![task.id,fork.id,source.worktree_path,fork.reasoning_effort.or(source.reasoning_effort),if adopting {"Resumed Codex task".into()}else{format!("{} (fork)",source.title).chars().take(200).collect::<String>()},source.codex_settings.map(|v|v.to_string())]).map_err(|e|e.to_string())?;
    for (role, content) in history {
        store.message(&task.id, &role, &content)?;
    }
    if !adopting {
        copy_task_messages(&store, &source.id, &task.id)?;
        crate::session_titles::inherit(&store, &source.id, &task.id)?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    store.session(&task.id)
}

/// A fork has no team provenance. Preserve recognized historical app turns as
/// typed records while their original team IDs and cutoff are still available.
pub(crate) fn copy_task_messages(store: &Store, source: &str, target: &str) -> Result<()> {
    if source == target {
        return Err("A task cannot be forked into itself.".into());
    }
    let mut query = store.db.prepare("SELECT id,role,content,created_at,turn_duration_ms FROM messages WHERE session_id=?1 ORDER BY id").map_err(|e|e.to_string())?;
    let messages = query
        .query_map([source], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, Option<i64>>(4)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    for message in messages {
        let (id, mut role, mut content, created_at, duration) =
            message.map_err(|e| e.to_string())?;
        if role == "user" {
            if let Some(kind) =
                crate::architect::internal_turns::legacy_kind(store, source, id, &content)?
            {
                content = crate::architect::internal_turns::encode(kind, &content)?;
                role = "coordination".into();
            }
        }
        store.db.execute("INSERT INTO messages(session_id,role,content,created_at,turn_duration_ms) VALUES(?1,?2,?3,?4,?5)",rusqlite::params![target,role,content,created_at,duration]).map_err(|e|e.to_string())?;
    }
    Ok(())
}

fn existing_codex_task(store: &Store, remote_id: &str) -> Result<Option<String>> {
    store.db.query_row("SELECT id FROM sessions WHERE provider='codex' AND resume_id=?1 ORDER BY updated_at DESC LIMIT 1",[remote_id],|row|row.get(0)).optional().map_err(|e|e.to_string())
}

#[tauri::command]
pub(super) async fn archive_codex_task(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<()> {
    let _lease = TaskLease::acquire(&state, &session_id)?;
    let (task, cwd) = context(&state, &session_id)?;
    if let Some(remote) = task.resume_id {
        command_operations::mutate_thread(
            &cwd,
            &remote,
            command_operations::ThreadMutation::Archive,
        )
        .await?;
    }
    state
        .store
        .lock()
        .map_err(|e| e.to_string())?
        .update(&session_id, None, Some(true), None, None)
}

#[tauri::command]
pub(super) async fn export_task(state: State<'_, AppState>, session_id: String) -> Result<String> {
    let store = state.store.lock().map_err(|e| e.to_string())?;
    let task = store.session(&session_id)?;
    let mut output = format!("# {}\n\n", task.title);
    let mut query = store
        .db
        .prepare("SELECT id,role,content FROM messages WHERE session_id=?1 ORDER BY id")
        .map_err(|e| e.to_string())?;
    let rows = query
        .query_map([&session_id], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (id, role, content) = row.map_err(|e| e.to_string())?;
        let (role, content, _) = crate::architect::internal_turns::project_text(
            &store,
            &session_id,
            id,
            &role,
            &content,
        )?;
        if output.len() + content.len() > 8 * 1024 * 1024 {
            return Err("This transcript exceeds the 8 MiB export limit.".into());
        }
        output.push_str(&format!("## {role}\n\n{content}\n\n"));
    }
    Ok(output)
}

#[tauri::command]
pub(super) async fn save_task_export(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<()> {
    let path = PathBuf::from(path);
    if !path.is_absolute()
        || !matches!(
            path.extension().and_then(|s| s.to_str()),
            Some("md" | "txt")
        )
    {
        return Err("Choose a Markdown or text file for the export.".into());
    }
    if std::fs::symlink_metadata(&path).is_ok_and(|m| !m.is_file() || m.file_type().is_symlink()) {
        return Err("Choose a regular file for the export.".into());
    }
    let text = export_task(state, session_id).await?;
    blocking(move || std::fs::write(path, text).map_err(|e| e.to_string())).await
}

pub(super) async fn rename_task(state: &AppState, sid: &str, title: &str) -> Result<()> {
    if title.trim().is_empty() || title.len() > 200 || title.chars().any(char::is_control) {
        return Err("Choose a task name of 1–200 characters.".into());
    }
    let _lease = TaskLease::acquire(state, sid)?;
    let (task, cwd) = context(state, sid)?;
    if let Some(remote) = task.resume_id {
        command_operations::mutate_thread(
            &cwd,
            &remote,
            command_operations::ThreadMutation::Rename(title.into()),
        )
        .await?;
    }
    state
        .store
        .lock()
        .map_err(|e| e.to_string())?
        .update(sid, Some(title.into()), None, None, None)
}

#[tauri::command]
pub(super) async fn start_harness_terminal(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<String> {
    let lease = TaskLease::acquire(&state, &session_id)?;
    let store = state.store.clone();
    let terms = state.terminals.clone();
    let (task, cwd) = {
        let db = store.lock().map_err(|error| error.to_string())?;
        let task = db.session(&session_id)?;
        if crate::context_recovery::pending(&db, &task)? {
            return Err(crate::context_recovery::RECOVERY_REQUIRED.into());
        }
        let cwd = db.workspace_root(&task.project_id, Some(&session_id))?;
        (task, cwd)
    };
    if task.provider == "codex" {
        if let Some(remote) = task.resume_id.as_deref() {
            // A native CLI can change the persisted goal while PandaCode is idle.
            // Read it without loading the thread: opening /vim must not restart
            // a goal whose active state was absent from the local UI cache.
            let goal = command_operations::read_goal(&cwd, remote).await?;
            let db = store.lock().map_err(|error| error.to_string())?;
            verify_console_task(&db, &task)?;
            db.record_goal(&session_id, goal.as_ref())?;
            ensure_console_goal_inactive(goal.as_ref())?;
        }
    }
    blocking(move || {
        let active = lease.agents.lock().map_err(|error| error.to_string())?;
        if app.state::<AppState>().shutdown.load(Ordering::SeqCst) != 0 {
            return Err("PandaCode is shutting down.".into());
        }
        if active
            .get(&session_id)
            .is_none_or(|agent| agent.run_id != lease.run_id)
            || terminal::harness_running(&terms, &session_id)?
        {
            return Err(
                "This task changed ownership while its console was opening. Try again.".into(),
            );
        }
        let current = {
            let db = store.lock().map_err(|error| error.to_string())?;
            verify_console_task(&db, &task)?
        };
        ensure_console_goal_inactive(current.goal_state.as_ref())?;
        // Keep the reservation until the terminal is in the registry. The new
        // console becomes its owner before the lease releases the agent slot.
        terminal::start_harness(
            app,
            terms,
            &cwd,
            terminal::HarnessContext {
                session_id: &session_id,
                provider: &current.provider,
                resume_id: current.resume_id.as_deref(),
                model: Some(&current.model),
                reasoning_effort: current.reasoning_effort.as_deref(),
                mode: &current.mode,
            },
            cols,
            rows,
        )
    })
    .await
}

fn verify_console_task(store: &Store, expected: &Session) -> Result<Session> {
    let current = store.session(&expected.id)?;
    if current.provider != expected.provider
        || current.resume_id != expected.resume_id
        || current.project_id != expected.project_id
        || current.worktree_path != expected.worktree_path
        || current.model != expected.model
        || current.mode != expected.mode
        || current.reasoning_effort != expected.reasoning_effort
    {
        return Err("This task changed while its console was opening. Try again.".into());
    }
    Ok(current)
}
fn ensure_console_goal_inactive(goal: Option<&GoalState>) -> Result<()> {
    if goal.is_some_and(|goal| goal.status == "active") {
        return Err("Pause the goal before opening its harness console.".into());
    }
    Ok(())
}

#[cfg(test)]
mod command_tests {
    use super::*;
    use std::path::Path;

    fn state() -> AppState {
        AppState {
            store: Arc::new(Mutex::new(Store::open(Path::new(":memory:")).unwrap())),
            agents: Arc::new(Mutex::new(HashMap::new())),
            terminals: Arc::new(Mutex::new(HashMap::new())),
            shutdown: AtomicU8::new(0),
        }
    }
    #[test]
    fn console_uses_refreshed_goal_and_rejects_changes_to_its_native_session() {
        let store = Store::open(Path::new(":memory:")).unwrap();
        let project = store.add_project(&std::env::temp_dir()).unwrap();
        let task = store
            .create_session(&project.id, "codex", "default", "ask")
            .unwrap();
        let remote = uuid::Uuid::new_v4().to_string();
        store.resume(&task.id, &remote).unwrap();
        let expected = store.session(&task.id).unwrap();
        let mut goal = GoalState {
            thread_id: remote,
            objective: "Finish work".into(),
            status: "paused".into(),
            token_budget: None,
            tokens_used: 1,
            time_used_seconds: 1,
            created_at: 1,
            updated_at: 2,
        };
        store.record_goal(&task.id, Some(&goal)).unwrap();
        assert!(
            ensure_console_goal_inactive(store.session(&task.id).unwrap().goal_state.as_ref())
                .is_ok()
        );
        goal.status = "active".into();
        verify_console_task(&store, &expected).unwrap();
        store.record_goal(&task.id, Some(&goal)).unwrap();
        assert!(
            ensure_console_goal_inactive(store.session(&task.id).unwrap().goal_state.as_ref())
                .is_err()
        );
        store.record_goal(&task.id, None).unwrap();
        assert!(
            ensure_console_goal_inactive(store.session(&task.id).unwrap().goal_state.as_ref())
                .is_ok()
        );
        store
            .resume(&task.id, &uuid::Uuid::new_v4().to_string())
            .unwrap();
        assert!(verify_console_task(&store, &expected).is_err());
    }
    #[test]
    fn independent_preference_changes_preserve_other_settings() {
        let saved = json!({"serviceTier":"fast","personality":"friendly"});
        let plan = json!({"collaborationMode":{"mode":"plan","settings":{"model":"actual-model"}}});
        let updated = merge_preference(Some(saved), &plan).unwrap();
        assert_eq!(updated["serviceTier"], "fast");
        assert_eq!(updated["personality"], "friendly");
        let updated = merge_preference(Some(updated), &json!({"serviceTier":null})).unwrap();
        assert_eq!(updated["collaborationMode"]["mode"], "plan");
        assert!(updated["serviceTier"].is_null());
        assert!(merge_preference(None, &json!({"approvalPolicy":"never"})).is_err());
    }
    #[test]
    fn imported_task_lookup_includes_history_outside_the_sidebar_limit() {
        let store = Store::open(Path::new(":memory:")).unwrap();
        let project = store.add_project(&std::env::temp_dir()).unwrap();
        let task = store
            .create_session(&project.id, "codex", "default", "ask")
            .unwrap();
        store.db.execute("UPDATE sessions SET resume_id='remote-existing',created_at=0,updated_at=0,archived=1 WHERE id=?1",[&task.id]).unwrap();
        for _ in 0..501 {
            store
                .create_session(&project.id, "codex", "default", "ask")
                .unwrap();
        }
        assert!(!store
            .sessions()
            .unwrap()
            .iter()
            .any(|entry| entry.id == task.id));
        assert_eq!(
            existing_codex_task(&store, "remote-existing").unwrap(),
            Some(task.id)
        );
    }
    #[tokio::test]
    async fn preference_serialization_is_per_task_and_releases_on_cancellation() {
        let sid = uuid::Uuid::new_v4().to_string();
        let first = preference_gate(&sid).unwrap();
        let same = preference_gate(&sid).unwrap();
        let other = preference_gate("other-task").unwrap();
        assert!(Arc::ptr_eq(&first, &same));
        let held = first.lock().await;
        assert!(same.try_lock().is_err());
        assert!(other.try_lock().is_ok());
        drop(held);
        assert!(same.try_lock().is_ok());
    }
    #[test]
    fn task_lease_preserves_other_owners_and_rejects_shutdown() {
        let state = state();
        let lease = TaskLease::acquire(&state, "one").unwrap();
        assert!(TaskLease::acquire(&state, "one").is_err());
        let (tx, _rx) = unbounded_channel();
        let replacement = RunningAgent::new(tx, Arc::new(AtomicBool::new(false)));
        let replacement_id = replacement.run_id.clone();
        state
            .agents
            .lock()
            .unwrap()
            .insert("one".into(), replacement);
        drop(lease);
        assert_eq!(state.agents.lock().unwrap()["one"].run_id, replacement_id);
        state.shutdown.store(1, Ordering::SeqCst);
        assert!(TaskLease::acquire(&state, "two").is_err());
        assert!(!state.agents.lock().unwrap().contains_key("two"));
    }
}
