//! Whether a checkout is busy, and how worktree merge, removal and recreation quiesce it: which
//! sessions (running, or exiting in the background) hold a checkout, the refusals that keep a
//! worktree operation or a checks run from racing an agent, and the shared idle guard.
use crate::storage::{Session, Store};
use crate::{blocking, lock_agents, providers, skill_manager, workspace, worktree_paths, AppState, Result};
use std::path::{Path, PathBuf};

pub(crate) fn session_checkout_root(store: &Store, session_id: &str) -> Option<PathBuf> {
    let task = store.session(session_id).ok()?;
    if task.remote_device.is_some() {
        return None;
    }
    if let Some(worktree) = task.worktree_path {
        return Some(PathBuf::from(worktree));
    }
    store.project(&task.project_id).ok().map(|project| PathBuf::from(project.path))
}

/// Whether any of `others` is `root`, literally or once both are canonical.
pub(crate) fn any_same_checkout(root: &Path, others: &[PathBuf]) -> bool {
    let canonical = std::cell::OnceCell::new();
    others.iter().any(|other| {
        other == root
            || other
                .canonicalize()
                .ok()
                .is_some_and(|a| canonical.get_or_init(|| root.canonicalize().ok()).as_ref() == Some(&a))
    })
}

/// Whether any agent (other than `exclude_session`, when given) runs or has a pending exit in any
/// checkout in `roots`, literally or canonically. Snapshots `state.agents` before
/// `providers::pending_exits()` so a turn handing off to background reaping cannot slip between.
pub(crate) async fn any_checkout_busy_excluding(
    state: &AppState,
    roots: &[PathBuf],
    exclude_session: Option<&str>,
) -> Result<bool> {
    if roots.is_empty() {
        return Ok(false);
    }
    let running: Vec<String> = lock_agents(&state.agents)
        .map_err(|e| e.to_string())?
        .keys()
        .filter(|id| exclude_session != Some(id.as_str()))
        .cloned()
        .collect();
    let exiting: Vec<(String, Option<PathBuf>)> = providers::pending_exits()
        .into_iter()
        .filter(|(id, _)| exclude_session != Some(id.as_str()))
        .collect();
    if running.is_empty() && exiting.is_empty() {
        return Ok(false);
    }
    let store = state.store.clone();
    let roots = roots.to_vec();
    blocking(move || {
        let mut others = Vec::with_capacity(running.len() + exiting.len());
        {
            let store = store.lock().map_err(|e| e.to_string())?;
            for session_id in running {
                if let Some(other) = session_checkout_root(&store, &session_id) {
                    others.push(other);
                }
            }
            for (session_id, cwd) in exiting {
                if let Some(dir) = cwd {
                    others.push(dir);
                }
                if let Some(other) = session_checkout_root(&store, &session_id) {
                    others.push(other);
                }
            }
        }
        Ok(roots.iter().any(|root| any_same_checkout(root, &others)))
    })
    .await
}

/// Whether any agent is actively running (in `state.agents`) in `root`, literally or canonically.
pub(crate) async fn active_agent_in_state(state: &AppState, root: &Path) -> Result<bool> {
    let running: Vec<String> = lock_agents(&state.agents)
        .map_err(|e| e.to_string())?
        .keys()
        .cloned()
        .collect();
    if running.is_empty() {
        return Ok(false);
    }
    let store = state.store.clone();
    let root = root.to_path_buf();
    blocking(move || {
        let others: Vec<PathBuf> = {
            let store = store.lock().map_err(|e| e.to_string())?;
            running
                .into_iter()
                .filter_map(|session_id| session_checkout_root(&store, &session_id))
                .collect()
        };
        Ok(any_same_checkout(&root, &others))
    })
    .await
}

/// Session IDs in `providers::pending_exits()` whose recorded `cwd` or persisted workspace root
/// matches `root`, literally or canonically.
pub(crate) async fn pending_exit_sessions_in_state(state: &AppState, root: &Path) -> Result<Vec<String>> {
    let exiting = providers::pending_exits();
    if exiting.is_empty() {
        return Ok(Vec::new());
    }
    let store = state.store.clone();
    let root = root.to_path_buf();
    blocking(move || {
        let resolved: Vec<(String, Vec<PathBuf>)> = {
            let store = store.lock().map_err(|e| e.to_string())?;
            exiting
                .into_iter()
                .map(|(session_id, cwd)| {
                    let mut paths = Vec::with_capacity(2);
                    if let Some(dir) = cwd {
                        paths.push(dir);
                    }
                    if let Some(other) = session_checkout_root(&store, &session_id) {
                        paths.push(other);
                    }
                    (session_id, paths)
                })
                .collect()
        };
        Ok(resolved
            .into_iter()
            .filter_map(|(session_id, paths)| any_same_checkout(&root, &paths).then_some(session_id))
            .collect())
    })
    .await
}

