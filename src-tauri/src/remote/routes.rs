//! Routes to a device besides the relay: a direct end-to-end encrypted socket on the
//! local network (or Tailscale), raced against the relay (docs/remote-access.md).
//!
//! A host with remote control on listens on one random TCP port of each private address
//! (RFC 1918, link-local, CGNAT 100.64/10 for Tailscale, IPv6 ULA) and announces
//! `{addrs, port, routeKey}` to the account's other devices in a sealed relay event, so the
//! relay never sees an address. A viewer races the addresses for [`PROBE`]. The socket is
//! authenticated by a four-step handshake sealed with the pair key, which only the two devices'
//! X25519 keys can derive, bound to the route key and to fresh nonces from both sides. After
//! it the socket carries exactly the relay's sealed frames (`{to, body, ref?}`), with the
//! relay's size and rate limits. The relay stays the control plane: presence, announcements,
//! and every frame while no direct link is up.
use super::{client, crypto, diagnostics, host, mirror, remote, socket};
use crate::Result;
use futures_util::stream::FuturesUnordered;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::net::{IpAddr, SocketAddr};
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant, SystemTime};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::{protocol::WebSocketConfig, Message};
use tokio_tungstenite::WebSocketStream;

/// The sealed event that carries a host's direct route to its own devices.
pub(super) const ANNOUNCE: &str = "route.direct";
/// A direct attempt (connect, upgrade and handshake) gets this long; the relay carries
/// everything meanwhile.
const PROBE: Duration = Duration::from_millis(1500);
/// An unauthenticated socket on the listener must finish the handshake this fast.
const HANDSHAKE: Duration = Duration::from_secs(3);
const MAX_HANDSHAKES: usize = 8;
/// Handshake frames are small; anything larger is refused unparsed.
const MAX_HELLO: usize = 4096;
const REPROBE: Duration = Duration::from_secs(60);
const TICK: Duration = Duration::from_secs(2);
/// How often local addresses are compared, to notice a network change.
const NETWORK: Duration = Duration::from_secs(10);
/// The wall clock moving this much further than the monotonic one means the computer slept.
const SLEPT: Duration = Duration::from_secs(10);
const PING: Duration = Duration::from_secs(10);
/// A ping must be answered (by anything from the peer) this soon, or the link is dead.
const PONG: Duration = Duration::from_secs(4);
const WRITE: Duration = Duration::from_secs(10);
const OUTBOX: usize = 512;
/// The relay's per-socket frame rate, applied to each direct link's incoming frames.
const RATE: f64 = 20.0;
const BURST: f64 = 100.0;
const MAX_ADDRS: usize = 8;
/// Requests remembered until answered, to retry on the relay if their link fails.
const MAX_INFLIGHT: usize = 256;
const FILE: &str = "connect-routes.json";
const REFUSED: &str = "The direct route refused the handshake.";

/// Private addresses only: RFC 1918, link-local, CGNAT 100.64/10 (Tailscale), IPv6 ULA and
/// link-local. Loopback and public addresses are never used for a direct route.
pub(crate) fn private(ip: IpAddr) -> bool {
    match ip.to_canonical() {
        IpAddr::V4(v4) => v4.is_private() || v4.is_link_local() || (v4.octets()[0] == 100 && v4.octets()[1] & 0xc0 == 64),
        IpAddr::V6(v6) => v6.segments()[0] & 0xfe00 == 0xfc00 || v6.segments()[0] & 0xffc0 == 0xfe80,
    }
}

/// Addresses worth announcing: private and dialable by another device (an IPv6 link-local
/// address would need that device's own interface scope).
fn announceable(ip: IpAddr) -> bool {
    private(ip) && !matches!(ip.to_canonical(), IpAddr::V6(v6) if v6.segments()[0] & 0xffc0 == 0xfe80)
}

/// Who may open a socket on the listener: private peers. Loopback can only reach a loopback
/// listener, which is never bound outside tests.
fn allowed_peer(ip: IpAddr) -> bool {
    private(ip) || ip.to_canonical().is_loopback()
}

/// This computer's announceable addresses, IPv4 first, at most [`MAX_ADDRS`].
fn local_addrs() -> Vec<IpAddr> {
    let interfaces = if_addrs::get_if_addrs().unwrap_or_default();
    pick_addrs(interfaces.iter().filter(|interface| !interface.is_loopback()).map(|interface| interface.ip()))
}

fn pick_addrs(ips: impl Iterator<Item = IpAddr>) -> Vec<IpAddr> {
    let set: BTreeSet<IpAddr> = ips.map(|ip| ip.to_canonical()).filter(|ip| announceable(*ip)).collect();
    set.into_iter().take(MAX_ADDRS).collect()
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Settings {
    /// Race a direct route against the relay (on by default).
    direct_routes: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self { direct_routes: true }
    }
}

