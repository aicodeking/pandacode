use super::*;

fn worker(id: &str, status: &str) -> Worker {
    serde_json::from_value(json!({"id":id,"sessionId":format!("task-{id}"),"name":id,"profileId":"fast","provider":"codex","model":"default","reasoningEffort":null,"status":status,"assignment":"Small task","summary":"","error":null,"dependsOn":[],"files":[],"attempt":1,"createdAt":1,"updatedAt":1})).unwrap()
}

fn team(statuses: &[(&str, &str)]) -> (AppState, String) {
    let store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let project = store.add_project(&std::env::temp_dir()).unwrap();
    let parent = store.create_session(&project.id, "claude", "default", "ask").unwrap();
    let config = serde_json::from_value(json!({"workers":[{"id":"fast","name":"Fast","provider":"codex","model":"default"}],"maxParallel":3,"maxRounds":5,"maxAssignments":10,"workspace":"shared","summaryLimit":2000})).unwrap();
    let mut team = new_team(parent.id.clone(), config);
    team.status = "running".into();
    team.generation = 1;
    team.workers = statuses.iter().map(|(id, status)| worker(id, status)).collect();
    save(&store, &mut team).unwrap();
    let state = AppState {
        store: Arc::new(std::sync::Mutex::new(store)),
        agents: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
        terminals: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
        shutdown: std::sync::atomic::AtomicU8::new(0),
    };
    (state, parent.id)
}

fn as_worker(id: &str) -> Actor {
    Actor::Worker { id: id.into(), attempt: 1 }
}

fn call(state: &AppState, parent: &str, actor: &Actor, name: &str, args: Value) -> Result<Value> {
    dispatch_state(state, parent, 1, actor, name, args, &AtomicBool::new(false)).map(|r| r.0)
}

fn send(state: &AppState, parent: &str, from: &Actor, args: Value) -> Result<Value> {
    call(state, parent, from, "pandacode_send_team_message", args)
}

#[test]
fn inbox_digest_appears_only_while_unread_and_reading_clears_it() {
    let (state, parent) = team(&[("a", "running"), ("b", "running")]);
    let (a, b) = (as_worker("a"), as_worker("b"));
    assert!(call(&state, &parent, &b, "pandacode_team_directory", json!({})).unwrap().get("inbox").is_none());
    assert!(call(&state, &parent, &b, "pandacode_team_directory", json!({"offset":null})).is_ok(), "null means absent");
    assert!(call(&state, &parent, &b, "pandacode_read_team_mailbox", json!({"afterId":null,"limit":null,"offset":null,"offsetId":null})).is_ok(), "null means absent");
    let long = "x".repeat(300);
    send(&state, &parent, &a, json!({"recipient":"b","key":"one","message":long})).unwrap();
    send(&state, &parent, &a, json!({"recipient":"b","key":"two","message":"second"})).unwrap();
    let directory = call(&state, &parent, &b, "pandacode_team_directory", json!({})).unwrap();
    assert_eq!(directory["inbox"]["unread"], 2);
    let newest = directory["inbox"]["newest"].as_array().unwrap();
    assert_eq!((newest[0]["preview"].as_str(), newest[0]["sender"].as_str()), (Some("second"), Some("a")));
    assert_eq!(newest[1]["preview"].as_str().unwrap().chars().count(), 161, "160 characters and an ellipsis");
    // The sender has nothing unread; reading clears the digest for the reader.
    assert!(send(&state, &parent, &a, json!({"recipient":"b","key":"three","message":"third"})).unwrap().get("inbox").is_none());
    let read = call(&state, &parent, &b, "pandacode_read_team_mailbox", json!({"limit":2})).unwrap();
    assert_eq!(read["inbox"]["unread"], 1, "one message is still past the page");
    let read = call(&state, &parent, &b, "pandacode_read_team_mailbox", json!({"afterId":read["nextCursor"]})).unwrap();
    assert!(read.get("inbox").is_none());
    // The brief does not repeat messages already read through the tool.
    let store = state.store.lock().unwrap();
    let snapshot = load(&store, &parent).unwrap().unwrap();
    let (text, _) = context(&store, &snapshot, &b, 0, false).unwrap();
    assert!(text.is_empty(), "{text}");
}

#[test]
fn broadcast_fans_out_to_active_teammates_and_dedups_by_key() {
    let (state, parent) = team(&[("a", "running"), ("b", "running"), ("c", "completed")]);
    let a = as_worker("a");
    let first = send(&state, &parent, &a, json!({"recipient":"all","key":"api","message":"Widget has id and title."})).unwrap();
    assert_eq!(first["messageIds"].as_array().unwrap().len(), 2, "b and the architect, not the finished c");
    assert_eq!(first["delivered"], "mailbox", "nothing urgent was steered");
    let again = send(&state, &parent, &a, json!({"recipient":"all","key":"api","message":"Widget has id and title."})).unwrap();
    assert_eq!((again["duplicate"].as_bool(), &again["messageIds"]), (Some(true), &first["messageIds"]));
    assert!(send(&state, &parent, &a, json!({"recipient":"all","key":"api","message":"Changed"})).is_err());
    assert!(send(&state, &parent, &a, json!({"recipient":"b","key":"api","message":"Widget has id and title."})).is_err(), "a broadcast key is not reused for one recipient");
    for reader in [as_worker("b"), Actor::Architect] {
        assert_eq!(call(&state, &parent, &reader, "pandacode_team_directory", json!({})).unwrap()["inbox"]["unread"], 1);
    }
    assert!(call(&state, &parent, &as_worker("c"), "pandacode_team_directory", json!({})).is_err(), "c is no longer active");
    let store = state.store.lock().unwrap();
    let snapshot = load(&store, &parent).unwrap().unwrap();
    assert_eq!(snapshot.coordination_revision, 0, "a non-urgent broadcast does not wake the architect");
}

