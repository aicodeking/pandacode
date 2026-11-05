//! Bots: named, always-on agents that live in PandaCode and can be reached from the
//! desktop app, a local web page and chat channels (docs/bots.md). Each bot owns a
//! workspace project; each conversation with it is an ordinary PandaCode task, so
//! harness runs, approvals, the queue and history work unchanged.

mod brief;
pub(crate) mod channels;
pub(crate) mod failover;
pub(crate) mod gateway;
pub(crate) mod guard;
pub(crate) mod schedule;
pub(crate) mod shared_channels;
mod secrets;
#[cfg(test)]
mod tests;
pub(crate) mod tools;

use crate::{storage::Store, AppState, Result};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;
use tauri::{Emitter, Manager, State};

pub(crate) const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS bots(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL DEFAULT '',
  goals TEXT NOT NULL DEFAULT '',
  soul TEXT NOT NULL DEFAULT '',
  avatar TEXT NOT NULL DEFAULT '',
  project_id TEXT NOT NULL REFERENCES projects(id),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  mode TEXT NOT NULL,
  heartbeat_minutes INTEGER NOT NULL DEFAULT 0 CHECK(heartbeat_minutes >= 0),
  next_heartbeat_at INTEGER,
  paused INTEGER NOT NULL DEFAULT 0 CHECK(paused IN (0,1)),
  memory_version INTEGER NOT NULL DEFAULT 0,
  notify_channel_id TEXT,
  notify_thread TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  color TEXT NOT NULL DEFAULT '',
  reasoning_effort TEXT NOT NULL DEFAULT '',
  backup_models TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(backup_models)),
  fallback_mode TEXT NOT NULL DEFAULT 'ask',
  notify INTEGER NOT NULL DEFAULT 1 CHECK(notify IN (0,1)),
  while_working TEXT NOT NULL DEFAULT 'queue',
  show_plan INTEGER NOT NULL DEFAULT 0 CHECK(show_plan IN (0,1)),
  skills TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(skills)),
  mcp TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(mcp)));
CREATE TABLE IF NOT EXISTS bot_memories(
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('user','bot')),
  created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS bot_memories_bot ON bot_memories(bot_id,created_at);
CREATE TABLE IF NOT EXISTS bot_threads(
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
  brief_version INTEGER NOT NULL DEFAULT -1,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(bot_id,channel_id,external_id));
CREATE TABLE IF NOT EXISTS bot_activity(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(detail)),
  at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS bot_activity_bot ON bot_activity(bot_id,id);
CREATE TABLE IF NOT EXISTS bot_schedules(
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('once','interval','daily','weekdays')),
  interval_minutes INTEGER,
  time_of_day TEXT,
  next_run_at INTEGER,
  last_run_at INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  created_by TEXT NOT NULL CHECK(created_by IN ('user','bot')),
  created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS bot_schedules_due ON bot_schedules(enabled,next_run_at);
CREATE TABLE IF NOT EXISTS bot_channels(
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('web','telegram','slack','discord','whatsapp')),
  label TEXT NOT NULL DEFAULT '',
  config TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(config)),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  status TEXT NOT NULL DEFAULT '',
  secret_names TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(secret_names)),
  web_token TEXT,
  created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS bot_pairings(
  channel_id TEXT NOT NULL REFERENCES bot_channels(id) ON DELETE CASCADE,
  sender_id TEXT NOT NULL,
  sender_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK(status IN ('pending','approved','blocked')),
  code TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(channel_id,sender_id));
