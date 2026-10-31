use super::super::{config::Link, crypto, tests::device, Inner};
use super::*;
use crate::storage::Store;
use std::path::Path;

fn store() -> (Store, String, String) {
    let store = Store::open(Path::new(":memory:")).unwrap();
    let project = store.add_project(&std::env::temp_dir()).unwrap();
    let parent = store.create_session(&project.id, "claude", "sonnet", "full").unwrap().id;
    (store, project.id, parent)
}

fn child(store: &Store, project: &str, parent: &str, status: &str) -> String {
    let id = store.create_session(project, "codex", "gpt", "ask").unwrap().id;
    store.db.execute("UPDATE sessions SET remote_device='studio',remote_session=?2,status=?3 WHERE id=?1", rusqlite::params![id, format!("h-{id}"), status]).unwrap();
    record_child(store, parent, &id).unwrap();
    id
}

/// Every test device's public key.
fn key() -> String {
    static KEY: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    KEY.get_or_init(|| crypto::public_key(&crypto::generate())).clone()
}

/// A link given under the test devices' current key.
fn linked(access: Access) -> Link {
    Link { access, at: 1, key: key() }
}

fn inner() -> Inner {
    let key = key();
    let mut inner = Inner { devices: vec![device("me", "This Mac", &key), device("studio", "ProMini", &key), device("laptop", "promini", &key), device("box", "Box", &key)], token: Some("t".into()), ..Default::default() };
    inner.settings.device_id = "me".into();
    inner.settings.orchestration = true;
    inner
}

#[test]
fn a_child_runs_in_full_access_only_when_link_and_parent_both_allow_it() {
    for (access, parent, expected) in [
        (Access::Full, "full", "full"),
        (Access::Full, "ask", "ask"),
        (Access::Full, "auto", "ask"),
        (Access::Ask, "full", "ask"),
        (Access::Ask, "ask", "ask"),
        (Access::Ask, "auto", "ask"),
    ] {
        assert_eq!(child_mode(access, parent), Ok(expected), "{access:?} link, {parent} parent");
    }
    for access in [Access::Ask, Access::Full] {
        assert!(child_mode(access, "plan").unwrap_err().contains("plan mode"), "a planning task launches nothing");
    }
    assert!(links::need(Some(Access::Read), Access::Ask, "ProMini").unwrap_err().contains("read only"));
    assert!(links::need(None, Access::Read, "ProMini").unwrap_err().contains("not linked"));
    assert_eq!(links::need(Some(Access::Full), Access::Ask, "ProMini"), Ok(Access::Full));
}

#[test]
fn the_mode_is_decided_again_at_the_commit_point() {
    let (store, _, parent) = store();
    let mut inner = inner();
    let link = linked;
    inner.settings.links.insert("studio".into(), link(Access::Full));
    assert_eq!(commit_mode(&inner, &store, &parent, "studio"), Ok("full"));
    // The parent left Full access during the launch's awaits: the thread asks.
    store.db.execute("UPDATE sessions SET mode='ask' WHERE id=?1", [&parent]).unwrap();
    assert_eq!(commit_mode(&inner, &store, &parent, "studio"), Ok("ask"));
    store.db.execute("UPDATE sessions SET mode='plan' WHERE id=?1", [&parent]).unwrap();
    assert!(commit_mode(&inner, &store, &parent, "studio").is_err());
    store.db.execute("UPDATE sessions SET mode='full' WHERE id=?1", [&parent]).unwrap();
    // The link was lowered or removed meanwhile: refused.
    inner.settings.links.insert("studio".into(), link(Access::Read));
    assert!(commit_mode(&inner, &store, &parent, "studio").unwrap_err().contains("read only"));
    inner.settings.links.clear();
    assert!(commit_mode(&inner, &store, &parent, "studio").unwrap_err().contains("not linked"));
    inner.settings.links.insert("studio".into(), link(Access::Ask));
    assert_eq!(commit_mode(&inner, &store, &parent, "studio"), Ok("ask"));
    inner.settings.orchestration = false;
    assert!(commit_mode(&inner, &store, &parent, "studio").is_err(), "turned off meanwhile");
}

#[test]
fn a_full_access_thread_is_messaged_only_over_a_full_link() {
    let (store, project, parent) = store();
    let id = child(&store, &project, &parent, "idle");
    let mut thread = threads::own(&store, &parent, &id).unwrap();
    assert_eq!(to_message(&thread), Access::Ask);
    thread.mode = "full".into();
    assert_eq!(to_message(&thread), Access::Full);
    assert!(links::need(Some(Access::Ask), to_message(&thread), "ProMini").is_err());
}

