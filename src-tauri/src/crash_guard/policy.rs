//! Pure decisions: how the app died, and whether another automatic restart is allowed.

use super::protocol::Watch;
use serde::{Deserialize, Serialize};

/// Crashes within this window count towards the restart limit.
pub const CRASH_WINDOW_MS: u64 = 10 * 60 * 1000;
/// The crash that reaches this count in the window pauses restarts.
pub const MAX_CRASHES_IN_WINDOW: usize = 3;
/// A crash this soon after launch is a startup crash.
pub const STARTUP_GRACE_MS: u64 = 30 * 1000;
/// Consecutive startup crashes (in the window) that pause restarts: relaunching again would loop.
pub const MAX_STARTUP_CRASHES: usize = 2;
/// Crash records kept in the state file.
pub const HISTORY_LIMIT: usize = 10;

/// What the guard could learn from the OS about the exit, beyond the pipe.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExitStatus {
    /// macOS and Linux: a non-parent is not told how a process ended.
    Unknown,
    /// Windows: `GetExitCodeProcess`.
    #[cfg_attr(not(windows), allow(dead_code))]
    Code(u32),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Death {
    /// Quit, update, restart, a termination signal, or a plain exit code: never relaunched.
    Deliberate,
    /// Killed without a word (SIGKILL, Task Manager): the user's call, never relaunched.
    Killed(Option<u32>),
    /// A panic, fatal signal or exception: relaunched when armed and the loop guard allows.
    Crash(String),
}

/// NTSTATUS error severity: access violations, stack overflows, `__fastfail` (Rust's abort).
const NTSTATUS_ERROR: u32 = 0xC000_0000;
/// Error-severity codes that are not faults: the console was closed or the session is ending
/// (STATUS_CONTROL_C_EXIT, also logoff/shutdown console events), and a DLL refused to start
/// because the system is shutting down (STATUS_DLL_INIT_FAILED_LOGOFF).
const NTSTATUS_DELIBERATE: [u32; 2] = [0xC000_013A, 0xC000_026B];
/// A death this soon after `term` is that termination finishing, even if it faulted on the way.
pub const TERM_GRACE_MS: u64 = 60 * 1000;
/// A fatal marker older than this when the pipe closes no longer explains the death. Far
/// longer than `TERM_GRACE_MS`: after `signal N` the handler re-raises into the default action,
/// and the pipe only closes once the kernel (or systemd-coredump, or ReportCrash) has finished
/// the core dump, which for a large process on a slow disk takes minutes. A release panic
/// ends the process at once, so the same limit costs it nothing. The signal handler always
/// re-raises into SIG_DFL, so the app cannot outlive a `signal N` it sent; the limit only
/// bounds a marker the app somehow survived (a `panic` line from a caught panic in a debug
/// build with the guard forced on), after which a silent kill within it is misread as a crash.
pub const FATAL_GRACE_MS: u64 = 10 * 60 * 1000;

/// `__fastfail` (STATUS_STACK_BUFFER_OVERRUN): how Rust's abort ends a Windows process.
const NTSTATUS_FAST_FAIL: u32 = 0xC000_0409;
/// SIGABRT, the same number on every Unix: how `panic = "abort"` ends the process there.
const SIGABRT: i32 = 6;

/// Whether this death can be a panic whose own lines were lost: a `panic` line, or the abort
/// that follows a panic. Any other fatal signal or exception is another kind of death.
pub fn may_be_panic(watch: &Watch, exit: ExitStatus) -> bool {
    watch.panic.is_some() || watch.signal == Some(SIGABRT) || exit == ExitStatus::Code(NTSTATUS_FAST_FAIL)
}

fn within(at: Option<u64>, now: u64, grace: u64) -> bool {
    at.is_some_and(|at| now.saturating_sub(at) <= grace)
}

/// How the app died at `now`, from what it said on the pipe and what the OS reports.
pub fn classify(watch: &Watch, exit: ExitStatus, now: u64) -> Death {
    if watch.exiting || within(watch.terminated_at, now, TERM_GRACE_MS) {
        return Death::Deliberate;
    }
    if within(watch.fatal_at, now, FATAL_GRACE_MS) {
        if let Some(summary) = &watch.panic {
            return Death::Crash(format!("Panic: {summary}"));
        }
        if let Some(signal) = watch.signal {
            return Death::Crash(format!("{CRASHED_WITH}{}", signal_name(signal)));
        }
    }
    match exit {
        ExitStatus::Code(code) if NTSTATUS_DELIBERATE.contains(&code) => Death::Deliberate,
        ExitStatus::Code(code) if code & NTSTATUS_ERROR == NTSTATUS_ERROR => {
            Death::Crash(format!("{CRASHED_WITH}{}", exception_name(code)))
        }
        // A plain code is an exit the app chose (0, 1 …) or TerminateProcess from Task Manager (1).
        ExitStatus::Code(code) if code <= 1 => Death::Killed(Some(code)),
        ExitStatus::Code(_) => Death::Deliberate,
        ExitStatus::Unknown => Death::Killed(None),
    }
}

