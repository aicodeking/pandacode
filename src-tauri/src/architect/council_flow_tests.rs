//! Council across turns: cycles, changes, rounds over time, resting and the user's answers.
use super::*;

#[test]
fn turning_council_on_reviews_only_what_comes_next() {
    let (state, sid) = state_fixture();
    let mut team = saved(&state, &sid);
    team.status = "ready".into();
    store_team(&state, &mut team);
    // Earlier work in this thread, before Council was on.
    persist_turn(&state, &sid, &["index.html"]);
    std::thread::sleep(std::time::Duration::from_millis(3));
    council::set(&state, &sid, Some(on(9.0, 0, 0))).unwrap();
    let (_, admission) = start_state(&state, &sid, "What does it do?", None, None).unwrap();
    let (lead, _rx) = claim(&state, Launch { sid: sid.clone(), prompt: "What does it do?".into(), images: None, admission });
    finish(&state, &lead, "It does X.", true);
    assert!(next_action_state(&state, &mut |_| {}).unwrap().is_none(), "a plain answer is not woken");
    let team = saved(&state, &sid);
    assert_eq!(team.status, "ready");
    assert_eq!(finish_refusal(&team), None);
    // Changing the setting while it is on does not restart the cycle.
    let since = team.council_since;
    std::thread::sleep(std::time::Duration::from_millis(3));
    assert_eq!(council::set(&state, &sid, Some(on(8.0, 0, 0))).unwrap().council_since, since);
}

#[test]
fn a_replacement_keeps_the_replaced_lens() {
    let mut failed = seat("b", 1, None, SINCE + 1);
    failed.status = "failed".into();
    let team = team_with(on(9.0, 0, 0), vec![seat("a", 1, Some(9.0), SINCE + 1), failed]);
    assert!(council::seat_for(&team, Some("other"), Some("b")).unwrap_err().contains("lens b"));
    assert_eq!(council::seat_for(&team, Some("lens b"), Some("b")).unwrap().unwrap().lens, "lens b");
}

#[test]
fn a_lead_that_edits_alone_is_brought_back_once_then_paused_with_the_reason() {
    let (state, sid) = council_state(on(9.0, 0, 0));
    let lead = objective_turn(&state, &sid);
    turn_change(&state, &sid, "solo", storage::now(), &["index.html"], &[]);
    finish(&state, &lead, "I edited index.html myself.", true);
    let nudge = next_action_state(&state, &mut |_| {}).unwrap().unwrap();
    assert_eq!(nudge.sid, sid);
    assert!(nudge.prompt.contains("Council has not passed") && nudge.prompt.contains("No Council round yet"), "{}", nudge.prompt);
    let (run, _rx) = claim(&state, nudge);
    finish(&state, &run, "Still done.", true);
    assert!(next_action_state(&state, &mut |_| {}).unwrap().is_none());
    let team = saved(&state, &sid);
    assert_eq!(team.status, "paused");
    assert!(team.error.as_deref().unwrap().contains("No Council round yet"), "{:?}", team.error);
}

#[test]
fn a_finish_whose_own_turn_then_records_changes_is_reopened() {
    let (state, sid) = council_state(on(9.0, 0, 0));
    let lead = objective_turn(&state, &sid);
    call(&state, &sid, "pandacode_finish_team", json!({"summary":"Done."})).unwrap();
    // The turn's changes are saved as it ends, after the finish call.
    turn_change(&state, &sid, "solo", storage::now(), &["index.html"], &[]);
    finish(&state, &lead, "Done.", true);
    let team = saved(&state, &sid);
    assert_eq!(team.status, "waiting");
    assert!(team.error.as_deref().unwrap().contains("No Council round yet"));
    assert_eq!(next_action_state(&state, &mut |_| {}).unwrap().unwrap().sid, sid, "the lead reviews it");
}

#[test]
fn rounds_are_timed_from_each_seats_first_run() {
    let (state, sid) = council_state(on(9.0, 0, 0));
    call(&state, &sid, "pandacode_dispatch_workers", json!({"assignments":[reviewer_assignment("r", "ux")]})).unwrap();
    // A writer that settles after the reviewer was dispatched but before it ran.
    let mut team = saved(&state, &sid);
    team.workers.push(writer("w", storage::now() + 1));
    store_team(&state, &mut team);
    std::thread::sleep(std::time::Duration::from_millis(3));
    let (run, _rx) = claim(&state, next_action_state(&state, &mut |_| {}).unwrap().unwrap());
    let team = saved(&state, &sid);
    let started = team.workers[0].council.as_ref().unwrap().started_at;
    assert!(started > team.workers[1].wrote_at, "{started}");
    assert!(serde_json::to_value(&team).unwrap()["workers"][0]["council"]["startedAt"].is_i64());
    assert!(!team.council_status.unwrap().stale);
    finish(&state, &run, "Council score: 9/10", true);
    assert_eq!(saved(&state, &sid).workers[0].council.as_ref().unwrap().started_at, started, "only the first run counts");
}

#[test]
fn failing_over_clears_a_reviewers_nudge_summary_and_score() {
    let (state, sid, _run) = failover_state("gpt-5", &["codex", "cline"]);
    let store = state.store.lock().unwrap();
    let mut team = load(&store, &sid).unwrap().unwrap();
    team.workers[0].status = "failed".into();
    team.workers[0].score_nudged = true;
    team.workers[0].summary = "The old session's report.".into();
    team.workers[0].council = Some(CouncilSeat { round: 1, lens: "ux".into(), score: Some(3.0), started_at: 1 });
    assert!(fail_over(&store, &mut team, 0, "harness error").unwrap());
    assert!(!team.workers[0].score_nudged);
    assert!(team.workers[0].summary.is_empty());
    assert_eq!(team.workers[0].council.as_ref().unwrap().score, None);
}

#[test]
fn a_failed_reviewer_turn_says_cancel_and_dispatch_fresh() {
    let (state, sid) = council_state(on(9.0, 0, 0));
    call(&state, &sid, "pandacode_dispatch_workers", json!({"assignments":[reviewer_assignment("r", "ux"), assignment("w", "fast", "src")]})).unwrap();
    let (reviewer, _rx) = claim(&state, next_action_state(&state, &mut |_| {}).unwrap().unwrap());
    let (_writer, _rw) = claim(&state, next_action_state(&state, &mut |_| {}).unwrap().unwrap());
    finish(&state, &reviewer, "Crashed.", false);
    let turn = next_action_state(&state, &mut |_| {}).unwrap().unwrap();
    assert!(turn.prompt.contains("cancel it (it has no score) and dispatch a fresh reviewer"), "{}", turn.prompt);
    let (_, plain) = fixture();
    assert!(!failed_body(&plain).contains("Council"));
}

