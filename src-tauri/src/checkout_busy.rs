//! Whether a checkout is busy, and how worktree merge, removal and recreation quiesce it: which
//! sessions (running, or exiting in the background) hold a checkout, the refusals that keep a
//! worktree operation or a checks run from racing an agent, and the shared idle guard.
use crate::path_match::{path_in_folder, resolve_path};
use crate::storage::Store;
use crate::{blocking, lock_agents, providers, worktree_paths, Agents, AppState, Result};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};

static RESERVATIONS: LazyLock<Mutex<Reservations>> =
    LazyLock::new(|| Mutex::new(Reservations::default()));

#[derive(Default)]
struct Reservations {
    next: u64,
    active: Vec<(usize, u64, Vec<PathBuf>)>,
}

impl Reservations {
    fn conflicts(&self, owner: usize, checkout: &Path) -> bool {
        self.active.iter().any(|(reserved_owner, _, roots)| {
            *reserved_owner == owner && roots.iter().any(|root| checkout_overlaps(root, checkout))
        })
    }

    fn reserve_for(&mut self, owner: usize, roots: Vec<PathBuf>, busy_message: &str) -> Result<u64> {
        if roots.iter().any(|root| self.conflicts(owner, root)) {
            return Err(busy_message.into());
        }
        let token = self.next;
        self.next += 1;
        self.active.push((owner, token, roots));
        Ok(token)
    }

    fn release(&mut self, token: u64) {
        self.active.retain(|(_, reserved_token, _)| *reserved_token != token);
    }
}

pub(crate) struct Reservation {
    token: u64,
}

impl Drop for Reservation {
    fn drop(&mut self) {
        RESERVATIONS.lock().unwrap_or_else(std::sync::PoisonError::into_inner).release(self.token);
    }
}

/// Called with the agents lock held during admission.
pub(crate) fn checkout_reserved(agents: &Agents, checkout: &Path) -> bool {
    RESERVATIONS.lock().map_or(true, |reservations| {
        reservations.conflicts(Arc::as_ptr(agents) as usize, checkout)
    })
}

/// Check and reserve under the same agents lock used to admit local runs.
pub(crate) async fn reserve_idle_checkouts(
    state: &AppState,
    roots: Vec<PathBuf>,
    busy_message: &'static str,
) -> Result<Reservation> {
    let agents = state.agents.clone();
    let store = state.store.clone();
    blocking(move || {
        let agents_guard = lock_agents(&agents).map_err(|e| e.to_string())?;
        let exiting = providers::pending_exits();
        let others: Vec<PathBuf> = {
            let store = store.lock().map_err(|e| e.to_string())?;
            agents_guard.keys().filter_map(|id| session_checkout_root(&store, id))
                .chain(exiting.into_iter().flat_map(|(id, cwd)| {
                    cwd.into_iter().chain(session_checkout_root(&store, &id))
                }))
                .collect()
        };
        if roots.iter().any(|root| any_same_checkout(root, &others)) {
            return Err(busy_message.into());
        }
        let token = RESERVATIONS.lock().map_err(|e| e.to_string())?
            .reserve_for(Arc::as_ptr(&agents) as usize, roots, busy_message)?;
        Ok(Reservation { token })
    })
    .await
}

fn session_checkout_root(store: &Store, session_id: &str) -> Option<PathBuf> {
    let task = store.session(session_id).ok()?;
    if task.remote_device.is_some() {
        return None;
    }
    if let Some(worktree) = task.worktree_path {
        return Some(PathBuf::from(worktree));
    }
    store.project(&task.project_id).ok().map(|project| PathBuf::from(project.path))
}

/// Whether any of `others` is `root` or lies inside it (an agent working in a subfolder of the
/// checkout), literally or once both resolve through `path_match::resolve_path`, which also
/// matches a deleted folder recorded under its symlinked or canonical spelling. The same matcher
/// as folder-scoped spare discard and `await_exits_in`, except that a path inside a linked
/// worktree nested below `root` (one under `root/.claude/worktrees`) is that worktree's.
pub(crate) fn any_same_checkout(root: &Path, others: &[PathBuf]) -> bool {
    let root_resolved = resolve_path(root);
    others.iter().any(|other| path_in_checkout(other, root, &root_resolved))
}

fn path_in_checkout(other: &Path, root: &Path, resolved: &Path) -> bool {
    path_in_folder(other, root, resolved) && !in_nested_checkout(other, root, resolved)
}

