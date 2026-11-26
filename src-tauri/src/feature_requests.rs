//! Feature request cards: when the user wants something PandaCode itself does not do, the
//! agent suggests it once with `pandacode_suggest_feature`. The suggestion is stored in app
//! data and shown as a card in the thread; the user sends it, does it themselves or hides it.
//! Nothing is sent from here: no network, and the agent never opens an issue.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager};

use crate::{agent_tools::spec, providers::ToolHost, AppState};

type Result<T> = std::result::Result<T, String>;

const FILE: &str = "feature-requests.json";
const TOOL: &str = "pandacode_suggest_feature";
const EVENT: &str = "feature-requests-changed";
const MAX_TITLE: usize = 120;
const MAX_DESCRIPTION: usize = 4000;
const MAX_ITEMS: usize = 100;
const MAX_PER_SESSION: usize = 50;
const MAX_FILE: u64 = 4 * 1024 * 1024;
/// One lock for the file: every change reads, edits and replaces the whole store.
static WRITE: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: String,
    pub session_id: String,
    pub title: String,
    pub description: String,
    pub created_at: i64,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
struct Store {
    #[serde(default = "on")]
    enabled: bool,
    #[serde(default)]
    items: Vec<Item>,
}

fn on() -> bool { true }

impl Default for Store {
    fn default() -> Self { Store { enabled: true, items: Vec::new() } }
}

fn session_name(session_id: &str) -> Result<&str> {
    let ok = (1..=64).contains(&session_id.len()) && session_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    if ok { Ok(session_id) } else { Err("Invalid task id.".into()) }
}

/// Trims both texts and checks them against their limits.
fn clean(title: &str, description: &str) -> Result<(String, String)> {
    let (title, description) = (title.trim(), description.trim());
    if title.is_empty() { return Err("title is required.".into()); }
    if description.is_empty() { return Err("description is required.".into()); }
    if title.chars().count() > MAX_TITLE { return Err(format!("title is limited to {MAX_TITLE} characters.")); }
    if description.chars().count() > MAX_DESCRIPTION { return Err(format!("description is limited to {MAX_DESCRIPTION} characters.")); }
    if title.contains('\0') || description.contains('\0') { return Err("Text must not contain null characters.".into()); }
    Ok((title.to_owned(), description.to_owned()))
}

fn load(dir: &Path) -> Result<Store> {
    let path = dir.join(FILE);
    let meta = match fs::symlink_metadata(&path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Store::default()),
        Err(e) => return Err(e.to_string()),
    };
    if !meta.is_file() || meta.len() > MAX_FILE { return Err("Feature requests file is not a regular file or is too large.".into()); }
    let mut bytes = Vec::new();
    fs::File::open(&path).map_err(|e| e.to_string())?.take(MAX_FILE + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    serde_json::from_slice(&bytes).map_err(|e| format!("Feature requests are not valid: {e}"))
}

/// Replaces the file atomically; never follows a link at the target.
fn save(dir: &Path, store: &Store) -> Result<()> {
    let path = dir.join(FILE);
    if fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink()) { return Err("Feature requests must be a regular file, not a link.".into()); }
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let text = serde_json::to_string_pretty(store).map_err(|e| e.to_string())? + "\n";
    let temp = path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4().simple()));
    fs::write(&temp, text).map_err(|e| e.to_string())?;
    fs::rename(&temp, &path).map_err(|e| { let _ = fs::remove_file(&temp); e.to_string() })
}

/// Edits the store under the lock and writes it back.
fn change<T>(dir: &Path, edit: impl FnOnce(&mut Store) -> Result<T>) -> Result<T> {
    let _guard = WRITE.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut store = load(dir)?;
    let out = edit(&mut store)?;
    save(dir, &store)?;
    Ok(out)
}

pub fn list(dir: &Path, session_id: &str) -> Result<Vec<Item>> {
    session_name(session_id)?;
    Ok(load(dir)?.items.into_iter().filter(|item| item.session_id == session_id).collect())
}

pub fn enabled(dir: &Path) -> Result<bool> { Ok(load(dir)?.enabled) }

pub fn set_enabled(dir: &Path, enabled: bool) -> Result<()> {
    change(dir, |store| { store.enabled = enabled; Ok(()) })
}

/// Stores a suggestion, dropping the oldest ones past the per-task and overall caps.
pub fn add(dir: &Path, session_id: &str, title: &str, description: &str) -> Result<Item> {
    session_name(session_id)?;
    let (title, description) = clean(title, description)?;
    let created_at = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64);
    let item = Item { id: uuid::Uuid::new_v4().to_string(), session_id: session_id.to_owned(), title, description, created_at };
    change(dir, |store| {
        store.items.push(item.clone());
        while store.items.iter().filter(|i| i.session_id == session_id).count() > MAX_PER_SESSION {
            let oldest = store.items.iter().position(|i| i.session_id == session_id).unwrap_or(0);
            store.items.remove(oldest);
        }
        if store.items.len() > MAX_ITEMS { store.items.drain(..store.items.len() - MAX_ITEMS); }
        Ok(item)
    })
}

