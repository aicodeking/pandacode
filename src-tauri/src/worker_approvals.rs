//! Team workers never wait on a person. The lead started the team with the user's
//! authority, so a worker's approvals are granted here and its questions are answered
//! with "decide yourself" (or a sensible choice), before either reaches bots, the tray or
//! the window. What cannot be resolved ends the worker's turn with a reason for its lead.
use crate::{architect::Admission, providers::RunInput, remove_pending_request, storage::Store, AgentEvent, RunningAgent};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex},
    time::Duration,
};

/// The answer a worker gets when it asks the user a question.
pub(crate) const NO_USER_ANSWER: &str =
    "No user is available; decide yourself using your best judgment and continue.";
/// Told to a worker whose always-ask tool call was declined, so it asks its lead instead.
const ASK_LEAD: &str = "PandaCode declined this action automatically: team workers cannot run billable or outward-facing tools that always ask for approval. Ask your lead to run it or to decide, then continue with the rest of your work.";
const AUDIT_LIMIT: usize = 300;
/// Starts every transcript note for an automatic stop (held until the stop is confirmed).
const STOPPED_NOTE: &str = "Stopped the team worker";
/// The whole wait for a question, answer and fallback together (`respond_user_input`'s).
const ANSWER_TIMEOUT: Duration = Duration::from_secs(15);
/// How long the first answer alone may take before the fallback is sent too.
const FIRST_ANSWER_WAIT: Duration = Duration::from_secs(10);

type Registry = Arc<Mutex<HashMap<String, RunningAgent>>>;

/// The run a sink belongs to. A worker request is only ever resolved on, or stops, this run:
/// a newer run registered for the same task is never touched by an older run's request.
#[derive(Clone)]
pub(crate) struct Run {
    pub(crate) id: String,
    /// Weak, so the sink never keeps a finished run's input open.
    pub(crate) input: tokio::sync::mpsc::WeakUnboundedSender<RunInput>,
    pub(crate) stopped: Arc<AtomicBool>,
    pub(crate) approvals: Arc<Mutex<HashSet<String>>>,
    pub(crate) requests: Arc<Mutex<HashMap<String, AgentEvent>>>,
}
impl Run {
    pub(crate) fn of(agent: &RunningAgent) -> Self {
        Self {
            id: agent.run_id.clone(),
            input: agent.input.downgrade(),
            stopped: agent.stopped.clone(),
            approvals: agent.approvals.clone(),
            requests: agent.pending_requests.clone(),
        }
    }

    /// Takes a request off this run's pending lists. Lock order approvals -> pending requests.
    fn clear(&self, request_id: Option<&str>) {
        let Some(request_id) = request_id else { return };
        match (self.approvals.lock(), self.requests.lock()) {
            (Ok(mut approvals), Ok(mut requests)) => remove_pending_request(&mut approvals, Some(&mut requests), request_id),
            _ => eprintln!("PandaCode: could not clear a team worker request {request_id}"),
        }
    }
}

/// Whether this launch is a team worker's: admitted to a team whose lead is another session.
pub(crate) fn is_worker_launch(team: Option<&Admission>, session_id: &str) -> bool {
    team.is_some_and(|admission| admission.parent != session_id)
}

