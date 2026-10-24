//! Answers requests from the account's other computers, only while
//! "Allow remote control" is on and only from computers trusted here (their key pinned),
//! and pushes the agent events of the tasks they mirror. Remote prompts run under the
//! same approval policy as local ones.
use super::{remote, socket, start, Subscriber};
use crate::{message_queue, providers::AgentEvent, AppState, Result};
use rusqlite::OptionalExtension;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

pub(crate) const METHODS: [&str; 11] = ["subscribe", "providers.list", "providers.models", "task.start", "task.messages", "task.send", "task.stop", "task.steer", "task.configure", "approval.respond", "input.respond"];
pub(crate) const OFF: &str = "Remote control is off on this computer";
pub(crate) const MAX_TEXT: usize = 100 * 1024;
const SUBSCRIPTION: Duration = Duration::from_secs(10 * 60);
/// Events wait this long, so one frame carries everything a subscriber missed meanwhile.
const FLUSH: Duration = Duration::from_millis(100);
pub(crate) const MAX_IDS: usize = 500;
const WINDOW_MS: i64 = 60_000;
const MAX_SEEN: usize = 20_000;
/// A reply's or event frame's JSON budget: sealing adds a third (base64) plus a small
/// envelope, so this stays under the relay's 256 KB frame.
pub(crate) const PAGE_BUDGET: usize = 180 * 1024;
/// A single message or event larger than this is cut, with [`CUT`] marking the cut.
const MAX_MESSAGE: usize = 120 * 1024;
/// Messages read per `task.messages` page before the budget trims it.
const PAGE_ROWS: i64 = 400;
/// Buffered events per subscriber; a viewer that falls this far behind resyncs at run end.
const MAX_BUFFER: usize = 4096;
const CUT: &str = "\n…[cut on the host to fit a remote page]";
/// Harness ids `providers.models` accepts (the same list `storage` allows).
pub(crate) const PROVIDERS: [&str; 16] = ["claude", "codex", "kimi", "opencode", "glm", "antigravity", "grok", "mimo", "pi", "deepseek", "commandcode", "cline", "kilo", "omp", "github-copilot", "muse"];

pub(crate) fn untrusted(host_name: &str) -> String {
    format!("This computer isn't trusted on {host_name}. Trust it in Settings → Remote access on that computer.")
}

/// Hosting must be on, and the frame must have been sealed with the caller's pinned key.
pub(crate) fn gate(host_enabled: bool, trusted: bool, host_name: &str) -> Result<()> {
    if !host_enabled {
        return Err(OFF.into());
    }
    if !trusted {
        return Err(untrusted(host_name));
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
    Subscribe { session_ids: Vec<String> },
    Providers { force: bool },
    Models { provider: String, force: bool },
    Start(start::Start),
    Messages { session_id: String, after_id: i64 },
    Send { session_id: String, text: String },
    Stop { session_id: String },
    Steer { session_id: String, text: String },
    Configure { session_id: String, model: Option<(String, String)>, effort: Option<Option<String>>, mode: Option<String> },
    Approve { session_id: String, request_id: String, approve: bool },
    Answer { session_id: String, request_id: String, response: Value },
}

pub(crate) fn id_param(params: &Value, key: &str) -> Result<String> {
    let id = params[key].as_str().ok_or_else(|| format!("Missing {key}."))?;
    valid_id(id).map_err(|_| format!("Invalid {key}."))?;
    Ok(id.to_owned())
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
            let session_ids = ids.iter().map(|id| id.as_str().filter(|id| valid_id(id).is_ok()).map(str::to_owned).ok_or("Invalid sessionIds.")).collect::<std::result::Result<_, _>>()?;
            Call::Subscribe { session_ids }
        }
        "providers.list" => Call::Providers { force: force_param(params)? },
        "providers.models" => {
            let provider = name_param(params, "provider")?.ok_or("Missing provider.")?;
            if !PROVIDERS.contains(&provider.as_str()) {
                return Err("Unknown provider.".into());
            }
            Call::Models { provider, force: force_param(params)? }
        }
        "task.start" => Call::Start(start::parse(params)?),
        "task.messages" => Call::Messages { session_id: id_param(params, "sessionId")?, after_id: params["afterId"].as_i64().unwrap_or(0).max(0) },
        "task.send" => Call::Send { session_id: id_param(params, "sessionId")?, text: text_param(params, "text")? },
        "task.stop" => Call::Stop { session_id: id_param(params, "sessionId")? },
        "task.steer" => Call::Steer { session_id: id_param(params, "sessionId")?, text: text_param(params, "text")? },
        "task.configure" => configure(params)?,
        "approval.respond" => Call::Approve { session_id: id_param(params, "sessionId")?, request_id: id_param(params, "requestId")?, approve: params["approve"].as_bool().ok_or("Missing approve.")? },
        "input.respond" => Call::Answer { session_id: id_param(params, "sessionId")?, request_id: id_param(params, "requestId")?, response: params.get("response").cloned().ok_or("Missing response.")? },
        _ => return Err("Unknown method.".into()),
    })
}

