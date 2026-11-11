//! PandaConnect methods for the `threads` feature group: rename, settle ("archive"), delete,
//! pin, fork, export and the task goal/stage, so a phone manages threads as the desktop
//! sidebar does. See `methods/mod.rs` and docs/remote-access.md, "Adding a method".
//!
//! Every method reuses the desktop command it mirrors (`update_session`, `set_task_stage`,
//! `delete_session`, `pin_session`, `fork_session_at_message`, `export_task`,
//! `update_task_details`), so the rules (a running task refuses, team workers are owned by
//! their architect...) are the desktop's own. Changes emit `sessions-changed`, so the
//! desktop's sidebar and every subscribed phone refresh.
//!
//! The desktop has no archive any more: settled tasks have the `completed` stage and sit in
//! the sidebar's Completed section. `thread.archive` therefore settles a task (and reopens
//! it for review with `archived: false`), clearing any legacy archive flag on the way.
use super::{allow_task_mode, bounded_text, drivable_task, id_param, local_task, Access, Ctx, Method, Reply, Run, MAX_TEXT, PAGE_BUDGET};
use crate::Result;
use serde_json::{json, Value};
use tauri::{Emitter, Manager};

/// Titles as the desktop accepts them (`rename_task`, `validate_task_details`).
const MAX_TITLE: usize = 200;
/// The JSON a reply's export text may fill: the page budget less room for the envelope.
const EXPORT_CHUNK: usize = PAGE_BUDGET - 4 * 1024;
/// Stages a phone may set by hand (`Store::set_task_stage` refuses the rest).
const STAGES: [&str; 4] = ["pending", "in_progress", "review", "completed"];
/// Where `thread.archive` with `archived: false` reopens a settled task, as the desktop's Reopen does.
const REOPENED: &str = "review";
/// How long an export snapshot serves its later pages, and how many each device keeps.
const EXPORT_TTL: std::time::Duration = std::time::Duration::from_secs(10 * 60);
const EXPORT_KEEP: usize = 4;
/// The most export text all snapshots together keep: past it the oldest go first (the newest
/// always stays, so the export that was just built can page).
const EXPORT_BYTES: usize = 32 * 1024 * 1024;
const EXPORT_EXPIRED: &str = "This export changed or expired. Export again.";

fn changed(app: &tauri::AppHandle) {
    let _ = app.emit("sessions-changed", ());
}

fn bool_param(params: &Value, key: &str) -> Result<bool> {
    params.get(key).and_then(Value::as_bool).ok_or_else(|| format!("Missing {key}."))
}

fn title_param(params: &Value) -> Result<String> {
    let title = params["title"].as_str().map(str::trim).unwrap_or_default();
    if title.is_empty() || title.chars().count() > MAX_TITLE || title.chars().any(char::is_control) {
        return Err(format!("Choose a name of 1–{MAX_TITLE} characters."));
    }
    Ok(title.to_owned())
}

fn message_param(params: &Value) -> Result<i64> {
    params.get("messageId").and_then(Value::as_i64).filter(|id| *id > 0).ok_or_else(|| "Invalid messageId.".into())
}

/// Task details may be empty (clearing them) but never larger than a message.
fn description_param(params: &Value) -> Result<String> {
    let text = params.get("description").and_then(Value::as_str).ok_or("Missing description.")?;
    if text.len() > MAX_TEXT {
        return Err("Send at most 100 KB of task details.".into());
    }
    Ok(text.trim().to_owned())
}

fn stage_param(params: &Value) -> Result<String> {
    let stage = params.get("stage").and_then(Value::as_str).ok_or("Missing stage.")?;
    STAGES.iter().find(|known| **known == stage).map(|known| (*known).to_owned()).ok_or_else(|| "Unknown task stage.".into())
}

fn offset_param(params: &Value) -> Result<usize> {
    match params.get("offset").filter(|value| !value.is_null()) {
        None => Ok(0),
        Some(value) => value.as_u64().and_then(|offset| usize::try_from(offset).ok()).ok_or_else(|| "Invalid offset.".into()),
    }
}

