//! PandaConnect methods for the `rewind` feature group: the desktop's Edit on a sent prompt
//! (docs/rewind.md) from a phone. See `methods/mod.rs` and docs/remote-access.md, "Adding a
//! method".
//!
//! `rewind.points` lists the task's saved prompts a phone may rewind to; `rewind.to` forks the
//! conversation to just before one of them (`fork_session_at_message` with `exclusive: true`,
//! as the desktop's Edit does) and answers the new task with the prompt's typed text, which the
//! phone puts in the new task's composer. The source task is unchanged, files are not rewound
//! and nothing is sent, so `rewind.to` needs Control, not Full. Like the desktop's Edit it
//! refuses while an agent runs on the task.
use super::{drivable_task, id_param, local_session_from, Access, Ctx, Method, Reply, Run, MAX_TEXT};
use crate::Result;
use serde_json::{json, Value};

/// How many of the newest prompts `rewind.points` lists.
const MAX_POINTS: usize = 100;
/// Characters of each prompt `rewind.points` shows.
const PREVIEW_CHARS: usize = 200;
/// What the desktop answers (`editAtMessage` in src/main.ts) while the agent runs.
const RUNNING: &str = "Stop the agent before rewinding.";

/// Blocks the composer appends after what was typed (`CONTEXT_BOUNDARY` in src/main.ts), each
/// with the characters that may follow its marker (empty: anything). Attached context is not
/// re-attached: only the typed text returns to the composer.
const CONTEXT_MARKERS: [(&str, &[char]); 13] = [
    ("File context", &[' ', ':', '(']),
    ("Document context", &[' ', ':', '(']),
    ("Folder context", &[' ', ':', '(']),
    ("GitHub context", &[' ', ':', '(']),
    ("Browser element context", &[' ', ':', '(']),
    ("Main thread context", &[' ', ':', '(']),
    ("Attached browser screenshot", &[' ', ':']),
    ("Attached image", &[' ', ':']),
    ("Attached mockup", &[' ', ':']),
    ("Bot brief:\n", &[]),
    ("Your ongoing role is:", &[]),
    ("Response style (PandaCode token saver", &[]),
    ("Scheduled wake-up (PandaCode scheduler)", &[]),
];

/// The typed part of a saved prompt, before its first context block.
fn typed_text(content: &str) -> &str {
    let starts_block = |rest: &str| {
        CONTEXT_MARKERS.iter().any(|(marker, next)| rest.strip_prefix(marker).is_some_and(|after| next.is_empty() || after.starts_with(*next)))
    };
    let cut = content.match_indices("\n\n").find(|(index, _)| starts_block(&content[index + 2..])).map_or(content.len(), |(index, _)| index);
    &content[..cut]
}

fn preview(text: &str) -> String {
    let line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.chars().count() > PREVIEW_CHARS {
        format!("{}…", line.chars().take(PREVIEW_CHARS - 1).collect::<String>())
    } else {
        line
    }
}

fn message_param(params: &Value) -> Result<i64> {
    params.get("messageId").and_then(Value::as_i64).filter(|id| *id > 0).ok_or_else(|| "Invalid messageId.".into())
}

/// Whether an agent runs on `session_id` on this computer.
fn running(ctx: &Ctx<'_>, session_id: &str) -> Result<bool> {
    Ok(crate::run_requests::lock_agents(&ctx.state().agents).map_err(|e| e.to_string())?.contains_key(session_id))
}

// ---- rewind.points ----

#[derive(Debug, PartialEq)]
struct Points {
    session_id: String,
}

/// The newest prompts, newest first, from `(id, content, created_at)` rows already newest first.
fn points_from(rows: Vec<(i64, String, i64)>) -> Vec<Value> {
    rows.into_iter()
        .take(MAX_POINTS)
        .map(|(id, content, created_at)| json!({ "messageId": id, "text": preview(typed_text(&content)), "createdAt": created_at }))
        .collect()
}

impl Run for Points {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let store = ctx.state().store.clone();
            let session_id = self.session_id.clone();
            let rows = crate::blocking(move || {
                let store = store.lock().map_err(|e| e.to_string())?;
                local_session_from(&store, &session_id)?;
                let mut query = store
                    .db
                    .prepare("SELECT id,content,created_at FROM messages WHERE session_id=?1 AND role='user' ORDER BY id DESC LIMIT ?2")
                    .map_err(|e| e.to_string())?;
                // Read a few extra: generated team prompts saved as user text are skipped.
                let rows = query
                    .query_map(rusqlite::params![session_id, (MAX_POINTS * 2) as i64], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?)))
                    .map_err(|e| e.to_string())?
                    .collect::<std::result::Result<Vec<_>, _>>()
                    .map_err(|e| e.to_string())?;
                let mut shown = Vec::with_capacity(rows.len());
                for (id, content, at) in rows {
                    if crate::architect::internal_turns::legacy_kind(&store, &session_id, id, &content)?.is_none() {
                        shown.push((id, content, at));
                    }
                }
                Ok(shown)
            })
            .await?;
            // `running`: the phone disables Rewind while it is true, as the desktop does.
            Ok(json!({ "points": points_from(rows), "running": running(&ctx, &self.session_id)? }))
        })
    }
}

fn parse_points(params: &Value) -> Result<Box<dyn Run>> {
    Ok(Box::new(Points { session_id: id_param(params, "sessionId")? }))
}

// ---- rewind.to ----

#[derive(Debug, PartialEq)]
struct To {
    session_id: String,
    message_id: i64,
    /// A retry with the same id answers the first rewind instead of forking again.
    send_id: Option<String>,
}