/// `connect-routes.json` beside the other Connect settings; missing or unreadable means defaults.
fn load(dir: &Path) -> Settings {
    std::fs::read_to_string(dir.join(FILE)).ok().and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_default()
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn limits() -> WebSocketConfig {
    WebSocketConfig::default().max_message_size(Some(socket::MAX_FRAME + 4096)).max_frame_size(Some(socket::MAX_FRAME + 4096))
}

// ---- Handshake ----

/// One handshake step. Each is sealed with the pair key in its own direction (`from|to` is
/// the AEAD's associated data, so a step can't be reflected back), names its step, and
/// carries the route key and both sides' nonces.
#[derive(serde::Serialize, serde::Deserialize, Default)]
struct Step {
    t: String,
    route: String,
    cn: String,
    #[serde(default)]
    sn: String,
    #[serde(default)]
    ts: i64,
}

fn sealed_step(kind: &str, key: &crypto::Key, from: &str, to: &str, step: &Step) -> Result<String> {
    let body = crypto::seal(key, from, to, &serde_json::to_vec(step).map_err(|e| e.to_string())?)?;
    Ok(json!({"kind": kind, "v": 1, "from": from, "to": to, "body": body}).to_string())
}

fn open_step(frame: &Value, key: &crypto::Key, from: &str, to: &str, t: &str) -> Result<Step> {
    let body = frame["body"].as_str().ok_or(REFUSED)?;
    let step: Step = serde_json::from_slice(&crypto::open(key, from, to, body).map_err(|_| REFUSED)?).map_err(|_| REFUSED)?;
    if step.t != t {
        return Err(REFUSED.into());
    }
    Ok(step)
}

async fn read_step<S: AsyncRead + AsyncWrite + Unpin>(ws: &mut WebSocketStream<S>) -> Result<Value> {
    loop {
        match ws.next().await {
            Some(Ok(Message::Text(text))) if text.len() <= MAX_HELLO => return serde_json::from_str(text.as_str()).map_err(|_| REFUSED.into()),
            Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue,
            _ => return Err(REFUSED.into()),
        }
    }
}

async fn write<S: AsyncRead + AsyncWrite + Unpin>(ws: &mut WebSocketStream<S>, message: Message) -> bool {
    matches!(tokio::time::timeout(WRITE, ws.send(message)).await, Ok(Ok(())))
}

async fn write_step<S: AsyncRead + AsyncWrite + Unpin>(ws: &mut WebSocketStream<S>, text: String) -> Result<()> {
    if write(ws, Message::text(text)).await {
        Ok(())
    } else {
        Err("The direct route stopped taking frames.".into())
    }
}

/// The viewer's first step: who it is, and proof it holds the pair key and the route key.
fn hello(me: &str, peer: &str, key: &crypto::Key, route: &str, cn: &str, ts: i64) -> Result<String> {
    sealed_step("hello", key, me, peer, &Step { t: "hello".into(), route: route.into(), cn: cn.into(), ts, ..Default::default() })
}

/// The host's side. The caller must be a device `known` derives a pair key for (one in the
/// account's presence), prove it holds that key and the current route key, and answer the
/// host's fresh nonce, so a recorded handshake can't be replayed. Unknown device, wrong key,
/// wrong route key and replay all fail alike. Returns the device and its pair key.
async fn accept<S: AsyncRead + AsyncWrite + Unpin>(ws: &mut WebSocketStream<S>, me: &str, route: &str, known: impl Fn(&str) -> Option<crypto::Key>, seen: &Mutex<host::Replay>) -> Result<(String, crypto::Key)> {
    let first = read_step(ws).await?;
    let from = first["from"].as_str().filter(|id| host::valid_id(id).is_ok() && *id != me).ok_or(REFUSED)?.to_owned();
    if first["kind"] != "hello" || first["to"].as_str() != Some(me) {
        return Err(REFUSED.into());
    }
    let key = known(&from).ok_or(REFUSED)?;
    let step = open_step(&first, &key, &from, me, "hello")?;
    if !crypto::same(&step.route, route) {
        return Err(REFUSED.into());
    }
    seen.lock().unwrap_or_else(|e| e.into_inner()).check(Some(step.ts), Some(&step.cn), now_ms()).map_err(|_| REFUSED)?;
    let sn = crypto::random_token();
    let challenge = Step { t: "challenge".into(), route: route.into(), cn: step.cn.clone(), sn: sn.clone(), ts: now_ms() };
    write_step(ws, sealed_step("challenge", &key, me, &from, &challenge)?).await?;
    let proof = open_step(&read_step(ws).await?, &key, &from, me, "proof")?;
    if !(crypto::same(&proof.sn, &sn) && crypto::same(&proof.cn, &step.cn) && crypto::same(&proof.route, route)) {
        return Err(REFUSED.into());
    }
    let ready = Step { t: "ready".into(), route: route.into(), cn: step.cn, sn, ts: now_ms() };
    write_step(ws, sealed_step("ready", &key, me, &from, &ready)?).await?;
    Ok((from, key))
}

/// The viewer's side: the host must answer this hello's nonce with its own, sealed with the
/// pair key (so it holds the host's X25519 key) and the announced route key.
async fn dial<S: AsyncRead + AsyncWrite + Unpin>(ws: &mut WebSocketStream<S>, me: &str, peer: &str, key: &crypto::Key, route: &str) -> Result<()> {
    let cn = crypto::random_token();
    write_step(ws, hello(me, peer, key, route, &cn, now_ms())?).await?;
    let challenge = open_step(&read_step(ws).await?, key, peer, me, "challenge")?;
    if !(crypto::same(&challenge.cn, &cn) && crypto::same(&challenge.route, route)) || challenge.sn.len() < 16 {
        return Err(REFUSED.into());
    }
    let proof = Step { t: "proof".into(), route: route.into(), cn: cn.clone(), sn: challenge.sn.clone(), ts: now_ms() };
    write_step(ws, sealed_step("proof", key, me, peer, &proof)?).await?;
    let ready = open_step(&read_step(ws).await?, key, peer, me, "ready")?;
    if !(crypto::same(&ready.cn, &cn) && crypto::same(&ready.sn, &challenge.sn)) {
        return Err(REFUSED.into());
    }
    Ok(())
}

/// Connects, upgrades and authenticates one address.
async fn connect(addr: SocketAddr, me: &str, peer: &str, key: &crypto::Key, route: &str) -> Result<WebSocketStream<TcpStream>> {
    let stream = TcpStream::connect(addr).await.map_err(|e| format!("{addr}: {e}"))?;
    let _ = stream.set_nodelay(true);
    let (mut ws, _) = tokio_tungstenite::client_async_with_config(format!("ws://{addr}/v1/direct"), stream, Some(limits())).await.map_err(|e| format!("{addr}: {e}"))?;
    dial(&mut ws, me, peer, key, route).await.map_err(|e| format!("{addr}: {e}"))?;
    Ok(ws)
}

/// Tries every announced address at once; the first to finish the handshake within
/// [`PROBE`] wins, and the rest are dropped.
async fn race(addrs: &[IpAddr], port: u16, me: &str, peer: &str, key: &crypto::Key, route: &str) -> Result<(WebSocketStream<TcpStream>, SocketAddr)> {
    let mut attempts: FuturesUnordered<_> = addrs
        .iter()
        .map(|ip| {
            let addr = SocketAddr::new(*ip, port);
            async move { connect(addr, me, peer, key, route).await.map(|ws| (ws, addr)) }
        })
        .collect();
    let first = async {
        let mut last = "No address was announced.".to_owned();
        while let Some(attempt) = attempts.next().await {
            match attempt {
                Ok(won) => return Ok(won),
                Err(error) => last = error,
            }
        }
        Err(last)
    };
    tokio::time::timeout(PROBE, first).await.unwrap_or_else(|_| Err(format!("No direct answer within {} ms.", PROBE.as_millis())))
}

// ---- Links ----

/// The relay's token bucket: [`RATE`] frames a second, bursts of [`BURST`].
struct Bucket {
    tokens: f64,
    at: Instant,
}

impl Bucket {
    fn new(now: Instant) -> Self {
        Self { tokens: BURST, at: now }
    }

    fn take(&mut self, now: Instant) -> bool {
        self.tokens = (self.tokens + now.saturating_duration_since(self.at).as_secs_f64() * RATE).min(BURST);
        self.at = now;
        let allowed = self.tokens >= 1.0;
        if allowed {
            self.tokens -= 1.0;
        }
        allowed
    }
}

/// What a link hands on: a sealed body for this device, or the peer refusing a frame (rate).
#[derive(Debug, PartialEq)]
enum Inbound {
    Body { body: String, reference: Option<String> },
    Undeliverable(Option<String>),
}

/// Frames are what the relay is given (`{to, body, ref?}`) or its `undeliverable`; one for
/// another device, or anything else, is dropped.
fn parse_frame(text: &str, me: &str, peer: &str) -> Option<Inbound> {
    let mut value: Value = serde_json::from_str(text).ok()?;
    let reference = value["ref"].as_str().map(str::to_owned);
    if value["kind"] == "undeliverable" {
        return (value["to"] == peer).then_some(Inbound::Undeliverable(reference));
    }
    if value.get("kind").is_some() || value["to"] != me {
        return None;
    }
    match value.get_mut("body").map(Value::take) {
        Some(Value::String(body)) => Some(Inbound::Body { body, reference }),
        _ => None,
    }
}

/// Carries frames both ways until the link fails, and returns why. Pings every [`PING`]
/// (RTT from the pong); a link that hears nothing within [`PONG`] of a ping is dead.
async fn pump<S: AsyncRead + AsyncWrite + Unpin>(mut ws: WebSocketStream<S>, me: &str, peer: &str, mut outbox: mpsc::Receiver<String>, mut inbound: impl FnMut(Inbound), mut rtt: impl FnMut(Duration)) -> String {
    let mut bucket = Bucket::new(Instant::now());
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    let (mut pinged, mut heard, mut last_ping): (Option<Instant>, Instant, Instant) = (None, Instant::now(), Instant::now());
    loop {
        tokio::select! {
            outgoing = outbox.recv() => match outgoing {
                Some(text) => if !write(&mut ws, Message::text(text)).await { return "The direct route stopped taking frames.".into() },
                // Replaced by a newer link, or routes stopped.
                None => {
                    let _ = write(&mut ws, Message::Close(None)).await;
                    return "The direct route was closed.".into();
                }
            },
            _ = tick.tick() => {
                let now = Instant::now();
                if let Some(at) = pinged.filter(|at| now.duration_since(*at) > PONG) {
                    if heard < at {
                        return "The direct route stopped answering.".into();
                    }
                    // Heard since, though its pong was refused (rate): alive, so ping again.
                    pinged = None;
                }
                if pinged.is_none() && now.duration_since(last_ping) >= PING {
                    if !write(&mut ws, Message::text("ping")).await {
                        return "The direct route stopped taking frames.".into();
                    }
                    (pinged, last_ping) = (Some(now), now);
                }
            }
            incoming = ws.next() => {
                let text = match incoming {
                    Some(Ok(Message::Text(text))) => text,
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => return "The direct route closed.".into(),
                    Some(Ok(_)) => continue,
                };
                let now = Instant::now();
                heard = now;
                // Every frame spends from the bucket, pongs too.
                let allowed = bucket.take(now);
                if text == "pong" {
                    if let Some(at) = pinged.filter(|_| allowed) {
                        pinged = None;
                        rtt(now.duration_since(at));
                    }
                    continue;
                }
                if text == "ping" {
                    if allowed && !write(&mut ws, Message::text("pong")).await {
                        return "The direct route stopped taking frames.".into();
                    }
                    continue;
                }
                match parse_frame(text.as_str(), me, peer) {
                    // Like the relay: a refused request fails at once instead of timing out.
                    Some(Inbound::Body { reference: Some(reference), .. }) if !allowed => {
                        let refusal = json!({"kind": "undeliverable", "to": me, "ref": reference, "reason": "rate"}).to_string();
                        if !write(&mut ws, Message::text(refusal)).await {
                            return "The direct route stopped taking frames.".into();
                        }
                    }
                    Some(item) if allowed => inbound(item),
                    _ => {}
                }
            }
        }
    }
}

struct Link {
    id: u64,
    tx: mpsc::Sender<String>,
    addr: SocketAddr,
    /// The peer's presence key when the link was authenticated; a change drops the link.
    public_key: String,
    /// Accepted by this computer's listener (as opposed to dialed).
    accepted: bool,
}

#[derive(Clone, Default)]
struct State {
    addr: Option<String>,
    rtt_ms: Option<u64>,
    since: i64,
    last_error: Option<String>,
}

#[derive(Clone, PartialEq, Debug)]
struct Announce {
    addrs: Vec<IpAddr>,
    port: u16,
    route: String,
    /// The host answers a repeated request id from its answers instead of running it again.
    dedupe: bool,
}

struct Sent {
    device: String,
    link: u64,
    frame: String,
    retry: bool,
    at: Instant,
}

/// This computer's listener: one per private address, all on one port, behind one route key.
struct Listening {
    route: String,
    port: u16,
    /// The private addresses it was made for, and those that could be bound.
    addrs: Vec<IpAddr>,
    bound: Vec<IpAddr>,
    tasks: Vec<tauri::async_runtime::JoinHandle<()>>,
}

impl Drop for Listening {
    fn drop(&mut self) {
        self.tasks.iter().for_each(|task| task.abort());
    }
}

struct Routes {
    generation: u64,
    direct_routes: bool,
    local: Vec<IpAddr>,
    next_id: u64,
    links: HashMap<String, Link>,
    states: HashMap<String, State>,
    /// Hosts' announced routes, and when each was last probed.
    announced: HashMap<String, (Announce, Option<Instant>)>,
    probing: HashSet<String>,
    inflight: HashMap<String, Sent>,
    listener: Option<Listening>,
}

impl Default for Routes {
    fn default() -> Self {
        Self {
            generation: 0,
            direct_routes: true,
            local: Vec::new(),
            next_id: 0,
            links: HashMap::new(),
            states: HashMap::new(),
            announced: HashMap::new(),
            probing: HashSet::new(),
            inflight: HashMap::new(),
            listener: None,
        }
    }
}

impl Routes {
    /// Sends on the direct link to `to` if one is up and has room, or gives the frame back
    /// for the relay. A request (`id`, `method`) is remembered until answered; it may be
    /// retried on the relay when it is read-only or its host dedupes request ids.
    fn send(&mut self, to: &str, frame: String, request: Option<(&str, &str)>, now: Instant) -> std::result::Result<(), String> {
        let Some(link) = self.links.get(to) else { return Err(frame) };
        let kept = request.map(|_| frame.clone());
        if let Err(error) = link.tx.try_send(frame) {
            return Err(error.into_inner());
        }
        let link = link.id;
        if let (Some((id, method)), Some(frame)) = (request, kept) {
            if self.inflight.len() >= MAX_INFLIGHT {
                if let Some(oldest) = self.inflight.iter().min_by_key(|(_, sent)| sent.at).map(|(id, _)| id.clone()) {
                    self.inflight.remove(&oldest);
                }
            }
            let retry = host::is_read_only_method(method) || self.announced.get(to).is_some_and(|(announce, _)| announce.dedupe);
            self.inflight.insert(id.to_owned(), Sent { device: to.to_owned(), link, frame, retry, at: now });
        }
        Ok(())
    }

    fn register(&mut self, device: &str, link: Link, now_ms: i64) {
        self.states.insert(device.to_owned(), State { addr: Some(link.addr.to_string()), rtt_ms: None, since: now_ms, last_error: None });
        self.probing.remove(device);
        self.links.insert(device.to_owned(), link);
    }

    /// A link ended. Unless a newer link replaced it, the device is back on the relay. Its
    /// unanswered requests are returned for a retry (or to fail).
    fn ended(&mut self, device: &str, id: u64, error: &str, now_ms: i64) -> (bool, Vec<(String, Sent)>) {
        let replaced = self.links.get(device).is_some_and(|link| link.id != id);
        if !replaced {
            self.links.remove(device);
            let state = self.states.entry(device.to_owned()).or_default();
            *state = State { addr: state.addr.take(), rtt_ms: None, since: now_ms, last_error: Some(error.to_owned()) };
        }
        let ids: Vec<String> = self.inflight.iter().filter(|(_, sent)| sent.link == id).map(|(id, _)| id.clone()).collect();
        (replaced, ids.into_iter().filter_map(|id| self.inflight.remove(&id).map(|sent| (id, sent))).collect())
    }

    /// A probe failed: the device stays on the relay.
    fn failed(&mut self, device: &str, error: &str, now_ms: i64) {
        self.probing.remove(device);
        if !self.links.contains_key(device) {
            let state = self.states.entry(device.to_owned()).or_default();
            state.last_error = Some(error.to_owned());
            state.since = now_ms;
        }
    }

    /// Stores a host's announcement; true when it should be probed now: a new route, or the
    /// last probe is [`REPROBE`] old. An empty announcement withdraws the route.
    fn announce(&mut self, from: &str, announce: Announce, now: Instant) -> bool {
        if announce.addrs.is_empty() {
            self.announced.remove(from);
            return false;
        }
        let probed = self.announced.get(from).filter(|(old, _)| *old == announce).and_then(|(_, probed)| *probed);
        self.announced.insert(from.to_owned(), (announce, probed));
        self.direct_routes && !self.links.contains_key(from) && probed.is_none_or(|at| now.saturating_duration_since(at) >= REPROBE)
    }

    /// Announced hosts to probe now: on a network change, or every [`REPROBE`], while no link
    /// to them is up or being made.
    fn due(&self, network: bool, now: Instant) -> Vec<String> {
        if !self.direct_routes {
            return Vec::new();
        }
        self.announced
            .iter()
            .filter(|(id, (_, probed))| !self.links.contains_key(*id) && !self.probing.contains(*id) && (network || probed.is_none_or(|at| now.saturating_duration_since(at) >= REPROBE)))
            .map(|(id, _)| id.clone())
            .collect()
    }

    /// Starts a probe: (addresses, port, route key, generation), or None when one is not due.
    fn start_probe(&mut self, host: &str, now: Instant) -> Option<(Vec<IpAddr>, u16, String, u64)> {
        if !self.direct_routes || self.links.contains_key(host) || self.probing.contains(host) {
            return None;
        }
        let (announce, probed) = self.announced.get_mut(host)?;
        *probed = Some(now);
        let target = (announce.addrs.clone(), announce.port, announce.route.clone(), self.generation);
        self.probing.insert(host.to_owned());
        Some(target)
    }

    fn views(&self) -> Value {
        let ids: BTreeSet<&String> = self.states.keys().chain(self.links.keys()).chain(self.announced.keys()).collect();
        Value::Array(
            ids.into_iter()
                .map(|id| {
                    let state = self.states.get(id).cloned().unwrap_or_default();
                    let link = self.links.get(id);
                    let status = if link.is_some() { "connected" } else if self.probing.contains(id) { "probing" } else { "fallback" };
                    json!({
                        "deviceId": id, "device": id,
                        "route": if link.is_some() { "direct" } else { "relay" }, "state": status,
                        "addr": link.map(|link| link.addr.to_string()).or(state.addr),
                        "rttMs": state.rtt_ms, "since": state.since, "lastError": state.last_error,
                    })
                })
                .collect(),
        )
    }
}

fn routes() -> MutexGuard<'static, Routes> {
    static ROUTES: OnceLock<Mutex<Routes>> = OnceLock::new();
    ROUTES.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner())
}

