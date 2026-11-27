//! `repair_v38_objects` and `Store::open` on databases missing version 38 objects: tracker
//! rebuilds, optional index repair, rollbacks, legacy `bots` tables and newer schemas.

use super::super::*;
use super::tests::{current_database, schema_38_index_names, v38_counts, TempDir, BOT_INDEXES, HEALTHY};
use super::*;

/// A file database with one running task holding running tool and subagent rows that no
/// tracker knows about: its triggers and tables are dropped and `user_version` is set.
fn database_without_trackers(version: i64) -> (TempDir, std::path::PathBuf, String) {
    let directory = TempDir::new("trackers");
    let path = directory.0.join("store.db");
    let sid = {
        let store = Store::open(&path).unwrap();
        let project = store.add_project(&std::env::temp_dir()).unwrap();
        let task = store.create_session(&project.id, "claude", "sonnet", "auto").unwrap();
        store.db.execute("UPDATE sessions SET status='running' WHERE id=?1", [&task.id]).unwrap();
        task.id
    };
    let db = Connection::open(&path).unwrap();
    db.execute_batch("DROP TRIGGER running_tools_insert; DROP TRIGGER running_tools_update_start; DROP TRIGGER running_tools_update_stop;
        DROP TRIGGER running_subagents_insert; DROP TRIGGER running_subagents_update_start; DROP TRIGGER running_subagents_update_stop;
        DROP TABLE running_tools; DROP TABLE running_subagents;
        DROP TRIGGER architect_team_meta_insert; DROP TRIGGER architect_team_meta_update_clear; DROP TRIGGER architect_team_meta_update_sync;
        DROP TABLE architect_team_meta;").unwrap();
    seed_running_rows(&db, &sid);
    db.pragma_update(None, "user_version", version).unwrap();
    (directory, path, sid)
}

fn seed_running_rows(db: &Connection, sid: &str) {
    db.execute("INSERT INTO architect_teams(session_id,content) VALUES(?1,?2)", params![sid, r#"{"status":"running","workers":[]}"#]).unwrap();
    let tool = |tool: &str, content: &str| {
        db.execute("INSERT INTO messages(session_id,role,content,created_at,tool_id) VALUES(?1,'tool',?2,1,?3)", params![sid, content, tool]).unwrap();
    };
    tool("plain", r#"{"type":"tool_activity","version":1,"status":"running"}"#);
    let escaped = r#"{"type":"tool_activity","version":1,"status":"\u0072unning"}"#;
    assert!(escaped.contains(r"\u0072unning") && !escaped.contains(r#""running""#));
    tool("escaped", escaped);
    tool("corrupt", r#"{"type":"tool_activity","status":"running""#);
    tool("done", r#"{"type":"tool_activity","version":1,"status":"completed"}"#);
    let subagent = |id: &str, content: &str| {
        db.execute("INSERT INTO subagents(session_id,id,content,updated_at) VALUES(?1,?2,?3,1)", params![sid, id, content]).unwrap();
    };
    subagent("running", r#"{"status":"running","tools":[{"status":"running"}]}"#);
    subagent("waiting", r#"{"status":"waiting","tools":[]}"#);
    let escaped = r#"{"status":"\u0077aiting","tools":[]}"#;
    assert!(escaped.contains(r"\u0077aiting") && !escaped.contains(r#""waiting""#) && !escaped.contains(r#""running""#));
    subagent("escaped", escaped);
    subagent("corrupt", r#"{"status":"running""#);
    subagent("done", r#"{"status":"completed","tools":[]}"#);
}

/// Asserts `Store::open` rebuilt the trackers and settled every running row of `sid`.
fn assert_trackers_rebuilt_and_settled(store: &Store, sid: &str) {
    let triggers: i64 = store.db.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name IN ('running_tools_insert','running_tools_update_start','running_tools_update_stop','running_subagents_insert','running_subagents_update_start','running_subagents_update_stop')", [], |r| r.get(0)).unwrap();
    assert_eq!(triggers, 6);
    let tracked: (i64, i64) = store.db.query_row("SELECT (SELECT COUNT(*) FROM running_tools),(SELECT COUNT(*) FROM running_subagents)", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
    assert_eq!(tracked, (0, 0), "startup recovery settled every tracked row");
    let team: (Option<String>, i64) = store.db.query_row("SELECT status,needs_legacy_cutoff FROM architect_team_meta WHERE session_id=?1", [sid], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
    assert_eq!(team, (Some("interrupted".into()), 0), "the rebuilt team tracker reflects recovery");
    assert_running_rows_settled(store, sid);
    // The rebuilt triggers track new writes.
    store.tool_message(sid, "after", r#"{"type":"tool_activity","version":1,"status":"running"}"#).unwrap();
    let tracked: i64 = store.db.query_row("SELECT COUNT(*) FROM running_tools WHERE session_id=?1", [sid], |r| r.get(0)).unwrap();
    assert_eq!(tracked, 1);
}

fn assert_running_rows_settled(store: &Store, sid: &str) {
    assert_tools_and_team_settled(store, sid);
    let subagent_status = |id: &str| -> Option<String> {
        store.db.query_row("SELECT CASE WHEN json_valid(content) THEN json_extract(content,'$.status') END FROM subagents WHERE session_id=?1 AND id=?2", params![sid, id], |r| r.get(0)).unwrap()
    };
    assert_eq!(subagent_status("running").as_deref(), Some("stopped"));
    assert_eq!(subagent_status("waiting").as_deref(), Some("stopped"));
    assert_eq!(subagent_status("escaped").as_deref(), Some("stopped"));
    assert_eq!(subagent_status("corrupt"), None);
    assert_eq!(subagent_status("done").as_deref(), Some("completed"));
}

fn assert_tools_and_team_settled(store: &Store, sid: &str) {
    let tool_status = |tool: &str| -> Option<String> {
        store.db.query_row("SELECT CASE WHEN json_valid(content) THEN json_extract(content,'$.status') END FROM messages WHERE session_id=?1 AND tool_id=?2", params![sid, tool], |r| r.get(0)).unwrap()
    };
    assert_eq!(tool_status("plain").as_deref(), Some("failed"));
    assert_eq!(tool_status("escaped").as_deref(), Some("failed"), "a JSON-escaped status is tracked too");
    assert_eq!(tool_status("corrupt"), None, "corrupt JSON is left alone");
    assert_eq!(tool_status("done").as_deref(), Some("completed"));
    assert_eq!(store.session(sid).unwrap().status, "interrupted");
    let team: (String, bool) = store.db.query_row(
        "SELECT json_extract(content,'$.status'),json_extract(content,'$.legacyPromptThroughId')=(SELECT MAX(id) FROM messages WHERE session_id=?1) FROM architect_teams WHERE session_id=?1",
        [sid], |r| Ok((r.get(0)?, r.get(1)?)),
    ).unwrap();
    assert_eq!(team, ("interrupted".into(), true));
}

#[test]
fn upgrading_from_version_37_backfills_trackers_and_settles_running_rows() {
    let (_directory, path, sid) = database_without_trackers(SCHEMA_VERSION);
    let db = Connection::open(&path).unwrap();
    for name in schema_38_index_names() {
        db.execute_batch(&format!("DROP INDEX {name};")).unwrap();
    }
    db.execute_batch("DROP INDEX bot_activity_model_switch; DROP INDEX bots_project;
        CREATE INDEX turn_changes_retained ON turn_changes(created_at,id) WHERE diff_bytes>0;").unwrap();
    drop(db);
    let store = Store::open(&path).unwrap();
    assert_eq!(store.db.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0)).unwrap(), SCHEMA_VERSION);
    assert_trackers_rebuilt_and_settled(&store, &sid);
    for index in ["sessions_worktree", "messages_session_conversation", "bot_activity_model_switch", "bots_project"] {
        let exists: bool = store.db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='index' AND name=?1)", [index], |r| r.get(0)).unwrap();
        assert!(exists, "{index} missing after the upgrade");
    }
    let superseded: bool = store.db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='turn_changes_retained')", [], |r| r.get(0)).unwrap();
    assert!(!superseded, "the upgrade drops turn_changes_retained");
}

#[test]
fn opening_a_current_database_without_trackers_recreates_them() {
    let (_directory, path, sid) = database_without_trackers(SCHEMA_VERSION);
    Connection::open(&path).unwrap().execute_batch("DROP INDEX sessions_worktree; DROP INDEX turn_changes_retained_bytes;
        DROP INDEX bot_activity_model_switch; DROP INDEX bots_project;").unwrap();
    let store = Store::open(&path).unwrap();
    assert_eq!(store.db.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0)).unwrap(), SCHEMA_VERSION);
    assert_trackers_rebuilt_and_settled(&store, &sid);
    assert_eq!(v38_counts(&store.db), HEALTHY);
}

#[test]
fn a_missing_index_is_restored_without_resyncing_the_trackers() {
    let (_directory, path) = current_database("index-heal");
    let trigger_row = |db: &Connection| -> i64 { db.query_row("SELECT rowid FROM sqlite_master WHERE name='running_tools_insert'", [], |r| r.get(0)).unwrap() };
    let before = {
        let db = Connection::open(&path).unwrap();
        db.execute_batch("DROP INDEX sessions_draft; DROP INDEX bot_shared_channel_deliveries_channel;").unwrap();
        assert_eq!(v38_counts(&db), (V38_OBJECTS - 2, V38_TRACKER_OBJECTS, BOT_INDEXES - 1));
        trigger_row(&db)
    };
    let store = Store::open(&path).unwrap();
    assert_eq!(v38_counts(&store.db), HEALTHY);
    assert_eq!(trigger_row(&store.db), before, "the triggers were not recreated");
    drop(store);
    // A tracker index is optional too.
    Connection::open(&path).unwrap().execute_batch("DROP INDEX running_tools_session;").unwrap();
    let store = Store::open(&path).unwrap();
    assert_eq!(v38_counts(&store.db), HEALTHY);
    assert_eq!(trigger_row(&store.db), before, "tracker index repair leaves triggers in place");
}

#[test]
fn a_bots_table_without_project_id_is_healthy_without_bots_project() {
    let (_directory, path) = current_database("bots-legacy");
    Connection::open(&path).unwrap().execute_batch("PRAGMA foreign_keys=OFF; DROP TABLE bots; CREATE TABLE bots(id TEXT PRIMARY KEY, name TEXT NOT NULL);").unwrap();
    let store = Store::open(&path).unwrap();
    assert_eq!(v38_counts(&store.db), (V38_OBJECTS - 1, V38_TRACKER_OBJECTS, BOT_INDEXES - 1), "bots_project is skipped, nothing else is missing");
    drop(store);
    Connection::open(&path).unwrap().execute_batch("DROP INDEX sessions_draft;").unwrap();
    let store = Store::open(&path).unwrap();
    assert_eq!(v38_counts(&store.db), (V38_OBJECTS - 1, V38_TRACKER_OBJECTS, BOT_INDEXES - 1), "the missing index is back");
    let has_project_index: bool = store.db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='bots_project')", [], |r| r.get(0)).unwrap();
    assert!(!has_project_index);
}

#[test]
fn opening_a_database_with_a_misattached_tracker_trigger_repairs_it() {
    assert_tracker_trigger_repaired("subagents");
}

#[test]
fn opening_a_database_with_a_same_parent_noop_trigger_repairs_it() {
    assert_tracker_trigger_repaired("messages");
}

fn assert_tracker_trigger_repaired(parent: &str) {
    let directory = TempDir::new("trigger-heal");
    let path = directory.0.join("store.db");
    let sid = {
        let store = Store::open(&path).unwrap();
        let project = store.add_project(&std::env::temp_dir()).unwrap();
        store.create_session(&project.id, "claude", "sonnet", "auto").unwrap().id
    };
    let trigger_sql = |db: &Connection| -> String {
        db.query_row("SELECT sql FROM sqlite_master WHERE name='running_tools_insert'", [], |r| r.get(0)).unwrap()
    };
    let db = Connection::open(&path).unwrap();
    let expected = trigger_sql(&db);
    db.execute_batch(&format!(
        "DROP TRIGGER running_tools_insert;
         CREATE TRIGGER running_tools_insert AFTER INSERT ON {parent} BEGIN SELECT 1; END;",
    )).unwrap();
    drop(db);
    let store = Store::open(&path).unwrap();
    assert_eq!(trigger_sql(&store.db), expected);
    assert_eq!(v38_counts(&store.db), HEALTHY, "every tracker table, index and all nine triggers are back");
    // SQLite fires the newest trigger first, so each stop trigger is created before its start,
    // and the team tracker's clear trigger before its sync trigger.
    let created = |name: &str| -> i64 { store.db.query_row("SELECT rowid FROM sqlite_master WHERE name=?1", [name], |r| r.get(0)).unwrap() };
    assert!(created("running_tools_update_stop") < created("running_tools_update_start"));
    assert!(created("running_subagents_update_stop") < created("running_subagents_update_start"));
    assert!(created("architect_team_meta_update_clear") < created("architect_team_meta_update_sync"));
    let tracked = || -> i64 { store.db.query_row("SELECT COUNT(*) FROM running_tools WHERE session_id=?1", [&sid], |r| r.get(0)).unwrap() };
    store.db.execute("INSERT INTO messages(session_id,role,content,created_at,tool_id) VALUES(?1,'tool',?2,1,'raw')", params![sid, r#"{"type":"tool_activity","version":1,"status":"running"}"#]).unwrap();
    assert_eq!(tracked(), 1, "the restored insert trigger tracks a running tool");
    store.finish_tools(&sid).unwrap();
    assert_eq!(tracked(), 0, "settling untracks it");
    let status: String = store.db.query_row("SELECT json_extract(content,'$.status') FROM messages WHERE session_id=?1 AND tool_id='raw'", [&sid], |r| r.get(0)).unwrap();
    assert_eq!(status, "failed");
}

#[test]
fn opening_a_newer_database_without_trackers_leaves_its_schema_untouched() {
    let (_directory, path, sid) = database_without_trackers(39);
    let db = Connection::open(&path).unwrap();
    db.execute_batch("CREATE INDEX turn_changes_retained ON turn_changes(created_at,id) WHERE diff_bytes>0;
        DROP INDEX sessions_worktree; DROP INDEX turn_changes_retained_bytes; DROP INDEX messages_handoffs;
        UPDATE sessions SET sidebar_order=0;").unwrap();
    let schema_version = |db: &Connection| db.pragma_query_value(None, "schema_version", |r| r.get::<_, i64>(0)).unwrap();
    let before = schema_version(&db);
    let store = Store::open(&path).unwrap();
    assert_eq!(store.db.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0)).unwrap(), 39);
    assert_eq!(schema_version(&store.db), before, "startup did not change the newer schema");
    let temp_objects = store.db.prepare("SELECT type, name FROM sqlite_temp_master").unwrap()
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))).unwrap()
        .collect::<rusqlite::Result<Vec<_>>>().unwrap();
    assert_eq!(temp_objects, [("trigger".to_owned(), "rank_published_draft".to_owned())]);
    assert!(has_object(&store.db, "turn_changes_retained"));
    assert!(!store.trackers_usable);
    assert_running_rows_settled(&store, &sid);
}

#[test]
fn an_index_that_cannot_be_rebuilt_never_stops_the_store_opening() {
    let (_directory, path) = current_database("index-blocked");
    // A table holding an index's name makes its `CREATE INDEX` fail.
    // Indexes listed after it in `SCHEMA_38_INDEXES` are dropped too, and must still come back.
    Connection::open(&path).unwrap().execute_batch("DROP INDEX sessions_draft; CREATE TABLE sessions_draft(x);
        DROP INDEX sessions_archived; DROP INDEX messages_remote_cut; DROP INDEX task_schedules_creator;").unwrap();
    let store = Store::open(&path).unwrap();
    assert_eq!(v38_counts(&store.db).1, V38_TRACKER_OBJECTS, "the trackers are intact");
    for name in ["sessions_archived", "messages_remote_cut", "task_schedules_creator"] {
        let restored: bool = store.db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='index' AND name=?1)", [name], |r| r.get(0)).unwrap();
        assert!(restored, "{name} is restored after the blocked sessions_draft");
    }
    drop(store);
    // A missing tracker is still restored alongside the failing index.
    Connection::open(&path).unwrap().execute_batch("DROP TRIGGER architect_team_meta_insert;").unwrap();
    let store = Store::open(&path).unwrap();
    assert_eq!(v38_counts(&store.db).1, V38_TRACKER_OBJECTS, "the missing trigger is back");
}

/// The columns of `bots`, in order.
fn bot_columns(db: &Connection) -> Vec<String> {
    let mut statement = db.prepare("SELECT name FROM pragma_table_info('bots')").unwrap();
    statement.query_map([], |r| r.get(0)).unwrap().collect::<rusqlite::Result<_>>().unwrap()
}

#[test]
fn repair_skips_bots_upgrade_when_only_schema_index_blocked_and_never_alters_newer_schema() {
    // (a) Every bot index is present and only a (blocked) schema index is missing: the legacy
    // `bots` table, which lacks `bots::upgrade`'s added columns, is not altered.
    let (_directory, path) = current_database("bots-untouched");
    let mut db = Connection::open(&path).unwrap();
    db.execute_batch("PRAGMA foreign_keys=OFF; DROP TABLE bots; CREATE TABLE bots(id TEXT PRIMARY KEY, name TEXT NOT NULL, project_id TEXT);
        CREATE INDEX bots_project ON bots(project_id); DROP INDEX sessions_draft; CREATE TABLE sessions_draft(x);").unwrap();
    let legacy = bot_columns(&db);
    assert_eq!(v38_counts(&db), (V38_OBJECTS - 1, V38_TRACKER_OBJECTS, BOT_INDEXES));
    repair_v38_objects(&mut db, SCHEMA_VERSION).unwrap();
    assert_eq!(bot_columns(&db), legacy, "bots::upgrade never ran");
    assert_eq!(v38_counts(&db), (V38_OBJECTS - 1, V38_TRACKER_OBJECTS, BOT_INDEXES));
    // (b) A newer schema leaves the missing bot index and legacy columns alone.
    db.execute_batch("DROP INDEX bot_activity_model_switch; PRAGMA user_version=39;").unwrap();
    repair_v38_objects(&mut db, 39).unwrap();
    let present: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='index' AND name='bot_activity_model_switch')", [], |r| r.get(0)).unwrap();
    assert!(!present, "the newer schema did not get the v38 index");
    assert_eq!(bot_columns(&db), legacy, "a newer schema's bots table is never altered");
    // The same database at this version gets the columns `bots::upgrade` adds.
    db.pragma_update(None, "user_version", SCHEMA_VERSION).unwrap();
    repair_v38_objects(&mut db, SCHEMA_VERSION).unwrap();
    assert!(bot_columns(&db).len() > legacy.len(), "bots::upgrade ran below a newer schema");
}

#[test]
fn index_only_repair_skips_when_locked_while_tracker_repair_fails() {
    let (_directory, path) = current_database("repair-locked");
    let mut db = Connection::open(&path).unwrap();
    db.busy_timeout(std::time::Duration::ZERO).unwrap();
    let writer = Connection::open(&path).unwrap();
    // (a) Only an optional index is missing: a held write lock skips the repair, never fails it.
    db.execute_batch("DROP INDEX sessions_worktree;").unwrap();
    writer.execute_batch("BEGIN IMMEDIATE;").unwrap();
    assert_eq!(repair_v38_objects(&mut db, SCHEMA_VERSION), Ok(()));
    writer.execute_batch("COMMIT;").unwrap();
    assert_eq!(v38_counts(&db), (V38_OBJECTS - 1, V38_TRACKER_OBJECTS, BOT_INDEXES), "the index is still missing");
    // (b) A missing tracker trigger is required, so the same lock fails the repair.
    db.execute_batch("DROP TRIGGER running_tools_insert;").unwrap();
    writer.execute_batch("BEGIN IMMEDIATE;").unwrap();
    assert!(repair_v38_objects(&mut db, SCHEMA_VERSION).is_err(), "tracker repair stays fatal");
    writer.execute_batch("COMMIT;").unwrap();
    // Once the lock is released, both come back.
    repair_v38_objects(&mut db, SCHEMA_VERSION).unwrap();
    assert_eq!(v38_counts(&db), HEALTHY);
}

/// Whether `sqlite_master` has an object named `name`.
fn has_object(db: &Connection, name: &str) -> bool {
    db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name=?1)", [name], |r| r.get(0)).unwrap()
}

#[test]
fn repair_skips_incompatible_tracker_rebuild_on_newer_schema() {
    // A newer schema without `subagents` (dropping it took its tracker triggers along), where
    // `SCHEMA_38_RUNNING` cannot run, plus a missing optional index.
    let (_directory, path) = current_database("newer-trackers");
    let mut db = Connection::open(&path).unwrap();
    db.execute_batch("PRAGMA foreign_keys=OFF; DROP TABLE subagents; DROP INDEX sessions_worktree; PRAGMA user_version=39;").unwrap();
    let broken = v38_counts(&db);
    assert!(broken.1 < V38_TRACKER_OBJECTS, "a tracker object is missing: {broken:?}");
    {
        let probe = db.unchecked_transaction().unwrap();
        assert!(probe.execute_batch(SCHEMA_38_RUNNING).is_err(), "the tracker rebuild cannot succeed");
    }
    // The newer schema skips even the buildable index without asking for a write lock.
    assert_eq!(repair_v38_objects(&mut db, 39), Ok(()));
    assert!(db.is_autocommit());
    assert!(has_object(&db, "running_tools_insert"), "the failed rebuild was rolled back");
    assert_eq!(v38_counts(&db), broken, "no schema object changed");
    assert_repair_skips_without_write_lock(&path, &mut db, 39);
    // At this binary's own version the same broken state fails the open.
    db.pragma_update(None, "user_version", SCHEMA_VERSION).unwrap();
    assert!(repair_v38_objects(&mut db, SCHEMA_VERSION).is_err(), "tracker repair stays fatal");
    assert!(has_object(&db, "running_tools_insert"), "the failed repair committed nothing");
}

#[test]
fn repair_bot_indexes_restores_indexes_even_when_upgrade_alter_fails() {
    // An index named `bot_rules` makes `bots::upgrade` fail before adding columns or indexes;
    // `repair_bot_indexes` still restores every bot index individually.
    let (_directory, path) = current_database("bots-alter-fails");
    let mut db = Connection::open(&path).unwrap();
    db.execute_batch("ALTER TABLE bots DROP COLUMN color; DROP TABLE IF EXISTS bot_rules; CREATE INDEX bot_rules ON projects(id);").unwrap();
    for index in V38_BOT_INDEXES { db.execute_batch(&format!("DROP INDEX {index};")).unwrap(); }
    let legacy = bot_columns(&db);
    {
        let probe = db.unchecked_transaction().unwrap();
        let error = crate::bots::upgrade(&probe).expect_err("bots::upgrade fails at SCHEMA_TABLES");
        assert!(error.contains("there is already an index named bot_rules"), "{error}");
        assert!(!probe.is_autocommit(), "the failure left the transaction open");
    }
    assert_eq!(v38_counts(&db).2, 0);
    repair_v38_objects(&mut db, SCHEMA_VERSION).unwrap();
    assert_eq!(bot_columns(&db), legacy, "bots::upgrade rolled back before adding color");
    for index in V38_BOT_INDEXES { verify_index(&db, index); }
    assert_eq!(v38_counts(&db), HEALTHY);
}

#[test]
fn newer_schema_settles_tools_and_teams_when_subagents_was_dropped() {
    let (_directory, path, sid) = database_without_trackers(39);
    Connection::open(&path).unwrap().execute_batch("PRAGMA foreign_keys=OFF; DROP TABLE subagents;").unwrap();
    let store = Store::open(&path).unwrap();
    assert!(!has_object(&store.db, "subagents"));
    assert!(!store.trackers_usable);
    assert_tools_and_team_settled(&store, &sid);
    drop(store);

    Connection::open(&path).unwrap().pragma_update(None, "user_version", SCHEMA_VERSION).unwrap();
    assert!(Store::open(&path).is_err(), "a missing parent stays fatal at v38");
}

thread_local! {
    /// How often SQLite called `count_busy`'s busy handler on this thread.
    static BUSY_CALLS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// A busy handler that never waits (as `busy_timeout(0)`) and counts its calls.
fn count_busy(_attempt: i32) -> bool {
    BUSY_CALLS.with(|calls| calls.set(calls.get() + 1));
    false
}

/// Asserts `repair_v38_objects(db, version)` returns `Ok(())` without even trying the write lock
/// while another connection to `path` holds `BEGIN IMMEDIATE`.
pub(super) fn assert_repair_skips_without_write_lock(path: &std::path::Path, db: &mut Connection, version: i64) {
    db.busy_timeout(std::time::Duration::ZERO).unwrap();
    db.busy_handler(Some(count_busy)).unwrap();
    let writer = Connection::open(path).unwrap();
    writer.execute_batch("BEGIN IMMEDIATE;").unwrap();
    BUSY_CALLS.with(|calls| calls.set(0));
    let before = v38_counts(db);
    let started = std::time::Instant::now();
    assert_eq!(repair_v38_objects(db, version), Ok(()));
    assert!(started.elapsed() < std::time::Duration::from_secs(1), "the repair never waited");
    assert_eq!(BUSY_CALLS.with(|calls| calls.get()), 0, "the repair never asked for the write lock");
    assert!(db.is_autocommit());
    assert_eq!(v38_counts(db), before, "nothing was retried");
    // The probe works: a real write attempt under the same lock hits the busy handler.
    assert!(db.execute_batch("BEGIN IMMEDIATE;").is_err());
    assert!(BUSY_CALLS.with(|calls| calls.get()) > 0, "the busy handler sees lock attempts");
    writer.execute_batch("COMMIT;").unwrap();
    db.busy_handler(None).unwrap();
}

#[test]
fn v38_open_survives_colliding_tracker_index_name() {
    let (_directory, path) = current_database("tracker-index-collision");
    let mut db = Connection::open(&path).unwrap();
    db.execute_batch("DROP INDEX running_tools_session; CREATE VIEW running_tools_session AS SELECT 1;").unwrap();

    let store = Store::open(&path).unwrap();
    let sid: String = store.db.query_row("SELECT id FROM sessions", [], |r| r.get(0)).unwrap();
    store.tool_message(&sid, "running", r#"{"type":"tool_activity","version":1,"status":"running"}"#).unwrap();
    let tracked: i64 = store.db.query_row("SELECT COUNT(*) FROM running_tools WHERE session_id=?1", [&sid], |r| r.get(0)).unwrap();
    assert_eq!(tracked, 1);
    drop(store);
    assert_repair_skips_without_write_lock(&path, &mut db, SCHEMA_VERSION);
    Store::open(&path).unwrap();

    db.execute_batch("DROP TRIGGER running_tools_insert; DROP INDEX architect_team_meta_status;").unwrap();
    let store = Store::open(&path).unwrap();
    assert!(has_object(&store.db, "running_tools_insert"));
    verify_index(&store.db, "architect_team_meta_status");
    let view: i64 = store.db.query_row("SELECT * FROM running_tools_session", [], |r| r.get(0)).unwrap();
    assert_eq!(view, 1);
}

fn verify_index(db: &Connection, index: &str) {
    let present: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='index' AND name=?1)", [index], |r| r.get(0)).unwrap();
    assert!(present, "{index} was not restored");
}

#[test]
fn permanently_blocked_indexes_are_not_retried_on_later_opens() {
    let (_directory, path) = current_database("blocked-retry");
    let mut db = Connection::open(&path).unwrap();
    // `bots` without `project_id` never gets `bots_project`, and a table named
    // `sessions_draft` blocks that index forever; the other dropped indexes can be rebuilt.
    db.execute_batch("PRAGMA foreign_keys=OFF; DROP TABLE bots; CREATE TABLE bots(id TEXT PRIMARY KEY, name TEXT NOT NULL);
        DROP INDEX sessions_draft; CREATE TABLE sessions_draft(x);
        DROP INDEX sessions_worktree; DROP INDEX task_schedules_creator; DROP INDEX bot_activity_model_switch;").unwrap();
    repair_v38_objects(&mut db, SCHEMA_VERSION).unwrap();
    for name in ["sessions_worktree", "task_schedules_creator", "bot_activity_model_switch"] {
        let restored: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='index' AND name=?1)", [name], |r| r.get(0)).unwrap();
        assert!(restored, "{name} is restored");
    }
    assert!(!has_object(&db, "bots_project"));
    assert_eq!(v38_counts(&db), (V38_OBJECTS - 2, V38_TRACKER_OBJECTS, BOT_INDEXES - 1), "only the two unbuildable indexes are missing");
    assert_repair_skips_without_write_lock(&path, &mut db, SCHEMA_VERSION);
}

#[test]
fn index_prereqs_cover_every_v38_index_once() {
    let names = |prereqs: &[IndexPrereq]| prereqs.iter().map(|index| index.name).collect::<Vec<_>>();
    assert_eq!(names(&SCHEMA_INDEX_PREREQS), V38_SCHEMA_INDEXES);
    assert_eq!(names(&BOT_INDEX_PREREQS), V38_BOT_INDEXES);
    assert_eq!(names(&TRACKER_INDEX_PREREQS), V38_TRACKER_INDEXES);
    for (statement, index) in SCHEMA_38_TRACKER_INDEXES.iter().zip(&TRACKER_INDEX_PREREQS) {
        assert!(statement.starts_with(&format!("CREATE INDEX IF NOT EXISTS {} ON {}(", index.name, index.table)));
    }
    let statements: Vec<&str> = [SCHEMA_38_INDEXES, crate::bots::INDEXES, crate::bots::PROJECT_INDEX]
        .into_iter()
        .chain(SCHEMA_38_TRACKER_INDEXES)
        .flat_map(|sql| sql.split(';'))
        .map(str::trim)
        .filter(|statement| !statement.is_empty())
        .collect();
    assert_eq!(statements.len(), SCHEMA_INDEX_PREREQS.len() + BOT_INDEX_PREREQS.len() + TRACKER_INDEX_PREREQS.len());
    for index in SCHEMA_INDEX_PREREQS.iter().chain(&BOT_INDEX_PREREQS).chain(&TRACKER_INDEX_PREREQS) {
        let head = format!("CREATE INDEX IF NOT EXISTS {} ON {}(", index.name, index.table);
        let matching: Vec<&&str> = statements.iter().filter(|statement| statement.starts_with(&head)).collect();
        assert_eq!(matching.len(), 1, "{} has exactly one statement on {}", index.name, index.table);
        for column in index.columns {
            assert!(matching[0].contains(column), "{} uses {column}", index.name);
        }
    }
}

#[test]
fn a_trigger_with_an_index_name_does_not_block_repair() {
    let (_directory, path) = current_database("trigger-index-name");
    let mut db = Connection::open(&path).unwrap();
    db.execute_batch("DROP INDEX bots_project;
        CREATE TRIGGER bots_project AFTER INSERT ON projects BEGIN SELECT 1; END;").unwrap();
    repair_v38_objects(&mut db, SCHEMA_VERSION).unwrap();
    assert_eq!(v38_counts(&db), HEALTHY);
}

/// Schema recorded from the version 37 migrations at f7961a0a, before any v38 objects existed.
const V37_SCHEMA: &str = r#"
PRAGMA foreign_keys=ON;
CREATE TABLE projects(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE);
CREATE TABLE sessions(
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, mode TEXT NOT NULL, status TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0,
  resume_id TEXT, last_response_at INTEGER, worktree_path TEXT, reasoning_effort TEXT,
  context_used_tokens INTEGER CHECK(context_used_tokens >= 0 AND context_used_tokens <= 1000000000),
  context_window INTEGER CHECK(context_window > 0 AND context_window <= 1000000000),
  task_stage TEXT NOT NULL DEFAULT 'pending' CHECK(task_stage IN ('pending', 'in_progress', 'review', 'completed')),
  task_description TEXT NOT NULL DEFAULT '', completed_at INTEGER, goal_state TEXT, codex_settings TEXT,
  worktree_branch TEXT, last_prompt_at INTEGER,
  title_origin TEXT NOT NULL DEFAULT 'legacy' CHECK(title_origin IN ('legacy', 'auto', 'manual')),
  pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0, 1)), sidebar_order INTEGER,
  draft INTEGER NOT NULL DEFAULT 0 CHECK(draft IN (0, 1)), limited_at INTEGER, limited_until INTEGER,
  resume_at_reset INTEGER NOT NULL DEFAULT 0 CHECK(resume_at_reset IN (0, 1)), remote_device TEXT,
  remote_session TEXT, remote_synced_id INTEGER NOT NULL DEFAULT 0,
  cloud TEXT CHECK(cloud IS NULL OR json_valid(cloud)), remote_backfill_base INTEGER,
  restart_interrupted INTEGER NOT NULL DEFAULT 0, stop_requested INTEGER NOT NULL DEFAULT 0);
CREATE TABLE messages(
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL, tool_id TEXT,
  turn_duration_ms INTEGER CHECK(turn_duration_ms >= 0), remote_cut INTEGER);
CREATE INDEX messages_session ON messages(session_id, id);
CREATE INDEX messages_handoffs ON messages(session_id, id) WHERE role='handoff';
CREATE TRIGGER messages_record_response AFTER INSERT ON messages
  WHEN NEW.role='assistant' AND NEW.content<>''
  BEGIN
    UPDATE sessions SET last_response_at=MAX(COALESCE(last_response_at,NEW.created_at),NEW.created_at) WHERE id=NEW.session_id;
  END;
CREATE UNIQUE INDEX messages_tool ON messages(session_id,tool_id);
CREATE INDEX sessions_completed_archive ON sessions(completed_at) WHERE archived=0 AND task_stage='completed';
CREATE TABLE subagents(
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, id TEXT NOT NULL, content TEXT NOT NULL,
  updated_at INTEGER NOT NULL, PRIMARY KEY(session_id, id));
CREATE INDEX subagents_session_updated ON subagents(session_id,updated_at DESC);
CREATE TABLE architect_teams(
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, content TEXT NOT NULL);
CREATE TABLE architect_workers(
  parent_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, worker_id TEXT NOT NULL,
  session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
  PRIMARY KEY(parent_session_id, worker_id));
CREATE INDEX architect_workers_parent ON architect_workers(parent_session_id);
CREATE TABLE architect_requests(
  parent_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, key TEXT NOT NULL,
  kind TEXT NOT NULL, content TEXT NOT NULL, worker_id TEXT NOT NULL, PRIMARY KEY(parent_session_id, key));
CREATE TABLE architect_library(
  id INTEGER PRIMARY KEY CHECK(id=1), content TEXT NOT NULL CHECK(json_valid(content)));
CREATE TABLE turn_changes(
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  message_id INTEGER NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  summary TEXT NOT NULL CHECK(json_valid(summary)), created_at INTEGER NOT NULL,
  diff_bytes INTEGER NOT NULL DEFAULT 0);
CREATE INDEX turn_changes_session ON turn_changes(session_id,message_id);
CREATE INDEX turn_changes_retained ON turn_changes(created_at,id) WHERE diff_bytes>0;
CREATE TABLE turn_change_files(
  change_id TEXT NOT NULL REFERENCES turn_changes(id) ON DELETE CASCADE, path TEXT NOT NULL,
  detail TEXT NOT NULL CHECK(json_valid(detail)), PRIMARY KEY(change_id, path));
CREATE TABLE context_recovery(
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, through_message_id INTEGER NOT NULL);
CREATE TABLE moodboards(
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, name TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX moodboards_project ON moodboards(project_id,updated_at);
CREATE TABLE moodboard_images(
  id TEXT PRIMARY KEY, board_id TEXT NOT NULL REFERENCES moodboards(id) ON DELETE CASCADE, name TEXT NOT NULL,
  caption TEXT NOT NULL DEFAULT '', mime_type TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL,
  original BLOB NOT NULL, thumbnail BLOB NOT NULL, agent_image BLOB NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX moodboard_images_board ON moodboard_images(board_id,created_at);
CREATE TABLE architect_messages(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, sender TEXT NOT NULL,
  recipient TEXT NOT NULL, request_key TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL,
  UNIQUE(parent_session_id, sender, request_key));
CREATE INDEX architect_messages_mailbox ON architect_messages(parent_session_id,recipient,id);
CREATE INDEX architect_messages_team ON architect_messages(parent_session_id,id);
CREATE TABLE jev_assessments(
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL, report TEXT NOT NULL CHECK(json_valid(report)));
CREATE INDEX jev_assessments_task ON jev_assessments(session_id,created_at DESC,id);
CREATE INDEX jev_assessments_retention ON jev_assessments(created_at DESC,id);
CREATE TABLE jev_project_rules(
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  rules TEXT NOT NULL CHECK(json_valid(rules)));
CREATE TABLE task_links(
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('issue', 'pull')), number INTEGER NOT NULL, url TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT '', checked_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(session_id, kind));
CREATE INDEX task_links_number ON task_links(kind,number);
CREATE TRIGGER messages_record_prompt AFTER INSERT ON messages
  WHEN NEW.role='user' AND trim(NEW.content)<>''
  BEGIN
    UPDATE sessions SET last_prompt_at=MAX(COALESCE(last_prompt_at,NEW.created_at),NEW.created_at) WHERE id=NEW.session_id;
  END;
CREATE INDEX sessions_sidebar ON sessions(pinned DESC,sidebar_order IS NULL,sidebar_order,COALESCE(MAX(last_response_at,last_prompt_at),last_response_at,last_prompt_at,created_at) DESC,id);
CREATE TRIGGER messages_publish_draft AFTER INSERT ON messages
  WHEN NEW.role='user' AND trim(NEW.content)<>''
  BEGIN
    UPDATE sessions SET draft=0,created_at=NEW.created_at,updated_at=MAX(updated_at,NEW.created_at) WHERE id=NEW.session_id AND draft=1;
  END;
CREATE TABLE queued_messages(
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  position INTEGER NOT NULL, text TEXT NOT NULL,
  attachments TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(attachments)), created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL);
CREATE INDEX queued_messages_session ON queued_messages(session_id,position);
CREATE TRIGGER messages_clear_limit AFTER INSERT ON messages
  WHEN NEW.role='user' AND trim(NEW.content)<>''
  BEGIN
    UPDATE sessions SET limited_at=NULL,limited_until=NULL,resume_at_reset=0 WHERE id=NEW.session_id AND limited_at IS NOT NULL;
  END;
CREATE TABLE bots(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL DEFAULT '', goals TEXT NOT NULL DEFAULT '', soul TEXT NOT NULL DEFAULT '',
  avatar TEXT NOT NULL DEFAULT '', project_id TEXT NOT NULL REFERENCES projects(id), provider TEXT NOT NULL,
  model TEXT NOT NULL, mode TEXT NOT NULL,
  heartbeat_minutes INTEGER NOT NULL DEFAULT 0 CHECK(heartbeat_minutes >= 0), next_heartbeat_at INTEGER,
  paused INTEGER NOT NULL DEFAULT 0 CHECK(paused IN (0, 1)), memory_version INTEGER NOT NULL DEFAULT 0,
  notify_channel_id TEXT, notify_thread TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  color TEXT NOT NULL DEFAULT '', reasoning_effort TEXT NOT NULL DEFAULT '',
  backup_models TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(backup_models)),
  fallback_mode TEXT NOT NULL DEFAULT 'ask', notify INTEGER NOT NULL DEFAULT 1 CHECK(notify IN (0, 1)),
  while_working TEXT NOT NULL DEFAULT 'queue',
  show_plan INTEGER NOT NULL DEFAULT 0 CHECK(show_plan IN (0, 1)),
  skills TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(skills)),
  mcp TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(mcp)));
CREATE TABLE bot_memories(
  id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE, content TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('user', 'bot')), created_at INTEGER NOT NULL);
CREATE INDEX bot_memories_bot ON bot_memories(bot_id,created_at);
CREATE TABLE bot_threads(
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE, channel_id TEXT NOT NULL,
  external_id TEXT NOT NULL, session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
  brief_version INTEGER NOT NULL DEFAULT -1, updated_at INTEGER NOT NULL,
  PRIMARY KEY(bot_id, channel_id, external_id));
CREATE TABLE bot_activity(
  id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, summary TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(detail)),
  at INTEGER NOT NULL);
CREATE INDEX bot_activity_bot ON bot_activity(bot_id,id);
CREATE TABLE bot_schedules(
  id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE, title TEXT NOT NULL,
  prompt TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('once', 'interval', 'daily', 'weekdays')),
  interval_minutes INTEGER, time_of_day TEXT, next_run_at INTEGER, last_run_at INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
  created_by TEXT NOT NULL CHECK(created_by IN ('user', 'bot')), created_at INTEGER NOT NULL);
CREATE INDEX bot_schedules_due ON bot_schedules(enabled,next_run_at);
CREATE TABLE bot_channels(
  id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('web', 'telegram', 'slack', 'discord', 'whatsapp')),
  label TEXT NOT NULL DEFAULT '', config TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(config)),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)), status TEXT NOT NULL DEFAULT '',
  secret_names TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(secret_names)), web_token TEXT,
  created_at INTEGER NOT NULL);
