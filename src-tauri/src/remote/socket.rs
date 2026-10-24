//! The one WebSocket to the relay: reconnects with backoff, pings, tracks presence,
//! and seals and opens every frame between this computer and the others.
use super::{auth, config, crypto, emit_presence, emit_status, host, mirror, remote, sign_out_local, Device, Inner};
use crate::Result;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::{self, client::IntoClientRequest, Message};

const PING: Duration = Duration::from_secs(30);
/// How often a connected computer checks whether its token is due for a refresh.
const REFRESH: Duration = Duration::from_secs(12 * 3600);
/// The error a call gets when the relay can't deliver it to an offline computer.
pub(crate) const OFFLINE: &str = "That computer is offline.";
/// Hosts keep a subscription for 10 minutes; it is renewed before then.
const RENEW: Duration = Duration::from_secs(9 * 60);
const SILENT: Duration = Duration::from_secs(75);
const MAX_BACKOFF: Duration = Duration::from_secs(60);
/// A socket must stay up this long before the backoff resets.
const STABLE: Duration = Duration::from_secs(30);
const MAX_FRAME: usize = 256 * 1024;
const PEER_QUEUE: usize = 64;
const MAX_PEERS: usize = 64;
/// Relay close codes: another socket replaced this one, or the device was revoked.
const REPLACED: u16 = 4000;
const REVOKED: u16 = 4001;

#[derive(Debug, PartialEq)]
enum Outcome {
    Closed { up: Duration, code: Option<u16> },
    Failed,
    Unauthorized,
}

/// (wait now, base for the next failure), or None to sign out.
fn backoff(delay: Duration, outcome: &Outcome) -> Option<(Duration, Duration)> {
    let base = match outcome {
        Outcome::Unauthorized | Outcome::Closed { code: Some(REVOKED), .. } => return None,
        Outcome::Closed { up, .. } if *up >= STABLE => Duration::from_secs(1),
        _ => delay,
    };
    let wait = if matches!(outcome, Outcome::Closed { code: Some(REPLACED), .. }) { base.max(MAX_BACKOFF) } else { base };
    Some((wait, (base * 2).min(MAX_BACKOFF)))
}

/// Starts (or restarts) the socket task while signed in.
pub(crate) fn start(app: &tauri::AppHandle) {
    let generation = {
        let state = remote(app);
        let mut inner = state.lock();
        if inner.token.is_none() {
            return;
        }
        inner.generation += 1;
        inner.outbox = None;
        inner.generation
    };
    tauri::async_runtime::spawn(run(app.clone(), generation));
}

fn current(app: &tauri::AppHandle, generation: u64) -> bool {
    remote(app).lock().generation == generation
}

async fn run(app: tauri::AppHandle, generation: u64) {
    let mut delay = Duration::from_secs(1);
    while current(&app, generation) {
        let Some(token) = remote(&app).lock().token.clone() else { return };
        let outcome = session(&app, generation, &token).await;
        let changed = {
            let state = remote(&app);
            let mut inner = state.lock();
            let changed = inner.generation == generation && inner.connected;
            if inner.generation == generation {
                inner.connected = false;
                inner.outbox = None;
                inner.presence = false;
                inner.fail_pending(None, "The connection to the relay was lost.");
            }
            changed
        };
        let Some((wait, next)) = backoff(delay, &outcome) else {
            if current(&app, generation) {
                sign_out_local(&app, Some(&token));
            }
            return;
        };
        if changed {
            emit_status(&app);
        }
        tokio::time::sleep(wait).await;
        delay = next;
    }
}

