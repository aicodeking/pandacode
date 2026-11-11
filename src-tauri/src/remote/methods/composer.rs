//! PandaConnect methods for the `composer` feature group: the phone's slash menu, `/btw`
//! side questions, the host's message queue and agent usage. See `methods/mod.rs` and
//! docs/remote-access.md, "Adding a method".
//!
//! Slash commands resolve exactly as the desktop composer resolves them
//! (`slash_commands::resolve`); a command that is plain text for the harness comes back as
//! `send`, which the phone sends with `task.send`, so the host expands skills and native
//! commands as it does for the desktop. App controls come back as `action` for the phone to
//! map onto its own screens.
use super::{allow_task_mode, drivable_session_from, drivable_task, id_param, local_session_from, local_task, workspace_session_from, name_param, text_param, Access, Ctx, Method, Reply, Run, PAGE_BUDGET};
use crate::{message_queue, slash_commands, AppState, Result};
use serde_json::{json, Value};
use tauri::{Emitter, Manager};

/// What one `/btw` message may carry of the main thread (`CONTEXT_LIMIT` in src/btw.ts).
const CONTEXT_LIMIT: usize = 24 * 1024;
/// `TITLE_PREFIX` in src/btw.ts.
const TITLE_PREFIX: &str = "BTW: ";
/// A queued message's text in `queue.list`: 50 entries stay inside one reply.
const QUEUE_PREVIEW: usize = 3 * 1024;
/// A slash command's description in `slash.list`.
const DESCRIPTION_MAX: usize = 300;
/// Queue reorders name at most this many entries (`MAX_PER_TASK` in message_queue.rs).
const MAX_QUEUE: usize = 50;
/// Hours in the day and week totals of `usage.get`.
const DAY_HOURS: i64 = 24;
const WEEK_HOURS: i64 = 24 * 7;
/// Side threads `btw.ask` remembers per main task, so a `sideId` can only name one it made.
const MAX_SIDES: usize = 256;
/// Grant checks for options with effects a View device may not cause: the narrowest
/// Control method of the same feature stands in for "this device has Control".
const CONTROL_PROBE: &str = "slash.resolve";

/// Refuses a View device: `force`/`refresh` rerun discovery or query providers.
fn require_control(ctx: &Ctx<'_>) -> Result<()> {
    super::super::grants::check(ctx.app, ctx.from, CONTROL_PROBE)
}

pub(crate) const METHODS: &[Method] = &[
    Method { name: "slash.list", access: Access::View, read_only: true, parse: parse_slash_list },
    Method { name: "slash.resolve", access: Access::Control, read_only: false, parse: parse_slash_resolve },
    Method { name: "btw.ask", access: Access::Control, read_only: false, parse: parse_btw_ask },
    Method { name: "queue.list", access: Access::View, read_only: true, parse: parse_queue_list },
    Method { name: "queue.update", access: Access::Control, read_only: false, parse: parse_queue_update },
    Method { name: "queue.remove", access: Access::Control, read_only: false, parse: parse_queue_remove },
    Method { name: "queue.reorder", access: Access::Control, read_only: false, parse: parse_queue_reorder },
    Method { name: "queue.restore", access: Access::Control, read_only: false, parse: parse_queue_restore },
    Method { name: "usage.get", access: Access::View, read_only: true, parse: parse_usage_get },
    Method { name: "usage.limits", access: Access::View, read_only: true, parse: parse_usage_limits },
    Method { name: "usage.resumeAtReset", access: Access::Control, read_only: false, parse: parse_resume_at_reset },
    Method { name: "usage.clearLimit", access: Access::Control, read_only: false, parse: parse_clear_limit },
];

fn optional_bool(params: &Value, key: &str) -> Result<bool> {
    match params.get(key).filter(|v| !v.is_null()) {
        None => Ok(false),
        Some(value) => value.as_bool().ok_or_else(|| format!("Invalid {key}.")),
    }
}

fn optional_id(params: &Value, key: &str) -> Result<Option<String>> {
    match params.get(key).filter(|v| !v.is_null()) {
        None => Ok(None),
        Some(_) => id_param(params, key).map(Some),
    }
}

/// The harness, folder and mode a task's commands are discovered in, as `list_slash_commands` does.
async fn command_context(state: &AppState, session_id: &str) -> Result<(String, std::path::PathBuf, String)> {
    let store = state.store.clone();
    let session_id = session_id.to_owned();
    crate::blocking(move || {
        let store = store.lock().map_err(|e| e.to_string())?;
        // Never a bot's workspace: discovery runs the harness's own config there (Round 20).
        let task = workspace_session_from(&store, &session_id)?;
        let cwd = store.workspace_root(&task.project_id, Some(&session_id))?;
        Ok((task.provider, cwd, task.mode))
    })
    .await
}

// ---- slash.list ----

#[derive(Debug, PartialEq)]
struct SlashList {
    session_id: String,
    force: bool,
}

fn parse_slash_list(params: &Value) -> Result<Box<dyn Run>> {
    Ok(Box::new(SlashList { session_id: id_param(params, "sessionId")?, force: optional_bool(params, "force")? }))
}

/// One command as the phone's menu shows it: `action` names an app control, `available`
/// is false for commands only the harness's terminal can run.
fn command_row(command: &slash_commands::SlashCommand) -> Value {
    let (action, available) = match &command.invocation {
        slash_commands::Invocation::Action(action) => (Some(action.as_str()), true),
        slash_commands::Invocation::Unsupported => (None, false),
        _ => (None, true),
    };
    json!({
        "name": command.name,
        "description": super::bounded_text(&command.description, DESCRIPTION_MAX),
        "argumentHint": command.argument_hint,
        "kind": command.kind,
        "source": command.source,
        "reason": command.reason,
        "action": action,
        "available": available,
    })
}

fn catalog_reply(catalog: &slash_commands::Catalog) -> Value {
    let mut commands: Vec<Value> = catalog.commands.iter().map(command_row).collect();
    let budget = PAGE_BUDGET.saturating_sub(serde_json::to_string(&catalog.warnings).map_or(0, |w| w.len()) + 64);
    let total = commands.len();
    super::super::host::fit_list(&mut commands, budget);
    json!({ "commands": commands, "warnings": catalog.warnings, "truncated": commands.len() < total })
}

/// Round 10: discovery starts the harness in the project (its own config with it), so below
/// Control a cache miss never launches one: the device gets [`slash_commands::snapshot`] (the
/// latest known catalog, else the local actions) instead.
async fn listed_catalog(provider: &str, cwd: &std::path::Path, force: bool, control: bool) -> Result<slash_commands::Catalog> {
    if control {
        slash_commands::catalog(provider, cwd, force).await
    } else {
        slash_commands::snapshot(provider, cwd)
    }
}

/// Round 11: discovery launches the harness inside the project with whatever config the
/// harness still reads, so only a Control device that could also run the task's mode
/// (`allow_task_mode`: a full-mode task needs the host switch) may start it; everyone
/// else gets the snapshot.
pub(super) fn may_discover(ctx: &Ctx<'_>, mode: &str) -> bool {
    allow_task_mode(mode, None, ctx.full_access).is_ok() && require_control(ctx).is_ok()
}

/// A local task's slash commands for another method (`recipes.plan`/`recipes.run`): the
/// discovered catalog only when [`may_discover`] holds, else the snapshot (Round 12). The
/// only way, outside this file's methods, a remote path may read the catalog.
pub(super) async fn task_catalog(ctx: &Ctx<'_>, session_id: &str, mode: &str) -> Result<slash_commands::Catalog> {
    let (provider, cwd, _) = command_context(&ctx.state(), session_id).await?;
    listed_catalog(&provider, &cwd, false, may_discover(ctx, mode)).await
}

impl Run for SlashList {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            if self.force {
                require_control(&ctx)?;
            }
            let (provider, cwd, mode) = command_context(&ctx.state(), &self.session_id).await?;
            // `force` already refused a View device above.
            let control = may_discover(&ctx, &mode);
            if self.force && !control {
                allow_task_mode(&mode, None, ctx.full_access)?;
            }
            let catalog = listed_catalog(&provider, &cwd, self.force, control).await?;
            Ok(catalog_reply(&catalog))
        })
    }
}

// ---- slash.resolve ----

#[derive(Debug, PartialEq)]
struct SlashResolve {
    session_id: String,
    text: String,
}

fn parse_slash_resolve(params: &Value) -> Result<Box<dyn Run>> {
    let text = text_param(params, "text")?;
    if slash_commands::split_command(&text).is_none() {
        return Err("Type a slash command, such as /review.".into());
    }
    Ok(Box::new(SlashResolve { session_id: id_param(params, "sessionId")?, text }))
}

