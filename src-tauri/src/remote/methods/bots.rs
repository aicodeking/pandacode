//! Bot management from a phone (docs/remote-access.md): the settings a paired device could not
//! reach before. A bot's *conversation* was already remote (`bot.thread`, `bot.message`,
//! `bot.pause` in `host.rs`, and `bot.detail`/`bot.remember`/`bot.runSchedule`/... in `admin.rs`),
//! so a phone could talk to a bot forever but never create one, retune it, schedule it, change its
//! Guard rules, read its audit trail, or clean it up.
//!
//! Every managing command in `crate::bots` is behind `guard_main(window)` ("Bots are managed from
//! the main window"), which is why this group exists as its own file rather than more `admin.rs`:
//! it is a distinct capability, and every write here is gated twice — `Access::Full` and the host's
//! "Full access for remote tasks" switch (`ctx.full_access`). A bot accepts untrusted input from
//! Telegram, Slack, Discord and WhatsApp and then acts on the user's machine, so its settings are a
//! bigger lever than an ordinary task's.
//!
//! Deliberate limits:
//! - `bot.edit` never accepts `instructions`, `goals` or `soul`. Those are the brief that defines who
//!   the bot is; a phone may retune its model, cadence and behaviour, but must not blind-overwrite it.
//! - Raising a bot's mode to `full` is refused without the switch: that is the setting that removes
//!   the approval barrier on untrusted outside messages.
//! - The library functions (`bots::update`, `bots::reset`, ...) do not emit events — only the Tauri
//!   commands do — so each write here emits `bots-changed` itself, or the desktop's sidebar and the
//!   other phones go stale.
use super::{bounded_text, full_access_off, id_param, name_param, text_param, Access, Ctx, Method, Reply, Run, PAGE_BUDGET};
use crate::bots::{self, channels, guard, schedule, BotInput};
use crate::Result;
use serde_json::{json, Value};
use tauri::Emitter;

/// Activity rows one `bot.activity` reply carries at most; the reader pages older ones with `before`.
const ACTIVITY_MAX: i64 = 200;
const ACTIVITY_DEFAULT: i64 = 50;
/// Characters one activity summary keeps (they are already short, but a channel can be chatty).
const MAX_SUMMARY: usize = 500;
/// JSON bytes one activity row's `detail` keeps. It carries arbitrary logged payloads (channel text,
/// tool args), so an unbounded one could fill a whole page with a single row.
const MAX_DETAIL: usize = 2 * 1024;

/// Takes the store lock on the blocking pool, as the rest of the registry does.
async fn with_store<T: Send + 'static>(ctx: &Ctx<'_>, work: impl FnOnce(&crate::storage::Store) -> Result<T> + Send + 'static) -> Result<T> {
    let store = ctx.state().store.clone();
    crate::blocking(move || work(&*store.lock().map_err(|e| e.to_string())?)).await
}

/// The bot as a phone shows it for a write's reply: the same shape `bot.detail`'s `bot` field uses,
/// so a client decodes one type (admin.rs `bot_view`; kept in step deliberately).
fn bot_view(bot: &bots::Bot) -> Value {
    json!({
        "id": bot.id, "name": bot.name, "role": bot.role, "avatar": bot.avatar, "color": bot.color,
        "provider": bot.provider, "model": bot.model, "mode": bot.mode, "paused": bot.paused,
        "heartbeatMinutes": bot.heartbeat_minutes, "nextHeartbeatAt": bot.next_heartbeat_at, "projectId": bot.project_id,
    })
}

/// The gate every write here passes before it touches anything. A bot acts on the user's machine and
/// takes untrusted input from outside, so a Full grant alone is not enough: the host's
/// "Full access for remote tasks" switch must be on too.
fn allow_write(full_access: bool) -> Result<()> {
    if !full_access {
        return Err(full_access_off());
    }
    Ok(())
}

fn bot_id(params: &Value) -> Result<String> {
    id_param(params, "botId")
}

fn bool_param(params: &Value, key: &str) -> Result<bool> {
    params[key].as_bool().ok_or_else(|| format!("Invalid {key}."))
}

