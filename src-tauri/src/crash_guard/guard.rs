//! The guard process (`pandacode __crash-guard …`): no GUI, no runtime. It reads the app's
//! pipe until EOF (or until `exit`), waits for the process to be gone, stops orphaned agent
//! process groups, records the death and relaunches the app when it crashed while armed.

use super::policy::{self, CrashRecord, Death, ExitStatus, Verdict};
use super::process::{self, Process};
use super::protocol::Watch;
use super::relaunch::{self, Mode};
use super::report;
use super::state::{self, GuardState, NotRestarted, Pending};
use std::ffi::OsString;
use std::io::{BufRead, Read};
use std::path::PathBuf;
use std::time::Duration;

pub const SUBCOMMAND: &str = "__crash-guard";
/// Pause between the app being gone and the relaunch: lets a logout's SIGTERM reach the guard
/// first, and keeps a crash loop from spinning the CPU.
const RELAUNCH_DELAY: Duration = Duration::from_millis(1500);
/// A panic report dated this long before the fatal marker belongs to the same death: the
/// hook writes it after `panic` (so later than it) but before the abort's `signal 6`, after
/// a backtrace that can take a while to capture.
const PANIC_REPORT_SLACK_MS: u64 = 60 * 1000;
/// Stands for "no wrapper" in the args.
const NO_WRAPPER: &str = "-";

/// The guard's command line, built by the app and parsed here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Config {
    pub pid: u32,
    pub data_dir: PathBuf,
    pub target: PathBuf,
    pub mode: Mode,
    pub launched_at: u64,
    /// The setting at spawn; only the initial `Watch::armed`, which `arm`/`disarm` then change.
    pub armed: bool,
    /// `xvfb-run`, when a `serve` relaunch must start a new display (wrapper.rs).
    pub wrapper: Option<PathBuf>,
    /// The app's own args (after argv[0]).
    pub args: Vec<String>,
}

impl Config {
    pub fn to_args(&self) -> Vec<OsString> {
        let mut out: Vec<OsString> = vec![
            SUBCOMMAND.into(),
            self.pid.to_string().into(),
            self.data_dir.clone().into(),
            self.target.clone().into(),
            self.mode.as_str().into(),
            self.launched_at.to_string().into(),
            if self.armed { "armed" } else { "disarmed" }.into(),
            self.wrapper.clone().map(OsString::from).unwrap_or_else(|| NO_WRAPPER.into()),
            "--".into(),
        ];
        out.extend(self.args.iter().map(Into::into));
        out
    }

    /// From the args after the subcommand; None when they are not ours.
    pub fn parse(args: &[OsString]) -> Option<Self> {
        let text = |i: usize| args.get(i).and_then(|a| a.to_str());
        if text(7) != Some("--") {
            return None;
        }
        Some(Self {
            pid: super::protocol::group_pid(text(0)?)?,
            data_dir: PathBuf::from(args.get(1)?),
            target: PathBuf::from(args.get(2)?),
            mode: Mode::parse(text(3)?)?,
            launched_at: text(4)?.parse().ok()?,
            armed: match text(5)? {
                "armed" => true,
                "disarmed" => false,
                _ => return None,
            },
            wrapper: Some(args.get(6)?).filter(|w| *w != NO_WRAPPER).map(PathBuf::from),
            args: args[8..].iter().map(|a| a.to_string_lossy().into_owned()).collect(),
        })
    }
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Whether `exit` ends the watch at once. Windows: an installer cannot replace an executable a
/// running process holds, and the app's job objects already end its agents. Unix: replacing a
/// running executable is fine, so after `exit` the guard (no longer relaunching anything)
/// stays until EOF and then stops any agent group still registered: a crash or kill during a
/// shutdown that takes seconds must not orphan them.
pub const LEAVE_AT_EXIT: bool = cfg!(windows);

/// Folds pipe lines (stamped by `clock`) until they end, or until `exit` when `leave_at_exit`.
/// `term` never ends the watch: if the app outlives it, the guard must still be there.
pub fn watch_pipe(lines: impl IntoIterator<Item = String>, initial: Watch, clock: impl Fn() -> u64, leave_at_exit: bool) -> Watch {
    let mut watch = initial;
    for line in lines {
        watch = watch.apply_line(&line, clock());
        if leave_at_exit && watch.exiting {
            break;
        }
    }
    watch
}

/// How often the guard checks the app by pid while its pipe stays open.
const ALIVE_POLL: Duration = Duration::from_millis(500);
/// After the app is seen gone, how long a line already in the pipe may take to arrive.
const DRAIN: Duration = Duration::from_millis(200);

/// The pipe's lines (read on their own thread) until EOF, or until `gone` says the app died
/// while a write end still exists elsewhere: a child another thread spawned in the moment
/// between std's `pipe()` and its close-on-exec (macOS has no `pipe2`) keeps one open.
pub fn pipe_lines(lines: std::sync::mpsc::Receiver<String>, poll: Duration, gone: impl Fn() -> bool) -> impl Iterator<Item = String> {
    use std::sync::mpsc::RecvTimeoutError;
    let mut draining = false;
    std::iter::from_fn(move || loop {
        match lines.recv_timeout(if draining { DRAIN } else { poll }) {
            Ok(line) => return Some(line),
            Err(RecvTimeoutError::Disconnected) => return None,
            Err(RecvTimeoutError::Timeout) if draining => return None,
            Err(RecvTimeoutError::Timeout) => draining = gone(),
        }
    })
}

/// Longest pipe line kept, in bytes; every line the app sends is under PIPE_BUF (512 on macOS).
/// A longer one is not the app's (another process inherited the write end) and is dropped
/// without being held in memory.
pub const MAX_LINE: usize = 1024;

/// Lines of at most `max` bytes (without the newline) from `reader`, until EOF or a read error;
/// longer lines are skipped whole, reading at most `max + 1` bytes of them at a time.
pub fn bounded_lines<R: BufRead>(mut reader: R, max: usize) -> impl Iterator<Item = String> {
    let mut buffer = Vec::new();
    let mut skipping = false;
    std::iter::from_fn(move || loop {
        buffer.clear();
        let read = (&mut reader).take(max as u64 + 1).read_until(b'\n', &mut buffer).ok()?;
        if read == 0 {
            return None;
        }
        let complete = buffer.last() == Some(&b'\n');
        if skipping || (!complete && buffer.len() > max) {
            skipping = !complete;
            continue;
        }
        return Some(String::from_utf8_lossy(&buffer).trim_end_matches(['\r', '\n']).to_owned());
    })
}

/// Stdin's lines on a channel; the channel closes at EOF or a read error.
fn read_stdin() -> std::sync::mpsc::Receiver<String> {
    let (sender, receiver) = std::sync::mpsc::channel();
    let reader = std::thread::Builder::new().name("crash-guard-pipe".into()).spawn(move || {
        for line in bounded_lines(std::io::stdin().lock(), MAX_LINE) {
            if sender.send(line).is_err() {
                break;
            }
        }
    });
    if let Err(error) = reader {
        eprintln!("Crash guard could not read its pipe: {error}");
    }
    receiver
}

/// What the guard did about one death, for logs and tests.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Ignored(Death),
    /// Crashed while restarts were off: a notice and the report, nothing started.
    NotArmed,
    Relaunched,
    Paused,
    /// The crash could not be recorded (the state file's lock not had in time, disk full):
    /// without a history the loop limit cannot work, so nothing is started.
    StateUnsaved,
    /// PandaCode was started (and took the notice) during the pause: no second instance.
    AlreadyRunning,
    RelaunchFailed(String),
    /// The relaunch exited at once with status 0: most likely the single-instance handoff to a
    /// PandaCode the user opened meanwhile. Handled as a failed relaunch (the notice goes back to
    /// not-restarted, unless that PandaCode already took it), logged as what it is.
    HandedOff,
}

