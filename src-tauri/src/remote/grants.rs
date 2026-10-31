//! What each paired device may do on this computer (scoped pairing). A device seen for
//! the first time waits for the user's approval here before any request is served.
//!
//! Scopes, narrowest first: `pending` (nothing; a new device or one whose key changed),
//! `view` (read-only), `control` (view plus driving existing tasks and answering
//! approvals) and `full` (everything, including starting tasks and merging pull
//! requests). `blocked` is refused outright and stays blocked when its key changes.
//! A grant belongs to a device id and the fingerprint of its public key. Grants live in a
//! 0600 JSON file in the app data dir (`connect-grants.json`, via `secret_store`).
use super::{config, crypto, remote};
use crate::Result;
use chacha20poly1305::aead::{rand_core::RngCore, OsRng};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::Emitter;

const FILE: &str = "connect-grants.json";
const LABEL: &str = "PandaCode Connect device grants";
/// How long a pairing code stays valid, and how many wrong guesses end it.
const CODE_TTL: i64 = 10 * 60;
const MAX_TRIES: u8 = 5;
pub(crate) const REDEEM: &str = "pair.redeem";
const INVALID_CODE: &str = "That pairing code is not valid or has expired.";

const VIEW: [&str; 18] = [
    "subscribe", "tasks.list", "task.messages", "task.changes", "task.diff", "task.attachment", "task.workspaceImage", "projects.icons", "providers.list", "providers.models",
    "task.team", "task.workerMessages", "bots.list", "bot.thread", "task.startStatus", "task.pull", "task.pullDiff", "batch",
];
const CONTROL: [&str; 9] = ["task.send", "task.steer", "task.stop", "task.configure", "approval.respond", "input.respond", "image.put", "task.cancelStart", "task.pullDetect"];
/// Needs `full`: starting work, merging, and acting as a bot. Anything not listed anywhere
/// is `full`-only too.
#[cfg(test)]
const FULL_ONLY: [&str; 4] = ["task.start", "task.pullMerge", "bot.message", "bot.pause"];

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Scope {
    #[default]
    Pending,
    View,
    Control,
    Full,
    Blocked,
}

impl Scope {
    fn parse(text: &str) -> Result<Scope> {
        Ok(match text {
            "pending" => Scope::Pending,
            "view" => Scope::View,
            "control" => Scope::Control,
            "full" => Scope::Full,
            "blocked" => Scope::Blocked,
            _ => return Err("Unknown access level.".into()),
        })
    }

