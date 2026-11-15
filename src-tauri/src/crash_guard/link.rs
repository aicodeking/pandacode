//! The app's end: spawns the guard with a pipe on its stdin and writes protocol lines to it.
//! The pipe is the guard's only tie to the app: when every copy of the write end closes
//! (the app is gone, however it went) the guard reads EOF.
//!
//! A guard that dies (or whose first spawn failed) is noticed on the next failed send or by a
//! periodic check of the child, and respawned (at most `MAX_RESPAWNS` times) with the live
//! setting and agent groups.
//!
//! Agent groups and the setting survive dropped lines: a line lost to a full pipe marks the
//! link dirty, and the next send (or the periodic check) first resends the whole state
//! (`reset`, one `child` line per group, `arm`/`disarm`, focus, `exit` once announced), so a lost `unchild` never
//! leaves the guard a stale group to kill and a lost `disarm` never relaunches. `child`/`unchild` lines are
//! sent while the map they describe is locked, so the guard sees changes in map order.

use super::guard::{self, Config};
use super::protocol::Message;
use super::relaunch::{self, Mode};
use super::writer::{SendError, Writer};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Child;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU8, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

/// Respawns allowed per app run; a guard that keeps dying is given up on (and logged).
pub const MAX_RESPAWNS: u32 = 3;
/// How often the app checks that its guard still runs (a cheap `try_wait`).
const CHECK_INTERVAL: Duration = Duration::from_secs(15);

/// What every guard of this run is spawned with.
struct Setup {
    mode: Mode,
    dir: PathBuf,
    target: PathBuf,
    wrapper: Option<PathBuf>,
    launched_at: u64,
    args: Vec<String>,
}

struct Link {
    writer: Writer,
    child: Child,
}

static SETUP: OnceLock<Setup> = OnceLock::new();
static LINK: Mutex<Option<Link>> = Mutex::new(None);
/// Agent process groups (leader pid → start time) a respawned or resynced guard must learn
/// again. Lock order: LINK, then CHILDREN (only ever locked while LINK is held).
static CHILDREN: Mutex<BTreeMap<u32, u64>> = Mutex::new(BTreeMap::new());
/// A line was dropped: the guard's agent groups may be stale until the next resync.
static DIRTY: AtomicBool = AtomicBool::new(false);
/// A deliberate exit was announced: never respawn after it.
static EXITING: AtomicBool = AtomicBool::new(false);
static RESPAWNS: AtomicU32 = AtomicU32::new(0);
/// A respawn failed to start a guard: `check` tries again (within `MAX_RESPAWNS`).
static NEEDS_RESPAWN: AtomicBool = AtomicBool::new(false);
/// `agents_interrupted` was called and the notice it belongs to is not shown yet: every resync
/// sends `interrupted` again (`clear_interrupted` stops it).
static INTERRUPTED: AtomicBool = AtomicBool::new(false);
/// Whether a PandaCode window has focus: `FOCUS_UNKNOWN`, `FOCUS_FRONT` or `FOCUS_BACK`.
static FOCUS: AtomicU8 = AtomicU8::new(FOCUS_UNKNOWN);
const FOCUS_UNKNOWN: u8 = 0;
const FOCUS_FRONT: u8 = 1;
const FOCUS_BACK: u8 = 2;

/// Result of one send, for callers that report failures.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sent {
    /// No guard in this run (off by env, debug build, failed to start): nothing to tell.
    NoGuard,
    Delivered,
    Failed(SendError),
}

pub fn data_dir() -> Option<&'static Path> {
    SETUP.get().map(|setup| setup.dir.as_path())
}

pub fn connected() -> bool {
    lock().is_some()
}

fn lock() -> std::sync::MutexGuard<'static, Option<Link>> {
    LINK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// What `connect` left in place.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Connected {
    /// This run is set up for a guard (`data_dir` answers): reports, the panic hook and
    /// `crash_recovery_take` work, even if spawning the guard failed.
    pub setup: bool,
    /// The periodic check thread runs (it also does the daily prune).
    pub checked: bool,
}

