//! Routes inbound messages to bot conversations and sends replies back. A message
//! becomes a turn in the thread's PandaCode task; when the task is busy it waits in
//! the task's durable queue and is sent natively after the run, so bots keep working
//! with the window closed. Approvals asked during a run go to the same thread.

use super::{brief, channels, guard, owner_of, Bot};
use crate::{message_queue, storage::Store, AppState, Result};
use serde_json::json;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{Emitter, Manager};

/// A message for a bot from the desktop, the web UI or a chat channel.
#[derive(Debug, Clone)]
pub(crate) struct Inbound {
    pub bot_id: String,
    pub channel_id: String,
    pub thread: String,
    pub sender_id: String,
    pub sender_name: String,
    pub text: String,
    /// The desktop app and the bot's own schedules; channel senders are checked by pairing.
    pub trusted: bool,
}

pub(crate) const NOTHING: &str = "NOTHING_TO_REPORT";
const MAX_INBOUND: usize = 32 * 1024;

/// Approvals waiting on a reply, per task: (request ID, action) in arrival order.
type Pending = Mutex<HashMap<String, Vec<(String, String)>>>;
fn pending() -> &'static Pending {
    static PENDING: std::sync::OnceLock<Pending> = std::sync::OnceLock::new();
    PENDING.get_or_init(Default::default)
}

/// What an inbound text asks for, before it is treated as a message to the agent.
#[derive(Debug, PartialEq)]
pub(crate) enum Command {
    Stop,
    Help,
    NewThread,
    Approve(bool, bool),
    Message,
}

pub(crate) fn parse_command(text: &str, has_pending_approval: bool) -> Command {
    let word = text.trim().trim_end_matches(['.', '!']).to_lowercase();
    match word.as_str() {
        "/stop" | "stop!" => Command::Stop,
        "/help" => Command::Help,
        "/new" | "/reset" => Command::NewThread,
        "yes" | "y" | "approve" | "allow" | "ok" if has_pending_approval => Command::Approve(true, false),
        "always" | "always allow" if has_pending_approval => Command::Approve(true, true),
        "no" | "n" | "deny" | "reject" if has_pending_approval => Command::Approve(false, false),
        _ => Command::Message,
    }
}

const HELP: &str = "Message me and I'll work on it. Commands: /stop stops what I'm doing, /new starts a fresh conversation. When I ask for approval, reply yes, no or always.";

fn channel_kind(store: &Store, channel_id: &str) -> String {
    match channel_id {
        super::DESKTOP => "desktop".into(),
        "schedule" => "schedule".into(),
        _ => channels::kind_of(store, channel_id).unwrap_or_else(|| "web".into()),
    }
}

/// The text a turn receives: the message, plus the brief when the thread has not seen this version.
fn compose(store: &Store, bot: &Bot, session_id: &str, kind: &str, sender: &str, text: &str) -> Result<String> {
    let seen = super::brief_version_of(store, session_id)?;
    if seen == bot.memory_version {
        return Ok(text.to_owned());
    }
    let memories = super::memories(store, &bot.id)?;
    super::mark_briefed(store, session_id, bot.memory_version)?;
    Ok(format!("{text}{}", brief::compose(bot, &memories, kind, sender)))
}

/// Starts a turn, or queues the message when the task is already working.
async fn start_or_queue(app: &tauri::AppHandle, bot: &Bot, session_id: &str, text: String) -> Result<()> {
    let state = app.state::<AppState>();
    let busy = state.agents.lock().map_err(|e| e.to_string())?.contains_key(session_id);
    if busy {
        message_queue::add(&*state.store.lock().map_err(|e| e.to_string())?, session_id, &text, &json!([]))?;
        return Ok(());
    }
    crate::launch_task_in_project(app.clone(), state, session_id.to_owned(), Some(text), None, Some(bot.project_id.clone())).await
}

