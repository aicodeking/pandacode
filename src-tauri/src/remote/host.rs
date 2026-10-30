//! Answers requests from the account's other computers, only while
//! "Allow remote control" is on,
//! and pushes the agent events of the tasks they mirror. Remote prompts run under the
//! same approval policy as local ones.
use super::{images, remote, socket, start, Subscriber};
use crate::{message_queue, providers::AgentEvent, AppState, Result};
use rusqlite::OptionalExtension;
use base64::Engine;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{Emitter, Listener, Manager};

pub(crate) const METHODS: [&str; 32] = ["subscribe", "tasks.list", "projects.icons", "providers.list", "providers.models", "task.start", "task.startStatus", "task.cancelStart", "task.messages", "task.team", "task.workerMessages", "task.attachment", "task.workspaceImage", "task.send", "task.stop", "task.steer", "task.configure", "approval.respond", "input.respond", "task.pull", "task.pullDiff", "task.pullMerge", "task.pullDetect", "task.changes", "task.diff", "bots.list", "bot.thread", "bot.message", "bot.pause", "image.put", "batch", "pair.redeem"];
pub(crate) const OFF: &str = "Remote control is off on this computer";
pub(crate) const MAX_TEXT: usize = 100 * 1024;
const SUBSCRIPTION: Duration = Duration::from_secs(10 * 60);
/// After the first event of a burst (sent at once), events wait this long, so one frame
/// carries everything a subscriber missed meanwhile.
pub(crate) const FLUSH: Duration = Duration::from_millis(40);
/// Past a burst's first [`BURST_FRAMES`] frames, frames go at most every 100 ms: the relay
/// allows 20 frames a second per socket, replies included.
pub(crate) const SUSTAINED: Duration = Duration::from_millis(100);
pub(crate) const BURST_FRAMES: u32 = 5;
/// Events kept per task for viewers that come back (`afterSeq`), and in all.
const JOURNAL_EVENTS: usize = 2000;
const JOURNAL_BYTES: usize = 2 * 1024 * 1024;
const JOURNAL_TOTAL: usize = 8 * 1024 * 1024;
const JOURNAL_TASKS: usize = 2048;
/// A finished task's events are dropped once no viewer has followed it for this long.
const JOURNAL_IDLE: Duration = Duration::from_secs(10 * 60);
/// The part of a subscribe reply that replayed events may fill; the rest comes in later
/// pages (`more`), each another subscribe from where the viewer now is.
const REPLAY_BUDGET: usize = PAGE_BUDGET / 3;
/// The replay a viewer that opens packed frames gets, while the packed reply fits [`PAGE_BUDGET`].
const PACKED_REPLAY_BUDGET: usize = PAGE_BUDGET;
const MISSING_BUDGET: usize = 24 * 1024;
/// A finished start is remembered this long for a repeated `task.start` or `task.startStatus`.
const START_MEMORY: Duration = Duration::from_secs(3600);
const MAX_HOST_STARTS: usize = 256;
pub(crate) const MAX_IDS: usize = 500;
const TASKS_DEFAULT: usize = 200;
const TASKS_MAX: usize = 500;
const MESSAGE_PAGE_DEFAULT: i64 = 100;
const WORKER_MESSAGE_PAGE_DEFAULT: i64 = 100;
const WORKER_MESSAGE_PAGE_MAX: i64 = 100;
const TEAM_MESSAGE_COUNT: usize = 30;
const TEAM_MESSAGE_TEXT: usize = 2048;
const WINDOW_MS: i64 = 60_000;
const MAX_SEEN: usize = 20_000;
/// A reply's or event frame's JSON budget: sealing adds a third (base64) plus a small
/// envelope, so this stays under the relay's 256 KB frame.
pub(crate) const PAGE_BUDGET: usize = 180 * 1024;
const MAX_PROJECT_ICON_IDS: usize = 50;
const MAX_PROJECT_ICON_BYTES: usize = 64 * 1024;
const MAX_BOT_AVATAR_BYTES: usize = 32 * 1024;
const SUBAGENT_SNAPSHOT_BUDGET: usize = 40 * 1024;
const MAX_SUBAGENT_SNAPSHOT: usize = 64;
const DIFF_BUDGET: usize = 120 * 1024;
const MAX_PATH: usize = 4096;
const MAX_BATCH_CALLS: usize = 8;
const PULL_CACHE_TTL: Duration = Duration::from_secs(30);
const MAX_PULL_CACHE_ENTRIES: usize = 64;
/// A single message or event larger than this is cut, with [`CUT`] marking the cut.
const MAX_MESSAGE: usize = 120 * 1024;
/// The smallest `budget` a `task.messages` page may ask for, and the largest a viewer that opens
/// packed frames (`"z": 1`) may: such a page is cut until it packs into [`PAGE_BUDGET`].
const MIN_PAGE_BUDGET: usize = 4 * 1024;
pub(crate) const PACKED_PAGE_MAX: usize = 1024 * 1024;
/// Messages read per legacy `afterId` `task.messages` page before the budget trims it.
const PAGE_ROWS: i64 = 400;
/// Buffered events per subscriber; past it the buffer ends in a [`LAGGED`] marker and the
/// viewer is told to subscribe again from where it is (the journal still has the rest).
const MAX_BUFFER: usize = 4096;
const LAGGED: &str = "lagged";
const CUT: &str = "\n…[cut on the host to fit a remote page]";
/// Harness ids `providers.models` accepts (the same list `storage` allows).
pub(crate) const PROVIDERS: [&str; 20] = ["openai-compatible", "claude", "codex", "kimi", "opencode", "glm", "antigravity", "grok", "mimo", "pi", "deepseek", "commandcode", "cline", "kilo", "omp", "github-copilot", "muse", "devin", "zcode", "hermes"];

/// Hosting must be on. The socket already limits frames to devices in presence.
pub(crate) fn gate(host_enabled: bool) -> Result<()> {
    if !host_enabled {
        return Err(OFF.into());
    }
    Ok(())
}

/// Request nonces seen in the last minute. Requests outside ±60 s or seen before are refused.
#[derive(Default)]
pub(crate) struct Replay {
    seen: HashMap<String, i64>,
}

impl Replay {
    pub(crate) fn check(&mut self, ts: Option<i64>, nonce: Option<&str>, now_ms: i64) -> Result<()> {
        const REFUSED: &str = "This request expired or was already received. Check that both computers' clocks are right.";
        let (Some(ts), Some(nonce)) = (ts, nonce) else { return Err(REFUSED.into()) };
        if !(16..=64).contains(&nonce.len()) || !nonce.chars().all(|c| c.is_ascii_graphic()) || (now_ms - ts).abs() > WINDOW_MS {
            return Err(REFUSED.into());
        }
        // An accepted nonce only needs remembering while its ts is still inside the window.
        self.seen.retain(|_, seen| *seen >= now_ms - WINDOW_MS);
        if self.seen.contains_key(nonce) {
            return Err(REFUSED.into());
        }
        if self.seen.len() >= MAX_SEEN {
            return Err("This computer is busy. Try again in a moment.".into());
        }
        self.seen.insert(nonce.to_owned(), ts);
        Ok(())
    }
}

/// Ids are UUIDs or provider request ids: short, printable, no spaces.
pub(crate) fn valid_id(id: &str) -> Result<()> {
    if id.is_empty() || id.len() > 200 || !id.chars().all(|c| c.is_ascii_graphic()) {
        return Err("Invalid id.".into());
    }
    Ok(())
}

#[derive(Debug, PartialEq)]
pub(crate) enum Call {
    /// `replay`: the JSON the replayed events may fill ([`REPLAY_BUDGET`], more for a packing viewer).
    Subscribe { session_ids: Vec<String>, after: HashMap<String, u64>, epoch: Option<String>, replay: usize },
    TasksList { limit: usize },
    ProjectIcons { project_ids: Vec<String> },
    Providers { force: bool },
    Models { provider: String, force: bool },
    Start(start::Start),
    StartStatus { start_id: String },
    CancelStart { start_id: String },
    /// `budget`: the page's JSON bytes ([`page_budget`]).
    Messages { session_id: String, page: MessagePaging, budget: usize },
    Team { session_id: String },
    /// `before_id`: a page ending before it (`tail` is before the newest), else after `after_id`.
    WorkerMessages { session_id: String, worker_id: String, after_id: i64, before_id: Option<i64>, limit: i64 },
    Attachment { session_id: String, id: String, variant: crate::attachments::Variant, offset: u64 },
    WorkspaceImage { session_id: String, path: String, variant: crate::attachments::Variant, offset: u64 },
    Send { session_id: String, text: String, image_ids: Vec<String> },
    PutImage(images::Chunk),
    Stop { session_id: String },
    Steer { session_id: String, text: String },
    Configure { session_id: String, model: Option<(String, String)>, effort: Option<Option<String>>, mode: Option<String> },
    Approve { session_id: String, request_id: String, approve: bool },
    Answer { session_id: String, request_id: String, response: Value },
    Pull { session_id: String },
    PullDiff { session_id: String, path: Option<String> },
    PullMerge { session_id: String, method: String },
    PullDetect { session_id: String },
    Changes { session_id: String },
    Diff { session_id: String, path: Option<String>, staged: bool },
    BotsList,
    BotThread { bot_id: String },
    BotMessage { bot_id: String, text: String },
    BotPause { bot_id: String, paused: bool },
    Batch(Vec<std::result::Result<Call, String>>),
}

impl Call {
    fn method_name(&self) -> &'static str {
        match self {
            Self::Subscribe { .. } => "subscribe",
            Self::TasksList { .. } => "tasks.list",
            Self::ProjectIcons { .. } => "projects.icons",
            Self::Providers { .. } => "providers.list",
            Self::Models { .. } => "providers.models",
            Self::Start(_) => "task.start",
            Self::StartStatus { .. } => "task.startStatus",
            Self::CancelStart { .. } => "task.cancelStart",
            Self::Messages { .. } => "task.messages",
            Self::Team { .. } => "task.team",
            Self::WorkerMessages { .. } => "task.workerMessages",
            Self::Attachment { .. } => "task.attachment",
            Self::WorkspaceImage { .. } => "task.workspaceImage",
            Self::Send { .. } => "task.send",
            Self::PutImage(_) => "image.put",
            Self::Stop { .. } => "task.stop",
            Self::Steer { .. } => "task.steer",
            Self::Configure { .. } => "task.configure",
            Self::Approve { .. } => "approval.respond",
            Self::Answer { .. } => "input.respond",
            Self::Pull { .. } => "task.pull",
            Self::PullDiff { .. } => "task.pullDiff",
            Self::PullMerge { .. } => "task.pullMerge",
            Self::PullDetect { .. } => "task.pullDetect",
            Self::Changes { .. } => "task.changes",
            Self::Diff { .. } => "task.diff",
            Self::BotsList => "bots.list",
            Self::BotThread { .. } => "bot.thread",
            Self::BotMessage { .. } => "bot.message",
            Self::BotPause { .. } => "bot.pause",
            Self::Batch(_) => "batch",
        }
    }
}

/// These methods may be run concurrently because they do not change task state.
/// `task.pullMerge` intentionally stays ordered because it changes the linked PR.
pub(crate) fn is_read_only_method(method: &str) -> bool {
    matches!(
        method,
        "subscribe"
            | "tasks.list"
            | "projects.icons"
            | "providers.list"
            | "providers.models"
            | "task.startStatus"
            | "task.messages"
            | "task.team"
            | "task.workerMessages"
            | "task.attachment"
            | "task.workspaceImage"
            | "task.pull"
            | "task.pullDiff"
            | "task.pullDetect"
            | "task.changes"
            | "task.diff"
            | "bots.list"
    )
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum MessagePaging {
    After { after_id: i64, limit: i64 },
    Tail { limit: i64 },
    Before { before_id: i64, limit: i64 },
}

pub(crate) fn id_param(params: &Value, key: &str) -> Result<String> {
    let id = params[key].as_str().ok_or_else(|| format!("Missing {key}."))?;
    valid_id(id).map_err(|_| format!("Invalid {key}."))?;
    Ok(id.to_owned())
}

fn uuid_param(params: &Value, key: &str) -> Result<String> {
    let id = id_param(params, key)?;
    let parsed = uuid::Uuid::parse_str(&id).map_err(|_| format!("Invalid {key}."))?;
    if parsed.to_string() != id { return Err(format!("Invalid {key}.")); }
    Ok(id)
}

fn variant_offset(params: &Value) -> Result<(crate::attachments::Variant, u64)> {
    let variant = params.get("variant").and_then(Value::as_str).ok_or("Missing variant.")?;
    let variant = crate::attachments::Variant::parse(variant)?;
    let offset = match params.get("offset").filter(|value| !value.is_null()) {
        None => 0,
        Some(value) => value.as_u64().ok_or("Invalid offset.")?,
    };
    Ok((variant, offset))
}

pub(crate) fn text_param(params: &Value, key: &str) -> Result<String> {
    let text = params[key].as_str().map(str::trim).unwrap_or_default();
    if text.is_empty() || text.len() > MAX_TEXT {
        return Err("Send between 1 byte and 100 KB of text.".into());
    }
    Ok(text.to_owned())
}

/// A short printable setting (provider, model, mode, effort), or None when absent.
pub(crate) fn name_param(params: &Value, key: &str) -> Result<Option<String>> {
    match params.get(key).filter(|v| !v.is_null()) {
        None => Ok(None),
        Some(value) => {
            let text = value.as_str().filter(|text| !text.is_empty() && text.len() <= 200 && text.chars().all(|c| c.is_ascii_graphic())).ok_or_else(|| format!("Invalid {key}."))?;
            Ok(Some(text.to_owned()))
        }
    }
}

fn force_param(params: &Value) -> Result<bool> {
    match params.get("force").filter(|v| !v.is_null()) {
        None => Ok(false),
        Some(value) => value.as_bool().ok_or_else(|| "Invalid force.".into()),
    }
}

fn task_limit(params: &Value) -> Result<usize> {
    match params.get("limit").filter(|value| !value.is_null()) {
        None => Ok(TASKS_DEFAULT),
        Some(value) => value
            .as_u64()
            .and_then(|limit| usize::try_from(limit).ok())
            .filter(|limit| *limit <= TASKS_MAX)
            .ok_or_else(|| format!("Limit must be between 0 and {TASKS_MAX}.")),
    }
}

fn message_paging(params: &Value) -> Result<MessagePaging> {
    let tail = match params.get("tail").filter(|value| !value.is_null()) {
        None => None,
        Some(value) => Some(value.as_bool().ok_or("Invalid tail.")?),
    };
    let before_id = match params.get("beforeId").filter(|value| !value.is_null()) {
        None => None,
        Some(value) => Some(value.as_i64().filter(|id| *id >= 0).ok_or("Invalid beforeId.")?),
    };
    let limit = match params.get("limit").filter(|value| !value.is_null()) {
        None => None,
        Some(value) => Some(
            value
                .as_u64()
                .and_then(|limit| i64::try_from(limit).ok())
                .filter(|limit| (1..=PAGE_ROWS).contains(limit))
                .ok_or_else(|| format!("Limit must be between 1 and {PAGE_ROWS}."))?,
        ),
    };
    if tail == Some(true) && before_id.is_some() {
        return Err("Use tail or beforeId, not both.".into());
    }
    if params.get("afterId").is_some() && (tail == Some(true) || before_id.is_some()) {
        return Err("Use afterId or newest-first paging, not both.".into());
    }
    Ok(if tail == Some(true) {
        MessagePaging::Tail { limit: limit.unwrap_or(MESSAGE_PAGE_DEFAULT) }
    } else if let Some(before_id) = before_id {
        MessagePaging::Before { before_id, limit: limit.unwrap_or(MESSAGE_PAGE_DEFAULT) }
    } else {
        MessagePaging::After {
            after_id: params["afterId"].as_i64().unwrap_or(0).max(0),
            limit: limit.unwrap_or(PAGE_ROWS),
        }
    })
}

/// A `task.messages` page's JSON budget: [`PAGE_BUDGET`] unless asked, clamped to
/// [`MIN_PAGE_BUDGET`]..[`PACKED_PAGE_MAX`]; [`plain_budget`] holds plain viewers to [`PAGE_BUDGET`].
pub(crate) fn page_budget(params: &Value) -> Result<usize> {
    match params.get("budget").filter(|value| !value.is_null()) {
        None => Ok(PAGE_BUDGET),
        Some(value) => Ok(value.as_u64().ok_or("Invalid budget.")?.clamp(MIN_PAGE_BUDGET as u64, PACKED_PAGE_MAX as u64) as usize),
    }
}

/// A viewer that does not open packed frames gets pages of at most [`PAGE_BUDGET`]; one that
/// does gets a bigger replay. A batch's calls stay plain-sized: its reply is measured plain.
fn plain_budget(call: Call, packs: bool) -> Call {
    match call {
        Call::Messages { session_id, page, budget } if !packs => Call::Messages { session_id, page, budget: budget.min(PAGE_BUDGET) },
        Call::Subscribe { session_ids, after, epoch, .. } => Call::Subscribe { session_ids, after, epoch, replay: if packs { PACKED_REPLAY_BUDGET } else { REPLAY_BUDGET } },
        Call::Batch(calls) => Call::Batch(calls.into_iter().map(|call| call.map(|call| plain_budget(call, false))).collect()),
        other => other,
    }
}

fn path_param(params: &Value, key: &str) -> Result<Option<String>> {
    match params.get(key).filter(|value| !value.is_null()) {
        None => Ok(None),
        Some(value) => {
            let path = value.as_str().filter(|path| !path.is_empty() && path.len() <= MAX_PATH && !path.contains('\0')).ok_or_else(|| format!("Invalid {key}."))?;
            if !Path::new(path).components().all(|part| match part {
                Component::Normal(name) => name != ".git",
                Component::CurDir => true,
                _ => false,
            }) {
                return Err(format!("Invalid {key}."));
            }
            Ok(Some(path.to_owned()))
        }
    }
}

fn staged_param(params: &Value) -> Result<bool> {
    match params.get("staged").filter(|value| !value.is_null()) {
        None => Ok(false),
        Some(value) => value.as_bool().ok_or_else(|| "Invalid staged.".into()),
    }
}

fn project_icon_ids(params: &Value) -> Result<Vec<String>> {
    let ids = params.get("projectIds").and_then(Value::as_array).ok_or("Missing projectIds.")?;
    if ids.is_empty() || ids.len() > MAX_PROJECT_ICON_IDS {
        return Err(format!("Request 1 to {MAX_PROJECT_ICON_IDS} project icons at a time."));
    }
    ids.iter()
        .map(|id| id.as_str().filter(|id| valid_id(id).is_ok()).map(str::to_owned).ok_or_else(|| "Invalid projectIds.".to_owned()))
        .collect()
}

fn batch_calls(params: &Value) -> Result<Vec<std::result::Result<Call, String>>> {
    let calls = params.get("calls").and_then(Value::as_array).ok_or("Missing calls.")?;
    if calls.is_empty() || calls.len() > MAX_BATCH_CALLS {
        return Err(format!("Batch 1 to {MAX_BATCH_CALLS} read-only calls at a time."));
    }
    calls
        .iter()
        .map(|entry| {
            let entry = entry.as_object().ok_or("Each batch call must be an object.")?;
            let method = entry.get("method").and_then(Value::as_str).ok_or("Each batch call needs a method.")?;
            if !is_read_only_method(method) {
                return Err("Batch only supports read-only methods.".into());
            }
            let params = entry.get("params").filter(|params| params.is_object()).ok_or("Each batch call needs object params.")?;
            Ok(parse(true, method, params))
        })
        .collect()
}

fn configure(params: &Value) -> Result<Call> {
    let model = match (name_param(params, "provider")?, name_param(params, "model")?) {
        (Some(provider), Some(model)) => Some((provider, model)),
        (None, None) => None,
        _ => return Err("Send a provider with the model.".into()),
    };
    let effort = params.get("effort").map(|_| name_param(params, "effort")).transpose()?;
    Ok(Call::Configure { session_id: id_param(params, "sessionId")?, model, effort, mode: name_param(params, "mode")? })
}

/// Validates a request. Everything is refused while hosting is off.
pub(crate) fn parse(host_enabled: bool, method: &str, params: &Value) -> Result<Call> {
    if !host_enabled {
        return Err(OFF.into());
    }
    Ok(match method {
        "subscribe" => {
            let ids = params["sessionIds"].as_array().ok_or("Missing sessionIds.")?;
            if ids.len() > MAX_IDS {
                return Err(format!("Mirror up to {MAX_IDS} tasks per computer."));
            }
            let session_ids: Vec<String> = ids.iter().map(|id| id.as_str().filter(|id| valid_id(id).is_ok()).map(str::to_owned).ok_or("Invalid sessionIds.")).collect::<std::result::Result<_, _>>()?;
            // Newer viewers say where they left off; anything malformed is ignored (no replay).
            let after = params["afterSeq"].as_object().map(|after| after.iter().filter(|(id, _)| session_ids.contains(id)).filter_map(|(id, seq)| Some((id.clone(), seq.as_u64()?))).collect()).unwrap_or_default();
            let epoch = params["epoch"].as_str().filter(|epoch| valid_id(epoch).is_ok() && epoch.len() <= 64).map(str::to_owned);
            Call::Subscribe { session_ids, after, epoch, replay: REPLAY_BUDGET }
        }
        "tasks.list" => Call::TasksList { limit: task_limit(params)? },
        "projects.icons" => Call::ProjectIcons { project_ids: project_icon_ids(params)? },
        "providers.list" => Call::Providers { force: force_param(params)? },
        "providers.models" => {
            let provider = name_param(params, "provider")?.ok_or("Missing provider.")?;
            if !PROVIDERS.contains(&provider.as_str()) {
                return Err("Unknown provider.".into());
            }
            Call::Models { provider, force: force_param(params)? }
        }
        "task.start" => Call::Start(start::parse(params)?),
        "task.startStatus" => Call::StartStatus { start_id: id_param(params, "startId")? },
        "task.cancelStart" => Call::CancelStart { start_id: id_param(params, "startId")? },
        "task.messages" => Call::Messages { session_id: id_param(params, "sessionId")?, page: message_paging(params)?, budget: page_budget(params)? },
        "task.team" => Call::Team { session_id: id_param(params, "sessionId")? },
        "task.workerMessages" => {
            let after_id = match params.get("afterId").filter(|value| !value.is_null()) {
                None => 0,
                Some(value) => value.as_i64().filter(|id| *id >= 0).ok_or("Invalid afterId.")?,
            };
            let limit = match params.get("limit").filter(|value| !value.is_null()) {
                None => WORKER_MESSAGE_PAGE_DEFAULT,
                Some(value) => value.as_u64().and_then(|limit| i64::try_from(limit).ok()).filter(|limit| (1..=WORKER_MESSAGE_PAGE_MAX).contains(limit)).ok_or_else(|| format!("Limit must be between 1 and {WORKER_MESSAGE_PAGE_MAX}."))?,
            };
            let before_id = if params["tail"] == true {
                Some(i64::MAX)
            } else {
                match params.get("beforeId").filter(|value| !value.is_null()) {
                    None => None,
                    Some(value) => Some(value.as_i64().filter(|id| *id > 0).ok_or("Invalid beforeId.")?),
                }
            };
            Call::WorkerMessages { session_id: id_param(params, "sessionId")?, worker_id: id_param(params, "workerId")?, after_id, before_id, limit }
        }
        "task.attachment" => {
            let (variant, offset) = variant_offset(params)?;
            Call::Attachment { session_id: id_param(params, "sessionId")?, id: uuid_param(params, "id")?, variant, offset }
        }
        "task.workspaceImage" => {
            let (variant, offset) = variant_offset(params)?;
            let path = path_param(params, "path")?.ok_or("Missing path.")?;
            Call::WorkspaceImage { session_id: id_param(params, "sessionId")?, path, variant, offset }
        }
        "task.send" => Call::Send { session_id: id_param(params, "sessionId")?, text: text_param(params, "text")?, image_ids: images::ids_param(params)? },
        "image.put" => Call::PutImage(images::parse_chunk(params)?),
        "task.stop" => Call::Stop { session_id: id_param(params, "sessionId")? },
        "task.steer" => Call::Steer { session_id: id_param(params, "sessionId")?, text: text_param(params, "text")? },
        "task.configure" => configure(params)?,
        "approval.respond" => Call::Approve { session_id: id_param(params, "sessionId")?, request_id: id_param(params, "requestId")?, approve: params["approve"].as_bool().ok_or("Missing approve.")? },
        "input.respond" => Call::Answer { session_id: id_param(params, "sessionId")?, request_id: id_param(params, "requestId")?, response: params.get("response").cloned().ok_or("Missing response.")? },
        "task.pull" => Call::Pull { session_id: id_param(params, "sessionId")? },
        "task.pullDiff" => Call::PullDiff { session_id: id_param(params, "sessionId")?, path: path_param(params, "path")? },
        "task.pullMerge" => {
            let method = name_param(params, "method")?.ok_or("Missing method.")?;
            crate::github_pull::merge_flag(&method)?;
            Call::PullMerge { session_id: id_param(params, "sessionId")?, method }
        }
        "task.pullDetect" => Call::PullDetect { session_id: id_param(params, "sessionId")? },
        "task.changes" => Call::Changes { session_id: id_param(params, "sessionId")? },
        "task.diff" => Call::Diff { session_id: id_param(params, "sessionId")?, path: path_param(params, "path")?, staged: staged_param(params)? },
        "bots.list" => Call::BotsList,
        "bot.thread" => Call::BotThread { bot_id: id_param(params, "botId")? },
        "bot.message" => Call::BotMessage { bot_id: id_param(params, "botId")?, text: text_param(params, "text")? },
        "bot.pause" => Call::BotPause { bot_id: id_param(params, "botId")?, paused: params.get("paused").and_then(Value::as_bool).ok_or("Missing paused.")? },
        "batch" => Call::Batch(batch_calls(params)?),
        _ => return Err("Unknown method.".into()),
    })
}

fn fit_batch_results(results: Vec<Result<Value>>) -> Value {
    const OMITTED: &str = "Result omitted to keep the batch reply within 180 KiB; request it separately.";
    let mut results: Vec<Value> = results
        .into_iter()
        .map(|result| match result {
            Ok(result) => json!({"ok": true, "result": result}),
            Err(error) => json!({"ok": false, "error": error.chars().take(1000).collect::<String>()}),
        })
        .collect();
    let mut size = json!({"results": results}).to_string().len();
    if size > PAGE_BUDGET {
        let mut largest = results
            .iter()
            .enumerate()
            .filter(|(_, result)| result["ok"] == true)
            .map(|(index, result)| (index, result.to_string().len()))
            .collect::<Vec<_>>();
        largest.sort_by_key(|(_, size)| std::cmp::Reverse(*size));
        for (index, _) in largest {
            results[index] = json!({"ok": false, "error": OMITTED});
            size = json!({"results": results}).to_string().len();
            if size <= PAGE_BUDGET {
                break;
            }
        }
    }
    json!({"results": results})
}

/// Checked when a request arrives, before it waits in its peer's queue: it is fresh and
/// not a replay. Time spent queued must not make a valid request expire.
pub(crate) fn fresh_request(inner: &mut super::Inner, message: &Value, now_ms: i64) -> Result<()> {
    inner.replay.check(message["ts"].as_i64(), message["nonce"].as_str(), now_ms)
}

/// Checked when a queued request is about to run, not when it arrived: remote control is
/// still on and the sender is still in presence. Returns whether remote tasks may use
/// Full access.
fn admit(inner: &super::Inner, from: &str) -> Result<bool> {
    gate(inner.settings.host_enabled)?;
    inner.callable(from)?;
    Ok(inner.settings.remote_full_access)
}

/// The methods a `batch` request's calls name (each is checked against the device's grant
/// too), or none for any other method.
fn batch_methods<'a>(method: &str, params: &'a Value) -> impl Iterator<Item = &'a str> {
    let calls = if method == "batch" { params["calls"].as_array().map(Vec::as_slice).unwrap_or_default() } else { &[] };
    calls.iter().take(MAX_BATCH_CALLS).map(|call| call["method"].as_str().unwrap_or_default())
}

/// Without "Full access for remote tasks", an explicit `full` is refused and a start
/// without a mode (which would default to full) asks for approvals.
fn cap_mode(call: Call, full_access: bool) -> Result<Call> {
    const SAFE: &str = "ask";
    if full_access {
        return Ok(call);
    }
    let refuse = || Err(full_access_off());
    Ok(match call {
        Call::Start(start) if start.mode.as_deref() == Some("full") => return refuse(),
        Call::Start(start) => Call::Start(start::Start { mode: Some(start.mode.unwrap_or_else(|| SAFE.into())), ..start }),
        Call::Configure { mode: Some(mode), .. } if mode == "full" => return refuse(),
        other => other,
    })
}

fn full_access_off() -> String {
    format!("Full access is off for remote tasks on {}.", super::config::device_name())
}