#[test]
fn the_review_payload_has_first_scores_per_lens() {
    let mut first = seat("a1", 1, Some(6.5), SINCE + 1);
    first.council.as_mut().unwrap().lens = "ux".into();
    let mut later = seat("a2", 2, Some(9.0), SINCE + 5);
    later.council.as_mut().unwrap().lens = "ux".into();
    let mut security = seat("b2", 2, Some(9.5), SINCE + 5);
    security.council.as_mut().unwrap().lens = "security".into();
    let team = team_with(on(9.0, 0, 0), vec![first, seat("x", 1, Some(7.5), SINCE + 1), later, security]);
    let council = review(&team).unwrap();
    assert_eq!(council["firstScores"], json!({"ux":6.5,"lens x":7.5,"security":9.5}));
}

#[test]
fn council_status_follows_the_gate() {
    let state_of = |team: &TeamSnapshot| council::status(team).unwrap().state;
    assert_eq!(state_of(&team_with(on(9.0, 0, 0), vec![writer("w", SINCE)])), "waiting");
    let mut open = seat("b", 1, None, SINCE + 1);
    open.status = "running".into();
    assert_eq!(state_of(&team_with(on(9.0, 0, 0), vec![seat("a", 1, Some(9.0), SINCE + 1), open])), "reviewing");
    let pair = |x: f64| vec![writer("w", SINCE), seat("a", 1, Some(x), SINCE + 1), seat("b", 1, Some(9.5), SINCE + 1)];
    assert_eq!(state_of(&team_with(on(9.0, 0, 0), pair(9.0))), "passed");
    assert_eq!(state_of(&team_with(on(9.0, 0, 0), pair(8.0))), "fixing");
    assert_eq!(state_of(&team_with(on(9.0, 1, 0), pair(8.0))), "limit");
    let status = council::status(&team_with(on(9.5, 0, 0), pair(8.0))).unwrap();
    assert_eq!(status, CouncilStatus { state: "fixing".into(), round: 1, lowest: Some(8.0), target: 9.5, stale: false, notice: None });
    assert_eq!(serde_json::to_value(&status).unwrap(), json!({"state":"fixing","round":1,"lowest":8.0,"target":9.5,"stale":false}));
    // Saved and emitted snapshots carry it while Council is on, and drop it when it is off.
    let (state, sid) = council_state(on(9.0, 0, 0));
    assert_eq!(saved(&state, &sid).council_status.unwrap().state, "waiting");
    assert_eq!(event_payload(&saved(&state, &sid)).council_status.unwrap().state, "waiting");
    council::set(&state, &sid, None).unwrap();
    assert!(serde_json::to_value(saved(&state, &sid)).unwrap().get("councilStatus").is_none());
}

#[test]
fn enabling_during_a_request_still_reviews_its_settled_writes() {
    let (state, sid) = state_fixture();
    let (run, _) = running_worker(&state, &sid, "w", "src");
    finish(&state, &run, "Done.", true);
    let since = saved(&state, &sid).council_since;
    let team = council::set(&state, &sid, Some(on(9.0, 0, 0))).unwrap();
    assert_eq!(team.council_since, since, "the running request keeps its start");
    assert!(finish_refusal(&team).unwrap().contains("No Council round yet"));
}

/// A complete round 1 below the target, after a writer: the lead was told to fix it or ask the user.
fn low_round(state: &AppState, sid: &str) {
    let mut team = saved(state, sid);
    team.workers = vec![writer("w", storage::now() - 50), seat("a", 1, Some(5.0), storage::now()), seat("b", 1, Some(9.0), storage::now())];
    store_team(state, &mut team);
}

#[test]
fn a_low_round_gets_one_continue_then_asks_the_user() {
    // The user's own turn.
    let (state, sid) = council_state(on(9.0, 0, 0));
    let lead = objective_turn(&state, &sid);
    low_round(&state, &sid);
    finish(&state, &lead, "Should I keep fixing the parser?", true);
    let nudge = next_action_state(&state, &mut |_| {}).unwrap().unwrap();
    assert!(nudge.prompt.contains("lowest 5") && nudge.prompt.contains("Fix the blockers through workers and convene a new round"), "{}", nudge.prompt);
    let (run, _r) = claim(&state, nudge);
    finish(&state, &run, "Asking the user.", true);
    assert!(next_action_state(&state, &mut |_| {}).unwrap().is_none(), "one Continue only");
    let team = saved(&state, &sid);
    assert_eq!(team.status, "ready");
    assert!(team.error.as_deref().unwrap().contains("lowest 5"), "{:?}", team.error);
    // A turn PandaCode started.
    let (state, sid) = council_state(on(9.0, 0, 0));
    call(&state, &sid, "pandacode_dispatch_workers", json!({"assignments":[assignment("x", "fast", "docs")]})).unwrap();
    let (worker, _rx) = claim(&state, next_action_state(&state, &mut |_| {}).unwrap().unwrap());
    finish(&state, &worker, "Done.", true);
    let (review, _rr) = claim(&state, next_action_state(&state, &mut |_| {}).unwrap().unwrap());
    let mut team = saved(&state, &sid);
    team.workers.extend([writer("w", storage::now() - 50), seat("a", 1, Some(5.0), storage::now()), seat("b", 1, Some(9.0), storage::now())]);
    store_team(&state, &mut team);
    finish(&state, &review, "Asking the user.", true);
    let nudge = next_action_state(&state, &mut |_| {}).unwrap().unwrap();
    assert!(nudge.prompt.contains("only if a remaining blocker should not be fixed"), "{}", nudge.prompt);
    let (run, _r) = claim(&state, nudge);
    finish(&state, &run, "Asking the user.", true);
    assert!(next_action_state(&state, &mut |_| {}).unwrap().is_none());
    let team = saved(&state, &sid);
    assert_eq!(team.status, "ready");
    assert!(team.error.as_deref().unwrap().contains("lower the target"));
}

#[test]
fn a_reopened_finish_from_a_review_turn_says_why_and_keeps_its_error() {
    let (state, sid) = council_state(on(9.0, 0, 0));
    call(&state, &sid, "pandacode_dispatch_workers", json!({"assignments":[assignment("x", "fast", "docs")]})).unwrap();
    let (worker, _rx) = claim(&state, next_action_state(&state, &mut |_| {}).unwrap().unwrap());
    finish(&state, &worker, "Done.", true);
    // The review turn: Council passes, the lead finishes, then its own edit is saved as the turn ends.
    let (review, _rr) = claim(&state, next_action_state(&state, &mut |_| {}).unwrap().unwrap());
    assert!(saved(&state, &sid).last_turn_kind.is_some());
    let mut team = saved(&state, &sid);
    team.workers.extend([seat("a", 1, Some(9.0), storage::now() + 5), seat("b", 1, Some(9.0), storage::now() + 5)]);
    store_team(&state, &mut team);
    call(&state, &sid, "pandacode_finish_team", json!({"summary":"Done."})).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(10));
    persist_turn(&state, &sid, &["index.html"]);
    finish(&state, &review, "Done.", true);
    let refusal = saved(&state, &sid).error.unwrap();
    assert!(refusal.contains("out of date"), "{refusal}");
    let again = next_action_state(&state, &mut |_| {}).unwrap().unwrap();
    assert!(again.prompt.contains("Your finish was reopened") && again.prompt.contains("out of date"), "{}", again.prompt);
    assert_eq!(saved(&state, &sid).error.as_deref(), Some(refusal.as_str()));
    // It ends that turn without acting: the next one names the refusal, not a missing dispatch.
    let (run, _r) = claim(&state, again);
    finish(&state, &run, "Hmm.", true);
    let next = next_action_state(&state, &mut |_| {}).unwrap().unwrap();
    assert!(next.prompt.contains("Council has not passed this work") && !next.prompt.contains("without dispatching"), "{}", next.prompt);
    assert_eq!(saved(&state, &sid).error.as_deref(), Some(refusal.as_str()));
}

