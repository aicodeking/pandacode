mod agent_tools;
mod agent_usage;
mod agent_updates;
mod agent_usage_providers;
mod appearance;
mod architect;
mod bots;
mod chats;
mod browser;
mod child_env;
mod checks;
mod code_search;
mod connections;
mod command_operations;
mod context_recovery;
mod conversation_fork;
mod conversation_import;
mod design;
mod file_preview;
mod run_script;
mod github;
mod github_pull;
mod github_hub;
mod project_icon;
mod simulator;
mod vm;
mod secret_store;
mod cloud;
mod cloud_agents;
mod capabilities;
mod vsix_themes;
mod token_saver;
mod skills;
mod goal_state;
#[cfg(test)]
mod goal_workflow_tests;
mod integrations;
mod jev;
mod jev_decisions;
mod local_servers;
mod local_signing;
mod message_queue;
mod moodboards;
mod prompt_attachments;
mod overlay;
mod provider_settings;
mod remote;
mod providers;
mod session_titles;
mod slash_commands;
mod recipes;
mod storage;
mod subagent_state;
mod support;
mod task_controls;
mod task_deletion;
mod terminal;
mod terminal_preferences;
mod turn_changes;
mod usage_keychain;
mod usage_ledger;
mod workspace;
mod jj;
mod tray;

pub use usage_keychain::handle_usage_keychain_helper;
pub use cloud_agents::handle_cloud_bridge;

use providers::{AgentEvent, RunConfig, RunInput};
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU8, Ordering},
        Arc, Mutex,
    },
};
use storage::{ContextUsage, MessagePage, Project, Session, Store};
use tauri::{Emitter, Manager, State};
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};

type Result<T> = std::result::Result<T, String>;
struct RunningAgent {
    input: UnboundedSender<RunInput>,
    stopped: Arc<AtomicBool>,
    run_id: String,
    approvals: Arc<Mutex<HashSet<String>>>,
    subagents: Arc<Mutex<subagent_state::SubagentState>>,
    assistant: Arc<Mutex<String>>,
    /// When the harness last sent anything; team watchdogs stop a turn that went silent.
    last_event: Arc<std::sync::atomic::AtomicI64>,
}
impl RunningAgent {
    fn new(input: UnboundedSender<RunInput>, stopped: Arc<AtomicBool>) -> Self {
        Self {
            input,
            stopped,
            run_id: uuid::Uuid::new_v4().to_string(),
            approvals: Arc::new(Mutex::new(HashSet::new())),
            subagents: Arc::new(Mutex::new(subagent_state::SubagentState::default())),
            assistant: Arc::new(Mutex::new(String::new())),
            last_event: Arc::new(std::sync::atomic::AtomicI64::new(storage::now())),
        }
    }

    pub(crate) fn silent_for(&self, now: i64) -> i64 {
        now.saturating_sub(self.last_event.load(Ordering::SeqCst))
    }

    pub(crate) fn has_pending_approvals(&self) -> bool {
        self.approvals.lock().map_or(true, |approvals| !approvals.is_empty())
    }

    fn respond_approval(
        &self,
        store: &Mutex<Store>,
        session_id: &str,
        request_id: String,
        approved: bool,
    ) -> Result<()> {
        // Lock order is registry (caller) -> approvals -> store. A new request
        // cannot become waiting between deciding the status and persisting it.
        let mut approvals = self.approvals.lock().map_err(|error| error.to_string())?;
        if self.stopped.load(Ordering::SeqCst) || !approvals.contains(&request_id) {
            return Err("This approval is no longer pending.".into());
        }
        let original_id = request_id
            .strip_prefix(&format!("{}:", self.run_id))
            .ok_or("This approval belongs to an earlier run.")?
            .to_string();
        let store = store.lock().map_err(|error| error.to_string())?;
        self.send(RunInput::Approval {
            request_id: original_id,
            approved,
        })
        .map_err(|_| "Agent has stopped.".to_string())?;
        approvals.remove(&request_id);
        store.status(
            session_id,
            if approvals.is_empty() {
                "running"
            } else {
                "waiting"
            },
        )
    }

    fn send(
        &self,
        input: RunInput,
    ) -> std::result::Result<(), tokio::sync::mpsc::error::SendError<RunInput>> {
        if matches!(input, RunInput::Stop) {
            self.stopped.store(true, Ordering::SeqCst);
        } else {
            // An answered approval or question restarts the silence clock.
            self.last_event.store(storage::now(), Ordering::SeqCst);
        }
        self.input.send(input)
    }
}
type Agents = Arc<Mutex<HashMap<String, RunningAgent>>>;

fn save_approval(
    store: &Mutex<Store>,
    approvals: &Mutex<HashSet<String>>,
    run_id: &str,
    activity: &mut AgentEvent,
) -> Result<()> {
    let request_id = activity
        .request_id
        .as_ref()
        .ok_or("Approval request ID is missing.")?;
    let request_id = format!("{run_id}:{request_id}");
    activity.request_id = Some(request_id.clone());
    let mut approvals = approvals.lock().map_err(|error| error.to_string())?;
    if matches!(activity.kind.as_str(), "approval" | "input_request") {
        approvals.insert(request_id);
    } else {
        approvals.remove(&request_id);
    }
    store.lock().map_err(|error| error.to_string())?.status(
        &activity.session_id,
        if approvals.is_empty() {
            "running"
        } else {
            "waiting"
        },
    )
}

#[cfg(test)]
mod concurrent_task_tests;

/// A provider can finish while the database is temporarily unable to write its
/// final status. The process registry remains authoritative for whether work is
/// actually running; retry persistence when that task is next read or started.
fn reconcile_inactive_task(
    store: &Store,
    agents: &HashMap<String, RunningAgent>,
    mut task: Session,
) -> Session {
    // Team coordination continues while the architect process is between review rounds.
    // The raw row remains idle for internal admission; the UI sees logical activity.
    if architect::load(store, &task.id)
        .ok()
        .flatten()
        .is_some_and(|team| matches!(team.status.as_str(), "running" | "waiting"))
    {
        if !agents.contains_key(&task.id) {
            task.status = "waiting".into();
        }
        task.task_stage = "in_progress".into();
        return task;
    }
    // A mirror runs on its host; its events keep the status. A cloud run keeps going on its
    // machine until `cloud_agents::resume` re-attaches and finishes it.
    if matches!(task.status.as_str(), "running" | "waiting") && !agents.contains_key(&task.id) && task.remote_device.is_none()
        && !cloud_agents::load(store, &task.id).ok().flatten().is_some_and(|cloud| cloud.active()) {
        if let Err(error) = store.finish_task_turn(&task.id, false, true) {
            eprintln!("Could not persist interrupted task state: {error}");
        }
        if let Err(error) = store.finish_subagents(&task.id, "stopped") {
            eprintln!("Could not persist interrupted subagent state: {error}");
        }
        task.status = "interrupted".into();
        task.task_stage = "in_progress".into();
        task.completed_at = None;
    }
    task
}

#[cfg(test)]
mod task_agent_tests {
    use super::*;

    #[test]
    fn assistant_boundaries_preserve_separate_commentary_and_final_rows_without_tools() {
        let store = Store::open(std::path::Path::new(":memory:")).unwrap();
        let project = store.add_project(&std::env::temp_dir()).unwrap();
        let task = store
            .create_session(&project.id, "codex", "default", "ask")
            .unwrap();
        store.begin_task_turn(&task.id, "Build a game").unwrap();
        let assistant = Mutex::new(String::new());
        let mut boundary = event(&task.id, "message_start", "");
        boundary.data = Some(serde_json::json!({"messageId": "commentary", "phase": "commentary"}));
        save_agent_activity(&store, &assistant, &mut boundary, None).unwrap();
        assistant.lock().unwrap().push_str("I’ll build it ");
        assistant.lock().unwrap().push_str("with a timer.");
        // Deltas stay in memory until a real message boundary; the first
        // response is durable before the final response begins streaming.
        assert_eq!(store.messages(&task.id, None).unwrap().len(), 1);
        boundary.data = Some(serde_json::json!({"messageId": "final", "phase": "final_answer"}));
        save_agent_activity(&store, &assistant, &mut boundary, None).unwrap();
        assert_eq!(
            store.messages(&task.id, None).unwrap()[1].content,
            "I’ll build it with a timer."
        );
        assistant.lock().unwrap().push_str("The game is ready.");
        flush_assistant(&store, &task.id, &assistant).unwrap();
        flush_assistant(&store, &task.id, &assistant).unwrap();
        let messages = store.messages(&task.id, None).unwrap();
        assert_eq!(
            messages
                .iter()
                .map(|message| message.role.as_str())
                .collect::<Vec<_>>(),
            ["user", "assistant", "assistant"]
        );
        assert_eq!(messages[2].content, "The game is ready.");
        assert!(messages[1].id < messages[2].id);
    }

    #[test]
    fn boundaries_after_tools_do_not_add_empty_or_duplicate_assistant_rows() {
        let store = Store::open(std::path::Path::new(":memory:")).unwrap();
        let project = store.add_project(&std::env::temp_dir()).unwrap();
        let task = store
            .create_session(&project.id, "claude", "sonnet", "ask")
            .unwrap();
        let assistant = Mutex::new("Checking the project.".to_string());
        let mut tool = event(&task.id, "tool", "Read");
        tool.tool = Some(providers::ToolActivity {
            id: "run:read".into(),
            name: "Read".into(),
            status: "completed".into(),
            input: "README.md".into(),
            output: "Project details".into(),
            write_paths: None,
        });
        save_agent_activity(&store, &assistant, &mut tool, None).unwrap();
        let mut boundary = event(&task.id, "message_start", "");
        save_agent_activity(&store, &assistant, &mut boundary, None).unwrap();
        save_agent_activity(&store, &assistant, &mut boundary, None).unwrap();
        assistant
            .lock()
            .unwrap()
            .push_str("This is a game project.");
        flush_assistant(&store, &task.id, &assistant).unwrap();
        let messages = store.messages(&task.id, None).unwrap();
        assert_eq!(
            messages
                .iter()
                .map(|message| message.role.as_str())
                .collect::<Vec<_>>(),
            ["assistant", "tool", "assistant"]
        );
        assert_eq!(messages[0].content, "Checking the project.");
        assert_eq!(messages[2].content, "This is a game project.");
    }

    #[test]
    fn failed_boundary_write_keeps_response_buffer_until_a_successful_retry() {
        let store = Store::open(std::path::Path::new(":memory:")).unwrap();
        let project = store.add_project(&std::env::temp_dir()).unwrap();
        let task = store
            .create_session(&project.id, "codex", "default", "ask")
            .unwrap();
        let assistant = Mutex::new("Preserve this response.".to_string());
        store.db.execute_batch("CREATE TRIGGER reject_response BEFORE INSERT ON messages WHEN NEW.role='assistant' BEGIN SELECT RAISE(ABORT,'injected storage failure'); END;").unwrap();
        let mut boundary = event(&task.id, "message_start", "");
        assert!(save_agent_activity(&store, &assistant, &mut boundary, None).is_err());
        assert_eq!(*assistant.lock().unwrap(), "Preserve this response.");
        assert!(store.messages(&task.id, None).unwrap().is_empty());
        store
            .db
            .execute_batch("DROP TRIGGER reject_response;")
            .unwrap();
        save_agent_activity(&store, &assistant, &mut boundary, None).unwrap();
        assert!(assistant.lock().unwrap().is_empty());
        flush_assistant(&store, &task.id, &assistant).unwrap();
        assert_eq!(store.messages(&task.id, None).unwrap().len(), 1);
    }

    #[test]
    fn late_tool_updates_do_not_split_an_assistant_response_that_is_still_streaming() {
        let store = Store::open(std::path::Path::new(":memory:")).unwrap();
        let project = store.add_project(&std::env::temp_dir()).unwrap();
        let task = store
            .create_session(&project.id, "codex", "default", "ask")
            .unwrap();
        let assistant = Mutex::new("I’ll inspect the files.".to_string());
        let mut tool = event(&task.id, "tool", "Read");
        tool.tool = Some(providers::ToolActivity {
            id: "run:read".into(),
            name: "Read".into(),
            status: "running".into(),
            input: "README.md".into(),
            output: String::new(),
            write_paths: None,
        });
        save_agent_activity(&store, &assistant, &mut tool, None).unwrap();
        let mut boundary = event(&task.id, "message_start", "");
        save_agent_activity(&store, &assistant, &mut boundary, None).unwrap();
        assistant.lock().unwrap().push_str("The project has ");
        tool.tool.as_mut().unwrap().output = "Partial file content".into();
        save_agent_activity(&store, &assistant, &mut tool, None).unwrap();
        assistant.lock().unwrap().push_str("a simple structure ");
        tool.tool.as_mut().unwrap().status = "completed".into();
        tool.tool.as_mut().unwrap().output = "Complete file content".into();
        save_agent_activity(&store, &assistant, &mut tool, None).unwrap();
        assert_eq!(store.messages(&task.id, None).unwrap().len(), 2);
        assistant.lock().unwrap().push_str("and is ready to build.");
        flush_assistant(&store, &task.id, &assistant).unwrap();
        let messages = store.messages(&task.id, None).unwrap();
        assert_eq!(
            messages
                .iter()
                .map(|message| message.role.as_str())
                .collect::<Vec<_>>(),
            ["assistant", "tool", "assistant"]
        );
        assert_eq!(
            messages[2].content,
            "The project has a simple structure and is ready to build."
        );
        assert!(messages[1].content.contains("Complete file content"));
    }

    #[test]
    fn stop_is_recorded_even_when_provider_returns_success_or_has_closed_its_input() {
        let (input, mut receiver) = unbounded_channel();
        let stopped = Arc::new(AtomicBool::new(false));
        let agent = RunningAgent::new(input, stopped.clone());
        agent
            .send(RunInput::Approval {
                request_id: "test".into(),
                approved: true,
            })
            .unwrap();
        assert!(!stopped.load(Ordering::SeqCst));
        assert!(receiver.try_recv().is_ok());
        agent.send(RunInput::Stop).unwrap();
        assert!(stopped.load(Ordering::SeqCst));
        stopped.store(false, Ordering::SeqCst);
        drop(receiver);
        assert!(agent.send(RunInput::Stop).is_err());
        assert!(stopped.load(Ordering::SeqCst));
    }

    #[test]
    fn stale_running_status_recovers_after_completion_write_failure_without_hiding_live_runs() {
        let store = Store::open(std::path::Path::new(":memory:")).unwrap();
        let project = store.add_project(&std::env::temp_dir()).unwrap();
        let task = store
            .create_session(&project.id, "claude", "sonnet", "ask")
            .unwrap();
        store.begin_task_turn(&task.id, "Build a game").unwrap();
        let (input, _receiver) = unbounded_channel();
        let mut agents = HashMap::new();
        agents.insert(
            task.id.clone(),
            RunningAgent::new(input, Arc::new(AtomicBool::new(false))),
        );
        let live = reconcile_inactive_task(&store, &agents, store.session(&task.id).unwrap());
        assert_eq!(live.status, "running");
        store.db.execute_batch("CREATE TRIGGER reject_completion BEFORE UPDATE ON sessions BEGIN SELECT RAISE(ABORT,'injected storage failure'); END;").unwrap();
        assert!(store.finish_task_turn(&task.id, true, false).is_err());
        agents.clear();
        let visible = reconcile_inactive_task(&store, &agents, store.session(&task.id).unwrap());
        assert_eq!(visible.status, "interrupted");
        assert_eq!(visible.task_stage, "in_progress");
        assert_eq!(store.session(&task.id).unwrap().status, "running");
        store
            .db
            .execute_batch("DROP TRIGGER reject_completion;")
            .unwrap();
        let recovered = reconcile_inactive_task(&store, &agents, store.session(&task.id).unwrap());
        assert_eq!(recovered.status, "interrupted");
        assert_eq!(store.session(&task.id).unwrap().status, "interrupted");
        store.begin_task_turn(&task.id, "Retry").unwrap();
        assert_eq!(store.session(&task.id).unwrap().status, "running");
    }
}
struct AppState {
    store: Arc<Mutex<Store>>,
    agents: Agents,
    terminals: terminal::Terminals,
    shutdown: AtomicU8,
}
impl AppState {
    fn root(&self, project_id: &str, session_id: Option<&str>) -> Result<PathBuf> {
        self.store
            .lock()
            .map_err(|e| e.to_string())?
            .workspace_root(project_id, session_id)
    }
}
/// Fixed instructions for every task turn: sidebar titles, the run script, change tracking.
/// Projectless chats have nothing to run, so they skip the run script.
fn app_instructions(chat: bool) -> String {
    let run = if chat { "" } else { run_script::INSTRUCTIONS };
    [session_titles::GUIDANCE, run, turn_changes::instruction(), TURN_ENDS, RICH_QUESTIONS, GENERATIVE_UI].concat()
}

