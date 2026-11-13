//! `serve` under `xvfb-run` (docs/headless.md): when `serve` dies, xvfb-run stops its Xvfb,
//! so a plain relaunch would find a dead DISPLAY, fail to build and count as startup crashes.
//! The relaunch therefore re-wraps with `xvfb-run -a` (a fresh server on a free display,
//! without the old DISPLAY/XAUTHORITY); when xvfb-run is not in /usr/bin or /bin, serve is
//! not guarded. Only those two system locations are used, never PATH: the caller sets PATH,
//! and the wrapper is a program the guard starts.
//!
//! xvfb-run keeps its Xauthority in a `mktemp -d -t xvfb-run.XXXXXX` directory and exports
//! XAUTHORITY pointing there, so that path marks a process it started.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

/// Where a helper program is believed: the distribution's own, never one found on PATH.
const SYSTEM_BIN_DIRS: [&str; 2] = ["/usr/bin", "/bin"];
const XVFB_AUTH_MARK: &str = "/xvfb-run.";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Wrap {
    /// Relaunch the binary itself.
    Plain,
    /// Relaunch as `<xvfb-run> -a <binary> …`.
    Xvfb(PathBuf),
    /// Do not guard; the reason is logged.
    Unguarded(&'static str),
}

/// How a relaunched `serve` must be started, from the environment it runs in now.
pub fn decide(linux: bool, xauthority: Option<&OsStr>, xvfb_run: Option<PathBuf>) -> Wrap {
    let under_xvfb = xauthority.is_some_and(|path| path.to_string_lossy().contains(XVFB_AUTH_MARK));
    if !linux || !under_xvfb {
        return Wrap::Plain;
    }
    match xvfb_run {
        Some(path) => Wrap::Xvfb(path),
        None => Wrap::Unguarded("serve runs under xvfb-run, but no xvfb-run in /usr/bin or /bin can start a new display"),
    }
}

/// `name` in the first of `SYSTEM_BIN_DIRS` where `is_file`; never looked up on PATH.
pub fn system_program(name: &str, is_file: impl Fn(&Path) -> bool) -> Option<PathBuf> {
    SYSTEM_BIN_DIRS.into_iter().map(|dir| Path::new(dir).join(name)).find(|candidate| is_file(candidate))
}

/// The decision for this process's environment.
pub fn current() -> Wrap {
    let xvfb_run = system_program("xvfb-run", Path::is_file);
    decide(cfg!(target_os = "linux"), std::env::var_os("XAUTHORITY").as_deref(), xvfb_run)
}

/// The wrapper a relaunch of `mode` uses in this environment: only `serve` is re-wrapped.
/// Err (the reason) when `serve` must not be guarded here.
pub fn for_mode(mode: super::Mode, wrap: Wrap) -> Result<Option<PathBuf>, &'static str> {
    match (mode, wrap) {
        (super::Mode::Serve, Wrap::Unguarded(reason)) => Err(reason),
        (super::Mode::Serve, Wrap::Xvfb(path)) => Ok(Some(path)),
        _ => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_process_started_by_xvfb_run_is_rewrapped() {
        let auth = OsStr::new("/tmp/xvfb-run.Ab12Cd/Xauthority");
        let tool = Some(PathBuf::from("/usr/bin/xvfb-run"));
        assert_eq!(decide(true, Some(auth), tool.clone()), Wrap::Xvfb(PathBuf::from("/usr/bin/xvfb-run")));
        assert_eq!(decide(true, Some(OsStr::new("/home/u/.Xauthority")), tool.clone()), Wrap::Plain);
        assert_eq!(decide(true, None, tool.clone()), Wrap::Plain);
        assert_eq!(decide(false, Some(auth), tool), Wrap::Plain);
        assert!(matches!(decide(true, Some(auth), None), Wrap::Unguarded(_)));
    }

    #[test]
    fn only_serve_is_rewrapped() {
        use super::super::Mode;
        let xvfb = || Wrap::Xvfb(PathBuf::from("/usr/bin/xvfb-run"));
        assert_eq!(for_mode(Mode::Serve, xvfb()), Ok(Some(PathBuf::from("/usr/bin/xvfb-run"))));
        assert_eq!(for_mode(Mode::Desktop, xvfb()), Ok(None));
        assert_eq!(for_mode(Mode::Serve, Wrap::Plain), Ok(None));
        assert!(for_mode(Mode::Serve, Wrap::Unguarded("no")).is_err());
        assert_eq!(for_mode(Mode::Desktop, Wrap::Unguarded("no")), Ok(None));
    }

    #[test]
    fn xvfb_run_is_taken_only_from_usr_bin_or_bin() {
        assert_eq!(system_program("xvfb-run", |_| true), Some(PathBuf::from("/usr/bin/xvfb-run")));
        assert_eq!(system_program("xvfb-run", |p| p == Path::new("/bin/xvfb-run")), Some(PathBuf::from("/bin/xvfb-run")));
        // One only in /usr/local/bin, ~/bin or anywhere else on PATH is never used.
        assert_eq!(system_program("xvfb-run", |p| !p.starts_with("/usr/bin") && !p.starts_with("/bin")), None);
    }
}