/// Hello nonces seen in the last minute, so a recorded hello is refused at once.
fn hellos() -> &'static Mutex<host::Replay> {
    static SEEN: OnceLock<Mutex<host::Replay>> = OnceLock::new();
    SEEN.get_or_init(Default::default)
}

/// Per-device route state for diagnostics: `[{deviceId, route, addr, rttMs, since, lastError}]`.
pub(crate) fn route_states() -> Value {
    routes().views()
}

/// Whether a direct link to `device` is up (its calls then outlive a relay drop).
pub(super) fn direct(device: &str) -> bool {
    routes().links.contains_key(device)
}

/// See [`Routes::send`]. Never call with the remote state locked.
pub(super) fn send(to: &str, frame: String, request: Option<(&str, &str)>) -> std::result::Result<(), String> {
    routes().send(to, frame, request, Instant::now())
}

/// A call was answered or given up: it is no longer retried.
pub(super) fn settled(id: &str) {
    routes().inflight.remove(id);
}

// ---- Glue: the listener, probes and the supervisor ----

/// Runs while this sign-in's sockets do: keeps the listener in step with the settings and
/// the network, re-probes hosts, and drops links of devices that left presence or changed key.
pub(super) async fn supervise(app: tauri::AppHandle, generation: u64) {
    {
        let mut routes = routes();
        if routes.generation != generation {
            // A reconnect or another sign-in: every old route goes. Announcements stay, so
            // their hosts are probed again at once (they still need a presence key).
            routes.generation = generation;
            routes.listener = None;
            routes.links.clear();
            routes.probing.clear();
        }
    }
    let mut tick = tokio::time::interval(TICK);
    let mut checked: Option<Instant> = None;
    let (mut wall, mut monotonic) = (SystemTime::now(), Instant::now());
    while socket::current(&app, generation) {
        tick.tick().await;
        if !socket::current(&app, generation) {
            break;
        }
        let (now_wall, now) = (SystemTime::now(), Instant::now());
        let woke = now_wall.duration_since(wall).is_ok_and(|wall| wall > now.duration_since(monotonic) + SLEPT);
        (wall, monotonic) = (now_wall, now);
        // The first round counts as a network change: every announced host is probed at once.
        let first = checked.is_none();
        let mut network = first || woke;
        if network || checked.is_some_and(|at| now.duration_since(at) >= NETWORK) {
            checked = Some(now);
            let (on, addrs) = (load(&remote(&app).dir).direct_routes, local_addrs());
            let mut routes = routes();
            if routes.local != addrs || woke {
                if !first {
                    diagnostics::record("route.network", if woke { "Woke from sleep".to_owned() } else { format!("{} private address(es) now", addrs.len()) });
                }
                network = true;
            }
            routes.local = addrs;
            if routes.direct_routes != on {
                routes.direct_routes = on;
                if !on {
                    routes.links.clear();
                    routes.probing.clear();
                }
                diagnostics::record("route.setting", if on { "Direct routes on" } else { "Direct routes off" });
            }
        }
        listen(&app, generation).await;
        prune(&app);
        let due = routes().due(network, now);
        for host in due {
            probe(&app, &host);
        }
    }
    let mut routes = routes();
    if routes.generation == generation {
        routes.listener = None;
        routes.links.clear();
        routes.probing.clear();
        routes.announced.clear();
        routes.inflight.clear();
    }
}

