//! Whether a checkout is busy, and how worktree merge, removal and recreation quiesce it: which
//! sessions (running, in a harness console, or exiting in the background) hold a checkout, the refusals that keep a
//! worktree operation or a checks run from racing an agent, and the shared idle guard.
use crate::path_match::{path_in_folder, resolve_path};
use crate::storage::Store;
use crate::{blocking, lock_agents, providers, terminal, worktree_paths, Agents, AppState, Result, RunningAgent};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};

static RESERVATIONS: LazyLock<Mutex<Reservations>> =
    LazyLock::new(|| Mutex::new(Reservations::default()));

#[derive(Clone, Copy, PartialEq, Eq)]
enum ReservationOwner {
    Agents(usize),
    #[cfg(test)]
    Test(u64),
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ReservationScope {
    Checkout,
    Subtree,
}

impl ReservationScope {
    fn any_busy_path(self, root: &Path, others: &[PathBuf]) -> bool {
        match self {
            Self::Checkout => any_same_checkout(root, others),
            Self::Subtree => {
                let resolved = resolve_path(root);
                others.iter().any(|other| path_in_folder(other, root, &resolved))
            }
        }
    }
}

#[derive(Default)]
struct Reservations {
    next: u64,
    active: Vec<(ReservationOwner, u64, ReservationScope, Vec<PathBuf>)>,
}

impl Reservations {
    fn conflicts(&self, owner: Option<ReservationOwner>, checkout: &Path, scope: ReservationScope) -> bool {
        self.active.iter().any(|(reserved_owner, _, reserved_scope, roots)| {
            owner.is_none_or(|owner| *reserved_owner == owner)
                && roots.iter().any(|root| match (reserved_scope, scope) {
                    (ReservationScope::Checkout, ReservationScope::Checkout) => checkout_overlaps(root, checkout),
                    _ => folder_overlaps(root, checkout),
                })
        })
    }

    fn reserve_for(&mut self, owner: ReservationOwner, roots: Vec<PathBuf>, scope: ReservationScope, busy_message: &str) -> Result<u64> {
        if roots.iter().any(|root| self.conflicts(Some(owner), root, scope)) {
            return Err(busy_message.into());
        }
        let token = self.next;
        self.next += 1;
        self.active.push((owner, token, scope, roots));
        Ok(token)
    }

    fn release(&mut self, token: u64) {
        self.active.retain(|(_, reserved_token, _, _)| *reserved_token != token);
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
        reservations.conflicts(Some(ReservationOwner::Agents(Arc::as_ptr(agents) as usize)), checkout, ReservationScope::Checkout)
    })
}

/// Warm spares have no app-state owner, so they must respect every reservation.
pub(crate) fn any_checkout_reserved(checkout: &Path) -> bool {
    RESERVATIONS.lock().map_or(true, |reservations| reservations.conflicts(None, checkout, ReservationScope::Checkout))
}

#[cfg(test)]
pub(crate) fn reserve_for_test(roots: Vec<PathBuf>) -> Reservation {
    let mut reservations = RESERVATIONS.lock().unwrap();
    let owner = ReservationOwner::Test(reservations.next);
    let token = reservations.reserve_for(owner, roots, ReservationScope::Checkout, "checkout busy").unwrap();
    Reservation { token }
}

/// Check and reserve under the same agents lock used to admit local runs.
pub(crate) async fn reserve_idle_checkouts(
    state: &AppState,
    roots: Vec<PathBuf>,
    busy_message: &'static str,
) -> Result<Reservation> {
    reserve_idle(state, roots, ReservationScope::Checkout, busy_message).await
}

/// Destructive operations also reserve nested checkouts inside the affected folders.
pub(crate) async fn reserve_idle_subtrees(
    state: &AppState,
    roots: Vec<PathBuf>,
    busy_message: &'static str,
) -> Result<Reservation> {
    reserve_idle(state, roots, ReservationScope::Subtree, busy_message).await
}

