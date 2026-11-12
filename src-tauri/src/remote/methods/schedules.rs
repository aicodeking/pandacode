//! PandaConnect methods for the `schedules` feature group: the desktop's task schedules
//! (`crate::schedules`, IPC contract `src/schedules-api.ts`). See `methods/mod.rs` and
//! docs/remote-access.md, "Adding a method".
//!
//! `schedules.list` and `schedules.runs` (View) read schedules and their run history, with
//! each schedule's cadence in the desktop's words and whether the scheduler is paused.
//! `schedules.runNow`, `schedules.setEnabled` and `schedules.snooze` (Control) drive an
//! existing schedule; `schedules.create`, `schedules.update` and `schedules.delete` (Full)
//! change what will be sent. Each runs the desktop's own command, so validation, events and
//! delivery are the desktop's. A schedule sends prompts to its thread in that thread's own
//! mode, so without "Full access for remote tasks" the phone may not create, edit, enable or
//! run one whose thread is in Full access (`allow_task_mode`). A bot's thread (target or
//! watched) needs a Full device and the bot's own mode rule, as `task.send` does
//! (`drivable_session_from`, Round 21).
use super::{allow_remote_team, allow_task_mode, drivable_session_from, id_param, local_session_from, Access, Ctx, Method, Reply, Run, MAX_TEXT, PAGE_BUDGET};
use crate::schedules::{self as desktop, ScheduleInput};
use crate::Result;
use serde_json::{json, Value};

const DEFAULT_RUNS: i64 = 50;
const MAX_RUNS: i64 = 200;
const MAX_TITLE: usize = 120;

fn schedule_id(params: &Value) -> Result<String> {
    id_param(params, "scheduleId")
}

fn optional_id(params: &Value, key: &str) -> Result<Option<String>> {
    match params.get(key).filter(|value| !value.is_null()) {
        None => Ok(None),
        Some(_) => id_param(params, key).map(Some),
    }
}

/// A schedule as the phone shows it: the desktop's row plus its cadence in words.
fn with_cadence(schedule: &desktop::TaskSchedule) -> Value {
    let mut value = serde_json::to_value(schedule).unwrap_or_default();
    value["cadence"] = json!(desktop::cadence(schedule));
    value
}

/// Drops items past the page budget (from the end), saying so.
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

/// Refuses a change that would make thread `session_id` run in Full access from the phone, or
/// drive a bot's thread from a device below Full.
fn check_target(store: &crate::storage::Store, session_id: &str, device_full: bool, full_access: bool) -> Result<()> {
    let task = drivable_session_from(store, session_id, device_full, full_access)?;
    allow_task_mode(&task.mode, None, full_access)?;
    // A scheduled prompt to a team lead would dispatch workers, which run in full access.
    allow_remote_team(store, session_id, full_access)
}

/// Runs `work` with the store locked, off the async runtime.
async fn with_store<T: Send + 'static>(ctx: &Ctx<'_>, work: impl FnOnce(&crate::storage::Store) -> Result<T> + Send + 'static) -> Result<T> {
    let store = ctx.state().store.clone();
    crate::blocking(move || work(&*store.lock().map_err(|e| e.to_string())?)).await
}

// ---- schedules.list ----

#[derive(Debug)]
struct List {
    session_id: Option<String>,
}

impl Run for List {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let (schedules, paused) = with_store(&ctx, move |store| {
                let schedules: Vec<Value> = desktop::list(store, self.session_id.as_deref())?.iter().map(with_cadence).collect();
                Ok((schedules, desktop::settings(store)?.paused))
            })
            .await?;
            Ok(fit(schedules, move |items, truncated| json!({"schedules": items, "paused": paused, "truncated": truncated})))
        })
    }
}

fn parse_list(params: &Value) -> Result<Box<dyn Run>> {
    Ok(Box::new(List { session_id: optional_id(params, "sessionId")? }))
}

// ---- schedules.runs ----

#[derive(Debug)]
struct Runs {
    session_id: Option<String>,
    schedule_id: Option<String>,
    limit: i64,
}

fn parse_runs(params: &Value) -> Result<Box<dyn Run>> {
    let limit = match params.get("limit").filter(|value| !value.is_null()) {
        None => DEFAULT_RUNS,
        Some(value) => value.as_i64().filter(|n| (1..=MAX_RUNS).contains(n)).ok_or("Invalid limit.")?,
    };
    Ok(Box::new(Runs { session_id: optional_id(params, "sessionId")?, schedule_id: optional_id(params, "scheduleId")?, limit }))
}

