use super::*;
use serde_json::json;
use crate::save_approval_with_pending;
use std::sync::atomic::AtomicBool;
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver};

struct Fixture {
    store: Arc<Mutex<Store>>,
    agents: Registry,
    receiver: UnboundedReceiver<RunInput>,
    sid: String,
    run_id: String,
}

fn fixture() -> Fixture {
    let store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let project = store.add_project(&std::env::temp_dir()).unwrap();
    let sid = store.create_session(&project.id, "codex", "default", "ask").unwrap().id;
    let (input, receiver) = unbounded_channel();
    let agent = RunningAgent::new(input, Arc::new(AtomicBool::new(false)));
    let run_id = agent.run_id.clone();
    let agents = Arc::new(Mutex::new(HashMap::from([(sid.clone(), agent)])));
    Fixture { store: Arc::new(Mutex::new(store)), agents, receiver, sid, run_id }
}

fn request(f: &Fixture, kind: &str, text: &str, data: Option<Value>) -> AgentEvent {
    let mut event = AgentEvent {
        session_id: f.sid.clone(),
        kind: kind.into(),
        text: text.into(),
        request_id: Some("7".into()),
        data,
        tool: None,
    };
    let registry = f.agents.lock().unwrap();
    let agent = registry.get(&f.sid).unwrap();
    save_approval_with_pending(&f.store, &agent.approvals, Some(&agent.pending_requests), &f.run_id, &mut event).unwrap();
    event
}

fn resolve(f: &Fixture, worker: bool, event: &mut AgentEvent) -> bool {
    let run = Run::of(f.agents.lock().unwrap().get(&f.sid).unwrap());
    resolve_if_worker(worker, &run, &f.agents, &f.store, event)
}

/// Another run of the same task, with its own input: an older one, or one no longer registered.
fn other_run() -> (Run, UnboundedReceiver<RunInput>) {
    let (input, receiver) = unbounded_channel();
    let agent = RunningAgent::new(input, Arc::new(AtomicBool::new(false)));
    let run = Run::of(&agent);
    // The run's input stays open for the test (a sender is deliberately leaked).
    std::mem::forget(agent.input.clone());
    (run, receiver)
}

#[test]
fn an_older_runs_request_never_touches_the_registered_run() {
    let mut f = fixture();
    let (old, mut old_input) = other_run();
    let mut event = AgentEvent { session_id: f.sid.clone(), kind: "approval".into(), text: "Run `ls`".into(), request_id: Some(format!("{}:3", old.id)), data: None, tool: None };
    assert!(resolve_if_worker(true, &old, &f.agents, &f.store, &mut event));
    assert!(matches!(old_input.try_recv(), Ok(RunInput::Stop)), "only the older run is stopped");
    assert!(f.receiver.try_recv().is_err(), "the registered run is untouched");
    assert!(!f.agents.lock().unwrap().get(&f.sid).unwrap().stopped.load(Ordering::SeqCst));
    assert!(take_unresolved(&f.run_id).is_none());
    assert!(take_unresolved(&old.id).unwrap().contains("no longer registered"));
}

#[test]
fn a_live_run_missing_from_the_registry_is_stopped_through_its_own_handle() {
    let mut f = fixture();
    let mut event = request(&f, "approval", "Run `ls`", None);
    let run = Run::of(f.agents.lock().unwrap().get(&f.sid).unwrap());
    // Keep the run's input open while it is out of the registry.
    let agent = f.agents.lock().unwrap().remove(&f.sid).unwrap();
    assert!(resolve_if_worker(true, &run, &f.agents, &f.store, &mut event), "not shown to the user");
    assert!(matches!(f.receiver.try_recv(), Ok(RunInput::Stop)));
    assert!(agent.approvals.lock().unwrap().is_empty() && agent.pending_requests.lock().unwrap().is_empty());
    assert!(take_unresolved(&f.run_id).is_some());
    // A run that is genuinely gone (its input closed): no one could act on the request, so
    // it is cleared and never shown, and the task is not left waiting.
    let gone = Run::of(&agent);
    let approvals = agent.approvals.clone();
    drop(agent);
    drop(std::mem::replace(&mut f.receiver, unbounded_channel().1));
    let mut event = AgentEvent { session_id: f.sid.clone(), kind: "approval".into(), text: "Run `ls`".into(), request_id: Some("8".into()), data: None, tool: None };
    save_approval_with_pending(&f.store, &gone.approvals, Some(&gone.requests), &gone.id, &mut event).unwrap();
    assert_eq!(status(&f), "waiting");
    gone.stopped.store(false, Ordering::SeqCst);
    assert!(resolve_if_worker(true, &gone, &f.agents, &f.store, &mut event), "never surfaced");
    assert_eq!(event.kind, "approval_cancelled");
    assert!(approvals.lock().unwrap().is_empty() && gone.requests.lock().unwrap().is_empty());
    assert_eq!(status(&f), "running");
}