async fn reserve_idle(
    state: &AppState,
    roots: Vec<PathBuf>,
    scope: ReservationScope,
    busy_message: &'static str,
) -> Result<Reservation> {
    let agents = state.agents.clone();
    let terminals = state.terminals.clone();
    let store = state.store.clone();
    blocking(move || {
        let agents_guard = lock_agents(&agents).map_err(|e| e.to_string())?;
        let others = busy_checkout_paths(&agents_guard, &terminals, &store, None, true)?;
        if roots.iter().any(|root| scope.any_busy_path(root, &others)) {
            return Err(busy_message.into());
        }
        let token = RESERVATIONS.lock().map_err(|e| e.to_string())?
            .reserve_for(ReservationOwner::Agents(Arc::as_ptr(&agents) as usize), roots, scope, busy_message)?;
        Ok(Reservation { token })
    })
    .await
}

/// Recheck after quiescing spares while the caller holds its checkout reservation.
pub(crate) async fn ensure_checkouts_idle(state: &AppState, roots: &[PathBuf], busy_message: &'static str) -> Result<()> {
    if any_checkout_busy_excluding(state, roots, None).await? {
        return Err(busy_message.into());
    }
    Ok(())
}

pub(crate) async fn ensure_subtrees_idle(state: &AppState, roots: &[PathBuf], busy_message: &'static str) -> Result<()> {
    if any_subtree_busy_excluding(state, roots, None).await? {
        return Err(busy_message.into());
    }
    Ok(())
}

