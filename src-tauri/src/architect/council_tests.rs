use super::*;
#[path = "council_flow_tests.rs"]
mod flow;
use crate::architect::council::review;
use council::{finish_refusal, parse_score, CouncilConfig, CouncilSeat};

const SINCE: i64 = 1000;

/// `max_rounds` 0 here stands for the most a config allows.
fn on(target: f64, max_rounds: usize, reviewers: usize) -> CouncilConfig {
    CouncilConfig { target, max_rounds: if max_rounds == 0 { 100 } else { max_rounds }, reviewers }
}
/// A settled reviewer of the current cycle.
fn seat(id: &str, round: usize, score: Option<f64>, created: i64) -> Worker {
    let mut reviewer = worker(id, "completed", &[], &[]);
    reviewer.read_only = true;
    reviewer.created_at = created;
    reviewer.updated_at = created;
    reviewer.council = Some(CouncilSeat { round, lens: format!("lens {id}"), score, started_at: created });
    reviewer
}
fn writer(id: &str, wrote_at: i64) -> Worker {
    let mut writer = worker(id, "completed", &["src"], &[]);
    writer.created_at = wrote_at;
    writer.updated_at = wrote_at;
    writer.wrote_at = wrote_at;
    writer
}
fn team_with(config: CouncilConfig, workers: Vec<Worker>) -> TeamSnapshot {
    let (_, mut team) = fixture();
    team.config.council = Some(config);
    team.council_since = SINCE;
    team.workers = workers;
    team
}
/// A running team with Council on, saved in a fresh app state.
fn council_state(config: CouncilConfig) -> (AppState, String) {
    let (state, sid) = state_fixture();
    council::set(&state, &sid, Some(config)).unwrap();
    (state, sid)
}
fn reviewer_assignment(key: &str, lens: &str) -> Value {
    json!({"key":key,"profileId":"fast","name":key,"prompt":format!("Review {key}."),"files":[],"councilLens":lens})
}
fn saved(state: &AppState, sid: &str) -> TeamSnapshot {
    load(&state.store.lock().unwrap(), sid).unwrap().unwrap()
}
fn store_team(state: &AppState, team: &mut TeamSnapshot) {
    save(&state.store.lock().unwrap(), team).unwrap();
}

#[test]
fn score_parsing_takes_the_last_marked_line() {
    assert_eq!(parse_score("Fine.\n\nCouncil score: 8/10"), Some(8.0));
    assert_eq!(parse_score("**Council score: 9.5/10**"), Some(9.5));
    assert_eq!(parse_score("**Council score:** 7"), Some(7.0));
    assert_eq!(parse_score("## council SCORE: 10 / 10\n"), Some(10.0));
    assert_eq!(parse_score("Council score: 0/10"), Some(0.0));
    // Only a line that starts with it counts.
    assert_eq!(parse_score("The council score was 3/10 last time."), None);
    assert_eq!(parse_score("Report.\nMy council score is 3.\nDone."), None);
    // The last one wins, even when it is unusable.
    assert_eq!(parse_score("Council score: 3/10\nFixes.\nCouncil score: 9/10\nThanks."), Some(9.0));
    assert_eq!(parse_score("Council score: 9/10\nCouncil score: N/10"), None);
    // Out of range or malformed.
    assert_eq!(parse_score("Council score: 11/10"), None);
    assert_eq!(parse_score("Council score: 10.5"), None);
    assert_eq!(parse_score("Council score: -3/10"), None);
    assert_eq!(parse_score("Council score: 8/100"), None);
    assert_eq!(parse_score("Council score: 8/5"), None);
    assert_eq!(parse_score("Council scores: 8/10"), None);
    assert_eq!(parse_score("Council score: 1e400"), None);
    assert_eq!(parse_score("Council score:"), None);
    assert_eq!(parse_score(""), None);
}

#[test]
fn config_validation_bounds_every_field() {
    for good in [on(1.0, 0, 0), on(10.0, 100, 8), on(9.5, 3, 2)] {
        assert!(good.validate().is_ok());
    }
    for bad in [on(0.5, 0, 0), on(10.5, 0, 0), on(f64::NAN, 0, 0), on(f64::INFINITY, 0, 0), on(9.0, 101, 0), on(9.0, 0, 9)] {
        assert!(bad.validate().is_err(), "{bad:?}");
    }
    let mut team_config = config();
    team_config.council = Some(on(11.0, 0, 0));
    assert!(team_config.validate().is_err());
}

