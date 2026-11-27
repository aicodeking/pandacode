//! PandaConnect methods for the `rooms` feature group: the shared bot channels of the
//! desktop's Bots view (`crate::bots::shared_channels`, docs/bots.md "Shared bot channels").
//! See `methods/mod.rs` and docs/remote-access.md, "Adding a method".
//!
//! `rooms.list` and `rooms.messages` (View) read rooms and their history. `rooms.post`
//! (Full) posts to a room exactly as the desktop composer does, assigning the post to the
//! room's lead or the mentioned members; each assignment then runs in its bot's own task, so
//! the reach of this method is the reach of a bot turn. Every bot the post would wake must be
//! Full access with the "Full access for remote tasks" switch on, because a room assignment
//! starts an agent turn on this computer (`drivable_session_from`, as `task.send` does); a
//! room whose members are not all allowed refuses rather than silently dropping them.
//!
//! Rooms are local to this computer and do not connect to a third-party chat service, so these
//! methods exist to give the phone the same room view the desktop has.
use super::{id_param, once_per_action, send_id_param, Access, Ctx, Method, Reply, Run, PAGE_BUDGET};
use crate::bots::shared_channels::{self as desktop, HISTORY_PAGE};
use crate::Result;
use serde_json::{json, Value};

/// A post is as long as the desktop composer allows (`shared_channels::MAX_TEXT`, 16 KiB);
/// this is the tighter limit `text_param` applies to every remote text.
const MAX_POST: usize = 16 * 1024;

fn room_id(params: &Value) -> Result<String> {
    id_param(params, "channelId")
}

/// Drops items past the page budget (from the end), saying so, as `schedules.rs` does.
fn fit(mut items: Vec<Value>, wrap: impl Fn(&[Value], bool) -> Value) -> Value {
    let mut truncated = false;
    loop {
        let reply = wrap(&items, truncated);
        if items.is_empty() || reply.to_string().len() <= PAGE_BUDGET {
            return reply;
        }
        items.pop();
        truncated = true;
    }
}

/// Runs `work` with the store locked, off the async runtime.
async fn with_store<T: Send + 'static>(ctx: &Ctx<'_>, work: impl FnOnce(&crate::storage::Store) -> Result<T> + Send + 'static) -> Result<T> {
    let store = ctx.state().store.clone();
    crate::blocking(move || work(&*store.lock().map_err(|e| e.to_string())?)).await
}

// ---- rooms.list ----

#[derive(Debug)]
struct List;

impl Run for List {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let rooms = with_store(&ctx, desktop::list).await?;
            let rooms: Vec<Value> = rooms.into_iter().map(|room| serde_json::to_value(room).unwrap_or_default()).collect();
            Ok(fit(rooms, |items, truncated| json!({"rooms": items, "truncated": truncated})))
        })
    }
}

fn parse_list(_: &Value) -> Result<Box<dyn Run>> {
    Ok(Box::new(List))
}

// ---- rooms.messages ----

#[derive(Debug)]
struct Messages {
    channel_id: String,
    limit: usize,
}

fn parse_messages(params: &Value) -> Result<Box<dyn Run>> {
    let limit = match params.get("limit").filter(|value| !value.is_null()) {
        None => HISTORY_PAGE,
        Some(value) => value.as_u64().filter(|n| (1..=10_000).contains(n)).map(|n| n as usize).ok_or("Invalid limit.")?,
    };
    Ok(Box::new(Messages { channel_id: room_id(params)?, limit }))
}

impl Run for Messages {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let detail = with_store(&ctx, move |store| desktop::detail(store, &self.channel_id, self.limit)).await?;
            let mut value = serde_json::to_value(&detail).unwrap_or_default();
            // Older rows beyond this page exist; the desktop says so as `hasMore`.
            if let Some(object) = value.as_object_mut() {
                object.insert("hasMore".into(), json!(detail.has_more));
            }
            Ok(fit(vec![value], |items, truncated| match items.first() {
                Some(page) => {
                    let mut page = page.clone();
                    page["truncated"] = json!(truncated);
                    page
                }
                None => json!({}),
            }))
        })
    }
}

// ---- rooms.post ----

