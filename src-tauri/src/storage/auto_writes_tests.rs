use super::*;
fn empty_session() -> (Store, Session) {
    let store = Store::open(Path::new(":memory:")).unwrap();
    let p = store.add_project(&std::env::temp_dir()).unwrap();
    let s = store
        .create_session(&p.id, "claude", "sonnet", "auto")
        .unwrap();
    (store, s)
}
/// Schema 38 carries the per-task auto_writes flag: NOT NULL, default 0,
/// and a CHECK that admits only 0 or 1.
#[test]
fn auto_writes_column_arrives_in_the_newest_schema_with_default_zero_and_a_strict_check() {
    let (store, session) = empty_session();
    assert_eq!(
        SCHEMA_VERSION, 38,
        "the newest schema introduces sessions.auto_writes"
    );
    let version: i64 = store
        .db
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap();
    assert_eq!(version, 38);
    let (notnull, default): (i64, Option<String>) = store
            .db
            .query_row(
                "SELECT \"notnull\", dflt_value FROM pragma_table_info('sessions') WHERE name='auto_writes'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
    assert_eq!((notnull, default.as_deref()), (1, Some("0")));
    let stored: i64 = store
        .db
        .query_row(
            "SELECT auto_writes FROM sessions WHERE id=?1",
            [&session.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(stored, 0, "existing rows default to off");
    assert!(!store.session(&session.id).unwrap().auto_writes);
    let invalid = store
        .db
        .execute(
            "UPDATE sessions SET auto_writes=2 WHERE id=?1",
            params![session.id],
        )
        .err()
        .map(|error| error.to_string());
    assert!(
        invalid
            .as_deref()
            .is_some_and(|error| error.contains("CHECK")),
        "only 0 and 1 are storable, got {invalid:?}"
    );
}

/// Both SELECT lists map the column onto the session card, serialized as
/// autoWrites for the frontend.
#[test]
fn auto_writes_maps_from_the_column_into_session_cards() {
    let (store, session) = empty_session();
    store
        .db
        .execute(
            "UPDATE sessions SET auto_writes=1 WHERE id=?1",
            params![session.id],
        )
        .unwrap();
    let loaded = store.session(&session.id).unwrap();
    assert!(loaded.auto_writes, "session() maps the column");
    let listed = store.sessions().unwrap();
    assert!(
        listed
            .iter()
            .any(|task| task.id == session.id && task.auto_writes),
        "sessions() maps the column"
    );
    assert_eq!(
        serde_json::to_value(&loaded).unwrap()["autoWrites"],
        serde_json::json!(true)
    );
}

/// A database left before the column existed still receives it, with its
/// rows off, through the guarded ALTER path.
#[test]
fn auto_writes_column_is_added_to_an_older_database() {
    let dir = std::env::temp_dir().join(format!("pandacode-writes-{}", id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("writes.db");
    let sid = {
        let store = Store::open(&path).unwrap();
        let project = store.add_project(&std::env::temp_dir()).unwrap();
        let task = store
            .create_session(&project.id, "claude", "sonnet", "ask")
            .unwrap();
        store
            .db
            .execute_batch("ALTER TABLE sessions DROP COLUMN auto_writes; PRAGMA user_version=37;")
            .unwrap();
        task.id
    };
    let reopened = Store::open(&path).unwrap();
    let version: i64 = reopened
        .db
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap();
    assert_eq!(version, SCHEMA_VERSION);
    let (notnull, default): (i64, Option<String>) = reopened
            .db
            .query_row(
                "SELECT \"notnull\", dflt_value FROM pragma_table_info('sessions') WHERE name='auto_writes'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
    assert_eq!((notnull, default.as_deref()), (1, Some("0")));
    let stored: i64 = reopened
        .db
        .query_row(
            "SELECT auto_writes FROM sessions WHERE id=?1",
            [&sid],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(stored, 0, "migrated rows keep the toggle off");
    assert!(!reopened.session(&sid).unwrap().auto_writes);
    drop(reopened);
    std::fs::remove_dir_all(dir).unwrap();
}

/// Extending the running guard to the toggle must not loosen it for model
/// and mode changes.
#[test]
fn auto_writes_leaves_the_model_and_mode_running_guard_intact() {
    let (store, session) = empty_session();
    store.status(&session.id, "running").unwrap();
    let refused = store
        .update(
            &session.id,
            None,
            None,
            Some("sonnet".into()),
            Some("ask".into()),
            None,
        )
        .unwrap_err();
    assert!(refused.contains("Stop the agent"), "{refused}");
    store.status(&session.id, "idle").unwrap();
    store
        .update(
            &session.id,
            None,
            None,
            Some("sonnet".into()),
            Some("ask".into()),
            None,
        )
        .unwrap();
}