CREATE TABLE bot_pairings(
  channel_id TEXT NOT NULL REFERENCES bot_channels(id) ON DELETE CASCADE, sender_id TEXT NOT NULL,
  sender_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'blocked')), code TEXT NOT NULL,
  created_at INTEGER NOT NULL, PRIMARY KEY(channel_id, sender_id));
CREATE TABLE bot_tasks(
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE, brief_version INTEGER NOT NULL DEFAULT -1);
CREATE TABLE bot_rules(
  id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE, pattern TEXT NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN ('allow', 'ask', 'deny')), created_at INTEGER NOT NULL);
CREATE TABLE bot_shared_channels(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, lead_bot_id TEXT REFERENCES bots(id) ON DELETE SET NULL,
  archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0, 1)), created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL);
CREATE TABLE bot_shared_channel_members(
  channel_id TEXT NOT NULL REFERENCES bot_shared_channels(id) ON DELETE CASCADE,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE, position INTEGER NOT NULL,
  PRIMARY KEY(channel_id, bot_id), UNIQUE(channel_id, position));
CREATE TABLE bot_shared_channel_messages(
  id TEXT PRIMARY KEY, channel_id TEXT NOT NULL REFERENCES bot_shared_channels(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('user', 'reply')),
  author_bot_id TEXT REFERENCES bots(id) ON DELETE SET NULL, text TEXT NOT NULL,
  status TEXT CHECK(status IN ('queued', 'in_progress', 'completed', 'failed', 'stopped')),
  created_at INTEGER NOT NULL);