/// The response to one request frame, or None when it has no usable id.
/// `trusted` is true only when the frame opened with the caller's pinned key.
pub(crate) async fn handle(app: &tauri::AppHandle, from: &str, message: &Value, trusted: bool) -> Option<Value> {
    let id = message["id"].as_str().filter(|id| valid_id(id).is_ok())?;
    let name = super::config::device_name();
    let admitted = {
        let state = remote(app);
        let mut inner = state.lock();
        let now_ms = chrono::Utc::now().timestamp_millis();
        let enabled = inner.settings.host_enabled;
        // Trust first: an untrusted caller never fills the nonce set.
        gate(enabled, trusted, &name).and_then(|_| inner.replay.check(message["ts"].as_i64(), message["nonce"].as_str(), now_ms)).map(|_| enabled)
    };
    let result = match admitted.and_then(|enabled| parse(enabled, message["method"].as_str().unwrap_or_default(), &message["params"])) {
        Ok(call) => run(app, from, call).await,
        Err(error) => Err(error),
    };
    Some(match result {
        Ok(result) => json!({"type": "res", "id": id, "ok": true, "result": result}),
        Err(error) => json!({"type": "res", "id": id, "ok": false, "error": error}),
    })
}

/// The task must exist here; a mirror never forwards a second hop.
fn local_task(state: &AppState, session_id: &str) -> Result<()> {
    let task = state.store.lock().map_err(|e| e.to_string())?.session(session_id)?;
    if task.remote_device.is_some() {
        return Err("That task runs on another computer.".into());
    }
    Ok(())
}

