//! Task schedules: wake-ups and timed messages that agents or the user set for any
//! thread. The IPC contract is `src/schedules-api.ts`. Clock times reuse the bot
//! scheduler's local-time arithmetic (`bots::schedule::next_run_zoned`). Overdue runs
//! after a restart fire once, not once per missed slot; a paused scheduler leaves
//! due runs due.

mod cron;
mod firing;
pub(crate) mod tools;
#[cfg(test)]
mod tests;

use crate::bots::schedule::{local_offset_ms, next_run_zoned};
use crate::{storage::Store, AppState, Result};
pub(crate) use firing::{run_finished, start};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{Emitter, State};

/// First line of the trace block a fired schedule appends to its message.
pub const TRACE_HEADER: &str = "Scheduled wake-up (PandaCode scheduler)";
const MINUTE: i64 = 60_000;
const DAY: i64 = 24 * 60 * MINUTE;
const RUNS_PER_SESSION: i64 = 200;
/// An `after` schedule waits at least this long after its previous run.
const AFTER_GAP: i64 = 30_000;
const FAILURE_LIMIT: i64 = 3;
const TICK_SECONDS: u64 = 15;
const KINDS: &str = "Choose once, interval, daily, weekdays, weekly, cron or after.";

pub(crate) const TABLE: &str = "
CREATE TABLE IF NOT EXISTS task_schedules(id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  title TEXT NOT NULL, prompt TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('once','interval','daily','weekdays','weekly','after','cron')),
  interval_minutes INTEGER, time_of_day TEXT, days TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(days)),
  watch_session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  only_on_success INTEGER NOT NULL DEFAULT 0, next_run_at INTEGER, last_run_at INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1, created_by TEXT NOT NULL CHECK(created_by IN ('user','agent')),
  created_by_session TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  run_count INTEGER NOT NULL DEFAULT 0, max_runs INTEGER, consecutive_failures INTEGER NOT NULL DEFAULT 0,
  trigger_ok INTEGER, workflow_id TEXT, chain_from_id TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, cron TEXT, timezone TEXT);";
pub(crate) const INDEXES: &str = "
CREATE INDEX IF NOT EXISTS task_schedules_due ON task_schedules(enabled,next_run_at);
CREATE INDEX IF NOT EXISTS task_schedules_session ON task_schedules(session_id);
CREATE INDEX IF NOT EXISTS task_schedules_watch ON task_schedules(watch_session_id);
CREATE INDEX IF NOT EXISTS task_schedules_workflow ON task_schedules(workflow_id);";
const RUNS: &str = "
CREATE TABLE IF NOT EXISTS task_schedule_runs(id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, title TEXT NOT NULL, at INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('started','queued','skipped','failed')), detail TEXT NOT NULL DEFAULT '',
  sequence INTEGER NOT NULL, manual INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS task_schedule_runs_session ON task_schedule_runs(session_id,at DESC);
