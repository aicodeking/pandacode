//! Local group conversations shared by bots. Channel records stay in the bot database;
//! assignments use each member's ordinary desktop task and the existing gateway queue.

use super::{gateway, Bot, DESKTOP};
use crate::{message_queue, storage::Store, AppState, Result};
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use tauri::{Emitter, Manager, State};

const MAX_NAME: usize = 48;
const MAX_TEXT: usize = 16 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedChannel {
    pub id: String,
    pub name: String,
    pub member_ids: Vec<String>,
    pub lead_bot_id: Option<String>,
    pub archived: bool,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedChannelMessage {
    pub id: String,
    pub kind: String,
    pub author_bot_id: Option<String>,
    pub text: String,
    pub status: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedChannelDetail {
    #[serde(flatten)]
    pub channel: SharedChannel,
    pub messages: Vec<SharedChannelMessage>,
    pub active_bot_ids: Vec<String>,
    /// Older rows exist beyond the `limit` returned.
    pub has_more: bool,
}

/// Channel history rows returned per page; the window asks for more as the user scrolls back.
pub(crate) const HISTORY_PAGE: usize = 100;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BotMessageMarker {
    pub id: String,
    /// `sent`, `received`, or `update`.
    pub kind: String,
    pub bot_id: String,
    pub bot_name: String,
    pub avatar: String,
    pub color: String,
    pub text: String,
    pub result: Option<String>,
    pub status: String,
    pub created_at: i64,
}

fn clean_name(value: &str) -> Result<String> {
    let name = value.trim().trim_start_matches('#').trim();
    if name.is_empty() || name.chars().count() > MAX_NAME || name.chars().any(char::is_control) {
        return Err("Use a channel name up to 48 characters.".into());
    }
    Ok(name.to_owned())
}

fn validate_members(store: &Store, members: &[String]) -> Result<Vec<String>> {
    if members.len() > 64 { return Err("A channel can have up to 64 bots.".into()); }
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for id in members {
        if !seen.insert(id.as_str()) { continue; }
        super::get(store, id)?;
        out.push(id.clone());
    }
    Ok(out)
}

/// Deterministic member routing. Explicit mentions win; otherwise the lead receives the post.
pub(crate) fn route_recipients(members: &[String], lead: Option<&str>, requested: &[String]) -> Result<Vec<String>> {
    let chosen = if requested.is_empty() {
        vec![lead.ok_or("Add a bot in channel settings before posting.")?.to_owned()]
    } else {
        requested.to_vec()
    };
    if chosen.len() > 2 { return Err("Mention up to two bots in one post.".into()); }
    let mut seen = HashSet::new();
    let mut recipients = Vec::new();
    for id in chosen {
        if !members.contains(&id) { return Err("Choose bots that belong to this channel.".into()); }
        if seen.insert(id.clone()) { recipients.push(id); }
    }
    if recipients.is_empty() { return Err("Choose a channel member to assign this post.".into()); }
    Ok(recipients)
}

fn member_ids(store: &Store, channel_id: &str) -> Result<Vec<String>> {
    let mut statement = store.db.prepare("SELECT bot_id FROM bot_shared_channel_members WHERE channel_id=?1 ORDER BY position,bot_id").map_err(|e| e.to_string())?;
    let rows = statement.query_map([channel_id], |row| row.get(0)).map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<_>>().map_err(|e| e.to_string())
}

fn shared_channel(store: &Store, id: &str) -> Result<SharedChannel> {
    let row: (String, String, Option<String>, bool, i64) = store.db.query_row(
        "SELECT id,name,lead_bot_id,archived,updated_at FROM bot_shared_channels WHERE id=?1", [id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
    ).optional().map_err(|e| e.to_string())?.ok_or("This channel no longer exists.")?;
    Ok(SharedChannel { id: row.0.clone(), name: row.1, lead_bot_id: row.2, archived: row.3, updated_at: row.4, member_ids: member_ids(store, &row.0)? })
}

pub(crate) fn list(store: &Store) -> Result<Vec<SharedChannel>> {
    let ids = {
        let mut statement = store.db.prepare("SELECT id FROM bot_shared_channels ORDER BY archived,name COLLATE NOCASE").map_err(|e| e.to_string())?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())?
    };
    ids.iter().map(|id| shared_channel(store, id)).collect()
}

pub(crate) fn create(store: &Store, raw_name: &str, requested: &[String]) -> Result<SharedChannel> {
    let name = clean_name(raw_name)?;
    let members = validate_members(store, requested)?;
    let id = crate::storage::id();
    let now = crate::storage::now();
    let lead = members.first().cloned();
    store.db.execute("INSERT INTO bot_shared_channels(id,name,lead_bot_id,created_at,updated_at) VALUES(?1,?2,?3,?4,?4)", params![id,name,lead,now]).map_err(|e| e.to_string())?;
    for (position, bot_id) in members.iter().enumerate() {
        store.db.execute("INSERT INTO bot_shared_channel_members(channel_id,bot_id,position) VALUES(?1,?2,?3)", params![id,bot_id,position as i64]).map_err(|e| e.to_string())?;
    }
    shared_channel(store, &id)
}

pub(crate) fn update(store: &Store, id: &str, raw_name: &str, requested: &[String], requested_lead: Option<&str>) -> Result<SharedChannel> {
    if shared_channel(store, id)?.archived { return Err("This channel is deleted. Restore it to change it.".into()); }
    let name = clean_name(raw_name)?;
    let members = validate_members(store, requested)?;
    if requested_lead.is_some_and(|lead| !members.iter().any(|id| id == lead)) {
        return Err("Choose a lead from the channel members.".into());
    }
    let lead = requested_lead.map(str::to_owned).or_else(|| members.first().cloned());
    let tx = store.db.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute("UPDATE bot_shared_channels SET name=?2,lead_bot_id=?3,updated_at=?4 WHERE id=?1", params![id,name,lead,crate::storage::now()]).map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM bot_shared_channel_members WHERE channel_id=?1", [id]).map_err(|e| e.to_string())?;
    for (position, bot_id) in members.iter().enumerate() {
        tx.execute("INSERT INTO bot_shared_channel_members(channel_id,bot_id,position) VALUES(?1,?2,?3)", params![id,bot_id,position as i64]).map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    shared_channel(store, id)
}

pub(crate) fn set_archived(store: &Store, id: &str, archived: bool) -> Result<()> {
    let changed = store.db.execute("UPDATE bot_shared_channels SET archived=?2,updated_at=?3 WHERE id=?1", params![id,archived,crate::storage::now()]).map_err(|e| e.to_string())?;
    if changed == 0 { return Err("This channel no longer exists.".into()); }
    Ok(())
}

/// The channel and its latest `limit` history rows (posts, replies and assignments), oldest first.
pub(crate) fn detail(store: &Store, id: &str, limit: usize) -> Result<SharedChannelDetail> {
    let limit = limit.clamp(1, 10_000);
    let channel = shared_channel(store, id)?;
    let mut messages = Vec::new();
    {
        let mut statement = store.db.prepare("SELECT id,kind,author_bot_id,text,status,created_at FROM bot_shared_channel_messages WHERE channel_id=?1 ORDER BY created_at DESC,id DESC LIMIT ?2").map_err(|e| e.to_string())?;
        let rows = statement.query_map(params![id,limit as i64+1], |r| Ok(SharedChannelMessage { id:r.get(0)?, kind:r.get(1)?, author_bot_id:r.get(2)?, text:r.get(3)?, status:r.get::<_,Option<String>>(4)?.map(status_label), created_at:r.get(5)? })).map_err(|e| e.to_string())?;
        messages.extend(rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())?);
    }
    {
        let mut statement = store.db.prepare("SELECT d.id,d.bot_id,b.name,d.status,d.created_at FROM bot_shared_channel_deliveries d JOIN bots b ON b.id=d.bot_id WHERE d.channel_id=?1 ORDER BY d.created_at DESC,d.id DESC LIMIT ?2").map_err(|e| e.to_string())?;
        let rows = statement.query_map(params![id,limit as i64+1], |r| {
            let bot_id: String = r.get(1)?; let bot_name: String = r.get(2)?;
            Ok(SharedChannelMessage { id:r.get(0)?, kind:"assigned".into(), author_bot_id:Some(bot_id), text:format!("Assigned to {bot_name}"), status:Some(status_label(r.get::<_,String>(3)?)), created_at:r.get(4)? })
        }).map_err(|e| e.to_string())?;
        messages.extend(rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())?);
    }
    messages.sort_by(|a,b| a.created_at.cmp(&b.created_at).then_with(|| {
        let rank = |kind: &str| match kind { "user" => 0, "assigned" => 1, "reply" => 2, _ => 3 };
        rank(&a.kind).cmp(&rank(&b.kind))
    }).then_with(|| a.id.cmp(&b.id)));
    let has_more = messages.len() > limit;
    let messages = messages.split_off(messages.len().saturating_sub(limit));
    let active_bot_ids = {
        let mut statement=store.db.prepare("SELECT DISTINCT bot_id FROM bot_shared_channel_deliveries WHERE channel_id=?1 AND status='in_progress' ORDER BY bot_id").map_err(|e|e.to_string())?;
        let rows=statement.query_map([id],|r|r.get(0)).map_err(|e|e.to_string())?;
        rows.collect::<rusqlite::Result<_>>().map_err(|e|e.to_string())?
    };
    Ok(SharedChannelDetail { channel, messages, active_bot_ids, has_more })
}

fn status_label(status: String) -> String {
    match status.as_str() { "queued" => "Queued", "in_progress" => "In progress", "completed" => "Completed", "failed" => "Failed", "stopped" => "Stopped", _ => "Failed" }.into()
}

/// A post's status from its deliveries. A stop or failure is superseded by any attempt made
/// after it (Continue or Reassign), and a post left with no deliveries (its bot was deleted) is
/// stopped, so it can be continued.
fn message_status(store: &Store, message_id: &str) -> Result<String> {
    let rows: Vec<(String, i64, i64)> = {
        let mut statement = store.db.prepare("SELECT status,created_at,updated_at FROM bot_shared_channel_deliveries WHERE message_id=?1 ORDER BY created_at,id").map_err(|e| e.to_string())?;
        let rows=statement.query_map([message_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(|e|e.to_string())?;
        rows.collect::<rusqlite::Result<_>>().map_err(|e|e.to_string())?
    };
    if rows.is_empty() { return Ok("stopped".into()); }
    let statuses: Vec<&str> = rows.iter()
        .filter(|(status, _, ended_at)| !matches!(status.as_str(), "stopped" | "failed") || !rows.iter().any(|(_, created, _)| created > ended_at))
        .map(|(status, _, _)| status.as_str()).collect();
    let status = if statuses.contains(&"in_progress") { "in_progress" }
        else if statuses.contains(&"queued") { "queued" }
        else if statuses.contains(&"failed") { "failed" }
        else if statuses.contains(&"stopped") { "stopped" }
        else { "completed" };
    Ok(status.into())
}

fn update_message_status(store: &Store, message_id: &str) -> Result<()> {
    let status = message_status(store, message_id)?;
    store.db.execute("UPDATE bot_shared_channel_messages SET status=?2 WHERE id=?1", params![message_id,status]).map_err(|e| e.to_string())?;
    Ok(())
}

/// Posts with unfinished work for `bot_id`, read before a reset or delete cascades its deliveries away.
pub(crate) fn open_posts(store: &Store, bot_id: &str) -> Result<Vec<String>> {
    let mut statement = store.db.prepare("SELECT DISTINCT message_id FROM bot_shared_channel_deliveries WHERE bot_id=?1 AND status IN ('queued','in_progress')").map_err(|e| e.to_string())?;
    let rows = statement.query_map([bot_id], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<_>>().map_err(|e| e.to_string())
}

/// Recomputes those posts once the cascade is done, so none stays In progress with nothing behind it.
pub(crate) fn settle_posts(store: &Store, message_ids: &[String]) -> Result<()> {
    for id in message_ids { update_message_status(store, id)?; }
    Ok(())
}

/// Runs are not restored for bot deliveries, so a process restart must not leave
/// old assignments permanently marked as active.
pub(crate) fn reconcile_in_progress(store: &Store) -> Result<()> {
    store.db.execute("UPDATE bot_messages SET status='failed',result='Interrupted when PandaCode closed.',updated_at=?1 WHERE status='in_progress'", [crate::storage::now()]).map_err(|e| e.to_string())?;
    store.db.execute("UPDATE bot_shared_channel_deliveries SET status='failed',updated_at=?1 WHERE status='in_progress'", [crate::storage::now()]).map_err(|e| e.to_string())?;
    // A queued assignment whose queue entry is gone was taken just before PandaCode closed.
    let queued: Vec<(String,String,String,String)> = {
        let mut statement = store.db.prepare("SELECT d.id,d.session_id,c.name,m.text FROM bot_shared_channel_deliveries d JOIN bot_shared_channel_messages m ON m.id=d.message_id JOIN bot_shared_channels c ON c.id=d.channel_id WHERE d.status='queued'").map_err(|e| e.to_string())?;
        let rows = statement.query_map([], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).map_err(|e| e.to_string())?;
        rows.collect::<rusqlite::Result<_>>().map_err(|e| e.to_string())?
    };
    for (id, session_id, name, text) in queued {
        let prefix = format!("Work requested in #{name}:");
        if !message_queue::list(store, Some(&session_id))?.iter().any(|item| prompt_matches(&item.text, &prefix, &text)) {
            store.db.execute("UPDATE bot_shared_channel_deliveries SET status='failed',updated_at=?2 WHERE id=?1", params![id,crate::storage::now()]).map_err(|e| e.to_string())?;
        }
    }
    let messages = {
        let mut statement = store.db.prepare("SELECT id FROM bot_shared_channel_messages WHERE kind='user' AND status IN ('queued','in_progress')").map_err(|e| e.to_string())?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())?
    };
    for id in messages { update_message_status(store, &id)?; }
    Ok(())
}

/// The post, then the channel's latest other posts and replies, so the assigned bot can build on
/// what the user and other members already said.
fn text_for_assignment(channel: &SharedChannel, text: &str, history: &str) -> String {
    if history.is_empty() { return format!("Work requested in #{}:\n\n{}", channel.name, text); }
    format!("Work requested in #{}:\n\n{}\n\nRecent messages in #{} (context, oldest first):\n{}", channel.name, text, channel.name, history)
}

const HISTORY_CONTEXT: usize = 8;
const HISTORY_CHARS: usize = 600;

/// The channel's latest posts and replies other than `message_id`, oldest first, one per line.
pub(crate) fn recent_history(store: &Store, channel_id: &str, message_id: &str) -> Result<String> {
    let mut statement = store.db.prepare("SELECT b.name,m.text FROM bot_shared_channel_messages m LEFT JOIN bots b ON b.id=m.author_bot_id WHERE m.channel_id=?1 AND m.id<>?2 AND m.kind IN ('user','reply') ORDER BY m.created_at DESC,m.id DESC LIMIT ?3").map_err(|e| e.to_string())?;
    let rows = statement.query_map(params![channel_id,message_id,HISTORY_CONTEXT as i64], |r| Ok((r.get::<_,Option<String>>(0)?, r.get::<_,String>(1)?))).map_err(|e| e.to_string())?;
    let mut lines = rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())?.into_iter().map(|(author, text)| {
        let text: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
        let clipped: String = text.chars().take(HISTORY_CHARS).collect();
        format!("- {}: {}{}", author.unwrap_or_else(|| "You".into()), clipped, if clipped.len() < text.len() { "…" } else { "" })
    }).collect::<Vec<_>>();
    lines.reverse();
    Ok(lines.join("\n"))
}

fn prompt_matches(content: &str, sender_prefix: &str, text: &str) -> bool {
    let Some((header, body)) = content.split_once("\n\n") else { return false };
    if !header.starts_with(sender_prefix) { return false; }
    body == text || body.strip_prefix(text).is_some_and(|suffix| suffix.starts_with("\n\n"))
}

/// `created_at` is shared by every delivery of one post or retry, so a failure early in a
/// post's fan-out never counts as superseded by its sibling (see `message_status`).
async fn send_channel_assignment(app: &tauri::AppHandle, channel_id: &str, message_id: &str, bot_id: &str, text: &str, created_at: i64) -> Result<()> {
    let state = app.state::<AppState>();
    // The delivery starts queued; the gateway marks it in progress when its turn launches
    // (`promote_taken`), so a finished run is credited only to the work it actually ran.
    let delivery_id = crate::storage::id();
    let (channel, bot, history) = {
        let store = state.store.lock().map_err(|e| e.to_string())?;
        let channel = shared_channel(&store, channel_id)?;
        if channel.archived { return Err("This channel is deleted.".into()); }
        if !channel.member_ids.iter().any(|id| id == bot_id) { return Err("Choose a bot that belongs to this channel.".into()); }
        let bot = super::get(&store, bot_id)?;
        if bot.paused { return Err(format!("{} is paused.", bot.name)); }
        let (session_id, _) = super::thread_session(&store, &bot, DESKTOP, DESKTOP, &format!("{} · You", bot.name))?;
        let history = recent_history(&store, channel_id, message_id)?;
        store.db.execute("INSERT INTO bot_shared_channel_deliveries(id,channel_id,message_id,bot_id,session_id,status,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,'queued',?6,?6)", params![delivery_id,channel_id,message_id,bot_id,session_id,created_at]).map_err(|e| e.to_string())?;
        (channel, bot, history)
    };
    let inbound = gateway::Inbound { bot_id: bot.id.clone(), channel_id: DESKTOP.into(), thread: DESKTOP.into(), sender_id: format!("channel:{channel_id}"), sender_name: format!("#{}", channel.name), text: text_for_assignment(&channel, text, &history), trusted: true, image_ids: None, moodboard_ids: None };
    if let Err(error) = gateway::deliver(app, inbound).await {
        let store = state.store.lock().map_err(|e| e.to_string())?;
        store.db.execute("UPDATE bot_shared_channel_deliveries SET status='failed',updated_at=?2 WHERE id=?1 AND status IN ('queued','in_progress')", params![delivery_id,crate::storage::now()]).map_err(|e|e.to_string())?;
        update_message_status(&store, message_id)?;
        return Err(error);
    }
    // A Stop, archive or member removal that landed while this was being handed over found no
    // queue entry or run yet; stop what the hand-over just queued or started.
    // If the hand-over already launched the turn, stop that run directly: its queue entry is gone,
    // so re-queuing the row would let `stop_pending` miss the live session.
    let stopped_session: Option<String> = state.store.lock().map_err(|e| e.to_string())
        .and_then(|store| store.db.query_row("SELECT session_id FROM bot_shared_channel_deliveries WHERE id=?1 AND status='stopped'", [&delivery_id], |r| r.get(0)).optional().map_err(|e| e.to_string()))?;
    if let Some(session_id) = stopped_session {
        let running = state.agents.lock().map_err(|e| e.to_string())?.contains_key(&session_id);
        if running {
            let _ = crate::stop_session(app.clone(), app.state::<AppState>(), session_id).await;
        } else {
            state.store.lock().map_err(|e| e.to_string())
                .and_then(|store| store.db.execute("UPDATE bot_shared_channel_deliveries SET status='queued' WHERE id=?1 AND status='stopped'", [&delivery_id]).map_err(|e| e.to_string()))?;
            stop_pending(app, channel_id, Some(&[bot_id.to_owned()])).await?;
        }
    }
    let _ = app.emit("bot-shared-channel-changed", serde_json::json!({"channelId":channel_id}));
    Ok(())
}

pub(crate) async fn deliver_bot_message(app: &tauri::AppHandle, source: &Bot, source_thread: &super::Thread, target: &Bot, text: &str, depth: u8) -> Result<String> {
    let text = text.trim();
    if text.is_empty() { return Err("Write a message for the other bot.".into()); }
    if text.chars().count() > MAX_TEXT { return Err("Keep bot messages under 16,384 characters.".into()); }
    let state = app.state::<AppState>();
    let session_id = {
        let store = state.store.lock().map_err(|e| e.to_string())?;
        let (session, _) = super::thread_session(&store, target, DESKTOP, DESKTOP, &format!("{} · You", target.name))?;
        session
    };
    // Queued until the gateway launches its turn (`promote_taken`).
    let id = crate::storage::id();
    {
        let store = state.store.lock().map_err(|e| e.to_string())?;
        store.db.execute("INSERT INTO bot_messages(id,source_bot_id,target_bot_id,source_session_id,target_session_id,source_channel_id,source_external_id,text,status,depth,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,'queued',?9,?10,?10)", params![id,source.id,target.id,source_thread.session_id,session_id,source_thread.channel_id,source_thread.external_id,text,depth as i64,crate::storage::now()]).map_err(|e| e.to_string())?;
    }
    let inbound = gateway::Inbound { bot_id: target.id.clone(), channel_id: DESKTOP.into(), thread: DESKTOP.into(), sender_id: format!("bot:{}", source.id), sender_name: format!("Message from {}", source.name), text: format!("Message from {}:\n\n{}", source.name, text), trusted: true, image_ids: None, moodboard_ids: None };
    if let Err(error) = gateway::deliver(app, inbound).await {
        if let Ok(store) = state.store.lock() { let _ = store.db.execute("UPDATE bot_messages SET status='failed',updated_at=?2 WHERE id=?1", params![id,crate::storage::now()]); }
        let _=app.emit("bot-messages-changed", ());
        return Err(error);
    }
    let _ = app.emit("bot-messages-changed", ());
    let _ = app.emit("bots-changed", ());
    Ok(id)
}

pub(crate) fn current_hop_depth(store: &Store, session_id: &str) -> Result<u8> {
    let direct: i64 = store.db.query_row("SELECT COALESCE(MAX(depth),0) FROM bot_messages WHERE target_session_id=?1 AND status='in_progress'", [session_id], |r| r.get(0)).map_err(|e| e.to_string())?;
    let channel: i64 = store.db.query_row("SELECT COALESCE(MAX(d.depth),0) FROM bot_shared_channel_deliveries d WHERE d.session_id=?1 AND d.status='in_progress'", [session_id], |r| r.get(0)).map_err(|e| e.to_string())?;
    // A delegated bot's result becomes a new user message in the sender's ordinary task.
    // Recover that request's depth from the matching "Update from …" message so a queued
    // follow-up cannot reset the three-hop guard when a reply starts another turn.
    let latest_user: Option<String> = store.db.query_row("SELECT content FROM messages WHERE session_id=?1 AND role='user' ORDER BY id DESC LIMIT 1", [session_id], |r| r.get(0)).optional().map_err(|e| e.to_string())?;
    let update_depth = if let Some(content) = latest_user {
        let mut statement = store.db.prepare("SELECT b.name,m.result,m.depth FROM bot_messages m JOIN bots b ON b.id=m.target_bot_id WHERE m.source_session_id=?1 AND m.result IS NOT NULL ORDER BY m.updated_at DESC").map_err(|e| e.to_string())?;
        let rows = statement.query_map([session_id], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,i64>(2)?))).map_err(|e| e.to_string())?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())?.into_iter().find_map(|(name,result,depth)| {
            content.starts_with(&format!("Update from {name}:\n\n{result}")).then_some(depth)
        }).unwrap_or(0)
    } else { 0 };
    Ok(direct.max(channel).max(update_depth).clamp(0, 3) as u8)
}