/// PandaCode closes the harness when a turn ends, so background waits never come back.
const TURN_ENDS: &str = "\n\nYour turn ends when you reply, and PandaCode then closes this session's process: background commands, monitors and scheduled wakeups started in this turn never report back. Wait for long-running commands in the foreground (or poll them) before you reply.";

/// Questions to the user render rich Markdown in PandaCode; agents only use it if told.
const RICH_QUESTIONS: &str = "\n\nQuestions you ask through the request_user_input tool, where available, render Markdown in PandaCode: use links, images by workspace path (![alt](relative/path.png)), ```chart blocks with JSON {\"type\":\"bar\"|\"line\"|\"pie\",\"title\",\"labels\":[…],\"series\":[{\"name\",\"values\":[…]}]}, ```svg drawings, or static ```html views when a visual helps the user decide. Remote images show as links; scripts never run.";

/// Replies may carry generative UI blocks that PandaCode draws in the thread.
const GENERATIVE_UI: &str = "\n\nGenerative UI: when a visual beats prose, a reply may include a ```ui block holding JSON {\"type\":…}; ```chart, ```svg and ```html work too. Types (fields): callout(tone info|success|warning|danger|note,title,body), card(title,body,footer,actions,children), stats(items[{label,value,delta,hint,spark[]}]), table(title,columns[],rows[[…]]), chart(chart bar|line|pie|area|sparkline,title,labels,series[{name,values}]), progress(label,value,max), plan|steps|timeline(title,summary,items[{title,detail,status done|active|pending|error|skipped,time}],actions), checklist(items[{text,done}]), tabs|accordion(items[{label,body,children}]), tree(paths[] or items[{name,status,children}]), diff(file,diff), code(file,language,code), terminal(command,output,exitCode), compare(items[{title,pros,cons,verdict}]), gallery(images[{path,caption}]), actions(buttons[{label,prompt,tone}]), chips|followups(options[{label,prompt}]), or inline :codex-followup[Label]{prompt=\"…\"}, form(title,fields[{name,label,type text|textarea|number|select|checkbox,options}],submit,prompt with {name}), stack|grid(columns,children), custom(html,css,state; data-ui-toggle=\"#id\", data-ui-tab/data-ui-panel, data-ui-set=\"k=v\", data-ui-bind=\"k\", data-ui-prompt). Bodies are Markdown. Buttons and forms only put a prompt in the user's composer; nothing runs, and remote URLs are not loaded. ```mermaid shows as labelled source. For a page that needs scripts, write an HTML file and open it with pandacode_preview_file.";

/// Harnesses without a system prompt hear the app instructions again every few turns.
const INSTRUCTION_REMINDER_EVERY: i64 = 8;
fn reminder_turn(turns: i64) -> bool {
    turns > 0 && turns % INSTRUCTION_REMINDER_EVERY == 1
}

#[cfg(test)]
mod instruction_tests {
    use super::*;

    #[test]
    fn harnesses_without_a_system_prompt_are_reminded_every_eighth_turn() {
        let reminded: Vec<i64> = (1..=20).filter(|turn| reminder_turn(*turn)).collect();
        assert_eq!(reminded, [1, 9, 17]);
        assert!(!reminder_turn(0));
        let text = app_instructions(false);
        for part in ["Sidebar titles:", "Run and preview workflow:", "File change tracking:", "Questions you ask through the request_user_input tool", "Your turn ends when you reply", "Generative UI:"] {
            assert!(text.contains(part), "{part}");
        }
        let chat = app_instructions(true);
        assert!(!chat.contains("Run and preview workflow:") && chat.contains("Sidebar titles:"));
    }
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn list_projects(state: State<'_, AppState>) -> Result<Vec<Project>> {
    state.store.lock().map_err(|e| e.to_string())?.projects()
}
#[tauri::command]
async fn add_project(state: State<'_, AppState>, path: String) -> Result<Project> {
    state
        .store
        .lock()
        .map_err(|e| e.to_string())?
        .add_project(&PathBuf::from(path))
}
#[tauri::command]
async fn remove_project(state: State<'_, AppState>, project_id: String) -> Result<()> {
    let agents = state.agents.lock().map_err(|e| e.to_string())?;
    let store = state.store.lock().map_err(|e| e.to_string())?;
    for session_id in agents.keys() {
        if store.session(session_id)?.project_id == project_id {
            return Err("Stop this project's agents first.".into());
        }
    }
    let active_team:bool=store.db.query_row("SELECT EXISTS(SELECT 1 FROM architect_teams t JOIN sessions s ON s.id=t.session_id WHERE s.project_id=?1 AND json_extract(t.content,'$.status') IN ('running','waiting'))",[&project_id],|r|r.get(0)).map_err(|e|e.to_string())?;
    if active_team {
        return Err("Stop this project's architect teams first.".into());
    }
    store.remove_project(&project_id)
}
#[tauri::command]
async fn list_sessions(state: State<'_, AppState>) -> Result<Vec<Session>> {
    listed_sessions(&state)
}
/// Tasks as the sidebar shows them, with stale running states settled.
pub(crate) fn listed_sessions(state: &AppState) -> Result<Vec<Session>> {
    let agents = state.agents.lock().map_err(|e| e.to_string())?;
    let store = state.store.lock().map_err(|e| e.to_string())?;
    Ok(store
        .sessions()?
        .into_iter()
        .map(|task| reconcile_inactive_task(&store, &agents, task))
        .collect())
}
#[tauri::command]
async fn set_resume_at_reset(state: State<'_, AppState>, session_id: String, enabled: bool) -> Result<Session> {
    state.store.lock().map_err(|e| e.to_string())?.set_resume_at_reset(&session_id, enabled)
}
#[tauri::command]
async fn clear_usage_limit(state: State<'_, AppState>, session_id: String) -> Result<()> {
    state.store.lock().map_err(|e| e.to_string())?.clear_limited(&session_id)
}
#[tauri::command]
async fn prompt_activity(state: State<'_, AppState>) -> Result<Vec<(i64, String, u64)>> {
    let since = storage::now() - 366 * 86_400_000;
    state.store.lock().map_err(|e| e.to_string())?.prompt_activity(since)
}
#[tauri::command]
async fn pin_session(app: tauri::AppHandle, state: State<'_, AppState>, session_id: String, pinned: bool) -> Result<Session> {
    let task = state.store.lock().map_err(|e| e.to_string())?.pin_session(&session_id, pinned)?;
    let _ = app.emit("sessions-changed", ());
    Ok(task)
}
#[tauri::command]
async fn reorder_sessions(app: tauri::AppHandle, state: State<'_, AppState>, session_ids: Vec<String>) -> Result<Vec<Session>> {
    let store = state.store.clone();
    let tasks = blocking(move || store.lock().map_err(|e| e.to_string())?.reorder_sessions(&session_ids)).await?;
    let _ = app.emit("sessions-changed", ());
    Ok(tasks)
}
#[tauri::command]
async fn get_task(state: State<'_, AppState>, session_id: String) -> Result<Session> {
    let agents = state.agents.lock().map_err(|e| e.to_string())?;
    let store = state.store.lock().map_err(|e| e.to_string())?;
    Ok(reconcile_inactive_task(
        &store,
        &agents,
        store.session(&session_id)?,
    ))
}
#[tauri::command]
async fn configure_window_appearance(
    window: tauri::Webview,
    reduced_transparency: bool,
    increased_contrast: bool,
    dark_mode: Option<bool>,
) -> Result<appearance::Appearance> {
    appearance::configure(
        window,
        reduced_transparency,
        increased_contrast,
        dark_mode.unwrap_or(true),
    )
    .await
}
#[tauri::command]
async fn create_session(
    state: State<'_, AppState>,
    project_id: String,
    provider: String,
    model: String,
    mode: Option<String>,
    draft: Option<bool>,
) -> Result<Session> {
    let store = state.store.lock().map_err(|e| e.to_string())?;
    let task = architect::profiles::create_user_task(
        &store,
        &project_id,
        &provider,
        &model,
        mode.as_deref(),
        None,
    )?;
    if draft.unwrap_or(false) {
        store.mark_draft(&task.id)
    } else {
        Ok(task)
    }
}
/// Deletes a New task draft that was left before its first prompt. A task
/// that has since saved a prompt, or never was a draft, is left untouched.
#[tauri::command]
async fn discard_draft(app: tauri::AppHandle, window: tauri::WebviewWindow, session_id: String) -> Result<bool> {
    if window.label() != "main" {
        return Err("Only the main window can discard new tasks.".into());
    }
    blocking(move || {
        let state = app.state::<AppState>();
        if !state.store.lock().map_err(|e| e.to_string())?.is_empty_draft(&session_id)? {
            return Ok(false);
        }
        task_deletion::delete_state(&state, &session_id)?;
        Ok(true)
    })
    .await
}
#[tauri::command]
async fn create_board_task(
    state: State<'_, AppState>,
    project_id: String,
    provider: String,
    model: String,
    mode: Option<String>,
    title: String,
    description: String,
) -> Result<Session> {
    let store = state.store.lock().map_err(|e| e.to_string())?;
    architect::profiles::create_user_task(
        &store,
        &project_id,
        &provider,
        &model,
        mode.as_deref(),
        Some((&title, &description)),
    )
}
#[tauri::command]
async fn update_task_details(
    state: State<'_, AppState>,
    session_id: String,
    title: String,
    description: String,
) -> Result<Session> {
    let agents = state.agents.lock().map_err(|e| e.to_string())?;
    if agents.contains_key(&session_id) {
        return Err("Stop the agent before editing its task details.".into());
    }
    state
        .store
        .lock()
        .map_err(|e| e.to_string())?
        .update_task_details(&session_id, &title, &description)
}
#[tauri::command]
async fn set_task_stage(
    state: State<'_, AppState>,
    session_id: String,
    stage: String,
) -> Result<Session> {
    let agents = state.agents.lock().map_err(|e| e.to_string())?;
    if agents.contains_key(&session_id) {
        return Err("Stop the agent before changing its task stage.".into());
    }
    state
        .store
        .lock()
        .map_err(|e| e.to_string())?
        .set_task_stage(&session_id, &stage)
}
#[tauri::command]
async fn configure_session(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    provider: String,
    model: String,
    project_id: Option<String>,
) -> Result<Session> {
    if project_id.is_none() {
        remote::catalog::check_mirror(&app, &state, &session_id, &provider, &model)?;
        remote::route(&app, &state, &session_id, "task.configure", serde_json::json!({"provider": provider, "model": model})).await?;
    }
    let agents = state.agents.lock().map_err(|e| e.to_string())?;
    if agents.contains_key(&session_id) {
        return Err("Stop the agent before changing its project, provider, or model.".into());
    }
    state.store.lock().map_err(|e| e.to_string())?.configure(
        &session_id,
        &provider,
        &model,
        project_id.as_deref(),
    )
}
#[tauri::command]
async fn set_reasoning_effort(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    reasoning_effort: Option<String>,
) -> Result<Session> {
    remote::route(&app, &state, &session_id, "task.configure", serde_json::json!({"effort": reasoning_effort})).await?;
    // Match send/configure's lock order so a send cannot capture the old
    // configuration halfway through a settings change.
    let agents = state.agents.lock().map_err(|e| e.to_string())?;
    if agents.contains_key(&session_id) {
        return Err("Stop the agent before changing its reasoning effort.".into());
    }
    state
        .store
        .lock()
        .map_err(|e| e.to_string())?
        .set_reasoning_effort(&session_id, reasoning_effort.as_deref())
}
#[tauri::command]
async fn update_session(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    title: Option<String>,
    archived: Option<bool>,
    model: Option<String>,
    mode: Option<String>,
) -> Result<()> {
    // A mirror's permissions are its host's; the local row follows below.
    if let Some(mode) = &mode {
        remote::route(&app, &state, &session_id, "task.configure", serde_json::json!({"mode": mode})).await?;
    }
    if let Some(title) = title
        .as_deref()
        .filter(|_| model.is_none() && mode.is_none() && archived.is_none())
    {
        let task = state
            .store
            .lock()
            .map_err(|e| e.to_string())?
            .session(&session_id)?;
        if task.provider == "codex" {
            return task_controls::rename_task(&state, &session_id, title).await;
        }
    }
    let agents = state.agents.lock().map_err(|e| e.to_string())?;
    if (model.is_some() || mode.is_some()) && agents.contains_key(&session_id) {
        return Err("Stop the agent before changing its model or permissions.".into());
    }
    state
        .store
        .lock()
        .map_err(|e| e.to_string())?
        .update(&session_id, title, archived, model, mode)
}
#[tauri::command]
async fn get_messages(
    state: State<'_, AppState>,
    session_id: String,
    before_id: Option<i64>,
) -> Result<MessagePage> {
    state
        .store
        .lock()
        .map_err(|e| e.to_string())?
        .message_page(&session_id, before_id)
}

#[tauri::command]
async fn list_subagents(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<providers::SubagentActivity>> {
    task_subagents(&state, &session_id)
}

fn task_subagents(state: &AppState, session_id: &str) -> Result<Vec<providers::SubagentActivity>> {
    // Registry -> subagent snapshots -> store matches completion. Holding the
    // live snapshot lock through the read prevents stale disk data winning a
    // race with an in-memory text update or with the final completion flush.
    let agents = state.agents.lock().map_err(|error| error.to_string())?;
    let live = agents
        .get(session_id)
        .map(|agent| agent.subagents.lock())
        .transpose()
        .map_err(|error| error.to_string())?;
    let store = state.store.lock().map_err(|error| error.to_string())?;
    if live.is_none() {
        // Retry a completion write that may have failed without reviving old
        // children just because their final snapshot could not reach disk.
        let task = store.session(session_id)?;
        store.finish_subagents(
            session_id,
            if task.status == "error" {
                "failed"
            } else {
                "stopped"
            },
        )?;
    }
    let history = store.subagents(session_id)?;
    Ok(match live {
        Some(live) => live.merge_history(history),
        None => history,
    })
}

// Boundary callbacks are synchronous; move their bounded filesystem work off Tokio's
// cooperative core so unrelated task streams and Stop continue to be serviced.
fn blocking_snapshot<T>(work: impl FnOnce() -> T) -> T {
    if tokio::runtime::Handle::try_current()
        .is_ok_and(|handle| handle.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread)
    {
        tokio::task::block_in_place(work)
    } else {
        work()
    }
}
fn persist_turn_changes(
    app: &tauri::AppHandle,
    store: &Mutex<Store>,
    sid: &str,
    capture: turn_changes::Captured,
) {
    let change_id = capture.summary.id.clone();
    match store
        .lock()
        .map_err(|e| e.to_string())
        .and_then(|store| {
            let message_id = turn_changes::persist(&store, sid, capture)?;
            Ok((message_id, turn_changes::summary(&store, sid, &change_id)?))
        })
    {
        Ok((message_id, summary)) => {
            let mut e = event(sid, "turn_changes", "");
            e.data = Some(serde_json::json!({"messageId":message_id,"turnChanges":summary}));
            let _ = app.emit("agent-event", e);
        }
        Err(error) => {
            let _ = app.emit(
                "agent-event",
                event(
                    sid,
                    "status",
                    &format!("Changes could not be saved: {error}"),
                ),
            );
        }
    }
}

fn event(sid: &str, kind: &str, text: &str) -> AgentEvent {
    AgentEvent {
        session_id: sid.into(),
        kind: kind.into(),
        text: text.into(),
        request_id: None,
        data: None,
        tool: None,
    }
}
#[derive(Serialize)]
struct StoredToolActivity<'a> {
    #[serde(rename = "type")]
    record_type: &'static str,
    version: u8,
    #[serde(flatten)]
    tool: &'a providers::ToolActivity,
}
fn run_tool_id(run_id: &str, native_turn_id: &str, tool_id: &str) -> String {
    if native_turn_id.is_empty() {
        return format!("{run_id}:{tool_id}");
    }
    // Native IDs are opaque. A short per-turn digest keeps the persistent key
    // bounded while separating call IDs reused by automatic goal turns.
    let mut hash = std::hash::DefaultHasher::new();
    std::hash::Hash::hash(native_turn_id, &mut hash);
    format!(
        "{run_id}:{:016x}:{tool_id}",
        std::hash::Hasher::finish(&hash)
    )
}

fn bounded_tail(text: &mut String, limit: usize) {
    if text.len() > limit {
        let mut i = text.len() - limit;
        while !text.is_char_boundary(i) {
            i += 1;
        }
        text.drain(..i);
    }
}

fn flush_assistant(db: &Store, sid: &str, assistant: &Mutex<String>) -> Result<()> {
    let mut text = assistant.lock().map_err(|error| error.to_string())?;
    if !text.is_empty() {
        db.message(sid, "assistant", &text)?;
        text.clear();
    }
    Ok(())
}

fn save_agent_activity(
    db: &Store,
    assistant: &Mutex<String>,
    activity: &mut AgentEvent,
    usage: Option<&ContextUsage>,
) -> Result<()> {
    match activity.kind.as_str() {
        "goal" => {
            let goal = activity
                .data
                .clone()
                .filter(|v| !v.is_null())
                .map(serde_json::from_value::<goal_state::GoalState>)
                .transpose()
                .map_err(|_| "Invalid goal metadata.".to_string())?;
            db.record_goal(&activity.session_id, goal.as_ref())
        }
        "task_settings" => {
            let task = db.session(&activity.session_id)?;
            let settings = activity.data.as_ref().ok_or("Missing task settings.")?;
            let object = settings.as_object().ok_or("Invalid task settings.")?;
            if task.provider != "codex"
                || object.keys().any(|key| {
                    !matches!(
                        key.as_str(),
                        "collaborationMode" | "serviceTier" | "personality"
                    )
                })
            {
                return Err("Task settings do not belong to this Codex task.".into());
            }
            let data = serde_json::to_string(settings).map_err(|error| error.to_string())?;
            if data.len() > 32 * 1024 {
                return Err("Task settings are too large.".into());
            }
            db.db
                .execute(
                    "UPDATE sessions SET codex_settings=?2 WHERE id=?1",
                    rusqlite::params![activity.session_id, data],
                )
                .map_err(|error| error.to_string())?;
            Ok(())
        }
        "goal_input" => {
            flush_assistant(db, &activity.session_id, assistant)?;
            db.message(&activity.session_id, "user", &activity.text)
                .map(|_| ())
        }
        "session" => db.resume(&activity.session_id, &activity.text),
        "limited" => db.set_limited(&activity.session_id, activity.data.as_ref().and_then(|data| data["resetsAt"].as_i64())),
        "approval" => db.status(&activity.session_id, "waiting"),
        "usage" => match usage {
            Some(usage) => db.record_context_usage(&activity.session_id, usage),
            None => Ok(()),
        },
        // Provider message boundaries separate commentary from subsequent
        // replies even when no tool call appears between them. Persist the
        // previous text before forwarding the boundary; the marker is not a row.
        "message_start" | "turn_complete" => flush_assistant(db, &activity.session_id, assistant),
        "tool" | "error" => {
            // Tool progress can arrive after the agent has begun its next
            // response. Only a newly encountered call is a text boundary;
            // updates must not split that response. Reuse the persisted unique
            // tool index instead of keeping an unbounded per-turn ID cache.
            let starts_tool = match &activity.tool {
                Some(tool) => db.db.query_row(
                    "SELECT NOT EXISTS(SELECT 1 FROM messages WHERE session_id=?1 AND tool_id=?2)",
                    rusqlite::params![activity.session_id, tool.id],
                    |row| row.get::<_, bool>(0),
                ).map_err(|error| error.to_string())?,
                None => true,
            };
            let flushed = if activity.kind == "error" || starts_tool {
                flush_assistant(db, &activity.session_id, assistant)
            } else {
                Ok(())
            };
            let saved = if let Some(tool) = &activity.tool {
                serde_json::to_string(&StoredToolActivity {
                    record_type: "tool_activity",
                    version: 1,
                    tool,
                })
                .map_err(|error| error.to_string())
                .and_then(|content| db.tool_message(&activity.session_id, &tool.id, &content))
            } else {
                bounded_tail(&mut activity.text, 8192);
                db.message(&activity.session_id, &activity.kind, &activity.text)
            };
            // Keep recording tool/error activity if a response write fails,
            // while still surfacing that persistence error to the turn owner.
            flushed.and(saved)
        }
        _ => Ok(()),
    }
}
fn recipes_dir(app: &tauri::AppHandle, state: &State<'_, AppState>, project_id: &str, scope: &str) -> Result<PathBuf> {
    if scope == "global" {
        return Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("recipes"));
    }
    let root = state.store.lock().map_err(|e| e.to_string())?.workspace_root(project_id, None)?;
    Ok(recipes::project_dir(&root))
}
#[tauri::command]
async fn recipes_list(app: tauri::AppHandle, state: State<'_, AppState>, project_id: String) -> Result<Vec<recipes::Recipe>> {
    let root = state.store.lock().map_err(|e| e.to_string())?.workspace_root(&project_id, None).ok();
    let global = recipes_dir(&app, &state, &project_id, "global")?;
    blocking(move || Ok(recipes::list(root.as_deref(), &global))).await
}
#[tauri::command]
async fn recipes_save(app: tauri::AppHandle, state: State<'_, AppState>, project_id: String, scope: String, recipe: recipes::Recipe) -> Result<()> {
    let dir = recipes_dir(&app, &state, &project_id, &scope)?;
    blocking(move || recipes::save(&dir, &recipe)).await
}
#[tauri::command]
async fn recipes_delete(app: tauri::AppHandle, state: State<'_, AppState>, project_id: String, scope: String, name: String) -> Result<()> {
    let dir = recipes_dir(&app, &state, &project_id, &scope)?;
    blocking(move || recipes::delete(&dir, &name)).await
}
#[tauri::command]
async fn recipes_dry_run(recipe: recipes::Recipe, provider: String, slash: Vec<String>) -> Result<recipes::Plan> {
    recipes::plan(&recipe, &provider, &slash)
}
#[tauri::command]
async fn list_slash_commands(
    state: State<'_, AppState>,
    session_id: String,
    force: Option<bool>,
    cached_only: Option<bool>,
) -> Result<slash_commands::Catalog> {
    let (provider, cwd) = {
        let store = state.store.lock().map_err(|e| e.to_string())?;
        let task = store.session(&session_id)?;
        (
            task.provider,
            store.workspace_root(&task.project_id, Some(&session_id))?,
        )
    };
    if cached_only.unwrap_or(false) {
        return slash_commands::snapshot(&provider, &cwd);
    }
    slash_commands::catalog(&provider, &cwd, force.unwrap_or(false)).await
}

