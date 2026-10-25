//! Brings conversations started in the Claude Code or Codex CLI into PandaCode.
//! Each import becomes a task in the project for the conversation's folder
//! (added if needed) with its readable history, and resumes the same agent
//! session on the next prompt. Nothing is sent to a model while importing.

mod claude;
mod copilot;
#[cfg(test)]
mod tests;

use crate::{command_operations, integrations::ControlClient, storage::Session, AppState, Result};
use serde::Serialize;
use serde_json::json;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{Emitter, Manager};

const CLAUDE_SCAN_LIMIT: usize = 400;
const MAX_IMPORT: usize = 50;
const COPILOT_SCAN_LIMIT: usize = 400;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Importable {
    id: String,
    title: String,
    folder: String,
    updated_at: i64,
    messages: Option<u32>,
    model: Option<String>,
    /// The PandaCode task already continuing this conversation.
    imported_task_id: Option<String>,
    /// Why it cannot be imported, such as a folder that no longer exists.
    unavailable: Option<String>,
    /// `local`, `synced`, or `hosted`; shown as a source badge in the picker.
    source_kind: String,
    /// The transcript can be imported but the existing harness cannot resume it.
    transcript_only: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPage {
    items: Vec<Importable>,
    cursor: Option<String>,
    note: Option<String>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    imported: Vec<Session>,
    existing: Vec<String>,
    failed: Vec<ImportFailure>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportFailure {
    id: String,
    message: String,
}

/// Claude log summaries keyed by path, reused while a file is unchanged.
type SummaryCache = HashMap<PathBuf, (u64, std::time::SystemTime, Option<claude::Summary>)>;
fn summaries() -> &'static Mutex<SummaryCache> {
    static CACHE: std::sync::OnceLock<Mutex<SummaryCache>> = std::sync::OnceLock::new();
    CACHE.get_or_init(Default::default)
}

fn cached_summary(path: &Path) -> Option<claude::Summary> {
    let meta = std::fs::metadata(path).ok()?;
    let key = (meta.len(), meta.modified().ok()?);
    if let Some((len, modified, summary)) = summaries().lock().ok()?.get(path) {
        if (*len, *modified) == key {
            return summary.clone();
        }
    }
    let summary = claude::summarize(path);
    if let Ok(mut cache) = summaries().lock() {
        cache.insert(path.to_path_buf(), (key.0, key.1, summary.clone()));
    }
    summary
}

fn folder_problem(folder: &str) -> Option<String> {
    if folder.is_empty() {
        return Some("The conversation does not record its folder.".into());
    }
    (!Path::new(folder).is_dir()).then(|| "Its folder no longer exists on this computer.".into())
}

fn matches(search: &Option<String>, fields: &[&str]) -> bool {
    search.as_deref().map(str::trim).filter(|query| !query.is_empty()).is_none_or(|query| {
        let query = query.to_lowercase();
        fields.iter().any(|field| field.to_lowercase().contains(&query))
    })
}

fn claude_items(state: &AppState, search: &Option<String>) -> Result<Vec<Importable>> {
    let logs = claude::logs(&crate::usage_ledger::claude_roots(), CLAUDE_SCAN_LIMIT);
    let summaries: Vec<(PathBuf, claude::Summary)> = logs.into_iter().filter_map(|path| cached_summary(&path).map(|summary| (path, summary))).collect();
    let store = state.store.lock().map_err(|e| e.to_string())?;
    let mut seen = std::collections::HashSet::new();
    let mut items = Vec::new();
    for (_, summary) in summaries {
        // A resumed Claude session can appear in more than one log; list it once.
        if !seen.insert(summary.session_id.clone()) || !matches(search, &[&summary.title, &summary.cwd]) {
            continue;
        }
        items.push(Importable {
            imported_task_id: store.imported_task("claude", &summary.session_id)?,
            unavailable: folder_problem(&summary.cwd),
            id: summary.session_id,
            title: summary.title,
            folder: summary.cwd,
            updated_at: summary.updated_at,
            messages: Some(summary.messages),
            model: summary.model,
            source_kind: "local".into(),
            transcript_only: false,
        });
    }
    items.sort_by_key(|item| std::cmp::Reverse(item.updated_at));
    Ok(items)
}

fn codex_home() -> PathBuf {
    crate::agent_usage_providers::home().unwrap_or_else(std::env::temp_dir)
}

async fn codex_page(state: &AppState, search: &Option<String>, cursor: &Option<String>) -> Result<ImportPage> {
    let Ok(mut client) = ControlClient::start(&codex_home()).await else {
        return Ok(ImportPage { items: Vec::new(), cursor: None, note: Some("Codex is not available. Check that its CLI is installed and signed in.".into()) });
    };
    let response = client
        .request("thread/list", json!({"cursor":cursor,"searchTerm":search.as_deref().map(str::trim).filter(|s| !s.is_empty()),"limit":50,"sortKey":"updated_at","sortDirection":"desc","useStateDbOnly":true}))
        .await;
    client.finish().await;
    let response = response?;
    let store = state.store.lock().map_err(|e| e.to_string())?;
    let mut items = Vec::new();
    for thread in response["data"].as_array().into_iter().flatten().take(50) {
        // Subagent threads belong to their parent conversation.
        if !thread["parentThreadId"].is_null() || thread["ephemeral"] == true {
            continue;
        }
        let Ok(id) = command_operations::remote_id(&thread["id"]) else { continue };
        let folder = command_operations::clean(&thread["cwd"], 4096);
        items.push(Importable {
            imported_task_id: store.imported_task("codex", &id)?,
            unavailable: folder_problem(&folder),
            title: command_operations::nonempty(&thread["name"], 160).or_else(|| command_operations::nonempty(&thread["preview"], 160)).unwrap_or_else(|| "Untitled conversation".into()),
            updated_at: thread["updatedAt"].as_i64().map_or(0, |seconds| seconds * 1000),
            messages: None,
            model: command_operations::nonempty(&thread["model"], 160),
            folder,
            id,
            source_kind: "local".into(),
            transcript_only: false,
        });
    }
    Ok(ImportPage { items, cursor: command_operations::nonempty(&response["nextCursor"], 4096), note: None })
}

#[tauri::command]
pub async fn list_importable_conversations(app: tauri::AppHandle, window: tauri::WebviewWindow, provider: String, search: Option<String>, cursor: Option<String>, include_cloud: Option<bool>) -> Result<ImportPage> {
    if window.label() != "main" {
        return Err("Conversations can be imported only from the main window.".into());
    }
    let search = search.map(|text| text.chars().take(200).collect::<String>());
    match provider.as_str() {
        "claude" => {
            let app = app.clone();
            crate::blocking(move || {
                let items = claude_items(&app.state::<AppState>(), &search)?;
                let note = items.is_empty().then(|| "No Claude Code conversations were found on this computer.".to_owned());
                Ok(ImportPage { items, cursor: None, note })
            })
            .await
        }
        "codex" => codex_page(&app.state::<AppState>(), &search, &cursor).await,
        "github-copilot" => {
            // Reading and parsing the logs is disk work; keep it off the async
            // runtime and out of every search keystroke, like the Claude path.
            let listed = crate::blocking(move || Ok(copilot::prepared_logs(&copilot::home(), COPILOT_SCAN_LIMIT))).await?;
            copilot_page(&app.state::<AppState>(), &search, include_cloud.unwrap_or(false), listed).await
        }
        _ => Err("Import conversations from Claude Code, Codex, or GitHub Copilot CLI.".into()),
    }
}

fn project_for_repository(store: &crate::storage::Store, repository: &str) -> Result<Option<String>> {
    Ok(store.projects()?.into_iter().find_map(|project| {
        crate::github_hub::project_repo(Path::new(&project.path))
            .filter(|candidate| candidate.eq_ignore_ascii_case(repository))
            .map(|_| project.id)
    }))
}

async fn copilot_page(state: &AppState, search: &Option<String>, include_cloud: bool, listed: Vec<(String, copilot::Prepared)>) -> Result<ImportPage> {
    let root = copilot::home();
    let mut items = Vec::new();
    let mut local_ids = std::collections::HashSet::new();
    for (id, parsed) in listed {
        local_ids.insert(id.clone());
        let Some(summary) = parsed.summary else {
            let Some(message) = parsed.unavailable else { continue };
            let store = state.store.lock().map_err(|e| e.to_string())?;
            let imported_task_id = store.imported_task("github-copilot", &id)?;
            items.push(Importable {
                id,
                title: "Copilot session cannot be imported".into(),
                folder: String::new(),
                updated_at: 0,
                messages: None,
                model: None,
                imported_task_id,
                unavailable: Some(message),
                source_kind: "local".into(),
                transcript_only: false,
            });
            continue;
        };
        if !matches(search, &[&summary.title, &summary.folder]) {
            continue;
        }
        let store = state.store.lock().map_err(|e| e.to_string())?;
        items.push(Importable {
            imported_task_id: store.imported_task("github-copilot", &summary.id)?,
            unavailable: folder_problem(&summary.folder),
            id: summary.id,
            title: summary.title,
            folder: summary.folder,
            updated_at: summary.updated_at,
            messages: Some(summary.messages),
            model: summary.model,
            source_kind: "local".into(),
            transcript_only: false,
        });
    }

    let mut note = None;
    if include_cloud {
        if let Some(program) = crate::providers::executable("github-copilot") {
            match copilot::cloud_sessions(&root, &program, &local_ids).await {
                Ok(sessions) if sessions.is_empty() => note = Some("Copilot CLI did not return any synced or GitHub-hosted sessions. Update Copilot CLI if you expected cloud sessions here.".into()),
                Ok(sessions) => {
                    let store = state.store.lock().map_err(|e| e.to_string())?;
                    for cloud in sessions {
                        if !matches(search, &[&cloud.title]) {
                            continue;
                        }
                        items.push(Importable {
                            imported_task_id: store.imported_task("github-copilot", &cloud.id)?,
                            id: cloud.id,
                            title: cloud.title,
                            // Session metadata omits repository context. Resolve it from
                            // the transcript only after the user selects the session.
                            folder: "Repository checked on import".into(),
                            updated_at: cloud.updated_at,
                            messages: None,
                            model: None,
                            unavailable: None,
                            source_kind: copilot::cloud_source_kind(cloud.is_remote).into(),
                            transcript_only: cloud.is_remote,
                        });
                    }
                }
                Err(message) => note = Some(message),
            }
        } else {
            note = Some("GitHub Copilot CLI is not installed or its executable is not configured.".into());
        }
    }
    items.sort_by_key(|item| std::cmp::Reverse(item.updated_at));
    if items.is_empty() && note.is_none() {
        note = Some(if include_cloud {
            "No local or cloud Copilot CLI conversations were found.".into()
        } else {
            "No local Copilot CLI conversations were found on this computer.".into()
        });
    }
    Ok(ImportPage { items, cursor: None, note })
}

fn project_for(store: &crate::storage::Store, folder: &str) -> Result<String> {
    if let Some(problem) = folder_problem(folder) {
        return Err(problem);
    }
    let canonical = Path::new(folder).canonicalize().map_err(|e| format!("Cannot open its folder: {e}"))?;
    if let Some(project) = store.projects()?.into_iter().find(|project| Path::new(&project.path).canonicalize().is_ok_and(|path| path == canonical)) {
        return Ok(project.id);
    }
    Ok(store.add_project(&canonical)?.id)
}

fn import_claude(state: &AppState, id: &str, fallback_model: &str) -> Result<Session> {
    let path = claude::logs(&crate::usage_ledger::claude_roots(), usize::MAX)
        .into_iter()
        .find(|path| cached_summary(path).is_some_and(|summary| summary.session_id == id))
        .ok_or("This Claude Code conversation was not found. Refresh the list.")?;
    let summary = cached_summary(&path).ok_or("This conversation has nothing to import.")?;
    let entries = claude::history(&path);
    let store = state.store.lock().map_err(|e| e.to_string())?;
    let project = project_for(&store, &summary.cwd)?;
    let model = summary.model.as_deref().unwrap_or(fallback_model);
    store.import_task(&project, "claude", model, &summary.title, id, None, summary.created_at, &entries)
}

async fn import_codex(state: &AppState, id: &str, fallback_model: &str) -> Result<Session> {
    let mut client = ControlClient::start(&codex_home()).await?;
    let read = client.request("thread/read", json!({"threadId":id,"includeTurns":false})).await;
    client.finish().await;
    let thread = read?["thread"].clone();
    if command_operations::remote_id(&thread["id"])? != id {
        return Err("Codex returned a different conversation.".into());
    }
    let folder = command_operations::clean(&thread["cwd"], 4096);
    if let Some(problem) = folder_problem(&folder) {
        return Err(problem);
    }
    let cwd = Path::new(&folder).canonicalize().map_err(|e| e.to_string())?;
    let history = command_operations::conversation_messages(&cwd, id).await?;
    let updated = thread["updatedAt"].as_i64().map_or_else(crate::storage::now, |seconds| seconds * 1000);
    let created = thread["createdAt"].as_i64().map_or(updated, |seconds| seconds * 1000);
    let entries: Vec<(&str, String, i64)> = history
        .into_iter()
        .filter_map(|(role, content)| {
            let role = match role.as_str() { "user" => "user", "assistant" => "assistant", "tool" => "tool", _ => return None };
            Some((role, content, updated))
        })
        .collect();
    let title = command_operations::nonempty(&thread["name"], 160).or_else(|| command_operations::nonempty(&thread["preview"], 160)).unwrap_or_else(|| "Imported Codex conversation".into());
    let model = command_operations::nonempty(&thread["model"], 160).unwrap_or_else(|| fallback_model.to_owned());
    let effort = command_operations::nonempty(&thread["reasoningEffort"], 32);
    let store = state.store.lock().map_err(|e| e.to_string())?;
    if let Some(existing) = store.imported_task("codex", id)? {
        return store.session(&existing);
    }
    let project = project_for(&store, &folder)?;
    store.import_task(&project, "codex", &model, &title, id, effort.as_deref(), created, &entries)
}

async fn import_copilot(state: &AppState, id: &str, include_cloud: bool, fallback_model: &str) -> Result<Session> {
    if !copilot::valid_id(id) {
        return Err("Not a valid Copilot conversation identifier.".into());
    }
    let root = copilot::home();
    if let Some((_, path)) = copilot::logs(&root, usize::MAX).into_iter().find(|(candidate, _)| candidate == id) {
        let events = copilot::read_events(&path)?;
        let summary = copilot::summarize(id, &events).ok_or("This Copilot conversation has no readable messages.")?;
        if let Some(problem) = folder_problem(&summary.folder) {
            return Err(problem);
        }
        let entries = copilot::history(&events);
        let store = state.store.lock().map_err(|e| e.to_string())?;
        let project = project_for(&store, &summary.folder)?;
        let model = summary.model.as_deref().unwrap_or(fallback_model);
        return store.import_copilot_task(&project, model, &summary.title, id, Some(id), false, summary.created_at, &entries);
    }
    if !include_cloud {
        return Err("Cloud sessions are hidden until Include cloud sessions is enabled.".into());
    }
    let program = crate::providers::executable("github-copilot").ok_or("GitHub Copilot CLI is not installed or its executable is not configured.")?;
    let (cloud, events) = copilot::cloud_session_with_transcript(&root, &program, id).await?;
    let entries = copilot::history(&events);
    if entries.is_empty() {
        return Err("Copilot did not provide a readable transcript for this session.".into());
    }
    let repository = copilot::repository(&events).ok_or("Copilot did not provide a repository for this cloud session. Open its repository as a project, then import again.")?;
    let store = state.store.lock().map_err(|e| e.to_string())?;
    let project = project_for_repository(&store, &repository)?.ok_or_else(|| format!("Open {repository} as a project before importing this cloud session."))?;
    let transcript_only = cloud.is_remote;
    store.import_copilot_task(
        &project,
        fallback_model,
        &cloud.title,
        id,
        (!transcript_only).then_some(id),
        transcript_only,
        cloud.created_at,
        &entries,
    )
}

#[tauri::command]
pub async fn import_conversations(app: tauri::AppHandle, window: tauri::WebviewWindow, provider: String, ids: Vec<String>, model: Option<String>, include_cloud: Option<bool>) -> Result<ImportResult> {
    if window.label() != "main" {
        return Err("Conversations can be imported only from the main window.".into());
    }
    if ids.is_empty() || ids.len() > MAX_IMPORT {
        return Err(format!("Choose between 1 and {MAX_IMPORT} conversations to import."));
    }
    if !matches!(provider.as_str(), "claude" | "codex" | "github-copilot") {
        return Err("Import conversations from Claude Code, Codex, or GitHub Copilot CLI.".into());
    }
    let include_cloud = include_cloud.unwrap_or(false);
    let fallback = model.filter(|model| !model.trim().is_empty() && model.len() <= 200).unwrap_or_else(|| "default".into());
    let mut result = ImportResult::default();
    for id in ids {
        if (provider == "github-copilot" && !copilot::valid_id(&id)) || (provider != "github-copilot" && uuid::Uuid::parse_str(&id).is_err()) {
            result.failed.push(ImportFailure { id, message: "Not a valid conversation identifier.".into() });
            continue;
        }
        let state = app.state::<AppState>();
        let existing = state.store.lock().map_err(|e| e.to_string())?.imported_task(&provider, &id)?;
        if let Some(task) = existing {
            result.existing.push(task);
            continue;
        }
        let imported = if provider == "claude" {
            let (app, id, fallback) = (app.clone(), id.clone(), fallback.clone());
            crate::blocking(move || import_claude(&app.state::<AppState>(), &id, &fallback)).await
        } else if provider == "github-copilot" {
            import_copilot(&state, &id, include_cloud, &fallback).await
        } else {
            import_codex(&state, &id, &fallback).await
        };
        match imported {
            Ok(task) => result.imported.push(task),
            Err(message) => result.failed.push(ImportFailure { id, message }),
        }
    }
    if !result.imported.is_empty() {
        let _ = app.emit("sessions-changed", ());
    }
    Ok(result)
}

