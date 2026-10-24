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
#[cfg(test)]
mod codex_stream_tests;
#[cfg(all(test, unix))]
pub(crate) mod concurrent_process_tests;
mod cline;
mod commandcode;
mod extra_models;
mod github_copilot;
mod glm;
mod mimo;
mod muse;
mod deepseek;
mod kimi_models;
mod kilo;
mod launch;
mod pi;
mod diagnostics;
pub(crate) mod claude_auth;
pub(crate) use launch::{command, pty_command, external_path, executable_path, widen_process_path};
#[cfg(test)]
mod kimi_stream_tests;
#[cfg(test)]
mod slash_command_tests;
mod limits;
mod steering;
mod subagents;
mod text_stream;
#[cfg(windows)]
pub(crate) mod windows_job;
pub use subagents::SubagentActivity;

const MAX_FRAME: usize = 4 * 1024 * 1024;
const MODEL_CATALOG_LIMIT: usize = 10_000;
const STDERR_LIMIT: usize = 16 * 1024;
const TOOL_INPUT_LIMIT: usize = 4096;
const TOOL_OUTPUT_LIMIT: usize = 8192;
const TOOL_CACHE_LIMIT: usize = 64;
const PREVIEW_TRUNCATED: &str = "\n[Preview truncated]";
pub(crate) const PROVIDERS: [(&str, &str); 16] = [
    ("claude", "Claude Code"),
    ("codex", "Codex"),
    ("kimi", "Kimi Code"),
    ("opencode", "OpenCode"),
    ("glm", "GLM Coding Plan"),
    ("antigravity", "Antigravity"),
    ("grok", "Grok Build"),
    ("mimo", "MiMo Token Plan"),
    ("pi", "Pi"),
    ("deepseek", "DeepSeek"),
    ("commandcode", "Command Code"),
    ("cline", "Cline"),
    ("kilo", "Kilo Code"),
    ("omp", "Oh My Pi"),
    ("github-copilot", "GitHub Copilot CLI"),
    ("muse", "Muse Code"),
];

/// Claude Code tools that only report back to a session that stays open after its turn.
pub(crate) const CLAUDE_SESSION_BOUND_TOOLS: &str = "ScheduleWakeup,Monitor,CronCreate";

/// Harnesses that take app instructions as a system prompt (`--append-system-prompt`).
pub fn takes_system_instructions(provider: &str) -> bool {
    matches!(provider, "claude" | "glm" | "mimo" | "pi" | "omp")
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
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReasoningEffortInfo {
    pub id: String,
    pub name: String,
    pub description: String,
}

pub fn validate_reasoning_effort(provider: &str, effort: Option<&str>) -> Result<(), String> {
    let valid = match (provider, effort) {
        (
            "claude" | "codex" | "kimi" | "glm" | "opencode" | "antigravity" | "grok" | "mimo"
            | "pi" | "deepseek" | "commandcode" | "cline" | "kilo" | "omp" | "github-copilot" | "muse",
            None,
        ) => true,
        ("claude" | "glm" | "mimo", Some(value)) => {
            ["low", "medium", "high", "xhigh", "max"].contains(&value)
        }
        // The current app-server schema deliberately permits catalog-defined effort IDs.
        ("codex" | "opencode" | "antigravity" | "grok" | "deepseek" | "commandcode" | "cline" | "kilo", Some(value)) => {
            !value.is_empty()
                && value.len() <= 64
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
        }
        ("pi" | "omp", Some(value)) => ["off", "minimal", "low", "medium", "high", "xhigh"].contains(&value),
        ("kimi", Some(value)) => ["on", "off"].contains(&value),
        ("muse", Some(value)) => muse::valid_effort(value),
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err("Unsupported reasoning effort for this provider".into())
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
        }
    }
}

pub(crate) fn executable(name: &str) -> Option<PathBuf> {
    if let Some(path) = crate::provider_settings::executable_override(name) {
        return Some(path);
    }
    launch::find(executable_name(name))
}