#[test]
fn a_poisoned_registry_still_stops_the_run() {
    let mut f = fixture();
    let mut event = request(&f, "approval", "Run `ls`", None);
    let run = Run::of(f.agents.lock().unwrap().get(&f.sid).unwrap());
    let agents = f.agents.clone();
    let _ = std::thread::spawn(move || {
        let _held = agents.lock().unwrap();
        panic!("poison the registry");
    })
    .join();
    assert!(f.agents.is_poisoned());
    assert!(resolve_if_worker(true, &run, &f.agents, &f.store, &mut event));
    assert!(matches!(f.receiver.try_recv(), Ok(RunInput::Stop)));
    assert!(take_unresolved(&f.run_id).unwrap().contains("registry was unavailable"));
}

#[test]
fn the_ask_your_lead_steer_goes_only_to_a_harness_that_steers_live() {
    // A decline that carries no text (an ACP permission) on Kimi, which holds steers for a
    // new turn: nothing is sent besides the decline.
    let mut f = fixture();
    f.store.lock().unwrap().db.execute("UPDATE sessions SET provider='kimi' WHERE id=?1", [&f.sid]).unwrap();
    let mut event = request(&f, "approval", "Allow pandacode_cloud_cli?", None);
    assert!(resolve(&f, true, &mut event));
    assert!(!approved(&mut f));
    assert!(f.receiver.try_recv().is_err(), "no steer that could start a new turn");
    // Pi takes it in the running turn.
    let mut f = fixture();
    f.store.lock().unwrap().db.execute("UPDATE sessions SET provider='pi' WHERE id=?1", [&f.sid]).unwrap();
    let mut event = request(&f, "approval", "Allow pandacode_cloud_cli?", None);
    assert!(resolve(&f, true, &mut event));
    assert!(!approved(&mut f));
    assert!(matches!(f.receiver.try_recv().unwrap(), RunInput::Steer { text, .. } if text.contains("Ask your lead")));
}

#[test]
fn a_decision_the_harness_could_not_take_stops_the_worker_and_is_recorded() {
    let mut f = fixture();
    let run = Run::of(f.agents.lock().unwrap().get(&f.sid).unwrap());
    let event = AgentEvent { session_id: f.sid.clone(), kind: crate::providers::UNANSWERED_APPROVAL.into(), text: String::new(), request_id: Some("7".into()), data: None, tool: None };
    stop_unanswered(false, &run, &event);
    assert!(f.receiver.try_recv().is_err(), "a user's run ignores it");
    stop_unanswered(true, &run, &event);
    assert!(matches!(f.receiver.try_recv(), Ok(RunInput::Stop)));
    assert_eq!(system_notes(&f), 0, "the stop's note waits for the run's end");
    let settled = settled_stop(&f);
    assert!(settled.reason.unwrap().contains("could not take the automatic decision"));
    assert!(settled.notes.iter().any(|(_, note)| note.starts_with("Stopped the team worker")), "{:?}", settled.notes);
}

#[test]
fn a_request_without_an_id_stops_the_turn() {
    let mut f = fixture();
    let mut event = AgentEvent { session_id: f.sid.clone(), kind: "approval".into(), text: "Run `ls`".into(), request_id: None, data: None, tool: None };
    assert!(resolve(&f, true, &mut event));
    stopped_with_reason(&mut f, "a request arrived without an ID (Run `ls`)");
}

#[test]
fn a_late_request_on_a_stopped_worker_is_dropped_silently() {
    let mut f = fixture();
    let mut event = request(&f, "approval", "Run `ls`", None);
    // The team paused the worker; its stop is already on the way.
    f.agents.lock().unwrap().get(&f.sid).unwrap().stopped.store(true, Ordering::SeqCst);
    assert!(resolve(&f, true, &mut event));
    assert!(f.receiver.try_recv().is_err(), "nothing sent");
    assert!(take_unresolved(&f.run_id).is_none(), "no false failure for the lead");
    assert!(pending_empty(&f));
    assert!(settle_run(&f.run_id, true).shown.is_empty(), "no error shown");
}

