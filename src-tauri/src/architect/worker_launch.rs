//! How a team worker's run is launched and relaunched: the launch's prompt record (for an
//! effort relaunch), the effort fit right before launch, the startup effort refusal and its
//! relaunch without the effort, and the mode a fork of a worker's transcript starts in.
use super::*;

/// The permission mode a fork of `source` starts in. A team worker always runs in full access
/// (`WORKER_PERMISSION_MODE`), which must not carry into a user's own chat: a fork of a worker's
/// transcript takes its lead's mode, or "ask" when the lead is gone. Any other fork keeps its
/// source's mode.
pub(crate) fn fork_mode(store: &Store, source: &storage::Session) -> String {
    match parent_of(store, &source.id) {
        Ok(Some(lead)) => store.session(&lead).map_or_else(|_| "ask".to_string(), |lead| lead.mode),
        Ok(None) => source.mode.clone(),
        // Unknown: the cautious mode.
        Err(_) => "ask".to_string(),
    }
}

/// The last check before a worker starts, from cached catalogs only (no I/O on the scheduler):
/// its effort must be one its model accepts (a failover, a roster default or a catalog learned
/// since dispatch may disagree), else the nearest one or none. The lead sees the note.
/// Only a catalog known to lack the level lowers it, so missing data never does. Never fails
/// the scheduler pass: a failed write is logged and the worker launches as it is.
pub(super) fn fit_before_launch(store: &Store, worker: &mut Worker) {
    // A missing session fails at launch with its own error; the effort is not the place.
    let Ok(session) = store.session(&worker.session_id) else { return };
    let (fitted, note) = model_efforts::fit(&session.provider, &session.model, session.reasoning_effort.as_ref());
    if fitted == session.reasoning_effort {
        return;
    }
    if let Err(error) = store.db.execute("UPDATE sessions SET reasoning_effort=?2 WHERE id=?1", params![worker.session_id, fitted]) {
        eprintln!("Architect: could not fit worker {}'s reasoning effort: {error}", worker.id);
        return;
    }
    worker.reasoning_effort = fitted;
    // Keep an earlier dispatch or failover note: both explain the effort the worker runs at.
    if let Some(note) = note.map(|n| format!("{EFFORT_NOTE} {n}.")) {
        worker.note = Some(match worker.note.take() {
            Some(earlier) if earlier != note => bounded(&format!("{earlier} {note}"), 1024),
            _ => note,
        });
    }
}

/// Queues a worker whose harness refused its reasoning effort again, on the model's default,
/// keeping any earlier failover note.
/// Removes the failed startup turn (its prompt and error rows: by `refused_at_startup` it has
/// no reply or tool), so the relaunch saves the prompt once, not twice.
/// Returns whether the worker was relaunched; when not (a failed write), nothing changed and the
/// run stands as an ordinary failure.
pub(super) fn relaunch_without_effort(store: &Store, worker: &mut Worker) -> bool {
    // The launch's prompt row (`launch_anchor`, the same row the startup check used): its text is
    // sent again (a parked worker's sub-worker results, a nudge, since `resume_prompt` was cleared
    // when the run started), and only that row and the turn's error rows after it are dropped.
    let launch = launch_anchor(store, &worker.session_id);
    // Only the row `mark_started` recorded is ever deleted. Without that record (after a
    // restart) the newest prompt row is only read: the worker is requeued and may repeat its
    // prompt, but an earlier turn is never deleted.
    let recorded = launch_prompt(&worker.session_id, false).is_some();
    let sent: Option<String> = launch.and_then(|id| {
        store
            .db
            .query_row(
                "SELECT content FROM messages WHERE id=?1 AND session_id=?2 AND role IN ('user','coordination')",
                params![id, worker.session_id],
                |r| r.get(0),
            )
            .optional()
            .ok()
            .flatten()
    });
    // Both writes or neither (a savepoint nests inside any transaction the caller holds).
    let cleared = store.db.execute_batch("SAVEPOINT effort_relaunch").and_then(|_| {
        let writes = store.db.execute("UPDATE sessions SET reasoning_effort=NULL WHERE id=?1", [&worker.session_id]).and_then(|_| match launch {
            // Only what a refused startup turn produces: its prompt row and error rows. Change
            // records, notes (audit rows) and later prompts stay.
            Some(id) if recorded => store.db.execute(
                "DELETE FROM messages WHERE session_id=?1 AND (id=?2 OR (role='error' AND id>?2))",
                params![worker.session_id, id],
            ),
            _ => Ok(0),
        });
        match writes {
            Ok(_) => store.db.execute_batch("RELEASE effort_relaunch"),
            Err(error) => {
                let _ = store.db.execute_batch("ROLLBACK TO effort_relaunch; RELEASE effort_relaunch");
                Err(error)
            }
        }
    });
    if let Err(error) = cleared {
        eprintln!("Architect: could not relaunch worker {} without its reasoning effort: {error}", worker.id);
        return false;
    }
    launch_prompt(&worker.session_id, true);
    let refused = worker.reasoning_effort.take().unwrap_or_default();
    worker.note = Some(format!("{EFFORT_NOTE} {} refused reasoningEffort {refused} for {} at startup; relaunched with the model's default.", worker.provider, worker.model));
    worker.effort_retried = true;
    if let Some(sent) = sent.filter(|sent| *sent != worker.assignment) {
        worker.resume_prompt = Some(sent);
    }
    worker.status = "queued".into();
    worker.started_at = None;
    worker.error = worker.error.take().and_then(|e| e.find(FAILOVER).map(|i| e[i..].to_string()));
    true
}