/// `SLASH_INSTRUCTIONS` in src/main.ts: app commands that become a prompt.
fn slash_instruction(action: &str, arguments: &str) -> Option<String> {
    let base = match action {
        "init" => "Inspect this repository and create or update AGENTS.md with concise, accurate project instructions: setup, development commands, tests, architecture, and conventions. Preserve existing useful guidance.",
        "recap" => "Summarize this conversation concisely: objective, changes, important decisions, validation, and remaining work.",
        _ => return None,
    };
    Some(if arguments.is_empty() { base.to_owned() } else { format!("{base}\n{arguments}") })
}

/// What the phone does with a resolved command: send `send` with `task.send`, or act on `action`.
fn resolution_reply(text: &str, resolution: &slash_commands::Resolution) -> Value {
    let send = match resolution.action.as_deref() {
        None => Some(text.to_owned()),
        Some(action) => slash_instruction(action, &resolution.arguments),
    };
    json!({
        "action": resolution.action,
        "arguments": resolution.arguments,
        "acceptsAttachments": resolution.accepts_attachments,
        "send": send,
    })
}

impl Run for SlashResolve {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let (provider, cwd, mode) = command_context(&ctx.state(), &self.session_id).await?;
            let resolution = if may_discover(&ctx, &mode) {
                slash_commands::resolve(&provider, &cwd, &self.text).await?
            } else {
                slash_commands::resolve_known(&provider, &cwd, &self.text)?
            };
            Ok(resolution_reply(&self.text, &resolution))
        })
    }
}

// ---- btw.ask ----

/// `/btw <question>` from the phone: a side thread beside `session_id`, as docs/btw.md
/// describes. The phone keeps the link (`side_id`, `seen_id`) and passes it back.
#[derive(Debug, PartialEq)]
struct BtwAsk {
    session_id: String,
    text: String,
    side_id: Option<String>,
    seen_id: i64,
    /// A retry with the same id answers the first question (`once_per_action`).
    send_id: Option<String>,
}

fn parse_btw_ask(params: &Value) -> Result<Box<dyn Run>> {
    let seen_id = match params.get("seenId").filter(|v| !v.is_null()) {
        None => 0,
        Some(value) => value.as_i64().filter(|id| *id >= 0).ok_or("Invalid seenId.")?,
    };
    Ok(Box::new(BtwAsk { session_id: id_param(params, "sessionId")?, text: text_param(params, "text")?, side_id: optional_id(params, "sideId")?, seen_id, send_id: super::send_id_param(params)? }))
}

/// `sideTitle` in src/btw.ts.
fn side_title(prompt: &str) -> String {
    let plain: String = prompt.chars().filter(|c| !matches!(c, '*' | '_' | '`')).collect();
    let line = plain.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.is_empty() {
        return format!("{TITLE_PREFIX}Side thread");
    }
    if line.chars().count() > 48 {
        return format!("{TITLE_PREFIX}{}…", line.chars().take(47).collect::<String>());
    }
    format!("{TITLE_PREFIX}{line}")
}

/// Context blocks the composer appends to a prompt (`CONTEXT_BOUNDARY` in src/main.ts):
/// a user message is shown to the side thread without them.
const CONTEXT_MARKERS: [&str; 10] = [
    "File context", "Document context", "Folder context", "GitHub context", "Browser element context", "Main thread context",
    "Attached browser screenshot", "Attached image", "Attached mockup", "Bot brief:",
];

fn strip_context(content: &str) -> &str {
    let cut = content
        .match_indices("\n\n")
        .find(|(index, _)| CONTEXT_MARKERS.iter().any(|marker| content[index + 2..].starts_with(marker)))
        .map_or(content.len(), |(index, _)| index);
    &content[..cut]
}

/// The end of `text` within `limit` bytes, cut on a character boundary (`tail` in src/btw.ts).
fn tail(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        return text.to_owned();
    }
    let mut start = text.len() - limit.saturating_sub(3);
    while !text.is_char_boundary(start) {
        start += 1;
    }
    format!("…{}", &text[start..])
}

/// `mainContext` in src/btw.ts: the main thread's title and status and its messages the side
/// thread has not seen, newest kept within `limit`. Returns the block and the new seen id.
fn main_context(title: &str, status: &str, messages: &[(i64, String, String)], seen_id: i64, limit: usize, gap: bool) -> (String, i64) {
    let fresh: Vec<&(i64, String, String)> = messages.iter().filter(|(id, role, content)| *id > seen_id && (role == "user" || role == "assistant") && !content.trim().is_empty()).collect();
    let entries: Vec<String> = fresh
        .iter()
        .map(|(_, role, content)| {
            let content = if role == "user" { strip_context(content) } else { content };
            format!("{}: {}", if role == "user" { "User" } else { "Agent" }, content.trim())
        })
        .collect();
    let mut kept: Vec<String> = Vec::new();
    let (mut budget, mut truncated) = (limit, gap);
    for entry in entries.iter().rev() {
        let size = entry.len() + 2;
        if size <= budget {
            kept.insert(0, entry.clone());
            budget -= size;
            continue;
        }
        if budget > 256 {
            kept.insert(0, tail(entry, budget - 2));
        }
        truncated = true;
        break;
    }
    let first = seen_id <= 0;
    let mut parts = vec![format!(
        "Main thread context: \"{title}\" ({status}). You are a side thread opened with /btw beside it; the main thread keeps working on its own, so answer here and leave its work alone unless asked."
    )];
    parts.push(
        match (kept.is_empty(), first) {
            (false, true) => "Recent main-thread messages:",
            (false, false) => "New in the main thread since your last message:",
            (true, true) => "The main thread has no messages yet.",
            (true, false) => "Nothing new in the main thread since your last message.",
        }
        .to_owned(),
    );
    if truncated {
        parts.push(format!("Older main-thread text was left out to stay within {} KB.", limit / 1024));
    }
    parts.extend(kept);
    let seen = fresh.iter().map(|(id, _, _)| *id).max().unwrap_or(seen_id).max(seen_id);
    (format!("\n\n{}", parts.join("\n\n")), seen)
}

/// Side threads `btw.ask` opened, by main task: the only `sideId`s it accepts back, so a
/// caller cannot point a question at an unrelated task (which may run in Full mode).
/// Forgotten on restart; the phone then gets a fresh side thread.
#[derive(Default)]
struct SideLinks {
    links: std::collections::VecDeque<(String, String)>,
}

impl SideLinks {
    fn link(&mut self, main: &str, side: &str) {
        if self.is_linked(main, side) {
            return;
        }
        if self.links.len() >= MAX_SIDES {
            self.links.pop_front();
        }
        self.links.push_back((main.to_owned(), side.to_owned()));
    }

    fn is_linked(&self, main: &str, side: &str) -> bool {
        self.links.iter().any(|(m, s)| m == main && s == side)
    }
}

static SIDE_LINKS: std::sync::LazyLock<std::sync::Mutex<SideLinks>> = std::sync::LazyLock::new(Default::default);

fn side_linked(main: &str, side: &str) -> bool {
    SIDE_LINKS.lock().is_ok_and(|links| links.is_linked(main, side))
}

fn link_side(main: &str, side: &str) {
    if let Ok(mut links) = SIDE_LINKS.lock() {
        links.link(main, side);
    }
}

/// Whether an existing side thread may take the question: it is one `btw.ask` opened for
/// `main`, still in its project, not archived and not `main` itself.
fn reusable_side((main_id, main_project): (&str, &str), (side_id, side_project, archived): (&str, &str, bool), linked: bool) -> bool {
    linked && side_project == main_project && !archived && side_id != main_id
}

/// `btwRefusal` in src/main.ts.
fn btw_refusal(task: &crate::storage::Session, bot_projects: &[String]) -> Option<&'static str> {
    if task.remote_device.is_some() || task.cloud.is_some() {
        return Some("Side threads run on this computer, and this task runs elsewhere.");
    }
    if bot_projects.contains(&task.project_id) {
        return Some("Bot conversations cannot open side threads. Ask in a project task instead.");
    }
    None
}

impl BtwAsk {
    /// The linked side thread if it can take another question, else a new one (`createBtw`).
    fn side(&self, state: &AppState) -> Result<(crate::storage::Session, bool)> {
        let store = state.store.lock().map_err(|e| e.to_string())?;
        let main = local_session_from(&store, &self.session_id)?;
        if let Some(refusal) = btw_refusal(&main, &crate::bots::project_ids(&store)?) {
            return Err(refusal.into());
        }
        if let Some(side) = self.side_id.as_deref().filter(|id| side_linked(&main.id, id)).and_then(|id| local_session_from(&store, id).ok()) {
            if reusable_side((&main.id, &main.project_id), (&side.id, &side.project_id, side.archived), true) {
                return Ok((side, false));
            }
        }
        if main.worktree_path.is_some() {
            // Only a fork keeps a worktree checkout; its copied transcript stays hidden.
            let page = store.message_page(&main.id, None)?;
            let last = page.messages.iter().rev().find(|m| m.id > 0 && (m.role == "user" || m.role == "assistant")).ok_or("Send a first message in this task before asking on the side.")?;
            return Ok((crate::conversation_fork::at_message(&store, &main.id, last.id)?, true));
        }
        let side = crate::architect::profiles::create_user_task(&store, &main.project_id, &main.provider, &main.model, Some(&main.mode), None)?;
        Ok((side, true))
    }

