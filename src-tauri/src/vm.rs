//! Local virtual machines for agents: macOS and Linux guests on Apple's Virtualization
//! framework through Tart, driven over VNC for computer use and `tart exec` for commands.
//!
//! Memory first: VMs run headless (the framework's own VNC server, no window), Linux
//! guests start at 2 GB, clones share disk blocks with their image, and a VM nobody has
//! used for `IDLE` is suspended (macOS, resumes in seconds) or stopped (Linux, boots fast).
pub mod commands;
pub mod desktop;
pub mod rfb;
pub mod screen;
pub mod setup;
pub mod tart;
pub mod tools;
mod vnc_auth;

use serde::Serialize;
use std::{
    collections::HashMap,
    io::{BufRead, BufReader},
    net::SocketAddr,
    path::Path,
    process::Child,
    sync::{mpsc, Mutex},
    thread,
    time::{Duration, Instant},
};

use rfb::Rfb;

pub const IDLE: Duration = Duration::from_secs(10 * 60);
const BOOT: Duration = Duration::from_secs(90);
const CONNECT: Duration = Duration::from_secs(5);

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Image {
    pub id: &'static str,
    pub name: &'static str,
    pub os: &'static str,
    pub source: &'static str,
    pub download_gb: u32,
    pub memory_mb: u64,
    pub cpus: u64,
}
/// Cirrus Labs images ship the Tart Guest Agent, so commands work without SSH.
pub const IMAGES: [Image; 5] = [
    Image { id: "ubuntu", name: "Ubuntu 24.04", os: "linux", source: "ghcr.io/cirruslabs/ubuntu:latest", download_gb: 5, memory_mb: 2048, cpus: 2 },
    Image { id: "debian", name: "Debian", os: "linux", source: "ghcr.io/cirruslabs/debian:latest", download_gb: 4, memory_mb: 2048, cpus: 2 },
    Image { id: "fedora", name: "Fedora", os: "linux", source: "ghcr.io/cirruslabs/fedora:latest", download_gb: 5, memory_mb: 2048, cpus: 2 },
    Image { id: "macos-tahoe", name: "macOS Tahoe", os: "darwin", source: "ghcr.io/cirruslabs/macos-tahoe-base:latest", download_gb: 30, memory_mb: 4096, cpus: 4 },
    Image { id: "macos-sequoia", name: "macOS Sequoia", os: "darwin", source: "ghcr.io/cirruslabs/macos-sequoia-base:latest", download_gb: 28, memory_mb: 4096, cpus: 4 },
];
pub fn image(id: &str) -> Result<Image, String> {
    IMAGES.iter().copied().find(|image| image.id == id).ok_or_else(|| format!("Unknown VM image {id:?}."))
}

/// Parse Tart's `vnc://:password@127.0.0.1:port` into a password and a loopback address.
pub fn parse_vnc_url(url: &str) -> Result<(Option<String>, SocketAddr), String> {
    let rest = url.trim().strip_prefix("vnc://").ok_or("Not a VNC URL.")?;
    let (credentials, host) = rest.rsplit_once('@').map_or((None, rest), |(c, h)| (Some(c), h));
    let password = credentials.and_then(|c| c.split_once(':').map(|(_, p)| p.to_string())).filter(|p| !p.is_empty());
    let address: SocketAddr = host.trim_end_matches('/').parse().map_err(|_| "The VNC address is not host:port.")?;
    if !address.ip().is_loopback() {
        return Err("PandaCode only connects to VM screens on this Mac.".into());
    }
    Ok((password, address))
}
/// VM names PandaCode creates: lowercase letters, digits and dashes.
pub fn valid_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 64 && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') && !name.starts_with('-')
}

struct Session {
    child: Child,
    password: Option<String>,
    address: SocketAddr,
    macos: bool,
    used: Instant,
    rfb: Option<Rfb>,
}