pub(crate) fn markers(store: &Store, session_id: &str) -> Result<Vec<BotMessageMarker>> {
    let sql = "SELECT m.id,'sent',b.id,b.name,b.avatar,b.color,m.text,m.result,m.status,m.created_at FROM bot_messages m JOIN bots b ON b.id=m.target_bot_id WHERE m.source_session_id=?1 \
      UNION ALL SELECT m.id,'received',b.id,b.name,b.avatar,b.color,m.text,NULL,m.status,m.created_at FROM bot_messages m JOIN bots b ON b.id=m.source_bot_id WHERE m.target_session_id=?1 \
      UNION ALL SELECT m.id,'update',b.id,b.name,b.avatar,b.color,m.result,m.result,m.status,m.updated_at FROM bot_messages m JOIN bots b ON b.id=m.target_bot_id WHERE m.source_session_id=?1 AND m.result IS NOT NULL AND trim(m.result)<>'' \
      ORDER BY 10,1,2";
    let mut statement=store.db.prepare(sql).map_err(|e|e.to_string())?;
    let rows=statement.query_map([session_id],|r|Ok(BotMessageMarker{id:r.get(0)?,kind:r.get(1)?,bot_id:r.get(2)?,bot_name:r.get(3)?,avatar:r.get(4)?,color:r.get(5)?,text:r.get(6)?,result:r.get(7)?,status:status_label(r.get(8)?),created_at:r.get(9)?})).map_err(|e|e.to_string())?;
    rows.collect::<rusqlite::Result<_>>().map_err(|e|e.to_string())
}