async fn session(app: &tauri::AppHandle, generation: u64, token: &str) -> Outcome {
    let Some(build) = config::build() else { return Outcome::Failed };
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    let hosting = remote(app).lock().settings.host_enabled;
    let url = format!("wss://{}/v1/connect?host={}", build.relay.trim_start_matches("https://"), u8::from(hosting));
    let Ok(mut request) = url.into_client_request() else { return Outcome::Failed };
    let Ok(authorization) = format!("Bearer {token}").parse() else { return Outcome::Unauthorized };
    request.headers_mut().insert("Authorization", authorization);
    // Nothing legitimate is larger than the relay's frame limit.
    let limits = tungstenite::protocol::WebSocketConfig::default().max_message_size(Some(MAX_FRAME + 4096)).max_frame_size(Some(MAX_FRAME + 4096));
    let stream = match tokio::time::timeout(Duration::from_secs(15), tokio_tungstenite::connect_async_with_config(request, Some(limits), false)).await {
        Ok(Ok((stream, _))) => stream,
        Ok(Err(tungstenite::Error::Http(response))) if matches!(response.status().as_u16(), 401 | 403) => return Outcome::Unauthorized,
        _ => return Outcome::Failed,
    };
    let opened = Instant::now();
    let (mut write, mut read) = stream.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let host_enabled = {
        let state = remote(app);
        let mut inner = state.lock();
        if inner.generation != generation {
            return Outcome::Failed;
        }
        inner.outbox = Some(tx);
        inner.connected = true;
        inner.settings.host_enabled
    };
    emit_status(app);
    let closed = |code| Outcome::Closed { up: opened.elapsed(), code };
    // Hosting was toggled while connecting, before the outbox could carry it.
    if host_enabled != hosting && write.send(Message::text(json!({"kind": "host", "enabled": host_enabled}).to_string())).await.is_err() {
        return closed(None);
    }
    // One ordered request queue per peer; dropping the map at the end stops their workers.
    let mut peers: HashMap<String, mpsc::Sender<Request>> = HashMap::new();
    let mut ping = tokio::time::interval_at(tokio::time::Instant::now() + PING, PING);
    // The first subscription follows the first presence frame.
    let mut renew = tokio::time::interval_at(tokio::time::Instant::now() + RENEW, RENEW);
    // The first tick is now: a token is checked at connect, then every 12 h.
    let mut refresh = tokio::time::interval(REFRESH);
    let mut heard = Instant::now();
    loop {
        tokio::select! {
            _ = refresh.tick() => {
                let token = remote(app).lock().token.clone();
                if let Some(token) = token.filter(|token| config::needs_refresh(token, chrono::Utc::now().timestamp())) {
                    tauri::async_runtime::spawn(refresh_token(app.clone(), token));
                }
            }
            // None once stop() or a restart drops the outbox.
            outgoing = rx.recv() => match outgoing {
                Some(text) => if write.send(Message::text(text)).await.is_err() { return closed(None) },
                None => {
                    let _ = write.send(Message::Close(None)).await;
                    return closed(None);
                }
            },
            _ = renew.tick() => {
                tauri::async_runtime::spawn(mirror::subscribe_all(app.clone()));
            }
            _ = ping.tick() => {
                if heard.elapsed() > SILENT || write.send(Message::text("ping")).await.is_err() {
                    return closed(None);
                }
            }
            incoming = read.next() => match incoming {
                Some(Ok(Message::Text(text))) => {
                    heard = Instant::now();
                    frame(app, text.as_str(), &mut peers);
                }
                Some(Ok(Message::Close(close))) => return closed(close.map(|frame| u16::from(frame.code))),
                Some(Err(_)) | None => return closed(None),
                Some(Ok(_)) => heard = Instant::now(),
            },
        }
    }
}

/// Trades a token in its last week for a fresh 30-day one (`POST /v1/token`). Failures are
/// left for the next check; a refused token signs out as any 401 does.
async fn refresh_token(app: tauri::AppHandle, old: String) {
    let Some(build) = config::build() else { return };
    let reply = match auth::relay(&build, &old, reqwest::Method::POST, "/v1/token").await {
        Ok(reply) => reply,
        Err(error) if error == auth::SIGNED_OUT => return sign_out_local(&app, Some(&old)),
        Err(_) => return,
    };
    let Some(fresh) = reply["token"].as_str().filter(|token| token.len() <= 4096) else { return };
    let (Some(was), Some(now)) = (config::parse_token(&old), config::parse_token(fresh)) else { return };
    if now.acct != was.acct || now.dev != was.dev || now.exp <= was.exp {
        return;
    }
    let state = remote(&app);
    {
        let mut inner = state.lock();
        // Signed out or in again meanwhile: the old token is no longer the one to replace.
        if inner.token.as_deref() != Some(old.as_str()) {
            return;
        }
        inner.token = Some(fresh.to_owned());
    }
    if let Err(error) = super::secrets::set_token(&state.dir, fresh) {
        eprintln!("Could not save the refreshed PandaCode Connect token: {error}");
    }
}