/// The caller holds the agents lock. Snapshot pending exits after the runners and consoles
/// so a turn handing off to background reaping cannot slip between.
fn busy_checkout_paths(
    running: &HashMap<String, RunningAgent>,
    terminals: &terminal::Terminals,
    store: &Mutex<Store>,
    exclude_session: Option<&str>,
    include_exits: bool,
) -> Result<Vec<PathBuf>> {
    let consoles = terminal::active_harness_sessions(terminals)?;
    let exiting = if include_exits { providers::pending_exits() } else { Vec::new() };
    let mut active = running.keys().chain(&consoles).filter(|id| exclude_session != Some(id.as_str())).peekable();
    let mut exiting = exiting.into_iter().filter(|(id, _)| exclude_session != Some(id.as_str())).peekable();
    if active.peek().is_none() && exiting.peek().is_none() {
        return Ok(Vec::new());
    }
    let store = store.lock().map_err(|e| e.to_string())?;
    Ok(active.filter_map(|id| session_checkout_root(&store, id))
        .chain(exiting.flat_map(|(id, cwd)| cwd.into_iter().chain(session_checkout_root(&store, &id))))
        .collect())
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

/// Existing Git paths share the identity of their checkout root. Keep missing paths at their
/// own canonical spelling so a deleted worktree never inherits the parent repository's identity.
pub(crate) fn checkout_identity(path: &Path) -> PathBuf {
    let resolved = resolve_path(path);
    if !resolved.exists() {
        return resolved;
    }
    crate::claude_roots::git_checkout_root(&resolved).map_or(resolved, |root| resolve_path(&root))
}

/// Whether any of `others` can be working in the same checkout as `root`.
pub(crate) fn any_same_checkout(root: &Path, others: &[PathBuf]) -> bool {
    if others.is_empty() {
        return false;
    }
    let root_id = checkout_identity(root);
    others
        .iter()
        .any(|other| path_in_checkout_identity(other, &root_id))
}

/// Matches activity against a precomputed checkout identity. An enclosing Git checkout can
/// write to its submodules and vendored repositories. Independent linked worktrees stay separate.
pub(crate) fn path_in_checkout_identity(other: &Path, root_id: &Path) -> bool {
    if path_in_folder(other, root_id, root_id) {
        return !in_nested_checkout(other, root_id);
    }
    let other_resolved = resolve_path(other);
    if !other_resolved.exists() {
        return false;
    }
    let Some(other_root) = crate::claude_roots::git_checkout_root(&other_resolved) else {
        return false;
    };
    let other_id = resolve_path(&other_root);
    path_in_folder(root_id, &other_id, &other_id) && !in_nested_checkout(root_id, &other_id)
}

fn checkout_overlaps(a: &Path, b: &Path) -> bool {
    let a_id = checkout_identity(a);
    let b_id = checkout_identity(b);
    path_in_checkout_identity(&b_id, &a_id) || path_in_checkout_identity(&a_id, &b_id)
}

fn folder_overlaps(a: &Path, b: &Path) -> bool {
    path_in_folder(b, a, &resolve_path(a)) || path_in_folder(a, b, &resolve_path(b))
}

/// Whether `other` (inside `root`) belongs to a linked worktree strictly below `root`'s own
/// checkout. Only when `root` is itself in a checkout: a plain folder still counts every
/// repository inside it. Submodules and vendored `.git` folders are part of `root`'s working tree
/// (their writes touch it), so keep walking past them to find any enclosing linked worktree.
/// `other` is resolved first: the checkout walk
/// is lexical, so `root/.claude/worktrees/x/..` would otherwise pass through `x` and be taken
/// for that worktree although it names a folder of `root`'s own checkout.
fn in_nested_checkout(other: &Path, root_id: &Path) -> bool {
    if root_id.join(".git").symlink_metadata().is_err() {
        return false;
    }
    let other_resolved = resolve_path(other);
    other_resolved
        .ancestors()
        .take_while(|&ancestor| ancestor != root_id && ancestor.starts_with(root_id))
        .any(crate::claude_roots::is_linked_worktree_root)
}

/// Whether a run, harness console or pending exit (except for `exclude_session`) holds any
/// checkout in `roots`, literally or canonically.
pub(crate) async fn any_checkout_busy_excluding(
    state: &AppState,
    roots: &[PathBuf],
    exclude_session: Option<&str>,
) -> Result<bool> {
    checkout_busy_in_state(state, roots, exclude_session, true, ReservationScope::Checkout).await
}

/// Counts activity anywhere inside each root, including independent nested checkouts.
pub(crate) async fn any_subtree_busy_excluding(
    state: &AppState,
    roots: &[PathBuf],
    exclude_session: Option<&str>,
) -> Result<bool> {
    checkout_busy_in_state(state, roots, exclude_session, true, ReservationScope::Subtree).await
}

/// Whether an agent or harness console is active in `root`.
pub(crate) async fn active_agent_in_state(state: &AppState, root: &Path) -> Result<bool> {
    checkout_busy_in_state(state, &[root.to_path_buf()], None, false, ReservationScope::Checkout).await
}

async fn checkout_busy_in_state(
    state: &AppState,
    roots: &[PathBuf],
    exclude_session: Option<&str>,
    include_exits: bool,
    scope: ReservationScope,
) -> Result<bool> {
    if roots.is_empty() {
        return Ok(false);
    }
    let agents = state.agents.clone();
    let terminals = state.terminals.clone();
    let store = state.store.clone();
    let roots = roots.to_vec();
    let exclude_session = exclude_session.map(str::to_owned);
    blocking(move || {
        let active = lock_agents(&agents).map_err(|e| e.to_string())?;
        let others = busy_checkout_paths(&active, &terminals, &store, exclude_session.as_deref(), include_exits)?;
        drop(active);
        Ok(roots.iter().any(|root| scope.any_busy_path(root, &others)))
    })
    .await
}

pub(crate) fn session_holds_checkout(state: &AppState, session_id: &str) -> Result<bool> {
    let agents = lock_agents(&state.agents).map_err(|e| e.to_string())?;
    Ok(agents.contains_key(session_id) || terminal::harness_running(&state.terminals, session_id)?)
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
        let root_id = checkout_identity(&root);
        let mut seen = std::collections::HashSet::new();
        Ok(resolved
            .into_iter()
            .filter_map(|(session_id, paths)| {
                (paths
                    .iter()
                    .any(|path| path_in_checkout_identity(path, &root_id))
                    && seen.insert(session_id.clone()))
                .then_some(session_id)
            })
            .collect())
    })
    .await
}