#[test]
fn team_tasks_never_get_the_machine_tools() {
    assert!(offered(false, true, || true));
    assert!(!offered(true, true, || true), "architects and workers");
    assert!(!offered(false, false, || true));
    assert!(!offered(false, true, || false));
}

#[test]
fn links_count_only_while_the_device_is_a_target() {
    let mut inner = inner();
    inner.settings.links.insert("studio".into(), linked(Access::Full));
    inner.settings.links.insert("box".into(), Link { key: crypto::public_key(&crypto::generate()), ..linked(Access::Ask) });
    let studio = inner.devices[1].clone();
    assert_eq!(links::access(&inner, &studio), Some(Access::Full));
    assert_eq!(links::access(&inner, &inner.devices[3].clone()), None, "a link given to another key does not count");
    inner.devices[1].host = false;
    assert_eq!(links::access(&inner, &inner.devices[1].clone()), None, "nor one with remote control off");
    let status = links::status_of(&inner);
    assert_eq!(status["enabled"], true);
    assert_eq!(status["links"], json!([]));
    inner.devices[1].host = true;
    assert_eq!(links::status_of(&inner)["links"], json!([{"deviceId": "studio", "name": "ProMini", "platform": "", "online": true, "access": "full"}]));
    // Gates: orchestration on and signed in.
    assert_eq!(links::ready(&inner), Ok(()));
    inner.token = None;
    assert!(links::ready(&inner).is_err());
    inner.token = Some("t".into());
    inner.settings.orchestration = false;
    assert!(links::ready(&inner).unwrap_err().contains("off"));
}

#[test]
fn machines_resolve_by_id_or_unique_name() {
    let inner = inner();
    assert_eq!(links::resolve(&inner, "studio").unwrap().id, "studio");
    assert_eq!(links::resolve(&inner, "BOX").unwrap().id, "box");
    assert!(links::resolve(&inner, "promini").unwrap_err().contains("Several"));
    assert!(links::resolve(&inner, "me").is_err(), "never this computer");
    assert!(links::resolve(&inner, "This Mac").is_err());
    assert!(links::resolve(&inner, "").is_err());
}

#[test]
fn only_a_tasks_own_threads_are_in_scope() {
    let (store, project, parent) = store();
    let other = store.create_session(&project, "claude", "sonnet", "full").unwrap().id;
    let mine = child(&store, &project, &parent, "running");
    let theirs = child(&store, &project, &other, "running");
    assert_eq!(threads::own(&store, &parent, &mine).unwrap().device, "studio");
    assert!(threads::own(&store, &parent, &theirs).unwrap_err().contains("not launched by this task"));
    // A mirror nobody here launched (the host's own task, say) is out of scope too.
    let plain = store.create_session(&project, "claude", "sonnet", "full").unwrap().id;
    store.db.execute("UPDATE sessions SET remote_device='studio',remote_session='own' WHERE id=?1", [&plain]).unwrap();
    assert!(threads::own(&store, &parent, &plain).is_err());
    assert_eq!(threads::active_children(&store, &parent).unwrap().iter().map(|c| c.id.clone()).collect::<Vec<_>>(), vec![mine.clone()]);
    // The transcript's lookup skips ids that are not this task's threads.
    let asked = vec![theirs.clone(), mine.clone(), plain, "missing".into()];
    assert_eq!(threads::some_children(&store, &parent, &asked).unwrap().into_iter().map(|c| c.id).collect::<Vec<_>>(), vec![mine]);
}

#[test]
fn a_task_runs_at_most_eight_threads() {
    let (store, project, parent) = store();
    for _ in 0..threads::MAX_RUNNING {
        child(&store, &project, &parent, "running");
    }
    assert!(check_capacity(&store, &parent).unwrap_err().contains("8 running"));
    store.db.execute("UPDATE sessions SET status='idle' WHERE id=(SELECT session_id FROM machine_threads LIMIT 1)", []).unwrap();
    assert_eq!(check_capacity(&store, &parent), Ok(()));
}

