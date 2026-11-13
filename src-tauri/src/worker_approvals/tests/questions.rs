//! Team workers' questions: automatic answers, their fallbacks and the answer budget.
use super::*;

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
