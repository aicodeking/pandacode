//! Direct, bounded stdio adapters. CLI credentials stay with each harness;
//! the optional GLM Coding Plan credential is supplied by native secure storage.
use serde::ser::{SerializeMap, SerializeSeq};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    io::Write,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::{Child, ChildStdin, Command},
    sync::mpsc::UnboundedReceiver,
};

mod attachments;
mod goals;
mod host_inputs;
mod host_tools;
mod mcp_host;
mod warm;
pub use warm::{discard as discard_warm_agent, epoch as warm_epoch, prewarm as prewarm_agent, supported as warms};
use host_tools::apply_step;
pub use host_tools::ToolHost;
pub(crate) mod acp;
pub(crate) mod acp_catalog;
#[cfg(test)]
mod claude_stream_tests;
mod pool;
#[cfg(all(test, unix))]
mod pool_live_tests;
#[cfg(all(test, unix))]
mod pool_run_tests;
#[cfg(test)]
mod codex_stream_tests;
#[cfg(all(test, unix))]
pub(crate) mod concurrent_process_tests;
mod cline;
mod commandcode;
mod extra_models;
mod github_copilot;
mod devin;
pub(crate) mod hermes;
mod glm;
mod mimo;
mod alibaba;
mod muse;
mod deepseek;
mod kimi_models;
mod kilo;
mod launch;
mod pi;
mod zcode;
mod diagnostics;
pub(crate) mod claude_auth;
pub(crate) mod privacy;
pub(crate) use launch::{command, pty_command, std_command, external_path, executable_path, widen_process_path};
#[cfg(test)]
mod kimi_stream_tests;
#[cfg(test)]
mod slash_command_tests;
mod limits;
mod plan_reads;
mod steering;
mod subagents;
mod text_stream;
#[cfg(windows)]
pub(crate) mod windows_job;
pub use subagents::{SubagentActivity, HEARTBEAT};

const MAX_FRAME: usize = 64 * 1024 * 1024;
/// Capacity the frame buffer keeps after a large message has been consumed.
const FRAME_KEEP: usize = 64 * 1024;
const MODEL_CATALOG_LIMIT: usize = 10_000;
const STDERR_LIMIT: usize = 16 * 1024;
/// Time a harness has to answer each startup step (boot, session open or resume, settings).
/// Any frame it sends renews it, so a slow but progressing agent is never cut off.
const STARTUP_STEP: Duration = Duration::from_secs(120);
/// Ceiling on the whole startup, so a chatty agent that never reaches the prompt still ends.
const STARTUP_LIMIT: Duration = Duration::from_secs(300);
/// Wait after closing a finished turn's stdin. Harnesses exit on EOF well within this.
const FINISH_GRACE: Duration = Duration::from_millis(1000);
/// Antigravity ignores EOF and writes context checkpoints in the background (40-80 s each).
const ANTIGRAVITY_GRACE: Duration = Duration::from_secs(120);
/// Under the app data dir: per-run `TEMP` folders of Antigravity on Windows.
const AGENT_TEMP_DIR: &str = "agent-temp";
const AGENT_TEMP_MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);
const TOOL_INPUT_LIMIT: usize = 4096;
const TOOL_OUTPUT_LIMIT: usize = 8192;
const TOOL_CACHE_LIMIT: usize = 64;
const PREVIEW_TRUNCATED: &str = "\n[Preview truncated]";

/// A frame buffer grown past 1 MiB by one large message gives the memory back once drained.
fn should_shrink(len: usize, capacity: usize) -> bool {
    capacity > 1024 * 1024 && len <= FRAME_KEEP / 2
}
pub(crate) const PROVIDERS: [(&str, &str); 20] = [
    ("claude", "Claude Code"),
    ("codex", "Codex"),
    ("kimi", "Kimi Code"),
    ("opencode", "OpenCode"),
    ("glm", "GLM Coding Plan"),
    ("antigravity", "Antigravity"),
    ("grok", "Grok Build"),
    ("mimo", "MiMo Token Plan"),
    ("alibaba", "Alibaba Token Plan"),
    ("pi", "Pi"),
    ("deepseek", "DeepSeek"),
    ("commandcode", "Command Code"),
    ("cline", "Cline"),
    ("kilo", "Kilo Code"),
    ("omp", "Oh My Pi"),
    ("github-copilot", "GitHub Copilot CLI"),
    ("muse", "Muse Code"),
    ("devin", "Devin CLI"),
    ("zcode", "ZCode"),
    ("hermes", "Hermes Agent"),
];

/// Claude Code tools that only report back to a session that stays open after its turn.
pub(crate) const CLAUDE_SESSION_BOUND_TOOLS: &str = "ScheduleWakeup,Monitor,CronCreate";

/// Never runs an agent-reviewed task under some other policy.
fn review_supported(provider: &str, mode: &str) -> Result<(), String> {
    if mode == "review" && !matches!(provider, "claude" | "glm" | "mimo" | "alibaba") {
        return Err("Approve for me needs Claude Code's auto mode; this harness has no agent-reviewed approvals. Choose another access mode.".into());
    }
    Ok(())
}

/// Harnesses that take app instructions as a system prompt (`--append-system-prompt`).
pub fn takes_system_instructions(provider: &str) -> bool {
    matches!(provider, "claude" | "glm" | "mimo" | "alibaba" | "pi" | "omp")
}

#[derive(Clone, Debug)]
pub struct RunConfig {
    pub session_id: String,
    pub provider: String,
    pub model: String,
    pub reasoning_effort: Option<String>,
    pub mode: String,
    pub cwd: PathBuf,
    pub resume_id: Option<String>,
    pub prompt: String,
    /// Fixed app instructions. Claude-family harnesses receive them as an appended system
    /// prompt, which is cached with the rest of the prefix instead of re-sent in every message.
    pub instructions: String,
    /// Exact skill reference resolved from the provider's native command catalog.
    pub skill: Option<(String, PathBuf)>,
    /// A native goal operation starts/resumes the harness goal runtime without
    /// manufacturing an ordinary user prompt.
    pub goal: Option<crate::goal_state::GoalRequest>,
    /// Validated per-task settings applied before any new Codex turn.
    pub codex_settings: Option<Value>,
    /// Only native-validated, managed screenshot paths; never arbitrary web content.
    pub images: Vec<PathBuf>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEvent {
    pub session_id: String,
    pub kind: String,
    pub text: String,
    pub request_id: Option<String>,
    pub data: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool: Option<ToolActivity>,
}

fn explicit_write_paths(name: &str, input: &Value) -> Option<Vec<String>> {
    match name {
        "Write" | "Edit" | "MultiEdit" => Some(input["file_path"].as_str().filter(|p| p.len() <= 4096).map(str::to_owned).into_iter().collect()),
        "NotebookEdit" => Some(input["notebook_path"].as_str().filter(|p| p.len() <= 4096).map(str::to_owned).into_iter().collect()),
        "Bash" | "Command" => Some(vec![]),
        _ => None,
    }
}
fn tool_write_paths(name: &str, input: &str) -> Option<Vec<String>> {
    if matches!(name, "Bash" | "Command") { return Some(vec![]); }
    if !matches!(name, "Write" | "Edit" | "MultiEdit" | "NotebookEdit") { return None; }
    serde_json::from_str(input).ok().and_then(|input| explicit_write_paths(name, &input))
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolActivity {
    pub id: String,
    pub name: String,
    pub status: String,
    pub input: String,
    pub output: String,
    /// Explicit write targets from the provider, never inferred from checkout status.
    /// An empty list denotes a command whose write targets are not reported.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub write_paths: Option<Vec<String>>,
}

// The serializer stops as soon as the preview fills: no multi-megabyte temporary
// String or cloned JSON subtree is built to display a small tool result.
struct Preview {
    bytes: Vec<u8>,
    limit: usize,
    truncated: bool,
}
impl Preview {
    fn new(limit: usize) -> Self {
        Self {
            bytes: Vec::new(),
            limit,
            truncated: false,
        }
    }
    fn text(&mut self, text: &str) {
        let _ = self.write_all(text.as_bytes());
    }
    fn finish(mut self) -> String {
        if self.truncated {
            self.bytes
                .truncate(self.limit.saturating_sub(PREVIEW_TRUNCATED.len()));
        }
        // A bounded byte write may stop inside a Unicode character.
        if let Err(error) = std::str::from_utf8(&self.bytes) {
            self.bytes.truncate(error.valid_up_to());
        }
        let mut text = String::from_utf8(self.bytes).unwrap_or_default();
        if self.truncated {
            text.push_str(PREVIEW_TRUNCATED);
        }
        text
    }
}
impl Write for Preview {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if self.truncated {
            return Err(std::io::Error::other("Preview full"));
        }
        let count = bytes.len().min(self.limit.saturating_sub(self.bytes.len()));
        self.bytes.extend_from_slice(&bytes[..count]);
        if count != bytes.len() {
            self.truncated = true;
            return Err(std::io::Error::other("Preview full"));
        }
        Ok(count)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
fn limited(text: &str, limit: usize) -> String {
    let mut preview = Preview::new(limit);
    preview.text(text);
    preview.finish()
}
fn preview_json(value: &Value, limit: usize) -> String {
    let mut preview = Preview::new(limit);
    if let Some(text) = value.as_str() {
        preview.text(text);
    } else if !value.is_null() {
        let _ = serde_json::to_writer_pretty(&mut preview, &ToolInput(value));
    }
    preview.finish()
}

struct ToolInput<'a>(&'a Value);
impl Serialize for ToolInput<'_> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        const FIRST: &[&str] = &[
            "command",
            "file_path",
            "path",
            "pattern",
            "query",
            "url",
            "description",
        ];
        let Some(object) = self.0.as_object() else {
            return self.0.serialize(serializer);
        };
        let mut map = serializer.serialize_map(Some(object.len()))?;
        for key in FIRST {
            if let Some(value) = object.get(*key) {
                map.serialize_entry(key, value)?;
            }
        }
        for (key, value) in object {
            if !FIRST.contains(&key.as_str()) {
                map.serialize_entry(key, value)?;
            }
        }
        map.end()
    }
}

// Structured results can contain both useful JSON and binary resources. Project
// them while serializing, without cloning the result or exposing opaque metadata.
struct ToolOutput<'a>(&'a Value);
impl Serialize for ToolOutput<'_> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self.0 {
            Value::Object(object) => {
                if matches!(
                    field(self.0, "type"),
                    "image"
                        | "inputImage"
                        | "image_url"
                        | "audio"
                        | "inputAudio"
                        | "video"
                        | "document"
                ) {
                    return serializer.serialize_str("[Non-text content omitted]");
                }
                let mut map = serializer.serialize_map(None)?;
                for (key, value) in object {
                    if !matches!(key.as_str(), "_meta" | "blob" | "base64") {
                        map.serialize_entry(key, &ToolOutput(value))?;
                    }
                }
                map.end()
            }
            Value::Array(items) => {
                let mut sequence = serializer.serialize_seq(Some(items.len()))?;
                for item in items {
                    sequence.serialize_element(&ToolOutput(item))?;
                }
                sequence.end()
            }
            Value::String(value)
                if value.starts_with("data:image/") || value.starts_with("data:audio/") =>
            {
                serializer.serialize_str("[Non-text content omitted]")
            }
            _ => self.0.serialize(serializer),
        }
    }
}
fn output_json(value: &Value, limit: usize) -> String {
    if let Some(text) = value.as_str() {
        return limited(
            if text.starts_with("data:image/") || text.starts_with("data:audio/") {
                "[Non-text content omitted]"
            } else {
                text
            },
            limit,
        );
    }
    let mut preview = Preview::new(limit);
    let _ = serde_json::to_writer_pretty(&mut preview, &ToolOutput(value));
    preview.finish()
}
fn append_preview(target: &mut String, fragment: &str, limit: usize) {
    if target.ends_with(PREVIEW_TRUNCATED) {
        return;
    }
    let mut preview = Preview::new(limit);
    preview.text(target);
    preview.text(fragment);
    *target = preview.finish();
}
fn field<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or_default()
}

/// Name, input and output for Codex app-server items beyond commands, file
/// changes and tool calls. Only named fields are copied, each one bounded.
type CodexItemDetails = (String, Option<String>, Option<String>);
type Fields = serde_json::Map<String, Value>;
const CODEX_ITEM_TEXT_LIMIT: usize = 2048;

fn put_text(target: &mut Fields, key: &str, value: &Value) {
    if let Some(text) = value.as_str().filter(|text| !text.is_empty()) {
        target.insert(key.into(), limited(text, CODEX_ITEM_TEXT_LIMIT).into());
    }
}
fn put_texts(target: &mut Fields, key: &str, value: &Value, count: usize) {
    let Some(values) = value.as_array() else { return; };
    let texts: Vec<Value> = values.iter().filter_map(Value::as_str).take(count)
        .map(|text| limited(text, 512).into()).collect();
    if !texts.is_empty() { target.insert(key.into(), texts.into()); }
}
fn fields_input(fields: Fields) -> Option<String> {
    (!fields.is_empty()).then(|| preview_json(&Value::Object(fields), TOOL_INPUT_LIMIT))
}
fn text_output(value: &Value) -> Option<String> {
    value.as_str().filter(|text| !text.is_empty()).map(|text| limited(text, TOOL_OUTPUT_LIMIT))
}

fn codex_item_details(item: &Value) -> Option<CodexItemDetails> {
    let mut input = Fields::new();
    let (name, output) = match field(item, "type") {
        "imageView" => {
            put_text(&mut input, "path", &item["path"]);
            ("View image".to_owned(), None)
        }
        "webSearch" => {
            put_text(&mut input, "query", &item["query"]);
            let action = &item["action"];
            if action.is_object() {
                let mut summary = Fields::new();
                for key in ["type", "query", "url", "pattern"] { put_text(&mut summary, key, &action[key]); }
                put_texts(&mut summary, "queries", &action["queries"], 8);
                if !summary.is_empty() { input.insert("action".into(), summary.into()); }
            }
            ("web_search".to_owned(), web_search_links(&item["results"]))
        }
        "sleep" => {
            if let Some(ms) = item["durationMs"].as_u64() { input.insert("durationMs".into(), ms.into()); }
            ("sleep".to_owned(), None)
        }
        "collabAgentToolCall" => {
            for key in ["prompt", "model", "reasoningEffort"] { put_text(&mut input, key, &item[key]); }
            put_texts(&mut input, "receiverThreadIds", &item["receiverThreadIds"], 16);
            let tool = limited(field(item, "tool"), 128);
            (if tool.is_empty() { "Agent".into() } else { format!("Agent · {tool}") }, agent_states(&item["agentsStates"]))
        }
        "subAgentActivity" => {
            for key in ["agentPath", "kind", "model", "reasoningEffort"] { put_text(&mut input, key, &item[key]); }
            ("Sub-agent".to_owned(), None)
        }
        "imageGeneration" => {
            put_text(&mut input, "revisedPrompt", &item["revisedPrompt"]);
            let failure = item["failure"].is_object().then(|| limited(field(&item["failure"], "type"), 256));
            ("Generate image".to_owned(), text_output(&item["savedPath"]).or(failure))
        }
        "plan" => ("Plan".to_owned(), text_output(&item["text"])),
        "enteredReviewMode" => {
            put_text(&mut input, "review", &item["review"]);
            ("Review".to_owned(), None)
        }
        "exitedReviewMode" => ("Review".to_owned(), text_output(&item["review"])),
        "functionCallOutput" => {
            let name = limited(field(item, "name"), 128);
            let name = match field(item, "namespace") { "" => name, namespace => format!("{} · {name}", limited(namespace, 128)) };
            let output = item.get("output").filter(|value| !value.is_null()).map(|value| output_json(value, TOOL_OUTPUT_LIMIT));
            (name, output)
        }
        _ => return None,
    };
    Some((name, fields_input(input), output))
}

/// `Links: [{"title","url"}]`, the shape the window's web card reads. The list
/// stops before the bound so the JSON always stays whole.
fn web_search_links(results: &Value) -> Option<String> {
    const PREFIX: &str = "Links: ";
    let mut links = Vec::new();
    let mut bytes = PREFIX.len() + 2;
    for result in results.as_array()?.iter().take(50) {
        let pick = |keys: &[&str]| keys.iter().find_map(|key| result[*key].as_str().filter(|text| !text.is_empty()));
        let Some(url) = pick(&["url", "link", "href"]).filter(|url| url.len() <= 2048) else { continue; };
        let mut link = json!({"title": limited(pick(&["title", "name"]).unwrap_or(url), 256), "url": url});
        if let Some(snippet) = pick(&["snippet", "description"]) { link["snippet"] = limited(snippet, 300).into(); }
        let size = serde_json::to_string(&link).map_or(usize::MAX, |text| text.len() + 1);
        if bytes.saturating_add(size) > TOOL_OUTPUT_LIMIT { break; }
        bytes += size;
        links.push(link);
    }
    (!links.is_empty()).then(|| format!("{PREFIX}{}", Value::Array(links)))
}

fn agent_states(states: &Value) -> Option<String> {
    let states = states.as_object().filter(|states| !states.is_empty())?;
    let mut preview = Preview::new(TOOL_OUTPUT_LIMIT);
    for (index, (thread, state)) in states.iter().take(32).enumerate() {
        if index > 0 { preview.text("\n"); }
        preview.text(&limited(thread, 256));
        preview.text(": ");
        preview.text(field(state, "status"));
        if let Some(message) = state["message"].as_str().filter(|message| !message.is_empty()) {
            preview.text(" — ");
            preview.text(&limited(message, CODEX_ITEM_TEXT_LIMIT));
        }
    }
    Some(preview.finish())
}

fn content_preview(value: &Value, limit: usize) -> String {
    fn content(value: &Value, preview: &mut Preview, depth: usize) {
        if preview.truncated {
            return;
        }
        if depth > 8 {
            preview.text("[Nested content omitted]");
            return;
        }
        match value {
            Value::String(text) => preview.text(text),
            Value::Array(items) => {
                for (index, item) in items.iter().take(128).enumerate() {
                    if index > 0 {
                        preview.text("\n");
                    }
                    content(item, preview, depth + 1);
                    if preview.truncated {
                        break;
                    }
                }
                if items.len() > 128 {
                    preview.truncated = true;
                }
            }
            Value::Object(_) => match field(value, "type") {
                "text" | "inputText" => preview.text(field(value, "text")),
                "content" => content(&value["content"], preview, depth + 1),
                "resource" => {
                    if value["resource"]["text"].is_string() {
                        preview.text(field(&value["resource"], "text"));
                    } else {
                        preview.text("[Binary resource omitted]");
                    }
                }
                "resource_link" => {
                    preview.text(field(value, "name"));
                    preview.text("\n");
                    preview.text(field(value, "uri"));
                }
                "diff" => {
                    preview.text(field(value, "path"));
                    preview.text("\n--- Before\n");
                    preview.text(field(value, "oldText"));
                    preview.text("\n+++ After\n");
                    preview.text(field(value, "newText"));
                }
                "terminal" => {
                    preview.text("Terminal: ");
                    preview.text(field(value, "terminalId"));
                    preview.text(" (output not supplied)");
                }
                _ => preview.text("[Non-text content omitted]"),
            },
            _ => {}
        }
    }
    let mut preview = Preview::new(limit);
    content(value, &mut preview, 0);
    preview.finish()
}

struct PartialTool {
    id: String,
    json: String,
}

pub enum RunInput {
    Stop,
    /// A message for the agent while it works: injected mid-turn where the harness supports it.
    /// The reply is `{"steered":true,"id","mode":"live"|"next-turn"}`; `steer` events follow its delivery.
    Steer {
        id: String,
        text: String,
        reply: tokio::sync::oneshot::Sender<Result<Value, String>>,
    },
    Goal {
        request: crate::goal_state::GoalRequest,
        reply: tokio::sync::oneshot::Sender<Result<Option<crate::goal_state::GoalState>, String>>,
    },
    CodexRequest {
        method: String,
        params: Value,
        reply: tokio::sync::oneshot::Sender<Result<Value, String>>,
    },
    Approval {
        request_id: String,
        approved: bool,
    },
    UserInput {
        request_id: String,
        response: Value,
        reply: Option<tokio::sync::oneshot::Sender<Result<(), String>>>,
    },
}
pub type Sink = Arc<dyn Fn(AgentEvent) + Send + Sync>;

/// How long streamed text may wait before it reaches the window (about one frame at 30 Hz).
pub const COALESCE_WINDOW: Duration = Duration::from_millis(33);
const COALESCE_BYTES: usize = 8 * 1024;

/// Merges consecutive plain `text`/`thinking` deltas into one event, so a long reply is a
/// few dozen window events instead of thousands. Any other event flushes the buffer first,
/// so ordering is preserved.
#[derive(Default)]
pub struct Coalescer {
    pending: Option<(AgentEvent, std::time::Instant)>,
}
impl Coalescer {
    /// Events to emit now, in order. A buffered delta waits until the window or size limit
    /// passes, the next event of another kind, or `flush`.
    pub fn push(&mut self, event: AgentEvent, now: std::time::Instant) -> Vec<AgentEvent> {
        let plain = matches!(event.kind.as_str(), "text" | "thinking")
            && event.request_id.is_none()
            && event.data.is_none()
            && event.tool.is_none();
        let mut out = Vec::new();
        match &mut self.pending {
            Some((buffered, _)) if plain && buffered.kind == event.kind && buffered.session_id == event.session_id => {
                buffered.text.push_str(&event.text);
            }
            _ => {
                out.extend(self.flush());
                if !plain {
                    out.push(event);
                    return out;
                }
                self.pending = Some((event, now));
            }
        }
        if self.pending.as_ref().is_some_and(|(buffered, since)| {
            buffered.text.len() >= COALESCE_BYTES || now.duration_since(*since) >= COALESCE_WINDOW
        }) {
            out.extend(self.flush());
        }
        out
    }
    pub fn flush(&mut self) -> Option<AgentEvent> {
        self.pending.take().map(|(event, _)| event)
    }
    /// When the buffered delta arrived; a timer flushes it only if it is still that buffer.
    pub fn started_at(&self) -> Option<std::time::Instant> {
        self.pending.as_ref().map(|(_, since)| *since)
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
    pub id: String,
    pub name: String,
    pub installed: bool,
    pub path: Option<String>,
    pub version: String,
    pub models: Vec<ModelInfo>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    pub reasoning_efforts: Vec<ReasoningEffortInfo>,
    pub default_reasoning_effort: Option<String>,
    pub context_window: Option<u64>,
    /// Faster service tiers beyond the standard speed (Codex `serviceTiers`, Claude fast mode).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub speed_tiers: Vec<ReasoningEffortInfo>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReasoningEffortInfo {
    pub id: String,
    pub name: String,
    pub description: String,
}

/// Harnesses that take a steering message into the running turn (`RunInput::Steer`) rather than
/// holding it for a new one: Claude-family stream input, Codex `turn/steer`, Pi `steer`, and
/// OpenCode and Devin over ACP.
pub(crate) fn steers_live(provider: &str) -> bool {
    matches!(provider, "claude" | "glm" | "mimo" | "codex" | "pi" | "omp" | "opencode" | "devin")
}

/// The status a run's loop reports when it takes a stop (or pauses a goal on one), so the run's
/// owner knows the stop, not the harness, ended the turn.
pub(crate) const STOPPING_STATUS: &str = "Stopping agent";
pub(crate) const PAUSING_GOAL_STATUS: &str = "Pausing goal";

/// The event a pooled run reports when it moves to another account: the old account's open
/// requests can no longer be answered, so the run's owner settles them (`account_switched`).
pub(crate) const ACCOUNT_SWITCHED: &str = "account_switched";

/// Whether the session's pooled run is changing accounts, so input waits for the next account.
pub(crate) fn switching_accounts(session_id: &str) -> bool {
    pool::switching(session_id)
}

/// The event a run reports when it could not apply an approval decision (`approval_step`).
pub(crate) const UNANSWERED_APPROVAL: &str = "approval_unanswered";
/// Phrases of the startup errors for a reasoning effort a harness refuses (Codex and Claude
/// model checks, the provider-wide check), shared with `architect::model_efforts::rejected`.
pub(crate) const MODEL_REFUSES_EFFORT: &str = "does not support this reasoning effort";
pub(crate) const UNSUPPORTED_EFFORT: &str = "Unsupported reasoning effort";

/// The decline a tool or harness gets when the user declines an approval.
pub(crate) const USER_DECLINE: &str = "Declined by the user";
/// Most decline texts one session keeps (its oldest goes first), so one session's burst of
/// declines never evicts another's; and a safety cap over all sessions.
const DECLINE_REASONS_PER_SESSION: usize = 16;
const DECLINE_REASONS_MAX: usize = 1024;
/// Decline texts PandaCode chose for approvals it answered itself (a team worker's always-ask tool),
/// by session and the harness's approval ID. The tool host returns one instead of `USER_DECLINE`;
/// a user's own decline registers none, so it reads exactly as before. Approval IDs can repeat
/// across runs (Codex host-tool IDs are small integers), so a reason is scoped to its session
/// and a session's reasons are dropped when its run ends (`forget_decline_reasons`).
/// Kept apart from `worker_approvals`' run registry: the tool host claims it inside the run and
/// knows only its session, not the team run.
static DECLINE_REASONS: Mutex<Vec<(String, String, String)>> = Mutex::new(Vec::new());

pub(crate) fn set_decline_reason(session_id: &str, id: &str, reason: &str) {
    let mut reasons = DECLINE_REASONS.lock().unwrap_or_else(|poison| poison.into_inner());
    reasons.retain(|(session, known, _)| !(session == session_id && known == id));
    if reasons.iter().filter(|(session, _, _)| session == session_id).count() >= DECLINE_REASONS_PER_SESSION {
        if let Some(oldest) = reasons.iter().position(|(session, _, _)| session == session_id) {
            reasons.remove(oldest);
        }
    }
    if reasons.len() >= DECLINE_REASONS_MAX {
        reasons.remove(0);
    }
    reasons.push((session_id.to_owned(), id.to_owned(), reason.to_owned()));
}

/// Claims the reason registered for this approval, if any (also on approval, so none is left).
pub(crate) fn take_decline_reason(session_id: &str, id: &str) -> Option<String> {
    let mut reasons = DECLINE_REASONS.lock().unwrap_or_else(|poison| poison.into_inner());
    let index = reasons.iter().position(|(session, known, _)| session == session_id && known == id)?;
    Some(reasons.remove(index).2)
}

/// Drops every reason left for a session (its run ended, so none can be claimed any more).
pub(crate) fn forget_decline_reasons(session_id: &str) {
    DECLINE_REASONS.lock().unwrap_or_else(|poison| poison.into_inner()).retain(|(session, _, _)| session != session_id);
}

/// Sessions whose current run is a team worker's, so PandaCode's own tool hosts refuse the
/// always-ask tools before any approval prompt (the request-text matcher in `worker_approvals`
/// stays as a second line for hosts PandaCode does not run). Each entry is `(session, run)`: a
/// run sets its session's mark as it starts and clears only its own (`RunLeftovers`), so an older
/// run of the same task ending late never clears a newer run's mark.
static WORKER_RUNS: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new());

fn worker_runs() -> std::sync::MutexGuard<'static, Vec<(String, String)>> {
    WORKER_RUNS.lock().unwrap_or_else(|poison| poison.into_inner())
}

/// A run starts: its session's mark becomes this run's (or none, for a run that is not a worker's).
pub(crate) fn mark_worker_run(session_id: &str, run_id: &str, worker: bool) {
    let mut runs = worker_runs();
    runs.retain(|(session, _)| session != session_id);
    if worker {
        runs.push((session_id.to_owned(), run_id.to_owned()));
    }
}

/// A run ends: clears its session's mark only while the mark is still this run's.
pub(crate) fn clear_worker_run(session_id: &str, run_id: &str) {
    worker_runs().retain(|(session, run)| !(session == session_id && run == run_id));
}

/// The refusal a tool host returns when a team worker calls an always-ask tool.
pub(crate) fn worker_tool_refusal(session_id: &str, tool: &str) -> Option<String> {
    let tool = crate::cloud::deploy::ALWAYS_ASK.iter().find(|name| **name == tool)?;
    worker_runs().iter().any(|(session, _)| session == session_id)
        .then(|| crate::worker_approvals::ask_lead_reason(tool))
}

/// The text a declined approval returns: PandaCode's own reason, else the user's decline.
pub(crate) fn decline_text(session_id: &str, id: &str) -> String {
    take_decline_reason(session_id, id).unwrap_or_else(|| USER_DECLINE.into())
}

pub fn validate_reasoning_effort(provider: &str, effort: Option<&str>) -> Result<(), String> {
    let valid = match (provider, effort) {
        (
            "claude" | "codex" | "kimi" | "glm" | "opencode" | "antigravity" | "grok" | "mimo" | "alibaba"
            | "pi" | "deepseek" | "commandcode" | "cline" | "kilo" | "omp" | "github-copilot" | "muse" | "devin" | "zcode" | "hermes",
            None,
        ) => true,
        ("claude" | "glm" | "mimo" | "alibaba", Some(value)) => {
            ["low", "medium", "high", "xhigh", "max"].contains(&value)
        }
        // The current app-server schema deliberately permits catalog-defined effort IDs.
        // Kimi's thinking option lists on/off or the model's levels (low/high/max).
        ("codex" | "kimi" | "opencode" | "antigravity" | "grok" | "deepseek" | "commandcode" | "cline" | "kilo" | "devin" | "zcode" | "hermes", Some(value)) => {
            // grok and cline pass it as an argv value: a leading dash would read as a flag.
            !value.is_empty()
                && !value.starts_with('-')
                && value.len() <= 64
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
        }
        ("pi" | "omp", Some(value)) => ["off", "minimal", "low", "medium", "high", "xhigh"].contains(&value),
        ("muse", Some(value)) => muse::valid_effort(value),
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err(format!("{UNSUPPORTED_EFFORT} for this provider"))
    }
}

fn effort_info(id: &str, description: Option<&str>) -> ReasoningEffortInfo {
    let name = match id {
        "xhigh" => "Extra high".into(),
        "on" => "On".into(),
        "off" => "Off".into(),
        _ => format!("{}{}", id[..1].to_uppercase(), &id[1..]),
    };
    ReasoningEffortInfo {
        id: id.into(),
        name,
        description: model_text(description, "", 500),
    }
}

impl ModelInfo {
    fn default_choice() -> Self {
        Self {
            id: "default".into(),
            name: "Default".into(),
            description: "Use the model configured in the CLI".into(),
            reasoning_efforts: Vec::new(),
            default_reasoning_effort: None,
            context_window: None,
            speed_tiers: Vec::new(),
        }
    }
}

pub(crate) fn executable(name: &str) -> Option<PathBuf> {
    if let Some(path) = crate::provider_settings::executable_override(name) {
        return Some(path);
    }
    launch::find(executable_name(name))
        .or_else(|| if name == "hermes" { launch::find("hermes-acp") } else if name == "devin" { devin::bundled() } else if name == "zcode" { zcode::bundled() } else if name == "antigravity" { launch::find("agy") } else { None })
}

/// Starts a provider CLI with the provider's saved environment variables applied.
/// Everything else a launch adds (credentials, endpoints, a named connection)
/// is applied later and wins.
pub(crate) fn provider_command(provider: &str, path: &Path) -> Result<Command, String> {
    let mut command = command(path)?;
    crate::provider_settings::apply_environment(provider, &mut command);
    Ok(command)
}

fn executable_name(name: &str) -> &str {
    match name {
        "glm" | "mimo" | "alibaba" => "claude",
        "antigravity" if cfg!(windows) => "agy_acp_server",
        "antigravity" => "agy_acp_server.par",
        "deepseek" => "dsh",
        "commandcode" => "command-code",
        "github-copilot" => "copilot",
        "hermes" => "hermes",
        other => other,
    }
}

/// Any command-line tool (`gh`, `git`…) where an interactive shell would find it, even
/// when PandaCode was opened from Finder or the Dock with a minimal PATH.
pub(crate) fn tool_path(name: &str) -> Option<std::path::PathBuf> {
    launch::find(name)
}

pub(crate) fn sweep_cline_mcp_settings(data: &Path) {
    cline::sweep_mcp_settings(data);
}

pub(crate) fn opencode_configuration(mode: &str) -> String {
    acp::configuration(mode)
}

/// The saved Command Code key for discovery paths that build their own process.
pub(crate) fn commandcode_key_environment(command: &mut Command) -> Option<String> {
    commandcode::key_environment(command)
}

/// Muse Code's process sandbox flags for a PandaCode mode, shared with its console.
pub(crate) fn muse_sandbox_args(mode: &str) -> &'static [&'static str] {
    muse::sandbox_args(mode)
}

pub(crate) fn grok_permission_mode(mode: &str) -> &'static str {
    acp::grok_permission_mode(mode)
}

/// Devin's commands for a project, from a discovery session it deletes afterwards.
pub(crate) async fn devin_commands(path: &Path, cwd: &Path) -> Result<Option<Value>, String> {
    devin::commands(path, cwd).await
}

pub(crate) use devin::HIDDEN_COMMANDS as DEVIN_HIDDEN_COMMANDS;

pub(crate) fn glm_arguments() -> Vec<String> {
    glm::arguments()
}

pub(crate) fn glm_environment() -> Result<Vec<(String, String)>, String> {
    glm::environment()
}

