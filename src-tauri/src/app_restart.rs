//! Relaunching after an in-app update.
//!
//! Tauri's own restart (`AppHandle::request_restart`, which `@tauri-apps/plugin-process`
//! calls) ends in `tauri::process::restart`, and since Tauri 2.12 that opens the bundle with
//! `/usr/bin/open -n` on macOS. `-n` asks LaunchServices for a *new* instance, so every
//! update leaves the previous Dock tile behind and adds another one
//! (tauri-apps/tauri#16449, #16458).
//!
//! On macOS we instead schedule a small detached helper: it waits for this process to leave
//! the process table, then opens the bundle **without** `-n`, exactly as Sparkle does. One
//! instance at a time, so LaunchServices binds the new process to the existing (pinned)
//! Dock tile. Other platforms keep Tauri's restart, which is correct there.

use std::sync::atomic::{AtomicBool, Ordering};

/// Set when the updater asked for a macOS relaunch. The exit path spawns the helper for it,
/// and Tauri's `open -n` restart is never reached (`request_restart` is not used).
static RESTART_REQUESTED: AtomicBool = AtomicBool::new(false);

/// True once [`restart_app`] scheduled a macOS relaunch.
pub(crate) fn restart_requested() -> bool {
    RESTART_REQUESTED.load(Ordering::SeqCst)
}

/// Restarts the app to finish an update: on macOS through the Dock-preserving helper, on
/// every other platform through Tauri's own restart.
#[tauri::command]
pub fn restart_app(app: tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    if bundle_of_current_exe().is_some() {
        // Exit normally rather than through `request_restart`, so Tauri never runs
        // `open -n`; the `RunEvent::Exit` handler spawns the helper instead.
        RESTART_REQUESTED.store(true, Ordering::SeqCst);
        app.exit(0);
        return;
    }
    app.request_restart();
}

/// `.../Name.app/Contents/MacOS/bin` → `.../Name.app`; `None` when not inside an app bundle.
#[cfg_attr(not(any(target_os = "macos", test)), allow(dead_code))]
pub(crate) fn bundle_of(exe: &std::path::Path) -> Option<std::path::PathBuf> {
    let macos = exe.parent()?;
    let contents = macos.parent()?;
    let bundle = contents.parent()?;
    (macos.file_name()? == "MacOS" && contents.file_name()? == "Contents" && bundle.extension()? == "app")
        .then(|| bundle.to_path_buf())
}

#[cfg(target_os = "macos")]
fn bundle_of_current_exe() -> Option<std::path::PathBuf> {
    std::env::current_exe().ok().and_then(|exe| bundle_of(&exe))
}

/// The detached helper's shell script. `$1` is our pid and `$2` the bundle path, kept as
/// arguments and never spliced into the script, so any characters in the path are safe. It
/// waits (up to a minute) for the process to go, treating a zombie as gone, then opens the
/// bundle with **no** `-n`. If the process somehow outlives the wait it exits without
/// opening, so a restart that never happens cannot spawn a second instance.
#[cfg_attr(not(any(target_os = "macos", test)), allow(dead_code))]
const LAUNCH_SCRIPT: &str = r#"pid="$1"
bundle="$2"
i=0
while kill -0 "$pid" 2>/dev/null; do
  /bin/ps -o stat= -p "$pid" 2>/dev/null | /usr/bin/grep -q '^ *Z' && break
  i=$((i + 1))
  if [ "$i" -gt 600 ]; then exit 0; fi
  /bin/sleep 0.1
done
/bin/sleep 0.2
exec /usr/bin/open "$bundle"
"#;

/// Spawns the helper that reopens the bundle once this process has exited. Called from the
/// `RunEvent::Exit` handler of a requested restart.
#[cfg(target_os = "macos")]
pub(crate) fn relaunch_after_exit() -> std::io::Result<()> {
    use std::os::unix::process::CommandExt;

    let bundle = bundle_of_current_exe()
        .ok_or_else(|| std::io::Error::other("PandaCode is not running from an app bundle"))?;
    std::process::Command::new("/bin/sh")
        .arg("-c")
        .arg(LAUNCH_SCRIPT)
        .arg("pandacode-restart")
        .arg(std::process::id().to_string())
        .arg(&bundle)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        // Its own process group and no inherited stdio: it must outlive us, and a write
        // once our pipes are gone would otherwise abort it.
        .process_group(0)
        .spawn()
        .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn an_app_bundle_is_found_from_its_executable() {
        assert_eq!(
            bundle_of(Path::new("/Applications/PandaCode.app/Contents/MacOS/pandacode")),
            Some("/Applications/PandaCode.app".into())
        );
    }

    #[test]
    fn anything_that_is_not_an_app_bundle_is_left_alone() {
        assert_eq!(bundle_of(Path::new("/usr/bin/pandacode")), None);
        assert_eq!(bundle_of(Path::new("/Applications/PandaCode/Contents/MacOS/pandacode")), None);
        assert_eq!(bundle_of(Path::new("/Applications/PandaCode.app/MacOS/pandacode")), None);
        assert_eq!(bundle_of(Path::new("/Applications/PandaCode.app/Contents/pandacode")), None);
        assert_eq!(bundle_of(Path::new("PandaCode.app")), None);
    }

    #[test]
    fn the_helper_opens_without_forcing_a_new_instance() {
        assert!(LAUNCH_SCRIPT.contains(r#"exec /usr/bin/open "$bundle""#));
        assert!(!LAUNCH_SCRIPT.contains("open -n"), "a forced new instance is what left the duplicate Dock icon");
        // The bundle path is passed as an argument, never spliced into the script.
        assert!(!LAUNCH_SCRIPT.contains("/Applications"));
    }
}
