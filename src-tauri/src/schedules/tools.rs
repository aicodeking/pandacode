//! Agent tools for task schedules: wake this thread later, message another task in
//! the project later, list and cancel. Registered only while Settings allows agents
//! to schedule; messaging another task asks first unless the user turned that off.

use super::{cadence, create, get, select, settings, ScheduleInput, TaskSchedule};
use crate::agent_tools::{spec, validate_spec};
use crate::bots::schedule::{local_offset_ms, next_run_zoned};
use crate::providers::ToolHost;
use crate::{storage::Store, AppState, Result};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::collections::HashSet;
use std::sync::Arc;
use tauri::Manager;

/// Recurring agent schedules stop after this many runs unless they say otherwise (`after` ones after 1).
pub(crate) const AGENT_DEFAULT_MAX_RUNS: i64 = 20;
const MESSAGE: &str = "pandacode_schedule_message";

fn with_timing(extra: Value) -> Value {
    let mut properties = json!({
        "title": {"type":"string","maxLength":120,"description":"Short label shown in the schedule list."},
        "kind": {"type":"string","enum":["once","interval","daily","weekdays","weekly","after"],"description":"Inferred when omitted: afterTaskId → after, days → weekly, intervalMinutes → interval, timeOfDay → daily, else once."},
        "inMinutes": {"type":"integer","description":"once: minutes from now."},
        "at": {"type":"string","maxLength":40,"description":"once: RFC 3339, local YYYY-MM-DDTHH:MM, or local HH:MM (next occurrence)."},
        "intervalMinutes": {"type":"integer","description":"interval: 5 to 10080."},
        "timeOfDay": {"type":"string","maxLength":5,"description":"daily/weekdays/weekly: local HH:MM. Alone it means daily; use kind weekdays for Mon–Fri."},
        "days": {"type":"array","items":{"type":"integer","minimum":0,"maximum":6},"description":"weekly: days, 0 = Sunday."},
        "afterTaskId": {"type":"string","maxLength":64,"description":"after: fires when that thread's run ends (the current run counts if it is running); set maxRuns for repeats. IDs from pandacode_list_schedules."},
        "onlyOnSuccess": {"type":"boolean","description":"after: only when that run succeeded."},
        "maxRuns": {"type":"integer","description":"Stop after this many runs (1 to 1000). Default: after 1, other recurring 20."}
    });
    if let (Some(properties), Value::Object(extra)) = (properties.as_object_mut(), extra) {
        properties.extend(extra);
    }
    properties
}

pub(crate) fn catalog() -> Vec<Value> {
    let text = json!({"type":"string","maxLength":8000});
    let id = json!({"type":"string","maxLength":64});
    vec![
        spec("schedule_wakeup", "Wake THIS thread later with a note to yourself (check a deploy in 20 min, poll CI hourly, continue after another thread finishes). The note comes back as a user message when it fires, even after this turn ends. You cannot edit or pause a schedule: cancel and recreate it.", with_timing(json!({"note": text})), &["note"]),
        spec("schedule_message", "Send a message to ANOTHER thread in this project later, as if the user sent it. taskId comes from pandacode_list_schedules (tasks).", with_timing(json!({"taskId": id, "text": text})), &["taskId", "text"]),
        spec("list_schedules", "List schedules for this thread (default), another thread (taskId) or the whole project (project: true), with their last 5 runs, plus thisTaskId and the project's open tasks (IDs for taskId/afterTaskId).", json!({"taskId": id, "project": {"type":"boolean"}}), &[]),
        spec("cancel_schedule", "Delete a schedule by ID: only agent-set schedules that target this thread or that this thread created.", json!({"scheduleId": id}), &["scheduleId"]),
    ]
}

fn names() -> Vec<String> {
    catalog().iter().filter_map(|tool| tool["name"].as_str().map(str::to_owned)).collect()
}

/// Tools that only touch this thread's own schedules, so harnesses need not ask before them.
/// Claude-family harnesses check this beside `bots::tools::self_scoped` in `providers.rs`.
pub(crate) fn self_scoped(name: &str) -> bool {
    name != MESSAGE && names().iter().any(|known| known == name)
}