pub(crate) async fn deliver(app: &tauri::AppHandle, inbound: Inbound) -> Result<String> {
    let text = inbound.text.trim().chars().take(MAX_INBOUND).collect::<String>();
    if text.is_empty() {
        return Err("Send some text.".into());
    }
    let state = app.state::<AppState>();
    let (bot, session_id, created, kind) = {
        let store = state.store.lock().map_err(|e| e.to_string())?;
        let bot = super::get(&store, &inbound.bot_id)?;
        if !inbound.trusted && !channels::is_approved(&store, &inbound.channel_id, &inbound.sender_id)? {
            return Err("This sender is not paired with the bot.".into());
        }
        let kind = channel_kind(&store, &inbound.channel_id);
        let (session, created) = super::thread_session(&store, &bot, &inbound.channel_id, &inbound.thread, &format!("{} · {}", bot.name, inbound.sender_name))?;
        (bot, session, created, kind)
    };
    let waiting = pending().lock().map_err(|e| e.to_string())?.get(&session_id).is_some_and(|list| !list.is_empty());
    match parse_command(&text, waiting) {
        Command::Stop => {
            stop_bot(app, &bot.id).await;
            reply(app, &bot, &inbound.channel_id, &inbound.thread, "Stopped. I'll wait for your next message.").await;
            return Ok(session_id);
        }
        Command::Help => {
            reply(app, &bot, &inbound.channel_id, &inbound.thread, HELP).await;
            return Ok(session_id);
        }
        Command::NewThread => {
            {
                let store = state.store.lock().map_err(|e| e.to_string())?;
                store.db.execute("DELETE FROM bot_threads WHERE session_id=?1", [&session_id]).map_err(|e| e.to_string())?;
            }
            reply(app, &bot, &inbound.channel_id, &inbound.thread, "Starting a fresh conversation. What's next?").await;
            return Ok(session_id);
        }
        Command::Approve(approved, always) => {
            answer_approval(app, &bot, &session_id, approved, always).await?;
            return Ok(session_id);
        }
        Command::Message => {}
    }
    if bot.paused {
        reply(app, &bot, &inbound.channel_id, &inbound.thread, &format!("{} is paused. Resume it in PandaCode to continue.", bot.name)).await;
        return Err("This bot is paused.".into());
    }
    let turn = {
        let store = state.store.lock().map_err(|e| e.to_string())?;
        // Proactive messages go to the thread the user last wrote from.
        if inbound.channel_id != super::DESKTOP {
            super::set_notify_target(&store, &bot.id, Some(&inbound.channel_id), Some(&inbound.thread))?;
        }
        super::log(&store, &bot.id, "inbound", &format!("{} ({kind}): {}", inbound.sender_name, text.chars().take(160).collect::<String>()), json!({"channelId": inbound.channel_id, "sessionId": session_id, "new": created}))?;
        compose(&store, &bot, &session_id, &kind, &inbound.sender_name, &text)?
    };
    start_or_queue(app, &bot, &session_id, turn).await?;
    let _ = app.emit("bots-changed", ());
    let _ = app.emit("sessions-changed", ());
    Ok(session_id)
}

/// A schedule or check-in: one ongoing scheduled conversation per bot.
pub(crate) async fn run_scheduled(app: &tauri::AppHandle, bot_id: &str, label: &str, prompt: &str) -> Result<()> {
    let state = app.state::<AppState>();
    let (bot, session_id, turn) = {
        let store = state.store.lock().map_err(|e| e.to_string())?;
        let bot = super::get(&store, bot_id)?;
        if bot.paused {
            return Err("This bot is paused.".into());
        }
        let (session, _) = super::thread_session(&store, &bot, "schedule", "schedule", &format!("{} · Scheduled work", bot.name))?;
        super::log(&store, &bot.id, "scheduled", label, json!({"sessionId": session}))?;
        let turn = compose(&store, &bot, &session, "schedule", "", &format!("{label}\n\n{prompt}"))?;
        (bot, session, turn)
    };
    start_or_queue(app, &bot, &session_id, turn).await?;
    let _ = app.emit("bots-changed", ());
    Ok(())
}

/// The assistant's reply for the turn that just ended: messages after the last user prompt.
fn latest_reply(store: &Store, session_id: &str) -> Result<String> {
    let mut statement = store
        .db
        .prepare("SELECT content FROM messages WHERE session_id=?1 AND role='assistant' AND id > COALESCE((SELECT MAX(id) FROM messages WHERE session_id=?1 AND role='user'),0) ORDER BY id")
        .map_err(|e| e.to_string())?;
    let parts = statement.query_map([session_id], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())?;
    Ok(parts.join("\n\n").trim().to_owned())
}

