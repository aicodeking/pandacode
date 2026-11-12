//! One-click engine setup through `VmBackend::install`: Lima on Linux (`lima::install`), and Tart on a Mac: download the latest release from GitHub, check that Apple
//! notarized it and that Cirrus Labs signed it, and install it in ~/Applications.
//! Tart is under the Functional Source License; PandaCode fetches it, never bundles it.
use std::{
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

use crate::workspace::run_process;

/// Cirrus Labs' Developer ID team, which signs every Tart release.
const TEAM: &str = "9M2P8L4D89";
const RELEASE: &str = "https://github.com/cirruslabs/tart/releases/latest/download/tart.tar.gz";
static RUNNING: AtomicBool = AtomicBool::new(false);

fn run(program: &str, args: &[&str], what: &str, timeout: Duration) -> Result<String, String> {
    let mut command = Command::new(program);
    command.args(args);
    let out = run_process(command, what, 1 << 16, timeout)?;
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout.bytes), String::from_utf8_lossy(&out.stderr.bytes));
    if out.status.success() { Ok(text) } else { Err(format!("{what} failed: {}", text.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("unknown error"))) }
}

/// The signing team in `codesign -dv` output, if the bundle is signed.
pub fn team_of(codesign_output: &str) -> Option<&str> {
    codesign_output.lines().find_map(|line| line.strip_prefix("TeamIdentifier=")).map(str::trim)
}

fn verify(app: &Path) -> Result<(), String> {
    let path = app.to_string_lossy();
    run("/usr/bin/codesign", &["--verify", "--deep", "--strict", &path], "Signature check", Duration::from_secs(60))?;
    let details = run("/usr/bin/codesign", &["-dv", &path], "Signature check", Duration::from_secs(30))?;
    if team_of(&details) != Some(TEAM) {
        return Err("The downloaded Tart is not signed by Cirrus Labs. Nothing was installed.".into());
    }
    run("/usr/sbin/spctl", &["--assess", "--type", "execute", &path], "Notarization check", Duration::from_secs(60))
        .map_err(|_| "The downloaded Tart is not notarized by Apple. Nothing was installed.".to_string())?;
    Ok(())
}

pub(super) fn install() -> Result<PathBuf, String> {
    if !cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        return Err("Local VMs need a Mac with Apple silicon. Use a cloud sandbox instead.".into());
    }
    let home = std::env::var_os("HOME").map(PathBuf::from).ok_or("Your home folder is unknown.")?;
    let work = std::env::temp_dir().join(format!("pandacode-tart-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    let result = (|| {
        let archive = work.join("tart.tar.gz");
        run("/usr/bin/curl", &["-fsSL", "--proto", "=https", "--max-filesize", "200000000", "-o", &archive.to_string_lossy(), RELEASE], "Download", Duration::from_secs(600))?;
        run("/usr/bin/tar", &["-xzf", &archive.to_string_lossy(), "-C", &work.to_string_lossy()], "Unpacking", Duration::from_secs(120))?;
        let app = work.join("tart.app");
        verify(&app)?;
        let applications = home.join("Applications");
        std::fs::create_dir_all(&applications).map_err(|e| e.to_string())?;
        let target = applications.join("tart.app");
        if target.exists() {
            std::fs::remove_dir_all(&target).map_err(|e| format!("Could not replace the old Tart: {e}"))?;
        }
        // `ditto` keeps the bundle's signature and extended attributes intact.
        run("/usr/bin/ditto", &[&app.to_string_lossy(), &target.to_string_lossy()], "Install", Duration::from_secs(120))?;
        Ok(target.join("Contents/MacOS/tart"))
    })();
    let _ = std::fs::remove_dir_all(&work);
    result
}

#[tauri::command]
pub async fn vm_setup() -> crate::Result<String> {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return Err("VM setup is already running.".into());
    }
    let result = crate::blocking(|| super::backend().install()).await;
    RUNNING.store(false, Ordering::SeqCst);
    result.map(|path| path.display().to_string())
}

#[cfg(test)]
mod tests {
    #[test]
    fn reads_the_signing_team() {
        let output = "Executable=/x/tart\nIdentifier=com.github.cirruslabs.tart\nTeamIdentifier=9M2P8L4D89\n";
        assert_eq!(super::team_of(output), Some(super::TEAM));
        assert_eq!(super::team_of("TeamIdentifier=not set\n"), Some("not set"));
        assert_eq!(super::team_of("Executable=/x"), None);
    }
}
