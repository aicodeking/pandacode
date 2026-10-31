use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
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
    matches!(mode, "ask" | "auto" | "review" | "plan" | "full")
}

// Only new user tasks use this default. Persisted tasks always retain their
// selected mode, including restrictive modes chosen before this default changed.
pub const DEFAULT_PERMISSION_MODE: &str = "full";


#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
    /// When the project was added, as an increasing number (its rowid): the sidebar's Added sort.
    pub added_order: i64,
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
/// One folder of a multi-folder project; `projects.path` always equals the primary row's path.
#[derive(Clone, Debug, PartialEq)]
pub struct Folder {
    pub path: String,
    pub position: i64,
    pub is_primary: bool,
}
/// A task's working folder: the project folder itself, or a checkout recorded for it.
#[derive(Clone, Debug, PartialEq)]
pub struct RepoFolder {
    pub path: PathBuf,
    pub label: String,
    pub is_primary: bool,
    pub worktree: Option<PathBuf>,
    pub branch: Option<String>,
}
/// Folder display names: the basename, parent-qualified only where basenames collide.
pub fn folder_labels(paths: &[PathBuf]) -> Vec<String> {
    let base = |p: &Path| {
        p.file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| p.to_string_lossy().to_string())
    };
    let basenames: Vec<String> = paths.iter().map(|p| base(p)).collect();
    let mut counts: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    for name in &basenames {
        *counts.entry(name.as_str()).or_insert(0) += 1;
    }
    paths
        .iter()
        .zip(&basenames)
        .map(|(p, name)| {
            if counts[name.as_str()] > 1 {
                if let Some(parent) = p.parent() {
                    return format!("{}/{}", base(parent), name);
                }
            }
            name.clone()
        })
        .collect()
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
    /// Tasks this open marked `restart_interrupted` (running or waiting when the previous
    /// process ended, and not stopped by the user). The crash notice reads it.
    pub restart_interrupted: usize,
    /// The v38 trackers this open may use, disabled on all newer schemas. A runtime loss of
    /// `architect_team_meta` is tracked separately in `team_trackers_disabled`.
    trackers_usable: bool,
    /// Set at runtime when this process finds `architect_team_meta` gone (another build's repair
    /// on the same data folder): team reads fall back to the snapshots until the next open.
    team_trackers_disabled: AtomicBool,
    model_audit_usable: bool,
}
type Result<T> = std::result::Result<T, String>;
/// The WAL size limit (64 MiB) after a reset, set by `Store::open`.
macro_rules! journal_size_limit_pragma {
    () => {
        "PRAGMA journal_size_limit=67108864;"
    };
}
/// `Store::open`'s prepared-statement cache: room for every `prepare_cached` statement.
const STMT_CACHE_CAPACITY: usize = 256;
/// `Store::open_read_only`'s page cache (4 MiB) and in-memory temp storage.
const READ_ONLY_PRAGMAS: &str = "PRAGMA cache_size=-4096; PRAGMA temp_store=MEMORY;";
mod helpers;
mod messages;
pub(crate) mod model_audit;
mod schema_v38;
mod sessions;
mod sql;
mod subagents;
use helpers::{recover_after_restart, set_steady_storage_pragmas, tracked_recovery};
pub(crate) use helpers::with_migration_pragmas;
pub(crate) use helpers::{
    resolve_workspace_root, run_savepoint, serialize_subagent, ImmediateTxError, RollbackGuard,
};
use schema_v38::{log_slow_upgrade, repair_v38_objects, upgrade_v38};
use sql::{BASE_SCHEMA, LEGACY_PROMPT_CUTOFF_SCAN_SQL, LEGACY_PROMPT_CUTOFF_SQL, SIDEBAR_ORDER};
// `storage_bench` (test-only) reads these.
#[cfg(test)]
pub(crate) use schema_v38::{
    V38_BOT_INDEXES, V38_SCHEMA_INDEXES, V38_TRACKER_INDEXES, V38_TRACKER_TABLES,
    V38_TRACKER_TRIGGERS,
};
/// The newest `PRAGMA user_version`. Folder associations and per-repository links require version 38.
pub const SCHEMA_VERSION: i64 = 38;
/// Most error rows one dismiss call may remove; the same limit as `DISMISS_BATCH` in src/thread-errors.ts (keep the two equal).
pub const MAX_DISMISS_ERROR_IDS: usize = 500;
/// The error every lookup of a task that has no row returns.
pub(crate) const SESSION_NOT_FOUND: &str = "Conversation not found.";
/// The `architect_teams` triggers that hard-reference `architect_team_meta`. A repair run by
/// another PandaCode build on the same data folder can drop the table and leave these behind;
/// `architect::write_snapshot` drops them so team saves keep working until the next open.
pub(crate) const TEAM_META_TRIGGERS: [&str; 3] = [
    "architect_team_meta_insert",
    "architect_team_meta_update_clear",
    "architect_team_meta_update_sync",
];

