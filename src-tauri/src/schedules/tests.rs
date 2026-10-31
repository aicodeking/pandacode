use super::*;
use crate::bots::schedule::{next_run, next_run_on};
use serde_json::{json, Value};

const NOW: i64 = 1_767_225_600_000; // 2026-01-01 00:00 UTC, a Thursday.

fn store() -> Store {
    let store = Store::open(std::path::Path::new(":memory:")).unwrap();
    store.db.execute_batch("INSERT INTO projects(id,name,path) VALUES('p1','One','/tmp/one'),('p2','Two','/tmp/two');").unwrap();
    for (id, project, draft) in [("a", "p1", 0), ("b", "p1", 0), ("c", "p2", 0), ("d", "p1", 1)] {
        store
            .db
            .execute("INSERT INTO sessions(id,project_id,title,provider,model,mode,status,created_at,updated_at,draft) VALUES(?1,?2,?1,'claude','default','ask','idle',0,0,?3)", params![id, project, draft])
            .unwrap();
    }
    store
}

fn input(kind: &str) -> ScheduleInput {
    ScheduleInput { session_id: "a".into(), prompt: "Check the deploy".into(), kind: kind.into(), ..Default::default() }
}

fn once(store: &Store) -> TaskSchedule {
    create(store, &ScheduleInput { run_at: Some(NOW + MINUTE), ..input("once") }, "user", None, NOW).unwrap()
}

#[test]
fn schema_version_is_28_with_schedule_tables() {
    let store = store();
    assert_eq!(crate::storage::SCHEMA_VERSION, 36);
    assert_eq!(store.db.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0)).unwrap(), 36);
    assert!(list(&store, None).unwrap().is_empty());
    assert_eq!(settings(&store).unwrap(), SchedulerSettings::default());
}

#[test]
fn weekly_next_run_picks_listed_days_and_daily_is_unchanged() {
    // Thursday 00:00 UTC: Monday and Friday at 09:00 → Friday the 2nd.
    let friday = next_run_on("weekly", None, Some("09:00"), &[1, 5], NOW, 0).unwrap();
    assert_eq!(friday, NOW + DAY + 9 * 60 * MINUTE);
    // After Friday's slot the next is Monday the 5th.
    assert_eq!(next_run_on("weekly", None, Some("09:00"), &[1, 5], friday, 0).unwrap(), NOW + 4 * DAY + 9 * 60 * MINUTE);
    assert_eq!(next_run_on("weekly", None, Some("09:00"), &[], NOW, 0), None);
    assert_eq!(next_run("daily", None, Some("09:00"), NOW, 0), Some(NOW + 9 * 60 * MINUTE));
    assert_eq!(next_run("weekly", None, Some("09:00"), NOW, 0), None, "bots never get weekly runs");
}

