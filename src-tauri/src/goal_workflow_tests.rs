//! Goal persistence is task-scoped, and native automatic turns remain ordinary
//! streamed transcript segments rather than fabricated user messages.
use super::*;
use crate::goal_state::GoalState;

fn fixture() -> (Store, Session) {
    let store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let project = store.add_project(&std::env::temp_dir()).unwrap();
    let task = store
        .create_session(&project.id, "codex", "default", "ask")
        .unwrap();
    store.resume(&task.id, "native-thread").unwrap();
    (store, task)
}
fn goal(status: &str) -> GoalState {
    GoalState {
        thread_id: "native-thread".into(),
        objective: "Finish the task".into(),
        status: status.into(),
        token_budget: Some(50000),
        tokens_used: 1200,
        time_used_seconds: 30,
        created_at: 1,
        updated_at: 31,
    }
}
#[test]
fn goal_snapshots_cannot_be_attached_to_another_task_or_harness() {
    let (store, task) = fixture();
    store.record_goal(&task.id, Some(&goal("active"))).unwrap();
    let mut foreign = goal("complete");
    foreign.thread_id = "another-thread".into();
    assert!(store.record_goal(&task.id, Some(&foreign)).is_err());
    assert_eq!(
        store.session(&task.id).unwrap().goal_state.unwrap().status,
        "active"
    );
    let project = store.add_project(&std::env::temp_dir()).unwrap();
    let claude = store
        .create_session(&project.id, "claude", "default", "ask")
        .unwrap();
    store.resume(&claude.id, "native-thread").unwrap();
    assert!(store
        .record_goal(&claude.id, Some(&goal("active")))
        .is_err());
    assert!(store.record_goal("missing", None).is_err());
}
#[test]
fn changing_the_native_thread_clears_its_old_goal_snapshot() {
    let (store, task) = fixture();
    store.record_goal(&task.id, Some(&goal("paused"))).unwrap();
    store.resume(&task.id, "native-thread").unwrap();
    assert!(store.session(&task.id).unwrap().goal_state.is_some());
    store.resume(&task.id, "different-thread").unwrap();
    assert!(store.session(&task.id).unwrap().goal_state.is_none());
}
#[test]
fn automatic_turn_boundaries_flush_responses_without_inventing_user_messages() {
    let (store, task) = fixture();
    store.begin_task_turn(&task.id, "Finish the task").unwrap();
    let assistant = Mutex::new("First response".to_owned());
    save_agent_activity(
        &store,
        &assistant,
        &mut event(&task.id, "turn_complete", ""),
        None,
    )
    .unwrap();
    save_agent_activity(
        &store,
        &assistant,
        &mut event(&task.id, "turn_start", ""),
        None,
    )
    .unwrap();
    assistant.lock().unwrap().push_str("Second response");
    save_agent_activity(
        &store,
        &assistant,
        &mut event(&task.id, "turn_complete", ""),
        None,
    )
    .unwrap();
    let rows = store.messages(&task.id, None).unwrap();
    assert_eq!(
        rows.iter().map(|row| row.role.as_str()).collect::<Vec<_>>(),
        ["user", "assistant", "assistant"]
    );
    assert_eq!(rows[1].content, "First response");
    assert_eq!(rows[2].content, "Second response");
}
#[test]
fn editing_a_live_goal_records_user_input_after_the_current_response_segment() {
    let (store, task) = fixture();
    store.begin_task_turn(&task.id, "First objective").unwrap();
    let assistant = Mutex::new("Working on the first objective".to_owned());
    save_agent_activity(
        &store,
        &assistant,
        &mut event(&task.id, "goal_input", "Revised objective"),
        None,
    )
    .unwrap();
    let rows = store.messages(&task.id, None).unwrap();
    assert_eq!(
        rows.iter().map(|row| row.role.as_str()).collect::<Vec<_>>(),
        ["user", "assistant", "user"]
    );
    assert_eq!(rows[2].content, "Revised objective");
    assert!(assistant.lock().unwrap().is_empty());
}
#[test]
fn paused_blocked_and_limited_goals_remain_in_progress_until_completion() {
    for status in [
        "paused",
        "blocked",
        "budgetLimited",
        "usageLimited",
        "active",
    ] {
        let (store, task) = fixture();
        store.begin_task_turn(&task.id, "Finish the task").unwrap();
        store.record_goal(&task.id, Some(&goal(status))).unwrap();
        store
            .finish_task_operation(&task.id, true, false, None)
            .unwrap();
        assert_eq!(
            store.session(&task.id).unwrap().task_stage,
            "in_progress",
            "{status}"
        );
    }
    let (store, task) = fixture();
    store.begin_task_turn(&task.id, "Finish the task").unwrap();
    store
        .record_goal(&task.id, Some(&goal("complete")))
        .unwrap();
    store
        .finish_task_operation(&task.id, true, false, None)
        .unwrap();
    assert_eq!(store.session(&task.id).unwrap().task_stage, "review");
}
#[test]
fn goal_maintenance_adds_no_user_turn_and_preserves_the_previous_stage() {
    let (store, task) = fixture();
    store
        .db
        .execute(
            "UPDATE sessions SET task_stage='pending' WHERE id=?1",
            [&task.id],
        )
        .unwrap();
    store.begin_goal_operation(&task.id).unwrap();
    store
        .finish_task_operation(&task.id, true, false, Some("pending"))
        .unwrap();
    assert!(store.messages(&task.id, None).unwrap().is_empty());
    assert_eq!(store.session(&task.id).unwrap().task_stage, "pending");
    store
        .update(&task.id, None, Some(true), None, None, None)
        .unwrap();
    assert!(store.begin_goal_operation(&task.id).is_err());
}
#[test]
fn startup_recovery_pauses_active_goals_without_losing_objective_or_budget_usage() {
    let path = std::env::temp_dir().join(format!(
        "pandacode-goal-recovery-{}.sqlite3",
        uuid::Uuid::new_v4()
    ));
    let sid;
    {
        let store = Store::open(&path).unwrap();
        let project = store.add_project(&std::env::temp_dir()).unwrap();
        let task = store
            .create_session(&project.id, "codex", "default", "ask")
            .unwrap();
        sid = task.id.clone();
        store.resume(&sid, "native-thread").unwrap();
        store.record_goal(&sid, Some(&goal("active"))).unwrap();
        store.status(&sid, "running").unwrap();
    }
    {
        let store = Store::open(&path).unwrap();
        let restored = store.session(&sid).unwrap();
        let goal = restored.goal_state.unwrap();
        assert_eq!(goal.status, "paused");
        assert_eq!(goal.objective, "Finish the task");
        assert_eq!(goal.token_budget, Some(50000));
        assert_eq!(goal.tokens_used, 1200);
        assert_eq!(goal.time_used_seconds, 30);
        assert_ne!(restored.status, "running");
    }
    let _ = std::fs::remove_file(path);
}

