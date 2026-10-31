use super::*;
use crate::storage::{self, Message};
use serde_json::json;
use std::path::Path;

fn fixture(provider: &str) -> (Store, Session) {
    let store = Store::open(Path::new(":memory:")).unwrap();
    let project = store.add_project(&std::env::temp_dir()).unwrap();
    let source = store
        .create_session(&project.id, provider, "test-model", "full")
        .unwrap();
    (store, source)
}

fn append(store: &Store, sid: &str, role: &str, content: &str) -> i64 {
    store.message(sid, role, content).unwrap();
    store.db.last_insert_rowid()
}

fn all_messages(store: &Store, sid: &str) -> Vec<Message> {
    let mut all = Vec::new();
    let mut before = None;
    loop {
        let page = store.message_page(sid, before).unwrap();
        before = page.messages.first().map(|m| m.id);
        all.splice(0..0, page.messages);
        if !page.has_older {
            return all;
        }
    }
}

#[test]
fn saved_message_content_is_complete_read_only_and_task_scoped() {
    let (store, source) = fixture("claude");
    let other = store
        .create_session(&source.project_id, "codex", "model", "ask")
        .unwrap();
    for role in ["user", "assistant"] {
        let content = format!(
            "# Original markdown\n{}\0\nLAST LINE\n",
            "🌿 `exact text`\n".repeat(20_000)
        );
        let message_id = append(&store, &source.id, role, &content);
        let before = serde_json::to_value(store.session(&source.id).unwrap()).unwrap();
        assert_eq!(
            store.message_content(&source.id, message_id).unwrap(),
            content
        );
        assert!(store.message_content(&other.id, message_id).is_err());
        assert_eq!(
            before,
            serde_json::to_value(store.session(&source.id).unwrap()).unwrap()
        );
        assert!(
            store
                .messages(&source.id, None)
                .unwrap()
                .iter()
                .find(|m| m.id == message_id)
                .unwrap()
                .content
                .len()
                < content.len()
        );
    }
    for role in ["tool", "system", "coordination", "internal", "changes"] {
        let message_id = append(&store, &source.id, role, "Private or non-conversation text");
        assert!(store.message_content(&source.id, message_id).is_err());
    }
    for missing in [-1, 0, i64::MAX] {
        assert!(store.message_content(&source.id, missing).is_err());
    }
    assert!(store.message_content("missing-task", 1).is_err());
}

#[test]
fn edit_forks_stop_before_the_message_and_start_a_fresh_harness_session() {
    let (store, source) = fixture("claude");
    store.resume(&source.id, "native-source").unwrap();
    append(&store, &source.id, "user", "First request");
    append(&store, &source.id, "assistant", "First response");
    let mistake = append(&store, &source.id, "user", "Mistaken request");
    append(&store, &source.id, "assistant", "Mistaken response");
    let fork = before_message(&store, &source.id, mistake).unwrap();
    assert_eq!(fork.resume_id, None);
    let copied: Vec<_> = all_messages(&store, &fork.id).into_iter().map(|m| m.content).collect();
    assert_eq!(copied, ["First request", "First response"]);
    assert_eq!(all_messages(&store, &source.id).len(), 4);
    let first = all_messages(&store, &source.id)[0].id;
    assert!(all_messages(&store, &before_message(&store, &source.id, first).unwrap().id).is_empty());
}

#[test]
fn forks_before_handoffs_keep_historical_authors_and_the_current_harness() {
    let (store, source) = fixture("claude");
    append(&store, &source.id, "user", "Original request");
    let boundary = append(&store, &source.id, "assistant", "Original Claude response");
    for _ in 0..110 { append(&store, &source.id, "tool", "Later activity"); }
    store.configure(&source.id, "codex", "default", None).unwrap();
    append(&store, &source.id, "assistant", "Later Codex response");
    let fork = at_message(&store, &source.id, boundary).unwrap();
    assert_eq!(fork.provider, "codex");
    let copied = all_messages(&store, &fork.id);
    assert_eq!(copied[1].content, "Original Claude response");
    assert_eq!(serde_json::to_value(&copied[1]).unwrap()["authorProvider"], "claude");
    assert!(!copied.iter().any(|m| m.content == "Later Codex response"));
    assert_eq!(copied.last().unwrap().role, "handoff");
    append(&store, &fork.id, "assistant", "New Codex response");
    assert_eq!(serde_json::to_value(all_messages(&store, &fork.id).last().unwrap()).unwrap()["authorProvider"], "codex");
    let nested = at_message(&store, &fork.id, copied[1].id).unwrap();
    assert_eq!(nested.provider, "codex");
    assert_eq!(serde_json::to_value(&all_messages(&store, &nested.id)[1]).unwrap()["authorProvider"], "claude");
}