/// Resolves a just-saved approval or question on a worker run. On success the event is
/// rewritten to its cancelled kind (keeping the request text) so nothing shows it as
/// pending; what cannot be resolved stops the run instead, and a request on a run that is gone
/// is cleared. For a worker it always acts (returns true): nothing is surfaced to the user.
/// Lock order: registry -> approvals -> pending requests -> store (as `respond_approval`);
/// the caller must hold none of these.
pub(crate) fn resolve_if_worker(
    worker: bool,
    run: &Run,
    agents: &Registry,
    store: &Arc<Mutex<Store>>,
    event: &mut AgentEvent,
) -> bool {
    // The harness settled a question itself: an answer still in flight no longer stops the turn.
    if worker && event.kind == "input_cancelled" {
        if let Some(request_id) = &event.request_id {
            in_flight(request_id, false);
        }
    }
    if !worker || !matches!(event.kind.as_str(), "approval" | "input_request") {
        return false;
    }
    let context = Context { agents: agents.clone(), store: store.clone() };
    let cancelled = if event.kind == "approval" { "approval_cancelled" } else { "input_cancelled" };
    let outcome = match agents.lock() {
        // The registered agent is this run: resolve through it.
        Ok(registry) => match registry.get(&event.session_id).filter(|agent| agent.run_id == run.id) {
            Some(agent) => resolve_on(agent, &context, event, cancelled),
            // This run is no longer the registered one (it is ending, or a newer run took the
            // task): stop only this run, never the newer one.
            None => stop_own_run(run, event, cancelled, "the run was no longer registered"),
        },
        Err(_) => stop_own_run(run, event, cancelled, "the agent registry was unavailable"),
    };
    match outcome {
        Ok((kind, note)) => {
            eprintln!("PandaCode: team worker {}: {note}", event.session_id);
            event.text = audit_text(note, &event.text);
            event.kind = kind.into();
            // A stop's note waits for the run's end to confirm the stop ended the run.
            if note.starts_with(STOPPED_NOTE) {
                defer_note(&run.id, &event.session_id, event.text.clone());
            } else {
                record(store, &event.session_id, &event.text);
            }
            true
        }
        Err(error) => {
            // The run is gone: no one could act on the request, so it is cleared, never shown.
            eprintln!("PandaCode: team worker {} request dropped; its run is gone: {error}", event.session_id);
            run.clear(event.request_id.as_deref());
            // The task's status is this run's only while no newer run owns the task.
            let newer = agents.lock().map(|registry| registry.get(&event.session_id).is_some_and(|agent| agent.run_id != run.id)).unwrap_or(true);
            // A run already stopped is ending: its end sets the status.
            if !newer && !run.stopped.load(Ordering::SeqCst) {
                let waiting = run.approvals.lock().map(|approvals| !approvals.is_empty()).unwrap_or(false);
                if let Err(error) = store.lock().map_err(|e| e.to_string()).and_then(|db| db.status(&event.session_id, if waiting { "waiting" } else { "running" })) {
                    eprintln!("PandaCode: could not update team worker {} status: {error}", event.session_id);
                }
            }
            event.text = audit_text("Dropped: the team worker's run is gone", &event.text);
            event.kind = cancelled.into();
            // The task's transcript belongs to a newer run if one took over: only logged then.
            if newer {
                eprintln!("PandaCode: team worker {}: {}", event.session_id, event.text);
            } else {
                record(store, &event.session_id, &event.text);
            }
            true
        }
    }
}

/// Resolves a request on its live, registered run. Whatever fails ends the worker's turn with the
/// reason; a run the team already stopped just drops the request.
fn resolve_on(agent: &RunningAgent, context: &Context, event: &AgentEvent, cancelled: &'static str) -> Resolution {
    let run = Run::of(agent);
    if run.stopped.load(Ordering::SeqCst) {
        // Paused, stopped or cancelled meanwhile: nothing will answer it, and nothing failed.
        run.clear(event.request_id.as_deref());
        return Ok((cancelled, "Dropped: the team worker was already stopped"));
    }
    if event.request_id.is_none() {
        stop_run(&run, event, &format!("a request arrived without an ID ({})", subject(event)))?;
        return Ok((cancelled, "Stopped the team worker: the request had no ID"));
    }
    let resolved = match event.kind.as_str() {
        "approval" => decide(agent, context, event),
        _ => answer(agent, context.clone(), event),
    };
    resolved.or_else(|error| {
        eprintln!("PandaCode: could not resolve a team worker request: {error}");
        if run.stopped.load(Ordering::SeqCst) {
            run.clear(event.request_id.as_deref());
            return Ok((cancelled, "Dropped: the team worker was already stopped"));
        }
        stop_run(&run, event, &format!("a request could not be resolved automatically ({}: {error})", subject(event)))?;
        Ok((cancelled, "Stopped the team worker: the request could not be resolved"))
    })
}

/// Stops the sink's own run when the registry cannot be used for it. Fails only when the run is
/// gone (its input is closed); the caller then clears the request instead of surfacing it.
fn stop_own_run(run: &Run, event: &AgentEvent, cancelled: &'static str, why: &str) -> Resolution {
    if run.stopped.load(Ordering::SeqCst) {
        run.clear(event.request_id.as_deref());
        return Ok((cancelled, "Dropped: the team worker was already stopped"));
    }
    stop_run(run, event, &format!("a request could not be resolved automatically ({}: {why})", subject(event)))?;
    Ok((cancelled, "Stopped the team worker: the request could not be resolved"))
}