/// The part of `text` from byte `offset` whose JSON string fits `budget`, cut on a character
/// boundary, and where the next part starts (None at the end). JSON escapes can grow text up
/// to six times, so the cut shrinks until the encoded part fits.
fn export_chunk(text: &str, offset: usize, budget: usize) -> Result<(&str, Option<usize>)> {
    if offset > text.len() || !text.is_char_boundary(offset) {
        return Err("Invalid offset.".into());
    }
    let rest = &text[offset..];
    let mut end = rest.len().min(budget);
    loop {
        while !rest.is_char_boundary(end) {
            end -= 1;
        }
        let part = &rest[..end];
        let encoded = serde_json::to_string(part).map_err(|e| e.to_string())?.len();
        if encoded <= budget || end == 0 {
            let next = (end < rest.len()).then_some(offset + end);
            return Ok((part, next));
        }
        end = (end * budget / encoded).min(end - 1);
    }
}

// ---- thread.rename ----

#[derive(Debug, PartialEq)]
struct Rename {
    session_id: String,
    title: String,
}

impl Run for Rename {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            local_task(&ctx.state(), &self.session_id).await?;
            crate::update_session(ctx.app.clone(), ctx.state(), self.session_id.clone(), Some(self.title.clone()), None, None, None).await?;
            changed(ctx.app);
            Ok(json!({ "sessionId": self.session_id, "title": self.title }))
        })
    }
}

fn parse_rename(params: &Value) -> Result<Box<dyn Run>> {
    Ok(Box::new(Rename { session_id: id_param(params, "sessionId")?, title: title_param(params)? }))
}

// ---- thread.archive (settle / reopen) ----

#[derive(Debug, PartialEq)]
struct Archive {
    session_id: String,
    archived: bool,
}

impl Run for Archive {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            // Reopening retries the task's orchestration, which can wake a full-mode agent
            // (and a bot's, so a bot thread needs a Full device to reopen). Settling uses the
            // same guard (Round 24), so a device that may archive a thread may also undo it.
            let task = drivable_task(ctx.app, ctx.from, &self.session_id, ctx.full_access).await?;
            allow_task_mode(&task.mode, None, ctx.full_access)?;
            let stage = if self.archived { "completed" } else { REOPENED };
            // A legacy archive flag blocks stage changes; reopening clears it, as on the desktop.
            if task.archived && !self.archived {
                crate::update_session(ctx.app.clone(), ctx.state(), self.session_id.clone(), None, Some(false), None, None).await?;
            }
            let settled = !task.archived || !self.archived;
            let task = if settled && task.task_stage != stage {
                crate::set_task_stage(ctx.app.clone(), ctx.state(), self.session_id.clone(), stage.to_owned()).await?
            } else {
                task
            };
            changed(ctx.app);
            Ok(json!({ "sessionId": self.session_id, "archived": self.archived, "stage": task.task_stage }))
        })
    }
}

fn parse_archive(params: &Value) -> Result<Box<dyn Run>> {
    Ok(Box::new(Archive { session_id: id_param(params, "sessionId")?, archived: bool_param(params, "archived")? }))
}

// ---- thread.delete ----

#[derive(Debug, PartialEq)]
struct Delete {
    session_id: String,
}

impl Run for Delete {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            local_task(&ctx.state(), &self.session_id).await?;
            // The desktop's delete is the main window's; it refuses running tasks and teams.
            let window = ctx.app.get_webview_window("main").ok_or("Open PandaCode on that computer to delete tasks.")?;
            let deleted = crate::delete_session_with_attachment_cleanup(ctx.app.clone(), window, self.session_id).await?;
            Ok(json!({ "deletedSessionIds": deleted.deleted_session_ids }))
        })
    }
}

fn parse_delete(params: &Value) -> Result<Box<dyn Run>> {
    Ok(Box::new(Delete { session_id: id_param(params, "sessionId")? }))
}

// ---- thread.pin ----

#[derive(Debug, PartialEq)]
struct Pin {
    session_id: String,
    pinned: bool,
}

impl Run for Pin {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            local_task(&ctx.state(), &self.session_id).await?;
            let task = crate::pin_session(ctx.app.clone(), ctx.state(), self.session_id, self.pinned).await?;
            Ok(json!({ "sessionId": task.id, "pinned": task.pinned }))
        })
    }
}

