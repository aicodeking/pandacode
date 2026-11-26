//! Schema version 38: index plans, tracker backfill and settling, and `repair_v38_objects`.

use super::super::sql::{
    COUNT_RESTART_INTERRUPTED_SQL, DISCARD_EMPTY_DRAFTS_SQL, DUE_LIMIT_RESUMES_SQL,
    IMPORTED_TASK_SQL, INTERRUPT_TEAMS_SQL, PAUSE_GOALS_SQL, PROJECT_LINKS_SQL, PROMPT_ACTIVITY_SQL,
    RESET_REMOTE_STARTS_SQL, SEARCH_TASKS_SQL, SETTLE_ARCHIVED_SQL, USER_TURNS_SQL,
};
use super::super::tests_sessions::empty_session;
use super::super::*;
use super::*;

/// `v38_counts` on a database with every version 38 object.
pub(super) const HEALTHY: (i64, i64, i64) = (V38_OBJECTS, V38_TRACKER_OBJECTS, BOT_INDEXES);
pub(super) const BOT_INDEXES: i64 = V38_BOT_INDEXES.len() as i64;

/// A temporary directory, removed when dropped, so a panicking test never leaks it.
pub(super) struct TempDir(pub(super) std::path::PathBuf);

impl TempDir {
    pub(super) fn new(tag: &str) -> Self {
        let directory = std::env::temp_dir().join(format!("pandacode-{tag}-{}", id()));
        std::fs::create_dir_all(&directory).unwrap();
        Self(directory)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A file database at the current version with one task, and the path to reopen it.
pub(super) fn current_database(tag: &str) -> (TempDir, std::path::PathBuf) {
    let directory = TempDir::new(tag);
    let path = directory.0.join("store.db");
    let store = Store::open(&path).unwrap();
    let project = store.add_project(&std::env::temp_dir()).unwrap();
    store.create_session(&project.id, "claude", "sonnet", "auto").unwrap();
    (directory, path)
}

/// Counts of version 38 objects: every object, tracker objects, and bot indexes.
pub(super) fn v38_counts(db: &Connection) -> (i64, i64, i64) {
    let (found, trackers, bot_indexes, _, _) = v38_objects_present(db).unwrap();
    (found, trackers, bot_indexes)
}

/// The plan SQLite picks for `sql`, one detail line per step. Parameters stay unbound.
fn query_plan(store: &Store, sql: &str) -> Vec<String> {
    let mut statement = store.db.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
    let mut rows = statement.raw_query();
    let mut plan = Vec::new();
    while let Some(row) = rows.next().unwrap() {
        plan.push(row.get::<_, String>(3).unwrap());
    }
    plan
}

/// Asserts the plan reads `index` and walks no table row by row.
fn assert_plan_uses(store: &Store, sql: &str, index: &str) -> Vec<String> {
    let plan = query_plan(store, sql);
    let named = |line: &String| line.contains(&format!("INDEX {index} ")) || line.ends_with(&format!("INDEX {index}"));
    assert!(plan.iter().any(named), "{index} unused: {plan:#?}");
    let full_scans: Vec<_> = plan
        .iter()
        .filter(|line| line.starts_with("SCAN ") && !line.contains(" USING ") && !line.contains("VIRTUAL TABLE") && !line.contains("CONSTANT ROW") && !line.contains("subquery"))
        .collect();
    assert!(full_scans.is_empty(), "full table scan: {plan:#?}");
    plan
}

/// The names of the indexes `SCHEMA_38_INDEXES` creates.
pub(super) fn schema_38_index_names() -> Vec<&'static str> {
    SCHEMA_38_INDEXES
        .split(';')
        .filter_map(|statement| statement.trim().strip_prefix("CREATE INDEX IF NOT EXISTS "))
        .map(|rest| rest.split_whitespace().next().unwrap())
        .collect()
}

#[test]
fn version_38_creates_every_hot_query_index() {
    let (store, _) = empty_session();
    assert!(store.trackers_usable);
    let names = schema_38_index_names();
    assert!(names.len() > 10, "{names:?}");
    for name in names {
        let exists: bool = store.db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='index' AND name=?1)", [name], |r| r.get(0)).unwrap();
        assert!(exists, "{name} missing");
    }
    let superseded: bool = store.db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='turn_changes_retained')", [], |r| r.get(0)).unwrap();
    assert!(!superseded, "turn_changes_retained_bytes supersedes turn_changes_retained");
}

#[test]
fn upgrade_v38_rolls_back_partial_bot_upgrade_in_savepoint() {
    let directory = TempDir::new("bot-upgrade-savepoint");
    let path = directory.0.join("store.db");
    let store = Store::open(&path).unwrap();
    // Bot upgrade recreates the shared-channel schema before its case-sensitive lookup
    // misses COLOR and the attempt to add color fails with a duplicate-column error.
    store.db.execute_batch(
        "DROP TABLE bot_shared_channel_deliveries;
         DROP TABLE bot_shared_channel_messages;
         DROP TABLE bot_shared_channel_members;
         DROP TABLE bot_shared_channels;
         ALTER TABLE bots RENAME COLUMN color TO COLOR;
         DROP INDEX bot_activity_model_switch;
         PRAGMA user_version=36;",
    ).unwrap();

    drop(store);
    let store = Store::open(&path).unwrap();

    let version: i64 = store.db.pragma_query_value(None, "user_version", |row| row.get(0)).unwrap();
    assert_eq!(version, SCHEMA_VERSION);
    let shared_objects: i64 = store.db.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE tbl_name GLOB 'bot_shared_channel*'",
        [],
        |row| row.get(0),
    ).unwrap();
    assert_eq!(shared_objects, 0, "the failed bot upgrade left shared-channel objects");
}

#[test]
fn newer_schema_skips_repair_and_preserves_custom_trigger() {
    assert_newer_schema_skips_repair_and_preserves_custom_trigger(None);
}

#[test]
fn tracker_repair_rereads_version_under_writer_lock() {
    assert_newer_schema_skips_repair_and_preserves_custom_trigger(Some(SCHEMA_VERSION));
}