CREATE INDEX bot_shared_channel_messages_channel ON bot_shared_channel_messages(channel_id,created_at,id);
CREATE TABLE bot_shared_channel_deliveries(
  id TEXT PRIMARY KEY, channel_id TEXT NOT NULL REFERENCES bot_shared_channels(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES bot_shared_channel_messages(id) ON DELETE CASCADE,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('queued', 'in_progress', 'completed', 'failed', 'stopped')),
  depth INTEGER NOT NULL DEFAULT 0 CHECK(depth BETWEEN 0 AND 3), created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL);
CREATE INDEX bot_shared_channel_deliveries_session ON bot_shared_channel_deliveries(session_id,status,created_at,id);
CREATE TABLE bot_messages(
  id TEXT PRIMARY KEY, source_bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  target_bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  source_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  target_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, source_channel_id TEXT NOT NULL,
  source_external_id TEXT NOT NULL, text TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued', 'in_progress', 'completed', 'failed', 'stopped')),
  result TEXT, depth INTEGER NOT NULL CHECK(depth BETWEEN 1 AND 3), created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, CHECK(source_bot_id<>target_bot_id));
CREATE INDEX bot_messages_target ON bot_messages(target_session_id,status,created_at,id);
CREATE INDEX bot_messages_source ON bot_messages(source_session_id,created_at,id);
CREATE UNIQUE INDEX sessions_remote ON sessions(remote_device,remote_session) WHERE remote_session IS NOT NULL;
CREATE TABLE message_attachments(
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind='image'), name TEXT NOT NULL, mime TEXT NOT NULL, width INTEGER,
  height INTEGER, bytes INTEGER NOT NULL CHECK(bytes>=0), file TEXT,
  source TEXT NOT NULL CHECK(source IN ('file', 'moodboard')),
  moodboard_id TEXT REFERENCES moodboards(id) ON DELETE CASCADE,
  moodboard_image_id TEXT REFERENCES moodboard_images(id) ON DELETE CASCADE, PRIMARY KEY(session_id, id),
  CHECK((source='file' AND file IS NOT NULL AND moodboard_id IS NULL AND moodboard_image_id IS NULL) OR (source='moodboard' AND file IS NULL AND moodboard_id IS NOT NULL AND moodboard_image_id IS NOT NULL)));
