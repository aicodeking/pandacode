use super::*;

struct Fixture { root: PathBuf, store: Store, project: Project, task: Session }
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("pandacode-relocate-{}", id()));
        std::fs::create_dir_all(root.join("old")).unwrap();
        std::fs::create_dir_all(root.join("external drive/New folder é")).unwrap();
        let store = Store::open(&root.join("app.sqlite")).unwrap();
        let project = store.add_project(&root.join("old")).unwrap();
        let task = store.create_session(&project.id, "codex", "default", "auto").unwrap();
        Self { root, store, project, task }
    }
    fn destination(&self) -> PathBuf { self.root.join("external drive/New folder é") }
}
impl Drop for Fixture { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.root); } }

#[test]
fn project_relocation_preserves_history_settings_and_identity_after_reopen() {
    let f = Fixture::new();
    f.store.rename_project(&f.project.id, "My custom project").unwrap();
    f.store.message(&f.task.id, "user", "Keep this conversation").unwrap();
    f.store.message(&f.task.id, "assistant", "Saved answer").unwrap();
    f.store.db.execute("UPDATE sessions SET resume_id='old-native-thread',pinned=1,sidebar_order=4,reasoning_effort='high',codex_settings='{}',task_stage='completed',completed_at=123 WHERE id=?1", [&f.task.id]).unwrap();
    f.store.db.execute("INSERT INTO moodboards(id,project_id,name,created_at,updated_at) VALUES('board',?1,'References',1,1)", [&f.project.id]).unwrap();
    let original = serde_json::to_value(f.store.messages(&f.task.id, None).unwrap()).unwrap();
    let before = f.store.session(&f.task.id).unwrap();
    // The source can already be gone; relocation must never require it to exist.
    std::fs::remove_dir(f.root.join("old")).unwrap();
    let updated = f.store.relocate_project(&f.project.id, &f.destination()).unwrap();
    assert_eq!(updated.id, f.project.id);
    assert_eq!(updated.name, "My custom project");
    assert_eq!(updated.added_order, f.project.added_order);
    assert_eq!(PathBuf::from(updated.path), f.destination().canonicalize().unwrap());
    let reopened = Store::open(&f.root.join("app.sqlite")).unwrap();
    let after = reopened.session(&f.task.id).unwrap();
    assert_eq!(serde_json::to_value(reopened.messages(&f.task.id, None).unwrap()).unwrap(), original);
    assert_eq!(after.project_id, before.project_id);
    assert_eq!(after.updated_at, before.updated_at);
    assert_eq!(after.pinned, before.pinned);
    assert_eq!(after.sidebar_order, before.sidebar_order);
    assert_eq!(after.codex_settings, before.codex_settings);
    assert_eq!(after.reasoning_effort, before.reasoning_effort);
    assert_eq!(after.task_stage, before.task_stage);
    assert_eq!(after.completed_at, before.completed_at);
    assert!(after.resume_id.is_none());
    assert_eq!(reopened.db.query_row("SELECT harness_id FROM task_usage_links WHERE session_id=?1", [&f.task.id], |r| r.get::<_, String>(0)).unwrap(), "old-native-thread");
    let (recovered, through) = crate::context_recovery::prepare(&reopened, &after, "Continue").unwrap();
    assert!(through.is_some());
    assert!(recovered.contains("Keep this conversation") && recovered.contains("Saved answer"));
    assert_eq!(reopened.db.query_row("SELECT project_id FROM moodboards WHERE id='board'", [], |r| r.get::<_, String>(0)).unwrap(), f.project.id);
}

#[test]
fn project_relocation_invalid_destinations_and_busy_tasks_leave_everything_unchanged() {
    let f = Fixture::new();
    f.store.db.execute("UPDATE sessions SET resume_id='native-thread' WHERE id=?1", [&f.task.id]).unwrap();
    std::fs::write(f.root.join("file"), "not a folder").unwrap();
    let other = f.store.add_project(&f.destination()).unwrap();
    for path in [f.root.join("missing"), f.root.join("file"), f.destination(), PathBuf::from("relative")] {
        assert!(f.store.relocate_project(&f.project.id, &path).is_err());
        assert_eq!(f.store.project(&f.project.id).unwrap().path, f.project.path);
        assert_eq!(f.store.session(&f.task.id).unwrap().resume_id.as_deref(), Some("native-thread"));
    }
    f.store.remove_project(&other.id).unwrap();
    for setting in ["status='running'", "status='waiting'", "resume_at_reset=1", "goal_state='{\"status\":\"paused\"}'"] {
        f.store.db.execute(&format!("UPDATE sessions SET {setting} WHERE id=?1"), [&f.task.id]).unwrap();
        assert!(f.store.relocate_project(&f.project.id, &f.destination()).unwrap_err().contains("Stop this project's"));
        assert_eq!(f.store.project(&f.project.id).unwrap().path, f.project.path);
        f.store.db.execute("UPDATE sessions SET status='idle',resume_at_reset=0,goal_state=NULL WHERE id=?1", [&f.task.id]).unwrap();
    }
    assert_eq!(f.store.relocate_project(&f.project.id, Path::new(&f.project.path)).unwrap().path, f.project.path);
    assert_eq!(f.store.session(&f.task.id).unwrap().resume_id.as_deref(), Some("native-thread"), "unchanged path is a no-op");
}

