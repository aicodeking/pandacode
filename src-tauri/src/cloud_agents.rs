//! Cloud agents (docs/cloud-agents.md): a task whose agent runs detached on a cloud
//! machine, through the ordinary provider pipeline with a remote transport.
pub(crate) mod bridge;
pub(crate) mod credentials;
pub(crate) mod resume;
pub(crate) mod setup;
pub(crate) mod sync;
pub(crate) mod tasks;
pub(crate) mod transport;

use crate::{storage::Store, Result};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::OnceLock;
use tauri::Emitter;

pub use bridge::handle as handle_cloud_bridge;

/// `sessions.cloud` (docs/cloud-agents.md → State).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct State {
    pub provider: String,
    /// `provider:native`, once created.
    pub machine: Option<String>,
    pub remote_dir: Option<String>,
    /// The commit the machine's checkout started from.
    pub base: Option<String>,
    pub stage: String,
    pub detail: Option<String>,
    /// The active (or last) run in `~/.pandacode/runs/`; None once it was finalized.
    pub run_id: Option<String>,
    pub offset: u64,
    pub inbox_lines: u64,
    /// The user message that started the active run; a re-attach replaces what came after.
    pub turn_message: i64,
    /// The first prompt, kept until the machine is ready so Retry can send it.
    pub pending_prompt: Option<String>,
}

impl State {
    pub(crate) fn native(&self) -> Option<&str> {
        self.machine.as_deref().and_then(|id| id.split_once(':')).map(|(_, native)| native)
    }
    /// A run that was started and has not been finalized: its output may still need saving
    /// or its changes pulling (whatever the stage, e.g. `syncing` when PandaCode quit).
    pub(crate) fn active(&self) -> bool {
        self.run_id.is_some()
    }
}

/// The webview's `cloud` field: `{provider, label, machine, stage, detail}`.
pub(crate) fn view(json: &str) -> Option<Value> {
    let state: State = serde_json::from_str(json).ok()?;
    let label = crate::cloud::sandbox::AGENT_PROVIDERS.iter().find(|(id, _)| *id == state.provider).map_or(state.provider.as_str(), |(_, label)| label);
    Some(json!({"provider": state.provider, "label": label, "machine": state.machine, "stage": state.stage, "detail": state.detail}))
}

pub(crate) fn load(store: &Store, session_id: &str) -> Result<Option<State>> {
    let json: Option<Option<String>> = store.db.query_row("SELECT cloud FROM sessions WHERE id=?1", [session_id], |r| r.get(0)).optional().map_err(|e| e.to_string())?;
    Ok(json.flatten().and_then(|json| serde_json::from_str(&json).ok()))
}

pub(crate) fn save(store: &Store, session_id: &str, state: Option<&State>) -> Result<()> {
    let json = state.map(serde_json::to_string).transpose().map_err(|e| e.to_string())?;
    store.db.execute("UPDATE sessions SET cloud=?2 WHERE id=?1", rusqlite::params![session_id, json]).map_err(|e| e.to_string())?;
    Ok(())
}

/// Cloud tasks with a run that was started and not finalized.
pub(crate) fn active_runs(store: &Store) -> Result<Vec<String>> {
    let mut statement = store.db.prepare("SELECT id,cloud FROM sessions WHERE cloud IS NOT NULL").map_err(|e| e.to_string())?;
    let rows = statement.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(std::result::Result::ok).filter(|(_, json)| serde_json::from_str::<State>(json).is_ok_and(|s| s.active())).map(|(id, _)| id).collect())
}

static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

/// Called once at startup: the transport and background work reach the store through it.
pub(crate) fn init(app: &tauri::AppHandle) {
    let _ = APP.set(app.clone());
    resume::start(app.clone());
}

pub(crate) fn app() -> Option<&'static tauri::AppHandle> {
    APP.get()
}

/// Changes a cloud task's state under the store lock, then tells the window.
pub(crate) fn update(app: &tauri::AppHandle, session_id: &str, change: impl FnOnce(&mut State)) -> Result<State> {
    use tauri::Manager;
    let state = {
        let app_state = app.state::<crate::AppState>();
        let store = app_state.store.lock().map_err(|e| e.to_string())?;
        let mut state = load(&store, session_id)?.ok_or("This task does not run on a cloud machine.")?;
        let before = state.clone();
        change(&mut state);
        if state == before {
            return Ok(state);
        }
        save(&store, session_id, Some(&state))?;
        if (&state.stage, &state.detail) == (&before.stage, &before.detail) {
            return Ok(state);
        }
        state
    };
    let _ = app.emit("cloud-agent://progress", json!({"sessionId": session_id, "stage": state.stage, "detail": state.detail}));
    let _ = app.emit("sessions-changed", ());
    Ok(state)
}

/// Sets the stage and detail shown on the task.
pub(crate) fn stage(app: &tauri::AppHandle, session_id: &str, stage: &str, detail: Option<&str>) {
    let result = update(app, session_id, |state| {
        state.stage = stage.into();
        state.detail = detail.map(str::to_owned);
    });
    if let Err(error) = result {
        eprintln!("Cloud agents: could not save a task's progress: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_27_adds_the_cloud_column_and_the_session_shows_it() {
        let path = std::env::temp_dir().join(format!("pandacode-cloud-{}.sqlite3", uuid::Uuid::new_v4()));
        {
            let store = Store::open(&path).unwrap();
            store.db.execute_batch("ALTER TABLE sessions DROP COLUMN cloud; PRAGMA user_version=26;").unwrap();
        }
        let store = Store::open(&path).unwrap();
        assert_eq!((crate::storage::SCHEMA_VERSION, store.db.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0)).unwrap()), (28, 28));
        let project = store.add_project(&std::env::temp_dir()).unwrap();
        let task = store.create_session(&project.id, "claude", "sonnet", "full").unwrap();
        assert_eq!(task.cloud, None);
        let state = State { provider: "e2b".into(), machine: Some("e2b:abc".into()), stage: "running".into(), run_id: Some("r".into()), ..State::default() };
        save(&store, &task.id, Some(&state)).unwrap();
        assert_eq!(load(&store, &task.id).unwrap(), Some(state.clone()));
        assert_eq!(state.native(), Some("abc"));
        assert_eq!(store.session(&task.id).unwrap().cloud, Some(json!({"provider": "e2b", "label": "E2B", "machine": "e2b:abc", "stage": "running", "detail": null})));
        assert_eq!(active_runs(&store).unwrap(), vec![task.id.clone()]);
        // Quitting while the changes come back keeps the run re-attachable.
        save(&store, &task.id, Some(&State { stage: "syncing".into(), ..state.clone() })).unwrap();
        assert_eq!(active_runs(&store).unwrap(), vec![task.id.clone()]);
        save(&store, &task.id, Some(&State { stage: "ready".into(), run_id: None, ..state })).unwrap();
        assert!(active_runs(&store).unwrap().is_empty());
        drop(store);
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    }
}