fn status(f: &Fixture) -> String {
    f.store.lock().unwrap().session(&f.sid).unwrap().status
}

fn pending_empty(f: &Fixture) -> bool {
    let registry = f.agents.lock().unwrap();
    let agent = registry.get(&f.sid).unwrap();
    let empty = agent.approvals.lock().unwrap().is_empty() && agent.pending_requests.lock().unwrap().is_empty();
    empty
}

fn eventually(check: impl Fn() -> bool) -> bool {
    (0..200).any(|_| check() || { std::thread::sleep(Duration::from_millis(10)); false })
}

fn questions(is_other: bool) -> Value {
    json!({"kind":"questions","questions":[{"id":"q","question":"Which?","isOther":is_other,"options":[{"label":"A"}]}]})
}

fn next_answer(f: &mut Fixture) -> (String, Value, tokio::sync::oneshot::Sender<crate::Result<()>>) {
    match f.receiver.blocking_recv() {
        Some(RunInput::UserInput { request_id, response, reply }) => (request_id, response, reply.unwrap()),
        _ => panic!("expected an answer"),
    }
}

fn approved(f: &mut Fixture) -> bool {
    match f.receiver.try_recv() {
        Ok(RunInput::Approval { request_id, approved }) if request_id == "7" => approved,
        _ => panic!("expected an approval reply"),
    }
}

#[test]
fn workers_are_detected_from_the_launch_admission() {
    let team = Admission { parent: "lead".into(), generation: 1 };
    assert!(is_worker_launch(Some(&team), "worker"));
    assert!(!is_worker_launch(Some(&team), "lead"));
    assert!(!is_worker_launch(None, "worker"));
}

#[test]
fn worker_approval_is_granted_and_cleared() {
    let mut f = fixture();
    let mut event = request(&f, "approval", "Allow shell?\nls", None);
    assert!(resolve(&f, true, &mut event));
    assert!(approved(&mut f));
    assert_eq!(event.kind, "approval_cancelled");
    assert_eq!(event.text, "Approved automatically for a team worker: Allow shell?\nls");
    assert!(pending_empty(&f));
    assert_eq!(status(&f), "running");
}

#[test]
fn always_ask_tools_are_declined_by_exact_name_only() {
    for name in crate::cloud::deploy::ALWAYS_ASK {
        let mut f = fixture();
        let text = format!("Allow mcp__pandacode__{name}?\n{{}}");
        let mut event = request(&f, "approval", &text, None);
        assert!(resolve(&f, true, &mut event));
        assert!(!approved(&mut f));
        assert!(matches!(f.receiver.try_recv().unwrap(), RunInput::Steer { text, .. } if text.contains("Ask your lead")));
        assert!(event.text.starts_with("Declined automatically") && event.text.ends_with(&text));
        assert_eq!(status(&f), "running");
    }
    let mut f = fixture();
    let mut event = request(&f, "approval", "Run `grep pandacode_cloud_cli src`", None);
    assert!(resolve(&f, true, &mut event));
    assert!(approved(&mut f));
    assert!(f.receiver.try_recv().is_err());
}

fn stopped_with_reason(f: &mut Fixture, needle: &str) {
    assert!(matches!(f.receiver.try_recv().unwrap(), RunInput::Stop));
    let settled = settled_stop(f);
    let reason = settled.reason.unwrap();
    assert!(reason.starts_with("Stopped: ") && reason.contains(needle) && reason.ends_with("do it yourself."), "{reason}");
    assert!(settled.shown.iter().any(|e| e.kind == "error" && e.text == reason), "the error is shown once the stop is confirmed");
}

/// Settles the fixture's run as a confirmed stop (its loop took it), once the stop's deferred
/// error event and note are both held.
fn settled_stop(f: &Fixture) -> Settled {
    assert!(eventually(|| runs().iter().any(|(id, state)| *id == f.run_id && !state.shown.is_empty() && !state.notes.is_empty())));
    stop_taken(&f.run_id);
    settle_run(&f.run_id, true)
}