/// Listens while signed in with remote control and direct routes on and a private address is
/// up; rebinds (with a fresh route key) when the addresses change, and announces each change.
async fn listen(app: &tauri::AppHandle, generation: u64) {
    let want = {
        let state = remote(app);
        let inner = state.lock();
        inner.token.is_some() && inner.settings.host_enabled
    };
    let (addrs, wanted) = {
        let routes = routes();
        let want = want && routes.direct_routes && !routes.local.is_empty();
        (want.then(|| routes.local.clone()), routes.listener.as_ref().map(|listening| listening.addrs.clone()))
    };
    let Some(addrs) = addrs else {
        let stopped = {
            let mut routes = routes();
            let stopped = routes.listener.take().is_some();
            routes.links.retain(|_, link| !link.accepted);
            stopped
        };
        if stopped {
            diagnostics::record("route.listen", "Stopped listening for direct routes");
            announce(app);
        }
        return;
    };
    // The same addresses: nothing to do, even when none of them could be bound.
    if wanted.as_ref() == Some(&addrs) {
        return;
    }
    let mut port = 0;
    let mut listeners = Vec::new();
    for ip in &addrs {
        if let Ok(listener) = TcpListener::bind((*ip, port)).await {
            port = listener.local_addr().map(|addr| addr.port()).unwrap_or(port);
            listeners.push((*ip, listener));
        }
    }
    let route = crypto::random_token();
    let gate = Arc::new(tokio::sync::Semaphore::new(MAX_HANDSHAKES));
    let bound: Vec<IpAddr> = listeners.iter().map(|(ip, _)| *ip).collect();
    let tasks = listeners.into_iter().map(|(_, listener)| tauri::async_runtime::spawn(serve(app.clone(), listener, route.clone(), generation, gate.clone()))).collect();
    let count = bound.len();
    // Dropping it (stale generation) stops its tasks.
    let listening = Listening { route, port, addrs, bound, tasks };
    {
        let mut routes = routes();
        if routes.generation != generation {
            return;
        }
        routes.listener = Some(listening);
    }
    diagnostics::record("route.listen", format!("Listening on {count} private address(es)"));
    announce(app);
}