/// Spawns the guard; reports and the panic hook work even if spawning fails, and a failed
/// spawn is retried by the periodic check (`first_link`).
pub fn connect(mode: Mode, dir: PathBuf, armed: bool, wrapper: Option<PathBuf>) -> Connected {
    let target = match relaunch::launch_target() {
        Ok(target) => target,
        Err(error) => {
            eprintln!("Crash guard did not start: {error}");
            return Connected { setup: false, checked: false };
        }
    };
    let args = std::env::args().skip(1).filter(|arg| !relaunch::is_restart_flag(arg)).collect();
    let setup = Setup { mode, dir, target, wrapper, launched_at: guard::now_ms(), args };
    if SETUP.set(setup).is_err() {
        return Connected { setup: true, checked: false };
    }
    super::panic_hook::install();
    first_link(&mut lock(), spawn_link(armed));
    let monitor = std::thread::Builder::new().name("crash-guard-check".into()).spawn(|| {
        while !EXITING.load(Ordering::SeqCst) {
            std::thread::sleep(CHECK_INTERVAL);
            check();
            if let Some(dir) = data_dir() {
                super::prune_if_due(dir);
            }
        }
    });
    if let Err(error) = &monitor {
        eprintln!("Crash guard check did not start: {error}");
    }
    Connected { setup: true, checked: monitor.is_ok() }
}

/// The first guard of this run, or (spawn failed, often a transient EAGAIN/EMFILE) a retry
/// left to `check`, within `MAX_RESPAWNS`, with the full resync once one starts.
fn first_link(slot: &mut Option<Link>, spawned: std::io::Result<Link>) {
    match spawned {
        Ok(link) => *slot = Some(link),
        Err(error) => {
            NEEDS_RESPAWN.store(true, Ordering::SeqCst);
            eprintln!("Crash guard did not start ({error}); it is tried again shortly.");
        }
    }
}

fn spawn_link(armed: bool) -> std::io::Result<Link> {
    let setup = SETUP.get().ok_or_else(|| std::io::Error::other("the crash guard is not set up"))?;
    let config = Config {
        pid: std::process::id(),
        data_dir: setup.dir.clone(),
        target: setup.target.clone(),
        mode: setup.mode,
        launched_at: setup.launched_at,
        armed,
        wrapper: setup.wrapper.clone(),
        args: setup.args.clone(),
    };
    let mut child = super::spawn::spawn(super::spawn::guard_command(&config)?)?;
    let stdin = child.stdin.take().ok_or_else(|| std::io::Error::other("the guard has no stdin"))?;
    let writer = Writer::new(stdin);
    #[cfg(unix)]
    {
        super::signals::set_fd(writer.fd());
        super::signals::install();
    }
    Ok(Link { writer, child })
}

/// Sends one line, respawning a dead guard once per call. Never blocks on a full pipe.
pub fn send(message: &Message) -> Sent {
    deliver(&mut lock(), message)
}

/// For the panic hook on Windows (Unix writes to the fd directly): skips (rather than
/// deadlocks) when this thread already holds the link.
#[cfg(not(unix))]
pub fn try_send(message: &Message) -> Sent {
    match LINK.try_lock() {
        Ok(mut link) => deliver(&mut link, message),
        Err(_) => Sent::Failed(SendError::Full),
    }
}

fn deliver(slot: &mut Option<Link>, message: &Message) -> Sent {
    let sent = deliver_now(slot, message);
    // After `exit` a guard on Windows leaves at once (`guard::LEAVE_AT_EXIT`), and one on Unix
    // may be gone too (killed at logout): a later line (an agent's `unchild` during shutdown)
    // finding it gone is expected, not a failure to report.
    if EXITING.load(Ordering::SeqCst) && matches!(sent, Sent::Failed(_)) {
        return Sent::NoGuard;
    }
    sent
}

fn deliver_now(slot: &mut Option<Link>, message: &Message) -> Sent {
    let line = message.encode();
    let Some(link) = slot.as_mut() else {
        // A guard waiting to be respawned is a failure. Never having had one is not, and
        // neither is one given up on: that was logged once, and the app runs without it.
        return if NEEDS_RESPAWN.load(Ordering::SeqCst) { Sent::Failed(SendError::Broken) } else { Sent::NoGuard };
    };
    match send_line(&mut link.writer, line.as_bytes()) {
        Ok(()) => Sent::Delivered,
        Err(SendError::Full) => Sent::Failed(SendError::Full),
        Err(SendError::Broken) => {
            respawn(slot);
            // The setting and groups were replayed; deliver this line (idempotent) too.
            match slot.as_mut().map(|link| send_line(&mut link.writer, line.as_bytes())) {
                Some(Ok(())) => Sent::Delivered,
                Some(Err(error)) => Sent::Failed(error),
                None => Sent::Failed(SendError::Broken),
            }
        }
    }
}