fn changed(app: &tauri::AppHandle) {
    let _ = app.emit("bots-changed", ());
}

// ---- bot.activity ----

#[derive(Debug)]
struct Activity {
    bot_id: String,
    before: Option<i64>,
    limit: i64,
}

/// A row's detail, cut to [`MAX_DETAIL`] JSON bytes. A string keeps its head; anything else that is
/// still too big becomes a marker rather than a half-serialized value.
fn bounded_detail(detail: Value) -> Value {
    if detail.to_string().len() <= MAX_DETAIL {
        return detail;
    }
    match detail {
        Value::String(text) => json!(bounded_text(&text, MAX_DETAIL)),
        other => json!({"omitted": true, "bytes": other.to_string().len()}),
    }
}

/// The audit trail, newest first, fitted to one page. The rows carry what the bot did and why,
/// which is exactly what a user away from their computer wants to check.
fn activity_reply(rows: Vec<bots::Activity>) -> Value {
    let mut activity: Vec<Value> = rows
        .into_iter()
        .map(|row| json!({
            "id": row.id,
            "kind": bounded_text(&row.kind, 80),
            "summary": bounded_text(&row.summary, MAX_SUMMARY),
            "detail": bounded_detail(row.detail),
            "at": row.at,
        }))
        .collect();
    // Keep the NEWEST rows when the page has to be cut: this list is newest-first.
    let before = activity.len();
    super::super::host::fit_list(&mut activity, PAGE_BUDGET);
    let truncated = activity.len() < before;
    json!({"activity": activity, "truncated": truncated})
}

impl Run for Activity {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let Activity { bot_id, before, limit } = *self;
            let rows = with_store(&ctx, move |store| {
                // A stale id should say so, not return an empty page that reads as "nothing happened".
                bots::get(store, &bot_id)?;
                bots::activity(store, &bot_id, before, limit)
            })
            .await?;
            Ok(activity_reply(rows))
        })
    }
}

fn parse_activity(params: &Value) -> Result<Box<dyn Run>> {
    let before = match params.get("before").filter(|value| !value.is_null()) {
        None => None,
        Some(value) => Some(value.as_i64().filter(|id| *id > 0).ok_or("Invalid before.")?),
    };
    let limit = match params.get("limit").filter(|value| !value.is_null()) {
        None => ACTIVITY_DEFAULT,
        Some(value) => value.as_i64().filter(|n| *n > 0).ok_or("Invalid limit.")?.clamp(1, ACTIVITY_MAX),
    };
    Ok(Box::new(Activity { bot_id: bot_id(params)?, before, limit }))
}

// ---- bot.edit ----

#[derive(Debug)]
struct Edit {
    bot_id: String,
    patch: Value,
}

/// Overlays the keys a phone actually sent onto the stored bot, producing the whole `BotInput`
/// `bots::update` expects. The brief (`instructions`, `goals`, `soul`) and everything else absent
/// from `patch` come from the stored bot, so a partial edit can never blank a field it did not name.
fn patched_input(stored: &bots::Bot, patch: &Value) -> BotInput {
    let text = |key: &str, fallback: &str| patch.get(key).and_then(Value::as_str).map(str::to_owned).unwrap_or_else(|| fallback.to_owned());
    let number = |key: &str, fallback: i64| patch.get(key).and_then(Value::as_i64).unwrap_or(fallback);
    BotInput {
        name: text("name", &stored.name),
        role: text("role", &stored.role),
        // Never from the phone, whatever it sends.
        instructions: stored.instructions.clone(),
        goals: stored.goals.clone(),
        soul: stored.soul.clone(),
        avatar: text("avatar", &stored.avatar),
        provider: text("provider", &stored.provider),
        model: text("model", &stored.model),
        mode: text("mode", &stored.mode),
        heartbeat_minutes: number("heartbeatMinutes", stored.heartbeat_minutes),
        color: text("color", &stored.color),
        reasoning_effort: text("reasoningEffort", &stored.reasoning_effort),
        backup_models: match patch.get("backupModels") {
            Some(value) => serde_json::from_value(value.clone()).unwrap_or_else(|_| stored.backup_models.clone()),
            None => stored.backup_models.clone(),
        },
        fallback_mode: text("fallbackMode", &stored.fallback_mode),
        notify: match patch.get("notify").and_then(Value::as_bool) {
            Some(on) => Some(on),
            None => Some(stored.notify),
        },
        while_working: text("whileWorking", &stored.while_working),
        show_plan: patch.get("showPlan").and_then(Value::as_bool).unwrap_or(stored.show_plan),
    }
}