fn assert_newer_schema_skips_repair_and_preserves_custom_trigger(stale_version: Option<i64>) {
    let directory = TempDir::new("newer-custom-trigger");
    let path = directory.0.join("store.db");
    let task = {
        let store = Store::open(&path).unwrap();
        let project = store.add_project(&directory.0).unwrap();
        let task = store.create_session(&project.id, "claude", "sonnet", "auto").unwrap();
        store.db.execute_batch(
            "CREATE TABLE v39_audit(session_id TEXT);
             DROP TRIGGER running_tools_insert;
             CREATE TRIGGER running_tools_insert AFTER INSERT ON messages WHEN NEW.role='tool'
             BEGIN INSERT INTO v39_audit VALUES(NEW.session_id); END;
             DROP TRIGGER running_tools_update_start;
             DROP INDEX running_tools_session;
             PRAGMA user_version=39;",
        ).unwrap();
        task
    };

    let db = if let Some(version) = stale_version {
        let mut db = Connection::open(&path).unwrap();
        repair_v38_objects(&mut db, version).unwrap();
        db
    } else {
        Store::open(&path).unwrap().db
    };
    assert_eq!(v38_counts(&db), (V38_OBJECTS - 3, V38_TRACKER_OBJECTS - 2, BOT_INDEXES));
    let version: i64 = db.pragma_query_value(None, "user_version", |row| row.get(0)).unwrap();
    assert_eq!(version, 39);
    let running = r#"{"type":"tool_activity","version":1,"status":"running"}"#;
    db.execute(
        "INSERT INTO messages(session_id,role,content,tool_id,created_at) VALUES(?1,'tool',?2,'running',0)",
        params![task.id, running],
    ).unwrap();
    let audited: String = db.query_row("SELECT session_id FROM v39_audit", [], |row| row.get(0)).unwrap();
    assert_eq!(audited, task.id);
}

#[test]
fn newer_schema_preserves_existing_tracker_rows() {
    const CUSTOM_TRIGGER: &str = "CREATE TRIGGER architect_team_meta_insert AFTER INSERT ON architect_teams BEGIN SELECT 39; END";
    let directory = TempDir::new("newer-custom-tracker-row");
    let path = directory.0.join("store.db");
    let task = {
        let store = Store::open(&path).unwrap();
        let project = store.add_project(&directory.0).unwrap();
        let task = store.create_session(&project.id, "claude", "sonnet", "auto").unwrap();
        // The snapshot already has its cutoff, so startup need not rewrite it to add one.
        store.db.execute(
            "INSERT INTO architect_teams(session_id,content) VALUES(?1,?2)",
            params![task.id, r#"{"status":"completed","legacyPromptThroughId":0}"#],
        ).unwrap();
        store.db.execute(
            "UPDATE architect_team_meta SET status='v39-paused' WHERE session_id=?1",
            [&task.id],
        ).unwrap();
        store.db.execute_batch("DROP TRIGGER architect_team_meta_insert; DROP INDEX running_tools_session; PRAGMA user_version=39;").unwrap();
        store.db.execute_batch(CUSTOM_TRIGGER).unwrap();
        task
    };

    let store = Store::open(&path).unwrap();
    let index_present: bool = store.db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='index' AND name='running_tools_session')",
        [],
        |row| row.get(0),
    ).unwrap();
    assert!(!index_present);
    let version: i64 = store.db.pragma_query_value(None, "user_version", |row| row.get(0)).unwrap();
    assert_eq!(version, 39);
    let status: String = store.db.query_row(
        "SELECT status FROM architect_team_meta WHERE session_id=?1",
        [&task.id],
        |row| row.get(0),
    ).unwrap();
    assert_eq!(status, "v39-paused");
    let trigger: String = store.db.query_row(
        "SELECT sql FROM sqlite_master WHERE name='architect_team_meta_insert'",
        [],
        |row| row.get(0),
    ).unwrap();
    assert_eq!(trigger, CUSTOM_TRIGGER);
    assert_eq!(v38_counts(&store.db), (V38_OBJECTS - 2, V38_TRACKER_OBJECTS - 1, BOT_INDEXES));
}