#[tauri::command]
async fn resolve_slash_command(
    state: State<'_, AppState>,
    session_id: String,
    text: String,
) -> Result<slash_commands::Resolution> {
    if text.len() > 128 * 1024 {
        return Err("Message must be under 128 KiB.".into());
    }
    let (provider, cwd) = {
        let store = state.store.lock().map_err(|e| e.to_string())?;
        let task = store.session(&session_id)?;
        (
            task.provider,
            store.workspace_root(&task.project_id, Some(&session_id))?,
        )
    };
    slash_commands::resolve(&provider, &cwd, &text).await
}

struct PreparedCommand {
    provider: String,
    cwd: PathBuf,
    original: String,
    resolution: slash_commands::Resolution,
}

async fn prepare_command(
    state: &AppState,
    session_id: &str,
    text: Option<&str>,
) -> Result<Option<PreparedCommand>> {
    let (provider, cwd, original) = {
        let store = state.store.lock().map_err(|e| e.to_string())?;
        let task = store.session(session_id)?;
        let original = text
            .unwrap_or_else(|| {
                if task.task_description.trim().is_empty() {
                    &task.title
                } else {
                    &task.task_description
                }
            })
            .trim()
            .to_string();
        if original.len() > 128 * 1024 {
            return Err("Message and attached context must be under 128 KiB.".into());
        }
        let Some((name, _)) = slash_commands::split_command(&original) else {
            return Ok(None);
        };
        if task.provider == "codex" && name == "/compact" && task.resume_id.is_none() {
            return Err("Start a conversation before compacting its context.".into());
        }
        (
            task.provider,
            store.workspace_root(&task.project_id, Some(session_id))?,
            original,
        )
    };
    let resolution = slash_commands::resolve(&provider, &cwd, &original).await?;
    if resolution.action.is_some() {
        return Err("This command opens a PandaCode control. Run it from the message box.".into());
    }
    Ok(Some(PreparedCommand {
        provider,
        cwd,
        original,
        resolution,
    }))
}

#[tauri::command]
async fn send_message(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    mut text: String,
    image_ids: Option<Vec<String>>,
    moodboard_ids: Option<Vec<String>>,
) -> Result<()> {
    let (is_team, project_id) = {
        let store = state.store.lock().map_err(|e| e.to_string())?;
        let task = store.session(&session_id)?;
        if let Some(ids) = moodboard_ids.as_deref().filter(|ids| !ids.is_empty()) {
            text.push_str(&moodboards::resolve_refs(&store, &task.project_id, ids)?);
        }
        (
            architect::load(&store, &session_id)?.is_some(),
            task.project_id,
        )
    };
    if is_team {
        return architect::architect_start_in_project(
            app,
            state,
            session_id,
            text,
            image_ids,
            Some(project_id),
        )
        .await;
    }
    if remote::Mirror::is(&state, &session_id)? {
        // Screenshots and images are files on this computer; the host cannot read them.
        if image_ids.as_ref().is_some_and(|ids| !ids.is_empty()) {
            return Err("Images can't be sent to a task on another computer yet.".into());
        }
        remote::route(&app, &state, &session_id, "task.send", serde_json::json!({"text": text})).await?;
        return Ok(());
    }
    if image_ids.as_ref().is_some_and(|ids| !ids.is_empty()) && cloud_agents::transport::is_cloud(&session_id) {
        return Err("Images can't be sent to a cloud machine yet.".into());
    }
    launch_task_in_project(
        app,
        state,
        session_id,
        Some(text),
        image_ids,
        Some(project_id),
    )
    .await
}

#[tauri::command]
async fn start_task(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
) -> Result<()> {
    let team_prompt = {
        let store = state.store.lock().map_err(|e| e.to_string())?;
        if architect::load(&store, &session_id)?.is_some() {
            let task = store.session(&session_id)?;
            Some(if task.task_description.trim().is_empty() {
                task.title
            } else {
                task.task_description
            })
        } else {
            None
        }
    };
    if let Some(prompt) = team_prompt {
        return architect::architect_start(app, state, session_id, prompt, None).await;
    }
    launch_task(app, state, session_id, None, None).await
}

#[derive(Default)]
struct RunAdmission<'a> {
    expected_project: Option<&'a str>,
    command: Option<PreparedCommand>,
    goal: Option<goal_state::GoalRequest>,
    team: Option<architect::Admission>,
    /// Re-attach to a cloud task's remote run (`cloud_agents::resume`): no new turn.
    cloud_attach: bool,
}

struct PreparedRun {
    config: RunConfig,
    restore_stage: Option<String>,
    turn_message_id: i64,
    turn_started: std::time::Instant,
    context_handoff: Option<i64>,
    run_id: String,
    pending_approvals: Arc<Mutex<HashSet<String>>>,
    subagents: Arc<Mutex<subagent_state::SubagentState>>,
    assistant: Arc<Mutex<String>>,
    last_event: Arc<std::sync::atomic::AtomicI64>,
    team: Option<architect::Admission>,
}

#[cfg(test)]
fn prepare_task_run(
    state: &AppState,
    session_id: String,
    text: Option<String>,
    images: Vec<PathBuf>,
    tx: UnboundedSender<RunInput>,
    stopped: Arc<AtomicBool>,
) -> Result<PreparedRun> {
    prepare_task_run_in_project(
        state,
        session_id,
        text,
        images,
        tx,
        stopped,
        RunAdmission::default(),
    )
}

