//! Settings → Skills → Uninstall: moves a skill's installed copies in one scope (user-level
//! roots, or one project's roots in its main checkout and its task worktrees) out of every
//! agent's reach into `skill-uninstalled/` in app data, so `skill_manager_undo_uninstall` can
//! put them back.
//!
//! Only entries of known skill roots are touched. Symbolic links are unlinked, never their
//! targets (a target is moved only when it is itself an installed copy in a skill root of this
//! scope). Codex, OpenCode, Pi and Kilo account homes lose a copy only when PandaCode put it
//! there (`accounts::foreign_account_copy`); the user's own stay and are reported as kept.
//! Switches for the name are cleared only when no copy is left in the view, and Undo sets
//! them again.
use super::*;
use quarantine::Item;

pub(super) const BUSY: &str = "A skill is being installed. Try again when it finishes.";
const OCCUPIED: &str =
    "Something now exists where this skill was installed. Remove it, then try Undo again.";
const MISSING: &str =
    "The kept copy of this skill is missing, so it can't be put back. Add the skill again.";
/// Entries read per skill root when looking for links to a removed folder.
const SWEEP_LIMIT: usize = 8192;
/// Why a project uninstall keeps a copy in Pi's ancestor `.agents/skills` (a folder above the
/// project, up to the repository root): every project below that folder loads it too.
pub(super) const SHARED_ABOVE: &str = "in a folder above this project, shared with the projects under it";

fn records_path(prefs: &Path) -> PathBuf {
    prefs.with_file_name("skill-uninstalled.json")
}
fn store_dir(prefs: &Path) -> PathBuf {
    prefs.with_file_name("skill-uninstalled")
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    id: String,
    name: String,
    #[serde(default)]
    project_id: Option<String>,
    items: Vec<Item>,
    /// The All projects switch this uninstall cleared (no copy was left); Undo sets it again.
    #[serde(default)]
    cleared_all: bool,
    /// Project switches this uninstall cleared, by project ID.
    #[serde(default)]
    cleared_projects: Vec<String>,
    #[serde(default)]
    removed_at: u64,
}

/// What one uninstall did, for the page's confirmation and its Undo.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Uninstalled {
    /// Pass to `skill_manager_undo_uninstall`.
    id: String,
    #[serde(serialize_with = "safety::serialize_warning")]
    name: String,
    /// Locations removed (display paths, as in the row's details).
    removed: Vec<String>,
    /// Locations left in place: copies in account homes PandaCode did not put there, plugin
    /// skills, or folders outside the known skill roots.
    kept: Vec<String>,
    /// No copy was left in this view, so the skill's switches were cleared (Undo sets them).
    switches_cleared: bool,
    /// Skill names of earlier uninstalls that can no longer be undone: the Undo records
    /// outgrew their file limit, so the oldest were forgotten with their kept copies.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    expired_undo: Vec<String>,
    /// The IDs of those uninstalls, as returned in their `id`, in the same order.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    expired_undo_ids: Vec<String>,
}

#[derive(Debug, Serialize)]
pub(crate) struct UninstallResult {
    #[serde(flatten)]
    inventory: SkillInventory,
    uninstalled: Uninstalled,
}

fn read(prefs: &Path) -> Result<Vec<Record>, String> {
    let path = records_path(prefs);
    match fs::symlink_metadata(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("Could not read uninstalled skills: {e}")),
        Ok(_) => {}
    }
    let text = read_text(&path).ok_or("Could not read uninstalled skills (maximum 256 KB).")?;
    serde_json::from_str(&text).map_err(|e| format!("Could not read uninstalled skills: {e}"))
}

