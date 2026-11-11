//! PandaConnect methods for the `admin` feature group: a bot's settings (docs/bots.md) and
//! this computer's machines (local VMs, cloud sandboxes and agents, linked computers, model
//! routing). See `methods/mod.rs` and docs/remote-access.md, "Adding a method".
//!
//! Bots: `bot.detail` (View) is the desktop's bot page without secrets: channel configs and
//! saved-secret names, web chat tokens and the bot's instructions never leave the computer.
//! A device that may not decide pairings (below Full) sees no pairing codes and only the
//! last 4 characters of each sender id. `bot.remember`/`bot.forget` (Full: the bot acts on
//! its memory in every channel), `bot.runSchedule`, `bot.pairingDecide` and
//! `bot.failoverDecide` (Full) make the bot act or let someone talk to it, like
//! `bot.message`, which is Full too.
//!
//! Machines: `machines.list`, `cloud.machines`, `cloudAgents.list`, `cloudAgents.targets`
//! and `routing.status` (View) read; `vm.frame` (Control: a live screen of a VM) reads; `vm.start`/`vm.stop` and
//! `orchestration.respond` (Full; linking with `full` also needs the host's Full access) act.
//! `cloudAgents.start` (Full, and the host's Full access switch: it runs an agent on a cloud
//! machine with this computer's credentials) is the desktop's `cloud_agent_start`, once per
//! `startId` (`host::start_keyed`). Each runs the desktop's own command, so validation and events are the desktop's.
use super::{allow_task_mode, id_param, name_param, text_param, valid_id, Access, Ctx, Method, Reply, Run, PAGE_BUDGET};
use crate::bots::{self, channels, failover, guard, schedule};
use crate::Result;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::sync::Mutex;
use tauri::Manager;

/// What a phone may add as one memory; the desktop keeps the first 2000 characters.
const MAX_MEMORY: usize = 2000;
/// Sender ids are the channel's (phone numbers, Slack and Discord ids).
const MAX_SENDER: usize = 256;
/// Cloud agent rows `cloudAgents.list` returns.
const MAX_AGENTS: i64 = 200;
/// Base64 characters one `vm.frame` page carries; a multiple of 4.
const FRAME_CHUNK: usize = 160 * 1024;
/// A provider's error, cut so one noisy provider cannot fill the page.
const MAX_ERROR: usize = 300;
/// Characters of a sender id a device below Full still sees.
const SENDER_TAIL: usize = 4;
/// The method whose grant shows pairing codes and whole sender ids.
const PAIRING_PROBE: &str = "bot.pairingDecide";
/// A Control-scope method: a grant check against it tells whether the device has Control.
const CONTROL_PROBE: &str = "vm.frame";
/// What a View device gets only as counts: what the bot remembers, its schedule prompts and
/// its guard rules can hold private instructions and conversation details.
const CONTROL_LISTS: [(&str, &str); 3] = [("memories", "memoryCount"), ("schedules", "scheduleCount"), ("rules", "ruleCount")];

/// Runs `work` with the store locked, off the async runtime.
async fn with_store<T: Send + 'static>(ctx: &Ctx<'_>, work: impl FnOnce(&crate::storage::Store) -> Result<T> + Send + 'static) -> Result<T> {
    let store = ctx.state().store.clone();
    crate::blocking(move || work(&*store.lock().map_err(|e| e.to_string())?)).await
}

/// A bot in `full` mode runs its turns without approvals, so what makes it run (a schedule run
/// now, a newly approved sender) needs "Full access for remote tasks", as a full task does.
pub(crate) fn allow_bot_mode(store: &crate::storage::Store, bot_id: &str, full_access: bool) -> Result<()> {
    allow_task_mode(&bots::get(store, bot_id)?.mode, None, full_access)
}

fn bot_id(params: &Value) -> Result<String> {
    id_param(params, "botId")
}

/// A printable channel-side id: not empty, bounded, no control characters.
fn sender_param(params: &Value) -> Result<String> {
    let text = params["senderId"].as_str().ok_or("Missing senderId.")?;
    if text.is_empty() || text.len() > MAX_SENDER || text.chars().any(char::is_control) {
        return Err("Invalid senderId.".into());
    }
    Ok(text.to_owned())
}

fn bool_param(params: &Value, key: &str) -> Result<bool> {
    params[key].as_bool().ok_or_else(|| format!("Invalid {key}."))
}

// ---- bot.detail ----

/// The bot as the phone shows it: identity, model and state; never instructions, soul or goals.
fn bot_view(bot: &bots::Bot) -> Value {
    json!({
        "id": bot.id, "name": bot.name, "role": bot.role, "avatar": bot.avatar, "color": bot.color,
        "provider": bot.provider, "model": bot.model, "mode": bot.mode, "paused": bot.paused,
        "heartbeatMinutes": bot.heartbeat_minutes, "nextHeartbeatAt": bot.next_heartbeat_at, "projectId": bot.project_id,
    })
}

/// A channel without its config (tunnel addresses, identities) or the names of its saved secrets.
fn channel_view(channel: &channels::Channel) -> Value {
    let identity = channel.config["identity"]["name"].as_str().unwrap_or_default();
    json!({"id": channel.id, "kind": channel.kind, "label": channel.label, "enabled": channel.enabled, "status": channel.status, "identity": identity})
}

/// Drops what least needs to be on the phone until the reply fits a page: the avatar image,
/// then the oldest memories, then other lists from the end.
fn fit_detail(mut reply: Value) -> Value {
    let size = |reply: &Value| reply.to_string().len();
    if size(&reply) > PAGE_BUDGET && reply["bot"]["avatar"].as_str().is_some_and(|a| a.len() > 1024) {
        reply["bot"]["avatar"] = json!("");
    }
    for list in ["memories", "pairings", "rules", "schedules", "channels", "failovers"] {
        while size(&reply) > PAGE_BUDGET {
            let Some(items) = reply[list].as_array_mut().filter(|items| !items.is_empty()) else { break };
            items.remove(0);
            reply["truncated"] = json!(true);
        }
    }
    reply
}

