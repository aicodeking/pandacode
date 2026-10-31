//! PandaCode Connect (docs/remote-access.md): sign-in, one end-to-end encrypted relay
//! socket, host RPC for this computer's tasks, and mirrors: local tasks that run on
//! another of the user's computers. Nothing touches the network until the user signs in.
mod auth;
mod bench;
pub(crate) mod catalog;
mod client;
mod config;
mod crypto;
pub(crate) mod diagnostics;
pub(crate) mod grants;
mod host;
mod images;
pub(crate) mod mirror;
pub(crate) mod routes;
mod secrets;
mod socket;
mod start;

pub(crate) use mirror::route;

use crate::Result;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::Instant;
use tauri::{Emitter, Manager};
use x25519_dalek::StaticSecret;

/// A device on the account, as the relay lists it and presence updates it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Device {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub platform: String,
    #[serde(default)]
    pub public_key: String,
    #[serde(default)]
    pub host: bool,
    #[serde(default)]
    pub online: bool,
    #[serde(default)]
    pub last_seen: Value,
}

impl Device {
    fn view(&self, me: &str) -> Value {
        json!({
            "id": self.id, "name": self.name, "platform": self.platform,
            "fingerprint": crypto::fingerprint(&self.public_key),
            "host": self.host, "online": self.online, "lastSeen": self.last_seen, "current": self.id == me,
        })
    }
}

type Reply = tokio::sync::oneshot::Sender<Result<Value>>;

const UNKNOWN_DEVICE: &str = "That computer is not on this account.";

/// A device mirroring some of this computer's tasks, and the events waiting
/// for its next frame.
#[derive(Default)]
pub(crate) struct Subscriber {
    until: Option<Instant>,
    sessions: std::collections::HashSet<String>,
    events: Vec<Value>,
    finished: Vec<Value>,
}

#[derive(Default)]
pub(crate) struct Inner {
    settings: config::Settings,
    token: Option<String>,
    connected: bool,
    /// Bumped on every start/stop so an old socket task knows to exit.
    generation: u64,
    /// Frames waiting for the socket, bounded so a stalled socket can't hoard memory.
    outbox: Option<tokio::sync::mpsc::Sender<String>>,
    /// The account's devices, as the latest presence frame lists them.
    devices: Vec<Device>,
    /// Whether presence arrived on this socket; until then `remote_devices` asks the relay.
    presence: bool,
    /// Outstanding calls to hosts: request id → (device id, reply).
    pending: HashMap<String, (String, Reply)>,
    subscribers: HashMap<String, Subscriber>,
    /// A flush of subscriber events is scheduled.
    flushing: bool,
    /// When subscriber events were last sent, and how many frames this burst has sent; a
    /// burst's first event goes at once.
    flushed_at: Option<Instant>,
    flush_frames: u32,
    /// Recent numbered events of followed tasks, replayed to viewers that come back.
    journal: host::Journal,
    /// This computer as a viewer: event positions, shown cards and starts in flight.
    viewer: mirror::Viewer,
    replay: host::Replay,
    /// Nonces of replies and events from hosts, refused when repeated or stale.
    inbound: host::Replay,
    /// Pair keys: device id → (the public key it was derived from, key).
    keys: HashMap<String, (String, crypto::Key)>,
    flow: Option<auth::Flow>,
    /// Dropping this cancels the device-flow poll in `remote_sign_in_finish`.
    cancel: Option<tokio::sync::oneshot::Sender<()>>,
    /// Other computers' harnesses and models, for their mirrors' model pickers.
    catalog: catalog::Cache,
    /// Images other computers are sending for their next message here.
    uploads: images::Uploads,
}

impl Inner {
    fn fail_pending(&mut self, device: Option<&str>, error: &str) {
        let ids: Vec<String> = self.pending.iter().filter(|(_, (d, _))| device.is_none_or(|device| d == device)).map(|(id, _)| id.clone()).collect();
        for id in ids {
            if let Some((_, reply)) = self.pending.remove(&id) {
                let _ = reply.send(Err(error.to_owned()));
            }
        }
    }