/// The prompt row of each worker's current launch, by session (`mark_started`), so an effort
/// relaunch drops exactly that row. In memory only: after a restart nothing is deleted. Kept
/// apart from `worker_approvals`' run registry because it is keyed by session and must outlive
/// the run that recorded it until that run settles.
static LAUNCH_PROMPTS: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<String, i64>>> = std::sync::LazyLock::new(Default::default);

/// Forgets a session's launch record when dropped.
pub(super) struct ForgetLaunch<'a>(pub(super) &'a str);

impl Drop for ForgetLaunch<'_> {
    fn drop(&mut self) {
        launch_prompt(self.0, true);
    }
}

/// Records a worker launch's prompt row (0 when it saved none, which forgets any earlier one).
pub(super) fn record_launch(sid: &str, turn_message_id: i64) {
    let mut prompts = LAUNCH_PROMPTS.lock().unwrap_or_else(|e| e.into_inner());
    if turn_message_id > 0 {
        prompts.insert(sid.to_owned(), turn_message_id);
    } else {
        prompts.remove(sid);
    }
}

/// Forgets a session's launch record (a run that ends without settling through `completed`).
pub(crate) fn forget_launch(sid: &str) {
    launch_prompt(sid, true);
}

/// The recorded prompt row of a worker's launch; `take` forgets it.
pub(super) fn launch_prompt(sid: &str, take: bool) -> Option<i64> {
    let mut prompts = LAUNCH_PROMPTS.lock().unwrap_or_else(|e| e.into_inner());
    if take { prompts.remove(sid) } else { prompts.get(sid).copied() }
}

/// The turn ended before the harness produced anything: no reply text and no tool since its prompt.
/// Looks only after the launch's own prompt row (`launch_anchor`), so a coordination row that
/// arrived mid-turn cannot hide the turn's earlier reply.
pub(super) fn refused_at_startup(store: &Store, sid: &str) -> bool {
    let Some(anchor) = launch_anchor(store, sid) else { return false };
    store
        .db
        .query_row(
            "SELECT NOT EXISTS(SELECT 1 FROM messages WHERE session_id=?1 AND (role='tool' OR (role='assistant' AND trim(content)<>'')) AND id>?2)",
            params![sid, anchor],
            |r| r.get(0),
        )
        .unwrap_or(false)
}

/// The prompt row of a worker's current launch: the one `mark_started` recorded, else (after an
/// app restart) the newest prompt row. The startup check and the relaunch share it.
pub(super) fn launch_anchor(store: &Store, sid: &str) -> Option<i64> {
    launch_prompt(sid, false).or_else(|| {
        store
            .db
            .query_row("SELECT MAX(id) FROM messages WHERE session_id=?1 AND role IN ('user','coordination')", [sid], |r| r.get::<_, Option<i64>>(0))
            .ok()
            .flatten()
    })
}

/// Whether this failed worker run is relaunched once without its reasoning effort: it has an
/// effort, was not already relaunched for it, and the harness refused it at startup.
pub(super) fn relaunches_for_effort(store: &Store, worker: &Worker, error: Option<&str>) -> bool {
    !worker.timed_out
        && !worker.abandoned
        && !worker.effort_retried
        && worker.reasoning_effort.is_some()
        && error.is_some_and(model_efforts::rejected)
        && refused_at_startup(store, &worker.session_id)
}

/// Whether a run's harness error counts against the model's health: everything but the startup
/// effort refusal the team relaunches without the effort (the same test `completed` applies).
pub(crate) fn counts_against_model(store: &Store, admission: Option<&Admission>, sid: &str, error: &str) -> bool {
    let Some(admission) = admission.filter(|a| a.parent != sid) else { return true };
    let Ok(Some(team)) = load(store, &admission.parent) else { return true };
    let worker = team.workers.iter().find(|w| w.session_id == sid);
    !(team.generation == admission.generation && worker.is_some_and(|w| relaunches_for_effort(store, w, Some(error))))
}
