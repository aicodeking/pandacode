//! Reads conversations from ZCode's local store (`~/.zcode/cli/db/db.sqlite`,
//! shared by the ZCode desktop app and the ZCode CLI) for import: summaries
//! for the picker and the readable conversation history.
//! The store is opened read-only and nothing here resumes a session; the saved
//! `sess_<uuid>` id lets the ZCode provider pick the conversation up on the next prompt.

use super::claude::{self, Entry};
use rusqlite::OpenFlags;
use serde_json::Value;
use std::path::{Path, PathBuf};

/// ZCode keeps its conversation database under its home directory.
pub(crate) fn db_path() -> PathBuf {
    crate::agent_usage_providers::home()
        .unwrap_or_else(std::env::temp_dir)
        .join(".zcode")
        .join("cli")
        .join("db")
        .join("db.sqlite")
}

/// Read-only: an import never writes into ZCode's store.
fn open(db: &Path) -> Option<rusqlite::Connection> {
    rusqlite::Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY).ok()
}

/// Whether the store is present and readable.
pub(crate) fn available(db: &Path) -> bool {
    open(db).is_some()
}

#[derive(Debug, PartialEq)]
pub(crate) struct Conversation {
    pub id: String,
    pub title: String,
    pub directory: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub messages: u32,
}

/// Top-level, undeleted conversations, newest first, with their message counts.
pub(crate) fn conversations(db: &Path) -> Vec<Conversation> {
    let Some(conn) = open(db) else { return Vec::new() };
    let Ok(mut sessions) = conn.prepare("SELECT id, directory, title, time_created, time_updated FROM session WHERE time_deleted IS NULL AND parent_id IS NULL AND id NOT LIKE 'sess_subagent_%' ORDER BY time_updated DESC LIMIT 200") else {
        return Vec::new();
    };
    let Ok(mut counts) = conn.prepare("SELECT COUNT(*) FROM message WHERE session_id = ?1") else { return Vec::new() };
    let Ok(rows) = sessions.query_map([], |row| {
        Ok(Conversation {
            id: row.get(0)?,
            directory: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
            title: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
            created_at: row.get::<_, Option<i64>>(3)?.unwrap_or(0),
            updated_at: row.get::<_, Option<i64>>(4)?.unwrap_or(0),
            messages: 0,
        })
    }) else {
        return Vec::new();
    };
    rows.filter_map(Result::ok)
        .map(|mut conversation| {
            conversation.messages = u32::try_from(counts.query_row(rusqlite::params![conversation.id], |count| count.get::<_, i64>(0)).unwrap_or(0)).unwrap_or(0);
            conversation
        })
        .collect()
}

/// The conversation to import, still present, not deleted and not a subagent.
pub(crate) fn conversation(db: &Path, id: &str) -> Option<Conversation> {
    let conn = open(db)?;
    conn.query_row(
        "SELECT id, directory, title, time_created FROM session WHERE id = ?1 AND time_deleted IS NULL AND parent_id IS NULL AND id NOT LIKE 'sess_subagent_%'",
        rusqlite::params![id],
        |row| {
            Ok(Conversation {
                id: row.get(0)?,
                directory: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                title: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                created_at: row.get::<_, Option<i64>>(3)?.unwrap_or(0),
                updated_at: 0,
                messages: 0,
            })
        },
    )
    .ok()
}

/// The model of the newest assistant message that names one.
pub(crate) fn model(db: &Path, id: &str) -> Option<String> {
    let conn = open(db)?;
    let mut messages = conn
        .prepare("SELECT data FROM message WHERE session_id = ?1 ORDER BY sequence DESC, time_created DESC")
        .ok()?;
    let rows = messages.query_map(rusqlite::params![id], |row| row.get::<_, String>(0)).ok()?;
    for data in rows.filter_map(Result::ok) {
        let Ok(data) = serde_json::from_str::<Value>(&data) else { continue };
        if data["role"] == "assistant" {
            let name = crate::command_operations::clean(&data["modelId"], 160);
            if !name.is_empty() {
                return Some(name);
            }
        }
    }
    None
}

/// The readable history, oldest first, bounded like the Claude importer:
/// user and assistant text plus tool names only. Synthetic `runtimeMessage`
/// injections, reasoning, step markers and tool payloads stay out.
pub(crate) fn history(db: &Path, id: &str) -> Vec<Entry> {
    let Some(conn) = open(db) else { return Vec::new() };
    let Ok(mut messages) = conn.prepare("SELECT id, data, time_created FROM message WHERE session_id = ?1 ORDER BY sequence, time_created") else { return Vec::new() };
    let Ok(rows) = messages.query_map(rusqlite::params![id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<i64>>(2)?))) else {
        return Vec::new();
    };
    let Ok(mut parts) = conn.prepare("SELECT data FROM part WHERE message_id = ?1 ORDER BY sequence") else { return Vec::new() };
    let mut entries = std::collections::VecDeque::new();
    let mut push = |entry: Entry| {
        if entries.len() == claude::MAX_ENTRIES {
            entries.pop_front();
        }
        entries.push_back(entry);
    };
    let mut last = 0;
    for (message_id, data, at) in rows.filter_map(Result::ok) {
        let Ok(data) = serde_json::from_str::<Value>(&data) else { continue };
        // Synthetic environment injections are agent plumbing, not conversation.
        if !data["metadata"]["runtimeMessage"].is_null() {
            continue;
        }
        let role = match data["role"].as_str() {
            Some("user") => "user",
            Some("assistant") => "assistant",
            _ => continue,
        };
        let at = at.unwrap_or(last);
        last = at;
        let Ok(parts) = parts.query_map(rusqlite::params![message_id], |row| row.get::<_, String>(0)) else { continue };
        let mut text = Vec::new();
        let mut tools = Vec::new();
        for part in parts.filter_map(Result::ok) {
            let Ok(part) = serde_json::from_str::<Value>(&part) else { continue };
            match part["type"].as_str() {
                Some("text") => text.extend(part["text"].as_str().map(str::to_owned)),
                // Tool payloads live in `state`; only the name is conversation.
                Some("tool") => {
                    let name = crate::command_operations::clean(&part["tool"], 160);
                    if !name.is_empty() {
                        tools.push(format!("Tool: {name}"));
                    }
                }
                _ => {}
            }
        }
        // Like the Claude logs: the turn's text first, then its tool calls.
        let text = claude::bounded(&text.join("\n"));
        if !text.is_empty() {
            push((role, text, at));
        }
        for tool in tools {
            push(("tool", tool, at));
        }
    }
    entries.into()
}
