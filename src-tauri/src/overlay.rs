//! A lazy launcher with a bounded, read-only view of the selected live thread.
use crate::architect::profiles::ModelSelection;
use crate::{storage, AppState, Result};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex,
    },
};
use tauri::{Emitter, Manager, State};
use tauri_plugin_global_shortcut::{GlobalShortcut, Shortcut, ShortcutState};

const LABEL: &str = "launcher";
const DEFAULT_SHORTCUT: &str = "CommandOrControl+Shift+Space";

fn shortcut_backend_notice(available: bool, wayland: bool) -> Option<String> {
    if !available {
        Some(if cfg!(target_os = "linux") || wayland {
            "Global shortcuts are unavailable. Linux shortcuts require X11; Wayland support depends on your desktop. Use Open in Quick launcher settings."
        } else {
            "Global shortcuts are unavailable. Use Open in Quick launcher settings."
        }.into())
    } else if wayland {
        Some("Linux shortcuts use X11 and may not work outside XWayland apps. Use Open in Quick launcher settings if your desktop does not support them.".into())
    } else {
        None
    }
}

fn shortcut_backend(app: &tauri::AppHandle) -> Result<State<'_, GlobalShortcut<tauri::Wry>>> {
    // GlobalShortcutExt::global_shortcut uses state(), which panics when the
    // optional backend could not initialize (for example, on native Wayland).
    app.try_state::<GlobalShortcut<tauri::Wry>>()
        .ok_or_else(|| shortcut_backend_notice(false, false).unwrap())
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LaunchContext {
    pub project_id: Option<String>,
    pub provider: String,
    pub model: String,
    #[serde(default = "default_launch_mode")]
    pub mode: String,
    #[serde(default)]
    pub reasoning_effort: Option<String>,
}
fn default_launch_mode() -> String {
    storage::DEFAULT_PERMISSION_MODE.into()
}
impl Default for LaunchContext {
    fn default() -> Self {
        Self {
            project_id: None,
            provider: "codex".into(),
            model: "default".into(),
            mode: default_launch_mode(),
            reasoning_effort: None,
        }
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preferences {
    pub enabled: bool,
    pub shortcut: String,
    #[serde(default)]
    pub context: LaunchContext,
    #[serde(default)]
    pub model_selection: Option<ModelSelection>,
    #[serde(skip_deserializing)]
    pub error: Option<String>,
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            enabled: true,
            shortcut: DEFAULT_SHORTCUT.into(),
            context: LaunchContext::default(),
            model_selection: None,
            error: None,
        }
    }
}
impl Preferences {
    fn effective_context(&self) -> LaunchContext {
        let mut context = self.context.clone();
        if let Some(selection) = &self.model_selection {
            context.provider = selection.provider.clone();
            context.model = selection.model.clone();
            context.reasoning_effort = selection.reasoning_effort.clone();
        }
        context
    }
}
struct Inner {
    preferences: Preferences,
    registered: Option<Shortcut>,
}
pub struct OverlayState {
    path: PathBuf,
    inner: Mutex<Inner>,
    launching: AtomicBool,
    recording_epoch: AtomicU64,
    shortcut_notice: Option<String>,
}
struct LaunchGuard<'a>(&'a AtomicBool);
impl Drop for LaunchGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

fn parse_shortcut(value: &str) -> Result<Shortcut> {
    if value.len() > 100 || !value.is_ascii() {
        return Err("Choose a standard keyboard shortcut.".into());
    }
    let shortcut: Shortcut = value
        .parse()
        .map_err(|_| "Use a shortcut such as CommandOrControl+Shift+Space.".to_string())?;
    if shortcut.mods.is_empty() {
        return Err("Include Command, Control, Option, or Shift in the shortcut.".into());
    }
    Ok(shortcut)
}
fn desired_binding(enabled: bool, shortcut: &str) -> Result<Option<Shortcut>> {
    // Disabling must remain possible even when a saved shortcut is invalid.
    enabled.then(|| parse_shortcut(shortcut)).transpose()
}
fn validate_context(context: &LaunchContext) -> Result<()> {
    if !storage::valid_permission_mode(&context.mode)
        || context.provider.is_empty()
        || context.provider.len() > 50
        || context.model.is_empty()
        || context.model.len() > 256
        || context.project_id.as_ref().is_some_and(|id| id.len() > 100)
        || context
            .reasoning_effort
            .as_ref()
            .is_some_and(|effort| effort.len() > 40)
    {
        return Err("Invalid launcher task settings.".into());
    }
    Ok(())
}
fn validate_selection(selection: &ModelSelection) -> Result<()> {
    if ![
        "claude",
        "codex",
        "kimi",
        "opencode",
        "glm",
        "antigravity",
        "grok",
        "mimo",
        "pi",
        "deepseek",
        "commandcode",
        "cline",
        "kilo",
        "omp",
        "github-copilot",
        "muse",
    ]
    .contains(&selection.provider.as_str())
        || selection.model.trim().is_empty()
        || selection.model.len() > 200
        || selection.model.chars().any(char::is_control)
    {
        return Err("Choose a supported harness and a model ID under 200 bytes.".into());
    }
    crate::providers::validate_reasoning_effort(
        &selection.provider,
        selection.reasoning_effort.as_deref(),
    )
}
fn persist(path: &Path, preferences: &Preferences) -> Result<()> {
    let temporary = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec(preferences).map_err(|e| e.to_string())?;
    std::fs::write(&temporary, bytes)
        .map_err(|e| format!("Could not save launcher settings: {e}"))?;
    std::fs::rename(&temporary, path).map_err(|e| format!("Could not save launcher settings: {e}"))
}

/// Registration is transactional: keep the old shortcut if the new one is busy,
/// and undo a new registration if persistence fails.
fn change_registration(
    old: Option<Shortcut>,
    next: Option<Shortcut>,
    mut register: impl FnMut(Shortcut) -> Result<()>,
    mut unregister: impl FnMut(Shortcut) -> Result<()>,
    save: impl FnOnce() -> Result<()>,
) -> Result<()> {
    if old == next {
        return save();
    }
    if let Some(shortcut) = next {
        register(shortcut)?;
    }
    if let Err(error) = save() {
        if let Some(shortcut) = next {
            let _ = unregister(shortcut);
        }
        return Err(error);
    }
    if let Some(shortcut) = old {
        // This cannot normally fail for our own registered shortcut. Surface it
        // rather than silently retaining two global bindings.
        if let Err(error) = unregister(shortcut) {
            if let Some(shortcut) = next {
                let _ = unregister(shortcut);
            }
            return Err(error);
        }
    }
    Ok(())
}

pub fn setup(app: &tauri::AppHandle, dir: &Path) -> Result<()> {
    let path = dir.join("overlay.json");
    let mut preferences = match std::fs::read(&path) {
        Ok(bytes) => {
            serde_json::from_slice::<Preferences>(&bytes).unwrap_or_else(|_| Preferences {
                error: Some("Launcher settings could not be read; defaults were restored.".into()),
                ..Preferences::default()
            })
        }
        Err(_) => Preferences::default(),
    };
    if validate_context(&preferences.context).is_err() {
        preferences.context = LaunchContext::default();
    }
    if preferences
        .model_selection
        .as_ref()
        .is_some_and(|selection| validate_selection(selection).is_err())
    {
        preferences.model_selection = None;
    }
    let backend_initialized = app
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    let Some(state) = app.try_state::<OverlayState>() else {
                        return;
                    };
                    // Registration changes marshal work to the main thread. Never block
                    // that thread on the preferences lock while one is in progress.
                    let selected = state
                        .inner
                        .try_lock()
                        .ok()
                        .and_then(|inner| inner.registered);
                    if selected.as_ref() != Some(shortcut) {
                        return;
                    }
                    let handle = app.clone();
                    let _ = app.run_on_main_thread(move || {
                        if let Err(error) = toggle(&handle) {
                            eprintln!("Could not open launcher: {error}");
                        }
                    });
                })
                .build(),
        )
        .is_ok();
    let wayland = cfg!(target_os = "linux")
        && (std::env::var_os("WAYLAND_DISPLAY").is_some()
            || std::env::var("XDG_SESSION_TYPE").is_ok_and(|value| value == "wayland"));
    let shortcut_notice = shortcut_backend_notice(
        backend_initialized && shortcut_backend(app).is_ok(),
        wayland,
    );
    if let Some(notice) = &shortcut_notice {
        preferences.error = Some(notice.clone());
    }
    let registered = if preferences.enabled {
        match parse_shortcut(&preferences.shortcut).and_then(|shortcut| {
            shortcut_backend(app)?
                .register(shortcut)
                .map_err(|e| format!("Shortcut unavailable: {e}. Choose another in Settings."))?;
            Ok(shortcut)
        }) {
            Ok(shortcut) => Some(shortcut),
            Err(error) => {
                preferences.error = Some(error);
                None
            }
        }
    } else {
        None
    };
    app.manage(OverlayState {
        path,
        inner: Mutex::new(Inner {
            preferences,
            registered,
        }),
        launching: AtomicBool::new(false),
        recording_epoch: AtomicU64::new(0),
        shortcut_notice,
    });
    Ok(())
}

