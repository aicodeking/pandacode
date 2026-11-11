//! How a run's approvals and questions, and its end, are recorded: a team worker's requests
//! resolved through the run's sink, a pooled account switch settling what the old account left
//! open, a confirmed automatic stop's trace, and how the run's end reads for every client.
use super::*;

/// Saves an approval or question and, for a team worker, resolves it or stops the run at once,
/// even when it could not be saved (no request ID, a storage error): a worker never waits on a
/// person.
///
/// # Locking
/// Resolving a worker's request locks the agents registry (`worker_approvals::resolve_if_worker`)
/// with a plain `std::sync::Mutex`, which is not reentrant: the run's event sink, and so this
/// function, must never be called on a thread that already holds `agents`, or it deadlocks.
/// Providers emit events from their own tasks with no registry lock held; keep it that way, and
/// release any `agents` guard before emitting from code that holds one. Debug builds assert it
/// for guards taken through `lock_agents`, which every non-test registry lock uses; a plain
/// `agents.lock()` is not tracked, so don't add one.
pub(crate) fn record_request_event(
    store: &Arc<Mutex<Store>>,
    run: &worker_approvals::Run,
    worker: bool,
    agents: &Arc<Mutex<HashMap<String, RunningAgent>>>,
    event: &mut AgentEvent,
) -> Result<()> {
    #[cfg(debug_assertions)]
    debug_assert!(!registry_held(), "the run's event sink was called with the agents registry locked");
    let had_id = event.request_id.is_some();
    // The harness cancelled its own request: a decline reason kept for it has nothing to reach.
    if event.kind == "approval_cancelled" {
        if let Some(id) = &event.request_id {
            providers::take_decline_reason(&event.session_id, id);
        }
    }
    // A worker's request is resolved at once: it joins the internal approvals set (the reply
    // needs it) but neither the snapshot payload list nor the waiting status.
    let quiet = worker && matches!(event.kind.as_str(), "approval" | "input_request");
    // The reply checks the internal approvals set only; the request payload list that remote
    // snapshots read never gets a worker request that is resolved right here.
    let requests = (!quiet).then_some(&*run.requests);
    let saved = save_pending_request(store, &run.approvals, requests, &run.id, event, !quiet);
    if saved.is_ok() || worker {
        let handled = worker_approvals::resolve_if_worker(worker, run, agents, store, event);
        // A worker request resolved or stopped here does not fail the run for its save: the
        // error is logged, and the run's error slot stays clear.
        if worker && handled {
            if let Err(error) = &saved {
                if had_id {
                    eprintln!("PandaCode: could not save team worker {} request: {error}", event.session_id);
                }
            }
            return Ok(());
        }
    }
    saved
}

/// The agents registry's guard. Debug builds count it per thread so `record_request_event` can
/// assert the sink never runs under the lock; release builds use the plain guard.
#[cfg(not(debug_assertions))]
pub(crate) type RegistryGuard<'a> = std::sync::MutexGuard<'a, HashMap<String, RunningAgent>>;

#[cfg(debug_assertions)]
thread_local! {
    static REGISTRY_HELD: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[cfg(debug_assertions)]
pub(crate) struct RegistryGuard<'a>(std::sync::MutexGuard<'a, HashMap<String, RunningAgent>>);

#[cfg(debug_assertions)]
impl<'a> RegistryGuard<'a> {
    fn new(guard: std::sync::MutexGuard<'a, HashMap<String, RunningAgent>>) -> Self {
        REGISTRY_HELD.with(|held| held.set(held.get() + 1));
        Self(guard)
    }
}

#[cfg(debug_assertions)]
impl Drop for RegistryGuard<'_> {
    fn drop(&mut self) {
        REGISTRY_HELD.with(|held| held.set(held.get().saturating_sub(1)));
    }
}

#[cfg(debug_assertions)]
impl std::ops::Deref for RegistryGuard<'_> {
    type Target = HashMap<String, RunningAgent>;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

#[cfg(debug_assertions)]
impl std::ops::DerefMut for RegistryGuard<'_> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}

/// Whether this thread holds the agents registry through `lock_agents` (debug builds).
#[cfg(debug_assertions)]
pub(crate) fn registry_held() -> bool {
    REGISTRY_HELD.with(|held| held.get() > 0)
}