/// Records a death and relaunches when allowed. `pause` runs between recording the crash and
/// the relaunch (`RELAUNCH_DELAY`); `launch` gets the relaunch args. Every crash leaves a
/// notice for the next launch; `relaunching` says this guard started one, which that launch
/// confirms as `restarted` when it takes the notice. Fails closed:
/// without a saved crash history the loop limit cannot work, so nothing is started. Every
/// save re-reads the mode's state file first (`state::update`), so a record another writer
/// saved meanwhile is kept.
pub fn conclude(config: &Config, watch: &Watch, exit: ExitStatus, now: u64, pause: impl FnOnce(), launch: impl FnOnce(&[String]) -> std::io::Result<()>) -> Outcome {
    let summary = match policy::classify(watch, exit, now) {
        Death::Crash(summary) => summary,
        other => {
            put_back_held(config, watch);
            return Outcome::Ignored(other);
        }
    };
    // When the app said it was dying: a slow core dump or gone-wait must not move it later.
    // Never in the future, never before this run's launch (a clock set back meanwhile).
    let at = crash_time(watch.fatal_at, config.launched_at, now);
    // The panic hook's report, even if its `report` line was lost: never a second one. When
    // its file cannot be found the guard writes its own, as for any other death, so a notice
    // never says it has a report that `crash_report_reveal` would have to guess.
    let hook_report = panic_hook_report(config, watch, exit, at).or_else(|| watch.report.then(|| report::panic_report_since(&config.data_dir, config.launched_at, config.pid)).flatten());
    let report_path = hook_report.or_else(|| write_death_report(config, &summary, at));
    let has_report = report_path.is_some();
    // Which report `crash_report_reveal` shows for this notice: the newest may be another
    // mode's (desktop and `serve` share `crash-reports/`).
    let report = report_path.as_deref().and_then(report::file_name);
    let path = state::state_path(&config.data_dir, config.mode);
    // Outside the report only the closed-set cause is kept: panic text can hold paths.
    let cause = policy::public_cause(&summary);
    let notice = |restarts_paused: bool, agents_interrupted: bool| Pending { crashed_at: at, summary: cause.clone(), has_report, restarts_paused, restarted: false, report: report.clone(), relaunching: false, agents_interrupted, not_restarted: None };
    // Agents this run's database recovery marked Interrupted for the notice it still holds
    // unshown (`interrupted` line, cleared by `shown`), or an unshown
    // notice this one replaces that said so: the page shows only the newest notice.
    let interrupted = |current: &GuardState| watch.agents_interrupted || current.pending.as_ref().is_some_and(|p| p.agents_interrupted);
    // The live setting. `crash-restart.json` is shared by every process on this data dir (a
    // `serve` host never hears the desktop's `arm`/`disarm`), so it decides when it can be
    // read; the pipe's last line otherwise. `config.armed` is only where the pipe started.
    if !state::saved_setting(&config.data_dir).unwrap_or(watch.armed) {
        let off = |current: &GuardState| Pending { not_restarted: Some(NotRestarted::Off), ..notice(false, interrupted(current)) };
        save(&path, |current| GuardState { pending: Some(off(&current)), crashes: current.crashes });
        return Outcome::NotArmed;
    }
    let crash = CrashRecord { at, startup: policy::is_startup(config.launched_at, at) };
    // Saved before the pause, with a not-restarted notice: a guard killed during it (logout)
    // starts nothing, and the next launch must not claim a restart.
    let saved = save(&path, |current| {
        let agents_interrupted = interrupted(&current);
        let crashes = policy::record(&current.crashes, crash);
        let paused = policy::verdict(&crashes, at) == Verdict::Pause;
        GuardState { crashes, pending: Some(notice(paused, agents_interrupted)) }
    });
    let Some(saved) = saved else { return Outcome::StateUnsaved };
    let Some(waiting) = saved.pending.filter(|pending| !pending.restarts_paused) else {
        return Outcome::Paused;
    };
    pause();
    // A claim, not yet a fact: the launch it marks makes it `restarted` (`Pending::confirmed`).
    let restarted = Pending { relaunching: true, ..waiting.clone() };
    relaunch_after_pause(config, &path, waiting, restarted, launch)
}

/// A deliberate or killed death (SIGTERM, Ctrl-C, SIGKILL) ends the app without its own put-back
/// (`commands::put_back_unshown` runs only on an announced exit): the notice it took at setup and
/// its page never showed (`held`, no `shown` after it) goes back for the next launch. After
/// `exit` the app did that itself. `state::put_back_pending` keeps a newer notice.
fn put_back_held(config: &Config, watch: &Watch) {
    let Some(held) = watch.held.clone().filter(|_| !watch.exiting) else { return };
    let held = Pending { agents_interrupted: held.agents_interrupted || watch.agents_interrupted, ..held };
    if let Err(error) = state::put_back_pending(&state::state_path(&config.data_dir, config.mode), held) {
        eprintln!("Crash guard could not keep the unshown crash notice: {error}");
    }
}