async fn run(app: &tauri::AppHandle, from: &str, call: Call) -> Result<Value> {
    let state = app.state::<AppState>();
    match call {
        Call::Subscribe { session_ids } => {
            let tasks = subscribed_tasks(&state, &session_ids)?;
            let state = remote(app);
            let mut inner = state.lock();
            let subscriber = inner.subscribers.entry(from.to_owned()).or_default();
            // Added to, not replaced: a task started a moment ago may not be in the list yet.
            // An expired (or overgrown) subscription starts over.
            if subscriber.until.is_none_or(|until| until <= Instant::now()) || subscriber.sessions.len() > 4 * MAX_IDS {
                subscriber.sessions.clear();
            }
            subscriber.until = Some(Instant::now() + SUBSCRIPTION);
            subscriber.sessions.extend(session_ids);
            Ok(json!({"tasks": tasks}))
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
        Call::Start(request) => start::run(app, from, request).await,
        Call::Messages { session_id, after_id } => {
            local_task(&state, &session_id)?;
            let store = state.store.lock().map_err(|e| e.to_string())?;
            messages_page(&store.db, &session_id, after_id)
        }
        Call::Send { session_id, text } => {
            local_task(&state, &session_id)?;
            // Like Enter in the composer: a running task queues the message.
            let busy = || state.agents.lock().map(|agents| agents.contains_key(&session_id)).map_err(|e| e.to_string());
            if busy()? {
                let entry = message_queue::add(&*state.store.lock().map_err(|e| e.to_string())?, &session_id, &text, &json!([]))?;
                // If the run ended between the check and the add, nothing would deliver the
                // entry: take it back (unless a run end already did) and send it now.
                if busy()? || message_queue::take(&*state.store.lock().map_err(|e| e.to_string())?, &entry.id).is_err() {
                    let _ = app.emit("queue-changed", json!({"sessionId": session_id}));
                    return Ok(json!({"queued": true}));
                }
            }
            crate::send_message(app.clone(), state, session_id, text, None, None).await?;
            let _ = app.emit("sessions-changed", ());
            Ok(json!({"queued": false}))
        }
        Call::Stop { session_id } => {
            local_task(&state, &session_id)?;
            crate::stop_session(app.clone(), state, session_id).await?;
            Ok(json!({}))
        }
        Call::Steer { session_id, text } => {
            local_task(&state, &session_id)?;
            message_queue::steer_task(app.clone(), state, session_id, text).await
        }
        Call::Configure { session_id, model, effort, mode } => {
            local_task(&state, &session_id)?;
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
            local_task(&state, &session_id)?;
            crate::respond_approval(app.clone(), state, session_id.clone(), request_id.clone(), approve).await?;
            // Clear the card in this computer's window, as bot approvals do.
            let event = AgentEvent { session_id, kind: "approval_cancelled".into(), text: String::new(), request_id: Some(request_id), data: None, tool: None };
            let _ = app.emit("agent-event", event);
            Ok(json!({}))
        }
        Call::Answer { session_id, request_id, response } => {
            local_task(&state, &session_id)?;
            crate::respond_user_input(app.clone(), state, session_id, request_id, response).await?;
            Ok(json!({}))
        }
    }
}

/// Each subscribed task that exists here: its status as this window shows it, its newest
/// message id (so the viewer pulls what it missed) and its title.
fn subscribed_tasks(state: &AppState, ids: &[String]) -> Result<Vec<Value>> {
    let agents = state.agents.lock().map_err(|e| e.to_string())?;
    let store = state.store.lock().map_err(|e| e.to_string())?;
    let mut tasks = Vec::new();
    for id in ids {
        let row: Option<(String, String, i64)> = store
            .db
            .query_row("SELECT status,title,(SELECT COALESCE(MAX(id),0) FROM messages WHERE session_id=?1) FROM sessions WHERE id=?1 AND remote_device IS NULL", [id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .optional()
            .map_err(|e| e.to_string())?;
        let Some((status, title, last_id)) = row else { continue };
        // Only a registered agent is really running; a stale row reads as interrupted.
        let status = if agents.contains_key(id) || !matches!(status.as_str(), "running" | "waiting") { status } else { "interrupted".into() };
        tasks.push(json!({"sessionId": id, "status": status, "lastId": last_id, "title": title}));
    }
    Ok(tasks)
}

/// Messages after `after_id`, oldest first, cut to fit one frame. `hasMore` asks the
/// viewer for the next page after the last id it got.
pub(crate) fn messages_page(db: &rusqlite::Connection, session_id: &str, after_id: i64) -> Result<Value> {
    let title: String = db.query_row("SELECT title FROM sessions WHERE id=?1", [session_id], |r| r.get(0)).optional().map_err(|e| e.to_string())?.ok_or("Conversation not found.")?;
    let mut statement = db.prepare("SELECT id,role,content,created_at,turn_duration_ms FROM messages WHERE session_id=?1 AND id>?2 ORDER BY id LIMIT ?3").map_err(|e| e.to_string())?;
    let rows: Vec<Value> = statement
        .query_map(rusqlite::params![session_id, after_id, PAGE_ROWS], |r| {
            Ok(json!({"id": r.get::<_, i64>(0)?, "role": r.get::<_, String>(1)?, "content": r.get::<_, String>(2)?, "createdAt": r.get::<_, i64>(3)?, "turnDurationMs": r.get::<_, Option<i64>>(4)?}))
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<_>>()
        .map_err(|e| e.to_string())?;
    let fetched = rows.len();
    let mut room = PAGE_BUDGET.saturating_sub(json!({"messages": [], "hasMore": true, "title": title}).to_string().len());
    let mut kept = Vec::new();
    for mut message in rows {
        if message.to_string().len() > MAX_MESSAGE {
            cut(&mut message);
        }
        let size = message.to_string().len() + 1;
        // The first message always fits: once cut it is under the budget.
        if size > room && !kept.is_empty() {
            break;
        }
        room = room.saturating_sub(size);
        kept.push(message);
    }
    let has_more = kept.len() < fetched || fetched as i64 == PAGE_ROWS;
    Ok(json!({"messages": kept, "hasMore": has_more, "title": title}))
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

/// Appends an event to a subscriber's buffer, joining consecutive text deltas.
pub(crate) fn push_event(events: &mut Vec<Value>, event: Value) {
    if event["kind"] == "text" {
        if let Some(last) = events.last_mut().filter(|last| last["kind"] == "text" && last["sessionId"] == event["sessionId"] && last["data"] == event["data"] && last["requestId"] == event["requestId"]) {
            let joined = format!("{}{}", last["text"].as_str().unwrap_or_default(), event["text"].as_str().unwrap_or_default());
            last["text"] = json!(joined);
            return;
        }
    }
    if events.len() < MAX_BUFFER {
        events.push(event);
    }
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
}

/// Drops subscribers that expired, left the account or lost trust; true if any remain.
fn prune_subscribers(inner: &mut super::Inner, now: Instant) -> bool {
    let super::Inner { subscribers, devices, settings, .. } = inner;
    subscribers.retain(|id, subscriber| subscriber.until.is_some_and(|until| until > now) && devices.iter().any(|d| &d.id == id && settings.is_trusted(id, &d.public_key)));
    !subscribers.is_empty()
}

/// Queues an event for every device mirroring its task. Called on the agent-event hot
/// path: nothing is cloned unless someone mirrors this task.
pub(crate) fn agent_event(app: &tauri::AppHandle, event: &AgentEvent) {
    buffer(app, &event.session_id, |subscriber| {
        if let Ok(value) = serde_json::to_value(event) {
            push_event(&mut subscriber.events, value);
        }
    });
}

/// Queues `run.finished` for every device mirroring the task.
pub(crate) fn run_finished(app: &tauri::AppHandle, session_id: &str, successful: bool, stopped: bool, text: &str) {
    buffer(app, session_id, |subscriber| subscriber.finished.push(json!({"sessionId": session_id, "successful": successful, "stopped": stopped, "text": text})));
}

fn buffer(app: &tauri::AppHandle, session_id: &str, mut add: impl FnMut(&mut Subscriber)) {
    let Some(state) = app.try_state::<super::Remote>() else { return };
    let schedule = {
        let mut inner = state.lock();
        if !inner.settings.host_enabled || inner.outbox.is_none() || !inner.subscribers.values().any(|s| s.sessions.contains(session_id)) {
            return;
        }
        if !prune_subscribers(&mut inner, Instant::now()) {
            return;
        }
        for subscriber in inner.subscribers.values_mut().filter(|s| s.sessions.contains(session_id)) {
            add(subscriber);
        }
        !std::mem::replace(&mut inner.flushing, true)
    };
    if schedule {
        tauri::async_runtime::spawn(flush(app.clone()));
    }
}

/// Sends each subscriber one `agent.events` frame (more only past the frame budget),
/// then its `run.finished` events, so a run's last deltas always arrive before its end.
async fn flush(app: tauri::AppHandle) {
    tokio::time::sleep(FLUSH).await;
    let batches: Vec<(String, Vec<Value>, Vec<Value>)> = {
        let state = remote(&app);
        let mut inner = state.lock();
        inner.flushing = false;
        let hosting = inner.settings.host_enabled;
        inner.subscribers.iter_mut().filter(|_| hosting).map(|(id, s)| (id.clone(), std::mem::take(&mut s.events), std::mem::take(&mut s.finished))).filter(|(_, events, finished)| !events.is_empty() || !finished.is_empty()).collect()
    };
    for (device, events, finished) in batches {
        for frame in frames(events) {
            let _ = socket::send_trusted(&app, &device, &json!({"type": "event", "name": "agent.events", "data": {"events": frame}}));
        }
        for data in finished {
            let _ = socket::send_trusted(&app, &device, &json!({"type": "event", "name": "run.finished", "data": data}));
        }
    }
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
    let parsed = message["content"].as_str().and_then(|content| serde_json::from_str::<Value>(content).ok()).filter(Value::is_object);
    if let Some(mut content) = parsed {
        shrink(&mut content, MAX_MESSAGE * 3 / 4);
        message["content"] = json!(content.to_string());
    }
    shrink(message, MAX_MESSAGE);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn everything_is_refused_while_hosting_is_off() {
        for method in METHODS {
            assert_eq!(parse(false, method, &json!({"sessionId": "s", "text": "hi", "requestId": "r", "approve": true})), Err(OFF.to_string()));
        }
        assert_eq!(parse(false, "nope", &json!({})), Err(OFF.to_string()));
    }

    #[test]
    fn requests_are_validated() {
        assert_eq!(parse(true, "subscribe", &json!({"sessionIds": ["s1", "s2"]})), Ok(Call::Subscribe { session_ids: vec!["s1".into(), "s2".into()] }));
        assert!(parse(true, "subscribe", &json!({})).is_err());
        assert!(parse(true, "subscribe", &json!({"sessionIds": ["a b"]})).is_err());
        assert!(parse(true, "subscribe", &json!({"sessionIds": vec!["s"; MAX_IDS + 1]})).is_err());
        assert_eq!(parse(true, "task.send", &json!({"sessionId": "s1", "text": " hi "})), Ok(Call::Send { session_id: "s1".into(), text: "hi".into() }));
        assert_eq!(parse(true, "task.messages", &json!({"sessionId": "s1", "afterId": 7})), Ok(Call::Messages { session_id: "s1".into(), after_id: 7 }));
        assert_eq!(parse(true, "task.messages", &json!({"sessionId": "s1", "afterId": -3})), Ok(Call::Messages { session_id: "s1".into(), after_id: 0 }));
        assert_eq!(parse(true, "task.configure", &json!({"sessionId": "s1", "effort": null})), Ok(Call::Configure { session_id: "s1".into(), model: None, effort: Some(None), mode: None }));
        assert_eq!(parse(true, "task.configure", &json!({"sessionId": "s1", "mode": "ask"})), Ok(Call::Configure { session_id: "s1".into(), model: None, effort: None, mode: Some("ask".into()) }));
        assert_eq!(parse(true, "task.configure", &json!({"sessionId": "s1", "provider": "codex", "model": "gpt"})), Ok(Call::Configure { session_id: "s1".into(), model: Some(("codex".into(), "gpt".into())), effort: None, mode: None }));
        assert!(parse(true, "task.configure", &json!({"sessionId": "s1", "model": "gpt"})).is_err());
        assert!(parse(true, "task.send", &json!({"sessionId": "s1", "text": "x".repeat(MAX_TEXT + 1)})).is_err());
        assert!(parse(true, "task.send", &json!({"sessionId": "s1", "text": "  "})).is_err());
        assert!(parse(true, "task.messages", &json!({"sessionId": "a\nb"})).is_err());
        assert!(parse(true, "task.stop", &json!({})).is_err());
        assert!(parse(true, "approval.respond", &json!({"sessionId": "s", "requestId": "r"})).is_err());
        assert!(parse(true, "input.respond", &json!({"sessionId": "s", "requestId": "r"})).is_err());
        for gone in ["tasks.list", "task.get", "shell.exec"] {
            assert!(parse(true, gone, &json!({})).is_err(), "{gone}");
        }
        assert!(valid_id(&"a".repeat(201)).is_err());
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
    fn untrusted_callers_are_refused_by_name() {
        assert_eq!(gate(false, true, "Mac"), Err(OFF.to_string()));
        assert_eq!(gate(true, false, "Mac"), Err("This computer isn't trusted on Mac. Trust it in Settings → Remote access on that computer.".to_string()));
        assert_eq!(gate(true, true, "Mac"), Ok(()));
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
        // A viewer that falls far behind stops buffering; it catches up at the run end.
        let mut full: Vec<Value> = (0..MAX_BUFFER).map(|i| event("a", "tool", &i.to_string())).collect();
        push_event(&mut full, event("a", "tool", "late"));
        assert_eq!(full.len(), MAX_BUFFER);
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
        let page = messages_page(&db, "s", 0).unwrap();
        let messages = page["messages"].as_array().unwrap();
        assert_eq!((messages.len(), page["hasMore"].as_bool(), page["title"].as_str()), (2, Some(false), Some("Task")), "only this task's messages");
        assert!(messages[0].to_string().len() <= MAX_MESSAGE);
        let parsed = serde_json::from_str::<Value>(messages[0]["content"].as_str().unwrap()).expect("tool content still parses");
        assert!(parsed["output"].as_str().unwrap().ends_with(CUT) && parsed["status"] == "completed");
        assert_eq!(messages[1]["content"], "done");
        assert!(messages_page(&db, "missing", 0).is_err());
    }
}