    /// The question with the main thread's news since `seen_id`, and the new seen id.
    fn prompt(&self, state: &AppState) -> Result<(String, i64)> {
        let running = state.agents.lock().map_err(|e| e.to_string())?.contains_key(&self.session_id);
        let store = state.store.lock().map_err(|e| e.to_string())?;
        let main = store.session(&self.session_id)?;
        let page = store.message_page(&self.session_id, None)?;
        let gap = page.has_older && page.messages.first().is_some_and(|m| m.id > self.seen_id);
        let messages: Vec<(i64, String, String)> = page.messages.into_iter().map(|m| (m.id, m.role, m.content)).collect();
        let status = if running { "running" } else { main.status.as_str() };
        let (context, seen) = main_context(&main.title, status, &messages, self.seen_id, CONTEXT_LIMIT, gap);
        Ok((format!("{}{context}", self.text), seen))
    }
}

impl Run for BtwAsk {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let (send_id, target) = (self.send_id.clone(), self.session_id.clone());
            super::once_per_action(ctx.from, "btw.ask", &target, send_id.as_deref(), self.ask(ctx)).await
        })
    }
}

impl BtwAsk {
    /// `btw.ask` itself.
    async fn ask(self: Box<Self>, ctx: Ctx<'_>) -> Result<Value> {
        let state = ctx.state();
        let main = local_task(&state, &self.session_id).await?;
        allow_task_mode(&main.mode, None, ctx.full_access)?;
        // Off the async runtime: both hold the store lock, and a fork copies a transcript.
        let app = ctx.app.clone();
        let (this, (side, created)) = crate::blocking(move || {
            let found = self.side(&tauri::Manager::state::<AppState>(&app))?;
            Ok((self, found))
        })
        .await?;
        let this: Box<Self> = this;
        // The side thread runs the prompt, so its own mode follows the rule for prompts.
        if let Err(error) = allow_task_mode(&side.mode, None, ctx.full_access) {
            if created {
                if let Err(cleanup) = crate::task_deletion::delete_state(&state, &side.id) {
                    eprintln!("btw.ask: could not remove the refused side thread: {cleanup}");
                }
            }
            return Err(error);
        }
        if state.agents.lock().map_err(|e| e.to_string())?.contains_key(&side.id) {
            return Err("The side thread is still answering. Send this when it finishes.".into());
        }
        let title = if created { side_title(&this.text) } else { side.title.clone() };
        // A fresh side thread starts from the next main-thread message it is shown.
        let seen_from = if created { 0 } else { this.seen_id };
        let self_session = this.session_id.clone();
        let ask = BtwAsk { seen_id: seen_from, ..*this };
        let setup = async {
            if created {
                crate::update_session(ctx.app.clone(), state.clone(), side.id.clone(), Some(title.clone()), None, None, None).await?;
            }
            let app = ctx.app.clone();
            let (prompt, seen) = crate::blocking(move || ask.prompt(&tauri::Manager::state::<AppState>(&app))).await?;
            crate::send_prompt(ctx.app.clone(), state.clone(), side.id.clone(), prompt, None).await?;
            Ok::<i64, String>(seen)
        };
        match setup.await {
            Ok(seen) => {
                link_side(&self_session, &side.id);
                let _ = ctx.app.emit("sessions-changed", ());
                Ok(json!({ "sideId": side.id, "title": title, "seenId": seen, "created": created }))
            }
            Err(error) => {
                if created {
                    // Never leave a half-set-up side thread behind.
                    if let Err(cleanup) = crate::task_deletion::delete_state(&state, &side.id) {
                        eprintln!("btw.ask: could not remove the unfinished side thread: {cleanup}");
                    }
                }
                Err(error)
            }
        }
    }
}

// ---- queue.* ----

fn queue_row(entry: &message_queue::QueuedMessage) -> Value {
    let truncated = entry.text.len() > QUEUE_PREVIEW;
    json!({
        "id": entry.id,
        "position": entry.position,
        "text": if truncated { super::bounded_text(&entry.text, QUEUE_PREVIEW) } else { entry.text.clone() },
        "truncated": truncated,
        "attachments": entry.attachments.as_array().map_or(0, Vec::len),
        "createdAt": entry.created_at,
        "updatedAt": entry.updated_at,
    })
}

fn queue_reply(entries: &[message_queue::QueuedMessage]) -> Value {
    json!({ "entries": entries.iter().map(queue_row).collect::<Vec<_>>() })
}

/// Runs `work` on a local task's queue and answers with the queue after it. Changes tell the
/// desktop to redraw its queue (its webview sends to an idle task); a headless host has no
/// webview, so `headless::queue_changed` drains an idle task there (a no-op on the desktop).
/// That drain starts a turn, so it runs only when this device could send to the task itself
/// ([`may_drain`]); otherwise the queue stays until someone who can resumes it (Round 21).
/// Round 22: a change (update, remove, restore, reorder) checks the task with
/// `drivable_session_from`, so a bot's thread queue needs a Full device and the bot's mode rule;
/// listing stays open to any device that can view the task.
async fn on_queue(ctx: Ctx<'_>, session_id: String, changes: bool, work: impl FnOnce(&crate::storage::Store) -> Result<()> + Send + 'static) -> Result<Value> {
    let store = ctx.state().store.clone();
    let id = session_id.clone();
    let (full_access, device_full) = (ctx.full_access, changes && super::files::device_from_has_full(ctx.app, ctx.from));
    let (entries, drain) = crate::blocking(move || {
        let store = store.lock().map_err(|e| e.to_string())?;
        if changes {
            drivable_session_from(&store, &id, device_full, full_access)?;
        } else {
            local_session_from(&store, &id)?;
        }
        work(&store)?;
        let drain = changes && may_drain(&store, &id, device_full, full_access);
        Ok((message_queue::list(&store, Some(&id))?, drain))
    })
    .await?;
    if changes {
        let _ = ctx.app.emit("queue-changed", json!({ "sessionId": session_id }));
        if drain {
            crate::headless::queue_changed(ctx.app, &session_id);
        }
    }
    Ok(queue_reply(&entries))
}

/// Whether a phone's queue edit may start the task's next turn (a headless host's drain): the
/// device must be allowed to send to it, as `task.send` checks, so a bot's thread needs a Full
/// device and the bot's mode rule, and a Full-access thread needs the switch.
fn may_drain(store: &crate::storage::Store, session_id: &str, device_full: bool, full_access: bool) -> bool {
    drivable_session_from(store, session_id, device_full, full_access).is_ok_and(|task| allow_task_mode(&task.mode, None, full_access).is_ok())
}

/// Rewriting a queued message is a prompt for the task's own mode.
fn queue_edit_allowed(mode: &str, full_access: bool) -> Result<()> {
    allow_task_mode(mode, None, full_access)
}

/// An entry of this task's queue, so one task's grant never edits another's.
fn queued_in(store: &crate::storage::Store, session_id: &str, id: &str) -> Result<message_queue::QueuedMessage> {
    message_queue::list(store, Some(session_id))?.into_iter().find(|entry| entry.id == id).ok_or_else(|| "This queued message was already sent or removed.".into())
}

#[derive(Debug, PartialEq)]
struct QueueList {
    session_id: String,
}

fn parse_queue_list(params: &Value) -> Result<Box<dyn Run>> {
    Ok(Box::new(QueueList { session_id: id_param(params, "sessionId")? }))
}

impl Run for QueueList {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(on_queue(ctx, self.session_id, false, |_| Ok(())))
    }
}

#[derive(Debug, PartialEq)]
struct QueueUpdate {
    session_id: String,
    id: String,
    text: String,
}

fn parse_queue_update(params: &Value) -> Result<Box<dyn Run>> {
    Ok(Box::new(QueueUpdate { session_id: id_param(params, "sessionId")?, id: id_param(params, "id")?, text: text_param(params, "text")? }))
}

impl Run for QueueUpdate {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        let QueueUpdate { session_id, id, text } = *self;
        let session = session_id.clone();
        let full_access = ctx.full_access;
        let device_full = super::files::device_from_has_full(ctx.app, ctx.from);
        Box::pin(on_queue(ctx, session_id, true, move |store| {
            // The rewritten text is what the agent will run, so it follows the rule for prompts
            // (and a bot's thread needs a Full device and the bot's mode rule).
            queue_edit_allowed(&drivable_session_from(store, &session, device_full, full_access)?.mode, full_access)?;
            // The phone edits the text only; attachments stay as the desktop queued them.
            let entry = queued_in(store, &session, &id)?;
            message_queue::update(store, &id, &text, &entry.attachments).map(|_| ())
        }))
    }
}

#[derive(Debug, PartialEq)]
struct QueueRemove {
    session_id: String,
    id: String,
}