pub(crate) async fn run_finished(app: &tauri::AppHandle, session_id: &str, successful: bool) {
    let state = app.state::<AppState>();
    let found = {
        let Ok(store) = state.store.lock() else { return };
        match owner_of(&store, session_id) {
            Ok(Some((bot, thread))) => Some((bot, thread, latest_reply(&store, session_id).unwrap_or_default())),
            _ => None,
        }
    };
    let Some((bot, thread, text)) = found else { return };
    if let Ok(mut map) = pending().lock() {
        map.remove(session_id);
    }
    let text = if text.is_empty() && !successful { "I couldn't finish that. Check PandaCode for details.".to_owned() } else { text };
    if thread.channel_id == "schedule" {
        if text.trim() == NOTHING || text.trim().is_empty() {
            if let Ok(store) = state.store.lock() {
                let _ = super::log(&store, &bot.id, "scheduled", "Nothing to report", json!({}));
            }
        } else {
            notify(app, &bot, &text).await;
        }
    } else if thread.channel_id != super::DESKTOP && !text.is_empty() {
        reply(app, &bot, &thread.channel_id, &thread.external_id, &text).await;
    }
    if let Ok(store) = state.store.lock() {
        let _ = super::log(&store, &bot.id, if successful { "reply" } else { "error" }, &text.chars().take(200).collect::<String>(), json!({"sessionId": session_id}));
    }
    let _ = app.emit("bots-changed", ());
    // Send the next queued message natively, so bot threads keep moving without the window.
    let next = state.store.lock().ok().and_then(|store| message_queue::list(&store, Some(session_id)).ok()).and_then(|queue| queue.into_iter().next());
    if let Some(entry) = next {
        let taken = state.store.lock().ok().and_then(|store| message_queue::take(&store, &entry.id).ok());
        if let Some(entry) = taken {
            let (text, images) = message_queue::prompt(&entry);
            let images = (!images.is_empty()).then_some(images);
            let launched = crate::launch_task_in_project(app.clone(), app.state::<AppState>(), session_id.to_owned(), Some(text), images, Some(bot.project_id.clone())).await;
            // A failed launch puts the message back at the front, so nothing is lost.
            if let Err(error) = launched {
                if let Ok(store) = state.store.lock() {
                    let _ = message_queue::requeue(&store, &entry);
                    let _ = super::log(&store, &bot.id, "error", &format!("Queued message held: {}", error.chars().take(160).collect::<String>()), json!({"sessionId": session_id}));
                }
            }
        }
    }
}

/// Answers an approval natively and clears its card in the desktop app.
async fn answer(app: &tauri::AppHandle, session_id: &str, request_id: &str, approved: bool) -> Result<()> {
    crate::respond_approval(app.state::<AppState>(), session_id.to_owned(), request_id.to_owned(), approved).await?;
    let event = crate::providers::AgentEvent { session_id: session_id.into(), kind: "approval_cancelled".into(), text: String::new(), request_id: Some(request_id.into()), data: None, tool: None };
    let _ = app.emit("agent-event", event);
    Ok(())
}