/// Without "Full access for remote tasks", a prompt, steer or configure that would run a
/// task stored in `full` is refused, unless it switches the task to another mode. The
/// task's own mode is the user's and is never changed here.
fn allow_task_mode(stored: &str, requested: Option<&str>, full_access: bool) -> Result<()> {
    if !full_access && stored == "full" && requested.is_none_or(|mode| mode == "full") {
        return Err(full_access_off());
    }
    Ok(())
}

/// The response to one request frame, or None when it has no usable id.
pub(crate) async fn handle(app: &tauri::AppHandle, from: &str, message: &Value) -> Option<Value> {
    let id = message["id"].as_str().filter(|id| valid_id(id).is_ok())?;
    let method = message["method"].as_str().unwrap_or_default();
    // The Inner lock is released before the grant check (and redeem), which take it themselves.
    let admitted = admit(&remote(app).lock(), from);
    // A device waiting for approval redeems the pairing code shown here (grants.rs).
    if method == "pair.redeem" {
        return Some(response(id, admitted.and_then(|_| super::grants::redeem(app, from, &message["params"]))));
    }
    let admitted = admitted.and_then(|full_access| {
        for method in std::iter::once(method).chain(batch_methods(method, &message["params"])) {
            super::grants::check(app, from, method)?;
        }
        Ok(full_access)
    });
    let call = admitted.and_then(|full_access| parse(true, method, &message["params"]).map(|call| plain_budget(call, message["z"] == 1)).and_then(|call| cap_mode(call, full_access)).map(|call| (call, full_access)));
    let result = match call {
        Ok((call, full_access)) => run(app, from, call, full_access).await,
        Err(error) => Err(error),
    };
    Some(response(id, result))
}

fn response(id: &str, result: Result<Value>) -> Value {
    match result {
        Ok(result) => json!({"type": "res", "id": id, "ok": true, "result": result}),
        Err(error) => json!({"type": "res", "id": id, "ok": false, "error": error}),
    }
}

/// The task must exist here; a mirror never forwards a second hop.
async fn local_task(state: &AppState, session_id: &str) -> Result<crate::storage::Session> {
    let store = state.store.clone();
    let session_id = session_id.to_owned();
    crate::blocking(move || {
        let store = store.lock().map_err(|e| e.to_string())?;
        local_session_from(&store, &session_id)
    })
    .await
}

fn local_session_from(store: &crate::storage::Store, session_id: &str) -> Result<crate::storage::Session> {
    let task = store.session(session_id)?;
    if task.remote_device.is_some() {
        return Err("That task runs on another computer.".into());
    }
    Ok(task)
}

async fn task_root(state: &AppState, session_id: &str) -> Result<PathBuf> {
    let store = state.store.clone();
    let session_id = session_id.to_owned();
    crate::blocking(move || {
        let store = store.lock().map_err(|e| e.to_string())?;
        let task = local_session_from(&store, &session_id)?;
        store.workspace_root(&task.project_id, Some(&session_id))
    })
    .await
}

async fn linked_pull(state: &AppState, session_id: &str) -> Result<(PathBuf, i64)> {
    let store = state.store.clone();
    let session_id = session_id.to_owned();
    crate::blocking(move || {
        let store = store.lock().map_err(|e| e.to_string())?;
        let task = local_session_from(&store, &session_id)?;
        let number = task.pull_request.as_ref().map(|link| link.number).ok_or("This task has no linked pull request.")?;
        let root = store.workspace_root(&task.project_id, Some(&session_id))?;
        Ok((root, number))
    })
    .await
}

async fn optional_pull(state: &AppState, session_id: &str) -> Result<Option<(PathBuf, i64)>> {
    let store = state.store.clone();
    let session_id = session_id.to_owned();
    crate::blocking(move || {
        let store = store.lock().map_err(|e| e.to_string())?;
        let task = local_session_from(&store, &session_id)?;
        let Some(number) = task.pull_request.map(|link| link.number) else { return Ok(None) };
        let root = store.workspace_root(&task.project_id, Some(&session_id))?;
        Ok(Some((root, number)))
    })
    .await
}

async fn run(app: &tauri::AppHandle, from: &str, call: Call, full_access: bool) -> Result<Value> {
    match call {
        Call::Batch(calls) => {
            let mut results = Vec::with_capacity(calls.len());
            for call in calls {
                let method = call.as_ref().map(Call::method_name).unwrap_or("invalid");
                let handling = Instant::now();
                match call {
                    Ok(call) => results.push(run_one(app, from, call, full_access).await),
                    Err(error) => results.push(Err(error)),
                }
                if std::env::var_os("PANDACODE_CONNECT_TIMING").is_some() {
                    eprintln!("PandaCode Connect timing method={method} batch_call=true handle_ms={}", handling.elapsed().as_secs_f64() * 1000.0);
                }
            }
            Ok(fit_batch_results(results))
        }
        call => run_one(app, from, call, full_access).await,
    }
}

fn remote_worker_status(status: &str) -> &str {
    match status {
        "waiting" => "running",
        "queued" | "running" | "parked" | "completed" | "failed" | "stopped" => status,
        _ => "stopped",
    }
}

fn bounded_text(text: &str, max: usize) -> String {
    let mut end = text.len().min(max);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    if end < text.len() {
        format!("{}[Truncated]", &text[..end])
    } else {
        text.to_owned()
    }
}

fn remote_worker(worker: &crate::architect::Worker) -> Value {
    let checkpoint = worker.checkpoint.as_ref().map(|checkpoint| {
        json!({
            "summary": bounded_text(&checkpoint.summary, 1024),
            "nextSteps": bounded_text(&checkpoint.next_steps, 1024),
            "blocker": checkpoint.blocker.as_deref().map(|blocker| bounded_text(blocker, 1024)),
            "updatedAt": checkpoint.updated_at,
        })
    });
    json!({
        "id": worker.id,
        "name": worker.name,
        "provider": worker.provider,
        "model": worker.model,
        "status": remote_worker_status(&worker.status),
        "attempt": worker.attempt,
        "summary": bounded_text(&worker.summary, 2048),
        "checkpoint": checkpoint,
        "files": worker.files,
        "dependsOn": worker.depends_on,
        "startedAt": worker.created_at,
        "createdAt": worker.created_at,
        "updatedAt": worker.updated_at,
        "sessionId": worker.session_id,
        // Desktop TeamWorker fields the phone's team panel also uses.
        "profileId": worker.profile_id,
        "assignment": bounded_text(&worker.assignment, 2048),
        "error": worker.error.as_deref().map(|error| bounded_text(error, 1024)),
        "readOnly": worker.read_only,
        "abandoned": worker.abandoned,
        "filesTruncated": false,
        "parentWorker": worker.parent_worker,
    })
}

fn team_reply(
    store: &crate::storage::Store,
    team: &crate::architect::TeamSnapshot,
) -> Result<Value> {
    let mut query = store.db.prepare("SELECT id,sender,recipient,content,created_at FROM architect_messages WHERE parent_session_id=?1 ORDER BY id DESC LIMIT ?2").map_err(|error| error.to_string())?;
    let mut messages = query
        .query_map(
            rusqlite::params![team.session_id, TEAM_MESSAGE_COUNT as i64],
            |row| {
                Ok(json!({
                    "id": row.get::<_, i64>(0)?,
                    "sender": row.get::<_, String>(1)?,
                    "recipient": row.get::<_, String>(2)?,
                    "message": bounded_text(&row.get::<_, String>(3)?, TEAM_MESSAGE_TEXT),
                    "createdAt": row.get::<_, i64>(4)?,
                }))
            },
        )
        .map_err(|error| error.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| error.to_string())?;
    messages.reverse();

    let workers: Vec<Value> = team.workers.iter().map(remote_worker).collect();
    let mut snapshot = remote_team(team, workers);
    if !messages.is_empty() {
        snapshot["messages"] = json!(messages);
    }
    Ok(fit_team_reply(json!({"team": snapshot})))
}

fn remote_team(team: &crate::architect::TeamSnapshot, workers: Vec<Value>) -> Value {
    json!({
        "sessionId": team.session_id,
        "status": team.status,
        "round": team.round,
        "revision": team.revision,
        "summary": team.summary.as_deref().map(|summary| bounded_text(summary, 4096)),
        "updatedAt": team.updated_at,
        "mode": if team.config.auto { "auto" } else { "classic" },
        "rounds": {"used": team.round, "max": team.config.max_rounds},
        "workers": workers,
    })
}

fn trim_team_files(reply: &mut Value) -> bool {
    let Some(workers) = reply["team"]["workers"].as_array_mut() else {
        return false;
    };
    let Some(index) = workers
        .iter()
        .enumerate()
        .filter_map(|(index, worker)| {
            worker["files"]
                .as_array()
                .filter(|files| !files.is_empty())
                .map(|files| (index, json!(files).to_string().len()))
        })
        .max_by_key(|(_, size)| *size)
        .map(|(index, _)| index)
    else {
        return false;
    };
    let worker = &mut workers[index];
    if let Some(files) = worker["files"].as_array_mut() {
        files.pop();
        worker["filesTruncated"] = json!(true);
    }
    true
}

fn trim_team_text(reply: &mut Value) -> bool {
    let Some(team) = reply["team"].as_object_mut() else {
        return false;
    };
    let mut target: Option<(usize, usize, String, usize)> = None;
    let mut consider = |row: usize, field: usize, key: &str, value: &Value| {
        if let Some(text) = value.as_str() {
            if text.len() > 256
                && target
                    .as_ref()
                    .is_none_or(|(_, _, _, length)| text.len() > *length)
            {
                target = Some((row, field, key.to_owned(), text.len()));
            }
        }
    };
    if let Some(workers) = team.get("workers").and_then(Value::as_array) {
        for (index, worker) in workers.iter().enumerate() {
            for key in ["summary", "assignment", "error"] {
                consider(index, 0, key, &worker[key]);
            }
            for key in ["summary", "nextSteps", "blocker"] {
                consider(index, 1, key, &worker["checkpoint"][key]);
            }
        }
    }
    if let Some(messages) = team.get("messages").and_then(Value::as_array) {
        for (index, message) in messages.iter().enumerate() {
            consider(index, 2, "message", &message["message"]);
        }
    }
    let Some((index, group, key, _)) = target else {
        return false;
    };
    let text = if group == 2 {
        &mut reply["team"]["messages"][index][&key]
    } else if group == 1 {
        &mut reply["team"]["workers"][index]["checkpoint"][&key]
    } else {
        &mut reply["team"]["workers"][index][&key]
    };
    if let Some(value) = text.as_str() {
        *text = json!(bounded_text(value, value.len() / 2));
        reply["team"]["truncated"] = json!(true);
        return true;
    }
    false
}

/// Keeps the complete worker list where possible, trimming file detail and prose first.
fn fit_team_reply(mut reply: Value) -> Value {
    while reply.to_string().len() > PAGE_BUDGET {
        if trim_team_text(&mut reply) || trim_team_files(&mut reply) {
            reply["team"]["truncated"] = json!(true);
            continue;
        }
        if reply["team"]["messages"]
            .as_array()
            .is_some_and(|messages| !messages.is_empty())
        {
            reply["team"]["messages"].as_array_mut().unwrap().remove(0);
            reply["team"]["truncated"] = json!(true);
            continue;
        }
        if reply["team"]["workers"]
            .as_array()
            .is_some_and(|workers| !workers.is_empty())
        {
            reply["team"]["workers"].as_array_mut().unwrap().pop();
            reply["team"]["workersTruncated"] = json!(true);
            continue;
        }
        shrink(&mut reply, PAGE_BUDGET);
        break;
    }
    reply
}

fn worker_messages(
    store: &crate::storage::Store,
    session_id: &str,
    worker_id: &str,
    after_id: i64,
    before_id: Option<i64>,
    limit: i64,
) -> Result<Value> {
    local_session_from(store, session_id)?;
    let team = crate::architect::load(store, session_id)?.ok_or("Team is unavailable.")?;
    let worker = team
        .workers
        .iter()
        .find(|worker| worker.id == worker_id)
        .ok_or("Worker does not belong to this team.")?;
    let worker_session = worker.session_id.as_str();
    let task = local_session_from(store, worker_session)?;
    let last_id: Option<i64> = store
        .db
        .query_row(
            "SELECT MAX(id) FROM messages WHERE session_id=?1",
            [worker_session],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    // Backward pages read newest first and are put back in order below.
    let (window, order) = if before_id.is_some() { ("<", "DESC") } else { (">", "") };
    let mut query = store.db.prepare(&format!("SELECT m.id,m.session_id,m.role,CASE WHEN m.role='assistant' THEN COALESCE(substr(CAST(m.content AS BLOB),1,131076),X'') ELSE m.content END,m.created_at,m.turn_duration_ms,t.summary FROM messages m LEFT JOIN turn_changes t ON t.message_id=m.id WHERE m.session_id=?1 AND m.id{window}?2 ORDER BY m.id {order} LIMIT ?3")).map_err(|error| error.to_string())?;
    let rows = query
        .query_map(
            rusqlite::params![worker_session, before_id.unwrap_or(after_id), limit + 1],
            |row| {
                let role: String = row.get(2)?;
                let content = match row.get_ref(3)? {
                    rusqlite::types::ValueRef::Blob(bytes) if role == "assistant" => {
                        String::from_utf8_lossy(bytes).into_owned()
                    }
                    _ => row.get(3)?,
                };
                let turn_changes = row
                    .get::<_, Option<String>>(6)?
                    .map(|summary| {
                        serde_json::from_str(&summary).map_err(|error| {
                            rusqlite::Error::FromSqlConversionFailure(
                                6,
                                rusqlite::types::Type::Text,
                                Box::new(error),
                            )
                        })
                    })
                    .transpose()?;
                Ok(crate::storage::Message {
                    id: row.get(0)?,
                    session_id: row.get(1)?,
                    role,
                    content,
                    created_at: row.get(4)?,
                    turn_duration_ms: row.get(5)?,
                    author_provider: None,
                    turn_changes,
                    coordination_kind: None,
                })
            },
        )
        .map_err(|error| error.to_string())?;
    let mut messages = rows
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| error.to_string())?;
    // Backward, the extra row is an older one: `hasOlder` reports it.
    let fetched_more = messages.len() > limit as usize && before_id.is_none();
    messages.truncate(limit as usize);
    if before_id.is_some() {
        messages.reverse();
    }
    for message in &mut messages {
        crate::architect::internal_turns::project_message(store, message)?;
        const NOTICE: &str = "\n\n[Message preview truncated at 128 KiB. The provider retains the complete conversation.]";
        if message.content.len() > 128 * 1024 {
            let mut end = 128 * 1024 - NOTICE.len();
            while !message.content.is_char_boundary(end) {
                end -= 1;
            }
            message.content.truncate(end);
            message.content.push_str(NOTICE);
        }
    }
    if let Some(last) = messages.last() {
        let mut author = store.provider_at_message(worker_session, last.id)?;
        for message in messages.iter_mut().rev() {
            if message.role == "handoff" {
                if let Ok(value) = serde_json::from_str::<Value>(&message.content) {
                    if let Some(provider) = value.get("fromProvider").and_then(Value::as_str) {
                        author = provider.to_owned();
                    }
                }
            } else if message.role == "assistant" {
                message.author_provider = Some(author.clone());
            }
        }
    }
    let message_values = messages
        .iter()
        .map(serde_json::to_value)
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let first_id = message_values
        .first()
        .and_then(|message| message["id"].as_i64());
    let has_older = match first_id {
        Some(id) => message_exists(&store.db, worker_session, id, true)?,
        None => false,
    };
    let mut reply = fit_worker_message_page(
        &bounded_text(&task.title, 1024),
        last_id,
        message_values,
        has_older,
        fetched_more,
        before_id.is_some(),
    );
    if let Some(id) = reply["messages"]
        .as_array()
        .and_then(|messages| messages.last())
        .and_then(|message| message["id"].as_i64())
    {
        reply["hasMore"] =
            json!(fetched_more || message_exists(&store.db, worker_session, id, false)?);
    }
    if before_id.is_some() {
        // Tells viewers this host pages backward; older ones ignore `tail` and `beforeId`.
        reply["tail"] = json!(true);
    }
    Ok(reply)
}

fn fit_worker_message_page(
    title: &str,
    last_id: Option<i64>,
    values: Vec<Value>,
    has_older: bool,
    fetched_more: bool,
    backward: bool,
) -> Value {
    // Measured once each; `false` is the longer flag, so the sum never undercounts.
    let envelope = json!({"messages": [], "hasMore": false, "hasOlder": false, "title": title, "lastId": last_id}).to_string().len();
    let (mut kept, mut size, mut cut) = (Vec::new(), envelope, false);
    // A backward page keeps the rows next to its cursor (the newest) and drops older ones,
    // so a cut page continues backward (`hasOlder`), never forward.
    let ordered: Box<dyn Iterator<Item = Value>> = if backward { Box::new(values.into_iter().rev()) } else { Box::new(values.into_iter()) };
    for mut message in ordered {
        shrink(&mut message, MAX_MESSAGE);
        let length = message.to_string().len() + 1;
        if size + length > PAGE_BUDGET {
            if kept.is_empty() {
                shrink(&mut message, PAGE_BUDGET.saturating_sub(envelope + 8));
                if envelope + message.to_string().len() <= PAGE_BUDGET {
                    kept.push(message);
                }
            }
            cut = true;
            break;
        }
        size += length;
        kept.push(message);
    }
    if backward {
        kept.reverse();
    }
    let (has_more, has_older) = if backward { (fetched_more, has_older || cut) } else { (fetched_more || cut, has_older) };
    json!({"messages": kept, "hasMore": has_more, "hasOlder": has_older, "title": title, "lastId": last_id})
}

fn team_event_cache() -> &'static StdMutex<HashMap<String, HashMap<String, Value>>> {
    static CACHE: OnceLock<StdMutex<HashMap<String, HashMap<String, Value>>>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

/// Forgets the team rows of tasks no subscriber follows any more, so a phone that comes back
/// gets every row again.
fn forget_unfollowed_teams(inner: &super::Inner) {
    team_event_cache()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .retain(|session, _| inner.subscribers.values().any(|s| s.sessions.contains(session)));
}

fn queue_team_event(app: &tauri::AppHandle, session_id: &str, data: Value) {
    journaled(app, session_id, team_event_value(session_id, data), Queue::Event);
}

fn team_event_value(session_id: &str, data: Value) -> Value {
    json!({"sessionId": session_id, "kind": "team", "text": "", "requestId": null, "data": data})
}

fn changed_worker_rows(
    team: &crate::architect::TeamSnapshot,
    previous: &mut HashMap<String, Value>,
) -> Vec<Value> {
    let mut changed = Vec::new();
    let mut live_ids = HashSet::new();
    for worker in &team.workers {
        live_ids.insert(worker.id.clone());
        let row = remote_worker(worker);
        if previous.get(&worker.id) != Some(&row) {
            previous.insert(worker.id.clone(), row.clone());
            changed.push(row);
        }
    }
    previous.retain(|id, _| live_ids.contains(id));
    changed
}

/// The part of an architect team a task row needs: the desktop shows the task as
/// running while its team is running or waiting, even between architect turns.
#[derive(Clone, Debug, PartialEq)]
struct TeamState {
    status: String,
    active_workers: i64,
    revision: u64,
}

impl TeamState {
    fn of(team: &crate::architect::TeamSnapshot) -> Self {
        let active_workers = team
            .workers
            .iter()
            .filter(|w| !w.abandoned && matches!(w.status.as_str(), "queued" | "running" | "waiting"))
            .count() as i64;
        Self { status: team.status.clone(), active_workers, revision: team.revision }
    }

    fn active(&self) -> bool {
        matches!(self.status.as_str(), "running" | "waiting")
    }

    fn value(&self) -> Value {
        json!({"status": self.status, "activeWorkers": self.active_workers})
    }
}