/// Adds schedule tools when Settings lets agents schedule; otherwise returns the host unchanged.
pub(crate) fn with_schedules(base: Option<ToolHost>, app: tauri::AppHandle, session_id: String, stopped: Arc<AtomicBool>) -> Option<ToolHost> {
    // Bot conversations schedule with bot_schedule instead.
    let found = app.state::<AppState>().store.lock().ok().and_then(|store| Some((settings(&store).ok()?, crate::bots::owner_of(&store, &session_id).ok()?.is_some())));
    let Some((settings, bot)) = found else { return base };
    if !settings.agents_may_schedule || bot {
        return base;
    }
    let mut tools = base.as_ref().map_or_else(Vec::new, |host| host.tools.clone());
    let mut approval_tools = base.as_ref().map_or_else(Default::default, |host| host.approval_tools.clone());
    if settings.ask_before_messaging_other_tasks {
        approval_tools.insert(MESSAGE.to_owned());
    }
    tools.extend(catalog());
    Some(ToolHost {
        tools,
        approval_tools,
        handler: Arc::new(move |name, args| {
            let (base, app, session_id, stopped) = (base.clone(), app.clone(), session_id.clone(), stopped.clone());
            Box::pin(async move {
                if stopped.load(Ordering::SeqCst) {
                    return Err("Task has stopped.".into());
                }
                if !names().contains(&name) {
                    return match base {
                        Some(base) => (base.handler)(name, args).await,
                        None => Err("Unknown PandaCode tool.".into()),
                    };
                }
                check_args(&name, &args)?;
                let state = app.state::<AppState>();
                let running: HashSet<String> = state.agents.lock().map_err(|e| e.to_string())?.keys().cloned().collect();
                let (result, changed) = {
                    let store = state.store.lock().map_err(|e| e.to_string())?;
                    dispatch(&store, &session_id, &name, &args, &running, crate::storage::now())?
                };
                if let Some(changed) = changed {
                    super::changed(&app, Some(&changed));
                }
                Ok(result)
            })
        }),
    })
}

/// `validate_spec` knows no arrays, so `days` is checked here.
fn check_args(name: &str, args: &Value) -> Result<()> {
    let mut rest = args.clone();
    if let Some(days) = rest.as_object_mut().and_then(|object| object.remove("days")) {
        if !days.as_array().is_some_and(|days| days.len() <= 7 && days.iter().all(|day| day.as_i64().is_some_and(|day| (0..=6).contains(&day)))) {
            return Err("Invalid argument: days (use 0 = Sunday to 6 = Saturday)".into());
        }
    }
    validate_spec(&catalog(), name, &rest)
}

/// The timing arguments as a schedule input (without target and message).
pub(crate) fn timing_input(args: &Value, now: i64) -> Result<ScheduleInput> {
    let string = |key: &str| args[key].as_str().map(str::trim).filter(|text| !text.is_empty()).map(str::to_owned);
    let watch = string("afterTaskId");
    let days = args["days"].as_array().map(|days| days.iter().filter_map(Value::as_i64).collect::<Vec<_>>()).unwrap_or_default();
    let kind = string("kind").unwrap_or_else(|| infer_kind(args, watch.is_some(), !days.is_empty()).into());
    let needs = |field: &str, what: &str| Err(format!("kind {kind} needs {field} ({what})."));
    match kind.as_str() {
        "interval" if args["intervalMinutes"].as_i64().is_none() => return needs("intervalMinutes", "5 to 10080"),
        "daily" | "weekdays" | "weekly" if string("timeOfDay").is_none() => return needs("timeOfDay", "local HH:MM"),
        "weekly" if days.is_empty() => return needs("days", "0 = Sunday to 6 = Saturday"),
        "after" if watch.is_none() => return needs("afterTaskId", "the thread whose run end fires it"),
        _ => {}
    }
    let run_at = if kind != "once" {
        None
    } else if let Some(minutes) = args["inMinutes"].as_i64() {
        Some(now + minutes.clamp(1, 366 * 24 * 60) * 60_000)
    } else if let Some(at) = string("at") {
        Some(parse_at(&at, now).ok_or("Use an RFC 3339 time, local YYYY-MM-DDTHH:MM, or local HH:MM for at.")?)
    } else {
        return Err("kind once needs inMinutes or at; for repeats give intervalMinutes, timeOfDay (with days for weekly) or afterTaskId.".into());
    };
    Ok(ScheduleInput {
        title: string("title").unwrap_or_default(),
        kind,
        interval_minutes: args["intervalMinutes"].as_i64(),
        time_of_day: string("timeOfDay"),
        days,
        run_at,
        watch_session_id: watch,
        only_on_success: args["onlyOnSuccess"].as_bool().unwrap_or(false),
        max_runs: args["maxRuns"].as_i64(),
        ..Default::default()
    })
}

