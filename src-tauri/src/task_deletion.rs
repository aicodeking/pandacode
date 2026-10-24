//! Local conversation deletion, serialized with task and harness admission.
use crate::{architect, jev, jev_decisions, storage::Store, terminal, AppState, Result};
use serde::Serialize;
use std::sync::atomic::Ordering;
use tauri::{Emitter, Manager};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletedSessions {
    pub deleted_session_ids: Vec<String>,
}

fn candidates(store: &Store, sid: &str) -> Result<Vec<String>> {
    store.session(sid)?;
    architect::check_manual(store, sid)?;
    let mut ids = vec![sid.to_owned()];
    let mut query = store.db.prepare(
        "SELECT session_id FROM architect_workers WHERE parent_session_id=?1 ORDER BY session_id",
    ).map_err(|e| e.to_string())?;
    let workers = query
        .query_map([sid], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    for worker in workers {
        ids.push(worker.map_err(|e| e.to_string())?);
    }
    for id in &ids {
        let task = store.session(id)?;
        if matches!(task.status.as_str(), "running" | "waiting") {
            return Err(
                "Stop this task and wait for its agents to finish before deleting it.".into(),
            );
        }
        if task.goal_state.is_some_and(|goal| goal.status == "active") {
            return Err("Pause this task's active goal before deleting it.".into());
        }
    }
    Ok(ids)
}

fn delete_owned(store: &Store, sid: &str, expected: &[String]) -> Result<()> {
    let transaction =
        rusqlite::Transaction::new_unchecked(&store.db, rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
    // Revalidate inside the transaction, including any changes made while the
    // runtime registries were inspected. Only this exact ownership set is removed.
    if candidates(store, sid)? != expected {
        return Err("The team changed. Review the task again before deleting it.".into());
    }
    // Parent deletion cascades the ownership mapping, not the worker sessions.
    // Delete children first, preserving unrelated conversations and forks.
    for id in expected.iter().skip(1).chain(expected.first()) {
        transaction
            .execute("DELETE FROM sessions WHERE id=?1", [id])
            .map_err(|e| e.to_string())?;
    }
    transaction.commit().map_err(|e| e.to_string())
}

pub(crate) fn delete_state(state: &AppState, sid: &str) -> Result<DeletedSessions> {
    // Agent, harness, team and Jev admissions share this lock. No process or
    // filesystem operations happen here; running work must be stopped first.
    let agents = state.agents.lock().map_err(|e| e.to_string())?;
    if state.shutdown.load(Ordering::SeqCst) != 0 {
        return Err("PandaCode is closing. Try again when it finishes.".into());
    }
    let ids = {
        let store = state.store.lock().map_err(|e| e.to_string())?;
        candidates(&store, sid)?
    };
    for id in &ids {
        if agents.contains_key(id) {
            return Err(
                "Stop this task and wait for its agents to finish before deleting it.".into(),
            );
        }
        if terminal::harness_running(&state.terminals, id)? {
            return Err("Close this task's harness console before deleting it.".into());
        }
    }
    if jev::active_for_tasks(&ids)? || jev_decisions::active_for_tasks(&ids)? {
        return Err(
            "Wait for this task's Jev browser test or assessment to finish before deleting it."
                .into(),
        );
    }
    let store = state.store.lock().map_err(|e| e.to_string())?;
    delete_owned(&store, sid, &ids)?;
    Ok(DeletedSessions {
        deleted_session_ids: ids,
    })
}

#[tauri::command]
pub async fn delete_session(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    session_id: String,
) -> Result<DeletedSessions> {
    if window.label() != "main" {
        return Err("Only the main window can delete tasks.".into());
    }
    // A deleted task never sends a follow-up; free its waiting agent.
    crate::providers::discard_warm_agent(&session_id);
    crate::blocking(move || {
        let cloud = app.state::<AppState>().store.lock().ok().and_then(|store| crate::cloud_agents::load(&store, &session_id).ok().flatten());
        let deleted = delete_state(&app.state::<AppState>(), &session_id)?;
        // Its cloud machine goes with it, best effort.
        crate::cloud_agents::tasks::forget_machine(cloud);
        let _ = app.emit(
            "sessions-deleted",
            serde_json::json!({
                "sessionIds": &deleted.deleted_session_ids,
            }),
        );
        let _ = app.emit("sessions-changed", ());
        Ok(deleted)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{concurrent_task_tests::test_state, storage::Store};
    use rusqlite::params;

    fn task(store: &Store, project: &str) -> String {
        store
            .create_session(project, "codex", "default", "ask")
            .unwrap()
            .id
    }

    fn owned_worker(store: &Store, parent: &str, project: &str) -> String {
        let child = task(store, project);
        store.db.execute("INSERT INTO architect_workers(parent_session_id,worker_id,session_id) VALUES(?1,?2,?2)", params![parent, child]).unwrap();
        child
    }

    #[test]
    fn deletes_owned_workers_and_history_but_preserves_other_conversations_and_project() {
        let (state, project) = test_state();
        let (parent, child, other) = {
            let store = state.store.lock().unwrap();
            let parent = task(&store, &project);
            let child = task(&store, &project);
            let other = task(&store, &project);
            store.db.execute("INSERT INTO architect_workers(parent_session_id,worker_id,session_id) VALUES(?1,'worker',?2)", params![parent, child]).unwrap();
            for sid in [&parent, &child, &other] {
                store.message(sid, "user", "Keep my project files").unwrap();
                let message = store.db.last_insert_rowid();
                store.db.execute("INSERT INTO subagents(session_id,id,content,updated_at) VALUES(?1,'sub','{}',0)", [sid]).unwrap();
                store.db.execute("INSERT INTO jev_assessments(id,session_id,created_at,report) VALUES(?1,?1,0,'{}')", [sid]).unwrap();
                store
                    .db
                    .execute(
                        "INSERT INTO context_recovery(session_id,through_message_id) VALUES(?1,?2)",
                        params![sid, message],
                    )
                    .unwrap();
                store.db.execute("INSERT INTO turn_changes(id,session_id,message_id,summary,created_at) VALUES(?1,?1,?2,'{}',0)", params![sid,message]).unwrap();
                store.db.execute("INSERT INTO turn_change_files(change_id,path,detail) VALUES(?1,'source.rs','{}')", [sid]).unwrap();
            }
            store.db.execute("INSERT INTO architect_requests(parent_session_id,key,kind,content,worker_id) VALUES(?1,'request','dispatch','{}','worker')", [&parent]).unwrap();
            store.db.execute("INSERT INTO architect_messages(parent_session_id,sender,recipient,request_key,content,created_at) VALUES(?1,'architect','worker','message','Hello',0)", [&parent]).unwrap();
            (parent, child, other)
        };
        let deleted = delete_state(&state, &parent).unwrap();
        assert_eq!(
            deleted.deleted_session_ids,
            vec![parent.clone(), child.clone()]
        );
        let store = state.store.lock().unwrap();
        assert!(store.session(&parent).is_err());
        assert!(store.session(&child).is_err());
        assert!(store.session(&other).is_ok());
        assert!(store.project(&project).is_ok());
        for table in [
            "messages",
            "subagents",
            "jev_assessments",
            "context_recovery",
            "turn_changes",
            "turn_change_files",
        ] {
            let count: i64 = store
                .db
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
                .unwrap();
            assert_eq!(count, 1, "{table}");
        }
        for table in [
            "architect_workers",
            "architect_requests",
            "architect_messages",
        ] {
            let count: i64 = store
                .db
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
                .unwrap();
            assert_eq!(count, 0, "{table}");
        }
        assert_eq!(store.sessions().unwrap().len(), 1);
    }

    #[test]
    fn managed_worker_must_be_deleted_through_its_parent() {
        let (state, project) = test_state();
        let (parent, child) = {
            let store = state.store.lock().unwrap();
            let parent = task(&store, &project);
            let child = owned_worker(&store, &parent, &project);
            (parent, child)
        };
        assert!(delete_state(&state, &child)
            .unwrap_err()
            .contains("managed"));
        let store = state.store.lock().unwrap();
        assert!(store.session(&parent).is_ok());
        assert!(store.session(&child).is_ok());
    }

    #[test]
    fn active_parent_or_worker_status_goal_and_reserved_run_block_deletion() {
        for target_worker in [false, true] {
            let (state, project) = test_state();
            let (parent, target) = {
                let store = state.store.lock().unwrap();
                let parent = task(&store, &project);
                let child = owned_worker(&store, &parent, &project);
                let target = if target_worker { child } else { parent.clone() };
                (parent, target)
            };
            for status in ["running", "waiting"] {
                state.store.lock().unwrap().status(&target, status).unwrap();
                assert!(delete_state(&state, &parent).unwrap_err().contains("Stop"));
            }
            state.store.lock().unwrap().status(&target, "idle").unwrap();
            let goal = serde_json::json!({"threadId":"native-thread","objective":"Keep working","status":"active","tokenBudget":null,"tokensUsed":0,"timeUsedSeconds":0,"createdAt":1,"updatedAt":1});
            state
                .store
                .lock()
                .unwrap()
                .db
                .execute(
                    "UPDATE sessions SET goal_state=?2 WHERE id=?1",
                    params![target, goal.to_string()],
                )
                .unwrap();
            assert!(delete_state(&state, &parent).unwrap_err().contains("goal"));
            state
                .store
                .lock()
                .unwrap()
                .db
                .execute("UPDATE sessions SET goal_state=NULL WHERE id=?1", [&target])
                .unwrap();
            let (tx, _rx) = crate::unbounded_channel();
            // A stop flag does not mean process cleanup or its callbacks finished.
            state.agents.lock().unwrap().insert(
                target.clone(),
                crate::RunningAgent::new(
                    tx,
                    std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true)),
                ),
            );
            assert!(delete_state(&state, &parent).unwrap_err().contains("Stop"));
            state.agents.lock().unwrap().remove(&target);
            assert!(delete_state(&state, &parent).is_ok());
        }
    }

    #[test]
    fn failure_after_worker_deletion_rolls_back_every_row_and_ownership() {
        let (state, project) = test_state();
        let (parent, child) = {
            let store = state.store.lock().unwrap();
            let parent = task(&store, &project);
            let child = owned_worker(&store, &parent, &project);
            store.message(&child, "assistant", "Worker result").unwrap();
            store.db.execute_batch("CREATE TRIGGER reject_parent_delete BEFORE DELETE ON sessions WHEN OLD.title='Keep parent' BEGIN SELECT RAISE(ABORT,'Injected deletion failure'); END;").unwrap();
            store
                .db
                .execute(
                    "UPDATE sessions SET title='Keep parent' WHERE id=?1",
                    [&parent],
                )
                .unwrap();
            (parent, child)
        };
        assert!(delete_state(&state, &parent)
            .unwrap_err()
            .contains("Injected deletion failure"));
        let store = state.store.lock().unwrap();
        assert!(store.session(&parent).is_ok());
        assert!(store.session(&child).is_ok());
        assert_eq!(architect::parent_of(&store, &child).unwrap(), Some(parent));
        assert_eq!(store.messages(&child, None).unwrap().len(), 1);
    }

    #[test]
    fn changed_ownership_or_new_activity_invalidates_the_checked_deletion_set() {
        let (state, project) = test_state();
        let store = state.store.lock().unwrap();
        let parent = task(&store, &project);
        let expected = candidates(&store, &parent).unwrap();
        let child = owned_worker(&store, &parent, &project);
        assert!(delete_owned(&store, &parent, &expected)
            .unwrap_err()
            .contains("team changed"));
        let expected = candidates(&store, &parent).unwrap();
        store.status(&child, "running").unwrap();
        assert!(delete_owned(&store, &parent, &expected).is_err());
        assert!(store.session(&parent).is_ok());
        assert!(store.session(&child).is_ok());
    }

    #[test]
    fn deletion_racing_agent_admission_never_leaves_a_run_without_its_task() {
        for _ in 0..12 {
            let (state, project) = test_state();
            let sid = task(&state.store.lock().unwrap(), &project);
            let barrier = std::sync::Barrier::new(2);
            let (deleted, admitted) = std::thread::scope(|scope| {
                let deletion = scope.spawn(|| {
                    barrier.wait();
                    delete_state(&state, &sid)
                });
                let admission = scope.spawn(|| {
                    let (tx, _rx) = crate::unbounded_channel();
                    barrier.wait();
                    crate::prepare_task_run(
                        &state,
                        sid.clone(),
                        Some("Summarize this project".into()),
                        vec![],
                        tx,
                        std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
                    )
                });
                (deletion.join().unwrap(), admission.join().unwrap())
            });
            assert_ne!(deleted.is_ok(), admitted.is_ok());
            assert_eq!(
                state.store.lock().unwrap().session(&sid).is_ok(),
                admitted.is_ok()
            );
            assert_eq!(
                state.agents.lock().unwrap().contains_key(&sid),
                admitted.is_ok()
            );
        }
    }

    #[test]
    fn project_worktree_files_provider_log_and_independent_fork_are_preserved() {
        let (state, _) = test_state();
        let dir =
            std::env::temp_dir().join(format!("pandacode-delete-test-{}", uuid::Uuid::new_v4()));
        let worktree = dir.join("worktree");
        std::fs::create_dir_all(&worktree).unwrap();
        let source = worktree.join("source.rs");
        let log = dir.join("provider-history.jsonl");
        std::fs::write(&source, "user code").unwrap();
        std::fs::write(&log, "provider transcript").unwrap();
        let (project, original, fork) = {
            let store = state.store.lock().unwrap();
            let project = store.add_project(&dir).unwrap().id;
            let original = task(&store, &project);
            let fork = task(&store, &project);
            for sid in [&original, &fork] {
                store.db.execute("UPDATE sessions SET worktree_path=?2,resume_id='same-provider-context' WHERE id=?1", params![sid,worktree.to_string_lossy()]).unwrap();
            }
            (project, original, fork)
        };
        delete_state(&state, &original).unwrap();
        let store = state.store.lock().unwrap();
        assert!(store.project(&project).is_ok());
        assert_eq!(
            store.session(&fork).unwrap().resume_id.as_deref(),
            Some("same-provider-context")
        );
        assert_eq!(std::fs::read_to_string(source).unwrap(), "user code");
        assert_eq!(std::fs::read_to_string(log).unwrap(), "provider transcript");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn shutdown_rejects_deletion_without_changing_the_task() {
        let (state, project) = test_state();
        let sid = task(&state.store.lock().unwrap(), &project);
        state.shutdown.store(1, Ordering::SeqCst);
        assert!(delete_state(&state, &sid).is_err());
        state.shutdown.store(0, Ordering::SeqCst);
        assert!(state.store.lock().unwrap().session(&sid).is_ok());
    }
}