#[test]
fn validation_explains_what_is_wrong() {
    let store = store();
    let error = |input: ScheduleInput| create(&store, &input, "user", None, NOW).unwrap_err();
    assert!(error(ScheduleInput { prompt: " ".into(), ..input("interval") }).contains("message"));
    assert!(error(ScheduleInput { prompt: "x".repeat(8001), ..input("interval") }).contains("8000"));
    assert!(error(ScheduleInput { title: "t".repeat(121), interval_minutes: Some(30), ..input("interval") }).contains("120"));
    assert!(error(ScheduleInput { interval_minutes: Some(4), ..input("interval") }).contains("5 minutes"));
    assert!(error(ScheduleInput { interval_minutes: Some(10081), ..input("interval") }).contains("5 minutes"));
    assert!(error(ScheduleInput { time_of_day: Some("9am".into()), ..input("daily") }).contains("HH") || error(ScheduleInput { time_of_day: Some("9am".into()), ..input("daily") }).contains("09:30"));
    assert!(error(ScheduleInput { time_of_day: Some("24:00".into()), ..input("daily") }).contains("09:30"));
    assert!(error(ScheduleInput { time_of_day: Some("09:00".into()), ..input("weekly") }).contains("at least one day"));
    assert!(error(ScheduleInput { time_of_day: Some("09:00".into()), days: vec![7], ..input("weekly") }).contains("0 (Sunday)"));
    assert!(error(ScheduleInput { run_at: Some(NOW - 2 * MINUTE), ..input("once") }).contains("passed"));
    assert!(error(ScheduleInput { run_at: Some(NOW + 367 * DAY), ..input("once") }).contains("within a year"));
    assert!(error(ScheduleInput { run_at: Some(NOW + MINUTE), max_runs: Some(0), ..input("once") }).contains("1 to 1000"));
    assert!(error(ScheduleInput { watch_session_id: Some("a".into()), ..input("after") }).contains("itself"));
    assert!(error(ScheduleInput { watch_session_id: Some("c".into()), ..input("after") }).contains("same project"));
    assert!(error(ScheduleInput { session_id: "d".into(), run_at: Some(NOW + MINUTE), ..input("once") }).contains("first message"));
    assert!(error(ScheduleInput { session_id: "zz".into(), ..input("once") }).contains("no longer exists"));
    assert!(error(input("hourly")).contains("Choose once"));

    let weekly = create(&store, &ScheduleInput { time_of_day: Some("9:05".into()), days: vec![5, 1, 5], ..input("weekly") }, "user", None, NOW).unwrap();
    assert_eq!((weekly.title.as_str(), weekly.time_of_day.as_deref(), weekly.days.clone()), ("Check the deploy", Some("09:05"), vec![1, 5]));
    assert_eq!(cadence(&weekly), "Mon, Fri at 09:05");
    let after = create(&store, &ScheduleInput { watch_session_id: Some("b".into()), only_on_success: true, ..input("after") }, "user", None, NOW).unwrap();
    assert_eq!((after.next_run_at, after.watch_session_title.as_deref(), after.project_name.as_str()), (None, Some("b"), "One"));
    assert_eq!(cadence(&after), "After “b” succeeds");
    // Sorted by next run, never-due last.
    assert_eq!(list(&store, Some("a")).unwrap().iter().map(|s| s.kind.as_str()).collect::<Vec<_>>(), ["weekly", "after"]);
}

#[test]
fn due_selection_waits_while_paused() {
    let store = store();
    let schedule = once(&store);
    assert!(due(&store, NOW).unwrap().is_empty());
    assert_eq!(due(&store, NOW + MINUTE).unwrap(), vec![schedule.clone()]);
    set_settings(&store, &SchedulerSettings { paused: true, ..Default::default() }).unwrap();
    assert!(due(&store, NOW + DAY).unwrap().is_empty());
    set_settings(&store, &SchedulerSettings::default()).unwrap();
    // Still due after the pause, and once only however late.
    assert_eq!(due(&store, NOW + DAY).unwrap().len(), 1);
    set_enabled(&store, &schedule.id, false, NOW).unwrap();
    assert!(due(&store, NOW + DAY).unwrap().is_empty());
}

#[test]
fn advance_counts_runs_and_stops_at_max_runs() {
    let store = store();
    let first = once(&store);
    let ran = advance(&store, &first, NOW + MINUTE, false).unwrap();
    assert_eq!((ran.run_count, ran.enabled, ran.next_run_at, ran.last_run_at), (1, false, None, Some(NOW + MINUTE)));

    let every = create(&store, &ScheduleInput { interval_minutes: Some(30), max_runs: Some(2), ..input("interval") }, "agent", Some("a"), NOW).unwrap();
    // Three hours late: one run, the next slot counted from now.
    let late = NOW + 3 * 60 * MINUTE;
    let one = advance(&store, &every, late, false).unwrap();
    assert_eq!((one.run_count, one.enabled, one.next_run_at), (1, true, Some(late + 30 * MINUTE)));
    let local = |at: i64| {
        use chrono::TimeZone;
        chrono::Local.timestamp_millis_opt(at).unwrap().format("%Y-%m-%d %H:%M").to_string()
    };
    assert_eq!(
        message(&one, false, late),
        format!("Check the deploy\n\n{TRACE_HEADER}: Check the deploy\nSchedule ID: {} · every 30 min · run 1 of 2 · set by this thread's agent\nTrigger: clock time reached · local time {}\nYou set this earlier in this thread. Pick up where you left off; cancel it with pandacode_cancel_schedule if it is no longer needed.", every.id, local(late))
    );
    let two = advance(&store, &one, late + 30 * MINUTE, false).unwrap();
    assert_eq!((two.run_count, two.enabled, two.next_run_at), (2, false, None));
    assert!(due(&store, late + DAY).unwrap().is_empty());
    assert!(set_enabled(&store, &two.id, true, NOW).unwrap_err().contains("all its runs"));
    assert!(message(&ran, true, NOW).contains(&format!("· once · run 1 · set by the user · started with Run now\nTrigger: Run now · local time {}", local(NOW))));
    assert!(update(&store, &two.id, &ScheduleInput { interval_minutes: Some(30), max_runs: Some(2), ..input("interval") }, NOW).unwrap_err().contains("already run 2 times"));
}