async fn serve(app: tauri::AppHandle, listener: TcpListener, route: String, generation: u64, gate: Arc<tokio::sync::Semaphore>) {
    loop {
        let Ok((stream, peer)) = listener.accept().await else {
            tokio::time::sleep(Duration::from_millis(250)).await;
            continue;
        };
        if !allowed_peer(peer.ip()) {
            continue;
        }
        let Ok(permit) = gate.clone().try_acquire_owned() else { continue };
        tauri::async_runtime::spawn(incoming(app.clone(), stream, peer, route.clone(), generation, permit));
    }
}

/// One socket on the listener: the handshake within [`HANDSHAKE`], then the link.
async fn incoming(app: tauri::AppHandle, stream: TcpStream, peer: SocketAddr, route: String, generation: u64, permit: tokio::sync::OwnedSemaphorePermit) {
    let _ = stream.set_nodelay(true);
    let me = remote(&app).device_id();
    let shaken = tokio::time::timeout(HANDSHAKE, async {
        let mut ws = tokio_tungstenite::accept_async_with_config(stream, Some(limits())).await.map_err(|_| REFUSED.to_owned())?;
        let (device, _) = accept(&mut ws, &me, &route, |id| socket::peer_key(&app, id).ok(), hellos()).await?;
        Ok::<_, String>((ws, device))
    })
    .await;
    drop(permit);
    match shaken {
        Ok(Ok((ws, device))) => run(app, ws, device, me, peer, true, generation).await,
        _ => diagnostics::record("route.refused", format!("A direct handshake from {} failed", peer.ip())),
    }
}

/// An authenticated link: registered (replacing any older one to the device), pumped, and on
/// failure the device falls back to the relay at once.
async fn run<S: AsyncRead + AsyncWrite + Unpin>(app: tauri::AppHandle, ws: WebSocketStream<S>, device: String, me: String, addr: SocketAddr, accepted: bool, generation: u64) {
    let public_key = {
        let state = remote(&app);
        let inner = state.lock();
        inner.devices.iter().find(|d| d.id == device).map(|d| d.public_key.clone()).unwrap_or_default()
    };
    let (tx, rx) = mpsc::channel(OUTBOX);
    let id = {
        let mut routes = routes();
        if routes.generation != generation || !routes.direct_routes || public_key.is_empty() {
            return;
        }
        routes.next_id += 1;
        let id = routes.next_id;
        routes.register(&device, Link { id, tx, addr, public_key, accepted }, now_ms());
        id
    };
    diagnostics::record("route.up", format!("{device} direct via {addr}"));
    let error = pump(
        ws,
        &me,
        &device,
        rx,
        |item| match item {
            Inbound::Body { body, .. } => socket::sealed(&app, &device, &me, &body),
            Inbound::Undeliverable(reference) => remote(&app).lock().fail_ref(&device, reference.as_deref(), socket::RATE_LIMITED),
        },
        |rtt| {
            if let Some(state) = routes().states.get_mut(&device) {
                state.rtt_ms = Some(rtt.as_millis() as u64);
            }
        },
    )
    .await;
    let (replaced, sent) = routes().ended(&device, id, &error, now_ms());
    diagnostics::record(if replaced { "route.down" } else { "route.fallback" }, format!("{device} {}: {error}", if replaced { "replaced" } else { "relay" }));
    retry(&app, sent);
    if !replaced {
        // Events lost with the link are replayed from the host's journal.
        mirror::subscribe_soon(&app);
    }
}

/// Requests a failed link carried: retried once on the relay (the identical sealed frame,
/// so its nonce can never run twice) when read-only or deduped by the host, else failed as a
/// lost connection, which may have run.
fn retry(app: &tauri::AppHandle, sent: Vec<(String, Sent)>) {
    for (id, sent) in sent {
        if !remote(app).lock().pending.contains_key(&id) {
            continue;
        }
        if sent.retry && socket::relay(app, sent.frame).is_ok() {
            diagnostics::record("route.retry", format!("{} retried on the relay", sent.device));
            continue;
        }
        remote(app).lock().fail_ref(&sent.device, Some(&id), client::LOST);
    }
}

/// Probes an announced host, unless direct routes are off or a link or probe exists.
fn probe(app: &tauri::AppHandle, host: &str) {
    let Some((addrs, port, route, generation)) = routes().start_probe(host, Instant::now()) else { return };
    let key = match socket::peer_key(app, host) {
        Ok(key) => key,
        Err(error) => return routes().failed(host, &error, now_ms()),
    };
    let (app, host, me) = (app.clone(), host.to_owned(), remote(app).device_id());
    tauri::async_runtime::spawn(async move {
        match race(&addrs, port, &me, &host, &key, &route).await {
            Ok((ws, addr)) => run(app, ws, host, me, addr, false, generation).await,
            Err(error) => {
                routes().failed(&host, &error, now_ms());
                diagnostics::record("route.fallback", format!("{host} relay: {error}"));
            }
        }
    });
}

/// Drops links whose device left presence or changed its key, and announcements with them.
fn prune(app: &tauri::AppHandle) {
    let devices: HashMap<String, String> = {
        let state = remote(app);
        let inner = state.lock();
        if !inner.presence {
            return;
        }
        inner.devices.iter().map(|d| (d.id.clone(), d.public_key.clone())).collect()
    };
    let mut routes = routes();
    routes.links.retain(|id, link| devices.get(id) == Some(&link.public_key));
    routes.announced.retain(|id, _| devices.contains_key(id));
    routes.states.retain(|id, _| devices.contains_key(id));
}

/// Applies a host's sealed announcement and probes it when due.
pub(super) fn announced(app: &tauri::AppHandle, from: &str, data: &Value) {
    let Some(announce) = parse_announce(data) else { return };
    // A device blocked here is never dialed.
    if super::grants::is_blocked(app, from) {
        return;
    }
    if routes().announce(from, announce, Instant::now()) {
        probe(app, from);
    }
}