#[tauri::command]
pub async fn overlay_preferences(state: State<'_, OverlayState>) -> Result<Preferences> {
    Ok(state
        .inner
        .lock()
        .map_err(|e| e.to_string())?
        .preferences
        .clone())
}
#[tauri::command]
pub async fn overlay_save_preferences(
    app: tauri::AppHandle,
    state: State<'_, OverlayState>,
    enabled: bool,
    shortcut: String,
) -> Result<Preferences> {
    let binding = desired_binding(enabled, shortcut.trim())?;
    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
    let next = Preferences {
        enabled,
        shortcut: shortcut.trim().to_string(),
        error: state.shortcut_notice.clone(),
        context: inner.preferences.context.clone(),
        model_selection: inner.preferences.model_selection.clone(),
    };
    let result = change_registration(
        inner.registered,
        binding,
        |key| {
            shortcut_backend(&app)?.register(key).map_err(|e| {
                format!("That shortcut is unavailable. Your previous shortcut is unchanged. {e}")
            })
        },
        |key| {
            shortcut_backend(&app)?
                .unregister(key)
                .map_err(|e| e.to_string())
        },
        || persist(&state.path, &next),
    );
    if let Err(error) = result {
        // Also roll back the saved file if releasing the old native binding failed.
        let _ = persist(&state.path, &inner.preferences);
        return Err(error);
    }
    inner.preferences = next.clone();
    inner.registered = binding;
    drop(inner);
    if !enabled {
        hide(&app)?;
    }
    Ok(next)
}
#[tauri::command]
pub async fn overlay_recording(
    app: tauri::AppHandle,
    state: State<'_, OverlayState>,
    active: bool,
) -> Result<()> {
    let epoch = state.recording_epoch.fetch_add(1, Ordering::AcqRel) + 1;
    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
    let backend = shortcut_backend(&app).inspect_err(|error| {
        inner.preferences.error = Some(error.clone());
    })?;
    if active {
        if let Some(key) = inner.registered {
            backend.unregister(key).map_err(|e| e.to_string())?;
            inner.registered = None;
        }
        // Restore even if a reload or crashed webview loses its cleanup hook.
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
            let state = handle.state::<OverlayState>();
            if state.recording_epoch.load(Ordering::Acquire) != epoch {
                return;
            }
            if let Ok(mut inner) = state.inner.lock() {
                if inner.registered.is_none() && inner.preferences.enabled {
                    match parse_shortcut(&inner.preferences.shortcut).and_then(|key| {
                        shortcut_backend(&handle)?
                            .register(key)
                            .map_err(|e| e.to_string())?;
                        Ok(key)
                    }) {
                        Ok(key) => {
                            inner.registered = Some(key);
                            inner.preferences.error = state.shortcut_notice.clone();
                        }
                        Err(error) => inner.preferences.error = Some(error),
                    }
                }
            };
        });
    } else if inner.registered.is_none() && inner.preferences.enabled {
        let key = parse_shortcut(&inner.preferences.shortcut)?;
        if let Err(error) = backend.register(key) {
            let error = format!("Could not restore launcher shortcut: {error}");
            inner.preferences.error = Some(error.clone());
            return Err(error);
        }
        inner.registered = Some(key);
        inner.preferences.error = state.shortcut_notice.clone();
    }
    Ok(())
}
#[tauri::command]
pub async fn overlay_sync_context(
    state: State<'_, OverlayState>,
    context: LaunchContext,
) -> Result<()> {
    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
    sync_context(&state.path, &mut inner.preferences, context)
}
fn sync_context(path: &Path, preferences: &mut Preferences, context: LaunchContext) -> Result<()> {
    validate_context(&context)?;
    if preferences.context == context {
        return Ok(());
    }
    let mut next = preferences.clone();
    next.context = context;
    persist(path, &next)?;
    *preferences = next;
    Ok(())
}