#[test]
fn saved_json_from_before_council_still_parses() {
    let (_, mut team) = fixture();
    team.workers = vec![worker("a", "completed", &[], &[])];
    let value = serde_json::to_value(&team).unwrap();
    assert!(value["config"].get("council").is_none(), "skipped when off");
    assert!(value["workers"][0].get("council").is_none(), "skipped when off");
    let mut old = value;
    old.as_object_mut().unwrap().remove("councilSince");
    let row = old["workers"][0].as_object_mut().unwrap();
    row.remove("wroteAt");
    row.remove("scoreNudged");
    let parsed: TeamSnapshot = serde_json::from_value(old).unwrap();
    assert_eq!(parsed.council_since, 0);
    assert_eq!(parsed.workers[0].wrote_at, 0);
    assert!(parsed.config.council.is_none());
    // A config sent without its optional fields takes the defaults.
    let config: CouncilConfig = serde_json::from_value(json!({"target":9.5})).unwrap();
    assert_eq!(config, on(9.5, 10, 0), "ten rounds unless the user says otherwise");
    // Rounds are always bounded.
    let none: CouncilConfig = serde_json::from_value(json!({"target":9.0,"maxRounds":0})).unwrap();
    assert!(none.validate().is_err());
    assert_eq!(serde_json::to_value(on(9.5, 3, 2)).unwrap(), json!({"target":9.5,"maxRounds":3,"reviewers":2}));
}

#[test]
fn lens_needs_council_and_a_valid_name() {
    let (state, sid) = state_fixture();
    let refused = call(&state, &sid, "pandacode_dispatch_workers", json!({"assignments":[reviewer_assignment("r", "correctness")]})).unwrap_err();
    assert!(refused.contains("Council is off"), "{refused}");
    assert!(saved(&state, &sid).workers.is_empty());
    council::set(&state, &sid, Some(on(9.0, 0, 0))).unwrap();
    for lens in ["", "   ", &"x".repeat(81), "two\nlines"] {
        let refused = call(&state, &sid, "pandacode_dispatch_workers", json!({"assignments":[reviewer_assignment("r", lens)]})).unwrap_err();
        assert!(refused.contains("councilLens"), "{refused}");
    }
}

#[test]
fn a_lens_forces_read_only_and_joins_one_round_per_batch() {
    let (state, sid) = council_state(on(9.0, 0, 0));
    let mut first = reviewer_assignment("r1", "correctness");
    first["readOnly"] = json!(false);
    call(&state, &sid, "pandacode_dispatch_workers", json!({"assignments":[first, reviewer_assignment("r2", "security")]})).unwrap();
    let team = saved(&state, &sid);
    assert!(team.workers.iter().all(|w| w.read_only));
    assert_eq!(team.workers.iter().map(|w| w.council.as_ref().unwrap().round).collect::<Vec<_>>(), [1, 1]);
    assert_eq!(team.workers[1].council.as_ref().unwrap().lens, "security");
}

#[test]
fn round_joins_while_open_and_opens_the_next_when_complete() {
    let (state, sid) = council_state(on(9.0, 2, 0));
    let mut team = saved(&state, &sid);
    team.council_since = SINCE;
    // One scored seat is below the minimum of two: still open.
    team.workers = vec![seat("a", 1, Some(9.0), SINCE)];
    store_team(&state, &mut team);
    let dispatch = |key: &str| call(&state, &sid, "pandacode_dispatch_workers", json!({"assignments":[reviewer_assignment(key, "ux")]}));
    dispatch("joins").unwrap();
    assert_eq!(saved(&state, &sid).workers.last().unwrap().council.as_ref().unwrap().round, 1);
    let mut team = saved(&state, &sid);
    team.workers.last_mut().unwrap().status = "completed".into();
    team.workers.last_mut().unwrap().council.as_mut().unwrap().score = Some(5.0);
    store_team(&state, &mut team);
    // Complete below the target with nothing changed since: no re-roll.
    let refused = dispatch("reroll").unwrap_err();
    assert!(refused.contains("nothing changed"), "{refused}");
    let mut team = saved(&state, &sid);
    team.workers.push(writer("fix", storage::now()));
    store_team(&state, &mut team);
    // Complete and fixed since: the next reviewer opens round 2, the configured limit.
    dispatch("next").unwrap();
    assert_eq!(saved(&state, &sid).workers.last().unwrap().council.as_ref().unwrap().round, 2);
    let mut team = saved(&state, &sid);
    team.workers.last_mut().unwrap().status = "completed".into();
    team.workers.last_mut().unwrap().council.as_mut().unwrap().score = Some(5.0);
    // Every lens round 1 seated sits again.
    team.workers.push(lensed("c", 2, Some(5.0), storage::now(), "lens a"));
    store_team(&state, &mut team);
    let refused = dispatch("past").unwrap_err();
    assert!(refused.contains("limit") && refused.contains('2'), "{refused}");
}

#[test]
fn the_configured_reviewer_count_keeps_a_round_open() {
    let team = team_with(on(9.0, 0, 3), vec![seat("a", 1, Some(9.0), SINCE), seat("b", 1, Some(9.0), SINCE)]);
    assert_eq!(council::round_for(&team, team.config.council.as_ref().unwrap(), None).unwrap(), 1);
    assert!(!council::complete(&team, team.config.council.as_ref().unwrap(), 1));
}

