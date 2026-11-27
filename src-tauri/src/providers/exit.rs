//! Background exit of clean Claude-family runs: `reap` finishes the process after the run
//! returns, and `await_exit` makes the next same-session launch wait for it.

use super::{wait_child, BACKGROUND_EXIT_WAIT, Child, ChildStdin, ChildStdout, ProcessGroup, StderrReader, EXIT_HARD_CAP, EXIT_WAIT};
use crate::checkout_busy::{checkout_identity, path_in_checkout_identity};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex, OnceLock},
    time::Duration,
};
use tokio::time::Instant;

/// Set when something is actually waiting for a pending exit: its reap then escalates at
/// `EXIT_WAIT` after it began (as before the background reap) instead of `BACKGROUND_EXIT_WAIT`.
type Hurry = Arc<tokio::sync::watch::Sender<bool>>;

/// Hurry signals of the pending exits, by session id.
fn hurries() -> &'static Mutex<HashMap<String, Vec<Hurry>>> {
    static HURRIES: OnceLock<Mutex<HashMap<String, Vec<Hurry>>>> = OnceLock::new();
    HURRIES.get_or_init(Default::default)
}

fn hurry_session(session_id: &str) {
    if let Some(pending) = hurries().lock().unwrap_or_else(|p| p.into_inner()).get(session_id) {
        for hurry in pending {
            hurry.send_replace(true);
        }
    }
}

#[derive(Clone)]
pub(super) struct ExitEntry {
    pub(super) exiting: tokio::sync::watch::Receiver<()>,
    pub(super) cwd: Option<PathBuf>,
    pub(super) call_stopped: Option<Arc<AtomicBool>>,
}

/// Every pending exit of a session, oldest first: each keeps its own `cwd`, so a newer exit in
/// another folder never hides an older one from `await_exits_in`.
pub(super) type Registry = Mutex<HashMap<String, Vec<ExitEntry>>>;

/// Processes of clean Claude-family runs still exiting, by session id, and saved-tool invocations
/// still working in a checkout. Claude Code's natural exit
/// after its `result` frame is within `BACKGROUND_EXIT_WAIT` (`EXIT_WAIT` once a launch waits); the run returns at once and `reap` waits instead.
/// The sender drops when the process (and its group) is gone, or if the reaper is dropped.
pub(super) fn exit_registry() -> &'static Registry {
    static EXITING: OnceLock<Registry> = OnceLock::new();
    EXITING.get_or_init(Default::default)
}

fn clear_exit(id: &str, exiting: &tokio::sync::watch::Receiver<()>) {
    let mut registry = exit_registry().lock().unwrap_or_else(|p| p.into_inner());
    if let Some(entries) = registry.get_mut(id) {
        entries.retain(|entry| !entry.exiting.same_channel(exiting));
        if entries.is_empty() {
            registry.remove(id);
        }
    }
}

/// The blocking runner holds this through process cleanup. Waiters resolve when it drops,
/// even if the runtime dropped the handler that started the runner.
pub(crate) struct CheckoutWorkGuard {
    id: String,
    exiting: tokio::sync::watch::Receiver<()>,
    _done: tokio::sync::watch::Sender<()>,
}

impl Drop for CheckoutWorkGuard {
    fn drop(&mut self) {
        clear_exit(&self.id, &self.exiting);
    }
}

/// Register a saved tool by checkout. Its per-call key keeps the work visible to checkout
/// busy checks even when they exclude the task that requested the mutation.
pub(crate) fn track_checkout_work(cwd: PathBuf, call_stopped: Arc<AtomicBool>) -> CheckoutWorkGuard {
    let id = format!("saved-tool:{}", uuid::Uuid::new_v4());
    let (done, exiting) = tokio::sync::watch::channel(());
    exit_registry().lock().unwrap_or_else(|p| p.into_inner()).insert(
        id.clone(),
        vec![ExitEntry { exiting: exiting.clone(), cwd: Some(cwd), call_stopped: Some(call_stopped) }],
    );
    CheckoutWorkGuard { id, exiting, _done: done }
}

/// Snapshot of `(session_id, cwd)` for every pending or in-flight exit in the registry.
pub(crate) fn pending_exits() -> Vec<(String, Option<PathBuf>)> {
    exit_registry()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .iter()
        .flat_map(|(session_id, entries)| entries.iter().map(|entry| (session_id.clone(), entry.cwd.clone())))
        .collect()
}