#[tauri::command]
pub async fn overlay_select_model(
    state: State<'_, OverlayState>,
    provider: String,
    model: String,
    reasoning_effort: Option<String>,
) -> Result<LaunchContext> {
    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
    select_model(
        &state.path,
        &mut inner.preferences,
        provider,
        model,
        reasoning_effort,
    )
}
fn select_model(
    path: &Path,
    preferences: &mut Preferences,
    provider: String,
    model: String,
    reasoning_effort: Option<String>,
) -> Result<LaunchContext> {
    let current = preferences.effective_context();
    let model = model.trim().to_string();
    let same_model = provider == current.provider && model == current.model;
    let selection = ModelSelection {
        provider,
        model,
        reasoning_effort: if same_model { reasoning_effort } else { None },
    };
    validate_selection(&selection)?;
    let mut next = preferences.clone();
    next.model_selection = Some(selection);
    // A failed disk write must leave both the visible selection and next launch unchanged.
    persist(path, &next)?;
    *preferences = next;
    Ok(preferences.effective_context())
}
fn hide(app: &tauri::AppHandle) -> Result<()> {
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.emit("overlay-visibility", false);
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}
#[tauri::command]
pub fn overlay_hide(app: tauri::AppHandle) -> Result<()> {
    hide(&app)
}
fn toggle(app: &tauri::AppHandle) -> Result<()> {
    if let Some(window) = app.get_webview_window(LABEL) {
        if window.is_visible().unwrap_or(false) {
            return hide(app);
        }
        position_near_cursor(app, &window);
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        let _ = window.emit("overlay-visibility", true);
        return Ok(());
    }
    let window = tauri::WebviewWindowBuilder::new(
        app,
        LABEL,
        tauri::WebviewUrl::App("index.html?view=launcher".into()),
    )
    .title("PandaCode launcher")
    .inner_size(650.0, 510.0)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .shadow(true)
    .always_on_top(true)
    .visible_on_all_workspaces(true)
    .skip_taskbar(true)
    .visible(false)
    .on_navigation(|url| {
        let local = (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
            || (url.scheme() == "http" && url.host_str() == Some("tauri.localhost"))
            || (cfg!(debug_assertions)
                && url.scheme() == "http"
                && url.host_str() == Some("127.0.0.1")
                && url.port() == Some(1420));
        local && matches!(url.path(), "/index.html" | "/")
    })
    .build()
    .map_err(|e| e.to_string())?;
    crate::appearance::setup(&window)?;
    let handle = app.clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Focused(false)) {
            let _ = hide(&handle);
        }
    });
    position_near_cursor(app, &window);
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())?;
    Ok(())
}
fn position_near_cursor(app: &tauri::AppHandle, window: &tauri::WebviewWindow) {
    let monitor = app
        .cursor_position()
        .ok()
        .and_then(|p| app.monitor_from_point(p.x, p.y).ok().flatten())
        .or_else(|| window.current_monitor().ok().flatten());
    if let Some(monitor) = monitor {
        let area = monitor.work_area();
        let scale = monitor.scale_factor();
        let width = (650.0 * scale).min(area.size.width as f64);
        let height = (510.0 * scale).min(area.size.height as f64);
        let _ = window.set_size(tauri::PhysicalSize::new(width as u32, height as u32));
        let _ = window.set_position(tauri::PhysicalPosition::new(
            area.position.x as f64 + (area.size.width as f64 - width) / 2.0,
            area.position.y as f64 + (area.size.height as f64 - height) / 3.0,
        ));
    } else {
        let _ = window.center();
    }
}
#[tauri::command]
pub async fn overlay_toggle(app: tauri::AppHandle) -> Result<()> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let _ = tx.send(toggle(&handle));
    })
    .map_err(|e| e.to_string())?;
    rx.await.map_err(|e| e.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskSummary {
    id: String,
    session_id: String,
    kind: &'static str,
    title: String,
    project_id: String,
    project_name: String,
    provider: String,
    status: String,
    updated_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    parent_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    worker_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    subagent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    parent_title: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    tasks: Vec<TaskSummary>,
    projects: Vec<storage::Project>,
    context: LaunchContext,
    active_count: usize,
    team_worker_count: usize,
}

fn launch_preview(
    store: &storage::Store,
    preferences: &Preferences,
) -> Result<(LaunchContext, usize)> {
    let mut context = preferences.effective_context();
    let library = crate::architect::profiles::read(store)?;
    if !library.enabled {
        return Ok((context, 0));
    }
    let setup = library
        .last_setup
        .ok_or("The saved default team setup is missing.")?;
    // New launcher tasks inherit this architect unless a launcher selection
    // explicitly overrides it. The current main-window task may use another model.
    if preferences.model_selection.is_none() {
        context.provider = setup.architect.provider;
        context.model = setup.architect.model;
        context.reasoning_effort = setup.architect.reasoning_effort;
    }
    Ok((context, setup.config.workers.len()))
}
#[derive(Default)]
struct LiveTask {
    waiting: bool,
    children: Vec<crate::subagent_state::ActiveSummary>,
}
fn live_tasks(
    agents: &std::collections::HashMap<String, crate::RunningAgent>,
) -> Result<std::collections::HashMap<String, LiveTask>> {
    let mut live = std::collections::HashMap::new();
    for (sid, agent) in agents {
        if agent.stopped.load(Ordering::Acquire) {
            continue;
        }
        let waiting = !agent
            .approvals
            .lock()
            .map_err(|e| e.to_string())?
            .is_empty();
        let children = agent
            .subagents
            .lock()
            .map_err(|e| e.to_string())?
            .active_summaries();
        live.insert(sid.clone(), LiveTask { waiting, children });
    }
    Ok(live)
}
fn summaries(
    store: &storage::Store,
    live: &std::collections::HashMap<String, LiveTask>,
) -> Result<Vec<TaskSummary>> {
    if live.is_empty() {
        return Ok(Vec::new());
    }
    // Only in-memory runs establish liveness. An architect waiting for a live
    // worker remains visible; a saved "running" team after restart does not.
    // SQLite extracts only labels from team JSON, never whole assignments/results.
    let ids = serde_json::to_string(&live.keys().collect::<Vec<_>>()).map_err(|e| e.to_string())?;
    let mut stmt = store.db.prepare("WITH live(id) AS (SELECT value FROM json_each(?1)),
      parents(id) AS (SELECT DISTINCT aw.parent_session_id FROM architect_workers aw JOIN live ON live.id=aw.session_id JOIN architect_teams t ON t.session_id=aw.parent_session_id WHERE json_extract(t.content,'$.status') IN ('running','waiting'))
      SELECT s.id,substr(COALESCE((SELECT json_extract(w.value,'$.name') FROM json_each(t.content,'$.workers') w WHERE json_extract(w.value,'$.id')=aw.worker_id LIMIT 1),s.title),1,160),s.project_id,substr(p.name,1,120),s.provider,s.updated_at,aw.parent_session_id,aw.worker_id,substr(parent.title,1,160)
      FROM sessions s JOIN projects p ON p.id=s.project_id
      LEFT JOIN architect_workers aw ON aw.session_id=s.id
      LEFT JOIN sessions parent ON parent.id=aw.parent_session_id
      LEFT JOIN architect_teams t ON t.session_id=aw.parent_session_id
      WHERE s.id IN (SELECT id FROM live) OR s.id IN (SELECT id FROM parents)
      ORDER BY s.created_at,s.id").map_err(|e| e.to_string())?;
    let owners = stmt
        .query_map([ids], |r| {
            let id: String = r.get(0)?;
            let parent_session_id: Option<String> = r.get(6)?;
            Ok(TaskSummary {
                session_id: id.clone(),
                kind: if parent_session_id.is_some() {
                    "worker"
                } else {
                    "task"
                },
                status: match live.get(&id) {
                    Some(task) if task.waiting => "waiting",
                    Some(_) => "running",
                    None => "coordinating",
                }
                .into(),
                id,
                title: r.get(1)?,
                project_id: r.get(2)?,
                project_name: r.get(3)?,
                provider: r.get(4)?,
                updated_at: r.get(5)?,
                parent_session_id,
                worker_id: r.get(7)?,
                subagent_id: None,
                parent_title: r.get(8)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let mut tasks = Vec::new();
    for owner in owners {
        let children = live
            .get(&owner.session_id)
            .map(|run| run.children.as_slice())
            .unwrap_or(&[]);
        let child_rows: Vec<_> = children
            .iter()
            .map(|child| TaskSummary {
                id: format!("subagent:{}:{}", owner.session_id, child.id),
                session_id: owner.session_id.clone(),
                kind: "subagent",
                title: child.name.clone(),
                project_id: owner.project_id.clone(),
                project_name: owner.project_name.clone(),
                provider: owner.provider.clone(),
                status: child.status.clone(),
                updated_at: child.updated_at,
                parent_session_id: owner.parent_session_id.clone(),
                worker_id: owner.worker_id.clone(),
                subagent_id: Some(child.id.clone()),
                parent_title: Some(owner.title.clone()),
            })
            .collect();
        tasks.push(owner);
        tasks.extend(child_rows);
    }
    Ok(tasks)
}
#[tauri::command]
pub async fn overlay_snapshot(
    state: State<'_, AppState>,
    overlay: State<'_, OverlayState>,
) -> Result<Snapshot> {
    let preferences = overlay
        .inner
        .lock()
        .map_err(|e| e.to_string())?
        .preferences
        .clone();
    // Registry -> child snapshot -> store, matching stream settlement. Child
    // responses/tools stay in their run's memory and are not cloned for polling.
    let agents = state.agents.lock().map_err(|e| e.to_string())?;
    let live = live_tasks(&agents)?;
    let store = state.store.lock().map_err(|e| e.to_string())?;
    let (mut context, team_worker_count) = launch_preview(&store, &preferences)?;
    let tasks = summaries(&store, &live)?;
    let mut projects = store.projects()?;
    projects.truncate(100);
    if !projects
        .iter()
        .any(|p| Some(&p.id) == context.project_id.as_ref())
    {
        context.project_id = tasks
            .first()
            .map(|t| t.project_id.clone())
            .or_else(|| projects.first().map(|p| p.id.clone()));
    }
    let active_count = tasks.len();
    Ok(Snapshot {
        tasks,
        projects,
        context,
        active_count,
        team_worker_count,
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSnapshot {
    messages: Vec<storage::Message>,
    has_older: bool,
    live_text: String,
    status: String,
    provider: String,
    subagent: Option<crate::providers::SubagentActivity>,
    history_version: u64,
    history_unchanged: bool,
}

fn thread_snapshot(
    state: &AppState,
    session_id: &str,
    subagent_id: Option<&str>,
    before_id: Option<i64>,
    history_version: Option<u64>,
) -> Result<ThreadSnapshot> {
    use rusqlite::OptionalExtension;
    if session_id.len() > 100
        || subagent_id.is_some_and(|id| id.len() > 1024)
        || before_id.is_some_and(|id| id <= 0)
    {
        return Err("Invalid conversation reference.".into());
    }
    // Keep the registry stable through the read so run settlement cannot move
    // text from memory to history between our two snapshots. Approval/child
    // locks precede the store; the store precedes the assistant buffer, matching
    // the writer. Never hold the assistant lock while waiting for the store.
    let agents = state.agents.lock().map_err(|e| e.to_string())?;
    let agent = agents.get(session_id);
    let running = agent.is_some_and(|agent| !agent.stopped.load(Ordering::Acquire));
    let waiting = if let Some(agent) = agent.filter(|_| running) {
        !agent
            .approvals
            .lock()
            .map_err(|e| e.to_string())?
            .is_empty()
    } else {
        false
    };
    let child = if let (Some(id), Some(agent)) = (subagent_id, agent) {
        agent.subagents.lock().map_err(|e| e.to_string())?.get(id)
    } else {
        None
    };
    let store = state.store.lock().map_err(|e| e.to_string())?;
    let session = store.session(session_id)?;
    let version = store.db.total_changes();
    if let Some(id) = subagent_id {
        let mut child = match child {
            Some(child) => child,
            None => {
                let content: Option<String> = store
                    .db
                    .query_row(
                        "SELECT content FROM subagents WHERE session_id=?1 AND id=?2",
                        rusqlite::params![session_id, id],
                        |row| row.get(0),
                    )
                    .optional()
                    .map_err(|e| e.to_string())?;
                serde_json::from_str::<crate::providers::SubagentActivity>(
                    &content.ok_or("This subagent does not belong to the selected task.")?,
                )
                .map_err(|e| e.to_string())?
            }
        };
        if !running && matches!(child.status.as_str(), "running" | "waiting") {
            child.status = "stopped".into();
        }
        return Ok(ThreadSnapshot {
            messages: Vec::new(),
            has_older: false,
            live_text: String::new(),
            status: child.status.clone(),
            provider: session.provider,
            subagent: Some(child),
            history_version: version,
            history_unchanged: false,
        });
    }

    let status = if running {
        if waiting {
            "waiting".into()
        } else {
            "running".into()
        }
    } else {
        // The architect can remain active between review turns while its
        // workers are running. Stored team status alone never implies liveness.
        let live_ids = serde_json::to_string(
            &agents
                .iter()
                .filter(|(_, agent)| !agent.stopped.load(Ordering::Acquire))
                .map(|(id, _)| id)
                .collect::<Vec<_>>(),
        )
        .map_err(|e| e.to_string())?;
        let coordinating: bool = store.db.query_row(
            "SELECT EXISTS(SELECT 1 FROM architect_workers w JOIN architect_teams t ON t.session_id=w.parent_session_id WHERE w.parent_session_id=?1 AND w.session_id IN (SELECT value FROM json_each(?2)) AND json_extract(t.content,'$.status') IN ('running','waiting'))",
            rusqlite::params![session_id, live_ids], |row| row.get(0),
        ).map_err(|e| e.to_string())?;
        if coordinating {
            "coordinating".into()
        } else if agent.is_some() {
            "stopped".into()
        } else if matches!(session.status.as_str(), "running" | "waiting") {
            "idle".into()
        } else {
            session.status
        }
    };
    // Text deltas stay in memory. During those updates, send only the live
    // prefix instead of repeatedly reading/serializing the same 2 MiB history.
    // SQLite's connection revision also catches tools updated in place. Older
    // pages are always loaded explicitly, regardless of the current revision.
    let history_unchanged = before_id.is_none() && history_version == Some(version);
    let page = if history_unchanged {
        storage::MessagePage {
            messages: Vec::new(),
            has_older: false,
        }
    } else {
        store.message_page(session_id, before_id)?
    };
    let live_text = if let Some(agent) = agent {
        agent.assistant.lock().map_err(|e| e.to_string())?.clone()
    } else {
        String::new()
    };
    Ok(ThreadSnapshot {
        messages: page.messages,
        has_older: page.has_older,
        live_text,
        status,
        provider: session.provider,
        subagent: None,
        history_version: version,
        history_unchanged,
    })
}

/// Reading a launcher thread has no window, focus, navigation, or agent effects.
#[tauri::command]
pub async fn overlay_thread(
    state: State<'_, AppState>,
    session_id: String,
    subagent_id: Option<String>,
    before_id: Option<i64>,
    history_version: Option<u64>,
) -> Result<ThreadSnapshot> {
    thread_snapshot(
        &state,
        &session_id,
        subagent_id.as_deref(),
        before_id,
        history_version,
    )
}

#[tauri::command]
pub async fn overlay_launch(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    overlay: State<'_, OverlayState>,
    prompt: String,
    project_id: Option<String>,
) -> Result<String> {
    if overlay.launching.swap(true, Ordering::AcqRel) {
        return Err("A task is already starting. Try again in a moment.".into());
    }
    let _launch = LaunchGuard(&overlay.launching);
    let prompt = prompt.trim();
    if prompt.is_empty() || prompt.len() > 32 * 1024 {
        return Err("Describe a task in fewer than 32,768 characters.".into());
    }
    let preferences = overlay
        .inner
        .lock()
        .map_err(|e| e.to_string())?
        .preferences
        .clone();
    let context = preferences.effective_context();
    let task = {
        let store = state.store.lock().map_err(|e| e.to_string())?;
        let project_id = project_id
            .or(context.project_id.clone())
            .or_else(|| store.sessions().ok()?.first().map(|s| s.project_id.clone()))
            .or_else(|| store.projects().ok()?.first().map(|p| p.id.clone()))
            .ok_or("Open a project in PandaCode first.")?;
        let title: String = prompt
            .lines()
            .next()
            .unwrap_or(prompt)
            .chars()
            .take(100)
            .collect();
        create_launch_task(
            &store,
            &project_id,
            &context,
            preferences.model_selection.is_some(),
            &title,
            prompt,
        )?
    };
    let result = crate::send_message(
        app.clone(),
        state,
        task.id.clone(),
        prompt.to_string(),
        None,
        None,
    )
    .await;
    let _ = app.emit("sessions-changed", ());
    result.map_err(|error| format!("{error} Your task is saved in Pending."))?;
    Ok(task.id)
}

fn create_launch_task(
    store: &storage::Store,
    project_id: &str,
    context: &LaunchContext,
    explicit_model: bool,
    title: &str,
    prompt: &str,
) -> Result<storage::Session> {
    let transaction = store
        .db
        .unchecked_transaction()
        .map_err(|e| e.to_string())?;
    let task =
        store.create_session(project_id, &context.provider, &context.model, &context.mode)?;
    store.update_task_details(&task.id, title, prompt)?;
    // The launcher derives this title from the prompt; it is not a manual name.
    store.db.execute("UPDATE sessions SET title_origin='auto' WHERE id=?1", [&task.id]).map_err(|e| e.to_string())?;
    crate::architect::profiles::apply_default(store, &task.id)?;
    if explicit_model {
        // Keep the saved worker setup, but honor the user's launcher selection for
        // this architect. The reusable team library is never rewritten here.
        store.configure(&task.id, &context.provider, &context.model, None)?;
        store.set_reasoning_effort(&task.id, context.reasoning_effort.as_deref())?;
    } else {
        apply_context_effort(store, &task.id, context.reasoning_effort.as_deref())?;
    }
    let task = store.session(&task.id)?;
    transaction.commit().map_err(|e| e.to_string())?;
    Ok(task)
}

fn apply_context_effort(store: &storage::Store, task_id: &str, effort: Option<&str>) -> Result<()> {
    // Saved team profiles own the architect's model and effort selection.
    if crate::architect::load(store, task_id)?.is_none() && effort.is_some() {
        store.set_reasoning_effort(task_id, effort)?;
    }
    Ok(())
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenTarget {
    session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    worker_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    worker_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    subagent_id: Option<String>,
}
fn open_target(
    store: &storage::Store,
    session_id: &str,
    subagent_id: Option<&str>,
    live_child: bool,
) -> Result<OpenTarget> {
    use rusqlite::OptionalExtension;
    let exists: bool = store
        .db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sessions WHERE id=?1)",
            [session_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !exists {
        return Err("Conversation not found.".into());
    }
    if let Some(child) = subagent_id {
        let saved: bool = store
            .db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM subagents WHERE session_id=?1 AND id=?2)",
                rusqlite::params![session_id, child],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if !live_child && !saved {
            return Err("This subagent does not belong to the selected task.".into());
        }
    }
    let worker: Option<(String, String)> = store
        .db
        .query_row(
            "SELECT parent_session_id,worker_id FROM architect_workers WHERE session_id=?1",
            [session_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(match worker {
        Some((parent, id)) => OpenTarget {
            session_id: parent,
            worker_id: Some(id),
            worker_session_id: Some(session_id.into()),
            subagent_id: subagent_id.map(str::to_string),
        },
        None => OpenTarget {
            session_id: session_id.into(),
            worker_id: None,
            worker_session_id: None,
            subagent_id: subagent_id.map(str::to_string),
        },
    })
}
#[tauri::command]
pub async fn overlay_open_task(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    subagent_id: Option<String>,
) -> Result<()> {
    let target = {
        let agents = state.agents.lock().map_err(|e| e.to_string())?;
        let live_child =
            if let (Some(id), Some(agent)) = (subagent_id.as_deref(), agents.get(&session_id)) {
                agent
                    .subagents
                    .lock()
                    .map_err(|e| e.to_string())?
                    .contains(id)
            } else {
                false
            };
        let store = state.store.lock().map_err(|e| e.to_string())?;
        open_target(&store, &session_id, subagent_id.as_deref(), live_child)?
    };
    hide(&app)?;
    let window = app
        .get_webview_window("main")
        .ok_or("The workspace window is unavailable.")?;
    window.unminimize().map_err(|e| e.to_string())?;
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())?;
    window
        .emit("overlay-open-task", target)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn missing_shortcut_backend_leaves_a_manual_launcher_fallback() {
        let notice = shortcut_backend_notice(false, false).unwrap();
        assert!(notice.contains("Global shortcuts are unavailable"));
        assert!(notice.contains("Open in Quick launcher settings"));
        assert!(shortcut_backend_notice(true, false).is_none());
        let notice = shortcut_backend_notice(true, true).unwrap();
        assert!(notice.contains("use X11"));
        assert!(notice.contains("may not work outside XWayland apps"));
        assert!(!notice.contains("are unavailable"));
    }
    #[test]
    fn disabling_an_invalid_shortcut_needs_neither_parsing_nor_a_backend() {
        let binding = desired_binding(false, "invalid old shortcut").unwrap();
        let saved = std::cell::Cell::new(false);
        change_registration(
            None,
            binding,
            |_| panic!("must not require a backend"),
            |_| panic!("must not require a backend"),
            || {
                saved.set(true);
                Ok(())
            },
        )
        .unwrap();
        assert!(saved.get());
        assert!(desired_binding(true, "invalid old shortcut").is_err());
    }
    #[test]
    fn enabling_without_a_shortcut_backend_never_saves_a_false_registration() {
        let binding = desired_binding(true, DEFAULT_SHORTCUT).unwrap();
        let saved = std::cell::Cell::new(false);
        let result = change_registration(
            None,
            binding,
            |_| Err(shortcut_backend_notice(false, false).unwrap()),
            |_| panic!("no registration to remove"),
            || {
                saved.set(true);
                Ok(())
            },
        );
        assert!(result
            .unwrap_err()
            .contains("Global shortcuts are unavailable"));
        assert!(!saved.get());
    }
    #[test]
    fn shortcut_requires_modifiers_and_valid_key() {
        assert!(parse_shortcut(DEFAULT_SHORTCUT).is_ok());
        assert!(parse_shortcut("Space").is_err());
        assert!(parse_shortcut("CommandOrControl+What").is_err());
    }
    #[test]
    fn shortcut_conflict_preserves_the_old_binding_and_settings() {
        let old = parse_shortcut(DEFAULT_SHORTCUT).unwrap();
        let next = parse_shortcut("Control+Alt+B").unwrap();
        let saved = std::cell::Cell::new(false);
        let unregistered = std::cell::Cell::new(false);
        let result = change_registration(
            Some(old),
            Some(next),
            |_| Err("occupied".into()),
            |_| {
                unregistered.set(true);
                Ok(())
            },
            || {
                saved.set(true);
                Ok(())
            },
        );
        assert!(result.is_err());
        assert!(!saved.get());
        assert!(!unregistered.get());
    }
    #[test]
    fn persistence_failure_releases_only_the_new_binding() {
        let old = parse_shortcut(DEFAULT_SHORTCUT).unwrap();
        let next = parse_shortcut("Control+Alt+B").unwrap();
        let removed = std::cell::Cell::new(None);
        assert!(change_registration(
            Some(old),
            Some(next),
            |_| Ok(()),
            |key| {
                removed.set(Some(key));
                Ok(())
            },
            || Err("disk full".into())
        )
        .is_err());
        assert_eq!(removed.get(), Some(next));
    }
    #[test]
    fn disabling_releases_binding_and_persists_without_registering() {
        let old = parse_shortcut(DEFAULT_SHORTCUT).unwrap();
        let removed = std::cell::Cell::new(None);
        change_registration(
            Some(old),
            None,
            |_| panic!("must not register"),
            |key| {
                removed.set(Some(key));
                Ok(())
            },
            || Ok(()),
        )
        .unwrap();
        assert_eq!(removed.get(), Some(old));
    }
    fn fixture() -> (storage::Store, storage::Project) {
        let store = storage::Store::open(Path::new(":memory:")).unwrap();
        let project = store.add_project(&std::env::temp_dir()).unwrap();
        (store, project)
    }
    fn task(store: &storage::Store, project: &storage::Project) -> storage::Session {
        store
            .create_session(&project.id, "codex", "default", "ask")
            .unwrap()
    }
    fn team(store: &storage::Store, parent: &str, worker: &str, status: &str) {
        let content = serde_json::json!({"status":status,"workers":[{"id":"worker-1","sessionId":worker,"name":"Review accessibility","status":"running"}]}).to_string();
        store
            .db
            .execute(
                "INSERT INTO architect_teams(session_id,content) VALUES(?1,?2)",
                rusqlite::params![parent, content],
            )
            .unwrap();
        store.db.execute("INSERT INTO architect_workers(parent_session_id,worker_id,session_id) VALUES(?1,'worker-1',?2)",[parent,worker]).unwrap();
    }

    fn app_state(store: storage::Store) -> AppState {
        AppState {
            store: std::sync::Arc::new(Mutex::new(store)),
            agents: std::sync::Arc::new(Mutex::new(Default::default())),
            terminals: std::sync::Arc::new(Mutex::new(Default::default())),
            shutdown: std::sync::atomic::AtomicU8::new(0),
        }
    }

    fn running_agent() -> crate::RunningAgent {
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        crate::RunningAgent::new(tx, std::sync::Arc::new(AtomicBool::new(false)))
    }

    #[test]
    fn thread_reads_history_and_live_prefix_without_starting_or_opening_anything() {
        let (store, project) = fixture();
        let task = task(&store, &project);
        let state = app_state(store);
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let prepared = crate::prepare_task_run(
            &state,
            task.id.clone(),
            Some("Build a garden".into()),
            Vec::new(),
            tx,
            std::sync::Arc::new(AtomicBool::new(false)),
        )
        .unwrap();
        *prepared.assistant.lock().unwrap() = "I’m building the garden".into();
        assert!(std::sync::Arc::ptr_eq(
            &prepared.assistant,
            &state.agents.lock().unwrap()[&task.id].assistant,
        ));
        let snapshot = thread_snapshot(&state, &task.id, None, None, None).unwrap();
        assert_eq!(snapshot.status, "running");
        assert_eq!(snapshot.messages.last().unwrap().content, "Build a garden");
        assert_eq!(snapshot.live_text, "I’m building the garden");
        assert!(!snapshot.has_older);
        assert!(snapshot.subagent.is_none());
        assert_eq!(state.agents.lock().unwrap().len(), 1);

        // Reading before and after a provider tool boundary never duplicates
        // the text: the exact same buffer moves atomically into saved history.
        crate::flush_assistant(&state.store.lock().unwrap(), &task.id, &prepared.assistant)
            .unwrap();
        prepared
            .assistant
            .lock()
            .unwrap()
            .push_str("Now adding a path");
        let snapshot = thread_snapshot(&state, &task.id, None, None, None).unwrap();
        assert_eq!(
            snapshot.messages.last().unwrap().content,
            "I’m building the garden"
        );
        assert_eq!(snapshot.live_text, "Now adding a path");
    }

    #[test]
    fn thread_reads_worker_session_not_its_architect_or_other_tasks() {
        let (store, project) = fixture();
        let parent = task(&store, &project);
        let worker = task(&store, &project);
        team(&store, &parent.id, &worker.id, "running");
        store
            .message(&parent.id, "assistant", "Architect-only plan")
            .unwrap();
        store
            .message(&worker.id, "assistant", "Worker-only progress")
            .unwrap();
        let state = app_state(store);
        let agent = running_agent();
        agent.approvals.lock().unwrap().insert("approval-1".into());
        *agent.assistant.lock().unwrap() = "Worker live text".into();
        state
            .agents
            .lock()
            .unwrap()
            .insert(worker.id.clone(), agent);
        let snapshot = thread_snapshot(&state, &worker.id, None, None, None).unwrap();
        assert_eq!(snapshot.messages.len(), 1);
        assert_eq!(snapshot.messages[0].content, "Worker-only progress");
        assert_eq!(snapshot.live_text, "Worker live text");
        assert_eq!(snapshot.status, "waiting");
        let parent_snapshot = thread_snapshot(&state, &parent.id, None, None, None).unwrap();
        assert_eq!(parent_snapshot.status, "coordinating");
        assert_eq!(parent_snapshot.messages[0].content, "Architect-only plan");
        assert!(parent_snapshot.live_text.is_empty());
    }

    #[test]
    fn thread_provider_refreshes_after_a_handoff_without_relabeling_saved_responses() {
        let (store, project) = fixture();
        let task = task(&store, &project);
        store.message(&task.id, "assistant", "Saved response").unwrap();
        let state = app_state(store);
        let first = thread_snapshot(&state, &task.id, None, None, None).unwrap();
        state.store.lock().unwrap().configure(&task.id, "kimi", "default", None).unwrap();
        let updated = thread_snapshot(&state, &task.id, None, None, Some(first.history_version)).unwrap();
        assert_eq!(updated.provider, "kimi");
        assert!(!updated.history_unchanged);
        assert_eq!(updated.messages[0].author_provider.as_deref(), Some(task.provider.as_str()));
        assert_eq!(updated.messages[1].role, "handoff");
    }

    #[test]
    fn thread_skips_unchanged_history_but_refreshes_tools_updated_in_place() {
        let (store, project) = fixture();
        let task = task(&store, &project);
        store.message(&task.id, "user", "Run the tests").unwrap();
        store.tool_message(&task.id, "tool-1", "running").unwrap();
        let state = app_state(store);
        let agent = running_agent();
        let assistant = agent.assistant.clone();
        state.agents.lock().unwrap().insert(task.id.clone(), agent);
        let first = thread_snapshot(&state, &task.id, None, None, None).unwrap();
        assert_eq!(first.messages.len(), 2);
        assert!(!first.history_unchanged);
        *assistant.lock().unwrap() = "Tests are running".into();
        let delta =
            thread_snapshot(&state, &task.id, None, None, Some(first.history_version)).unwrap();
        assert!(delta.history_unchanged);
        assert!(delta.messages.is_empty());
        assert_eq!(delta.live_text, "Tests are running");
        assert_eq!(delta.history_version, first.history_version);

        state
            .store
            .lock()
            .unwrap()
            .tool_message(&task.id, "tool-1", "completed")
            .unwrap();
        let updated =
            thread_snapshot(&state, &task.id, None, None, Some(first.history_version)).unwrap();
        assert!(!updated.history_unchanged);
        assert!(updated.history_version > first.history_version);
        assert_eq!(updated.messages.len(), 2);
        assert_eq!(updated.messages[1].id, first.messages[1].id);
        assert_eq!(updated.messages[1].content, "completed");
        let older = thread_snapshot(
            &state,
            &task.id,
            None,
            Some(updated.messages[1].id),
            Some(updated.history_version),
        )
        .unwrap();
        assert!(!older.history_unchanged);
        assert_eq!(older.messages.len(), 1);
        assert_eq!(older.messages[0].role, "user");
    }

    #[test]
    fn thread_reads_selected_live_child_and_retains_completed_child_history() {
        let (store, project) = fixture();
        let owner = task(&store, &project);
        let other = task(&store, &project);
        store
            .message(&owner.id, "assistant", "Parent-only response")
            .unwrap();
        let state = app_state(store);
        let agent = running_agent();
        let children = agent.subagents.clone();
        let mut activity = crate::providers::SubagentActivity {
            id: "child".into(),
            parent_id: None,
            name: "Testing".into(),
            prompt: "Check the build".into(),
            status: "running".into(),
            response: "First prefix".into(),
            tools: Vec::new(),
            started_at: 10,
            updated_at: 10,
        };
        let mut event = crate::event(&owner.id, "subagent", "");
        event.data = Some(serde_json::to_value(&activity).unwrap());
        children
            .lock()
            .unwrap()
            .record(&state.store, "run", &mut event)
            .unwrap();
        activity.response = "First prefix plus live continuation".into();
        event.data = Some(serde_json::to_value(&activity).unwrap());
        children
            .lock()
            .unwrap()
            .record(&state.store, "run", &mut event)
            .unwrap();
        state.agents.lock().unwrap().insert(owner.id.clone(), agent);
        let snapshot = thread_snapshot(&state, &owner.id, Some("run:child"), None, None).unwrap();
        assert!(snapshot.messages.is_empty());
        assert!(snapshot.live_text.is_empty());
        assert_eq!(snapshot.status, "running");
        assert_eq!(snapshot.subagent.unwrap().response, activity.response);
        assert!(thread_snapshot(&state, &other.id, Some("run:child"), None, None).is_err());
        assert!(thread_snapshot(&state, &owner.id, Some("unrelated-child"), None, None).is_err());

        activity.status = "completed".into();
        activity.response = "Final result".into();
        event.data = Some(serde_json::to_value(&activity).unwrap());
        children
            .lock()
            .unwrap()
            .record(&state.store, "run", &mut event)
            .unwrap();
        state.agents.lock().unwrap().remove(&owner.id);
        let snapshot = thread_snapshot(&state, &owner.id, Some("run:child"), None, None).unwrap();
        assert_eq!(snapshot.status, "completed");
        assert_eq!(snapshot.subagent.unwrap().response, "Final result");
    }

    #[test]
    fn thread_read_after_completion_stays_available_and_is_bounded() {
        let (store, project) = fixture();
        let task = task(&store, &project);
        for i in 0..105 {
            store
                .message(&task.id, "assistant", &format!("Response {i}"))
                .unwrap();
        }
        store.status(&task.id, "idle").unwrap();
        let state = app_state(store);
        let recent = thread_snapshot(&state, &task.id, None, None, None).unwrap();
        assert_eq!(recent.status, "idle");
        assert_eq!(recent.messages.len(), 100);
        assert!(recent.has_older);
        assert!(recent.live_text.is_empty());
        let older =
            thread_snapshot(&state, &task.id, None, Some(recent.messages[0].id), None).unwrap();
        assert_eq!(older.messages.len(), 5);
        assert!(!older.has_older);
        assert!(thread_snapshot(&state, "missing", None, None, None).is_err());
        assert!(thread_snapshot(&state, &task.id, None, Some(0), None).is_err());
    }

    #[test]
    fn thread_does_not_report_stale_or_stopped_runs_as_active() {
        let (store, project) = fixture();
        let task = task(&store, &project);
        store.status(&task.id, "running").unwrap();
        let state = app_state(store);
        assert_eq!(
            thread_snapshot(&state, &task.id, None, None, None)
                .unwrap()
                .status,
            "idle"
        );
        let agent = running_agent();
        agent.stopped.store(true, Ordering::Release);
        *agent.assistant.lock().unwrap() = "Last visible response".into();
        state.agents.lock().unwrap().insert(task.id.clone(), agent);
        let snapshot = thread_snapshot(&state, &task.id, None, None, None).unwrap();
        assert_eq!(snapshot.status, "stopped");
        assert_eq!(snapshot.live_text, "Last visible response");
    }

    #[test]
    fn snapshots_exclude_idle_finished_and_stale_saved_activity() {
        let (store, project) = fixture();
        let idle = task(&store, &project);
        let stale = task(&store, &project);
        let live = task(&store, &project);
        store.status(&stale.id, "running").unwrap();
        store
            .db
            .execute(
                "INSERT INTO architect_teams(session_id,content) VALUES(?1,?2)",
                rusqlite::params![
                    idle.id,
                    serde_json::json!({"status":"running","workers":[]}).to_string()
                ],
            )
            .unwrap();
        assert!(summaries(&store, &Default::default()).unwrap().is_empty());
        let active = std::collections::HashMap::from([(
            live.id.clone(),
            LiveTask {
                waiting: true,
                ..Default::default()
            },
        )]);
        let rows = summaries(&store, &active).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, live.id);
        assert_eq!(rows[0].status, "waiting");
        assert_eq!(rows[0].kind, "task");
    }
    #[test]
    fn active_workers_and_their_coordinating_architect_are_both_visible() {
        let (store, project) = fixture();
        let parent = task(&store, &project);
        let worker = task(&store, &project);
        team(&store, &parent.id, &worker.id, "waiting");
        assert!(summaries(&store, &Default::default()).unwrap().is_empty());
        let active = std::collections::HashMap::from([(worker.id.clone(), LiveTask::default())]);
        let rows = summaries(&store, &active).unwrap();
        assert_eq!(rows.len(), 2);
        let architect = rows.iter().find(|row| row.id == parent.id).unwrap();
        assert_eq!(architect.status, "coordinating");
        assert_eq!(architect.kind, "task");
        let child = rows.iter().find(|row| row.id == worker.id).unwrap();
        assert_eq!(child.kind, "worker");
        assert_eq!(child.title, "Review accessibility");
        assert_eq!(child.worker_id.as_deref(), Some("worker-1"));
        assert_eq!(child.parent_session_id.as_deref(), Some(parent.id.as_str()));
        assert_eq!(child.session_id, worker.id);
        store.db.execute("UPDATE architect_teams SET content=json_set(content,'$.status','completed') WHERE session_id=?1",[&parent.id]).unwrap();
        let rows = summaries(&store, &active).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, worker.id);
    }
    #[test]
    fn worker_subagent_metadata_routes_to_owner_without_cloning_responses() {
        let (store, project) = fixture();
        let parent = task(&store, &project);
        let worker = task(&store, &project);
        team(&store, &parent.id, &worker.id, "running");
        let active = std::collections::HashMap::from([(
            worker.id.clone(),
            LiveTask {
                waiting: false,
                children: vec![crate::subagent_state::ActiveSummary {
                    id: "run:child".into(),
                    name: "Check semantics".into(),
                    status: "running".into(),
                    updated_at: 123,
                }],
            },
        )]);
        let rows = summaries(&store, &active).unwrap();
        assert_eq!(rows.len(), 3);
        let child = rows.iter().find(|row| row.kind == "subagent").unwrap();
        assert_eq!(child.session_id, worker.id);
        assert_eq!(child.parent_session_id.as_deref(), Some(parent.id.as_str()));
        assert_eq!(child.parent_title.as_deref(), Some("Review accessibility"));
        assert_eq!(child.subagent_id.as_deref(), Some("run:child"));
        assert_eq!(child.id, format!("subagent:{}:run:child", worker.id));
        let json = serde_json::to_value(child).unwrap();
        assert!(json.get("response").is_none());
        assert!(json.get("tools").is_none());
        assert_eq!(json["sessionId"], worker.id);
        assert_eq!(json["kind"], "subagent");
    }
    #[test]
    fn active_children_are_not_truncated_to_the_old_recent_task_limit() {
        let (store, project) = fixture();
        let owner = task(&store, &project);
        let children = (0..40)
            .map(|i| crate::subagent_state::ActiveSummary {
                id: format!("child-{i}"),
                name: format!("#{i}"),
                status: "running".into(),
                updated_at: 1,
            })
            .collect();
        let rows = summaries(
            &store,
            &std::collections::HashMap::from([(
                owner.id,
                LiveTask {
                    waiting: false,
                    children,
                },
            )]),
        )
        .unwrap();
        assert_eq!(rows.len(), 41);
    }
    #[test]
    fn stopped_processes_and_their_children_are_not_active() {
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let agent = crate::RunningAgent::new(tx, std::sync::Arc::new(AtomicBool::new(true)));
        assert!(
            live_tasks(&std::collections::HashMap::from([("task".into(), agent)]))
                .unwrap()
                .is_empty()
        );
    }
    #[test]
    fn opening_children_checks_ownership_and_resolves_worker_parent() {
        let (store, project) = fixture();
        let parent = task(&store, &project);
        let worker = task(&store, &project);
        let other = task(&store, &project);
        team(&store, &parent.id, &worker.id, "running");
        // An indexed existence lookup permits a child which settled after it was clicked.
        store
            .db
            .execute(
                "INSERT INTO subagents(session_id,id,content,updated_at) VALUES(?1,'child','{}',1)",
                [&worker.id],
            )
            .unwrap();
        assert!(open_target(&store, &other.id, Some("child"), false).is_err());
        assert!(open_target(&store, "missing", None, false).is_err());
        let target = open_target(&store, &worker.id, Some("child"), false).unwrap();
        assert_eq!(target.session_id, parent.id);
        assert_eq!(
            target.worker_session_id.as_deref(),
            Some(worker.id.as_str())
        );
        assert_eq!(target.worker_id.as_deref(), Some("worker-1"));
        assert_eq!(target.subagent_id.as_deref(), Some("child"));
        let live = open_target(&store, &other.id, Some("new-child"), true).unwrap();
        assert_eq!(live.session_id, other.id);
        assert!(live.worker_id.is_none());
    }
    #[test]
    fn context_and_preferences_survive_round_trip() {
        let preferences = Preferences {
            context: LaunchContext {
                project_id: Some("project-1".into()),
                provider: "claude".into(),
                model: "sonnet".into(),
                mode: "plan".into(),
                reasoning_effort: Some("high".into()),
            },
            ..Preferences::default()
        };
        let restored: Preferences =
            serde_json::from_slice(&serde_json::to_vec(&preferences).unwrap()).unwrap();
        assert_eq!(restored.context, preferences.context);
        assert!(validate_context(&restored.context).is_ok());
    }

    #[test]
    fn old_preferences_use_synced_model_until_an_explicit_selection_is_saved() {
        let preferences: Preferences = serde_json::from_value(serde_json::json!({
            "enabled": true, "shortcut": DEFAULT_SHORTCUT,
            "context": {"projectId":"project", "provider":"kimi", "model":"kimi-latest", "mode":"plan"}
        })).unwrap();
        assert!(preferences.model_selection.is_none());
        assert_eq!(preferences.effective_context(), preferences.context);
    }

    #[test]
    fn selection_survives_restart_and_background_project_sync() {
        let dir = std::env::temp_dir().join(format!("pandacode-overlay-model-{}", storage::id()));
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("overlay.json");
        let mut preferences = Preferences::default();
        select_model(
            &path,
            &mut preferences,
            "opencode".into(),
            "openrouter/custom-model".into(),
            None,
        )
        .unwrap();
        let mut restored: Preferences =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        sync_context(
            &path,
            &mut restored,
            LaunchContext {
                project_id: Some("new-project".into()),
                provider: "claude".into(),
                model: "sonnet".into(),
                mode: "plan".into(),
                reasoning_effort: Some("high".into()),
            },
        )
        .unwrap();
        let restored: Preferences = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let context = restored.effective_context();
        assert_eq!(context.provider, "opencode");
        assert_eq!(context.model, "openrouter/custom-model");
        assert_eq!(context.project_id.as_deref(), Some("new-project"));
        assert_eq!(context.mode, "plan");
        assert_eq!(context.reasoning_effort, None);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn launcher_defaults_to_full_but_keeps_saved_permission_choices() {
        assert_eq!(LaunchContext::default().mode, "full");
        let store = storage::Store::open(Path::new(":memory:")).unwrap();
        let project = store.add_project(&std::env::temp_dir()).unwrap();
        for provider in [
            "claude",
            "codex",
            "kimi",
            "glm",
            "opencode",
            "antigravity",
            "grok",
            "mimo",
            "pi",
            "deepseek",
            "commandcode",
            "cline",
            "kilo",
            "omp",
            "github-copilot",
            "muse",
        ] {
            for mode in [None, Some("ask"), Some("auto"), Some("plan"), Some("full")] {
                let mut saved = serde_json::json!({"provider":provider,"model":"default"});
                if let Some(mode) = mode {
                    saved["mode"] = serde_json::json!(mode);
                }
                let context: LaunchContext = serde_json::from_value(saved).unwrap();
                assert_eq!(context.mode, mode.unwrap_or("full"));
                let created = create_launch_task(
                    &store,
                    &project.id,
                    &context,
                    true,
                    "Quick task",
                    "Build a feature",
                )
                .unwrap();
                assert_eq!(created.mode, mode.unwrap_or("full"));
            }
        }
    }

    #[test]
    fn failed_model_persistence_keeps_previous_selection() {
        let path = std::env::temp_dir()
            .join(format!("pandacode-missing-{}", storage::id()))
            .join("overlay.json");
        let mut preferences = Preferences::default();
        let before = preferences.effective_context();
        assert!(select_model(
            &path,
            &mut preferences,
            "claude".into(),
            "sonnet".into(),
            None
        )
        .is_err());
        assert!(preferences.model_selection.is_none());
        assert_eq!(preferences.effective_context(), before);
    }

    #[test]
    fn model_selection_resets_old_effort_and_accepts_effort_for_same_model() {
        let dir = std::env::temp_dir().join(format!("pandacode-overlay-model-{}", storage::id()));
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("overlay.json");
        let mut preferences = Preferences::default();
        preferences.context.reasoning_effort = Some("ultra".into());
        let changed = select_model(
            &path,
            &mut preferences,
            "claude".into(),
            "sonnet".into(),
            Some("ultra".into()),
        )
        .unwrap();
        assert_eq!(changed.reasoning_effort, None);
        let changed = select_model(
            &path,
            &mut preferences,
            "claude".into(),
            "sonnet".into(),
            Some("high".into()),
        )
        .unwrap();
        assert_eq!(changed.reasoning_effort.as_deref(), Some("high"));
        let changed = select_model(
            &path,
            &mut preferences,
            "claude".into(),
            "sonnet".into(),
            None,
        )
        .unwrap();
        assert_eq!(changed.reasoning_effort, None);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn invalid_model_selection_never_changes_preferences() {
        let path = std::env::temp_dir().join(format!("pandacode-invalid-{}.json", storage::id()));
        let mut preferences = Preferences::default();
        for (provider, model) in [
            ("unknown", "default"),
            ("codex", ""),
            ("codex", "injected\nmodel"),
            ("codex", &"m".repeat(201)),
        ] {
            assert!(
                select_model(&path, &mut preferences, provider.into(), model.into(), None).is_err()
            );
            assert!(preferences.model_selection.is_none());
        }
        assert!(!path.exists());
    }

    #[test]
    fn invalid_launch_effort_rolls_back_new_task() {
        let (store, project) = fixture();
        let before = store.sessions().unwrap().len();
        assert!(create_launch_task(
            &store,
            &project.id,
            &LaunchContext {
                provider: "kimi".into(),
                reasoning_effort: Some("high".into()),
                ..LaunchContext::default()
            },
            true,
            "Task",
            "Build a task"
        )
        .is_err());
        assert_eq!(store.sessions().unwrap().len(), before);
    }
    #[test]
    fn launcher_prompt_titles_remain_automatic_while_named_board_titles_do_not() {
        let (store, project) = fixture();
        let prompt = "Build a provider usage panel";
        let task = create_launch_task(&store, &project.id, &LaunchContext::default(), false, prompt, prompt).unwrap();
        assert!(crate::session_titles::automatic(&store, &task.id).unwrap());
        let id = store.begin_task_turn(&task.id, prompt).unwrap();
        assert!(crate::session_titles::TitleRun::prepare(&store, &task.id, id).unwrap().is_some());
        let board = store.create_board_task(&project.id, "claude", "sonnet", "full", prompt, prompt).unwrap();
        assert!(!crate::session_titles::automatic(&store, &board.id).unwrap());
    }

    #[test]
    fn launcher_preserves_team_effort_and_applies_context_to_solo_tasks() {
        use crate::architect::{self, profiles::ModelSelection, TeamConfig, WorkerProfile};
        use std::sync::{atomic::AtomicU8, Arc};
        let store = storage::Store::open(Path::new(":memory:")).unwrap();
        let project = store.add_project(&std::env::temp_dir()).unwrap();
        let original = store
            .create_session(&project.id, "codex", "default", "ask")
            .unwrap();
        let state = AppState {
            store: Arc::new(Mutex::new(store)),
            agents: Arc::new(Mutex::new(Default::default())),
            terminals: Arc::new(Mutex::new(Default::default())),
            shutdown: AtomicU8::new(0),
        };
        architect::configure_state(
            &state,
            &original.id,
            Some(TeamConfig {
                auto: false,
                roster_only: false,
                name: None,
                workers: vec![WorkerProfile {
                    id: "worker".into(),
                    name: "Worker".into(),
                    provider: "codex".into(),
                    model: "default".into(),
                    reasoning_effort: None,
                }],
                max_parallel: 1,
                max_rounds: 4,
                max_assignments: 4,
                workspace: "shared".into(),
                summary_limit: 1500,
                lead_guidance: None,
            }),
            Some(ModelSelection {
                provider: "claude".into(),
                model: "sonnet".into(),
                reasoning_effort: Some("medium".into()),
            }),
            None,
        )
        .unwrap();
        let store = state.store.lock().unwrap();
        let preferences = Preferences {
            context: LaunchContext {
                project_id: Some(project.id.clone()),
                reasoning_effort: Some("xhigh".into()),
                ..LaunchContext::default()
            },
            ..Preferences::default()
        };
        let (preview, count) = launch_preview(&store, &preferences).unwrap();
        assert_eq!(count, 1);
        assert_eq!(preview.provider, "claude");
        assert_eq!(preview.model, "sonnet");
        assert_eq!(preview.reasoning_effort.as_deref(), Some("medium"));
        assert_eq!(preview.project_id.as_deref(), Some(project.id.as_str()));
        let team_task = architect::profiles::create_user_task(
            &store,
            &project.id,
            "codex",
            "default",
            Some("ask"),
            None,
        )
        .unwrap();
        apply_context_effort(&store, &team_task.id, Some("xhigh")).unwrap();
        let team_task = store.session(&team_task.id).unwrap();
        assert_eq!(team_task.provider, "claude");
        assert_eq!(team_task.reasoning_effort.as_deref(), Some("medium"));
        assert_eq!(preview.model, team_task.model);
        let library_before =
            serde_json::to_value(architect::profiles::read(&store).unwrap()).unwrap();
        let selected = create_launch_task(
            &store,
            &project.id,
            &LaunchContext {
                provider: "opencode".into(),
                model: "openrouter/custom-model".into(),
                ..LaunchContext::default()
            },
            true,
            "Selected architect",
            "Build with the chosen architect",
        )
        .unwrap();
        assert_eq!(selected.provider, "opencode");
        assert_eq!(selected.model, "openrouter/custom-model");
        assert_eq!(selected.reasoning_effort, None);
        let explicit_preferences = Preferences {
            model_selection: Some(ModelSelection::from_session(&selected)),
            ..preferences.clone()
        };
        let (preview, count) = launch_preview(&store, &explicit_preferences).unwrap();
        assert_eq!(count, 1);
        assert_eq!(preview.provider, selected.provider);
        assert_eq!(preview.model, selected.model);
        assert_eq!(preview.reasoning_effort, selected.reasoning_effort);
        assert_eq!(
            architect::load(&store, &selected.id)
                .unwrap()
                .unwrap()
                .config
                .workers[0]
                .provider,
            "codex"
        );
        assert_eq!(
            serde_json::to_value(architect::profiles::read(&store).unwrap()).unwrap(),
            library_before
        );
        store.db.execute("UPDATE architect_library SET content=json_set(content,'$.enabled',json('false')) WHERE id=1", []).unwrap();
        let (preview, count) = launch_preview(&store, &preferences).unwrap();
        assert_eq!(count, 0);
        assert_eq!(preview, preferences.effective_context());
        let (preview, count) = launch_preview(&store, &explicit_preferences).unwrap();
        assert_eq!(count, 0);
        assert_eq!(preview, explicit_preferences.effective_context());
        let solo = store
            .create_session(&project.id, "codex", "default", "ask")
            .unwrap();
        apply_context_effort(&store, &solo.id, Some("xhigh")).unwrap();
        assert_eq!(
            store.session(&solo.id).unwrap().reasoning_effort.as_deref(),
            Some("xhigh")
        );
    }
}