CREATE INDEX message_attachments_session_id ON message_attachments(session_id,id,message_id);
CREATE INDEX message_attachments_message ON message_attachments(message_id,session_id);
CREATE TABLE remote_cursors(
  device TEXT NOT NULL, session TEXT NOT NULL, epoch TEXT NOT NULL, seq INTEGER NOT NULL CHECK(seq>=0),
  PRIMARY KEY(device, session));
CREATE TABLE task_usage_links(
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, harness_id TEXT NOT NULL,
  created_at INTEGER NOT NULL, PRIMARY KEY(session_id, harness_id));
CREATE TABLE task_schedules(
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  title TEXT NOT NULL, prompt TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('once', 'interval', 'daily', 'weekdays', 'weekly', 'after')),
  interval_minutes INTEGER, time_of_day TEXT, days TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(days)),
  watch_session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE, only_on_success INTEGER NOT NULL DEFAULT 0,
  next_run_at INTEGER, last_run_at INTEGER, enabled INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL CHECK(created_by IN ('user', 'agent')),
  created_by_session TEXT REFERENCES sessions(id) ON DELETE SET NULL, run_count INTEGER NOT NULL DEFAULT 0,
  max_runs INTEGER, consecutive_failures INTEGER NOT NULL DEFAULT 0, trigger_ok INTEGER, workflow_id TEXT,
  chain_from_id TEXT, saved_remotely INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL);