pub(crate) fn latest_reply(store: &Store, session_id: &str) -> Result<String> {
    let mut statement=store.db.prepare("SELECT content FROM messages WHERE session_id=?1 AND role='assistant' AND id>COALESCE((SELECT MAX(id) FROM messages WHERE session_id=?1 AND role='user'),0) ORDER BY id").map_err(|e|e.to_string())?;
    let rows=statement.query_map([session_id],|r|r.get::<_,String>(0)).map_err(|e|e.to_string())?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|e|e.to_string())?.join("\n\n").trim().to_owned())
}

/// Finalize the assignment whose turn just ended, copy its result into the channel or sender
/// thread, then promote the next queued collaboration request if the ordinary gateway started it.
pub(crate) async fn run_finished(app: &tauri::AppHandle, session_id: &str, successful: bool, reply: &str) {
    let state=app.state::<AppState>();
    // The request this run carried; with none recorded (an older run), the oldest active one.
    let tracked = take_running(session_id);
    let (message_id, delivery_id) = match &tracked { Some(Running::Message(id)) => (Some(id.as_str()),None), Some(Running::Delivery(id)) => (None,Some(id.as_str())), None => (None,None) };
    let direct = if delivery_id.is_some() { None } else {
        let Ok(store)=state.store.lock() else { return };
        store.db.query_row("SELECT id,source_bot_id,target_bot_id,source_channel_id,source_external_id FROM bot_messages WHERE target_session_id=?1 AND status='in_progress' AND (?2 IS NULL OR id=?2) ORDER BY created_at,id LIMIT 1", params![session_id,message_id], |r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?))).optional().ok().flatten()
    };
    let channel = if message_id.is_some() { None } else {
        let Ok(store)=state.store.lock() else { return };
        store.db.query_row("SELECT id,channel_id,message_id,bot_id FROM bot_shared_channel_deliveries WHERE session_id=?1 AND status='in_progress' AND (?2 IS NULL OR id=?2) ORDER BY created_at,id LIMIT 1", params![session_id,delivery_id], |r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?))).optional().ok().flatten()
    };
    if let Some((id,source_bot_id,target_bot_id,source_channel_id,source_external_id)) = direct {
        let result = if !successful { "I couldn't finish that message. Check PandaCode for details." } else if reply.trim().is_empty() { "The bot finished without a text reply." } else { reply.trim() };
        let source_bot = state.store.lock().ok().and_then(|store| super::get(&store,&source_bot_id).ok());
        let target_bot = state.store.lock().ok().and_then(|store| super::get(&store,&target_bot_id).ok());
        if let Ok(store)=state.store.lock() {
            let status=if successful {"completed"} else {"failed"};
            let _=store.db.execute("UPDATE bot_messages SET status=?2,result=?3,updated_at=?4 WHERE id=?1",params![id,status,result,crate::storage::now()]);
        }
        if let (Some(source),Some(target))=(source_bot,target_bot) {
            let text=format!("Update from {}:\n\n{}",target.name,result);
            let _=gateway::deliver(app,gateway::Inbound{bot_id:source.id,channel_id:source_channel_id,thread:source_external_id,sender_id:format!("bot-update:{id}"),sender_name:format!("Update from {}",target.name),text,trusted:true,image_ids:None,moodboard_ids:None}).await;
        }
        let _=app.emit("bot-messages-changed",());
    }
    if let Some((delivery_id,channel_id,message_id,bot_id)) = channel {
        let store = match state.store.lock() { Ok(store)=>store, Err(_)=>return };
        let status=if successful {"completed"} else {"failed"};
        let _=store.db.execute("UPDATE bot_shared_channel_deliveries SET status=?2,updated_at=?3 WHERE id=?1",params![delivery_id,status,crate::storage::now()]);
        if successful && !reply.trim().is_empty() {
            let _=store.db.execute("INSERT INTO bot_shared_channel_messages(id,channel_id,kind,author_bot_id,text,created_at) VALUES(?1,?2,'reply',?3,?4,?5)",params![crate::storage::id(),channel_id,bot_id,reply.trim(),crate::storage::now()]);
        }
        let _=update_message_status(&store,&message_id);
        let _=app.emit("bot-shared-channel-changed",serde_json::json!({"channelId":channel_id}));
    }
    // The window may have sent the next queued entry itself; credit it to its request.
    let running=state.agents.lock().map(|agents|agents.contains_key(session_id)).unwrap_or(false);
    if running {
        if let Ok(store)=state.store.lock() {
            let current:Option<String>=store.db.query_row("SELECT content FROM messages WHERE session_id=?1 AND role='user' ORDER BY id DESC LIMIT 1",[session_id],|r|r.get(0)).optional().ok().flatten();
            if let Some(current)=current { promote_taken(&store,session_id,&current); }
        }
    }
    let _=app.emit("bot-messages-changed",());
}