/// Before any same-session launch, require the previous reaper to finish so the new
/// process never reads a half-flushed session file. Other sessions do not wait.
/// Delayed reaping may exceed the normal escalation time; the hard cap fails the
/// launch instead of treating a timeout as confirmed exit. No mutex is held while waiting.
pub(crate) async fn await_exit(session_id: &str) -> Result<(), String> {
    await_exit_with_cap(session_id, EXIT_HARD_CAP).await
}

/// `await_exit` that never hurries the reap: for a waiter that is not itself waiting on the
/// user's next turn (the warm spare, a Turn check), so the CLI keeps its natural exit up to
/// `BACKGROUND_EXIT_WAIT`. The same hard cap applies.
pub(crate) async fn await_exit_patiently(session_id: &str) -> Result<(), String> {
    wait_exit(session_id, EXIT_HARD_CAP, false).await
}

pub(super) async fn await_exit_with_cap(session_id: &str, cap: Duration) -> Result<(), String> {
    wait_exit(session_id, cap, true).await
}

async fn wait_exit(session_id: &str, cap: Duration, hurry: bool) -> Result<(), String> {
    // One cap for the whole wait, which follows the chain: an exit registered while this one
    // ran (a pending spare killed, then retired) waits on it, so look again until none is left.
    let wait = async {
        // A finished exit left in place (not removed) must not be waited on again.
        let mut waited: Vec<tokio::sync::watch::Receiver<()>> = Vec::new();
        loop {
            let fresh: Vec<_> = exit_registry()
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .get(session_id)
                .into_iter()
                .flatten()
                .map(|entry| &entry.exiting)
                .filter(|exiting| !waited.iter().any(|done| done.same_channel(exiting)))
                .cloned()
                .collect();
            if fresh.is_empty() {
                return;
            }
            if hurry {
                hurry_session(session_id);
            }
            for mut exiting in fresh {
                // Sender closure is the reaper's completion signal.
                let _ = exiting.changed().await;
                waited.push(exiting);
            }
        }
    };
    tokio::time::timeout(cap, wait)
        .await
        .map_err(|_| "The previous run of this conversation is still shutting down. Try again.".to_string())
}

/// Wait until every process in the registry has exited, or `cap` passes, whichever is first
/// (the app quitting: nothing may be left half-flushed). Never fails and never hangs; a miss of
/// the cap just returns. No mutex is held while waiting and no store lock is taken.
pub(crate) async fn await_all_exits(cap: Duration) {
    wait_all(exit_registry(), cap).await;
}

// Folder matching shared with warm spares and the checkout guard (`checkout_busy.rs`).
pub(crate) use crate::path_match::{path_in_folder, resolve_path};

/// Wait until every pending exit whose recorded working directory lies in `folder` has exited
/// (hurrying them as `await_exit` does), bounded by `EXIT_HARD_CAP`.
pub(crate) async fn await_exits_in(folder: &Path) -> Result<(), String> {
    wait_in(exit_registry(), folder, EXIT_HARD_CAP, true, WaitScope::Folder).await
}

/// Wait for pending exits in this checkout, excluding independent linked worktrees below it.
pub(crate) async fn await_exits_in_checkout(folder: &Path) -> Result<(), String> {
    wait_in(exit_registry(), folder, EXIT_HARD_CAP, true, WaitScope::Checkout).await
}

/// Patient version of [`await_exits_in_checkout`] for Turn checks, bounded by
/// `EXIT_HARD_CAP`.
pub(crate) async fn await_exits_in_checkout_patiently(folder: &Path) -> Result<(), String> {
    wait_in(exit_registry(), folder, EXIT_HARD_CAP, false, WaitScope::Checkout).await
}

