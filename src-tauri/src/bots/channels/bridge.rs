//! The generic bridge: one connector that lets an external adapter — a platform's own CLI
//! (`signal-cli`, a Mattermost bot, an ntfy subscriber) or a small script — carry messages
//! in and out of a bot, without PandaCode implementing that platform's protocol.
//!
//! Inbound arrives as a normalized POST on the shared loopback server; replies are pulled
//! from a persisted queue. Nothing here parses a vendor payload: the adapter owns the
//! platform's API, its credentials and its field names, and only this contract crosses into
//! PandaCode.
//!
//! Safety is deliberately the same as every other channel, not weaker:
//! * the adapter proves itself with a per-channel bearer token, rotated on demand;
//! * `handle_inbound` still runs pairing, so an unapproved sender is asked for a code and a
//!   compromised adapter cannot reach a sender it has not been paired with;
//! * the body may sit behind a tunnel only when the channel's `remote` setting says so;
//! * the reply queue is bounded and pruned, so a busy adapter cannot grow the database.

use super::http::{same, Request, Response};
use super::{handle_inbound, secrets, Channel};
use crate::AppState;
use rusqlite::params;
use serde_json::{json, Value};
use tauri::Manager;

/// Replies kept per channel before the oldest are pruned.
pub(crate) const QUEUE: i64 = 1_000;
/// Accepted events allowed per channel per minute, matching the web chat.
const POSTS_PER_MINUTE: usize = 30;
/// Longest inbound body, well under the server's own cap.
const MAX_BODY: usize = 128 * 1024;
/// How long a reply poll waits for something to arrive.
const POLL: std::time::Duration = std::time::Duration::from_secs(25);

/// A wakeup per channel, so a waiting poll answers the moment a reply is queued.
fn wake() -> &'static tokio::sync::Notify {
    static WAKE: std::sync::OnceLock<tokio::sync::Notify> = std::sync::OnceLock::new();
    WAKE.get_or_init(tokio::sync::Notify::new)
}

pub(crate) fn new_token() -> String {
    super::web::new_token()
}

fn channel(app: &tauri::AppHandle, id: &str) -> Option<Channel> {
    let state = app.state::<AppState>();
    let store = state.store.lock().ok()?;
    super::get(&store, id).ok().filter(|channel| channel.kind == "bridge" && channel.enabled)
}

fn authorized(channel_id: &str, request: &Request) -> bool {
    let expected = secrets::get(channel_id, "token").unwrap_or_default();
    let given = request.bearer().unwrap_or_default();
    !expected.is_empty() && !given.is_empty() && same(&expected, given)
}

/// Whether the adapter may reach this channel through a tunnel.
fn remote_allowed(channel: &Channel) -> bool {
    channel.config["remote"].as_bool().unwrap_or(false)
}

/// Records an event id, returning false when it was already seen. Keeps only the last day,
/// which is far longer than any sender retries.
fn first_delivery(store: &crate::storage::Store, channel_id: &str, event_id: &str) -> crate::Result<bool> {
    let now = crate::storage::now();
    let _ = store.db.execute("DELETE FROM bot_bridge_events WHERE accepted_at<?1", [now - 86_400_000]);
    let inserted = store.db.execute(
        "INSERT OR IGNORE INTO bot_bridge_events(channel_id,event_id,accepted_at) VALUES(?1,?2,?3)",
        params![channel_id, event_id, now],
    ).map_err(|e| e.to_string())?;
    Ok(inserted == 1)
}

/// A rate limit that survives the request, so a hot adapter is slowed rather than dropped.
fn allow_post(channel_id: &str) -> bool {
    static POSTS: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, std::collections::VecDeque<i64>>>> = std::sync::OnceLock::new();
    let Ok(mut map) = POSTS.get_or_init(Default::default).lock() else { return false };
    let now = crate::storage::now();
    let times = map.entry(channel_id.to_owned()).or_default();
    while times.front().is_some_and(|at| now - at > 60_000) {
        times.pop_front();
    }
    if times.len() >= POSTS_PER_MINUTE {
        return false;
    }
    times.push_back(now);
    true
}