/// A settled run's reason and stop state.
fn outcome(settled: Settled) -> (Option<String>, bool) {
    (settled.reason, settled.stopped)
}

fn system_notes(f: &Fixture) -> i64 {
    f.store.lock().unwrap().db.query_row("SELECT COUNT(*) FROM messages WHERE session_id=?1 AND role='system'", [&f.sid], |r| r.get(0)).unwrap()
}

#[test]
fn muse_approval_without_an_approve_choice_is_declined_or_stops_the_turn() {
    let mut f = fixture();
    let mut event = request(&f, "approval", "Run `ls`", Some(json!({"museChoices":{"approve":false,"deny":true}})));
    assert!(resolve(&f, true, &mut event));
    assert!(!approved(&mut f));
    assert!(pending_empty(&f));
    let mut f = fixture();
    let mut event = request(&f, "approval", "Run `ls`", Some(json!({"museChoices":{"approve":false,"deny":false}})));
    assert!(resolve(&f, true, &mut event));
    assert_eq!(event.kind, "approval_cancelled");
    stopped_with_reason(&mut f, "(Run `ls`)");
    assert!(pending_empty(&f), "a stopped request is no longer pending");
}

#[test]
fn an_automatic_answer_restarts_the_silence_clock() {
    let mut f = fixture();
    f.agents.lock().unwrap().get(&f.sid).unwrap().last_event.store(0, Ordering::SeqCst);
    let mut event = request(&f, "input_request", "Which?", Some(questions(true)));
    assert!(resolve(&f, true, &mut event));
    let silent = f.agents.lock().unwrap().get(&f.sid).unwrap().silent_for(crate::storage::now());
    assert!(silent < 60_000, "silent for {silent} ms");
    next_answer(&mut f).2.send(Ok(())).unwrap();
}

#[test]
fn a_decline_that_carries_text_says_ask_your_lead_without_a_steer() {
    // The real event shapes (`event_metadata` keeps scalar keys only): Codex host tools label
    // `Allow <tool>?`; Claude's permission prompt is labelled with the bare MCP tool name.
    for (label, data) in [
        ("Allow pandacode_cloud_cli?\n{\"args\":[\"deploy\"]}", json!({"id":"rpc","method":"item/tool/call"})),
        ("mcp__pandacode__pandacode_cloud_cli", json!({"type":"control_request"})),
    ] {
        let mut f = fixture();
        let mut event = request(&f, "approval", label, Some(data));
        assert!(resolve(&f, true, &mut event));
        assert!(!approved(&mut f));
        assert!(f.receiver.try_recv().is_err(), "no steer: the decline itself says it");
        let reason = crate::providers::take_decline_reason(&f.sid, "7").unwrap();
        assert!(reason.starts_with("Declined: team workers cannot run pandacode_cloud_cli;") && reason.contains("ask your lead"), "{reason}");
    }
}

#[test]
fn a_failed_approval_reply_stops_the_worker_instead_of_waiting() {
    let mut f = fixture();
    let mut event = request(&f, "approval", "Run `ls`", None);
    // The reply cannot be given (the approval is no longer pending), so the worker must not wait.
    {
        let registry = f.agents.lock().unwrap();
        let agent = registry.get(&f.sid).unwrap();
        agent.approvals.lock().unwrap().clear();
    }
    assert!(resolve(&f, true, &mut event), "never surfaced to the user");
    assert_eq!(event.kind, "approval_cancelled");
    stopped_with_reason(&mut f, "a request could not be resolved automatically (Run `ls`:");
    assert!(pending_empty(&f));
}

#[test]
fn automatic_decisions_are_kept_in_the_worker_transcript() {
    let mut f = fixture();
    let mut event = request(&f, "approval", "Run `cargo test`", None);
    assert!(resolve(&f, true, &mut event));
    assert!(approved(&mut f));
    let notes: Vec<String> = {
        let store = f.store.lock().unwrap();
        let mut query = store.db.prepare("SELECT content FROM messages WHERE session_id=?1 AND role='system'").unwrap();
        query.query_map([&f.sid], |r| r.get(0)).unwrap().map(Result::unwrap).collect()
    };
    assert_eq!(notes, vec!["Approved automatically for a team worker: Run `cargo test`".to_string()]);
}