#[test]
fn version_36_adds_machine_threads() {
    let path = std::env::temp_dir().join(format!("pandacode-orchestrate-{}.sqlite3", uuid::Uuid::new_v4()));
    {
        let store = Store::open(&path).unwrap();
        store.db.execute_batch("DROP TABLE machine_threads; ALTER TABLE sessions DROP COLUMN restart_interrupted; ALTER TABLE sessions DROP COLUMN stop_requested; PRAGMA user_version=35;").unwrap();
    }
    let store = Store::open(&path).unwrap();
    assert_eq!((crate::storage::SCHEMA_VERSION, store.db.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0)).unwrap()), (36, 36));
    let columns: i64 = store.db.query_row("SELECT (SELECT COUNT(*) FROM pragma_table_info('sessions') WHERE name IN ('restart_interrupted','stop_requested'))+(SELECT COUNT(*) FROM pragma_table_info('machine_threads') WHERE name='reported_by')", [], |r| r.get(0)).unwrap();
    assert_eq!(columns, 3);
    // Running the step again (a half-applied upgrade) changes nothing.
    store.db.execute_batch("PRAGMA user_version=35;").unwrap();
    drop(store);
    let store = Store::open(&path).unwrap();
    assert_eq!(store.db.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0)).unwrap(), 36);
    let indexed: bool = store.db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='index' AND name='machine_threads_parent')", [], |r| r.get(0)).unwrap();
    assert!(indexed);
    let project = store.add_project(&std::env::temp_dir()).unwrap();
    let parent = store.create_session(&project.id, "claude", "sonnet", "full").unwrap().id;
    let thread = child(&store, &project.id, &parent, "running");
    // Deleting the parent removes its rows.
    store.db.execute("DELETE FROM sessions WHERE id=?1", [&parent]).unwrap();
    assert_eq!(threads::parent_of(&store, &thread), None);
    drop(store);
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
    }
}

#[test]
fn the_catalog_validates_arguments() {
    let tools = catalog();
    assert_eq!(tools.len(), 8);
    let ok = |name: &str, args: Value| validate_spec(tools, name, &args).is_ok();
    assert!(ok("pandacode_machine_list", json!({})));
    assert!(ok("pandacode_machine_link", json!({"reason": "Run the Linux tests"})));
    assert!(!ok("pandacode_machine_link", json!({})));
    assert!(ok("pandacode_machine_launch", json!({"machine": "ProMini", "prompt": "Run tests", "provider": "codex", "model": "gpt-5", "worktree": false})));
    assert!(!ok("pandacode_machine_launch", json!({"machine": "ProMini", "prompt": "x", "provider": "bash", "model": "m"})), "providers are an enum");
    assert!(!ok("pandacode_machine_launch", json!({"machine": "ProMini", "prompt": "x", "provider": "codex", "model": "m", "mode": "full"})), "the agent never picks the mode");
    assert!(ok("pandacode_machine_wait", json!({"threads": ["a", "b"], "timeoutSeconds": 30})));
    assert!(!ok("pandacode_machine_wait", json!({"threads": [1]})));
    assert!(!ok("pandacode_machine_wait", json!({"threads": vec!["a"; 21]})));
    assert!(ok("pandacode_machine_message", json!({"thread": "t", "action": "steer", "text": "Also lint"})));
    assert!(!ok("pandacode_machine_message", json!({"thread": "t", "action": "delete", "text": "x"})));
    assert!(!ok("pandacode_machine_message", json!({"thread": "t", "action": "stop", "text": "x"})), "stop is its own tool");
    assert!(ok("pandacode_machine_stop", json!({"thread": "t"})));
    assert!(!APPROVAL.contains(&"pandacode_machine_stop"), "stopping needs no approval");
    assert!(!ok("pandacode_machine_read", json!({"thread": "t", "beforeId": -1})));
    assert!(APPROVAL.iter().all(|name| tools.iter().any(|t| t["name"] == *name)));
    assert!(tools.iter().filter(|t| ["pandacode_machine_wait", "pandacode_machine_read"].contains(&t["name"].as_str().unwrap())).all(|t| t["description"].as_str().unwrap().contains("untrusted")));
}

fn claim(store: &Store, parent: &str) -> Option<(String, Vec<String>)> {
    threads::claim(store, parent, |_| "ProMini".to_string()).unwrap()
}