#[test]
fn an_abandoned_unscored_seat_leaves_its_round_but_a_score_stands() {
    // A seat that never ran (its dependency failed) drops out freely.
    let mut failed = seat("failed", 1, None, SINCE);
    failed.status = "failed".into();
    failed.abandoned = true;
    failed.council.as_mut().unwrap().started_at = 0;
    let team = team_with(on(9.0, 0, 0), vec![writer("w", SINCE), failed, seat("a", 1, Some(9.0), SINCE + 1), seat("b", 1, Some(9.5), SINCE + 1)]);
    assert_eq!(finish_refusal(&team), None);
    // An abandoned seat with a score still counts, low score and all.
    let mut low = seat("low", 1, Some(2.0), SINCE);
    low.abandoned = true;
    let mut team = team;
    team.workers.push(low);
    assert!(finish_refusal(&team).unwrap().contains("lowest 2"));
    // Unscored abandoned seats do not count toward the minimum.
    team.workers.pop();
    team.workers[2].council.as_mut().unwrap().score = None;
    team.workers[2].abandoned = true;
    assert!(finish_refusal(&team).unwrap().contains("not complete"));
}

#[test]
fn a_scored_seat_cannot_be_cancelled_or_replaced() {
    let (state, sid) = council_state(on(9.0, 0, 0));
    let mut team = saved(&state, &sid);
    let mut failed = seat("failed", 1, None, storage::now());
    failed.status = "failed".into();
    team.workers = vec![seat("a", 1, Some(4.0), storage::now()), failed];
    store_team(&state, &mut team);
    let refused = call(&state, &sid, "pandacode_cancel_worker", json!({"workerId":"a","reason":"Too harsh."})).unwrap_err();
    assert_eq!(refused, council::SCORED_STANDS);
    let mut replacement = reviewer_assignment("again", "ux");
    replacement["replaces"] = json!("a");
    assert_eq!(call(&state, &sid, "pandacode_dispatch_workers", json!({"assignments":[replacement]})).unwrap_err(), council::SCORED_STANDS);
    let team = saved(&state, &sid);
    assert!(!team.workers[0].abandoned && team.workers.len() == 2);
    // An unscored seat keeps today's paths.
    call(&state, &sid, "pandacode_cancel_worker", json!({"workerId":"failed","reason":"It crashed."})).unwrap();
    assert!(saved(&state, &sid).workers[1].abandoned);
}

#[test]
fn a_replacement_joins_the_seat_it_replaces_and_keeps_its_lens() {
    let (state, sid) = council_state(on(9.0, 1, 0));
    let mut team = saved(&state, &sid);
    let mut failed = seat("b", 1, None, storage::now());
    failed.status = "failed".into();
    team.workers = vec![seat("a", 1, Some(9.0), storage::now()), seat("c", 1, Some(9.0), storage::now()), failed];
    store_team(&state, &mut team);
    let mut replacement = reviewer_assignment("again", "ignored");
    replacement.as_object_mut().unwrap().remove("councilLens");
    replacement["replaces"] = json!("b");
    // The round is at its limit, yet the replacement belongs to it.
    call(&state, &sid, "pandacode_dispatch_workers", json!({"assignments":[replacement]})).unwrap();
    let team = saved(&state, &sid);
    let new = team.workers.last().unwrap();
    assert!(new.read_only);
    assert_eq!(new.council, Some(CouncilSeat { round: 1, lens: "lens b".into(), score: None, started_at: 0 }));
    assert!(team.workers[2].abandoned);
}

#[test]
fn gate_refuses_below_target_with_the_numbers() {
    let team = team_with(on(9.5, 0, 0), vec![writer("w", SINCE), seat("a", 2, Some(8.3), SINCE + 1), seat("b", 2, Some(9.9), SINCE + 1)]);
    let refusal = finish_refusal(&team).unwrap();
    assert_eq!(refusal, "Council round 2: lowest 8.3, target 9.5. Fix the blockers with workers, then dispatch a new round with councilLens. If a remaining blocker should not be fixed, end your turn and tell the user, who can lower the target or turn Council off; if they say to accept the current scores, tell them to press Accept and finish on the Council card.");
    assert!(review(&team_with(on(9.5, 0, 0), vec![writer("w", SINCE), seat("a", 2, Some(8.3), SINCE + 1), seat("b", 2, Some(9.9), SINCE + 1)])).unwrap()["next"].as_str().unwrap().contains("lower the target"));
}

#[test]
fn gate_passes_on_the_lowest_score_not_the_average() {
    let team = team_with(on(9.0, 0, 0), vec![writer("w", SINCE), seat("a", 1, Some(9.0), SINCE + 1), seat("b", 1, Some(10.0), SINCE + 1)]);
    assert_eq!(finish_refusal(&team), None);
    let team = team_with(on(9.0, 0, 0), vec![writer("w", SINCE), seat("a", 1, Some(8.9), SINCE + 1), seat("b", 1, Some(10.0), SINCE + 1)]);
    assert!(finish_refusal(&team).is_some());
}

#[test]
fn gate_refuses_a_round_older_than_a_writer() {
    let team = team_with(on(9.0, 0, 0), vec![seat("a", 1, Some(9.5), SINCE + 1), seat("b", 1, Some(9.5), SINCE + 5), writer("w", SINCE + 2)]);
    let refusal = finish_refusal(&team).unwrap();
    assert!(refusal.contains("round 1") && refusal.contains("new round"), "{refusal}");
}

/// A reviewer with a given lens.
fn lensed(id: &str, round: usize, score: Option<f64>, created: i64, lens: &str) -> Worker {
    let mut reviewer = seat(id, round, score, created);
    reviewer.council.as_mut().unwrap().lens = lens.into();
    reviewer
}