#[tauri::command]
pub async fn bot_shared_channels(state: State<'_,AppState>) -> Result<Vec<SharedChannel>> {
    let store = state.store.lock().map_err(|e|e.to_string())?;
    list(&store)
}

#[tauri::command]
pub async fn bot_shared_channel_detail(state: State<'_,AppState>, channel_id:String, limit:Option<usize>) -> Result<SharedChannelDetail> {
    let store = state.store.lock().map_err(|e|e.to_string())?;
    detail(&store,&channel_id,limit.unwrap_or(HISTORY_PAGE))
}

#[tauri::command]
pub async fn bot_shared_channel_create(app:tauri::AppHandle,state:State<'_,AppState>,name:String,member_ids:Vec<String>) -> Result<SharedChannel> {
    let store = state.store.lock().map_err(|e|e.to_string())?;
    let channel=create(&store,&name,&member_ids)?;
    drop(store);
    let _=app.emit("bot-shared-channel-changed",serde_json::json!({"channelId":channel.id}));
    Ok(channel)
}

#[tauri::command]
pub async fn bot_shared_channel_update(app:tauri::AppHandle,state:State<'_,AppState>,channel_id:String,name:String,member_ids:Vec<String>,lead_bot_id:Option<String>) -> Result<SharedChannel> {
    let (channel,removed)={
        let store = state.store.lock().map_err(|e|e.to_string())?;
        let before=shared_channel(&store,&channel_id)?.member_ids;
        let channel=update(&store,&channel_id,&name,&member_ids,lead_bot_id.as_deref())?;
        let removed:Vec<String>=before.into_iter().filter(|id| !channel.member_ids.contains(id)).collect();
        (channel,removed)
    };
    // A removed member's pending work stops; its posts can be continued by the others.
    if !removed.is_empty() { stop_pending(&app,&channel_id,Some(&removed)).await?; }
    let _=app.emit("bot-shared-channel-changed",serde_json::json!({"channelId":channel.id}));
    Ok(channel)
}

