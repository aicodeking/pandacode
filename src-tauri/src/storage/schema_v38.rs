//! Hot-query indexes, running-row trackers and their repair on supported schemas.
//! The additive upgrade keeps `user_version` at 37 for older PandaCode releases.

use super::sql::BASE_SCHEMA;
use super::{now, run_savepoint, with_migration_pragmas, Result, RollbackGuard, SCHEMA_VERSION};
use rusqlite::{params, Connection, Transaction, TransactionBehavior};
use std::time::{Duration, Instant};
use std::collections::HashMap;

/// Version 38's indexes (the bot indexes are `bots::INDEXES`, created by `bots::upgrade`). Each
/// WHERE clause is repeated verbatim by the query it serves, since SQLite uses a partial or
/// expression index only when the query's terms match it.
///
/// `repair_v38_objects` runs this batch again whenever one of these indexes is missing, so a new
/// index also goes in `V38_SCHEMA_INDEXES` and gets an `EXPLAIN QUERY PLAN` check in
/// `hot_queries_use_their_indexes`. `turn_changes_retained_bytes` supersedes version 13's
/// `turn_changes_retained`, which the upgrade and repair both drop.
const SCHEMA_38_INDEXES: &str = "
CREATE INDEX IF NOT EXISTS sessions_project ON sessions(project_id,updated_at DESC);
CREATE INDEX IF NOT EXISTS sessions_provider_resume ON sessions(provider,resume_id,updated_at DESC) WHERE resume_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS sessions_limit_resume ON sessions(limited_until) WHERE resume_at_reset=1 AND limited_until IS NOT NULL AND archived=0 AND draft=0;
CREATE INDEX IF NOT EXISTS sessions_active_status ON sessions(status) WHERE status IN ('running','waiting');
CREATE INDEX IF NOT EXISTS sessions_worktree ON sessions(worktree_path) WHERE worktree_path IS NOT NULL;
CREATE INDEX IF NOT EXISTS sessions_draft ON sessions(id) WHERE draft=1;
CREATE INDEX IF NOT EXISTS sessions_archived ON sessions(id) WHERE archived=1;
CREATE INDEX IF NOT EXISTS sessions_active_goal ON sessions(id) WHERE json_valid(goal_state) AND json_extract(goal_state,'$.status')='active';
CREATE INDEX IF NOT EXISTS sessions_remote_pending ON sessions(id) WHERE remote_device IS NOT NULL AND remote_session IS NULL;
CREATE INDEX IF NOT EXISTS messages_user_activity ON messages(created_at,session_id) WHERE role='user';
CREATE INDEX IF NOT EXISTS messages_session_conversation ON messages(session_id,id) WHERE role IN ('user','assistant');
CREATE INDEX IF NOT EXISTS messages_remote_cut ON messages(session_id,id) WHERE remote_cut IS NOT NULL;
CREATE INDEX IF NOT EXISTS architect_requests_worker ON architect_requests(worker_id);
CREATE INDEX IF NOT EXISTS turn_changes_retained_bytes ON turn_changes(created_at,id,diff_bytes) WHERE diff_bytes > 0;
CREATE INDEX IF NOT EXISTS message_attachments_moodboard ON message_attachments(moodboard_id) WHERE moodboard_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS message_attachments_moodboard_image ON message_attachments(moodboard_image_id) WHERE moodboard_image_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS task_schedules_creator ON task_schedules(created_by_session) WHERE created_by_session IS NOT NULL;";

/// JSON5 can also encode status letters with hex escapes or split them with a line continuation.
macro_rules! json5_status_escape {
    ($p:literal) => {
        concat!($p, "content GLOB ('*\\[x' || char(10,13,8232,8233) || ']*')")
    };
}

/// Whether a `messages` row (columns prefixed `NEW.`, or bare) is a running tool snapshot. The
/// `instr` tests come first so the JSON is parsed only for rows that can match either a
/// quoted `running` value (JSON5 also allows single quotes) or an escape such as `\u0072unning`.
/// A missing type or version can produce NULL, so COALESCE keeps the stop trigger firing.
macro_rules! running_tool {
    ($p:literal) => {
        concat!($p, "role='tool' AND ", $p, "tool_id IS NOT NULL AND (instr(", $p, "content,'running')>0 OR instr(", $p, "content,'\\u')>0 OR ", json5_status_escape!($p), ") AND COALESCE(CASE WHEN json_valid(", $p, "content,6) THEN json_extract(", $p, "content,'$.type')='tool_activity' AND json_extract(", $p, "content,'$.version')=1 AND json_extract(", $p, "content,'$.status')='running' ELSE 0 END,0)=1")
    };
}
/// Whether a `subagents` row's saved status is running or waiting, as `running_tool!`.
macro_rules! running_subagent {
    ($p:literal) => {
        concat!("(instr(", $p, "content,'running')>0 OR instr(", $p, "content,'waiting')>0 OR instr(", $p, "content,'\\u')>0 OR ", json5_status_escape!($p), ") AND COALESCE(CASE WHEN json_valid(", $p, "content,6) THEN json_extract(", $p, "content,'$.status') IN ('running','waiting') ELSE 0 END,0)=1")
    };
}