/// Refuses checks while the checkout is active or reserved, patiently waits for exit, then reserves
/// and quiesces the checkout for the script. Sibling exits match by recorded cwd or persisted
/// workspace root.
pub(crate) async fn prepare_checkout_for_checks(state: &AppState, session_id: &str, root: &Path) -> Result<Reservation> {
    const BUSY: &str = "Wait for the agent to finish first.";
    if checkout_reserved(&state.agents, root) || active_agent_in_state(state, root).await? {
        return Err(BUSY.into());
    }
    let wait = async {
        providers::await_exit_patiently(session_id).await?;
        providers::await_exits_in_checkout_patiently(root).await?;
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
    let root_path = root.to_path_buf();
    let reservation = reserve_idle_checkouts(state, vec![root_path.clone()], BUSY).await?;
    providers::end_lingering_in_checkout(root).await;
    providers::quiesce_spares_in_checkout(root).await?;
    ensure_checkouts_idle(state, std::slice::from_ref(&root_path), BUSY).await?;
    Ok(reservation)
}

/// Refuses a worktree merge while `session_id` is actively running or any OTHER session (or
/// unpersisted worker/spare with matching `cwd`) is actively running or exiting in either the
/// main checkout or the worktree. Allows `session_id`'s own pending exit so `merge_task_worktree`
/// awaits it cleanly.
pub(crate) async fn refuse_worktree_merge_busy(state: &AppState, session_id: &str) -> Result<()> {
    const BUSY: &str = "Wait for the agent to finish before merging its worktree.";
    if session_holds_checkout(state, session_id)? {
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
    if session_holds_checkout(state, session_id)? {
        return Err(BUSY.into());
    }
    let store = state.store.clone();
    let sid = session_id.to_owned();
    let path = blocking(move || Ok(worktree_paths(&store, &sid).ok().map(|(_, path, _)| path))).await?;
    if let Some(path) = path {
        if any_subtree_busy_excluding(state, std::slice::from_ref(&path), Some(session_id)).await? {
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

/// Refuse other activity before and after retiring this task's CLI. Folder-wide retirement
/// happens after the caller reserves the checkout.
pub(crate) async fn quiesce_worktree<F: std::future::Future<Output = Result<()>>>(
    state: &AppState,
    session_id: &str,
    message: &str,
    refuse_busy: impl Fn() -> F,
) -> Result<()> {
    refuse_busy().await?;
    guard_idle(
        || session_holds_checkout(state, session_id).unwrap_or(true),
        providers::quiesce(session_id),
        message,
    )
    .await?;
    refuse_busy().await
}

#[cfg(test)]
pub(crate) mod test_support {
    use std::path::PathBuf;

    pub(crate) struct Checkout {
        pub(crate) root: PathBuf,
        pub(crate) pkg_a: PathBuf,
        pub(crate) pkg_b: PathBuf,
        pub(crate) nested: PathBuf,
    }

    impl Checkout {
        pub(crate) fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "pandacode-test-checkout-{}",
                uuid::Uuid::new_v4().simple()
            ));
            let pkg_a = root.join("pkg-a");
            let pkg_b = root.join("pkg-b");
            let nested = root.join(".claude/worktrees/x");
            let admin = root.join(".git/worktrees/x");
            for dir in [&pkg_a, &pkg_b, &nested, &admin] {
                std::fs::create_dir_all(dir).unwrap();
            }
            std::fs::write(admin.join("commondir"), "../..\n").unwrap();
            std::fs::write(nested.join(".git"), "gitdir: ../../../.git/worktrees/x\n").unwrap();
            Self {
                root,
                pkg_a,
                pkg_b,
                nested,
            }
        }
    }

    impl Drop for Checkout {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::Checkout;
    use super::{
        active_agent_in_state, any_checkout_reserved, any_same_checkout, checkout_identity,
        checkout_reserved, prepare_checkout_for_checks, reserve_for_test, reserve_idle_checkouts,
        resolve_path, Reservation, ReservationOwner, ReservationScope, RESERVATIONS,
    };
    use crate::{providers, AppState, RunningAgent};
    use std::{
        path::{Path, PathBuf},
        sync::{Arc, Mutex},
        time::Duration,
    };

    fn test_state() -> AppState {
        AppState {
            store: Arc::new(Mutex::new(
                crate::storage::Store::open(Path::new(":memory:")).unwrap(),
            )),
            agents: Default::default(),
            terminals: Default::default(),
            shutdown: Default::default(),
        }
    }

    fn vendored_repo_in_nested_worktree(checkout: &Checkout) -> PathBuf {
        let dep = checkout.nested.join("vendor/dep");
        std::fs::create_dir_all(dep.join(".git")).unwrap();
        std::fs::create_dir(dep.join("sub")).unwrap();
        dep
    }

    #[test]
    fn vendored_repo_matches_its_nested_worktree_in_both_directions() {
        let checkout = Checkout::new();
        let dep = vendored_repo_in_nested_worktree(&checkout);
        let sub = dep.join("sub");
        let nested_pkg = checkout.nested.join("pkg-a");
        std::fs::create_dir(&nested_pkg).unwrap();

        for (outer, inner, same) in [
            (&checkout.root, &dep, false),
            (&checkout.pkg_a, &sub, false),
            (&checkout.nested, &dep, true),
            (&nested_pkg, &sub, true),
        ] {
            assert_eq!(any_same_checkout(outer, std::slice::from_ref(inner)), same);
            assert_eq!(any_same_checkout(inner, std::slice::from_ref(outer)), same);
        }
    }

    #[test]
    fn submodule_matches_its_nested_worktree_in_both_directions() {
        let checkout = Checkout::new();
        let submod = checkout.nested.join("submod");
        let gitdir = checkout.root.join(".git/worktrees/x/modules/submod");
        std::fs::create_dir(&submod).unwrap();
        std::fs::create_dir_all(gitdir).unwrap();
        std::fs::write(
            submod.join(".git"),
            "gitdir: ../../../../.git/worktrees/x/modules/submod\n",
        )
        .unwrap();

        assert!(!any_same_checkout(&checkout.root, std::slice::from_ref(&submod)));
        assert!(!any_same_checkout(&submod, std::slice::from_ref(&checkout.root)));
        assert!(any_same_checkout(&checkout.nested, std::slice::from_ref(&submod)));
        assert!(any_same_checkout(&submod, std::slice::from_ref(&checkout.nested)));
    }

    #[tokio::test]
    async fn main_checkout_checks_skip_an_exit_in_a_nested_worktrees_vendored_repo() {
        let checkout = Checkout::new();
        let dep = vendored_repo_in_nested_worktree(&checkout);
        let state = test_state();
        let session_id = format!("nested-vendored-exit-{}", uuid::Uuid::new_v4());
        let hold = providers::hold_exit_in_cwd_for_test(&session_id, dep);
        let prepared = tokio::time::timeout(
            Duration::from_secs(2),
            prepare_checkout_for_checks(&state, "checks", &checkout.root),
        )
        .await;
        let still_pending = providers::pending_exits().iter().any(|(id, _)| id == &session_id);
        drop(hold);
        providers::await_exit(&session_id).await.unwrap();

        let _reservation = prepared.expect("main checks must skip the nested exit").unwrap();
        assert!(still_pending);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn main_checkout_checks_preserve_a_spare_in_a_nested_worktrees_vendored_repo() {
        let _serial = providers::spare_pool_test_lock().lock().await;
        let checkout = Checkout::new();
        let dep = vendored_repo_in_nested_worktree(&checkout);
        let state = test_state();
        let session_id = format!("nested-vendored-spare-{}", uuid::Uuid::new_v4());
        providers::insert_spare_in_cwd_for_test(&session_id, dep, false);

        let prepared = prepare_checkout_for_checks(&state, "checks", &checkout.root).await;
        let still_pooled = providers::has_spare_for_test(&session_id);
        providers::quiesce(&session_id).await.unwrap();

        let _reservation = prepared.unwrap();
        assert!(still_pooled);
    }

    #[tokio::test]
    async fn subfolder_checks_refuse_agents_at_the_git_root_and_sibling_project() {
        let checkout = Checkout::new();
        let state = test_state();
        for cwd in [&checkout.root, &checkout.pkg_b] {
            let session = {
                let store = state.store.lock().unwrap();
                let project = store.add_project(cwd).unwrap();
                store
                    .create_session(&project.id, "claude", "default", "ask")
                    .unwrap()
            };
            let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
            state
                .agents
                .lock()
                .unwrap()
                .insert(session.id.clone(), RunningAgent::new(tx, Arc::default()));

            assert!(active_agent_in_state(&state, &checkout.pkg_a)
                .await
                .unwrap());
            assert_eq!(
                prepare_checkout_for_checks(&state, "checks", &checkout.pkg_a)
                    .await
                    .err()
                    .as_deref(),
                Some("Wait for the agent to finish first."),
            );
            state.agents.lock().unwrap().remove(&session.id);
        }
    }

    #[tokio::test]
    async fn sibling_subfolder_reservations_conflict_but_nested_worktrees_are_independent() {
        let checkout = Checkout::new();
        let state = test_state();
        let reserve =
            |path: &Path| reserve_idle_checkouts(&state, vec![path.to_path_buf()], "busy");
        let first = reserve(&checkout.pkg_a).await.unwrap();
        assert!(reserve(&checkout.pkg_b).await.is_err());
        assert!(reserve(&checkout.root).await.is_err());
        assert!(reserve(&checkout.nested).await.is_ok());
        drop(first);
        assert!(reserve(&checkout.pkg_b).await.is_ok());
    }

    #[tokio::test]
    async fn checkout_checks_and_patient_wait_skip_a_nested_linked_worktree_exit() {
        let checkout = Checkout::new();
        let state = test_state();
        let session_id = format!("nested-exit-{}", uuid::Uuid::new_v4());
        let hold = providers::hold_exit_in_cwd_for_test(&session_id, checkout.nested.clone());
        let cap = Duration::from_secs(2);
        let waited = tokio::time::timeout(
            cap,
            providers::await_exits_in_checkout_patiently(&checkout.root),
        )
        .await;
        let prepared = tokio::time::timeout(
            cap,
            prepare_checkout_for_checks(&state, "checks", &checkout.root),
        )
        .await;
        let report = if let Ok(Ok(reservation)) = prepared {
            Some(
                tokio::time::timeout(
                    cap,
                    crate::checks::turn_report_after_exit_guarded(
                        "checks",
                        checkout.root.clone(),
                        reservation,
                    ),
                )
                .await,
            )
        } else {
            None
        };
        drop(hold);
        providers::await_exit(&session_id).await.unwrap();

        waited
            .expect("patient checkout wait must skip the nested exit")
            .unwrap();
        let report = report
            .expect("prepare must skip the nested exit")
            .expect("guarded checks must skip the nested exit");
        assert!(report["reason"].as_str().unwrap().contains("no fast check"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn subfolder_checks_reap_pooled_sibling_spares_and_preserve_nested_worktree_spares() {
        let _serial = providers::spare_pool_test_lock().lock().await;
        let checkout = Checkout::new();
        let state = test_state();
        let sibling = format!("checkout-sibling-spare-{}", uuid::Uuid::new_v4());
        let nested = format!("checkout-nested-spare-{}", uuid::Uuid::new_v4());
        let pid = providers::insert_spare_in_cwd_for_test(&sibling, checkout.pkg_b.clone(), false);
        providers::insert_spare_in_cwd_for_test(&nested, checkout.nested.clone(), true);

        let reservation = prepare_checkout_for_checks(&state, "checks", &checkout.pkg_a).await;
        let sibling_reaped =
            !providers::has_spare_for_test(&sibling) && providers::process_gone_for_test(pid);
        let nested_pooled = providers::has_spare_for_test(&nested);
        providers::quiesce(&sibling).await.unwrap();
        providers::quiesce(&nested).await.unwrap();

        let _reservation = reservation.unwrap();
        assert!(
            sibling_reaped,
            "the sibling spare must exit before checks can start"
        );
        assert!(
            nested_pooled,
            "the nested worktree's spare belongs to another checkout"
        );
    }

    #[test]
    fn global_reservation_lookup_covers_every_owner_until_release() {
        let base = std::env::temp_dir().join(format!("pandacode-checkout-reservations-{}", uuid::Uuid::new_v4()));
        let checkout = base.join("checkout");
        let first = reserve_for_test(vec![checkout.clone()]);
        let second = reserve_for_test(vec![checkout.clone()]);
        assert!(any_checkout_reserved(&checkout));
        assert!(any_checkout_reserved(&checkout.join("src")));
        assert!(any_checkout_reserved(&base));
        assert!(!any_checkout_reserved(&base.join("sibling")));
        assert!(!checkout_reserved(&crate::Agents::default(), &checkout));
        drop(first);
        assert!(any_checkout_reserved(&checkout));
        drop(second);
        assert!(!any_checkout_reserved(&checkout));
    }

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
        let owner = ReservationOwner::Agents(std::sync::Arc::as_ptr(&agents) as usize);
        let reserve_scoped = |path, scope| RESERVATIONS.lock().unwrap().reserve_for(owner, vec![path], scope, "busy")
            .map(|token| Reservation { token });
        let reserve = |path| reserve_scoped(path, ReservationScope::Checkout);
        let reservation = reserve(main.clone()).unwrap();
        for overlap in [main.clone(), main.join("src"), base.clone()] {
            assert!(checkout_reserved(&agents, &overlap));
            assert!(reserve(overlap).is_err());
        }
        assert!(!checkout_reserved(&other_agents, &main));
        assert!(!any_checkout_reserved(&nested));
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
        assert!(reserve_scoped(main.clone(), ReservationScope::Subtree).is_err());
        drop(nested_reservation);
        let subtree = reserve_scoped(main.clone(), ReservationScope::Subtree).unwrap();
        assert!(checkout_reserved(&agents, &nested));
        assert!(any_checkout_reserved(&nested));
        assert!(reserve(nested.clone()).is_err());
        assert!(ReservationScope::Subtree.any_busy_path(&main, std::slice::from_ref(&nested)));
        assert!(!ReservationScope::Subtree.any_busy_path(&main, std::slice::from_ref(&base)));
        drop(subtree);
        assert!(!any_checkout_reserved(&nested));
        // Without its `.git` (mid-recreation) the folder is just part of the main checkout again.
        std::fs::remove_file(nested.join(".git")).unwrap();
        assert!(any_same_checkout(&main, std::slice::from_ref(&nested)));
        std::fs::remove_dir_all(&nested).unwrap();
        assert_eq!(checkout_identity(&nested), resolve_path(&nested));
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
        assert!(
            any_same_checkout(&submodule, std::slice::from_ref(&main)),
            "the superproject can write to the submodule"
        );
        assert!(any_same_checkout(&vendored, std::slice::from_ref(&main)));
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
