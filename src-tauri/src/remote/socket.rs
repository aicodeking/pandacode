//! The one WebSocket to the relay: reconnects with backoff, pings, tracks presence,
//! and seals and opens every frame between this computer and the others. A frame goes on
//! a device's direct link instead when one is up ([`super::routes`]).
use super::{auth, config, crypto, emit_presence, emit_status, host, mirror, remote, routes, sign_out_local, Device, Inner};
use crate::Result;
use futures_util::future::BoxFuture;
use futures_util::stream::FuturesUnordered;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::time::{Duration, Instant, SystemTime};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::{self, client::IntoClientRequest, Message};

const PING: Duration = Duration::from_secs(25);
/// A ping must be answered (by anything from the relay) this soon, or the socket is dead.
const PONG: Duration = Duration::from_secs(10);
/// How often the socket checks for a missed pong and for the computer having slept.
const CHECK: Duration = Duration::from_secs(2);
/// The wall clock moving this much further than the monotonic one means the computer slept
/// (the monotonic clock and tokio's timers stand still meanwhile).
const SLEPT: Duration = Duration::from_secs(10);
/// A frame the socket can't take this long marks it dead.
const WRITE: Duration = Duration::from_secs(10);
/// Frames waiting for the socket.
const OUTBOX: usize = 512;
/// How often a connected computer checks whether its token is due for a refresh.
const REFRESH: Duration = Duration::from_secs(12 * 3600);
/// The error a call gets when the relay can't deliver it to an offline computer.
pub(crate) const OFFLINE: &str = "That computer is offline.";
/// Hosts keep a subscription for 10 minutes; it is renewed before then.
const RENEW: Duration = Duration::from_secs(9 * 60);
const FIRST_BACKOFF: Duration = Duration::from_secs(1);
const MAX_BACKOFF: Duration = Duration::from_secs(60);
/// A request that waited longer than this in its peer's queue is dropped unanswered by its
/// work: its caller gave up ([`super::client::TIMEOUT`]) and may have sent it again.
const EXPIRED: Duration = Duration::from_secs(super::client::TIMEOUT.as_secs() - EXPIRY_MARGIN.as_secs());
/// How long before its caller's timeout a queued request stops being run (relay transit).
const EXPIRY_MARGIN: Duration = Duration::from_secs(2);
/// A socket must stay up this long before the backoff resets.
const STABLE: Duration = Duration::from_secs(30);
pub(super) const MAX_FRAME: usize = 256 * 1024;
/// The error a call gets when the relay (or a direct link) refused it for the frame rate.
pub(super) const RATE_LIMITED: &str = "Too many requests to that computer. Try again in a moment.";
const PEER_QUEUE: usize = 64;
const MAX_PEERS: usize = 64;
const MAX_STARTS: usize = 4;
static STARTS: std::sync::OnceLock<std::sync::Arc<tokio::sync::Semaphore>> = std::sync::OnceLock::new();
/// Relay close codes: another socket replaced this one, or the device was revoked.
const REPLACED: u16 = 4000;
const REVOKED: u16 = 4001;

#[derive(Debug, PartialEq)]
enum Outcome {
    Closed { up: Duration, code: Option<u16> },
    /// The computer slept: the socket is surely dead, so reconnect at once.
    Woke,
    Failed,
    Unauthorized,
}

/// (wait now, base for the next failure), or None to sign out. The first retry after a
/// stable socket (or a wake) is immediate, then 1 s, 2 s, 4 s… up to a minute.
fn backoff(delay: Duration, outcome: &Outcome) -> Option<(Duration, Duration)> {
    let base = match outcome {
        Outcome::Unauthorized | Outcome::Closed { code: Some(REVOKED), .. } => return None,
        Outcome::Woke => Duration::ZERO,
        Outcome::Closed { up, .. } if *up >= STABLE => Duration::ZERO,
        _ => delay,
    };
    let wait = if matches!(outcome, Outcome::Closed { code: Some(REPLACED), .. }) { base.max(MAX_BACKOFF) } else { base };
    Some((wait, (base * 2).clamp(FIRST_BACKOFF, MAX_BACKOFF)))
}

/// Spreads waits over 75–125 %, so computers that lost the relay together don't return together.
fn jitter(wait: Duration, random: f64) -> Duration {
    wait.mul_f64(0.75 + 0.5 * random.clamp(0.0, 1.0))
}

/// Whether the wall clock ran ahead of the monotonic clock: the computer slept.
fn slept(wall: Option<Duration>, monotonic: Duration) -> bool {
    wall.is_some_and(|wall| wall > monotonic + SLEPT)
}

/// Whether a ping sent at `since` went unanswered too long.
fn unanswered(since: Option<Instant>, now: Instant) -> bool {
    since.is_some_and(|since| now.saturating_duration_since(since) > PONG)
}

/// Sends one frame, or false when the socket failed or could not take it in time.
async fn send<S: futures_util::Sink<Message> + Unpin>(write: &mut S, message: Message) -> bool {
    matches!(tokio::time::timeout(WRITE, write.send(message)).await, Ok(Ok(())))
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
    tauri::async_runtime::spawn(routes::supervise(app.clone(), generation));
}

pub(super) fn current(app: &tauri::AppHandle, generation: u64) -> bool {
    remote(app).lock().generation == generation
}

/// The relay is gone: its calls fail, except those to a device with a direct link up, which
/// may still be answered on it.
fn fail_relayed(inner: &mut Inner) {
    let lost: Vec<String> = inner.pending.iter().filter(|(_, (device, _))| !routes::direct(device)).map(|(id, _)| id.clone()).collect();
    for id in lost {
        if let Some((_, reply)) = inner.pending.remove(&id) {
            let _ = reply.send(Err(super::client::LOST.to_owned()));
        }
    }
}