#[test]
fn after_triggers_wait_for_the_clock_loop_and_hold_while_paused() {
    let store = store();
    let after = create(&store, &ScheduleInput { watch_session_id: Some("b".into()), only_on_success: true, ..input("after") }, "user", None, NOW).unwrap();
    assert_eq!(trigger(&store, "b", false, NOW).unwrap(), 0, "only on success");
    assert_eq!(trigger(&store, "a", true, NOW).unwrap(), 0);
    set_settings(&store, &SchedulerSettings { paused: true, ..Default::default() }).unwrap();
    assert_eq!(trigger(&store, "b", true, NOW).unwrap(), 1);
    assert!(due(&store, NOW + DAY).unwrap().is_empty(), "held while paused");
    // A second finish coalesces into the same pending run.
    trigger(&store, "b", true, NOW + 10_000).unwrap();
    set_settings(&store, &SchedulerSettings::default()).unwrap();
    let pending = due(&store, NOW + DAY).unwrap();
    assert_eq!((pending.len(), pending[0].next_run_at, pending[0].trigger_ok), (1, Some(NOW), Some(true)));
    let fired = advance(&store, &pending[0], NOW + DAY, false).unwrap();
    assert_eq!((fired.enabled, fired.next_run_at, fired.trigger_ok), (true, None, Some(true)));
    assert!(message(&fired, false, NOW).contains("\nTrigger: “b” (b) finished successfully · local time "));
    assert!(message(&fired, false, NOW).contains("· after “b” succeeds · run 1 · set by the user\n"));
    // The next trigger waits 30 s after that run.
    trigger(&store, "b", true, NOW + DAY + 1_000).unwrap();
    assert_eq!(get(&store, &after.id).unwrap().next_run_at, Some(NOW + DAY + 30_000));
}

#[test]
fn after_schedules_that_would_loop_are_refused() {
    let store = store();
    // a runs after b; then b after a would loop.
    let first = create(&store, &ScheduleInput { watch_session_id: Some("b".into()), ..input("after") }, "user", None, NOW).unwrap();
    let error = create(&store, &ScheduleInput { session_id: "b".into(), watch_session_id: Some("a".into()), ..input("after") }, "user", None, NOW).unwrap_err();
    assert!(error.starts_with("This would loop:"), "{error}");
    // Editing the first schedule itself is not a loop with itself.
    update(&store, &first.id, &ScheduleInput { watch_session_id: Some("b".into()), ..input("after") }, NOW).unwrap();
    // With the first off, the reverse is fine, and turning the first back on is refused.
    set_enabled(&store, &first.id, false, NOW).unwrap();
    create(&store, &ScheduleInput { session_id: "b".into(), watch_session_id: Some("a".into()), ..input("after") }, "user", None, NOW).unwrap();
    assert!(set_enabled(&store, &first.id, true, NOW).unwrap_err().starts_with("This would loop:"));
}

#[test]
fn zoned_next_run_rechecks_the_offset_at_the_slot() {
    use crate::bots::schedule::next_run_zoned;
    // The offset moves from +0 to +1 h at NOW + 5 h; a 09:00 run must stay 09:00 local.
    let shift = NOW + 5 * 60 * MINUTE;
    let offset_at = |at: i64| if at >= shift { 60 * MINUTE } else { 0 };
    assert_eq!(next_run_zoned("daily", None, Some("09:00"), &[], NOW, offset_at), Some(NOW + 8 * 60 * MINUTE));
    assert_eq!(next_run_on("daily", None, Some("09:00"), &[], NOW, 0), Some(NOW + 9 * 60 * MINUTE), "fixed offset unchanged");
    assert_eq!(next_run_zoned("interval", Some(30), None, &[], NOW, offset_at), Some(NOW + 30 * MINUTE));
}