pub(crate) fn mimo_arguments() -> Result<Vec<String>, String> {
    mimo::saved_arguments()
}

pub(crate) fn mimo_environment() -> Result<Vec<(String, String)>, String> {
    mimo::environment()
}

pub(crate) fn alibaba_arguments() -> Vec<String> {
    alibaba::arguments()
}

pub(crate) fn alibaba_environment() -> Result<Vec<(String, String)>, String> {
    alibaba::environment()
}

pub(crate) fn mimo_endpoint_url(id: &str) -> Option<&'static str> {
    mimo::endpoint_url(id)
}

pub(crate) fn mimo_endpoints() -> &'static [(&'static str, &'static str, &'static str)] {
    &mimo::ENDPOINTS
}

fn version(path: &Path) -> Option<String> {
    capture(launch::std_command(path).ok()?, &["--version"], Duration::from_secs(2))
        .map(|text| text.chars().take(150).collect())
}

/// Whether this Claude CLI takes `--include-hook-events` (absent in 2.1.0, present by 2.1.100):
/// an unknown flag ends the CLI at launch. Answered once per binary, so an update asks again. A
/// cloud harness's placeholder program answers no: its machine's CLI is unknown, and a
/// longer grace covers it there.
fn claude_lists_hook_events(command: &Command) -> bool {
    let command = command.as_std();
    let program = Path::new(command.get_program());
    let key = std::fs::canonicalize(program).unwrap_or_else(|_| program.to_owned());
    hook_events_answer(key, || {
        let mut probe = std::process::Command::new(program);
        probe.args(command.get_args());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            probe.creation_flags(0x08000000);
        }
        capture(probe, &["--help"], Duration::from_secs(2))
    })
}

/// The answer for this binary: remembered, else `help` (None when it timed out or failed to spawn).
fn hook_events_answer(key: PathBuf, help: impl FnOnce() -> Option<String>) -> bool {
    static KNOWN: std::sync::LazyLock<Mutex<HashMap<PathBuf, bool>>> = std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
    static PROBING: Mutex<()> = Mutex::new(());
    let known = |key: &Path| KNOWN.lock().ok().and_then(|known| known.get(key).copied());
    if let Some(known) = known(&key) {
        return known;
    }
    // The caller is an async run start, so the wait leaves the runtime's thread free. Parallel first
    // runs take turns and reuse the answer.
    // ponytail: one lock for every binary; a CLI that never answers delays N parallel starts by 2 s each.
    crate::blocking_snapshot(|| {
        let _turn = PROBING.lock();
        if let Some(known) = known(&key) {
            return known;
        }
        // A timeout says nothing about the CLI, so only an answer is remembered. A CLI that never
        // answers costs each run's start 2 s; one that fails to spawn fails at once.
        let Some(help) = help() else {
            return false;
        };
        let listed = help.contains("--include-hook-events");
        if let Ok(mut known) = KNOWN.lock() {
            known.insert(key.clone(), listed);
        }
        listed
    })
}

/// Runs an installed provider's CLI and returns its stdout (up to 2 MiB); None when the
/// provider is not installed or the command failed or stalled past `timeout`. Runs with the
/// provider's saved environment, so a custom data dir reads the same store as its runs.
pub(crate) fn run_provider(id: &str, args: &[&str], timeout: Duration) -> Option<String> {
    let mut command = launch::std_command(&executable(id)?).ok()?;
    crate::provider_settings::apply_environment(id, &mut command);
    capture(command, args, timeout)
}

fn capture(mut command: std::process::Command, args: &[&str], timeout: Duration) -> Option<String> {
    let mut child = command
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    #[cfg(windows)]
    let _job = windows_job::Job::attach(child.id());
    // Drained on its own thread: a child writing past the OS pipe buffer while we poll
    // must not block forever on the write (read only after exit would never drain it).
    let mut piped = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        use std::io::Read as _;
        let _ = piped.read_to_end(&mut bytes);
        bytes
    });
    let deadline = std::time::Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    if !status.success() {
        return None;
    }
    let mut bytes = reader.join().ok()?;
    bytes.truncate(2 * 1024 * 1024);
    Some(String::from_utf8_lossy(&bytes).trim().to_owned())
}

/// Blocking discovery; invoke on a worker thread, not the UI event loop.
pub fn discover() -> Vec<ProviderInfo> {
    PROVIDERS.into_iter()
    .map(|(id, name)| {
        let path = executable(id);
        ProviderInfo {
            id: id.into(),
            name: name.into(),
            installed: path.is_some(),
            version: if id == "antigravity" {
                "ACP".into()
            } else {
                path.as_deref().and_then(version).unwrap_or_default()
            },
            path: path.map(|p| p.to_string_lossy().into_owned()),
            models: if id == "glm" {
                glm::models()
            } else if id == "mimo" {
                mimo::models()
            } else if id == "alibaba" {
                alibaba::models()
            } else if id == "opencode" {
                selected_opencode_models(
                    Vec::new(),
                    &crate::provider_settings::opencode_model_ids().unwrap_or_default(),
                )
            } else {
                vec![ModelInfo::default_choice()]
            },
        }
    })
    .collect()
}

/// On-demand metadata only: no user prompt or inference. ACP-only servers may
/// create an empty session to advertise their scoped model options.
pub async fn list_models(provider: &str) -> Result<Vec<ModelInfo>, String> {
    if provider == "opencode" {
        // A saved Settings selection narrows the picker; without one, list the
        // whole catalog like every other harness.
        let selected = crate::provider_settings::opencode_model_ids()?;
        if !selected.is_empty() {
            // Keep saved choices usable during temporary discovery failures. The
            // Settings catalog reports the error and allows an explicit refresh.
            let catalog = list_model_catalog(provider).await.unwrap_or_default();
            return Ok(selected_opencode_models(catalog, &selected));
        }
    }
    list_model_catalog(provider).await
}

fn model_discovery_index(provider: &str) -> Option<usize> {
    PROVIDERS
        .iter()
        .position(|(id, _)| *id == provider)
}

fn model_discovery_semaphores(
) -> &'static [tokio::sync::Semaphore; PROVIDERS.len()] {
    static DISCOVERY: OnceLock<[tokio::sync::Semaphore; PROVIDERS.len()]> = OnceLock::new();
    DISCOVERY.get_or_init(|| std::array::from_fn(|_| tokio::sync::Semaphore::new(1)))
}

fn selected_opencode_models(catalog: Vec<ModelInfo>, selected: &[String]) -> Vec<ModelInfo> {
    let mut available: HashMap<_, _> = catalog
        .into_iter()
        .map(|model| (model.id.clone(), model))
        .collect();
    let mut models = vec![ModelInfo::default_choice()];
    for id in selected {
        models.push(available.remove(id).unwrap_or_else(|| ModelInfo {
            speed_tiers: Vec::new(),
            id: id.clone(),
            name: id.clone(),
            description: "Saved OpenCode model".into(),
            reasoning_efforts: Vec::new(),
            default_reasoning_effort: None,
            context_window: None,
        }));
    }
    models
}

/// `1.19.0` from v1, `opencode v2.2.5` from v2.
fn opencode_major_version(version: &str) -> Option<u64> {
    version
        .split_whitespace()
        .find_map(|word| word.trim_start_matches('v').split('.').next()?.parse().ok())
}

/// OpenCode v2 removed `models --verbose`, but its local API still reports each
/// model's variants. Only v2 gets this command: v1 has no `api` subcommand.
async fn opencode_catalog(path: &Path) -> Result<Vec<ModelInfo>, String> {
    let owned = path.to_owned();
    // Longer than `version()`'s 2 s: OpenCode's cold start can pass that, and a missed
    // answer here would cost a v2 install its efforts.
    let major = tokio::task::spawn_blocking(move || capture(launch::std_command(&owned).ok()?, &["--version"], Duration::from_secs(5)))
        .await
        .ok()
        .flatten()
        .as_deref()
        .and_then(opencode_major_version);
    if major.is_some_and(|major| major >= 2) {
        match opencode_v2_catalog(path).await {
            Ok(models) => return Ok(models),
            // A hung CLI would hang again; anything else falls back to the bare IDs.
            Err(error) if error.contains("timed out") => return Err("OpenCode model discovery timed out".into()),
            Err(_) => {}
        }
    }
    extra_models::opencode(path).await
}

async fn opencode_v2_catalog(path: &Path) -> Result<Vec<ModelInfo>, String> {
    #[cfg(test)]
    let app_data = std::env::temp_dir().join("pandacode-test-app-data");
    #[cfg(test)]
    let app_data = Some(app_data.as_path());
    #[cfg(not(test))]
    let app_data = crate::secret_store::dir();
    opencode_v2_catalog_in(path, app_data).await
}

async fn opencode_v2_catalog_in(path: &Path, app_data: Option<&Path>) -> Result<Vec<ModelInfo>, String> {
    const OUTPUT_LIMIT: usize = 16 * 1024 * 1024;
    let mut command = launch::std_command(path)?;
    crate::provider_settings::apply_environment("opencode", &mut command);
    // OpenCode reads config from its directory, and anyone can plant one in a shared temp folder.
    let folder = app_data
        .and_then(|dir| AgentTemp::create_in(&dir.join(AGENT_TEMP_DIR)))
        .ok_or("Could not create a private folder for OpenCode discovery")?;
    // A private server, so listing models leaves no background service behind.
    command
        .args(["--standalone", "api", "model.list", "--param"])
        .arg(format!("directory={}", folder.0.display()))
        .current_dir(&folder.0);
    let mut output = tokio::task::spawn_blocking(move || {
        crate::workspace::run_process(command, "OpenCode", OUTPUT_LIMIT, Duration::from_secs(15))
    })
    .await
    .map_err(|_| "OpenCode discovery failed")??;
    let parsed = if output.status.success() && !output.stdout.truncated {
        parse_opencode_v2_models(&output.stdout.bytes)
    } else {
        Err("OpenCode could not load models. Check its provider login and configuration.".into())
    };
    // The response carries provider settings, which can hold configured API keys.
    output.stdout.bytes.fill(0);
    parsed
}

/// Whitelist fields: entries also carry `settings` and `headers` from the user's
/// configuration, which must never cross into the webview.
fn parse_opencode_v2_models(bytes: &[u8]) -> Result<Vec<ModelInfo>, String> {
    const INVALID: &str = "Invalid OpenCode model catalog";
    let response: Value = serde_json::from_slice(bytes).map_err(|_| INVALID)?;
    let entries = response["data"].as_array().ok_or(INVALID)?;
    if entries.len() > MODEL_CATALOG_LIMIT {
        return Err("OpenCode returned too many models".into());
    }
    let mut models = entries
        .iter()
        .map(|entry| {
            let (provider, model) = (entry["providerID"].as_str().unwrap_or_default(), entry["id"].as_str().unwrap_or_default());
            let id = format!("{provider}/{model}");
            if provider.is_empty() || model.is_empty() || !valid_model_id(&id) {
                return Err(INVALID.to_owned());
            }
            Ok(ModelInfo {
                speed_tiers: Vec::new(),
                name: model_text(entry["name"].as_str(), &id, 160),
                description: id.clone(),
                // The API lists variants least to most, unlike v1's sorted keys.
                reasoning_efforts: entry["variants"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|variant| variant["id"].as_str())
                    .filter(|effort| validate_reasoning_effort("opencode", Some(effort)).is_ok())
                    .take(20)
                    .map(|effort| effort_info(effort, None))
                    .collect(),
                default_reasoning_effort: None,
                context_window: entry["limit"]["context"].as_u64().filter(|n| *n > 0 && *n <= 1_000_000_000),
                id,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    // `opencode models` sorts by ID; the API orders by release date.
    models.sort_by(|a, b| a.id.cmp(&b.id));
    models.dedup_by(|a, b| a.id == b.id);
    models.insert(0, ModelInfo::default_choice());
    Ok(models)
}

pub(crate) async fn list_model_catalog(provider: &str) -> Result<Vec<ModelInfo>, String> {
    let index = model_discovery_index(provider).ok_or("Unknown provider")?;
    let semaphore = &model_discovery_semaphores()[index];
    let _permit = if matches!(
        provider,
        "opencode" | "antigravity" | "grok" | "deepseek" | "commandcode" | "cline" | "kilo" | "github-copilot" | "muse" | "devin" | "zcode" | "hermes"
    ) {
        // Saving models refreshes both windows. Queue their bounded metadata
        // queries so one window does not cache incomplete ID-only fallbacks.
        tokio::time::timeout(Duration::from_secs(if provider == "opencode" { 20 } else { 65 }), semaphore.acquire())
            .await
            .map_err(|_| "Model discovery is busy. Try again shortly.".to_owned())?
            .map_err(|_| "Model discovery is unavailable".to_owned())?
    } else {
        semaphore
            .try_acquire()
            .map_err(|_| "Model discovery is already running".to_owned())?
    };
    let path = executable(provider).ok_or("Provider CLI is not installed or is not on PATH")?;
    match provider {
        "claude" => claude_models(&path).await,
        "codex" => codex_models(&path).await,
        "kimi" => kimi_models::list(&path).await,
        "opencode" => opencode_catalog(&path).await,
        "glm" => Ok(glm::models()),
        "antigravity" => acp::models(&path).await,
        "grok" => acp::grok_models(&path).await,
        "mimo" => Ok(mimo::models()),
        "alibaba" => Ok(alibaba::models()),
        "pi" | "omp" => pi::models(&path, provider).await,
        "deepseek" => deepseek::models(&path).await,
        "commandcode" => commandcode::models(&path).await,
        "cline" => cline::models(&path).await,
        "kilo" => kilo::models(&path).await,
        "github-copilot" => github_copilot::models(&path).await,
        "muse" => muse::models(&path).await,
        "devin" => devin::models(&path).await,
        "zcode" => zcode::models(&path).await,
        "hermes" => hermes::models(&path).await,
        _ => unreachable!(),
    }
}

fn valid_model_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 200 && !id.chars().any(char::is_control)
}

fn model_text(value: Option<&str>, fallback: &str, limit: usize) -> String {
    let text: String = value
        .unwrap_or_default()
        .chars()
        .filter(|c| !c.is_control())
        .take(limit)
        .collect();
    if text.trim().is_empty() {
        fallback.into()
    } else {
        text.trim().into()
    }
}

fn parse_codex_models(result: &Value) -> Result<Vec<ModelInfo>, String> {
    let entries = result["data"]
        .as_array()
        .ok_or("Codex returned an invalid model catalog")?;
    if entries.len() > 100 {
        return Err("Codex model catalog exceeded the requested page size".into());
    }
    let mut models = vec![ModelInfo::default_choice()];
    for entry in entries {
        if entry["hidden"] == true {
            continue;
        }
        let model = entry["model"].as_str().or_else(|| entry["id"].as_str());
        if let Some(model) = model.filter(|model| valid_model_id(model)) {
            if !models.iter().any(|m| m.id == model) {
                let mut efforts = Vec::new();
                for option in entry["supportedReasoningEfforts"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .take(32)
                {
                    if let Some(id) = option["reasoningEffort"]
                        .as_str()
                        .filter(|id| validate_reasoning_effort("codex", Some(id)).is_ok())
                    {
                        if !efforts
                            .iter()
                            .any(|effort: &ReasoningEffortInfo| effort.id == id)
                        {
                            efforts.push(effort_info(id, option["description"].as_str()));
                        }
                    }
                }
                let default_effort = entry["defaultReasoningEffort"]
                    .as_str()
                    .filter(|id| efforts.iter().any(|effort| effort.id == *id))
                    .map(str::to_owned);
                models.push(ModelInfo {
                    id: model.into(),
                    name: model_text(
                        entry["displayName"]
                            .as_str()
                            .or_else(|| entry["name"].as_str()),
                        model,
                        200,
                    ),
                    description: model_text(entry["description"].as_str(), "", 1000),
                    reasoning_efforts: efforts,
                    default_reasoning_effort: default_effort,
                    // model/list does not report the effective window. Live usage does.
                    context_window: None,
                    speed_tiers: codex_speed_tiers(&entry["serviceTiers"]),
                });
            }
        }
    }
    Ok(models)
}

/// Every tier Codex reports, so new ones (Ultra Fast) appear without a release.
fn codex_speed_tiers(tiers: &Value) -> Vec<ReasoningEffortInfo> {
    let mut found: Vec<ReasoningEffortInfo> = Vec::new();
    for tier in tiers.as_array().into_iter().flatten().take(8) {
        let Some(id) = tier["id"].as_str().filter(|id| valid_service_tier(id)) else { continue };
        if !found.iter().any(|known| known.id == id) {
            found.push(ReasoningEffortInfo {
                id: id.into(),
                name: model_text(tier["name"].as_str(), id, 64),
                description: model_text(tier["description"].as_str(), "", 500),
            });
        }
    }
    found
}

pub(crate) fn valid_service_tier(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && !id.chars().any(char::is_control)
}

// SDK displayName can still be just "Sonnet". Format the provider's resolved
// wire ID instead; never assign a release version to an unresolved alias.
fn claude_model_name(entry: &Value, id: &str) -> String {
    let resolved = entry["resolvedModel"]
        .as_str()
        .filter(|id| valid_model_id(id));
    if let Some(resolved) = resolved {
        let (base, suffix) = resolved
            .strip_suffix("[1m]")
            .map(|id| (id, " (1M context)"))
            .unwrap_or((resolved, ""));
        if let Some(model) = base.strip_prefix("claude-") {
            let mut parts: Vec<&str> = model.split('-').collect();
            if parts
                .last()
                .is_some_and(|part| part.len() == 8 && part.chars().all(|c| c.is_ascii_digit()))
            {
                parts.pop(); // Snapshot date is an invocation detail, not the release version.
            }
            if parts.len() >= 2
                && matches!(parts[0], "sonnet" | "opus" | "haiku" | "fable")
                && parts[1..]
                    .iter()
                    .all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()))
            {
                let family = format!("{}{}", parts[0][..1].to_uppercase(), &parts[0][1..]);
                return format!(
                    "{}Claude {family} {}{suffix}",
                    if id == "default" { "Default · " } else { "" },
                    parts[1..].join(".")
                );
            }
        }
        // Future/custom model formats stay exact instead of being guessed.
        return resolved.into();
    }
    let name = model_text(entry["displayName"].as_str(), id, 200);
    if matches!(name.as_str(), "Sonnet" | "Opus" | "Haiku" | "Fable") {
        format!("Claude {name}")
    } else {
        name
    }
}

fn parse_claude_models(result: &Value) -> Result<Vec<ModelInfo>, String> {
    let entries = result["models"].as_array().ok_or(
        "Claude did not return a model catalog; update the CLI or enter a custom model ID",
    )?;
    if entries.len() > 100 {
        return Err("Claude model catalog is too large".into());
    }
    let mut models = vec![ModelInfo::default_choice()];
    let mut seen = HashSet::new();
    for entry in entries {
        let Some(id) = entry["value"].as_str().filter(|id| valid_model_id(id)) else {
            continue;
        };
        if !seen.insert(id) {
            continue;
        }
        let model = ModelInfo {
            // Claude Code's catalog flags the models it can run in fast mode.
            speed_tiers: if entry["supportsFastMode"] == true {
                vec![ReasoningEffortInfo { id: "fast".into(), name: "Fast".into(), description: "Claude Code fast mode: faster output at a higher price.".into() }]
            } else {
                Vec::new()
            },
            id: id.into(),
            name: claude_model_name(entry, id),
            description: model_text(entry["description"].as_str(), "", 1000),
            reasoning_efforts: if entry["supportsEffort"] == false {
                Vec::new()
            } else {
                let mut efforts = Vec::new();
                for id in entry["supportedEffortLevels"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .take(16)
                {
                    if validate_reasoning_effort("claude", Some(id)).is_ok()
                        && !efforts
                            .iter()
                            .any(|effort: &ReasoningEffortInfo| effort.id == id)
                    {
                        efforts.push(effort_info(id, None));
                    }
                }
                efforts
            },
            default_reasoning_effort: None,
            context_window: entry["contextWindow"]
                .as_u64()
                .filter(|window| *window > 0 && *window <= 1_000_000_000),
        };
        if id == "default" {
            models[0] = model;
        } else {
            models.push(model);
        }
    }
    Ok(models)
}

/// Claude's initialize reply carries its commands, agents and models in one
/// line, which can pass 256 KiB with many skills or plugins (#276).
const CLAUDE_INIT_FRAME: usize = 4 * 1024 * 1024;

async fn read_claude_models(stdout: &mut (impl tokio::io::AsyncRead + Unpin)) -> Result<Vec<ModelInfo>, String> {
    let mut bytes = Vec::new();
    let mut buffer = vec![0u8; 64 * 1024];
    let mut total = 0;
    loop {
        let count = stdout.read(&mut buffer).await.map_err(|e| format!("Claude model stream failed: {e}"))?;
        if count == 0 { return Err("Claude exited before returning its model catalog; update the CLI or enter a custom model ID".into()); }
        total += count;
        if total > 2 * CLAUDE_INIT_FRAME { return Err("Claude model discovery exceeded its output limit".into()); }
        // Only the new bytes can hold a newline: rescanning the held partial
        // frame on every read would be quadratic in a multi-megabyte frame.
        let scan = bytes.len();
        bytes.extend_from_slice(&buffer[..count]);
        let mut consumed = 0;
        for end in bytes[scan..].iter().enumerate().filter_map(|(i, byte)| (*byte == b'\n').then_some(scan + i)) {
            let line = &bytes[consumed..end]; consumed = end + 1;
            if line.len() > CLAUDE_INIT_FRAME { return Err("Claude model catalog frame is too large".into()); }
            if line.iter().all(u8::is_ascii_whitespace) { continue; }
            let message: Value = serde_json::from_slice(line).map_err(|_| "Claude returned invalid model discovery JSON")?;
            if message["type"] != "control_response" || message["response"]["request_id"] != "pandacode-models" { continue; }
            let response = &message["response"];
            if response["subtype"] != "success" { return Err("Claude could not load its model catalog; check the CLI or enter a custom model ID".into()); }
            return parse_claude_models(&response["response"]);
        }
        bytes.drain(..consumed);
        if bytes.len() > CLAUDE_INIT_FRAME { return Err("Claude model catalog frame is too large".into()); }
    }
}

async fn claude_models(path: &Path) -> Result<Vec<ModelInfo>, String> {
    let mut command = provider_command("claude", path)?;
    claude_auth::configure(&mut command, "claude");
    command
        .args([
            "-p",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
            "--permission-prompt-tool",
            "stdio",
            "--no-session-persistence",
            "--strict-mcp-config",
            "--mcp-config",
            r#"{"mcpServers":{}}"#,
            "--settings",
            r#"{"disableAllHooks":true}"#,
        ])
        .current_dir(std::env::temp_dir())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command
        .spawn()
        .map_err(|e| format!("Could not start Claude: {e}"))?;
    let group = ProcessGroup::register(child.id());
    let mut stdin = child.stdin.take().ok_or("Claude stdin unavailable")?;
    let mut stdout = child.stdout.take().ok_or("Claude stdout unavailable")?;
    let result = tokio::time::timeout(Duration::from_secs(15), async {
        write_json(&mut stdin, &json!({"type":"control_request","request_id":"pandacode-models","request":{"subtype":"initialize","hooks":null}})).await?;
        read_claude_models(&mut stdout).await
    }).await.unwrap_or_else(|_| Err("Claude model discovery timed out; check the CLI or enter a custom model ID".into()));
    drop(stdin);
    drop(group);
    let _ = child.start_kill();
    let _ = tokio::time::timeout(Duration::from_secs(1), child.wait()).await;
    result
}

async fn codex_models(path: &Path) -> Result<Vec<ModelInfo>, String> {
    let mut command = provider_command("codex", path)?;
    command
        .arg("app-server")
        .current_dir(std::env::temp_dir())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command
        .spawn()
        .map_err(|e| format!("Could not start Codex: {e}"))?;
    let group = ProcessGroup::register(child.id());
    let mut stdin = child.stdin.take().ok_or("Codex stdin unavailable")?;
    let mut stdout = child.stdout.take().ok_or("Codex stdout unavailable")?;
    let result = tokio::time::timeout(Duration::from_secs(8), async {
        write_json(&mut stdin, &json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"pandacode","title":"PandaCode","version":"0.1.0"}}})).await?;
        let mut bytes = Vec::new();
        let mut buffer = [0u8; 4096];
        let mut total = 0;
        let mut expected = 1;
        loop {
            let count = stdout.read(&mut buffer).await.map_err(|e| format!("Codex model stream failed: {e}"))?;
            if count == 0 { return Err("Codex exited before returning its model catalog".into()); }
            total += count;
            if total > 1024 * 1024 { return Err("Codex model discovery exceeded its output limit".into()); }
            bytes.extend_from_slice(&buffer[..count]);
            let mut consumed = 0;
            for end in bytes.iter().enumerate().filter_map(|(i, byte)| (*byte == b'\n').then_some(i)) {
                let line = &bytes[consumed..end];
                consumed = end + 1;
                if line.len() > 256 * 1024 { return Err("Codex model catalog frame is too large".into()); }
                if line.iter().all(u8::is_ascii_whitespace) { continue; }
                let message: Value = serde_json::from_slice(line).map_err(|_| "Codex returned invalid model discovery JSON")?;
                if message["id"].as_u64() != Some(expected) || message.get("method").is_some() { continue; }
                if let Some(error) = message.get("error") {
                    return Err(format!("Codex model discovery failed: {}", short(error["message"].as_str().unwrap_or("Unknown error"))));
                }
                let result = message.get("result").ok_or("Codex model discovery returned an invalid response")?;
                if expected == 2 { return parse_codex_models(result); }
                write_json(&mut stdin, &json!({"method":"initialized","params":{}})).await?;
                write_json(&mut stdin, &json!({"id":2,"method":"model/list","params":{"limit":100,"includeHidden":false}})).await?;
                expected = 2;
            }
            bytes.drain(..consumed);
            if bytes.len() > 256 * 1024 { return Err("Codex model catalog frame is too large".into()); }
        }
    }).await.unwrap_or_else(|_| Err("Codex model discovery timed out; check the CLI or enter a custom model ID".into()));
    drop(stdin);
    // Discovery has no active turn to preserve. Kill and reap on success, failure,
    // or timeout; the guard also handles cancellation of this future.
    drop(group);
    let _ = child.start_kill();
    let _ = tokio::time::timeout(Duration::from_secs(1), child.wait()).await;
    result
}

#[derive(Default)]
struct Step {
    events: Vec<AgentEvent>,
    write: Vec<Value>,
    done: bool,
    calls: Vec<host_tools::Call>,
    failure: Option<String>,
    goal_acknowledgements: Vec<goals::Acknowledgement>,
}

struct Protocol {
    config: RunConfig,
    remote_id: String,
    turn_id: String,
    phase: u8,
    /// Steering messages this run has accepted but not yet delivered.
    steers: steering::Steers,
    acp_steers: acp::Steers,
    /// Latest Codex rate-limit snapshot, for the reset time of a usage-limit error.
    codex_limits: Value,
    /// Claude echoes the opening prompt first; later echoes are steering messages.
    prompt_replayed: bool,
    pending: HashMap<String, Value>,
    inputs: HashMap<String, Value>,
    host: Option<host_tools::HostTools>,
    mcp_server: Option<Value>,
    mcp_required: bool,
    codex_mcp_servers: Option<Value>,
    mcp_tool_names: HashSet<String>,
    text_streams: text_stream::TextStreams,
    text_sequence: u64,
    claude_message_id: String,
    kimi_message_id: String,
    kimi_resume: bool,
    pi: pi::State,
    muse: muse::State,
    zcode: zcode::State,
    // ACP may publish commands before session/new responds. Keep at most one
    // small frame until the response confirms which session owns it.
    early_kimi_commands: Option<Vec<u8>>,
    tools: HashMap<String, ToolActivity>,
    file_write_tools: HashSet<String>,
    tool_order: VecDeque<String>,
    partial_tools: HashMap<(String, u64), PartialTool>,
    image_blocks: Vec<Value>,
    active_model: String,
    kimi_thinking_values: Vec<String>,
    acp_config: Value,
    // Grok Build authenticates before session calls; the session request waits here.
    acp_pending_session: Option<Value>,
    grok_context_used: u64,
    grok_reasoning: bool,
    /// A plan task whose harness advertises no plan mode: PandaCode keeps it
    /// read-only itself (prompt prefix, permission declines).
    plan_fallback: bool,
    /// Which mode a fallback ran in, shown once the prompt is sent.
    mode_note: Option<String>,
    claude_input_tokens: Option<u64>,
    claude_output_tokens: u64,
    subagents: Option<subagents::Subagents>,
    goals: goals::Runtime,
}

fn string(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}
fn short(value: &str) -> String {
    value.chars().take(4000).collect()
}

// Tool snapshots may contain megabytes of output. Only small scalar metadata
// crosses IPC; complete pending approval requests remain in the native adapter.
fn event_metadata(value: &Value) -> Option<Value> {
    let mut metadata = serde_json::Map::new();
    for key in [
        "type",
        "id",
        "status",
        "name",
        "toolCallId",
        "tool_use_id",
        "sessionUpdate",
        "method",
    ] {
        match value.get(key) {
            Some(Value::String(text)) => {
                metadata.insert(
                    key.into(),
                    json!(text.chars().take(128).collect::<String>()),
                );
            }
            Some(scalar @ (Value::Bool(_) | Value::Number(_))) => {
                metadata.insert(key.into(), scalar.clone());
            }
            _ => {}
        }
    }
    if metadata.is_empty() {
        None
    } else {
        Some(Value::Object(metadata))
    }
}

/// Set on an approval event's data when approving can only grant a lasting permission (an ACP
/// request offering `allow_always` but no `allow_once`).
pub(crate) const LASTING_ONLY: &str = "lastingOnly";
/// Beside `LASTING_ONLY`: whether the request also offers a reject choice, so a team worker's
/// automatic answer can decline it instead of stopping the turn.
pub(crate) const LASTING_DECLINABLE: &str = "lastingDeclinable";

fn declinable(request: &Value) -> bool {
    request["params"]["options"].as_array().into_iter().flatten().any(|option| matches!(option["kind"].as_str(), Some("reject_once" | "reject_always")))
}

fn lasting_only(request: &Value) -> bool {
    let kinds = || request["params"]["options"].as_array().into_iter().flatten().filter_map(|option| option["kind"].as_str());
    kinds().any(|kind| kind == "allow_always") && !kinds().any(|kind| kind == "allow_once")
}

