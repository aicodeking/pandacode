//! Pending approvals and questions on a run, and a team worker's requests through the run's sink.
use super::*;

#[test]
fn a_worker_request_that_cannot_be_saved_still_stops_the_run() {
    let store = storage::Store::open(std::path::Path::new(":memory:")).unwrap();
    let project = store.add_project(&std::env::temp_dir()).unwrap();
    let sid = store.create_session(&project.id, "codex", "default", "full").unwrap().id;
    let store = Arc::new(Mutex::new(store));
    let (input, mut receiver) = unbounded_channel();
    let agent = RunningAgent::new(input, Arc::new(AtomicBool::new(false)));
    let run = worker_approvals::Run::of(&agent);
    let agents = Arc::new(Mutex::new(HashMap::from([(sid.clone(), agent)])));
    // A request without an ID cannot be saved, yet the worker must not wait on it.
    let mut event = AgentEvent { session_id: sid.clone(), kind: "approval".into(), text: "Run `ls`".into(), request_id: None, data: None, tool: None };
    assert!(record_request_event(&store, &run, true, &agents, &mut event).is_ok(), "stopped cleanly, not a persistence error");
    assert_eq!(event.kind, "approval_cancelled", "never surfaced to bots, tray or window");
    assert!(matches!(receiver.try_recv(), Ok(RunInput::Stop)));
    assert!(worker_approvals::take_unresolved(&run.id).unwrap().contains("without an ID"));
    // A user's own request is saved and surfaced as before.
    let mut user = AgentEvent { session_id: sid, kind: "approval".into(), text: "Run `ls`".into(), request_id: None, data: None, tool: None };
    assert!(record_request_event(&store, &run, false, &agents, &mut user).is_err());
    assert_eq!(user.kind, "approval");
}

#[test]
fn a_worker_request_stopped_after_a_failed_save_does_not_fail_the_run_for_it() {
    let store = storage::Store::open(std::path::Path::new(":memory:")).unwrap();
    let project = store.add_project(&std::env::temp_dir()).unwrap();
    let sid = store.create_session(&project.id, "codex", "default", "full").unwrap().id;
    let store = Arc::new(Mutex::new(store));
    let (input, mut receiver) = unbounded_channel();
    let agent = RunningAgent::new(input, Arc::new(AtomicBool::new(false)));
    let run = worker_approvals::Run::of(&agent);
    // The pending list is unusable, so the request (it has an ID) cannot be saved.
    let approvals = run.approvals.clone();
    let _ = std::thread::spawn(move || {
        let _held = approvals.lock().unwrap();
        panic!("poison the pending list");
    })
    .join();
    let agents = Arc::new(Mutex::new(HashMap::from([(sid.clone(), agent)])));
    let mut event = AgentEvent { session_id: sid, kind: "approval".into(), text: "Run `ls`".into(), request_id: Some("7".into()), data: None, tool: None };
    assert!(record_request_event(&store, &run, true, &agents, &mut event).is_ok(), "logged, not the run's error");
    assert_eq!(event.kind, "approval_cancelled");
    assert!(matches!(receiver.try_recv(), Ok(RunInput::Stop)));
    assert!(worker_approvals::take_unresolved(&run.id).is_some());
}

/// A worker session with its run registered, and every status change to "waiting" logged.
fn worker_fixture() -> (Arc<Mutex<storage::Store>>, String, worker_approvals::Run, Arc<Mutex<HashMap<String, RunningAgent>>>, tokio::sync::mpsc::UnboundedReceiver<RunInput>) {
    let store = storage::Store::open(std::path::Path::new(":memory:")).unwrap();
    let project = store.add_project(&std::env::temp_dir()).unwrap();
    let sid = store.create_session(&project.id, "codex", "default", "full").unwrap().id;
    store.db.execute_batch("CREATE TEMP TABLE waited(id TEXT); CREATE TEMP TRIGGER log_waiting AFTER UPDATE OF status ON sessions WHEN NEW.status='waiting' BEGIN INSERT INTO waited VALUES(NEW.id); END;").unwrap();
    let (input, receiver) = unbounded_channel();
    let agent = RunningAgent::new(input, Arc::new(AtomicBool::new(false)));
    let run = worker_approvals::Run::of(&agent);
    let agents = Arc::new(Mutex::new(HashMap::from([(sid.clone(), agent)])));
    (Arc::new(Mutex::new(store)), sid, run, agents, receiver)
}