#[test]
fn inclusive_forks_are_isolated_complete_and_repeatable_across_pages() {
    let (store, source) = fixture("codex");
    let mut boundary = 0;
    for n in 0..230 {
        let id = append(
            &store,
            &source.id,
            if n % 2 == 0 { "user" } else { "assistant" },
            &format!("message {n}"),
        );
        if n == 204 {
            boundary = id;
        }
    }
    let before = serde_json::to_value(store.session(&source.id).unwrap()).unwrap();
    let fork = at_message(&store, &source.id, boundary).unwrap();
    let copied = all_messages(&store, &fork.id);
    assert_eq!(copied.len(), 205);
    assert_eq!(copied.first().unwrap().content, "message 0");
    assert_eq!(copied.last().unwrap().content, "message 204");
    assert!(copied
        .iter()
        .all(|m| m.session_id == fork.id && m.id > boundary));
    assert_eq!(store.projects().unwrap().len(), 1);
    assert_eq!(
        before,
        serde_json::to_value(store.session(&source.id).unwrap()).unwrap()
    );
    assert_eq!(all_messages(&store, &source.id).len(), 230);

    let sibling = at_message(&store, &source.id, boundary).unwrap();
    assert_ne!(fork.id, sibling.id);
    let nested = at_message(&store, &fork.id, copied[1].id).unwrap();
    let nested_messages = all_messages(&store, &nested.id);
    assert_eq!(nested_messages.len(), 2);
    assert_eq!(nested_messages[1].role, "assistant");
    append(&store, &fork.id, "user", "Only in one fork");
    assert_eq!(all_messages(&store, &sibling.id).len(), 205);
    assert_eq!(all_messages(&store, &source.id).len(), 230);
}

#[test]
fn each_harness_recovers_only_the_prefix_including_a_first_user_boundary() {
    for provider in ["codex", "claude", "kimi", "opencode", "glm", "antigravity", "grok", "mimo"] {
        let (store, source) = fixture(provider);
        let first = append(
            &store,
            &source.id,
            "user",
            "Use the attached plan: /tmp/attachments/plan.png",
        );
        append(&store, &source.id, "assistant", "EXCLUDED_FUTURE_ANSWER");
        store
            .resume(&source.id, "source-provider-future-context")
            .unwrap();
        let fork = at_message(&store, &source.id, first).unwrap();
        assert_eq!(fork.provider, provider);
        assert_eq!(fork.resume_id, None);
        let (prompt, boundary) =
            crate::context_recovery::prepare(&store, &fork, "Implement that plan").unwrap();
        assert!(prompt.contains("Use the attached plan: /tmp/attachments/plan.png"));
        assert!(!prompt.contains("EXCLUDED_FUTURE_ANSWER"));
        assert!(prompt.ends_with("Current request:\nImplement that plan"));
        assert_eq!(boundary, Some(all_messages(&store, &fork.id)[0].id));
        // Receiving a new ID before a failed launch must not discard recovery.
        store.resume(&fork.id, "fork-provider-context").unwrap();
        let restarted = store.session(&fork.id).unwrap();
        assert!(crate::context_recovery::pending(&store, &restarted).unwrap());
        let (retry, _) = crate::context_recovery::prepare(&store, &restarted, "Try again").unwrap();
        assert!(retry.contains("Use the attached plan"));
        crate::context_recovery::acknowledge(&store, &fork.id, boundary.unwrap()).unwrap();
        assert!(!crate::context_recovery::pending(&store, &restarted).unwrap());
        assert_eq!(
            store.session(&source.id).unwrap().resume_id.as_deref(),
            Some("source-provider-future-context")
        );
    }
}