fn prepare_task_run_in_project(
    state: &AppState,
    session_id: String,
    text: Option<String>,
    images: Vec<PathBuf>,
    tx: UnboundedSender<RunInput>,
    stopped: Arc<AtomicBool>,
    admission: RunAdmission<'_>,
) -> Result<PreparedRun> {
    let mut agents = state.agents.lock().map_err(|e| e.to_string())?;
    agent_updates::ensure_not_installing()?;
    if state.shutdown.load(Ordering::SeqCst) != 0 {
        return Err("PandaCode is shutting down.".into());
    }
    if agents.contains_key(&session_id) || terminal::harness_running(&state.terminals, &session_id)?
    {
        return Err("This task is already running in an agent or harness console.".into());
    }
    let store = state.store.lock().map_err(|e| e.to_string())?;
    architect::validate_admission(&store, &session_id, admission.team.as_ref())?;
    let session = reconcile_inactive_task(&store, &agents, store.session(&session_id)?);
    if admission.cloud_attach {
        return prepare_cloud_attach(&store, &mut agents, session, tx, stopped);
    }
    if admission.goal.is_some() && session.provider != "codex" {
        return Err(
            "Goals require the Codex harness. The task provider changed before it started.".into(),
        );
    }
    if admission
        .expected_project
        .is_some_and(|project| project != session.project_id)
    {
        return Err("Task moved to a different project. Read its details again.".into());
    }
    // Resolve the saved task details under the same lock as the execution
    // claim, so Start cannot race a details edit or completion action.
    let text = text
        .unwrap_or_else(|| {
            if session.task_description.trim().is_empty() {
                session.title.clone()
            } else {
                session.task_description.clone()
            }
        })
        .trim()
        .to_string();
    if text.is_empty() {
        return Err("Write a message first.".into());
    }
    if text.len() > 128 * 1024 {
        return Err("Message and attached context must be under 128 KiB.".into());
    }
    let cwd = store.workspace_root(&session.project_id, Some(&session_id))?;
    // Discovery awaits outside the locks. Recheck the exact command and checkout
    // when claiming the task so changing its harness/project cannot run stale metadata.
    let (prompt, skill, maintenance) = match admission.command {
        Some(command) => {
            if command.provider != session.provider
                || command.cwd != cwd
                || command.original != text
            {
                return Err("The task changed while commands were loading. Try again.".into());
            }
            if !command.resolution.accepts_attachments && !images.is_empty() {
                return Err(
                    "This command does not accept attachments. Remove them before running it."
                        .into(),
                );
            }
            (
                command.resolution.prompt,
                command.resolution.skill,
                command.resolution.maintenance,
            )
        }
        None if admission.goal.is_none()
            && admission.team.is_none()
            && slash_commands::split_command(&text).is_some() =>
        {
            return Err("The task command changed. Try again to load its commands.".into());
        }
        None => (text.clone(), None, false),
    };
    let needs_context = context_recovery::pending(&store, &session)?;
    let goal_control = matches!(
        admission.goal,
        Some(
            goal_state::GoalRequest::Get
                | goal_state::GoalRequest::Pause
                | goal_state::GoalRequest::Clear
        )
    );
    if needs_context
        && ((!goal_control && admission.goal.is_some())
            || slash_commands::split_command(&prompt).is_some())
    {
        return Err(context_recovery::RECOVERY_REQUIRED.into());
    }
    let (prompt, context_handoff) = if goal_control {
        if needs_context {
            context_recovery::queue(&store, &session_id)?;
        }
        (prompt, None)
    } else {
        context_recovery::prepare(&store, &session, &prompt)?
    };
    let turn_started = std::time::Instant::now();
    let turn_message_id = if admission.goal.is_some() {
        if matches!(admission.goal, Some(goal_state::GoalRequest::Set { .. })) {
            store.begin_task_turn(&session_id, &text)?
        } else {
            store.begin_goal_operation(&session_id)?;
            0
        }
    } else {
        let kind = architect::internal_turns::pending_kind(
            &store,
            &session_id,
            &text,
            admission.team.as_ref(),
        )?;
        store.begin_task_turn_with_kind(&session_id, &text, kind)?
    };
    let maintenance = maintenance
        || matches!(
            admission.goal,
            Some(
                goal_state::GoalRequest::Get
                    | goal_state::GoalRequest::Pause
                    | goal_state::GoalRequest::Clear
            )
        );
    let prompt = architect::prompt(&store, &session_id, &prompt, admission.team.as_ref())?;
    let config = RunConfig {
        session_id: session_id.clone(),
        provider: session.provider,
        model: session.model,
        reasoning_effort: session.reasoning_effort,
        mode: session.mode,
        cwd,
        resume_id: session.resume_id,
        prompt,
        instructions: String::new(),
        images,
        skill,
        goal: admission.goal,
        codex_settings: session.codex_settings,
    };
    architect::mark_started(&store, &session_id, admission.team.as_ref())?;
    let agent = RunningAgent::new(tx, stopped.clone());
    let run_id = agent.run_id.clone();
    let pending_approvals = agent.approvals.clone();
    let subagents = agent.subagents.clone();
    let assistant = agent.assistant.clone();
    let last_event = agent.last_event.clone();
    agents.insert(session_id.clone(), agent);
    Ok(PreparedRun {
        config,
        restore_stage: maintenance.then_some(session.task_stage),
        turn_message_id,
        turn_started,
        context_handoff,
        run_id,
        pending_approvals,
        subagents,
        assistant,
        last_event,
        team: admission.team,
    })
}

/// A run that re-attaches to a cloud task's remote run: the turn it belongs to was saved
/// before; what came after is rebuilt by replaying the run's whole log.
fn prepare_cloud_attach(
    store: &Store,
    agents: &mut HashMap<String, RunningAgent>,
    session: Session,
    tx: UnboundedSender<RunInput>,
    stopped: Arc<AtomicBool>,
) -> Result<PreparedRun> {
    let session_id = session.id.clone();
    let cloud = cloud_agents::load(store, &session_id)?
        .filter(|cloud| cloud.active())
        .ok_or("This cloud run already ended.")?;
    let cwd = store.workspace_root(&session.project_id, Some(&session_id))?;
    store.db.execute("DELETE FROM messages WHERE session_id=?1 AND id>?2", rusqlite::params![session_id, cloud.turn_message]).map_err(|e| e.to_string())?;
    store.db.execute("UPDATE sessions SET status='running',task_stage='in_progress',completed_at=NULL WHERE id=?1", [&session_id]).map_err(|e| e.to_string())?;
    let config = RunConfig {
        session_id: session_id.clone(),
        provider: session.provider,
        model: session.model,
        reasoning_effort: session.reasoning_effort,
        mode: session.mode,
        cwd,
        resume_id: session.resume_id,
        prompt: String::new(),
        instructions: String::new(),
        images: Vec::new(),
        skill: None,
        goal: None,
        codex_settings: session.codex_settings,
    };
    let agent = RunningAgent::new(tx, stopped);
    let prepared = PreparedRun {
        config,
        restore_stage: None,
        turn_message_id: cloud.turn_message,
        turn_started: std::time::Instant::now(),
        context_handoff: None,
        run_id: agent.run_id.clone(),
        pending_approvals: agent.approvals.clone(),
        subagents: agent.subagents.clone(),
        assistant: agent.assistant.clone(),
        last_event: agent.last_event.clone(),
        team: None,
    };
    agents.insert(session_id, agent);
    Ok(prepared)
}

/// Starts a run that re-attaches to a cloud task's remote run (`cloud_agents::resume`).
pub(crate) async fn attach_cloud_run(app: tauri::AppHandle, session_id: String) -> Result<()> {
    let state = app.state::<AppState>();
    launch_operation_admitted(
        app.clone(),
        state,
        session_id,
        None,
        None,
        OperationAdmission {
            expected_project: None,
            goal: None,
            team: None,
            cloud_attach: true,
        },
    )
    .await
}

async fn launch_task(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    text: Option<String>,
    image_ids: Option<Vec<String>>,
) -> Result<()> {
    launch_task_in_project(app, state, session_id, text, image_ids, None).await
}

async fn launch_task_in_project(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    text: Option<String>,
    image_ids: Option<Vec<String>>,
    expected_project: Option<String>,
) -> Result<()> {
    launch_operation(
        app,
        state,
        session_id,
        text,
        image_ids,
        expected_project,
        None,
    )
    .await
}

async fn launch_operation(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    text: Option<String>,
    image_ids: Option<Vec<String>>,
    expected_project: Option<String>,
    goal: Option<task_controls::GoalLaunch>,
) -> Result<()> {
    launch_operation_admitted(
        app,
        state,
        session_id,
        text,
        image_ids,
        OperationAdmission {
            expected_project,
            goal,
            team: None,
            cloud_attach: false,
        },
    )
    .await
}

pub(crate) fn launch_team_task<'a>(
    app: tauri::AppHandle,
    state: State<'a, AppState>,
    session_id: String,
    text: String,
    image_ids: Option<Vec<String>>,
    admission: architect::Admission,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>> + Send + 'a>> {
    Box::pin(launch_operation_admitted(
        app,
        state,
        session_id,
        Some(text),
        image_ids,
        OperationAdmission {
            expected_project: None,
            goal: None,
            team: Some(admission),
            cloud_attach: false,
        },
    ))
}

struct OperationAdmission {
    expected_project: Option<String>,
    goal: Option<task_controls::GoalLaunch>,
    team: Option<architect::Admission>,
    cloud_attach: bool,
}