/// The harness could not take a decision made for a worker (no matching choice), so it would wait
/// forever: the worker's run is stopped with the reason. A user's own run ignores it.
pub(crate) fn stop_unanswered(worker: bool, run: &Run, event: &AgentEvent) {
    if !worker || run.stopped.load(Ordering::SeqCst) {
        return;
    }
    let request = format!("{}:{}", run.id, event.request_id.as_deref().unwrap_or_default());
    let shown = AgentEvent { request_id: Some(request), ..event.clone() };
    match stop_run(run, &shown, "the harness could not take the automatic decision on a request") {
        Ok(()) => defer_note(&run.id, &event.session_id, format!("{STOPPED_NOTE}: the harness could not take the automatic decision")),
        Err(error) => eprintln!("PandaCode: could not stop team worker {}: {error}", event.session_id),
    }
}

/// Keeps the automatic decision in the worker's transcript as a note (`system` row), so it
/// can be audited later, not only from the live event and the log.
fn record(store: &Arc<Mutex<Store>>, session_id: &str, text: &str) {
    if let Err(error) = store.lock().map_err(|e| e.to_string()).and_then(|db| db.message(session_id, "system", text).map(|_| ())) {
        eprintln!("PandaCode: could not record a team worker decision: {error}");
    }
}

/// What a run's automatic request handling keeps until it settles (`RUNS`: one cap, one drain in
/// `settle_run`/`forget_run`). Decline reasons and launch prompts are keyed by session instead.
#[derive(Default)]
struct RunState {
    /// Why PandaCode stopped the run (requests it could not resolve), distinct, in order.
    reasons: Vec<String>,
    /// Automatic answers the harness has not settled yet, by full request ID.
    in_flight: Vec<String>,
    /// The run's loop took a stop (it reported `providers::STOPPING_STATUS`).
    stop_taken: bool,
    /// A user or the team stopped the run (`RunningAgent::send(Stop)`), not the automatic stop.
    stopped_by_owner: bool,
    /// The automatic stop's error event and transcript notes (session, text), held until the
    /// run's end confirms the stop ended it (`settle_run`): a run that finished first shows none.
    shown: Vec<AgentEvent>,
    notes: Vec<(String, String)>,
}
impl RunState {
    /// Only an owner's stop mark: nothing a settle would lose by dropping it early.
    fn idle(&self) -> bool {
        self.reasons.is_empty() && self.in_flight.is_empty() && !self.stop_taken && self.shown.is_empty() && self.notes.is_empty()
    }

    fn is_empty(&self) -> bool {
        self.reasons.is_empty() && self.in_flight.is_empty() && !self.stop_taken && !self.stopped_by_owner && self.shown.is_empty() && self.notes.is_empty()
    }
}

/// Most runs the registry keeps; the oldest goes first, so runs that never settle cannot grow it.
const RUNS_MAX: usize = 256;
type Runs = Vec<(String, RunState)>;
static RUNS: Mutex<Runs> = Mutex::new(Vec::new());

fn runs() -> std::sync::MutexGuard<'static, Runs> {
    RUNS.lock().unwrap_or_else(|poison| poison.into_inner())
}

/// A run's state in `runs`, added (dropping the oldest at the cap) when new.
fn run_entry<'a>(runs: &'a mut Runs, run_id: &str) -> &'a mut RunState {
    let index = match runs.iter().position(|(id, _)| id == run_id) {
        Some(index) => index,
        None => {
            // At the cap the oldest idle mark goes (an owner's stop with nothing else kept). A
            // run holding a reason, an answer in flight, a taken stop or a deferred stop trace is
            // never dropped: the registry then grows past the cap until those runs settle.
            if runs.len() >= RUNS_MAX {
                if let Some(idle) = runs.iter().position(|(_, state)| state.idle()) {
                    runs.remove(idle);
                }
            }
            runs.push((run_id.to_owned(), RunState::default()));
            runs.len() - 1
        }
    };
    &mut runs[index].1
}

/// Updates a run's state; a state left empty is removed.
fn with_run<R>(run_id: &str, update: impl FnOnce(&mut RunState) -> R) -> R {
    let mut runs = runs();
    let result = update(run_entry(&mut runs, run_id));
    runs.retain(|(id, state)| id != run_id || !state.is_empty());
    result
}

/// Whether the registry keeps anything for the run (tests).
#[cfg(test)]
pub(crate) fn has_run(run_id: &str) -> bool {
    runs().iter().any(|(id, _)| id == run_id)
}