#[test]
fn newer_schema_settles_live_tools_with_archived_or_noop_triggers() {
    for archived in [true, false] {
        let (_directory, path) = current_database("newer-tool-triggers");
        let db = Connection::open(&path).unwrap();
        if archived {
            let schema: String = db.query_row("SELECT sql FROM sqlite_master WHERE name='messages'", [], |row| row.get(0)).unwrap();
            db.execute_batch("ALTER TABLE messages RENAME TO messages_old").unwrap();
            db.execute_batch(&schema).unwrap();
        } else {
            db.execute_batch(
                "DROP TRIGGER running_tools_insert;
                 DROP TRIGGER running_tools_update_stop;
                 DROP TRIGGER running_tools_update_start;
                 CREATE TRIGGER running_tools_insert AFTER INSERT ON messages BEGIN SELECT 1; END;
                 CREATE TRIGGER running_tools_update_stop AFTER UPDATE ON messages BEGIN SELECT 1; END;
                 CREATE TRIGGER running_tools_update_start AFTER UPDATE ON messages BEGIN SELECT 1; END;",
            ).unwrap();
        }
        db.execute_batch(r#"UPDATE sessions SET status='running';
            INSERT INTO messages(session_id,role,content,tool_id,created_at)
                SELECT id,'tool','{"type":"tool_activity","version":1,"status":"running"}','live',1 FROM sessions;
            PRAGMA user_version=39;"#).unwrap();
        let tracked: i64 = db.query_row("SELECT COUNT(*) FROM running_tools", [], |row| row.get(0)).unwrap();
        assert_eq!(tracked, 0, "fixture: no tracker entry for the live tool");
        let schema_version = |db: &Connection| db.pragma_query_value(None, "schema_version", |row| row.get::<_, i64>(0)).unwrap();
        let before = schema_version(&db);
        let store = Store::open(&path).unwrap();
        let status: String = store.db.query_row("SELECT json_extract(content,'$.status') FROM messages WHERE tool_id='live'", [], |row| row.get(0)).unwrap();
        assert_eq!(status, "failed", "archived={archived}");
        assert_eq!(schema_version(&store.db), before);
        assert!(!store.trackers_usable);
    }
}

#[test]
fn optional_statements_stop_after_sqlite_rollback() {
    let mut db = Connection::open_in_memory().unwrap();
    db.execute_batch("CREATE TABLE guarded(x); CREATE TABLE later(x);").unwrap();
    let tx = db.transaction().unwrap();
    tx.execute_batch("CREATE TRIGGER guarded_full BEFORE INSERT ON guarded BEGIN SELECT RAISE(ROLLBACK, 'disk full'); END;").unwrap();
    let result = run_optional_statements(&tx, "INSERT INTO guarded VALUES(1); INSERT INTO later VALUES(2);", "Test");
    assert!(result.unwrap_err().contains("disk full"));
    assert!(tx.is_autocommit(), "SQLite rolled the transaction back");
    let later: i64 = tx.query_row("SELECT COUNT(*) FROM later", [], |r| r.get(0)).unwrap();
    assert_eq!(later, 0, "the next statement never ran in autocommit mode");
}

/// Forces the transaction rollback SQLite does on an I/O or disk-full error in the
/// optional index step, then fails it the way `run_optional_statements` does.
fn assert_pragmas(db: &Connection, expected_temp_store: i64, expected_cache: i64) {
    let read = |name| db.pragma_query_value(None, name, |row| row.get::<_, i64>(0)).unwrap();
    assert_eq!(read("temp_store"), expected_temp_store);
    assert_eq!(read("cache_size"), expected_cache);
}

fn rolled_back_index_step(repair: &Connection, _missing: MissingIndexes) -> Result<()> {
    assert_pragmas(repair, 1, -65536);
    assert!(!repair.is_autocommit(), "the repair transaction is open");
    repair.execute_batch("ROLLBACK;").unwrap();
    assert!(repair.is_autocommit(), "SQLite rolled the transaction back");
    Err("Restoring a version 38 index: database or disk is full".to_string())
}

#[test]
fn index_only_repair_rollback_does_not_fail_open() {
    // A real `max_page_count` disk-full `CREATE INDEX` rolls back only the statement, so the
    // transaction rollback (I/O errors, some disk-full cases) is forced by the injected step.
    let (_directory, path) = current_database("repair-rollback");
    let mut db = Connection::open(&path).unwrap();
    // (a) Every tracker is present: the rolled-back index repair is skipped and the store opens.
    db.execute_batch("DROP INDEX running_tools_session;").unwrap();
    assert_eq!(repair_v38_objects_with(&mut db, SCHEMA_VERSION, rolled_back_index_step), Ok(()));
    assert!(db.is_autocommit());
    assert_pragmas(&db, 2, -8192);
    assert_eq!(v38_counts(&db), (V38_OBJECTS - 1, V38_TRACKER_OBJECTS, BOT_INDEXES), "nothing was committed");
    // (b) A tracker trigger is missing too: the same rollback fails the repair.
    db.execute_batch("DROP TRIGGER running_tools_insert;").unwrap();
    let error = repair_v38_objects_with(&mut db, SCHEMA_VERSION, rolled_back_index_step).unwrap_err();
    assert!(error.contains("database or disk is full"), "{error}");
    assert!(db.is_autocommit());
    assert_pragmas(&db, 2, -8192);
    assert_eq!(v38_counts(&db), (V38_OBJECTS - 2, V38_TRACKER_OBJECTS - 1, BOT_INDEXES), "nothing was committed");
    // The next open's repair restores both.
    repair_v38_objects(&mut db, SCHEMA_VERSION).unwrap();
    assert_eq!(v38_counts(&db), HEALTHY);
}

#[test]
fn a_lone_legacy_retention_index_is_dropped_once() {
    let (_directory, path) = current_database("legacy-retention-index");
    let mut db = Connection::open(&path).unwrap();
    db.execute_batch("CREATE INDEX turn_changes_retained ON turn_changes(created_at,id) WHERE diff_bytes>0").unwrap();
    Store::open(&path).unwrap();
    let exists: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name='turn_changes_retained')",
        [], |row| row.get(0),
    ).unwrap();
    assert!(!exists);
    super::repair_tests::assert_repair_skips_without_write_lock(&path, &mut db, SCHEMA_VERSION);
}

#[test]
fn migration_and_index_repair_restore_steady_pragmas() {
    let (directory, path) = current_database("repair-pragmas");
    let mut db = Connection::open(&path).unwrap();
    db.execute_batch("DROP INDEX messages_handoffs; DROP INDEX sessions_worktree;").unwrap();
    repair_v38_objects_with(&mut db, SCHEMA_VERSION, |repair, missing| {
        assert!(!repair.is_autocommit());
        assert_pragmas(repair, 1, -65536);
        repair_optional_indexes(repair, missing)
    }).unwrap();
    assert_pragmas(&db, 2, -8192);
    let found: i64 = db.query_row(
        "SELECT count(*) FROM sqlite_schema WHERE type='index' AND name IN ('messages_handoffs','sessions_worktree')",
        [], |row| row.get(0),
    ).unwrap();
    assert_eq!(found, 2);
    assert_pragmas(&Store::open(&path).unwrap().db, 2, -8192);
    assert_pragmas(&Store::open(&directory.0.join("fresh.db")).unwrap().db, 2, -8192);
}

#[test]
fn failed_migration_rolls_back_before_restoring_steady_pragmas() {
    let db = Connection::open_in_memory().unwrap();
    let result = with_migration_pragmas(&db, true, || {
        let migration = Transaction::new_unchecked(&db, TransactionBehavior::Immediate).unwrap();
        assert_pragmas(&migration, 1, -65536);
        migration.execute_batch("CREATE TABLE work(id); CREATE INDEX broken ON work(missing);")
            .map_err(|error| error.to_string())?;
        Ok(())
    });
    assert!(result.unwrap_err().contains("no such column"));
    assert!(db.is_autocommit());
    assert_pragmas(&db, 2, -8192);
}

#[test]
fn newer_schema_repair_skips_the_optional_step() {
    let (_directory, path) = current_database("repair-newer");
    let mut db = Connection::open(&path).unwrap();
    db.execute_batch("DROP INDEX sessions_worktree; DROP TRIGGER running_tools_insert; PRAGMA user_version=39;").unwrap();
    let before = v38_counts(&db);
    let unexpected = |_: &Connection, _: MissingIndexes| panic!("newer schema attempted index repair");
    assert_eq!(repair_v38_objects_with(&mut db, 39, unexpected), Ok(()));
    assert_eq!(v38_counts(&db), before);
}

