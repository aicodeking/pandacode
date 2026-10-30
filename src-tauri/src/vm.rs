//! Local virtual machines for agents: macOS and Linux guests behind a `VmBackend` (Tart on
//! Apple's Virtualization framework), driven over VNC for computer use.
//!
//! Memory first: VMs run headless (the framework's own VNC server, no window), Linux
//! guests start at 2 GB, clones share disk blocks with their image, and a VM nobody has
//! used for `IDLE` is suspended (macOS, resumes in seconds) or stopped (Linux, boots fast).
pub mod backend;
pub mod commands;
pub mod desktop;
pub mod rfb;
pub mod screen;
pub mod setup;
mod tart;
pub mod tools;
mod vnc_auth;

use serde::Serialize;
use std::{
    collections::HashMap,
    net::SocketAddr,
    path::Path,
    process::Child,
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};

pub use backend::backend;
use backend::{Started, VmBackend};
use rfb::Rfb;
#[cfg(test)]
pub use tart::parse_vnc_url;

pub const IDLE: Duration = Duration::from_secs(10 * 60);
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

/// VM names PandaCode creates: lowercase letters, digits and dashes.
pub fn valid_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 64 && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') && !name.starts_with('-')
}

struct Session {
    child: Option<Child>,
    password: Option<String>,
    address: SocketAddr,
    macos: bool,
    used: Instant,
    rfb: Option<Rfb>,
}

/// Waits for the process holding a stopped VM up, if its backend keeps one.
fn reap(session: Option<Session>) {
    if let Some(mut child) = session.and_then(|session| session.child) {
        let _ = child.wait();
    }
}

