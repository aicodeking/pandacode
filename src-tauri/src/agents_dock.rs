use crate::{reconcile_inactive_task, storage, AppState, RunningAgent};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};
use tauri::{AppHandle, Emitter, Listener, Manager, State};

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum DockStatus {
    Running,
    WaitingForApproval,
    WaitingForInput,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DockAgent {
    pub id: String,
    pub title: String,
    pub project_name: String,
    pub provider: String,
    pub model: String,
    pub status: DockStatus,
    pub elapsed_seconds: u64,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentsDockSnapshot {
    pub agents: Vec<DockAgent>,
}

struct Candidate {
    id: String,
    title: String,
    project_name: String,
    provider: String,
    model: String,
    status: String,
    waiting_for_input: bool,
    waiting_for_approval: bool,
    started_at_ms: i64,
}

fn shape_snapshot(candidates: Vec<Candidate>, now_ms: i64) -> AgentsDockSnapshot {
    let agents = candidates
        .into_iter()
        .filter_map(|candidate| {
            let status = match candidate.status.as_str() {
                "running" => DockStatus::Running,
                "waiting" if candidate.waiting_for_input => DockStatus::WaitingForInput,
                "waiting" if candidate.waiting_for_approval => DockStatus::WaitingForApproval,
                // Waiting with nothing pending (a team between rounds) is still working.
                "waiting" => DockStatus::Running,
                _ => return None,
            };
            Some(DockAgent {
                id: candidate.id,
                title: candidate.title,
                project_name: candidate.project_name,
                provider: candidate.provider,
                model: candidate.model,
                status,
                elapsed_seconds: now_ms.saturating_sub(candidate.started_at_ms).max(0) as u64
                    / 1_000,
            })
        })
        .take(64)
        .collect();
    AgentsDockSnapshot { agents }
}

#[tauri::command]
pub async fn agents_dock_snapshot(state: State<'_, AppState>) -> crate::Result<AgentsDockSnapshot> {
    snapshot(&state)
}

fn snapshot(state: &AppState) -> crate::Result<AgentsDockSnapshot> {
    let agents = state.agents.lock().map_err(|error| error.to_string())?;
    let store = state.store.lock().map_err(|error| error.to_string())?;
    let projects: HashMap<_, _> = store
        .projects()?
        .into_iter()
        .map(|project| (project.id, project.name))
        .collect();
    let candidates = store
        .sessions()?
        .into_iter()
        .map(|task| {
            let task = reconcile_inactive_task(&store, &agents, task);
            let running = agents.get(&task.id);
            Candidate {
                id: task.id,
                title: task.title,
                project_name: projects
                    .get(&task.project_id)
                    .cloned()
                    .unwrap_or_else(|| "Project".into()),
                provider: task.provider,
                model: task.model,
                status: task.status,
                waiting_for_input: running.is_some_and(RunningAgent::waiting_for_input),
                waiting_for_approval: running.is_some_and(|agent| {
                    agent.approvals.lock().is_ok_and(|pending| !pending.is_empty())
                }),
                started_at_ms: running.map_or_else(
                    || task.last_prompt_at.unwrap_or(task.updated_at),
                    |agent| agent.started_at_ms,
                ),
            }
        })
        .collect();
    Ok(shape_snapshot(candidates, storage::now()))
}

const FALLBACK_REFRESH: Duration = Duration::from_secs(15);
const COALESCE: Duration = Duration::from_millis(150);
const MIN_GAP: Duration = Duration::from_millis(500);
const SAVE_POSITION_AFTER: Duration = Duration::from_millis(400);

/// Agent events that can add, remove or change the state of a dock row. Text deltas
/// never wake the dock; tool bursts coalesce and are throttled by `MIN_GAP`.
fn changes_dock(kind: &str) -> bool {
    matches!(
        kind,
        "status"
            | "done"
            | "turn_start"
            | "turn_complete"
            | "approval"
            | "approval_cancelled"
            | "input_request"
            | "input_cancelled"
            | "task_settings"
            // The first activity after an approval or answer: waiting becomes running.
            | "tool"
            | "message_start"
    )
}

pub fn emit_changed(app: &AppHandle) {
    let state = app.state::<AppState>();
    if let Ok(snapshot) = snapshot(&state) {
        let _ = app.emit("agents-dock-changed", snapshot);
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentsDockPreferences {
    pub enabled: bool,
    pub keep_on_screen: bool,
    pub pinned: bool,
    position: Option<Position>,
}
impl Default for AgentsDockPreferences {
    fn default() -> Self {
        Self {
            enabled: true,
            keep_on_screen: true,
            pinned: false,
            position: None,
        }
    }
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
struct Position {
    x: i32,
    y: i32,
}

pub struct DockState {
    path: PathBuf,
    preferences: Mutex<AgentsDockPreferences>,
    /// Bumped on every move; only the last move of a drag writes the file.
    moves: std::sync::atomic::AtomicU64,
}
impl DockState {
    fn save(&self) -> crate::Result<()> {
        let value = self
            .preferences
            .lock()
            .map_err(|error| error.to_string())?
            .clone();
        let bytes = serde_json::to_vec(&value).map_err(|error| error.to_string())?;
        let temporary = self.path.with_extension("json.tmp");
        std::fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
        std::fs::rename(temporary, &self.path).map_err(|error| error.to_string())
    }
    fn set_position(&self, position: Position) {
        if let Ok(mut preferences) = self.preferences.lock() {
            preferences.position = Some(position);
        }
    }
}

pub fn setup(app: &AppHandle, app_data: &Path) -> crate::Result<()> {
    let path = app_data.join("agents-dock.json");
    let preferences: AgentsDockPreferences = std::fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    let pinned = preferences.enabled && preferences.pinned;
    app.manage(DockState {
        path,
        preferences: Mutex::new(preferences),
        moves: std::sync::atomic::AtomicU64::new(0),
    });
    if pinned {
        create_dock_window(app.clone())?;
    }
    // Event-driven: a run starting, ending, or asking for approval/input wakes the
    // emitter; bursts coalesce, and a slow fallback catches anything else (renames).
    // Elapsed time is counted by the windows themselves from the snapshot.
    let wake = std::sync::Arc::new(tokio::sync::Notify::new());
    let listener = wake.clone();
    app.listen_any("agent-event", move |event| {
        #[derive(Deserialize)]
        struct Kind {
            kind: String,
        }
        if serde_json::from_str::<Kind>(event.payload())
            .is_ok_and(|event| changes_dock(&event.kind))
        {
            listener.notify_one();
        }
    });
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let _ = tokio::time::timeout(FALLBACK_REFRESH, wake.notified()).await;
            tokio::time::sleep(COALESCE).await;
            if handle
                .state::<crate::AppState>()
                .shutdown
                .load(std::sync::atomic::Ordering::SeqCst)
                != 0
            {
                break;
            }
            if handle
                .state::<DockState>()
                .preferences
                .lock()
                .is_ok_and(|preferences| preferences.enabled)
            {
                emit_changed(&handle);
            }
            tokio::time::sleep(MIN_GAP - COALESCE).await;
        }
    });
    Ok(())
}

#[tauri::command]
pub async fn agents_dock_preferences(
    state: State<'_, DockState>,
) -> crate::Result<AgentsDockPreferences> {
    state
        .preferences
        .lock()
        .map_err(|error| error.to_string())
        .map(|value| value.clone())
}

#[tauri::command]
pub async fn agents_dock_save_preferences(
    app: AppHandle,
    state: State<'_, DockState>,
    enabled: bool,
    keep_on_screen: bool,
) -> crate::Result<AgentsDockPreferences> {
    {
        let mut preferences = state
            .preferences
            .lock()
            .map_err(|error| error.to_string())?;
        preferences.enabled = enabled;
        preferences.keep_on_screen = keep_on_screen;
        if !enabled {
            preferences.pinned = false;
        }
    }
    state.save()?;
    let value = state
        .preferences
        .lock()
        .map_err(|error| error.to_string())?
        .clone();
    let _ = app.emit("agents-dock-preferences-changed", value.clone());
    if !enabled {
        on_main_thread(app, close_dock_window).await?;
    }
    Ok(value)
}

#[tauri::command]
pub async fn agents_dock_pin(app: AppHandle, state: State<'_, DockState>) -> crate::Result<()> {
    {
        let mut preferences = state
            .preferences
            .lock()
            .map_err(|error| error.to_string())?;
        if !preferences.enabled {
            return Err("Enable the Running agents widget first.".into());
        }
        preferences.pinned = true;
    }
    state.save()?;
    on_main_thread(app, create_dock_window).await
}

#[tauri::command]
pub async fn agents_dock_unpin(app: AppHandle, state: State<'_, DockState>) -> crate::Result<()> {
    state
        .preferences
        .lock()
        .map_err(|error| error.to_string())?
        .pinned = false;
    state.save()?;
    let value = state
        .preferences
        .lock()
        .map_err(|error| error.to_string())?
        .clone();
    let _ = app.emit("agents-dock-preferences-changed", value);
    on_main_thread(app, close_dock_window).await
}

async fn on_main_thread<T: Send + 'static>(
    app: AppHandle,
    operation: impl FnOnce(AppHandle) -> crate::Result<T> + Send + 'static,
) -> crate::Result<T> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let _ = tx.send(operation(handle));
    })
    .map_err(|error| error.to_string())?;
    rx.await.map_err(|error| error.to_string())?
}

