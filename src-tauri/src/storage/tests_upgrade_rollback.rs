//! The released read-only contract and queries copied from v0.3.151 (52702085).
use super::*;

/// Stored paths canonicalized per launch lookup at most (`launch_project_at`).
const LAUNCH_CANDIDATES: usize = 64;

/// `[as given, resolved, then each one's last component after a / and after a \]`: a stored
/// path that names this folder another way (`..`, a trailing `.`) still ends in one of those.
fn launch_path_patterns(cwd: &Path, resolved: &Path) -> [String; 6] {
    let text = |p: &Path| p.to_string_lossy().into_owned();
    let suffix = |p: &Path, separator: char| {
        p.file_name().map_or_else(
            || text(p),
            |name| format!("{separator}{}", name.to_string_lossy()),
        )
    };
    [
        text(cwd),
        text(resolved),
        suffix(cwd, '/'),
        suffix(cwd, '\\'),
        suffix(resolved, '/'),
        suffix(resolved, '\\'),
    ]
}

struct ReleasedReader {
    db: Connection,
}

impl ReleasedReader {
    fn open_read_only(path: &Path) -> Result<Self> {
        let db = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|e| e.to_string())?;
        db.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|e| e.to_string())?;
        let version: i64 = db
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .map_err(|e| e.to_string())?;
        const RELEASED_SCHEMA_VERSION: i64 = 37;
        if version != RELEASED_SCHEMA_VERSION {
            return Err(format!("Database schema {version} differs from expected {RELEASED_SCHEMA_VERSION}; open PandaCode to migrate it."));
        }
        Ok(Self { db })
    }

    fn launch_session_project(&self, sid: &str) -> Result<Option<(String, String)>> {
        self.db.query_row(
            "SELECT p.id,p.path FROM sessions s JOIN projects p ON p.id=s.project_id WHERE s.id=?1",
            [sid], |r| Ok((r.get(0)?, r.get(1)?)),
        ).optional().map_err(|e| e.to_string())
    }

    /// The project a launch folder belongs to: a task worktree first, then a main checkout.
    /// SQL keeps only rows whose stored path is the folder or ends in its name (as given or
    /// with links resolved), so only those few candidates are canonicalized.
    fn launch_project_at(&self, cwd: &Path) -> Result<Option<(String, String)>> {
        let canonical = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_owned());
        let wanted = canonical(cwd);
        let [exact, resolved, a, b, c, d] = launch_path_patterns(cwd, &wanted);
        let matches = |column: &str| {
            format!("({column} IN (?1,?2) OR substr({column},-length(?3))=?3 OR substr({column},-length(?4))=?4 OR substr({column},-length(?5))=?5 OR substr({column},-length(?6))=?6)")
        };
        let params = rusqlite::params![exact, resolved, a, b, c, d];
        let mut stmt = self.db.prepare(&format!("SELECT DISTINCT p.id,p.path,s.worktree_path FROM sessions s JOIN projects p ON p.id=s.project_id WHERE s.worktree_path IS NOT NULL AND {} ORDER BY s.worktree_path IN (?1,?2) DESC,p.id LIMIT {LAUNCH_CANDIDATES}", matches("s.worktree_path"))).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params, |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (id, path, worktree) = row.map_err(|e| e.to_string())?;
            if canonical(Path::new(&worktree)) == wanted {
                return Ok(Some((id, path)));
            }
        }
        let mut stmt = self.db.prepare(&format!("SELECT id,path FROM projects WHERE {} ORDER BY path IN (?1,?2) DESC,id LIMIT {LAUNCH_CANDIDATES}", matches("path"))).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params, |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (id, path) = row.map_err(|e| e.to_string())?;
            if canonical(Path::new(&path)) == wanted {
                return Ok(Some((id, path)));
            }
        }
        Ok(None)
    }

    fn prompt_activity(&self, since_ms: i64) -> Result<Vec<(i64, String, u64)>> {
        let mut statement = self
            .db
            .prepare("SELECT m.created_at/3600000,s.provider,COUNT(*) FROM messages m JOIN sessions s ON s.id=m.session_id WHERE m.role='user' AND m.created_at>=?1 GROUP BY 1,2 ORDER BY 1")
            .map_err(|e| e.to_string())?;
        let rows = statement
            .query_map([since_ms], |row| Ok((row.get(0)?, row.get(1)?, row.get::<_, i64>(2)?.max(0) as u64)))
            .map_err(|e| e.to_string())?;
        rows.collect::<std::result::Result<_, _>>().map_err(|e| e.to_string())
    }
}

