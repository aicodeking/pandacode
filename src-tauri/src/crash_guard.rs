//! Crash guard: restarts PandaCode after a crash, never after a deliberate exit.
//!
//! At startup the app spawns `pandacode __crash-guard …` (same binary, no GUI) with a pipe
//! on its stdin (`protocol`). The app announces deliberate exits (`exit`, or `term N` from
//! its SIGTERM/SIGINT/SIGHUP handler) and crashes (`panic …`, `signal N`); the guard reads
//! until EOF, classifies the death (`policy::classify`, refined on Windows by the exit
//! code), applies the crash-loop limit (`policy::verdict`), and relaunches with
//! `--crash-restart=<ms>`. The next launch takes the notice out of `crash-guard.json` in
//! `start` (after the single-instance plugin, so a duplicate launch never consumes it) and its
//! main webview gets it from memory (`crash_recovery_take`, until `crash_recovery_shown`). Local
//! reports go to `crash-reports/`.
//!
//! Off in debug builds unless `PANDACODE_CRASH_GUARD=1`; `PANDACODE_NO_CRASH_GUARD=1` turns
//! it off anywhere. The Settings switch (`crash-restart.json`) arms or disarms it live.

pub(crate) mod commands;
mod files;
mod guard;
mod link;
mod panic_hook;
mod policy;
mod process;
mod protocol;
mod relaunch;
mod report;
mod signals;
mod spawn;
mod startup;
mod state;
mod systemd;
mod webview;
mod wrapper;
mod writer;
#[cfg(all(test, unix))]
mod tests;

pub use guard::handle;
pub use relaunch::{is_restart_flag, Mode};
#[cfg(target_os = "linux")]
pub use files::narrow_webview_data;
pub use startup::desktop_startup_failed;
#[cfg(target_os = "macos")]
pub use webview::on_terminate as on_web_content_process_terminate;

use state::{NotRestarted, Pending, Settings};
use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

/// Forces the guard on in debug builds (testing).
pub const FORCE_ENV: &str = "PANDACODE_CRASH_GUARD";
/// Turns the guard off, in any build.
pub const OPT_OUT_ENV: &str = "PANDACODE_NO_CRASH_GUARD";
/// The app's identifier (tauri.conf.json): its data dir is `<data dir>/<identifier>`, as
/// Tauri's `app_data_dir`. A constant so the guard can derive the dir without the app context.
pub const IDENTIFIER: &str = "ai.pandacode.desktop";

/// CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB: no console
/// window, no Ctrl-C from the app's console, and not ended with a job the app was put in.
#[cfg(windows)]
const WINDOWS_DETACHED_FLAGS: u32 = 0x0800_0000 | 0x0000_0200 | CREATE_BREAKAWAY_FROM_JOB;
#[cfg(windows)]
const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;

static ENABLED: AtomicBool = AtomicBool::new(true);

/// Old reports, logs and temp files are removed at startup and then this often while the
/// process stays up, so none outlives its age limit by more than about a day.
const PRUNE_EVERY_MS: u64 = 24 * 60 * 60 * 1000;
/// How often a run without the guard's periodic check looks whether a prune is due. Short
/// against `PRUNE_EVERY_MS`: a sleeping computer stretches a thread's sleep, the clock goes on.
const PRUNE_CHECK: Duration = Duration::from_secs(60 * 60);
/// A guard's temp file (`files::write_private_atomic`) is renamed within moments: one this
/// old was left by a process that died mid-save.
const STALE_TEMP_AGE: Duration = Duration::from_secs(60 * 60);
/// When this process last pruned (ms since epoch; 0: not yet).
static LAST_PRUNE: AtomicU64 = AtomicU64::new(0);

/// Whether this build and environment run a guard at all.
fn allowed(debug: bool, force: Option<&str>, opt_out: Option<&str>) -> bool {
    let set = |value: Option<&str>| value.is_some_and(|v| !v.is_empty() && v != "0");
    !set(opt_out) && (!debug || set(force))
}

/// The app data dir, the same for the app and its guard.
pub fn app_data_dir() -> Option<PathBuf> {
    #[cfg(all(test, unix))]
    if let Some(dir) = std::env::var_os(tests::DIR_ENV) {
        return Some(PathBuf::from(dir));
    }
    dirs::data_dir().map(|dir| dir.join(IDENTIFIER))
}