async fn launch_operation_admitted(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    text: Option<String>,
    image_ids: Option<Vec<String>>,
    admission: OperationAdmission,
) -> Result<()> {
    let OperationAdmission {
        expected_project,
        goal,
        team: team_admission,
        cloud_attach,
    } = admission;
    if state.shutdown.load(Ordering::SeqCst) != 0 {
        return Err("PandaCode is shutting down.".into());
    }
    let command = if goal.is_none() && team_admission.is_none() && !cloud_attach {
        prepare_command(&state, &session_id, text.as_deref()).await?
    } else {
        None
    };
    let goal_request = goal.as_ref().map(|g| g.request.clone());
    let goal_reply = Arc::new(Mutex::new(goal.map(|g| g.reply)));
    let image_ids = image_ids.unwrap_or_default();
    if image_ids.len() > 4 {
        return Err("Attach up to four screenshots per message.".into());
    }
    let capture_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("browser-captures");
    let images = image_ids
        .into_iter()
        .map(|id| {
            let parsed = uuid::Uuid::parse_str(&id)
                .map_err(|_| "Invalid screenshot attachment.".to_string())?;
            if parsed.to_string() != id {
                return Err("Invalid screenshot attachment.".to_string());
            }
            let path = capture_dir.join(format!("{id}.png"));
            let metadata = std::fs::symlink_metadata(&path)
                .map_err(|_| "Screenshot is unavailable. Capture it again.".to_string())?;
            if !metadata.file_type().is_file() || metadata.len() > 5 * 1024 * 1024 {
                return Err("Invalid screenshot attachment.".to_string());
            }
            Ok(path)
        })
        .collect::<Result<Vec<_>>>()?;
    let (tx, rx) = unbounded_channel();
    let stopped = Arc::new(AtomicBool::new(false));
    let PreparedRun {
        mut config,
        restore_stage,
        turn_message_id,
        turn_started,
        context_handoff,
        run_id,
        pending_approvals,
        subagents,
        assistant,
        last_event,
        team,
    } = prepare_task_run_in_project(
        &state,
        session_id.clone(),
        text,
        images,
        tx,
        stopped.clone(),
        RunAdmission {
            expected_project: expected_project.as_deref(),
            command,
            goal: goal_request,
            team: team_admission,
            cloud_attach,
        },
    )?;
    // A cloud task's agent runs on its machine (cloud_agents::transport). Quitting must
    // leave that run alone, so this run neither stops it nor records an end while closing.
    let cloud = cloud_agents::transport::is_cloud(&session_id);
    let _ = app.emit("agent-event", event(&session_id, "status", "running"));
    tray::refresh(&app);
    let store = state.store.clone();
    let agents = state.agents.clone();
    // Optional metadata must never block a conversation when its storage cannot
    // be inspected. It is unavailable for maintenance, coordination, or named tasks.
    let title_run = if restore_stage.is_none() {
        store.lock().ok().and_then(|db| {
            session_titles::TitleRun::prepare(&db, &session_id, turn_message_id)
                .ok()
                .flatten()
        })
    } else {
        None
    };
    if let Some(title) = &title_run {
        config.prompt.push_str(&title.instruction());
    }
    if restore_stage.is_none() {
        let instructions = app_instructions(chats::is_chat_folder(&config.cwd));
        if providers::takes_system_instructions(&config.provider) {
            // Cached with the system prompt: paid once, then read at a tenth of the price.
            config.instructions = instructions;
        } else {
            // In the message: on a new conversation, then as a periodic reminder.
            let turns = store.lock().ok().and_then(|db| db.user_turns(&session_id).ok()).unwrap_or(1);
            if config.resume_id.is_none() || reminder_turn(turns) {
                config.prompt.push_str(&instructions);
            }
        }
    }
    tauri::async_runtime::spawn(async move {
        let changes_root = config.cwd.clone();
        let changes_cache = app
            .path()
            .app_cache_dir()
            .unwrap_or_else(|_| std::env::temp_dir().join("pandacode"))
            .join("turn-captures");
        // Goal inspection/pause/clear are control operations, not model turns.
        let tracker = if matches!(
            config.goal.as_ref(),
            Some(
                goal_state::GoalRequest::Get
                    | goal_state::GoalRequest::Pause
                    | goal_state::GoalRequest::Clear
            )
        ) {
            None
        } else {
            tauri::async_runtime::spawn_blocking(move || {
                turn_changes::Tracker::start(changes_root, changes_cache)
            })
            .await
            .ok()
            .map(|tracker| Arc::new(Mutex::new(tracker)))
        };
        let tracker_sink = tracker.clone();
        let persistence_error = Arc::new(Mutex::new(None::<String>));
        let errors_sink = persistence_error.clone();
        let assistant_sink = assistant.clone();
        let store_sink = store.clone();
        let app_sink = app.clone();
        let subagents_sink = subagents.clone();
        let goal_reply_sink = goal_reply.clone();
        let goal_agents_sink = agents.clone();
        let native_turn_sink = Mutex::new(String::new());
        let team_sink = team.clone();
        let sink: providers::Sink = Arc::new(move |mut e: AgentEvent| {
            if cloud && app_sink.state::<AppState>().shutdown.load(Ordering::SeqCst) != 0 {
                return;
            }
            last_event.store(storage::now(), Ordering::SeqCst);
            if e.kind == "done" {
                return;
            }
            let usage = if e.kind == "usage" {
                let Some(usage) = e.data.as_ref().and_then(ContextUsage::from_value) else {
                    return;
                };
                // Forward only bounded, recognized metadata, never the raw
                // provider response or cumulative billing totals.
                e.data = serde_json::to_value(&usage).ok();
                Some(usage)
            } else {
                None
            };
            if e.kind == "turn_start" {
                if let Some(tracker) = &tracker_sink {
                    blocking_snapshot(|| {
                        if let Ok(mut tracker) = tracker.lock() {
                            tracker.started();
                        }
                    });
                }
                if let Some(turn) = e.data.as_ref().and_then(|data| data["turnId"].as_str()) {
                    *native_turn_sink
                        .lock()
                        .unwrap_or_else(|poison| poison.into_inner()) = turn.into();
                }
            }
            if let Some(tool) = &mut e.tool {
                let turn = native_turn_sink
                    .lock()
                    .unwrap_or_else(|poison| poison.into_inner());
                tool.id = run_tool_id(&run_id, &turn, &tool.id);
            }
            if let Some(tracker) = tracker_sink.as_ref().filter(|_| e.tool.is_some() || e.kind == "subagent") {
                blocking_snapshot(|| {
                    if let Ok(mut tracker) = tracker.lock() {
                        tracker.observe(&e);
                    }
                });
            }
            if e.kind == "text" {
                if let Ok(mut text) = assistant_sink.lock() {
                    text.push_str(&e.text);
                    bounded_tail(&mut text, 512 * 1024);
                }
            } else {
                let saved = if e.kind == "subagent" {
                    subagents_sink
                        .lock()
                        .map_err(|error| error.to_string())
                        .and_then(|mut children| children.record(&store_sink, &run_id, &mut e))
                } else if matches!(
                    e.kind.as_str(),
                    "approval" | "approval_cancelled" | "input_request" | "input_cancelled"
                ) {
                    let saved = save_approval(&store_sink, &pending_approvals, &run_id, &mut e);
                    if saved.is_ok() && e.kind == "approval" {
                        if let Some(request_id) = &e.request_id {
                            bots::approval_requested(&app_sink, &e.session_id, request_id, &e.text);
                        }
                        tray::refresh(&app_sink);
                    }
                    saved
                } else {
                    store_sink
                        .lock()
                        .map_err(|error| error.to_string())
                        .and_then(|db| {
                            save_agent_activity(&db, &assistant_sink, &mut e, usage.as_ref())
                        })
                };
                if let Err(error) = saved {
                    if let Ok(mut slot) = errors_sink.lock() {
                        *slot = Some(error);
                    }
                    if matches!(e.kind.as_str(), "goal" | "goal_input") {
                        if let Ok(registry) = goal_agents_sink.lock() {
                            if let Some(agent) = registry.get(&e.session_id) {
                                let _ = agent.send(RunInput::Stop);
                            }
                        }
                    }
                }
            }
            if e.kind == "goal_ready" {
                let result = errors_sink
                    .lock()
                    .map_err(|_| "Goal persistence is unavailable.".to_string())
                    .and_then(|error| {
                        if let Some(error) = error.as_ref() {
                            Err(error.clone())
                        } else {
                            e.data
                                .clone()
                                .filter(|v| !v.is_null())
                                .map(serde_json::from_value)
                                .transpose()
                                .map_err(|_| "Invalid goal metadata.".to_string())
                        }
                    });
                if let Ok(mut slot) = goal_reply_sink.lock() {
                    if let Some(reply) = slot.take() {
                        let _ = reply.send(result);
                    }
                }
            }
            if matches!(
                e.kind.as_str(),
                "approval" | "approval_cancelled" | "input_request" | "input_cancelled"
            ) {
                architect::activity(&app_sink, &e.session_id, team_sink.as_ref());
            }
            remote::agent_event(&app_sink, &e);
            // Cloned only for the turn boundary below.
            let completed = (e.kind == "turn_complete").then(|| e.session_id.clone());
            let _ = app_sink.emit("agent-event", e);
            if let Some(changes_sid) = completed {
                if let Some(tracker) = &tracker_sink {
                    let capture = blocking_snapshot(|| {
                        tracker
                            .lock()
                            .ok()
                            .and_then(|mut tracker| tracker.boundary())
                    });
                    if let Some(capture) = capture {
                        persist_turn_changes(&app_sink, &store_sink, &changes_sid, capture);
                    }
                }
            }
        });
        let host = if let Some(admission) = team.as_ref() {
            architect::host(app.clone(), session_id.clone(), stopped.clone(), admission)
        } else {
            (config.provider == "codex")
                .then(|| agent_tools::host(app.clone(), session_id.clone(), stopped.clone()))
        };
        let team_tools_missing = team.is_some() && host.is_none();
        let host = agent_tools::with_jev(host, app.clone(), session_id.clone(), stopped.clone());
        let host = bots::tools::with_bot(host, app.clone(), session_id.clone(), stopped.clone());
        let host = simulator::tools::with_simulator(host, app.clone(), stopped.clone());
        let host = vm::tools::with_vm(host, app.clone(), session_id.clone(), stopped.clone());
        let host = design::with_design(host, app.clone(), session_id.clone(), stopped.clone());
        let host = cloud::deploy::with_deploy(host, app.clone(), session_id.clone(), stopped.clone());
        let host = Some(agent_tools::with_preview(host, app.clone(), session_id.clone(), stopped.clone()));
        let host = Some(turn_changes::with_host(host, tracker.clone(), stopped.clone()));
        let host = Some(session_titles::with_host(title_run.as_ref(), host, stopped.clone()));
        // What the next turn's warm agent needs: this launch and the tools it listed.
        // Team workers rarely get a follow-up, and their warm agents would push out the
        // architect's, whose review turn starts as soon as they settle.
        let managed_worker = team.as_ref().is_some_and(|admission| admission.parent != session_id);
        let warm_next = (providers::warms(&config) && !managed_worker && !cloud).then(|| {
            let tools = host.as_ref().map(|host| (host.tools.clone(), host.approval_tools.clone())).unwrap_or_default();
            (config.clone(), tools)
        });
        let result = if stopped.load(Ordering::SeqCst) {
            Ok(())
        } else if team_tools_missing {
            Err(
                "Team tools could not be initialized. No unrestricted tool fallback was used."
                    .into(),
            )
        } else {
            providers::run_with_tools(config, sink, rx, host).await
        };
        if cloud && app.state::<AppState>().shutdown.load(Ordering::SeqCst) != 0 {
            // The remote run continues; the next launch re-attaches to it.
            if let Ok(mut registry) = agents.lock() {
                registry.remove(&session_id);
            }
            return;
        }
        if let Ok(mut slot) = goal_reply.lock() {
            if let Some(reply) = slot.take() {
                let _ =
                    reply.send(Err(result.as_ref().err().cloned().unwrap_or_else(|| {
                        "Codex did not acknowledge the goal operation.".into()
                    })));
            }
        }
        let turn_duration_ms = turn_started.elapsed().as_millis().min(i64::MAX as u128) as i64;
        // The terminal change marker must follow the final assistant response,
        // including harnesses that emit no native completion boundary.
        if let Err(error) = store
            .lock()
            .map_err(|e| e.to_string())
            .and_then(|db| flush_assistant(&db, &session_id, &assistant))
        {
            if let Ok(mut slot) = persistence_error.lock() {
                *slot = Some(error);
            }
        }
        if let Some(tracker) = tracker {
            if let Ok(Some(capture)) = tauri::async_runtime::spawn_blocking(move || {
                tracker.lock().ok().and_then(|mut tracker| tracker.finish())
            })
            .await
            {
                persist_turn_changes(&app, &store, &session_id, capture);
            }
        }
        if cloud {
            // The run's messages are saved; now its changes come back, before the turn ends,
            // so a queued follow-up starts from them. Until that is done the run stays
            // re-attachable (its run ID is kept), so a quit or an outage loses nothing.
            let (cloud_app, cloud_id) = (app.clone(), session_id.clone());
            if let Err(error) = blocking(move || cloud_agents::tasks::after_run(&cloud_app, &cloud_id)).await {
                eprintln!("Cloud agents: could not finish a cloud run yet: {error}");
            }
            let unfinished = store.lock().ok().and_then(|db| cloud_agents::load(&db, &session_id).ok().flatten()).is_some_and(|cloud| cloud.active());
            if unfinished && app.state::<AppState>().shutdown.load(Ordering::SeqCst) != 0 {
                if let Ok(mut registry) = agents.lock() {
                    registry.remove(&session_id);
                }
                return;
            }
        }
        // Match the registry -> store lock order used for Start and Stop. Stop
        // cannot arrive between the final stage decision and registry removal.
        let mut registry = agents.lock().ok();
        let was_stopped = stopped.load(Ordering::SeqCst);
        // Provider completion revokes callbacks too; a delayed collaboration/MCP
        // request must not write into the next run while the team remains active.
        stopped.store(true, Ordering::SeqCst);
        let mut successful = result.is_ok() && !was_stopped;
        let mut children = subagents.lock().ok();
        if let Ok(db) = store.lock() {
            let child_status = if was_stopped || successful {
                "stopped"
            } else {
                "failed"
            };
            let (changed, saved) = children
                .as_mut()
                .map(|children| children.finish(&db, &session_id, child_status))
                .unwrap_or_else(|| {
                    (
                        Vec::new(),
                        Err("Could not lock subagent snapshots.".to_string()),
                    )
                });
            for child in changed {
                let mut activity = event(&session_id, "subagent", "");
                activity.data = serde_json::to_value(child).ok();
                let _ = app.emit("agent-event", activity);
            }
            if let Err(error) = saved {
                if let Ok(mut slot) = persistence_error.lock() {
                    *slot = Some(error);
                }
            }
            // Success, provider failure, and explicit cancellation all return
            // through here. Startup recovery intentionally leaves unknown time null.
            if let Err(error) = if turn_message_id != 0 {
                db.finish_turn(&session_id, turn_message_id, turn_duration_ms)
            } else {
                Ok(())
            } {
                if let Ok(mut slot) = persistence_error.lock() {
                    *slot = Some(error);
                }
            }
            if let Err(error) = db.finish_tools(&session_id) {
                if let Ok(mut slot) = persistence_error.lock() {
                    *slot = Some(error);
                }
            }
            if let Err(error) = flush_assistant(&db, &session_id, &assistant) {
                if let Ok(mut slot) = persistence_error.lock() {
                    *slot = Some(error);
                }
            }
            successful &= persistence_error
                .lock()
                .map(|error| error.is_none())
                .unwrap_or(false);
            if let Ok(task) = db.session(&session_id) {
                if let Some(mut goal) = task.goal_state.filter(|g| g.status == "active") {
                    goal.status = "paused".into();
                    if db.record_goal(&session_id, Some(&goal)).is_ok() {
                        let mut e = event(&session_id, "goal", "");
                        e.data = serde_json::to_value(goal).ok();
                        let _ = app.emit("agent-event", e);
                    }
                }
            }
            if let Err(error) = db.finish_task_operation(
                &session_id,
                successful,
                was_stopped,
                restore_stage.as_deref(),
            ) {
                successful = false;
                if let Ok(mut slot) = persistence_error.lock() {
                    *slot = Some(error);
                }
            }
            if successful {
                if let Some(through) = context_handoff {
                    let resumed = db
                        .session(&session_id)
                        .is_ok_and(|task| task.resume_id.is_some_and(|id| !id.trim().is_empty()));
                    if resumed {
                        if let Err(error) = context_recovery::acknowledge(&db, &session_id, through)
                        {
                            successful = false;
                            if let Ok(mut slot) = persistence_error.lock() {
                                *slot = Some(error);
                            }
                        }
                    }
                }
            }
            if let Some(title) = &title_run {
                if title.finish(&db, successful).unwrap_or(false) {
                    let _ = app.emit("sessions-changed", ());
                }
            }
        } else {
            successful = false;
        }
        if let Ok(error) = persistence_error.lock() {
            if let Some(error) = error.as_ref() {
                let _ = app.emit(
                    "agent-event",
                    event(
                        &session_id,
                        "error",
                        &format!("Could not save this conversation: {error}"),
                    ),
                );
            }
        }
        if let Some(registry) = registry.as_mut() {
            registry.remove(&session_id);
        }
        let done = if was_stopped {
            "Turn stopped"
        } else if successful {
            "Turn complete"
        } else {
            "Turn failed"
        };
        // Before `done`, so the window's tray_seen for the open task lands after it.
        tray::finished(&app, &session_id, was_stopped, successful);
        let _ = app.emit("agent-event", event(&session_id, "done", done));
        remote::run_finished(&app, &session_id, successful, was_stopped, done);
        // Bot conversations reply on their channel and send their next queued message.
        if !was_stopped {
            bots::run_finished(&app, &session_id, successful);
        }
        // Keep Start blocked until the old run's final event has been queued.
        // Otherwise its delayed `done` can finish a newly started UI stream.
        drop(children);
        // Read before the team scheduler can start this task's next turn.
        let launch = providers::warm_epoch(&session_id);
        if let Some(registry) = registry.as_ref() {
            architect::completed(&app, &session_id, team.as_ref(), successful, was_stopped, registry);
        }
        drop(registry);
        // Start the next turn's agent now, so a follow-up skips the CLI's own startup.
        if let (true, Some((mut next, (tools, approvals)))) = (successful && !was_stopped, warm_next) {
            // A turn that ended without any reply (seen after background commands) may have
            // left the session in a state a spare would inherit: start the next one fresh.
            let replied = store.lock().ok().and_then(|db| db.db.query_row(
                "SELECT EXISTS(SELECT 1 FROM messages WHERE session_id=?1 AND role='assistant' AND id>(SELECT COALESCE(MAX(id),0) FROM messages WHERE session_id=?1 AND role IN ('user','coordination')))",
                [&session_id],
                |row| row.get::<_, bool>(0),
            ).ok()).unwrap_or(false);
            let task = store.lock().ok().filter(|_| replied).and_then(|db| db.session(&session_id).ok());
            if let Some(task) = task {
                next.resume_id = task.resume_id;
                next.model = task.model;
                next.mode = task.mode;
                next.reasoning_effort = task.reasoning_effort;
                next.prompt.clear();
                next.images.clear();
                tauri::async_runtime::spawn(async move {
                    let _ = providers::prewarm_agent(next, tools, approvals, launch).await;
                });
            }
        }
    });
    Ok(())
}
#[tauri::command]
async fn stop_session(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
) -> Result<()> {
    if remote::mirror::stop(&app, &state, &session_id).await?.is_some() {
        return Ok(());
    }
    let is_team = {
        let store = state.store.lock().map_err(|e| e.to_string())?;
        architect::load(&store, &session_id)?.is_some()
    };
    if is_team {
        architect::architect_control(app, state, session_id, "stop".into()).await?;
        return Ok(());
    }
    if cloud_agents::transport::is_cloud(&session_id) {
        cloud_agents::tasks::stop_run(&app, &session_id);
    }
    if let Some(tx) = state
        .agents
        .lock()
        .map_err(|e| e.to_string())?
        .get(&session_id)
    {
        tx.send(RunInput::Stop)
            .map_err(|_| "Agent has stopped.".to_string())?;
    }
    Ok(())
}
#[tauri::command]
async fn respond_approval(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    request_id: String,
    approved: bool,
) -> Result<()> {
    if remote::route(&app, &state, &session_id, "approval.respond", serde_json::json!({"requestId": request_id, "approve": approved})).await?.is_some() {
        return Ok(());
    }
    let agents = state.agents.lock().map_err(|e| e.to_string())?;
    let tx = agents
        .get(&session_id)
        .ok_or("This agent is no longer running.")?;
    tx.respond_approval(&state.store, &session_id, request_id, approved)
}
#[tauri::command]
async fn list_providers(app: tauri::AppHandle, force: Option<bool>, device_id: Option<String>) -> Result<serde_json::Value> {
    let force = force.unwrap_or(false);
    if let Some(remote) = remote::catalog::providers(&app, device_id, force).await? {
        return Ok(remote);
    }
    serde_json::to_value(local_providers(force).await).map_err(|e| e.to_string())
}
/// This computer's harnesses; `force` drops the cached ACP catalogs first.
pub(crate) async fn local_providers(force: bool) -> Vec<providers::ProviderInfo> {
    if force {
        providers::acp_catalog::invalidate("antigravity");
        providers::acp_catalog::invalidate("grok");
    }
    tauri::async_runtime::spawn_blocking(providers::discover)
        .await
        .unwrap_or_default()
}
#[tauri::command]
async fn list_provider_models(app: tauri::AppHandle, provider: String, force: Option<bool>, device_id: Option<String>) -> Result<serde_json::Value> {
    let force = force.unwrap_or(false);
    if let Some(remote) = remote::catalog::models(&app, device_id, &provider, force).await? {
        return Ok(remote);
    }
    serde_json::to_value(local_provider_models(&provider, force).await?).map_err(|e| e.to_string())
}
pub(crate) async fn local_provider_models(provider: &str, force: bool) -> Result<Vec<providers::ModelInfo>> {
    if force { providers::acp_catalog::invalidate(provider); }
    providers::list_models(provider).await
}

#[tauri::command]
async fn respond_user_input(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    request_id: String,
    response: serde_json::Value,
) -> Result<()> {
    if response.to_string().len() > 32 * 1024 {
        return Err("Response is too large.".into());
    }
    if remote::route(&app, &state, &session_id, "input.respond", serde_json::json!({"requestId": request_id, "response": response})).await?.is_some() {
        return Ok(());
    }
    let reply = {
        let agents = state.agents.lock().map_err(|e| e.to_string())?;
        let agent = agents
            .get(&session_id)
            .ok_or("This agent is no longer running.")?;
        let pending = agent.approvals.lock().map_err(|e| e.to_string())?;
        if agent.stopped.load(Ordering::SeqCst) || !pending.contains(&request_id) {
            return Err("This question is no longer pending.".into());
        }
        let original_id = request_id
            .strip_prefix(&format!("{}:", agent.run_id))
            .ok_or("This question belongs to an earlier run.")?
            .to_owned();
        let (tx, rx) = tokio::sync::oneshot::channel();
        agent
            .send(RunInput::UserInput {
                request_id: original_id,
                response,
                reply: Some(tx),
            })
            .map_err(|_| "Agent has stopped.".to_string())?;
        rx
    };
    // Keep the form pending until the protocol validates the answer. An enqueue
    // acknowledgement alone could discard a rejected answer during streaming.
    tokio::time::timeout(std::time::Duration::from_secs(15), reply)
        .await
        .map_err(|_| "The agent did not acknowledge the answer. Try again.".to_owned())?
        .map_err(|_| "The agent stopped before accepting the answer.".to_owned())?
}