fn git(root: &Path, arguments: &[&str]) {
    let output = std::process::Command::new("git").arg("-C").arg(root).args(arguments).output().unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
}

#[test]
fn project_relocation_rebases_nested_worktrees_only_after_git_links_are_repaired() {
    let f = Fixture::new();
    let old = Path::new(&f.project.path);
    git(old, &["init"]);
    git(old, &["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-m", "Initial"]);
    git(old, &["worktree", "add", "-b", "nested", "nested"]);
    let external = f.root.join("old-other");
    git(old, &["worktree", "add", "-b", "external", external.to_str().unwrap()]);
    let outside_task = f.store.create_session(&f.project.id, "claude", "sonnet", "auto").unwrap();
    f.store.db.execute("UPDATE sessions SET worktree_path=?2 WHERE id=?1", params![f.task.id, old.join("nested").to_str().unwrap()]).unwrap();
    f.store.db.execute("UPDATE sessions SET worktree_path=?2 WHERE id=?1", params![outside_task.id, external.to_str().unwrap()]).unwrap();
    std::fs::remove_dir(f.destination()).unwrap();
    std::fs::rename(old, f.destination()).unwrap();
    assert!(f.store.relocate_project(&f.project.id, &f.destination()).unwrap_err().contains("Repair Git worktrees"));
    assert_eq!(f.store.project(&f.project.id).unwrap().path, f.project.path);
    git(&f.destination(), &["worktree", "repair", f.destination().join("nested").to_str().unwrap(), external.to_str().unwrap()]);
    f.store.relocate_project(&f.project.id, &f.destination()).unwrap();
    assert_eq!(f.store.session(&f.task.id).unwrap().worktree_path, Some(f.destination().canonicalize().unwrap().join("nested").to_string_lossy().into_owned()));
    assert_eq!(f.store.session(&outside_task.id).unwrap().worktree_path, Some(external.to_string_lossy().into_owned()), "a textual prefix is not a child path");
}

#[test]
fn project_relocation_keeps_remote_and_cloud_native_contexts() {
    let f = Fixture::new();
    f.store.db.execute("UPDATE sessions SET resume_id='cloud-thread',cloud='{}' WHERE id=?1", [&f.task.id]).unwrap();
    let remote = f.store.create_session(&f.project.id, "claude", "sonnet", "auto").unwrap();
    f.store.db.execute("UPDATE sessions SET resume_id='remote-thread',remote_device='other-machine',worktree_path='/on/another/computer' WHERE id=?1", [&remote.id]).unwrap();
    f.store.relocate_project(&f.project.id, &f.destination()).unwrap();
    assert_eq!(f.store.session(&f.task.id).unwrap().resume_id.as_deref(), Some("cloud-thread"));
    assert_eq!(f.store.session(&remote.id).unwrap().resume_id.as_deref(), Some("remote-thread"));
}

#[test]
fn project_relocation_rolls_back_context_and_path_updates_when_a_worktree_is_invalid() {
    let f = Fixture::new();
    f.store.message(&f.task.id, "user", "Earlier context").unwrap();
    f.store.db.execute("UPDATE sessions SET resume_id='retained-context' WHERE id=?1", [&f.task.id]).unwrap();
    let worktree = f.store.create_session(&f.project.id, "claude", "sonnet", "auto").unwrap();
    f.store.db.execute("UPDATE sessions SET worktree_path=?2 WHERE id=?1", params![worktree.id, f.root.join("old/missing-worktree").to_str().unwrap()]).unwrap();
    assert!(f.store.relocate_project(&f.project.id, &f.destination()).is_err());
    assert_eq!(f.store.project(&f.project.id).unwrap().path, f.project.path);
    assert_eq!(f.store.session(&f.task.id).unwrap().resume_id.as_deref(), Some("retained-context"));
    assert_eq!(f.store.db.query_row("SELECT COUNT(*) FROM context_recovery", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
}