/// A View device's detail: [`CONTROL_LISTS`] become counts (`memoryCount`, ...) with empty
/// lists, so a phone renders "3 memories" without their text.
fn limit_detail(mut reply: Value, control: bool) -> Value {
    if control {
        return reply;
    }
    for (list, count) in CONTROL_LISTS {
        reply[count] = json!(reply[list].as_array().map_or(0, Vec::len));
        reply[list] = json!([]);
    }
    reply["limited"] = json!(true);
    reply
}

/// `•••1234`: the last `SENDER_TAIL` characters, so a person is recognizable but not reachable.
fn mask_sender(sender: &str) -> String {
    let count = sender.chars().count();
    let tail: String = sender.chars().skip(count.saturating_sub(SENDER_TAIL)).collect();
    if count <= SENDER_TAIL {
        return "•".repeat(count.max(1));
    }
    format!("•••{tail}")
}

/// Pairings for a device that may not decide them: no code, masked sender ids.
fn redact_pairings(pairings: &[channels::Pairing]) -> Vec<Value> {
    pairings
        .iter()
        .map(|p| json!({"channelId": p.channel_id, "senderId": mask_sender(&p.sender_id), "senderName": p.sender_name, "status": p.status, "createdAt": p.created_at, "masked": true}))
        .collect()
}

#[derive(Debug)]
struct Detail {
    bot_id: String,
}

impl Run for Detail {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let id = self.bot_id;
            let whole = super::super::grants::check(ctx.app, ctx.from, PAIRING_PROBE).is_ok();
            let control = super::super::grants::check(ctx.app, ctx.from, CONTROL_PROBE).is_ok();
            let (mut reply, sessions) = with_store(&ctx, move |store| {
                let bot = bots::get(store, &id)?;
                let threads = bots::threads(store, &id)?;
                let pairings = channels::pairings(store, &id)?;
                let reply = json!({
                    "bot": bot_view(&bot),
                    "channels": channels::list(store, &id)?.iter().map(channel_view).collect::<Vec<_>>(),
                    "pairings": if whole { serde_json::to_value(pairings).map_err(|e| e.to_string())? } else { json!(redact_pairings(&pairings)) },
                    "rules": guard::rules(store, &id)?,
                    "schedules": schedule::list(store, &id)?,
                    "memories": bots::memories(store, &id)?,
                    "truncated": false,
                });
                Ok((reply, threads.into_iter().map(|t| t.session_id).collect::<Vec<_>>()))
            })
            .await?;
            let mut failovers = Vec::new();
            for session in sessions {
                if let Some(ask) = failover::bot_failover_pending(session).await? {
                    failovers.push(serde_json::to_value(ask).map_err(|e| e.to_string())?);
                }
            }
            reply["failovers"] = json!(failovers);
            Ok(fit_detail(limit_detail(reply, control)))
        })
    }
}

fn parse_detail(params: &Value) -> Result<Box<dyn Run>> {
    Ok(Box::new(Detail { bot_id: bot_id(params)? }))
}

// ---- bot.remember / bot.forget ----

#[derive(Debug)]
struct Remember {
    bot_id: String,
    content: String,
}

fn parse_remember(params: &Value) -> Result<Box<dyn Run>> {
    let content = params["content"].as_str().map(str::trim).unwrap_or_default();
    if content.is_empty() || content.chars().count() > MAX_MEMORY {
        return Err("Write a memory of up to 2000 characters.".into());
    }
    Ok(Box::new(Remember { bot_id: bot_id(params)?, content: content.to_owned() }))
}

impl Run for Remember {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            // What a bot remembers goes into every turn it runs: for a full bot, an instruction.
            let (bot, full_access) = (self.bot_id.clone(), ctx.full_access);
            with_store(&ctx, move |store| allow_bot_mode(store, &bot, full_access)).await?;
            let memory = bots::bot_remember(ctx.app.clone(), ctx.state(), self.bot_id, self.content).await?;
            Ok(json!({"memory": memory}))
        })
    }
}

#[derive(Debug)]
struct Forget {
    bot_id: String,
    memory_id: String,
}

fn parse_forget(params: &Value) -> Result<Box<dyn Run>> {
    Ok(Box::new(Forget { bot_id: bot_id(params)?, memory_id: id_param(params, "memoryId")? }))
}

impl Run for Forget {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            bots::bot_forget(ctx.app.clone(), ctx.state(), self.bot_id, self.memory_id).await?;
            Ok(json!({}))
        })
    }
}

// ---- bot.runSchedule ----

#[derive(Debug)]
struct RunSchedule {
    bot_id: String,
    schedule_id: String,
    /// A retry with the same id answers the first run (`once_per_action`).
    send_id: Option<String>,
}

fn parse_run_schedule(params: &Value) -> Result<Box<dyn Run>> {
    Ok(Box::new(RunSchedule { bot_id: bot_id(params)?, schedule_id: id_param(params, "scheduleId")?, send_id: super::send_id_param(params)? }))
}

impl Run for RunSchedule {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let (send_id, target) = (self.send_id.clone(), super::run_schedule_target(&self.bot_id, &self.schedule_id));
            super::once_per_action(ctx.from, "bot.runSchedule", &target, send_id.as_deref(), run_schedule(ctx, *self)).await
        })
    }
}

/// `bot.runSchedule` itself.
async fn run_schedule(ctx: Ctx<'_>, this: RunSchedule) -> Result<Value> {
    let (bot, id, full_access) = (this.bot_id, this.schedule_id.clone(), ctx.full_access);
    with_store(&ctx, move |store| {
        allow_bot_mode(store, &bot, full_access)?;
        super::super::host::allow_remote_bot_team(store, &bot, "schedule", full_access)?;
        let found = schedule::list(store, &bot)?.iter().any(|s| s.id == id);
        if found { Ok(()) } else { Err("This schedule no longer exists.".into()) }
    })
    .await?;
    schedule::bot_run_schedule_now(ctx.app.clone(), ctx.state(), this.schedule_id).await?;
    Ok(json!({}))
}

