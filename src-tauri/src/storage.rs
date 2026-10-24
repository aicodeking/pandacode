use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
pub fn id() -> String {
    Uuid::new_v4().to_string()
}

pub fn valid_permission_mode(mode: &str) -> bool {
    matches!(mode, "ask" | "auto" | "plan" | "full")
}

// Only new user tasks use this default. Persisted tasks always retain their
// selected mode, including restrictive modes chosen before this default changed.
pub const DEFAULT_PERMISSION_MODE: &str = "full";

pub const COMPLETED_ARCHIVE_DELAY_MS: i64 = 7 * 24 * 60 * 60 * 1000;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextUsage {
    pub used_tokens: u64,
    pub context_window: Option<u64>,
}
impl ContextUsage {
    // Far above current model limits, while preventing malformed provider data
    // from overflowing SQLite integers or making the frontend's meter unusable.
    const MAX_TOKENS: u64 = 1_000_000_000;

    pub fn from_value(value: &serde_json::Value) -> Option<Self> {
        let usage = Self {
            used_tokens: value.get("usedTokens")?.as_u64()?,
            context_window: match value.get("contextWindow") {
                None | Some(serde_json::Value::Null) => None,
                Some(value) => Some(value.as_u64()?),
            },
        };
        usage.is_valid().then_some(usage)
    }

    fn is_valid(&self) -> bool {
        self.used_tokens <= Self::MAX_TOKENS
            && self
                .context_window
                .is_none_or(|window| window > 0 && window <= Self::MAX_TOKENS)
    }
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub provider: String,
    pub model: String,
    pub reasoning_effort: Option<String>,
    pub context_usage: Option<ContextUsage>,
    pub mode: String,
    pub status: String,
    pub created_at: i64,
    pub updated_at: i64,
    /// Unix milliseconds of the latest saved nonempty assistant response.
    pub last_response_at: Option<i64>,
    /// Latest saved user prompt; independent of agent responses and metadata edits.
    pub last_prompt_at: Option<i64>,
    pub archived: bool,
    /// Sidebar preferences never change task activity or execution state.
    pub pinned: bool,
    pub sidebar_order: Option<i64>,
    /// Opened from New task but not yet sent a prompt: hidden from task lists
    /// and discarded if left empty. The first saved prompt publishes it.
    pub draft: bool,
    /// When the account hit a usage limit during this task's last run, if it did.
    pub limited_at: Option<i64>,
    /// When that limit resets, if the harness reported it.
    pub limited_until: Option<i64>,
    pub resume_at_reset: bool,
    pub resume_id: Option<String>,
    /// Checkout owned by this task; the project continues to identify its repository.
    pub worktree_path: Option<String>,
    /// Branch created for that checkout, kept so chips and recreation need no Git call.
    pub worktree_branch: Option<String>,
    pub task_stage: String,
    pub task_description: String,
    pub completed_at: Option<i64>,
    pub goal_state: Option<crate::goal_state::GoalState>,
    pub codex_settings: Option<serde_json::Value>,
    /// GitHub work linked to this task; at most one issue and one pull request.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub issue: Option<TaskLink>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pull_request: Option<TaskLink>,
    /// A mirror of a task that runs on another computer (docs/remote-access.md).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_device: Option<RemoteDevice>,
    /// A task whose agent runs on a cloud machine (docs/cloud-agents.md):
    /// `{provider, label, machine, stage, detail}`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cloud: Option<serde_json::Value>,
}
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct RemoteDevice {
    pub id: String,
    pub name: String,
}
#[derive(Clone, Debug, Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TaskLink {
    pub kind: String,
    pub number: i64,
    pub url: String,
    pub title: String,
    pub state: String,
    pub checked_at: i64,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: i64,
    pub session_id: String,
    pub role: String,
    pub content: String,
    pub created_at: i64,
    /// Measured duration of the turn initiated by this user message.
    pub turn_duration_ms: Option<i64>,
    /// The saved response author, resolved independently of the visible page.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author_provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_changes: Option<crate::turn_changes::TurnChanges>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub coordination_kind: Option<crate::architect::internal_turns::CoordinationKind>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessagePage {
    pub messages: Vec<Message>,
    pub has_older: bool,
}

pub struct Store {
    pub db: Connection,
    pub path: PathBuf,
}
type Result<T> = std::result::Result<T, String>;
/// The newest `PRAGMA user_version`. Every migration step below must run for any
/// database older than this, so the guard reads this constant, never a literal.
pub const SCHEMA_VERSION: i64 = 27;

const SIDEBAR_ORDER: &str = "pinned DESC,sidebar_order IS NULL,sidebar_order,COALESCE(MAX(last_response_at,last_prompt_at),last_response_at,last_prompt_at,created_at) DESC,id";

fn settle_unfinished_tools(db: &Connection, sid: Option<&str>, notice: &str) -> Result<()> {
    db.execute("UPDATE messages SET content=json_set(content,'$.status','failed','$.output',
        COALESCE(json_extract(content,'$.output'),'') || ?2)
      WHERE role='tool' AND tool_id IS NOT NULL
        AND session_id IN (SELECT id FROM sessions WHERE id=?1 OR (?1 IS NULL AND status IN ('running','waiting')))
        AND CASE WHEN json_valid(content) THEN
          json_extract(content,'$.type')='tool_activity' AND json_extract(content,'$.version')=1
          AND json_extract(content,'$.status')='running' ELSE 0 END",
      params![sid, notice]).map_err(|e| e.to_string())?;
    Ok(())
}