#[test]
fn a_parent_wakes_once_after_its_last_thread_settles() {
    let (store, project, parent) = store();
    let first = child(&store, &project, &parent, "idle");
    let second = child(&store, &project, &parent, "running");
    store.db.execute("UPDATE sessions SET title='Linux tests' WHERE id=?1", [&first]).unwrap();
    store.message(&first, "assistant", &format!("All green.{}", "x".repeat(4096))).unwrap();
    assert_eq!(claim(&store, &parent), None, "a thread still runs");
    store.db.execute("UPDATE sessions SET status='error' WHERE id=?1", [&second]).unwrap();
    store.db.execute("UPDATE sessions SET status='running' WHERE id=?1", [&parent]).unwrap();
    assert_eq!(claim(&store, &parent), None, "a running parent wakes at its run end");
    store.db.execute("UPDATE sessions SET status='interrupted' WHERE id=?1", [&parent]).unwrap();
    assert_eq!(claim(&store, &parent), None, "a stopped parent is not woken");
    store.db.execute("UPDATE sessions SET status='idle',task_stage='completed' WHERE id=?1", [&parent]).unwrap();
    assert_eq!(claim(&store, &parent), None, "a completed parent waits until it is reopened");
    store.db.execute("UPDATE sessions SET task_stage='in_progress' WHERE id=?1", [&parent]).unwrap();
    let (text, ids) = claim(&store, &parent).unwrap();
    assert_eq!(ids, vec![first.clone(), second.clone()]);
    assert!(text.contains("untrusted"));
    assert!(text.contains("1. \"Linux tests\" on ProMini: idle\nFinal reply:\nAll green."));
    assert!(text.contains("2. \"New conversation\" on ProMini: error\nNo reply."));
    let excerpt = text.split("Final reply:\n").nth(1).unwrap().split('\n').next().unwrap();
    assert!(excerpt.len() <= 2 * 1024 + "…".len(), "excerpts are bounded");
    // Claiming marks nothing: a wake that never started is still due (at startup, say).
    assert!(claim(&store, &parent).is_some());
    assert_eq!(threads::unreported_parents(&store).unwrap(), vec![parent.clone()]);
    // The turn that carries the message marks them, in its own transaction.
    let kind = Some(CoordinationKind::MachineThreads);
    assert!(store.begin_task_turn_reporting(&parent, "", kind, &ids).is_err());
    assert!(claim(&store, &parent).is_some(), "a turn that failed to save reports nothing");
    store.begin_task_turn_reporting(&parent, &text, kind, &ids).unwrap();
    store.finish_task_turn(&parent, true, false).unwrap();
    assert_eq!(claim(&store, &parent), None, "each thread is reported once");
    assert!(threads::unreported_parents(&store).unwrap().is_empty());
    assert_eq!(store.messages(&parent, None).unwrap().last().unwrap().role, "coordination");
}

#[test]
fn queued_prompts_go_before_a_wake() {
    let (store, project, parent) = store();
    child(&store, &project, &parent, "idle");
    store.db.execute("INSERT INTO queued_messages(id,session_id,position,text,created_at,updated_at) VALUES('q',?1,0,'next',0,0)", [&parent]).unwrap();
    assert_eq!(claim(&store, &parent), None);
}

#[test]
fn the_lineage_lists_every_live_thread_and_the_newest_settled_ones() {
    let (store, project, parent) = store();
    let mut ids = Vec::new();
    for n in 0..30 {
        ids.push(child(&store, &project, &parent, if n == 0 || n == 29 { "running" } else { "idle" }));
    }
    let listed: Vec<String> = threads::lineage(&store, &parent).unwrap().into_iter().map(|c| c.id).collect();
    // The oldest (running) thread, then the 24 newest settled ones and the newest (running), oldest first.
    let mut expected = vec![ids[0].clone()];
    expected.extend(ids[5..30].iter().cloned());
    assert_eq!(listed, expected);
    assert_eq!(threads::SETTLED_SHOWN, 24);
}

#[tokio::test]
async fn lists_are_empty_while_orchestration_is_off() {
    links::insert_for_test("task-off");
    assert!(orchestration_pending_off().await.is_empty());
    links::cancel_for("task-off");
}

async fn orchestration_pending_off() -> Vec<Value> {
    assert!(!links::on());
    links::orchestration_pending().await
}

#[test]
fn exactly_one_answer_wins_a_link_request() {
    let (id, call) = links::join_for_test("task-d");
    let declined = json!({"linked": false, "reason": "The user declined."});
    assert!(!links::answer_for_test(&id, declined.clone()).unwrap(), "a call was waiting: no wake");
    assert_eq!(links::answer_for_test(&id, json!({"linked": true})), Err("This link request was already answered.".into()));
    assert_eq!(call(), Ok(declined), "the first answer is the one delivered");
    assert_eq!(claim_link("task-d"), None, "the call read it: no wake turn as well");
}

#[test]
fn every_call_joined_to_a_request_gets_its_answer() {
    let (id, first) = links::join_for_test("task-g");
    let (joined, second) = links::join_for_test("task-g");
    assert_eq!(id, joined);
    let linked = json!({"linked": true, "access": "ask"});
    assert!(!links::answer_for_test(&id, linked.clone()).unwrap());
    assert_eq!((first(), second()), (Ok(linked.clone()), Ok(linked)));
}

#[test]
fn a_call_leaving_while_the_answer_is_saved_still_gets_it() {
    let (id, call) = links::join_for_test("task-h");
    links::take_for_test(&id);
    // A call made while the answer is being saved joins the same request: no second card.
    let (joined, late) = links::join_for_test("task-h");
    assert_eq!(joined, id);
    assert!(!links::deliver_for_test(&id, json!({"linked": false, "reason": "x"})));
    assert_eq!(call().unwrap()["reason"], "x");
    assert_eq!(late().unwrap()["reason"], "x", "an answer that landed as the call left is not lost");
    // A request cancelled before any answer reads as cancelled, not pending.
    let (_, gone) = links::join_for_test("task-i");
    links::cancel_for("task-i");
    assert_eq!(gone(), Err(false));
}