/// Removes a run's state and returns it.
fn take_run(run_id: &str) -> RunState {
    let mut runs = runs();
    runs.iter().position(|(id, _)| id == run_id).map(|index| runs.remove(index).1).unwrap_or_default()
}

/// The run a full request ID (`<run>:<harness id>`) belongs to.
fn run_of(request_id: &str) -> &str {
    request_id.split_once(':').map_or(request_id, |(run, _)| run)
}

fn in_flight(request_id: &str, add: bool) {
    with_run(run_of(request_id), |state| {
        state.in_flight.retain(|id| id != request_id);
        if add {
            state.in_flight.push(request_id.to_owned());
        }
    });
}

fn is_in_flight(request_id: &str) -> bool {
    let run = run_of(request_id);
    runs().iter().any(|(id, state)| id == run && state.in_flight.iter().any(|flying| flying == request_id))
}

/// Records why PandaCode stopped a run, for the lead to see at its end.
fn record_reason(run_id: &str, reason: &str) {
    with_run(run_id, |state| {
        if !state.reasons.iter().any(|known| known == reason) {
            state.reasons.push(reason.to_owned());
        }
    });
}

fn joined(reasons: Vec<String>) -> Option<String> {
    (!reasons.is_empty()).then(|| reasons.join(" "))
}

/// The reason this run was stopped for an unresolvable request, taken once at its end so the
/// lead sees it as the worker's failure. Every reason recorded for the run is drained; several
/// distinct ones are joined in the order they happened.
#[cfg(test)]
pub(crate) fn take_unresolved(run_id: &str) -> Option<String> {
    joined(with_run(run_id, |state| std::mem::take(&mut state.reasons)))
}

/// Forgets everything kept for a run when it ends without settling (a cloud run left
/// re-attachable at shutdown), so the registry never keeps it.
pub(crate) fn forget_run(run_id: &str) {
    take_run(run_id);
}

pub(crate) fn stopped_by_owner(run_id: &str) {
    with_run(run_id, |state| state.stopped_by_owner = true);
}

/// The run's loop took a stop: an automatic stop really ended its turn.
pub(crate) fn stop_taken(run_id: &str) {
    with_run(run_id, |state| state.stop_taken = true);
}

/// The pooled run moved to another account: what the old account left open is settled without a
/// stop. Any run, a user's too; returns the cancel events that drop the stale cards.
pub(crate) fn account_switched(run: &Run, session_id: &str) -> Vec<AgentEvent> {
    with_run(&run.id, |state| state.in_flight.clear());
    // Lock order approvals -> pending requests.
    let (Ok(mut approvals), Ok(mut requests)) = (run.approvals.lock(), run.requests.lock()) else { return Vec::new() };
    let cancelled = approvals
        .drain()
        .map(|request_id| {
            let question = requests.get(&request_id).is_some_and(|request| request.kind == "input_request");
            AgentEvent {
                session_id: session_id.to_owned(),
                kind: if question { "input_cancelled" } else { "approval_cancelled" }.into(),
                text: String::new(),
                request_id: Some(request_id),
                data: None,
                tool: None,
            }
        })
        .collect();
    requests.clear();
    cancelled
}

/// Settles a run's automatic stop at its end and forgets its state. The reason stands only if the
/// run's loop took the stop and no user or team stop raced it.
pub(crate) fn settle_run(run_id: &str, was_stopped: bool) -> Settled {
    let state = take_run(run_id);
    let (reason, stopped) = match joined(state.reasons) {
        // The user or the team stopped the run too: their stop is what ended it.
        Some(_) if state.stopped_by_owner => (None, was_stopped),
        // The run ended before its loop took the automatic stop: the harness finished the turn,
        // or failed on its own (a crash), whose error then stands, for health and failover.
        Some(_) if !state.stop_taken => (None, false),
        reason => (reason, was_stopped),
    };
    // The stop's error event and notes appear only when the automatic stop ended the run.
    let confirmed = reason.is_some();
    Settled {
        reason,
        stopped,
        notes: if confirmed { state.notes } else { Vec::new() },
        shown: if confirmed { state.shown } else { Vec::new() },
    }
}

