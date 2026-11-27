//! Token saver: detects optional local tools the per-thread saver can lean on.
//! The saver itself is prompt guidance assembled by the window; nothing here runs an agent.
use serde::Serialize;
use std::{path::{Path, PathBuf}, process::Command, sync::atomic::{AtomicBool, Ordering}, time::Duration};

use crate::workspace::{checked, run_process};

static INSTALLING: AtomicBool = AtomicBool::new(false);

pub const RTK_INSTALL: &str = "brew install rtk";
pub const PXPIPE_INSTALL: &str = "npm install -g pxpipe-proxy";

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Tools {
    /// RTK (Rust Token Killer) compresses command output before agents read it.
    pub rtk: bool,
    pub rtk_version: String,
    pub rtk_install: String,
    /// pxpipe renders bulky text to dense PNG pages for models that read images well.
    pub pxpipe: bool,
    pub pxpipe_version: String,
    pub pxpipe_install: String,
    /// The detected pxpipe executable, so guidance can name it even when an agent's
    /// PATH differs from the app's.
    pub pxpipe_bin: String,
}

/// A CLI from the user's PATH or a standard Homebrew prefix; GUI launches miss shell PATHs.
pub fn find_tool(name: &str) -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|path| std::env::split_paths(&path).collect()).unwrap_or_default();
    dirs.extend(["/opt/homebrew/bin", "/usr/local/bin"].map(PathBuf::from));
    if let Some(home) = std::env::var_os("HOME") {
        dirs.extend([".local/bin", ".cargo/bin"].map(|dir| Path::new(&home).join(dir)));
    }
    let file = if cfg!(windows) { format!("{name}.exe") } else { name.to_string() };
    dirs.into_iter().map(|dir| dir.join(&file)).find(|path| path.is_file())
}

/// `rtk 0.37.1` → `0.37.1`; `pxpipe --version` prints a bare `0.16.0`. Anything else
/// stays as printed.
pub fn version_line(output: &str) -> String {
    let line = output.lines().next().unwrap_or_default().trim();
    line.split_whitespace().last().unwrap_or(line).to_string()
}

fn detect() -> Tools {
    let mut tools = Tools {
        rtk_install: RTK_INSTALL.into(),
        pxpipe_install: PXPIPE_INSTALL.into(),
        ..Default::default()
    };
    if let Some(path) = find_tool("rtk") {
        let mut command = Command::new(path);
        command.arg("--version");
        if let Ok(output) = run_process(command, "rtk", 4096, Duration::from_secs(5)) {
            tools.rtk = output.status.success();
            tools.rtk_version = version_line(&String::from_utf8_lossy(&output.stdout.bytes));
        }
    }
    if let Some(path) = find_tool("pxpipe") {
        let mut command = Command::new(&path);
        command.arg("--version");
        if let Ok(output) = run_process(command, "pxpipe", 4096, Duration::from_secs(8)) {
            tools.pxpipe = output.status.success();
            tools.pxpipe_version = version_line(&String::from_utf8_lossy(&output.stdout.bytes));
            if tools.pxpipe {
                tools.pxpipe_bin = path.to_string_lossy().into_owned();
            }
        }
    }
    tools
}

/// Install a tool a saver pack needs. Only RTK through Homebrew and pxpipe through npm,
/// one at a time.
#[tauri::command]
pub async fn token_saver_install(tool: String) -> crate::Result<Tools> {
    if tool != "rtk" && tool != "pxpipe" {
        return Err("Unknown tool.".into());
    }
    if INSTALLING.swap(true, Ordering::SeqCst) {
        return Err("A token-saver tool is already being installed.".into());
    }
    let result = crate::blocking(move || {
        let found = detect();
        match tool.as_str() {
            "rtk" => {
                if found.rtk {
                    return Ok(found);
                }
                let brew = find_tool("brew").ok_or_else(|| format!("Homebrew is needed to install RTK. Install Homebrew from brew.sh, or run `{RTK_INSTALL}` another way."))?;
                let mut command = Command::new(brew);
                command
                    .args(["install", "rtk"])
                    .env("HOMEBREW_NO_AUTO_UPDATE", "1")
                    .env("HOMEBREW_NO_INSTALL_CLEANUP", "1")
                    .env("HOMEBREW_NO_ENV_HINTS", "1")
                    .env("NONINTERACTIVE", "1");
                checked(run_process(command, "Homebrew", 1024 * 1024, Duration::from_secs(600))?)
                    .map_err(|error| format!("Could not install RTK: {}", error.lines().last().unwrap_or(&error)))?;
                let tools = detect();
                if !tools.rtk {
                    return Err("Homebrew finished, but rtk was not found afterwards.".into());
                }
                Ok(tools)
            }
            _ => {
                if found.pxpipe {
                    return Ok(found);
                }
                let npm = find_tool("npm").ok_or_else(|| format!("Node.js and npm are needed to install pxpipe. Install Node.js, or run `{PXPIPE_INSTALL}` another way."))?;
                let mut command = Command::new(npm);
                command
                    .args(["install", "--global", "pxpipe-proxy"])
                    .env("npm_config_yes", "true")
                    .env("npm_config_update_notifier", "false")
                    .env("npm_config_fund", "false")
                    .env("NONINTERACTIVE", "1");
                checked(run_process(command, "npm", 1024 * 1024, Duration::from_secs(600))?)
                    .map_err(|error| format!("Could not install pxpipe: {}", error.lines().last().unwrap_or(&error)))?;
                let tools = detect();
                if !tools.pxpipe {
                    return Err("npm finished, but pxpipe was not found afterwards. Check that your npm global bin is on PATH.".into());
                }
                Ok(tools)
            }
        }
    })
    .await;
    INSTALLING.store(false, Ordering::SeqCst);
    result
}

#[tauri::command]
pub async fn token_saver_tools() -> crate::Result<Tools> {
    crate::blocking(|| Ok(detect())).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_are_read_from_the_first_line() {
        assert_eq!(version_line("rtk 0.37.1\nmore"), "0.37.1");
        assert_eq!(version_line("0.16.0\n"), "0.16.0");
        assert_eq!(version_line(""), "");
    }

    #[test]
    fn only_known_tools_install_and_one_at_a_time() {
        let unknown = tauri::async_runtime::block_on(token_saver_install("curl".into())).unwrap_err();
        assert_eq!(unknown, "Unknown tool.");
        INSTALLING.store(true, Ordering::SeqCst);
        let busy = tauri::async_runtime::block_on(token_saver_install("pxpipe".into())).unwrap_err();
        assert!(busy.contains("already being installed"), "{busy}");
        INSTALLING.store(false, Ordering::SeqCst);
    }

}