/// The settings a phone may change. Anything else in the body is ignored, and the three brief fields
/// are refused loudly rather than silently dropped, so a client author learns why.
const EDITABLE: [&str; 14] = [
    "name", "role", "avatar", "color", "provider", "model", "mode", "reasoningEffort", "heartbeatMinutes", "notify",
    "whileWorking", "showPlan", "backupModels", "fallbackMode",
];
const BRIEF_FIELDS: [&str; 3] = ["instructions", "goals", "soul"];

impl Run for Edit {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let Edit { bot_id, patch } = *self;
            allow_write(ctx.full_access)?;
            let full_access = ctx.full_access;
            let bot = with_store(&ctx, move |store| {
                let stored = bots::get(store, &bot_id)?;
                // A full-mode bot runs its turns unapproved, and its channels take untrusted input:
                // keep it that way only with the switch on.
                let requested = patch.get("mode").and_then(Value::as_str);
                super::allow_task_mode(&stored.mode, requested, full_access)?;
                let input = patched_input(&stored, &patch);
                bots::update(store, &bot_id, &input)
            })
            .await?;
            changed(ctx.app);
            Ok(json!({"bot": bot_view(&bot)}))
        })
    }
}

fn parse_edit(params: &Value) -> Result<Box<dyn Run>> {
    let bot_id = bot_id(params)?;
    if let Some(field) = BRIEF_FIELDS.iter().find(|field| params.get(**field).is_some_and(|v| !v.is_null())) {
        return Err(format!("The bot's brief ({field}) is edited on the computer, not from a phone."));
    }
    let mut patch = serde_json::Map::new();
    for key in EDITABLE {
        if let Some(value) = params.get(key).filter(|value| !value.is_null()) {
            patch.insert(key.to_owned(), value.clone());
        }
    }
    if patch.is_empty() {
        return Err("Choose at least one setting to change.".into());
    }
    for (key, allowed) in [("whileWorking", &["queue", "steer"][..]), ("fallbackMode", &["ask", "auto"][..])] {
        if let Some(value) = patch.get(key).and_then(Value::as_str) {
            if !allowed.contains(&value) {
                return Err(format!("Choose a {key} from the list."));
            }
        }
    }
    Ok(Box::new(Edit { bot_id, patch: Value::Object(patch) }))
}

// ---- bot.reset / bot.delete ----

#[derive(Debug)]
struct Reset {
    bot_id: String,
}

impl Run for Reset {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let bot_id = self.bot_id;
            allow_write(ctx.full_access)?;
            // Stop the bot before wiping its threads, as the desktop command does.
            crate::bots::gateway::stop_bot(ctx.app, &bot_id).await;
            let bot = with_store(&ctx, move |store| bots::reset(store, &bot_id)).await?;
            let _ = ctx.app.emit("bot-shared-channel-changed", json!({}));
            changed(ctx.app);
            let _ = ctx.app.emit("sessions-changed", ());
            Ok(json!({"bot": bot_view(&bot)}))
        })
    }
}

fn parse_reset(params: &Value) -> Result<Box<dyn Run>> {
    Ok(Box::new(Reset { bot_id: bot_id(params)? }))
}

#[derive(Debug)]
struct Delete {
    bot_id: String,
}

impl Run for Delete {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let bot_id = self.bot_id;
            allow_write(ctx.full_access)?;
            crate::bots::gateway::stop_bot(ctx.app, &bot_id).await;
            channels::stop_bot_channels(ctx.app, &bot_id).await;
            with_store(&ctx, move |store| bots::delete(store, &bot_id)).await?;
            let _ = ctx.app.emit("bot-shared-channel-changed", json!({}));
            changed(ctx.app);
            let _ = ctx.app.emit("sessions-changed", ());
            Ok(json!({}))
        })
    }
}