#[derive(Debug)]
struct Post {
    channel_id: String,
    text: String,
    recipients: Vec<String>,
    /// A retry with the same id answers the first post (`once_per_action`).
    send_id: Option<String>,
}

fn parse_post(params: &Value) -> Result<Box<dyn Run>> {
    let text = super::text_param(params, "text")?;
    if text.trim().is_empty() {
        return Err("Write a room message.".into());
    }
    if text.len() > MAX_POST {
        return Err("Write a room message under 16,384 characters.".into());
    }
    let recipients = match params.get("recipients").filter(|value| !value.is_null()) {
        None => Vec::new(),
        Some(value) => {
            let list = value.as_array().ok_or("Invalid recipients.")?;
            if list.len() > 64 {
                return Err("Mention at most 64 bots.".into());
            }
            let mut out = Vec::new();
            for item in list {
                let id = item.as_str().filter(|id| !id.is_empty() && id.len() <= 64).ok_or("Invalid recipients.")?;
                if !out.iter().any(|seen: &String| seen == id) {
                    out.push(id.to_owned());
                }
            }
            out
        }
    };
    Ok(Box::new(Post { channel_id: room_id(params)?, text, recipients, send_id: send_id_param(params)? }))
}

impl Run for Post {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let (send_id, target) = (self.send_id.clone(), self.channel_id.clone());
            once_per_action(ctx.from, "rooms.post", &target, send_id.as_deref(), post(ctx, *self)).await
        })
    }
}

/// The members a post would wake, or the room's lead when none is named, as the desktop's
/// `route_recipients` decides. Checked here so the whole fan-out is allowed before any bot
/// starts a turn.
fn intended_recipients(room: &desktop::SharedChannel, requested: &[String]) -> Result<Vec<String>> {
    if !requested.is_empty() {
        return Ok(requested.to_vec());
    }
    room.lead_bot_id
        .clone()
        .or_else(|| room.member_ids.first().cloned())
        .map(|lead| vec![lead])
        .ok_or_else(|| "Add a bot in the room's settings before posting.".into())
}

/// Every bot the post wakes must be Full access with the remote Full switch on, as `bot.message`
/// requires; a room assignment starts a real agent turn on this computer.
fn allow_members(store: &crate::storage::Store, room: &desktop::SharedChannel, recipients: &[String], full_access: bool) -> Result<()> {
    if room.archived {
        return Err("This room is deleted. Restore it to post.".into());
    }
    for bot_id in recipients {
        if !room.member_ids.iter().any(|member| member == bot_id) {
            return Err("Choose bots that belong to this room.".into());
        }
        crate::bots::get(store, bot_id)?;
        super::super::host::allow_remote_bot_team(store, bot_id, crate::bots::DESKTOP, full_access)?;
    }
    Ok(())
}

async fn post(ctx: Ctx<'_>, this: Post) -> Result<Value> {
    let full_access = ctx.full_access;
    let (channel_id, requested) = (this.channel_id.clone(), this.recipients.clone());
    // Decide the fan-out and prove this device may wake every bot before anything is queued.
    let recipients = with_store(&ctx, move |store| {
        let room = desktop::get(store, &channel_id)?;
        let recipients = intended_recipients(&room, &requested)?;
        allow_members(store, &room, &recipients, full_access)?;
        Ok(recipients)
    })
    .await?;
    let (app, channel_id, text) = (ctx.app.clone(), this.channel_id, this.text);
    desktop::post(&app, &channel_id, &text, Some(recipients)).await?;
    Ok(json!({"posted": true}))
}

pub(crate) const METHODS: &[Method] = &[
    Method { name: "rooms.list", access: Access::View, read_only: true, parse: parse_list },
    Method { name: "rooms.messages", access: Access::View, read_only: true, parse: parse_messages },
    Method { name: "rooms.post", access: Access::Full, read_only: false, parse: parse_post },
];

#[cfg(test)]
mod tests {
    use super::*;