/// A run's settled automatic stop (`settle_run`).
#[derive(Debug, Default)]
pub(crate) struct Settled {
    /// Why PandaCode stopped the run, when that stop is what ended it.
    pub(crate) reason: Option<String>,
    /// Whether the run counts as stopped.
    pub(crate) stopped: bool,
    /// Transcript notes (session, text) for the run's end to record.
    pub(crate) notes: Vec<(String, String)>,
    /// Error events for the run's end to show.
    pub(crate) shown: Vec<AgentEvent>,
}

/// Holds a stop's transcript note until the run's end confirms the stop.
fn defer_note(run_id: &str, session_id: &str, text: String) {
    with_run(run_id, |state| state.notes.push((session_id.to_owned(), text)));
}

type Resolution = crate::Result<(&'static str, &'static str)>;

fn audit_text(note: &str, original: &str) -> String {
    let original: String = original.chars().take(AUDIT_LIMIT).collect();
    format!("{note}: {original}")
}

/// Approves, or declines what a worker may not run or the harness cannot approve. With no
/// usable choice at all the worker's turn ends, so it never waits.
fn decide(agent: &RunningAgent, context: &Context, event: &AgentEvent) -> Resolution {
    let choices = event.data.as_ref().map(|data| &data["museChoices"]).filter(|c| c.is_object());
    let (can_approve, can_deny) = choices.map_or((true, true), |c| (c["approve"] == true, c["deny"] == true));
    let store = context.store.as_ref();
    if always_asks(event) && can_deny {
        // Where the decline carries text back to the model, it says what to do; elsewhere the
        // live turn is told instead.
        let carried = carries_decline_text(agent, event);
        if let Some(id) = &carried {
            crate::providers::set_decline_reason(&event.session_id, id, &decline_reason(event));
        }
        if let Err(error) = respond(agent, store, event, false) {
            if let Some(id) = &carried {
                crate::providers::take_decline_reason(&event.session_id, id);
            }
            return Err(error);
        }
        // Elsewhere the live turn is told, only on a harness that takes it mid-turn: one that
        // would queue it as a new turn gets nothing (the decline alone suffices).
        if carried.is_none() && steers_live(store, &event.session_id) {
            tell(agent, &event.session_id, ASK_LEAD);
        }
        return Ok(("approval_cancelled", "Declined automatically for a team worker (ask the lead)"));
    }
    if always_asks(event) || (!can_approve && !can_deny) {
        stop_run(&Run::of(agent), event, &format!("an approval could not be resolved automatically ({})", subject(event)))?;
        return Ok(("approval_cancelled", "Stopped the team worker: no automatic choice"));
    }
    if !can_approve {
        respond(agent, store, event, false)?;
        return Ok(("approval_cancelled", "Declined automatically for a team worker (no approve choice offered)"));
    }
    respond(agent, store, event, true)?;
    Ok(("approval_cancelled", "Approved automatically for a team worker"))
}

fn steers_live(store: &Mutex<Store>, session_id: &str) -> bool {
    store.lock().ok().and_then(|db| db.session(session_id).ok()).is_some_and(|session| crate::providers::steers_live(&session.provider))
}

fn respond(agent: &RunningAgent, store: &Mutex<Store>, event: &AgentEvent, approved: bool) -> crate::Result<()> {
    let request_id = event.request_id.clone().ok_or("Approval request ID is missing.")?;
    agent.respond_approval(store, &event.session_id, request_id, approved)
}

/// Steers the guidance into the live turn when the decline carries no text (`carries_decline_text`);
/// a stopped run gets nothing, so no extra turn starts.
fn tell(agent: &RunningAgent, session_id: &str, text: &str) {
    if agent.stopped.load(Ordering::SeqCst) {
        return;
    }
    let (reply, _accepted) = tokio::sync::oneshot::channel();
    let steer = RunInput::Steer { id: uuid::Uuid::new_v4().to_string(), text: text.into(), reply };
    if agent.send(steer).is_err() {
        eprintln!("PandaCode: could not tell team worker {session_id} to ask its lead");
    }
}

/// The request's first line, bounded, to name it in a stop reason.
fn subject(event: &AgentEvent) -> String {
    event.text.lines().next().unwrap_or_default().chars().take(120).collect()
}