pub fn signal_name(signal: i32) -> String {
    let name = match signal {
        1 => "SIGHUP",
        2 => "SIGINT",
        4 => "SIGILL",
        5 => "SIGTRAP",
        6 => "SIGABRT",
        8 => "SIGFPE",
        9 => "SIGKILL",
        15 => "SIGTERM",
        // SIGBUS, SIGSEGV and SIGSYS differ between macOS and Linux.
        #[cfg(unix)]
        n if n == libc::SIGBUS => "SIGBUS",
        #[cfg(unix)]
        n if n == libc::SIGSEGV => "SIGSEGV",
        #[cfg(unix)]
        n if n == libc::SIGSYS => "SIGSYS",
        _ => return format!("signal {signal}"),
    };
    name.into()
}

/// Windows exception codes with a name (`crash-recovery-model.ts` `PLAIN_EXCEPTIONS`).
const EXCEPTIONS: [(u32, &str); 5] = [
    (0xC000_0005, "an access violation"),
    (0xC000_001D, "an illegal instruction"),
    (0xC000_00FD, "a stack overflow"),
    (0xC000_0409, "a fatal error (abort)"),
    (0xC000_0374, "heap corruption"),
];

fn exception_name(code: u32) -> String {
    match EXCEPTIONS.iter().find(|(known, _)| *known == code) {
        Some((_, name)) => (*name).into(),
        None => format!("exception 0x{code:08X}"),
    }
}

/// The names `signal_name` gives the fatal signals a crash can carry (other signals are
/// `signal N`). SIGHUP, SIGINT, SIGKILL and SIGTERM are named for logs but are never a crash's
/// cause: a forced quit or stop request must never be described as a crash.
const SIGNAL_NAMES: [&str; 7] = ["SIGILL", "SIGTRAP", "SIGABRT", "SIGFPE", "SIGBUS", "SIGSEGV", "SIGSYS"];
/// SIGHUP, SIGINT, SIGQUIT, SIGKILL, SIGTERM (the same numbers on every Unix): stop requests
/// the app reports as `term N`, and SIGKILL, which no handler sees. A `signal N` line naming
/// one is not the app's (`protocol::Message::parse` drops it), so none ever makes a crash.
pub const TERMINATION_SIGNALS: [i32; 5] = [1, 2, 3, 9, 15];
const CRASHED_WITH: &str = "Crashed with ";
/// What a panic becomes outside the report.
pub const PUBLIC_PANIC: &str = "Panic";