/// Refuses checks while any agent is actively running in `root`, and patiently waits for
/// `session_id` and any sibling pending exits sharing `root` (matched by recorded `cwd` or
/// persisted workspace root) before re-checking for newly started agents.
pub(crate) async fn prepare_checkout_for_checks(state: &AppState, session_id: &str, root: &Path) -> Result<()> {
    const BUSY: &str = "Wait for the agent to finish first.";
    if active_agent_in_state(state, root).await? {
        return Err(BUSY.into());
    }
    let wait = async {
        providers::await_exit_patiently(session_id).await?;
        providers::await_exits_in_patiently(root).await?;
        loop {
            let sibling_ids = pending_exit_sessions_in_state(state, root).await?;
            if sibling_ids.is_empty() {
                return Ok::<(), String>(());
            }
            for id in sibling_ids {
                providers::await_exit_patiently(&id).await?;
            }
        }
    };
    tokio::time::timeout(providers::EXIT_HARD_CAP, wait)
        .await
        .map_err(|_| "The previous run of this conversation is still shutting down. Try again.".to_string())??;
    if active_agent_in_state(state, root).await? {
        return Err(BUSY.into());
    }
    Ok(())
}

/// Refuses a worktree merge while `session_id` is actively running or any OTHER session (or
/// unpersisted worker/spare with matching `cwd`) is actively running or exiting in either the
/// main checkout or the worktree. Allows `session_id`'s own pending exit so `merge_task_worktree`
/// awaits it cleanly.
pub(crate) async fn refuse_worktree_merge_busy(state: &AppState, session_id: &str) -> Result<()> {
    const BUSY: &str = "Wait for the agent to finish before merging its worktree.";
    if lock_agents(&state.agents).map_err(|e| e.to_string())?.contains_key(session_id) {
        return Err(BUSY.into());
    }
    let store = state.store.clone();
    let sid = session_id.to_owned();
    let roots = blocking(move || Ok(worktree_paths(&store, &sid).ok().map(|(main, path, _)| vec![main, path]))).await?;
    if let Some(roots) = roots {
        if any_checkout_busy_excluding(state, &roots, Some(session_id)).await? {
            return Err(BUSY.into());
        }
    }
    Ok(())
}

/// Refuses a worktree removal while `session_id` is actively running or any OTHER session (a
/// forked task or team worker sharing `worktree_path`, or an unpersisted worker/spare with
/// matching `cwd`) is actively running or exiting in the worktree. Allows `session_id`'s own
/// pending exit so `remove_task_worktree` quiesces it cleanly.
pub(crate) async fn refuse_worktree_remove_busy(state: &AppState, session_id: &str) -> Result<()> {
    const BUSY: &str = "Stop the agent before removing its worktree.";
    if lock_agents(&state.agents).map_err(|e| e.to_string())?.contains_key(session_id) {
        return Err(BUSY.into());
    }
    let store = state.store.clone();
    let sid = session_id.to_owned();
    let roots = blocking(move || Ok(worktree_paths(&store, &sid).ok().map(|(_, path, _)| vec![path]))).await?;
    if let Some(roots) = roots {
        if any_checkout_busy_excluding(state, &roots, Some(session_id)).await? {
            return Err(BUSY.into());
        }
    }
    Ok(())
}

/// Refuse while `busy()`, wait for `wait` (the session's CLI exits), then refuse again: a run may
/// have started meanwhile. The one guard of worktree merge and removal.
pub(crate) async fn guard_idle(
    busy: impl Fn() -> bool,
    wait: impl std::future::Future<Output = Result<()>>,
    message: &str,
) -> Result<()> {
    if busy() {
        return Err(message.into());
    }
    wait.await?;
    if busy() {
        return Err(message.into());
    }
    Ok(())
}

/// Refuse other activity before and after retiring this task's CLI. Recreation also retires
/// every idle process in the old folder before its final check; removal does that after it has
/// resolved its worktree paths. Merge keeps its await-only guard (it need not discard spares).
pub(crate) async fn quiesce_worktree<F: std::future::Future<Output = Result<()>>>(
    state: &AppState,
    session_id: &str,
    message: &str,
    refuse_busy: impl Fn() -> F,
    folder: Option<&Path>,
) -> Result<()> {
    refuse_busy().await?;
    guard_idle(
        || lock_agents(&state.agents).map_or(true, |agents| agents.contains_key(session_id)),
        providers::quiesce(session_id),
        message,
    )
    .await?;
    if let Some(folder) = folder {
        providers::end_lingering_in(folder).await;
        providers::quiesce_spares_in(folder).await?;
    }
    refuse_busy().await
}

pub(crate) async fn recreate_task_worktree(state: &AppState, session_id: String) -> Result<Session> {
    const BUSY: &str = "Stop the agent before recreating its worktree.";
    if lock_agents(&state.agents).map_err(|e| e.to_string())?.contains_key(&session_id) {
        return Err(BUSY.into());
    }
    let (_, path, _) = worktree_paths(&state.store, &session_id)?;
    // Retire pooled/lingering processes pinned to the deleted folder's old inode too.
    quiesce_worktree(
        state,
        &session_id,
        BUSY,
        || async {
            if lock_agents(&state.agents).map_err(|e| e.to_string())?.contains_key(&session_id)
                || any_checkout_busy_excluding(state, std::slice::from_ref(&path), Some(&session_id)).await?
            {
                return Err(BUSY.into());
            }
            Ok(())
        },
        Some(&path),
    )
    .await?;
    let store = state.store.clone();
    blocking(move || {
        let (main, path, branch) = worktree_paths(&store, &session_id)?;
        workspace::recreate_worktree(&main, &path, branch.as_deref())?;
        skill_manager::projects_changed();
        store.lock().map_err(|e| e.to_string())?.session(&session_id)
    })
    .await
}