/// Locks the agents registry; in debug builds the guard marks this thread as its holder.
pub(crate) fn lock_agents(agents: &Mutex<HashMap<String, RunningAgent>>) -> std::sync::LockResult<RegistryGuard<'_>> {
    #[cfg(debug_assertions)]
    return match agents.lock() {
        Ok(guard) => Ok(RegistryGuard::new(guard)),
        Err(poison) => Err(std::sync::PoisonError::new(RegistryGuard::new(poison.into_inner()))),
    };
    #[cfg(not(debug_assertions))]
    agents.lock()
}

/// Records and shows a confirmed automatic stop: its transcript notes and its error event.
pub(crate) fn show_settled_stop(app: &tauri::AppHandle, store: &Arc<Mutex<Store>>, settled: worker_approvals::Settled) {
    if !settled.notes.is_empty() {
        if let Ok(db) = store.lock() {
            for (session_id, text) in &settled.notes {
                if let Err(error) = db.message(session_id, "system", text) {
                    eprintln!("PandaCode: could not record a team worker stop: {error}");
                }
            }
        }
    }
    for event in settled.shown {
        let _ = app.emit("agent-event", event);
    }
}

/// A pooled run moved to another account (any run, a user's too): the old account's open
/// requests are cleared, the task reads as running again, approval cards forwarded to a bot
/// conversation are withdrawn, and the returned cancel events drop the window's cards.
pub(crate) fn settle_account_switch(store: &Arc<Mutex<Store>>, run: &worker_approvals::Run, session_id: &str) -> Vec<AgentEvent> {
    let cancelled = worker_approvals::account_switched(run, session_id);
    if cancelled.is_empty() {
        return cancelled;
    }
    if let Ok(db) = store.lock() {
        if let Err(error) = db.status(session_id, "running") {
            eprintln!("PandaCode: could not update task {session_id} after an account switch: {error}");
        }
    }
    let withdrawn: Vec<String> = cancelled.iter().filter(|e| e.kind == "approval_cancelled").filter_map(|e| e.request_id.clone()).collect();
    bots::approvals_withdrawn(session_id, &withdrawn);
    cancelled
}

/// How a run's end reads: a worker PandaCode stopped for a request it could not resolve
/// failed (its team, the window, the tray and remote clients agree), it was not stopped.
pub(crate) fn run_end(successful: bool, was_stopped: bool, unresolved: bool) -> (bool, &'static str) {
    let stopped = was_stopped && !unresolved;
    let done = if stopped {
        "Turn stopped"
    } else if successful {
        "Turn complete"
    } else {
        "Turn failed"
    };
    (stopped, done)
}

#[cfg(all(test, debug_assertions))]
mod tests {
    use super::*;

    type Worker = (Arc<Mutex<Store>>, worker_approvals::Run, Arc<Mutex<HashMap<String, RunningAgent>>>, AgentEvent);

    fn worker() -> Worker {
        let store = Store::open(std::path::Path::new(":memory:")).unwrap();
        let project = store.add_project(&std::env::temp_dir()).unwrap();
        let sid = store.create_session(&project.id, "codex", "default", "full").unwrap().id;
        let (input, _receiver) = tokio::sync::mpsc::unbounded_channel();
        let agent = RunningAgent::new(input, Arc::new(std::sync::atomic::AtomicBool::new(false)));
        let run = worker_approvals::Run::of(&agent);
        let event = AgentEvent { session_id: sid.clone(), kind: "approval_cancelled".into(), text: String::new(), request_id: Some("7".into()), data: None, tool: None };
        (Arc::new(Mutex::new(store)), run, Arc::new(Mutex::new(HashMap::from([(sid, agent)]))), event)
    }

    #[test]
    fn the_registry_guard_marks_only_its_own_thread() {
        let registry: Mutex<HashMap<String, RunningAgent>> = Mutex::default();
        assert!(!registry_held());
        let guard = lock_agents(&registry).unwrap();
        assert!(registry_held());
        assert!(std::thread::spawn(|| !registry_held()).join().unwrap(), "another thread is not marked");
        drop(guard);
        assert!(!registry_held());
    }

    #[test]
    #[should_panic(expected = "agents registry locked")]
    fn the_sink_under_the_registry_lock_fails_in_debug_builds() {
        let (store, run, agents, mut event) = worker();
        // Another registry, so the check fires instead of the deadlock it guards against.
        let other: Mutex<HashMap<String, RunningAgent>> = Mutex::default();
        let _held = lock_agents(&other).unwrap();
        let _ = record_request_event(&store, &run, true, &agents, &mut event);
    }
}
