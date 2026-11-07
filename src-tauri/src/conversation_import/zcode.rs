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
fn open(db: &Path) -> rusqlite::Result<rusqlite::Connection> {
    rusqlite::Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY)
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

/// A bounded, never blank title; each caller supplies its own fallback.
pub(crate) fn bounded_title(raw: String, fallback: &str) -> String {
    let title = crate::command_operations::clean(&Value::String(raw), 160);
    if title.is_empty() { fallback.to_owned() } else { title }
}

/// Top-level, undeleted conversations, newest first, with their message counts.
/// A store that opens but cannot be read (old schema, corruption, lock) is an
/// error, not an empty list.
pub(crate) fn conversations(db: &Path) -> crate::Result<Vec<Conversation>> {
    let conn = open(db).map_err(|e| e.to_string())?;
    let mut sessions = conn.prepare("SELECT id, directory, title, time_created, time_updated FROM session WHERE time_deleted IS NULL AND parent_id IS NULL AND id NOT LIKE 'sess_subagent_%' ORDER BY time_updated DESC LIMIT 200").map_err(|e| e.to_string())?;
    let mut counts = conn.prepare("SELECT COUNT(*) FROM message WHERE session_id = ?1").map_err(|e| e.to_string())?;
    let rows = sessions.query_map([], |row| {
        Ok(Conversation {
            id: row.get(0)?,
            directory: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
            title: bounded_title(row.get::<_, Option<String>>(2)?.unwrap_or_default(), "Untitled conversation"),
            created_at: row.get::<_, Option<i64>>(3)?.unwrap_or(0),
            updated_at: row.get::<_, Option<i64>>(4)?.unwrap_or(0),
            messages: 0,
        })
    }).map_err(|e| e.to_string())?;
    Ok(rows
        .filter_map(Result::ok)
        .map(|mut conversation| {
            conversation.messages = u32::try_from(counts.query_row(rusqlite::params![conversation.id], |count| count.get::<_, i64>(0)).unwrap_or(0)).unwrap_or(0);
            conversation
        })
        .collect())
}

/// The conversation to import, still present, not deleted and not a subagent.
/// A store that opens but cannot be read is an error, not a missing conversation.
pub(crate) fn conversation(db: &Path, id: &str) -> crate::Result<Option<Conversation>> {
    let conn = open(db).map_err(|e| e.to_string())?;
    match conn.query_row(
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
    ) {
        Ok(conversation) => Ok(Some(conversation)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// The model of the newest assistant message that names one.
/// A failed message query is an error, not no model.
pub(crate) fn model(db: &Path, id: &str) -> crate::Result<Option<String>> {
    let conn = open(db).map_err(|e| e.to_string())?;
    // NULL sequences sort last so pre-trigger rows cannot masquerade as the newest.
    let mut messages = conn
        .prepare("SELECT data FROM message WHERE session_id = ?1 ORDER BY sequence IS NULL, sequence DESC, time_created DESC")
        .map_err(|e| e.to_string())?;
    let rows = messages.query_map(rusqlite::params![id], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())?;
    for data in rows.filter_map(Result::ok) {
        let Ok(data) = serde_json::from_str::<Value>(&data) else { continue };
        if data["role"] == "assistant" {
            let name = crate::command_operations::clean(&data["modelId"], 160);
            if !name.is_empty() {
                return Ok(Some(name));
            }
        }
    }
    Ok(None)
}

/// The readable history, oldest first, bounded like the Claude importer:
/// user and assistant text plus tool names only. Synthetic `runtimeMessage`
/// injections, reasoning, step markers and tool payloads stay out.
pub(crate) fn history(db: &Path, id: &str) -> crate::Result<Vec<Entry>> {
    let conn = open(db).map_err(|e| e.to_string())?;
    // NULL sequences sort last so pre-trigger rows follow their sequenced neighbours.
    let mut messages = conn.prepare("SELECT id, data, time_created FROM message WHERE session_id = ?1 ORDER BY sequence IS NULL, sequence, time_created").map_err(|e| e.to_string())?;
    let rows = messages.query_map(rusqlite::params![id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<i64>>(2)?))).map_err(|e| e.to_string())?;
    let mut parts = conn.prepare("SELECT data FROM part WHERE message_id = ?1 ORDER BY sequence").map_err(|e| e.to_string())?;
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
        let parts = parts.query_map(rusqlite::params![message_id], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())?;
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
    Ok(entries.into())
}

/// Everything an import needs from the store, read up front so the app's
/// store lock stays short.
pub(crate) struct Read {
    pub conversation: Conversation,
    pub entries: Vec<Entry>,
    pub model: Option<String>,
}

pub(crate) fn read(db: &Path, id: &str) -> crate::Result<Option<Read>> {
    let Some(conversation) = conversation(db, id)? else { return Ok(None) };
    Ok(Some(Read { conversation, entries: history(db, id)?, model: model(db, id)? }))
}