/// Stored paths canonicalized per launch lookup at most (`launch_project_at`).
const LAUNCH_CANDIDATES: usize = 64;

/// Whether `column` holds the launch folder (?1, ?2) or a path ending in one of its names (?3..?6).
fn launch_path_match(column: &str) -> String {
    format!("({column} IN (?1,?2) OR substr({column},-length(?3))=?3 OR substr({column},-length(?4))=?4 OR substr({column},-length(?5))=?5 OR substr({column},-length(?6))=?6)")
}

/// `launch_project_at`'s task-worktree candidates: walks only the `sessions_worktree` partial
/// index (tasks with a worktree), never every task.
fn launch_worktrees_sql() -> String {
    format!("SELECT DISTINCT p.id,p.path,s.worktree_path FROM sessions s JOIN projects p ON p.id=s.project_id WHERE s.worktree_path IS NOT NULL AND {} ORDER BY s.worktree_path IN (?1,?2) DESC,p.id LIMIT {LAUNCH_CANDIDATES}", launch_path_match("s.worktree_path"))
}

/// `[as given, resolved, then each one's last component after a / and after a \]`: a stored
/// path that names this folder another way (`..`, a trailing `.`) still ends in one of those.
fn launch_path_patterns(cwd: &Path, resolved: &Path) -> [String; 6] {
    let text = |p: &Path| p.to_string_lossy().into_owned();
    let suffix = |p: &Path, separator: char| {
        p.file_name().map_or_else(
            || text(p),
            |name| format!("{separator}{}", name.to_string_lossy()),
        )
    };
    [
        text(cwd),
        text(resolved),
        suffix(cwd, '/'),
        suffix(cwd, '\\'),
        suffix(resolved, '/'),
        suffix(resolved, '\\'),
    ]
}