    /// An undeliverable frame fails the call it carried, or every call to `to` without a ref.
    fn fail_ref(&mut self, to: &str, reference: Option<&str>, error: &str) {
        let Some(id) = reference else { return self.fail_pending(Some(to), error) };
        if self.pending.get(id).is_some_and(|(device, _)| device == to) {
            if let Some((_, reply)) = self.pending.remove(id) {
                let _ = reply.send(Err(error.to_owned()));
            }
        }
    }

    /// Calls and task content go only to a device in the latest account presence list.
    fn callable(&self, device_id: &str) -> Result<()> {
        self.devices.iter().find(|d| d.id == device_id).ok_or(UNKNOWN_DEVICE)?;
        Ok(())
    }

    /// Forgets the sign-in and stops the socket. With `used`, only while that is still the
    /// token: a refusal of an old token must not sign out a newer sign-in.
    fn clear_sign_in(&mut self, used: Option<&str>) -> bool {
        if used.is_some_and(|used| self.token.as_deref() != Some(used)) {
            return false;
        }
        self.generation += 1;
        self.outbox = None;
        self.connected = false;
        self.fail_pending(None, "Signed out of PandaCode Connect.");
        self.token = None;
        self.settings.account = None;
        self.devices.clear();
        self.presence = false;
        self.subscribers.clear();
        self.viewer = Default::default();
        self.catalog = Default::default();
        self.uploads = Default::default();
        true
    }
}

pub(crate) struct Remote {
    dir: PathBuf,
    inner: Mutex<Inner>,
    /// The device key, separate from `inner` so reading or creating it blocks nothing else.
    key: Mutex<Option<StaticSecret>>,
}

impl Remote {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn key(&self) -> MutexGuard<'_, Option<StaticSecret>> {
        self.key.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn save(&self, settings: &config::Settings) {
        if let Err(error) = config::save(&self.dir, settings) {
            eprintln!("{error}");
        }
    }

    /// The device's X25519 key from the secrets file. Never creates one.
    fn secret(&self) -> Result<StaticSecret> {
        let mut key = self.key();
        if let Some(secret) = key.as_ref() {
            return Ok(secret.clone());
        }
        let secret = secrets::read(&self.dir).key.and_then(|text| crypto::decode_secret(&text)).ok_or("This computer has no PandaCode Connect key. Sign in again.")?;
        *key = Some(secret.clone());
        Ok(secret)
    }

    /// Reads or makes the key at sign-in, behind the key lock so two sign-ins cannot race.
    fn ensure_secret(&self) -> Result<StaticSecret> {
        let mut key = self.key();
        if let Some(secret) = key.as_ref() {
            return Ok(secret.clone());
        }
        let secret = config::load_or_create_key(secrets::read(&self.dir).key, |text| secrets::set_key(&self.dir, text))?;
        *key = Some(secret.clone());
        Ok(secret)
    }

    fn device_id(&self) -> String {
        self.lock().settings.device_id.clone()
    }

    fn status(&self) -> Value {
        let signed_in = self.lock().token.is_some();
        let cached = self.key().as_ref().map(|secret| crypto::fingerprint(&crypto::public_key(secret)));
        let fingerprint = cached.or_else(|| signed_in.then(|| self.secret().map(|secret| crypto::fingerprint(&crypto::public_key(&secret))).ok()).flatten()).unwrap_or_default();
        let inner = self.lock();
        let mut status = json!({
            "configured": config::build().is_some(),
            "signedIn": inner.token.is_some(),
            "device": {"id": inner.settings.device_id, "name": config::device_name(), "fingerprint": fingerprint},
            "hostEnabled": inner.settings.host_enabled,
            "notifyEnabled": inner.settings.notify_enabled,
            "remoteFullAccess": inner.settings.remote_full_access,
            "connected": inner.connected,
        });
        if let Some(account) = &inner.settings.account {
            status["account"] = json!({"login": account.login, "avatarUrl": account.avatar_url});
        }
        status
    }

    fn devices_view(&self) -> Vec<Value> {
        let inner = self.lock();
        inner.devices.iter().map(|device| device.view(&inner.settings.device_id)).collect()
    }
}

