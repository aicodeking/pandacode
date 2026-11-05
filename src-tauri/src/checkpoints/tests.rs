use super::*;
use std::sync::{
    atomic::{AtomicBool, AtomicU8},
    Arc,
};

fn repo() -> Scratch {
    let dir = Scratch::new().unwrap();
    git(&dir.0, None, &["init", "-q"], None, 8192).unwrap();
    fs::write(dir.0.join("file.txt"), "original\n").unwrap();
    git(&dir.0, None, &["add", "."], None, 8192).unwrap();
    git(&dir.0, None, &["commit", "-qm", "Initial"], None, 8192).unwrap();
    dir
}
fn fixture(root: &Path) -> (AppState, Session, i64) {
    let store = Store::open(Path::new(":memory:")).unwrap();
    let project = store.add_project(root).unwrap();
    let task = store
        .create_session(&project.id, "codex", "default", "full")
        .unwrap();
    store.message(&task.id, "user", "Earlier request").unwrap();
    store
        .message(&task.id, "assistant", "Earlier answer")
        .unwrap();
    store.message(&task.id, "user", "Change the file").unwrap();
    let message = store.db.last_insert_rowid();
    (
        AppState {
            store: Arc::new(Mutex::new(store)),
            agents: Arc::new(Mutex::new(HashMap::new())),
            terminals: Arc::new(Mutex::new(HashMap::new())),
            shutdown: AtomicU8::new(0),
        },
        task,
        message,
    )
}
fn review(root: &Path, session: &str, message: i64) -> String {
    let root = checkout(root).unwrap();
    let target = load(&root, &reference(session, message).unwrap()).unwrap();
    let before = snapshot(&root).unwrap();
    let (patch, _, _) = patch(&root, &before, &target).unwrap();
    let token = storage::id();
    reviews().lock().unwrap().insert(
        token.clone(),
        Review {
            session: session.into(),
            message,
            head: head(&root).unwrap(),
            root,
            before,
            target,
            patch,
            at: Instant::now(),
        },
    );
    token
}

#[test]
fn captures_dirty_and_untracked_bytes_without_changing_head_index_or_stash() {
    let dir = repo();
    fs::write(dir.0.join("file.txt"), "staged\n").unwrap();
    git(&dir.0, None, &["add", "file.txt"], None, 8192).unwrap();
    fs::write(dir.0.join("file.txt"), "unstaged\n").unwrap();
    fs::write(dir.0.join("new name\n.txt"), "untracked\n").unwrap();
    fs::write(dir.0.join(".gitignore"), "secret\n").unwrap();
    fs::write(dir.0.join("secret"), "private\n").unwrap();
    let index = fs::read(dir.0.join(".git/index")).unwrap();
    let original_head = head(&dir.0).unwrap();
    capture(&dir.0, "test-session", 4).unwrap();
    let saved = load(
        &checkout(&dir.0).unwrap(),
        &reference("test-session", 4).unwrap(),
    )
    .unwrap();
    let files = entries(&dir.0, &saved.tree).unwrap();
    assert_eq!(
        git(
            &dir.0,
            None,
            &["cat-file", "blob", &files["file.txt"].hash],
            None,
            8192
        )
        .unwrap(),
        b"unstaged\n"
    );
    assert!(files.contains_key("new name\n.txt"));
    assert!(!files.contains_key("secret"));
    assert!(saved.skipped.contains("secret"));
    assert_eq!(fs::read(dir.0.join(".git/index")).unwrap(), index);
    assert_eq!(head(&dir.0).unwrap(), original_head);
    assert!(git(
        &dir.0,
        None,
        &["show-ref", "--verify", "refs/stash"],
        None,
        8192
    )
    .is_err());
}