/// Team states for those of `ids` that lead a team, read in one query without
/// deserializing the saved snapshots.
fn team_states(db: &rusqlite::Connection, ids: &[&str]) -> Result<HashMap<String, TeamState>> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let mut query = db.prepare("SELECT session_id,COALESCE(json_extract(content,'$.status'),''),COALESCE(json_extract(content,'$.revision'),0),(SELECT COUNT(*) FROM json_each(content,'$.workers') w WHERE COALESCE(json_extract(w.value,'$.abandoned'),0)=0 AND json_extract(w.value,'$.status') IN ('queued','running','waiting')) FROM architect_teams WHERE session_id IN (SELECT value FROM json_each(?1))").map_err(|e| e.to_string())?;
    let rows = query
        .query_map([json!(ids).to_string()], |row| {
            Ok((row.get::<_, String>(0)?, TeamState { status: row.get(1)?, revision: row.get::<_, i64>(2)?.max(0) as u64, active_workers: row.get(3)? }))
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<_>>().map_err(|e| e.to_string())
}

/// The newest team state reported or seen per architect task, so a team the phone was
/// told is active gets a settling `run.finished` when it stops.
fn team_status_cache() -> &'static StdMutex<HashMap<String, TeamState>> {
    static CACHE: OnceLock<StdMutex<HashMap<String, TeamState>>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

/// Records `team` unless a newer revision was already seen. Returns the newest state and
/// whether this observation settled a team last seen active.
fn observe_team(cache: &mut HashMap<String, TeamState>, session_id: &str, team: TeamState) -> (TeamState, bool) {
    match cache.get(session_id) {
        Some(seen) if seen.revision > team.revision => (seen.clone(), false),
        previous => {
            let settled = previous.is_some_and(TeamState::active) && !team.active();
            cache.insert(session_id.to_owned(), team.clone());
            (team, settled)
        }
    }
}

/// Reads and records the team states of `ids`.
fn observed_team_states(db: &rusqlite::Connection, ids: &[&str]) -> Result<HashMap<String, TeamState>> {
    let states = team_states(db, ids)?;
    let mut cache = team_status_cache().lock().unwrap_or_else(|error| error.into_inner());
    Ok(states.into_iter().map(|(id, team)| {
        let newest = observe_team(&mut cache, &id, team).0;
        (id, newest)
    }).collect())
}

/// A row's status as the desktop shows it. Only a registered agent is really running, so a
/// stale running row reads as interrupted, but an active team keeps its task running.
/// A team task's row also carries `team`.
fn shape_task_status(row: &mut Value, has_agent: bool, team: Option<&TeamState>) {
    let saved = row["status"].as_str().unwrap_or_default().to_owned();
    let mut status = if !has_agent && matches!(saved.as_str(), "running" | "waiting") { "interrupted".to_owned() } else { saved };
    if let Some(team) = team {
        if team.active() && !(has_agent && status == "waiting") {
            status = "running".into();
        }
        row["team"] = team.value();
    }
    row["status"] = json!(status);
}

/// An architect run can end while its workers carry on: then the phone must not settle it.
fn shape_finished(data: &mut Value, team: Option<&TeamState>) {
    if let Some(team) = team {
        if team.active() {
            data["status"] = json!("running");
        }
        data["team"] = team.value();
    }
}

/// `run.finished` for a team that settled after its architect's last run ended.
fn settled_finished(session_id: &str, saved_status: &str, team: &TeamState) -> Value {
    let mut data = json!({
        "sessionId": session_id,
        "successful": team.status == "completed",
        "stopped": team.status == "paused",
        "text": match team.status.as_str() { "completed" => "Team completed", "paused" => "Team paused", "failed" => "Team failed", _ => "Team stopped" },
        "status": saved_status,
        "teamSettled": true,
    });
    shape_task_status(&mut data, false, Some(team));
    data
}

/// Queues the settling `run.finished` unless the architect itself still runs (its own
/// run end reports the team) or that run end is still waiting in the buffer.
async fn queue_team_settled(app: tauri::AppHandle, session_id: String, team: TeamState) {
    let handle = app.clone();
    let id = session_id.clone();
    let data = crate::blocking(move || {
        let state = handle.state::<AppState>();
        if state.agents.lock().map_err(|e| e.to_string())?.contains_key(&id) {
            return Ok(None);
        }
        let store = state.store.lock().map_err(|e| e.to_string())?;
        let status: Option<String> = store.db.query_row("SELECT status FROM sessions WHERE id=?1 AND remote_device IS NULL", [&id], |r| r.get(0)).optional().map_err(|e| e.to_string())?;
        Ok(status.map(|status| settled_finished(&id, &status, &team)))
    })
    .await;
    let Ok(Some(data)) = data else { return };
    journaled(&app, &session_id, data, Queue::Settled);
}

/// Architect state is a Tauri app event on desktop. Translate it once the first
/// Connect viewer subscribes, and feed only changed worker rows through the same
/// per-subscriber 100 ms event buffer used for agent deltas.
fn watch_team_events(app: &tauri::AppHandle) {
    static WATCHING: OnceLock<()> = OnceLock::new();
    WATCHING.get_or_init(|| {
        let app = app.clone();
        let listener_app = app.clone();
        let _ = app.listen("architect-event", move |event| {
            let Ok(value) = serde_json::from_str::<Value>(event.payload()) else {
                return;
            };
            if value["removed"] == true {
                if let Some(session_id) = value["sessionId"].as_str() {
                    team_event_cache()
                        .lock()
                        .unwrap_or_else(|error| error.into_inner())
                        .remove(session_id);
                    team_status_cache()
                        .lock()
                        .unwrap_or_else(|error| error.into_inner())
                        .remove(session_id);
                    queue_team_event(&listener_app, session_id, json!({"removed": true}));
                }
                return;
            }
            let Ok(team) = serde_json::from_value::<crate::architect::TeamSnapshot>(value) else {
                return;
            };
            // Rows are remembered only while hosting and a phone follows the task; a phone
            // that starts following gets every row once, then only changes.
            let following = listener_app
                .try_state::<super::Remote>()
                .is_some_and(|state| followed(&state.lock(), &team.session_id) == Some(true));
            let changed = {
                let mut cache = team_event_cache()
                    .lock()
                    .unwrap_or_else(|error| error.into_inner());
                if following {
                    let previous = cache.entry(team.session_id.clone()).or_default();
                    changed_worker_rows(&team, previous)
                } else {
                    cache.remove(&team.session_id);
                    Vec::new()
                }
            };
            for worker in changed {
                queue_team_event(&listener_app, &team.session_id, worker);
            }
            // This runs inside the emit, possibly under the agent and store locks: only the
            // cache is touched here, and the settle check runs on the blocking pool.
            let (state, settled) = observe_team(
                &mut team_status_cache().lock().unwrap_or_else(|error| error.into_inner()),
                &team.session_id,
                TeamState::of(&team),
            );
            if settled {
                tauri::async_runtime::spawn(queue_team_settled(listener_app.clone(), team.session_id.clone(), state));
            }
        });
    });
}

async fn run_one(app: &tauri::AppHandle, from: &str, call: Call, full_access: bool) -> Result<Value> {
    let state = app.state::<AppState>();
    match call {
        Call::Subscribe { session_ids, after, epoch, replay: budget } => {
            watch_team_events(app);
            let handle = app.clone();
            let requested = session_ids.clone();
            let (mut tasks, missing) = crate::blocking(move || {
                let state = handle.state::<AppState>();
                subscribed_tasks(&state, &requested)
            })
            .await?;
            // In a block, so the lock is gone before the await below.
            let (fallback, replay) = {
                let state = remote(app);
                let mut inner = state.lock();
                let subscriber = inner.subscribers.entry(from.to_owned()).or_default();
                // Added to, not replaced: a task started a moment ago may not be in the list yet.
                // An expired (or overgrown) subscription starts over.
                if subscriber.until.is_none_or(|until| until <= Instant::now()) || subscriber.sessions.len() > 4 * MAX_IDS {
                    subscriber.sessions.clear();
                    forget_unfollowed_teams(&inner);
                }
                let subscriber = inner.subscribers.entry(from.to_owned()).or_default();
                subscriber.until = Some(Instant::now() + SUBSCRIPTION);
                subscriber.sessions.extend(session_ids);
                // The plain-sized replay, read at the same journal position, is the fallback for
                // events that pack poorly; it always fits. Measured after the lock is released.
                let fallback = (budget > REPLAY_BUDGET).then(|| tasks.clone()).map(|mut tasks| {
                    let replay = inner.journal.resume(&mut tasks, &after, epoch.as_deref(), REPLAY_BUDGET);
                    (subscribe_reply(tasks, &missing, &replay), replay)
                });
                let replay = inner.journal.resume(&mut tasks, &after, epoch.as_deref(), budget);
                (fallback, replay)
            };
            let reply = subscribe_reply(tasks, &missing, &replay);
            let (reply, replay) = match fallback {
                Some(plain) if packed_len(&reply) > PAGE_BUDGET => plain,
                _ => (reply, replay),
            };
            let reply = if replay.gaps > 0 {
                let handle = app.clone();
                crate::blocking(move || {
                    let state = handle.state::<AppState>();
                    let store = state.store.lock().map_err(|e| e.to_string())?;
                    Ok(add_gap_subagents(reply, |id| store.subagents(id)))
                })
                .await?
            } else {
                reply
            };
            if replay.gaps > 0 {
                super::diagnostics::record("replay.gap", format!("{} of {} tasks for {from}", replay.gaps, after.len()));
            }
            Ok(reply)
        }
        Call::TasksList { limit } => {
            let handle = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let state = handle.state::<AppState>();
                tasks_list(&state, limit)
            })
            .await
            .map_err(|e| e.to_string())?
        }
        Call::ProjectIcons { project_ids } => {
            let handle = app.clone();
            crate::blocking(move || {
                let state = handle.state::<AppState>();
                project_icons(&state, &project_ids)
            })
            .await
        }
        Call::Providers { force } => {
            let mut providers = serde_json::to_value(crate::local_providers(force).await).map_err(|e| e.to_string())?;
            fit_providers(&mut providers);
            Ok(providers)
        }
        Call::Models { provider, force } => {
            let mut models = serde_json::to_value(crate::local_provider_models(&provider, force).await?).map_err(|e| e.to_string())?;
            if let Some(list) = models.as_array_mut() {
                fit_list(list, PAGE_BUDGET);
            }
            Ok(models)
        }
        Call::Start(request) => start_once(app, from, request).await,
        Call::StartStatus { start_id } => Ok(start_status(host_starts().lock().unwrap_or_else(|e| e.into_inner()).get(&start_id).filter(|start| start.from == from).map(Arc::as_ref))),
        Call::CancelStart { start_id } => {
            let mut starts = host_starts().lock().unwrap_or_else(|e| e.into_inner());
            Ok(match starts.get(&start_id) {
                Some(start) if start.from == from => cancel_start(start),
                Some(_) => json!({"cancelled": true}),
                // Not claimed yet (still waiting for a start slot): leave it cancelled so it never runs.
                None => {
                    let (entry, _) = claim_start(&mut starts, &start_id, from, Instant::now())?;
                    cancel_start(&entry)
                }
            })
        }
        Call::Messages { session_id, page, budget } => {
            let handle = app.clone();
            crate::blocking(move || {
                let state = handle.state::<AppState>();
                let rows = {
                    let store = state.store.lock().map_err(|e| e.to_string())?;
                    local_session_from(&store, &session_id)?;
                    read_page(&store.db, &session_id, page)?
                };
                Ok(fit_page(rows, budget))
            })
            .await
        }
        Call::Team { session_id } => {
            let handle = app.clone();
            crate::blocking(move || {
                let state = handle.state::<AppState>();
                let store = state.store.lock().map_err(|e| e.to_string())?;
                local_session_from(&store, &session_id)?;
                let Some(team) = crate::architect::load(&store, &session_id)? else {
                    return Ok(json!({"team": null}));
                };
                team_reply(&store, &team)
            })
            .await
        }
        Call::WorkerMessages { session_id, worker_id, after_id, before_id, limit } => {
            let handle = app.clone();
            crate::blocking(move || {
                let state = handle.state::<AppState>();
                let store = state.store.lock().map_err(|e| e.to_string())?;
                worker_messages(&store, &session_id, &worker_id, after_id, before_id, limit)
            })
            .await
        }
        Call::Attachment { session_id, id, variant, offset } => {
            let app_data_dir = app.path().app_data_dir().map_err(|error| error.to_string())?;
            let store = state.store.clone();
            crate::blocking(move || {
                let store = store.lock().map_err(|error| error.to_string())?;
                local_session_from(&store, &session_id)?;
                let image = crate::attachments::load_attachment(&store.db, &app_data_dir, &session_id, &id)?;
                let (mime, bytes) = crate::attachments::variant_bytes(&image.bytes, &image.metadata.mime, variant)?;
                crate::attachments::chunk_reply(&bytes, &mime, offset)
            }).await
        }
        Call::WorkspaceImage { session_id, path, variant, offset } => {
            let root = task_root(&state, &session_id).await?;
            crate::blocking(move || {
                let data_url = crate::workspace::image_data_url(&root, &path)?;
                let (header, encoded) = data_url.split_once(',').ok_or("Invalid workspace image.")?;
                let mime = header.strip_prefix("data:").and_then(|value| value.strip_suffix(";base64")).ok_or("Invalid workspace image.")?;
                let bytes = base64::engine::general_purpose::STANDARD.decode(encoded).map_err(|error| error.to_string())?;
                let (mime, bytes) = crate::attachments::variant_bytes(&bytes, mime, variant)?;
                crate::attachments::chunk_reply(&bytes, &mime, offset)
            }).await
        }
        Call::PutImage(chunk) => images::put(app, from, chunk).await,
        Call::Send { session_id, text, image_ids } => {
            allow_task_mode(&local_task(&state, &session_id).await?.mode, None, full_access)?;
            // Only images this caller just sent; they are now this task's.
            images::claim(app, from, &image_ids)?;
            // Like Enter in the composer: a running task queues the message.
            let busy = || state.agents.lock().map(|agents| agents.contains_key(&session_id)).map_err(|e| e.to_string());
            if busy()? {
                let queued: Vec<Value> = image_ids.iter().map(|id| json!({"kind": "image", "id": id, "name": "Image", "width": 0, "height": 0, "thumbnail": "", "source": "file"})).collect();
                let entry = message_queue::add(&*state.store.lock().map_err(|e| e.to_string())?, &session_id, &text, &json!(queued))?;
                // If the run ended between the check and the add, nothing would deliver the
                // entry: take it back (unless a run end already did) and send it now.
                if busy()? || message_queue::take(&*state.store.lock().map_err(|e| e.to_string())?, &entry.id).is_err() {
                    let _ = app.emit("queue-changed", json!({"sessionId": session_id}));
                    return Ok(json!({"queued": true}));
                }
            }
            crate::send_message(app.clone(), state, session_id, text, Some(image_ids), None).await?;
            let _ = app.emit("sessions-changed", ());
            Ok(json!({"queued": false}))
        }
        Call::Stop { session_id } => {
            local_task(&state, &session_id).await?;
            // Like the desktop Stop button: a task leading an active team stops the whole
            // team (architect and workers), which also covers the gap between architect turns.
            let store = state.store.clone();
            let id = session_id.clone();
            let team_active = crate::blocking(move || {
                let store = store.lock().map_err(|e| e.to_string())?;
                Ok(team_states(&store.db, &[id.as_str()])?.get(&id).is_some_and(TeamState::active))
            })
            .await?;
            if team_active {
                crate::architect::architect_control(app.clone(), state, session_id, "stop".into()).await?;
            } else {
                crate::stop_session(app.clone(), state, session_id).await?;
            }
            Ok(json!({}))
        }
        Call::Steer { session_id, text } => {
            allow_task_mode(&local_task(&state, &session_id).await?.mode, None, full_access)?;
            message_queue::steer_task(app.clone(), state, session_id, text).await
        }
        Call::Configure { session_id, model, effort, mode } => {
            allow_task_mode(&local_task(&state, &session_id).await?.mode, mode.as_deref(), full_access)?;
            if let Some((provider, _)) = &model {
                start::require_installed(provider).await?;
            }
            if let Some(mode) = mode {
                crate::update_session(app.clone(), state.clone(), session_id.clone(), None, None, None, Some(mode)).await?;
            }
            if let Some((provider, model)) = model {
                crate::configure_session(app.clone(), state.clone(), session_id.clone(), provider, model, None).await?;
            }
            if let Some(effort) = effort {
                crate::set_reasoning_effort(app.clone(), state, session_id, effort).await?;
            }
            let _ = app.emit("sessions-changed", ());
            Ok(json!({}))
        }
        Call::Approve { session_id, request_id, approve } => {
            local_task(&state, &session_id).await?;
            crate::respond_approval(app.clone(), state, session_id.clone(), request_id.clone(), approve).await?;
            answered(app, session_id, "approval_cancelled", request_id);
            Ok(json!({}))
        }
        Call::Answer { session_id, request_id, response } => {
            local_task(&state, &session_id).await?;
            crate::respond_user_input(app.clone(), state, session_id.clone(), request_id.clone(), response).await?;
            answered(app, session_id, "input_cancelled", request_id);
            Ok(json!({}))
        }
        Call::Pull { session_id } => {
            let Some((root, number)) = optional_pull(&state, &session_id).await? else { return Ok(json!({"pull": null })) };
            let pull = pull_detail_cached(&session_id, root, number).await?;
            Ok(json!({"pull": pull}))
        }
        Call::PullDiff { session_id, path } => {
            let (root, number) = linked_pull(&state, &session_id).await?;
            if let Some(path) = path {
                pull_diff_cached(&session_id, root, number, path).await
            } else {
                let pull = pull_detail_cached(&session_id, root, number).await?;
                Ok(fit_pull_files(pull["files"].clone()))
            }
        }
        Call::PullMerge { session_id, method } => {
            let (root, number) = linked_pull(&state, &session_id).await?;
            crate::github_pull::merge_flag(&method)?;
            let store = state.store.clone();
            let cache_session_id = session_id.clone();
            crate::blocking(move || {
                let link = crate::github_pull::merge(&root, number, &method)?;
                store.lock().map_err(|e| e.to_string())?.set_task_link(&session_id, "pull", Some(&link)).map(|_| ())
            })
            .await?;
            invalidate_pull_cache(&cache_session_id);
            let _ = app.emit("sessions-changed", ());
            Ok(json!({}))
        }
        Call::PullDetect { session_id } => detect_pull(app, &state, &session_id).await,
        Call::Changes { session_id } => {
            let root = task_root(&state, &session_id).await?;
            crate::blocking(move || {
                let status = crate::workspace::git_status(&root)?;
                let (ahead, behind) = if status.is_repo { ahead_behind(&root)? } else { (0, 0) };
                Ok(changes_reply(status, ahead, behind))
            })
            .await
        }
        Call::Diff { session_id, path, staged } => {
            let root = task_root(&state, &session_id).await?;
            crate::blocking(move || {
                let diff = crate::workspace::git_diff(&root, path, staged)?;
                let underlying_truncated = diff.contains("[Preview truncated at 256 KiB]");
                let (diff, truncated) = bounded_diff(diff, underlying_truncated);
                Ok(json!({"diff": diff, "truncated": truncated}))
            })
            .await
        }
        Call::BotsList => {
            let handle = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let state = handle.state::<AppState>();
                bots_list(&state)
            })
            .await
            .map_err(|e| e.to_string())?
        }
        Call::BotThread { bot_id } => {
            let store = state.store.clone();
            let (session_id, created) = tauri::async_runtime::spawn_blocking(move || {
                let store = store.lock().map_err(|e| e.to_string())?;
                let bot = crate::bots::get(&store, &bot_id)?;
                crate::bots::thread_session(&store, &bot, crate::bots::DESKTOP, crate::bots::DESKTOP, &format!("{} · You", bot.name))
            })
            .await
            .map_err(|e| e.to_string())??;
            if created {
                let _ = app.emit("sessions-changed", ());
                let _ = app.emit("bots-changed", ());
            }
            Ok(json!({"sessionId": session_id}))
        }
        Call::BotMessage { bot_id, text } => {
            let session_id = crate::bots::bot_message(app.clone(), bot_id, text, None, None, None).await?;
            Ok(json!({"sessionId": session_id}))
        }
        Call::BotPause { bot_id, paused } => {
            if paused {
                crate::bots::gateway::stop_bot(app, &bot_id).await;
            }
            let store = state.store.clone();
            tauri::async_runtime::spawn_blocking(move || {
                crate::bots::set_paused(&*store.lock().map_err(|e| e.to_string())?, &bot_id, paused).map(|_| ())
            })
            .await
            .map_err(|e| e.to_string())??;
            let _ = app.emit("bots-changed", ());
            Ok(json!({}))
        }
        Call::Batch(_) => Err("Nested batch calls are not supported.".into()),
    }
}

/// A remote answer clears the card in this window and on every other viewer, as a
/// harness's own `*_cancelled` would: through the same forwarding as any agent event.
fn answered(app: &tauri::AppHandle, session_id: String, kind: &str, request_id: String) {
    let event = AgentEvent { session_id, kind: kind.into(), text: String::new(), request_id: Some(request_id), data: None, tool: None };
    agent_event(app, &event);
    let _ = app.emit("agent-event", event);
}

/// A start by the viewer's `startId`: a repeated `task.start` waits for (or returns) the
/// first one's result, `task.startStatus` reports it and `task.cancelStart` stops it.
struct HostStart {
    from: String,
    /// Set by `task.cancelStart`; `start::run_cancellable` checks it between steps and stops the clone.
    cancel: Arc<start::Cancel>,
    result: tokio::sync::watch::Sender<Option<Result<Value>>>,
    at: Instant,
}

fn host_starts() -> &'static StdMutex<HashMap<String, Arc<HostStart>>> {
    static STARTS: OnceLock<StdMutex<HashMap<String, Arc<HostStart>>>> = OnceLock::new();
    STARTS.get_or_init(Default::default)
}

/// The start under `id`, made now (true) unless this device already asked for it.
fn claim_start(starts: &mut HashMap<String, Arc<HostStart>>, id: &str, from: &str, now: Instant) -> Result<(Arc<HostStart>, bool)> {
    starts.retain(|_, start| start.result.borrow().is_none() || now.duration_since(start.at) < START_MEMORY);
    if let Some(start) = starts.get(id) {
        return if start.from == from { Ok((start.clone(), false)) } else { Err("Invalid startId.".into()) };
    }
    if starts.len() >= MAX_HOST_STARTS {
        return Err("This computer is busy. Try again in a moment.".into());
    }
    let start = Arc::new(HostStart { from: from.to_owned(), cancel: Default::default(), result: tokio::sync::watch::channel(None).0, at: now });
    starts.insert(id.to_owned(), start.clone());
    Ok((start, true))
}

/// Runs a start once per `startId`. The start runs on its own, so a lost reply or a
/// cancelled caller never stops it halfway; every caller waits for its one result.
async fn start_once(app: &tauri::AppHandle, from: &str, request: start::Start) -> Result<Value> {
    let Some(id) = request.start_id.clone() else { return start::run(app, from, request).await };
    let (entry, fresh) = claim_start(&mut host_starts().lock().unwrap_or_else(|e| e.into_inner()), &id, from, Instant::now())?;
    let mut done = entry.result.subscribe();
    if fresh {
        let (app, from, entry) = (app.clone(), from.to_owned(), entry.clone());
        tauri::async_runtime::spawn(async move {
            // A panic (or the task being dropped) below still settles the start.
            let settle = Settle(entry.clone());
            // A cancel is refused once the task is being made, so a made task is never unseen.
            let result = start::run_cancellable(&app, &from, request, entry.cancel.clone()).await;
            if let Err(error) = &result {
                super::diagnostics::record("start.failed", error.chars().take(200).collect::<String>());
            }
            settle.finish(result);
        });
    }
    let result = done.wait_for(Option::is_some).await.ok().and_then(|slot| slot.clone());
    result.unwrap_or_else(|| Err(START_ENDED.into()))
}

const START_ENDED: &str = "The start ended unexpectedly.";

/// Settles a host start with its result, or, dropped first (the start panicked or was
/// dropped), with [`START_ENDED`], so `task.startStatus` never reports it running forever.
struct Settle(Arc<HostStart>);

impl Settle {
    fn finish(self, result: Result<Value>) {
        self.0.result.send_if_modified(|slot| slot.is_none() && slot.replace(result).is_none());
    }
}

impl Drop for Settle {
    fn drop(&mut self) {
        if self.0.result.borrow().is_none() {
            super::diagnostics::record("start.failed", START_ENDED);
            self.0.result.send_if_modified(|slot| slot.is_none() && slot.replace(Err(START_ENDED.into())).is_none());
        }
    }
}

/// `task.startStatus`: running, done (with the host task), failed, or unknown here.
fn start_status(start: Option<&HostStart>) -> Value {
    let Some(start) = start else { return json!({"state": "unknown"}) };
    match &*start.result.borrow() {
        None => json!({"state": "running"}),
        // With the worktree note too, for a viewer whose `task.start` reply was lost.
        Some(Ok(reply)) => {
            let mut done = json!({"state": "done", "sessionId": reply["sessionId"]});
            for key in ["worktree", "note"].into_iter().filter(|key| !reply[key].is_null()) {
                done[key] = reply[key].clone();
            }
            done
        }
        Some(Err(error)) => json!({"state": "failed", "error": error}),
    }
}

/// `task.cancelStart`: a running start is told to stop and its callers get `CANCELLED`
/// at once; a start that already made its task says so (`cancelled: false`), and one making
/// it now answers `cancelled: false, pending: true` (the viewer links and stops it once made).
fn cancel_start(start: &HostStart) -> Value {
    let mut answer = json!({"cancelled": true});
    start.result.send_if_modified(|slot| match slot {
        None if start.cancel.cancel() => {
            *slot = Some(Err(start::CANCELLED.into()));
            true
        }
        None => {
            answer = json!({"cancelled": false, "pending": true});
            false
        }
        Some(Ok(reply)) => {
            answer = json!({"cancelled": false, "sessionId": reply["sessionId"]});
            false
        }
        Some(Err(_)) => false,
    });
    answer
}

/// Recent agent events of subscribed tasks, numbered by one process-wide `seq`, so a
/// viewer that comes back gets exactly what it missed (docs/remote-access.md). `epoch`
/// is new with every launch, when `seq` starts over.
pub(crate) struct Journal {
    pub(crate) epoch: String,
    seq: u64,
    bytes: usize,
    rings: HashMap<String, Ring>,
    /// A delayed sweep ([`sweep_later`]) is scheduled.
    sweeping: bool,
}

impl Default for Journal {
    fn default() -> Self {
        Self { epoch: uuid::Uuid::new_v4().simple().to_string(), seq: 0, bytes: 0, rings: HashMap::new(), sweeping: false }
    }
}

struct Ring {
    /// `seq` when recording began: anything before it may be missing.
    since: u64,
    /// The newest `seq` dropped to stay in bounds.
    dropped: u64,
    bytes: usize,
    /// When a viewer last followed the task or its run last ended.
    touched: Instant,
    /// The newest entry is a run end.
    finished: bool,
    /// Kept as sent (JSON text, far smaller than a parsed Value), parsed only for a replay.
    events: std::collections::VecDeque<(u64, String)>,
}

#[derive(Debug, PartialEq)]
enum Missed {
    /// The missed events in order; with `more`, only the first ones, through seq `last`.
    Events { events: Vec<Value>, more: bool, last: u64 },
    Gap,
}

/// What [`Journal::resume`] added to a subscribe reply.
pub(crate) struct Resumed {
    pub(crate) epoch: String,
    /// Some task's replay continues in the next page.
    pub(crate) more: bool,
    pub(crate) gaps: usize,
}

impl Journal {
    /// Starts recording a task's events, unless it already is.
    fn watch(&mut self, session: &str) {
        let now = Instant::now();
        if let Some(ring) = self.rings.get_mut(session) {
            ring.touched = now;
            return;
        }
        self.sweep(now);
        if self.rings.len() >= JOURNAL_TASKS {
            let quiet = self.rings.iter().min_by_key(|(_, ring)| ring.events.back().map_or(ring.since, |(seq, ..)| *seq)).map(|(id, _)| id.clone());
            if let Some(ring) = quiet.and_then(|id| self.rings.remove(&id)) {
                self.bytes -= ring.bytes;
            }
        }
        self.rings.insert(session.to_owned(), Ring { since: self.seq, dropped: 0, bytes: 0, touched: now, finished: false, events: Default::default() });
    }

    /// How long until the first finished ring goes idle, when no sweep is scheduled yet;
    /// the caller schedules one ([`sweep_later`]) for then.
    fn arm(&mut self, now: Instant) -> Option<Duration> {
        if self.sweeping {
            return None;
        }
        let due = self.rings.values().filter(|ring| ring.finished).map(|ring| ring.touched + JOURNAL_IDLE).min()?;
        self.sweeping = true;
        Some(due.saturating_duration_since(now))
    }

    /// The scheduled sweep: drops what went idle and says when to run again, if anything is
    /// still waiting (a ring followed again meanwhile is due later, never polled).
    fn fire(&mut self, now: Instant) -> Option<Duration> {
        self.sweeping = false;
        self.sweep(now);
        self.arm(now)
    }

    /// Drops the rings of finished tasks nobody has followed for [`JOURNAL_IDLE`]. Run on
    /// a new ring, a subscribe and a run end, and by [`sweep_later`] once a run end idles.
    fn sweep(&mut self, now: Instant) {
        let bytes = &mut self.bytes;
        self.rings.retain(|_, ring| {
            let keep = !ring.finished || now.saturating_duration_since(ring.touched) < JOURNAL_IDLE;
            if !keep {
                *bytes -= ring.bytes;
            }
            keep
        });
    }

    /// Numbers and keeps an event of a recorded (or, with `subscribed`, newly recorded)
    /// task; the event as sent, with its `seq`, or None when nobody follows the task.
    fn record(&mut self, session: &str, mut event: Value, subscribed: bool) -> Option<Value> {
        let now = Instant::now();
        let finished = event["kind"] == "run.finished";
        if finished {
            self.sweep(now);
        }
        if !self.rings.contains_key(session) {
            if !subscribed {
                return None;
            }
            self.watch(session);
        }
        self.seq += 1;
        event["seq"] = json!(self.seq);
        let text = event.to_string();
        let size = text.len();
        let ring = self.rings.get_mut(session)?;
        if subscribed || finished {
            ring.touched = now;
        }
        ring.finished = finished;
        ring.events.push_back((self.seq, text));
        ring.bytes += size;
        self.bytes += size;
        while ring.events.len() > JOURNAL_EVENTS || ring.bytes > JOURNAL_BYTES {
            let Some((seq, text)) = ring.events.pop_front() else { break };
            (ring.dropped, ring.bytes, self.bytes) = (seq, ring.bytes - text.len(), self.bytes - text.len());
        }
        while self.bytes > JOURNAL_TOTAL {
            // The oldest event anywhere goes first, so the one just recorded stays.
            let Some(ring) = self.rings.values_mut().filter(|ring| !ring.events.is_empty()).min_by_key(|ring| ring.events.front().map_or(0, |(seq, _)| *seq)) else { break };
            let Some((seq, text)) = ring.events.pop_front() else { break };
            (ring.dropped, ring.bytes, self.bytes) = (seq, ring.bytes - text.len(), self.bytes - text.len());
        }
        Some(event)
    }

    /// Replaces a recorded event (a run end shaped with its team at send time), so a replay
    /// says what the live frame said.
    fn amend(&mut self, session: &str, seq: u64, event: Value) {
        let Some(ring) = self.rings.get_mut(session) else { return };
        let Some(slot) = ring.events.iter_mut().find(|(at, _)| *at == seq) else { return };
        let text = event.to_string();
        (ring.bytes, self.bytes) = (ring.bytes - slot.1.len() + text.len(), self.bytes - slot.1.len() + text.len());
        slot.1 = text;
    }

    /// The events after `after` in order, as many as fit `budget`, or a gap when some are
    /// gone. With `first`, the page's first replay, one event always goes (cut to fit), so
    /// every page moves on.
    fn missed(&self, session: &str, after: u64, budget: usize, first: bool) -> Missed {
        let Some(ring) = self.rings.get(session).filter(|ring| after >= ring.since && after >= ring.dropped && after <= self.seq) else { return Missed::Gap };
        let (mut events, mut size, mut last) = (Vec::new(), 2, after);
        let mut pending = ring.events.iter().filter(|(seq, _)| *seq > after).peekable();
        while let Some(&(seq, text)) = pending.peek() {
            // Sizes are summed before deltas are joined, so the page only comes out smaller.
            let Ok(mut event) = serde_json::from_str::<Value>(text) else {
                pending.next();
                continue;
            };
            let mut length = text.len();
            if size + length + 1 > budget {
                if !first || !events.is_empty() {
                    break;
                }
                shrink(&mut event, budget.saturating_sub(size + 1));
                length = event.to_string().len();
            }
            size += length + 1;
            last = *seq;
            push_event(&mut events, event);
            pending.next();
        }
        Missed::Events { events, more: pending.peek().is_some(), last }
    }

    /// Adds to each subscribed task the newest `seq`, and for a viewer that says where it
    /// left off (same `epoch`), the events it missed or `gap: true`. The replay fills at most
    /// [`REPLAY_BUDGET`]: a task whose replay goes on is marked `more` and its `seq` is the
    /// last one replayed, so the viewer's next subscribe continues from there.
    fn resume(&mut self, tasks: &mut [Value], after: &HashMap<String, u64>, epoch: Option<&str>, budget: usize) -> Resumed {
        let same = epoch == Some(self.epoch.as_str());
        let (mut room, mut more, mut gaps) = (budget, false, 0);
        for task in tasks {
            let Some(id) = task["sessionId"].as_str().map(str::to_owned) else { continue };
            self.watch(&id);
            task["seq"] = json!(self.seq);
            let Some(&after) = after.get(&id) else { continue };
            // Past the room, a task's replay starts in the next page.
            match if same { self.missed(&id, after, room, room == budget) } else { Missed::Gap } {
                Missed::Events { events, more: rest, last } => {
                    if !events.is_empty() {
                        room = room.saturating_sub(json!(events).to_string().len());
                        task["events"] = json!(events);
                    }
                    if rest {
                        (more, task["more"], task["seq"]) = (true, json!(true), json!(last));
                    }
                }
                Missed::Gap => {
                    gaps += 1;
                    task["gap"] = json!(true);
                }
            }
        }
        // After the loop, which touched every subscribed task, so none of those is dropped.
        self.sweep(Instant::now());
        Resumed { epoch: self.epoch.clone(), more, gaps }
    }
}

#[derive(Clone)]
struct PullCacheEntry {
    expires: Instant,
    value: Value,
}

#[derive(Clone, Hash, PartialEq, Eq)]
enum PullFlightKey {
    Detail(String, i64),
    Diff(String, i64, String),
    Detect(String, i64, Option<i64>),
}

#[derive(Default)]
struct PullCache {
    details: HashMap<(String, i64), PullCacheEntry>,
    diffs: HashMap<(String, i64, String), PullCacheEntry>,
    detects: HashMap<(String, i64, Option<i64>), PullCacheEntry>,
    flights: HashMap<PullFlightKey, Arc<tokio::sync::Mutex<()>>>,
}

static PULL_CACHE: OnceLock<StdMutex<PullCache>> = OnceLock::new();

fn with_pull_cache<T>(f: impl FnOnce(&mut PullCache) -> T) -> T {
    let mut cache = PULL_CACHE
        .get_or_init(|| StdMutex::new(PullCache::default()))
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    f(&mut cache)
}

fn trim_pull_cache<K: std::hash::Hash + Eq + Clone>(entries: &mut HashMap<K, PullCacheEntry>) {
    let now = Instant::now();
    entries.retain(|_, entry| entry.expires > now);
    while entries.len() > MAX_PULL_CACHE_ENTRIES {
        let Some(key) = entries.keys().next().cloned() else { break };
        entries.remove(&key);
    }
}

fn cached_pull_entry<K: std::hash::Hash + Eq + Clone>(entries: &mut HashMap<K, PullCacheEntry>, key: &K) -> Option<Value> {
    trim_pull_cache(entries);
    entries.get(key).map(|entry| entry.value.clone())
}

fn store_pull_entry<K: std::hash::Hash + Eq + Clone>(entries: &mut HashMap<K, PullCacheEntry>, key: K, value: Value) {
    trim_pull_cache(entries);
    entries.insert(key, PullCacheEntry { expires: Instant::now() + PULL_CACHE_TTL, value });
    trim_pull_cache(entries);
}

fn pull_flight(key: PullFlightKey) -> Arc<tokio::sync::Mutex<()>> {
    with_pull_cache(|cache| {
        cache.flights.retain(|_, flight| Arc::strong_count(flight) > 1);
        cache.flights.entry(key).or_default().clone()
    })
}

async fn pull_detail_cached(session_id: &str, root: PathBuf, number: i64) -> Result<Value> {
    let key = (session_id.to_owned(), number);
    if let Some(value) = with_pull_cache(|cache| cached_pull_entry(&mut cache.details, &key)) {
        return Ok(value);
    }
    let flight = pull_flight(PullFlightKey::Detail(key.0.clone(), key.1));
    let _flight = flight.lock().await;
    if let Some(value) = with_pull_cache(|cache| cached_pull_entry(&mut cache.details, &key)) {
        return Ok(value);
    }
    let mut value = serde_json::to_value(crate::blocking(move || crate::github_pull::detail(&root, number)).await?)
        .map_err(|error| error.to_string())?;
    fit_pull_detail(&mut value);
    with_pull_cache(|cache| store_pull_entry(&mut cache.details, key, value.clone()));
    Ok(value)
}