/// An opened request and the pair key to answer with.
type Request = (Value, crypto::Key);

/// One relay frame: presence, delivery failures and errors, or an encrypted message.
/// Responses and events are handled at once; only requests wait in their peer's queue.
fn frame(app: &tauri::AppHandle, text: &str, peers: &mut HashMap<String, mpsc::Sender<Request>>) {
    if text == "pong" {
        return;
    }
    let Ok(value) = serde_json::from_str::<Value>(text) else { return };
    match value["kind"].as_str() {
        Some("presence") => presence(app, &value["devices"]),
        Some("undeliverable") => {
            if let Some(to) = value["to"].as_str() {
                let error = if value["reason"] == "rate" { "Too many requests to that computer. Try again in a moment." } else { OFFLINE };
                remote(app).lock().fail_ref(to, value["ref"].as_str(), error);
            }
        }
        Some("error") => eprintln!("PandaCode Connect relay: {}", value["error"].as_str().unwrap_or("error")),
        _ => {
            let (Some(from), Some(to), Some(body)) = (value["from"].as_str(), value["to"].as_str(), value["body"].as_str()) else { return };
            if host::valid_id(from).is_err() {
                return;
            }
            let me = remote(app).device_id();
            if to != me || from == me {
                return;
            }
            let Ok(key) = peer_key(app, from) else { return };
            let Ok(plain) = crypto::open(&key, from, to, body) else { return };
            let Ok(message) = serde_json::from_slice::<Value>(&plain) else { return };
            if matches!(message["type"].as_str(), Some("res" | "event")) && !fresh(app, from, &message) {
                return;
            }
            match message["type"].as_str() {
                Some("req") => queue(app, from, (message, key), peers),
                Some("res") => super::client::resolve(app, from, &message),
                Some("event") => match message["name"].as_str() {
                    Some("agent.events") => mirror::events(app, from, &message["data"]),
                    Some("run.finished") => mirror::finished(app, from, &message["data"]),
                    _ => {}
                },
                _ => {}
            }
        }
    }
}

/// The error a call gets when its reply is stale, repeated, or from a host without `ts`/`nonce`.
const STALE: &str = "That computer's reply was stale or repeated. Update PandaCode on both computers and check their clocks.";

/// Replies and events carry `ts` and `nonce` like requests; a stale or repeated one is
/// dropped (a reply fails its call at once instead of timing out).
fn fresh(app: &tauri::AppHandle, from: &str, message: &Value) -> bool {
    let checked = remote(app).lock().inbound.check(message["ts"].as_i64(), message["nonce"].as_str(), chrono::Utc::now().timestamp_millis());
    if checked.is_err() {
        eprintln!("PandaCode Connect: dropped a stale or repeated {} from {from}.", message["type"].as_str().unwrap_or_default());
        if message["type"] == "res" {
            super::client::resolve(app, from, &json!({"id": message["id"], "ok": false, "error": STALE}));
        }
    }
    checked.is_ok()
}

/// `task.start` runs beside the peer's queue, so a slow clone never holds up its other
/// requests (which stay in order); at most [`MAX_STARTS`] at once, then it queues too.
fn runs_apart(message: &Value) -> bool {
    message["method"] == "task.start"
}

const MAX_STARTS: usize = 4;
static STARTS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