fn parse_announce(data: &Value) -> Option<Announce> {
    let addrs: Vec<IpAddr> = pick_addrs(data["addrs"].as_array()?.iter().take(MAX_ADDRS).filter_map(|addr| addr.as_str()?.parse().ok()));
    let port = u16::try_from(data["port"].as_u64()?).ok()?;
    let route = data["routeKey"].as_str().unwrap_or_default();
    if !addrs.is_empty() && (port == 0 || route.len() != 44) {
        return None;
    }
    Some(Announce { addrs, port, route: route.to_owned(), dedupe: data["dedupe"] == true })
}

/// On every presence frame: the listener's route (or its withdrawal) goes to every other
/// online device of the account, sealed, over the relay only.
pub(super) fn presence(app: &tauri::AppHandle) {
    if routes().listener.is_some() {
        announce(app);
    }
}

fn announce(app: &tauri::AppHandle) {
    let data = match routes().listener.as_ref().filter(|listening| !listening.bound.is_empty()) {
        Some(listening) => json!({"addrs": listening.bound.iter().map(IpAddr::to_string).collect::<Vec<_>>(), "port": listening.port, "routeKey": listening.route, "dedupe": true}),
        None => json!({"addrs": [], "port": 0, "routeKey": ""}),
    };
    let targets: Vec<String> = {
        let state = remote(app);
        let inner = state.lock();
        inner.devices.iter().filter(|d| d.online && d.id != inner.settings.device_id).map(|d| d.id.clone()).collect()
    };
    let event = json!({"type": "event", "name": ANNOUNCE, "data": data});
    for device in targets {
        let _ = socket::send_relay(app, &device, &event);
    }
}