/// Starts the guard for this process. The desktop app calls it once the single-instance
/// plugin has let this process go on; `serve` once the app is built, before its run loop.
pub fn start(mode: Mode) {
    let dir = app_data_dir();
    // Whether or not a guard runs: old reports and logs must not outlive their age limit.
    if let Some(dir) = &dir {
        prune_if_due(dir);
        #[cfg(unix)]
        if mode == Mode::Serve {
            relaunch::keep_serve_log_capped(dir);
        }
    }
    let wrapper = match gate(mode) {
        Ok(wrapper) => wrapper,
        Err(reason) => {
            if let Some(reason) = reason {
                eprintln!("Crash guard is off: {reason}.");
            }
            if let Some(dir) = dir {
                let _dropped = take_notice(mode, &dir, false, guard::now_ms(), None);
                keep_pruning(dir);
            }
            return;
        }
    };
    let Some(dir) = dir else {
        eprintln!("Crash guard is off: no app data directory.");
        return;
    };
    let enabled = state::load::<Settings>(&dir.join(state::SETTINGS_FILE)).enabled;
    ENABLED.store(enabled, Ordering::SeqCst);
    let connected = link::connect(mode, dir.clone(), enabled, wrapper);
    // Not set up (no relaunch target): `crash_recovery_take` hands nothing out in this run.
    if let Some(pending) = take_notice(mode, &dir, connected.setup, guard::now_ms(), relaunch::restart_mark(std::env::args_os().filter_map(|arg| arg.into_string().ok()))) {
        commands::hold_notice(pending);
    }
    if !connected.checked {
        keep_pruning(dir);
    }
}

/// Ok with the `xvfb-run` wrapper when this run gets a guard; Err with the reason to log, if
/// any, when it does not.
fn gate(mode: Mode) -> Result<Option<PathBuf>, Option<String>> {
    let env = |name: &str| std::env::var(name).ok();
    if !allowed(cfg!(debug_assertions), env(FORCE_ENV).as_deref(), env(OPT_OUT_ENV).as_deref()) {
        return Err(None);
    }
    // systemd restarts its service itself: a guard beside it would start a second host.
    if mode == Mode::Serve && systemd::supervises_this_process() {
        return Err(Some("systemd runs this serve as a service, and restarts are left to its Restart= setting".into()));
    }
    // As PID 1 (a container without an init) the app's death ends the whole PID namespace,
    // the guard with it, so a guard could never relaunch anything.
    if std::process::id() == 1 {
        return Err(Some("PandaCode runs as process 1, and nothing outlives it to restart it".into()));
    }
    wrapper::for_mode(mode, wrapper::current()).map_err(|reason| Some(reason.to_owned()))
}

/// Takes `mode`'s pending notice out of its state file at setup. `serve` has no webview: it
/// prints it. A desktop run with a guard returns it for `commands::hold_notice`, so a guard
/// still in its relaunch pause sees it gone at once (`state::replace_pending`) and starts no
/// duplicate, while the webview's `crash_recovery_take` gets it from memory later. This runs
/// only after the single-instance plugin let this process go on, so a duplicate launch never
/// takes it. A desktop run without a guard never hands it out, so it is dropped rather than
/// keep the crash time and cause in `crash-guard.json` forever. `mark` is this launch's
/// `--crash-restart` time: only the guard's own relaunch confirms a restart it claimed.
#[must_use]
fn take_notice(mode: Mode, dir: &std::path::Path, guarded: bool, now: u64, mark: Option<u64>) -> Option<Pending> {
    let pending = state::take_pending(dir, mode, now)?.confirmed(mark);
    match mode {
        Mode::Desktop => guarded.then_some(pending),
        Mode::Serve => {
            println!("{}", serve_notice(&pending, &dir.join(report::REPORTS_DIR), now));
            None
        }
    }
}

fn prune_old_files(dir: &std::path::Path) {
    let now = std::time::SystemTime::now();
    report::prune_all(dir, guard::now_ms());
    state::prune_old(dir, guard::now_ms());
    files::prune_logs(dir, &[relaunch::SERVE_LOG, spawn::GUARD_LOG], now, Duration::from_millis(report::MAX_REPORT_AGE_MS));
    files::prune_temp_files(dir, &[state::STATE_FILE, state::SERVE_STATE_FILE, state::SETTINGS_FILE], now, STALE_TEMP_AGE);
}