#[test]
fn gate_at_the_round_limit() {
    // Two completed rounds below target with a limit of 2: the lead may finish and say so.
    let limit = on(9.0, 2, 0);
    let rounds = vec![writer("w", SINCE), lensed("a1", 1, Some(7.0), SINCE + 1, "ux"), lensed("b1", 1, Some(8.0), SINCE + 1, "sec"), writer("fix", SINCE + 2), lensed("a2", 2, Some(8.0), SINCE + 3, "ux"), lensed("b2", 2, Some(8.5), SINCE + 3, "sec")];
    let team = team_with(limit.clone(), rounds.clone());
    assert_eq!(finish_refusal(&team), None);
    // A writer since then cannot hold the team open: no further round can run.
    let mut later = rounds.clone();
    later.push(writer("late", SINCE + 4));
    let team = team_with(limit.clone(), later);
    assert_eq!(finish_refusal(&team), None);
    assert!(review(&team).unwrap()["next"].as_str().unwrap().contains("round limit"));
    // One completed round of two is the ordinary refusal.
    let team = team_with(limit, rounds[..3].to_vec());
    assert!(finish_refusal(&team).unwrap().contains("Fix the blockers"));
}

#[test]
fn gate_ignores_teams_without_writers_and_with_council_off() {
    // Reviewers alone, or nothing at all: as today.
    assert_eq!(finish_refusal(&team_with(on(9.0, 0, 0), vec![])), None);
    // Once a round exists its scores bind, writers or not.
    let low = team_with(on(9.0, 0, 0), vec![seat("a", 1, Some(1.0), SINCE), seat("b", 1, Some(9.0), SINCE)]);
    assert!(finish_refusal(&low).unwrap().contains("lowest 1"));
    assert!(!review(&low).unwrap()["next"].as_str().unwrap().contains("no council is needed"));
    // A writer that never ran changed nothing.
    assert_eq!(finish_refusal(&team_with(on(9.0, 0, 0), vec![writer("w", 0)])), None);
    let mut off = team_with(on(9.0, 0, 0), vec![writer("w", SINCE)]);
    off.config.council = None;
    assert_eq!(finish_refusal(&off), None);
    let refusal = finish_refusal(&team_with(on(9.0, 0, 3), vec![writer("w", SINCE)])).unwrap();
    assert!(refusal.contains("3 reviewers") && refusal.contains("councilLens"), "{refusal}");
}

#[test]
fn a_new_cycle_ignores_earlier_rounds_and_writers() {
    let old = vec![writer("old", SINCE - 10), seat("a", 4, Some(1.0), SINCE - 5), seat("b", 4, Some(1.0), SINCE - 5)];
    let team = team_with(on(9.0, 2, 0), old.clone());
    assert_eq!(finish_refusal(&team), None, "no writer in this cycle");
    assert_eq!(council::round_for(&team, team.config.council.as_ref().unwrap(), None).unwrap(), 1, "rounds restart");
    let mut current = old;
    current.push(writer("new", SINCE + 1));
    let refusal = finish_refusal(&team_with(on(9.0, 2, 0), current)).unwrap();
    assert!(refusal.contains("No Council round"), "{refusal}");
}

#[test]
fn finish_team_runs_the_gate_after_the_existing_checks() {
    let (state, sid) = council_state(on(9.0, 0, 0));
    let mut team = saved(&state, &sid);
    team.workers = vec![writer("w", storage::now())];
    store_team(&state, &mut team);
    let refused = call(&state, &sid, "pandacode_finish_team", json!({"summary":"Done."})).unwrap_err();
    assert!(refused.contains("councilLens"), "{refused}");
    assert_eq!(saved(&state, &sid).status, "running");
    let mut team = saved(&state, &sid);
    team.workers.push(seat("a", 1, Some(9.0), storage::now() + 10));
    team.workers.push(seat("b", 1, Some(9.0), storage::now() + 10));
    store_team(&state, &mut team);
    call(&state, &sid, "pandacode_finish_team", json!({"summary":"Done."})).unwrap();
    assert_eq!(saved(&state, &sid).status, "completed");
}

#[test]
fn start_state_begins_a_new_cycle_in_the_same_clock_as_workers() {
    let (state, sid) = state_fixture();
    let mut team = saved(&state, &sid);
    team.status = "ready".into();
    store_team(&state, &mut team);
    let before = storage::now();
    start_state(&state, &sid, "A new objective", None, None).unwrap();
    let since = saved(&state, &sid).council_since;
    assert!(since >= before && since <= storage::now());
    // Worker timestamps come from the same millisecond clock.
    let (run, _) = running_worker(&state, &sid, "w", "src");
    let team = saved(&state, &sid);
    assert!(team.workers[0].created_at >= since && team.workers[0].wrote_at >= since);
    drop(run);
}

