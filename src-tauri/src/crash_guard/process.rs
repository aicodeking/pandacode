//! Process facts for the guard: waiting for the app to be gone (with its exit code where the
//! OS tells a non-parent), process start times, and stopping orphaned agent process groups.
//!
//! Orphan safety: the app reports each group leader with its start time. Before SIGKILLing
//! group `pid` the guard re-reads the start time of process `pid`:
//! - same start time: the leader is the process the app started, so the group is its group;
//! - different start time: the pid was reused, skip;
//! - no such process: the leader exited. The group is killed only when one of its current
//!   members started at or after the registered leader start (members descend from it) and
//!   no later than the app's death (EOF): a group whose id was reused by a process that
//!   started after the app died (and then exited, leaving its own members) cannot be ours.
//!   Members come from `proc_listpgrppids` (macOS) or a `/proc/*/stat` scan (Linux); when
//!   they or the death time cannot be read, nothing is killed.
//! - unknown start time (unreadable when registered): never killed.

use super::policy::ExitStatus;
use std::collections::BTreeMap;
use std::time::Duration;

/// Longest wait for the dead app to leave the process table (its single-instance lock with it).
pub const GONE_TIMEOUT: Duration = Duration::from_secs(10);
#[cfg(unix)]
const GONE_POLL: Duration = Duration::from_millis(50);

/// Start time of `pid` in a platform unit (µs since epoch on macOS, clock ticks since boot on
/// Linux), only ever compared with itself; None when it is not running or unreadable.
pub fn start_time(pid: u32) -> Option<u64> {
    platform_stat(pid).map(|stat| stat.start).filter(|start| *start != 0)
}

/// What the guard reads about one process.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Stat {
    pub start: u64,
    /// Dead but not yet reaped by its parent: gone for every purpose but the process table.
    #[cfg_attr(not(unix), allow(dead_code))]
    pub zombie: bool,
}

/// `SZOMB` in macOS `<sys/proc.h>`: `pbi_status` of a dead, unreaped process.
#[cfg(target_os = "macos")]
const SZOMB: u32 = 5;

#[cfg(target_os = "macos")]
fn platform_stat(pid: u32) -> Option<Stat> {
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
    // SAFETY: proc_pidinfo fills at most `size` bytes of `info`.
    let read = unsafe { libc::proc_pidinfo(pid as libc::c_int, libc::PROC_PIDTBSDINFO, 0, (&mut info as *mut libc::proc_bsdinfo).cast(), size) };
    if read == size {
        return Some(Stat { start: info.pbi_start_tvsec * 1_000_000 + info.pbi_start_tvusec, zombie: info.pbi_status == SZOMB });
    }
    // proc_pidinfo refuses a zombie (ESRCH) though kill(pid, 0) still finds it; sysctl tells.
    macos_zombie(pid).then_some(Stat { start: 0, zombie: true })
}

/// `struct kinfo_proc` (`<sys/sysctl.h>`, LP64: arm64 and x86_64), which libc does not
/// define: its size, and the offset of `kp_proc.p_stat`.
#[cfg(target_os = "macos")]
const KINFO_PROC_SIZE: usize = 648;
#[cfg(target_os = "macos")]
const P_STAT_OFFSET: usize = 36;

#[cfg(target_os = "macos")]
fn macos_zombie(pid: u32) -> bool {
    let Ok(pid) = libc::c_int::try_from(pid) else { return false };
    let mut mib = [libc::CTL_KERN, libc::KERN_PROC, libc::KERN_PROC_PID, pid];
    let mut info = [0u8; KINFO_PROC_SIZE];
    let mut len = info.len();
    // SAFETY: sysctl writes at most `len` bytes into `info` and updates `len`.
    let read = unsafe { libc::sysctl(mib.as_mut_ptr(), 4, info.as_mut_ptr().cast(), &mut len, std::ptr::null_mut(), 0) };
    read == 0 && len == KINFO_PROC_SIZE && u32::from(info[P_STAT_OFFSET]) == SZOMB
}

#[cfg(target_os = "linux")]
fn platform_stat(pid: u32) -> Option<Stat> {
    linux_stat(&std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn platform_stat(_pid: u32) -> Option<Stat> {
    None
}

/// Fields 3 (`state`: `Z` zombie, `X` dead) and 22 (`starttime`) of `/proc/<pid>/stat`.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn linux_stat(stat: &str) -> Option<Stat> {
    let state = stat[stat.rfind(')')? + 1..].split_whitespace().next()?;
    Some(Stat { start: linux_stat_start(stat)?, zombie: matches!(state, "Z" | "X") })
}

/// Field 22 (`starttime`) of `/proc/<pid>/stat`; the command name (field 2) may hold spaces
/// and parentheses, so fields are counted after its last `)`.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn linux_stat_start(stat: &str) -> Option<u64> {
    let after_name = &stat[stat.rfind(')')? + 1..];
    // After the name: field 3 (state) is the first, so starttime (22) is the 20th.
    after_name.split_whitespace().nth(19)?.parse().ok()
}