    fn name(self) -> &'static str {
        match self {
            Scope::Pending => "pending",
            Scope::View => "view",
            Scope::Control => "control",
            Scope::Full => "full",
            Scope::Blocked => "blocked",
        }
    }

    fn rank(self) -> u8 {
        match self {
            Scope::Pending | Scope::Blocked => 0,
            Scope::View => 1,
            Scope::Control => 2,
            Scope::Full => 3,
        }
    }

    /// Whether an approved scope may call `method`. Pending and blocked devices never do
    /// (a pending one may redeem a code, which `decide` handles).
    fn allows(self, method: &str) -> bool {
        match self {
            Scope::Pending | Scope::Blocked => false,
            Scope::Full => true,
            Scope::View => VIEW.contains(&method),
            Scope::Control => VIEW.contains(&method) || CONTROL.contains(&method),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct Entry {
    scope: Scope,
    /// Fingerprint of the public key the scope was granted to.
    fingerprint: String,
    #[serde(default)]
    name: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
struct Store {
    #[serde(default)]
    devices: BTreeMap<String, Entry>,
    /// Set once when an app from before scoped pairing is upgraded: the devices in the first
    /// presence frame after that are adopted as `full` so nobody is locked out. Cleared by
    /// that frame whatever it lists, so a device registered later always waits.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    adopt: bool,
}

/// A device on the account as presence lists it.
#[derive(Debug, Clone, PartialEq)]
struct Peer {
    id: String,
    name: String,
    platform: String,
    fingerprint: String,
    online: bool,
}

#[derive(Debug, PartialEq)]
enum Verdict {
    Allow,
    /// Waiting for approval; `announce` is true the first time this key is seen.
    Pending { announce: bool },
    Denied(Scope),
}

struct Code {
    digits: String,
    scope: Scope,
    expires: i64,
    tries: u8,
}

#[derive(Default)]
struct Grants {
    store: Store,
    code: Option<Code>,
    /// `id|fingerprint` pairs already announced in this run.
    announced: HashSet<String>,
    dirty: bool,
}

impl Grants {
    fn load(dir: &Path) -> Grants {
        let store = crate::secret_store::load(&dir.join(FILE), LABEL).unwrap_or_else(|error| {
            eprintln!("{error}");
            Store::default()
        });
        Grants { store, ..Default::default() }
    }

    /// The scope in force: the stored one only while the device still has the key it was
    /// granted to (`blocked` holds whatever the key).
    fn scope_of(&self, peer: &Peer) -> Scope {
        match self.store.devices.get(&peer.id) {
            Some(entry) if entry.scope == Scope::Blocked => Scope::Blocked,
            Some(entry) if !peer.fingerprint.is_empty() && entry.fingerprint == peer.fingerprint => entry.scope,
            _ => Scope::Pending,
        }
    }

    fn set(&mut self, peer: &Peer, scope: Scope) {
        self.store.devices.insert(peer.id.clone(), Entry { scope, fingerprint: peer.fingerprint.clone(), name: peer.name.clone() });
        self.announced.remove(&format!("{}|{}", peer.id, peer.fingerprint));
        self.dirty = true;
    }

    /// Records a waiting device (once per key) and says whether this is its first sighting.
    fn note_pending(&mut self, peer: &Peer) -> bool {
        let waiting = self.store.devices.get(&peer.id).is_some_and(|entry| entry.scope == Scope::Pending && entry.fingerprint == peer.fingerprint && entry.name == peer.name);
        if !waiting {
            self.store.devices.insert(peer.id.clone(), Entry { scope: Scope::Pending, fingerprint: peer.fingerprint.clone(), name: peer.name.clone() });
            self.dirty = true;
        }
        self.announced.insert(format!("{}|{}", peer.id, peer.fingerprint))
    }

    fn decide(&mut self, peer: &Peer, method: &str) -> Verdict {
        match self.scope_of(peer) {
            Scope::Blocked => Verdict::Denied(Scope::Blocked),
            Scope::Pending if method == REDEEM => Verdict::Allow,
            Scope::Pending => Verdict::Pending { announce: self.note_pending(peer) },
            scope if scope.allows(method) => Verdict::Allow,
            scope => Verdict::Denied(scope),
        }
    }

    /// The one-time upgrade, run on the first presence frame only: devices already on the
    /// account keep full access.
    fn adopt(&mut self, peers: &[Peer]) {
        if !self.store.adopt {
            return;
        }
        for peer in peers.iter().filter(|peer| !peer.fingerprint.is_empty()) {
            self.store.devices.entry(peer.id.clone()).or_insert_with(|| Entry { scope: Scope::Full, fingerprint: peer.fingerprint.clone(), name: peer.name.clone() });
        }
        self.store.adopt = false;
        self.dirty = true;
    }

    fn blocks(&self, device: &str) -> bool {
        self.store.devices.get(device).is_some_and(|entry| entry.scope == Scope::Blocked)
    }

    /// Starts (replacing any earlier) a single-use code for `scope`; returns its expiry.
    fn new_code(&mut self, scope: Scope, digits: String, now: i64) -> i64 {
        let expires = now + CODE_TTL;
        self.code = Some(Code { digits, scope, expires, tries: 0 });
        expires
    }

    fn redeem(&mut self, peer: &Peer, input: &str, now: i64) -> Result<Scope> {
        if self.scope_of(peer) == Scope::Blocked {
            return Err(INVALID_CODE.into());
        }
        let given: String = input.chars().filter(char::is_ascii_digit).collect();
        let Some(code) = self.code.as_mut().filter(|code| code.expires > now) else {
            self.code = None;
            return Err(INVALID_CODE.into());
        };
        let same = given.len() == code.digits.len() && given.bytes().zip(code.digits.bytes()).fold(0u8, |diff, (a, b)| diff | (a ^ b)) == 0;
        if !same {
            code.tries += 1;
            if code.tries >= MAX_TRIES {
                self.code = None;
            }
            return Err(INVALID_CODE.into());
        }
        let granted = self.code.take().map(|code| code.scope).unwrap_or_default();
        let current = self.scope_of(peer);
        let scope = if current.rank() >= granted.rank() { current } else { granted };
        self.set(peer, scope);
        Ok(scope)
    }

    /// Every device with its scope, devices waiting for a decision first.
    fn view(&self, peers: &[Peer]) -> Vec<Value> {
        let mut rows: Vec<(bool, Value)> = peers
            .iter()
            .map(|peer| {
                let scope = self.scope_of(peer);
                let requested = self.store.devices.get(&peer.id).is_some_and(|entry| entry.scope == Scope::Blocked || entry.fingerprint == peer.fingerprint);
                let waiting = scope == Scope::Pending && requested;
                (waiting, json!({"deviceId": peer.id, "name": peer.name, "platform": peer.platform, "fingerprint": peer.fingerprint, "scope": scope.name(), "online": peer.online, "requested": requested}))
            })
            .collect();
        rows.sort_by_key(|(waiting, _)| !waiting);
        rows.into_iter().map(|(_, row)| row).collect()
    }
}

/// A pending-approval or blocked device's request, as a user-facing refusal.
fn refusal(scope: Scope, host: &str) -> String {
    match scope {
        Scope::Blocked => format!("{host} has blocked this device."),
        Scope::View => format!("This device can only view tasks on {host}."),
        _ => format!("This device is not allowed to do that on {host}. Ask for full access."),
    }
}

struct Snapshot {
    dir: PathBuf,
    host: String,
    peers: Vec<Peer>,
}

/// The account's other devices as presence lists them. Takes and releases the remote lock.
fn snapshot(app: &tauri::AppHandle) -> Snapshot {
    let state = remote(app);
    let inner = state.lock();
    let peers = inner.devices.iter().filter(|device| device.id != inner.settings.device_id).map(|device| Peer { id: device.id.clone(), name: device.name.clone(), platform: device.platform.clone(), fingerprint: crypto::fingerprint(&device.public_key), online: device.online }).collect();
    Snapshot { dir: state.dir.clone(), host: config::device_name(), peers }
}

static GRANTS: Mutex<Option<Grants>> = Mutex::new(None);

/// Runs `f` on the loaded grants and saves them afterwards when it changed them.
fn with<R>(dir: &Path, f: impl FnOnce(&mut Grants) -> R) -> R {
    let mut guard = GRANTS.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let grants = guard.get_or_insert_with(|| Grants::load(dir));
    let result = f(grants);
    if std::mem::take(&mut grants.dirty) {
        let store = grants.store.clone();
        if let Err(error) = crate::secret_store::update(dir, FILE, LABEL, |_: Store| store) {
            eprintln!("{error}");
        }
    }
    result
}

/// Called by `config::load` once, on the first launch after scoped pairing shipped, for a
/// computer that already had remote control on.
pub(crate) fn seed_adopt(dir: &Path) -> Result<()> {
    crate::secret_store::update(dir, FILE, LABEL, |store: Store| Store { adopt: true, ..store })
}

/// Called on every presence frame (never on the HTTP device list): the first one after an
/// upgrade adopts the devices it lists (`Grants::adopt`).
pub(crate) fn presence(app: &tauri::AppHandle) {
    let snap = snapshot(app);
    let adopted = with(&snap.dir, |grants| {
        let adopting = grants.store.adopt;
        grants.adopt(&snap.peers);
        adopting
    });
    if adopted {
        emit_grants(app);
    }
}

/// Whether the user blocked `device` here.
pub(crate) fn is_blocked(app: &tauri::AppHandle, device: &str) -> bool {
    with(&remote(app).dir, |grants| grants.blocks(device))
}

fn emit_grants(app: &tauri::AppHandle) {
    let snap = snapshot(app);
    let list = with(&snap.dir, |grants| grants.view(&snap.peers));
    let _ = app.emit("remote://device-grants", list);
}

/// Ok when `device` may call `method` on this host. Locks the remote state itself: call
/// it after `admit`'s guard is dropped, for a batch also once per inner method.
pub(crate) fn check(app: &tauri::AppHandle, device: &str, method: &str) -> Result<()> {
    let snap = snapshot(app);
    let peer = snap.peers.iter().find(|peer| peer.id == device).ok_or(super::UNKNOWN_DEVICE)?;
    let verdict = with(&snap.dir, |grants| grants.decide(peer, method));
    match verdict {
        Verdict::Allow => Ok(()),
        Verdict::Pending { announce } => {
            if announce {
                let _ = app.emit("remote://device-pending", json!({"deviceId": peer.id, "name": peer.name, "fingerprint": peer.fingerprint}));
                emit_grants(app);
            }
            Err(format!("Waiting for approval on {}.", snap.host))
        }
        Verdict::Denied(scope) => Err(refusal(scope, &snap.host)),
    }
}

/// Host side of `pair.redeem`: the device sent the code shown here. Returns `{scope}`.
pub(crate) fn redeem(app: &tauri::AppHandle, device: &str, params: &Value) -> Result<Value> {
    let snap = snapshot(app);
    let peer = snap.peers.iter().find(|peer| peer.id == device).ok_or(super::UNKNOWN_DEVICE)?;
    let code = params["code"].as_str().filter(|code| code.len() <= 32).ok_or(INVALID_CODE)?;
    let scope = with(&snap.dir, |grants| grants.redeem(peer, code, chrono::Utc::now().timestamp()))?;
    let _ = app.emit("remote://pair-code-used", json!({"deviceId": peer.id, "name": peer.name, "scope": scope.name()}));
    emit_grants(app);
    Ok(json!({"scope": scope.name()}))
}

fn random_code() -> String {
    loop {
        let n = OsRng.next_u32();
        // 4_294_000_000 is a multiple of a million, so the digits are uniform.
        if n < 4_294_000_000 {
            return format!("{:06}", n % 1_000_000);
        }
    }
}

/// Every known device with its scope (`pending`, `full`, `control`, `view`, `blocked`).
#[tauri::command]
pub async fn remote_device_grants(app: tauri::AppHandle) -> Result<Value> {
    let snap = snapshot(&app);
    Ok(Value::Array(with(&snap.dir, |grants| grants.view(&snap.peers))))
}

/// Sets a device's scope; `pending` devices become usable once given another scope.
#[tauri::command]
pub async fn remote_set_device_grant(app: tauri::AppHandle, device_id: String, scope: String) -> Result<()> {
    let scope = Scope::parse(&scope)?;
    let snap = snapshot(&app);
    let peer = snap.peers.iter().find(|peer| peer.id == device_id).ok_or(super::UNKNOWN_DEVICE)?;
    with(&snap.dir, |grants| grants.set(peer, scope));
    emit_grants(&app);
    Ok(())
}

/// Shows a one-time code (valid 10 minutes) that gives a new device `scope` when entered
/// there. A new code replaces the old one.
#[tauri::command]
pub async fn remote_pair_code(app: tauri::AppHandle, scope: String) -> Result<Value> {
    let scope = Scope::parse(&scope)?;
    if !matches!(scope, Scope::View | Scope::Control | Scope::Full) {
        return Err("A pairing code can give view, control or full access.".into());
    }
    let snap = snapshot(&app);
    let (digits, now) = (random_code(), chrono::Utc::now().timestamp());
    let expires = with(&snap.dir, |grants| grants.new_code(scope, digits.clone(), now));
    Ok(json!({"code": digits, "scope": scope.name(), "expiresAt": expires * 1000}))
}

#[tauri::command]
pub async fn remote_pair_code_cancel(app: tauri::AppHandle) -> Result<()> {
    let snap = snapshot(&app);
    with(&snap.dir, |grants| grants.code = None);
    Ok(())
}

/// Viewer side: sends the code shown on `device_id` (a host) over the encrypted channel.
/// Returns `{scope}` when the host accepted it.
#[tauri::command]
pub async fn remote_pair_redeem(app: tauri::AppHandle, device_id: String, code: String) -> Result<Value> {
    let digits: String = code.chars().filter(char::is_ascii_digit).collect();
    if digits.len() != 6 {
        return Err("Enter the 6-digit code shown on the other computer.".into());
    }
    super::client::call(&app, &device_id, REDEEM, json!({"code": digits})).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn peer(id: &str, fingerprint: &str) -> Peer {
        Peer { id: id.into(), name: format!("Device {id}"), platform: "iOS".into(), fingerprint: fingerprint.into(), online: true }
    }

    fn granted(grants: &mut Grants, id: &str, fingerprint: &str, scope: Scope) -> Peer {
        let peer = peer(id, fingerprint);
        grants.set(&peer, scope);
        peer
    }

    #[test]
    fn scope_matrix_covers_every_host_method() {
        for method in super::super::host::METHODS {
            let listed = VIEW.contains(&method) || CONTROL.contains(&method) || FULL_ONLY.contains(&method) || method == REDEEM;
            assert!(listed, "{method} is not classified in grants.rs");
        }
        let mut seen = HashSet::new();
        for method in VIEW.iter().chain(&CONTROL).chain(&FULL_ONLY) {
            assert!(seen.insert(*method), "{method} is listed twice");
        }
        for method in VIEW.iter().chain(&CONTROL) {
            assert!(super::super::host::METHODS.contains(method), "{method} is not a host method");
        }
    }

    #[test]
    fn each_scope_allows_exactly_its_methods() {
        for method in VIEW {
            assert!(Scope::View.allows(method) && Scope::Control.allows(method) && Scope::Full.allows(method), "{method}");
        }
        for method in CONTROL {
            assert!(!Scope::View.allows(method) && Scope::Control.allows(method) && Scope::Full.allows(method), "{method}");
        }
        for method in FULL_ONLY {
            assert!(!Scope::View.allows(method) && !Scope::Control.allows(method) && Scope::Full.allows(method), "{method}");
        }
        for scope in [Scope::Pending, Scope::Blocked] {
            for method in VIEW.iter().chain(&CONTROL).chain(&FULL_ONLY) {
                assert!(!scope.allows(method), "{method}");
            }
        }
        // Unknown methods are for full only.
        assert!(Scope::Full.allows("something.new"));
        assert!(!Scope::Control.allows("something.new") && !Scope::View.allows("something.new"));
        assert!(!Scope::Control.allows("task.start") && !Scope::Control.allows("task.pullMerge"));
    }

    #[test]
    fn a_new_device_waits_and_is_announced_once() {
        let mut grants = Grants::default();
        let phone = peer("phone", "aa11");
        assert_eq!(grants.decide(&phone, "tasks.list"), Verdict::Pending { announce: true });
        assert_eq!(grants.decide(&phone, "subscribe"), Verdict::Pending { announce: false });
        assert!(grants.dirty);
        assert_eq!(grants.store.devices["phone"].scope, Scope::Pending);
        assert_eq!(grants.decide(&phone, REDEEM), Verdict::Allow);
        grants.set(&phone, Scope::View);
        assert_eq!(grants.decide(&phone, "tasks.list"), Verdict::Allow);
        assert_eq!(grants.decide(&phone, "task.send"), Verdict::Denied(Scope::View));
    }

    #[test]
    fn a_changed_key_falls_back_to_pending() {
        let mut grants = Grants::default();
        granted(&mut grants, "phone", "aa11", Scope::Full);
        assert_eq!(grants.decide(&peer("phone", "aa11"), "task.start"), Verdict::Allow);
        let swapped = peer("phone", "bb22");
        assert_eq!(grants.scope_of(&swapped), Scope::Pending);
        assert_eq!(grants.decide(&swapped, "tasks.list"), Verdict::Pending { announce: true });
        assert_eq!(grants.store.devices["phone"].fingerprint, "bb22");
        // The old key no longer matches the new pending entry either.
        assert_eq!(grants.scope_of(&peer("phone", "aa11")), Scope::Pending);
        // A device without a key is never approved.
        granted(&mut grants, "keyless", "", Scope::Full);
        assert_eq!(grants.scope_of(&peer("keyless", "")), Scope::Pending);
    }

    #[test]
    fn blocked_stays_blocked_across_key_changes() {
        let mut grants = Grants::default();
        granted(&mut grants, "phone", "aa11", Scope::Blocked);
        for key in ["aa11", "bb22"] {
            assert_eq!(grants.decide(&peer("phone", key), "tasks.list"), Verdict::Denied(Scope::Blocked));
            assert_eq!(grants.decide(&peer("phone", key), REDEEM), Verdict::Denied(Scope::Blocked));
        }
        grants.new_code(Scope::Full, "123456".into(), 0);
        assert!(grants.redeem(&peer("phone", "aa11"), "123456", 1).is_err());
        assert!(grants.code.is_some());
    }

    #[test]
    fn upgrade_adopts_present_devices_as_full_once() {
        let mut grants = Grants { store: Store { adopt: true, ..Default::default() }, ..Default::default() };
        let known = [peer("laptop", "aa11"), peer("nas", "bb22")];
        grants.adopt(&known);
        assert!(!grants.store.adopt && grants.dirty);
        assert_eq!(grants.decide(&known[0], "task.start"), Verdict::Allow);
        // A device that shows up afterwards starts pending, and its key still binds.
        grants.adopt(&[peer("new", "cc33")]);
        assert_eq!(grants.decide(&peer("new", "cc33"), "tasks.list"), Verdict::Pending { announce: true });
        assert_eq!(grants.scope_of(&peer("laptop", "other")), Scope::Pending);
    }

    #[test]
    fn an_empty_first_presence_still_ends_adoption() {
        let mut grants = Grants { store: Store { adopt: true, ..Default::default() }, ..Default::default() };
        grants.adopt(&[]);
        assert!(!grants.store.adopt && grants.dirty, "only the first presence frame adopts");
        grants.adopt(&[peer("later", "dd44")]);
        assert_eq!(grants.scope_of(&peer("later", "dd44")), Scope::Pending);
    }

    #[test]
    fn only_a_blocked_device_is_blocked() {
        let mut grants = Grants::default();
        grants.set(&peer("phone", "aa11"), Scope::Blocked);
        grants.set(&peer("laptop", "bb22"), Scope::Full);
        grants.note_pending(&peer("new", "cc33"));
        assert!(grants.blocks("phone"));
        assert!(!grants.blocks("laptop") && !grants.blocks("new") && !grants.blocks("unknown"));
    }

    #[test]
    fn seeding_and_saving_round_trip_through_the_private_file() {
        let dir = std::env::temp_dir().join(format!("pandacode-grants-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        seed_adopt(&dir).unwrap();
        let mut grants = Grants::load(&dir);
        assert!(grants.store.adopt);
        grants.adopt(&[peer("laptop", "aa11")]);
        let store = grants.store.clone();
        crate::secret_store::update(&dir, FILE, LABEL, |_: Store| store).unwrap();
        let reloaded = Grants::load(&dir);
        assert!(!reloaded.store.adopt);
        assert_eq!(reloaded.scope_of(&peer("laptop", "aa11")), Scope::Full);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(dir.join(FILE)).unwrap().permissions().mode() & 0o777, 0o600);
        }
        std::fs::write(dir.join(FILE), "{nope").unwrap();
        assert_eq!(Grants::load(&dir).store, Store::default());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_code_is_single_use_and_expires() {
        let mut grants = Grants::default();
        let phone = peer("phone", "aa11");
        let expires = grants.new_code(Scope::Control, "042917".into(), 1_000);
        assert_eq!(expires, 1_000 + 600);
        assert!(grants.redeem(&phone, "000000", 1_001).is_err());
        assert_eq!(grants.scope_of(&phone), Scope::Pending);
        assert_eq!(grants.redeem(&phone, "042 917", 1_002), Ok(Scope::Control));
        assert_eq!(grants.decide(&phone, "task.send"), Verdict::Allow);
        // Used: a second device cannot reuse it.
        let other = peer("other", "bb22");
        assert!(grants.redeem(&other, "042917", 1_003).is_err());
        assert_eq!(grants.scope_of(&other), Scope::Pending);
        // Expired exactly at the deadline.
        grants.new_code(Scope::View, "111111".into(), 2_000);
        assert!(grants.redeem(&other, "111111", 2_600).is_err());
        assert!(grants.code.is_none());
        // Cancelling or replacing invalidates the old code.
        grants.new_code(Scope::View, "222222".into(), 3_000);
        grants.new_code(Scope::Full, "333333".into(), 3_001);
        assert!(grants.redeem(&other, "222222", 3_002).is_err());
        assert_eq!(grants.redeem(&other, "333333", 3_003), Ok(Scope::Full));
    }

    #[test]
    fn wrong_guesses_burn_the_code_and_redeeming_never_downgrades() {
        let mut grants = Grants::default();
        let phone = peer("phone", "aa11");
        grants.new_code(Scope::View, "424242".into(), 0);
        for _ in 0..MAX_TRIES {
            assert!(grants.redeem(&phone, "999999", 1).is_err());
        }
        assert!(grants.redeem(&phone, "424242", 2).is_err(), "the code is gone after too many wrong guesses");
        granted(&mut grants, "tablet", "dd44", Scope::Full);
        grants.new_code(Scope::View, "424242".into(), 10);
        assert_eq!(grants.redeem(&peer("tablet", "dd44"), "424242", 11), Ok(Scope::Full));
        assert!(grants.redeem(&phone, "12345", 11).is_err());
    }

    #[test]
    fn the_list_puts_waiting_devices_first_with_their_scope() {
        let mut grants = Grants::default();
        let (a, b, c) = (peer("a", "aa"), peer("b", "bb"), peer("c", "cc"));
        grants.set(&a, Scope::View);
        grants.set(&b, Scope::Blocked);
        grants.decide(&c, "tasks.list");
        let list = grants.view(&[a, b, peer("d", "dd"), c]);
        let ids: Vec<_> = list.iter().map(|row| row["deviceId"].as_str().unwrap()).collect();
        assert_eq!(ids[0], "c");
        assert_eq!(list[0]["scope"], "pending");
        assert_eq!(list[0]["requested"], true);
        let row = |id: &str| list.iter().find(|row| row["deviceId"] == id).unwrap().clone();
        assert_eq!((row("a")["scope"].clone(), row("b")["scope"].clone(), row("d")["scope"].clone(), row("d")["requested"].clone()), (json!("view"), json!("blocked"), json!("pending"), json!(false)));
    }

    #[test]
    fn scopes_parse_by_name_and_refusals_name_the_host() {
        for scope in [Scope::Pending, Scope::View, Scope::Control, Scope::Full, Scope::Blocked] {
            assert_eq!(Scope::parse(scope.name()), Ok(scope));
        }
        assert!(Scope::parse("admin").is_err());
        assert_eq!(refusal(Scope::Blocked, "Studio"), "Studio has blocked this device.");
        assert!(refusal(Scope::View, "Studio").contains("only view"));
        assert_eq!(random_code().len(), 6);
    }
}
