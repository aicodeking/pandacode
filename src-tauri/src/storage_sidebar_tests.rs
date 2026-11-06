use super::*;

fn tasks(store: &Store, count: usize) -> Vec<Session> {
    let project = store.add_project(&std::env::temp_dir()).unwrap();
    (0..count).map(|i| {
        let task = store.create_session(&project.id, "codex", "default", "full").unwrap();
        // Metadata edit time deliberately opposes activity order.
        store.db.execute("UPDATE sessions SET created_at=1,updated_at=?2,last_response_at=?3,last_prompt_at=NULL WHERE id=?1", params![task.id, i as i64 + 1, (count - i) as i64 + 10]).unwrap();
        store.session(&task.id).unwrap()
    }).collect()
}

fn ids(store: &Store) -> Vec<String> {
    store
        .sessions()
        .unwrap()
        .into_iter()
        .map(|s| s.id)
        .collect()
}

fn without_sidebar(task: &Session) -> serde_json::Value {
    let mut value = serde_json::to_value(task).unwrap();
    value.as_object_mut().unwrap().remove("pinned");
    value.as_object_mut().unwrap().remove("sidebarOrder");
    value
}

#[test]
fn sidebar_preferences_persist_without_changing_activity_or_execution() {
    let directory = std::env::temp_dir().join(format!("pandacode-sidebar-{}", id()));
    std::fs::create_dir_all(&directory).unwrap();
    let path = directory.join("store.sqlite");
    let initial;
    let expected;
    {
        let store = Store::open(&path).unwrap();
        initial = tasks(&store, 3);
        store.pin_session(&initial[2].id, true).unwrap();
        expected = vec![
            initial[2].id.clone(),
            initial[1].id.clone(),
            initial[0].id.clone(),
        ];
        store
            .reorder_sessions(&[initial[1].id.clone(), initial[0].id.clone()])
            .unwrap();
        assert_eq!(ids(&store), expected);
        for original in &initial {
            assert_eq!(
                without_sidebar(original),
                without_sidebar(&store.session(&original.id).unwrap())
            );
        }
    }
    {
        let store = Store::open(&path).unwrap();
        assert_eq!(ids(&store), expected);
        let pinned = store.session(&initial[2].id).unwrap();
        assert!(pinned.pinned);
        assert_eq!(pinned.sidebar_order, Some(0));
        // Archive/restore can retain the preference; unpin keeps its rank.
        store
            .update(&pinned.id, None, Some(true), None, None, None)
            .unwrap();
        assert!(store.session(&pinned.id).unwrap().pinned);
        let unpinned = store.pin_session(&pinned.id, false).unwrap();
        assert!(!unpinned.pinned);
        assert_eq!(unpinned.sidebar_order, Some(0));
    }
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn sidebar_filtered_reorder_preserves_hidden_slots_and_activity_fallback() {
    let store = Store::open(Path::new(":memory:")).unwrap();
    let tasks = tasks(&store, 5);
    let mut expected = tasks.iter().map(|s| s.id.clone()).collect::<Vec<_>>();
    assert_eq!(ids(&store), expected);
    // Two visible search/project results move; the three hidden rows stay put.
    let subset = vec![expected[3].clone(), expected[1].clone()];
    expected.swap(1, 3);
    store.reorder_sessions(&subset).unwrap();
    assert_eq!(ids(&store), expected);
    for (rank, task) in store.sessions().unwrap().iter().enumerate() {
        assert_eq!(task.sidebar_order, Some(rank as i64));
    }
    store.message(&tasks[4].id, "user", "New prompt").unwrap();
    assert_eq!(ids(&store), expected, "manual order survives new activity");
    // An unrelated archived row still has its same place in the global order.
    store
        .update(&tasks[2].id, None, Some(true), None, None, None)
        .unwrap();
    store
        .reorder_sessions(&[expected[3].clone(), expected[1].clone()])
        .unwrap();
    assert_eq!(store.session(&tasks[2].id).unwrap().sidebar_order, Some(2));
}

#[test]
fn sidebar_order_uses_prompt_response_then_creation_and_not_metadata_edits() {
    let store = Store::open(Path::new(":memory:")).unwrap();
    let tasks = tasks(&store, 3);
    store
        .db
        .execute(
            "UPDATE sessions SET last_prompt_at=30,last_response_at=20,created_at=100 WHERE id=?1",
            [&tasks[0].id],
        )
        .unwrap();
    store
        .db
        .execute(
            "UPDATE sessions SET last_prompt_at=NULL,last_response_at=40,updated_at=1 WHERE id=?1",
            [&tasks[1].id],
        )
        .unwrap();
    store.db.execute("UPDATE sessions SET last_prompt_at=NULL,last_response_at=NULL,created_at=35,updated_at=999 WHERE id=?1", [&tasks[2].id]).unwrap();
    assert_eq!(
        ids(&store),
        vec![
            tasks[1].id.clone(),
            tasks[2].id.clone(),
            tasks[0].id.clone()
        ]
    );
}

#[test]
fn sidebar_reorder_rejects_invalid_subsets_without_partial_writes() {
    let store = Store::open(Path::new(":memory:")).unwrap();
    let tasks = tasks(&store, 4);
    store.db.execute("INSERT INTO architect_workers(parent_session_id,worker_id,session_id) VALUES(?1,'worker',?2)", params![tasks[0].id, tasks[3].id]).unwrap();
    store.pin_session(&tasks[2].id, true).unwrap();
    let before = serde_json::to_value(store.sessions().unwrap()).unwrap();
    for invalid in [
        vec![],
        vec![tasks[0].id.clone(), tasks[0].id.clone()],
        vec!["missing".into()],
        vec![tasks[3].id.clone()],
        vec![tasks[0].id.clone(), tasks[2].id.clone()],
        (0..501).map(|i| format!("task-{i}")).collect(),
    ] {
        assert!(store.reorder_sessions(&invalid).is_err());
        assert_eq!(
            serde_json::to_value(store.sessions().unwrap()).unwrap(),
            before
        );
    }
    assert!(store.pin_session(&tasks[3].id, true).is_err());
    assert!(store.pin_session("missing", true).is_err());
    assert!(store.session(&tasks[3].id).unwrap().sidebar_order.is_none());
}

#[test]
fn sidebar_reorder_rolls_back_if_any_rank_write_fails() {
    let store = Store::open(Path::new(":memory:")).unwrap();
    let tasks = tasks(&store, 4);
    let before = serde_json::to_value(store.sessions().unwrap()).unwrap();
    store.db.execute_batch("CREATE TRIGGER fail_sidebar_rank BEFORE UPDATE OF sidebar_order ON sessions WHEN NEW.sidebar_order=2 BEGIN SELECT RAISE(ABORT,'injected write failure'); END;").unwrap();
    assert!(store
        .reorder_sessions(&[tasks[1].id.clone(), tasks[0].id.clone()])
        .is_err());
    assert_eq!(
        serde_json::to_value(store.sessions().unwrap()).unwrap(),
        before
    );
}

#[test]
fn sidebar_old_pinned_and_ranked_tasks_are_included_before_the_list_limit() {
    let store = Store::open(Path::new(":memory:")).unwrap();
    let tasks = tasks(&store, 502);
    store.pin_session(&tasks[501].id, true).unwrap();
    store
        .db
        .execute(
            "UPDATE sessions SET sidebar_order=0 WHERE id=?1",
            [&tasks[500].id],
        )
        .unwrap();
    let listed = store.sessions().unwrap();
    assert_eq!(listed.len(), 500);
    assert_eq!(listed[0].id, tasks[501].id);
    assert_eq!(listed[1].id, tasks[500].id);
    // Reorder must still preserve the two excluded tasks' relative positions.
    store
        .reorder_sessions(&[tasks[1].id.clone(), tasks[0].id.clone()])
        .unwrap();
    assert_eq!(
        store.session(&tasks[498].id).unwrap().sidebar_order,
        Some(500)
    );
    assert_eq!(
        store.session(&tasks[499].id).unwrap().sidebar_order,
        Some(501)
    );
}

#[test]
fn sidebar_forks_start_unpinned_unordered_and_deletion_preserves_other_preferences() {
    let store = Store::open(Path::new(":memory:")).unwrap();
    let tasks = tasks(&store, 2);
    let source = &tasks[0];
    store.message(&source.id, "user", "Saved prompt").unwrap();
    let boundary = store.db.last_insert_rowid();
    store.pin_session(&source.id, true).unwrap();
    store.reorder_sessions(std::slice::from_ref(&source.id)).unwrap();
    let fork = crate::conversation_fork::at_message(&store, &source.id, boundary).unwrap();
    assert!(!fork.pinned);
    assert_eq!(fork.sidebar_order, None);
    let worktree = store
        .create_worktree_session_on(
            &store.session(&source.id).unwrap(),
            &std::env::temp_dir(),
            None,
        )
        .unwrap();
    assert!(!worktree.pinned);
    assert_eq!(worktree.sidebar_order, None);
    let retained = serde_json::to_value(store.session(&tasks[1].id).unwrap()).unwrap();
    store
        .db
        .execute("DELETE FROM sessions WHERE id=?1", [&source.id])
        .unwrap();
    assert_eq!(
        serde_json::to_value(store.session(&tasks[1].id).unwrap()).unwrap(),
        retained
    );
    assert!(store.session(&fork.id).is_ok());
}

#[test]
fn sidebar_v20_migration_is_idempotent_and_retains_existing_preferences() {
    let directory = std::env::temp_dir().join(format!("pandacode-sidebar-migration-{}", id()));
    std::fs::create_dir_all(&directory).unwrap();
    let path = directory.join("store.sqlite");
    let sid;
    {
        let store = Store::open(&path).unwrap();
        sid = tasks(&store, 1)[0].id.clone();
        store.db.execute_batch("DROP INDEX sessions_sidebar; ALTER TABLE sessions DROP COLUMN pinned; ALTER TABLE sessions DROP COLUMN sidebar_order; PRAGMA user_version=20;").unwrap();
    }
    {
        let store = Store::open(&path).unwrap();
        let task = store.session(&sid).unwrap();
        assert!(!task.pinned);
        assert_eq!(task.sidebar_order, None);
        store.pin_session(&sid, true).unwrap();
        store.reorder_sessions(std::slice::from_ref(&sid)).unwrap();
        store.db.execute_batch("PRAGMA user_version=20;").unwrap();
    }
    {
        let store = Store::open(&path).unwrap();
        let task = store.session(&sid).unwrap();
        assert!(task.pinned);
        assert_eq!(task.sidebar_order, Some(0));
        assert_eq!(
            store
                .db
                .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
    }
    std::fs::remove_dir_all(directory).unwrap();
}