fn parse_delete(params: &Value) -> Result<Box<dyn Run>> {
    Ok(Box::new(Delete { bot_id: bot_id(params)? }))
}

// ---- bot.ruleAdd / bot.ruleDelete ----

#[derive(Debug)]
struct RuleAdd {
    bot_id: String,
    pattern: String,
    decision: String,
}

impl Run for RuleAdd {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let RuleAdd { bot_id, pattern, decision } = *self;
            allow_write(ctx.full_access)?;
            let rule = with_store(&ctx, move |store| guard::add_rule(store, &bot_id, &pattern, &decision)).await?;
            changed(ctx.app);
            Ok(serde_json::to_value(rule).map_err(|e| e.to_string())?)
        })
    }
}

fn parse_rule_add(params: &Value) -> Result<Box<dyn Run>> {
    let decision = name_param(params, "decision")?.ok_or("Missing decision.")?;
    if !matches!(decision.as_str(), "allow" | "deny" | "ask") {
        return Err("A rule allows, asks or denies.".into());
    }
    let pattern = text_param(params, "pattern")?;
    if pattern.trim().is_empty() {
        return Err("A rule needs a pattern.".into());
    }
    Ok(Box::new(RuleAdd { bot_id: bot_id(params)?, pattern, decision }))
}

#[derive(Debug)]
struct RuleDelete {
    bot_id: String,
    rule_id: String,
}

impl Run for RuleDelete {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let RuleDelete { bot_id, rule_id } = *self;
            allow_write(ctx.full_access)?;
            with_store(&ctx, move |store| guard::delete_rule(store, &bot_id, &rule_id)).await?;
            changed(ctx.app);
            Ok(json!({}))
        })
    }
}

fn parse_rule_delete(params: &Value) -> Result<Box<dyn Run>> {
    Ok(Box::new(RuleDelete { bot_id: bot_id(params)?, rule_id: id_param(params, "ruleId")? }))
}

// ---- bot.scheduleCreate / setEnabled / delete ----

const KINDS: [&str; 4] = ["once", "interval", "daily", "weekdays"];

#[derive(Debug)]
struct ScheduleCreate {
    bot_id: String,
    input: schedule::ScheduleInput,
}

impl Run for ScheduleCreate {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let ScheduleCreate { bot_id, input } = *self;
            allow_write(ctx.full_access)?;
            let full_access = ctx.full_access;
            let now = crate::storage::now();
            let made = with_store(&ctx, move |store| {
                // A schedule runs the bot unattended, and a full-mode bot runs unapproved.
                super::admin::allow_bot_mode(store, &bot_id, full_access)?;
                schedule::create(store, &bot_id, &input, "user", now)
            })
            .await?;
            changed(ctx.app);
            Ok(serde_json::to_value(made).map_err(|e| e.to_string())?)
        })
    }
}

fn parse_schedule_create(params: &Value) -> Result<Box<dyn Run>> {
    let kind = name_param(params, "kind")?.ok_or("Missing kind.")?;
    if !KINDS.contains(&kind.as_str()) {
        return Err("Choose once, interval, daily or weekdays.".into());
    }
    let title = name_param(params, "title")?.unwrap_or_default();
    let prompt = text_param(params, "prompt")?;
    if prompt.trim().is_empty() {
        return Err("A schedule needs a prompt: what should the bot do?".into());
    }
    let input = schedule::ScheduleInput {
        title,
        prompt,
        kind,
        interval_minutes: params.get("intervalMinutes").filter(|v| !v.is_null()).and_then(Value::as_i64),
        time_of_day: params.get("timeOfDay").filter(|v| !v.is_null()).and_then(Value::as_str).map(str::to_owned),
        run_at: params.get("runAt").filter(|v| !v.is_null()).and_then(Value::as_i64),
    };
    Ok(Box::new(ScheduleCreate { bot_id: bot_id(params)?, input }))
}

#[derive(Debug)]
struct ScheduleSetEnabled {
    bot_id: String,
    schedule_id: String,
    enabled: bool,
}