/// Drops backoff and reconnects every route now: a fresh relay socket, and every direct link
/// made again. Returns once the relay socket is open, or after 10 s with an error.
#[tauri::command]
pub async fn remote_reconnect(app: tauri::AppHandle) -> Result<()> {
    const SIGNED_OUT: &str = "Sign in to PandaCode Connect first.";
    {
        let state = remote(&app);
        let mut inner = state.lock();
        if inner.token.is_none() {
            return Err(SIGNED_OUT.into());
        }
        inner.connected = false;
    }
    diagnostics::record("route.reconnect", "Reconnecting every route now");
    socket::start(&app);
    super::emit_status(&app);
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        {
            let state = remote(&app);
            let inner = state.lock();
            if inner.token.is_none() {
                return Err(SIGNED_OUT.into());
            }
            if inner.connected {
                return Ok(());
            }
        }
        if Instant::now() >= deadline {
            return Err("Could not reach the relay within 10 seconds. PandaCode keeps trying in the background.".into());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, Ipv6Addr};

    fn ip(text: &str) -> IpAddr {
        text.parse().unwrap()
    }

    #[test]
    fn only_private_addresses_are_used() {
        for text in ["10.0.0.5", "172.16.3.4", "172.31.255.1", "192.168.1.20", "169.254.10.1", "100.64.0.1", "100.101.102.103", "100.127.255.254", "fd7a:115c:a1e0::1", "fc00::1", "fe80::1", "::ffff:192.168.1.2"] {
            assert!(private(ip(text)), "{text}");
        }
        for text in ["8.8.8.8", "1.1.1.1", "172.32.0.1", "100.63.255.255", "100.128.0.1", "127.0.0.1", "::1", "2001:db8::1", "0.0.0.0", "::", "224.0.0.1", "255.255.255.255"] {
            assert!(!private(ip(text)), "{text}");
        }
        assert!(!announceable(ip("fe80::1")), "an IPv6 link-local address needs the dialer's scope");
        assert!(announceable(ip("169.254.10.1")) && announceable(ip("fd7a:115c:a1e0::1")));
        assert!(allowed_peer(ip("127.0.0.1")) && allowed_peer(ip("::ffff:10.1.2.3")) && !allowed_peer(ip("8.8.8.8")));
        let picked = pick_addrs(["8.8.8.8", "fd00::2", "192.168.1.2", "127.0.0.1", "::ffff:192.168.1.2", "fe80::3", "100.100.1.1"].into_iter().map(ip));
        assert_eq!(picked, [ip("100.100.1.1"), ip("192.168.1.2"), ip("fd00::2")]);
        assert_eq!(pick_addrs((0..20u8).map(|n| IpAddr::V4(Ipv4Addr::new(10, 0, 0, n)))).len(), MAX_ADDRS);
        assert!(local_addrs().iter().all(|ip| announceable(*ip) && !ip.is_loopback()));
    }

    #[test]
    fn announcements_are_validated_and_settings_default_on() {
        let route = crypto::random_token();
        let good = parse_announce(&json!({"addrs": ["192.168.1.2", "8.8.8.8", "nope"], "port": 4242, "routeKey": route, "dedupe": true})).unwrap();
        assert_eq!((good.addrs, good.port, good.dedupe), (vec![ip("192.168.1.2")], 4242, true));
        assert!(parse_announce(&json!({"addrs": ["192.168.1.2"], "port": 0, "routeKey": route})).is_none());
        assert!(parse_announce(&json!({"addrs": ["192.168.1.2"], "port": 70000, "routeKey": route})).is_none());
        assert!(parse_announce(&json!({"addrs": ["192.168.1.2"], "port": 1, "routeKey": "short"})).is_none());
        assert!(parse_announce(&json!({"addrs": [], "port": 0, "routeKey": ""})).unwrap().addrs.is_empty(), "a withdrawal");
        let dir = std::env::temp_dir().join(format!("pandacode-routes-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(load(&dir).direct_routes);
        std::fs::write(dir.join(FILE), r#"{"directRoutes": false}"#).unwrap();
        assert!(!load(&dir).direct_routes);
        std::fs::write(dir.join(FILE), "not json").unwrap();
        assert!(load(&dir).direct_routes);
        let _ = std::fs::remove_dir_all(dir);
    }

    struct Pair {
        host: (String, crypto::Key),
        viewer: (String, crypto::Key),
    }

    fn pair() -> Pair {
        let (h, v) = (crypto::generate(), crypto::generate());
        let host = crypto::pair_key(&h, "host", &crypto::public_key(&v), "viewer").unwrap();
        let viewer = crypto::pair_key(&v, "viewer", &crypto::public_key(&h), "host").unwrap();
        Pair { host: ("host".into(), host), viewer: ("viewer".into(), viewer) }
    }

    /// A loopback listener running the host's side of one handshake per connection.
    async fn host_side(key: crypto::Key, route: String, seen: Arc<Mutex<host::Replay>>) -> (SocketAddr, mpsc::Receiver<Result<(String, WebSocketStream<TcpStream>)>>) {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (tx, rx) = mpsc::channel(8);
        tokio::spawn(async move {
            while let Ok((stream, peer)) = listener.accept().await {
                assert!(allowed_peer(peer.ip()));
                let (tx, route, seen) = (tx.clone(), route.clone(), seen.clone());
                tokio::spawn(async move {
                    let result = async {
                        let mut ws = tokio_tungstenite::accept_async_with_config(stream, Some(limits())).await.map_err(|e| e.to_string())?;
                        let (device, _) = accept(&mut ws, "host", &route, |id| (id == "viewer").then_some(key), &seen).await?;
                        Ok((device, ws))
                    };
                    let _ = tx.send(tokio::time::timeout(HANDSHAKE, result).await.unwrap_or_else(|_| Err("timeout".into()))).await;
                });
            }
        });
        (addr, rx)
    }

    #[tokio::test]
    async fn the_handshake_accepts_a_listed_device_and_refuses_the_rest() {
        let Pair { host: (_, host_key), viewer: (_, viewer_key) } = pair();
        let route = crypto::random_token();
        let (addr, mut accepted) = host_side(host_key, route.clone(), Default::default()).await;

        connect(addr, "viewer", "host", &viewer_key, &route).await.expect("the listed viewer gets in");
        assert_eq!(accepted.recv().await.unwrap().unwrap().0, "viewer");

        // A device holding another key (not the one presence lists) can't open the hello.
        let stranger = crypto::pair_key(&crypto::generate(), "viewer", &crypto::public_key(&crypto::generate()), "host").unwrap();
        assert!(connect(addr, "viewer", "host", &stranger, &route).await.is_err());
        assert!(accepted.recv().await.unwrap().is_err());

        // A device presence doesn't list, even with a valid pair key of its own.
        assert!(connect(addr, "intruder", "host", &viewer_key, &route).await.is_err());
        assert!(accepted.recv().await.unwrap().is_err());

        // An old or guessed route key.
        assert!(connect(addr, "viewer", "host", &viewer_key, &crypto::random_token()).await.is_err());
        assert!(accepted.recv().await.unwrap().is_err());

        // Addressed to another device.
        assert!(connect(addr, "viewer", "other", &viewer_key, &route).await.is_err());
        assert!(accepted.recv().await.unwrap().is_err());
    }

    #[tokio::test]
    async fn a_recorded_hello_is_refused_and_a_fake_host_is_not_trusted() {
        let Pair { host: (_, host_key), viewer: (_, viewer_key) } = pair();
        let route = crypto::random_token();
        let (addr, mut accepted) = host_side(host_key, route.clone(), Default::default()).await;
        let replay = hello("viewer", "host", &viewer_key, &route, &crypto::random_token(), now_ms()).unwrap();
        for attempt in 0..2 {
            let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/")).await.unwrap();
            ws.send(Message::text(replay.clone())).await.unwrap();
            let reply = ws.next().await;
            if attempt == 0 {
                // The first copy gets a challenge, but without the key there is no proof.
                let challenge: Value = serde_json::from_str(reply.unwrap().unwrap().to_text().unwrap()).unwrap();
                assert!(open_step(&challenge, &viewer_key, "host", "viewer", "challenge").is_ok());
                ws.send(Message::text(json!({"kind": "proof", "body": "AAAA"}).to_string())).await.unwrap();
            } else {
                assert!(!matches!(reply, Some(Ok(Message::Text(_)))), "a repeated hello gets no challenge");
            }
            assert!(accepted.recv().await.unwrap().is_err());
        }
        // A stale hello (outside the minute) is refused too.
        let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/")).await.unwrap();
        ws.send(Message::text(hello("viewer", "host", &viewer_key, &route, &crypto::random_token(), now_ms() - 120_000).unwrap())).await.unwrap();
        assert!(accepted.recv().await.unwrap().is_err());

        // A listener that doesn't hold the host's key: the viewer refuses its challenge.
        let impostor = crypto::pair_key(&crypto::generate(), "host", &crypto::public_key(&crypto::generate()), "viewer").unwrap();
        let (fake, _rx) = host_side(impostor, route.clone(), Default::default()).await;
        assert!(connect(fake, "viewer", "host", &viewer_key, &route).await.is_err());
    }

    #[tokio::test]
    async fn the_race_takes_the_address_that_answers_and_falls_back_when_none_does() {
        let Pair { host: (_, host_key), viewer: (_, viewer_key) } = pair();
        let route = crypto::random_token();
        let (addr, mut accepted) = host_side(host_key, route.clone(), Default::default()).await;
        // ::1 has nothing on that port; 127.0.0.1 answers.
        let (_, won) = race(&[IpAddr::V6(Ipv6Addr::LOCALHOST), IpAddr::V4(Ipv4Addr::LOCALHOST)], addr.port(), "viewer", "host", &viewer_key, &route).await.unwrap();
        assert_eq!(won, addr);
        assert!(accepted.recv().await.unwrap().is_ok());
        // Nothing listens: the relay is used, well within the probe timeout.
        let closed = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap().local_addr().unwrap().port();
        let started = Instant::now();
        assert!(race(&[IpAddr::V4(Ipv4Addr::LOCALHOST)], closed, "viewer", "host", &viewer_key, &route).await.is_err());
        assert!(race(&[], closed, "viewer", "host", &viewer_key, &route).await.is_err());
        assert!(started.elapsed() <= PROBE + Duration::from_millis(500));
    }

    #[tokio::test]
    async fn a_link_carries_relay_frames_with_the_relays_limits() {
        let Pair { host: (_, host_key), viewer: (_, viewer_key) } = pair();
        let route = crypto::random_token();
        let (addr, mut accepted) = host_side(host_key, route.clone(), Default::default()).await;
        let mut viewer = connect(addr, "viewer", "host", &viewer_key, &route).await.unwrap();
        let (_, host_ws) = accepted.recv().await.unwrap().unwrap();
        let (to_viewer, outbox) = mpsc::channel(8);
        let (got, mut inbound) = mpsc::unbounded_channel();
        let deliver = move |item| {
            let _ = got.send(item);
        };
        let pumping = tokio::spawn(async move { pump(host_ws, "host", "viewer", outbox, deliver, |_| {}).await });

        // The host's frames reach the viewer as they are.
        let frame = r#"{"to":"viewer","body":"sealed","ref":"r1"}"#;
        to_viewer.send(frame.to_owned()).await.unwrap();
        assert_eq!(viewer.next().await.unwrap().unwrap().to_text().unwrap(), frame);
        viewer.send(Message::text("ping")).await.unwrap();
        assert_eq!(viewer.next().await.unwrap().unwrap().to_text().unwrap(), "pong");
        // Frames for this device go on; others and relay control frames are dropped.
        for frame in [json!({"to": "someone", "body": "x"}), json!({"kind": "presence", "devices": []}), json!({"to": "host", "body": 5}), json!({"to": "host", "body": "b1", "ref": "q1"})] {
            viewer.send(Message::text(frame.to_string())).await.unwrap();
        }
        assert_eq!(inbound.recv().await.unwrap(), Inbound::Body { body: "b1".into(), reference: Some("q1".into()) });
        // Past the burst, a request is refused at once, as the relay would.
        for n in 0..BURST as usize + 5 {
            viewer.send(Message::text(json!({"to": "host", "body": "b", "ref": format!("q{n}")}).to_string())).await.unwrap();
        }
        let refusal: Value = loop {
            let text = viewer.next().await.unwrap().unwrap();
            if let Ok(value) = serde_json::from_str::<Value>(text.to_text().unwrap()) {
                break value;
            }
        };
        assert_eq!((refusal["kind"].as_str(), refusal["to"].as_str(), refusal["reason"].as_str()), (Some("undeliverable"), Some("host"), Some("rate")));
        assert_eq!(parse_frame(&refusal.to_string(), "viewer", "host"), Some(Inbound::Undeliverable(refusal["ref"].as_str().map(str::to_owned))));
        assert_eq!(parse_frame(&refusal.to_string(), "viewer", "other"), None, "only the peer may refuse its own frames");
        // An oversized frame ends the link.
        viewer.send(Message::text("x".repeat(socket::MAX_FRAME + 8192))).await.unwrap_or(());
        let error = tokio::time::timeout(Duration::from_secs(5), pumping).await.unwrap().unwrap();
        assert!(error.contains("closed"), "{error}");
    }

    #[tokio::test]
    async fn pongs_spend_from_the_links_rate_limit() {
        let Pair { host: (_, host_key), viewer: (_, viewer_key) } = pair();
        let route = crypto::random_token();
        let (addr, mut accepted) = host_side(host_key, route.clone(), Default::default()).await;
        let mut viewer = connect(addr, "viewer", "host", &viewer_key, &route).await.unwrap();
        let (_, host_ws) = accepted.recv().await.unwrap().unwrap();
        let (_to_viewer, outbox) = mpsc::channel(8);
        let (got, mut inbound) = mpsc::unbounded_channel();
        tokio::spawn(async move { pump(host_ws, "host", "viewer", outbox, move |item| drop(got.send(item)), |_| {}).await });
        for _ in 0..BURST as usize {
            viewer.send(Message::text("pong")).await.unwrap();
        }
        viewer.send(Message::text(json!({"to": "host", "body": "b", "ref": "q"}).to_string())).await.unwrap();
        let refusal: Value = serde_json::from_str(viewer.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(refusal["reason"], "rate", "a pong flood used up the burst");
        assert!(inbound.try_recv().is_err());
    }

    #[test]
    fn the_bucket_matches_the_relay() {
        let start = Instant::now();
        let mut bucket = Bucket::new(start);
        assert!((0..BURST as usize).all(|_| bucket.take(start)));
        assert!(!bucket.take(start));
        assert!(bucket.take(start + Duration::from_millis(50)), "20 a second refill");
        assert!(!bucket.take(start + Duration::from_millis(50)));
    }

    fn link(routes: &mut Routes, device: &str, capacity: usize) -> (u64, mpsc::Receiver<String>) {
        let (tx, rx) = mpsc::channel(capacity);
        routes.next_id += 1;
        let id = routes.next_id;
        routes.register(device, Link { id, tx, addr: "192.168.1.2:4000".parse().unwrap(), public_key: "k".into(), accepted: false }, 1);
        (id, rx)
    }

    #[test]
    fn frames_prefer_a_healthy_link_and_fall_back_to_the_relay() {
        let now = Instant::now();
        let mut routes = Routes::default();
        assert_eq!(routes.send("host", "f0".into(), None, now), Err("f0".into()), "no link: the relay");
        let (id, mut rx) = link(&mut routes, "host", 2);
        assert_eq!(routes.send("host", "f1".into(), Some(("r1", "task.messages")), now), Ok(()));
        assert_eq!(routes.send("host", "f2".into(), Some(("r2", "task.send")), now), Ok(()));
        assert_eq!(routes.send("host", "f3".into(), None, now), Err("f3".into()), "a full link spills to the relay");
        assert_eq!((rx.try_recv().unwrap(), rx.try_recv().unwrap()), ("f1".to_owned(), "f2".to_owned()));
        assert_eq!(routes.views()[0]["route"], "direct");
        assert_eq!(routes.views()[0]["state"], "connected");
        routes.settled_for_test("r1");

        // The link fails: the device is on the relay, with why, and the unanswered request comes
        // back. `task.send` changes a task, so without the host's dedupe it fails instead.
        let (replaced, sent) = routes.ended("host", id, "The direct route stopped answering.", 2);
        assert!(!replaced);
        assert_eq!(sent.iter().map(|(id, sent)| (id.as_str(), sent.frame.as_str(), sent.retry)).collect::<Vec<_>>(), [("r2", "f2", false)]);
        let view = &routes.views()[0];
        assert_eq!((view["route"].as_str(), view["state"].as_str(), view["lastError"].as_str(), view["since"].as_i64()), (Some("relay"), Some("fallback"), Some("The direct route stopped answering."), Some(2)));
        assert_eq!(routes.send("host", "f4".into(), None, now), Err("f4".into()));

        // A host that dedupes request ids: every request may be retried once.
        routes.announce("host", Announce { addrs: vec![ip("192.168.1.2")], port: 4000, route: "r".repeat(44), dedupe: true }, now);
        let (id, _rx) = link(&mut routes, "host", 4);
        routes.send("host", "f5".into(), Some(("r5", "task.send")), now).unwrap();
        // A newer link replaces this one: still direct, but its unsent request is handed back.
        let (_newer, _rx2) = link(&mut routes, "host", 4);
        let (replaced, sent) = routes.ended("host", id, "The direct route was closed.", 3);
        assert!(replaced && sent.len() == 1 && sent[0].1.retry);
        assert!(routes.inflight.is_empty(), "handed back once: a retry is never retried again");
        assert_eq!(routes.views()[0]["route"], "direct");
    }

    #[test]
    fn hosts_are_reprobed_every_minute_and_on_a_network_change() {
        let now = Instant::now();
        let mut routes = Routes::default();
        let announce = Announce { addrs: vec![ip("192.168.1.2")], port: 4000, route: "r".repeat(44), dedupe: true };
        assert!(routes.announce("host", announce.clone(), now), "a new route is probed at once");
        assert!(routes.start_probe("host", now).is_some());
        assert!(routes.start_probe("host", now).is_none(), "one probe at a time");
        routes.failed("host", "No direct answer within 1500 ms.", 5);
        assert!(!routes.announce("host", announce.clone(), now + Duration::from_secs(5)), "the same route again soon: not probed");
        assert!(routes.due(false, now + Duration::from_secs(30)).is_empty());
        assert_eq!(routes.due(true, now + Duration::from_secs(30)), ["host"], "a network change");
        assert_eq!(routes.due(false, now + REPROBE), ["host"]);
        let moved = Announce { port: 4001, ..announce.clone() };
        assert!(routes.announce("host", moved, now + Duration::from_secs(1)), "a changed route is probed at once");
        let _link = link(&mut routes, "host", 1);
        assert!(routes.due(true, now + REPROBE).is_empty(), "never while a link is up");
        routes.direct_routes = false;
        routes.links.clear();
        assert!(routes.due(true, now + REPROBE).is_empty() && routes.start_probe("host", now + REPROBE).is_none(), "the setting is off");
        routes.direct_routes = true;
        assert!(!routes.announce("host", Announce { addrs: vec![], port: 0, route: String::new(), dedupe: false }, now));
        assert!(routes.due(true, now + REPROBE).is_empty(), "the host withdrew its route");
    }

    impl Routes {
        fn settled_for_test(&mut self, id: &str) {
            self.inflight.remove(id);
        }
    }
}