async fn run(app: tauri::AppHandle, generation: u64) {
    let mut delay = Duration::ZERO;
    let mut attempt = "socket.connecting";
    while current(&app, generation) {
        let Some(token) = remote(&app).lock().token.clone() else { return };
        super::diagnostics::record(attempt, "");
        let outcome = session(&app, generation, &token).await;
        attempt = record_outcome(&outcome);
        let changed = {
            let state = remote(&app);
            let mut inner = state.lock();
            let changed = inner.generation == generation && inner.connected;
            if inner.generation == generation {
                inner.connected = false;
                inner.outbox = None;
                inner.presence = false;
                fail_relayed(&mut inner);
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
        if !wait.is_zero() {
            tokio::time::sleep(jitter(wait, (uuid::Uuid::new_v4().as_u128() % 1000) as f64 / 1000.0)).await;
        }
        delay = next;
    }
}

/// Logs how a socket ended; returns the kind of the next attempt.
fn record_outcome(outcome: &Outcome) -> &'static str {
    let (kind, detail, next) = match outcome {
        Outcome::Closed { up, code } => ("socket.close", format!("Closed after {}s{}", up.as_secs(), code.map(|c| format!(" (code {c})")).unwrap_or_default()), "socket.reconnect"),
        Outcome::Woke => ("socket.close", "The computer slept".to_owned(), "socket.reconnect"),
        Outcome::Failed => ("socket.error", "Could not reach the relay".to_owned(), "socket.retry"),
        Outcome::Unauthorized => ("socket.error", "The relay refused the sign-in".to_owned(), "socket.retry"),
    };
    super::diagnostics::record(kind, detail);
    next
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
    let stream = match tokio::time::timeout(Duration::from_secs(15), tokio_tungstenite::connect_async_tls_with_config(request, Some(limits), false, Some(tls()))).await {
        Ok(Ok((stream, _))) => stream,
        Ok(Err(tungstenite::Error::Http(response))) if matches!(response.status().as_u16(), 401 | 403) => return Outcome::Unauthorized,
        _ => return Outcome::Failed,
    };
    let opened = Instant::now();
    let (mut write, mut read) = stream.split();
    let (tx, mut rx) = mpsc::channel::<String>(OUTBOX);
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
    super::diagnostics::record("socket.open", "");
    emit_status(app);
    let closed = |code| Outcome::Closed { up: opened.elapsed(), code };
    // Hosting was toggled while connecting, before the outbox could carry it.
    if host_enabled != hosting && !send(&mut write, Message::text(json!({"kind": "host", "enabled": host_enabled}).to_string())).await {
        return closed(None);
    }
    let mut ping = tokio::time::interval_at(tokio::time::Instant::now() + PING, PING);
    let mut check = tokio::time::interval_at(tokio::time::Instant::now() + CHECK, CHECK);
    // The first subscription follows the first presence frame.
    let mut renew = tokio::time::interval_at(tokio::time::Instant::now() + RENEW, RENEW);
    // Browse discovery has its own cadence; subscription renewal alone is only every nine minutes.
    let mut browse = tokio::time::interval_at(tokio::time::Instant::now() + super::browse::REFRESH_EVERY, super::browse::REFRESH_EVERY);
    // The first tick is now: a token is checked at connect, then every 12 h.
    let mut refresh = tokio::time::interval(REFRESH);
    // An unanswered ping, and the clocks at the last check.
    let mut pinged: Option<Instant> = None;
    let (mut wall, mut monotonic) = (SystemTime::now(), Instant::now());
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
                Some(text) => if !send(&mut write, Message::text(text)).await { return closed(None) },
                None => {
                    let _ = send(&mut write, Message::Close(None)).await;
                    return closed(None);
                }
            },
            _ = renew.tick() => mirror::subscribe_soon(app),
            _ = browse.tick() => {
                if !remote(app).lock().settings.browsed.is_empty() {
                    mirror::subscribe_soon(app);
                }
            },
            _ = ping.tick() => {
                if !send(&mut write, Message::text("ping")).await {
                    return closed(None);
                }
                pinged.get_or_insert_with(Instant::now);
            }
            _ = check.tick() => {
                let (now_wall, now) = (SystemTime::now(), Instant::now());
                if slept(now_wall.duration_since(wall).ok(), now.duration_since(monotonic)) {
                    return Outcome::Woke;
                }
                if unanswered(pinged, now) {
                    return closed(None);
                }
                (wall, monotonic) = (now_wall, now);
            }
            incoming = read.next() => {
                // Anything from the relay answers the ping.
                pinged = None;
                match incoming {
                    Some(Ok(Message::Text(text))) => frame(app, text.as_str()),
                    Some(Ok(Message::Close(close))) => return closed(close.map(|frame| u16::from(frame.code))),
                    Some(Err(_)) | None => return closed(None),
                    Some(Ok(_)) => {}
                }
            }
        }
    }
}