pub fn update(dir: &Path, id: &str, title: &str, description: &str) -> Result<Item> {
    let (title, description) = clean(title, description)?;
    change(dir, |store| {
        let item = store.items.iter_mut().find(|i| i.id == id).ok_or("That request no longer exists.")?;
        (item.title, item.description) = (title, description);
        Ok(item.clone())
    })
}

/// Removes one suggestion and returns the task it belonged to, `None` when it was gone.
pub fn dismiss(dir: &Path, id: &str) -> Result<Option<String>> {
    change(dir, |store| {
        let at = store.items.iter().position(|i| i.id == id);
        Ok(at.map(|at| store.items.remove(at).session_id))
    })
}

/// Removes the suggestions of deleted tasks; best effort, errors are logged.
pub fn forget(app_data: &Path, session_ids: &[String]) {
    let _guard = WRITE.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let result = load(app_data).and_then(|mut store| {
        let before = store.items.len();
        store.items.retain(|item| !session_ids.contains(&item.session_id));
        if store.items.len() == before { Ok(()) } else { save(app_data, &store) }
    });
    if let Err(error) = result { eprintln!("Could not remove feature requests of deleted tasks: {error}"); }
}

// ---- IPC ----

fn data_dir(app: &tauri::AppHandle) -> Result<PathBuf> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn feature_requests_list(app: tauri::AppHandle, session_id: String) -> Result<Vec<Item>> {
    crate::blocking(move || list(&data_dir(&app)?, &session_id)).await
}
#[tauri::command]
pub async fn feature_request_update(app: tauri::AppHandle, id: String, title: String, description: String) -> Result<Item> {
    let emit_app = app.clone();
    let item = crate::blocking(move || update(&data_dir(&app)?, &id, &title, &description)).await?;
    let _ = emit_app.emit(EVENT, json!({"sessionId": item.session_id}));
    Ok(item)
}
#[tauri::command]
pub async fn feature_request_dismiss(app: tauri::AppHandle, id: String) -> Result<()> {
    let emit_app = app.clone();
    if let Some(session_id) = crate::blocking(move || dismiss(&data_dir(&app)?, &id)).await? {
        let _ = emit_app.emit(EVENT, json!({"sessionId": session_id}));
    }
    Ok(())
}
#[tauri::command]
pub async fn feature_requests_enabled(app: tauri::AppHandle) -> Result<bool> {
    crate::blocking(move || enabled(&data_dir(&app)?)).await
}
#[tauri::command]
pub async fn feature_requests_set_enabled(app: tauri::AppHandle, enabled: bool) -> Result<()> {
    let emit_app = app.clone();
    crate::blocking(move || switch(&data_dir(&app)?, enabled, |payload| { let _ = emit_app.emit(EVENT, payload); })).await
}

/// Saves the switch, then tells every thread to read it again (no session id).
fn switch(dir: &Path, enabled: bool, emit: impl FnOnce(Value)) -> Result<()> {
    set_enabled(dir, enabled)?;
    emit(json!({}));
    Ok(())
}

// ---- Agent tool ----

pub fn catalog() -> Vec<Value> {
    vec![spec("suggest_feature", "Suggest a feature of PandaCode itself, when the user wants something the app does not do (an app feature, not a change to their project). PandaCode shows the user a card in this thread; the user decides whether to open a GitHub issue draft with this text, do it themselves or hide it. Call it once per idea. Write in general terms about PandaCode: no file paths, code, names or secrets from the user\'s project. Never open an issue or send anything yourself.", json!({
        "title":{"type":"string","maxLength":MAX_TITLE,"description":"Short name of the feature."},
        "description":{"type":"string","maxLength":MAX_DESCRIPTION,"description":"The problem the user has and what you propose."},
    }), &["title", "description"])]
}

/// Validates the arguments and stores the suggestion, unless the user turned the cards off.
fn suggest(app: &tauri::AppHandle, session_id: &str, args: &Value) -> Result<Value> {
    crate::agent_tools::validate_spec(&catalog(), TOOL, args)?;
    let text = |key: &str| args[key].as_str().unwrap_or_default().to_owned();
    let (title, description) = (text("title"), text("description"));
    clean(&title, &description)?;
    if crate::headless::active() {
        return Ok(json!({"shown": false, "note": "This task runs on a headless host with no app window, so there is no card to show. Do not suggest features again."}));
    }
    app.state::<AppState>().store.lock().map_err(|e| e.to_string())?.session(session_id)?;
    let dir = data_dir(app)?;
    if !enabled(&dir)? {
        return Ok(json!({"shown": false, "note": "The user turned feature request cards off. Do not suggest features again."}));
    }
    let item = add(&dir, session_id, &title, &description)?;
    Ok(json!({"shown": true, "id": item.id, "note": "The user sees a card in this thread to send it, do it themselves or hide it. Do not open issues or send anything yourself."}))
}