#[test]
fn copies_full_saved_response_and_keeps_a_bounded_context_handoff() {
    let (store, source) = fixture("claude");
    append(&store, &source.id, "user", "Original question");
    let response = format!("{}\nEND_OF_FULL_RESPONSE", "🌿 Rust ".repeat(20_000));
    let boundary = append(&store, &source.id, "assistant", &response);
    assert!(store.messages(&source.id, None).unwrap()[1].content.len() < response.len());
    let fork = at_message(&store, &source.id, boundary).unwrap();
    let saved: String = store
        .db
        .query_row(
            "SELECT content FROM messages WHERE session_id=?1 AND role='assistant'",
            [&fork.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(saved, response);
    let (prompt, _) = crate::context_recovery::prepare(&store, &fork, "Continue").unwrap();
    assert!(prompt.contains("bounded excerpt"));
    assert!(prompt.len() < 66 * 1024);
}

#[test]
fn fork_history_and_pending_context_survive_restart_without_resuming_source() {
    let root = std::env::temp_dir().join(format!("pandacode-fork-restart-{}", storage::id()));
    std::fs::create_dir_all(&root).unwrap();
    let path = root.join("state.sqlite");
    let (source_id, fork_id);
    {
        let store = Store::open(&path).unwrap();
        let project = store.add_project(&root).unwrap();
        let source = store
            .create_session(&project.id, "codex", "model", "ask")
            .unwrap();
        let boundary = append(&store, &source.id, "assistant", "Remember this answer");
        append(&store, &source.id, "user", "Later source-only request");
        store.resume(&source.id, "source-context").unwrap();
        fork_id = at_message(&store, &source.id, boundary).unwrap().id;
        source_id = source.id;
    }
    {
        let store = Store::open(&path).unwrap();
        let fork = store.session(&fork_id).unwrap();
        assert!(fork.resume_id.is_none());
        let (prompt, boundary) =
            crate::context_recovery::prepare(&store, &fork, "Continue").unwrap();
        assert!(prompt.contains("Remember this answer"));
        assert!(!prompt.contains("Later source-only request"));
        assert_eq!(all_messages(&store, &fork_id).len(), 1);
        assert_eq!(
            store.session(&source_id).unwrap().resume_id.as_deref(),
            Some("source-context")
        );
        store.resume(&fork_id, "fork-context").unwrap();
        crate::context_recovery::acknowledge(&store, &fork_id, boundary.unwrap()).unwrap();
    }
    {
        let store = Store::open(&path).unwrap();
        let fork = store.session(&fork_id).unwrap();
        assert_eq!(fork.resume_id.as_deref(), Some("fork-context"));
        assert!(!crate::context_recovery::pending(&store, &fork).unwrap());
    }
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn wrong_missing_and_internal_boundaries_leave_no_task_or_history() {
    let (store, source) = fixture("codex");
    let other = store
        .create_session(&source.project_id, "codex", "test-model", "ask")
        .unwrap();
    let foreign = append(&store, &other.id, "user", "Wrong task");
    let mut rejected = vec![foreign, -1, 0, i64::MAX];
    for role in ["system", "tool", "coordination", "internal", "changes"] {
        rejected.push(append(
            &store,
            &source.id,
            role,
            "Not a conversation boundary",
        ));
    }
    for message_id in rejected {
        assert!(at_message(&store, &source.id, message_id).is_err());
        assert_eq!(store.sessions().unwrap().len(), 2);
    }
    assert!(at_message(&store, "missing-task", foreign).is_err());
    let boundary = append(&store, &source.id, "user", "Fork me");
    store.db.execute_batch(&format!("CREATE TRIGGER reject_fork_message BEFORE INSERT ON messages WHEN NEW.session_id <> '{}' AND NEW.session_id <> '{}' BEGIN SELECT RAISE(ABORT, 'injected fork failure'); END;", source.id, other.id)).unwrap();
    assert!(at_message(&store, &source.id, boundary)
        .unwrap_err()
        .contains("injected fork failure"));
    assert_eq!(store.sessions().unwrap().len(), 2);
    let queued: i64 = store
        .db
        .query_row("SELECT COUNT(*) FROM context_recovery", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(queued, 0);
}

#[test]
fn running_team_and_worker_forks_preserve_preferences_without_execution_state() {
    let (store, source) = fixture("codex");
    let first = append(&store, &source.id, "user", "Original request");
    let child = store
        .create_session(&source.project_id, "codex", "worker-model", "plan")
        .unwrap();
    let child_message = append(&store, &child.id, "assistant", "Worker answer");
    store
        .db
        .execute(
            "INSERT INTO architect_teams(session_id,content) VALUES(?1,'{}')",
            [&source.id],
        )
        .unwrap();
    store.db.execute("INSERT INTO architect_workers(parent_session_id,worker_id,session_id) VALUES(?1,'worker-1',?2)", params![source.id, child.id]).unwrap();
    store.db.execute("INSERT INTO subagents(session_id,id,content,updated_at) VALUES(?1,'native-child','{}',1)", [&source.id]).unwrap();
    store.db.execute("UPDATE sessions SET status='running',resume_id='source-context',reasoning_effort='high',context_used_tokens=500,context_window=1000,goal_state='{}',codex_settings=?2,task_description='FUTURE_DESCRIPTION',task_stage='completed',completed_at=1,archived=1 WHERE id=?1", params![source.id, json!({"personality":"friendly"}).to_string()]).unwrap();
    let source_before = serde_json::to_value(store.session(&source.id).unwrap()).unwrap();
    for (source_id, boundary) in [(&source.id, first), (&child.id, child_message)] {
        let original = store.session(source_id).unwrap();
        let fork = at_message(&store, source_id, boundary).unwrap();
        assert_eq!(fork.project_id, source.project_id);
        assert_eq!(fork.provider, original.provider);
        assert_eq!(fork.model, original.model);
        assert_eq!(fork.reasoning_effort, original.reasoning_effort);
        assert_eq!(fork.mode, original.mode);
        assert_eq!(fork.codex_settings, original.codex_settings);
        assert_eq!(fork.status, "idle");
        assert_eq!(fork.task_stage, "in_progress");
        assert!(!fork.archived);
        assert!(
            fork.resume_id.is_none()
                && fork.goal_state.is_none()
                && fork.context_usage.is_none()
                && fork.completed_at.is_none()
        );
        assert!(!fork.task_description.contains("FUTURE_DESCRIPTION"));
        assert!(store.subagents(&fork.id).unwrap().is_empty());
        let active: bool = store.db.query_row("SELECT EXISTS(SELECT 1 FROM architect_teams WHERE session_id=?1) OR EXISTS(SELECT 1 FROM architect_workers WHERE session_id=?1 OR parent_session_id=?1) OR EXISTS(SELECT 1 FROM architect_requests WHERE parent_session_id=?1)", [&fork.id], |row| row.get(0)).unwrap();
        assert!(!active);
    }
    assert_eq!(
        source_before,
        serde_json::to_value(store.session(&source.id).unwrap()).unwrap()
    );
}

#[test]
fn tool_snapshots_and_metadata_cannot_update_or_reference_the_source() {
    let (store, source) = fixture("codex");
    let first = append(&store, &source.id, "user", "Inspect the project");
    store.finish_turn(&source.id, first, 4321).unwrap();
    let tool = json!({"type":"tool_activity","version":1,"id":"source-call","name":"Read","status":"running","input":"README.md","output":"partial"}).to_string();
    store
        .tool_message(&source.id, "source-call", &tool)
        .unwrap();
    append(&store, &source.id, "internal", "Hidden source state");
    append(&store, &source.id, "changes", "Source change summary");
    let change_id = storage::id();
    store.db.execute("INSERT INTO turn_changes(id,session_id,message_id,summary,created_at) VALUES(?1,?2,?3,?4,1)", params![change_id, source.id, first, json!({"id":change_id,"files":[],"additions":0,"deletions":0,"truncated":false,"concurrent":false}).to_string()]).unwrap();
    let boundary = append(&store, &source.id, "assistant", "Current response");
    let fork = at_message(&store, &source.id, boundary).unwrap();
    let copied = all_messages(&store, &fork.id);
    assert_eq!(copied.len(), 3);
    assert!(copied
        .iter()
        .all(|m| m.turn_changes.is_none() && m.turn_duration_ms.is_none()));
    let snapshot: serde_json::Value = serde_json::from_str(&copied[1].content).unwrap();
    assert_ne!(snapshot["id"], "source-call");
    assert_eq!(snapshot["status"], "failed");
    assert!(snapshot["output"]
        .as_str()
        .unwrap()
        .contains("still running"));
    assert_eq!(store.messages(&source.id, None).unwrap()[1].content, tool);
    store
        .tool_message(&fork.id, "source-call", &tool.replace("partial", "new run"))
        .unwrap();
    assert_eq!(all_messages(&store, &fork.id).len(), 4);
    assert_eq!(store.messages(&source.id, None).unwrap()[1].content, tool);
}

#[test]
fn worktree_forks_share_the_existing_checkout_and_reject_missing_metadata() {
    let (store, source) = fixture("codex");
    let root = std::env::temp_dir().join(format!("pandacode-fork-worktree-{}", storage::id()));
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join(".git"), "gitdir: /unmodified/source/worktree").unwrap();
    std::fs::write(root.join("uncommitted.txt"), "Keep current checkout bytes").unwrap();
    store
        .db
        .execute(
            "UPDATE sessions SET worktree_path=?2 WHERE id=?1",
            params![source.id, root.to_str()],
        )
        .unwrap();
    let boundary = append(&store, &source.id, "user", "Continue this checkout");
    let fork = at_message(&store, &source.id, boundary).unwrap();
    assert_eq!(
        fork.worktree_path,
        store.session(&source.id).unwrap().worktree_path
    );
    assert_eq!(
        store
            .workspace_root(&fork.project_id, Some(&fork.id))
            .unwrap(),
        root.canonicalize().unwrap()
    );
    assert_eq!(
        std::fs::read_to_string(root.join("uncommitted.txt")).unwrap(),
        "Keep current checkout bytes"
    );
    std::fs::remove_file(root.join(".git")).unwrap();
    assert!(at_message(&store, &source.id, boundary)
        .unwrap_err()
        .contains("Git metadata"));
    assert_eq!(store.sessions().unwrap().len(), 2);
    std::fs::remove_dir_all(&root).unwrap();
    assert!(at_message(&store, &source.id, boundary)
        .unwrap_err()
        .contains("Worktree folder"));
    assert_eq!(store.sessions().unwrap().len(), 2);
}