#[test]
fn only_real_work_moves_a_writers_mark() {
    let (state, sid) = council_state(on(9.0, 0, 0));
    let (run, actor) = running_worker(&state, &sid, "w", "src");
    let started = saved(&state, &sid).workers[0].wrote_at;
    assert!(started > 0, "launch marks it");
    // A checkpoint is not an edit, though it moves updated_at.
    let mut team = saved(&state, &sid);
    team.workers[0].wrote_at = 5;
    store_team(&state, &mut team);
    coordinate(&state, &sid, &actor, "pandacode_checkpoint_worker", json!({"key":"c1","summary":"s","nextSteps":"n"})).unwrap();
    assert_eq!(saved(&state, &sid).workers[0].wrote_at, 5);
    finish(&state, &run, "Done.", true);
    let settled = saved(&state, &sid).workers[0].wrote_at;
    assert!(settled >= started, "a run's end marks it");
    // Cancelling or replacing a settled writer changes nothing in the checkout.
    call(&state, &sid, "pandacode_cancel_worker", json!({"workerId":saved(&state, &sid).workers[0].id,"reason":"Not needed."})).unwrap();
    let team = saved(&state, &sid);
    assert_eq!(team.workers[0].wrote_at, settled);
    assert!(team.workers[0].abandoned);
}

#[test]
fn cancelling_a_live_writer_marks_it_and_a_queued_one_stays_unmarked() {
    let (state, sid) = council_state(on(9.0, 0, 0));
    let (_run, _) = running_worker(&state, &sid, "w", "src");
    let mut team = saved(&state, &sid);
    team.workers[0].wrote_at = 5;
    store_team(&state, &mut team);
    call(&state, &sid, "pandacode_cancel_worker", json!({"workerId":team.workers[0].id,"reason":"Wrong."})).unwrap();
    assert!(saved(&state, &sid).workers[0].wrote_at > 5, "it ran until now");
    call(&state, &sid, "pandacode_dispatch_workers", json!({"assignments":[assignment("q", "fast", "tests")]})).unwrap();
    let id = saved(&state, &sid).workers[1].id.clone();
    call(&state, &sid, "pandacode_cancel_worker", json!({"workerId":id,"reason":"Not needed."})).unwrap();
    assert_eq!(saved(&state, &sid).workers[1].wrote_at, 0);
}

#[test]
fn a_reviewers_score_comes_from_the_tail_of_a_long_report() {
    let (state, sid) = council_state(on(9.0, 0, 0));
    call(&state, &sid, "pandacode_dispatch_workers", json!({"assignments":[reviewer_assignment("r", "correctness")]})).unwrap();
    let (run, _rx) = claim(&state, next_action_state(&state, &mut |_| {}).unwrap().unwrap());
    let report = format!("{}\n\n**Council score: 8.5/10**", "Finding. ".repeat(4000));
    assert!(report.len() > SUMMARY_PREVIEW);
    finish(&state, &run, &report, true);
    let team = saved(&state, &sid);
    assert_eq!(team.workers[0].status, "completed");
    assert_eq!(team.workers[0].council.as_ref().unwrap().score, Some(8.5));
    assert_eq!(team.workers[0].wrote_at, 0, "a reviewer is no writer");
    assert!(!team.workers[0].score_nudged);
}

#[test]
fn a_missing_score_is_asked_for_once_then_fails_without_looping() {
    let (state, sid) = council_state(on(9.0, 0, 0));
    call(&state, &sid, "pandacode_dispatch_workers", json!({"assignments":[reviewer_assignment("r", "correctness")]})).unwrap();
    let (run, _rx) = claim(&state, next_action_state(&state, &mut |_| {}).unwrap().unwrap());
    let reviewer_session = run.config.session_id.clone();
    finish(&state, &run, "Looks fine overall.", true);
    let team = saved(&state, &sid);
    assert_eq!(team.workers[0].status, "queued");
    assert!(team.workers[0].score_nudged);
    let (again, _rx) = claim(&state, next_action_state(&state, &mut |_| {}).unwrap().unwrap());
    assert_eq!(again.config.session_id, reviewer_session, "same conversation");
    assert!(again.config.prompt.contains("Council score: N/10"), "{}", again.config.prompt);
    // A reply resets `nudged`; this flag must not reset, or it would ask forever.
    finish(&state, &again, "I already reported.", true);
    let team = saved(&state, &sid);
    assert_eq!(team.workers[0].status, "failed");
    assert!(team.workers[0].error.as_deref().unwrap().contains("Council score"));
    assert_eq!(team.workers[0].council.as_ref().unwrap().score, None);
    // The lead wakes for it; the reviewer does not run again.
    let next = next_action_state(&state, &mut |_| {}).unwrap().unwrap();
    assert_eq!(next.sid, sid);
}

#[test]
fn a_nudged_reviewer_scores_and_keeps_its_report() {
    let (state, sid) = council_state(on(9.0, 0, 0));
    call(&state, &sid, "pandacode_dispatch_workers", json!({"assignments":[reviewer_assignment("r", "correctness")]})).unwrap();
    let (run, _rx) = claim(&state, next_action_state(&state, &mut |_| {}).unwrap().unwrap());
    finish(&state, &run, "The parser drops the last token.", true);
    let (again, _rx) = claim(&state, next_action_state(&state, &mut |_| {}).unwrap().unwrap());
    assert!(again.config.prompt.contains("in full"), "{}", again.config.prompt);
    finish(&state, &again, "The parser drops the last token.\n\nCouncil score: 6/10", true);
    let team = saved(&state, &sid);
    assert_eq!(team.workers[0].status, "completed");
    assert_eq!(team.workers[0].council.as_ref().unwrap().score, Some(6.0));
    assert!(team.workers[0].summary.contains("drops the last token"), "{}", team.workers[0].summary);
}