fn executable_name(name: &str) -> &str {
    match name {
        "glm" | "mimo" => "claude",
        "antigravity" if cfg!(windows) => "agy_acp_server",
        "antigravity" => "agy_acp_server.par",
        "deepseek" => "dsh",
        "commandcode" => "command-code",
        "github-copilot" => "copilot",
        other => other,
    }
}

/// Any command-line tool (`gh`, `git`…) where an interactive shell would find it, even
/// when PandaCode was opened from Finder or the Dock with a minimal PATH.
pub(crate) fn tool_path(name: &str) -> Option<std::path::PathBuf> {
    launch::find(name)
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

pub(crate) fn mimo_endpoint_url(id: &str) -> Option<&'static str> {
    mimo::endpoint_url(id)
}

pub(crate) fn mimo_endpoints() -> &'static [(&'static str, &'static str, &'static str)] {
    &mimo::ENDPOINTS
}

fn version(path: &Path) -> Option<String> {
    let mut child = launch::std_command(path)
        .ok()?
        .arg("--version")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    #[cfg(windows)]
    let _job = windows_job::Job::attach(child.id());
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    loop {
        if child.try_wait().ok()?.is_some() {
            let output = child.wait_with_output().ok()?;
            return Some(
                String::from_utf8_lossy(&output.stdout)
                    .trim()
                    .chars()
                    .take(150)
                    .collect(),
            );
        }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
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

pub(crate) async fn list_model_catalog(provider: &str) -> Result<Vec<ModelInfo>, String> {
    let index = model_discovery_index(provider).ok_or("Unknown provider")?;
    let semaphore = &model_discovery_semaphores()[index];
    let _permit = if matches!(
        provider,
        "opencode" | "antigravity" | "grok" | "deepseek" | "commandcode" | "cline" | "kilo" | "github-copilot" | "muse"
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
        "opencode" => extra_models::opencode(&path).await,
        "glm" => Ok(glm::models()),
        "antigravity" => acp::models(&path).await,
        "grok" => acp::grok_models(&path).await,
        "mimo" => Ok(mimo::models()),
        "pi" | "omp" => pi::models(&path, provider).await,
        "deepseek" => deepseek::models(&path).await,
        "commandcode" => commandcode::models(&path).await,
        "cline" => cline::models(&path).await,
        "kilo" => kilo::models(&path).await,
        "github-copilot" => github_copilot::models(&path).await,
        "muse" => muse::models(&path).await,
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
                });
            }
        }
    }
    Ok(models)
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

async fn claude_models(path: &Path) -> Result<Vec<ModelInfo>, String> {
    let mut command = command(path)?;
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
        let mut bytes = Vec::new();
        let mut buffer = [0u8; 4096];
        let mut total = 0;
        loop {
            let count = stdout.read(&mut buffer).await.map_err(|e| format!("Claude model stream failed: {e}"))?;
            if count == 0 { return Err("Claude exited before returning its model catalog; update the CLI or enter a custom model ID".into()); }
            total += count;
            if total > 1024 * 1024 { return Err("Claude model discovery exceeded its output limit".into()); }
            bytes.extend_from_slice(&buffer[..count]);
            let mut consumed = 0;
            for end in bytes.iter().enumerate().filter_map(|(i, byte)| (*byte == b'\n').then_some(i)) {
                let line = &bytes[consumed..end]; consumed = end + 1;
                if line.len() > 256 * 1024 { return Err("Claude model catalog frame is too large".into()); }
                if line.iter().all(u8::is_ascii_whitespace) { continue; }
                let message: Value = serde_json::from_slice(line).map_err(|_| "Claude returned invalid model discovery JSON")?;
                if message["type"] != "control_response" || message["response"]["request_id"] != "pandacode-models" { continue; }
                let response = &message["response"];
                if response["subtype"] != "success" { return Err("Claude could not load its model catalog; check the CLI or enter a custom model ID".into()); }
                return parse_claude_models(&response["response"]);
            }
            bytes.drain(..consumed);
            if bytes.len() > 256 * 1024 { return Err("Claude model catalog frame is too large".into()); }
        }
    }).await.unwrap_or_else(|_| Err("Claude model discovery timed out; check the CLI or enter a custom model ID".into()));
    drop(stdin);
    drop(group);
    let _ = child.start_kill();
    let _ = tokio::time::timeout(Duration::from_secs(1), child.wait()).await;
    result
}