fn checkout_overlaps(a: &Path, b: &Path) -> bool {
    path_in_checkout(b, a, &resolve_path(a)) || path_in_checkout(a, b, &resolve_path(b))
}

/// Whether `other` (inside `root`) belongs to a linked worktree strictly below `root`'s own
/// checkout. Only when `root` is itself in a checkout: a plain folder still counts every
/// repository inside it. Submodules and vendored `.git` folders are part of `root`'s working tree
/// (their writes touch it), so they still count; plain subfolders, deleted paths and non-git
/// folders resolve to `root`'s checkout or none. `other` is resolved first: the checkout walk
/// is lexical, so `root/.claude/worktrees/x/..` would otherwise pass through `x` and be taken
/// for that worktree although it names a folder of `root`'s own checkout.
fn in_nested_checkout(other: &Path, root: &Path, root_resolved: &Path) -> bool {
    let other_resolved = resolve_path(other);
    let Some(other_root) = crate::claude_roots::git_checkout_root(&other_resolved) else { return false };
    let other_root_resolved = resolve_path(&other_root);
    other_root_resolved != root_resolved
        && path_in_folder(&other_root_resolved, root, root_resolved)
        && crate::claude_roots::git_checkout_root(root).is_some()
        && crate::claude_roots::is_linked_worktree_root(&other_root)
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

/// Distinct session IDs in `providers::pending_exits()` whose recorded `cwd` or persisted workspace
/// root matches `root`, literally or canonically, in the order of the first matching exit.
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
        let mut seen = std::collections::HashSet::new();
        Ok(resolved
            .into_iter()
            .filter_map(|(session_id, paths)| {
                (any_same_checkout(&root, &paths) && seen.insert(session_id.clone())).then_some(session_id)
            })
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

#[cfg(test)]
mod tests {
    use super::{any_same_checkout, checkout_reserved, Reservation, RESERVATIONS};
    use std::path::PathBuf;

    #[test]
    fn nested_linked_worktrees_are_their_own_checkouts() {
        let base = std::env::temp_dir().join(format!("pandacode-checkout-nested-{}", uuid::Uuid::new_v4().simple()));
        let main = base.join("main");
        let nested = main.join(".claude").join("worktrees").join("x");
        let admin = main.join(".git").join("worktrees").join("x");
        for dir in [admin.clone(), main.join("src"), nested.join("src")] {
            std::fs::create_dir_all(dir).unwrap();
        }
        std::fs::write(admin.join("commondir"), "../..\n").unwrap();
        std::fs::write(nested.join(".git"), "gitdir: ../../../.git/worktrees/x\n").unwrap();
        assert!(any_same_checkout(&main, std::slice::from_ref(&main)));
        assert!(any_same_checkout(&main, &[main.join("src")]), "a plain subfolder is the same checkout");
        assert!(!any_same_checkout(&main, std::slice::from_ref(&nested)), "a nested worktree is another checkout");
        assert!(!any_same_checkout(&main, &[nested.join("src")]));
        assert!(any_same_checkout(&nested, &[nested.join("src")]), "the nested worktree still matches itself");
        assert!(!any_same_checkout(&nested, std::slice::from_ref(&main)));
        assert!(any_same_checkout(&base, std::slice::from_ref(&nested)), "a plain folder counts every repository inside it");
        let agents = crate::Agents::default();
        let other_agents = crate::Agents::default();
        let owner = std::sync::Arc::as_ptr(&agents) as usize;
        let reserve = |path| RESERVATIONS.lock().unwrap().reserve_for(owner, vec![path], "busy")
            .map(|token| Reservation { token });
        let reservation = reserve(main.clone()).unwrap();
        for overlap in [main.clone(), main.join("src"), base.clone()] {
            assert!(checkout_reserved(&agents, &overlap));
            assert!(reserve(overlap).is_err());
        }
        assert!(!checkout_reserved(&other_agents, &main));
        let sibling = base.join("sibling");
        for independent in [&nested, &sibling] {
            assert!(!checkout_reserved(&agents, independent));
            let _independent = reserve(independent.to_path_buf()).unwrap();
        }
        drop(reservation);
        assert!(!checkout_reserved(&agents, &main));
        let sub_reservation = reserve(main.join("src")).unwrap();
        assert!(checkout_reserved(&agents, &main));
        drop(sub_reservation);
        let nested_reservation = reserve(nested.clone()).unwrap();
        assert!(!checkout_reserved(&agents, &main));
        drop(nested_reservation);
        assert!(reserve(main.clone()).is_ok());
        // Without its `.git` (mid-recreation) the folder is just part of the main checkout again.
        std::fs::remove_file(nested.join(".git")).unwrap();
        assert!(any_same_checkout(&main, std::slice::from_ref(&nested)));
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn parent_segments_out_of_a_nested_worktree_keep_the_main_checkout_busy() {
        let base = std::env::temp_dir().join(format!("pandacode-checkout-dotdot-{}", uuid::Uuid::new_v4().simple()));
        let main = base.join("main");
        let nested = main.join(".claude").join("worktrees").join("x");
        let admin = main.join(".git").join("worktrees").join("x");
        for dir in [admin.clone(), nested.join("src")] {
            std::fs::create_dir_all(dir).unwrap();
        }
        std::fs::write(admin.join("commondir"), "../..\n").unwrap();
        std::fs::write(nested.join(".git"), "gitdir: ../../../.git/worktrees/x\n").unwrap();
        assert!(!any_same_checkout(&main, std::slice::from_ref(&nested)), "the nested worktree itself is another checkout");
        // Each names a folder of the main checkout, though its spelling passes through `x`.
        for other in [nested.join(".."), nested.join("..").join(".."), nested.join("..").join("missing"), nested.join("src").join("..").join("..")] {
            assert!(any_same_checkout(&main, std::slice::from_ref(&other)), "{} is in the main checkout", other.display());
        }
        // A `..` that stays inside the nested worktree is still that worktree's.
        assert!(!any_same_checkout(&main, &[nested.join("src").join("..")]));
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn nested_submodules_and_vendored_repositories_keep_the_checkout_busy() {
        let base = std::env::temp_dir().join(format!("pandacode-checkout-submodule-{}", uuid::Uuid::new_v4().simple()));
        let main = base.join("main");
        let submodule = main.join("vendor").join("sub");
        let vendored = main.join("third_party").join("lib");
        for dir in [main.join(".git").join("modules").join("sub"), submodule.join("src"), vendored.join(".git"), vendored.join("src")] {
            std::fs::create_dir_all(dir).unwrap();
        }
        // A submodule's gitfile leads to `.git/modules/<name>`, which has no `commondir`.
        std::fs::write(submodule.join(".git"), "gitdir: ../../.git/modules/sub\n").unwrap();
        assert!(any_same_checkout(&main, std::slice::from_ref(&submodule)), "a submodule is part of the checkout");
        assert!(any_same_checkout(&main, &[submodule.join("src")]));
        assert!(any_same_checkout(&main, std::slice::from_ref(&vendored)), "a vendored `.git` folder is part of the checkout");
        assert!(any_same_checkout(&main, &[vendored.join("src")]));
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn same_checkout_matches_canonical_nested_and_deleted_roots_only() {
        let base = std::env::temp_dir().join(format!("pandacode-checkout-busy-{}", uuid::Uuid::new_v4().simple()));
        let root = base.join("repo");
        let nested = root.join("sub");
        let sibling = base.join("repo-worktrees").join("pandacode-x");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::create_dir_all(&sibling).unwrap();
        assert!(!any_same_checkout(&root, &[]));
        assert!(any_same_checkout(&root, std::slice::from_ref(&root)));
        assert!(any_same_checkout(&root, &[root.join(".")]));
        assert!(any_same_checkout(&root, std::slice::from_ref(&nested)), "a working folder inside the checkout");
        assert!(!any_same_checkout(&root, std::slice::from_ref(&sibling)), "a sibling worktree is another checkout");
        assert!(!any_same_checkout(&nested, std::slice::from_ref(&root)), "a parent folder is not inside the root");
        let canonical_root = root.canonicalize().unwrap();
        let canonical_nested: PathBuf = canonical_root.join("sub");
        std::fs::remove_dir_all(&root).unwrap();
        assert!(any_same_checkout(&root, std::slice::from_ref(&canonical_root)), "a deleted root still matches");
        assert!(any_same_checkout(&root, &[canonical_nested]));
        assert!(!any_same_checkout(&root, &[sibling]));
        let _ = std::fs::remove_dir_all(base);
    }
}