#[test]
fn a_run_left_behind_forgets_its_reasons_and_answers() {
    let f = fixture();
    record_reason(&f.run_id, "Stopped: x.");
    in_flight(&format!("{}:9", f.run_id), true);
    forget_run(&f.run_id);
    assert!(take_unresolved(&f.run_id).is_none());
    assert!(!is_in_flight(&format!("{}:9", f.run_id)));
}

#[test]
fn every_reason_for_a_run_is_drained_at_once() {
    let f = fixture();
    record_reason(&f.run_id, "Stopped: first.");
    record_reason("other-run", "Stopped: elsewhere.");
    record_reason(&f.run_id, "Stopped: second.");
    record_reason(&f.run_id, "Stopped: first.");
    assert_eq!(take_unresolved(&f.run_id).as_deref(), Some("Stopped: first. Stopped: second."));
    assert!(take_unresolved(&f.run_id).is_none(), "nothing left behind");
    assert_eq!(take_unresolved("other-run").as_deref(), Some("Stopped: elsewhere."));
}

#[test]
fn a_stop_that_cannot_be_sent_records_no_reason() {
    let mut f = fixture();
    // The run's input is gone, so the stop cannot be delivered.
    drop(std::mem::replace(&mut f.receiver, unbounded_channel().1));
    let mut event = request(&f, "approval", "Run `ls`", Some(json!({"museChoices":{"approve":false,"deny":false}})));
    // Nothing could act on it: it is cleared and dropped, never shown, with no stop reason.
    assert!(resolve(&f, true, &mut event), "not surfaced");
    assert_eq!(event.kind, "approval_cancelled");
    assert!(pending_empty(&f));
    assert!(take_unresolved(&f.run_id).is_none());
}

#[test]
fn an_always_ask_tool_without_a_deny_choice_stops_the_turn() {
    let mut f = fixture();
    let data = json!({"museChoices":{"approve":true,"deny":false}});
    let mut event = request(&f, "approval", "Allow pandacode_cloud_cli?", Some(data));
    assert!(resolve(&f, true, &mut event));
    stopped_with_reason(&mut f, "pandacode_cloud_cli");
    assert!(f.receiver.try_recv().is_err());
    assert!(pending_empty(&f));
}

#[test]
fn a_lasting_only_acp_request_is_never_approved_for_a_worker() {
    // Recorded ACP option sets offering only `allow_always`, as `Protocol::approval` flags them.
    let mut f = fixture();
    let declinable = json!({"lastingOnly":true,"lastingDeclinable":true});
    let mut event = request(&f, "approval", "Edit file", Some(declinable));
    assert!(resolve(&f, true, &mut event));
    assert!(!approved(&mut f), "declined, not granted for good");
    assert!(event.text.starts_with("Declined automatically for a team worker (only a lasting permission"), "{}", event.text);
    assert!(pending_empty(&f));
    let mut f = fixture();
    let mut event = request(&f, "approval", "Edit file", Some(json!({"lastingOnly":true,"lastingDeclinable":false})));
    assert!(resolve(&f, true, &mut event));
    stopped_with_reason(&mut f, "only a lasting permission (Edit file)");
    assert!(pending_empty(&f));
}

#[test]
fn non_worker_approval_stays_pending() {
    let mut f = fixture();
    let mut event = request(&f, "approval", "Run ls", None);
    assert!(!resolve(&f, false, &mut event));
    assert!(f.receiver.try_recv().is_err());
    assert_eq!((event.kind.as_str(), event.text.as_str()), ("approval", "Run ls"));
    assert!(!pending_empty(&f));
    assert_eq!(status(&f), "waiting");
}