#[tauri::command]
pub async fn bot_shared_channel_archive(app:tauri::AppHandle,state:State<'_,AppState>,channel_id:String,archived:bool) -> Result<()> {
    // Archive first, so no post is admitted while its pending work stops.
    set_archived(&*state.store.lock().map_err(|e|e.to_string())?,&channel_id,archived)?;
    if archived { stop_pending(&app,&channel_id,None).await?; }
    let _=app.emit("bot-shared-channel-changed",serde_json::json!({"channelId":channel_id}));
    Ok(())
}

#[tauri::command]
pub async fn bot_shared_channel_post(app:tauri::AppHandle,state:State<'_,AppState>,channel_id:String,text:String,recipients:Option<Vec<String>>) -> Result<()> {
    let text=text.trim().to_owned();
    if text.is_empty() || text.chars().count()>MAX_TEXT { return Err("Write a channel message under 16,384 characters.".into()); }
    let (channel,message_id,recipients)={
        let store=state.store.lock().map_err(|e|e.to_string())?;
        let channel=shared_channel(&store,&channel_id)?;
        if channel.archived { return Err("This channel is deleted.".into()); }
        let recipients=route_recipients(&channel.member_ids,channel.lead_bot_id.as_deref(),recipients.as_deref().unwrap_or_default())?;
        let message_id=crate::storage::id();
        store.db.execute("INSERT INTO bot_shared_channel_messages(id,channel_id,kind,text,status,created_at) VALUES(?1,?2,'user',?3,'in_progress',?4)",params![message_id,channel_id,text,crate::storage::now()]).map_err(|e|e.to_string())?;
        (channel,message_id,recipients)
    };
    let posted_at=crate::storage::now();
    for bot_id in recipients {
        if let Err(error)=send_channel_assignment(&app,&channel_id,&message_id,&bot_id,&text,posted_at).await {
            if let Ok(store)=state.store.lock() {
                // send_channel_assignment already recorded the failure once it had a delivery row.
                let _=store.db.execute("INSERT INTO bot_shared_channel_deliveries(id,channel_id,message_id,bot_id,session_id,status,created_at,updated_at) SELECT ?1,?2,?3,?4,session_id,'failed',?5,?5 FROM bot_threads WHERE bot_id=?4 AND channel_id=?6 AND NOT EXISTS (SELECT 1 FROM bot_shared_channel_deliveries WHERE message_id=?3 AND bot_id=?4) LIMIT 1",params![crate::storage::id(),channel_id,message_id,bot_id,posted_at,DESKTOP]);
                let _=update_message_status(&store,&message_id);
            }
            super::note(&app,&bot_id,"error",&format!("Channel assignment failed: {}",error.chars().take(160).collect::<String>()),serde_json::json!({"channelId":channel.id,"messageId":message_id}));
        }
    }
    {
        let store=state.store.lock().map_err(|e|e.to_string())?;
        update_message_status(&store,&message_id)?;
    }
    let _=app.emit("bot-shared-channel-changed",serde_json::json!({"channelId":channel_id}));
    Ok(())
}