fn parse_pin(params: &Value) -> Result<Box<dyn Run>> {
    Ok(Box::new(Pin { session_id: id_param(params, "sessionId")?, pinned: bool_param(params, "pinned")? }))
}

// ---- thread.fork ----

#[derive(Debug, PartialEq)]
struct Fork {
    session_id: String,
    message_id: i64,
    /// End just before the message (a prompt to ask again differently), not with it.
    before: bool,
    /// A retry with the same id answers the first fork instead of making another.
    send_id: Option<String>,
}

impl Run for Fork {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let target = fork_target(&self.session_id, self.message_id);
            let send_id = self.send_id.clone();
            super::once_per_action(ctx.from, "thread.fork", &target, send_id.as_deref(), async move {
                drivable_task(ctx.app, ctx.from, &self.session_id, ctx.full_access).await?;
                let task = crate::task_controls::fork_session_at_message(ctx.app.clone(), ctx.state(), self.session_id, self.message_id, Some(self.before)).await?;
                Ok(json!({ "sessionId": task.id, "title": task.title }))
            })
            .await
        })
    }
}

/// What a `thread.fork` or `rewind.to` acts on, as `host::action_target` reads it from the params.
pub(crate) fn fork_target(session_id: &str, message_id: i64) -> String {
    format!("{session_id}@{message_id}")
}

fn parse_fork(params: &Value) -> Result<Box<dyn Run>> {
    let before = match params.get("before").filter(|value| !value.is_null()) {
        None => false,
        Some(value) => value.as_bool().ok_or("Invalid before.")?,
    };
    Ok(Box::new(Fork { session_id: id_param(params, "sessionId")?, message_id: message_param(params)?, before, send_id: super::send_id_param(params)? }))
}

// ---- thread.export ----

/// One export, built once at offset 0 so later pages come from the same text even while
/// the task keeps running.
struct Snapshot {
    token: String,
    device: String,
    session_id: String,
    at: std::time::Instant,
    text: std::sync::Arc<String>,
}

/// Each device's newest few export snapshots: one device's exports and retries never evict
/// another's export that is still paging.
#[derive(Default)]
struct Snapshots(Vec<Snapshot>);

impl Snapshots {
    fn keep(&mut self, snapshot: Snapshot, now: std::time::Instant) {
        self.0.retain(|s| now.duration_since(s.at) < EXPORT_TTL);
        let device = snapshot.device.clone();
        self.0.push(snapshot);
        // Oldest first: drop this device's oldest past its limit, leaving the others alone.
        let mut excess = self.0.iter().filter(|s| s.device == device).count().saturating_sub(EXPORT_KEEP);
        self.0.retain(|s| {
            let drop = excess > 0 && s.device == device;
            excess -= usize::from(drop);
            !drop
        });
        // Then the bytes all of them keep, oldest first, never the one just kept.
        let mut total: usize = self.0.iter().map(|s| s.text.len()).sum();
        while total > EXPORT_BYTES && self.0.len() > 1 {
            total -= self.0.remove(0).text.len();
        }
    }

    /// The snapshot `token` names, if it is the same device's export of the same task and fresh.
    fn find(&self, token: &str, device: &str, session_id: &str, now: std::time::Instant) -> Option<std::sync::Arc<String>> {
        self.0.iter().find(|s| s.token == token && s.device == device && s.session_id == session_id && now.duration_since(s.at) < EXPORT_TTL).map(|s| s.text.clone())
    }
}

static SNAPSHOTS: std::sync::LazyLock<std::sync::Mutex<Snapshots>> = std::sync::LazyLock::new(Default::default);

/// A short hash of the text, so a phone paging without a token can tell it changed.
fn export_version(text: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    text.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

/// Where an export page's text comes from.
#[derive(Debug, PartialEq)]
enum ExportSource<'a> {
    /// Offset 0: build the export and snapshot it under a new token.
    Build,
    /// A later page: the snapshot this token names.
    Snapshot(&'a str),
}

/// Only offset 0 builds (and snapshots) an export; a later page needs the token it answered, so
/// a phone paging without one can't make the host build a snapshot per page.
fn export_source(offset: usize, token: Option<&str>) -> Result<ExportSource<'_>> {
    match (offset, token) {
        (0, _) => Ok(ExportSource::Build),
        (_, Some(token)) => Ok(ExportSource::Snapshot(token)),
        (_, None) => Err(EXPORT_EXPIRED.into()),
    }
}