/// One TLS config for every relay connect: rustls keeps session tickets in it, so a reconnect
/// resumes instead of receiving and checking the certificate chain again. That saves bytes and
/// CPU, not a round trip (TLS 1.3 takes one either way). 0-RTT early data is not used: a
/// replayed upgrade would replace this device's socket at the relay (close 4000, a minute's
/// backoff), and the relay can't tell a replay apart.
pub(super) fn tls() -> tokio_tungstenite::Connector {
    static CONFIG: std::sync::OnceLock<std::sync::Arc<rustls::ClientConfig>> = std::sync::OnceLock::new();
    let config = CONFIG.get_or_init(|| {
        let roots = rustls::RootCertStore { roots: webpki_roots::TLS_SERVER_ROOTS.to_vec() };
        std::sync::Arc::new(rustls::ClientConfig::builder().with_root_certificates(roots).with_no_client_auth())
    });
    tokio_tungstenite::Connector::Rustls(config.clone())
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

/// An opened request, its pair key, and when it entered this peer's bounded queue.
struct Request {
    message: Value,
    key: crypto::Key,
    queued_at: Instant,
}

impl Request {
    fn new(message: Value, key: crypto::Key) -> Self {
        Self { message, key, queued_at: Instant::now() }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Lane {
    /// Overlapping, up to a small bound: reads, and `task.cancelStart`, which must never
    /// wait behind the start it cancels.
    Read,
    /// One at a time, in arrival order: everything that changes a task.
    Ordered,
    /// Each start (`task.start`, `github.startTask`, `chat.start`) on its own, holding one of
    /// the computer's [`MAX_STARTS`] slots: a clone can take minutes, and stops, answers and
    /// prompts must not wait behind it.
    Start,
    /// Slow registry methods (`methods::lane_for`: a push, checks, a model call) beside the
    /// ordered lane, up to [`BACKGROUND_PER_PEER`] at once.
    Background,
    /// Read-only methods the phone waits long for (`methods::slow_read_timeout`: `gh`, a usage
    /// refresh, a design render), up to [`SLOW_READS_PER_PEER`] at once, so they never take the
    /// read slots a reconnect's `subscribe`, `tasks.list` and `task.messages` need.
    SlowRead,
}

fn lane(method: &str) -> Lane {
    match method {
        "task.start" => Lane::Start,
        "batch" | "task.cancelStart" => Lane::Read,
        // Round 23: a merge waits on GitHub up to the phone's 60 s (`MERGE_TIMEOUT_MS`), so it
        // runs beside the ordered lane instead of expiring there after 18 s; host.rs lets one
        // merge per task run at a time (`claim_merge`).
        "task.pullMerge" => Lane::Background,
        method if super::methods::slow_read_timeout(method).is_some() && host::is_read_only_method(method) => Lane::SlowRead,
        method if host::is_read_only_method(method) => Lane::Read,
        method => match super::methods::lane_for(method) {
            Some(super::methods::Lane::Start) => Lane::Start,
            Some(super::methods::Lane::Background) => Lane::Background,
            None => Lane::Ordered,
        },
    }
}

#[derive(Default)]
struct PendingRequests {
    reads: VecDeque<Request>,
    ordered: VecDeque<Request>,
    starts: VecDeque<Request>,
    background: VecDeque<Request>,
    slow_reads: VecDeque<Request>,
}

impl PendingRequests {
    fn len(&self) -> usize {
        self.reads.len() + self.ordered.len() + self.starts.len() + self.background.len() + self.slow_reads.len()
    }

    fn push(&mut self, request: Request) {
        match lane(request.message["method"].as_str().unwrap_or_default()) {
            Lane::Read => self.reads.push_back(request),
            Lane::Ordered => self.ordered.push_back(request),
            Lane::Start => self.starts.push_back(request),
            Lane::Background => self.background.push_back(request),
            Lane::SlowRead => self.slow_reads.push_back(request),
        }
    }

    /// The next ordinary read, while fewer than [`READS_PER_PEER`] run.
    fn next_read(&mut self, active: &mut usize) -> Option<Request> {
        if *active >= READS_PER_PEER {
            return None;
        }
        let request = self.reads.pop_front()?;
        *active += 1;
        Some(request)
    }

    /// The next slow read, while fewer than [`SLOW_READS_PER_PEER`] run.
    fn next_slow_read(&mut self, active: &mut usize) -> Option<Request> {
        if *active >= SLOW_READS_PER_PEER {
            return None;
        }
        let request = self.slow_reads.pop_front()?;
        *active += 1;
        Some(request)
    }

    /// The next slow call, while fewer than [`BACKGROUND_PER_PEER`] run.
    fn next_background(&mut self, active: &mut usize) -> Option<Request> {
        if *active >= BACKGROUND_PER_PEER {
            return None;
        }
        let request = self.background.pop_front()?;
        *active += 1;
        Some(request)
    }

    fn next_ordered(&mut self, active: &mut bool) -> Option<Request> {
        if *active {
            return None;
        }
        let request = self.ordered.pop_front()?;
        *active = true;
        Some(request)
    }
}

struct SendStats {
    payload_bytes: usize,
    frame_bytes: usize,
    json_micros: u128,
    seal_micros: u128,
}

/// One relay frame: presence, delivery failures and errors, or an encrypted message.
fn frame(app: &tauri::AppHandle, text: &str) {
    if text == "pong" {
        return;
    }
    let Ok(value) = serde_json::from_str::<Value>(text) else { return };
    match value["kind"].as_str() {
        Some("presence") => presence(app, &value["devices"]),
        Some("undeliverable") => {
            if let Some(to) = value["to"].as_str() {
                let error = if value["reason"] == "rate" { RATE_LIMITED } else { OFFLINE };
                remote(app).lock().fail_ref(to, value["ref"].as_str(), error);
            }
        }
        Some("error") => eprintln!("PandaCode Connect relay: {}", value["error"].as_str().unwrap_or("error")),
        _ => {
            let (Some(from), Some(to), Some(body)) = (value["from"].as_str(), value["to"].as_str(), value["body"].as_str()) else { return };
            sealed(app, from, to, body);
        }
    }
}

/// An encrypted message from `from` to `to`, off the relay or a direct link: opened with the
/// pair key from `from`'s presence key. Responses and events are handled at once; only
/// requests wait in their peer's queue.
pub(super) fn sealed(app: &tauri::AppHandle, from: &str, to: &str, body: &str) {
    if host::valid_id(from).is_err() {
        return;
    }
    let me = remote(app).device_id();
    if to != me || from == me {
        return;
    }
    let Ok(key) = peer_key(app, from) else { return };
    let Ok((plain, packed)) = crypto::open_packed(&key, from, to, body) else { return };
    let Ok(message) = serde_json::from_slice::<Value>(&plain) else { return };
    if matches!(message["type"].as_str(), Some("res" | "event")) && !fresh(app, from, &message) {
        return;
    }
    match message["type"].as_str() {
        // No viewer packs requests: one that comes packed is refused like any unreadable frame.
        Some("req") if packed => {}
        Some("req") => queue(app, from, (message, key)),
        Some("res") => super::client::resolve(app, from, &message),
        Some("event") => match message["name"].as_str() {
            Some("agent.events") => mirror::events(app, from, &message["data"]),
            Some("run.finished") => mirror::finished(app, from, &message["data"]),
            Some("task.progress") => super::start::progress(app, from, &message["data"]),
            Some(routes::ANNOUNCE) => routes::announced(app, from, &message["data"]),
            _ => {}
        },
        _ => {}
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

/// How long a request id is remembered with its answer, and the bounds on what is kept.
const ANSWERED: Duration = Duration::from_secs(60);
const MAX_ANSWERED: usize = 512;
const MAX_ANSWER_BYTES: usize = 4 * 1024 * 1024;

enum Seen {
    Running,
    /// The answer sent, or None when it was too large to keep.
    Answered(Option<Value>, usize),
}

enum Repeat {
    New,
    Running,
    Answered(Value),
}

/// Requests by (device, id) for a minute. A viewer retries a request on the relay after its
/// direct link failed (the identical sealed frame); the copy is answered again from here, or
/// dropped while the first one runs, so a request never runs twice whichever route carried it.
#[derive(Default)]
struct Answers {
    seen: HashMap<(String, String), (Instant, Seen)>,
    bytes: usize,
}

impl Answers {
    fn prune(&mut self, now: Instant) {
        let bytes = &mut self.bytes;
        self.seen.retain(|_, (at, seen)| {
            let keep = now.saturating_duration_since(*at) < ANSWERED;
            if let (false, Seen::Answered(Some(_), size)) = (keep, seen) {
                *bytes -= *size;
            }
            keep
        });
    }

    fn arrive(&mut self, from: &str, id: &str, now: Instant) -> Repeat {
        self.prune(now);
        let key = (from.to_owned(), id.to_owned());
        match self.seen.get(&key) {
            Some((_, Seen::Running)) => return Repeat::Running,
            Some((_, Seen::Answered(Some(answer), _))) => return Repeat::Answered(answer.clone()),
            // Not kept: the copy goes on, and its repeated nonce gets it refused.
            Some((_, Seen::Answered(None, _))) => return Repeat::New,
            None => {}
        }
        if self.seen.len() >= MAX_ANSWERED {
            if let Some(oldest) = self.seen.iter().min_by_key(|(_, (at, _))| *at).map(|(key, _)| key.clone()) {
                if let Some((_, Seen::Answered(Some(_), size))) = self.seen.remove(&oldest) {
                    self.bytes -= size;
                }
            }
        }
        self.seen.insert(key, (now, Seen::Running));
        Repeat::New
    }

    fn answered(&mut self, to: &str, id: &str, answer: &Value, size: usize) {
        let Some((_, seen)) = self.seen.get_mut(&(to.to_owned(), id.to_owned())) else { return };
        if !matches!(seen, Seen::Running) {
            return;
        }
        let kept = self.bytes + size <= MAX_ANSWER_BYTES;
        if kept {
            self.bytes += size;
        }
        *seen = Seen::Answered(kept.then(|| answer.clone()), size);
    }
}

/// Peers whose latest request said they open packed (deflated) frames (`"z": 1`); only they
/// get replies and events packed. An older app never says so, and is forgotten at its next request.
fn packing() -> std::sync::MutexGuard<'static, std::collections::HashSet<String>> {
    static PACKING: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<String>>> = std::sync::OnceLock::new();
    PACKING.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner())
}

fn packs(peer: &str, accepts: bool) {
    let mut packing = packing();
    if accepts {
        packing.insert(peer.to_owned());
    } else {
        packing.remove(peer);
    }
}

/// A plaintext as it is sealed: replies and events to a packing peer are packed. A reply
/// carries its request's `"z"` (`packs`), so a presence prune between the request and its
/// reply never sends a page sized for packing plain.
fn outgoing(to: &str, message: &Value, plain: String, packs: Option<bool>) -> Vec<u8> {
    if message["type"] != "req" && packs.unwrap_or_else(|| packing().contains(to)) {
        crypto::pack(plain.as_bytes())
    } else {
        plain.into_bytes()
    }
}

fn answers() -> std::sync::MutexGuard<'static, Answers> {
    static ANSWERS: std::sync::OnceLock<std::sync::Mutex<Answers>> = std::sync::OnceLock::new();
    ANSWERS.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner())
}

/// One ordered request queue per peer, shared by the relay and direct links, for one sign-in.
fn peers() -> std::sync::MutexGuard<'static, (u64, HashMap<String, mpsc::Sender<Request>>)> {
    #[allow(clippy::type_complexity)]
    static PEERS: std::sync::OnceLock<std::sync::Mutex<(u64, HashMap<String, mpsc::Sender<Request>>)>> = std::sync::OnceLock::new();
    PEERS.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner())
}

