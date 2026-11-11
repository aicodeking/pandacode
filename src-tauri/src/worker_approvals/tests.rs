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
fn worker_question_is_answered_and_cleared_once_accepted() {
    let mut f = fixture();
    let mut event = request(&f, "input_request", "Which?", Some(questions(true)));
    assert!(resolve(&f, true, &mut event));
    assert_eq!(event.kind, "input_cancelled");
    assert_eq!(event.text, "Answered automatically for a team worker: Which?");
    let (request_id, response, reply) = next_answer(&mut f);
    assert_eq!(request_id, "7");
    assert_eq!(response, json!({"answers":{"q":[NO_USER_ANSWER]}}));
    // Off the pending lists at once: no snapshot lists an answer in flight as waiting.
    assert!(pending_empty(&f));
    assert_eq!(status(&f), "running");
    reply.send(Ok(())).unwrap();
    assert!(eventually(|| pending_empty(&f) && status(&f) == "running"));
    assert!(!runs().iter().any(|(id, state)| *id == f.run_id && !state.shown.is_empty()), "no stop");
}

#[test]
fn rejected_worker_answer_falls_back_to_cancel_and_clears() {
    let mut f = fixture();
    let mut event = request(&f, "input_request", "Which?", Some(questions(true)));
    assert!(resolve(&f, true, &mut event));
    let (_, _, reply) = next_answer(&mut f);
    reply.send(Err("rejected".into())).unwrap();
    let (request_id, response, reply) = next_answer(&mut f);
    assert_eq!((request_id.as_str(), response), ("7", json!({"answers":{}})));
    reply.send(Ok(())).unwrap();
    assert!(eventually(|| pending_empty(&f) && status(&f) == "running"));
}

#[test]
fn a_question_refused_twice_stops_the_turn() {
    let mut f = fixture();
    let mut event = request(&f, "input_request", "Which?", Some(questions(true)));
    assert!(resolve(&f, true, &mut event));
    next_answer(&mut f).2.send(Err("rejected".into())).unwrap();
    next_answer(&mut f).2.send(Err("rejected again".into())).unwrap();
    assert!(matches!(f.receiver.blocking_recv(), Some(RunInput::Stop)));
    let settled = settled_stop(&f);
    let reason = settled.reason.unwrap();
    assert!(reason.contains("a question could not be answered automatically (Which?)"));
    assert!(settled.shown.iter().any(|e| e.kind == "error" && e.text == reason));
    assert!(settled.notes.iter().any(|(_, note)| note.contains("no answer was taken")));
}

#[test]
fn a_question_the_harness_resolved_itself_is_not_stopped() {
    let mut f = fixture();
    let mut event = request(&f, "input_request", "Which?", Some(questions(true)));
    assert!(resolve(&f, true, &mut event));
    let first = next_answer(&mut f).2;
    // The harness's own input_cancelled settles the request before the replies fail.
    let mut cancelled = request(&f, "input_cancelled", "Which?", None);
    assert!(!resolve(&f, true, &mut cancelled), "shown as usual");
    first.send(Err("already answered".into())).unwrap();
    // Settled by the harness: no fallback follows, and the turn is not stopped.
    assert!(eventually(|| status(&f) == "running"));
    std::thread::sleep(Duration::from_millis(100));
    assert!(f.receiver.try_recv().is_err(), "no fallback and no stop");
    assert!(take_unresolved(&f.run_id).is_none());
}

#[tokio::test]
async fn a_late_first_acknowledgement_counts_after_the_fallback_is_refused() {
    let (input, mut receiver) = unbounded_channel();
    let (reply, first) = tokio::sync::oneshot::channel();
    let data = questions(true);
    let settling = tokio::spawn(async move {
        // The answerer holds the input weakly; the run's own sender keeps it open.
        let answerer = Answerer { input: input.downgrade(), last_event: Arc::new(std::sync::atomic::AtomicI64::new(0)), watched: None };
        let settled = settle_within(first, &answerer, "7", &data, Duration::from_millis(20), Duration::from_secs(5), &|| false).await;
        drop(input);
        settled
    });
    let Some(RunInput::UserInput { response, reply: Some(fallback), .. }) = receiver.recv().await else {
        panic!("expected the fallback");
    };
    assert_eq!(response, json!({"answers":{}}));
    fallback.send(Err("This input request is no longer active".into())).unwrap();
    reply.send(Ok(())).unwrap();
    assert!(settling.await.unwrap());
}

#[tokio::test]
async fn settling_gives_up_within_one_budget() {
    let (input, mut receiver) = unbounded_channel();
    let (_reply, first) = tokio::sync::oneshot::channel();
    let started = std::time::Instant::now();
    let data = questions(true);
    let settled = settle_within(first, &Answerer { input: input.downgrade(), last_event: Arc::new(std::sync::atomic::AtomicI64::new(0)), watched: None }, "7", &data, Duration::from_millis(20), Duration::from_millis(80), &|| false).await;
    assert!(!settled);
    assert!(started.elapsed() < Duration::from_millis(500));
    assert!(matches!(receiver.try_recv(), Ok(RunInput::UserInput { .. })));
}

