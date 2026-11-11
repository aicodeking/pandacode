//! The last inventory scan of each view, so a switch save updates flags without rescanning
//! skill roots. Lists refresh it; adds and project changes forget it; a save without one scans.
use super::*;

/// One scan: its rows before quarantine rows and switch flags, and whether every OpenCode agent
/// in the view could be listed.
#[derive(Clone)]
pub(super) struct Scan {
    pub(super) skills: Vec<ManagedSkill>,
    pub(super) not_shown: usize,
    pub(super) opencode_complete: bool,
}

const VIEWS: usize = 8;
static LAST: std::sync::LazyLock<Mutex<Vec<(String, Scan)>>> =
    std::sync::LazyLock::new(|| Mutex::new(Vec::new()));

/// Everything a scan of this view depends on besides the files themselves.
pub(super) fn key(
    home: &Path,
    project: Option<&Path>,
    project_id: Option<&str>,
    prefs: &Path,
    homes: &Homes,
) -> String {
    format!(
        "{:?}",
        (
            prefs,
            home,
            project,
            project_id,
            &homes.projects,
            &homes.worktrees,
            &homes.configured,
            [
                &homes.claude,
                &homes.codex,
                &homes.xdg_config,
                &homes.pi,
                &homes.grok,
                &homes.hermes,
            ],
        )
    )
}

pub(super) fn get(key: &str) -> Option<Scan> {
    recover(&LAST)
        .iter()
        .find(|(k, _)| k == key)
        .map(|(_, scan)| scan.clone())
}

pub(super) fn remember(key: String, scan: Scan) {
    let mut last = recover(&LAST);
    last.retain(|(k, _)| *k != key);
    if last.len() >= VIEWS {
        last.remove(0);
    }
    last.push((key, scan));
}

/// Skills were added or projects changed: the next save scans again.
pub(crate) fn forget() {
    recover(&LAST).clear();
}

/// Forgets every scan when dropped, so an add that fails part-way still invalidates them.
pub(super) struct Forget;
impl Drop for Forget {
    fn drop(&mut self) {
        forget();
    }
}

/// The cached scan of this view, or a fresh one (remembered for the next save).
pub(super) fn scan(
    home: &Path,
    project: Option<&Path>,
    project_id: Option<&str>,
    prefs_path: &Path,
    prefs: &Prefs,
    homes: &Homes,
) -> (String, Scan) {
    let key = key(home, project, project_id, prefs_path, homes);
    if let Some(scan) = get(&key) {
        return (key, scan);
    }
    let scan = fresh(home, project, project_id, prefs, homes);
    remember(key.clone(), scan.clone());
    (key, scan)
}

/// A new scan of skill roots (and OpenCode agents) for this view.
pub(super) fn fresh(
    home: &Path,
    project: Option<&Path>,
    project_id: Option<&str>,
    prefs: &Prefs,
    homes: &Homes,
) -> Scan {
    let (skills, not_shown) = inventory::with_counts(home, project, project_id, prefs, homes);
    Scan {
        skills,
        not_shown,
        opencode_complete: opencode_complete(home, project, homes),
    }
}

/// Whether OpenCode's skill denies reach every agent it could run in this view's folder.
pub(super) fn opencode_complete(home: &Path, project: Option<&Path>, homes: &Homes) -> bool {
    opencode_agents::agents(project.unwrap_or(home), home, homes).complete
}
