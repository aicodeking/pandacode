//! Per-task token totals from the agents' own local session logs, attributed through
//! the harness session ids each task has run under (see usage_ledger).

use tauri::Manager;

#[tauri::command]
pub(crate) async fn task_token_usage(
    state: tauri::State<'_, crate::AppState>,
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    session_id: String,
    since: Option<i64>,
) -> crate::Result<Option<crate::usage_ledger::TaskUsage>> {
    if window.label() != "main" {
        return Err("Task usage is available only in the main application window.".into());
    }
    let links = state
        .store
        .lock()
        .map_err(|e| e.to_string())?
        .usage_links(&session_id)?;
    if links.is_empty() {
        return Ok(None);
    }
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let usage = crate::usage_ledger::task_usage(dir, links, since).await?;
    Ok(usage.last_used.map(|_| usage))
}