/// Queues a request for its peer. Freshness and replays are checked here, on arrival, so
/// time spent waiting in the queue never makes a valid request expire.
fn queue(app: &tauri::AppHandle, from: &str, (message, key): (Value, crypto::Key)) {
    let request = Request::new(message, key);
    if let Some(id) = request.message["id"].as_str().filter(|id| host::valid_id(id).is_ok()) {
        let repeat = answers().arrive(from, id, Instant::now());
        match repeat {
            Repeat::New => {}
            Repeat::Running => return,
            Repeat::Answered(answer) => {
                // The device may have lost access since: check as a new request would be.
                let answer = cached_reply(id, answer, still_allowed(app, from, &request.message));
                let _ = send_reply(app, from, &request, &answer);
                return;
            }
        }
    }
    let (fresh, generation) = {
        let state = remote(app);
        let mut inner = state.lock();
        (host::fresh_request(&mut inner, &request.message, chrono::Utc::now().timestamp_millis()), inner.generation)
    };
    if let Err(error) = fresh {
        return refuse(app, from, request, &error);
    }
    // Only a fresh request may change how this peer's replies are sealed.
    packs(from, request.message["z"] == 1);
    let refused = {
        let mut peers = peers();
        if peers.0 != generation {
            // Another sign-in or a reconnect: dropping the senders stops the old workers.
            *peers = (generation, HashMap::new());
        }
        let peers = &mut peers.1;
        if !peers.contains_key(from) && peers.len() >= MAX_PEERS {
            Some(request)
        } else {
            let tx = peers.entry(from.to_owned()).or_insert_with(|| {
                let (tx, rx) = mpsc::channel(PEER_QUEUE);
                tauri::async_runtime::spawn(peer(app.clone(), from.to_owned(), rx));
                tx
            });
            tx.try_send(request).err().map(|error| error.into_inner())
        }
    };
    if let Some(request) = refused {
        busy(app, from, request);
    }
}

/// `host::handle`'s admission for a repeated request answered from [`Answers`]: remote
/// control on, the sender in presence, and its grant (for a batch, every call's).
fn still_allowed(app: &tauri::AppHandle, from: &str, message: &Value) -> Result<()> {
    {
        let state = remote(app);
        let inner = state.lock();
        host::gate(inner.settings.host_enabled)?;
        inner.callable(from)?;
    }
    granted_methods(message).into_iter().try_for_each(|method| super::grants::check(app, from, method))
}

/// The methods a request needs a grant for: its own and each batch call's. `pair.redeem` needs
/// none (a pending device redeems a code; its answer is a refusal or its new scope).
fn granted_methods(message: &Value) -> Vec<&str> {
    let method = message["method"].as_str().unwrap_or_default();
    if method == super::grants::REDEEM {
        return Vec::new();
    }
    let calls = if method == "batch" { message["params"]["calls"].as_array().map(Vec::as_slice).unwrap_or_default() } else { &[] };
    std::iter::once(method).chain(calls.iter().map(|call| call["method"].as_str().unwrap_or_default())).collect()
}

fn cached_reply(id: &str, answer: Value, allowed: Result<()>) -> Value {
    match allowed {
        Ok(()) => answer,
        Err(error) => json!({"type": "res", "id": id, "ok": false, "error": error}),
    }
}

/// Refuses a request at once instead of dropping it, so the caller doesn't wait for its timeout.
fn busy(app: &tauri::AppHandle, from: &str, request: Request) {
    refuse(app, from, request, "This computer is busy. Try again in a moment.");
}