impl Protocol {
    fn emit_text(&mut self, update: Option<text_stream::Update>, step: &mut Step) {
        let Some(update) = update else {
            return;
        };
        if let Some((id, phase)) = update.boundary {
            let mut event = self.event("message_start", "", None);
            event.data = Some(json!({"messageId": id}));
            if let Some(phase) = phase {
                event.data.as_mut().unwrap()["phase"] = json!(phase);
            }
            step.events.push(event);
        }
        step.events.push(self.event("text", update.text, None));
    }
    fn text_delta(&mut self, id: &str, phase: Option<&str>, text: &str, step: &mut Step) {
        let update = self.text_streams.delta(id, phase, text);
        self.emit_text(update, step);
    }
    fn text_snapshot(&mut self, id: &str, phase: Option<&str>, text: &str, step: &mut Step) {
        let update = self.text_streams.snapshot(id, phase, text);
        self.emit_text(update, step);
    }
    fn remember_text_phase(&mut self, id: &str, phase: Option<&str>) {
        self.text_streams.remember_phase(id, phase);
    }
    fn next_text_id(&mut self) -> String {
        self.text_sequence += 1;
        format!("{}-message-{}", self.config.provider, self.text_sequence)
    }
    fn claude_text_id(&mut self, message: &Value) -> String {
        if let Some(id) = message["id"].as_str().filter(|id| !id.is_empty()) {
            self.claude_message_id = limited(id, 256);
        } else if self.claude_message_id.is_empty() {
            self.claude_message_id = self.next_text_id();
        }
        self.claude_message_id.clone()
    }
    fn new(config: RunConfig) -> Self {
        Self {
            remote_id: config.resume_id.clone().unwrap_or_default(),
            active_model: config.model.clone(),
            config,
            turn_id: String::new(),
            phase: 0,
            steers: Default::default(),
            acp_steers: Default::default(),
            codex_limits: Value::Null,
            prompt_replayed: false,
            pending: HashMap::new(),
            inputs: HashMap::new(),
            host: None,
            mcp_server: None,
            codex_mcp_servers: None,
            mcp_required: true,
            mcp_tool_names: HashSet::new(),
            text_streams: text_stream::TextStreams::default(),
            text_sequence: 0,
            claude_message_id: String::new(),
            kimi_message_id: String::new(),
            kimi_resume: false,
            pi: pi::State::default(),
            muse: muse::State::default(),
            zcode: zcode::State::default(),
            early_kimi_commands: None,
            tools: HashMap::new(),
            file_write_tools: HashSet::new(),
            tool_order: VecDeque::new(),
            partial_tools: HashMap::new(),
            image_blocks: Vec::new(),
            kimi_thinking_values: Vec::new(),
            acp_config: Value::Null,
            acp_pending_session: None,
            grok_context_used: 0,
            grok_reasoning: false,
            plan_fallback: false,
            mode_note: None,
            claude_input_tokens: None,
            claude_output_tokens: 0,
            subagents: Some(subagents::Subagents::default()),
            goals: goals::Runtime::default(),
        }
    }
    fn usage(&self, used: u64, window: Option<u64>, step: &mut Step) {
        // Match the storage/UI limit and never turn a negative/malformed metric
        // into a fabricated zero or an unbounded percentage.
        if used > 1_000_000_000 || window.is_some_and(|value| value == 0 || value > 1_000_000_000) {
            return;
        }
        let mut event = self.event("usage", "", None);
        event.data = Some(json!({"usedTokens":used,"contextWindow":window}));
        step.events.push(event);
    }
    fn claude_usage(&mut self, usage: &Value, fresh: bool, step: &mut Step) {
        if fresh {
            self.claude_input_tokens = usage["input_tokens"].as_u64().and_then(|input| {
                input
                    .checked_add(
                        usage
                            .get("cache_read_input_tokens")
                            .map_or(Some(0), Value::as_u64)?,
                    )?
                    .checked_add(
                        usage
                            .get("cache_creation_input_tokens")
                            .map_or(Some(0), Value::as_u64)?,
                    )
            });
            self.claude_output_tokens = 0;
        }
        if let Some(output) = usage["output_tokens"].as_u64() {
            self.claude_output_tokens = output;
        }
        if let Some(used) = self
            .claude_input_tokens
            .and_then(|input| input.checked_add(self.claude_output_tokens))
        {
            self.usage(used, None, step);
        }
    }
    fn kimi_config_options(&mut self, result: &Value) {
        if let Some(options) = result["configOptions"].as_array() {
            self.kimi_thinking_values.clear();
            if let Some(thinking) = options
                .iter()
                .take(32)
                .find(|option| option["id"] == "thinking")
            {
                self.kimi_thinking_values = thinking["options"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .take(8)
                    .filter_map(|option| option["value"].as_str())
                    .filter(|value| validate_reasoning_effort("kimi", Some(value)).is_ok())
                    .map(str::to_owned)
                    .collect();
            }
        }
    }
    fn prompt_content(&mut self) -> Vec<Value> {
        // Move encoded screenshots into the outgoing frame so the protocol does
        // not retain a second copy for the rest of a potentially long turn.
        let mut content = std::mem::take(&mut self.image_blocks);
        let mut text = std::mem::take(&mut self.config.prompt);
        if (matches!(self.config.provider.as_str(), "grok" | "deepseek" | "muse" | "hermes") || self.plan_fallback) && self.config.mode == "plan" && !text.trim().is_empty() {
            text = format!("{}\n\n{text}", acp::READ_ONLY_PLAN_PREFIX);
        }
        if !text.trim().is_empty() {
            content.push(if self.config.provider == "codex" {
                json!({"type":"text","text":text,"text_elements":[]})
            } else {
                json!({"type":"text","text":text})
            });
        }
        if self.config.provider == "codex" {
            // `prepare_turn` already dropped a switched-off skill (off the runtime) before the
            // protocol was built, so attaching reads no switches here.
            if let Some((name, path)) = self.config.skill.take() {
                content.push(json!({"type":"skill","name":name,"path":path}));
            }
        }
        content
    }
    fn codex_permissions(&self, turn: bool) -> Value {
        let (sandbox, policy, reviewer) = match self.config.mode.as_str() {
            "auto" => ("workspace-write", "on-request", "auto_review"),
            "plan" => ("read-only", "never", "user"),
            "full" => ("danger-full-access", "never", "user"),
            _ => ("workspace-write", "on-request", "user"),
        };
        let mut params = json!({"approvalPolicy":policy,"approvalsReviewer":reviewer});
        if turn {
            // Apply every turn, including after resume. This revokes an earlier
            // full-access setting and prevents user CLI defaults from widening
            // the workspace represented by the selected behavior.
            params["sandboxPolicy"] = match sandbox {
                "danger-full-access" => json!({"type":"dangerFullAccess"}),
                "read-only" => json!({"type":"readOnly","networkAccess":false}),
                _ => {
                    json!({"type":"workspaceWrite","writableRoots":[self.config.cwd],"networkAccess":false,"excludeTmpdirEnvVar":false,"excludeSlashTmp":false})
                }
            };
        } else {
            params["sandbox"] = json!(sandbox);
        }
        params
    }
    fn event(&self, kind: &str, text: impl Into<String>, data: Option<&Value>) -> AgentEvent {
        let text = text.into();
        AgentEvent {
            session_id: self.config.session_id.clone(),
            kind: kind.into(),
            text: if matches!(kind, "text" | "thinking" | "session" | "note") {
                text
            } else {
                short(&text)
            },
            request_id: None,
            data: data.and_then(event_metadata),
            tool: None,
        }
    }
    /// Reasoning text the model streams; the window appends it to the turn's Thinking fold.
    fn thinking(&self, text: &str, step: &mut Step) {
        if !text.is_empty() { step.events.push(self.event("thinking", text, None)); }
    }
    fn tool_update(
        &mut self,
        id: &str,
        name: Option<&str>,
        status: Option<&str>,
        input: Option<String>,
        output: Option<String>,
        step: &mut Step,
    ) {
        if id.is_empty() {
            return;
        }
        let id = limited(id, 256);
        if !self.tools.contains_key(&id) {
            if self.tools.len() >= TOOL_CACHE_LIMIT {
                if let Some(oldest) = self.tool_order.pop_front() {
                    self.tools.remove(&oldest);
                    self.file_write_tools.remove(&oldest);
                }
            }
            self.tool_order.push_back(id.clone());
        }
        let previous = self.tools.get(&id);
        // Claude may replay its complete tool_use after the corresponding result.
        if previous.is_some_and(|tool| tool.status != "running") && status == Some("running") {
            return;
        }
        let mut tool = previous.cloned().unwrap_or_else(|| ToolActivity {
            id: id.clone(),
            name: "Tool".into(),
            status: "running".into(),
            input: String::new(),
            output: String::new(),
            write_paths: None,
        });
        if let Some(name) = name.filter(|name| !name.is_empty()) {
            tool.name = limited(name, 256);
        }
        if let Some(status) = status {
            tool.status = status.into();
        }
        if let Some(input) = input {
            tool.input = limited(&input, TOOL_INPUT_LIMIT);
        }
        if let Some(output) = output {
            tool.output = limited(&output, TOOL_OUTPUT_LIMIT);
        }
        if let Some(paths) = tool_write_paths(&tool.name, &tool.input) {
            tool.write_paths = Some(paths);
        }
        if previous == Some(&tool) {
            return;
        }
        self.tools.insert(id, tool.clone());
        // The authenticated bridge emits these calls itself. Provider tool
        // frames are retained for joining sparse results, but not shown twice.
        if self.mcp_tool_names.contains(&tool.name)
            || (self.config.provider == "cline" && cline::host_tool(&tool.name).is_some_and(|name| self.mcp_tool_names.contains(name)))
        {
            return;
        }
        let mut event = self.event("tool", format!("{} · {}", tool.name, tool.status), None);
        event.tool = Some(tool);
        step.events.push(event);
    }
    fn tool_paths(&mut self, id: &str, paths: Option<Vec<String>>, step: &mut Step) {
        let Some(paths) = paths else { return; };
        let mut bounded = Vec::new();
        let mut bytes = 0usize;
        for path in paths {
            bytes = bytes.saturating_add(path.len());
            if bounded.len() >= 200 || bytes > 16 * 1024 {
                // An invalid sentinel marks partial provenance without inventing
                // a file name or retaining an unbounded provider payload.
                bounded.push(String::new());
                break;
            }
            if !bounded.contains(&path) { bounded.push(path); }
        }
        let paths = bounded;
        let Some(tool) = self.tools.get_mut(id) else { return; };
        let changed = tool.write_paths.as_ref() != Some(&paths);
        tool.write_paths = Some(paths);
        let tool = tool.clone();
        if let Some(event) = step.events.iter_mut().rev().find(|e| e.tool.as_ref().is_some_and(|t| t.id == id)) {
            event.tool = Some(tool);
        } else if changed {
            let mut event = self.event("tool", format!("{} · {}", tool.name, tool.status), None);
            event.tool = Some(tool);
            step.events.push(event);
        }
    }
    fn codex_tool(&mut self, item: &Value, completed: bool, step: &mut Step) {
        let id = field(item, "id");
        let status = if matches!(field(item, "status"), "failed" | "declined")
            || item["exitCode"].as_i64().is_some_and(|code| code != 0)
            || item["success"] == false
            || item["error"].is_object()
        {
            "failed"
        } else if completed || item["status"] == "completed" {
            "completed"
        } else {
            "running"
        };
        match field(item, "type") {
            "contextCompaction" => {
                self.tool_update(
                    id,
                    Some("Compact context"),
                    Some(status),
                    None,
                    completed.then(|| "Conversation context compacted.".into()),
                    step,
                );
            }
            "commandExecution" => {
                let input = item["command"].as_str().map(|command| {
                    let mut preview = Preview::new(TOOL_INPUT_LIMIT);
                    preview.text(command);
                    if !field(item, "cwd").is_empty() {
                        preview.text("\nWorking directory: ");
                        preview.text(field(item, "cwd"));
                    }
                    preview.finish()
                });
                let output = if item["aggregatedOutput"].is_string() || item["exitCode"].is_number()
                {
                    let mut preview = Preview::new(TOOL_OUTPUT_LIMIT);
                    if let Some(code) = item["exitCode"].as_i64() {
                        preview.text(&format!("Exit code: {code}\n"));
                    }
                    preview.text(item["aggregatedOutput"].as_str().unwrap_or_else(|| {
                        self.tools
                            .get(id)
                            .map(|t| t.output.as_str())
                            .unwrap_or_default()
                    }));
                    Some(preview.finish())
                } else {
                    None
                };
                self.tool_update(id, Some("Command"), Some(status), input, output, step);
                self.tool_paths(id, Some(vec![]), step);
            }
            "fileChange" => {
                let (input, output) = if let Some(changes) = item["changes"].as_array() {
                    let mut input = Preview::new(TOOL_INPUT_LIMIT);
                    let mut output = Preview::new(TOOL_OUTPUT_LIMIT);
                    for (index, change) in changes.iter().take(128).enumerate() {
                        if index > 0 {
                            input.text("\n");
                            output.text("\n\n");
                        }
                        input.text(field(&change["kind"], "type"));
                        input.text(" ");
                        input.text(field(change, "path"));
                        if let Some(path) = change["kind"]["move_path"].as_str() {
                            input.text(" → ");
                            input.text(path);
                        }
                        output.text(field(change, "path"));
                        output.text("\n");
                        output.text(field(change, "diff"));
                        if input.truncated && output.truncated {
                            break;
                        }
                    }
                    if changes.len() > 128 {
                        input.truncated = true;
                        output.truncated = true;
                    }
                    (Some(input.finish()), Some(output.finish()))
                } else {
                    (None, None)
                };
                self.tool_update(id, Some("Update files"), Some(status), input, output, step);
                let paths = item["changes"].as_array().map(|changes| changes.iter().take(201).flat_map(|change| {
                    [change["path"].as_str(), change["kind"]["move_path"].as_str(), change["kind"]["movePath"].as_str()]
                        .into_iter().flatten().filter(|p| p.len() <= 4096).map(str::to_owned)
                }).collect());
                self.tool_paths(id, paths, step);
            }
            "mcpToolCall" | "dynamicToolCall" => {
                if item["type"] == "mcpToolCall"
                    && field(item, "server") == "pandacode_architect"
                    && self.mcp_tool_names.contains(field(item, "tool"))
                {
                    // The authenticated local bridge owns these events. Title
                    // metadata emits none; other host tools emit their own rows.
                    return;
                }
                let namespace = if item["type"] == "mcpToolCall" {
                    field(item, "server")
                } else {
                    field(item, "namespace")
                };
                let name = if namespace.is_empty() {
                    limited(field(item, "tool"), 256)
                } else {
                    format!(
                        "{} · {}",
                        limited(namespace, 128),
                        limited(field(item, "tool"), 128)
                    )
                };
                let input = item
                    .get("arguments")
                    .filter(|value| !value.is_null())
                    .map(|v| preview_json(v, TOOL_INPUT_LIMIT));
                let output = if item["error"].is_object() {
                    Some(limited(field(&item["error"], "message"), TOOL_OUTPUT_LIMIT))
                } else if item["result"].is_object() {
                    let mut output = content_preview(&item["result"]["content"], TOOL_OUTPUT_LIMIT);
                    if let Some(structured) = item["result"]
                        .get("structuredContent")
                        .filter(|value| !value.is_null())
                    {
                        if !output.is_empty() {
                            append_preview(&mut output, "\n", TOOL_OUTPUT_LIMIT);
                        }
                        append_preview(
                            &mut output,
                            &output_json(structured, TOOL_OUTPUT_LIMIT),
                            TOOL_OUTPUT_LIMIT,
                        );
                    }
                    Some(output)
                } else if item["contentItems"].is_array() {
                    Some(content_preview(&item["contentItems"], TOOL_OUTPUT_LIMIT))
                } else {
                    None
                };
                self.tool_update(id, Some(&name), Some(status), input, output, step);
            }
            kind => {
                // Known activities keep a few named, bounded fields; others keep
                // only a label, never arbitrary nested protocol payloads.
                let (name, input, output) = codex_item_details(item)
                    .unwrap_or_else(|| (limited(kind, 256), None, None));
                self.tool_update(id, Some(&name), Some(status), input, output, step);
            }
        }
    }
    fn kimi_tool(&mut self, update: &Value, step: &mut Step) {
        let write_kind = matches!(field(update, "kind"), "edit" | "delete" | "move");
        if write_kind { self.file_write_tools.insert(limited(field(update, "toolCallId"), 256)); }
        let writes = write_kind || self.file_write_tools.contains(field(update, "toolCallId"));
        let status = match field(update, "status") {
            "completed" => Some("completed"),
            "failed" => Some("failed"),
            "pending" | "in_progress" => Some("running"),
            _ => None,
        };
        let finished = matches!(status, Some("completed" | "failed"))
            || (status.is_none()
                && self
                    .tools
                    .get(field(update, "toolCallId"))
                    .is_some_and(|tool| tool.status != "running"));
        // Kimi sends cumulative argument previews before execution and REPLACES
        // content with the result on completion; missing fields are unchanged.
        let input = if let Some(input) = update.get("rawInput").filter(|value| !value.is_null()) {
            Some(preview_json(input, TOOL_INPUT_LIMIT))
        } else if !finished && update.get("content").is_some() {
            Some(content_preview(&update["content"], TOOL_INPUT_LIMIT))
        } else {
            None
        };
        let output = if finished && update.get("content").is_some() {
            Some(content_preview(&update["content"], TOOL_OUTPUT_LIMIT))
        } else {
            update
                .get("rawOutput")
                .filter(|value| !value.is_null())
                .map(|output| output_json(output, TOOL_OUTPUT_LIMIT))
        };
        // ACP argument deltas are cumulative. Retain the latest bounded input
        // locally, then publish it with the complete call or terminal result.
        let buffer_only = self.tools.contains_key(field(update, "toolCallId"))
            && status == Some("running")
            && update.get("content").is_some()
            && update["title"].is_null()
            && update["rawInput"].is_null()
            && update["rawOutput"].is_null();
        let mut buffered = Step::default();
        let target = if buffer_only { &mut buffered } else { step };
        self.tool_update(
            field(update, "toolCallId"),
            update["title"].as_str(),
            status,
            input,
            output,
            target,
        );
        self.file_write_tools.retain(|id| self.tools.contains_key(id));
        let paths = if writes {
            let mut paths: Vec<String> = update["locations"].as_array().into_iter().flatten().take(201)
                .filter_map(|location| location["path"].as_str()).filter(|p| p.len() <= 4096).map(str::to_owned).collect();
            for key in ["file_path", "path", "notebook_path", "old_path", "new_path"] {
                if let Some(path) = update["rawInput"][key].as_str().filter(|p| p.len() <= 4096) { paths.push(path.into()); }
            }
            paths.sort(); paths.dedup();
            if paths.is_empty() && self.tools.get(field(update, "toolCallId")).is_some_and(|tool| tool.write_paths.as_ref().is_some_and(|p| !p.is_empty())) { None } else { Some(paths) }
        } else if update["kind"] == "execute" { Some(vec![]) } else { None };
        self.tool_paths(field(update, "toolCallId"), paths, target);
    }
    fn initial(&self) -> Value {
        match self.config.provider.as_str() {
            "pi" | "omp" => json!({"type":"get_state","id":"pandacode-init"}),
            "zcode" => self.zcode_initial(),
            "muse" => self.muse_initial(),
            "codex" => {
                let mut request = json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"pandacode","title":"PandaCode","version":"0.1.0"}}});
                request["params"]["capabilities"] =
                    json!({"experimentalApi":true,"requestAttestation":false});
                request
            }
            "kimi" | "opencode" | "antigravity" | "grok" | "deepseek" | "commandcode" | "cline" | "kilo" | "github-copilot" | "devin" | "hermes" => {
                json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{},"clientInfo":{"name":"pandacode","version":"0.1.0"}}})
            }
            _ => {
                json!({"type":"control_request","request_id":"pandacode-init","request":{"subtype":"initialize","hooks":null}})
            }
        }
    }
    fn approval(&mut self, value: Value, text: String, step: &mut Step) {
        let request_id = uuid::Uuid::new_v4().to_string();
        let mut event = self.event("approval", short(&text), Some(&value));
        event.request_id = Some(request_id.clone());
        // Approving it grants more than this action (`approve`), so PandaCode never approves
        // it automatically (a bot's allow rule asks instead; a team worker's is declined).
        if lasting_only(&value) {
            let data = event.data.get_or_insert_with(|| json!({}));
            data[LASTING_ONLY] = json!(true);
            data[LASTING_DECLINABLE] = json!(declinable(&value));
        }
        self.pending.insert(request_id, value);
        step.events.push(event);
    }
    fn approve(&mut self, id: &str, approved: bool) -> Option<Value> {
        if self.config.provider == "muse" {
            // Muse decides only with a choice it offered; keep the prompt when none fits.
            let request = self.pending.get(id)?.clone();
            let decision = self.muse_decide(&request, approved)?;
            self.pending.remove(id);
            return Some(decision);
        }
        let request = self.pending.remove(id)?;
        let declined = decline_text(&self.config.session_id, id);
        Some(match self.config.provider.as_str() {
            "pi" | "omp" => json!({"type":"extension_ui_response","id":request["id"],"confirmed":approved}),
            "zcode" => zcode::permission_decision(&request, approved),
            "codex" => {
                let method = string(&request, "method");
                let result = if method == "item/permissions/requestApproval" {
                    json!({"permissions": if approved {request["params"]["permissions"].clone()} else {json!({})},"scope":"turn"})
                } else {
                    json!({"decision": if approved { "accept" } else { "decline" }})
                };
                json!({"id":request["id"],"result":result})
            }
            "devin" => devin::decision(&request, approved),
            // ACP: a one-time choice first. With only a lasting one (`allow_always`), approving
            // takes it: only the user's own approval of such a request. PandaCode's automatic
            // paths never approve one (`LASTING_ONLY`): a team worker's declines or stops the turn.
            "kimi" | "opencode" | "antigravity" | "grok" | "deepseek" | "commandcode" | "cline" | "kilo" | "github-copilot" | "hermes" => {
                let options = request["params"]["options"].as_array();
                let kinds = if approved {
                    ["allow_once", "allow_always"]
                } else {
                    ["reject_once", "reject_always"]
                };
                let selected = kinds.iter().find_map(|kind| {
                    options.and_then(|o| o.iter().find(|o| o["kind"].as_str() == Some(kind)))
                });
                let outcome = selected
                    .map(|o| json!({"outcome":"selected","optionId":o["optionId"]}))
                    .unwrap_or_else(|| json!({"outcome":"cancelled"}));
                json!({"jsonrpc":"2.0","id":request["id"],"result":{"outcome":outcome}})
            }
            _ => {
                json!({"type":"control_response","response":{"subtype":"success","request_id":request["request_id"],"response":if approved {json!({"behavior":"allow","updatedInput":request["request"]["input"]})} else {json!({"behavior":"deny","message":declined})}}})
            }
        })
    }
    fn cancel(&self) -> Value {
        match self.config.provider.as_str() {
            "pi" | "omp" => json!({"type":"abort"}),
            "zcode" => zcode::stop(&self.remote_id),
            "muse" => self.muse_cancel(),
            "codex" => {
                json!({"id":900,"method":"turn/interrupt","params":{"threadId":self.remote_id,"turnId":self.turn_id}})
            }
            "kimi" | "opencode" | "antigravity" | "grok" | "deepseek" | "commandcode" | "cline" | "kilo" | "github-copilot" | "devin" | "hermes" => {
                json!({"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":self.remote_id}})
            }
            _ => {
                json!({"type":"control_request","request_id":"pandacode-stop","request":{"subtype":"interrupt"}})
            }
        }
    }
    fn receive(&mut self, mut value: Value) -> Result<Step, String> {
        let Some(mut subagents) = self.subagents.take() else {
            return self.receive_inner(value);
        };
        let mut result = if let Some(step) = subagents.route(&mut value, self) {
            Ok(step)
        } else {
            self.receive_inner(value)
        };
        if let Ok(step) = &mut result {
            subagents.observe_tools(&step.events, None, &self.config);
            step.events.extend(subagents.flush(self));
        }
        self.subagents = Some(subagents);
        result
    }
    /// Sends child snapshots the throttle held back; `all` also sends those not yet due.
    fn flush_subagents(&mut self, all: bool) -> Step {
        let mut step = Step::default();
        if let Some(mut subagents) = self.subagents.take() {
            step.events = subagents.flush_due(self, all);
            self.subagents = Some(subagents);
        }
        step
    }
    fn subagent_flush_at(&self) -> Option<tokio::time::Instant> {
        self.subagents.as_ref().and_then(subagents::Subagents::next_flush)
    }
    fn receive_inner(&mut self, value: Value) -> Result<Step, String> {
        match self.config.provider.as_str() {
            "codex" => self.codex(value).map(|step| self.steered(step)),
            "kimi" => self.kimi_steered(value),
            "pi" | "omp" => self.pi(value).map(|step| self.steered(step)),
            "zcode" => self.zcode(value).map(|step| self.steered(step)),
            "muse" => self.muse(value),
            "opencode" | "antigravity" | "grok" | "deepseek" | "commandcode" | "cline" | "kilo" | "github-copilot" | "devin" | "hermes" => self.acp(value),
            _ => self.claude(value),
        }
    }
    fn steered(&mut self, mut step: Step) -> Step {
        self.steer_turn_end(&mut step);
        step
    }
    fn codex(&mut self, value: Value) -> Result<Step, String> {
        let mut step = Step::default();
        if self.codex_steer_response(&value, &mut step) {
            return Ok(step);
        }
        let method = string(&value, "method");
        let params = &value["params"];
        if !method.is_empty() {
            // Child threads share this app-server connection. Keep their text,
            // errors, and completion out of the main turn, but route their
            // approval requests through the existing user approval policy.
            // Older envelopes without routing IDs remain compatible.
            let foreign_thread = params["threadId"]
                .as_str()
                .is_some_and(|id| !id.is_empty() && id != self.remote_id);
            let event_turn = params["turnId"]
                .as_str()
                .filter(|id| !id.is_empty())
                .or_else(|| params["turn"]["id"].as_str().filter(|id| !id.is_empty()));
            let goal_thread_event = matches!(
                method.as_str(),
                "thread/goal/updated" | "thread/goal/cleared"
            );
            let goal_next_turn =
                method == "turn/started" && self.goals.active() && !self.goals.turn_running;
            let foreign_turn = !goal_thread_event
                && !goal_next_turn
                && !self.turn_id.is_empty()
                && event_turn.is_some_and(|id| id != self.turn_id);
            let approval_request = value.get("id").is_some()
                && matches!(
                    method.as_str(),
                    "item/commandExecution/requestApproval"
                        | "item/fileChange/requestApproval"
                        | "item/permissions/requestApproval"
                );
            if (foreign_thread || foreign_turn) && !approval_request {
                if value.get("id").is_some() {
                    step.write.push(json!({"id":value["id"],"error":{"code":-32602,"message":"This client is not handling the requested thread or turn"}}));
                }
                return Ok(step);
            }
        }
        if self.goal_response(&value, &mut step)? {
            return Ok(step);
        }
        if self.goal_notification(&method, params, &mut step)? {
            return Ok(step);
        }
        if let Some(error) = value.get("error") {
            return Err(error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("Codex request failed")
                .into());
        }
        if let Some(id) = value["id"]
            .as_u64()
            .filter(|_| value.get("result").is_some())
        {
            match id {
                1 => {
                    step.write.push(json!({"method":"initialized","params":{}}));
                    self.codex_bootstrap(&mut step)?;
                }
                2 => {
                    self.remote_id = string(&value["result"]["thread"], "id");
                    if self.remote_id.is_empty() {
                        return Err("Codex did not return a thread ID".into());
                    }
                    step.events
                        .push(self.event("session", self.remote_id.clone(), None));
                    if let Some(model) = value["result"]["model"].as_str() {
                        self.active_model = model.into();
                    }
                    self.goals.resolved_effort = value["result"]["reasoningEffort"]
                        .as_str()
                        .map(str::to_owned);
                    if self.config.reasoning_effort.is_some() || self.wants_tier_catalog() {
                        step.write.push(json!({"id":6,"method":"model/list","params":{"limit":100,"includeHidden":false}}));
                    } else {
                        self.codex_goal_ready(&mut step)?;
                    }
                }
                3 => {
                    // Compaction acknowledges with {}, and notifications can
                    // precede that response. Never erase its already-started turn.
                    if let Some(id) = value["result"]["turn"]["id"].as_str() {
                        self.turn_id = id.into();
                        self.goals.turn_running = true;
                    }
                }
                6 => {
                    let models = parse_codex_models(&value["result"])?;
                    let found_model = self.remember_model_tiers(&value["result"]);
                    if !found_model && self.next_model_page(&value["result"], &mut step)? {
                        return Ok(step);
                    }
                    if let Some(model) = models
                        .iter()
                        .find(|model| model.id == self.active_model && model.id != "default")
                    {
                        if self.config.reasoning_effort.as_ref().is_some_and(|effort| {
                            !model
                                .reasoning_efforts
                                .iter()
                                .any(|option| &option.id == effort)
                        }) {
                            return Err(format!("The selected Codex model {MODEL_REFUSES_EFFORT}. Choose another effort or use harness settings."));
                        }
                    }
                    self.codex_goal_ready(&mut step)?;
                }
                _ => {}
            }
        }
        match method.as_str() {
            "skills/changed" => self.commands_changed(&value, &mut step),
            "item/tool/call" => self.host_tool_request(value, &mut step),
            "item/tool/requestUserInput" | "mcpServer/elicitation/request" => self.input_request(value, &mut step),
            "serverRequest/resolved" => self.resolved_request(&params["requestId"], &mut step),
            "thread/tokenUsage/updated" => {
                if field(params,"threadId") == self.remote_id {
                    let usage=&params["tokenUsage"];
                    if let Some(used)=usage["last"]["totalTokens"].as_u64() {
                        self.usage(used,usage["modelContextWindow"].as_u64(),&mut step);
                    }
                }
            },
            "turn/started" => self.goal_turn_started(string(&params["turn"],"id"), &mut step),
            "item/agentMessage/delta" => {
                self.text_delta(field(params,"itemId"),None,field(params,"delta"),&mut step);
            },
            "item/reasoning/summaryTextDelta"|"item/reasoning/textDelta" => self.thinking(field(params,"delta"),&mut step),
            "item/reasoning/summaryPartAdded" if params["summaryIndex"].as_u64().is_some_and(|index| index > 0) => self.thinking("\n\n",&mut step),
            "item/commandExecution/outputDelta" => {
                let id=field(params,"itemId");
                let mut output=self.tools.get(id).map(|tool|tool.output.clone()).unwrap_or_default();
                append_preview(&mut output,field(params,"delta"),TOOL_OUTPUT_LIMIT);
                self.tool_update(id,Some("Command"),None,None,Some(output),&mut step);
            },
            "item/started"|"item/completed" => {
                let item=&params["item"];let kind=string(item,"type");
                if kind=="agentMessage" {
                    if method=="item/completed" {
                        self.text_snapshot(field(item,"id"),item["phase"].as_str(),field(item,"text"),&mut step);
                    } else {
                        self.remember_text_phase(field(item,"id"),item["phase"].as_str());
                    }
                } else if kind=="userMessage" {
                    // Codex echoes a steer as a user message when the turn takes it.
                    if method=="item/started" { self.steers_consumed(&item["content"],&mut step); }
                } else if kind!="reasoning" {
                    self.codex_tool(item,method=="item/completed",&mut step);
                }
            },
            "item/commandExecution/requestApproval"|"item/fileChange/requestApproval"|"item/permissions/requestApproval" => {
                let label=if params["command"].is_string() { string(params,"command") } else if params["reason"].is_string() {string(params,"reason")} else {"Allow this agent action?".into()};
                self.approval(value,label,&mut step);
            },
            "turn/completed" => {
                self.goal_turn_completed(params, &mut step)?;
            },
            "account/rateLimits/updated" => self.codex_rate_limits(params),
            "error" => {
                if !params["willRetry"].as_bool().unwrap_or(false) {
                    let limited = self.codex_limited(params);
                    let is_limited = limited.is_some();
                    step.events.extend(limited);
                    if self.goals.state.is_some() {
                        self.goal_failure(string(&params["error"],"message"), &mut step)?;
                        return Ok(step);
                    }
                    if is_limited {
                        // End the run through the step, so the limit event is delivered first.
                        step.failure = Some(string(&params["error"],"message"));
                        return Ok(step);
                    }
                    return Err(string(&params["error"],"message"));
                }
                step.events.push(self.event("status","Provider is retrying",None));
            },
            _ if value.get("id").is_some() && !method.is_empty() => step.write.push(json!({"id":value["id"],"error":{"code":-32601,"message":"This client does not support this interactive request"}})),
            _=>{},
        }
        Ok(step)
    }
    fn codex_prompt(&mut self, step: &mut Step) -> Result<(), String> {
        let prompt = self.config.prompt.trim();
        let (command, arguments) = prompt
            .split_once(char::is_whitespace)
            .map_or((prompt, ""), |(command, arguments)| {
                (command, arguments.trim())
            });
        if self.config.skill.is_none() && matches!(command, "/compact" | "/review") {
            if !self.image_blocks.is_empty() {
                return Err("Codex /compact and /review do not accept screenshot attachments. Remove the screenshots or send a regular message.".into());
            }
            let request = if command == "/compact" {
                if !arguments.is_empty() {
                    return Err("Codex /compact does not accept arguments.".into());
                }
                json!({"id":3,"method":"thread/compact/start","params":{"threadId":self.remote_id}})
            } else {
                let target = if arguments.is_empty() {
                    json!({"type":"uncommittedChanges"})
                } else {
                    json!({"type":"custom","instructions":arguments})
                };
                json!({"id":3,"method":"review/start","params":{"threadId":self.remote_id,"target":target,"delivery":"inline"}})
            };
            self.config.prompt.clear();
            step.write.push(request);
            self.phase = 1;
            self.goals.turn_running = true;
            return Ok(());
        }
        let mut request =
            json!({"id":3,"method":"turn/start","params":self.codex_permissions(true)});
        request["params"]["threadId"] = json!(self.remote_id);
        request["params"]["input"] = Value::Array(self.prompt_content());
        if let Some(mode) = &self.goals.collaboration_mode {
            request["params"]["collaborationMode"] = mode.clone();
        }
        if let Some(effort) = &self.config.reasoning_effort {
            request["params"]["effort"] = json!(effort);
        }
        step.write.push(request);
        self.phase = 1;
        self.goals.turn_running = true;
        Ok(())
    }

    fn commands_changed(&self, value: &Value, step: &mut Step) {
        if crate::slash_commands::observe_runtime(&self.config.provider, &self.config.cwd, value) {
            step.events.push(self.event("commands_changed", "", None));
        }
    }
    fn kimi(&mut self, value: Value) -> Result<Step, String> {
        let mut step = Step::default();
        if let Some(error) = value.get("error") {
            // Kimi reports model-level image capability failures in ACP error
            // data. Keep that useful reason instead of only "Internal error".
            if !self.config.images.is_empty() {
                if let Some(detail) = error["data"]["error"].as_str() {
                    return Err(format!(
                        "Kimi could not process the screenshot: {}",
                        short(detail)
                    ));
                }
            }
            return Err(error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("Kimi request failed; run kimi login if authentication is required")
                .into());
        }
        if let Some(id) = value["id"]
            .as_u64()
            .filter(|_| value.get("result").is_some())
        {
            match id {
                1 => {
                    if value["result"]["protocolVersion"] != 1 {
                        return Err("Unsupported Kimi ACP protocol version".into());
                    }
                    if !self.image_blocks.is_empty()
                        && value["result"]["agentCapabilities"]["promptCapabilities"]["image"]
                            != true
                    {
                        return Err("This Kimi version does not support screenshot input. Update Kimi Code or remove the screenshots.".into());
                    }
                    self.kimi_resume = value["result"]["agentCapabilities"]["sessionCapabilities"]
                        .get("resume")
                        .is_some();
                    if self.mcp_server.is_some()
                        && value["result"]["agentCapabilities"]["mcpCapabilities"]["http"] != true
                    {
                        if self.mcp_required {
                            return Err("This Kimi version does not support the HTTP MCP transport required by architect teams. Update Kimi Code.".into());
                        }
                        self.mcp_server = None;
                    }
                    let mut params = json!({"cwd":self.config.cwd,"mcpServers":self.mcp_server.iter().collect::<Vec<_>>()});
                    let method = if self.remote_id.is_empty() {
                        "session/new"
                    } else {
                        params["sessionId"] = json!(self.remote_id);
                        if self.kimi_resume {
                            "session/resume"
                        } else {
                            "session/load"
                        }
                    };
                    step.write
                        .push(json!({"jsonrpc":"2.0","id":2,"method":method,"params":params}));
                }
                2 => {
                    self.kimi_config_options(&value["result"]);
                    let returned = string(&value["result"], "sessionId");
                    if !returned.is_empty() {
                        self.remote_id = returned;
                    }
                    if self.remote_id.is_empty() {
                        return Err("Kimi did not return a session ID".into());
                    }
                    if let Some(bytes) = self.early_kimi_commands.take() {
                        if let Ok(commands) = serde_json::from_slice::<Value>(&bytes) {
                            if commands["params"]["sessionId"] == self.remote_id {
                                self.commands_changed(&commands, &mut step);
                            }
                        }
                    }
                    step.events
                        .push(self.event("session", self.remote_id.clone(), None));
                    let modes = value["result"]["modes"]["availableModes"].as_array();
                    // Kimi ACP's mode descriptions may be stale: the actual
                    // engine uses yolo for routine auto-approval and auto for
                    // unattended execution (including sensitive operations).
                    let wanted = match self.config.mode.as_str() {
                        "auto" => "yolo",
                        "plan" => "plan",
                        "full" => "auto",
                        _ => "default",
                    };
                    if let Some(mode) =
                        modes.and_then(|m| m.iter().find(|m| string(m, "id") == wanted))
                    {
                        step.write.push(json!({"jsonrpc":"2.0","id":4,"method":"session/set_mode","params":{"sessionId":self.remote_id,"modeId":mode["id"]}}));
                        return Ok(step);
                    }
                    return Err(format!("This Kimi version does not advertise the required {wanted} permission mode"));
                }
                4 => self.kimi_model(&mut step)?,
                5 => {
                    self.kimi_config_options(&value["result"]);
                    self.kimi_effort(&mut step)?;
                }
                6 => self.kimi_prompt(&mut step),
                3 => step.done = true,
                _ => {}
            }
        }
        let method = string(&value, "method");
        let params = &value["params"];
        match method.as_str() {
            "session/update"=>{
                if self.remote_id.is_empty() && self.phase == 0
                    && params["update"]["sessionUpdate"] == "available_commands_update"
                    && params["sessionId"].as_str().is_some_and(|id| !id.is_empty() && id.len() <= 256)
                {
                    let mut preview = Preview::new(128 * 1024);
                    if value.serialize(&mut serde_json::Serializer::new(&mut preview)).is_ok() {
                        self.early_kimi_commands = Some(preview.bytes);
                    }
                    return Ok(step);
                }
                if params["sessionId"].as_str().is_some_and(|id| id != self.remote_id) {return Ok(step);}
                let update=&params["update"];
                if update["sessionUpdate"] == "available_commands_update" { self.commands_changed(&value, &mut step); }
                if update["sessionUpdate"] == "config_option_update" { self.kimi_config_options(update); }
                // session/load can replay history before its response; UI already owns that history.
                if self.phase==0{return Ok(step);}
                match string(update,"sessionUpdate").as_str() {
                    "usage_update"=>{if let Some(used)=update["used"].as_u64() {self.usage(used,update["size"].as_u64(),&mut step);}},
                    "agent_message_chunk"=>{
                        let content=&update["content"];
                        if content["type"]=="text" || content["type"].is_null() {
                            let text=field(content,"text");
                            if !text.is_empty() {
                                if let Some(id)=update["messageId"].as_str().filter(|id| !id.is_empty()) {
                                    self.kimi_message_id=limited(id,256);
                                } else if self.kimi_message_id.is_empty() {
                                    self.kimi_message_id=self.next_text_id();
                                }
                                let id=self.kimi_message_id.clone();
                                self.text_delta(&id,None,text,&mut step);
                            }
                        }
                    },
                    "agent_thought_chunk"=>{
                        self.kimi_message_id.clear();
                        if update["content"]["type"]=="text" {self.thinking(field(&update["content"],"text"),&mut step);}
                    },
                    "tool_call"|"tool_call_update"=>{
                        // Late snapshots of a known tool must not split a later
                        // assistant response. Only a new call closes the segment.
                        let id=field(update,"toolCallId");
                        if !id.is_empty() && !self.tools.contains_key(id) {self.kimi_message_id.clear();}
                        self.kimi_tool(update,&mut step);
                    },
                    "plan"=>step.events.push(self.event("status","Plan updated",Some(update))),
                    _=>{},
                }
            },
            "session/request_permission"=>{
                let options=params["options"].as_array();
                let is_question=options.is_some_and(|options|options.iter().filter(|o|o["kind"]=="allow_once").count()>1 || options.iter().any(|o| {
                    let id=string(o,"optionId");
                    id.strip_prefix('q').and_then(|s|s.split_once("_opt_")).is_some_and(|(number,_)|number.parse::<usize>().is_ok())
                }));
                if is_question {
                    step.events.push(self.event("status","The agent requested structured input. Answer in chat when the turn finishes.",None));
                    step.write.push(json!({"jsonrpc":"2.0","id":value["id"],"result":{"outcome":{"outcome":"cancelled"}}}));
                    return Ok(step);
                }
                let label=string(&params["toolCall"],"title");self.approval(value,if label.is_empty(){"Allow this agent action?".into()}else{label},&mut step);
            },
            _ if value.get("id").is_some() && !method.is_empty()=>step.write.push(json!({"jsonrpc":"2.0","id":value["id"],"error":{"code":-32601,"message":"Client capability not supported"}})),
            _=>{},
        }
        Ok(step)
    }
    fn kimi_model(&mut self, step: &mut Step) -> Result<(), String> {
        if !self.config.model.is_empty() && self.config.model != "default" {
            self.kimi_thinking_values.clear();
            step.write.push(json!({"jsonrpc":"2.0","id":5,"method":"session/set_model","params":{"sessionId":self.remote_id,"modelId":self.config.model}}));
        } else {
            self.kimi_effort(step)?;
        }
        Ok(())
    }
    fn kimi_effort(&mut self, step: &mut Step) -> Result<(), String> {
        if let Some(effort) = &self.config.reasoning_effort {
            if !self.kimi_thinking_values.contains(effort) {
                return Err("This Kimi model does not advertise the selected thinking setting. Choose another setting or use harness settings.".into());
            }
            step.write.push(json!({"jsonrpc":"2.0","id":6,"method":"session/set_config_option","params":{"sessionId":self.remote_id,"configId":"thinking","value":effort}}));
        } else {
            self.kimi_prompt(step);
        }
        Ok(())
    }
    fn kimi_prompt(&mut self, step: &mut Step) {
        let mut request = json!({"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"sessionId":self.remote_id}});
        request["params"]["prompt"] = Value::Array(self.prompt_content());
        step.write.push(request);
        self.phase = 1;
    }
    fn claude(&mut self, value: Value) -> Result<Step, String> {
        let mut step = Step::default();
        // Child transcripts share stdout but are not the parent's response.
        // Top-level Agent/Task tool results summarize that work; approvals still
        // flow through control_request so children cannot wait indefinitely.
        if matches!(
            field(&value, "type"),
            "stream_event" | "assistant" | "user" | "system"
        ) && !field(&value, "parent_tool_use_id").is_empty()
        {
            return Ok(step);
        }
        self.claude_turn_activity(&value);
        match string(&value, "type").as_str() {
            "control_response" => {
                let response = &value["response"];
                if response["request_id"] == "pandacode-init" {
                    if response["subtype"] == "error" {
                        return Err(string(response, "error"));
                    }
                    self.commands_changed(&value, &mut step);
                    crate::slash_commands::validate_claude_start(&self.config.prompt, &value)?;
                    if let Some(effort) = &self.config.reasoning_effort {
                        if let Ok(models) = parse_claude_models(&response["response"]) {
                            if let Some(model) =
                                models.iter().find(|model| model.id == self.config.model)
                            {
                                if !model
                                    .reasoning_efforts
                                    .iter()
                                    .any(|option| &option.id == effort)
                                {
                                    return Err(format!("The selected Claude model {MODEL_REFUSES_EFFORT}. Choose another effort or use harness settings."));
                                }
                            }
                        }
                    }
                    let content = if self.image_blocks.is_empty() {
                        Value::String(std::mem::take(&mut self.config.prompt))
                    } else {
                        Value::Array(self.prompt_content())
                    };
                    let mut request = json!({"type":"user","message":{"role":"user"},"parent_tool_use_id":null,"session_id":self.remote_id});
                    request["message"]["content"] = content;
                    step.write.push(request);
                    self.phase = 1;
                    self.claude_send_held(&mut step);
                }
            }
            "system" if value["subtype"] == "init" => {
                self.commands_changed(&value, &mut step);
                self.remote_id = string(&value, "session_id");
                step.events
                    .push(self.event("session", self.remote_id.clone(), None));
            }
            "system" if value["subtype"] == "commands_changed" => {
                self.commands_changed(&value, &mut step);
            }
            "system" if value["subtype"] == "background_tasks_changed" => {
                self.claude_background_tasks(&value);
            }
            "system" if value["subtype"] == "task_started" => {
                self.claude_task_started(&value);
            }
            "system" if matches!(field(&value, "subtype"), "hook_started" | "hook_response") => {
                self.claude_hook(&value);
            }
            "system" if matches!(field(&value, "subtype"), "task_notification" | "task_updated") => {
                self.claude_task_ended(&value);
            }
            "system" if value["subtype"] == "local_command_output" => {
                if let Some(text) = value["content"].as_str().filter(|text| !text.is_empty()) {
                    let id = value["uuid"]
                        .as_str()
                        .filter(|id| !id.is_empty())
                        .map(|id| format!("local-command:{}", limited(id, 240)))
                        .unwrap_or_else(|| self.next_text_id());
                    self.text_snapshot(&id, None, text, &mut step);
                    // The result may repeat the local output or provide its
                    // missing suffix. Reuse its digest rather than emitting it twice.
                    if step.events.iter().any(|event| event.kind == "text") {
                        self.claude_message_id = id;
                    }
                }
            }
            "system" if value["subtype"] == "compact_boundary" => {
                if value["compact_metadata"].is_object() {
                    let id = format!(
                        "compaction:{}",
                        limited(value["uuid"].as_str().unwrap_or("context"), 240)
                    );
                    self.tool_update(
                        &id,
                        Some("Compact context"),
                        Some("completed"),
                        None,
                        Some("Conversation context compacted.".into()),
                        &mut step,
                    );
                }
            }
            "system" if value["subtype"] == "status" && value["status"] == "compacting" => {
                step.events
                    .push(self.event("status", "Compacting context…", None));
            }
            "stream_event" => {
                let event = &value["event"];
                let parent = limited(field(&value, "parent_tool_use_id"), 256);
                if event["type"] == "message_start" {
                    self.claude_message_id.clear();
                    self.claude_text_id(&event["message"]);
                    self.partial_tools.retain(|(owner, _), _| owner != &parent);
                    if parent.is_empty() {
                        self.active_model = string(&event["message"], "model");
                        self.claude_usage(&event["message"]["usage"], true, &mut step);
                    }
                }
                if event["type"] == "message_delta" && parent.is_empty() {
                    self.claude_usage(&event["usage"], false, &mut step);
                }
                if event["type"] == "content_block_start"
                    && event["content_block"]["type"] == "text"
                {
                    let id = self.claude_text_id(&Value::Null);
                    self.text_delta(&id, None, field(&event["content_block"], "text"), &mut step);
                }
                if event["type"] == "content_block_start"
                    && event["content_block"]["type"] == "tool_use"
                {
                    let block = &event["content_block"];
                    let id = limited(field(block, "id"), 256);
                    if let Some(index) = event["index"].as_u64() {
                        if self.partial_tools.len() >= TOOL_CACHE_LIMIT {
                            if let Some(oldest) = self.partial_tools.keys().next().cloned() {
                                self.partial_tools.remove(&oldest);
                            }
                        }
                        self.partial_tools.insert(
                            (parent.clone(), index),
                            PartialTool {
                                id: id.clone(),
                                json: String::new(),
                            },
                        );
                    }
                    let input = block
                        .get("input")
                        .map(|input| preview_json(input, TOOL_INPUT_LIMIT));
                    self.tool_update(
                        &id,
                        block["name"].as_str(),
                        Some("running"),
                        input,
                        None,
                        &mut step,
                    );
                }
                if event["type"] == "content_block_delta"
                    && event["delta"]["type"] == "input_json_delta"
                {
                    if let Some(index) = event["index"].as_u64() {
                        if let Some(partial) = self.partial_tools.get_mut(&(parent.clone(), index))
                        {
                            append_preview(
                                &mut partial.json,
                                field(&event["delta"], "partial_json"),
                                TOOL_INPUT_LIMIT,
                            );
                        }
                    }
                }
                if event["type"] == "content_block_stop" {
                    if let Some(index) = event["index"].as_u64() {
                        if let Some(partial) = self.partial_tools.remove(&(parent, index)) {
                            if !partial.json.is_empty() {
                                let input = serde_json::from_str::<Value>(&partial.json)
                                    .map(|input| preview_json(&input, TOOL_INPUT_LIMIT))
                                    .unwrap_or(partial.json);
                                self.tool_update(
                                    &partial.id,
                                    None,
                                    Some("running"),
                                    Some(input),
                                    None,
                                    &mut step,
                                );
                            }
                        }
                    }
                }
                if event["type"] == "content_block_delta"
                    && event["delta"]["type"] == "thinking_delta"
                {
                    self.thinking(field(&event["delta"], "thinking"), &mut step);
                }
                if event["type"] == "content_block_delta" && event["delta"]["type"] == "text_delta"
                {
                    let id = self.claude_text_id(&Value::Null);
                    self.text_delta(&id, None, field(&event["delta"], "text"), &mut step);
                }
            }
            "assistant" => {
                let id = self.claude_text_id(&value["message"]);
                if field(&value, "parent_tool_use_id").is_empty()
                    && value["message"]["usage"].is_object()
                {
                    self.active_model = string(&value["message"], "model");
                    self.claude_usage(&value["message"]["usage"], true, &mut step);
                }
                if let Some(content) = value["message"]["content"].as_array() {
                    let mut text = String::new();
                    for block in content {
                        if block["type"] == "text" {
                            text.push_str(field(block, "text"));
                            self.text_snapshot(&id, None, &text, &mut step);
                        }
                        if block["type"] == "tool_use" {
                            self.tool_update(
                                field(block, "id"),
                                block["name"].as_str(),
                                Some("running"),
                                block
                                    .get("input")
                                    .map(|input| preview_json(input, TOOL_INPUT_LIMIT)),
                                None,
                                &mut step,
                            );
                            self.tool_paths(field(block, "id"), explicit_write_paths(field(block, "name"), &block["input"]), &mut step);
                        }
                    }
                }
            }
            "user" => {
                if !self.claude_notification_taken(&value) && value["isReplay"] == true {
                    self.claude_replay(&value["message"]["content"], &mut step);
                }
                if let Some(content) = value["message"]["content"].as_array() {
                    for block in content {
                        if block["type"] == "tool_result" {
                            self.tool_update(
                                field(block, "tool_use_id"),
                                None,
                                Some(if block["is_error"] == true {
                                    "failed"
                                } else {
                                    "completed"
                                }),
                                None,
                                Some(content_preview(&block["content"], TOOL_OUTPUT_LIMIT)),
                                &mut step,
                            );
                        }
                    }
                }
            }
            "control_request" => {
                if value["request"]["subtype"] == "can_use_tool" {
                    let name = string(&value["request"], "tool_name");
                    let command = string(&value["request"]["input"], "command");
                    // Questions need structured answers; a boolean allow must not silently submit one.
                    if name == "AskUserQuestion" {
                        step.write.push(json!({"type":"control_response","response":{"subtype":"success","request_id":value["request_id"],"response":{"behavior":"deny","message":"Ask the user in your response; this UI supports free-text replies."}}}));
                    } else if name.strip_prefix("mcp__pandacode_architect__").is_some_and(self_scoped_host_tool)
                        && self.mcp_tool_names.contains(&name)
                    {
                        // Registered metadata callbacks only stage this run's
                        // title or snapshot named paths. They cannot edit the checkout.
                        // Bot tools are registered only in a bot's own tasks and only
                        // touch that bot's memory, schedules and messages to its owner.
                        // Schedule tools here only wake or list this thread's own schedules.
                        // Team tools only exist in team turns and only change team state.
                        step.write.push(json!({"type":"control_response","response":{"subtype":"success","request_id":value["request_id"],"response":{"behavior":"allow","updatedInput":value["request"]["input"]}}}));
                    } else if self.config.mode == "plan" && plan_reads::plan_read_only(&name, &value["request"]["input"], &self.config.cwd) {
                        // Plan mode investigates: reads and web lookups anywhere run;
                        // Claude's own deny rules were applied before it asked.
                        step.write.push(json!({"type":"control_response","response":{"subtype":"success","request_id":value["request_id"],"response":{"behavior":"allow","updatedInput":value["request"]["input"]}}}));
                    } else {
                        self.approval(
                            value,
                            if command.is_empty() { name } else { command },
                            &mut step,
                        );
                    }
                } else {
                    step.write.push(json!({"type":"control_response","response":{"subtype":"error","request_id":value["request_id"],"error":"Control request unsupported"}}));
                }
            }
            "control_cancel_request" => {
                let cancelled: Vec<_> = self
                    .pending
                    .iter()
                    .filter(|(_, request)| request["request_id"] == value["request_id"])
                    .map(|(id, _)| id.clone())
                    .collect();
                for id in cancelled {
                    self.pending.remove(&id);
                    let mut event = self.event("approval_cancelled", "", None);
                    event.request_id = Some(id);
                    step.events.push(event);
                }
            }
            "rate_limit_event" => self.claude_rate_limit(&value, &mut step),
            "result" => {
                if let Some(used) = self
                    .claude_input_tokens
                    .and_then(|input| input.checked_add(self.claude_output_tokens))
                {
                    // modelUsage totals are cumulative billing. Only borrow the
                    // matching main model's window; keep per-message token usage.
                    if let Some(window) =
                        value["modelUsage"][&self.active_model]["contextWindow"].as_u64()
                    {
                        self.usage(used, Some(window), &mut step);
                    }
                }
                let session = string(&value, "session_id");
                if !session.is_empty() && self.remote_id != session {
                    self.remote_id = session;
                    step.events
                        .push(self.event("session", self.remote_id.clone(), None));
                }
                if value["is_error"] == true
                    || value["subtype"]
                        .as_str()
                        .unwrap_or_default()
                        .starts_with("error")
                {
                    let message = string(&value, "result");
                    return Err(if message.is_empty() {
                        value["errors"].to_string()
                    } else {
                        message
                    });
                }
                let text = field(&value, "result");
                if !text.is_empty() {
                    let id = self.claude_text_id(&Value::Null);
                    self.text_snapshot(&id, None, text, &mut step);
                }
                // Claude starts another turn in this process for a steer it has not echoed
                // and for a background agent's hand-back, so the run stays open for those.
                step.done = self.claude_turn_ended(&value, &mut step);
            }
            _ => {}
        }
        Ok(step)
    }
}

async fn write_json(stdin: &mut ChildStdin, value: &Value) -> Result<(), String> {
    let mut bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    // A large message over the cloud bridge drains in slow chunks; that is not a stuck harness.
    let patience = Duration::from_secs(5 + (bytes.len() / (256 * 1024)) as u64);
    tokio::time::timeout(patience, async {
        stdin.write_all(&bytes).await?;
        stdin.flush().await
    })
    .await
    .map_err(|_| "Provider stopped reading input; send timed out".to_owned())?
    .map_err(|e| format!("Could not send to provider: {e}"))
}

struct StderrReader(tokio::task::JoinHandle<String>);
impl Drop for StderrReader {
    fn drop(&mut self) {
        // A child can inherit stderr and outlive the CLI. A timeout or aborted
        // run must not leave a detached task holding that pipe indefinitely.
        self.0.abort();
    }
}

async fn read_stderr(mut stderr: impl tokio::io::AsyncRead + Unpin) -> String {
    let mut tail = Vec::new();
    let mut buf = [0u8; 2048];
    while let Ok(n) = stderr.read(&mut buf).await {
        if n == 0 {
            break;
        }
        tail.extend_from_slice(&buf[..n]);
        if tail.len() > STDERR_LIMIT {
            tail.drain(..tail.len() - STDERR_LIMIT);
        }
    }
    String::from_utf8_lossy(&tail).trim().to_owned()
}

fn process_registry() -> &'static Mutex<HashSet<u32>> {
    static GROUPS: OnceLock<Mutex<HashSet<u32>>> = OnceLock::new();
    GROUPS.get_or_init(|| Mutex::new(HashSet::new()))
}