#[test]
fn runs_keep_the_newest_200_per_thread_and_survive_deletion() {
    let store = store();
    let schedule = once(&store);
    for at in 0..205 {
        record_run(&store, &schedule, NOW + at, "started", "", false).unwrap();
    }
    let kept = runs(&store, Some("a"), None, 500).unwrap();
    assert_eq!(kept.len(), 200);
    assert_eq!(kept[0].at, NOW + 204);
    assert_eq!(kept[199].at, NOW + 5);
    delete(&store, &schedule.id).unwrap();
    assert_eq!(runs(&store, None, Some(&schedule.id), 5).unwrap().len(), 5);
}

#[test]
fn failures_turn_a_schedule_off_after_three() {
    let store = store();
    let schedule = once(&store);
    assert_eq!(note_outcome(&store, &schedule, Some("Boom.")).unwrap(), "Boom.");
    note_outcome(&store, &schedule, Some("Boom.")).unwrap();
    assert!(note_outcome(&store, &schedule, Some("Boom.")).unwrap().contains("Turned off after 3 failures"));
    assert!(!get(&store, &schedule.id).unwrap().enabled);
}

#[test]
fn agent_tools_respect_scope_limits_and_defaults() {
    let store = store();
    let running: std::collections::HashSet<String> = ["b".to_owned()].into();
    let call = |session: &str, name: &str, args: Value| tools::dispatch(&store, session, name, &args, &running, NOW);
    let (made, changed) = call("a", "pandacode_schedule_wakeup", json!({"note": "Poll CI", "kind": "interval", "intervalMinutes": 60})).unwrap();
    assert_eq!(changed.as_deref(), Some("a"));
    assert_eq!(made["scheduled"]["schedule"]["maxRuns"], 20);
    assert_eq!(made["scheduled"]["schedule"]["createdBy"], "agent");
    let id = made["scheduled"]["id"].as_str().unwrap().to_owned();
    assert!(call("a", "pandacode_schedule_message", json!({"taskId": "c", "text": "hi", "inMinutes": 5})).unwrap_err().contains("another project"));
    assert!(call("a", "pandacode_schedule_message", json!({"taskId": "a", "text": "hi", "inMinutes": 5})).unwrap_err().contains("wakeup"));
    let (sent, _) = call("a", "pandacode_schedule_message", json!({"taskId": "b", "text": "Rebase", "at": "2026-01-01T05:00:00Z"})).unwrap();
    assert_eq!(sent["scheduled"]["schedule"]["nextRunAt"], NOW + 5 * 60 * MINUTE);
    assert!(call("b", "pandacode_cancel_schedule", json!({"scheduleId": id})).unwrap_err().contains("only schedules"));
    let (listed, _) = call("a", "pandacode_list_schedules", json!({})).unwrap();
    assert_eq!(listed["schedules"].as_array().unwrap().len(), 2);
    assert_eq!(listed["thisTaskId"], "a");
    assert!(listed["nowLocal"].is_string());
    let tasks = listed["tasks"].as_array().unwrap();
    assert_eq!(tasks.len(), 2, "same project, no drafts: {tasks:?}");
    assert!(tasks.iter().any(|task| task["id"] == "b" && task["running"] == true));
    let user = create(&store, &ScheduleInput { run_at: Some(NOW + MINUTE), ..input("once") }, "user", None, NOW).unwrap();
    assert!(call("a", "pandacode_cancel_schedule", json!({"scheduleId": user.id})).unwrap_err().contains("Settings → Schedules"));
    delete(&store, &user.id).unwrap();
    assert!(call("a", "pandacode_schedule_wakeup", json!({"note": "x"})).unwrap_err().contains("inMinutes"));

    set_settings(&store, &SchedulerSettings { agent_limit_per_task: 2, ..Default::default() }).unwrap();
    assert!(call("a", "pandacode_schedule_wakeup", json!({"note": "x", "inMinutes": 5})).unwrap_err().contains("limit 2"));
    call("a", "pandacode_cancel_schedule", json!({"scheduleId": id})).unwrap();
    assert!(get(&store, &id).is_err());
    assert!(tools::self_scoped("pandacode_schedule_wakeup") && !tools::self_scoped("pandacode_schedule_message") && !tools::self_scoped("pandacode_open_browser"));
}

