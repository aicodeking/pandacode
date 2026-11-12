//! Resolve launch and catalog switches while retaining the last usable project lookup.
use super::*;
pub(super) type Project = Option<(String, String)>;
/// Session → project, refreshed by each launch and read by every later turn, bot brief and
/// gateway call. Entries are stamped with the `GENERATION` they were resolved in.
pub(super) static PROJECTS: std::sync::LazyLock<Mutex<BTreeMap<String, SessionProject>>> =
    std::sync::LazyLock::new(|| Mutex::new(BTreeMap::new()));
/// Bumped whenever projects or worktrees change (`projects_changed`): a session entry from an
/// earlier generation is resolved again before use, so no caller acts on a removed or
/// relinked project's mapping.
#[cfg(not(test))]
static GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
// Tests: one generation and folder cache per test thread, so a parallel test that adds a
// project (`bots::create`) never invalidates another test's lookups midway.
#[cfg(test)]
thread_local! {
    static GENERATION: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
    static PATH_PROJECTS: &'static Mutex<PathProjects> =
        Box::leak(Box::new(Mutex::new(PathProjects::default())));
}

#[cfg(not(test))]
fn generation() -> u64 {
    GENERATION.load(std::sync::atomic::Ordering::SeqCst)
}
#[cfg(test)]
fn generation() -> u64 {
    GENERATION.get()
}

#[cfg(not(test))]
fn bump_generation() {
    GENERATION.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
}
#[cfg(test)]
fn bump_generation() {
    GENERATION.set(GENERATION.get() + 1);
}

/// The folder → project cache (per test thread in tests).
#[cfg(not(test))]
pub(super) fn path_projects() -> &'static Mutex<PathProjects> {
    &PATH_PROJECTS
}
#[cfg(test)]
pub(super) fn path_projects() -> &'static Mutex<PathProjects> {
    PATH_PROJECTS.with(|cache| *cache)
}

/// One session's project, the generation it was resolved in, and the launch folder it was
/// resolved from (so a session absent from SQLite resolves the same way again).
#[derive(Clone, Debug)]
pub(super) struct SessionProject {
    generation: u64,
    project: Project,
    cwd: Option<PathBuf>,
}
#[cfg(not(test))]
static PATH_PROJECTS: std::sync::LazyLock<Mutex<PathProjects>> =
    std::sync::LazyLock::new(|| Mutex::new(PathProjects::default()));

/// Folder → owning project, for slash catalogs. Any project or worktree change starts a new
/// generation: entries are dropped, and a lookup that began before the change is not stored.
#[derive(Default)]
pub(super) struct PathProjects {
    generation: u64,
    entries: BTreeMap<String, Project>,
}
impl PathProjects {
    fn get(&self, cwd: &Path) -> Option<Project> {
        self.entries.get(&checkout_key(cwd)).cloned()
    }
    fn remember(&mut self, generation: u64, cwd: &Path, project: Project) {
        if generation != self.generation {
            return;
        }
        if self.entries.len() >= 256 {
            self.entries.pop_first();
        }
        self.entries.insert(checkout_key(cwd), project);
    }
    fn invalidate(&mut self) {
        self.generation += 1;
        self.entries.clear();
    }
    #[cfg(test)]
    pub(super) fn forget(&mut self, cwd: &Path) {
        self.entries.remove(&checkout_key(cwd));
    }
}

/// Projects or worktrees were added, removed, relinked or recreated: forget folder lookups.
pub(crate) fn projects_changed() {
    bump_generation();
    recover(path_projects()).invalidate();
    super::scan_cache::forget();
}