#[derive(Default)]
pub struct Vms {
    sessions: Mutex<HashMap<String, Session>>,
    shown: Mutex<Option<String>>,
    desktops: Mutex<HashMap<String, desktop::State>>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VmStatus {
    pub name: String,
    pub running: bool,
    /// Started by PandaCode, so its screen and idle handling are available.
    pub attached: bool,
    pub os: String,
    pub memory_mb: u64,
    pub cpus: u64,
    pub size_gb: u64,
    /// `installing` while PandaCode adds a desktop, `failed` if that did not work.
    pub desktop: Option<&'static str>,
    pub desktop_error: Option<String>,
}

impl Vms {
    /// Mark a desktop install as started; false if one is already running.
    pub fn begin_desktop(&self, name: &str) -> bool {
        let Ok(mut desktops) = self.desktops.lock() else { return false };
        if desktops.get(name) == Some(&desktop::State::Installing) {
            return false;
        }
        desktops.insert(name.to_string(), desktop::State::Installing);
        true
    }
    pub fn end_desktop(&self, name: &str, error: Option<String>) {
        if let Ok(mut desktops) = self.desktops.lock() {
            match error {
                Some(error) => { desktops.insert(name.to_string(), desktop::State::Failed(error)); }
                None => { desktops.remove(name); }
            }
        }
    }
    pub fn desktop_state(&self, name: &str) -> Option<desktop::State> {
        self.desktops.lock().ok().and_then(|desktops| desktops.get(name).cloned())
    }
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, HashMap<String, Session>>, String> {
        self.sessions.lock().map_err(|_| "VM state is unavailable.".to_string())
    }
    pub fn shown(&self) -> Option<String> {
        self.shown.lock().ok().and_then(|shown| shown.clone())
    }
    pub fn show(&self, name: Option<String>) {
        if let Ok(mut shown) = self.shown.lock() {
            *shown = name;
        }
    }
    pub fn attached(&self, name: &str) -> bool {
        self.lock().is_ok_and(|sessions| sessions.contains_key(name))
    }

    pub fn list(&self) -> Result<Vec<VmStatus>, String> {
        let vms = tart::list()?;
        Ok(vms.into_iter().map(|vm| {
            let details = tart::details(&vm.name).ok();
            let desktop = self.desktop_state(&vm.name);
            VmStatus {
                desktop: match desktop { Some(desktop::State::Installing) => Some("installing"), Some(desktop::State::Failed(_)) => Some("failed"), None => None },
                desktop_error: match desktop { Some(desktop::State::Failed(error)) => Some(error), _ => None },
                attached: vm.running && self.attached(&vm.name),
                running: vm.running,
                os: details.as_ref().map_or_else(|| "linux".into(), |d| d.os.clone()),
                memory_mb: details.as_ref().map_or(0, |d| d.memory_mb),
                cpus: details.as_ref().map_or(0, |d| d.cpus),
                size_gb: vm.size_gb,
                name: vm.name,
            }
        }).collect())
    }

    /// The named VM, else the one PandaCode shows, else the only running one.
    pub fn resolve(&self, name: Option<&str>) -> Result<String, String> {
        if let Some(name) = name.filter(|n| !n.is_empty()) {
            return Ok(name.to_string());
        }
        if let Some(shown) = self.shown() {
            return Ok(shown);
        }
        let sessions = self.lock()?;
        match sessions.keys().collect::<Vec<_>>().as_slice() {
            [only] => Ok((*only).clone()),
            [] => Err("No VM is running. Start one with vm_manage, or list them with vm_list.".into()),
            _ => Err("Several VMs are running; name one.".into()),
        }
    }

    /// Clone an image into a new VM sized for memory: Linux 2 GB, macOS 4 GB.
    pub fn create(&self, image_id: &str, name: &str) -> Result<VmStatus, String> {
        let image = image(image_id)?;
        if !valid_name(name) {
            return Err("VM names use lowercase letters, digits and dashes.".into());
        }
        if tart::list()?.iter().any(|vm| vm.name == name) {
            return Err(format!("A VM named {name} already exists."));
        }
        tart::clone(image.source, name)?;
        tart::configure(name, image.memory_mb, image.cpus)?;
        Ok(VmStatus { name: name.into(), running: false, attached: false, os: image.os.into(), memory_mb: image.memory_mb, cpus: image.cpus, size_gb: image.download_gb as u64, desktop: None, desktop_error: None })
    }

