//! Team briefs across turns: full rules on a fresh or compacted context, deltas, delivery after
//! a clean end, refreshes and note previews (moved from `tests.rs`).
use super::tests::{assignment, call, claim, clean_turn, finish, fixture, objective_turn, resumed_lead, state_fixture, FULL_COORDINATION, FULL_RULES, REFRESH_IDENTITY};
use super::*;

/// The tool row Claude and Codex write when they compact, saved the way a run saves it.
fn compaction_row(store: &Store, sid: &str) {
    crate::save_compaction(store, sid, "compaction:1");
}

#[test]
fn a_fresh_or_compacted_context_gets_the_full_brief() {
    let (state, sid, admission) = resumed_lead();
    let store = state.store.lock().unwrap();
    let first = clean_turn(&store, &sid, "Build the parser", &admission);
    assert!(first.contains(FULL_RULES) && first.contains(FULL_COORDINATION));
    let second = clean_turn(&store, &sid, "Next", &admission);
    assert!(!second.contains(FULL_RULES) && !second.contains(FULL_COORDINATION));
    // A compaction the harness reported since the last brief starts from nothing again.
    store.message(&sid, "user", "Next").unwrap();
    compaction_row(&store, &sid);
    let compacted = clean_turn(&store, &sid, "Go on", &admission);
    assert!(compacted.contains(FULL_RULES) && compacted.contains(FULL_COORDINATION));
    assert!(compacted.ends_with("Go on"));
    // One path: the rules replace the reminder, and the periodic count starts over.
    assert!(!compacted.contains("architect mode continues"), "{compacted}");
    assert_eq!(compacted.matches(FULL_RULES).count(), 1);
    assert_eq!(load(&store, &sid).unwrap().unwrap().briefings[&sid].since_full, 0);
    let after = clean_turn(&store, &sid, "And on", &admission);
    assert!(!after.contains(FULL_RULES) && !after.contains(FULL_COORDINATION), "a compaction counts once");
    // A conversation the harness starts afresh.
    store.db.execute("UPDATE sessions SET resume_id=NULL WHERE id=?1", [&sid]).unwrap();
    let fresh = clean_turn(&store, &sid, "Again", &admission);
    assert!(fresh.contains(FULL_RULES) && fresh.contains(FULL_COORDINATION));
}

#[test]
fn compaction_is_read_from_the_tool_name_not_from_output_text() {
    let (state, sid, admission) = resumed_lead();
    let store = state.store.lock().unwrap();
    clean_turn(&store, &sid, "Build the parser", &admission);
    // An agent grepping PandaCode's source prints both strings inside another tool's row.
    let output = format!("providers.rs: \"{}\" => \"{}\"", crate::providers::COMPACT_CONTEXT_TOOL, crate::providers::COMPACTED_OUTPUT);
    crate::save_tool_row(&store, &sid, "grep:1", "Bash", &output);
    store.message(&sid, "assistant", &format!("Found \"{}\" and {}", crate::providers::COMPACT_CONTEXT_TOOL, crate::providers::COMPACTED_OUTPUT)).unwrap();
    assert!(!coordination::compacted(&store, &sid, &sid).unwrap());
    let next = clean_turn(&store, &sid, "Next", &admission);
    assert!(!next.contains(FULL_RULES), "{next}");
    compaction_row(&store, &sid);
    assert!(coordination::compacted(&store, &sid, &sid).unwrap());
}

#[test]
fn a_roster_change_is_a_delta_line_not_the_full_rules() {
    let (state, sid, admission) = resumed_lead();
    let store = state.store.lock().unwrap();
    let first = clean_turn(&store, &sid, "Build the parser", &admission);
    let mut team = load(&store, &sid).unwrap().unwrap();
    team.config.workers.push(WorkerProfile { id: "extra".into(), name: "Extra worker".into(), provider: "codex".into(), model: "gpt-extra".into(), reasoning_effort: None });
    save(&store, &mut team).unwrap();
    let delta = prompt(&store, &sid, "Next", Some(&admission)).unwrap();
    assert!(!delta.contains(FULL_RULES) && !delta.contains(FULL_COORDINATION));
    assert!(delta.contains("Team roster update") && delta.contains("gpt-extra"));
    assert!(delta.len() < first.len() / 2, "{} vs {}", delta.len(), first.len());
    let again = prompt(&store, &sid, "Retry", Some(&admission)).unwrap();
    assert!(again.contains("Team roster update"), "the delta repeats until a clean end");
    coordination::brief_accepted(&store, &admission.parent, &sid).unwrap();
    let after = prompt(&store, &sid, "And on", Some(&admission)).unwrap();
    assert!(!after.contains("Team roster update"), "the delta goes out once after a clean end");
}