#[test]
fn a_seat_awaiting_its_score_cannot_be_cancelled_or_replaced() {
    let (state, sid) = council_state(on(9.0, 0, 0));
    let mut team = saved(&state, &sid);
    let mut nudged = seat("n", 1, None, storage::now());
    nudged.status = "queued".into();
    nudged.score_nudged = true;
    team.workers = vec![nudged];
    store_team(&state, &mut team);
    assert_eq!(call(&state, &sid, "pandacode_cancel_worker", json!({"workerId":"n","reason":"Slow."})).unwrap_err(), council::NUDGE_PENDING);
    let mut team = saved(&state, &sid);
    team.workers[0].status = "failed".into();
    store_team(&state, &mut team);
    // Settled after two misses, it is replaced as its error says.
    let mut again = reviewer_assignment("again", "lens n");
    again["replaces"] = json!("n");
    call(&state, &sid, "pandacode_dispatch_workers", json!({"assignments":[again]})).unwrap();
}

#[test]
fn council_is_never_a_saved_default() {
    let (state, sid) = council_state(on(9.0, 0, 0));
    let mut with = config();
    with.council = Some(on(7.0, 0, 0));
    configure_state(&state, &sid, Some(with.clone()), None, None).unwrap();
    let store = state.store.lock().unwrap();
    assert_eq!(profiles::read(&store).unwrap().last_setup.unwrap().config.council, None);
}

#[test]
fn enabling_on_a_paused_request_keeps_its_writers_under_review() {
    let (state, sid) = state_fixture();
    let (run, _) = running_worker(&state, &sid, "w", "src");
    finish(&state, &run, "Done.", true);
    control_state(&state, &sid, "pause").unwrap();
    let since = saved(&state, &sid).council_since;
    let team = council::set(&state, &sid, Some(on(9.0, 0, 0))).unwrap();
    assert_eq!(team.council_since, since);
    assert!(finish_refusal(&team).unwrap().contains("No Council round yet"));
}

#[test]
fn an_overtaken_rounds_unscored_seats_stop() {
    let (state, sid) = council_state(on(9.0, 0, 0));
    call(&state, &sid, "pandacode_dispatch_workers", json!({"assignments":[reviewer_assignment("r1", "ux")]})).unwrap();
    let (_run, _rx) = claim(&state, next_action_state(&state, &mut |_| {}).unwrap().unwrap());
    let mut team = saved(&state, &sid);
    team.workers.push(writer("w", storage::now() + 5));
    store_team(&state, &mut team);
    call(&state, &sid, "pandacode_dispatch_workers", json!({"assignments":[reviewer_assignment("r2", "ux")]})).unwrap();
    let team = saved(&state, &sid);
    let old = &team.workers[0];
    assert_eq!((old.status.as_str(), old.abandoned), ("stopped", true));
    assert!(old.error.as_deref().unwrap().contains("round 2 replaces it"), "{:?}", old.error);
    assert_eq!(team.workers[2].council.as_ref().unwrap().round, 2);
    assert_eq!(council::status(&team).unwrap().round, 2, "the stopped seat blocks nothing");
}

#[test]
fn a_lens_below_target_must_sit_again() {
    let mut workers = vec![writer("w", SINCE), lensed("a1", 1, Some(5.0), SINCE + 1, "ux"), lensed("b1", 1, Some(9.5), SINCE + 1, "sec"), writer("fix", SINCE + 2)];
    workers.extend([lensed("c2", 2, Some(9.5), SINCE + 3, "perf"), lensed("d2", 2, Some(9.5), SINCE + 3, "sec")]);
    let team = team_with(on(9.0, 0, 0), workers.clone());
    let refusal = finish_refusal(&team).unwrap();
    assert!(refusal.contains("not complete") && refusal.contains("ux") && !refusal.contains("sec"), "{refusal}");
    workers.push(lensed("a2", 2, Some(9.2), SINCE + 3, "ux"));
    assert_eq!(finish_refusal(&team_with(on(9.0, 0, 0), workers)), None);
}

#[test]
fn a_setting_that_lifts_the_refusal_clears_its_error() {
    let (state, sid) = council_state(on(9.0, 0, 0));
    let mut team = saved(&state, &sid);
    team.status = "ready".into();
    team.workers = vec![writer("w", storage::now() - 50), seat("a", 1, Some(5.0), storage::now()), seat("b", 1, Some(9.0), storage::now())];
    store_team(&state, &mut team);
    let mut team = saved(&state, &sid);
    team.error = finish_refusal(&team);
    store_team(&state, &mut team);
    assert!(council::set(&state, &sid, Some(on(8.0, 0, 0))).unwrap().error.unwrap().contains("target 8"), "still below 8, and says so");
    assert_eq!(council::set(&state, &sid, Some(on(5.0, 0, 0))).unwrap().error, None);
    // An unrelated error stays.
    let mut team = saved(&state, &sid);
    team.error = Some("Team paused.".into());
    store_team(&state, &mut team);
    assert_eq!(council::set(&state, &sid, None).unwrap().error.as_deref(), Some("Team paused."));
}

#[test]
fn a_lead_change_is_dated_by_its_last_write() {
    let (state, sid) = council_state(on(9.0, 0, 0));
    let wrote = storage::now();
    std::thread::sleep(std::time::Duration::from_millis(3));
    let mut team = saved(&state, &sid);
    team.workers = vec![seat("a", 1, Some(9.0), storage::now()), seat("b", 1, Some(9.0), storage::now())];
    store_team(&state, &mut team);
    std::thread::sleep(std::time::Duration::from_millis(3));
    // The lead edited, then convened, and its turn ended after the round started.
    let summary = crate::turn_changes::TurnChanges { id: uuid::Uuid::new_v4().to_string(), files: vec![crate::turn_changes::ChangedFile { path: "index.html".into(), old_path: None, status: "modified".into(), additions: Some(1), deletions: Some(0), binary: false, truncated: false }], additions: 1, deletions: 0, truncated: false, concurrent: false, attributed: true, error: None };
    let detail = crate::turn_changes::TurnChangeDiff { path: "index.html".into(), old_path: None, patch: "+x\n".into(), binary: false, truncated: false, error: None };
    crate::turn_changes::persist_dated(&state.store.lock().unwrap(), &sid, crate::turn_changes::Captured { summary, details: vec![detail] }, wrote).unwrap();
    store_team(&state, &mut saved(&state, &sid));
    assert_eq!(saved(&state, &sid).changed_at, wrote);
    assert_eq!(finish_refusal(&saved(&state, &sid)), None, "the round saw that edit");
}