/// One page of the task's Markdown transcript: `next` is the byte offset of the following page.
/// Offset 0 snapshots the export and answers a `token`; later pages that pass it back read
/// that snapshot. An unknown or expired token, or a later page without one, is refused, so the
/// phone starts again.
#[derive(Debug, PartialEq)]
struct Export {
    session_id: String,
    offset: usize,
    token: Option<String>,
}

impl Run for Export {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            local_task(&ctx.state(), &self.session_id).await?;
            let now = std::time::Instant::now();
            let (text, token) = match export_source(self.offset, self.token.as_deref())? {
                ExportSource::Snapshot(token) => {
                    let found = SNAPSHOTS.lock().map_err(|e| e.to_string())?.find(token, ctx.from, &self.session_id, now);
                    (found.ok_or(EXPORT_EXPIRED)?, Some(token.to_owned()))
                }
                ExportSource::Build => {
                    let text = std::sync::Arc::new(crate::task_controls::export_task(ctx.state(), self.session_id.clone()).await?);
                    let token = uuid::Uuid::new_v4().simple().to_string();
                    let snapshot = Snapshot { token: token.clone(), device: ctx.from.to_owned(), session_id: self.session_id.clone(), at: now, text: text.clone() };
                    SNAPSHOTS.lock().map_err(|e| e.to_string())?.keep(snapshot, now);
                    (text, Some(token))
                }
            };
            let (part, next) = export_chunk(&text, self.offset, EXPORT_CHUNK)?;
            Ok(json!({ "text": part, "offset": self.offset, "next": next, "total": text.len(), "token": token, "version": export_version(&text) }))
        })
    }
}

fn parse_export(params: &Value) -> Result<Box<dyn Run>> {
    let token = match params.get("token").filter(|v| !v.is_null()) {
        None => None,
        Some(_) => Some(id_param(params, "token")?),
    };
    Ok(Box::new(Export { session_id: id_param(params, "sessionId")?, offset: offset_param(params)?, token }))
}

// ---- thread.goal / thread.setGoal / thread.setStage ----

/// What the task info sheet shows: the task's details, its stage and its native goal, if any.
fn goal_reply(task: &crate::storage::Session) -> Value {
    json!({
        "sessionId": task.id,
        "title": task.title,
        "description": bounded_text(&task.task_description, MAX_TEXT),
        "stage": task.task_stage,
        "goal": task.goal_state,
        "running": matches!(task.status.as_str(), "running" | "waiting"),
    })
}

#[derive(Debug, PartialEq)]
struct Goal {
    session_id: String,
}

impl Run for Goal {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move { Ok(goal_reply(&local_task(&ctx.state(), &self.session_id).await?)) })
    }
}

fn parse_goal(params: &Value) -> Result<Box<dyn Run>> {
    Ok(Box::new(Goal { session_id: id_param(params, "sessionId")? }))
}

#[derive(Debug, PartialEq)]
struct SetGoal {
    session_id: String,
    description: String,
}

impl Run for SetGoal {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let task = drivable_task(ctx.app, ctx.from, &self.session_id, ctx.full_access).await?;
            // The goal is text the task's agent reads: like a prompt, a full task needs the switch.
            allow_task_mode(&task.mode, None, ctx.full_access)?;
            let task = crate::update_task_details(ctx.state(), self.session_id, task.title, self.description).await?;
            changed(ctx.app);
            Ok(goal_reply(&task))
        })
    }
}

fn parse_set_goal(params: &Value) -> Result<Box<dyn Run>> {
    Ok(Box::new(SetGoal { session_id: id_param(params, "sessionId")?, description: description_param(params)? }))
}

#[derive(Debug, PartialEq)]
struct SetStage {
    session_id: String,
    stage: String,
}