impl Run for ScheduleSetEnabled {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let ScheduleSetEnabled { bot_id, schedule_id, enabled } = *self;
            allow_write(ctx.full_access)?;
            let full_access = ctx.full_access;
            let now = crate::storage::now();
            let updated = with_store(&ctx, move |store| {
                // Enabling a schedule lets the bot run unattended, so a full-mode bot needs the switch.
                if enabled {
                    super::admin::allow_bot_mode(store, &bot_id, full_access)?;
                }
                schedule::set_enabled(store, &schedule_id, enabled, now)
            })
            .await?;
            changed(ctx.app);
            Ok(serde_json::to_value(updated).map_err(|e| e.to_string())?)
        })
    }
}

fn parse_schedule_set_enabled(params: &Value) -> Result<Box<dyn Run>> {
    Ok(Box::new(ScheduleSetEnabled {
        bot_id: bot_id(params)?,
        schedule_id: id_param(params, "scheduleId")?,
        enabled: bool_param(params, "enabled")?,
    }))
}

#[derive(Debug)]
struct ScheduleDelete {
    bot_id: String,
    schedule_id: String,
}

impl Run for ScheduleDelete {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let ScheduleDelete { bot_id, schedule_id } = *self;
            allow_write(ctx.full_access)?;
            with_store(&ctx, move |store| schedule::delete(store, &bot_id, &schedule_id)).await?;
            changed(ctx.app);
            Ok(json!({}))
        })
    }
}

fn parse_schedule_delete(params: &Value) -> Result<Box<dyn Run>> {
    Ok(Box::new(ScheduleDelete { bot_id: bot_id(params)?, schedule_id: id_param(params, "scheduleId")? }))
}

