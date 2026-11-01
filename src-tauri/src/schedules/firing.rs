//! The clock loop and delivery: due schedules are advanced under the store lock, then
//! their message is queued behind a busy thread or sent as a turn through `send_prompt`.

use super::{advance, changed, due, message, note_outcome, record_run, trigger, ScheduleRun, TaskSchedule, TICK_SECONDS};
use crate::{message_queue, storage::Store, AppState, Result};
use serde_json::json;
use std::collections::HashSet;
use tauri::{Emitter, Manager};

/// A team thread is busy while its architect or any worker is running.
fn team_busy(store: &Store, session_id: &str) -> Result<bool> {
    Ok(crate::architect::load(store, session_id)?.is_some_and(|team| matches!(team.status.as_str(), "running" | "waiting") || team.workers.iter().any(|worker| worker.status == "running")))
}

/// An open harness console with no agent run: nothing can send to it, the window's queue
/// included, so its schedules wait (still due, not advanced) until the console closes.
pub(super) fn console_only(state: &AppState, session_id: &str) -> bool {
    let running = state.agents.lock().map(|agents| agents.contains_key(session_id)).unwrap_or(true);
    !running && crate::terminal::harness_running(&state.terminals, session_id).unwrap_or(false)
}

/// Advances the due schedules whose thread is not `held`; they are the runs to deliver.
pub(super) fn take_due(store: &Store, now: i64, held: &HashSet<String>) -> Result<Vec<TaskSchedule>> {
    Ok(due(store, now)?.iter().filter(|schedule| !held.contains(&schedule.session_id)).filter_map(|schedule| advance(store, schedule, now, false).ok()).collect())
}

/// Sends an advanced schedule's message: queued behind a running turn or team, or started as a turn.
pub(crate) async fn deliver(app: &tauri::AppHandle, schedule: &TaskSchedule, manual: bool) -> Result<ScheduleRun> {
    let state = app.state::<AppState>();
    let now = crate::storage::now();
    let team = {
        let store = state.store.lock().map_err(|e| e.to_string())?;
        let session = store.session(&schedule.session_id).map_err(|_| String::from("The thread was deleted."))?;
        if session.archived {
            let run = record_run(&store, schedule, now, "skipped", "Thread is archived", manual)?;
            drop(store);
            changed(app, Some(&schedule.session_id));
            return Ok(run);
        }
        team_busy(&store, &schedule.session_id)?
    };
    let text = message(schedule, manual, now);
    let busy = team || state.agents.lock().map_err(|e| e.to_string())?.contains_key(&schedule.session_id);
    let result = if busy {
        let queued = message_queue::add(&*state.store.lock().map_err(|e| e.to_string())?, &schedule.session_id, &text, &json!([]));
        if queued.is_ok() {
            let _ = app.emit("queue-changed", json!({"sessionId": schedule.session_id}));
        }
        queued.map(|_| ("queued", "Queued behind the running turn"))
    } else {
        crate::send_prompt(app.clone(), state.clone(), schedule.session_id.clone(), text, None).await.map(|_| ("started", "Started a turn"))
    };
    let run = {
        let store = state.store.lock().map_err(|e| e.to_string())?;
        match result {
            Ok((outcome, detail)) => {
                note_outcome(&store, schedule, None)?;
                record_run(&store, schedule, now, outcome, detail, manual)?
            }
            Err(error) => {
                let detail = note_outcome(&store, schedule, Some(&error))?;
                record_run(&store, schedule, now, "failed", &detail, manual)?
            }
        }
    };
    changed(app, Some(&schedule.session_id));
    Ok(run)
}

pub(super) async fn tick(app: &tauri::AppHandle) {
    let now = crate::storage::now();
    let state = app.state::<AppState>();
    // Read the due threads first: the agents map is never locked while the store is.
    let threads: Vec<String> = match state.store.lock() {
        Ok(store) => due(&store, now).unwrap_or_default().into_iter().map(|schedule| schedule.session_id).collect(),
        Err(_) => return,
    };
    if threads.is_empty() {
        return;
    }
    let held: HashSet<String> = threads.into_iter().filter(|id| console_only(&state, id)).collect();
    let fired = match state.store.lock() {
        Ok(store) => take_due(&store, now, &held).unwrap_or_default(),
        Err(_) => return,
    };
    for schedule in fired {
        if let Err(error) = deliver(app, &schedule, false).await {
            eprintln!("Schedule {} could not run: {error}", schedule.id);
        }
    }
}

/// Scheduler loop: one tick at startup (overdue runs fire once), then every 15 seconds.
pub(crate) fn start(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(TICK_SECONDS));
        loop {
            interval.tick().await;
            tick(&app).await;
        }
    });
}

/// Called when any thread's run ends (local or mirror): marks the `after` schedules watching it due.
pub(crate) fn run_finished(app: &tauri::AppHandle, session_id: &str, successful: bool) {
    let marked = {
        let state = app.state::<AppState>();
        let Ok(store) = state.store.lock() else { return };
        trigger(&store, session_id, successful, crate::storage::now()).unwrap_or_default()
    };
    if marked > 0 {
        changed(app, None);
        let app = app.clone();
        tauri::async_runtime::spawn(async move { tick(&app).await });
    }
}
