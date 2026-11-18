//! A clean Claude-family run returns before its CLI exits; the next launch of the same
//! session waits for that exit (`reap`, `await_exit`).

use super::concurrent_process_tests::process_test_lock;
use super::*;
use super::exit::{exit_note, spawn_exit, NOTE_TAIL};
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};

/// Answers, then stays alive after stdin closes until the test writes to the FIFO `$1`.
/// A background `sleep` shares its process group. Reports `pid:grandchild` as the session.
const HELD: &str = r#"
IFS= read -r init
printf '%s\n' '{"type":"control_response","response":{"request_id":"pandacode-init","subtype":"success","response":{}}}'
IFS= read -r prompt
sleep 30 </dev/null >/dev/null 2>&1 &
printf '{"type":"system","subtype":"init","session_id":"%s:%s"}\n' "$$" "$!"
printf '%s\n' '{"type":"result","subtype":"success","result":"done"}'
while IFS= read -r _; do :; done
IFS= read -r _ < "$1"
printf 'old-exit\n' >> "$2"
"#;
const QUICK: &str = r#"
printf 'new-start\n' >> "$1"
IFS= read -r init
printf '%s\n' '{"type":"control_response","response":{"request_id":"pandacode-init","subtype":"success","response":{}}}'
IFS= read -r prompt
printf '{"type":"system","subtype":"init","session_id":"%s"}\n' "$$"
printf '%s\n' '{"type":"result","subtype":"success","result":"done"}'
"#;
const FAILING: &str = r#"
IFS= read -r init
printf '%s\n' '{"type":"control_response","response":{"request_id":"pandacode-init","subtype":"success","response":{}}}'
IFS= read -r prompt
printf '%s\n' 'fatal: relay rejected the key' >&2
exit 1
"#;
/// Leaves a background process in its group, then fails before any result.
const FAILING_WITH_CHILD: &str = r#"
IFS= read -r init
printf '%s\n' '{"type":"control_response","response":{"request_id":"pandacode-init","subtype":"success","response":{}}}'
IFS= read -r prompt
sleep 30 </dev/null >/dev/null 2>&1 &
printf '{"type":"system","subtype":"init","session_id":"%s:%s"}\n' "$$" "$!"
exit 1
"#;
/// Leaves a background process in its group and works until interrupted.
const STOPPABLE: &str = r#"
IFS= read -r init
printf '%s\n' '{"type":"control_response","response":{"request_id":"pandacode-init","subtype":"success","response":{}}}'
IFS= read -r prompt
sleep 30 </dev/null >/dev/null 2>&1 &
printf '{"type":"system","subtype":"init","session_id":"%s:%s"}\n' "$$" "$!"
while IFS= read -r line; do case "$line" in *interrupt*) exit 0 ;; esac; done
"#;

/// Keeps writing to stdout after `result`, once stdin has closed, then records a clean exit.
const WRITES_AFTER_RESULT: &str = r#"
IFS= read -r init
printf '%s\n' '{"type":"control_response","response":{"request_id":"pandacode-init","subtype":"success","response":{}}}'
IFS= read -r prompt
printf '{"type":"system","subtype":"init","session_id":"%s"}\n' "$$"
printf '%s\n' '{"type":"result","subtype":"success","result":"done"}'
while IFS= read -r _; do :; done
sleep 0.3
head -c 300000 /dev/zero | tr '\0' 'x'
printf '\nflushed\n'
printf 'clean-exit\n' >> "$1"
"#;

type Run = (tokio::task::JoinHandle<Result<(), String>>, UnboundedReceiver<AgentEvent>, UnboundedSender<RunInput>);

fn start(session: &str, script: &str, args: &[&Path]) -> Run {
    let mut config = tests::config("claude");
    config.session_id = session.into();
    let (input, receiver) = unbounded_channel();
    let (emit, events) = unbounded_channel();
    let sink: Sink = Arc::new(move |event| {
        let _ = emit.send(event);
    });
    let mut command = Command::new("/bin/sh");
    command.arg("-c").arg(script).arg("pandacode-test").args(args);
    (tokio::spawn(run_process(config, sink, receiver, command, Vec::new())), events, input)
}