fn parse_queue_remove(params: &Value) -> Result<Box<dyn Run>> {
    Ok(Box::new(QueueRemove { session_id: id_param(params, "sessionId")?, id: id_param(params, "id")? }))
}

impl Run for QueueRemove {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        let QueueRemove { session_id, id } = *self;
        let session = session_id.clone();
        Box::pin(on_queue(ctx, session_id, true, move |store| {
            let mut holding = QUEUE_HOLDING.lock().map_err(|e| e.to_string())?;
            remove_queued(store, &mut holding, &session, &id, std::time::Instant::now())
        }))
    }
}

/// Takes `id` out of the task's queue and holds it for `queue.restore`, so the phone's Undo
/// puts back exactly this entry. Round 22: an entry this host already removed and still holds
/// (within [`HOLD_FOR`], not put back since) answers success again, so a retry after a lost
/// reply gets the queue and its Undo instead of "already sent or removed".
fn remove_queued(store: &crate::storage::Store, holding: &mut QueueHolding, session_id: &str, id: &str, now: std::time::Instant) -> Result<()> {
    let entries = message_queue::list(store, Some(session_id))?;
    let Some(index) = entries.iter().position(|entry| entry.id == id) else {
        return match holding.find(session_id, id, now) {
            Some(held) if !held.restored => Ok(()),
            _ => Err("This queued message was already sent or removed.".into()),
        };
    };
    message_queue::remove(store, id)?;
    holding.hold(Held::new(&entries, index, message_queue::deliveries(session_id), now));
    Ok(())
}

/// How long `queue.restore` can put back a removed entry, and how many it holds per task
/// and in all.
const HOLD_FOR: std::time::Duration = std::time::Duration::from_secs(60);
const HOLD_PER_TASK: usize = 8;
const HOLD_TOTAL: usize = 256;
const CANNOT_RESTORE: &str = "This message can no longer be put back.";

/// A queued message `queue.remove` took out: the entry as stored, its index then, and the
/// task's delivery count ([`message_queue::deliveries`]), so a restore after the queue
/// delivered is refused (see [`queue_delivered`]).
#[derive(Debug, Clone)]
struct Held {
    entry: message_queue::QueuedMessage,
    index: usize,
    /// The task's delivery count at removal (or, once restored, at the restore).
    deliveries: u64,
    at: std::time::Instant,
    restored: bool,
}

impl Held {
    fn new(entries: &[message_queue::QueuedMessage], index: usize, deliveries: u64, at: std::time::Instant) -> Self {
        Held { entry: entries[index].clone(), index, deliveries, at, restored: false }
    }
}

/// Whether the task's queue delivered any entry since `held` was taken (or restored). Only the
/// queue's own deliveries count, so a prompt sent straight to the task (`task.send`) leaves
/// Undo available.
fn queue_delivered(held: &Held) -> bool {
    message_queue::deliveries(&held.entry.session_id) != held.deliveries
}

/// Recently removed queue entries, bounded and short-lived. Forgotten on restart.
#[derive(Default)]
struct QueueHolding {
    held: std::collections::VecDeque<Held>,
}

impl QueueHolding {
    fn prune(&mut self, now: std::time::Instant) {
        self.held.retain(|held| now.saturating_duration_since(held.at) < HOLD_FOR);
    }

    fn hold(&mut self, held: Held) {
        self.prune(held.at);
        self.held.retain(|other| other.entry.id != held.entry.id);
        let session = held.entry.session_id.clone();
        while self.held.iter().filter(|other| other.entry.session_id == session).count() >= HOLD_PER_TASK {
            let oldest = self.held.iter().position(|other| other.entry.session_id == session).expect("counted");
            self.held.remove(oldest);
        }
        if self.held.len() >= HOLD_TOTAL {
            self.held.pop_front();
        }
        self.held.push_back(held);
    }

    fn find(&mut self, session_id: &str, id: &str, now: std::time::Instant) -> Option<&mut Held> {
        self.prune(now);
        self.held.iter_mut().find(|held| held.entry.session_id == session_id && held.entry.id == id)
    }
}

static QUEUE_HOLDING: std::sync::LazyLock<std::sync::Mutex<QueueHolding>> = std::sync::LazyLock::new(Default::default);

/// Puts a held entry back at its old index (clamped). Idempotent: an entry already back in
/// the queue succeeds. Refused once the hold expired, once the task's queue delivered since
/// the removal ([`queue_delivered`]; a direct prompt does not count), and for an entry this
/// restored that has since left the queue again (Round 20: `restored` alone is no proof).
/// `restored` and the delivery count are recorded only after the reorder succeeds, so an
/// entry restored and then sent reports that it can't be put back.
fn restore_held(store: &crate::storage::Store, holding: &mut QueueHolding, session_id: &str, id: &str, now: std::time::Instant) -> Result<()> {
    let entries = message_queue::list(store, Some(session_id))?;
    if entries.iter().any(|entry| entry.id == id) {
        return Ok(());
    }
    let held = holding.find(session_id, id, now).ok_or(CANNOT_RESTORE)?;
    if queue_delivered(held) || held.restored {
        return Err(CANNOT_RESTORE.into());
    }
    // Both run under the store lock this holds, so nothing changes the queue in between
    // (reorder opens its own transaction, which cannot nest in one here).
    message_queue::reinsert(store, &held.entry)?;
    let mut ids: Vec<String> = entries.into_iter().map(|entry| entry.id).collect();
    ids.insert(held.index.min(ids.len()), held.entry.id.clone());
    message_queue::reorder(store, session_id, &ids)?;
    held.restored = true;
    held.deliveries = message_queue::deliveries(session_id);
    Ok(())
}

#[derive(Debug, PartialEq)]
struct QueueRestore {
    session_id: String,
    id: String,
}

fn parse_queue_restore(params: &Value) -> Result<Box<dyn Run>> {
    Ok(Box::new(QueueRestore { session_id: id_param(params, "sessionId")?, id: id_param(params, "id")? }))
}

impl Run for QueueRestore {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        let QueueRestore { session_id, id } = *self;
        let session = session_id.clone();
        // No mode check: this only puts back an entry the task already had queued.
        Box::pin(on_queue(ctx, session_id, true, move |store| {
            let mut holding = QUEUE_HOLDING.lock().map_err(|e| e.to_string())?;
            restore_held(store, &mut holding, &session, &id, std::time::Instant::now())
        }))
    }
}

#[derive(Debug, PartialEq)]
struct QueueReorder {
    session_id: String,
    ids: Vec<String>,
}

fn parse_queue_reorder(params: &Value) -> Result<Box<dyn Run>> {
    let list = params["ids"].as_array().filter(|ids| ids.len() <= MAX_QUEUE).ok_or("Invalid ids.")?;
    let ids = list.iter().map(|id| id.as_str().filter(|id| super::valid_id(id).is_ok()).map(str::to_owned).ok_or("Invalid ids.")).collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(Box::new(QueueReorder { session_id: id_param(params, "sessionId")?, ids }))
}

impl Run for QueueReorder {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        let QueueReorder { session_id, ids } = *self;
        let session = session_id.clone();
        Box::pin(on_queue(ctx, session_id, true, move |store| message_queue::reorder(store, &session, &ids).map(|_| ())))
    }
}

// ---- usage.* ----

#[derive(Debug, PartialEq)]
struct UsageGet {
    session_id: Option<String>,
    refresh: bool,
}

fn parse_usage_get(params: &Value) -> Result<Box<dyn Run>> {
    Ok(Box::new(UsageGet { session_id: optional_id(params, "sessionId")?, refresh: optional_bool(params, "refresh")? }))
}

/// Token and cost totals per provider over the last `hours` from the ledger's hourly rows
/// (`[unixHour, modelIndex, input, cacheRead, cacheWrite, output, costUsd, savingsUsd]`).
fn ledger_totals(ledger: &Value, now_hour: i64, hours: i64) -> Value {
    let models = ledger["models"].as_array().cloned().unwrap_or_default();
    let mut totals = serde_json::Map::new();
    for row in ledger["rows"].as_array().into_iter().flatten() {
        let Some(row) = row.as_array().filter(|row| row.len() >= 7) else { continue };
        if row[0].as_i64().is_none_or(|hour| hour <= now_hour - hours) {
            continue;
        }
        let Some(provider) = row[1].as_u64().and_then(|index| models.get(index as usize)).and_then(|model| model["provider"].as_str()) else { continue };
        let entry = totals.entry(provider.to_owned()).or_insert_with(|| json!({ "input": 0, "cacheRead": 0, "cacheWrite": 0, "output": 0, "cost": 0.0 }));
        for (key, index) in [("input", 2), ("cacheRead", 3), ("cacheWrite", 4), ("output", 5)] {
            entry[key] = json!(entry[key].as_u64().unwrap_or(0) + row[index].as_u64().unwrap_or(0));
        }
        entry["cost"] = json!(entry["cost"].as_f64().unwrap_or(0.0) + row[6].as_f64().unwrap_or(0.0));
    }
    Value::Object(totals)
}