CREATE INDEX task_schedules_due ON task_schedules(enabled,next_run_at);
CREATE INDEX task_schedules_session ON task_schedules(session_id);
CREATE INDEX task_schedules_watch ON task_schedules(watch_session_id);
CREATE INDEX task_schedules_workflow ON task_schedules(workflow_id);
CREATE TABLE task_schedule_runs(
  id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, title TEXT NOT NULL,
  at INTEGER NOT NULL, outcome TEXT NOT NULL CHECK(outcome IN ('started', 'queued', 'skipped', 'failed')),
  detail TEXT NOT NULL DEFAULT '', sequence INTEGER NOT NULL, manual INTEGER NOT NULL DEFAULT 0);
CREATE INDEX task_schedule_runs_session ON task_schedule_runs(session_id,at DESC);
CREATE INDEX task_schedule_runs_schedule ON task_schedule_runs(schedule_id,at DESC);
CREATE TABLE scheduler_settings(
  id INTEGER PRIMARY KEY CHECK(id=1), content TEXT NOT NULL CHECK(json_valid(content)));
CREATE TABLE machine_threads(
  parent_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, created_at INTEGER NOT NULL,
  reported INTEGER NOT NULL DEFAULT 0, reported_by INTEGER);
CREATE INDEX machine_threads_parent ON machine_threads(parent_session_id,reported);
CREATE INDEX machine_threads_reported_by ON machine_threads(reported_by) WHERE reported_by IS NOT NULL;
PRAGMA user_version=37;
"#;