fn queue(app: &tauri::AppHandle, from: &str, request: Request, peers: &mut HashMap<String, mpsc::Sender<Request>>) {
    use std::sync::atomic::Ordering;
    if runs_apart(&request.0) && STARTS.fetch_add(1, Ordering::AcqRel) < MAX_STARTS {
        let (app, from) = (app.clone(), from.to_owned());
        tauri::async_runtime::spawn(async move {
            answer(&app, &from, request).await;
            STARTS.fetch_sub(1, Ordering::AcqRel);
        });
        return;
    } else if runs_apart(&request.0) {
        STARTS.fetch_sub(1, Ordering::AcqRel);
    }
    if !peers.contains_key(from) {
        if peers.len() >= MAX_PEERS {
            return busy(app, from, request);
        }
        let (tx, rx) = mpsc::channel(PEER_QUEUE);
        tauri::async_runtime::spawn(peer(app.clone(), from.to_owned(), rx));
        peers.insert(from.to_owned(), tx);
    }
    if let Err(error) = peers[from].try_send(request) {
        busy(app, from, error.into_inner());
    }
}

/// Refuses a request at once instead of dropping it, so the caller doesn't wait for its timeout.
fn busy(app: &tauri::AppHandle, from: &str, (message, key): Request) {
    let failure = json!({"type": "res", "id": message["id"], "ok": false, "error": "This computer is busy. Try again in a moment."});
    let _ = send_sealed(app, from, &key, &failure);
}

/// Answers one peer's requests strictly in arrival order.
async fn peer(app: tauri::AppHandle, from: String, mut requests: mpsc::Receiver<Request>) {
    while let Some(request) = requests.recv().await {
        answer(&app, &from, request).await;
    }
}

async fn answer(app: &tauri::AppHandle, from: &str, (message, key): Request) {
    if let Some(response) = host::handle(app, from, &message).await {
        if let Err(error) = send_sealed(app, from, &key, &response) {
            let failure = json!({"type": "res", "id": response["id"], "ok": false, "error": error});
            let _ = send_sealed(app, from, &key, &failure);
        }
    }
}

/// Applies a presence list, which carries the full device rows. A host that comes online (or restarted, forgetting subscriptions) is subscribed again.
fn presence(app: &tauri::AppHandle, list: &Value) {
    let Some(list) = list.as_array() else { return };
    let renamed = {
        let state = remote(app);
        let mut inner = state.lock();
        apply_presence(&mut inner, list);
        super::remember_names(&inner.devices)
    };
    emit_presence(app);
    if renamed {
        use tauri::Emitter;
        let _ = app.emit("sessions-changed", ());
    }
    tauri::async_runtime::spawn(mirror::subscribe_all(app.clone()));
}

/// The list replaces the known devices. A device missing from it is gone, with its subscription.
/// A device that went offline, came back or changed hosting loses its cached harness lists.
fn apply_presence(inner: &mut Inner, list: &[Value]) {
    let devices = parse_devices(list);
    for old in &inner.devices {
        if !devices.iter().any(|d| d.id == old.id && d.online == old.online && d.host == old.host) {
            inner.catalog.forget(&old.id);
        }
    }
    inner.devices = devices;
    inner.presence = true;
    let Inner { devices, subscribers, keys, .. } = inner;
    subscribers.retain(|id, _| devices.iter().any(|d| &d.id == id));
    keys.retain(|id, _| devices.iter().any(|d| &d.id == id));
}

fn parse_devices(list: &[Value]) -> Vec<Device> {
    list.iter().filter_map(|d| serde_json::from_value(d.clone()).ok()).filter(|d: &Device| host::valid_id(&d.id).is_ok()).take(64).collect()
}