#[cfg(test)]
pub(super) fn disabled_for_session(
    prefs: &Prefs,
    db: &rusqlite::Connection,
    session_id: &str,
) -> BTreeSet<String> {
    use rusqlite::OptionalExtension;
    let project = db
        .query_row(
            "SELECT p.id,p.path FROM sessions s JOIN projects p ON p.id=s.project_id WHERE s.id=?1",
            [session_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .unwrap_or_else(|error| {
            eprintln!("Warning: could not resolve skill settings project: {error}");
            None
        });
    disabled_with_project(prefs, project.as_ref(), None)
}
pub(crate) fn disabled_for(session_id: &str) -> BTreeSet<String> {
    let Some(dir) = crate::secret_store::dir() else {
        // Standalone adapters have no settings location before app startup.
        return BTreeSet::new();
    };
    disabled_for_at(dir, session_id, None)
}
pub(super) fn disabled_for_at(
    dir: &Path,
    session_id: &str,
    cwd: Option<&Path>,
) -> BTreeSet<String> {
    let prefs = launch_prefs(&dir.join("skill-manager.json"));
    if prefs.projects.values().all(BTreeSet::is_empty) {
        return prefs.off_in_panda_code;
    }
    let current = generation();
    let cached = recover(&PROJECTS).get(session_id).cloned();
    if let Some(entry) = &cached {
        if entry.generation == current && (entry.project.is_some() || cwd.is_none()) {
            return disabled_with_project(&prefs, entry.project.as_ref(), cwd);
        }
    }
    // Missing, or stale after a project change: resolve again, from the folder the session
    // was launched in when this caller has none.
    let launch_cwd = cwd.or_else(|| cached.as_ref().and_then(|entry| entry.cwd.as_deref()));
    match launch::session_project(&dir.join("kingcode.sqlite3"), session_id, launch_cwd) {
        Ok(project) => {
            remember_session_in(current, session_id, project.clone(), launch_cwd);
            disabled_with_project(&prefs, project.as_ref(), cwd)
        }
        Err(error) => {
            eprintln!("Warning: could not resolve skill settings project: {error}");
            conservative_disabled(&prefs)
        }
    }
}
fn conservative_disabled(prefs: &Prefs) -> BTreeSet<String> {
    prefs
        .off_in_panda_code
        .iter()
        .chain(prefs.projects.values().flatten())
        .cloned()
        .collect()
}
pub(super) fn disabled_with_project(
    prefs: &Prefs,
    project: Option<&(String, String)>,
    cwd: Option<&Path>,
) -> BTreeSet<String> {
    prefs.disabled(
        project.map(|p| p.0.as_str()),
        project.map(|p| Path::new(&p.1)).or(cwd),
    )
}
#[cfg(test)]
pub(super) fn remember_session(session_id: &str, project: Project) {
    remember_session_in(generation(), session_id, project, None);
}
/// Stores a lookup stamped with the generation it began in: one a project change overtook is
/// already stale, so the next read resolves it again (from the same launch folder).
fn remember_session_in(generation: u64, session_id: &str, project: Project, cwd: Option<&Path>) {
    let mut cache = recover(&PROJECTS);
    if cache.len() >= 256 && !cache.contains_key(session_id) {
        cache.pop_first();
    }
    let entry = SessionProject {
        generation,
        project,
        cwd: cwd.map(Path::to_path_buf),
    };
    cache.insert(session_id.into(), entry);
}
/// Callers holding the Store lock reuse their project lookup for slash catalogs.
pub(crate) fn remember_project(cwd: &Path, project_id: &str, main: &Path) {
    let mut cache = recover(path_projects());
    let generation = cache.generation;
    cache.remember(
        generation,
        cwd,
        Some((project_id.into(), main.to_string_lossy().into_owned())),
    );
}
/// Resolve worktree paths through their owning session before falling back to a project root.
pub(crate) fn disabled_at(cwd: &Path) -> BTreeSet<String> {
    let Some(dir) = crate::secret_store::dir() else {
        return BTreeSet::new();
    };
    let prefs = launch_prefs(&dir.join("skill-manager.json"));
    disabled_for_path(&prefs, cwd, || {
        launch::open(&dir.join("kingcode.sqlite3")).and_then(|db| launch::project_at(&db, cwd))
    })
}
pub(super) fn disabled_for_path(
    prefs: &Prefs,
    cwd: &Path,
    lookup: impl FnOnce() -> Result<Project, String>,
) -> BTreeSet<String> {
    disabled_for_path_in(path_projects(), prefs, cwd, lookup)
}
fn disabled_for_path_in(
    cache: &Mutex<PathProjects>,
    prefs: &Prefs,
    cwd: &Path,
    lookup: impl FnOnce() -> Result<Project, String>,
) -> BTreeSet<String> {
    if prefs.projects.values().all(BTreeSet::is_empty) {
        return prefs.off_in_panda_code.clone();
    }
    let (cached, generation) = {
        let cache = recover(cache);
        (cache.get(cwd), cache.generation)
    };
    if let Some(project) = cached {
        return disabled_with_project(prefs, project.as_ref(), Some(cwd));
    }
    match lookup() {
        Ok(project) => {
            if project.is_some() {
                recover(cache).remember(generation, cwd, project.clone());
            }
            disabled_with_project(prefs, project.as_ref(), Some(cwd))
        }
        Err(error) => {
            eprintln!("Warning: could not resolve skill settings project: {error}");
            conservative_disabled(prefs)
        }
    }
}
/// Each launch refreshes the lookup, including synthetic sessions absent from SQLite.
pub(crate) fn begin_launch(session_id: &str) {
    if let Some(dir) = crate::secret_store::dir() {
        refresh_project(dir, session_id, None);
    }
}
pub(crate) fn begin_launch_at(session_id: &str, cwd: &Path) {
    if let Some(dir) = crate::secret_store::dir() {
        refresh_project(dir, session_id, Some(cwd));
    }
}
pub(super) fn refresh_project(dir: &Path, session_id: &str, cwd: Option<&Path>) {
    let current = generation();
    match launch::session_project(&dir.join("kingcode.sqlite3"), session_id, cwd) {
        Ok(project) => remember_session_in(current, session_id, project, cwd),
        Err(error) => eprintln!("Warning: keeping last good skill project: {error}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::skill_manager::tests::Fixture;
    #[test]
    fn skill_manager_sqlite_failure_preserves_project_disables_and_last_good_session() {
        let f = Fixture::new();
        let prefs =
            Prefs::default()
                .set("global", false, None)
                .set("project-only", false, Some("p"));
        save_prefs(&f.0.join("skill-manager.json"), &prefs).unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        // An unknown session with an unavailable DB conservatively retains every disable.
        assert_eq!(
            disabled_for_at(&f.0, &id, None),
            BTreeSet::from(["global".into(), "project-only".into()])
        );
        remember_session(
            &id,
            Some(("p".into(), f.0.join("main").to_string_lossy().into_owned())),
        );
        refresh_project(&f.0, &id, None);
        assert_eq!(
            disabled_for_at(&f.0, &id, None),
            prefs.disabled(Some("p"), None)
        );
        recover(&PROJECTS).remove(&id);
    }

    #[test]
    fn skill_manager_missing_session_resolves_launch_cwd_main_and_worktree() {
        let f = Fixture::new();
        let root = f.0.join("project");
        let worktree = f.0.join("worktree");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&worktree).unwrap();
        let store = crate::storage::Store::open(&f.0.join("kingcode.sqlite3")).unwrap();
        let project = store.add_project(&root).unwrap();
        let task = store
            .create_session(&project.id, "codex", "default", "ask")
            .unwrap();
        store
            .create_worktree_session_on(&task, &worktree, None)
            .unwrap();
        let prefs = Prefs::default()
            .set("global", false, None)
            .set("local", false, Some(&project.id))
            .set("other", false, Some("other"));
        save_prefs(&f.0.join("skill-manager.json"), &prefs).unwrap();
        for cwd in [&root, &worktree, &worktree.join("..").join("worktree")] {
            let id = uuid::Uuid::new_v4().to_string();
            remember_session(&id, None);
            assert_eq!(
                disabled_for_at(&f.0, &id, Some(cwd)),
                BTreeSet::from(["global".into(), "local".into()])
            );
            recover(&PROJECTS).remove(&id);
            refresh_project(&f.0, &id, Some(cwd));
            assert_eq!(
                disabled_for_at(&f.0, &id, None),
                BTreeSet::from(["global".into(), "local".into()])
            );
            recover(&PROJECTS).remove(&id);
        }
        let id = uuid::Uuid::new_v4().to_string();
        assert_eq!(
            disabled_for_at(&f.0, &id, Some(&f.0)),
            BTreeSet::from(["global".into()])
        );
        recover(&PROJECTS).remove(&id);
    }

    #[test]
    fn skill_manager_session_project_cache_is_resolved_again_after_projects_change() {
        let f = Fixture::new();
        let (a, b) = (f.0.join("a"), f.0.join("b"));
        fs::create_dir_all(&a).unwrap();
        fs::create_dir_all(&b).unwrap();
        let store = crate::storage::Store::open(&f.0.join("kingcode.sqlite3")).unwrap();
        let (first, second) = (store.add_project(&a).unwrap(), store.add_project(&b).unwrap());
        let task = store
            .create_session(&second.id, "codex", "default", "ask")
            .unwrap();
        let prefs = Prefs::default()
            .set("a-off", false, Some(&first.id))
            .set("b-off", false, Some(&second.id));
        save_prefs(&f.0.join("skill-manager.json"), &prefs).unwrap();
        let old = Some((first.id.clone(), a.to_string_lossy().into_owned()));
        // A mapping from before a project change (the session's project was relinked).
        remember_session(&task.id, old.clone());
        assert_eq!(
            disabled_for_at(&f.0, &task.id, None),
            BTreeSet::from(["a-off".into()]),
            "within one generation the cached mapping is used"
        );
        bump_generation();
        // A bot brief or gateway read (no launch since) resolves the session again.
        assert_eq!(
            disabled_for_at(&f.0, &task.id, None),
            BTreeSet::from(["b-off".into()])
        );
        let entry = recover(&PROJECTS).get(&task.id).cloned().unwrap();
        assert_eq!(entry.project.unwrap().0, second.id);
        assert_eq!(entry.generation, generation());
        recover(&PROJECTS).remove(&task.id);

        // A stale mapping whose lookup fails is never used: every switch stays off.
        let elsewhere = Fixture::new();
        save_prefs(&elsewhere.0.join("skill-manager.json"), &prefs).unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        remember_session(&id, old);
        bump_generation();
        assert_eq!(
            disabled_for_at(&elsewhere.0, &id, None),
            BTreeSet::from(["a-off".into(), "b-off".into()])
        );
        recover(&PROJECTS).remove(&id);
    }

    #[test]
    fn skill_manager_path_project_cache_forgets_lookups_when_projects_change() {
        let cache = Mutex::new(PathProjects::default());
        let cwd = Path::new("/pandacode-cache-test/worktree");
        let prefs = Prefs::default().set("old-only", false, Some("old"));
        let old = || Ok(Some(("old".to_string(), "/main".to_string())));
        assert!(disabled_for_path_in(&cache, &prefs, cwd, old).contains("old-only"));
        // Cached: no second lookup.
        assert!(
            disabled_for_path_in(&cache, &prefs, cwd, || panic!("cached")).contains("old-only")
        );
        // The project is removed (or the worktree path reused): the next lookup is fresh.
        recover(&cache).invalidate();
        assert!(disabled_for_path_in(&cache, &prefs, cwd, || Ok(None)).is_empty());
        // A lookup that started before a change is not stored.
        let generation = recover(&cache).generation;
        recover(&cache).invalidate();
        recover(&cache).remember(generation, cwd, Some(("old".into(), "/main".into())));
        assert!(recover(&cache).get(cwd).is_none());
    }
}