#[test]
fn upgrading_from_authentic_v37_schema_without_prior_v38_objects() {
    let directory = TempDir::new("authentic-v37");
    let path = directory.0.join("store.db");
    let sid = "running-task";
    {
        let db = Connection::open(&path).unwrap();
        db.execute_batch(V37_SCHEMA).unwrap();
        db.execute("INSERT INTO projects(id,name,path) VALUES('project','Legacy',?1)", [directory.0.to_string_lossy()]).unwrap();
        db.execute_batch("INSERT INTO sessions(id,project_id,title,provider,model,mode,status,created_at,updated_at)
            VALUES('running-task','project','Running task','claude','sonnet','auto','running',1,1);
            INSERT INTO architect_library(id,content) VALUES(1,'{}');").unwrap();
        seed_running_rows(&db, sid);
        assert_eq!(v38_counts(&db), (0, 0, 0));
        assert!(has_object(&db, "turn_changes_retained"));
    }
    let store = Store::open(&path).unwrap();
    assert_eq!(store.db.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0)).unwrap(), SCHEMA_VERSION);
    assert_eq!(v38_counts(&store.db), HEALTHY);
    assert!(!has_object(&store.db, "turn_changes_retained"));
    assert_trackers_rebuilt_and_settled(&store, sid);
}