#[test]
fn stopping_marks_only_a_live_writer() {
    let mut parked = writer("p", 5);
    parked.status = "parked".into();
    council::note_stopped(&mut parked);
    assert_eq!(parked.wrote_at, 5);
    let mut stopped = writer("s", 5);
    stopped.status = "stopped".into();
    council::note_stopped(&mut stopped);
    assert_eq!(stopped.wrote_at, 5);
    // Pausing a live writer marks it: its run may have written until then.
    let (state, sid) = council_state(on(9.0, 0, 0));
    let (_run, _) = running_worker(&state, &sid, "w", "src");
    let mut team = saved(&state, &sid);
    team.workers[0].wrote_at = 5;
    store_team(&state, &mut team);
    control_state(&state, &sid, "pause").unwrap();
    assert!(saved(&state, &sid).workers[0].wrote_at > 5);
}

#[test]
fn an_overtaken_parked_seat_settles_and_never_relaunches() {
    let mut parked = seat("p", 1, None, SINCE + 1);
    parked.status = "parked".into();
    let mut team = team_with(on(9.0, 0, 0), vec![parked, writer("w", SINCE + 2)]);
    assert!(council::overtake(&mut team, 2).is_empty(), "a parked seat has no run to stop");
    assert_eq!((team.workers[0].status.as_str(), team.workers[0].abandoned), ("stopped", true));
    // An abandoned worker is never launched or resumed.
    let mut team = team_with(on(9.0, 0, 0), vec![seat("q", 1, None, SINCE + 1), seat("r", 1, None, SINCE + 1)]);
    team.workers[0].status = "queued".into();
    team.workers[0].abandoned = true;
    team.workers[1].status = "parked".into();
    team.workers[1].abandoned = true;
    assert!(!eligible(&team, 0));
    assert!(!resumable(&team, 1));
}

#[test]
fn overtaken_seats_stop_only_when_the_batch_commits() {
    let (state, sid) = council_state(on(9.0, 0, 0));
    call(&state, &sid, "pandacode_dispatch_workers", json!({"assignments":[reviewer_assignment("r1", "ux")]})).unwrap();
    let (_run, mut rx) = claim(&state, next_action_state(&state, &mut |_| {}).unwrap().unwrap());
    let mut team = saved(&state, &sid);
    team.workers.push(writer("w", storage::now() + 5));
    store_team(&state, &mut team);
    // A batch refused at its second assignment stops nothing.
    let bad = json!({"assignments":[reviewer_assignment("r2", "ux"), {"key":"bad","name":"b","prompt":"p"}]});
    assert!(call(&state, &sid, "pandacode_dispatch_workers", bad).is_err());
    assert!(rx.try_recv().is_err());
    assert_eq!(saved(&state, &sid).workers[0].status, "running");
    call(&state, &sid, "pandacode_dispatch_workers", json!({"assignments":[reviewer_assignment("r3", "ux")]})).unwrap();
    assert!(matches!(rx.try_recv(), Ok(RunInput::Stop)));
}

#[test]
fn turning_council_off_stops_its_running_reviewers() {
    let (state, sid) = council_state(on(9.0, 0, 0));
    call(&state, &sid, "pandacode_dispatch_workers", json!({"assignments":[reviewer_assignment("r1", "ux")]})).unwrap();
    let (_run, mut rx) = claim(&state, next_action_state(&state, &mut |_| {}).unwrap().unwrap());
    let team = council::set(&state, &sid, None).unwrap();
    assert_eq!((team.workers[0].status.as_str(), team.workers[0].abandoned), ("stopped", true));
    assert!(team.workers[0].error.as_deref().unwrap().contains("turned off"));
    assert!(matches!(rx.try_recv(), Ok(RunInput::Stop)));
}

#[test]
fn round_completeness_is_computed_once_per_round() {
    // Forty overtaken rounds of one seat each: a recursive check would take exponential time.
    let mut workers = vec![];
    for round in 1..=40 {
        workers.push(seat(&format!("s{round}"), round, Some(9.0), SINCE + round as i64 * 2));
        workers.push(writer(&format!("w{round}"), SINCE + round as i64 * 2 + 1));
    }
    let team = team_with(on(9.0, 0, 0), workers);
    let started = std::time::Instant::now();
    assert_eq!(council::status(&team).unwrap().state, "dispatch", "no seat is live");
    assert!(started.elapsed() < std::time::Duration::from_secs(1), "{:?}", started.elapsed());
}

#[test]
fn a_reviewers_sub_workers_do_not_outdate_its_round() {
    let (state, sid) = council_state(on(9.0, 0, 0));
    call(&state, &sid, "pandacode_dispatch_workers", json!({"assignments":[reviewer_assignment("r", "ux")]})).unwrap();
    let (run, actor) = {
        let (run, _rx) = claim(&state, next_action_state(&state, &mut |_| {}).unwrap().unwrap());
        let team = saved(&state, &sid);
        (run, coordination::Actor::resolve(&team, &team.workers[0].session_id).unwrap())
    };
    let coordination::Actor::Worker { id, attempt } = actor else { panic!("a worker") };
    let generation = saved(&state, &sid).generation;
    dispatch_as(&state, &sid, generation, Some((&id, attempt)), "pandacode_dispatch_workers", json!({"assignments":[{"key":"render","profileId":"fast","name":"render","prompt":"Render frames.","files":[],"readOnly":true}]}), &AtomicBool::new(false), &routing::AutoRoutes::default()).unwrap();
    let child = saved(&state, &sid).workers[1].session_id.clone();
    let mut team = saved(&state, &sid);
    team.workers[0].council.as_mut().unwrap().started_at = storage::now() - 100;
    team.workers.push(seat("b", 1, Some(9.0), storage::now()));
    store_team(&state, &mut team);
    turn_change(&state, &child, "frames", storage::now(), &["frames/001.png"], &[]);
    store_team(&state, &mut saved(&state, &sid));
    assert!(!saved(&state, &sid).council_status.unwrap().stale);
    drop(run);
}

/// A team resting while its lead asks the user about a round below the target.
fn resting_asking() -> (AppState, String) {
    let (state, sid) = council_state(on(9.0, 0, 0));
    let lead = objective_turn(&state, &sid);
    low_round(&state, &sid);
    finish(&state, &lead, "Should I keep fixing the parser?", true);
    let (run, _r) = claim(&state, next_action_state(&state, &mut |_| {}).unwrap().unwrap());
    finish(&state, &run, "Asking the user.", true);
    assert!(next_action_state(&state, &mut |_| {}).unwrap().is_none());
    assert_eq!(saved(&state, &sid).council_status.unwrap().state, "asking");
    (state, sid)
}