CREATE INDEX IF NOT EXISTS task_schedule_runs_schedule ON task_schedule_runs(schedule_id,at DESC);
CREATE TABLE IF NOT EXISTS scheduler_settings(id INTEGER PRIMARY KEY CHECK(id=1), content TEXT NOT NULL CHECK(json_valid(content)));";
/// The table and its indexes, for a fresh database (the 37 migration adds the
/// `cron` and `timezone` columns to older ones and rebuilds the kind CHECK).
pub(crate) fn schema() -> String {
    format!("{TABLE}{INDEXES}{RUNS}")
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TaskSchedule {
    pub id: String,
    pub session_id: String,
    pub session_title: String,
    pub project_id: String,
    pub project_name: String,
    pub title: String,
    pub prompt: String,
    pub kind: String,
    pub interval_minutes: Option<i64>,
    pub time_of_day: Option<String>,
    pub days: Vec<i64>,
    /// For `cron`: the five-field expression.
    pub cron: Option<String>,
    /// IANA timezone for the clock kinds; None = this computer's local zone.
    pub timezone: Option<String>,
    pub watch_session_id: Option<String>,
    pub watch_session_title: Option<String>,
    pub only_on_success: bool,
    pub next_run_at: Option<i64>,
    pub last_run_at: Option<i64>,
    pub enabled: bool,
    pub created_by: String,
    pub created_by_session: Option<String>,
    pub run_count: i64,
    pub max_runs: Option<i64>,
    /// Groups the steps of one workflow.
    pub workflow_id: Option<String>,
    /// For a workflow `after` step: the step whose run must come first.
    pub chain_from_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    /// Title of the thread that created it (for the trace), not part of the IPC type.
    #[serde(skip)]
    pub created_by_title: Option<String>,
    /// For a pending `after` run: whether the watched run succeeded.
    #[serde(skip)]
    pub trigger_ok: Option<bool>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleRun {
    pub id: String,
    pub schedule_id: String,
    pub session_id: String,
    pub title: String,
    pub at: i64,
    pub outcome: String,
    pub detail: String,
    pub sequence: i64,
    pub manual: bool,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ScheduleInput {
    pub session_id: String,
    pub title: String,
    pub prompt: String,
    pub kind: String,
    pub interval_minutes: Option<i64>,
    pub time_of_day: Option<String>,
    pub days: Vec<i64>,
    /// For `cron`: the five-field expression.
    pub cron: Option<String>,
    /// IANA timezone for the clock kinds; None/empty = this computer's local zone.
    pub timezone: Option<String>,
    pub run_at: Option<i64>,
    pub watch_session_id: Option<String>,
    pub only_on_success: bool,
    pub max_runs: Option<i64>,
    pub workflow_id: Option<String>,
    pub chain_from_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct SchedulerSettings {
    pub agents_may_schedule: bool,
    pub ask_before_messaging_other_tasks: bool,
    pub paused: bool,
    pub agent_limit_per_task: i64,
}

impl Default for SchedulerSettings {
    fn default() -> Self {
        Self { agents_may_schedule: true, ask_before_messaging_other_tasks: true, paused: false, agent_limit_per_task: 10 }
    }
}

pub(crate) fn settings(store: &Store) -> Result<SchedulerSettings> {
    let content: Option<String> = store.db.query_row("SELECT content FROM scheduler_settings WHERE id=1", [], |r| r.get(0)).optional().map_err(|e| e.to_string())?;
    Ok(content.and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_default())
}

pub(crate) fn set_settings(store: &Store, settings: &SchedulerSettings) -> Result<SchedulerSettings> {
    if !(0..=100).contains(&settings.agent_limit_per_task) {
        return Err("The per-thread agent limit must be 0 to 100.".into());
    }
    let content = serde_json::to_string(settings).map_err(|e| e.to_string())?;
    store.db.execute("INSERT INTO scheduler_settings(id,content) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET content=excluded.content", [content]).map_err(|e| e.to_string())?;
    self::settings(store)
}

const COLUMNS: &str = "t.id,t.session_id,s.title,s.project_id,p.name,t.title,t.prompt,t.kind,t.interval_minutes,t.time_of_day,t.days,t.watch_session_id,w.title,t.only_on_success,t.next_run_at,t.last_run_at,t.enabled,t.created_by,t.created_by_session,t.run_count,t.max_runs,t.created_at,t.updated_at,c.title,t.trigger_ok,t.workflow_id,t.chain_from_id,t.cron,t.timezone";
const FROM: &str = "FROM task_schedules t JOIN sessions s ON s.id=t.session_id JOIN projects p ON p.id=s.project_id LEFT JOIN sessions w ON w.id=t.watch_session_id LEFT JOIN sessions c ON c.id=t.created_by_session";

fn row(r: &rusqlite::Row<'_>) -> rusqlite::Result<TaskSchedule> {
    Ok(TaskSchedule {
        id: r.get(0)?,
        session_id: r.get(1)?,
        session_title: r.get(2)?,
        project_id: r.get(3)?,
        project_name: r.get(4)?,
        title: r.get(5)?,
        prompt: r.get(6)?,
        kind: r.get(7)?,
        interval_minutes: r.get(8)?,
        time_of_day: r.get(9)?,
        days: serde_json::from_str(&r.get::<_, String>(10)?).unwrap_or_default(),
        watch_session_id: r.get(11)?,
        watch_session_title: r.get(12)?,
        only_on_success: r.get(13)?,
        next_run_at: r.get(14)?,
        last_run_at: r.get(15)?,
        enabled: r.get(16)?,
        created_by: r.get(17)?,
        created_by_session: r.get(18)?,
        run_count: r.get(19)?,
        max_runs: r.get(20)?,
        created_at: r.get(21)?,
        updated_at: r.get(22)?,
        created_by_title: r.get(23)?,
        trigger_ok: r.get(24)?,
        workflow_id: r.get(25)?,
        chain_from_id: r.get(26)?,
        cron: r.get(27)?,
        timezone: r.get(28)?,
    })
}

/// Schedules matching `filter` (SQL over `t`, `s`, `w`), soonest first, never-due last.
pub(crate) fn select(store: &Store, filter: &str, args: impl rusqlite::Params) -> Result<Vec<TaskSchedule>> {
    let sql = format!("SELECT {COLUMNS} {FROM} WHERE {filter} ORDER BY t.next_run_at IS NULL, t.next_run_at, t.created_at, t.id");
    let mut statement = store.db.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = statement.query_map(args, row).map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<_>>().map_err(|e| e.to_string())
}

pub(crate) fn list(store: &Store, session_id: Option<&str>) -> Result<Vec<TaskSchedule>> {
    select(store, "(?1 IS NULL OR t.session_id=?1)", [session_id])
}

pub(crate) fn get(store: &Store, id: &str) -> Result<TaskSchedule> {
    select(store, "t.id=?1", [id])?.pop().ok_or_else(|| "This schedule no longer exists.".into())
}

/// The next clock slot after `after`: interval and daily/weekly arithmetic recheck the
/// offset at the slot in the schedule's timezone (local when unset); cron scans the
/// expression in it.
fn next_slot(kind: &str, interval_minutes: Option<i64>, time_of_day: Option<&str>, days: &[i64], cron: Option<&str>, timezone: Option<&str>, after: i64) -> Option<i64> {
    if kind == "cron" {
        let expr = cron::parse(cron?);
        return expr.and_then(|expr| cron::cron_next_fire(&expr, timezone.unwrap_or_default(), after));
    }
    next_run_zoned(kind, interval_minutes, time_of_day, days, after, |at| zone_offset(timezone, at))
}

/// The UTC offset in ms at `at` in `timezone` (an IANA name); unset falls back to the
/// computer's zone.
fn zone_offset(timezone: Option<&str>, at: i64) -> i64 {
    match timezone.and_then(|name| name.parse::<chrono_tz::Tz>().ok()) {
        Some(tz) => offset_ms(tz, at),
        None => local_offset_ms(at),
    }
}

fn offset_ms<T: chrono::TimeZone>(tz: T, at: i64) -> i64 {
    use chrono::Offset;
    tz.timestamp_millis_opt(at).single().map_or(0, |time| i64::from(time.offset().fix().local_minus_utc()) * 1000)
}

/// Whether an `after` schedule waking `target` when `watch` ends would come back round to
/// `watch` through enabled `after` schedules (ignoring `exclude`, the one being edited).
fn would_loop(store: &Store, target: &str, watch: &str, exclude: Option<&str>) -> Result<bool> {
    store
        .db
        .query_row(
            "WITH RECURSIVE reach(id) AS (SELECT ?1 UNION SELECT t.session_id FROM task_schedules t JOIN reach r ON t.watch_session_id=r.id WHERE t.enabled=1 AND t.kind='after' AND t.id IS NOT ?3)
             SELECT EXISTS(SELECT 1 FROM reach WHERE id=?2)",
            params![target, watch, exclude],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())
}

fn loop_error(watch: &str, target: &str) -> String {
    format!("This would loop: “{target}” runs after “{watch}”, and its own schedules lead back to “{watch}”.")
}

/// A validated input: normalized fields plus the first run.
#[derive(Debug)]
struct Plan {
    input: ScheduleInput,
    next_run_at: Option<i64>,
}

fn time_of_day(text: Option<&str>) -> Result<String> {
    text.map(str::trim)
        .and_then(|text| text.split_once(':'))
        .filter(|(hours, minutes)| (1..=2).contains(&hours.len()) && minutes.len() == 2)
        .and_then(|(hours, minutes)| Some((hours.parse::<u32>().ok()?, minutes.parse::<u32>().ok()?)))
        .filter(|(hours, minutes)| *hours < 24 && *minutes < 60)
        .map(|(hours, minutes)| format!("{hours:02}:{minutes:02}"))
        .ok_or_else(|| "Use a 24-hour local time like 09:30.".into())
}

/// The schedule's IANA timezone for the clock kinds: empty means this computer's zone
/// (today's behaviour). The canonical name is stored, so the UI round-trips it.
fn timezone(text: Option<&str>) -> Result<Option<String>> {
    let text = text.map(str::trim).unwrap_or_default();
    if text.is_empty() {
        return Ok(None);
    }
    let zone: chrono_tz::Tz = text.parse().map_err(|_| format!("Unknown timezone: {text}."))?;
    Ok(Some(zone.name().to_owned()))
}

fn validate(store: &Store, input: &ScheduleInput, existing: Option<&str>, now: i64) -> Result<Plan> {
    let target = store.session(&input.session_id).map_err(|_| String::from("That thread no longer exists."))?;
    if target.draft {
        return Err("Send this thread's first message before scheduling it.".into());
    }
    let prompt = input.prompt.trim().to_owned();
    if prompt.is_empty() {
        return Err("Write the message the thread should be sent.".into());
    }
    if prompt.chars().count() > 8000 {
        return Err("Keep the message under 8000 characters.".into());
    }
    let title = input.title.trim();
    if title.chars().count() > 120 {
        return Err("Keep the title under 120 characters.".into());
    }
    let title = if title.is_empty() { prompt.lines().next().unwrap_or_default().chars().take(60).collect() } else { title.to_owned() };
    if input.max_runs.is_some_and(|runs| !(1..=1000).contains(&runs)) {
        return Err("Max runs must be 1 to 1000, or empty to run until removed.".into());
    }
    let mut plan = ScheduleInput { session_id: target.id.clone(), title, prompt, kind: input.kind.clone(), max_runs: input.max_runs, ..Default::default() };
    let next_run_at = match input.kind.as_str() {
        "once" => {
            let at = input.run_at.ok_or("Pick when the one-off run should happen.")?;
            if at < now - MINUTE {
                return Err("That time has already passed.".into());
            }
            if at > now + 366 * DAY {
                return Err("Schedule one-off runs within a year.".into());
            }
            Some(at.max(now))
        }
        "interval" => {
            let minutes = input.interval_minutes.filter(|m| (5..=7 * 24 * 60).contains(m)).ok_or("Intervals are 5 minutes to 7 days (10080 minutes).")?;
            plan.interval_minutes = Some(minutes);
            Some(now + minutes * MINUTE)
        }
        kind @ ("daily" | "weekdays" | "weekly") => {
            let time = time_of_day(input.time_of_day.as_deref())?;
            if kind == "weekly" {
                if input.days.is_empty() {
                    return Err("Pick at least one day for a weekly schedule.".into());
                }
                if input.days.iter().any(|day| !(0..=6).contains(day)) {
                    return Err("Days are 0 (Sunday) to 6 (Saturday).".into());
                }
                let mut days = input.days.clone();
                days.sort_unstable();
                days.dedup();
                plan.days = days;
            }
            plan.timezone = timezone(input.timezone.as_deref())?;
            let next = next_slot(kind, None, Some(&time), &plan.days, None, plan.timezone.as_deref(), now);
            plan.time_of_day = Some(time);
            Some(next.ok_or("Could not find the next run for that time.")?)
        }
        "cron" => {
            let expr = input
                .cron
                .as_deref()
                .map(str::trim)
                .filter(|expr| !expr.is_empty())
                .ok_or("Write a cron expression: five fields (minute hour day-of-month month day-of-week).")?;
            let parsed = cron::parse_cron(expr)?;
            plan.timezone = timezone(input.timezone.as_deref())?;
            plan.cron = Some(expr.to_owned());
            let next = cron::cron_next_fire(&parsed, plan.timezone.as_deref().unwrap_or_default(), now);
            Some(next.ok_or("Could not find the next run for that cron expression.")?)
        }
        "after" => {
            let watch_id = input.watch_session_id.as_deref().filter(|id| !id.is_empty()).ok_or("Pick the thread whose run should trigger this one.")?;
            let watch = store.session(watch_id).map_err(|_| String::from("The thread to watch no longer exists."))?;
            if watch.id == target.id {
                return Err("A thread cannot wake itself after its own run; pick another thread to watch.".into());
            }
            if watch.project_id != target.project_id {
                return Err("The thread to watch must be in the same project.".into());
            }
            if watch.draft {
                return Err("The thread to watch has not started yet.".into());
            }
            if would_loop(store, &target.id, &watch.id, existing)? {
                return Err(loop_error(&watch.title, &target.title));
            }
            plan.watch_session_id = Some(watch.id);
            plan.only_on_success = input.only_on_success;
            None
        }
        _ => return Err(KINDS.into()),
    };
    plan.workflow_id = input.workflow_id.as_deref().map(str::trim).filter(|id| !id.is_empty()).map(str::to_owned);
    if plan.workflow_id.as_ref().is_some_and(|id| id.chars().count() > 64) {
        return Err("Keep the workflow ID under 64 characters.".into());
    }
    plan.chain_from_id = match input.chain_from_id.as_deref().map(str::trim).filter(|id| !id.is_empty()) {
        None => None,
        Some(id) => Some(chain_from(store, &plan, &target.project_id, id, existing)?),
    };
    Ok(Plan { input: plan, next_run_at })
}

/// Checks a workflow step's predecessor: an existing schedule in the same project whose
/// thread is the one this `after` step watches.
fn chain_from(store: &Store, plan: &ScheduleInput, project_id: &str, id: &str, existing: Option<&str>) -> Result<String> {
    if plan.kind != "after" {
        return Err("Only an after schedule can follow another step.".into());
    }
    if Some(id) == existing {
        return Err("A step cannot follow itself.".into());
    }
    let before = get(store, id).map_err(|_| String::from("The step this one follows no longer exists."))?;
    if before.project_id != project_id {
        return Err("The step this one follows must be in the same project.".into());
    }
    if plan.watch_session_id.as_deref() != Some(before.session_id.as_str()) {
        return Err("A step must watch the thread its previous step wakes.".into());
    }
    Ok(before.id)
}

pub(crate) fn create(store: &Store, input: &ScheduleInput, created_by: &str, created_by_session: Option<&str>, now: i64) -> Result<TaskSchedule> {
    let Plan { input, next_run_at } = validate(store, input, None, now)?;
    let id = crate::storage::id();
    store
        .db
        .execute(
            "INSERT INTO task_schedules(id,session_id,title,prompt,kind,interval_minutes,time_of_day,days,watch_session_id,only_on_success,next_run_at,enabled,created_by,created_by_session,max_runs,created_at,updated_at,workflow_id,chain_from_id,cron,timezone)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,1,?12,?13,?14,?15,?15,?16,?17,?18,?19)",
            params![id, input.session_id, input.title, input.prompt, input.kind, input.interval_minutes, input.time_of_day, json!(input.days).to_string(), input.watch_session_id, input.only_on_success, next_run_at, created_by, created_by_session, input.max_runs, now, input.workflow_id, input.chain_from_id, input.cron, input.timezone],
        )
        .map_err(|e| e.to_string())?;
    get(store, &id)
}

pub(crate) fn update(store: &Store, id: &str, input: &ScheduleInput, now: i64) -> Result<TaskSchedule> {
    let before = get(store, id)?;
    if input.max_runs.is_some_and(|max| max <= before.run_count) {
        return Err(format!("This schedule has already run {} times; set Max runs above that, or leave it empty.", before.run_count));
    }
    let Plan { input, next_run_at } = validate(store, input, Some(id), now)?;
    store
        .db
        .execute(
            "UPDATE task_schedules SET session_id=?2,title=?3,prompt=?4,kind=?5,interval_minutes=?6,time_of_day=?7,days=?8,watch_session_id=?9,only_on_success=?10,next_run_at=?11,max_runs=?12,updated_at=?13,workflow_id=?14,chain_from_id=?15,cron=?16,timezone=?17 WHERE id=?1",
            params![id, input.session_id, input.title, input.prompt, input.kind, input.interval_minutes, input.time_of_day, json!(input.days).to_string(), input.watch_session_id, input.only_on_success, next_run_at, input.max_runs, now, input.workflow_id, input.chain_from_id, input.cron, input.timezone],
        )
        .map_err(|e| e.to_string())?;
    get(store, id)
}

fn exhausted(schedule: &TaskSchedule) -> bool {
    schedule.max_runs.is_some_and(|max| schedule.run_count >= max)
}

pub(crate) fn set_enabled(store: &Store, id: &str, enabled: bool, now: i64) -> Result<TaskSchedule> {
    let schedule = get(store, id)?;
    let next = if !enabled {
        schedule.next_run_at
    } else if exhausted(&schedule) {
        return Err("This schedule has used all its runs. Raise Max runs to turn it on.".into());
    } else {
        match schedule.kind.as_str() {
            "once" => Some(schedule.next_run_at.filter(|at| *at >= now - MINUTE).ok_or("This one-off run has passed. Edit it to pick a new time.")?),
            "after" => {
                let watch = schedule.watch_session_id.as_deref().unwrap_or_default();
                if would_loop(store, &schedule.session_id, watch, Some(id))? {
                    return Err(loop_error(schedule.watch_session_title.as_deref().unwrap_or("a task"), &schedule.session_title));
                }
                None
            }
            kind => next_slot(kind, schedule.interval_minutes, schedule.time_of_day.as_deref(), &schedule.days, schedule.cron.as_deref(), schedule.timezone.as_deref(), now),
        }
    };
    store
        .db
        .execute("UPDATE task_schedules SET enabled=?2,next_run_at=?3,consecutive_failures=CASE WHEN ?2 THEN 0 ELSE consecutive_failures END,updated_at=?4 WHERE id=?1", params![id, enabled, next, now])
        .map_err(|e| e.to_string())?;
    get(store, id)
}

pub(crate) fn delete(store: &Store, id: &str) -> Result<TaskSchedule> {
    let schedule = get(store, id)?;
    store.db.execute("DELETE FROM task_schedules WHERE id=?1", [id]).map_err(|e| e.to_string())?;
    Ok(schedule)
}

pub(crate) fn snooze(store: &Store, id: &str, minutes: i64, now: i64) -> Result<TaskSchedule> {
    if !(1..=7 * 24 * 60).contains(&minutes) {
        return Err("Snooze for 1 minute to 7 days.".into());
    }
    let schedule = get(store, id)?;
    let next = schedule.next_run_at.filter(|_| schedule.enabled).ok_or("This schedule has no upcoming run to snooze.")?;
    store.db.execute("UPDATE task_schedules SET next_run_at=?2,updated_at=?3 WHERE id=?1", params![id, next.max(now) + minutes * MINUTE, now]).map_err(|e| e.to_string())?;
    get(store, id)
}

/// Enabled clock schedules whose time has come, unless the scheduler is paused.
pub(crate) fn due(store: &Store, now: i64) -> Result<Vec<TaskSchedule>> {
    if settings(store)?.paused {
        return Ok(Vec::new());
    }
    let mut due = select(store, "t.enabled=1 AND t.next_run_at IS NOT NULL AND t.next_run_at<=?1 AND (t.max_runs IS NULL OR t.run_count<t.max_runs)", [now])?;
    due.truncate(20);
    Ok(due)
}

/// Marks the `after` schedules watching `session_id` due, for the clock loop to fire. A
/// paused scheduler holds them, and quick repeat finishes coalesce into one pending run.
/// A workflow step (`chain_from_id`) arms only when its previous step has run since it
/// last did and the watched thread has taken a prompt since (a step queued behind a busy
/// turn waits for the turn that reads it), so it runs once per pass, never on an unrelated turn end.
pub(crate) fn trigger(store: &Store, session_id: &str, successful: bool, now: i64) -> Result<usize> {
    store
        .db
        .execute(
            "UPDATE task_schedules SET next_run_at=COALESCE(next_run_at,MAX(?3,COALESCE(last_run_at,0)+?4)),trigger_ok=?2,updated_at=?3
             WHERE enabled=1 AND kind='after' AND watch_session_id=?1 AND (only_on_success=0 OR ?2) AND (max_runs IS NULL OR run_count<max_runs)
               AND (chain_from_id IS NULL OR ((SELECT p.last_run_at FROM task_schedules p WHERE p.id=task_schedules.chain_from_id)>COALESCE(last_run_at,0)
                 AND (SELECT MAX(created_at) FROM messages WHERE session_id=?1 AND role='user')>=(SELECT p.last_run_at FROM task_schedules p WHERE p.id=task_schedules.chain_from_id)))",
            params![session_id, successful, now, AFTER_GAP],
        )
        .map_err(|e| e.to_string())
}

/// Moves a schedule past this run before it fires: counts the run, finds the next slot
/// (skipping missed ones), and turns off one-off and used-up schedules. A manual run
/// keeps the next clock slot.
pub(crate) fn advance(store: &Store, schedule: &TaskSchedule, now: i64, manual: bool) -> Result<TaskSchedule> {
    let runs = schedule.run_count + 1;
    let finished = schedule.kind == "once" || schedule.max_runs.is_some_and(|max| runs >= max);
    let next = match schedule.kind.as_str() {
        _ if finished => None,
        // Run now leaves a pending trigger (or the next clock slot) in place.
        _ if manual => schedule.next_run_at,
        "after" => None,
        kind => next_slot(kind, schedule.interval_minutes, schedule.time_of_day.as_deref(), &schedule.days, schedule.cron.as_deref(), schedule.timezone.as_deref(), now),
    };
    store
        .db
        .execute(
            "UPDATE task_schedules SET run_count=?2,last_run_at=?3,next_run_at=?4,enabled=CASE WHEN ?5 THEN 0 ELSE enabled END,trigger_ok=CASE WHEN ?6 THEN trigger_ok END,updated_at=?3 WHERE id=?1 AND run_count=?7",
            params![schedule.id, runs, now, next, finished, manual, schedule.run_count],
        )
        .map_err(|e| e.to_string())
        .and_then(|changed| if changed == 0 { Err(String::from("This schedule already ran.")) } else { Ok(()) })?;
    // The trace reports what triggered this run.
    Ok(TaskSchedule { trigger_ok: schedule.trigger_ok.filter(|_| !manual), ..get(store, &schedule.id)? })
}

const DAY_NAMES: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/// Matches `cadence()` in `src/schedules-api.ts`.
pub(crate) fn cadence(schedule: &TaskSchedule) -> String {
    let time = schedule.time_of_day.as_deref().unwrap_or_default();
    let zone = schedule
        .timezone
        .as_deref()
        .filter(|zone| !zone.is_empty())
        .map(|zone| format!(" · {zone}"))
        .unwrap_or_default();
    match schedule.kind.as_str() {
        "once" => "Once".into(),
        "interval" => {
            let minutes = schedule.interval_minutes.unwrap_or_default();
            let plural = |n: i64, one: &str, many: &str| if n == 1 { one.to_owned() } else { format!("{n} {many}") };
            if minutes % 1440 == 0 {
                format!("Every {}", plural(minutes / 1440, "day", "days"))
            } else if minutes % 60 == 0 {
                format!("Every {}", plural(minutes / 60, "hour", "hours"))
            } else {
                format!("Every {minutes} min")
            }
        }
        "daily" => format!("Daily at {time}{zone}"),
        "weekdays" => format!("Weekdays at {time}{zone}"),
        "weekly" => {
            let days = schedule.days.iter().filter_map(|day| DAY_NAMES.get(*day as usize).copied()).collect::<Vec<_>>().join(", ");
            format!("{days} at {time}{zone}")
        }
        "cron" => {
            let expr = schedule.cron.as_deref().unwrap_or_default();
            format!("{expr}{zone}")
        }
        _ => format!("After “{}” {}", schedule.watch_session_title.as_deref().unwrap_or("a task"), if schedule.only_on_success { "succeeds" } else { "finishes" }),
    }
}

/// `cadence` in message wording: "every 30 min", "weekdays at 09:00", "once".
fn spoken_cadence(schedule: &TaskSchedule) -> String {
    let text = cadence(schedule);
    if schedule.kind == "weekly" {
        return text;
    }
    let mut chars = text.chars();
    chars.next().map(|first| first.to_lowercase().chain(chars).collect()).unwrap_or_default()
}

fn task_ref(title: Option<&str>, id: Option<&str>) -> String {
    format!("“{}” ({})", title.unwrap_or("a task"), id.unwrap_or("unknown"))
}

/// The exact text a fired schedule sends (format in docs/schedules.md); `schedule` is
/// already advanced, so `run_count` is this run.
pub(crate) fn message(schedule: &TaskSchedule, manual: bool, at: i64) -> String {
    let of = schedule.max_runs.map(|max| format!(" of {max}")).unwrap_or_default();
    let creator = schedule.created_by_session.as_deref();
    let own = creator == Some(schedule.session_id.as_str());
    let agent = schedule.created_by == "agent";
    let by = match (agent, own, creator) {
        (false, _, _) => "the user".to_owned(),
        (true, true, _) => "this thread's agent".to_owned(),
        (true, false, Some(id)) => format!("an agent in {}", task_ref(schedule.created_by_title.as_deref(), Some(id))),
        (true, false, None) => "an agent".to_owned(),
    };
    let manual_note = if manual { " · started with Run now" } else { "" };
    let watched = || task_ref(schedule.watch_session_title.as_deref(), schedule.watch_session_id.as_deref());
    let trigger = match schedule.trigger_ok {
        _ if manual => "Run now".to_owned(),
        Some(true) => format!("{} finished successfully", watched()),
        Some(false) => format!("{} finished with an error", watched()),
        None => "clock time reached".to_owned(),
    };
    let local = {
        use chrono::TimeZone;
        chrono::Local.timestamp_millis_opt(at).single().map(|time| time.format("%Y-%m-%d %H:%M").to_string()).unwrap_or_default()
    };
    let mut text = format!(
        "{}\n\n{TRACE_HEADER}: {}\nSchedule ID: {} · {} · run {}{of} · set by {by}{manual_note}\nTrigger: {trigger} · local time {local}",
        schedule.prompt,
        schedule.title,
        schedule.id,
        spoken_cadence(schedule),
        schedule.run_count
    );
    if agent && !own {
        if let Some(id) = creator {
            text.push_str(&format!("\nFrom: {}. Reply there with pandacode_schedule_message if useful.", task_ref(schedule.created_by_title.as_deref(), Some(id))));
        }
    }
    if agent && own {
        text.push_str("\nYou set this earlier in this thread. Pick up where you left off; cancel it with pandacode_cancel_schedule if it is no longer needed.");
    }
    text
}

fn run_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<ScheduleRun> {
    Ok(ScheduleRun { id: r.get(0)?, schedule_id: r.get(1)?, session_id: r.get(2)?, title: r.get(3)?, at: r.get(4)?, outcome: r.get(5)?, detail: r.get(6)?, sequence: r.get(7)?, manual: r.get(8)? })
}

/// Records a run and keeps the newest `RUNS_PER_SESSION` per thread.
pub(crate) fn record_run(store: &Store, schedule: &TaskSchedule, at: i64, outcome: &str, detail: &str, manual: bool) -> Result<ScheduleRun> {
    let id = crate::storage::id();
    store
        .db
        .execute(
            "INSERT INTO task_schedule_runs(id,schedule_id,session_id,title,at,outcome,detail,sequence,manual) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            params![id, schedule.id, schedule.session_id, schedule.title, at, outcome, detail, schedule.run_count, manual],
        )
        .map_err(|e| e.to_string())?;
    store
        .db
        .execute(
            "DELETE FROM task_schedule_runs WHERE session_id=?1 AND id NOT IN (SELECT id FROM task_schedule_runs WHERE session_id=?1 ORDER BY at DESC, rowid DESC LIMIT ?2)",
            params![schedule.session_id, RUNS_PER_SESSION],
        )
        .map_err(|e| e.to_string())?;
    store.db.query_row("SELECT id,schedule_id,session_id,title,at,outcome,detail,sequence,manual FROM task_schedule_runs WHERE id=?1", [&id], run_row).map_err(|e| e.to_string())
}

pub(crate) fn runs(store: &Store, session_id: Option<&str>, schedule_id: Option<&str>, limit: i64) -> Result<Vec<ScheduleRun>> {
    let mut statement = store
        .db
        .prepare("SELECT id,schedule_id,session_id,title,at,outcome,detail,sequence,manual FROM task_schedule_runs WHERE (?1 IS NULL OR session_id=?1) AND (?2 IS NULL OR schedule_id=?2) ORDER BY at DESC, rowid DESC LIMIT ?3")
        .map_err(|e| e.to_string())?;
    let rows = statement.query_map(params![session_id, schedule_id, limit.clamp(1, RUNS_PER_SESSION)], run_row).map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<_>>().map_err(|e| e.to_string())
}

/// Counts a failed delivery; three in a row turn the schedule off. Returns the detail to record.
fn note_outcome(store: &Store, schedule: &TaskSchedule, error: Option<&str>) -> Result<String> {
    let Some(error) = error else {
        store.db.execute("UPDATE task_schedules SET consecutive_failures=0 WHERE id=?1", [&schedule.id]).map_err(|e| e.to_string())?;
        return Ok(String::new());
    };
    let failures: i64 = store
        .db
        .query_row("UPDATE task_schedules SET consecutive_failures=consecutive_failures+1 WHERE id=?1 RETURNING consecutive_failures", [&schedule.id], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?
        .unwrap_or_default();
    if failures >= FAILURE_LIMIT {
        store.db.execute("UPDATE task_schedules SET enabled=0,next_run_at=NULL WHERE id=?1", [&schedule.id]).map_err(|e| e.to_string())?;
        return Ok(format!("{error} Turned off after {FAILURE_LIMIT} failures in a row."));
    }
    Ok(error.to_owned())
}

pub(crate) fn changed(app: &tauri::AppHandle, session_id: Option<&str>) {
    let _ = app.emit("schedules-changed", json!({"sessionId": session_id}));
}

fn lock<'a>(state: &'a State<'_, AppState>) -> Result<std::sync::MutexGuard<'a, Store>> {
    state.store.lock().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn schedules_list(state: State<'_, AppState>, session_id: Option<String>) -> Result<Vec<TaskSchedule>> {
    list(&*lock(&state)?, session_id.as_deref())
}

#[tauri::command]
pub async fn schedule_create(app: tauri::AppHandle, state: State<'_, AppState>, input: ScheduleInput) -> Result<TaskSchedule> {
    let schedule = create(&*lock(&state)?, &input, "user", None, crate::storage::now())?;
    changed(&app, Some(&schedule.session_id));
    Ok(schedule)
}

#[tauri::command]
pub async fn schedule_update(app: tauri::AppHandle, state: State<'_, AppState>, schedule_id: String, input: ScheduleInput) -> Result<TaskSchedule> {
    let (before, schedule) = {
        let store = lock(&state)?;
        let before = get(&store, &schedule_id)?;
        (before, update(&store, &schedule_id, &input, crate::storage::now())?)
    };
    // Moving a schedule to another thread changes both threads' lists.
    changed(&app, (before.session_id == schedule.session_id).then_some(schedule.session_id.as_str()));
    Ok(schedule)
}

#[tauri::command]
pub async fn schedule_set_enabled(app: tauri::AppHandle, state: State<'_, AppState>, schedule_id: String, enabled: bool) -> Result<TaskSchedule> {
    let schedule = set_enabled(&*lock(&state)?, &schedule_id, enabled, crate::storage::now())?;
    changed(&app, Some(&schedule.session_id));
    Ok(schedule)
}

#[tauri::command]
pub async fn schedule_delete(app: tauri::AppHandle, state: State<'_, AppState>, schedule_id: String) -> Result<()> {
    let schedule = delete(&*lock(&state)?, &schedule_id)?;
    changed(&app, Some(&schedule.session_id));
    Ok(())
}

#[tauri::command]
pub async fn schedule_run_now(app: tauri::AppHandle, state: State<'_, AppState>, schedule_id: String) -> Result<ScheduleRun> {
    let schedule = {
        let store = lock(&state)?;
        let schedule = get(&store, &schedule_id)?;
        if exhausted(&schedule) {
            return Err("This schedule has used all its runs. Raise Max runs to run it again.".into());
        }
        schedule
    };
    if firing::console_only(&state, &schedule.session_id) {
        return Err("This thread's harness console is open; close it, then run the schedule.".into());
    }
    let schedule = advance(&*lock(&state)?, &schedule, crate::storage::now(), true)?;
    firing::deliver(&app, &schedule, true).await
}

#[tauri::command]
pub async fn schedule_snooze(app: tauri::AppHandle, state: State<'_, AppState>, schedule_id: String, minutes: i64) -> Result<TaskSchedule> {
    let schedule = snooze(&*lock(&state)?, &schedule_id, minutes, crate::storage::now())?;
    changed(&app, Some(&schedule.session_id));
    Ok(schedule)
}

#[tauri::command]
pub async fn schedule_runs(state: State<'_, AppState>, session_id: Option<String>, schedule_id: Option<String>, limit: Option<i64>) -> Result<Vec<ScheduleRun>> {
    runs(&*lock(&state)?, session_id.as_deref(), schedule_id.as_deref(), limit.unwrap_or(50))
}

#[tauri::command]
pub async fn scheduler_settings(state: State<'_, AppState>) -> Result<SchedulerSettings> {
    settings(&*lock(&state)?)
}

#[tauri::command]
pub async fn scheduler_set_settings(app: tauri::AppHandle, state: State<'_, AppState>, settings: SchedulerSettings) -> Result<SchedulerSettings> {
    let saved = set_settings(&*lock(&state)?, &settings)?;
    changed(&app, None);
    // Resuming fires what came due while paused.
    if !saved.paused {
        let app = app.clone();
        tauri::async_runtime::spawn(async move { firing::tick(&app).await });
    }
    Ok(saved)
}
