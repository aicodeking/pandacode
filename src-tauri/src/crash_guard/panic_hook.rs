//! The panic hook: `panic` to the guard, then a local report and `report`, then the previous
//! hook (which prints). With `panic = "abort"` the abort follows and the signal handler adds
//! `signal 6`, which the guard ignores after a panic. On Unix both lines go straight to the
//! pipe's fd, never through the link's lock, which another thread (the periodic check, an
//! agent's `child` line) or the panicking one may hold. On Windows the lines go through the
//! writer thread's queue and can be lost to the abort; the exit code still marks a crash.
//!
//! macOS release builds (`panic = "abort"`): once the previous hook has printed and the guard
//! has confirmed both lines (`panic`, `report`), the process ends with `_exit(101)` instead
//! of the abort, so macOS shows no "quit unexpectedly" dialog beside the relaunched window.
//! The guard classifies the death from the `panic` line and stops agent groups as after any
//! crash. The cost: ReportCrash writes no `.ips` log and no core dump for a panic; our panic
//! report (message, location, backtrace) is the record. When a write failed or no guard runs,
//! the normal abort follows. Unwinding builds (tests, dev) never take this path.

use super::protocol::Message;
use super::{guard, link, report};
use std::sync::atomic::{AtomicBool, Ordering};

static IN_PANIC_HOOK: AtomicBool = AtomicBool::new(false);

/// Rust's exit status for a panic that ends the process.
#[cfg(all(target_os = "macos", panic = "abort"))]
const PANIC_EXIT_CODE: i32 = 101;

pub fn install() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let mut announced = false;
        // A panic inside this hook (or on another thread meanwhile) goes straight to the previous one.
        if !IN_PANIC_HOOK.swap(true, Ordering::SeqCst) {
            announced = record(info);
            IN_PANIC_HOOK.store(false, Ordering::SeqCst);
        }
        previous(info);
        if exit_quietly(cfg!(all(target_os = "macos", panic = "abort")), announced) {
            end_quietly();
        }
    }));
}

/// Whether to `_exit` instead of aborting: only in a macOS abort build, and only when the
/// guard got both the `panic` and the `report` line (so it knows, and the report exists).
fn exit_quietly(macos_abort_build: bool, announced: bool) -> bool {
    macos_abort_build && announced
}

#[cfg(all(target_os = "macos", panic = "abort"))]
fn end_quietly() {
    // SAFETY: _exit(2) ends the process at once; nothing after it runs.
    unsafe { libc::_exit(PANIC_EXIT_CODE) }
}

#[cfg(not(all(target_os = "macos", panic = "abort")))]
fn end_quietly() {}

/// True when the guard got both lines: `panic` and, after the report was written, `report`.
fn record(info: &std::panic::PanicHookInfo) -> bool {
    let message = info
        .payload()
        .downcast_ref::<&str>()
        .map(|s| s.to_string())
        .or_else(|| info.payload().downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "Box<dyn Any>".into());
    // First, before the slow backtrace: the guard must learn of the panic even if capturing
    // the backtrace or writing the report goes wrong.
    let panic_sent = send(&Message::Panic(message.clone()));
    let thread = std::thread::current();
    let backtrace = std::backtrace::Backtrace::force_capture().to_string();
    let panic = report::Panic {
        pid: std::process::id(),
        message: &message,
        location: info.location().map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column())),
        thread: thread.name().unwrap_or("unnamed"),
        backtrace: &backtrace,
    };
    let Some(dir) = link::data_dir() else { return false };
    let now = guard::now_ms();
    match report::write(dir, report::Kind::Panic, now, &report::panic_text(&panic, now)) {
        Ok(_) => send(&Message::Report) && panic_sent,
        Err(error) => {
            eprintln!("Could not write a crash report: {error}");
            false
        }
    }
}

/// True when the line reached the guard's pipe.
#[cfg(unix)]
fn send(message: &Message) -> bool {
    super::signals::write_raw(message.encode().as_bytes())
}

#[cfg(not(unix))]
fn send(message: &Message) -> bool {
    link::try_send(message) == link::Sent::Delivered
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_macos_abort_build_with_both_lines_delivered_exits_quietly() {
        assert!(exit_quietly(true, true));
        assert!(!exit_quietly(true, false), "a lost line falls through to the abort");
        assert!(!exit_quietly(false, true), "unwinding or non-macOS builds never _exit");
        // This test binary unwinds: the hook it installs never ends the process.
        const { assert!(!cfg!(panic = "abort")) };
    }
}
