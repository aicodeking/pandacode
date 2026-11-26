use super::*;

#[test]
fn all_recovery_phases_claim_the_write_lock_before_accessing_tables() {
    let dir = std::env::temp_dir().join(format!("pandacode-bot-recovery-{}", crate::storage::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("store.sqlite");
    let store = Store::open(&path).unwrap();
    store.db.busy_timeout(std::time::Duration::ZERO).unwrap();
    // Missing tables expose any phase that starts reading before claiming the lock.
    store.db.execute_batch("DROP TABLE bot_messages; DROP TABLE bot_shared_channel_deliveries;").unwrap();
    let writer = rusqlite::Connection::open(&path).unwrap();
    writer.execute_batch("BEGIN IMMEDIATE").unwrap();

    let error = reconcile_in_progress(&store).unwrap_err();
    assert!(store.db.is_autocommit());
    drop(writer);
    drop(store);
    std::fs::remove_dir_all(dir).unwrap();
    assert_eq!(error.matches("database is locked").count(), 3, "{error}");
}

#[test]
fn corrupt_queue_preserves_interrupted_delivery_recovery() {
    let store = Store::open(std::path::Path::new(":memory:")).unwrap();
    store.db.execute_batch(
        "INSERT INTO projects(id,name,path) VALUES('project','Project','/project');
         INSERT INTO sessions(id,project_id,title,provider,model,mode,status,created_at,updated_at)
         VALUES('working-task','project','Working','claude','default','ask','idle',1,1),
               ('queued-task','project','Queued','claude','default','ask','idle',1,1);
         INSERT INTO bots(id,name,project_id,provider,model,mode,created_at,updated_at)
         VALUES('working-bot','Working','project','claude','default','ask',1,1),
               ('queued-bot','Queued','project','claude','default','ask',1,1);
         INSERT INTO bot_messages(id,source_bot_id,target_bot_id,source_session_id,target_session_id,
                                  source_channel_id,source_external_id,text,status,depth,created_at,updated_at)
         VALUES('direct','queued-bot','working-bot','queued-task','working-task',
                'desktop','desktop','work on it','in_progress',1,1,1);
         INSERT INTO bot_shared_channels(id,name,created_at,updated_at) VALUES('channel','launch',1,1);
         INSERT INTO bot_shared_channel_messages(id,channel_id,kind,text,status,created_at)
         VALUES('working-post','channel','user','ship it','in_progress',1),
               ('queued-post','channel','user','draft it','queued',2);
         INSERT INTO bot_shared_channel_deliveries(id,channel_id,message_id,bot_id,session_id,status,created_at,updated_at)
         VALUES('working','channel','working-post','working-bot','working-task','in_progress',1,1),
               ('waiting','channel','queued-post','queued-bot','queued-task','queued',2,2);
         INSERT INTO queued_messages(id,session_id,position,text,attachments,created_at,updated_at)
         VALUES('bad','queued-task',0,X'deadbeef','[]',2,2);",
    ).unwrap();
    let decode_error = message_queue::list(&store, Some("queued-task")).unwrap_err();

    assert_eq!(reconcile_in_progress(&store), Err(decode_error));
    assert!(store.db.is_autocommit());
    let status = |table: &str, id: &str| {
        store.db.query_row(&format!("SELECT status FROM {table} WHERE id=?1"), [id], |row| row.get::<_, String>(0)).unwrap()
    };
    assert_eq!(status("bot_messages", "direct"), "failed");
    assert_eq!(status("bot_shared_channel_deliveries", "working"), "failed");
    assert_eq!(status("bot_shared_channel_messages", "working-post"), "failed");
    assert_eq!(status("bot_shared_channel_deliveries", "waiting"), "queued");
    assert_eq!(status("bot_shared_channel_messages", "queued-post"), "queued");
}

#[test]
fn shared_channel_recovery_survives_missing_direct_bot_messages() {
    let store = Store::open(std::path::Path::new(":memory:")).unwrap();
    store.db.execute_batch(
        "INSERT INTO projects(id,name,path) VALUES('project','Project','/project');
         INSERT INTO sessions(id,project_id,title,provider,model,mode,status,created_at,updated_at)
         VALUES('task','project','Task','claude','default','ask','idle',1,1);
         INSERT INTO bots(id,name,project_id,provider,model,mode,created_at,updated_at)
         VALUES('bot','Bot','project','claude','default','ask',1,1);
         INSERT INTO bot_shared_channels(id,name,created_at,updated_at) VALUES('channel','launch',1,1);
         INSERT INTO bot_shared_channel_messages(id,channel_id,kind,text,status,created_at)
         VALUES('working-post','channel','user','ship it','in_progress',1),
               ('queued-post','channel','user','draft it','queued',2);
         INSERT INTO bot_shared_channel_deliveries(id,channel_id,message_id,bot_id,session_id,status,created_at,updated_at)
         VALUES('working','channel','working-post','bot','task','in_progress',1,1),
               ('queued','channel','queued-post','bot','task','queued',2,2);
         DROP TABLE bot_messages;",
    ).unwrap();

    assert!(reconcile_in_progress(&store).unwrap_err().contains("bot_messages"));
    assert!(store.db.is_autocommit());
    let statuses: Vec<(String, String)> = store.db.prepare(
        "SELECT d.status,m.status FROM bot_shared_channel_deliveries d
         JOIN bot_shared_channel_messages m ON m.id=d.message_id ORDER BY d.id",
    ).unwrap().query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap()
        .collect::<rusqlite::Result<_>>().unwrap();
    assert_eq!(statuses, vec![("failed".into(), "failed".into()); 2]);
}

#[test]
fn direct_bot_recovery_survives_missing_shared_channel_tables() {
    let store = Store::open(std::path::Path::new(":memory:")).unwrap();
    store.db.execute_batch(
        "INSERT INTO projects(id,name,path) VALUES('project','Project','/project');
         INSERT INTO sessions(id,project_id,title,provider,model,mode,status,created_at,updated_at)
         VALUES('source-task','project','Source','claude','default','ask','idle',1,1),
               ('target-task','project','Target','claude','default','ask','idle',1,1);
         INSERT INTO bots(id,name,project_id,provider,model,mode,created_at,updated_at)
         VALUES('source-bot','Source','project','claude','default','ask',1,1),
               ('target-bot','Target','project','claude','default','ask',1,1);
         INSERT INTO bot_messages(id,source_bot_id,target_bot_id,source_session_id,target_session_id,
                                  source_channel_id,source_external_id,text,status,depth,created_at,updated_at)
         VALUES('direct','source-bot','target-bot','source-task','target-task',
                'desktop','desktop','work on it','in_progress',1,1,1);
         DROP TABLE bot_shared_channel_deliveries;",
    ).unwrap();

    let error = reconcile_in_progress(&store).unwrap_err();
    assert!(error.contains("interrupted shared-channel deliveries:"));
    assert!(error.contains("queued shared-channel deliveries:"));
    assert!(store.db.is_autocommit());
    let (status, result): (String, String) = store.db
        .query_row("SELECT status,result FROM bot_messages WHERE id='direct'", [], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap();
    assert_eq!(status, "failed");
    assert_eq!(result, "Interrupted when PandaCode closed.");
}

#[test]
fn corrupt_queue_preserves_other_sessions_queued_delivery_recovery() {
    let store = Store::open(std::path::Path::new(":memory:")).unwrap();
    store.db.execute_batch(
        "INSERT INTO projects(id,name,path) VALUES('project','Project','/project');
         INSERT INTO sessions(id,project_id,title,provider,model,mode,status,created_at,updated_at)
         VALUES('healthy-task','project','Healthy','claude','default','ask','idle',1,1),
               ('corrupt-task','project','Corrupt','claude','default','ask','idle',1,1);
         INSERT INTO bots(id,name,project_id,provider,model,mode,created_at,updated_at)
         VALUES('healthy-bot','Healthy','project','claude','default','ask',1,1),
               ('corrupt-bot','Corrupt','project','claude','default','ask',1,1);
         INSERT INTO bot_shared_channels(id,name,created_at,updated_at) VALUES('channel','launch',1,1);
         INSERT INTO bot_shared_channel_messages(id,channel_id,kind,text,status,created_at)
         VALUES('healthy-post','channel','user','ship it','queued',1),
               ('corrupt-post','channel','user','draft it','queued',2);
         INSERT INTO bot_shared_channel_deliveries(id,channel_id,message_id,bot_id,session_id,status,created_at,updated_at)
         VALUES('healthy','channel','healthy-post','healthy-bot','healthy-task','queued',1,1),
               ('corrupt','channel','corrupt-post','corrupt-bot','corrupt-task','queued',2,2);
         INSERT INTO queued_messages(id,session_id,position,text,attachments,created_at,updated_at)
         VALUES('bad','corrupt-task',0,X'deadbeef','[]',2,2);",
    ).unwrap();
    let decode_error = message_queue::list(&store, Some("corrupt-task")).unwrap_err();
    assert!(decode_error.contains("Invalid column type Blob"), "{decode_error}");
    assert_eq!(reconcile_in_progress(&store), Err(decode_error));
    assert!(store.db.is_autocommit());

    let statuses = |delivery| {
        store.db.query_row(
            "SELECT d.status,m.status FROM bot_shared_channel_deliveries d
             JOIN bot_shared_channel_messages m ON m.id=d.message_id WHERE d.id=?1",
            [delivery],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        ).unwrap()
    };
    assert_eq!(statuses("healthy"), ("failed".into(), "failed".into()));
    assert_eq!(statuses("corrupt"), ("queued".into(), "queued".into()));
}

#[test]
fn corrupt_delivery_preserves_other_posts_during_recovery() {
    for active in ["queued", "in_progress"] {
        let store = Store::open(std::path::Path::new(":memory:")).unwrap();
        store.db.execute_batch(
            "INSERT INTO projects(id,name,path) VALUES('project','Project','/project');
             INSERT INTO sessions(id,project_id,title,provider,model,mode,status,created_at,updated_at)
             VALUES('task','project','Task','claude','default','ask','idle',1,1);
             INSERT INTO bots(id,name,project_id,provider,model,mode,created_at,updated_at)
             VALUES('bot','Bot','project','claude','default','ask',1,1);
             INSERT INTO bot_shared_channels(id,name,created_at,updated_at) VALUES('channel','launch',1,1);
             INSERT INTO bot_shared_channel_messages(id,channel_id,kind,text,status,created_at)
             VALUES('healthy-post','channel','user','ship it','queued',1),
                   ('corrupt-post','channel','user','draft it','queued',2);
             INSERT INTO bot_shared_channel_deliveries(id,channel_id,message_id,bot_id,session_id,status,created_at,updated_at)
             VALUES('healthy','channel','healthy-post','bot','task','queued',1,1),
                   ('corrupt','channel','corrupt-post','bot','task','completed',2,'bad-ts');",
        ).unwrap();
        if active == "in_progress" {
            store.db.execute_batch(
                "UPDATE bot_shared_channel_messages SET status='in_progress';
                 UPDATE bot_shared_channel_deliveries SET status='in_progress' WHERE id='healthy';",
            ).unwrap();
        }

        let statuses = || store.db.prepare(
            "SELECT d.status,m.status FROM bot_shared_channel_deliveries d
             JOIN bot_shared_channel_messages m ON m.id=d.message_id ORDER BY d.id",
        ).unwrap().query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).unwrap()
            .collect::<rusqlite::Result<Vec<_>>>().unwrap();
        if active == "queued" {
            store.db.execute_batch(
                "CREATE TRIGGER refuse_settlement BEFORE UPDATE OF status ON bot_shared_channel_messages
                 WHEN NEW.id='healthy-post' BEGIN SELECT RAISE(ABORT,'Invalid column type Text from trigger'); END;",
            ).unwrap();
            let error = reconcile_in_progress(&store).unwrap_err();
            assert!(error.contains("from trigger"), "{error}");
            assert_eq!(statuses(), vec![("completed".into(), "queued".into()), ("queued".into(), "queued".into())]);
            store.db.execute_batch("DROP TRIGGER refuse_settlement").unwrap();
        }

        let error = reconcile_in_progress(&store).unwrap_err();
        assert!(error.contains("Invalid column type Text") && error.contains("updated_at"), "{error}");
        assert!(store.db.is_autocommit());
        assert_eq!(statuses(), vec![("completed".into(), active.into()), ("failed".into(), "failed".into())]);
    }
}
