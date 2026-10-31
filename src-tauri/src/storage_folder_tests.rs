use super::*;

fn canonical(path: &Path) -> String {
    path.canonicalize().unwrap().to_string_lossy().to_string()
}

/// A scratch directory of distinct real folders; the store keeps their canonical paths.
fn scratch(tag: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("pandacode-folders-{tag}-{}", id()));
    std::fs::create_dir_all(&root).unwrap();
    root
}

fn folder_dir(root: &Path, name: &str) -> PathBuf {
    let path = root.join(name);
    std::fs::create_dir_all(&path).unwrap();
    path
}

fn paths_of(folders: &[Folder]) -> Vec<String> {
    folders.iter().map(|f| f.path.clone()).collect()
}

/// After every folder mutation exactly one row is primary and projects.path follows it.
fn assert_single_primary(store: &Store, project_id: &str) {
    let folders = store.project_folders(project_id).unwrap();
    let primaries: Vec<&Folder> = folders.iter().filter(|f| f.is_primary).collect();
    assert_eq!(primaries.len(), 1, "exactly one primary folder: {folders:?}");
    assert_eq!(
        store.project(project_id).unwrap().path,
        primaries[0].path,
        "projects.path follows the primary folder"
    );
}

fn pull_link(number: i64, title: &str) -> TaskLink {
    TaskLink {
        kind: "pull".into(),
        number,
        url: format!("https://github.com/o/r/pull/{number}"),
        title: title.into(),
        state: "open".into(),
        checked_at: 0,
    }
}

