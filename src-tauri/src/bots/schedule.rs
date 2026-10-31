//! Bot schedules and check-ins. Times are computed in the computer's local time zone
//! with plain arithmetic on a fixed UTC offset sampled at scheduling time, so a run
//! lands at the wall-clock time the user chose; the next run is recomputed after
//! every run, which absorbs daylight-saving changes. Overdue runs after a restart
//! run once, not once per missed slot.

use super::{gateway, Bot};
use crate::{storage::Store, AppState, Result};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{Emitter, Manager, State};

const MINUTE: i64 = 60_000;
const DAY: i64 = 24 * 60 * MINUTE;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Schedule {
    pub id: String,
    pub bot_id: String,
    pub title: String,
    pub prompt: String,
    pub kind: String,
    pub interval_minutes: Option<i64>,
    pub time_of_day: Option<String>,
    pub next_run_at: Option<i64>,
    pub last_run_at: Option<i64>,
    pub enabled: bool,
    pub created_by: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ScheduleInput {
    pub title: String,
    pub prompt: String,
    pub kind: String,
    pub interval_minutes: Option<i64>,
    pub time_of_day: Option<String>,
    /// For `once`: when to run, in ms.
    pub run_at: Option<i64>,
}

/// The local UTC offset in ms at `at`, from the operating system's time zone.
pub(crate) fn local_offset_ms(at: i64) -> i64 {
    use chrono::{Offset, TimeZone};
    chrono::Local.timestamp_millis_opt(at).single().map_or(0, |time| i64::from(time.offset().fix().local_minus_utc()) * 1000)
}

fn parse_time(text: &str) -> Option<i64> {
    let (hours, minutes) = text.trim().split_once(':')?;
    let (hours, minutes): (i64, i64) = (hours.parse().ok()?, minutes.parse().ok()?);
    ((0..24).contains(&hours) && (0..60).contains(&minutes)).then_some((hours * 60 + minutes) * MINUTE)
}

/// Next run strictly after `after`, given a fixed local offset.
pub(crate) fn next_run(kind: &str, interval_minutes: Option<i64>, time_of_day: Option<&str>, after: i64, offset: i64) -> Option<i64> {
    next_run_on(kind, interval_minutes, time_of_day, &[], after, offset)
}

/// Like `next_run`, plus `weekly`: at `time_of_day` on `days` (0 = Sunday).
pub(crate) fn next_run_on(kind: &str, interval_minutes: Option<i64>, time_of_day: Option<&str>, days: &[i64], after: i64, offset: i64) -> Option<i64> {
    match kind {
        "interval" => interval_minutes.filter(|m| (5..=7 * 24 * 60).contains(m)).map(|m| after + m * MINUTE),
        "daily" | "weekdays" | "weekly" => {
            let at = parse_time(time_of_day?)?;
            let local = after + offset;
            let mut day_start = local.div_euclid(DAY) * DAY;
            for _ in 0..8 {
                let candidate = day_start + at;
                // 1970-01-01 was a Thursday, so (days + 4) % 7 counts from Sunday.
                let weekday = (candidate.div_euclid(DAY) + 4).rem_euclid(7); // 0 = Sunday
                let weekend = weekday == 0 || weekday == 6;
                let allowed = match kind {
                    "daily" => true,
                    "weekdays" => !weekend,
                    _ => days.contains(&weekday),
                };
                if candidate > local && allowed {
                    return Some(candidate - offset);
                }
                day_start += DAY;
            }
            None
        }
        _ => None,
    }
}

/// Like `next_run_on`, but reads the offset again at the chosen slot, so a slot past a
/// daylight-saving change still lands on its wall-clock time. Bots keep `next_run`.
pub(crate) fn next_run_zoned(kind: &str, interval_minutes: Option<i64>, time_of_day: Option<&str>, days: &[i64], after: i64, offset_at: impl Fn(i64) -> i64) -> Option<i64> {
    let offset = offset_at(after);
    let first = next_run_on(kind, interval_minutes, time_of_day, days, after, offset)?;
    if kind == "interval" {
        return Some(first);
    }
    let adjusted = first + offset - offset_at(first);
    Some(if adjusted > after { adjusted } else { first })
}

pub(crate) fn heartbeat_after(minutes: i64, now: i64) -> Option<i64> {
    (minutes > 0).then(|| now + minutes * MINUTE)
}

fn row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Schedule> {
    Ok(Schedule {
        id: r.get(0)?,
        bot_id: r.get(1)?,
        title: r.get(2)?,
        prompt: r.get(3)?,
        kind: r.get(4)?,
        interval_minutes: r.get(5)?,
        time_of_day: r.get(6)?,
        next_run_at: r.get(7)?,
        last_run_at: r.get(8)?,
        enabled: r.get(9)?,
        created_by: r.get(10)?,
    })
}
const COLUMNS: &str = "id,bot_id,title,prompt,kind,interval_minutes,time_of_day,next_run_at,last_run_at,enabled,created_by";

pub(crate) fn list(store: &Store, bot_id: &str) -> Result<Vec<Schedule>> {
    let mut statement = store.db.prepare(&format!("SELECT {COLUMNS} FROM bot_schedules WHERE bot_id=?1 ORDER BY created_at")).map_err(|e| e.to_string())?;
    let rows = statement.query_map([bot_id], row).map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<_>>().map_err(|e| e.to_string())
}

fn get(store: &Store, id: &str) -> Result<Schedule> {
    store
        .db
        .query_row(&format!("SELECT {COLUMNS} FROM bot_schedules WHERE id=?1"), [id], row)
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "This schedule no longer exists.".into())
}

