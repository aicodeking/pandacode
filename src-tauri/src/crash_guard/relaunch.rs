//! Starting the app again after a crash: which args to pass, and how to launch it so the
//! new process is independent of the guard (macOS bundles go through LaunchServices).

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// Marks a launch as an automatic restart; the value is the crash time (ms since epoch).
pub const RESTART_FLAG: &str = "--crash-restart";
/// Relaunched `serve` hosts log here (relative to the data dir), having lost their terminal.
pub const SERVE_LOG: &str = "serve-restart.log";
/// How often a relaunched `serve` checks its own log against `files::LOG_MAX_BYTES`.
#[cfg(unix)]
const SERVE_LOG_CHECK: std::time::Duration = std::time::Duration::from_secs(30);

/// A relaunched `serve` writes through the log handle it inherited for as long as it runs:
/// when this process's stdout is `SERVE_LOG`, a thread rotates it past the cap, or opens it
/// again once another process's prune deleted it, and points stdout and stderr at the fresh
/// file. It also keeps the log's modification time fresh (`files::refresh_output`, at most
/// once a day), so another process's prune never deletes it as unwritten. Elsewhere (Windows)
/// the cap applies at each relaunch.
#[cfg(unix)]
pub fn keep_serve_log_capped(data_dir: &Path) {
    use std::os::fd::AsFd;
    let path = data_dir.join(SERVE_LOG);
    if !super::files::writes_to(std::io::stdout().as_fd(), &path) {
        return;
    }
    let checker = std::thread::Builder::new().name("serve-log-cap".into()).spawn(move || loop {
        if let Err(error) = super::files::refresh_output(std::io::stdout().as_fd(), std::time::SystemTime::now()) {
            eprintln!("Could not keep {SERVE_LOG} current: {error}");
        }
        std::thread::sleep(SERVE_LOG_CHECK);
        let (out, err) = (std::io::stdout(), std::io::stderr());
        if let Err(error) = super::files::rotate_redirected_log(&path, super::files::LOG_MAX_BYTES, &[out.as_fd(), err.as_fd()]) {
            eprintln!("Could not rotate {SERVE_LOG}: {error}");
        }
    });
    if let Err(error) = checker {
        eprintln!("Could not start the {SERVE_LOG} size check: {error}");
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Desktop,
    Serve,
}

impl Mode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Desktop => "desktop",
            Self::Serve => "serve",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "desktop" => Some(Self::Desktop),
            "serve" => Some(Self::Serve),
            _ => None,
        }
    }
}

/// True for our own flag (`--crash-restart=<ms>`), which no other parser may see.
pub fn is_restart_flag(arg: &str) -> bool {
    arg == RESTART_FLAG || arg.starts_with(&format!("{RESTART_FLAG}="))
}

/// The crash time a guard's relaunch carries (`--crash-restart=<ms>`); None for any other launch.
pub fn restart_mark(args: impl IntoIterator<Item = String>) -> Option<u64> {
    args.into_iter().find_map(|arg| arg.strip_prefix(&format!("{RESTART_FLAG}="))?.parse().ok())
}

/// The args (after argv[0]) a relaunch passes on: the desktop keeps what it was given minus
/// one-shot flags and old restart marks; `serve` restarts as a plain host (sign-in, import
/// and settings commands are one-shot).
pub fn relaunch_args(mode: Mode, original: &[String], crashed_at: u64) -> Vec<String> {
    let mut args: Vec<String> = match mode {
        Mode::Serve => vec!["serve".into()],
        Mode::Desktop => original
            .iter()
            .filter(|arg| !is_restart_flag(arg) && arg.as_str() != "--local-sign" && !arg.starts_with("-psn_"))
            .cloned()
            .collect(),
    };
    args.push(format!("{RESTART_FLAG}={crashed_at}"));
    args
}