impl Run for To {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let target = super::threads::fork_target(&self.session_id, self.message_id);
            let send_id = self.send_id.clone();
            super::once_per_action(ctx.from, "rewind.to", &target, send_id.as_deref(), rewind(ctx, *self)).await
        })
    }
}

/// `rewind.to` itself.
async fn rewind(ctx: Ctx<'_>, this: To) -> Result<Value> {
    drivable_task(ctx.app, ctx.from, &this.session_id, ctx.full_access).await?;
    if running(&ctx, &this.session_id)? {
        return Err(RUNNING.into());
    }
    let store = ctx.state().store.clone();
    let (session_id, message_id) = (this.session_id.clone(), this.message_id);
    let content = crate::blocking(move || {
        let store = store.lock().map_err(|e| e.to_string())?;
        let role: Option<String> = rusqlite::OptionalExtension::optional(store.db.query_row(
            "SELECT role FROM messages WHERE session_id=?1 AND id=?2",
            rusqlite::params![session_id, message_id],
            |row| row.get(0),
        ))
        .map_err(|e| e.to_string())?;
        if role.as_deref() != Some("user") {
            return Err("Rewind to one of your own messages.".to_owned());
        }
        store.message_content(&session_id, message_id)
    })
    .await?;
    let task = crate::task_controls::fork_session_at_message(ctx.app.clone(), ctx.state(), this.session_id, this.message_id, Some(true)).await?;
    let draft = typed_text(&content);
    let draft = if draft.len() > MAX_TEXT { super::bounded_text(draft, MAX_TEXT) } else { draft.to_owned() };
    Ok(json!({ "sessionId": task.id, "title": task.title, "draft": draft }))
}

fn parse_to(params: &Value) -> Result<Box<dyn Run>> {
    Ok(Box::new(To { session_id: id_param(params, "sessionId")?, message_id: message_param(params)?, send_id: super::send_id_param(params)? }))
}

pub(crate) const METHODS: &[Method] = &[
    Method { name: "rewind.points", access: Access::View, read_only: true, parse: parse_points },
    Method { name: "rewind.to", access: Access::Control, read_only: false, parse: parse_to },
];

#[cfg(test)]
mod tests {
    use super::*;

    fn parsed(name: &str, params: Value) -> Result<String> {
        let method = METHODS.iter().find(|method| method.name == name).expect("listed");
        (method.parse)(&params).map(|call| format!("{call:?}"))
    }

    #[test]
    fn scopes_match_what_each_method_can_do() {
        let find = |name: &str| METHODS.iter().find(|method| method.name == name).unwrap();
        assert_eq!(find("rewind.points").access, Access::View);
        assert!(find("rewind.points").read_only);
        // A rewind forks the transcript only: no files change and nothing is sent.
        assert_eq!(find("rewind.to").access, Access::Control);
        assert!(!find("rewind.to").read_only);
    }

    #[test]
    fn params_are_validated() {
        assert_eq!(parsed("rewind.points", json!({"sessionId": "s1"})).unwrap(), format!("{:?}", Points { session_id: "s1".into() }));
        assert!(parsed("rewind.points", json!({})).is_err());
        assert!(parsed("rewind.points", json!({"sessionId": "has space"})).is_err());
        assert_eq!(parsed("rewind.to", json!({"sessionId": "s1", "messageId": 42})).unwrap(), format!("{:?}", To { session_id: "s1".into(), message_id: 42, send_id: None }));
        let send_id = uuid::Uuid::new_v4().to_string();
        assert!(parsed("rewind.to", json!({"sessionId": "s1", "messageId": 42, "sendId": send_id})).unwrap().contains(&send_id));
        for bad in [json!(0), json!(-3), json!("42"), json!(1.5), Value::Null] {
            assert!(parsed("rewind.to", json!({"sessionId": "s1", "messageId": bad})).is_err(), "{bad}");
        }
        assert!(parsed("rewind.to", json!({"messageId": 4})).is_err());
    }

    #[test]
    fn only_the_typed_text_returns() {
        assert_eq!(typed_text("Fix the login"), "Fix the login");
        assert_eq!(typed_text("Fix it\n\nFile context: a.ts\n…"), "Fix it");
        assert_eq!(typed_text("Fix it\n\nAttached image: shot.png"), "Fix it");
        assert_eq!(typed_text("Fix it\n\nResponse style (PandaCode token saver): terse"), "Fix it");
        assert_eq!(typed_text("Fix it\n\nScheduled wake-up (PandaCode scheduler)\nat 9"), "Fix it");
        assert_eq!(typed_text("Fix it\n\nBot brief:\nbe nice"), "Fix it");
        // Ordinary paragraphs, and words that only start like a marker, stay.
        assert_eq!(typed_text("One\n\nTwo"), "One\n\nTwo");
        assert_eq!(typed_text("One\n\nFile contexts are great"), "One\n\nFile contexts are great");
        assert_eq!(typed_text("One\n\nAttached imagery"), "One\n\nAttached imagery");
    }

    #[test]
    fn points_preview_and_cap() {
        let rows = (1..=150).rev().map(|id| (id, format!("Prompt {id}\n\n  with   spaces\n\nFile context: x"), id * 10)).collect();
        let points = points_from(rows);
        assert_eq!(points.len(), MAX_POINTS);
        assert_eq!(points[0], json!({"messageId": 150, "text": "Prompt 150 with spaces", "createdAt": 1500}));
        let long = points_from(vec![(1, "é".repeat(500), 0)]);
        let text = long[0]["text"].as_str().unwrap();
        assert_eq!(text.chars().count(), PREVIEW_CHARS);
        assert!(text.ends_with('…'));
    }
}