#[test]
fn an_auto_approved_worker_request_never_shows_as_waiting() {
    let (store, sid, run, agents, mut receiver) = worker_fixture();
    let mut event = AgentEvent { session_id: sid.clone(), kind: "approval".into(), text: "Run `cargo test`".into(), request_id: Some("7".into()), data: None, tool: None };
    assert!(record_request_event(&store, &run, true, &agents, &mut event).is_ok());
    assert!(matches!(receiver.try_recv(), Ok(RunInput::Approval { approved: true, .. })));
    let db = store.lock().unwrap();
    let waited: i64 = db.db.query_row("SELECT COUNT(*) FROM waited", [], |r| r.get(0)).unwrap();
    assert_eq!(waited, 0, "the task never flipped to waiting");
    assert_ne!(db.session(&sid).unwrap().status, "waiting");
    assert!(run.approvals.lock().unwrap().is_empty());
    drop(db);
    assert!(run.requests.lock().unwrap().is_empty(), "never in the snapshot payload list");
    // A user's own request still waits, and is listed for remote snapshots.
    let mut user = AgentEvent { session_id: sid.clone(), kind: "approval".into(), text: "Run `ls`".into(), request_id: Some("8".into()), data: None, tool: None };
    assert!(record_request_event(&store, &run, false, &agents, &mut user).is_ok());
    assert_eq!(store.lock().unwrap().session(&sid).unwrap().status, "waiting");
    assert_eq!(run.requests.lock().unwrap().len(), 1);
}

#[test]
fn a_harness_cancellation_claims_a_kept_decline_reason() {
    let (store, sid, run, agents, _receiver) = worker_fixture();
    providers::set_decline_reason(&sid, "cancel-me", "Declined: team workers cannot run it.");
    let mut cancelled = AgentEvent { session_id: sid.clone(), kind: "approval_cancelled".into(), text: String::new(), request_id: Some("cancel-me".into()), data: None, tool: None };
    let _ = record_request_event(&store, &run, true, &agents, &mut cancelled);
    assert!(providers::take_decline_reason(&sid, "cancel-me").is_none());
}

#[test]
fn an_unresolved_stop_is_saved_as_failed_not_interrupted() {
    let (store, sid, _run, _agents, _receiver) = worker_fixture();
    let db = store.lock().unwrap();
    db.begin_task_turn(&sid, "Implement it.").unwrap();
    // As the run's end saves it: stopped for a request it could not resolve.
    db.finish_task_operation(&sid, false, run_end(false, true, true).0, None).unwrap();
    assert_ne!(db.session(&sid).unwrap().status, "interrupted");
}

#[test]
fn only_a_worker_launchs_stop_is_kept_for_the_team() {
    let (input, _receiver) = unbounded_channel();
    let agent = RunningAgent::new(input, Arc::new(AtomicBool::new(false)));
    let _ = agent.send(RunInput::Stop);
    assert!(!worker_approvals::has_run(&agent.run_id), "a non-worker agent keeps nothing");
    let (input, _receiver) = unbounded_channel();
    let mut worker = RunningAgent::new(input, Arc::new(AtomicBool::new(false)));
    worker.team_worker = true;
    let _ = worker.send(RunInput::Stop);
    assert!(worker_approvals::has_run(&worker.run_id));
    worker_approvals::forget_run(&worker.run_id);
}

#[test]
fn an_unresolved_stop_ends_as_failed_for_every_client() {
    assert_eq!(run_end(false, true, true), (false, "Turn failed"));
    assert_eq!(run_end(false, true, false), (true, "Turn stopped"));
    assert_eq!(run_end(true, false, false), (false, "Turn complete"));
}