fn remote(app: &tauri::AppHandle) -> tauri::State<'_, Remote> {
    app.state::<Remote>()
}

fn emit_status(app: &tauri::AppHandle) {
    let _ = app.emit("remote://status", remote(app).status());
}

fn emit_presence(app: &tauri::AppHandle) {
    let _ = app.emit("remote://presence", remote(app).devices_view());
}

/// Loads settings and starts the socket when already signed in. No network otherwise.
pub(crate) fn setup(app: &tauri::AppHandle, dir: &std::path::Path) {
    let settings = config::load(dir);
    // Only a signed-in computer reads the secrets file; an expired token means signed out.
    let now = chrono::Utc::now().timestamp();
    let token = if settings.account.is_some() { secrets::read(dir).token.filter(|token| config::token_valid(token, now)) } else { None };
    let signed_in = token.is_some();
    app.manage(Remote { dir: dir.to_owned(), inner: Mutex::new(Inner { settings, token, ..Default::default() }), key: Mutex::new(None) });
    if signed_in && config::build().is_some() {
        socket::start(app);
    }
}

/// Forgets the account on this computer: closes the socket and drops the token.
/// With `used`, only if that request's token is still the current one.
fn sign_out_local(app: &tauri::AppHandle, used: Option<&str>) {
    let remote = remote(app);
    let settings = {
        let mut inner = remote.lock();
        if !inner.clear_sign_in(used) {
            return;
        }
        inner.settings.clone()
    };
    if let Err(error) = secrets::remove_token(&remote.dir) {
        eprintln!("{error}");
    }
    remote.save(&settings);
    emit_status(app);
    emit_presence(app);
}

/// Hooked into every agent event: forwards it to devices mirroring that task.
/// Allocates nothing while hosting is off or nobody mirrors the task.
pub(crate) fn agent_event(app: &tauri::AppHandle, event: &crate::providers::AgentEvent) {
    host::agent_event(app, event);
}

/// Hooked into every run end, with the text of its `done` event.
pub(crate) fn run_finished(app: &tauri::AppHandle, session_id: &str, successful: bool, stopped: bool, text: &str) {
    host::run_finished(app, session_id, successful, stopped, text);
}

/// Device names as presence last listed them, for mirrors' labels and errors.
fn names() -> &'static Mutex<HashMap<String, String>> {
    static NAMES: std::sync::OnceLock<Mutex<HashMap<String, String>>> = std::sync::OnceLock::new();
    NAMES.get_or_init(Default::default)
}

/// A device's name, or a neutral label before presence names it.
pub(crate) fn device_label(id: &str) -> String {
    names().lock().unwrap_or_else(|e| e.into_inner()).get(id).filter(|name| !name.is_empty()).cloned().unwrap_or_else(|| "another computer".into())
}

/// Remembers the names in a device list; true if any changed.
fn remember_names(devices: &[Device]) -> bool {
    let mut names = names().lock().unwrap_or_else(|e| e.into_inner());
    let mut changed = false;
    for device in devices {
        if names.get(&device.id) != Some(&device.name) {
            names.insert(device.id.clone(), device.name.clone());
            changed = true;
        }
    }
    changed
}

fn valid_device_id(id: &str) -> Result<()> {
    host::valid_id(id).map_err(|_| "Unknown computer.".into())
}

#[tauri::command]
pub async fn remote_status(app: tauri::AppHandle) -> Value {
    remote(&app).status()
}

/// Stops any device-flow poll and forgets its code.
fn cancel_sign_in(app: &tauri::AppHandle) {
    let state = remote(app);
    let mut inner = state.lock();
    inner.flow = None;
    inner.cancel = None;
}

#[tauri::command]
pub async fn remote_sign_in_start(app: tauri::AppHandle) -> Result<Value> {
    let build = config::build().ok_or("Remote access is not configured in this build.")?;
    cancel_sign_in(&app);
    let (flow, view) = auth::start(&build).await?;
    remote(&app).lock().flow = Some(flow);
    Ok(view)
}

#[tauri::command]
pub async fn remote_sign_in_cancel(app: tauri::AppHandle) -> Value {
    cancel_sign_in(&app);
    remote(&app).status()
}

