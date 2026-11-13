//! Whether systemd runs this `serve` as a service: it then restarts it itself (`Restart=`), and
//! a guard beside it would start a second host.
//!
//! `INVOCATION_ID` alone does not say so: everything a service starts inherits it, so a
//! `pandacode serve` typed into a terminal that itself runs as a systemd user service has it
//! too. Beside it, one of these must hold: `JOURNAL_STREAM` (`<device>:<inode>` of the journal
//! socket systemd connected the service's output to) names this process's own stdout or
//! stderr, which a terminal's pty never is; or the parent process is `systemd` (a service
//! whose output goes to a file or nowhere has no `JOURNAL_STREAM`).
//!
//! A host the guard relaunched (`--crash-restart`) is never the service: the guard strips
//! both variables from its environment, and the parent rule is not applied to it, since
//! it is re-parented to `systemd` (the user manager is a subreaper) once the guard exits.
//!
//! Not recognised, so it gets a guard: a service that runs `serve` through a wrapper (a shell,
//! `xvfb-run`) with its output away from the journal. systemd's default `KillMode` then ends
//! the guard with the rest of the unit when the host dies.

const INVOCATION_ENV: &str = "INVOCATION_ID";
const JOURNAL_ENV: &str = "JOURNAL_STREAM";
/// What a relaunched host must not inherit: it is the guard's child, not systemd's service.
pub const SERVICE_ENV: [&str; 2] = [INVOCATION_ENV, JOURNAL_ENV];
/// The process name (`/proc/<pid>/comm`) of the system manager and of `systemd --user`.
const MANAGER_NAME: &str = "systemd";

/// `stdio`: the `(device, inode)` of this process's stdout and stderr. `parent`: the parent
/// process's name, when it can be read. `restarted`: started by the guard with the restart
/// flag, so a `systemd` parent only means the guard has exited.
pub fn supervised(invocation_id: Option<&str>, journal_stream: Option<&str>, stdio: &[(u64, u64)], parent: Option<&str>, restarted: bool) -> bool {
    if invocation_id.is_none_or(str::is_empty) {
        return false;
    }
    journal_stream.and_then(parse_stream).is_some_and(|stream| stdio.contains(&stream)) || (!restarted && parent == Some(MANAGER_NAME))
}

/// `<device>:<inode>`, both decimal (systemd.exec(5)).
fn parse_stream(text: &str) -> Option<(u64, u64)> {
    let (device, inode) = text.split_once(':')?;
    Some((device.parse().ok()?, inode.parse().ok()?))
}

pub fn supervises_this_process() -> bool {
    let env = |name: &str| std::env::var(name).ok();
    let restarted = std::env::args().any(|arg| super::relaunch::is_restart_flag(&arg));
    supervised(env(INVOCATION_ENV).as_deref(), env(JOURNAL_ENV).as_deref(), &stdio(), parent_name().as_deref(), restarted)
}

#[cfg(unix)]
fn stdio() -> Vec<(u64, u64)> {
    use std::os::fd::AsFd;
    use std::os::unix::fs::MetadataExt;
    let identity = |fd: std::os::fd::BorrowedFd<'_>| {
        let meta = fd.try_clone_to_owned().map(std::fs::File::from).and_then(|file| file.metadata()).ok()?;
        Some((meta.dev(), meta.ino()))
    };
    [identity(std::io::stdout().as_fd()), identity(std::io::stderr().as_fd())].into_iter().flatten().collect()
}

#[cfg(not(unix))]
fn stdio() -> Vec<(u64, u64)> {
    Vec::new()
}

#[cfg(target_os = "linux")]
fn parent_name() -> Option<String> {
    let name = std::fs::read_to_string(format!("/proc/{}/comm", std::os::unix::process::parent_id())).ok()?;
    Some(name.trim_end().to_owned())
}

#[cfg(not(target_os = "linux"))]
fn parent_name() -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    const JOURNAL: (u64, u64) = (9, 43_210);
    const PTY: (u64, u64) = (25, 7);

    #[test]
    fn a_service_is_supervised_and_a_serve_typed_in_a_service_terminal_is_not() {
        // The unit's main process: its stderr is the journal stream systemd named.
        assert!(supervised(Some("abc"), Some("9:43210"), &[PTY, JOURNAL], Some("sh"), false));
        // Output sent to a file: no journal stream, but systemd is the parent.
        assert!(supervised(Some("abc"), None, &[PTY], Some("systemd"), false));
        assert!(supervised(Some("abc"), Some("9:43210"), &[], Some("systemd"), false));
        // Typed into a terminal that runs as a user service: both variables are inherited,
        // but stdio is the pty and the parent is the shell.
        assert!(!supervised(Some("abc"), Some("9:43210"), &[PTY, PTY], Some("bash"), false));
        assert!(!supervised(Some("abc"), None, &[PTY], None, false));
    }

    #[test]
    fn a_host_the_guard_restarted_is_not_taken_for_the_service_by_its_parent() {
        // Re-parented to systemd after the guard exited: still gets a guard of its own.
        assert!(!supervised(Some("abc"), None, &[PTY], Some("systemd"), true));
        assert!(!supervised(Some("abc"), Some("9:43210"), &[PTY], Some("systemd"), true));
        // Its output really is the journal: systemd started it.
        assert!(supervised(Some("abc"), Some("9:43210"), &[JOURNAL], Some("systemd"), true));
    }

    #[test]
    fn nothing_counts_without_an_invocation_id_and_a_bad_stream_is_no_stream() {
        assert!(!supervised(None, Some("9:43210"), &[JOURNAL], Some("systemd"), false));
        assert!(!supervised(Some(""), Some("9:43210"), &[JOURNAL], Some("systemd"), false));
        for stream in ["", "9", "9:", ":43210", "9:43210:1", "x:y", "-9:43210"] {
            assert!(!supervised(Some("abc"), Some(stream), &[JOURNAL, (9, 0), (0, 43_210)], None, false), "{stream:?}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn this_process_reads_its_own_stdio() {
        assert!(stdio().len() <= 2);
        // Whatever the test runner is, asking never fails.
        let _ = supervises_this_process();
    }
}