/// The fields an adapter sends. Every one is required: a message with no sender or thread
/// could not be answered.
fn inbound(body: &[u8]) -> Option<(String, String, String, String, Option<String>)> {
    let payload: Value = serde_json::from_slice(body).ok()?;
    let field = |name: &str| payload[name].as_str().map(str::trim).filter(|value| !value.is_empty()).map(str::to_owned);
    let event = field("eventId");
    let sender_id = field("senderId")?;
    let sender_name = field("senderName").unwrap_or_else(|| sender_id.clone());
    let thread = field("thread")?;
    let text = field("text")?;
    Some((sender_id, sender_name, thread, text, event))
}

pub(crate) async fn messages(app: &tauri::AppHandle, channel_id: &str, request: &Request) -> Response {
    let error = |status, message| Response::json(status, &json!({"error": message}));
    let Some(channel) = channel(app, channel_id) else { return error(404, "Bridge not found.") };
    if !authorized(channel_id, request) {
        return error(401, "A valid bridge token is required.");
    }
    if !request.loopback_host() && !remote_allowed(&channel) {
        return error(403, "A loopback Host is required unless remote access is on.");
    }
    if request.body.len() > MAX_BODY {
        return error(413, "The event is too large.");
    }
    let Some((sender_id, sender_name, thread, text, event)) = inbound(&request.body) else {
        return error(400, "Send eventId, senderId, thread and text.");
    };
    // An adapter that retries after a timeout must not start the work twice.
    if let Some(event) = &event {
        let duplicate = {
            let state = app.state::<AppState>();
            let store = match state.store.lock() {
                Ok(store) => store,
                Err(_) => return error(500, "Could not record this event."),
            };
            first_delivery(&store, channel_id, event).map(|first| !first)
        };
        match duplicate {
            Ok(true) => return Response::json(200, &json!({"ok": true, "duplicate": true})),
            Ok(false) => {}
            Err(_) => return error(500, "Could not record this event."),
        }
    }
    if !allow_post(channel_id) {
        return error(429, "Too many events. Wait a minute and try again.");
    }
    super::update_status(app, channel_id, "Receiving messages");
    let (app, channel_id) = (app.clone(), channel_id.to_owned());
    tauri::async_runtime::spawn(async move {
        handle_inbound(&app, &channel_id, &sender_id, &sender_name, &thread, &text).await;
    });
    Response::json(202, &json!({"ok": true}))
}

/// Queues one reply for the adapter to pull, pruning the oldest so the table stays bounded.
pub(crate) fn send(app: &tauri::AppHandle, channel: &Channel, thread: &str, text: &str) -> crate::Result<()> {
    let state = app.state::<AppState>();
    let store = state.store.lock().map_err(|e| e.to_string())?;
    store
        .db
        .execute(
            "INSERT INTO bot_bridge_replies(channel_id,thread,text,created_at) VALUES(?1,?2,?3,?4)",
            params![channel.id, thread, text, crate::storage::now()],
        )
        .map_err(|e| e.to_string())?;
    let keep_from = oldest_kept(&store, &channel.id)?;
    store
        .db
        .execute("DELETE FROM bot_bridge_replies WHERE channel_id=?1 AND id<?2", params![channel.id, keep_from])
        .map_err(|e| e.to_string())?;
    drop(store);
    wake().notify_waiters();
    Ok(())
}

/// The lowest id still inside the newest [`QUEUE`] replies, so a prune drops only what fell
/// out of that window.
fn oldest_kept(store: &crate::storage::Store, channel_id: &str) -> crate::Result<i64> {
    store.db.query_row(
        "SELECT COALESCE(MIN(id),0) FROM (SELECT id FROM bot_bridge_replies WHERE channel_id=?1 ORDER BY id DESC LIMIT ?2)",
        params![channel_id, QUEUE],
        |r| r.get(0),
    ).map_err(|e| e.to_string())
}