// ---- bot.pairingDecide ----

#[derive(Debug)]
struct Pairing {
    bot_id: String,
    channel_id: String,
    sender_id: String,
    decision: &'static str,
}

fn parse_pairing(params: &Value) -> Result<Box<dyn Run>> {
    let decision = match params["decision"].as_str() {
        Some("approved") => "approved",
        Some("blocked") => "blocked",
        Some("removed") => "removed",
        _ => return Err("Approve, block or remove the sender.".into()),
    };
    Ok(Box::new(Pairing { bot_id: bot_id(params)?, channel_id: id_param(params, "channelId")?, sender_id: sender_param(params)?, decision }))
}

impl Run for Pairing {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let (bot, channel, full_access, approving) = (self.bot_id, self.channel_id.clone(), ctx.full_access, self.decision == "approved");
            with_store(&ctx, move |store| {
                // Blocking or removing a sender only takes power away; approving one gives it a full bot.
                if approving {
                    allow_bot_mode(store, &bot, full_access)?;
                }
                let found = channels::list(store, &bot)?.iter().any(|c| c.id == channel);
                if found { Ok(()) } else { Err("This channel no longer exists.".into()) }
            })
            .await?;
            channels::bot_pairing_decide(ctx.app.clone(), ctx.state(), self.channel_id, self.sender_id, self.decision.into()).await?;
            Ok(json!({}))
        })
    }
}

// ---- bot.failoverDecide ----

#[derive(Debug)]
struct Failover {
    session_id: String,
    action: &'static str,
    always: bool,
}

fn parse_failover(params: &Value) -> Result<Box<dyn Run>> {
    let action = match params["action"].as_str() {
        Some("send") => "send",
        Some("wait") => "wait",
        _ => return Err("Choose Send or Wait.".into()),
    };
    let always = match params.get("always").filter(|v| !v.is_null()) {
        None => false,
        Some(_) => bool_param(params, "always")?,
    };
    Ok(Box::new(Failover { session_id: id_param(params, "sessionId")?, action, always }))
}

/// Whether a failover decision makes the bot run a turn: `send` retries it on the backup model
/// now, and a `wait` on a limit with a known reset resumes it then. Dismissing a hold runs nothing.
fn failover_runs_turn(action: &str, resumes_at_reset: bool) -> bool {
    action == "send" || resumes_at_reset
}

impl Run for Failover {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let ask = failover::bot_failover_pending(self.session_id.clone()).await?.ok_or("This message is no longer on hold.")?;
            if failover_runs_turn(self.action, ask.cause == failover::Cause::Limit && ask.resets_at.is_some()) {
                let full_access = ctx.full_access;
                let session = self.session_id.clone();
                with_store(&ctx, move |store| {
                    allow_bot_mode(store, &ask.bot_id, full_access)?;
                    super::super::host::allow_remote_team(store, &session, full_access)
                })
                .await?;
            }
            failover::bot_failover_decide(ctx.app.clone(), self.session_id, self.action.into(), self.always).await?;
            Ok(json!({}))
        })
    }
}

// ---- machines.list ----

/// The account's other computers, as candidates for a link request: no keys or fingerprints.
fn devices(app: &tauri::AppHandle) -> Vec<Value> {
    super::super::remote(app)
        .devices_view()
        .into_iter()
        .filter(|d| d["current"] != json!(true))
        .map(|d| json!({"id": d["id"], "name": d["name"], "platform": d["platform"], "online": d["online"]}))
        .collect()
}

#[derive(Debug)]
struct Machines;

impl Run for Machines {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let vms = crate::vm::commands::vm_status(ctx.app.clone()).await?;
            let vms = json!({"supported": vms.supported, "installed": vms.installed, "vms": vms.vms});
            let orchestration = crate::remote::orchestrate::links::orchestration_status(ctx.app.clone()).await;
            let pending = crate::remote::orchestrate::links::orchestration_pending().await;
            Ok(json!({"vms": vms, "orchestration": orchestration, "pending": pending, "devices": devices(ctx.app)}))
        })
    }
}

// ---- cloud.machines ----

#[derive(Debug)]
struct CloudMachines;

impl Run for CloudMachines {
    fn run<'a>(self: Box<Self>, _ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let found = crate::cloud::commands::cloud_machines().await?;
            let home = crate::agent_usage_providers::home();
            let errors: Vec<String> = found.errors.iter().map(|e| cloud_error(e, home.as_deref())).collect();
            Ok(json!({"machines": found.machines, "errors": errors}))
        })
    }
}

/// A provider's error as a View device sees it (Round 23): the home folder written as `~`, as
/// `projects.cloneStatus` does, then cut to [`MAX_ERROR`] bytes.
fn cloud_error(error: &str, home: Option<&std::path::Path>) -> String {
    super::bounded_text(&super::projects::home_as_tilde(error, home), MAX_ERROR)
}

// ---- cloudAgents.list ----

/// One cloud agent task: its thread and the desktop's `cloud` view (provider, machine, stage).
fn agent_row(id: String, title: String, status: String, updated_at: i64, cloud: &str) -> Option<Value> {
    let cloud = crate::cloud_agents::view(cloud)?;
    Some(json!({"sessionId": id, "title": title, "status": status, "updatedAt": updated_at, "cloud": cloud}))
}

#[derive(Debug)]
struct CloudAgents;

impl Run for CloudAgents {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let agents = with_store(&ctx, |store| {
                let mut statement = store
                    .db
                    .prepare("SELECT id,title,status,updated_at,cloud FROM sessions WHERE cloud IS NOT NULL AND archived=0 AND draft=0 AND remote_device IS NULL ORDER BY updated_at DESC LIMIT ?1")
                    .map_err(|e| e.to_string())?;
                let rows = statement
                    .query_map([MAX_AGENTS], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, i64>(3)?, r.get::<_, String>(4)?)))
                    .map_err(|e| e.to_string())?;
                let rows = rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())?;
                Ok(rows.into_iter().filter_map(|(id, title, status, at, cloud)| agent_row(id, title, status, at, &cloud)).collect::<Vec<_>>())
            })
            .await?;
            Ok(json!({"agents": agents}))
        })
    }
}