#[test]
fn rewind_restores_added_deleted_binary_and_untracked_files_and_forks_before_prompt() {
    let dir = repo();
    let (state, task, message) = fixture(&dir.0);
    fs::write(dir.0.join("binary"), [0, 255, 128, 7]).unwrap();
    fs::write(dir.0.join("raw-text"), [255, 128, 65, 10]).unwrap();
    fs::write(dir.0.join("untracked"), "before\n").unwrap();
    capture(&dir.0, &task.id, message).unwrap();
    fs::remove_file(dir.0.join("file.txt")).unwrap();
    fs::write(dir.0.join("binary"), [0, 1]).unwrap();
    fs::write(dir.0.join("raw-text"), [254, 127, 66, 10]).unwrap();
    fs::write(dir.0.join("untracked"), "after\n").unwrap();
    fs::write(dir.0.join("added"), "new\n").unwrap();
    let index = fs::read(dir.0.join(".git/index")).unwrap();
    let original_head = head(&dir.0).unwrap();
    let token = review(&dir.0, &task.id, message);
    let fork = restore(&state, &task.id, message, &token).unwrap();
    assert_eq!(fs::read(dir.0.join("file.txt")).unwrap(), b"original\n");
    assert_eq!(fs::read(dir.0.join("binary")).unwrap(), [0, 255, 128, 7]);
    assert_eq!(
        fs::read(dir.0.join("raw-text")).unwrap(),
        [255, 128, 65, 10]
    );
    assert_eq!(fs::read(dir.0.join("untracked")).unwrap(), b"before\n");
    assert!(!dir.0.join("added").exists());
    assert_eq!(fs::read(dir.0.join(".git/index")).unwrap(), index);
    assert_eq!(head(&dir.0).unwrap(), original_head);
    let store = state.store.lock().unwrap();
    let count: i64 = store
        .db
        .query_row(
            "SELECT COUNT(*) FROM messages WHERE session_id=?1",
            [&fork.id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 2);
    assert!(fork.resume_id.is_none());
    assert!(crate::context_recovery::pending(&store, &fork).unwrap());
    assert_eq!(
        store.message_content(&task.id, message).unwrap(),
        "Change the file"
    );
}

#[test]
fn skipped_large_files_and_newly_ignored_files_are_never_deleted_or_restored() {
    let dir = repo();
    let (state, task, message) = fixture(&dir.0);
    fs::write(dir.0.join("large"), vec![0; FILE_BYTES + 1]).unwrap();
    fs::write(dir.0.join("keep"), "before").unwrap();
    capture(&dir.0, &task.id, message).unwrap();
    fs::write(dir.0.join("large"), "small now").unwrap();
    fs::write(dir.0.join(".gitignore"), "keep\nignored-dir/\n").unwrap();
    fs::write(dir.0.join("keep"), "private now").unwrap();
    fs::create_dir(dir.0.join("ignored-dir")).unwrap();
    fs::write(dir.0.join("ignored-dir/private"), "untouched").unwrap();
    fs::write(dir.0.join("file.txt"), "changed\n").unwrap();
    let token = review(&dir.0, &task.id, message);
    restore(&state, &task.id, message, &token).unwrap();
    assert_eq!(fs::read(dir.0.join("large")).unwrap(), b"small now");
    assert_eq!(fs::read(dir.0.join("keep")).unwrap(), b"private now");
    assert_eq!(
        fs::read(dir.0.join("ignored-dir/private")).unwrap(),
        b"untouched"
    );
}

#[test]
fn stale_preview_and_running_sibling_refuse_without_mutation_or_fork() {
    let dir = repo();
    let (state, task, message) = fixture(&dir.0);
    capture(&dir.0, &task.id, message).unwrap();
    fs::write(dir.0.join("file.txt"), "agent edit\n").unwrap();
    let token = review(&dir.0, &task.id, message);
    fs::write(dir.0.join("file.txt"), "later manual edit\n").unwrap();
    assert!(restore(&state, &task.id, message, &token)
        .unwrap_err()
        .contains("changed after the preview"));
    let sibling = state
        .store
        .lock()
        .unwrap()
        .create_session(&task.project_id, "claude", "default", "full")
        .unwrap();
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    state.agents.lock().unwrap().insert(
        sibling.id,
        crate::RunningAgent::new(tx, Arc::new(AtomicBool::new(false))),
    );
    let token = review(&dir.0, &task.id, message);
    assert!(restore(&state, &task.id, message, &token)
        .unwrap_err()
        .contains("Stop all agents"));
    assert_eq!(
        fs::read(dir.0.join("file.txt")).unwrap(),
        b"later manual edit\n"
    );
    let count: i64 = state
        .store
        .lock()
        .unwrap()
        .db
        .query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 2);
}

#[test]
fn worktrees_have_separate_identity_and_checkpoint_capture_does_not_touch_indexes() {
    let dir = repo();
    let work = Scratch::new().unwrap();
    let path = work.0.join("checkout");
    git(
        &dir.0,
        None,
        &["worktree", "add", "--detach", path.to_str().unwrap()],
        None,
        8192,
    )
    .unwrap();
    capture(&path, "worktree-session", 9).unwrap();
    assert!(load(
        &checkout(&dir.0).unwrap(),
        &reference("worktree-session", 9).unwrap()
    )
    .unwrap_err()
    .contains("different checkout"));
    assert!(load(
        &checkout(&path).unwrap(),
        &reference("worktree-session", 9).unwrap()
    )
    .is_ok());
}