#[tauri::command]
pub async fn remote_sign_in_finish(app: tauri::AppHandle) -> Result<Value> {
    let build = config::build().ok_or("Remote access is not configured in this build.")?;
    let state = remote(&app);
    let (flow, cancelled) = {
        let mut inner = state.lock();
        let flow = inner.flow.take().ok_or("Start signing in first.")?;
        let (cancel, cancelled) = tokio::sync::oneshot::channel();
        inner.cancel = Some(cancel);
        (flow, cancelled)
    };
    let public_key = crypto::public_key(&state.ensure_secret()?);
    let github_token = tokio::select! {
        token = auth::github_token(&build, flow) => token?,
        _ = cancelled => return Err("Sign-in was cancelled.".into()),
    };
    let device = |id: String| json!({"id": id, "name": config::device_name(), "platform": std::env::consts::OS, "publicKey": public_key});
    let (token, account) = match auth::register(&build, &github_token, device(state.device_id())).await {
        // This id is registered with another key (the key file was lost, say): become a new device once.
        Err(error) if error == auth::KEY_CHANGED => {
            let settings = {
                let mut inner = state.lock();
                inner.settings.device_id = uuid::Uuid::new_v4().to_string();
                inner.settings.clone()
            };
            state.save(&settings);
            auth::register(&build, &github_token, device(settings.device_id)).await?
        }
        other => other?,
    };
    if config::parse_token(&token).is_none_or(|claims| claims.dev != state.device_id()) {
        return Err("The relay returned an unexpected sign-in token.".into());
    }
    secrets::set_token(&state.dir, &token)?;
    let settings = {
        let mut inner = state.lock();
        inner.token = Some(token);
        inner.settings.account = Some(account);
        inner.settings.clone()
    };
    state.save(&settings);
    socket::start(&app);
    emit_status(&app);
    Ok(state.status())
}

#[tauri::command]
pub async fn remote_sign_out(app: tauri::AppHandle) -> Result<Value> {
    let (token, me) = {
        let state = remote(&app);
        let inner = state.lock();
        (inner.token.clone(), inner.settings.device_id.clone())
    };
    // Free this computer's slot on the account; signing out locally never waits on it.
    if let (Some(build), Some(token)) = (config::build(), token) {
        let _ = auth::relay(&build, &token, reqwest::Method::DELETE, &format!("/v1/devices/{me}")).await;
    }
    sign_out_local(&app, None);
    Ok(remote(&app).status())
}

/// Sets "Allow remote control" and/or "Full access for remote tasks"; either may be omitted.
#[tauri::command]
pub async fn remote_set_host_enabled(app: tauri::AppHandle, enabled: Option<bool>, full_access: Option<bool>) -> Result<Value> {
    let state = remote(&app);
    let settings = {
        let mut inner = state.lock();
        if let Some(full_access) = full_access {
            inner.settings.remote_full_access = full_access;
        }
        if let Some(enabled) = enabled {
            inner.settings.host_enabled = enabled;
            if !enabled {
                inner.subscribers.clear();
                inner.uploads = Default::default();
            }
            if let Some(outbox) = &inner.outbox {
                let _ = outbox.try_send(json!({"kind": "host", "enabled": enabled}).to_string());
            }
        }
        inner.settings.clone()
    };
    state.save(&settings);
    emit_status(&app);
    Ok(state.status())
}

#[tauri::command]
pub async fn remote_set_notify_enabled(app: tauri::AppHandle, enabled: bool) -> Result<Value> {
    let state = remote(&app);
    let settings = {
        let mut inner = state.lock();
        inner.settings.notify_enabled = enabled;
        inner.settings.clone()
    };
    state.save(&settings);
    emit_status(&app);
    Ok(state.status())
}

#[tauri::command]
pub async fn remote_devices(app: tauri::AppHandle) -> Result<Vec<Value>> {
    // Presence carries the list; the relay is asked only before the first presence frame.
    if !remote(&app).lock().presence {
        socket::refresh_devices(&app).await?;
    }
    Ok(remote(&app).devices_view())
}

