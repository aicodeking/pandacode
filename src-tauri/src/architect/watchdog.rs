//! A team turn that goes silent is stopped, so one hung tool call cannot block the team, and a turn
//! whose end was never recorded is settled, so nothing waits forever for an event that was missed.
use super::*;

/// Claude's longest tool timeout is 10 minutes, so a turn with no event for twice that
/// is stuck. Approvals and questions that wait on the user never count as silence.
pub(crate) const SILENCE_MINUTES: i64 = 20;
const SILENCE_LIMIT_MS: i64 = SILENCE_MINUTES * 60 * 1000;
const CHECK_EVERY: std::time::Duration = std::time::Duration::from_secs(30);
/// A tick this late means the computer slept (or its clock jumped): the wall clock moved, harnesses did not.
const SLEEP_GAP_MS: i64 = 3 * CHECK_EVERY.as_secs() as i64 * 1000;
/// How long a run may read as running with no process before it counts as lost. The scheduler claims
/// a run and registers it in `prepare_task_run_in_project` with no await in between (the one await on
/// that path, `prepare_command` for `/` prompts, is skipped for team launches), so only lock waits
/// separate them, and everything slow (cloud setup, harness startup) happens after the agent is
/// registered. A claim this old with no agent is no launch in progress; even if a launch did arrive
/// later, `validate_admission` refuses it once the worker is no longer `running`.
pub(super) const ORPHAN_AFTER_MS: i64 = 60 * 1000;
/// The error of a worker settled by `reap_orphans`; also marks the run as not the model's failure.
pub(super) const ORPHANED: &str = "The run ended without reporting back.";

pub(crate) fn architect_note() -> String {
    format!("The architect's turn was stopped after {SILENCE_MINUTES} minutes without any output.")
}
pub(crate) fn worker_note() -> String {
    format!("No output for {SILENCE_MINUTES} minutes, so PandaCode stopped this worker. Check its changes in the checkout, or follow up.")
}

pub(crate) fn watch(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut first = true;
        let mut last_tick = storage::now();
        loop {
            tokio::time::sleep(CHECK_EVERY).await;
            let state = app.state::<AppState>();
            if state.shutdown.load(Ordering::SeqCst) != 0 {
                break;
            }
            if std::mem::take(&mut first) {
                match settle_stale(&state, &mut |team| emit(&app, team)) {
                    Ok(0) => {}
                    Ok(n) => eprintln!("Team watchdog: settled {n} workers of inactive teams saved as running"),
                    Err(error) => eprintln!("Team watchdog: {error}"),
                }
            }
            let now = storage::now();
            // After a sleep this tick only restarts the clocks; the next one gives any launch the
            // sleep interrupted time to register before the orphan and reservation checks look.
            match forgive_sleep(&state, now, std::mem::replace(&mut last_tick, now)) {
                Ok(true) => continue,
                Ok(false) => {}
                Err(error) => eprintln!("Team watchdog: {error}"),
            }
            if let Err(error) = stop_silent(&state, now, &mut |team| emit(&app, team)) {
                eprintln!("Team watchdog: {error}");
            }
            match reconcile(&state, now, &mut |team| emit(&app, team)) {
                Ok(true) => wake(app.clone()),
                Ok(false) => {}
                Err(error) => eprintln!("Team watchdog: {error}"),
            }
        }
    });
}

/// Time asleep is not silence: without this, opening the lid after 20 minutes would fail every live
/// turn and pause healthy models. Returns whether `now` is far enough past `last_tick` to count.
pub(super) fn forgive_sleep(state: &AppState, now: i64, last_tick: i64) -> Result<bool> {
    if now.saturating_sub(last_tick) <= SLEEP_GAP_MS {
        return Ok(false);
    }
    let agents = state.agents.lock().map_err(|e| e.to_string())?;
    for agent in agents.values() {
        agent.last_event.store(now, Ordering::SeqCst);
    }
    Ok(true)
}

/// Stops every silent team turn and returns how many it stopped. The flag is saved
/// before the stop, so the completion settles the run as a timeout and not a user stop.
pub(super) fn stop_silent(
    state: &AppState,
    now: i64,
    notify: &mut impl FnMut(&TeamSnapshot),
) -> Result<usize> {
    let agents = state.agents.lock().map_err(|e| e.to_string())?;
    let silent = agents
        .iter()
        .filter(|(_, agent)| {
            agent.silent_for(now) >= SILENCE_LIMIT_MS
                && !agent.stopped.load(Ordering::SeqCst)
                && !agent.has_pending_approvals()
        })
        .map(|(sid, _)| sid.clone())
        .collect::<Vec<_>>();
    if silent.is_empty() {
        return Ok(0);
    }
    let store = state.store.lock().map_err(|e| e.to_string())?;
    let mut stopped = 0;
    for sid in silent {
        if store.session(&sid).is_ok_and(|task| task.status == "waiting") {
            continue;
        }
        // One unreadable team must not keep the others' silent turns running.
        let found = load(&store, &sid).and_then(|own| match own {
            Some(team) => Ok(Some((sid.clone(), team))),
            None => match parent_of(&store, &sid)? {
                Some(parent) => Ok(load(&store, &parent)?.map(|team| (parent, team))),
                None => Ok(None),
            },
        });
        let (parent, mut team) = match found {
            Ok(Some(found)) => found,
            Ok(None) => continue,
            Err(error) => {
                eprintln!("Team watchdog: {sid}: {error}");
                continue;
            }
        };
        if !active(&team.status) {
            continue;
        }
        if parent == sid {
            team.timed_out = true;
        } else if let Some(worker) = team
            .workers
            .iter_mut()
            .find(|w| w.session_id == sid && active(&w.status))
        {
            worker.timed_out = true;
        } else {
            continue;
        }
        if let Err(error) = save(&store, &mut team) {
            eprintln!("Team watchdog: {sid}: {error}");
            continue;
        }
        notify(&team);
        if let Some(agent) = agents.get(&sid) {
            let _ = agent.send(RunInput::Stop);
        }
        stopped += 1;
    }
    Ok(stopped)
}

