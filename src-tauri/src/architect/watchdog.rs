//! A team turn that goes silent is stopped, so one hung tool call cannot block the team, and a turn
//! whose end was never recorded is settled, so nothing waits forever for an event that was missed.
use super::*;

/// Claude's longest tool timeout is 10 minutes, so a turn with no event for twice that
/// is stuck. Approvals and questions that wait on the user never count as silence.
pub(crate) const SILENCE_MINUTES: i64 = 20;
const SILENCE_LIMIT_MS: i64 = SILENCE_MINUTES * 60 * 1000;
const CHECK_EVERY: std::time::Duration = std::time::Duration::from_secs(30);
/// A tick this late means the computer slept (or its clock jumped): the wall clock moved, harnesses did not.
const SLEEP_GAP_MS: i64 = 3 * CHECK_EVERY.as_secs() as i64 * 1000;
/// How long a run may read as running with no process before it counts as lost. The scheduler claims
/// a run and registers it in `prepare_task_run_in_project` with no await in between (the one await on
/// that path, `prepare_command` for `/` prompts, is skipped for team launches), so only lock waits
/// separate them, and everything slow (cloud setup, harness startup) happens after the agent is
/// registered. A claim this old with no agent is no launch in progress; even if a launch did arrive
/// later, `validate_admission` refuses it once the worker is no longer `running`.
pub(super) const ORPHAN_AFTER_MS: i64 = 60 * 1000;
/// The error of a worker settled by `reap_orphans`; also marks the run as not the model's failure.
pub(super) const ORPHANED: &str = "The run ended without reporting back.";

pub(crate) fn architect_note() -> String {
    format!("The architect's turn was stopped after {SILENCE_MINUTES} minutes without any output.")
}
pub(crate) fn worker_note() -> String {
    format!("No output for {SILENCE_MINUTES} minutes, so PandaCode stopped this worker. Check its changes in the checkout, or follow up.")
}

pub(crate) fn watch(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut first = true;
        let mut last_tick = storage::now();
        loop {
            tokio::time::sleep(CHECK_EVERY).await;
            let state = app.state::<AppState>();
            if state.shutdown.load(Ordering::SeqCst) != 0 {
                break;
            }
            if std::mem::take(&mut first) {
                match settle_stale(&state, &mut |team| emit(&app, team)) {
                    Ok(0) => {}
                    Ok(n) => eprintln!("Team watchdog: settled {n} workers of inactive teams saved as running"),
                    Err(error) => eprintln!("Team watchdog: {error}"),
                }
            }
            let now = storage::now();
            // After a sleep this tick only restarts the clocks; the next one gives any launch the
            // sleep interrupted time to register before the orphan and reservation checks look.
            match forgive_sleep(&state, now, std::mem::replace(&mut last_tick, now)) {
                Ok(true) => continue,
                Ok(false) => {}
                Err(error) => eprintln!("Team watchdog: {error}"),
            }
            if let Err(error) = stop_silent(&state, now, &mut |team| emit(&app, team)) {
                eprintln!("Team watchdog: {error}");
            }
            match reconcile(&state, now, &mut |team| emit(&app, team)) {
                Ok(true) => wake(app.clone()),
                Ok(false) => {}
                Err(error) => eprintln!("Team watchdog: {error}"),
            }
        }
    });
}

/// Time asleep is not silence: without this, opening the lid after 20 minutes would fail every live
/// turn and pause healthy models. Returns whether `now` is far enough past `last_tick` to count.
pub(super) fn forgive_sleep(state: &AppState, now: i64, last_tick: i64) -> Result<bool> {
    if now.saturating_sub(last_tick) <= SLEEP_GAP_MS {
        return Ok(false);
    }
    let agents = crate::run_requests::lock_agents(&state.agents).map_err(|e| e.to_string())?;
    for agent in agents.values() {
        agent.last_event.store(now, Ordering::SeqCst);
    }
    Ok(true)
}