#[test]
fn waiting_team_in_the_same_checkout_blocks_rewind_between_worker_runs() {
    let dir = repo();
    let (state, task, message) = fixture(&dir.0);
    capture(&dir.0, &task.id, message).unwrap();
    fs::write(dir.0.join("file.txt"), "team edits\n").unwrap();
    let sibling = state
        .store
        .lock()
        .unwrap()
        .create_session(&task.project_id, "claude", "default", "full")
        .unwrap();
    state
        .store
        .lock()
        .unwrap()
        .db
        .execute(
            "INSERT INTO architect_teams(session_id,content) VALUES(?1,?2)",
            rusqlite::params![sibling.id, r#"{"status":"waiting"}"#],
        )
        .unwrap();
    let token = review(&dir.0, &task.id, message);
    assert!(restore(&state, &task.id, message, &token)
        .unwrap_err()
        .contains("Stop all agents"));
    assert_eq!(fs::read(dir.0.join("file.txt")).unwrap(), b"team edits\n");
}

#[test]
fn comparison_is_directional_and_leaves_working_files_unchanged() {
    let dir = repo();
    let root = checkout(&dir.0).unwrap();
    let before = snapshot(&root).unwrap();
    fs::write(root.join("file.txt"), "replacement\n").unwrap();
    let after = snapshot(&root).unwrap();
    let (forward, paths, _) = patch(&root, &before, &after).unwrap();
    let (backward, _, _) = patch(&root, &after, &before).unwrap();
    assert!(String::from_utf8(forward).unwrap().contains("+replacement"));
    assert!(String::from_utf8(backward).unwrap().contains("+original"));
    assert_eq!(paths, ["file.txt"]);
    assert_eq!(fs::read(root.join("file.txt")).unwrap(), b"replacement\n");
}

#[test]
fn unborn_repositories_and_immutable_refs_work() {
    let dir = Scratch::new().unwrap();
    git(&dir.0, None, &["init", "-q"], None, 8192).unwrap();
    fs::write(dir.0.join("new"), "first").unwrap();
    capture(&dir.0, "first-session", 1).unwrap();
    assert!(!dir.0.join(".git/index").exists());
    fs::write(dir.0.join("new"), "second").unwrap();
    assert!(capture(&dir.0, "first-session", 1).is_err());
    assert!(head(&dir.0).is_ok());
}

#[test]
fn retention_deletes_only_old_checkpoint_refs() {
    let dir = repo();
    capture(&dir.0, "retained-session", 1).unwrap();
    let saved = snapshot(&checkout(&dir.0).unwrap()).unwrap();
    let tree_line = format!("tree {}\nauthor PandaCode <checkpoint@pandacode.invalid> 1000000000 +0000\ncommitter PandaCode <checkpoint@pandacode.invalid> 1000000000 +0000\n\n{}\n", saved.tree, serde_json::to_string(&saved).unwrap());
    let old = oid(git(
        &dir.0,
        None,
        &["hash-object", "-t", "commit", "-w", "--stdin"],
        Some(tree_line.as_bytes()),
        8192,
    )
    .unwrap())
    .unwrap();
    git(
        &dir.0,
        None,
        &["update-ref", "refs/pandacode/cp/retained-session/2", &old],
        None,
        8192,
    )
    .unwrap();
    git(
        &dir.0,
        None,
        &["update-ref", "refs/keep/old", &old],
        None,
        8192,
    )
    .unwrap();
    collect(&dir.0).unwrap();
    assert!(load(
        &checkout(&dir.0).unwrap(),
        "refs/pandacode/cp/retained-session/1"
    )
    .is_ok());
    assert!(git(
        &dir.0,
        None,
        &[
            "show-ref",
            "--verify",
            "refs/pandacode/cp/retained-session/2"
        ],
        None,
        8192
    )
    .is_err());
    assert!(git(
        &dir.0,
        None,
        &["show-ref", "--verify", "refs/keep/old"],
        None,
        8192
    )
    .is_ok());
}

#[cfg(unix)]
#[test]
fn symlinks_execute_bits_and_filters_do_not_escape_or_run() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let dir = repo();
    let outside = Scratch::new().unwrap();
    fs::write(outside.0.join("private"), "outside").unwrap();
    symlink(&outside.0, dir.0.join("link")).unwrap();
    fs::write(
        dir.0.join(".gitattributes"),
        "*.txt filter=checkpoint-test text eol=crlf\n",
    )
    .unwrap();
    fs::write(
        dir.0.join(".git/info/attributes"),
        "*.txt filter=checkpoint-test text eol=crlf\n",
    )
    .unwrap();
    git(
        &dir.0,
        None,
        &[
            "config",
            "filter.checkpoint-test.clean",
            "touch FILTER_RAN; cat",
        ],
        None,
        8192,
    )
    .unwrap();
    git(
        &dir.0,
        None,
        &[
            "config",
            "filter.checkpoint-test.smudge",
            "touch FILTER_RAN; cat",
        ],
        None,
        8192,
    )
    .unwrap();
    fs::set_permissions(dir.0.join("file.txt"), fs::Permissions::from_mode(0o755)).unwrap();
    let (state, task, message) = fixture(&dir.0);
    capture(&dir.0, &task.id, message).unwrap();
    fs::write(dir.0.join("file.txt"), "changed\n").unwrap();
    fs::set_permissions(dir.0.join("file.txt"), fs::Permissions::from_mode(0o644)).unwrap();
    fs::remove_file(dir.0.join("link")).unwrap();
    let token = review(&dir.0, &task.id, message);
    restore(&state, &task.id, message, &token).unwrap();
    assert_eq!(fs::read_link(dir.0.join("link")).unwrap(), outside.0);
    assert_ne!(
        fs::metadata(dir.0.join("file.txt"))
            .unwrap()
            .permissions()
            .mode()
            & 0o111,
        0
    );
    assert!(!dir.0.join("FILTER_RAN").exists());
    assert_eq!(fs::read(outside.0.join("private")).unwrap(), b"outside");
}