#[test]
fn rules_and_messages_count_as_delivered_only_after_a_clean_end() {
    let (state, sid, admission) = resumed_lead();
    let store = state.store.lock().unwrap();
    // A first brief whose launch fails: the retry gets the full rules, not the reminder.
    prompt(&store, &sid, "Build the parser", Some(&admission)).unwrap();
    coordination::brief_refused(&admission.parent, &sid);
    let retried = clean_turn(&store, &sid, "Build the parser", &admission);
    assert!(retried.contains(FULL_RULES), "{retried}");
    // A mailbox message in a stopped turn goes out again on the retry, then never after a clean end.
    store.db.execute("INSERT INTO architect_messages(parent_session_id,sender,recipient,request_key,content,created_at) VALUES(?1,'w1','architect','k','Renderer API is ready',1)", [&sid]).unwrap();
    assert!(prompt(&store, &sid, "Review", Some(&admission)).unwrap().contains("Renderer API is ready"));
    coordination::brief_refused(&admission.parent, &sid);
    let retry = clean_turn(&store, &sid, "Review", &admission);
    assert!(retry.contains("Renderer API is ready"), "the retry repeats it: {retry}");
    let after = clean_turn(&store, &sid, "Next", &admission);
    assert!(!after.contains("Renderer API is ready") && !after.contains(FULL_RULES), "{after}");
}

#[test]
fn a_periodic_refresh_resends_rules_but_not_messages_or_notes() {
    let (state, sid, admission) = resumed_lead();
    let store = state.store.lock().unwrap();
    coordination::notes::ensure(&store).unwrap();
    coordination::notes::tool(&store, &sid, "w1", json!({"action":"set","key":"api","value":"Parser API is parse(text)"})).unwrap();
    store.db.execute("INSERT INTO architect_messages(parent_session_id,sender,recipient,request_key,content,created_at) VALUES(?1,'w1','architect','k','Renderer API is ready',1)", [&sid]).unwrap();
    let first = clean_turn(&store, &sid, "Build the parser", &admission);
    assert!(first.contains("Renderer API is ready") && first.contains("Parser API is parse(text)"));
    let mut refresh = String::new();
    for turn in 0..16 {
        let text = clean_turn(&store, &sid, &format!("Turn {turn}"), &admission);
        if text.contains(FULL_RULES) {
            refresh = text;
            break;
        }
        assert!(!text.contains("Renderer API is ready") && !text.contains("Parser API"));
    }
    assert!(refresh.contains(FULL_RULES), "the rules come back periodically");
    assert!(!refresh.contains(FULL_COORDINATION));
    // A harness that compacted without saying so gets its identity back on the refresh.
    let identity = &refresh[refresh.find(REFRESH_IDENTITY).expect("identity block")..];
    assert!(identity.contains("your ID is architect") && identity.contains("never poll"));
    assert!(identity.contains("Saved checkpoint: null") && identity.contains("api"));
    let identity = identity.split("\n\n").next().unwrap();
    println!("periodic refresh identity block: {} B", identity.len());
    assert!(identity.len() < 700, "{identity}");
    assert!(!refresh.contains("Renderer API is ready"), "the message went out once");
    assert!(!refresh.contains("Parser API is parse(text)"), "the note went out once");
    // New messages and notes still arrive on a refresh turn, once.
    store.db.execute("INSERT INTO architect_messages(parent_session_id,sender,recipient,request_key,content,created_at) VALUES(?1,'w1','architect','k2','Tests are green',2)", [&sid]).unwrap();
    let next = clean_turn(&store, &sid, "Review", &admission);
    assert!(next.contains("Tests are green"));
    assert!(!clean_turn(&store, &sid, "Review again", &admission).contains("Tests are green"));
}