/// Stops a channel's unfinished deliveries (only `bots`' ones, when given). A queued assignment
/// leaves its bot's queue; one already taken from the queue or running stops that bot's turn
/// when the turn is this assignment. The records stay, marked stopped.
async fn stop_pending(app:&tauri::AppHandle,channel_id:&str,bots:Option<&[String]>) -> Result<()> {
    let state=app.state::<AppState>();
    let mut cancelled_holds=false;
    let stop_sessions: HashSet<String>={
        let running: HashSet<String> = state.agents.lock().map_err(|e|e.to_string())?.keys().cloned().collect();
        let store=state.store.lock().map_err(|e|e.to_string())?;
        let channel=shared_channel(&store,channel_id)?;
        let deliveries: Vec<(String,String,String,String,String,String)> = {
            let mut statement=store.db.prepare("SELECT d.id,d.message_id,d.session_id,d.status,m.text,d.bot_id FROM bot_shared_channel_deliveries d JOIN bot_shared_channel_messages m ON m.id=d.message_id WHERE d.channel_id=?1 AND d.status IN ('queued','in_progress') ORDER BY d.created_at,d.id").map_err(|e|e.to_string())?;
            let rows=statement.query_map([channel_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).map_err(|e|e.to_string())?;
            rows.collect::<rusqlite::Result<_>>().map_err(|e|e.to_string())?
        };
        let assignment_prefix=format!("Work requested in #{}:",channel.name);
        let mut stop_sessions=HashSet::new();
        let mut stopped_messages=HashSet::new();
        for (delivery_id,message_id,session_id,status,text,bot_id) in deliveries {
            if bots.is_some_and(|bots| !bots.contains(&bot_id)) { continue; }
            let queued = if status == "queued" { message_queue::list(&store,Some(&session_id))?.into_iter().find(|item| prompt_matches(&item.text,&assignment_prefix,&text)) } else { None };
            if let Some(queued) = queued {
                let _=message_queue::remove(&store,&queued.id);
            } else if status == "in_progress" {
                let latest: Option<String> = store.db.query_row("SELECT content FROM messages WHERE session_id=?1 AND role='user' ORDER BY id DESC LIMIT 1", [&session_id], |r|r.get(0)).optional().map_err(|e|e.to_string())?;
                if latest.as_deref().is_some_and(|content| prompt_matches(content,&assignment_prefix,&text)) {
                    if running.contains(&session_id) {
                        stop_sessions.insert(session_id.clone());
                    } else {
                        // Held by failover: no run will end for it, so drop the hold and its card.
                        forget(&session_id,&Running::Delivery(delivery_id.clone()));
                        super::failover::cancel(&session_id);
                        store.set_resume_at_reset(&session_id,false)?;
                        cancelled_holds=true;
                    }
                }
            }
            store.db.execute("UPDATE bot_shared_channel_deliveries SET status='stopped',updated_at=?2 WHERE id=?1",params![delivery_id,crate::storage::now()]).map_err(|e|e.to_string())?;
            stopped_messages.insert(message_id);
        }
        for message_id in &stopped_messages { update_message_status(&store,message_id)?; }
        stop_sessions
    };
    for id in stop_sessions { let _=crate::stop_session(app.clone(),app.state::<AppState>(),id).await; }
    if cancelled_holds { let _=app.emit("bot-messages-changed",()); let _=app.emit("sessions-changed",()); }
    Ok(())
}

/// Marks the queued bot message or channel delivery a turn about to launch (or a just-taken queue
/// entry) belongs to as in progress, in the same store lock as the launch or take, so Stop never
/// sees it queued with no queue row and a finished run is credited to the work it ran. Returns
/// the request, also recorded as the session's next running request for `run_finished`.
pub(crate) fn promote_taken(store: &Store, session_id: &str, text: &str) -> Option<Running> {
    let promoted = promote(store, session_id, text)?;
    if let Ok(mut map) = running().lock() { map.entry(session_id.to_owned()).or_default().push(promoted.clone()); }
    Some(promoted)
}

/// A bot request a turn carries: a `bot_messages` id or a channel delivery id.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Running { Message(String), Delivery(String) }

/// Requests promoted per session, oldest first; each finished run settles the first one.
fn running() -> &'static Mutex<HashMap<String, Vec<Running>>> {
    static RUNNING: std::sync::OnceLock<Mutex<HashMap<String, Vec<Running>>>> = std::sync::OnceLock::new();
    RUNNING.get_or_init(Default::default)
}