/// When this death happened: the fatal marker's time when there is one, kept between this
/// run's launch and `now`; `now` otherwise.
fn crash_time(fatal_at: Option<u64>, launched_at: u64, now: u64) -> u64 {
    fatal_at.map_or(now, |at| at.max(launched_at).min(now))
}

/// The restarted notice, then the launch. A PandaCode the user opened during the pause took
/// the waiting notice: it already runs (a desktop relaunch would only hand off to it, a second
/// `serve` would fight it for its port), so nothing is saved and nothing started. The restarted
/// notice is saved before launching: the new process may read it before `launch` returns.
fn relaunch_after_pause(config: &Config, path: &std::path::Path, waiting: Pending, restarted: Pending, launch: impl FnOnce(&[String]) -> std::io::Result<()>) -> Outcome {
    match swap_notice(path, &waiting, restarted.clone()) {
        None => return Outcome::Paused,
        Some(false) => return Outcome::AlreadyRunning,
        Some(true) => {}
    }
    match launch(&relaunch::relaunch_args(config.mode, &config.args, restarted.crashed_at)) {
        Ok(()) => Outcome::Relaunched,
        // A handoff to a PandaCode the user opened is no failure: that one may take the notice.
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            swap_notice(path, &restarted, waiting);
            Outcome::HandedOff
        }
        Err(error) => {
            swap_notice(path, &restarted, Pending { not_restarted: Some(NotRestarted::Failed), ..waiting });
            Outcome::RelaunchFailed(error.to_string())
        }
    }
}

/// The saved state; None (logged) when it could not be saved.
fn save(path: &std::path::Path, change: impl FnOnce(GuardState) -> GuardState) -> Option<GuardState> {
    state::update(path, change).inspect_err(|error| eprintln!("Crash guard could not save its state: {error}")).ok()
}

/// `state::replace_pending`; None (logged) when it could not be saved.
fn swap_notice(path: &std::path::Path, expected: &Pending, next: Pending) -> Option<bool> {
    state::replace_pending(path, expected, next).inspect_err(|error| eprintln!("Crash guard could not save its state: {error}")).ok()
}

/// Whether the panic hook's report of this death exists although its `report` line was lost.
/// Only a death that can be a panic adopts one (`policy::may_be_panic`), and only a report
/// written by this run: one dated before `config.launched_at` is an earlier run's death (a
/// panic, a relaunch, then another crash within the slack), which must not hide this one.
/// And only one the guarded process wrote (`config.pid` in its header): a `serve` host's
/// panic on the shared data dir is never the desktop app's abort, nor the other way round.
fn panic_hook_report(config: &Config, watch: &Watch, exit: ExitStatus, fatal_at: u64) -> Option<std::path::PathBuf> {
    let since = fatal_at.saturating_sub(PANIC_REPORT_SLACK_MS).max(config.launched_at);
    policy::may_be_panic(watch, exit).then(|| report::panic_report_since(&config.data_dir, since, config.pid)).flatten()
}

fn write_death_report(config: &Config, summary: &str, now: u64) -> Option<std::path::PathBuf> {
    report::write(&config.data_dir, report::Kind::Crash, now, &report::death_text(summary, now))
        .inspect_err(|error| eprintln!("Crash guard could not write a report: {error}"))
        .ok()
}

/// Entry for `main.rs`: true when this process is the guard (it has already run).
pub fn handle() -> bool {
    let args: Vec<OsString> = std::env::args_os().skip(1).collect();
    if args.first().and_then(|a| a.to_str()) != Some(SUBCOMMAND) {
        return false;
    }
    run_args(&args[1..]);
    true
}

pub fn run_args(args: &[OsString]) {
    // Stderr is `crash-guard.log`: a panic message could carry paths or text, so never log it.
    std::panic::set_hook(Box::new(|_| eprintln!("Crash guard stopped on an internal error.")));
    let Some(config) = Config::parse(args) else { return eprintln!("Crash guard: unexpected arguments.") };
    match derived(config.mode).map(|own| disagreement(&config, &own)) {
        Ok(None) => run(config),
        Ok(Some(field)) => eprintln!("Crash guard: the {field} in its arguments is not this app's; not running."),
        Err(error) => eprintln!("Crash guard: {error}; not running."),
    }
}

/// What the guard relaunches and where it writes, worked out by the guard itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Own {
    pub data_dir: PathBuf,
    pub target: PathBuf,
    pub wrapper: Option<PathBuf>,
}

/// The guard's own target, wrapper and data dir, from the same sources the app used (it runs
/// the same binary with the app's environment). Tests point them elsewhere only through
/// `#[cfg(test)]` code (`relaunch::launch_target`, `super::app_data_dir`).
fn derived(mode: Mode) -> Result<Own, String> {
    Ok(Own {
        data_dir: super::app_data_dir().ok_or("no app data directory")?,
        target: relaunch::launch_target().map_err(|error| format!("no launch target ({error})"))?,
        wrapper: super::wrapper::for_mode(mode, super::wrapper::current())?,
    })
}

/// The first field where argv differs from what the guard derived. Any local process can run
/// `pandacode __crash-guard …`; this keeps argv alone from choosing what the guard starts or
/// where it writes. It is no boundary against a caller that also sets the environment the
/// guard derives them from (HOME or XDG_DATA_HOME for the data dir, XAUTHORITY for whether to
/// re-wrap, APPIMAGE/APPDIR checked by `relaunch::trusted_appimage`): such a caller can point
/// the state files elsewhere or relaunch a checked AppImage, but runs as the same user and
/// could start those programs itself. The wrapper is only ever an xvfb-run in /usr/bin or /bin.
pub fn disagreement(config: &Config, own: &Own) -> Option<&'static str> {
    [("relaunch target", config.target == own.target), ("data directory", config.data_dir == own.data_dir), ("wrapper", config.wrapper == own.wrapper)]
        .into_iter()
        .find_map(|(field, same)| (!same).then_some(field))
}

