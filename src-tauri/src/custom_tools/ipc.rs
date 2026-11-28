//! Settings → tools: list every scope, move a tool between a project and global, delete it,
//! turn it off. Every change emits `custom-tools-changed`.
use super::{store, Scope, Stats, Tool, CHANGED_EVENT};
use crate::AppState;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{Emitter, Manager};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ToolView {
    #[serde(flatten)]
    pub tool: Tool,
    pub stats: Stats,
    pub scope: Scope,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectTools {
    pub project_id: String,
    pub project_name: String,
    pub tools: Vec<ToolView>,
}

#[derive(Serialize)]
pub(crate) struct Listing {
    pub global: Vec<ToolView>,
    pub projects: Vec<ProjectTools>,
}

pub(super) fn base_dir(app_data: &Path) -> PathBuf {
    app_data.join("custom-tools")
}

fn app_base(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(base_dir(&app.path().app_data_dir().map_err(|e| e.to_string())?))
}

fn views(dir: &Path, scope: Scope) -> Result<Vec<ToolView>, String> {
    let mut stats = store::try_read_stats(dir)?;
    Ok(store::try_load_all(dir)?.into_iter().map(|tool| ToolView { stats: stats.remove(&tool.name).unwrap_or_default(), tool, scope }).collect())
}

/// Every scope's tools; `name_of` names a project id (bots and chats included).
pub(super) fn listing(base: &Path, name_of: impl Fn(&str) -> String) -> Result<Listing, String> {
    let global = views(&store::scope_dir(base, None)?, Scope::Global)?;
    let mut projects = Vec::new();
    for id in store::project_ids(base)? {
        let tools = views(&store::scope_dir(base, Some(&id))?, Scope::Project)?;
        if !tools.is_empty() {
            projects.push(ProjectTools { project_name: name_of(&id), project_id: id, tools });
        }
    }
    Ok(Listing { global, projects })
}

fn changed(app: &tauri::AppHandle) {
    let _ = app.emit(CHANGED_EVENT, ());
}

/// Settings → Tools & add-ons → Agent-made tools: opt-in, on only while this `app_marker`
/// exists (a pilot saw 0 uses in 12 tasks; docs/custom-tools.md).
const ON_FILE: &str = "custom-tools-on";

/// Whether new runs are offered agent-made tools: off when the marker cannot be read.
pub(crate) fn enabled_for(app: &tauri::AppHandle) -> bool {
    crate::app_marker::exists(app, ON_FILE).unwrap_or(false)
}

/// An error when the marker cannot be checked, which Settings shows as unreadable.
#[tauri::command]
pub(crate) async fn custom_tools_enabled(app: tauri::AppHandle) -> Result<bool, String> {
    crate::blocking(move || crate::app_marker::exists(&app, ON_FILE)).await
}

#[tauri::command]
pub(crate) async fn set_custom_tools_enabled(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    crate::blocking(move || crate::app_marker::set(&app, ON_FILE, enabled)).await
}

#[tauri::command]
pub(crate) async fn custom_tools_list(app: tauri::AppHandle) -> Result<Listing, String> {
    crate::blocking(move || {
        let names: Vec<(String, String)> = {
            let state = app.state::<AppState>();
            let store = state.store.lock().map_err(|e| e.to_string())?;
            store.projects()?.into_iter().map(|project| (project.id, project.name)).collect()
        };
        listing(&app_base(&app)?, |id| names.iter().find(|(known, _)| known == id).map_or_else(|| "Removed project".to_owned(), |(_, name)| name.clone()))
    })
    .await
}

#[tauri::command]
pub(crate) async fn custom_tool_move(app: tauri::AppHandle, name: String, from_project_id: Option<String>, to_project_id: Option<String>) -> Result<(), String> {
    crate::blocking(move || {
        let base = app_base(&app)?;
        let from = store::scope_dir(&base, from_project_id.as_deref())?;
        let to = store::scope_dir(&base, to_project_id.as_deref())?;
        store::move_tool(&from, &to, &name)?;
        changed(&app);
        Ok(())
    })
    .await
}

#[tauri::command]
pub(crate) async fn custom_tool_delete(app: tauri::AppHandle, name: String, project_id: Option<String>) -> Result<(), String> {
    crate::blocking(move || {
        store::delete(&store::scope_dir(&app_base(&app)?, project_id.as_deref())?, &name)?;
        changed(&app);
        Ok(())
    })
    .await
}

#[tauri::command]
pub(crate) async fn custom_tool_set_disabled(app: tauri::AppHandle, name: String, project_id: Option<String>, disabled: bool) -> Result<(), String> {
    crate::blocking(move || {
        store::set_disabled(&store::scope_dir(&app_base(&app)?, project_id.as_deref())?, &name, disabled)?;
        changed(&app);
        Ok(())
    })
    .await
}