impl Run for SetStage {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let task = drivable_task(ctx.app, ctx.from, &self.session_id, ctx.full_access).await?;
            // A stage change calls `orchestrate::retry`, which can wake this task's agent to
            // report settled machine threads: a full task needs the switch, as for a prompt.
            allow_task_mode(&task.mode, None, ctx.full_access)?;
            let task = crate::set_task_stage(ctx.app.clone(), ctx.state(), self.session_id, self.stage).await?;
            changed(ctx.app);
            Ok(goal_reply(&task))
        })
    }
}

fn parse_set_stage(params: &Value) -> Result<Box<dyn Run>> {
    Ok(Box::new(SetStage { session_id: id_param(params, "sessionId")?, stage: stage_param(params)? }))
}

pub(crate) const METHODS: &[Method] = &[
    Method { name: "thread.rename", access: Access::Control, read_only: false, parse: parse_rename },
    Method { name: "thread.archive", access: Access::Control, read_only: false, parse: parse_archive },
    Method { name: "thread.delete", access: Access::Full, read_only: false, parse: parse_delete },
    Method { name: "thread.pin", access: Access::Control, read_only: false, parse: parse_pin },
    Method { name: "thread.fork", access: Access::Control, read_only: false, parse: parse_fork },
    Method { name: "thread.export", access: Access::View, read_only: true, parse: parse_export },
    Method { name: "thread.goal", access: Access::View, read_only: true, parse: parse_goal },
    Method { name: "thread.setGoal", access: Access::Control, read_only: false, parse: parse_set_goal },
    Method { name: "thread.setStage", access: Access::Control, read_only: false, parse: parse_set_stage },
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn setting_a_goal_checks_the_task_mode_first() {
        let source = include_str!("threads.rs");
        let body = &source[source.find("impl Run for SetGoal").unwrap()..];
        assert!(body.find("allow_task_mode(&task.mode, None, ctx.full_access)").unwrap() < body.find("update_task_details").unwrap());
    }

    /// Round 8: `thread.setStage` can wake a full task through `orchestrate::retry`.
    #[test]
    fn setting_a_stage_checks_the_task_mode_first() {
        let source = include_str!("threads.rs");
        let body = &source[source.find("impl Run for SetStage").unwrap()..];
        assert!(body.find("allow_task_mode(&task.mode, None, ctx.full_access)").unwrap() < body.find("set_task_stage").unwrap());
    }

    #[test]
    fn archiving_or_reopening_checks_the_task_mode_first() {
        let source = include_str!("threads.rs");
        let body = &source[source.find("impl Run for Archive").unwrap()..];
        let check = body.find("allow_task_mode(&task.mode, None, ctx.full_access)").unwrap();
        assert!(check < body.find("update_session").unwrap());
        assert!(check < body.find("set_task_stage").unwrap());
    }

    fn parsed(name: &str, params: Value) -> Result<String> {
        super::super::parse(name, &params).expect("registered").map(|parsed| format!("{:?}", parsed.call))
    }

    #[test]
    fn scopes_match_what_each_method_can_do() {
        let access = |name: &str| super::super::find(name).unwrap().access;
        assert_eq!(access("thread.delete"), Access::Full);
        for name in ["thread.rename", "thread.archive", "thread.pin", "thread.fork", "thread.setGoal", "thread.setStage"] {
            assert_eq!(access(name), Access::Control, "{name}");
            assert!(!super::super::find(name).unwrap().read_only, "{name}");
        }
        for name in ["thread.export", "thread.goal"] {
            assert_eq!(access(name), Access::View, "{name}");
            assert!(super::super::find(name).unwrap().read_only, "{name}");
        }
    }

    #[test]
    fn rename_trims_and_bounds_the_title() {
        assert_eq!(parsed("thread.rename", json!({"sessionId": "s1", "title": "  Fix login  "})).unwrap(), format!("{:?}", Rename { session_id: "s1".into(), title: "Fix login".into() }));
        assert!(parsed("thread.rename", json!({"sessionId": "s1", "title": "   "})).is_err());
        assert!(parsed("thread.rename", json!({"sessionId": "s1", "title": "a\nb"})).is_err());
        assert!(parsed("thread.rename", json!({"sessionId": "s1", "title": "é".repeat(200)})).is_ok(), "counts characters, not bytes");
        assert!(parsed("thread.rename", json!({"sessionId": "s1", "title": "x".repeat(201)})).is_err());
        assert!(parsed("thread.rename", json!({"sessionId": "../etc", "title": "x"})).is_ok_and(|call| call.contains("../etc")), "ids are opaque: the store looks them up");
        assert!(parsed("thread.rename", json!({"sessionId": "has space", "title": "x"})).is_err());
        assert!(parsed("thread.rename", json!({"title": "x"})).is_err());
    }

    #[test]
    fn flags_and_ids_must_be_typed() {
        assert!(parsed("thread.archive", json!({"sessionId": "s1", "archived": true})).is_ok());
        assert!(parsed("thread.archive", json!({"sessionId": "s1", "archived": "yes"})).is_err());
        assert!(parsed("thread.archive", json!({"sessionId": "s1"})).is_err());
        assert!(parsed("thread.pin", json!({"sessionId": "s1", "pinned": false})).is_ok());
        assert!(parsed("thread.pin", json!({"sessionId": "s1", "pinned": 1})).is_err());
        assert!(parsed("thread.delete", json!({"sessionId": ""})).is_err());
        assert!(parsed("thread.fork", json!({"sessionId": "s1", "messageId": 42})).unwrap().contains("message_id: 42"));
        assert!(parsed("thread.fork", json!({"sessionId": "s1", "messageId": 42, "before": true})).unwrap().contains("before: true"));
        assert!(parsed("thread.fork", json!({"sessionId": "s1", "messageId": 42, "before": "yes"})).is_err());
        for bad in [json!(0), json!(-3), json!("42"), json!(1.5), Value::Null] {
            assert!(parsed("thread.fork", json!({"sessionId": "s1", "messageId": bad})).is_err(), "{bad}");
        }
    }

    #[test]
    fn goal_and_stage_params_are_checked() {
        assert!(parsed("thread.setGoal", json!({"sessionId": "s1", "description": ""})).is_ok(), "clearing the details is allowed");
        assert!(parsed("thread.setGoal", json!({"sessionId": "s1"})).is_err());
        assert!(parsed("thread.setGoal", json!({"sessionId": "s1", "description": "x".repeat(MAX_TEXT + 1)})).is_err());
        for stage in STAGES {
            assert!(parsed("thread.setStage", json!({"sessionId": "s1", "stage": stage})).is_ok(), "{stage}");
        }
        assert!(parsed("thread.setStage", json!({"sessionId": "s1", "stage": "archived"})).is_err());
        assert!(parsed("thread.export", json!({"sessionId": "s1", "offset": -1})).is_err());
        assert!(parsed("thread.export", json!({"sessionId": "s1"})).unwrap().contains("offset: 0"));
    }

    #[test]
    fn export_snapshots_serve_later_pages_from_one_text() {
        let now = std::time::Instant::now();
        let mut snapshots = Snapshots::default();
        let text = std::sync::Arc::new("first".to_owned());
        snapshots.keep(Snapshot { token: "t1".into(), device: "d1".into(), session_id: "s1".into(), at: now, text: text.clone() }, now);
        assert_eq!(snapshots.find("t1", "d1", "s1", now).as_deref().map(String::as_str), Some("first"));
        assert!(snapshots.find("t1", "d2", "s1", now).is_none(), "another device");
        assert!(snapshots.find("t1", "d1", "s2", now).is_none(), "another task");
        assert!(snapshots.find("t1", "d1", "s1", now + EXPORT_TTL).is_none(), "expired");
        for n in 0..EXPORT_KEEP {
            snapshots.keep(Snapshot { token: format!("n{n}"), device: "d1".into(), session_id: "s1".into(), at: now, text: text.clone() }, now);
        }
        assert!(snapshots.find("t1", "d1", "s1", now).is_none(), "oldest is dropped");
        assert_eq!(snapshots.0.len(), EXPORT_KEEP);
        assert_ne!(export_version("a"), export_version("b"));
        assert!(parsed("thread.export", json!({"sessionId": "s1", "offset": 10, "token": "abc"})).unwrap().contains("Some(\"abc\")"));
        assert!(parsed("thread.export", json!({"sessionId": "s1", "token": "bad token"})).is_err());
    }

    #[test]
    fn other_devices_exports_never_evict_one_still_paging() {
        let now = std::time::Instant::now();
        let mut snapshots = Snapshots::default();
        let text = std::sync::Arc::new("mine".to_owned());
        snapshots.keep(Snapshot { token: "mine".into(), device: "d1".into(), session_id: "s1".into(), at: now, text: text.clone() }, now);
        // Another phone exports (and retries) many times.
        for n in 0..3 * EXPORT_KEEP {
            snapshots.keep(Snapshot { token: format!("o{n}"), device: "d2".into(), session_id: format!("s{n}"), at: now, text: text.clone() }, now);
        }
        assert_eq!(snapshots.find("mine", "d1", "s1", now).as_deref().map(String::as_str), Some("mine"));
        assert_eq!(snapshots.0.iter().filter(|s| s.device == "d2").count(), EXPORT_KEEP, "the busy phone keeps only its newest");
        assert!(snapshots.find(&format!("o{}", 3 * EXPORT_KEEP - 1), "d2", &format!("s{}", 3 * EXPORT_KEEP - 1), now).is_some());
        // The same phone's own later exports of other threads keep this one while within its limit.
        for n in 0..EXPORT_KEEP - 1 {
            snapshots.keep(Snapshot { token: format!("m{n}"), device: "d1".into(), session_id: format!("t{n}"), at: now, text: text.clone() }, now);
        }
        assert!(snapshots.find("mine", "d1", "s1", now).is_some());
    }

    #[test]
    fn only_the_first_export_page_builds_a_snapshot() {
        assert_eq!(export_source(0, None).unwrap(), ExportSource::Build);
        assert_eq!(export_source(0, Some("old")).unwrap(), ExportSource::Build, "a fresh export starts over");
        assert_eq!(export_source(500, Some("abc")).unwrap(), ExportSource::Snapshot("abc"));
        assert_eq!(export_source(500, None).unwrap_err(), EXPORT_EXPIRED, "no snapshot per page without a token");
    }

    #[test]
    fn export_snapshots_keep_a_bounded_number_of_bytes() {
        let now = std::time::Instant::now();
        let mut snapshots = Snapshots::default();
        let big = std::sync::Arc::new("x".repeat(EXPORT_BYTES / 3 + 1));
        for n in 0..3 {
            snapshots.keep(Snapshot { token: format!("b{n}"), device: format!("d{n}"), session_id: "s1".into(), at: now, text: big.clone() }, now);
        }
        assert!(snapshots.0.iter().map(|s| s.text.len()).sum::<usize>() <= EXPORT_BYTES);
        assert!(snapshots.find("b0", "d0", "s1", now).is_none(), "the oldest goes first");
        assert!(snapshots.find("b2", "d2", "s1", now).is_some());
        // One export past the cap on its own still pages.
        let huge = std::sync::Arc::new("y".repeat(EXPORT_BYTES + 1));
        snapshots.keep(Snapshot { token: "h".into(), device: "d9".into(), session_id: "s1".into(), at: now, text: huge }, now);
        assert_eq!(snapshots.0.len(), 1);
        assert!(snapshots.find("h", "d9", "s1", now).is_some());
    }

    #[test]
    fn export_pages_cover_the_text_once_within_the_budget() {
        let text = format!("# Title\n\n{}", "naïve \"quoted\"\n\u{1}🐼 ".repeat(500));
        let budget = 1024;
        let (mut offset, mut joined, mut pages) = (0, String::new(), 0);
        loop {
            let (part, next) = export_chunk(&text, offset, budget).unwrap();
            assert!(serde_json::to_string(part).unwrap().len() <= budget);
            assert!(!part.is_empty());
            joined.push_str(part);
            pages += 1;
            match next {
                Some(next) => offset = next,
                None => break,
            }
        }
        assert_eq!(joined, text);
        assert!(pages > 1);
        assert_eq!(export_chunk("", 0, budget).unwrap(), ("", None));
        assert!(export_chunk("🐼", 1, budget).is_err(), "inside a character");
        assert!(export_chunk("ab", 3, budget).is_err());
    }
}