#[test]
fn only_urgent_messages_wake_the_architect() {
    let (state, parent) = team(&[("a", "running")]);
    let revision = || load(&state.store.lock().unwrap(), &parent).unwrap().unwrap().coordination_revision;
    send(&state, &parent, &as_worker("a"), json!({"recipient":"architect","key":"fyi","message":"Parser done"})).unwrap();
    assert_eq!(revision(), 0);
    send(&state, &parent, &as_worker("a"), json!({"recipient":"architect","key":"now","message":"Blocked on API","urgent":true})).unwrap();
    assert_eq!(revision(), 1);
    send(&state, &parent, &as_worker("a"), json!({"recipient":"architect","key":"now","message":"Blocked on API","urgent":true})).unwrap();
    assert_eq!(revision(), 1, "a retried key does not wake it again");
}

#[test]
fn reply_to_roundtrips_and_must_name_a_received_message() {
    let (state, parent) = team(&[("a", "running"), ("b", "running")]);
    let (a, b) = (as_worker("a"), as_worker("b"));
    let question = send(&state, &parent, &a, json!({"recipient":"b","key":"q","message":"Port?"})).unwrap()["messageId"].as_i64().unwrap();
    assert!(send(&state, &parent, &a, json!({"recipient":"b","key":"bad","message":"x","replyTo":question})).is_err(), "a sends, it did not receive");
    let answer = send(&state, &parent, &b, json!({"recipient":"a","key":"ans","message":"1420","replyTo":question})).unwrap();
    assert_eq!(answer["replyTo"], question);
    let read = call(&state, &parent, &a, "pandacode_read_team_mailbox", json!({})).unwrap();
    assert_eq!(read["messages"][0]["replyTo"], question);
    assert!(read["messages"][0].get("replyTo").is_some());
    let unthreaded = call(&state, &parent, &b, "pandacode_read_team_mailbox", json!({})).unwrap();
    assert!(unthreaded["messages"][0].get("replyTo").is_none());
}

#[test]
fn notes_set_get_list_delete_and_brief() {
    let (state, parent) = team(&[("a", "running"), ("b", "running")]);
    let (a, b) = (as_worker("a"), as_worker("b"));
    let notes = |actor: &Actor, args: Value| call(&state, &parent, actor, "pandacode_team_notes", args);
    notes(&a, json!({"action":"set","key":"api.widget","value":"Widget { id, title }"})).unwrap();
    let got = notes(&b, json!({"action":"get","key":"api.widget"})).unwrap();
    assert_eq!((got["note"]["value"].as_str(), got["note"]["author"].as_str()), (Some("Widget { id, title }"), Some("a")));
    assert_eq!(notes(&Actor::Architect, json!({"action":"list"})).unwrap()["notes"].as_array().unwrap().len(), 1);
    assert!(notes(&a, json!({"action":"set","key":"bad key","value":"x"})).is_err());
    assert!(notes(&a, json!({"action":"set","key":"nul","value":"x\0y"})).is_err());
    {
        let store = state.store.lock().unwrap();
        let snapshot = load(&store, &parent).unwrap().unwrap();
        let (brief, _) = context(&store, &snapshot, &b, 0, true).unwrap();
        assert!(brief.contains("api.widget (a): Widget { id, title }"), "{brief}");
        let (again, _) = context(&store, &snapshot, &b, 0, false).unwrap();
        assert!(again.is_empty(), "seen notes are not repeated: {again}");
    }
    assert_eq!(notes(&b, json!({"action":"set","key":"api.widget","value":""})).unwrap()["deleted"], true);
    assert_eq!(notes(&b, json!({"action":"get","key":"api.widget"})).unwrap()["found"], false);
    for i in 0..64 {
        notes(&a, json!({"action":"set","key":format!("k{i}"),"value":"v"})).unwrap();
    }
    notes(&a, json!({"action":"set","key":"k64","value":"v"})).expect("past the old 64 notes");
    notes(&a, json!({"action":"set","key":"k0","value":"updated"})).expect("an existing key can still change");
}