async fn event(events: &mut UnboundedReceiver<AgentEvent>, kind: &str) -> String {
    loop {
        let event = events.recv().await.expect("run ended without the event");
        if event.kind == kind {
            return event.text;
        }
    }
}

fn fifo(name: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!("pandacode-exit-{}-{name}", std::process::id()));
    let _ = std::fs::remove_file(&path);
    assert!(std::process::Command::new("mkfifo").arg(&path).status().unwrap().success());
    path
}

/// Our direct child is reaped by `waitpid`; anyone else is gone once `kill(0)` fails.
fn dead(pid: u32) -> bool {
    let pid = pid as i32;
    unsafe { libc::waitpid(pid, std::ptr::null_mut(), libc::WNOHANG) == pid || libc::kill(pid, 0) == -1 }
}

fn eventually_dead(pid: u32) -> bool {
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while std::time::Instant::now() < deadline {
        if dead(pid) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    false
}

fn pids(session: &str) -> (u32, u32) {
    let (pid, child) = session.split_once(':').unwrap();
    (pid.parse().unwrap(), child.parse().unwrap())
}

#[tokio::test]
async fn a_clean_run_returns_before_exit_and_only_its_session_waits() {
    let _serial = process_test_lock().lock().await;
    let gate = fifo("held");
    // Stands in for the conversation's session file: each process logs when it touches it.
    let journal = std::env::temp_dir().join(format!("pandacode-exit-{}-journal", std::process::id()));
    let _ = std::fs::remove_file(&journal);
    let (mut task, mut events, _input) = start("exit-held", HELD, &[&gate, &journal]);
    let (pid, grandchild) = pids(&tokio::time::timeout(Duration::from_secs(10), event(&mut events, "session")).await.unwrap());
    tokio::time::timeout(Duration::from_secs(10), &mut task).await.unwrap().unwrap().unwrap();
    // The CLI is still running (it waits on the FIFO), yet the run has returned.
    assert_eq!(unsafe { libc::kill(pid as i32, 0) }, 0, "run waited for the process to exit");
    assert!(tokio::time::timeout(Duration::from_millis(300), await_exit("exit-held")).await.is_err());
    // Another session never waits.
    assert!(tokio::time::timeout(Duration::ZERO, await_exit("exit-elsewhere")).await.is_ok());
    // A new launch of the same session does not start its process yet.
    let (mut next, mut next_events, _next_input) = start("exit-held", QUICK, &[&journal]);
    assert!(tokio::time::timeout(Duration::from_millis(500), event(&mut next_events, "session")).await.is_err());
    // Read-write never blocks on a FIFO; held open until the reader has taken the line.
    let mut release = std::fs::OpenOptions::new().read(true).write(true).open(&gate).unwrap();
    std::io::Write::write_all(&mut release, b"x\n").unwrap();
    tokio::time::timeout(Duration::from_secs(5), await_exit("exit-held")).await.unwrap().unwrap();
    assert!(dead(pid));
    assert!(!process_registry().lock().unwrap().contains(&pid));
    assert!(eventually_dead(grandchild), "process group member leaked");
    tokio::time::timeout(Duration::from_secs(10), &mut next).await.unwrap().unwrap().unwrap();
    tokio::time::timeout(Duration::from_secs(5), await_exit("exit-held")).await.unwrap().unwrap();
    drop(release);
    // The resume began only after the old process had finished with the session.
    assert_eq!(std::fs::read_to_string(&journal).unwrap(), "old-exit\nnew-start\n");
    let _ = std::fs::remove_file(gate);
    let _ = std::fs::remove_file(journal);
}

#[tokio::test]
async fn a_waiter_outlasts_sigkill_and_reaping_when_the_cli_ignores_sigterm() {
    let _serial = process_test_lock().lock().await;
    let gate = fifo("ignores-term");
    let journal = std::env::temp_dir().join("pandacode-exit-unused");
    let (task, mut events, _input) = start("exit-ignores-term", &format!("trap '' TERM\n{HELD}"), &[&gate, &journal]);
    let (pid, grandchild) = pids(&tokio::time::timeout(Duration::from_secs(10), event(&mut events, "session")).await.unwrap());
    tokio::time::timeout(Duration::from_secs(10), task).await.unwrap().unwrap().unwrap();
    assert_eq!(unsafe { libc::kill(pid as i32, 0) }, 0, "CLI exited before the waiter started");
    tokio::time::timeout(Duration::from_secs(5), await_exit("exit-ignores-term")).await.unwrap().unwrap();
    // Check immediately: polling here could hide a waiter that returned before SIGKILL/reaping.
    assert_eq!(unsafe { libc::kill(pid as i32, 0) }, -1, "waiter returned before the CLI was reaped");
    assert_eq!(std::io::Error::last_os_error().raw_os_error(), Some(libc::ESRCH));
    assert!(!exit_registry().lock().unwrap().contains_key("exit-ignores-term"));
    assert!(!process_registry().lock().unwrap().contains(&pid));
    assert!(eventually_dead(grandchild), "process group member leaked");
    let _ = std::fs::remove_file(gate);
}

#[tokio::test]
async fn a_failed_run_still_waits_and_reports_stderr() {
    let _serial = process_test_lock().lock().await;
    let (task, _events, _input) = start("exit-failed", FAILING, &[]);
    let error = tokio::time::timeout(Duration::from_secs(10), task).await.unwrap().unwrap().unwrap_err();
    assert!(error.contains("relay rejected the key"), "{error}");
    assert!(!exit_registry().lock().unwrap().contains_key("exit-failed"));
}

#[tokio::test]
async fn a_failed_run_leaves_no_process_behind() {
    let _serial = process_test_lock().lock().await;
    let (task, mut events, _input) = start("exit-failed-child", FAILING_WITH_CHILD, &[]);
    let (pid, grandchild) = pids(&tokio::time::timeout(Duration::from_secs(10), event(&mut events, "session")).await.unwrap());
    tokio::time::timeout(Duration::from_secs(10), task).await.unwrap().unwrap().unwrap_err();
    assert!(!exit_registry().lock().unwrap().contains_key("exit-failed-child"), "errors keep the synchronous path");
    assert!(!process_registry().lock().unwrap().contains(&pid));
    assert!(eventually_dead(pid));
    assert!(eventually_dead(grandchild), "process group member leaked");
}

/// Stop and Pause both arrive as `RunInput::Stop`.
#[tokio::test]
async fn a_stopped_run_leaves_no_process_behind() {
    let _serial = process_test_lock().lock().await;
    let (task, mut events, input) = start("exit-stopped", STOPPABLE, &[]);
    let (pid, grandchild) = pids(&tokio::time::timeout(Duration::from_secs(10), event(&mut events, "session")).await.unwrap());
    input.send(RunInput::Stop).unwrap();
    tokio::time::timeout(Duration::from_secs(10), task).await.unwrap().unwrap().unwrap();
    assert!(!exit_registry().lock().unwrap().contains_key("exit-stopped"), "a stop keeps the synchronous path");
    assert!(!process_registry().lock().unwrap().contains(&pid));
    assert!(eventually_dead(pid));
    assert!(eventually_dead(grandchild), "process group member leaked");
}

/// Stop is answered while the previous process of the session is still exiting, and no process
/// is spawned for the stopped launch.
#[tokio::test]
async fn stop_during_the_exit_wait_ends_the_launch_without_spawning() {
    let _serial = process_test_lock().lock().await;
    let held = exit::hold_for_test("exit-stop-wait");
    let journal = std::env::temp_dir().join(format!("pandacode-exit-{}-stopwait", std::process::id()));
    let _ = std::fs::remove_file(&journal);
    let (task, mut events, input) = start("exit-stop-wait", QUICK, &[&journal]);
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(!task.is_finished(), "the launch should be waiting for the earlier exit");
    input.send(RunInput::Stop).unwrap();
    tokio::time::timeout(Duration::from_secs(2), task).await.expect("Stop was not serviced during the wait").unwrap().unwrap();
    let status = events.try_recv().expect("a stopped launch says it is stopping");
    assert_eq!((status.kind.as_str(), status.text.as_str()), ("status", "Stopping agent"));
    assert!(events.try_recv().is_err(), "a stopped launch emitted more than the status");
    assert!(!journal.exists(), "a process was spawned after Stop");
    drop(held);
    tokio::time::timeout(Duration::from_secs(5), await_exit("exit-stop-wait")).await.unwrap().unwrap();
}

/// A steer sent while the launch waits for the earlier exit is held and answered by the run once
/// its process exists, not dropped; a Stop sent after it still ends the launch unspawned.
#[tokio::test]
async fn a_steer_during_the_exit_wait_is_held_and_answered_after_spawn() {
    let _serial = process_test_lock().lock().await;
    let held = exit::hold_for_test("exit-steer-wait");
    let journal = std::env::temp_dir().join(format!("pandacode-exit-{}-steerwait", std::process::id()));
    let _ = std::fs::remove_file(&journal);
    let (task, mut events, input) = start("exit-steer-wait", QUICK, &[&journal]);
    let (reply, answered) = tokio::sync::oneshot::channel();
    input.send(RunInput::Steer { id: "s1".into(), text: "also this".into(), reply }).unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(!journal.exists(), "spawned before the earlier exit finished");
    drop(held);
    let answer = tokio::time::timeout(Duration::from_secs(10), answered).await.expect("the steer was never answered");
    assert!(answer.expect("the steer's reply was dropped").is_ok(), "the held steer failed");
    tokio::time::timeout(Duration::from_secs(10), event(&mut events, "session")).await.unwrap();
    let _ = tokio::time::timeout(Duration::from_secs(10), task).await;
    let _ = std::fs::remove_file(&journal);
}

#[tokio::test]
async fn stop_after_a_steer_during_the_exit_wait_still_wins() {
    let _serial = process_test_lock().lock().await;
    let held = exit::hold_for_test("exit-steer-stop");
    let journal = std::env::temp_dir().join(format!("pandacode-exit-{}-steerstop", std::process::id()));
    let _ = std::fs::remove_file(&journal);
    let (task, _events, input) = start("exit-steer-stop", QUICK, &[&journal]);
    let (reply, _answered) = tokio::sync::oneshot::channel();
    input.send(RunInput::Steer { id: "s1".into(), text: "x".into(), reply }).unwrap();
    input.send(RunInput::Stop).unwrap();
    tokio::time::timeout(Duration::from_secs(2), task).await.expect("Stop was not serviced").unwrap().unwrap();
    assert!(!journal.exists(), "a process was spawned after Stop");
    drop(held);
}

#[test]
fn dropping_the_runtime_kills_a_process_still_exiting() {
    let _serial = process_test_lock().blocking_lock();
    let gate = fifo("dropped");
    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
    let session = runtime.block_on(async {
        let journal = std::env::temp_dir().join("pandacode-exit-unused");
        let (task, mut events, input) = start("exit-dropped", HELD, &[&gate, &journal]);
        let session = event(&mut events, "session").await;
        task.await.unwrap().unwrap();
        drop(input);
        session
    });
    let (pid, grandchild) = pids(&session);
    drop(runtime);
    assert!(eventually_dead(pid), "CLI outlived the runtime");
    assert!(eventually_dead(grandchild), "process group member outlived the runtime");
    assert!(!process_registry().lock().unwrap().contains(&pid));
    let _ = std::fs::remove_file(gate);
}

/// Hold the reaper behind a gate beyond the former 1.75 s timeout. The child
/// remains alive until that gate opens, regardless of scheduler load.
#[tokio::test]
async fn a_delayed_reaper_never_allows_a_live_process_to_be_resumed() {
    let _serial = process_test_lock().lock().await;
    let session = "exit-delayed-reaper";
    let mut command = Command::new("/bin/sh");
    command.args(["-c", "exec sleep 30"]).stdin(Stdio::piped()).kill_on_drop(true);
    command.process_group(0);
    let mut child = command.spawn().unwrap();
    let pid = child.id().unwrap();
    let stdin = child.stdin.take().unwrap();
    let mut group = ProcessGroup::register(Some(pid));
    let (done, exiting) = tokio::sync::watch::channel(());
    exit_registry().lock().unwrap().insert(session.into(), exiting);
    let (release, gate) = tokio::sync::oneshot::channel();
    let reaper = tokio::spawn(async move {
        gate.await.unwrap();
        child.kill().await.unwrap();
        finish_child(&mut child, stdin, &mut group).await;
        exit_registry().lock().unwrap().remove(session);
        drop(done);
    });
    let waiter = await_exit_with_cap(session, Duration::from_secs(30));
    tokio::pin!(waiter);
    assert!(tokio::time::timeout(
        EXIT_WAIT + TERM_WAIT + Duration::from_millis(500), &mut waiter
    ).await.is_err(), "waiter returned before the gated reaper finished");
    assert_eq!(unsafe { libc::kill(pid as i32, 0) }, 0);
    release.send(()).unwrap();
    waiter.await.unwrap();
    assert!(dead(pid), "successful wait must imply confirmed process exit");
    reaper.await.unwrap();
}

#[tokio::test]
async fn a_hard_cap_fails_without_clearing_the_exit_registration() {
    let session = "exit-hard-cap";
    let (done, exiting) = tokio::sync::watch::channel(());
    exit_registry().lock().unwrap().insert(session.into(), exiting);
    let error = await_exit_with_cap(session, Duration::ZERO).await.unwrap_err();
    assert!(error.contains("still shutting down"), "{error}");
    assert!(exit_registry().lock().unwrap().contains_key(session));
    // A failed launch must leave the guard intact for the next launch.
    drop(done);
    await_exit_with_cap(session, Duration::from_secs(5)).await.unwrap();
    exit_registry().lock().unwrap().remove(session);
}

#[tokio::test]
async fn a_reaped_process_may_keep_writing_to_stdout_until_it_exits() {
    let _serial = process_test_lock().lock().await;
    let marker = std::env::temp_dir().join(format!("pandacode-exit-{}-flush", std::process::id()));
    let _ = std::fs::remove_file(&marker);
    let (task, _events, _input) = start("exit-flush", WRITES_AFTER_RESULT, &[&marker]);
    tokio::time::timeout(Duration::from_secs(10), task).await.unwrap().unwrap().unwrap();
    tokio::time::timeout(Duration::from_secs(10), await_exit("exit-flush")).await.unwrap().unwrap();
    assert_eq!(std::fs::read_to_string(&marker).unwrap_or_default(), "clean-exit\n", "the process hit a closed stdout pipe");
    let _ = std::fs::remove_file(marker);
}

/// Only a status PandaCode did not cause is the CLI's own; its SIGTERM is never logged as a failure.
#[tokio::test]
async fn wait_child_reports_its_own_escalation() {
    let spawn = |script: &str| {
        let mut command = Command::new("/bin/sh");
        command.arg("-c").arg(script).process_group(0).kill_on_drop(true);
        let child = command.spawn().unwrap();
        let group = ProcessGroup::register(child.id());
        (child, group)
    };
    let (mut child, mut group) = spawn("exit 0");
    let (status, escalated) = wait_child(&mut child, &mut group, Duration::from_secs(5)).await;
    assert!(status.is_some_and(|status| status.success()) && !escalated);
    let (mut child, mut group) = spawn("sleep 30");
    let (status, escalated) = wait_child(&mut child, &mut group, Duration::from_millis(100)).await;
    assert!(escalated && status.is_some_and(|status| !status.success()));
}

fn local_registry(entries: &[(&str, tokio::sync::watch::Receiver<()>)]) -> exit::Registry {
    std::sync::Mutex::new(entries.iter().map(|(session, exiting)| (session.to_string(), exiting.clone())).collect())
}

#[tokio::test]
async fn await_all_exits_returns_at_once_when_nothing_is_exiting() {
    let started = std::time::Instant::now();
    exit::wait_all(&local_registry(&[]), Duration::from_secs(30)).await;
    assert!(started.elapsed() < Duration::from_secs(5), "an empty registry must not wait");
}

#[tokio::test]
async fn await_all_exits_waits_for_every_pending_exit() {
    let ((first, a), (second, b)) = (tokio::sync::watch::channel(()), tokio::sync::watch::channel(()));
    let registry = std::sync::Arc::new(local_registry(&[("a", a), ("b", b)]));
    let waiting = tokio::spawn({
        let registry = registry.clone();
        async move { exit::wait_all(&registry, Duration::from_secs(30)).await }
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(!waiting.is_finished(), "returned while exits were pending");
    drop(first);
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(!waiting.is_finished(), "returned while one exit was pending");
    drop(second);
    tokio::time::timeout(Duration::from_secs(5), waiting).await.unwrap().unwrap();
}

#[tokio::test]
async fn await_all_exits_respects_the_cap() {
    let (_held, exiting) = tokio::sync::watch::channel(());
    let started = std::time::Instant::now();
    exit::wait_all(&local_registry(&[("stuck", exiting)]), Duration::from_millis(150)).await;
    let elapsed = started.elapsed();
    assert!(elapsed >= Duration::from_millis(100) && elapsed < Duration::from_secs(5), "{elapsed:?}");
}

#[tokio::test]
async fn await_all_exits_waits_for_an_exit_registered_meanwhile() {
    let (first, a) = tokio::sync::watch::channel(());
    let registry = std::sync::Arc::new(local_registry(&[("a", a)]));
    let waiting = tokio::spawn({
        let registry = registry.clone();
        async move { exit::wait_all(&registry, Duration::from_secs(30)).await }
    });
    let (second, b) = tokio::sync::watch::channel(());
    registry.lock().unwrap().insert("b".into(), b);
    drop(first);
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(!waiting.is_finished(), "returned before the later exit finished");
    drop(second);
    tokio::time::timeout(Duration::from_secs(5), waiting).await.unwrap().unwrap();
}

#[test]
fn a_nonzero_exit_logs_once_with_a_bounded_redacted_tail() {
    use std::os::unix::process::ExitStatusExt;
    let failed = std::process::ExitStatus::from_raw(1 << 8);
    let clean = std::process::ExitStatus::from_raw(0);
    let key = ["sk-secret-key".to_string()];
    assert!(exit_note("s1", clean, "ignored", &key).is_none());
    let note = exit_note("s1", failed, "boom sk-secret-key\n", &key).unwrap();
    assert!(note.contains("s1") && note.contains("boom [redacted]"), "{note}");
    assert!(!note.contains("sk-secret-key"), "{note}");
    // No secret known: the short tail is still logged.
    let note = exit_note("s2", failed, "boom", &[]).unwrap();
    assert!(note.contains("s2") && note.ends_with(": boom"), "{note}");
    // Several secrets are all hidden.
    let two = ["a-secret".to_string(), "b-secret".to_string()];
    let note = exit_note("s4", failed, "a-secret b-secret", &two).unwrap();
    assert!(!note.contains("-secret"), "{note}");
    // The tail is bounded.
    let long = "x".repeat(NOTE_TAIL * 3);
    let note = exit_note("s3", failed, &long, &[]).unwrap();
    assert_eq!(note.rsplit(": ").next().unwrap().len(), NOTE_TAIL, "{note}");
}

/// stdin closes at once, not after the earlier exit the reaper chains behind.
#[tokio::test]
async fn a_reaped_cli_sees_stdin_close_before_the_earlier_exit_finishes() {
    let _serial = process_test_lock().lock().await;
    let session = "exit-stdin-first";
    let marker = std::env::temp_dir().join(format!("pandacode-reap-stdin-{}", std::process::id()));
    let _ = std::fs::remove_file(&marker);
    // An earlier registration that stays pending.
    let (hold, held) = tokio::sync::oneshot::channel::<()>();
    spawn_exit(session, async move { let _ = held.await; });
    let mut command = Command::new("/bin/sh");
    command
        .args(["-c", "cat >/dev/null; printf eof > \"$1\"", "sh"])
        .arg(&marker)
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    command.process_group(0);
    let mut child = command.spawn().unwrap();
    let group = ProcessGroup::register(child.id());
    let (stdin, stdout, stderr) = (child.stdin.take().unwrap(), child.stdout.take().unwrap(), child.stderr.take().unwrap());
    reap(session.into(), child, stdin, stdout, group, StderrReader(tokio::spawn(read_stderr(stderr))), Vec::new());
    let mut seen = false;
    for _ in 0..50 {
        if marker.exists() { seen = true; break; }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let _ = std::fs::remove_file(&marker);
    drop(hold);
    await_exit(session).await.unwrap();
    assert!(seen, "the CLI never saw stdin close while chained behind an earlier exit");
}

/// A closed input is not a stop request: the launch keeps waiting for the earlier exit and then
/// spawns its process (the run loop, as before, treats the closed input as a stop only afterwards).
#[tokio::test]
async fn closed_input_during_the_exit_wait_still_runs_the_turn() {
    let _serial = process_test_lock().lock().await;
    let held = exit::hold_for_test("exit-closed-wait");
    let journal = std::env::temp_dir().join(format!("pandacode-exit-{}-closedwait", std::process::id()));
    let _ = std::fs::remove_file(&journal);
    let (task, _events, input) = start("exit-closed-wait", QUICK, &[&journal]);
    tokio::time::sleep(Duration::from_millis(200)).await;
    drop(input);
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(!task.is_finished(), "a closed input ended the launch");
    assert!(!journal.exists(), "the process started before the earlier exit finished");
    drop(held);
    let _ = tokio::time::timeout(Duration::from_secs(10), task).await.expect("the launch never finished");
    assert_eq!(std::fs::read_to_string(&journal).unwrap_or_default(), "new-start\n", "no process was spawned");
    let _ = std::fs::remove_file(&journal);
}

/// Ignores stdin closing and SIGTERM-free: stays until the FIFO `$1` is written, then exits.
const SLOW_EXIT: &str = r#"
IFS= read -r init
printf '%s\n' '{"type":"control_response","response":{"request_id":"pandacode-init","subtype":"success","response":{}}}'
IFS= read -r prompt
printf '{"type":"system","subtype":"init","session_id":"%s"}\n' "$$"
printf '%s\n' '{"type":"result","subtype":"success","result":"done"}'
while IFS= read -r _; do :; done
sleep 30
"#;

async fn slow_exit_session(session: &str) -> u32 {
    let (task, mut events, _input) = start(session, SLOW_EXIT, &[]);
    let pid: u32 = tokio::time::timeout(Duration::from_secs(10), event(&mut events, "session")).await.unwrap().parse().unwrap();
    tokio::time::timeout(Duration::from_secs(10), task).await.unwrap().unwrap().unwrap();
    pid
}

#[tokio::test]
async fn a_hurried_reap_escalates_near_exit_wait_not_background_wait() {
    let _serial = process_test_lock().lock().await;
    let pid = slow_exit_session("exit-hurried").await;
    let began = std::time::Instant::now();
    tokio::time::timeout(Duration::from_secs(10), await_exit("exit-hurried")).await.unwrap().unwrap();
    let took = began.elapsed();
    assert!(dead(pid));
    assert!(took < BACKGROUND_EXIT_WAIT, "a waiting launch still waited the background time: {took:?}");
    assert!(took < EXIT_WAIT + TERM_WAIT + Duration::from_millis(500), "{took:?}");
}

#[tokio::test]
async fn a_patient_wait_does_not_hurry_the_reap() {
    let _serial = process_test_lock().lock().await;
    let pid = slow_exit_session("exit-patient").await;
    let began = std::time::Instant::now();
    tokio::time::timeout(Duration::from_secs(10), await_exit_patiently("exit-patient")).await.unwrap().unwrap();
    let took = began.elapsed();
    assert!(dead(pid));
    assert!(took >= BACKGROUND_EXIT_WAIT - Duration::from_millis(300), "a spare cut the natural exit short: {took:?}");
}

#[tokio::test]
async fn a_launch_arriving_after_exit_wait_stops_the_process_at_once() {
    let _serial = process_test_lock().lock().await;
    let pid = slow_exit_session("exit-late-launch").await;
    tokio::time::sleep(EXIT_WAIT + Duration::from_millis(300)).await;
    assert_eq!(unsafe { libc::kill(pid as i32, 0) }, 0, "the patient reap ended early");
    let began = std::time::Instant::now();
    tokio::time::timeout(Duration::from_secs(10), await_exit("exit-late-launch")).await.unwrap().unwrap();
    let took = began.elapsed();
    assert!(dead(pid));
    assert!(took < TERM_WAIT + Duration::from_millis(500), "a late launch waited for the natural exit: {took:?}");
}