fn refuse(app: &tauri::AppHandle, from: &str, request: Request, error: &str) {
    let failure = json!({"type": "res", "id": request.message["id"], "ok": false, "error": error});
    let _ = send_reply(app, from, &request, &failure);
}

/// The refusal of a request that waited too long. It never ran, and neither did an earlier copy
/// with its `sendId` (that one is answered instead), so the phone may drop its bubble. Hosts
/// before this said "...and was dropped. Try again." even when an earlier copy had run.
pub(crate) const NOT_RUN: &str = "This request waited too long on the other computer and did not run. Try again.";

/// Whether a request waited so long that its caller gave up; running it now could run a
/// retried prompt twice. A start is kept: `startId` makes a repeated one harmless. A background
/// call gets the slow method's own, longer timeout the phone waits for it
/// (`methods::background_timeout`: a `git.commit` queued behind `checks.run` and `git.push` is
/// still wanted), less the same margin, so a call the phone gave up on never runs late and a
/// manual retry never runs it twice. Only queued requests expire; a running one finishes.
fn expired(message: &Value, waited: Duration) -> bool {
    let method = message["method"].as_str().unwrap_or_default();
    match lane(method) {
        Lane::Start => false,
        Lane::Background => waited >= super::methods::background_timeout(method, &message["params"]).saturating_sub(EXPIRY_MARGIN),
        Lane::SlowRead => waited >= super::methods::slow_read_timeout(method).unwrap_or(super::client::TIMEOUT).saturating_sub(EXPIRY_MARGIN),
        Lane::Read | Lane::Ordered => waited >= EXPIRED,
    }
}

const READS_PER_PEER: usize = 4;
/// Slow read-only methods one phone runs at once, beside its [`READS_PER_PEER`] ordinary reads.
const SLOW_READS_PER_PEER: usize = 2;
/// Slow registry methods one phone runs at once beside its ordered lane.
const BACKGROUND_PER_PEER: usize = 2;

/// Read-only requests overlap up to a small bound. State-changing requests share one FIFO
/// lane; each start runs on its own and slow registry methods run beside it, a few at a time.
/// Response ids let replies return in any order.
async fn peer(app: tauri::AppHandle, from: String, mut requests: mpsc::Receiver<Request>) {
    let mut pending = PendingRequests::default();
    let mut in_flight = FuturesUnordered::<BoxFuture<'static, Lane>>::new();
    let mut active_reads = 0usize;
    let mut active_starts = 0usize;
    let mut active_background = 0usize;
    let mut active_slow_reads = 0usize;
    let mut ordered_active = false;
    let mut input_open = true;

    loop {
        while let Some(request) = pending.starts.pop_front() {
            active_starts += 1;
            let (app, from) = (app.clone(), from.clone());
            in_flight.push(Box::pin(async move {
                answer(&app, &from, request).await;
                Lane::Start
            }));
        }
        while let Some(request) = pending.next_read(&mut active_reads) {
            let (app, from) = (app.clone(), from.clone());
            in_flight.push(Box::pin(async move {
                answer(&app, &from, request).await;
                Lane::Read
            }));
        }
        while let Some(request) = pending.next_slow_read(&mut active_slow_reads) {
            let (app, from) = (app.clone(), from.clone());
            in_flight.push(Box::pin(async move {
                answer(&app, &from, request).await;
                Lane::SlowRead
            }));
        }
        while let Some(request) = pending.next_background(&mut active_background) {
            let (app, from) = (app.clone(), from.clone());
            in_flight.push(Box::pin(async move {
                answer(&app, &from, request).await;
                Lane::Background
            }));
        }
        if let Some(request) = pending.next_ordered(&mut ordered_active) {
            let (app, from) = (app.clone(), from.clone());
            in_flight.push(Box::pin(async move {
                answer(&app, &from, request).await;
                Lane::Ordered
            }));
        }
        if !input_open && pending.len() == 0 && in_flight.is_empty() {
            break;
        }

        tokio::select! {
            request = requests.recv(), if input_open => match request {
                Some(request) if pending.len() + active_reads + active_slow_reads + active_starts + active_background + usize::from(ordered_active) < PEER_QUEUE => pending.push(request),
                Some(request) => busy(&app, &from, request),
                None => input_open = false,
            },
            completed = in_flight.next(), if !in_flight.is_empty() => match completed {
                Some(Lane::Read) => active_reads -= 1,
                Some(Lane::Start) => active_starts -= 1,
                Some(Lane::Background) => active_background -= 1,
                Some(Lane::SlowRead) => active_slow_reads -= 1,
                Some(Lane::Ordered) => ordered_active = false,
                None => {}
            },
        }
    }
}

async fn answer(app: &tauri::AppHandle, from: &str, request: Request) {
    let method = request.message["method"].as_str().unwrap_or("unknown").to_owned();
    let queue_wait = request.queued_at.elapsed();
    // A prompt or once-method whose `sendId` already ran (or runs now) still goes through: the
    // host answers its first reply.
    if expired(&request.message, queue_wait) && !host::already_sent(from, &request.message) {
        return refuse(app, from, request, NOT_RUN);
    }
    let method = method.as_str();
    let starts = lane(method) == Lane::Start;
    let start_waiting = Instant::now();
    let _start_permit = if starts {
        Some(STARTS.get_or_init(|| std::sync::Arc::new(tokio::sync::Semaphore::new(MAX_STARTS))).clone().acquire_owned().await.ok())
    } else {
        None
    };
    let start_slot_wait = if starts { start_waiting.elapsed() } else { Duration::ZERO };
    let handling = Instant::now();
    let response = host::handle(app, from, &request.message).await;
    let handle_time = handling.elapsed();
    let mut send_stats = None;
    if let Some(response) = response {
        match send_reply(app, from, &request, &response) {
            Ok(stats) => send_stats = Some(stats),
            Err(error) => {
                let failure = json!({"type": "res", "id": response["id"], "ok": false, "error": error});
                send_stats = send_reply(app, from, &request, &failure).ok();
            }
        }
    }
    if std::env::var_os("PANDACODE_CONNECT_TIMING").is_some() {
        let stats = send_stats;
        eprintln!(
            "PandaCode Connect timing method={method} queue_wait_ms={} start_slot_wait_ms={} handle_ms={} json_ms={} seal_ms={} payload_bytes={} frame_bytes={}",
            queue_wait.as_secs_f64() * 1000.0,
            start_slot_wait.as_secs_f64() * 1000.0,
            handle_time.as_secs_f64() * 1000.0,
            stats.as_ref().map(|stats| stats.json_micros as f64 / 1000.0).unwrap_or_default(),
            stats.as_ref().map(|stats| stats.seal_micros as f64 / 1000.0).unwrap_or_default(),
            stats.as_ref().map(|stats| stats.payload_bytes).unwrap_or_default(),
            stats.as_ref().map(|stats| stats.frame_bytes).unwrap_or_default(),
        );
    }
}