/// Ends the run's turn (as `RunningAgent::send(Stop)` does) with a reason the lead sees.
fn stop_run(run: &Run, event: &AgentEvent, why: &str) -> crate::Result<()> {
    let reason = format!("Stopped: {why}; reassign the work or do it yourself.");
    eprintln!("PandaCode: team worker {}: {reason}", event.session_id);
    // Marked first, as `RunningAgent::send(Stop)` does, so the run's end reads it as stopped;
    // undone if the stop cannot be delivered.
    let was_stopped = run.stopped.swap(true, Ordering::SeqCst);
    let sent = run.input.upgrade().is_some_and(|input| input.send(RunInput::Stop).is_ok());
    if !sent {
        run.stopped.store(was_stopped, Ordering::SeqCst);
        return Err("Agent has stopped.".into());
    }
    // After the send, so a failed send leaves no reason; safe, as the run settles only after its
    // loop returned and this sink call finished.
    record_reason(&run.id, &reason);
    // Nothing answers this request now: tray and remote snapshots must not list it as pending.
    // Lock order: the caller holds the registry; approvals -> pending requests.
    run.clear(event.request_id.as_deref());
    let mut shown = event.clone();
    (shown.kind, shown.text, shown.request_id, shown.data, shown.tool) = ("error".into(), reason, None, None, None);
    // Shown by the run's end once it confirms this stop ended the run (`settle_run`).
    with_run(&run.id, |state| state.shown.push(shown));
    Ok(())
}

/// Tools that ask on every call even in full access (`cloud::deploy::ALWAYS_ASK`), matched
/// by exact tool name: the `Allow <tool>?` request line (MCP-prefixed names included), the
/// request's tool field, or its tool activity. Never a substring of a command line.
fn always_asks(event: &AgentEvent) -> bool {
    always_ask_tool(event).is_some()
}

/// The always-ask tool this request is for, by its PandaCode name. The label is either
/// `Allow <tool>?` (PandaCode's tool host, Codex host tools) or the bare tool name, MCP prefix
/// included (Claude's permission prompt); a tool activity on the event counts too. Event data
/// carries no tool arguments (`event_metadata` keeps only a few scalar keys).
pub(crate) fn always_ask_tool(event: &AgentEvent) -> Option<&'static str> {
    let line = event.text.lines().next().unwrap_or_default().trim();
    let names = [
        line.strip_prefix("Allow ").and_then(|rest| rest.strip_suffix('?')),
        Some(line),
        event.tool.as_ref().map(|tool| tool.name.as_str()),
    ];
    names.into_iter().flatten().find_map(|name| {
        crate::cloud::deploy::ALWAYS_ASK
            .iter()
            .find(|tool| name == **tool || name.strip_suffix(**tool).is_some_and(|prefix| prefix.ends_with("__")))
            .copied()
    })
}

/// What the model reads when a team worker's always-ask tool is declined for it.
fn decline_reason(event: &AgentEvent) -> String {
    let tool = always_ask_tool(event).unwrap_or("this tool");
    format!("Declined: team workers cannot run {tool}; ask your lead to run it or decide, then continue with the rest of your work.")
}

/// The harness's approval ID when this approval's decline returns text to the model: PandaCode's
/// MCP tool host (`mcp-approval:` IDs), Codex host tools (`item/tool/call`) and Claude's
/// permission control (`control_request`). Other harnesses decline without text.
fn carries_decline_text(agent: &RunningAgent, event: &AgentEvent) -> Option<String> {
    let id = original_id(agent, event).ok()?;
    let data = event.data.as_ref();
    let carried = id.starts_with("mcp-approval:")
        || data.is_some_and(|data| data["method"] == "item/tool/call" || data["type"] == "control_request");
    carried.then_some(id)
}

/// What a worker request needs after the sink returns.
#[derive(Clone)]
struct Context {
    agents: Registry,
    store: Arc<Mutex<Store>>,
}

/// Sends the answer, then the cancel if the answer is refused or slow, and clears the
/// pending request once the harness takes either, as `respond_user_input` does. If the
/// question is still pending when the wait ends, the worker's turn is stopped.
fn answer(agent: &RunningAgent, context: Context, event: &AgentEvent) -> Resolution {
    let request_id = original_id(agent, event)?;
    let data = event.data.clone().unwrap_or(Value::Null);
    let answerer = Answerer { watched: event.request_id.clone(), ..Answerer::of(agent) };
    let first = answerer.send(&request_id, preferred_response(&data))?;
    let pending = Pending { context, run_id: agent.run_id.clone(), original: event.clone() };
    in_flight(pending.request_id(), true);
    pending.hide(agent);
    tauri::async_runtime::spawn(async move {
        let session = pending.original.session_id.clone();
        let between_accounts = move || crate::providers::switching_accounts(&session);
        if settle(first, &answerer, &request_id, &data, &between_accounts).await || !pending.still_pending() {
            pending.clear();
        } else {
            pending.stop();
        }
    });
    Ok(("input_cancelled", "Answered automatically for a team worker"))
}