/// True, and `last` set to `now`, when no prune ran in the `PRUNE_EVERY_MS` before `now` (or
/// the clock was set back past the last one). Only one of several callers at once gets true.
fn prune_due(last: &AtomicU64, now: u64) -> bool {
    let before = last.load(Ordering::SeqCst);
    let due = before == 0 || now < before || now - before >= PRUNE_EVERY_MS;
    due && last.compare_exchange(before, now, Ordering::SeqCst, Ordering::SeqCst).is_ok()
}

/// Prunes at startup (the first call) and then about once a day. Cheap when nothing is due
/// (one atomic load), so the guard's 15 s check calls it every time.
fn prune_if_due(dir: &std::path::Path) {
    if prune_due(&LAST_PRUNE, guard::now_ms()) {
        prune_old_files(dir);
    }
}

/// The daily prune for a run without the guard's periodic check (the guard is off, or did
/// not start): a `serve` host under systemd stays up for months.
fn keep_pruning(dir: PathBuf) {
    let pruner = std::thread::Builder::new().name("crash-files-prune".into()).spawn(move || loop {
        std::thread::sleep(PRUNE_CHECK);
        prune_if_due(&dir);
    });
    if let Err(error) = pruner {
        eprintln!("Old crash reports are only removed at startup: {error}");
    }
}

/// The line a `serve` prints at its next start after a crash, so it says what happened, not
/// what to do. Never the summary: panic text can carry user content, and stdout goes to logs.
fn serve_notice(pending: &Pending, reports: &std::path::Path, now: u64) -> String {
    let at = clock_time(pending.crashed_at);
    let what = match (pending.restarted, pending.restarts_paused, pending.not_restarted) {
        (true, ..) => format!("PandaCode crashed at {at} and restarted"),
        // Restarts resume once the oldest crash in the window ages out: by the last one's end.
        (_, true, _) => {
            let resume = pending.crashed_at.saturating_add(policy::CRASH_WINDOW_MS);
            let when = if now > resume { "automatic restarts are on again".to_owned() } else { format!("automatic restarts resume by {}", clock_time(resume)) };
            format!("PandaCode kept crashing, last at {at}, and didn't restart; {when}")
        }
        (_, _, Some(NotRestarted::Off)) => format!("PandaCode crashed at {at} and didn't restart: automatic restarts are off (turn them on in the desktop app's Settings, or in {} in the data folder)", state::SETTINGS_FILE),
        (_, _, Some(NotRestarted::Failed)) => format!("PandaCode crashed at {at} and didn't restart: the restart failed"),
        (_, _, None) => format!("PandaCode crashed at {at} and didn't restart"),
    };
    // A bare file name only: the report sits in `reports`.
    let named = pending.report.as_deref().and_then(|name| std::path::Path::new(name).file_name());
    let details = named.map_or_else(|| reports.to_path_buf(), |name| reports.join(name));
    format!("{what}. Details: {}", details.display())
}

/// `ms` since the epoch as a UTC clock time, like the time in a crash report's header.
fn clock_time(ms: u64) -> String {
    chrono::DateTime::from_timestamp_millis(ms as i64).map_or_else(|| format!("{ms} ms since epoch"), |t| t.format("%Y-%m-%d %H:%M:%S UTC").to_string())
}

/// A deliberate exit follows (quit, update, restart): the guard will not relaunch, and a
/// crash notice the page never showed is kept for the next launch.
pub fn notify_exit() {
    link::announce_exit();
    commands::put_back_unshown();
}

/// The database was opened and marked `restart_interrupted` tasks Interrupted. A held, unshown
/// notice keeps it, and the guard is told (`interrupted`), so a crash before the page showed
/// the notice, or a quit that puts it back, does not lose it. With no notice held nothing is
/// sent: the flag never reaches a later crash's notice.
pub fn store_opened(restart_interrupted: usize) {
    if commands::note_interrupted(restart_interrupted) {
        if let Err(error) = sent(link::agents_interrupted()) {
            eprintln!("Stopped agents may be left out of the next crash notice: {error}");
        }
    }
}

/// The labels of PandaCode windows that hold focus now (usually one, briefly two or none
/// while focus moves between them).
static FOCUSED_WINDOWS: std::sync::Mutex<BTreeSet<String>> = std::sync::Mutex::new(BTreeSet::new());