#[test]
fn lifting_the_refusal_wakes_the_lead_once_to_finish() {
    let (state, sid) = resting_asking();
    council::set(&state, &sid, Some(on(5.0, 0, 0))).unwrap();
    let turn = next_action_state(&state, &mut |_| {}).unwrap().unwrap();
    assert_eq!(turn.sid, sid);
    assert!(turn.prompt.contains("Verify the work and call finish_team") && turn.prompt.contains("first and final score"), "{}", turn.prompt);
    assert!(next_action_state(&state, &mut |_| {}).unwrap().is_none(), "once");
    // Turning Council off asks for no table; a refusal still standing wakes nobody.
    let (state, sid) = resting_asking();
    council::set(&state, &sid, Some(on(8.0, 0, 0))).unwrap();
    assert!(next_action_state(&state, &mut |_| {}).unwrap().is_none(), "5 is still below 8");
    council::set(&state, &sid, None).unwrap();
    let turn = next_action_state(&state, &mut |_| {}).unwrap().unwrap();
    // Accept and finish: the council block is gone, so the scores come in the prompt.
    assert!(turn.prompt.contains("first and final score (lens a: first 5, final 5; lens b: first 9, final 9)"), "{}", turn.prompt);
}

#[test]
fn a_low_round_without_new_writers_still_brings_the_lead_back_then_asks() {
    let (state, sid) = council_state(on(9.0, 0, 0));
    let lead = objective_turn(&state, &sid);
    // The cycle's only writer ran before it: a user message answered without delegating.
    let mut team = saved(&state, &sid);
    team.workers = vec![seat("a", 1, Some(5.0), storage::now()), seat("b", 1, Some(9.0), storage::now())];
    store_team(&state, &mut team);
    finish(&state, &lead, "It is slow because of X.", true);
    let (run, _r) = claim(&state, next_action_state(&state, &mut |_| {}).unwrap().unwrap());
    finish(&state, &run, "Asking the user.", true);
    assert!(next_action_state(&state, &mut |_| {}).unwrap().is_none());
    let team = saved(&state, &sid);
    assert_eq!(team.status, "ready");
    assert!(team.error.as_deref().is_some_and(|e| e.contains("lowest 5")), "never ready with no error: {:?}", team.error);
}

#[test]
fn every_round_starts_count_toward_the_limit() {
    let config = on(9.0, 2, 0);
    // Round 1 started and was overtaken; round 2 opens and counts too.
    let overtaken = team_with(config.clone(), vec![seat("a", 1, Some(9.0), SINCE + 1), writer("w", SINCE + 2)]);
    assert_eq!(council::round_for(&overtaken, &config, None).unwrap(), 2);
    let mut both = overtaken.workers.clone();
    both.extend([seat("b", 2, Some(9.0), SINCE + 3), writer("x", SINCE + 4)]);
    let team = team_with(config.clone(), both);
    assert!(council::round_for(&team, &config, None).unwrap_err().contains("limit of 2"));
    // At the limit, with nothing live, the lead finishes even though the round is incomplete.
    assert_eq!(finish_refusal(&team), None);
    assert_eq!(council::status(&team).unwrap().state, "limit");
    // A live seat holds the finish until it settles.
    let mut running = team.clone();
    running.workers[2].status = "running".into();
    running.workers[2].council.as_mut().unwrap().score = None;
    assert!(finish_refusal(&running).is_some());
    // A round whose seats have not run yet does not count.
    let mut queued = team_with(config.clone(), vec![seat("q", 1, None, SINCE + 1)]);
    queued.workers[0].status = "queued".into();
    queued.workers[0].council.as_mut().unwrap().started_at = 0;
    assert_eq!(council::round_for(&queued, &config, None).unwrap(), 1);
}

#[test]
fn a_full_round_counts_abandoned_seats_and_gives_way_to_the_next() {
    let mut workers = vec![writer("w", SINCE), seat("a", 1, Some(9.0), SINCE + 1)];
    for i in 0..7 {
        let mut dropped = lensed(&format!("d{i}"), 1, None, SINCE + 1, "lens a");
        dropped.status = "stopped".into();
        dropped.abandoned = true;
        workers.push(dropped);
    }
    let team = team_with(on(9.0, 0, 0), workers);
    // Eight seats, seven dropped: the round has no room, so the next one opens.
    assert_eq!(council::round_for(&team, team.config.council.as_ref().unwrap(), None).unwrap(), 2);
    // Abandoned seats that never scored are out of completeness; only one scored, so it is short.
    assert!(finish_refusal(&team).unwrap().contains("1 scored, at least 2"));
}

#[test]
fn round_one_fixes_the_lenses() {
    let workers = vec![writer("w", SINCE), lensed("u1", 1, Some(9.5), SINCE + 1, "UX "), lensed("s1", 1, Some(7.0), SINCE + 1, "sec"), writer("fix", SINCE + 2)];
    let team = team_with(on(9.0, 0, 0), workers.clone());
    let refused = council::seat_for(&team, Some("perf"), None).unwrap_err();
    assert!(refused.contains("fixed by round 1") && refused.contains("UX") && refused.contains("sec"), "{refused}");
    // Names match without case or spaces.
    assert_eq!(council::seat_for(&team, Some("ux"), None).unwrap().unwrap().round, 2);
    // Every first-round lens sits again, a passing one too.
    let mut next = workers;
    next.push(lensed("s2", 2, Some(9.5), SINCE + 3, "Sec"));
    next.push(lensed("x2", 2, Some(9.5), SINCE + 3, "sec"));
    let refusal = finish_refusal(&team_with(on(9.0, 0, 0), next.clone())).unwrap();
    assert!(refusal.contains("lenses round 1 seated: UX"), "{refusal}");
    next.push(lensed("u2", 2, Some(9.5), SINCE + 3, "ux"));
    assert_eq!(finish_refusal(&team_with(on(9.0, 0, 0), next)), None);
}

#[test]
fn notice_only_while_a_refusal_holds_the_team() {
    let mut low = team_with(on(9.5, 0, 0), vec![writer("w", SINCE), seat("a", 3, Some(8.3), SINCE + 1), seat("b", 3, Some(9.6), SINCE + 1)]);
    let status = council::status(&low).unwrap();
    assert_eq!((status.state.as_str(), status.notice), ("fixing", None));
    low.status = "ready".into();
    low.error = finish_refusal(&low);
    let status = council::status(&low).unwrap();
    assert_eq!(status.state, "asking");
    assert!(serde_json::to_value(&status).unwrap().get("ask").is_none());
    assert_eq!(status.notice.as_deref(), Some("The lead is asking how to continue: lowest score 8.3, target 9.5, after round 3."));
    // Whole scores print with one decimal, and a stop below the target reads the same way.
    let mut whole = team_with(on(9.0, 0, 0), vec![writer("w", SINCE), seat("a", 1, Some(8.0), SINCE + 1), seat("b", 1, Some(9.0), SINCE + 1)]);
    whole.status = "paused".into();
    whole.error = Some(format!("The architect ended without dispatching work or finishing. {} Resume to continue.", finish_refusal(&whole).unwrap()));
    assert_eq!(council::status(&whole).unwrap().notice.as_deref(), Some("The team stopped after Council round 1: lowest score 8.0, target 9.0."));
    whole.status = "ready".into();
    whole.error = finish_refusal(&whole);
    assert_eq!(council::status(&whole).unwrap().notice.as_deref(), Some("The lead is asking how to continue: lowest score 8.0, target 9.0, after round 1."));
    assert!(low.error.unwrap().contains("Accept and finish"));
    assert!(council::lead_rules(&team_with(on(9.0, 0, 0), vec![]), true).contains("Accept and finish"));
}