#[test]
fn a_dropped_link_call_never_holds_back_the_wake() {
    // The client closed while waiting: the call no longer counts, so a later answer wakes.
    let (id, call) = links::join_for_test("task-x");
    drop(call);
    assert!(links::answer_for_test(&id, json!({"linked": true, "access": "ask"})).unwrap(), "nobody waits: wake the task");
    // The answer came while a call waited, then that call was dropped unread: wake for it.
    let (id, _call) = links::join_for_test("task-y");
    assert!(!links::answer_for_test(&id, json!({"linked": true, "access": "ask"})).unwrap());
    assert!(links::abandon_for_test("task-y", &id), "an unread answer left by a dropped call wakes the task");
    // Leave no unread answers behind for tests that scan them.
    assert!(links::take_answer("task-x").is_some() && links::take_answer("task-y").is_some());
}

#[test]
fn a_link_request_outlives_its_calls() {
    let id = links::insert_for_test("task-e");
    assert_eq!(links::insert_for_test("task-e"), id, "a second call joins the same request: no second card");
    assert_eq!(links::detach_for_test("task-e", &id), None);
    assert_eq!(links::detach_for_test("task-e", &id), None);
    assert!(links::pending_for_test(&id), "still waiting for the user after the calls ended");
    // Answered with no call waiting: the task is woken with the result, once.
    let result = json!({"linked": true, "machine": {"id": "studio", "name": "ProMini"}, "access": "ask"});
    assert!(links::answer_for_test(&id, result).unwrap());
    let (message, answer) = claim_link("task-e").unwrap();
    assert!(message.contains("linked ProMini with ask access"), "{message}");
    assert!(claim_link("task-e").is_some(), "unread until its wake turn is saved");
    link_claimed("task-e", &answer);
    assert_eq!(claim_link("task-e"), None);
    assert!(links::answer_message(&json!({"linked": false, "reason": "The user declined."})).contains("Nothing was linked: The user declined."));
}

#[test]
fn a_failed_answer_is_not_put_back_after_a_cancel_or_while_off() {
    let id = links::insert_for_test("task-f");
    assert!(!links::restore_for_test(&id, true), "cancelled meanwhile");
    assert!(!links::pending_for_test(&id));
    let id = links::insert_for_test("task-f");
    assert!(!links::restore_for_test(&id, false), "orchestration is off in tests");
    assert!(!links::pending_for_test(&id));
}

#[test]
fn turning_orchestration_on_reconciles_due_wakes() {
    let (reconciled, cancelled) = (std::cell::Cell::new(0), std::cell::Cell::new(0));
    links::toggled(true, || reconciled.set(reconciled.get() + 1), || cancelled.set(cancelled.get() + 1));
    assert_eq!((reconciled.get(), cancelled.get()), (1, 0));
    links::toggled(false, || reconciled.set(reconciled.get() + 1), || cancelled.set(cancelled.get() + 1));
    assert_eq!((reconciled.get(), cancelled.get()), (1, 1));
}

#[test]
fn every_machine_tool_answers_before_the_harness_gives_up() {
    let harness = Duration::from_secs(60);
    for tool in catalog() {
        let name = tool["name"].as_str().unwrap();
        assert!(deadline(name) < harness, "{name}");
    }
    assert!(Duration::from_secs(WAIT_MAX) < deadline("pandacode_machine_wait"));
    assert!(links::LINK_CALL < deadline("pandacode_machine_link"));
    assert!(links::LINK_TTL >= Duration::from_secs(10 * 60), "the request itself still waits 10 minutes");
}

#[test]
fn an_approved_launch_or_message_ends_before_the_harness_gives_up() {
    // Claude Code drops an HTTP MCP call after 300 s without data; Codex MCP after 360 s.
    let claude_idle = Duration::from_secs(300);
    for name in APPROVAL {
        let total = approval_wait(name).unwrap() + deadline(name);
        assert!(total < claude_idle, "{name}: {total:?}");
    }
    assert_eq!(approval_wait("pandacode_cloud_cli"), None, "other tools keep their own wait");
}

#[test]
fn a_thread_that_fails_to_start_stays_and_is_reported() {
    let (store, project, parent) = store();
    let thread = child(&store, &project, &parent, "running");
    store.db.execute("UPDATE sessions SET remote_session=NULL WHERE id=?1", [&thread]).unwrap();
    fail_start(&store, &thread, "Codex is not installed on ProMini.").unwrap();
    let kept = threads::own(&store, &parent, &thread).unwrap();
    assert_eq!(kept.status, "error");
    let (text, ids) = claim(&store, &parent).unwrap();
    assert_eq!(ids, vec![thread]);
    assert!(text.contains(": error\nFinal reply:\nThis thread could not start on the other computer: Codex is not installed on ProMini."), "{text}");
}