/// Fetches the account's devices; used only before the socket's first presence frame.
pub(crate) async fn refresh_devices(app: &tauri::AppHandle) -> Result<()> {
    let build = config::build().ok_or("Remote access is not configured in this build.")?;
    let token = remote(app).lock().token.clone().ok_or("Sign in to PandaCode Connect first.")?;
    let reply = match auth::relay(&build, &token, reqwest::Method::GET, "/v1/devices").await {
        Err(error) if error == auth::SIGNED_OUT => {
            sign_out_local(app, Some(&token));
            return Err(error);
        }
        other => other?,
    };
    let devices = parse_devices(reply["devices"].as_array().map(Vec::as_slice).unwrap_or_default());
    {
        let state = remote(app);
        let mut inner = state.lock();
        // Presence that arrived meanwhile is newer.
        if !inner.presence {
            inner.subscribers.retain(|id, _| devices.iter().any(|d| &d.id == id));
            super::remember_names(&devices);
            inner.devices = devices;
        }
    }
    emit_presence(app);
    Ok(())
}

/// The pair key with a device, derived from its current presence key. Keys are cached
/// by (device id, public key), so key changes derive a fresh pair key.
fn peer_key(app: &tauri::AppHandle, device_id: &str) -> Result<crypto::Key> {
    let state = remote(app);
    let public = {
        let inner = state.lock();
        let public = &inner.devices.iter().find(|d| d.id == device_id).filter(|d| !d.public_key.is_empty()).ok_or(super::UNKNOWN_DEVICE)?.public_key;
        if let Some((_, key)) = inner.keys.get(device_id).filter(|(cached, _)| cached == public) {
            return Ok(*key);
        }
        public.clone()
    };
    let key = crypto::pair_key(&state.secret()?, &state.device_id(), &public, device_id)?;
    state.lock().keys.insert(device_id.to_owned(), (public, key));
    Ok(key)
}

/// Adds `ts` and a fresh `nonce`, so the receiver can refuse replays (docs/remote-access.md).
fn stamp(message: &Value, now_ms: i64) -> Value {
    let mut message = message.clone();
    message["ts"] = json!(now_ms);
    message["nonce"] = json!(uuid::Uuid::new_v4().simple().to_string());
    message
}

/// Seals a stamped message with a known key and queues it on the socket as `{to, body, ref}`.
fn send_sealed(app: &tauri::AppHandle, to: &str, key: &crypto::Key, message: &Value) -> Result<()> {
    let me = remote(app).device_id();
    let body = crypto::seal(key, &me, to, stamp(message, chrono::Utc::now().timestamp_millis()).to_string().as_bytes())?;
    let mut frame = json!({"to": to, "body": body});
    if let Some(id) = message["id"].as_str() {
        frame["ref"] = json!(id);
    }
    let frame = frame.to_string();
    if frame.len() > MAX_FRAME {
        return Err("That reply is too large to send to another computer.".into());
    }
    let state = remote(app);
    let inner = state.lock();
    let outbox = inner.outbox.as_ref().ok_or("Not connected to the relay.")?;
    outbox.send(frame).map_err(|_| "Not connected to the relay.".into())
}