#[test]
fn failed_and_parked_reviewers_keep_their_paths() {
    let (state, sid) = council_state(on(9.0, 0, 0));
    call(&state, &sid, "pandacode_dispatch_workers", json!({"assignments":[reviewer_assignment("r", "correctness")]})).unwrap();
    let (run, _rx) = claim(&state, next_action_state(&state, &mut |_| {}).unwrap().unwrap());
    finish(&state, &run, "Council score: 9/10", false);
    let team = saved(&state, &sid);
    assert_eq!(team.workers[0].status, "failed");
    assert_eq!(team.workers[0].council.as_ref().unwrap().score, None, "a failed run has no score");
    assert!(!team.workers[0].score_nudged);
    // A sub-worker still out parks the reviewer without asking for its score.
    let (state, sid) = council_state(on(9.0, 0, 0));
    call(&state, &sid, "pandacode_dispatch_workers", json!({"assignments":[reviewer_assignment("r", "correctness")]})).unwrap();
    let (run, _rx) = claim(&state, next_action_state(&state, &mut |_| {}).unwrap().unwrap());
    let mut team = saved(&state, &sid);
    let mut child = worker("child", "running", &[], &[]);
    child.parent_worker = Some(team.workers[0].id.clone());
    team.workers.push(child);
    store_team(&state, &mut team);
    finish(&state, &run, "Waiting on my sub-worker.", true);
    let team = saved(&state, &sid);
    assert_eq!(team.workers[0].status, "parked");
    assert!(!team.workers[0].score_nudged);
}

#[test]
fn followup_is_refused_for_a_reviewer() {
    let (state, sid) = council_state(on(9.0, 0, 0));
    let mut team = saved(&state, &sid);
    team.workers = vec![seat("a", 1, Some(5.0), storage::now())];
    store_team(&state, &mut team);
    let refused = call(&state, &sid, "pandacode_followup_worker", json!({"workerId":"a","key":"more","prompt":"Look again."})).unwrap_err();
    assert_eq!(refused, "Dispatch a fresh reviewer for the next round");
}

#[test]
fn sub_workers_cannot_convene() {
    assert!(catalog().iter().any(|t| t["name"] == "pandacode_dispatch_workers" && t["inputSchema"]["properties"]["assignments"]["items"]["properties"]["councilLens"]["description"].as_str().is_some_and(|d| d.contains("lens"))));
    assert!(sub_worker_catalog().iter().all(|t| t["inputSchema"]["properties"]["assignments"]["items"]["properties"].get("councilLens").is_none()));
    let (state, sid) = council_state(on(9.0, 0, 0));
    let (_run, actor) = running_worker(&state, &sid, "w", "src");
    let coordination::Actor::Worker { id, attempt } = actor else { panic!("a worker") };
    let team = saved(&state, &sid);
    let refused = dispatch_as(&state, &sid, team.generation, Some((&id, attempt)), "pandacode_dispatch_workers", json!({"assignments":[reviewer_assignment("r", "ux")]}), &AtomicBool::new(false), &routing::AutoRoutes::default()).unwrap_err();
    assert!(refused.contains("lead"), "{refused}");
}

#[test]
fn set_council_validates_and_applies_at_once() {
    let (state, sid) = state_fixture();
    assert!(council::set(&state, &sid, Some(on(0.0, 0, 0))).is_err());
    assert!(council::set(&state, "no-such-task", Some(on(9.0, 0, 0))).unwrap_err().contains("team"));
    let revision = saved(&state, &sid).dispatch_revision;
    let team = council::set(&state, &sid, Some(on(9.0, 4, 2))).unwrap();
    assert_eq!(team.config.council, Some(on(9.0, 4, 2)));
    assert_eq!(saved(&state, &sid).config.council, Some(on(9.0, 4, 2)));
    assert_eq!(team.dispatch_revision, revision, "no review turn for a setting");
    assert_eq!(council::set(&state, &sid, None).unwrap().config.council, None);
}

#[test]
fn set_council_reaches_a_queued_setup() {
    let (state, sid) = council_state(on(9.0, 0, 0));
    let mut team = saved(&state, &sid);
    let mut queued = team.config.clone();
    queued.council = Some(on(5.0, 0, 0));
    team.pending_setup = Some(profiles::TeamSetup { architect: profiles::ModelSelection::from_session(&state.store.lock().unwrap().session(&sid).unwrap()), config: queued });
    store_team(&state, &mut team);
    let team = council::set(&state, &sid, None).unwrap();
    assert_eq!(team.pending_setup.unwrap().config.council, None, "turning it off is not undone when the setup applies");
}