#[test]
fn opening_repairs_reversed_update_trigger_pairs() {
    let (_directory, path) = current_database("reversed-triggers");
    for (first, second) in UPDATE_TRIGGER_ORDER {
        let db = Connection::open(&path).unwrap();
        let first_sql: String = db.query_row("SELECT sql FROM sqlite_master WHERE name=?1", [first], |row| row.get(0)).unwrap();
        let second_sql: String = db.query_row("SELECT sql FROM sqlite_master WHERE name=?1", [second], |row| row.get(0)).unwrap();
        db.execute_batch(&format!("DROP TRIGGER {first}; DROP TRIGGER {second}; {second_sql}; {first_sql};")).unwrap();
        assert_eq!(v38_counts(&db).1, V38_TRACKER_OBJECTS - 1, "{first}, {second}");
        drop(db);
        assert_eq!(v38_counts(&Store::open(&path).unwrap().db), HEALTHY);
    }
}

#[test]
fn opening_removes_legacy_team_status_only_on_supported_schemas() {
    for version in [SCHEMA_VERSION, SCHEMA_VERSION + 1] {
        let (_directory, path) = current_database("legacy-team-status");
        let db = Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE architect_team_status(session_id TEXT PRIMARY KEY, status);
            CREATE INDEX architect_teams_status ON architect_teams(session_id);
            CREATE TRIGGER architect_team_status_insert AFTER INSERT ON architect_teams BEGIN DELETE FROM architect_team_status WHERE session_id=NEW.session_id; END;
            CREATE TRIGGER architect_team_status_update AFTER UPDATE ON architect_teams BEGIN DELETE FROM architect_team_status WHERE session_id IN (OLD.session_id,NEW.session_id); END;
            CREATE TRIGGER architect_team_status_delete AFTER DELETE ON architect_teams BEGIN DELETE FROM architect_team_status WHERE session_id=OLD.session_id; END;").unwrap();
        db.pragma_update(None, "user_version", version).unwrap();
        drop(db);
        let store = Store::open(&path).unwrap();
        let objects: i64 = store.db.query_row("SELECT COUNT(*) FROM sqlite_master WHERE name GLOB 'architect_team_status*' OR name='architect_teams_status'", [], |row| row.get(0)).unwrap();
        assert_eq!(objects, if version <= SCHEMA_VERSION { 0 } else { 5 }, "v{version}");
    }
}