/// Stops every silent team turn and returns how many it stopped. The flag is saved
/// before the stop, so the completion settles the run as a timeout and not a user stop.
pub(super) fn stop_silent(
    state: &AppState,
    now: i64,
    notify: &mut impl FnMut(&TeamSnapshot),
) -> Result<usize> {
    let agents = crate::run_requests::lock_agents(&state.agents).map_err(|e| e.to_string())?;
    let silent = agents
        .iter()
        .filter(|(_, agent)| {
            agent.silent_for(now) >= SILENCE_LIMIT_MS
                && !agent.stopped.load(Ordering::SeqCst)
                && !agent.has_pending_approvals()
        })
        .map(|(sid, _)| sid.clone())
        .collect::<Vec<_>>();
    if silent.is_empty() {
        return Ok(0);
    }
    let store = state.store.lock().map_err(|e| e.to_string())?;
    let mut stopped = 0;
    for sid in silent {
        if store.session(&sid).is_ok_and(|task| task.status == "waiting") {
            continue;
        }
        // One unreadable team must not keep the others' silent turns running.
        let found = load(&store, &sid).and_then(|own| match own {
            Some(team) => Ok(Some((sid.clone(), team))),
            None => match parent_of(&store, &sid)? {
                Some(parent) => Ok(load(&store, &parent)?.map(|team| (parent, team))),
                None => Ok(None),
            },
        });
        let (parent, mut team) = match found {
            Ok(Some(found)) => found,
            Ok(None) => continue,
            Err(error) => {
                eprintln!("Team watchdog: {sid}: {error}");
                continue;
            }
        };
        if !active(&team.status) {
            continue;
        }
        if parent == sid {
            team.timed_out = true;
        } else if let Some(worker) = team
            .workers
            .iter_mut()
            .find(|w| w.session_id == sid && active(&w.status))
        {
            worker.timed_out = true;
        } else {
            continue;
        }
        if let Err(error) = save(&store, &mut team) {
            eprintln!("Team watchdog: {sid}: {error}");
            continue;
        }
        notify(&team);
        if let Some(agent) = agents.get(&sid) {
            let _ = agent.send(RunInput::Stop);
        }
        stopped += 1;
    }
    Ok(stopped)
}

/// The teams `settle_stale` looks at, in save order: every team that is not running or waiting,
/// and every row that is not even JSON, so the load reports it instead of the query failing.
/// A JSON team without a status is not listed. Each range reads the `architect_team_meta_status`
/// index on the trigger-kept tracker rather than parsing every snapshot: `NOT IN` is split into
/// the ranges around the two active statuses (the untyped `status` column keeps
/// `json_extract`'s types, so they order exactly as the old expression did), and only rows with
/// a NULL status are checked for invalid JSON.
const STALE_CANDIDATES_SQL: &str = "SELECT session_id FROM architect_teams WHERE session_id IN (SELECT session_id FROM architect_team_meta WHERE status<'running' OR (status>'running' AND status<'waiting') OR status>'waiting' UNION ALL SELECT session_id FROM architect_team_meta WHERE status IS NULL AND valid_json=0) ORDER BY rowid";

/// The working teams `reconcile` settles, in save order, through the `architect_team_meta_status`
/// index (the same test as `architect::ACTIVE_TEAMS`).
const RECONCILE_CANDIDATES_SQL: &str = "SELECT session_id FROM architect_teams WHERE session_id IN (SELECT session_id FROM architect_team_meta WHERE status IN ('running','waiting')) ORDER BY rowid";