#[test]
fn messages_from_another_thread_say_where_they_came_from() {
    let store = store();
    let running = std::collections::HashSet::new();
    let (made, _) = tools::dispatch(&store, "b", "pandacode_schedule_message", &json!({"taskId": "a", "text": "Rebase now", "inMinutes": 5}), &running, NOW).unwrap();
    let schedule = get(&store, made["scheduled"]["id"].as_str().unwrap()).unwrap();
    let text = message(&advance(&store, &schedule, NOW, true).unwrap(), true, NOW);
    let lines: Vec<&str> = text.lines().collect();
    assert_eq!(lines[0], "Rebase now");
    assert_eq!(lines[2], format!("{TRACE_HEADER}: Rebase now"));
    assert_eq!(lines[3], format!("Schedule ID: {} · once · run 1 · set by an agent in “b” (b) · started with Run now", schedule.id));
    assert!(lines[4].starts_with("Trigger: Run now · local time "));
    assert_eq!(lines[5], "From: “b” (b). Reply there with pandacode_schedule_message if useful.");
    assert_eq!(lines.len(), 6);
}

#[test]
fn at_accepts_rfc3339_naive_local_and_clock_times() {
    use chrono::TimeZone;
    let naive = chrono::Local.from_local_datetime(&chrono::NaiveDate::from_ymd_opt(2026, 3, 4).unwrap().and_hms_opt(10, 30, 0).unwrap()).earliest().unwrap().timestamp_millis();
    assert_eq!(tools::parse_at("2026-03-04T10:30", NOW), Some(naive));
    assert_eq!(tools::parse_at("2026-03-04 10:30", NOW), Some(naive));
    assert_eq!(tools::parse_at("2026-01-01T05:00:00Z", NOW), Some(NOW + 5 * 60 * MINUTE));
    let clock = tools::parse_at("23:15", NOW).unwrap();
    assert!(clock > NOW && clock <= NOW + DAY + 60 * MINUTE);
    assert_eq!(tools::parse_at("soon", NOW), None);
}

#[test]
fn workflow_steps_arm_only_after_their_previous_step_ran() {
    let store = store();
    // Step 1: when b finishes, wake a. Step 2: when a finishes after step 1, wake b.
    let one = create(&store, &ScheduleInput { watch_session_id: Some("b".into()), workflow_id: Some("wf".into()), ..input("after") }, "user", None, NOW).unwrap();
    let two_input = ScheduleInput { session_id: "b".into(), watch_session_id: Some("a".into()), workflow_id: Some("wf".into()), chain_from_id: Some(one.id.clone()), ..input("after") };
    // A plain b-after-a would loop with step 1; validation sees the chain too.
    assert!(create(&store, &two_input, "user", None, NOW).unwrap_err().starts_with("This would loop:"));
    set_enabled(&store, &one.id, false, NOW).unwrap();
    let two = create(&store, &two_input, "user", None, NOW).unwrap();
    assert_eq!((two.workflow_id.as_deref(), two.chain_from_id.as_deref()), (Some("wf"), Some(one.id.as_str())));
    // An unrelated end of a's turn does not arm step 2.
    assert_eq!(trigger(&store, "a", true, NOW).unwrap(), 0);
    // Once step 1 has run, a's next turn end arms step 2 once.
    store.db.execute("UPDATE task_schedules SET last_run_at=?2 WHERE id=?1", params![one.id, NOW + 1_000]).unwrap();
    // Step 1's message was queued behind a busy turn: that earlier turn's end does not arm step 2.
    store.db.execute("INSERT INTO messages(session_id,role,content,created_at) VALUES('a','user','earlier',?1)", [NOW]).unwrap();
    assert_eq!(trigger(&store, "a", true, NOW + 1_500).unwrap(), 0);
    // The turn that read step 1's message ends: step 2 arms.
    store.db.execute("INSERT INTO messages(session_id,role,content,created_at) VALUES('a','user','step 1',?1)", [NOW + 1_200]).unwrap();
    assert_eq!(trigger(&store, "a", true, NOW + 2_000).unwrap(), 1);
    let fired = advance(&store, &due(&store, NOW + 2_000).unwrap()[0], NOW + 3_000, false).unwrap();
    assert_eq!(fired.id, two.id);
    assert_eq!(trigger(&store, "a", true, NOW + 60_000).unwrap(), 0, "one run per pass");

    let bad = |chain: &str, watch: &str| create(&store, &ScheduleInput { session_id: "b".into(), watch_session_id: Some(watch.into()), chain_from_id: Some(chain.into()), ..input("after") }, "user", None, NOW).unwrap_err();
    assert!(bad("nope", "a").contains("no longer exists"));
    assert!(bad(&two.id, "a").contains("watch the thread its previous step wakes"));
    assert!(create(&store, &ScheduleInput { chain_from_id: Some(one.id.clone()), run_at: Some(NOW + MINUTE), ..input("once") }, "user", None, NOW).unwrap_err().contains("Only an after schedule"));
    assert!(create(&store, &ScheduleInput { workflow_id: Some("w".repeat(65)), run_at: Some(NOW + MINUTE), ..input("once") }, "user", None, NOW).unwrap_err().contains("64"));
}