async fn pull_diff_cached(session_id: &str, root: PathBuf, number: i64, path: String) -> Result<Value> {
    let key = (session_id.to_owned(), number, path.clone());
    if let Some(value) = with_pull_cache(|cache| cached_pull_entry(&mut cache.diffs, &key)) {
        return Ok(value);
    }
    let flight = pull_flight(PullFlightKey::Diff(key.0.clone(), key.1, key.2.clone()));
    let _flight = flight.lock().await;
    if let Some(value) = with_pull_cache(|cache| cached_pull_entry(&mut cache.diffs, &key)) {
        return Ok(value);
    }
    let value = crate::blocking(move || {
        let diff = crate::github_pull::diff(&root, number)?;
        let (patch, truncated) = pull_file_patch(&diff.patch, &path, diff.truncated);
        let (patch, truncated) = bounded_diff(patch, truncated);
        Ok(json!({"patch": patch, "truncated": truncated}))
    })
    .await?;
    with_pull_cache(|cache| store_pull_entry(&mut cache.diffs, key, value.clone()));
    Ok(value)
}

fn cached_pull_detect(session_id: &str, latest_message_id: i64, existing_number: Option<i64>) -> Option<Value> {
    let key = (session_id.to_owned(), latest_message_id, existing_number);
    with_pull_cache(|cache| cached_pull_entry(&mut cache.detects, &key))
}

fn store_pull_detect(session_id: &str, latest_message_id: i64, existing_number: Option<i64>, value: Value) {
    let key = (session_id.to_owned(), latest_message_id, existing_number);
    with_pull_cache(|cache| store_pull_entry(&mut cache.detects, key, value));
}

fn invalidate_pull_cache(session_id: &str) {
    with_pull_cache(|cache| {
        cache.details.retain(|(id, _), _| id != session_id);
        cache.diffs.retain(|(id, _, _), _| id != session_id);
        cache.detects.retain(|(id, _, _), _| id != session_id);
    });
}

async fn detect_pull(app: &tauri::AppHandle, state: &AppState, session_id: &str) -> Result<Value> {
    let store = state.store.clone();
    let session_id_owned = session_id.to_owned();
    let context = crate::blocking(move || {
        let store = store.lock().map_err(|e| e.to_string())?;
        let task = local_session_from(&store, &session_id_owned)?;
        if task.pull_request.as_ref().is_some_and(|link| ["open", "draft"].contains(&link.state.as_str())) {
            return Ok(None);
        }
        let messages = store.messages(&session_id_owned, None)?;
        let latest_message_id = messages.first().map(|message| message.id).unwrap_or_default();
        let mut turn = Vec::new();
        let mut started = 0;
        for message in messages {
            if message.role == "user" {
                started = message.created_at;
                break;
            }
            turn.push(message.content);
        }
        if !turn.iter().any(|text| text.contains("/pull/")) {
            return Ok(None);
        }
        let root = store.workspace_root(&task.project_id, Some(&session_id_owned))?;
        Ok(Some((root, turn, started, task.pull_request.map(|link| link.number), latest_message_id)))
    })
    .await?;
    let Some((root, turn, started, existing_number, latest_message_id)) = context else { return Ok(json!({"pull": null })) };
    if let Some(value) = cached_pull_detect(session_id, latest_message_id, existing_number) {
        return Ok(value);
    }
    let flight = pull_flight(PullFlightKey::Detect(session_id.to_owned(), latest_message_id, existing_number));
    let _flight = flight.lock().await;
    if let Some(value) = cached_pull_detect(session_id, latest_message_id, existing_number) {
        return Ok(value);
    }
    let detect_root = root.clone();
    let detection = crate::blocking(move || {
        let repo = match crate::github::repository(&detect_root) {
            Ok(repo) => repo,
            Err(error) if error.is_empty() => return Ok(None),
            Err(error) => return Err(error),
        };
        let branch = crate::workspace::git_status(&detect_root).map(|status| status.branch).unwrap_or_default();
        crate::github_pull::detect(&detect_root, &repo, &turn, &branch, started)
    })
    .await?;
    let Some(link) = detection else {
        let value = json!({"pull": null});
        store_pull_detect(session_id, latest_message_id, existing_number, value.clone());
        return Ok(value);
    };
    if existing_number == Some(link.number) {
        let value = json!({"pull": null});
        store_pull_detect(session_id, latest_message_id, existing_number, value.clone());
        return Ok(value);
    }
    let pull = pull_detail_cached(session_id, root, link.number).await?;
    let store = state.store.clone();
    let session_id_owned = session_id.to_owned();
    let saved_link = link.clone();
    let saved = crate::blocking(move || {
        let store = store.lock().map_err(|e| e.to_string())?;
        if store.session(&session_id_owned)?.pull_request.is_some_and(|current| current.number == saved_link.number) {
            return Ok(false);
        }
        store.set_task_link(&session_id_owned, "pull", Some(&saved_link))?;
        Ok(true)
    })
    .await?;
    if saved {
        let _ = app.emit("sessions-changed", ());
    }
    let value = if saved { json!({"pull": pull}) } else { json!({"pull": null}) };
    store_pull_detect(session_id, latest_message_id, existing_number, value.clone());
    Ok(value)
}

fn bots_list(state: &AppState) -> Result<Value> {
    let active: HashSet<String> = state.agents.lock().map_err(|e| e.to_string())?.keys().cloned().collect();
    let store = state.store.lock().map_err(|e| e.to_string())?;
    let active_projects: HashSet<String> = store
        .sessions()?
        .into_iter()
        .filter(|task| active.contains(&task.id))
        .map(|task| task.project_id)
        .collect();
    let mut items = Vec::new();
    for bot in crate::bots::list(&store)? {
        let desktop_session: Option<String> = store
            .db
            .query_row("SELECT session_id FROM bot_threads WHERE bot_id=?1 AND channel_id=?2", rusqlite::params![bot.id, crate::bots::DESKTOP], |row| row.get(0))
            .optional()
            .map_err(|e| e.to_string())?;
        let avatar = (bot.avatar.len() <= MAX_BOT_AVATAR_BYTES).then_some(bot.avatar);
        let state = if bot.paused { "paused" } else if active_projects.contains(&bot.project_id) { "working" } else { "ready" };
        items.push(json!({
            "id": bot.id,
            "name": bot.name,
            "avatar": avatar,
            "state": state,
            "paused": bot.paused,
            "desktopSession": desktop_session,
            "projectId": bot.project_id,
        }));
    }
    fit_list(&mut items, PAGE_BUDGET.saturating_sub(json!({"bots": []}).to_string().len()));
    Ok(json!({"bots": items}))
}