    /// Boot headless and wait for its VNC server. A VM started elsewhere must be stopped first.
    pub fn start(&self, name: &str, share: Option<&Path>) -> Result<(), String> {
        if self.attached(name) {
            return Ok(());
        }
        let listed = tart::list()?;
        let vm = listed.iter().find(|vm| vm.name == name).ok_or_else(|| format!("No VM named {name}."))?;
        if vm.running {
            return Err(format!("{name} is running outside PandaCode. Stop it there, then start it here to see its screen."));
        }
        let macos = tart::details(name)?.os == "darwin";
        let mut child = tart::spawn_run(&tart::run_arguments(name, macos, share))?;
        let url = wait_for_vnc(&mut child, BOOT).inspect_err(|_| {
            let _ = child.kill();
        })?;
        let (password, address) = parse_vnc_url(&url)?;
        self.lock()?.insert(name.into(), Session { child, password, address, macos, used: Instant::now(), rfb: None });
        Ok(())
    }

    pub fn stop(&self, name: &str) -> Result<(), String> {
        let session = self.lock()?.remove(name);
        let result = tart::stop(name);
        if let Some(mut session) = session {
            let _ = session.child.wait();
        }
        result
    }
    pub fn suspend(&self, name: &str) -> Result<(), String> {
        let macos = match self.lock()?.get(name) { Some(session) => session.macos, None => tart::details(name)?.os == "darwin" };
        if !macos {
            return Err("Only macOS VMs can be suspended. Stop a Linux VM instead; it boots in seconds.".into());
        }
        let session = self.lock()?.remove(name);
        let result = tart::suspend(name);
        if let Some(mut session) = session {
            let _ = session.child.wait();
        }
        result
    }
    pub fn delete(&self, name: &str) -> Result<(), String> {
        if tart::list()?.iter().any(|vm| vm.name == name && vm.running) {
            self.stop(name)?;
        }
        if self.shown().as_deref() == Some(name) {
            self.show(None);
        }
        tart::delete(name)
    }

    /// Use the VM's screen, reconnecting once if the connection dropped. `used` marks
    /// agent or user activity; the panel merely watching does not keep a VM awake.
    pub fn with_screen<T>(&self, name: &str, used: bool, mut action: impl FnMut(&mut Rfb) -> Result<T, String>) -> Result<T, String> {
        let mut sessions = self.lock()?;
        let session = sessions.get_mut(name).ok_or_else(|| format!("{name} is not running in PandaCode. Start it with vm_manage first."))?;
        if used {
            session.used = Instant::now();
        }
        for attempt in 0..2 {
            if session.rfb.is_none() {
                session.rfb = Some(Rfb::connect(session.address, session.password.as_deref(), CONNECT)?);
            }
            let rfb = session.rfb.as_mut().expect("connected above");
            match action(rfb) {
                Ok(value) => return Ok(value),
                Err(error) if attempt == 0 && error.starts_with("VNC connection failed") => session.rfb = None,
                Err(error) => return Err(error),
            }
        }
        unreachable!("the second attempt returns")
    }
    /// Commands count as use, so a VM an agent is working in is not released.
    pub fn mark_used(&self, name: &str) {
        if let Ok(mut sessions) = self.lock() {
            if let Some(session) = sessions.get_mut(name) {
                session.used = Instant::now();
            }
        }
    }
    pub fn is_macos(&self, name: &str) -> Result<bool, String> {
        if let Some(session) = self.lock()?.get(name) {
            return Ok(session.macos);
        }
        Ok(tart::details(name)?.os == "darwin")
    }