fn assert_release_reads(fixture: &TestDatabase, prompt_count: u64) {
    let reader = ReleasedReader::open_read_only(&fixture.path()).unwrap();
    assert_eq!(reader.prompt_activity(0).unwrap(), [(0, "codex".to_owned(), prompt_count)]);
    assert!(reader.prompt_activity(313).unwrap().is_empty());

    let project_path = fixture.0.join("project");
    let project = Some(("project".to_owned(), project_path.to_string_lossy().into_owned()));
    assert_eq!(reader.launch_session_project("lead").unwrap(), project);
    assert_eq!(reader.launch_project_at(&project_path).unwrap(), project);
    assert_eq!(reader.launch_project_at(&fixture.0.join("worktree")).unwrap(), project);
    assert_eq!(reader.launch_session_project("missing").unwrap(), None);
}

#[test]
fn rollback_to_0_3_151_and_reupgrade_preserves_all_data() {
    let (fixture, db) = TestDatabase::v37();
    batch(&db, CORE_ROWS);
    let project_path = fixture.0.join("project");
    let worktree = fixture.0.join("worktree");
    fs::create_dir(&project_path).unwrap();
    fs::create_dir(&worktree).unwrap();
    db.execute("UPDATE projects SET path=?1 WHERE id='project'", [project_path.to_string_lossy()]).unwrap();
    db.execute("UPDATE sessions SET worktree_path=?1 WHERE id='lead'", [worktree.to_string_lossy()]).unwrap();
    install_legacy_team_status(&db);
    drop(db);
    let store = Store::open(&fixture.path()).unwrap();
    assert!(assert_current(&store.db).is_empty());
    assert_release_reads(&fixture, 1);
    let mut before_rollback = snapshot(&store.db, false);
    drop(store);

    let old = Connection::open(fixture.path()).unwrap();
    batch(&old, "PRAGMA foreign_keys=ON");
    assert_eq!(version(&old), 37, "v0.3.151 requires schema 37 for read-only lookups");
    install_legacy_team_status(&old);
    let saved_status = "SELECT status FROM architect_team_status WHERE session_id='lead'";
    assert_eq!(scalar::<String>(&old, saved_status), "idle");

    // 0.3.151's tool/subagent upserts and save_team's two statements in one savepoint.
    batch(
        &old,
        r#"
        UPDATE sessions SET status='running' WHERE id='lead';
        INSERT INTO messages(session_id,role,content,created_at,tool_id)
            VALUES ('lead','tool','{"type":"tool_activity","version":1,"status":"running","output":"rollback output"}',310,'rollback-tool')
            ON CONFLICT(session_id,tool_id) DO UPDATE SET content=excluded.content;
        INSERT INTO subagents(session_id,id,content,updated_at)
            VALUES ('lead','done-worker','{"id":"done-worker","status":"running","updatedAt":311,"summary":"Updated by 0.3.151","tools":[]}',311)
            ON CONFLICT(session_id,id) DO UPDATE SET content=excluded.content,updated_at=excluded.updated_at;
        INSERT INTO messages(session_id,role,content,created_at) VALUES('lead','user','Written by v0.3.151',312);
        SAVEPOINT team_save;
    "#,
    );
    let team = r#"{"status":"waiting","legacyPromptThroughId":6,"workers":[{"id":"worker","status":"waiting"}],"note":"Saved by 0.3.151"}"#;
    old.execute(TEAM_SAVE, params!["lead", team]).unwrap();
    old.execute(TEAM_STATUS_SAVE, params!["lead", "waiting"]).unwrap();
    batch(&old, "RELEASE team_save");

    assert_release_reads(&fixture, 2);
    assert!(integrity_and_foreign_keys(&old).is_empty());
    assert_eq!(legacy_objects(&old).len(), 4);
    assert_eq!(scalar::<String>(&old, saved_status), "waiting");
    let tracked: (i64, i64, i64) = old
        .query_row(
            "SELECT (SELECT count(*) FROM running_tools JOIN messages ON message_id=messages.id
                    WHERE running_tools.session_id='lead' AND tool_id='rollback-tool'),
                (SELECT count(*) FROM running_subagents WHERE session_id='lead' AND id='done-worker'),
                (SELECT count(*) FROM architect_team_meta WHERE session_id='lead'
                    AND status='waiting' AND valid_json=1 AND needs_legacy_cutoff=0 AND skip_sync=0)",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(tracked, (1, 1, 1));

    // Verify the exact write set of the old SQL before taking its post-write baseline.
    let mut before = snapshot(&old, false);
    let inserted = before["messages"].rows[7].clone();
    let tool_content = r#"{"type":"tool_activity","version":1,"status":"running","output":"rollback output"}"#;
    assert_eq!(
        inserted,
        [
            8_i64.into(),
            "lead".to_owned().into(),
            "tool".to_owned().into(),
            tool_content.to_owned().into(),
            310_i64.into(),
            "rollback-tool".to_owned().into(),
            Value::Null,
            Value::Null,
        ]
    );
    before_rollback.get_mut("messages").unwrap().rows.push(inserted);
    let prompt = before["messages"].rows[8].clone();
    assert_eq!(&prompt[..5], &[9_i64.into(), "lead".to_owned().into(), "user".to_owned().into(), "Written by v0.3.151".to_owned().into(), 312_i64.into()]);
    before_rollback.get_mut("messages").unwrap().rows.push(prompt);
    expect(&mut before_rollback, "sqlite_sequence", "name", "messages", &[("seq", 9_i64.into())]);
    expect(&mut before_rollback, "sessions", "id", "lead", &[("last_prompt_at", 312_i64.into())]);
    expect_text(&mut before_rollback, "sessions", "id", "lead", "status", "running");
    let worker = r#"{"id":"done-worker","status":"running","updatedAt":311,"summary":"Updated by 0.3.151","tools":[]}"#;
    expect(
        &mut before_rollback,
        "subagents",
        "id",
        "done-worker",
        &[("content", worker.to_owned().into()), ("updated_at", 311_i64.into())],
    );
    expect_text(&mut before_rollback, "architect_teams", "session_id", "lead", "content", team);
    assert_eq!(before, before_rollback);
    drop(old);

    let started = now();
    let reopened = Store::open(&fixture.path()).unwrap();
    assert!(assert_current(&reopened.db).is_empty());
    assert_release_reads(&fixture, 2);
    expect_interrupted_task(&mut before, "lead");
    expect(&mut before, "messages", "tool_id", "rollback-tool", &[
        ("content", r#"{"type":"tool_activity","version":1,"status":"failed","output":"rollback output\n\n[PandaCode was interrupted before this tool reported a result.]"}"#.to_owned().into()),
    ]);
    expect_stopped_subagent(
        &mut before,
        &reopened.db,
        "done-worker",
        started,
        r#"{"id":"done-worker","status":"stopped","updatedAt":RECOVERY_TIME,"summary":"Updated by 0.3.151","tools":[]}"#,
    );
    expect(&mut before, "architect_teams", "session_id", "lead", &[
        ("content", r#"{"status":"interrupted","legacyPromptThroughId":6,"workers":[{"id":"worker","status":"stopped"}],"note":"Saved by 0.3.151","pendingTurn":null,"error":"PandaCode restarted. Resume explicitly to continue.","generation":1,"revision":1}"#.to_owned().into()),
    ]);
    assert_eq!(snapshot(&reopened.db, false), before);
    assert_eq!(
        scalar::<i64>(
            &reopened.db,
            "SELECT (SELECT count(*) FROM running_tools) +
        (SELECT count(*) FROM running_subagents)"
        ),
        0
    );
    assert_eq!(
        scalar::<String>(&reopened.db, "SELECT status FROM architect_team_meta WHERE session_id='lead'"),
        "interrupted"
    );
}

#[test]
fn migration_pragmas_can_leave_the_work_cache_unchanged() {
    let db = Connection::open_in_memory().unwrap();
    db.pragma_update(None, "cache_size", -4096).unwrap();
    let temp_store = with_migration_pragmas(&db, false, || {
        assert_eq!(scalar::<i64>(&db, "PRAGMA cache_size"), -4096);
        Ok(scalar::<i64>(&db, "PRAGMA temp_store"))
    }).unwrap();
    assert_eq!(temp_store, 1);
    assert_eq!(scalar::<i64>(&db, "PRAGMA temp_store"), 2);
    assert_eq!(scalar::<i64>(&db, "PRAGMA cache_size"), -8192);
}

#[test]
fn migration_pragmas_restore_the_sidebar_ranking_trigger() {
    let store = Store::open(Path::new(":memory:")).unwrap();
    let db = &store.db;
    super::super::sessions::rank_published_drafts(db).unwrap();
    for outcome in [Ok(()), Err("migration failed".to_owned())] {
        assert_eq!(with_migration_pragmas(db, true, || outcome.clone()), outcome);
        assert!(scalar::<bool>(db, "SELECT EXISTS(SELECT 1 FROM sqlite_temp_schema
            WHERE type='trigger' AND name='rank_published_draft')"));
    }
}

#[test]
fn json5_running_snapshots_are_tracked_and_recovered() {
    let (fixture, db) = TestDatabase::v37();
    batch(&db, "INSERT INTO projects(id,name,path) VALUES('project','Migration Lab','/work/pandacode');
        INSERT INTO sessions(id,project_id,title,provider,model,mode,status,created_at,updated_at)
        VALUES('task','project','Recover snapshots','codex','gpt-5','auto','running',1,1);");
    let child = "{id:'legacy-child',status:'running',updatedAt:1,tools:[{status:'waiting'}],}";
    let tool = "{type:'tool_activity',version:1,status:'running',output:'partial',}";
    let malformed = "{status:'running', broken";
    let insert_snapshots = |db: &Connection, child: &str, tool: &str| {
        db.execute(
            "INSERT INTO subagents(session_id,id,content,updated_at) VALUES
             ('task','legacy-child',?1,1),('task','malformed-child',?2,1)",
            params![child, malformed],
        ).unwrap();
        db.execute(
            "INSERT INTO messages(session_id,role,content,created_at,tool_id) VALUES
             ('task','tool',?1,1,'legacy-tool'),('task','tool',?2,1,'malformed-tool')",
            params![tool, malformed],
        ).unwrap();
    };
    let assert_tracked = |db: &Connection| {
        assert_eq!(strings(db, "SELECT id FROM running_subagents", []), ["legacy-child"]);
        assert_eq!(strings(db, "SELECT tool_id FROM running_tools JOIN messages ON message_id=messages.id", []), ["legacy-tool"]);
    };
    let assert_recovered = |db: &Connection| {
        assert_eq!(
            scalar::<String>(db, "SELECT json_extract(content,'$.status') FROM subagents WHERE id='legacy-child'"),
            "stopped",
        );
        assert_eq!(
            scalar::<String>(db, "SELECT json_extract(content,'$.tools[0].status') FROM subagents WHERE id='legacy-child'"),
            "failed",
        );
        assert_eq!(
            scalar::<String>(db, "SELECT json_extract(content,'$.status') FROM messages WHERE tool_id='legacy-tool'"),
            "failed",
        );
        assert_eq!(scalar::<String>(db, "SELECT content FROM subagents WHERE id='malformed-child'"), malformed);
        assert_eq!(scalar::<String>(db, "SELECT content FROM messages WHERE tool_id='malformed-tool'"), malformed);
        assert_eq!(scalar::<i64>(db, "SELECT count(*) FROM running_subagents"), 0);
        assert_eq!(scalar::<i64>(db, "SELECT count(*) FROM running_tools"), 0);
    };

    insert_snapshots(&db, child, tool);
    drop(db);
    let mut upgraded = Store::open_with_before_recovery(&fixture.path(), || {
        assert_tracked(&Connection::open(fixture.path()).unwrap());
    }).unwrap();
    assert_recovered(&upgraded.db);

    let escaped_child = "{id:'legacy-child',status:'wait\\\ning',updatedAt:1,tools:[{status:'wait\\\ning'}],}";
    let escaped_tool = r"{type:'tool_activity',version:1,status:'\x72unning',output:'partial',}";
    for (child, tool) in [(child, tool), (escaped_child, escaped_tool)] {
        batch(&upgraded.db, "UPDATE sessions SET status='running' WHERE id='task';
            DELETE FROM subagents; DELETE FROM messages;");
        insert_snapshots(&upgraded.db, child, tool);
        assert_tracked(&upgraded.db);
        drop(upgraded);
        upgraded = Store::open(&fixture.path()).unwrap();
        assert_recovered(&upgraded.db);
    }
}

#[test]
fn read_only_store_accepts_supported_and_future_versions() {
    let (fixture, db) = TestDatabase::v37();
    for schema in [36, 37, 38] {
        db.pragma_update(None, "user_version", schema).unwrap();
        let current = Store::open_read_only(&fixture.path());
        if schema < 37 {
            assert!(current.err().unwrap().contains("open PandaCode to migrate"));
        } else {
            let reader = current.unwrap();
            assert_eq!(version(&reader.db), schema);
            assert!(!reader.trackers_usable);
        }
        assert_eq!(ReleasedReader::open_read_only(&fixture.path()).is_ok(), schema == 37);
    }
}

#[test]
fn future_schema_with_incompatible_recovery_tables_and_columns_opens_without_ddl() {
    for schema in [SCHEMA_VERSION, 38, 39] {
        let (fixture, db) = TestDatabase::v37();
        batch(&db, CORE_ROWS);
        drop(db);
        let store = Store::open(&fixture.path()).unwrap();
        batch(
            &store.db,
            "UPDATE sessions SET status='running' WHERE id='lead';
            ALTER TABLE machine_threads RENAME TO future_machine_threads;
            UPDATE sessions SET sidebar_order=NULL;",
        );
        if schema == 39 {
            batch(&store.db,
                "ALTER TABLE architect_library RENAME TO future_architect_library;
                ALTER TABLE sessions RENAME COLUMN archived TO future_archived;
                ALTER TABLE sessions RENAME COLUMN remote_session TO future_remote_session;
                ALTER TABLE sessions RENAME COLUMN goal_state TO future_goal_state;",
            );
        }
        store.db.pragma_update(None, "user_version", schema).unwrap();
        let schema_cookie: i64 = scalar(&store.db, "PRAGMA schema_version");
        drop(store);

        let result = Store::open(&fixture.path());
        if schema == SCHEMA_VERSION {
            assert!(result.err().unwrap().contains("machine_threads"));
            continue;
        }
        let reopened = result.unwrap();
        assert_eq!(reopened.restart_interrupted, 0);
        assert!(!reopened.trackers_usable);
        assert_eq!(version(&reopened.db), schema);
        assert_eq!(scalar::<i64>(&reopened.db, "PRAGMA schema_version"), schema_cookie);
        assert_eq!(scalar::<i64>(&reopened.db, "PRAGMA temp.schema_version"), 0);
        assert_eq!(scalar::<String>(&reopened.db, "SELECT status FROM sessions WHERE id='lead'"), "running");
    }
}

#[test]
fn subagent_recovery_handles_mixed_empty_null_missing_and_non_array_tools() {
    let (fixture, db) = TestDatabase::v37();
    batch(&db, "INSERT INTO projects(id,name,path) VALUES('project','Migration Lab','/work/pandacode');
        INSERT INTO sessions(id,project_id,title,provider,model,mode,status,created_at,updated_at)
        VALUES('task','project','Subagent tools edge cases','codex','gpt-5','auto','running',1,1);");
    let cases = [
        ("mixed", r#"{"id":"mixed","status":"running","updatedAt":1,"tools":["x",1,null,true,false,["nested"],{"id":"t1","status":"running"},{"id":"t2","status":"waiting"},{"id":"t3","status":"done"}]}"#),
        ("empty", r#"{"id":"empty","status":"running","updatedAt":1,"tools":[]}"#),
        ("null-tools", r#"{"id":"null-tools","status":"waiting","updatedAt":1,"tools":null}"#),
        ("missing-tools", r#"{"id":"missing-tools","status":"running","updatedAt":1}"#),
        ("object-tools", r#"{"id":"object-tools","status":"running","updatedAt":1,"tools":{"id":"t0","status":"running"}}"#),
    ];
    for (id, content) in cases {
        db.execute(
            "INSERT INTO subagents(session_id,id,content,updated_at) VALUES('task',?1,?2,1)",
            params![id, content],
        ).unwrap();
    }
    drop(db);

    let store = Store::open(&fixture.path()).unwrap();
    assert_eq!(scalar::<i64>(&store.db, "SELECT count(*) FROM running_subagents"), 0);
    let parsed = |id: &str| -> serde_json::Value {
        let raw: String = store.db.query_row(
            "SELECT content FROM subagents WHERE session_id='task' AND id=?1",
            [id],
            |row| row.get(0),
        ).unwrap();
        serde_json::from_str(&raw).unwrap()
    };
    for (id, _) in cases {
        assert_eq!(parsed(id)["status"], "stopped", "{id}");
    }
    assert_eq!(
        parsed("mixed")["tools"],
        serde_json::json!(["x", 1, null, true, false, ["nested"], {"id":"t1","status":"failed"}, {"id":"t2","status":"failed"}, {"id":"t3","status":"done"}]),
    );
    assert_eq!(parsed("empty")["tools"], serde_json::json!([]));
    assert_eq!(parsed("null-tools").get("tools"), Some(&serde_json::Value::Null));
    assert_eq!(parsed("missing-tools").get("tools"), None);
    assert_eq!(parsed("object-tools")["tools"], serde_json::json!({"id":"t0","status":"running"}));
}

#[test]
fn json5_running_team_snapshot_is_tracked_interrupted_and_unblocks_guards() {
    let (fixture, db) = TestDatabase::v37();
    batch(&db, "INSERT INTO projects(id,name,path) VALUES('project','Migration Lab','/work/pandacode');
        INSERT INTO sessions(id,project_id,title,provider,model,mode,status,created_at,updated_at) VALUES
          ('team-cutoff','project','JSON5 team','codex','gpt-5','auto','running',1,1),
          ('team-direct','project','JSON5 direct','codex','gpt-5','auto','waiting',1,1),
          ('team-null','project','JSON5 null workers','codex','gpt-5','auto','running',1,1),
          ('team-missing','project','JSON5 missing workers','codex','gpt-5','auto','running',1,1);
        INSERT INTO messages(session_id,role,content,created_at) VALUES('team-cutoff','user','hello',1);");
    let teams = [
        ("team-cutoff", "{status:'running',generation:1,revision:1,workers:[{id:'w1',status:'running'}]}"),
        ("team-direct", "{status:'waiting',legacyPromptThroughId:0,generation:2,revision:3,workers:[{id:'w2',status:'waiting'},{id:'w3',status:'completed'}],}"),
        ("team-null", "{status:'running',legacyPromptThroughId:0,workers:null}"),
        ("team-missing", "{status:'running',legacyPromptThroughId:0}"),
    ];
    for (sid, content) in teams {
        db.execute("INSERT INTO architect_teams(session_id,content) VALUES(?1,?2)", params![sid, content]).unwrap();
    }
    drop(db);

    let store = Store::open_with_before_recovery(&fixture.path(), || {
        let before = Connection::open(fixture.path()).unwrap();
        let meta = |sid: &str| -> (Option<String>, i64, i64) {
            before.query_row(
                "SELECT status,valid_json,needs_legacy_cutoff FROM architect_team_meta WHERE session_id=?1",
                [sid],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            ).unwrap()
        };
        assert_eq!(meta("team-cutoff"), (Some("running".into()), 1, 1));
        assert_eq!(meta("team-direct"), (Some("waiting".into()), 1, 0));
        assert_eq!(meta("team-null"), (Some("running".into()), 1, 0));
        assert_eq!(meta("team-missing"), (Some("running".into()), 1, 0));
    }).unwrap();

    let parsed = |sid: &str| -> serde_json::Value {
        let raw: String = store.db.query_row("SELECT content FROM architect_teams WHERE session_id=?1", [sid], |row| row.get(0)).unwrap();
        serde_json::from_str(&raw).unwrap()
    };
    let cutoff = parsed("team-cutoff");
    assert_eq!(cutoff["status"], "interrupted");
    assert_eq!(cutoff["generation"], 2);
    assert_eq!(cutoff["revision"], 2);
    assert_eq!(cutoff["legacyPromptThroughId"], 1);
    assert_eq!(cutoff["workers"], serde_json::json!([{"id":"w1","status":"stopped"}]));
    let direct = parsed("team-direct");
    assert_eq!(direct["status"], "interrupted");
    assert_eq!(direct["generation"], 3);
    assert_eq!(direct["revision"], 4);
    assert_eq!(direct["workers"], serde_json::json!([{"id":"w2","status":"stopped"},{"id":"w3","status":"completed"}]));
    assert_eq!(parsed("team-null").get("workers"), Some(&serde_json::Value::Null));
    assert_eq!(parsed("team-missing").get("workers"), None);
    for (sid, _) in teams {
        let meta: (Option<String>, i64, i64) = store.db.query_row(
            "SELECT status,valid_json,needs_legacy_cutoff FROM architect_team_meta WHERE session_id=?1",
            [sid],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).unwrap();
        assert_eq!(meta, (Some("interrupted".into()), 1, 0), "{sid}");
    }

    let (state, _) = crate::concurrent_task_tests::test_state();
    *state.store.lock().unwrap() = store;
    drop(crate::agent_updates::reserve_install(&state).expect("recovered JSON5 teams no longer block installs"));
    let store = state.store.lock().unwrap();
    crate::remove_project_with_team_check(&store, "project").expect("recovered JSON5 teams no longer block project removal");
}
