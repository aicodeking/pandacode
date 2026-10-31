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
fn notes_set_get_list_delete_limit_and_brief() {
    let (state, parent) = team(&[("a", "running"), ("b", "running")]);
    let (a, b) = (as_worker("a"), as_worker("b"));
    let notes = |actor: &Actor, args: Value| call(&state, &parent, actor, "pandacode_team_notes", args);
    notes(&a, json!({"action":"set","key":"api.widget","value":"Widget { id, title }"})).unwrap();
    let got = notes(&b, json!({"action":"get","key":"api.widget"})).unwrap();
    assert_eq!((got["note"]["value"].as_str(), got["note"]["author"].as_str()), (Some("Widget { id, title }"), Some("a")));
    assert_eq!(notes(&Actor::Architect, json!({"action":"list"})).unwrap()["notes"].as_array().unwrap().len(), 1);
    assert!(notes(&a, json!({"action":"set","key":"bad key","value":"x"})).is_err());
    assert!(notes(&a, json!({"action":"set","key":"big","value":"x".repeat(1025)})).is_err());
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
    assert!(notes(&a, json!({"action":"set","key":"k64","value":"v"})).is_err());
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
        assert_eq!(sent["delivered"], "steered");
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