/// Wait before starting a saved tool so retries cannot overlap a canceled process. Other
/// active tool calls may run in parallel. Checkout mutations use the full checkout wait.
pub(crate) async fn await_checkout_before_tool(folder: &Path) -> Result<(), String> {
    wait_in(exit_registry(), folder, EXIT_HARD_CAP, true, WaitScope::BeforeTool).await
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum WaitScope {
    Folder,
    Checkout,
    BeforeTool,
}

async fn wait_in(registry: &Registry, folder: &Path, cap: Duration, hurry: bool, scope: WaitScope) -> Result<(), String> {
    let wait = async {
        let mut resolved = None;
        let mut waited: Vec<tokio::sync::watch::Receiver<()>> = Vec::new();
        loop {
            let snapshot: Vec<(String, PathBuf, tokio::sync::watch::Receiver<()>)> = registry
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .iter()
                .flat_map(|(id, entries)| entries.iter().map(move |entry| (id, entry)))
                .filter_map(|(id, entry)| {
                    if scope == WaitScope::BeforeTool && entry.call_stopped.as_ref().is_some_and(|flag| !flag.load(Ordering::SeqCst)) {
                        return None;
                    }
                    if waited.iter().any(|done| done.same_channel(&entry.exiting)) {
                        return None;
                    }
                    entry.cwd.as_ref().map(|cwd| (id.clone(), cwd.clone(), entry.exiting.clone()))
                })
                .collect();
            if snapshot.is_empty() {
                return Ok::<(), String>(());
            }
            let target = folder.to_path_buf();
            let previous = resolved.take();
            let (target_resolved, matching) = tokio::task::spawn_blocking(move || {
                let target_resolved = previous.unwrap_or_else(|| {
                    if scope != WaitScope::Folder {
                        checkout_identity(&target)
                    } else {
                        resolve_path(&target)
                    }
                });
                let matching = snapshot
                    .into_iter()
                    .filter(|(_, cwd, _)| {
                        if scope != WaitScope::Folder {
                            path_in_checkout_identity(cwd, &target_resolved)
                        } else {
                            path_in_folder(cwd, &target, &target_resolved)
                        }
                    })
                    .collect::<Vec<_>>();
                (target_resolved, matching)
            })
            .await
            // Fail closed: skipping the wait could let the folder go while a process still runs in it.
            .map_err(|error| format!("Could not check exiting processes: {error}"))?;
            resolved = Some(target_resolved);
            if matching.is_empty() {
                return Ok(());
            }
            if hurry {
                for (session_id, _, _) in &matching {
                    hurry_session(session_id);
                }
            }
            for (_, _, mut exiting) in matching {
                // Sender closure is the reaper's completion signal.
                let _ = exiting.changed().await;
                waited.push(exiting);
            }
        }
    };
    tokio::time::timeout(cap, wait)
        .await
        .map_err(|_| "A previous run in this folder is still shutting down. Try again.".to_string())?
}

/// `await_all_exits` over a given registry. Exits registered while waiting (a pending spare
/// killed, then retired) are waited for too, so it looks again until nothing new is left.
pub(super) async fn wait_all(registry: &Registry, cap: Duration) {
    let wait = async {
        let mut waited: Vec<tokio::sync::watch::Receiver<()>> = Vec::new();
        loop {
            let fresh: Vec<_> = registry
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .values()
                .flatten()
                .map(|entry| &entry.exiting)
                .filter(|exiting| !waited.iter().any(|done| done.same_channel(exiting)))
                .cloned()
                .collect();
            if fresh.is_empty() {
                return;
            }
            for mut exiting in fresh {
                // Sender closure is the reaper's completion signal.
                let _ = exiting.changed().await;
                waited.push(exiting);
            }
        }
    };
    let _ = tokio::time::timeout(cap, wait).await;
}

/// Register `task`'s exit under the session and run it in the background: it waits for any exit
/// already registered for the session, then for `task`, then clears its own registration (never
/// a newer one). The one path every process removal takes (`reap`, `warm::retire`), so a
/// same-session launch (`await_exit`) always waits for the last of them. Outside a runtime
/// nothing can wait and `task` is dropped (its process dies with it).
#[cfg(all(test, unix))]
pub(super) fn spawn_exit(session_id: &str, task: impl std::future::Future<Output = ()> + Send + 'static) {
    spawn_exit_in_cwd(session_id, None, task);
}

pub(super) fn spawn_exit_in_cwd(
    session_id: &str,
    cwd: Option<PathBuf>,
    task: impl std::future::Future<Output = ()> + Send + 'static,
) {
    spawn_exit_hurried(session_id, cwd, |_| task);
}

/// `spawn_exit` for a task that can shorten its own wait: it receives the hurry signal.
fn spawn_exit_hurried<F: std::future::Future<Output = ()> + Send + 'static>(
    session_id: &str,
    cwd: Option<PathBuf>,
    make: impl FnOnce(tokio::sync::watch::Receiver<bool>) -> F,
) {
    let Ok(runtime) = tokio::runtime::Handle::try_current() else { return };
    let hurry: Hurry = Arc::new(tokio::sync::watch::channel(false).0);
    let task = make(hurry.subscribe());
    hurries().lock().unwrap_or_else(|p| p.into_inner()).entry(session_id.to_owned()).or_default().push(hurry.clone());
    let (done, exiting) = tokio::sync::watch::channel(());
    let previous = {
        let mut registry = exit_registry().lock().unwrap_or_else(|p| p.into_inner());
        let entries = registry.entry(session_id.to_owned()).or_default();
        let previous = entries.last().map(|entry| entry.exiting.clone());
        // Earlier entries keep their own `cwd` (a folder wait still finds them); an exit without
        // one inherits the latest, as it continues that run in the same folder.
        let cwd = cwd.or_else(|| entries.last().and_then(|entry| entry.cwd.clone()));
        entries.push(ExitEntry { exiting: exiting.clone(), cwd, call_stopped: None });
        previous
    };
    let session_id = session_id.to_owned();
    runtime.spawn(async move {
        if let Some(mut previous) = previous {
            // Sender closure is the earlier exit's completion signal.
            let _ = previous.changed().await;
        }
        task.await;
        {
            let mut all = hurries().lock().unwrap_or_else(|p| p.into_inner());
            if let Some(list) = all.get_mut(&session_id) {
                list.retain(|other| !Arc::ptr_eq(other, &hurry));
                if list.is_empty() {
                    all.remove(&session_id);
                }
            }
        }
        clear_exit(&session_id, &exiting);
        drop(done);
    });
}