async fn codex_models(path: &Path) -> Result<Vec<ModelInfo>, String> {
    let mut command = command(path)?;
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
                    .filter(|value| ["on", "off"].contains(value))
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
        if matches!(self.config.provider.as_str(), "grok" | "deepseek" | "muse") && self.config.mode == "plan" && !text.trim().is_empty() {
            text = format!("{}\n\n{text}", acp::GROK_PLAN_PREFIX);
        }
        if !text.trim().is_empty() {
            content.push(if self.config.provider == "codex" {
                json!({"type":"text","text":text,"text_elements":[]})
            } else {
                json!({"type":"text","text":text})
            });
        }
        if self.config.provider == "codex" {
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
            text: if kind == "text" || kind == "session" {
                text
            } else {
                short(&text)
            },
            request_id: None,
            data: data.and_then(event_metadata),
            tool: None,
        }
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
        if self.mcp_tool_names.contains(&tool.name) {
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
            _ => {
                // Keep a label for other provider activities without forwarding
                // arbitrary nested protocol payloads as tool details.
                self.tool_update(
                    id,
                    Some(field(item, "type")),
                    Some(status),
                    None,
                    None,
                    step,
                );
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
            "muse" => self.muse_initial(),
            "codex" => {
                let mut request = json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"pandacode","title":"PandaCode","version":"0.1.0"}}});
                request["params"]["capabilities"] =
                    json!({"experimentalApi":true,"requestAttestation":false});
                request
            }
            "kimi" | "opencode" | "antigravity" | "grok" | "deepseek" | "commandcode" | "cline" | "kilo" | "github-copilot" => {
                json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{},"clientInfo":{"name":"pandacode","version":"0.1.0"}}})
            }
            _ => {
                json!({"type":"control_request","request_id":"pandacode-init","request":{"subtype":"initialize","hooks":null}})
            }
        }
    }
    fn approval(&mut self, value: Value, text: String, step: &mut Step) -> Result<(), String> {
        if self.pending.len() + self.inputs.len() >= 64 {
            return Err("Too many simultaneous approval requests".into());
        }
        let request_id = uuid::Uuid::new_v4().to_string();
        let mut event = self.event("approval", short(&text), Some(&value));
        event.request_id = Some(request_id.clone());
        self.pending.insert(request_id, value);
        step.events.push(event);
        Ok(())
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
        Some(match self.config.provider.as_str() {
            "pi" | "omp" => json!({"type":"extension_ui_response","id":request["id"],"confirmed":approved}),
            "codex" => {
                let method = string(&request, "method");
                let result = if method == "item/permissions/requestApproval" {
                    json!({"permissions": if approved {request["params"]["permissions"].clone()} else {json!({})},"scope":"turn"})
                } else {
                    json!({"decision": if approved { "accept" } else { "decline" }})
                };
                json!({"id":request["id"],"result":result})
            }
            "kimi" | "opencode" | "antigravity" | "grok" | "deepseek" | "commandcode" | "cline" | "kilo" | "github-copilot" => {
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
                json!({"type":"control_response","response":{"subtype":"success","request_id":request["request_id"],"response":if approved {json!({"behavior":"allow","updatedInput":request["request"]["input"]})} else {json!({"behavior":"deny","message":"Declined by the user"})}}})
            }
        })
    }
    fn cancel(&self) -> Value {
        match self.config.provider.as_str() {
            "pi" | "omp" => json!({"type":"abort"}),
            "muse" => self.muse_cancel(),
            "codex" => {
                json!({"id":900,"method":"turn/interrupt","params":{"threadId":self.remote_id,"turnId":self.turn_id}})
            }
            "kimi" | "opencode" | "antigravity" | "grok" | "deepseek" | "commandcode" | "cline" | "kilo" | "github-copilot" => {
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
    fn receive_inner(&mut self, value: Value) -> Result<Step, String> {
        match self.config.provider.as_str() {
            "codex" => self.codex(value).map(|step| self.steered(step)),
            "kimi" => self.kimi_steered(value),
            "pi" | "omp" => self.pi(value).map(|step| self.steered(step)),
            "muse" => self.muse(value),
            "opencode" | "antigravity" | "grok" | "deepseek" | "commandcode" | "cline" | "kilo" | "github-copilot" => self.acp(value),
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
                            return Err("The selected Codex model does not support this reasoning effort. Choose another effort or use harness settings.".into());
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
                self.approval(value,label,&mut step)?;
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
                    "agent_thought_chunk"=>self.kimi_message_id.clear(),
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
                let label=string(&params["toolCall"],"title");self.approval(value,if label.is_empty(){"Allow this agent action?".into()}else{label},&mut step)?;
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
                                    return Err("The selected Claude model does not support this reasoning effort. Choose another effort or use harness settings.".into());
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
                if value["isReplay"] == true {
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
                    } else if name.strip_prefix("mcp__pandacode_architect__").is_some_and(|tool| optional_metadata_tool(tool) || crate::bots::tools::self_scoped(tool) || crate::architect::team_tool(tool))
                        && self.mcp_tool_names.contains(&name)
                    {
                        // Registered metadata callbacks only stage this run's
                        // title or snapshot named paths. They cannot edit the checkout.
                        // Bot tools are registered only in a bot's own tasks and only
                        // touch that bot's memory, schedules and messages to its owner.
                        // Team tools only exist in team turns and only change team state.
                        step.write.push(json!({"type":"control_response","response":{"subtype":"success","request_id":value["request_id"],"response":{"behavior":"allow","updatedInput":value["request"]["input"]}}}));
                    } else {
                        self.approval(
                            value,
                            if command.is_empty() { name } else { command },
                            &mut step,
                        )?;
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
                // A steer Claude has not echoed yet arrived as the turn ended: Claude
                // starts another turn for it in this process, so keep the run open.
                step.done = !self.claude_steers_open();
            }
            _ => {}
        }
        Ok(step)
    }
}

async fn write_json(stdin: &mut ChildStdin, value: &Value) -> Result<(), String> {
    let mut bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    tokio::time::timeout(Duration::from_secs(5), async {
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
            }
        }
    }
}

async fn finish_child(child: &mut Child, stdin: ChildStdin, group: &mut ProcessGroup) {
    drop(stdin);
    if tokio::time::timeout(Duration::from_millis(1000), child.wait())
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

// Protocol fixture entry point.
#[cfg(test)]
#[allow(dead_code)]
pub async fn run(
    config: RunConfig,
    sink: Sink,
    input: UnboundedReceiver<RunInput>,
) -> Result<(), String> {
    run_with_tools(config, sink, input, None).await
}

pub async fn run_with_tools(
    config: RunConfig,
    sink: Sink,
    input: UnboundedReceiver<RunInput>,
    host: Option<ToolHost>,
) -> Result<(), String> {
    let identity = Protocol::new(config.clone());
    sink(identity.event("status", "Starting agent", None));
    let result = run_inner(config, sink.clone(), input, host).await;
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

fn configure_command(command: &mut Command, config: &RunConfig) {
    claude_auth::configure(command, &config.provider);
    let use_model = !config.model.is_empty() && config.model != "default";
    match config.provider.as_str() {
        "codex" => {
            // Process-local override: never alter the user's Codex config.
            command.args(["app-server", "--enable", "goals"]);
        }
        "pi" | "omp" => pi::configure(command, config),
        "muse" => muse::configure(command, config),
        "opencode" | "antigravity" | "grok" | "deepseek" | "commandcode" | "cline" | "kilo" => acp::configure(command, config),
        "github-copilot" => acp::configure(command, config),
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
            let permission_mode = match config.mode.as_str() {
                "auto" => "acceptEdits",
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
            command.arg(format!("--disallowedTools={}", CLAUDE_SESSION_BOUND_TOOLS));
            if use_model {
                command.args(["--model", &config.model]);
            } else if config.provider == "glm" {
                command.args(["--model", glm::DEFAULT_MODEL]);
            } else if config.provider == "mimo" {
                command.args(["--model", mimo::DEFAULT_MODEL]);
            }
            if let Some(effort) = &config.reasoning_effort {
                command.args(["--effort", effort]);
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
        "pi",
        "deepseek",
        "commandcode",
        "cline",
        "kilo",
        "omp",
        "github-copilot",
        "muse",
    ]
    .contains(&config.provider.as_str())
    {
        return Err("Unknown provider".into());
    }
    if !crate::storage::valid_permission_mode(&config.mode) {
        return Err("Unknown permission mode".into());
    }
    validate_reasoning_effort(&config.provider, config.reasoning_effort.as_deref())?;
    // A cloud task runs the same pipeline through a bridge to its machine; local MCP host
    // tools stay on this computer (docs/cloud-agents.md, step 5).
    if let Some(command) = crate::cloud_agents::transport::command(&config, |command| configure_command(command, &config)).await? {
        return run_process_with_tools(config, sink, input, command, Vec::new(), None).await;
    }
    let mut connection = crate::connections::for_task(&config.session_id, &config.provider)
        .map(|connection| crate::connections::launch(&connection))
        .transpose()?;
    let path = connection
        .as_ref()
        .and_then(|connection| connection.executable.clone())
        .or_else(|| executable(&config.provider))
        .ok_or_else(|| format!("{} CLI is not installed or is not on PATH", config.provider))?;
    config.cwd = external_path(&config.cwd);
    let image_blocks = attachments::load(&config.provider, &config.images).await?;
    let mut command = command(&path)?;
    configure_command(&mut command, &config);
    // A named connection's arguments and environment win over the global setup.
    if let Some(connection) = &connection {
        connection.apply(&mut command);
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

fn optional_metadata_tool(name: &str) -> bool {
    name == crate::session_titles::TOOL || name == crate::turn_changes::TRACK_TOOL
}
// Preview tools are an optional transport capability, but retain their normal
// approval requirements and transcript activity. They are not metadata tools.
fn optional_transport_tool(name: &str) -> bool {
    optional_metadata_tool(name) || matches!(name, "pandacode_run_project" | "pandacode_preview_file")
}
fn per_run_mcp_tool(name: &str) -> bool {
    name.starts_with("pandacode_jev_") || optional_transport_tool(name)
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
        Some(tools) if warm::supported(&config) => warm::take(&config.session_id, &warm::key(&config, &tools.tools)),
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
            "claude" | "glm" | "mimo" | "kimi" | "opencode" | "antigravity" | "grok" | "pi"
            | "deepseek" | "commandcode" | "cline" | "kilo" | "omp" | "github-copilot" | "muse",
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
        (_, None) => (None, None),
        _ => return Err("Host tools are unavailable for this provider".into()),
    };
    let _pi_bridge = if matches!(config.provider.as_str(), "pi" | "omp") {
        Some(pi::Bridge::configure(&mut command, &config.mode, mcp.as_ref())?)
    } else { None };
    let (mut child, mut group) = if let Some(spare) = spare {
        (spare.child, spare.group)
    } else {
        if matches!(config.provider.as_str(), "claude" | "glm" | "mimo") {
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
    protocol.image_blocks = image_blocks;
    protocol.host = host;
    protocol.mcp_server = mcp.as_ref().map(mcp_host::Server::kimi_config);
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
    let mut deadline = tokio::time::Instant::now() + Duration::from_secs(90);
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
                                sink(protocol.event("status","Pausing goal",None));
                                jobs.abort_all(); queued.clear();
                                let cancel=protocol.cancel_requests();
                                apply_step(&mut protocol,cancel,&sink,&mut stdin,&mut jobs,&mut queued).await?;
                                if apply_step(&mut protocol,step,&sink,&mut stdin,&mut jobs,&mut queued).await? {return Ok(());}
                                continue;
                            }
                            input_open=false;stopped=true;sink(protocol.event("status","Stopping agent",None));
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
                    if stopped{break Ok(());}break Err("Agent initialization timed out. Check the CLI's login and configuration in a terminal.".into());
                },
                _=tokio::time::sleep_until(protocol.goals.deadline().unwrap_or_else(||tokio::time::Instant::now()+Duration::from_secs(86400))),if protocol.goals.deadline().is_some()=>{
                    let step=protocol.goal_tick();
                    if apply_step(&mut protocol,step,&sink,&mut stdin,&mut jobs,&mut queued).await? {return Ok(());}
                },
                read=stdout.read(&mut buf)=>{
                    let count=read.map_err(|e|format!("Provider stream failed: {e}"))?;
                    if count==0 {if stopped{break Ok(());}break Err("Agent exited before completing its response".into());}
                    // Retained bytes contain no newline: only scan this read.
                    // Rescanning the entire partial frame makes large tool
                    // results quadratic and can starve other concurrent runs.
                    let previous_len=bytes.len();
                    bytes.extend_from_slice(&buf[..count]);
                    let mut consumed=0;
                    for end in bytes.iter().enumerate().skip(previous_len).filter_map(|(i,b)|if *b==b'\n'{Some(i)}else{None}).collect::<Vec<_>>() {
                        let line=&bytes[consumed..end];consumed=end+1;
                        if line.len()>MAX_FRAME{return Err("Provider sent an oversized JSON message".into());}
                        if line.iter().all(u8::is_ascii_whitespace){continue;}
                        let value:Value=serde_json::from_slice(line).map_err(|e|format!("Invalid provider JSON: {e}"))?;
                        if stopped {
                            if pi::stop_settled(&protocol.config.provider, &value) {return Ok(());}
                            continue;
                        }
                        let step=protocol.receive(value)?;
                        if apply_step(&mut protocol,step,&sink,&mut stdin,&mut jobs,&mut queued).await? {return Ok(());}
                    }
                    bytes.drain(..consumed);
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
    for event in protocol.steers_ended(result.is_ok() && !stopped) {
        sink(event);
    }
    for event in protocol.cancel_requests().events {
        sink(event);
    }
    finish_child(&mut child, stdin, &mut group).await;
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
mod tests {
    #[test]
    fn opencode_choices_keep_only_saved_models_and_retain_unavailable_ids() {
        let model = super::ModelInfo {
            id: "vendor/selected".into(),
            name: "Selected model".into(),
            description: "Provider metadata".into(),
            reasoning_efforts: vec![super::effort_info("high", None)],
            default_reasoning_effort: None,
            context_window: Some(200_000),
        };
        let unused = super::ModelInfo {
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
        for provider in ["kimi", "opencode", "antigravity", "grok"] {
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
    fn claude_preview_tools_never_inherit_the_metadata_permission_exemption() {
        for provider in ["claude", "glm", "mimo"] {
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
        for provider in ["claude", "glm", "mimo"] {
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
        assert!(validate_reasoning_effort("kimi", Some("high")).is_err());
        assert!(validate_reasoning_effort("codex", Some("future_effort")).is_ok());
        assert!(validate_reasoning_effort("codex", Some("")).is_err());
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