fn settle_unfinished_subagents(db: &Connection, sid: Option<&str>, status: &str) -> Result<()> {
    db.execute("UPDATE subagents SET content=json_set(content,'$.status',?2,'$.updatedAt',?3,
        '$.tools',json((SELECT json_group_array(json(CASE
            WHEN json_extract(value,'$.status') IN ('running','waiting') THEN json_set(value,'$.status','failed')
            ELSE value END)) FROM json_each(content,'$.tools')))),updated_at=?3
        WHERE (?1 IS NULL OR session_id=?1)
        AND json_extract(content,'$.status') IN ('running','waiting')",
        params![sid,status,now()]).map_err(|error| error.to_string())?;
    Ok(())
}

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        let mut db = Connection::open(path).map_err(|e| e.to_string())?;
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL; PRAGMA cache_size=-1024; PRAGMA mmap_size=0;
            CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE);
            CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
              title TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, mode TEXT NOT NULL, status TEXT NOT NULL,
              created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0, resume_id TEXT);
            CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
              role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id, id);
            CREATE INDEX IF NOT EXISTS messages_handoffs ON messages(session_id, id) WHERE role='handoff';").map_err(|e| e.to_string())?;
        let version: i64 = db
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(|e| e.to_string())?;
        if version < SCHEMA_VERSION {
            // One transactional backfill, using the existing session/message
            // index. Listing tasks subsequently reads only session metadata.
            let migration = db
                .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
                .map_err(|e| e.to_string())?;
            // Another app instance may have migrated while this one waited.
            let version: i64 = migration
                .pragma_query_value(None, "user_version", |row| row.get(0))
                .map_err(|e| e.to_string())?;
            if version < 2 {
                migration.execute_batch("ALTER TABLE sessions ADD COLUMN last_response_at INTEGER;
                UPDATE sessions SET last_response_at=(
                  SELECT MAX(created_at) FROM messages
                  WHERE session_id=sessions.id AND role='assistant' AND content<>'');
                CREATE TRIGGER messages_record_response AFTER INSERT ON messages
                  WHEN NEW.role='assistant' AND NEW.content<>''
                  BEGIN
                    UPDATE sessions SET last_response_at=MAX(COALESCE(last_response_at,NEW.created_at),NEW.created_at)
                    WHERE id=NEW.session_id;
                  END;
                PRAGMA user_version=2;").map_err(|e| e.to_string())?;
            }
            if version < 3 {
                migration
                    .execute_batch(
                        "ALTER TABLE messages ADD COLUMN tool_id TEXT;
                  CREATE UNIQUE INDEX messages_tool ON messages(session_id,tool_id);
                  PRAGMA user_version=3;",
                    )
                    .map_err(|e| e.to_string())?;
            }
            if version < 4 {
                migration
                    .execute_batch("ALTER TABLE sessions ADD COLUMN worktree_path TEXT;")
                    .map_err(|e| e.to_string())?;
            }
            if version < 5 {
                Self::migrate_legacy_worktrees(&migration)?;
                migration
                    .pragma_update(None, "user_version", 5)
                    .map_err(|e| e.to_string())?;
            }
            if version < 6 {
                migration.execute_batch("ALTER TABLE messages ADD COLUMN turn_duration_ms INTEGER CHECK(turn_duration_ms >= 0);
                    PRAGMA user_version=6;").map_err(|e| e.to_string())?;
            }
            if version < 7 {
                migration.execute_batch("ALTER TABLE sessions ADD COLUMN reasoning_effort TEXT;
                    ALTER TABLE sessions ADD COLUMN context_used_tokens INTEGER CHECK(context_used_tokens >= 0 AND context_used_tokens <= 1000000000);
                    ALTER TABLE sessions ADD COLUMN context_window INTEGER CHECK(context_window > 0 AND context_window <= 1000000000);
                    PRAGMA user_version=7;").map_err(|e| e.to_string())?;
            }
            if version < 8 {
                migration.execute_batch("ALTER TABLE sessions ADD COLUMN task_stage TEXT NOT NULL DEFAULT 'pending' CHECK(task_stage IN ('pending','in_progress','review','completed'));
                    ALTER TABLE sessions ADD COLUMN task_description TEXT NOT NULL DEFAULT '';
                    ALTER TABLE sessions ADD COLUMN completed_at INTEGER;
                    UPDATE sessions SET task_stage=CASE
                      WHEN status IN ('running','waiting','interrupted','error') THEN 'in_progress'
                      WHEN EXISTS(SELECT 1 FROM messages WHERE session_id=sessions.id) THEN 'review'
                      ELSE 'pending' END,
                      task_description=COALESCE((SELECT substr(content,1,131072) FROM messages WHERE session_id=sessions.id AND role='user' ORDER BY id LIMIT 1),'');
                    CREATE INDEX sessions_completed_archive ON sessions(completed_at) WHERE archived=0 AND task_stage='completed';
                    PRAGMA user_version=8;").map_err(|e| e.to_string())?;
            }
            if version < 9 {
                migration
                    .execute_batch(
                        "CREATE TABLE subagents(
                    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                    id TEXT NOT NULL,content TEXT NOT NULL,updated_at INTEGER NOT NULL,
                    PRIMARY KEY(session_id,id));
                    CREATE INDEX subagents_session_updated ON subagents(session_id,updated_at DESC);
                    PRAGMA user_version=9;",
                    )
                    .map_err(|e| e.to_string())?;
            }
            if version < 10 {
                migration
                    .execute_batch(
                        "ALTER TABLE sessions ADD COLUMN goal_state TEXT;
                    ALTER TABLE sessions ADD COLUMN codex_settings TEXT;
                    PRAGMA user_version=10;",
                    )
                    .map_err(|e| e.to_string())?;
            }
            if version < 11 {
                migration.execute_batch("CREATE TABLE IF NOT EXISTS architect_teams(session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,content TEXT NOT NULL);
                    CREATE TABLE IF NOT EXISTS architect_workers(parent_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,worker_id TEXT NOT NULL,session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,PRIMARY KEY(parent_session_id,worker_id));
                    CREATE INDEX IF NOT EXISTS architect_workers_parent ON architect_workers(parent_session_id);
                    CREATE TABLE IF NOT EXISTS architect_requests(parent_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,key TEXT NOT NULL,kind TEXT NOT NULL,content TEXT NOT NULL,worker_id TEXT NOT NULL,PRIMARY KEY(parent_session_id,key));
                    PRAGMA user_version=11;").map_err(|e|e.to_string())?;
            }
            if version < 12 {
                migration.execute_batch("CREATE TABLE IF NOT EXISTS architect_library(id INTEGER PRIMARY KEY CHECK(id=1),content TEXT NOT NULL CHECK(json_valid(content))); PRAGMA user_version=12;").map_err(|e|e.to_string())?;
            }
            if version < 13 {
                migration.execute_batch("CREATE TABLE IF NOT EXISTS turn_changes(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,message_id INTEGER NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,summary TEXT NOT NULL CHECK(json_valid(summary)),created_at INTEGER NOT NULL,diff_bytes INTEGER NOT NULL DEFAULT 0); CREATE INDEX IF NOT EXISTS turn_changes_session ON turn_changes(session_id,message_id); CREATE INDEX IF NOT EXISTS turn_changes_retained ON turn_changes(created_at,id) WHERE diff_bytes>0; CREATE TABLE IF NOT EXISTS turn_change_files(change_id TEXT NOT NULL REFERENCES turn_changes(id) ON DELETE CASCADE,path TEXT NOT NULL,detail TEXT NOT NULL CHECK(json_valid(detail)),PRIMARY KEY(change_id,path)); PRAGMA user_version=13;").map_err(|e|e.to_string())?;
            }
            if version < 14 {
                migration.execute_batch("CREATE TABLE IF NOT EXISTS context_recovery(session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,through_message_id INTEGER NOT NULL); PRAGMA user_version=14;").map_err(|e|e.to_string())?;
                migration.execute("INSERT INTO context_recovery(session_id,through_message_id) SELECT s.id,MAX(m.id) FROM sessions s JOIN messages m ON m.session_id=s.id WHERE m.role IN ('user','assistant') AND m.content<>'' AND EXISTS(SELECT 1 FROM messages notice WHERE notice.session_id=s.id AND notice.role='system' AND notice.content=?1) GROUP BY s.id ON CONFLICT(session_id) DO UPDATE SET through_message_id=MAX(through_message_id,excluded.through_message_id)", [crate::context_recovery::LEGACY_NOTICE]).map_err(|e|e.to_string())?;
            }
            if version < 15 {
                migration.execute_batch("CREATE TABLE IF NOT EXISTS moodboards(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,name TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS moodboards_project ON moodboards(project_id,updated_at); CREATE TABLE IF NOT EXISTS moodboard_images(id TEXT PRIMARY KEY,board_id TEXT NOT NULL REFERENCES moodboards(id) ON DELETE CASCADE,name TEXT NOT NULL,caption TEXT NOT NULL DEFAULT '',mime_type TEXT NOT NULL,width INTEGER NOT NULL,height INTEGER NOT NULL,original BLOB NOT NULL,thumbnail BLOB NOT NULL,agent_image BLOB NOT NULL,created_at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS moodboard_images_board ON moodboard_images(board_id,created_at); PRAGMA user_version=15;").map_err(|e|e.to_string())?;
            }
            if version < 16 {
                migration.execute_batch("CREATE TABLE IF NOT EXISTS architect_messages(id INTEGER PRIMARY KEY AUTOINCREMENT,parent_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,sender TEXT NOT NULL,recipient TEXT NOT NULL,request_key TEXT NOT NULL,content TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(parent_session_id,sender,request_key)); CREATE INDEX IF NOT EXISTS architect_messages_mailbox ON architect_messages(parent_session_id,recipient,id); CREATE INDEX IF NOT EXISTS architect_messages_team ON architect_messages(parent_session_id,id); PRAGMA user_version=16;").map_err(|e|e.to_string())?;
                // Codex saves its dynamic-tool catalog in its native context. Start a
                // fresh context once for team tasks so existing teams receive the new
                // role-specific coordination tools, retaining only their own history.
                migration.execute_batch("INSERT INTO context_recovery(session_id,through_message_id) SELECT s.id,MAX(m.id) FROM sessions s JOIN messages m ON m.session_id=s.id WHERE s.provider='codex' AND s.resume_id IS NOT NULL AND (s.id IN (SELECT session_id FROM architect_teams) OR s.id IN (SELECT session_id FROM architect_workers)) GROUP BY s.id ON CONFLICT(session_id) DO UPDATE SET through_message_id=MAX(through_message_id,excluded.through_message_id); UPDATE sessions SET resume_id=NULL,context_used_tokens=NULL,context_window=NULL WHERE provider='codex' AND (id IN (SELECT session_id FROM architect_teams) OR id IN (SELECT session_id FROM architect_workers));").map_err(|e|e.to_string())?;
            }
            if version < 17 {
                migration.execute_batch("CREATE TABLE IF NOT EXISTS jev_assessments(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,created_at INTEGER NOT NULL,report TEXT NOT NULL CHECK(json_valid(report))); CREATE INDEX IF NOT EXISTS jev_assessments_task ON jev_assessments(session_id,created_at DESC,id); CREATE INDEX IF NOT EXISTS jev_assessments_retention ON jev_assessments(created_at DESC,id); CREATE TABLE IF NOT EXISTS jev_project_rules(project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,rules TEXT NOT NULL CHECK(json_valid(rules))); PRAGMA user_version=17;").map_err(|e|e.to_string())?;
            }
            if version < 18 {
                // Linked GitHub work and the branch behind each worktree checkout. Test
                // fixtures rebuild old schemas selectively, so the column add is guarded.
                let has_branch: i64 = migration.query_row("SELECT COUNT(*) FROM pragma_table_info('sessions') WHERE name='worktree_branch'", [], |r| r.get(0)).map_err(|e| e.to_string())?;
                if has_branch == 0 {
                    migration.execute_batch("ALTER TABLE sessions ADD COLUMN worktree_branch TEXT;").map_err(|e| e.to_string())?;
                }
                migration.execute_batch("CREATE TABLE IF NOT EXISTS task_links(session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,kind TEXT NOT NULL CHECK(kind IN ('issue','pull')),number INTEGER NOT NULL,url TEXT NOT NULL,title TEXT NOT NULL DEFAULT '',state TEXT NOT NULL DEFAULT '',checked_at INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(session_id,kind)); CREATE INDEX IF NOT EXISTS task_links_number ON task_links(kind,number); PRAGMA user_version=18;").map_err(|e|e.to_string())?;
            }
            if version < 19 {
                // Guard the column because migration fixtures selectively rebuild older schemas.
                let has_prompt: i64 = migration.query_row("SELECT COUNT(*) FROM pragma_table_info('sessions') WHERE name='last_prompt_at'", [], |r| r.get(0)).map_err(|e| e.to_string())?;
                if has_prompt == 0 {
                    migration.execute_batch("ALTER TABLE sessions ADD COLUMN last_prompt_at INTEGER;").map_err(|e| e.to_string())?;
                }
                migration.execute_batch("UPDATE sessions SET last_prompt_at=(SELECT MAX(created_at) FROM messages WHERE session_id=sessions.id AND role='user' AND trim(content)<>'');
                  CREATE TRIGGER IF NOT EXISTS messages_record_prompt AFTER INSERT ON messages
                    WHEN NEW.role='user' AND trim(NEW.content)<>''
                    BEGIN
                      UPDATE sessions SET last_prompt_at=MAX(COALESCE(last_prompt_at,NEW.created_at),NEW.created_at) WHERE id=NEW.session_id;
                    END;
                  PRAGMA user_version=19;").map_err(|e| e.to_string())?;
                Self::backfill_legacy_prompt_activity(&migration)?;
            }
            if version < 20 {
                let has_origin: i64 = migration.query_row("SELECT COUNT(*) FROM pragma_table_info('sessions') WHERE name='title_origin'", [], |r| r.get(0)).map_err(|e| e.to_string())?;
                if has_origin == 0 {
                    migration.execute_batch("ALTER TABLE sessions ADD COLUMN title_origin TEXT NOT NULL DEFAULT 'legacy' CHECK(title_origin IN ('legacy','auto','manual'));").map_err(|e| e.to_string())?;
                }
                migration.execute_batch("PRAGMA user_version=20;").map_err(|e| e.to_string())?;
            }
            if version < 21 {
                // Older migration fixtures may already retain these columns.
                for (name, definition) in [
                    ("pinned", "INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0,1))"),
                    ("sidebar_order", "INTEGER CHECK(sidebar_order >= 0)"),
                ] {
                    let exists: bool = migration.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('sessions') WHERE name=?1)", [name], |r| r.get(0)).map_err(|e| e.to_string())?;
                    if !exists {
                        migration.execute_batch(&format!("ALTER TABLE sessions ADD COLUMN {name} {definition};")).map_err(|e| e.to_string())?;
                    }
                }
                migration.execute_batch(&format!("CREATE INDEX IF NOT EXISTS sessions_sidebar ON sessions({SIDEBAR_ORDER}); PRAGMA user_version=21;")).map_err(|e| e.to_string())?;
            }
            if version < 22 {
                let has_draft: bool = migration.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('sessions') WHERE name='draft')", [], |r| r.get(0)).map_err(|e| e.to_string())?;
                if !has_draft {
                    migration.execute_batch("ALTER TABLE sessions ADD COLUMN draft INTEGER NOT NULL DEFAULT 0 CHECK(draft IN (0,1));").map_err(|e| e.to_string())?;
                }
                // A draft becomes a task when its first prompt is saved, dated from that prompt.
                migration.execute_batch("CREATE TRIGGER IF NOT EXISTS messages_publish_draft AFTER INSERT ON messages
                    WHEN NEW.role='user' AND trim(NEW.content)<>''
                    BEGIN
                      UPDATE sessions SET draft=0,created_at=NEW.created_at,updated_at=MAX(updated_at,NEW.created_at) WHERE id=NEW.session_id AND draft=1;
                    END;
                  PRAGMA user_version=22;").map_err(|e| e.to_string())?;
            }
            if version < 23 {
                // Messages typed while an agent works, delivered in order after the run.
                migration.execute_batch("CREATE TABLE IF NOT EXISTS queued_messages(
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                    position INTEGER NOT NULL,
                    text TEXT NOT NULL,
                    attachments TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(attachments)),
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL);
                  CREATE INDEX IF NOT EXISTS queued_messages_session ON queued_messages(session_id,position);
                  PRAGMA user_version=23;").map_err(|e| e.to_string())?;
            }
            if version < 24 {
                // Usage limits: when one was hit, when it resets (null when unknown), and
                // whether to continue automatically then. New user work clears all three.
                for (name, definition) in [
                    ("limited_at", "INTEGER"),
                    ("limited_until", "INTEGER"),
                    ("resume_at_reset", "INTEGER NOT NULL DEFAULT 0 CHECK(resume_at_reset IN (0,1))"),
                ] {
                    let exists: bool = migration.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('sessions') WHERE name=?1)", [name], |r| r.get(0)).map_err(|e| e.to_string())?;
                    if !exists {
                        migration.execute_batch(&format!("ALTER TABLE sessions ADD COLUMN {name} {definition};")).map_err(|e| e.to_string())?;
                    }
                }
                migration.execute_batch("CREATE TRIGGER IF NOT EXISTS messages_clear_limit AFTER INSERT ON messages
                    WHEN NEW.role='user' AND trim(NEW.content)<>''
                    BEGIN
                      UPDATE sessions SET limited_at=NULL,limited_until=NULL,resume_at_reset=0 WHERE id=NEW.session_id AND limited_at IS NOT NULL;
                    END;
                  PRAGMA user_version=24;").map_err(|e| e.to_string())?;
            }
            if version < 25 {
                // Bots: always-on agents reachable from channels (docs/bots.md).
                migration.execute_batch(crate::bots::SCHEMA).map_err(|e| e.to_string())?;
                migration.execute_batch("PRAGMA user_version=25;").map_err(|e| e.to_string())?;
            }
            if version < 26 {
                // Mirrors: a task that runs on another computer, and the last of its
                // messages copied here (docs/remote-access.md).
                for (name, definition) in [("remote_device", "TEXT"), ("remote_session", "TEXT"), ("remote_synced_id", "INTEGER NOT NULL DEFAULT 0")] {
                    let exists: bool = migration.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('sessions') WHERE name=?1)", [name], |r| r.get(0)).map_err(|e| e.to_string())?;
                    if !exists {
                        migration.execute_batch(&format!("ALTER TABLE sessions ADD COLUMN {name} {definition};")).map_err(|e| e.to_string())?;
                    }
                }
                migration.execute_batch("CREATE UNIQUE INDEX IF NOT EXISTS sessions_remote ON sessions(remote_device,remote_session) WHERE remote_session IS NOT NULL; PRAGMA user_version=26;").map_err(|e| e.to_string())?;
            }
            if version < 27 {
                // Cloud agents: the machine and run behind a task (docs/cloud-agents.md).
                let exists: bool = migration.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('sessions') WHERE name='cloud')", [], |r| r.get(0)).map_err(|e| e.to_string())?;
                if !exists {
                    migration.execute_batch("ALTER TABLE sessions ADD COLUMN cloud TEXT CHECK(cloud IS NULL OR json_valid(cloud));").map_err(|e| e.to_string())?;
                }
                migration.execute_batch("PRAGMA user_version=27;").map_err(|e| e.to_string())?;
            }
            migration.commit().map_err(|e| e.to_string())?;
        }
        let recovery = db.transaction().map_err(|e| e.to_string())?;
        // Only rows from before typed coordination existed are eligible for the
        // narrowly scoped legacy display projection. New user copies stay user text.
        Self::record_legacy_prompt_cutoff(&recovery)?;
        settle_unfinished_tools(
            &recovery,
            None,
            "\n\n[PandaCode was interrupted before this tool reported a result.]",
        )?;
        settle_unfinished_subagents(&recovery, None, "stopped")?;
        recovery
            .execute(
                "UPDATE sessions SET status='interrupted',task_stage='in_progress',completed_at=NULL WHERE status IN ('running','waiting')",
                [],
            )
            .map_err(|e| e.to_string())?;
        recovery
            .execute(
                "UPDATE sessions SET goal_state=json_set(goal_state,'$.status','paused')
            WHERE json_valid(goal_state) AND json_extract(goal_state,'$.status')='active'",
                [],
            )
            .map_err(|e| e.to_string())?;
        recovery.execute_batch("UPDATE architect_teams SET content=json_set(content,'$.status','interrupted','$.pendingTurn',NULL,'$.error','PandaCode restarted. Resume explicitly to continue.','$.generation',COALESCE(json_extract(content,'$.generation'),0)+1,'$.revision',COALESCE(json_extract(content,'$.revision'),0)+1,
            '$.workers',json((SELECT json_group_array(json(CASE WHEN json_extract(value,'$.status') IN ('running','waiting') THEN json_set(value,'$.status','stopped') ELSE value END)) FROM json_each(content,'$.workers'))))
            WHERE json_extract(content,'$.status') IN ('running','waiting');").map_err(|e|e.to_string())?;
        recovery.commit().map_err(|e| e.to_string())?;
        let store = Self {
            db,
            path: path.to_path_buf(),
        };
        crate::architect::profiles::initialize(&store)?;
        store.archive_completed(now())?;
        Ok(store)
    }
    /// Older team releases stored scheduler prompts as user rows. Reuse their exact
    /// provenance check once during migration, rather than reading transcripts on every list.
    fn record_legacy_prompt_cutoff(db: &Connection) -> Result<()> {
        db.execute_batch("UPDATE architect_teams SET content=json_set(content,'$.legacyPromptThroughId',COALESCE((SELECT MAX(id) FROM messages WHERE session_id=architect_teams.session_id),0)) WHERE json_type(content,'$.legacyPromptThroughId') IS NULL OR json_type(content,'$.legacyPromptThroughId')='null';").map_err(|e|e.to_string())?;
        Ok(())
    }

    fn backfill_legacy_prompt_activity(db: &Connection) -> Result<()> {
        Self::record_legacy_prompt_cutoff(db)?;
        let mut teams = db.prepare("SELECT session_id FROM architect_teams WHERE COALESCE(json_extract(content,'$.legacyPromptThroughId'),0)>0").map_err(|e| e.to_string())?;
        let ids = teams.query_map([], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())?;
        let mut messages = db.prepare("SELECT id,content,created_at FROM messages WHERE session_id=?1 AND role='user' AND trim(content)<>'' ORDER BY created_at DESC,id DESC").map_err(|e| e.to_string())?;
        for sid in ids {
            let sid = sid.map_err(|e| e.to_string())?;
            let rows = messages.query_map([&sid], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?))).map_err(|e| e.to_string())?;
            let mut prompt_at = None;
            for row in rows {
                let (id, content, created_at) = row.map_err(|e| e.to_string())?;
                if crate::architect::internal_turns::legacy_kind_in_db(db, &sid, id, &content)?.is_none() {
                    prompt_at = Some(created_at); break;
                }
            }
            db.execute("UPDATE sessions SET last_prompt_at=?2 WHERE id=?1", params![sid,prompt_at]).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    fn migrate_legacy_worktrees(db: &Connection) -> Result<()> {
        let projects = Self::read_projects(db)?;
        let registered: Vec<_> = projects
            .iter()
            .map(|project| PathBuf::from(&project.path))
            .collect();
        for legacy in &projects {
            let Some(parent) =
                crate::workspace::legacy_worktree_parent(Path::new(&legacy.path), &registered)
            else {
                continue;
            };
            let Some(project) = projects
                .iter()
                .find(|project| Path::new(&project.path) == parent)
            else {
                continue;
            };
            let moved = db.execute("UPDATE sessions SET project_id=?2,worktree_path=COALESCE(worktree_path,?3) WHERE project_id=?1",
                params![legacy.id,project.id,legacy.path]).map_err(|e| e.to_string())?;
            if moved == 0 {
                // An old worktree may have been created before its first task.
                let choice = db.query_row("SELECT provider,model FROM sessions WHERE project_id=?1 ORDER BY updated_at DESC LIMIT 1",
                    [&project.id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
                    .optional().map_err(|e| e.to_string())?.unwrap_or_else(|| ("claude".into(), "default".into()));
                db.execute("INSERT INTO sessions(id,project_id,title,provider,model,mode,status,created_at,updated_at,worktree_path)
                    VALUES (?1,?2,'New conversation',?3,?4,'ask','idle',?5,?5,?6)",
                    params![id(),project.id,choice.0,choice.1,now(),legacy.path]).map_err(|e| e.to_string())?;
            }
            db.execute("DELETE FROM projects WHERE id=?1", [&legacy.id])
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub fn projects(&self) -> Result<Vec<Project>> {
        Self::read_projects(&self.db)
    }
    fn read_projects(db: &Connection) -> Result<Vec<Project>> {
        let mut stmt = db
            .prepare("SELECT id,name,path FROM projects ORDER BY name COLLATE NOCASE")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok(Project {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    path: r.get(2)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }
    pub fn add_project(&self, path: &Path) -> Result<Project> {
        let path = path
            .canonicalize()
            .map_err(|e| format!("Cannot open folder: {e}"))?;
        if !path.is_dir() {
            return Err("Choose a folder.".into());
        }
        let path_str = path.to_string_lossy().to_string();
        let name = path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| path_str.clone());
        self.db
            .execute(
                "INSERT OR IGNORE INTO projects(id,name,path) VALUES (?1,?2,?3)",
                params![id(), name, path_str],
            )
            .map_err(|e| e.to_string())?;
        self.db
            .query_row(
                "SELECT id,name,path FROM projects WHERE path=?1",
                [path_str],
                |r| {
                    Ok(Project {
                        id: r.get(0)?,
                        name: r.get(1)?,
                        path: r.get(2)?,
                    })
                },
            )
            .map_err(|e| e.to_string())
    }
    pub fn project(&self, project_id: &str) -> Result<Project> {
        self.db
            .query_row(
                "SELECT id,name,path FROM projects WHERE id=?1",
                [project_id],
                |r| {
                    Ok(Project {
                        id: r.get(0)?,
                        name: r.get(1)?,
                        path: r.get(2)?,
                    })
                },
            )
            .optional()
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "Project not found.".into())
    }
    pub fn remove_project(&self, project_id: &str) -> Result<()> {
        self.db
            .execute("DELETE FROM projects WHERE id=?1", [project_id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    fn session_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Session> {
        let used_tokens: Option<i64> = r.get(14)?;
        let context_window: Option<i64> = r.get(15)?;
        let context_usage = used_tokens
            .and_then(|tokens| u64::try_from(tokens).ok())
            .and_then(|used_tokens| {
                let context_window = match context_window {
                    Some(window) => Some(u64::try_from(window).ok()?),
                    None => None,
                };
                let usage = ContextUsage {
                    used_tokens,
                    context_window,
                };
                usage.is_valid().then_some(usage)
            });
        Ok(Session {
            id: r.get(0)?,
            project_id: r.get(1)?,
            title: r.get(2)?,
            provider: r.get(3)?,
            model: r.get(4)?,
            mode: r.get(5)?,
            status: r.get(6)?,
            created_at: r.get(7)?,
            updated_at: r.get(8)?,
            archived: r.get(9)?,
            pinned: r.get(23)?,
            sidebar_order: r.get(24)?,
            draft: r.get(25)?,
            limited_at: r.get(26)?,
            limited_until: r.get(27)?,
            resume_at_reset: r.get(28)?,
            resume_id: r.get(10)?,
            last_response_at: r.get(11)?,
            last_prompt_at: r.get(22)?,
            worktree_path: r.get(12)?,
            reasoning_effort: r.get(13)?,
            context_usage,
            task_stage: r.get(16)?,
            task_description: r.get(17)?,
            completed_at: r.get(18)?,
            goal_state: r
                .get::<_, Option<String>>(19)?
                .and_then(|s| serde_json::from_str::<crate::goal_state::GoalState>(&s).ok())
                .filter(|g| g.is_valid()),
            codex_settings: r
                .get::<_, Option<String>>(20)?
                .and_then(|s| serde_json::from_str(&s).ok()),
            worktree_branch: r.get(21)?,
            remote_device: r.get::<_, Option<String>>(29)?.map(|id| RemoteDevice { name: crate::remote::device_label(&id), id }),
            cloud: r.get::<_, Option<String>>(30)?.as_deref().and_then(crate::cloud_agents::view),
            issue: None,
            pull_request: None,
        })
    }
    pub fn sessions(&self) -> Result<Vec<Session>> {
        // Lists only need a card preview. Full details remain in SQLite and are
        // fetched for the selected task or directly for an agent's Start prompt.
        let mut stmt=self.db.prepare(&format!("SELECT id,project_id,title,provider,model,mode,status,created_at,updated_at,archived,resume_id,last_response_at,worktree_path,reasoning_effort,context_used_tokens,context_window,task_stage,substr(task_description,1,512),completed_at,goal_state,codex_settings,worktree_branch,last_prompt_at,pinned,sidebar_order,draft,limited_at,limited_until,resume_at_reset,remote_device,cloud FROM sessions WHERE draft=0 AND id NOT IN (SELECT session_id FROM architect_workers) ORDER BY {SIDEBAR_ORDER} LIMIT 500")).map_err(|e|e.to_string())?;
        let rows = stmt
            .query_map([], Self::session_row)
            .map_err(|e| e.to_string())?;
        let mut sessions = rows
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        self.attach_links(&mut sessions)?;
        Ok(sessions)
    }
    pub fn session(&self, sid: &str) -> Result<Session> {
        let mut session = self.db.query_row("SELECT id,project_id,title,provider,model,mode,status,created_at,updated_at,archived,resume_id,last_response_at,worktree_path,reasoning_effort,context_used_tokens,context_window,task_stage,task_description,completed_at,goal_state,codex_settings,worktree_branch,last_prompt_at,pinned,sidebar_order,draft,limited_at,limited_until,resume_at_reset,remote_device,cloud FROM sessions WHERE id=?1",[sid],Self::session_row).optional().map_err(|e|e.to_string())?.ok_or_else(||String::from("Conversation not found."))?;
        self.attach_links(std::slice::from_mut(&mut session))?;
        Ok(session)
    }

    /// Prompts sent from PandaCode per hour and agent since `since_ms`, for the usage calendar.
    pub fn prompt_activity(&self, since_ms: i64) -> Result<Vec<(i64, String, u64)>> {
        let mut statement = self
            .db
            .prepare("SELECT m.created_at/3600000,s.provider,COUNT(*) FROM messages m JOIN sessions s ON s.id=m.session_id WHERE m.role='user' AND m.created_at>=?1 GROUP BY 1,2 ORDER BY 1")
            .map_err(|e| e.to_string())?;
        let rows = statement
            .query_map([since_ms], |row| Ok((row.get(0)?, row.get(1)?, row.get::<_, i64>(2)?.max(0) as u64)))
            .map_err(|e| e.to_string())?;
        rows.collect::<std::result::Result<_, _>>().map_err(|e| e.to_string())
    }
    /// Tasks in a project whose title or conversation mentions `query`, newest first,
    /// each with a short excerpt around the first match in its messages.
    pub fn search_tasks(&self, project_id: &str, query: &str, limit: usize) -> Result<Vec<serde_json::Value>> {
        let query = query.trim();
        if query.is_empty() || query.chars().count() > 200 {
            return Err("Search for 1 to 200 characters.".into());
        }
        let pattern = format!("%{}%", query.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
        let mut statement = self.db.prepare(
            "SELECT s.id,s.title,s.updated_at,
               (SELECT m.content FROM messages m WHERE m.session_id=s.id AND m.role IN ('user','assistant') AND m.content LIKE ?2 ESCAPE '\\' ORDER BY m.id DESC LIMIT 1)
             FROM sessions s
             WHERE s.project_id=?1 AND s.draft=0 AND s.id NOT IN (SELECT session_id FROM architect_workers)
               AND (s.title LIKE ?2 ESCAPE '\\' OR EXISTS(SELECT 1 FROM messages m WHERE m.session_id=s.id AND m.role IN ('user','assistant') AND m.content LIKE ?2 ESCAPE '\\'))
             ORDER BY s.updated_at DESC LIMIT ?3").map_err(|e| e.to_string())?;
        let needle = query.to_lowercase();
        let rows = statement.query_map(params![project_id, pattern, limit as i64], |r| {
            let content: Option<String> = r.get(3)?;
            let excerpt = content.map(|text| {
                let lower = text.to_lowercase();
                let at = lower.find(&needle).unwrap_or(0);
                let start = text.char_indices().map(|(i, _)| i).take_while(|i| *i + 80 <= at).last().unwrap_or(0);
                text[start..].chars().take(220).collect::<String>()
            });
            Ok(serde_json::json!({"taskId": r.get::<_, String>(0)?, "title": r.get::<_, String>(1)?, "updatedAt": r.get::<_, i64>(2)?, "excerpt": excerpt}))
        }).map_err(|e| e.to_string())?;
        rows.collect::<std::result::Result<_, _>>().map_err(|e| e.to_string())
    }

    /// Records a usage limit hit by the task's run.
    pub fn set_limited(&self, sid: &str, until: Option<i64>) -> Result<()> {
        let until = until.filter(|at| *at > 0 && *at < 4_102_444_800_000);
        self.db.execute("UPDATE sessions SET limited_at=?2,limited_until=?3 WHERE id=?1", params![sid, now(), until]).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Turns automatic continuation at the reset on or off for a limited task.
    pub fn set_resume_at_reset(&self, sid: &str, enabled: bool) -> Result<Session> {
        let changed = self.db.execute("UPDATE sessions SET resume_at_reset=?2 WHERE id=?1 AND limited_at IS NOT NULL AND (?2=0 OR limited_until IS NOT NULL)", params![sid, enabled]).map_err(|e| e.to_string())?;
        if changed == 0 && enabled {
            return Err("This task has no usage limit with a known reset time.".into());
        }
        self.session(sid)
    }

    /// Clears a limit once it has been handled (resumed, archived or dismissed).
    pub fn clear_limited(&self, sid: &str) -> Result<()> {
        self.db.execute("UPDATE sessions SET limited_at=NULL,limited_until=NULL,resume_at_reset=0 WHERE id=?1", [sid]).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// The PandaCode task already continuing an agent conversation, if any.
    pub fn imported_task(&self, provider: &str, resume_id: &str) -> Result<Option<String>> {
        self.db
            .query_row("SELECT id FROM sessions WHERE provider=?1 AND resume_id=?2 ORDER BY updated_at DESC LIMIT 1", params![provider, resume_id], |row| row.get(0))
            .optional()
            .map_err(|e| e.to_string())
    }

    /// Adds a conversation started outside PandaCode as a task that continues it:
    /// its history keeps original times, and the agent resumes `resume_id` on the next prompt.
    #[allow(clippy::too_many_arguments)]
    pub fn import_task(&self, project_id: &str, provider: &str, model: &str, title: &str, resume_id: &str, reasoning_effort: Option<&str>, created_at: i64, entries: &[(&str, String, i64)]) -> Result<Session> {
        let transaction = self.db.unchecked_transaction().map_err(|e| e.to_string())?;
        let task = self.create_session(project_id, provider, model, DEFAULT_PERMISSION_MODE)?;
        let title: String = title.chars().filter(|c| !c.is_control()).take(200).collect();
        let title = if title.trim().is_empty() { "Imported conversation".to_owned() } else { title.trim().to_owned() };
        let first = entries.first().map_or(created_at, |entry| entry.2).min(created_at.max(1));
        let last = entries.last().map_or(created_at, |entry| entry.2).max(first);
        self.db
            .execute(
                "UPDATE sessions SET resume_id=?2,title=?3,title_origin='manual',reasoning_effort=?4,task_stage='in_progress',created_at=?5,updated_at=?6 WHERE id=?1",
                params![task.id, resume_id, title, reasoning_effort, first, last],
            )
            .map_err(|e| e.to_string())?;
        for (role, content, at) in entries {
            self.db
                .execute("INSERT INTO messages(session_id,role,content,created_at) VALUES (?1,?2,?3,?4)", params![task.id, role, content, at])
                .map_err(|e| e.to_string())?;
        }
        transaction.commit().map_err(|e| e.to_string())?;
        self.session(&task.id)
    }

    /// Hides a task opened from New task until its first prompt is saved.
    pub fn mark_draft(&self, sid: &str) -> Result<Session> {
        self.db.execute("UPDATE sessions SET draft=1 WHERE id=?1 AND NOT EXISTS(SELECT 1 FROM messages WHERE session_id=?1)", [sid]).map_err(|e| e.to_string())?;
        self.session(sid)
    }

    /// Whether a task is still an unsent draft with no saved history.
    pub fn is_empty_draft(&self, sid: &str) -> Result<bool> {
        self.db.query_row("SELECT EXISTS(SELECT 1 FROM sessions WHERE id=?1 AND draft=1 AND NOT EXISTS(SELECT 1 FROM messages WHERE session_id=?1))", [sid], |r| r.get(0)).map_err(|e| e.to_string())
    }

    /// Removes drafts left from an earlier launch; none can be open yet.
    pub fn discard_empty_drafts(&self) -> Result<usize> {
        self.db.execute("DELETE FROM sessions WHERE draft=1 AND NOT EXISTS(SELECT 1 FROM messages WHERE session_id=sessions.id) AND id NOT IN (SELECT session_id FROM architect_workers) AND id NOT IN (SELECT parent_session_id FROM architect_workers)", []).map_err(|e| e.to_string())
    }

    pub fn pin_session(&self, sid: &str, pinned: bool) -> Result<Session> {
        let changed = self.db.execute(
            "UPDATE sessions SET pinned=?2 WHERE id=?1 AND id NOT IN (SELECT session_id FROM architect_workers)",
            params![sid, pinned],
        ).map_err(|e| e.to_string())?;
        if changed == 0 { return Err("Conversation not found or is a team worker.".into()); }
        self.session(sid)
    }

    pub fn reorder_sessions(&self, session_ids: &[String]) -> Result<Vec<Session>> {
        if session_ids.is_empty() || session_ids.len() > 500 {
            return Err("Reorder between 1 and 500 conversations at a time.".into());
        }
        let selected: std::collections::HashSet<&str> = session_ids.iter().map(String::as_str).collect();
        if selected.len() != session_ids.len() {
            return Err("A conversation may appear only once in the order.".into());
        }
        let transaction = rusqlite::Transaction::new_unchecked(&self.db, rusqlite::TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
        // Work from the entire order, not the currently displayed project/search
        // result or the 500-row listing window, so hidden tasks keep their slots.
        let mut ordered = {
            let mut query = transaction.prepare(&format!("SELECT id,pinned FROM sessions WHERE id NOT IN (SELECT session_id FROM architect_workers) ORDER BY {SIDEBAR_ORDER}")).map_err(|e| e.to_string())?;
            let rows = query.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, bool>(1)?))).map_err(|e| e.to_string())?;
            rows.collect::<std::result::Result<Vec<_>, _>>().map_err(|e| e.to_string())?
        };
        let included = ordered.iter().filter(|(id, _)| selected.contains(id.as_str())).collect::<Vec<_>>();
        if included.len() != selected.len() {
            return Err("A conversation no longer exists or is a team worker.".into());
        }
        if included.iter().any(|(_, pinned)| *pinned != included[0].1) {
            return Err("Reorder pinned and unpinned conversations separately.".into());
        }
        let mut next = session_ids.iter();
        for (id, _) in &mut ordered {
            if selected.contains(id.as_str()) { *id = next.next().expect("validated selection count").clone(); }
        }
        {
            let mut update = transaction.prepare("UPDATE sessions SET sidebar_order=?2 WHERE id=?1").map_err(|e| e.to_string())?;
            for (rank, (id, _)) in ordered.iter().enumerate() {
                update.execute(params![id, rank as i64]).map_err(|e| e.to_string())?;
            }
        }
        transaction.commit().map_err(|e| e.to_string())?;
        self.sessions()
    }
    fn attach_links(&self, sessions: &mut [Session]) -> Result<()> {
        if sessions.is_empty() {
            return Ok(());
        }
        let mut stmt = self
            .db
            .prepare("SELECT session_id,kind,number,url,title,state,checked_at FROM task_links")
            .map_err(|e| e.to_string())?;
        let links = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    TaskLink {
                        kind: r.get(1)?,
                        number: r.get(2)?,
                        url: r.get(3)?,
                        title: r.get(4)?,
                        state: r.get(5)?,
                        checked_at: r.get(6)?,
                    },
                ))
            })
            .map_err(|e| e.to_string())?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        for (session_id, link) in links {
            if let Some(session) = sessions.iter_mut().find(|s| s.id == session_id) {
                if link.kind == "pull" {
                    session.pull_request = Some(link);
                } else {
                    session.issue = Some(link);
                }
            }
        }
        Ok(())
    }
    /// Replace the task's link of one kind; `None` removes it.
    pub fn set_task_link(&self, sid: &str, kind: &str, link: Option<&TaskLink>) -> Result<Session> {
        if !["issue", "pull"].contains(&kind) {
            return Err("Unknown link kind.".into());
        }
        self.session(sid)?;
        match link {
            Some(link) => {
                if link.number <= 0 || link.url.len() > 2048 || link.title.len() > 1024 || link.state.len() > 32 {
                    return Err("Invalid GitHub link.".into());
                }
                self.db.execute("INSERT INTO task_links(session_id,kind,number,url,title,state,checked_at) VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(session_id,kind) DO UPDATE SET number=excluded.number,url=excluded.url,title=excluded.title,state=excluded.state,checked_at=excluded.checked_at",
                    params![sid, kind, link.number, link.url, link.title, link.state, now()]).map_err(|e| e.to_string())?;
            }
            None => {
                self.db
                    .execute("DELETE FROM task_links WHERE session_id=?1 AND kind=?2", params![sid, kind])
                    .map_err(|e| e.to_string())?;
            }
        }
        self.session(sid)
    }
    /// Linked numbers for one project, so states can be refreshed in one batch.
    pub fn project_links(&self, project_id: &str) -> Result<Vec<(String, TaskLink)>> {
        let mut stmt = self.db.prepare("SELECT l.session_id,l.kind,l.number,l.url,l.title,l.state,l.checked_at FROM task_links l JOIN sessions s ON s.id=l.session_id WHERE s.project_id=?1 ORDER BY l.number").map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([project_id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    TaskLink {
                        kind: r.get(1)?,
                        number: r.get(2)?,
                        url: r.get(3)?,
                        title: r.get(4)?,
                        state: r.get(5)?,
                        checked_at: r.get(6)?,
                    },
                ))
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }
    /// Record refreshed states without touching which task owns which link.
    pub fn update_link_states(&self, project_id: &str, states: &[(String, i64, String, String)]) -> Result<()> {
        for (kind, number, state, title) in states {
            self.db.execute("UPDATE task_links SET state=?3,title=CASE WHEN ?4='' THEN title ELSE ?4 END,checked_at=?5 WHERE kind=?1 AND number=?2 AND session_id IN (SELECT id FROM sessions WHERE project_id=?6)",
                params![kind, number, state, title, now(), project_id]).map_err(|e| e.to_string())?;
        }
        Ok(())
    }
    /// Give an unstarted task its own checkout, keeping the draft and settings.
    pub fn attach_worktree(&self, sid: &str, path: &Path, branch: &str) -> Result<Session> {
        let path = path
            .canonicalize()
            .map_err(|e| format!("Worktree folder is unavailable: {e}"))?;
        let changed = self.db.execute(
            "UPDATE sessions SET worktree_path=?2,worktree_branch=?3,updated_at=?4 WHERE id=?1 AND worktree_path IS NULL AND resume_id IS NULL AND status NOT IN ('running','waiting') AND NOT EXISTS (SELECT 1 FROM messages WHERE session_id=?1)",
            params![sid, path.to_string_lossy(), branch, now()],
        ).map_err(|e| e.to_string())?;
        if changed == 0 {
            return Err("This conversation already started. Create a new task in a worktree instead.".into());
        }
        self.session(sid)
    }
    /// How many messages the user has sent in a task, including the one being sent.
    pub fn user_turns(&self, sid: &str) -> Result<i64> {
        self.db.query_row("SELECT COUNT(*) FROM messages WHERE session_id=?1 AND role='user'", [sid], |r| r.get(0)).map_err(|e| e.to_string())
    }
    /// Whether a task can still be converted in place.
    pub fn worktree_attachable(&self, sid: &str) -> Result<bool> {
        let session = self.session(sid)?;
        if session.worktree_path.is_some() || session.resume_id.is_some() || ["running", "waiting"].contains(&session.status.as_str()) {
            return Ok(false);
        }
        let messages: i64 = self.db.query_row("SELECT COUNT(*) FROM messages WHERE session_id=?1", [sid], |r| r.get(0)).map_err(|e| e.to_string())?;
        Ok(messages == 0)
    }
    pub fn record_goal(
        &self,
        sid: &str,
        goal: Option<&crate::goal_state::GoalState>,
    ) -> Result<()> {
        let task = self.session(sid)?;
        if goal.is_some_and(|g| {
            !g.is_valid()
                || task.provider != "codex"
                || task.resume_id.as_deref() != Some(&g.thread_id)
        }) {
            return Err("Goal metadata does not belong to this Codex task.".into());
        }
        let data = goal
            .map(serde_json::to_string)
            .transpose()
            .map_err(|e| e.to_string())?;
        self.db
            .execute(
                "UPDATE sessions SET goal_state=?2 WHERE id=?1",
                params![sid, data],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn begin_goal_operation(&self, sid: &str) -> Result<()> {
        let task = self.session(sid)?;
        if task.archived || task.task_stage == "completed" {
            return Err("Reopen this task first.".into());
        }
        self.db.execute("UPDATE sessions SET status='running',task_stage='in_progress',completed_at=NULL,updated_at=?2 WHERE id=?1", params![sid,now()]).map_err(|e|e.to_string())?;
        Ok(())
    }

    pub fn create_session(
        &self,
        project_id: &str,
        provider: &str,
        model: &str,
        mode: &str,
    ) -> Result<Session> {
        self.project(project_id)?;
        if ![
            "claude",
            "codex",
            "kimi",
            "opencode",
            "glm",
            "antigravity",
            "grok",
            "mimo",
            "pi",
            "deepseek",
            "commandcode",
            "cline",
            "kilo",
            "omp",
            "github-copilot",
            "muse",
        ]
        .contains(&provider)
        {
            return Err("Unknown provider.".into());
        }
        if !valid_permission_mode(mode) {
            return Err("Unknown permission mode.".into());
        }
        if model.len() > 200 {
            return Err("Model name is too long.".into());
        }
        let sid = id();
        let t = now();
        self.db.execute("INSERT INTO sessions(id,project_id,title,provider,model,mode,status,created_at,updated_at,title_origin) VALUES (?1,?2,'New conversation',?3,?4,?5,'idle',?6,?6,'auto')",params![sid,project_id,provider,model,mode,t]).map_err(|e|e.to_string())?;
        self.session(&sid)
    }

    pub fn create_board_task(
        &self,
        project_id: &str,
        provider: &str,
        model: &str,
        mode: &str,
        title: &str,
        description: &str,
    ) -> Result<Session> {
        Self::validate_task_details(title, description)?;
        // Validation happens before inserting, and rollback prevents orphaned
        // empty tasks if writing the description fails.
        let transaction = self.db.unchecked_transaction().map_err(|e| e.to_string())?;
        let task = self.create_session(project_id, provider, model, mode)?;
        self.db
            .execute(
                "UPDATE sessions SET title=?2,title_origin='manual',task_description=?3 WHERE id=?1",
                params![task.id, title.trim(), description.trim()],
            )
            .map_err(|e| e.to_string())?;
        transaction.commit().map_err(|e| e.to_string())?;
        self.session(&task.id)
    }

    fn validate_task_details(title: &str, description: &str) -> Result<()> {
        if title.trim().is_empty() || title.len() > 200 {
            return Err("Title must be 1–200 characters.".into());
        }
        if description.len() > 128 * 1024 {
            return Err("Task details must be under 128 KiB.".into());
        }
        Ok(())
    }

    pub fn update_task_details(
        &self,
        sid: &str,
        title: &str,
        description: &str,
    ) -> Result<Session> {
        crate::architect::check_manual(self, sid)?;
        Self::validate_task_details(title, description)?;
        self.session(sid)?;
        let changed = self
            .db
            .execute(
                "UPDATE sessions SET title=?2,title_origin='manual',task_description=?3,updated_at=?4
             WHERE id=?1 AND status NOT IN ('running','waiting') AND archived=0",
                params![sid, title.trim(), description.trim(), now()],
            )
            .map_err(|e| e.to_string())?;
        if changed == 0 {
            return Err("Restore this task and stop its agent before editing its details.".into());
        }
        self.session(sid)
    }

    pub fn set_task_stage(&self, sid: &str, stage: &str) -> Result<Session> {
        crate::architect::check_manual(self, sid)?;
        if stage == "in_progress" {
            return Err("Start the task to move it to work in progress.".into());
        }
        if !matches!(stage, "pending" | "review" | "completed") {
            return Err("Unknown task stage.".into());
        }
        self.session(sid)?;
        let changed = self
            .db
            .execute(
                "UPDATE sessions SET task_stage=?2,
               completed_at=CASE WHEN ?2='completed' THEN COALESCE(completed_at,?3) ELSE NULL END,
               updated_at=?3 WHERE id=?1 AND status NOT IN ('running','waiting') AND archived=0",
                params![sid, stage, now()],
            )
            .map_err(|e| e.to_string())?;
        if changed == 0 {
            return Err("Restore this task and stop its agent before changing its stage.".into());
        }
        self.session(sid)
    }

    /// Archive deadlines depend on completion time, never unrelated task edits.
    /// The partial index keeps the once-per-minute sweep bounded to completed tasks.
    pub fn archive_completed(&self, timestamp: i64) -> Result<usize> {
        self.db
            .execute(
                "UPDATE sessions SET archived=1,updated_at=?1
             WHERE archived=0 AND task_stage='completed' AND completed_at<=?2
               AND status NOT IN ('running','waiting')",
                params![
                    timestamp,
                    timestamp.saturating_sub(COMPLETED_ARCHIVE_DELAY_MS)
                ],
            )
            .map_err(|e| e.to_string())
    }
    /// Resolve the selected task's checkout without silently falling back to the main folder.
    pub fn workspace_root(&self, project_id: &str, session_id: Option<&str>) -> Result<PathBuf> {
        let project = self.project(project_id)?;
        let worktree = if let Some(session_id) = session_id {
            let task = self.session(session_id)?;
            if task.project_id != project_id {
                return Err("This task does not belong to the selected project.".into());
            }
            // A mirror's checkout is on the other computer, never this disk.
            if let Some(device) = task.remote_device {
                return Err(format!("This task runs on {}.", device.name));
            }
            task.worktree_path
        } else {
            None
        };
        let is_worktree = worktree.is_some();
        let kind = if is_worktree { "Worktree" } else { "Project" };
        let path = PathBuf::from(worktree.unwrap_or(project.path))
            .canonicalize()
            .map_err(|e| format!("{kind} folder is unavailable: {e}"))?;
        if !path.is_dir() {
            return Err(format!("{kind} folder is unavailable."));
        }
        if is_worktree && !path.join(".git").is_file() {
            return Err("Worktree checkout is unavailable. Its Git metadata is missing.".into());
        }
        Ok(path)
    }

    pub fn create_worktree_session_on(&self, source: &Session, path: &Path, branch: Option<&str>) -> Result<Session> {
        self.project(&source.project_id)?;
        let path = path
            .canonicalize()
            .map_err(|e| format!("Worktree folder is unavailable: {e}"))?;
        if !path.is_dir() {
            return Err("Worktree folder is unavailable.".into());
        }
        let sid = id();
        let t = now();
        self.db.execute("INSERT INTO sessions(id,project_id,title,provider,model,mode,status,created_at,updated_at,worktree_path,reasoning_effort,worktree_branch,title_origin)
            VALUES (?1,?2,'New conversation',?3,?4,?8,'idle',?5,?5,?6,?7,?9,'auto')",
            params![sid,source.project_id,source.provider,source.model,t,path.to_string_lossy(),source.reasoning_effort,source.mode,branch])
            .map_err(|e| e.to_string())?;
        self.session(&sid)
    }

    pub fn configure(
        &self,
        sid: &str,
        provider: &str,
        model: &str,
        project_id: Option<&str>,
    ) -> Result<Session> {
        crate::architect::check_manual(self, sid)?;
        if ![
            "claude",
            "codex",
            "kimi",
            "opencode",
            "glm",
            "antigravity",
            "grok",
            "mimo",
            "pi",
            "deepseek",
            "commandcode",
            "cline",
            "kilo",
            "omp",
            "github-copilot",
            "muse",
        ]
        .contains(&provider)
        {
            return Err("Unknown provider.".into());
        }
        if model.len() > 200 {
            return Err("Model name is too long.".into());
        }
        if let Some(project_id) = project_id {
            self.project(project_id)?;
        }
        let current = self.session(sid)?;
        // Queue the handoff and replace the native context atomically. Keep the
        // project fixed once a conversation exists, but let another harness continue it.
        let switching = current.provider != provider;
        let needs_handoff = switching && (current.resume_id.is_some() || self.db.query_row(
            "SELECT EXISTS(SELECT 1 FROM messages WHERE session_id=?1 AND role IN ('user','assistant','coordination'))", [sid], |r| r.get::<_, bool>(0)
        ).map_err(|e| e.to_string())?);
        // New-task creation can already have a transaction. Without history,
        // configuration is still one atomic UPDATE, even if team defaults chose another harness.
        let transaction = needs_handoff.then(|| self.db.unchecked_transaction()).transpose().map_err(|e| e.to_string())?;
        if needs_handoff { crate::context_recovery::queue(self, sid)?; }
        let changed = self
            .db
            .execute(
                "UPDATE sessions SET provider=?2,model=?3,project_id=COALESCE(?5,project_id),
               resume_id=CASE WHEN provider<>?2 THEN NULL ELSE resume_id END,
               goal_state=CASE WHEN provider<>?2 THEN NULL ELSE goal_state END,
               codex_settings=CASE WHEN provider<>?2 THEN NULL ELSE codex_settings END,
               reasoning_effort=CASE WHEN provider<>?2 OR model<>?3 THEN NULL ELSE reasoning_effort END,
               context_used_tokens=CASE WHEN provider<>?2 OR model<>?3 THEN NULL ELSE context_used_tokens END,
               context_window=CASE WHEN provider<>?2 OR model<>?3 THEN NULL ELSE context_window END,
               updated_at=?4
             WHERE id=?1 AND status NOT IN ('running','waiting')
               AND (worktree_path IS NULL OR project_id=COALESCE(?5,project_id))
               AND (project_id=COALESCE(?5,project_id) OR (resume_id IS NULL AND NOT EXISTS
               (SELECT 1 FROM messages WHERE session_id=?1)))",
                params![sid, provider, model, now(), project_id],
            )
            .map_err(|e| e.to_string())?;
        let session = self.session(sid)?;
        if changed == 0 {
            if ["running", "waiting"].contains(&session.status.as_str()) {
                return Err(
                    "Stop the agent before changing its project, provider, or model.".into(),
                );
            }
            if session.worktree_path.is_some()
                && project_id.is_some_and(|id| id != session.project_id)
            {
                return Err("A worktree task stays in its original project. Create a new task to use another project.".into());
            }
            if project_id.is_some_and(|id| id != session.project_id) {
                return Err("Create a new task to use a different project after a conversation has started.".into());
            }
            return Err(
                "Create a new task to use a different provider after a conversation has started."
                    .into(),
            );
        }
        if needs_handoff {
            let notice = serde_json::json!({
                "fromProvider": current.provider, "toProvider": provider,
                "summary": "Switched harness. The next message includes up to 200 recent conversation entries (64 KiB). Files and project stay in place. Older text may be shortened; private reasoning, native tool state, and image contents are not transferred. Reattach images if needed."
            });
            self.message(sid, "handoff", &notice.to_string())?;
        }
        if let Some(transaction) = transaction { transaction.commit().map_err(|e| e.to_string())?; }
        Ok(session)
    }
    pub fn set_reasoning_effort(&self, sid: &str, effort: Option<&str>) -> Result<Session> {
        crate::architect::check_manual(self, sid)?;
        let session = self.session(sid)?;
        let effort = effort.map(str::trim).filter(|effort| !effort.is_empty());
        crate::providers::validate_reasoning_effort(&session.provider, effort)?;
        let changed = self.db.execute(
            "UPDATE sessions SET reasoning_effort=?2,updated_at=?3 WHERE id=?1 AND status NOT IN ('running','waiting')",
            params![sid, effort, now()],
        ).map_err(|e| e.to_string())?;
        if changed == 0 {
            return Err("Stop the agent before changing its reasoning effort.".into());
        }
        self.session(sid)
    }

    pub fn record_context_usage(&self, sid: &str, usage: &ContextUsage) -> Result<()> {
        if !usage.is_valid() {
            return Err("Invalid context usage metadata.".into());
        }
        let changed = self
            .db
            .execute(
                "UPDATE sessions SET context_used_tokens=?2,context_window=?3 WHERE id=?1",
                params![
                    sid,
                    usage.used_tokens as i64,
                    usage.context_window.map(|window| window as i64)
                ],
            )
            .map_err(|e| e.to_string())?;
        if changed == 0 {
            return Err("Conversation not found.".into());
        }
        Ok(())
    }
    pub fn update(
        &self,
        sid: &str,
        title: Option<String>,
        archived: Option<bool>,
        model: Option<String>,
        mode: Option<String>,
    ) -> Result<()> {
        crate::architect::check_manual(self, sid)?;
        let session = self.session(sid)?;
        if title
            .as_ref()
            .is_some_and(|s| s.trim().is_empty() || s.len() > 200)
        {
            return Err("Title must be 1–200 characters.".into());
        }
        if model.as_ref().is_some_and(|s| s.len() > 200) {
            return Err("Model name is too long.".into());
        }
        if mode.as_ref().is_some_and(|s| !valid_permission_mode(s)) {
            return Err("Unknown permission mode.".into());
        }
        if (model.is_some() || mode.is_some())
            && matches!(session.status.as_str(), "running" | "waiting")
        {
            return Err("Stop the agent before changing its model or approval behavior.".into());
        }
        let changed = self.db.execute("UPDATE sessions SET title=COALESCE(?2,title),title_origin=CASE WHEN ?2 IS NOT NULL THEN 'manual' ELSE title_origin END,archived=COALESCE(?3,archived),model=COALESCE(?4,model),mode=COALESCE(?5,mode),
            completed_at=CASE WHEN archived=1 AND ?3=0 AND task_stage='completed' THEN ?6 ELSE completed_at END,
            reasoning_effort=CASE WHEN model<>COALESCE(?4,model) THEN NULL ELSE reasoning_effort END,
            context_used_tokens=CASE WHEN model<>COALESCE(?4,model) THEN NULL ELSE context_used_tokens END,
            context_window=CASE WHEN model<>COALESCE(?4,model) THEN NULL ELSE context_window END,
            updated_at=?6 WHERE id=?1 AND ((?4 IS NULL AND ?5 IS NULL) OR status NOT IN ('running','waiting'))",params![sid,title,archived,model,mode,now()]).map_err(|e|e.to_string())?;
        if changed == 0 {
            return Err("Stop the agent before changing its model or approval behavior.".into());
        }
        Ok(())
    }
    pub fn status(&self, sid: &str, status: &str) -> Result<()> {
        self.db
            .execute(
                "UPDATE sessions SET status=?2,updated_at=?3 WHERE id=?1",
                params![sid, status, now()],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    pub fn resume(&self, sid: &str, resume_id: &str) -> Result<()> {
        self.db
            .execute(
                "UPDATE sessions SET resume_id=?2,goal_state=CASE WHEN resume_id=?2 THEN goal_state ELSE NULL END WHERE id=?1",
                params![sid, resume_id],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    pub fn message(&self, sid: &str, role: &str, content: &str) -> Result<()> {
        self.db
            .execute(
                "INSERT INTO messages(session_id,role,content,created_at) VALUES (?1,?2,?3,?4)",
                params![sid, role, content, now()],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    /// RETURNING ties the timer to this exact insert even with concurrent tasks.
    pub fn start_turn_message(&self, sid: &str, content: &str) -> Result<i64> {
        self.db
            .query_row(
                "INSERT INTO messages(session_id,role,content,created_at)
            VALUES (?1,'user',?2,?3) RETURNING id",
                params![sid, content, now()],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())
    }

    /// Claim execution and save its initiating message together. A failed insert
    /// rolls the claim back; concurrent callers cannot enqueue a second run.
    pub fn begin_task_turn(&self, sid: &str, content: &str) -> Result<i64> {
        self.begin_task_turn_with_kind(sid, content, None)
    }

    pub fn begin_task_turn_with_kind(
        &self,
        sid: &str,
        content: &str,
        kind: Option<crate::architect::internal_turns::CoordinationKind>,
    ) -> Result<i64> {
        if content.trim().is_empty() || content.len() > 128 * 1024 {
            return Err("Write a message under 128 KiB first.".into());
        }
        let transaction = self.db.unchecked_transaction().map_err(|e| e.to_string())?;
        let session = self.session(sid)?;
        let title: String = if kind.is_none() && session.title == "New conversation"
            && crate::session_titles::automatic(self, sid)? {
            content
                .lines()
                .next()
                .unwrap_or(content)
                .chars()
                .take(64)
                .collect()
        } else {
            session.title
        };
        let claimed = self
            .db
            .execute(
                "UPDATE sessions SET status='running',task_stage='in_progress',completed_at=NULL,
                title=?2,updated_at=?3 WHERE id=?1 AND archived=0 AND task_stage<>'completed'
                AND status NOT IN ('running','waiting')",
                params![sid, title, now()],
            )
            .map_err(|e| e.to_string())?;
        if claimed == 0 {
            return Err("Restore or reopen the task and stop its agent before starting it.".into());
        }
        let message_id = if let Some(kind) = kind {
            let saved = crate::architect::internal_turns::encode(kind, content)?;
            self.db.query_row("INSERT INTO messages(session_id,role,content,created_at) VALUES(?1,'coordination',?2,?3) RETURNING id",params![sid,saved,now()],|row|row.get(0)).map_err(|e|e.to_string())?
        } else {
            self.start_turn_message(sid, content)?
        };
        transaction.commit().map_err(|e| e.to_string())?;
        Ok(message_id)
    }

    pub fn finish_task_turn(&self, sid: &str, successful: bool, stopped: bool) -> Result<()> {
        self.finish_task_operation(sid, successful, stopped, None)
    }

    pub fn finish_task_operation(
        &self,
        sid: &str,
        successful: bool,
        stopped: bool,
        restore_stage: Option<&str>,
    ) -> Result<()> {
        if restore_stage.is_some_and(|stage| !matches!(stage, "pending" | "in_progress" | "review"))
        {
            return Err("Invalid task stage for a context command.".into());
        }
        let status = if stopped {
            "interrupted"
        } else if successful {
            "idle"
        } else {
            "error"
        };
        self.db
            .execute(
                "UPDATE sessions SET status=?2,
               task_stage=CASE WHEN json_valid(goal_state) AND json_extract(goal_state,'$.status')<>'complete' THEN 'in_progress' ELSE COALESCE(?5, CASE WHEN ?3 THEN 'review' ELSE 'in_progress' END) END,
               completed_at=NULL,updated_at=?4 WHERE id=?1",
                params![sid, status, successful && !stopped, now(), restore_stage],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn finish_turn(&self, sid: &str, message_id: i64, duration_ms: i64) -> Result<()> {
        if duration_ms < 0 {
            return Err("Turn duration cannot be negative.".into());
        }
        let changed = self
            .db
            .execute(
                "UPDATE messages SET turn_duration_ms=COALESCE(turn_duration_ms,?3)
            WHERE session_id=?1 AND id=?2 AND role IN ('user','coordination')",
                params![sid, message_id, duration_ms],
            )
            .map_err(|e| e.to_string())?;
        if changed == 0 {
            return Err("The initiating turn message was not found.".into());
        }
        Ok(())
    }

    /// Keep tool start/progress/result snapshots in one ordered transcript row.
    pub fn tool_message(&self, sid: &str, tool_id: &str, content: &str) -> Result<()> {
        if tool_id.is_empty() || tool_id.len() > 512 || content.len() > 96 * 1024 {
            return Err("Tool activity exceeded its storage limit.".into());
        }
        self.db
            .execute(
                "INSERT INTO messages(session_id,role,content,created_at,tool_id)
          VALUES (?1,'tool',?2,?3,?4)
          ON CONFLICT(session_id,tool_id) DO UPDATE SET content=excluded.content",
                params![sid, content, now(), tool_id],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    pub fn finish_tools(&self, sid: &str) -> Result<()> {
        settle_unfinished_tools(
            &self.db,
            Some(sid),
            "\n\n[The turn ended before this tool reported a result.]",
        )
    }

    /// Subagent history is independent of the bounded parent message window.
    pub fn save_subagent(
        &self,
        sid: &str,
        activity: &crate::providers::SubagentActivity,
    ) -> Result<()> {
        let content = serde_json::to_string(activity).map_err(|error| error.to_string())?;
        if activity.id.is_empty() || activity.id.len() > 1024 || content.len() > 1024 * 1024 {
            return Err("Subagent activity exceeded its storage limit.".into());
        }
        self.db.execute("INSERT INTO subagents(session_id,id,content,updated_at) VALUES (?1,?2,?3,?4)
            ON CONFLICT(session_id,id) DO UPDATE SET content=excluded.content,updated_at=excluded.updated_at",
            params![sid,activity.id,content,activity.updated_at]).map_err(|error| error.to_string())?;
        // Keep current work regardless of age; older terminal snapshots give
        // way to the newest 64 entries without growing every parent turn.
        self.db
            .execute(
                "DELETE FROM subagents WHERE session_id=?1
            AND json_extract(content,'$.status') NOT IN ('running','waiting')
            AND id NOT IN (SELECT id FROM subagents WHERE session_id=?1
                ORDER BY (json_extract(content,'$.status') IN ('running','waiting')) DESC,
                updated_at DESC,id DESC LIMIT 64)",
                [sid],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn subagents(&self, sid: &str) -> Result<Vec<crate::providers::SubagentActivity>> {
        self.session(sid)?;
        let mut query = self
            .db
            .prepare(
                "SELECT content FROM subagents WHERE session_id=?1
            ORDER BY updated_at DESC,id DESC LIMIT 64",
            )
            .map_err(|error| error.to_string())?;
        let rows = query
            .query_map([sid], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?;
        rows.map(|row| {
            let content = row.map_err(|error| error.to_string())?;
            serde_json::from_str(&content).map_err(|error| error.to_string())
        })
        .collect()
    }

    pub fn finish_subagents(&self, sid: &str, status: &str) -> Result<()> {
        settle_unfinished_subagents(&self.db, Some(sid), status)
    }

    /// Fetch one complete saved conversation message on demand. App-origin
    /// coordination prompts stay private even if older versions stored them as user text.
    pub fn message_content(&self, sid: &str, message_id: i64) -> Result<String> {
        let selected: Option<(String, String)> = self
            .db
            .query_row(
                "SELECT role,content FROM messages WHERE session_id=?1 AND id=?2",
                params![sid, message_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let (role, content) =
            selected.ok_or("This saved message does not belong to the selected task.")?;
        if !matches!(role.as_str(), "user" | "assistant")
            || (role == "user"
                && crate::architect::internal_turns::legacy_kind(self, sid, message_id, &content)?
                    .is_some())
        {
            return Err("Choose a saved user message or assistant response.".into());
        }
        Ok(content)
    }

    /// The next saved switch identifies the provider at this point, even when
    /// that switch lies outside the requested page or fork boundary. The partial
    /// index visits only handoffs and reads at most one small app-owned notice.
    pub(crate) fn provider_at_message(&self, sid: &str, message_id: i64) -> Result<String> {
        let current = self.session(sid)?.provider;
        let next: Option<String> = self.db.query_row(
            "SELECT substr(content,1,4096) FROM messages WHERE session_id=?1 AND role='handoff' AND id>?2 ORDER BY id LIMIT 1",
            params![sid, message_id], |row| row.get(0),
        ).optional().map_err(|e| e.to_string())?;
        Ok(next.as_deref().and_then(handoff_from_provider).unwrap_or(current))
    }

    pub fn messages(&self, sid: &str, before: Option<i64>) -> Result<Vec<Message>> {
        self.session(sid)?;
        // Read only the assistant preview before allocating the saved response.
        // BLOB substr preserves embedded NUL; four extra bytes keep any partial
        // UTF-8 code point beyond the existing byte-safe display truncation.
        let mut stmt=self.db.prepare("SELECT m.id,m.session_id,m.role,CASE WHEN m.role='assistant' THEN COALESCE(substr(CAST(m.content AS BLOB),1,131076),X'') ELSE m.content END,m.created_at,m.turn_duration_ms,t.summary FROM messages m LEFT JOIN turn_changes t ON t.message_id=m.id WHERE m.session_id=?1 AND m.id<?2 ORDER BY m.id DESC LIMIT 100").map_err(|e|e.to_string())?;
        let rows = stmt
            .query_map(params![sid, before.unwrap_or(i64::MAX)], |r| {
                let role: String = r.get(2)?;
                let content = match r.get_ref(3)? {
                    rusqlite::types::ValueRef::Blob(bytes) if role == "assistant" => {
                        String::from_utf8_lossy(bytes).into_owned()
                    }
                    _ => r.get(3)?,
                };
                Ok(Message {
                    id: r.get(0)?,
                    session_id: r.get(1)?,
                    role,
                    content,
                    created_at: r.get(4)?,
                    turn_duration_ms: r.get(5)?,
                    author_provider: None,
                    coordination_kind: None,
                    turn_changes: r
                        .get::<_, Option<String>>(6)?
                        .map(|s| {
                            serde_json::from_str(&s).map_err(|e| {
                                rusqlite::Error::FromSqlConversionFailure(
                                    6,
                                    rusqlite::types::Type::Text,
                                    Box::new(e),
                                )
                            })
                        })
                        .transpose()?,
                })
            })
            .map_err(|e| e.to_string())?;
        let mut page = Vec::new();
        let mut bytes = 0;
        for row in rows {
            let mut message = row.map_err(|e| e.to_string())?;
            crate::architect::internal_turns::project_message(self, &mut message)?;
            const NOTICE:&str="\n\n[Message preview truncated at 128 KiB. The provider retains the complete conversation.]";
            if message.content.len() > 128 * 1024 {
                let mut end = 128 * 1024 - NOTICE.len();
                while !message.content.is_char_boundary(end) {
                    end -= 1;
                }
                message.content.truncate(end);
                message.content.push_str(NOTICE);
            }
            let metadata_bytes = message
                .turn_changes
                .as_ref()
                .map(|c| serde_json::to_vec(c).map_or(0, |s| s.len()))
                .unwrap_or(0);
            if bytes + message.content.len() + metadata_bytes > 2 * 1024 * 1024 {
                break;
            }
            bytes += message.content.len() + metadata_bytes;
            page.push(message);
        }
        if let Some(last) = page.first() {
            let mut author = self.provider_at_message(sid, last.id)?;
            // Rows are newest first. An in-page switch changes the author of
            // the preceding responses without another database lookup.
            for message in &mut page {
                if message.role == "handoff" {
                    if let Some(from) = handoff_from_provider(&message.content) { author = from; }
                } else if message.role == "assistant" {
                    message.author_provider = Some(author.clone());
                }
            }
        }
        page.reverse();
        Ok(page)
    }
    pub fn message_page(&self, sid: &str, before: Option<i64>) -> Result<MessagePage> {
        let messages = self.messages(sid, before)?;
        // IDs are shared by every task, so the first ID alone cannot tell us
        // whether this task has earlier history. The session/id index keeps
        // this lookup bounded even when the returned page hit its byte limit.
        let has_older = match messages.first() {
            Some(first) => self
                .db
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM messages WHERE session_id=?1 AND id<?2)",
                    params![sid, first.id],
                    |row| row.get(0),
                )
                .map_err(|e| e.to_string())?,
            None => false,
        };
        Ok(MessagePage {
            messages,
            has_older,
        })
    }
}

fn handoff_from_provider(content: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(content).ok()?;
    let from = value.get("fromProvider")?.as_str()?;
    let to = value.get("toProvider")?.as_str()?;
    value.get("summary")?.as_str()?;
    let known = |provider: &str| {
        matches!(
            provider,
            "claude"
                | "codex"
                | "kimi"
                | "opencode"
                | "glm"
                | "antigravity"
                | "grok"
                | "mimo"
                | "pi"
                | "deepseek"
                | "commandcode" | "cline" | "kilo"
                | "omp"
                | "github-copilot"
                | "muse"
        )
    };
    (known(from) && known(to)).then(|| from.to_owned())
}

#[cfg(test)]
#[path = "storage_sidebar_tests.rs"]
mod sidebar_tests;

#[cfg(test)]
mod tests {
    use super::*;
    fn empty_session() -> (Store, Session) {
        let store = Store::open(Path::new(":memory:")).unwrap();
        let project = store.add_project(&std::env::temp_dir()).unwrap();
        let session = store
            .create_session(&project.id, "claude", "sonnet", "auto")
            .unwrap();
        (store, session)
    }

    #[test]
    fn new_task_drafts_stay_hidden_until_their_first_prompt() {
        let (store, listed) = empty_session();
        let draft = store.create_session(&listed.project_id, "codex", "gpt-5", "auto").unwrap();
        let draft = store.mark_draft(&draft.id).unwrap();
        assert!(draft.draft);
        let ids = |store: &Store| store.sessions().unwrap().into_iter().map(|task| task.id).collect::<Vec<_>>();
        assert_eq!(ids(&store), vec![listed.id.clone()]);
        assert!(store.session(&draft.id).unwrap().draft, "the open draft still loads by id");
        assert!(store.is_empty_draft(&draft.id).unwrap());
        // A reply or tool output alone does not publish it; the first prompt does.
        store.message(&draft.id, "assistant", "hello").unwrap();
        assert!(store.session(&draft.id).unwrap().draft);
        store.message(&draft.id, "user", "   ").unwrap();
        assert!(store.session(&draft.id).unwrap().draft);
        store.message(&draft.id, "user", "Build the thing").unwrap();
        let published = store.session(&draft.id).unwrap();
        assert!(!published.draft);
        assert!(published.created_at >= draft.created_at);
        assert!(!store.is_empty_draft(&draft.id).unwrap());
        assert_eq!(ids(&store).len(), 2);
        // Marking a task that already has history is refused.
        assert!(!store.mark_draft(&draft.id).unwrap().draft);
    }

    #[test]
    fn usage_limits_record_resets_schedule_resumes_and_clear_on_new_work() {
        let (store, task) = empty_session();
        store.set_limited(&task.id, Some(1_791_013_800_000)).unwrap();
        let limited = store.session(&task.id).unwrap();
        assert!(limited.limited_at.is_some());
        assert_eq!(limited.limited_until, Some(1_791_013_800_000));
        assert!(store.set_resume_at_reset(&task.id, true).unwrap().resume_at_reset);
        assert!(!store.set_resume_at_reset(&task.id, false).unwrap().resume_at_reset);
        store.set_resume_at_reset(&task.id, true).unwrap();
        // Replies do not clear a limit; a new prompt is new work and does.
        store.message(&task.id, "assistant", "partial reply").unwrap();
        assert!(store.session(&task.id).unwrap().limited_at.is_some());
        store.message(&task.id, "user", "Continue").unwrap();
        let cleared = store.session(&task.id).unwrap();
        assert_eq!((cleared.limited_at, cleared.limited_until, cleared.resume_at_reset), (None, None, false));
        // An unknown reset cannot be scheduled, and absurd times are dropped.
        store.set_limited(&task.id, None).unwrap();
        assert!(store.set_resume_at_reset(&task.id, true).is_err());
        store.set_limited(&task.id, Some(i64::MAX)).unwrap();
        assert_eq!(store.session(&task.id).unwrap().limited_until, None);
        store.clear_limited(&task.id).unwrap();
        assert!(store.session(&task.id).unwrap().limited_at.is_none());
        assert!(store.set_resume_at_reset(&task.id, true).is_err(), "only a limited task can resume at reset");
    }

    #[test]
    fn task_search_matches_titles_and_messages_within_the_project() {
        let (store, task) = empty_session();
        store.update(&task.id, Some("Fix the login redirect".into()), None, None, None).unwrap();
        let other = store.create_session(&task.project_id, "codex", "gpt-5", "full").unwrap();
        store.message(&other.id, "user", "Please make the billing page load 100% faster").unwrap();
        store.message(&other.id, "assistant", "I will profile the billing page first.").unwrap();
        let folder = std::env::temp_dir().join(format!("pandacode-search-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&folder).unwrap();
        let elsewhere = store.add_project(&folder).unwrap();
        assert_ne!(elsewhere.id, task.project_id);
        let foreign = store.create_session(&elsewhere.id, "codex", "gpt-5", "full").unwrap();
        store.message(&foreign.id, "user", "billing secrets").unwrap();
        let ids = |query: &str| store.search_tasks(&task.project_id, query, 20).unwrap().into_iter().map(|row| row["taskId"].as_str().unwrap().to_owned()).collect::<Vec<_>>();
        assert_eq!(ids("LOGIN"), vec![task.id.clone()]);
        let billing = store.search_tasks(&task.project_id, "billing", 20).unwrap();
        assert_eq!(billing.len(), 1, "other projects stay out of the results");
        assert!(billing[0]["excerpt"].as_str().unwrap().contains("billing page"));
        // LIKE wildcards are literal.
        assert_eq!(ids("100%"), vec![other.id.clone()]);
        assert!(ids("10_%").is_empty());
        assert!(store.search_tasks(&task.project_id, "  ", 20).is_err());
        std::fs::remove_dir_all(folder).unwrap();
    }

    #[test]
    fn startup_discards_only_empty_drafts() {
        let (store, board_like) = empty_session();
        let empty = store.create_session(&board_like.project_id, "codex", "gpt-5", "auto").unwrap();
        store.mark_draft(&empty.id).unwrap();
        let replied = store.create_session(&board_like.project_id, "codex", "gpt-5", "auto").unwrap();
        store.mark_draft(&replied.id).unwrap();
        store.message(&replied.id, "assistant", "partial").unwrap();
        assert_eq!(store.discard_empty_drafts().unwrap(), 1);
        assert!(store.session(&empty.id).is_err());
        assert!(store.session(&replied.id).is_ok(), "a draft with saved history is kept");
        assert!(store.session(&board_like.id).is_ok(), "empty non-draft tasks, such as board tasks, are kept");
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
    fn sidebar_metadata_has_unpinned_unordered_defaults() {
        let (store, task) = empty_session();
        let saved = serde_json::to_value(store.session(&task.id).unwrap()).unwrap();
        assert_eq!(saved["pinned"], false);
        assert_eq!(saved["sidebarOrder"], serde_json::Value::Null);
    }

    #[test]
    fn board_tasks_are_pending_without_starting_a_conversation() {
        let (store, source) = empty_session();
        let task = store
            .create_board_task(
                &source.project_id,
                "codex",
                "gpt-5",
                "plan",
                "  Build game  ",
                "  Add a board and timer.  ",
            )
            .unwrap();
        assert_eq!(task.title, "Build game");
        assert_eq!(task.task_description, "Add a board and timer.");
        assert_eq!(task.task_stage, "pending");
        assert_eq!(task.status, "idle");
        assert_eq!(task.mode, "plan");
        assert!(task.completed_at.is_none());
        assert!(store.messages(&task.id, None).unwrap().is_empty());
        let edited = store
            .update_task_details(&task.id, "Add leaderboard", "Rank the scores")
            .unwrap();
        assert_eq!(edited.task_description, "Rank the scores");
        assert!(store.messages(&task.id, None).unwrap().is_empty());
        let count = store.sessions().unwrap().len();
        for (provider, title, details) in [
            ("bad", "Valid", ""),
            ("codex", "  ", ""),
            ("codex", "Valid", &"x".repeat(128 * 1024 + 1)),
        ] {
            assert!(store
                .create_board_task(
                    &source.project_id,
                    provider,
                    "default",
                    "ask",
                    title,
                    details
                )
                .is_err());
        }
        assert_eq!(store.sessions().unwrap().len(), count);
        assert_eq!(serde_json::to_value(task).unwrap()["taskStage"], "pending");
    }

    #[test]
    fn task_lists_bound_description_previews_without_truncating_details_or_start_prompts() {
        let (store, source) = empty_session();
        let description = "λ".repeat(8_000);
        let task = store
            .create_board_task(
                &source.project_id,
                "codex",
                "default",
                "ask",
                "Long specification",
                &description,
            )
            .unwrap();
        let preview = store
            .sessions()
            .unwrap()
            .into_iter()
            .find(|item| item.id == task.id)
            .unwrap();
        assert_eq!(preview.task_description.chars().count(), 512);
        assert_eq!(
            store.session(&task.id).unwrap().task_description,
            description
        );
        // Start reads the full task through session(), independently of the
        // shortened board metadata returned to the frontend.
        let prompt = store.session(&task.id).unwrap().task_description;
        store.begin_task_turn(&task.id, &prompt).unwrap();
        assert_eq!(
            store.messages(&task.id, None).unwrap()[0].content,
            description
        );
    }

    #[test]
    fn archive_sweep_includes_completed_tasks_outside_the_recent_list() {
        let (store, task) = empty_session();
        store.set_task_stage(&task.id, "completed").unwrap();
        store
            .db
            .execute(
                "UPDATE sessions SET created_at=0,updated_at=0,completed_at=?2 WHERE id=?1",
                params![task.id, now() - COMPLETED_ARCHIVE_DELAY_MS],
            )
            .unwrap();
        store.db.execute("WITH RECURSIVE n(value) AS (SELECT 1 UNION ALL SELECT value+1 FROM n WHERE value<501)
            INSERT INTO sessions(id,project_id,title,provider,model,mode,status,created_at,updated_at)
            SELECT 'filler-'||value,?1,'Recent task','codex','default','ask','idle',1,1 FROM n", [&task.project_id]).unwrap();
        let recent = store.sessions().unwrap();
        assert_eq!(recent.len(), 500);
        assert!(recent.iter().all(|item| item.id != task.id));
        assert_eq!(store.archive_completed(now()).unwrap(), 1);
        assert!(store.session(&task.id).unwrap().archived);
    }

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
        store.begin_task_turn(&task.id, "Finish").unwrap();
        store.finish_task_turn(&task.id, true, false).unwrap();
        let review = store.session(&task.id).unwrap();
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
    fn completed_archive_uses_exact_deadline_and_manual_restore_grants_another_week() {
        let (store, task) = empty_session();
        store.set_task_stage(&task.id, "completed").unwrap();
        let completed_at = now() - COMPLETED_ARCHIVE_DELAY_MS;
        store
            .db
            .execute(
                "UPDATE sessions SET completed_at=?2 WHERE id=?1",
                params![task.id, completed_at],
            )
            .unwrap();
        store
            .update_task_details(&task.id, "Edited later", "Still complete")
            .unwrap();
        assert_eq!(
            store
                .archive_completed(completed_at + COMPLETED_ARCHIVE_DELAY_MS - 1)
                .unwrap(),
            0
        );
        assert_eq!(
            store
                .archive_completed(completed_at + COMPLETED_ARCHIVE_DELAY_MS)
                .unwrap(),
            1
        );
        assert_eq!(store.archive_completed(now()).unwrap(), 0);
        assert!(store.session(&task.id).unwrap().archived);
        store
            .update(&task.id, None, Some(false), None, None)
            .unwrap();
        let restored = store.session(&task.id).unwrap();
        assert!(!restored.archived);
        assert!(restored.completed_at.unwrap() > completed_at);
        assert_eq!(store.archive_completed(now()).unwrap(), 0);
        store.set_task_stage(&task.id, "pending").unwrap();
        assert_eq!(
            store
                .archive_completed(now() + 2 * COMPLETED_ARCHIVE_DELAY_MS)
                .unwrap(),
            0
        );
        assert!(store.session(&task.id).unwrap().completed_at.is_none());
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
                    "ALTER TABLE sessions DROP COLUMN goal_state; ALTER TABLE sessions DROP COLUMN codex_settings; DROP TABLE subagents; DROP INDEX sessions_completed_archive;
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
                    params![answered, now() - COMPLETED_ARCHIVE_DELAY_MS],
                )
                .unwrap();
        }
        {
            let store = Store::open(&path).unwrap();
            let archived = store.session(&answered).unwrap();
            assert!(archived.archived);
            assert_eq!(archived.task_stage, "completed");
            assert_eq!(archived.task_description, "Original requirements");
            assert_eq!(store.messages(&answered, None).unwrap().len(), 2);
            assert!(!store.session(&empty).unwrap().archived);
        }
        std::fs::remove_dir_all(directory).unwrap();
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
                    "ALTER TABLE sessions DROP COLUMN goal_state; ALTER TABLE sessions DROP COLUMN codex_settings; DROP TABLE subagents; DROP INDEX sessions_completed_archive;
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
                    "ALTER TABLE sessions DROP COLUMN goal_state; ALTER TABLE sessions DROP COLUMN codex_settings; DROP TABLE subagents; DROP INDEX sessions_completed_archive; ALTER TABLE sessions DROP COLUMN task_stage; ALTER TABLE sessions DROP COLUMN task_description; ALTER TABLE sessions DROP COLUMN completed_at; ALTER TABLE sessions DROP COLUMN reasoning_effort; ALTER TABLE sessions DROP COLUMN context_used_tokens; ALTER TABLE sessions DROP COLUMN context_window; ALTER TABLE messages DROP COLUMN turn_duration_ms; PRAGMA user_version=5;",
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
        let source = include_str!("storage.rs");
        let newest = source
            .match_indices("PRAGMA user_version=")
            .filter_map(|(index, marker)| source[index + marker.len()..].split(|c: char| !c.is_ascii_digit()).next()?.parse::<i64>().ok())
            .max()
            .unwrap();
        assert_eq!(newest, SCHEMA_VERSION, "bump SCHEMA_VERSION with every new migration step");
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
    fn configure_empty_task_can_switch_provider_and_preserves_permissions() {
        let (store, session) = empty_session();
        store
            .update(
                &session.id,
                Some("Saved title".into()),
                Some(true),
                None,
                None,
            )
            .unwrap();
        store
            .db
            .execute(
                "UPDATE sessions SET updated_at=0 WHERE id=?1",
                [&session.id],
            )
            .unwrap();
        let before = store.session(&session.id).unwrap();
        let updated = store
            .configure(&session.id, "codex", "gpt-5.6-sol", None)
            .unwrap();
        assert_eq!(updated.provider, "codex");
        assert_eq!(updated.model, "gpt-5.6-sol");
        assert_eq!(updated.mode, before.mode);
        assert_eq!(updated.resume_id, None);
        assert_eq!(updated.id, before.id);
        assert_eq!(updated.project_id, before.project_id);
        assert_eq!(updated.title, before.title);
        assert_eq!(updated.archived, before.archived);
        assert_eq!(updated.status, before.status);
        assert_eq!(updated.created_at, before.created_at);
        assert!(updated.updated_at > before.updated_at);
    }

    #[test]
    fn configure_empty_task_project_switch_preserves_identity_and_survives_reopen() {
        let dir = std::env::temp_dir().join(format!("pandacode-project-switch-{}", id()));
        std::fs::create_dir_all(dir.join("destination")).unwrap();
        let path = dir.join("store.db");
        let expected;
        {
            let store = Store::open(&path).unwrap();
            let source = store.add_project(&dir).unwrap();
            let destination = store.add_project(&dir.join("destination")).unwrap();
            let task = store
                .create_session(&source.id, "claude", "sonnet", "auto")
                .unwrap();
            store
                .update(&task.id, Some("Draft task".into()), Some(true), None, None)
                .unwrap();
            store
                .db
                .execute("UPDATE sessions SET updated_at=0 WHERE id=?1", [&task.id])
                .unwrap();
            let before = store.session(&task.id).unwrap();
            let moved = store
                .configure(&task.id, "claude", "sonnet", Some(&destination.id))
                .unwrap();
            assert_eq!(moved.project_id, destination.id);
            assert!(moved.updated_at > before.updated_at);
            let mut prior = serde_json::to_value(before).unwrap();
            prior["projectId"] = destination.id.into();
            prior["updatedAt"] = moved.updated_at.into();
            expected = serde_json::to_value(&moved).unwrap();
            assert_eq!(
                expected, prior,
                "Only project and modification time should change"
            );
            assert!(store.messages(&task.id, None).unwrap().is_empty());
        }
        {
            let store = Store::open(&path).unwrap();
            assert_eq!(
                serde_json::to_value(store.sessions().unwrap().remove(0)).unwrap(),
                expected
            );
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn configure_project_change_rejects_any_history_and_resume_atomically() {
        for role in ["user", "assistant", "tool", "status", "error", "resume"] {
            let (store, task) = empty_session();
            let destination = store.add_project(Path::new("/")).unwrap();
            if role == "resume" {
                store.resume(&task.id, "remote-task").unwrap();
            } else {
                store.message(&task.id, role, "Saved activity").unwrap();
            }
            let before = serde_json::to_value(store.session(&task.id).unwrap()).unwrap();
            assert!(
                store
                    .configure(&task.id, "claude", "opus", Some(&destination.id))
                    .is_err(),
                "History kind {role} must prevent moving"
            );
            assert_eq!(
                serde_json::to_value(store.session(&task.id).unwrap()).unwrap(),
                before
            );
            let same = store
                .configure(&task.id, "claude", "opus", Some(&task.project_id))
                .unwrap();
            assert_eq!(same.project_id, task.project_id);
            assert_eq!(
                same.model, "opus",
                "Existing tasks can still change models within their project"
            );
        }
    }

    #[test]
    fn configure_project_change_checks_history_outside_current_page() {
        let (store, task) = empty_session();
        let destination = store.add_project(Path::new("/")).unwrap();
        store.message(&task.id, "user", "Original prompt").unwrap();
        for _ in 0..100 {
            store.message(&task.id, "tool", "Tool completed").unwrap();
        }
        assert!(store
            .messages(&task.id, None)
            .unwrap()
            .iter()
            .all(|m| m.role == "tool"));
        let before = serde_json::to_value(store.session(&task.id).unwrap()).unwrap();
        assert!(store
            .configure(&task.id, "claude", "opus", Some(&destination.id))
            .is_err());
        assert_eq!(
            serde_json::to_value(store.session(&task.id).unwrap()).unwrap(),
            before
        );
    }

    #[test]
    fn configure_project_change_rejects_active_task_without_messages() {
        for status in ["running", "waiting"] {
            let (store, task) = empty_session();
            let destination = store.add_project(Path::new("/")).unwrap();
            store.status(&task.id, status).unwrap();
            let before = serde_json::to_value(store.session(&task.id).unwrap()).unwrap();
            assert!(store
                .configure(&task.id, "claude", "opus", Some(&destination.id))
                .is_err());
            assert_eq!(
                serde_json::to_value(store.session(&task.id).unwrap()).unwrap(),
                before
            );
        }
    }

    #[test]
    fn configure_invalid_project_cannot_partially_change_harness_or_model() {
        let (store, task) = empty_session();
        let before = serde_json::to_value(store.session(&task.id).unwrap()).unwrap();
        for project in ["missing", ""] {
            assert!(store
                .configure(&task.id, "codex", "default", Some(project))
                .is_err());
            assert_eq!(
                serde_json::to_value(store.session(&task.id).unwrap()).unwrap(),
                before
            );
        }
        let destination = store.add_project(Path::new("/")).unwrap();
        assert!(store
            .configure(&task.id, "unknown", "default", Some(&destination.id))
            .is_err());
        assert!(store
            .configure(&task.id, "codex", &"x".repeat(201), Some(&destination.id))
            .is_err());
        assert_eq!(
            serde_json::to_value(store.session(&task.id).unwrap()).unwrap(),
            before
        );
    }

    #[test]
    fn configure_provider_change_preserves_history_outside_current_page() {
        let (store, session) = empty_session();
        store.message(&session.id, "user", "Original prompt").unwrap();
        store.message(&session.id, "assistant", "Keep the exact code").unwrap();
        store.resume(&session.id, "old-native-id").unwrap();
        for _ in 0..100 { store.message(&session.id, "tool", "Tool completed").unwrap(); }
        let updated = store.configure(&session.id, "kimi", "default", None).unwrap();
        assert_eq!(updated.provider, "kimi");
        assert_eq!(updated.project_id, session.project_id);
        assert!(updated.resume_id.is_none());
        assert!(crate::context_recovery::pending(&store, &updated).unwrap());
        let (prompt, through) = crate::context_recovery::prepare(&store, &updated, "Continue").unwrap();
        assert!(through.is_some());
        assert!(prompt.contains("Original prompt"));
        assert!(prompt.contains("Keep the exact code"));
        assert!(!prompt.contains("Tool completed"));
        assert_eq!(store.messages(&session.id, None).unwrap().last().unwrap().role, "handoff");
        store.resume(&session.id, "new-native-id").unwrap();
        assert!(crate::context_recovery::pending(&store, &store.session(&session.id).unwrap()).unwrap());
    }

    #[test]
    fn configure_provider_change_clears_resume_without_inventing_missing_history() {
        let (store, session) = empty_session();
        store.resume(&session.id, "provider-session-1").unwrap();
        let updated = store.configure(&session.id, "codex", "default", None).unwrap();
        assert!(updated.resume_id.is_none());
        assert_eq!(store.messages(&session.id, None).unwrap()[0].role, "handoff");
        assert!(!crate::context_recovery::pending(&store, &updated).unwrap());
    }

    #[test]
    fn configure_same_provider_can_change_model_with_history_and_resume() {
        let (store, session) = empty_session();
        store.resume(&session.id, "provider-session-1").unwrap();
        store
            .message(&session.id, "user", "Original prompt")
            .unwrap();
        let updated = store
            .configure(&session.id, "claude", "opus", None)
            .unwrap();
        assert_eq!(updated.model, "opus");
        assert_eq!(updated.mode, "auto");
        assert_eq!(updated.resume_id.as_deref(), Some("provider-session-1"));
        assert_eq!(
            store.messages(&session.id, None).unwrap()[0].content,
            "Original prompt"
        );
    }

    #[test]
    fn configure_rejects_invalid_provider_model_and_missing_task_atomically() {
        let (store, session) = empty_session();
        let before = serde_json::to_value(store.session(&session.id).unwrap()).unwrap();
        assert!(store
            .configure(&session.id, "shell", "default", None)
            .is_err());
        assert!(store
            .configure(&session.id, "codex", &"x".repeat(201), None)
            .is_err());
        assert!(store
            .configure("missing", "claude", "sonnet", None)
            .is_err());
        assert_eq!(
            serde_json::to_value(store.session(&session.id).unwrap()).unwrap(),
            before
        );
        assert!(store
            .configure(&session.id, "claude", &"x".repeat(200), None)
            .is_ok());
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
    fn rejects_unknown_providers_and_permission_modes() {
        let store = Store::open(Path::new(":memory:")).unwrap();
        let p = store.add_project(&std::env::temp_dir()).unwrap();
        assert!(store.create_session(&p.id, "shell", "", "ask").is_err());
        assert!(store
            .create_session(&p.id, "codex", "", "dangerously-bypass")
            .is_err());
        assert!(store.messages("missing", None).is_err());
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
                "pi",
                "deepseek",
                "commandcode",
                "cline",
                "kilo",
                "omp",
                "github-copilot",
                "muse",
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
    fn approval_behavior_cannot_change_during_a_running_turn() {
        let store = Store::open(Path::new(":memory:")).unwrap();
        let project = store.add_project(&std::env::temp_dir()).unwrap();
        let session = store
            .create_session(&project.id, "codex", "default", "ask")
            .unwrap();
        for status in ["running", "waiting"] {
            store.status(&session.id, status).unwrap();
            assert!(store
                .update(
                    &session.id,
                    Some("New title".into()),
                    None,
                    None,
                    Some("full".into())
                )
                .unwrap_err()
                .contains("Stop the agent"));
            let unchanged = store.session(&session.id).unwrap();
            assert_eq!(unchanged.mode, "ask");
            assert_eq!(unchanged.title, "New conversation");
            store
                .update(&session.id, Some("Renamed task".into()), None, None, None)
                .unwrap();
            store
                .update(
                    &session.id,
                    Some("New conversation".into()),
                    None,
                    None,
                    None,
                )
                .unwrap();
        }
        store.status(&session.id, "idle").unwrap();
        store
            .update(&session.id, None, None, None, Some("plan".into()))
            .unwrap();
        assert_eq!(store.session(&session.id).unwrap().mode, "plan");
        assert!(store
            .update(&session.id, None, None, None, Some("invalid".into()))
            .is_err());
        assert_eq!(store.session(&session.id).unwrap().mode, "plan");
    }
}
