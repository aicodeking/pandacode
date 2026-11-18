//! The switch commands: `skill_manager_set` (one skill on or off in a view) and
//! `skill_manager_reset` (every switch back to on).
use super::*;

#[cfg(test)]
pub(super) fn set_at(
    home: &Path,
    project: Option<&Path>,
    project_id: Option<&str>,
    path: &Path,
    name: &str,
    enabled: bool,
    homes: &Homes,
) -> Result<Vec<ManagedSkill>, String> {
    set_counted(home, project, project_id, path, name, enabled, homes).map(|view| view.skills)
}
/// Saves one switch and answers with the view: the last scan of this view with updated flags
/// (`scan_cache`), or a fresh scan when there is none.
pub(super) fn set_counted(
    home: &Path,
    project: Option<&Path>,
    project_id: Option<&str>,
    path: &Path,
    name: &str,
    enabled: bool,
    homes: &Homes,
) -> Result<SkillInventory, String> {
    validate_toggle_name(name)?;
    let prefs = {
        let _guard = recover(&LOCK);
        read_prefs(path)?
    };
    let (key, mut scan) = scan_cache::scan(home, project, project_id, path, &prefs, homes);
    if !scan.skills.iter().any(|skill| skill.name == name) {
        // Installed since the remembered scan, perhaps: look again before refusing.
        scan = scan_cache::fresh(home, project, project_id, &prefs, homes);
    }
    let quarantined = quarantine::names(path);
    let row = scan.skills.iter().find(|skill| skill.name == name);
    let missing = row.is_none_or(|skill| skill.missing) && !quarantined.contains(name);
    if row.is_none() && !quarantined.contains(name) || (missing && !enabled) {
        return Err(
            "This skill is no longer installed. Refresh the skill list and try again.".into(),
        );
    }
    if row.is_some_and(|skill| !skill.switchable) {
        return Err("This skill's identity could not be resolved safely; review its SKILL.md before switching it.".into());
    }
    let _guard = recover(&LOCK);
    let mut prefs = read_prefs(path)?;
    if let (Some(id), Some(project)) = (project_id, project) {
        if let Some(legacy) = prefs.projects.remove(&checkout_key(project)) {
            prefs
                .projects
                .entry(id.to_owned())
                .or_default()
                .extend(legacy);
        }
    }
    let mut prefs = prefs.set(name, enabled, project_id);
    if missing && project_id.is_none() {
        // Turning a removed skill back on in All projects clears every switch left for it.
        for names in prefs.projects.values_mut() {
            names.remove(name);
        }
        prefs.projects.retain(|_, names| !names.is_empty());
    }
    save_prefs(path, &prefs)?;
    drop(_guard);
    scan.skills
        .retain(|skill| !skill.missing || prefs_mentions(&prefs, &skill.name));
    scan_cache::remember(key, scan.clone());
    let mut view = view(project_id.map(str::to_owned), scan, &prefs, homes);
    quarantine::add_rows(&mut view.skills, path, project_id);
    inventory::attribute(&mut view.skills, &prefs, project_id, project, homes);
    view.links_warning = accounts::links_warning(path);
    Ok(view)
}
fn prefs_mentions(prefs: &Prefs, name: &str) -> bool {
    prefs.off_in_panda_code.contains(name) || prefs.projects.values().any(|n| n.contains(name))
}
#[tauri::command]
pub(crate) async fn skill_manager_set(
    app: AppHandle,
    state: State<'_, crate::AppState>,
    name: String,
    enabled: bool,
    project_id: Option<String>,
) -> crate::Result<SkillInventory> {
    let (home, project, path) = locations(&app, &state, project_id.as_deref())?;
    let homes = command_homes(&state, project_id.as_deref())?;
    crate::blocking(move || {
        set_counted(
            &home,
            project.as_deref(),
            project_id.as_deref(),
            &path,
            &name,
            enabled,
            &homes,
        )
    })
    .await
}
#[tauri::command]
pub(crate) async fn skill_manager_reset(
    app: AppHandle,
    state: State<'_, crate::AppState>,
    project_id: Option<String>,
) -> crate::Result<SkillInventory> {
    let (home, project, prefs) = locations(&app, &state, project_id.as_deref())?;
    let homes = command_homes(&state, project_id.as_deref())?;
    crate::blocking(move || {
        reset_prefs(&prefs)?;
        list_at(&home, project.as_deref(), project_id, &prefs, &homes)
    })
    .await
}