/// A fresh database is at version 37 with both folder tables, the task_links repo
/// dimension, cross-project path uniqueness and the foreign-key cascades.
#[test]
fn schema_37_creates_folder_tables_and_keys_task_links_by_repo() {
    let store = Store::open(Path::new(":memory:")).unwrap();
    let version: i64 = store
        .db
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap();
    assert_eq!(version, 37, "the folder migration moves the schema to 37");
    for table in ["project_folders", "session_repos"] {
        let exists: bool = store
            .db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
                [table],
                |row| row.get(0),
            )
            .unwrap();
        assert!(exists, "{table} exists");
    }
    let repo_column: i64 = store
        .db
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('task_links') WHERE name='repo'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(repo_column, 1, "task_links carries the repo dimension");

    let root = scratch("schema");
    let project = store.add_project(&root).unwrap();
    let other_dir = folder_dir(&root, "other");
    let other = store.add_project(&other_dir).unwrap();
    let extra = folder_dir(&root, "extra");
    let task = store
        .create_session(&project.id, "claude", "sonnet", "full")
        .unwrap();

    // Links default to the primary repo key and each repo holds its own row.
    store
        .db
        .execute(
            "INSERT INTO task_links(session_id,kind,number,url,title,state,checked_at) VALUES(?1,'pull',5,'https://github.com/o/r/pull/5','Default repo','open',0)",
            [&task.id],
        )
        .unwrap();
    let defaulted: String = store
        .db
        .query_row(
            "SELECT repo FROM task_links WHERE session_id=?1 AND number=5",
            [&task.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(defaulted, "", "repo defaults to the empty primary key");
    for repo in ["repoA", "repoB"] {
        store
            .db
            .execute(
                "INSERT INTO task_links(session_id,kind,repo,number,url,title,state,checked_at) VALUES(?1,'pull',?2,6,'https://github.com/o/r/pull/6','T','open',0)",
                params![task.id, repo],
            )
            .unwrap();
    }
    let pulls: i64 = store
        .db
        .query_row(
            "SELECT COUNT(*) FROM task_links WHERE session_id=?1 AND kind='pull'",
            [&task.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        pulls, 3,
        "the empty repo key and each named repo hold their own link"
    );
    assert!(store
        .db
        .execute(
            "INSERT INTO task_links(session_id,kind,repo,number,url,title,state,checked_at) VALUES(?1,'pull','repoA',8,'u','t','open',0)",
            [&task.id],
        )
        .is_err(), "(session_id,kind,repo) is the primary key");

    // One folder belongs to one project, enforced by the schema.
    store
        .db
        .execute(
            "INSERT INTO project_folders(project_id,path) VALUES(?1,?2)",
            params![project.id, extra.to_string_lossy()],
        )
        .unwrap();
    assert!(store
        .db
        .execute(
            "INSERT INTO project_folders(project_id,path) VALUES(?1,?2)",
            params![other.id, extra.to_string_lossy()],
        )
        .is_err(), "a folder path is unique across projects");

    // Session and project deletes cascade through both new tables.
    store
        .db
        .execute(
            "INSERT INTO session_repos(session_id,path,worktree_path,worktree_branch) VALUES(?1,?2,?3,'feat/x')",
            params![task.id, extra.to_string_lossy(), folder_dir(&root, "wt").to_string_lossy()],
        )
        .unwrap();
    store
        .db
        .execute("DELETE FROM sessions WHERE id=?1", [&task.id])
        .unwrap();
    let repos: i64 = store
        .db
        .query_row("SELECT COUNT(*) FROM session_repos", [], |row| row.get(0))
        .unwrap();
    assert_eq!(repos, 0, "session_repos cascade with their session");
    store
        .db
        .execute("DELETE FROM projects WHERE id=?1", [&project.id])
        .unwrap();
    let folders: i64 = store
        .db
        .query_row(
            "SELECT COUNT(*) FROM project_folders WHERE project_id=?1",
            [&project.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(folders, 0, "project_folders cascade with their project");
    std::fs::remove_dir_all(&root).unwrap();
}

/// A database exactly as version 36 shipped it: every project is seeded with one
/// primary folder, task_links is rebuilt with repo='' and legacy link reads keep
/// working (old tasks and mobile keep their single-link readers).
#[test]
fn migration_36_seeds_one_primary_folder_per_project_and_keeps_legacy_links() {
    let root = scratch("migration");
    let path = root.join("store.sqlite");
    let (first_id, second_id, first_dir, second_dir, sid) = {
        let store = Store::open(&path).unwrap();
        let first_dir = folder_dir(&root, "first");
        let second_dir = folder_dir(&root, "second");
        let first = store.add_project(&first_dir).unwrap();
        let second = store.add_project(&second_dir).unwrap();
        let task = store
            .create_session(&first.id, "claude", "sonnet", "full")
            .unwrap();
        // Rebuild exactly what version 36 shipped: no folder tables, links keyed
        // (session_id,kind) with no repo column.
        store
            .db
            .execute_batch(
                "DROP TABLE task_links;
                 CREATE TABLE task_links(session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,kind TEXT NOT NULL CHECK(kind IN ('issue','pull')),number INTEGER NOT NULL,url TEXT NOT NULL,title TEXT NOT NULL DEFAULT '',state TEXT NOT NULL DEFAULT '',checked_at INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(session_id,kind));
                 CREATE INDEX task_links_number ON task_links(kind,number);
                 DROP TABLE IF EXISTS project_folders;
                 DROP TABLE IF EXISTS session_repos;
                 PRAGMA user_version=36;",
            )
            .unwrap();
        store
            .db
            .execute(
                "INSERT INTO task_links(session_id,kind,number,url,title,state,checked_at) VALUES(?1,'pull',42,'https://github.com/o/r/pull/42','Existing PR','open',1700000000)",
                [&task.id],
            )
            .unwrap();
        (first.id, second.id, first_dir, second_dir, task.id)
    };
    {
        let store = Store::open(&path).unwrap();
        let version: i64 = store
            .db
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, 37, "opening a version 36 database migrates it");
        for (project_id, dir) in [(&first_id, &first_dir), (&second_id, &second_dir)] {
            let (seeded_path, position, is_primary): (String, i64, i64) = store
                .db
                .query_row(
                    "SELECT path,position,is_primary FROM project_folders WHERE project_id=?1",
                    [project_id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .unwrap();
            assert_eq!(
                seeded_path,
                canonical(dir),
                "each project is seeded with its own path"
            );
            assert_eq!(
                (position, is_primary),
                (0, 1),
                "the seeded folder is the primary at position 0"
            );
        }
        let seeded: i64 = store
            .db
            .query_row("SELECT COUNT(*) FROM project_folders", [], |row| row.get(0))
            .unwrap();
        assert_eq!(seeded, 2, "exactly one row per project");
        let repos: i64 = store
            .db
            .query_row("SELECT COUNT(*) FROM session_repos", [], |row| row.get(0))
            .unwrap();
        assert_eq!(repos, 0);

        // The rebuilt task_links keeps every legacy value under the empty repo key.
        let (repo, number, url, title, state, checked_at): (
            String,
            i64,
            String,
            String,
            String,
            i64,
        ) = store
            .db
            .query_row(
                "SELECT repo,number,url,title,state,checked_at FROM task_links WHERE session_id=?1 AND kind='pull'",
                [&sid],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(
            (repo.as_str(), number, state.as_str(), checked_at),
            ("", 42, "open", 1700000000)
        );
        assert_eq!(url, "https://github.com/o/r/pull/42");
        assert_eq!(title, "Existing PR");
        // Today's single-link reader still sees it.
        let pull = store
            .session(&sid)
            .unwrap()
            .pull_request
            .expect("legacy pull link survives the rebuild");
        assert_eq!((pull.number, pull.state.as_str()), (42, "open"));
        // The rebuilt key accepts per-repo rows.
        store
            .db
            .execute(
                "INSERT INTO task_links(session_id,kind,repo,number,url,title,state,checked_at) VALUES(?1,'pull','/other',43,'https://github.com/o/r/pull/43','Other','open',0)",
                [&sid],
            )
            .unwrap();
    }
    {
        // Opening the migrated database again changes nothing.
        let store = Store::open(&path).unwrap();
        let folders: i64 = store
            .db
            .query_row("SELECT COUNT(*) FROM project_folders", [], |row| row.get(0))
            .unwrap();
        assert_eq!(folders, 2);
        let links: i64 = store
            .db
            .query_row("SELECT COUNT(*) FROM task_links", [], |row| row.get(0))
            .unwrap();
        assert_eq!(links, 2);
    }
    std::fs::remove_dir_all(&root).unwrap();
}

/// A newly added project lists exactly its own folder as the primary.
#[test]
fn a_new_project_starts_with_one_primary_folder() {
    let store = Store::open(Path::new(":memory:")).unwrap();
    let root = scratch("new-project");
    let project = store.add_project(&root).unwrap();
    let folders = store.project_folders(&project.id).unwrap();
    assert_eq!(paths_of(&folders), vec![canonical(&root)]);
    assert_eq!(folders[0].position, 0);
    assert!(folders[0].is_primary);
    assert_single_primary(&store, &project.id);
    std::fs::remove_dir_all(&root).unwrap();
}

/// Folders append by position, the primary never moves, a folder joins at most one
/// project, and invalid paths are refused the way add_project refuses them.
#[test]
fn add_project_folder_appends_by_position_and_refuses_taken_paths() {
    let store = Store::open(Path::new(":memory:")).unwrap();
    let root = scratch("add");
    let project = store.add_project(&root).unwrap();
    let primary =
        PathBuf::from(store.project_folders(&project.id).unwrap()[0].path.clone());
    let extra = folder_dir(&root, "extra");
    let third = folder_dir(&root, "third");

    let added = store.add_project_folder(&project.id, &extra).unwrap();
    assert_eq!((added.position, added.is_primary), (1, false));
    store.add_project_folder(&project.id, &third).unwrap();
    assert_eq!(
        paths_of(&store.project_folders(&project.id).unwrap()),
        vec![canonical(&primary), canonical(&extra), canonical(&third)]
    );
    assert_eq!(
        store.project(&project.id).unwrap().path,
        canonical(&primary),
        "adding folders never moves the primary"
    );

    // The same folder cannot join twice...
    assert!(store.add_project_folder(&project.id, &extra).is_err());
    assert!(store
        .add_project_folder(&project.id, &primary)
        .is_err(), "the project's own primary path is already a folder");
    // ...and no folder of another project can join, primary or additional.
    let other_dir = folder_dir(&root, "other");
    let other = store.add_project(&other_dir).unwrap();
    let owned = folder_dir(&root, "owned");
    store.add_project_folder(&project.id, &owned).unwrap();
    assert!(store
        .add_project_folder(&project.id, &other_dir)
        .is_err(), "another project's primary cannot join");
    assert!(store
        .add_project_folder(&other.id, &primary)
        .is_err(), "this project's primary cannot join elsewhere");
    assert!(store
        .add_project_folder(&other.id, &owned)
        .is_err(), "an additional folder of this project cannot join elsewhere");
    // Missing paths and files are refused like add_project.
    assert!(store
        .add_project_folder(&project.id, &root.join("missing"))
        .is_err());
    let file = root.join("file.txt");
    std::fs::write(&file, "x").unwrap();
    assert!(store.add_project_folder(&project.id, &file).is_err());
    assert_eq!(
        store.project_folders(&project.id).unwrap().len(),
        4,
        "refusals append nothing"
    );
    assert_single_primary(&store, &project.id);
    std::fs::remove_dir_all(&root).unwrap();
}

/// Folder paths are canonicalized before they are stored, like add_project does.
#[cfg(unix)]
#[test]
fn add_project_folder_stores_the_canonical_path() {
    use std::os::unix::fs::symlink;
    let store = Store::open(Path::new(":memory:")).unwrap();
    let root = scratch("canonical");
    let project = store.add_project(&root).unwrap();
    let real = folder_dir(&root, "real");
    let alias = root.join("alias");
    symlink(&real, &alias).unwrap();
    let added = store.add_project_folder(&project.id, &alias).unwrap();
    assert_eq!(added.path, canonical(&real), "the symlink spelling canonicalizes");
    assert!(store
        .add_project_folder(&project.id, &real)
        .is_err(), "the real spelling is the same folder");
    assert_eq!(store.project_folders(&project.id).unwrap().len(), 2);
    std::fs::remove_dir_all(&root).unwrap();
}

/// The last folder is never removed, removing an additional folder leaves the
/// primary alone, and removing the primary promotes the next folder by position.
#[test]
fn remove_project_folder_refuses_the_last_folder_and_promotes_the_next_primary() {
    let store = Store::open(Path::new(":memory:")).unwrap();
    let root = scratch("remove");
    let project = store.add_project(&root).unwrap();
    let primary = store.project_folders(&project.id).unwrap()[0].path.clone();
    let extra = folder_dir(&root, "extra");
    let third = folder_dir(&root, "third");
    store.add_project_folder(&project.id, &extra).unwrap();
    store.add_project_folder(&project.id, &third).unwrap();

    // A project always keeps its one folder.
    let solo_dir = folder_dir(&root, "solo");
    let solo = store.add_project(&solo_dir).unwrap();
    assert!(store
        .remove_project_folder(&solo.id, &solo_dir)
        .is_err(), "the last folder is never removed");
    assert_eq!(store.project_folders(&solo.id).unwrap().len(), 1);
    assert_eq!(store.project(&solo.id).unwrap().path, canonical(&solo_dir));

    // Removing an additional folder leaves the primary alone.
    store.remove_project_folder(&project.id, &extra).unwrap();
    assert_eq!(
        paths_of(&store.project_folders(&project.id).unwrap()),
        vec![primary.clone(), canonical(&third)]
    );
    assert_eq!(store.project(&project.id).unwrap().path, primary.clone());
    assert_single_primary(&store, &project.id);

    // Removing the primary promotes the next folder by position and rewrites
    // projects.path to it.
    store
        .remove_project_folder(&project.id, Path::new(&primary))
        .unwrap();
    assert_eq!(
        paths_of(&store.project_folders(&project.id).unwrap()),
        vec![canonical(&third)]
    );
    assert!(store.project_folders(&project.id).unwrap()[0].is_primary);
    assert_eq!(store.project(&project.id).unwrap().path, canonical(&third));
    assert_single_primary(&store, &project.id);
    std::fs::remove_dir_all(&root).unwrap();
}

/// The primary-flag move and the projects.path rewrite land in one transaction.
#[test]
fn removing_the_primary_folder_rewrites_flag_and_path_atomically() {
    let store = Store::open(Path::new(":memory:")).unwrap();
    let root = scratch("atomic");
    let project = store.add_project(&root).unwrap();
    let primary = store.project_folders(&project.id).unwrap()[0].path.clone();
    let extra = folder_dir(&root, "extra");
    store.add_project_folder(&project.id, &extra).unwrap();
    let before = store.project_folders(&project.id).unwrap();

    store.db.execute_batch("CREATE TRIGGER fail_project_path BEFORE UPDATE OF path ON projects WHEN NEW.path<>OLD.path BEGIN SELECT RAISE(ABORT,'injected path write failure'); END;").unwrap();
    assert!(store
        .remove_project_folder(&project.id, Path::new(&primary))
        .unwrap_err()
        .contains("injected"));
    assert_eq!(
        paths_of(&store.project_folders(&project.id).unwrap()),
        paths_of(&before),
        "a failed promotion changes nothing"
    );
    assert_eq!(store.project(&project.id).unwrap().path, primary);
    assert_single_primary(&store, &project.id);

    store
        .db
        .execute_batch("DROP TRIGGER fail_project_path;")
        .unwrap();
    store
        .remove_project_folder(&project.id, Path::new(&primary))
        .unwrap();
    assert_eq!(store.project(&project.id).unwrap().path, canonical(&extra));
    assert_single_primary(&store, &project.id);
    std::fs::remove_dir_all(&root).unwrap();
}

/// set_primary_folder moves the one flag and the project path together.
#[test]
fn set_primary_folder_moves_the_flag_and_the_project_path_together() {
    let store = Store::open(Path::new(":memory:")).unwrap();
    let root = scratch("primary");
    let project = store.add_project(&root).unwrap();
    let primary = store.project_folders(&project.id).unwrap()[0].path.clone();
    let extra = folder_dir(&root, "extra");
    let third = folder_dir(&root, "third");
    store.add_project_folder(&project.id, &extra).unwrap();
    store.add_project_folder(&project.id, &third).unwrap();

    store.set_primary_folder(&project.id, &third).unwrap();
    let folders = store.project_folders(&project.id).unwrap();
    assert_eq!(
        paths_of(&folders),
        vec![primary, canonical(&extra), canonical(&third)],
        "positions do not move"
    );
    assert_eq!(
        folders.iter().map(|f| f.is_primary).collect::<Vec<_>>(),
        vec![false, false, true]
    );
    assert_eq!(store.project(&project.id).unwrap().path, canonical(&third));
    assert_single_primary(&store, &project.id);

    // Only this project's own folders can become primary.
    let other_dir = folder_dir(&root, "other");
    store.add_project(&other_dir).unwrap();
    assert!(store
        .set_primary_folder(&project.id, &other_dir)
        .is_err(), "another project's folder cannot become primary");
    assert_eq!(store.project(&project.id).unwrap().path, canonical(&third));
    assert_single_primary(&store, &project.id);
    std::fs::remove_dir_all(&root).unwrap();
}

/// workspace_folders resolves the primary (worktree-aware), applies per-task
/// overrides for additional folders, keeps repos of removed folders alive for the
/// task that recorded them, and labels every entry from its folder path.
#[test]
fn workspace_folders_resolve_worktrees_overrides_and_orphans() {
    let store = Store::open(Path::new(":memory:")).unwrap();
    let root = scratch("workspace");
    let app = folder_dir(&root, "alpha/app");
    let web = folder_dir(&root, "beta/app");
    let site = folder_dir(&root, "gamma/site");
    let project = store.add_project(&app).unwrap();
    store.add_project_folder(&project.id, &web).unwrap();
    store.add_project_folder(&project.id, &site).unwrap();

    let plain = store
        .create_session(&project.id, "claude", "sonnet", "full")
        .unwrap();
    assert_eq!(
        store.workspace_folders(&project.id, &plain.id).unwrap(),
        vec![
            RepoFolder {
                path: app.canonicalize().unwrap(),
                label: "alpha/app".into(),
                is_primary: true,
                worktree: None,
                branch: None,
            },
            RepoFolder {
                path: web.canonicalize().unwrap(),
                label: "beta/app".into(),
                is_primary: false,
                worktree: None,
                branch: None,
            },
            RepoFolder {
                path: site.canonicalize().unwrap(),
                label: "site".into(),
                is_primary: false,
                worktree: None,
                branch: None,
            },
        ],
        "the primary comes first, shared basenames are parent-disambiguated"
    );

    // A worktree task runs in its checkout but keeps its project folder's label.
    let checkout = folder_dir(&root, "worktrees/task-1");
    let task = store
        .create_session(&project.id, "claude", "sonnet", "full")
        .unwrap();
    store
        .attach_worktree(&task.id, &checkout, "task-branch")
        .unwrap();
    assert_eq!(
        store.workspace_folders(&project.id, &task.id).unwrap()[0],
        RepoFolder {
            path: checkout.canonicalize().unwrap(),
            label: "alpha/app".into(),
            is_primary: true,
            worktree: Some(checkout.canonicalize().unwrap()),
            branch: Some("task-branch".into()),
        }
    );

    // session_repos overrides additional folders for one task only.
    let override_dir = folder_dir(&root, "worktrees/task-2");
    store
        .set_session_repo(&plain.id, &web, Some(override_dir.as_path()), Some("feat/two"))
        .unwrap();
    assert_eq!(
        store.workspace_folders(&project.id, &plain.id).unwrap()[1],
        RepoFolder {
            path: override_dir.canonicalize().unwrap(),
            label: "beta/app".into(),
            is_primary: false,
            worktree: Some(override_dir.canonicalize().unwrap()),
            branch: Some("feat/two".into()),
        }
    );
    assert_eq!(
        store.workspace_folders(&project.id, &task.id).unwrap()[1].path,
        web.canonicalize().unwrap(),
        "other tasks keep the plain folder"
    );

    // A folder removed from the project stays alive for a task that recorded a
    // repo in it, labeled from the folder path.
    let orphan_checkout = folder_dir(&root, "worktrees/task-3");
    store
        .set_session_repo(&plain.id, &site, Some(orphan_checkout.as_path()), Some("feat/three"))
        .unwrap();
    store.remove_project_folder(&project.id, &site).unwrap();
    let folders = store.workspace_folders(&project.id, &plain.id).unwrap();
    assert_eq!(folders.len(), 3);
    assert_eq!(
        folders[2],
        RepoFolder {
            path: orphan_checkout.canonicalize().unwrap(),
            label: "site".into(),
            is_primary: false,
            worktree: Some(orphan_checkout.canonicalize().unwrap()),
            branch: Some("feat/three".into()),
        },
        "a running task keeps its repos"
    );
    assert_eq!(
        store.workspace_folders(&project.id, &task.id).unwrap().len(),
        2,
        "tasks without that repo lose the removed folder"
    );
    std::fs::remove_dir_all(&root).unwrap();
}

/// set_session_repo upserts by (session, folder): later calls replace, NULLs clear
/// the override, and other tasks are untouched.
#[test]
fn set_session_repo_upserts_by_session_and_folder() {
    let store = Store::open(Path::new(":memory:")).unwrap();
    let root = scratch("repos");
    let project = store.add_project(&root).unwrap();
    let extra = folder_dir(&root, "extra");
    store.add_project_folder(&project.id, &extra).unwrap();
    let task = store
        .create_session(&project.id, "claude", "sonnet", "full")
        .unwrap();
    let first = folder_dir(&root, "wt-1");
    let second = folder_dir(&root, "wt-2");

    store
        .set_session_repo(&task.id, &extra, Some(first.as_path()), Some("feat/one"))
        .unwrap();
    store
        .set_session_repo(&task.id, &extra, Some(second.as_path()), Some("feat/two"))
        .unwrap();
    let rows: i64 = store
        .db
        .query_row(
            "SELECT COUNT(*) FROM session_repos WHERE session_id=?1",
            [&task.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(rows, 1, "the same folder upserts, never appends");
    let folders = store.workspace_folders(&project.id, &task.id).unwrap();
    assert_eq!(folders[1].path, second.canonicalize().unwrap());
    assert_eq!(folders[1].branch.as_deref(), Some("feat/two"));

    // Clearing the override falls back to the folder itself.
    store
        .set_session_repo(&task.id, &extra, None, None)
        .unwrap();
    assert_eq!(
        store.workspace_folders(&project.id, &task.id).unwrap()[1],
        RepoFolder {
            path: extra.canonicalize().unwrap(),
            label: "extra".into(),
            is_primary: false,
            worktree: None,
            branch: None,
        }
    );

    // Another task's overrides never leak.
    let other = store
        .create_session(&project.id, "claude", "sonnet", "full")
        .unwrap();
    store
        .set_session_repo(&other.id, &extra, Some(first.as_path()), Some("feat/x"))
        .unwrap();
    assert_eq!(
        store.workspace_folders(&project.id, &task.id).unwrap()[1].path,
        extra.canonicalize().unwrap()
    );
    assert_eq!(
        store.workspace_folders(&project.id, &other.id).unwrap()[1].path,
        first.canonicalize().unwrap()
    );
    std::fs::remove_dir_all(&root).unwrap();
}

/// The label helper: basenames, parent-disambiguated only on collision.
#[test]
fn folder_labels_use_basenames_and_disambiguate_collisions() {
    assert_eq!(folder_labels(&[]), Vec::<String>::new());
    assert_eq!(
        folder_labels(&[
            PathBuf::from("/srv/repos/app"),
            PathBuf::from("/srv/work/app"),
            PathBuf::from("/srv/sites/landing"),
        ]),
        vec![
            "repos/app".to_string(),
            "work/app".to_string(),
            "landing".to_string()
        ]
    );
    assert_eq!(
        folder_labels(&[
            PathBuf::from("/a/app"),
            PathBuf::from("/b/app"),
            PathBuf::from("/a/docs"),
        ]),
        vec!["a/app".to_string(), "b/app".to_string(), "docs".to_string()],
        "only colliding basenames grow"
    );
}

/// The link upsert keys on (session, kind, repo): '' stays the primary link and
/// each named repo holds its own, while session reads keep serving the primary one.
#[test]
fn set_task_link_keys_the_upsert_on_session_kind_and_repo() {
    let store = Store::open(Path::new(":memory:")).unwrap();
    let root = scratch("links");
    let project = store.add_project(&root).unwrap();
    let task = store
        .create_session(&project.id, "claude", "sonnet", "full")
        .unwrap();

    store
        .set_task_link(&task.id, "pull", "", Some(&pull_link(1, "Primary repo")))
        .unwrap();
    store
        .set_task_link(&task.id, "pull", "/repos/other", Some(&pull_link(2, "Other repo")))
        .unwrap();
    let pulls: i64 = store
        .db
        .query_row(
            "SELECT COUNT(*) FROM task_links WHERE session_id=?1 AND kind='pull'",
            [&task.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(pulls, 2, "two repos each hold a pull link");
    assert_eq!(
        store
            .session(&task.id)
            .unwrap()
            .pull_request
            .expect("the primary link is readable")
            .number,
        1,
        "the single-link read stays on the empty repo key"
    );

    // Re-upserting one repo replaces only that repo's row.
    store
        .set_task_link(&task.id, "pull", "/repos/other", Some(&pull_link(3, "Updated")))
        .unwrap();
    let (other_number, primary_number): (i64, i64) = store
        .db
        .query_row(
            "SELECT (SELECT number FROM task_links WHERE session_id=?1 AND kind='pull' AND repo='/repos/other'),
                    (SELECT number FROM task_links WHERE session_id=?1 AND kind='pull' AND repo='')",
            [&task.id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!((other_number, primary_number), (3, 1));

    // Removing one repo's link leaves the other intact.
    store.set_task_link(&task.id, "pull", "", None).unwrap();
    let pulls: i64 = store
        .db
        .query_row(
            "SELECT COUNT(*) FROM task_links WHERE session_id=?1 AND kind='pull'",
            [&task.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(pulls, 1);
    let kept: String = store
        .db
        .query_row(
            "SELECT repo FROM task_links WHERE session_id=?1 AND kind='pull'",
            [&task.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(kept, "/repos/other");
    assert!(store.session(&task.id).unwrap().pull_request.is_none());
    std::fs::remove_dir_all(&root).unwrap();
}