fn run(config: Config) {
    #[cfg(unix)]
    let logs_to_file = super::files::writes_to(std::os::fd::AsFd::as_fd(&std::io::stderr()), &config.data_dir.join(super::spawn::GUARD_LOG));
    #[cfg(unix)]
    if logs_to_file {
        keep_log_fresh();
    }
    let app = Process::open(config.pid);
    let watch = watch_pipe(pipe_lines(read_stdin(), ALIVE_POLL, || app.gone()), Watch::new(config.armed), now_ms, LEAVE_AT_EXIT);
    if LEAVE_AT_EXIT && watch.exiting {
        return;
    }
    // The app may have pruned (or another guard rotated) `GUARD_LOG` during a long watch: what
    // follows must land in the file at the path, not in a deleted one.
    #[cfg(unix)]
    if logs_to_file {
        let log = config.data_dir.join(super::spawn::GUARD_LOG);
        let _ = super::files::rotate_redirected_log(&log, super::files::LOG_MAX_BYTES, &[std::os::fd::AsFd::as_fd(&std::io::stderr())]);
    }
    // EOF: the app's last write end closed as it exited. Orphans must have started by then.
    let died = process::clock_now();
    let Some(exit) = app.wait_gone(process::GONE_TIMEOUT) else {
        return eprintln!("Crash guard: PandaCode is still running after its pipe closed; leaving its agents alone and not relaunching.");
    };
    process::stop_children(&watch.children, died);
    let pause = || std::thread::sleep(RELAUNCH_DELAY);
    let background = relaunch_in_background(&watch);
    let outcome = conclude(&config, &watch, exit, now_ms(), pause, |args| {
        relaunch::launch(config.mode, &config.target, args, &config.data_dir, config.wrapper.as_deref(), background)
    });
    match outcome {
        Outcome::RelaunchFailed(error) => eprintln!("Crash guard could not relaunch PandaCode: {error}"),
        Outcome::HandedOff => eprintln!("Crash guard: the relaunched app handed off to a running PandaCode."),
        Outcome::AlreadyRunning => eprintln!("Crash guard: PandaCode was opened again during the pause; not relaunching."),
        Outcome::StateUnsaved => eprintln!("Crash guard could not record the crash, so PandaCode was not restarted."),
        _ => {}
    }
}

/// How often a guard looks at its log's time; `files::refresh_output` sets it at most daily.
#[cfg(unix)]
const LOG_FRESH_CHECK: Duration = Duration::from_secs(60 * 60);

/// A guard may watch for months without writing a line: its log's time is kept fresh so the
/// app's daily prune never deletes `GUARD_LOG` while the guard still has it open.
#[cfg(unix)]
fn keep_log_fresh() {
    let refresher = std::thread::Builder::new().name("crash-guard-log".into()).spawn(|| loop {
        let _ = super::files::refresh_output(std::os::fd::AsFd::as_fd(&std::io::stderr()), std::time::SystemTime::now());
        std::thread::sleep(LOG_FRESH_CHECK);
    });
    if let Err(error) = refresher {
        eprintln!("Crash guard could not start its log check: {error}");
    }
}

