use super::*;
use std::path::Path;

#[test]
fn a_listing_reads_a_teams_status_alone_and_survives_a_corrupt_row() {
    let store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let project = store.add_project(&std::env::temp_dir()).unwrap();
    let task = store.create_session(&project.id, "codex", "default", "ask").unwrap();
    let listed = |content: &str| {
        store.db.execute("INSERT INTO architect_teams(session_id,content) VALUES(?1,?2) ON CONFLICT(session_id) DO UPDATE SET content=excluded.content", rusqlite::params![task.id, content]).unwrap();
        reconcile_inactive_task(&store, &HashMap::new(), store.session(&task.id).unwrap()).status
    };
    // Nothing but the status: a full parse of this row would fail.
    assert_eq!(listed(r#"{"status":"waiting"}"#), "waiting");
    assert_eq!(listed(r#"{"status":"paused"}"#), "idle");
    assert_eq!(listed("not json"), "idle");
}

#[test]
fn account_switch_notes_preserve_the_marker_and_body_in_message_pages() {
    let store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let project = store.add_project(&std::env::temp_dir()).unwrap();
    let task = store.create_session(&project.id, "claude", "sonnet", "ask").unwrap();
    let assistant = Mutex::new("Checking the project.".to_string());
    let body = "Account switched\nThe default Claude account reached its usage limit, so this task continues on “Backup”.";
    let mut switch = event(&task.id, "note", body);
    switch.data = Some(serde_json::json!({"accountPool": {"connectionId": "b"}}));
    save_agent_activity(&store, &assistant, &mut switch, None).unwrap();
    let mut ordinary = event(&task.id, "note", "Waiting for a background task.");
    save_agent_activity(&store, &assistant, &mut ordinary, None).unwrap();
    let page = store.message_page(&task.id, None).unwrap();
    let rows: Vec<_> = page.messages.iter().map(|message| (message.role.as_str(), message.content.as_str())).collect();
    assert_eq!(rows, [
        ("assistant", "Checking the project."),
        ("system", body),
        ("system", "Waiting for a background task."),
    ]);
    assert!(!page.has_older);
    assert!(assistant.lock().unwrap().is_empty());
    assert_eq!(switch.kind, "note");
    assert_eq!(switch.text, body);
    assert_eq!(switch.data.unwrap()["accountPool"]["connectionId"], "b");
}

#[test]
fn dismiss_error_event_carries_its_saved_row_id() {
    let store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let project = store.add_project(&std::env::temp_dir()).unwrap();
    let task = store.create_session(&project.id, "claude", "sonnet", "ask").unwrap();
    let assistant = Mutex::new(String::new());
    let mut first = event(&task.id, "error", "boom");
    save_agent_activity(&store, &assistant, &mut first, None).unwrap();
    let mut repeat = event(&task.id, "error", "boom");
    repeat.data = Some(serde_json::json!({"code": 7}));
    save_agent_activity(&store, &assistant, &mut repeat, None).unwrap();
    let mut odd = event(&task.id, "error", "boom");
    odd.data = Some(serde_json::json!("opaque"));
    save_agent_activity(&store, &assistant, &mut odd, None).unwrap();
    let ids: Vec<i64> = store.message_page(&task.id, None).unwrap().messages.iter().map(|m| m.id).collect();
    assert_eq!(ids.len(), 3);
    assert_eq!(first.data.unwrap()["messageId"], ids[0]);
    let repeat = repeat.data.unwrap();
    assert_eq!((repeat["messageId"].as_i64(), repeat["code"].as_i64()), (Some(ids[1]), Some(7)));
    assert_eq!(odd.data, Some(serde_json::json!("opaque")));
    // Only error events get an id; a failed write leaves the event without one.
    let mut note = event(&task.id, "note", "fine");
    save_agent_activity(&store, &assistant, &mut note, None).unwrap();
    assert!(note.data.is_none());
    store.db.execute_batch("CREATE TRIGGER reject_error BEFORE INSERT ON messages WHEN NEW.role='error' BEGIN SELECT RAISE(ABORT,'nope'); END;").unwrap();
    let mut unsaved = event(&task.id, "error", "boom");
    assert!(save_agent_activity(&store, &assistant, &mut unsaved, None).is_err());
    assert!(unsaved.data.is_none());
}

#[test]
fn assistant_boundaries_preserve_separate_commentary_and_final_rows_without_tools() {
    let store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let project = store.add_project(&std::env::temp_dir()).unwrap();
    let task = store
        .create_session(&project.id, "codex", "default", "ask")
        .unwrap();
    store.begin_task_turn(&task.id, "Build a game").unwrap();
    let assistant = Mutex::new(String::new());
    let mut boundary = event(&task.id, "message_start", "");
    boundary.data = Some(serde_json::json!({"messageId": "commentary", "phase": "commentary"}));
    save_agent_activity(&store, &assistant, &mut boundary, None).unwrap();
    assistant.lock().unwrap().push_str("I’ll build it ");
    assistant.lock().unwrap().push_str("with a timer.");
    // Deltas stay in memory until a real message boundary; the first
    // response is durable before the final response begins streaming.
    assert_eq!(store.messages(&task.id, None).unwrap().len(), 1);
    boundary.data = Some(serde_json::json!({"messageId": "final", "phase": "final_answer"}));
    save_agent_activity(&store, &assistant, &mut boundary, None).unwrap();
    assert_eq!(
        store.messages(&task.id, None).unwrap()[1].content,
        "I’ll build it with a timer."
    );
    assistant.lock().unwrap().push_str("The game is ready.");
    flush_assistant(&store, &task.id, &assistant).unwrap();
    flush_assistant(&store, &task.id, &assistant).unwrap();
    let messages = store.messages(&task.id, None).unwrap();
    assert_eq!(
        messages
            .iter()
            .map(|message| message.role.as_str())
            .collect::<Vec<_>>(),
        ["user", "assistant", "assistant"]
    );
    assert_eq!(messages[2].content, "The game is ready.");
    assert!(messages[1].id < messages[2].id);
}

#[test]
fn boundaries_after_tools_do_not_add_empty_or_duplicate_assistant_rows() {
    let store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let project = store.add_project(&std::env::temp_dir()).unwrap();
    let task = store
        .create_session(&project.id, "claude", "sonnet", "ask")
        .unwrap();
    let assistant = Mutex::new("Checking the project.".to_string());
    let mut tool = event(&task.id, "tool", "Read");
    tool.tool = Some(providers::ToolActivity {
        id: "run:read".into(),
        name: "Read".into(),
        status: "completed".into(),
        input: "README.md".into(),
        output: "Project details".into(),
        write_paths: None,
    });
    save_agent_activity(&store, &assistant, &mut tool, None).unwrap();
    let mut boundary = event(&task.id, "message_start", "");
    save_agent_activity(&store, &assistant, &mut boundary, None).unwrap();
    save_agent_activity(&store, &assistant, &mut boundary, None).unwrap();
    assistant
        .lock()
        .unwrap()
        .push_str("This is a game project.");
    flush_assistant(&store, &task.id, &assistant).unwrap();
    let messages = store.messages(&task.id, None).unwrap();
    assert_eq!(
        messages
            .iter()
            .map(|message| message.role.as_str())
            .collect::<Vec<_>>(),
        ["assistant", "tool", "assistant"]
    );
    assert_eq!(messages[0].content, "Checking the project.");
    assert_eq!(messages[2].content, "This is a game project.");
}

#[test]
fn failed_boundary_write_keeps_response_buffer_until_a_successful_retry() {
    let store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let project = store.add_project(&std::env::temp_dir()).unwrap();
    let task = store
        .create_session(&project.id, "codex", "default", "ask")
        .unwrap();
    let assistant = Mutex::new("Preserve this response.".to_string());
    store.db.execute_batch("CREATE TRIGGER reject_response BEFORE INSERT ON messages WHEN NEW.role='assistant' BEGIN SELECT RAISE(ABORT,'injected storage failure'); END;").unwrap();
    let mut boundary = event(&task.id, "message_start", "");
    assert!(save_agent_activity(&store, &assistant, &mut boundary, None).is_err());
    assert_eq!(*assistant.lock().unwrap(), "Preserve this response.");
    assert!(store.messages(&task.id, None).unwrap().is_empty());
    store
        .db
        .execute_batch("DROP TRIGGER reject_response;")
        .unwrap();
    save_agent_activity(&store, &assistant, &mut boundary, None).unwrap();
    assert!(assistant.lock().unwrap().is_empty());
    flush_assistant(&store, &task.id, &assistant).unwrap();
    assert_eq!(store.messages(&task.id, None).unwrap().len(), 1);
}

#[test]
fn late_tool_updates_do_not_split_an_assistant_response_that_is_still_streaming() {
    let store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let project = store.add_project(&std::env::temp_dir()).unwrap();
    let task = store
        .create_session(&project.id, "codex", "default", "ask")
        .unwrap();
    let assistant = Mutex::new("I’ll inspect the files.".to_string());
    let mut tool = event(&task.id, "tool", "Read");
    tool.tool = Some(providers::ToolActivity {
        id: "run:read".into(),
        name: "Read".into(),
        status: "running".into(),
        input: "README.md".into(),
        output: String::new(),
        write_paths: None,
    });
    save_agent_activity(&store, &assistant, &mut tool, None).unwrap();
    let mut boundary = event(&task.id, "message_start", "");
    save_agent_activity(&store, &assistant, &mut boundary, None).unwrap();
    assistant.lock().unwrap().push_str("The project has ");
    tool.tool.as_mut().unwrap().output = "Partial file content".into();
    save_agent_activity(&store, &assistant, &mut tool, None).unwrap();
    assistant.lock().unwrap().push_str("a simple structure ");
    tool.tool.as_mut().unwrap().status = "completed".into();
    tool.tool.as_mut().unwrap().output = "Complete file content".into();
    save_agent_activity(&store, &assistant, &mut tool, None).unwrap();
    assert_eq!(store.messages(&task.id, None).unwrap().len(), 2);
    assistant.lock().unwrap().push_str("and is ready to build.");
    flush_assistant(&store, &task.id, &assistant).unwrap();
    let messages = store.messages(&task.id, None).unwrap();
    assert_eq!(
        messages
            .iter()
            .map(|message| message.role.as_str())
            .collect::<Vec<_>>(),
        ["assistant", "tool", "assistant"]
    );
    assert_eq!(
        messages[2].content,
        "The project has a simple structure and is ready to build."
    );
    assert!(messages[1].content.contains("Complete file content"));
}

#[test]
fn stop_is_recorded_even_when_provider_returns_success_or_has_closed_its_input() {
    let (input, mut receiver) = unbounded_channel();
    let stopped = Arc::new(AtomicBool::new(false));
    let agent = RunningAgent::new(input, stopped.clone());
    agent
        .send(RunInput::Approval {
            request_id: "test".into(),
            approved: true,
        })
        .unwrap();
    assert!(!stopped.load(Ordering::SeqCst));
    assert!(receiver.try_recv().is_ok());
    agent.send(RunInput::Stop).unwrap();
    assert!(stopped.load(Ordering::SeqCst));
    stopped.store(false, Ordering::SeqCst);
    drop(receiver);
    assert!(agent.send(RunInput::Stop).is_err());
    assert!(stopped.load(Ordering::SeqCst));
}

#[tokio::test]
async fn the_worktree_guard_refuses_before_and_after_the_wait() {
    use std::sync::atomic::AtomicUsize;
    let waited = Arc::new(AtomicBool::new(false));
    // Busy at once: refused without waiting.
    let flag = waited.clone();
    let error = guard_idle(|| true, async move { flag.store(true, Ordering::SeqCst); Ok(()) }, "busy").await.unwrap_err();
    assert_eq!(error, "busy");
    assert!(!waited.load(Ordering::SeqCst), "waited although the agent was running");
    // Idle throughout: waits, then proceeds.
    let flag = waited.clone();
    guard_idle(|| false, async move { flag.store(true, Ordering::SeqCst); Ok(()) }, "busy").await.unwrap();
    assert!(waited.load(Ordering::SeqCst));
    // An agent starts during the wait: refused afterwards.
    let started = Arc::new(AtomicBool::new(false));
    let (check, flag) = (started.clone(), started.clone());
    let error = guard_idle(|| check.load(Ordering::SeqCst), async move { flag.store(true, Ordering::SeqCst); Ok(()) }, "busy").await.unwrap_err();
    assert_eq!(error, "busy");
    // A failed wait is returned as is, with one check before it.
    let checks = AtomicUsize::new(0);
    let error = guard_idle(|| { checks.fetch_add(1, Ordering::SeqCst); false }, async { Err("shutting down".to_string()) }, "busy").await.unwrap_err();
    assert_eq!(error, "shutting down");
    assert_eq!(checks.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn remove_project_quiesces_sessions_and_forgets_their_state() {
    use crate::app_instructions::{remember_catalog, History};
    let dir = std::env::temp_dir().join(format!("pandacode-rm-proj-{}", uuid::Uuid::new_v4().simple()));
    let proj_dir = dir.join("removed");
    let keep_dir = dir.join("kept");
    std::fs::create_dir_all(&proj_dir).unwrap();
    std::fs::create_dir_all(&keep_dir).unwrap();
    let store = Store::open(Path::new(":memory:")).unwrap();
    let project = store.add_project(&proj_dir).unwrap();
    let kept_project = store.add_project(&keep_dir).unwrap();
    let s1 = store.create_session(&project.id, "claude", "default", "full").unwrap();
    let s2 = store.create_session(&project.id, "claude", "default", "full").unwrap();
    let kept = store.create_session(&kept_project.id, "claude", "default", "full").unwrap();
    let state = Arc::new(AppState {
        store: Arc::new(Mutex::new(store)),
        agents: Arc::new(Mutex::new(HashMap::new())),
        terminals: Arc::new(Mutex::new(HashMap::new())),
        shutdown: AtomicU8::new(0),
    });

    let natives = ["SendMessage".to_owned()];
    for id in [&s1.id, &s2.id, &kept.id] {
        remember_catalog(id, Some("conv-1"), None, &natives);
        custom_tools::test_note(id);
    }

    // Refuses while an agent is active in this project.
    let (tx, _rx) = unbounded_channel();
    state.agents.lock().unwrap().insert(s1.id.clone(), RunningAgent::new(tx, Arc::new(AtomicBool::new(false))));
    assert!(remove_project_in_state(&state, &project.id).await.unwrap_err().contains("agents"));
    state.agents.lock().unwrap().remove(&s1.id);

    // Refuses while an architect team is running/waiting in this project.
    state
        .store
        .lock()
        .unwrap()
        .db
        .execute(
            "INSERT INTO architect_teams(session_id, content) VALUES(?1, ?2)",
            rusqlite::params![s1.id, r#"{"status":"running"}"#],
        )
        .unwrap();
    assert!(remove_project_in_state(&state, &project.id).await.unwrap_err().contains("architect teams"));
    state
        .store
        .lock()
        .unwrap()
        .db
        .execute("DELETE FROM architect_teams WHERE session_id=?1", [&s1.id])
        .unwrap();

    // Waits for pending exits of the project's sessions before removing the project row and forgetting state.
    let hold = providers::hold_exit_for_test(&s1.id);
    let removing = tokio::spawn({
        let state = state.clone();
        let pid = project.id.clone();
        async move { remove_project_in_state(&state, &pid).await }
    });
    tokio::time::sleep(std::time::Duration::from_millis(80)).await;
    assert!(!removing.is_finished(), "remove_project must wait until project sessions finish exiting");
    assert!(state.store.lock().unwrap().project(&project.id).is_ok());

    drop(hold);
    tokio::time::timeout(std::time::Duration::from_secs(2), removing)
        .await
        .expect("remove_project should finish once sessions quiesce")
        .unwrap()
        .unwrap();
    assert!(state.store.lock().unwrap().project(&project.id).is_err());
    for id in [&s1.id, &s2.id] {
        assert_eq!(History::of(id, "claude", Some("conv-1")), History::unknown(false));
        assert!(!custom_tools::test_noted(id));
    }
    assert_eq!(History::of(&kept.id, "claude", Some("conv-1")), History::holding(&["SendMessage"]));
    assert!(custom_tools::test_noted(&kept.id));

    app_instructions::forget(std::slice::from_ref(&kept.id));
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn merge_and_remove_task_worktree_wait_for_own_exit_and_refuse_other_sessions() {
    let base = std::env::temp_dir().join(format!("pandacode-wt-e2e-{}", uuid::Uuid::new_v4().simple()));
    let main = base.join("main");
    std::fs::create_dir_all(&main).unwrap();
    let main = std::fs::canonicalize(main).unwrap();
    let git = |cwd: &Path, args: &[&str]| {
        let out = std::process::Command::new("git").args(args).current_dir(cwd).output().unwrap();
        assert!(out.status.success(), "{args:?}: {}", String::from_utf8_lossy(&out.stderr));
    };
    git(&main, &["init", "-b", "main"]);
    git(&main, &["config", "user.name", "Tests"]);
    git(&main, &["config", "user.email", "tests@example.invalid"]);
    std::fs::write(main.join("readme.txt"), "base\n").unwrap();
    git(&main, &["add", "readme.txt"]);
    git(&main, &["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "commit", "-m", "init"]);

    let wt = workspace::create_worktree_for(&main, "feature", None, false, workspace::Trust::Desktop).unwrap();
    std::fs::write(wt.path.join("feature.txt"), "hi\n").unwrap();
    git(&wt.path, &["add", "feature.txt"]);
    git(&wt.path, &["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "commit", "-m", "feat"]);

    let store = Store::open(Path::new(":memory:")).unwrap();
    let project = store.add_project(&main).unwrap();
    let wt_task = store.create_session(&project.id, "claude", "default", "full").unwrap();
    let wt_fork = store.create_session(&project.id, "claude", "default", "full").unwrap();
    let main_sibling = store.create_session(&project.id, "claude", "default", "full").unwrap();
    for sid in [&wt_task.id, &wt_fork.id] {
        store
            .db
            .execute(
                "UPDATE sessions SET worktree_path=?2, worktree_branch=?3 WHERE id=?1",
                rusqlite::params![sid, wt.path.to_string_lossy(), wt.branch],
            )
            .unwrap();
    }
    let state = Arc::new(AppState {
        store: Arc::new(Mutex::new(store)),
        agents: Arc::new(Mutex::new(HashMap::new())),
        terminals: Arc::new(Mutex::new(HashMap::new())),
        shutdown: AtomicU8::new(0),
    });

    // Merge waits for own pending exit, then refuses if a sibling started in `&main` meanwhile.
    let hold_self = providers::hold_exit_in_cwd_for_test(&wt_task.id, wt.path.clone());
    let merging = tokio::spawn({
        let state = state.clone();
        let sid = wt_task.id.clone();
        async move { merge_task_worktree(&state, sid, workspace::Trust::Desktop).await }
    });
    tokio::time::sleep(std::time::Duration::from_millis(80)).await;
    assert!(!merging.is_finished(), "merge must wait on own pending exit");
    let (tx, _rx) = unbounded_channel();
    state.agents.lock().unwrap().insert(main_sibling.id.clone(), RunningAgent::new(tx, Arc::new(AtomicBool::new(false))));
    drop(hold_self);
    let outcome = tokio::time::timeout(std::time::Duration::from_secs(5), merging).await.unwrap().unwrap();
    assert!(outcome.is_err(), "sibling started in main during wait must refuse merge");
    state.agents.lock().unwrap().remove(&main_sibling.id);

    // Merge waits for own pending exit and succeeds cleanly once released.
    let hold_self = providers::hold_exit_in_cwd_for_test(&wt_task.id, wt.path.clone());
    let merging = tokio::spawn({
        let state = state.clone();
        let sid = wt_task.id.clone();
        async move { merge_task_worktree(&state, sid, workspace::Trust::Desktop).await }
    });
    tokio::time::sleep(std::time::Duration::from_millis(80)).await;
    assert!(!merging.is_finished());
    drop(hold_self);
    let merged = tokio::time::timeout(std::time::Duration::from_secs(5), merging).await.unwrap().unwrap().unwrap();
    assert_eq!(merged.commits, 1);

    // Remove refuses while a forked task sharing `worktree_path` has a pending exit.
    let hold_fork = providers::hold_exit_for_test(&wt_fork.id);
    assert!(remove_task_worktree(&state, wt_task.id.clone(), true, workspace::Trust::Desktop).await.is_err());
    assert!(wt.path.exists(), "worktree must stay when forked task is exiting");
    drop(hold_fork);
    providers::await_exit(&wt_fork.id).await.unwrap();

    // Remove waits for own pending exit and removes the worktree once released.
    let hold_self = providers::hold_exit_in_cwd_for_test(&wt_task.id, wt.path.clone());
    let removing = tokio::spawn({
        let state = state.clone();
        let sid = wt_task.id.clone();
        async move { remove_task_worktree(&state, sid, true, workspace::Trust::Desktop).await }
    });
    tokio::time::sleep(std::time::Duration::from_millis(80)).await;
    assert!(!removing.is_finished(), "remove must wait on own pending exit");
    drop(hold_self);
    tokio::time::timeout(std::time::Duration::from_secs(5), removing).await.unwrap().unwrap().unwrap();
    assert!(!wt.path.exists());

    let _ = std::fs::remove_dir_all(base);
}

#[cfg(unix)]
#[tokio::test]
async fn remove_and_recreate_task_worktree_retire_sibling_and_own_pooled_warm_spares() {
    let _serial = providers::spare_pool_test_lock().lock().await;
    let base = std::env::temp_dir().join(format!("pandacode-wt-spares-{}", uuid::Uuid::new_v4().simple()));
    let main = base.join("main");
    std::fs::create_dir_all(&main).unwrap();
    let main = std::fs::canonicalize(main).unwrap();
    let git = |cwd: &Path, args: &[&str]| {
        let out = std::process::Command::new("git").args(args).current_dir(cwd).output().unwrap();
        assert!(out.status.success(), "{args:?}: {}", String::from_utf8_lossy(&out.stderr));
    };
    git(&main, &["init", "-b", "main"]);
    git(&main, &["config", "user.name", "Tests"]);
    git(&main, &["config", "user.email", "tests@example.invalid"]);
    std::fs::write(main.join("readme.txt"), "base\n").unwrap();
    git(&main, &["add", "readme.txt"]);
    git(&main, &["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "commit", "-m", "init"]);

    let wt = workspace::create_worktree_for(&main, "feature", None, false, workspace::Trust::Desktop).unwrap();
    let store = Store::open(Path::new(":memory:")).unwrap();
    let project = store.add_project(&main).unwrap();
    let wt_task = store.create_session(&project.id, "claude", "default", "full").unwrap();
    let wt_fork = store.create_session(&project.id, "claude", "default", "full").unwrap();
    let main_sibling = store.create_session(&project.id, "claude", "default", "full").unwrap();
    for sid in [&wt_task.id, &wt_fork.id] {
        store
            .db
            .execute(
                "UPDATE sessions SET worktree_path=?2, worktree_branch=?3 WHERE id=?1",
                rusqlite::params![sid, wt.path.to_string_lossy(), wt.branch],
            )
            .unwrap();
    }
    let state = Arc::new(AppState {
        store: Arc::new(Mutex::new(store)),
        agents: Arc::new(Mutex::new(HashMap::new())),
        terminals: Arc::new(Mutex::new(HashMap::new())),
        shutdown: AtomicU8::new(0),
    });

    // Remove worktree must retire a forked sibling's pooled warm spare holding `&wt.path`,
    // while leaving an unrelated spare in `&main` untouched (kept in the lead pool so it is
    // never evicted by the two ordinary spares inserted below).
    let fork_pid = providers::insert_spare_in_cwd_for_test(&wt_fork.id, wt.path.clone(), false);
    let main_pid = providers::insert_spare_in_cwd_for_test(&main_sibling.id, main.clone(), true);
    remove_task_worktree(&state, wt_task.id.clone(), false, workspace::Trust::Desktop)
        .await
        .unwrap();
    assert!(!wt.path.exists(), "worktree should be removed");
    assert!(!providers::has_spare_for_test(&wt_fork.id), "forked sibling's pooled spare must be retired");
    assert!(providers::process_gone_for_test(fork_pid), "forked sibling's spare process must exit");
    assert!(providers::has_spare_for_test(&main_sibling.id), "main checkout spare must stay pooled");
    assert!(!providers::process_gone_for_test(main_pid));

    // Recreate worktree (after the folder disappeared externally) must retire both the task's
    // own spare and any sibling spare pinned to the deleted directory's old inode.
    recreate_task_worktree(&state, wt_task.id.clone()).await.unwrap();
    assert!(wt.path.exists(), "worktree should exist before simulating external deletion");
    let own_pid = providers::insert_spare_in_cwd_for_test(&wt_task.id, wt.path.clone(), false);
    let fork_pid_2 = providers::insert_spare_in_cwd_for_test(&wt_fork.id, wt.path.clone(), false);
    std::fs::remove_dir_all(&wt.path).unwrap();
    assert!(!wt.path.exists());

    recreate_task_worktree(&state, wt_task.id.clone()).await.unwrap();
    assert!(wt.path.exists(), "worktree should be recreated");
    assert!(!providers::has_spare_for_test(&wt_task.id), "own stale-inode spare must be retired");
    assert!(!providers::has_spare_for_test(&wt_fork.id), "sibling stale-inode spare must be retired");
    assert!(providers::process_gone_for_test(own_pid), "own spare process must exit");
    assert!(providers::process_gone_for_test(fork_pid_2), "sibling spare process must exit");
    assert!(providers::has_spare_for_test(&main_sibling.id), "main checkout spare must stay pooled");

    providers::quiesce(&main_sibling.id).await.unwrap();
    let _ = std::fs::remove_dir_all(base);
}

#[test]
fn stale_running_status_recovers_after_completion_write_failure_without_hiding_live_runs() {
    let store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let project = store.add_project(&std::env::temp_dir()).unwrap();
    let task = store
        .create_session(&project.id, "claude", "sonnet", "ask")
        .unwrap();
    store.begin_task_turn(&task.id, "Build a game").unwrap();
    let (input, _receiver) = unbounded_channel();
    let mut agents = HashMap::new();
    agents.insert(
        task.id.clone(),
        RunningAgent::new(input, Arc::new(AtomicBool::new(false))),
    );
    let live = reconcile_inactive_task(&store, &agents, store.session(&task.id).unwrap());
    assert_eq!(live.status, "running");
    store.db.execute_batch("CREATE TRIGGER reject_completion BEFORE UPDATE ON sessions BEGIN SELECT RAISE(ABORT,'injected storage failure'); END;").unwrap();
    assert!(store.finish_task_turn(&task.id, true, false).is_err());
    agents.clear();
    let visible = reconcile_inactive_task(&store, &agents, store.session(&task.id).unwrap());
    assert_eq!(visible.status, "interrupted");
    assert_eq!(visible.task_stage, "in_progress");
    assert_eq!(store.session(&task.id).unwrap().status, "running");
    store
        .db
        .execute_batch("DROP TRIGGER reject_completion;")
        .unwrap();
    let recovered = reconcile_inactive_task(&store, &agents, store.session(&task.id).unwrap());
    assert_eq!(recovered.status, "interrupted");
    assert_eq!(store.session(&task.id).unwrap().status, "interrupted");
    store.begin_task_turn(&task.id, "Retry").unwrap();
    assert_eq!(store.session(&task.id).unwrap().status, "running");
}
