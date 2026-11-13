//! End to end, with the real code: this test binary re-runs itself as a fixture app
//! (`app_entry`) that calls `link::connect`, which spawns a real guard process
//! (`guard_entry` → `guard::run_args`, see `spawn::base_command`). The fixture then dies in a
//! chosen way; the relaunch target is a script that records its args.

use super::guard;
use super::relaunch::{self, Mode};
use super::state::{self, GuardState};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

pub const GUARD_ENTRY: &str = "crash_guard::tests::guard_entry";
pub const GUARD_ARGS_ENV: &str = "PANDACODE_CRASH_GUARD_TEST_GUARD_ARGS";
pub const APP_ENV: &str = "PANDACODE_CRASH_GUARD_TEST_APP";
pub const TARGET_ENV: &str = "PANDACODE_CRASH_GUARD_TEST_TARGET";
const APP_ENTRY: &str = "crash_guard::tests::app_entry";
pub const DIR_ENV: &str = "PANDACODE_CRASH_GUARD_TEST_DIR";
const WAIT: Duration = Duration::from_secs(20);

/// The guard process body; a no-op in normal runs.
#[test]
fn guard_entry() {
    use std::os::unix::ffi::OsStrExt;
    let Some(joined) = std::env::var_os(GUARD_ARGS_ENV) else { return };
    let args: Vec<std::ffi::OsString> = joined.as_bytes().split(|b| *b == b'\n').map(|a| std::ffi::OsStr::from_bytes(a).to_owned()).collect();
    guard::run_args(&args[1..]);
}

/// The fixture app's body; a no-op in normal runs.
#[test]
fn app_entry() {
    let (Ok(scenario), Some(dir)) = (std::env::var(APP_ENV), std::env::var_os(DIR_ENV)) else { return };
    super::link::connect(Mode::Desktop, PathBuf::from(dir), scenario != "disarmed", None);
    say(&format!("guard {}", super::link::guard_pid().unwrap()));
    match scenario.as_str() {
        "abort" | "disarmed" => std::process::abort(),
        "exit" => {
            super::notify_exit();
            std::process::exit(0)
        }
        "exit-child" => {
            start_sleeper();
            super::notify_exit();
            // The guard stays after `exit` until the pipe closes (Unix).
            std::thread::sleep(Duration::from_millis(300));
            say(&format!("guard-alive {}", u8::from(alive(super::link::guard_pid().unwrap()))));
            // Gone mid-shutdown, its agent still registered.
            std::process::exit(0)
        }
        "term" => {
            start_sleeper();
            // SAFETY: plain raise(3): our handler reports `term`, then the default kills us.
            unsafe { libc::raise(libc::SIGTERM) };
        }
        "respawn" => {
            let old = super::link::guard_pid().unwrap();
            // SAFETY: kill(2) on the guard this process spawned.
            unsafe { libc::kill(old as i32, libc::SIGKILL) };
            let deadline = Instant::now() + WAIT;
            while super::link::guard_pid() == Some(old) && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(20));
                super::link::check();
            }
            say(&format!("guard {}", super::link::guard_pid().unwrap()));
            std::process::abort()
        }
        "leak" => {
            // As if another thread spawned it between std's pipe() and its close-on-exec: a
            // child that holds the pipe's write end, so the guard never reads EOF.
            let fd = super::link::guard_fd().unwrap();
            // SAFETY: fcntl on the pipe fd this process owns.
            unsafe { libc::fcntl(fd, libc::F_SETFD, 0) };
            let holder = Command::new("sleep").arg("60").stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
            say(&format!("child {}", holder.id()));
            std::process::abort()
        }
        "kill-segv" => {
            // As `kill -SEGV <pid>`: no fault address, so Rust std's stack-overflow handler
            // (installed before ours) would treat it as not its own and return.
            // SAFETY: kill(2) on this process.
            unsafe { libc::kill(libc::getpid(), libc::SIGSEGV) };
        }
        "panic" => {
            // Another thread holds the link (the 15 s check, a `child` line) as this one panics.
            super::link::with_link_locked(|| std::thread::spawn(|| panic!("fixture panic")).join().is_err());
            std::process::abort()
        }
        other => panic!("unknown scenario {other}"),
    }
    std::thread::sleep(Duration::from_secs(5));
    std::process::exit(9)
}

/// An agent-like `sleep 60` in its own process group, registered with the guard.
fn start_sleeper() -> u32 {
    let mut sleeper = Command::new("sleep");
    sleeper.arg("60").stdout(Stdio::null()).stderr(Stdio::null());
    std::os::unix::process::CommandExt::process_group(&mut sleeper, 0);
    let pid = sleeper.spawn().unwrap().id();
    super::child_started(pid).unwrap();
    say(&format!("child {pid}"));
    pid
}

fn say(line: &str) {
    let mut out = std::io::stdout();
    let _ = writeln!(out, "{line}");
    let _ = out.flush();
}

struct Run {
    dir: PathBuf,
    guards: Vec<u32>,
    children: Vec<u32>,
    lines: Vec<String>,
    status: std::process::ExitStatus,
}