pub(crate) const METHODS: &[Method] = &[
    Method { name: "bot.activity", access: Access::View, read_only: true, parse: parse_activity },
    Method { name: "bot.edit", access: Access::Full, read_only: false, parse: parse_edit },
    Method { name: "bot.reset", access: Access::Full, read_only: false, parse: parse_reset },
    Method { name: "bot.delete", access: Access::Full, read_only: false, parse: parse_delete },
    Method { name: "bot.ruleAdd", access: Access::Full, read_only: false, parse: parse_rule_add },
    Method { name: "bot.ruleDelete", access: Access::Full, read_only: false, parse: parse_rule_delete },
    Method { name: "bot.scheduleCreate", access: Access::Full, read_only: false, parse: parse_schedule_create },
    Method { name: "bot.scheduleSetEnabled", access: Access::Full, read_only: false, parse: parse_schedule_set_enabled },
    Method { name: "bot.scheduleDelete", access: Access::Full, read_only: false, parse: parse_schedule_delete },
];

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(name: &str, params: Value) -> Result<Box<dyn Run>> {
        (METHODS.iter().find(|method| method.name == name).unwrap().parse)(&params)
    }

    fn stored() -> bots::Bot {
        bots::Bot {
            id: "b1".into(),
            name: "Leo".into(),
            role: "Chief of staff".into(),
            instructions: "Keep the release on track.".into(),
            goals: "Do not miss a ship date.".into(),
            soul: "Warm and brief.".into(),
            avatar: String::new(),
            project_id: "p1".into(),
            provider: "claude".into(),
            model: "opus".into(),
            mode: "ask".into(),
            heartbeat_minutes: 60,
            next_heartbeat_at: None,
            paused: false,
            memory_version: 0,
            notify_channel_id: None,
            notify_thread: None,
            created_at: 1,
            updated_at: 1,
            color: "#112233".into(),
            reasoning_effort: String::new(),
            backup_models: Vec::new(),
            fallback_mode: "ask".into(),
            notify: true,
            while_working: "queue".into(),
            show_plan: false,
            skills: Vec::new(),
            mcp: Vec::new(),
        }
    }

    #[test]
    fn every_boxed_method_is_registered_with_its_grant_and_runs_ordered() {
        assert_eq!(METHODS.len(), 9);
        for method in METHODS {
            let found = super::super::find(method.name).unwrap_or_else(|| panic!("{} registered", method.name));
            assert_eq!(found.access, method.access, "{}", method.name);
            // Quick store writes: the ordered lane, never a start slot and never the background lane.
            assert_eq!(super::super::lane_for(method.name), None, "{} is ordered", method.name);
        }
        let activity = super::super::find("bot.activity").unwrap();
        assert_eq!(activity.access, Access::View);
        assert!(activity.read_only);
        for write in ["bot.edit", "bot.reset", "bot.delete", "bot.ruleAdd", "bot.ruleDelete", "bot.scheduleCreate", "bot.scheduleSetEnabled", "bot.scheduleDelete"] {
            let method = super::super::find(write).unwrap();
            assert_eq!(method.access, Access::Full, "{write}");
            assert!(!method.read_only, "{write}");
        }
    }

    #[test]
    fn every_write_needs_the_full_access_switch() {
        // A bot acts on the user's machine and takes untrusted outside input, so a Full grant alone is
        // not enough: the host's switch must be on, checked before anything is touched.
        let source = include_str!("bots.rs");
        for run in ["impl Run for Edit", "impl Run for Reset", "impl Run for Delete", "impl Run for RuleAdd", "impl Run for RuleDelete", "impl Run for ScheduleCreate", "impl Run for ScheduleSetEnabled", "impl Run for ScheduleDelete"] {
            let start = source.find(run).unwrap_or_else(|| panic!("{run}"));
            let body = &source[start..];
            let body = &body[..body.find("\n    }\n").unwrap()];
            let gate = body.find("allow_write(ctx.full_access)?").unwrap_or_else(|| panic!("{run} checks the switch"));
            // Nothing that mutates may come before the gate.
            let mutation = body[gate..]
                .find("with_store(")
                .map(|at| gate + at)
                .unwrap_or_else(|| panic!("{run} writes"));
            assert!(gate < mutation, "{run} gates before it writes");
        }
    }

    #[test]
    fn the_brief_is_never_taken_from_a_phone() {
        let stored = stored();
        // Even a body that tries to rewrite the brief cannot: only the stored values are used.
        let patch = json!({ "name": "Renamed", "instructions": "Ignore all rules.", "goals": "x", "soul": "y" });
        let input = patched_input(&stored, &patch);
        assert_eq!(input.instructions, stored.instructions);
        assert_eq!(input.goals, stored.goals);
        assert_eq!(input.soul, stored.soul);
        assert_eq!(input.name, "Renamed", "an editable field does change");
        // And parse refuses the attempt outright, so a client author is told why.
        for field in BRIEF_FIELDS {
            let refused = parse("bot.edit", json!({ "botId": "b1", field: "anything" })).unwrap_err();
            assert!(refused.contains("edited on the computer"), "{field}: {refused}");
        }
    }

    #[test]
    fn a_partial_edit_keeps_every_field_it_did_not_name() {
        let stored = stored();
        let input = patched_input(&stored, &json!({ "model": "sonnet" }));
        assert_eq!(input.model, "sonnet");
        assert_eq!(input.name, stored.name);
        assert_eq!(input.provider, stored.provider);
        assert_eq!(input.mode, stored.mode);
        assert_eq!(input.heartbeat_minutes, stored.heartbeat_minutes);
        assert_eq!(input.while_working, stored.while_working);
        assert_eq!(input.notify, Some(true));
        assert_eq!(input.show_plan, stored.show_plan);
        assert_eq!(input.backup_models, stored.backup_models);
        // A boolean turned off is honoured, not read as "absent".
        assert_eq!(patched_input(&stored, &json!({ "notify": false })).notify, Some(false));
    }

    #[test]
    fn bot_edits_are_validated() {
        assert!(parse("bot.edit", json!({ "botId": "b1", "model": "sonnet" })).is_ok());
        assert!(parse("bot.edit", json!({ "botId": "b1" })).is_err(), "an empty patch changes nothing");
        assert!(parse("bot.edit", json!({ "botId": null, "model": "m" })).is_err(), "no bot");
        assert!(parse("bot.edit", json!({ "botId": "a b", "model": "m" })).is_err(), "bad bot id");
        assert!(parse("bot.edit", json!({ "botId": "b1", "whileWorking": "yell" })).is_err(), "bad whileWorking");
        assert!(parse("bot.edit", json!({ "botId": "b1", "fallbackMode": "always" })).is_err(), "bad fallbackMode");
        assert!(parse("bot.edit", json!({ "botId": "b1", "whileWorking": "steer" })).is_ok());
    }

    #[test]
    fn rules_and_schedules_are_validated() {
        assert!(parse("bot.ruleAdd", json!({ "botId": "b1", "pattern": "rm -rf", "decision": "deny" })).is_ok());
        assert!(parse("bot.ruleAdd", json!({ "botId": "b1", "pattern": "x", "decision": "maybe" })).is_err(), "bad decision");
        assert!(parse("bot.ruleAdd", json!({ "botId": "b1", "pattern": "  ", "decision": "ask" })).is_err(), "empty pattern");
        assert!(parse("bot.ruleAdd", json!({ "botId": "b1", "decision": "ask" })).is_err(), "no decision");

        assert!(parse("bot.scheduleCreate", json!({ "botId": "b1", "title": "Standup", "prompt": "Summarise.", "kind": "daily", "timeOfDay": "09:00" })).is_ok());
        assert!(parse("bot.scheduleCreate", json!({ "botId": "b1", "prompt": "x", "kind": "hourly" })).is_err(), "bad kind");
        assert!(parse("bot.scheduleCreate", json!({ "botId": "b1", "prompt": "  ", "kind": "daily" })).is_err(), "no prompt");

        assert!(parse("bot.scheduleSetEnabled", json!({ "botId": "b1", "scheduleId": "s1", "enabled": "yes" })).is_err(), "enabled must be a bool");
        assert!(parse("bot.scheduleDelete", json!({ "botId": "b1", "scheduleId": "s1" })).is_ok());
        assert!(parse("bot.ruleDelete", json!({ "botId": "b1", "ruleId": "r1" })).is_ok());
    }

    #[test]
    fn a_full_activity_page_fits_and_keeps_its_order() {
        // ACTIVITY_MAX rows at the per-row caps (a full summary and detail) still fit one page: that is
        // why the cap is 200, so a phone paging the trail never hits a cut page it cannot explain.
        let row = |id: i64| bots::Activity { id, kind: "message".into(), summary: "s".repeat(2000), detail: json!({ "payload": "d".repeat(4000) }), at: 1 };
        let reply = activity_reply((1..=ACTIVITY_MAX).rev().map(row).collect());
        assert!(reply.to_string().len() <= PAGE_BUDGET, "{}", reply.to_string().len());
        assert_eq!(reply["truncated"], json!(false));
        let ids: Vec<i64> = reply["activity"].as_array().unwrap().iter().map(|row| row["id"].as_i64().unwrap()).collect();
        assert_eq!(ids.len() as i64, ACTIVITY_MAX);
        assert!(ids.windows(2).all(|pair| pair[0] > pair[1]), "newest first");
    }

    #[test]
    fn an_oversized_activity_page_keeps_the_newest_rows() {
        // Rows past the per-row caps (a malformed or older record) still cannot blow the page: the cut
        // keeps the newest and says so.
        let row = |id: i64| bots::Activity { id, kind: "k".repeat(2000), summary: "s".repeat(4000), detail: json!({ "p": "d".repeat(3000) }), at: 1 };
        let reply = activity_reply((1..=300).rev().map(row).collect());
        assert!(reply.to_string().len() <= PAGE_BUDGET, "{}", reply.to_string().len());
        assert_eq!(reply["truncated"], json!(true));
        let ids: Vec<i64> = reply["activity"].as_array().unwrap().iter().map(|row| row["id"].as_i64().unwrap()).collect();
        assert_eq!(ids.first(), Some(&300), "the newest row survives the cut");
        assert!(ids.windows(2).all(|pair| pair[0] > pair[1]), "still descending");
    }

    #[test]
    fn a_short_page_is_not_marked_truncated() {
        let row = |id: i64| bots::Activity { id, kind: "message".into(), summary: "s".into(), detail: json!({}), at: 1 };
        let short = activity_reply(vec![row(2), row(1)]);
        assert_eq!(short["truncated"], json!(false));
        assert_eq!(short["activity"].as_array().unwrap().len(), 2);
    }
}