fn create_dock_window(app: AppHandle) -> crate::Result<()> {
    if let Some(window) = app.get_webview_window("agents-dock") {
        window.show().map_err(|error| error.to_string())?;
        return Ok(());
    }
    let window = tauri::WebviewWindowBuilder::new(
        &app,
        "agents-dock",
        tauri::WebviewUrl::App("agents-dock.html".into()),
    )
    .title("Running agents")
    .inner_size(92.0, 92.0)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .always_on_top(true)
    .visible_on_all_workspaces(true)
    .skip_taskbar(true)
    .visible(true)
    .on_navigation(|url| {
        let local = (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
            || (url.scheme() == "http" && url.host_str() == Some("tauri.localhost"))
            || (cfg!(debug_assertions)
                && url.scheme() == "http"
                && url.host_str() == Some("127.0.0.1")
                && url.port() == Some(1420));
        local && matches!(url.path(), "/agents-dock.html" | "/")
    })
    .build()
    .map_err(|error| error.to_string())?;
    crate::appearance::setup(&window)?;

    let saved_position = app
        .state::<DockState>()
        .preferences
        .lock()
        .map_err(|error| error.to_string())?
        .position;
    if let Some(position) = saved_position {
        let position = tauri::PhysicalPosition::new(position.x, position.y);
        let position = if app
            .state::<DockState>()
            .preferences
            .lock()
            .is_ok_and(|preferences| preferences.keep_on_screen)
        {
            clamp_position(&app, &window, position).unwrap_or(position)
        } else {
            position
        };
        window
            .set_position(position)
            .map_err(|error| error.to_string())?;
    } else if let Some(monitor) = app.primary_monitor().ok().flatten() {
        let area = monitor.work_area();
        let scale = monitor.scale_factor();
        let edge = (92.0 * scale) as u32;
        window
            .set_position(tauri::PhysicalPosition::new(
                area.position.x
                    + area.size.width.saturating_sub(edge + (24.0 * scale) as u32) as i32,
                area.position.y + (48.0 * scale) as i32,
            ))
            .map_err(|error| error.to_string())?;
    }

    let handle = app.clone();
    let dock_window = window.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::Moved(position) = event {
            let position = if handle
                .state::<DockState>()
                .preferences
                .lock()
                .is_ok_and(|preferences| preferences.keep_on_screen)
            {
                clamp_position(&handle, &dock_window, *position).unwrap_or(*position)
            } else {
                *position
            };
            if let Ok(current) = dock_window.outer_position() {
                if current.x != position.x || current.y != position.y {
                    let _ = dock_window.set_position(position);
                }
            }
            let state = handle.state::<DockState>();
            state.set_position(Position {
                x: position.x,
                y: position.y,
            });
            let generation = state.moves.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
            let saver = handle.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(SAVE_POSITION_AFTER).await;
                let state = saver.state::<DockState>();
                if state.moves.load(std::sync::atomic::Ordering::SeqCst) == generation {
                    let _ = state.save();
                }
            });
        }
    });
    Ok(())
}

