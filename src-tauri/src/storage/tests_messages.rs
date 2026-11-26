//! Store tests for messages: tool rows, pages and previews, handoffs, durations, responses,
//! error dismissal, context usage and nested transactions.
use super::tests_sessions::empty_session;
use super::*;

#[test]
fn tool_records_containing_reads_only_this_sessions_tool_records() {
    let (store, session) = empty_session();
    let other = store.create_session(&session.project_id, "claude", "sonnet", "auto").unwrap();
    for n in 0..5 {
        store.message(&session.id, "tool", &format!(r#"{{"type":"tool_activity","input":"/tmp/shot{n}.png"}}"#)).unwrap();
    }
    store.message(&session.id, "user", "/tmp/shot9.png").unwrap();
    store.message(&other.id, "tool", r#"{"type":"tool_activity","input":"/tmp/shot7.png"}"#).unwrap();
    let rows = store.tool_records_containing(&session.id, "shot", None, 3).unwrap();
    assert_eq!(rows.len(), 3);
    assert!(rows[0].1.contains("shot4.png"), "newest first: {rows:?}");
    // The next page starts below the oldest id of the previous one.
    let next = store.tool_records_containing(&session.id, "shot", Some(rows[2].0), 3).unwrap();
    assert_eq!(next.len(), 2);
    assert!(next[0].1.contains("shot1.png") && next[1].1.contains("shot0.png"), "{next:?}");
    assert!(store.tool_records_containing(&session.id, "shot9", None, 10).unwrap().is_empty());
    assert!(store.tool_records_containing(&session.id, "shot7", None, 10).unwrap().is_empty());
    assert_eq!(store.tool_records_containing(&other.id, "shot7", None, 10).unwrap().len(), 1);
}

#[test]
fn prompt_activity_counts_user_prompts_per_hour_and_agent() {
    let (store, task) = empty_session();
    store.message(&task.id, "user", "first").unwrap();
    store.message(&task.id, "assistant", "reply").unwrap();
    store.message(&task.id, "user", "second").unwrap();
    let activity = store.prompt_activity(0).unwrap();
    assert_eq!(activity, vec![(now() / 3_600_000, "claude".to_string(), 2)]);
    assert!(store.prompt_activity(now() + 3_600_000).unwrap().is_empty());
}

#[test]
fn dismiss_error_messages_deletes_only_this_sessions_error_rows() {
    let (store, task) = empty_session();
    let other = store
        .create_session(&task.project_id, "claude", "sonnet", "auto")
        .unwrap();
    for (sid, role) in [(&task.id, "error"), (&task.id, "error"), (&task.id, "user"), (&task.id, "assistant"), (&task.id, "tool"), (&other.id, "error")] {
        store.message(sid, role, "x").unwrap();
    }
    let rows = |sid: &str| store.messages(sid, None).unwrap();
    let mine = rows(&task.id);
    let id = |role: &str, n: usize| mine.iter().filter(|m| m.role == role).nth(n).unwrap().id;
    let (e1, e2, user, assistant, tool) = (id("error", 0), id("error", 1), id("user", 0), id("assistant", 0), id("tool", 0));
    let foreign = rows(&other.id)[0].id;
    assert_eq!(store.dismiss_error_messages(&task.id, &[user, assistant, tool, foreign, 9_999]).unwrap(), 0);
    assert_eq!(rows(&task.id).len(), 5);
    assert_eq!(store.dismiss_error_messages(&task.id, &[e1]).unwrap(), 1);
    assert_eq!(store.dismiss_error_messages(&task.id, &[e1, e2]).unwrap(), 1);
    let left: Vec<_> = rows(&task.id).iter().map(|m| m.role.clone()).collect();
    assert_eq!(left, ["user", "assistant", "tool"]);
    assert_eq!(rows(&other.id).len(), 1);
}

#[test]
fn dismiss_error_insert_message_returns_the_row_id() {
    let (store, task) = empty_session();
    let first = store.insert_message(&task.id, "error", "boom").unwrap();
    let second = store.insert_message(&task.id, "error", "boom").unwrap();
    assert!(second > first);
    let ids: Vec<i64> = store.messages(&task.id, None).unwrap().iter().map(|m| m.id).collect();
    assert_eq!(ids, [first, second]);
    assert_eq!(store.dismiss_error_messages(&task.id, &[first]).unwrap(), 1);
    let left: Vec<i64> = store.messages(&task.id, None).unwrap().iter().map(|m| m.id).collect();
    assert_eq!(left, [second]);
}

#[test]
fn dismiss_error_messages_handles_empty_and_oversized_lists() {
    let (store, task) = empty_session();
    store.message(&task.id, "error", "x").unwrap();
    assert_eq!(store.dismiss_error_messages(&task.id, &[]).unwrap(), 0);
    let too_many: Vec<i64> = (0..=MAX_DISMISS_ERROR_IDS as i64).collect();
    assert!(store.dismiss_error_messages(&task.id, &too_many).is_err());
    assert_eq!(store.messages(&task.id, None).unwrap().len(), 1);
}

#[test]
fn dismiss_error_messages_never_deletes_a_mirrored_copy() {
    // A mirror's rows are copies of another computer's; the backfill could copy a deleted one back.
    let (store, task) = empty_session();
    let id = store.insert_message(&task.id, "error", "boom").unwrap();
    store.db.execute("UPDATE sessions SET remote_device='dev',remote_session='host-task' WHERE id=?1", [&task.id]).unwrap();
    assert_eq!(store.dismiss_error_messages(&task.id, &[id]).unwrap(), 0);
    assert_eq!(store.messages(&task.id, None).unwrap().len(), 1);
}

#[test]
fn context_usage_accepts_only_bounded_current_usage_metadata() {
    use serde_json::json;
    assert_eq!(
        ContextUsage::from_value(&json!({"usedTokens": 64_000, "contextWindow": 200_000})),
        Some(ContextUsage {
            used_tokens: 64_000,
            context_window: Some(200_000)
        })
    );
    assert_eq!(
        ContextUsage::from_value(&json!({"usedTokens": 0, "contextWindow": null})),
        Some(ContextUsage {
            used_tokens: 0,
            context_window: None
        })
    );
    assert!(ContextUsage::from_value(&json!({"usedTokens": 100})).is_some());
    for invalid in [
        json!({"totalTokens": 100}),
        json!({"usedTokens": -1}),
        json!({"usedTokens": 1.5}),
        json!({"usedTokens": "100"}),
        json!({"usedTokens": 1_000_000_001u64}),
        json!({"usedTokens": 100, "contextWindow": 0}),
        json!({"usedTokens": 100, "contextWindow": -1}),
        json!({"usedTokens": 100, "contextWindow": 1_000_000_001u64}),
        json!({"usedTokens": 100, "contextWindow": "200000"}),
    ] {
        assert!(ContextUsage::from_value(&invalid).is_none(), "{invalid}");
    }
    // Even externally corrupted signed values must never become enormous
    // unsigned counts when a saved task is read.
    let (store, session) = empty_session();
    store
        .db
        .execute_batch("PRAGMA ignore_check_constraints=ON;")
        .unwrap();
    for (used, window) in [(-1, 200_000), (100, -1), (100, 0)] {
        store
            .db
            .execute(
                "UPDATE sessions SET context_used_tokens=?2,context_window=?3 WHERE id=?1",
                params![session.id, used, window],
            )
            .unwrap();
        assert!(store.session(&session.id).unwrap().context_usage.is_none());
    }
}

#[test]
fn reasoning_and_context_reset_only_for_changed_model_or_provider() {
    let (store, session) = empty_session();
    let usage = ContextUsage {
        used_tokens: 1234,
        context_window: Some(200_000),
    };
    store
        .set_reasoning_effort(&session.id, Some(" high "))
        .unwrap();
    store.record_context_usage(&session.id, &usage).unwrap();
    let unchanged = store
        .configure(&session.id, "claude", "sonnet", None)
        .unwrap();
    assert_eq!(unchanged.reasoning_effort.as_deref(), Some("high"));
    assert_eq!(unchanged.context_usage.as_ref(), Some(&usage));
    store
        .update(
            &session.id,
            Some("Renamed".into()),
            None,
            Some("sonnet".into()),
            Some("plan".into()),
        )
        .unwrap();
    let renamed = store.session(&session.id).unwrap();
    assert_eq!(renamed.reasoning_effort.as_deref(), Some("high"));
    assert_eq!(renamed.context_usage.as_ref(), Some(&usage));
    let different_model = store
        .configure(&session.id, "claude", "opus", None)
        .unwrap();
    assert!(different_model.reasoning_effort.is_none());
    assert!(different_model.context_usage.is_none());
    store
        .set_reasoning_effort(&session.id, Some("high"))
        .unwrap();
    store.record_context_usage(&session.id, &usage).unwrap();
    store
        .update(&session.id, None, None, Some("sonnet".into()), None)
        .unwrap();
    let updated_model = store.session(&session.id).unwrap();
    assert!(updated_model.reasoning_effort.is_none());
    assert!(updated_model.context_usage.is_none());
    store
        .set_reasoning_effort(&session.id, Some("high"))
        .unwrap();
    store.record_context_usage(&session.id, &usage).unwrap();
    let different_provider = store
        .configure(&session.id, "codex", "sonnet", None)
        .unwrap();
    assert!(different_provider.reasoning_effort.is_none());
    assert!(different_provider.context_usage.is_none());
    assert_eq!(different_provider.mode, "plan");
    store
        .set_reasoning_effort(&session.id, Some("high"))
        .unwrap();
    assert!(store
        .set_reasoning_effort(&session.id, Some("  "))
        .unwrap()
        .reasoning_effort
        .is_none());
    assert!(store
        .set_reasoning_effort(&session.id, Some("invalid effort"))
        .is_err());
    assert!(store.set_reasoning_effort("missing", None).is_err());
}

#[test]
fn turn_duration_is_scoped_to_its_user_message_and_never_overwritten() {
    let (store, task) = empty_session();
    let other = store
        .create_session(&task.project_id, "codex", "default", "ask")
        .unwrap();
    let first = store.start_turn_message(&task.id, "First turn").unwrap();
    let unrelated = store.start_turn_message(&other.id, "Other task").unwrap();
    store
        .message(&task.id, "assistant", "First response")
        .unwrap();
    let second = store.start_turn_message(&task.id, "Second turn").unwrap();
    // A provider error or cancellation can leave tool/error activity as the
    // latest row. Completion must still update the captured initiating ID.
    store.message(&task.id, "tool", "Tool activity").unwrap();
    store
        .message(&task.id, "error", "Provider stopped")
        .unwrap();
    let metadata = serde_json::to_value(store.session(&task.id).unwrap()).unwrap();
    store.finish_turn(&task.id, first, 83_456).unwrap();
    store.finish_turn(&task.id, first, 1).unwrap();
    let messages = store.messages(&task.id, None).unwrap();
    assert_eq!(messages.len(), 5);
    assert_eq!(messages[0].id, first);
    assert_eq!(messages[0].turn_duration_ms, Some(83_456));
    assert!(messages[1..]
        .iter()
        .all(|message| message.turn_duration_ms.is_none()));
    assert_eq!(
        serde_json::to_value(&messages[0]).unwrap()["turnDurationMs"],
        83_456
    );
    assert_eq!(
        serde_json::to_value(store.session(&task.id).unwrap()).unwrap(),
        metadata
    );
    assert!(store.finish_turn(&other.id, first, 10).is_err());
    assert!(store.finish_turn(&task.id, unrelated, 10).is_err());
    assert!(store.finish_turn(&task.id, messages[1].id, 10).is_err());
    assert!(store.finish_turn(&task.id, second, -1).is_err());
    assert!(store.messages(&other.id, None).unwrap()[0]
        .turn_duration_ms
        .is_none());
    store.finish_turn(&task.id, second, 0).unwrap();
    assert_eq!(
        store.messages(&task.id, None).unwrap()[2].turn_duration_ms,
        Some(0)
    );
}

#[test]
fn message_page_only_reports_earlier_history_in_its_own_task() {
    let (store, other) = empty_session();
    store
        .message(&other.id, "user", "Unrelated history")
        .unwrap();
    let task = store
        .create_session(&other.project_id, "claude", "sonnet", "ask")
        .unwrap();
    let empty = store.message_page(&task.id, None).unwrap();
    assert!(empty.messages.is_empty());
    assert!(!empty.has_older);
    store.message(&task.id, "user", "A new task").unwrap();
    store.message(&task.id, "assistant", "A response").unwrap();
    let page = store.message_page(&task.id, None).unwrap();
    assert_eq!(page.messages.len(), 2);
    assert!(page.messages[0].id > 1);
    assert!(!page.has_older);
    let exhausted = store
        .message_page(&task.id, Some(page.messages[0].id))
        .unwrap();
    assert!(exhausted.messages.is_empty());
    assert!(!exhausted.has_older);
    assert_eq!(serde_json::to_value(page).unwrap()["hasOlder"], false);
    assert!(store.message_page("missing", None).is_err());
}

#[test]
fn message_page_distinguishes_full_and_incomplete_pages_with_interleaved_tasks() {
    let (store, other) = empty_session();
    let task = store
        .create_session(&other.project_id, "claude", "sonnet", "ask")
        .unwrap();
    for i in 0..100 {
        store.message(&other.id, "user", "Other task").unwrap();
        store
            .message(&task.id, "assistant", &format!("message {i}"))
            .unwrap();
    }
    let complete = store.message_page(&task.id, None).unwrap();
    assert_eq!(complete.messages.len(), 100);
    assert_eq!(complete.messages[0].content, "message 0");
    assert!(!complete.has_older);

    store.message(&task.id, "assistant", "message 100").unwrap();
    let recent = store.message_page(&task.id, None).unwrap();
    assert_eq!(recent.messages.len(), 100);
    assert_eq!(recent.messages[0].content, "message 1");
    assert!(recent.has_older);
    assert!(recent
        .messages
        .iter()
        .all(|message| message.session_id == task.id));
    let oldest = store
        .message_page(&task.id, Some(recent.messages[0].id))
        .unwrap();
    assert_eq!(oldest.messages.len(), 1);
    assert_eq!(oldest.messages[0].content, "message 0");
    assert!(!oldest.has_older);
}

#[test]
fn message_pages_preserve_authors_across_off_page_handoffs_and_other_tasks() {
    let (store, task) = empty_session();
    store.message(&task.id, "assistant", "Claude response").unwrap();
    let claude_id = store.db.last_insert_rowid();
    let other = store.create_session(&task.project_id, "grok", "default", "ask").unwrap();
    store.message(&other.id, "assistant", "Another task").unwrap();
    store.configure(&other.id, "mimo", "default", None).unwrap();
    // The next switch is farther away than any message page.
    for _ in 0..110 { store.message(&task.id, "tool", "Completed").unwrap(); }
    store.configure(&task.id, "codex", "default", None).unwrap();
    store.message(&task.id, "assistant", "Codex response").unwrap();
    let codex_id = store.db.last_insert_rowid();
    store.configure(&task.id, "kimi", "default", None).unwrap();
    store.message(&task.id, "assistant", "Kimi response").unwrap();
    let recent = serde_json::to_value(store.message_page(&task.id, None).unwrap()).unwrap();
    let recent = recent["messages"].as_array().unwrap();
    assert_eq!(recent.iter().find(|m| m["id"] == codex_id).unwrap()["authorProvider"], "codex");
    assert_eq!(recent.last().unwrap()["authorProvider"], "kimi");
    let old = serde_json::to_value(store.message_page(&task.id, Some(claude_id + 1)).unwrap()).unwrap();
    assert_eq!(old["messages"].as_array().unwrap().len(), 1);
    assert_eq!(old["messages"][0]["authorProvider"], "claude");
    let unrelated = serde_json::to_value(store.message_page(&other.id, None).unwrap()).unwrap();
    assert_eq!(unrelated["messages"][0]["authorProvider"], "grok");
}

#[test]
fn failed_handoff_notice_rolls_back_context_and_provider_together() {
    let (store, task) = empty_session();
    let task = store.configure(&task.id, "codex", "default", None).unwrap();
    store.message(&task.id, "user", "Keep this conversation").unwrap();
    store.message(&task.id, "assistant", "Saved response").unwrap();
    store.resume(&task.id, "original-native-session").unwrap();
    store.record_goal(&task.id, Some(&crate::goal_state::GoalState {
        thread_id: "original-native-session".into(), objective: "Finish the original work".into(),
        status: "paused".into(), token_budget: Some(10_000), tokens_used: 500,
        time_used_seconds: 20, created_at: 1, updated_at: 2,
    })).unwrap();
    store.db.execute("UPDATE sessions SET codex_settings=?2 WHERE id=?1", params![task.id, r#"{"personality":"friendly"}"#]).unwrap();
    let before = serde_json::to_value(store.session(&task.id).unwrap()).unwrap();
    let history = serde_json::to_value(store.messages(&task.id, None).unwrap()).unwrap();
    store.db.execute_batch("CREATE TRIGGER reject_handoff BEFORE INSERT ON messages WHEN NEW.role='handoff' BEGIN SELECT RAISE(ABORT,'injected notice failure'); END;").unwrap();
    assert!(store.configure(&task.id, "kimi", "default", None).unwrap_err().contains("injected notice failure"));
    let restored = store.session(&task.id).unwrap();
    assert_eq!(serde_json::to_value(&restored).unwrap(), before);
    assert_eq!(serde_json::to_value(store.messages(&task.id, None).unwrap()).unwrap(), history);
    assert!(!crate::context_recovery::pending(&store, &restored).unwrap());
    store.db.execute_batch("DROP TRIGGER reject_handoff;").unwrap();
    let switched = store.configure(&task.id, "kimi", "default", None).unwrap();
    assert!(switched.resume_id.is_none());
    assert!(switched.goal_state.is_none());
    assert!(switched.codex_settings.is_none());
    assert!(crate::context_recovery::pending(&store, &switched).unwrap());
}

#[test]
fn tool_updates_share_one_message_and_preserve_response_activity() {
    let (store, session) = empty_session();
    let started = r#"{"type":"tool_activity","version":1,"id":"call-1","name":"Bash","status":"running","input":"pwd","output":""}"#;
    let completed = r#"{"type":"tool_activity","version":1,"id":"call-1","name":"Bash","status":"completed","input":"pwd","output":"/tmp/project"}"#;
    store
        .tool_message(&session.id, "turn-1:call-1", started)
        .unwrap();
    let first = store.messages(&session.id, None).unwrap().remove(0);
    store
        .tool_message(&session.id, "turn-1:call-1", completed)
        .unwrap();
    let messages = store.messages(&session.id, None).unwrap();
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].id, first.id);
    assert_eq!(messages[0].created_at, first.created_at);
    assert_eq!(messages[0].content, completed);
    assert_eq!(messages[0].role, "tool");
    assert_eq!(store.session(&session.id).unwrap().last_response_at, None);
    // Some providers reuse call IDs in later turns; the native run prefix isolates them.
    store
        .tool_message(&session.id, "turn-2:call-1", started)
        .unwrap();
    assert_eq!(store.messages(&session.id, None).unwrap().len(), 2);
    assert!(store.tool_message(&session.id, "", completed).is_err());
    assert!(store
        .tool_message(&session.id, "turn-1:huge", &"x".repeat(96 * 1024 + 1))
        .is_err());
}

#[test]
fn tool_details_survive_restart_without_changing_legacy_rows() {
    let dir = std::env::temp_dir().join(format!("pandacode-tools-{}", id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("store.db");
    let sid;
    {
        let store = Store::open(&path).unwrap();
        let project = store.add_project(&dir).unwrap();
        sid = store
            .create_session(&project.id, "claude", "sonnet", "ask")
            .unwrap()
            .id;
        store.message(&sid, "tool", "Read").unwrap();
        store
            .tool_message(&sid, "run:read", "Read\n/tmp/README.md")
            .unwrap();
    }
    {
        let store = Store::open(&path).unwrap();
        store
            .tool_message(&sid, "run:read", "Read\n/tmp/README.md\nFile contents")
            .unwrap();
        let messages = store.messages(&sid, None).unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].content, "Read");
        assert_eq!(messages[1].content, "Read\n/tmp/README.md\nFile contents");
    }
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn unfinished_tools_settle_on_turn_end_and_restart() {
    let dir = std::env::temp_dir().join(format!("pandacode-interrupted-tools-{}", id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("store.db");
    let sid;
    let running = r#"{"type":"tool_activity","version":1,"id":"run:read","name":"Read","status":"running","input":"README.md","output":"partial output"}"#;
    let completed = r#"{"type":"tool_activity","version":1,"id":"run:done","name":"Bash","status":"completed","input":"pwd","output":"/tmp"}"#;
    {
        let store = Store::open(&path).unwrap();
        let project = store.add_project(&dir).unwrap();
        sid = store
            .create_session(&project.id, "claude", "sonnet", "ask")
            .unwrap()
            .id;
        store.status(&sid, "running").unwrap();
        store.tool_message(&sid, "run:read", running).unwrap();
        store.tool_message(&sid, "run:done", completed).unwrap();
        store.message(&sid, "tool", "Read").unwrap();
    }
    {
        let store = Store::open(&path).unwrap();
        assert_eq!(store.session(&sid).unwrap().status, "interrupted");
        let messages = store.messages(&sid, None).unwrap();
        let tool: serde_json::Value = serde_json::from_str(&messages[0].content).unwrap();
        assert_eq!(tool["status"], "failed");
        assert_eq!(tool["input"], "README.md");
        assert!(tool["output"].as_str().unwrap().contains("partial output"));
        assert!(tool["output"].as_str().unwrap().contains("interrupted"));
        assert_eq!(messages[1].content, completed);
        assert_eq!(messages[2].content, "Read");
        store.tool_message(&sid, "run:read", running).unwrap();
        store
            .tool_message(&sid, "run:malformed", "{bad json")
            .unwrap();
        store.finish_tools(&sid).unwrap();
        let messages = store.messages(&sid, None).unwrap();
        let tool: serde_json::Value = serde_json::from_str(&messages[0].content).unwrap();
        assert_eq!(tool["status"], "failed");
        assert!(tool["output"].as_str().unwrap().contains("turn ended"));
        assert_eq!(messages[3].content, "{bad json");
        assert_eq!(store.session(&sid).unwrap().last_response_at, None);
    }
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn user_prompt_activity_is_saved_before_any_agent_response() {
    let (store, session) = empty_session();
    let before = now();
    store.begin_task_turn(&session.id, "Start immediately").unwrap();
    let saved = serde_json::to_value(store.session(&session.id).unwrap()).unwrap();
    assert!(saved["lastPromptAt"].as_i64().is_some_and(|time| time >= before));
    assert!(saved["lastResponseAt"].is_null());
    let prompt_at = saved["lastPromptAt"].clone();
    store.finish_task_turn(&session.id, true, false).unwrap();
    store.begin_task_turn_with_kind(&session.id, "Internal worker check", Some(crate::architect::internal_turns::CoordinationKind::WorkerUpdate)).unwrap();
    store.message(&session.id, "tool", "Tool output").unwrap();
    store.update(&session.id, Some("Renamed".into()), None, None, None).unwrap();
    let saved = serde_json::to_value(store.sessions().unwrap().remove(0)).unwrap();
    assert_eq!(saved["lastPromptAt"], prompt_at);
}

#[test]
fn last_response_only_tracks_nonempty_assistant_messages() {
    let (store, session) = empty_session();
    assert_eq!(session.last_response_at, None);
    for role in ["user", "tool", "status", "error"] {
        store.message(&session.id, role, "Activity").unwrap();
    }
    store.message(&session.id, "assistant", "").unwrap();
    assert_eq!(store.session(&session.id).unwrap().last_response_at, None);
    store
        .message(&session.id, "assistant", "A response")
        .unwrap();
    let sent = store
        .messages(&session.id, None)
        .unwrap()
        .last()
        .unwrap()
        .created_at;
    assert_eq!(
        store.session(&session.id).unwrap().last_response_at,
        Some(sent)
    );
    for role in ["user", "tool", "status", "error"] {
        store.message(&session.id, role, "Later activity").unwrap();
    }
    store.message(&session.id, "assistant", "").unwrap();
    assert_eq!(store.sessions().unwrap()[0].last_response_at, Some(sent));
    assert_eq!(
        serde_json::to_value(store.session(&session.id).unwrap()).unwrap()["lastResponseAt"],
        sent
    );
}

#[test]
fn last_response_does_not_move_on_metadata_edits() {
    let (store, session) = empty_session();
    store
        .message(&session.id, "assistant", "A response")
        .unwrap();
    let response = store.session(&session.id).unwrap().last_response_at;
    store
        .db
        .execute(
            "UPDATE sessions SET updated_at=0 WHERE id=?1",
            [&session.id],
        )
        .unwrap();
    store
        .update(
            &session.id,
            Some("Renamed".into()),
            Some(true),
            Some("opus".into()),
            Some("ask".into()),
        )
        .unwrap();
    store
        .configure(&session.id, "claude", "haiku", None)
        .unwrap();
    store.resume(&session.id, "remote-session").unwrap();
    store.status(&session.id, "idle").unwrap();
    let updated = store.session(&session.id).unwrap();
    assert!(updated.updated_at > 0);
    assert_eq!(updated.last_response_at, response);
}

#[test]
fn assistant_preview_limits_preserve_exact_fit_and_embedded_nul() {
    let (store, task) = empty_session();
    let exact = [
        "a".repeat(128 * 1024),
        "🌿".repeat(32 * 1024),
        "Before\0after".into(),
        String::new(),
    ];
    for content in &exact {
        store.message(&task.id, "assistant", content).unwrap();
    }
    let page = store.message_page(&task.id, None).unwrap();
    assert!(!page.has_older);
    for (message, original) in page.messages.iter().zip(&exact) {
        assert_eq!(&message.content, original);
    }
    store
        .message(&task.id, "assistant", &"a".repeat(128 * 1024 + 1))
        .unwrap();
    let page = store.message_page(&task.id, None).unwrap();
    assert_eq!(page.messages.last().unwrap().content.len(), 128 * 1024);
    assert!(page
        .messages
        .last()
        .unwrap()
        .content
        .contains("Message preview truncated"));
}

#[test]
fn assistant_previews_bound_allocation_without_mutating_history() {
    let (store, task) = empty_session();
    for index in 0..101 {
        store
            .message(&task.id, "assistant", &format!("Earlier {index}"))
            .unwrap();
    }
    let originals = [
        "a".repeat(8 * 1024 * 1024),
        format!("🌿\0b{}", "🌿".repeat(2 * 1024 * 1024)),
    ];
    for content in &originals {
        store.message(&task.id, "assistant", content).unwrap();
    }
    let kind = crate::architect::internal_turns::CoordinationKind::WorkerReview;
    let coordination =
        crate::architect::internal_turns::encode(kind, &"\0".repeat(48 * 1024)).unwrap();
    assert!(coordination.len() > 128 * 1024);
    store
        .message(&task.id, "coordination", &coordination)
        .unwrap();
    let page = store.message_page(&task.id, None).unwrap();
    assert!(page.has_older);
    assert_eq!(page.messages.len(), 100);
    let marker = "\n\n[Message preview truncated at 128 KiB. The provider retains the complete conversation.]";
    for (message, original) in page
        .messages
        .iter()
        .rev()
        .skip(1)
        .take(2)
        .zip(originals.iter().rev())
    {
        assert_eq!(message.role, "assistant");
        assert!(message.content.len() <= 128 * 1024);
        assert!(message.content.ends_with(marker));
        assert!(original.starts_with(message.content.strip_suffix(marker).unwrap()));
        // The preview must not retain the full saved response allocation,
        // even with Unicode or embedded NUL in the stored reply.
        assert!(
            message.content.capacity() <= 2 * (128 * 1024 + 4),
            "retained {} bytes",
            message.content.capacity()
        );
        let saved: String = store
            .db
            .query_row(
                "SELECT content FROM messages WHERE id=?1",
                [message.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(&saved, original);
    }
    let internal = page.messages.last().unwrap();
    assert_eq!(internal.coordination_kind, Some(kind));
    assert_eq!(internal.content, "Reviewing worker results");
    let oldest = page.messages.first().unwrap().id;
    let earlier = store.message_page(&task.id, Some(oldest)).unwrap();
    assert!(!earlier.has_older);
    assert_eq!(earlier.messages.len(), 4);
    assert_eq!(earlier.messages.last().unwrap().id + 1, oldest);
}

#[test]
fn transcript_pages_have_a_byte_budget_and_do_not_skip_history() {
    let store = Store::open(Path::new(":memory:")).unwrap();
    let p = store.add_project(&std::env::temp_dir()).unwrap();
    let s = store
        .create_session(&p.id, "claude", "default", "ask")
        .unwrap();
    for _ in 0..30 {
        store
            .message(&s.id, "assistant", &"é".repeat(100_000))
            .unwrap();
    }
    let page = store.message_page(&s.id, None).unwrap();
    assert!(page.has_older);
    let recent = page.messages;
    assert!(recent.iter().map(|m| m.content.len()).sum::<usize>() <= 2 * 1024 * 1024);
    assert!(recent.iter().all(|m| m.content.len() <= 128 * 1024));
    assert!(recent.len() < 30);
    let older = store.message_page(&s.id, Some(recent[0].id)).unwrap();
    assert_eq!(older.messages.last().unwrap().id + 1, recent[0].id);
    assert_eq!(older.messages.len() + recent.len(), 30);
    assert!(!older.has_older);
}

#[test]
fn persists_resume_and_pages_messages_across_restart() {
    let dir = std::env::temp_dir().join(format!("pandacode-db-{}", id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("test.db");
    let sid;
    {
        let store = Store::open(&path).unwrap();
        let p = store.add_project(&dir).unwrap();
        assert_eq!(store.add_project(&dir).unwrap().id, p.id);
        let s = store.create_session(&p.id, "codex", "", "ask").unwrap();
        sid = s.id;
        store.resume(&sid, "provider-session-1").unwrap();
        store.status(&sid, "running").unwrap();
        for i in 0..125 {
            store
                .message(&sid, "assistant", &format!("message {i}"))
                .unwrap();
        }
    }
    {
        let store = Store::open(&path).unwrap();
        let s = store.session(&sid).unwrap();
        assert_eq!(s.status, "interrupted");
        assert_eq!(s.resume_id.as_deref(), Some("provider-session-1"));
        let page = store.messages(&sid, None).unwrap();
        assert_eq!(page.len(), 100);
        assert_eq!(page[0].content, "message 25");
        let older = store.messages(&sid, Some(page[0].id)).unwrap();
        assert_eq!(older.len(), 25);
        assert_eq!(older[24].content, "message 24");
    }
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn nested_in_transaction_rolls_back_only_its_own_writes() {
    let (store, _task) = empty_session();
    store.db.execute_batch("CREATE TABLE nested_probe(step TEXT NOT NULL)").unwrap();
    let insert = |step: &str| store.db.execute("INSERT INTO nested_probe(step) VALUES (?1)", [step]).map(|_| ()).map_err(|e| e.to_string());
    store
        .in_transaction(|| {
            insert("outer-before")?;
            let nested: Result<()> = store.in_transaction(|| {
                insert("nested-partial")?;
                Err("nested failed".into())
            });
            assert_eq!(nested, Err("nested failed".into()));
            assert!(!store.db.is_autocommit(), "the outer transaction stays open");
            store.in_transaction(|| insert("nested-ok"))?;
            insert("outer-after")
        })
        .unwrap();
    let mut statement = store.db.prepare("SELECT step FROM nested_probe ORDER BY rowid").unwrap();
    let steps: Vec<String> = statement.query_map([], |r| r.get(0)).unwrap().collect::<rusqlite::Result<_>>().unwrap();
    assert_eq!(steps, ["outer-before", "nested-ok", "outer-after"]);
    assert!(store.db.is_autocommit());
    let immediate: Result<()> = store.in_transaction_immediate(|| {
        insert("immediate-partial")?;
        Err("immediate failed".into())
    });
    assert!(immediate.is_err());
    let count: i64 = store.db.query_row("SELECT COUNT(*) FROM nested_probe WHERE step='immediate-partial'", [], |r| r.get(0)).unwrap();
    assert_eq!(count, 0, "a standalone failure rolls back its own transaction");
}
