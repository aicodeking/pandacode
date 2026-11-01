use super::*;

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

fn canonical(path: &Path) -> String {
    path.canonicalize().unwrap().to_string_lossy().to_string()
}

/// A scratch directory of distinct real folders; the store keeps their canonical paths.
fn scratch(tag: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("pandacode-identity-{tag}-{}", id()));
    std::fs::create_dir_all(&root).unwrap();
    root
}

fn folder_dir(root: &Path, name: &str) -> PathBuf {
    let path = root.join(name);
    std::fs::create_dir_all(&path).unwrap();
    path
}

/// A pinned worktree task keeps labeling its primary with the folder that was
/// primary when it was created, even after the project's primary moved, and the
/// pinned folder is never listed twice. Tasks without a pin row (legacy) keep
/// following the project's current primary.
#[test]
fn a_worktree_task_keeps_the_primary_it_was_created_with() {
    let store = Store::open(Path::new(":memory:")).unwrap();
    let root = scratch("pin");
    let app = folder_dir(&root, "alpha/app");
    let web = folder_dir(&root, "beta/app");
    let project = store.add_project(&app).unwrap();
    store.add_project_folder(&project.id, &web).unwrap();
    let checkout = folder_dir(&root, "worktrees/task-1");

    let source = store
        .create_session(&project.id, "claude", "sonnet", "full")
        .unwrap();
    let task = store
        .create_worktree_session_on(&source, &checkout, Some("feat/one"))
        .unwrap();
    store
        .set_session_repo(&task.id, &app, Some(checkout.as_path()), Some("feat/one"))
        .unwrap();

    store.set_primary_folder(&project.id, &web).unwrap();
    let folders = store.workspace_folders(&project.id, &task.id).unwrap();
    assert_eq!(folders.len(), 2, "the pinned folder is not listed twice");
    assert_eq!(
        folders[0],
        RepoFolder {
            path: checkout.canonicalize().unwrap(),
            label: "alpha/app".into(),
            is_primary: true,
            worktree: Some(checkout.canonicalize().unwrap()),
            branch: Some("feat/one".into()),
        },
        "the primary entry keeps its creation-time folder and label"
    );
    assert_eq!(
        folders[1],
        RepoFolder {
            path: web.canonicalize().unwrap(),
            label: "beta/app".into(),
            is_primary: false,
            worktree: None,
            branch: None,
        }
    );

    // Attaching pins the primary as it is at attach time, so a later primary
    // change cannot relabel the attached task either.
    let attached_checkout = folder_dir(&root, "worktrees/attached");
    let attached = store
        .create_session(&project.id, "claude", "sonnet", "full")
        .unwrap();
    store
        .attach_worktree(&attached.id, &attached_checkout, "attached-branch")
        .unwrap();
    let folders = store.workspace_folders(&project.id, &attached.id).unwrap();
    assert_eq!(folders[0].label, "beta/app", "attach pins the primary as it is");
    assert_eq!(folders.len(), 2);
    store.set_primary_folder(&project.id, &app).unwrap();
    assert_eq!(
        store.workspace_folders(&project.id, &attached.id).unwrap()[0].label,
        "beta/app",
        "a later primary change cannot relabel an attached task"
    );
    std::fs::remove_dir_all(&root).unwrap();
}

/// The label helper grows parent levels only while spellings still collide:
/// parents sharing a basename settle at two levels, and only a second shared
/// parent level needs three.
#[test]
fn folder_labels_grow_levels_until_shared_parents_are_disambiguated() {
    assert_eq!(
        folder_labels(&[PathBuf::from("/w/a/app"), PathBuf::from("/v/a/app")]),
        vec!["w/a/app".to_string(), "v/a/app".to_string()],
        "parents sharing a basename settle at two levels"
    );
    assert_eq!(
        folder_labels(&[
            PathBuf::from("/r/w/a/app"),
            PathBuf::from("/v/w/a/app"),
            PathBuf::from("/r/v/b/app"),
        ]),
        vec![
            "r/w/a/app".to_string(),
            "v/w/a/app".to_string(),
            "b/app".to_string(),
        ],
        "two shared parent levels settle at three; the distinct folder stays short"
    );
}

