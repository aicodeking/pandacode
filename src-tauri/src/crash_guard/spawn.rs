//! Starting processes detached from their parent (the guard from the app, the app from the
//! guard), and the guard's own command line.

use super::guard::Config;
use std::process::{Child, Command, Stdio};

/// Own process group on Unix: a signal aimed at the parent's group (a terminal's Ctrl-C)
/// does not take the child with it.
#[cfg(unix)]
pub fn detach(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
}

#[cfg(windows)]
pub fn detach(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    command.creation_flags(super::WINDOWS_DETACHED_FLAGS);
}

#[cfg(not(any(unix, windows)))]
pub fn detach(_command: &mut Command) {}

#[cfg(windows)]
pub fn spawn(mut command: Command) -> std::io::Result<Child> {
    use std::os::windows::process::CommandExt;
    // Leaving a job object can be refused; then start inside it rather than not at all.
    command.spawn().or_else(|_| command.creation_flags(super::WINDOWS_DETACHED_FLAGS & !super::CREATE_BREAKAWAY_FROM_JOB).spawn())
}

#[cfg(not(windows))]
pub fn spawn(mut command: Command) -> std::io::Result<Child> {
    command.spawn()
}

/// The guard's log (relative to the data dir): its stderr, shared by the desktop and `serve`
/// guards. Capped and rotated at each spawn (`files::open_private_log`); a guard writes only a
/// few lines in its life.
pub const GUARD_LOG: &str = "crash-guard.log";

/// `<target> __crash-guard …` with a pipe on stdin and stderr in `GUARD_LOG`: `config.target` is the
/// launch target worked out once at setup (the AppImage too, when trusted: its own mount
/// outlives this process's), never read again, since after a package upgrade Linux reports
/// this executable as `… (deleted)`.
pub fn guard_command(config: &Config) -> std::io::Result<Command> {
    let mut command = base_command(config)?;
    command.stdin(Stdio::piped()).stdout(Stdio::null()).stderr(guard_log(&config.data_dir));
    detach(&mut command);
    Ok(command)
}

/// `GUARD_LOG`, or nowhere when it cannot be opened: a guard without a log beats none.
fn guard_log(data_dir: &std::path::Path) -> Stdio {
    let opened = super::files::create_dirs(data_dir).and_then(|()| super::files::open_private_log(&data_dir.join(GUARD_LOG), super::files::LOG_MAX_BYTES));
    match opened {
        Ok(file) => file.into(),
        Err(error) => {
            eprintln!("Crash guard runs without its log: {error}");
            Stdio::null()
        }
    }
}

#[cfg(not(all(test, unix)))]
fn base_command(config: &Config) -> std::io::Result<Command> {
    let mut command = Command::new(&config.target);
    command.args(config.to_args());
    Ok(command)
}

/// Tests: the test binary cannot take `__crash-guard` argv (libtest would read it as filters),
/// so it re-runs itself into `tests::guard_entry`, which hands these args to the real `guard::run`.
#[cfg(all(test, unix))]
fn base_command(config: &Config) -> std::io::Result<Command> {
    use std::os::unix::ffi::OsStrExt;
    let mut command = Command::new(std::env::current_exe()?);
    command.args(["--exact", super::tests::GUARD_ENTRY, "--nocapture", "-q", "--test-threads=1"]);
    let joined: Vec<u8> = config.to_args().iter().map(|a| a.as_bytes()).collect::<Vec<_>>().join(&b'\n');
    command.env(super::tests::GUARD_ARGS_ENV, std::ffi::OsStr::from_bytes(&joined));
    command.env_remove(super::tests::APP_ENV);
    Ok(command)
}