// ---- cloudAgents.targets / cloudAgents.start ----

/// What [`cloudAgents.start`] refuses without the host's Full access switch.
const START_CLOUD_AGENTS: &str = "start cloud agents";

/// Providers that run agents (`{provider, label, ready}`: no keys or account details) and the
/// harnesses a cloud machine can run.
fn targets_reply(providers: Vec<Value>) -> Value {
    json!({"providers": providers, "harnesses": crate::cloud_agents::setup::HARNESSES})
}

#[derive(Debug)]
struct CloudTargets;

impl Run for CloudTargets {
    fn run<'a>(self: Box<Self>, _ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move { Ok(targets_reply(crate::cloud_agents::tasks::cloud_agent_targets().await?)) })
    }
}

#[derive(Debug)]
struct CloudStart {
    start_id: String,
    project_id: String,
    provider: String,
    prompt: String,
    harness: String,
    model: String,
    mode: Option<String>,
    effort: Option<String>,
}

fn parse_cloud_start(params: &Value) -> Result<Box<dyn Run>> {
    let start_id = name_param(params, "startId")?.ok_or("Missing startId.")?;
    valid_id(&start_id).map_err(|_| "Invalid startId.")?;
    let harness = name_param(params, "harness")?.ok_or("Missing harness.")?;
    if !crate::cloud_agents::setup::HARNESSES.contains(&harness.as_str()) {
        return Err(crate::cloud_agents::tasks::harness_refusal(&harness));
    }
    Ok(Box::new(CloudStart {
        start_id,
        project_id: id_param(params, "projectId")?,
        provider: name_param(params, "provider")?.ok_or("Missing provider.")?,
        prompt: text_param(params, "prompt")?,
        harness,
        model: name_param(params, "model")?.ok_or("Missing model.")?,
        mode: name_param(params, "mode")?,
        effort: name_param(params, "effort")?,
    }))
}

impl Run for CloudStart {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            super::terminal::require_full_access_to(ctx.full_access, START_CLOUD_AGENTS)?;
            let mut start = *self;
            start.mode = super::team::capped_mode(start.mode.take(), ctx.full_access)?;
            let (app, from, id) = (ctx.app.clone(), ctx.from.to_owned(), start.start_id.clone());
            super::super::host::start_keyed(ctx.from, &id, move |cancel| async move { start_cloud_agent(&app, &from, start, &cancel).await }).await
        })
    }
}

/// Makes the cloud task (the desktop's own command) and follows it for the caller.
async fn start_cloud_agent(app: &tauri::AppHandle, from: &str, start: CloudStart, cancel: &super::super::start::Cancel) -> Result<Value> {
    {
        let state = app.state::<crate::AppState>();
        let store = state.store.lock().map_err(|e| e.to_string())?;
        if crate::bots::project_ids(&store)?.contains(&start.project_id) {
            return Err("Bot workspaces cannot be used for remote tasks.".into());
        }
    }
    cancel.commit()?;
    let CloudStart { project_id, provider, prompt, harness, model, mode, effort, .. } = start;
    let task = crate::cloud_agents::tasks::cloud_agent_start(app.clone(), None, project_id, provider, prompt, harness, model, mode, effort).await?;
    super::super::host::follow(app, from, &task.id);
    Ok(json!({"sessionId": task.id, "projectId": task.project_id}))
}

// ---- vm.start / vm.stop ----

/// A Tart VM name, checked like the desktop's: nothing that could read as an option.
fn vm_name(params: &Value) -> Result<String> {
    let name = params["name"].as_str().ok_or("Missing name.")?;
    if name.is_empty() || name.len() > 128 || name.starts_with('-') || name.chars().any(char::is_control) {
        return Err("Unknown VM.".into());
    }
    Ok(name.to_owned())
}

#[derive(Debug)]
struct Power {
    name: String,
    action: &'static str,
    /// A retry with the same id answers the first start or stop (`once_per_action`).
    send_id: Option<String>,
}

fn parse_power(params: &Value, action: &'static str) -> Result<Box<dyn Run>> {
    Ok(Box::new(Power { name: vm_name(params)?, action, send_id: super::send_id_param(params)? }))
}

impl Run for Power {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let Power { name, action, send_id } = *self;
            let method = if action == "start" { "vm.start" } else { "vm.stop" };
            super::once_per_action(ctx.from, method, &name.clone(), send_id.as_deref(), async move {
                let status = crate::vm::commands::vm_power(ctx.app.clone(), name, action.into(), None).await?;
                Ok(json!({"vms": {"supported": status.supported, "installed": status.installed, "vms": status.vms}}))
            })
            .await
        })
    }
}

// ---- vm.frame ----

/// The latest frame per VM, so later pages of one screenshot match its first.
static FRAMES: Mutex<Vec<(String, String, String)>> = Mutex::new(Vec::new());
const KEPT_FRAMES: usize = 4;

/// One page of `data`: `{frameId, mime, total, offset, data, done}`.
fn frame_page(frame_id: &str, data: &str, offset: usize) -> Result<Value> {
    if offset > data.len() || !offset.is_multiple_of(4) {
        return Err("Invalid offset.".into());
    }
    let end = (offset + FRAME_CHUNK).min(data.len());
    Ok(json!({"frameId": frame_id, "mime": "image/jpeg", "total": data.len(), "offset": offset, "data": &data[offset..end], "done": end == data.len()}))
}

#[derive(Debug)]
struct Frame {
    name: String,
    offset: usize,
    frame_id: Option<String>,
}