#[tauri::command]
pub async fn remote_revoke_device(app: tauri::AppHandle, device_id: String) -> Result<Value> {
    valid_device_id(&device_id)?;
    let build = config::build().ok_or("Remote access is not configured in this build.")?;
    let (token, me) = {
        let state = remote(&app);
        let inner = state.lock();
        (inner.token.clone().ok_or("Sign in to PandaCode Connect first.")?, inner.settings.device_id.clone())
    };
    auth::relay(&build, &token, reqwest::Method::DELETE, &format!("/v1/devices/{device_id}")).await.inspect_err(|error| {
        if error == auth::SIGNED_OUT {
            sign_out_local(&app, Some(&token));
        }
    })?;
    if device_id == me {
        sign_out_local(&app, Some(&token));
    } else {
        {
            let state = remote(&app);
            let mut inner = state.lock();
            inner.devices.retain(|device| device.id != device_id);
            inner.subscribers.remove(&device_id);
            inner.keys.remove(&device_id);
            inner.catalog.forget(&device_id);
            let settings = inner.settings.clone();
            drop(inner);
            state.save(&settings);
        }
        emit_presence(&app);
    }
    Ok(json!({}))
}

/// Other online account devices with remote control enabled.
#[tauri::command]
pub async fn remote_targets(app: tauri::AppHandle) -> Vec<Value> {
    let state = remote(&app);
    let inner = state.lock();
    targets(&inner)
}

fn targets(inner: &Inner) -> Vec<Value> {
    inner
        .devices
        .iter()
        .filter(|d| d.id != inner.settings.device_id && d.host && d.online)
        .map(|d| json!({"deviceId": d.id, "name": d.name, "platform": d.platform, "online": d.online}))
        .collect()
}

// Headless host support (`pandacode serve`, docs/headless.md): the sign-in, settings and
// status paths a server needs, without a webview to click through.

/// Full headless sign-in: the GitHub device flow on stdout, then [`headless_register`].
pub(crate) async fn headless_sign_in(dir: &Path, name: Option<String>) -> Result<String> {
    let build = config::build().ok_or(
        "Remote access is not configured in this build (PANDACODE_RELAY_URL / PANDACODE_GITHUB_CLIENT_ID).",
    )?;
    let (flow, view) = auth::start(&build).await?;
    println!(
        "PandaCode Connect sign-in: open {} and enter the code {}.",
        view["verificationUri"].as_str().unwrap_or_default(),
        view["userCode"].as_str().unwrap_or_default()
    );
    let github_token = auth::github_token(&build, flow).await?;
    let settings = headless_register(&build, &github_token, dir, name).await?;
    let login = settings.account.as_ref().map(|account| account.login.clone()).unwrap_or_default();
    println!("Signed in as {login} — this server is now hosting for your devices.");
    Ok(login)
}

/// Registers this device for `github_token` and enables hosting on disk. The last half of
/// [`headless_sign_in`], separate so tests can run it against a mock relay.
async fn headless_register(build: &config::Build, github_token: &str, dir: &Path, name: Option<String>) -> Result<config::Settings> {
    let mut settings = config::load(dir);
    let secret = config::load_or_create_key(secrets::read(dir).key, |text| secrets::set_key(dir, text))?;
    let public_key = crypto::public_key(&secret);
    let name = name.unwrap_or_else(config::device_name);
    let device = |id: String| json!({"id": id, "name": name, "platform": std::env::consts::OS, "publicKey": public_key});
    let (token, account) = match auth::register(build, github_token, device(settings.device_id.clone())).await {
        // This id is registered with another key (the key file was lost, say): become a new device once.
        Err(error) if error == auth::KEY_CHANGED => {
            settings.device_id = uuid::Uuid::new_v4().to_string();
            config::save(dir, &settings)?;
            auth::register(build, github_token, device(settings.device_id.clone())).await?
        }
        other => other?,
    };
    if config::parse_token(&token).is_none_or(|claims| claims.dev != settings.device_id) {
        return Err("The relay returned an unexpected sign-in token.".into());
    }
    secrets::set_token(dir, &token)?;
    settings.host_enabled = true;
    settings.account = Some(account);
    config::save(dir, &settings)?;
    Ok(settings)
}