#[test]
fn a_turn_the_harness_finished_before_the_automatic_stop_is_not_failed() {
    let run = "race-run";
    let reason = || record_reason(run, "Stopped: x.");
    // The harness completed its turn before its loop took the stop: not stopped, not failed.
    reason();
    assert_eq!(outcome(settle_run(run, true)), (None, false));
    // The loop took the stop: the worker fails with the reason.
    reason();
    stop_taken(run);
    assert_eq!(outcome(settle_run(run, true)), (Some("Stopped: x.".into()), true));
    // A failed run whose loop did take the stop keeps the reason too.
    reason();
    stop_taken(run);
    assert_eq!(outcome(settle_run(run, true)), (Some("Stopped: x.".into()), true));
    // The harness crashed before its loop took the stop: its own error stands (no reason).
    reason();
    assert_eq!(outcome(settle_run(run, true)), (None, false));
    // Nothing is left behind for the run.
    assert!(take_unresolved(run).is_none() && !runs().iter().any(|(id, _)| id == run));
    // A run with no automatic stop keeps its own stop state.
    assert_eq!(outcome(settle_run(run, true)), (None, true));
    // A user's or team's stop raced the automatic one: the run stays stopped, and the
    // automatic reason goes, so the run's end and the team agree it was stopped, not failed.
    reason();
    stopped_by_owner(run);
    assert_eq!(outcome(settle_run(run, true)), (None, true));
    reason();
    stopped_by_owner(run);
    stop_taken(run);
    assert_eq!(outcome(settle_run(run, true)), (None, true));
    assert!(!runs().iter().any(|(id, _)| id == run), "drained");
}

#[test]
fn audit_text_is_bounded() {
    let text = audit_text("Note", &"x".repeat(1000));
    assert_eq!(text.len(), "Note: ".len() + AUDIT_LIMIT);
}

#[test]
fn a_gone_runs_request_never_writes_the_status_of_a_newer_run() {
    let f = fixture();
    // An older run of the task whose input is closed; the fixture's run is the newer, registered one.
    let (input, receiver) = unbounded_channel();
    let old = Run::of(&RunningAgent::new(input, Arc::new(AtomicBool::new(false))));
    drop(receiver);
    f.store.lock().unwrap().status(&f.sid, "waiting").unwrap();
    let mut event = AgentEvent { session_id: f.sid.clone(), kind: "approval".into(), text: "Run `ls`".into(), request_id: Some(format!("{}:4", old.id)), data: None, tool: None };
    assert!(resolve_if_worker(true, &old, &f.agents, &f.store, &mut event), "never surfaced");
    assert_eq!(event.kind, "approval_cancelled");
    assert_eq!(status(&f), "waiting", "the newer run's status is left alone");
}

#[test]
fn the_run_registry_is_bounded_oldest_first() {
    // A local registry, so the shared one used by concurrent tests is untouched.
    let mut registry = Vec::new();
    // Idle owner-only marks are what the cap drops, oldest first.
    for i in 0..=RUNS_MAX {
        run_entry(&mut registry, &format!("run-{i}")).stopped_by_owner = true;
    }
    assert_eq!(registry.len(), RUNS_MAX);
    assert_eq!(registry.first().map(|(id, _)| id.as_str()), Some("run-1"), "the oldest went first");
    run_entry(&mut registry, "run-5").reasons.push("Stopped: x.".into());
    assert_eq!(registry.len(), RUNS_MAX, "a run has one entry");
    assert!(registry.iter().find(|(id, _)| id == "run-5").is_some_and(|(_, state)| state.stopped_by_owner && state.reasons.len() == 1));
}

#[test]
fn a_lookup_for_an_unknown_run_never_evicts_a_mark_at_the_cap() {
    let mut registry = Vec::new();
    for i in 0..RUNS_MAX {
        run_entry(&mut registry, &format!("owner-{i}")).stopped_by_owner = true;
    }
    // A read of an unknown run adds nothing, so the oldest owner's stop mark stays.
    assert!(!update_run(&mut registry, "unknown", |state| state.stopped_by_owner));
    assert_eq!(registry.len(), RUNS_MAX);
    assert_eq!(registry.first().map(|(id, _)| id.as_str()), Some("owner-0"), "nothing was evicted");
    // An update that keeps something is added (evicting the oldest idle mark).
    update_run(&mut registry, "kept", |state| state.reasons.push("Stopped: x.".into()));
    assert!(registry.iter().any(|(id, _)| id == "kept"));
    assert_eq!(registry.len(), RUNS_MAX);
}

#[test]
fn a_run_with_nothing_kept_leaves_no_entry() {
    let run = "empty-run";
    in_flight(&format!("{run}:1"), true);
    assert!(is_in_flight(&format!("{run}:1")));
    in_flight(&format!("{run}:1"), false);
    assert!(take_unresolved(run).is_none());
    assert!(!runs().iter().any(|(id, _)| id == run));
}