/// A process about to exist: held from before `spawn` until the spare owns it (pooled, or killed
/// and retired), so a launch or the harness console that calls `await_exit` in between waits
/// instead of resuming the session beside it. Dropping it resolves the wait.
pub(super) struct Pending {
    _guard: Option<tokio::sync::oneshot::Sender<()>>,
}

impl Pending {
    /// Nothing to wait for (a stub that spawns no process).
    #[cfg(all(test, unix))]
    pub(super) fn none() -> Self {
        Pending { _guard: None }
    }
}

/// Register an exit for a process that is about to start or retire under `session_id` (and
/// optional working directory `cwd`). The caller drops the guard as soon as the process is
/// registered (`warm::register`), retired (`warm::retire`), or was never started; `await_exit`'s
/// hard cap still bounds any wait.
pub(super) fn pending_in_cwd(session_id: &str, cwd: Option<PathBuf>) -> Pending {
    let (guard, released) = tokio::sync::oneshot::channel::<()>();
    // The guard's sender closing is the signal; the value is never sent.
    spawn_exit_in_cwd(session_id, cwd, async move { let _ = released.await; });
    Pending { _guard: Some(guard) }
}

/// Test seam: an exit registered for `session_id` until the returned guard drops.
#[cfg(test)]
pub(crate) fn hold_for_test(session_id: &str) -> Box<dyn std::any::Any + Send> {
    Box::new(pending_in_cwd(session_id, None))
}

/// Test seam: an exit registered for `session_id` in `cwd` until the returned guard drops.
#[cfg(test)]
pub(crate) fn hold_in_cwd_for_test(session_id: &str, cwd: PathBuf) -> Box<dyn std::any::Any + Send> {
    Box::new(pending_in_cwd(session_id, Some(cwd)))
}

/// Kill a process the caller owns in pieces and cannot use (a spare that left the pool, or a
/// launch whose streams were unavailable) and register its exit under the session, so the next
/// same-session launch waits until it is really gone.
pub(super) fn retire_parts_in_cwd(
    session_id: &str,
    mut child: Child,
    group: ProcessGroup,
    server: Option<super::mcp_host::Server>,
    cwd: Option<PathBuf>,
) {
    drop(group);
    let _ = child.start_kill();
    spawn_exit_in_cwd(session_id, cwd, async move {
        let _ = child.wait().await;
        drop(server);
    });
}

/// How long an unused warm spare retired in the background (`retire_gracefully_in_cwd`) may take
/// to exit on its own once its stdin closes before it is killed.
pub(super) const SPARE_RETIRE_WAIT: Duration = Duration::from_secs(2);

/// Close stdin and drain both output pipes so an unused spare can run its `SessionEnd` hooks.
/// Kill it after `SPARE_RETIRE_WAIT`, when `await_exit` hurries it, or at once without piped stdin.
pub(super) fn retire_gracefully_in_cwd(session_id: &str, mut child: Child, group: ProcessGroup, server: Option<super::mcp_host::Server>, cwd: Option<PathBuf>) {
    let Some(stdin) = child.stdin.take() else {
        retire_parts_in_cwd(session_id, child, group, server, cwd);
        return;
    };
    // Outside a runtime nothing can drain or wait; the process dies with its handles.
    let Ok(runtime) = tokio::runtime::Handle::try_current() else { return };
    drop(stdin);
    let stdout = child.stdout.take().map(|mut stdout| runtime.spawn(async move { tokio::io::copy(&mut stdout, &mut tokio::io::sink()).await.ok() }));
    let stderr = child.stderr.take().map(|mut stderr| runtime.spawn(async move { tokio::io::copy(&mut stderr, &mut tokio::io::sink()).await.ok() }));
    spawn_exit_hurried(session_id, cwd, move |mut hurry| async move {
        let hurried = async {
            while hurry.changed().await.is_ok() && !*hurry.borrow() {}
        };
        tokio::select! {
            _ = child.wait() => {}
            () = tokio::time::sleep(SPARE_RETIRE_WAIT) => {}
            () = hurried => {}
        }
        // Exited: this only stops what it left in its group. Otherwise it is killed now.
        drop(group);
        let _ = child.start_kill();
        let _ = child.wait().await;
        for drain in [stdout, stderr].into_iter().flatten() {
            drain.abort();
        }
        drop(server);
    });
}