/// Teams saved by older versions can be failed, paused or completed with workers still saved as
/// running: `reconcile` never looks at inactive teams, so this runs once at startup and settles
/// every active worker without a process in such a team as stopped. Returns how many it settled.
pub(super) fn settle_stale(state: &AppState, notify: &mut impl FnMut(&TeamSnapshot)) -> Result<usize> {
    let agents = state.agents.lock().map_err(|e| e.to_string())?;
    let store = state.store.lock().map_err(|e| e.to_string())?;
    let teams = {
        // A row that is not even JSON is listed too, so the load below reports it instead of the query failing.
        let mut query = store.db.prepare("SELECT session_id FROM architect_teams WHERE CASE WHEN json_valid(content) THEN json_extract(content,'$.status') NOT IN ('running','waiting') ELSE 1 END").map_err(|e| e.to_string())?;
        let rows = query.query_map([], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
        rows.collect::<std::result::Result<Vec<_>, _>>().map_err(|e| e.to_string())?
    };
    let mut settled = 0;
    for sid in &teams {
        // This pass runs once: one unreadable team must not cost the others theirs.
        let mut team = match load(&store, sid) {
            Ok(Some(team)) => team,
            Ok(None) => continue,
            Err(error) => {
                eprintln!("Team watchdog: team {sid}: {error}");
                continue;
            }
        };
        let stale: Vec<usize> = team.workers.iter().enumerate().filter(|(_, w)| active(&w.status) && !agents.contains_key(&w.session_id)).map(|(i, _)| i).collect();
        if stale.is_empty() {
            continue;
        }
        let count = stale.len();
        for index in stale {
            let worker = &mut team.workers[index];
            worker.status = "stopped".into();
            worker.updated_at = storage::now();
        }
        if let Err(error) = save(&store, &mut team) {
            eprintln!("Team watchdog: team {sid}: {error}");
            continue;
        }
        settled += count;
        notify(&team);
    }
    Ok(settled)
}

/// Settles what no event will settle. Returns whether any team is active, so the caller runs the
/// scheduler too: one missed wake never strands a team. Lock order is registry, then store.
pub(super) fn reconcile(
    state: &AppState,
    now: i64,
    notify: &mut impl FnMut(&TeamSnapshot),
) -> Result<bool> {
    let agents = state.agents.lock().map_err(|e| e.to_string())?;
    if state.shutdown.load(Ordering::SeqCst) != 0 {
        return Ok(false);
    }
    let teams = {
        let store = state.store.lock().map_err(|e| e.to_string())?;
        let mut query = store.db.prepare("SELECT session_id FROM architect_teams WHERE json_valid(content) AND json_extract(content,'$.status') IN ('running','waiting')").map_err(|e| e.to_string())?;
        let rows = query.query_map([], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
        rows.collect::<std::result::Result<Vec<_>, _>>().map_err(|e| e.to_string())?
    };
    for sid in &teams {
        if let Err(error) = reconcile_team(state, &agents, sid, now, notify) {
            eprintln!("Team watchdog: team {sid}: {error}");
        }
    }
    Ok(!teams.is_empty())
}

fn reconcile_team(
    state: &AppState,
    agents: &std::collections::HashMap<String, crate::RunningAgent>,
    sid: &str,
    now: i64,
    notify: &mut impl FnMut(&TeamSnapshot),
) -> Result<()> {
    let team = load(&*state.store.lock().map_err(|e| e.to_string())?, sid)?.ok_or("Team unavailable.")?;
    let orphans = team.workers.iter().filter(|w| {
        active(&w.status) && !agents.contains_key(&w.session_id) && now - w.updated_at >= ORPHAN_AFTER_MS
    });
    let admission = Admission { parent: team.session_id.clone(), generation: team.generation };
    for worker in orphans {
        // The same path as a failed run, so sub-workers settle and the lead is woken.
        completed_with_agents(state, agents, &worker.session_id, Some(&admission), false, false, Some(ORPHANED), notify);
    }
    release_reservation(state, agents, sid, now, notify)
}

/// A reserved lead turn with no agent lost its launch; without this its team would wait forever.
/// Saved teams are read again because settling an orphan above saves the team.
fn release_reservation(
    state: &AppState,
    agents: &std::collections::HashMap<String, crate::RunningAgent>,
    sid: &str,
    now: i64,
    notify: &mut impl FnMut(&TeamSnapshot),
) -> Result<()> {
    let store = state.store.lock().map_err(|e| e.to_string())?;
    let mut team = load(&store, sid)?.ok_or("Team unavailable.")?;
    if agents.contains_key(sid) {
        return Ok(());
    }
    let Some(pending) = team.pending_turn.as_mut().filter(|pending| pending.reserved && now - pending.reserved_at >= ORPHAN_AFTER_MS) else {
        return Ok(());
    };
    pending.reserved = false;
    save(&store, &mut team)?;
    notify(&team);
    Ok(())
}