#[test]
fn a_new_setup_without_council_keeps_it() {
    let (state, sid) = council_state(on(9.0, 3, 0));
    let mut other = config();
    other.max_parallel = 1;
    let team = configure_state(&state, &sid, Some(other), None, None).unwrap().unwrap();
    assert_eq!(team.config.max_parallel, 1);
    assert_eq!(team.config.council, Some(on(9.0, 3, 0)));
    // One that names its own takes effect.
    let mut own = config();
    own.council = Some(on(7.0, 0, 0));
    let team = configure_state(&state, &sid, Some(own), None, None).unwrap().unwrap();
    assert_eq!(team.config.council, Some(on(7.0, 0, 0)));
}

#[test]
fn prompts_carry_config_only_and_reviewers_never_see_the_target() {
    let (state, sid) = council_state(on(9.5, 3, 2));
    let (_run, _) = running_worker(&state, &sid, "w", "src");
    call(&state, &sid, "pandacode_dispatch_workers", json!({"assignments":[reviewer_assignment("r", "security")]})).unwrap();
    let store = state.store.lock().unwrap();
    let mut team = load(&store, &sid).unwrap().unwrap();
    let (lead, _) = rules(&store, &team, &sid).unwrap();
    assert!(lead.contains("councilLens") && lead.contains("9.5") && lead.contains("exactly 2") && lead.contains("3 rounds"), "{lead}");
    assert!(council::lead_rules(&team, false).contains("a different roster model for each reviewer"));
    assert!(!council::lead_rules(&team, true).contains("different roster model"));
    assert!(lead.contains("visual quality, pacing"));
    // Live status would resend the rules on every change.
    let before = lead.clone();
    team.workers[1].council.as_mut().unwrap().score = Some(4.0);
    assert_eq!(rules(&store, &team, &sid).unwrap().0, before);
    let (reviewer, _) = rules(&store, &team, &team.workers[1].session_id.clone()).unwrap();
    assert!(reviewer.contains("`Council score: N/10`") && reviewer.contains("security") && reviewer.contains("Score strictly") && !reviewer.contains("9+"), "{reviewer}");
    assert!(!reviewer.contains("9.5"), "{reviewer}");
    assert!(reviewer.contains("frames, renders") && reviewer.contains("the work your assignment names"), "{reviewer}");
    assert!(reviewer.contains("Do not change the work under review") && reviewer.contains("temporary directory"), "{reviewer}");
    assert!(!reviewer.contains("the whole checkout") && !reviewer.contains("writing follow-up"), "{reviewer}");
    let (plain, _) = rules(&store, &team, &team.workers[0].session_id.clone()).unwrap();
    assert!(!plain.contains("Council"), "{plain}");
    team.config.council = None;
    assert!(!rules(&store, &team, &sid).unwrap().0.contains("councilLens"));
}

#[test]
fn the_review_payload_reports_the_round() {
    let team = team_with(on(9.0, 3, 0), vec![writer("w", SINCE), seat("a", 2, Some(8.0), SINCE + 1), seat("b", 2, Some(9.0), SINCE + 1)]);
    let review = review_summaries(&team, true);
    let council = &review["council"];
    assert_eq!(council["round"], 2);
    assert_eq!(council["target"], 9.0);
    assert_eq!(council["lowest"], 8.0);
    assert_eq!(council["complete"], true);
    assert_eq!(council["passed"], false);
    assert_eq!(council["roundsLeft"], 2, "only round 2 completed");
    assert!(council["next"].as_str().unwrap().contains("Fix the blockers"));
    let passing = team_with(on(8.0, 0, 0), team.workers.clone());
    let council = &review_summaries(&passing, true)["council"];
    assert_eq!(council["passed"], true);
    assert_eq!(council["roundsLeft"], 99, "one completed round of 100");
    let (_, plain) = fixture();
    assert!(review_summaries(&plain, true).get("council").is_none());
    // Reviewers' seats are in list_workers too, for the lead's final table.
    assert_eq!(summaries(&team, 0, None)["workers"][1]["council"]["score"], 8.0);
}

#[test]
fn one_roster_model_keeps_auto_in_the_rules() {
    let mut team = team_with(on(9.0, 0, 0), vec![]);
    team.config.workers.truncate(1);
    assert!(!council::lead_rules(&team, false).contains("different roster model"));
}

#[test]
fn a_new_message_continues_an_unfinished_cycle() {
    let (state, sid) = council_state(on(9.0, 0, 0));
    let mut team = saved(&state, &sid);
    team.status = "paused".into();
    team.council_since = SINCE;
    team.workers = vec![writer("w", SINCE + 1), seat("a", 1, Some(5.0), SINCE + 2), seat("b", 1, Some(9.0), SINCE + 2)];
    store_team(&state, &mut team);
    start_state(&state, &sid, "Keep going", None, None).unwrap();
    let team = saved(&state, &sid);
    assert_eq!(team.council_since, SINCE, "the cycle and its rounds continue");
    assert_eq!(team.council_status.as_ref().unwrap().round, 1);
    // A passed cycle ends: the next message starts a new one.
    let mut team = team;
    team.status = "ready".into();
    team.workers[1].council.as_mut().unwrap().score = Some(9.5);
    store_team(&state, &mut team);
    start_state(&state, &sid, "Something new", None, None).unwrap();
    assert!(saved(&state, &sid).council_since > SINCE);
}