/// What to start: the AppImage when this process really runs from it (its mount vanishes
/// with the app), else the executable. Like `tauri::process::current_binary`, but `$APPIMAGE`
/// is only believed when checked (see `trusted_appimage`).
pub fn launch_target() -> std::io::Result<PathBuf> {
    #[cfg(all(test, unix))]
    if let Some(target) = std::env::var_os(super::tests::TARGET_ENV) {
        return Ok(PathBuf::from(target));
    }
    let exe = std::env::current_exe()?;
    #[cfg(target_os = "linux")]
    if let Some(image) = trusted_appimage(
        std::env::var_os("APPIMAGE").as_deref(),
        std::env::var_os("APPDIR").as_deref(),
        &exe,
        &std::env::temp_dir(),
        Path::is_file,
    ) {
        return Ok(image);
    }
    Ok(exe)
}

/// `$APPIMAGE`, if this executable lives inside that AppImage's mount: under `<temp>/.mount_*`
/// (where the AppImage runtime mounts, as tauri-utils checks), or under `$APPDIR` when that
/// itself looks like a mount point (`<temp>/.mount_*` or `/run/user/<uid>/<dir>`, never a broad
/// prefix such as `/` or `/usr`), and the image file exists. A PandaCode started from inside
/// another AppImage inherits that app's variables; trusting them would make the foreign image
/// our guard and relaunch target.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn trusted_appimage(
    appimage: Option<&std::ffi::OsStr>,
    appdir: Option<&std::ffi::OsStr>,
    exe: &Path,
    temp: &Path,
    is_file: impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    let image = PathBuf::from(appimage.filter(|p| !p.is_empty())?);
    let in_appdir = appdir.map(Path::new).is_some_and(|dir| mount_point(dir, temp) && exe.starts_with(dir));
    let in_mount = exe.ancestors().any(|dir| temp_mount(dir, temp));
    (image.is_absolute() && plain(exe) && (in_appdir || in_mount) && is_file(&image)).then_some(image)
}

/// Absolute with no `.`/`..` parts, so `starts_with` means what it says.
fn plain(path: &Path) -> bool {
    use std::path::Component;
    path.is_absolute() && path.components().all(|c| matches!(c, Component::RootDir | Component::Normal(_)))
}

/// `<temp>/.mount_*` exactly.
fn temp_mount(dir: &Path, temp: &Path) -> bool {
    dir.parent() == Some(temp) && dir.file_name().is_some_and(|name| name.to_string_lossy().starts_with(".mount_"))
}

/// Where an AppImage runtime mounts: `<temp>/.mount_*`, or a directory under `/run/user/<uid>/`.
fn mount_point(dir: &Path, temp: &Path) -> bool {
    let under_run_user = dir
        .strip_prefix("/run/user")
        .is_ok_and(|rest| rest.components().count() >= 2 && rest.components().next().is_some_and(|uid| uid.as_os_str().to_string_lossy().parse::<u32>().is_ok()));
    plain(dir) && (temp_mount(dir, temp) || under_run_user)
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
/// `Foo.app` for `Foo.app/Contents/MacOS/foo`: relaunching the bundle picks up an updated
/// executable even if its name changed.
pub fn bundle_root(target: &Path) -> Option<&Path> {
    let macos = target.parent()?;
    let contents = macos.parent()?;
    let bundle = contents.parent()?;
    let named = |path: &Path, name: &str| path.file_name().is_some_and(|n| n == name);
    let is_app = bundle.extension().is_some_and(|ext| ext == "app");
    (named(macos, "MacOS") && named(contents, "Contents") && is_app).then_some(bundle)
}

/// `open` args for a bundle: a new instance, in the background (`-g`, not activated) when
/// PandaCode was not in front when it died.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn open_args(bundle: &Path, args: &[String], background: bool) -> Vec<OsString> {
    let flags: &[&str] = if background { &["-n", "-g"] } else { &["-n"] };
    let mut out: Vec<OsString> = flags.iter().map(OsString::from).collect();
    out.push(bundle.into());
    out.push("--args".into());
    out.extend(args.iter().map(OsString::from));
    out
}

