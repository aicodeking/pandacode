//! An unused spare retired in the background (`exit::retire_gracefully_in_cwd`): its stdin closes
//! so it can exit on its own, and it is killed once a launch hurries it or the wait runs out.
use super::super::exit::{pending_exits, retire_gracefully_in_cwd, SPARE_RETIRE_WAIT};
use super::test_support::TempDir;
use super::*;
use std::time::Instant;

fn scratch(name: &str) -> (TempDir, String) {
    let id = format!("warm-retire-{name}-{}", uuid::Uuid::new_v4().simple());
    let dir = std::env::temp_dir().join(format!("pandacode-{id}"));
    std::fs::create_dir_all(&dir).unwrap();
    (TempDir(dir), id)
}

/// A stand-in spare that idles about 30 s and ignores stdin closing, with stdin and stdout piped
/// like a real spare's (so it takes the graceful path).
fn stubborn(cwd: &Path) -> Command {
    let mut command = test_support::idle_sleep_command();
    command.current_dir(cwd).stdin(Stdio::piped()).stdout(Stdio::piped());
    #[cfg(unix)]
    command.process_group(0);
    command
}

fn retire_spawned(session_id: &str, cwd: &Path, mut command: Command) {
    let child = command.spawn().expect("the child starts");
    let group = ProcessGroup::register(child.id());
    retire_gracefully_in_cwd(session_id, child, group, None, Some(cwd.to_path_buf()));
}

fn pending_for(session_id: &str) -> Vec<Option<PathBuf>> {
    pending_exits().into_iter().filter(|(id, _)| id == session_id).map(|(_, cwd)| cwd).collect()
}

#[tokio::test]
async fn a_stubborn_spare_ignoring_stdin_eof_is_killed_at_once_when_a_launch_hurries_it() {
    let (dir, session) = scratch("hurry");
    retire_spawned(&session, &dir.0, stubborn(&dir.0));
    assert_eq!(pending_for(&session), vec![Some(dir.0.clone())], "registered at once, with its folder");
    let began = Instant::now();
    tokio::time::timeout(Duration::from_secs(10), await_exit(&session)).await.expect("await_exit never finished").expect("await_exit failed");
    assert!(began.elapsed() < SPARE_RETIRE_WAIT, "hurried, not left to the graceful wait: {:?}", began.elapsed());
    assert!(pending_for(&session).is_empty());
}

#[tokio::test]
async fn a_stubborn_spare_left_unhurried_is_killed_once_the_graceful_wait_runs_out() {
    let (dir, session) = scratch("patient");
    retire_spawned(&session, &dir.0, stubborn(&dir.0));
    let began = Instant::now();
    tokio::time::timeout(Duration::from_secs(15), await_exit_patiently(&session)).await.expect("await_exit never finished").expect("await_exit failed");
    // The child would idle 30 s: it was stopped when the graceful wait ran out.
    let waited = began.elapsed();
    assert!(waited >= SPARE_RETIRE_WAIT - Duration::from_millis(200) && waited < Duration::from_secs(15), "{waited:?}");
    assert!(pending_for(&session).is_empty());
}

#[tokio::test]
async fn a_spare_without_piped_stdin_is_killed_at_once() {
    let (dir, session) = scratch("null");
    let mut command = test_support::idle_sleep_command();
    command.current_dir(&dir.0);
    retire_spawned(&session, &dir.0, command);
    let began = Instant::now();
    tokio::time::timeout(Duration::from_secs(10), await_exit_patiently(&session)).await.expect("await_exit never finished").expect("await_exit failed");
    assert!(began.elapsed() < SPARE_RETIRE_WAIT, "nothing to close, so no graceful wait: {:?}", began.elapsed());
}

/// Unix only: `sh` gives a child that really exits on stdin EOF; its marker file is written only
/// if it finished on its own, never if it was killed.
#[cfg(unix)]
#[tokio::test]
async fn a_spare_exiting_on_stdin_eof_exits_naturally_without_being_killed() {
    let (dir, session) = scratch("clean");
    // Reads stdin to EOF, then takes a moment (as `SessionEnd` hooks do) and records it finished.
    let mut command = Command::new("sh");
    command
        .args(["-c", "cat >/dev/null; sleep 0.3; echo done > exited"])
        .current_dir(&dir.0)
        .process_group(0)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    retire_spawned(&session, &dir.0, command);
    let began = Instant::now();
    tokio::time::timeout(Duration::from_secs(10), await_exit_patiently(&session)).await.expect("await_exit never finished").expect("await_exit failed");
    assert!(began.elapsed() < SPARE_RETIRE_WAIT, "it exited on its own, before the kill: {:?}", began.elapsed());
    assert_eq!(std::fs::read_to_string(dir.0.join("exited")).ok().as_deref(), Some("done\n"), "it finished, not killed");
}