fn clamp_position(
    app: &AppHandle,
    window: &tauri::WebviewWindow,
    position: tauri::PhysicalPosition<i32>,
) -> crate::Result<tauri::PhysicalPosition<i32>> {
    let size = window.outer_size().map_err(|error| error.to_string())?;
    let monitor = app
        .monitor_from_point(
            position.x as f64 + size.width as f64 / 2.0,
            position.y as f64 + size.height as f64 / 2.0,
        )
        .ok()
        .flatten()
        .or_else(|| window.current_monitor().ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        return Ok(position);
    };
    let area = monitor.work_area();
    let min_x = area.position.x;
    let min_y = area.position.y;
    let max_x = (area.position.x + area.size.width.saturating_sub(size.width) as i32).max(min_x);
    let max_y = (area.position.y + area.size.height.saturating_sub(size.height) as i32).max(min_y);
    Ok(tauri::PhysicalPosition::new(
        position.x.clamp(min_x, max_x),
        position.y.clamp(min_y, max_y),
    ))
}

fn close_dock_window(app: AppHandle) -> crate::Result<()> {
    if let Some(window) = app.get_webview_window("agents-dock") {
        window.close().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn agents_dock_set_expanded(app: AppHandle, expanded: bool) -> crate::Result<()> {
    on_main_thread(app, move |app| {
        let Some(window) = app.get_webview_window("agents-dock") else {
            return Ok(());
        };
        let (width, height) = if expanded {
            (360.0, 430.0)
        } else {
            (92.0, 92.0)
        };
        window
            .set_size(tauri::LogicalSize::new(width, height))
            .map_err(|error| error.to_string())?;
        let keep_on_screen = app
            .state::<DockState>()
            .preferences
            .lock()
            .map_err(|error| error.to_string())?
            .keep_on_screen;
        if keep_on_screen {
            let position = window.outer_position().map_err(|error| error.to_string())?;
            let point = clamp_position(&app, &window, position)?;
            window
                .set_position(point)
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn agents_dock_open_task(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
) -> crate::Result<()> {
    {
        let store = state.store.lock().map_err(|error| error.to_string())?;
        store.session(&session_id)?;
    }
    on_main_thread(app, move |app| {
        let main = app
            .get_webview_window("main")
            .ok_or("Workspace window is unavailable.")?;
        main.show().map_err(|error| error.to_string())?;
        main.set_focus().map_err(|error| error.to_string())?;
        main.emit(
            "overlay-open-task",
            serde_json::json!({ "sessionId": session_id }),
        )
        .map_err(|error| error.to_string())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::{changes_dock, shape_snapshot, Candidate, DockStatus};

    #[test]
    fn only_state_changes_wake_the_dock() {
        assert!(changes_dock("status"));
        assert!(changes_dock("done"));
        assert!(changes_dock("input_request"));
        assert!(!changes_dock("delta"));
        assert!(changes_dock("tool"));
        assert!(!changes_dock("thinking"));
    }

    #[test]
    fn snapshot_shapes_live_runs_and_omits_inactive_sessions() {
        let snapshot = shape_snapshot(
            vec![
                Candidate {
                    id: "task-running".into(),
                    title: "Polish onboarding".into(),
                    project_name: "PandaCode".into(),
                    provider: "codex".into(),
                    model: "gpt-5.6-sol".into(),
                    status: "running".into(),
                    waiting_for_input: false,
                    waiting_for_approval: false,
                    started_at_ms: 4_000,
                },
                Candidate {
                    id: "task-approval".into(),
                    title: "Build gallery".into(),
                    project_name: "Gallery".into(),
                    provider: "claude".into(),
                    model: "sonnet".into(),
                    status: "waiting".into(),
                    waiting_for_input: false,
                    waiting_for_approval: true,
                    started_at_ms: 1_000,
                },
                Candidate {
                    id: "task-input".into(),
                    title: "Review copy".into(),
                    project_name: "Website".into(),
                    provider: "pi".into(),
                    model: "anthropic/sonnet".into(),
                    status: "waiting".into(),
                    waiting_for_input: true,
                    waiting_for_approval: false,
                    started_at_ms: 9_500,
                },
                Candidate {
                    id: "task-idle".into(),
                    title: "Finished".into(),
                    project_name: "PandaCode".into(),
                    provider: "codex".into(),
                    model: "default".into(),
                    status: "idle".into(),
                    waiting_for_input: false,
                    waiting_for_approval: false,
                    started_at_ms: 0,
                },
            ],
            12_000,
        );

        assert_eq!(snapshot.agents.len(), 3);
        assert_eq!(snapshot.agents[0].id, "task-running");
        assert_eq!(snapshot.agents[0].status, DockStatus::Running);
        assert_eq!(snapshot.agents[0].elapsed_seconds, 8);
        assert_eq!(snapshot.agents[1].status, DockStatus::WaitingForApproval);
        assert_eq!(snapshot.agents[2].status, DockStatus::WaitingForInput);
        assert!(!snapshot.agents.iter().any(|agent| agent.id == "task-idle"));
    }
}
