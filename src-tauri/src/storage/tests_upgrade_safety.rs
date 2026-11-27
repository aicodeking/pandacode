//! Existing-install upgrade, rollback compatibility, and online backup checks.
use super::*;
use rusqlite::types::Value;
use std::{collections::BTreeMap, fs, time::Instant};

#[path = "tests_upgrade_rollback.rs"]
mod rollback;

// From 0.3.151 (52702085). The index below is from its old-index cleanup fixture:
// the release dropped it on open, but a v37 install could still have it on disk.
const TEAM_STATUS_SCHEMA: &str = "DROP INDEX IF EXISTS architect_teams_status;
    CREATE TABLE IF NOT EXISTS architect_team_status(session_id TEXT PRIMARY KEY,status);
    CREATE TRIGGER IF NOT EXISTS architect_team_status_insert AFTER INSERT ON architect_teams
      BEGIN DELETE FROM architect_team_status WHERE session_id=NEW.session_id; END;
    CREATE TRIGGER IF NOT EXISTS architect_team_status_update AFTER UPDATE ON architect_teams
      BEGIN DELETE FROM architect_team_status WHERE session_id IN (OLD.session_id,NEW.session_id); END;
    CREATE TRIGGER IF NOT EXISTS architect_team_status_delete AFTER DELETE ON architect_teams
      BEGIN DELETE FROM architect_team_status WHERE session_id=OLD.session_id; END;";
const TEAM_STATUS_BACKFILL: &str = "INSERT INTO architect_team_status(session_id,status)
    SELECT session_id,CASE WHEN json_valid(content) THEN json_extract(content,'$.status') END
    FROM architect_teams t WHERE NOT EXISTS(SELECT 1 FROM architect_team_status s WHERE s.session_id=t.session_id)";
const TEAM_SAVE: &str =
    "INSERT INTO architect_teams(session_id,content) VALUES(?1,?2) ON CONFLICT(session_id) DO UPDATE SET content=excluded.content";
const TEAM_STATUS_SAVE: &str =
    "INSERT INTO architect_team_status(session_id,status) VALUES(?1,?2) ON CONFLICT(session_id) DO UPDATE SET status=excluded.status";

struct TestDatabase(PathBuf);

impl TestDatabase {
    fn v37() -> (Self, Connection) {
        let fixture = Self(std::env::temp_dir().join(format!("pandacode-upgrade-safety-{}", id())));
        fs::create_dir(&fixture.0).unwrap();
        let db = Store::open(&fixture.path()).unwrap().db;
        for trigger in V38_TRACKER_TRIGGERS {
            db.execute_batch(&format!("DROP TRIGGER {trigger}")).unwrap();
        }
        for table in V38_TRACKER_TABLES {
            db.execute_batch(&format!("DROP TABLE {table}")).unwrap();
        }
        db.execute_batch("DROP TABLE task_model_runs").unwrap();
        for index in V38_SCHEMA_INDEXES.into_iter().chain(V38_BOT_INDEXES) {
            db.execute_batch(&format!("DROP INDEX {index}")).unwrap();
        }
        db.execute_batch(
            "CREATE INDEX turn_changes_retained ON turn_changes(created_at,id) WHERE diff_bytes>0;
            PRAGMA user_version=37;",
        )
        .unwrap();
        (fixture, db)
    }

    fn path(&self) -> PathBuf {
        self.0.join("store.sqlite3")
    }
}