#[tauri::command]
async fn list_agent_integrations(
    state: State<'_, AppState>,
    project_id: String,
    session_id: Option<String>,
) -> Result<integrations::Catalog> {
    integrations::discover(state.root(&project_id, session_id.as_deref())?).await
}

#[tauri::command]
fn list_app_tools() -> serde_json::Value {
    serde_json::json!(agent_tools::catalog()
        .into_iter()
        .chain(agent_tools::enabled_jev_catalog())
        .map(|t| serde_json::json!({"name":t["name"],"description":t["description"]}))
        .collect::<Vec<_>>())
}

#[tauri::command]
async fn open_external_url(url: String) -> Result<()> {
    let parsed = tauri::Url::parse(&url).map_err(|_| "Invalid URL.")?;
    if url.len() > 8192
        || !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err("Use an HTTP or HTTPS URL without embedded credentials.".into());
    }
    #[cfg(target_os = "macos")]
    let mut command = tokio::process::Command::new("/usr/bin/open");
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = tokio::process::Command::new("rundll32");
        command.arg("url.dll,FileProtocolHandler");
        command
    };
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let mut command = tokio::process::Command::new("xdg-open");
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    child_env::sanitize(&mut command);
    command
        .arg(parsed.as_str())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    let status = tokio::time::timeout(std::time::Duration::from_secs(5), command.status())
        .await
        .map_err(|_| "Opening the link timed out.")?
        .map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err("Could not open the browser.".into())
    }
}

#[tauri::command]
async fn jj_status(state: State<'_, AppState>, project_id: String, session_id: Option<String>) -> Result<jj::JjStatus> {
    let root = state.root(&project_id, session_id.as_deref())?;
    blocking(move || jj::status(&root)).await
}
#[tauri::command]
async fn jj_diff(state: State<'_, AppState>, project_id: String, session_id: Option<String>, path: Option<String>) -> Result<String> {
    let root = state.root(&project_id, session_id.as_deref())?;
    blocking(move || jj::diff(&root, path.as_deref())).await
}
#[tauri::command]
async fn jj_describe(state: State<'_, AppState>, project_id: String, session_id: Option<String>, message: String) -> Result<jj::JjStatus> {
    let root = state.root(&project_id, session_id.as_deref())?;
    blocking(move || jj::describe(&root, &message)).await
}
#[tauri::command]
async fn jj_new(state: State<'_, AppState>, project_id: String, session_id: Option<String>) -> Result<jj::JjStatus> {
    let root = state.root(&project_id, session_id.as_deref())?;
    blocking(move || jj::new_change(&root)).await
}
#[tauri::command]
async fn jj_commit(state: State<'_, AppState>, project_id: String, session_id: Option<String>, message: String) -> Result<jj::JjStatus> {
    let root = state.root(&project_id, session_id.as_deref())?;
    blocking(move || jj::commit(&root, &message)).await
}
#[tauri::command]
async fn jj_log(state: State<'_, AppState>, project_id: String, session_id: Option<String>, limit: Option<usize>) -> Result<Vec<jj::Change>> {
    let root = state.root(&project_id, session_id.as_deref())?;
    blocking(move || jj::log(&root, limit.unwrap_or(20))).await
}

#[tauri::command]
async fn git_status(
    state: State<'_, AppState>,
    project_id: String,
    session_id: Option<String>,
) -> Result<workspace::GitStatus> {
    let root = state.root(&project_id, session_id.as_deref())?;
    blocking(move || workspace::git_status(&root)).await
}
#[tauri::command]
async fn git_diff(
    state: State<'_, AppState>,
    project_id: String,
    session_id: Option<String>,
    path: Option<String>,
    staged: Option<bool>,
) -> Result<String> {
    let root = state.root(&project_id, session_id.as_deref())?;
    blocking(move || workspace::git_diff(&root, path, staged.unwrap_or(false))).await
}
#[tauri::command]
async fn git_stage(
    state: State<'_, AppState>,
    project_id: String,
    session_id: Option<String>,
    paths: Vec<String>,
    staged: bool,
) -> Result<()> {
    let root = state.root(&project_id, session_id.as_deref())?;
    blocking(move || workspace::git_stage(&root, paths, staged)).await
}
#[tauri::command]
async fn git_commit(
    state: State<'_, AppState>,
    project_id: String,
    session_id: Option<String>,
    message: String,
) -> Result<String> {
    let root = state.root(&project_id, session_id.as_deref())?;
    blocking(move || workspace::git_commit(&root, message)).await
}
fn create_worktree_task(
    store: &Arc<Mutex<Store>>,
    session_id: &str,
    branch: String,
) -> Result<Session> {
    create_worktree_task_with_defaults(store, session_id, branch, None, false, false)
}
fn create_worktree_task_with_defaults(
    store: &Arc<Mutex<Store>>,
    session_id: &str,
    branch: String,
    base: Option<String>,
    existing: bool,
    inherit_defaults: bool,
) -> Result<Session> {
    let (source, root) = {
        let store = store.lock().map_err(|e| e.to_string())?;
        let source = store.session(session_id)?;
        let root = store.workspace_root(&source.project_id, Some(session_id))?;
        (source, root)
    };
    let worktree = workspace::create_worktree_with(&root, &branch, base.as_deref(), existing)?;
    let store = store.lock().map_err(|e| e.to_string())?;
    let transaction = store
        .db
        .unchecked_transaction()
        .map_err(|e| e.to_string())?;
    let created = (|| {
        let mut source = source.clone();
        if inherit_defaults {
            source.mode = storage::DEFAULT_PERMISSION_MODE.into();
        }
        let task = store.create_worktree_session_on(&source, &worktree.path, Some(&worktree.branch))?;
        if inherit_defaults {
            architect::profiles::apply_default(&store, &task.id)?;
        }
        store.session(&task.id)
    })()
    .map_err(|error| {
        format!(
            "Worktree created at {}, but the task could not be saved: {error}",
            worktree.path.display()
        )
    })?;
    transaction.commit().map_err(|e| e.to_string())?;
    Ok(created)
}

#[tauri::command]
async fn create_worktree(
    state: State<'_, AppState>,
    session_id: String,
    branch: String,
    base: Option<String>,
    existing: Option<bool>,
) -> Result<Session> {
    let store = state.store.clone();
    blocking(move || {
        create_worktree_task_with_defaults(&store, &session_id, branch, base, existing.unwrap_or(false), true)
    })
    .await
}

/// Give the current, unstarted task its own checkout instead of a second task.
#[tauri::command]
async fn attach_worktree(
    state: State<'_, AppState>,
    session_id: String,
    branch: String,
    base: Option<String>,
    existing: Option<bool>,
) -> Result<Session> {
    if state.agents.lock().map_err(|e| e.to_string())?.contains_key(&session_id) {
        return Err("Stop the agent before moving this task into a worktree.".into());
    }
    let store = state.store.clone();
    blocking(move || {
        let (source, root) = {
            let store = store.lock().map_err(|e| e.to_string())?;
            if !store.worktree_attachable(&session_id)? {
                return Err("This conversation already started. Create a new task in a worktree instead.".into());
            }
            let source = store.session(&session_id)?;
            let root = store.workspace_root(&source.project_id, Some(&session_id))?;
            (source, root)
        };
        let worktree = workspace::create_worktree_with(&root, &branch, base.as_deref(), existing.unwrap_or(false))?;
        let store = store.lock().map_err(|e| e.to_string())?;
        store.attach_worktree(&source.id, &worktree.path, &worktree.branch).map_err(|error| {
            format!("Worktree created at {}, but the task could not be updated: {error}", worktree.path.display())
        })
    })
    .await
}

/// The main checkout and this task's worktree, or an error when it has none.
fn worktree_paths(store: &Arc<Mutex<Store>>, session_id: &str) -> Result<(PathBuf, PathBuf, Option<String>)> {
    let store = store.lock().map_err(|e| e.to_string())?;
    let task = store.session(session_id)?;
    if let Some(device) = task.remote_device {
        return Err(format!("This task runs on {}.", device.name));
    }
    let worktree = task.worktree_path.ok_or("This task uses the main checkout.")?;
    let main = store.workspace_root(&task.project_id, None)?;
    Ok((main, PathBuf::from(worktree), task.worktree_branch))
}

#[tauri::command]
async fn worktree_status(state: State<'_, AppState>, session_id: String) -> Result<workspace::WorktreeStatus> {
    let store = state.store.clone();
    blocking(move || {
        let (main, path, branch) = worktree_paths(&store, &session_id)?;
        workspace::worktree_status(&main, &path, branch.as_deref())
    })
    .await
}

#[tauri::command]
async fn merge_worktree(state: State<'_, AppState>, session_id: String) -> Result<workspace::WorktreeMerge> {
    if state.agents.lock().map_err(|e| e.to_string())?.contains_key(&session_id) {
        return Err("Wait for the agent to finish before merging its worktree.".into());
    }
    let store = state.store.clone();
    blocking(move || {
        let (main, path, _) = worktree_paths(&store, &session_id)?;
        workspace::merge_worktree(&main, &path)
    })
    .await
}

#[tauri::command]
async fn remove_worktree(
    state: State<'_, AppState>,
    session_id: String,
    delete_branch: Option<bool>,
) -> Result<workspace::WorktreeRemoval> {
    if state.agents.lock().map_err(|e| e.to_string())?.contains_key(&session_id) {
        return Err("Stop the agent before removing its worktree.".into());
    }
    let store = state.store.clone();
    blocking(move || {
        let (main, path, branch) = worktree_paths(&store, &session_id)?;
        workspace::remove_worktree(&main, &path, branch.as_deref(), delete_branch.unwrap_or(false))
    })
    .await
}

#[tauri::command]
async fn recreate_worktree(state: State<'_, AppState>, session_id: String) -> Result<Session> {
    let store = state.store.clone();
    blocking(move || {
        let (main, path, branch) = worktree_paths(&store, &session_id)?;
        workspace::recreate_worktree(&main, &path, branch.as_deref())?;
        store.lock().map_err(|e| e.to_string())?.session(&session_id)
    })
    .await
}

#[tauri::command]
async fn git_branches(
    state: State<'_, AppState>,
    project_id: String,
    session_id: Option<String>,
) -> Result<workspace::BranchList> {
    let root = state.root(&project_id, session_id.as_deref())?;
    blocking(move || workspace::git_branches(&root)).await
}

/// Check out another local branch in the task's own checkout; worktree tasks keep their branch.
#[tauri::command]
async fn git_switch_branch(
    state: State<'_, AppState>,
    project_id: String,
    session_id: Option<String>,
    branch: String,
) -> Result<workspace::BranchList> {
    if let Some(id) = session_id.as_deref() {
        let store = state.store.lock().map_err(|e| e.to_string())?;
        if store.session(id)?.worktree_path.is_some() {
            return Err("This task works in its own worktree; its branch stays as it is.".into());
        }
    }
    let root = state.root(&project_id, session_id.as_deref())?;
    blocking(move || workspace::git_switch(&root, &branch)).await
}

#[tauri::command]
async fn git_push(
    state: State<'_, AppState>,
    project_id: String,
    session_id: Option<String>,
) -> Result<String> {
    let root = state.root(&project_id, session_id.as_deref())?;
    blocking(move || workspace::git_push(&root)).await
}

/// Images from the picker, a drop or a paste join the same PNG registry as browser
/// screenshots, so `send_message` accepts their IDs unchanged.
#[tauri::command]
async fn import_prompt_image(
    app: tauri::AppHandle,
    path: Option<String>,
    data_url: Option<String>,
    name: Option<String>,
) -> Result<prompt_attachments::ImportedImage> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("browser-captures");
    let source = match (path, data_url) {
        (Some(path), _) => prompt_attachments::ImageSource::Path(PathBuf::from(path)),
        (None, Some(data_url)) => prompt_attachments::ImageSource::Data {
            name: name.unwrap_or_default(),
            data_url,
        },
        (None, None) => return Err("Choose an image to attach.".into()),
    };
    blocking(move || prompt_attachments::import_image(&dir, source)).await
}

#[tauri::command]
async fn read_document(path: String) -> Result<prompt_attachments::DocumentText> {
    blocking(move || prompt_attachments::read_document(std::path::Path::new(&path))).await
}

#[tauri::command]
async fn describe_folder(path: String) -> Result<prompt_attachments::FolderSummary> {
    blocking(move || prompt_attachments::describe_folder(std::path::Path::new(&path))).await
}

/// The project's own app icon for its sidebar rows, as a `data:` URL; None shows the default.
#[tauri::command]
async fn project_icon(state: State<'_, AppState>, project_id: String) -> Result<Option<String>> {
    let path = state.store.lock().map_err(|e| e.to_string())?.projects()?.into_iter().find(|project| project.id == project_id).map(|project| project.path).ok_or("This project no longer exists.")?;
    blocking(move || Ok(project_icon::find(std::path::Path::new(&path)))).await
}
#[tauri::command]
async fn github_repos() -> Result<Vec<github_hub::HubRepo>> {
    blocking(github_hub::repos).await
}
#[tauri::command]
async fn github_repo_pulls(repo: String) -> Result<Vec<github_hub::HubPull>> {
    blocking(move || github_hub::pulls(&repo)).await
}
#[tauri::command]
async fn github_repo_issues(repo: String) -> Result<Vec<github_hub::HubIssue>> {
    blocking(move || github_hub::issues(&repo)).await
}
#[tauri::command]
async fn github_repo_runs(repo: String) -> Result<Vec<github_hub::HubRun>> {
    blocking(move || github_hub::runs(&repo)).await
}
#[tauri::command]
async fn github_run_details(repo: String, id: i64) -> Result<github_hub::RunDetails> {
    blocking(move || github_hub::run_details(&repo, id)).await
}
/// Which local projects check out which GitHub repositories, by their `origin` remote.
#[tauri::command]
async fn github_project_repos(state: State<'_, AppState>) -> Result<Vec<github_hub::ProjectRepo>> {
    let projects = state.store.lock().map_err(|e| e.to_string())?.projects()?;
    blocking(move || Ok(projects.into_iter().filter_map(|project| github_hub::project_repo(std::path::Path::new(&project.path)).map(|repo| github_hub::ProjectRepo { project_id: project.id, repo })).collect())).await
}
/// Clones a repository into a folder the user chose and opens it as a project.
#[tauri::command]
async fn github_clone_repo(state: State<'_, AppState>, repo: String, parent: String) -> Result<Project> {
    let destination = blocking(move || github_hub::clone(&repo, std::path::Path::new(&parent))).await?;
    state.store.lock().map_err(|e| e.to_string())?.add_project(&destination)
}

#[tauri::command]
async fn github_status(
    state: State<'_, AppState>,
    project_id: String,
    session_id: Option<String>,
) -> Result<github::GithubStatus> {
    let root = state.root(&project_id, session_id.as_deref())?;
    blocking(move || Ok(github::status(&root))).await
}

#[tauri::command]
async fn github_search(
    state: State<'_, AppState>,
    project_id: String,
    session_id: Option<String>,
    query: String,
) -> Result<Vec<github::Item>> {
    let root = state.root(&project_id, session_id.as_deref())?;
    blocking(move || github::search(&root, &query, 10)).await
}

#[tauri::command]
async fn github_issues(
    state: State<'_, AppState>,
    project_id: String,
    filter: Option<github::IssueFilter>,
) -> Result<Vec<github::Issue>> {
    let root = state.root(&project_id, None)?;
    blocking(move || github::issues(&root, &filter.unwrap_or_default())).await
}