/// Day and week totals from the desktop's usage ledger; null when it can't be read here
/// (no main window, as on a headless host).
async fn ledger_summary(app: &tauri::AppHandle, refresh: bool) -> Value {
    let Some(window) = app.get_webview_window("main") else { return Value::Null };
    let Ok(ledger) = crate::usage_ledger::usage_ledger(app.clone(), window, Some(refresh)).await else { return Value::Null };
    let Ok(ledger) = serde_json::to_value(ledger) else { return Value::Null };
    let now_hour = crate::storage::now().div_euclid(3_600_000);
    json!({ "scannedAt": ledger["scannedAt"], "day": ledger_totals(&ledger, now_hour, DAY_HOURS), "week": ledger_totals(&ledger, now_hour, WEEK_HOURS) })
}

impl Run for UsageGet {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let providers: Vec<Value> = crate::local_providers(false).await.into_iter().filter(|p| p.installed).map(|p| json!({ "id": p.id, "name": p.name })).collect();
            let ledger = ledger_summary(ctx.app, self.refresh).await;
            let task = match self.session_id {
                None => Value::Null,
                Some(session_id) => {
                    let state = ctx.state();
                    let task = local_task(&state, &session_id).await?;
                    let links = state.store.lock().map_err(|e| e.to_string())?.usage_links(&session_id)?;
                    let tokens = if links.is_empty() {
                        Value::Null
                    } else {
                        let dir = ctx.app.path().app_data_dir().map_err(|e| e.to_string())?;
                        let usage = crate::usage_ledger::task_usage(dir, links, None).await?;
                        if usage.last_used.is_some() { serde_json::to_value(usage).map_err(|e| e.to_string())? } else { Value::Null }
                    };
                    json!({
                        "sessionId": task.id,
                        "provider": task.provider,
                        "limitedAt": task.limited_at,
                        "limitedUntil": task.limited_until,
                        "resumeAtReset": task.resume_at_reset,
                        "contextUsage": task.context_usage,
                        "tokens": tokens,
                    })
                }
            };
            Ok(json!({ "providers": providers, "ledger": ledger, "task": task }))
        })
    }
}

/// One provider's limit windows, as Settings → Usage reads them (cached on the host).
#[derive(Debug, PartialEq)]
struct UsageLimits {
    provider: String,
    refresh: bool,
}

fn parse_usage_limits(params: &Value) -> Result<Box<dyn Run>> {
    let provider = name_param(params, "provider")?.ok_or("Missing provider.")?;
    Ok(Box::new(UsageLimits { provider, refresh: optional_bool(params, "refresh")? }))
}

impl Run for UsageLimits {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            if self.refresh {
                require_control(&ctx)?;
            }
            let usage = crate::agent_usage::query_usage(self.provider, self.refresh).await?;
            serde_json::to_value(usage).map_err(|e| e.to_string())
        })
    }
}

#[derive(Debug, PartialEq)]
struct ResumeAtReset {
    session_id: String,
    on: bool,
}

fn parse_resume_at_reset(params: &Value) -> Result<Box<dyn Run>> {
    let on = params.get("on").and_then(Value::as_bool).ok_or("Invalid on.")?;
    Ok(Box::new(ResumeAtReset { session_id: id_param(params, "sessionId")?, on }))
}

impl Run for ResumeAtReset {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let state = ctx.state();
            // Resuming at the reset starts the agent again, so it follows the rule for prompts.
            let task = if self.on { drivable_task(ctx.app, ctx.from, &self.session_id, ctx.full_access).await? } else { local_task(&state, &self.session_id).await? };
            if self.on {
                allow_task_mode(&task.mode, None, ctx.full_access)?;
            }
            let task = state.store.lock().map_err(|e| e.to_string())?.set_resume_at_reset(&self.session_id, self.on)?;
            let _ = ctx.app.emit("sessions-changed", ());
            Ok(json!({ "resumeAtReset": task.resume_at_reset, "limitedUntil": task.limited_until }))
        })
    }
}

/// "Continue now": forgets the task's limit, as `clear_usage_limit` does.
#[derive(Debug, PartialEq)]
struct ClearLimit {
    session_id: String,
}

fn parse_clear_limit(params: &Value) -> Result<Box<dyn Run>> {
    Ok(Box::new(ClearLimit { session_id: id_param(params, "sessionId")? }))
}

impl Run for ClearLimit {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let state = ctx.state();
            let task = drivable_task(ctx.app, ctx.from, &self.session_id, ctx.full_access).await?;
            allow_task_mode(&task.mode, None, ctx.full_access)?;
            state.store.lock().map_err(|e| e.to_string())?.clear_limited(&self.session_id)?;
            crate::architect::wake(ctx.app.clone());
            let _ = ctx.app.emit("sessions-changed", ());
            Ok(json!({}))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parsed(name: &str, params: Value) -> Result<String> {
        super::super::parse(name, &params).expect("registered").map(|p| format!("{:?}", p.call))
    }

    /// Round 10: a View device's cache miss is answered from the snapshot, never by starting
    /// the harness in the project; only Control (and `force`, which needs it) runs discovery.
    #[test]
    fn view_devices_never_launch_slash_discovery() {
        let cwd = std::env::temp_dir().join(format!("pandacode-slash-view-{}", uuid::Uuid::new_v4().simple()));
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let started = std::time::Instant::now();
        let listed = runtime.block_on(listed_catalog("claude", &cwd, false, false)).unwrap();
        assert!(started.elapsed() < std::time::Duration::from_secs(2), "no harness started");
        let snapshot = slash_commands::snapshot("claude", &cwd).unwrap();
        assert_eq!(serde_json::to_value(&listed).unwrap(), serde_json::to_value(&snapshot).unwrap());
        assert!(runtime.block_on(listed_catalog("nope", &cwd, false, false)).is_err(), "providers still validated");
        let source = include_str!("composer.rs");
        let body = &source[source.find("impl Run for SlashList").unwrap()..];
        let body = &body[..body.find("\n}\n").unwrap()];
        assert!(body.contains("let control = may_discover(&ctx, &mode);"));
        assert!(body.contains("listed_catalog(&provider, &cwd, self.force, control)"));
        assert!(!body.contains("slash_commands::catalog("), "only listed_catalog may launch discovery");
    }

    /// Round 11: discovery needs Control *and* the task's mode (a full-mode task needs the
    /// host switch); slash.resolve falls back to the known catalog the same way.
    /// Round 17: a queue change also drains an idle task on a headless host, which has no
    /// webview to answer `queue-changed`; read-only listing never drains.
    #[test]
    fn queue_changes_drain_on_a_headless_host() {
        let source = include_str!("composer.rs");
        let body = &source[source.find("async fn on_queue").unwrap()..];
        let body = &body[..body.find("\n}\n").unwrap()];
        let changed = &body[body.find("if changes {").unwrap()..];
        assert!(changed.find("emit(\"queue-changed\"").unwrap() < changed.find("crate::headless::queue_changed(ctx.app, &session_id);").unwrap());
        let list = &source[source.find("impl Run for QueueList").unwrap()..];
        assert!(list[..list.find("\n}\n").unwrap()].contains("on_queue(ctx, self.session_id, false,"));
    }

    #[test]
    fn slash_discovery_needs_control_and_the_task_mode() {
        let source = include_str!("composer.rs");
        let gate = &source[source.find("fn may_discover").unwrap()..];
        let gate = &gate[..gate.find("\n}\n").unwrap()];
        assert!(gate.contains("allow_task_mode(mode, None, ctx.full_access).is_ok() && require_control(ctx).is_ok()"));
        let resolve = &source[source.find("impl Run for SlashResolve").unwrap()..];
        let resolve = &resolve[..resolve.find("\n}\n").unwrap()];
        assert!(resolve.find("may_discover(&ctx, &mode)").unwrap() < resolve.find("slash_commands::resolve(").unwrap());
        assert!(resolve.contains("slash_commands::resolve_known("));
        let cwd = std::env::temp_dir().join(format!("pandacode-slash-known-{}", uuid::Uuid::new_v4().simple()));
        let started = std::time::Instant::now();
        let unknown = slash_commands::resolve_known("claude", &cwd, "/definitely-not-a-command now");
        assert!(started.elapsed() < std::time::Duration::from_secs(2), "no harness started");
        assert!(unknown.err().unwrap().contains("Unknown command"));
        assert_eq!(slash_commands::resolve_known("claude", &cwd, "plain text").unwrap().prompt, "plain text");
        assert!(slash_commands::resolve_known("nope", &cwd, "/review").is_err());
    }

