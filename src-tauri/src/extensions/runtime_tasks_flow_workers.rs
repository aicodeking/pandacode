//! One worker of a team, stopped, skipped, retried or resumed on request (`tasks.control`, runtime slice R0404B).
//!
//! This file is a child module of `architect` (declared there with `#[path]`), so it reaches the team store, the status
//! rules and the Council seat rules that the parent keeps private; nothing here is public beyond [`worker_control`]. The
//! interface has no per-worker button: its team-level Stop, Pause and Resume (`control_state`) act on every worker, and the
//! lead's own `cancel_worker` and `followup_worker` tools act on one. A package that holds `tasks.control` gets the same
//! effect on one worker, by the same rules as those tools:
//! - `stop`: the worker's run is stopped and it settles as `stopped` (a later Resume or `resume` brings it back);
//! - `skip`: the worker is abandoned as `cancel_worker` does (its sub-workers settle with it), so the team can finish;
//! - `retry` (a failed worker) and `resume` (a stopped one): the worker is queued again, as the team's Resume queues it
//!   (a failure uses one attempt, a stop does not). The team itself must be running; a paused, failed or interrupted team is
//!   resumed with `architect_control` first, which is what the caller's plan runs.
//! A scored or running Council reviewer is never unseated, and a reviewer is never followed up, exactly as for the lead.
use super::*;

/// Applies `op` to worker `worker_id` of the team led by `session_id` and wakes the scheduler. Answers the team snapshot.
pub(crate) async fn worker_control(app: tauri::AppHandle, state: State<'_, AppState>, session_id: String, worker_id: String, op: String) -> Result<Value> {
    let team = worker_state(&state, &session_id, &worker_id, &op)?;
    emit(&app, &team);
    wake(app);
    serde_json::to_value(&team).map_err(|e| e.to_string())
}

/// The state change of `worker_control`, without the window: one save, under the agent and store locks the team's own
/// controls take.
fn worker_state(state: &AppState, session_id: &str, worker_id: &str, op: &str) -> Result<TeamSnapshot> {
    let agents = crate::run_requests::lock_agents(&state.agents).map_err(|e| e.to_string())?;
    let store = state.store.lock().map_err(|e| e.to_string())?;
    refuse_mirror(&store, session_id)?;
    let mut team = load(&store, session_id)?.ok_or("This task has no team.")?;
    let index = team.workers.iter().position(|worker| worker.id == worker_id).ok_or("Worker does not belong to this team.")?;
    match op {
        "stop" => {
            let worker = &mut team.workers[index];
            if !unsettled(&worker.status) { return Err("This worker is not running.".into()); }
            council::refuse_unseat(worker)?;
            if let Some(agent) = agents.get(&worker.session_id) { let _ = agent.send(RunInput::Stop); }
            council::note_stopped(worker);
            worker.status = "stopped".into();
            worker.updated_at = storage::now();
        }
        "skip" => {
            let revision = team.dispatch_revision + 1;
            let worker = &mut team.workers[index];
            if worker.status == "completed" || worker.abandoned { return Err("This worker is already settled.".into()); }
            council::refuse_unseat(worker)?;
            if let Some(agent) = agents.get(&worker.session_id) { let _ = agent.send(RunInput::Stop); }
            council::note_stopped(worker);
            if stoppable(&worker.status) { worker.status = "stopped".into(); }
            worker.abandoned = true;
            worker.error = Some(bounded("Skipped by a package on the user's behalf.", 1024));
            worker.updated_at = storage::now();
            worker.result_revision = revision;
            let id = worker.id.clone();
            settle_children(&mut team, &id, &agents, "Skipped with its parent worker.");
        }
        "retry" | "resume" => {
            if !active(&team.status) { return Err("Resume the team first.".into()); }
            let revision = team.dispatch_revision + 1;
            let worker = &mut team.workers[index];
            if worker.abandoned { return Err("That worker was skipped; it is already settled.".into()); }
            if worker.council.is_some() { return Err(council::NO_FOLLOWUP.into()); }
            let failed = match (op, worker.status.as_str()) { ("retry", "failed") => true, ("resume", "stopped") => false, _ => return Err("This worker is not waiting to be started again.".into()) };
            if agents.contains_key(&worker.session_id) { return Err("Wait for this worker to stop first.".into()); }
            worker.status = "queued".into();
            worker.started_at = None;
            worker.error = None;
            worker.reported = false;
            // A stop is not a failed attempt: only a failure uses one up.
            if failed { worker.attempt += 1; }
            worker.updated_at = storage::now();
            team.dispatch_revision = revision;
        }
        _ => return Err("Unknown worker action.".into()),
    }
    save(&store, &mut team)?;
    Ok(team)
}