/// The one log line for a reaped process that exited nonzero.
pub(super) fn exit_note(session_id: &str, status: std::process::ExitStatus) -> Option<String> {
    (!status.success()).then(|| format!("The CLI of session {session_id} exited with {status} after finishing its turn"))
}

/// Process handles handed to [`reap`] once a clean Claude-family run finishes.
pub(super) struct Reaped {
    pub(super) session_id: String,
    pub(super) cwd: Option<PathBuf>,
    pub(super) child: Child,
    pub(super) stdin: ChildStdin,
    pub(super) stdout: ChildStdout,
    pub(super) group: ProcessGroup,
    pub(super) stderr: StderrReader,
}

/// Finish a clean run's process in the background, with `finish_child`'s escalation. stdin is
/// closed at once, before the wait behind any earlier exit of the session, so the CLI never
/// idles with it open. Both output streams are drained while it flushes after `result`.
/// A nonzero exit logs only its session and status. Child output can contain credentials.
pub(super) fn reap(reaped: Reaped) {
    reap_with_log(reaped, |note| eprintln!("{note}"));
}

pub(super) fn reap_with_log(reaped: Reaped, log: impl FnOnce(String) + Send + 'static) {
    let Reaped { session_id, cwd, mut child, stdin, mut stdout, mut group, stderr } = reaped;
    // Outside a runtime nothing can drain or wait; the process dies with its handles.
    let Ok(runtime) = tokio::runtime::Handle::try_current() else { return };
    drop(stdin);
    // Drained at once, not after an earlier exit of the session: a full pipe would stall the
    // flushing process and so the very exit this waits for.
    let drain = runtime.spawn(async move {
        let mut sink = tokio::io::sink();
        let _ = tokio::io::copy(&mut stdout, &mut sink).await;
    });
    let id = session_id.clone();
    let began = Instant::now();
    spawn_exit_hurried(&session_id, cwd, move |hurry| async move {
        wait_natural_exit(&mut child, hurry, began).await;
        // Past the natural deadline this escalates at once; a finished exit just returns.
        let (status, escalated) = wait_child(&mut child, &mut group, Duration::ZERO).await;
        drain.abort();
        if escalated {
            // The status is PandaCode's own SIGTERM/SIGKILL, not a CLI failure.
            log(format!("The CLI of session {id} was still exiting after {:.1}s and was stopped", began.elapsed().as_secs_f32()));
        } else if let Some(note) = status.and_then(|status| exit_note(&id, status)) {
            log(note);
        }
        drop(stderr);
    });
}

/// Wait for the process to exit on its own: until `BACKGROUND_EXIT_WAIT` after the reap began,
/// or once hurried (a real launch waits) until `EXIT_WAIT` after it began, or at once if later.
async fn wait_natural_exit(child: &mut Child, mut hurry: tokio::sync::watch::Receiver<bool>, began: Instant) {
    let deadline = async {
        let patient = tokio::time::sleep_until(began + BACKGROUND_EXIT_WAIT);
        tokio::pin!(patient);
        loop {
            tokio::select! {
                () = &mut patient => return,
                changed = hurry.changed() => {
                    if changed.is_err() || *hurry.borrow() {
                        tokio::time::sleep_until(began + EXIT_WAIT).await;
                        return;
                    }
                }
            }
        }
    };
    tokio::select! {
        _ = child.wait() => {}
        () = deadline => {}
    }
}

/// Default-on marker switch (shared by the desktop app and headless host): with it present every
/// clean run finishes its process before returning, as managed workers and cloud runs always do.
const BACKGROUND_REAP_OFF_FILE: &str = "background-reap-off";

#[cfg(test)]
thread_local! {
    static BACKGROUND_REAP_OVERRIDE: std::cell::Cell<Option<bool>> = const { std::cell::Cell::new(None) };
}

