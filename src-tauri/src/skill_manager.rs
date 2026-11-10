//! Local inventory and session-scoped skill switches, separate from the skills library.
mod cli;
mod disabled;
use disabled::Project;
pub(crate) use disabled::{
    begin_launch, begin_launch_at, disabled_at, disabled_for, projects_changed, remember_project,
};
#[cfg(test)]
use disabled::{
    disabled_for_at, disabled_for_path, disabled_for_session, path_projects, refresh_project,
    PROJECTS,
};
mod prefs;
#[cfg(test)]
use prefs::{backup_path, LAST_PREFS};
use prefs::{
    launch_prefs, prefs_warning, read_prefs, recovered_prefs, reset_prefs, save_prefs, Prefs,
};
mod enforcement;
pub(crate) use enforcement::{
    codex_arguments, codex_connection_arguments, opencode_agents_at, opencode_configuration_at,
    opencode_enforcement_with, opencode_launch_with, opencode_permission, OpenCodeAgents,
};
mod matrix;
#[cfg(test)]
pub(crate) use matrix::SKILLS_SETTINGS;
use matrix::{advisory_names, Mode};
#[cfg(test)]
pub(crate) use matrix::{check_prompt, check_session_prompt_with, launch_disabled_with};
pub(crate) use matrix::{
    check_session_prompt, console_arguments, console_environment, harness_builtin, launch_disabled,
    off_error, prepare_turn, typed_command,
};
mod accounts;
mod install;
mod inventory;
mod launch;
mod library;
mod links;
mod metadata;
mod opencode_agents;
mod plugins;
mod quarantine;
mod reminders;
pub(crate) use reminders::{
    apply_instructions, console_advisory, installed_names_for, is_disabled, quoted_name,
    remind_unenforced,
};
use reminders::apply_instructions_with;
#[cfg(test)]
use reminders::remind;
pub(crate) mod roots;
mod safety;
mod scan_cache;
mod switches;
#[cfg(test)]
use switches::{set_at, set_counted};
pub(crate) use switches::*;
mod uninstall;
#[cfg(test)]
use inventory::inventory;
use roots::Homes;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{AppHandle, Manager, State};

