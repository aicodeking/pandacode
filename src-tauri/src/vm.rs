//! Local virtual machines for agents behind a `VmBackend` (Tart on Apple's Virtualization
//! framework for macOS and Linux guests, Lima on QEMU and KVM for Linux guests on Linux),
//! driven over VNC for computer use.
//!
//! Memory first: VMs run headless (the engine's own VNC server, no window), Linux guests
//! start at 2 GB, and a VM nobody has used for `IDLE` is suspended (macOS, resumes in
//! seconds) or stopped (Linux, boots fast).
pub mod backend;
pub mod commands;
pub mod desktop;
pub mod rfb;
pub mod screen;
pub mod setup;
mod lima;
mod tart;
pub mod tools;
mod vnc_auth;

use serde::Serialize;
use std::{
    collections::HashMap,
    net::SocketAddr,
    path::{Path, PathBuf},
    process::Child,
    sync::{atomic::{AtomicUsize, Ordering::SeqCst}, mpsc, Arc, Mutex, MutexGuard, PoisonError},
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
/// Quit stops or suspends every VM at once and returns by this deadline: each engine call gets
/// what is left, a VM process still up then is killed, and an engine call that hangs anyway is
/// left behind. A Lima VM still up is adopted on the next launch.
const QUIT: Duration = Duration::from_secs(20);

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
/// Any name that reaches an engine's command line. Existing Tart VMs may use any name Tart
/// accepts, and cloud IDs pass through, so only what could be an option or break a line is refused.
pub fn check_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > 128 || name.starts_with('-') || name.chars().any(char::is_control) {
        return Err("Unknown VM.".into());
    }
    Ok(())
}
pub fn different_share(name: &str) -> String {
    format!("{name} is already running with a different shared folder. Stop it, then start it again.")
}

struct Session {
    child: Option<Child>,
    password: Option<String>,
    address: SocketAddr,
    macos: bool,
    share: Option<PathBuf>,
    used: Instant,
    /// Commands running in the guest; the idle watcher leaves a busy VM alone. Each `Busy`
    /// holds the counter of the session it raised, so one from an earlier session never counts here.
    busy: Arc<AtomicUsize>,
    /// The screen connection, under its own lock so VNC I/O never holds up other VMs.
    rfb: Arc<Mutex<Option<Rfb>>>,
}
impl Session {
    fn new(started: Started, share: Option<&Path>) -> Self {
        let Started { child, password, address, macos } = started;
        Session { child, password, address, macos, share: share.map(Path::to_path_buf), used: Instant::now(), busy: Arc::default(), rfb: Arc::default() }
    }
}

/// A lock that a panic elsewhere never makes unusable, so quit still stops every VM.
fn guard<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Waits for the process holding a stopped VM up, if its backend keeps one; with a deadline
/// (quit) only until then, and then kills it.
fn reap(session: Option<Session>, deadline: Option<Instant>) {
    let Some(mut child) = session.and_then(|session| session.child) else { return };
    if let Some(deadline) = deadline {
        while Instant::now() < deadline {
            if !matches!(child.try_wait(), Ok(None)) {
                return;
            }
            thread::sleep(Duration::from_millis(50));
        }
        let _ = child.kill();
    }
    let _ = child.wait();
}

pub struct Vms {
    backend: &'static dyn VmBackend,
    sessions: Mutex<HashMap<String, Session>>,
    shown: Mutex<Option<String>>,
    desktops: Mutex<HashMap<String, desktop::State>>,
    /// VMs being created, started, stopped or deleted, so a second call (the panel and an agent) refuses.
    claims: Mutex<HashMap<String, &'static str>>,
}
impl Default for Vms {
    fn default() -> Self {
        Self { backend: backend(), sessions: Mutex::default(), shown: Mutex::default(), desktops: Mutex::default(), claims: Mutex::default() }
    }
}

/// A claim held for the whole `create`: the engine lists the VM as stopped while its image downloads.
const CREATING: &str = "creating";
/// A claim held while a VM boots: the engine still lists it as stopped.
const STARTING: &str = "starting";