/// One line, after a resync when an earlier line was dropped. Caller holds LINK.
fn send_line(writer: &mut Writer, line: &[u8]) -> Result<(), SendError> {
    if DIRTY.load(Ordering::SeqCst) {
        resync(writer)?;
    }
    writer.send(line).inspect_err(|error| {
        if *error == SendError::Full {
            DIRTY.store(true, Ordering::SeqCst);
        }
    })
}

/// `reset`, every current `child` line, the live restart setting, the focus state, `interrupted`
/// once agents were stopped, the held notice (`held`, or `shown`) and, once
/// a deliberate exit was announced, `exit` (a dropped one is resent); the link stays dirty
/// unless all of them went. Caller holds LINK. Each line is short (under
/// PIPE_BUF), so none arrives cut.
fn resync(writer: &mut Writer) -> Result<(), SendError> {
    let interrupted = INTERRUPTED.load(Ordering::SeqCst).then_some(Message::Interrupted);
    let children = CHILDREN.lock().unwrap_or_else(|p| p.into_inner());
    let armed = if super::ENABLED.load(Ordering::SeqCst) { Message::Arm } else { Message::Disarm };
    let focus = focus_line(FOCUS.load(Ordering::SeqCst));
    let exit = EXITING.load(Ordering::SeqCst).then_some(Message::Exit);
    let held = super::commands::held_line();
    let lines = std::iter::once(Message::Reset).chain(children.iter().map(|(pid, start)| Message::Child(*pid, *start))).chain([armed]).chain(focus).chain(interrupted).chain([held]).chain(exit);
    let result = lines.map(|message| writer.send(message.encode().as_bytes())).find(Result::is_err).unwrap_or(Ok(()));
    DIRTY.store(result.is_err(), Ordering::SeqCst);
    result
}

/// The periodic check: a guard that exited (and was not told to) is respawned, and so is one
/// whose respawn failed earlier. A dropped line (an `arm`/`disarm` that nothing follows) is
/// repaired here too, rather than wait for the next line the app happens to send.
pub fn check() {
    let mut slot = lock();
    let exited = slot.as_mut().is_some_and(|link| matches!(link.child.try_wait(), Ok(Some(_))));
    let retry = slot.is_none() && NEEDS_RESPAWN.load(Ordering::SeqCst);
    if exited || retry {
        return respawn(&mut slot);
    }
    if let Some(link) = slot.as_mut().filter(|_| DIRTY.load(Ordering::SeqCst)) {
        if resync(&mut link.writer) == Err(SendError::Broken) {
            respawn(&mut slot);
        }
    }
}

/// How often, and how many times, `repair_soon` retries before leaving it to `check`.
const REPAIR_EVERY: Duration = Duration::from_millis(250);
const REPAIR_TRIES: u32 = 20;

/// A line that must not wait for the periodic check was not delivered: runs `check` at once,
/// then every `REPAIR_EVERY` (a full pipe drains, a respawn is retried) until the guard has
/// the whole state or `REPAIR_TRIES` ran out (the 15 s check takes over).
pub fn repair_soon() {
    let repair = std::thread::Builder::new().name("crash-guard-repair".into()).spawn(|| {
        for _ in 0..REPAIR_TRIES {
            check();
            if repaired() {
                return;
            }
            std::thread::sleep(REPAIR_EVERY);
        }
    });
    if let Err(error) = repair {
        eprintln!("Crash guard state is resent with the next check: {error}");
        check();
    }
}

/// The guard (if any) has the whole state, or there is nothing more to try.
fn repaired() -> bool {
    !DIRTY.load(Ordering::SeqCst) && !NEEDS_RESPAWN.load(Ordering::SeqCst)
}

/// Replaces a dead guard (or retries a failed respawn). The old write end is leaked, not
/// closed: a signal handler that read its fd number a moment ago must not write into
/// whatever file reuses that number.
fn respawn(slot: &mut Option<Link>) {
    if let Some(Link { writer, mut child }) = slot.take() {
        let _ = child.try_wait();
        std::mem::forget(writer);
    }
    if EXITING.load(Ordering::SeqCst) {
        return NEEDS_RESPAWN.store(false, Ordering::SeqCst);
    }
    // Logged once: with no link and nothing pending, nothing calls this again.
    if RESPAWNS.fetch_add(1, Ordering::SeqCst) >= MAX_RESPAWNS {
        NEEDS_RESPAWN.store(false, Ordering::SeqCst);
        return eprintln!("Crash guard keeps stopping; PandaCode runs without it until restarted.");
    }
    match spawn_link(super::ENABLED.load(Ordering::SeqCst)) {
        Ok(mut link) => {
            replay(&mut link);
            *slot = Some(link);
            NEEDS_RESPAWN.store(false, Ordering::SeqCst);
        }
        Err(error) => {
            NEEDS_RESPAWN.store(true, Ordering::SeqCst);
            eprintln!("Crash guard could not be restarted: {error}");
        }
    }
}