/// The `architect_team_meta` columns derived from a team snapshot (`NEW.content` or bare
/// `content`): its status (NULL for unparsable content), whether it is JSON/JSON5, and whether it
/// still lacks its `legacyPromptThroughId` watermark (valid JSON/JSON5 whose key is missing or
/// JSON `null`).
macro_rules! team_meta_values {
    ($c:literal) => {
        concat!("CASE WHEN json_valid(", $c, ",6) THEN json_extract(", $c, ",'$.status') END,json_valid(", $c, ",6),CASE WHEN json_valid(", $c, ",6) AND COALESCE(json_type(", $c, ",'$.legacyPromptThroughId'),'null')='null' THEN 1 ELSE 0 END,0")
    };
}
macro_rules! team_meta_upsert {
    () => {
        " ON CONFLICT(session_id) DO UPDATE SET status=excluded.status,valid_json=excluded.valid_json,needs_legacy_cutoff=excluded.needs_legacy_cutoff,skip_sync=0"
    };
}

/// Version 38's running-row trackers. `running_tools` and `running_subagents` hold the key of each
/// running tool snapshot and subagent, kept by triggers, so settling reads them instead of
/// `messages` or `subagents`. Tracking tables are used rather than JSON partial indexes because
/// SQLite maintains a partial index by evaluating its WHERE clause for every deleted or
/// rewritten row, parsing that row's `content` (overflow pages included); the triggers never
/// read `OLD.content`, and there are no delete triggers: the foreign keys remove a deleted
/// row's entry through its primary key. The trigger bodies use upsert clauses, never
/// `INSERT OR REPLACE`/`OR IGNORE`: inside a trigger fired by an upsert (`tool_message`,
/// `save_subagent`) SQLite replaces an `OR` policy with the outer statement's `ABORT`. The update
/// triggers check the tracker's primary key before the JSON predicate, so a progress update
/// parses `content` at most once (start skips a tracked row, stop skips an untracked one).
/// The tool triggers also watch `session_id`; start refreshes a tracked row if the message moved.
///
/// Creation order matters: SQLite fires a table's triggers newest-created first (LIFO), so each
/// `*_update_stop` is created BEFORE its `*_update_start`. On `running -> completed`, start then
/// fires first and skips the still-tracked row if its session is unchanged, and stop removes it. In the
/// other order stop would delete the entry first and start would see `NOT EXISTS` and parse the
/// JSON again whenever the finished output contains `"running"` or a `\u` escape (ANSI
/// `\u001b` in shell output, say). The `DROP TRIGGER`s make migration and current-schema repair recreate them in
/// this order.
///
/// `architect_team_meta` tracks each team's status and whether it still needs its legacy prompt
/// cutoff, replacing JSON expression/partial indexes on `architect_teams` that parsed both the old
/// and new snapshot (tens of KiB to megabytes) on every save. `status` has no declared type, so it
/// keeps whatever `json_extract` returned (text, integer, `1` for `true`, NULL) and range tests on
/// it match the old expression exactly. Its triggers parse `NEW.content` only; `architect::save`
/// avoids even that: inside one savepoint it writes the tracker row itself with `skip_sync=1`,
/// then upserts the snapshot. `*_update_clear` is created BEFORE `*_update_sync` (LIFO again), so
/// sync fires first, sees `skip_sync=1` and skips, and clear then resets it to 0. Any other write
/// (raw SQL, `INSERT`, a remote import) leaves `skip_sync=0` and is parsed by the triggers.
///
/// Current-schema repair recreates all triggers and resynchronizes the tracker rows.
/// Prunes probe base rows by primary key. Backfill is the only full pass over the base tables.
macro_rules! running_tools_objects {
    () => {
        concat!("
CREATE TABLE IF NOT EXISTS running_tools(
  message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS running_tools_insert AFTER INSERT ON messages WHEN ", running_tool!("NEW."), "
  BEGIN INSERT INTO running_tools(message_id,session_id) VALUES (NEW.id,NEW.session_id) ON CONFLICT(message_id) DO UPDATE SET session_id=excluded.session_id; END;
CREATE TRIGGER IF NOT EXISTS running_tools_update_stop AFTER UPDATE OF role,content,tool_id,session_id ON messages WHEN OLD.role='tool' AND EXISTS(SELECT 1 FROM running_tools WHERE message_id=NEW.id) AND NOT (", running_tool!("NEW."), ")
  BEGIN DELETE FROM running_tools WHERE message_id=NEW.id; END;
CREATE TRIGGER IF NOT EXISTS running_tools_update_start AFTER UPDATE OF role,content,tool_id,session_id ON messages WHEN (OLD.session_id<>NEW.session_id OR NOT EXISTS(SELECT 1 FROM running_tools WHERE message_id=NEW.id)) AND ", running_tool!("NEW."), "
  BEGIN INSERT INTO running_tools(message_id,session_id) VALUES (NEW.id,NEW.session_id) ON CONFLICT(message_id) DO UPDATE SET session_id=excluded.session_id; END;
")
    };
}

macro_rules! running_subagents_objects {
    () => {
        concat!("
CREATE TABLE IF NOT EXISTS running_subagents(
  session_id TEXT NOT NULL,
  id TEXT NOT NULL,
  PRIMARY KEY(session_id,id),
  FOREIGN KEY(session_id,id) REFERENCES subagents(session_id,id) ON DELETE CASCADE);
CREATE TRIGGER IF NOT EXISTS running_subagents_insert AFTER INSERT ON subagents WHEN ", running_subagent!("NEW."), "
  BEGIN INSERT INTO running_subagents(session_id,id) VALUES (NEW.session_id,NEW.id) ON CONFLICT DO NOTHING; END;
CREATE TRIGGER IF NOT EXISTS running_subagents_update_stop AFTER UPDATE OF content ON subagents WHEN EXISTS(SELECT 1 FROM running_subagents WHERE session_id=NEW.session_id AND id=NEW.id) AND NOT (", running_subagent!("NEW."), ")
  BEGIN DELETE FROM running_subagents WHERE session_id=NEW.session_id AND id=NEW.id; END;
CREATE TRIGGER IF NOT EXISTS running_subagents_update_start AFTER UPDATE OF content ON subagents WHEN NOT EXISTS(SELECT 1 FROM running_subagents WHERE session_id=NEW.session_id AND id=NEW.id) AND ", running_subagent!("NEW."), "
  BEGIN INSERT INTO running_subagents(session_id,id) VALUES (NEW.session_id,NEW.id) ON CONFLICT DO NOTHING; END;
")
    };
}

macro_rules! architect_team_meta_objects {
    () => {
        concat!("
CREATE TABLE IF NOT EXISTS architect_team_meta(
  session_id TEXT PRIMARY KEY REFERENCES architect_teams(session_id) ON DELETE CASCADE,
  status,
  valid_json INTEGER NOT NULL DEFAULT 1,
  needs_legacy_cutoff INTEGER NOT NULL DEFAULT 0,
  skip_sync INTEGER NOT NULL DEFAULT 0);
CREATE TRIGGER IF NOT EXISTS architect_team_meta_insert AFTER INSERT ON architect_teams
  BEGIN INSERT INTO architect_team_meta(session_id,status,valid_json,needs_legacy_cutoff,skip_sync) VALUES(NEW.session_id,", team_meta_values!("NEW.content"), ")", team_meta_upsert!(), "; END;
CREATE TRIGGER IF NOT EXISTS architect_team_meta_update_clear AFTER UPDATE OF content ON architect_teams
  WHEN EXISTS(SELECT 1 FROM architect_team_meta WHERE session_id=NEW.session_id AND skip_sync=1)
  BEGIN UPDATE architect_team_meta SET skip_sync=0 WHERE session_id=NEW.session_id; END;
CREATE TRIGGER IF NOT EXISTS architect_team_meta_update_sync AFTER UPDATE OF content ON architect_teams
  WHEN NOT EXISTS(SELECT 1 FROM architect_team_meta WHERE session_id=NEW.session_id AND skip_sync=1)
  BEGIN INSERT INTO architect_team_meta(session_id,status,valid_json,needs_legacy_cutoff,skip_sync) VALUES(NEW.session_id,", team_meta_values!("NEW.content"), ")", team_meta_upsert!(), "; END;
")
    };
}

macro_rules! resync_running_tools {
    () => {
        concat!("
DELETE FROM running_tools WHERE NOT EXISTS(SELECT 1 FROM messages WHERE id=running_tools.message_id AND ", running_tool!(""), ");
INSERT INTO running_tools(message_id,session_id) SELECT id,session_id FROM messages WHERE ", running_tool!(""), "
  ON CONFLICT(message_id) DO UPDATE SET session_id=excluded.session_id;")
    };
}
macro_rules! resync_running_subagents {
    () => {
        concat!("
DELETE FROM running_subagents WHERE NOT EXISTS(SELECT 1 FROM subagents WHERE session_id=running_subagents.session_id AND id=running_subagents.id AND ", running_subagent!(""), ");
INSERT OR IGNORE INTO running_subagents(session_id,id) SELECT session_id,id FROM subagents WHERE ", running_subagent!(""), ";")
    };
}
macro_rules! resync_architect_team_meta {
    () => {
        concat!("
DELETE FROM architect_team_meta WHERE NOT EXISTS(SELECT 1 FROM architect_teams WHERE session_id=architect_team_meta.session_id);
INSERT INTO architect_team_meta(session_id,status,valid_json,needs_legacy_cutoff,skip_sync)
  SELECT session_id,", team_meta_values!("content"), " FROM architect_teams WHERE true", team_meta_upsert!(), ";")
    };
}

const LEGACY_TEAM_STATUS_CLEANUP: &str = "
DROP INDEX IF EXISTS architect_teams_status;
DROP INDEX IF EXISTS turn_changes_retained;
DROP TRIGGER IF EXISTS architect_team_status_insert;
DROP TRIGGER IF EXISTS architect_team_status_update;
DROP TRIGGER IF EXISTS architect_team_status_delete;
DROP TABLE IF EXISTS architect_team_status;";

const UPDATE_TRIGGER_ORDER: [(&str, &str); 3] = [
    ("running_tools_update_stop", "running_tools_update_start"),
    ("running_subagents_update_stop", "running_subagents_update_start"),
    ("architect_team_meta_update_clear", "architect_team_meta_update_sync"),
];

const SCHEMA_38_RUNNING: &str = concat!("
DROP TRIGGER IF EXISTS running_tools_insert;
DROP TRIGGER IF EXISTS running_tools_update_start;
DROP TRIGGER IF EXISTS running_tools_update_stop;
DROP TRIGGER IF EXISTS running_subagents_insert;
DROP TRIGGER IF EXISTS running_subagents_update_start;
DROP TRIGGER IF EXISTS running_subagents_update_stop;
DROP TRIGGER IF EXISTS architect_team_meta_insert;
DROP TRIGGER IF EXISTS architect_team_meta_update_sync;
DROP TRIGGER IF EXISTS architect_team_meta_update_clear;
", running_tools_objects!(), running_subagents_objects!(), architect_team_meta_objects!(),
    resync_running_tools!(), resync_running_subagents!(), resync_architect_team_meta!()
);

const SCHEMA_38_TRACKER_INDEXES: [&str; 3] = [
    "CREATE INDEX IF NOT EXISTS running_tools_session ON running_tools(session_id)",
    "CREATE INDEX IF NOT EXISTS architect_team_meta_status ON architect_team_meta(status)",
    "CREATE INDEX IF NOT EXISTS architect_team_meta_legacy_cutoff ON architect_team_meta(session_id) WHERE needs_legacy_cutoff=1",
];

const V38_SLOW_UPGRADE: Duration = Duration::from_millis(500);

pub(super) fn log_slow_upgrade(started: Instant) {
    let elapsed = started.elapsed();
    if elapsed >= V38_SLOW_UPGRADE {
        eprintln!("PandaCode: upgraded database indexes and trackers in {:.1}s", elapsed.as_secs_f64());
    }
}

/// The tables `SCHEMA_38_RUNNING` creates.
pub(crate) const V38_TRACKER_TABLES: [&str; 3] = ["running_tools", "running_subagents", "architect_team_meta"];
/// The triggers `SCHEMA_38_RUNNING` creates, grouped by messages, subagents, and architect_teams.
pub(crate) const V38_TRACKER_TRIGGERS: [&str; 9] = ["running_tools_insert", "running_tools_update_start", "running_tools_update_stop", "running_subagents_insert", "running_subagents_update_start", "running_subagents_update_stop", "architect_team_meta_insert", "architect_team_meta_update_clear", "architect_team_meta_update_sync"];
/// The indexes `SCHEMA_38_TRACKER_INDEXES` creates.
pub(crate) const V38_TRACKER_INDEXES: [&str; 3] = ["running_tools_session", "architect_team_meta_status", "architect_team_meta_legacy_cutoff"];
/// The tracker core: the tables and their triggers.
const V38_TRACKER_OBJECTS: i64 = (V38_TRACKER_TABLES.len() + V38_TRACKER_TRIGGERS.len()) as i64;
/// The indexes `SCHEMA_38_INDEXES` creates (a test keeps the two in step).
pub(crate) const V38_SCHEMA_INDEXES: [&str; 17] = ["sessions_project", "sessions_provider_resume", "sessions_limit_resume", "sessions_active_status", "sessions_worktree", "sessions_draft", "sessions_archived", "sessions_active_goal", "sessions_remote_pending", "messages_user_activity", "messages_session_conversation", "messages_remote_cut", "architect_requests_worker", "turn_changes_retained_bytes", "message_attachments_moodboard", "message_attachments_moodboard_image", "task_schedules_creator"];
/// The indexes `bots::upgrade` creates; `bots_project` only when `bots.project_id` exists.
pub(crate) const V38_BOT_INDEXES: [&str; 5] = ["bot_shared_channel_deliveries_message", "bot_shared_channel_deliveries_channel", "bot_shared_channel_deliveries_bot_status", "bot_activity_model_switch", "bots_project"];
/// Every version 38 object `Store::open` repairs.
const BASE_INDEXES: [&str; 2] = ["messages_session", "messages_handoffs"];
const V38_OBJECTS: i64 = V38_TRACKER_OBJECTS + (V38_TRACKER_INDEXES.len() + V38_SCHEMA_INDEXES.len() + V38_BOT_INDEXES.len()) as i64;

/// The table and columns a version 38 index is built on, so the repair can tell before taking the
/// write lock whether its `CREATE INDEX` can ever succeed.
pub(crate) struct IndexPrereq {
    pub(crate) name: &'static str,
    pub(crate) table: &'static str,
    pub(crate) columns: &'static [&'static str],
}
const fn prereq(name: &'static str, table: &'static str, columns: &'static [&'static str]) -> IndexPrereq {
    IndexPrereq { name, table, columns }
}
/// `SCHEMA_38_INDEXES`' prerequisites, in `V38_SCHEMA_INDEXES` order (a test keeps them in step).
pub(crate) const SCHEMA_INDEX_PREREQS: [IndexPrereq; 17] = [
    prereq("sessions_project", "sessions", &["project_id", "updated_at"]),
    prereq("sessions_provider_resume", "sessions", &["provider", "resume_id", "updated_at"]),
    prereq("sessions_limit_resume", "sessions", &["limited_until", "resume_at_reset", "archived", "draft"]),
    prereq("sessions_active_status", "sessions", &["status"]),
    prereq("sessions_worktree", "sessions", &["worktree_path"]),
    prereq("sessions_draft", "sessions", &["id", "draft"]),
    prereq("sessions_archived", "sessions", &["id", "archived"]),
    prereq("sessions_active_goal", "sessions", &["id", "goal_state"]),
    prereq("sessions_remote_pending", "sessions", &["id", "remote_device", "remote_session"]),
    prereq("messages_user_activity", "messages", &["created_at", "session_id", "role"]),
    prereq("messages_session_conversation", "messages", &["session_id", "id", "role"]),
    prereq("messages_remote_cut", "messages", &["session_id", "id", "remote_cut"]),
    prereq("architect_requests_worker", "architect_requests", &["worker_id"]),
    prereq("turn_changes_retained_bytes", "turn_changes", &["created_at", "id", "diff_bytes"]),
    prereq("message_attachments_moodboard", "message_attachments", &["moodboard_id"]),
    prereq("message_attachments_moodboard_image", "message_attachments", &["moodboard_image_id"]),
    prereq("task_schedules_creator", "task_schedules", &["created_by_session"]),
];
/// `bots::INDEXES` and `bots::PROJECT_INDEX` prerequisites, in `V38_BOT_INDEXES` order.
pub(crate) const BOT_INDEX_PREREQS: [IndexPrereq; 5] = [
    prereq("bot_shared_channel_deliveries_message", "bot_shared_channel_deliveries", &["message_id", "created_at", "id"]),
    prereq("bot_shared_channel_deliveries_channel", "bot_shared_channel_deliveries", &["channel_id", "created_at", "id"]),
    prereq("bot_shared_channel_deliveries_bot_status", "bot_shared_channel_deliveries", &["bot_id", "status"]),
    prereq("bot_activity_model_switch", "bot_activity", &["id", "kind"]),
    prereq("bots_project", "bots", &["project_id"]),
];
/// Prerequisites in `SCHEMA_38_TRACKER_INDEXES` order.
const TRACKER_INDEX_PREREQS: [IndexPrereq; 3] = [
    prereq("running_tools_session", "running_tools", &["session_id"]),
    prereq("architect_team_meta_status", "architect_team_meta", &["status"]),
    prereq("architect_team_meta_legacy_cutoff", "architect_team_meta", &["session_id", "needs_legacy_cutoff"]),
];

fn table_columns(db: &Connection, table: &str) -> Result<Vec<String>> {
    let mut statement = db.prepare_cached("SELECT name FROM pragma_table_info(?1)").map_err(|e| e.to_string())?;
    let present = statement
        .query_map([table], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    present.collect::<rusqlite::Result<_>>().map_err(|e| e.to_string())
}

fn plan_v38_repair(db: &Connection, need_trackers: bool) -> Result<MissingIndexes> {
    // Tables, views and indexes share SQLite's index namespace. Triggers are separate.
    let objects = db
        .prepare_cached("SELECT lower(name), type FROM sqlite_master WHERE type<>'trigger'")
        .and_then(|mut statement| {
            let rows = statement.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
            rows.collect::<rusqlite::Result<HashMap<_, _>>>()
        })
        .map_err(|e| e.to_string())?;
    let mut columns = HashMap::new();
    // None means the name is free, so bots::upgrade can create a missing bot table.
    let mut has_columns = |table: &'static str, required: &[&str]| -> Result<Option<bool>> {
        match objects.get(table).map(String::as_str) {
            None => return Ok(None),
            Some("table") => {}
            Some(_) => return Ok(Some(false)),
        }
        let present = match columns.entry(table) {
            std::collections::hash_map::Entry::Occupied(entry) => entry.into_mut(),
            std::collections::hash_map::Entry::Vacant(entry) => entry.insert(table_columns(db, table)?),
        };
        Ok(Some(required.iter().all(|column| present.iter().any(|name| name.eq_ignore_ascii_case(column)))))
    };
    let mut schema = false;
    for index in &SCHEMA_INDEX_PREREQS {
        if !objects.contains_key(index.name) && has_columns(index.table, index.columns)? == Some(true) {
            schema = true;
            break;
        }
    }
    let mut has_bots_project = false;
    let mut bot = false;
    for index in &BOT_INDEX_PREREQS {
        if objects.contains_key(index.name) {
            continue;
        }
        if index.name == "bots_project" {
            // bots::upgrade never adds project_id to a legacy table.
            has_bots_project = has_columns(index.table, index.columns)? == Some(true);
            bot |= has_bots_project;
        } else if !bot {
            bot = has_columns(index.table, index.columns)?.unwrap_or(true);
        }
    }
    let mut tracker_indexes = [false; TRACKER_INDEX_PREREQS.len()];
    for (index, missing) in TRACKER_INDEX_PREREQS.iter().zip(&mut tracker_indexes) {
        if !objects.contains_key(index.name) {
            // Core repair creates any absent tracker table before restoring its indexes.
            *missing = has_columns(index.table, index.columns)?.unwrap_or(need_trackers);
        }
    }
    Ok(MissingIndexes { has_bots_project, bot, schema, tracker_indexes })
}

/// SQLite strips IF NOT EXISTS from the CREATE TRIGGER header and omits the final semicolon.
fn tracker_trigger_definitions() -> &'static HashMap<&'static str, &'static str> {
    static DEFINITIONS: std::sync::OnceLock<HashMap<&'static str, &'static str>> = std::sync::OnceLock::new();
    DEFINITIONS.get_or_init(|| {
        [running_tools_objects!(), running_subagents_objects!(), architect_team_meta_objects!()]
            .into_iter()
            .flat_map(|sql| sql.split("\nCREATE TRIGGER IF NOT EXISTS ").skip(1))
            .map(|definition| {
                let definition = definition.trim().trim_end_matches(';');
                let name = definition.split_ascii_whitespace().next().expect("tracker trigger name");
                (name, definition)
            })
            .collect()
    })
}

fn tracker_trigger_matches(name: &str, sql: &str) -> bool {
    let Some(expected) = tracker_trigger_definitions().get(name) else { return false };
    let Some(actual) = sql.trim().trim_end_matches(';').strip_prefix("CREATE TRIGGER ") else { return false };
    if actual == *expected {
        return true;
    }
    // Ignore formatting whitespace outside string literals, preserving the literal values.
    let mut actual = actual.split('\'');
    let mut expected = expected.split('\'');
    while let (Some(actual_sql), Some(expected_sql)) = (actual.next(), expected.next()) {
        if !actual_sql.split_ascii_whitespace().eq(expected_sql.split_ascii_whitespace()) {
            return false;
        }
        match (actual.next(), expected.next()) {
            (None, None) => return true,
            (Some(actual_literal), Some(expected_literal)) if actual_literal == expected_literal => {}
            _ => return false,
        }
    }
    false
}

fn v38_objects_sql() -> &'static str {
    static SQL: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    SQL.get_or_init(|| {
        let list = |names: &[&str]| names.iter().map(|name| format!("'{name}'")).collect::<Vec<_>>().join(",");
        let indexes: Vec<&str> = V38_TRACKER_INDEXES.into_iter().chain(V38_SCHEMA_INDEXES).chain(V38_BOT_INDEXES).collect();
        let triggers = ["messages", "subagents", "architect_teams"]
            .into_iter()
            .zip(V38_TRACKER_TRIGGERS.as_chunks::<3>().0)
            .map(|(parent, names)| format!("(tbl_name COLLATE NOCASE = '{parent}' AND name COLLATE NOCASE IN ({}))", list(names)))
            .collect::<Vec<_>>()
            .join(" OR ");
        format!(
            "SELECT type,name,CASE WHEN type='trigger' THEN sql END,type='index' AND name COLLATE NOCASE IN ({}) FROM sqlite_master WHERE (type='table' AND name COLLATE NOCASE IN ({})) OR (type='trigger' AND ({triggers})) OR (type='index' AND name COLLATE NOCASE IN ({}))
                OR (type='index' AND name COLLATE NOCASE IN ('architect_teams_status','turn_changes_retained',{}))
                OR (type='table' AND name COLLATE NOCASE='architect_team_status')
                OR (type='trigger' AND name COLLATE NOCASE IN ('architect_team_status_insert','architect_team_status_update','architect_team_status_delete'))
                ORDER BY rowid",
            list(&V38_BOT_INDEXES),
            list(&V38_TRACKER_TABLES),
            list(&indexes),
            list(&BASE_INDEXES),
        )
    })
}

/// Counts matching objects and detects legacy objects in one sqlite_master read.
fn v38_objects_present(db: &Connection) -> Result<(i64, i64, i64, bool, bool)> {
    let count = || -> rusqlite::Result<_> {
        let mut statement = db.prepare(v38_objects_sql())?;
        let mut rows = statement.query([])?;
        let (mut found, mut trackers, mut bot_indexes) = (0, 0, 0);
        let mut legacy = false;
        let mut base_indexes = 0;
        let mut first_created = [false; UPDATE_TRIGGER_ORDER.len()];
        while let Some(row) = rows.next()? {
            let kind = row.get_ref(0)?.as_str()?;
            let name = row.get_ref(1)?.as_str()?;
            if name.eq_ignore_ascii_case("turn_changes_retained")
                || name.eq_ignore_ascii_case("architect_teams_status")
                || name.get(.."architect_team_status".len()).is_some_and(|prefix| prefix.eq_ignore_ascii_case("architect_team_status"))
            {
                legacy = true;
                continue;
            }
            if kind == "index" && BASE_INDEXES.iter().any(|index| name.eq_ignore_ascii_case(index)) {
                base_indexes += 1;
                continue;
            }
            match kind {
                "trigger" => {
                    if !row.get_ref(2)?.as_str_or_null()?.is_some_and(|sql| tracker_trigger_matches(name, sql)) {
                        continue;
                    }
                    // SQLite fires later-created triggers first. A reversed pair needs repair
                    // even when both definitions match.
                    if UPDATE_TRIGGER_ORDER.iter().zip(&mut first_created).any(|((first, second), seen)| {
                        *seen |= name.eq_ignore_ascii_case(first);
                        name.eq_ignore_ascii_case(second) && !*seen
                    }) {
                        continue;
                    }
                    trackers += 1;
                }
                "table" => trackers += 1,
                _ => bot_indexes += i64::from(row.get::<_, bool>(3)?),
            }
            found += 1;
        }
        Ok((found, trackers, bot_indexes, legacy, base_indexes < BASE_INDEXES.len()))
    };
    count().map_err(|e| e.to_string())
}

macro_rules! settle_tool_update {
    ($indexed:literal) => {
        concat!("UPDATE messages", $indexed, " SET content=json_set(content,'$.status','failed','$.output',COALESCE(json_extract(content,'$.output'),'') || ?2) WHERE ")
    };
}
macro_rules! settle_tool_set {
    () => {
        // `NOT INDEXED` keeps the lookup on the message IDs supplied by the tracker.
        concat!(settle_tool_update!(" NOT INDEXED"), "id IN (SELECT message_id FROM running_tools WHERE ")
    };
}
macro_rules! settle_subagent_set {
    () => {
        "UPDATE subagents SET content=CASE WHEN json_type(content,'$.tools')='array' THEN json_set(content,'$.status',?2,'$.updatedAt',?3,
        '$.tools',json((SELECT json_group_array(CASE
            WHEN type='object' AND json_extract(value,'$.status') IN ('running','waiting') THEN json(json_set(value,'$.status','failed'))
            WHEN type IN ('object','array') THEN json(value)
            WHEN type IN ('true','false') THEN json(type)
            ELSE value END) FROM json_each(content,'$.tools'))))
        ELSE json_set(content,'$.status',?2,'$.updatedAt',?3) END,updated_at=?3 WHERE "
    };
}
// Settling rewrites each row's status, so the stop triggers empty the trackers as it goes.
// Each also repeats the tracker's full predicate (`running_tool!` / `running_subagent!`) on the
// row itself, so a stale tracker entry (left by a write that bypassed the triggers) never fails a
// finished tool, a non-tool row or a snapshot missing `$.type`/`$.version`, nor stops a settled
// subagent.
const SETTLE_TOOLS_ONE: &str = concat!(settle_tool_set!(), "session_id=?1) AND session_id=?1 AND ", running_tool!(""));
const SETTLE_TOOLS_ACTIVE: &str = concat!(settle_tool_set!(), "session_id IN (SELECT id FROM sessions WHERE status IN ('running','waiting'))) AND session_id IN (SELECT id FROM sessions WHERE status IN ('running','waiting')) AND ", running_tool!(""));
const SETTLE_SUBAGENTS_ONE: &str = concat!(settle_subagent_set!(), "session_id=?1 AND id IN (SELECT id FROM running_subagents WHERE session_id=?1) AND ", running_subagent!(""));
const SETTLE_SUBAGENTS_ALL: &str = concat!(settle_subagent_set!(), "(session_id,id) IN (SELECT session_id,id FROM running_subagents) AND ", running_subagent!(""));
// The same updates on the base tables, for a newer schema without a usable tracker.
const SETTLE_TOOLS_ONE_BASE: &str = concat!(settle_tool_update!(""), "session_id=?1 AND ", running_tool!(""));
const SETTLE_TOOLS_ACTIVE_BASE: &str = concat!(settle_tool_update!(""), "session_id IN (SELECT id FROM sessions WHERE status IN ('running','waiting')) AND ", running_tool!(""));
const SETTLE_SUBAGENTS_ONE_BASE: &str = concat!(settle_subagent_set!(), "session_id=?1 AND ", running_subagent!(""));
const SETTLE_SUBAGENTS_ALL_BASE: &str = concat!(settle_subagent_set!(), running_subagent!(""));

/// Fails running tools for one task or for all running and waiting tasks at startup.
pub(super) fn settle_unfinished_tools(db: &Connection, sid: Option<&str>, notice: &str, tracked: bool) -> Result<()> {
    let sql = match (sid.is_some(), tracked) {
        (true, true) => SETTLE_TOOLS_ONE,
        (false, true) => SETTLE_TOOLS_ACTIVE,
        (true, false) => SETTLE_TOOLS_ONE_BASE,
        (false, false) => SETTLE_TOOLS_ACTIVE_BASE,
    };
    db.prepare_cached(sql)
        .and_then(|mut statement| statement.execute(params![sid, notice]))
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Settles unfinished subagents for one task or for every task at startup.
pub(super) fn settle_unfinished_subagents(db: &Connection, sid: Option<&str>, status: &str, tracked: bool) -> Result<()> {
    let sql = match (sid.is_some(), tracked) {
        (true, true) => SETTLE_SUBAGENTS_ONE,
        (false, true) => SETTLE_SUBAGENTS_ALL,
        (true, false) => SETTLE_SUBAGENTS_ONE_BASE,
        (false, false) => SETTLE_SUBAGENTS_ALL_BASE,
    };
    db.prepare_cached(sql)
        .and_then(|mut statement| statement.execute(params![sid, status, now()]))
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// The additive upgrade inside `Store::open`'s migration transaction. `bots::upgrade` owns
/// the bot tables and their indexes (tables added to `bots::SCHEMA` after a database passed
/// version 29 are otherwise created only when bots start). On failure, its savepoint is rolled
/// back and the error is logged (`repair_v38_objects` retries the bot indexes on the next open).
/// The rest of the step is fatal.
pub(super) fn upgrade_v38(migration: &Connection) -> Result<()> {
    let guard = RollbackGuard::new(migration);
    if let Err(error) = run_savepoint(
        migration,
        "pandacode_v38_bots",
        || crate::bots::upgrade(migration),
        |e| e.to_string(),
    ) {
        // On I/O or disk-full errors SQLite rolls the transaction back; never go on in autocommit mode.
        if guard.rolled_back() {
            return Err(format!("Upgrading bot tables/indexes: {error}"));
        }
        eprintln!("Upgrading bot tables/indexes: {error}");
    }
    migration.execute_batch(SCHEMA_38_INDEXES).map_err(|e| e.to_string())?;
    migration.execute_batch(LEGACY_TEAM_STATUS_CLEANUP).map_err(|e| e.to_string())?;
    migration.execute_batch(SCHEMA_38_RUNNING).map_err(|e| e.to_string())?;
    for index in SCHEMA_38_TRACKER_INDEXES {
        migration.execute_batch(index).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Runs each `;`-separated statement of `sql` inside the open transaction `tx`, logging a failure
/// (prefixed with `label`) and going on, so one index that cannot be built never keeps the later
/// ones from being restored. A failed statement normally leaves the transaction open; on I/O or
/// disk-full errors SQLite rolls it back, and going on would run the rest in autocommit mode, so
/// that error is returned instead.
pub(super) fn run_optional_statements(tx: &Connection, sql: &str, label: &str) -> Result<()> {
    let guard = RollbackGuard::new(tx);
    for statement in sql.split(';').map(str::trim).filter(|s| !s.is_empty()) {
        if let Err(error) = tx.execute_batch(statement) {
            if guard.rolled_back() {
                return Err(format!("{label}: {error}"));
            }
            eprintln!("{label}: {error}");
        }
    }
    Ok(())
}

/// Restores bot tables, columns and indexes. Try indexes individually even if upgrade fails
/// before reaching them, such as when SQLite rejects an ALTER TABLE.
fn repair_bot_indexes(repair: &Connection, has_bots_project: bool) -> Result<()> {
    const LABEL: &str = "Restoring a bot index";
    let guard = RollbackGuard::new(repair);
    if let Err(error) = run_savepoint(
        repair,
        "pandacode_v38_repair_bots",
        || crate::bots::upgrade(repair),
        |e| e.to_string(),
    ) {
        if guard.rolled_back() {
            return Err(format!("{LABEL}: {error}"));
        }
        eprintln!("{LABEL}: {error}");
    }
    run_optional_statements(repair, crate::bots::INDEXES, LABEL)?;
    if has_bots_project {
        run_optional_statements(repair, crate::bots::PROJECT_INDEX, LABEL)?;
    }
    Ok(())
}

/// Repairs v38 tracker tables and triggers, then restores optional tracker, schema and bot
/// indexes, only through `SCHEMA_VERSION`. Index statement failures are logged individually.
/// A write-lock, transaction rollback or commit error fails the open only when base schema,
/// legacy object cleanup or tracker core repair is required.
///
/// A healthy database takes one `sqlite_master` read. When objects are missing, the read-only
/// plan skips the write lock when only permanently blocked indexes are missing.
pub(super) fn repair_v38_objects(db: &mut Connection, version: i64) -> Result<()> {
    repair_v38_objects_with(db, version, repair_optional_indexes)
}

/// Which optional index groups have a missing index that can be built.
#[derive(Clone, Copy, Debug)]
struct MissingIndexes {
    has_bots_project: bool,
    bot: bool,
    schema: bool,
    tracker_indexes: [bool; TRACKER_INDEX_PREREQS.len()],
}

impl MissingIndexes {
    fn any(self) -> bool {
        self.bot || self.schema || self.tracker_indexes.contains(&true)
    }
}

/// Restores the missing optional index groups. An error means SQLite rolled the transaction back.
fn repair_optional_indexes(repair: &Connection, missing: MissingIndexes) -> Result<()> {
    for (statement, missing) in SCHEMA_38_TRACKER_INDEXES.into_iter().zip(missing.tracker_indexes) {
        if missing {
            run_optional_statements(repair, statement, "Restoring a version 38 tracker index")?;
        }
    }
    if missing.bot {
        repair_bot_indexes(repair, missing.has_bots_project)?;
    }
    if missing.schema {
        run_optional_statements(repair, SCHEMA_38_INDEXES, "Restoring a version 38 index")?;
    }
    Ok(())
}

/// `repair_v38_objects` with the optional index step injectable, so tests can force SQLite's
/// rollback (disk full, I/O error) in it.
fn repair_v38_objects_with(
    db: &mut Connection,
    version: i64,
    optional_step: impl FnOnce(&Connection, MissingIndexes) -> Result<()>,
) -> Result<()> {
    if version > SCHEMA_VERSION {
        return Ok(());
    }
    let (found, trackers_found, _, legacy, missing_base) = v38_objects_present(db)?;
    // Avoid the write lock when only unbuildable indexes are missing.
    let fatal = legacy || missing_base || trackers_found < V38_TRACKER_OBJECTS;
    if found >= V38_OBJECTS && !fatal {
        return Ok(());
    }
    if !fatal && !plan_v38_repair(db, false)?.any() {
        return Ok(());
    }
    // Only setup failures use the initial repair plan. The transaction determines
    // whether any errors after taking the writer lock are fatal.
    let result = with_migration_pragmas(db, true, || {
        Ok(repair_v38_objects_in_transaction(db, version, fatal, optional_step))
    });
    or_skip(result, fatal, version)?.unwrap_or(Ok(()))
}

fn repair_v38_objects_in_transaction(
    db: &Connection,
    version: i64,
    fatal: bool,
    optional_step: impl FnOnce(&Connection, MissingIndexes) -> Result<()>,
) -> Result<()> {
    let Some(repair) = or_skip(Transaction::new_unchecked(db, TransactionBehavior::Immediate), fatal, version)? else { return Ok(()) };
    // Another instance may have migrated or repaired the database while this one waited.
    let Some(version) = or_skip(repair.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0)), fatal, version)? else { return Ok(()) };
    if version > SCHEMA_VERSION {
        return Ok(());
    }
    let Some((found, trackers, _, legacy, missing_base)) = or_skip(v38_objects_present(&repair), fatal, version)? else { return Ok(()) };
    let rebuild_trackers = trackers < V38_TRACKER_OBJECTS;
    let fatal = legacy || missing_base || rebuild_trackers;
    if found >= V38_OBJECTS && !fatal {
        return Ok(());
    }
    let started = rebuild_trackers.then(Instant::now);
    if missing_base {
        repair.execute_batch(BASE_SCHEMA).map_err(|e| e.to_string())?;
    }
    let Some(missing) = or_skip(plan_v38_repair(&repair, rebuild_trackers), fatal, version)? else { return Ok(()) };
    if legacy {
        repair.execute_batch(LEGACY_TEAM_STATUS_CLEANUP).map_err(|e| e.to_string())?;
    }
    if rebuild_trackers {
        repair.execute_batch(SCHEMA_38_RUNNING).map_err(|e| e.to_string())?;
    } else if !fatal && !missing.any() {
        return Ok(());
    }
    let result = if missing.any() { optional_step(&repair, missing) } else { Ok(()) };
    if or_skip(result, fatal, version)?.is_some() && or_skip(repair.commit(), fatal, version)?.is_some() {
        if let Some(started) = started {
            log_slow_upgrade(started);
        }
    }
    Ok(())
}

/// `result`'s value. A failure fails the open when `fatal`; otherwise it is logged and the repair
/// skipped (`None`).
fn or_skip<T, E: std::fmt::Display>(result: std::result::Result<T, E>, fatal: bool, version: i64) -> Result<Option<T>> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(error) if fatal => Err(error.to_string()),
        Err(error) => {
            eprintln!("Skipping version 38 repair (v{version}): {error}");
            Ok(None)
        }
    }
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod repair_tests;