pub(crate) fn create(store: &Store, bot_id: &str, input: &ScheduleInput, created_by: &str, now: i64) -> Result<Schedule> {
    super::get(store, bot_id)?;
    let title = input.title.trim().chars().take(120).collect::<String>();
    let prompt = input.prompt.trim().chars().take(8000).collect::<String>();
    if prompt.is_empty() {
        return Err("A schedule needs a prompt: what should the bot do?".into());
    }
    let count: i64 = store.db.query_row("SELECT COUNT(*) FROM bot_schedules WHERE bot_id=?1", [bot_id], |r| r.get(0)).map_err(|e| e.to_string())?;
    if count >= 50 {
        return Err("A bot can have up to 50 schedules.".into());
    }
    let next = match input.kind.as_str() {
        "once" => input.run_at.filter(|at| *at > now - MINUTE && *at < now + 366 * DAY),
        kind @ ("interval" | "daily" | "weekdays") => next_run(kind, input.interval_minutes, input.time_of_day.as_deref(), now, local_offset_ms(now)),
        _ => return Err("Choose once, every N minutes, daily, or weekdays.".into()),
    }
    .ok_or("Check the schedule's time: intervals are 5 minutes to a week, times are HH:MM, one-off runs are within a year.")?;
    let id = crate::storage::id();
    store
        .db
        .execute(
            "INSERT INTO bot_schedules(id,bot_id,title,prompt,kind,interval_minutes,time_of_day,next_run_at,enabled,created_by,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,1,?9,?10)",
            params![id, bot_id, if title.is_empty() { prompt.chars().take(60).collect::<String>() } else { title }, prompt, input.kind, input.interval_minutes, input.time_of_day, next, created_by, now],
        )
        .map_err(|e| e.to_string())?;
    let schedule = get(store, &id)?;
    super::log(store, bot_id, "schedule", &format!("Scheduled: {}", schedule.title), json!({"scheduleId": id, "by": created_by}))?;
    Ok(schedule)
}

pub(crate) fn set_enabled(store: &Store, id: &str, enabled: bool, now: i64) -> Result<Schedule> {
    let schedule = get(store, id)?;
    let next = if enabled && schedule.kind != "once" {
        next_run(&schedule.kind, schedule.interval_minutes, schedule.time_of_day.as_deref(), now, local_offset_ms(now))
    } else {
        schedule.next_run_at
    };
    store.db.execute("UPDATE bot_schedules SET enabled=?2,next_run_at=?3 WHERE id=?1", params![id, enabled, next]).map_err(|e| e.to_string())?;
    get(store, id)
}

pub(crate) fn delete(store: &Store, bot_id: &str, id: &str) -> Result<()> {
    let removed = store.db.execute("DELETE FROM bot_schedules WHERE id=?1 AND bot_id=?2", params![id, bot_id]).map_err(|e| e.to_string())?;
    if removed == 0 {
        return Err("That schedule was already removed.".into());
    }
    super::log(store, bot_id, "schedule", "Removed a schedule", json!({"scheduleId": id}))
}