fn temp_dir() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("pandacode-guard-e2e-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// Runs the fixture app through `scenario` and waits until every guard it had has finished.
fn run_app(scenario: &str) -> Run {
    run_app_with(scenario, 0o755)
}

/// `run_app` with the relaunch target's permissions (0o644: it cannot be started).
fn run_app_with(scenario: &str, target_mode: u32) -> Run {
    let dir = temp_dir();
    let target = dir.join("relaunch-target.sh");
    // Stays up past `relaunch::STARTED_WATCH`, like an app that started.
    std::fs::write(&target, format!("#!/bin/sh\necho \"$@\" >> '{}'\nsleep 1\n", dir.join("launched").display())).unwrap();
    std::fs::set_permissions(&target, std::os::unix::fs::PermissionsExt::from_mode(target_mode)).unwrap();
    let mut app = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", APP_ENTRY, "--nocapture", "-q", "--test-threads=1"])
        .env(APP_ENV, scenario)
        .env(DIR_ENV, &dir)
        .env(TARGET_ENV, &target)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let (mut guards, mut children, mut lines) = (Vec::new(), Vec::new(), Vec::new());
    for line in BufReader::new(app.stdout.take().unwrap()).lines().map_while(Result::ok) {
        lines.push(line.clone());
        let mut words = line.split(' ');
        let (kind, pid) = (words.next(), words.next().and_then(|p| p.parse().ok()));
        match (kind, pid) {
            (Some("guard"), Some(pid)) => guards.push(pid),
            (Some("child"), Some(pid)) => children.push(pid),
            _ => {}
        }
    }
    let status = app.wait().unwrap();
    for pid in &guards {
        assert!(wait_until(|| !alive(*pid)), "guard {pid} still running");
    }
    Run { dir, guards, children, lines, status }
}

fn alive(pid: u32) -> bool {
    // SAFETY: signal 0 only checks that the process exists.
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

fn wait_until(done: impl Fn() -> bool) -> bool {
    let deadline = Instant::now() + WAIT;
    while !done() {
        if Instant::now() > deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    true
}

fn launches(dir: &Path) -> Vec<String> {
    std::fs::read_to_string(dir.join("launched")).map(|text| text.lines().map(String::from).collect()).unwrap_or_default()
}

fn notice(dir: &Path) -> Option<state::Pending> {
    state::load::<GuardState>(&dir.join(state::STATE_FILE)).pending
}

#[test]
fn an_aborting_app_is_relaunched_once_with_the_restart_mark() {
    use std::os::unix::process::ExitStatusExt;
    let run = run_app("abort");
    assert_eq!(run.status.signal(), Some(libc::SIGABRT));
    assert!(wait_until(|| !launches(&run.dir).is_empty()));
    std::thread::sleep(Duration::from_millis(300));
    let launched = launches(&run.dir);
    assert_eq!(launched.len(), 1, "{launched:?}");
    assert!(launched[0].split(' ').any(relaunch::is_restart_flag), "{launched:?}");
    let notice = notice(&run.dir).unwrap();
    assert!(notice.relaunching && notice.has_report);
    assert_eq!(notice.summary.as_deref(), Some("Crashed with SIGABRT"));
    std::fs::remove_dir_all(run.dir).unwrap();
}

#[test]
fn a_crash_is_relaunched_even_while_a_child_holds_the_pipe_open() {
    let run = run_app("leak");
    let [holder] = run.children[..] else { panic!("no holder reported") };
    assert!(wait_until(|| launches(&run.dir).len() == 1), "no relaunch while the pipe stayed open");
    assert_eq!(notice(&run.dir).unwrap().summary.as_deref(), Some("Crashed with SIGABRT"));
    // SAFETY: kill(2) on the sleep this test's fixture started.
    unsafe { libc::kill(holder as i32, libc::SIGKILL) };
    std::fs::remove_dir_all(run.dir).unwrap();
}

#[test]
fn a_sigsegv_sent_with_kill_ends_the_app_and_counts_as_a_crash() {
    use std::os::unix::process::ExitStatusExt;
    let run = run_app("kill-segv");
    assert_eq!(run.status.signal(), Some(libc::SIGSEGV), "the app survived the signal: {:?}", run.status);
    assert!(wait_until(|| launches(&run.dir).len() == 1));
    let notice = notice(&run.dir).unwrap();
    assert_eq!((notice.summary.as_deref(), notice.relaunching), (Some("Crashed with SIGSEGV"), true));
    std::fs::remove_dir_all(run.dir).unwrap();
}

#[test]
fn a_panic_while_another_thread_holds_the_link_is_reported_once_as_a_panic() {
    let run = run_app("panic");
    assert!(wait_until(|| launches(&run.dir).len() == 1));
    let notice = notice(&run.dir).unwrap();
    assert_eq!((notice.summary.as_deref(), notice.has_report), (Some("Panic"), true));
    let reports: Vec<String> = std::fs::read_dir(run.dir.join(super::report::REPORTS_DIR)).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    assert!(matches!(&reports[..], [only] if only.ends_with("-panic.txt")), "{reports:?}");
    std::fs::remove_dir_all(run.dir).unwrap();
}

#[test]
fn a_deliberate_exit_is_not_relaunched() {
    let run = run_app("exit");
    assert_eq!(run.status.code(), Some(0));
    assert_eq!((launches(&run.dir), notice(&run.dir)), (Vec::new(), None));
    std::fs::remove_dir_all(run.dir).unwrap();
}

#[test]
fn agents_left_by_a_deliberate_exit_are_stopped_and_nothing_is_relaunched() {
    let run = run_app("exit-child");
    assert_eq!(run.status.code(), Some(0));
    assert!(run.lines.iter().any(|line| line == "guard-alive 1"), "the guard left at `exit`: {:?}", run.lines);
    let [child] = run.children[..] else { panic!("no child reported") };
    assert!(wait_until(|| !alive(child)), "agent group {child} survived the exit");
    assert_eq!((launches(&run.dir), notice(&run.dir)), (Vec::new(), None));
    std::fs::remove_dir_all(run.dir).unwrap();
}

#[test]
fn a_terminated_app_is_not_relaunched_and_its_agent_groups_are_stopped() {
    use std::os::unix::process::ExitStatusExt;
    let run = run_app("term");
    assert_eq!(run.status.signal(), Some(libc::SIGTERM));
    let [child] = run.children[..] else { panic!("no child reported") };
    assert!(wait_until(|| !alive(child)), "agent group {child} survived");
    assert_eq!((launches(&run.dir), notice(&run.dir)), (Vec::new(), None));
    std::fs::remove_dir_all(run.dir).unwrap();
}

#[test]
fn a_crash_with_restarts_off_leaves_a_notice_and_starts_nothing() {
    let run = run_app("disarmed");
    assert!(launches(&run.dir).is_empty());
    let notice = notice(&run.dir).unwrap();
    assert!(!notice.relaunching && !notice.restarts_paused);
    std::fs::remove_dir_all(run.dir).unwrap();
}

#[test]
fn a_killed_guard_is_respawned_and_still_relaunches_after_a_crash() {
    let run = run_app("respawn");
    let [first, second] = run.guards[..] else { panic!("guards: {:?}", run.guards) };
    assert_ne!(first, second);
    assert!(wait_until(|| launches(&run.dir).len() == 1));
    assert!(notice(&run.dir).unwrap().relaunching);
    std::fs::remove_dir_all(run.dir).unwrap();
}

#[test]
fn the_guard_logs_a_failed_relaunch_to_its_private_log() {
    let run = run_app_with("abort", 0o644);
    let log = run.dir.join(super::spawn::GUARD_LOG);
    let text = std::fs::read_to_string(&log).unwrap_or_default();
    assert!(text.contains("Crash guard could not relaunch PandaCode:"), "{text:?}");
    let mode = std::os::unix::fs::PermissionsExt::mode(&std::fs::metadata(&log).unwrap().permissions());
    assert_eq!(mode & 0o777, 0o600);
    assert!(!notice(&run.dir).unwrap().relaunching);
    std::fs::remove_dir_all(run.dir).unwrap();
}

#[test]
fn a_relaunch_starts_a_detached_process_with_the_restart_mark() {
    let dir = temp_dir();
    let out = dir.join("relaunched");
    let script = format!("printf '%s' \"$0\" > '{}'; sleep 1", out.display());
    let args = vec!["-c".to_string(), script, "--crash-restart=42".to_string()];
    relaunch::launch(Mode::Desktop, Path::new("/bin/sh"), &args, &dir, None, false).unwrap();
    assert!(wait_until(|| std::fs::read_to_string(&out).is_ok_and(|text| !text.is_empty())));
    assert_eq!(std::fs::read_to_string(&out).unwrap(), "--crash-restart=42");
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_serve_relaunch_under_xvfb_run_rewraps_and_logs_privately() {
    let dir = temp_dir();
    let out = dir.join("wrapped");
    let wrapper = dir.join("xvfb-run");
    std::fs::write(&wrapper, format!("#!/bin/sh\necho \"$@\" > '{}'\nsleep 1\n", out.display())).unwrap();
    std::fs::set_permissions(&wrapper, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    let args = relaunch::relaunch_args(Mode::Serve, &["serve".into(), "--sign-in".into()], 5);
    relaunch::launch(Mode::Serve, Path::new("/opt/pandacode"), &args, &dir, Some(&wrapper), false).unwrap();
    assert!(wait_until(|| std::fs::read_to_string(&out).is_ok_and(|text| !text.is_empty())));
    assert_eq!(std::fs::read_to_string(&out).unwrap().trim(), "-a /opt/pandacode serve --crash-restart=5");
    let mode = std::os::unix::fs::PermissionsExt::mode(&std::fs::metadata(dir.join("serve-restart.log")).unwrap().permissions());
    assert_eq!(mode & 0o777, 0o600);
    std::fs::remove_dir_all(dir).unwrap();
}