#[test]
fn a_wake_reads_only_a_bounded_batch() {
    let (store, project, parent) = store();
    for _ in 0..25 {
        child(&store, &project, &parent, "idle");
    }
    assert_eq!(claim(&store, &parent).unwrap().1.len(), 20);
}

#[tokio::test]
async fn a_wait_wakes_only_for_its_own_parents_threads() {
    let mine = threads::change_signal("parent-a");
    let woken = mine.notified();
    tokio::pin!(woken);
    woken.as_mut().enable();
    threads::notify_changed("parent-b");
    assert!(tokio::time::timeout(Duration::from_millis(50), &mut woken).await.is_err(), "another parent's thread");
    threads::notify_changed("parent-a");
    tokio::time::timeout(Duration::from_secs(1), woken).await.expect("its own thread");
}

#[test]
fn a_thread_in_error_does_not_hold_a_wait() {
    let (store, project, parent) = store();
    let running = threads::own(&store, &parent, &child(&store, &project, &parent, "running")).unwrap();
    let idle = threads::own(&store, &parent, &child(&store, &project, &parent, "waiting")).unwrap();
    let unlinked: Result<(Child, String)> = Err("ProMini is not linked".into());
    assert!(settled([unlinked.clone(), Ok((idle, "ProMini".into()))].iter()));
    assert!(!settled([unlinked, Ok((running, "ProMini".into()))].iter()));
}

#[test]
fn an_empty_message_does_not_end_a_page() {
    let row = |id: i64, content: &str| (id, "assistant".to_string(), content.to_string(), 0);
    let (messages, more) = page(vec![row(3, "newest"), row(2, ""), row(1, "oldest")]);
    assert_eq!(messages.iter().map(|m| m["id"].as_i64().unwrap()).collect::<Vec<_>>(), vec![1, 2, 3]);
    assert!(!more);
    // The budget still bounds a page.
    let big = "x".repeat(MESSAGE_BYTES);
    let rows: Vec<_> = (0..10).rev().map(|id| row(id, &big)).collect();
    let (messages, more) = page(rows);
    assert_eq!((messages.len(), more), (PAGE_BYTES / MESSAGE_BYTES, true));
    // No more rows: never hasMore, even when the page or the budget is exactly used up.
    let (messages, more) = page((0..4).rev().map(|id| row(id, &big)).collect());
    assert_eq!((messages.len(), more), (4, false));
    let (messages, more) = page((0..PAGE as i64).rev().map(|id| row(id, "x")).collect());
    assert_eq!((messages.len(), more), (PAGE, false));
    let (messages, more) = page((0..PAGE as i64 + 1).rev().map(|id| row(id, "x")).collect());
    assert_eq!((messages.len(), more), (PAGE, true));
}

#[test]
fn link_requests_end_when_their_task_stops() {
    let id = links::insert_for_test("task-a");
    let other = links::insert_for_test("task-b");
    assert_eq!(links::cancel_for("task-a"), vec![id.clone()]);
    assert!(!links::pending_for_test(&id));
    assert_eq!(links::detach_for_test("task-a", &id), None, "the wait sees no answer");
    assert!(links::pending_for_test(&other));
    assert!(links::cancel_for("task-a").is_empty());
    links::cancel_for("task-b");
}

#[tokio::test]
async fn a_stop_wakes_a_wait() {
    let signal = threads::stop_signal("task-c");
    let waiting = signal.notified();
    tokio::pin!(waiting);
    waiting.as_mut().enable();
    threads::notify_stopped("task-c");
    tokio::time::timeout(Duration::from_secs(1), waiting).await.expect("woken by the stop");
}

#[test]
fn a_wake_that_never_reached_its_agent_is_given_back_once() {
    let (store, project, parent) = store();
    let thread = child(&store, &project, &parent, "idle");
    let (text, ids) = claim(&store, &parent).unwrap();
    let kind = Some(CoordinationKind::MachineThreads);
    let turn = store.begin_task_turn_reporting(&parent, &text, kind, &ids).unwrap();
    store.finish_task_turn(&parent, false, false).unwrap();
    assert_eq!(claim(&store, &parent), None, "claimed by the turn");
    // The harness never started: nothing came after the wake, so it is due again.
    assert!(restore_wake(&store, &parent, turn).unwrap());
    assert!(!restore_wake(&store, &parent, turn).unwrap(), "given back once");
    let (_, again) = claim(&store, &parent).unwrap();
    assert_eq!(again, vec![thread.clone()]);
    // A wake the agent answered is never given back, so it is never delivered twice.
    let turn = store.begin_task_turn_reporting(&parent, &text, kind, &again).unwrap();
    store.message(&parent, "assistant", "Merged both branches.").unwrap();
    store.finish_task_turn(&parent, true, false).unwrap();
    assert!(!restore_wake(&store, &parent, turn).unwrap());
    assert_eq!(claim(&store, &parent), None);
    // Ordinary turns give nothing back.
    let plain = store.begin_task_turn(&parent, "hello").unwrap();
    store.finish_task_turn(&parent, false, false).unwrap();
    assert!(!restore_wake(&store, &parent, plain).unwrap());
}