/// Applies a presence list, which carries the full device rows. A host that comes online (or restarted, forgetting subscriptions) is subscribed again.
fn presence(app: &tauri::AppHandle, list: &Value) {
    let Some(list) = list.as_array() else { return };
    // The socket's first presence: subscribe at once, with the catch-up alongside.
    let (renamed, first) = {
        let state = remote(app);
        let mut inner = state.lock();
        let first = !inner.presence;
        apply_presence(&mut inner, list);
        prune_packing(&mut packing(), &inner.devices);
        super::orchestrate::links::remember_presence(&inner.devices);
        (super::remember_names(&inner.devices), first)
    };
    emit_presence(app);
    if renamed {
        use tauri::Emitter;
        let _ = app.emit("sessions-changed", ());
    }
    super::grants::presence(app);
    if first {
        mirror::subscribe_reconnected(app);
    } else {
        mirror::subscribe_soon(app);
    }
    routes::presence(app);
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

/// A device gone from presence is forgotten as a packing peer too.
fn prune_packing(packing: &mut std::collections::HashSet<String>, devices: &[Device]) {
    packing.retain(|id| devices.iter().any(|d| &d.id == id));
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
pub(super) fn peer_key(app: &tauri::AppHandle, device_id: &str) -> Result<crypto::Key> {
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

/// Adds `ts` and a fresh `nonce`, so the receiver can refuse replays (docs/remote-access.md),
/// and on requests `"z": 1`: this computer opens packed replies and events.
fn stamp(message: &Value, now_ms: i64) -> Value {
    let mut message = message.clone();
    message["ts"] = json!(now_ms);
    message["nonce"] = json!(uuid::Uuid::new_v4().simple().to_string());
    if message["type"] == "req" {
        message["z"] = json!(1);
    }
    message
}

/// Seals a stamped message with a known key and queues it as `{to, body, ref}` on the
/// device's direct link when one is up, else on the relay socket. Replies go straight out;
/// only mirrored event frames use the 100 ms flush.
fn send_sealed(app: &tauri::AppHandle, to: &str, key: &crypto::Key, message: &Value) -> Result<SendStats> {
    seal_and_send(app, to, key, message, true, None)
}

/// [`send_sealed`] for a reply to `request`, packed exactly when the request said `"z": 1`.
fn send_reply(app: &tauri::AppHandle, to: &str, request: &Request, message: &Value) -> Result<SendStats> {
    seal_and_send(app, to, &request.key, message, true, Some(request.message["z"] == 1))
}

fn seal_and_send(app: &tauri::AppHandle, to: &str, key: &crypto::Key, message: &Value, direct: bool, packs: Option<bool>) -> Result<SendStats> {
    let me = remote(app).device_id();
    let json_started = Instant::now();
    let plain = stamp(message, chrono::Utc::now().timestamp_millis()).to_string();
    let payload_bytes = plain.len();
    let mut json_micros = json_started.elapsed().as_micros();
    let seal_started = Instant::now();
    let body = crypto::seal(key, &me, to, &outgoing(to, message, plain, packs))?;
    let seal_micros = seal_started.elapsed().as_micros();
    let mut frame = json!({"to": to, "body": body});
    if let Some(id) = message["id"].as_str() {
        frame["ref"] = json!(id);
    }
    let json_started = Instant::now();
    let frame = frame.to_string();
    json_micros += json_started.elapsed().as_micros();
    if frame.len() > MAX_FRAME {
        return Err("That reply is too large to send to another computer.".into());
    }
    let frame_bytes = frame.len();
    let stats = SendStats { payload_bytes, frame_bytes, json_micros, seal_micros };
    let id = message["id"].as_str();
    if let (Some("res"), Some(id)) = (message["type"].as_str(), id) {
        answers().answered(to, id, message, payload_bytes);
    }
    if !direct {
        return relay(app, frame).map(|_| stats);
    }
    let request = id.filter(|_| message["type"] == "req").map(|id| (id, message["method"].as_str().unwrap_or_default()));
    match routes::send(to, frame, request) {
        Ok(()) => Ok(stats),
        Err(frame) => relay(app, frame).map(|_| stats),
    }
}

/// Queues a sealed frame on the relay socket.
pub(super) fn relay(app: &tauri::AppHandle, frame: String) -> Result<()> {
    let state = remote(app);
    let inner = state.lock();
    let outbox = inner.outbox.as_ref().ok_or("Not connected to the relay.")?;
    outbox.try_send(frame).map_err(|error| match error {
        mpsc::error::TrySendError::Full(_) => "Too much is waiting to go to the relay. Try again in a moment.",
        mpsc::error::TrySendError::Closed(_) => "Not connected to the relay.",
    })?;
    Ok(())
}

/// Seals a request or event to the device's current key from presence.
pub(crate) fn send_to_device(app: &tauri::AppHandle, to: &str, message: &Value) -> Result<()> {
    remote(app).lock().callable(to)?;
    let key = peer_key(app, to)?;
    send_sealed(app, to, &key, message).map(|_| ())
}

/// Like [`send_to_device`], on the relay only: route announcements.
pub(super) fn send_relay(app: &tauri::AppHandle, to: &str, message: &Value) -> Result<()> {
    remote(app).lock().callable(to)?;
    let key = peer_key(app, to)?;
    seal_and_send(app, to, &key, message, false, None).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_peers_that_ask_get_packed_frames() {
        let event = json!({"type": "event", "name": "agent.events", "data": {"events": vec!["same text"; 500]}});
        let plain = event.to_string();
        assert_eq!(stamp(&json!({"type": "req"}), 1)["z"], 1);
        assert!(stamp(&event, 1).get("z").is_none());
        // An older app never sent "z": it gets plain JSON.
        assert_eq!(outgoing("old-peer", &event, plain.clone(), None), plain.as_bytes());
        packs("new-peer", true);
        assert_eq!(outgoing("new-peer", &event, plain.clone(), None)[0], b'z');
        // Requests and small frames stay plain; a downgrade is noticed at the next request.
        assert_eq!(outgoing("new-peer", &json!({"type": "req"}), plain.clone(), None), plain.as_bytes());
        assert_eq!(outgoing("new-peer", &event, "{}".into(), None), b"{}");
        packs("new-peer", false);
        assert_eq!(outgoing("new-peer", &event, plain.clone(), None), plain.as_bytes());
        // A reply follows its own request, whatever the set says by the time it goes out.
        let reply = json!({"type": "res", "result": {"messages": vec!["same text"; 500]}});
        let text = reply.to_string();
        assert_eq!(outgoing("new-peer", &reply, text.clone(), Some(true))[0], b'z', "a prune after the request still packs its reply");
        packs("new-peer", true);
        assert_eq!(outgoing("new-peer", &reply, text.clone(), Some(false)), text.as_bytes());
        packs("new-peer", false);
    }

    #[test]
    fn state_changing_requests_keep_arrival_order_while_reads_use_a_separate_lane() {
        let mut pending = PendingRequests::default();
        for method in ["task.send", "task.messages", "task.stop", "task.start", "task.diff"] {
            pending.push(Request { message: json!({"method": method}), key: [0; 32], queued_at: Instant::now() });
        }
        let ordered = pending.ordered.iter().map(|request| request.message["method"].as_str().unwrap()).collect::<Vec<_>>();
        let reads = pending.reads.iter().map(|request| request.message["method"].as_str().unwrap()).collect::<Vec<_>>();
        assert_eq!(ordered, ["task.send", "task.stop"]);
        assert_eq!(reads, ["task.messages", "task.diff"]);
        assert_eq!(pending.starts.len(), 1, "a start never holds the ordered lane");
        let mut active = false;
        assert_eq!(pending.next_ordered(&mut active).unwrap().message["method"], "task.send");
        assert!(pending.next_ordered(&mut active).is_none(), "ordered calls never overlap");
        active = false;
        assert_eq!(pending.next_ordered(&mut active).unwrap().message["method"], "task.stop");
        pending.push(Request { message: json!({"method": "batch"}), key: [0; 32], queued_at: Instant::now() });
        assert_eq!(pending.reads.back().unwrap().message["method"], "batch");
    }

    #[test]
    fn a_repeated_request_is_checked_again_before_its_cached_answer() {
        let batch = json!({"method": "batch", "params": {"calls": [{"method": "tasks.list"}, {"method": "task.start"}]}});
        assert_eq!(granted_methods(&batch), ["batch", "tasks.list", "task.start"]);
        assert_eq!(granted_methods(&json!({"method": "task.send"})), ["task.send"]);
        assert!(granted_methods(&json!({"method": super::super::grants::REDEEM})).is_empty());
        let answer = json!({"type": "res", "id": "r1", "ok": true, "result": {"secret": 1}});
        assert_eq!(cached_reply("r1", answer.clone(), Ok(())), answer);
        let refused = cached_reply("r1", answer, Err("This device can only view tasks on Mac.".into()));
        assert_eq!((refused["ok"].as_bool(), refused["result"].is_null(), refused["id"].as_str()), (Some(false), true, Some("r1")));
    }

    #[test]
    fn stops_and_answers_never_wait_behind_a_start() {
        assert_eq!(lane("task.start"), Lane::Start);
        for method in ["task.stop", "approval.respond", "input.respond", "task.send"] {
            assert_eq!(lane(method), Lane::Ordered, "{method}");
        }
        // Round 23: a merge never holds up a Stop, and waits as long as the phone does.
        assert_eq!(lane("task.pullMerge"), Lane::Background);
        // Cancelling and asking about a start overlap with it.
        for method in ["task.cancelStart", "task.startStatus", "subscribe", "batch"] {
            assert_eq!(lane(method), Lane::Read, "{method}");
        }
    }

    #[test]
    fn a_request_its_caller_gave_up_on_is_dropped() {
        let call = |method: &str| json!({"method": method, "params": {}});
        let s = Duration::from_secs;
        assert!(EXPIRED < super::super::client::TIMEOUT);
        assert!(!expired(&call("task.send"), s(5)));
        assert!(expired(&call("task.send"), EXPIRED));
        assert!(expired(&call("approval.respond"), s(60)));
        assert!(!expired(&call("task.start"), s(600)), "startId makes a repeated start harmless");
        for method in ["github.startTask", "chat.start"] {
            assert!(!expired(&call(method), s(600)), "{method}");
        }
        // The phone still waits for a queued slow call while its own, longer timeout runs...
        for (method, waited) in [("checks.run", 140), ("git.push", 80), ("git.commit", 50), ("pull.create", 80), ("recipes.run", 40), ("btw.ask", 50), ("vm.start", 50)] {
            assert!(!expired(&call(method), s(waited)), "the phone still waits for a queued {method}");
        }
        // ...but not past it: a btw.ask queued behind checks.run and git.push never runs late.
        for (method, waited) in [("checks.run", 148), ("git.push", 88), ("git.commit", 58), ("btw.ask", 58), ("vm.stop", 58), ("recipes.run", 43), ("moodboards.add", 18), ("rewind.to", 18)] {
            assert!(expired(&call(method), s(waited)), "{method} after {waited} s");
        }
        // Round 23: a queued merge is still wanted for the phone's 60 s, not refused after 18 s.
        assert!(!expired(&call("task.pullMerge"), s(50)), "the phone still waits for a queued merge");
        assert!(expired(&call("task.pullMerge"), s(58)));
        let commit = |push: bool| json!({"method": "git.commit", "params": {"push": push}});
        assert!(!expired(&commit(true), s(80)), "a commit with a push gets the push timeout");
        assert!(expired(&commit(false), s(80)));
    }

    #[test]
    fn registry_starts_take_the_start_lane_and_slow_methods_run_beside_the_ordered_one() {
        for method in ["github.startTask", "chat.start"] {
            assert_eq!(lane(method), Lane::Start, "{method}");
        }
        for method in ["checks.run", "git.push", "git.commit", "pull.create", "worktree.merge", "worktree.remove", "btw.ask", "recipes.run"] {
            assert_eq!(lane(method), Lane::Background, "{method}");
        }
        assert_eq!(lane("thread.rename"), Lane::Ordered);
        assert_eq!(lane("github.repos"), Lane::SlowRead);
    }

    #[test]
    fn a_slow_method_never_delays_a_stop_and_slow_ones_are_bounded_per_phone() {
        let mut pending = PendingRequests::default();
        for method in ["checks.run", "git.push", "btw.ask", "task.stop", "chat.start"] {
            pending.push(Request { message: json!({"method": method}), key: [0; 32], queued_at: Instant::now() });
        }
        assert_eq!(pending.starts.len(), 1);
        let (mut background, mut ordered) = (0, false);
        assert_eq!(pending.next_background(&mut background).unwrap().message["method"], "checks.run");
        assert_eq!(pending.next_background(&mut background).unwrap().message["method"], "git.push");
        assert!(pending.next_background(&mut background).is_none(), "at most {BACKGROUND_PER_PEER} at once");
        // Both slow calls still run, and the stop goes at once.
        assert_eq!(pending.next_ordered(&mut ordered).unwrap().message["method"], "task.stop");
        background -= 1;
        assert_eq!(pending.next_background(&mut background).unwrap().message["method"], "btw.ask");
        assert_eq!(pending.len(), 1);
    }

    #[test]
    fn slow_reads_never_take_the_read_slots_core_reads_catch_up_through() {
        let mut pending = PendingRequests::default();
        let slow = ["github.repos", "github.pulls", "usage.get", "usage.limits", "design.preview", "settings.providers", "projects.recentRepos"];
        for method in slow.iter().chain(["subscribe", "tasks.list", "task.messages", "batch", "host.hello"].iter()) {
            pending.push(Request { message: json!({"method": method}), key: [0; 32], queued_at: Instant::now() });
        }
        assert_eq!(pending.slow_reads.len(), slow.len());
        let (mut reads, mut slow_reads) = (0, 0);
        assert_eq!(pending.next_slow_read(&mut slow_reads).unwrap().message["method"], "github.repos");
        assert_eq!(pending.next_slow_read(&mut slow_reads).unwrap().message["method"], "github.pulls");
        assert!(pending.next_slow_read(&mut slow_reads).is_none(), "at most {SLOW_READS_PER_PEER} slow reads at once");
        // With both slow slots busy, every core read still gets an ordinary read slot.
        let core = std::iter::from_fn(|| pending.next_read(&mut reads)).map(|request| request.message["method"].as_str().unwrap().to_owned()).collect::<Vec<_>>();
        assert_eq!(core, ["subscribe", "tasks.list", "task.messages", "batch"]);
        assert!(pending.next_read(&mut reads).is_none(), "at most {READS_PER_PEER} reads at once");
        reads -= 1;
        assert_eq!(pending.next_read(&mut reads).unwrap().message["method"], "host.hello");
        slow_reads -= 1;
        assert_eq!(pending.next_slow_read(&mut slow_reads).unwrap().message["method"], "usage.get");
        for method in ["subscribe", "tasks.list", "task.messages", "batch", "host.hello", "task.startStatus"] {
            assert_eq!(lane(method), Lane::Read, "{method}");
        }
    }

    #[test]
    fn a_slow_read_waits_for_its_own_phone_timeout_not_the_default() {
        let call = |method: &str| json!({"method": method, "params": {}});
        let s = Duration::from_secs;
        // Queued past the default 18 s, but the phone still waits for these...
        for (method, waited) in [("github.repos", 40), ("github.item", 40), ("usage.get", 55), ("usage.limits", 40), ("design.preview", 35), ("settings.providers", 25), ("projects.recentRepos", 25)] {
            assert!(!expired(&call(method), s(waited)), "the phone still waits for a queued {method}");
        }
        // ...and not past their own timeout less the margin.
        for (method, waited) in [("github.repos", 43), ("github.search", 43), ("usage.get", 58), ("usage.limits", 43), ("design.preview", 38), ("settings.providers", 28), ("projects.recentRepos", 28)] {
            assert!(expired(&call(method), s(waited)), "{method} after {waited} s");
        }
        // Core reads keep the default.
        for method in ["subscribe", "tasks.list", "task.messages"] {
            assert!(expired(&call(method), EXPIRED), "{method}");
            assert!(!expired(&call(method), s(10)), "{method}");
        }
    }

    #[test]
    fn sleep_and_a_dead_socket_are_found_in_seconds() {
        let s = Duration::from_secs;
        assert!(!slept(Some(s(2)), s(2)));
        assert!(!slept(Some(s(11)), s(2)), "a small clock correction");
        assert!(slept(Some(s(3600)), s(2)), "the wall clock ran on while the computer slept");
        assert!(!slept(None, s(2)), "the clock was set back");
        let now = Instant::now();
        assert!(!unanswered(None, now));
        assert!(!unanswered(Some(now - s(5)), now));
        assert!(unanswered(Some(now - PONG - s(1)), now));
        assert!(PING + PONG < Duration::from_secs(60));
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
    fn reconnects_share_one_tls_config_for_resumption() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let (tokio_tungstenite::Connector::Rustls(a), tokio_tungstenite::Connector::Rustls(b)) = (tls(), tls()) else { panic!("rustls") };
        assert!(std::sync::Arc::ptr_eq(&a, &b));
    }

    #[test]
    fn backoff_resets_only_after_a_stable_socket() {
        let s = Duration::from_secs;
        assert_eq!(backoff(s(8), &Outcome::Failed), Some((s(8), s(16))));
        assert_eq!(backoff(s(40), &Outcome::Failed), Some((s(40), s(60))));
        assert_eq!(backoff(s(8), &Outcome::Closed { up: s(5), code: None }), Some((s(8), s(16))));
        // The first retry is immediate, then 1 s, 2 s…
        assert_eq!(backoff(s(8), &Outcome::Closed { up: s(30), code: None }), Some((s(0), s(1))));
        assert_eq!(backoff(s(0), &Outcome::Failed), Some((s(0), s(1))));
        assert_eq!(backoff(s(1), &Outcome::Failed), Some((s(1), s(2))));
        assert_eq!(backoff(s(30), &Outcome::Woke), Some((s(0), s(1))), "after sleep, at once");
        assert_eq!(backoff(s(1), &Outcome::Closed { up: s(300), code: Some(REPLACED) }), Some((s(60), s(1))));
        assert_eq!(backoff(s(1), &Outcome::Closed { up: s(300), code: Some(REVOKED) }), None);
        assert_eq!(backoff(s(1), &Outcome::Unauthorized), None);
        assert_eq!(jitter(s(0), 0.7), s(0));
        assert_eq!((jitter(s(8), 0.0), jitter(s(8), 1.0)), (s(6), s(10)));
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
    fn a_device_gone_from_presence_is_no_longer_packed_for() {
        let mut inner = Inner::default();
        apply_presence(&mut inner, &[json!({"id": "kept", "online": true, "host": false})]);
        let mut set: std::collections::HashSet<String> = ["kept".into(), "gone".into()].into();
        prune_packing(&mut set, &inner.devices);
        assert_eq!(set, ["kept".to_string()].into());
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
