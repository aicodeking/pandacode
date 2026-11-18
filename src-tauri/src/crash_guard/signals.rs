//! Unix signal handlers that tell the guard how the app is dying, since a non-parent cannot
//! learn the exit status. Each handler only formats into a stack buffer, calls write(2) on the
//! pipe and sigaction(2)/raise(3), all async-signal-safe. Fatal signals report `signal N`,
//! termination signals `term N` (deliberate).
//!
//! A fatal signal always ends the process: the handler sets the signal back to SIG_DFL (not
//! the action installed before ours) and re-raises. The signal is blocked while we run, so it
//! is delivered as soon as we return and kills with the right signal (core/crash log as
//! usual); a real fault would also recur into SIG_DFL. The previous action is deliberately
//! not chained: Rust std's stack-overflow handler (SIGSEGV/SIGBUS) treats a signal without a
//! guard-page address (one sent with `kill`, or our own re-raise) as not its own, resets to
//! SIG_DFL and returns, so a SIGSEGV sent with `kill` was swallowed and the app went on while
//! the guard held `signal N`. Its "thread overflowed its stack" line is not printed this way.
//! Termination signals still hand over to the previous action (tokio's in `serve`).
#![cfg(unix)]

use std::cell::UnsafeCell;
use std::mem::MaybeUninit;
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};

const FATAL: [libc::c_int; 7] = [libc::SIGSEGV, libc::SIGBUS, libc::SIGILL, libc::SIGFPE, libc::SIGABRT, libc::SIGTRAP, libc::SIGSYS];
/// Deliberate: a kill, Ctrl-C, a closed terminal, or Ctrl-\ (SIGQUIT asks to quit with a core
/// dump; the user sends it, no fault caused it), so none of them is relaunched.
const TERMINATE: [libc::c_int; 4] = [libc::SIGTERM, libc::SIGINT, libc::SIGHUP, libc::SIGQUIT];
/// Above every signal number used here on macOS and Linux.
const SLOTS: usize = 32;

/// The pipe's write end, or -1.
static FD: AtomicI32 = AtomicI32::new(-1);
static INSTALLED: AtomicBool = AtomicBool::new(false);
/// The termination signal received (0: none), so a respawned guard learns of it too.
static TERMINATED: AtomicI32 = AtomicI32::new(0);

/// Actions in place before ours, written once before the handlers go in, then only read.
struct Previous(UnsafeCell<[MaybeUninit<libc::sigaction>; SLOTS]>);
// SAFETY: written only in `install` before any handler can run (guarded by INSTALLED), read-only after.
unsafe impl Sync for Previous {}
static PREVIOUS: Previous = Previous(UnsafeCell::new([const { MaybeUninit::uninit() }; SLOTS]));

/// Sets the pipe fd the handlers write to (-1 to stop).
pub fn set_fd(fd: i32) {
    FD.store(fd, Ordering::SeqCst);
}

/// Installs the handlers once per process. Failures leave that signal's default in place.
pub fn install() {
    if INSTALLED.swap(true, Ordering::SeqCst) {
        return;
    }
    for signal in FATAL.into_iter().chain(TERMINATE) {
        // SAFETY: `signal` < SLOTS; the slot is written before the handler that reads it exists.
        unsafe {
            let slot = (*PREVIOUS.0.get())[signal as usize].as_mut_ptr();
            if libc::sigaction(signal, std::ptr::null(), slot) != 0 || !take_over(FATAL.contains(&signal), (*slot).sa_sigaction) {
                continue;
            }
            let mut action: libc::sigaction = std::mem::zeroed();
            action.sa_sigaction = handler_address();
            action.sa_flags = libc::SA_SIGINFO | libc::SA_ONSTACK;
            libc::sigemptyset(&mut action.sa_mask);
            if libc::sigaction(signal, &action, std::ptr::null_mut()) != 0 {
                eprintln!("Crash guard could not watch signal {signal}: {}", std::io::Error::last_os_error());
            }
        }
    }
}

/// Whether to put our handler on a signal whose current action is `current`. A termination
/// signal set to SIG_IGN (nohup's SIGHUP, a shell's SIGINT/SIGQUIT for background jobs) is
/// left alone: taking it over would turn an ignored signal into a `term` and a death.
fn take_over(fatal: bool, current: libc::sighandler_t) -> bool {
    fatal || current != libc::SIG_IGN
}

/// The termination signal this process received, if any.
pub fn terminated() -> Option<i32> {
    Some(TERMINATED.load(Ordering::SeqCst)).filter(|signal| *signal != 0)
}

extern "C" fn on_signal(signal: libc::c_int, _info: *mut libc::siginfo_t, _context: *mut libc::c_void) {
    // A termination signal can return into the interrupted thread (tokio's handler in `serve`
    // does the shutdown): a failed write(2) here must not change the errno that thread reads.
    keeping_errno(|| announce(signal));
}

/// The address of this thread's `errno` (async-signal-safe: it only returns an address);
/// null where this code does not know its name.
#[cfg(any(target_os = "macos", target_os = "ios", target_os = "freebsd"))]
fn errno_location() -> *mut libc::c_int {
    // SAFETY: no arguments, no preconditions.
    unsafe { libc::__error() }
}

#[cfg(any(target_os = "linux", target_os = "emscripten"))]
fn errno_location() -> *mut libc::c_int {
    // SAFETY: no arguments, no preconditions.
    unsafe { libc::__errno_location() }
}

#[cfg(any(target_os = "android", target_os = "netbsd", target_os = "openbsd"))]
fn errno_location() -> *mut libc::c_int {
    // SAFETY: no arguments, no preconditions.
    unsafe { libc::__errno() }
}