/// Starts the app detached from the guard. Desktop bundles on macOS open through
/// LaunchServices (`background`: without taking focus); everything else runs the target in
/// its own process group, `serve` through `xvfb-run -a` when it was started under one
/// (`wrapper`) and logging to `SERVE_LOG`.
pub fn launch(mode: Mode, target: &Path, args: &[String], data_dir: &Path, wrapper: Option<&Path>, background: bool) -> std::io::Result<()> {
    #[cfg(target_os = "macos")]
    if mode == Mode::Desktop {
        if let Some(bundle) = bundle_root(target) {
            let status = Command::new("/usr/bin/open")
                .args(open_args(bundle, args, background))
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()?;
            return if status.success() { Ok(()) } else { Err(std::io::Error::other(format!("open exited with {status}"))) };
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = background;
    let mut command = relaunch_command(mode, target, args, wrapper);
    match mode {
        Mode::Serve => {
            let log = super::files::open_private_log(&data_dir.join(SERVE_LOG), super::files::LOG_MAX_BYTES)?;
            command.stdout(log.try_clone()?).stderr(log);
        }
        Mode::Desktop => {
            command.stdout(Stdio::null()).stderr(Stdio::null());
        }
    }
    super::spawn::detach(&mut command);
    still_running(super::spawn::spawn(command)?, STARTED_WATCH)
}

/// How long the guard watches a relaunch it started itself. One gone by then died before it
/// could take the notice or start its own guard (a `serve` whose app build fails, a desktop
/// launch that dies in plugin setup), so `launch` fails and the notice goes back to
/// not-restarted. A bundle opened through `open` has no handle here and is not watched: its
/// notice says restarted only once that launch takes it (`state::Pending::confirmed`), and
/// the same rule covers a relaunch that dies after this watch.
#[cfg(not(test))]
const STARTED_WATCH: std::time::Duration = std::time::Duration::from_secs(2);
#[cfg(test)]
const STARTED_WATCH: std::time::Duration = std::time::Duration::from_millis(300);

/// Ok once `child` has run for `within`; Err when it exited sooner. The child is reaped if it
/// exited and otherwise left running (dropping a `Child` neither kills nor waits for it).
fn still_running(mut child: std::process::Child, within: std::time::Duration) -> std::io::Result<()> {
    let deadline = std::time::Instant::now() + within;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Err(exited_at_once(status.success(), &status)),
            // Unknown: it was started, so count it as running.
            Err(error) => {
                eprintln!("Crash guard could not check the relaunched app: {error}");
                return Ok(());
            }
            Ok(None) if std::time::Instant::now() >= deadline => return Ok(()),
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(25)),
        }
    }
}

/// Why a relaunch that ended within the watch failed. Status 0 is most likely the
/// single-instance handoff to a PandaCode the user opened meanwhile (`ErrorKind::AlreadyExists`,
/// `guard::Outcome::HandedOff`), not a launch that could not start.
fn exited_at_once(success: bool, status: &dyn std::fmt::Display) -> std::io::Error {
    if success {
        std::io::Error::new(std::io::ErrorKind::AlreadyExists, "the relaunched app handed off to a running PandaCode")
    } else {
        std::io::Error::other(format!("the relaunched app exited at once ({status})"))
    }
}