/// Window `label` gained or lost focus (or closed: `false`). After a crash the relaunch comes
/// to the front only if the app was in front (macOS), which is while any of its windows (main,
/// tray popover, launcher, agents dock …) has focus, whatever order their events arrive in.
pub fn window_focused(label: &str, focused: bool) {
    let mut windows = FOCUSED_WINDOWS.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    *windows = with_focus(&windows, label, focused);
    // Under the lock, so two threads never send their states out of order.
    link::focus_changed(!windows.is_empty());
}

/// `windows` with `label` focused or not.
fn with_focus(windows: &BTreeSet<String>, label: &str, focused: bool) -> BTreeSet<String> {
    let others = windows.iter().filter(|other| *other != label).cloned();
    others.chain(focused.then(|| label.to_owned())).collect()
}

/// An agent process group the guard stops if the app dies abruptly. Err when a running guard
/// did not get it (no guard in this run is fine).
pub fn child_started(pid: u32) -> Result<(), String> {
    sent(link::child_started(pid))
}

pub fn child_ended(pid: u32) -> Result<(), String> {
    sent(link::child_ended(pid))
}

fn sent(result: link::Sent) -> Result<(), String> {
    match result {
        link::Sent::NoGuard | link::Sent::Delivered => Ok(()),
        link::Sent::Failed(error) => Err(format!("the crash guard did not get it ({error:?})")),
    }
}

#[cfg(test)]
mod gate_tests {
    use super::{allowed, prune_due, serve_notice, take_notice, with_focus, Mode, IDENTIFIER, PRUNE_EVERY_MS};
    use super::state::{self, GuardState, NotRestarted, Pending};