impl Run for Runs {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let runs = with_store(&ctx, move |store| desktop::runs(store, self.session_id.as_deref(), self.schedule_id.as_deref(), self.limit)).await?;
            let runs = runs.into_iter().map(|run| serde_json::to_value(run).unwrap_or_default()).collect();
            Ok(fit(runs, |items, truncated| json!({"runs": items, "truncated": truncated})))
        })
    }
}

// ---- schedules.runNow / setEnabled / snooze / delete ----

#[derive(Debug, PartialEq)]
enum Action {
    RunNow,
    SetEnabled(bool),
    Snooze(i64),
    Delete,
}

#[derive(Debug)]
struct Act {
    schedule_id: String,
    action: Action,
    /// `schedules.runNow` only: a retry with the same id answers the first run (`once_per_action`).
    send_id: Option<String>,
}

fn act(schedule_id: String, action: Action) -> Box<Act> {
    Box::new(Act { schedule_id, action, send_id: None })
}

fn parse_run_now(params: &Value) -> Result<Box<dyn Run>> {
    Ok(Box::new(Act { schedule_id: schedule_id(params)?, action: Action::RunNow, send_id: super::send_id_param(params)? }))
}

fn parse_set_enabled(params: &Value) -> Result<Box<dyn Run>> {
    let enabled = params["enabled"].as_bool().ok_or("Invalid enabled.")?;
    Ok(act(schedule_id(params)?, Action::SetEnabled(enabled)))
}

fn parse_snooze(params: &Value) -> Result<Box<dyn Run>> {
    // The range is the desktop's (`schedules::snooze`), checked there too.
    let minutes = params["minutes"].as_i64().filter(|m| (1..=7 * 24 * 60).contains(m)).ok_or("Snooze for 1 minute to 7 days.")?;
    Ok(act(schedule_id(params)?, Action::Snooze(minutes)))
}

fn parse_delete(params: &Value) -> Result<Box<dyn Run>> {
    Ok(act(schedule_id(params)?, Action::Delete))
}

impl Run for Act {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            if self.action != Action::RunNow {
                return act_on(ctx, *self).await;
            }
            let (send_id, target) = (self.send_id.clone(), self.schedule_id.clone());
            super::once_per_action(ctx.from, "schedules.runNow", &target, send_id.as_deref(), act_on(ctx, *self)).await
        })
    }
}

/// One schedule action; `schedules.runNow` sends under the thread's send lock.
async fn act_on(ctx: Ctx<'_>, this: Act) -> Result<Value> {
    let id = this.schedule_id.clone();
    let full_access = ctx.full_access;
    let device_full = super::files::device_from_has_full(ctx.app, ctx.from);
    // Running or turning on a schedule sends to its thread: the thread must be local, drivable
    // by this device (a bot's thread needs Full) and its mode allowed.
    let gated = matches!(this.action, Action::RunNow | Action::SetEnabled(true));
    let session_id = with_store(&ctx, move |store| {
        let schedule = desktop::get(store, &id)?;
        if gated {
            check_target(store, &schedule.session_id, device_full, full_access)?;
            // A watch trigger sends when the watched thread finishes: it must be drivable too.
            if let Some(watch) = schedule.watch_session_id.as_deref().filter(|id| !id.is_empty()) {
                drivable_session_from(store, watch, device_full, full_access)?;
            }
        } else {
            local_session_from(store, &schedule.session_id)?;
        }
        Ok(schedule.session_id)
    })
    .await?;
    let (app, state, id) = (ctx.app.clone(), ctx.state(), this.schedule_id);
    Ok(match this.action {
        Action::RunNow => {
            // Background lane: never check-then-send beside a `task.send` or `recipes.run`.
            let _turn = super::task_send_lock(&session_id).await;
            json!({"run": desktop::schedule_run_now(app, state, id).await?})
        }
        Action::SetEnabled(enabled) => json!({"schedule": with_cadence(&desktop::schedule_set_enabled(app, state, id, enabled).await?)}),
        Action::Snooze(minutes) => json!({"schedule": with_cadence(&desktop::schedule_snooze(app, state, id, minutes).await?)}),
        Action::Delete => {
            desktop::schedule_delete(app, state, id).await?;
            json!({})
        }
    })
}