fn replay(link: &mut Link) {
    if let Err(error) = resync(&mut link.writer) {
        eprintln!("Crash guard missed the replayed agent groups ({error:?}); they are resent with the next line.");
    }
    #[cfg(unix)]
    if let Some(signal) = super::signals::terminated() {
        if let Err(error) = link.writer.send(Message::Term(signal).encode().as_bytes()) {
            eprintln!("Crash guard missed a replayed line: {error:?}");
        }
    }
}

/// A deliberate exit follows: the guard relaunches nothing after it (and on Windows leaves at
/// once), and is not respawned.
pub fn announce_exit() {
    EXITING.store(true, Ordering::SeqCst);
    send(&Message::Exit);
}

/// A PandaCode window gained or lost focus; only a change is sent. A dropped line is resent
/// with the next resync.
pub fn focus_changed(focused: bool) {
    let state = if focused { FOCUS_FRONT } else { FOCUS_BACK };
    if FOCUS.swap(state, Ordering::SeqCst) != state {
        send(&Message::Focus(focused));
    }
}

fn focus_line(state: u8) -> Option<Message> {
    match state {
        FOCUS_FRONT => Some(Message::Focus(true)),
        FOCUS_BACK => Some(Message::Focus(false)),
        _ => None,
    }
}

/// Agents were stopped (`Message::Interrupted`) by the crash whose notice is held unshown; kept
/// for every resync, so a respawned guard knows it too.
pub fn agents_interrupted() -> Sent {
    INTERRUPTED.store(true, Ordering::SeqCst);
    send(&Message::Interrupted)
}

/// The held notice was shown: resyncs stop sending `interrupted`. The guard clears its own
/// copy on the `shown` line that follows.
pub fn clear_interrupted() {
    INTERRUPTED.store(false, Ordering::SeqCst);
}

pub fn child_started(pid: u32) -> Sent {
    let start = super::process::start_time(pid).unwrap_or(0);
    change_children(|children| {
        children.insert(pid, start);
    }, &Message::Child(pid, start))
}

pub fn child_ended(pid: u32) -> Sent {
    change_children(|children| {
        children.remove(&pid);
    }, &Message::Unchild(pid))
}

/// Changes the map and sends the matching line under LINK, so no other change or resync
/// slips between them.
fn change_children(change: impl FnOnce(&mut BTreeMap<u32, u64>), message: &Message) -> Sent {
    let mut slot = lock();
    change(&mut CHILDREN.lock().unwrap_or_else(|p| p.into_inner()));
    deliver(&mut slot, message)
}

/// Tests: runs `f` while holding the link, as the periodic check or a `child` line would.
#[cfg(all(test, unix))]
pub fn with_link_locked<R>(f: impl FnOnce() -> R) -> R {
    let _link = lock();
    f()
}

#[cfg(all(test, unix))]
pub fn guard_fd() -> Option<i32> {
    lock().as_ref().map(|link| link.writer.fd())
}

