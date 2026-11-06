// Store::update auto-approve-writes toggle (issue #200): setting and clearing
// the flag, and the refusal while a task is running or waiting. Wired as
// `mod auto_writes_update_tests` next to the sidebar tests in storage.rs.
use super::*;

fn task() -> (Store, Session) {
    let store = Store::open(Path::new(":memory:")).unwrap();
    let project = store.add_project(&std::env::temp_dir()).unwrap();
    let session = store
        .create_session(&project.id, "claude", "sonnet", "ask")
        .unwrap();
    (store, session)
}

fn stored_flag(store: &Store, sid: &str) -> i64 {
    store
        .db
        .query_row("SELECT auto_writes FROM sessions WHERE id=?1", [sid], |row| {
            row.get(0)
        })
        .unwrap()
}

/// The toggle is a plain per-task setting: set it, clear it, and leave it
/// alone when the update does not mention it.
#[test]
fn auto_writes_updates_set_and_clear_the_flag() {
    let (store, session) = task();
    store
        .update(&session.id, None, None, None, None, Some(true))
        .unwrap();
    assert_eq!(stored_flag(&store, &session.id), 1);
    assert!(store.session(&session.id).unwrap().auto_writes);
    store
        .update(&session.id, None, None, None, None, Some(false))
        .unwrap();
    assert_eq!(stored_flag(&store, &session.id), 0);
    assert!(!store.session(&session.id).unwrap().auto_writes);
    // An update about something else never touches the toggle.
    store
        .update(&session.id, Some("Renamed".into()), None, None, None, None)
        .unwrap();
    assert_eq!(stored_flag(&store, &session.id), 0);
}

/// A running or waiting task keeps its approval posture: the toggle refuses
/// exactly like a model or mode change, and the row stays off.
#[test]
fn auto_writes_updates_are_refused_while_the_task_runs() {
    let (store, session) = task();
    for status in ["running", "waiting"] {
        store.status(&session.id, status).unwrap();
        let refused = store
            .update(&session.id, None, None, None, None, Some(true))
            .unwrap_err();
        assert!(refused.contains("Stop the agent"), "{status}: {refused}");
        assert_eq!(stored_flag(&store, &session.id), 0, "{status} keeps the flag off");
    }
    store.status(&session.id, "idle").unwrap();
    store
        .update(&session.id, None, None, None, None, Some(true))
        .unwrap();
    assert_eq!(stored_flag(&store, &session.id), 1);
}