#[cfg(unix)]
#[tokio::test]
async fn a_spare_can_finish_its_eof_hook_after_filling_stderr() {
    let (dir, session) = scratch("stderr");
    let mut command = Command::new("sh");
    command
        .args(["-c", "cat >/dev/null && dd if=/dev/zero bs=4096 count=64 >&2 && echo done > exited"])
        .current_dir(&dir.0)
        .process_group(0)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    retire_spawned(&session, &dir.0, command);
    tokio::time::timeout(SPARE_RETIRE_WAIT * 3 / 4, await_exit_patiently(&session))
        .await
        .expect("stderr blocked the spare's graceful exit")
        .unwrap();
    assert_eq!(std::fs::read_to_string(dir.0.join("exited")).unwrap(), "done\n");
}

#[cfg(unix)]
#[tokio::test]
async fn session_quiescence_kills_a_pooled_spare_before_its_eof_hook_can_run() {
    let (dir, session) = scratch("quiesce");
    let pool = Pool::default();
    let child = Command::new("sh")
        .args(["-c", "echo ready > ready; cat >/dev/null; sleep 0.3; echo done > exited"])
        .current_dir(&dir.0)
        .process_group(0)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let pid = child.id().unwrap();
    let spare = Spare {
        key: "test-spare".into(),
        child,
        group: ProcessGroup::register(Some(pid)),
        server: None,
        born: Instant::now(),
        born_wall: std::time::SystemTime::now(),
        idle: IDLE,
        lead: false,
        renewal_due: false,
        cwd: Some(dir.0.clone()),
    };
    launched(&session);
    assert!(super::spawn::register(&pool, &session, epoch(&session), spare));
    assert!(test_support::eventually(|| dir.0.join("ready").exists()).await);

    // Until the earlier exit clears, the reaper cannot hurry a graceful retirement.
    // Closing stdin before killing the spare would give its hook time to finish.
    let previous = pending_in_cwd(&session, None);
    tokio::time::timeout(SPARE_RETIRE_WAIT * 3 / 4, async {
        let (result, ()) = tokio::join!(quiesce_in(&pool, &session), async {
            tokio::time::sleep(Duration::from_millis(600)).await;
            drop(previous);
        });
        result.unwrap();
    })
    .await
    .expect("quiescence waited for a graceful retirement");
    test_support::assert_process_gone(pid);
    assert!(!dir.0.join("exited").exists());
}

#[cfg(unix)]
#[tokio::test]
async fn same_task_replacement_kills_the_old_spare_before_its_eof_hook_can_run() {
    let (dir, session) = scratch("replace");
    let pool = Pool::default();
    let old_child = Command::new("sh")
        .args(["-c", "echo ready > ready; cat >/dev/null; sleep 0.3; echo done > exited"])
        .current_dir(&dir.0)
        .process_group(0)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let old_pid = old_child.id().unwrap();
    let spare = |child: Child, pid: u32| Spare {
        key: "test-spare".into(),
        child,
        group: ProcessGroup::register(Some(pid)),
        server: None,
        born: Instant::now(),
        born_wall: std::time::SystemTime::now(),
        idle: IDLE,
        lead: false,
        renewal_due: false,
        cwd: Some(dir.0.clone()),
    };
    launched(&session);
    assert!(super::spawn::register(&pool, &session, epoch(&session), spare(old_child, old_pid)));
    assert!(test_support::eventually(|| dir.0.join("ready").exists()).await);

    // Until the earlier exit clears, the reaper cannot hurry a graceful retirement, and the
    // old spare's hook (about 0.3 s after stdin closes) would finish well inside 600 ms.
    let previous = pending_in_cwd(&session, None);
    let new_child = stubborn(&dir.0).stderr(Stdio::piped()).kill_on_drop(true).spawn().unwrap();
    let new_pid = new_child.id().unwrap();
    assert!(super::spawn::register(&pool, &session, epoch(&session), spare(new_child, new_pid)));
    tokio::time::timeout(SPARE_RETIRE_WAIT * 3 / 4, async {
        let (result, ()) = tokio::join!(await_exit_patiently(&session), async {
            tokio::time::sleep(Duration::from_millis(600)).await;
            drop(previous);
        });
        result.unwrap();
    })
    .await
    .expect("the replaced spare was left to a graceful retirement");
    test_support::assert_process_gone(old_pid);
    assert!(!dir.0.join("exited").exists(), "the replaced spare was killed, not left to finish its hook");

    quiesce_in(&pool, &session).await.unwrap();
    test_support::assert_process_gone(new_pid);
}