fn parse_frame(params: &Value) -> Result<Box<dyn Run>> {
    let offset = match params.get("offset").filter(|v| !v.is_null()) {
        None => 0,
        Some(value) => value.as_u64().ok_or("Invalid offset.")? as usize,
    };
    let frame_id = match params.get("frameId").filter(|v| !v.is_null()) {
        None => None,
        Some(_) => Some(id_param(params, "frameId")?),
    };
    if offset > 0 && frame_id.is_none() {
        return Err("Missing frameId.".into());
    }
    Ok(Box::new(Frame { name: vm_name(params)?, offset, frame_id }))
}

impl Run for Frame {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            if let Some(id) = self.frame_id.filter(|_| self.offset > 0) {
                let frames = FRAMES.lock().map_err(|e| e.to_string())?;
                let (_, _, data) = frames.iter().find(|(name, frame, _)| *name == self.name && *frame == id).ok_or("The screen changed. Load it again.")?;
                return frame_page(&id, data, self.offset);
            }
            let (app, name) = (ctx.app.clone(), self.name.clone());
            let jpeg = crate::blocking(move || app.state::<crate::vm::Vms>().with_screen(&name, false, |rfb| crate::vm::screen::screenshot(rfb, 70)).map(|shot| shot.jpeg)).await?;
            let data = STANDARD.encode(jpeg);
            let id = crate::storage::id();
            let page = frame_page(&id, &data, 0)?;
            let mut frames = FRAMES.lock().map_err(|e| e.to_string())?;
            frames.retain(|(name, _, _)| *name != self.name);
            frames.push((self.name, id, data));
            if frames.len() > KEPT_FRAMES {
                frames.remove(0);
            }
            Ok(page)
        })
    }
}

// ---- orchestration.respond ----

#[derive(Debug)]
struct Respond {
    request_id: String,
    /// Accept: the computer to link and its access (`read`, `ask` or `full`). None declines.
    link: Option<(String, String)>,
}

fn parse_respond(params: &Value) -> Result<Box<dyn Run>> {
    let request_id = id_param(params, "requestId")?;
    let link = if bool_param(params, "accept")? {
        let access = params["access"].as_str().filter(|a| matches!(*a, "read" | "ask" | "full")).ok_or("Choose read, ask or full access.")?;
        Some((id_param(params, "deviceId")?, access.to_owned()))
    } else {
        None
    };
    Ok(Box::new(Respond { request_id, link }))
}

/// Why a phone may not give another computer `full` access over this one.
const LINK_NEEDS_FULL_ACCESS: &str = "Turn on Full access for remote tasks on this computer to link another computer with full access.";

/// A link with `full` access lets the other computer run tasks here without approval, which
/// a phone may only grant while the host lets remote tasks run with Full access.
fn allow_link_access(access: Option<&str>, full_access: bool) -> Result<()> {
    if access == Some("full") && !full_access {
        return Err(LINK_NEEDS_FULL_ACCESS.into());
    }
    Ok(())
}

impl Run for Respond {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            allow_link_access(self.link.as_ref().map(|(_, access)| access.as_str()), ctx.full_access)?;
            if self.link.is_some() && !ctx.full_access {
                let (store, id) = (ctx.state().store.clone(), self.request_id.clone());
                crate::blocking(move || crate::remote::orchestrate::links::allow_remote_accept(&*store.lock().map_err(|e| e.to_string())?, &id, false)).await?;
            }
            let (device, access) = self.link.map_or((None, None), |(device, access)| (Some(device), Some(access)));
            let status = crate::remote::orchestrate::links::orchestration_link_respond(ctx.app.clone(), self.request_id, device, access).await?;
            Ok(json!({"orchestration": status}))
        })
    }
}

// ---- routing.status ----

#[derive(Debug)]
struct Routing;

impl Run for Routing {
    fn run<'a>(self: Box<Self>, _ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let status = crate::blocking(crate::model_routing::model_routing_status).await?;
            Ok(routing_status_reply(status))
        })
    }
}

/// What a phone learns about routing (a View device may ask): `error` can name folders on the
/// computer, so a failure is a fixed sentence and a `failed` flag, as in `settings.routing`.
const ROUTING_FAILED: &str = "Preparing the router failed. Open PandaCode on the computer for details.";

fn routing_status_reply(status: crate::model_routing::RoutingStatus) -> Value {
    let failed = status.error.is_some();
    json!({"routing": {
        "enabled": status.enabled, "mode": status.mode, "minP": status.min_p, "profiler": status.profiler,
        "error": failed.then_some(ROUTING_FAILED), "failed": failed,
    }})
}

// ---- deploy.targets ----

/// The desktop's Deploy menu targets, in its order (`TARGETS` in src/deploy.ts).
pub(crate) const DEPLOY_TARGETS: [&str; 6] = ["vercel", "cloudflare", "railway", "netlify", "aws", "gcloud"];
/// What the desktop's Deploy menu says beside a target that is not connected.
const DEPLOY_NOT_CONNECTED: &str = "Connect it in Settings → Agents → Cloud sandboxes";

#[derive(Debug)]
struct DeployTargets;

/// The desktop's `deployItems()`: a target is connected when `cloud_connections` lists its
/// provider as connected. Only booleans and a fixed note: no token, account or project detail.
fn deploy_targets(connections: &[(String, bool)]) -> Value {
    let targets: Vec<Value> = DEPLOY_TARGETS
        .iter()
        .map(|id| {
            let connected = connections.iter().any(|(provider, on)| provider == id && *on);
            if connected { json!({"id": id, "connected": true}) } else { json!({"id": id, "connected": false, "note": DEPLOY_NOT_CONNECTED}) }
        })
        .collect();
    json!({"targets": targets})
}

impl Run for DeployTargets {
    fn run<'a>(self: Box<Self>, _ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let connections = crate::cloud::commands::cloud_connections().await?;
            let pairs: Vec<(String, bool)> = connections.into_iter().map(|c| (c.provider.to_owned(), c.connected)).collect();
            Ok(deploy_targets(&pairs))
        })
    }
}