#[test]
fn a_launch_brief_lists_full_notes_while_they_fit_then_previews() {
    let (store, team) = fixture();
    coordination::notes::ensure(&store).unwrap();
    let long = format!("Use port 4123. {}", "Detail ".repeat(100));
    coordination::notes::tool(&store, &team.session_id, "w1", json!({"action":"set","key":"ports","value":long})).unwrap();
    for i in 0..20 {
        coordination::notes::tool(&store, &team.session_id, "w1", json!({"action":"set","key":format!("fact-{i}"),"value":"x".repeat(300)})).unwrap();
    }
    let brief = coordination::context(&store, &team, &coordination::Actor::Architect, 0, true).unwrap().0;
    let notes = &brief[brief.find("Team notes").unwrap()..];
    // Up to 3 KiB of full values, newest first, as single-turn workers need them now.
    let full: Vec<&str> = notes.lines().filter(|l| l.ends_with(&"x".repeat(300))).collect();
    let full_bytes: usize = full.iter().map(|l| l.len() + 1).sum();
    assert!(full_bytes <= 3072 && full_bytes + 318 > 3072, "{full_bytes}: {notes}");
    for i in (20 - full.len()..20).rev() {
        assert!(notes.contains(&format!("- fact-{i} (w1): {}\n", "x".repeat(300))), "fact-{i}: {notes}");
    }
    // Then previews for what does not fit, within their own small budget.
    let previews: Vec<&str> = notes.lines().filter(|l| l.ends_with('…')).collect();
    let preview_bytes: usize = previews.iter().map(|l| l.len() + 1).sum();
    assert!(!previews.is_empty() && preview_bytes <= 1024, "{preview_bytes}: {notes}");
    let rest = 21 - full.len() - previews.len();
    assert!(notes.contains("21 in all") && notes.contains(&format!("{} cut to previews, full text through pandacode_team_notes get", previews.len())), "{notes}");
    assert!(rest > 0 && notes.contains(&format!("{rest} more notes: use pandacode_team_notes list.")), "{notes}");
    assert!(!brief.contains(&long));
    // A short team gets every value in full, with nothing to fetch.
    let (store, team) = fixture();
    coordination::notes::ensure(&store).unwrap();
    coordination::notes::tool(&store, &team.session_id, "w1", json!({"action":"set","key":"ports","value":long})).unwrap();
    let brief = coordination::context(&store, &team, &coordination::Actor::Architect, 0, true).unwrap().0;
    assert!(brief.contains(&format!("- ports (w1): {long}")) && !brief.contains("cut to previews") && !brief.contains("more notes"), "{brief}");
}

#[test]
fn notes_shown_only_as_previews_arrive_in_full_next_turn_unless_fetched() {
    let (store, team) = fixture();
    let parent = team.session_id.clone();
    coordination::notes::ensure(&store).unwrap();
    let old = format!("Old fact. {}", "a".repeat(1000));
    let fetched = format!("Fetched fact. {}", "c".repeat(1000));
    let mid = format!("Mid fact. {}", "d".repeat(1000));
    let new = format!("New fact. {}", "b".repeat(1000));
    for (key, value) in [("old", &old), ("fetched", &fetched), ("mid", &mid), ("new", &new)] {
        coordination::notes::tool(&store, &parent, "w1", json!({"action":"set","key":key,"value":value})).unwrap();
    }
    let architect = coordination::Actor::Architect;
    let brief = coordination::context(&store, &team, &architect, 0, true).unwrap().0;
    assert!(brief.contains(&new) && brief.contains(&mid) && !brief.contains(&old) && !brief.contains(&fetched), "{brief}");
    assert!(brief.contains("2 cut to previews") && !brief.contains("more notes"), "{brief}");
    // Fetching one with `get` delivers it; the other comes in full on the next turn, once.
    let got = coordination::notes::tool(&store, &parent, "architect", json!({"action":"get","key":"fetched"})).unwrap();
    assert_eq!(got["note"]["value"], fetched);
    let delta = coordination::context(&store, &team, &architect, 0, false).unwrap().0;
    assert!(delta.contains(&format!("- old (w1): {old}")), "{delta}");
    assert!(!delta.contains(&new) && !delta.contains(&mid) && !delta.contains(&fetched), "{delta}");
    let after = coordination::context(&store, &team, &architect, 0, false).unwrap().0;
    assert!(!after.contains("Old fact."), "{after}");
}

#[test]
fn note_tables_come_back_whenever_missing() {
    let (store, _) = fixture();
    coordination::notes::ensure(&store).unwrap();
    coordination::notes::ensure(&store).unwrap();
    // No cache to go stale: a dropped table is created again on the next prompt.
    store.db.execute_batch("DROP TABLE architect_note_previews").unwrap();
    coordination::notes::ensure(&store).unwrap();
    store.db.execute_batch("SELECT 1 FROM architect_note_previews").unwrap();
}