/// Seals a request or event to the device's current key from presence.
pub(crate) fn send_to_device(app: &tauri::AppHandle, to: &str, message: &Value) -> Result<()> {
    remote(app).lock().callable(to)?;
    let key = peer_key(app, to)?;
    send_sealed(app, to, &key, message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_starts_run_beside_the_queue() {
        assert!(runs_apart(&json!({"method": "task.start"})));
        for method in ["subscribe", "task.send", "task.messages", "task.stop"] {
            assert!(!runs_apart(&json!({"method": method})), "{method}");
        }
    }

    #[test]
    fn every_sealed_message_is_stamped_and_a_replay_is_refused() {
        let event = json!({"type": "event", "name": "run.finished", "data": {}});
        let (a, b) = (stamp(&event, 1_000), stamp(&event, 1_000));
        assert_eq!((a["ts"].as_i64(), a["name"].as_str()), (Some(1_000), Some("run.finished")));
        assert_ne!(a["nonce"], b["nonce"]);
        // The viewer's check: once only, inside the window, and never without the fields.
        let mut inbound = host::Replay::default();
        assert!(inbound.check(a["ts"].as_i64(), a["nonce"].as_str(), 1_500).is_ok());
        assert!(inbound.check(a["ts"].as_i64(), a["nonce"].as_str(), 1_600).is_err(), "repeated");
        assert!(inbound.check(b["ts"].as_i64(), b["nonce"].as_str(), 1_000 + 60_001).is_err(), "stale");
        assert!(inbound.check(event["ts"].as_i64(), event["nonce"].as_str(), 1_000).is_err(), "an old host without ts/nonce");
    }

    #[test]
    fn backoff_resets_only_after_a_stable_socket() {
        let s = Duration::from_secs;
        assert_eq!(backoff(s(8), &Outcome::Failed), Some((s(8), s(16))));
        assert_eq!(backoff(s(40), &Outcome::Failed), Some((s(40), s(60))));
        assert_eq!(backoff(s(8), &Outcome::Closed { up: s(5), code: None }), Some((s(8), s(16))));
        assert_eq!(backoff(s(8), &Outcome::Closed { up: s(30), code: None }), Some((s(1), s(2))));
        assert_eq!(backoff(s(1), &Outcome::Closed { up: s(300), code: Some(REPLACED) }), Some((s(60), s(2))));
        assert_eq!(backoff(s(1), &Outcome::Closed { up: s(300), code: Some(REVOKED) }), None);
        assert_eq!(backoff(s(1), &Outcome::Unauthorized), None);
    }

    #[test]
    fn presence_is_the_device_list_and_prunes_subscribers() {
        let mut inner = Inner::default();
        inner.subscribers.insert("a".into(), super::super::Subscriber::default());
        inner.subscribers.insert("b".into(), super::super::Subscriber::default());
        apply_presence(&mut inner, &[json!({"id": "a", "name": "Mac", "platform": "macos", "publicKey": "k", "host": false, "online": true, "lastSeen": 5}), json!({"id": "c", "online": false, "host": true}), json!({"id": "bad id"})]);
        assert!(inner.presence);
        assert_eq!(inner.devices.iter().map(|d| d.id.as_str()).collect::<Vec<_>>(), ["a", "c"]);
        assert_eq!((inner.devices[0].name.as_str(), inner.devices[0].online, inner.devices[0].host), ("Mac", true, false));
        assert_eq!(inner.subscribers.keys().collect::<Vec<_>>(), ["a"]);
        apply_presence(&mut inner, &[]);
        assert!(inner.devices.is_empty() && inner.subscribers.is_empty());
    }

    #[test]
    fn going_offline_or_coming_back_forgets_cached_lists() {
        let mut inner = Inner::default();
        let row = |id: &str, online: bool| json!({"id": id, "online": online, "host": true});
        apply_presence(&mut inner, &[row("a", true), row("b", true)]);
        let now = std::time::Instant::now();
        for id in ["a", "b"] {
            inner.catalog.put((id.into(), None), now, json!([]));
        }
        apply_presence(&mut inner, &[row("a", false), row("b", true)]);
        assert!(!inner.catalog.knows("a") && inner.catalog.knows("b"));
        inner.catalog.put(("a".into(), None), now, json!([]));
        apply_presence(&mut inner, &[row("a", true), row("b", true)]);
        assert!(!inner.catalog.knows("a") && inner.catalog.knows("b"));
    }

    #[test]
    fn device_views_omit_trust_while_encryption_still_uses_the_current_key() {
        let (host, old, new) = (crypto::generate(), crypto::generate(), crypto::generate());
        // A frame sealed for an old key still cannot open after the peer key changes.
        let previous = crypto::pair_key(&host, "host", &crypto::public_key(&old), "viewer").unwrap();
        let swapped = crypto::pair_key(&new, "viewer", &crypto::public_key(&host), "host").unwrap();
        let body = crypto::seal(&swapped, "viewer", "host", b"{}").unwrap();
        assert!(crypto::open(&previous, "viewer", "host", &body).is_err());
        let view = Device { id: "viewer".into(), name: String::new(), platform: String::new(), public_key: crypto::public_key(&new), host: false, online: true, last_seen: Value::Null }.view("host");
        assert!(view.get("trusted").is_none());
    }
}