#[test]
fn notes_written_in_the_same_millisecond_still_reach_the_next_brief() {
    let (state, parent) = team(&[("a", "running"), ("b", "running")]);
    let (a, b) = (as_worker("a"), as_worker("b"));
    let notes = |args: Value| call(&state, &parent, &a, "pandacode_team_notes", args);
    notes(json!({"action":"set","key":"first","value":"one"})).unwrap();
    let brief = |full| {
        let store = state.store.lock().unwrap();
        let snapshot = load(&store, &parent).unwrap().unwrap();
        context(&store, &snapshot, &b, 0, full).unwrap().0
    };
    assert!(brief(false).contains("first (a): one"));
    notes(json!({"action":"set","key":"second","value":"two"})).unwrap();
    state.store.lock().unwrap().db.execute("UPDATE architect_notes SET updated_at=(SELECT MIN(updated_at) FROM architect_notes WHERE parent_session_id=?1) WHERE parent_session_id=?1", [&parent]).unwrap();
    let update = brief(false);
    assert!(update.contains("second (a): two") && !update.contains("first"), "{update}");
    assert!(brief(false).is_empty());
}

#[test]
fn a_mailbox_cursor_past_the_newest_message_hides_nothing() {
    let (state, parent) = team(&[("a", "running"), ("b", "running")]);
    let (a, b) = (as_worker("a"), as_worker("b"));
    let empty = call(&state, &parent, &b, "pandacode_read_team_mailbox", json!({"afterId":i64::MAX})).unwrap();
    assert!(empty["messages"].as_array().unwrap().is_empty());
    send(&state, &parent, &a, json!({"recipient":"b","key":"later","message":"Port is 1420"})).unwrap();
    let directory = call(&state, &parent, &b, "pandacode_team_directory", json!({})).unwrap();
    assert_eq!(directory["inbox"]["unread"], 1, "an empty page read nothing");
    let read = call(&state, &parent, &b, "pandacode_read_team_mailbox", json!({})).unwrap();
    assert_eq!(read["messages"][0]["message"], "Port is 1420");
    assert!(read.get("inbox").is_none());
}

#[test]
fn a_mailbox_cursor_past_unread_messages_does_not_mark_them_read() {
    let (state, parent) = team(&[("a", "running"), ("b", "running")]);
    let (a, b) = (as_worker("a"), as_worker("b"));
    send(&state, &parent, &a, json!({"recipient":"b","key":"one","message":"First"})).unwrap();
    let two = send(&state, &parent, &a, json!({"recipient":"b","key":"two","message":"Second"})).unwrap();
    let two = two["messageId"].as_i64().unwrap_or_else(|| two["messageIds"][0].as_i64().unwrap());
    let read = call(&state, &parent, &b, "pandacode_read_team_mailbox", json!({"afterId":two - 1})).unwrap();
    assert_eq!(read["messages"][0]["message"], "Second");
    let directory = call(&state, &parent, &b, "pandacode_team_directory", json!({})).unwrap();
    assert_eq!(directory["inbox"]["unread"], 2, "the jump read nothing it skipped");
    let read = call(&state, &parent, &b, "pandacode_read_team_mailbox", json!({})).unwrap();
    assert_eq!(read["messages"][0]["message"], "First");
    let directory = call(&state, &parent, &b, "pandacode_team_directory", json!({})).unwrap();
    assert_eq!(directory.get("inbox"), None, "a read from the cursor still counts");
}

#[test]
fn a_note_too_large_for_a_brief_does_not_stop_smaller_older_ones() {
    let (state, parent) = team(&[("a", "running"), ("b", "running")]);
    let (a, b) = (as_worker("a"), as_worker("b"));
    let notes = |args: Value| call(&state, &parent, &a, "pandacode_team_notes", args);
    notes(json!({"action":"set","key":"small","value":"port 1420"})).unwrap();
    notes(json!({"action":"set","key":"huge","value":"v".repeat(10 * 1024)})).unwrap();
    let store = state.store.lock().unwrap();
    let snapshot = load(&store, &parent).unwrap().unwrap();
    let (brief, _) = context(&store, &snapshot, &b, 0, true).unwrap();
    assert!(brief.contains("- small (a): port 1420"), "{brief}");
    assert!(brief.contains(" 1 more note: use") && !brief.contains("- huge"), "{brief}");
}

#[test]
fn a_message_key_is_never_reused_across_direct_and_broadcast_forms() {
    let (state, parent) = team(&[("a", "running"), ("b", "running"), ("c", "queued"), ("d", "parked")]);
    let a = as_worker("a");
    send(&state, &parent, &a, json!({"recipient":"b","key":"k","message":"Same text"})).unwrap();
    assert!(send(&state, &parent, &a, json!({"recipient":"all","key":"k","message":"Same text"})).is_err(), "a direct key does not dedupe a broadcast");
    let all = send(&state, &parent, &a, json!({"recipient":"all","key":"wide","message":"Schema changed"})).unwrap();
    assert_eq!(all["messageIds"].as_array().unwrap().len(), 4, "b, queued c, parked d and the architect");
    assert!(send(&state, &parent, &a, json!({"recipient":"b","key":"wide#b","message":"Schema changed"})).is_err());
    let question = send(&state, &parent, &as_worker("b"), json!({"recipient":"a","key":"q","message":"Port?"})).unwrap()["messageId"].clone();
    send(&state, &parent, &a, json!({"recipient":"b","key":"ans","message":"1420","replyTo":question})).unwrap();
    assert!(send(&state, &parent, &a, json!({"recipient":"b","key":"ans","message":"1420"})).is_err(), "a retry must repeat replyTo");
}