    fn method(name: &str) -> &'static Method {
        METHODS.iter().find(|m| m.name == name).unwrap()
    }

    #[test]
    fn scopes_follow_what_each_method_does() {
        for (name, access) in [("rooms.list", Access::View), ("rooms.messages", Access::View), ("rooms.post", Access::Full)] {
            assert_eq!(method(name).access, access, "{name}");
            assert_eq!(method(name).read_only, access == Access::View, "{name}");
        }
    }

    #[test]
    fn messages_take_a_room_id_and_a_bounded_limit() {
        assert!((method("rooms.messages").parse)(&json!({})).is_err(), "a room id is required");
        assert!((method("rooms.messages").parse)(&json!({"channelId": "c1"})).is_ok());
        assert!((method("rooms.messages").parse)(&json!({"channelId": "c1", "limit": 20})).is_ok());
        assert!((method("rooms.messages").parse)(&json!({"channelId": "c1", "limit": 0})).is_err());
        assert!((method("rooms.messages").parse)(&json!({"channelId": "c1", "limit": 10_001})).is_err());
        assert!((method("rooms.messages").parse)(&json!({"channelId": ""})).is_err());
    }

    #[test]
    fn a_post_needs_text_and_takes_a_send_id_and_recipients() {
        assert!((method("rooms.post").parse)(&json!({"channelId": "c1"})).is_err(), "text is required");
        assert!((method("rooms.post").parse)(&json!({"channelId": "c1", "text": "   "})).is_err(), "blank text is refused");
        assert!((method("rooms.post").parse)(&json!({"channelId": "c1", "text": "hi", "sendId": "abc-1"})).is_ok());
        assert!((method("rooms.post").parse)(&json!({"channelId": "c1", "text": "hi", "sendId": "a b"})).is_err());
        assert!((method("rooms.post").parse)(&json!({"channelId": "c1", "text": "hi", "recipients": ["b1", "b2"]})).is_ok());
        assert!((method("rooms.post").parse)(&json!({"channelId": "c1", "text": "hi", "recipients": "b1"})).is_err());
        assert!((method("rooms.post").parse)(&json!({"channelId": "c1", "text": "hi", "recipients": [""]})).is_err());
        // Repeats collapse so a doubled mention is not checked twice.
        let call = (method("rooms.post").parse)(&json!({"channelId": "c1", "text": "hi", "recipients": ["b1", "b1"]})).unwrap();
        assert!(format!("{call:?}").contains("recipients: [\"b1\"]"), "{call:?}");
    }

    #[test]
    fn the_fan_out_defaults_to_the_lead_then_the_first_member() {
        let room = |lead: Option<&str>, members: &[&str]| desktop::SharedChannel {
            id: "c1".into(), name: "launch".into(), member_ids: members.iter().map(|id| id.to_string()).collect(),
            lead_bot_id: lead.map(str::to_owned), archived: false, updated_at: 0,
        };
        assert_eq!(intended_recipients(&room(Some("lead"), &["a", "lead"]), &[]).unwrap(), ["lead"]);
        // A room whose lead was deleted falls back to its first member, as the desktop does.
        assert_eq!(intended_recipients(&room(None, &["a", "b"]), &[]).unwrap(), ["a"]);
        assert!(intended_recipients(&room(None, &[]), &[]).is_err(), "an empty room has nobody to wake");
        assert_eq!(intended_recipients(&room(Some("lead"), &["a", "b"]), &["b".into()]).unwrap(), ["b"]);
    }

    #[test]
    fn a_room_post_runs_once_per_send_id() {
        let source = include_str!("rooms.rs");
        assert!(source.contains("once_per_action(ctx.from, \"rooms.post\""));
        // The member check runs before the desktop post queues anything.
        let body = &source[source.find("async fn post(").unwrap()..source.find("pub(crate) const METHODS").unwrap()];
        assert!(body.find("allow_members(store, &room, &recipients, full_access)?").unwrap() < body.find("desktop::post").unwrap());
    }

    #[test]
    fn pages_fit_the_budget() {
        let items: Vec<Value> = (0..500).map(|i| json!({"id": i, "text": "t".repeat(1000)})).collect();
        let reply = fit(items, |items, truncated| json!({"rooms": items, "truncated": truncated}));
        assert!(reply.to_string().len() <= PAGE_BUDGET);
        assert_eq!(reply["truncated"], true);
    }
}
