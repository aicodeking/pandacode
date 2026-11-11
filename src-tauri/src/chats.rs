//! Projectless chats: each chat runs in its own PandaCode-managed folder under
//! `~/PandaCode Chats/`, registered as an ordinary project that the window hides
//! from the project list. A project is a chat when its folder sits directly in
//! that root, so no schema change is needed.

use crate::storage::{Session, Store};
use crate::AppState;
use rusqlite::params;
use std::path::{Path, PathBuf};
use tauri::{Emitter, State};

type Result<T> = std::result::Result<T, String>;

/// Files PandaCode itself may leave in a chat folder; anything else is the user's.
const OWN_FILES: [&str; 2] = [".pandacode", ".DS_Store"];

pub(crate) fn root() -> PathBuf {
    crate::agent_usage_providers::home().unwrap_or_else(std::env::temp_dir).join("PandaCode Chats")
}

fn in_root(folder: &Path, root: &Path) -> bool {
    let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    folder.parent() == Some(root.as_path())
}

/// Whether a task folder is a projectless chat's.
pub(crate) fn is_chat_folder(folder: &Path) -> bool {
    in_root(folder, &root())
}

/// Makes the chat's folder, registers it as a project and starts its task. `team`: whether the
/// saved default team applies (off for a phone without "Full access for remote tasks": a team's
/// workers always run in full access).
pub(crate) fn create(store: &Store, root: &Path, provider: &str, model: &str, mode: Option<&str>, team: bool) -> Result<Session> {
    let id = crate::storage::id();
    let folder = root.join(format!("chat-{}", &id[..8]));
    std::fs::create_dir_all(&folder).map_err(|e| format!("Could not create the chat's folder: {e}"))?;
    let project = store.add_project(&folder)?;
    store.db.execute("UPDATE projects SET name='Chat' WHERE id=?1", params![project.id]).map_err(|e| e.to_string())?;
    if team {
        crate::architect::profiles::create_user_task(store, &project.id, provider, model, mode, None)
    } else {
        crate::architect::profiles::create_task_without_team(store, &project.id, provider, model, mode, None)
    }
}

/// The folder of a chat project no task uses any more.
fn unused_folder(store: &Store, root: &Path, project_id: &str) -> Result<Option<PathBuf>> {
    let Ok(project) = store.project(project_id) else { return Ok(None) };
    let folder = PathBuf::from(&project.path);
    if !in_root(&folder, root) {
        return Ok(None);
    }
    let used: bool = store.db.query_row("SELECT EXISTS(SELECT 1 FROM sessions WHERE project_id=?1)", [project_id], |r| r.get(0)).map_err(|e| e.to_string())?;
    Ok((!used).then_some(folder))
}

/// Forgets a chat project once no task uses it, and removes its folder when
/// only PandaCode's own files are left. Other projects are never touched.
pub(crate) fn cleanup(store: &Store, root: &Path, project_id: &str) -> Result<bool> {
    let Some(folder) = unused_folder(store, root, project_id)? else { return Ok(false) };
    store.remove_project(project_id)?;
    let only_ours = std::fs::read_dir(&folder)
        .map(|entries| entries.flatten().all(|entry| OWN_FILES.iter().any(|name| entry.file_name() == *name)))
        .unwrap_or(false);
    if only_ours {
        std::fs::remove_dir_all(&folder).map_err(|e| format!("Could not remove the chat's folder: {e}"))?;
    }
    Ok(true)
}

#[tauri::command]
pub async fn chat_create(app: tauri::AppHandle, state: State<'_, AppState>, provider: String, model: String, mode: Option<String>) -> Result<Session> {
    let task = create(&*state.store.lock().map_err(|e| e.to_string())?, &root(), &provider, &model, mode.as_deref(), true)?;
    let _ = app.emit("sessions-changed", ());
    Ok(task)
}

/// Called after a chat's task is deleted or moved to a real project.
#[tauri::command]
pub async fn chat_cleanup(state: State<'_, AppState>, project_id: String) -> Result<bool> {
    let folder = unused_folder(&*state.store.lock().map_err(|e| e.to_string())?, &root(), &project_id)?;
    // A task moved out of the chat can leave its agent lingering here, which on Windows blocks removal.
    if let Some(folder) = folder {
        crate::providers::end_lingering_in(&folder).await;
    }
    cleanup(&*state.store.lock().map_err(|e| e.to_string())?, &root(), &project_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> (PathBuf, PathBuf, Store) {
        let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&dir).unwrap();
        let store = Store::open(&dir.join("test.sqlite")).unwrap();
        (dir.clone(), dir.join("PandaCode Chats"), store)
    }

    #[test]
    fn a_chat_gets_its_own_hidden_folder_and_is_cleaned_up_with_its_last_task() {
        let (dir, root, store) = setup();
        let task = create(&store, &root, "claude", "default", None, true).unwrap();
        let project = store.project(&task.project_id).unwrap();
        assert_eq!(project.name, "Chat");
        assert!(in_root(Path::new(&project.path), &root));
        // A task still uses the chat: nothing is removed.
        assert!(!cleanup(&store, &root, &project.id).unwrap());
        store.db.execute("DELETE FROM sessions WHERE id=?1", [&task.id]).unwrap();
        std::fs::create_dir(Path::new(&project.path).join(".pandacode")).unwrap();
        assert!(cleanup(&store, &root, &project.id).unwrap());
        assert!(store.project(&project.id).is_err());
        assert!(!Path::new(&project.path).exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_chat_without_team_never_gets_the_saved_default_team() {
        let (dir, root, store) = setup();
        let library = serde_json::json!({"enabled": true, "lastSetup": {"architect": {"provider": "codex", "model": "default", "reasoningEffort": null}, "config": {"auto": true, "workers": [], "catalog": [{"id": "a", "name": "A", "provider": "codex", "model": "default", "reasoningEffort": null}], "maxParallel": 0, "maxRounds": 8, "maxAssignments": 24, "workspace": "shared", "summaryLimit": 3072}}, "activeProfileId": null, "profiles": []});
        store.db.execute("INSERT OR REPLACE INTO architect_library(id,content) VALUES(1,?1)", [library.to_string()]).unwrap();
        let leads_team = |sid: &str| -> bool { store.db.query_row("SELECT EXISTS(SELECT 1 FROM architect_teams WHERE session_id=?1)", [sid], |r| r.get(0)).unwrap() };
        // A phone's chat.start without "Full access for remote tasks" passes team: false.
        let plain = create(&store, &root, "codex", "default", None, false).unwrap();
        assert!(!leads_team(&plain.id));
        let desktop = create(&store, &root, "codex", "default", None, true).unwrap();
        assert!(leads_team(&desktop.id), "the desktop's chat keeps the saved default team");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn user_files_keep_the_folder_and_other_projects_are_never_cleaned() {
        let (dir, root, store) = setup();
        let task = create(&store, &root, "claude", "default", None, true).unwrap();
        let folder = PathBuf::from(store.project(&task.project_id).unwrap().path);
        std::fs::write(folder.join("notes.md"), "keep").unwrap();
        store.db.execute("DELETE FROM sessions WHERE id=?1", [&task.id]).unwrap();
        assert!(cleanup(&store, &root, &task.project_id).unwrap());
        assert!(folder.join("notes.md").exists());

        let other = dir.join("work");
        std::fs::create_dir(&other).unwrap();
        let project = store.add_project(&other).unwrap();
        assert!(!cleanup(&store, &root, &project.id).unwrap());
        assert!(store.project(&project.id).is_ok());
        let _ = std::fs::remove_dir_all(dir);
    }
}