// ---- schedules.create / update ----

/// The desktop's `ScheduleInput`, with ids, sizes and kinds checked before it reaches the store.
fn input_param(params: &Value) -> Result<ScheduleInput> {
    let raw = params.get("input").filter(|value| value.is_object()).ok_or("Missing input.")?;
    let input: ScheduleInput = serde_json::from_value(raw.clone()).map_err(|_| "Invalid schedule.".to_string())?;
    super::valid_id(&input.session_id).map_err(|_| "Invalid sessionId.".to_string())?;
    if let Some(watch) = input.watch_session_id.as_deref().filter(|id| !id.is_empty()) {
        super::valid_id(watch).map_err(|_| "Invalid watchSessionId.".to_string())?;
    }
    if let Some(chain) = input.chain_from_id.as_deref().filter(|id| !id.is_empty()) {
        super::valid_id(chain).map_err(|_| "Invalid chainFromId.".to_string())?;
    }
    if input.prompt.trim().is_empty() || input.prompt.len() > MAX_TEXT {
        return Err("Write a message of up to 100 KB.".into());
    }
    if input.title.chars().count() > MAX_TITLE {
        return Err("Keep the title under 120 characters.".into());
    }
    if !["once", "interval", "daily", "weekdays", "weekly", "after"].contains(&input.kind.as_str()) {
        return Err("Choose once, interval, daily, weekdays, weekly or after.".into());
    }
    if input.days.len() > 7 || input.time_of_day.as_deref().is_some_and(|time| time.len() > 8) || input.workflow_id.as_deref().is_some_and(|id| id.len() > 256) {
        return Err("Invalid schedule.".into());
    }
    Ok(input)
}

/// Which workflow fields an update's input names; one it leaves out keeps the schedule's own
/// (the phone's form has no workflow fields, and the desktop's input defaults them to none).
#[derive(Debug, Default, PartialEq)]
struct Names {
    workflow: bool,
    chain: bool,
}

fn names(params: &Value) -> Names {
    let input = &params["input"];
    Names { workflow: input.get("workflowId").is_some(), chain: input.get("chainFromId").is_some() }
}

/// `input` with the workflow and chain of the schedule it edits wherever `named` leaves them out.
fn keep_chain(mut input: ScheduleInput, named: &Names, before: &desktop::TaskSchedule) -> ScheduleInput {
    if !named.workflow {
        input.workflow_id = before.workflow_id.clone();
    }
    if !named.chain {
        input.chain_from_id = before.chain_from_id.clone();
    }
    input
}

#[derive(Debug)]
struct Save {
    /// None creates.
    schedule_id: Option<String>,
    input: ScheduleInput,
    /// Update only: the workflow fields the input names.
    named: Names,
    /// `schedules.create` only: a retry with the same id answers the first schedule (`once_per_action`).
    send_id: Option<String>,
}

fn parse_create(params: &Value) -> Result<Box<dyn Run>> {
    Ok(Box::new(Save { schedule_id: None, input: input_param(params)?, named: names(params), send_id: super::send_id_param(params)? }))
}

fn parse_update(params: &Value) -> Result<Box<dyn Run>> {
    Ok(Box::new(Save { schedule_id: Some(schedule_id(params)?), input: input_param(params)?, named: names(params), send_id: None }))
}

impl Run for Save {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            if self.schedule_id.is_some() {
                return save(ctx, *self).await;
            }
            let (send_id, target) = (self.send_id.clone(), self.input.session_id.clone());
            super::once_per_action(ctx.from, "schedules.create", &target, send_id.as_deref(), save(ctx, *self)).await
        })
    }
}