pub(crate) fn kill_group(pid: u32) {
    #[cfg(unix)]
    unsafe {
        libc::kill(-(pid as i32), libc::SIGKILL);
    }
    #[cfg(windows)]
    {
        if windows_job::terminate(pid) {
            return;
        }
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .creation_flags(0x08000000)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

/// Call immediately before forced application exit, which skips Rust destructors.
pub fn shutdown_all() {
    let owned: Vec<_> = process_registry()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .drain()
        .collect();
    for pid in owned {
        kill_group(pid);
    }
}

pub(crate) struct ProcessGroup(Option<u32>);
impl ProcessGroup {
    pub(crate) fn register(pid: Option<u32>) -> Self {
        if let Some(pid) = pid {
            #[cfg(windows)]
            windows_job::register(pid);
            process_registry()
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .insert(pid);
            // Stopped by the crash guard if the app dies before it can.
            if let Err(error) = crate::crash_guard::child_started(pid) {
                eprintln!("Agent process group {pid}: {error}");
            }
        }
        Self(pid)
    }
}
impl Drop for ProcessGroup {
    fn drop(&mut self) {
        if let Some(pid) = self.0 {
            if process_registry()
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .remove(&pid)
            {
                kill_group(pid);
                if let Err(error) = crate::crash_guard::child_ended(pid) {
                    eprintln!("Agent process group {pid}: {error}");
                }
            }
        }
    }
}

async fn finish_child(child: &mut Child, stdin: ChildStdin, group: &mut ProcessGroup, grace: Duration) {
    drop(stdin);
    if tokio::time::timeout(grace, child.wait())
        .await
        .is_err()
    {
        #[cfg(unix)]
        if let Some(pid) = group.0 {
            unsafe {
                libc::kill(-(pid as i32), libc::SIGTERM);
            }
        }
        if tokio::time::timeout(Duration::from_millis(500), child.wait())
            .await
            .is_err()
        {
            let _ = child.kill().await;
        }
    }
    // Also clean up provider-created background processes, including orphaned children.
    let cleanup = ProcessGroup(group.0.take());
    drop(cleanup);
}

/// Antigravity's Windows build unpacks 150-250 MB into `%TEMP%\\_MEI*` and removes it only on a
/// clean exit, which a forced kill skips. So it gets its own `TEMP`, deleted when this drops.
pub(crate) struct AgentTemp(PathBuf);
impl AgentTemp {
    /// None off Windows, or if the folder cannot be made: the agent then uses the system `TEMP`.
    pub(crate) fn redirect(command: &mut Command) -> Option<Self> {
        if !cfg!(windows) {
            return None;
        }
        let root = crate::secret_store::dir()?.join(AGENT_TEMP_DIR);
        static SWEPT: std::sync::Once = std::sync::Once::new();
        SWEPT.call_once(|| Self::sweep(&root));
        let temp = Self::create_in(&root)?;
        command.env("TEMP", &temp.0).env("TMP", &temp.0);
        Some(temp)
    }
    /// Folders left by a crash or a quit. Only old ones: `pandacode serve` has no single-instance
    /// guard, so another process's agent can be using a recent one.
    fn sweep(root: &Path) {
        for entry in std::fs::read_dir(root).into_iter().flatten().flatten() {
            let age = entry.metadata().and_then(|meta| meta.modified()).ok().and_then(|time| time.elapsed().ok());
            if age.is_some_and(|age| age > AGENT_TEMP_MAX_AGE) {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }
    /// Private to this user: discovery runs in one, where a planted file must not be readable as config.
    fn create_in(root: &Path) -> Option<Self> {
        let dir = root.join(uuid::Uuid::new_v4().to_string());
        let mut builder = std::fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
        builder.create(&dir).ok()?;
        Some(Self(dir))
    }
}
impl Drop for AgentTemp {
    fn drop(&mut self) {
        let dir = std::mem::take(&mut self.0);
        // Windows holds a killed process's files for a moment. Off the async workers.
        std::thread::spawn(move || {
            for _ in 0..5 {
                if std::fs::remove_dir_all(&dir).is_ok() || !dir.exists() {
                    return;
                }
                std::thread::sleep(Duration::from_secs(1));
            }
        });
    }
}

struct Lingering {
    /// Canonical, for `end_lingering_in`.
    cwd: PathBuf,
    agent: tokio::task::JoinHandle<()>,
}

/// Agents past their turn, still finishing background work, by task.
fn lingering() -> &'static Mutex<HashMap<String, Lingering>> {
    static AGENTS: OnceLock<Mutex<HashMap<String, Lingering>>> = OnceLock::new();
    AGENTS.get_or_init(Default::default)
}

/// Gives a finished agent `ANTIGRAVITY_GRACE` to exit by itself, without holding the turn open.
/// Its group stays in the process registry, so app quit still kills it, and its pipes stay read,
/// because an agent that writes to a closed pipe would die on the spot.
#[allow(clippy::too_many_arguments)]
fn linger_agent(
    session_id: String,
    cwd: &Path,
    mut child: Child,
    stdin: ChildStdin,
    mut stdout: tokio::process::ChildStdout,
    stderr: StderrReader,
    mut group: ProcessGroup,
    temp: Option<AgentTemp>,
) {
    let agent = tokio::spawn(async move {
        let (_stderr, _temp) = (stderr, temp);
        // In this task, so an abort stops the drain too. It never ends the select: an agent can
        // close stdout and keep working.
        let drain = async move {
            let _ = tokio::io::copy(&mut stdout, &mut tokio::io::sink()).await;
            std::future::pending::<()>().await
        };
        tokio::select! {
            () = finish_child(&mut child, stdin, &mut group, ANTIGRAVITY_GRACE) => {}
            () = drain => {}
        }
    });
    let cwd = cwd.canonicalize().unwrap_or_else(|_| cwd.to_owned());
    let mut agents = lingering().lock().unwrap_or_else(|p| p.into_inner());
    agents.retain(|_, lingering| !lingering.agent.is_finished());
    agents.insert(session_id, Lingering { cwd, agent });
}

/// Ends the task's lingering agent. Its next turn must not share the conversation store with it.
/// Dropping the aborted task kills the group and removes its temp folder.
pub(crate) async fn end_lingering(session_id: &str) {
    let lingering = lingering().lock().unwrap_or_else(|p| p.into_inner()).remove(session_id);
    if let Some(Lingering { agent, .. }) = lingering {
        agent.abort();
        let _ = agent.await;
    }
}

/// Ends every lingering agent working in `folder`, whichever task it belongs to, before the folder
/// is removed: on Windows a process's working directory cannot be deleted.
pub(crate) async fn end_lingering_in(folder: &Path) {
    let folder = folder.canonicalize().unwrap_or_else(|_| folder.to_owned());
    let tasks: Vec<String> = lingering()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .iter()
        .filter(|(_, lingering)| lingering.cwd.starts_with(&folder))
        .map(|(task, _)| task.clone())
        .collect();
    for task in tasks {
        end_lingering(&task).await;
    }
}

// Protocol fixture entry point.
#[cfg(test)]
#[allow(dead_code)]
pub async fn run(
    config: RunConfig,
    sink: Sink,
    input: UnboundedReceiver<RunInput>,
) -> Result<(), String> {
    run_with_tools(config, sink, input, None, Default::default()).await
}

tokio::task_local! {
    static HARNESS: Arc<std::sync::atomic::AtomicBool>;
    /// Set when the run's own loop takes a `RunInput::Stop` (`stop_taken`): its owner then knows
    /// the stop, not the harness, ended the turn.
    static STOP_TAKEN: Arc<std::sync::atomic::AtomicBool>;
}

/// The run's loop took a stop. Every loop that takes `RunInput::Stop` calls this (and still
/// reports `STOPPING_STATUS` for the window).
pub(crate) fn stop_taken() {
    let _ = STOP_TAKEN.try_with(|taken| taken.store(true, std::sync::atomic::Ordering::SeqCst));
}

#[cfg(test)]
tokio::task_local! {
    static TEST_STARTUP_STEP: Duration;
}

fn startup_step() -> Duration {
    #[cfg(test)]
    if let Ok(step) = TEST_STARTUP_STEP.try_with(|step| *step) {
        return step;
    }
    STARTUP_STEP
}

fn startup_deadline(started: tokio::time::Instant, now: tokio::time::Instant, step: Duration) -> tokio::time::Instant {
    (now + step).min(started + STARTUP_LIMIT)
}

fn startup_timeout_error(waited: Duration, answered: bool) -> String {
    let state = if answered {
        "the agent stopped answering while its session was opening"
    } else {
        "the agent never answered after it was launched"
    };
    format!("Agent initialization timed out after {} s: {state}. A first run or a busy computer can be this slow, so send again. If it keeps happening, check the CLI's login and configuration in a terminal.", waited.as_secs())
}

/// Marks the run as having reached the harness: from here an error is the harness's (its CLI is
/// missing, it could not start, or its process or session failed), so it counts for model health.
/// PandaCode's own preflight (validation, attachments, connections, tools) fails before this.
fn reached_harness() {
    let _ = HARNESS.try_with(|reached| reached.store(true, std::sync::atomic::Ordering::SeqCst));
}

/// `harness` is set once the run reaches the harness (`reached_harness`). Tests' entry point;
/// the app runs `run_with_tools_reporting`.
#[cfg(test)]
pub async fn run_with_tools(
    config: RunConfig,
    sink: Sink,
    input: UnboundedReceiver<RunInput>,
    host: Option<ToolHost>,
    harness: Arc<std::sync::atomic::AtomicBool>,
) -> Result<(), String> {
    run_with_tools_reporting(config, sink, input, host, harness, Default::default()).await
}

/// `run_with_tools`, also setting `taken` once the run's loop takes a stop (`stop_taken`).
pub async fn run_with_tools_reporting(
    config: RunConfig,
    sink: Sink,
    input: UnboundedReceiver<RunInput>,
    host: Option<ToolHost>,
    harness: Arc<std::sync::atomic::AtomicBool>,
    taken: Arc<std::sync::atomic::AtomicBool>,
) -> Result<(), String> {
    // Refreshes the task's project for its switches: a SQLite read, kept off the runtime.
    let (session_id, cwd) = (config.session_id.clone(), config.cwd.clone());
    if let Err(error) = crate::blocking(move || {
        crate::skill_manager::begin_launch_at(&session_id, &cwd);
        Ok(())
    })
    .await
    {
        eprintln!("Warning: could not refresh the skill settings project: {error}");
    }
    let identity = Protocol::new(config.clone());
    sink(identity.event("status", "Starting agent", None));
    // A goal operation is acknowledged by its own turn, so it is never continued elsewhere.
    let pooled = config.goal.is_none() && crate::account_pool::enabled(&config.provider) && !crate::cloud_agents::transport::is_cloud(&config.session_id);
    let result = if pooled {
        STOP_TAKEN.scope(taken, HARNESS.scope(harness, pool::run(config, sink.clone(), input, host))).await
    } else {
        STOP_TAKEN.scope(taken, HARNESS.scope(harness, run_inner(config, sink.clone(), input, host))).await
    };
    if let Err(error) = &result {
        sink(identity.event("error", error.clone(), None));
    }
    sink(identity.event(
        "done",
        if result.is_ok() { "Finished" } else { "Failed" },
        None,
    ));
    result
}

/// Codex refuses subagents past this (`AgentLimitReached`, no row, no report); a task's children have no cap of ours.
/// The old name on purpose: 0.145+ renamed it to `max_concurrent_threads_per_session` and keep this as a serde alias,
/// while 0.144 and older read the new name as an agent role and refuse to start.
const CODEX_NO_THREAD_LIMIT: &str = "agents.max_threads=1024";

/// Whether the user's Codex config (the home this launch uses, or the project's) sets the limit;
/// `max_threads` is its older name. Their choice stands, and a `-c` would override it.
fn codex_user_limits_threads(command: &Command, config: &RunConfig) -> bool {
    let connection = crate::connections::for_task(&config.session_id, "codex");
    let own = connection.and_then(|connection| connection.config_dir.or_else(|| connection.env.get("CODEX_HOME").cloned())).map(std::ffi::OsString::from);
    let set = command.as_std().get_envs().find(|(name, _)| *name == "CODEX_HOME").and_then(|(_, value)| value.map(ToOwned::to_owned));
    let home = own.or(set).or_else(|| std::env::var_os("CODEX_HOME")).map(PathBuf::from)
        .or_else(|| crate::agent_usage_providers::home().map(|home| home.join(".codex")));
    home.into_iter().chain([Path::new(&config.cwd).join(".codex")]).any(|dir| {
        let Some(text) = std::fs::read_to_string(dir.join("config.toml")).ok() else { return false };
        let Ok(toml) = text.parse::<toml::Table>() else { return false };
        toml.get("agents").and_then(toml::Value::as_table).is_some_and(|agents| agents.contains_key("max_concurrent_threads_per_session") || agents.contains_key("max_threads"))
    })
}

#[cfg(test)]
fn configure_command(command: &mut Command, config: &RunConfig) {
    configure_command_with_skills(command, config, &Default::default());
}

/// Lists OpenCode's agents for this launch itself; `run_inner` passes its one scan instead.
fn configure_command_with_skills(
    command: &mut Command,
    config: &RunConfig,
    disabled: &std::collections::BTreeSet<String>,
) {
    let agents = (config.provider == "opencode")
        .then(|| crate::skill_manager::opencode_agents_at(disabled, &config.cwd));
    configure_command_with_agents(command, config, disabled, &agents.unwrap_or_default());
}

fn configure_command_with_agents(
    command: &mut Command,
    config: &RunConfig,
    disabled: &std::collections::BTreeSet<String>,
    opencode_agents: &crate::skill_manager::OpenCodeAgents,
) {
    claude_auth::configure(command, &config.provider);
    let use_model = !config.model.is_empty() && config.model != "default";
    match config.provider.as_str() {
        "codex" => {
            // Process-local override: never alter the user's Codex config.
            command.args(["app-server", "--enable", "goals"]);
            command.args(crate::skill_manager::codex_arguments(disabled));
            if !codex_user_limits_threads(command, config) {
                command.args(["-c", CODEX_NO_THREAD_LIMIT]);
            }
        }
        "pi" | "omp" => pi::configure(command, config),
        "zcode" => zcode::configure(command),
        "muse" => muse::configure(command, config),
        "opencode" | "antigravity" | "grok" | "deepseek" | "commandcode" | "cline" | "kilo" => acp::configure(command, config),
        "github-copilot" | "devin" | "hermes" => acp::configure(command, config),
        "kimi" => {
            if use_model {
                command.args(["--model", &config.model]);
            }
            command.arg("acp");
        }
        _ => {
            command.args([
                "-p",
                "--input-format",
                "stream-json",
                "--output-format",
                "stream-json",
                "--include-partial-messages",
                "--verbose",
                "--permission-prompt-tool",
                "stdio",
                // Echo consumed user messages so steering knows when a mid-turn message was taken.
                "--replay-user-messages",
            ]);
            // Shows a slow UserPromptSubmit hook as the owed turn starting, not a silent process.
            if claude_lists_hook_events(command) {
                command.arg("--include-hook-events");
            }
            let permission_mode = match config.mode.as_str() {
                "auto" => "acceptEdits",
                // Claude Code's auto mode: its safety reviewer approves routine actions.
                "review" => "auto",
                "plan" => "plan",
                "full" => "bypassPermissions",
                _ => "default",
            };
            // Always override the resumed session's mode, including when the
            // user has moved from full access back to standard approvals.
            command.args(["--permission-mode", permission_mode]);
            if config.mode == "full" {
                command.arg("--allow-dangerously-skip-permissions");
            }
            // These wait on a live session; PandaCode's process ends with the turn.
            command.arg(format!(
                "--disallowedTools={}",
                crate::skill_manager::claude_disallowed(CLAUDE_SESSION_BOUND_TOOLS, disabled)
            ));
            if use_model {
                command.args(["--model", &config.model]);
            } else if config.provider == "glm" {
                command.args(["--model", glm::DEFAULT_MODEL]);
            } else if config.provider == "mimo" {
                command.args(["--model", mimo::DEFAULT_MODEL]);
            } else if config.provider == "alibaba" {
                command.args(["--model", alibaba::DEFAULT_MODEL]);
            }
            if let Some(effort) = &config.reasoning_effort {
                command.args(["--effort", effort]);
            }
            // The Speed row stores Claude's fast mode as the task's service tier.
            if config.provider == "claude"
                && config.codex_settings.as_ref().is_some_and(|settings| settings["serviceTier"] == "fast")
            {
                command.args(["--settings", r#"{"fastMode":true}"#]);
            }
            if let Some(id) = &config.resume_id {
                command.arg(format!("--resume={id}"));
            }
            if !config.instructions.is_empty() {
                command.args(["--append-system-prompt", &config.instructions]);
            }
            command.env_remove("CLAUDECODE");
        }
    }
    if config.provider == "opencode" {
        command.env(
            "OPENCODE_CONFIG_CONTENT",
            crate::skill_manager::opencode_enforcement_with(
                &opencode_configuration(&config.mode),
                disabled,
                opencode_agents,
            ),
        );
    }
}

/// The connection may have replaced the inline configuration: deny again for the same agents.
/// The denies also always go through `OPENCODE_PERMISSION` (kept rules, merged last by OpenCode).
/// Text that can't be read stays untouched and the launch also asks, as for names OpenCode can't deny.
fn enforce_opencode_after_connection(
    command: &mut Command,
    config: &mut RunConfig,
    disabled: &std::collections::BTreeSet<String>,
    agents: &crate::skill_manager::OpenCodeAgents,
) {
    let variable = |name: &str| {
        command
            .as_std()
            .get_envs()
            .find(|(key, _)| *key == name)
            .map(|(_, value)| value.and_then(|value| value.to_str()).map(str::to_owned))
            .unwrap_or_else(|| std::env::var(name).ok())
    };
    let inline = variable("OPENCODE_CONFIG_CONTENT").unwrap_or_else(|| "{}".into());
    let permission = variable("OPENCODE_PERMISSION");
    let launch = crate::skill_manager::opencode_launch_with(
        &inline,
        permission.as_deref(),
        disabled,
        agents,
    );
    command.env("OPENCODE_CONFIG_CONTENT", launch.content);
    if let Some(permission) = launch.permission {
        command.env("OPENCODE_PERMISSION", permission);
    }
    if !launch.enforced {
        crate::skill_manager::remind_unenforced(config, disabled);
    }
}

async fn run_inner(
    mut config: RunConfig,
    sink: Sink,
    input: UnboundedReceiver<RunInput>,
    host: Option<ToolHost>,
) -> Result<(), String> {
    if ![
        "claude",
        "codex",
        "kimi",
        "opencode",
        "glm",
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
    ]
    .contains(&config.provider.as_str())
    {
        return Err("Unknown provider".into());
    }
    if !crate::storage::valid_permission_mode(&config.mode) {
        return Err("Unknown permission mode".into());
    }
    review_supported(&config.provider, &config.mode)?;
    validate_reasoning_effort(&config.provider, config.reasoning_effort.as_deref())?;
    // Switches, the installed-skill scan and OpenCode's agent files are read off the runtime.
    // Unrecoverable switches never refuse a launch: they deny or ask (`launch_disabled`).
    let (prepared, disabled, opencode_agents) = crate::blocking(move || {
        let disabled = crate::skill_manager::launch_disabled(
            &config.provider,
            &config.cwd,
            crate::skill_manager::disabled_for(&config.session_id),
        );
        // Refuses a typed switched-off skill before anything is sent, then adds reminders.
        crate::skill_manager::prepare_turn(&mut config, &disabled)?;
        // OpenCode's agents are listed once and reused by every configuration below.
        let agents = if config.provider == "opencode" {
            crate::skill_manager::opencode_agents_at(&disabled, &config.cwd)
        } else {
            Default::default()
        };
        // Some agent could not be given the denies: ask instead, as for names OpenCode can't deny.
        if config.provider == "opencode" && !agents.complete && !disabled.is_empty() {
            crate::skill_manager::remind_unenforced(&mut config, &disabled);
        }
        Ok((config, disabled, agents))
    })
    .await?;
    config = prepared;
    // A cloud task runs the same pipeline through a bridge to its machine; local MCP host
    // tools stay on this computer (docs/cloud-agents.md, step 5).
    if let Some(command) = crate::cloud_agents::transport::command(&config, |command| {
        crate::blocking_snapshot(|| {
            configure_command_with_agents(command, &config, &disabled, &opencode_agents)
        })
    })
    .await?
    {
        return run_process_with_tools(config, sink, input, command, Vec::new(), None).await;
    }
    let mut connection = crate::connections::for_task(&config.session_id, &config.provider)
        .map(|connection| crate::connections::launch(&connection))
        .transpose()?;
    let path = connection
        .as_ref()
        .and_then(|connection| connection.executable.clone())
        .or_else(|| executable(&config.provider))
        .ok_or_else(|| {
            reached_harness();
            format!("{} CLI is not installed or is not on PATH", config.provider)
        })?;
    config.cwd = external_path(&config.cwd);
    let image_blocks = attachments::load(&config.provider, &config.images).await?;
    let mut command = provider_command(&config.provider, &path)?;
    let mut command = {
        let (config, disabled, agents) =
            (config.clone(), disabled.clone(), opencode_agents.clone());
        crate::blocking(move || {
            configure_command_with_agents(&mut command, &config, &disabled, &agents);
            Ok(command)
        })
        .await?
    };
    // A named connection's arguments and environment win over the global setup.
    if let Some(connection) = &connection {
        connection.apply(&mut command);
        // A connection's own `-c skills.config=…` can't override the switches: merged, manager last.
        if config.provider == "codex" {
            command.args(crate::skill_manager::codex_connection_arguments(
                &connection.args,
                &disabled,
            ));
        }
    }
    if config.provider == "opencode" && !disabled.is_empty() {
        enforce_opencode_after_connection(&mut command, &mut config, &disabled, &opencode_agents);
    }
    if config.provider == "kilo" {
        let inline = kilo::configure_environment(&mut command, &config);
        if let Some(connection) = &mut connection {
            connection.secrets.push(inline);
        }
    }
    let key = if config.provider == "glm" {
        Some(glm::configure(&mut command)?)
    } else if config.provider == "mimo" {
        Some(mimo::configure(&mut command)?)
    } else if config.provider == "alibaba" {
        Some(alibaba::configure(&mut command)?)
    } else if config.provider == "deepseek" {
        deepseek::configure(&mut command)?
    } else if config.provider == "commandcode" {
        commandcode::key_environment(&mut command)
    } else {
        None
    };
    run_process_with_tools(
        config,
        sink,
        input,
        command,
        image_blocks,
        host,
    )
    .await
    .map_err(|error| {
        let error = key
            .as_ref()
            .map_or(error.clone(), |key| error.replace(key, "[redacted]"));
        connection.as_ref().map_or(error.clone(), |connection| connection.redact(&error))
    })
}

#[cfg(all(test, unix))]
async fn run_process(
    config: RunConfig,
    sink: Sink,
    input: UnboundedReceiver<RunInput>,
    command: Command,
    image_blocks: Vec<Value>,
) -> Result<(), String> {
    run_process_with_tools(config, sink, input, command, image_blocks, None).await
}

/// Host tools that need no permission prompt once registered for the run.
fn self_scoped_host_tool(name: &str) -> bool {
    optional_metadata_tool(name) || crate::bots::tools::self_scoped(name) || crate::schedules::tools::self_scoped(name) || crate::architect::team_tool(name)
}
fn optional_metadata_tool(name: &str) -> bool {
    name == crate::session_titles::TOOL || name == crate::turn_changes::TRACK_TOOL
}
// Preview, simulator, VM, design, cloud deploy, Jev, and bot tools are optional
// transport capabilities, but retain their normal approval requirements and transcript
// activity. They are not metadata tools.
fn optional_transport_tool(name: &str) -> bool {
    optional_metadata_tool(name)
        || matches!(
            name,
            "pandacode_run_project" | "pandacode_preview_file" | "pandacode_cloud_cli"
        )
        || name.starts_with("pandacode_simulator_")
        || name.starts_with("pandacode_vm_")
        || name.starts_with("pandacode_design_")
        || name.starts_with("pandacode_jev_")
        || name.starts_with("pandacode_bot_")
}
fn per_run_mcp_tool(name: &str) -> bool {
    name.starts_with("pandacode_jev_")
        || optional_metadata_tool(name)
        || matches!(name, "pandacode_run_project" | "pandacode_preview_file")
}

fn split_jev_host(host: Option<ToolHost>) -> (Option<ToolHost>, Option<ToolHost>) {
    let Some(mut host) = host else {
        return (None, None);
    };
    let (jev, other): (Vec<_>, Vec<_>) = host.tools.into_iter().partition(|tool| {
        tool["name"]
            .as_str()
            .is_some_and(per_run_mcp_tool)
    });
    host.tools = other;
    if jev.is_empty() {
        return (Some(host), None);
    }
    let protected = host
        .approval_tools
        .iter()
        .filter(|name| per_run_mcp_tool(name))
        .cloned()
        .collect();
    host.approval_tools
        .retain(|name| !per_run_mcp_tool(name));
    let jev = ToolHost {
        tools: jev,
        approval_tools: protected,
        handler: host.handler.clone(),
    };
    ((!host.tools.is_empty()).then_some(host), Some(jev))
}

async fn run_process_with_tools(
    config: RunConfig,
    sink: Sink,
    mut input: UnboundedReceiver<RunInput>,
    mut command: Command,
    image_blocks: Vec<Value>,
    host: Option<ToolHost>,
) -> Result<(), String> {
    let mcp_tool_names: HashSet<String> = {
        host.as_ref()
            .into_iter()
            .flat_map(|host| host.tools.iter())
            .filter_map(|spec| spec["name"].as_str())
            .filter(|name| config.provider != "codex" || per_run_mcp_tool(name))
            .flat_map(|name| [name.into(), format!("mcp__pandacode_architect__{name}")])
            .collect()
    };
    // A warm agent started after the task's last turn: same launch, tools already listed.
    let mut spare = match &host {
        Some(tools) if warm::supported(&config) => {
            // The key reads the task's switches and saved settings: off the runtime.
            let (keyed, catalog) = (config.clone(), tools.tools.clone());
            let key = crate::blocking(move || Ok(warm::key(&keyed, &catalog))).await?;
            warm::take(&config.session_id, &key)
        }
        _ => {
            warm::launched(&config.session_id);
            None
        }
    };
    let (host, mcp) = match (config.provider.as_str(), host) {
        ("claude", Some(host)) if spare.is_some() => {
            let server = spare.as_mut().and_then(|spare| spare.server.take());
            if let Some(server) = &server {
                server.rebind(host, config.session_id.clone(), sink.clone(), &config.mode)?;
            }
            (None, server)
        }
        ("codex", host) => {
            // Dynamic tools are fixed at thread creation. A per-run MCP override
            // adds optional tools and title metadata to resumed conversations
            // without discarding their history.
            let (host, jev) = split_jev_host(host);
            let server = if let Some(jev) = jev {
                mcp_host::Server::start_for_run(
                    jev,
                    config.session_id.clone(),
                    sink.clone(),
                    &config.mode,
                )
                .await?
            } else {
                None
            };
            (host.map(host_tools::HostTools::new).transpose()?, server)
        }
        (
            "claude" | "glm" | "mimo" | "alibaba" | "kimi" | "opencode" | "antigravity" | "grok" | "pi"
            | "deepseek" | "commandcode" | "cline" | "kilo" | "omp" | "github-copilot" | "muse" | "devin" | "hermes",
            Some(host),
        ) => (
            None,
            mcp_host::Server::start_for_run(
                host,
                config.session_id.clone(),
                sink.clone(),
                &config.mode,
            )
            .await?,
        ),
        // ZCode bridging does not pass `mcpServers` in session/create yet, so a
        // started server would sit unconsumed; drop host tools until it does.
        ("zcode", Some(_)) => (None, None),
        (_, None) => (None, None),
        _ => return Err("Host tools are unavailable for this provider".into()),
    };
    let _pi_bridge = if matches!(config.provider.as_str(), "pi" | "omp") {
        Some(pi::Bridge::configure(&mut command, &config.mode, mcp.as_ref())?)
    } else { None };
    let cline_settings = match &mcp {
        Some(server) if config.provider == "cline" && !crate::cloud_agents::transport::is_cloud(&config.session_id) => {
            match cline::mcp_settings(&mut command, &server.kimi_config()) {
                Ok(folder) => Some(folder),
                Err(error) if server.required() => return Err(error),
                Err(_) => None,
            }
        }
        _ => None,
    };
    reached_harness();
    let lingers = config.provider == "antigravity" && !crate::cloud_agents::transport::is_cloud(&config.session_id);
    let mut agent_temp = None;
    let (mut child, mut group) = if let Some(spare) = spare {
        (spare.child, spare.group)
    } else {
        if lingers {
            end_lingering(&config.session_id).await;
            agent_temp = AgentTemp::redirect(&mut command);
        }
        if matches!(config.provider.as_str(), "claude" | "glm" | "mimo" | "alibaba") {
            if let Some(server) = &mcp {
                command.args(["--mcp-config", &server.claude_config().to_string()]);
            }
        }
        command
            .current_dir(&config.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(unix)]
        command.process_group(0);
        let child = command
            .spawn()
            .map_err(|e| format!("Could not start {}: {e}", config.provider))?;
        let group = ProcessGroup::register(child.id());
        (child, group)
    };
    let mut stdin = child.stdin.take().ok_or("Provider stdin unavailable")?;
    let mut stdout = child.stdout.take().ok_or("Provider stdout unavailable")?;
    let stderr = child.stderr.take().ok_or("Provider stderr unavailable")?;
    let mut stderr_task = StderrReader(tokio::spawn(read_stderr(stderr)));
    let mut protocol = Protocol::new(config);
    if crate::cloud_agents::transport::is_cloud(&protocol.config.session_id) {
        protocol.claude_over_cloud();
    }
    protocol.image_blocks = image_blocks;
    protocol.host = host;
    // Cline already has the server from its settings file, not from `session/new`.
    protocol.mcp_server = mcp.as_ref().filter(|_| cline_settings.is_none()).map(mcp_host::Server::kimi_config);
    protocol.mcp_required = mcp.as_ref().is_some_and(mcp_host::Server::required);
    protocol.codex_mcp_servers = mcp
        .as_ref()
        .filter(|_| protocol.config.provider == "codex")
        .map(mcp_host::Server::codex_config);
    // An optional bridge can fail to bind. In that case no local MCP tool is
    // registered, so a same-named user server must retain normal approvals.
    protocol.mcp_tool_names = if mcp.is_some() { mcp_tool_names } else { HashSet::new() };
    let mut jobs = tokio::task::JoinSet::new();
    let mut queued = VecDeque::new();
    let mut bytes = Vec::new();
    let mut buf = [0u8; 8192];
    let mut stopped = false;
    let mut input_open = true;
    let started = tokio::time::Instant::now();
    let step_limit = startup_step();
    let mut deadline = startup_deadline(started, started, step_limit);
    let mut answered = false;
    let result=async {
        write_json(&mut stdin,&protocol.initial()).await?;
        if protocol.config.provider == "antigravity" {
            sink(protocol.event("status", "Waiting for Antigravity startup", None));
        }
        loop {
            tokio::select! {
                action=input.recv(),if input_open && !stopped=>{
                    match action {
                        Some(RunInput::Goal{request,reply})=>{let step=protocol.goal_control(request,reply);if apply_step(&mut protocol,step,&sink,&mut stdin,&mut jobs,&mut queued).await? {return Ok(());}},
                        Some(RunInput::CodexRequest{method,params,reply})=>{let step=protocol.codex_control(method,params,reply);apply_step(&mut protocol,step,&sink,&mut stdin,&mut jobs,&mut queued).await?;},
                        Some(RunInput::Steer{id,text,reply})=>{let step=protocol.steer(id,text,reply);apply_step(&mut protocol,step,&sink,&mut stdin,&mut jobs,&mut queued).await?;},
                        Some(RunInput::Approval{request_id,approved})=>{if !mcp.as_ref().is_some_and(|server|server.approve(&request_id,approved)) {let step=protocol.approval_step(&request_id,approved); apply_step(&mut protocol,step,&sink,&mut stdin,&mut jobs,&mut queued).await?;}},
                        Some(RunInput::UserInput{request_id,response,reply})=>{
                            match if protocol.config.provider=="muse" {protocol.muse_user_input(&request_id,response)} else {protocol.user_input(&request_id,response)} {
                                Ok(step)=>{let result=apply_step(&mut protocol,step,&sink,&mut stdin,&mut jobs,&mut queued).await.map(|_|());if let Some(reply)=reply {let _=reply.send(result.clone());}result?;},
                                Err(error)=>{if let Some(reply)=reply {let _=reply.send(Err(error));}},
                            }
                        },
                        Some(RunInput::Stop)|None=>{
                            if let Some(server) = &mcp { server.stop(); }
                            if let Some(step)=protocol.stop_goal() {
                                input_open=false;
                                stop_taken();sink(protocol.event("status",PAUSING_GOAL_STATUS,None));
                                jobs.abort_all(); queued.clear();
                                let cancel=protocol.cancel_requests();
                                apply_step(&mut protocol,cancel,&sink,&mut stdin,&mut jobs,&mut queued).await?;
                                if apply_step(&mut protocol,step,&sink,&mut stdin,&mut jobs,&mut queued).await? {return Ok(());}
                                continue;
                            }
                            input_open=false;stopped=true;stop_taken();sink(protocol.event("status",STOPPING_STATUS,None));
                            jobs.abort_all(); queued.clear();
                            let step=protocol.cancel_requests();
                            let _=tokio::time::timeout(Duration::from_millis(500),apply_step(&mut protocol,step,&sink,&mut stdin,&mut jobs,&mut queued)).await;
                            let _=tokio::time::timeout(Duration::from_millis(500),write_json(&mut stdin,&protocol.cancel())).await;deadline=tokio::time::Instant::now()+Duration::from_secs(3);
                        },
                    }
                },
                completed=jobs.join_next(),if !jobs.is_empty() && !stopped=>{
                    let (id,response)=completed.ok_or("Host tool task disappeared")?.map_err(|_|"Host tool task failed")?;
                    if protocol.host.as_mut().is_some_and(|host|host.finish(&id)) {
                        host_tools::write_response(&mut stdin,&response).await?;
                    }
                    apply_step(&mut protocol,Step::default(),&sink,&mut stdin,&mut jobs,&mut queued).await?;
                },
                _=tokio::time::sleep_until(deadline),if stopped || protocol.phase==0=>{
                    if stopped{break Ok(());}break Err(startup_timeout_error(started.elapsed(),answered));
                },
                _=tokio::time::sleep_until(protocol.approval_deadline().unwrap_or_else(||tokio::time::Instant::now()+Duration::from_secs(86400))),if !stopped && protocol.approval_deadline().is_some()=>{
                    let step=protocol.expire_approvals(tokio::time::Instant::now());
                    apply_step(&mut protocol,step,&sink,&mut stdin,&mut jobs,&mut queued).await?;
                },
                _=tokio::time::sleep_until(protocol.claude_grace().unwrap_or_else(||tokio::time::Instant::now()+Duration::from_secs(86400))),if !stopped && protocol.claude_grace().is_some()=>{
                    let step=protocol.claude_wait_over();
                    if apply_step(&mut protocol,step,&sink,&mut stdin,&mut jobs,&mut queued).await? {return Ok(());}
                },
                _=tokio::time::sleep_until(protocol.subagent_flush_at().unwrap_or_else(||tokio::time::Instant::now()+Duration::from_secs(86400))),if !stopped && protocol.subagent_flush_at().is_some()=>{
                    let step=protocol.flush_subagents(false);
                    apply_step(&mut protocol,step,&sink,&mut stdin,&mut jobs,&mut queued).await?;
                },
                _=tokio::time::sleep_until(protocol.goals.deadline().unwrap_or_else(||tokio::time::Instant::now()+Duration::from_secs(86400))),if protocol.goals.deadline().is_some()=>{
                    let step=protocol.goal_tick();
                    if apply_step(&mut protocol,step,&sink,&mut stdin,&mut jobs,&mut queued).await? {return Ok(());}
                },
                read=stdout.read(&mut buf)=>{
                    let count=read.map_err(|e|format!("Provider stream failed: {e}"))?;
                    if count==0 {
                        if stopped{break Ok(());}
                        // Exited after a finished turn, while the run was only waiting for another.
                        if protocol.claude_idle() {
                            let step=protocol.claude_end_idle();
                            apply_step(&mut protocol,step,&sink,&mut stdin,&mut jobs,&mut queued).await?;
                            break Ok(());
                        }
                        break Err("Agent exited before completing its response".into());
                    }
                    // Retained bytes contain no newline: only scan this read.
                    // Rescanning the entire partial frame makes large tool
                    // results quadratic and can starve other concurrent runs.
                    let previous_len=bytes.len();
                    bytes.extend_from_slice(&buf[..count]);
                    let mut consumed=0;
                    let mut scan=previous_len;
                    while let Some(offset)=bytes[scan..].iter().position(|b|*b==b'\n') {
                        let end=scan+offset;scan=end+1;
                        let line=&bytes[consumed..end];consumed=end+1;
                        if line.len()>MAX_FRAME{return Err("Provider sent an oversized JSON message".into());}
                        if line.iter().all(u8::is_ascii_whitespace){continue;}
                        let value:Value=serde_json::from_slice(line).map_err(|e|format!("Invalid provider JSON: {e}"))?;
                        if stopped {
                            if pi::stop_settled(&protocol.config.provider, &value) {return Ok(());}
                            continue;
                        }
                        answered=true;
                        if protocol.phase==0 {deadline=startup_deadline(started,tokio::time::Instant::now(),step_limit);}
                        let step=protocol.receive(value)?;
                        if apply_step(&mut protocol,step,&sink,&mut stdin,&mut jobs,&mut queued).await? {return Ok(());}
                    }
                    bytes.drain(..consumed);
                    if should_shrink(bytes.len(),bytes.capacity()){bytes.shrink_to(FRAME_KEEP);}
                    if bytes.len()>MAX_FRAME{return Err("Provider output exceeded the message size limit".into());}
                },
            }
        }
    }.await;
    if let Some(server) = &mcp {
        server.stop();
    }
    jobs.abort_all();
    queued.clear();
    protocol.goals.cancel_pending();
    // Before the run settles its children, so the last text a throttle held back is the one saved.
    for event in protocol.flush_subagents(true).events {
        sink(event);
    }
    if result.is_ok() && !stopped {
        for event in protocol.lost_reports_note() {
            sink(event);
        }
    }
    for event in protocol.steers_ended(result.is_ok() && !stopped) {
        sink(event);
    }
    for event in protocol.cancel_requests().events {
        sink(event);
    }
    if lingers && result.is_ok() && !stopped {
        linger_agent(protocol.config.session_id.clone(), &protocol.config.cwd, child, stdin, stdout, stderr_task, group, agent_temp);
        return Ok(());
    }
    finish_child(&mut child, stdin, &mut group, FINISH_GRACE).await;
    let diagnostic = tokio::time::timeout(Duration::from_millis(500), &mut stderr_task.0)
        .await
        .ok()
        .and_then(Result::ok)
        .unwrap_or_default();
    let diagnostic = mcp
        .as_ref()
        .map(|server| server.redact(&diagnostic))
        .unwrap_or(diagnostic);
    result.map_err(|error: String| {
        let error = mcp
            .as_ref()
            .map(|server| server.redact(&error))
            .unwrap_or(error);
        diagnostics::failure(&error, &diagnostic)
    })
}

#[cfg(test)]
mod coalesce_tests {
    use super::*;
    fn ev(kind: &str, text: &str) -> AgentEvent {
        AgentEvent { session_id: "s".into(), kind: kind.into(), text: text.into(), request_id: None, data: None, tool: None }
    }
    #[test]
    fn tiny_deltas_merge_and_flush_before_other_events() {
        let start = std::time::Instant::now();
        let mut c = Coalescer::default();
        let mut out = Vec::new();
        let mut sent = String::new();
        for i in 0..2000 {
            if i == 1000 {
                let mut tool = ev("tool", "Bash");
                tool.data = Some(json!({"id": "t1"}));
                out.extend(c.push(tool, start));
            }
            let delta = format!("{}", i % 10);
            sent.push_str(&delta);
            // All within one 33 ms window.
            out.extend(c.push(ev("text", &delta), start + Duration::from_micros(i)));
        }
        out.extend(c.flush());
        eprintln!("coalesced 2000 text deltas into {} emits (was 2001)", out.len());
        assert_eq!(out.len(), 3);
        assert_eq!(out[1].kind, "tool");
        let text: String = out.iter().filter(|e| e.kind == "text").map(|e| e.text.as_str()).collect();
        assert_eq!(text, sent);
        assert_eq!(out[0].text, sent[..1000]);
    }
    #[test]
    fn window_size_and_kind_changes_flush() {
        let start = std::time::Instant::now();
        let mut c = Coalescer::default();
        assert!(c.push(ev("text", "a"), start).is_empty());
        assert_eq!(c.started_at(), Some(start));
        let late = c.push(ev("text", "b"), start + COALESCE_WINDOW);
        assert_eq!(late.len(), 1);
        assert_eq!(late[0].text, "ab");
        assert!(c.push(ev("thinking", "x"), start).is_empty());
        let switched = c.push(ev("text", "y"), start);
        assert_eq!((switched[0].kind.as_str(), switched[0].text.as_str()), ("thinking", "x"));
        let big = c.push(ev("text", &"z".repeat(COALESCE_BYTES)), start);
        assert_eq!(big[0].text.len(), COALESCE_BYTES + 1);
        assert!(c.flush().is_none());
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn frame_buffer_shrinks_only_when_large_and_drained() {
        assert!(super::should_shrink(10, 2 * 1024 * 1024));
        assert!(!super::should_shrink(10, 1024 * 1024));
        assert!(!super::should_shrink(super::FRAME_KEEP, 2 * 1024 * 1024));
    }
    /// Recorded from `opencode --standalone api model.list` 2.2.5 (trimmed to two models).
    const OPENCODE_V2_MODELS: &str = r#"{"location":{"directory":"/tmp"},"data":[{"id":"flint-40b-free","modelID":"flint-40b-free","providerID":"opencode","type":"chat","family":"flint","name":"Flint 40B Free","package":"@opencode/ai/providers/openai-compatible","settings":{"apiKey":"public","baseURL":"https://opencode.ai/inference/openai/v1","provider":"opencode"},"capabilities":{"tools":true,"input":["text"],"output":["text"],"temperature":true},"variants":[{"id":"low","settings":{"reasoningEffort":"low"}},{"id":"medium","settings":{"reasoningEffort":"medium"}},{"id":"high","settings":{"reasoningEffort":"high"}},{"id":"xhigh","settings":{"reasoningEffort":"xhigh"}},{"id":"max","settings":{"reasoningEffort":"max"}}],"time":{"released":1792540800000},"cost":[{"input":0,"output":0,"cache":{"read":0,"write":0}}],"status":"active","enabled":true,"limit":{"context":262144,"output":65536}},{"id":"big-pickle","modelID":"big-pickle","providerID":"opencode","type":"chat","family":"big-pickle","name":"Big Pickle","package":"@opencode/ai/providers/openai-compatible","settings":{"apiKey":"public","baseURL":"https://opencode.ai/inference/openai/v1","provider":"opencode"},"capabilities":{"tools":true,"input":["text"],"output":["text"],"temperature":true},"variants":[],"time":{"released":1760659200000},"cost":[{"input":0,"output":0,"cache":{"read":0,"write":0}}],"status":"active","enabled":true,"limit":{"context":200000,"input":160000,"output":32000}}]}"#;

    #[test]
    fn opencode_v2_recorded_models_keep_efforts_and_drop_settings() {
        let parsed = super::parse_opencode_v2_models(OPENCODE_V2_MODELS.as_bytes()).unwrap();
        let ids: Vec<_> = parsed.iter().map(|model| model.id.as_str()).collect();
        assert_eq!(ids, ["default", "opencode/big-pickle", "opencode/flint-40b-free"]);
        assert!(parsed[1].reasoning_efforts.is_empty());
        let efforts: Vec<_> = parsed[2].reasoning_efforts.iter().map(|effort| effort.id.as_str()).collect();
        assert_eq!(efforts, ["low", "medium", "high", "xhigh", "max"]);
        assert_eq!(parsed[2].name, "Flint 40B Free");
        assert_eq!(parsed[2].context_window, Some(262144));
        let visible = serde_json::to_string(&parsed).unwrap();
        assert!(!visible.contains("apiKey") && !visible.contains("baseURL"));
    }

    #[test]
    fn opencode_v2_malformed_catalogs_do_not_echo_input() {
        for bad in [&b"SECRET"[..], br#"{"data":"SECRET"}"#, br#"{"data":[{"id":"SECRET"}]}"#] {
            assert!(!super::parse_opencode_v2_models(bad).unwrap_err().contains("SECRET"));
        }
    }

    #[test]
    fn opencode_major_version_reads_both_generations() {
        assert_eq!(super::opencode_major_version("1.19.0\n"), Some(1));
        assert_eq!(super::opencode_major_version("opencode v2.2.5\n"), Some(2));
        assert_eq!(super::opencode_major_version("opencode"), None);
    }

    /// Runs the catalog against a stand-in CLI; `$MARK` records every `api` call.
    #[cfg(unix)]
    async fn opencode_catalog_with(version: &str, verbose: &str, api: &str) -> (Result<Vec<super::ModelInfo>, String>, bool) {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("pandacode-opencode-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let (script, mark, models) = (root.join("opencode"), root.join("api-called"), root.join("models.json"));
        std::fs::write(&models, api).unwrap();
        std::fs::write(&script, format!(
            "#!/bin/sh\ncase \"$*\" in\n*--version*) echo '{version}';;\n*'--standalone api model.list --param directory='*) : > '{mark}'; cat '{models}';;\n'models --verbose') {verbose};;\nmodels) echo opencode/plain;;\n*) exit 9;;\nesac\n",
            mark = mark.display(), models = models.display(),
        )).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let result = super::opencode_catalog(&script).await;
        let called = mark.exists();
        std::fs::remove_dir_all(&root).unwrap();
        (result, called)
    }

    #[tokio::test]
    #[ignore = "Reads the installed OpenCode's model catalog; never sends a prompt"]
    async fn installed_opencode_catalog_reports_efforts() {
        let path = super::executable("opencode").expect("Install OpenCode first");
        let models = super::opencode_catalog(&path).await.unwrap();
        let with_efforts = models.iter().filter(|model| !model.reasoning_efforts.is_empty()).count();
        println!("{:?}: {} models, {with_efforts} with efforts", super::version(&path), models.len() - 1);
        assert!(with_efforts > 0);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn opencode_v2_reads_efforts_through_its_api() {
        let (models, called) = opencode_catalog_with("opencode v2.2.5", "exit 1", OPENCODE_V2_MODELS).await;
        assert!(called);
        assert_eq!(models.unwrap()[2].reasoning_efforts.len(), 5);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn opencode_v2_falls_back_to_plain_ids_when_its_api_fails() {
        let (models, _) = opencode_catalog_with("opencode v2.2.5", "exit 1", "not json").await;
        let models = models.unwrap();
        assert_eq!(models[1].id, "opencode/plain");
        assert!(models[1].reasoning_efforts.is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn opencode_v1_never_gets_the_api_command() {
        let verbose = r#"printf 'vendor/id\n{"name":"Actual","variants":{"high":{},"low":{}}}\n'"#;
        let (models, called) = opencode_catalog_with("1.19.0", verbose, OPENCODE_V2_MODELS).await;
        assert!(!called);
        let efforts: Vec<_> = models.unwrap()[1].reasoning_efforts.iter().map(|effort| effort.id.clone()).collect();
        assert_eq!(efforts, ["low", "high"]);
    }

    #[test]
    fn opencode_choices_keep_only_saved_models_and_retain_unavailable_ids() {
        let model = super::ModelInfo {
            speed_tiers: Vec::new(),
            id: "vendor/selected".into(),
            name: "Selected model".into(),
            description: "Provider metadata".into(),
            reasoning_efforts: vec![super::effort_info("high", None)],
            default_reasoning_effort: None,
            context_window: Some(200_000),
        };
        let unused = super::ModelInfo {
            speed_tiers: Vec::new(),
            id: "vendor/not-selected".into(),
            ..model.clone()
        };
        let curated = super::selected_opencode_models(
            vec![unused, model.clone()],
            &["vendor/missing".into(), model.id.clone()],
        );
        assert_eq!(
            curated
                .iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>(),
            ["default", "vendor/missing", "vendor/selected"]
        );
        assert_eq!(curated[2], model);
        assert_eq!(curated[1].name, "vendor/missing");
        assert_eq!(
            super::selected_opencode_models(vec![model], &[]),
            [super::ModelInfo::default_choice()]
        );
    }
    use super::*;

    #[test]
    fn github_copilot_is_discovered_with_its_direct_cli_executable_and_no_effort_override() {
        assert!(PROVIDERS.contains(&("github-copilot", "GitHub Copilot CLI")));
        assert_eq!(executable_name("github-copilot"), "copilot");
        assert!(validate_reasoning_effort("github-copilot", None).is_ok());
        assert!(validate_reasoning_effort("github-copilot", Some("high")).is_err());
    }

    #[test]
    fn kilo_is_registered_with_its_cli_and_catalog_defined_efforts() {
        assert!(PROVIDERS.contains(&("kilo", "Kilo Code")));
        assert_eq!(executable_name("kilo"), "kilo");
        assert!(validate_reasoning_effort("kilo", None).is_ok());
        assert!(validate_reasoning_effort("kilo", Some("max")).is_ok());
        assert!(validate_reasoning_effort("kilo", Some("bad\nflag")).is_err());
    }

    #[test]
    fn hermes_is_registered_with_its_cli_and_catalog_defined_efforts() {
        assert!(PROVIDERS.contains(&("hermes", "Hermes Agent")));
        assert_eq!(executable_name("hermes"), "hermes");
        assert!(validate_reasoning_effort("hermes", None).is_ok());
        assert!(validate_reasoning_effort("hermes", Some("high")).is_ok());
        assert!(validate_reasoning_effort("hermes", Some("bad\nflag")).is_err());
    }

    pub(super) fn config(provider: &str) -> RunConfig {
        RunConfig {
            session_id: "local".into(),
            provider: provider.into(),
            model: "default".into(),
            reasoning_effort: None,
            mode: "ask".into(),
            cwd: PathBuf::from("/tmp"),
            resume_id: None,
            prompt: "Explain this project".into(),
            instructions: String::new(),
            skill: None,
            goal: None,
            codex_settings: None,
            images: Vec::new(),
        }
    }

    #[tokio::test]
    async fn only_harness_failures_mark_the_run_as_reaching_the_harness() {
        let sink: Sink = Arc::new(|_| {});
        // PandaCode's own validation fails before the harness.
        let reached: Arc<std::sync::atomic::AtomicBool> = Default::default();
        let (_tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let mut local = config("claude");
        local.mode = "bogus".into();
        assert!(run_with_tools(local, sink.clone(), rx, None, reached.clone()).await.is_err());
        assert!(!reached.load(std::sync::atomic::Ordering::SeqCst));
        // A harness that cannot start is the harness's failure.
        let reached: Arc<std::sync::atomic::AtomicBool> = Default::default();
        let (_tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let missing = Command::new("/nonexistent/pandacode-harness");
        let started = HARNESS
            .scope(reached.clone(), run_process_with_tools(config("claude"), sink, rx, missing, Vec::new(), None))
            .await;
        assert!(started.unwrap_err().starts_with("Could not start"));
        assert!(reached.load(std::sync::atomic::Ordering::SeqCst));
    }

    #[test]
    fn independent_jev_switches_build_valid_hosts_and_codex_transports() {
        for browser in [false, true] {
            for decisions in [true, false] {
                for base_enabled in [false, true] {
                    let base = base_enabled.then(|| ToolHost {
                        tools: crate::agent_tools::catalog(),
                        approval_tools: ["pandacode_open_browser".into()].into(),
                        handler: Arc::new(|_, _| Box::pin(async { Ok(json!({})) })),
                    });
                    let mut optional = Vec::new();
                    if browser {
                        optional.extend(crate::agent_tools::jev_catalog());
                    }
                    if decisions {
                        optional.extend(crate::agent_tools::jev_assist_catalog());
                    }
                    let (tools, approval_tools) =
                        crate::agent_tools::jev_host_catalog(base.as_ref(), optional);
                    let host = ToolHost {
                        tools,
                        approval_tools,
                        handler: Arc::new(|_, _| Box::pin(async { Ok(json!({})) })),
                    };
                    let mut expected = HashSet::new();
                    if base_enabled {
                        expected.insert("pandacode_open_browser".into());
                    }
                    if browser {
                        expected.extend(["pandacode_jev_test".into(), "pandacode_jev_cancel".into()]);
                    }
                    if decisions {
                        expected.extend([
                            "pandacode_jev_review".into(),
                            "pandacode_jev_check_rules".into(),
                            "pandacode_jev_find_context".into(),
                            "pandacode_jev_choose_worker".into(),
                        ]);
                    }
                    // All non-Codex harnesses validate this complete host before MCP starts.
                    host_tools::HostTools::new(host.clone()).unwrap_or_else(|error| {
                        panic!("browser={browser}, decisions={decisions}, base={base_enabled}: {error}")
                    });
                    assert_eq!(host.approval_tools, expected,
                        "browser={browser}, decisions={decisions}, base={base_enabled}");
                    let (dynamic, mcp) = split_jev_host(Some(host));
                    assert_eq!(mcp.is_some(), browser || decisions);
                    for transport in [dynamic, mcp].into_iter().flatten() {
                        host_tools::HostTools::new(transport).unwrap();
                    }
                }
            }
        }
    }
    #[test]
    fn jev_tools_split_to_mcp_preserving_other_dynamic_tools_and_approvals() {
        let mut tools = crate::agent_tools::catalog();
        tools.extend(crate::agent_tools::jev_catalog());
        let host = ToolHost {
            tools,
            approval_tools: ["pandacode_jev_test".into(), "pandacode_open_browser".into()].into(),
            handler: Arc::new(|_, _| Box::pin(async { Ok(json!({})) })),
        };
        let (dynamic, mcp) = split_jev_host(Some(host));
        let dynamic = dynamic.unwrap();
        let mcp = mcp.unwrap();
        assert!(dynamic
            .tools
            .iter()
            .all(|tool| !tool["name"].as_str().unwrap().starts_with("pandacode_jev_")));
        assert_eq!(mcp.tools.len(), 6);
        assert!(dynamic.approval_tools.contains("pandacode_open_browser"));
        assert!(!dynamic.approval_tools.contains("pandacode_jev_test"));
        assert_eq!(mcp.approval_tools, ["pandacode_jev_test".into()].into());
        host_tools::HostTools::new(dynamic).unwrap();
        host_tools::HostTools::new(mcp).unwrap();
    }
    #[test]
    fn preview_tools_use_resumable_optional_mcp_without_losing_approval_boundaries() {
        let names = ["pandacode_run_project", "pandacode_preview_file"];
        let host = ToolHost {
            tools: names.iter().map(|name| json!({"type":"function","name":name,"description":"Preview","inputSchema":{"type":"object"}})).collect(),
            approval_tools: names.iter().map(|name| (*name).into()).collect(),
            handler: Arc::new(|_, _| Box::pin(async { Ok(json!({})) })),
        };
        let (dynamic, mcp) = split_jev_host(Some(host));
        assert!(dynamic.is_none(), "existing Codex threads need the per-run MCP catalog");
        let mcp = mcp.unwrap();
        assert_eq!(mcp.tools.len(), 2);
        for name in names {
            assert!(mcp.approval_tools.contains(name));
            assert!(optional_transport_tool(name));
            assert!(!optional_metadata_tool(name), "preview must not inherit metadata permission exemptions");
        }
        host_tools::HostTools::new(mcp).unwrap();
    }

    #[test]
    fn preview_tools_do_not_block_normal_acp_turns_when_http_mcp_is_unavailable() {
        for provider in ["kimi", "opencode", "antigravity", "grok", "cline"] {
            let mut p = Protocol::new(config(provider));
            p.mcp_server = Some(json!({"type":"http","name":"pandacode_architect"}));
            p.mcp_required = ["pandacode_run_project", "pandacode_preview_file"].iter().any(|name| !optional_transport_tool(name));
            let mut step = p.receive(json!({"id":1,"result":{"protocolVersion":1,"agentCapabilities":{"mcpCapabilities":{"http":false}},"authMethods":[{"id":"cached_token","name":"cached_token"}],"_meta":{"defaultAuthMethodId":"cached_token"}}})).unwrap();
            if provider == "grok" {
                assert_eq!(step.write[0]["method"], "authenticate");
                step = p.receive(json!({"id":7,"result":{}})).unwrap();
            }
            assert_eq!(step.write[0]["method"], "session/new", "{provider}");
            assert_eq!(step.write[0]["params"]["mcpServers"], json!([]), "{provider}");
        }
    }

    #[test]
    fn optional_host_tools_do_not_block_normal_acp_turns_when_http_mcp_is_unavailable() {
        for name in [
            crate::session_titles::TOOL,
            crate::turn_changes::TRACK_TOOL,
            "pandacode_run_project",
            "pandacode_preview_file",
            "pandacode_cloud_cli",
            "pandacode_simulator_tap",
            "pandacode_vm_exec",
            "pandacode_design_artboard",
            "pandacode_jev_test",
            "pandacode_bot_recall",
        ] {
            assert!(optional_transport_tool(name), "{name} should be optional transport");
        }
        for name in [
            "pandacode_delegate",
            "pandacode_send_team_message",
            "pandacode_team_status",
            "pandacode_read_file",
        ] {
            assert!(!optional_transport_tool(name), "{name} must be required");
        }
    }

    #[test]
    fn approve_for_me_runs_only_where_the_harness_reviews_actions() {
        for provider in ["claude", "glm", "mimo", "alibaba"] {
            assert!(review_supported(provider, "review").is_ok());
        }
        for provider in ["codex", "kimi", "opencode", "antigravity", "grok", "pi", "omp", "deepseek", "commandcode", "cline", "kilo", "github-copilot", "muse", "hermes"] {
            assert!(review_supported(provider, "review").unwrap_err().contains("Approve for me"), "{provider}");
            assert!(review_supported(provider, "ask").is_ok());
        }
    }

    #[test]
    fn one_sessions_burst_of_declines_never_evicts_anothers() {
        set_decline_reason("quiet-session", "7", "Declined: team workers cannot run it.");
        for i in 0..100 {
            set_decline_reason("busy-session", &i.to_string(), "Declined: team workers cannot run it.");
        }
        assert!(take_decline_reason("quiet-session", "7").is_some(), "the other session keeps its reason");
        assert!(take_decline_reason("busy-session", "99").is_some(), "the newest is kept");
        assert!(take_decline_reason("busy-session", "0").is_none(), "the busy session's oldest went first");
        forget_decline_reasons("busy-session");
    }

    /// A loop that takes a stop from the run's input must say so (`STOPPING_STATUS`), or a team
    /// worker's automatic stop reads as "finished first" and its failure is lost.
    #[test]
    fn every_input_loop_that_takes_a_stop_reports_it() {
        let marker = ["Some(RunInput", "::Stop)"].concat();
        for (name, source) in [("providers.rs", include_str!("providers.rs")), ("providers/pool.rs", include_str!("providers/pool.rs"))] {
            for (at, _) in source.match_indices(&marker) {
                let arm = &source[at..(at + 1500).min(source.len())];
                assert!(arm.contains("stop_taken()"), "{name}: an input loop takes a stop without marking it (`stop_taken`)");
                assert!(arm.contains("STOPPING_STATUS"), "{name}: an input loop takes a stop without reporting STOPPING_STATUS");
            }
        }
        // The pool's stop taken between accounts marks it as well.
        let pool = include_str!("providers/pool.rs");
        let between = pool.find("Stopped while the run changed accounts").expect("the pool's stop between accounts");
        assert!(pool[between..between + 400].contains("stopped_between_accounts("));
        let helper = pool.find("fn stopped_between_accounts(").unwrap();
        assert!(pool[helper..helper + 200].contains("super::stop_taken();"));
    }

    #[tokio::test]
    async fn a_taken_stop_sets_the_runs_flag_and_only_inside_its_run() {
        let taken = Arc::new(std::sync::atomic::AtomicBool::new(false));
        STOP_TAKEN.scope(taken.clone(), async { stop_taken() }).await;
        assert!(taken.load(std::sync::atomic::Ordering::SeqCst));
        // Outside any run it is a no-op.
        stop_taken();
    }

    #[test]
    fn a_decision_after_claude_cancelled_its_permission_reports_nothing() {
        let mut p = Protocol::new(config("claude"));
        let step = p.receive(json!({"type":"control_request","request_id":"r","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"ls"}}})).unwrap();
        let id = step.events.iter().find(|e| e.kind == "approval").unwrap().request_id.clone().unwrap();
        p.receive(json!({"type":"control_cancel_request","request_id":"r"})).unwrap();
        // The automatic decision arrives late: nothing waits on it, so the worker keeps running.
        let late = p.approval_step(&id, true);
        assert!(late.events.is_empty() && late.write.is_empty(), "{:?}", late.events);
    }

    #[test]
    fn claudes_permission_for_an_always_ask_tool_is_recognised_for_team_workers() {
        let mut cfg = config("claude");
        cfg.mode = "full".into();
        let mut p = Protocol::new(cfg);
        let step = p.receive(json!({"type":"control_request","request_id":"r","request":{"subtype":"can_use_tool","tool_name":"mcp__pandacode__pandacode_cloud_cli","input":{"args":["deploy"]}}})).unwrap();
        let event = step.events.iter().find(|e| e.kind == "approval").expect("Claude asks for it");
        // The real label is the bare tool name; the data keeps only scalar keys.
        assert_eq!(event.text, "mcp__pandacode__pandacode_cloud_cli");
        assert_eq!(event.data.as_ref().unwrap()["type"], "control_request");
        assert_eq!(crate::worker_approvals::always_ask_tool(event), Some("pandacode_cloud_cli"));
        let mut other = event.clone();
        other.text = "mcp__pandacode__pandacode_status".into();
        assert_eq!(crate::worker_approvals::always_ask_tool(&other), None);
    }

    #[test]
    fn claude_plan_mode_runs_reads_and_web_lookups_but_asks_for_the_rest() {
        let permission = |mode: &str, name: &str, input: Value| {
            let mut cfg = config("claude");
            cfg.mode = mode.into();
            let mut p = Protocol::new(cfg);
            let step = p.receive(json!({"type":"control_request","request_id":"r","request":{"subtype":"can_use_tool","tool_name":name,"input":input}})).unwrap();
            step.write.first().map(|w| w["response"]["response"]["behavior"].clone())
        };
        for (name, input) in [
            ("Read", json!({"file_path":"/Users/me/other-repo/README.md"})),
            ("Grep", json!({"pattern":"token","path":"/opt/lib"})),
            ("Glob", json!({"pattern":"**/*.md","path":"/Users/me/docs"})),
            ("WebFetch", json!({"url":"https://docs.example.com","prompt":"summary"})),
            ("WebSearch", json!({"query":"tauri updater"})),
        ] {
            assert_eq!(permission("plan", name, input.clone()), Some(json!("allow")), "{name}");
            assert_eq!(permission("ask", name, input), None, "{name} keeps Standard approvals");
        }
        // Credentials and anything that changes state still go to the user.
        for (name, input) in [
            ("Read", json!({"file_path":"/Users/me/.ssh/id_ed25519"})),
            ("Read", json!({"file_path":"/Users/me/project/.env"})),
            ("Glob", json!({"pattern":"/Users/me/.aws/*"})),
            ("Write", json!({"file_path":"/tmp/a.txt","content":"x"})),
            ("Edit", json!({"file_path":"/tmp/a.txt"})),
            ("Bash", json!({"command":"cat README.md"})),
        ] {
            assert_eq!(permission("plan", name, input), None, "{name}");
        }
    }

    #[test]
    fn claude_preview_tools_never_inherit_the_metadata_permission_exemption() {
        for provider in ["claude", "glm", "mimo", "alibaba"] {
            for mode in ["ask", "auto", "plan"] {
                for name in ["pandacode_run_project", "pandacode_preview_file"] {
                    let name = format!("mcp__pandacode_architect__{name}");
                    let mut cfg = config(provider);
                    cfg.mode = mode.into();
                    let mut p = Protocol::new(cfg);
                    p.mcp_tool_names.insert(name.clone());
                    let step = p.receive(json!({"type":"control_request","request_id":"preview-permission","request":{"subtype":"can_use_tool","tool_name":name,"input":{}}})).unwrap();
                    assert!(step.write.is_empty());
                    assert!(step.events.iter().any(|event| event.kind == "approval"));
                }
            }
        }
    }

    #[test]
    fn titles_use_per_run_mcp_on_resumed_codex_and_hide_native_tool_mirrors() {
        let host = ToolHost {
            tools: vec![json!({"type":"function","name":crate::session_titles::TOOL,"description":"Metadata","inputSchema":{"type":"object"}})],
            approval_tools: HashSet::new(),
            handler: Arc::new(|_, _| Box::pin(async { Ok(json!({})) })),
        };
        let (dynamic, mcp) = split_jev_host(Some(host));
        assert!(dynamic.is_none());
        assert_eq!(mcp.unwrap().tools[0]["name"], crate::session_titles::TOOL);
        for name in [crate::session_titles::TOOL.into(), format!("mcp__pandacode_architect__{}", crate::session_titles::TOOL)] {
            let mut protocol = Protocol::new(config("codex"));
            protocol.mcp_tool_names.insert(name.clone());
            let mut step = Step::default();
            protocol.tool_update("title-call", Some(&name), Some("running"), Some("sidebar metadata".into()), None, &mut step);
            protocol.tool_update("title-call", None, Some("completed"), None, Some("staged".into()), &mut step);
            assert!(step.events.is_empty());
        }
    }
    #[test]
    fn codex_title_wire_frames_are_hidden_only_for_the_registered_local_server() {
        for registered in [false, true] {
            for server in ["pandacode_architect", "other_server"] {
                let mut p = Protocol::new(config("codex"));
                if registered { p.mcp_tool_names.insert(crate::session_titles::TOOL.into()); }
                for method in ["item/started", "item/completed"] {
                    let frame = json!({"method":method,"params":{"item":{"type":"mcpToolCall","id":"title-1","server":server,"tool":crate::session_titles::TOOL,"arguments":{"title":"Current conversation topic"},"status":if method=="item/started" {"inProgress"} else {"completed"},"result":{"content":[{"type":"text","text":"staged"}]}}}});
                    let step = p.receive(frame).unwrap();
                    let visible = step.events.iter().any(|e| e.kind == "tool");
                    assert_eq!(visible, !(registered && server == "pandacode_architect"));
                }
            }
        }
    }
    #[test]
    fn kimi_without_http_mcp_starts_for_optional_titles_but_rejects_required_tools() {
        for required in [false, true] {
            let mut p = Protocol::new(config("kimi"));
            p.mcp_server = Some(json!({"type":"http","name":"pandacode_architect"}));
            p.mcp_required = required;
            let result = p.receive(json!({"id":1,"result":{"protocolVersion":1,"agentCapabilities":{"mcpCapabilities":{"http":false}}}}));
            if required { assert!(result.err().unwrap().contains("HTTP MCP")); }
            else {
                let step = result.unwrap();
                assert_eq!(step.write[0]["method"], "session/new");
                assert_eq!(step.write[0]["params"]["mcpServers"], json!([]));
            }
        }
    }
    #[test]
    fn file_capture_metadata_uses_resumable_mcp_and_never_prompts_to_take_snapshots() {
        let host = crate::turn_changes::with_host(None, None, Arc::new(std::sync::atomic::AtomicBool::new(false)));
        let (dynamic, mcp) = split_jev_host(Some(host));
        assert!(dynamic.is_none());
        assert_eq!(mcp.unwrap().tools[0]["name"], crate::turn_changes::TRACK_TOOL);
        let name = format!("mcp__pandacode_architect__{}", crate::turn_changes::TRACK_TOOL);
        for registered in [false,true] {
            let mut p = Protocol::new(config("claude"));
            if registered { p.mcp_tool_names.insert(name.clone()); }
            let step=p.receive(json!({"type":"control_request","request_id":"tracking","request":{"subtype":"can_use_tool","tool_name":name,"input":{"action":"begin","paths":["file.txt"]}}})).unwrap();
            if registered { assert!(step.events.is_empty()); assert_eq!(step.write[0]["response"]["response"]["behavior"],"allow"); }
            else { assert_eq!(step.events[0].kind,"approval"); }
        }
    }

    #[test]
    fn claude_title_permission_is_silent_only_for_the_registered_metadata_tool() {
        let title_name = format!("mcp__pandacode_architect__{}", crate::session_titles::TOOL);
        for provider in ["claude", "glm", "mimo", "alibaba"] {
            for mode in ["ask", "auto", "plan"] {
                for (registered, name) in [(true, title_name.as_str()), (false, title_name.as_str()), (true, "mcp__other__pandacode_title"), (true, "mcp__pandacode_architect__pandacode_open_browser")] {
                    let mut cfg = config(provider);
                    cfg.mode = mode.into();
                    let mut p = Protocol::new(cfg);
                    if registered { p.mcp_tool_names.insert(title_name.clone()); }
                    let input = json!({"title":"Current conversation topic"});
                    let step = p.receive(json!({"type":"control_request","request_id":"title-permission","request":{"subtype":"can_use_tool","tool_name":name,"input":input}})).unwrap();
                    if registered && name == title_name {
                        assert!(step.events.is_empty());
                        assert_eq!(step.write[0]["response"]["response"]["behavior"], "allow");
                        assert_eq!(step.write[0]["response"]["response"]["updatedInput"], input);
                        assert!(p.pending.is_empty());
                    } else {
                        assert!(step.write.is_empty());
                        assert!(step.events.iter().any(|e| e.kind == "approval"));
                    }
                }
            }
        }
    }
    #[test]
    fn jev_mcp_config_is_added_to_codex_start_and_resume_without_resetting_history() {
        for resume in [false, true] {
            let mut cfg = config("codex");
            cfg.resume_id = resume.then(|| "existing-conversation".into());
            cfg.reasoning_effort = Some("high".into());
            let mut protocol = Protocol::new(cfg);
            protocol.codex_mcp_servers = Some(
                json!({"pandacode_architect":{"url":"http://127.0.0.1:43210/mcp","http_headers":{"Authorization":"Bearer temporary-fixture"}}}),
            );
            let mut step = protocol.receive(json!({"id":1,"result":{}})).unwrap();
            if resume {
                let preflight = step
                    .write
                    .iter()
                    .find(|request| request["method"] == "thread/goal/get")
                    .unwrap();
                step = protocol
                    .receive(json!({"id":preflight["id"],"result":{"goal":null}}))
                    .unwrap();
            }
            let load = step
                .write
                .iter()
                .find(|request| request["id"] == 2)
                .unwrap();
            assert_eq!(
                load["method"],
                if resume {
                    "thread/resume"
                } else {
                    "thread/start"
                }
            );
            if resume {
                assert_eq!(load["params"]["threadId"], "existing-conversation");
            }
            assert_eq!(load["params"]["config"]["model_reasoning_effort"], "high");
            assert_eq!(
                load["params"]["config"]["mcp_servers.pandacode_architect"]["url"],
                "http://127.0.0.1:43210/mcp"
            );
            assert!(
                load["params"]["config"].get("mcp_servers").is_none(),
                "Do not replace the user's whole MCP table"
            );
        }
    }

    fn activity(step: &Step) -> Value {
        serde_json::to_value(
            step.events
                .iter()
                .find(|event| event.kind == "tool")
                .expect("tool event"),
        )
        .unwrap()["tool"]
            .clone()
    }

    #[test]
    fn codex_structured_questions_are_forwarded_before_reply() {
        let mut p = Protocol::new(config("codex"));
        p.remote_id = "thread".into();
        p.turn_id = "turn".into();
        let step = p.receive(json!({"id":"question-rpc","method":"item/tool/requestUserInput","params":{"threadId":"thread","turnId":"turn","itemId":"question","isBlocking":true,"questions":[{"id":"q","header":"Choice","question":"Which?","isOther":false,"isSecret":false,"options":[{"label":"A","description":"First"}]}]}})).unwrap();
        assert!(step.write.is_empty(), "must wait for user input");
        assert_eq!(step.events[0].kind, "input_request");
        assert_eq!(step.events[0].data.as_ref().unwrap()["kind"], "questions");
    }

    #[test]
    fn reasoning_catalogs_project_only_advertised_supported_values() {
        let models = parse_codex_models(&json!({"data":[{"model":"actual","defaultReasoningEffort":"high","supportedReasoningEfforts":[
            {"reasoningEffort":"low","description":"Faster"},{"reasoningEffort":"high","description":"Deeper"},
            {"reasoningEffort":"high"},{"reasoningEffort":"bad\n"}],"contextWindow":999999}]})).unwrap();
        assert_eq!(
            models[1]
                .reasoning_efforts
                .iter()
                .map(|effort| effort.id.as_str())
                .collect::<Vec<_>>(),
            vec!["low", "high"]
        );
        assert_eq!(models[1].default_reasoning_effort.as_deref(), Some("high"));
        assert_eq!(models[1].context_window, None);
        let models = parse_claude_models(&json!({"models":[
            {"value":"sonnet","supportsEffort":true,"supportedEffortLevels":["low","high","ultra","high"],"contextWindow":200000},
            {"value":"haiku","supportsEffort":false,"supportedEffortLevels":["high"]},
            {"value":"custom","contextWindow":2000000000}
        ]})).unwrap();
        assert_eq!(models[1].reasoning_efforts.len(), 2);
        assert_eq!(models[1].context_window, Some(200000));
        assert!(models[2].reasoning_efforts.is_empty());
        assert_eq!(models[3].context_window, None);
        assert!(validate_reasoning_effort("claude", Some("ultra")).is_err());
        assert!(validate_reasoning_effort("kimi", Some("high")).is_ok());
        assert!(validate_reasoning_effort("kimi", Some("high level")).is_err());
        assert!(validate_reasoning_effort("codex", Some("future_effort")).is_ok());
        assert!(validate_reasoning_effort("codex", Some("")).is_err());
        for provider in ["grok", "cline", "codex"] {
            assert!(validate_reasoning_effort(provider, Some("-x")).is_err(), "{provider}");
            assert!(validate_reasoning_effort(provider, Some("--help")).is_err(), "{provider}");
            assert!(validate_reasoning_effort(provider, Some("extra-high")).is_ok(), "{provider}");
        }
    }

    #[test]
    fn codex_reasoning_is_validated_then_applied_on_start_resume_and_turn() {
        for resume in [false, true] {
            let mut cfg = config("codex");
            cfg.reasoning_effort = Some("high".into());
            cfg.resume_id = resume.then(|| "remote".into());
            let mut p = Protocol::new(cfg);
            let start = p.receive(json!({"id":1,"result":{}})).unwrap();
            let request = if resume {
                assert_eq!(start.write[1]["method"], "thread/goal/get");
                p.receive(json!({"id":start.write[1]["id"],"result":{"goal":null}}))
                    .unwrap()
                    .write
                    .remove(0)
            } else {
                start.write[1].clone()
            };
            assert_eq!(
                request["params"]["config"]["model_reasoning_effort"],
                "high"
            );
            let ready = p
                .receive(json!({"id":2,"result":{"thread":{"id":"remote"},"model":"actual"}}))
                .unwrap();
            assert_eq!(ready.write[0]["method"], "model/list");
            let turn = p.receive(json!({"id":6,"result":{"data":[{"model":"actual","supportedReasoningEfforts":[{"reasoningEffort":"high"}]}]}})).unwrap();
            assert_eq!(turn.write[0]["method"], "turn/start");
            assert_eq!(turn.write[0]["params"]["effort"], "high");
        }
        let mut cfg = config("codex");
        cfg.model = "actual".into();
        cfg.reasoning_effort = Some("max".into());
        let mut p = Protocol::new(cfg);
        assert!(p.receive(json!({"id":6,"result":{"data":[{"model":"actual","supportedReasoningEfforts":[{"reasoningEffort":"high"}]}]}})).is_err());
        let mut p = Protocol::new(config("codex"));
        let turn = p
            .receive(json!({"id":2,"result":{"thread":{"id":"remote"}}}))
            .unwrap();
        assert!(turn.write[0]["params"].get("effort").is_none());
    }

    #[test]
    fn skill_manager_claude_arbitrary_names_use_advisory_and_unrecoverable_prefs_block_skill_tools()
    {
        for provider in ["claude", "glm", "mimo", "alibaba"] {
            let mut cfg = config(provider);
            let disabled = std::collections::BTreeSet::from(["Friendly 技能".into()]);
            crate::skill_manager::apply_instructions(&mut cfg, &disabled);
            let mut command = Command::new("claude");
            configure_command_with_skills(&mut command, &cfg, &disabled);
            let args: Vec<_> = command
                .as_std()
                .get_args()
                .map(|s| s.to_string_lossy().into_owned())
                .collect();
            assert!(args
                .windows(2)
                .any(|a| a[0] == "--append-system-prompt" && a[1].contains("[\"Friendly 技能\"]")));
            assert!(!args.iter().any(|a| a.contains("Skill(Friendly")));
        }
        let mut cfg = config("codex");
        cfg.skill = Some(("any-skill".into(), "/skill".into()));
        let disabled = std::collections::BTreeSet::from(["*".into()]);
        crate::skill_manager::apply_instructions(&mut cfg, &disabled);
        assert!(cfg.skill.is_none());
        assert_eq!(
            crate::skill_manager::claude_disallowed("Monitor", &disabled),
            "Monitor,Skill"
        );
    }

    #[test]
    fn skill_manager_codex_and_opencode_receive_native_launch_overrides() {
        let disabled = std::collections::BTreeSet::from(["review".into()]);
        let mut command = Command::new("codex");
        configure_command_with_skills(&mut command, &config("codex"), &disabled);
        let args: Vec<_> = command
            .as_std()
            .get_args()
            .map(|s| s.to_string_lossy().into_owned())
            .collect();
        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "-c"
                && pair[1] == "skills.config=[{name=\"review\",enabled=false}]"));
        let mut command = Command::new("opencode");
        configure_command_with_skills(&mut command, &config("opencode"), &disabled);
        let inline = command
            .as_std()
            .get_envs()
            .find(|(key, _)| *key == "OPENCODE_CONFIG_CONTENT")
            .unwrap()
            .1
            .unwrap()
            .to_str()
            .unwrap();
        let value: Value = serde_json::from_str(inline).unwrap();
        assert_eq!(value["permission"]["skill"]["review"], "deny");
    }

    #[test]
    fn skill_manager_opencode_connection_config_that_cannot_be_read_is_kept_and_the_launch_asks() {
        let disabled = std::collections::BTreeSet::from(["review".into()]);
        let mut cfg = config("opencode");
        let mut command = Command::new("opencode");
        let text = r#"{"provider":{"work":{"options":{"timeout":{env:TIMEOUT}}}}}"#;
        command.env("OPENCODE_CONFIG_CONTENT", text);
        enforce_opencode_after_connection(&mut command, &mut cfg, &disabled, &Default::default());
        let env = |name: &str| {
            command
                .as_std()
                .get_envs()
                .find(|(key, _)| *key == name)
                .unwrap()
                .1
                .unwrap()
                .to_str()
                .unwrap()
                .to_owned()
        };
        assert_eq!(env("OPENCODE_CONFIG_CONTENT"), text);
        let permission: Value = serde_json::from_str(&env("OPENCODE_PERMISSION")).unwrap();
        assert_eq!(permission["skill"]["review"], "deny");
        assert!(format!("{}{}", cfg.prompt, cfg.instructions)
            .contains("Do not use these skills in this session: review."));
        // A readable connection configuration gets the denies merged in and no reminder.
        let mut cfg = config("opencode");
        let mut command = Command::new("opencode");
        command.env("OPENCODE_CONFIG_CONTENT", r#"{"mcp":{"x":{}}}"#);
        enforce_opencode_after_connection(&mut command, &mut cfg, &disabled, &Default::default());
        let value: Value =
            serde_json::from_str(&env_of(&command, "OPENCODE_CONFIG_CONTENT")).unwrap();
        assert!(value["mcp"]["x"].is_object());
        assert_eq!(value["permission"]["skill"]["review"], "deny");
        assert!(!format!("{}{}", cfg.prompt, cfg.instructions).contains("review"));
    }

    fn env_of(command: &Command, name: &str) -> String {
        command
            .as_std()
            .get_envs()
            .find(|(key, _)| *key == name)
            .unwrap()
            .1
            .unwrap()
            .to_str()
            .unwrap()
            .to_owned()
    }

    #[test]
    fn skill_manager_codex_connection_skills_config_cannot_override_the_switches() {
        let disabled = std::collections::BTreeSet::from(["review".into()]);
        let mut command = Command::new("codex");
        configure_command_with_skills(&mut command, &config("codex"), &disabled);
        let connection = vec![
            "-c".to_string(),
            "skills.config=[{name=\"review\",enabled=true},{path=\"/x/SKILL.md\",enabled=false}]"
                .into(),
        ];
        command.args(&connection);
        command.args(crate::skill_manager::codex_connection_arguments(
            &connection,
            &disabled,
        ));
        let args: Vec<_> = command
            .as_std()
            .get_args()
            .map(|s| s.to_string_lossy().into_owned())
            .collect();
        let last = args
            .iter()
            .rev()
            .find(|a| a.starts_with("skills.config="))
            .unwrap();
        let table = last.parse::<toml::Table>().unwrap();
        let rules = table["skills"]["config"].as_array().unwrap();
        assert_eq!(rules.len(), 3, "{last}");
        assert_eq!(rules[1]["path"].as_str(), Some("/x/SKILL.md"));
        assert_eq!(rules[2]["name"].as_str(), Some("review"));
        assert_eq!(rules[2]["enabled"].as_bool(), Some(false));
    }

    #[test]
    fn skill_manager_claude_launch_has_one_merged_disallowed_tools_flag() {
        let disabled = std::collections::BTreeSet::from(["alpha".into(), "beta".into()]);
        for provider in ["claude", "glm", "mimo", "alibaba"] {
            let mut command = Command::new("claude");
            configure_command_with_skills(&mut command, &config(provider), &disabled);
            let flags: Vec<_> = command
                .as_std()
                .get_args()
                .map(|s| s.to_string_lossy().into_owned())
                .filter(|s| s.starts_with("--disallowedTools="))
                .collect();
            assert_eq!(
                flags,
                [format!(
                    "--disallowedTools={CLAUDE_SESSION_BOUND_TOOLS},Skill(alpha),Skill(beta)"
                )]
            );
        }
    }

    #[test]
    fn codex_launches_without_its_thread_limit_unless_the_user_set_one() {
        let dir = std::env::temp_dir().join(format!("pandacode-codex-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("home")).unwrap();
        std::fs::create_dir_all(dir.join("project/.codex")).unwrap();
        let args = |toml: &str, project: &str| {
            std::fs::write(dir.join("home/config.toml"), toml).unwrap();
            std::fs::write(dir.join("project/.codex/config.toml"), project).unwrap();
            let mut cfg = config("codex");
            cfg.cwd = dir.join("project");
            let mut command = Command::new("codex");
            command.env("CODEX_HOME", dir.join("home"));
            configure_command(&mut command, &cfg);
            command.as_std().get_args().map(|arg| arg.to_string_lossy().into_owned()).collect::<Vec<_>>()
        };
        let plain = ["app-server", "--enable", "goals"];
        // Checked by starting `codex app-server` with it on 0.141.0 to 0.162.1: the newer name stops 0.144.1 and older.
        let lifted = [&plain[..], &["-c", "agents.max_threads=1024"]].concat();
        assert_eq!(args("model = \"x\"\n[agents]\nmax_depth = 2\n", ""), lifted);
        assert_eq!(args("not toml [", ""), lifted, "Codex reports a broken config itself");
        assert_eq!(args("[agents]\nmax_concurrent_threads_per_session = 3\n", ""), plain);
        assert_eq!(args("[agents]\nmax_threads = 3\n", ""), plain, "its older name");
        assert_eq!(args("", "[agents]\nmax_threads = 3\n"), plain, "a project's config");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn claude_effort_is_passed_to_cli_and_unsupported_model_rejected_before_prompt() {
        for resume in [false, true] {
            let mut cfg = config("claude");
            cfg.reasoning_effort = Some("xhigh".into());
            cfg.resume_id = resume.then(|| "remote".into());
            let mut command = Command::new("claude");
            configure_command(&mut command, &cfg);
            let args: Vec<_> = command
                .as_std()
                .get_args()
                .map(|arg| arg.to_string_lossy())
                .collect();
            assert!(args.windows(2).any(|args| args == ["--effort", "xhigh"]));
        }
        let mut cfg = config("claude");
        cfg.model = "haiku".into();
        cfg.reasoning_effort = Some("high".into());
        let mut p = Protocol::new(cfg);
        assert!(p.receive(json!({"type":"control_response","response":{"request_id":"pandacode-init","subtype":"success","response":{"models":[{"value":"haiku","supportsEffort":false}]}}})).is_err());
    }

    #[test]
    fn kimi_thinking_waits_for_advertised_option_and_confirmation_after_model_change() {
        let mut cfg = config("kimi");
        cfg.model = "custom".into();
        cfg.reasoning_effort = Some("off".into());
        let mut p = Protocol::new(cfg);
        p.remote_id = "remote".into();
        let model = p.receive(json!({"id":4,"result":{}})).unwrap();
        assert_eq!(model.write[0]["method"], "session/set_model");
        p.receive(json!({"method":"session/update","params":{"sessionId":"remote","update":{"sessionUpdate":"config_option_update","configOptions":[{"id":"thinking","options":[{"value":"on"},{"value":"off"}]}]}}})).unwrap();
        let thinking = p.receive(json!({"id":5,"result":{}})).unwrap();
        assert_eq!(thinking.write[0]["method"], "session/set_config_option");
        assert_eq!(thinking.write[0]["params"]["value"], "off");
        assert_eq!(thinking.write[0]["params"]["configId"], "thinking");
        assert_eq!(
            p.receive(json!({"id":6,"result":{}})).unwrap().write[0]["method"],
            "session/prompt"
        );
        let mut cfg = config("kimi");
        cfg.reasoning_effort = Some("off".into());
        let mut p = Protocol::new(cfg);
        p.kimi_config_options(
            &json!({"configOptions":[{"id":"thinking","options":[{"value":"on"}]}]}),
        );
        assert!(p.receive(json!({"id":4,"result":{}})).is_err());
    }

    /// Recorded from Kimi Code 2.3.1 `acp` after `session/set_config_option` model=kimi-code/k3.1-pro.
    #[test]
    fn kimi_sets_a_recorded_thinking_level() {
        let mut cfg = config("kimi");
        cfg.model = "kimi-code/k3.1-pro".into();
        cfg.reasoning_effort = Some("low".into());
        let mut p = Protocol::new(cfg);
        p.remote_id = "remote".into();
        p.receive(json!({"id":4,"result":{}})).unwrap();
        p.receive(json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"remote","update":{"sessionUpdate":"config_option_update","configOptions":[
            {"type":"select","id":"thinking","name":"Thinking","category":"thought_level","currentValue":"max","options":[{"value":"low","name":"Thinking Low"},{"value":"high","name":"Thinking High"},{"value":"max","name":"Thinking Max"}]}]}}})).unwrap();
        let thinking = p.receive(json!({"id":5,"result":{}})).unwrap();
        assert_eq!(thinking.write[0]["params"]["configId"], "thinking");
        assert_eq!(thinking.write[0]["params"]["value"], "low");
    }

    #[test]
    fn usage_uses_current_context_not_cumulative_cost_or_subagent_tokens() {
        let mut p = Protocol::new(config("codex"));
        p.remote_id = "remote".into();
        let step=p.receive(json!({"method":"thread/tokenUsage/updated","params":{"threadId":"remote","tokenUsage":{"last":{"totalTokens":1234},"total":{"totalTokens":999999},"modelContextWindow":200000}}})).unwrap();
        assert_eq!(
            step.events[0].data,
            json!({"usedTokens":1234,"contextWindow":200000}).into()
        );
        let step=p.receive(json!({"method":"thread/tokenUsage/updated","params":{"threadId":"other","tokenUsage":{"last":{"totalTokens":1234}}}})).unwrap();
        assert!(step.events.is_empty());
        let mut p = Protocol::new(config("claude"));
        let step=p.receive(json!({"type":"stream_event","parent_tool_use_id":null,"event":{"type":"message_start","message":{"model":"actual","usage":{"input_tokens":10,"cache_read_input_tokens":100,"cache_creation_input_tokens":20,"output_tokens":1}}}})).unwrap();
        assert_eq!(step.events[0].data.as_ref().unwrap()["usedTokens"], 131);
        let step=p.receive(json!({"type":"stream_event","parent_tool_use_id":"subagent","event":{"type":"message_start","message":{"model":"other","usage":{"input_tokens":9000,"output_tokens":10}}}})).unwrap();
        assert!(step.events.iter().all(|event| event.kind != "usage"));
        let step=p.receive(json!({"type":"stream_event","event":{"type":"message_delta","usage":{"output_tokens":8}}})).unwrap();
        assert_eq!(step.events[0].data.as_ref().unwrap()["usedTokens"], 138);
        let step=p.receive(json!({"type":"result","modelUsage":{"actual":{"inputTokens":999999,"outputTokens":99999,"contextWindow":200000},"other":{"contextWindow":1000000}}})).unwrap();
        assert_eq!(
            step.events[0].data,
            json!({"usedTokens":138,"contextWindow":200000}).into()
        );
        let mut p = Protocol::new(config("kimi"));
        p.phase = 1;
        let step=p.receive(json!({"method":"session/update","params":{"update":{"sessionUpdate":"usage_update","used":4096,"size":262144}}})).unwrap();
        assert_eq!(
            step.events[0].data,
            json!({"usedTokens":4096,"contextWindow":262144}).into()
        );
        let step=p.receive(json!({"method":"session/update","params":{"update":{"sessionUpdate":"usage_update","used":-1,"size":262144}}})).unwrap();
        assert!(step.events.is_empty());
    }

    #[test]
    fn codex_modes_apply_to_start_resume_and_every_turn() {
        for (mode, sandbox, sandbox_type, policy, reviewer) in [
            (
                "ask",
                "workspace-write",
                "workspaceWrite",
                "on-request",
                "user",
            ),
            (
                "auto",
                "workspace-write",
                "workspaceWrite",
                "on-request",
                "auto_review",
            ),
            ("plan", "read-only", "readOnly", "never", "user"),
            (
                "full",
                "danger-full-access",
                "dangerFullAccess",
                "never",
                "user",
            ),
        ] {
            for resume in [false, true] {
                let mut cfg = config("codex");
                cfg.mode = mode.into();
                cfg.cwd = PathBuf::from("/tmp/selected-project");
                cfg.resume_id = resume.then(|| "previously-full-access-thread".into());
                let mut p = Protocol::new(cfg);
                let start = p.receive(json!({"id":1,"result":{}})).unwrap();
                let request = if resume {
                    assert_eq!(start.write[1]["method"], "thread/goal/get");
                    p.receive(json!({"id":start.write[1]["id"],"result":{"goal":null}}))
                        .unwrap()
                        .write
                        .remove(0)
                } else {
                    start.write[1].clone()
                };
                assert_eq!(
                    request["method"],
                    if resume {
                        "thread/resume"
                    } else {
                        "thread/start"
                    }
                );
                assert_eq!(request["params"]["sandbox"], sandbox);
                assert_eq!(request["params"]["approvalPolicy"], policy);
                assert_eq!(request["params"]["approvalsReviewer"], reviewer);
                let turn = p
                    .receive(json!({"id":2,"result":{"thread":{"id":"same-thread"}}}))
                    .unwrap();
                let params = &turn.write[0]["params"];
                assert_eq!(params["approvalPolicy"], policy);
                assert_eq!(params["approvalsReviewer"], reviewer);
                assert_eq!(params["sandboxPolicy"]["type"], sandbox_type);
                if mode != "full" {
                    assert_eq!(params["sandboxPolicy"]["networkAccess"], false);
                }
                if matches!(mode, "ask" | "auto") {
                    assert_eq!(
                        params["sandboxPolicy"]["writableRoots"],
                        json!(["/tmp/selected-project"])
                    );
                }
            }
        }
    }

    #[test]
    fn claude_and_glm_modes_override_resume_and_only_full_enables_bypass() {
        for provider in ["claude", "glm"] {
            for (mode, expected) in [
                ("ask", "default"),
                ("auto", "acceptEdits"),
                ("review", "auto"),
                ("plan", "plan"),
                ("full", "bypassPermissions"),
            ] {
                let mut cfg = config(provider);
                cfg.mode = mode.into();
                cfg.resume_id = Some("previously-full-access-session".into());
                let mut command = Command::new("claude");
                configure_command(&mut command, &cfg);
                let args: Vec<_> = command
                    .as_std()
                    .get_args()
                    .map(|arg| arg.to_string_lossy().into_owned())
                    .collect();
                let permission = args
                    .iter()
                    .position(|arg| arg == "--permission-mode")
                    .unwrap();
                assert_eq!(args[permission + 1], expected);
                assert_eq!(
                    args.iter()
                        .any(|arg| arg == "--allow-dangerously-skip-permissions"),
                    mode == "full"
                );
                assert!(args
                    .iter()
                    .any(|arg| arg == "--resume=previously-full-access-session"));
            }
        }
    }

    #[test]
    fn kimi_modes_use_engine_semantics_and_wait_for_confirmation_before_prompt() {
        for (mode, expected) in [
            ("ask", "default"),
            ("auto", "yolo"),
            ("plan", "plan"),
            ("full", "auto"),
        ] {
            let mut cfg = config("kimi");
            cfg.mode = mode.into();
            cfg.resume_id = Some("previously-full-access-session".into());
            let mut p = Protocol::new(cfg);
            let step = p.receive(json!({"id":2,"result":{"sessionId":"same-session","modes":{"currentModeId":"auto","availableModes":[{"id":"default"},{"id":"plan"},{"id":"auto"},{"id":"yolo"}]}}})).unwrap();
            assert_eq!(step.write.len(), 1);
            assert_eq!(step.write[0]["method"], "session/set_mode");
            assert_eq!(step.write[0]["params"]["modeId"], expected);
            assert!(!p.config.prompt.is_empty());
            let prompt = p.receive(json!({"id":4,"result":{}})).unwrap();
            assert_eq!(prompt.write[0]["method"], "session/prompt");
        }
    }

    #[test]
    fn unsupported_kimi_mode_or_failed_selection_never_sends_prompt() {
        for mode in ["auto", "plan", "full"] {
            let mut cfg = config("kimi");
            cfg.mode = mode.into();
            let mut p = Protocol::new(cfg);
            let result = p.receive(json!({"id":2,"result":{"sessionId":"s","modes":{"availableModes":[{"id":"default"}]}}}));
            assert!(result.err().unwrap().contains("does not advertise"));
            assert_eq!(p.phase, 0);
            assert!(!p.config.prompt.is_empty());
        }
        let mut p = Protocol::new(config("kimi"));
        assert!(p
            .receive(json!({"id":4,"error":{"message":"Mode is blocked by your administrator"}}))
            .is_err());
        assert_eq!(p.phase, 0);
        assert!(!p.config.prompt.is_empty());
    }

    #[test]
    fn claude_sends_screenshots_in_the_user_message_and_releases_image_data() {
        let mut p = Protocol::new(config("claude"));
        p.image_blocks = vec![
            json!({"type":"image","source":{"type":"base64","media_type":"image/png","data":"PRIVATE_IMAGE"}}),
        ];
        let step = p.receive(json!({"type":"control_response","response":{"request_id":"pandacode-init","subtype":"success"}})).unwrap();
        assert_eq!(
            step.write[0]["message"]["content"][0]["source"]["data"],
            "PRIVATE_IMAGE"
        );
        assert_eq!(
            step.write[0]["message"]["content"][1]["text"],
            "Explain this project"
        );
        assert!(p.image_blocks.is_empty());
        assert!(p.config.prompt.is_empty());
        assert!(!serde_json::to_string(&step.events)
            .unwrap()
            .contains("PRIVATE_IMAGE"));
    }

    #[test]
    fn codex_includes_local_images_in_the_same_turn_as_the_prompt() {
        let mut p = Protocol::new(config("codex"));
        p.image_blocks = vec![json!({"type":"localImage","path":"/tmp/managed-capture.png"})];
        let step = p
            .receive(json!({"id":2,"result":{"thread":{"id":"remote-thread"}}}))
            .unwrap();
        assert_eq!(step.write[0]["method"], "turn/start");
        assert_eq!(step.write[0]["params"]["input"][0]["type"], "localImage");
        assert_eq!(
            step.write[0]["params"]["input"][0]["path"],
            "/tmp/managed-capture.png"
        );
        assert_eq!(
            step.write[0]["params"]["input"][1]["text"],
            "Explain this project"
        );
        assert!(p.image_blocks.is_empty());
    }

    #[test]
    fn kimi_requires_image_capability_and_delivers_images_after_mode_selection() {
        let image = json!({"type":"image","mimeType":"image/png","data":"PRIVATE_IMAGE"});
        let mut unsupported = Protocol::new(config("kimi"));
        unsupported.image_blocks = vec![image.clone()];
        let error = unsupported
            .receive(json!({"id":1,"result":{"protocolVersion":1,"agentCapabilities":{}}}))
            .err()
            .unwrap();
        assert!(error.contains("does not support screenshot input"));

        let mut p = Protocol::new(config("kimi"));
        p.image_blocks = vec![image];
        let initialized = p.receive(json!({"id":1,"result":{"protocolVersion":1,"agentCapabilities":{"promptCapabilities":{"image":true}}}})).unwrap();
        assert_eq!(initialized.write[0]["method"], "session/new");
        let mode = p.receive(json!({"id":2,"result":{"sessionId":"remote-kimi","modes":{"availableModes":[{"id":"default"}]}}})).unwrap();
        assert_eq!(mode.write[0]["method"], "session/set_mode");
        assert!(!p.image_blocks.is_empty());
        let prompt = p.receive(json!({"id":4,"result":{}})).unwrap();
        assert_eq!(prompt.write[0]["method"], "session/prompt");
        assert_eq!(
            prompt.write[0]["params"]["prompt"][0]["data"],
            "PRIVATE_IMAGE"
        );
        assert_eq!(
            prompt.write[0]["params"]["prompt"][1]["text"],
            "Explain this project"
        );
        assert!(p.image_blocks.is_empty());
        assert!(!serde_json::to_string(&prompt.events)
            .unwrap()
            .contains("PRIVATE_IMAGE"));
    }

    #[test]
    fn kimi_image_model_errors_preserve_the_actionable_reason() {
        let mut cfg = config("kimi");
        cfg.images.push(PathBuf::from("/tmp/managed.png"));
        let mut p = Protocol::new(cfg);
        let error = p.receive(json!({"id":3,"error":{"code":-32603,"message":"Internal error","data":{"error":"Selected model does not support image_in"}}})).err().unwrap();
        assert!(error.contains("does not support image_in"));
    }

    #[test]
    fn screenshot_only_prompts_do_not_include_invalid_empty_text_blocks() {
        for provider in ["claude", "codex", "kimi"] {
            let mut cfg = config(provider);
            cfg.prompt.clear();
            let mut p = Protocol::new(cfg);
            p.image_blocks = vec![if provider == "codex" {
                json!({"type":"localImage","path":"/tmp/managed.png"})
            } else if provider == "claude" {
                json!({"type":"image","source":{"type":"base64","media_type":"image/png","data":"PRIVATE_IMAGE"}})
            } else {
                json!({"type":"image","mimeType":"image/png","data":"PRIVATE_IMAGE"})
            }];
            let response = match provider {
                "claude" => {
                    json!({"type":"control_response","response":{"request_id":"pandacode-init","subtype":"success"}})
                }
                "codex" => json!({"id":2,"result":{"thread":{"id":"remote"}}}),
                _ => json!({"id":4,"result":{}}),
            };
            let step = p.receive(response).unwrap();
            let content = match provider {
                "claude" => &step.write[0]["message"]["content"],
                "codex" => &step.write[0]["params"]["input"],
                _ => &step.write[0]["params"]["prompt"],
            };
            assert_eq!(content.as_array().unwrap().len(), 1);
            assert_ne!(content[0]["type"], "text");
        }
    }

    #[test]
    fn provider_write_provenance_survives_sparse_completions_and_large_arguments() {
        let mut codex = Protocol::new(config("codex"));
        let start=codex.receive(json!({"method":"item/started","params":{"item":{"type":"fileChange","id":"edit","status":"inProgress","changes":[{"path":"old.txt","kind":{"type":"update","move_path":"new.txt"},"diff":""}]}}})).unwrap();
        assert_eq!(activity(&start)["writePaths"],json!(["old.txt","new.txt"]));
        let end=codex.receive(json!({"method":"item/completed","params":{"item":{"type":"fileChange","id":"edit","status":"completed"}}})).unwrap();
        assert_eq!(activity(&end)["writePaths"],json!(["old.txt","new.txt"]));

        let mut claude = Protocol::new(config("claude"));
        let start=claude.receive(json!({"type":"assistant","message":{"id":"message","content":[{"type":"tool_use","id":"edit","name":"Write","input":{"content":"x".repeat(100_000),"file_path":"large.txt"}}]}})).unwrap();
        assert_eq!(activity(&start)["writePaths"],json!(["large.txt"]));
        let end=claude.receive(json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"edit","content":"Wrote file"}]}})).unwrap();
        assert_eq!(activity(&end)["writePaths"],json!(["large.txt"]));
        let read=claude.receive(json!({"type":"assistant","message":{"id":"read","content":[{"type":"tool_use","id":"read","name":"Read","input":{"file_path":"README.md"}}]}})).unwrap();
        assert!(activity(&read)["writePaths"].is_null());

        for provider in ["kimi", "opencode", "antigravity", "grok"] {
            let mut acp = Protocol::new(config(provider));
            acp.phase = 1;
            acp.remote_id = "remote".into();
            acp.receive(json!({"method":"session/update","params":{"sessionId":"remote","update":{"sessionUpdate":"tool_call","toolCallId":"edit","title":"Editing source","kind":"edit","status":"in_progress"}}})).unwrap();
            let start=acp.receive(json!({"method":"session/update","params":{"sessionId":"remote","update":{"sessionUpdate":"tool_call","toolCallId":"edit","status":"in_progress","locations":[{"path":"source.rs","line":1}],"rawInput":{"path":"source.rs"}}}})).unwrap();
            assert_eq!(activity(&start)["writePaths"],json!(["source.rs"]));
            let end=acp.receive(json!({"method":"session/update","params":{"sessionId":"remote","update":{"sessionUpdate":"tool_call_update","toolCallId":"edit","kind":"edit","status":"completed"}}})).unwrap();
            assert_eq!(activity(&end)["writePaths"],json!(["source.rs"]));
        }
    }

    #[test]
    fn claude_tool_details_pair_arguments_with_failed_result() {
        let mut p = Protocol::new(config("claude"));
        let start = p.receive(json!({"type":"assistant","message":{"id":"msg-1","content":[{"type":"tool_use","id":"call-1","name":"Read","input":{"file_path":"/tmp/example.rs","limit":20}}]}})).unwrap();
        let tool = activity(&start);
        assert_eq!(tool["id"], "call-1");
        assert_eq!(tool["name"], "Read");
        assert_eq!(tool["status"], "running");
        assert!(tool["input"].as_str().unwrap().contains("/tmp/example.rs"));
        let result = p.receive(json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"call-1","is_error":true,"content":[{"type":"text","text":"File not found"},{"type":"image","source":{"data":"DO_NOT_EXPORT_BASE64"}}]}]}})).unwrap();
        let tool = activity(&result);
        assert_eq!(tool["id"], "call-1");
        assert_eq!(tool["name"], "Read");
        assert_eq!(tool["status"], "failed");
        assert!(tool["input"].as_str().unwrap().contains("/tmp/example.rs"));
        assert!(tool["output"].as_str().unwrap().contains("File not found"));
        assert!(!tool["output"]
            .as_str()
            .unwrap()
            .contains("DO_NOT_EXPORT_BASE64"));
    }

    #[test]
    fn claude_partial_tool_arguments_emit_at_block_stop_and_replay_deduplicates() {
        let mut p = Protocol::new(config("claude"));
        p.receive(
            json!({"type":"stream_event","event":{"type":"message_start","message":{"id":"m1"}}}),
        )
        .unwrap();
        p.receive(json!({"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"Bash","input":{}}}})).unwrap();
        for fragment in ["{\"command\":", "\"printf hello\"}"] {
            let step=p.receive(json!({"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":fragment}}})).unwrap();
            assert!(
                step.events.is_empty(),
                "Do not persist every argument fragment"
            );
        }
        let stop = p
            .receive(json!({"type":"stream_event","event":{"type":"content_block_stop","index":0}}))
            .unwrap();
        assert!(activity(&stop)["input"]
            .as_str()
            .unwrap()
            .contains("printf hello"));
        let full = json!({"type":"assistant","message":{"id":"m1","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"printf hello"}}]}});
        assert!(p.receive(full.clone()).unwrap().events.is_empty());
        p.receive(json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"hello"}]}})).unwrap();
        assert!(
            p.receive(full).unwrap().events.is_empty(),
            "Replayed tool_use must not reopen a finished call"
        );
    }

    #[test]
    fn codex_tool_details_include_command_output_and_exit_failure() {
        let mut p = Protocol::new(config("codex"));
        let start=p.receive(json!({"method":"item/started","params":{"item":{"type":"commandExecution","id":"cmd1","command":"cargo test","cwd":"/tmp/project","status":"inProgress"}}})).unwrap();
        assert!(activity(&start)["input"]
            .as_str()
            .unwrap()
            .contains("cargo test"));
        let done=p.receive(json!({"method":"item/completed","params":{"item":{"type":"commandExecution","id":"cmd1","status":"completed","aggregatedOutput":"test failed: expected 4, got 5","exitCode":1}}})).unwrap();
        let tool = activity(&done);
        assert_eq!(tool["status"], "failed");
        assert!(tool["input"].as_str().unwrap().contains("/tmp/project"));
        assert!(tool["output"]
            .as_str()
            .unwrap()
            .contains("expected 4, got 5"));
        assert!(tool["output"].as_str().unwrap().contains("Exit code: 1"));
    }

    #[test]
    fn codex_file_and_mcp_details_keep_useful_text_without_binary_payloads() {
        let mut p = Protocol::new(config("codex"));
        let file=p.receive(json!({"method":"item/completed","params":{"item":{"type":"fileChange","id":"f1","status":"completed","changes":[{"path":"src/main.rs","kind":{"type":"update"},"diff":"- old\n+ new"}]}}})).unwrap();
        assert!(activity(&file)["input"]
            .as_str()
            .unwrap()
            .contains("src/main.rs"));
        assert!(activity(&file)["output"]
            .as_str()
            .unwrap()
            .contains("+ new"));
        let mcp=p.receive(json!({"method":"item/completed","params":{"item":{"type":"mcpToolCall","id":"mcp1","server":"docs","tool":"search","arguments":{"query":"lifetimes"},"status":"completed","result":{"content":[{"type":"text","text":"Three results"},{"type":"image","data":"BINARY_SECRET"}],"_meta":{"private":"HIDDEN_METADATA"}}}}})).unwrap();
        let tool = activity(&mcp);
        assert!(tool["name"].as_str().unwrap().contains("search"));
        assert!(tool["input"].as_str().unwrap().contains("lifetimes"));
        assert!(tool["output"].as_str().unwrap().contains("Three results"));
        assert!(!tool.to_string().contains("BINARY_SECRET"));
        assert!(!tool.to_string().contains("HIDDEN_METADATA"));
    }

    #[test]
    fn kimi_sparse_updates_preserve_input_and_replace_cumulative_content() {
        let mut p = Protocol::new(config("kimi"));
        p.phase = 1;
        p.remote_id = "s".into();
        let envelope = |update: Value| json!({"method":"session/update","params":{"sessionId":"s","update":update}});
        p.receive(envelope(json!({"sessionUpdate":"tool_call","toolCallId":"1:t1","title":"Read","status":"pending","content":[{"type":"content","content":{"type":"text","text":"{\"path\":"}}]}))).unwrap();
        let fragment=p.receive(envelope(json!({"sessionUpdate":"tool_call_update","toolCallId":"1:t1","status":"in_progress","content":[{"type":"content","content":{"type":"text","text":"{\"path\":\"/tmp/a"}}]}))).unwrap();
        assert!(
            fragment.events.is_empty(),
            "Argument fragments stay native until a complete input or result"
        );
        p.receive(envelope(json!({"sessionUpdate":"tool_call_update","toolCallId":"1:t1","status":"in_progress","rawInput":{"path":"/tmp/a.txt"},"content":[{"type":"content","content":{"type":"text","text":"{\"path\":\"/tmp/a.txt\"}"}}]}))).unwrap();
        let progress=p.receive(envelope(json!({"sessionUpdate":"tool_call_update","toolCallId":"1:t1","title":"Reading a.txt"}))).unwrap();
        assert!(activity(&progress)["input"]
            .as_str()
            .unwrap()
            .contains("/tmp/a.txt"));
        let done = envelope(
            json!({"sessionUpdate":"tool_call_update","toolCallId":"1:t1","status":"completed","content":[{"type":"content","content":{"type":"text","text":"file contents"}}]}),
        );
        let result = p.receive(done.clone()).unwrap();
        let tool = activity(&result);
        assert_eq!(tool["name"], "Reading a.txt");
        assert_eq!(tool["status"], "completed");
        assert_eq!(tool["output"], "file contents");
        assert!(tool["input"].as_str().unwrap().contains("/tmp/a.txt"));
        assert!(p.receive(done).unwrap().events.is_empty());
        let unrelated = p.receive(json!({"method":"session/update","params":{"sessionId":"another-session","update":{"sessionUpdate":"tool_call_update","toolCallId":"1:t1","status":"failed","rawOutput":"Not this session"}}})).unwrap();
        assert!(unrelated.events.is_empty());
        assert_eq!(p.tools["1:t1"].status, "completed");
    }

    #[test]
    fn tool_details_have_utf8_byte_limits_and_explicit_truncation() {
        let mut p = Protocol::new(config("claude"));
        let start=p.receive(json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":"huge","name":"Write","input":{"file_path":"/tmp/file","content":"🦀".repeat(100_000)}}]}})).unwrap();
        let result=p.receive(json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"huge","content":"é".repeat(100_000)}]}})).unwrap();
        let input = activity(&start)["input"].as_str().unwrap().to_owned();
        let output = activity(&result)["output"].as_str().unwrap().to_owned();
        assert!(input.len() <= 4096 && output.len() <= 8192);
        assert!(input.contains("truncated") && output.contains("truncated"));
        assert!(
            input.contains("/tmp/file"),
            "Keep the file path before large Write content"
        );
        assert!(serde_json::to_vec(&result.events[0]).unwrap().len() < 16 * 1024);
    }

    #[test]
    fn structured_tool_outputs_are_bounded_and_omit_binary_metadata() {
        let mut p = Protocol::new(config("codex"));
        let result=p.receive(json!({"method":"item/completed","params":{"item":{"type":"mcpToolCall","id":"structured","tool":"query","status":"completed","result":{"content":[],"structuredContent":{"rows":[{"name":"Found record"}],"_meta":{"secret":"HIDDEN_META"},"attachment":{"type":"image","data":"HIDDEN_IMAGE"}}}}}})).unwrap();
        let output = activity(&result)["output"].as_str().unwrap().to_owned();
        assert!(output.contains("Found record"));
        assert!(!output.contains("HIDDEN_META") && !output.contains("HIDDEN_IMAGE"));
        let mut p = Protocol::new(config("kimi"));
        p.phase = 1;
        let result=p.receive(json!({"method":"session/update","params":{"update":{"sessionUpdate":"tool_call_update","toolCallId":"sparse","status":"completed","rawOutput":{"stdout":"command output","exitCode":0}}}})).unwrap();
        assert!(activity(&result)["output"]
            .as_str()
            .unwrap()
            .contains("command output"));
        let late=p.receive(json!({"method":"session/update","params":{"update":{"sessionUpdate":"tool_call_update","toolCallId":"sparse","content":[{"type":"content","content":{"type":"text","text":"final output"}}]}}})).unwrap();
        assert_eq!(activity(&late)["output"], "final output");
        assert_eq!(activity(&late)["input"], "");
    }

    #[test]
    fn tool_caches_and_partial_argument_buffers_remain_bounded() {
        let mut p = Protocol::new(config("claude"));
        for index in 0..80 {
            p.receive(json!({"type":"stream_event","event":{"type":"content_block_start","index":index,"content_block":{"type":"tool_use","id":format!("t{index}"),"name":"Write","input":{}}}})).unwrap();
            p.receive(json!({"type":"stream_event","event":{"type":"content_block_delta","index":index,"delta":{"type":"input_json_delta","partial_json":"🦀".repeat(10_000)}}})).unwrap();
        }
        assert!(p.tools.len() <= 64 && p.tool_order.len() <= 64 && p.partial_tools.len() <= 64);
        assert!(p
            .partial_tools
            .values()
            .all(|tool| tool.json.len() <= 4096 && tool.json.contains("truncated")));
    }

    #[test]
    fn model_catalog_uses_invocation_ids_and_filters_hidden_duplicates() {
        let models = parse_codex_models(&json!({"data":[
            {"id":"display-id","model":"actual-model","displayName":"Actual Model 2","description":"Provider description","hidden":false},
            {"id":"legacy-id","name":"Legacy Model"},
            {"model":"actual-model"},
            {"model":"hidden-model","hidden":true},
            {"model":""},
            {"model":"bad\nmodel"},
            {"model":"x".repeat(201)}
        ]}))
        .unwrap();
        assert_eq!(
            models
                .iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>(),
            ["default", "actual-model", "legacy-id"]
        );
        assert_eq!(models[1].name, "Actual Model 2");
        assert_eq!(models[1].description, "Provider description");
        assert_eq!(models[2].name, "Legacy Model");
    }

    #[test]
    fn model_catalogs_report_speed_tiers_from_the_harness() {
        let models = parse_codex_models(&json!({"data":[
            {"model":"fast","serviceTiers":[{"id":"priority","name":"Fast","description":"1.5x speed"},{"id":"ultrafast","name":"Ultra Fast"},{"id":"priority","name":"Dup"},{"id":""},{"id":"bad\nid"},{"name":"No id"}]},
            {"model":"plain","serviceTiers":[]}
        ]})).unwrap();
        let tiers: Vec<_> = models[1].speed_tiers.iter().map(|tier| (tier.id.as_str(), tier.name.as_str(), tier.description.as_str())).collect();
        assert_eq!(tiers, [("priority", "Fast", "1.5x speed"), ("ultrafast", "Ultra Fast", "")]);
        assert!(models[2].speed_tiers.is_empty());
        assert!(serde_json::to_value(&models[2]).unwrap().get("speedTiers").is_none());
        assert_eq!(serde_json::to_value(&models[1]).unwrap()["speedTiers"][1]["id"], "ultrafast");
        let many: Vec<_> = (0..20).map(|n| json!({"id":format!("t{n}")})).collect();
        assert_eq!(parse_codex_models(&json!({"data":[{"model":"m","serviceTiers":many}]})).unwrap()[1].speed_tiers.len(), 8);

        let claude = parse_claude_models(&json!({"models":[{"value":"opus","supportsFastMode":true},{"value":"haiku"}]})).unwrap();
        assert_eq!(claude[1].speed_tiers.iter().map(|tier| tier.id.as_str()).collect::<Vec<_>>(), ["fast"]);
        assert!(claude[2].speed_tiers.is_empty());
    }

    #[test]
    fn claude_fast_mode_is_passed_as_a_flag_setting_only_when_chosen() {
        let args = |provider: &str, settings: Option<Value>| {
            let mut cfg = config(provider);
            cfg.codex_settings = settings;
            let mut command = Command::new("claude");
            configure_command(&mut command, &cfg);
            command.as_std().get_args().map(|arg| arg.to_string_lossy().into_owned()).collect::<Vec<_>>()
        };
        let fast = ["--settings".to_string(), r#"{"fastMode":true}"#.to_string()];
        assert!(args("claude", Some(json!({"serviceTier":"fast"}))).windows(2).any(|pair| pair == fast));
        for (provider, settings) in [("claude", None), ("claude", Some(json!({"serviceTier":null}))), ("glm", Some(json!({"serviceTier":"fast"})))] {
            assert!(!args(provider, settings).iter().any(|arg| arg == "--settings"));
        }
    }

    #[test]
    fn model_catalog_rejects_malformed_or_oversized_pages() {
        assert!(parse_codex_models(&json!({"models":[]})).is_err());
        assert!(parse_codex_models(&json!({"data":vec![json!({"model":"m"});101]})).is_err());
    }

    #[tokio::test]
    async fn model_listing_rejects_unknown_provider_without_starting_a_process() {
        assert_eq!(list_models("shell").await.unwrap_err(), "Unknown provider");
    }

    #[test]
    fn every_registered_provider_has_a_model_discovery_slot() {
        assert_eq!(model_discovery_semaphores().len(), PROVIDERS.len());
        for (index, (id, _)) in PROVIDERS.iter().enumerate() {
            assert_eq!(model_discovery_index(id), Some(index));
            assert!(index < model_discovery_semaphores().len());
        }
        assert!(PROVIDERS.iter().any(|(id, _)| *id == "github-copilot"));
        assert_eq!(model_discovery_index("not-a-provider"), None);
    }

    #[test]
    fn claude_catalog_uses_resolved_releases_without_changing_invocation_aliases() {
        let models = parse_claude_models(&json!({"models":[
            {"value":"default","resolvedModel":"claude-opus-5[1m]","displayName":"Default (recommended)"},
            {"value":"sonnet","resolvedModel":"claude-sonnet-5","displayName":"Sonnet","description":"Sonnet 5 · Efficient for routine tasks"},
            {"value":"haiku","resolvedModel":"claude-haiku-4-5-20251001","displayName":"Haiku"},
            {"value":"claude-fable-5-1[1m]","resolvedModel":"claude-fable-5-1","displayName":"Fable"},
            {"value":"sonnet","displayName":"Duplicate"},
            {"value":""}, {"value":"bad\nmodel"}
        ]})).unwrap();
        assert_eq!(models.len(), 4);
        assert_eq!(models[0].name, "Default · Claude Opus 5 (1M context)");
        assert_eq!(models[1].id, "sonnet");
        assert_eq!(models[1].name, "Claude Sonnet 5");
        assert_eq!(
            models[1].description,
            "Sonnet 5 · Efficient for routine tasks"
        );
        assert_eq!(models[2].name, "Claude Haiku 4.5");
        assert_eq!(models[3].name, "Claude Fable 5.1");
    }

    #[test]
    fn claude_catalog_never_guesses_unresolved_or_custom_model_versions() {
        let models = parse_claude_models(&json!({"models":[
            {"value":"sonnet","displayName":"Sonnet"},
            {"value":"custom","resolvedModel":"custom/vendor-model-v9","displayName":"Custom"},
            {"value":"future","resolvedModel":"claude-future-x","displayName":"Future"},
            {"value":"provider-model","displayName":"Model Name 3.2"}
        ]}))
        .unwrap();
        assert_eq!(models[0], ModelInfo::default_choice());
        assert_eq!(models[1].name, "Claude Sonnet");
        assert_eq!(models[2].name, "custom/vendor-model-v9");
        assert_eq!(models[3].name, "claude-future-x");
        assert_eq!(models[4].name, "Model Name 3.2");
        assert!(parse_claude_models(&json!({})).is_err());
        assert!(parse_claude_models(&json!({"models":vec![json!({});101]})).is_err());
    }

    #[tokio::test]
    async fn claude_catalog_reads_an_initialize_frame_over_256_kib() {
        // #276: many skills and plugins push Claude's one-line initialize reply
        // past the old 256 KiB frame limit.
        let commands: Vec<Value> = (0..3000).map(|i| json!({"name":format!("skill-{i}"),"description":"d".repeat(100)})).collect();
        let init = json!({"type":"control_response","response":{"request_id":"pandacode-models","subtype":"success","response":{"commands":commands,"models":[{"value":"sonnet","resolvedModel":"claude-sonnet-5","displayName":"Sonnet"}]}}});
        let output = format!("{{\"type\":\"system\"}}\n{init}\n");
        assert!(output.len() > 256 * 1024);
        let models = read_claude_models(&mut output.as_bytes()).await.unwrap();
        assert_eq!(models[1].id, "sonnet");
        // Memory stays bounded: an endless frame is refused at the limit.
        let endless = vec![b'x'; CLAUDE_INIT_FRAME + 1];
        assert!(read_claude_models(&mut endless.as_slice()).await.unwrap_err().contains("too large"));
    }

    #[test]
    fn model_catalog_bounds_display_metadata_and_serializes_only_picker_fields() {
        let models = parse_codex_models(&json!({"data":[{"model":"actual","displayName":"a".repeat(500),"description":"b".repeat(2000),"account":"private"}]})).unwrap();
        assert_eq!(models[1].name.len(), 200);
        assert_eq!(models[1].description.len(), 1000);
        let output = serde_json::to_value(&models[1]).unwrap();
        let keys: HashSet<_> = output
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            HashSet::from([
                "id",
                "name",
                "description",
                "reasoningEfforts",
                "defaultReasoningEffort",
                "contextWindow"
            ])
        );
        assert!(output.get("account").is_none());
    }

    /// Read-only CLI initialization; no user prompt or model inference.
    #[tokio::test]
    #[ignore]
    async fn installed_claude_catalog() {
        let path = executable("claude").expect("Install Claude Code to check its catalog");
        let start = std::time::Instant::now();
        let models = claude_models(&path).await.unwrap();
        assert!(models.len() > 1);
        for model in models {
            println!("{}: {}", model.id, model.name);
        }
        println!("Catalog completed in {:?}", start.elapsed());
    }

    /// Read-only app-server metadata; no thread or model inference.
    #[tokio::test]
    #[ignore]
    async fn installed_codex_catalog() {
        let path = executable("codex").expect("Install Codex to check its catalog");
        let models = codex_models(&path).await.unwrap();
        assert!(models.len() > 1);
        for model in models {
            println!("{}: {}", model.id, model.name);
        }
    }

    #[test]
    fn claude_stream_does_not_repeat_completed_text() {
        let mut p = Protocol::new(config("claude"));
        let delta = p.receive(json!({"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}})).unwrap();
        assert_eq!(delta.events[0].kind, "message_start");
        assert_eq!(delta.events[1].text, "Hello");
        let complete = p
            .receive(
                json!({"type":"assistant","message":{"content":[{"type":"text","text":"Hello"}]}}),
            )
            .unwrap();
        assert!(complete.events.is_empty());
    }

    #[test]
    fn codex_approval_is_pending_until_explicit_response() {
        let mut p = Protocol::new(config("codex"));
        let step = p.receive(json!({"id":77,"method":"item/commandExecution/requestApproval","params":{"command":"git status","itemId":"tool1"}})).unwrap();
        assert!(step.write.is_empty());
        let id = step.events[0].request_id.as_ref().unwrap();
        let response = p.approve(id, false).unwrap();
        assert_eq!(response, json!({"id":77,"result":{"decision":"decline"}}));
        assert!(p.approve(id, true).is_none());
    }

    #[test]
    fn tool_events_bound_output_and_exclude_opaque_payloads() {
        let mut p = Protocol::new(config("codex"));
        let step = p.receive(json!({"method":"item/completed","params":{"item":{"type":"commandExecution","id":"tool-1","status":"completed","command":"git status","aggregatedOutput":"x".repeat(2 * 1024 * 1024),"other":{"payload":"large"}}}})).unwrap();
        let event = &step.events[0];
        assert_eq!(event.text, "Command · completed");
        assert!(event.data.is_none());
        let tool = event.tool.as_ref().unwrap();
        assert_eq!(tool.status, "completed");
        assert_eq!(tool.input, "git status");
        assert!(tool.output.len() <= TOOL_OUTPUT_LIMIT);
        assert!(tool.output.ends_with(PREVIEW_TRUNCATED));
        assert!(!serde_json::to_string(event).unwrap().contains("payload"));
        assert!(serde_json::to_vec(event).unwrap().len() < 16 * 1024);
    }

    #[test]
    fn approval_keeps_full_input_native_without_copying_it_to_ui() {
        let mut p = Protocol::new(config("claude"));
        let content = "x".repeat(1024 * 1024);
        let step=p.receive(json!({"type":"control_request","request_id":"req-1","request":{"subtype":"can_use_tool","tool_name":"Write","input":{"file_path":"/tmp/answer.txt","content":content}}})).unwrap();
        let event = &step.events[0];
        assert!(serde_json::to_vec(event).unwrap().len() < 2048);
        let response = p.approve(event.request_id.as_ref().unwrap(), true).unwrap();
        assert_eq!(
            response["response"]["response"]["updatedInput"]["content"],
            content
        );
    }

    #[test]
    fn kimi_approval_uses_offered_option_id() {
        let mut p = Protocol::new(config("kimi"));
        let step = p.receive(json!({"jsonrpc":"2.0","id":"req-8","method":"session/request_permission","params":{"sessionId":"s","toolCall":{"title":"Edit file"},"options":[{"optionId":"custom-yes","kind":"allow_once"},{"optionId":"custom-no","kind":"reject_once"}]}})).unwrap();
        let id = step.events[0].request_id.as_ref().unwrap();
        assert_eq!(
            p.approve(id, true).unwrap()["result"]["outcome"]["optionId"],
            "custom-yes"
        );
    }

    #[test]
    fn only_the_run_that_owns_a_worker_mark_clears_it() {
        let session = format!("worker-mark-{}", uuid::Uuid::new_v4());
        let tool = crate::cloud::deploy::ALWAYS_ASK[0];
        mark_worker_run(&session, "old", true);
        // A newer run of the same task starts before the older one's leftovers drop.
        mark_worker_run(&session, "new", true);
        clear_worker_run(&session, "old");
        assert!(worker_tool_refusal(&session, tool).is_some(), "the older run left the newer run's mark");
        clear_worker_run(&session, "new");
        assert!(worker_tool_refusal(&session, tool).is_none());
        // A newer run that is not a worker's drops the older worker run's mark at once.
        mark_worker_run(&session, "old", true);
        mark_worker_run(&session, "new", false);
        assert!(worker_tool_refusal(&session, tool).is_none());
    }

    #[test]
    fn acp_approvals_take_a_one_time_choice_and_flag_lasting_only_requests() {
        // Recorded option sets: Kimi, Grok and Cline (a one-time choice beside lasting ones; Grok's
        // full handshake is in acp.rs), and a request offering only a lasting choice.
        let kimi = json!([{"optionId":"custom-yes","kind":"allow_once"},{"optionId":"custom-no","kind":"reject_once"}]);
        let grok = json!([{"optionId":"allow-edits-session","name":"Yes, allow all edits during this session","kind":"allow_always"},{"optionId":"allow-once","name":"Yes","kind":"allow_once"},{"optionId":"reject-once","name":"No, and tell Grok what to do differently","kind":"reject_once"}]);
        let cline = json!([{"optionId":"allow_once","name":"Allow once","kind":"allow_once"},{"optionId":"allow_always","name":"Allow always","kind":"allow_always"},{"optionId":"reject_once","name":"Reject","kind":"reject_once"}]);
        let lasting = json!([{"optionId":"always","kind":"allow_always"},{"optionId":"reject","kind":"reject_once"}]);
        let lasting_no_reject = json!([{"optionId":"always","kind":"allow_always"}]);
        // One ACP choice path serves every harness; Kimi's protocol hands each set to it.
        for (provider, options, chosen, lasting_only, declinable) in [("kimi", kimi, "custom-yes", false, false), ("grok", grok, "allow-once", false, false), ("cline", cline, "allow_once", false, false), ("only allow_always", lasting, "always", true, true), ("allow_always, no reject", lasting_no_reject, "always", true, false)] {
            let mut p = Protocol::new(config("kimi"));
            let step = p.receive(json!({"jsonrpc":"2.0","id":"req-1","method":"session/request_permission","params":{"sessionId":"s","toolCall":{"title":"Edit file","kind":"edit"},"options":options}})).unwrap();
            let event = step.events.iter().find(|event| event.kind == "approval").unwrap_or_else(|| panic!("{provider}: no approval"));
            assert_eq!(event.data.as_ref().is_some_and(|data| data[LASTING_ONLY] == true), lasting_only, "{provider}");
            assert_eq!(event.data.as_ref().is_some_and(|data| data[LASTING_DECLINABLE] == true), declinable, "{provider}");
            let id = event.request_id.clone().unwrap();
            assert_eq!(p.approve(&id, true).unwrap()["result"]["outcome"]["optionId"], chosen, "{provider}");
        }
    }

    #[test]
    fn kimi_questions_never_silently_select_first_answer() {
        let mut p = Protocol::new(config("kimi"));
        let step=p.receive(json!({"jsonrpc":"2.0","id":20,"method":"session/request_permission","params":{"toolCall":{"title":"Choose a database"},"options":[{"kind":"allow_once","optionId":"q0_opt_0","name":"Postgres"},{"kind":"allow_once","optionId":"q0_opt_1","name":"SQLite"},{"kind":"reject_once","optionId":"q0_skip","name":"Skip"}]}})).unwrap();
        assert_eq!(step.write[0]["result"]["outcome"]["outcome"], "cancelled");
        assert!(p.pending.is_empty());
        assert!(step.events.iter().all(|e| e.kind != "approval"));
    }

    #[test]
    fn resume_and_cwd_are_preserved_for_kimi() {
        let mut cfg = config("kimi");
        cfg.resume_id = Some("saved-session".into());
        let mut p = Protocol::new(cfg);
        let step=p.receive(json!({"id":1,"result":{"protocolVersion":1,"agentCapabilities":{"loadSession":true,"sessionCapabilities":{"resume":{}}}}})).unwrap();
        assert_eq!(step.write[0]["method"], "session/resume");
        assert_eq!(step.write[0]["params"]["sessionId"], "saved-session");
        assert_eq!(step.write[0]["params"]["cwd"], "/tmp");
    }

    #[test]
    fn failed_claude_success_subtype_is_still_error() {
        let mut p = Protocol::new(config("claude"));
        assert!(p.receive(json!({"type":"result","subtype":"success","is_error":true,"result":"API Error: no credits"})).is_err());
    }

    #[test]
    fn unsupported_reverse_rpc_gets_error_instead_of_hanging() {
        let mut p = Protocol::new(config("kimi"));
        let step = p
            .receive(json!({"id":99,"jsonrpc":"2.0","method":"fs/write_text_file","params":{}}))
            .unwrap();
        assert_eq!(step.write[0]["error"]["code"], -32601);
    }

    #[test]
    fn kimi_restores_manual_mode_before_sending_prompt() {
        let mut p = Protocol::new(config("kimi"));
        let step=p.receive(json!({"id":2,"result":{"sessionId":"s","modes":{"currentModeId":"yolo","availableModes":[{"id":"default"},{"id":"yolo"}]}}})).unwrap();
        assert_eq!(step.write[0]["method"], "session/set_mode");
        assert_eq!(step.write[0]["params"]["modeId"], "default");
        assert!(!step.write.iter().any(|r| r["method"] == "session/prompt"));
    }

    #[test]
    fn startup_deadline_renews_with_progress_up_to_the_limit() {
        let started = tokio::time::Instant::now();
        let step = Duration::from_secs(120);
        assert_eq!(startup_deadline(started, started, step), started + step);
        let later = started + Duration::from_secs(100);
        assert_eq!(startup_deadline(started, later, step), later + step);
        let late = started + Duration::from_secs(250);
        assert_eq!(startup_deadline(started, late, step), started + STARTUP_LIMIT);
    }

    #[cfg(unix)]
    fn run_script(provider: &str, id: &str, script: &str, marker: &Path) -> impl std::future::Future<Output = Result<(), String>> {
        let mut config = config(provider);
        config.session_id = id.into();
        // A closed input channel means Stop, so the sink holds its sender for the run.
        let (input, receiver) = tokio::sync::mpsc::unbounded_channel();
        let sink: Sink = Arc::new(move |_| {
            let _ = &input;
        });
        let mut command = Command::new("/bin/sh");
        command.args(["-c", script, "pandacode-test"]).arg(marker);
        run_process(config, sink, receiver, command, Vec::new())
    }

    /// Answers each ACP step after `$PAUSE`, then runs `$AFTER` past the turn's end.
    #[cfg(unix)]
    fn acp_agent(pause: &str, after: &str) -> String {
        format!(
            r#"read -r a; sleep {pause}; echo '{{"jsonrpc":"2.0","id":1,"result":{{"protocolVersion":1,"agentCapabilities":{{}}}}}}'
read -r a; sleep {pause}; echo '{{"jsonrpc":"2.0","id":2,"result":{{"sessionId":"s"}}}}'
read -r a; echo '{{"jsonrpc":"2.0","id":3,"result":{{"stopReason":"end_turn"}}}}'
{after}"#
        )
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn startup_steps_each_get_their_own_time_limit() {
        let _serial = concurrent_process_tests::process_test_lock().lock().await;
        // Two 0.6 s steps with a 1 s limit per step: the old fixed budget would have expired.
        let run = run_script("opencode", "startup-progress", &acp_agent("0.6", ""), Path::new("/dev/null"));
        let result = TEST_STARTUP_STEP.scope(Duration::from_secs(1), run).await;
        assert_eq!(result, Ok(()));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn startup_timeout_says_how_far_it_got_and_keeps_stderr() {
        let _serial = concurrent_process_tests::process_test_lock().lock().await;
        let silent = "echo 'dsh: still booting plugins' >&2; exec sleep 30";
        let run = run_script("opencode", "startup-silent", silent, Path::new("/dev/null"));
        let error = TEST_STARTUP_STEP.scope(Duration::from_millis(300), run).await.unwrap_err();
        assert!(error.starts_with("Agent initialization timed out"), "{error}");
        assert!(error.contains("never answered"), "{error}");
        assert!(error.contains("dsh: still booting plugins"), "{error}");

        let stalls = "read -r a; echo '{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"protocolVersion\":1,\"agentCapabilities\":{}}}'; exec sleep 30";
        let run = run_script("opencode", "startup-stalled", stalls, Path::new("/dev/null"));
        let error = TEST_STARTUP_STEP.scope(Duration::from_millis(300), run).await.unwrap_err();
        assert!(error.contains("stopped answering"), "{error}");
    }

    /// Past the old 1.5 s kill, the agent writes to both pipes (a closed one would kill it) and
    /// then leaves the marker. It ignores stdin's EOF, as Antigravity does.
    #[cfg(unix)]
    fn lingering_agent() -> String {
        acp_agent("0", r#"sleep 2; echo '{}'; echo note >&2; echo done > "$1"; exec sleep 30"#)
    }

    #[cfg(unix)]
    async fn wait_for(marker: &Path) -> bool {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(6);
        while tokio::time::Instant::now() < deadline {
            if marker.exists() {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        false
    }

    #[cfg(unix)]
    fn marker_path() -> PathBuf {
        std::env::temp_dir().join(format!("pandacode-linger-{}", uuid::Uuid::new_v4()))
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn antigravity_finishes_background_work_after_the_turn_without_blocking_it() {
        let _serial = concurrent_process_tests::process_test_lock().lock().await;
        let marker = marker_path();
        let started = std::time::Instant::now();
        let script = lingering_agent();
        assert_eq!(run_script("antigravity", "linger-work", &script, &marker).await, Ok(()));
        assert!(started.elapsed() < Duration::from_secs(2), "the turn waited for the agent");
        assert!(lingering().lock().unwrap().contains_key("linger-work"));
        assert!(wait_for(&marker).await, "the agent was killed before its work finished");
        end_lingering("linger-work").await;
        let _ = std::fs::remove_file(marker);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_next_turn_and_app_quit_end_a_lingering_agent() {
        let _serial = concurrent_process_tests::process_test_lock().lock().await;
        let script = lingering_agent();
        let next_turn = marker_path();
        assert_eq!(run_script("antigravity", "linger-next", &script, &next_turn).await, Ok(()));
        end_lingering("linger-next").await;
        // Past the marker's 2 s, with nothing else in the way: `shutdown_all` would hide a failure.
        tokio::time::sleep(Duration::from_secs(3)).await;
        let survived = next_turn.exists();
        let _ = std::fs::remove_file(&next_turn);
        assert!(!survived, "the next turn left the old agent running");

        let quit = marker_path();
        assert_eq!(run_script("antigravity", "linger-quit", &script, &quit).await, Ok(()));
        shutdown_all();
        tokio::time::sleep(Duration::from_secs(3)).await;
        assert!(!quit.exists(), "app quit left the agent running");
        end_lingering("linger-quit").await;
    }

    #[tokio::test]
    async fn removing_a_folder_ends_only_the_agents_working_in_it() {
        let root = std::env::temp_dir().join(format!("pandacode-linger-in-{}", uuid::Uuid::new_v4()));
        let (inside, other) = (root.join("gone/deep"), root.join("kept"));
        std::fs::create_dir_all(&inside).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        for (task, cwd) in [("linger-in-gone", &inside), ("linger-in-kept", &other)] {
            let lingering_agent = Lingering { cwd: cwd.canonicalize().unwrap(), agent: tokio::spawn(std::future::pending()) };
            lingering().lock().unwrap().insert(task.into(), lingering_agent);
        }
        end_lingering_in(&root.join("gone")).await;
        assert!(!lingering().lock().unwrap().contains_key("linger-in-gone"));
        assert!(lingering().lock().unwrap().contains_key("linger-in-kept"));
        end_lingering("linger-in-kept").await;
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_failed_antigravity_run_is_not_kept_around() {
        let _serial = concurrent_process_tests::process_test_lock().lock().await;
        let run = run_script("antigravity", "linger-failed", "echo boom >&2; exit 3", Path::new("/dev/null"));
        let error = run.await.unwrap_err();
        assert!(error.contains("boom"), "{error}");
        assert!(!lingering().lock().unwrap().contains_key("linger-failed"));
    }

    #[test]
    fn agent_temp_folder_is_deleted_with_its_contents() {
        let root = std::env::temp_dir().join(format!("pandacode-agent-temp-{}", uuid::Uuid::new_v4()));
        let temp = AgentTemp::create_in(&root).unwrap();
        let unpacked = temp.0.join("_MEI123");
        std::fs::create_dir_all(&unpacked).unwrap();
        std::fs::write(unpacked.join("python.dll"), b"x").unwrap();
        let dir = temp.0.clone();
        drop(temp);
        for _ in 0..100 {
            if !dir.exists() {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(!dir.exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn the_sweep_leaves_recent_agent_temp_folders_alone() {
        let root = std::env::temp_dir().join(format!("pandacode-agent-sweep-{}", uuid::Uuid::new_v4()));
        let (old, live) = (root.join("old"), root.join("live"));
        std::fs::create_dir_all(old.join("_MEI123")).unwrap();
        std::fs::create_dir_all(&live).unwrap();
        let past = std::time::SystemTime::now() - AGENT_TEMP_MAX_AGE - Duration::from_secs(60);
        std::fs::File::open(&old).unwrap().set_modified(past).unwrap();
        AgentTemp::sweep(&root);
        assert!(!old.exists());
        assert!(live.exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn opencode_v2_discovery_runs_in_a_private_folder_it_then_removes() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("pandacode-opencode-private-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let (script, seen, models) = (root.join("opencode"), root.join("seen"), root.join("models.json"));
        std::fs::write(&models, OPENCODE_V2_MODELS).unwrap();
        std::fs::write(&script, format!(
            "#!/bin/sh\nprintf '%s\\n%s\\n%s\\n' \"$(pwd -P)\" \"$(ls -ld . | cut -c1-10)\" \"$*\" > '{}'\ncat '{}'\n",
            seen.display(), models.display(),
        )).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let app_data = root.join("app-data");

        opencode_v2_catalog_in(&script, Some(&app_data)).await.unwrap();

        let seen = std::fs::read_to_string(&seen).unwrap();
        let lines: Vec<&str> = seen.lines().collect();
        let folder = Path::new(lines[0]);
        assert!(folder.starts_with(app_data.canonicalize().unwrap().join(AGENT_TEMP_DIR)), "{seen}");
        assert_eq!(lines[1], "drwx------", "{seen}");
        assert!(lines[2].contains(folder.file_name().unwrap().to_str().unwrap()), "{seen}");
        for _ in 0..100 {
            if !folder.exists() {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(!folder.exists(), "the private folder stayed behind");

        // Without a private folder it never runs, and the error takes the bare-ID path.
        let _ = std::fs::remove_file(root.join("seen"));
        for app_data in [None, Some(script.as_path())] {
            let error = opencode_v2_catalog_in(&script, app_data).await.unwrap_err();
            assert!(!error.contains("timed out"), "{error}");
        }
        assert!(!root.join("seen").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn forced_shutdown_terminates_owned_provider_group() {
        let _serial = concurrent_process_tests::process_test_lock().lock().await;
        let mut child = Command::new("sleep")
            .arg("30")
            .process_group(0)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let group = ProcessGroup::register(child.id());
        shutdown_all();
        let status = tokio::time::timeout(Duration::from_secs(2), child.wait())
            .await
            .unwrap()
            .unwrap();
        assert!(!status.success());
        assert!(!process_registry()
            .lock()
            .unwrap()
            .contains(&group.0.unwrap()));
        drop(group);
    }

    /// Explicitly opt in: this runs two small billable/subscription requests.
    /// PANDACODE_SMOKE_PROVIDER=codex cargo test smoke_provider_from_env -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn smoke_provider_from_env() {
        use std::sync::Mutex;
        let provider = std::env::var("PANDACODE_SMOKE_PROVIDER")
            .expect("Set PANDACODE_SMOKE_PROVIDER to claude, codex, kimi or muse");
        let model = std::env::var("PANDACODE_SMOKE_MODEL").unwrap_or_else(|_| "default".into());
        assert!(["claude", "codex", "kimi", "muse"].contains(&provider.as_str()));
        let root =
            std::env::temp_dir().join(format!("pandacode-provider-smoke-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        assert!(std::process::Command::new("git")
            .arg("init")
            .arg("--quiet")
            .arg(&root)
            .status()
            .unwrap()
            .success());
        let mut resume = None;
        for turn in 0..2 {
            let observed = Arc::new(Mutex::new((
                String::new(),
                None::<String>,
                Vec::<String>::new(),
            )));
            let captured = observed.clone();
            let (sender, receiver) = tokio::sync::mpsc::unbounded_channel();
            let approval_sender = sender.clone();
            let sink: Sink = Arc::new(move |event| {
                let mut data = captured.lock().unwrap();
                data.2.push(event.kind.clone());
                if event.kind == "text" {
                    data.0.push_str(&event.text);
                }
                if event.kind == "session" {
                    data.1 = Some(event.text);
                }
                if event.kind == "approval" {
                    if let Some(request_id) = event.request_id {
                        let _ = approval_sender.send(RunInput::Approval {
                            request_id,
                            approved: false,
                        });
                    }
                }
            });
            let prompt = if turn == 0 {
                "Reply with exactly PANDACODE_OK. Do not use tools or modify files."
            } else {
                "What exact token did you reply in your preceding answer? Reply only with that token. Do not use tools or modify files."
            };
            let cfg = RunConfig {
                session_id: format!("smoke-{provider}"),
                provider: provider.clone(),
                model: model.clone(),
                reasoning_effort: None,
                mode: "ask".into(),
                cwd: root.clone(),
                resume_id: resume.clone(),
                prompt: prompt.into(),
                instructions: String::new(),
                skill: None,
                goal: None,
                codex_settings: None,
                images: Vec::new(),
            };
            let mut task = tokio::spawn(run(cfg, sink, receiver));
            let outcome = match tokio::time::timeout(Duration::from_secs(90), &mut task).await {
                Ok(result) => result.expect("Provider task panicked"),
                Err(_) => {
                    let _ = sender.send(RunInput::Stop);
                    let _ = tokio::time::timeout(Duration::from_secs(10), &mut task).await;
                    task.abort();
                    panic!("Provider smoke timed out");
                }
            };
            outcome.unwrap_or_else(|e| panic!("{provider} failed: {e}"));
            let data = observed.lock().unwrap();
            assert!(
                data.0.contains("PANDACODE_OK"),
                "Expected smoke response, received {} characters",
                data.0.chars().count()
            );
            let remote = data.1.clone().expect("No provider session ID was emitted");
            if let Some(previous) = resume.as_ref() {
                assert_eq!(
                    previous, &remote,
                    "Resume created a different provider session"
                );
            }
            resume = Some(remote);
            println!(
                "{provider} turn {}: PANDACODE_OK; {} events; resume ID present",
                turn + 1,
                data.2.len()
            );
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}