impl Store {
    /// Launch lookups must never migrate or repair the database behind the live Store.
    pub(crate) fn open_read_only(path: &Path) -> Result<Self> {
        let db = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|e| e.to_string())?;
        db.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|e| e.to_string())?;
        db.execute_batch(READ_ONLY_PRAGMAS)
            .map_err(|e| e.to_string())?;
        let version: i64 = db
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .map_err(|e| e.to_string())?;
        if version < SCHEMA_VERSION {
            return Err(format!("Database schema {version} is older than {SCHEMA_VERSION}; open PandaCode to migrate it."));
        }
        Ok(Self {
            db,
            path: path.into(),
            restart_interrupted: 0,
            trackers_usable: false,
            team_trackers_disabled: AtomicBool::new(false),
            model_audit_usable: false,
        })
    }

    /// Whether `architect_team_meta` (else `architect_teams`) answers team status queries.
    pub(crate) fn team_meta_usable(&self) -> bool {
        self.trackers_usable && !self.team_trackers_disabled.load(Ordering::Relaxed)
    }

    /// Stops this process from reading or writing `architect_team_meta`: another build's repair
    /// dropped the table, and `repair_v38_objects` rebuilds it at the next open.
    pub(crate) fn disable_team_trackers(&self) {
        self.team_trackers_disabled.store(true, Ordering::Relaxed);
    }

    pub(crate) fn launch_session_project(&self, sid: &str) -> Result<Option<(String, String)>> {
        self.db.query_row(
            "SELECT p.id,p.path FROM sessions s JOIN projects p ON p.id=s.project_id WHERE s.id=?1",
            [sid], |r| Ok((r.get(0)?, r.get(1)?)),
        ).optional().map_err(|e| e.to_string())
    }

    /// The project a launch folder belongs to: a task worktree first, then a main checkout.
    /// SQL keeps only rows whose stored path is the folder or ends in its name (as given or
    /// with links resolved), so only those few candidates are canonicalized.
    pub(crate) fn launch_project_at(&self, cwd: &Path) -> Result<Option<(String, String)>> {
        let canonical = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_owned());
        let wanted = canonical(cwd);
        let [exact, resolved, a, b, c, d] = launch_path_patterns(cwd, &wanted);
        let matches = launch_path_match;
        let params = rusqlite::params![exact, resolved, a, b, c, d];
        let mut stmt = self.db.prepare(&launch_worktrees_sql()).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params, |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (id, path, worktree) = row.map_err(|e| e.to_string())?;
            if canonical(Path::new(&worktree)) == wanted {
                return Ok(Some((id, path)));
            }
        }
        let mut stmt = self.db.prepare(&format!("SELECT id,path FROM projects WHERE {} ORDER BY path IN (?1,?2) DESC,id LIMIT {LAUNCH_CANDIDATES}", matches("path"))).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params, |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (id, path) = row.map_err(|e| e.to_string())?;
            if canonical(Path::new(&path)) == wanted {
                return Ok(Some((id, path)));
            }
        }
        Ok(None)
    }

    pub fn open(path: &Path) -> Result<Self> {
        Self::open_with_before_recovery(path, || {})
    }

    fn open_with_before_recovery(path: &Path, before_recovery: impl FnOnce()) -> Result<Self> {
        let mut db = Connection::open(path).map_err(|e| e.to_string())?;
        // Room for every `prepare_cached` statement (about 220 call sites). The WAL keeps
        // SQLite's default 1000-page autocheckpoint, so no single commit under the Store lock
        // pays for a larger checkpoint. No `busy_timeout` here: rusqlite opens every connection
        // with a 5 s one already.
        db.set_prepared_statement_cache_capacity(STMT_CACHE_CAPACITY);
        db.execute_batch(concat!("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL; PRAGMA mmap_size=0; ", journal_size_limit_pragma!())).map_err(|e| e.to_string())?;
        set_steady_storage_pragmas(&db)?;
        let version: i64 = db
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(|e| e.to_string())?;
        let opened_version = if version < SCHEMA_VERSION {
            Self::migrate(&db)?
        } else {
            version
        };
        repair_v38_objects(&mut db, opened_version)?;
        before_recovery();
        let (restart_interrupted, recovery_version, model_audit_usable) = recover_after_restart(&mut db)?;
        let store = Self {
            db,
            path: path.to_path_buf(),
            restart_interrupted,
            trackers_usable: recovery_version <= SCHEMA_VERSION,
            team_trackers_disabled: AtomicBool::new(false),
            model_audit_usable,
        };
        tracked_recovery(&store.db, recovery_version, "team library", |_| crate::architect::profiles::initialize(&store))?;
        tracked_recovery(&store.db, recovery_version, "archived tasks", |_| store.settle_archived())?;
        Ok(store)
    }

    fn migrate(db: &Connection) -> Result<i64> {
        // One transactional backfill, using the existing session/message
        // index. Listing tasks subsequently reads only session metadata.
        with_migration_pragmas(db, true, || {
            let migration = rusqlite::Transaction::new_unchecked(db, rusqlite::TransactionBehavior::Immediate)
                .map_err(|e| e.to_string())?;
            // Another app instance may have migrated while this one waited.
            let version: i64 = migration
                .pragma_query_value(None, "user_version", |row| row.get(0))
                .map_err(|e| e.to_string())?;
            if version < SCHEMA_VERSION {
                migration.execute_batch(BASE_SCHEMA).map_err(|e| e.to_string())?;
            }
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
            if version < 28 {
                // Bots: an optional personality (soul.md) kept apart from instructions (docs/bots.md).
                crate::bots::migrate_soul(&migration)?;
                migration.execute_batch("PRAGMA user_version=28;").map_err(|e| e.to_string())?;
            }
            if version < 29 {
                // Bots: skill and MCP references, and the bot a project task was started with (docs/bots.md).
                crate::bots::migrate_capabilities(&migration)?;
                migration.execute_batch("PRAGMA user_version=29;").map_err(|e| e.to_string())?;
            }
            if version < 30 {
                // Durable links let Connect load only attachments belonging to a saved message.
                migration.execute_batch("CREATE TABLE IF NOT EXISTS message_attachments(
                    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
                    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                    id TEXT NOT NULL,
                    kind TEXT NOT NULL CHECK(kind='image'),
                    name TEXT NOT NULL,
                    mime TEXT NOT NULL,
                    width INTEGER,
                    height INTEGER,
                    bytes INTEGER NOT NULL CHECK(bytes>=0),
                    file TEXT,
                    source TEXT NOT NULL CHECK(source IN ('file','moodboard')),
                    moodboard_id TEXT REFERENCES moodboards(id) ON DELETE CASCADE,
                    moodboard_image_id TEXT REFERENCES moodboard_images(id) ON DELETE CASCADE,
                    PRIMARY KEY(session_id,id),
                    CHECK((source='file' AND file IS NOT NULL AND moodboard_id IS NULL AND moodboard_image_id IS NULL) OR (source='moodboard' AND file IS NULL AND moodboard_id IS NOT NULL AND moodboard_image_id IS NOT NULL))
                  );
                  CREATE INDEX IF NOT EXISTS message_attachments_session_id ON message_attachments(session_id,id,message_id);
                  CREATE INDEX IF NOT EXISTS message_attachments_message ON message_attachments(message_id,session_id);
                  PRAGMA user_version=30;").map_err(|e|e.to_string())?;
            }
            if version < 31 {
                // Connect viewer cursors: where this computer left off in each host's event
                // journal, so a restart replays what it missed (docs/remote-access.md).
                migration.execute_batch("CREATE TABLE IF NOT EXISTS remote_cursors(device TEXT NOT NULL,session TEXT NOT NULL,epoch TEXT NOT NULL,seq INTEGER NOT NULL CHECK(seq>=0),PRIMARY KEY(device,session)); PRAGMA user_version=31;").map_err(|e| e.to_string())?;
            }
            if version < 32 {
                // Mirrors copy the host's newest page first, then older pages behind it: copied
                // messages take local id `remote_backfill_base + host id`, a range kept free when
                // the newest page was stored. NULL once nothing older is left to copy.
                let exists: bool = migration.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('sessions') WHERE name='remote_backfill_base')", [], |r| r.get(0)).map_err(|e| e.to_string())?;
                if !exists {
                    migration.execute_batch("ALTER TABLE sessions ADD COLUMN remote_backfill_base INTEGER;").map_err(|e| e.to_string())?;
                }
                migration.execute_batch("PRAGMA user_version=32;").map_err(|e| e.to_string())?;
            }
            if version < 33 {
                // A mirror's copy of a message the host cut to fit a small first page holds the
                // host id here until it is fetched whole, across restarts. NULL for every other row.
                let exists: bool = migration.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('messages') WHERE name='remote_cut')", [], |r| r.get(0)).map_err(|e| e.to_string())?;
                if !exists {
                    migration.execute_batch("ALTER TABLE messages ADD COLUMN remote_cut INTEGER;").map_err(|e| e.to_string())?;
                }
                migration.execute_batch("PRAGMA user_version=33;").map_err(|e| e.to_string())?;
            }
            if version < 34 {
                // Per-task usage attribution: every harness session id each task has run
                // under, so its token totals can be summed from the agents' own logs.
                migration.execute_batch("CREATE TABLE IF NOT EXISTS task_usage_links(session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,harness_id TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(session_id,harness_id)); PRAGMA user_version=34;").map_err(|e| e.to_string())?;
            }
            if version < 35 {
                // Task schedules: wake-ups and timed messages for any thread (docs/schedules.md).
                migration.execute_batch(crate::schedules::SCHEMA).map_err(|e| e.to_string())?;
                migration.execute_batch("PRAGMA user_version=35;").map_err(|e| e.to_string())?;
            }
            if version < 36 {
                // Machine orchestration (docs/machine-orchestration.md): threads a task launched on
                // another computer, the wake message that reported each, whether the restart (not
                // the user) interrupted a task, and the user's Stop saved before the run is
                // signalled, so a quit right after it never counts as a restart interruption.
                migration.execute_batch("CREATE TABLE IF NOT EXISTS machine_threads(parent_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, created_at INTEGER NOT NULL, reported INTEGER NOT NULL DEFAULT 0);
                  CREATE INDEX IF NOT EXISTS machine_threads_parent ON machine_threads(parent_session_id,reported);").map_err(|e| e.to_string())?;
                for (table, name, definition) in [("sessions", "restart_interrupted", "INTEGER NOT NULL DEFAULT 0"), ("sessions", "stop_requested", "INTEGER NOT NULL DEFAULT 0"), ("machine_threads", "reported_by", "INTEGER")] {
                    let exists: bool = migration.query_row(&format!("SELECT EXISTS(SELECT 1 FROM pragma_table_info('{table}') WHERE name=?1)"), [name], |r| r.get(0)).map_err(|e| e.to_string())?;
                    if !exists {
                        migration.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {name} {definition};")).map_err(|e| e.to_string())?;
                    }
                }
                migration.execute_batch("CREATE INDEX IF NOT EXISTS machine_threads_reported_by ON machine_threads(reported_by) WHERE reported_by IS NOT NULL;
                  PRAGMA user_version=36;").map_err(|e|e.to_string())?;
            }
            if version < 37 {
                // Whether a remote device last saved each schedule, so the team gate is checked
                // again when it fires (`schedules::remote_team_gate`). Version 35's schema already
                // carries the column on databases created since; ids an unreleased build kept in
                // the settings row's `remoteSaved` list move into it (malformed settings JSON is skipped,
                // never failing startup). Released version 36 recorded nothing, so a schedule saved from a
                // phone there is indistinguishable: fail closed and mark every user-made schedule (agents'
                // own wakeups stay unmarked); a skipped run tells the user to save it on the desktop.
                let exists: bool = migration.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('task_schedules') WHERE name='saved_remotely')", [], |r| r.get(0)).map_err(|e| e.to_string())?;
                if !exists {
                    migration.execute_batch("ALTER TABLE task_schedules ADD COLUMN saved_remotely INTEGER NOT NULL DEFAULT 0;").map_err(|e| e.to_string())?;
                }
                migration.execute_batch("UPDATE task_schedules SET saved_remotely=1 WHERE created_by='user';
                  UPDATE task_schedules SET saved_remotely=1 WHERE id IN (SELECT j.value FROM scheduler_settings s, json_each(CASE WHEN json_valid(s.content) THEN s.content ELSE '{}' END,'$.remoteSaved') j WHERE s.id=1);
                  UPDATE scheduler_settings SET content=json_remove(content,'$.remoteSaved') WHERE id=1 AND json_valid(content);
                  PRAGMA user_version=37;").map_err(|e| e.to_string())?;
            }
            let upgrade_started = (version < SCHEMA_VERSION).then(std::time::Instant::now);
            if upgrade_started.is_some() {
                upgrade_v38(&migration)?;
            }
            if version < 38 {
                // Multi-folder projects: each project keeps an ordered folder list with one
                // primary (projects.path follows it), a task can point a folder at its own
                // checkout, and task links are keyed per repo ('' stays the primary link
                // today's single-link readers serve). SQLite cannot alter a primary key,
                // so task_links is rebuilt and every legacy row lands under repo=''.
                migration.execute_batch("CREATE TABLE IF NOT EXISTS project_folders(project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,path TEXT NOT NULL,position INTEGER NOT NULL DEFAULT 0,is_primary INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(project_id,path),UNIQUE(path));
                  CREATE TABLE IF NOT EXISTS session_repos(session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,path TEXT NOT NULL,worktree_path TEXT,worktree_branch TEXT,PRIMARY KEY(session_id,path));
                  INSERT OR IGNORE INTO project_folders(project_id,path,position,is_primary) SELECT id,path,0,1 FROM projects;").map_err(|e|e.to_string())?;
                migration.execute_batch("ALTER TABLE task_links RENAME TO task_links_v37;
                  CREATE TABLE task_links(session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,kind TEXT NOT NULL CHECK(kind IN ('issue','pull')),repo TEXT NOT NULL DEFAULT '',number INTEGER NOT NULL,url TEXT NOT NULL,title TEXT NOT NULL DEFAULT '',state TEXT NOT NULL DEFAULT '',checked_at INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(session_id,kind,repo));
                  INSERT INTO task_links(session_id,kind,repo,number,url,title,state,checked_at) SELECT session_id,kind,'',number,url,title,state,checked_at FROM task_links_v37;
                  DROP TABLE task_links_v37;
                  CREATE INDEX IF NOT EXISTS task_links_number ON task_links(kind,number);
                  PRAGMA user_version=38;").map_err(|e|e.to_string())?;
            }
            migration.commit().map_err(|e| e.to_string())?;
            if let Some(started) = upgrade_started {
                log_slow_upgrade(started);
            }
            Ok(version.max(SCHEMA_VERSION))
        })
    }

    /// Stamps teams still eligible for legacy coordination prompt classification.
    fn record_legacy_prompt_cutoff(db: &Connection, team_meta: bool) -> Result<()> {
        let sql = if team_meta { LEGACY_PROMPT_CUTOFF_SQL } else { LEGACY_PROMPT_CUTOFF_SCAN_SQL };
        db.execute_batch(sql).map_err(|e| e.to_string())
    }

    fn backfill_legacy_prompt_activity(db: &Connection) -> Result<()> {
        db.execute_batch(LEGACY_PROMPT_CUTOFF_SCAN_SQL).map_err(|e| e.to_string())?;
        let mut teams = db.prepare("SELECT session_id FROM architect_teams WHERE COALESCE(CASE WHEN json_valid(content) THEN json_extract(content,'$.legacyPromptThroughId') END,0)>0").map_err(|e| e.to_string())?;
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
}

/// `missing_sessions` input limits (the `sessions_missing` IPC).
pub const MAX_MISSING_IDS: usize = 2000;
pub const MAX_MISSING_ID_CHARS: usize = 128;

#[cfg(test)]
#[path = "storage_sidebar_tests.rs"]
mod sidebar_tests;

#[cfg(test)]
mod tests_messages;
#[cfg(test)]
mod tests_migrations;
#[cfg(test)]
mod tests_sessions;
#[cfg(test)]
mod tests_upgrade_safety;
#[cfg(test)]
#[path = "storage_folder_tests.rs"]
mod folder_tests;