#[tauri::command]
async fn github_resolve(
    state: State<'_, AppState>,
    project_id: String,
    session_id: Option<String>,
    numbers: Vec<i64>,
) -> Result<Vec<github::Reference>> {
    let root = state.root(&project_id, session_id.as_deref())?;
    blocking(move || github::resolve(&root, &numbers)).await
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LinkedTask {
    session_id: String,
    link: storage::TaskLink,
}

/// Refresh every linked issue and pull request of a project in one batch.
#[tauri::command]
async fn github_refresh_links(state: State<'_, AppState>, project_id: String) -> Result<Vec<LinkedTask>> {
    let root = state.root(&project_id, None)?;
    let store = state.store.clone();
    blocking(move || {
        let links = store.lock().map_err(|e| e.to_string())?.project_links(&project_id)?;
        if !links.is_empty() {
            let repo = github::repository(&root).map_err(|error| if error.is_empty() { "This project has no GitHub remote.".to_string() } else { error })?;
            let wanted: Vec<(String, i64)> = links.iter().map(|(_, link)| (link.kind.clone(), link.number)).collect();
            let states: Vec<(String, i64, String, String)> = github::link_states(&root, &repo, &wanted)?
                .into_iter()
                .map(|state| (state.kind, state.number, state.state, state.title))
                .collect();
            store.lock().map_err(|e| e.to_string())?.update_link_states(&project_id, &states)?;
        }
        Ok(store
            .lock()
            .map_err(|e| e.to_string())?
            .project_links(&project_id)?
            .into_iter()
            .map(|(session_id, link)| LinkedTask { session_id, link })
            .collect())
    })
    .await
}

#[tauri::command]
async fn set_task_link(
    state: State<'_, AppState>,
    session_id: String,
    kind: String,
    link: Option<storage::TaskLink>,
) -> Result<Session> {
    state
        .store
        .lock()
        .map_err(|e| e.to_string())?
        .set_task_link(&session_id, &kind, link.as_ref())
}

/// Push the task's branch and open a pull request for it, linking the result.
#[tauri::command]
async fn github_create_pull_request(
    state: State<'_, AppState>,
    session_id: String,
    title: String,
    body: String,
    base: String,
) -> Result<Session> {
    let root = {
        let store = state.store.lock().map_err(|e| e.to_string())?;
        let task = store.session(&session_id)?;
        store.workspace_root(&task.project_id, Some(&session_id))?
    };
    let store = state.store.clone();
    blocking(move || {
        let status = workspace::git_status(&root)?;
        if !status.is_repo {
            return Err("Open a Git repository to create a pull request.".into());
        }
        if !status.files.is_empty() {
            return Err("Commit or stash your changes before opening a pull request. The Changes tab can commit them.".into());
        }
        if status.branch.is_empty() || status.branch == base {
            return Err(format!("Create a branch other than {base} before opening a pull request."));
        }
        workspace::git_push(&root)?;
        let pull = github::create_pull_request(&root, &title, &body, &base, &status.branch)?;
        let link = storage::TaskLink { kind: "pull".into(), number: pull.number, url: pull.url, title: pull.title, state: pull.state, checked_at: 0 };
        store.lock().map_err(|e| e.to_string())?.set_task_link(&session_id, "pull", Some(&link))
    })
    .await
}
/// The task's checkout and its linked pull request number.
fn linked_pull(state: &AppState, session_id: &str) -> Result<(PathBuf, i64)> {
    let store = state.store.lock().map_err(|e| e.to_string())?;
    let task = store.session(session_id)?;
    let number = task.pull_request.as_ref().map(|link| link.number).ok_or("This task has no linked pull request.")?;
    Ok((store.workspace_root(&task.project_id, Some(session_id))?, number))
}

#[tauri::command]
async fn github_pull_request(state: State<'_, AppState>, session_id: String) -> Result<github_pull::PullDetail> {
    let (root, number) = linked_pull(&state, &session_id)?;
    blocking(move || github_pull::detail(&root, number)).await
}

#[tauri::command]
async fn github_pull_request_diff(state: State<'_, AppState>, session_id: String) -> Result<github_pull::PullDiff> {
    let (root, number) = linked_pull(&state, &session_id)?;
    blocking(move || github_pull::diff(&root, number)).await
}

/// Merge the task's linked pull request with the chosen method; returns the task with its link updated.
#[tauri::command]
async fn github_merge_pull_request(state: State<'_, AppState>, session_id: String, method: String) -> Result<Session> {
    let (root, number) = linked_pull(&state, &session_id)?;
    github_pull::merge_flag(&method)?;
    let store = state.store.clone();
    blocking(move || {
        let link = github_pull::merge(&root, number, &method)?;
        store.lock().map_err(|e| e.to_string())?.set_task_link(&session_id, "pull", Some(&link))
    })
    .await
}

/// After a turn, link the pull request the agent opened, if any. Returns the task only when it changed.
#[tauri::command]
async fn github_detect_pull_request(state: State<'_, AppState>, session_id: String) -> Result<Option<Session>> {
    let (root, turn, started) = {
        let store = state.store.lock().map_err(|e| e.to_string())?;
        let task = store.session(&session_id)?;
        // An open link stays: the user or an earlier turn chose it.
        if task.pull_request.as_ref().is_some_and(|link| ["open", "draft"].contains(&link.state.as_str())) {
            return Ok(None);
        }
        let mut turn = Vec::new();
        let mut started = 0;
        for message in store.messages(&session_id, None)? {
            if message.role == "user" {
                started = message.created_at;
                break;
            }
            turn.push(message.content);
        }
        if !turn.iter().any(|text| text.contains("/pull/")) {
            return Ok(None);
        }
        (store.workspace_root(&task.project_id, Some(&session_id))?, turn, started)
    };
    let store = state.store.clone();
    blocking(move || {
        let repo = match github::repository(&root) {
            Ok(repo) => repo,
            Err(error) if error.is_empty() => return Ok(None),
            Err(error) => return Err(error),
        };
        let branch = workspace::git_status(&root).map(|status| status.branch).unwrap_or_default();
        let Some(link) = github_pull::detect(&root, &repo, &turn, &branch, started)? else { return Ok(None) };
        let store = store.lock().map_err(|e| e.to_string())?;
        if store.session(&session_id)?.pull_request.is_some_and(|current| current.number == link.number) {
            return Ok(None);
        }
        store.set_task_link(&session_id, "pull", Some(&link)).map(Some)
    })
    .await
}

/// Link an existing pull request, given as a number or URL, to the task.
#[tauri::command]
async fn github_link_pull_request(state: State<'_, AppState>, session_id: String, reference: String) -> Result<Session> {
    if reference.len() > 512 {
        return Err("Enter a pull request number or its GitHub URL.".into());
    }
    let root = {
        let store = state.store.lock().map_err(|e| e.to_string())?;
        let task = store.session(&session_id)?;
        store.workspace_root(&task.project_id, Some(&session_id))?
    };
    let store = state.store.clone();
    blocking(move || {
        let repo = github::repository(&root).map_err(|error| if error.is_empty() { "This project has no GitHub remote.".to_string() } else { error })?;
        let link = github_pull::lookup(&root, github_pull::parse_reference(&reference, &repo.name_with_owner)?)?;
        store.lock().map_err(|e| e.to_string())?.set_task_link(&session_id, "pull", Some(&link))
    })
    .await
}
#[tauri::command]
async fn list_files(
    state: State<'_, AppState>,
    project_id: String,
    session_id: Option<String>,
    path: Option<String>,
) -> Result<Vec<workspace::FileEntry>> {
    let root = state.root(&project_id, session_id.as_deref())?;
    blocking(move || workspace::list_files(&root, path)).await
}
#[tauri::command]
async fn search_files(
    state: State<'_, AppState>,
    project_id: String,
    session_id: Option<String>,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<workspace::FileEntry>> {
    let root = state.root(&project_id, session_id.as_deref())?;
    blocking(move || workspace::search_files(&root, query, limit)).await
}
#[tauri::command]
async fn search_text(
    state: State<'_, AppState>,
    project_id: String,
    session_id: Option<String>,
    query: String,
    match_case: bool,
    whole_word: bool,
    regex: bool,
) -> Result<workspace::TextSearchResult> {
    let root = state.root(&project_id, session_id.as_deref())?;
    blocking(move || workspace::search_text(&root, &query, match_case, whole_word, regex)).await
}
#[tauri::command]
async fn read_file(
    state: State<'_, AppState>,
    project_id: String,
    session_id: Option<String>,
    path: String,
) -> Result<String> {
    let root = state.root(&project_id, session_id.as_deref())?;
    blocking(move || workspace::read_file(&root, path)).await
}
#[tauri::command]
async fn workspace_image(state: State<'_, AppState>, session_id: String, path: String) -> Result<String> {
    // A question belongs to one task: its images come from that task's checkout only.
    let project_id = state.store.lock().map_err(|e| e.to_string())?.session(&session_id)?.project_id;
    let root = state.root(&project_id, Some(&session_id))?;
    blocking(move || workspace::image_data_url(&root, &path)).await
}
#[tauri::command]
async fn resolve_workspace_files(
    state: State<'_, AppState>,
    project_id: String,
    session_id: Option<String>,
    paths: Vec<String>,
) -> Result<Vec<file_preview::ResolvedFile>> {
    let root = state.root(&project_id, session_id.as_deref())?;
    blocking(move || file_preview::resolve_files(&root, paths)).await
}
#[tauri::command]
async fn prepare_file_preview(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    session_id: Option<String>,
    path: String,
) -> Result<file_preview::FilePreview> {
    if state.shutdown.load(Ordering::SeqCst) != 0 {
        return Err("PandaCode is shutting down.".into());
    }
    let root = state.root(&project_id, session_id.as_deref())?;
    blocking(move || app.state::<file_preview::FilePreviews>().prepare(&root, &path)).await
}
#[tauri::command]
async fn get_run_script(
    state: State<'_, AppState>,
    project_id: String,
    session_id: Option<String>,
) -> Result<Option<run_script::RunScript>> {
    let root = state.root(&project_id, session_id.as_deref())?;
    blocking(move || run_script::inspect(&root)).await
}
/// The task checkout's own fast check, run once at the user's request after a
/// clean turn. Bounded; no plan is a result, not an error.
#[tauri::command]
async fn run_turn_checks(state: State<'_, AppState>, session_id: String) -> Result<serde_json::Value> {
    let project_id = state
        .store
        .lock()
        .map_err(|e| e.to_string())?
        .session(&session_id)?
        .project_id;
    let root = state.root(&project_id, Some(&session_id))?;
    blocking(move || Ok(checks::turn_report(&root))).await
}
#[tauri::command]
async fn get_run_script_preview(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    session_id: Option<String>,
) -> Result<Option<String>> {
    let root = state.root(&project_id, session_id.as_deref())?;
    let inspect_root = root.clone();
    let Some(script) = blocking(move || run_script::inspect(&inspect_root)).await? else {
        return Ok(None);
    };
    if let Some(url) = script.preview_url {
        return Ok(run_script::url_ready(&url).await.then_some(url));
    }
    if let Some(path) = script.preview_path {
        return blocking(move || {
            // Builds may not have produced the file yet. FilePreviews performs
            // containment and type checks before creating an authenticated URL.
            if !root.join(&path).exists() { return Ok(None); }
            app.state::<file_preview::FilePreviews>().prepare(&root, &path).map(|preview| Some(preview.url))
        }).await;
    }
    Ok(None)
}
#[tauri::command]
async fn start_run_script_terminal(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    session_id: Option<String>,
    request_id: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<String> {
    if state.shutdown.load(Ordering::SeqCst) != 0 { return Err("PandaCode is shutting down.".into()); }
    let root = state.root(&project_id, session_id.as_deref())?;
    let terms = state.terminals.clone();
    blocking(move || {
        let state = app.state::<AppState>();
        let _admission = state.agents.lock().map_err(|_| "Agent state is unavailable.")?;
        agent_updates::ensure_not_installing()?;
        if request_id.is_some_and(|id| !agent_tools::agent_ui_request_active(app.state(), id)) {
            return Err("Run request was cancelled before the script could start.".into());
        }
        terminal::start_script(app.clone(), terms, &root, cols, rows)
    }).await
}
#[tauri::command]
async fn start_terminal(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    session_id: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<String> {
    if state.shutdown.load(Ordering::SeqCst) != 0 {
        return Err("PandaCode is shutting down.".into());
    }
    let root = state.root(&project_id, session_id.as_deref())?;
    let terms = state.terminals.clone();
    blocking(move || {
        let state = app.state::<AppState>();
        let _admission = state
            .agents
            .lock()
            .map_err(|_| "Agent state is unavailable.")?;
        agent_updates::ensure_not_installing()?;
        terminal::start(app.clone(), terms, &root, cols, rows)
    })
    .await
}
#[tauri::command]
async fn write_terminal(
    state: State<'_, AppState>,
    terminal_id: String,
    data: String,
) -> Result<()> {
    let terms = state.terminals.clone();
    blocking(move || terminal::write(&terms, &terminal_id, &data)).await
}
#[tauri::command]
async fn resize_terminal(
    state: State<'_, AppState>,
    terminal_id: String,
    cols: u16,
    rows: u16,
) -> Result<()> {
    terminal::resize(&state.terminals, &terminal_id, cols, rows)
}
#[tauri::command]
async fn get_terminal_preferences() -> Result<terminal_preferences::TerminalPreferences> {
    blocking(move || Ok(terminal_preferences::discover())).await
}
#[tauri::command]
async fn get_terminal_activity(
    state: State<'_, AppState>,
    terminal_id: String,
) -> Result<terminal::TerminalActivity> {
    let terms = state.terminals.clone();
    blocking(move || terminal::activity(&terms, &terminal_id)).await
}
#[tauri::command]
async fn close_terminal(state: State<'_, AppState>, terminal_id: String) -> Result<()> {
    terminal::close(&state.terminals, &terminal_id)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Metrics {
    core_rss_bytes: u64,
    active_agents: usize,
    active_terminals: usize,
    database_bytes: u64,
}
#[tauri::command]
async fn get_metrics(state: State<'_, AppState>) -> Result<Metrics> {
    let agents = state.agents.lock().map_err(|e| e.to_string())?.len();
    let terms = state.terminals.lock().map_err(|e| e.to_string())?.len();
    let db = state.store.lock().map_err(|e| e.to_string())?.path.clone();
    blocking(move || {
        #[cfg(unix)]
        let rss = std::process::Command::new("ps")
            .args(["-o", "rss=", "-p", &std::process::id().to_string()])
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .and_then(|s| s.trim().parse::<u64>().ok())
            .unwrap_or(0)
            * 1024;
        #[cfg(windows)]
        let rss = {
            use windows::Win32::System::{ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS}, Threading::GetCurrentProcess};
            let mut counters = PROCESS_MEMORY_COUNTERS::default();
            let size = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
            counters.cb = size;
            if unsafe { GetProcessMemoryInfo(GetCurrentProcess(), &mut counters, size) }.is_ok() {
                counters.WorkingSetSize as u64
            } else { 0 }
        };
        #[cfg(not(any(unix, windows)))]
        let rss = 0;
        let db_bytes = std::fs::metadata(&db).map(|m| m.len()).unwrap_or(0)
            + std::fs::metadata(format!("{}-wal", db.display()))
                .map(|m| m.len())
                .unwrap_or(0);
        Ok(Metrics {
            core_rss_bytes: rss,
            active_agents: agents,
            active_terminals: terms,
            database_bytes: db_bytes,
        })
    })
    .await
}

#[tauri::command]
async fn list_local_servers() -> Result<Vec<local_servers::LocalServer>> {
    local_servers::list().await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// Process-wide setup that must happen before any thread or child process starts.
pub fn prepare_environment() {
    providers::widen_process_path();
}

/// Re-signs the app bundle with the local identity (after an update installs, and before,
/// to wait out the startup pass); a no-op outside a macOS app bundle.
#[tauri::command]
async fn local_sign_app() -> Result<()> {
    tauri::async_runtime::spawn_blocking(local_signing::sign_running_app)
        .await
        .map_err(|e| e.to_string())?
}

pub fn run() {
    // The npx installer signs the fresh bundle this way, before any window exists.
    if std::env::args().skip(1).any(|arg| arg == "--local-sign") {
        std::process::exit(local_signing::cli());
    }
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // Updates come only from GitHub Releases, verified against the public key in tauri.conf.json.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // Covers DMG installs and earlier failures; only ad hoc bundles change, on disk only.
            std::thread::spawn(|| {
                if let Err(error) = local_signing::sign_running_app() {
                    eprintln!("Local signing failed: {error}");
                }
            });
            if let Ok(cache) = app.path().app_cache_dir() {
                turn_changes::cleanup_cache(&cache.join("turn-captures"));
            }
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            secret_store::setup(&dir);
            provider_settings::setup(&dir).map_err(std::io::Error::other)?;
            connections::setup(&dir).map_err(std::io::Error::other)?;
            // Optional integration storage must never prevent the workspace from opening.
            if jev::setup(&dir).is_err() {
                eprintln!("Jev settings are unavailable; browser testing remains disabled.");
            }
            // Retain the database filename and bundle identifier so upgrades reuse existing data.
            let store =
                Store::open(&dir.join("kingcode.sqlite3")).map_err(std::io::Error::other)?;
            if let Err(error) = store.discard_empty_drafts() {
                eprintln!("Could not clear unsent new tasks: {error}");
            }
            app.manage(AppState {
                store: Arc::new(Mutex::new(store)),
                agents: Arc::new(Mutex::new(HashMap::new())),
                terminals: Arc::new(Mutex::new(HashMap::new())),
                shutdown: AtomicU8::new(0),
            });
            cloud_agents::init(app.handle());
            overlay::setup(app.handle(), &dir).map_err(std::io::Error::other)?;
            remote::setup(app.handle(), &dir);
            app.manage(browser::BrowserState::default());
            app.manage(simulator::Simulators::default());
            app.manage(vm::Vms::default());
            vm::watch_idle(app.handle().clone());
            app.manage(file_preview::FilePreviews::default());
            app.manage(agent_tools::UiRequests::default());
            app.manage(architect::Runtime::default());
            architect::watchdog::watch(app.handle().clone());
            bots::start(app.handle());
            if let Err(error) = tray::setup(app.handle()) {
                eprintln!("Menu bar item is unavailable: {error}");
            }
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                    let state = handle.state::<AppState>();
                    if state.shutdown.load(Ordering::SeqCst) != 0 {
                        break;
                    }
                    let archived = state
                        .store
                        .lock()
                        .map_err(|e| e.to_string())
                        .and_then(|store| store.archive_completed(storage::now()));
                    match archived {
                        Ok(count) if count > 0 => {
                            let _ = handle.emit("sessions-changed", ());
                        }
                        Err(error) => eprintln!("Completed task archive failed: {error}"),
                        _ => {}
                    }
                }
            });
            if let Some(window) = app.get_webview_window("main") {
                if let Err(error) = appearance::setup(&window) {
                    eprintln!("Native appearance setup failed: {error}");
                }
            }
            Ok(())
        })
        .invoke_handler(|invoke: tauri::ipc::Invoke<tauri::Wry>| {
            if invoke.message.webview_ref().label() == "launcher" {
                let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
                    overlay::overlay_snapshot,
                    overlay::overlay_thread,
                    overlay::overlay_launch,
                    overlay::overlay_select_model,
                    overlay::overlay_hide,
                    overlay::overlay_open_task,
                    task_controls::fork_session_at_message,
                    task_controls::get_message_content,
                    list_providers,
                    list_provider_models,
                    search_files,
                    open_external_url,
                ];
                return handler(invoke);
            }
            if invoke.message.webview_ref().label() == "tray" {
                let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
                    tray::tray_snapshot,
                    tray::tray_open,
                    tray::tray_refresh_usage,
                    tray::tray_show_app,
                    tray::tray_hide,
                    tray::tray_quit,
                    tray::tray_resize,
                ];
                return handler(invoke);
            }
            if invoke.message.webview_ref().label() != "main" {
                invoke
                    .resolver
                    .reject("Browser content has no application access.");
                return true;
            }
            let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
                support::open_support,
                support::support_details,
                local_sign_app,
                agent_updates::check_agent_updates,
                agent_updates::update_agent,
                moodboards::list_moodboards,
                moodboards::create_moodboard,
                moodboards::read_moodboard,
                moodboards::rename_moodboard,
                moodboards::delete_moodboard,
                moodboards::add_moodboard_image,
                moodboards::import_moodboard_images,
                moodboards::update_moodboard_image,
                moodboards::remove_moodboard_image,
                moodboards::moodboard_image,
                overlay::overlay_preferences,
                overlay::overlay_save_preferences,
                overlay::overlay_recording,
                overlay::overlay_sync_context,
                overlay::overlay_toggle,
                overlay::overlay_hide,
                overlay::overlay_snapshot,
                overlay::overlay_thread,
                overlay::overlay_launch,
                overlay::overlay_select_model,
                overlay::overlay_open_task,
                remote::remote_status,
                remote::remote_sign_in_start,
                remote::remote_sign_in_finish,
                remote::remote_sign_in_cancel,
                remote::remote_sign_out,
                remote::remote_set_host_enabled,
                remote::remote_devices,
                remote::remote_revoke_device,
                remote::remote_set_trusted,
                remote::remote_targets,
                remote::mirror::remote_start_task,
                cloud_agents::tasks::cloud_agent_targets,
                cloud_agents::tasks::cloud_agent_start,
                cloud_agents::tasks::cloud_agent_action,
                cloud_agents::tasks::cloud_agent_set_claude_token,
                remote::mirror::remote_repo_check,
                provider_settings::provider_configuration,
                connections::connections_list,
                connections::connection_save,
                connections::connection_delete,
                connections::connection_assign,
                agent_usage::agent_usage,
                tray::tray_seen,
                usage_ledger::usage_ledger,
                capabilities::capabilities_inventory,
                capabilities::cache_alignment,
                prompt_activity,
                set_resume_at_reset,
                clear_usage_limit,
                discard_draft,
                message_queue::queue_list,
                message_queue::queue_add,
                message_queue::queue_update,
                message_queue::queue_remove,
                message_queue::queue_reorder,
                message_queue::queue_take,
                message_queue::queue_restore,
                message_queue::steer_task,
                bots::bots_list,
                bots::bot_desktop_thread,
                bots::bot_detail,
                bots::bot_create,
                bots::bot_update,
                bots::bot_set_paused,
                bots::bot_reset,
                bots::bot_delete,
                bots::bot_remember,
                bots::bot_forget,
                bots::bot_activity,
                bots::bot_project_ids,
                bots::bot_message,
                bots::schedule::bot_schedule_create,
                bots::schedule::bot_schedule_set_enabled,
                bots::schedule::bot_schedule_delete,
                bots::schedule::bot_run_schedule_now,
                bots::channels::bot_channel_add,
                bots::channels::bot_channel_test,
                bots::channels::bot_channel_configure,
                bots::channels::bot_channel_set_enabled,
                bots::channels::bot_channel_remove,
                bots::channels::bot_pairing_decide,
                bots::channels::bot_web_link,
                bots::channels::bot_web_new_link,
                bots::guard::bot_rule_add,
                bots::guard::bot_rule_delete,
                conversation_import::list_importable_conversations,
                conversation_import::import_conversations,
                provider_settings::provider_set_claude_connection_mode,
                providers::claude_auth::provider_claude_status,
                provider_settings::list_opencode_models,
                provider_settings::save_opencode_models,
                provider_settings::provider_set_executable,
                provider_settings::provider_save_glm_key,
                provider_settings::provider_remove_glm_key,
                provider_settings::provider_save_mimo_key,
                provider_settings::provider_remove_mimo_key,
                provider_settings::provider_save_deepseek_key,
                provider_settings::provider_remove_deepseek_key,
                provider_settings::provider_save_commandcode_key,
                provider_settings::provider_remove_commandcode_key,
                provider_settings::provider_set_mimo_endpoint,
                architect::profiles::architect_profiles,
                architect::profiles::architect_set_lead_guidance,
                architect::profiles::architect_save_profile,
                architect::profiles::architect_delete_profile,
                architect::architect_get,
                architect::architect_configure,
                architect::architect_start,
                architect::architect_control,
                architect::architect_worker_messages,
                architect::coordination::architect_team_messages,
                task_controls::task_goal,
                task_controls::codex_command,
                task_controls::codex_jobs,
                task_controls::set_task_preference,
                task_controls::fork_codex_task,
                task_controls::fork_session_at_message,
                task_controls::get_message_content,
                task_controls::archive_codex_task,
                task_controls::export_task,
                task_controls::save_task_export,
                task_controls::start_harness_terminal,
                list_projects,
                add_project,
                remove_project,
                list_sessions,
                pin_session,
                reorder_sessions,
                get_task,
                configure_window_appearance,
                create_session,
                create_board_task,
                update_task_details,
                set_task_stage,
                start_task,
                configure_session,
                set_reasoning_effort,
                update_session,
                task_deletion::delete_session,
                chats::chat_create,
                chats::chat_cleanup,
                get_messages,
                turn_changes::turn_change_diff,
                turn_changes::turn_change_summary,
                list_subagents,
                send_message,
                list_slash_commands,
                recipes_list,
                recipes_save,
                recipes_delete,
                recipes_dry_run,
                providers::acp::provider_check_connection,
                resolve_slash_command,
                stop_session,
                respond_approval,
                respond_user_input,
                list_agent_integrations,
                list_app_tools,
                open_external_url,
                agent_tools::agent_ui_request_active,
                agent_tools::resolve_agent_ui_action,
                browser::browser_inspect,
                list_providers,
                list_provider_models,
                git_status,
                git_diff,
                jj_status,
                jj_diff,
                jj_describe,
                jj_new,
                jj_commit,
                jj_log,
                git_stage,
                git_commit,
                git_branches,
                git_switch_branch,
                git_push,
                create_worktree,
                attach_worktree,
                worktree_status,
                remove_worktree,
                merge_worktree,
                recreate_worktree,
                github_status,
                github_repos,
                project_icon,
                github_repo_pulls,
                github_repo_issues,
                github_repo_runs,
                github_run_details,
                github_project_repos,
                github_clone_repo,
                github_search,
                github_issues,
                github_resolve,
                github_refresh_links,
                github_create_pull_request,
                github_pull_request,
                github_pull_request_diff,
                github_merge_pull_request,
                github_detect_pull_request,
                github_link_pull_request,
                simulator::commands::simulator_status,
                simulator::commands::simulator_select,
                simulator::commands::simulator_create_duo,
                simulator::commands::simulator_pose,
                simulator::commands::simulator_power,
                simulator::commands::simulator_frame,
                simulator::commands::simulator_input,
                simulator::commands::simulator_appearance,
                simulator::commands::simulator_capture,
                simulator::android_setup::android_setup,
                vm::commands::vm_status,
                vm::commands::vm_show,
                vm::commands::vm_create,
                vm::commands::vm_power,
                vm::commands::vm_frame,
                vm::commands::vm_input,
                vm::commands::vm_desktop,
                vm::setup::vm_setup,
                cloud::commands::cloud_connections,
                cloud::commands::cloud_connect,
                cloud::commands::cloud_disconnect,
                cloud::commands::cloud_setup_sandboxes,
                cloud::commands::cloud_machines,
                cloud::commands::cloud_create,
                cloud::commands::cloud_power,
                cloud::commands::cloud_frame,
                cloud::commands::cloud_input,
                vsix_themes::themes_list,
                vsix_themes::theme_import,
                vsix_themes::theme_install,
                vsix_themes::theme_remove,
                token_saver::token_saver_tools,
                token_saver::token_saver_install,
                skills::skills_list,
                skills::skills_import_folder,
                skills::skills_import_github,
                skills::skills_activate,
                skills::skills_deactivate,
                skills::skills_matrix,
                skills::skills_scan,
                skills::skills_remove,
                set_task_link,
                import_prompt_image,
                read_document,
                describe_folder,
                list_files,
                search_files,
                search_text,
                read_file,
                design::design_list,
                design::design_read,
                design::design_comments,
                design::design_save_comments,
                workspace_image,
                resolve_workspace_files,
                prepare_file_preview,
                get_run_script,
                get_run_script_preview,
                run_turn_checks,
                start_run_script_terminal,
                start_terminal,
                write_terminal,
                resize_terminal,
                close_terminal,
                get_terminal_activity,
                get_terminal_preferences,
                get_metrics,
                list_local_servers,
                jev::jev_configuration,
                jev::jev_save_configuration,
                jev::jev_doctor,
                jev::jev_install_runtime,
                jev::jev_start,
                jev::jev_watch_run,
                jev::jev_cancel,
                jev::jev_list_runs,
                jev::jev_read_run,
                jev_decisions::jev_assist_prepare,
                jev_decisions::jev_assist_run,
                jev_decisions::jev_assist_list,
                jev_decisions::jev_assist_save_rules,
                browser::browser_open,
                browser::browser_bounds,
                browser::browser_action,
                browser::browser_pick,
                browser::browser_capture,
                browser::browser_close
            ];
            handler(invoke)
        })
        .build(tauri::generate_context!())
        .expect("Failed to launch PandaCode");
    app.run(|app, event| {
        if let tauri::RunEvent::ExitRequested { api, .. } = event {
            let state = app.state::<AppState>();
            if state.shutdown.load(Ordering::SeqCst) == 2 {
                return;
            }
            api.prevent_exit();
            if state.shutdown.swap(1, Ordering::SeqCst) == 1 {
                return;
            }
            jev::shutdown();
            app.state::<file_preview::FilePreviews>().shutdown();
            // Cloud runs keep going on their machines; their bridges are killed below.
            let cloud: HashSet<String> = state.store.lock().ok().and_then(|store| cloud_agents::active_runs(&store).ok()).unwrap_or_default().into_iter().collect();
            if let Ok(agents) = state.agents.lock() {
                for (_, tx) in agents.iter().filter(|(id, _)| !cloud.contains(*id)) {
                    let _ = tx.send(RunInput::Stop);
                }
            }
            if let Ok(mut terms) = state.terminals.lock() {
                terms.clear();
            };
            let handle = app.clone();
            let agents = state.agents.clone();
            tauri::async_runtime::spawn(async move {
                let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(12);
                while tokio::time::Instant::now() < deadline {
                    if agents.lock().map(|a| a.keys().all(|id| cloud.contains(id))).unwrap_or(true) {
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                }
                providers::shutdown_all();
                // Let pending pipe EOFs finish persistence after a forced cleanup.
                for _ in 0..20 {
                    if agents.lock().map(|a| a.is_empty()).unwrap_or(true) {
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                }
                handle
                    .state::<AppState>()
                    .shutdown
                    .store(2, Ordering::SeqCst);
                handle.exit(0);
            });
        } else if matches!(event, tauri::RunEvent::Exit) {
            app.state::<file_preview::FilePreviews>().shutdown();
            // VMs PandaCode started release their memory when it quits.
            app.state::<vm::Vms>().shutdown();
            cloud::aws_screen::close(None);
            providers::shutdown_all();
        }
    });
}