fn forget(session_id: &str, request: &Running) {
    if let Ok(mut map) = running().lock() {
        if let Some(list) = map.get_mut(session_id) { list.retain(|item| item != request); if list.is_empty() { map.remove(session_id); } }
    }
}

fn take_running(session_id: &str) -> Option<Running> {
    let mut map = running().lock().ok()?;
    let list = map.get_mut(session_id)?;
    let first = (!list.is_empty()).then(|| list.remove(0));
    if list.is_empty() { map.remove(session_id); }
    first
}

/// A promoted request whose turn did not launch goes back to queued (its queue entry is
/// restored or its sender settles it), so Stop finds it and no later run is credited with it.
pub(crate) fn launch_failed(store: &Store, session_id: &str, request: &Running) {
    forget(session_id, request);
    let now = crate::storage::now();
    match request {
        Running::Message(id) => { let _ = store.db.execute("UPDATE bot_messages SET status='queued',updated_at=?2 WHERE id=?1 AND status='in_progress'", params![id,now]); }
        Running::Delivery(id) => {
            let _ = store.db.execute("UPDATE bot_shared_channel_deliveries SET status='queued',updated_at=?2 WHERE id=?1 AND status='in_progress'", params![id,now]);
            let message_id: Option<String> = store.db.query_row("SELECT message_id FROM bot_shared_channel_deliveries WHERE id=?1",[id],|r|r.get(0)).ok();
            if let Some(message_id) = message_id { let _ = update_message_status(store,&message_id); }
        }
    }
}