type Accepted = tokio::sync::oneshot::Receiver<crate::Result<()>>;

/// Whether the harness took the answer or the fallback within one `ANSWER_TIMEOUT`. A
/// first answer acknowledged late, after the fallback was sent, still counts.
async fn settle(first: Accepted, input: &Answerer, request_id: &str, data: &Value, unreachable: &(dyn Fn() -> bool + Sync)) -> bool {
    settle_within(first, input, request_id, data, FIRST_ANSWER_WAIT, ANSWER_TIMEOUT, unreachable).await
}

/// Most extra time a question may wait while its pooled run changes accounts.
const SWITCH_ALLOWANCE: Duration = Duration::from_secs(120);
const SWITCH_POLL: Duration = Duration::from_millis(100);

/// A timeout while the run cannot take input (`unreachable`: a pooled run changing accounts,
/// which holds the answer until the next account starts) is not final: the wait goes on until
/// the account is ready, then allows `grace`, never past `cap`. Returns the new deadline, or
/// `None` when the timeout stands.
async fn extend_while_unreachable(unreachable: &(dyn Fn() -> bool + Sync), grace: Duration, cap: tokio::time::Instant) -> Option<tokio::time::Instant> {
    if !unreachable() {
        return None;
    }
    while unreachable() && tokio::time::Instant::now() < cap {
        tokio::time::sleep(SWITCH_POLL).await;
    }
    let now = tokio::time::Instant::now();
    (now < cap).then(|| (now + grace).min(cap))
}

async fn settle_within(
    first: Accepted,
    input: &Answerer,
    request_id: &str,
    data: &Value,
    first_wait: Duration,
    total: Duration,
    unreachable: &(dyn Fn() -> bool + Sync),
) -> bool {
    let started = tokio::time::Instant::now();
    let cap = started + total + SWITCH_ALLOWANCE;
    let mut deadline = started + total;
    let mut first = Some(first);
    let mut first_deadline = started + first_wait;
    let first_reply = loop {
        match tokio::time::timeout_at(first_deadline, first.as_mut().unwrap()).await {
            Ok(reply) => break Some(reply),
            Err(_) => match extend_while_unreachable(unreachable, first_wait, cap).await {
                Some(later) => {
                    first_deadline = later;
                    deadline = deadline.max(later + (total - first_wait.min(total)));
                }
                None => break None,
            },
        }
    };
    match first_reply {
        Some(Ok(Ok(()))) => return true,
        Some(_) => first = None,
        None => {}
    }
    let mut second = input.send_fallback(request_id, fallback_response(data)).ok();
    while first.is_some() || second.is_some() {
        let next = tokio::time::timeout_at(deadline, async {
            tokio::select! {
                taken = async { first.as_mut().unwrap().await }, if first.is_some() => (true, taken),
                taken = async { second.as_mut().unwrap().await }, if second.is_some() => (false, taken),
            }
        })
        .await;
        match next {
            Err(_) => match extend_while_unreachable(unreachable, first_wait, cap).await {
                Some(later) => deadline = later,
                None => return false,
            },
            Ok((_, Ok(Ok(())))) => return true,
            Ok((true, _)) => first = None,
            Ok((false, _)) => second = None,
        }
    }
    false
}

/// Sends a worker's automatic answers as `RunningAgent::send` does, restarting the team
/// watchdog's silence clock with each one.
struct Answerer {
    /// Weak, as `Run`'s: a pending answer never keeps a finished run's input open.
    input: tokio::sync::mpsc::WeakUnboundedSender<RunInput>,
    last_event: Arc<std::sync::atomic::AtomicI64>,
    /// The question's full request ID: its fallback goes only while the answer is still in flight.
    watched: Option<String>,
}
impl Answerer {
    fn of(agent: &RunningAgent) -> Self {
        Self { input: agent.input.downgrade(), last_event: agent.last_event.clone(), watched: None }
    }

    /// The fallback, unless the question was settled meanwhile (never sent to a new account).
    fn send_fallback(&self, request_id: &str, response: Value) -> crate::Result<Accepted> {
        if self.watched.as_deref().is_some_and(|watched| !is_in_flight(watched)) {
            return Err("The question was settled.".into());
        }
        self.send(request_id, response)
    }