fn recover<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}
const MAX_BYTES: u64 = 256 * 1024;
static LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillAgent {
    harness: String,
    scope: String,
    #[serde(serialize_with = "safety::serialize_warning")]
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    project_id: Option<String>,
    /// A quarantined copy listed on a row that also has a clean install of the same name: the
    /// row keeps its switch, and this location is restored with `skill_manager_restore`.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    quarantined: bool,
    /// The installed folder with links resolved, so one folder reached through two roots
    /// (a link, or a configured home that is a default one) is listed once.
    #[serde(skip)]
    real: Option<PathBuf>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ManagedSkill {
    #[serde(serialize_with = "safety::serialize_warning")]
    name: String,
    #[serde(serialize_with = "safety::serialize_warning")]
    description: String,
    agents: Vec<SkillAgent>,
    off_in_panda_code: bool,
    off_in_project: bool,
    off_in_projects: Vec<String>,
    #[serde(serialize_with = "serialize_optional_warning")]
    source: Option<String>,
    switchable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    unswitchable_reason: Option<&'static str>,
    /// Effective modes for harnesses that treat this name differently from their defaults.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    enforcement_overrides: BTreeMap<&'static str, matrix::Modes>,
    /// Why a quarantined skill was flagged, as recorded when it was moved.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    flags: Vec<quarantine::Flag>,
    /// Flagged on install and moved to PandaCode's quarantine; `skill_manager_restore` returns it.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    quarantined: bool,
    /// The row is a clean install that stays switchable, and a same-named copy is also in
    /// quarantine (its locations carry `quarantined: true`): the page shows the switch and Restore.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    quarantined_copy: bool,
    /// A saved switch for a name that is no longer installed; turning it on clears the switch.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    missing: bool,
}
impl ManagedSkill {
    fn new(name: String, description: String, source: Option<String>, resolved: bool) -> Self {
        let overrides = matrix::overrides(&name);
        Self {
            unswitchable_reason: (!resolved).then_some(UNRESOLVED),
            switchable: resolved
                && validate_toggle_name(&name).is_ok()
                && safety::redact_warning(&name) == name,
            enforcement_overrides: overrides,
            flags: Vec::new(),
            name,
            description,
            source,
            agents: Vec::new(),
            off_in_panda_code: false,
            off_in_project: false,
            off_in_projects: Vec::new(),
            quarantined: false,
            quarantined_copy: false,
            missing: false,
        }
    }
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Harness {
    id: String,
    installed: bool,
    enforcement: Mode,
    console_enforcement: Mode,
    /// What the console mode cannot stop, shown beside it (Claude-family typed commands).
    #[serde(skip_serializing_if = "Option::is_none")]
    console_note: Option<&'static str>,
    installable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    install_as: Option<&'static str>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillInventory {
    project_id: Option<String>,
    harnesses: Vec<Harness>,
    skills: Vec<ManagedSkill>,
    #[serde(skip_serializing_if = "Option::is_none")]
    not_shown: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    findings: Option<Vec<safety::Finding>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    failures: Option<Vec<install::Failure>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    prefs_error: Option<String>,
    /// With `prefs_error`: no saved switches could be recovered, so every skill is off until
    /// Reset switches.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    prefs_lost: bool,
    /// The record of links PandaCode made in account homes couldn't be read (`accounts.rs`).
    #[serde(skip_serializing_if = "Option::is_none")]
    links_warning: Option<String>,
    /// Saved switches kept off whose names no longer pass the switch policy (a calm notice).
    #[serde(skip_serializing_if = "Option::is_none")]
    prefs_warning: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    /// Add only: the names this add itself switched off in its scope (flagged copies it could
    /// not quarantine), so "Turn on anyway" can offer them back. Omitted when empty.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    switched_off: Vec<String>,
}

impl SkillInventory {
    /// The settings read's error, and whether nothing was recovered (`prefs` then holds only
    /// the `*` marker that keeps every skill off).
    fn set_prefs_error(&mut self, prefs: &Prefs, error: Option<String>) {
        self.prefs_lost = error.is_some() && prefs.off_in_panda_code.contains("*");
        self.prefs_error = error;
    }
}

fn serialize_optional_warning<S: serde::Serializer>(
    text: &Option<String>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    text.as_deref()
        .map(safety::redact_warning)
        .serialize(serializer)
}

fn checkout_key(path: &Path) -> String {
    fs::canonicalize(path)
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .into_owned()
}
fn read_text(path: &Path) -> Option<String> {
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_BYTES {
        return None;
    }
    let file = fs::File::open(path).ok()?;
    let meta = file.metadata().ok()?;
    if !meta.is_file() || meta.len() > MAX_BYTES {
        return None;
    }
    let mut text = String::new();
    file.take(MAX_BYTES + 1).read_to_string(&mut text).ok()?;
    (text.len() as u64 <= MAX_BYTES).then_some(text)
}
fn skill_text(path: &Path) -> Option<String> {
    if !path.is_file() {
        return None;
    }
    let mut bytes = Vec::new();
    if let Ok(file) = fs::File::open(path) {
        let _ = file.take(MAX_BYTES).read_to_end(&mut bytes);
    }
    Some(String::from_utf8_lossy(&bytes).into_owned())
}
fn validate_toggle_name(name: &str) -> Result<(), String> {
    if name.trim().is_empty()
        || name.len() > 200
        || name.starts_with('-')
        || name.chars().any(|c| {
            c.is_control() || matches!(c, '\u{2028}' | '\u{2029}') || ",()`<>*".contains(c)
        })
    {
        Err("This skill name can't be switched: use at most 200 bytes, without control characters, a leading '-', commas, parentheses, backticks, angle brackets or wildcards.".into())
    } else {
        Ok(())
    }
}
fn validate_name(name: &str) -> Result<(), String> {
    validate_toggle_name(name)
}
// Claude's comma/space separated --disallowedTools syntax does not document escaping arbitrary
// skill identifiers. Keep exact rules to identifiers without separators/metacharacters. Every
// other switchable name receives the same JSON advisory as soft harnesses, including on consoles.
fn claude_rule_name(name: &str) -> bool {
    validate_toggle_name(name).is_ok()
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.:".contains(&b))
}
fn validate_source(source: &str) -> Result<(), String> {
    let invalid = || {
        "Enter owner/repo, owner/repo/path, a GitHub/GitLab HTTPS URL, or a skills.sh package name."
            .to_string()
    };
    if source.is_empty()
        || source.len() > 1024
        || source.starts_with('-')
        || !source
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.@:/".contains(&b))
    {
        return Err(invalid());
    }
    let path = if source.starts_with("https://") {
        let url = reqwest::Url::parse(source).map_err(|_| invalid())?;
        if !matches!(
            url.host_str(),
            Some("github.com" | "gitlab.com" | "skills.sh")
        ) || !url.username().is_empty()
            || url.password().is_some()
            || url.port().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(invalid());
        }
        source
            .split_once("://")
            .and_then(|(_, rest)| rest.split_once('/'))
            .map(|(_, path)| path)
            .ok_or_else(invalid)?
    } else {
        source
    };
    if path.split('/').all(|s| {
        !s.is_empty()
            && s != "."
            && s != ".."
            && !s.starts_with('-')
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_.@".contains(&b))
    }) {
        Ok(())
    } else {
        Err(invalid())
    }
}
pub(crate) fn claude_disallowed(existing: &str, disabled: &BTreeSet<String>) -> String {
    let mut tools: Vec<String> = existing
        .split(',')
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect();
    if disabled.contains("*") && !tools.iter().any(|t| t == "Skill") {
        tools.push("Skill".into());
    }
    for name in disabled.iter().filter(|name| claude_rule_name(name)) {
        let tool = format!("Skill({name})");
        if !tools.contains(&tool) {
            tools.push(tool);
        }
    }
    tools.join(",")
}
const UNRESOLVED: &str =
    "Skill identity could not be resolved from SKILL.md; review its metadata before switching it.";
const LINKED_OUT: &str = "SKILL.md links outside the skill folder, so its identity was not read; review the link before switching it.";
/// A SKILL.md that is a link leading outside its own folder (or nowhere). Identity and
/// descriptions are never read through it.
pub(crate) fn skill_md_escapes(path: &Path) -> bool {
    if !fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
        return false;
    }
    let folder = path.parent().and_then(|p| fs::canonicalize(p).ok());
    !matches!(
        (fs::canonicalize(path), folder),
        (Ok(target), Some(folder)) if target.starts_with(&folder)
    )
}
pub(crate) fn canonical_name(path: &Path) -> Option<String> {
    if skill_md_escapes(path) {
        return None;
    }
    skill_text(path).and_then(|text| metadata::frontmatter(&text).0)
}
fn list_at(
    home: &Path,
    project: Option<&Path>,
    project_id: Option<String>,
    path: &Path,
    homes: &Homes,
) -> Result<SkillInventory, String> {
    let (prefs, error) = {
        let _guard = recover(&LOCK);
        recovered_prefs(path)
    };
    // A list always rescans, and leaves its scan for the switch saves that follow.
    let scan = scan_cache::fresh(home, project, project_id.as_deref(), &prefs, homes);
    scan_cache::remember(
        scan_cache::key(home, project, project_id.as_deref(), path, homes),
        scan.clone(),
    );
    let mut inventory = view(project_id, scan, &prefs, homes);
    quarantine::add_rows(&mut inventory.skills, path, inventory.project_id.as_deref());
    inventory::attribute(
        &mut inventory.skills,
        &prefs,
        inventory.project_id.as_deref(),
        project,
        homes,
    );
    inventory.set_prefs_error(&prefs, error);
    inventory.links_warning = accounts::links_warning(path);
    Ok(inventory)
}
fn list_with_prefs(
    home: &Path,
    project: Option<&Path>,
    project_id: Option<String>,
    prefs: &Prefs,
    homes: &Homes,
) -> SkillInventory {
    let scan = scan_cache::fresh(home, project, project_id.as_deref(), prefs, homes);
    view(project_id, scan, prefs, homes)
}
fn view(
    project_id: Option<String>,
    scan: scan_cache::Scan,
    prefs: &Prefs,
    homes: &Homes,
) -> SkillInventory {
    let mut inventory = SkillInventory {
        skills: scan.skills,
        not_shown: (scan.not_shown > 0).then_some(scan.not_shown),
        findings: None,
        failures: None,
        prefs_error: None,
        prefs_lost: false,
        links_warning: None,
        prefs_warning: prefs_warning(prefs),
        error: None,
        switched_off: Vec::new(),
        project_id,
        harnesses: harnesses(homes),
    };
    if !scan.opencode_complete {
        opencode_unlisted_agents(&mut inventory);
    }
    inventory
}
const OPENCODE_UNLISTED: &str =
    "Some OpenCode agents here could not be listed, so skills are only asked, not blocked";