#[test]
fn hot_queries_use_their_indexes() {
    let (store, _) = empty_session();
    let mut covered = std::collections::BTreeSet::new();
    let mut check = |sql: &str, index: &'static str| -> Vec<String> {
        covered.insert(index);
        assert_plan_uses(&store, sql, index)
    };
    check(PROMPT_ACTIVITY_SQL, "messages_user_activity");
    check(SETTLE_TOOLS_ONE, "running_tools_session");
    check(SETTLE_TOOLS_ACTIVE, "sessions_active_status");
    check(SETTLE_SUBAGENTS_ONE, "sqlite_autoindex_running_subagents_1");
    check(SETTLE_SUBAGENTS_ALL, "sqlite_autoindex_running_subagents_1");
    check(DUE_LIMIT_RESUMES_SQL, "sessions_limit_resume");
    check(IMPORTED_TASK_SQL, "sessions_provider_resume");
    check(USER_TURNS_SQL, "messages_session_conversation");
    check(DISCARD_EMPTY_DRAFTS_SQL, "sessions_draft");
    check(PROJECT_LINKS_SQL, "sessions_project");
    check(INTERRUPT_TEAMS_SQL, "architect_team_meta_status");
    check(LEGACY_PROMPT_CUTOFF_SQL, "architect_team_meta_legacy_cutoff");
    check(COUNT_RESTART_INTERRUPTED_SQL, "sessions_active_status");
    check(RESET_REMOTE_STARTS_SQL, "sessions_remote_pending");
    check(PAUSE_GOALS_SQL, "sessions_active_goal");
    check(SETTLE_ARCHIVED_SQL, "sessions_archived");
    // Launch matching walks only tasks that have a worktree.
    check(&launch_worktrees_sql(), "sessions_worktree");
    check(crate::remote::mirror::CUT_COPIES_SQL, "messages_remote_cut");
    check(crate::architect::REQUESTED_EFFORT_SQL, "architect_requests_worker");
    // The retained diff budget reads the index alone.
    for sql in [crate::turn_changes::RETAINED_BYTES_SQL, crate::turn_changes::RETAINED_ROWS_SQL] {
        let plan = check(sql, "turn_changes_retained_bytes");
        assert!(plan.iter().any(|line| line.contains("COVERING INDEX turn_changes_retained_bytes")), "{plan:#?}");
    }
    // The foreign-key checks when a moodboard, moodboard image or task is deleted.
    check("SELECT 1 FROM message_attachments WHERE moodboard_id=?1", "message_attachments_moodboard");
    check("SELECT 1 FROM message_attachments WHERE moodboard_image_id=?1", "message_attachments_moodboard_image");
    check("SELECT 1 FROM task_schedules WHERE created_by_session=?1", "task_schedules_creator");
    // Bot indexes, against the real statements in `bots::shared_channels`.
    check(crate::bots::shared_channels::MESSAGE_DELIVERIES_SQL, "bot_shared_channel_deliveries_message");
    check(crate::bots::shared_channels::CHANNEL_DELIVERIES_SQL, "bot_shared_channel_deliveries_channel");
    check(crate::bots::shared_channels::OPEN_POSTS_SQL, "bot_shared_channel_deliveries_bot_status");
    // The foreign-key check when a project is deleted.
    check("SELECT 1 FROM bots WHERE project_id=?1", "bots_project");
    // `bots::failover::SWITCHES` is private; its own test checks it reads
    // `bot_activity_model_switch` (`switches_read_only_model_switch_rows_through_the_partial_index`).
    covered.insert("bot_activity_model_switch");
    for name in schema_38_index_names().into_iter().chain(V38_TRACKER_INDEXES).chain(V38_BOT_INDEXES) {
        assert!(covered.contains(name), "{name} has no EXPLAIN QUERY PLAN check");
    }
    // The settle and team recovery statements reach their tables only through the trackers.
    assert_settle_driven_by(&store, LEGACY_PROMPT_CUTOFF_SQL, "architect_team_meta", "architect_teams");
    assert_settle_driven_by(&store, INTERRUPT_TEAMS_SQL, "architect_team_meta", "architect_teams");
}

#[test]
fn the_v38_repair_lists_every_index_it_restores() {
    let mut listed: Vec<&str> = V38_SCHEMA_INDEXES.to_vec();
    let mut created = schema_38_index_names();
    listed.sort_unstable();
    created.sort_unstable();
    assert_eq!(listed, created, "V38_SCHEMA_INDEXES must match SCHEMA_38_INDEXES");
    let mut bot: Vec<&str> = [crate::bots::INDEXES, crate::bots::PROJECT_INDEX]
        .into_iter()
        .flat_map(|sql| sql.split(';'))
        .filter_map(|statement| statement.trim().strip_prefix("CREATE INDEX IF NOT EXISTS "))
        .map(|rest| rest.split_whitespace().next().unwrap())
        .collect();
    let mut listed_bots = V38_BOT_INDEXES.to_vec();
    bot.sort_unstable();
    listed_bots.sort_unstable();
    assert_eq!(listed_bots, bot, "V38_BOT_INDEXES must match bots::INDEXES and PROJECT_INDEX");
    let created_by = |sql: &'static str, kind: &str| -> Vec<&str> {
        let mut names: Vec<&str> = sql
            .split(&format!("CREATE {kind} IF NOT EXISTS "))
            .skip(1)
            .map(|rest| rest.split(|c: char| c.is_whitespace() || c == '(').next().unwrap())
            .collect();
        names.sort_unstable();
        names
    };
    let sorted = |names: &[&'static str]| -> Vec<&'static str> {
        let mut names = names.to_vec();
        names.sort_unstable();
        names
    };
    assert_eq!(created_by(SCHEMA_38_RUNNING, "TABLE"), sorted(&V38_TRACKER_TABLES));
    assert_eq!(created_by(SCHEMA_38_RUNNING, "TRIGGER"), sorted(&V38_TRACKER_TRIGGERS));
    let (store, _) = empty_session();
    assert_eq!(v38_counts(&store.db), HEALTHY, "a new database has every version 38 object");
}