/// Saves the records; when they outgrow the file limit the oldest are forgotten, with their
/// kept copies, but never `keep`. Returns the forgotten records, oldest first.
fn write(prefs: &Path, records: &mut Vec<Record>, keep: &str) -> Result<Vec<Record>, String> {
    let mut dropped: Vec<Record> = Vec::new();
    loop {
        let bytes = serde_json::to_vec_pretty(records).map_err(|e| e.to_string())?;
        if bytes.len() as u64 <= MAX_BYTES {
            prefs::write_prefs_file(&records_path(prefs), &bytes)?;
            for record in &dropped {
                let _ = fs::remove_dir_all(store_dir(prefs).join(&record.id));
            }
            return Ok(dropped);
        }
        let Some(oldest) = records.iter().position(|r| r.id != keep) else {
            return Err("Too many skill files to keep for Undo.".into());
        };
        dropped.push(records.remove(oldest));
    }
}

/// The install lock, without waiting: an uninstall or restore never races an add's snapshot
/// and CLI run.
pub(super) fn claim(lock: &Mutex<()>) -> Result<std::sync::MutexGuard<'_, ()>, String> {
    match lock.try_lock() {
        Ok(guard) => Ok(guard),
        Err(std::sync::TryLockError::Poisoned(poisoned)) => Ok(poisoned.into_inner()),
        Err(std::sync::TryLockError::WouldBlock) => Err(BUSY.into()),
    }
}

/// Skill roots of this scope only: user-level roots, or the project's own: not the user's, and
/// not Pi's ancestor roots above the project, which the projects under them share.
fn scope_roots(home: &Path, project: Option<&Path>, homes: &Homes) -> BTreeSet<PathBuf> {
    let roots = |project| {
        crate::providers::PROVIDERS
            .iter()
            .flat_map(move |(id, _)| roots::skill_roots(id, home, project, homes))
            .map(|(root, _)| root)
            .collect::<BTreeSet<_>>()
    };
    let user = roots(None);
    match project {
        None => user,
        Some(project) => roots(Some(project))
            .into_iter()
            .filter(|root| !user.contains(root) && !above_project(root, Some(project)))
            .collect(),
    }
}

/// The project's task worktrees a project view lists (`inventory::collect`'s rule: the project's
/// own, never one that is a listed main checkout). None for All projects, whose uninstall only
/// removes user-level copies.
fn own_worktrees(project: Option<&Path>, project_id: Option<&str>, homes: &Homes) -> Vec<PathBuf> {
    let (Some(project), Some(id)) = (project, project_id) else {
        return Vec::new();
    };
    let mains: BTreeSet<_> = homes
        .projects
        .iter()
        .map(|(_, p)| p.as_path())
        .chain([project])
        .map(checkout_key)
        .collect();
    homes
        .worktrees
        .iter()
        .filter(|(owner, path)| owner == id && !mains.contains(&checkout_key(path)))
        .map(|(_, path)| path.clone())
        .collect()
}

/// This scope's own skill roots (`scope_roots`) plus, in a project view, each of its task
/// worktrees' own roots: a project uninstall removes the copies there too.
fn view_roots(
    home: &Path,
    project: Option<&Path>,
    worktrees: &[PathBuf],
    homes: &Homes,
) -> BTreeSet<PathBuf> {
    let mut roots = scope_roots(home, project, homes);
    for worktree in worktrees {
        roots.extend(scope_roots(home, Some(worktree), homes));
    }
    roots
}

/// How the inventory would show `real` (canonical) when it is a copy in one of a task
/// worktree's own skill roots: `Worktree wt-1 · .agents/skills/x`.
fn worktree_display(
    real: &Path,
    home: &Path,
    worktrees: &[PathBuf],
    homes: &Homes,
) -> Option<String> {
    let (parent, name) = (real.parent()?, real.file_name()?.to_string_lossy());
    worktrees.iter().find_map(|worktree| {
        crate::providers::PROVIDERS
            .iter()
            .flat_map(|(id, _)| roots::skill_roots(id, home, Some(worktree), homes))
            .find(|(root, _)| {
                root.starts_with(worktree) && fs::canonicalize(root).is_ok_and(|r| r == parent)
            })
            .map(|(_, display)| {
                let label = inventory::worktree_label(worktree);
                format!("{label}{}{display}/{name}", inventory::LABEL_SEP)
            })
    })
}