/// One create, start, stop or delete in flight; released however the call ends.
struct Claim<'a> {
    vms: &'a Vms,
    name: String,
}
impl Claim<'_> {
    /// Hand the claim to the next step without a moment unclaimed.
    fn now(&self, doing: &'static str) {
        guard(&self.vms.claims).insert(self.name.clone(), doing);
    }
}
impl Drop for Claim<'_> {
    fn drop(&mut self) {
        guard(&self.vms.claims).remove(&self.name);
    }
}
/// A command running in the guest; the VM counts as used until it ends.
pub struct Busy<'a> {
    vms: &'a Vms,
    name: String,
    count: Option<Arc<AtomicUsize>>,
}
impl Drop for Busy<'_> {
    fn drop(&mut self) {
        let Some(count) = &self.count else { return };
        count.fetch_sub(1, SeqCst);
        if let Some(session) = self.vms.lock().get_mut(&self.name).filter(|session| Arc::ptr_eq(&session.busy, count)) {
            session.used = Instant::now();
        }
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VmStatus {
    pub name: String,
    pub running: bool,
    /// Started by PandaCode, so its screen and idle handling are available.
    pub attached: bool,
    /// Still downloading its image: it cannot start or be deleted yet.
    pub creating: bool,
    /// Booting (the engine lists it as stopped until then): it cannot start or be deleted yet.
    pub starting: bool,
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
        let mut desktops = guard(&self.desktops);
        if desktops.get(name) == Some(&desktop::State::Installing) {
            return false;
        }
        desktops.insert(name.to_string(), desktop::State::Installing);
        true
    }
    pub fn end_desktop(&self, name: &str, error: Option<String>) {
        let mut desktops = guard(&self.desktops);
        match error {
            Some(error) => { desktops.insert(name.to_string(), desktop::State::Failed(error)); }
            None => { desktops.remove(name); }
        }
    }
    pub fn desktop_state(&self, name: &str) -> Option<desktop::State> {
        guard(&self.desktops).get(name).cloned()
    }
    fn lock(&self) -> MutexGuard<'_, HashMap<String, Session>> {
        guard(&self.sessions)
    }
    pub fn shown(&self) -> Option<String> {
        guard(&self.shown).clone()
    }
    pub fn show(&self, name: Option<String>) {
        *guard(&self.shown) = name;
    }
    pub fn attached(&self, name: &str) -> bool {
        self.lock().contains_key(name)
    }

    fn claim(&self, name: &str, doing: &'static str) -> Result<Claim<'_>, String> {
        check_name(name)?;
        let mut claims = guard(&self.claims);
        match claims.get(name) {
            Some(&CREATING) => return Err(format!("{name} is still being created.")),
            Some(what) => return Err(format!("{name} is already {what}.")),
            None => {}
        }
        claims.insert(name.to_string(), doing);
        Ok(Claim { vms: self, name: name.to_string() })
    }
    fn claimed(&self, name: &str, doing: &str) -> bool {
        guard(&self.claims).get(name) == Some(&doing)
    }
    /// Hold the VM awake while a command runs in it.
    pub fn busy(&self, name: &str) -> Busy<'_> {
        let count = self.lock().get_mut(name).map(|session| {
            session.busy.fetch_add(1, SeqCst);
            session.used = Instant::now();
            session.busy.clone()
        });
        Busy { vms: self, name: name.to_string(), count }
    }

    pub fn list(&self) -> Result<Vec<VmStatus>, String> {
        let vms = self.backend.list_details()?;
        Ok(vms.into_iter().map(|(vm, details)| {
            let desktop = self.desktop_state(&vm.name);
            VmStatus {
                desktop: match desktop { Some(desktop::State::Installing) => Some("installing"), Some(desktop::State::Failed(_)) => Some("failed"), None => None },
                desktop_error: match desktop { Some(desktop::State::Failed(error)) => Some(error), _ => None },
                attached: vm.running && self.attached(&vm.name),
                creating: self.claimed(&vm.name, CREATING),
                starting: self.claimed(&vm.name, STARTING),
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
            check_name(name)?;
            return Ok(name.to_string());
        }
        if let Some(shown) = self.shown() {
            return Ok(shown);
        }
        let sessions = self.lock();
        match sessions.keys().collect::<Vec<_>>().as_slice() {
            [only] => Ok((*only).clone()),
            [] => Err("No VM is running. Start one with vm_manage, or list them with vm_list.".into()),
            _ => Err("Several VMs are running; name one.".into()),
        }
    }

    /// Clone an image into a new VM sized for memory: Linux 2 GB, macOS 4 GB. The VM is
    /// claimed until the download ends, and a backend removes what a failed create left behind.
    /// The app always boots it straight after (`create_and_start`); tests create on its own.
    #[cfg(test)]
    pub fn create(&self, image_id: &str, name: &str) -> Result<VmStatus, String> {
        let (_claim, image) = self.create_claimed(image_id, name)?;
        Ok(VmStatus { name: name.into(), running: false, attached: false, creating: false, starting: false, os: image.os.into(), memory_mb: image.memory_mb, cpus: image.cpus, size_gb: image.download_gb as u64, desktop: None, desktop_error: None })
    }
    /// Create, show and boot a new VM under one claim, so it never lists as a stopped VM
    /// that could be started or deleted between the download and the boot.
    pub fn create_and_start(&self, image_id: &str, name: &str) -> Result<(), String> {
        let (claim, _) = self.create_claimed(image_id, name)?;
        self.show(Some(name.into()));
        claim.now(STARTING);
        self.start_claimed(name, None)
    }
    fn create_claimed(&self, image_id: &str, name: &str) -> Result<(Claim<'_>, Image), String> {
        let image = self.backend.image(image_id)?;
        if !valid_name(name) {
            return Err("VM names use lowercase letters, digits and dashes.".into());
        }
        let claim = self.claim(name, CREATING)?;
        if self.backend.list()?.iter().any(|vm| vm.name == name) {
            return Err(format!("A VM named {name} already exists."));
        }
        self.backend.create(&image, name)?;
        Ok((claim, image))
    }

    /// Boot headless and wait for its VNC server. A VM started elsewhere must be stopped first,
    /// unless the backend can adopt it. Without a process of its own a session can outlive its
    /// VM (a shutdown inside the guest), so only the backend's list can tell it is still up.
    /// A running VM keeps the share it started with.
    pub fn start(&self, name: &str, share: Option<&Path>) -> Result<(), String> {
        let _claim = self.claim(name, STARTING)?;
        self.start_claimed(name, share)
    }
    fn start_claimed(&self, name: &str, share: Option<&Path>) -> Result<(), String> {
        let attached = |same: bool| if same { Ok(()) } else { Err(different_share(name)) };
        let session = self.lock().get(name).map(|session| (session.child.is_some(), session.share.as_deref() == share));
        if let Some((true, same)) = session {
            return attached(same);
        }
        let listed = self.backend.list()?;
        let vm = listed.iter().find(|vm| vm.name == name).ok_or_else(|| format!("No VM named {name}."))?;
        if let Some((_, same)) = session {
            if vm.running {
                return attached(same);
            }
            self.lock().remove(name);
        }
        let started = if vm.running { self.backend.adopt(name, share)?.ok_or_else(|| format!("{name} is running outside PandaCode. Stop it there, then start it here to see its screen."))? } else { self.backend.start(name, share)? };
        self.lock().insert(name.into(), Session::new(started, share));
        Ok(())
    }

    pub fn stop(&self, name: &str) -> Result<(), String> {
        let _claim = self.claim(name, "stopping")?;
        self.stop_claimed(name, None)
    }
    fn stop_claimed(&self, name: &str, deadline: Option<Instant>) -> Result<(), String> {
        self.power_off(name, false, deadline)
    }
    pub fn suspend(&self, name: &str) -> Result<(), String> {
        let _claim = self.claim(name, "suspending")?;
        self.suspend_claimed(name, None)
    }
    fn suspend_claimed(&self, name: &str, deadline: Option<Instant>) -> Result<(), String> {
        if !self.backend.can_suspend(self.is_macos(name)?) {
            return Err("Only macOS VMs can be suspended. Stop a Linux VM instead; it boots in seconds.".into());
        }
        self.power_off(name, true, deadline)
    }
    /// Stop or suspend a claimed VM, then wait for its process. With a deadline (quit) the
    /// engine runs on a thread of its own, so one that hangs past it cannot hold quit up.
    fn power_off(&self, name: &str, suspend: bool, deadline: Option<Instant>) -> Result<(), String> {
        let session = self.lock().remove(name);
        let (backend, owned) = (self.backend, name.to_string());
        let run = move || {
            let result = match (suspend, deadline) {
                (true, Some(deadline)) => backend.suspend_by(&owned, deadline),
                (true, None) => backend.suspend(&owned),
                (false, Some(deadline)) => backend.stop_by(&owned, deadline),
                (false, None) => backend.stop(&owned),
            };
            reap(session, deadline);
            result
        };
        let Some(deadline) = deadline else { return run() };
        let (sender, receiver) = mpsc::channel();
        thread::spawn(move || sender.send(run()));
        receiver.recv_timeout(deadline.saturating_duration_since(Instant::now())).unwrap_or_else(|_| Err(format!("{name} did not stop in time.")))
    }
    pub fn delete(&self, name: &str) -> Result<(), String> {
        let _claim = self.claim(name, "deleting")?;
        if self.backend.list()?.iter().any(|vm| vm.name == name && vm.running) {
            self.stop_claimed(name, None)?;
        }
        if self.shown().as_deref() == Some(name) {
            self.show(None);
        }
        self.backend.delete(name)
    }

    /// Use the VM's screen, reconnecting once if the connection broke. `used` marks agent or
    /// user activity; the panel merely watching does not keep a VM awake. Only this VM's
    /// screen lock is held while VNC talks, so other VMs and the idle watcher never wait on it.
    pub fn with_screen<T>(&self, name: &str, used: bool, mut action: impl FnMut(&mut Rfb) -> Result<T, String>) -> Result<T, String> {
        check_name(name)?;
        let (address, password, screen) = {
            let mut sessions = self.lock();
            let session = sessions.get_mut(name).ok_or_else(|| format!("{name} is not running in PandaCode. Start it with vm_manage first."))?;
            if used {
                session.used = Instant::now();
            }
            (session.address, session.password.clone(), session.rfb.clone())
        };
        let mut rfb = guard(&screen);
        for attempt in 0..2 {
            if rfb.as_ref().is_some_and(Rfb::broken) {
                *rfb = None;
            }
            let connection = match rfb.as_mut() {
                Some(connection) => connection,
                None => rfb.insert(Rfb::connect(address, password.as_deref(), CONNECT)?),
            };
            let result = action(connection);
            if result.is_err() && attempt == 0 && connection.broken() {
                *rfb = None;
                continue;
            }
            return result;
        }
        unreachable!("the second attempt returns")
    }
    pub fn is_macos(&self, name: &str) -> Result<bool, String> {
        check_name(name)?;
        if let Some(session) = self.lock().get(name) {
            return Ok(session.macos);
        }
        Ok(self.backend.details(name)?.os == "darwin")
    }

    /// Unused for `idle`, and with a nonzero `idle` not running a command or installing its desktop.
    fn stale(&self, name: &str, session: &Session, idle: Duration) -> bool {
        session.used.elapsed() >= idle && (idle.is_zero() || (session.busy.load(SeqCst) == 0 && self.desktop_state(name) != Some(desktop::State::Installing)))
    }
    /// Suspend or stop VMs nobody has used for `idle`, all at once. Returns the names it released.
    /// A VM running a command or installing its desktop is busy even though `used` is stale;
    /// only quit (zero idle) stops it, and gives every stop until `QUIT`. A VM being started or
    /// stopped by someone else is left to them, and one used again since the list is kept.
    pub fn release_idle(&self, idle: Duration) -> Vec<String> {
        self.release(idle, QUIT)
    }
    fn release(&self, idle: Duration, quit: Duration) -> Vec<String> {
        let stale: Vec<String> = self.lock().iter().filter(|(name, session)| self.stale(name, session, idle)).map(|(name, _)| name.clone()).collect();
        let deadline = idle.is_zero().then(|| Instant::now() + quit);
        thread::scope(|scope| {
            let releases: Vec<_> = stale.into_iter().map(|name| scope.spawn(move || {
                let _claim = self.claim(&name, "stopping").ok()?;
                let macos = self.lock().get(&name).filter(|session| self.stale(&name, session, idle)).map(|session| session.macos)?;
                let released = if self.backend.can_suspend(macos) { self.suspend_claimed(&name, deadline) } else { self.stop_claimed(&name, deadline) };
                released.ok().map(|_| name)
            })).collect();
            releases.into_iter().filter_map(|release| release.join().ok().flatten()).collect()
        })
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
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering::SeqCst};

    #[derive(Default)]
    struct Fake(Mutex<Vec<String>>);
    impl Fake {
        /// Each stop or suspend takes a moment, so releasing several at once shows. A VM
        /// named `hang` never stops.
        fn call(&self, what: &str, name: &str) -> Result<(), String> {
            thread::sleep(if name == "hang" { Duration::from_secs(600) } else { Duration::from_millis(200) });
            self.0.lock().unwrap().push(format!("{what} {name}"));
            Ok(())
        }
    }
    impl VmBackend for Fake {
        fn id(&self) -> &'static str { "fake" }
        fn supported(&self) -> bool { true }
        fn installed(&self) -> bool { true }
        fn install(&self) -> Result<PathBuf, String> { Err("no install".into()) }
        fn has_vms(&self) -> bool { true }
        fn engine(&self, _: bool) -> &'static str { "" }
        fn exec_hint(&self) -> &'static str { "" }
        fn list_text(&self) -> &'static str { "" }
        fn manage_text(&self) -> &'static str { "" }
        fn images(&self) -> &'static [Image] { &[] }
        fn list(&self) -> Result<Vec<Vm>, String> { Ok(Vec::new()) }
        fn details(&self, _: &str) -> Result<Details, String> { Err("no details".into()) }
        fn create(&self, _: &Image, _: &str) -> Result<(), String> { Ok(()) }
        fn start(&self, _: &str, _: Option<&Path>) -> Result<Started, String> { Err("no start".into()) }
        fn stop(&self, name: &str) -> Result<(), String> { self.call("stop", name) }
        fn stop_by(&self, name: &str, _: Instant) -> Result<(), String> { self.call("stop", name) }
        fn can_suspend(&self, macos: bool) -> bool { macos }
        fn suspend(&self, name: &str) -> Result<(), String> { self.call("suspend", name) }
        fn suspend_by(&self, name: &str, _: Instant) -> Result<(), String> { self.call("suspend", name) }
        fn delete(&self, _: &str) -> Result<(), String> { Ok(()) }
        fn exec(&self, _: &str, _: bool, _: &str, _: Duration) -> Result<Exec, String> { Err("no exec".into()) }
    }
    fn session(macos: bool) -> Session {
        Session::new(Started { child: None, password: None, address: "127.0.0.1:5900".parse().unwrap(), macos }, None)
    }

    /// One VM that is up or down, for what `start` does with each. A start or create waits
    /// for `gate`; a create lists the VM (stopped) while it waits, as Lima does while it downloads.
    #[derive(Default)]
    struct Lone { running: AtomicBool, adopts: bool, gate: Mutex<()>, entered: AtomicBool, stops: AtomicUsize, absent: AtomicBool, boot: Mutex<()>, booting: AtomicBool }
    impl Lone {
        fn screen() -> Started { Started { child: None, password: None, address: "127.0.0.1:5900".parse().unwrap(), macos: false } }
    }
    impl VmBackend for Lone {
        fn id(&self) -> &'static str { "lone" }
        fn supported(&self) -> bool { true }
        fn installed(&self) -> bool { true }
        fn install(&self) -> Result<PathBuf, String> { Err("no install".into()) }
        fn has_vms(&self) -> bool { true }
        fn engine(&self, _: bool) -> &'static str { "" }
        fn exec_hint(&self) -> &'static str { "" }
        fn list_text(&self) -> &'static str { "" }
        fn manage_text(&self) -> &'static str { "" }
        fn images(&self) -> &'static [Image] { &[] }
        fn list(&self) -> Result<Vec<Vm>, String> {
            Ok(if self.absent.load(SeqCst) { Vec::new() } else { vec![Vm { name: "vm".into(), running: self.running.load(SeqCst), size_gb: 1, disk_gb: 1 }] })
        }
        fn details(&self, _: &str) -> Result<Details, String> { Err("no details".into()) }
        fn image(&self, _: &str) -> Result<Image, String> { Ok(Image { id: "x", name: "X", os: "linux", source: "", download_gb: 1, memory_mb: 2048, cpus: 2 }) }
        fn create(&self, _: &Image, _: &str) -> Result<(), String> {
            self.absent.store(false, SeqCst);
            self.entered.store(true, SeqCst);
            let _gate = self.gate.lock().unwrap();
            Ok(())
        }
        fn start(&self, _: &str, _: Option<&Path>) -> Result<Started, String> {
            self.entered.store(true, SeqCst);
            self.booting.store(true, SeqCst);
            let _gate = self.gate.lock().unwrap();
            let _boot = self.boot.lock().unwrap();
            self.running.store(true, SeqCst);
            Ok(Self::screen())
        }
        fn adopt(&self, _: &str, _: Option<&Path>) -> Result<Option<Started>, String> { Ok(self.adopts.then(Self::screen)) }
        fn stop(&self, _: &str) -> Result<(), String> { self.stops.fetch_add(1, SeqCst); self.running.store(false, SeqCst); Ok(()) }
        fn stop_by(&self, name: &str, _: Instant) -> Result<(), String> { self.stop(name) }
        fn can_suspend(&self, _: bool) -> bool { false }
        fn suspend(&self, _: &str) -> Result<(), String> { Ok(()) }
        fn suspend_by(&self, _: &str, _: Instant) -> Result<(), String> { Ok(()) }
        fn delete(&self, _: &str) -> Result<(), String> { Ok(()) }
        fn exec(&self, _: &str, _: bool, _: &str, _: Duration) -> Result<Exec, String> { Err("no exec".into()) }
    }

    #[test]
    fn a_running_vm_is_adopted_only_by_a_backend_that_can() {
        let tart: &'static Lone = Box::leak(Box::new(Lone { running: true.into(), adopts: false, ..Lone::default() }));
        let vms = Vms { backend: tart, ..Vms::default() };
        assert_eq!(vms.start("vm", None).unwrap_err(), "vm is running outside PandaCode. Stop it there, then start it here to see its screen.");
        assert!(!vms.attached("vm"));
        let lima: &'static Lone = Box::leak(Box::new(Lone { running: true.into(), adopts: true, ..Lone::default() }));
        let vms = Vms { backend: lima, ..Vms::default() };
        vms.start("vm", None).unwrap();
        assert!(vms.attached("vm"));
    }
    #[test]
    fn a_vm_that_stopped_under_its_session_boots_again() {
        let lima: &'static Lone = Box::leak(Box::new(Lone { running: false.into(), adopts: true, ..Lone::default() }));
        let vms = Vms { backend: lima, ..Vms::default() };
        vms.lock().insert("vm".to_string(), session(false));
        vms.start("vm", None).unwrap();
        assert!(lima.running.load(SeqCst) && vms.attached("vm"));
    }
    #[test]
    fn a_second_call_refuses_while_a_start_is_in_flight_and_never_stops_it() {
        let lima: &'static Lone = Box::leak(Box::default());
        let vms = Vms { backend: lima, ..Vms::default() };
        let gate = lima.gate.lock().unwrap();
        thread::scope(|scope| {
            let first = scope.spawn(|| vms.start("vm", None));
            while !lima.entered.load(SeqCst) {
                thread::sleep(Duration::from_millis(1));
            }
            assert_eq!(vms.start("vm", None).unwrap_err(), "vm is already starting.");
            assert_eq!(vms.stop("vm").unwrap_err(), "vm is already starting.");
            assert_eq!(vms.delete("vm").unwrap_err(), "vm is already starting.");
            drop(gate);
            first.join().unwrap().unwrap();
        });
        assert!(vms.attached("vm") && lima.stops.load(SeqCst) == 0);
        // The claim ends with the call, however it ends.
        vms.start("vm", None).unwrap();
        vms.stop("vm").unwrap();
        assert_eq!(lima.stops.load(SeqCst), 1);
    }
    #[test]
    fn an_attached_vm_keeps_the_share_it_started_with() {
        let lima: &'static Lone = Box::leak(Box::default());
        let vms = Vms { backend: lima, ..Vms::default() };
        vms.start("vm", Some(Path::new("/p/app"))).unwrap();
        vms.start("vm", Some(Path::new("/p/app"))).unwrap();
        assert_eq!(vms.start("vm", Some(Path::new("/p/other"))).unwrap_err(), different_share("vm"));
        assert_eq!(vms.start("vm", None).unwrap_err(), different_share("vm"));
        assert!(vms.attached("vm"));
    }
    #[test]
    fn a_busy_vm_is_not_idle_until_its_command_ends() {
        let fake: &'static Fake = Box::leak(Box::default());
        let vms = Vms { backend: fake, ..Vms::default() };
        vms.lock().insert("vm".to_string(), session(false));
        let tiny = Duration::from_nanos(1);
        let busy = vms.busy("vm");
        let nested = vms.busy("vm");
        thread::sleep(Duration::from_millis(2));
        assert!(vms.release_idle(tiny).is_empty());
        drop(nested);
        thread::sleep(Duration::from_millis(2));
        assert!(vms.release_idle(tiny).is_empty(), "still one command");
        drop(busy);
        thread::sleep(Duration::from_millis(2));
        assert_eq!(vms.release_idle(tiny), ["vm"]);
        // Quit stops a busy VM too.
        vms.lock().insert("vm".to_string(), session(false));
        let _busy = vms.busy("vm");
        assert_eq!(vms.release_idle(Duration::ZERO), ["vm"]);
    }
    #[test]
    fn names_from_agents_are_checked_before_any_engine_sees_them() {
        let fake: &'static Fake = Box::leak(Box::default());
        let vms = Vms { backend: fake, ..Vms::default() };
        for name in ["-rf", "", "a\nb", &"x".repeat(129)] {
            assert_eq!(vms.stop(name).unwrap_err(), "Unknown VM.");
            assert_eq!(vms.delete(name).unwrap_err(), "Unknown VM.");
            assert_eq!(vms.suspend(name).unwrap_err(), "Unknown VM.");
            assert_eq!(vms.start(name, None).unwrap_err(), "Unknown VM.");
            assert_eq!(vms.resolve(Some(name)).unwrap_err(), if name.is_empty() { "No VM is running. Start one with vm_manage, or list them with vm_list." } else { "Unknown VM." });
            assert!(vms.with_screen(name, true, |_| Ok(())).is_err() && vms.is_macos(name).is_err());
        }
        assert!(fake.0.lock().unwrap().is_empty());
        assert_eq!(vms.resolve(Some("daytona:abc")).unwrap(), "daytona:abc");
    }
    #[test]
    fn a_vm_being_created_cannot_start_or_be_deleted() {
        let lima: &'static Lone = Box::leak(Box::new(Lone { absent: true.into(), ..Lone::default() }));
        let vms = Vms { backend: lima, ..Vms::default() };
        let gate = lima.gate.lock().unwrap();
        thread::scope(|scope| {
            let create = scope.spawn(|| vms.create("x", "vm"));
            while !lima.entered.load(SeqCst) {
                thread::sleep(Duration::from_millis(1));
            }
            // The engine already lists it, stopped, while the image downloads.
            assert!(vms.list().unwrap().iter().any(|vm| vm.name == "vm" && vm.creating && !vm.running));
            assert_eq!(vms.start("vm", None).unwrap_err(), "vm is still being created.");
            assert_eq!(vms.delete("vm").unwrap_err(), "vm is still being created.");
            assert_eq!(vms.stop("vm").unwrap_err(), "vm is still being created.");
            drop(gate);
            assert!(!create.join().unwrap().unwrap().creating);
        });
        assert!(!vms.list().unwrap()[0].creating);
        vms.start("vm", None).unwrap();
        assert!(vms.attached("vm"));
    }
    #[test]
    fn a_new_vm_stays_claimed_from_its_download_through_its_boot() {
        let lima: &'static Lone = Box::leak(Box::new(Lone { absent: true.into(), ..Lone::default() }));
        let vms = Vms { backend: lima, ..Vms::default() };
        let gate = lima.gate.lock().unwrap();
        let boot = lima.boot.lock().unwrap();
        let wait = |flag: &AtomicBool| while !flag.load(SeqCst) { thread::sleep(Duration::from_millis(1)) };
        thread::scope(|scope| {
            let create = scope.spawn(|| vms.create_and_start("x", "vm"));
            wait(&lima.entered);
            let listed = vms.list().unwrap();
            assert!(listed[0].creating && !listed[0].starting && !listed[0].running);
            drop(gate);
            wait(&lima.booting);
            // Lima still lists it as stopped while it boots; it is starting, never just stopped.
            let listed = vms.list().unwrap();
            assert!(!listed[0].creating && listed[0].starting && !listed[0].running);
            assert_eq!(vms.shown().as_deref(), Some("vm"));
            assert_eq!(vms.start("vm", None).unwrap_err(), "vm is already starting.");
            assert_eq!(vms.delete("vm").unwrap_err(), "vm is already starting.");
            drop(boot);
            create.join().unwrap().unwrap();
        });
        let listed = vms.list().unwrap();
        assert!(!listed[0].creating && !listed[0].starting && listed[0].running && listed[0].attached);
    }
    #[test]
    fn quit_returns_by_its_deadline_even_if_a_stop_hangs() {
        let fake: &'static Fake = Box::leak(Box::default());
        let vms = Vms { backend: fake, ..Vms::default() };
        vms.lock().extend([("hang".to_string(), session(false)), ("linux".to_string(), session(false)), ("mac".to_string(), session(true))]);
        let quit = Duration::from_secs(2);
        let started = Instant::now();
        let mut released = vms.release(Duration::ZERO, quit);
        assert!(started.elapsed() < quit + Duration::from_secs(3), "{:?}", started.elapsed());
        released.sort();
        assert_eq!(released, ["linux", "mac"]);
        assert!(vms.lock().is_empty());
    }
    #[test]
    fn reaping_on_quit_kills_a_vm_process_left_at_the_deadline() {
        let mut lingering = session(false);
        lingering.child = Some(std::process::Command::new("sleep").arg("600").spawn().unwrap());
        let started = Instant::now();
        reap(Some(lingering), Some(Instant::now() + Duration::from_millis(300)));
        assert!(started.elapsed() < Duration::from_secs(5), "{:?}", started.elapsed());
    }
    #[test]
    fn a_vm_used_again_after_the_idle_list_is_kept() {
        let fake: &'static Fake = Box::leak(Box::default());
        let vms = Vms { backend: fake, ..Vms::default() };
        let idle = Duration::from_millis(50);
        for keep in [true, false] {
            vms.lock().insert("vm".to_string(), session(false));
            thread::sleep(idle * 2);
            // Hold every claim so the release lists the VM, then waits; meanwhile it gets busy.
            let claims = guard(&vms.claims);
            let (released, busy) = thread::scope(|scope| {
                let release = scope.spawn(|| vms.release(idle, QUIT));
                thread::sleep(Duration::from_millis(300));
                let busy = keep.then(|| vms.busy("vm"));
                drop(claims);
                (release.join().unwrap(), busy)
            });
            if keep {
                assert!(released.is_empty() && vms.attached("vm"), "{released:?}");
            } else {
                assert_eq!(released, ["vm"]);
            }
            drop(busy);
        }
        // An install that started since is kept too.
        vms.lock().insert("vm".to_string(), session(false));
        thread::sleep(idle * 2);
        let claims = guard(&vms.claims);
        let released = thread::scope(|scope| {
            let release = scope.spawn(|| vms.release(idle, QUIT));
            thread::sleep(Duration::from_millis(300));
            assert!(vms.begin_desktop("vm"));
            drop(claims);
            release.join().unwrap()
        });
        assert!(released.is_empty() && vms.attached("vm"));
    }
    #[test]
    fn a_command_from_an_earlier_session_never_counts_in_the_next() {
        let fake: &'static Fake = Box::leak(Box::default());
        let vms = Vms { backend: fake, ..Vms::default() };
        vms.lock().insert("vm".to_string(), session(false));
        let old = vms.busy("vm");
        // Restarted underneath the command.
        vms.lock().insert("vm".to_string(), session(false));
        let new = vms.busy("vm");
        drop(old);
        assert_eq!(vms.lock()["vm"].busy.load(SeqCst), 1);
        drop(new);
        assert_eq!(vms.lock()["vm"].busy.load(SeqCst), 0);
    }
    #[test]
    fn a_panic_holding_a_lock_never_stops_quit() {
        let fake: &'static Fake = Box::leak(Box::default());
        let vms = Vms { backend: fake, ..Vms::default() };
        vms.lock().insert("vm".to_string(), session(false));
        let _ = thread::scope(|scope| scope.spawn(|| { let _held = vms.lock(); let _claims = guard(&vms.claims); panic!("poison") }).join());
        assert!(vms.sessions.is_poisoned() && vms.claims.is_poisoned());
        assert_eq!(vms.release_idle(Duration::ZERO), ["vm"]);
    }
    #[test]
    fn names_are_safe() {
        assert!(valid_name("pandacode-ubuntu-2") && !valid_name("Ubuntu") && !valid_name("-x") && !valid_name("a b") && !valid_name(""));
    }
    #[test]
    fn releases_idle_vms_by_suspending_what_the_backend_can() {
        let fake: &'static Fake = Box::leak(Box::default());
        let vms = Vms { backend: fake, ..Vms::default() };
        vms.lock().extend([("mac".to_string(), session(true)), ("linux".to_string(), session(false))]);
        assert_eq!(vms.suspend("linux").unwrap_err(), "Only macOS VMs can be suspended. Stop a Linux VM instead; it boots in seconds.");
        let started = Instant::now();
        let mut released = vms.release_idle(Duration::ZERO);
        assert!(started.elapsed() < Duration::from_millis(350), "one at a time: {:?}", started.elapsed());
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
        // Quit, which stops it within `QUIT`.
        let quit = Instant::now();
        assert_eq!(vms.release_idle(Duration::ZERO), vec![name.clone()]);
        eprintln!("quit took {:?}", quit.elapsed());
        assert!(quit.elapsed() < QUIT + Duration::from_secs(1));
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