pub(crate) const METHODS: &[Method] = &[
    Method { name: "deploy.targets", access: Access::View, read_only: true, parse: |_| Ok(Box::new(DeployTargets)) },
    Method { name: "bot.detail", access: Access::View, read_only: true, parse: parse_detail },
    Method { name: "bot.remember", access: Access::Full, read_only: false, parse: parse_remember },
    Method { name: "bot.forget", access: Access::Full, read_only: false, parse: parse_forget },
    Method { name: "bot.runSchedule", access: Access::Full, read_only: false, parse: parse_run_schedule },
    Method { name: "bot.pairingDecide", access: Access::Full, read_only: false, parse: parse_pairing },
    Method { name: "bot.failoverDecide", access: Access::Full, read_only: false, parse: parse_failover },
    Method { name: "machines.list", access: Access::View, read_only: true, parse: |_| Ok(Box::new(Machines)) },
    Method { name: "cloud.machines", access: Access::View, read_only: true, parse: |_| Ok(Box::new(CloudMachines)) },
    Method { name: "cloudAgents.list", access: Access::View, read_only: true, parse: |_| Ok(Box::new(CloudAgents)) },
    Method { name: "cloudAgents.targets", access: Access::View, read_only: true, parse: |_| Ok(Box::new(CloudTargets)) },
    Method { name: "cloudAgents.start", access: Access::Full, read_only: false, parse: parse_cloud_start },
    // A live picture of a VM's screen shows whatever runs there: Control.
    Method { name: "vm.frame", access: Access::Control, read_only: true, parse: parse_frame },
    Method { name: "vm.start", access: Access::Full, read_only: false, parse: |p| parse_power(p, "start") },
    Method { name: "vm.stop", access: Access::Full, read_only: false, parse: |p| parse_power(p, "stop") },
    Method { name: "orchestration.respond", access: Access::Full, read_only: false, parse: parse_respond },
    Method { name: "routing.status", access: Access::View, read_only: true, parse: |_| Ok(Box::new(Routing)) },
];

#[cfg(test)]
mod tests {
    /// Round 23: `cloud.machines` errors never carry the home folder's path.
    #[test]
    fn cloud_machine_errors_write_home_as_tilde() {
        let home = std::path::Path::new("/Users/someone");
        let error = super::cloud_error("Could not read /Users/someone/.config/hcloud/cli.toml", Some(home));
        assert_eq!(error, "Could not read ~/.config/hcloud/cli.toml");
        assert!(!super::cloud_error(&format!("/Users/someone/{}", "x".repeat(400)), Some(home)).contains("/Users/someone"));
        assert!(super::cloud_error(&"é".repeat(400), None).len() <= super::MAX_ERROR + "[Truncated]".len());
        let source = include_str!("admin.rs");
        let run = &source[source.find("impl Run for CloudMachines").unwrap()..];
        assert!(run[..run.find("\n}\n").unwrap()].contains("cloud_error(e, home.as_deref())"));
    }

    use super::*;

    fn parse(name: &str, params: Value) -> Result<Box<dyn Run>> {
        (METHODS.iter().find(|m| m.name == name).unwrap().parse)(&params)
    }

    /// Round 8: `deploy.targets` lists the desktop's Deploy menu targets, connected as
    /// `deployItems()` decides, with nothing but booleans and a fixed note.
    #[test]
    fn deploy_targets_match_the_desktop_menu_and_carry_no_secrets() {
        let desktop = include_str!("../../../../src/deploy.ts");
        let table = &desktop[desktop.find("export const TARGETS").unwrap()..];
        let table = &table[..table.find("];").unwrap()];
        let ids: Vec<&str> = table.match_indices("{ id: '").map(|(at, _)| { let rest = &table[at + 7..]; &rest[..rest.find('\'').unwrap()] }).collect();
        assert_eq!(ids, DEPLOY_TARGETS, "same ids and order as src/deploy.ts");
        let reply = deploy_targets(&[("vercel".into(), true), ("netlify".into(), false), ("daytona".into(), true)]);
        let targets = reply["targets"].as_array().unwrap();
        assert_eq!(targets.len(), DEPLOY_TARGETS.len());
        assert_eq!(targets[0], json!({"id": "vercel", "connected": true}));
        assert_eq!(targets[3], json!({"id": "netlify", "connected": false, "note": DEPLOY_NOT_CONNECTED}));
        for target in targets {
            let keys: Vec<&String> = target.as_object().unwrap().keys().collect();
            assert!(keys.iter().all(|key| ["id", "connected", "note"].contains(&key.as_str())), "{target}");
        }
        let method = METHODS.iter().find(|m| m.name == "deploy.targets").unwrap();
        assert_eq!(method.access, Access::View);
        assert!(method.read_only);
    }

    #[test]
    fn routing_status_never_sends_the_error_text() {
        let status = crate::model_routing::RoutingStatus {
            enabled: true, mode: crate::panda_router::Mode::Balanced, min_p: 0.5, profiler: "failed",
            error: Some("Could not create /Users/someone/Library/router: denied".into()),
        };
        let reply = routing_status_reply(status.clone());
        assert!(!reply.to_string().contains("/Users/"), "{reply}");
        assert_eq!(reply["routing"]["failed"], true);
        assert_eq!(reply["routing"]["error"], ROUTING_FAILED);
        assert_eq!(reply["routing"]["minP"], 0.5);
        let ok = routing_status_reply(crate::model_routing::RoutingStatus { error: None, ..status });
        assert_eq!((ok["routing"]["failed"].clone(), ok["routing"]["error"].clone()), (json!(false), Value::Null));
    }

    #[test]
    fn linking_with_full_access_needs_full_access_for_remote_tasks() {
        assert_eq!(allow_link_access(Some("full"), false).unwrap_err(), LINK_NEEDS_FULL_ACCESS);
        assert!(allow_link_access(Some("full"), true).is_ok());
        for access in [Some("read"), Some("ask"), None] {
            assert!(allow_link_access(access, false).is_ok(), "{access:?}");
        }
    }