fn session_ids(db: &rusqlite::Connection, sql: &str) -> Result<Vec<String>> {
    let mut query = db.prepare_cached(sql).map_err(|e| e.to_string())?;
    let rows = query.query_map([], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
    rows.collect::<std::result::Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// The tracker query for the v38 benchmark and query-plan fixtures.
#[cfg(test)]
pub(crate) fn stale_candidates(db: &rusqlite::Connection) -> Result<Vec<String>> {
    session_ids(db, STALE_CANDIDATES_SQL)
}

/// The tracker query for the v38 benchmark and query-plan fixtures.
#[cfg(test)]
pub(crate) fn reconcile_candidates(db: &rusqlite::Connection) -> Result<Vec<String>> {
    session_ids(db, RECONCILE_CANDIDATES_SQL)
}

/// `stale_candidates`' rows from the snapshots themselves, for a newer schema without a usable
/// `architect_team_meta`.
const STALE_CANDIDATES_FALLBACK_SQL: &str = "SELECT session_id FROM architect_teams WHERE CASE WHEN json_valid(content) THEN json_extract(content,'$.status') NOT IN ('running','waiting') ELSE 1 END ORDER BY session_id";
/// `reconcile_candidates`' rows from the snapshots themselves.
const RECONCILE_CANDIDATES_FALLBACK_SQL: &str = "SELECT session_id FROM architect_teams WHERE json_valid(content) AND json_extract(content,'$.status') IN ('running','waiting') ORDER BY session_id";

/// `stale_candidates`, through the snapshots when `store`'s team tracker is unusable.
pub(crate) fn stale_candidates_in(store: &Store) -> Result<Vec<String>> {
    session_ids(&store.db, if store.team_meta_usable() { STALE_CANDIDATES_SQL } else { STALE_CANDIDATES_FALLBACK_SQL })
}

/// `reconcile_candidates`, through the snapshots when `store`'s team tracker is unusable.
pub(crate) fn reconcile_candidates_in(store: &Store) -> Result<Vec<String>> {
    session_ids(&store.db, if store.team_meta_usable() { RECONCILE_CANDIDATES_SQL } else { RECONCILE_CANDIDATES_FALLBACK_SQL })
}

/// Teams saved by older versions can be failed, paused or completed with workers still saved as
/// running: `reconcile` never looks at inactive teams, so this runs once at startup and settles
/// every active worker without a process in such a team as stopped. Returns how many it settled.
pub(super) fn settle_stale(state: &AppState, notify: &mut impl FnMut(&TeamSnapshot)) -> Result<usize> {
    let agents = crate::run_requests::lock_agents(&state.agents).map_err(|e| e.to_string())?;
    let store = state.store.lock().map_err(|e| e.to_string())?;
    let teams = stale_candidates_in(&store)?;
    let mut settled = 0;
    for sid in &teams {
        // This pass runs once: one unreadable team must not cost the others theirs.
        let mut team = match load(&store, sid) {
            Ok(Some(team)) => team,
            Ok(None) => continue,
            Err(error) => {
                eprintln!("Team watchdog: team {sid}: {error}");
                continue;
            }
        };
        let stale: Vec<usize> = team.workers.iter().enumerate().filter(|(_, w)| active(&w.status) && !agents.contains_key(&w.session_id)).map(|(i, _)| i).collect();
        if stale.is_empty() {
            continue;
        }
        let count = stale.len();
        for index in stale {
            let worker = &mut team.workers[index];
            worker.status = "stopped".into();
            worker.updated_at = storage::now();
        }
        if let Err(error) = save(&store, &mut team) {
            eprintln!("Team watchdog: team {sid}: {error}");
            continue;
        }
        settled += count;
        notify(&team);
    }
    Ok(settled)
}

/// Settles what no event will settle. Returns whether any team is active, so the caller runs the
/// scheduler too: one missed wake never strands a team. Lock order is registry, then store.
pub(super) fn reconcile(
    state: &AppState,
    now: i64,
    notify: &mut impl FnMut(&TeamSnapshot),
) -> Result<bool> {
    let agents = crate::run_requests::lock_agents(&state.agents).map_err(|e| e.to_string())?;
    if state.shutdown.load(Ordering::SeqCst) != 0 {
        return Ok(false);
    }
    let teams = {
        let store = state.store.lock().map_err(|e| e.to_string())?;
        reconcile_candidates_in(&store)?
    };
    for sid in &teams {
        if let Err(error) = reconcile_team(state, &agents, sid, now, notify) {
            eprintln!("Team watchdog: team {sid}: {error}");
        }
    }
    Ok(!teams.is_empty())
}

fn reconcile_team(
    state: &AppState,
    agents: &std::collections::HashMap<String, crate::RunningAgent>,
    sid: &str,
    now: i64,
    notify: &mut impl FnMut(&TeamSnapshot),
) -> Result<()> {
    let team = load(&*state.store.lock().map_err(|e| e.to_string())?, sid)?.ok_or("Team unavailable.")?;
    let orphans = team.workers.iter().filter(|w| {
        active(&w.status) && !agents.contains_key(&w.session_id) && now - w.updated_at >= ORPHAN_AFTER_MS
    });
    let admission = Admission { parent: team.session_id.clone(), generation: team.generation };
    for worker in orphans {
        // The same path as a failed run, so sub-workers settle and the lead is woken.
        completed_with_agents(state, agents, &worker.session_id, Some(&admission), false, false, Some(ORPHANED), notify);
    }
    release_reservation(state, agents, sid, now, notify)
}

/// A reserved lead turn with no agent lost its launch; without this its team would wait forever.
/// Saved teams are read again because settling an orphan above saves the team.
fn release_reservation(
    state: &AppState,
    agents: &std::collections::HashMap<String, crate::RunningAgent>,
    sid: &str,
    now: i64,
    notify: &mut impl FnMut(&TeamSnapshot),
) -> Result<()> {
    let store = state.store.lock().map_err(|e| e.to_string())?;
    let mut team = load(&store, sid)?.ok_or("Team unavailable.")?;
    if agents.contains_key(sid) {
        return Ok(());
    }
    let Some(pending) = team.pending_turn.as_mut().filter(|pending| pending.reserved && now - pending.reserved_at >= ORPHAN_AFTER_MS) else {
        return Ok(());
    };
    pending.reserved = false;
    save(&store, &mut team)?;
    notify(&team);
    Ok(())
}

#[cfg(test)]
mod query_tests {
    use super::*;

    /// The queries these helpers replaced, kept to prove the rewrites list the same rows.
    const OLD_RUNNABLE: &str = "SELECT session_id,content FROM architect_teams WHERE json_valid(content) AND (json_extract(content,'$.status') IN ('running','waiting') OR EXISTS(SELECT 1 FROM architect_workers aw JOIN sessions s ON s.id=aw.session_id WHERE aw.parent_session_id=architect_teams.session_id AND s.status IN ('running','waiting'))) ORDER BY json_extract(content,'$.updatedAt'),session_id";
    const OLD_STALE: &str = "SELECT session_id FROM architect_teams WHERE CASE WHEN json_valid(content) THEN json_extract(content,'$.status') NOT IN ('running','waiting') ELSE 1 END";
    const OLD_ACTIVE: &str = "SELECT session_id FROM architect_teams WHERE json_valid(content) AND json_extract(content,'$.status') IN ('running','waiting')";
    /// A real store, so the tests run against the migrated schema and its indexes, with the
    /// two indexes these queries are written for dropped when `indexed` is false.
    fn store(indexed: bool) -> Store {
        let store = Store::open(std::path::Path::new(":memory:")).unwrap();
        let db = &store.db;
        if !indexed {
            db.execute_batch("DROP INDEX architect_team_meta_status; DROP INDEX sessions_active_status;").unwrap();
        }
        db.execute("INSERT INTO projects(id,name,path) VALUES('p','p','/p')", []).unwrap();
        let session = |id: &str, status: &str| {
            db.execute("INSERT INTO sessions(id,project_id,title,provider,model,mode,status,created_at,updated_at) VALUES(?1,'p',?1,'codex','default','full',?2,0,0)", [id, status]).unwrap();
        };
        let teams = [
            ("a", r#"{"status":"running","updatedAt":5}"#),
            ("b", r#"{"status":"waiting","updatedAt":3}"#),
            ("c", r#"{"status":"paused","updatedAt":3}"#),
            ("d", r#"{"status":"completed","updatedAt":1}"#),
            ("e", "not json"),
            ("f", "{}"),
            ("g", r#"{"status":5}"#),
            ("h", r#"{"status":"s"}"#),
            ("i", r#"{"status":"zzz"}"#),
            ("j", r#"{"status":null}"#),
            ("k", r#"{"status":["running"]}"#),
            ("l", r#"{"status":"Running"}"#),
            ("m", r#"{"status":"failed"}"#),
            ("n", r#"{"status":true}"#),
            ("o", r#"{"status":123}"#),
            ("q", "{bad"),
        ];
        for (sid, content) in teams {
            session(sid, "idle");
            db.execute("INSERT INTO architect_teams(session_id,content) VALUES(?1,?2)", [sid, content]).unwrap();
        }
        // Workers still running under inactive, broken and active teams, and a settled one.
        for (parent, worker, status) in [("c", "c1", "running"), ("d", "d1", "idle"), ("e", "e1", "waiting"), ("m", "m1", "waiting"), ("m", "m2", "running"), ("a", "a1", "running")] {
            session(worker, status);
            db.execute("INSERT INTO architect_workers(parent_session_id,worker_id,session_id) VALUES(?1,?2,?2)", [parent, worker]).unwrap();
        }
        store
    }

    fn column<T: rusqlite::types::FromSql>(db: &rusqlite::Connection, sql: &str) -> Vec<T> {
        let mut query = db.prepare(sql).unwrap();
        let rows = query.query_map([], |r| r.get(0)).unwrap();
        rows.collect::<rusqlite::Result<_>>().unwrap()
    }

    fn plan(db: &rusqlite::Connection, sql: &str) -> String {
        let mut query = db.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
        let rows = query.query_map([], |r| r.get::<_, String>(3)).unwrap();
        rows.collect::<rusqlite::Result<Vec<_>>>().unwrap().join("\n")
    }

    #[test]
    fn rewritten_team_queries_list_what_the_old_ones_did() {
        for indexed in [false, true] {
            let store = store(indexed);
            let db = &store.db;
            let old: Vec<(String, String)> = {
                let mut query = db.prepare(OLD_RUNNABLE).unwrap();
                let rows = query.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
                rows.collect::<rusqlite::Result<_>>().unwrap()
            };
            let runnable = crate::architect::runnable_team_rows(db).unwrap();
            assert_eq!(runnable, old, "indexed: {indexed}");
            assert_eq!(crate::architect::team_rows(db, crate::architect::RUNNABLE_TEAMS_FALLBACK_SQL).unwrap(), old);
            assert_eq!(runnable.iter().map(|r| r.0.as_str()).collect::<Vec<_>>(), ["m", "b", "c", "a"]);
            assert_eq!(stale_candidates(db).unwrap(), column::<String>(db, OLD_STALE), "indexed: {indexed}");
            assert_eq!(stale_candidates(db).unwrap(), ["c", "d", "e", "g", "h", "i", "k", "l", "m", "n", "o", "q"]);
            assert_eq!(reconcile_candidates(db).unwrap(), column::<String>(db, OLD_ACTIVE), "indexed: {indexed}");
            assert_eq!(reconcile_candidates(db).unwrap(), ["a", "b"]);
        }
    }

    #[test]
    fn team_queries_read_the_status_index_instead_of_every_snapshot() {
        let store = store(true);
        let db = &store.db;
        let runnable_plan = plan(db, crate::architect::RUNNABLE_TEAMS_SQL);
        assert!(!runnable_plan.contains("SCAN architect_teams"), "{runnable_plan}");
        assert!(runnable_plan.contains("architect_team_meta_status") && runnable_plan.contains("sessions_active_status"), "{runnable_plan}");
        for sql in [crate::architect::ACTIVE_TEAMS, STALE_CANDIDATES_SQL, RECONCILE_CANDIDATES_SQL] {
            let plan = plan(db, sql);
            assert!(!plan.contains("SCAN architect_teams") && plan.contains("architect_team_meta_status"), "{plan}");
        }
    }

    #[test]
    fn active_team_session_ids_lists_working_teams() {
        let path = std::env::temp_dir().join(format!("pandacode-active-teams-{}.db", storage::id()));
        {
            let store = Store::open(&path).unwrap();
            let project = store.add_project(&std::env::temp_dir()).unwrap();
            let mut expected = std::collections::HashSet::new();
            for status in ["running", "waiting", "paused", "completed"] {
                let sid = store.create_session(&project.id, "codex", "default", "full").unwrap().id;
                store.db.execute("INSERT INTO architect_teams(session_id,content) VALUES(?1,?2)", params![sid, json!({ "status": status }).to_string()]).unwrap();
                if active(status) {
                    expected.insert(sid);
                }
            }
            assert_eq!(crate::architect::active_team_session_ids(&store).unwrap(), expected);
        }
        let _ = std::fs::remove_file(&path);
    }
}

#[cfg(test)]
mod team_meta_tests {
    use super::*;

    fn team(store: &Store) -> TeamSnapshot {
        let project = store.add_project(&std::env::temp_dir()).unwrap();
        let sid = store.create_session(&project.id, "codex", "default", "full").unwrap().id;
        let config: TeamConfig = serde_json::from_value(json!({"workers":[],"maxParallel":1,"maxRounds":1,"maxAssignments":1,"workspace":"shared","summaryLimit":100})).unwrap();
        crate::architect::new_team(sid, config)
    }

    /// `(status, valid_json, needs_legacy_cutoff, skip_sync)` of a team's tracker row.
    fn meta(store: &Store, sid: &str) -> (Option<String>, i64, i64, i64) {
        store.db.query_row("SELECT status,valid_json,needs_legacy_cutoff,skip_sync FROM architect_team_meta WHERE session_id=?1", [sid], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).unwrap()
    }

    #[test]
    fn newer_schema_uses_team_snapshots_when_metadata_is_incompatible() {
        assert_newer_schema_team_fallback(false);
    }

    #[test]
    fn newer_schema_team_fallback_accepts_without_rowid() {
        assert_newer_schema_team_fallback(true);
    }

    fn assert_newer_schema_team_fallback(without_rowid: bool) {
        let directory = std::env::temp_dir().join(format!("pandacode-newer-team-{}", storage::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("store.sqlite");
        let store = Store::open(&path).unwrap();
        let mut running = team(&store);
        running.status = "running".into();
        running.legacy_prompt_through_id = None;
        let prompt = store.begin_task_turn(&running.session_id, "Begin").unwrap();
        save(&store, &mut running).unwrap();
        let running_project = store.session(&running.session_id).unwrap().project_id;
        let broken_project = store.add_project(&directory).unwrap();
        let broken = store.create_session(&broken_project.id, "codex", "default", "full").unwrap();
        let malformed = r#"{"status":"completed""#;
        store.db.execute("INSERT INTO architect_teams(session_id,content) VALUES(?1,?2)", params![broken.id, malformed]).unwrap();
        store.db.execute_batch(
            "DROP TRIGGER architect_team_meta_insert;
             DROP TRIGGER architect_team_meta_update_clear;
             DROP TRIGGER architect_team_meta_update_sync;
             DROP TABLE architect_team_meta;
             CREATE TABLE architect_team_meta(session_id TEXT PRIMARY KEY, status, valid_json, needs_legacy_cutoff);
             PRAGMA user_version=39;",
        ).unwrap();
        if without_rowid {
            store.db.execute_batch("ALTER TABLE architect_teams RENAME TO old_teams;
                CREATE TABLE architect_teams(session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, content TEXT NOT NULL) WITHOUT ROWID;
                INSERT INTO architect_teams SELECT * FROM old_teams;
                DROP TABLE old_teams;").unwrap();
        }
        drop(store);

        let store = Store::open(&path).unwrap();
        assert!(!store.team_meta_usable());
        let triggers: i64 = store.db.query_row("SELECT count(*) FROM sqlite_master WHERE type='trigger' AND tbl_name='architect_teams'", [], |row| row.get(0)).unwrap();
        assert_eq!(triggers, 0);
        let mut recovered = load(&store, &running.session_id).unwrap().unwrap();
        assert_eq!(recovered.status, "interrupted");
        assert_eq!(recovered.legacy_prompt_through_id, Some(prompt));
        assert!(!crate::architect::is_active(&store, &recovered.session_id));
        assert!(reconcile_candidates_in(&store).unwrap().is_empty());
        let mut expected = [recovered.session_id.clone(), broken.id.clone()];
        expected.sort();
        assert_eq!(stale_candidates_in(&store).unwrap(), expected);

        recovered.status = "waiting".into();
        save(&store, &mut recovered).unwrap();
        assert!(crate::architect::is_active(&store, &recovered.session_id));
        assert!(!crate::architect::is_active(&store, &broken.id));
        assert_eq!(crate::architect::active_team_session_ids(&store).unwrap(), HashSet::from([recovered.session_id.clone()]));
        let runnable = crate::architect::runnable_team_rows_in(&store).unwrap();
        assert_eq!(runnable, [(recovered.session_id.clone(), serde_json::to_string(&recovered).unwrap())]);
        assert_eq!(reconcile_candidates_in(&store).unwrap(), std::slice::from_ref(&recovered.session_id));
        assert_eq!(stale_candidates_in(&store).unwrap(), std::slice::from_ref(&broken.id));

        assert_eq!(crate::remove_project_with_team_check(&store, &running_project).unwrap_err(), "Stop this project's architect teams first.");
        assert!(crate::remove_project_with_team_check(&store, &broken_project.id).unwrap_err().contains("malformed JSON"));
        for (project, sid, snapshot) in [(&running_project, &recovered.session_id, runnable[0].1.as_str()), (&broken_project.id, &broken.id, malformed)] {
            assert!(store.project(project).is_ok());
            assert!(store.session(sid).is_ok());
            let content: String = store.db.query_row("SELECT content FROM architect_teams WHERE session_id=?1", [sid], |row| row.get(0)).unwrap();
            assert_eq!(content, snapshot);
        }
        drop(store);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn saving_keeps_the_team_tracker_in_step() {
        let store = Store::open(std::path::Path::new(":memory:")).unwrap();
        let mut team = team(&store);
        team.status = "running".into();
        team.legacy_prompt_through_id = None;
        save(&store, &mut team).unwrap();
        assert_eq!(meta(&store, &team.session_id), (Some("running".into()), 1, 1, 0), "a new team is tracked by its insert trigger");
        assert!(crate::architect::is_active(&store, &team.session_id));
        team.status = "waiting".into();
        team.legacy_prompt_through_id = Some(7);
        save(&store, &mut team).unwrap();
        assert_eq!(meta(&store, &team.session_id), (Some("waiting".into()), 1, 0, 0), "an update writes the tracker itself and clears skip_sync");
        team.status = "completed".into();
        team.legacy_prompt_through_id = None;
        save(&store, &mut team).unwrap();
        assert_eq!(meta(&store, &team.session_id), (Some("completed".into()), 1, 1, 0));
        assert!(!crate::architect::is_active(&store, &team.session_id));
        // The tracker agrees with what the triggers would derive from the snapshot itself.
        let derived: (Option<String>, i64) = store.db.query_row("SELECT json_extract(content,'$.status'),COALESCE(json_type(content,'$.legacyPromptThroughId'),'null')='null' FROM architect_teams WHERE session_id=?1", [&team.session_id], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!(derived, (Some("completed".into()), 1));
        assert!(store.db.is_autocommit(), "the savepoint is released");
    }

    #[test]
    fn a_failed_save_rolls_its_tracker_write_back_inside_a_transaction() {
        let store = Store::open(std::path::Path::new(":memory:")).unwrap();
        let mut team = team(&store);
        team.status = "running".into();
        save(&store, &mut team).unwrap();
        store.db.execute_batch("CREATE TEMP TRIGGER refuse_team_save BEFORE UPDATE ON main.architect_teams BEGIN SELECT RAISE(ABORT,'refused'); END;").unwrap();
        store.db.execute_batch("BEGIN").unwrap();
        team.status = "completed".into();
        assert!(save(&store, &mut team).is_err());
        assert!(!store.db.is_autocommit(), "the caller's transaction is still open");
        assert_eq!(meta(&store, &team.session_id), (Some("running".into()), 1, 0, 0), "the savepoint rolled the tracker write back");
        store.db.execute_batch("COMMIT").unwrap();
        assert_eq!(meta(&store, &team.session_id), (Some("running".into()), 1, 0, 0));
        // Standalone, too.
        assert!(save(&store, &mut team).is_err());
        assert!(store.db.is_autocommit());
        assert_eq!(meta(&store, &team.session_id), (Some("running".into()), 1, 0, 0));
    }

    #[test]
    fn a_failed_standalone_save_leaves_no_transaction_open() {
        let store = Store::open(std::path::Path::new(":memory:")).unwrap();
        let mut team = team(&store);
        team.status = "running".into();
        save(&store, &mut team).unwrap();
        let sid = team.session_id.clone();
        // A constraint error fails only its statement; RAISE(ROLLBACK) rolls back the whole
        // transaction the savepoint opened. Neither may leave one open or keep skip_sync set.
        for body in ["SELECT RAISE(ABORT,'refused')", "SELECT RAISE(ROLLBACK,'refused')", "SELECT RAISE(IGNORE)"] {
            store.db.execute_batch(&format!("CREATE TEMP TRIGGER refuse_team_save BEFORE UPDATE ON main.architect_teams BEGIN {body}; END;")).unwrap();
            team.status = "completed".into();
            assert!(save(&store, &mut team).is_err(), "{body}");
            assert!(store.db.is_autocommit(), "{body}: no transaction is left open");
            assert_eq!(load(&store, &sid).unwrap().unwrap().status, "running", "{body}");
            assert_eq!(meta(&store, &sid), (Some("running".into()), 1, 0, 0), "{body}: skip_sync is clear");
            store.db.execute_batch("DROP TRIGGER temp.refuse_team_save").unwrap();
            team.status = "paused".into();
            save(&store, &mut team).unwrap();
            assert!(store.db.is_autocommit(), "{body}: the next save commits");
            assert_eq!(meta(&store, &sid), (Some("paused".into()), 1, 0, 0));
            team.status = "running".into();
            save(&store, &mut team).unwrap();
        }
    }

    #[test]
    fn raw_team_writes_resync_the_tracker() {
        let store = Store::open(std::path::Path::new(":memory:")).unwrap();
        let mut team = team(&store);
        save(&store, &mut team).unwrap();
        let sid = team.session_id.clone();
        let write = |content: &str| store.db.execute("UPDATE architect_teams SET content=?2 WHERE session_id=?1", params![sid, content]).unwrap();
        write(r#"{"status":"running"}"#);
        assert_eq!(meta(&store, &sid), (Some("running".into()), 1, 1, 0));
        write(r#"{"status":"paused","legacyPromptThroughId":3}"#);
        assert_eq!(meta(&store, &sid), (Some("paused".into()), 1, 0, 0));
        write("{bad");
        assert_eq!(meta(&store, &sid), (None, 0, 0, 0));
        let typed: (i64, String) = {
            write(r#"{"status":123}"#);
            store.db.query_row("SELECT status,typeof(status) FROM architect_team_meta WHERE session_id=?1", [&sid], |r| Ok((r.get(0)?, r.get(1)?))).unwrap()
        };
        assert_eq!(typed, (123, "integer".into()), "the untyped column keeps json_extract's type");
        store.db.execute("DELETE FROM architect_teams WHERE session_id=?1", [&sid]).unwrap();
        let left: i64 = store.db.query_row("SELECT COUNT(*) FROM architect_team_meta", [], |r| r.get(0)).unwrap();
        assert_eq!(left, 0, "deleting a team cascades to its tracker row");
    }
}