/// Headless sign-out: leaves the account's device list, then clears the local sign-in.
pub(crate) async fn headless_sign_out(app: &tauri::AppHandle) {
    let (build, token, me) = {
        let state = remote(app);
        let inner = state.lock();
        (config::build(), inner.token.clone(), inner.settings.device_id.clone())
    };
    if let (Some(build), Some(token)) = (build, token) {
        let _ = auth::relay(&build, &token, reqwest::Method::DELETE, &format!("/v1/devices/{me}")).await;
    }
    sign_out_local(app, None);
}

/// Persists the Full access toggle for remote tasks (headless settings command).
pub(crate) fn headless_set_full_access(dir: &Path, enabled: bool) -> Result<()> {
    let mut settings = config::load(dir);
    settings.remote_full_access = enabled;
    config::save(dir, &settings)
}

/// Whether saved Connect credentials exist (serve requires them before serving).
pub(crate) fn signed_in(dir: &Path) -> bool {
    let settings = config::load(dir);
    settings.account.is_some()
        && secrets::read(dir).token.as_deref().is_some_and(|token| config::token_valid(token, chrono::Utc::now().timestamp()))
}

/// Whether this build can reach a relay at all (plain `serve` refuses without it).
pub(crate) fn configured() -> bool {
    config::build().is_some()
}

/// Whether the saved settings turn hosting on.
pub(crate) fn host_enabled(dir: &Path) -> bool {
    config::load(dir).host_enabled
}

/// Persists "Allow remote control" (headless settings command).
pub(crate) fn headless_set_host_enabled(dir: &Path, enabled: bool) -> Result<()> {
    let mut settings = config::load(dir);
    settings.host_enabled = enabled;
    config::save(dir, &settings)
}

/// After a CLI sign-in on disk: load it into the managed state and connect the socket.
pub(crate) fn headless_reload(app: &tauri::AppHandle, dir: &Path) {
    let settings = config::load(dir);
    let token = secrets::read(dir).token.filter(|token| config::token_valid(token, chrono::Utc::now().timestamp()));
    {
        let state = remote(app);
        let mut inner = state.lock();
        inner.settings = settings;
        inner.token = token;
    }
    socket::start(app);
    emit_status(app);
}