#[test]
fn repeated_tool_call_ids_in_automatic_turns_keep_distinct_rows() {
    let (store, task) = fixture();
    let assistant = Mutex::new(String::new());
    for turn in ["first", "second"] {
        for status in ["running", "completed"] {
            let mut activity = event(&task.id, "tool", "Command");
            activity.tool = Some(providers::ToolActivity {
                id: run_tool_id("run", turn, "same-call"),
                name: "Command".into(),
                status: status.into(),
                input: format!("Run {turn}"),
                output: format!("{turn} {status}"),
                write_paths: None,
            });
            save_agent_activity(&store, &assistant, &mut activity, None).unwrap();
        }
    }
    let messages = store.messages(&task.id, None).unwrap();
    let tools: Vec<_> = messages
        .iter()
        .filter(|message| message.role == "tool")
        .collect();
    assert_eq!(tools.len(), 2);
    assert!(tools[0].content.contains("first completed"));
    assert!(tools[1].content.contains("second completed"));
    assert_eq!(run_tool_id("run", "", "legacy"), "run:legacy");
    assert_ne!(
        run_tool_id("run-a", "same", "call"),
        run_tool_id("run-b", "same", "call")
    );
}

#[test]
fn acknowledged_normalized_settings_replace_stale_saved_presets() {
    let (store, task) = fixture();
    let assistant = Mutex::new(String::new());
    let normalized = serde_json::json!({"serviceTier":null,"collaborationMode":{"mode":"plan","settings":{"model":"new-model","reasoning_effort":"high","developer_instructions":null}}});
    let mut activity = event(&task.id, "task_settings", "");
    activity.data = Some(normalized.clone());
    save_agent_activity(&store, &assistant, &mut activity, None).unwrap();
    assert_eq!(
        store.session(&task.id).unwrap().codex_settings.unwrap(),
        normalized
    );
    activity.data = Some(serde_json::json!({"cwd":"/other/project"}));
    assert!(save_agent_activity(&store, &assistant, &mut activity, None).is_err());
}