/// The part of a death summary that may leave the report file: `Panic` for any panic (its
/// message can hold paths or user text), `Crashed with <signal or exception name>` from the
/// closed sets above, None for anything else. Never free text.
pub fn public_cause(summary: &str) -> Option<String> {
    if summary.starts_with("Panic:") || summary == PUBLIC_PANIC {
        return Some(PUBLIC_PANIC.into());
    }
    let name = summary.strip_prefix(CRASHED_WITH)?;
    let known = SIGNAL_NAMES.contains(&name) || EXCEPTIONS.iter().any(|(_, known)| *known == name);
    known.then(|| format!("{CRASHED_WITH}{name}"))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct CrashRecord {
    /// ms since the Unix epoch.
    pub at: u64,
    pub startup: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    Restart,
    /// Too many crashes: the next manual launch tells the user.
    Pause,
}

/// History plus the new crash, oldest first: only records within `CRASH_WINDOW_MS` before it
/// (the only ones `verdict` reads), at most `HISTORY_LIMIT`.
pub fn record(history: &[CrashRecord], crash: CrashRecord) -> Vec<CrashRecord> {
    let mut next = in_window(history, crash.at);
    next.push(crash);
    let skip = next.len().saturating_sub(HISTORY_LIMIT);
    next.split_off(skip)
}

/// The records within `CRASH_WINDOW_MS` before `now` (none from after it): all a later
/// `verdict` can read, so nothing else is worth keeping.
pub fn in_window(history: &[CrashRecord], now: u64) -> Vec<CrashRecord> {
    history.iter().copied().filter(|r| r.at <= now && now - r.at <= CRASH_WINDOW_MS).collect()
}

/// Whether to restart after the newest crash in `history` (as returned by `record`).
pub fn verdict(history: &[CrashRecord], now: u64) -> Verdict {
    let recent: Vec<&CrashRecord> = history.iter().filter(|r| now.saturating_sub(r.at) <= CRASH_WINDOW_MS).collect();
    if recent.len() >= MAX_CRASHES_IN_WINDOW {
        return Verdict::Pause;
    }
    let startup_run = recent.iter().rev().take_while(|r| r.startup).count();
    if startup_run >= MAX_STARTUP_CRASHES {
        return Verdict::Pause;
    }
    Verdict::Restart
}

pub fn is_startup(launched_at: u64, crashed_at: u64) -> bool {
    crashed_at.saturating_sub(launched_at) < STARTUP_GRACE_MS
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_000_000;

    fn watch(lines: &[&str]) -> Watch {
        lines.iter().fold(Watch::new(true), |w, l| w.apply_line(l, NOW))
    }

    #[test]
    fn only_a_panic_line_or_an_abort_can_be_a_panic() {
        assert!(may_be_panic(&watch(&["panic boom"]), ExitStatus::Unknown));
        assert!(may_be_panic(&watch(&["signal 6"]), ExitStatus::Unknown));
        assert!(may_be_panic(&watch(&[]), ExitStatus::Code(NTSTATUS_FAST_FAIL)));
        assert!(!may_be_panic(&watch(&["signal 11"]), ExitStatus::Unknown));
        assert!(!may_be_panic(&watch(&[]), ExitStatus::Code(0xC000_0005)));
    }

    #[test]
    fn deliberate_exits_never_count_as_crashes() {
        assert_eq!(classify(&watch(&["exit"]), ExitStatus::Unknown, NOW), Death::Deliberate);
        assert_eq!(classify(&watch(&["signal 11", "exit"]), ExitStatus::Unknown, NOW), Death::Deliberate);
        assert_eq!(classify(&watch(&["term 15"]), ExitStatus::Code(0xC000_0005), NOW), Death::Deliberate);
        assert_eq!(classify(&watch(&["term 15", "signal 11"]), ExitStatus::Unknown, NOW), Death::Deliberate);
        assert_eq!(classify(&watch(&[]), ExitStatus::Code(0), NOW), Death::Killed(Some(0)));
        assert_eq!(classify(&watch(&[]), ExitStatus::Code(2), NOW), Death::Deliberate);
    }

    #[test]
    fn closing_the_console_or_ending_the_session_is_not_a_crash() {
        assert_eq!(classify(&watch(&[]), ExitStatus::Code(0xC000_013A), NOW), Death::Deliberate);
        assert_eq!(classify(&watch(&[]), ExitStatus::Code(0xC000_026B), NOW), Death::Deliberate);
    }

    #[test]
    fn a_stale_term_or_fatal_marker_no_longer_explains_a_death() {
        // A chained SIGTERM handler that did not exit: a crash much later is a crash.
        let late = NOW + TERM_GRACE_MS + 1;
        let termed_then_crashed = watch(&["term 15"]).apply_line("signal 11", late);
        assert_eq!(classify(&termed_then_crashed, ExitStatus::Unknown, late), Death::Crash("Crashed with SIGSEGV".into()));
        // A fault another handler recovered from, then a silent kill much later: a kill.
        let recovered = watch(&["signal 11"]);
        assert_eq!(classify(&recovered, ExitStatus::Unknown, NOW + FATAL_GRACE_MS + 1), Death::Killed(None));
        assert_eq!(classify(&recovered, ExitStatus::Unknown, NOW + FATAL_GRACE_MS), Death::Crash("Crashed with SIGSEGV".into()));
        // A slow core dump keeps the pipe open well past the termination grace.
        assert_eq!(classify(&recovered, ExitStatus::Unknown, NOW + 5 * 60 * 1000), Death::Crash("Crashed with SIGSEGV".into()));
    }

    #[test]
    fn silent_deaths_are_user_kills() {
        assert_eq!(classify(&watch(&[]), ExitStatus::Unknown, NOW), Death::Killed(None));
        assert_eq!(classify(&watch(&[]), ExitStatus::Code(1), NOW), Death::Killed(Some(1)));
    }

    #[test]
    fn panics_signals_and_exceptions_are_crashes() {
        assert_eq!(classify(&watch(&["panic boom", "signal 6"]), ExitStatus::Unknown, NOW), Death::Crash("Panic: boom".into()));
        assert_eq!(classify(&watch(&["signal 6"]), ExitStatus::Unknown, NOW), Death::Crash("Crashed with SIGABRT".into()));
        assert_eq!(
            classify(&watch(&[]), ExitStatus::Code(0xC000_0409), NOW),
            Death::Crash("Crashed with a fatal error (abort)".into())
        );
        assert_eq!(classify(&watch(&[]), ExitStatus::Code(0xC0FF_EE00), NOW), Death::Crash("Crashed with exception 0xC0FFEE00".into()));
    }

    #[test]
    fn the_third_crash_in_ten_minutes_pauses() {
        let minute = 60_000;
        let one = record(&[], CrashRecord { at: minute, startup: false });
        assert_eq!(verdict(&one, minute), Verdict::Restart);
        let two = record(&one, CrashRecord { at: 3 * minute, startup: false });
        assert_eq!(verdict(&two, 3 * minute), Verdict::Restart);
        let three = record(&two, CrashRecord { at: 9 * minute, startup: false });
        assert_eq!(verdict(&three, 9 * minute), Verdict::Pause);
        // The first one aged out of the window.
        let later = record(&two, CrashRecord { at: 12 * minute, startup: false });
        assert_eq!(verdict(&later, 12 * minute), Verdict::Restart);
    }

    #[test]
    fn repeated_startup_crashes_pause_at_once() {
        let first = record(&[], CrashRecord { at: 1_000, startup: true });
        assert_eq!(verdict(&first, 1_000), Verdict::Restart);
        let second = record(&first, CrashRecord { at: 20_000, startup: true });
        assert_eq!(verdict(&second, 20_000), Verdict::Pause);
        // A crash after a good run breaks the startup streak.
        let mixed = record(&record(&[], CrashRecord { at: 1_000, startup: true }), CrashRecord { at: 200_000, startup: false });
        assert_eq!(verdict(&mixed, 200_000), Verdict::Restart);
        assert!(is_startup(1_000, 1_000 + STARTUP_GRACE_MS - 1));
        assert!(!is_startup(1_000, 1_000 + STARTUP_GRACE_MS));
    }

    #[test]
    fn only_closed_set_causes_are_public() {
        assert_eq!(public_cause("Panic: open /Users/alice/notes.txt failed").as_deref(), Some("Panic"));
        assert_eq!(public_cause("Crashed with SIGSEGV").as_deref(), Some("Crashed with SIGSEGV"));
        assert_eq!(public_cause("Crashed with heap corruption").as_deref(), Some("Crashed with heap corruption"));
        for free in ["Crashed with SIGKILL", "Crashed with SIGTERM", "Crashed with SIGINT", "Crashed with SIGHUP", "Crashed with signal 31", "Crashed with exception 0xC0FFEE00", "Crashed with /tmp/x", "/Users/alice", ""] {
            assert_eq!(public_cause(free), None, "{free}");
        }
        // Every death the guard classifies maps into the set or to None, never to free text.
        for signal in 1..=64 {
            let summary = format!("{CRASHED_WITH}{}", signal_name(signal));
            let public = public_cause(&summary);
            assert!(public.is_none() || public.as_deref() == Some(summary.as_str()), "{summary}");
            let named = !signal_name(signal).starts_with("signal ");
            assert_eq!(public.is_some(), named && !TERMINATION_SIGNALS.contains(&signal), "{summary}");
        }
        for (code, name) in EXCEPTIONS {
            assert_eq!(public_cause(&format!("{CRASHED_WITH}{}", exception_name(code))), Some(format!("{CRASHED_WITH}{name}")));
        }
    }

    #[test]
    fn history_is_bounded_and_drops_future_records() {
        let history: Vec<_> = (0..20).map(|i| CrashRecord { at: i, startup: false }).collect();
        let next = record(&history, CrashRecord { at: 100, startup: false });
        assert_eq!(next.len(), HISTORY_LIMIT);
        assert_eq!(next.last().map(|r| r.at), Some(100));
        // A clock set back must not keep stale "future" crashes counting forever.
        let skewed = record(&[CrashRecord { at: 9_999_999, startup: false }], CrashRecord { at: 5, startup: false });
        assert_eq!(skewed.len(), 1);
    }

    #[test]
    fn crashes_older_than_the_window_are_not_kept() {
        let at = |at| CrashRecord { at, startup: false };
        let now = 10 * CRASH_WINDOW_MS;
        let history = [at(1), at(now - CRASH_WINDOW_MS - 1), at(now - CRASH_WINDOW_MS), at(now - 5)];
        assert_eq!(record(&history, at(now)), [at(now - CRASH_WINDOW_MS), at(now - 5), at(now)]);
    }
}