#[test]
fn a_saved_team_profile_never_carries_council() {
    let (state, _) = state_fixture();
    let store = state.store.lock().unwrap();
    let mut setup_config = config();
    setup_config.council = Some(on(9.0, 0, 0));
    let architect = profiles::ModelSelection { provider: "claude".into(), model: "default".into(), reasoning_effort: None };
    let library = profiles::save_profile(&store, None, "Reviewed".into(), profiles::TeamSetup { architect, config: setup_config }).unwrap();
    assert!(library.profiles.iter().all(|p| p.setup.config.council.is_none()));
}

#[test]
fn lifting_a_refusal_on_a_paused_team_keeps_its_pause_note() {
    let (state, sid) = council_state(on(9.0, 0, 0));
    let mut team = saved(&state, &sid);
    team.status = "paused".into();
    team.workers = vec![writer("w", storage::now() - 50), seat("a", 1, Some(5.0), storage::now()), seat("b", 1, Some(9.0), storage::now())];
    store_team(&state, &mut team);
    let mut team = saved(&state, &sid);
    team.error = Some(format!("The architect ended without dispatching work or finishing. {} Resume to continue.", finish_refusal(&team).unwrap()));
    store_team(&state, &mut team);
    let team = council::set(&state, &sid, Some(on(5.0, 0, 0))).unwrap();
    assert_eq!(team.error.as_deref(), Some("The architect ended without dispatching work or finishing. Resume to continue."));
}

#[test]
fn every_round_one_seat_fixes_its_lens() {
    // A scored, B overtaken without a score: round 2 must seat both again.
    let mut b = lensed("b", 1, None, SINCE + 1, "B");
    b.status = "stopped".into();
    b.abandoned = true;
    let workers = vec![writer("w", SINCE), lensed("a", 1, Some(9.5), SINCE + 1, "A"), b, writer("fix", SINCE + 2), lensed("a2", 2, Some(9.5), SINCE + 3, "A"), lensed("x2", 2, Some(9.5), SINCE + 3, "A")];
    let refusal = finish_refusal(&team_with(on(9.0, 0, 0), workers.clone())).unwrap();
    assert!(refusal.contains("lenses round 1 seated: B"), "{refusal}");
    let mut both = workers;
    both.push(lensed("b2", 2, Some(9.5), SINCE + 3, "B"));
    assert_eq!(finish_refusal(&team_with(on(9.0, 0, 0), both)), None);
}

#[test]
fn reconvening_after_cancelling_every_round_one_seat_works() {
    let (state, sid) = council_state(on(9.0, 0, 0));
    call(&state, &sid, "pandacode_dispatch_workers", json!({"assignments":[reviewer_assignment("r1", "A"), reviewer_assignment("r2", "B")]})).unwrap();
    // Both ran and stopped, then were cancelled; a writer changed the work after.
    let mut team = saved(&state, &sid);
    for w in &mut team.workers {
        w.status = "stopped".into();
        w.council.as_mut().unwrap().started_at = storage::now() - 100;
    }
    store_team(&state, &mut team);
    for id in saved(&state, &sid).workers.iter().map(|w| w.id.clone()).collect::<Vec<_>>() {
        call(&state, &sid, "pandacode_cancel_worker", json!({"workerId":id,"reason":"Wrong brief."})).unwrap();
    }
    let mut team = saved(&state, &sid);
    team.workers.push(writer("w", storage::now()));
    store_team(&state, &mut team);
    // The new round keeps both lenses, and only those.
    assert!(call(&state, &sid, "pandacode_dispatch_workers", json!({"assignments":[reviewer_assignment("r3", "C")]})).unwrap_err().contains("fixed by round 1: A, B"));
    call(&state, &sid, "pandacode_dispatch_workers", json!({"assignments":[reviewer_assignment("r4", "A"), reviewer_assignment("r5", "b")]})).unwrap();
    let team = saved(&state, &sid);
    assert!(team.workers.iter().filter(|w| !w.abandoned && w.council.is_some()).all(|w| w.council.as_ref().unwrap().round == 2));
}

#[test]
fn no_round_one_lenses_refuse_nothing() {
    let team = team_with(on(9.0, 0, 0), vec![seat("only", 2, Some(9.0), SINCE + 1), writer("w", SINCE + 2)]);
    assert!(council::seat_for(&team, Some("anything"), None).unwrap().is_some());
}

#[test]
fn a_running_reviewer_cannot_be_cancelled_or_replaced() {
    let (state, sid) = council_state(on(9.0, 0, 0));
    call(&state, &sid, "pandacode_dispatch_workers", json!({"assignments":[reviewer_assignment("r", "A")]})).unwrap();
    let (_run, _rx) = claim(&state, next_action_state(&state, &mut |_| {}).unwrap().unwrap());
    let id = saved(&state, &sid).workers[0].id.clone();
    assert_eq!(call(&state, &sid, "pandacode_cancel_worker", json!({"workerId":id,"reason":"Slow."})).unwrap_err(), council::RUNNING_SEAT);
    // Stopped, it can be cancelled.
    let mut team = saved(&state, &sid);
    team.workers[0].status = "stopped".into();
    store_team(&state, &mut team);
    call(&state, &sid, "pandacode_cancel_worker", json!({"workerId":id,"reason":"Stopped."})).unwrap();
}

#[test]
fn a_stopped_seat_is_named_for_cancelling() {
    let mut stopped = lensed("st", 1, None, SINCE + 1, "B");
    stopped.status = "stopped".into();
    let team = team_with(on(9.0, 0, 0), vec![writer("w", SINCE), lensed("a", 1, Some(9.5), SINCE + 1, "A"), stopped]);
    let refusal = finish_refusal(&team).unwrap();
    assert!(refusal.contains("Cancel the stopped reviewers st (st)") && !refusal.contains("wait for"), "{refusal}");
}

#[test]
fn a_full_round_with_a_low_score_cannot_open_a_fresh_one_without_a_change() {
    let mut workers = vec![writer("w", SINCE), seat("a", 1, Some(5.0), SINCE + 1)];
    for i in 0..7 {
        let mut dropped = lensed(&format!("d{i}"), 1, None, SINCE + 1, "lens a");
        dropped.status = "stopped".into();
        dropped.abandoned = true;
        workers.push(dropped);
    }
    let config = on(9.0, 0, 0);
    let team = team_with(config.clone(), workers.clone());
    assert!(council::round_for(&team, &config, None).unwrap_err().contains("nothing changed"));
    workers.push(writer("fix", SINCE + 2));
    assert_eq!(council::round_for(&team_with(config.clone(), workers), &config, None).unwrap(), 2);
}