/// Creates or updates one schedule after checking its threads; an update keeps the
/// schedule's workflow and chain unless the input names them.
async fn save(ctx: Ctx<'_>, this: Save) -> Result<Value> {
    let full_access = ctx.full_access;
    let device_full = super::files::device_from_has_full(ctx.app, ctx.from);
    let (target, watch, existing) = (this.input.session_id.clone(), this.input.watch_session_id.clone().filter(|id| !id.is_empty()), this.schedule_id.clone());
    let before = with_store(&ctx, move |store| {
        let before = match &existing {
            Some(id) => {
                let before = desktop::get(store, id)?;
                local_session_from(store, &before.session_id)?;
                Some(before)
            }
            None => None,
        };
        check_target(store, &target, device_full, full_access)?;
        if let Some(watch) = &watch {
            drivable_session_from(store, watch, device_full, full_access)?;
        }
        Ok(before)
    })
    .await?;
    let (app, state) = (ctx.app.clone(), ctx.state());
    let schedule = match (this.schedule_id, before) {
        // Marked as saved remotely, so the gate is checked again when it fires (`remote_team_gate`).
        (Some(id), Some(before)) => desktop::save_update(&app, &state, &id, &keep_chain(this.input, &this.named, &before), true)?,
        _ => desktop::save_create(&app, &state, &this.input, true)?,
    };
    Ok(json!({"schedule": with_cadence(&schedule)}))
}

pub(crate) const METHODS: &[Method] = &[
    Method { name: "schedules.list", access: Access::View, read_only: true, parse: parse_list },
    Method { name: "schedules.runs", access: Access::View, read_only: true, parse: parse_runs },
    Method { name: "schedules.runNow", access: Access::Control, read_only: false, parse: parse_run_now },
    Method { name: "schedules.setEnabled", access: Access::Control, read_only: false, parse: parse_set_enabled },
    Method { name: "schedules.snooze", access: Access::Control, read_only: false, parse: parse_snooze },
    Method { name: "schedules.create", access: Access::Full, read_only: false, parse: parse_create },
    Method { name: "schedules.update", access: Access::Full, read_only: false, parse: parse_update },
    Method { name: "schedules.delete", access: Access::Full, read_only: false, parse: parse_delete },
];

#[cfg(test)]
mod tests {
    use super::*;