#[test]
fn remote_pending_request_payloads_are_added_and_cancelled_with_the_approval_id() {
    let request_id = "run-id:provider-id";
    let mut approvals = HashSet::new();
    let mut pending = HashMap::new();
    let request = AgentEvent {
        session_id: "task-id".into(),
        kind: "input_request".into(),
        text: "Choose one".into(),
        request_id: Some(request_id.into()),
        data: Some(serde_json::json!({"questions": [{"question": "Which?"}]})),
        tool: None,
    };
    update_pending_request(&mut approvals, Some(&mut pending), request_id, &request);
    assert!(approvals.contains(request_id));
    assert_eq!(pending.get(request_id).unwrap().text, "Choose one");
    assert_eq!(pending.get(request_id).unwrap().data, request.data);

    let cancelled = AgentEvent { kind: "input_cancelled".into(), ..request };
    update_pending_request(&mut approvals, Some(&mut pending), request_id, &cancelled);
    assert!(!approvals.contains(request_id));
    assert!(!pending.contains_key(request_id));
}

#[test]
fn an_account_switch_clears_a_users_requests_and_reads_as_running() {
    let (store, sid, run, agents, _receiver) = worker_fixture();
    // A user's own run (not a worker): an approval and a question wait on the old account.
    let mut approval = AgentEvent { session_id: sid.clone(), kind: "approval".into(), text: "Run `ls`".into(), request_id: Some("1".into()), data: None, tool: None };
    record_request_event(&store, &run, false, &agents, &mut approval).unwrap();
    let mut question = AgentEvent { session_id: sid.clone(), kind: "input_request".into(), text: "Which?".into(), request_id: Some("2".into()), data: None, tool: None };
    record_request_event(&store, &run, false, &agents, &mut question).unwrap();
    assert_eq!(store.lock().unwrap().session(&sid).unwrap().status, "waiting");
    let mut cancelled: Vec<(String, String)> = settle_account_switch(&store, &run, &sid).into_iter().map(|e| (e.kind, e.request_id.unwrap())).collect();
    cancelled.sort();
    assert_eq!(cancelled, vec![("approval_cancelled".to_string(), approval.request_id.unwrap()), ("input_cancelled".to_string(), question.request_id.unwrap())]);
    assert_eq!(store.lock().unwrap().session(&sid).unwrap().status, "running");
    assert!(run.approvals.lock().unwrap().is_empty() && run.requests.lock().unwrap().is_empty());
    // Nothing left to clear: no events, no status change.
    assert!(settle_account_switch(&store, &run, &sid).is_empty());
}

#[test]
fn a_reattached_worker_run_is_a_worker_and_never_waits_on_a_person() {
    let (store, sid, run, agents, mut receiver) = worker_fixture();
    let (lead, plain) = {
        let db = store.lock().unwrap();
        let project = db.session(&sid).unwrap().project_id;
        let lead = db.create_session(&project, "codex", "default", "ask").unwrap().id;
        let plain = db.create_session(&project, "codex", "default", "ask").unwrap().id;
        db.db.execute("INSERT INTO architect_workers(parent_session_id,worker_id,session_id) VALUES(?1,'w1',?2)", rusqlite::params![lead, sid]).unwrap();
        (lead, plain)
    };
    // A re-attached cloud run has no team admission: the session's worker row decides.
    let reattached = worker_launch(&store.lock().unwrap(), None, &sid).unwrap();
    assert!(reattached);
    assert!(!worker_launch(&store.lock().unwrap(), None, &plain).unwrap());
    assert!(!worker_launch(&store.lock().unwrap(), None, &lead).unwrap(), "the lead is not a worker");
    let admitted = architect::Admission { parent: lead.clone(), generation: 1 };
    assert!(worker_launch(&store.lock().unwrap(), Some(&admitted), &sid).unwrap());
    // Its question, through the sink with that flag, is answered automatically and never surfaced.
    let mut question = AgentEvent { session_id: sid.clone(), kind: "input_request".into(), text: "Which?".into(), request_id: Some("q".into()), data: Some(serde_json::json!({"kind":"questions","questions":[{"id":"q","question":"Which?","isOther":true,"options":[]}]})), tool: None };
    record_request_event(&store, &run, reattached, &agents, &mut question).unwrap();
    assert_eq!(question.kind, "input_cancelled", "answered, not shown to the user");
    assert!(matches!(receiver.try_recv(), Ok(RunInput::UserInput { .. })));
    assert_ne!(store.lock().unwrap().session(&sid).unwrap().status, "waiting");
}