#[test]
fn a_run_that_finished_before_the_stop_shows_no_stop() {
    let f = fixture();
    // No usable choice: the worker's turn is stopped, its error and note held for the run's end.
    let mut event = request(&f, "approval", "Run `ls`", Some(json!({"museChoices":{"approve":false,"deny":false}})));
    assert!(resolve(&f, true, &mut event));
    // The harness finished its turn before its loop took that stop.
    let settled = settle_run(&f.run_id, true);
    assert_eq!((settled.reason, settled.stopped), (None, false));
    assert!(settled.notes.is_empty() && settled.shown.is_empty(), "no Stopped note or error");
    assert_eq!(system_notes(&f), 0);
}

#[tokio::test]
async fn time_between_accounts_does_not_use_up_the_answer_budget() {
    let (input, _receiver) = unbounded_channel();
    let (reply, first) = tokio::sync::oneshot::channel();
    let switching = Arc::new(AtomicBool::new(true));
    let flag = switching.clone();
    // The pooled run changes accounts for 300 ms, then takes the answer.
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(300)).await;
        flag.store(false, Ordering::SeqCst);
        tokio::time::sleep(Duration::from_millis(50)).await;
        let _ = reply.send(Ok(()));
    });
    let answerer = Answerer { input: input.downgrade(), last_event: Arc::new(std::sync::atomic::AtomicI64::new(0)), watched: None };
    let unreachable = move || switching.load(Ordering::SeqCst);
    let settled = settle_within(first, &answerer, "7", &questions(true), Duration::from_millis(100), Duration::from_millis(200), &unreachable).await;
    assert!(settled, "the wait went on while the run changed accounts");
    drop(input);
}

#[test]
fn mixed_questions_are_answered_all_or_nothing() {
    // The harnesses take every answer or a cancel (`host_inputs::answer`): a choice-only question
    // with no recommended option cancels the whole request, free-text questions included.
    let mixed = json!({"kind":"questions","questions":[
        {"id":"why","question":"Why?","isOther":true,"options":[]},
        {"id":"pick","question":"Delete it?","options":[{"label":"Yes"},{"label":"No"}]}
    ]});
    assert_eq!(preferred_response(&mixed), json!({"answers":{}}));
}

#[test]
fn an_account_switch_settles_what_the_old_account_left_open() {
    let mut f = fixture();
    let mut event = request(&f, "input_request", "Which?", Some(questions(true)));
    assert!(resolve(&f, true, &mut event));
    let request_id = event.request_id.clone().unwrap();
    assert!(is_in_flight(&request_id));
    let run = Run::of(f.agents.lock().unwrap().get(&f.sid).unwrap());
    run.approvals.lock().unwrap().insert(format!("{}:old", f.run_id));
    // Hiding the question failed: it is still listed, and must be cancelled as a question.
    run.approvals.lock().unwrap().insert(request_id.clone());
    // The pool moves to another account; the old account's process never answers.
    let mut cancelled: Vec<(String, String)> = account_switched(&run, &f.sid).into_iter().map(|e| (e.kind, e.request_id.unwrap())).collect();
    cancelled.sort();
    assert_eq!(cancelled, vec![("approval_cancelled".to_string(), format!("{}:old", f.run_id)), ("input_cancelled".to_string(), request_id.clone())]);
    assert!(!is_in_flight(&request_id));
    assert!(run.approvals.lock().unwrap().is_empty());
    // The first answer fails on the new account; no late fallback follows it there, and the
    // question is settled, not a stop.
    next_answer(&mut f).2.send(Err("unknown request".into())).unwrap();
    std::thread::sleep(Duration::from_millis(200));
    assert!(f.receiver.try_recv().is_err(), "no fallback and no stop");
    assert!(take_unresolved(&f.run_id).is_none());
}

#[test]
fn owner_stop_marks_never_evict_a_live_runs_state() {
    // A local registry, so the shared one used by concurrent tests is untouched.
    let mut registry = Vec::new();
    run_entry(&mut registry, "live").reasons.push("Stopped: x.".into());
    for i in 0..(RUNS_MAX * 2) {
        run_entry(&mut registry, &format!("owner-{i}")).stopped_by_owner = true;
    }
    assert!(registry.iter().any(|(id, state)| id == "live" && state.reasons.len() == 1), "the live reason survives");
    assert!(registry.len() <= RUNS_MAX);
    // With only live runs, none is dropped: the registry grows until they settle.
    let mut live = Vec::new();
    for i in 0..=RUNS_MAX {
        run_entry(&mut live, &format!("live-{i}")).stop_taken = true;
    }
    assert_eq!(live.len(), RUNS_MAX + 1);
}