    #[test]
    fn scopes_follow_what_each_method_changes() {
        for method in METHODS {
            assert_eq!(method.read_only, method.access == Access::View || method.name == "vm.frame", "{}", method.name);
        }
        assert_eq!(METHODS.iter().find(|m| m.name == "vm.frame").unwrap().access, Access::Control);
        for name in ["bot.remember", "bot.forget", "bot.runSchedule", "bot.pairingDecide", "bot.failoverDecide", "vm.start", "vm.stop", "orchestration.respond", "cloudAgents.start"] {
            assert_eq!(METHODS.iter().find(|m| m.name == name).unwrap().access, Access::Full, "{name}");
        }
        assert_eq!(METHODS.iter().find(|m| m.name == PAIRING_PROBE).unwrap().access, Access::Full);
    }

    #[test]
    fn what_makes_a_full_bot_act_needs_full_access_for_remote_tasks() {
        assert!(failover_runs_turn("send", false) && failover_runs_turn("send", true));
        assert!(failover_runs_turn("wait", true), "a wait that resumes at the reset runs the turn then");
        assert!(!failover_runs_turn("wait", false), "dismissing a hold runs nothing");
        let source = include_str!("admin.rs");
        for method in ["impl Run for Remember", "impl Run for Failover", "async fn run_schedule("] {
            let body = &source[source.find(method).unwrap_or_else(|| panic!("{method}"))..];
            let body = &body[..body.find("\n}\n").unwrap()];
            assert!(body.contains("allow_bot_mode(store, &"), "{method}");
        }
    }

    #[test]
    fn pairings_below_full_hide_codes_and_most_of_the_sender() {
        assert_eq!(mask_sender("+15551234567"), "•••4567");
        assert_eq!(mask_sender("abc"), "•••");
        assert_eq!(mask_sender("ünï1234"), "•••1234");
        let pairing = channels::Pairing { channel_id: "c1".into(), sender_id: "U0123456789".into(), sender_name: "Ann".into(), status: "pending".into(), code: "XYZ123".into(), created_at: 5 };
        let rows = redact_pairings(&[pairing]);
        let text = rows[0].to_string();
        assert!(!text.contains("XYZ123") && !text.contains("U0123456789"), "{text}");
        assert_eq!(rows[0]["senderId"], "•••6789");
        assert_eq!(rows[0]["senderName"], "Ann");
        assert!(rows[0].get("code").is_none());
    }

    #[test]
    fn bot_params_are_checked() {
        assert!(parse("bot.detail", json!({})).is_err());
        assert!(parse("bot.detail", json!({"botId": "a b"})).is_err());
        assert!(parse("bot.detail", json!({"botId": "b1"})).is_ok());
        assert!(parse("bot.remember", json!({"botId": "b1", "content": "  "})).is_err());
        assert!(parse("bot.remember", json!({"botId": "b1", "content": "x".repeat(MAX_MEMORY + 1)})).is_err());
        assert!(parse("bot.remember", json!({"botId": "b1", "content": "Prefers pnpm"})).is_ok());
        assert!(parse("bot.forget", json!({"botId": "b1"})).is_err());
        assert!(parse("bot.forget", json!({"botId": "b1", "memoryId": "m1"})).is_ok());
        assert!(parse("bot.runSchedule", json!({"scheduleId": "s1"})).is_err(), "needs the bot");
        assert!(parse("bot.runSchedule", json!({"botId": "b1", "scheduleId": "s1"})).is_ok());
    }

    #[test]
    fn decisions_take_only_the_desktops_answers() {
        let pairing = |decision: &str, sender: &str| parse("bot.pairingDecide", json!({"botId": "b1", "channelId": "c1", "senderId": sender, "decision": decision}));
        assert!(pairing("approved", "+15551234").is_ok());
        assert!(pairing("blocked", "U123").is_ok());
        assert!(pairing("removed", "U123").is_ok());
        assert!(pairing("maybe", "U123").is_err());
        assert!(pairing("approved", "").is_err());
        assert!(pairing("approved", "a\nb").is_err());
        assert!(pairing("approved", &"x".repeat(MAX_SENDER + 1)).is_err());
        assert!(parse("bot.failoverDecide", json!({"sessionId": "s1", "action": "send"})).is_ok());
        assert!(parse("bot.failoverDecide", json!({"sessionId": "s1", "action": "wait", "always": true})).is_ok());
        assert!(parse("bot.failoverDecide", json!({"sessionId": "s1", "action": "wait", "always": "yes"})).is_err());
        assert!(parse("bot.failoverDecide", json!({"sessionId": "s1", "action": "retry"})).is_err());
    }

    #[test]
    fn machine_params_are_checked() {
        assert!(parse("vm.start", json!({"name": "-rm"})).is_err());
        assert!(parse("vm.stop", json!({"name": ""})).is_err());
        assert!(parse("vm.start", json!({"name": "ubuntu dev"})).is_ok());
        assert!(parse("vm.frame", json!({"name": "dev"})).is_ok());
        assert!(parse("vm.frame", json!({"name": "dev", "offset": 4})).is_err(), "a later page names its frame");
        assert!(parse("vm.frame", json!({"name": "dev", "offset": 4, "frameId": "f1"})).is_ok());
        assert!(parse("vm.frame", json!({"name": "dev", "offset": -4, "frameId": "f1"})).is_err());
        assert!(parse("orchestration.respond", json!({"requestId": "r1", "accept": false})).is_ok());
        assert!(parse("orchestration.respond", json!({"requestId": "r1", "accept": true, "deviceId": "d1"})).is_err());
        assert!(parse("orchestration.respond", json!({"requestId": "r1", "accept": true, "deviceId": "d1", "access": "root"})).is_err());
        assert!(parse("orchestration.respond", json!({"requestId": "r1", "accept": true, "deviceId": "d1", "access": "ask"})).is_ok());
        assert!(parse("orchestration.respond", json!({"requestId": "r1"})).is_err());
    }

