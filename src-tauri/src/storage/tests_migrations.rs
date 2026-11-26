//! Store tests for schema migrations and restarts (backfills, version upgrades, recovery after
//! reopen), run state on the board, and settings that are locked while a turn runs.
use super::tests_sessions::empty_session;
use super::*;

#[test]
fn starting_a_task_claims_running_and_message_atomically() {
    let (store, task) = empty_session();
    store.db.execute_batch("CREATE TRIGGER reject_prompt BEFORE INSERT ON messages WHEN NEW.role='user' BEGIN SELECT RAISE(ABORT,'injected storage failure'); END;").unwrap();
    assert!(store.begin_task_turn(&task.id, "Build a game").is_err());
    let unchanged = store.session(&task.id).unwrap();
    assert_eq!(unchanged.task_stage, "pending");
    assert_eq!(unchanged.status, "idle");
    assert_eq!(unchanged.title, "New conversation");
    store
        .db
        .execute_batch("DROP TRIGGER reject_prompt;")
        .unwrap();
    let message_id = store.begin_task_turn(&task.id, "Build a game").unwrap();
    let running = store.session(&task.id).unwrap();
    assert_eq!(running.task_stage, "in_progress");
    assert_eq!(running.status, "running");
    assert_eq!(running.title, "Build a game");
    assert_eq!(store.messages(&task.id, None).unwrap()[0].id, message_id);
    assert!(store.begin_task_turn(&task.id, "Duplicate").is_err());
    assert_eq!(store.messages(&task.id, None).unwrap().len(), 1);
    for status in ["running", "waiting"] {
        store.status(&task.id, status).unwrap();
        for stage in ["pending", "review", "completed"] {
            assert!(store.set_task_stage(&task.id, stage).is_err());
        }
        assert!(store
            .update_task_details(&task.id, "Changed", "Changed")
            .is_err());
    }
}

#[test]
fn successful_runs_go_to_review_but_errors_and_stops_stay_in_progress() {
    let (store, task) = empty_session();
    store.begin_task_turn(&task.id, "Build a game").unwrap();
    store.finish_task_turn(&task.id, false, false).unwrap();
    let failed = store.session(&task.id).unwrap();
    assert_eq!(failed.status, "error");
    assert_eq!(failed.task_stage, "in_progress");
    store.begin_task_turn(&task.id, "Retry").unwrap();
    // Providers intentionally return Ok after a graceful user cancellation.
    store.finish_task_turn(&task.id, true, true).unwrap();
    let stopped = store.session(&task.id).unwrap();
    assert_eq!(stopped.status, "interrupted");
    assert_eq!(stopped.task_stage, "in_progress");
    // Completing a stopped run can be undone back to work in progress.
    store.set_task_stage(&task.id, "completed").unwrap();
    let undone = store.set_task_stage(&task.id, "in_progress").unwrap();
    assert_eq!(undone.task_stage, "in_progress");
    assert!(undone.completed_at.is_none());
    store.begin_task_turn(&task.id, "Finish").unwrap();
    store.finish_task_turn(&task.id, true, false).unwrap();
    let review = store.session(&task.id).unwrap();
    // Undoing a completion puts a stopped run back in progress; nothing else may.
    assert!(store.set_task_stage(&task.id, "in_progress").is_err());
    assert_eq!(review.status, "idle");
    assert_eq!(review.task_stage, "review");
    assert!(review.completed_at.is_none());
    let completed = store.set_task_stage(&task.id, "completed").unwrap();
    assert!(completed.completed_at.is_some());
    assert!(store
        .begin_task_turn(&task.id, "Cannot run completed")
        .is_err());
    assert_eq!(
        store
            .set_task_stage(&task.id, "completed")
            .unwrap()
            .completed_at,
        completed.completed_at
    );
    assert!(store.set_task_stage(&task.id, "in_progress").is_err());
    assert!(store.set_task_stage(&task.id, "unknown").is_err());
    let reopened = store.set_task_stage(&task.id, "review").unwrap();
    assert!(reopened.completed_at.is_none());
    store.begin_task_turn(&task.id, "More feedback").unwrap();
    store.finish_task_turn(&task.id, true, false).unwrap();
    store
        .update(&task.id, None, Some(true), None, None)
        .unwrap();
    assert!(store
        .begin_task_turn(&task.id, "Cannot run archived")
        .is_err());
    assert!(store.set_task_stage(&task.id, "pending").is_err());
}