#[test]
fn a_parked_reviewer_that_started_cannot_be_unseated() {
    let mut parked = seat("p", 1, None, SINCE + 1);
    parked.status = "parked".into();
    assert_eq!(council::refuse_unseat(&parked).unwrap_err(), council::RUNNING_SEAT);
    parked.status = "stopped".into();
    assert!(council::refuse_unseat(&parked).is_ok());
}

#[test]
fn a_reopened_finish_clears_the_continue_mark() {
    let (state, sid) = council_state(on(9.0, 0, 0));
    persist_turn(&state, &sid, &["index.html"]);
    let store = state.store.lock().unwrap();
    let mut team = load(&store, &sid).unwrap().unwrap();
    team.status = "completed".into();
    team.continued_revision = Some(team.dispatch_revision);
    assert!(reopen_for_council(&store, &mut team));
    assert_eq!(team.continued_revision, None, "the lead is woken, not paused as on a second stop");
}

#[test]
fn lifting_the_ask_with_a_refusal_still_standing_says_it() {
    let (state, sid) = resting_asking();
    // More reviewers than the round has: the question is answered, but the round is now short.
    council::set(&state, &sid, Some(on(5.0, 0, 3))).unwrap();
    let turn = next_action_state(&state, &mut |_| {}).unwrap().unwrap();
    assert!(turn.prompt.contains("Council still refuses") && turn.prompt.contains("at least 3 needed"), "{}", turn.prompt);
}

#[test]
fn accepting_finishes_this_cycle_and_keeps_council_on() {
    let (state, sid) = resting_asking();
    assert!(council::accept(&state, "no-such-task").is_err());
    let team = council::accept(&state, &sid).unwrap();
    assert!(team.config.council.is_some());
    assert_eq!(finish_refusal(&team), None);
    let status = team.council_status.clone().unwrap();
    assert_eq!((status.state.as_str(), status.lowest, status.target), ("accepted", Some(5.0), 9.0));
    assert_eq!(team.error, None, "the refusal is gone from the error");
    let turn = next_action_state(&state, &mut |_| {}).unwrap().unwrap();
    assert!(turn.prompt.contains("accepted the current Council scores") && turn.prompt.contains("lens a: first 5, final 5"), "{}", turn.prompt);
    // The next cycle reviews as usual.
    let mut team = saved(&state, &sid);
    team.status = "ready".into();
    team.pending_turn = None;
    store_team(&state, &mut team);
    std::thread::sleep(std::time::Duration::from_millis(3));
    start_state(&state, &sid, "Next request", None, None).unwrap();
    assert_ne!(saved(&state, &sid).council_status.unwrap().state, "accepted");
    // With Council off there is nothing to accept.
    council::set(&state, &sid, None).unwrap();
    assert!(council::accept(&state, &sid).unwrap_err().contains("off"));
}

#[test]
fn a_council_pause_has_a_plain_notice() {
    let mut team = team_with(on(9.0, 0, 0), vec![writer("w", SINCE), seat("a", 1, Some(9.5), SINCE + 1)]);
    team.status = "paused".into();
    team.error = Some(format!("The architect ended without dispatching work or finishing. {} Resume to continue.", finish_refusal(&team).unwrap()));
    assert_eq!(council::status(&team).unwrap().notice.as_deref(), Some("The team stopped with Council round 1 unfinished."));
    team.error = Some("Team paused.".into());
    assert_eq!(council::status(&team).unwrap().notice, None);
}

#[test]
fn a_second_reopen_in_a_cycle_rests_the_team() {
    let (state, sid) = council_state(on(9.0, 0, 0));
    persist_turn(&state, &sid, &["index.html"]);
    let store = state.store.lock().unwrap();
    let mut team = load(&store, &sid).unwrap().unwrap();
    team.status = "completed".into();
    assert!(reopen_for_council(&store, &mut team));
    assert_eq!(team.status, "waiting", "the first reopen wakes the lead");
    team.status = "completed".into();
    assert!(reopen_for_council(&store, &mut team));
    assert_eq!(team.status, "paused");
    assert!(team.error.as_deref().unwrap().contains("No Council round yet"), "{:?}", team.error);
    assert!(council::status(&team).unwrap().notice.is_some());
}

#[test]
fn a_reviewer_that_writes_the_work_outdates_its_round() {
    let (state, sid) = council_state(on(9.0, 0, 0));
    call(&state, &sid, "pandacode_dispatch_workers", json!({"assignments":[reviewer_assignment("r", "ux")]})).unwrap();
    let reviewer = saved(&state, &sid).workers[0].session_id.clone();
    let mut team = saved(&state, &sid);
    team.workers[0].status = "completed".into();
    team.workers[0].council.as_mut().unwrap().score = Some(9.0);
    team.workers[0].council.as_mut().unwrap().started_at = storage::now() - 100;
    let mut other = seat("b", 1, Some(9.0), storage::now());
    other.council.as_mut().unwrap().started_at = storage::now() - 100;
    team.workers.push(other);
    store_team(&state, &mut team);
    let summary = crate::turn_changes::TurnChanges { id: uuid::Uuid::new_v4().to_string(), files: vec![crate::turn_changes::ChangedFile { path: "src/app.rs".into(), old_path: None, status: "modified".into(), additions: Some(1), deletions: Some(0), binary: false, truncated: false }], additions: 1, deletions: 0, truncated: false, concurrent: false, attributed: true, error: None };
    let detail = crate::turn_changes::TurnChangeDiff { path: "src/app.rs".into(), old_path: None, patch: "+x\n".into(), binary: false, truncated: false, error: None };
    crate::turn_changes::persist_dated(&state.store.lock().unwrap(), &reviewer, crate::turn_changes::Captured { summary, details: vec![detail] }, storage::now()).unwrap();
    store_team(&state, &mut saved(&state, &sid));
    assert!(saved(&state, &sid).council_status.unwrap().stale, "a real write by the reviewer counts");
}

#[test]
fn accepting_stops_live_reviewers_and_wakes_only_when_it_lifts_a_refusal() {
    let (state, sid) = council_state(on(9.0, 0, 0));
    call(&state, &sid, "pandacode_dispatch_workers", json!({"assignments":[reviewer_assignment("r1", "ux")]})).unwrap();
    let (_run, mut rx) = claim(&state, next_action_state(&state, &mut |_| {}).unwrap().unwrap());
    let team = council::accept(&state, &sid).unwrap();
    assert_eq!((team.workers[0].status.as_str(), team.workers[0].abandoned), ("stopped", true));
    assert!(matches!(rx.try_recv(), Ok(RunInput::Stop)));
    // A cycle that already passes has nothing to wake the lead for.
    let (state, sid) = council_state(on(9.0, 0, 0));
    let mut team = saved(&state, &sid);
    team.status = "ready".into();
    store_team(&state, &mut team);
    assert_eq!(finish_refusal(&saved(&state, &sid)), None);
    assert!(council::accept(&state, &sid).unwrap().pending_turn.is_none());
}

