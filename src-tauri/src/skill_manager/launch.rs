use super::*;
use crate::storage::Store;

pub(super) fn open(path: &Path) -> Result<Store, String> {
    Store::open_read_only(path)
}
pub(super) fn session_project(
    path: &Path,
    session_id: &str,
    cwd: Option<&Path>,
) -> Result<Project, String> {
    let store = open(path)?;
    if let Some(project) = store.launch_session_project(session_id)? {
        return Ok(Some(project));
    }
    eprintln!("Warning: skill settings session is not stored; resolving its launch directory before using global-only settings.");
    cwd.map(|cwd| project_at(&store, cwd)).unwrap_or(Ok(None))
}
pub(super) fn project_at(store: &Store, cwd: &Path) -> Result<Project, String> {
    store.launch_project_at(cwd)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::skill_manager::tests::Fixture;
    #[test]
    fn skill_manager_sqlite_launch_lookup_waits_for_writers() {
        let f = Fixture::new();
        let path = f.0.join("db.sqlite");
        Store::open(&path).unwrap();
        let db = open(&path).unwrap();
        let timeout: i64 = db
            .db
            .query_row("PRAGMA busy_timeout", [], |r| r.get(0))
            .unwrap();
        assert!(timeout >= 5000);
    }
    #[test]
    fn skill_manager_read_only_launch_rejects_schema_drift() {
        let f = Fixture::new();
        let path = f.0.join("db.sqlite");
        let store = Store::open(&path).unwrap();
        store
            .db
            .pragma_update(None, "user_version", crate::storage::SCHEMA_VERSION + 1)
            .unwrap();
        assert!(open(&path).err().unwrap().contains("Database schema"));
    }
    #[test]
    fn skill_manager_worktree_lookups_canonicalize_paths() {
        let f = Fixture::new();
        let main = f.0.join("main");
        let worktree = f.0.join("worktree");
        fs::create_dir_all(&main).unwrap();
        fs::create_dir_all(&worktree).unwrap();
        let store = crate::storage::Store::open(Path::new(":memory:")).unwrap();
        let project = store.add_project(&main).unwrap();
        let task = store
            .create_session(&project.id, "claude", "default", "ask")
            .unwrap();
        store
            .create_worktree_session_on(&task, &worktree, None)
            .unwrap();
        let equivalent = worktree.join("..").join("worktree");
        assert_eq!(
            project_at(&store, &equivalent).unwrap().unwrap().0,
            project.id
        );
        assert_eq!(
            project_at(&store, &main.join(".")).unwrap().unwrap().0,
            project.id
        );
    }
}