    /// Round 12: discovery starts the harness in the project, so no remote method may reach it
    /// except through `listed_catalog` (behind `may_discover`) or `SlashResolve`'s gated branch.
    #[test]
    fn remote_paths_reach_discovery_only_through_the_gate() {
        let remote = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/remote");
        let mut files: Vec<_> = std::fs::read_dir(remote.join("methods")).unwrap().map(|entry| entry.unwrap().path()).filter(|path| path.extension().is_some_and(|ext| ext == "rs")).collect();
        files.push(remote.join("host.rs"));
        assert!(files.len() > 5, "found the method files");
        let calls = ["list_slash_commands(", "resolve_slash_command(", "slash_commands::catalog(", "slash_commands::resolve(", "slash_commands::discover"];
        for path in files {
            let source = std::fs::read_to_string(&path).unwrap();
            // Tests may name the calls; shipped code may not.
            let shipped = source.split("#[cfg(test)]\nmod tests").next().unwrap();
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            for call in calls {
                for (at, _) in shipped.match_indices(call) {
                    let allowed = name == "composer.rs" && {
                        let before = &shipped[..at];
                        let owner = before.rfind("\nfn ").max(before.rfind("\nasync fn ")).max(before.rfind("\nimpl ")).map_or("", |start| shipped[start + 1..].lines().next().unwrap_or(""));
                        (call == "slash_commands::catalog(" && owner.starts_with("async fn listed_catalog("))
                            || (call == "slash_commands::resolve(" && owner.starts_with("impl Run for SlashResolve") && before[before.rfind("impl Run for SlashResolve").unwrap()..].contains("if may_discover(&ctx, &mode)"))
                    };
                    assert!(allowed, "{name} calls {call} outside the gated helpers");
                }
            }
        }
        let helper = &source_of("pub(super) async fn task_catalog");
        assert!(helper.contains("listed_catalog(&provider, &cwd, false, may_discover(ctx, mode))"));
    }

    fn source_of(start: &str) -> String {
        let source = include_str!("composer.rs");
        let body = &source[source.find(start).unwrap()..];
        body[..body.find("\n}\n").unwrap()].to_owned()
    }

    #[test]
    fn scopes_match_effects() {
        for (name, access, read_only) in [
            ("slash.list", Access::View, true),
            ("slash.resolve", Access::Control, false),
            ("btw.ask", Access::Control, false),
            ("queue.list", Access::View, true),
            ("queue.update", Access::Control, false),
            ("queue.remove", Access::Control, false),
            ("queue.reorder", Access::Control, false),
            ("queue.restore", Access::Control, false),
            ("usage.get", Access::View, true),
            ("usage.limits", Access::View, true),
            ("usage.resumeAtReset", Access::Control, false),
            ("usage.clearLimit", Access::Control, false),
        ] {
            let method = super::super::find(name).unwrap_or_else(|| panic!("{name} missing"));
            assert_eq!((method.access, method.read_only), (access, read_only), "{name}");
        }
    }

    #[test]
    fn params_are_validated() {
        assert!(parsed("slash.list", json!({"sessionId": "s1"})).is_ok());
        assert!(parsed("slash.list", json!({})).is_err());
        assert!(parsed("slash.list", json!({"sessionId": "s1", "force": "yes"})).is_err());
        assert!(parsed("slash.resolve", json!({"sessionId": "s1", "text": "/review now"})).is_ok());
        assert!(parsed("slash.resolve", json!({"sessionId": "s1", "text": "hello"})).is_err());
        assert!(parsed("slash.resolve", json!({"sessionId": "s1", "text": ""})).is_err());
        assert!(parsed("btw.ask", json!({"sessionId": "s1", "text": "why?"})).is_ok());
        assert!(parsed("btw.ask", json!({"sessionId": "s1", "text": "why?", "sideId": "s2", "seenId": 9})).is_ok());
        assert!(parsed("btw.ask", json!({"sessionId": "s1", "text": "why?", "seenId": -1})).is_err());
        assert!(parsed("btw.ask", json!({"sessionId": "s1", "text": "why?", "sideId": "bad id"})).is_err());
        assert!(parsed("queue.update", json!({"sessionId": "s1", "id": "q1", "text": "  "})).is_err());
        assert!(parsed("queue.remove", json!({"sessionId": "s1"})).is_err());
        assert!(parsed("queue.restore", json!({"sessionId": "s1"})).is_err());
        assert!(parsed("queue.restore", json!({"sessionId": "s1", "id": "q1"})).is_ok());
        assert!(parsed("queue.reorder", json!({"sessionId": "s1", "ids": ["a", "b"]})).is_ok());
        assert!(parsed("queue.reorder", json!({"sessionId": "s1", "ids": ["a", 3]})).is_err());
        assert!(parsed("queue.reorder", json!({"sessionId": "s1", "ids": vec!["a"; MAX_QUEUE + 1]})).is_err());
        assert!(parsed("usage.get", json!({})).is_ok());
        assert!(parsed("usage.get", json!({"sessionId": ""})).is_err());
        assert!(parsed("usage.limits", json!({})).is_err());
        assert!(parsed("usage.limits", json!({"provider": "../x y"})).is_err());
        assert!(parsed("usage.limits", json!({"provider": "claude", "refresh": true})).is_ok());
        assert!(parsed("usage.resumeAtReset", json!({"sessionId": "s1"})).is_err());
        assert!(parsed("usage.resumeAtReset", json!({"sessionId": "s1", "on": true})).is_ok());
    }

    #[test]
    fn resolution_tells_the_phone_what_to_send() {
        let plain = slash_commands::Resolution { action: None, arguments: String::new(), accepts_attachments: true, maintenance: false, prompt: String::new(), skill: None };
        assert_eq!(resolution_reply("/review x", &plain)["send"], "/review x");
        let init = slash_commands::Resolution { action: Some("init".into()), arguments: "short".into(), ..plain };
        let reply = resolution_reply("/init short", &init);
        assert!(reply["send"].as_str().unwrap().starts_with("Inspect this repository") && reply["send"].as_str().unwrap().ends_with("\nshort"));
        let btw = slash_commands::Resolution { action: Some("btw".into()), arguments: "why".into(), accepts_attachments: false, maintenance: false, prompt: String::new(), skill: None };
        let reply = resolution_reply("/btw why", &btw);
        assert_eq!((reply["action"].as_str(), reply["send"].is_null()), (Some("btw"), true));
    }

    #[test]
    fn side_titles_match_the_desktop() {
        assert_eq!(side_title("what does **this** do?"), "BTW: what does this do?");
        assert_eq!(side_title("   "), "BTW: Side thread");
        let long = side_title(&"a".repeat(60));
        assert_eq!(long.chars().count(), TITLE_PREFIX.len() + 48);
        assert!(long.ends_with('…'));
    }

    #[test]
    fn main_context_reports_only_news() {
        let messages = vec![
            (1, "user".to_owned(), "Fix the login\n\nFile context: a.ts".to_owned()),
            (2, "assistant".to_owned(), "Done.".to_owned()),
            (3, "tool".to_owned(), "ignored".to_owned()),
        ];
        let (text, seen) = main_context("Login", "idle", &messages, 0, CONTEXT_LIMIT, false);
        assert_eq!(seen, 2);
        assert!(text.contains("Recent main-thread messages:") && text.contains("User: Fix the login") && text.contains("Agent: Done."));
        assert!(!text.contains("File context") && !text.contains("ignored"));
        let (text, seen) = main_context("Login", "running", &messages, 2, CONTEXT_LIMIT, false);
        assert_eq!(seen, 2);
        assert!(text.contains("Nothing new in the main thread") && text.contains("(running)"));
        let long = vec![(5, "assistant".to_owned(), "x".repeat(2000))];
        let (text, _) = main_context("T", "idle", &long, 0, 1024, false);
        assert!(text.contains("left out") && text.contains('…'));
    }

    #[test]
    fn ledger_totals_sum_recent_hours_by_provider() {
        let ledger = json!({
            "models": [{"provider": "claude"}, {"provider": "codex"}],
            "rows": [[100, 0, 10, 1, 2, 5, 0.5, 0.0], [99, 0, 10, 0, 0, 5, 0.5, 0.0], [70, 1, 1, 0, 0, 1, 0.1, 0.0], [76, 1, 5, 0, 0, 5, 0.1, 0.0], [100, 9, 1, 1, 1, 1, 1.0, 0.0]],
        });
        let day = ledger_totals(&ledger, 100, 24);
        assert_eq!(day["claude"]["input"], 20);
        assert_eq!(day["claude"]["output"], 10);
        assert!((day["claude"]["cost"].as_f64().unwrap() - 1.0).abs() < 1e-9);
        assert!(day.get("codex").is_none());
        // Hour 76 is exactly 24 hours old: in the week, out of the day.
        assert_eq!(ledger_totals(&ledger, 100, 168)["codex"]["input"], 6);
    }

    #[test]
    fn queue_rows_keep_replies_small() {
        let entry = message_queue::QueuedMessage { id: "q".into(), session_id: "s".into(), position: 0, text: "y".repeat(QUEUE_PREVIEW + 10), attachments: json!([{}, {}]), created_at: 1, updated_at: 2 };
        let row = queue_row(&entry);
        assert_eq!((row["truncated"].as_bool(), row["attachments"].as_u64()), (Some(true), Some(2)));
        assert!(serde_json::to_string(&queue_reply(&vec![entry; MAX_QUEUE])).unwrap().len() < PAGE_BUDGET);
    }