impl Drop for TestDatabase {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn batch(db: &Connection, sql: &str) {
    db.execute_batch(sql).unwrap();
}

fn scalar<T: rusqlite::types::FromSql>(db: &Connection, sql: &str) -> T {
    db.query_row(sql, [], |row| row.get(0)).unwrap()
}

fn version(db: &Connection) -> i64 {
    scalar(db, "PRAGMA user_version")
}

fn strings(db: &Connection, sql: &str, params: impl rusqlite::Params) -> Vec<String> {
    let mut query = db.prepare(sql).unwrap();
    query
        .query_map(params, |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

fn legacy_objects(db: &Connection) -> Vec<String> {
    strings(
        db,
        "SELECT name FROM sqlite_schema WHERE name COLLATE NOCASE IN
         ('architect_team_status','architect_team_status_insert','architect_team_status_update',
          'architect_team_status_delete','architect_teams_status') ORDER BY name",
        [],
    )
}

type ForeignKeyViolation = (String, Option<i64>, String, i64);

fn integrity_and_foreign_keys(db: &Connection) -> Vec<ForeignKeyViolation> {
    let mut integrity = db.prepare("PRAGMA integrity_check").unwrap();
    let mut rows = integrity.query([]).unwrap();
    assert!(
        rows.next().unwrap().is_some_and(|row| row.get::<_, String>(0).unwrap() == "ok") && rows.next().unwrap().is_none(),
        "SQLite integrity_check did not return exactly one ok row",
    );
    let mut query = db.prepare("PRAGMA foreign_key_check").unwrap();
    let mut violations: Vec<_> = query
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    violations.sort_unstable();
    violations
}

fn assert_current(db: &Connection) -> Vec<ForeignKeyViolation> {
    assert_eq!(version(db), SCHEMA_VERSION);
    assert!(legacy_objects(db).is_empty(), "legacy team status objects survived");
    integrity_and_foreign_keys(db)
}

fn ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn table_names(db: &Connection) -> Vec<String> {
    strings(
        db,
        "SELECT name FROM sqlite_schema WHERE type='table' AND
        (name NOT GLOB 'sqlite_*' OR name='sqlite_sequence') ORDER BY name",
        [],
    )
}

fn columns(db: &Connection, table: &str) -> Vec<String> {
    strings(db, "SELECT name FROM pragma_table_info(?1) ORDER BY cid", [table])
}

fn is_user_table(table: &str) -> bool {
    table != "architect_team_status" && !V38_TRACKER_TABLES.contains(&table)
}

fn select_rows(table: &str, columns: &[String], key: &str) -> String {
    let columns = columns.iter().map(|name| ident(name)).collect::<Vec<_>>();
    format!("SELECT {key}{} FROM {} ORDER BY _rowid_", columns.join(","), ident(table))
}

#[derive(Debug, PartialEq)]
struct TableSnapshot {
    columns: Vec<String>,
    rows: Vec<Vec<Value>>,
}

type Snapshot = BTreeMap<String, TableSnapshot>;

fn read_rows(db: &Connection, table: &str, columns: &[String]) -> Vec<Vec<Value>> {
    let mut query = db.prepare(&select_rows(table, columns, "")).unwrap();
    query
        .query_map([], |row| (0..columns.len()).map(|index| row.get(index)).collect())
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

fn snapshot(db: &Connection, include_trackers: bool) -> Snapshot {
    table_names(db)
        .into_iter()
        .filter(|table| include_trackers || is_user_table(table))
        .map(|table| {
            let columns = columns(db, &table);
            let rows = read_rows(db, &table, &columns);
            (table, TableSnapshot { columns, rows })
        })
        .collect()
}

fn expect(snapshot: &mut Snapshot, table: &str, key: &str, id: &str, updates: &[(&str, Value)]) {
    let table = snapshot.get_mut(table).unwrap();
    let index = |name| table.columns.iter().position(|col| col == name).unwrap();
    let key = index(key);
    let id = Value::Text(id.into());
    let mut matches = table.rows.iter_mut().filter(|row| row[key] == id);
    let row = matches.next().unwrap();
    assert!(matches.next().is_none(), "fixture key is ambiguous");
    for (column, value) in updates {
        row[index(*column)] = value.clone();
    }
}

fn expect_text(snapshot: &mut Snapshot, table: &str, key: &str, id: &str, column: &str, text: &str) {
    expect(snapshot, table, key, id, &[(column, text.to_owned().into())]);
}

const CORE_ROWS: &str = r#"
INSERT INTO projects(id,name,path) VALUES
    ('project','Migration Lab','/work/pandacode'),('other','Reference','/work/reference');
INSERT INTO sessions(id,project_id,title,provider,model,mode,status,created_at,updated_at) VALUES
    ('lead','project','Ship the migration','codex','gpt-5','auto','idle',100,200),
    ('worker','project','Verify attachments','claude','sonnet','ask','idle',101,201),
    ('active','project','In-flight repair','codex','gpt-5','auto','running',102,202),
    ('archive','other','Archived notes','codex','gpt-5','ask','idle',103,203),
    ('draft-empty','project','New conversation','codex','gpt-5','ask','idle',104,204),
    ('draft-kept','project','Prepared draft','codex','gpt-5','ask','idle',105,205),
    ('remote','project','Mirrored task','codex','gpt-5','ask','idle',106,206),
    ('cloud','project','Cloud task','codex','gpt-5','ask','idle',107,207),
    ('limited','project','Waiting for quota','codex','gpt-5','ask','idle',108,208);
UPDATE sessions SET pinned=1,sidebar_order=0,resume_id='resume-lead' WHERE id='lead';
UPDATE sessions SET sidebar_order=1 WHERE id='worker';
UPDATE sessions SET archived=1 WHERE id='archive';
UPDATE sessions SET draft=1 WHERE id IN ('draft-empty','draft-kept');
UPDATE sessions SET remote_device='laptop',remote_session='host-id',remote_synced_id=18 WHERE id='remote';
UPDATE sessions SET cloud='{"provider":"daytona","runId":"run-1"}' WHERE id='cloud';
UPDATE sessions SET goal_state='{"status":"active","objective":"Verify café migration","tokensUsed":22}' WHERE id='active';
UPDATE sessions SET limited_at=220,limited_until=300,resume_at_reset=1 WHERE id='limited';
INSERT INTO messages(id,session_id,role,content,created_at,tool_id) VALUES
    (1,'lead','user','Keep the café name 🐼',111,NULL),
    (2,'lead','assistant','Verified the saved transcript.',112,NULL),
    (3,'active','tool','{"type":"tool_activity","version":1,"status":"running","output":"partial","name":"cargo"}',113,'tool-live'),
    (4,'lead','tool','{"type":"tool_activity","version":1,"status":"completed","output":"passed"}',114,'tool-done'),
    (5,'lead','handoff','{"summary":"Continue after review","workingDirectory":"/work/pandacode"}',115,NULL),
    (6,'lead','changes','{"id":"change-1","files":1}',116,NULL),
    (7,'draft-kept','assistant','Saved draft context',117,NULL);
INSERT INTO subagents(session_id,id,content,updated_at) VALUES
    ('active','running-worker','{"id":"running-worker","status":"running","updatedAt":118,"tools":[{"id":"nested","status":"waiting"}],"summary":"Keep this evidence"}',118),
    ('lead','done-worker','{"id":"done-worker","status":"completed","updatedAt":119,"summary":"Checked"}',119);
INSERT INTO architect_teams(session_id,content) VALUES
    ('lead','{"status":"idle","legacyPromptThroughId":6,"workers":[{"id":"worker","status":"completed"}]}'),
    ('active','{"status":"running","generation":5,"revision":7,"pendingTurn":{"kind":"lead"},"workers":[{"id":"helper","status":"running"},{"id":"reviewer","status":"completed"}],"legacyPromptThroughId":3}'),
    ('worker','{broken'),
    ('limited','{status:"running",workers:[],legacyPromptThroughId:0,}');
"#;

const OTHER_USER_ROWS: &str = r#"
INSERT INTO architect_workers(parent_session_id,worker_id,session_id) VALUES('lead','worker','worker');
INSERT INTO architect_requests(parent_session_id,key,kind,content,worker_id)
    VALUES('lead','dispatch-1','dispatch','{"assignment":"Check the export"}','worker');
INSERT INTO architect_messages(parent_session_id,sender,recipient,request_key,content,created_at)
    VALUES('lead','worker','lead','mail-1','The export has been checked.',121);
UPDATE architect_library SET content='{"enabled":false,"profiles":[],"leadGuidance":"Keep quoted evidence."}' WHERE id=1;
INSERT INTO turn_changes(id,session_id,message_id,summary,created_at,diff_bytes)
    VALUES('change-1','lead',6,'{"files":1,"added":2}',122,42);
INSERT INTO turn_change_files(change_id,path,detail)
    VALUES('change-1','src/café.ts','{"diff":"@@ -1 +1 @@\n-old\n+new","status":"modified"}');
INSERT INTO context_recovery(session_id,through_message_id) VALUES('lead',2);
INSERT INTO moodboards(id,project_id,name,created_at,updated_at)
    VALUES('board','project','Visual references',123,124);
INSERT INTO moodboard_images(id,board_id,name,caption,mime_type,width,height,original,thumbnail,agent_image,created_at)
    VALUES('image','board','Desk.png','Reference photo','image/png',800,600,x'89504e4700ff',x'00fe',x'89ff00',125);
INSERT INTO jev_assessments(id,session_id,created_at,report)
    VALUES('assessment','lead',126,'{"checks":[{"name":"Coverage","passed":true}]}');
INSERT INTO jev_project_rules(project_id,rules) VALUES('project','{"rules":["Verify checks before shipping"]}');
INSERT INTO task_links(session_id,kind,number,url,title,state,checked_at)
    VALUES('lead','issue',38,'https://example.test/issues/38','Migration checklist','open',127);
INSERT INTO queued_messages(id,session_id,position,text,attachments,created_at,updated_at)
    VALUES('queue','lead',2,'Keep for the next turn','[{"id":"queued-image","kind":"image"}]',128,129);
INSERT INTO bots(id,name,project_id,provider,model,mode,soul,skills,mcp,created_at,updated_at) VALUES
    ('bot-1','Scout','project','codex','gpt-5','auto','Careful checks.','["local-review"]','["git"]',130,131),
    ('bot-2','Reviewer','other','claude','sonnet','ask','','[]','[]',132,133);
INSERT INTO bot_memories(id,bot_id,content,source,created_at)
    VALUES('memory','bot-1','Remember the cutoff.','user',134);
INSERT INTO bot_channels(id,bot_id,kind,label,config,created_at)
    VALUES('channel','bot-1','web','Bench chat','{"paired":true}',135);
INSERT INTO bot_threads(bot_id,channel_id,external_id,session_id,brief_version,updated_at)
    VALUES('bot-1','channel','web-visitor','lead',3,136);
INSERT INTO bot_pairings(channel_id,sender_id,sender_name,status,code,created_at)
    VALUES('channel','visitor','Test visitor','approved','fixture-code',137);
INSERT INTO bot_tasks(session_id,bot_id,brief_version) VALUES('worker','bot-2',4);
INSERT INTO bot_activity(bot_id,kind,summary,detail,at)
    VALUES('bot-1','model-switch','Switched model','{"reason":"quota"}',138);
INSERT INTO bot_rules(id,bot_id,pattern,decision,created_at)
    VALUES('rule','bot-1','cargo test*','allow',139);
INSERT INTO bot_schedules(id,bot_id,title,prompt,kind,interval_minutes,next_run_at,created_by,created_at)
    VALUES('bot-timer','bot-1','Check again','Review the reports','interval',15,400,'user',140);
INSERT INTO bot_messages(id,source_bot_id,target_bot_id,source_session_id,target_session_id,
        source_channel_id,source_external_id,text,status,result,depth,created_at,updated_at)
    VALUES('bot-mail','bot-1','bot-2','lead','worker','channel','visitor','Check timestamps','completed','They match.',1,141,142);
INSERT INTO bot_shared_channels(id,name,lead_bot_id,created_at,updated_at)
    VALUES('shared','Review channel','bot-2',143,144);
INSERT INTO bot_shared_channel_members(channel_id,bot_id,position) VALUES('shared','bot-1',0),('shared','bot-2',1);
INSERT INTO bot_shared_channel_messages(id,channel_id,kind,text,status,created_at)
    VALUES('post','shared','user','Keep this discussion','in_progress',145);
INSERT INTO bot_shared_channel_deliveries(id,channel_id,message_id,bot_id,session_id,status,depth,created_at,updated_at)
    VALUES('delivery','shared','post','bot-2','worker','in_progress',1,146,147);
INSERT INTO message_attachments(message_id,session_id,id,kind,name,mime,width,height,bytes,file,source,moodboard_id,moodboard_image_id)
    VALUES(1,'lead','upload','image','Sketch.png','image/png',640,480,1024,'uploads/sketch.png','file',NULL,NULL),
          (1,'lead','reference','image','Desk.png','image/png',800,600,6,NULL,'moodboard','board','image');
INSERT INTO remote_cursors(device,session,epoch,seq) VALUES('laptop','host-id','epoch',9);
INSERT INTO task_usage_links(session_id,harness_id,created_at) VALUES('lead','resume-lead',148);
INSERT INTO task_schedules(id,session_id,title,prompt,kind,interval_minutes,next_run_at,created_by,created_by_session,saved_remotely,created_at,updated_at)
    VALUES('timer','lead','Review later','Check the notes','interval',20,500,'user','worker',1,149,150);
INSERT INTO task_schedule_runs(id,schedule_id,session_id,title,at,outcome,detail,sequence)
    VALUES('wake','timer','lead','Review later',151,'queued','Task already running',1);
INSERT INTO scheduler_settings(id,content) VALUES(1,'{"paused":true,"maxConcurrent":2}');
INSERT INTO machine_threads(parent_session_id,session_id,created_at,reported,reported_by)
    VALUES('lead','remote',152,1,5);
"#;

fn install_legacy_team_status(db: &Connection) {
    batch(db, TEAM_STATUS_SCHEMA);
    batch(db, TEAM_STATUS_BACKFILL);
}

fn expect_interrupted_task(before: &mut Snapshot, sid: &str) {
    expect(
        before,
        "sessions",
        "id",
        sid,
        &[
            ("status", "interrupted".to_owned().into()),
            ("task_stage", "in_progress".to_owned().into()),
            ("completed_at", Value::Null),
            ("restart_interrupted", 1_i64.into()),
        ],
    );
}

fn expect_stopped_subagent(before: &mut Snapshot, db: &Connection, worker: &str, started: i64, json: &str) {
    let settled_at: i64 = db
        .query_row("SELECT updated_at FROM subagents WHERE id=?1", [worker], |row| row.get(0))
        .unwrap();
    assert!((started..=now()).contains(&settled_at), "unexpected recovery timestamp");
    let content = json.replace("RECOVERY_TIME", &settled_at.to_string());
    expect(
        before,
        "subagents",
        "id",
        worker,
        &[("updated_at", settled_at.into()), ("content", content.into())],
    );
}

#[test]
fn v37_0_3_151_upgrade_preserves_every_table_and_passes_integrity_checks() {
    let (fixture, db) = TestDatabase::v37();
    batch(&db, CORE_ROWS);
    batch(&db, OTHER_USER_ROWS);
    install_legacy_team_status(&db);
    batch(
        &db,
        "CREATE INDEX architect_teams_status ON architect_teams(session_id,
        (CASE WHEN json_valid(content) THEN json_extract(content,'$.status') END));",
    );
    assert_eq!(version(&db), 37);
    assert_eq!(legacy_objects(&db).len(), 5);
    assert_eq!(scalar::<i64>(&db, "SELECT count(*) FROM architect_team_status"), 4);
    assert!(integrity_and_foreign_keys(&db).is_empty());
    let mut before = snapshot(&db, false);
    assert!(before.values().all(|table| !table.rows.is_empty()), "every table needs a fixture row");

    // Spill large uncommitted records into the WAL, then release the writer. The physical
    // frames survive rollback on the still-open connection and must never become visible.
    let wal = fixture.path().with_extension("sqlite3-wal");
    batch(
        &db,
        "PRAGMA wal_autocheckpoint=0; PRAGMA wal_checkpoint(TRUNCATE);
        PRAGMA cache_size=4; PRAGMA cache_spill=ON;
        BEGIN IMMEDIATE;
        UPDATE projects SET name=hex(zeroblob(262144)) WHERE id='project';
        DELETE FROM sessions WHERE id='lead';
        INSERT INTO projects(id,name,path) VALUES('uncommitted','Discard me','/fixture/uncommitted');",
    );
    let dirty_wal_size = fs::metadata(&wal).unwrap().len();
    assert!(dirty_wal_size > 32, "fixture did not spill dirty WAL frames");
    batch(&db, "ROLLBACK");
    assert_eq!(fs::metadata(&wal).unwrap().len(), dirty_wal_size);

    batch(&db, "BEGIN");
    assert_eq!(version(&db), 37);
    let started = now();
    let store = Store::open(&fixture.path()).unwrap();
    assert!(assert_backup_rows_preserved(&db, &store.db, Some(started)) > 0);
    assert!(assert_current(&store.db).is_empty());
    assert_eq!(store.restart_interrupted, 1);
    expect_interrupted_task(&mut before, "active");
    let recovered = r#"{"status":"paused","objective":"Verify café migration","tokensUsed":22}"#;
    expect_text(&mut before, "sessions", "id", "active", "goal_state", recovered);
    expect(
        &mut before,
        "sessions",
        "id",
        "archive",
        &[
            ("archived", 0_i64.into()),
            ("task_stage", "completed".to_owned().into()),
            ("completed_at", 203_i64.into()),
        ],
    );
    expect(&mut before, "messages", "tool_id", "tool-live", &[
        ("content", r#"{"type":"tool_activity","version":1,"status":"failed","output":"partial\n\n[PandaCode was interrupted before this tool reported a result.]","name":"cargo"}"#.to_owned().into()),
    ]);
    expect_stopped_subagent(
        &mut before,
        &store.db,
        "running-worker",
        started,
        r#"{"id":"running-worker","status":"stopped","updatedAt":RECOVERY_TIME,"tools":[{"id":"nested","status":"failed"}],"summary":"Keep this evidence"}"#,
    );
    expect(&mut before, "architect_teams", "session_id", "active", &[
        ("content", r#"{"status":"interrupted","generation":6,"revision":8,"pendingTurn":null,"workers":[{"id":"helper","status":"stopped"},{"id":"reviewer","status":"completed"}],"legacyPromptThroughId":3,"error":"PandaCode restarted. Resume explicitly to continue."}"#.to_owned().into()),
    ]);
    expect_text(
        &mut before,
        "architect_teams",
        "session_id",
        "limited",
        "content",
        r#"{"status":"interrupted","workers":[],"legacyPromptThroughId":0,"pendingTurn":null,"error":"PandaCode restarted. Resume explicitly to continue.","generation":1,"revision":1}"#,
    );
    before.insert("task_model_runs".into(), TableSnapshot {
        columns: ["turn_message_id", "harness", "requested_model", "requested_effort", "reported_model"]
            .into_iter().map(str::to_owned).collect(),
        rows: Vec::new(),
    });
    assert_eq!(snapshot(&store.db, false), before);
    let upgraded = snapshot(&store.db, true);
    drop(store);
    drop(db);

    let reopened = Store::open(&fixture.path()).unwrap();
    assert!(assert_current(&reopened.db).is_empty());
    assert_eq!(reopened.restart_interrupted, 0);
    assert_eq!(snapshot(&reopened.db, true), upgraded);
}

#[test]
fn legacy_installs_with_partial_bot_schema_and_corrupt_rows_upgrade_cleanly() {
    for (old_version, has_bots) in [(25, true), (25, false), (29, true), (36, true), (37, true), (37, false)] {
        let (fixture, db) = TestDatabase::v37();
        batch(
            &db,
            "DROP TABLE bot_shared_channel_deliveries; DROP TABLE bot_shared_channel_messages;
            DROP TABLE bot_shared_channel_members; DROP TABLE bot_shared_channels; DROP TABLE bot_messages;",
        );
        if !has_bots {
            batch(
                &db,
                "DROP TABLE bot_pairings; DROP TABLE bot_channels; DROP TABLE bot_threads;
                DROP TABLE bot_schedules; DROP TABLE bot_memories; DROP TABLE bot_activity;
                DROP TABLE bot_tasks; DROP TABLE bot_rules; DROP TABLE bots;",
            );
        } else {
            batch(
                &db,
                "ALTER TABLE bots DROP COLUMN color;
                ALTER TABLE bots DROP COLUMN reasoning_effort;
                ALTER TABLE bots DROP COLUMN backup_models;
                ALTER TABLE bots DROP COLUMN fallback_mode;
                ALTER TABLE bots DROP COLUMN notify;
                ALTER TABLE bots DROP COLUMN while_working;
                ALTER TABLE bots DROP COLUMN show_plan;
                INSERT INTO projects(id,name,path) VALUES('bot-project','Legacy bot','/work/bot');
                INSERT INTO bots(id,name,project_id,provider,model,mode,created_at,updated_at)
                    VALUES('legacy-bot','Legacy bot','bot-project','codex','gpt-5','ask',31,32);",
            );
        }
        if old_version <= 29 {
            batch(
                &db,
                "DROP TABLE machine_threads; DROP TABLE task_schedules; DROP TABLE task_schedule_runs;
                DROP TABLE scheduler_settings; DROP TABLE task_usage_links; DROP TABLE remote_cursors;
                DROP TABLE message_attachments; ALTER TABLE messages DROP COLUMN remote_cut;
                ALTER TABLE sessions DROP COLUMN remote_backfill_base;
                ALTER TABLE sessions DROP COLUMN restart_interrupted; ALTER TABLE sessions DROP COLUMN stop_requested;",
            );
        }
        if old_version == 25 {
            batch(
                &db,
                "DROP INDEX sessions_remote; ALTER TABLE sessions DROP COLUMN remote_device;
                ALTER TABLE sessions DROP COLUMN remote_session; ALTER TABLE sessions DROP COLUMN remote_synced_id;
                ALTER TABLE sessions DROP COLUMN cloud;",
            );
            if has_bots {
                batch(&db, "ALTER TABLE bots DROP COLUMN soul; ALTER TABLE bots DROP COLUMN skills;
                    ALTER TABLE bots DROP COLUMN mcp; DROP TABLE bot_tasks;");
            }
        }
        if old_version == 36 {
            batch(&db, "ALTER TABLE task_schedules DROP COLUMN saved_remotely;");
        }
        db.pragma_update(None, "user_version", old_version).unwrap();
        batch(
            &db,
            r#"
            INSERT INTO projects(id,name,path) VALUES('legacy','Legacy project','/work/legacy');
            INSERT INTO sessions(id,project_id,title,provider,model,mode,status,created_at,updated_at,goal_state)
                VALUES('malformed','legacy','Legacy notes','codex','gpt-5','ask','idle',50,51,'{broken'),
                      ('json5','legacy','Legacy JSON5','claude','sonnet','ask','idle',52,53,'{status:"active",}');
            INSERT INTO messages(session_id,role,content,created_at,tool_id)
                VALUES('malformed','tool','{"type":"tool_activity","version":1,"status":"running"}',54,NULL),
                      ('json5','user','Preserve the original text',55,NULL);
            INSERT INTO architect_teams(session_id,content)
                VALUES('malformed','{broken'),('json5','{status:"running",workers:[],}');
        "#,
        );
        install_legacy_team_status(&db);
        batch(&db, "BEGIN");
        assert_eq!(version(&db), old_version);
        assert!(integrity_and_foreign_keys(&db).is_empty());

        let started = now();
        let upgraded = Store::open(&fixture.path()).unwrap_or_else(|error| panic!("v{old_version}: {error}"));
        assert!(assert_current(&upgraded.db).is_empty(), "v{old_version}");
        assert_eq!(assert_backup_rows_preserved(&db, &upgraded.db, Some(started)), 1);
        assert_eq!(
            scalar::<String>(&upgraded.db, "SELECT content FROM architect_teams WHERE session_id='malformed'"),
            "{broken",
            "v{old_version}"
        );
        let json5_team: (String, i64) = upgraded.db.query_row(
            "SELECT json_extract(content,'$.status'),json_extract(content,'$.legacyPromptThroughId') FROM architect_teams WHERE session_id='json5'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).unwrap();
        let expected_cutoff: i64 = scalar(&upgraded.db, "SELECT MAX(id) FROM messages WHERE session_id='json5'");
        assert_eq!(json5_team, ("interrupted".into(), expected_cutoff), "v{old_version}");
        assert_eq!(scalar::<i64>(&upgraded.db, "SELECT count(*) FROM running_tools"), 0);
        let bots = crate::bots::list(&upgraded).unwrap_or_else(|error| panic!("v{old_version} listing bots: {error}"));
        assert_eq!(bots.len(), usize::from(has_bots), "v{old_version}");
        if let Some(bot) = bots.first() {
            assert_eq!((bot.id.as_str(), bot.project_id.as_str()), ("legacy-bot", "bot-project"));
            assert_eq!(bot.name, "Legacy bot");
            assert!(bot.color.is_empty());
        }
        for table in ["bots", "bot_messages", "bot_shared_channels", "bot_shared_channel_deliveries"] {
            assert!(
                table_names(&upgraded.db).iter().any(|name| name == table),
                "v{old_version}: missing {table}"
            );
        }
    }
}

fn table_counts(db: &Connection) -> BTreeMap<String, i64> {
    table_names(db)
        .into_iter()
        .map(|table| {
            let count = scalar(db, &format!("SELECT count(*) FROM {}", ident(&table)));
            (table, count)
        })
        .collect()
}

// Independently check any changes made by startup recovery against the pre-upgrade row.
fn expected_recovery(db: &Connection, table: &str, column: &str, rowid: i64, older: i64, at: i64) -> Option<Value> {
    let machine = if older >= 36 {
        "id NOT IN (SELECT session_id FROM machine_threads)"
    } else {
        "1"
    };
    let remote = if older >= 26 {
        format!("remote_device IS NOT NULL AND remote_session IS NULL AND {machine}")
    } else {
        "0".to_owned()
    };
    let active = if older >= 36 {
        format!("status IN ('running','waiting') AND (remote_device IS NULL OR {machine})")
    } else {
        "status IN ('running','waiting')".to_owned()
    };
    let original = ident(column);
    let conditional = |condition: &str, value: &str| format!("CASE WHEN {condition} THEN {value} ELSE {original} END");
    let expression = match (table, column) {
        ("sessions", "status") => format!("CASE WHEN {remote} THEN 'idle' WHEN {active} THEN 'interrupted' ELSE status END"),
        ("sessions", "task_stage") => format!("CASE WHEN archived=1 THEN 'completed' WHEN {active} THEN 'in_progress' ELSE task_stage END"),
        ("sessions", "completed_at") => format!(
            "CASE WHEN archived=1 AND ({active}) THEN updated_at
            WHEN archived=1 THEN coalesce(completed_at,updated_at) WHEN {active} THEN NULL ELSE completed_at END"
        ),
        ("sessions", "restart_interrupted") => conditional(&active, "1-stop_requested"),
        ("sessions", "archived") => conditional("archived=1", "0"),
        ("sessions", "remote_device") => conditional(&remote, "NULL"),
        ("sessions", "draft") => conditional(&remote, "NOT EXISTS(SELECT 1 FROM messages WHERE session_id=old.id)"),
        ("sessions", "goal_state") => "CASE WHEN json_valid(goal_state) AND json_extract(goal_state,'$.status')='active'
            THEN json_set(goal_state,'$.status','paused') ELSE goal_state END"
            .into(),
        ("messages", "content") => r#"CASE WHEN role='tool' AND tool_id IS NOT NULL
            AND session_id IN (SELECT id FROM sessions WHERE status IN ('running','waiting'))
            AND CASE WHEN json_valid(content,6) THEN json_extract(content,'$.type')='tool_activity'
            AND json_extract(content,'$.version')=1 AND json_extract(content,'$.status')='running' END
            THEN json_set(content,'$.status','failed','$.output',coalesce(json_extract(content,'$.output'),'')
                || char(10) || char(10) || '[PandaCode was interrupted before this tool reported a result.]') ELSE content END"#
            .into(),
        ("subagents", "updated_at" | "content") => {
            let value = if column == "updated_at" {
                "?2"
            } else {
                "CASE WHEN json_type(content,'$.tools')='array' THEN json_set(content,'$.status','stopped','$.updatedAt',?2,'$.tools',
                    json((SELECT json_group_array(CASE
                        WHEN type='object' AND json_extract(value,'$.status') IN ('running','waiting') THEN json(json_set(value,'$.status','failed'))
                        WHEN type IN ('object','array') THEN json(value)
                        WHEN type IN ('true','false') THEN json(type)
                        ELSE value END) FROM json_each(content,'$.tools'))))
                ELSE json_set(content,'$.status','stopped','$.updatedAt',?2) END"
            };
            conditional("CASE WHEN json_valid(content,6) THEN json_extract(content,'$.status') IN ('running','waiting') END", value)
        }
        ("architect_teams", "content") => "(SELECT CASE WHEN json_valid(stamped,6)
            AND json_extract(stamped,'$.status') IN ('running','waiting') THEN
            CASE WHEN json_type(stamped,'$.workers')='array' THEN
                json_set(stamped,'$.status','interrupted','$.pendingTurn',NULL,
                    '$.error','PandaCode restarted. Resume explicitly to continue.',
                    '$.generation',coalesce(json_extract(stamped,'$.generation'),0)+1,
                    '$.revision',coalesce(json_extract(stamped,'$.revision'),0)+1,
                    '$.workers',json((SELECT json_group_array(json(CASE WHEN json_extract(value,'$.status') IN ('running','waiting')
                        THEN json_set(value,'$.status','stopped') ELSE value END))
                        FROM json_each(stamped,'$.workers') WHERE type='object')))
            ELSE json_set(stamped,'$.status','interrupted','$.pendingTurn',NULL,
                    '$.error','PandaCode restarted. Resume explicitly to continue.',
                    '$.generation',coalesce(json_extract(stamped,'$.generation'),0)+1,
                    '$.revision',coalesce(json_extract(stamped,'$.revision'),0)+1) END
            ELSE stamped END FROM (
                SELECT CASE WHEN json_valid(content,6) AND coalesce(json_type(content,'$.legacyPromptThroughId'),'null')='null'
                    THEN json_set(content,'$.legacyPromptThroughId',coalesce((SELECT max(id) FROM messages WHERE session_id=old.session_id),0))
                    ELSE content END AS stamped))"
            .into(),
        ("scheduler_settings", "content") if older < 37 => "CASE WHEN id=1 AND json_valid(content)
            THEN json_remove(content,'$.remoteSaved') ELSE content END"
            .into(),
        ("task_schedules", "saved_remotely") if older < 37 => "CASE WHEN created_by='user' OR id IN (
            SELECT j.value FROM scheduler_settings s, json_each(CASE WHEN json_valid(s.content) THEN s.content ELSE '{}' END,'$.remoteSaved') j
            WHERE s.id=1) THEN 1 ELSE saved_remotely END"
            .into(),
        _ => return None,
    };
    let sql = format!("SELECT {expression} FROM {} AS old WHERE _rowid_=?1 AND ?2 IS NOT NULL", ident(table));
    Some(db.query_row(&sql, params![rowid, at], |row| row.get(0)).unwrap())
}

// Stream from an open WAL snapshot so a multi-GB database stays bounded in memory.
fn assert_backup_rows_preserved(before: &Connection, after: &Connection, recovery_started: Option<i64>) -> usize {
    let older = version(before);
    let mut changed = 0;
    for table in table_names(before)
        .into_iter()
        .filter(|table| recovery_started.is_none() || is_user_table(table))
    {
        let original_columns = columns(before, &table);
        let actual_columns = columns(after, &table);
        assert!(
            original_columns.iter().all(|column| actual_columns.contains(column)),
            "{table} lost a column"
        );
        let sql = select_rows(&table, &original_columns, "_rowid_,");
        let mut original_query = before.prepare(&sql).unwrap();
        let mut actual_query = after.prepare(&sql).unwrap();
        let mut original = original_query.query([]).unwrap();
        let mut actual = actual_query.query([]).unwrap();
        while let Some(old_row) = original.next().unwrap() {
            let new_row = actual.next().unwrap().unwrap_or_else(|| panic!("{table} lost rows"));
            let rowid: i64 = old_row.get(0).unwrap();
            assert!(rowid == new_row.get::<_, i64>(0).unwrap(), "{table} row identity changed");
            for (i, column) in original_columns.iter().enumerate() {
                let saved = new_row.get_ref(i + 1).unwrap();
                if old_row.get_ref(i + 1).unwrap() == saved {
                    continue;
                }
                let started = recovery_started.unwrap_or_else(|| panic!("{table}.{column} changed on reopen"));
                let at = if table == "subagents" {
                    let index = original_columns.iter().position(|col| col == "updated_at").unwrap();
                    let at: i64 = new_row.get(index + 1).unwrap();
                    assert!((started..=now()).contains(&at), "unexpected subagent recovery timestamp");
                    at
                } else {
                    started
                };
                let expected = expected_recovery(before, &table, column, rowid, older, at);
                assert!(
                    expected.as_ref().is_some_and(|value| rusqlite::types::ValueRef::from(value) == saved),
                    "unexpected change in {table}.{column}"
                );
                changed += 1;
            }
        }
        assert!(actual.next().unwrap().is_none(), "{table} gained rows");
    }
    changed
}

#[test]
#[ignore = "requires a sqlite3 online backup in pandacode-upgrade-smoke under the system temporary directory"]
fn real_existing_install_backup_smoke() {
    const INPUT_GUIDANCE: &str =
        "Set PANDACODE_UPGRADE_SMOKE_DB=/path/to/backup.sqlite3 to run this ignored existing-install smoke test";
    let path = std::env::var_os("PANDACODE_UPGRADE_SMOKE_DB")
        .filter(|path| !path.is_empty())
        .expect(INPUT_GUIDANCE);
    let path = fs::canonicalize(path).expect(INPUT_GUIDANCE);
    let metadata = fs::metadata(&path).expect(INPUT_GUIDANCE);
    assert!(metadata.is_file() && metadata.len() > 0, "{INPUT_GUIDANCE}");
    let backups = fs::canonicalize(std::env::temp_dir()).unwrap().join("pandacode-upgrade-smoke");
    assert_eq!(path.parent(), Some(backups.as_path()), "{INPUT_GUIDANCE}. Use an isolated smoke backup in {backups:?}");
    assert!(path.extension().is_some_and(|ext| ext == "sqlite3"), "{INPUT_GUIDANCE}");
    #[cfg(unix)]
    assert_eq!(
        std::os::unix::fs::MetadataExt::nlink(&metadata),
        1,
        "use a standalone smoke backup"
    );
    let size = || fs::metadata(&path).unwrap().len();
    // The backup has no active sidecars. Opening the copy with write access lets SQLite
    // read its WAL-mode header and create its own sidecars; snapshots below only read.
    let baseline = Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE)
        .expect(INPUT_GUIDANCE);
    batch(&baseline, "PRAGMA query_only=ON; BEGIN");
    let older: i64 = baseline
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .expect(INPUT_GUIDANCE);
    let before = table_counts(&baseline);
    assert!(
        before.iter().any(|(table, count)| *count > 0 && table != "sqlite_sequence" && is_user_table(table)),
        "{INPUT_GUIDANCE}. The backup must contain at least one row in a user table."
    );
    let violations = integrity_and_foreign_keys(&baseline);
    println!(
        "Before: {} bytes, v{older}, integrity ok, {} foreign-key violations, {before:?}",
        size(),
        violations.len()
    );

    let recovery_started = now();
    let started = Instant::now();
    let upgraded = Store::open(&path).unwrap();
    let elapsed = started.elapsed();
    let after_violations = assert_current(&upgraded.db);
    let after = table_counts(&upgraded.db);
    println!(
        "After: {} bytes, v{}, integrity ok, {} foreign-key violations, open {elapsed:?}, {after:?}",
        size(),
        version(&upgraded.db),
        after_violations.len()
    );
    assert!(after_violations == violations, "foreign-key violations changed");
    let changed = assert_backup_rows_preserved(&baseline, &upgraded.db, Some(recovery_started));
    println!("{changed} expected startup or migration cell changes, all existing user rows preserved");
    drop(baseline);

    batch(&upgraded.db, "BEGIN");
    // Pin the pre-reopen snapshot before the second connection can change it.
    assert_eq!(version(&upgraded.db), SCHEMA_VERSION);
    let started = Instant::now();
    let reopened = Store::open(&path).unwrap();
    let elapsed = started.elapsed();
    assert!(assert_current(&reopened.db) == violations, "foreign-key violations changed on reopen");
    assert_eq!(table_counts(&reopened.db), after);
    assert_eq!(assert_backup_rows_preserved(&upgraded.db, &reopened.db, None), 0);
    let reopened_version = version(&reopened.db);
    drop(upgraded);
    drop(reopened);
    println!("Reopen: {} bytes, v{reopened_version}, integrity ok, {elapsed:?}; every row matched", size());
}