/// OpenCode's denies reach only the agents PandaCode could list. When one in this view could
/// not be (too many, or an unusable name), launches ask (`remind_unenforced`) and consoles, which
/// have no reminder channel, carry nothing: the page reports that state, not the table's.
fn opencode_unlisted_agents(inventory: &mut SkillInventory) {
    for harness in inventory
        .harnesses
        .iter_mut()
        .filter(|h| h.id == "opencode")
    {
        harness.enforcement = Mode::Asked;
        harness.console_enforcement = Mode::None;
        harness.console_note = Some(OPENCODE_UNLISTED);
    }
    for skill in &mut inventory.skills {
        skill.enforcement_overrides.remove("opencode");
    }
}
fn locations(
    app: &AppHandle,
    state: &crate::AppState,
    project_id: Option<&str>,
) -> Result<(PathBuf, Option<PathBuf>, PathBuf), String> {
    let home =
        crate::agent_usage_providers::home().ok_or("Could not locate the home directory.")?;
    let project = project_id.map(|id| state.root(id, None)).transpose()?;
    let prefs = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("skill-manager.json");
    Ok((home, project, prefs))
}
#[tauri::command]
pub(crate) async fn skill_manager_list(
    app: AppHandle,
    state: State<'_, crate::AppState>,
    project_id: Option<String>,
) -> crate::Result<SkillInventory> {
    let (home, project, prefs) = locations(&app, &state, project_id.as_deref())?;
    let homes = command_homes(&state, project_id.as_deref())?;
    crate::blocking(move || list_at(&home, project.as_deref(), project_id, &prefs, &homes)).await
}
/// "Turn on anyway" for a quarantined skill: moves its files back. `project_id` picks the view.
#[tauri::command]
pub(crate) async fn skill_manager_restore(
    app: AppHandle,
    state: State<'_, crate::AppState>,
    name: String,
    project_id: Option<String>,
) -> crate::Result<SkillInventory> {
    let (home, project, prefs) = locations(&app, &state, project_id.as_deref())?;
    let homes = command_homes(&state, project_id.as_deref())?;
    crate::blocking(move || {
        restore_at(
            &install::ADD,
            &home,
            project.as_deref(),
            project_id,
            &prefs,
            &homes,
            &name,
        )
    })
    .await
}
/// `lock` is the install lock (`install::ADD`); tests pass their own.
fn restore_at(
    lock: &Mutex<()>,
    home: &Path,
    project: Option<&Path>,
    project_id: Option<String>,
    path: &Path,
    homes: &Homes,
    name: &str,
) -> Result<SkillInventory, String> {
    if name.is_empty() || name.len() > 1024 {
        return Err("Choose a quarantined skill to restore.".into());
    }
    quarantine::restore_with(lock, path, name, || {})?;
    list_at(home, project, project_id, path, homes)
}
/// Uninstall: moves the skill's copies in this scope aside (`uninstall.rs`). No `projectId`:
/// user-level copies; a project: that project's copies only.
#[tauri::command]
pub(crate) async fn skill_manager_uninstall(
    app: AppHandle,
    state: State<'_, crate::AppState>,
    name: String,
    project_id: Option<String>,
) -> crate::Result<uninstall::UninstallResult> {
    let (home, project, prefs) = locations(&app, &state, project_id.as_deref())?;
    let homes = command_homes(&state, project_id.as_deref())?;
    crate::blocking(move || {
        let _forget = scan_cache::Forget;
        uninstall::uninstall_at(&home, project.as_deref(), project_id, &prefs, &homes, &name)
    })
    .await
}
/// Undo for `skill_manager_uninstall`: `id` is its `uninstalled.id`; `projectId` picks the view.
#[tauri::command]
pub(crate) async fn skill_manager_undo_uninstall(
    app: AppHandle,
    state: State<'_, crate::AppState>,
    id: String,
    project_id: Option<String>,
) -> crate::Result<SkillInventory> {
    let (home, project, prefs) = locations(&app, &state, project_id.as_deref())?;
    let homes = command_homes(&state, project_id.as_deref())?;
    crate::blocking(move || {
        let _forget = scan_cache::Forget;
        uninstall::undo_at(&home, project.as_deref(), project_id, &prefs, &homes, &id)
    })
    .await
}
#[tauri::command]
pub(crate) async fn skill_manager_preview(
    app: AppHandle,
    source: String,
) -> crate::Result<cli::Preview> {
    let prefs = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("skill-manager.json");
    crate::blocking(move || cli::preview(source, &prefs)).await
}
#[tauri::command]
pub(crate) async fn skill_manager_add(
    app: AppHandle,
    state: State<'_, crate::AppState>,
    source: String,
    skills: Vec<String>,
    harnesses: Vec<String>,
    project_id: Option<String>,
) -> crate::Result<SkillInventory> {
    let (home, project, path) = locations(&app, &state, project_id.as_deref())?;
    let homes = command_homes(&state, project_id.as_deref())?;
    crate::blocking(move || {
        // New skills invalidate every remembered scan, whatever the add's outcome.
        let _forget = scan_cache::Forget;
        install::add_at(
            &home,
            project.as_deref(),
            project_id,
            &path,
            &homes,
            &source,
            &skills,
            &harnesses,
            cli::run,
        )
    })
    .await
}
/// Add → Bot library: imports the chosen skills from a previewed source into PandaCode's
/// library (the skills bots use) instead of agent folders (`library.rs`).
#[tauri::command]
pub(crate) async fn skill_manager_add_library(
    app: AppHandle,
    source: String,
    skills: Vec<String>,
) -> crate::Result<library::LibraryImport> {
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let library = crate::skills::library(&app)?;
    let home =
        crate::agent_usage_providers::home().ok_or("Could not locate the home directory.")?;
    crate::blocking(move || {
        library::import_at(
            &home,
            &data.join("skill-manager.json"),
            &data.join("skill-manager-staging"),
            &library,
            &source,
            &skills,
            cli::run,
        )
    })
    .await
}