/// A turn of `session` that recorded changes to `paths`, at `at`.
fn turn_change(state: &AppState, session: &str, id: &str, at: i64, paths: &[&str], sources: &[&str]) {
    let store = state.store.lock().unwrap();
    let message: i64 = store.db.query_row("INSERT INTO messages(session_id,role,content,created_at) VALUES(?1,'changes','',?2) RETURNING id", params![session, at], |r| r.get(0)).unwrap();
    let files: Vec<Value> = paths.iter().map(|p| json!({"path":p,"status":"modified","additions":1,"deletions":0,"binary":false,"truncated":false})).collect();
    let mut summary = json!({"id":id,"files":files,"additions":1,"deletions":0,"truncated":false,"concurrent":false,"attributed":true});
    if !sources.is_empty() {
        summary["teamSources"] = json!(sources);
    }
    store.db.execute("INSERT INTO turn_changes(id,session_id,message_id,summary,created_at,diff_bytes) VALUES(?1,?2,?3,?4,?5,0)", params![id, session, message, summary.to_string(), at]).unwrap();
}

#[test]
fn recorded_turn_changes_count_as_changes_but_not_a_reviewers_own() {
    let (state, sid) = council_state(on(9.0, 0, 0));
    // A reviewer that renders into the checkout does not outdate its own round.
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
    assert_eq!(saved(&state, &sid).council_status.unwrap().state, "passed", "no writer at all");
    turn_change(&state, &reviewer, "c1", storage::now(), &["frames/001.png"], &[]);
    store_team(&state, &mut saved(&state, &sid));
    assert_eq!(saved(&state, &sid).council_status.unwrap().state, "passed");
    // A worker's change does.
    call(&state, &sid, "pandacode_dispatch_workers", json!({"assignments":[assignment("w", "fast", "src")]})).unwrap();
    let writer = saved(&state, &sid).workers[2].session_id.clone();
    turn_change(&state, &writer, "c2", storage::now(), &["src/a.rs"], &[]);
    store_team(&state, &mut saved(&state, &sid));
    let status = saved(&state, &sid).council_status.unwrap();
    assert!(status.stale && status.state == "fixing", "{status:?}");
}

/// Saves a turn's changes to `paths` the way a finished run does.
fn persist_turn(state: &AppState, session: &str, paths: &[&str]) {
    let file = |path: &&str| crate::turn_changes::ChangedFile { path: path.to_string(), old_path: None, status: "modified".into(), additions: Some(1), deletions: Some(0), binary: false, truncated: false };
    let detail = |path: &&str| crate::turn_changes::TurnChangeDiff { path: path.to_string(), old_path: None, patch: "+x\n".into(), binary: false, truncated: false, error: None };
    let summary = crate::turn_changes::TurnChanges { id: uuid::Uuid::new_v4().to_string(), files: paths.iter().map(file).collect(), additions: paths.len(), deletions: 0, truncated: false, concurrent: false, attributed: true, error: None };
    crate::turn_changes::persist(&state.store.lock().unwrap(), session, crate::turn_changes::Captured { summary, details: paths.iter().map(detail).collect() }).unwrap();
}

/// A worker changed `src/a.rs`, then a passing round started; the lead's turn is still to be saved.
fn reviewed_worker_change() -> (AppState, String) {
    let (state, sid) = council_state(on(9.0, 0, 0));
    call(&state, &sid, "pandacode_dispatch_workers", json!({"assignments":[assignment("w", "fast", "src")]})).unwrap();
    let writer_session = saved(&state, &sid).workers[0].session_id.clone();
    let mut team = saved(&state, &sid);
    team.workers[0].status = "completed".into();
    store_team(&state, &mut team);
    persist_turn(&state, &writer_session, &["src/a.rs"]);
    std::thread::sleep(std::time::Duration::from_millis(3));
    let mut team = saved(&state, &sid);
    team.workers.push(seat("a", 1, Some(9.0), storage::now()));
    team.workers.push(seat("b", 1, Some(9.0), storage::now()));
    store_team(&state, &mut team);
    assert_eq!(finish_refusal(&saved(&state, &sid)), None);
    std::thread::sleep(std::time::Duration::from_millis(3));
    (state, sid)
}

#[test]
fn a_lead_turn_that_only_rolls_up_worker_changes_is_no_new_change() {
    let (state, sid) = reviewed_worker_change();
    persist_turn(&state, &sid, &[]);
    store_team(&state, &mut saved(&state, &sid));
    assert_eq!(finish_refusal(&saved(&state, &sid)), None);
}

#[test]
fn the_leads_own_edits_count_even_on_a_file_a_worker_changed() {
    let (state, sid) = reviewed_worker_change();
    // The lead's turn edits the worker's file and rolls the worker's change up with it.
    persist_turn(&state, &sid, &["src/a.rs"]);
    store_team(&state, &mut saved(&state, &sid));
    assert!(finish_refusal(&saved(&state, &sid)).unwrap().contains("out of date"));
}
