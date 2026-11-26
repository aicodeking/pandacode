//! User-owned reusable team setups. Runtime worker sessions never inherit this library.
use super::{TeamConfig, TeamSnapshot};
use crate::{
    storage::{self, Session, Store},
    AppState, Result,
};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelSelection {
    pub provider: String,
    pub model: String,
    #[serde(default)]
    pub reasoning_effort: Option<String>,
}
impl ModelSelection {
    pub fn from_session(session: &Session) -> Self {
        Self {
            provider: session.provider.clone(),
            model: session.model.clone(),
            reasoning_effort: session.reasoning_effort.clone(),
        }
    }
    fn validate(&self) -> Result<()> {
        if ![
            "claude",
            "codex",
            "kimi",
            "opencode",
            "glm",
            "antigravity",
            "grok",
            "mimo",
            "alibaba",
            "pi",
            "deepseek",
            "commandcode",
            "cline",
            "kilo",
            "omp",
            "github-copilot",
            "muse",
            "devin",
            "hermes",
            "cursor",
        ]
        .contains(&self.provider.as_str())
            || self.model.len() > 200
            || self.model.contains('\0')
        {
            return Err("Choose a supported harness and a model ID under 200 bytes.".into());
        }
        crate::providers::validate_reasoning_effort(
            &self.provider,
            self.reasoning_effort.as_deref(),
        )
    }
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TeamSetup {
    pub architect: ModelSelection,
    pub config: TeamConfig,
}
impl TeamSetup {
    pub fn validate(&self) -> Result<()> {
        self.architect.validate()?;
        self.config.validate()
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TeamProfile {
    pub id: String,
    pub name: String,
    pub setup: TeamSetup,
    pub updated_at: i64,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TeamLibrary {
    pub enabled: bool,
    pub last_setup: Option<TeamSetup>,
    pub active_profile_id: Option<String>,
    pub profiles: Vec<TeamProfile>,
    /// Lead guidance for every team that does not set its own, from Settings.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lead_guidance: Option<String>,
}

pub(crate) fn initialize(store: &Store) -> Result<()> {
    let exists: bool = store
        .db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM architect_library WHERE id=1)",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if exists {
        return Ok(());
    }
    // Only a missing library is seeded. Explicitly disabling defaults is durable.
    let mut library = TeamLibrary::default();
    {
        let mut statement = store.db.prepare(
            "SELECT s.provider, s.model, s.reasoning_effort, CAST(json_extract(t.content, '$.config') AS TEXT)
             FROM architect_teams t JOIN sessions s ON s.id=t.session_id
             WHERE json_valid(t.content, 6) AND json_extract(t.content, '$.config') IS NOT NULL
             ORDER BY json_extract(t.content, '$.updatedAt') DESC",
        ).map_err(|e| e.to_string())?;
        let snapshots = statement.query_map([], |row| {
            let architect = ModelSelection {
                provider: row.get(0)?,
                model: row.get(1)?,
                reasoning_effort: row.get(2)?,
            };
            Ok((architect, row.get::<_, String>(3)?))
        }).map_err(|e| e.to_string())?;
        for snapshot in snapshots {
            let (architect, config) = match snapshot {
                Ok(snapshot) => snapshot,
                Err(rusqlite::Error::InvalidColumnType(..) | rusqlite::Error::FromSqlConversionFailure(..)) => continue,
                Err(error) => return Err(error.to_string()),
            };
            let Ok(config) = serde_json::from_str(&config) else { continue };
            let setup = TeamSetup { architect, config };
            if setup.validate().is_ok() {
                library.enabled = true;
                library.last_setup = Some(setup);
                break;
            }
        }
    }
    let content = serde_json::to_string(&library).map_err(|e| e.to_string())?;
    store
        .db
        .execute(
            "INSERT OR IGNORE INTO architect_library(id,content) VALUES(1,?1)",
            [content],
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}
pub(crate) fn read(store: &Store) -> Result<TeamLibrary> {
    let content = store
        .db
        .query_row(
            "SELECT content FROM architect_library WHERE id=1",
            [],
            |r| r.get::<_, String>(0),
        )
        .map_err(|e| e.to_string())?;
    serde_json::from_str(&content).map_err(|e| format!("Saved team library is invalid: {e}"))
}
/// A saved profile never carries a team's model catalog (every installed model, up to 1000): it is
/// rebuilt when the team turns on. `last_setup` keeps it, so a new task inheriting an auto team
/// routes over every model and not just the roster.
fn strip_catalog(setup: &mut TeamSetup) {
    setup.config.catalog = Vec::new();
}
/// Whether a profile is this setup: a catalog is no part of a profile's identity.
fn same_setup(profile: &TeamSetup, setup: Option<&TeamSetup>) -> bool {
    setup.is_some_and(|setup| {
        let mut setup = setup.clone();
        strip_catalog(&mut setup);
        let mut profile = profile.clone();
        strip_catalog(&mut profile);
        profile == setup
    })
}
fn write(store: &Store, library: &TeamLibrary) -> Result<()> {
    let mut library = library.clone();
    library.profiles.iter_mut().for_each(|p| strip_catalog(&mut p.setup));
    let content = serde_json::to_string(&library).map_err(|e| e.to_string())?;
    store
        .db
        .execute(
            "UPDATE architect_library SET content=?1 WHERE id=1",
            [content],
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}
fn validate_name(name: &str) -> Result<String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 80 || name.chars().any(char::is_control) {
        return Err("Profile names must be 1–80 characters without control characters.".into());
    }
    Ok(name.into())
}
pub(crate) fn save_profile(
    store: &Store,
    id: Option<String>,
    name: String,
    mut setup: TeamSetup,
) -> Result<TeamLibrary> {
    setup.validate()?;
    // Council is per task: a saved team profile never carries it.
    setup.config.council = None;
    let name = validate_name(&name)?;
    let transaction = store
        .db
        .unchecked_transaction()
        .map_err(|e| e.to_string())?;
    let mut library = read(store)?;
    if library
        .profiles
        .iter()
        .any(|p| p.name.to_lowercase() == name.to_lowercase() && Some(&p.id) != id.as_ref())
    {
        return Err("A team profile with this name already exists.".into());
    }
    if let Some(id) = id {
        let profile = library
            .profiles
            .iter_mut()
            .find(|p| p.id == id)
            .ok_or("This team profile no longer exists.")?;
        profile.name = name;
        profile.setup = setup;
        profile.updated_at = storage::now();
    } else {
        library.profiles.push(TeamProfile {
            id: storage::id(),
            name,
            setup,
            updated_at: storage::now(),
        });
    }
    // Named profile edits never silently replace the applied default or current task.
    if library.active_profile_id.as_ref().is_some_and(|id| {
        library
            .profiles
            .iter()
            .find(|p| p.id == *id)
            .is_none_or(|p| !same_setup(&p.setup, library.last_setup.as_ref()))
    }) {
        library.active_profile_id = None;
    }
    write(store, &library)?;
    transaction.commit().map_err(|e| e.to_string())?;
    Ok(library)
}
pub(crate) fn delete_profile(store: &Store, id: &str) -> Result<TeamLibrary> {
    let transaction = store
        .db
        .unchecked_transaction()
        .map_err(|e| e.to_string())?;
    let mut library = read(store)?;
    let index = library
        .profiles
        .iter()
        .position(|p| p.id == id)
        .ok_or("This team profile no longer exists.")?;
    library.profiles.remove(index);
    if library.active_profile_id.as_deref() == Some(id) {
        library.active_profile_id = None;
    }
    write(store, &library)?;
    transaction.commit().map_err(|e| e.to_string())?;
    Ok(library)
}
/// Must share the task configuration transaction so Save setup is all-or-nothing.
pub(super) fn remember(
    store: &Store,
    setup: Option<TeamSetup>,
    profile_id: Option<&str>,
) -> Result<()> {
    let mut library = read(store)?;
    if let Some(setup) = setup {
        setup.validate()?;
        let profile = profile_id
            .map(|id| {
                library
                    .profiles
                    .iter()
                    .find(|p| p.id == id)
                    .ok_or("This team profile no longer exists.")
            })
            .transpose()?;
        if profile.is_some_and(|p| !same_setup(&p.setup, Some(&setup))) {
            return Err("The selected profile does not match this team setup. Save it as a custom setup or update the profile first.".into());
        }
        library.active_profile_id = profile.map(|p| p.id.clone());
        library.enabled = true;
        // Council is per task: it never becomes the default for new tasks.
        let mut setup = setup;
        setup.config.council = None;
        library.last_setup = Some(setup);
    } else {
        library.enabled = false;
    }
    write(store, &library)
}
pub(super) fn apply_selection(store: &Store, sid: &str, selection: &ModelSelection) -> Result<()> {
    selection.validate()?;
    store.db.execute("UPDATE sessions SET provider=?2,model=?3,reasoning_effort=?4,context_used_tokens=NULL,context_window=NULL WHERE id=?1",params![sid,selection.provider,selection.model,selection.reasoning_effort]).map_err(|e|e.to_string())?;
    Ok(())
}
/// Called only by user-facing new-task entrypoints, inside their creation transaction.
pub(crate) fn apply_default(store: &Store, sid: &str) -> Result<Option<TeamSnapshot>> {
    let library = read(store)?;
    if !library.enabled {
        return Ok(None);
    }
    let setup = library
        .last_setup
        .ok_or("The saved default team setup is missing.")?;
    setup.validate()?;
    let has_history: bool = store
        .db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM messages WHERE session_id=?1)",
            [sid],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if has_history || super::parent_of(store, sid)?.is_some() || super::load(store, sid)?.is_some()
    {
        return Err("Default team settings only apply to a new user task.".into());
    }
    // An auto team is led by whatever model the new task was created with.
    if !setup.config.auto {
        apply_selection(store, sid, &setup.architect)?;
    }
    let mut team = super::new_team(sid.into(), setup.config);
    super::save(store, &mut team)?;
    Ok(Some(team))
}
pub(crate) fn create_user_task(
    store: &Store,
    project_id: &str,
    provider: &str,
    model: &str,
    mode: Option<&str>,
    details: Option<(&str, &str)>,
) -> Result<Session> {
    create_task_with(store, project_id, provider, model, mode, details, true)
}
/// A user task without the saved default team. Callers: a remote `task.start` on a host without
/// "Full access for remote tasks" (a team's workers always run in full access), the desktop's
/// /btw side task (`create_session` with `team: false`), the remote `btw.ask`, and chat creation.
pub(crate) fn create_task_without_team(
    store: &Store,
    project_id: &str,
    provider: &str,
    model: &str,
    mode: Option<&str>,
    details: Option<(&str, &str)>,
) -> Result<Session> {
    create_task_with(store, project_id, provider, model, mode, details, false)
}
fn create_task_with(
    store: &Store,
    project_id: &str,
    provider: &str,
    model: &str,
    mode: Option<&str>,
    details: Option<(&str, &str)>,
    team: bool,
) -> Result<Session> {
    let transaction = store
        .db
        .unchecked_transaction()
        .map_err(|e| e.to_string())?;
    let task = store.create_session(
        project_id,
        provider,
        model,
        mode.unwrap_or(storage::DEFAULT_PERMISSION_MODE),
    )?;
    if let Some((title, description)) = details {
        store.update_task_details(&task.id, title, description)?;
    }
    if team {
        apply_default(store, &task.id)?;
    }
    let task = store.session(&task.id)?;
    transaction.commit().map_err(|e| e.to_string())?;
    Ok(task)
}
/// Replaces the app-wide lead guidance. Blank or absent means the built-in rules alone.
pub(crate) fn set_lead_guidance(
    store: &Store,
    guidance: Option<String>,
) -> Result<TeamLibrary> {
    let mut library = read(store)?;
    library.lead_guidance = guidance
        .map(|text| text.trim().to_owned())
        .filter(|text| !text.is_empty());
    if let Some(guidance) = &library.lead_guidance {
        if guidance.contains('\0') {
            return Err("Lead guidance must be plain text.".into());
        }
    }
    write(store, &library)?;
    Ok(library)
}
#[tauri::command]
pub async fn architect_profiles(state: State<'_, AppState>) -> Result<TeamLibrary> {
    let store = state.store.lock().map_err(|e| e.to_string())?;
    read(&store)
}
#[tauri::command]
pub async fn architect_save_profile(
    state: State<'_, AppState>,
    id: Option<String>,
    name: String,
    setup: TeamSetup,
) -> Result<TeamLibrary> {
    let store = state.store.lock().map_err(|e| e.to_string())?;
    save_profile(&store, id, name, setup)
}
#[tauri::command]
pub async fn architect_set_lead_guidance(
    state: State<'_, AppState>,
    guidance: Option<String>,
) -> Result<TeamLibrary> {
    let store = state.store.lock().map_err(|e| e.to_string())?;
    set_lead_guidance(&store, guidance)
}
#[tauri::command]
pub async fn architect_delete_profile(
    state: State<'_, AppState>,
    id: String,
) -> Result<TeamLibrary> {
    let store = state.store.lock().map_err(|e| e.to_string())?;
    delete_profile(&store, &id)
}
#[cfg(test)]
mod tests;

#[cfg(test)]
#[test]
fn missing_library_skips_malformed_and_invalid_team_snapshots() {
    struct TestDatabase(std::path::PathBuf);
    impl Drop for TestDatabase {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }
    let path = TestDatabase(std::env::temp_dir().join(format!("pandacode-profile-seed-{}.db", storage::id())));
    let store = Store::open(&path.0).unwrap();
    store.db.execute_batch(
        "INSERT INTO projects(id,name,path) VALUES('project','Project','/project');
         INSERT INTO sessions(id,project_id,title,provider,model,mode,status,created_at,updated_at)
         VALUES('malformed','project','Malformed','codex','default','ask','idle',1,1),
               ('scalar','project','Scalar','codex','default','ask','idle',1,1),
               ('invalid','project','Invalid','codex','default','ask','idle',1,1),
               ('older','project','Older','codex','gpt-test','ask','idle',1,1);
         INSERT INTO architect_teams(session_id,content) VALUES('malformed','{bad-json');
         DELETE FROM architect_library;",
    ).unwrap();
    drop(store);

    let store = Store::open(&path.0).unwrap();
    let library = read(&store).unwrap();
    assert!(!library.enabled);
    assert!(library.last_setup.is_none());
    assert!(library.profiles.is_empty());

    let config = serde_json::json!({
        "auto": true, "workers": [], "maxParallel": 2, "maxRounds": 7,
        "maxAssignments": 15, "workspace": "shared", "summaryLimit": 1500,
    });
    let mut invalid = config.clone();
    invalid["workspace"] = "bad-mode".into();
    for (id, updated_at, config) in [
        ("older", 10, config.clone()),
        ("invalid", 20, invalid),
        ("scalar", 30, 42.into()),
    ] {
        let snapshot = serde_json::json!({"status":"completed", "updatedAt":updated_at, "config":config});
        store.db.execute(
            "INSERT INTO architect_teams(session_id,content) VALUES(?1,?2)",
            params![id, snapshot.to_string()],
        ).unwrap();
    }
    store.db.execute("DELETE FROM architect_library", []).unwrap();
    drop(store);

    let store = Store::open(&path.0).unwrap();
    let library = read(&store).unwrap();
    assert!(library.enabled);
    assert_eq!(library.last_setup, Some(TeamSetup {
        architect: ModelSelection { provider: "codex".into(), model: "gpt-test".into(), reasoning_effort: None },
        config: serde_json::from_value(config).unwrap(),
    }));
    let malformed: String = store.db.query_row(
        "SELECT content FROM architect_teams WHERE session_id='malformed'",
        [],
        |row| row.get(0),
    ).unwrap();
    assert_eq!(malformed, "{bad-json");
}