#[cfg(not(any(
    target_os = "macos",
    target_os = "ios",
    target_os = "freebsd",
    target_os = "linux",
    target_os = "emscripten",
    target_os = "android",
    target_os = "netbsd",
    target_os = "openbsd"
)))]
fn errno_location() -> *mut libc::c_int {
    std::ptr::null_mut()
}

/// Runs `f` and puts `errno` back to what it was. Only reads and writes one thread-local
/// integer, so it is async-signal-safe.
fn keeping_errno(f: impl FnOnce()) {
    let location = errno_location();
    if location.is_null() {
        return f();
    }
    // SAFETY: `location` is this thread's errno, valid for the thread's life.
    let saved = unsafe { *location };
    f();
    // SAFETY: as above.
    unsafe { *location = saved };
}

fn announce(signal: libc::c_int) {
    let fatal = FATAL.contains(&signal);
    if !fatal {
        TERMINATED.store(signal, Ordering::SeqCst);
    }
    write_line(if fatal { b"signal " } else { b"term " }, signal);
    // SAFETY: only async-signal-safe calls; the slot was filled in `install`.
    unsafe {
        if fatal {
            // Announced as a crash: the process must die of it, whatever was installed before.
            let mut default: libc::sigaction = std::mem::zeroed();
            default.sa_sigaction = libc::SIG_DFL;
            libc::sigaction(signal, &default, std::ptr::null_mut());
        } else if still_ours(signal) {
            libc::sigaction(signal, (*PREVIOUS.0.get())[signal as usize].as_ptr(), std::ptr::null_mut());
        } else {
            // A later handler (tokio in `serve`) chained to us: it does the shutdown.
            return;
        }
        // Delivered once this returns (it is blocked while we run); a fault would also recur.
        libc::raise(signal);
    }
}

fn handler_address() -> libc::sighandler_t {
    on_signal as *const () as libc::sighandler_t
}

/// True when the installed action is still this handler, not one that chains to it.
unsafe fn still_ours(signal: libc::c_int) -> bool {
    let mut current: libc::sigaction = std::mem::zeroed();
    libc::sigaction(signal, std::ptr::null(), &mut current) == 0 && current.sa_sigaction == handler_address()
}

/// `<prefix><n>\n` in one write, so it never interleaves with other pipe lines.
fn write_line(prefix: &[u8], signal: libc::c_int) {
    let fd = FD.load(Ordering::SeqCst);
    if fd < 0 {
        return;
    }
    let mut buffer = [0u8; 24];
    let mut len = prefix.len().min(12);
    buffer[..len].copy_from_slice(&prefix[..len]);
    len += format_number(signal.unsigned_abs(), &mut buffer[len..23]);
    buffer[len] = b'\n';
    // SAFETY: write(2) on a valid buffer; a failure (guard gone) is ignored.
    unsafe {
        libc::write(fd, buffer.as_ptr().cast(), len + 1);
    }
}

/// One whole line straight to the pipe, without the link's lock (the panic hook: the lock
/// may be held by the thread that panicked or by another). Lines under PIPE_BUF arrive whole
/// or not at all on the non-blocking pipe. False when nothing was written.
pub fn write_raw(line: &[u8]) -> bool {
    let fd = FD.load(Ordering::SeqCst);
    // SAFETY: write(2) of a valid buffer; a failure (guard gone, pipe full) is reported.
    fd >= 0 && unsafe { libc::write(fd, line.as_ptr().cast(), line.len()) } == line.len() as isize
}

/// Decimal digits of `n` into `out`, returning the count; no allocation.
fn format_number(mut n: u32, out: &mut [u8]) -> usize {
    let mut digits = [0u8; 10];
    let mut count = 0;
    loop {
        digits[count] = b'0' + (n % 10) as u8;
        count += 1;
        n /= 10;
        if n == 0 || count == digits.len() {
            break;
        }
    }
    let count = count.min(out.len());
    for (i, digit) in digits[..count].iter().rev().enumerate() {
        out[i] = *digit;
    }
    count
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ignored_termination_signals_are_never_taken_over() {
        assert!(!take_over(false, libc::SIG_IGN));
        assert!(take_over(false, libc::SIG_DFL));
        assert!(take_over(true, libc::SIG_IGN));
        assert!(take_over(true, libc::SIG_DFL));
    }

    #[test]
    fn errno_is_as_it_was_after_a_failed_write() {
        let location = errno_location();
        assert!(!location.is_null(), "no errno location on this platform");
        // SAFETY: this thread's errno.
        unsafe { *location = libc::EDOM };
        let mut failed_with = 0;
        keeping_errno(|| {
            // SAFETY: write(2) to a descriptor that is never open; it fails with EBADF.
            assert_eq!(unsafe { libc::write(-1, b"term 15\n".as_ptr().cast(), 8) }, -1);
            // SAFETY: this thread's errno.
            failed_with = unsafe { *location };
        });
        assert_eq!(failed_with, libc::EBADF);
        // SAFETY: this thread's errno.
        assert_eq!(unsafe { *location }, libc::EDOM);
    }

    #[test]
    fn numbers_format_without_allocating() {
        let digits = |n: u32| {
            let mut out = [0u8; 10];
            let len = format_number(n, &mut out);
            out[..len].to_vec()
        };
        assert_eq!(digits(0), b"0");
        assert_eq!(digits(11), b"11");
        assert_eq!(digits(u32::MAX), b"4294967295");
    }
}