CREATE TABLE IF NOT EXISTS bot_tasks(
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  brief_version INTEGER NOT NULL DEFAULT -1);
CREATE TABLE IF NOT EXISTS bot_rules(
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  pattern TEXT NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN ('allow','ask','deny')),
  created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS bot_shared_channels(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  lead_bot_id TEXT REFERENCES bots(id) ON DELETE SET NULL,
  archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS bot_shared_channel_members(
  channel_id TEXT NOT NULL REFERENCES bot_shared_channels(id) ON DELETE CASCADE,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  PRIMARY KEY(channel_id,bot_id),
  UNIQUE(channel_id,position));
CREATE TABLE IF NOT EXISTS bot_shared_channel_messages(
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES bot_shared_channels(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('user','reply')),
  author_bot_id TEXT REFERENCES bots(id) ON DELETE SET NULL,
  text TEXT NOT NULL,
  status TEXT CHECK(status IN ('queued','in_progress','completed','failed','stopped')),
  created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS bot_shared_channel_messages_channel ON bot_shared_channel_messages(channel_id,created_at,id);
CREATE TABLE IF NOT EXISTS bot_shared_channel_deliveries(
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES bot_shared_channels(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES bot_shared_channel_messages(id) ON DELETE CASCADE,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('queued','in_progress','completed','failed','stopped')),
  depth INTEGER NOT NULL DEFAULT 0 CHECK(depth BETWEEN 0 AND 3),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS bot_shared_channel_deliveries_session ON bot_shared_channel_deliveries(session_id,status,created_at,id);
CREATE TABLE IF NOT EXISTS bot_messages(
  id TEXT PRIMARY KEY,
  source_bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  target_bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  source_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  target_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  source_channel_id TEXT NOT NULL,
  source_external_id TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','in_progress','completed','failed','stopped')),
  result TEXT,
  depth INTEGER NOT NULL CHECK(depth BETWEEN 1 AND 3),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK(source_bot_id<>target_bot_id));
CREATE INDEX IF NOT EXISTS bot_messages_target ON bot_messages(target_session_id,status,created_at,id);
CREATE INDEX IF NOT EXISTS bot_messages_source ON bot_messages(source_session_id,created_at,id);
";

/// Profile columns added after the bots table first shipped (schema 25). Fresh databases get
/// them from `SCHEMA`; `upgrade` adds whichever are missing, so it is safe to run every start.
const ADDED_COLUMNS: [(&str, &str); 7] = [
    ("color", "TEXT NOT NULL DEFAULT ''"),
    ("reasoning_effort", "TEXT NOT NULL DEFAULT ''"),
    ("backup_models", "TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(backup_models))"),
    ("fallback_mode", "TEXT NOT NULL DEFAULT 'ask'"),
    ("notify", "INTEGER NOT NULL DEFAULT 1 CHECK(notify IN (0,1))"),
    ("while_working", "TEXT NOT NULL DEFAULT 'queue'"),
    ("show_plan", "INTEGER NOT NULL DEFAULT 0 CHECK(show_plan IN (0,1))"),
];

pub(crate) fn upgrade(db: &rusqlite::Connection) -> Result<()> {
    // Bot databases at schema 27 already exist in the wild. Keep these tables idempotent
    // here instead of bumping the app-wide schema version for this bot-only feature.
    db.execute_batch(SCHEMA).map_err(|e| e.to_string())?;
    for (name, definition) in ADDED_COLUMNS {
        let exists: bool = db
            .query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('bots') WHERE name=?1)", [name], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        if !exists {
            db.execute_batch(&format!("ALTER TABLE bots ADD COLUMN {name} {definition};")).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

const MAX_TEXT: usize = 16 * 1024;
/// A soul.md larger than this is refused rather than cut short.
pub(crate) const MAX_SOUL: usize = 64 * 1024;
const MAX_MEMORIES: i64 = 500;
pub(crate) const DESKTOP: &str = "desktop";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Bot {
    pub id: String,
    pub name: String,
    pub role: String,
    pub instructions: String,
    pub goals: String,
    /// Optional personality Markdown (a soul.md copied in once); never grants tools or permissions.
    pub soul: String,
    pub avatar: String,
    pub project_id: String,
    pub provider: String,
    pub model: String,
    pub mode: String,
    pub heartbeat_minutes: i64,
    pub next_heartbeat_at: Option<i64>,
    pub paused: bool,
    pub memory_version: i64,
    pub notify_channel_id: Option<String>,
    pub notify_thread: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    /// Badge color behind a panda avatar (`#rrggbb`); empty uses the panda's own.
    pub color: String,
    pub reasoning_effort: String,
    /// Models to try, in order, when the main one is unavailable.
    pub backup_models: Vec<BackupModel>,
    /// `ask` before switching to a backup model, or switch `auto`matically.
    pub fallback_mode: String,
    pub notify: bool,
    /// What a message sent while the bot works does: `queue` or `steer`.
    pub while_working: String,
    pub show_plan: bool,
    /// Library skill ids, by reference (schema 29).
    pub skills: Vec<String>,
    /// MCP server names from the harness's own config, by reference; never their definitions.
    pub mcp: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BackupModel {
    pub provider: String,
    pub model: String,
}

/// Editable fields; workspace and timestamps are owned by native code.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct BotInput {
    pub name: String,
    pub role: String,
    pub instructions: String,
    pub goals: String,
    /// Optional personality Markdown (a soul.md copied in once); never grants tools or permissions.
    pub soul: String,
    pub avatar: String,
    pub provider: String,
    pub model: String,
    pub mode: String,
    pub heartbeat_minutes: i64,
    pub color: String,
    pub reasoning_effort: String,
    pub backup_models: Vec<BackupModel>,
    pub fallback_mode: String,
    /// Absent (an older caller) means on.
    pub notify: Option<bool>,
    pub while_working: String,
    pub show_plan: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Memory {
    pub id: String,
    pub content: String,
    pub source: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    pub id: i64,
    pub kind: String,
    pub summary: String,
    pub detail: Value,
    pub at: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Thread {
    pub channel_id: String,
    pub external_id: String,
    pub session_id: String,
    pub updated_at: i64,
}

const BOT_COLUMNS: &str = "id,name,role,instructions,goals,avatar,project_id,provider,model,mode,heartbeat_minutes,next_heartbeat_at,paused,memory_version,notify_channel_id,notify_thread,created_at,updated_at,color,reasoning_effort,backup_models,fallback_mode,notify,while_working,show_plan,soul,skills,mcp";

fn bot_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Bot> {
    Ok(Bot {
        id: r.get(0)?,
        name: r.get(1)?,
        role: r.get(2)?,
        instructions: r.get(3)?,
        goals: r.get(4)?,
        avatar: r.get(5)?,
        project_id: r.get(6)?,
        provider: r.get(7)?,
        model: r.get(8)?,
        mode: r.get(9)?,
        heartbeat_minutes: r.get(10)?,
        next_heartbeat_at: r.get(11)?,
        paused: r.get(12)?,
        memory_version: r.get(13)?,
        notify_channel_id: r.get(14)?,
        notify_thread: r.get(15)?,
        created_at: r.get(16)?,
        updated_at: r.get(17)?,
        color: r.get(18)?,
        reasoning_effort: r.get(19)?,
        backup_models: serde_json::from_str(&r.get::<_, String>(20)?).unwrap_or_default(),
        fallback_mode: r.get(21)?,
        notify: r.get(22)?,
        while_working: r.get(23)?,
        show_plan: r.get(24)?,
        soul: r.get(25)?,
        skills: serde_json::from_str(&r.get::<_, String>(26)?).unwrap_or_default(),
        mcp: serde_json::from_str(&r.get::<_, String>(27)?).unwrap_or_default(),
    })
}

/// The canonical stored form of a free-text field: control characters stripped, capped.
pub(crate) fn clean(text: &str, limit: usize) -> String {
    text.chars().filter(|c| *c == '\n' || !c.is_control()).take(limit).collect::<String>().trim().to_owned()
}

fn validate(input: &BotInput) -> Result<BotInput> {
    let name = clean(&input.name, 60);
    if name.is_empty() {
        return Err("Give the bot a name.".into());
    }
    if !crate::storage::valid_permission_mode(&input.mode) {
        return Err("Choose a permission mode for the bot.".into());
    }
    if input.model.len() > 200 || !known_provider(&input.provider) {
        return Err("Choose a harness and model for the bot.".into());
    }
    if !(0..=7 * 24 * 60).contains(&input.heartbeat_minutes) {
        return Err("Check-ins run at most once a week and at least every minute.".into());
    }
    if input.soul.len() > MAX_SOUL {
        return Err("The personality is larger than 64 KB. Shorten it and try again.".into());
    }
    let color = input.color.trim();
    if !(color.is_empty() || color.len() == 7 && color.starts_with('#') && color[1..].bytes().all(|c| c.is_ascii_hexdigit())) {
        return Err("Choose a color from the list.".into());
    }
    if input.reasoning_effort.len() > 40 || input.reasoning_effort.chars().any(|c| !(c.is_ascii_alphanumeric() || c == '-' || c == '_')) {
        return Err("Choose a reasoning level from the list.".into());
    }
    if input.backup_models.len() > MAX_BACKUPS || input.backup_models.iter().any(|backup| !known_provider(&backup.provider) || backup.model.is_empty() || backup.model.len() > 200) {
        return Err(format!("Choose up to {MAX_BACKUPS} backup models from installed harnesses."));
    }
    let pick = |value: &str, allowed: &[&str]| if value.is_empty() { Ok(allowed[0].to_owned()) } else if allowed.contains(&value) { Ok(value.to_owned()) } else { Err(String::from("Choose a setting from the list.")) };
    Ok(BotInput {
        name,
        role: clean(&input.role, 200),
        instructions: clean(&input.instructions, MAX_TEXT),
        goals: clean(&input.goals, MAX_TEXT),
        soul: clean(&input.soul, MAX_SOUL),
        avatar: avatar(&input.avatar),
        provider: input.provider.clone(),
        model: input.model.clone(),
        mode: input.mode.clone(),
        heartbeat_minutes: input.heartbeat_minutes,
        color: color.to_ascii_lowercase(),
        reasoning_effort: input.reasoning_effort.clone(),
        backup_models: input.backup_models.clone(),
        fallback_mode: pick(&input.fallback_mode, &["ask", "auto"])?,
        notify: Some(input.notify.unwrap_or(true)),
        while_working: pick(&input.while_working, &["queue", "steer"])?,
        show_plan: input.show_plan,
    })
}

const MAX_BACKUPS: usize = 4;

fn known_provider(provider: &str) -> bool {
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
            | "devin"
            | "zcode"
            | "hermes"
            | "openai-compatible"
    )
}

const MAX_AVATAR: usize = 300_000;

/// A preset panda (`panda:0`..`panda:9`), an uploaded image as a base64 data URL, or a short glyph.
fn avatar(value: &str) -> String {
    let panda = value.strip_prefix("panda:").is_some_and(|n| n.len() == 1 && n.as_bytes()[0].is_ascii_digit());
    let image = value.len() <= MAX_AVATAR
        && ["png", "jpeg", "webp", "gif"].iter().any(|kind| {
            value.strip_prefix(&format!("data:image/{kind};base64,")).is_some_and(|data| {
                !data.is_empty() && data.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'+' | b'/' | b'='))
            })
        });
    if panda || image { value.into() } else { value.chars().take(4).collect() }
}

#[cfg(test)]
mod avatar_tests {
    #[test]
    fn avatars_keep_pandas_and_images_and_trim_glyphs() {
        use super::avatar;
        assert_eq!(avatar("panda:7"), "panda:7");
        assert_eq!(avatar("panda:12"), "pand");
        assert_eq!(avatar("data:image/png;base64,iVBORw0KGgo="), "data:image/png;base64,iVBORw0KGgo=");
        assert_eq!(avatar("data:image/svg+xml;base64,PHN2Zz4="), "data");
        assert_eq!(avatar("data:image/png;base64,<script>"), "data");
        assert_eq!(avatar(&format!("data:image/png;base64,{}", "A".repeat(300_000))), "data");
        assert_eq!(avatar("🐼🐼🐼🐼🐼"), "🐼🐼🐼🐼");
    }
}

/// Adds the `soul` column to a bots table created before it existed (schema 28). Idempotent.
pub(crate) fn migrate_soul(db: &rusqlite::Connection) -> Result<()> {
    let exists: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('bots') WHERE name='soul')", [], |r| r.get(0)).map_err(|e| e.to_string())?;
    if !exists {
        db.execute_batch("ALTER TABLE bots ADD COLUMN soul TEXT NOT NULL DEFAULT '';").map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Adds bot skill and MCP references and the task-to-bot links (schema 29). Idempotent.
pub(crate) fn migrate_capabilities(db: &rusqlite::Connection) -> Result<()> {
    for column in ["skills", "mcp"] {
        let exists: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('bots') WHERE name=?1)", [column], |r| r.get(0)).map_err(|e| e.to_string())?;
        if !exists {
            db.execute_batch(&format!("ALTER TABLE bots ADD COLUMN {column} TEXT NOT NULL DEFAULT '[]' CHECK(json_valid({column}));")).map_err(|e| e.to_string())?;
        }
    }
    db.execute_batch(SCHEMA).map_err(|e| e.to_string())
}

const MAX_REFERENCES: usize = 50;

/// Distinct, bounded references: skill ids are library slugs, MCP names short labels.
fn references(values: &[String], skill: bool) -> Result<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    for value in values.iter().map(|v| v.trim()) {
        let ok = !value.is_empty()
            && value.len() <= if skill { 64 } else { 100 }
            && if skill { value.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-') } else { !value.chars().any(char::is_control) };
        if !ok {
            return Err(format!("{} is not a valid {} name.", value.chars().take(64).collect::<String>(), if skill { "skill" } else { "MCP server" }));
        }
        if !out.iter().any(|v| v == value) {
            out.push(value.to_owned());
        }
    }
    if out.len() > MAX_REFERENCES {
        return Err(format!("A bot can reference up to {MAX_REFERENCES} skills and {MAX_REFERENCES} MCP servers."));
    }
    Ok(out)
}

/// Saves which library skills and configured MCP servers a bot uses. They are part of the brief.
pub(crate) fn set_capabilities(store: &Store, id: &str, skills: &[String], mcp: &[String]) -> Result<Bot> {
    let (skills, mcp) = (references(skills, true)?, references(mcp, false)?);
    get(store, id)?;
    store
        .db
        .execute(
            "UPDATE bots SET skills=?2,mcp=?3,memory_version=memory_version+1,updated_at=?4 WHERE id=?1",
            params![id, serde_json::to_string(&skills).map_err(|e| e.to_string())?, serde_json::to_string(&mcp).map_err(|e| e.to_string())?, crate::storage::now()],
        )
        .map_err(|e| e.to_string())?;
    log(store, id, "updated", "Skills and MCP servers changed", json!({"skills": skills.len(), "mcp": mcp.len()}))?;
    get(store, id)
}

/// Links an ordinary project task to a bot, or unlinks it with `None`. The task keeps its
/// own project and checkout; bot workspaces and bot conversations cannot be linked.
pub(crate) fn assign_task(store: &Store, session_id: &str, bot_id: Option<&str>) -> Result<Option<Bot>> {
    let task = store.session(session_id)?;
    if project_ids(store)?.contains(&task.project_id) {
        return Err("A bot's own conversations already use that bot.".into());
    }
    let Some(bot_id) = bot_id else {
        store.db.execute("DELETE FROM bot_tasks WHERE session_id=?1", [session_id]).map_err(|e| e.to_string())?;
        return Ok(None);
    };
    let bot = get(store, bot_id)?;
    store
        .db
        .execute("INSERT INTO bot_tasks(session_id,bot_id) VALUES(?1,?2) ON CONFLICT(session_id) DO UPDATE SET bot_id=excluded.bot_id,brief_version=-1", params![session_id, bot_id])
        .map_err(|e| e.to_string())?;
    Ok(Some(bot))
}

/// The bot an ordinary task was started with, and the brief version that task has seen.
pub(crate) fn task_bot(store: &Store, session_id: &str) -> Result<Option<(Bot, i64)>> {
    let found: Option<(String, i64)> = store.db.query_row("SELECT bot_id,brief_version FROM bot_tasks WHERE session_id=?1", [session_id], |r| Ok((r.get(0)?, r.get(1)?))).optional().map_err(|e| e.to_string())?;
    found.map(|(bot, seen)| Ok((get(store, &bot)?, seen))).transpose()
}

/// Every task-to-bot link, for the window's context bar.
pub(crate) fn task_links(store: &Store) -> Result<std::collections::HashMap<String, String>> {
    let mut statement = store.db.prepare("SELECT session_id,bot_id FROM bot_tasks").map_err(|e| e.to_string())?;
    let rows = statement.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<_>>().map_err(|e| e.to_string())
}

/// Folder name for a bot workspace: readable, unique per bot.
fn slug(name: &str, id: &str) -> String {
    let base: String = name.chars().map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' }).collect();
    let base = base.split('-').filter(|part| !part.is_empty()).collect::<Vec<_>>().join("-");
    format!("{}-{}", if base.is_empty() { "bot".into() } else { base }, &id[..8])
}

pub(crate) fn workspace_root() -> PathBuf {
    crate::agent_usage_providers::home().unwrap_or_else(std::env::temp_dir).join("PandaCode Bots")
}

pub(crate) fn get(store: &Store, id: &str) -> Result<Bot> {
    store
        .db
        .query_row(&format!("SELECT {BOT_COLUMNS} FROM bots WHERE id=?1"), [id], bot_row)
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "This bot no longer exists.".into())
}

pub(crate) fn list(store: &Store) -> Result<Vec<Bot>> {
    let mut statement = store.db.prepare(&format!("SELECT {BOT_COLUMNS} FROM bots ORDER BY created_at")).map_err(|e| e.to_string())?;
    let rows = statement.query_map([], bot_row).map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<_>>().map_err(|e| e.to_string())
}

/// Creates a bot with its own workspace folder, registered as a project.
pub(crate) fn create(store: &Store, input: &BotInput, root: &std::path::Path) -> Result<Bot> {
    let input = validate(input)?;
    let id = crate::storage::id();
    let folder = root.join(slug(&input.name, &id));
    std::fs::create_dir_all(&folder).map_err(|e| format!("Could not create the bot's workspace: {e}"))?;
    let project = store.add_project(&folder)?;
    // The sidebar shows the bot's name, not its folder's.
    store.db.execute("UPDATE projects SET name=?2 WHERE id=?1", params![project.id, input.name]).map_err(|e| e.to_string())?;
    let now = crate::storage::now();
    store
        .db
        .execute(
            "INSERT INTO bots(id,name,role,instructions,goals,avatar,project_id,provider,model,mode,heartbeat_minutes,next_heartbeat_at,created_at,updated_at,color,reasoning_effort,backup_models,fallback_mode,notify,while_working,show_plan,soul) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?13,?14,?15,?16,?17,?18,?19,?20,?21)",
            params![id, input.name, input.role, input.instructions, input.goals, input.avatar, project.id, input.provider, input.model, input.mode, input.heartbeat_minutes, schedule::heartbeat_after(input.heartbeat_minutes, now), now, input.color, input.reasoning_effort, json!(input.backup_models).to_string(), input.fallback_mode, input.notify, input.while_working, input.show_plan, input.soul],
        )
        .map_err(|e| e.to_string())?;
    log(store, &id, "created", &format!("Created {}", input.name), json!({}))?;
    get(store, &id)
}

pub(crate) fn update(store: &Store, id: &str, input: &BotInput) -> Result<Bot> {
    let input = validate(input)?;
    let before = get(store, id)?;
    let now = crate::storage::now();
    let next = if before.heartbeat_minutes == input.heartbeat_minutes { before.next_heartbeat_at } else { schedule::heartbeat_after(input.heartbeat_minutes, now) };
    // Identity, instructions, goals and soul are part of the brief; bump the version so open threads get them.
    let brief_changed = before.instructions != input.instructions || before.goals != input.goals || before.role != input.role || before.name != input.name || before.show_plan != input.show_plan || before.soul != input.soul;
    store
        .db
        .execute(
            "UPDATE bots SET name=?2,role=?3,instructions=?4,goals=?5,avatar=?6,provider=?7,model=?8,mode=?9,heartbeat_minutes=?10,next_heartbeat_at=?11,memory_version=memory_version+?12,updated_at=?13,color=?14,reasoning_effort=?15,backup_models=?16,fallback_mode=?17,notify=?18,while_working=?19,show_plan=?20,soul=?21 WHERE id=?1",
            params![id, input.name, input.role, input.instructions, input.goals, input.avatar, input.provider, input.model, input.mode, input.heartbeat_minutes, next, brief_changed as i64, now, input.color, input.reasoning_effort, json!(input.backup_models).to_string(), input.fallback_mode, input.notify, input.while_working, input.show_plan, input.soul],
        )
        .map_err(|e| e.to_string())?;
    if before.name != input.name {
        store.db.execute("UPDATE projects SET name=?2 WHERE id=?1", params![before.project_id, input.name]).map_err(|e| e.to_string())?;
    }
    log(store, id, "updated", "Settings changed", json!({}))?;
    let bot = get(store, id)?;
    let session_ids = {
        let mut statement = store.db.prepare("SELECT session_id FROM bot_threads WHERE bot_id=?1 ORDER BY updated_at").map_err(|e| e.to_string())?;
        let rows = statement.query_map([id], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())?
    };
    for session_id in session_ids { sync_thread_profile(store, &bot, &session_id)?; }
    Ok(bot)
}

fn sync_thread_profile(store: &Store, bot: &Bot, session_id: &str) -> Result<()> {
    let session = store.session(session_id)?;
    if matches!(session.status.as_str(), "running" | "waiting") { return Ok(()); }
    if session.provider != bot.provider || session.model != bot.model {
        store.configure(session_id, &bot.provider, &bot.model, None)?;
    }
    store.db.execute("UPDATE sessions SET mode=?2,reasoning_effort=?3 WHERE id=?1", params![session_id,bot.mode,(!bot.reasoning_effort.is_empty()).then_some(bot.reasoning_effort.as_str())]).map_err(|e| e.to_string())?;
    Ok(())
}

pub(crate) fn set_paused(store: &Store, id: &str, paused: bool) -> Result<Bot> {
    store.db.execute("UPDATE bots SET paused=?2,updated_at=?3 WHERE id=?1", params![id, paused, crate::storage::now()]).map_err(|e| e.to_string())?;
    log(store, id, if paused { "paused" } else { "resumed" }, if paused { "Paused" } else { "Resumed" }, json!({}))?;
    get(store, id)
}

/// Reset deletes the bot's conversations, memories, schedules and activity together.
pub(crate) fn reset(store: &Store, id: &str) -> Result<Bot> {
    let bot = get(store, id)?;
    let transaction = store.db.unchecked_transaction().map_err(|e| e.to_string())?;
    let open = shared_channels::open_posts(store, id)?;
    store.db.execute("DELETE FROM sessions WHERE id IN (SELECT session_id FROM bot_threads WHERE bot_id=?1)", [id]).map_err(|e| e.to_string())?;
    shared_channels::settle_posts(store, &open)?;
    for table in ["bot_memories", "bot_schedules", "bot_activity"] {
        store.db.execute(&format!("DELETE FROM {table} WHERE bot_id=?1"), [id]).map_err(|e| e.to_string())?;
    }
    store.db.execute("UPDATE bots SET memory_version=memory_version+1,notify_thread=NULL,updated_at=?2 WHERE id=?1", params![id, crate::storage::now()]).map_err(|e| e.to_string())?;
    transaction.commit().map_err(|e| e.to_string())?;
    log(store, id, "reset", &format!("{} was reset", bot.name), json!({}))?;
    get(store, id)
}

/// Deletes the bot and its records. Its workspace folder stays on disk.
pub(crate) fn delete(store: &Store, id: &str) -> Result<()> {
    let open = shared_channels::open_posts(store, id)?;
    store.db.execute("DELETE FROM sessions WHERE id IN (SELECT session_id FROM bot_threads WHERE bot_id=?1)", [id]).map_err(|e| e.to_string())?;
    let channels: Vec<String> = {
        let mut statement = store.db.prepare("SELECT id FROM bot_channels WHERE bot_id=?1").map_err(|e| e.to_string())?;
        let rows = statement.query_map([id], |r| r.get(0)).map_err(|e| e.to_string())?;
        rows.collect::<rusqlite::Result<_>>().map_err(|e| e.to_string())?
    };
    for channel in channels {
        secrets::remove_all(&channel);
    }
    store.db.execute("DELETE FROM bots WHERE id=?1", [id]).map_err(|e| e.to_string())?;
    shared_channels::settle_posts(store, &open)?;
    Ok(())
}

pub(crate) fn log(store: &Store, bot_id: &str, kind: &str, summary: &str, detail: Value) -> Result<()> {
    store
        .db
        .execute("INSERT INTO bot_activity(bot_id,kind,summary,detail,at) VALUES(?1,?2,?3,?4,?5)", params![bot_id, kind, clean(summary, 300), detail.to_string(), crate::storage::now()])
        .map_err(|e| e.to_string())?;
    // Keep the audit trail bounded per bot.
    store
        .db
        .execute("DELETE FROM bot_activity WHERE bot_id=?1 AND id <= (SELECT id FROM bot_activity WHERE bot_id=?1 ORDER BY id DESC LIMIT 1 OFFSET 5000)", [bot_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub(crate) fn activity(store: &Store, bot_id: &str, before: Option<i64>, limit: i64) -> Result<Vec<Activity>> {
    let mut statement = store
        .db
        .prepare("SELECT id,kind,summary,detail,at FROM bot_activity WHERE bot_id=?1 AND (?2 IS NULL OR id < ?2) ORDER BY id DESC LIMIT ?3")
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map(params![bot_id, before, limit.clamp(1, 200)], |r| {
            Ok(Activity { id: r.get(0)?, kind: r.get(1)?, summary: r.get(2)?, detail: serde_json::from_str(&r.get::<_, String>(3)?).unwrap_or(Value::Null), at: r.get(4)? })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<_>>().map_err(|e| e.to_string())
}

pub(crate) fn memories(store: &Store, bot_id: &str) -> Result<Vec<Memory>> {
    let mut statement = store.db.prepare("SELECT id,content,source,created_at FROM bot_memories WHERE bot_id=?1 ORDER BY created_at").map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([bot_id], |r| Ok(Memory { id: r.get(0)?, content: r.get(1)?, source: r.get(2)?, created_at: r.get(3)? }))
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<_>>().map_err(|e| e.to_string())
}

pub(crate) fn remember(store: &Store, bot_id: &str, content: &str, source: &str) -> Result<Memory> {
    get(store, bot_id)?;
    let content = clean(content, 2000);
    if content.is_empty() {
        return Err("A memory needs some text.".into());
    }
    let count: i64 = store.db.query_row("SELECT COUNT(*) FROM bot_memories WHERE bot_id=?1", [bot_id], |r| r.get(0)).map_err(|e| e.to_string())?;
    if count >= MAX_MEMORIES {
        return Err(format!("A bot keeps up to {MAX_MEMORIES} memories. Remove some first."));
    }
    let duplicate: Option<String> = store.db.query_row("SELECT id FROM bot_memories WHERE bot_id=?1 AND lower(content)=lower(?2)", params![bot_id, content], |r| r.get(0)).optional().map_err(|e| e.to_string())?;
    if let Some(existing) = duplicate {
        return memories(store, bot_id)?.into_iter().find(|memory| memory.id == existing).ok_or_else(|| "Memory not found.".into());
    }
    let id = crate::storage::id();
    let now = crate::storage::now();
    store.db.execute("INSERT INTO bot_memories(id,bot_id,content,source,created_at) VALUES(?1,?2,?3,?4,?5)", params![id, bot_id, content, source, now]).map_err(|e| e.to_string())?;
    store.db.execute("UPDATE bots SET memory_version=memory_version+1 WHERE id=?1", [bot_id]).map_err(|e| e.to_string())?;
    log(store, bot_id, "memory", &format!("Remembered: {}", content.chars().take(120).collect::<String>()), json!({"source": source}))?;
    Ok(Memory { id, content, source: source.into(), created_at: now })
}

pub(crate) fn forget(store: &Store, bot_id: &str, memory_id: &str) -> Result<()> {
    let removed = store.db.execute("DELETE FROM bot_memories WHERE id=?1 AND bot_id=?2", params![memory_id, bot_id]).map_err(|e| e.to_string())?;
    if removed == 0 {
        return Err("That memory was already removed.".into());
    }
    store.db.execute("UPDATE bots SET memory_version=memory_version+1 WHERE id=?1", [bot_id]).map_err(|e| e.to_string())?;
    log(store, bot_id, "memory", "Forgot a memory", json!({}))
}

pub(crate) fn threads(store: &Store, bot_id: &str) -> Result<Vec<Thread>> {
    let mut statement = store.db.prepare("SELECT channel_id,external_id,session_id,updated_at FROM bot_threads WHERE bot_id=?1 ORDER BY updated_at DESC").map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([bot_id], |r| Ok(Thread { channel_id: r.get(0)?, external_id: r.get(1)?, session_id: r.get(2)?, updated_at: r.get(3)? }))
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<_>>().map_err(|e| e.to_string())
}

/// The bot that owns a task, if the task is a bot conversation.
pub(crate) fn owner_of(store: &Store, session_id: &str) -> Result<Option<(Bot, Thread)>> {
    let found: Option<(String, Thread)> = store
        .db
        .query_row("SELECT bot_id,channel_id,external_id,session_id,updated_at FROM bot_threads WHERE session_id=?1", [session_id], |r| {
            Ok((r.get(0)?, Thread { channel_id: r.get(1)?, external_id: r.get(2)?, session_id: r.get(3)?, updated_at: r.get(4)? }))
        })
        .optional()
        .map_err(|e| e.to_string())?;
    match found {
        Some((bot, thread)) => Ok(Some((get(store, &bot)?, thread))),
        None => Ok(None),
    }
}

/// The task for a conversation thread, created on first use in the bot's workspace.
pub(crate) fn thread_session(store: &Store, bot: &Bot, channel_id: &str, external_id: &str, title: &str) -> Result<(String, bool)> {
    let existing: Option<String> = store
        .db
        .query_row("SELECT session_id FROM bot_threads WHERE bot_id=?1 AND channel_id=?2 AND external_id=?3", params![bot.id, channel_id, external_id], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(session) = existing {
        if store.session(&session).is_ok() {
            sync_thread_profile(store, bot, &session)?;
            store.db.execute("UPDATE bot_threads SET updated_at=?2 WHERE session_id=?1", params![session, crate::storage::now()]).map_err(|e| e.to_string())?;
            return Ok((session, false));
        }
        store.db.execute("DELETE FROM bot_threads WHERE session_id=?1", [session]).map_err(|e| e.to_string())?;
    }
    let task = store.create_session(&bot.project_id, &bot.provider, &bot.model, &bot.mode)?;
    store.update(&task.id, Some(clean(title, 120)), None, None, None)?;
    if !bot.reasoning_effort.is_empty() {
        store.db.execute("UPDATE sessions SET reasoning_effort=?2 WHERE id=?1", params![task.id, bot.reasoning_effort]).map_err(|e| e.to_string())?;
    }
    store
        .db
        .execute("INSERT INTO bot_threads(bot_id,channel_id,external_id,session_id,updated_at) VALUES(?1,?2,?3,?4,?5)", params![bot.id, channel_id, external_id, task.id, crate::storage::now()])
        .map_err(|e| e.to_string())?;
    Ok((task.id, true))
}

/// Records that a thread has seen the current brief.
pub(crate) fn mark_briefed(store: &Store, session_id: &str, version: i64) -> Result<()> {
    store.db.execute("UPDATE bot_threads SET brief_version=?2 WHERE session_id=?1", params![session_id, version]).map_err(|e| e.to_string())?;
    Ok(())
}

pub(crate) fn brief_version_of(store: &Store, session_id: &str) -> Result<i64> {
    store.db.query_row("SELECT brief_version FROM bot_threads WHERE session_id=?1", [session_id], |r| r.get(0)).map_err(|e| e.to_string())
}

/// Where proactive messages go: the bot's chosen channel thread, else its latest thread.
pub(crate) fn set_notify_target(store: &Store, bot_id: &str, channel_id: Option<&str>, thread: Option<&str>) -> Result<()> {
    store.db.execute("UPDATE bots SET notify_channel_id=?2,notify_thread=?3 WHERE id=?1", params![bot_id, channel_id, thread]).map_err(|e| e.to_string())?;
    Ok(())
}

/// Project IDs that belong to bots, so ordinary task lists can leave them out.
pub(crate) fn project_ids(store: &Store) -> Result<Vec<String>> {
    let mut statement = store.db.prepare("SELECT project_id FROM bots").map_err(|e| e.to_string())?;
    let rows = statement.query_map([], |r| r.get(0)).map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<_>>().map_err(|e| e.to_string())
}

// --- Desktop commands -------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BotDetail {
    bot: Bot,
    memories: Vec<Memory>,
    schedules: Vec<schedule::Schedule>,
    channels: Vec<channels::Channel>,
    pairings: Vec<channels::Pairing>,
    threads: Vec<Thread>,
    rules: Vec<guard::Rule>,
    /// The local server's port, for web chat links and the WhatsApp webhook URL.
    server_port: u16,
}

fn guard_main(window: &tauri::WebviewWindow) -> Result<()> {
    if window.label() != "main" {
        return Err("Bots are managed from the main window.".into());
    }
    Ok(())
}

/// A bot plus its desktop conversation, for the sidebar.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BotSummary {
    #[serde(flatten)]
    bot: Bot,
    desktop_session: Option<String>,
    /// The latest thing said in the desktop conversation, flattened to one short line for the sidebar.
    pub(crate) last_message: Option<LastMessage>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LastMessage {
    pub role: String,
    pub text: String,
    pub at: i64,
}

const PREVIEW_CHARS: usize = 160;

/// Markdown and whitespace flattened to one line, cut to a sidebar-sized preview.
/// One line of the message as the user saw it: folded context such as the bot brief is left out.
fn preview(content: &str) -> String {
    let plain: String = channels::web::visible(content).chars().filter(|c| !matches!(c, '*' | '_' | '`' | '#' | '>')).collect();
    let line = plain.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.chars().count() <= PREVIEW_CHARS {
        return line;
    }
    let mut cut: String = line.chars().take(PREVIEW_CHARS).collect();
    cut.push('…');
    cut
}

fn last_message(store: &Store, session: &str) -> Result<Option<LastMessage>> {
    store
        .db
        .query_row(
            "SELECT role, substr(content,1,4096), created_at FROM messages WHERE session_id=?1 AND role IN ('user','assistant') AND trim(content)<>'' ORDER BY id DESC LIMIT 1",
            params![session],
            |r| Ok(LastMessage { role: r.get(0)?, text: preview(&r.get::<_, String>(1)?), at: r.get(2)? }),
        )
        .optional()
        .map_err(|e| e.to_string())
}

pub(crate) fn summaries(store: &Store) -> Result<Vec<BotSummary>> {
    list(store)?
        .into_iter()
        .map(|bot| {
            let desktop_session = store
                .db
                .query_row("SELECT session_id FROM bot_threads WHERE bot_id=?1 AND channel_id=?2", params![bot.id, DESKTOP], |r| r.get(0))
                .optional()
                .map_err(|e| e.to_string())?;
            let last_message = match desktop_session.as_deref() { Some(session) => last_message(store, session)?, None => None };
            Ok(BotSummary { bot, desktop_session, last_message })
        })
        .collect()
}

#[tauri::command]
pub async fn bots_list(state: State<'_, AppState>) -> Result<Vec<BotSummary>> {
    summaries(&*state.store.lock().map_err(|e| e.to_string())?)
}

/// The bot's conversation in this app, created on first use, so the sidebar can open it.
#[tauri::command]
pub async fn bot_desktop_thread(app: tauri::AppHandle, state: State<'_, AppState>, bot_id: String) -> Result<String> {
    let (session, created) = {
        let store = state.store.lock().map_err(|e| e.to_string())?;
        let bot = get(&store, &bot_id)?;
        thread_session(&store, &bot, DESKTOP, DESKTOP, &format!("{} · You", bot.name))?
    };
    if created {
        let _ = app.emit("sessions-changed", ());
        let _ = app.emit("bots-changed", ());
    }
    Ok(session)
}

#[tauri::command]
pub async fn bot_detail(state: State<'_, AppState>, bot_id: String) -> Result<BotDetail> {
    let store = state.store.lock().map_err(|e| e.to_string())?;
    Ok(BotDetail {
        bot: get(&store, &bot_id)?,
        memories: memories(&store, &bot_id)?,
        schedules: schedule::list(&store, &bot_id)?,
        channels: channels::list(&store, &bot_id)?,
        pairings: channels::pairings(&store, &bot_id)?,
        threads: threads(&store, &bot_id)?,
        rules: guard::rules(&store, &bot_id)?,
        server_port: channels::http::port(),
    })
}

#[tauri::command]
pub async fn bot_create(app: tauri::AppHandle, window: tauri::WebviewWindow, state: State<'_, AppState>, input: BotInput) -> Result<Bot> {
    guard_main(&window)?;
    let bot = create(&*state.store.lock().map_err(|e| e.to_string())?, &input, &workspace_root())?;
    let _ = app.emit("bots-changed", ());
    Ok(bot)
}

#[tauri::command]
pub async fn bot_update(app: tauri::AppHandle, window: tauri::WebviewWindow, state: State<'_, AppState>, bot_id: String, input: BotInput) -> Result<Bot> {
    guard_main(&window)?;
    let bot = update(&*state.store.lock().map_err(|e| e.to_string())?, &bot_id, &input)?;
    let _ = app.emit("bots-changed", ());
    Ok(bot)
}

#[tauri::command]
pub async fn bot_set_paused(app: tauri::AppHandle, window: tauri::WebviewWindow, state: State<'_, AppState>, bot_id: String, paused: bool) -> Result<Bot> {
    guard_main(&window)?;
    if paused {
        gateway::stop_bot(&app, &bot_id).await;
    }
    let bot = set_paused(&*state.store.lock().map_err(|e| e.to_string())?, &bot_id, paused)?;
    let _ = app.emit("bots-changed", ());
    Ok(bot)
}

#[tauri::command]
pub async fn bot_reset(app: tauri::AppHandle, window: tauri::WebviewWindow, state: State<'_, AppState>, bot_id: String) -> Result<Bot> {
    guard_main(&window)?;
    gateway::stop_bot(&app, &bot_id).await;
    let bot = reset(&*state.store.lock().map_err(|e| e.to_string())?, &bot_id)?;
    let _ = app.emit("bot-shared-channel-changed", json!({}));
    let _ = app.emit("bots-changed", ());
    let _ = app.emit("sessions-changed", ());
    Ok(bot)
}

#[tauri::command]
pub async fn bot_delete(app: tauri::AppHandle, window: tauri::WebviewWindow, state: State<'_, AppState>, bot_id: String) -> Result<()> {
    guard_main(&window)?;
    gateway::stop_bot(&app, &bot_id).await;
    channels::stop_bot_channels(&app, &bot_id).await;
    delete(&*state.store.lock().map_err(|e| e.to_string())?, &bot_id)?;
    let _ = app.emit("bot-shared-channel-changed", json!({}));
    let _ = app.emit("bots-changed", ());
    let _ = app.emit("sessions-changed", ());
    Ok(())
}

#[tauri::command]
pub async fn bot_remember(app: tauri::AppHandle, state: State<'_, AppState>, bot_id: String, content: String) -> Result<Memory> {
    let memory = remember(&*state.store.lock().map_err(|e| e.to_string())?, &bot_id, &content, "user")?;
    let _ = app.emit("bots-changed", ());
    Ok(memory)
}

#[tauri::command]
pub async fn bot_forget(app: tauri::AppHandle, state: State<'_, AppState>, bot_id: String, memory_id: String) -> Result<()> {
    forget(&*state.store.lock().map_err(|e| e.to_string())?, &bot_id, &memory_id)?;
    let _ = app.emit("bots-changed", ());
    Ok(())
}

#[tauri::command]
pub async fn bot_activity(state: State<'_, AppState>, bot_id: String, before: Option<i64>) -> Result<Vec<Activity>> {
    activity(&*state.store.lock().map_err(|e| e.to_string())?, &bot_id, before, 100)
}

#[tauri::command]
pub async fn bot_project_ids(state: State<'_, AppState>) -> Result<Vec<String>> {
    project_ids(&*state.store.lock().map_err(|e| e.to_string())?)
}

/// Sends a message to the bot from the desktop app, in its desktop conversation.
#[tauri::command]
pub async fn bot_message(app: tauri::AppHandle, bot_id: String, text: String, image_ids: Option<Vec<String>>, moodboard_ids: Option<Vec<String>>, force_queue: Option<bool>) -> Result<String> {
    gateway::deliver_with_queue(&app, gateway::Inbound { bot_id, channel_id: DESKTOP.into(), thread: DESKTOP.into(), sender_id: DESKTOP.into(), sender_name: "You".into(), text, trusted: true, image_ids, moodboard_ids }, force_queue.unwrap_or(false)).await
}

#[tauri::command]
pub async fn bot_set_capabilities(app: tauri::AppHandle, window: tauri::WebviewWindow, state: State<'_, AppState>, bot_id: String, skills: Vec<String>, mcp: Vec<String>) -> Result<Bot> {
    guard_main(&window)?;
    let bot = set_capabilities(&*state.store.lock().map_err(|e| e.to_string())?, &bot_id, &skills, &mcp)?;
    let _ = app.emit("bots-changed", ());
    Ok(bot)
}

/// Starts an ordinary task with a bot (or none). The window then applies the bot's harness and model.
#[tauri::command]
pub async fn bot_assign_task(window: tauri::WebviewWindow, state: State<'_, AppState>, session_id: String, bot_id: Option<String>) -> Result<Option<Bot>> {
    guard_main(&window)?;
    assign_task(&*state.store.lock().map_err(|e| e.to_string())?, &session_id, bot_id.as_deref())
}

#[tauri::command]
pub async fn bot_task_links(state: State<'_, AppState>) -> Result<std::collections::HashMap<String, String>> {
    task_links(&*state.store.lock().map_err(|e| e.to_string())?)
}

/// The brief a bot task's next message carries, or nothing when the task has no bot or has
/// seen this version. Skills are the bot's plus the project's, deduplicated by id; the bot's
/// ride in the prompt, so nothing is written into a checkout other tasks may share.
pub(crate) fn task_brief(store: &Store, library: Option<&crate::skills::Library>, session_id: &str) -> Result<Option<String>> {
    let Some((bot, seen)) = task_bot(store, session_id)? else { return Ok(None) };
    if seen == bot.memory_version {
        return Ok(None);
    }
    let task = store.session(session_id)?;
    let root = store.workspace_root(&task.project_id, Some(session_id))?;
    let project = library.map(|l| l.project_active(&task.provider, &root)).unwrap_or_default();
    let resolved = crate::skills::scoped::resolve(&bot.skills, &project);
    let files = crate::skills::scoped::has_skill_folder(&task.provider);
    // Harnesses with skill folders already read the project's; the rest get every skill as text.
    let inline: Vec<String> = resolved.iter().filter(|r| !files || r.provenance == "bot").map(|r| r.id.clone()).collect();
    let installed: Vec<String> = resolved.iter().filter(|r| files && r.provenance != "bot").map(|r| format!("{} ({})", r.id, if r.provenance == "both" { "bot and project" } else { "project" })).collect();
    let (text, skipped) = library.map(|l| l.prompt_text(&inline)).unwrap_or_default();
    let memories = memories(store, &bot.id)?;
    store.db.execute("UPDATE bot_tasks SET brief_version=?2 WHERE session_id=?1", params![session_id, bot.memory_version]).map_err(|e| e.to_string())?;
    Ok(Some(format!("{}{}", brief::compose(&bot, &memories, brief::TASK, ""), brief::skills(&text, &installed, &skipped))))
}

#[tauri::command]
pub async fn bot_task_brief(app: tauri::AppHandle, state: State<'_, AppState>, session_id: String) -> Result<Option<String>> {
    let library = crate::skills::library(&app).ok();
    task_brief(&*state.store.lock().map_err(|e| e.to_string())?, library.as_ref(), &session_id)
}

/// Starts the scheduler and channel connections once the app is ready.
pub(crate) fn start(app: &tauri::AppHandle) {
    // Before the scheduler or any window reads a bot, so older databases have the profile columns.
    let upgraded = app.state::<AppState>().store.lock().map_err(|e| e.to_string()).and_then(|store| { upgrade(&store.db)?; shared_channels::reconcile_in_progress(&store) });
    if let Err(error) = upgraded {
        eprintln!("Could not upgrade the bots table: {error}");
    }
    schedule::start(app.clone());
    channels::start_all(app.clone());
}

/// Called when any task's run ends; replies for bot conversations go back to their channel.
pub(crate) fn run_finished(app: &tauri::AppHandle, session_id: &str, successful: bool) {
    let app = app.clone();
    let session_id = session_id.to_owned();
    tauri::async_runtime::spawn(async move {
        let reply = app.state::<AppState>().store.lock().ok()
            .and_then(|store| shared_channels::latest_reply(&store, &session_id).ok())
            .unwrap_or_default();
        if gateway::run_finished(&app, &session_id, successful).await {
            shared_channels::run_finished(&app, &session_id, successful, &reply).await;
        }
    });
}

/// Called when a run asks for approval; bot conversations forward it to their channel.
pub(crate) fn approval_requested(app: &tauri::AppHandle, session_id: &str, request_id: &str, text: &str) {
    let (app, session_id, request_id, text) = (app.clone(), session_id.to_owned(), request_id.to_owned(), text.to_owned());
    tauri::async_runtime::spawn(async move { gateway::approval_requested(&app, &session_id, &request_id, &text).await });
}

/// Logs activity from async code without holding the store lock across an await.
pub(crate) fn note(app: &tauri::AppHandle, bot_id: &str, kind: &str, summary: &str, detail: Value) {
    let state = app.state::<AppState>();
    let result = state.store.lock().map_err(|e| e.to_string()).and_then(|store| log(&store, bot_id, kind, summary, detail));
    if let Err(error) = result {
        eprintln!("Could not record bot activity: {error}");
    }
}
