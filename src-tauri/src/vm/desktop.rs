//! Linux VMs get a desktop on their own: the Cirrus Labs images are console-only, so
//! whenever PandaCode starts a Linux VM without one, it installs a light Xfce desktop
//! with automatic login in the background. The panel streams the console meanwhile and
//! shows the progress; agents can use commands right away.
use std::{thread, time::{Duration, Instant}};
use tauri::{Emitter, Manager};

use super::{backend, Vms};

pub const SCRIPT: &str = include_str!("scripts/linux-desktop.sh");
/// PandaCode's desktop, or any display manager the user set up themselves.
const HAS_DESKTOP: &str = "test -f /etc/lightdm/lightdm.conf.d/50-pandacode.conf || systemctl is-active --quiet display-manager";
/// The guest agent answers a few seconds after boot.
const AGENT_WAIT: Duration = Duration::from_secs(120);

#[derive(Clone, Debug, PartialEq)]
pub enum State {
    Installing,
    Failed(String),
}

/// Ask the guest, retrying while its agent is still starting.
pub fn has_desktop(name: &str) -> Result<bool, String> {
    let deadline = Instant::now() + AGENT_WAIT;
    loop {
        match backend().exec(name, false, HAS_DESKTOP, Duration::from_secs(20)) {
            Ok(out) if out.code.is_some() => return Ok(out.code == Some(0)),
            Ok(_) | Err(_) if Instant::now() < deadline => thread::sleep(Duration::from_secs(3)),
            Ok(_) => return Err("The VM did not answer in time.".into()),
            Err(error) => return Err(error),
        }
    }
}

pub fn install(vms: &Vms, name: &str) -> Result<String, String> {
    if vms.is_macos(name)? {
        return Err("macOS VMs already have a desktop.".into());
    }
    vms.mark_used(name);
    let out = backend().exec(name, false, SCRIPT, Duration::from_secs(30 * 60))?;
    vms.mark_used(name);
    if out.code != Some(0) {
        return Err(format!("Installing the desktop failed: {}", out.stderr.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("unknown error")));
    }
    Ok(format!("{name} now has an Xfce desktop with automatic login. Take a screenshot in a few seconds."))
}

/// After a Linux VM starts: install a desktop if it has none. Runs once per VM at a time.
pub fn ensure_in_background(app: tauri::AppHandle, name: String) {
    let vms = app.state::<Vms>();
    if vms.is_macos(&name).unwrap_or(true) || !vms.begin_desktop(&name) {
        return;
    }
    let _ = app.emit("vm-changed", serde_json::json!({}));
    thread::spawn(move || {
        let vms = app.state::<Vms>();
        let result = has_desktop(&name).and_then(|present| if present { Ok(String::new()) } else { install(&vms, &name) });
        vms.end_desktop(&name, result.err());
        let _ = app.emit("vm-changed", serde_json::json!({}));
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installs_once_at_a_time_and_remembers_failures() {
        let vms = Vms::default();
        assert!(vms.begin_desktop("a"));
        assert!(!vms.begin_desktop("a"), "already installing");
        assert_eq!(vms.desktop_state("a"), Some(State::Installing));
        vms.end_desktop("a", Some("apt failed".into()));
        assert_eq!(vms.desktop_state("a"), Some(State::Failed("apt failed".into())));
        assert!(vms.begin_desktop("a"), "a failed install can be retried");
        vms.end_desktop("a", None);
        assert_eq!(vms.desktop_state("a"), None);
    }

    #[test]
    fn the_check_accepts_any_display_manager() {
        assert!(HAS_DESKTOP.contains("50-pandacode.conf") && HAS_DESKTOP.contains("display-manager"));
        assert!(SCRIPT.contains("autologin-user"));
    }
}

#[cfg(test)]
mod live {
    use super::*;

    /// A fresh Ubuntu VM gets its desktop: `cargo test --lib -- --ignored vm::desktop::live --nocapture`
    #[test]
    #[ignore]
    fn a_new_linux_vm_ends_up_with_a_desktop() {
        let vms = Vms::default();
        let name = "pandacode-desktop-check";
        let _ = vms.delete(name);
        vms.create("ubuntu", name).unwrap();
        vms.start(name, None).unwrap();
        assert!(!has_desktop(name).unwrap(), "console-only image");
        let started = Instant::now();
        install(&vms, name).unwrap();
        eprintln!("desktop installed in {:?}", started.elapsed());
        assert!(has_desktop(name).unwrap());
        thread::sleep(Duration::from_secs(8));
        let shot = vms.with_screen(name, true, |rfb| super::super::screen::screenshot(rfb, 80)).unwrap();
        std::fs::write(std::env::temp_dir().join("pandacode-desktop-check.jpg"), &shot.jpeg).unwrap();
        vms.delete(name).unwrap();
    }
}