    #[test]
    fn side_links_only_accept_sides_made_for_that_main() {
        let mut links = SideLinks::default();
        links.link("main", "side");
        assert!(links.is_linked("main", "side"));
        assert!(!links.is_linked("other", "side"));
        assert!(!links.is_linked("main", "full-task"));
        for n in 0..MAX_SIDES {
            links.link("m", &format!("s{n}"));
        }
        assert_eq!(links.links.len(), MAX_SIDES);
        assert!(!links.is_linked("main", "side"), "oldest link is forgotten");
    }

    #[test]
    fn reusable_side_needs_a_link_and_the_same_project() {
        let main = ("m", "p");
        assert!(reusable_side(main, ("s", "p", false), true));
        assert!(!reusable_side(main, ("s", "p", false), false));
        assert!(!reusable_side(main, ("s", "q", false), true));
        assert!(!reusable_side(main, ("s", "p", true), true));
        assert!(!reusable_side(main, ("m", "p", false), true));
    }

    #[test]
    fn full_mode_side_threads_and_queue_edits_need_full_access() {
        assert!(allow_task_mode("full", None, false).is_err());
        assert!(queue_edit_allowed("full", false).is_err());
        assert!(queue_edit_allowed("full", true).is_ok());
        assert!(queue_edit_allowed("auto", false).is_ok());
    }

    #[test]
    fn control_probe_is_a_control_method() {
        assert_eq!(super::super::find(CONTROL_PROBE).map(|m| m.access), Some(Access::Control));
    }

    #[test]
    fn strip_context_cuts_attached_blocks() {
        assert_eq!(strip_context("hi\n\nAttached image: x"), "hi");
        assert_eq!(strip_context("hi\n\nmore text"), "hi\n\nmore text");
    }

    #[test]
    fn btw_ask_reads_the_store_off_the_async_runtime() {
        let source = include_str!("composer.rs");
        let body = &source[source.find("async fn ask(self: Box<Self>").unwrap()..];
        let body = &body[..body.find("\n    }\n").unwrap()];
        assert!(body.contains("crate::blocking(move || {\n            let found = self.side("), "side() runs in crate::blocking");
        assert!(body.contains("crate::blocking(move || ask.prompt("), "prompt() runs in crate::blocking");
        assert!(!body.contains("self.side(&state)") && !body.contains("ask.prompt(&state)"));
    }