    fn method(name: &str) -> &'static Method {
        METHODS.iter().find(|m| m.name == name).unwrap()
    }

    #[test]
    fn scopes_follow_what_each_method_changes() {
        for (name, access) in [
            ("schedules.list", Access::View),
            ("schedules.runs", Access::View),
            ("schedules.runNow", Access::Control),
            ("schedules.setEnabled", Access::Control),
            ("schedules.snooze", Access::Control),
            ("schedules.create", Access::Full),
            ("schedules.update", Access::Full),
            ("schedules.delete", Access::Full),
        ] {
            assert_eq!(method(name).access, access, "{name}");
            assert_eq!(method(name).read_only, access == Access::View, "{name}");
        }
    }

    #[test]
    fn reads_take_optional_ids_and_a_bounded_limit() {
        assert!((method("schedules.list").parse)(&json!({})).is_ok());
        assert!((method("schedules.list").parse)(&json!({"sessionId": null})).is_ok());
        assert!((method("schedules.list").parse)(&json!({"sessionId": ""})).is_err());
        assert!((method("schedules.runs").parse)(&json!({"scheduleId": "s1", "limit": 20})).is_ok());
        assert!((method("schedules.runs").parse)(&json!({"limit": 0})).is_err());
        assert!((method("schedules.runs").parse)(&json!({"limit": 201})).is_err());
    }

    #[test]
    fn actions_check_their_params() {
        assert!((method("schedules.runNow").parse)(&json!({})).is_err());
        assert!((method("schedules.runNow").parse)(&json!({"scheduleId": "s1"})).is_ok());
        assert!((method("schedules.setEnabled").parse)(&json!({"scheduleId": "s1"})).is_err());
        assert!((method("schedules.setEnabled").parse)(&json!({"scheduleId": "s1", "enabled": "yes"})).is_err());
        assert!((method("schedules.setEnabled").parse)(&json!({"scheduleId": "s1", "enabled": false})).is_ok());
        assert!((method("schedules.snooze").parse)(&json!({"scheduleId": "s1", "minutes": 0})).is_err());
        assert!((method("schedules.snooze").parse)(&json!({"scheduleId": "s1", "minutes": 7 * 24 * 60 + 1})).is_err());
        assert!((method("schedules.snooze").parse)(&json!({"scheduleId": "s1", "minutes": 60})).is_ok());
        assert!((method("schedules.delete").parse)(&json!({"scheduleId": "a b"})).is_err());
    }

    #[test]
    fn run_now_takes_a_send_id_and_sends_under_the_task_lock() {
        let call = (method("schedules.runNow").parse)(&json!({"scheduleId": "s1", "sendId": "abc-1"})).unwrap();
        assert!(format!("{call:?}").contains("send_id: Some(\"abc-1\")"));
        assert!((method("schedules.runNow").parse)(&json!({"scheduleId": "s1", "sendId": "a b"})).is_err());
        let source = include_str!("schedules.rs");
        let body = &source[source.find("async fn act_on").unwrap()..source.find("// ---- schedules.create").unwrap()];
        assert!(body.find("task_send_lock(&session_id)").unwrap() < body.find("schedule_run_now").unwrap());
    }

    #[test]
    fn inputs_are_checked_before_the_store() {
        let good = json!({"input": {"sessionId": "t1", "prompt": "Check CI", "kind": "daily", "timeOfDay": "09:30"}});
        assert!((method("schedules.create").parse)(&good).is_ok());
        assert!((method("schedules.update").parse)(&good).is_err(), "update needs a scheduleId");
        assert!((method("schedules.update").parse)(&json!({"scheduleId": "s1", "input": good["input"]})).is_ok());
        let bad = |input: Value| (method("schedules.create").parse)(&json!({ "input": input })).is_err();
        assert!(bad(json!({"sessionId": "", "prompt": "x", "kind": "daily"})));
        assert!(bad(json!({"sessionId": "t1", "prompt": "  ", "kind": "daily"})));
        assert!(bad(json!({"sessionId": "t1", "prompt": "x".repeat(MAX_TEXT + 1), "kind": "daily"})));
        assert!(bad(json!({"sessionId": "t1", "prompt": "x", "kind": "hourly"})));
        assert!(bad(json!({"sessionId": "t1", "prompt": "x", "kind": "weekly", "days": [0, 1, 2, 3, 4, 5, 6, 0]})));
        assert!(bad(json!({"sessionId": "t1", "prompt": "x", "kind": "after", "watchSessionId": "a b"})));
        assert!(bad(json!({"sessionId": "t1", "prompt": "x", "kind": "once", "runAt": "soon"})));
        assert!(bad(json!({"sessionId": "t1", "prompt": "x", "kind": "daily", "title": "t".repeat(121)})));
        assert!((method("schedules.create").parse)(&json!({})).is_err());
    }

    #[test]
    fn create_takes_a_send_id_and_runs_once() {
        let call = (method("schedules.create").parse)(&json!({"input": {"sessionId": "t1", "prompt": "x", "kind": "daily"}, "sendId": "draft-1"})).unwrap();
        assert!(format!("{call:?}").contains("send_id: Some(\"draft-1\")"));
        assert!((method("schedules.create").parse)(&json!({"input": {"sessionId": "t1", "prompt": "x", "kind": "daily"}, "sendId": "a b"})).is_err());
        let source = include_str!("schedules.rs");
        let body = &source[source.find("impl Run for Save").unwrap()..source.find("async fn save(").unwrap()];
        assert!(body.contains("once_per_action(ctx.from, \"schedules.create\", &target"));
    }

    #[test]
    fn an_update_keeps_the_workflow_and_chain_it_leaves_out() {
        let before = desktop::TaskSchedule {
            id: "s1".into(), session_id: "t1".into(), session_title: "T".into(), project_id: "p".into(), project_name: "P".into(), title: String::new(), prompt: "x".into(),
            kind: "after".into(), interval_minutes: None, time_of_day: None, days: vec![], watch_session_id: Some("t2".into()), watch_session_title: None, only_on_success: false,
            next_run_at: None, last_run_at: None, enabled: true, created_by: "user".into(), created_by_session: None, run_count: 0, max_runs: None,
            workflow_id: Some("wf-1".into()), chain_from_id: Some("s0".into()), created_at: 0, updated_at: 0, created_by_title: None, trigger_ok: None,
        };
        let params = json!({"scheduleId": "s1", "input": {"sessionId": "t1", "prompt": "y", "kind": "after", "watchSessionId": "t2"}});
        let kept = keep_chain(input_param(&params).unwrap(), &names(&params), &before);
        assert_eq!((kept.workflow_id.as_deref(), kept.chain_from_id.as_deref()), (Some("wf-1"), Some("s0")));
        assert_eq!(kept.prompt, "y");
        // Named fields win, including an explicit null that clears one.
        let params = json!({"scheduleId": "s1", "input": {"sessionId": "t1", "prompt": "y", "kind": "after", "workflowId": "wf-2", "chainFromId": null}});
        let named = keep_chain(input_param(&params).unwrap(), &names(&params), &before);
        assert_eq!((named.workflow_id.as_deref(), named.chain_from_id), (Some("wf-2"), None));
    }

    #[test]
    fn runs_and_schedules_fit_a_page() {
        let items: Vec<Value> = (0..500).map(|i| json!({"id": i, "detail": "d".repeat(1000)})).collect();
        let reply = fit(items, |items, truncated| json!({"runs": items, "truncated": truncated}));
        assert!(reply.to_string().len() <= PAGE_BUDGET);
        assert_eq!(reply["truncated"], true);
    }

    /// Round 21: a schedule sends to its thread, so a bot's thread needs a Full device and the
    /// bot's mode rule, as `task.send` does; a plain thread keeps the task-mode check.
    #[test]
    fn a_bots_thread_needs_a_full_device_to_be_scheduled() {
        let store = crate::storage::Store::open(std::path::Path::new(":memory:")).unwrap();
        let project = store.add_project(&std::env::temp_dir()).unwrap();
        let bot_home = std::env::temp_dir().join(format!("pandacode-bot-schedule-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&bot_home).unwrap();
        let bot_project = store.add_project(&bot_home).unwrap();
        store
            .db
            .execute("INSERT INTO bots(id,name,project_id,provider,model,mode,created_at,updated_at) VALUES('b','Bot',?1,'claude','sonnet','auto',0,0)", [&bot_project.id])
            .unwrap();
        let plain = store.create_session(&project.id, "claude", "sonnet", "auto").unwrap();
        let full = store.create_session(&project.id, "claude", "sonnet", "full").unwrap();
        let bot_task = store.create_session(&bot_project.id, "claude", "sonnet", "auto").unwrap();
        assert!(check_target(&store, &plain.id, false, false).is_ok());
        assert!(check_target(&store, &full.id, true, false).is_err(), "Full-access threads still need the switch");
        assert_eq!(check_target(&store, &bot_task.id, false, true).unwrap_err(), super::super::super::host::BOT_THREAD_REFUSED);
        assert!(check_target(&store, &bot_task.id, true, false).is_ok());
        let _ = std::fs::remove_dir_all(&bot_home);
    }

    /// A schedule on a team lead would prompt it, and its workers run in full access.
    #[test]
    fn a_team_lead_is_scheduled_only_with_full_access_for_remote_tasks() {
        let store = crate::storage::Store::open(std::path::Path::new(":memory:")).unwrap();
        let project = store.add_project(&std::env::temp_dir()).unwrap();
        let lead = store.create_session(&project.id, "claude", "sonnet", "ask").unwrap();
        store.db.execute("INSERT INTO architect_teams(session_id,content) VALUES(?1,'{}')", [&lead.id]).unwrap();
        assert_eq!(check_target(&store, &lead.id, true, false).unwrap_err(), super::super::TEAM_NEEDS_FULL_ACCESS);
        assert!(check_target(&store, &lead.id, true, true).is_ok());
    }

    /// Round 21 source scan: runNow / setEnabled(true) and save check target and watch threads
    /// through `drivable_session_from`.
    #[test]
    fn schedules_check_bot_threads_where_they_send() {
        let source = include_str!("schedules.rs");
        let act = &source[source.find("async fn act_on").unwrap()..source.find("// ---- schedules.create").unwrap()];
        assert!(act.contains("device_from_has_full(ctx.app, ctx.from)"));
        assert!(act.contains("check_target(store, &schedule.session_id, device_full, full_access)?"));
        assert!(act.contains("drivable_session_from(store, watch, device_full, full_access)?"));
        let save = &source[source.find("async fn save(").unwrap()..];
        let save = &save[..save.find("\n}\n").unwrap()];
        assert!(save.contains("check_target(store, &target, device_full, full_access)?"));
        assert!(save.contains("drivable_session_from(store, watch, device_full, full_access)?"));
        let check = &source[source.find("fn check_target(").unwrap()..];
        assert!(check[..check.find("\n}\n").unwrap()].contains("drivable_session_from(store, session_id, device_full, full_access)?"));
    }
}