/// The relaunch command without its output. A `serve` host the guard starts is the guard's
/// child, never a systemd service: the service variables it inherited are removed, or it
/// would take itself for the service and run without a guard (`systemd::supervised`).
fn relaunch_command(mode: Mode, target: &Path, args: &[String], wrapper: Option<&Path>) -> Command {
    let mut command = match wrapper {
        Some(xvfb_run) => {
            let mut command = Command::new(xvfb_run);
            // The old display died with the old xvfb-run: start clean on a free one.
            command.arg("-a").arg(target).env_remove("DISPLAY").env_remove("XAUTHORITY");
            command
        }
        None => Command::new(target),
    };
    command.args(args.iter().map(OsString::from)).stdin(Stdio::null());
    if mode == Mode::Serve {
        for name in super::systemd::SERVICE_ENV {
            command.env_remove(name);
        }
    }
    command
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn a_relaunch_that_exits_within_the_watch_fails_and_one_still_running_succeeds() {
        let quick = Command::new("/bin/sh").args(["-c", "exit 3"]).spawn().unwrap();
        let error = still_running(quick, std::time::Duration::from_secs(2)).unwrap_err();
        assert!(error.to_string().contains("exited at once"), "{error}");
        let slow = Command::new("/bin/sh").args(["-c", "sleep 5"]).spawn().unwrap();
        let pid = slow.id().to_string();
        let started = std::time::Instant::now();
        assert!(still_running(slow, std::time::Duration::from_millis(200)).is_ok());
        assert!(started.elapsed() < std::time::Duration::from_secs(2));
        let _ = Command::new("/bin/kill").arg(&pid).status();
    }

    fn removed(command: &Command) -> Vec<String> {
        command.get_envs().filter(|(_, value)| value.is_none()).map(|(name, _)| name.to_string_lossy().into_owned()).collect()
    }

    #[test]
    fn a_relaunched_serve_drops_the_systemd_service_variables() {
        let target = Path::new("/usr/bin/pandacode");
        let args = strings(&["serve", "--crash-restart=1"]);
        for wrapper in [None, Some(Path::new("/usr/bin/xvfb-run"))] {
            let serve = removed(&relaunch_command(Mode::Serve, target, &args, wrapper));
            assert!(serve.contains(&"INVOCATION_ID".to_string()) && serve.contains(&"JOURNAL_STREAM".to_string()), "{serve:?}");
        }
        assert!(removed(&relaunch_command(Mode::Desktop, target, &args, None)).is_empty());
    }

    fn strings(args: &[&str]) -> Vec<String> {
        args.iter().map(|a| a.to_string()).collect()
    }

    #[test]
    fn desktop_relaunch_keeps_args_but_drops_one_shot_and_old_marks() {
        let original = strings(&["/tmp/project", "--crash-restart=5", "-psn_0_123", "--local-sign", "--flag"]);
        assert_eq!(relaunch_args(Mode::Desktop, &original, 99), strings(&["/tmp/project", "--flag", "--crash-restart=99"]));
        assert_eq!(relaunch_args(Mode::Desktop, &[], 1), strings(&["--crash-restart=1"]));
    }

    #[test]
    fn serve_relaunches_as_a_plain_host() {
        let original = strings(&["serve", "--sign-in", "--device-name", "box", "--import-bots", "/tmp/b.json"]);
        assert_eq!(relaunch_args(Mode::Serve, &original, 7), strings(&["serve", "--crash-restart=7"]));
    }

    #[test]
    fn restart_flag_is_recognised_and_read() {
        assert!(is_restart_flag("--crash-restart=12") && is_restart_flag("--crash-restart"));
        assert!(!is_restart_flag("--crash-restarts=1"));
        assert_eq!(restart_mark(strings(&["/tmp/p", "--crash-restart=12"])), Some(12));
        assert_eq!(restart_mark(strings(&["--crash-restart", "--crash-restart=x", "--crash-restarts=3"])), None);
        assert_eq!(Mode::parse(Mode::Serve.as_str()), Some(Mode::Serve));
    }

    #[test]
    fn appimage_is_trusted_only_from_inside_its_own_mount() {
        let image = Some(std::ffi::OsStr::new("/home/u/Apps/PandaCode.AppImage"));
        let temp = Path::new("/tmp");
        let exists = |_: &Path| true;
        let mounted = Path::new("/tmp/.mount_PandaCabc/usr/bin/pandacode");
        let expected = Some(PathBuf::from("/home/u/Apps/PandaCode.AppImage"));
        assert_eq!(trusted_appimage(image, None, mounted, temp, exists), expected);
        let appdir = Some(std::ffi::OsStr::new("/run/user/1/appimage"));
        assert_eq!(trusted_appimage(image, appdir, Path::new("/run/user/1/appimage/usr/bin/pandacode"), temp, exists), expected);
        // A .deb or dev build started from inside another AppImage inherits its variables.
        let foreign_dir = Some(std::ffi::OsStr::new("/tmp/.mount_Other123"));
        assert_eq!(trusted_appimage(image, foreign_dir, Path::new("/usr/bin/pandacode"), temp, exists), None);
        assert_eq!(trusted_appimage(image, None, Path::new("/tmp/not-a-mount/pandacode"), temp, exists), None);
        // Missing, relative or empty images are never used.
        assert_eq!(trusted_appimage(image, None, mounted, temp, |_| false), None);
        assert_eq!(trusted_appimage(Some(std::ffi::OsStr::new("rel.AppImage")), None, mounted, temp, exists), None);
        assert_eq!(trusted_appimage(Some(std::ffi::OsStr::new("")), None, mounted, temp, exists), None);
        assert_eq!(trusted_appimage(None, None, mounted, temp, exists), None);
    }

    #[test]
    fn a_broad_appdir_is_not_a_mount_point() {
        let image = Some(std::ffi::OsStr::new("/home/u/Apps/Other.AppImage"));
        let temp = Path::new("/tmp");
        let exists = |_: &Path| true;
        let exe = Path::new("/usr/bin/pandacode");
        for dir in ["/", "/usr", "/usr/bin", "/run/user/1", "/run/user/x/app", "/tmp", "/tmp/.mount_a/../../usr", "relative"] {
            assert_eq!(trusted_appimage(image, Some(std::ffi::OsStr::new(dir)), exe, temp, exists), None, "{dir}");
        }
        let under = |dir: &str, exe: &str| trusted_appimage(image, Some(std::ffi::OsStr::new(dir)), Path::new(exe), temp, exists).is_some();
        assert!(under("/tmp/.mount_PandaXy", "/tmp/.mount_PandaXy/usr/bin/pandacode"));
        assert!(under("/run/user/1000/appimage-x", "/run/user/1000/appimage-x/usr/bin/pandacode"));
        assert!(!under("/run/user/1000/appimage-x", "/run/user/1000/appimage-x/../../../usr/bin/pandacode"));
    }

    #[test]
    fn a_background_relaunch_opens_without_taking_focus() {
        let bundle = Path::new("/Applications/PandaCode.app");
        let args = strings(&["--crash-restart=1"]);
        let text = |background| open_args(bundle, &args, background).iter().map(|a| a.to_string_lossy().into_owned()).collect::<Vec<_>>();
        assert_eq!(text(false), ["-n", "/Applications/PandaCode.app", "--args", "--crash-restart=1"]);
        assert_eq!(text(true), ["-n", "-g", "/Applications/PandaCode.app", "--args", "--crash-restart=1"]);
    }

    #[test]
    fn bundles_are_found_only_in_app_layouts() {
        let exe = Path::new("/Applications/PandaCode.app/Contents/MacOS/pandacode");
        assert_eq!(bundle_root(exe), Some(Path::new("/Applications/PandaCode.app")));
        assert_eq!(bundle_root(Path::new("/repo/target/debug/pandacode")), None);
        assert_eq!(bundle_root(Path::new("/x/Contents/MacOS/pandacode")), None);
    }

    #[test]
    fn a_relaunch_that_exits_at_once_with_status_0_handed_off() {
        let handed_off = exited_at_once(true, &"exit status: 0");
        assert_eq!(handed_off.kind(), std::io::ErrorKind::AlreadyExists);
        assert!(handed_off.to_string().contains("handed off to a running PandaCode"));
        let failed = exited_at_once(false, &"exit status: 1");
        assert_ne!(failed.kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(failed.to_string(), "the relaunched app exited at once (exit status: 1)");
    }

}