#[test]
fn dispatch_judges_rounds_on_changes_saved_since_the_last_save() {
    let (state, sid) = council_state(on(9.0, 0, 0));
    call(&state, &sid, "pandacode_dispatch_workers", json!({"assignments":[assignment("w", "fast", "src")]})).unwrap();
    let writer_session = saved(&state, &sid).workers[0].session_id.clone();
    let mut team = saved(&state, &sid);
    team.workers[0].status = "completed".into();
    team.workers.push(seat("a", 1, Some(9.0), storage::now() - 100));
    store_team(&state, &mut team);
    // The writer's turn is recorded after the round started, with no team save since.
    turn_change(&state, &writer_session, "late", storage::now(), &["src/a.rs"], &[]);
    call(&state, &sid, "pandacode_dispatch_workers", json!({"assignments":[reviewer_assignment("r2", "lens a")]})).unwrap();
    assert_eq!(saved(&state, &sid).workers.last().unwrap().council.as_ref().unwrap().round, 2, "round 1 is out of date");
}

#[test]
fn accepting_a_paused_team_lifts_the_refusal_and_leaves_resume_to_the_user() {
    let (state, sid) = council_state(on(9.0, 0, 0));
    let mut team = saved(&state, &sid);
    team.status = "paused".into();
    team.workers = vec![writer("w", storage::now() - 50), seat("a", 1, Some(5.0), storage::now()), seat("b", 1, Some(9.0), storage::now())];
    store_team(&state, &mut team);
    let mut team = saved(&state, &sid);
    team.error = Some(format!("The architect ended without dispatching work or finishing. {} Resume to continue.", finish_refusal(&team).unwrap()));
    store_team(&state, &mut team);
    let team = council::accept(&state, &sid).unwrap();
    assert_eq!(team.status, "paused");
    assert!(team.pending_turn.is_none(), "Resume continues it, not a wake");
    assert_eq!(team.error.as_deref(), Some("The architect ended without dispatching work or finishing. Resume to continue."));
}

#[test]
fn at_the_limit_a_round_that_can_still_be_filled_comes_first() {
    let config = on(9.0, 1, 0);
    // Round 1 started and is current, one seat short: the lead fills it before finishing.
    let short = team_with(config.clone(), vec![writer("w", SINCE), seat("a", 1, Some(9.5), SINCE + 1)]);
    assert!(finish_refusal(&short).unwrap().contains("not complete"));
    assert_eq!(council::round_for(&short, &config, None).unwrap(), 1);
    // Full of dropped seats, it cannot be filled: finishing is allowed.
    let mut full = short.workers.clone();
    for i in 0..7 {
        let mut dropped = lensed(&format!("d{i}"), 1, None, SINCE + 1, "lens a");
        dropped.status = "stopped".into();
        dropped.abandoned = true;
        full.push(dropped);
    }
    assert_eq!(finish_refusal(&team_with(config.clone(), full)), None);
    // Complete below the target: finishing is allowed too.
    let mut done = short.workers.clone();
    done.push(seat("b", 1, Some(5.0), SINCE + 1));
    assert_eq!(finish_refusal(&team_with(config, done)), None);
}

#[test]
fn changed_at_reads_only_this_cycles_rows() {
    let (state, sid) = council_state(on(9.0, 0, 0));
    call(&state, &sid, "pandacode_dispatch_workers", json!({"assignments":[assignment("w", "fast", "src")]})).unwrap();
    let writer = saved(&state, &sid).workers[0].session_id.clone();
    // A row written before the lead's last message from before this cycle is old history, whatever its
    // timestamp says (a clock that jumped): it is not read.
    turn_change(&state, &writer, "old", storage::now() + 60_000, &["src/a.rs"], &[]);
    let since = saved(&state, &sid).council_since;
    state.store.lock().unwrap().db.execute("INSERT INTO messages(session_id,role,content,created_at) VALUES(?1,'user','Earlier',?2)", params![sid, since - 1]).unwrap();
    store_team(&state, &mut saved(&state, &sid));
    assert_eq!(saved(&state, &sid).changed_at, 0);
    // A row of this cycle is.
    turn_change(&state, &writer, "new", storage::now(), &["src/b.rs"], &[]);
    store_team(&state, &mut saved(&state, &sid));
    assert!(saved(&state, &sid).changed_at > 0);
}

#[test]
fn raising_the_limit_on_a_resting_team_wakes_the_lead_once() {
    let (state, sid) = council_state(on(9.0, 1, 0));
    let mut team = saved(&state, &sid);
    team.status = "completed".into();
    team.workers = vec![writer("w", storage::now() - 50), seat("a", 1, Some(5.0), storage::now()), seat("b", 1, Some(9.0), storage::now())];
    store_team(&state, &mut team);
    let team = saved(&state, &sid);
    assert_eq!((team.council_status.unwrap().state.as_str(), finish_refusal(&saved(&state, &sid))), ("limit", None));
    // The same setting again changes nothing.
    assert!(council::set(&state, &sid, Some(on(9.0, 1, 0))).unwrap().pending_turn.is_none());
    let team = council::set(&state, &sid, Some(on(9.0, 2, 0))).unwrap();
    assert_eq!(team.status, "running");
    assert_eq!(team.council_status.as_ref().unwrap().state, "fixing");
    let turn = next_action_state(&state, &mut |_| {}).unwrap().unwrap();
    assert!(turn.prompt.starts_with("The user raised the Council round limit to 2, so Council refuses again: Council round 1: lowest 5, target 9."), "{}", turn.prompt);
    // A passed council has nothing to reopen.
    let (state, sid) = council_state(on(9.0, 1, 0));
    let mut team = saved(&state, &sid);
    team.status = "completed".into();
    team.workers = vec![writer("w", storage::now() - 50), seat("a", 1, Some(9.5), storage::now()), seat("b", 1, Some(9.0), storage::now())];
    store_team(&state, &mut team);
    let team = council::set(&state, &sid, Some(on(9.0, 2, 0))).unwrap();
    assert_eq!((team.status.as_str(), team.pending_turn.is_none()), ("completed", true));
    // A paused team is the user's to resume: the raise wakes nobody.
    let (state, sid) = council_state(on(9.0, 1, 0));
    let mut team = saved(&state, &sid);
    team.status = "paused".into();
    team.workers = vec![writer("w", storage::now() - 50), seat("a", 1, Some(5.0), storage::now()), seat("b", 1, Some(9.0), storage::now())];
    store_team(&state, &mut team);
    let team = council::set(&state, &sid, Some(on(9.0, 2, 0))).unwrap();
    assert_eq!((team.status.as_str(), team.pending_turn.is_none()), ("paused", true));
}