/// A copy outside every checkout of the project view (its main checkout and task worktrees):
/// one of Pi's ancestor `.agents/skills` roots, shared with the projects under it.
fn above_view(path: &Path, project: Option<&Path>, worktrees: &[PathBuf]) -> bool {
    above_project(path, project)
        && worktrees
            .iter()
            .all(|worktree| above_project(path, Some(worktree)))
}

/// A path outside the project being viewed (lexically, or through its canonical folder): one
/// of Pi's ancestor `.agents/skills` roots, or a copy in one. Never true for All projects.
fn above_project(path: &Path, project: Option<&Path>) -> bool {
    let Some(project) = project else {
        return false;
    };
    if path.starts_with(project) {
        return false;
    }
    !fs::canonicalize(project).is_ok_and(|real| path.starts_with(real))
}

/// Skill roots of every project All projects lists (main checkouts and task worktrees), for
/// unlinking links there that lead to a user-level copy being removed.
fn project_roots(home: &Path, homes: &Homes) -> BTreeSet<PathBuf> {
    homes
        .projects
        .iter()
        .chain(&homes.worktrees)
        .flat_map(|(_, project)| scope_roots(home, Some(project), homes))
        .collect()
}

/// Known roots of this scope plus, for All projects, the listed projects' roots, where links to
/// a removed user-level copy may be unlinked, and for a project its task worktrees' roots
/// (`check_inside_roots` and `move_aside`).
fn removal_roots(
    home: &Path,
    project: Option<&Path>,
    worktrees: &[PathBuf],
    homes: &Homes,
) -> BTreeSet<PathBuf> {
    let mut roots = safety::known_roots(home, project, homes);
    if project.is_none() {
        for (_, project) in homes.projects.iter().chain(&homes.worktrees) {
            roots.extend(safety::known_roots(home, Some(project), homes));
        }
    }
    for worktree in worktrees {
        roots.extend(safety::known_roots(home, Some(worktree), homes));
    }
    roots
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

pub(super) fn uninstall_at(
    home: &Path,
    project: Option<&Path>,
    project_id: Option<String>,
    path: &Path,
    homes: &Homes,
    name: &str,
) -> Result<UninstallResult, String> {
    uninstall_with(&install::ADD, home, project, project_id, path, homes, name)
}

/// Folders (and links) to remove, each with its display path, and locations left in place.
struct Plan {
    targets: BTreeMap<PathBuf, String>,
    kept: Vec<String>,
}

/// `worktrees`: the project's task worktrees (`own_worktrees`); their copies are the project's
/// too, resolved against each worktree's roots and held to the same containment.
fn plan(
    row: &ManagedSkill,
    home: &Path,
    project: Option<&Path>,
    worktrees: &[PathBuf],
    path: &Path,
    homes: &Homes,
) -> Plan {
    let scope = if project.is_some() { "project" } else { "user" };
    let roots = removal_roots(home, project, worktrees, homes);
    let real_scope_roots: BTreeSet<PathBuf> = view_roots(home, project, worktrees, homes)
        .iter()
        .filter_map(|root| fs::canonicalize(root).ok())
        .collect();
    let plugin_roots: BTreeSet<PathBuf> = roots::codex_plugins(home, homes)
        .into_iter()
        .filter_map(|(root, _, _)| fs::canonicalize(root).ok())
        .collect();
    let mut found: BTreeMap<PathBuf, String> = BTreeMap::new();
    for agent in row
        .agents
        .iter()
        .filter(|a| a.scope == scope && !a.quarantined)
    {
        let in_worktrees = safety::worktree_folders(agent, home, worktrees, homes)
            .into_iter()
            .map(|(_, folder)| folder);
        for folder in safety::agent_folders(agent, home, project, homes)
            .into_iter()
            .chain(in_worktrees)
        {
            found.entry(folder).or_insert_with(|| agent.path.clone());
        }
    }
    // A link's target is removed too when it is itself an installed copy in this scope.
    let linked: Vec<_> = found
        .keys()
        .filter(|f| fs::symlink_metadata(f).is_ok_and(|m| m.file_type().is_symlink()))
        .filter_map(|f| fs::canonicalize(f).ok())
        .filter(|real| real.parent().is_some_and(|p| real_scope_roots.contains(p)))
        .collect();
    for real in linked {
        let label = real.to_string_lossy().into_owned();
        found.entry(real.clone()).or_insert_with(|| {
            worktree_display(&real, home, worktrees, homes)
                .unwrap_or_else(|| roots::display_path(&real, home, &label))
        });
    }
    let mut plan = Plan {
        targets: BTreeMap::new(),
        kept: Vec::new(),
    };
    for (folder, display) in found {
        if fs::symlink_metadata(&folder).is_err() {
            continue;
        }
        let parent = folder.parent().and_then(|p| fs::canonicalize(p).ok());
        let plugin = parent
            .as_ref()
            .is_some_and(|p| plugin_roots.iter().any(|root| p.starts_with(root)));
        if above_view(&folder, project, worktrees) {
            plan.kept.push(format!(
                "{} ({SHARED_ABOVE})",
                safety::redact_warning(&display)
            ));
        } else if plugin
            || safety::check_inside_roots(&folder, &roots).is_err()
            || accounts::foreign_account_copy(home, homes, path, &folder)
        {
            plan.kept.push(safety::redact_warning(&display));
        } else {
            plan.targets.insert(folder, display);
        }
    }
    sweep_links(&mut plan, home, project, worktrees, path, homes, &roots);
    plan.kept.sort();
    plan.kept.dedup();
    plan
}

/// Links in this scope's roots (a project's include its task worktrees') that lead to a folder
/// being removed would dangle: unlink them
/// too (the inventory lists one folder reached through two roots once). For All projects that
/// includes links in the listed projects' roots: only links, each recorded for Undo.
fn sweep_links(
    plan: &mut Plan,
    home: &Path,
    project: Option<&Path>,
    worktrees: &[PathBuf],
    path: &Path,
    homes: &Homes,
    roots: &BTreeSet<PathBuf>,
) {
    let removed: BTreeSet<PathBuf> = plan
        .targets
        .keys()
        .filter(|f| fs::symlink_metadata(f).is_ok_and(|m| m.is_dir()))
        .filter_map(|f| fs::canonicalize(f).ok())
        .collect();
    if removed.is_empty() {
        return;
    }
    let mut sweep = view_roots(home, project, worktrees, homes);
    if project.is_none() {
        sweep.extend(project_roots(home, homes));
    }
    for root in sweep {
        let Ok(entries) = fs::read_dir(&root) else {
            continue;
        };
        for entry in entries.flatten().take(SWEEP_LIMIT) {
            let link = entry.path();
            if plan.targets.contains_key(&link)
                || !entry.file_type().is_ok_and(|t| t.is_symlink())
                || !fs::canonicalize(&link).is_ok_and(|real| removed.contains(&real))
                || safety::check_inside_roots(&link, roots).is_err()
                || accounts::foreign_account_copy(home, homes, path, &link)
            {
                continue;
            }
            let label = link.to_string_lossy().into_owned();
            plan.targets
                .insert(link.clone(), roots::display_path(&link, home, &label));
        }
    }
}

/// Moves `targets` (links first) into `dir`; all or nothing.
fn move_aside(
    targets: &BTreeMap<PathBuf, String>,
    dir: &Path,
    roots: &BTreeSet<PathBuf>,
) -> Result<(Vec<Item>, Vec<String>), String> {
    let mut ordered: Vec<_> = targets.iter().collect();
    ordered
        .sort_by_key(|(p, _)| !fs::symlink_metadata(p).is_ok_and(|m| m.file_type().is_symlink()));
    let mut items = Vec::new();
    let mut removed = Vec::new();
    let result = (|| -> Result<(), String> {
        for (index, (folder, display)) in ordered.into_iter().enumerate() {
            let meta = match fs::symlink_metadata(folder) {
                // Already moved through another path to the same folder.
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                result => result.map_err(|e| e.to_string())?,
            };
            safety::check_inside_roots(folder, roots).map_err(|e| e.to_string())?;
            if meta.file_type().is_symlink() {
                let link = fs::read_link(folder).map_err(|e| e.to_string())?;
                links::remove_link(folder).map_err(|e| e.to_string())?;
                items.push(Item {
                    original: folder.clone(),
                    stored: None,
                    link: Some(link),
                    put_back: false,
                });
            } else {
                fs::create_dir_all(dir).map_err(|e| e.to_string())?;
                let stored = index.to_string();
                let to = dir.join(&stored);
                let moved = quarantine::move_folder(folder, &to);
                // A copy that is the one full copy is recorded, so it is put back, not deleted.
                if moved.is_ok() || quarantine::kept_after_failed_move(folder, &to) {
                    items.push(Item {
                        original: folder.clone(),
                        stored: Some(stored),
                        link: None,
                        put_back: false,
                    });
                }
                moved.map_err(|e| e.to_string())?;
            }
            removed.push(safety::redact_warning(display));
        }
        Ok(())
    })();
    if let Err(error) = result {
        return Err(match quarantine::put_back(&items, dir) {
            Ok(()) => {
                let _ = fs::remove_dir_all(dir);
                error
            }
            // What could not be put back stays in `dir`, never deleted.
            Err(stuck) => format!("{error}. {stuck}, kept in {}", dir.display()),
        });
    }
    Ok((items, removed))
}

/// `lock` is the install lock (`install::ADD`); tests pass their own.
pub(super) fn uninstall_with(
    lock: &Mutex<()>,
    home: &Path,
    project: Option<&Path>,
    project_id: Option<String>,
    path: &Path,
    homes: &Homes,
    name: &str,
) -> Result<UninstallResult, String> {
    if name.is_empty() || name.len() > 1024 {
        return Err("Choose an installed skill to uninstall.".into());
    }
    let _install = claim(lock)?;
    let prefs = {
        let _guard = recover(&LOCK);
        read_prefs(path)?
    };
    let before = list_with_prefs(home, project, project_id.clone(), &prefs, homes);
    let Some(row) = before
        .skills
        .iter()
        .find(|s| s.name == name && !s.missing && !s.agents.is_empty())
    else {
        return Err(
            "This skill is no longer installed. Refresh the skill list and try again.".into(),
        );
    };
    let worktrees = own_worktrees(project, project_id.as_deref(), homes);
    let plan = plan(row, home, project, &worktrees, path, homes);
    if plan.targets.is_empty() {
        return Err(if plan.kept.is_empty() {
            "PandaCode found no copy of this skill it can remove here.".into()
        } else if plan.kept.iter().all(|kept| kept.ends_with(&format!("({SHARED_ABOVE})"))) {
            format!(
                "This skill's copies here are shared with other projects, so PandaCode left them in place: {}.",
                plan.kept.join(", ")
            )
        } else {
            format!(
                "PandaCode didn't install the copies here, so it left them in place: {}.",
                plan.kept.join(", ")
            )
        });
    }
    let id = uuid::Uuid::new_v4().to_string();
    let dir = store_dir(path).join(&id);
    let roots = removal_roots(home, project, &worktrees, homes);
    let (items, removed) = move_aside(&plan.targets, &dir, &roots)
        .map_err(|e| safety::redact_warning(&format!("Could not uninstall the skill: {e}")))?;
    let after = list_with_prefs(home, project, project_id.clone(), &prefs, homes);
    let left = after
        .skills
        .iter()
        .any(|s| s.name == name && !s.missing && !s.agents.is_empty())
        || quarantine::names(path).contains(name);
    let record = Record {
        id: id.clone(),
        name: name.into(),
        project_id: project_id.clone(),
        items,
        cleared_all: false,
        cleared_projects: Vec::new(),
        removed_at: now_ms(),
    };
    let (switches_cleared, expired, error) = match save(path, record, !left) {
        Ok((cleared, expired)) => (cleared, expired, None),
        Err(Saved::Record(error, record)) => {
            // Without a record Undo could not find the files: put them back instead. What
            // can't go back stays in `dir`, never deleted.
            let stuck = match quarantine::put_back(&record.items, &dir) {
                Ok(()) => {
                    let _ = fs::remove_dir_all(&dir);
                    String::new()
                }
                Err(stuck) => format!(". {stuck}, kept in {}", dir.display()),
            };
            return Err(safety::redact_warning(&format!(
                "Could not uninstall the skill: {error}{stuck}"
            )));
        }
        Err(Saved::Switches(error, expired)) => (false, expired, Some(error)),
    };
    let mut inventory = list_at(home, project, project_id, path, homes)?;
    if let Some(error) = error {
        inventory.error = Some(safety::redact_warning(&format!(
            "The skill was uninstalled, but its switches could not be cleared: {error}"
        )));
    }
    Ok(UninstallResult {
        inventory,
        uninstalled: Uninstalled {
            id,
            name: name.into(),
            removed,
            kept: plan.kept,
            switches_cleared,
            expired_undo: expired
                .iter()
                .map(|r| safety::redact_warning(&r.name))
                .collect(),
            expired_undo_ids: expired.into_iter().map(|r| r.id).collect(),
        },
    })
}

enum Saved {
    /// The record could not be written; the files must go back.
    Record(String, Box<Record>),
    /// The record is saved (forgetting the expired ones), but clearing switches failed.
    Switches(String, Vec<Record>),
}

/// Under `LOCK`: records the uninstall and, when no copy is left (`gone`), clears the name's
/// switches for this view (All projects: every switch; a project: its own), noting which.
/// Returns whether switches were cleared and the older records forgotten to make room.
fn save(path: &Path, mut record: Record, gone: bool) -> Result<(bool, Vec<Record>), Saved> {
    let _guard = recover(&LOCK);
    let mut prefs = None;
    if gone {
        if let Ok(mut latest) = read_prefs(path) {
            let name = record.name.clone();
            match record.project_id.as_deref() {
                None => {
                    record.cleared_all = latest.off_in_panda_code.remove(&name);
                    for (project, names) in latest.projects.iter_mut() {
                        if names.remove(&name) {
                            record.cleared_projects.push(project.clone());
                        }
                    }
                }
                Some(project) => {
                    if latest
                        .projects
                        .get_mut(project)
                        .is_some_and(|names| names.remove(&name))
                    {
                        record.cleared_projects.push(project.into());
                    }
                }
            }
            latest.projects.retain(|_, names| !names.is_empty());
            prefs = Some(latest);
        }
    }
    let cleared = record.cleared_all || !record.cleared_projects.is_empty();
    let mut records = match read(path) {
        Ok(records) => records,
        Err(error) => return Err(Saved::Record(error, Box::new(record))),
    };
    let id = record.id.clone();
    records.push(record);
    let expired = match write(path, &mut records, &id) {
        Ok(expired) => expired,
        Err(error) => {
            let record = records.pop().expect("pushed record");
            return Err(Saved::Record(error, Box::new(record)));
        }
    };
    match prefs.filter(|_| cleared) {
        Some(prefs) => match save_prefs(path, &prefs) {
            Ok(()) => Ok((true, expired)),
            Err(error) => Err(Saved::Switches(error, expired)),
        },
        None => Ok((false, expired)),
    }
}

/// Puts an uninstall's files back where they were and sets the switches it cleared again.
pub(super) fn undo_at(
    home: &Path,
    project: Option<&Path>,
    project_id: Option<String>,
    path: &Path,
    homes: &Homes,
    id: &str,
) -> Result<SkillInventory, String> {
    undo_with(&install::ADD, path, id)?;
    list_at(home, project, project_id, path, homes)
}

pub(super) fn undo_with(lock: &Mutex<()>, path: &Path, id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 64 || !id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
        return Err("This uninstall can no longer be undone.".into());
    }
    let _install = claim(lock)?;
    let record = {
        let _guard = recover(&LOCK);
        read(path)?.into_iter().find(|r| r.id == id)
    }
    .ok_or("This uninstall can no longer be undone.")?;
    let dir = store_dir(path).join(&record.id);
    // Like Restore: an Undo whose rollback could not move every item back leaves those items
    // at their original paths (their kept copy gone) and marks them. They count as done; the
    // rest is retried. A kept copy gone without that mark is missing, whatever is now there.
    let pending: Vec<&Item> = record
        .items
        .iter()
        .filter(|item| !quarantine::already_restored(item, &dir))
        .collect();
    if pending
        .iter()
        .filter_map(|item| item.stored.as_ref())
        .any(|stored| !dir.join(stored).exists())
    {
        // The record can never be undone: drop it, leaving the switches as they are.
        let _guard = recover(&LOCK);
        let mut records = read(path)?;
        records.retain(|r| r.id != record.id);
        write(path, &mut records, "")?;
        return Err(MISSING.into());
    }
    if pending
        .iter()
        .any(|item| fs::symlink_metadata(&item.original).is_ok())
    {
        return Err(OCCUPIED.into());
    }
    // Folders first so restored links point at existing targets.
    let mut items = pending;
    items.sort_by_key(|item| item.stored.is_none());
    let mut done: Vec<&Item> = Vec::new();
    for item in items {
        if let Err(error) = quarantine::restore_item(item, &dir) {
            let left = quarantine::take_back(&done, &dir);
            if let Err(mark) = mark_put_back(path, &record.id, &left) {
                eprintln!("Warning: could not record the items left put back: {mark}");
            }
            return Err(if error.kind() == std::io::ErrorKind::AlreadyExists {
                OCCUPIED.into()
            } else {
                format!("Could not put the skill back: {error}")
            });
        }
        done.push(item);
    }
    let _ = fs::remove_dir_all(&dir);
    let _guard = recover(&LOCK);
    let mut records = read(path)?;
    records.retain(|r| r.id != record.id);
    // Removing a record only shrinks the file: nothing else is forgotten here.
    write(path, &mut records, "")?;
    if record.cleared_all || !record.cleared_projects.is_empty() {
        let mut prefs = read_prefs(path)?;
        if record.cleared_all {
            prefs.off_in_panda_code.insert(record.name.clone());
        }
        for project in &record.cleared_projects {
            prefs
                .projects
                .entry(project.clone())
                .or_default()
                .insert(record.name.clone());
        }
        save_prefs(path, &prefs)?;
    }
    Ok(())
}

/// Under `LOCK`: marks the items of record `id` left put back by a failed rollback.
fn mark_put_back(path: &Path, id: &str, left: &[PathBuf]) -> Result<(), String> {
    if left.is_empty() {
        return Ok(());
    }
    let _guard = recover(&LOCK);
    let mut records = read(path)?;
    for record in records.iter_mut().filter(|r| r.id == id) {
        quarantine::mark_items(&mut record.items, left);
    }
    write(path, &mut records, id).map(|_| ())
}

#[cfg(test)]
#[path = "uninstall_tests.rs"]
mod tests;
#[cfg(test)]
#[path = "uninstall_scope_tests.rs"]
mod scope_tests;