#[test]
fn an_answer_after_the_run_ended_does_not_mark_it_running() {
    let mut f = fixture();
    let mut event = request(&f, "input_request", "Which?", Some(questions(true)));
    assert!(resolve(&f, true, &mut event));
    let (_, _, reply) = next_answer(&mut f);
    f.agents.lock().unwrap().clear();
    f.store.lock().unwrap().status(&f.sid, "idle").unwrap();
    reply.send(Ok(())).unwrap();
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(status(&f), "idle");
    assert!(!runs().iter().any(|(id, state)| *id == f.run_id && !state.shown.is_empty()), "no stop");
}

#[test]
fn choice_questions_take_the_recommended_option_or_cancel_and_secrets_cancel() {
    // No option is marked: cancelled rather than the first one picked.
    assert_eq!(preferred_response(&questions(false)), json!({"answers":{}}));
    let mut destructive = questions(false);
    destructive["questions"][0]["options"] = json!([{"label":"Yes, delete it"},{"label":"No"}]);
    assert_eq!(preferred_response(&destructive), json!({"answers":{}}));
    let mut recommended = questions(false);
    recommended["questions"][0]["options"] = json!([{"label":"Small"},{"label":"Full (Recommended)"}]);
    assert_eq!(preferred_response(&recommended), json!({"answers":{"q":["Full (Recommended)"]}}));
    let mut described = questions(false);
    // A description is advice, not a marker: only a "(Recommended)" clause there counts.
    described["questions"][0]["options"] = json!([{"label":"Small","description":""},{"label":"Full","description":"Recommended for most tasks"}]);
    assert_eq!(preferred_response(&described), json!({"answers":{}}));
    let mut advised = questions(false);
    advised["questions"][0]["options"] = json!([{"label":"Keep"},{"label":"Overwrite","description":"Recommended only if you are sure"}]);
    assert_eq!(preferred_response(&advised), json!({"answers":{}}));
    let mut clause = questions(false);
    clause["questions"][0]["options"] = json!([{"label":"Keep","description":"Keeps local edits (recommended)"},{"label":"Overwrite"}]);
    assert_eq!(preferred_response(&clause), json!({"answers":{"q":["Keep"]}}));
    let mut multi = questions(false);
    multi["questions"][0]["multiSelect"] = json!(true);
    multi["questions"][0]["options"] = json!([{"label":"Apple"},{"label":"Banana","default":true}]);
    assert_eq!(preferred_response(&multi), json!({"answers":{"q":["Banana"]}}));
    let mut secret = questions(true);
    secret["questions"][0]["isSecret"] = json!(true);
    secret["questions"][0]["options"] = Value::Null;
    assert_eq!(preferred_response(&secret), json!({"answers":{}}));
    let form = json!({"kind":"form","message":"Configure","schema":{}});
    assert_eq!(preferred_response(&form), json!({"action":"decline","content":null}));
    // A negated or buried "recommended" is no marker: the question is cancelled.
    for (label, description) in [
        ("Delete all (not recommended)", ""),
        ("Delete all", "This is not recommended for production"),
        ("Not recommended", ""),
        ("Force push (don't, unless sure; recommended only by experts)", ""),
        ("Wipe the disk", "Never recommended"),
        ("Quick scan", "Less thorough than recommended"),
        ("Skip checks", "Faster, but riskier than recommended"),
        ("Unrecommended", ""),
        ("(not recommended)", ""),
    ] {
        let mut negated = questions(false);
        negated["questions"][0]["options"] = json!([{"label":label,"description":description},{"label":"Keep"}]);
        assert_eq!(preferred_response(&negated), json!({"answers":{}}), "{label} / {description}");
    }
    let mut defaulted = questions(false);
    defaulted["questions"][0]["options"] = json!([{"label":"Rebase"},{"label":"Merge (default)"}]);
    assert_eq!(preferred_response(&defaulted), json!({"answers":{"q":["Merge (default)"]}}));
    // The marker clause alone decides: a negation in the option's own text does not cancel it.
    for (label, description) in [
        ("No (Recommended)", ""),
        ("Don't overwrite (recommended)", ""),
        ("Recommended: keep your local edits", ""),
        ("Recommended for most projects.", ""),
    ] {
        let mut marked = questions(false);
        marked["questions"][0]["options"] = json!([{"label":"Other"},{"label":label,"description":description}]);
        assert_eq!(preferred_response(&marked), json!({"answers":{"q":[label]}}), "{label} / {description}");
    }
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
    // The pool moves to another account; the old account's process never answers.
    assert!(!account_switched(&run, &f.sid).is_empty());
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