#[cfg(test)]
mod harness_tests;
#[cfg(test)]
mod lifecycle_tests;
#[cfg(test)]
mod robustness_tests;
#[cfg(test)]
mod recovery_state_tests;
#[cfg(test)]
mod tests;

fn installed(id: &str) -> bool {
    if crate::providers::executable(id).is_none() {
        return false;
    }
    match id {
        "glm" => configured_key(
            crate::provider_settings::glm_key(),
            crate::provider_settings::GLM_KEY.env,
        ),
        "mimo" => configured_key(
            crate::provider_settings::mimo_key(),
            crate::provider_settings::MIMO_KEY.env,
        ),
        _ => true,
    }
}
const MAX_WORKTREES: usize = 512;
fn command_homes(state: &crate::AppState, project_id: Option<&str>) -> Result<Homes, String> {
    let mut homes = Homes::resolved();
    let store = state.store.lock().map_err(|e| e.to_string())?;
    let ids: Vec<String> = if let Some(id) = project_id {
        vec![id.to_owned()]
    } else {
        let projects = visible_projects(&store)?;
        homes.not_shown = projects.len().saturating_sub(256);
        homes.projects = projects
            .into_iter()
            .take(256)
            .map(|p| (p.id, PathBuf::from(p.path)))
            .collect();
        homes.projects.iter().map(|(id, _)| id.clone()).collect()
    };
    for id in ids {
        // A project whose worktrees cannot be read still lists its main checkout.
        for path in store.project_worktrees(&id).unwrap_or_default() {
            let path = PathBuf::from(path);
            if homes.worktrees.len() == MAX_WORKTREES {
                homes.not_shown += 1;
            } else if path.is_absolute() && path.is_dir() {
                homes.worktrees.push((id.clone(), path));
            }
        }
    }
    Ok(homes)
}

