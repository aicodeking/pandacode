//! Reads Claude Code session logs (`~/.claude/projects/<folder>/<session>.jsonl`)
//! for import: a summary for the picker and the readable conversation history.
//! Tool payloads, file contents and thinking stay out; tools appear by name only.

use serde_json::Value;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

/// Longest message kept from a log, and how many of the latest entries an import keeps.
const MAX_TEXT: usize = 64 * 1024;
pub(crate) const MAX_ENTRIES: usize = 1000;
const MAX_LINE: usize = 8 * 1024 * 1024;

#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Summary {
    pub session_id: String,
    pub title: String,
    pub cwd: String,
    pub messages: u32,
    pub created_at: i64,
    pub updated_at: i64,
    pub model: Option<String>,
}

/// One history entry: role (`user`, `assistant` or `tool`), text, and time in ms.
pub(crate) type Entry = (&'static str, String, i64);

fn millis(entry: &Value) -> Option<i64> {
    let seconds = crate::usage_ledger::unix_seconds(entry["timestamp"].as_str()?)?;
    let fraction = entry["timestamp"].as_str()?.split('.').nth(1).map_or(0, |rest| {
        rest.chars().take_while(char::is_ascii_digit).take(3).collect::<String>().parse::<i64>().unwrap_or(0)
    });
    Some(seconds * 1000 + fraction)
}

pub(crate) fn bounded(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.len() <= MAX_TEXT {
        return trimmed.to_owned();
    }
    let mut end = MAX_TEXT;
    while !trimmed.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n[Truncated during import]", &trimmed[..end])
}

/// Slash-command echoes and local command output are CLI plumbing, not conversation.
fn plumbing(text: &str) -> bool {
    let text = text.trim_start();
    ["<command-name>", "<command-message>", "<local-command-", "<command-args>", "Caveat: The messages below"].iter().any(|prefix| text.starts_with(prefix))
}

/// The readable text of a user or assistant message; `None` for tool results and plumbing.
fn text_of(content: &Value) -> Option<String> {
    let text = match content {
        Value::String(text) => text.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter(|block| block["type"] == "text")
            .filter_map(|block| block["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => return None,
    };
    (!text.trim().is_empty() && !plumbing(&text)).then(|| bounded(&text))
}

fn tools_of(content: &Value) -> Vec<String> {
    content
        .as_array()
        .into_iter()
        .flatten()
        .filter(|block| block["type"] == "tool_use")
        .map(|block| format!("Tool: {}", crate::command_operations::clean(&block["name"], 160)))
        .collect()
}

/// Main-thread messages only: subagent (sidechain) turns and injected meta prompts are skipped.
fn conversational(entry: &Value) -> bool {
    matches!(entry["type"].as_str(), Some("user" | "assistant")) && entry["isSidechain"] != true && entry["isMeta"] != true
}

fn lines(path: &Path) -> impl Iterator<Item = Value> {
    let reader = std::fs::File::open(path).ok().map(|file| BufReader::with_capacity(256 * 1024, file));
    reader.into_iter().flat_map(|reader| {
        reader.split(b'\n').map_while(Result::ok).filter(|line| line.len() <= MAX_LINE).filter_map(|line| serde_json::from_slice::<Value>(&line).ok())
    })
}

/// Summary for the picker, or `None` when the log has no conversation to import.
pub(crate) fn summarize(path: &Path) -> Option<Summary> {
    let mut summary = Summary::default();
    let mut first_prompt = None;
    for entry in lines(path) {
        if summary.session_id.is_empty() {
            if let Some(id) = entry["sessionId"].as_str() {
                summary.session_id = id.to_owned();
            }
        }
        match entry["type"].as_str() {
            Some("ai-title") => summary.title = crate::command_operations::clean(&entry["aiTitle"], 160),
            Some("custom-title") => summary.title = crate::command_operations::clean(&entry["customTitle"], 160),
            _ => {}
        }
        if !conversational(&entry) {
            continue;
        }
        let message = &entry["message"];
        let text = text_of(&message["content"]);
        if text.is_none() {
            continue;
        }
        summary.messages += 1;
        if summary.cwd.is_empty() {
            summary.cwd = entry["cwd"].as_str().unwrap_or_default().to_owned();
        }
        if let Some(at) = millis(&entry) {
            if summary.created_at == 0 {
                summary.created_at = at;
            }
            summary.updated_at = summary.updated_at.max(at);
        }
        if entry["type"] == "user" && first_prompt.is_none() {
            first_prompt = text.map(|text| text.lines().next().unwrap_or_default().chars().take(160).collect::<String>());
        }
        if let Some(model) = message["model"].as_str().filter(|model| model.starts_with("claude")) {
            summary.model = Some(model.to_owned());
        }
    }
    if summary.session_id.is_empty() || summary.messages == 0 || uuid::Uuid::parse_str(&summary.session_id).is_err() {
        return None;
    }
    if summary.title.is_empty() {
        summary.title = first_prompt.filter(|text| !text.trim().is_empty()).unwrap_or_else(|| "Untitled conversation".into());
    }
    Some(summary)
}

/// The latest readable history, oldest first, bounded to [`MAX_ENTRIES`].
pub(crate) fn history(path: &Path) -> Vec<Entry> {
    let mut entries = std::collections::VecDeque::new();
    let mut last = 0;
    for entry in lines(path) {
        if !conversational(&entry) {
            continue;
        }
        let at = millis(&entry).unwrap_or(last);
        last = at;
        let content = &entry["message"]["content"];
        let role = if entry["type"] == "user" { "user" } else { "assistant" };
        let mut push = |item: Entry| {
            if entries.len() == MAX_ENTRIES {
                entries.pop_front();
            }
            entries.push_back(item);
        };
        if let Some(text) = text_of(content) {
            push((role, text, at));
        }
        if role == "assistant" {
            for tool in tools_of(content) {
                push(("tool", tool, at));
            }
        }
    }
    entries.into()
}

/// Session logs in every Claude configuration folder, newest first, excluding subagent logs.
pub(crate) fn logs(roots: &[PathBuf], limit: usize) -> Vec<PathBuf> {
    let mut found: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
    for root in roots {
        let Ok(projects) = std::fs::read_dir(root) else { continue };
        for project in projects.flatten().filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir())) {
            let Ok(files) = std::fs::read_dir(project.path()) else { continue };
            for file in files.flatten() {
                let path = file.path();
                if path.extension().is_some_and(|ext| ext == "jsonl") && file.file_type().is_ok_and(|kind| kind.is_file()) {
                    let modified = file.metadata().and_then(|meta| meta.modified()).unwrap_or(std::time::UNIX_EPOCH);
                    found.push((modified, path));
                }
            }
        }
    }
    found.sort_by_key(|entry| std::cmp::Reverse(entry.0));
    found.into_iter().take(limit).map(|(_, path)| path).collect()
}