    /// Suspend or stop VMs nobody has used for `idle`. Returns the names it released.
    /// A VM whose desktop is still installing is busy even though nothing marks it used.
    pub fn release_idle(&self, idle: Duration) -> Vec<String> {
        self.release(idle, true)
    }
    fn release(&self, idle: Duration, spare_installing: bool) -> Vec<String> {
        let stale: Vec<(String, bool)> = self.lock().map(|sessions| sessions.iter().filter(|(_, s)| s.used.elapsed() >= idle).map(|(name, s)| (name.clone(), s.macos)).collect()).unwrap_or_default();
        stale.into_iter().filter(|(name, _)| !(spare_installing && self.desktop_state(name) == Some(desktop::State::Installing))).filter_map(|(name, macos)| {
            let released = if macos { self.suspend(&name) } else { self.stop(&name) };
            released.ok().map(|_| name)
        }).collect()
    }
    /// On quit, VMs PandaCode started are suspended or stopped so they free their memory.
    pub fn shutdown(&self) {
        self.release(Duration::ZERO, false);
    }
}
/// Read `tart run` output until it prints the VNC URL; keep draining afterwards.
fn wait_for_vnc(child: &mut Child, timeout: Duration) -> Result<String, String> {
    let stdout = child.stdout.take().ok_or("The VM's output is unavailable.")?;
    let stderr = child.stderr.take().ok_or("The VM's output is unavailable.")?;
    let (tx, rx) = mpsc::channel::<String>();
    for reader in [Box::new(stdout) as Box<dyn std::io::Read + Send>, Box::new(stderr)] {
        let tx = tx.clone();
        thread::spawn(move || {
            for line in BufReader::new(reader).lines().map_while(Result::ok) {
                let _ = tx.send(line);
            }
        });
    }
    drop(tx);
    let deadline = Instant::now() + timeout;
    let mut last = String::new();
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        match rx.recv_timeout(left) {
            Ok(line) => {
                if let Some(start) = line.find("vnc://") {
                    return Ok(line[start..].split_whitespace().next().unwrap_or_default().to_string());
                }
                if !line.trim().is_empty() {
                    last = line;
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => return Err("The VM did not start within 90 seconds.".into()),
            Err(mpsc::RecvTimeoutError::Disconnected) => return Err(if last.is_empty() { "The VM stopped while starting.".into() } else { format!("The VM could not start: {last}") }),
        }
    }
}

/// Checks idle VMs every minute for the life of the app.
pub fn watch_idle(app: tauri::AppHandle) {
    use tauri::{Emitter, Manager};
    thread::spawn(move || loop {
        thread::sleep(Duration::from_secs(60));
        let released = app.state::<Vms>().release_idle(IDLE);
        if !released.is_empty() {
            let _ = app.emit("vm-changed", released);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_vm_installing_its_desktop_is_not_released_as_idle() {
        let vms = Vms::default();
        assert!(vms.begin_desktop("vm"));
        assert_eq!(vms.desktop_state("vm"), Some(desktop::State::Installing));
        // No session exists, so nothing is stopped; the install state must survive a sweep.
        assert!(vms.release_idle(Duration::ZERO).is_empty());
        assert_eq!(vms.desktop_state("vm"), Some(desktop::State::Installing));
    }

    #[test]
    fn parses_tarts_vnc_url_and_keeps_it_local() {
        let (password, address) = parse_vnc_url("vnc://:august-symptom-bulb-panda@127.0.0.1:64282").unwrap();
        assert_eq!(password.as_deref(), Some("august-symptom-bulb-panda"));
        assert_eq!(address.port(), 64282);
        assert_eq!(parse_vnc_url("vnc://127.0.0.1:5900").unwrap().0, None);
        assert!(parse_vnc_url("vnc://:x@10.0.0.2:5900").is_err());
        assert!(parse_vnc_url("http://127.0.0.1:1").is_err());
    }
    #[test]
    fn images_are_memory_conscious_and_names_are_safe() {
        assert!(IMAGES.iter().filter(|i| i.os == "linux").all(|i| i.memory_mb <= 2048));
        assert!(IMAGES.iter().all(|i| i.source.starts_with("ghcr.io/cirruslabs/")));
        assert!(image("ubuntu").is_ok() && image("windows").is_err());
        assert!(valid_name("pandacode-ubuntu-2") && !valid_name("Ubuntu") && !valid_name("-x") && !valid_name("a b") && !valid_name(""));
    }
    #[cfg(unix)]
    #[test]
    fn reads_the_vnc_url_from_tart_output() {
        let mut child = std::process::Command::new("/bin/sh")
            .args(["-c", "echo booting; echo 'VNC server is running at vnc://:pw@127.0.0.1:5901'; sleep 5"])
            .stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).spawn().unwrap();
        assert_eq!(wait_for_vnc(&mut child, Duration::from_secs(5)).unwrap(), "vnc://:pw@127.0.0.1:5901");
        let _ = child.kill();
        let mut failed = std::process::Command::new("/bin/sh").args(["-c", "echo 'Error: no such VM' >&2"])
            .stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).spawn().unwrap();
        assert_eq!(wait_for_vnc(&mut failed, Duration::from_secs(5)).unwrap_err(), "The VM could not start: Error: no such VM");
    }
}

#[cfg(test)]
mod live {
    use super::*;

    /// The manager's whole life cycle on a stopped VM:
    /// `PANDACODE_VM=name cargo test --lib -- --ignored vm::live`
    #[test]
    #[ignore]
    fn starts_looks_runs_and_releases_an_idle_vm() {
        let name = std::env::var("PANDACODE_VM").unwrap();
        let vms = Vms::default();
        let started = Instant::now();
        vms.start(&name, None).unwrap();
        eprintln!("VNC ready after {:?}", started.elapsed());
        assert!(vms.attached(&name));
        assert_eq!(vms.resolve(None).unwrap(), name);
        let shot = vms.with_screen(&name, true, |rfb| screen::screenshot(rfb, 70)).unwrap();
        assert!(shot.width >= 640 && shot.jpeg.len() > 1000);
        let out = tart::exec(&name, false, "uptime -p", Duration::from_secs(60)).unwrap();
        assert_eq!(out.code, Some(0), "{}", out.stderr);
        assert!(vms.list().unwrap().iter().any(|vm| vm.name == name && vm.running && vm.attached));
        // Not idle yet, then released when the idle limit passes.
        assert!(vms.release_idle(Duration::from_secs(600)).is_empty());
        assert_eq!(vms.release_idle(Duration::ZERO), vec![name.clone()]);
        assert!(!vms.attached(&name));
        assert!(tart::list().unwrap().iter().any(|vm| vm.name == name && !vm.running));
    }
}

#[cfg(test)]
mod live_panel {
    use super::*;

    /// Polls frames the way the VM panel does: `PANDACODE_VM=name cargo test --lib -- --ignored vm::live_panel --nocapture`
    #[test]
    #[ignore]
    fn frames_keep_coming_like_the_panel_asks() {
        let name = std::env::var("PANDACODE_VM").unwrap();
        let vms = Vms::default();
        vms.start(&name, None).unwrap();
        let mut sizes = Vec::new();
        for round in 0..40 {
            let started = Instant::now();
            let shot = vms.with_screen(&name, false, |rfb| screen::screenshot(rfb, 70));
            eprintln!("frame {round}: {:?} in {:?}", shot.as_ref().map(|s| (s.width, s.height, s.jpeg.len())), started.elapsed());
            if let Ok(shot) = &shot { sizes.push(shot.jpeg.len()); std::fs::write(std::env::temp_dir().join("pandacode-panel.jpg"), &shot.jpeg).unwrap(); }
            std::thread::sleep(Duration::from_millis(220));
        }
        vms.stop(&name).unwrap();
        assert!(sizes.len() >= 35, "only {} frames", sizes.len());
    }
}