#[test]
fn settle_archived_completes_archived_tasks_only() {
    let (store, review) = empty_session();
    let done = store.create_session(&review.project_id, "codex", "default", "ask").unwrap();
    let live = store.create_session(&review.project_id, "codex", "default", "ask").unwrap();
    store.set_task_stage(&done.id, "completed").unwrap();
    store
        .db
        .execute("UPDATE sessions SET archived=1,completed_at=5 WHERE id=?1", [&done.id])
        .unwrap();
    store
        .db
        .execute("UPDATE sessions SET archived=1,task_stage='review',updated_at=9,completed_at=NULL WHERE id=?1", [&review.id])
        .unwrap();
    assert_eq!(store.settle_archived().unwrap(), 2);
    let done = store.session(&done.id).unwrap();
    assert!(!done.archived);
    assert_eq!(done.completed_at, Some(5));
    let review = store.session(&review.id).unwrap();
    assert!(!review.archived);
    assert_eq!(review.task_stage, "completed");
    assert_eq!(review.completed_at, Some(9));
    assert_eq!(review.updated_at, 9);
    assert!(!store.session(&live.id).unwrap().archived);
    assert_eq!(store.settle_archived().unwrap(), 0);
}

#[test]
fn a_corrupt_team_row_never_stops_the_store_opening() {
    let directory = std::env::temp_dir().join(format!("pandacode-corrupt-team-{}", id()));
    std::fs::create_dir_all(&directory).unwrap();
    let path = directory.join("store.sqlite");
    drop(Store::open(&path).unwrap());
    {
        let db = Connection::open(&path).unwrap();
        db.execute_batch("PRAGMA foreign_keys=OFF;
            INSERT INTO architect_teams(session_id,content) VALUES('not-json','{broken'),('bad-worker','{\"status\":\"running\",\"workers\":[\"x\",{\"status\":\"running\"}]}');").unwrap();
    }
    drop(Store::open(&path).unwrap());
    let db = Connection::open(&path).unwrap();
    let broken: String = db.query_row("SELECT content FROM architect_teams WHERE session_id='not-json'", [], |row| row.get(0)).unwrap();
    assert_eq!(broken, "{broken");
    let worker: String = db.query_row("SELECT json_extract(content,'$.workers[0].status') FROM architect_teams WHERE session_id='bad-worker'", [], |row| row.get(0)).unwrap();
    assert_eq!(worker, "stopped");
    let _ = std::fs::remove_dir_all(directory);
}

#[test]
fn board_migration_backfills_history_recovers_runs_and_archives_after_reopen() {
    let directory = std::env::temp_dir().join(format!("pandacode-board-{}", id()));
    std::fs::create_dir_all(&directory).unwrap();
    let path = directory.join("store.sqlite");
    let (empty, answered, running, failed);
    {
        let store = Store::open(&path).unwrap();
        let project = store.add_project(&directory).unwrap();
        let create = || {
            store
                .create_session(&project.id, "claude", "sonnet", "ask")
                .unwrap()
        };
        empty = create().id;
        answered = create().id;
        running = create().id;
        failed = create().id;
        store
            .message(&answered, "user", "Original requirements")
            .unwrap();
        store.message(&answered, "assistant", "Done").unwrap();
        store.resume(&answered, "keep-resume").unwrap();
        store.status(&running, "waiting").unwrap();
        store.status(&failed, "error").unwrap();
        store
            .db
            .execute_batch(
                "DROP INDEX IF EXISTS sessions_active_goal; ALTER TABLE sessions DROP COLUMN goal_state; ALTER TABLE sessions DROP COLUMN codex_settings; DROP TABLE IF EXISTS running_subagents; DROP TABLE subagents; DROP INDEX sessions_completed_archive;
            ALTER TABLE sessions DROP COLUMN task_stage;
            ALTER TABLE sessions DROP COLUMN task_description;
            ALTER TABLE sessions DROP COLUMN completed_at;
            PRAGMA user_version=7;",
            )
            .unwrap();
    }
    {
        let store = Store::open(&path).unwrap();
        assert_eq!(store.session(&empty).unwrap().task_stage, "pending");
        let migrated = store.session(&answered).unwrap();
        assert_eq!(migrated.task_stage, "review");
        assert_eq!(migrated.task_description, "Original requirements");
        assert_eq!(migrated.resume_id.as_deref(), Some("keep-resume"));
        assert_eq!(store.messages(&answered, None).unwrap().len(), 2);
        let interrupted = store.session(&running).unwrap();
        assert_eq!(interrupted.status, "interrupted");
        assert_eq!(interrupted.task_stage, "in_progress");
        assert_eq!(store.session(&failed).unwrap().task_stage, "in_progress");
        store.set_task_stage(&answered, "completed").unwrap();
        store
            .db
            .execute(
                "UPDATE sessions SET completed_at=?2 WHERE id=?1",
                params![answered, now() - 8 * 24 * 60 * 60 * 1000],
            )
            .unwrap();
    }
    {
        let store = Store::open(&path).unwrap();
        let archived = store.session(&answered).unwrap();
        assert!(!archived.archived);
        assert_eq!(archived.task_stage, "completed");
        assert_eq!(archived.task_description, "Original requirements");
        assert_eq!(store.messages(&answered, None).unwrap().len(), 2);
        assert!(!store.session(&empty).unwrap().archived);
    }
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn reasoning_and_context_migrate_from_v6_and_persist_without_activity_side_effects() {
    let directory = std::env::temp_dir().join(format!("pandacode-context-{}", id()));
    std::fs::create_dir_all(&directory).unwrap();
    let path = directory.join("store.sqlite");
    let sid;
    {
        let store = Store::open(&path).unwrap();
        let project = store.add_project(&directory).unwrap();
        sid = store
            .create_session(&project.id, "claude", "sonnet", "ask")
            .unwrap()
            .id;
        store
            .message(&sid, "assistant", "Existing response")
            .unwrap();
        store.resume(&sid, "preserved-session").unwrap();
        store
            .db
            .execute_batch(
                "DROP INDEX IF EXISTS sessions_active_goal; ALTER TABLE sessions DROP COLUMN goal_state; ALTER TABLE sessions DROP COLUMN codex_settings; DROP TABLE IF EXISTS running_subagents; DROP TABLE subagents; DROP INDEX sessions_completed_archive;
            ALTER TABLE sessions DROP COLUMN task_stage;
            ALTER TABLE sessions DROP COLUMN task_description;
            ALTER TABLE sessions DROP COLUMN completed_at;
            ALTER TABLE sessions DROP COLUMN reasoning_effort;
            ALTER TABLE sessions DROP COLUMN context_used_tokens;
            ALTER TABLE sessions DROP COLUMN context_window;
            PRAGMA user_version=6;",
            )
            .unwrap();
    }
    let metadata;
    {
        let store = Store::open(&path).unwrap();
        let migrated = store.session(&sid).unwrap();
        assert!(migrated.reasoning_effort.is_none());
        assert!(migrated.context_usage.is_none());
        assert_eq!(store.messages(&sid, None).unwrap().len(), 1);
        store.set_reasoning_effort(&sid, Some("high")).unwrap();
        metadata = store.session(&sid).unwrap();
        store
            .record_context_usage(
                &sid,
                &ContextUsage {
                    used_tokens: 90_000,
                    context_window: Some(200_000),
                },
            )
            .unwrap();
        // Compaction may decrease the latest context; never accumulate it.
        store
            .record_context_usage(
                &sid,
                &ContextUsage {
                    used_tokens: 30_000,
                    context_window: None,
                },
            )
            .unwrap();
        let changed = store.session(&sid).unwrap();
        assert_eq!(
            changed.context_usage.unwrap(),
            ContextUsage {
                used_tokens: 30_000,
                context_window: None,
            }
        );
        assert_eq!(changed.last_response_at, metadata.last_response_at);
        assert_eq!(changed.updated_at, metadata.updated_at);
        assert_eq!(changed.title, metadata.title);
        assert_eq!(changed.status, metadata.status);
        assert_eq!(store.messages(&sid, None).unwrap().len(), 1);
    }
    {
        let store = Store::open(&path).unwrap();
        let reopened = store.session(&sid).unwrap();
        assert_eq!(reopened.reasoning_effort.as_deref(), Some("high"));
        assert_eq!(reopened.context_usage.unwrap().used_tokens, 30_000);
        assert_eq!(reopened.last_response_at, metadata.last_response_at);
        assert_eq!(reopened.updated_at, metadata.updated_at);
        assert_eq!(reopened.resume_id.as_deref(), Some("preserved-session"));
        assert_eq!(
            serde_json::to_value(&store.sessions().unwrap()[0]).unwrap()["contextUsage"]
                ["usedTokens"],
            30_000
        );
        assert_eq!(
            store
                .db
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
    }
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn reasoning_and_model_changes_are_blocked_while_active_but_context_can_update() {
    let (store, session) = empty_session();
    store
        .set_reasoning_effort(&session.id, Some("high"))
        .unwrap();
    for status in ["running", "waiting"] {
        store.status(&session.id, status).unwrap();
        assert!(store
            .set_reasoning_effort(&session.id, None)
            .unwrap_err()
            .contains("Stop the agent"));
        assert!(store
            .configure(&session.id, "claude", "opus", None)
            .is_err());
        assert!(store
            .update(
                &session.id,
                Some("Must not rename".into()),
                None,
                Some("opus".into()),
                None
            )
            .is_err());
        let before = store.session(&session.id).unwrap();
        assert_eq!(before.reasoning_effort.as_deref(), Some("high"));
        assert_eq!(before.model, "sonnet");
        assert_eq!(before.title, "New conversation");
        store
            .record_context_usage(
                &session.id,
                &ContextUsage {
                    used_tokens: 100,
                    context_window: None,
                },
            )
            .unwrap();
        let after = store.session(&session.id).unwrap();
        assert_eq!(after.status, status);
        assert_eq!(after.updated_at, before.updated_at);
    }
    assert!(store
        .record_context_usage(
            &session.id,
            &ContextUsage {
                used_tokens: u64::MAX,
                context_window: None
            }
        )
        .is_err());
    assert!(store
        .record_context_usage(
            "missing",
            &ContextUsage {
                used_tokens: 0,
                context_window: None
            }
        )
        .is_err());
    store.status(&session.id, "idle").unwrap();
    assert!(store
        .set_reasoning_effort(&session.id, None)
        .unwrap()
        .reasoning_effort
        .is_none());
}

#[test]
fn duration_migration_and_restart_preserve_known_time_without_inventing_interrupted_time() {
    let directory = std::env::temp_dir().join(format!("pandacode-turn-time-{}", id()));
    std::fs::create_dir_all(&directory).unwrap();
    let path = directory.join("store.sqlite");
    let task;
    {
        let store = Store::open(&path).unwrap();
        let project = store.add_project(&directory).unwrap();
        task = store
            .create_session(&project.id, "claude", "sonnet", "ask")
            .unwrap();
        store.message(&task.id, "user", "Legacy prompt").unwrap();
        store
            .message(&task.id, "assistant", "Legacy response")
            .unwrap();
        store.resume(&task.id, "preserved-resume-id").unwrap();
        store
            .db
            .execute_batch(
                "DROP INDEX IF EXISTS sessions_active_goal; ALTER TABLE sessions DROP COLUMN goal_state; ALTER TABLE sessions DROP COLUMN codex_settings; DROP TABLE IF EXISTS running_subagents; DROP TABLE subagents; DROP INDEX sessions_completed_archive; ALTER TABLE sessions DROP COLUMN task_stage; ALTER TABLE sessions DROP COLUMN task_description; ALTER TABLE sessions DROP COLUMN completed_at; ALTER TABLE sessions DROP COLUMN reasoning_effort; ALTER TABLE sessions DROP COLUMN context_used_tokens; ALTER TABLE sessions DROP COLUMN context_window; ALTER TABLE messages DROP COLUMN turn_duration_ms; PRAGMA user_version=5;",
            )
            .unwrap();
    }
    let (finished, interrupted);
    {
        let store = Store::open(&path).unwrap();
        assert_eq!(
            store
                .db
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
        assert!(store
            .messages(&task.id, None)
            .unwrap()
            .iter()
            .all(|message| message.turn_duration_ms.is_none()));
        finished = store
            .start_turn_message(&task.id, "Measured prompt")
            .unwrap();
        store.message(&task.id, "error", "Provider failed").unwrap();
        store.finish_turn(&task.id, finished, 65_321).unwrap();
        interrupted = store
            .start_turn_message(&task.id, "Unfinished prompt")
            .unwrap();
        store.status(&task.id, "running").unwrap();
    }
    {
        let store = Store::open(&path).unwrap();
        let messages = store.message_page(&task.id, None).unwrap().messages;
        assert_eq!(messages.len(), 5);
        assert_eq!(
            messages
                .iter()
                .find(|message| message.id == finished)
                .unwrap()
                .turn_duration_ms,
            Some(65_321)
        );
        assert!(messages
            .iter()
            .find(|message| message.id == interrupted)
            .unwrap()
            .turn_duration_ms
            .is_none());
        assert!(messages[..2]
            .iter()
            .all(|message| message.turn_duration_ms.is_none()));
        assert_eq!(store.session(&task.id).unwrap().status, "interrupted");
        assert_eq!(
            store.session(&task.id).unwrap().resume_id.as_deref(),
            Some("preserved-resume-id")
        );
        assert_eq!(
            serde_json::to_value(messages.last().unwrap()).unwrap()["turnDurationMs"],
            serde_json::Value::Null
        );
    }
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn prompt_activity_backfills_version_18_and_survives_reopen() {
    let dir = std::env::temp_dir().join(format!("pandacode-prompt-{}", id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("prompt.db");
    let sid;
    {
        let store = Store::open(&path).unwrap();
        let project = store.add_project(&std::env::temp_dir()).unwrap();
        sid = store.create_session(&project.id, "codex", "", "full").unwrap().id;
        for (role, content, time) in [("user", "Earlier prompt", 100), ("assistant", "Reply", 200), ("user", "Newest prompt", 300), ("coordination", "Worker status", 400), ("user", " ", 500)] {
            store.db.execute("INSERT INTO messages(session_id,role,content,created_at) VALUES(?1,?2,?3,?4)", params![sid,role,content,time]).unwrap();
        }
        store.db.execute_batch("DROP INDEX sessions_sidebar; DROP TRIGGER messages_record_prompt; ALTER TABLE sessions DROP COLUMN last_prompt_at; PRAGMA user_version=18;").unwrap();
    }
    {
        let store = Store::open(&path).unwrap();
        let task = store.session(&sid).unwrap();
        assert_eq!(task.last_prompt_at, Some(300));
        assert_eq!(task.last_response_at, Some(200));
        assert_eq!(store.sessions().unwrap()[0].last_prompt_at, Some(300));
        store.db.execute("INSERT INTO messages(session_id,role,content,created_at) VALUES(?1,'user','Newest send',600)", [&sid]).unwrap();
    }
    let store = Store::open(&path).unwrap();
    assert_eq!(store.session(&sid).unwrap().last_prompt_at, Some(600));
    assert_eq!(store.db.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0)).unwrap(), SCHEMA_VERSION);
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
}

/// The regression behind "no such column: worktree_branch": a database already at
/// version 17 must still receive the branch migration, with its threads intact.
#[test]
fn version_17_database_migrates_to_the_current_schema_and_keeps_threads() {
    let dir = std::env::temp_dir().join(format!("pandacode-previous-{}", id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("previous.db");
    let (project_id, task_id) = {
        let store = Store::open(&path).unwrap();
        let project = store.add_project(&std::env::temp_dir()).unwrap();
        let task = store
            .create_session(&project.id, "claude", "sonnet", "full")
            .unwrap();
        store.message(&task.id, "user", "Keep this thread").unwrap();
        store.message(&task.id, "assistant", "It stays").unwrap();
        // Rebuild exactly what the previous release shipped: no branch column, no links.
        store
            .db
            .execute_batch("ALTER TABLE sessions DROP COLUMN worktree_branch; DROP TABLE task_links; PRAGMA user_version=17;")
            .unwrap();
        (project.id, task.id)
    };
    let reopened = Store::open(&path).unwrap();
    assert_eq!(
        reopened
            .db
            .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
            .unwrap(),
        SCHEMA_VERSION
    );
    let listed = reopened.sessions().unwrap();
    assert_eq!(listed.len(), 1);
    let task = reopened.session(&task_id).unwrap();
    assert_eq!(task.project_id, project_id);
    assert_eq!(task.worktree_branch, None);
    assert!(task.issue.is_none() && task.pull_request.is_none());
    assert_eq!(reopened.messages(&task_id, None).unwrap().len(), 2);
    // Opening a current database again is a no-op.
    drop(reopened);
    Store::open(&path).unwrap().session(&task_id).unwrap();
}

/// Diagnostic: open a copy of a real database and list its tasks with the current
/// code. `PANDACODE_DB_PATH=/copy/of/kingcode.sqlite3 cargo test -- --ignored --nocapture opens_the_database`
#[test]
#[ignore]
fn opens_the_database_at_pandacode_db_path() {
    let path = PathBuf::from(std::env::var("PANDACODE_DB_PATH").expect("set PANDACODE_DB_PATH to a copy of the database"));
    let store = Store::open(&path).unwrap();
    let version: i64 = store.db.pragma_query_value(None, "user_version", |row| row.get(0)).unwrap();
    let sessions = store.sessions().unwrap();
    let messages: i64 = store.db.query_row("SELECT COUNT(*) FROM messages", [], |r| r.get(0)).unwrap();
    println!("user_version={version} projects={} sessions={} (worktrees={}, linked={}) messages={messages}", store.projects().unwrap().len(), sessions.len(), sessions.iter().filter(|s| s.worktree_path.is_some()).count(), sessions.iter().filter(|s| s.issue.is_some() || s.pull_request.is_some()).count());
    for session in sessions.iter().take(5) {
        println!("  {} · {} · {}", session.title, session.provider, if session.archived { "archived" } else { &session.status });
        store.session(&session.id).unwrap();
    }
    // Optionally write the exact IPC payloads so the browser preview can render them.
    if let Ok(dir) = std::env::var("PANDACODE_DUMP_DIR") {
        let dir = PathBuf::from(dir);
        std::fs::write(dir.join("projects.json"), serde_json::to_vec(&store.projects().unwrap()).unwrap()).unwrap();
        std::fs::write(dir.join("sessions.json"), serde_json::to_vec(&sessions).unwrap()).unwrap();
    }
    assert_eq!(version, SCHEMA_VERSION);
}

#[test]
fn schema_version_constant_matches_the_newest_migration_step() {
    let source = concat!(include_str!("../storage.rs"), include_str!("schema_v38.rs"));
    let newest = source
        .match_indices("PRAGMA user_version=")
        .filter_map(|(index, marker)| source[index + marker.len()..].split(|c: char| !c.is_ascii_digit()).next()?.parse::<i64>().ok())
        .max()
        .unwrap();
    assert_eq!(newest, SCHEMA_VERSION, "bump SCHEMA_VERSION with every new migration step");
}

#[test]
fn migration_30_creates_message_attachments_index() {
    let (store, _) = empty_session();
    let version: i64 = store.db.pragma_query_value(None, "user_version", |row| row.get(0)).unwrap();
    assert_eq!(version, SCHEMA_VERSION);
    let table: bool = store.db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='message_attachments')", [], |row| row.get(0)).unwrap();
    let index: bool = store.db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='index' AND name='message_attachments_session_id')", [], |row| row.get(0)).unwrap();
    assert!(table && index);
}

#[test]
fn last_response_backfills_old_schema_and_survives_reopen() {
    let dir = std::env::temp_dir().join(format!("pandacode-migration-{}", id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("legacy.db");
    {
        let legacy = Connection::open(&path).unwrap();
        legacy.execute_batch("CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,path TEXT NOT NULL UNIQUE);
            CREATE TABLE sessions(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,title TEXT NOT NULL,provider TEXT NOT NULL,model TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,archived INTEGER NOT NULL DEFAULT 0,resume_id TEXT);
            CREATE TABLE messages(id INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL,role TEXT NOT NULL,content TEXT NOT NULL,created_at INTEGER NOT NULL);
            PRAGMA user_version=1;
            INSERT INTO projects VALUES ('project','Project','/tmp');
            INSERT INTO sessions VALUES ('answered','project','Old task','claude','sonnet','ask','idle',1000,999999,0,NULL);
            INSERT INTO sessions VALUES ('unanswered','project','Empty task','codex','default','ask','idle',1000,999999,0,NULL);
            INSERT INTO messages(session_id,role,content,created_at) VALUES
              ('answered','assistant','Latest response',6000),
              ('answered','assistant','Older response inserted later',5000),
              ('answered','assistant','',10000),
              ('unanswered','assistant','',10000),
              ('unanswered','user','A prompt',11000);").unwrap();
        for _ in 0..100 {
            legacy.execute("INSERT INTO messages(session_id,role,content,created_at) VALUES ('answered','tool','Later activity',12000)", []).unwrap();
        }
    }
    {
        let store = Store::open(&path).unwrap();
        assert!(store
            .messages("answered", None)
            .unwrap()
            .iter()
            .all(|m| m.role == "tool"));
        assert_eq!(
            store.session("answered").unwrap().last_response_at,
            Some(6000)
        );
        assert_eq!(store.session("unanswered").unwrap().last_response_at, None);
        assert_eq!(
            store
                .db
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
        store.db.execute("INSERT INTO messages(session_id,role,content,created_at) VALUES ('answered','assistant','New response',15000)", []).unwrap();
        store.db.execute("INSERT INTO messages(session_id,role,content,created_at) VALUES ('answered','assistant','Older imported response',14000)", []).unwrap();
        assert_eq!(
            store.session("answered").unwrap().last_response_at,
            Some(15000)
        );
        // A reopened current schema must retain the recorded activity even if
        // old transcript rows have been pruned, rather than rerun a backfill.
        store
            .db
            .execute("DELETE FROM messages WHERE session_id='answered'", [])
            .unwrap();
    }
    {
        let reopened = Store::open(&path).unwrap();
        assert_eq!(
            reopened.session("answered").unwrap().last_response_at,
            Some(15000)
        );
        assert_eq!(
            reopened.session("unanswered").unwrap().last_response_at,
            None
        );
    }
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn all_approval_behaviors_persist_across_restart_and_harness_changes() {
    let dir = std::env::temp_dir().join(format!("pandacode-modes-{}", id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("test.db");
    let mut sessions = Vec::new();
    {
        let store = Store::open(&path).unwrap();
        let project = store.add_project(&dir).unwrap();
        for provider in [
            "claude",
            "codex",
            "kimi",
            "glm",
            "opencode",
            "antigravity",
            "grok",
            "mimo",
            "alibaba",
            "pi",
            "deepseek",
            "commandcode",
            "cline",
            "kilo",
            "omp",
            "github-copilot",
            "muse",
            "devin",
            "zcode",
            "hermes",
            "cursor",
        ] {
            for mode in ["ask", "auto", "plan", "full"] {
                let session = store
                    .create_session(&project.id, provider, "default", mode)
                    .unwrap();
                sessions.push((session.id, provider, mode));
            }
        }
    }
    {
        let store = Store::open(&path).unwrap();
        for (sid, provider, mode) in sessions {
            assert_eq!(store.session(&sid).unwrap().mode, mode);
            assert_eq!(
                store
                    .configure(&sid, provider, "other-model", None)
                    .unwrap()
                    .mode,
                mode
            );
            let next_provider = if provider == "codex" {
                "claude"
            } else {
                "codex"
            };
            assert_eq!(
                store
                    .configure(&sid, next_provider, "default", None)
                    .unwrap()
                    .mode,
                mode
            );
        }
    }
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn startup_recovery_uses_schema_advanced_by_another_connection() {
    let directory = std::env::temp_dir().join(format!("pandacode-recovery-version-{}", id()));
    std::fs::create_dir_all(&directory).unwrap();
    let path = directory.join("store.sqlite");
    let store = Store::open(&path).unwrap();
    let project = store.add_project(&directory).unwrap();
    let task = store.create_session(&project.id, "claude", "sonnet", "auto").unwrap();
    store.begin_task_turn(&task.id, "Work in progress").unwrap();
    let seed = |db: &Connection| db.execute_batch(r#"
        INSERT INTO messages(session_id,role,content,created_at,tool_id) SELECT id,'tool','{"type":"tool_activity","version":1,"status":"running"}',1,'tool' FROM sessions;
        INSERT INTO subagents(session_id,id,content,updated_at) SELECT id,'child','{"status":"waiting","tools":[{"status":"running"}]}',1 FROM sessions;"#).unwrap();
    seed(&store.db);
    drop(store);

    let reopened = Store::open_with_before_recovery(&path, || {
        Connection::open(&path).unwrap().execute_batch(
            "BEGIN IMMEDIATE;
             DROP TRIGGER running_tools_insert;
             DROP TRIGGER running_subagents_insert;
             DELETE FROM running_tools; DELETE FROM running_subagents;
             PRAGMA user_version=39;
             COMMIT;",
        ).unwrap();
    }).unwrap();
    assert_eq!(reopened.session(&task.id).unwrap().status, "interrupted");
    assert!(!reopened.trackers_usable);
    let statuses = || -> (String, String, String) {
        reopened.db.query_row("SELECT json_extract(m.content,'$.status'),json_extract(s.content,'$.status'),json_extract(s.content,'$.tools[0].status') FROM messages m JOIN subagents s USING(session_id) WHERE m.tool_id='tool'", [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap()
    };
    let finished = ("failed".into(), "stopped".into(), "failed".into());
    assert_eq!(statuses(), finished);
    reopened.db.execute_batch("DELETE FROM messages WHERE role='tool'; DELETE FROM subagents;").unwrap();
    seed(&reopened.db);
    reopened.finish_tools(&task.id).unwrap();
    reopened.finish_subagents(&task.id, "stopped").unwrap();
    assert_eq!(statuses(), finished);
    drop(reopened);
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn newer_schema_sidebar_trigger_ranks_published_drafts_without_persistent_ddl() {
    let directory = std::env::temp_dir().join(format!("pandacode-sidebar-version-{}", id()));
    std::fs::create_dir_all(&directory).unwrap();
    let path = directory.join("store.sqlite");
    let store = Store::open(&path).unwrap();
    let project = store.add_project(&directory).unwrap();
    let older = store.create_session(&project.id, "codex", "default", "ask").unwrap();
    store.db.execute_batch("UPDATE sessions SET sidebar_order=0; PRAGMA user_version=39;").unwrap();
    let objects = |db: &Connection| {
        db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").unwrap()
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?))).unwrap()
            .collect::<rusqlite::Result<Vec<_>>>().unwrap()
    };
    let original_objects = objects(&store.db);
    drop(store);

    let store = Store::open(&path).unwrap();
    let draft = store.create_session(&project.id, "codex", "default", "ask").unwrap();
    store.mark_draft(&draft.id).unwrap();
    store.message(&draft.id, "user", "Publish draft").unwrap();
    assert_eq!(store.session(&draft.id).unwrap().sidebar_order, Some(0));
    assert_eq!(store.session(&older.id).unwrap().sidebar_order, Some(1));
    assert_eq!(objects(&store.db), original_objects);
    drop(store);
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn newer_schema_without_sidebar_order_skips_the_sidebar_trigger() {
    let path = std::env::temp_dir().join(format!("pandacode-sidebar-{}.sqlite", id()));
    let store = Store::open(&path).unwrap();
    store.db.execute_batch(
        "DROP INDEX sessions_sidebar; ALTER TABLE sessions DROP COLUMN sidebar_order; PRAGMA user_version=39;",
    ).unwrap();
    drop(store);
    let store = Store::open(&path).unwrap();
    let has_temp_trigger: bool = store.db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_temp_master WHERE name='rank_published_draft')", [], |r| r.get(0),
    ).unwrap();
    assert!(!has_temp_trigger);
    drop(store);
    std::fs::remove_file(path).unwrap();
}