/// The kind the timing arguments imply when `kind` is left out.
fn infer_kind(args: &Value, after: bool, days: bool) -> &'static str {
    if after {
        "after"
    } else if days {
        "weekly"
    } else if args["intervalMinutes"].is_i64() {
        "interval"
    } else if args["timeOfDay"].as_str().is_some_and(|time| !time.trim().is_empty()) {
        "daily"
    } else {
        "once"
    }
}

/// How a new schedule ends, for the agent: "runs once" or "stops after N runs; …".
fn stops_after(schedule: &TaskSchedule) -> String {
    match (schedule.kind.as_str(), schedule.max_runs) {
        ("once", _) | (_, Some(1)) => "runs once; pass maxRuns for repeats".into(),
        (_, Some(runs)) => format!("stops after {runs} runs; pass maxRuns up to 1000 to keep going"),
        (_, None) => "runs until cancelled".into(),
    }
}

/// RFC 3339, a naive local date and time, or a local HH:MM (its next occurrence).
pub(crate) fn parse_at(at: &str, now: i64) -> Option<i64> {
    use chrono::TimeZone;
    if let Ok(time) = chrono::DateTime::parse_from_rfc3339(at) {
        return Some(time.timestamp_millis());
    }
    let naive = ["%Y-%m-%dT%H:%M", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M"].iter().find_map(|format| chrono::NaiveDateTime::parse_from_str(at, format).ok());
    if let Some(naive) = naive {
        return chrono::Local.from_local_datetime(&naive).earliest().map(|time| time.timestamp_millis());
    }
    next_run_zoned("daily", None, Some(at), &[], now, local_offset_ms)
}

fn local(at: Option<i64>) -> Option<String> {
    use chrono::TimeZone;
    chrono::Local.timestamp_millis_opt(at?).single().map(|time| time.format("%a %b %-d %Y %H:%M (UTC%:z)").to_string())
}

fn describe(store: &Store, schedule: &TaskSchedule, with_runs: bool) -> Result<Value> {
    let next = local(schedule.next_run_at).unwrap_or_else(|| if schedule.enabled && schedule.kind == "after" { "when the watched thread's run ends".into() } else { "none".into() });
    let mut value = json!({"id": schedule.id, "cadence": cadence(schedule), "nextRunLocal": next, "schedule": schedule});
    if with_runs {
        value["lastRuns"] = json!(super::runs(store, None, Some(&schedule.id), 5)?);
    }
    Ok(value)
}

/// Runs one schedule tool for `session_id`; returns the result and the thread whose list changed.
pub(crate) fn dispatch(store: &Store, session_id: &str, name: &str, args: &Value, running: &HashSet<String>, now: i64) -> Result<(Value, Option<String>)> {
    let (mut result, changed) = run(store, session_id, name, args, running, now)?;
    result["nowLocal"] = json!(local(Some(now)));
    Ok((result, changed))
}

/// The project's open tasks, newest first, so agents can find IDs for taskId/afterTaskId.
fn tasks(store: &Store, project_id: &str, running: &HashSet<String>) -> Result<Vec<Value>> {
    let mut statement = store
        .db
        .prepare("SELECT id,title FROM sessions WHERE project_id=?1 AND archived=0 AND draft=0 AND id NOT IN (SELECT session_id FROM architect_workers) ORDER BY updated_at DESC LIMIT 50")
        .map_err(|e| e.to_string())?;
    let rows = statement.query_map([project_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).map_err(|e| e.to_string())?;
    rows.map(|row| row.map(|(id, title)| json!({"id": id, "title": title, "running": running.contains(&id)})).map_err(|e| e.to_string())).collect()
}

fn run(store: &Store, session_id: &str, name: &str, args: &Value, running: &HashSet<String>, now: i64) -> Result<(Value, Option<String>)> {
    let me = store.session(session_id)?;
    let string = |key: &str| args[key].as_str().unwrap_or_default().trim().to_owned();
    let same_project = |id: &str| -> Result<crate::storage::Session> {
        let task = store.session(id).map_err(|_| String::from("No thread with that ID; find IDs in pandacode_list_schedules (tasks)."))?;
        if task.project_id != me.project_id {
            return Err("That thread is in another project; schedules stay within this project.".into());
        }
        Ok(task)
    };
    match name {
        "pandacode_schedule_wakeup" | MESSAGE => {
            let target = if name == MESSAGE {
                let task = same_project(&string("taskId"))?;
                if task.id == me.id {
                    return Err("Use pandacode_schedule_wakeup to wake this thread.".into());
                }
                task.id
            } else {
                if string("afterTaskId") == me.id {
                    return Err("afterTaskId is this thread, which would wake on its own turn end; pick another thread.".into());
                }
                me.id.clone()
            };
            let limit = settings(store)?.agent_limit_per_task;
            let active: i64 = store
                .db
                .query_row("SELECT COUNT(*) FROM task_schedules WHERE enabled=1 AND created_by='agent' AND created_by_session=?1", [&me.id], |r| r.get(0))
                .map_err(|e| e.to_string())?;
            if active >= limit {
                return Err(format!("This thread already has {active} active schedules (limit {limit}). Cancel one with pandacode_cancel_schedule first."));
            }
            let mut input = timing_input(args, now)?;
            input.session_id = target;
            input.prompt = string(if name == MESSAGE { "text" } else { "note" });
            if input.max_runs.is_none() {
                input.max_runs = match input.kind.as_str() {
                    "once" => None,
                    "after" => Some(1),
                    _ => Some(AGENT_DEFAULT_MAX_RUNS),
                };
            }
            let schedule = create(store, &input, "agent", Some(&me.id), now)?;
            let mut scheduled = describe(store, &schedule, false)?;
            scheduled["stopsAfter"] = json!(stops_after(&schedule));
            Ok((json!({"scheduled": scheduled}), Some(schedule.session_id)))
        }
        "pandacode_list_schedules" => {
            let mut schedules = if args["project"] == true {
                select(store, "s.project_id=?1", [&me.project_id])?
            } else if !string("taskId").is_empty() {
                super::list(store, Some(&same_project(&string("taskId"))?.id))?
            } else {
                select(store, "(t.session_id=?1 OR t.created_by_session=?1)", [&me.id])?
            };
            schedules.truncate(50);
            let listed = schedules.iter().map(|schedule| describe(store, schedule, true)).collect::<Result<Vec<_>>>()?;
            Ok((json!({"schedules": listed, "thisTaskId": me.id, "tasks": tasks(store, &me.project_id, running)?}), None))
        }
        "pandacode_cancel_schedule" => {
            let schedule = get(store, &string("scheduleId")).map_err(|_| String::from("No schedule with that ID; list them with pandacode_list_schedules."))?;
            let mine = schedule.session_id == me.id || schedule.created_by_session.as_deref() == Some(me.id.as_str());
            if schedule.project_id != me.project_id || !mine {
                return Err("You can cancel only schedules that target this thread or that this thread created.".into());
            }
            if schedule.created_by != "agent" {
                return Err("The user set this schedule. Ask the user to remove it in Settings → Schedules.".into());
            }
            super::delete(store, &schedule.id)?;
            Ok((json!({"cancelled": schedule.id, "title": schedule.title}), Some(schedule.session_id)))
        }
        _ => Err("Unknown PandaCode tool.".into()),
    }
}