#[cfg(all(test, unix))]
pub fn guard_pid() -> Option<u32> {
    lock().as_ref().map(|link| link.child.id())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::io::Read;
    use std::process::{Command, Stdio};

    /// Tests that change RESPAWNS, NEEDS_RESPAWN or EXITING: one of them drops LINK between steps.
    static RESPAWN_STATE: Mutex<()> = Mutex::new(());

    /// A reader that ignores the pipe (it fills) until `go` exists, then reads it all.
    fn slow_reader(go: &std::path::Path) -> (std::process::Child, Writer) {
        let script = format!("while [ ! -e '{}' ]; do sleep 0.05; done; cat", go.display());
        let mut child = Command::new("/bin/sh").args(["-c", &script]).stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
        let writer = Writer::new(child.stdin.take().unwrap());
        (child, writer)
    }

    #[test]
    fn a_failed_respawn_is_retried_by_the_check_then_given_up_quietly() {
        let _serial = RESPAWN_STATE.lock().unwrap_or_else(|p| p.into_inner());
        // Holding LINK keeps every other send out. No `connect` in this process, so no SETUP:
        // each spawn fails, as a transient spawn error would.
        let mut slot = lock();
        assert!(slot.is_none() && SETUP.get().is_none());
        RESPAWNS.store(0, Ordering::SeqCst);
        NEEDS_RESPAWN.store(false, Ordering::SeqCst);
        respawn(&mut slot);
        assert!(NEEDS_RESPAWN.load(Ordering::SeqCst), "a failed respawn must stay pending");
        assert_eq!(deliver(&mut slot, &Message::Ping), Sent::Failed(SendError::Broken));
        drop(slot);
        // `check` keeps retrying while respawns are left...
        for tries in 2..=MAX_RESPAWNS {
            check();
            assert_eq!((RESPAWNS.load(Ordering::SeqCst), NEEDS_RESPAWN.load(Ordering::SeqCst)), (tries, true));
        }
        // ...then gives up once: no more attempts, and sends no longer report a failure.
        check();
        assert!(!NEEDS_RESPAWN.load(Ordering::SeqCst));
        let given_up = RESPAWNS.load(Ordering::SeqCst);
        check();
        assert_eq!(RESPAWNS.load(Ordering::SeqCst), given_up);
        let mut slot = lock();
        assert_eq!(deliver(&mut slot, &Message::Ping), Sent::NoGuard);
        RESPAWNS.store(0, Ordering::SeqCst);
    }

    #[test]
    fn a_failed_first_spawn_leaves_a_retry_for_the_check() {
        let _serial = RESPAWN_STATE.lock().unwrap_or_else(|p| p.into_inner());
        let mut slot = lock();
        assert!(slot.is_none() && SETUP.get().is_none());
        RESPAWNS.store(0, Ordering::SeqCst);
        NEEDS_RESPAWN.store(false, Ordering::SeqCst);
        first_link(&mut slot, Err(std::io::Error::from_raw_os_error(libc::EAGAIN)));
        assert!(slot.is_none() && NEEDS_RESPAWN.load(Ordering::SeqCst), "the first failure is retried");
        assert!(!repaired());
        assert_eq!(deliver(&mut slot, &Message::Ping), Sent::Failed(SendError::Broken));
        drop(slot);
        // The check retries (here it fails again: no SETUP), counting against MAX_RESPAWNS.
        check();
        assert_eq!((RESPAWNS.load(Ordering::SeqCst), NEEDS_RESPAWN.load(Ordering::SeqCst)), (1, true));
        NEEDS_RESPAWN.store(false, Ordering::SeqCst);
        RESPAWNS.store(0, Ordering::SeqCst);
    }

    #[test]
    fn a_lost_shown_is_resent_at_once_not_at_the_next_periodic_check() {
        let _serial = RESPAWN_STATE.lock().unwrap_or_else(|p| p.into_inner());
        let go = std::env::temp_dir().join(format!("pandacode-link-shown-{}", uuid::Uuid::new_v4()));
        let (reader, mut writer) = slow_reader(&go);
        let held = super::super::state::Pending { crashed_at: 3, summary: None, has_report: false, restarts_paused: false, restarted: true, report: None, relaunching: false, agents_interrupted: false, not_restarted: None };
        {
            let mut slot = lock();
            DIRTY.store(false, Ordering::SeqCst);
            writer.send(Message::Held(held).encode().as_bytes()).unwrap();
            while send_line(&mut writer, b"ping\n").is_ok() {}
            // The pipe is full: the `shown` line is lost (this process's HOLDER holds nothing).
            assert_eq!(send_line(&mut writer, b"shown\n"), Err(SendError::Full));
            *slot = Some(Link { writer, child: reader });
        }
        repair_soon();
        std::fs::write(&go, "").unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(4);
        while !repaired() {
            assert!(std::time::Instant::now() < deadline, "not repaired well before the 15 s check");
            std::thread::sleep(Duration::from_millis(20));
        }
        let Link { writer, mut child } = lock().take().unwrap();
        drop(writer);
        let mut text = String::new();
        child.stdout.take().unwrap().read_to_string(&mut text).unwrap();
        child.wait().unwrap();
        let watch = text.lines().fold(super::super::protocol::Watch::new(true), |w, line| w.apply_line(line, 1));
        assert_eq!(watch.held, None, "the guard has the resent `shown`");
        std::fs::remove_file(go).unwrap();
    }

    #[test]
    fn a_line_after_exit_finds_the_guard_gone_quietly() {
        let _serial = RESPAWN_STATE.lock().unwrap_or_else(|p| p.into_inner());
        // Holding LINK keeps every other send out while EXITING is set.
        let mut slot = lock();
        let mut child = Command::new("/bin/sh").args(["-c", "exit 0"]).stdin(Stdio::piped()).spawn().unwrap();
        let writer = Writer::new(child.stdin.take().unwrap());
        child.wait().unwrap();
        *slot = Some(Link { writer, child });
        let respawns = RESPAWNS.load(Ordering::SeqCst);
        EXITING.store(true, Ordering::SeqCst);
        let sent = deliver(&mut slot, &Message::Unchild(5));
        EXITING.store(false, Ordering::SeqCst);
        assert_eq!(sent, Sent::NoGuard);
        assert!(slot.is_none() && !NEEDS_RESPAWN.load(Ordering::SeqCst));
        assert_eq!(RESPAWNS.load(Ordering::SeqCst), respawns, "no respawn after exit");
    }

    #[test]
    fn a_dropped_unchild_is_repaired_by_a_full_resync() {
        let go = std::env::temp_dir().join(format!("pandacode-link-go-{}", uuid::Uuid::new_v4()));
        let (mut reader, mut writer) = slow_reader(&go);
        // Other tests register agent groups through `child_started`, which waits for LINK.
        let _link = lock();
        DIRTY.store(false, Ordering::SeqCst);
        CHILDREN.lock().unwrap().extend([(7, 70), (8, 80)]);
        for line in ["child 7 70\n", "child 8 80\n"] {
            send_line(&mut writer, line.as_bytes()).unwrap();
        }
        while send_line(&mut writer, b"ping\n").is_ok() {}
        assert!(DIRTY.load(Ordering::SeqCst));
        // The pipe is full: this unchild is lost, the guard would keep group 7.
        CHILDREN.lock().unwrap().remove(&7);
        assert_eq!(send_line(&mut writer, b"unchild 7\n"), Err(SendError::Full));
        // A `blur` and a `disarm` lost the same way.
        FOCUS.store(FOCUS_BACK, Ordering::SeqCst);
        super::super::ENABLED.store(false, Ordering::SeqCst);
        std::fs::write(&go, "").unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while send_line(&mut writer, b"ping\n").is_err() {
            assert!(std::time::Instant::now() < deadline, "the reader never drained");
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(!DIRTY.load(Ordering::SeqCst));
        drop(writer);
        let mut text = String::new();
        reader.stdout.take().unwrap().read_to_string(&mut text).unwrap();
        reader.wait().unwrap();
        let watch = text.lines().fold(super::super::protocol::Watch::new(true), |w, line| w.apply_line(line, 1));
        assert_eq!((watch.children.get(&7), watch.children.get(&8)), (None, Some(&80)));
        // The focus state rides along with the resync, so a dropped `blur` is repaired too.
        assert_eq!(watch.focused, Some(false));
        // So does the restart setting: a dropped `disarm` no longer waits for the next launch.
        assert!(!watch.armed);
        super::super::ENABLED.store(true, Ordering::SeqCst);
        CHILDREN.lock().unwrap().remove(&8);
        std::fs::remove_file(go).unwrap();
    }

    #[test]
    fn a_dropped_exit_is_resent_by_the_resync() {
        let _serial = RESPAWN_STATE.lock().unwrap_or_else(|p| p.into_inner());
        let go = std::env::temp_dir().join(format!("pandacode-link-exit-{}", uuid::Uuid::new_v4()));
        let (mut reader, mut writer) = slow_reader(&go);
        let _link = lock();
        DIRTY.store(false, Ordering::SeqCst);
        while send_line(&mut writer, b"ping\n").is_ok() {}
        // The pipe is full: the `exit` line is lost.
        EXITING.store(true, Ordering::SeqCst);
        assert_eq!(send_line(&mut writer, b"exit\n"), Err(SendError::Full));
        std::fs::write(&go, "").unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        // A later line (an agent's `unchild` during shutdown) resyncs first.
        while send_line(&mut writer, b"unchild 9\n").is_err() {
            assert!(std::time::Instant::now() < deadline, "the reader never drained");
            std::thread::sleep(Duration::from_millis(20));
        }
        EXITING.store(false, Ordering::SeqCst);
        drop(writer);
        let mut text = String::new();
        reader.stdout.take().unwrap().read_to_string(&mut text).unwrap();
        reader.wait().unwrap();
        let watch = text.lines().fold(super::super::protocol::Watch::new(true), |w, line| w.apply_line(line, 1));
        assert!(watch.exiting, "the resync carries the exit");
        std::fs::remove_file(go).unwrap();
    }
}