#[test]
fn an_urgent_steer_counts_as_read_only_once_the_run_accepts_it() {
    let (state, parent) = team(&[("a", "running"), ("b", "running"), ("c", "running")]);
    let mut inputs = Vec::new();
    for id in ["b", "c"] {
        let (tx, rx) = crate::unbounded_channel();
        state.agents.lock().unwrap().insert(format!("task-{id}"), crate::RunningAgent::new(tx, Arc::new(AtomicBool::new(false))));
        inputs.push(rx);
    }
    for (recipient, key) in [("b", "u1"), ("c", "u2")] {
        let sent = send(&state, &parent, &as_worker("a"), json!({"recipient":recipient,"key":key,"message":"Stop editing api.rs","urgent":true})).unwrap();
        assert_eq!(sent["delivered"], "sent", "the run has not accepted it yet");
    }
    let unread = |id: &str| call(&state, &parent, &as_worker(id), "pandacode_team_directory", json!({})).unwrap().get("inbox").map(|i| i["unread"].clone());
    // b's run refuses the steer; c's takes it.
    for (rx, accepted) in inputs.iter_mut().zip([false, true]) {
        let Ok(RunInput::Steer { reply, .. }) = rx.try_recv() else { panic!("no steer") };
        reply.send(if accepted { Ok(json!({"steered":true})) } else { Err("refused".into()) }).unwrap();
    }
    for _ in 0..200 {
        if unread("c").is_none() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    assert_eq!(unread("c"), None, "an accepted steer is read");
    assert_eq!(unread("b"), Some(json!(1)), "a refused steer stays unread");
}

#[test]
fn an_urgent_steer_of_a_long_message_carries_a_preview_and_stays_unread() {
    let (state, parent) = team(&[("a", "running"), ("b", "running")]);
    let (tx, mut rx) = crate::unbounded_channel();
    state.agents.lock().unwrap().insert("task-b".into(), crate::RunningAgent::new(tx, Arc::new(AtomicBool::new(false))));
    // The cut falls inside a multi-byte character, and the tail never reaches the turn.
    let long = format!("{}é{}TAIL", "x".repeat(STEER_PREVIEW - 1), "y".repeat(STEER_PREVIEW));
    let sent = send(&state, &parent, &as_worker("a"), json!({"recipient":"b","key":"u","message":long,"urgent":true})).unwrap();
    assert_eq!(sent["delivered"], "sent");
    let Ok(RunInput::Steer { text, reply, .. }) = rx.try_recv() else { panic!("no steer") };
    assert!(text.len() < STEER_PREVIEW + 256, "{} bytes", text.len());
    assert!(text.contains("read_team_mailbox has the rest") && !text.contains("TAIL"));
    // Nothing waits on a cut steer's acceptance, so nothing can mark it read.
    assert!(reply.send(Ok(json!({"steered":true}))).is_err());
    let directory = call(&state, &parent, &as_worker("b"), "pandacode_team_directory", json!({})).unwrap();
    assert_eq!(directory["inbox"]["unread"], 1, "the rest must still be read");
    assert_eq!(steer_preview("short"), ("short".to_string(), true));
}

#[test]
fn urgent_falls_back_to_the_mailbox_when_the_worker_is_not_running() {
    let (state, parent) = team(&[("a", "running"), ("b", "running")]);
    let sent = send(&state, &parent, &as_worker("a"), json!({"recipient":"b","key":"u","message":"Stop editing api.rs","urgent":true})).unwrap();
    assert_eq!((sent["delivered"].as_str(), sent["saved"].as_bool()), (Some("mailbox"), Some(true)));
    let to_architect = send(&state, &parent, &as_worker("a"), json!({"recipient":"architect","key":"u2","message":"Blocked","urgent":true})).unwrap();
    assert_eq!(to_architect["delivered"], "mailbox", "the architect is never steered");
    assert_eq!(call(&state, &parent, &as_worker("b"), "pandacode_team_directory", json!({})).unwrap()["inbox"]["unread"], 1);
}

#[test]
fn urgent_slots_allow_one_steer_per_pair_per_window() {
    let parent = uuid::Uuid::new_v4().to_string();
    assert!(take_urgent_slot(&parent, "a", "b"));
    assert!(!take_urgent_slot(&parent, "a", "b"));
    assert!(take_urgent_slot(&parent, "a", "c"));
    assert!(take_urgent_slot(&parent, "c", "b"));
}

#[test]
fn a_hundred_large_notes_stay_retrievable_and_each_is_discoverable_in_a_brief() {
    let (state, parent) = team(&[("a", "running"), ("b", "running")]);
    let (a, b) = (as_worker("a"), as_worker("b"));
    let notes = |actor: &Actor, args: Value| call(&state, &parent, actor, "pandacode_team_notes", args);
    let value = |i: usize| format!("{i}:{}", "v".repeat(10 * 1024));
    for i in 0..100 {
        notes(&a, json!({"action":"set","key":format!("note.{i}"),"value":value(i)})).unwrap();
    }
    assert_eq!(notes(&b, json!({"action":"list"})).unwrap()["notes"].as_array().unwrap().len(), 100);
    for i in 0..100 {
        assert_eq!(notes(&b, json!({"action":"get","key":format!("note.{i}")})).unwrap()["note"]["value"], value(i));
    }
    let long = "k".repeat(256);
    notes(&a, json!({"action":"set","key":long,"value":"x"})).unwrap();
    assert!(notes(&a, json!({"action":"set","key":"k".repeat(257),"value":"x"})).is_err());
    assert!(notes(&a, json!({"action":"set","key":"bad key","value":"x"})).is_err());
    let store = state.store.lock().unwrap();
    let snapshot = load(&store, &parent).unwrap().unwrap();
    let (brief, _) = context(&store, &snapshot, &b, 0, true).unwrap();
    // The brief stops at its budget and counts the rest; the list tool pages them.
    assert!(brief.contains(&format!("- {long} (a): x")), "the newest, small note fits inline");
    assert!(brief.contains("100 more notes: use pandacode_team_notes list."), "{brief}");
    assert!(!brief.contains("- note.0 (a)"), "nothing past the budget is listed: {brief}");
    assert!(brief.len() < 4 * 1024, "{} bytes", brief.len());
}

#[test]
fn large_messages_checkpoints_and_mailbox_pages_are_accepted() {
    let (state, parent) = team(&[("a", "running"), ("b", "running")]);
    let (a, b) = (as_worker("a"), as_worker("b"));
    let message = "m".repeat(50 * 1024);
    for i in 0..30 {
        send(&state, &parent, &a, json!({"recipient":"b","key":format!("k{i}"),"message":message})).unwrap();
    }
    // Larger than a page: the first page holds the start of one, and the cursor stays before it.
    let page = call(&state, &parent, &b, "pandacode_read_team_mailbox", json!({"limit":25})).unwrap();
    assert_eq!(page["messages"].as_array().unwrap().len(), 1);
    assert_eq!(page["hasMore"], true);
    assert_eq!(page["messages"][0]["truncated"], true);
    assert_eq!(page["nextCursor"], 0);
    assert_eq!(page["offsetId"], page["messages"][0]["id"]);
    assert!(call(&state, &parent, &b, "pandacode_read_team_mailbox", json!({"limit":0})).is_err());
    let saved = call(&state, &parent, &a, "pandacode_checkpoint_worker", json!({"key":"big","summary":"s".repeat(20_000),"nextSteps":"n".repeat(20_000),"blocker":"b".repeat(20_000)})).unwrap();
    assert_eq!((saved["saved"].as_bool(), saved["duplicate"].as_bool(), saved.get("checkpoint")), (Some(true), Some(false), None));
    assert!(call(&state, &parent, &a, "pandacode_checkpoint_worker", json!({"key":"nul","summary":" ","nextSteps":"n"})).is_err());
    for i in 0..205 {
        call(&state, &parent, &a, "pandacode_checkpoint_worker", json!({"key":format!("c{i}"),"summary":"s","nextSteps":"n"})).unwrap();
    }
}

#[test]
fn urgent_steers_past_the_throttle_fall_back_to_the_mailbox_without_refusal() {
    let (state, parent) = team(&[("a", "running"), ("b", "running")]);
    let a = as_worker("a");
    for i in 0..3 {
        let sent = send(&state, &parent, &a, json!({"recipient":"b","key":format!("u{i}"),"message":"hi","urgent":true})).unwrap();
        assert_eq!(sent["delivered"], "mailbox", "no agent is registered in this fixture");
        assert_eq!(sent["saved"], true);
    }
}

#[test]
fn every_urgent_message_and_new_blocker_counts_toward_a_wake() {
    let (state, parent) = team(&[("a", "running")]);
    let a = as_worker("a");
    let revision = || load(&state.store.lock().unwrap(), &parent).unwrap().unwrap().coordination_revision;
    send(&state, &parent, &a, json!({"recipient":"architect","key":"one","message":"Blocked on API","urgent":true})).unwrap();
    send(&state, &parent, &a, json!({"recipient":"architect","key":"two","message":"Still blocked","urgent":true})).unwrap();
    assert_eq!(revision(), 2, "the window never swallows one");
    call(&state, &parent, &a, "pandacode_checkpoint_worker", json!({"key":"c1","summary":"s","nextSteps":"n","blocker":"Need the widget API"})).unwrap();
    assert_eq!(revision(), 3);
    call(&state, &parent, &a, "pandacode_checkpoint_worker", json!({"key":"c2","summary":"s","nextSteps":"n","blocker":"Need the widget API"})).unwrap();
    assert_eq!(revision(), 3, "the same blocker is not new");
}

#[test]
fn a_mailbox_offset_must_name_its_message_and_lie_inside_it() {
    let (state, parent) = team(&[("a", "running"), ("b", "running")]);
    let (a, b) = (as_worker("a"), as_worker("b"));
    send(&state, &parent, &a, json!({"recipient":"b","key":"big","message":"m".repeat(40 * 1024)})).unwrap();
    send(&state, &parent, &a, json!({"recipient":"b","key":"small","message":"short"})).unwrap();
    let first = call(&state, &parent, &b, "pandacode_read_team_mailbox", json!({})).unwrap();
    let (big, at) = (first["offsetId"].as_i64().unwrap(), first["nextOffset"].as_u64().unwrap());
    let small = big + 1;
    let read = |args: Value| call(&state, &parent, &b, "pandacode_read_team_mailbox", args);
    assert!(read(json!({"offset":at})).is_err(), "an offset needs its message");
    assert!(read(json!({"afterId":big,"offset":at,"offsetId":big})).is_err(), "the first message here is another one");
    assert!(read(json!({"afterId":big,"offset":5,"offsetId":small})).is_err(), "at the end of the message");
    assert!(read(json!({"afterId":small,"offset":1,"offsetId":small})).is_err(), "no message to apply it to");
    assert_eq!(call(&state, &parent, &b, "pandacode_team_directory", json!({})).unwrap()["inbox"]["unread"], 2, "refused reads marked nothing");
    assert_eq!(read(json!({"afterId":big,"offset":3,"offsetId":small})).unwrap()["messages"][0]["message"], "rt");
}

#[test]
fn large_checkpoints_page_through_read_worker_and_never_fill_a_result() {
    let (state, parent) = team(&[("a", "running")]);
    let a = as_worker("a");
    let summary = "s\"".repeat(30_000);
    let saved = call(&state, &parent, &a, "pandacode_checkpoint_worker", json!({"key":"big","summary":summary,"nextSteps":"Finish","blocker":"Stuck"})).unwrap();
    assert!(serde_json::to_string(&saved).unwrap().len() < 256, "{saved}");
    let read = |args: Value| dispatch_as(&state, &parent, 1, None, "pandacode_read_worker", args, &AtomicBool::new(false), &routing::AutoRoutes::default()).unwrap().0;
    let brief = read(json!({"workerId":"a"}));
    assert_eq!(brief["checkpointTruncated"], true);
    assert!(serde_json::to_string(&brief).unwrap().len() <= PAGE_BYTES);
    let mut text = String::new();
    let mut offset = Some(0);
    while let Some(at) = offset {
        let page = read(json!({"workerId":"a","checkpoint":true,"offset":at}));
        assert!(serde_json::to_string(&page).unwrap().len() <= PAGE_BYTES + 256);
        text.push_str(page["checkpoint"].as_str().unwrap());
        offset = page["nextOffset"].as_u64();
    }
    assert_eq!(text, format!("Summary:\n{summary}\n\nNext steps:\nFinish\n\nBlocker:\nStuck"));
    let store = state.store.lock().unwrap();
    let snapshot = load(&store, &parent).unwrap().unwrap();
    let (full, _) = context(&store, &snapshot, &a, 0, true).unwrap();
    assert!(full.len() < 8 * 1024 && full.contains("checkpointTruncated"), "{} bytes", full.len());
}

#[test]
fn a_huge_file_scope_is_bounded_and_flagged_in_lists() {
    let (state, parent) = team(&[("a", "running"), ("b", "running")]);
    {
        let store = state.store.lock().unwrap();
        let mut snapshot = load(&store, &parent).unwrap().unwrap();
        snapshot.workers[0].files = (0..5000).map(|i| format!("src/file-{i}.rs")).collect();
        save(&store, &mut snapshot).unwrap();
    }
    let directory = call(&state, &parent, &as_worker("b"), "pandacode_team_directory", json!({})).unwrap();
    assert_eq!(directory["workers"][0]["filesTruncated"], true);
    assert!(directory["workers"][1].get("filesTruncated").is_none());
    assert!(serde_json::to_string(&directory).unwrap().len() <= PAGE_BYTES);
    let snapshot = load(&state.store.lock().unwrap(), &parent).unwrap().unwrap();
    let list = summaries(&snapshot, 0, None);
    assert_eq!(list["workers"][0]["filesTruncated"], true);
    assert!(serde_json::to_string(&list).unwrap().len() <= PAGE_BYTES + 256);
}

#[test]
fn a_deleted_notes_revision_is_never_reused_so_the_next_note_reaches_the_brief() {
    let (state, parent) = team(&[("a", "running"), ("b", "running")]);
    let (a, b) = (as_worker("a"), as_worker("b"));
    let notes = |args: Value| call(&state, &parent, &a, "pandacode_team_notes", args);
    notes(json!({"action":"set","key":"first","value":"one"})).unwrap();
    notes(json!({"action":"set","key":"second","value":"two"})).unwrap();
    let brief = || {
        let store = state.store.lock().unwrap();
        let snapshot = load(&store, &parent).unwrap().unwrap();
        context(&store, &snapshot, &b, 0, false).unwrap().0
    };
    assert!(brief().contains("second"));
    notes(json!({"action":"set","key":"second","value":""})).unwrap();
    notes(json!({"action":"set","key":"third","value":"three"})).unwrap();
    assert!(brief().contains("third (a): three"), "its revision is past what b saw");
}

#[test]
fn a_note_updated_mid_listing_is_still_listed_once() {
    let (state, parent) = team(&[("a", "running")]);
    let a = as_worker("a");
    let notes = |args: Value| call(&state, &parent, &a, "pandacode_team_notes", args);
    for i in 0..200 {
        notes(json!({"action":"set","key":format!("{i:03}.{}", "k".repeat(240)),"value":"v"})).unwrap();
    }
    let first = notes(json!({"action":"list"})).unwrap();
    let mut keys: Vec<String> = first["notes"].as_array().unwrap().iter().map(|n| n["key"].as_str().unwrap().to_string()).collect();
    let unlisted = format!("199.{}", "k".repeat(240));
    assert!(!keys.contains(&unlisted));
    notes(json!({"action":"set","key":unlisted,"value":"changed"})).unwrap();
    let mut cursor = first["nextCursor"].clone();
    while !cursor.is_null() {
        let page = notes(json!({"action":"list","cursor":cursor})).unwrap();
        keys.extend(page["notes"].as_array().unwrap().iter().map(|n| n["key"].as_str().unwrap().to_string()));
        cursor = page["nextCursor"].clone();
    }
    assert_eq!(keys.iter().collect::<std::collections::HashSet<_>>().len(), 200);
    assert_eq!(keys.len(), 200);
}

#[test]
fn send_and_checkpoint_results_carry_no_mailbox_echo() {
    let (state, parent) = team(&[("a", "running"), ("b", "running")]);
    let (a, b) = (as_worker("a"), as_worker("b"));
    send(&state, &parent, &b, json!({"recipient":"a","key":"big","message":"m".repeat(200 * 1024)})).unwrap();
    let sent = send(&state, &parent, &a, json!({"recipient":"b","key":"k","message":"hi"})).unwrap();
    let again = send(&state, &parent, &a, json!({"recipient":"b","key":"k","message":"hi"})).unwrap();
    let saved = call(&state, &parent, &a, "pandacode_checkpoint_worker", json!({"key":"c","summary":"s","nextSteps":"n"})).unwrap();
    for result in [&sent, &again, &saved] {
        assert!(result.get("mailbox").is_none(), "{result}");
        assert_eq!(result["inbox"]["unread"], 1, "the digest covers it");
        assert!(serde_json::to_string(result).unwrap().len() < 1024, "{result}");
    }
}

#[test]
fn mailbox_pages_by_bytes_cut_a_large_message_and_never_skip_one() {
    let (state, parent) = team(&[("a", "running"), ("b", "running")]);
    let (a, b) = (as_worker("a"), as_worker("b"));
    let big: String = (0..60_000).map(|i| format!("{i}é\"\n")).collect();
    assert!(big.len() > 3 * PAGE_BYTES);
    send(&state, &parent, &a, json!({"recipient":"b","key":"small","message":"first"})).unwrap();
    send(&state, &parent, &a, json!({"recipient":"b","key":"big","message":big})).unwrap();
    send(&state, &parent, &a, json!({"recipient":"b","key":"last","message":"third"})).unwrap();
    let small = call(&state, &parent, &b, "pandacode_read_team_mailbox", json!({})).unwrap();
    assert_eq!(small["messages"].as_array().unwrap().len(), 1, "the big one does not fit beside it");
    assert_eq!((small["messages"][0]["message"].as_str(), small["hasMore"].as_bool()), (Some("first"), Some(true)));
    assert_eq!(small["nextCursor"], small["messages"][0]["id"]);
    let first = call(&state, &parent, &b, "pandacode_read_team_mailbox", json!({"afterId":small["nextCursor"]})).unwrap();
    assert_eq!(first["messages"].as_array().unwrap().len(), 1, "a page always holds something: the start of the big one");
    assert_eq!(first["messages"][0]["truncated"], true);
    assert_eq!(first["nextCursor"], small["nextCursor"], "the cursor stops before the cut message");
    assert_eq!(first["inbox"]["unread"], 2, "the cut message and the one after it are still unread");
    let mut rebuilt = first["messages"][0]["message"].as_str().unwrap().to_string();
    let mut cursor = first["nextCursor"].clone();
    let mut offset = first["nextOffset"].as_u64();
    let mut pages = 1;
    while let Some(at) = offset {
        let page = call(&state, &parent, &b, "pandacode_read_team_mailbox", json!({"afterId":cursor,"offset":at,"offsetId":first["offsetId"]})).unwrap();
        assert!(serde_json::to_string(&page["messages"]).unwrap().len() <= PAGE_BYTES + 256, "a page stays within its budget");
        let message = &page["messages"][0];
        assert_eq!(message["offset"].as_u64(), Some(at));
        rebuilt.push_str(message["message"].as_str().unwrap());
        cursor = page["nextCursor"].clone();
        offset = page["nextOffset"].as_u64();
        pages += 1;
        if offset.is_none() {
            assert_eq!(message["truncated"].as_bool(), None, "the last part is whole");
            // Read whole, so the cursor moves past it and the page goes on to the next message.
            assert_eq!(page["messages"][1]["message"], "third");
            assert_eq!(cursor, page["messages"][1]["id"]);
            assert!(page.get("inbox").is_none(), "everything is read");
        }
    }
    assert!(pages >= 4);
    assert_eq!(rebuilt, big);
    let rest = call(&state, &parent, &b, "pandacode_read_team_mailbox", json!({"afterId":cursor})).unwrap();
    assert!(rest["messages"].as_array().unwrap().is_empty() && rest["hasMore"] == false);
}

#[test]
fn notes_list_pages_by_cursor_and_get_pages_a_long_value_by_offset() {
    let (state, parent) = team(&[("a", "running")]);
    let a = as_worker("a");
    let notes = |args: Value| call(&state, &parent, &a, "pandacode_team_notes", args);
    for i in 0..400 {
        notes(json!({"action":"set","key":format!("{i}.{}", "k".repeat(240)),"value":"v".repeat(400)})).unwrap();
    }
    let mut keys = Vec::new();
    let mut cursor = None;
    let mut pages = 0;
    loop {
        let page = notes(json!({"action":"list","cursor":cursor})).unwrap();
        assert!(serde_json::to_string(&page["notes"]).unwrap().len() <= PAGE_BYTES + 512);
        keys.extend(page["notes"].as_array().unwrap().iter().map(|n| n["key"].as_str().unwrap().to_string()));
        pages += 1;
        cursor = page["nextCursor"].as_str().map(String::from);
        if cursor.is_none() {
            break;
        }
    }
    assert!(pages >= 2);
    assert_eq!(keys.len(), 400, "every note once");
    assert_eq!(keys.iter().collect::<std::collections::HashSet<_>>().len(), 400);
    let big: String = (0..40_000).map(|i| format!("{i}\"é")).collect();
    notes(json!({"action":"set","key":"big","value":big})).unwrap();
    let mut rebuilt = String::new();
    let mut offset = Some(0);
    while let Some(at) = offset {
        let got = notes(json!({"action":"get","key":"big","offset":at})).unwrap();
        assert!(serde_json::to_string(&got).unwrap().len() <= PAGE_BYTES, "a get stays within a page");
        rebuilt.push_str(got["note"]["value"].as_str().unwrap());
        offset = got["note"]["nextOffset"].as_u64().map(|n| n as usize);
    }
    assert_eq!(rebuilt, big);
}

#[test]
fn team_directory_pages_many_workers() {
    let workers: Vec<(String, &str)> = (0..3000).map(|i| (format!("w{i}"), "running")).collect();
    let statuses: Vec<(&str, &str)> = workers.iter().map(|(id, s)| (id.as_str(), *s)).collect();
    let (state, parent) = team(&statuses);
    let a = as_worker("w0");
    let mut seen = 0;
    let mut offset = Some(0);
    let mut pages = 0;
    while let Some(at) = offset {
        let page = call(&state, &parent, &a, "pandacode_team_directory", json!({"offset":at})).unwrap();
        assert!(serde_json::to_string(&page["workers"]).unwrap().len() <= PAGE_BYTES + 256);
        seen += page["workers"].as_array().unwrap().len();
        offset = page["nextOffset"].as_u64().map(|n| n as usize);
        pages += 1;
    }
    assert!(pages >= 2);
    assert_eq!(seen, 3000);
}

#[test]
fn briefs_carry_message_previews_and_stay_small() {
    let (state, parent) = team(&[("a", "running"), ("b", "running")]);
    let (a, b) = (as_worker("a"), as_worker("b"));
    for i in 0..8 {
        send(&state, &parent, &a, json!({"recipient":"b","key":format!("k{i}"),"message":format!("{i}:{}", "m".repeat(100 * 1024))})).unwrap();
    }
    let store = state.store.lock().unwrap();
    let snapshot = load(&store, &parent).unwrap().unwrap();
    let (full, seen) = context(&store, &snapshot, &b, 0, true).unwrap();
    assert!(full.len() < 4 * 1024, "{} bytes", full.len());
    assert!(full.contains("\"preview\":\"7:") && full.contains("\"preview\":\"2:") && !full.contains("\"preview\":\"1:"), "the newest six, as previews: {full}");
    assert!(full.contains("read them with read_team_mailbox"));
    // Previews do not count as read: the digest keeps pointing at them.
    assert_eq!(cursor(&store, &parent, "b").unwrap(), 0);
    assert_eq!(digest(&store, &parent, "b").unwrap().unwrap()["unread"], 8);
    // The next brief lists only what came after.
    let (delta, _) = context(&store, &snapshot, &b, seen, false).unwrap();
    assert!(delta.is_empty(), "{delta}");
}