/// Add the feature suggestion tool to every harness turn.
pub fn with_feature_requests(base: Option<ToolHost>, app: tauri::AppHandle, session_id: String, stopped: Arc<AtomicBool>) -> Option<ToolHost> {
    let mut tools = base.as_ref().map_or_else(Vec::new, |host| host.tools.clone());
    let approval_tools = base.as_ref().map_or_else(Default::default, |host| host.approval_tools.clone());
    tools.extend(catalog());
    Some(ToolHost {
        tools,
        approval_tools,
        handler: Arc::new(move |name, args| {
            let (base, app, stopped, session_id) = (base.clone(), app.clone(), stopped.clone(), session_id.clone());
            Box::pin(async move {
                if stopped.load(Ordering::SeqCst) { return Err("Task has stopped.".into()); }
                if name != TOOL {
                    return match base { Some(base) => (base.handler)(name, args).await, None => Err("Unknown PandaCode tool.".into()) };
                }
                let (emit_app, sid) = (app.clone(), session_id.clone());
                let result = crate::blocking(move || suggest(&app, &session_id, &args)).await?;
                if result["shown"] == true { let _ = emit_app.emit(EVENT, json!({"sessionId": sid})); }
                Ok(result)
            })
        }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Temp(PathBuf);
    impl Drop for Temp { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
    fn temp() -> Temp {
        let dir = std::env::temp_dir().join(format!("pandacode-feature-requests-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(&dir).unwrap();
        Temp(dir)
    }
    const SID: &str = "task-1";

    #[test]
    fn adds_lists_per_task_and_persists() {
        let t = temp();
        assert!(list(&t.0, SID).unwrap().is_empty() && enabled(&t.0).unwrap());
        let a = add(&t.0, SID, " Dark mode ", " Needs a night theme ").unwrap();
        let b = add(&t.0, "task-2", "Other", "Elsewhere").unwrap();
        assert_eq!((a.title.as_str(), a.description.as_str(), a.session_id.as_str()), ("Dark mode", "Needs a night theme", SID));
        assert!(a.created_at > 0 && a.id != b.id && uuid::Uuid::parse_str(&a.id).is_ok());
        assert_eq!(list(&t.0, SID).unwrap(), vec![a.clone()]);
        assert_eq!(list(&t.0, "task-2").unwrap(), vec![b]);
        let text = fs::read_to_string(t.0.join(FILE)).unwrap();
        assert!(text.contains("\"sessionId\"") && text.contains("\"createdAt\"") && text.contains("\"enabled\": true"));
        assert!(fs::read_dir(&t.0).unwrap().flatten().all(|e| e.file_name() == FILE), "no temporary file is left behind");
    }

    #[test]
    fn enforces_text_limits_and_task_ids() {
        let t = temp();
        assert!(add(&t.0, SID, &"x".repeat(MAX_TITLE), &"y".repeat(MAX_DESCRIPTION)).is_ok());
        let (long_title, long_text) = ("x".repeat(MAX_TITLE + 1), "y".repeat(MAX_DESCRIPTION + 1));
        let bad = [
            ("", "d"), ("  ", "d"), ("t", ""), ("t", "  "),
            (long_title.as_str(), "d"), ("t", long_text.as_str()), ("t\0", "d"), ("t", "d\0"),
        ];
        for (title, description) in bad { assert!(add(&t.0, SID, title, description).is_err(), "{title:?} {description:?}"); }
        let long_id = "a".repeat(65);
        for sid in ["", "../x", "a/b", long_id.as_str()] { assert!(add(&t.0, sid, "t", "d").is_err() && list(&t.0, sid).is_err(), "{sid:?}"); }
        assert_eq!(list(&t.0, SID).unwrap().len(), 1);
        // Characters count, not bytes.
        assert!(add(&t.0, SID, &"é".repeat(MAX_TITLE), "d").is_ok());
    }

    #[test]
    fn keeps_the_newest_50_per_task_and_100_overall() {
        let t = temp();
        for n in 0..55 { add(&t.0, SID, &format!("t{n}"), "d").unwrap(); }
        let mine = list(&t.0, SID).unwrap();
        assert_eq!((mine.len(), mine[0].title.as_str(), mine[49].title.as_str()), (50, "t5", "t54"));
        for task in ["a", "b", "c"] { for n in 0..40 { add(&t.0, task, &format!("{task}{n}"), "d").unwrap(); } }
        let sizes: Vec<usize> = [SID, "a", "b", "c"].iter().map(|s| list(&t.0, s).unwrap().len()).collect();
        assert_eq!(sizes, [0, 20, 40, 40], "the overall cap drops the oldest first");
        assert_eq!(list(&t.0, "a").unwrap()[0].title, "a20");
    }

    #[test]
    fn updates_and_dismisses() {
        let t = temp();
        let a = add(&t.0, SID, "Old", "old text").unwrap();
        let other = add(&t.0, SID, "Keep", "kept").unwrap();
        let edited = update(&t.0, &a.id, " New ", " new text ").unwrap();
        assert_eq!((edited.id.as_str(), edited.title.as_str(), edited.description.as_str(), edited.created_at), (a.id.as_str(), "New", "new text", a.created_at));
        assert_eq!(list(&t.0, SID).unwrap(), vec![edited.clone(), other.clone()]);
        assert!(update(&t.0, &a.id, "", "x").is_err() && update(&t.0, &a.id, "t", &"y".repeat(MAX_DESCRIPTION + 1)).is_err());
        assert!(update(&t.0, "missing", "t", "d").is_err());
        assert_eq!(list(&t.0, SID).unwrap()[0], edited, "a refused edit changes nothing");
        assert_eq!(dismiss(&t.0, &a.id).unwrap().as_deref(), Some(SID));
        assert_eq!(dismiss(&t.0, &a.id).unwrap(), None);
        assert_eq!(list(&t.0, SID).unwrap(), vec![other]);
    }

    #[test]
    fn the_switch_defaults_on_and_survives_other_changes() {
        let t = temp();
        assert!(enabled(&t.0).unwrap());
        set_enabled(&t.0, false).unwrap();
        assert!(!enabled(&t.0).unwrap());
        add(&t.0, SID, "t", "d").unwrap();
        assert!(!enabled(&t.0).unwrap() && list(&t.0, SID).unwrap().len() == 1);
        set_enabled(&t.0, true).unwrap();
        assert!(enabled(&t.0).unwrap());
        // A file without the key reads as on.
        fs::write(t.0.join(FILE), "{}").unwrap();
        assert!(enabled(&t.0).unwrap());
        fs::write(t.0.join(FILE), "not json").unwrap();
        assert!(enabled(&t.0).is_err() && add(&t.0, SID, "t", "d").is_err());
    }

    #[test]
    fn the_switch_tells_every_thread_and_stays_quiet_when_it_fails() {
        let t = temp();
        let mut sent = Vec::new();
        switch(&t.0, false, |payload| sent.push(payload)).unwrap();
        assert_eq!(sent, vec![json!({})]);
        assert!(!enabled(&t.0).unwrap());
        fs::write(t.0.join(FILE), "not json").unwrap();
        assert!(switch(&t.0, true, |payload| sent.push(payload)).is_err());
        assert_eq!(sent.len(), 1, "no event without a saved change");
    }

    #[test]
    fn deleting_tasks_removes_only_their_requests() {
        let t = temp();
        for task in ["task-a", "task-b", "task-c"] { add(&t.0, task, task, "d").unwrap(); }
        forget(&t.0, &["task-a".to_string(), "../bad".to_string(), "task-b".to_string()]);
        assert!(list(&t.0, "task-a").unwrap().is_empty() && list(&t.0, "task-b").unwrap().is_empty());
        assert_eq!(list(&t.0, "task-c").unwrap().len(), 1);
        // Nothing stored yet is not an error, and no file appears.
        let empty = temp();
        forget(&empty.0, &["task-a".to_string()]);
        assert!(list(&empty.0, "task-a").unwrap().is_empty() && !empty.0.join(FILE).exists());
    }

    #[test]
    fn catalog_names_the_tool_with_the_contract_limits() {
        let tools = catalog();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["name"], TOOL);
        assert_eq!(tools[0]["inputSchema"]["required"], json!(["title", "description"]));
        assert_eq!(tools[0]["inputSchema"]["properties"]["title"]["maxLength"], 120);
        assert_eq!(tools[0]["inputSchema"]["properties"]["description"]["maxLength"], 4000);
        let ok = |args: Value| crate::agent_tools::validate_spec(&tools, TOOL, &args);
        assert!(ok(json!({"title":"t","description":"d"})).is_ok());
        assert!(ok(json!({"title":"t"})).is_err() && ok(json!({"description":"d"})).is_err());
        assert!(ok(json!({"title":"x".repeat(121),"description":"d"})).is_err());
        assert!(ok(json!({"title":"t","description":"y".repeat(4001)})).is_err());
        assert!(ok(json!({"title":"t","description":"d","extra":1})).is_err());
        assert!(ok(json!({"title":"t","description":"y".repeat(4000)})).is_ok());
    }
}