fn ahead_behind(root: &Path) -> Result<(usize, usize)> {
    let mut command = Command::new("git");
    command.args(["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]).current_dir(root);
    let output = crate::workspace::run_process(command, "Git", 8192, Duration::from_secs(10))?;
    if !output.status.success() {
        let error = String::from_utf8_lossy(&output.stderr.bytes).to_ascii_lowercase();
        if error.contains("upstream") || error.contains("unknown revision") || error.contains("ambiguous argument") {
            return Ok((0, 0));
        }
        return match crate::workspace::checked(output) {
            Err(error) => Err(error),
            Ok(_) => Err("Git operation failed".into()),
        };
    }
    let capture = crate::workspace::checked(output)?;
    let counts = std::str::from_utf8(&capture.bytes).map_err(|_| "Git returned invalid ahead/behind counts")?;
    let mut parts = counts.split_whitespace();
    let ahead = parts.next().and_then(|value| value.parse::<usize>().ok()).ok_or("Git returned invalid ahead/behind counts")?;
    let behind = parts.next().and_then(|value| value.parse::<usize>().ok()).ok_or("Git returned invalid ahead/behind counts")?;
    if parts.next().is_some() {
        return Err("Git returned invalid ahead/behind counts".into());
    }
    Ok((ahead, behind))
}

fn changes_reply(status: crate::workspace::GitStatus, ahead: usize, behind: usize) -> Value {
    let mut files: Vec<Value> = status
        .files
        .into_iter()
        .map(|file| {
            let staged = file.index != " " && file.index != "?";
            let status = if file.index == "?" { "??".to_owned() } else if file.index == " " { file.working } else if file.working == " " { file.index } else { format!("{}{}", file.index, file.working) };
            json!({"path": file.path, "status": status, "staged": staged})
        })
        .collect();
    fit_list(&mut files, PAGE_BUDGET.saturating_sub(json!({"branch": status.branch, "ahead": ahead, "behind": behind, "files": []}).to_string().len()));
    let mut reply = json!({"branch": status.branch, "ahead": ahead, "behind": behind, "files": files});
    shrink(&mut reply, PAGE_BUDGET);
    reply
}

fn bounded_diff(mut diff: String, truncated: bool) -> (String, bool) {
    const MARKER: &str = "\n…[cut on the host to fit a remote diff]";
    if diff.len() <= DIFF_BUDGET && !truncated {
        return (diff, false);
    }
    let end = (DIFF_BUDGET - MARKER.len()).min(diff.len());
    diff.truncate(head(&diff, end).len());
    diff.push_str(MARKER);
    (diff, true)
}

fn unquote_git_path(path: &str) -> Option<String> {
    if !path.starts_with('"') {
        return Some(path.to_owned());
    }
    let bytes = path.as_bytes();
    let (mut index, mut decoded) = (1, Vec::new());
    while index < bytes.len() {
        match bytes[index] {
            b'"' => return String::from_utf8(decoded).ok(),
            b'\\' => {
                index += 1;
                let escape = *bytes.get(index)?;
                match escape {
                    b'"' | b'\\' => decoded.push(escape),
                    b'a' => decoded.push(7),
                    b'b' => decoded.push(8),
                    b't' => decoded.push(b'\t'),
                    b'n' => decoded.push(b'\n'),
                    b'v' => decoded.push(11),
                    b'f' => decoded.push(12),
                    b'r' => decoded.push(b'\r'),
                    b'0'..=b'7' => {
                        let mut value = (escape - b'0') as u16;
                        for _ in 0..2 {
                            if bytes.get(index + 1).is_some_and(|byte| (b'0'..=b'7').contains(byte)) {
                                index += 1;
                                value = value * 8 + (bytes[index] - b'0') as u16;
                            } else {
                                break;
                            }
                        }
                        decoded.push(u8::try_from(value).ok()?);
                    }
                    _ => return None,
                }
            }
            byte => decoded.push(byte),
        }
        index += 1;
    }
    None
}

fn path_from_diff_header(line: &str) -> Option<String> {
    let line = line.strip_prefix("--- ").or_else(|| line.strip_prefix("+++ "))?;
    let path = line.split('\t').next()?;
    let decoded = unquote_git_path(path)?;
    decoded.strip_prefix("a/").or_else(|| decoded.strip_prefix("b/")).map(str::to_owned)
}

fn pull_file_patch(diff: &str, path: &str, source_truncated: bool) -> (String, bool) {
    let starts: Vec<usize> = diff
        .match_indices("diff --git ")
        .filter_map(|(index, _)| (index == 0 || diff.as_bytes().get(index - 1) == Some(&b'\n')).then_some(index))
        .collect();
    for (position, start) in starts.iter().copied().enumerate() {
        let end = starts.get(position + 1).copied().unwrap_or(diff.len());
        let section = &diff[start..end];
        let header = section.lines().take_while(|line| !line.starts_with("@@") && *line != "GIT binary patch");
        let matches_headers = header
            .clone()
            .filter_map(path_from_diff_header)
            .any(|candidate| candidate == path)
            || header
                .clone()
                .filter_map(|line| line.strip_prefix("rename from ").or_else(|| line.strip_prefix("rename to ")))
                .filter_map(unquote_git_path)
                .any(|candidate| candidate == path)
            || header.filter_map(|line| line.strip_prefix("Binary files ")).any(|paths| {
                paths
                    .strip_suffix(" differ")
                    .and_then(|paths| paths.split_once(" and "))
                    .is_some_and(|(left, right)| {
                        [left, right].into_iter().filter_map(unquote_git_path).filter_map(|file| file.strip_prefix("a/").or_else(|| file.strip_prefix("b/")).map(str::to_owned)).any(|file| file == path)
                    })
            });
        let matches = matches_headers;
        if matches {
            return (section.to_owned(), source_truncated && end == diff.len());
        }
    }
    (String::new(), source_truncated)
}

fn fit_pull_files(mut files: Value) -> Value {
    let Some(list) = files.as_array_mut() else { return json!({"files": [], "truncated": false}) };
    let count = list.len();
    fit_list(list, PAGE_BUDGET.saturating_sub(json!({"files": [], "truncated": true}).to_string().len()));
    let truncated = list.len() < count;
    json!({"files": files, "truncated": truncated})
}

fn fit_pull_detail(pull: &mut Value) {
    let budget = PAGE_BUDGET.saturating_sub(16);
    let mut truncated = pull["bodyTruncated"].as_bool().unwrap_or(false);
    pull["truncated"] = json!(truncated);
    const ARRAYS: [&str; 5] = ["timeline", "files", "commits", "checks", "labels"];
    while pull.to_string().len() > budget {
        let largest = ARRAYS
            .iter()
            .filter_map(|key| pull.get(*key).and_then(Value::as_array).filter(|items| !items.is_empty()).map(|items| (*key, json!(items).to_string().len())))
            .max_by_key(|(_, size)| *size);
        let body_len = pull["body"].as_str().map(str::len).unwrap_or_default();
        if let Some((key, _)) = largest.filter(|(_, size)| *size >= body_len || body_len <= 2 * CUT.len()) {
            if let Some(items) = pull.get_mut(key).and_then(Value::as_array_mut) {
                let budget = json!(items).to_string().len() / 2;
                fit_list(items, budget);
            }
            truncated = true;
        } else if body_len > 2 * CUT.len() {
            let size = pull.to_string().len();
            let target = body_len.saturating_sub(size.saturating_sub(budget)).saturating_sub(CUT.len());
            let text = pull["body"].as_str().unwrap_or_default();
            pull["body"] = json!(format!("{}{}", head(text, target), CUT));
            pull["bodyTruncated"] = json!(true);
            truncated = true;
        } else if let Some((key, _)) = largest {
            if let Some(items) = pull.get_mut(key).and_then(Value::as_array_mut) {
                let budget = json!(items).to_string().len() / 2;
                fit_list(items, budget);
            }
            truncated = true;
        } else {
            shrink(pull, budget);
            truncated = true;
            break;
        }
        pull["truncated"] = json!(truncated);
    }
    pull["truncated"] = json!(truncated);
}

#[derive(Clone, Copy)]
struct LiveTiming {
    last_event_at: i64,
    run_started_at: Option<i64>,
}

struct LiveRun {
    timing: LiveTiming,
    subagents: Vec<Value>,
    subagents_truncated: bool,
}

fn add_live_timing(task: &mut Value, timing: Option<LiveTiming>) {
    let Some(timing) = timing else { return };
    task["lastEventAt"] = json!(timing.last_event_at);
    if let Some(started_at) = timing.run_started_at {
        task["runStartedAt"] = json!(started_at);
    }
}

/// Fits desktop-shaped child snapshots into a small slice of the response budget.
fn bounded_subagents(activities: &[crate::providers::SubagentActivity], budget: usize) -> Result<(Vec<Value>, bool)> {
    let mut items = Vec::new();
    let mut truncated = activities.len() > MAX_SUBAGENT_SNAPSHOT;
    for activity in activities.iter().take(MAX_SUBAGENT_SNAPSHOT) {
        let mut item = serde_json::to_value(activity).map_err(|error| error.to_string())?;
        let original_size = item.to_string().len();
        let current_size = json!(&items).to_string().len();
        let separator = usize::from(!items.is_empty());
        let remaining = budget.saturating_sub(current_size.saturating_add(separator));
        shrink(&mut item, remaining);
        let item_size = item.to_string().len();
        if item_size > remaining {
            truncated = true;
            break;
        }
        truncated |= item_size < original_size;
        items.push(item);
    }
    truncated |= items.len() < activities.len();
    Ok((items, truncated))
}

fn live_run(agent: &crate::RunningAgent) -> Result<LiveRun> {
    let activities = agent
        .subagents
        .lock()
        .map_err(|error| error.to_string())?
        .merge_history(Vec::new());
    let (subagents, subagents_truncated) = bounded_subagents(&activities, SUBAGENT_SNAPSHOT_BUDGET)?;
    Ok(LiveRun {
        timing: LiveTiming {
            last_event_at: agent.last_event.load(Ordering::SeqCst),
            run_started_at: None,
        },
        subagents,
        subagents_truncated,
    })
}

/// Returns local tasks and their projects for a viewer's task picker. Store::sessions
/// already omits drafts and architect workers; mirrors are filtered and bot workspaces tagged here.
fn tasks_list(state: &AppState, limit: usize) -> Result<Value> {
    let (last_event_by_session, pending_by_session) = {
        let agents = state.agents.lock().map_err(|e| e.to_string())?;
        let mut last_event = HashMap::new();
        let mut pending = HashMap::new();
        for (session_id, agent) in agents.iter() {
            last_event.insert(session_id.clone(), agent.last_event.load(Ordering::SeqCst));
            let requests = agent.pending_requests.lock().map_err(|e| e.to_string())?;
            let items = pending_items(&requests);
            if !items.is_empty() {
                pending.insert(session_id.clone(), items);
            }
        }
        (last_event, pending)
    };
    let (sessions, project_rows, bots_by_project) = {
        let store = state.store.lock().map_err(|e| e.to_string())?;
        let bots = crate::bots::list(&store)?.into_iter().map(|bot| (bot.project_id, (bot.id, bot.name))).collect::<HashMap<_, _>>();
        (store.sessions()?, store.projects()?, bots)
    };
    let bot_projects: HashSet<String> = bots_by_project.keys().cloned().collect();

    let project_chats: HashSet<String> = project_rows
        .iter()
        .filter(|project| !bot_projects.contains(&project.id) && crate::chats::is_chat_folder(Path::new(&project.path)))
        .map(|project| project.id.clone())
        .collect();
    let projects: Vec<Value> = project_rows
        .into_iter()
        .filter(|project| !bot_projects.contains(&project.id))
        .map(|project| {
            let repo = crate::github_hub::project_repo(Path::new(&project.path));
            json!({"id": project.id, "name": project.name, "repo": repo})
        })
        .collect();
    let project_names: HashMap<String, String> = projects
        .iter()
        .filter_map(|project| Some((project["id"].as_str()?.to_owned(), project["name"].as_str()?.to_owned())))
        .collect();
    let mut sessions: Vec<_> = sessions
        .into_iter()
        .filter(|task| task.remote_device.is_none() && (project_names.contains_key(&task.project_id) || bot_projects.contains(&task.project_id)))
        .collect();
    sessions.sort_by(|a, b| activity_at(b).cmp(&activity_at(a)).then_with(|| a.id.cmp(&b.id)));
    sessions.truncate(limit);
    let teams = {
        let ids: Vec<&str> = sessions.iter().map(|task| task.id.as_str()).collect();
        observed_team_states(&state.store.lock().map_err(|e| e.to_string())?.db, &ids)?
    };
    let tasks: Vec<Value> = sessions
        .into_iter()
        .map(|task| {
            let project_name = project_names.get(&task.project_id).or_else(|| bots_by_project.get(&task.project_id).map(|(_, name)| name)).cloned().unwrap_or_default();
            let run_started_at = task.last_prompt_at;
            let mut item = json!({
                "sessionId": task.id,
                "title": task.title,
                "status": task.status,
                "projectId": task.project_id,
                "projectName": project_name,
                "provider": task.provider,
                "model": task.model,
                "effort": task.reasoning_effort,
                "mode": task.mode,
                "pinned": task.pinned,
                "updatedAt": task.updated_at,
                "lastPromptAt": task.last_prompt_at,
                "pending": pending_by_session.get(&task.id).cloned().unwrap_or_default(),
            });
            shape_task_status(&mut item, last_event_by_session.contains_key(&task.id), teams.get(&task.id));
            if let Some(&last_event_at) = last_event_by_session.get(&task.id) {
                add_live_timing(&mut item, Some(LiveTiming { last_event_at, run_started_at }));
            }
            if let Some((bot_id, bot_name)) = bots_by_project.get(&task.project_id) {
                item["botId"] = json!(bot_id);
                item["botName"] = json!(bot_name);
            }
            if let Some(branch) = task.worktree_branch {
                item["branch"] = json!(branch);
            }
            if project_chats.contains(&task.project_id) {
                item["chat"] = json!(true);
            }
            item
        })
        .collect();
    Ok(fit_task_lists(tasks, projects))
}

/// Resolves only registered non-bot projects, keeping filesystem icon reads off the async runtime.
fn project_icons(state: &AppState, ids: &[String]) -> Result<Value> {
    let project_paths = {
        let store = state.store.lock().map_err(|e| e.to_string())?;
        let bot_projects: HashSet<String> = crate::bots::project_ids(&store)?.into_iter().collect();
        store
            .projects()?
            .into_iter()
            .filter(|project| !bot_projects.contains(&project.id))
            .map(|project| (project.id, std::path::PathBuf::from(project.path)))
            .collect::<HashMap<_, _>>()
    };
    let entries = ids.iter().filter_map(|id| {
        project_paths.get(id).map(|path| (id.clone(), crate::project_icon::find(path)))
    });
    Ok(fit_project_icons(entries))
}

fn activity_at(task: &crate::storage::Session) -> i64 {
    task.last_response_at.into_iter().chain(task.last_prompt_at).max().unwrap_or(task.created_at)
}

/// Fits both arrays, including their object envelope, under the relay's reply budget.
fn fit_task_lists(mut tasks: Vec<Value>, mut projects: Vec<Value>) -> Value {
    fit_list(&mut projects, PAGE_BUDGET);
    let task_budget = PAGE_BUDGET.saturating_sub(json!(projects).to_string().len() + 32);
    fit_list(&mut tasks, task_budget);
    while json!({"tasks": &tasks, "projects": &projects}).to_string().len() > PAGE_BUDGET {
        if tasks.pop().is_none() && projects.pop().is_none() {
            break;
        }
    }
    json!({"tasks": tasks, "projects": projects})
}

/// Keeps the result envelope under the frame budget; known projects without a usable icon stay null.
fn fit_project_icons(icons: impl IntoIterator<Item = (String, Option<String>)>) -> Value {
    let mut result = serde_json::Map::new();
    for (id, icon) in icons {
        if result.contains_key(&id) {
            continue;
        }
        let icon = icon.filter(|icon| icon.len() <= MAX_PROJECT_ICON_BYTES).map(Value::String).unwrap_or(Value::Null);
        result.insert(id.clone(), icon);
        if json!({"icons": &result}).to_string().len() > PAGE_BUDGET {
            result.remove(&id);
            break;
        }
    }
    json!({"icons": result})
}

/// Each subscribed task that exists here: its status as this window shows it, its newest
/// message id (so the viewer pulls what it missed) and its title; then the ids that are
/// not tasks here (deleted, or never were), so the viewer stops waiting on them.
fn subscribed_tasks(state: &AppState, ids: &[String]) -> Result<(Vec<Value>, Vec<Value>)> {
    let (active_runs, pending_by_session) = {
        let agents = state.agents.lock().map_err(|e| e.to_string())?;
        let mut active_runs = HashMap::new();
        let mut pending = HashMap::new();
        for id in ids {
            if let Some(agent) = agents.get(id) {
                active_runs.insert(id.clone(), live_run(agent)?);
                let requests = agent.pending_requests.lock().map_err(|e| e.to_string())?;
                pending.insert(id.clone(), pending_items(&requests));
            }
        }
        (active_runs, pending)
    };
    let store = state.store.lock().map_err(|e| e.to_string())?;
    let teams = observed_team_states(&store.db, &ids.iter().map(String::as_str).collect::<Vec<_>>())?;
    let (mut tasks, mut missing) = (Vec::new(), Vec::new());
    for id in ids {
        let row: Option<(String, String, i64, Option<i64>)> = store
            .db
            .query_row("SELECT status,title,(SELECT COALESCE(MAX(id),0) FROM messages WHERE session_id=?1),last_prompt_at FROM sessions WHERE id=?1 AND remote_device IS NULL", [id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .optional()
            .map_err(|e| e.to_string())?;
        let Some((status, title, last_id, last_prompt_at)) = row else {
            missing.push(json!(id));
            continue;
        };
        let pending = pending_by_session.get(id).cloned().unwrap_or_default();
        let mut task = json!({"sessionId": id, "status": status, "lastId": last_id, "title": title, "pending": pending});
        shape_task_status(&mut task, active_runs.contains_key(id), teams.get(id));
        if let Some(run) = active_runs.get(id) {
            add_live_timing(
                &mut task,
                Some(LiveTiming { run_started_at: last_prompt_at, ..run.timing }),
            );
            task["subagents"] = json!(run.subagents);
            if run.subagents_truncated {
                task["subagentsTruncated"] = json!(true);
            }
        }
        tasks.push(task);
    }
    fit_list(&mut missing, MISSING_BUDGET);
    // Room is left for the gone ids and what `Journal::resume` adds: a `seq` (and maybe
    // `gap`) per task and the replayed events.
    fit_list(&mut tasks, PAGE_BUDGET.saturating_sub(REPLAY_BUDGET + MISSING_BUDGET + 40 * ids.len() + json!({"tasks": [], "missing": [], "epoch": "0".repeat(32)}).to_string().len()));
    Ok((tasks, missing))
}

/// A task whose replay has a gap may have lost its last `subagent` events (a run that ended
/// while the viewer was away has no live snapshot): its saved children go with it, as many
/// tasks as keep the reply within [`PAGE_BUDGET`]. Live runs already carry theirs.
fn add_gap_subagents(mut reply: Value, saved: impl Fn(&str) -> Result<Vec<crate::providers::SubagentActivity>>) -> Value {
    let ids: Vec<String> = reply["tasks"].as_array().map(|tasks| tasks.iter().filter(|task| task["gap"] == true && task.get("subagents").is_none()).filter_map(|task| task["sessionId"].as_str().map(str::to_owned)).collect()).unwrap_or_default();
    let mut size = reply.to_string().len();
    for id in ids {
        let Ok((children, truncated)) = saved(&id).and_then(|children| bounded_subagents(&children, SUBAGENT_SNAPSHOT_BUDGET)) else { continue };
        if children.is_empty() {
            continue;
        }
        let mut extra = json!({"subagents": children});
        if truncated {
            extra["subagentsTruncated"] = json!(true);
        }
        let added = extra.to_string().len();
        if size + added > PAGE_BUDGET {
            break;
        }
        let Some(task) = reply["tasks"].as_array_mut().and_then(|tasks| tasks.iter_mut().find(|task| task["sessionId"] == id.as_str())) else { continue };
        task.as_object_mut().into_iter().for_each(|task| task.extend(extra.as_object().cloned().unwrap_or_default()));
        size += added;
    }
    reply
}

fn subscribe_reply(tasks: Vec<Value>, missing: &[Value], replay: &Resumed) -> Value {
    let mut reply = json!({"tasks": tasks, "missing": missing, "epoch": replay.epoch});
    if replay.more {
        reply["more"] = json!(true);
    }
    reply
}

/// Clones the currently answerable events into a small JSON shape for late subscribers.
fn pending_items(requests: &HashMap<String, AgentEvent>) -> Vec<Value> {
    let mut items: Vec<Value> = requests
        .values()
        .map(|event| {
            let mut item = json!({
                "kind": event.kind,
                "requestId": event.request_id,
                "text": event.text,
                "data": event.data,
            });
            if let Some(tool) = &event.tool {
                item["tool"] = json!(tool);
            }
            shrink(&mut item, MAX_MESSAGE.saturating_sub(1024));
            item
        })
        .collect();
    items.sort_by(|a, b| a["requestId"].as_str().cmp(&b["requestId"].as_str()));
    fit_list(&mut items, MAX_MESSAGE);
    items
}

fn context_attachments(message_id: i64, content: &str) -> Vec<Value> {
    let mut attachments = Vec::new();
    for line in content.lines() {
        let (kind, raw_name) = if let Some(name) = line.strip_prefix("Document context: ") {
            ("document", name)
        } else if let Some(path) = line.strip_prefix("Folder context: ") {
            ("folder", path)
        } else { continue };
        let value = raw_name.split(" (").next().unwrap_or(raw_name).trim();
        if value.is_empty() { continue; }
        let name = if kind == "folder" {
            Path::new(value).file_name().and_then(|part| part.to_str()).unwrap_or(value)
        } else { value };
        let ordinal = attachments.len();
        attachments.push(json!({"id": format!("context-{message_id}-{ordinal}"), "kind": kind, "name": name}));
    }
    attachments
}

fn fit_message(message: &mut Value) {
    if message["role"] != "user" {
        cut(message);
        return;
    }
    while message.to_string().len() > MAX_MESSAGE {
        let Some(content) = message.get("content").and_then(Value::as_str).map(str::to_owned) else { break };
        if content.is_empty() { break; }
        let next = if content.len() <= CUT.len() { String::new() } else { format!("{}{CUT}", head(&content, content.len() / 2)) };
        message["content"] = json!(next);
    }
    while message.to_string().len() > MAX_MESSAGE {
        let Some(items) = message.get_mut("attachments").and_then(Value::as_array_mut) else { break };
        if items.pop().is_none() { break; }
        message["attachmentsTruncated"] = json!(true);
    }
}

fn message_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({"id": row.get::<_, i64>(0)?, "role": row.get::<_, String>(1)?, "content": row.get::<_, String>(2)?, "createdAt": row.get::<_, i64>(3)?, "turnDurationMs": row.get::<_, Option<i64>>(4)?, "attachments": []}))
}

fn message_exists(db: &rusqlite::Connection, session_id: &str, id: i64, older: bool) -> Result<bool> {
    let comparison = if older { "<" } else { ">" };
    db.query_row(
        &format!("SELECT EXISTS(SELECT 1 FROM messages WHERE session_id=?1 AND id{comparison}?2)"),
        rusqlite::params![session_id, id],
        |row| row.get(0),
    )
    .map_err(|e| e.to_string())
}

/// Legacy `afterId` page entrypoint used by mirror copies and tests.
#[cfg(test)]
pub(crate) fn messages_page(db: &rusqlite::Connection, session_id: &str, after_id: i64) -> Result<Value> {
    messages_page_with(db, session_id, MessagePaging::After { after_id, limit: PAGE_ROWS })
}

/// Reads a message page oldest first, cutting individual messages and the page to fit one frame.
/// `hasMore` means newer rows follow the page; `hasOlder` means older rows precede its first id.
#[cfg(test)]
pub(crate) fn messages_page_with(db: &rusqlite::Connection, session_id: &str, page: MessagePaging) -> Result<Value> {
    messages_page_fit(db, session_id, page, PAGE_BUDGET)
}

/// [`messages_page_with`] in `budget` JSON bytes (the newest that fit, for newest-first pages;
/// always at least one message). Over [`PAGE_BUDGET`] the page is for a viewer that opens packed
/// frames, and is cut until it packs into [`PAGE_BUDGET`], so the sealed frame fits the relay.
#[cfg(test)]
pub(crate) fn messages_page_fit(db: &rusqlite::Connection, session_id: &str, page: MessagePaging, budget: usize) -> Result<Value> {
    Ok(fit_page(read_page(db, session_id, page)?, budget))
}

/// A message page's rows and bounds, read in one pass under the store lock; [`fit_page`]
/// fits them to a budget without it.
pub(crate) struct PageRows {
    page: MessagePaging,
    title: String,
    /// The session's lowest and highest message ids.
    first_id: Option<i64>,
    last_id: Option<i64>,
    rows: Vec<Value>,
}

pub(crate) fn read_page(db: &rusqlite::Connection, session_id: &str, page: MessagePaging) -> Result<PageRows> {
    let title: String = db.query_row("SELECT title FROM sessions WHERE id=?1", [session_id], |r| r.get(0)).optional().map_err(|e| e.to_string())?.ok_or("Conversation not found.")?;
    let (first_id, last_id): (Option<i64>, Option<i64>) = db
        .query_row("SELECT MIN(id),MAX(id) FROM messages WHERE session_id=?1", [session_id], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(|e| e.to_string())?;
    let mut statement = match page {
        MessagePaging::After { .. } => db.prepare("SELECT id,role,content,created_at,turn_duration_ms FROM messages WHERE session_id=?1 AND id>?2 ORDER BY id LIMIT ?3"),
        MessagePaging::Tail { .. } => db.prepare("SELECT id,role,content,created_at,turn_duration_ms FROM messages WHERE session_id=?1 ORDER BY id DESC LIMIT ?2"),
        MessagePaging::Before { .. } => db.prepare("SELECT id,role,content,created_at,turn_duration_ms FROM messages WHERE session_id=?1 AND id<?2 ORDER BY id DESC LIMIT ?3"),
    }
    .map_err(|e| e.to_string())?;
    let mapped = match page {
        MessagePaging::After { after_id, limit } => statement.query_map(rusqlite::params![session_id, after_id, limit], message_row),
        MessagePaging::Tail { limit } => statement.query_map(rusqlite::params![session_id, limit], message_row),
        MessagePaging::Before { before_id, limit } => statement.query_map(rusqlite::params![session_id, before_id, limit], message_row),
    }
    .map_err(|e| e.to_string())?;
    let mut rows: Vec<Value> = mapped.collect::<rusqlite::Result<_>>().map_err(|e| e.to_string())?;
    let mut attachments = page_attachments(db, session_id, &rows)?;
    for message in &mut rows {
        let message_id = message["id"].as_i64().unwrap_or_default();
        let mut list = attachments.remove(&message_id).unwrap_or_default();
        if message["role"] == "user" {
            list.extend(context_attachments(message_id, message["content"].as_str().unwrap_or_default()));
        }
        message["attachments"] = json!(list);
    }
    Ok(PageRows { page, title, first_id, last_id, rows })
}

/// The page's image attachments by message id, in one query over the page's id range.
fn page_attachments(db: &rusqlite::Connection, session_id: &str, rows: &[Value]) -> Result<HashMap<i64, Vec<Value>>> {
    let ids = rows.iter().filter_map(|row| row["id"].as_i64());
    let (Some(low), Some(high)) = (ids.clone().min(), ids.max()) else { return Ok(HashMap::new()) };
    let table: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='message_attachments')", [], |row| row.get(0)).map_err(|e| e.to_string())?;
    let mut by_message: HashMap<i64, Vec<Value>> = HashMap::new();
    if !table {
        return Ok(by_message);
    }
    // The same rows and shape as attachments::message_attachment_rows, for every message at once.
    let mut statement = db
        .prepare("SELECT message_id,id,kind,name,mime,bytes,width,height FROM message_attachments WHERE session_id=?1 AND message_id BETWEEN ?2 AND ?3 ORDER BY message_id,rowid")
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map(rusqlite::params![session_id, low, high], |row| {
            Ok((row.get::<_, i64>(0)?, json!({
                "id": row.get::<_, String>(1)?, "kind": row.get::<_, String>(2)?, "name": row.get::<_, String>(3)?,
                "mime": row.get::<_, String>(4)?, "bytes": row.get::<_, i64>(5)?,
                "width": row.get::<_, Option<u32>>(6)?, "height": row.get::<_, Option<u32>>(7)?
            })))
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (message, attachment) = row.map_err(|e| e.to_string())?;
        by_message.entry(message).or_default().push(attachment);
    }
    Ok(by_message)
}

/// Fits read rows to `budget`. Each message is cut and measured once; a packed page is packed at
/// the socket's level and, when too big, refitted once by the ratio seen, else held to
/// [`PAGE_BUDGET`] plain, which always fits a frame.
pub(crate) fn fit_page(rows: PageRows, budget: usize) -> Value {
    let messages: Vec<(Value, usize)> = rows
        .rows
        .iter()
        .map(|message| {
            let mut message = message.clone();
            if message.to_string().len() > MAX_MESSAGE {
                fit_message(&mut message);
            }
            let size = message.to_string().len();
            (message, size)
        })
        .collect();
    let page = fit_page_in(&rows, &messages, budget);
    if budget <= PAGE_BUDGET {
        return page;
    }
    let plain = page.to_string().len();
    let packed = packed_len(&page);
    if packed <= PAGE_BUDGET {
        return page;
    }
    let scaled = (plain as u128 * PAGE_BUDGET as u128 * 9 / (10 * packed as u128)) as usize;
    if scaled > PAGE_BUDGET {
        let page = fit_page_in(&rows, &messages, scaled);
        if packed_len(&page) <= PAGE_BUDGET {
            return page;
        }
    }
    fit_page_in(&rows, &messages, PAGE_BUDGET)
}

/// The packed size of `value` as the socket sends it (`crypto::pack`, level 6), without keeping
/// the output. Fast deflate packs worse, so sizing by it left pages near 60 % of a frame.
fn packed_len(value: &Value) -> usize {
    use std::io::Write;
    let mut out = flate2::write::DeflateEncoder::new(std::io::sink(), flate2::Compression::new(6));
    let _ = serde_json::to_writer(&mut out, value);
    let _ = out.flush();
    out.total_out() as usize + 1
}

fn fit_page_in(rows: &PageRows, messages: &[(Value, usize)], budget: usize) -> Value {
    let PageRows { page, title, first_id, last_id, .. } = rows;
    let mut room = budget.saturating_sub(json!({"messages": [], "hasMore": false, "hasOlder": false, "title": title, "lastId": last_id}).to_string().len());
    let mut kept = Vec::new();
    for (message, size) in messages {
        if size + 1 > room {
            if kept.is_empty() {
                // A small page stays small: its one message is cut to the budget and marked, and
                // viewers fetch it whole later (afterId id-1). Full pages never get here.
                let mut message = message.clone();
                cut_to(&mut message, room.saturating_sub(r#","cut":true"#.len() + 1));
                message["cut"] = json!(true);
                kept.push(message);
            }
            break;
        }
        room -= size + 1;
        kept.push(message.clone());
    }
    if matches!(page, MessagePaging::Tail { .. } | MessagePaging::Before { .. }) {
        kept.reverse();
    }
    let page_first = kept.first().and_then(|message| message["id"].as_i64());
    let page_last = kept.last().and_then(|message| message["id"].as_i64());
    // Ids only grow, so older (newer) rows exist exactly when the session's lowest (highest) id is past the page's.
    let has_older = matches!((first_id, page_first), (Some(low), Some(id)) if *low < id);
    let has_more = match *page {
        MessagePaging::After { limit, .. } => kept.len() < rows.rows.len() || rows.rows.len() as i64 == limit,
        MessagePaging::Tail { .. } => false,
        MessagePaging::Before { .. } => matches!((last_id, page_last), (Some(high), Some(id)) if *high > id),
    };
    json!({"messages": kept, "hasMore": has_more, "hasOlder": has_older, "title": title, "lastId": last_id})
}

/// Drops the tail of a list until its JSON fits `budget`.
pub(crate) fn fit_list(list: &mut Vec<Value>, budget: usize) {
    let mut size = 2;
    let keep = list.iter().take_while(|item| {
        size += item.to_string().len() + 1;
        size <= budget
    }).count();
    list.truncate(keep);
}

/// Trims the longest model lists until the provider list fits one reply.
pub(crate) fn fit_providers(providers: &mut Value) {
    while providers.to_string().len() > PAGE_BUDGET {
        let Some(models) = providers.as_array_mut().and_then(|list| list.iter_mut().filter_map(|p| p["models"].as_array_mut()).max_by_key(|models| models.len())).filter(|models| !models.is_empty()) else { return };
        let keep = models.len() / 2;
        models.truncate(keep);
    }
}

/// Appends an event to a subscriber's buffer, joining consecutive text deltas. A joined
/// delta takes the newest `seq`, so a viewer's position still covers all of its text.
pub(crate) fn push_event(events: &mut Vec<Value>, event: Value) {
    if event["kind"] == "text" {
        if let Some(last) = events.last_mut().filter(|last| last["kind"] == "text" && last["sessionId"] == event["sessionId"] && last["data"] == event["data"] && last["requestId"] == event["requestId"]) {
            let joined = format!("{}{}", last["text"].as_str().unwrap_or_default(), event["text"].as_str().unwrap_or_default());
            last["text"] = json!(joined);
            if let Some(seq) = event.get("seq") {
                last["seq"] = seq.clone();
            }
            return;
        }
    }
    if events.len() < MAX_BUFFER {
        events.push(event);
    } else if !events.last().is_some_and(lagged) {
        events.push(json!({LAGGED: true}));
    }
}

/// The marker a full subscriber buffer ends with.
fn lagged(event: &Value) -> bool {
    event[LAGGED] == true
}

/// Events grouped into frames that each fit the budget; an oversized event is cut.
pub(crate) fn frames(events: Vec<Value>) -> Vec<Vec<Value>> {
    let mut frames = Vec::new();
    let (mut frame, mut size) = (Vec::new(), 0);
    for mut event in events {
        if event.to_string().len() > MAX_MESSAGE {
            shrink(&mut event, MAX_MESSAGE);
        }
        let length = event.to_string().len() + 1;
        if size + length > PAGE_BUDGET && !frame.is_empty() {
            frames.push(std::mem::take(&mut frame));
            size = 0;
        }
        size += length;
        frame.push(event);
    }
    if !frame.is_empty() {
        frames.push(frame);
    }
    frames
}

/// Adds a task to a device's subscription, starting one if it has none.
pub(crate) fn follow(app: &tauri::AppHandle, device: &str, session_id: &str) {
    let state = remote(app);
    let mut inner = state.lock();
    let subscriber = inner.subscribers.entry(device.to_owned()).or_default();
    if subscriber.until.is_none_or(|until| until <= Instant::now()) {
        subscriber.until = Some(Instant::now() + SUBSCRIPTION);
    }
    subscriber.sessions.insert(session_id.to_owned());
    inner.journal.watch(session_id);
}

/// Drops expired subscribers and devices no longer in presence; true if any remain.
fn prune_subscribers(inner: &mut super::Inner, now: Instant) -> bool {
    let super::Inner { subscribers, devices, .. } = inner;
    let before = subscribers.len();
    subscribers.retain(|id, subscriber| subscriber.until.is_some_and(|until| until > now) && devices.iter().any(|d| &d.id == id));
    if inner.subscribers.len() < before {
        forget_unfollowed_teams(inner);
    }
    !inner.subscribers.is_empty()
}

/// Numbers an event, keeps it for viewers that come back, and queues it for every device
/// mirroring its task. Called on the agent-event hot path: nothing is cloned unless
/// someone follows (or followed) this task.
pub(crate) fn agent_event(app: &tauri::AppHandle, event: &AgentEvent) {
    let Some(state) = app.try_state::<super::Remote>() else { return };
    let delay = {
        let mut inner = state.lock();
        if followed(&inner, &event.session_id).is_none() {
            return;
        }
        let Ok(value) = serde_json::to_value(event) else { return };
        journal_and_enqueue(&mut inner, &event.session_id, value, Queue::Event)
    };
    if let Some(delay) = delay {
        tauri::async_runtime::spawn(flush(app.clone(), delay));
    }
    if matches!(event.kind.as_str(), "approval" | "input_request") && wants_notify(app) {
        let _ = super::socket::relay(app, notify_frame("waiting", 1));
    }
}

/// Queues `run.finished` for every device mirroring the task.
pub(crate) fn run_finished(app: &tauri::AppHandle, session_id: &str, successful: bool, stopped: bool, text: &str) {
    journaled(app, session_id, json!({"sessionId": session_id, "successful": successful, "stopped": stopped, "text": text}), Queue::Finished);
    if wants_notify(app) {
        let _ = super::socket::relay(app, notify_frame("finished", 1));
    }
}

/// The relay frame that becomes a phone push; the relay's bridge coalesces bursts and keeps
/// payloads generic (counts only, no session ids or text).
pub(crate) fn notify_frame(kind: &str, count: u32) -> String {
    json!({"kind": "notify", "body": {"kind": kind, "count": count}}).to_string()
}

/// Whether this computer should push about the notice just emitted: the setting is on and the
/// relay socket is up. Checked before the frame is queued; the relay does the rest.
fn wants_notify(app: &tauri::AppHandle) -> bool {
    app.try_state::<super::Remote>().is_some_and(|state| {
        let inner = state.lock();
        inner.settings.notify_enabled && inner.connected
    })
}

/// How a numbered entry is queued: as an agent event, as a run end, or as the run end of a
/// team that settled (skipped while a run end for the task still waits to be sent).
#[derive(Clone, Copy, PartialEq)]
enum Queue {
    Event,
    Finished,
    Settled,
}

/// Whether anyone follows (or followed) the task: Some(subscribed now).
fn followed(inner: &super::Inner, session_id: &str) -> Option<bool> {
    let subscribed = inner.subscribers.values().any(|s| s.sessions.contains(session_id));
    (inner.settings.host_enabled && (subscribed || inner.journal.rings.contains_key(session_id))).then_some(subscribed)
}

/// Numbers, keeps and queues a team update or run end, like an agent event, so a viewer
/// that comes back gets it in its replay too.
fn journaled(app: &tauri::AppHandle, session_id: &str, value: Value, queue: Queue) {
    let Some(state) = app.try_state::<super::Remote>() else { return };
    let (delay, sweep) = {
        let mut inner = state.lock();
        let delay = journal_and_enqueue(&mut inner, session_id, value, queue);
        (delay, inner.journal.arm(Instant::now()))
    };
    if let Some(delay) = delay {
        tauri::async_runtime::spawn(flush(app.clone(), delay));
    }
    if let Some(sweep) = sweep {
        tauri::async_runtime::spawn(sweep_later(app.clone(), sweep));
    }
}

/// Sweeps the journal when its first finished ring goes idle, so an idle host does not keep
/// rings after the last run ends; one task, re-armed only while finished rings remain.
async fn sweep_later(app: tauri::AppHandle, mut delay: Duration) {
    loop {
        tokio::time::sleep(delay).await;
        let Some(state) = app.try_state::<super::Remote>() else { return };
        let Some(next) = state.lock().journal.fire(Instant::now()) else { return };
        delay = next;
    }
}

/// Run ends are journaled as `kind: "run.finished"` entries carrying the frame's fields; the
/// live `run.finished` frame carries the same object, `seq` included.
fn journal_and_enqueue(inner: &mut super::Inner, session_id: &str, mut value: Value, queue: Queue) -> Option<Duration> {
    let subscribed = followed(inner, session_id)?;
    if queue == Queue::Settled && inner.subscribers.values().any(|s| s.finished.iter().any(|item| item["sessionId"] == session_id)) {
        return None;
    }
    if queue != Queue::Event {
        value["kind"] = json!("run.finished");
    }
    let value = inner.journal.record(session_id, value, subscribed)?;
    enqueue(inner, session_id, |subscriber| match queue {
        Queue::Event => push_event(&mut subscriber.events, value.clone()),
        Queue::Finished | Queue::Settled => subscriber.finished.push(value.clone()),
    })
}

/// Adds to the buffers of the task's subscribers; the delay of a flush to schedule, if none is.
fn enqueue(inner: &mut super::Inner, session_id: &str, mut add: impl FnMut(&mut Subscriber)) -> Option<Duration> {
    if !inner.settings.host_enabled || inner.outbox.is_none() || !inner.subscribers.values().any(|s| s.sessions.contains(session_id)) {
        return None;
    }
    if !prune_subscribers(inner, Instant::now()) {
        return None;
    }
    for subscriber in inner.subscribers.values_mut().filter(|s| s.sessions.contains(session_id)) {
        add(subscriber);
    }
    if std::mem::replace(&mut inner.flushing, true) {
        return None;
    }
    let delay = flush_delay(inner.flushed_at, inner.flush_frames, Instant::now());
    if delay.is_zero() {
        inner.flush_frames = 0;
    }
    Some(delay)
}

/// The first event after a quiet spell goes at once (a turn's first delta shows without
/// waiting); events right behind it wait out the rest of [`FLUSH`] since `last`, and once a
/// burst has sent `frames` frames, of [`SUSTAINED`]. `last` is when the last flush's frames
/// are paid for ([`paid_until`]), so several viewers share the relay's frames/s.
pub(crate) fn flush_delay(last: Option<Instant>, frames: u32, now: Instant) -> Duration {
    match last {
        Some(at) if now < at + SUSTAINED => (at + if frames < BURST_FRAMES { FLUSH } else { SUSTAINED }).saturating_duration_since(now),
        _ => Duration::ZERO,
    }
}

/// When a flush that sent `sent` frames at `now` is paid for: past the burst every frame
/// after the first takes [`SUSTAINED`] of the socket's budget.
pub(crate) fn paid_until(now: Instant, frames: u32, sent: u32) -> Instant {
    if frames < BURST_FRAMES { now } else { now + SUSTAINED * sent.saturating_sub(1) }
}

/// Sends each subscriber one `agent.events` frame (more only past the frame budget),
/// then its `run.finished` events, so a run's last deltas always arrive before its end.
async fn flush(app: tauri::AppHandle, delay: Duration) {
    if !delay.is_zero() {
        tokio::time::sleep(delay).await;
    }
    #[allow(clippy::type_complexity)]
    let (epoch, batches, started, counted): (String, Vec<(String, Vec<Value>, Vec<Value>)>, Instant, u32) = {
        let state = remote(&app);
        let mut inner = state.lock();
        inner.flushing = false;
        let hosting = inner.settings.host_enabled;
        let batches: Vec<_> = inner.subscribers.iter_mut().filter(|_| hosting).map(|(id, s)| (id.clone(), std::mem::take(&mut s.events), std::mem::take(&mut s.finished))).filter(|(_, events, finished)| !events.is_empty() || !finished.is_empty()).collect();
        // Paced by the frames this flush sends (one per viewer at least), not by flushes;
        // a frame split for size is added once sent.
        let counted = batches.iter().map(|(_, events, finished)| u32::from(!events.is_empty()) + finished.len() as u32).sum::<u32>().max(1);
        let now = Instant::now();
        inner.flush_frames = inner.flush_frames.saturating_add(counted);
        inner.flushed_at = Some(paid_until(now, inner.flush_frames, counted));
        (inner.journal.epoch.clone(), batches, now, counted)
    };
    let mut sent = 0u32;
    // Read after the run end has settled its team (architect::completed follows it), so a
    // team whose workers carry on reports the run's task as still running.
    let ids: Vec<String> = batches.iter().flat_map(|(_, _, finished)| finished.iter().filter(|data| data.get("team").is_none()).filter_map(|data| data["sessionId"].as_str().map(str::to_owned))).collect::<HashSet<_>>().into_iter().collect();
    let teams = if ids.is_empty() {
        HashMap::new()
    } else {
        let handle = app.clone();
        crate::blocking(move || {
            let state = handle.state::<AppState>();
            let store = state.store.lock().map_err(|e| e.to_string())?;
            observed_team_states(&store.db, &ids.iter().map(String::as_str).collect::<Vec<_>>())
        })
        .await
        .unwrap_or_default()
    };
    let mut amended = HashMap::new();
    for (device, mut events, mut finished) in batches {
        for data in finished.iter_mut().filter(|data| data.get("team").is_none()) {
            let team = data["sessionId"].as_str().and_then(|id| teams.get(id));
            shape_finished(data, team);
            if let (Some(seq), Some(id)) = (data["seq"].as_u64(), data["sessionId"].as_str()) {
                amended.insert(seq, (id.to_owned(), data.clone()));
            }
        }
        let behind = events.last().is_some_and(lagged);
        if behind {
            events.pop();
            super::diagnostics::record("subscriber.lagged", format!("{device}: over {MAX_BUFFER} buffered events"));
        }
        for frame in lagged_frames(frames(events), behind, &epoch) {
            sent += 1;
            let _ = socket::send_to_device(&app, &device, &json!({"type": "event", "name": "agent.events", "data": frame}));
        }
        for data in finished {
            sent += 1;
            let _ = socket::send_to_device(&app, &device, &json!({"type": "event", "name": "run.finished", "data": data}));
        }
    }
    if sent > counted || !amended.is_empty() {
        let state = remote(&app);
        let mut inner = state.lock();
        if sent > counted {
            inner.flush_frames = inner.flush_frames.saturating_add(sent - counted);
            let paid = paid_until(started, inner.flush_frames, sent);
            inner.flushed_at = inner.flushed_at.max(Some(paid));
        }
        for (seq, (id, data)) in amended {
            inner.journal.amend(&id, seq, data);
        }
    }
}

/// `agent.events` frame data; after a buffer overflowed, the last frame says `lagged`, so
/// the viewer subscribes again from its position at once and the journal fills the rest.
fn lagged_frames(frames: Vec<Vec<Value>>, lagged: bool, epoch: &str) -> Vec<Value> {
    let mut out: Vec<Value> = frames.into_iter().map(|events| json!({"events": events, "epoch": epoch})).collect();
    if lagged {
        if out.is_empty() {
            out.push(json!({"events": [], "epoch": epoch}));
        }
        out.last_mut().unwrap()[LAGGED] = json!(true);
    }
    out
}

fn head(text: &str, max: usize) -> &str {
    let mut end = text.len().min(max);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

fn longest_string(value: &mut Value) -> Option<&mut String> {
    match value {
        Value::String(text) => Some(text),
        Value::Array(items) => items.iter_mut().filter_map(longest_string).max_by_key(|text| text.len()),
        Value::Object(map) => map.values_mut().filter_map(longest_string).max_by_key(|text| text.len()),
        _ => None,
    }
}

/// Halves the longest string in `value`, marking the cut, until it serializes under `max`.
fn shrink(value: &mut Value, max: usize) {
    while value.to_string().len() > max {
        let Some(longest) = longest_string(value).filter(|text| text.len() > 2 * CUT.len()) else { return };
        *longest = format!("{}{CUT}", head(longest, longest.len() / 2));
    }
}

/// Cuts one oversized message. JSON content (tool calls) is cut inside, so it still parses.
fn cut(message: &mut Value) {
    cut_to(message, MAX_MESSAGE);
}

fn cut_to(message: &mut Value, max: usize) {
    if message.to_string().len() <= max {
        return;
    }
    let parsed = message["content"].as_str().and_then(|content| serde_json::from_str::<Value>(content).ok()).filter(Value::is_object);
    if let Some(mut content) = parsed {
        shrink(&mut content, max * 3 / 4);
        message["content"] = json!(content.to_string());
    }
    shrink(message, max);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn worker_fixture(id: &str, status: &str) -> crate::architect::Worker {
        crate::architect::Worker {
            id: id.into(),
            session_id: format!("session-{id}"),
            name: format!("Worker {id}"),
            profile_id: "profile".into(),
            provider: "codex".into(),
            model: "test-model".into(),
            reasoning_effort: None,
            status: status.into(),
            assignment: "Inspect the implementation".into(),
            summary: "Worker summary".into(),
            error: None,
            depends_on: vec!["prior".into()],
            files: vec!["src/main.rs".into()],
            read_only: false,
            attempt: 2,
            created_at: 100,
            updated_at: 200,
            keys: vec![],
            abandoned: false,
            result_revision: 1,
            checkpoint: Some(crate::architect::coordination::WorkerCheckpoint {
                summary: "Checkpoint summary".into(),
                next_steps: "Checkpoint next".into(),
                blocker: None,
                updated_at: 150,
            }),
            timed_out: false,
            failovers: 0,
            parent_worker: None,
            resume_prompt: None,
            tool_catalog_version: 0,
        }
    }

    fn team_fixture(workers: Vec<crate::architect::Worker>) -> crate::architect::TeamSnapshot {
        crate::architect::TeamSnapshot {
            session_id: "team-session".into(),
            tool_catalog_version: 0,
            config: crate::architect::TeamConfig {
                auto: true,
                roster_only: false,
                name: None,
                workers: vec![],
                catalog: vec![],
                max_parallel: 0,
                max_rounds: 8,
                max_assignments: 50,
                workspace: "shared".into(),
                summary_limit: 2000,
                lead_guidance: None,
            },
            status: "running".into(),
            round: 3,
            revision: 9,
            workers,
            error: None,
            summary: Some("Team summary".into()),
            updated_at: 300,
            generation: 1,
            objective: "Objective".into(),
            reviewed_revision: 0,
            dispatch_revision: 1,
            pending_turn: None,
            pending_setup: None,
            coordination_revision: 0,
            reviewed_coordination_revision: 0,
            legacy_prompt_through_id: Some(0),
            continued_revision: None,
            last_turn_kind: None,
            objective_start: 0,
            timed_out: false,
            briefings: Default::default(),
        }
    }

    fn subagent(id: &str, response: &str) -> crate::providers::SubagentActivity {
        crate::providers::SubagentActivity {
            id: id.into(),
            parent_id: None,
            name: "Reviewer".into(),
            prompt: "Inspect the change".into(),
            status: "running".into(),
            response: response.into(),
            tools: Vec::new(),
            started_at: 1_700_000_000_000,
            updated_at: 1_700_000_000_500,
        }
    }

    #[test]
    fn team_snapshot_and_worker_event_keep_the_phone_shape() {
        let team = team_fixture(vec![worker_fixture("w1", "waiting")]);
        let worker = remote_worker(&team.workers[0]);
        let mut parked = worker_fixture("s1", "parked");
        parked.parent_worker = Some("w1".into());
        let parked = remote_worker(&parked);
        assert_eq!((parked["status"].as_str(), parked["parentWorker"].as_str()), (Some("parked"), Some("w1")));
        let mut previous = HashMap::new();
        assert_eq!(changed_worker_rows(&team, &mut previous), std::slice::from_ref(&worker));
        assert!(
            changed_worker_rows(&team, &mut previous).is_empty(),
            "unchanged rows are not resent"
        );

        let snapshot = remote_team(&team, vec![worker.clone()]);
        assert_eq!(snapshot["sessionId"], "team-session");
        assert_eq!(snapshot["mode"], "auto");
        assert_eq!(snapshot["rounds"], json!({"used": 3, "max": 8}));
        assert_eq!(
            snapshot["workers"][0]["status"], "running",
            "desktop waiting is represented as a running phone worker"
        );
        assert_eq!(snapshot["workers"][0]["startedAt"], 100);
        assert_eq!(snapshot["workers"][0]["sessionId"], "session-w1");
        assert_eq!(
            snapshot["workers"][0]["checkpoint"],
            json!({"summary":"Checkpoint summary","nextSteps":"Checkpoint next","blocker":null,"updatedAt":150})
        );

        let event = team_event_value("team-session", worker);
        assert_eq!(event["sessionId"], "team-session");
        assert_eq!(event["kind"], "team");
        assert_eq!(event["data"]["id"], "w1");
        assert_eq!(event["data"]["sessionId"], "session-w1");
    }

    #[test]
    fn gap_tasks_get_their_saved_subagents_within_budget() {
        let reply = json!({"tasks": [
            {"sessionId": "ended", "gap": true},
            {"sessionId": "live", "gap": true, "subagents": []},
            {"sessionId": "caught-up"},
            {"sessionId": "none", "gap": true},
        ]});
        let saved = |id: &str| Ok(if id == "none" { vec![] } else { vec![subagent(&format!("{id}:a"), "done")] });
        let out = add_gap_subagents(reply.clone(), saved);
        assert_eq!(out["tasks"][0]["subagents"][0]["id"], "ended:a", "an ended run's children come back");
        assert_eq!(out["tasks"][1]["subagents"], json!([]), "a live snapshot is kept");
        assert!(out["tasks"][2].get("subagents").is_none() && out["tasks"][3].get("subagents").is_none());
        let full = json!({"tasks": [{"sessionId": "ended", "gap": true, "title": "x".repeat(PAGE_BUDGET)}]});
        assert!(add_gap_subagents(full, saved)["tasks"][0].get("subagents").is_none(), "never past the budget");
    }

    #[test]
    fn worker_transcripts_page_from_the_tail_and_back() {
        let store = crate::storage::Store::open(std::path::Path::new(":memory:")).unwrap();
        let project = store.add_project(&std::env::temp_dir()).unwrap();
        let parent = store.create_session(&project.id, "claude", "sonnet", "full").unwrap();
        let child = store.create_session(&project.id, "codex", "gpt", "full").unwrap();
        let mut team = team_fixture(vec![worker_fixture("w1", "running")]);
        team.session_id = parent.id.clone();
        team.workers[0].session_id = child.id.clone();
        store.db.execute("INSERT INTO architect_teams(session_id,content) VALUES(?1,?2)", rusqlite::params![parent.id, serde_json::to_string(&team).unwrap()]).unwrap();
        for index in 0..5 {
            store.message(&child.id, if index % 2 == 0 { "user" } else { "assistant" }, &format!("m{index}")).unwrap();
        }
        let texts = |page: &Value| page["messages"].as_array().unwrap().iter().map(|m| m["content"].as_str().unwrap().to_owned()).collect::<Vec<_>>();
        let tail = worker_messages(&store, &parent.id, "w1", 0, Some(i64::MAX), 2).unwrap();
        assert_eq!(texts(&tail), ["m3", "m4"], "the newest, in order");
        assert_eq!((tail["hasOlder"].as_bool(), tail["hasMore"].as_bool(), tail["tail"].as_bool()), (Some(true), Some(false), Some(true)));
        let first = tail["messages"][0]["id"].as_i64().unwrap();
        let older = worker_messages(&store, &parent.id, "w1", 0, Some(first), 2).unwrap();
        assert_eq!(texts(&older), ["m1", "m2"]);
        assert_eq!((older["hasOlder"].as_bool(), older["hasMore"].as_bool()), (Some(true), Some(true)));
        let forward = worker_messages(&store, &parent.id, "w1", 0, None, 2).unwrap();
        assert_eq!(texts(&forward), ["m0", "m1"]);
        assert!(forward.get("tail").is_none(), "forward pages read as before");
    }

    /// Host and viewer together: a worker transcript too big for one page loads from the
    /// tail back to its first message, each message once and in order, never merging newer
    /// history into an older page.
    #[test]
    fn a_long_worker_transcript_pages_back_to_its_first_message() {
        let store = crate::storage::Store::open(std::path::Path::new(":memory:")).unwrap();
        let project = store.add_project(&std::env::temp_dir()).unwrap();
        let parent = store.create_session(&project.id, "claude", "sonnet", "full").unwrap();
        let child = store.create_session(&project.id, "codex", "gpt", "full").unwrap();
        let mut team = team_fixture(vec![worker_fixture("w1", "completed")]);
        team.session_id = parent.id.clone();
        team.workers[0].session_id = child.id.clone();
        store.db.execute("INSERT INTO architect_teams(session_id,content) VALUES(?1,?2)", rusqlite::params![parent.id, serde_json::to_string(&team).unwrap()]).unwrap();
        // 30 messages of 20 KiB: about three host pages each way.
        let written: Vec<String> = (0..30).map(|index| format!("m{index:02} {}", "x".repeat(20 * 1024))).collect();
        for (index, text) in written.iter().enumerate() {
            store.message(&child.id, if index % 2 == 0 { "user" } else { "assistant" }, text).unwrap();
        }
        let store = StdMutex::new(store);
        let ask = |key: &str, value: Value| {
            let mut params = json!({"sessionId": parent.id, "workerId": "w1"});
            params[key] = value;
            let reply = match parse(true, "task.workerMessages", &params).unwrap() {
                Call::WorkerMessages { session_id, worker_id, after_id, before_id, limit } => worker_messages(&store.lock().unwrap(), &session_id, &worker_id, after_id, before_id, limit),
                _ => unreachable!(),
            };
            std::future::ready(reply)
        };
        let page = |before: Option<i64>| tauri::async_runtime::block_on(super::super::mirror::worker_pages(ask, before)).unwrap();
        let ids = |page: &Value| page["messages"].as_array().unwrap().iter().map(|m| m["id"].as_i64().unwrap()).collect::<Vec<_>>();
        let mut loaded = page(None);
        assert!(loaded["hasOlder"] == true && ids(&loaded).len() < 30, "the tail page was cut: {}", ids(&loaded).len());
        let mut seen = loaded["messages"].as_array().unwrap().clone();
        let mut pages = 1;
        while loaded["hasOlder"] == true {
            let first = seen[0]["id"].as_i64().unwrap();
            loaded = page(Some(first));
            let older = ids(&loaded);
            assert!(!older.is_empty() && older.iter().all(|id| *id < first), "an older page holds only older rows: {older:?} before {first}");
            seen = [loaded["messages"].as_array().unwrap().clone(), seen].concat();
            pages += 1;
            assert!(pages < 30);
        }
        assert!(pages >= 3, "{pages}");
        let texts: Vec<&str> = seen.iter().map(|m| m["content"].as_str().unwrap()).collect();
        assert_eq!(texts, written.iter().map(String::as_str).collect::<Vec<_>>());
    }

    fn team_state(status: &str, active_workers: i64, revision: u64) -> TeamState {
        TeamState { status: status.into(), active_workers, revision }
    }

    #[test]
    fn team_states_count_unsettled_workers_in_one_query() {
        let mut team = team_fixture(vec![worker_fixture("w1", "running"), worker_fixture("w2", "queued"), worker_fixture("w3", "completed"), worker_fixture("w4", "waiting")]);
        team.workers[3].abandoned = true;
        team.status = "waiting".into();
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute("CREATE TABLE architect_teams(session_id TEXT PRIMARY KEY, content TEXT NOT NULL)", []).unwrap();
        db.execute("INSERT INTO architect_teams VALUES(?1,?2)", rusqlite::params![team.session_id, serde_json::to_string(&team).unwrap()]).unwrap();
        let states = team_states(&db, &["team-session", "plain-task"]).unwrap();
        assert_eq!(states.len(), 1, "only architect parents get a team");
        assert_eq!(states["team-session"], team_state("waiting", 2, 9));
        assert_eq!(states["team-session"], TeamState::of(&team), "SQL and snapshot agree");
        assert!(team_states(&db, &[]).unwrap().is_empty());
    }

    #[test]
    fn an_active_team_keeps_its_task_running() {
        for (saved, has_agent) in [("completed", false), ("idle", false), ("running", false), ("waiting", false), ("running", true)] {
            let mut row = json!({"sessionId": "team-session", "status": saved});
            shape_task_status(&mut row, has_agent, Some(&team_state("waiting", 2, 1)));
            assert_eq!(row["status"], "running", "{saved} with agent {has_agent}");
            assert_eq!(row["team"], json!({"status": "waiting", "activeWorkers": 2}));
        }
        let mut row = json!({"status": "waiting"});
        shape_task_status(&mut row, true, Some(&team_state("running", 1, 1)));
        assert_eq!(row["status"], "waiting", "an architect asking for input still needs the user");
    }

    #[test]
    fn a_settled_team_leaves_the_status_unchanged() {
        for team in ["paused", "failed", "completed", "ready"] {
            let mut row = json!({"status": "completed"});
            shape_task_status(&mut row, false, Some(&team_state(team, 0, 1)));
            assert_eq!(row["status"], "completed");
            assert_eq!(row["team"], json!({"status": team, "activeWorkers": 0}));
            let mut row = json!({"status": "running"});
            shape_task_status(&mut row, false, Some(&team_state(team, 0, 1)));
            assert_eq!(row["status"], "interrupted");
        }
        let mut row = json!({"status": "running"});
        shape_task_status(&mut row, false, None);
        assert_eq!(row, json!({"status": "interrupted"}), "plain tasks get no team");
        let mut row = json!({"status": "waiting"});
        shape_task_status(&mut row, true, None);
        assert_eq!(row["status"], "waiting");
    }

    #[test]
    fn notify_frames_carry_only_the_kind_and_count() {
        let frame: Value = serde_json::from_str(&notify_frame("waiting", 2)).unwrap();
        assert_eq!(frame, json!({"kind": "notify", "body": {"kind": "waiting", "count": 2}}));
    }

    #[test]
    fn run_finished_carries_the_team_and_settles_once_it_stops() {
        let mut data = json!({"sessionId": "team-session", "successful": true, "stopped": false, "text": "Turn complete"});
        shape_finished(&mut data, Some(&team_state("waiting", 3, 4)));
        assert_eq!(data["status"], "running");
        assert_eq!(data["team"], json!({"status": "waiting", "activeWorkers": 3}));

        let mut data = json!({"sessionId": "s", "successful": false, "stopped": true, "text": "Turn stopped"});
        shape_finished(&mut data, Some(&team_state("paused", 0, 5)));
        assert!(data.get("status").is_none(), "a settled team keeps the old payload");
        assert_eq!(data["team"]["status"], "paused");
        let mut plain = json!({"sessionId": "s", "successful": true, "stopped": false, "text": "Turn complete"});
        shape_finished(&mut plain, None);
        assert_eq!(plain, json!({"sessionId": "s", "successful": true, "stopped": false, "text": "Turn complete"}));

        let mut cache = HashMap::new();
        assert_eq!(observe_team(&mut cache, "t", team_state("paused", 0, 1)), (team_state("paused", 0, 1), false), "nothing was reported active");
        assert!(!observe_team(&mut cache, "t", team_state("running", 1, 2)).1);
        assert!(!observe_team(&mut cache, "t", team_state("waiting", 1, 3)).1);
        assert_eq!(observe_team(&mut cache, "t", team_state("running", 1, 2)), (team_state("waiting", 1, 3), false), "an older read never wins");
        assert!(observe_team(&mut cache, "t", team_state("completed", 0, 4)).1);
        assert!(!observe_team(&mut cache, "t", team_state("completed", 0, 5)).1, "settles once");

        let settled = settled_finished("t", "completed", &team_state("completed", 0, 4));
        assert_eq!(settled, json!({"sessionId": "t", "successful": true, "stopped": false, "text": "Team completed", "status": "completed", "teamSettled": true, "team": {"status": "completed", "activeWorkers": 0}}));
        let paused = settled_finished("t", "running", &team_state("paused", 0, 6));
        assert_eq!((paused["status"].as_str(), paused["stopped"].as_bool(), paused["text"].as_str()), (Some("interrupted"), Some(true), Some("Team paused")));
    }

    #[test]
    fn team_and_worker_message_replies_stay_within_the_remote_budget() {
        let workers = (0..25)
            .map(|index| {
                let mut worker = worker_fixture(&format!("w{index}"), "completed");
                worker.summary = "summary ".repeat(512);
                worker.assignment = "assignment ".repeat(512);
                worker.files = (0..24)
                    .map(|file| format!("src/{index}-{file}-{}", "x".repeat(500)))
                    .collect();
                worker.checkpoint.as_mut().unwrap().summary = "checkpoint ".repeat(512);
                worker.checkpoint.as_mut().unwrap().next_steps = "next ".repeat(512);
                worker
            })
            .collect();
        let team = team_fixture(workers);
        let messages = (0..TEAM_MESSAGE_COUNT).map(|id| json!({"id": id, "sender": "architect", "recipient": "w1", "message": "coordination ".repeat(128), "createdAt": id})).collect::<Vec<_>>();
        let mut value = remote_team(&team, team.workers.iter().map(remote_worker).collect());
        value["messages"] = json!(messages);
        let reply = fit_team_reply(json!({"team": value}));
        assert!(reply.to_string().len() <= PAGE_BUDGET);
        assert_eq!(reply["team"]["workers"].as_array().unwrap().len(), 25);
        assert_eq!(
            reply["team"]["messages"].as_array().unwrap().len(),
            TEAM_MESSAGE_COUNT
        );
        assert_eq!(reply["team"]["truncated"], true);
        assert!(reply["team"]["workers"]
            .as_array()
            .unwrap()
            .iter()
            .any(|worker| worker["filesTruncated"] == true));

        let values = (1..=100).map(|id| json!({
            "id": id, "sessionId": "session-w1", "role": "assistant", "content": "response ".repeat(320),
            "createdAt": id, "turnDurationMs": null, "authorProvider": "codex", "turnChanges": null, "coordinationKind": null,
        })).collect();
        let page = fit_worker_message_page("Worker w1", Some(100), values, false, true, false);
        assert!(page.to_string().len() <= PAGE_BUDGET);
        assert_eq!(page["title"], "Worker w1");
        assert_eq!(page["lastId"], 100);
        assert_eq!(page["hasMore"], true);
        assert_eq!(page["messages"][0]["sessionId"], "session-w1");
        assert_eq!(page["messages"][0]["authorProvider"], "codex");
        assert!(page["messages"].as_array().unwrap().len() < 100);
        // Linear: thousands of small messages fit at once, filling the budget closely.
        let values = (1..=5000).map(|id| json!({"id": id, "role": "assistant", "content": "ok ".repeat(10)})).collect();
        let started = Instant::now();
        let page = fit_worker_message_page("Worker w1", Some(5000), values, false, false, false);
        assert!(started.elapsed() < Duration::from_secs(2));
        let size = page.to_string().len();
        assert!(size <= PAGE_BUDGET && size > PAGE_BUDGET - 200, "{size}");
        assert_eq!(page["hasMore"], true);
        // One oversized message is cut to fit, never dropped.
        let page = fit_worker_message_page("Worker w1", Some(1), vec![json!({"id": 1, "content": "x".repeat(400 * 1024)})], false, false, false);
        assert_eq!(page["messages"][0]["id"], 1);
        assert!(page.to_string().len() <= PAGE_BUDGET);
    }

    #[test]
    fn live_timestamps_are_unix_milliseconds_and_omitted_without_a_run() {
        let mut task = json!({"sessionId": "s1"});
        add_live_timing(&mut task, None);
        assert!(task.get("lastEventAt").is_none());
        assert!(task.get("runStartedAt").is_none());

        add_live_timing(
            &mut task,
            Some(LiveTiming {
                last_event_at: 1_700_000_000_250,
                run_started_at: Some(1_700_000_000_000),
            }),
        );
        assert_eq!(task["lastEventAt"], 1_700_000_000_250_i64);
        assert_eq!(task["runStartedAt"], 1_700_000_000_000_i64);
    }

    #[test]
    fn subagent_snapshots_keep_desktop_shape_and_mark_budget_cuts() {
        let (items, truncated) = bounded_subagents(&[subagent("run:worker", "Reading the source")], 1024).unwrap();
        assert!(!truncated);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["id"], "run:worker");
        assert_eq!(items[0]["parentId"], Value::Null);
        assert_eq!(items[0]["name"], "Reviewer");
        assert_eq!(items[0]["prompt"], "Inspect the change");
        assert_eq!(items[0]["status"], "running");
        assert_eq!(items[0]["response"], "Reading the source");
        assert_eq!(items[0]["tools"], json!([]));
        assert_eq!(items[0]["startedAt"], 1_700_000_000_000_i64);
        assert_eq!(items[0]["updatedAt"], 1_700_000_000_500_i64);

        let large = subagent("run:large", &"activity ".repeat(512));
        let (items, truncated) = bounded_subagents(&[large], 512).unwrap();
        assert!(truncated);
        assert_eq!(items.len(), 1);
        assert!(items[0]["response"].as_str().unwrap().ends_with(CUT));
        assert!(json!(items).to_string().len() <= 512);
    }

    #[test]
    fn everything_is_refused_while_hosting_is_off() {
        for method in METHODS {
            assert_eq!(parse(false, method, &json!({"sessionId": "s", "text": "hi", "requestId": "r", "approve": true})), Err(OFF.to_string()));
        }
        assert_eq!(parse(false, "nope", &json!({})), Err(OFF.to_string()));
    }

    #[test]
    fn requests_are_validated() {
        assert_eq!(parse(true, "subscribe", &json!({"sessionIds": ["s1", "s2"]})), Ok(Call::Subscribe { session_ids: vec!["s1".into(), "s2".into()], after: HashMap::new(), epoch: None, replay: REPLAY_BUDGET }));
        // Where a viewer left off: only for requested tasks, and only valid positions.
        let resume = parse(true, "subscribe", &json!({"sessionIds": ["s1", "s2"], "epoch": "e1", "afterSeq": {"s1": 7, "s2": -1, "other": 3}}));
        assert_eq!(resume, Ok(Call::Subscribe { session_ids: vec!["s1".into(), "s2".into()], after: HashMap::from([("s1".to_string(), 7)]), epoch: Some("e1".into()), replay: REPLAY_BUDGET }));
        assert_eq!(parse(true, "task.startStatus", &json!({"startId": "st1"})), Ok(Call::StartStatus { start_id: "st1".into() }));
        assert_eq!(parse(true, "task.cancelStart", &json!({"startId": "st1"})), Ok(Call::CancelStart { start_id: "st1".into() }));
        assert!(parse(true, "task.cancelStart", &json!({})).is_err());
        assert!(parse(true, "subscribe", &json!({})).is_err());
        assert!(parse(true, "subscribe", &json!({"sessionIds": ["a b"]})).is_err());
        assert!(parse(true, "subscribe", &json!({"sessionIds": vec!["s"; MAX_IDS + 1]})).is_err());
        assert_eq!(parse(true, "task.send", &json!({"sessionId": "s1", "text": " hi "})), Ok(Call::Send { session_id: "s1".into(), text: "hi".into(), image_ids: vec![] }));
        let image = uuid::Uuid::new_v4().to_string();
        assert_eq!(parse(true, "task.send", &json!({"sessionId": "s1", "text": "hi", "imageIds": [image]})), Ok(Call::Send { session_id: "s1".into(), text: "hi".into(), image_ids: vec![image.clone()] }));
        assert!(parse(true, "task.send", &json!({"sessionId": "s1", "text": "hi", "imageIds": ["../x"]})).is_err());
        assert!(parse(true, "task.send", &json!({"sessionId": "s1", "text": "hi", "imageIds": vec![image; 5]})).is_err());
        assert!(parse(true, "image.put", &json!({"uploadId": "u1", "index": 0, "size": 3, "data": "iVBO"})).is_ok());
        assert!(parse(true, "image.put", &json!({"uploadId": "u1", "index": 0, "size": 6 * 1024 * 1024, "data": "iVBO"})).is_err());
        assert_eq!(parse(true, "task.messages", &json!({"sessionId": "s1", "afterId": 7})), Ok(Call::Messages { session_id: "s1".into(), page: MessagePaging::After { after_id: 7, limit: PAGE_ROWS }, budget: PAGE_BUDGET }));
        assert_eq!(parse(true, "task.messages", &json!({"sessionId": "s1", "afterId": -3})), Ok(Call::Messages { session_id: "s1".into(), page: MessagePaging::After { after_id: 0, limit: PAGE_ROWS }, budget: PAGE_BUDGET }));
        assert_eq!(parse(true, "task.configure", &json!({"sessionId": "s1", "effort": null})), Ok(Call::Configure { session_id: "s1".into(), model: None, effort: Some(None), mode: None }));
        assert_eq!(parse(true, "task.configure", &json!({"sessionId": "s1", "mode": "ask"})), Ok(Call::Configure { session_id: "s1".into(), model: None, effort: None, mode: Some("ask".into()) }));
        assert_eq!(parse(true, "task.configure", &json!({"sessionId": "s1", "provider": "codex", "model": "gpt"})), Ok(Call::Configure { session_id: "s1".into(), model: Some(("codex".into(), "gpt".into())), effort: None, mode: None }));
        assert!(parse(true, "task.configure", &json!({"sessionId": "s1", "model": "gpt"})).is_err());
        assert!(parse(true, "task.send", &json!({"sessionId": "s1", "text": "x".repeat(MAX_TEXT + 1)})).is_err());
        assert!(parse(true, "task.send", &json!({"sessionId": "s1", "text": "  "})).is_err());
        assert!(parse(true, "task.messages", &json!({"sessionId": "a\nb"})).is_err());
        assert!(parse(true, "task.stop", &json!({})).is_err());
        let image_id = uuid::Uuid::new_v4().to_string();
        assert!(matches!(parse(true, "task.attachment", &json!({"sessionId":"s1","id":image_id,"variant":"thumb"})), Ok(Call::Attachment { offset: 0, .. })));
        assert!(parse(true, "task.attachment", &json!({"sessionId":"s1","id":"../../secret","variant":"full"})).is_err());
        assert!(parse(true, "task.workspaceImage", &json!({"sessionId":"s1","path":"../secret.png","variant":"thumb"})).is_err());
        assert!(parse(true, "task.workspaceImage", &json!({"sessionId":"s1","path":"src/pic.png","variant":"full","offset":-1})).is_err());
        assert!(parse(true, "approval.respond", &json!({"sessionId": "s", "requestId": "r"})).is_err());
        assert!(parse(true, "input.respond", &json!({"sessionId": "s", "requestId": "r"})).is_err());
        assert_eq!(parse(true, "tasks.list", &json!({})), Ok(Call::TasksList { limit: TASKS_DEFAULT }));
        assert_eq!(parse(true, "tasks.list", &json!({"limit": null})), Ok(Call::TasksList { limit: TASKS_DEFAULT }));
        assert_eq!(parse(true, "tasks.list", &json!({"limit": 500})), Ok(Call::TasksList { limit: 500 }));
        assert_eq!(parse(true, "tasks.list", &json!({"limit": 1})), Ok(Call::TasksList { limit: 1 }));
        assert_eq!(parse(true, "tasks.list", &json!({"limit": 0})), Ok(Call::TasksList { limit: 0 }));
        assert!(parse(true, "tasks.list", &json!({"limit": 501})).is_err());
        assert!(parse(true, "tasks.list", &json!({"limit": 1.5})).is_err());
        assert!(parse(true, "tasks.list", &json!({"limit": "20"})).is_err());
        for gone in ["task.get", "shell.exec"] {
            assert!(parse(true, gone, &json!({})).is_err(), "{gone}");
        }
        assert!(valid_id(&"a".repeat(201)).is_err());
    }

    #[test]
    fn team_requests_are_read_only_and_validate_worker_paging() {
        assert_eq!(
            parse(true, "task.team", &json!({"sessionId": "s1"})),
            Ok(Call::Team {
                session_id: "s1".into()
            })
        );
        assert_eq!(
            parse(
                true,
                "task.workerMessages",
                &json!({"sessionId": "s1", "workerId": "w1"})
            ),
            Ok(Call::WorkerMessages {
                session_id: "s1".into(),
                worker_id: "w1".into(),
                after_id: 0,
                before_id: None,
                limit: WORKER_MESSAGE_PAGE_DEFAULT
            })
        );
        assert_eq!(
            parse(true, "task.workerMessages", &json!({"sessionId": "s1", "workerId": "w1", "tail": true})),
            Ok(Call::WorkerMessages { session_id: "s1".into(), worker_id: "w1".into(), after_id: 0, before_id: Some(i64::MAX), limit: WORKER_MESSAGE_PAGE_DEFAULT })
        );
        assert_eq!(
            parse(true, "task.workerMessages", &json!({"sessionId": "s1", "workerId": "w1", "beforeId": 40, "limit": 10})),
            Ok(Call::WorkerMessages { session_id: "s1".into(), worker_id: "w1".into(), after_id: 0, before_id: Some(40), limit: 10 })
        );
        assert_eq!(
            parse(
                true,
                "task.workerMessages",
                &json!({"sessionId": "s1", "workerId": "w1", "afterId": 7, "limit": 25})
            ),
            Ok(Call::WorkerMessages {
                session_id: "s1".into(),
                worker_id: "w1".into(),
                after_id: 7,
                before_id: None,
                limit: 25
            })
        );
        for params in [
            json!({"workerId": "w1"}),
            json!({"sessionId": "s1"}),
            json!({"sessionId": "s1", "workerId": "w1", "afterId": -1}),
            json!({"sessionId": "s1", "workerId": "w1", "afterId": "7"}),
            json!({"sessionId": "s1", "workerId": "w1", "limit": 0}),
            json!({"sessionId": "s1", "workerId": "w1", "beforeId": 0}),
            json!({"sessionId": "s1", "workerId": "w1", "beforeId": "9"}),
            json!({"sessionId": "s1", "workerId": "w1", "limit": WORKER_MESSAGE_PAGE_MAX + 1}),
        ] {
            assert!(
                parse(true, "task.workerMessages", &params).is_err(),
                "{params}"
            );
        }
        for method in ["task.team", "task.workerMessages"] {
            assert!(is_read_only_method(method));
            assert!(METHODS.contains(&method));
        }
        assert!(parse(false, "task.team", &json!({"sessionId": "s1"})).is_err());
    }

    #[test]
    fn task_pull_changes_and_bot_requests_are_validated() {
        for (method, params) in [
            ("task.pull", json!({"sessionId": "s1"})),
            ("task.pullDiff", json!({"sessionId": "s1"})),
            ("task.pullDiff", json!({"sessionId": "s1", "path": "src/main.rs"})),
            ("task.pullMerge", json!({"sessionId": "s1", "method": "squash"})),
            ("task.pullDetect", json!({"sessionId": "s1"})),
            ("task.changes", json!({"sessionId": "s1"})),
            ("task.diff", json!({"sessionId": "s1"})),
            ("task.diff", json!({"sessionId": "s1", "path": "src/main.rs", "staged": true})),
            ("bots.list", json!({})),
            ("bot.thread", json!({"botId": "b1"})),
            ("bot.message", json!({"botId": "b1", "text": "hello"})),
            ("bot.pause", json!({"botId": "b1", "paused": true})),
        ] {
            assert!(parse(true, method, &params).is_ok(), "{method} {params}");
        }

        for (method, params) in [
            ("task.pull", json!({})),
            ("task.pullMerge", json!({"sessionId": "s1", "method": "--admin"})),
            ("task.changes", json!({"sessionId": "bad id"})),
            ("task.diff", json!({"sessionId": "s1", "path": "../secret"})),
            ("task.diff", json!({"sessionId": "s1", "staged": "yes"})),
            ("bot.thread", json!({"botId": "bad id"})),
            ("bot.message", json!({"botId": "b1", "text": "  "})),
            ("bot.pause", json!({"botId": "b1", "paused": "yes"})),
        ] {
            assert!(parse(true, method, &params).is_err(), "{method} {params}");
        }
    }

    #[test]
    fn message_paging_options_are_parsed_and_validated() {
        let tail = parse(true, "task.messages", &json!({"sessionId": "s1", "tail": true})).unwrap();
        assert_eq!(tail, Call::Messages { session_id: "s1".into(), page: MessagePaging::Tail { limit: MESSAGE_PAGE_DEFAULT }, budget: PAGE_BUDGET });

        let before = parse(true, "task.messages", &json!({"sessionId": "s1", "beforeId": 19, "limit": 25})).unwrap();
        assert_eq!(before, Call::Messages { session_id: "s1".into(), page: MessagePaging::Before { before_id: 19, limit: 25 }, budget: PAGE_BUDGET });
        assert_eq!(parse(true, "task.messages", &json!({"sessionId": "s1", "beforeId": 19})), Ok(Call::Messages { session_id: "s1".into(), page: MessagePaging::Before { before_id: 19, limit: MESSAGE_PAGE_DEFAULT }, budget: PAGE_BUDGET }));
        assert_eq!(parse(true, "task.messages", &json!({"sessionId": "s1", "tail": true, "limit": 1})), Ok(Call::Messages { session_id: "s1".into(), page: MessagePaging::Tail { limit: 1 }, budget: PAGE_BUDGET }));
        assert_eq!(parse(true, "task.messages", &json!({"sessionId": "s1", "beforeId": 19, "limit": 400})), Ok(Call::Messages { session_id: "s1".into(), page: MessagePaging::Before { before_id: 19, limit: 400 }, budget: PAGE_BUDGET }));

        assert!(parse(true, "task.messages", &json!({"sessionId": "s1", "tail": true, "afterId": 1})).is_err());
        assert!(parse(true, "task.messages", &json!({"sessionId": "s1", "beforeId": 1, "afterId": 2})).is_err());
        assert!(parse(true, "task.messages", &json!({"sessionId": "s1", "tail": true, "beforeId": 1})).is_err());
        assert!(parse(true, "task.messages", &json!({"sessionId": "s1", "tail": true, "limit": 0})).is_err());
        assert!(parse(true, "task.messages", &json!({"sessionId": "s1", "tail": true, "limit": 401})).is_err());
        assert!(parse(true, "task.messages", &json!({"sessionId": "s1", "beforeId": "19"})).is_err());
        assert!(parse(true, "task.messages", &json!({"sessionId": "s1", "beforeId": -1})).is_err());
        assert!(parse(true, "task.messages", &json!({"sessionId": "s1", "tail": "yes"})).is_err());
    }

    #[test]
    fn pull_diff_and_detail_replies_fit_the_remote_budget() {
        let mut pull = json!({
            "number": 42,
            "title": "A pull request",
            "body": "b".repeat(64 * 1024),
            "bodyTruncated": false,
            "timeline": vec![json!({"body": "c".repeat(16 * 1024)}); 60],
            "files": vec![json!({"path": "src/".to_owned() + &"f".repeat(2048), "additions": 1, "deletions": 0}); 200],
            "commits": [],
            "checks": [],
            "labels": [],
        });
        fit_pull_detail(&mut pull);
        assert_eq!(pull["truncated"], true);
        assert!(pull.to_string().len() <= PAGE_BUDGET);
        assert!(json!({"pull": &pull}).to_string().len() <= PAGE_BUDGET);

        let files = fit_pull_files(json!(vec![json!({"path": "p".repeat(1024), "additions": 3, "deletions": 1}); 300]));
        assert_eq!(files["truncated"], true);
        assert!(files.to_string().len() <= PAGE_BUDGET);

        let mut bots = vec![json!({"avatar": "data:image/png;base64,{}", "id": "bot".repeat(100) }); 12];
        fit_list(&mut bots, PAGE_BUDGET.saturating_sub(json!({"bots": []}).to_string().len()));
        let bots = json!({"bots": bots});
        assert!(bots.to_string().len() <= PAGE_BUDGET);

        let (patch, truncated) = bounded_diff("λ".repeat(DIFF_BUDGET), false);
        assert!(truncated);
        assert!(patch.len() <= DIFF_BUDGET);
        assert!(patch.ends_with("[cut on the host to fit a remote diff]"));

        let source = "diff --git a/first.rs b/first.rs\n--- a/first.rs\n+++ b/first.rs\n@@ -1 +1 @@\n+first\ndiff --git \"a/space name.rs\" \"b/space name.rs\"\n--- \"a/space name.rs\"\n+++ \"b/space name.rs\"\n@@ -1 +1 @@\n+second\n";
        let (selected, truncated) = pull_file_patch(source, "space name.rs", false);
        assert!(selected.contains("+second"));
        assert!(!selected.contains("+first"));
        assert!(!truncated);
        assert_eq!(pull_file_patch(source, "missing.rs", true), (String::new(), true));

        let changes = changes_reply(
            crate::workspace::GitStatus {
                branch: "b".repeat(PAGE_BUDGET),
                files: (0..500).map(|n| crate::workspace::GitFile { path: format!("src/{}-{n}", "f".repeat(512)), index: " ".into(), working: "M".into() }).collect(),
                is_repo: true,
            },
            2,
            1,
        );
        assert!(changes.to_string().len() <= PAGE_BUDGET);
    }

    #[test]
    fn provider_requests_are_validated() {
        assert_eq!(parse(true, "providers.list", &json!({})), Ok(Call::Providers { force: false }));
        assert_eq!(parse(true, "providers.list", &json!({"force": true})), Ok(Call::Providers { force: true }));
        assert!(parse(true, "providers.list", &json!({"force": "yes"})).is_err());
        assert_eq!(parse(true, "providers.models", &json!({"provider": "codex", "force": null})), Ok(Call::Models { provider: "codex".into(), force: false }));
        assert_eq!(parse(true, "providers.models", &json!({"provider": "omp", "force": true})), Ok(Call::Models { provider: "omp".into(), force: true }));
        for bad in [json!({}), json!({"provider": "../bin/sh"}), json!({"provider": "gemini"}), json!({"provider": 3})] {
            assert!(parse(true, "providers.models", &bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn read_only_request_classification_is_explicit() {
        for method in [
            "tasks.list", "task.messages", "task.changes", "task.diff", "task.pull", "task.pullDiff",
            "task.pullDetect", "task.attachment", "task.workspaceImage", "projects.icons", "providers.list",
            "providers.models", "bots.list", "subscribe",
        ] {
            assert!(is_read_only_method(method), "{method}");
        }
        for method in [
            "task.send", "task.steer", "task.stop", "task.configure", "approval.respond", "input.respond",
            "bot.thread", "bot.message", "bot.pause", "task.pullMerge", "task.start", "unknown",
        ] {
            assert!(!is_read_only_method(method), "{method}");
        }
    }

    #[test]
    fn batches_accept_up_to_eight_read_only_calls_and_keep_call_errors_local() {
        let parsed = parse(
            true,
            "batch",
            &json!({"calls": [
                {"method": "task.messages", "params": {"sessionId": "s", "tail": true}},
                {"method": "task.messages", "params": {}},
            ]}),
        )
        .unwrap();
        assert_eq!(
            parsed,
            Call::Batch(vec![
                Ok(Call::Messages { session_id: "s".into(), page: MessagePaging::Tail { limit: MESSAGE_PAGE_DEFAULT }, budget: PAGE_BUDGET }),
                Err("Missing sessionId.".into()),
            ])
        );
        assert!(parse(true, "batch", &json!({"calls": []})).is_err());
        let eight = std::iter::repeat_n(json!({"method": "tasks.list", "params": {}}), 8).collect::<Vec<_>>();
        assert!(parse(true, "batch", &json!({"calls": eight})).is_ok());
        let too_many = std::iter::repeat_n(json!({"method": "tasks.list", "params": {}}), 9).collect::<Vec<_>>();
        assert!(parse(true, "batch", &json!({"calls": too_many})).is_err());
        assert!(parse(true, "batch", &json!({"calls": [{"method": "task.send", "params": {"sessionId": "s", "text": "x"}}]})).is_err());
        assert!(parse(true, "batch", &json!({"calls": [{"method": "batch", "params": {"calls": []}}]})).is_err());
    }

    #[test]
    fn batch_results_stay_within_the_single_reply_budget() {
        let reply = fit_batch_results(vec![
            Ok(json!({"value": "small"})),
            Ok(json!({"value": "x".repeat(PAGE_BUDGET)})),
            Err("failed".into()),
        ]);
        assert!(reply.to_string().len() <= PAGE_BUDGET);
        assert_eq!(reply["results"].as_array().unwrap().len(), 3);
        assert_eq!(reply["results"][0]["ok"], true);
        assert_eq!(reply["results"][1]["ok"], false);
        assert_eq!(reply["results"][2]["error"], "failed");
    }

    #[test]
    fn pull_cache_entries_are_scoped_and_expire_after_the_ttl() {
        let key = ("task".to_owned(), 42);
        let mut entries = HashMap::new();
        store_pull_entry(&mut entries, key.clone(), json!({"number": 42}));
        assert_eq!(cached_pull_entry(&mut entries, &key), Some(json!({"number": 42})));
        assert_eq!(cached_pull_entry(&mut entries, &("other-task".into(), 42)), None);
        entries.get_mut(&key).unwrap().expires = Instant::now() - Duration::from_secs(1);
        assert_eq!(cached_pull_entry(&mut entries, &key), None);
        assert_eq!(PULL_CACHE_TTL, Duration::from_secs(30));
    }

    #[test]
    fn concurrent_pull_misses_for_the_same_key_share_a_flight() {
        let key = PullFlightKey::Detail("flight-test-task".into(), 101);
        let first = pull_flight(key.clone());
        let second = pull_flight(key);
        assert!(Arc::ptr_eq(&first, &second));
    }

    #[test]
    fn project_icon_requests_are_validated() {
        assert_eq!(parse(true, "projects.icons", &json!({"projectIds": ["p1", "p2"]})), Ok(Call::ProjectIcons { project_ids: vec!["p1".into(), "p2".into()] }));
        let fifty: Vec<String> = (0..MAX_PROJECT_ICON_IDS).map(|i| format!("p{i}")).collect();
        assert!(parse(true, "projects.icons", &json!({"projectIds": fifty})).is_ok());
        assert!(parse(true, "projects.icons", &json!({})).is_err());
        assert!(parse(true, "projects.icons", &json!({"projectIds": []})).is_err());
        assert!(parse(true, "projects.icons", &json!({"projectIds": vec!["p"; 51]})).is_err());
        for bad in [json!({"projectIds": [""]}), json!({"projectIds": ["bad id"]}), json!({"projectIds": [1]}), json!({"projectIds": "p1"})] {
            assert!(parse(true, "projects.icons", &bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn project_icons_obey_single_icon_and_reply_budgets() {
        let result = fit_project_icons(vec![
            ("oversized".into(), Some("x".repeat(64 * 1024 + 1))),
            ("empty".into(), None),
            ("first".into(), Some("x".repeat(60 * 1024))),
            ("second".into(), Some("x".repeat(60 * 1024))),
            ("third".into(), Some("x".repeat(60 * 1024))),
            ("after".into(), Some("small".into())),
        ]);
        assert_eq!(result["icons"]["oversized"], Value::Null);
        assert_eq!(result["icons"]["empty"], Value::Null);
        assert!(result["icons"].get("first").is_some());
        assert!(result["icons"].get("second").is_some());
        assert!(result["icons"].get("third").is_none());
        assert!(result["icons"].get("after").is_none());
        assert!(result.to_string().len() <= PAGE_BUDGET);

        let at_limit = fit_project_icons(vec![("at-limit".into(), Some("x".repeat(MAX_PROJECT_ICON_BYTES)))]);
        assert_eq!(at_limit["icons"]["at-limit"].as_str().unwrap().len(), MAX_PROJECT_ICON_BYTES);
    }

    #[test]
    fn provider_lists_are_trimmed_to_one_reply() {
        let model = json!({"id": "m", "name": "x".repeat(1000)});
        let mut list = vec![model.clone(); 400];
        fit_list(&mut list, PAGE_BUDGET);
        assert!(!list.is_empty() && list.len() < 400 && json!(list).to_string().len() <= PAGE_BUDGET);
        let mut small = vec![model.clone(); 3];
        fit_list(&mut small, PAGE_BUDGET);
        assert_eq!(small.len(), 3);
        let mut providers = json!([{"id": "opencode", "models": vec![model.clone(); 400]}, {"id": "claude", "models": [model]}]);
        fit_providers(&mut providers);
        assert!(providers.to_string().len() <= PAGE_BUDGET);
        assert_eq!(providers[1]["models"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn task_and_project_lists_fit_one_reply() {
        let tasks = vec![json!({"title": "t".repeat(1024)}); 110];
        let projects = vec![json!({"name": "p".repeat(900)}); 70];
        let result = fit_task_lists(tasks, projects);
        assert!(result.to_string().len() <= PAGE_BUDGET);
        assert!(!result["tasks"].as_array().unwrap().is_empty());
        assert!(!result["projects"].as_array().unwrap().is_empty());
    }

    #[test]
    fn remote_pending_requests_keep_answer_payloads_within_one_message_budget() {
        let request_id = "run-id:provider-id";
        let requests = HashMap::from([(
            request_id.to_owned(),
            AgentEvent {
                session_id: "task-id".into(),
                kind: "input_request".into(),
                text: "Choose one".into(),
                request_id: Some(request_id.into()),
                data: Some(json!({"question": "x".repeat(MAX_MESSAGE * 2)})),
                tool: None,
            },
        )]);
        let pending = pending_items(&requests);
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0]["kind"], "input_request");
        assert_eq!(pending[0]["requestId"], request_id);
        assert_eq!(pending[0]["text"], "Choose one");
        assert!(pending[0]["data"]["question"].as_str().unwrap().contains("[cut on the host"));
        assert!(pending[0].get("tool").is_none());
        assert!(json!(pending).to_string().len() <= MAX_MESSAGE);
    }

    #[test]
    fn host_gate_only_checks_remote_control() {
        assert_eq!(gate(false), Err(OFF.to_string()));
        assert_eq!(gate(true), Ok(()));
    }

    #[test]
    fn a_present_device_keeps_its_subscription_without_a_pin() {
        let now = Instant::now();
        let subscriber = Subscriber {
            until: Some(now + Duration::from_secs(60)),
            ..Default::default()
        };
        let mut inner = super::super::Inner {
            devices: vec![super::super::Device {
                id: "viewer".into(), name: "Phone".into(), platform: "iOS".into(), public_key: "current-key".into(),
                host: false, online: true, last_seen: Value::Null,
            }],
            ..Default::default()
        };
        inner.subscribers.insert("viewer".into(), subscriber);
        assert!(prune_subscribers(&mut inner, now));
        assert!(inner.subscribers.contains_key("viewer"));
    }

    #[test]
    fn access_is_checked_when_a_request_runs() {
        let mut inner = super::super::Inner {
            devices: vec![super::super::Device { id: "viewer".into(), name: String::new(), platform: String::new(), public_key: "k".into(), host: false, online: true, last_seen: Value::Null }],
            ..Default::default()
        };
        let now = 1_000_000_000;
        let request = |nonce: &str| json!({"ts": now, "nonce": nonce});
        assert_eq!(admit(&inner, "viewer"), Err(OFF.to_string()));
        inner.settings.host_enabled = true;
        assert_eq!(admit(&inner, "viewer"), Ok(false));
        inner.settings.remote_full_access = true;
        assert_eq!(admit(&inner, "viewer"), Ok(true));
        // Revoked (gone from presence) after the request was queued.
        inner.devices.clear();
        assert_eq!(admit(&inner, "viewer"), Err(super::super::UNKNOWN_DEVICE.to_string()));
        // Freshness is checked on arrival: a request that then waits a minute in the
        // queue still runs, and a replay of it is refused when it arrives.
        assert_eq!(fresh_request(&mut inner, &request("nonce-0000000000000003"), now), Ok(()));
        assert!(fresh_request(&mut inner, &request("nonce-0000000000000003"), now + 90_000).is_err(), "replayed or stale");
        assert!(fresh_request(&mut inner, &request("nonce-0000000000000004"), now + 90_000).is_err(), "stale on arrival");
    }

    #[test]
    fn full_access_is_capped_for_remote_tasks() {
        let start = |mode: Option<&str>| {
            let mut params = json!({"projectId": "p", "prompt": "go", "provider": "claude", "model": "sonnet"});
            if let Some(mode) = mode {
                params["mode"] = json!(mode);
            }
            parse(true, "task.start", &params).unwrap()
        };
        let mode = |call: Call| match call {
            Call::Start(start) => start.mode,
            Call::Configure { mode, .. } => mode,
            _ => unreachable!(),
        };
        assert_eq!(mode(cap_mode(start(None), false).unwrap()).as_deref(), Some("ask"), "the full default asks instead");
        assert_eq!(mode(cap_mode(start(Some("auto")), false).unwrap()).as_deref(), Some("auto"));
        assert!(cap_mode(start(Some("full")), false).unwrap_err().starts_with("Full access is off for remote tasks on "));
        assert_eq!(mode(cap_mode(start(None), true).unwrap()), None);
        assert_eq!(mode(cap_mode(start(Some("full")), true).unwrap()).as_deref(), Some("full"));
        let configure = |mode: &str| parse(true, "task.configure", &json!({"sessionId": "s", "mode": mode})).unwrap();
        assert!(cap_mode(configure("full"), false).is_err());
        assert_eq!(mode(cap_mode(configure("plan"), false).unwrap()).as_deref(), Some("plan"));
        assert_eq!(mode(cap_mode(configure("full"), true).unwrap()).as_deref(), Some("full"));
    }

    #[test]
    fn a_full_task_takes_no_remote_prompts_without_full_access() {
        let off = |stored, requested| allow_task_mode(stored, requested, false);
        assert!(off("full", None).unwrap_err().starts_with("Full access is off for remote tasks on "), "send, steer, model-only configure");
        assert!(off("full", Some("full")).is_err());
        assert!(off("full", Some("ask")).is_ok(), "switching it to an approving mode");
        assert!(off("ask", None).is_ok() && off("auto", None).is_ok());
        assert!(allow_task_mode("full", None, true).is_ok());
    }

    #[test]
    fn replays_and_stale_requests_are_refused() {
        let mut replay = Replay::default();
        let now = 1_000_000_000;
        let nonce = "0123456789abcdef0123";
        assert!(replay.check(Some(now - 1000), Some(nonce), now).is_ok());
        assert!(replay.check(Some(now - 1000), Some(nonce), now + 10).is_err(), "same nonce twice");
        assert!(replay.check(Some(now - 60_001), Some("fresh-nonce-000001"), now).is_err(), "too old");
        assert!(replay.check(Some(now + 60_001), Some("fresh-nonce-000002"), now).is_err(), "too new");
        assert!(replay.check(None, Some("fresh-nonce-000003"), now).is_err());
        assert!(replay.check(Some(now), Some("short"), now).is_err());
        assert!(replay.check(Some(now), None, now).is_err());
        // Seen nonces are pruned once their ts leaves the window.
        assert!(replay.check(Some(now + 61_500), Some("fresh-nonce-000004"), now + 61_500).is_ok());
        assert!(!replay.seen.contains_key(nonce));
    }

    fn event(session: &str, kind: &str, text: &str) -> Value {
        serde_json::to_value(AgentEvent { session_id: session.into(), kind: kind.into(), text: text.into(), request_id: None, data: None, tool: None }).unwrap()
    }

    #[test]
    fn consecutive_text_deltas_are_merged() {
        let mut events = Vec::new();
        for (session, kind, text) in [("a", "text", "Hel"), ("a", "text", "lo"), ("b", "text", "other"), ("a", "text", " there"), ("a", "tool", "ls"), ("a", "text", "!"), ("a", "text", "?")] {
            push_event(&mut events, event(session, kind, text));
        }
        let texts: Vec<(&str, &str)> = events.iter().map(|e| (e["sessionId"].as_str().unwrap(), e["text"].as_str().unwrap())).collect();
        assert_eq!(texts, [("a", "Hello"), ("b", "other"), ("a", " there"), ("a", "ls"), ("a", "!?")]);
        // A delta of another message (its data differs) starts a new event.
        let mut tagged = event("a", "text", "new");
        tagged["data"] = json!({"messageId": "m2"});
        push_event(&mut events, tagged);
        assert_eq!(events.len(), 6);
        // A joined delta carries the newest seq, so a viewer's position covers all its text.
        let mut numbered = Vec::new();
        for seq in [7, 8] {
            let mut delta = event("a", "text", "x");
            delta["seq"] = json!(seq);
            push_event(&mut numbered, delta);
        }
        assert_eq!((numbered.len(), numbered[0]["seq"].as_u64(), numbered[0]["text"].as_str()), (1, Some(8), Some("xx")));
    }

    #[test]
    fn a_viewer_that_comes_back_gets_exactly_what_it_missed() {
        let mut journal = Journal::default();
        assert!(journal.record("a", event("a", "text", "lost"), false).is_none(), "nobody follows the task");
        let first = journal.record("a", event("a", "text", "Hel"), true).unwrap();
        assert_eq!(first["seq"], 1);
        journal.record("b", event("b", "tool", "ls"), true);
        journal.record("a", event("a", "text", "lo"), false).unwrap();
        journal.record("a", event("a", "approval", "Run ls"), false).unwrap();
        // After seq 1: the rest of a's events, in order, deltas joined under the newest seq.
        let Missed::Events { events: missed, more: false, last: 4 } = journal.missed("a", 1, REPLAY_BUDGET, true) else { panic!("no gap") };
        assert_eq!(missed.iter().map(|e| (e["kind"].as_str().unwrap(), e["text"].as_str().unwrap(), e["seq"].as_u64().unwrap())).collect::<Vec<_>>(), [("text", "lo", 3), ("approval", "Run ls", 4)]);
        assert_eq!(journal.missed("a", 4, REPLAY_BUDGET, true), Missed::Events { events: vec![], more: false, last: 4 });
        // More than fits: the first page, and where the next one starts.
        let Missed::Events { events, more: true, last: 1 } = journal.missed("a", 0, 10, true) else { panic!("a first page") };
        assert_eq!(events.len(), 1, "one event always goes first, cut to fit");
        assert_eq!(journal.missed("a", 0, 10, false), Missed::Events { events: vec![], more: true, last: 0 }, "or waits for the next page");
        assert_eq!(journal.missed("a", 99, REPLAY_BUDGET, true), Missed::Gap, "a position this journal never gave");
        assert_eq!(journal.missed("c", 0, REPLAY_BUDGET, true), Missed::Gap, "a task it never recorded");
        // A task recorded from a later point can't account for what came before.
        journal.watch("c");
        journal.record("c", event("c", "tool", "x"), false).unwrap();
        assert_eq!(journal.missed("c", 2, REPLAY_BUDGET, true), Missed::Gap);
        assert!(matches!(journal.missed("c", 4, REPLAY_BUDGET, true), Missed::Events { events, .. } if events.len() == 1));
    }

    #[test]
    fn a_long_replay_is_paged_instead_of_starving_later_tasks() {
        let mut journal = Journal::default();
        let epoch = journal.epoch.clone();
        let mut tasks = vec![json!({"sessionId": "a"}), json!({"sessionId": "b"})];
        journal.resume(&mut tasks, &HashMap::new(), None, REPLAY_BUDGET);
        // a's missed tool output is several pages; b missed one event after it.
        let chunk = "o".repeat(20 * 1024);
        for i in 0..12 {
            journal.record("a", event("a", "tool", &format!("{i}{chunk}")), false).unwrap();
        }
        journal.record("b", event("b", "tool", "pwd"), false).unwrap();
        let mut after = HashMap::from([("a".to_string(), 0u64), ("b".to_string(), 0u64)]);
        let (mut seen_a, mut seen_b, mut pages) = (Vec::new(), Vec::new(), 0);
        loop {
            pages += 1;
            let mut tasks = vec![json!({"sessionId": "a"}), json!({"sessionId": "b"})];
            let resumed = journal.resume(&mut tasks, &after, Some(&epoch), REPLAY_BUDGET);
            assert_eq!(resumed.gaps, 0, "nothing turns into a gap");
            assert!(json!(tasks).to_string().len() <= REPLAY_BUDGET + 512, "each page fits");
            for (task, seen) in tasks.iter().zip([&mut seen_a, &mut seen_b]) {
                seen.extend(task["events"].as_array().cloned().unwrap_or_default());
                assert!(task.get("gap").is_none());
                after.insert(task["sessionId"].as_str().unwrap().into(), task["seq"].as_u64().unwrap());
            }
            if !resumed.more {
                break;
            }
            assert!(tasks.iter().any(|task| task["more"] == true));
        }
        assert!(pages > 2, "paged");
        assert_eq!(seen_a.iter().map(|e| e["text"].as_str().unwrap().split('o').next().unwrap().to_owned()).collect::<Vec<_>>(), (0..12).map(|i| i.to_string()).collect::<Vec<_>>(), "every event once, in order");
        assert_eq!(seen_b.iter().map(|e| e["text"].as_str().unwrap()).collect::<Vec<_>>(), ["pwd"]);
        assert_eq!(after["a"], 13, "caught up to the newest seq");
    }

    #[test]
    fn team_updates_and_run_ends_are_journaled_and_replayed() {
        let mut inner = super::super::Inner {
            devices: vec![super::super::Device { id: "viewer".into(), name: String::new(), platform: String::new(), public_key: "k".into(), host: false, online: true, last_seen: Value::Null }],
            outbox: Some(tokio::sync::mpsc::channel(1).0),
            ..Default::default()
        };
        inner.settings.host_enabled = true;
        inner.subscribers.insert("viewer".into(), Subscriber { until: Some(Instant::now() + SUBSCRIPTION), sessions: HashSet::from(["h1".to_string()]), ..Default::default() });
        let epoch = inner.journal.epoch.clone();
        journal_and_enqueue(&mut inner, "h1", event("h1", "text", "Hi"), Queue::Event);
        journal_and_enqueue(&mut inner, "h1", team_event_value("h1", json!({"id": "w1", "status": "running"})), Queue::Event);
        journal_and_enqueue(&mut inner, "h1", json!({"sessionId": "h1", "successful": true, "stopped": false, "text": "Turn complete"}), Queue::Finished);
        // A team settling while that run end still waits to go adds nothing.
        journal_and_enqueue(&mut inner, "h1", json!({"sessionId": "h1", "successful": true, "teamSettled": true}), Queue::Settled);
        let subscriber = &inner.subscribers["viewer"];
        assert_eq!(subscriber.events.iter().map(|e| (e["kind"].as_str().unwrap(), e["seq"].as_u64().unwrap())).collect::<Vec<_>>(), [("text", 1), ("team", 2)]);
        assert_eq!(subscriber.finished, vec![json!({"sessionId": "h1", "successful": true, "stopped": false, "text": "Turn complete", "kind": "run.finished", "seq": 3})], "the live frame carries its seq");
        // The run end is shaped with its team when sent; the replay says the same.
        inner.journal.amend("h1", 3, json!({"sessionId": "h1", "kind": "run.finished", "status": "running", "seq": 3}));
        let mut tasks = vec![json!({"sessionId": "h1"})];
        inner.journal.resume(&mut tasks, &HashMap::from([("h1".to_string(), 0)]), Some(&epoch), REPLAY_BUDGET);
        assert_eq!(tasks[0]["events"].as_array().unwrap().iter().map(|e| e["kind"].as_str().unwrap()).collect::<Vec<_>>(), ["text", "team", "run.finished"]);
        assert_eq!(tasks[0]["events"][2]["status"], "running");
        assert_eq!(inner.journal.bytes, inner.journal.rings.values().map(|ring| ring.bytes).sum::<usize>());
    }

    #[test]
    fn a_full_buffer_tells_the_viewer_it_lagged() {
        let mut full: Vec<Value> = (0..MAX_BUFFER).map(|i| event("a", "tool", &i.to_string())).collect();
        push_event(&mut full, event("a", "tool", "late"));
        push_event(&mut full, event("a", "tool", "later"));
        assert_eq!(full.len(), MAX_BUFFER + 1, "one marker, nothing more");
        assert!(lagged(full.last().unwrap()));
        full.pop();
        let sent = lagged_frames(frames(full), true, "e1");
        assert!(sent.len() > 1);
        assert!(sent[..sent.len() - 1].iter().all(|frame| frame.get(LAGGED).is_none()));
        assert_eq!((sent.last().unwrap()[LAGGED].as_bool(), sent.last().unwrap()["epoch"].as_str()), (Some(true), Some("e1")), "the last frame says so");
        assert_eq!(lagged_frames(Vec::new(), true, "e1"), vec![json!({"events": [], "epoch": "e1", "lagged": true})]);
        assert!(lagged_frames(vec![vec![event("a", "tool", "x")]], false, "e1")[0].get(LAGGED).is_none());
    }

    #[test]
    fn a_start_that_panics_still_settles() {
        let mut starts = HashMap::new();
        let (entry, _) = claim_start(&mut starts, "st-panic", "viewer", Instant::now()).unwrap();
        let guarded = entry.clone();
        let joined = std::thread::spawn(move || {
            let _settle = Settle(guarded);
            panic!("start blew up");
        })
        .join();
        assert!(joined.is_err());
        assert_eq!(start_status(Some(&entry)), json!({"state": "failed", "error": START_ENDED}));
        // A start that finished keeps its result.
        let (done, _) = claim_start(&mut starts, "st-ok", "viewer", Instant::now()).unwrap();
        Settle(done.clone()).finish(Ok(json!({"sessionId": "h1"})));
        assert_eq!(start_status(Some(&done)), json!({"state": "done", "sessionId": "h1"}));
    }

    #[test]
    fn batch_calls_are_checked_one_by_one() {
        let params = json!({"calls": [{"method": "tasks.list", "params": {}}, {"method": "task.diff", "params": {}}]});
        assert_eq!(batch_methods("batch", &params).collect::<Vec<_>>(), ["tasks.list", "task.diff"]);
        assert_eq!(batch_methods("task.send", &params).count(), 0);
        assert_eq!(batch_methods("batch", &json!({})).count(), 0);
    }

    #[test]
    fn the_journal_stays_bounded_and_says_when_it_dropped_events() {
        let mut journal = Journal::default();
        for i in 0..JOURNAL_EVENTS + 10 {
            journal.record("a", event("a", "tool", &i.to_string()), true);
        }
        let ring = &journal.rings["a"];
        assert_eq!((ring.events.len(), ring.dropped), (JOURNAL_EVENTS, 10));
        assert_eq!(journal.missed("a", 5, usize::MAX, true), Missed::Gap, "events after 5 were dropped");
        assert!(matches!(journal.missed("a", 10, usize::MAX, true), Missed::Events { events, more: false, .. } if events.len() == JOURNAL_EVENTS));
        let big = "x".repeat(600 * 1024);
        for _ in 0..4 {
            journal.record("b", event("b", "tool", &big), true);
        }
        assert!(journal.rings["b"].bytes <= JOURNAL_BYTES && journal.rings["b"].events.len() < 4);
        assert_eq!(journal.bytes, journal.rings.values().map(|ring| ring.bytes).sum::<usize>());
    }

    #[test]
    fn an_idle_journal_sweeps_once_its_last_run_end_idles() {
        let mut journal = Journal::default();
        let now = Instant::now();
        assert_eq!(journal.arm(now), None, "nothing finished, nothing to schedule");
        journal.record("done", json!({"sessionId": "done", "kind": "run.finished", "successful": true}), true).unwrap();
        let delay = journal.arm(now).expect("a sweep at the idle deadline");
        assert!(delay >= JOURNAL_IDLE && delay < JOURNAL_IDLE + Duration::from_secs(5));
        assert_eq!(journal.arm(now), None, "one sweep at a time");
        // Followed again meanwhile: the sweep keeps it and re-arms for its new deadline.
        let touched = now + Duration::from_secs(60);
        journal.rings.get_mut("done").unwrap().touched = touched;
        assert_eq!(journal.fire(now + JOURNAL_IDLE), Some(Duration::from_secs(60)));
        assert!(journal.rings.contains_key("done"));
        assert_eq!(journal.fire(touched + JOURNAL_IDLE), None, "nothing left to wait for");
        assert!(journal.rings.is_empty() && journal.bytes == 0);
        assert_eq!(journal.missed("done", 0, REPLAY_BUDGET, true), Missed::Gap, "the phone refetches");
    }

    #[test]
    fn unfollowed_tasks_forget_their_team_rows() {
        let now = Instant::now();
        let mut inner = super::super::Inner {
            devices: vec![super::super::Device { id: "phone".into(), name: String::new(), platform: String::new(), public_key: "k".into(), host: false, online: true, last_seen: Value::Null }],
            ..Default::default()
        };
        inner.settings.host_enabled = true;
        inner.subscribers.insert("phone".into(), Subscriber { until: Some(now + Duration::from_secs(60)), sessions: HashSet::from(["team-kept".to_string()]), ..Default::default() });
        inner.subscribers.insert("gone".into(), Subscriber { until: Some(now + Duration::from_secs(60)), sessions: HashSet::from(["team-left".to_string()]), ..Default::default() });
        inner.journal.watch("team-left");
        for id in ["team-kept", "team-left"] {
            team_event_cache().lock().unwrap().insert(id.into(), HashMap::from([("w1".to_string(), json!({}))]));
        }
        // "gone" left presence: its subscription ends, its ring stays for a replay.
        assert!(prune_subscribers(&mut inner, now));
        assert_eq!(followed(&inner, "team-left"), Some(false), "a ring but no subscriber is not following");
        let cache = team_event_cache().lock().unwrap();
        assert!(cache.contains_key("team-kept") && !cache.contains_key("team-left"));
    }

    #[test]
    fn finished_rings_nobody_follows_are_dropped() {
        let mut journal = Journal::default();
        journal.record("done", event("done", "text", "Hi"), true).unwrap();
        journal.record("done", json!({"sessionId": "done", "kind": "run.finished", "successful": true}), false).unwrap();
        journal.record("busy", event("busy", "text", "Hi"), true).unwrap();
        journal.record("back", json!({"sessionId": "back", "kind": "run.finished", "successful": true}), true).unwrap();
        let later = Instant::now() + JOURNAL_IDLE;
        journal.sweep(later - Duration::from_secs(1));
        assert_eq!(journal.rings.len(), 3, "a run that ended a moment ago keeps its events");
        // A viewer came back to "back" just before the sweep.
        journal.rings.get_mut("back").unwrap().touched = later;
        journal.sweep(later + Duration::from_secs(1));
        assert!(!journal.rings.contains_key("done"), "finished and unfollowed for ten minutes");
        assert!(journal.rings.contains_key("busy") && journal.rings.contains_key("back"));
        assert_eq!(journal.bytes, journal.rings.values().map(|ring| ring.bytes).sum::<usize>());
        assert_eq!(journal.missed("done", 0, REPLAY_BUDGET, true), Missed::Gap);
        // A new run clears the mark.
        journal.record("back", event("back", "text", "again"), false).unwrap();
        assert!(!journal.rings["back"].finished);
    }

    #[test]
    fn the_journal_total_stays_under_its_cap() {
        let mut journal = Journal::default();
        let big = "x".repeat(512 * 1024);
        for task in 0..40 {
            let id = format!("t{task}");
            journal.record(&id, event(&id, "tool", &big), true).unwrap();
            assert!(journal.bytes <= JOURNAL_TOTAL);
        }
        assert_eq!(journal.bytes, journal.rings.values().map(|ring| ring.bytes).sum::<usize>());
        let newest = journal.missed("t39", journal.rings["t39"].since, usize::MAX, true);
        assert!(matches!(newest, Missed::Events { events, .. } if events[0]["text"].as_str().is_some_and(|text| text.len() == big.len())), "replays parse the stored text");
    }

    #[test]
    fn subscribe_replies_carry_seq_replay_or_a_gap() {
        let mut journal = Journal::default();
        let epoch = journal.epoch.clone();
        let mut tasks = vec![json!({"sessionId": "a"}), json!({"sessionId": "b"})];
        journal.resume(&mut tasks, &HashMap::new(), None, REPLAY_BUDGET);
        assert_eq!((tasks[0]["seq"].as_u64(), tasks[0].get("gap")), (Some(0), None), "a new viewer gets only the position");
        journal.record("a", event("a", "tool", "ls"), false).unwrap();
        journal.record("b", event("b", "tool", "pwd"), false).unwrap();
        let mut tasks = vec![json!({"sessionId": "a"}), json!({"sessionId": "b"})];
        journal.resume(&mut tasks, &HashMap::from([("a".to_string(), 0), ("b".to_string(), 2)]), Some(&epoch), REPLAY_BUDGET);
        assert_eq!(tasks[0]["events"][0]["text"], "ls");
        assert_eq!((tasks[1].get("events"), tasks[1].get("gap"), tasks[1]["seq"].as_u64()), (None, None, Some(2)), "nothing missed");
        // Another epoch: this host restarted, so every position is a gap.
        let mut tasks = vec![json!({"sessionId": "a"})];
        journal.resume(&mut tasks, &HashMap::from([("a".to_string(), 0)]), Some("old"), REPLAY_BUDGET);
        assert_eq!((tasks[0]["gap"].as_bool(), tasks[0].get("events")), (Some(true), None));
    }

    #[test]
    fn a_burst_sends_its_first_event_at_once() {
        let now = Instant::now();
        assert_eq!(flush_delay(None, 0, now), Duration::ZERO);
        assert_eq!(flush_delay(Some(now - Duration::from_secs(1)), 9, now), Duration::ZERO, "after a quiet spell");
        assert_eq!(flush_delay(Some(now - Duration::from_millis(5)), 1, now), FLUSH - Duration::from_millis(5), "only the rest of FLUSH");
        assert_eq!(flush_delay(Some(now - Duration::from_millis(60)), BURST_FRAMES, now), SUSTAINED - Duration::from_millis(60), "a long stream");
        // Three viewers past the burst: one flush is three frames, paid for over 300 ms.
        let paid = paid_until(now, BURST_FRAMES + 3, 3);
        assert_eq!(flush_delay(Some(paid), BURST_FRAMES + 3, now), 3 * SUSTAINED);
        assert_eq!(paid_until(now, 3, 3), now, "inside the burst");
        // Any number of viewers in a sustained stream stays at 1000 / SUSTAINED frames/s.
        for viewers in 1..=8u32 {
            let (mut at, mut frames, mut sent, mut clock) = (None, 0u32, 0u32, now);
            while clock < now + Duration::from_secs(10) {
                clock += flush_delay(at, frames, clock).max(Duration::from_millis(1));
                frames = frames.saturating_add(viewers);
                at = Some(paid_until(clock, frames, viewers));
                sent += viewers;
            }
            assert!(sent <= 10 * 1000 / SUSTAINED.as_millis() as u32 + BURST_FRAMES + 2 * viewers, "{viewers} viewers sent {sent} frames in 10 s");
        }
        assert_eq!(FLUSH, Duration::from_millis(40));
        // Worst case, a burst repeated after each quiet spell, stays under the relay's 20 frames/s.
        let cycle = FLUSH * (BURST_FRAMES - 1) + SUSTAINED;
        assert!(f64::from(BURST_FRAMES) / cycle.as_secs_f64() < 20.0);
    }

    #[test]
    fn a_start_runs_once_per_start_id_and_can_be_cancelled() {
        let mut starts = HashMap::new();
        let now = Instant::now();
        let (first, fresh) = claim_start(&mut starts, "st1", "viewer", now).unwrap();
        assert!(fresh);
        let (again, fresh) = claim_start(&mut starts, "st1", "viewer", now).unwrap();
        assert!(!fresh && Arc::ptr_eq(&first, &again), "a repeated task.start waits for the first");
        assert!(claim_start(&mut starts, "st1", "phone", now).is_err(), "another device can't take it over");
        assert_eq!(start_status(None), json!({"state": "unknown"}));
        assert_eq!(start_status(Some(&first)), json!({"state": "running"}));
        // Cancelled while running: callers get CANCELLED at once and the start is told to stop.
        assert_eq!(cancel_start(&first), json!({"cancelled": true}));
        assert!(first.cancel.is_set());
        assert_eq!(*first.result.borrow(), Some(Err(start::CANCELLED.to_string())));
        assert_eq!(start_status(Some(&first)), json!({"state": "failed", "error": start::CANCELLED}));
        // A start that already made its task says so and is left alone.
        let (done, _) = claim_start(&mut starts, "st2", "viewer", now).unwrap();
        done.result.send_replace(Some(Ok(json!({"sessionId": "h1"}))));
        assert_eq!(cancel_start(&done), json!({"cancelled": false, "sessionId": "h1"}));
        assert!(!done.cancel.is_set());
        assert_eq!(start_status(Some(&done)), json!({"state": "done", "sessionId": "h1"}));
        // A worktree fallback's note survives a lost `task.start` reply.
        done.result.send_replace(Some(Ok(json!({"sessionId": "h1", "worktree": true, "note": "Started in a worktree: busy."}))));
        assert_eq!(start_status(Some(&done)), json!({"state": "done", "sessionId": "h1", "worktree": true, "note": "Started in a worktree: busy."}));
        // Cancelled while its task is being made: too late, the start goes on and is not failed.
        let (making, _) = claim_start(&mut starts, "st6", "viewer", now).unwrap();
        assert!(!making.cancel.is_set());
        // What `start::run_cancellable` does before it creates the task.
        making.cancel.commit().unwrap();
        assert_eq!(cancel_start(&making), json!({"cancelled": false, "pending": true}));
        assert!(!making.cancel.is_set());
        assert_eq!(start_status(Some(&making)), json!({"state": "running"}));
        // A cancel that arrives before its start was claimed leaves it cancelled, so it never runs.
        let (early, _) = claim_start(&mut starts, "st5", "viewer", now).unwrap();
        cancel_start(&early);
        let (late, fresh) = claim_start(&mut starts, "st5", "viewer", now).unwrap();
        assert!(!fresh && late.cancel.is_set());
        assert_eq!(*late.result.borrow(), Some(Err(start::CANCELLED.to_string())));
        // Finished starts are forgotten after an hour; running ones never are.
        let (_running, _) = claim_start(&mut starts, "st3", "viewer", now).unwrap();
        claim_start(&mut starts, "st4", "viewer", now + START_MEMORY + Duration::from_secs(1)).unwrap();
        assert_eq!(starts.keys().map(String::as_str).collect::<HashSet<_>>(), HashSet::from(["st3", "st4", "st6"]));
    }

    #[test]
    fn events_are_framed_under_the_budget() {
        let events: Vec<Value> = (0..30).map(|i| event("a", "tool", &format!("{i}{}", "o".repeat(20 * 1024)))).chain([event("a", "text", &"é".repeat(300 * 1024))]).collect();
        let framed = frames(events);
        assert!(framed.len() > 1);
        assert_eq!(framed.iter().map(Vec::len).sum::<usize>(), 31, "nothing is dropped");
        let key = [7u8; 32];
        for frame in &framed {
            let body = super::super::crypto::seal(&key, "a", "b", json!({"type": "event", "name": "agent.events", "data": {"events": frame}}).to_string().as_bytes()).unwrap();
            assert!(json!({"to": "b", "body": body}).to_string().len() < 256 * 1024);
        }
        assert!(framed.last().unwrap()[0]["text"].as_str().unwrap().ends_with(CUT));
        assert!(frames(Vec::new()).is_empty());
    }

    #[test]
    fn huge_messages_are_cut_and_tool_json_still_parses() {
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE sessions(id TEXT PRIMARY KEY, title TEXT NOT NULL); CREATE TABLE messages(id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL, turn_duration_ms INTEGER); INSERT INTO sessions VALUES ('s','Task'),('t','Other');").unwrap();
        let tool = json!({"status": "completed", "output": "o".repeat(300 * 1024)}).to_string();
        db.execute("INSERT INTO messages(session_id,role,content,created_at) VALUES ('s','tool',?1,1),('t','user','elsewhere',2),('s','assistant','done',3)", [&tool]).unwrap();
        let page = messages_page_with(&db, "s", MessagePaging::After { after_id: 0, limit: PAGE_ROWS }).unwrap();
        let messages = page["messages"].as_array().unwrap();
        assert_eq!((messages.len(), page["hasMore"].as_bool(), page["title"].as_str()), (2, Some(false), Some("Task")), "only this task's messages");
        assert_eq!(page["lastId"], 3);
        assert_eq!(page["hasOlder"], false);
        assert!(messages[0].to_string().len() <= MAX_MESSAGE);
        let parsed = serde_json::from_str::<Value>(messages[0]["content"].as_str().unwrap()).expect("tool content still parses");
        assert!(parsed["output"].as_str().unwrap().ends_with(CUT) && parsed["status"] == "completed");
        assert_eq!(messages[1]["content"], "done");
        assert!(messages_page_with(&db, "missing", MessagePaging::After { after_id: 0, limit: PAGE_ROWS }).is_err());
    }

    #[test]
    fn message_pages_report_older_rows_last_id_and_empty_threads() {
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE sessions(id TEXT PRIMARY KEY, title TEXT NOT NULL); CREATE TABLE messages(id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL, turn_duration_ms INTEGER); INSERT INTO sessions VALUES ('s','Task'),('empty','Empty'); INSERT INTO messages(session_id,role,content,created_at) VALUES ('s','user','first',1),('s','assistant','last',2);").unwrap();

        let page = messages_page_with(&db, "s", MessagePaging::After { after_id: 1, limit: PAGE_ROWS }).unwrap();
        assert_eq!(page["messages"][0]["content"], "last");
        assert_eq!(page["hasOlder"], true);
        assert_eq!(page["lastId"], 2);

        let empty = messages_page_with(&db, "empty", MessagePaging::Tail { limit: MESSAGE_PAGE_DEFAULT }).unwrap();
        assert_eq!(empty["messages"], json!([]));
        assert_eq!(empty["hasMore"], false);
        assert_eq!(empty["hasOlder"], false);
        assert_eq!(empty["lastId"], Value::Null);
    }

    #[test]
    fn tail_and_before_pages_return_the_newest_rows_oldest_first() {
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE sessions(id TEXT PRIMARY KEY, title TEXT NOT NULL); CREATE TABLE messages(id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL, turn_duration_ms INTEGER); INSERT INTO sessions VALUES ('s','Task');").unwrap();
        for index in 1..=5 {
            db.execute("INSERT INTO messages(session_id,role,content,created_at) VALUES ('s','user',?1,?2)", rusqlite::params![format!("message-{index}"), index]).unwrap();
        }

        let tail = messages_page_with(&db, "s", MessagePaging::Tail { limit: 2 }).unwrap();
        assert_eq!(tail["messages"].as_array().unwrap().iter().map(|message| message["id"].as_i64().unwrap()).collect::<Vec<_>>(), [4, 5]);
        assert_eq!(tail["hasOlder"], true);
        assert_eq!(tail["hasMore"], false);
        assert_eq!(tail["lastId"], 5);

        let before = messages_page_with(&db, "s", MessagePaging::Before { before_id: 4, limit: 2 }).unwrap();
        assert_eq!(before["messages"].as_array().unwrap().iter().map(|message| message["id"].as_i64().unwrap()).collect::<Vec<_>>(), [2, 3]);
        assert_eq!(before["hasOlder"], true);
        assert_eq!(before["hasMore"], true);
        assert_eq!(before["lastId"], 5);
    }

    #[test]
    fn a_packed_page_fills_most_of_its_frame() {
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE sessions(id TEXT PRIMARY KEY, title TEXT NOT NULL); CREATE TABLE messages(id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL, turn_duration_ms INTEGER); INSERT INTO sessions VALUES ('s','Task');").unwrap();
        // Transcript-like text: prose and paths that pack well, ids that don't.
        let words = ["the", "test", "passes", "src/remote/host.rs", "fn", "page", "budget", "let", "mirror", "ok", "error", "frame", "packed", "viewer", "cargo", "message", "=>", "{", "}", "Value"];
        let mut seed = 7u64;
        for index in 1..=400 {
            let content: String = (0..600).map(|_| {
                seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
                if seed >> 60 == 0 { format!("{:x} ", seed) } else { format!("{} ", words[(seed >> 33) as usize % words.len()]) }
            }).collect();
            db.execute("INSERT INTO messages(session_id,role,content,created_at) VALUES ('s','tool',?1,?2)", rusqlite::params![content, index]).unwrap();
        }
        let page = messages_page_fit(&db, "s", MessagePaging::Before { before_id: 401, limit: PAGE_ROWS }, PACKED_PAGE_MAX).unwrap();
        let packed = super::super::crypto::pack(page.to_string().as_bytes()).len();
        assert!(page.to_string().len() > PAGE_BUDGET && packed <= PAGE_BUDGET);
        assert!(packed > PAGE_BUDGET * 4 / 5, "a packed page of {packed} bytes ({} plain) leaves much of its frame empty", page.to_string().len());
    }

    #[test]
    fn page_budgets_are_asked_clamped_and_held_for_plain_viewers() {
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE sessions(id TEXT PRIMARY KEY, title TEXT NOT NULL); CREATE TABLE messages(id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL, turn_duration_ms INTEGER); INSERT INTO sessions VALUES ('s','Task');").unwrap();
        for index in 1..=40 {
            db.execute("INSERT INTO messages(session_id,role,content,created_at) VALUES ('s','assistant',?1,?2)", rusqlite::params![format!("{index} {}", "the build passes ".repeat(500)), index]).unwrap();
        }
        let ids = |page: &Value| page["messages"].as_array().unwrap().iter().map(|message| message["id"].as_i64().unwrap()).collect::<Vec<_>>();

        // A small tail budget keeps the newest messages that fit, oldest first.
        let tail = messages_page_fit(&db, "s", MessagePaging::Tail { limit: 60 }, 32 * 1024).unwrap();
        assert!(tail.to_string().len() <= 32 * 1024);
        assert_eq!(ids(&tail).last(), Some(&40));
        assert!(ids(&tail).len() >= 2 && ids(&tail).windows(2).all(|pair| pair[0] + 1 == pair[1]));
        assert_eq!((tail["hasOlder"].as_bool(), tail["hasMore"].as_bool()), (Some(true), Some(false)));
        // Below one message there is still one.
        let one = messages_page_fit(&db, "s", MessagePaging::Tail { limit: 60 }, MIN_PAGE_BUDGET).unwrap();
        assert_eq!((ids(&one), one["hasOlder"].as_bool()), (vec![40], Some(true)));
        // A big budget for a packing viewer takes the whole thread in one page that packs small.
        let all = messages_page_fit(&db, "s", MessagePaging::After { after_id: 0, limit: PAGE_ROWS }, PACKED_PAGE_MAX).unwrap();
        assert_eq!((ids(&all).len(), all["hasMore"].as_bool(), all["hasOlder"].as_bool()), (40, Some(false), Some(false)));
        assert!(all.to_string().len() > PAGE_BUDGET && super::super::crypto::pack(all.to_string().as_bytes()).len() <= PAGE_BUDGET);

        // Text that packs poorly is cut until the packed page fits a frame.
        for index in 41..=200 {
            let noise: String = (0..200).map(|_| uuid::Uuid::new_v4().simple().to_string()).collect();
            db.execute("INSERT INTO messages(session_id,role,content,created_at) VALUES ('s','tool',?1,?2)", rusqlite::params![noise, index]).unwrap();
        }
        let cut = messages_page_fit(&db, "s", MessagePaging::Before { before_id: 201, limit: PAGE_ROWS }, PACKED_PAGE_MAX).unwrap();
        assert!(super::super::crypto::pack(cut.to_string().as_bytes()).len() <= PAGE_BUDGET);
        assert_eq!((ids(&cut).last(), cut["hasOlder"].as_bool(), cut["hasMore"].as_bool()), (Some(&200), Some(true), Some(false)));

        // Params: default, clamped, refused; a viewer without "z" is held to PAGE_BUDGET, in batches too.
        let budget = |params: Value| match parse(true, "task.messages", &params) { Ok(Call::Messages { budget, .. }) => Ok(budget), Ok(_) => unreachable!(), Err(error) => Err(error) };
        assert_eq!(budget(json!({"sessionId": "s", "tail": true})), Ok(PAGE_BUDGET));
        assert_eq!(budget(json!({"sessionId": "s", "tail": true, "budget": 1})), Ok(MIN_PAGE_BUDGET));
        assert_eq!(budget(json!({"sessionId": "s", "budget": u64::MAX})), Ok(PACKED_PAGE_MAX));
        assert_eq!(budget(json!({"sessionId": "s", "budget": "big"})), Err("Invalid budget.".into()));
        let big = || Call::Messages { session_id: "s".into(), page: MessagePaging::Tail { limit: 1 }, budget: PACKED_PAGE_MAX };
        assert_eq!(plain_budget(big(), true), big());
        assert!(matches!(plain_budget(big(), false), Call::Messages { budget: PAGE_BUDGET, .. }));
        assert!(matches!(plain_budget(Call::Batch(vec![Ok(big())]), false), Call::Batch(calls) if matches!(calls[0], Ok(Call::Messages { budget: PAGE_BUDGET, .. }))));
        // A batch reply is measured plain, so its pages stay plain-sized for packing viewers too.
        assert!(matches!(plain_budget(Call::Batch(vec![Ok(big())]), true), Call::Batch(calls) if matches!(calls[0], Ok(Call::Messages { budget: PAGE_BUDGET, .. }))));
        // A packing viewer gets a bigger replay, except inside a batch.
        let subscribe = || Call::Subscribe { session_ids: vec!["s".into()], after: HashMap::new(), epoch: None, replay: REPLAY_BUDGET };
        assert!(matches!(plain_budget(subscribe(), true), Call::Subscribe { replay: PACKED_REPLAY_BUDGET, .. }));
        assert!(matches!(plain_budget(subscribe(), false), Call::Subscribe { replay: REPLAY_BUDGET, .. }));
        assert!(matches!(plain_budget(Call::Batch(vec![Ok(subscribe())]), true), Call::Batch(calls) if matches!(calls[0], Ok(Call::Subscribe { replay: REPLAY_BUDGET, .. }))));
    }

    #[test]
    fn pages_read_attachments_in_one_pass_and_fit_without_the_database() {
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE sessions(id TEXT PRIMARY KEY, title TEXT NOT NULL); CREATE TABLE messages(id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL, turn_duration_ms INTEGER);
            CREATE TABLE message_attachments(message_id INTEGER, session_id TEXT, id TEXT, kind TEXT, name TEXT, mime TEXT, width INTEGER, height INTEGER, bytes INTEGER);
            INSERT INTO sessions VALUES ('s','Task');").unwrap();
        for index in 1..=6 {
            db.execute("INSERT INTO messages(session_id,role,content,created_at) VALUES ('s','user',?1,?2)", rusqlite::params![format!("prompt {index}"), index]).unwrap();
        }
        for (message, id) in [(2, "a"), (2, "b"), (5, "c")] {
            db.execute("INSERT INTO message_attachments VALUES (?1,'s',?2,'image','x.png','image/png',1,2,3)", rusqlite::params![message, id]).unwrap();
        }
        let rows = read_page(&db, "s", MessagePaging::Before { before_id: 6, limit: 3 }).unwrap();
        drop(db);
        let page = fit_page(rows, PAGE_BUDGET);
        let messages = page["messages"].as_array().unwrap();
        assert_eq!(messages.iter().map(|m| m["id"].as_i64().unwrap()).collect::<Vec<_>>(), [3, 4, 5]);
        assert_eq!(messages[2]["attachments"], json!([{"id": "c", "kind": "image", "name": "x.png", "mime": "image/png", "bytes": 3, "width": 1, "height": 2}]));
        assert_eq!((page["hasOlder"].as_bool(), page["hasMore"].as_bool(), page["lastId"].as_i64()), (Some(true), Some(true), Some(6)));
    }

    #[test]
    fn a_small_page_cuts_its_one_oversized_message_and_marks_it() {
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE sessions(id TEXT PRIMARY KEY, title TEXT NOT NULL); CREATE TABLE messages(id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL, turn_duration_ms INTEGER); INSERT INTO sessions VALUES ('s','Task');").unwrap();
        db.execute("INSERT INTO messages(session_id,role,content,created_at) VALUES ('s','assistant',?1,1)", [r#"{"tool":"x"} "#.to_string() + &"y".repeat(100 * 1024)]).unwrap();
        let small = messages_page_fit(&db, "s", MessagePaging::Tail { limit: 30 }, 32 * 1024).unwrap();
        assert!(small.to_string().len() <= 32 * 1024);
        assert_eq!((small["messages"][0]["id"].as_i64(), small["messages"][0]["cut"].as_bool()), (Some(1), Some(true)));
        // A normal page keeps it whole (under the 120 KB cap) and unmarked.
        let full = messages_page_fit(&db, "s", MessagePaging::Tail { limit: 30 }, PAGE_BUDGET).unwrap();
        assert!(full["messages"][0].get("cut").is_none() && full["messages"][0]["content"].as_str().unwrap().len() > 100 * 1024);
    }

    #[test]
    fn newest_first_pages_keep_the_newest_messages_that_fit_the_budget() {
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE sessions(id TEXT PRIMARY KEY, title TEXT NOT NULL); CREATE TABLE messages(id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL, turn_duration_ms INTEGER); INSERT INTO sessions VALUES ('s','Task');").unwrap();
        for index in 1..=4 {
            db.execute("INSERT INTO messages(session_id,role,content,created_at) VALUES ('s','user',?1,?2)", rusqlite::params!["x".repeat(72 * 1024), index]).unwrap();
        }

        let page = messages_page_with(&db, "s", MessagePaging::Tail { limit: 4 }).unwrap();
        let messages = page["messages"].as_array().unwrap();
        assert_eq!(messages.iter().map(|message| message["id"].as_i64().unwrap()).collect::<Vec<_>>(), [3, 4]);
        assert!(page.to_string().len() <= PAGE_BUDGET);
        assert_eq!(page["hasOlder"], true);
        assert_eq!(page["lastId"], 4);

        let before = messages_page_with(&db, "s", MessagePaging::Before { before_id: 4, limit: 4 }).unwrap();
        let messages = before["messages"].as_array().unwrap();
        assert_eq!(messages.iter().map(|message| message["id"].as_i64().unwrap()).collect::<Vec<_>>(), [2, 3]);
        assert!(before.to_string().len() <= PAGE_BUDGET);
        assert_eq!(before["hasOlder"], true);
        assert_eq!(before["hasMore"], true);
    }
}
