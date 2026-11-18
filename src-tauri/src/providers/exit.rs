//! Background exit of clean Claude-family runs: `reap` finishes the process after the run
//! returns, and `await_exit` makes the next same-session launch wait for it.

use super::{redact::redact_key, wait_child, BACKGROUND_EXIT_WAIT, Child, ChildStdin, ChildStdout, ProcessGroup, StderrReader, EXIT_HARD_CAP, EXIT_WAIT};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
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

pub(super) type Registry = Mutex<HashMap<String, tokio::sync::watch::Receiver<()>>>;

/// Processes of clean Claude-family runs still exiting, by session id. Claude Code's natural exit
/// after its `result` frame is within `BACKGROUND_EXIT_WAIT` (`EXIT_WAIT` once a launch waits); the run returns at once and `reap` waits instead.
/// The sender drops when the process (and its group) is gone, or if the reaper is dropped.
pub(super) fn exit_registry() -> &'static Registry {
    static EXITING: OnceLock<Registry> = OnceLock::new();
    EXITING.get_or_init(Default::default)
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
        loop {
            let exiting = exit_registry().lock().unwrap_or_else(|p| p.into_inner()).get(session_id).cloned();
            let Some(mut exiting) = exiting else { return };
            if hurry {
                hurry_session(session_id);
            }
            // Sender closure is the reaper's completion signal.
            let _ = exiting.changed().await;
            // A finished exit left in place (not removed) must not be waited on again.
            let current = exit_registry().lock().unwrap_or_else(|p| p.into_inner()).get(session_id).cloned();
            if current.is_none_or(|current| current.same_channel(&exiting)) {
                return;
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
pub(super) fn spawn_exit(session_id: &str, task: impl std::future::Future<Output = ()> + Send + 'static) {
    spawn_exit_hurried(session_id, |_| task);
}

/// `spawn_exit` for a task that can shorten its own wait: it receives the hurry signal.
fn spawn_exit_hurried<F: std::future::Future<Output = ()> + Send + 'static>(
    session_id: &str,
    make: impl FnOnce(tokio::sync::watch::Receiver<bool>) -> F,
) {
    let Ok(runtime) = tokio::runtime::Handle::try_current() else { return };
    let hurry: Hurry = Arc::new(tokio::sync::watch::channel(false).0);
    let task = make(hurry.subscribe());
    hurries().lock().unwrap_or_else(|p| p.into_inner()).entry(session_id.to_owned()).or_default().push(hurry.clone());
    let (done, exiting) = tokio::sync::watch::channel(());
    let previous = exit_registry().lock().unwrap_or_else(|p| p.into_inner()).insert(session_id.to_owned(), exiting.clone());
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
        let mut registry = exit_registry().lock().unwrap_or_else(|p| p.into_inner());
        if registry.get(&session_id).is_some_and(|current| current.same_channel(&exiting)) {
            registry.remove(&session_id);
        }
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
    #[cfg(test)]
    pub(super) fn none() -> Self {
        Pending { _guard: None }
    }
}

/// Register an exit for a process that is about to start under `session_id`. The caller drops
/// the guard as soon as the process is registered (`warm::register`) or was never started;
/// `await_exit`'s hard cap still bounds any wait.
pub(super) fn pending(session_id: &str) -> Pending {
    let (guard, released) = tokio::sync::oneshot::channel::<()>();
    // The guard's sender closing is the signal; the value is never sent.
    spawn_exit(session_id, async move { let _ = released.await; });
    Pending { _guard: Some(guard) }
}

/// Test seam: an exit registered for `session_id` until the returned guard drops.
#[cfg(test)]
pub(crate) fn hold_for_test(session_id: &str) -> Box<dyn std::any::Any + Send> {
    Box::new(pending(session_id))
}

/// Kill a process the caller owns in pieces and cannot use (a spare that left the pool, or a
/// launch whose streams were unavailable) and register its exit under the session, so the next
/// same-session launch waits until it is really gone.
pub(super) fn retire_parts(
    session_id: &str,
    mut child: Child,
    group: ProcessGroup,
    server: Option<super::mcp_host::Server>,
) {
    drop(group);
    let _ = child.start_kill();
    spawn_exit(session_id, async move {
        let _ = child.wait().await;
        drop(server);
    });
}

/// The one log line for a reaped process that exited nonzero: session id and a short stderr
/// tail with every known secret (relay key, named-connection values) redacted.
pub(super) fn exit_note(
    session_id: &str,
    status: std::process::ExitStatus,
    stderr: &str,
    secrets: &[String],
) -> Option<String> {
    if status.success() {
        return None;
    }
    let redacted = secrets.iter().fold(stderr.trim().to_owned(), |text, secret| redact_key(&text, Some(secret)));
    let start = redacted.char_indices().rev().nth(NOTE_TAIL - 1).map_or(0, |(at, _)| at);
    let tail = &redacted[start..];
    let tail = if tail.is_empty() { String::new() } else { format!(": {tail}") };
    Some(format!("The CLI of session {session_id} exited with {status} after its run ended{tail}"))
}

/// Characters of stderr kept in `exit_note`.
pub(super) const NOTE_TAIL: usize = 300;

/// Finish a clean run's process in the background, with `finish_child`'s escalation. stdin is
/// closed at once, before the wait behind any earlier exit of the session, so the CLI never
/// idles with it open. Stdout is read to EOF and discarded meanwhile: Claude Code may still
/// write while it flushes after `result`, and a closed pipe would fail it. A nonzero exit is
/// logged once (`exit_note`); `secrets` are redacted from its stderr tail.
pub(super) fn reap(
    session_id: String,
    mut child: Child,
    stdin: ChildStdin,
    mut stdout: ChildStdout,
    mut group: ProcessGroup,
    mut stderr: StderrReader,
    secrets: Vec<String>,
) {
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
    spawn_exit_hurried(&session_id, move |hurry| async move {
        wait_natural_exit(&mut child, hurry, began).await;
        // Past the natural deadline this escalates at once; a finished exit just returns.
        let (status, escalated) = wait_child(&mut child, &mut group, Duration::ZERO).await;
        drain.abort();
        if escalated {
            // The status is PandaCode's own SIGTERM/SIGKILL, not a CLI failure.
            eprintln!("The CLI of session {id} was still exiting after {:.1}s and was stopped", began.elapsed().as_secs_f32());
        } else if let Some(status) = status.filter(|status| !status.success()) {
            let tail = tokio::time::timeout(Duration::from_millis(500), &mut stderr.0).await.ok().and_then(Result::ok).unwrap_or_default();
            if let Some(note) = exit_note(&id, status, &tail, &secrets) {
                eprintln!("{note}");
            }
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