/// Fields 5 (`pgrp`) and 22 (`starttime`) of `/proc/<pid>/stat`.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn linux_stat_group_and_start(stat: &str) -> Option<(u32, u64)> {
    let mut fields = stat[stat.rfind(')')? + 1..].split_whitespace();
    let group = fields.nth(2)?.parse().ok()?;
    Some((group, fields.nth(16)?.parse().ok()?))
}

/// Now, in `start_time`'s unit; None where start times are not read.
#[cfg(target_os = "macos")]
pub fn clock_now() -> Option<u64> {
    let since = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).ok()?;
    u64::try_from(since.as_micros()).ok()
}

/// Now, in clock ticks since boot (`/proc/uptime` × `_SC_CLK_TCK`), rounded up.
#[cfg(target_os = "linux")]
pub fn clock_now() -> Option<u64> {
    let uptime: f64 = std::fs::read_to_string("/proc/uptime").ok()?.split_whitespace().next()?.parse().ok()?;
    // SAFETY: sysconf has no preconditions.
    let ticks = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
    (ticks > 0 && uptime >= 0.0).then(|| (uptime * ticks as f64).ceil() as u64)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn clock_now() -> Option<u64> {
    None
}

/// Start times of the current members of process group `group`; None when unreadable.
#[cfg(target_os = "macos")]
fn group_member_starts(group: i32) -> Option<Vec<u64>> {
    // A full buffer may cut the list short; that can only skip a kill, never add one.
    let mut pids = vec![0 as libc::pid_t; 4096];
    let bytes = libc::c_int::try_from(pids.len() * std::mem::size_of::<libc::pid_t>()).ok()?;
    // SAFETY: the kernel writes at most `bytes` bytes into `pids`.
    let count = unsafe { libc::proc_listpgrppids(group, pids.as_mut_ptr().cast(), bytes) };
    let count = usize::try_from(count).ok()?.min(pids.len());
    Some(pids[..count].iter().filter_map(|pid| u32::try_from(*pid).ok().and_then(start_time)).collect())
}

#[cfg(target_os = "linux")]
fn group_member_starts(group: i32) -> Option<Vec<u64>> {
    let group = u32::try_from(group).ok()?;
    let entries = std::fs::read_dir("/proc").ok()?;
    let stats = entries.filter_map(|entry| {
        let entry = entry.ok()?;
        entry.file_name().to_str()?.parse::<u32>().ok()?;
        linux_stat_group_and_start(&std::fs::read_to_string(entry.path().join("stat")).ok()?)
    });
    Some(stats.filter(|(member_group, start)| *member_group == group && *start != 0).map(|(_, start)| start).collect())
}

#[cfg(all(unix, not(any(target_os = "macos", target_os = "linux"))))]
fn group_member_starts(_group: i32) -> Option<Vec<u64>> {
    None
}

/// Whether group `pid`, registered with `registered` as its leader's start time, may be killed.
/// `leader`: the start time of process `pid` now. With the leader gone, `members` (the group's
/// member start times, read only then) must hold one started within `registered..=died`.
///
/// Known limit of the leaderless case: start times in that range do not prove the members are
/// the agent's. If the agent's whole group ended while the guard still listed it (its
/// `unchild` was dropped and no resync followed, or the app died first), the kernel could give
/// the leader's pid to an unrelated process that became a group leader itself, started
/// children before the app died and then exited: that group has the same id, no leader and
/// members inside the range, and is killed. It needs a pid reuse plus those four steps inside
/// one app run. Telling the two apart needs an identity the guard does not have (a per-member
/// record from the app, or a pidfd/kqueue watch held from registration), so it is left as is.
#[cfg(any(unix, test))]
pub fn group_is_ours(registered: u64, leader: Option<u64>, members: impl FnOnce() -> Option<Vec<u64>>, died: Option<u64>) -> bool {
    if registered == 0 {
        return false;
    }
    match (leader, died) {
        (Some(now), _) => now == registered,
        (None, Some(died)) => members().is_some_and(|starts| starts.iter().any(|start| (registered..=died).contains(start))),
        (None, None) => false,
    }
}

/// Agent process groups the dead app left behind: their output has nowhere to go, and the
/// restarted app marks their runs interrupted. `died`: when the app died (`clock_now` at EOF).
pub fn stop_children(children: &BTreeMap<u32, u64>, died: Option<u64>) {
    #[cfg(unix)]
    for (&pid, &registered) in children {
        let Ok(group) = i32::try_from(pid) else { continue };
        if group <= 1 || !group_is_ours(registered, start_time(pid), || group_member_starts(group), died) {
            continue;
        }
        // SAFETY: kill(2) on a validated process group id (> 1).
        unsafe {
            libc::kill(-group, libc::SIGKILL);
        }
    }
    // Windows: the app's job objects already end those trees when its handles close.
    #[cfg(not(unix))]
    let _ = (children, died);
}

/// The watched app, held open on Windows from the start so its exit code survives.
pub struct Process {
    #[cfg(unix)]
    pid: u32,
    /// Its start time when the guard began, to tell a reused pid from the app.
    #[cfg(unix)]
    start: Option<u64>,
    #[cfg(windows)]
    handle: Option<std::os::windows::io::OwnedHandle>,
}

impl Process {
    #[cfg(unix)]
    pub fn open(pid: u32) -> Self {
        Self { pid, start: start_time(pid) }
    }

    /// Unix: dead (a zombie counts: a supervisor that reaps late must not stop recovery), or
    /// its pid now names a later process. Unreadable details fall back to `kill(pid, 0)`, so
    /// a failed read never declares a live app gone.
    #[cfg(unix)]
    pub fn gone(&self) -> bool {
        match platform_stat(self.pid) {
            Some(stat) => stat.zombie || self.start.is_some_and(|start| start != stat.start),
            // SAFETY: signal 0 only checks that the process exists.
            None => (unsafe { libc::kill(self.pid as i32, 0) }) != 0,
        }
    }

    /// Unix: until `gone`, for at most `timeout`; the OS does not tell a non-parent why.
    /// None when the process is still there.
    #[cfg(unix)]
    pub fn wait_gone(&self, timeout: Duration) -> Option<ExitStatus> {
        let deadline = std::time::Instant::now() + timeout;
        while !self.gone() {
            if std::time::Instant::now() >= deadline {
                return None;
            }
            std::thread::sleep(GONE_POLL);
        }
        Some(ExitStatus::Unknown)
    }

    #[cfg(windows)]
    pub fn open(pid: u32) -> Self {
        use std::os::windows::io::FromRawHandle;
        use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE};
        // SAFETY: a successful OpenProcess returns an owned handle, wrapped at once.
        let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }
            .inspect_err(|error| eprintln!("Crash guard could not open the app process: {error}"))
            .ok()
            .map(|handle| unsafe { std::os::windows::io::OwnedHandle::from_raw_handle(handle.0) });
        Self { handle }
    }

    /// Windows: exited (its handle is signaled), or never opened, which `wait_gone` also
    /// treats as gone.
    #[cfg(windows)]
    pub fn gone(&self) -> bool {
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::Foundation::{HANDLE, WAIT_OBJECT_0};
        use windows::Win32::System::Threading::WaitForSingleObject;
        let Some(handle) = &self.handle else { return true };
        // SAFETY: the handle stays owned for the call; a zero timeout only polls.
        unsafe { WaitForSingleObject(HANDLE(handle.as_raw_handle()), 0) == WAIT_OBJECT_0 }
    }

    /// None when the process is still running after `timeout` (or the wait failed). A
    /// process that could not be opened at the start counts as gone.
    #[cfg(windows)]
    pub fn wait_gone(&self, timeout: Duration) -> Option<ExitStatus> {
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::Foundation::{HANDLE, WAIT_OBJECT_0};
        use windows::Win32::System::Threading::{GetExitCodeProcess, WaitForSingleObject};
        let Some(handle) = &self.handle else { return Some(ExitStatus::Unknown) };
        let raw = HANDLE(handle.as_raw_handle());
        let millis = u32::try_from(timeout.as_millis()).unwrap_or(u32::MAX);
        // SAFETY: the handle stays owned for both calls.
        unsafe {
            if WaitForSingleObject(raw, millis) != WAIT_OBJECT_0 {
                return None;
            }
            let mut code = 0u32;
            Some(match GetExitCodeProcess(raw, &mut code) {
                Ok(()) => ExitStatus::Code(code),
                Err(_) => ExitStatus::Unknown,
            })
        }
    }

    #[cfg(not(any(unix, windows)))]
    pub fn open(_pid: u32) -> Self {
        Self {}
    }

    #[cfg(not(any(unix, windows)))]
    pub fn gone(&self) -> bool {
        false
    }

    #[cfg(not(any(unix, windows)))]
    pub fn wait_gone(&self, _timeout: Duration) -> Option<ExitStatus> {
        Some(ExitStatus::Unknown)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn linux_stat_start_skips_tricky_command_names() {
        let stat = "4242 (we ird) name)) S 1 4242 4242 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 987654 1000 10";
        assert_eq!(linux_stat_start(stat), Some(987_654));
        assert_eq!(linux_stat_start("4242 (short) S 1"), None);
        assert_eq!(linux_stat_start("garbage"), None);
    }

    #[test]
    fn a_group_with_its_leader_present_is_ours_only_with_the_same_start() {
        let unread = || -> Option<Vec<u64>> { panic!("members are read only when the leader is gone") };
        assert!(group_is_ours(10, Some(10), unread, Some(100)));
        assert!(!group_is_ours(10, Some(11), unread, Some(100)));
        assert!(!group_is_ours(0, Some(0), unread, Some(100)));
    }

    #[test]
    fn a_leaderless_group_is_ours_only_with_a_member_from_before_the_death() {
        // A member started between the leader's registered start and the death.
        assert!(group_is_ours(10, None, || Some(vec![500, 50]), Some(100)));
        assert!(group_is_ours(10, None, || Some(vec![10]), Some(100)));
        assert!(group_is_ours(10, None, || Some(vec![100]), Some(100)));
        // A group made after the app died (a reused id), or older than our leader: not ours.
        assert!(!group_is_ours(10, None, || Some(vec![101, 200]), Some(100)));
        assert!(!group_is_ours(10, None, || Some(vec![9]), Some(100)));
        // Nothing left, unreadable members, unknown death or registration: never killed.
        assert!(!group_is_ours(10, None, || Some(Vec::new()), Some(100)));
        assert!(!group_is_ours(10, None, || None, Some(100)));
        assert!(!group_is_ours(10, None, || Some(vec![50]), None));
        assert!(!group_is_ours(0, None, || Some(vec![50]), Some(100)));
    }

    #[test]
    fn linux_stat_reads_the_group_and_start() {
        let stat = "4242 (we ird) name)) S 1 777 4242 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 987654 1000 10";
        assert_eq!(linux_stat_group_and_start(stat), Some((777, 987_654)));
        assert_eq!(linux_stat_group_and_start("4242 (x) S 1 2"), None);
    }

    #[test]
    fn linux_stat_reads_zombies() {
        let stat = |state: &str| format!("4242 (a (b) c) {state} 1 4242 4242 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 987654 1000 10");
        assert_eq!(linux_stat(&stat("Z")), Some(Stat { start: 987_654, zombie: true }));
        assert_eq!(linux_stat(&stat("X")).map(|s| s.zombie), Some(true));
        assert_eq!(linux_stat(&stat("S")), Some(Stat { start: 987_654, zombie: false }));
        assert_eq!(linux_stat("4242 (x) Z 1"), None);
    }

    /// A child that exits and is deliberately not waited on stays a zombie: `kill(pid, 0)`
    /// still succeeds, yet the app is gone.
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn an_unreaped_zombie_counts_as_gone() {
        let mut child = std::process::Command::new("true").spawn().unwrap();
        let pid = child.id();
        let app = Process::open(pid);
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while !platform_stat(pid).is_some_and(|stat| stat.zombie) {
            assert!(std::time::Instant::now() < deadline, "the child never became a zombie");
            std::thread::sleep(Duration::from_millis(10));
        }
        // SAFETY: signal 0 only checks that the process exists.
        assert_eq!(unsafe { libc::kill(pid as i32, 0) }, 0, "a zombie is still in the process table");
        assert_eq!(app.wait_gone(Duration::from_secs(2)), Some(ExitStatus::Unknown));
        child.wait().unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn waiting_reports_whether_the_process_is_gone() {
        let me = Process::open(std::process::id());
        assert_eq!(me.wait_gone(Duration::from_millis(120)), None);
        let mut child = std::process::Command::new("true").spawn().unwrap();
        let pid = child.id();
        child.wait().unwrap();
        assert_eq!(Process::open(pid).wait_gone(Duration::from_secs(5)), Some(ExitStatus::Unknown));
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn this_process_is_a_member_of_its_own_group_started_before_now() {
        // SAFETY: getpgrp has no preconditions.
        let group = unsafe { libc::getpgrp() };
        let mine = start_time(std::process::id()).unwrap();
        let now = clock_now().unwrap();
        assert!(mine <= now, "{mine} > {now}");
        assert!(group_member_starts(group).unwrap().contains(&mine));
        assert!(group_is_ours(mine, None, || group_member_starts(group), Some(now)));
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn start_times_identify_a_process() {
        let mine = start_time(std::process::id());
        assert!(mine.is_some());
        assert_eq!(mine, start_time(std::process::id()));
        assert_eq!(start_time(i32::MAX as u32), None);
    }
}