fn replies_after(store: &crate::storage::Store, channel_id: &str, after: i64) -> crate::Result<(Vec<Value>, i64, i64)> {
    let mut statement = store
        .db
        .prepare("SELECT id,thread,text,created_at FROM bot_bridge_replies WHERE channel_id=?1 AND id>?2 ORDER BY id LIMIT 100")
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map(params![channel_id, after], |r| {
            Ok(json!({"id": r.get::<_,i64>(0)?, "thread": r.get::<_,String>(1)?, "text": r.get::<_,String>(2)?, "at": r.get::<_,i64>(3)?}))
        })
        .map_err(|e: rusqlite::Error| e.to_string())?;
    let events: Vec<Value> = rows.collect::<rusqlite::Result<_>>().map_err(|e| e.to_string())?;
    let cursor = events.last().and_then(|event| event["id"].as_i64()).unwrap_or(after);
    let oldest: i64 = store
        .db
        .query_row("SELECT COALESCE(MIN(id),0) FROM bot_bridge_replies WHERE channel_id=?1", [channel_id], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    // A cursor below the oldest surviving reply fell behind a prune: the adapter must know
    // it lost events rather than silently skipping them.
    Ok((events, cursor, oldest))
}

/// `GET /api/bridge/<id>/events?after=<cursor>`: long-poll for replies.
pub(crate) async fn events(app: &tauri::AppHandle, channel_id: &str, request: &Request) -> Response {
    let error = |status, message| Response::json(status, &json!({"error": message}));
    let Some(channel) = channel(app, channel_id) else { return error(404, "Bridge not found.") };
    if !authorized(channel_id, request) {
        return error(401, "A valid bridge token is required.");
    }
    if !request.loopback_host() && !remote_allowed(&channel) {
        return error(403, "A loopback Host is required unless remote access is on.");
    }
    let after: i64 = request.query.get("after").and_then(|value| value.parse().ok()).unwrap_or(0);
    let deadline = tokio::time::Instant::now() + POLL;
    loop {
        let read = {
            let state = app.state::<AppState>();
            let store = match state.store.lock() {
                Ok(store) => store,
                Err(_) => return error(500, "Could not read replies."),
            };
            replies_after(&store, channel_id, after)
        };
        let (events, cursor, oldest) = match read {
            Ok(found) => found,
            Err(_) => return error(500, "Could not read replies."),
        };
        if !events.is_empty() || tokio::time::Instant::now() >= deadline {
            // `truncated` warns the adapter that its cursor fell behind a prune.
            let truncated = after != 0 && oldest > 0 && after < oldest - 1;
            return Response::json(200, &json!({"events": events, "cursor": cursor, "oldest": oldest, "truncated": truncated}));
        }
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        let _ = tokio::time::timeout(remaining.min(std::time::Duration::from_secs(3)), wake().notified()).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inbound_requires_every_routing_field() {
        let body = br#"{"eventId":"e1","senderId":"u1","senderName":"Ada","thread":"t1","text":"hi"}"#;
        let parsed = inbound(body).expect("complete body");
        assert_eq!((parsed.0.as_str(), parsed.1.as_str(), parsed.2.as_str(), parsed.3.as_str()), ("u1", "Ada", "t1", "hi"));
        assert_eq!(parsed.4.as_deref(), Some("e1"));
        // No sender: this could not be answered or paired.
        assert!(inbound(br#"{"thread":"t1","text":"hi"}"#).is_none());
        // No thread: the reply would have nowhere to go.
        assert!(inbound(br#"{"senderId":"u1","text":"hi"}"#).is_none());
        // Blank text is not a message.
        assert!(inbound(br#"{"senderId":"u1","thread":"t1","text":"  "}"#).is_none());
        assert!(inbound(b"not json").is_none());
    }

    #[test]
    fn a_missing_event_id_still_works() {
        let parsed = inbound(br#"{"senderId":"u1","thread":"t1","text":"hi"}"#).expect("routable");
        assert_eq!(parsed.4, None, "an adapter without retries is not forced to invent ids");
        // A sender name falls back to the id rather than showing an empty author.
        assert_eq!(parsed.1, "u1");
    }
}