/// Due work: schedules whose time has come and bots whose check-in is due, for unpaused bots.
pub(crate) fn due(store: &Store, now: i64) -> Result<(Vec<Schedule>, Vec<Bot>)> {
    let mut statement = store
        .db
        .prepare(&format!("SELECT {COLUMNS} FROM bot_schedules WHERE enabled=1 AND next_run_at IS NOT NULL AND next_run_at<=?1 AND bot_id IN (SELECT id FROM bots WHERE paused=0) ORDER BY next_run_at LIMIT 20"))
        .map_err(|e| e.to_string())?;
    let schedules = statement.query_map([now], row).map_err(|e| e.to_string())?.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())?;
    let bots = super::list(store)?.into_iter().filter(|bot| !bot.paused && bot.heartbeat_minutes > 0 && bot.next_heartbeat_at.is_some_and(|at| at <= now)).collect();
    Ok((schedules, bots))
}

/// Moves a schedule past this run: one-off schedules finish, recurring ones skip missed slots.
pub(crate) fn advance(store: &Store, schedule: &Schedule, now: i64) -> Result<()> {
    let next = if schedule.kind == "once" { None } else { next_run(&schedule.kind, schedule.interval_minutes, schedule.time_of_day.as_deref(), now, local_offset_ms(now)) };
    store
        .db
        .execute("UPDATE bot_schedules SET last_run_at=?2,next_run_at=?3,enabled=CASE WHEN ?4 THEN 0 ELSE enabled END WHERE id=?1", params![schedule.id, now, next, schedule.kind == "once"])
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub(crate) fn advance_heartbeat(store: &Store, bot: &Bot, now: i64) -> Result<()> {
    store.db.execute("UPDATE bots SET next_heartbeat_at=?2 WHERE id=?1", params![bot.id, heartbeat_after(bot.heartbeat_minutes, now)]).map_err(|e| e.to_string())?;
    Ok(())
}

pub(crate) const HEARTBEAT_PROMPT: &str = "Check-in: review your standing goals and what you remember. Use read-only steps only (reading files, pages or connected data); do not send messages, change data or spend money without asking. If something needs the user's attention or a decision, say so briefly and propose the next step.";

/// Scheduler loop: every 30 seconds, start due schedules and check-ins as bot turns.
pub(crate) fn start(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(30));
        loop {
            tick.tick().await;
            let now = crate::storage::now();
            let due = {
                let state = app.state::<AppState>();
                let Ok(store) = state.store.lock() else { continue };
                let Ok(due) = due(&store, now) else { continue };
                for schedule in &due.0 {
                    let _ = advance(&store, schedule, now);
                }
                for bot in &due.1 {
                    let _ = advance_heartbeat(&store, bot, now);
                }
                due
            };
            for schedule in due.0 {
                let label = format!("Scheduled: {}", schedule.title);
                if let Err(error) = gateway::run_scheduled(&app, &schedule.bot_id, &label, &schedule.prompt).await {
                    super::note(&app, &schedule.bot_id, "error", &format!("{label} could not start: {error}"), json!({"scheduleId": schedule.id}));
                }
            }
            for bot in due.1 {
                let _ = gateway::run_scheduled(&app, &bot.id, "Check-in", HEARTBEAT_PROMPT).await;
            }
            let _ = app.emit("bots-changed", ());
        }
    });
}

#[tauri::command]
pub async fn bot_schedule_create(app: tauri::AppHandle, state: State<'_, AppState>, bot_id: String, input: ScheduleInput) -> Result<Schedule> {
    let schedule = create(&*state.store.lock().map_err(|e| e.to_string())?, &bot_id, &input, "user", crate::storage::now())?;
    let _ = app.emit("bots-changed", ());
    Ok(schedule)
}

#[tauri::command]
pub async fn bot_schedule_set_enabled(app: tauri::AppHandle, state: State<'_, AppState>, schedule_id: String, enabled: bool) -> Result<Schedule> {
    let schedule = set_enabled(&*state.store.lock().map_err(|e| e.to_string())?, &schedule_id, enabled, crate::storage::now())?;
    let _ = app.emit("bots-changed", ());
    Ok(schedule)
}

#[tauri::command]
pub async fn bot_schedule_delete(app: tauri::AppHandle, state: State<'_, AppState>, bot_id: String, schedule_id: String) -> Result<()> {
    delete(&*state.store.lock().map_err(|e| e.to_string())?, &bot_id, &schedule_id)?;
    let _ = app.emit("bots-changed", ());
    Ok(())
}

#[tauri::command]
pub async fn bot_run_schedule_now(app: tauri::AppHandle, state: State<'_, AppState>, schedule_id: String) -> Result<()> {
    let schedule = get(&*state.store.lock().map_err(|e| e.to_string())?, &schedule_id)?;
    gateway::run_scheduled(&app, &schedule.bot_id, &format!("Run now: {}", schedule.title), &schedule.prompt).await
}