fn promote(store: &Store, session_id: &str, text: &str) -> Option<Running> {
    let direct: Vec<(String,String)> = store.db.prepare("SELECT id,text FROM bot_messages WHERE target_session_id=?1 AND status='queued' ORDER BY created_at,id").ok()
        .and_then(|mut statement| statement.query_map([session_id],|r|Ok((r.get(0)?,r.get(1)?))).ok().and_then(|rows| rows.collect::<rusqlite::Result<Vec<_>>>().ok())).unwrap_or_default();
    if let Some(id) = direct.into_iter().find_map(|(id,body)| prompt_matches(text,"Message from ",&body).then_some(id)) {
        let _ = store.db.execute("UPDATE bot_messages SET status='in_progress',updated_at=?2 WHERE id=?1 AND status='queued'",params![id,crate::storage::now()]);
        return Some(Running::Message(id));
    }
    let rows: Vec<(String,String,String)> = store.db.prepare("SELECT d.id,c.name,m.text FROM bot_shared_channel_deliveries d JOIN bot_shared_channel_messages m ON m.id=d.message_id JOIN bot_shared_channels c ON c.id=d.channel_id WHERE d.session_id=?1 AND d.status='queued' ORDER BY d.created_at,d.id").ok()
        .and_then(|mut statement| statement.query_map([session_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).ok().and_then(|rows| rows.collect::<rusqlite::Result<Vec<_>>>().ok())).unwrap_or_default();
    let id = rows.into_iter().find_map(|(id,name,body)| prompt_matches(text,&format!("Work requested in #{name}:"),&body).then_some(id))?;
    store.db.execute("UPDATE bot_shared_channel_deliveries SET status='in_progress',updated_at=?2 WHERE id=?1 AND status='queued'",params![id,crate::storage::now()]).ok()?;
    let message_id: Option<String> = store.db.query_row("SELECT message_id FROM bot_shared_channel_deliveries WHERE id=?1",[&id],|r|r.get(0)).ok();
    if let Some(message_id) = message_id { let _ = update_message_status(store,&message_id); }
    Some(Running::Delivery(id))
}

/// Whether a channel delivery was stopped, e.g. between its queue entry being taken and its turn starting.
pub(crate) fn delivery_stopped(store: &Store, request: &Running) -> bool {
    let Running::Delivery(id) = request else { return false };
    store.db.query_row("SELECT status='stopped' FROM bot_shared_channel_deliveries WHERE id=?1",[id],|r|r.get(0)).unwrap_or(false)
}

#[tauri::command]
pub async fn bot_shared_channel_stop(app:tauri::AppHandle,channel_id:String) -> Result<()> {
    stop_pending(&app,&channel_id,None).await?;
    let _=app.emit("bot-shared-channel-changed",serde_json::json!({"channelId":channel_id}));
    Ok(())
}

async fn continue_message(app:&tauri::AppHandle,state:&tauri::State<'_,AppState>,channel_id:&str,message_id:&str,requested_bot:Option<&str>) -> Result<()> {
    let (channel,text,bot_id)={
        let store=state.store.lock().map_err(|e|e.to_string())?;
        let channel=shared_channel(&store,channel_id)?;
        if channel.archived { return Err("This channel is deleted.".into()); }
        let (text,status):(String,String)=store.db.query_row("SELECT text,status FROM bot_shared_channel_messages WHERE id=?1 AND channel_id=?2 AND kind='user'",params![message_id,channel_id],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(|e|e.to_string())?.ok_or("This channel message no longer exists.")?;
        if status!="stopped" && status!="failed" { return Err("This message is no longer stopped.".into()); }
        let bot_id=requested_bot.map(str::to_owned).or(channel.lead_bot_id.clone()).or_else(||channel.member_ids.first().cloned()).ok_or("Add a bot in channel settings to continue.")?;
        if !channel.member_ids.contains(&bot_id) { return Err("Choose a bot that belongs to this channel.".into()); }
        store.db.execute("UPDATE bot_shared_channel_messages SET status='in_progress' WHERE id=?1",[message_id]).map_err(|e|e.to_string())?;
        (channel,text,bot_id)
    };
    if let Err(error)=send_channel_assignment(app,channel_id,message_id,&bot_id,&text,crate::storage::now()).await {
        // Recompute, so a retry that failed before its delivery existed keeps the post recoverable.
        if let Ok(store)=state.store.lock() { let _=update_message_status(&store,message_id); }
        let _=app.emit("bot-shared-channel-changed",serde_json::json!({"channelId":channel_id}));
        return Err(error);
    }
    update_message_status(&*state.store.lock().map_err(|e|e.to_string())?,message_id)?;
    let _=app.emit("bot-shared-channel-changed",serde_json::json!({"channelId":channel.id}));
    Ok(())
}

#[tauri::command]
pub async fn bot_shared_channel_continue(app:tauri::AppHandle,state:State<'_,AppState>,channel_id:String,message_id:String) -> Result<()> {
    continue_message(&app,&state,&channel_id,&message_id,None).await
}

#[tauri::command]
pub async fn bot_shared_channel_reassign(app:tauri::AppHandle,state:State<'_,AppState>,channel_id:String,message_id:String,bot_id:String) -> Result<()> {
    continue_message(&app,&state,&channel_id,&message_id,Some(&bot_id)).await
}

#[tauri::command]
pub async fn bot_message_markers(state:State<'_,AppState>,session_id:String) -> Result<Vec<BotMessageMarker>> {
    let store = state.store.lock().map_err(|e|e.to_string())?;
    markers(&store,&session_id)
}