/// Moving the primary (directly, or by removing it) is refused while any task
/// of the project holds a pull or issue link under the legacy '' repo key;
/// other folders stay removable, and settling the links unblocks the change.
#[test]
fn the_primary_never_moves_while_tasks_hold_primary_links() {
    let store = Store::open(Path::new(":memory:")).unwrap();
    let root = scratch("guard");
    let app = folder_dir(&root, "app");
    let extra = folder_dir(&root, "extra");
    let project = store.add_project(&app).unwrap();
    store.add_project_folder(&project.id, &extra).unwrap();
    let task = store
        .create_session(&project.id, "claude", "sonnet", "full")
        .unwrap();
    store
        .set_task_link(&task.id, "pull", "", Some(&pull_link(7, "Primary PR")))
        .unwrap();

    let refusal = "This project has tasks with linked GitHub items. Settle them before changing the primary folder.";
    assert_eq!(
        store.set_primary_folder(&project.id, &extra).unwrap_err(),
        refusal
    );
    assert_eq!(
        store.remove_project_folder(&project.id, &app).unwrap_err(),
        refusal,
        "removing the primary would promote another folder"
    );
    // An issue link under the primary key refuses too.
    store.set_task_link(&task.id, "pull", "", None).unwrap();
    store
        .set_task_link(&task.id, "issue", "", Some(&TaskLink {
            kind: "issue".into(),
            number: 3,
            url: "https://github.com/o/r/issues/3".into(),
            title: "Bug".into(),
            state: "open".into(),
            checked_at: 0,
        }))
        .unwrap();
    assert_eq!(
        store.set_primary_folder(&project.id, &extra).unwrap_err(),
        refusal
    );
    // A non-primary folder is still removable.
    store.remove_project_folder(&project.id, &extra).unwrap();
    store.add_project_folder(&project.id, &extra).unwrap();
    // Settling the link unblocks the move.
    store.set_task_link(&task.id, "issue", "", None).unwrap();
    store.set_primary_folder(&project.id, &extra).unwrap();
    assert_eq!(store.project(&project.id).unwrap().path, canonical(&extra));
    std::fs::remove_dir_all(&root).unwrap();
}

/// A refreshed state only rewrites the rows of its own repository key: two
/// repositories sharing a pull number never cross-update each other.
#[test]
fn link_state_updates_stay_within_their_repository() {
    let store = Store::open(Path::new(":memory:")).unwrap();
    let project = store.add_project(&std::env::temp_dir()).unwrap();
    let primary = store
        .create_session(&project.id, "claude", "sonnet", "full")
        .unwrap();
    let other = store
        .create_session(&project.id, "claude", "sonnet", "full")
        .unwrap();
    store
        .set_task_link(&primary.id, "pull", "", Some(&pull_link(7, "Primary PR")))
        .unwrap();
    store
        .set_task_link(&other.id, "pull", "o/other", Some(&pull_link(7, "Other PR")))
        .unwrap();

    store
        .update_link_states(
            &project.id,
            &[("o/other".into(), "pull".into(), 7, "merged".into(), "Renamed".into())],
        )
        .unwrap();
    let links = |store: &Store, sid: &str| {
        store
            .session_pull_links(sid)
            .unwrap()
            .into_iter()
            .map(|(repo, link)| (repo, link.state, link.title))
            .collect::<Vec<_>>()
    };
    assert_eq!(
        links(&store, &primary.id),
        vec![("".to_string(), "open".to_string(), "Primary PR".to_string())],
        "the primary's same-numbered pull is untouched"
    );
    assert_eq!(
        links(&store, &other.id),
        vec![("o/other".to_string(), "merged".to_string(), "Renamed".to_string())]
    );
}