#[test]
fn startup_gives_back_wakes_cut_off_by_a_quit() {
    let (store, project, parent) = store();
    child(&store, &project, &parent, "idle");
    let (text, ids) = claim(&store, &parent).unwrap();
    store.begin_task_turn_reporting(&parent, &text, Some(CoordinationKind::MachineThreads), &ids).unwrap();
    // A link answer's wake turn, also cut off.
    let other = store.create_session(&project, "claude", "sonnet", "ask").unwrap().id;
    let link = links::answer_message(&json!({"linked": true, "machine": {"name": "ProMini"}, "access": "ask"}));
    store.begin_task_turn_with_kind(&other, &link, Some(CoordinationKind::MachineLink)).unwrap();
    // Still running in this process: left alone.
    let running: std::collections::HashSet<String> = [parent.clone(), other.clone()].into();
    assert_eq!(recover_wakes(&store, &running).unwrap(), Vec::<String>::new());
    assert_eq!(threads::unreported_parents(&store).unwrap(), Vec::<String>::new());
    // After a quit the rows still read running, but no agent runs them.
    assert_eq!(recover_wakes(&store, &Default::default()).unwrap(), vec![other.clone()]);
    assert_eq!(threads::unreported_parents(&store).unwrap(), vec![parent.clone()]);
    let (message, answer) = claim_link(&other).unwrap();
    assert_eq!(message, link, "the same wake text is delivered again");
    link_claimed(&other, &answer);
    assert_eq!(recover_wakes(&store, &Default::default()).unwrap(), vec![other.clone()], "until a turn reaches the agent");
    link_claimed(&other, "restored");
    store.message(&other, "assistant", "Launching on ProMini.").unwrap();
    assert_eq!(recover_wakes(&store, &Default::default()).unwrap(), Vec::<String>::new());
}

#[test]
fn an_unread_answer_in_memory_is_delivered_by_recovery() {
    let (store, _, _) = store();
    let session = format!("task-{}", uuid::Uuid::new_v4());
    assert!(links::restore_answer(&session, "The user answered.".into()));
    assert!(recover_wakes(&store, &Default::default()).unwrap().contains(&session));
    let running: std::collections::HashSet<String> = [session.clone()].into();
    assert!(!recover_wakes(&store, &running).unwrap().contains(&session), "not while it runs");
    links::take_answer(&session);
}

#[test]
fn a_parent_interrupted_by_a_restart_still_wakes_but_one_the_user_stopped_does_not() {
    let path = std::env::temp_dir().join(format!("pandacode-restart-{}.sqlite3", uuid::Uuid::new_v4()));
    let (parent, thread) = {
        let store = Store::open(&path).unwrap();
        let project = store.add_project(&std::env::temp_dir()).unwrap();
        let parent = store.create_session(&project.id, "claude", "sonnet", "full").unwrap().id;
        let thread = child(&store, &project.id, &parent, "running");
        store.begin_task_turn(&parent, "launch the tests").unwrap();
        (parent, thread)
    };
    let store = Store::open(&path).unwrap();
    assert_eq!(store.session(&parent).unwrap().status, "interrupted");
    assert_eq!(store.session(&thread).unwrap().status, "running", "a mirror keeps its host's status");
    store.db.execute("UPDATE sessions SET status='idle' WHERE id=?1", [&thread]).unwrap();
    assert!(claim(&store, &parent).is_some(), "stopped by the restart, not the user");
    // A user's stop ends a turn the ordinary way: that parent is not woken.
    store.begin_task_turn(&parent, "again").unwrap();
    store.finish_task_turn(&parent, false, true).unwrap();
    assert_eq!(store.session(&parent).unwrap().status, "interrupted");
    assert_eq!(claim(&store, &parent), None);
    drop(store);
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
    }
}

#[test]
fn a_wait_shares_one_reply_budget() {
    assert_eq!(reply_share(1), threads::REPLY);
    for threads in [12, 20, 64] {
        assert!(threads * reply_share(threads) <= WAIT_REPLIES, "{threads}");
    }
    const { assert!(WAIT_REPLIES < 128 * 1024 - 16 * 1024, "room for the rest of the result") };
}