#[test]
fn previews_past_the_budget_stay_pending_until_delivered_in_full() {
    let (store, team) = fixture();
    let parent = team.session_id.clone();
    coordination::notes::ensure(&store).unwrap();
    let architect = coordination::Actor::Architect;
    // Six 1 KiB notes: two fit the launch brief in full, the rest go out as previews.
    let value = |i: usize| format!("Fact {i}. {}", "p".repeat(1000));
    for i in 0..6 {
        coordination::notes::tool(&store, &parent, "w1", json!({"action":"set","key":format!("old-{i}"),"value":value(i)})).unwrap();
    }
    let brief = coordination::context(&store, &team, &architect, 0, true).unwrap().0;
    let previewed: Vec<usize> = (0..6).filter(|i| !brief.contains(&value(*i))).collect();
    assert!(previewed.len() >= 3, "{brief}");
    // New notes changed since then take the next brief's budget first.
    for i in 0..2 {
        coordination::notes::tool(&store, &parent, "w1", json!({"action":"set","key":format!("new-{i}"),"value":format!("New {i}. {}", "n".repeat(1000))})).unwrap();
    }
    let mut delivered = std::collections::HashSet::new();
    for _ in 0..previewed.len() {
        let delta = coordination::context(&store, &team, &architect, 0, false).unwrap().0;
        delivered.extend(previewed.iter().copied().filter(|i| delta.contains(&value(*i))));
        if delivered.len() == previewed.len() {
            break;
        }
    }
    assert_eq!(delivered.len(), previewed.len(), "every preview arrives in full on a later turn");
    let after = coordination::context(&store, &team, &architect, 0, false).unwrap().0;
    assert!(after.is_empty() || !after.contains("Fact "), "{after}");
}

#[test]
fn notes_cut_by_a_brief_budget_say_how_many_and_where_to_fetch_them() {
    let (store, team) = fixture();
    coordination::notes::ensure(&store).unwrap();
    for i in 0..20 {
        coordination::notes::tool(&store, &team.session_id, "w1", json!({"action":"set","key":format!("fact-{i}"),"value":"x".repeat(300)})).unwrap();
    }
    let brief = coordination::context(&store, &team, &coordination::Actor::Architect, 0, true).unwrap().0;
    let shown = brief.matches("- fact-").count();
    assert!(shown < 20);
    assert!(brief.contains(&format!("{} more notes: use pandacode_team_notes list.", 20 - shown)), "{brief}");
    // Changed notes past the incremental budget are marked seen too, so the header counts them.
    for i in 0..20 {
        coordination::notes::tool(&store, &team.session_id, "w1", json!({"action":"set","key":format!("fact-{i}"),"value":"y".repeat(300)})).unwrap();
    }
    let delta = coordination::context(&store, &team, &coordination::Actor::Architect, 0, false).unwrap().0;
    let shown = delta.matches("- fact-").count();
    assert!(shown < 20);
    assert!(delta.contains(&format!("{} more changed notes: use pandacode_team_notes list.", 20 - shown)), "{delta}");
}

#[test]
fn a_compacted_lead_gets_the_whole_objective_on_an_internal_turn() {
    let (state, sid) = state_fixture();
    state.store.lock().unwrap().db.execute("UPDATE sessions SET resume_id='native-1' WHERE id=?1", [&sid]).unwrap();
    let parent = objective_turn(&state, &sid);
    let objective = format!("{} END", "Build the parser and its tests. ".repeat(64));
    {
        let store = state.store.lock().unwrap();
        let mut team = load(&store, &sid).unwrap().unwrap();
        team.objective = objective.clone();
        save(&store, &mut team).unwrap();
    }
    call(&state, &sid, "pandacode_dispatch_workers", json!({"assignments":[assignment("a","fast","src/a")]})).unwrap();
    let (run, _r) = claim(&state, next_action_state(&state, &mut |_| {}).unwrap().unwrap());
    finish(&state, &parent, "Waiting.", true);
    finish(&state, &run, "Done.", true);
    compaction_row(&state.store.lock().unwrap(), &sid);
    let (review, _r) = claim(&state, next_action_state(&state, &mut |_| {}).unwrap().unwrap());
    assert!(review.config.prompt.contains(&objective), "{}", review.config.prompt);
    assert!(!review.config.prompt.contains("objective unchanged"));
    assert!(!review.config.prompt.contains("architect mode continues"));
}