    #[test]
    fn a_run_without_a_guard_drops_a_notice_nothing_will_take() {
        let dir = std::env::temp_dir().join(format!("pandacode-notice-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(state::STATE_FILE);
        let pending = Pending { crashed_at: 1, summary: Some("Panic".into()), has_report: true, restarts_paused: false, restarted: true, report: None, relaunching: false, agents_interrupted: false, not_restarted: None };
        state::save(&path, &GuardState { crashes: Vec::new(), pending: Some(pending.clone()) }).unwrap();
        // A guarded desktop run takes it out of the file at setup and holds it for its webview…
        assert_eq!(take_notice(Mode::Desktop, &dir, true, 1, None), Some(pending.clone()));
        assert_eq!(state::load::<GuardState>(&path).pending, None);
        // …an unguarded one (opted out, systemd, PID 1) drops it.
        state::save(&path, &GuardState { crashes: Vec::new(), pending: Some(pending) }).unwrap();
        assert_eq!(take_notice(Mode::Desktop, &dir, false, 1, None), None);
        assert_eq!(state::load::<GuardState>(&path).pending, None);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_claimed_restart_is_told_only_by_the_relaunch_it_marked() {
        let dir = std::env::temp_dir().join(format!("pandacode-notice-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(state::STATE_FILE);
        let claimed = Pending { crashed_at: 7, summary: None, has_report: true, restarts_paused: false, restarted: false, report: None, relaunching: true, agents_interrupted: false, not_restarted: None };
        let take = |mark| {
            state::save(&path, &GuardState { crashes: Vec::new(), pending: Some(claimed.clone()) }).unwrap();
            take_notice(Mode::Desktop, &dir, true, 7, mark).unwrap()
        };
        // The guard's relaunch (`open -n` gave no handle to watch) took it: restarted.
        assert!(take(Some(7)).restarted);
        // That relaunch died before taking it, and the user opened PandaCode later: not restarted.
        let manual = take(None);
        assert!(!manual.restarted && !manual.relaunching);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_prune_is_due_at_startup_and_then_once_a_day() {
        let last = std::sync::atomic::AtomicU64::new(0);
        let start = 1_700_000_000_000;
        assert!(prune_due(&last, start), "the first call is the startup prune");
        assert!(!prune_due(&last, start + 15_000));
        assert!(!prune_due(&last, start + PRUNE_EVERY_MS - 1));
        assert!(prune_due(&last, start + PRUNE_EVERY_MS));
        assert!(!prune_due(&last, start + PRUNE_EVERY_MS + 1));
        // A clock set back does not stop pruning for as long as it was set back.
        assert!(prune_due(&last, start - 1));
    }

    #[test]
    fn the_identifier_matches_tauri_conf() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["identifier"], IDENTIFIER);
    }

    #[test]
    fn the_serve_startup_line_says_when_it_crashed_and_whether_it_was_started_again() {
        let at = 1_700_000_000_000; // 2023-11-14 22:13:20 UTC
        let notice = |restarted, restarts_paused| Pending { crashed_at: at, summary: Some("Panic: secret".into()), has_report: true, restarts_paused, restarted, report: None, relaunching: false, agents_interrupted: false, not_restarted: None };
        let dir = std::path::Path::new("/data/crash-reports");
        let line = |pending: &Pending, now| serve_notice(pending, dir, now);
        assert_eq!(line(&notice(true, false), at), "PandaCode crashed at 2023-11-14 22:13:20 UTC and restarted. Details: /data/crash-reports");
        let off = line(&notice(false, false), at);
        assert_eq!(off, "PandaCode crashed at 2023-11-14 22:13:20 UTC and didn't restart. Details: /data/crash-reports");
        let paused = notice(false, true);
        assert_eq!(super::policy::CRASH_WINDOW_MS, 600_000);
        assert_eq!(line(&paused, at + 1), "PandaCode kept crashing, last at 2023-11-14 22:13:20 UTC, and didn't restart; automatic restarts resume by 2023-11-14 22:23:20 UTC. Details: /data/crash-reports");
        // At exactly the window's end the guard still counts the crash (`policy::in_window` is inclusive).
        assert_eq!(line(&paused, at + 600_000), "PandaCode kept crashing, last at 2023-11-14 22:13:20 UTC, and didn't restart; automatic restarts resume by 2023-11-14 22:23:20 UTC. Details: /data/crash-reports");
        assert_eq!(line(&paused, at + 600_001), "PandaCode kept crashing, last at 2023-11-14 22:13:20 UTC, and didn't restart; automatic restarts are on again. Details: /data/crash-reports");
        let why = |reason| line(&Pending { not_restarted: Some(reason), ..notice(false, false) }, at);
        assert_eq!(why(NotRestarted::Off), "PandaCode crashed at 2023-11-14 22:13:20 UTC and didn't restart: automatic restarts are off (turn them on in the desktop app's Settings, or in crash-restart.json in the data folder). Details: /data/crash-reports");
        assert_eq!(why(NotRestarted::Failed), "PandaCode crashed at 2023-11-14 22:13:20 UTC and didn't restart: the restart failed. Details: /data/crash-reports");
        // A named report is the details; only its file name is used.
        let named = |name: &str| line(&Pending { report: Some(name.into()), ..notice(true, false) }, at);
        assert!(named("panic-1.txt").ends_with(". Details: /data/crash-reports/panic-1.txt"));
        assert!(named("../../etc/passwd").ends_with(". Details: /data/crash-reports/passwd"));
        for text in [off, why(NotRestarted::Failed), line(&paused, at)] {
            assert!(!text.contains("secret") && !text.contains('\n'), "{text}");
        }
    }

    #[test]
    fn the_app_is_in_front_while_any_of_its_windows_has_focus() {
        let apply = |events: &[(&str, bool)]| events.iter().fold(Default::default(), |set, (label, focused)| with_focus(&set, label, *focused));
        // Main → tray popover, in either event order: still in front.
        assert!(!apply(&[("main", true), ("tray", true), ("main", false)]).is_empty());
        assert!(!apply(&[("main", true), ("main", false), ("tray", true)]).is_empty());
        // The popover's late blur after the main window took focus back does not count.
        assert!(!apply(&[("tray", true), ("main", true), ("tray", false)]).is_empty());
        // Every window lost focus (another app is in front), or the focused one closed.
        assert!(apply(&[("main", true), ("dock", true), ("dock", false), ("main", false)]).is_empty());
        assert!(apply(&[("launcher", true), ("launcher", false)]).is_empty());
        // A repeated focus is one entry.
        assert_eq!(apply(&[("main", true), ("main", true)]).len(), 1);
    }

    #[test]
    fn debug_needs_the_force_variable_and_the_opt_out_always_wins() {
        assert!(allowed(false, None, None));
        assert!(!allowed(true, None, None));
        assert!(allowed(true, Some("1"), None));
        assert!(!allowed(true, Some("0"), None));
        assert!(!allowed(false, None, Some("1")));
        assert!(!allowed(true, Some("1"), Some("1")));
        assert!(allowed(false, None, Some("")));
    }
}