#[test]
fn a_wake_whose_run_cannot_start_leaves_no_second_message() {
    let (store, project, parent) = store();
    child(&store, &project, &parent, "idle");
    let (text, ids) = claim(&store, &parent).unwrap();
    let turn = store.begin_task_turn_reporting(&parent, &text, Some(CoordinationKind::MachineThreads), &ids).unwrap();
    abandon_wake(&store, &parent, turn).unwrap();
    let saved: i64 = store.db.query_row("SELECT COUNT(*) FROM messages WHERE session_id=?1 AND role='coordination'", [&parent], |r| r.get(0)).unwrap();
    assert_eq!(saved, 0, "the retry adds the only wake message");
    let (_, again) = claim(&store, &parent).expect("due again, and the task can be woken");
    assert_eq!(again, ids);
}

#[test]
fn a_quit_right_after_stop_does_not_make_the_parent_wakeable() {
    let path = std::env::temp_dir().join(format!("pandacode-stop-{}.sqlite3", uuid::Uuid::new_v4()));
    let parent = {
        let store = Store::open(&path).unwrap();
        let project = store.add_project(&std::env::temp_dir()).unwrap();
        let parent = store.create_session(&project.id, "claude", "sonnet", "full").unwrap().id;
        child(&store, &project.id, &parent, "idle");
        store.begin_task_turn(&parent, "launch the tests").unwrap();
        // Stop pressed; PandaCode quits before the run reports its end.
        store.request_stop(&parent).unwrap();
        parent
    };
    let store = Store::open(&path).unwrap();
    assert_eq!(store.session(&parent).unwrap().status, "interrupted");
    assert_eq!(claim(&store, &parent), None, "the user stopped it");
    // The next turn clears the stop, so a later restart counts again.
    store.begin_task_turn(&parent, "again").unwrap();
    drop(store);
    let store = Store::open(&path).unwrap();
    assert!(claim(&store, &parent).is_some(), "interrupted by the restart");
    drop(store);
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
    }
}

#[test]
fn a_wait_full_of_escapes_still_fits_the_host_result_limit() {
    let (store, project, parent) = store();
    let mut ids = Vec::new();
    for n in 0..20 {
        let id = child(&store, &project, &parent, "idle");
        // Quotes, backslashes and control characters grow up to six times when escaped.
        let reply: String = "\"\\\u{1}\n".repeat(threads::REPLY);
        store.message(&id, "assistant", &reply).unwrap();
        store.db.execute("UPDATE sessions SET title=?2 WHERE id=?1", rusqlite::params![id, format!("{n}{}", "\u{2}\"".repeat(32))]).unwrap();
        ids.push(id);
    }
    let result = fitted(reply_share(ids.len()), false, |share| {
        ids.iter().map(|id| {
            let title: String = store.db.query_row("SELECT title FROM sessions WHERE id=?1", [id], |r| r.get(0)).unwrap();
            json!({"thread": id, "title": title, "machine": {"id": "studio", "name": "ProMini"}, "status": "idle", "reply": threads::final_reply(&store, id, share)})
        }).collect()
    });
    let size = serde_json::to_vec(&result).unwrap().len();
    assert!(size <= 128 * 1024, "{size} bytes");
    assert!(result["threads"][0]["reply"].as_str().unwrap().len() > 1024, "replies are trimmed, not dropped");
}

#[test]
fn a_read_only_link_refuses_launch_and_message_even_in_full_access() {
    let (store, project, parent) = store();
    assert_eq!(store.session(&parent).unwrap().mode, "full", "no approval prompt: the link is the cap");
    let mut inner = inner();
    inner.settings.links.insert("studio".into(), linked(Access::Read));
    assert!(commit_mode(&inner, &store, &parent, "studio").unwrap_err().contains("read only"));
    let thread = child(&store, &project, &parent, "idle");
    let child = threads::own(&store, &parent, &thread).unwrap();
    assert!(links::need(Some(Access::Read), to_message(&child), "ProMini").unwrap_err().contains("read only"));
}

#[test]
fn startup_reads_link_wakes_by_index_not_every_message() {
    let (store, _, _) = store();
    let mut statement = store.db.prepare(&format!("EXPLAIN QUERY PLAN {LINK_WAKES}")).unwrap();
    let plan: Vec<String> = statement.query_map([], |r| r.get::<_, String>(3)).unwrap().map(|step| step.unwrap()).collect();
    // Messages are only searched by key, never scanned (with or without an index).
    assert!(!plan.iter().any(|step| step.starts_with("SCAN") && (step.contains("messages") || step.split_whitespace().nth(1) == Some("m"))), "{plan:?}");
    assert!(plan.iter().any(|step| step.starts_with("SEARCH messages USING COVERING INDEX messages_session")), "{plan:?}");
}
