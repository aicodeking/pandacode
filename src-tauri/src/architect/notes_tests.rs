use super::*;
use crate::architect::tests::{clean_turn, resumed_lead};
use crate::architect::{completed_state, prompt};

#[test]
fn failed_delta_keeps_owed_previews_and_new_notes_until_accepted() {
    let (state, sid, admission) = resumed_lead();
    let store = state.store.lock().unwrap();
    ensure(&store).unwrap();
    let old = format!("Old fact. {}", "a".repeat(1200));
    let mid = format!("Mid fact. {}", "d".repeat(1200));
    let new = format!("New fact. {}", "b".repeat(1200));
    for (key, value) in [("old", &old), ("mid", &mid), ("new", &new)] {
        tool(&store, &sid, "w1", json!({"action":"set","key":key,"value":value})).unwrap();
    }
    let launch = clean_turn(&store, &sid, "Build the parser", &admission);
    assert!(launch.contains(&new) && launch.contains(&mid) && !launch.contains(&old), "{launch}");
    assert!(launch.contains("1 cut to previews"), "{launch}");

    // Also add a new note before the delta turn.
    let late = "Late fact. Use port 4123.";
    tool(&store, &sid, "w1", json!({"action":"set","key":"late","value":late})).unwrap();

    // Build delta: includes both the owed preview (`old`) and the newly added note (`late`).
    let delta = prompt(&store, &sid, "Next", Some(&admission)).unwrap();
    assert!(delta.contains(&format!("- old (w1): {old}")), "{delta}");
    assert!(delta.contains(&format!("- late (w1): {late}")), "{delta}");

    // Launch fails before the actor sees the delta.
    super::super::brief_refused(&admission.parent, &sid);

    // Retry delta must still deliver both the owed preview and the new note in full.
    let retry = prompt(&store, &sid, "Retry", Some(&admission)).unwrap();
    assert!(retry.contains(&format!("- old (w1): {old}")), "retry lost owed preview: {retry}");
    assert!(retry.contains(&format!("- late (w1): {late}")), "retry lost new note: {retry}");

    // Once accepted, the next delta does not repeat them.
    super::super::brief_accepted(&store, &admission.parent, &sid).unwrap();
    let after = clean_turn(&store, &sid, "After", &admission);
    assert!(!after.contains("Old fact.") && !after.contains(late), "after repeated delivered notes: {after}");
}

#[test]
fn completed_state_commits_notes_only_on_clean_end() {
    let (state, sid, admission) = resumed_lead();
    let old = format!("Old fact. {}", "a".repeat(1200));
    let mid = format!("Mid fact. {}", "d".repeat(1200));
    let new = format!("New fact. {}", "b".repeat(1200));
    {
        let store = state.store.lock().unwrap();
        ensure(&store).unwrap();
        for (key, value) in [("old", &old), ("mid", &mid), ("new", &new)] {
            tool(&store, &sid, "w1", json!({"action":"set","key":key,"value":value})).unwrap();
        }
        clean_turn(&store, &sid, "Build the parser", &admission);
        let delta = prompt(&store, &sid, "Next", Some(&admission)).unwrap();
        assert!(delta.contains(&old), "{delta}");
    }

    // Failed run and stopped run both discard staged note delivery.
    completed_state(&state, &sid, Some(&admission), false, false, &mut |_| {});
    {
        let store = state.store.lock().unwrap();
        let retry = prompt(&store, &sid, "Retry failed", Some(&admission)).unwrap();
        assert!(retry.contains(&old), "failed completed_state lost owed preview: {retry}");
    }
    completed_state(&state, &sid, Some(&admission), true, true, &mut |_| {});
    {
        let store = state.store.lock().unwrap();
        let retry = prompt(&store, &sid, "Retry stopped", Some(&admission)).unwrap();
        assert!(retry.contains(&old), "stopped completed_state lost owed preview: {retry}");
    }

    // Clean run commits note delivery.
    completed_state(&state, &sid, Some(&admission), true, false, &mut |_| {});
    {
        let store = state.store.lock().unwrap();
        let after = clean_turn(&store, &sid, "After", &admission);
        assert!(!after.contains(&old), "clean completed_state repeated delivered preview: {after}");
    }
}