#[test]
fn console_only_threads_stay_due_without_advancing() {
    let store = store();
    let schedule = once(&store);
    let held: std::collections::HashSet<String> = ["a".to_owned()].into();
    assert!(firing::take_due(&store, NOW + MINUTE, &held).unwrap().is_empty());
    let still = get(&store, &schedule.id).unwrap();
    assert_eq!((still.run_count, still.enabled, still.next_run_at), (0, true, Some(NOW + MINUTE)));
    assert!(runs(&store, Some("a"), None, 10).unwrap().is_empty());
    let fired = firing::take_due(&store, NOW + MINUTE, &Default::default()).unwrap();
    assert_eq!(fired.len(), 1);
    // A second pass over the same snapshot cannot run it again.
    assert!(advance(&store, &schedule, NOW + MINUTE, false).is_err());
}

#[test]
fn agent_timing_infers_the_kind_and_after_defaults_to_one_run() {
    let infer = |args: Value| tools::timing_input(&args, NOW).map(|input| input.kind);
    assert_eq!(infer(json!({"afterTaskId": "b"})).unwrap(), "after");
    assert_eq!(infer(json!({"days": [1], "timeOfDay": "09:00"})).unwrap(), "weekly");
    assert_eq!(infer(json!({"intervalMinutes": 30})).unwrap(), "interval");
    assert_eq!(infer(json!({"timeOfDay": "09:00"})).unwrap(), "daily");
    assert_eq!(infer(json!({"inMinutes": 5})).unwrap(), "once");
    assert!(infer(json!({"days": [1]})).unwrap_err().contains("needs timeOfDay"));
    assert!(infer(json!({"kind": "interval"})).unwrap_err().contains("needs intervalMinutes"));
    assert!(infer(json!({"kind": "after"})).unwrap_err().contains("needs afterTaskId"));

    let store = store();
    let running = std::collections::HashSet::new();
    let call = |name: &str, args: Value| tools::dispatch(&store, "a", name, &args, &running, NOW);
    let (made, _) = call("pandacode_schedule_wakeup", json!({"note": "Review b", "afterTaskId": "b"})).unwrap();
    assert_eq!((made["scheduled"]["schedule"]["kind"].as_str(), made["scheduled"]["schedule"]["maxRuns"].as_i64()), (Some("after"), Some(1)));
    assert_eq!(made["scheduled"]["stopsAfter"], "runs once; pass maxRuns for repeats");
    let (every, _) = call("pandacode_schedule_wakeup", json!({"note": "Poll", "intervalMinutes": 30})).unwrap();
    assert_eq!(every["scheduled"]["stopsAfter"], "stops after 20 runs; pass maxRuns up to 1000 to keep going");
    assert!(call("pandacode_schedule_wakeup", json!({"note": "x", "afterTaskId": "a"})).unwrap_err().contains("its own turn end"));
    assert!(call("pandacode_schedule_message", json!({"taskId": "zz", "text": "x", "inMinutes": 5})).unwrap_err().starts_with("No thread"));
}