pub struct Vms {
    backend: &'static dyn VmBackend,
    sessions: Mutex<HashMap<String, Session>>,
    shown: Mutex<Option<String>>,
    desktops: Mutex<HashMap<String, desktop::State>>,
}
impl Default for Vms {
    fn default() -> Self {
        Self { backend: backend(), sessions: Mutex::default(), shown: Mutex::default(), desktops: Mutex::default() }
    }
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
        let vms = self.backend.list()?;
        Ok(vms.into_iter().map(|vm| {
            let details = self.backend.details(&vm.name).ok();
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
        let image = self.backend.image(image_id)?;
        if !valid_name(name) {
            return Err("VM names use lowercase letters, digits and dashes.".into());
        }
        if self.backend.list()?.iter().any(|vm| vm.name == name) {
            return Err(format!("A VM named {name} already exists."));
        }
        self.backend.create(&image, name)?;
        Ok(VmStatus { name: name.into(), running: false, attached: false, os: image.os.into(), memory_mb: image.memory_mb, cpus: image.cpus, size_gb: image.download_gb as u64, desktop: None, desktop_error: None })
    }

    /// Boot headless and wait for its VNC server. A VM started elsewhere must be stopped first.
    pub fn start(&self, name: &str, share: Option<&Path>) -> Result<(), String> {
        if self.attached(name) {
            return Ok(());
        }
        let listed = self.backend.list()?;
        let vm = listed.iter().find(|vm| vm.name == name).ok_or_else(|| format!("No VM named {name}."))?;
        if vm.running {
            return Err(format!("{name} is running outside PandaCode. Stop it there, then start it here to see its screen."));
        }
        let Started { child, password, address, macos } = self.backend.start(name, share)?;
        self.lock()?.insert(name.into(), Session { child, password, address, macos, used: Instant::now(), rfb: None });
        Ok(())
    }

    pub fn stop(&self, name: &str) -> Result<(), String> {
        let session = self.lock()?.remove(name);
        let result = self.backend.stop(name);
        reap(session);
        result
    }
    pub fn suspend(&self, name: &str) -> Result<(), String> {
        if !self.backend.can_suspend(self.is_macos(name)?) {
            return Err("Only macOS VMs can be suspended. Stop a Linux VM instead; it boots in seconds.".into());
        }
        let session = self.lock()?.remove(name);
        let result = self.backend.suspend(name);
        reap(session);
        result
    }
    pub fn delete(&self, name: &str) -> Result<(), String> {
        if self.backend.list()?.iter().any(|vm| vm.name == name && vm.running) {
            self.stop(name)?;
        }
        if self.shown().as_deref() == Some(name) {
            self.show(None);
        }
        self.backend.delete(name)
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
        Ok(self.backend.details(name)?.os == "darwin")
    }

    /// Suspend or stop VMs nobody has used for `idle`. Returns the names it released.
    /// A VM installing its desktop is busy even though `used` is stale; only quit (zero idle) stops it.
    pub fn release_idle(&self, idle: Duration) -> Vec<String> {
        let stale: Vec<(String, bool)> = self.lock().map(|sessions| sessions.iter().filter(|(name, s)| s.used.elapsed() >= idle && (idle.is_zero() || self.desktop_state(name) != Some(desktop::State::Installing))).map(|(name, s)| (name.clone(), s.macos)).collect()).unwrap_or_default();
        stale.into_iter().filter_map(|(name, macos)| {
            let released = if self.backend.can_suspend(macos) { self.suspend(&name) } else { self.stop(&name) };
            released.ok().map(|_| name)
        }).collect()
    }
    /// On quit, VMs PandaCode started are suspended or stopped so they free their memory.
    pub fn shutdown(&self) {
        self.release_idle(Duration::ZERO);
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
    use backend::{Details, Exec, Vm};

    #[derive(Default)]
    struct Fake(Mutex<Vec<String>>);
    impl Fake {
        fn call(&self, what: &str, name: &str) -> Result<(), String> {
            self.0.lock().unwrap().push(format!("{what} {name}"));
            Ok(())
        }
    }
    impl VmBackend for Fake {
        fn supported(&self) -> bool { true }
        fn installed(&self) -> bool { true }
        fn has_vms(&self) -> bool { true }
        fn engine(&self, _: bool) -> &'static str { "" }
        fn exec_hint(&self) -> &'static str { "" }
        fn images(&self) -> &'static [Image] { &[] }
        fn list(&self) -> Result<Vec<Vm>, String> { Ok(Vec::new()) }
        fn details(&self, _: &str) -> Result<Details, String> { Err("no details".into()) }
        fn create(&self, _: &Image, _: &str) -> Result<(), String> { Ok(()) }
        fn start(&self, _: &str, _: Option<&Path>) -> Result<Started, String> { Err("no start".into()) }
        fn stop(&self, name: &str) -> Result<(), String> { self.call("stop", name) }
        fn can_suspend(&self, macos: bool) -> bool { macos }
        fn suspend(&self, name: &str) -> Result<(), String> { self.call("suspend", name) }
        fn delete(&self, _: &str) -> Result<(), String> { Ok(()) }
        fn exec(&self, _: &str, _: bool, _: &str, _: Duration) -> Result<Exec, String> { Err("no exec".into()) }
    }
    fn session(macos: bool) -> Session {
        Session { child: None, password: None, address: "127.0.0.1:5900".parse().unwrap(), macos, used: Instant::now(), rfb: None }
    }

    #[test]
    fn names_are_safe() {
        assert!(valid_name("pandacode-ubuntu-2") && !valid_name("Ubuntu") && !valid_name("-x") && !valid_name("a b") && !valid_name(""));
    }
    #[test]
    fn releases_idle_vms_by_suspending_what_the_backend_can() {
        let fake: &'static Fake = Box::leak(Box::default());
        let vms = Vms { backend: fake, ..Vms::default() };
        vms.lock().unwrap().extend([("mac".to_string(), session(true)), ("linux".to_string(), session(false))]);
        assert_eq!(vms.suspend("linux").unwrap_err(), "Only macOS VMs can be suspended. Stop a Linux VM instead; it boots in seconds.");
        let mut released = vms.release_idle(Duration::ZERO);
        released.sort();
        assert_eq!(released, ["linux", "mac"]);
        let mut calls = fake.0.lock().unwrap().clone();
        calls.sort();
        assert_eq!(calls, ["stop linux", "suspend mac"]);
        assert!(!vms.attached("mac") && !vms.attached("linux"));
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
        let out = backend().exec(&name, false, "uptime -p", Duration::from_secs(60)).unwrap();
        assert_eq!(out.code, Some(0), "{}", out.stderr);
        assert!(vms.list().unwrap().iter().any(|vm| vm.name == name && vm.running && vm.attached));
        // Not idle yet, then released when the idle limit passes.
        assert!(vms.release_idle(Duration::from_secs(600)).is_empty());
        assert_eq!(vms.release_idle(Duration::ZERO), vec![name.clone()]);
        assert!(!vms.attached(&name));
        assert!(backend().list().unwrap().iter().any(|vm| vm.name == name && !vm.running));
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