/// On while the marker is absent, read off the async runtime through the handle both entry points
/// save (`app_marker::init`). An unreadable settings folder, or no handle in production, fails
/// closed (finish in the run); unit tests default on unless overridden via the thread-local.
pub(super) async fn background_reap_enabled_off_runtime() -> bool {
    #[cfg(test)]
    if let Some(enabled) = BACKGROUND_REAP_OVERRIDE.with(std::cell::Cell::get) {
        return enabled;
    }
    crate::app_marker::default_on_off_runtime(BACKGROUND_REAP_OFF_FILE).await
}

#[cfg(test)]
mod unit_tests {
    use super::*;
    use super::super::{read_stderr, StderrReader};
    use std::process::Stdio;
    use tokio::process::Command;

    /// A fresh folder under the temp dir, removed on drop (after the test's processes are gone).
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!("pandacode-exit-x-{name}-{}", uuid::Uuid::new_v4().simple()));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn unique(name: &str) -> String {
        format!("exit-x-{name}-{}", uuid::Uuid::new_v4().simple())
    }

    #[tokio::test]
    async fn the_background_reap_marker_defaults_on_and_fails_closed() {
        let dir = Scratch::new("reap-marker");
        let background_reap_enabled_in = |dir: Result<PathBuf, String>| crate::app_marker::default_on_in(dir, BACKGROUND_REAP_OFF_FILE);
        assert!(background_reap_enabled_in(Ok(dir.0.clone())), "absent: on");
        std::fs::write(dir.0.join(BACKGROUND_REAP_OFF_FILE), b"").unwrap();
        assert!(!background_reap_enabled_in(Ok(dir.0.clone())), "present: off");
        let file = dir.0.join("not-a-folder");
        std::fs::write(&file, b"").unwrap();
        assert!(!background_reap_enabled_in(Ok(file)), "an unreadable settings folder fails closed");
        assert!(!background_reap_enabled_in(Err("no app data".into())), "an unknown one too");
        assert!(background_reap_enabled_off_runtime().await, "tests without an app handle default on");
        for enabled in [false, true] {
            BACKGROUND_REAP_OVERRIDE.with(|value| value.set(Some(enabled)));
            assert_eq!(background_reap_enabled_off_runtime().await, enabled);
        }
        BACKGROUND_REAP_OVERRIDE.with(|value| value.set(None));
    }

    /// A child that idles for 30 s, ignores stdin closing and dies only when stopped.
    fn idle_cmd(cwd: &Path) -> Command {
        #[cfg(unix)]
        let mut command = {
            let mut command = Command::new("sleep");
            command.arg("30");
            // Its own group, as a launch's CLI has: the reap signals the group.
            command.process_group(0);
            command
        };
        #[cfg(windows)]
        let mut command = {
            let mut command = Command::new("ping");
            command.args(["-n", "30", "127.0.0.1"]);
            command
        };
        command
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        command
    }

    /// Spawns `idle_cmd()` in `cwd` and hands it to `reap` under `session_id`, as a clean run does.
    fn spawn_reaped(session_id: &str, cwd: &Path) {
        let mut child = idle_cmd(cwd).spawn().expect("the idle child starts");
        let group = ProcessGroup::register(child.id());
        let (stdin, stdout, stderr) = (child.stdin.take().unwrap(), child.stdout.take().unwrap(), child.stderr.take().unwrap());
        reap(Reaped {
            session_id: session_id.to_owned(),
            cwd: Some(cwd.to_path_buf()),
            child,
            stdin,
            stdout,
            group,
            stderr: StderrReader(tokio::spawn(read_stderr(stderr))),
        });
    }

    /// The recorded folders of `session_id`'s pending exits, from one `pending_exits()` snapshot.
    fn pending_for(session_id: &str) -> Vec<Option<PathBuf>> {
        pending_exits().into_iter().filter(|(id, _)| id == session_id).map(|(_, cwd)| cwd).collect()
    }

    #[tokio::test]
    async fn reap_registers_cwd_and_await_exit_hurries_and_clears() {
        let scratch = Scratch::new("reap");
        let session = unique("reap");
        spawn_reaped(&session, &scratch.0);
        assert_eq!(pending_for(&session), vec![Some(scratch.0.clone())], "registered at once, with its folder");
        assert!(pending_exits().contains(&(session.clone(), Some(scratch.0.clone()))));
        let began = Instant::now();
        tokio::time::timeout(Duration::from_secs(10), await_exit(&session))
            .await
            .expect("await_exit never finished")
            .expect("await_exit failed");
        // Hurried: stopped from `EXIT_WAIT` after the reap, not left to `BACKGROUND_EXIT_WAIT`.
        assert!(began.elapsed() < BACKGROUND_EXIT_WAIT, "not hurried: {:?}", began.elapsed());
        assert!(pending_for(&session).is_empty(), "the exit is cleared once awaited");
        assert!(!exit_registry().lock().unwrap_or_else(|p| p.into_inner()).contains_key(&session));
        assert!(!hurries().lock().unwrap_or_else(|p| p.into_inner()).contains_key(&session), "its hurry signal is dropped too");
    }

    #[tokio::test]
    async fn reap_chains_behind_an_earlier_pending_exit_and_waits_for_both() {
        let scratch = Scratch::new("chain");
        let session = unique("chain");
        let earlier = pending_in_cwd(&session, Some(scratch.0.clone()));
        spawn_reaped(&session, &scratch.0);
        assert_eq!(pending_for(&session).len(), 2, "both exits are registered, oldest first");
        let waiter = tokio::spawn({
            let session = session.clone();
            async move { await_exit(&session).await }
        });
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(!waiter.is_finished(), "await_exit returned while the earlier exit was pending");
        assert_eq!(pending_for(&session).len(), 2, "the reap waits behind the earlier exit");
        drop(earlier);
        tokio::time::timeout(Duration::from_secs(10), waiter)
            .await
            .expect("await_exit never finished")
            .expect("the waiter panicked")
            .expect("await_exit failed");
        assert!(pending_for(&session).is_empty(), "both exits are cleared");
        assert!(!exit_registry().lock().unwrap_or_else(|p| p.into_inner()).contains_key(&session));
    }

    #[tokio::test]
    async fn await_exits_in_waits_for_reaped_child_in_nested_folder_without_blocking_other_folder() {
        let scratch = Scratch::new("nested");
        let root = scratch.0.join("root");
        let sub = root.join("sub");
        let other = scratch.0.join("other");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        let session = unique("nested");
        spawn_reaped(&session, &sub);
        let began = Instant::now();
        tokio::time::timeout(Duration::from_secs(1), await_exits_in(&other))
            .await
            .expect("another folder's wait was blocked")
            .expect("await_exits_in failed for another folder");
        assert!(began.elapsed() < Duration::from_secs(1));
        tokio::time::timeout(Duration::from_secs(10), await_exits_in(&root))
            .await
            .expect("await_exits_in never finished")
            .expect("await_exits_in failed");
        assert!(pending_for(&session).is_empty(), "the nested exit is waited for and cleared");
    }

    #[tokio::test]
    async fn await_all_exits_waits_for_multiple_reaped_sessions() {
        let scratch = Scratch::new("all");
        let first = unique("all-first");
        let second = unique("all-second");
        spawn_reaped(&first, &scratch.0);
        spawn_reaped(&second, &scratch.0);
        assert_eq!(pending_for(&first).len(), 1);
        assert_eq!(pending_for(&second).len(), 1);
        // Never fails or hangs: bounded by the cap even if another test holds an exit meanwhile.
        await_all_exits(EXIT_HARD_CAP).await;
        let registry = exit_registry().lock().unwrap_or_else(|p| p.into_inner());
        assert!(!registry.contains_key(&first) && !registry.contains_key(&second), "both reaped sessions are gone");
    }

    #[test]
    fn exit_note_reports_only_session_and_status_cross_platform() {
        #[cfg(unix)]
        let (failed, clean) = {
            use std::os::unix::process::ExitStatusExt;
            (std::process::ExitStatus::from_raw(1 << 8), std::process::ExitStatus::from_raw(0))
        };
        #[cfg(windows)]
        let (failed, clean) = {
            use std::os::windows::process::ExitStatusExt;
            (std::process::ExitStatus::from_raw(1), std::process::ExitStatus::from_raw(0))
        };
        assert!(!failed.success() && clean.success());
        assert!(exit_note("s1", clean).is_none(), "a clean exit logs nothing");
        let note = exit_note("s1", failed).unwrap();
        assert_eq!(note, format!("The CLI of session s1 exited with {failed} after finishing its turn"));
    }

    /// End to end on Windows: a clean Claude-family run returns at its `result` frame and its CLI
    /// is reaped in the background, as on Unix (`exit_tests.rs`, which is Unix-only).
    #[cfg(windows)]
    mod windows_run {
        use super::super::super::{external_path, test_launch::run_process_with_tools, tests::config, AgentEvent, Sink};
        use super::*;
        use tokio::sync::mpsc::unbounded_channel;

        /// Answers the init request and the prompt, then idles for 30 s with stdin closed.
        const SCRIPT: &str = r#"
$null = [Console]::In.ReadLine()
[Console]::Out.WriteLine('{"type":"control_response","response":{"request_id":"pandacode-init","subtype":"success","response":{}}}')
[Console]::Out.Flush()
$null = [Console]::In.ReadLine()
[Console]::Out.WriteLine('{"type":"system","subtype":"init","session_id":"win-reap"}')
[Console]::Out.WriteLine('{"type":"result","subtype":"success","result":"done"}')
[Console]::Out.Flush()
Start-Sleep -Seconds 30
"#;

        #[tokio::test]
        async fn clean_claude_run_returns_before_exit_and_reaps_in_background_on_windows() {
            let scratch = Scratch::new("win-run");
            let script = scratch.0.join("cli.ps1");
            std::fs::write(&script, SCRIPT).unwrap();
            let session = unique("win-run");
            let mut config = config("claude");
            config.session_id = session.clone();
            config.cwd = scratch.0.clone();
            let expected_cwd = external_path(&config.cwd);
            // `-File`: any flags the launch appends (such as `--mcp-config`) become ignored script arguments.
            let mut command = Command::new("powershell");
            command.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"]).arg(script);
            // Kept open: a closed input after the spawn would end the run as a stop, which is never reaped.
            let (_input, receiver) = unbounded_channel();
            let sink: Sink = Arc::new(|_: AgentEvent| {});
            let began = Instant::now();
            tokio::time::timeout(Duration::from_secs(25), run_process_with_tools(config, sink, receiver, command, Vec::new(), None))
                .await
                .expect("the run waited for the CLI to exit")
                .expect("the clean run failed");
            assert!(began.elapsed() < Duration::from_secs(25), "returned at `result`, not after the 30 s idle");
            assert!(
                pending_exits().contains(&(session.clone(), Some(expected_cwd))),
                "the CLI is still exiting in the background, under its folder: {:?}",
                pending_exits()
            );
            tokio::time::timeout(Duration::from_secs(10), await_exit(&session))
                .await
                .expect("await_exit never finished")
                .expect("await_exit failed");
            assert!(pending_for(&session).is_empty(), "the reaped CLI is stopped and cleared");
        }
    }

    #[tokio::test]
    async fn await_exits_in_waits_for_canonical_and_nested_cwds_only() {
        let base = std::env::temp_dir().join(format!("pandacode-exit-in-{}", uuid::Uuid::new_v4().simple()));
        let folder = base.join("chat");
        let nested = folder.join("sub");
        let elsewhere = base.join("other");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::create_dir_all(&elsewhere).unwrap();

        let other_id = format!("exit-in-other-{}", uuid::Uuid::new_v4().simple());
        let same_id = format!("exit-in-same-{}", uuid::Uuid::new_v4().simple());
        let nested_id = format!("exit-in-nested-{}", uuid::Uuid::new_v4().simple());

        // An unrelated folder's pending exit does not block awaiting `folder`.
        let hold_other = hold_in_cwd_for_test(&other_id, elsewhere.clone());
        tokio::time::timeout(Duration::from_secs(2), await_exits_in(&folder))
            .await
            .expect("unrelated exit must not block")
            .unwrap();

        // A pending exit matching `folder` via canonical spelling (`.`) or a nested cwd blocks until released.
        let hold_same = hold_in_cwd_for_test(&same_id, folder.join("."));
        let hold_nested = hold_in_cwd_for_test(&nested_id, nested.clone());
        let waiter = tokio::spawn({
            let folder = folder.clone();
            async move { await_exits_in(&folder).await }
        });
        tokio::time::sleep(Duration::from_millis(80)).await;
        assert!(!waiter.is_finished(), "must wait while matching exits are pending");

        drop(hold_same);
        tokio::time::sleep(Duration::from_millis(80)).await;
        assert!(!waiter.is_finished(), "must still wait for nested exit in the same folder");

        drop(hold_nested);
        tokio::time::timeout(Duration::from_secs(2), waiter)
            .await
            .expect("waiter should complete once matching exits end")
            .unwrap()
            .unwrap();

        // Timeout bounds a stuck exit.
        let stuck_id = format!("exit-in-stuck-{}", uuid::Uuid::new_v4().simple());
        let hold_stuck = hold_in_cwd_for_test(&stuck_id, folder.clone());
        assert!(wait_in(exit_registry(), &folder, Duration::from_millis(60), false, WaitScope::Folder).await.is_err());
        drop(hold_stuck);
        await_exit(&stuck_id).await.unwrap();

        drop(hold_other);
        await_exit(&other_id).await.unwrap();
        let _ = std::fs::remove_dir_all(base);
    }
}