    fn send(&self, request_id: &str, response: Value) -> crate::Result<Accepted> {
        let (reply, accepted) = tokio::sync::oneshot::channel();
        self.last_event.store(crate::storage::now(), Ordering::SeqCst);
        self.input
            .upgrade()
            .ok_or("Agent has stopped.")?
            .send(RunInput::UserInput { request_id: request_id.into(), response, reply: Some(reply) })
            .map_err(|_| "Agent has stopped.".to_string())?;
        Ok(accepted)
    }
}

/// A worker question awaiting the harness's acknowledgement.
struct Pending {
    context: Context,
    run_id: String,
    original: AgentEvent,
}
impl Pending {
    /// Runs `action` on this launch's run while it is still registered and not stopped,
    /// mirroring `respond_user_input`, so a finished worker is never touched.
    fn with_live<T>(&self, action: impl FnOnce(&RunningAgent) -> crate::Result<T>) -> crate::Result<Option<T>> {
        let registry = self.context.agents.lock().map_err(|e| e.to_string())?;
        let live = registry
            .get(&self.original.session_id)
            .filter(|agent| agent.run_id == self.run_id && !agent.stopped.load(Ordering::SeqCst));
        live.map(action).transpose()
    }

    fn request_id(&self) -> &str {
        self.original.request_id.as_deref().unwrap_or_default()
    }

    /// Whether the harness has not resolved the question by any route (its own
    /// `input_cancelled` also settles it) while this run is live.
    fn still_pending(&self) -> bool {
        is_in_flight(self.request_id()) && self.with_live(|_| Ok(())).is_ok_and(|live| live.is_some())
    }

    /// Takes the question off the pending lists while its answer is in flight, so the tray and
    /// remote snapshots never list it, and the worker reads as running again. The caller holds
    /// the registry; lock order approvals -> pending requests -> store.
    fn hide(&self, agent: &RunningAgent) {
        let result = (|| {
            let mut approvals = agent.approvals.lock().map_err(|e| e.to_string())?;
            let mut requests = agent.pending_requests.lock().map_err(|e| e.to_string())?;
            remove_pending_request(&mut approvals, Some(&mut requests), self.request_id());
            let status = if approvals.is_empty() { "running" } else { "waiting" };
            self.context.store.lock().map_err(|e| e.to_string())?.status(&self.original.session_id, status)
        })();
        if let Err(error) = result {
            eprintln!("PandaCode: could not hide team worker {} question: {error}", self.original.session_id);
        }
    }

    /// Lock order registry -> approvals -> pending requests -> store.
    fn clear(&self) {
        in_flight(self.request_id(), false);
        let result = self.with_live(|agent| {
            let mut approvals = agent.approvals.lock().map_err(|e| e.to_string())?;
            let mut requests = agent.pending_requests.lock().map_err(|e| e.to_string())?;
            remove_pending_request(&mut approvals, Some(&mut requests), self.request_id());
            let status = if approvals.is_empty() { "running" } else { "waiting" };
            self.context.store.lock().map_err(|e| e.to_string())?.status(&self.original.session_id, status)
        });
        if let Err(error) = result {
            eprintln!("PandaCode: could not clear team worker {} question: {error}", self.original.session_id);
        }
    }

    /// Neither answer was taken and the question is still open: end the worker's turn.
    fn stop(&self) {
        in_flight(self.request_id(), false);
        let why = format!("a question could not be answered automatically ({})", subject(&self.original));
        match self.with_live(|agent| stop_run(&Run::of(agent), &self.original, &why)) {
            Ok(Some(())) => defer_note(&self.run_id, &self.original.session_id, audit_text(&format!("{STOPPED_NOTE}: no answer was taken"), &self.original.text)),
            Ok(None) => {}
            Err(error) => eprintln!("PandaCode: could not stop team worker {}: {error}", self.original.session_id),
        }
    }
}

fn original_id(agent: &RunningAgent, event: &AgentEvent) -> crate::Result<String> {
    event
        .request_id
        .as_deref()
        .and_then(|id| id.strip_prefix(&format!("{}:", agent.run_id)))
        .map(str::to_owned)
        .ok_or_else(|| "This question belongs to an earlier run.".into())
}

mod answers;
use answers::{fallback_response, preferred_response};

#[cfg(test)]
mod tests;