// Keep the scope roster identical to main.ts userProjects(), including its chat path test.
fn visible_projects(store: &crate::storage::Store) -> Result<Vec<crate::storage::Project>, String> {
    static CHAT: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"[\\/]PandaCode Chats[\\/]chat-[0-9a-f]{8}$")
            .expect("chat project pattern")
    });
    let bots = crate::bots::project_ids(store)?;
    Ok(store
        .projects()?
        .into_iter()
        .filter(|p| !bots.contains(&p.id) && !CHAT.is_match(&p.path))
        .collect())
}

fn harnesses(homes: &Homes) -> Vec<Harness> {
    crate::providers::PROVIDERS
        .iter()
        .map(|(id, _)| Harness {
            id: (*id).into(),
            installed: homes
                .installed
                .as_ref()
                .map_or_else(|| installed(id), |ids| ids.contains(*id)),
            enforcement: matrix::defaults(id).0,
            console_enforcement: matrix::defaults(id).1,
            console_note: matrix::console_note(id),
            installable: cli::agent_id(id).is_some(),
            install_as: cli::agent_id(id),
        })
        .collect()
}

fn configured_key(saved: Result<Option<String>, String>, env: &str) -> bool {
    saved.ok().flatten().is_some()
        || std::env::var(env).is_ok_and(|key| crate::provider_settings::validate_key(&key).is_ok())
}