#[test]
fn an_account_switch_drops_a_users_stale_request_cards() {
    let f = fixture();
    let run = Run::of(f.agents.lock().unwrap().get(&f.sid).unwrap());
    // A user's run: an approval and a question left open by the old account.
    let mut approval = request(&f, "approval", "Run `ls`", None);
    let approval_id = approval.request_id.clone().unwrap();
    assert!(!resolve(&f, false, &mut approval), "a user's request waits");
    let mut question = AgentEvent { session_id: f.sid.clone(), kind: "input_request".into(), text: "Which?".into(), request_id: Some("9".into()), data: Some(questions(true)), tool: None };
    save_approval_with_pending(&f.store, &run.approvals, Some(&run.requests), &f.run_id, &mut question).unwrap();
    let question_id = question.request_id.clone().unwrap();
    let mut cancelled: Vec<(String, String)> = account_switched(&run, &f.sid).into_iter().map(|e| (e.kind, e.request_id.unwrap())).collect();
    cancelled.sort();
    assert_eq!(cancelled, vec![("approval_cancelled".to_string(), approval_id), ("input_cancelled".to_string(), question_id)]);
    assert!(pending_empty(&f));
}

/// Every harness's real approval label for an always-ask tool, as its producer writes it, so a
/// label format change fails here instead of letting a team worker approve the tool.
#[test]
fn always_ask_tools_match_every_harness_approval_shape() {
    // The producers these shapes copy; a change to one must update its fixture below.
    let mcp_host = include_str!("../providers/mcp_host.rs");
    assert!(mcp_host.contains(r#"const SERVER_NAME: &str = "pandacode_architect";"#));
    assert!(mcp_host.contains(r#"text: format!("Allow {name}?\n{}", preview_json(args, TOOL_INPUT_LIMIT)),"#));
    let host_tools = include_str!("../providers/host_tools.rs");
    assert!(host_tools.contains("\"Allow {}?\\n{}\",\n                call.tool,"));
    assert!(host_tools.contains(r#""method":"item/tool/call""#));
    assert!(include_str!("../providers/cline.rs").contains(r#"title.strip_prefix("pandacode_architect__")?.split(':').next()"#));
    let event = |text: String, data: Option<Value>| AgentEvent { session_id: "s".into(), kind: "approval".into(), text, request_id: Some("7".into()), data, tool: None };
    for name in crate::cloud::deploy::ALWAYS_ASK {
        let shapes = [
            // PandaCode's MCP tool host (`mcp-approval:` IDs): Claude, GLM, MiMo, Kimi, OpenCode,
            // Antigravity, Grok, Pi, DeepSeek, Command Code, Cline, Kilo, OMP, GitHub Copilot,
            // Muse, Devin, Hermes, and Codex's per-run server. It asks even in full access.
            ("mcp host", event(format!("Allow {name}?\n{{\"args\":[\"deploy\"]}}"), None)),
            // Codex dynamic host tools (`item/tool/call`).
            ("codex", event(format!("Allow {name}?\n{{\"args\":[\"deploy\"]}}"), Some(json!({"id":"rpc","method":"item/tool/call"})))),
            // Claude's `can_use_tool` control request: the bare MCP tool name.
            ("claude", event(format!("mcp__pandacode_architect__{name}"), Some(json!({"type":"control_request"})))),
            // Cline's ACP `session/request_permission` title: `<server>__<tool>: <input>`.
            ("cline", event(format!("pandacode_architect__{name}: {{\"args\":[\"deploy\"]}}"), Some(json!({"jsonrpc":"2.0","method":"session/request_permission"})))),
        ];
        for (harness, shape) in shapes {
            assert_eq!(always_ask_tool(&shape), Some(*name), "{harness}: {}", shape.text);
        }
        // Only the exact tool name counts: never a longer name or a command line naming it.
        for text in [format!("Allow {name}_extra?"), format!("Run `grep {name} src`"), format!("pandacode_architect__x{name}: {{}}"), format!("Run `echo x: {name}`")] {
            assert_eq!(always_ask_tool(&event(text.clone(), None)), None, "{text}");
        }
    }
}

mod questions;