#[test]
fn the_legacy_prompt_cutoff_marks_only_teams_missing_it() {
    let (store, _) = empty_session();
    let project = store.add_project(&std::env::temp_dir()).unwrap();
    let team = |content: &str| -> String {
        let task = store.create_session(&project.id, "claude", "sonnet", "auto").unwrap();
        store.db.execute("INSERT INTO messages(session_id,role,content,created_at) VALUES(?1,'user','hi',1)", [&task.id]).unwrap();
        store.db.execute("INSERT INTO architect_teams(session_id,content) VALUES(?1,?2)", params![task.id, content]).unwrap();
        task.id
    };
    let invalid = team("{broken");
    let missing = team(r#"{"status":"idle"}"#);
    let null = team(r#"{"status":"idle","legacyPromptThroughId":null}"#);
    let zero = team(r#"{"legacyPromptThroughId":0}"#);
    let set = team(r#"{"legacyPromptThroughId":42}"#);
    let text = team(r#"{"legacyPromptThroughId":"7"}"#);
    let pending = || -> i64 { store.db.query_row("SELECT COUNT(*) FROM architect_team_meta WHERE needs_legacy_cutoff=1", [], |r| r.get(0)).unwrap() };
    assert_eq!(pending(), 2, "only the missing key and JSON null are pending");
    Store::record_legacy_prompt_cutoff(&store.db, true).unwrap();
    let content = |sid: &str| -> String { store.db.query_row("SELECT content FROM architect_teams WHERE session_id=?1", [sid], |r| r.get(0)).unwrap() };
    let last_message = |sid: &str| -> i64 { store.db.query_row("SELECT MAX(id) FROM messages WHERE session_id=?1", [sid], |r| r.get(0)).unwrap() };
    let watermark = |sid: &str| -> Option<i64> { store.db.query_row("SELECT json_extract(content,'$.legacyPromptThroughId') FROM architect_teams WHERE session_id=?1", [sid], |r| r.get(0)).unwrap() };
    assert_eq!(content(&invalid), "{broken", "invalid JSON is left untouched");
    assert_eq!(watermark(&missing), Some(last_message(&missing)));
    assert_eq!(watermark(&null), Some(last_message(&null)));
    assert_eq!(content(&zero), r#"{"legacyPromptThroughId":0}"#);
    assert_eq!(content(&set), r#"{"legacyPromptThroughId":42}"#);
    assert_eq!(content(&text), r#"{"legacyPromptThroughId":"7"}"#);
    assert_eq!(pending(), 0, "the partial index is empty once every team is marked");
    assert_plan_uses(&store, LEGACY_PROMPT_CUTOFF_SQL, "architect_team_meta_legacy_cutoff");
    // A stale tracker row never stamps a team that already has its watermark.
    store.db.execute("UPDATE architect_team_meta SET needs_legacy_cutoff=1 WHERE session_id=?1", [&set]).unwrap();
    Store::record_legacy_prompt_cutoff(&store.db, true).unwrap();
    assert_eq!(content(&set), r#"{"legacyPromptThroughId":42}"#);
}

#[test]
fn user_turns_counts_only_user_rows() {
    let (store, task) = empty_session();
    for role in ["user", "assistant", "tool", "user", "error"] {
        store.db.execute("INSERT INTO messages(session_id,role,content,created_at) VALUES(?1,?2,'x',1)", params![task.id, role]).unwrap();
    }
    assert_eq!(store.user_turns(&task.id).unwrap(), 2);
}

#[test]
fn running_tracker_predicates_are_never_null_and_see_escaped_statuses() {
    let (store, task) = empty_session();
    let tracked_tools = || -> i64 { store.db.query_row("SELECT COUNT(*) FROM running_tools WHERE session_id=?1", [&task.id], |r| r.get(0)).unwrap() };
    let tracked_subagents = || -> i64 { store.db.query_row("SELECT COUNT(*) FROM running_subagents WHERE session_id=?1", [&task.id], |r| r.get(0)).unwrap() };
    store.tool_message(&task.id, "t", r#"{"type":"tool_activity","version":1,"status":"running"}"#).unwrap();
    assert_eq!(tracked_tools(), 1);
    // Without `$.type` the JSON test is NULL; the stop trigger must still untrack the row.
    store.db.execute("UPDATE messages SET content=?2 WHERE session_id=?1 AND tool_id='t'", params![task.id, r#"{"version":1,"status":"running"}"#]).unwrap();
    assert_eq!(tracked_tools(), 0, "a snapshot missing $.type is no longer running");
    store.tool_message(&task.id, "t", r#"{"type":"tool_activity","version":1,"status":"running"}"#).unwrap();
    store.db.execute("UPDATE messages SET content=?2 WHERE session_id=?1 AND tool_id='t'", params![task.id, r#"{"type":"tool_activity","status":"running"}"#]).unwrap();
    assert_eq!(tracked_tools(), 0, "a snapshot missing $.version is no longer running");
    // A JSON-escaped status is still a running status.
    let escaped_tool = r#"{"type":"tool_activity","version":1,"status":"\u0072unning"}"#;
    assert!(escaped_tool.contains(r"\u0072unning") && !escaped_tool.contains(r#""running""#));
    store.tool_message(&task.id, "u", escaped_tool).unwrap();
    assert_eq!(tracked_tools(), 1);
    store.tool_message(&task.id, "u", r#"{"type":"tool_activity","version":1,"status":"completed"}"#).unwrap();
    assert_eq!(tracked_tools(), 0);
    let escaped_subagent = r#"{"status":"\u0077aiting"}"#;
    assert!(escaped_subagent.contains(r"\u0077aiting") && !escaped_subagent.contains(r#""waiting""#));
    store.db.execute("INSERT INTO subagents(session_id,id,content,updated_at) VALUES(?1,'s',?2,1)", params![task.id, escaped_subagent]).unwrap();
    assert_eq!(tracked_subagents(), 1);
    store.db.execute("UPDATE subagents SET content='{}' WHERE session_id=?1 AND id='s'", [&task.id]).unwrap();
    assert_eq!(tracked_subagents(), 0, "a snapshot missing $.status is no longer running");
    // A resync removes stale entries as well as adding missing ones.
    store.db.execute("INSERT INTO running_tools(message_id,session_id) SELECT id,session_id FROM messages WHERE session_id=?1 AND tool_id='t'", [&task.id]).unwrap();
    store.db.execute("INSERT INTO running_subagents(session_id,id) VALUES(?1,'s')", [&task.id]).unwrap();
    store.db.execute_batch(SCHEMA_38_RUNNING).unwrap();
    assert_eq!((tracked_tools(), tracked_subagents()), (0, 0));
    // The resync is idempotent: a running row is backfilled once and a second run changes nothing.
    store.tool_message(&task.id, "v", r#"{"type":"tool_activity","version":1,"status":"running"}"#).unwrap();
    store.db.execute("DELETE FROM running_tools WHERE session_id=?1", [&task.id]).unwrap();
    for _ in 0..2 {
        store.db.execute_batch(SCHEMA_38_RUNNING).unwrap();
        assert_eq!((tracked_tools(), tracked_subagents()), (1, 0));
    }
}

/// Asserts a settle statement reads `tracker` and reaches `table` only by primary key.
fn assert_settle_driven_by(store: &Store, sql: &str, tracker: &str, table: &str) {
    let plan = query_plan(store, sql);
    assert!(plan.iter().any(|line| line.contains(tracker)), "{tracker} unused: {plan:#?}");
    let reads: Vec<_> = plan.iter().filter(|line| line.contains(&format!(" {table} ")) || line.ends_with(&format!(" {table}"))).collect();
    assert!(!reads.is_empty(), "{table} not reached: {plan:#?}");
    for line in reads {
        assert!(line.starts_with("SEARCH ") && (line.contains("INTEGER PRIMARY KEY") || line.contains("sqlite_autoindex_")), "{table} not reached by key: {plan:#?}");
    }
}

#[test]
fn settling_is_driven_by_the_running_trackers() {
    let (store, _) = empty_session();
    for sql in [SETTLE_TOOLS_ONE, SETTLE_TOOLS_ACTIVE] {
        assert_settle_driven_by(&store, sql, "running_tools", "messages");
    }
    for sql in [SETTLE_SUBAGENTS_ONE, SETTLE_SUBAGENTS_ALL] {
        assert_settle_driven_by(&store, sql, "running_subagents", "subagents");
    }
}

#[test]
fn resync_refreshes_stale_running_tool_session_and_settle_checks_session() {
    let (store, task) = empty_session();
    let other = store.create_session(&task.project_id, "claude", "sonnet", "auto").unwrap();
    let running = r#"{"type":"tool_activity","version":1,"status":"running"}"#;
    store.tool_message(&task.id, "stale", running).unwrap();
    let message_id = store.db.last_insert_rowid();
    store.db.execute(
        "INSERT OR REPLACE INTO running_tools(message_id,session_id) VALUES(?1,?2)",
        params![message_id, other.id],
    ).unwrap();
    let status = || -> String {
        store.db.query_row(
            "SELECT json_extract(content,'$.status') FROM messages WHERE id=?1",
            [message_id],
            |row| row.get(0),
        ).unwrap()
    };

    store.finish_tools(&other.id).unwrap();
    assert_eq!(status(), "running");

    store.status(&other.id, "running").unwrap();
    settle_unfinished_tools(&store.db, None, "!", true).unwrap();
    assert_eq!(status(), "running", "startup settlement must leave the idle task alone");

    store.db.execute_batch(SCHEMA_38_RUNNING).unwrap();
    let tracked_session: String = store.db.query_row(
        "SELECT session_id FROM running_tools WHERE message_id=?1",
        [message_id],
        |row| row.get(0),
    ).unwrap();
    assert_eq!(tracked_session, task.id);
    store.finish_tools(&task.id).unwrap();
    assert_eq!(status(), "failed");
}

#[test]
fn settling_skips_stale_tracker_rows_of_finished_rows() {
    let (store, task) = empty_session();
    let done_tool = r#"{"type":"tool_activity","version":1,"status":"completed","output":"ok"}"#;
    store.db.execute("INSERT INTO messages(session_id,role,content,created_at,tool_id) VALUES(?1,'tool',?2,1,'done')", params![task.id, done_tool]).unwrap();
    let done_subagent = r#"{"status":"completed","tools":[{"status":"running"}]}"#;
    store.db.execute("INSERT INTO subagents(session_id,id,content,updated_at) VALUES(?1,'done',?2,1)", params![task.id, done_subagent]).unwrap();
    // Stale entries, as a write that bypassed the triggers could leave.
    store.db.execute("INSERT INTO running_tools(message_id,session_id) SELECT id,session_id FROM messages WHERE session_id=?1 AND tool_id='done'", [&task.id]).unwrap();
    store.db.execute("INSERT INTO running_subagents(session_id,id) VALUES(?1,'done')", [&task.id]).unwrap();
    store.finish_tools(&task.id).unwrap();
    store.finish_subagents(&task.id, "stopped").unwrap();
    let tool: String = store.db.query_row("SELECT content FROM messages WHERE session_id=?1 AND tool_id='done'", [&task.id], |r| r.get(0)).unwrap();
    assert_eq!(tool, done_tool, "a completed tool is neither failed nor given the interruption notice");
    let subagent: String = store.db.query_row("SELECT content FROM subagents WHERE session_id=?1 AND id='done'", [&task.id], |r| r.get(0)).unwrap();
    assert_eq!(subagent, done_subagent, "a completed subagent is not stopped");
    store.db.execute("UPDATE sessions SET status='running' WHERE id=?1", [&task.id]).unwrap();
    assert_eq!(store.db.execute(SETTLE_TOOLS_ACTIVE, params![None::<String>, "!"]).unwrap(), 0);
    assert_eq!(store.db.execute(SETTLE_SUBAGENTS_ALL, params![None::<String>, "stopped", 3]).unwrap(), 0);
    // Stale entries pointing at rows the tracker predicate rejects: a non-tool row whose
    // content looks like a running tool, and a tool row missing `$.type` and `$.version`.
    store.db.execute("DELETE FROM running_tools WHERE session_id=?1", [&task.id]).unwrap();
    let lookalike = r#"{"type":"tool_activity","version":1,"status":"running"}"#;
    store.db.execute("INSERT INTO messages(session_id,role,content,created_at) VALUES(?1,'assistant',?2,1)", params![task.id, lookalike]).unwrap();
    let untyped = r#"{"status":"running"}"#;
    store.db.execute("INSERT INTO messages(session_id,role,content,created_at,tool_id) VALUES(?1,'tool',?2,1,'untyped')", params![task.id, untyped]).unwrap();
    let tracked: i64 = store.db.query_row("SELECT COUNT(*) FROM running_tools WHERE session_id=?1", [&task.id], |r| r.get(0)).unwrap();
    assert_eq!(tracked, 0, "the triggers track neither row");
    store.db.execute("INSERT INTO running_tools(message_id,session_id) SELECT id,session_id FROM messages WHERE session_id=?1 AND (role='assistant' OR tool_id='untyped')", [&task.id]).unwrap();
    store.finish_tools(&task.id).unwrap();
    let assistant: String = store.db.query_row("SELECT content FROM messages WHERE session_id=?1 AND role='assistant'", [&task.id], |r| r.get(0)).unwrap();
    assert_eq!(assistant, lookalike, "a non-tool row is never failed");
    let tool: String = store.db.query_row("SELECT content FROM messages WHERE session_id=?1 AND tool_id='untyped'", [&task.id], |r| r.get(0)).unwrap();
    assert_eq!(tool, untyped, "a snapshot missing $.type and $.version is never failed");
}

#[test]
fn running_trackers_follow_raw_writes_settles_and_deletes() {
    let (store, task) = empty_session();
    let count = |sql: &str| -> i64 { store.db.query_row(sql, [&task.id], |r| r.get(0)).unwrap() };
    let tracked_tools = || count("SELECT COUNT(*) FROM running_tools WHERE session_id=?1");
    let tracked_subagents = || count("SELECT COUNT(*) FROM running_subagents WHERE session_id=?1");
    let insert_tool = |tool: &str, content: &str| {
        store.db.execute("INSERT INTO messages(session_id,role,content,created_at,tool_id) VALUES(?1,'tool',?2,1,?3)", params![task.id, content, tool]).unwrap();
    };
    let running = r#"{"type":"tool_activity","version":1,"status":"running"}"#;
    insert_tool("raw", running);
    insert_tool("spaced", r#"{"type": "tool_activity", "version": 1, "status": "running"}"#);
    insert_tool("done", r#"{"type":"tool_activity","version":1,"status":"completed","output":"\"running\""}"#);
    insert_tool("broken", r#"{"status":"running""#);
    store.db.execute("INSERT INTO messages(session_id,role,content,created_at) VALUES(?1,'assistant',?2,1)", params![task.id, running]).unwrap();
    assert_eq!(tracked_tools(), 2, "only valid running tool snapshots are tracked");
    let settle_tools = || store.db.execute(SETTLE_TOOLS_ONE, params![task.id, "!"]).unwrap();
    assert_eq!(settle_tools(), 2);
    assert_eq!(tracked_tools(), 0, "settling clears the tracker");
    assert_eq!(settle_tools(), 0, "a second settle touches no row");
    // An upsert back to running is tracked again; completing or deleting it untracks it.
    store.tool_message(&task.id, "raw", running).unwrap();
    assert_eq!(tracked_tools(), 1);
    store.tool_message(&task.id, "raw", r#"{"type":"tool_activity","version":1,"status":"completed"}"#).unwrap();
    assert_eq!(tracked_tools(), 0);
    store.tool_message(&task.id, "raw", running).unwrap();
    store.db.execute("UPDATE messages SET role='assistant' WHERE session_id=?1 AND tool_id='raw'", [&task.id]).unwrap();
    assert_eq!(tracked_tools(), 0, "a row that stops being a tool is untracked");
    insert_tool("deleted", running);
    store.db.execute("DELETE FROM messages WHERE session_id=?1 AND tool_id='deleted'", [&task.id]).unwrap();
    assert_eq!(tracked_tools(), 0, "deleting a row removes its entry");

    let insert_subagent = |id: &str, status: &str| {
        store.db.execute("INSERT INTO subagents(session_id,id,content,updated_at) VALUES(?1,?2,?3,1)", params![task.id, id, format!(r#"{{"status":"{status}","tools":[{{"status":"running"}}]}}"#)]).unwrap();
    };
    insert_subagent("a", "running");
    insert_subagent("b", "waiting");
    insert_subagent("c", "completed");
    store.db.execute("INSERT INTO subagents(session_id,id,content,updated_at) VALUES(?1,'d','not json \"running\"',1)", [&task.id]).unwrap();
    assert_eq!(tracked_subagents(), 2);
    let settle_subagents = || store.db.execute(SETTLE_SUBAGENTS_ONE, params![task.id, "stopped", 2]).unwrap();
    assert_eq!(settle_subagents(), 2);
    assert_eq!(tracked_subagents(), 0);
    assert_eq!(settle_subagents(), 0, "a second settle touches no row");
    let status: String = store.db.query_row("SELECT json_extract(content,'$.status') FROM subagents WHERE session_id=?1 AND id='a'", [&task.id], |r| r.get(0)).unwrap();
    assert_eq!(status, "stopped");
    insert_subagent("e", "running");
    assert_eq!(store.db.execute(SETTLE_SUBAGENTS_ALL, params![None::<String>, "stopped", 3]).unwrap(), 1);
    assert_eq!(store.db.execute(SETTLE_SUBAGENTS_ALL, params![None::<String>, "stopped", 3]).unwrap(), 0);

    // The migration's backfill rebuilds lost entries and is idempotent.
    insert_tool("again", running);
    insert_subagent("f", "waiting");
    store.db.execute_batch("DELETE FROM running_tools; DELETE FROM running_subagents;").unwrap();
    store.db.execute_batch(SCHEMA_38_RUNNING).unwrap();
    store.db.execute_batch(SCHEMA_38_RUNNING).unwrap();
    assert_eq!((tracked_tools(), tracked_subagents()), (1, 1));
    // Deleting the task cascades through both trackers.
    store.db.execute("DELETE FROM sessions WHERE id=?1", [&task.id]).unwrap();
    assert_eq!((tracked_tools(), tracked_subagents()), (0, 0));
}

#[test]
fn running_tool_tracker_follows_message_session_changes() {
    let (store, source) = empty_session();
    let destination = store.create_session(&source.project_id, "claude", "sonnet", "auto").unwrap();
    let running = r#"{"type":"tool_activity","version":1,"status":"running"}"#;
    store.tool_message(&source.id, "moved", running).unwrap();
    let message_id = store.db.last_insert_rowid();
    let tracked_session = || {
        store.db.query_row("SELECT session_id FROM running_tools WHERE message_id=?1", [message_id], |r| r.get::<_, String>(0)).unwrap()
    };
    assert_eq!(tracked_session(), source.id);
    store.db.execute("UPDATE messages SET session_id=?1 WHERE id=?2", params![destination.id, message_id]).unwrap();
    assert_eq!(tracked_session(), destination.id);
    store.finish_tools(&destination.id).unwrap();
    let status: String = store.db.query_row("SELECT json_extract(content,'$.status') FROM messages WHERE id=?1", [message_id], |r| r.get(0)).unwrap();
    assert_eq!(status, "failed");
}

#[test]
fn repeated_running_upserts_keep_one_tracker_row() {
    let (store, task) = empty_session();
    let count = |sql: &str| -> i64 { store.db.query_row(sql, [&task.id], |r| r.get(0)).unwrap() };
    let running = r#"{"type":"tool_activity","version":1,"status":"running"}"#;
    for _ in 0..3 {
        store.tool_message(&task.id, "same", running).unwrap();
    }
    assert_eq!(count("SELECT COUNT(*) FROM running_tools WHERE session_id=?1"), 1);
    let activity = |status: &str| crate::providers::SubagentActivity { id: "same".into(), parent_id: None, name: "n".into(), prompt: "p".into(), status: status.into(), response: String::new(), tools: Vec::new(), started_at: 1, updated_at: 1 };
    for _ in 0..3 {
        store.save_subagent(&task.id, &activity("running")).unwrap();
    }
    assert_eq!(count("SELECT COUNT(*) FROM running_subagents WHERE session_id=?1"), 1);
    store.tool_message(&task.id, "same", r#"{"type":"tool_activity","version":1,"status":"completed"}"#).unwrap();
    store.save_subagent(&task.id, &activity("completed")).unwrap();
    assert_eq!(count("SELECT COUNT(*) FROM running_tools WHERE session_id=?1"), 0);
    assert_eq!(count("SELECT COUNT(*) FROM running_subagents WHERE session_id=?1"), 0);
    store.tool_message(&task.id, "same", running).unwrap();
    store.save_subagent(&task.id, &activity("running")).unwrap();
    store.finish_tools(&task.id).unwrap();
    store.finish_subagents(&task.id, "stopped").unwrap();
    assert_eq!(count("SELECT COUNT(*) FROM running_tools WHERE session_id=?1"), 0);
    assert_eq!(count("SELECT COUNT(*) FROM running_subagents WHERE session_id=?1"), 0);
    assert_eq!(store.subagent(&task.id, "same").unwrap().unwrap().status, "stopped");
    assert_eq!(store.db.execute(SETTLE_TOOLS_ONE, params![task.id, "!"]).unwrap(), 0);
}

#[test]
fn task_search_reads_each_tasks_messages_once() {
    let (store, _) = empty_session();
    let plan = assert_plan_uses(&store, SEARCH_TASKS_SQL, "sessions_project");
    assert!(plan.iter().any(|line| line.contains("INDEX messages_session_conversation")), "{plan:#?}");
    let lookups = plan.iter().filter(|line| line.contains("CORRELATED SCALAR SUBQUERY")).count();
    assert_eq!(lookups, 1, "the newest matching message is looked up once per task: {plan:#?}");
    assert!(!plan.iter().any(|line| line.contains("TEMP B-TREE")), "the outer ORDER BY keeps the index order, so LIMIT stops early: {plan:#?}");
}

#[test]
fn settling_touches_only_running_rows_of_the_chosen_tasks() {
    let (store, task) = empty_session();
    let other = store.create_session(&task.project_id, "claude", "sonnet", "auto").unwrap();
    let running = |n: u32| format!(r#"{{"type":"tool_activity","version":1,"status":"running","output":"{n}"}}"#);
    for sid in [&task.id, &other.id] {
        store.tool_message(sid, "a", &running(1)).unwrap();
        store.tool_message(sid, "b", r#"{"type":"tool_activity","version":1,"status":"completed"}"#).unwrap();
    }
    store.tool_message(&task.id, "c", "not json").unwrap();
    store.finish_tools(&task.id).unwrap();
    let tool = |sid: &str, tool: &str| -> String { store.db.query_row("SELECT content FROM messages WHERE session_id=?1 AND tool_id=?2", [sid, tool], |r| r.get(0)).unwrap() };
    let settled: serde_json::Value = serde_json::from_str(&tool(&task.id, "a")).unwrap();
    assert_eq!(settled["status"], "failed");
    assert!(settled["output"].as_str().unwrap().starts_with("1\n\n[The turn ended"));
    assert!(tool(&task.id, "b").contains("completed"));
    assert_eq!(tool(&task.id, "c"), "not json");
    assert!(tool(&other.id, "a").contains("running"), "another task's tools are left alone");
    // Startup settles only tasks still marked running or waiting.
    store.status(&other.id, "running").unwrap();
    settle_unfinished_tools(&store.db, None, "!", true).unwrap();
    assert!(tool(&other.id, "a").contains("failed"));
    let activity = |id: &str, status: &str| crate::providers::SubagentActivity { id: id.into(), parent_id: None, name: "n".into(), prompt: "p".into(), status: status.into(), response: String::new(), tools: Vec::new(), started_at: 1, updated_at: 1 };
    store.save_subagent(&task.id, &activity("x", "running")).unwrap();
    store.save_subagent(&task.id, &activity("y", "completed")).unwrap();
    store.save_subagent(&other.id, &activity("z", "waiting")).unwrap();
    store.finish_subagents(&task.id, "stopped").unwrap();
    assert_eq!(store.subagent(&task.id, "x").unwrap().unwrap().status, "stopped");
    assert_eq!(store.subagent(&task.id, "y").unwrap().unwrap().status, "completed");
    assert_eq!(store.subagent(&other.id, "z").unwrap().unwrap().status, "waiting");
    settle_unfinished_subagents(&store.db, None, "stopped", true).unwrap();
    assert_eq!(store.subagent(&other.id, "z").unwrap().unwrap().status, "stopped");
}