    #[test]
    fn cloud_agent_starts_are_checked() {
        let ok = json!({"startId": "s1", "projectId": "p1", "provider": "e2b", "prompt": "Fix it", "harness": "claude", "model": "default", "mode": "ask"});
        assert!(parse("cloudAgents.start", ok.clone()).is_ok());
        for (key, bad) in [("startId", json!(null)), ("startId", json!("has space")), ("projectId", json!(null)), ("provider", json!(null)), ("prompt", json!("  ")), ("model", json!(null)), ("mode", json!("a b"))] {
            let mut params = ok.clone();
            params[key] = bad;
            assert!(parse("cloudAgents.start", params).is_err(), "{key}");
        }
        let mut params = ok;
        params["harness"] = json!("kimi");
        assert_eq!(parse("cloudAgents.start", params).unwrap_err(), crate::cloud_agents::tasks::harness_refusal("kimi"));
    }

    #[test]
    fn full_mode_bots_need_the_switch_to_run_or_admit_senders() {
        let source = include_str!("admin.rs");
        for (start, action) in [("impl Run for RunSchedule", "bot_run_schedule_now"), ("impl Run for Pairing", "bot_pairing_decide")] {
            let body = &source[source.find(start).unwrap()..];
            let gate = body.find("allow_bot_mode(store, &bot, full_access)").expect(start);
            assert!(gate < body.find(action).unwrap(), "{start} checks the bot's mode first");
        }
        let host = include_str!("../host.rs");
        let body = &host[host.find("Call::BotMessage { bot_id, text, send_id } =>").unwrap()..];
        assert!(body.find("allow_bot_mode").unwrap() < body.find("bot_message(").unwrap(), "bot.message checks it too");
        assert!(allow_task_mode("full", None, false).unwrap_err().starts_with("Full access is off for remote tasks on "));
        assert!(allow_task_mode("full", None, true).is_ok() && allow_task_mode("ask", None, false).is_ok());
    }

    #[test]
    fn cloud_agent_starts_need_the_switch_and_targets_carry_no_credentials() {
        let source = include_str!("admin.rs");
        let body = &source[source.find("impl Run for CloudStart").unwrap()..];
        let gate = body.find("require_full_access_to(ctx.full_access, START_CLOUD_AGENTS)").expect("cloudAgents.start checks the switch");
        assert!(gate < body.find("start_keyed").unwrap() && gate < body.find("capped_mode").unwrap());
        assert_eq!(super::super::terminal::require_full_access_to(false, START_CLOUD_AGENTS).unwrap_err(), "Turn on Full access for remote tasks on this computer to start cloud agents.");
        let reply = targets_reply(vec![json!({"provider": "e2b", "label": "E2B", "ready": true})]);
        let mut keys: Vec<&String> = reply["providers"][0].as_object().unwrap().keys().collect();
        keys.sort();
        assert_eq!(keys, ["label", "provider", "ready"]);
        assert!(reply["harnesses"].as_array().unwrap().contains(&json!("claude")));
    }

    #[test]
    fn frame_pages_split_on_base64_quads() {
        let data = "A".repeat(FRAME_CHUNK + 8);
        let first = frame_page("f", &data, 0).unwrap();
        assert_eq!(first["done"], false);
        assert_eq!(first["data"].as_str().unwrap().len(), FRAME_CHUNK);
        let last = frame_page("f", &data, FRAME_CHUNK).unwrap();
        assert_eq!(last["done"], true);
        assert_eq!(last["frameId"], "f");
        assert!(frame_page("f", &data, 3).is_err());
        assert!(frame_page("f", &data, data.len() + 4).is_err());
    }

    fn channel(config: Value) -> channels::Channel {
        channels::Channel { id: "c1".into(), bot_id: "b1".into(), kind: "web".into(), label: "Web".into(), config, enabled: true, status: "connected".into(), secrets: vec!["token".into()] }
    }

    #[test]
    fn channels_never_carry_secrets_or_config() {
        let view = channel_view(&channel(json!({"identity": {"name": "Helper"}, "publicUrl": "https://x.ts.net", "token": "s3cret"})));
        let text = view.to_string();
        assert_eq!(view["identity"], "Helper");
        for leaked in ["s3cret", "publicUrl", "secrets", "config", "x.ts.net"] {
            assert!(!text.contains(leaked), "{leaked} leaked: {text}");
        }
        assert_eq!(channel_view(&channel(json!(null)))["identity"], "");
    }

    #[test]
    fn view_devices_get_counts_not_memories_prompts_or_rules() {
        assert_eq!(METHODS.iter().find(|m| m.name == CONTROL_PROBE).unwrap().access, Access::Control);
        let reply = json!({"memories": [{"content": "secret plan"}, {"content": "x"}], "schedules": [{"prompt": "email the boss"}], "rules": [{"pattern": "deny"}], "truncated": false});
        let view = limit_detail(reply.clone(), false);
        assert_eq!((view["memoryCount"].clone(), view["scheduleCount"].clone(), view["ruleCount"].clone()), (json!(2), json!(1), json!(1)));
        assert_eq!(view["limited"], json!(true));
        let text = view.to_string();
        for private in ["secret plan", "email the boss", "deny"] {
            assert!(!text.contains(private), "{private}");
        }
        assert_eq!(limit_detail(reply.clone(), true), reply, "Control sees everything");
    }

    #[test]
    fn details_fit_a_page() {
        let memories: Vec<Value> = (0..500).map(|i| json!({"id": i, "content": "m".repeat(1000)})).collect();
        let reply = fit_detail(json!({"bot": {"avatar": format!("data:image/png;base64,{}", "A".repeat(50_000))}, "memories": memories, "pairings": [], "truncated": false}));
        assert!(reply.to_string().len() <= PAGE_BUDGET);
        assert_eq!(reply["truncated"], true);
        assert_eq!(reply["bot"]["avatar"], "");
        let small = fit_detail(json!({"bot": {"avatar": "data:image/png;base64,AAAA"}, "memories": [], "truncated": false}));
        assert_eq!(small["truncated"], false);
        assert_eq!(small["bot"]["avatar"], "data:image/png;base64,AAAA");
    }
}