    fn queue_store() -> (crate::storage::Store, String, std::path::PathBuf) {
        let store = crate::storage::Store::open(std::path::Path::new(":memory:")).unwrap();
        let base = std::env::temp_dir().join(format!("pandacode-queue-hold-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&base).unwrap();
        let project = store.add_project(&base).unwrap();
        let task = store.create_session(&project.id, "codex", "m", "full").unwrap();
        (store, task.id, base)
    }

    /// Removes `id` the way `queue.remove` does, into `holding`, at `at`.
    fn remove_into(store: &crate::storage::Store, holding: &mut QueueHolding, session: &str, id: &str, at: std::time::Instant) {
        let entries = message_queue::list(store, Some(session)).unwrap();
        let index = entries.iter().position(|entry| entry.id == id).unwrap();
        message_queue::remove(store, id).unwrap();
        holding.hold(Held::new(&entries, index, message_queue::deliveries(session), at));
    }

    fn queue_ids(store: &crate::storage::Store, session: &str) -> Vec<String> {
        message_queue::list(store, Some(session)).unwrap().into_iter().map(|entry| entry.id).collect()
    }

    /// Round 21: a phone's queue edit drains a headless host's idle task only when that device
    /// could send to it: the task's mode and the bot-thread guard, as `task.send`.
    #[test]
    fn a_queue_edit_drains_only_where_the_device_could_send() {
        let (store, full_task, base) = queue_store();
        let project = store.projects().unwrap().remove(0);
        let plain = store.create_session(&project.id, "codex", "m", "auto").unwrap();
        assert!(may_drain(&store, &plain.id, false, false));
        assert!(!may_drain(&store, &full_task, true, false), "a Full-access thread needs the switch");
        assert!(may_drain(&store, &full_task, false, true));
        let bot_home = base.join("bot");
        std::fs::create_dir_all(&bot_home).unwrap();
        let bot_project = store.add_project(&bot_home).unwrap();
        store
            .db
            .execute("INSERT INTO bots(id,name,project_id,provider,model,mode,created_at,updated_at) VALUES('b','Bot',?1,'claude','sonnet','auto',0,0)", [&bot_project.id])
            .unwrap();
        let bot_task = store.create_session(&bot_project.id, "claude", "sonnet", "auto").unwrap();
        assert!(!may_drain(&store, &bot_task.id, false, true), "a Control device never drives a bot's thread");
        assert!(may_drain(&store, &bot_task.id, true, false));
        assert!(!may_drain(&store, "missing", true, true));
        let source = include_str!("composer.rs");
        let hook = &source[source.find("async fn on_queue(").unwrap()..];
        let hook = &hook[..hook.find("\n}\n").unwrap()];
        assert!(hook.contains("let drain = changes && may_drain(&store, &id, device_full, full_access);"));
        assert!(hook.find("if drain {").unwrap() < hook.find("crate::headless::queue_changed(").unwrap());
        let _ = std::fs::remove_dir_all(&base);
    }

    /// Round 22: a `queue.remove` retried after its reply was lost answers success while this
    /// host holds the entry, so the phone still gets its Undo; anything else stays refused.
    #[test]
    fn a_retried_queue_remove_answers_from_the_hold() {
        let (store, task, base) = queue_store();
        let a = message_queue::add(&store, &task, "first", &json!([])).unwrap();
        let b = message_queue::add(&store, &task, "second", &json!([])).unwrap();
        let mut holding = QueueHolding::default();
        let now = std::time::Instant::now();
        remove_queued(&store, &mut holding, &task, &a.id, now).unwrap();
        assert_eq!(queue_ids(&store, &task), vec![b.id.clone()]);
        remove_queued(&store, &mut holding, &task, &a.id, now).expect("the retry finds the hold");
        restore_held(&store, &mut holding, &task, &a.id, now).expect("and Undo still works");
        assert_eq!(queue_ids(&store, &task), vec![a.id.clone(), b.id.clone()]);
        // Put back and then sent elsewhere: no longer this host's removal.
        message_queue::remove(&store, &a.id).unwrap();
        assert_eq!(remove_queued(&store, &mut holding, &task, &a.id, now).unwrap_err(), "This queued message was already sent or removed.");
        // Removed on the desktop (never held), past the window, or for another task.
        message_queue::remove(&store, &b.id).unwrap();
        assert!(remove_queued(&store, &mut holding, &task, &b.id, now).is_err());
        let c = message_queue::add(&store, &task, "third", &json!([])).unwrap();
        remove_queued(&store, &mut holding, &task, &c.id, now).unwrap();
        assert!(remove_queued(&store, &mut holding, &task, &c.id, now + HOLD_FOR).is_err(), "past the hold window");
        let d = message_queue::add(&store, &task, "fourth", &json!([])).unwrap();
        remove_queued(&store, &mut holding, &task, &d.id, now).unwrap();
        assert!(remove_queued(&store, &mut holding, "other-task", &d.id, now).is_err());
        let source = include_str!("composer.rs");
        let remove = &source[source.find("impl Run for QueueRemove").unwrap()..];
        assert!(remove[..remove.find("\n}\n").unwrap()].contains("remove_queued(store, &mut holding, &session, &id,"));
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn queue_restore_puts_the_exact_entry_back_in_place() {
        let (store, task, base) = queue_store();
        let a = message_queue::add(&store, &task, "first", &json!([])).unwrap();
        let b = message_queue::add(&store, &task, &"long ".repeat(2_000), &json!([{"kind": "image", "path": "/tmp/x.png"}])).unwrap();
        let c = message_queue::add(&store, &task, "third", &json!([])).unwrap();
        let mut holding = QueueHolding::default();
        let now = std::time::Instant::now();
        remove_into(&store, &mut holding, &task, &b.id, now);
        assert_eq!(queue_ids(&store, &task), vec![a.id.clone(), c.id.clone()]);
        restore_held(&store, &mut holding, &task, &b.id, now).unwrap();
        assert_eq!(queue_ids(&store, &task), vec![a.id.clone(), b.id.clone(), c.id.clone()]);
        let back = message_queue::list(&store, Some(&task)).unwrap().into_iter().find(|entry| entry.id == b.id).unwrap();
        assert_eq!((back.text, back.attachments, back.created_at), (b.text.clone(), b.attachments.clone(), b.created_at));
        restore_held(&store, &mut holding, &task, &b.id, now).expect("idempotent while queued");
        // Removed again outside `queue.remove` (the desktop): `restored` alone is no success.
        message_queue::remove(&store, &b.id).unwrap();
        assert_eq!(restore_held(&store, &mut holding, &task, &b.id, now).unwrap_err(), CANNOT_RESTORE, "gone again since the restore");
        assert_eq!(queue_ids(&store, &task), vec![a.id.clone(), c.id.clone()], "a retry never adds it twice");
        // The old index is clamped to the queue's length now.
        remove_into(&store, &mut holding, &task, &c.id, now);
        message_queue::remove(&store, &a.id).unwrap();
        restore_held(&store, &mut holding, &task, &c.id, now).unwrap();
        assert_eq!(queue_ids(&store, &task), vec![c.id.clone()]);
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn queue_restore_refuses_after_the_window_or_a_delivery() {
        let (store, task, base) = queue_store();
        let a = message_queue::add(&store, &task, "first", &json!([])).unwrap();
        let b = message_queue::add(&store, &task, "second", &json!([])).unwrap();
        let mut holding = QueueHolding::default();
        let now = std::time::Instant::now();
        remove_into(&store, &mut holding, &task, &a.id, now);
        assert_eq!(restore_held(&store, &mut holding, &task, &a.id, now + HOLD_FOR).unwrap_err(), CANNOT_RESTORE);
        let c = message_queue::add(&store, &task, "third", &json!([])).unwrap();
        remove_into(&store, &mut holding, &task, &c.id, now);
        // The queue delivers `b`.
        message_queue::take(&store, &b.id).unwrap();
        store.start_turn_message(&task, "second").unwrap();
        assert_eq!(restore_held(&store, &mut holding, &task, &c.id, now).unwrap_err(), CANNOT_RESTORE, "the queue moved on");
        assert_eq!(restore_held(&store, &mut holding, &task, "unknown", now).unwrap_err(), CANNOT_RESTORE);
        assert_eq!(restore_held(&store, &mut holding, "other-task", &c.id, now).unwrap_err(), CANNOT_RESTORE, "only the task it came from");
        assert!(queue_ids(&store, &task).is_empty());
        let _ = std::fs::remove_dir_all(base);
    }

    /// A restored entry that the queue then sent is gone for good: the retry reports that it
    /// can't be put back instead of answering the earlier restore.
    #[test]
    fn queue_restore_after_a_restored_entry_was_sent_is_refused() {
        let (store, task, base) = queue_store();
        let a = message_queue::add(&store, &task, "first", &json!([])).unwrap();
        let mut holding = QueueHolding::default();
        let now = std::time::Instant::now();
        remove_into(&store, &mut holding, &task, &a.id, now);
        restore_held(&store, &mut holding, &task, &a.id, now).unwrap();
        // Delivered by the queue.
        message_queue::take(&store, &a.id).unwrap();
        store.start_turn_message(&task, "first").unwrap();
        assert_eq!(restore_held(&store, &mut holding, &task, &a.id, now).unwrap_err(), CANNOT_RESTORE);
        assert!(queue_ids(&store, &task).is_empty());
        let _ = std::fs::remove_dir_all(base);
    }

    /// A prompt sent straight to the task adds a user message but takes nothing from the
    /// queue, so Undo still puts the removed entry back.
    #[test]
    fn queue_restore_survives_a_direct_send() {
        let (store, task, base) = queue_store();
        let a = message_queue::add(&store, &task, "first", &json!([])).unwrap();
        let b = message_queue::add(&store, &task, "second", &json!([])).unwrap();
        let c = message_queue::add(&store, &task, "third", &json!([])).unwrap();
        let mut holding = QueueHolding::default();
        let now = std::time::Instant::now();
        remove_into(&store, &mut holding, &task, &b.id, now);
        store.start_turn_message(&task, "typed instead").unwrap();
        restore_held(&store, &mut holding, &task, &b.id, now).expect("a direct send never blocks Undo");
        assert_eq!(queue_ids(&store, &task), vec![a.id.clone(), b.id.clone(), c.id.clone()]);
        // Alone in the queue, a direct send leaves Undo available too.
        remove_into(&store, &mut holding, &task, &a.id, now);
        remove_into(&store, &mut holding, &task, &c.id, now);
        remove_into(&store, &mut holding, &task, &b.id, now);
        store.start_turn_message(&task, "another").unwrap();
        restore_held(&store, &mut holding, &task, &b.id, now).unwrap();
        assert_eq!(queue_ids(&store, &task), vec![b.id.clone()]);
        let _ = std::fs::remove_dir_all(base);
    }

    /// The removed entry was alone in the queue; an entry queued after the removal is
    /// delivered before the Undo, so the queue moved on and the Undo is refused.
    #[test]
    fn queue_restore_refuses_after_a_later_entry_was_delivered() {
        let (store, task, base) = queue_store();
        let a = message_queue::add(&store, &task, "first", &json!([])).unwrap();
        let mut holding = QueueHolding::default();
        let now = std::time::Instant::now();
        remove_into(&store, &mut holding, &task, &a.id, now);
        let b = message_queue::add(&store, &task, "added later", &json!([])).unwrap();
        message_queue::take(&store, &b.id).unwrap();
        store.start_turn_message(&task, "added later").unwrap();
        assert_eq!(restore_held(&store, &mut holding, &task, &a.id, now).unwrap_err(), CANNOT_RESTORE);
        assert!(queue_ids(&store, &task).is_empty());
        let _ = std::fs::remove_dir_all(base);
    }

    /// Another task's queue delivering never blocks this task's Undo.
    #[test]
    fn queue_restore_ignores_other_tasks_deliveries() {
        let (store, task, base) = queue_store();
        let project = store.session(&task).unwrap().project_id;
        let other = store.create_session(&project, "codex", "m", "full").unwrap().id;
        let a = message_queue::add(&store, &task, "first", &json!([])).unwrap();
        let elsewhere = message_queue::add(&store, &other, "elsewhere", &json!([])).unwrap();
        let mut holding = QueueHolding::default();
        let now = std::time::Instant::now();
        remove_into(&store, &mut holding, &task, &a.id, now);
        message_queue::take(&store, &elsewhere.id).unwrap();
        restore_held(&store, &mut holding, &task, &a.id, now).unwrap();
        assert_eq!(queue_ids(&store, &task), vec![a.id.clone()]);
        let _ = std::fs::remove_dir_all(base);
    }

    /// Round 20: `restored` is set only once the entry is back and in place; a failed restore
    /// leaves the hold as it was, and a restored entry reports success only while queued.
    #[test]
    fn queue_restore_marks_restored_only_after_it_is_back() {
        let (store, task, base) = queue_store();
        let mut holding = QueueHolding::default();
        let now = std::time::Instant::now();
        let ghost = message_queue::QueuedMessage { id: "q-ghost".into(), session_id: "no-such-task".into(), position: 0, text: "t".into(), attachments: json!([]), created_at: 1, updated_at: 1 };
        holding.hold(Held { entry: ghost, index: 0, deliveries: message_queue::deliveries("no-such-task"), at: now, restored: false });
        assert!(restore_held(&store, &mut holding, "no-such-task", "q-ghost", now).is_err());
        assert!(!holding.find("no-such-task", "q-ghost", now).unwrap().restored, "a failed restore is not marked restored");
        let a = message_queue::add(&store, &task, "first", &json!([])).unwrap();
        remove_into(&store, &mut holding, &task, &a.id, now);
        restore_held(&store, &mut holding, &task, &a.id, now).unwrap();
        assert!(holding.find(&task, &a.id, now).unwrap().restored);
        assert_eq!(queue_ids(&store, &task), vec![a.id.clone()]);
        restore_held(&store, &mut holding, &task, &a.id, now).expect("present again: success");
        message_queue::remove(&store, &a.id).unwrap();
        assert_eq!(restore_held(&store, &mut holding, &task, &a.id, now).unwrap_err(), CANNOT_RESTORE);
        assert!(queue_ids(&store, &task).is_empty());
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn queue_holding_is_bounded_per_task() {
        let entry = |n: usize, session: &str| message_queue::QueuedMessage { id: format!("q{n}"), session_id: session.into(), position: 0, text: "t".into(), attachments: json!([]), created_at: 1, updated_at: 1 };
        let mut holding = QueueHolding::default();
        let now = std::time::Instant::now();
        for n in 0..HOLD_PER_TASK + 3 {
            holding.hold(Held { entry: entry(n, "s1"), index: 0, deliveries: 0, at: now, restored: false });
        }
        holding.hold(Held { entry: entry(99, "s2"), index: 0, deliveries: 0, at: now, restored: false });
        assert_eq!(holding.held.iter().filter(|held| held.entry.session_id == "s1").count(), HOLD_PER_TASK);
        assert!(holding.find("s1", "q0", now).is_none(), "the oldest goes first");
        assert!(holding.find("s1", &format!("q{}", HOLD_PER_TASK + 2), now).is_some());
        assert!(holding.find("s2", "q99", now).is_some());
        assert!(holding.find("s2", "q99", now + HOLD_FOR).is_none(), "expired holds are dropped");
        assert!(holding.held.is_empty());
    }
}