/// One-line serve status for journald, logged only when it changes.
pub(crate) fn headless_status(app: &tauri::AppHandle) -> String {
    let state = remote(app);
    let inner = state.lock();
    format!(
        "pandacode serve: {} · hosting {} · relay {} · {} device(s) online",
        inner.settings.account.as_ref().map(|account| account.login.as_str()).unwrap_or("signed out"),
        if inner.settings.host_enabled { "on" } else { "off" },
        if inner.connected { "connected" } else { "disconnected" },
        inner.devices.iter().filter(|device| device.online).count(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A relay token the client accepts: signed-shaped, `dev` naming its device.
    fn relay_token(dev: &str) -> String {
        use base64::Engine;
        let engine = base64::engine::general_purpose::URL_SAFE_NO_PAD;
        format!("{}.{}", engine.encode(format!(r#"{{"acct":"gh:1","dev":"{dev}","iat":1,"exp":9999999999}}"#)), engine.encode([7u8; 32]))
    }

    /// The serve sign-in's register half: enables hosting, and a 409 becomes a new device.
    #[test]
    fn headless_register_enables_hosting_and_survives_a_key_change() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let calls = AtomicUsize::new(0);
        let (relay, seen) = crate::cloud::http::mock::serve(move |request, _| {
            let body: Value = serde_json::from_str(&request.body).unwrap_or(Value::Null);
            let dev = body["device"]["id"].as_str().unwrap_or_default().to_owned();
            let n = calls.fetch_add(1, Ordering::SeqCst);
            if n == 0 {
                (409, r#"{"error":"key changed"}"#.to_owned())
            } else {
                (200, json!({"token": relay_token(&dev), "account": {"id": "gh:1", "login": "octocat", "avatarUrl": "u"}}).to_string())
            }
        });
        let build = config::Build { relay, client_id: "Iv1.test".into() };
        let dir = std::env::temp_dir().join(format!("pandacode-headless-signin-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let first = config::load(&dir).device_id;
        let settings = crate::cloud::http::block(async { headless_register(&build, "gh-token", &dir, Some("Build server".into())).await }).unwrap();
        assert!(settings.host_enabled && !settings.remote_full_access);
        assert_eq!(settings.account.as_ref().unwrap().login, "octocat");
        assert_ne!(settings.device_id, first, "a 409 made this a new device");
        assert_eq!(secrets::read(&dir).token.as_deref(), Some(relay_token(&settings.device_id).as_str()));
        assert!(config::load(&dir).host_enabled);
        assert_eq!(seen.lock().unwrap().len(), 2, "the 409 retried once");
        let _ = std::fs::remove_dir_all(dir);
    }

    fn device(id: &str, name: &str, key: &str) -> Device {
        Device { id: id.into(), name: name.into(), platform: String::new(), public_key: key.into(), host: true, online: true, last_seen: Value::Null }
    }

    #[test]
    fn undeliverable_fails_only_the_call_it_names() {
        let mut inner = Inner::default();
        let (a, mut ra) = tokio::sync::oneshot::channel();
        let (b, mut rb) = tokio::sync::oneshot::channel();
        let (c, mut rc) = tokio::sync::oneshot::channel();
        inner.pending.insert("r1".into(), ("host".into(), a));
        inner.pending.insert("r2".into(), ("host".into(), b));
        inner.pending.insert("r3".into(), ("other".into(), c));
        // A ref naming another device's call is ignored.
        inner.fail_ref("host", Some("r3"), "offline");
        assert!(rc.try_recv().is_err());
        inner.fail_ref("host", Some("r1"), "offline");
        assert_eq!(ra.try_recv().unwrap(), Err("offline".to_string()));
        assert!(rb.try_recv().is_err());
        // Without a ref, every call to that device fails.
        inner.fail_ref("host", None, "rate");
        assert_eq!(rb.try_recv().unwrap(), Err("rate".to_string()));
        assert!(rc.try_recv().is_err());
        assert_eq!(inner.pending.len(), 1);
    }

    #[test]
    fn listed_hosts_are_callable_without_a_pin() {
        let key = crypto::public_key(&crypto::generate());
        let inner = Inner { devices: vec![device("host", "Studio Mac", &key)], ..Default::default() };
        assert_eq!(inner.callable("host"), Ok(()));
        assert_eq!(inner.callable("gone"), Err(UNKNOWN_DEVICE.to_string()));
    }

    #[test]
    fn targets_are_every_online_host_other_than_this_one() {
        let key = crypto::public_key(&crypto::generate());
        let mut guest = device("guest", "Laptop", &key);
        guest.host = false;
        let mut offline = device("offline", "Offline Mac", &key);
        offline.online = false;
        let mut inner = Inner { devices: vec![device("me", "This Mac", &key), device("studio", "Studio Mac", &key), device("other", "Other", &key), offline, guest], ..Default::default() };
        inner.settings.device_id = "me".into();
        assert_eq!(targets(&inner), vec![
            json!({"deviceId": "studio", "name": "Studio Mac", "platform": "", "online": true}),
            json!({"deviceId": "other", "name": "Other", "platform": "", "online": true}),
        ]);
    }

    #[test]
    fn a_stale_token_never_signs_out_a_newer_sign_in() {
        let mut inner = Inner { token: Some("new".into()), generation: 3, ..Default::default() };
        inner.settings.account = Some(config::Account::default());
        assert!(!inner.clear_sign_in(Some("old")));
        assert_eq!((inner.token.as_deref(), inner.generation, inner.settings.account.is_some()), (Some("new"), 3, true));
        assert!(inner.clear_sign_in(Some("new")));
        assert_eq!((inner.token.as_deref(), inner.generation, inner.settings.account.is_some()), (None, 4, false));
        inner.token = Some("again".into());
        assert!(inner.clear_sign_in(None));
        assert!(inner.token.is_none());
    }
}