pub(crate) async fn approval_requested(app: &tauri::AppHandle, session_id: &str, request_id: &str, text: &str) {
    let state = app.state::<AppState>();
    let found = state.store.lock().ok().and_then(|store| owner_of(&store, session_id).ok().flatten());
    let Some((bot, thread)) = found else { return };
    // Allow rules answer without asking; deny rules refuse.
    let decision = state.store.lock().ok().and_then(|store| guard::decide(&store, &bot.id, text).ok());
    match decision {
        Some(guard::Decision::Allow) => {
            let _ = answer(app, session_id, request_id, true).await;
            if let Ok(store) = state.store.lock() {
                let _ = super::log(&store, &bot.id, "approval", &format!("Allowed by rule: {}", text.chars().take(160).collect::<String>()), json!({"sessionId": session_id}));
            }
            return;
        }
        Some(guard::Decision::Deny) => {
            let _ = answer(app, session_id, request_id, false).await;
            if let Ok(store) = state.store.lock() {
                let _ = super::log(&store, &bot.id, "approval", &format!("Denied by rule: {}", text.chars().take(160).collect::<String>()), json!({"sessionId": session_id}));
            }
            return;
        }
        _ => {}
    }
    if let Ok(mut map) = pending().lock() {
        map.entry(session_id.to_owned()).or_default().push((request_id.to_owned(), text.to_owned()));
    }
    if let Ok(store) = state.store.lock() {
        let _ = super::log(&store, &bot.id, "approval", &format!("Asked: {}", text.chars().take(160).collect::<String>()), json!({"sessionId": session_id}));
    }
    let message = format!("Approval needed: {}\nReply yes, no, or always (allow this kind of action from now on).", text.chars().take(600).collect::<String>());
    match thread.channel_id.as_str() {
        super::DESKTOP => {}
        "schedule" => notify(app, &bot, &message).await,
        channel => reply(app, &bot, channel, &thread.external_id, &message).await,
    }
    let _ = app.emit("bots-changed", ());
}

async fn answer_approval(app: &tauri::AppHandle, bot: &Bot, session_id: &str, approved: bool, always: bool) -> Result<()> {
    // Requests answered in the desktop app meanwhile are gone; skip to the oldest live one.
    loop {
        let next = pending().lock().map_err(|e| e.to_string())?.get_mut(session_id).and_then(|list| (!list.is_empty()).then(|| list.remove(0)));
        let Some((request_id, text)) = next else { return Err("Nothing is waiting for approval.".into()) };
        if answer(app, session_id, &request_id, approved).await.is_err() {
            continue;
        }
        if always && approved {
            let state = app.state::<AppState>();
            let added = state.store.lock().map_err(|e| e.to_string()).and_then(|store| guard::add_rule(&store, &bot.id, &guard::pattern_for(&text), "allow"));
            if let Err(error) = added {
                super::note(app, &bot.id, "error", &format!("Could not save the rule: {error}"), json!({}));
            }
        }
        let outcome = if !approved { "Denied" } else if always { "Always allowed" } else { "Approved" };
        super::note(app, &bot.id, "approval", &format!("{outcome}: {}", text.chars().take(160).collect::<String>()), json!({"sessionId": session_id}));
        return Ok(());
    }
}

/// Sends text to one thread, splitting it to fit the channel.
pub(crate) async fn reply(app: &tauri::AppHandle, bot: &Bot, channel_id: &str, thread: &str, text: &str) {
    if channel_id == super::DESKTOP {
        let _ = app.emit("bot-notification", json!({"botId": bot.id, "text": text}));
        return;
    }
    if let Err(error) = channels::send(app, channel_id, thread, text).await {
        super::note(app, &bot.id, "error", &format!("Could not send a reply: {error}"), json!({"channelId": channel_id}));
    }
}

/// A proactive message: to the bot's notification thread, and always to the desktop app.
pub(crate) async fn notify(app: &tauri::AppHandle, bot: &Bot, text: &str) {
    let _ = app.emit("bot-notification", json!({"botId": bot.id, "text": text}));
    if let (Some(channel), Some(thread)) = (&bot.notify_channel_id, &bot.notify_thread) {
        reply(app, bot, channel, thread, text).await;
    }
    super::note(app, &bot.id, "notify", &text.chars().take(200).collect::<String>(), json!({}));
}

/// Stops every running conversation of a bot.
pub(crate) async fn stop_bot(app: &tauri::AppHandle, bot_id: &str) {
    let sessions: Vec<String> = {
        let state = app.state::<AppState>();
        let Ok(store) = state.store.lock() else { return };
        super::threads(&store, bot_id).map(|threads| threads.into_iter().map(|thread| thread.session_id).collect()).unwrap_or_default()
    };
    for session in sessions {
        let running = app.state::<AppState>().agents.lock().map(|agents| agents.contains_key(&session)).unwrap_or(false);
        if running {
            let _ = crate::stop_session(app.clone(), app.state::<AppState>(), session.clone()).await;
        }
        if let Ok(mut map) = pending().lock() {
            map.remove(&session);
        }
    }
    super::note(app, bot_id, "stopped", "Stopped running work", json!({}));
}