fn notes_seen(store: &Store, parent: &str, actor: &str) -> i64 {
    store
        .db
        .query_row("SELECT notes_seen FROM architect_mailbox_cursors WHERE parent_session_id=?1 AND actor=?2", params![parent, actor], |r| r.get(0))
        .optional()
        .unwrap()
        .unwrap_or(0)
}

fn pending_preview_keys(store: &Store, parent: &str, actor: &str) -> Vec<String> {
    let mut q = store.db.prepare("SELECT key FROM architect_note_previews WHERE parent_session_id=?1 AND actor=?2 ORDER BY key").unwrap();
    q.query_map(params![parent, actor], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect()
}

#[test]
fn brief_context_is_side_effect_free_until_accepted_and_get_updates_staged_launch() {
    let (state, sid, admission) = resumed_lead();
    let store = state.store.lock().unwrap();
    ensure(&store).unwrap();
    let old = format!("Old fact. {}", "a".repeat(1200));
    let fetched = format!("Fetched fact. {}", "c".repeat(1200));
    let mid = format!("Mid fact. {}", "d".repeat(1200));
    let new = format!("New fact. {}", "b".repeat(1200));
    for (key, value) in [("old", &old), ("fetched", &fetched), ("mid", &mid), ("new", &new)] {
        tool(&store, &sid, "w1", json!({"action":"set","key":key,"value":value})).unwrap();
    }

    // Building the launch brief leaves notes_seen and architect_note_previews untouched.
    let launch = prompt(&store, &sid, "Build", Some(&admission)).unwrap();
    assert!(launch.contains(&new) && launch.contains(&mid) && !launch.contains(&old) && !launch.contains(&fetched));
    assert_eq!(notes_seen(&store, &sid, "architect"), 0);
    assert!(pending_preview_keys(&store, &sid, "architect").is_empty());

    // Fetching a previewed note during the in-flight Fresh turn prevents brief_accepted from re-inserting it.
    let got = tool(&store, &sid, "architect", json!({"action":"get","key":"fetched"})).unwrap();
    assert_eq!(got["note"]["value"], fetched);
    super::super::brief_accepted(&store, &admission.parent, &sid).unwrap();
    assert_eq!(notes_seen(&store, &sid, "architect"), 4);
    assert_eq!(pending_preview_keys(&store, &sid, "architect"), vec!["old"]);

    // New note before delta; building delta does not advance cursor or clear `old` yet.
    tool(&store, &sid, "w1", json!({"action":"set","key":"late","value":"Late fact"})).unwrap();
    let delta = prompt(&store, &sid, "Next", Some(&admission)).unwrap();
    assert!(delta.contains(&old) && delta.contains("Late fact"));
    assert_eq!(notes_seen(&store, &sid, "architect"), 4);
    assert_eq!(pending_preview_keys(&store, &sid, "architect"), vec!["old"]);

    // Refusal discards staged cursor and preview clear; acceptance commits both.
    super::super::brief_refused(&admission.parent, &sid);
    assert_eq!(notes_seen(&store, &sid, "architect"), 4);
    assert_eq!(pending_preview_keys(&store, &sid, "architect"), vec!["old"]);

    let retry = prompt(&store, &sid, "Retry", Some(&admission)).unwrap();
    assert!(retry.contains(&old) && retry.contains("Late fact"));
    super::super::brief_accepted(&store, &admission.parent, &sid).unwrap();
    assert_eq!(notes_seen(&store, &sid, "architect"), 5);
    assert!(pending_preview_keys(&store, &sid, "architect").is_empty());
}

#[test]
fn forget_drops_staged_notes_of_deleted_teams_and_conversations_only() {
    let tag = uuid::Uuid::new_v4().simple().to_string();
    let id = |name: &str| format!("{name}-{tag}");
    let keys = [(id("team"), id("worker")), (id("other-team"), id("team")), (id("other-team"), id("kept"))];
    for (parent, sid) in &keys {
        super::super::pending_notes().insert(
            (parent.clone(), sid.clone()),
            Staged { actor: "architect".into(), newest: 1, previews: PreviewTransition::Clear(Vec::new()) },
        );
    }
    super::super::forget(&[id("team")]);
    for (index, key) in keys.iter().enumerate() {
        assert_eq!(super::super::pending_notes().contains_key(key), index == 2);
    }
    super::super::forget(&[id("kept")]);
}