/// Only when the app said it was in the background: unknown keeps the relaunch in front.
fn relaunch_in_background(watch: &Watch) -> bool {
    watch.focused == Some(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    const NOW: u64 = 10 * policy::STARTUP_GRACE_MS;

    fn config(dir: &std::path::Path, armed: bool) -> Config {
        Config {
            pid: 42,
            data_dir: dir.to_owned(),
            target: PathBuf::from("/Applications/PandaCode.app/Contents/MacOS/pandacode"),
            mode: Mode::Desktop,
            launched_at: 0,
            armed,
            wrapper: None,
            args: vec!["--x".into()],
        }
    }

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pandacode-guard-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn pipe(bytes: &[u8], armed: bool) -> Watch {
        watch_pipe(bytes.lines().map_while(Result::ok), Watch::new(armed), || NOW, LEAVE_AT_EXIT)
    }

    /// A panic report as the hook of the app `config` guards (pid 42) writes it.
    fn own_panic(dir: &std::path::Path, at: u64, text: &str) -> std::io::Result<PathBuf> {
        report::write(dir, report::Kind::Panic, at, &format!("{}\n\n{text}", report::process_line(42)))
    }

    fn pending(dir: &std::path::Path) -> Pending {
        state::load::<GuardState>(&dir.join(state::STATE_FILE)).pending.unwrap()
    }

    #[test]
    fn config_round_trips_through_args() {
        let mut original = config(std::path::Path::new("/data dir/é"), true);
        let args = original.to_args();
        assert_eq!(args[0], SUBCOMMAND);
        assert_eq!(Config::parse(&args[1..]), Some(original.clone()));
        assert_eq!(Config::parse(&args[2..]), None);
        original.wrapper = Some(PathBuf::from("/usr/bin/xvfb-run"));
        assert_eq!(Config::parse(&original.to_args()[1..]), Some(original));
    }

    #[test]
    fn argv_that_names_another_target_dir_or_wrapper_is_refused() {
        let config = config(std::path::Path::new("/data"), true);
        let own = Own { data_dir: config.data_dir.clone(), target: config.target.clone(), wrapper: None };
        assert_eq!(disagreement(&config, &own), None);
        assert_eq!(disagreement(&Config { target: PathBuf::from("/tmp/evil"), ..config.clone() }, &own), Some("relaunch target"));
        assert_eq!(disagreement(&Config { data_dir: PathBuf::from("/etc"), ..config.clone() }, &own), Some("data directory"));
        assert_eq!(disagreement(&Config { wrapper: Some(PathBuf::from("/tmp/evil")), ..config.clone() }, &own), Some("wrapper"));
    }

    #[test]
    fn the_relaunch_stays_in_the_background_only_when_the_app_was() {
        assert!(!relaunch_in_background(&pipe(b"signal 11\n", true)));
        assert!(!relaunch_in_background(&pipe(b"blur\nfocus\nsignal 11\n", true)));
        assert!(relaunch_in_background(&pipe(b"focus\nblur\nsignal 11\n", true)));
    }

    #[test]
    fn the_pipe_stops_at_eof_or_exit_but_not_at_term() {
        assert_eq!(pipe(b"child 5 1\nsignal 11\n", true).signal, Some(11));
        let lines = || b"exit\nunchild 5\nsignal 11\n".lines().map_while(Result::ok);
        let left = watch_pipe(lines(), Watch::new(true).apply_line("child 5 1", 0), || NOW, true);
        assert!(left.exiting && left.signal.is_none() && left.children.contains_key(&5));
        // Staying after `exit` (Unix) keeps following agent groups until EOF, and the death is
        // still deliberate: nothing is relaunched.
        let stayed = watch_pipe(lines(), Watch::new(true).apply_line("child 5 1", 0), || NOW, false);
        assert!(stayed.exiting && stayed.children.is_empty());
        assert_eq!(policy::classify(&stayed, ExitStatus::Unknown, NOW), Death::Deliberate);
        let termed = pipe(b"term 15\nchild 9 3\n", true);
        assert_eq!((termed.terminated_at, termed.children.get(&9)), (Some(NOW), Some(&3)));
    }

    #[test]
    fn lines_end_when_the_app_is_gone_even_if_a_stray_write_end_keeps_the_pipe_open() {
        let (sender, receiver) = std::sync::mpsc::channel();
        sender.send("signal 11".to_string()).unwrap();
        let checks = std::cell::Cell::new(0);
        let gone = || {
            checks.set(checks.get() + 1);
            checks.get() >= 2
        };
        // `sender` stays alive: no EOF ever comes.
        let lines: Vec<String> = pipe_lines(receiver, Duration::from_millis(10), gone).collect();
        assert_eq!((lines, checks.get()), (vec!["signal 11".to_string()], 2));
        drop(sender);
        let (sender, receiver) = std::sync::mpsc::channel::<String>();
        drop(sender);
        assert_eq!(pipe_lines(receiver, Duration::from_secs(60), || panic!("EOF needs no check")).count(), 0);
    }

    #[test]
    fn a_crash_relaunches_once_with_the_mark_and_a_restarted_notice() {
        let dir = temp_dir();
        let launched = RefCell::new(Vec::new());
        let outcome = conclude(&config(&dir, true), &pipe(b"signal 11\n", true), ExitStatus::Unknown, NOW, || (), |args| {
            launched.borrow_mut().push(args.to_vec());
            Ok(())
        });
        assert_eq!(outcome, Outcome::Relaunched);
        assert_eq!(launched.into_inner(), [vec!["--x".to_string(), format!("--crash-restart={NOW}")]]);
        let notice = pending(&dir);
        assert!(notice.has_report && notice.relaunching && !notice.restarts_paused);
        assert_eq!(notice.summary.as_deref(), Some("Crashed with SIGSEGV"));
        assert_eq!(state::load::<GuardState>(&dir.join(state::STATE_FILE)).crashes, [CrashRecord { at: NOW, startup: false }]);
        assert!(report::newest(&dir).is_some());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_second_crash_before_the_notice_showed_still_says_agents_were_stopped() {
        // The relaunch marked agents Interrupted (`interrupted`), took the first notice out of
        // the file at setup and crashed again before its page showed it.
        let dir = temp_dir();
        let outcome = conclude(&config(&dir, true), &pipe(b"interrupted\nsignal 11\n", true), ExitStatus::Unknown, NOW, || (), |_| Ok(()));
        assert_eq!(outcome, Outcome::Relaunched);
        assert!(pending(&dir).agents_interrupted && pending(&dir).relaunching);
        // A crash with nothing interrupted says nothing about agents...
        let quiet = temp_dir();
        conclude(&config(&quiet, true), &pipe(b"signal 11\n", true), ExitStatus::Unknown, NOW, || (), |_| Ok(()));
        assert!(!pending(&quiet).agents_interrupted);
        // ...unless it replaces an unshown notice that did (restarts off: not relaunched).
        let path = dir.join(state::STATE_FILE);
        let state = state::load::<GuardState>(&path);
        state::save(&path, &GuardState { crashes: Vec::new(), ..state }).unwrap();
        let outcome = conclude(&config(&dir, false), &pipe(b"signal 11\n", false), ExitStatus::Unknown, NOW + 1, || (), |_| Ok(()));
        assert_eq!(outcome, Outcome::NotArmed);
        let replaced = pending(&dir);
        assert!(replaced.agents_interrupted && !replaced.relaunching);
        std::fs::remove_dir_all(dir).unwrap();
        std::fs::remove_dir_all(quiet).unwrap();
    }

    #[test]
    fn agents_stopped_belong_to_the_held_notice_never_to_a_later_crash() {
        // The notice was shown hours ago: a later crash with no agent running says nothing.
        let shown = temp_dir();
        conclude(&config(&shown, true), &pipe(b"interrupted\nshown\nsignal 11\n", true), ExitStatus::Unknown, NOW, || (), |_| Ok(()));
        assert!(!pending(&shown).agents_interrupted);
        // Still held and unshown: the new notice replaces it and keeps its flag.
        let held = temp_dir();
        conclude(&config(&held, true), &pipe(b"held 5 1010 -\ninterrupted\nsignal 11\n", true), ExitStatus::Unknown, NOW, || (), |_| Ok(()));
        assert!(pending(&held).agents_interrupted);
        std::fs::remove_dir_all(shown).unwrap();
        std::fs::remove_dir_all(held).unwrap();
    }

    #[test]
    fn a_notice_held_unshown_goes_back_when_the_app_is_terminated() {
        let dir = temp_dir();
        let held = b"held 5 1010 - Crashed with SIGSEGV\n";
        let outcome = conclude(&config(&dir, true), &pipe(&[held.as_slice(), b"interrupted\nterm 15\n"].concat(), true), ExitStatus::Unknown, NOW, || (), |_| panic!("not relaunched"));
        assert_eq!(outcome, Outcome::Ignored(Death::Deliberate));
        let back = pending(&dir);
        assert_eq!((back.crashed_at, back.restarted, back.agents_interrupted, back.summary.as_deref()), (5, true, true, Some("Crashed with SIGSEGV")));
        // Shown first, or announced with `exit` (the app put it back itself): nothing is written.
        for lines in [&b"shown\nterm 15\n"[..], b"exit\n"] {
            let quiet = temp_dir();
            conclude(&config(&quiet, true), &pipe(&[held.as_slice(), lines].concat(), true), ExitStatus::Unknown, NOW, || (), |_| Ok(()));
            assert_eq!(state::load::<GuardState>(&quiet.join(state::STATE_FILE)).pending, None, "{lines:?}");
            std::fs::remove_dir_all(quiet).unwrap();
        }
        // A newer notice (another death's) is kept.
        let newer = Pending { crashed_at: 9, ..back };
        state::save(&dir.join(state::STATE_FILE), &GuardState { crashes: Vec::new(), pending: Some(newer.clone()) }).unwrap();
        conclude(&config(&dir, true), &pipe(&[held.as_slice(), b"term 15\n"].concat(), true), ExitStatus::Unknown, NOW, || (), |_| Ok(()));
        assert_eq!(pending(&dir), newer);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_relaunch_that_handed_off_is_not_logged_as_a_failure_and_claims_no_restart() {
        let dir = temp_dir();
        let handed_off = || Err(std::io::Error::new(std::io::ErrorKind::AlreadyExists, "handed off"));
        let outcome = conclude(&config(&dir, true), &pipe(b"signal 11\n", true), ExitStatus::Unknown, NOW, || (), |_| handed_off());
        assert_eq!(outcome, Outcome::HandedOff);
        assert!(!pending(&dir).relaunching);
        let failed = conclude(&config(&dir, true), &pipe(b"signal 11\n", true), ExitStatus::Unknown, NOW + 1, || (), |_| Err(std::io::Error::other("exited at once")));
        assert_eq!(failed, Outcome::RelaunchFailed("exited at once".into()));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_restarted_notice_is_saved_only_after_the_pause() {
        let dir = temp_dir();
        let during = RefCell::new(None);
        let outcome = conclude(&config(&dir, true), &pipe(b"signal 11\n", true), ExitStatus::Unknown, NOW, || {
            *during.borrow_mut() = Some(state::load::<GuardState>(&dir.join(state::STATE_FILE)));
        }, |_| Ok(()));
        assert_eq!(outcome, Outcome::Relaunched);
        // Killed during the pause: the crash counts, and nothing claims a restart.
        let during = during.into_inner().unwrap();
        assert_eq!(during.crashes, [CrashRecord { at: NOW, startup: false }]);
        assert!(!during.pending.unwrap().relaunching);
        assert!(pending(&dir).relaunching);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn an_unsavable_crash_history_never_relaunches() {
        let dir = temp_dir();
        // The state file cannot be written (or read): it is a directory.
        std::fs::create_dir_all(dir.join(state::STATE_FILE).join("x")).unwrap();
        let never = |_: &[String]| -> std::io::Result<()> { panic!("must not relaunch") };
        for _ in 0..5 {
            let paused = || panic!("must not wait to relaunch");
            assert_eq!(conclude(&config(&dir, true), &pipe(b"signal 11\n", true), ExitStatus::Unknown, NOW, paused, never), Outcome::StateUnsaved);
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn panic_text_stays_in_the_report_and_out_of_the_state_file() {
        let dir = temp_dir();
        let watch = pipe(b"panic open /Users/alice/Secret/notes.md failed\n", true);
        assert_eq!(conclude(&config(&dir, true), &watch, ExitStatus::Unknown, NOW, || (), |_| Ok(())), Outcome::Relaunched);
        let state = std::fs::read_to_string(dir.join(state::STATE_FILE)).unwrap();
        assert!(!state.contains("/Users") && !state.contains("alice"), "{state}");
        assert_eq!(pending(&dir).summary.as_deref(), Some("Panic"));
        let report = std::fs::read_to_string(report::newest(&dir).unwrap()).unwrap();
        assert!(report.contains("/Users/alice/Secret/notes.md"), "{report}");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn deliberate_deaths_and_kills_never_relaunch_or_notify() {
        let dir = temp_dir();
        let never = |_: &[String]| -> std::io::Result<()> { panic!("must not relaunch") };
        assert_eq!(conclude(&config(&dir, true), &pipe(b"exit\n", true), ExitStatus::Unknown, NOW, || (), never), Outcome::Ignored(Death::Deliberate));
        assert_eq!(conclude(&config(&dir, true), &pipe(b"term 15\n", true), ExitStatus::Unknown, NOW, || (), never), Outcome::Ignored(Death::Deliberate));
        assert_eq!(conclude(&config(&dir, true), &pipe(b"", true), ExitStatus::Unknown, NOW, || (), never), Outcome::Ignored(Death::Killed(None)));
        assert_eq!(state::load::<GuardState>(&dir.join(state::STATE_FILE)), GuardState::default());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_panic_report_whose_line_was_lost_is_not_doubled_by_a_crash_report() {
        let dir = temp_dir();
        let old = NOW - PANIC_REPORT_SLACK_MS - 1;
        own_panic(&dir, old, "an older death").unwrap();
        // Only `signal 6` arrived: the panic's own lines were lost.
        let watch = pipe(b"signal 6\n", true);
        assert_eq!(conclude(&config(&dir, true), &watch, ExitStatus::Unknown, NOW, || (), |_| Ok(())), Outcome::Relaunched);
        let crash = report::newest(&dir).unwrap();
        assert!(crash.to_string_lossy().ends_with("-crash.txt"), "an old panic report is another death: {crash:?}");
        std::fs::remove_file(crash).unwrap();
        own_panic(&dir, NOW - 5, "this death").unwrap();
        assert_eq!(conclude(&config(&dir, true), &watch, ExitStatus::Unknown, NOW + 1, || (), |_| Ok(())), Outcome::Relaunched);
        assert!(report::newest(&dir).unwrap().to_string_lossy().ends_with(&format!("{}-panic.txt", NOW - 5)));
        assert!(pending(&dir).has_report);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn an_abort_never_adopts_the_other_modes_panic_report() {
        let dir = temp_dir();
        // `serve` (another pid) panicked on the shared data dir moments ago…
        report::write(&dir, report::Kind::Panic, NOW - 5, &format!("{}\n\nserve's panic", report::process_line(43))).unwrap();
        // …and the desktop app died of SIGABRT with no `panic` line, or with only `report`.
        for (at, lines) in [(NOW, &b"signal 6\n"[..]), (NOW + 1, b"report\nsignal 6\n")] {
            let _ = std::fs::remove_file(dir.join(state::STATE_FILE));
            let watch = Watch { fatal_at: Some(at), ..pipe(lines, true) };
            assert_eq!(conclude(&config(&dir, true), &watch, ExitStatus::Unknown, at, || (), |_| Ok(())), Outcome::Relaunched);
            assert_eq!(pending(&dir).report, Some(format!("{at}-crash.txt")), "adopted serve's report");
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_second_crash_soon_after_a_panic_gets_its_own_report() {
        let dir = temp_dir();
        // The previous run panicked at NOW - 10 s and was relaunched 2 s later.
        let earlier = NOW - 10_000;
        own_panic(&dir, earlier, "the previous run's panic").unwrap();
        let relaunched = Config { launched_at: earlier + 2_000, ..config(&dir, true) };
        let own_report = |watch: &Watch, at: u64| {
            // Each case alone: these crashes are seconds after launch, and the loop limit
            // would pause the second one.
            let _ = std::fs::remove_file(dir.join(state::STATE_FILE));
            let watch = &Watch { fatal_at: Some(at), ..watch.clone() };
            assert_eq!(conclude(&relaunched, watch, ExitStatus::Unknown, at, || (), |_| Ok(())), Outcome::Relaunched);
            assert!(pending(&dir).has_report);
            report::newest(&dir).unwrap().to_string_lossy().ends_with(&format!("{at}-crash.txt"))
        };
        // A SIGSEGV is never a panic; a SIGABRT could be one, but that report is the last run's.
        assert!(own_report(&pipe(b"signal 11\n", true), NOW), "the SIGSEGV adopted the earlier panic report");
        assert!(own_report(&pipe(b"signal 6\n", true), NOW + 1), "the abort adopted the earlier run's panic report");
        // A panic report this run wrote is adopted by its abort, not by a SIGSEGV.
        own_panic(&dir, NOW + 2, "this run's panic").unwrap();
        assert!(own_report(&pipe(b"signal 11\n", true), NOW + 3));
        std::fs::remove_file(report::newest(&dir).unwrap()).unwrap();
        assert!(!own_report(&pipe(b"signal 6\n", true), NOW + 4), "one death, one report");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_crash_with_restarts_off_leaves_a_notice_but_starts_nothing() {
        let dir = temp_dir();
        let never = |_: &[String]| -> std::io::Result<()> { panic!("must not relaunch") };
        assert_eq!(conclude(&config(&dir, false), &pipe(b"signal 6\n", false), ExitStatus::Unknown, NOW, || (), never), Outcome::NotArmed);
        let notice = pending(&dir);
        assert!(!notice.relaunching && !notice.restarts_paused && notice.has_report);
        assert_eq!(notice.not_restarted, Some(NotRestarted::Off));
        assert!(state::load::<GuardState>(&dir.join(state::STATE_FILE)).crashes.is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_failed_relaunch_is_not_reported_as_a_restart() {
        let dir = temp_dir();
        let outcome = conclude(&config(&dir, true), &pipe(b"signal 11\n", true), ExitStatus::Unknown, NOW, || (), |_| Err(std::io::Error::other("no such file")));
        assert_eq!(outcome, Outcome::RelaunchFailed("no such file".into()));
        assert!(!pending(&dir).relaunching);
        assert_eq!(pending(&dir).not_restarted, Some(NotRestarted::Failed));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_live_setting_from_the_pipe_decides_not_the_spawn_args() {
        let dir = temp_dir();
        let never = |_: &[String]| -> std::io::Result<()> { panic!("must not relaunch") };
        assert_eq!(conclude(&config(&dir, true), &pipe(b"disarm\nsignal 11\n", true), ExitStatus::Unknown, NOW, || (), never), Outcome::NotArmed);
        let launches = RefCell::new(0);
        let outcome = conclude(&config(&dir, false), &pipe(b"arm\nsignal 11\n", false), ExitStatus::Unknown, NOW, || (), |_| {
            *launches.borrow_mut() += 1;
            Ok(())
        });
        assert_eq!((outcome, launches.into_inner()), (Outcome::Relaunched, 1));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_shared_settings_file_decides_over_the_pipe() {
        let dir = temp_dir();
        let never = |_: &[String]| -> std::io::Result<()> { panic!("must not relaunch") };
        // Switched off in another process on this data dir: this guard's pipe still says armed.
        state::save(&dir.join(state::SETTINGS_FILE), &state::Settings { enabled: false }).unwrap();
        assert_eq!(conclude(&config(&dir, true), &pipe(b"signal 11\n", true), ExitStatus::Unknown, NOW, || (), never), Outcome::NotArmed);
        // Switched on there: a pipe that started disarmed relaunches.
        state::save(&dir.join(state::SETTINGS_FILE), &state::Settings { enabled: true }).unwrap();
        let outcome = conclude(&config(&dir, false), &pipe(b"signal 11\n", false), ExitStatus::Unknown, NOW + 1, || (), |_| Ok(()));
        assert_eq!(outcome, Outcome::Relaunched);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_crash_loop_pauses_with_a_notice_for_the_next_launch() {
        let dir = temp_dir();
        let watch = pipe(b"panic boom\nreport\n", true);
        let count = RefCell::new(0);
        let outcomes: Vec<Outcome> = [NOW, NOW + 1_000]
            .into_iter()
            .map(|at| {
                own_panic(&dir, at, "boom").unwrap();
                let watch = Watch { fatal_at: Some(at), ..watch.clone() };
                conclude(&Config { launched_at: at - 1, ..config(&dir, true) }, &watch, ExitStatus::Unknown, at, || (), |_| {
                    *count.borrow_mut() += 1;
                    Ok(())
                })
            })
            .collect();
        assert_eq!(outcomes, [Outcome::Relaunched, Outcome::Paused]);
        assert_eq!(count.into_inner(), 1);
        let notice = state::take_pending(&dir, Mode::Desktop, NOW + 1_000).unwrap();
        assert!(notice.restarts_paused && notice.has_report && !notice.relaunching);
        assert_eq!(notice.summary.as_deref(), Some("Panic"));
        // The panic hook's reports exist already: the guard adds none.
        assert!(report::newest(&dir).unwrap().to_string_lossy().ends_with(&format!("{}-panic.txt", NOW + 1_000)));
        assert_eq!(notice.report, Some(format!("{}-panic.txt", NOW + 1_000)));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_launch_during_the_pause_takes_the_notice_and_the_guard_starts_nothing() {
        let dir = temp_dir();
        let never = |_: &[String]| -> std::io::Result<()> { panic!("must not start a second instance") };
        let taken = RefCell::new(None);
        let outcome = conclude(&config(&dir, true), &pipe(b"signal 11\n", true), ExitStatus::Unknown, NOW, || {
            // The user's desktop launch at setup (`crash_guard::start`), long before its webview asks.
            *taken.borrow_mut() = super::super::take_notice(Mode::Desktop, &dir, true, NOW, None);
        }, never);
        assert_eq!(outcome, Outcome::AlreadyRunning);
        assert!(!taken.into_inner().unwrap().relaunching, "the user's launch saw a not-restarted notice");
        let after = state::load::<GuardState>(&dir.join(state::STATE_FILE));
        // No stale restarted notice for a later launch; the crash still counts.
        assert_eq!((after.pending, after.crashes), (None, vec![CrashRecord { at: NOW, startup: false }]));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_notice_names_its_own_report() {
        let dir = temp_dir();
        // The guard's own report for a signal.
        assert_eq!(conclude(&config(&dir, true), &pipe(b"signal 11\n", true), ExitStatus::Unknown, NOW, || (), |_| Ok(())), Outcome::Relaunched);
        assert_eq!(pending(&dir).report, Some(format!("{NOW}-crash.txt")));
        // The panic hook's report, adopted rather than written again.
        let at = NOW + 2 * policy::CRASH_WINDOW_MS;
        own_panic(&dir, at, "boom").unwrap();
        let watch = Watch { fatal_at: Some(at), ..pipe(b"panic boom\nreport\n", true) };
        assert_eq!(conclude(&Config { launched_at: at - 1, ..config(&dir, true) }, &watch, ExitStatus::Unknown, at, || (), |_| Ok(())), Outcome::Relaunched);
        assert_eq!(pending(&dir).report, Some(format!("{at}-panic.txt")));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn desktop_and_serve_keep_their_own_notice_and_history() {
        let dir = temp_dir();
        let serve = Config { mode: Mode::Serve, ..config(&dir, true) };
        assert_eq!(conclude(&config(&dir, true), &pipe(b"signal 11\n", true), ExitStatus::Unknown, NOW, || (), |_| Ok(())), Outcome::Relaunched);
        assert_eq!(conclude(&serve, &pipe(b"signal 6\n", true), ExitStatus::Unknown, NOW + 1, || (), |_| Ok(())), Outcome::Relaunched);
        let serve_notice = state::take_pending(&dir, Mode::Serve, NOW + 1).unwrap();
        assert_eq!(serve_notice.summary.as_deref(), Some("Crashed with SIGABRT"));
        assert_eq!(pending(&dir).summary.as_deref(), Some("Crashed with SIGSEGV"));
        for mode in [Mode::Desktop, Mode::Serve] {
            assert_eq!(state::load::<GuardState>(&state::state_path(&dir, mode)).crashes.len(), 1, "{mode:?}");
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_crash_another_guard_records_during_the_pause_is_kept() {
        let dir = temp_dir();
        let path = dir.join(state::STATE_FILE);
        let other = CrashRecord { at: NOW - 5, startup: false };
        let outcome = conclude(&config(&dir, true), &pipe(b"signal 11\n", true), ExitStatus::Unknown, NOW, || {
            state::update(&path, |mut current| {
                current.crashes.insert(0, other);
                current
            })
            .unwrap();
        }, |_| Ok(()));
        assert_eq!(outcome, Outcome::Relaunched);
        assert_eq!(state::load::<GuardState>(&path).crashes, [other, CrashRecord { at: NOW, startup: false }]);
        assert!(pending(&dir).relaunching);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_startup_crash_is_timed_by_its_fatal_line_not_by_a_slow_core_dump() {
        let dir = temp_dir();
        // Died 1 s after launch; the pipe closed minutes later.
        let watch = Watch { fatal_at: Some(1_000), ..pipe(b"signal 11\n", true) };
        const { assert!(NOW - 1_000 > policy::STARTUP_GRACE_MS) };
        assert_eq!(conclude(&config(&dir, true), &watch, ExitStatus::Unknown, NOW, || (), |_| Ok(())), Outcome::Relaunched);
        assert_eq!(state::load::<GuardState>(&dir.join(state::STATE_FILE)).crashes, [CrashRecord { at: 1_000, startup: true }]);
        let notice = pending(&dir);
        assert_eq!((notice.crashed_at, notice.report), (1_000, Some("1000-crash.txt".into())), "the notice and report are timed by the fatal line too");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_crash_time_is_the_fatal_line_kept_between_launch_and_now() {
        assert_eq!(crash_time(None, 10, 50), 50);
        assert_eq!(crash_time(Some(20), 10, 50), 20);
        assert_eq!(crash_time(Some(90), 10, 50), 50, "never in the future");
        assert_eq!(crash_time(Some(5), 10, 50), 10, "never before this run's launch");
        assert_eq!(crash_time(Some(5), 60, 50), 50, "a clock set back past the launch: now");
    }

    #[test]
    fn a_report_line_whose_file_is_missing_gets_the_guards_own_report() {
        let dir = temp_dir();
        // The hook said it wrote a report, but no file is there (a full disk, or pruned).
        let watch = pipe(b"panic boom
report
", true);
        assert_eq!(conclude(&config(&dir, true), &watch, ExitStatus::Unknown, NOW, || (), |_| Ok(())), Outcome::Relaunched);
        let notice = pending(&dir);
        assert!(notice.has_report);
        assert_eq!(notice.report, Some(format!("{NOW}-crash.txt")));
        assert!(report::named(&dir, &format!("{NOW}-crash.txt")).is_some());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn over_long_lines_are_dropped_and_the_rest_still_read() {
        let mut input = b"signal 11\n".to_vec();
        input.extend(std::iter::repeat_n(b'x', MAX_LINE * 50));
        input.extend(b"\nfocus\r\n");
        input.extend(std::iter::repeat_n(b'y', MAX_LINE));
        input.extend(b"\n");
        input.extend(std::iter::repeat_n(b'z', MAX_LINE + 1));
        input.extend(b"\nblur");
        let lines: Vec<String> = bounded_lines(&input[..], MAX_LINE).collect();
        assert_eq!(lines, ["signal 11".to_string(), "focus".into(), "y".repeat(MAX_LINE), "blur".into()]);
        assert_eq!(bounded_lines(&b""[..], MAX_LINE).count(), 0);
    }
}
