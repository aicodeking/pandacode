//! PandaConnect benchmarks (docs/connect-benchmark.md): how long Connect operations take and
//! where the time goes. Everything runs on this computer: a relay emulator that follows
//! `relay/src/account.ts` (forwarding, presence, the 20/s token bucket), two peers that seal
//! with the real `crypto.rs`, the real host page/chunk/image code, and local bare git repos.
//! Nothing reaches the production relay or GitHub.
//!
//! `cargo test --lib remote::bench -- --ignored --nocapture --test-threads=1`
#![cfg(test)]

use super::{crypto, host, images, mirror, start};
use crate::storage::Store;
use futures_util::{Sink, SinkExt, Stream, StreamExt};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::{
    self,
    client::IntoClientRequest,
    handshake::server::{ErrorResponse, Request as WsRequest, Response as WsResponse},
    Message,
};

// Production values that are private to their modules; keep them in sync.
/// images.rs `PACE` before the pipelined upload replaced it.
const PACE: Duration = Duration::from_millis(75);
/// socket.rs `run`: the first retry waits this long.
const FIRST_BACKOFF: Duration = Duration::from_secs(1);
/// socket.rs `PING` and `SILENT`.
const PING_S: u64 = 30;
const SILENT_S: u64 = 75;
/// mirror.rs `MAX_PAGES`.
const MAX_PAGES: usize = 50;
/// start.rs `FETCH` and `GIT`.
const FETCH: Duration = Duration::from_secs(90);
const GIT: Duration = Duration::from_secs(15);
/// relay/src/limits.ts.
const RATE_PER_SEC: f64 = 20.0;
const RATE_BURST: f64 = 100.0;
const MAX_FRAME: usize = 256 * 1024;
/// One frame per this gap stays inside the relay's rate.
const RATE_GAP: Duration = Duration::from_millis(50);
const MB: usize = 1024 * 1024;

#[derive(Clone, Copy)]
struct Profile {
    name: &'static str,
    /// One way between a computer and the relay.
    one_way: Duration,
    /// Each computer's downlink, or None for unlimited.
    bytes_per_sec: Option<f64>,
}

const LOOPBACK: Profile = Profile { name: "loopback", one_way: Duration::ZERO, bytes_per_sec: None };
/// Modeled: each computer 20 ms from the relay (80 ms per request/response), 50 Mbit/s down.
const WAN: Profile = Profile { name: "wan", one_way: Duration::from_millis(20), bytes_per_sec: Some(50e6 / 8.0) };
const PROFILES: [Profile; 2] = [LOOPBACK, WAN];

// ---------------------------------------------------------------------------------------
// Reporting

struct Table {
    title: String,
    rows: Vec<(String, Vec<f64>, String)>,
}

impl Table {
    fn new(title: &str) -> Self {
        Self { title: title.into(), rows: Vec::new() }
    }

    fn add(&mut self, name: impl Into<String>, samples: &[Duration], note: impl Into<String>) {
        self.rows.push((name.into(), samples.iter().map(|d| d.as_secs_f64() * 1000.0).collect(), note.into()));
    }

    fn print(&self) {
        println!("\n### {}\n\n| case | n | p50 ms | p95 ms | max ms | note |\n|---|---:|---:|---:|---:|---|", self.title);
        for (name, samples, note) in &self.rows {
            let mut s = samples.clone();
            s.sort_by(f64::total_cmp);
            if s.is_empty() {
                println!("| {name} | 0 | - | - | - | {note} |");
                continue;
            }
            let at = |p: f64| s[((s.len() - 1) as f64 * p).round() as usize];
            println!("| {name} | {} | {:.3} | {:.3} | {:.3} | {note} |", s.len(), at(0.5), at(0.95), s[s.len() - 1]);
        }
    }
}

fn time<T>(f: impl FnOnce() -> T) -> (T, Duration) {
    let started = Instant::now();
    let value = f();
    (value, started.elapsed())
}

fn median(samples: &[Duration]) -> Duration {
    let mut s = samples.to_vec();
    s.sort();
    s[s.len() / 2]
}

fn size(bytes: usize) -> String {
    if bytes >= MB {
        format!("{:.1} MB", bytes as f64 / MB as f64)
    } else if bytes >= 1024 {
        format!("{} KB", bytes / 1024)
    } else {
        format!("{bytes} B")
    }
}

/// gzip -6 size of `bytes`, to show what compressing before sealing would save.
fn gzip_len(bytes: &[u8]) -> Option<usize> {
    let mut child = Command::new("gzip").args(["-6", "-c"]).stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().ok()?;
    let mut stdin = child.stdin.take()?;
    let input = bytes.to_vec();
    let writer = std::thread::spawn(move || stdin.write_all(&input));
    let output = child.wait_with_output().ok()?;
    writer.join().ok()?.ok()?;
    Some(output.stdout.len())
}

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
}

fn temp_root(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("pandacode-connect-bench-{label}-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&dir).unwrap();
    dir.canonicalize().unwrap()
}

// ---------------------------------------------------------------------------------------
// Relay emulator (relay/src/account.ts semantics, no TLS, no auth beyond a device id)

type Outbox = mpsc::UnboundedSender<(tokio::time::Instant, Message)>;

struct RelayState {
    devices: Vec<(String, String)>,
    sockets: HashMap<String, Outbox>,
    buckets: HashMap<String, (f64, Instant)>,
}

struct Relay {
    addr: SocketAddr,
    profile: Profile,
    task: JoinHandle<()>,
}

impl Drop for Relay {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn start_relay(profile: Profile, devices: &[&Identity]) -> Relay {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let devices = devices.iter().map(|d| (d.id.clone(), d.public())).collect();
    let state = Arc::new(Mutex::new(RelayState { devices, sockets: HashMap::new(), buckets: HashMap::new() }));
    let task = tokio::spawn(async move {
        while let Ok((tcp, _)) = listener.accept().await {
            let _ = tcp.set_nodelay(true);
            tokio::spawn(serve(tcp, state.clone(), profile));
        }
    });
    Relay { addr, profile, task }
}

/// Delivers frames after the modeled propagation, one at a time over the modeled downlink.
async fn write_delayed<S: Sink<Message> + Unpin>(mut write: S, mut rx: mpsc::UnboundedReceiver<(tokio::time::Instant, Message)>, profile: Profile) {
    let mut free = tokio::time::Instant::now();
    while let Some((at, message)) = rx.recv().await {
        let transfer = profile.bytes_per_sec.map_or(Duration::ZERO, |rate| Duration::from_secs_f64(message.len() as f64 / rate));
        free = free.max(at) + transfer;
        // Tokio's timer rounds up to 1 ms, so a frame already due goes out at once.
        if free > tokio::time::Instant::now() {
            tokio::time::sleep_until(free).await;
        }
        if write.send(message).await.is_err() {
            break;
        }
    }
}

fn broadcast_presence(state: &RelayState, hop: Duration) {
    let at = tokio::time::Instant::now() + hop;
    let devices: Vec<Value> = state
        .devices
        .iter()
        .map(|(id, public)| {
            let online = state.sockets.contains_key(id);
            json!({"id": id, "name": "bench", "platform": "macos", "publicKey": public, "host": online, "online": online, "lastSeen": 0})
        })
        .collect();
    let frame = json!({"kind": "presence", "devices": devices}).to_string();
    for out in state.sockets.values() {
        let _ = out.send((at, Message::text(frame.clone())));
    }
}

async fn serve(tcp: tokio::net::TcpStream, state: Arc<Mutex<RelayState>>, profile: Profile) {
    let mut device = String::new();
    // tungstenite requires this large response error type in its callback signature.
    #[allow(clippy::result_large_err)]
    let callback = |request: &WsRequest, response: WsResponse| -> Result<WsResponse, ErrorResponse> {
        device = request.headers().get("authorization").and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer ")).unwrap_or_default().to_owned();
        Ok(response)
    };
    let Ok(ws) = tokio_tungstenite::accept_hdr_async(tcp, callback).await else { return };
    if !state.lock().unwrap().devices.iter().any(|(id, _)| *id == device) {
        return;
    }
    // A frame crosses two hops: sender to relay, relay to receiver.
    let hop = profile.one_way * 2;
    let (write, mut read) = ws.split();
    let (tx, rx) = mpsc::unbounded_channel();
    tokio::spawn(write_delayed(write, rx, profile));
    {
        let mut s = state.lock().unwrap();
        s.sockets.insert(device.clone(), tx.clone());
        s.buckets.entry(device.clone()).or_insert((RATE_BURST, Instant::now()));
        broadcast_presence(&s, hop);
    }
    while let Some(Ok(message)) = read.next().await {
        let text = match message {
            Message::Text(text) => text,
            Message::Close(_) => break,
            _ => continue,
        };
        let at = tokio::time::Instant::now() + hop;
        // The relay's auto-response answers pings without spending a token.
        if text.as_str() == "ping" {
            let _ = tx.send((at, Message::text("pong")));
            continue;
        }
        let s = &mut *state.lock().unwrap();
        // relay/src/bucket.ts: refill by elapsed time, then spend one token.
        let now = Instant::now();
        let bucket = s.buckets.get_mut(&device).unwrap();
        let tokens = (bucket.0 + now.duration_since(bucket.1).as_secs_f64() * RATE_PER_SEC).min(RATE_BURST);
        let allowed = tokens >= 1.0;
        *bucket = (if allowed { tokens - 1.0 } else { tokens }, now);
        let Ok(frame) = serde_json::from_str::<Value>(text.as_str()) else { continue };
        let to = frame["to"].as_str().unwrap_or_default().to_owned();
        let undeliverable = |reason: &str| Message::text(json!({"kind": "undeliverable", "to": to, "ref": frame["ref"], "reason": reason}).to_string());
        if !allowed {
            let _ = tx.send((at, undeliverable("rate")));
            continue;
        }
        match s.sockets.get(&to) {
            Some(target) => {
                let _ = target.send((at, Message::text(json!({"from": device, "to": to, "body": frame["body"]}).to_string())));
            }
            None => {
                let _ = tx.send((at, undeliverable("offline")));
            }
        }
    }
    let mut s = state.lock().unwrap();
    if s.sockets.get(&device).is_some_and(|out| out.same_channel(&tx)) {
        s.sockets.remove(&device);
        broadcast_presence(&s, hop);
    }
}

// ---------------------------------------------------------------------------------------
// Peers: sealed request/response/event over the relay, like socket.rs and client.rs

struct Identity {
    id: String,
    secret: x25519_dalek::StaticSecret,
}

impl Identity {
    fn new() -> Self {
        Self { id: uuid::Uuid::new_v4().to_string(), secret: crypto::generate() }
    }

    fn public(&self) -> String {
        crypto::public_key(&self.secret)
    }
}

struct Reply {
    result: Result<Value, String>,
    /// An event sent this long after the response (agent events after a prompt).
    event: Option<(Duration, Value)>,
}

fn ok(value: Value) -> Reply {
    Reply { result: Ok(value), event: None }
}

fn refuse(error: impl Into<String>) -> Reply {
    Reply { result: Err(error.into()), event: None }
}

/// The host's request handler: (from, method, params). Requests run one at a time in
/// arrival order, like socket.rs's ordered lane.
type Handler = Arc<dyn Fn(&str, &str, &Value) -> Reply + Send + Sync>;
type Answer = oneshot::Receiver<Result<Value, String>>;
type Pending = Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>>;

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// socket.rs `send_sealed`: stamp `ts` and `nonce`, seal, wrap as `{to, body, ref}`.
fn seal_frame(key: &crypto::Key, me: &str, to: &str, message: &Value) -> String {
    let mut stamped = message.clone();
    stamped["ts"] = json!(now_ms());
    stamped["nonce"] = json!(uuid::Uuid::new_v4().simple().to_string());
    let body = crypto::seal(key, me, to, stamped.to_string().as_bytes()).unwrap();
    let mut frame = json!({"to": to, "body": body});
    if let Some(id) = message["id"].as_str() {
        frame["ref"] = json!(id);
    }
    frame.to_string()
}

struct Peer {
    id: String,
    keys: HashMap<String, crypto::Key>,
    out: mpsc::UnboundedSender<String>,
    pending: Pending,
    events: tokio::sync::Mutex<mpsc::UnboundedReceiver<(Instant, Value)>>,
    tasks: Vec<JoinHandle<()>>,
}

impl Drop for Peer {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
    }
}

impl Peer {
    /// Connects and returns once the first presence frame arrives. `nagle` keeps Nagle's
    /// algorithm on, as socket.rs does (`connect_async_with_config(.., false)`).
    async fn connect(relay: &Relay, me: &Identity, others: &[&Identity], handler: Option<Handler>, nagle: bool) -> (Peer, Duration) {
        let keys: HashMap<String, crypto::Key> = others.iter().map(|o| (o.id.clone(), crypto::pair_key(&me.secret, &me.id, &o.public(), &o.id).unwrap())).collect();
        let started = Instant::now();
        // Modeled TCP and TLS 1.3 set-up: two round trips that loopback can't show.
        tokio::time::sleep(relay.profile.one_way * 4).await;
        let mut request = format!("ws://{}/v1/connect?host=1", relay.addr).into_client_request().unwrap();
        request.headers_mut().insert("Authorization", format!("Bearer {}", me.id).parse().unwrap());
        let (stream, _) = tokio_tungstenite::connect_async_with_config(request, None, !nagle).await.unwrap();
        let (mut write, read) = stream.split();
        let (out, mut outgoing) = mpsc::unbounded_channel::<String>();
        let writer = tokio::spawn(async move {
            while let Some(text) = outgoing.recv().await {
                if write.send(Message::text(text)).await.is_err() {
                    break;
                }
            }
        });
        let pending: Pending = Arc::default();
        let (event_tx, events) = mpsc::unbounded_channel();
        let (presence_tx, mut presence) = mpsc::unbounded_channel();
        let worker = handler.map(|handler| {
            let (tx, rx) = std::sync::mpsc::channel::<(String, crypto::Key, Value)>();
            let (me, out) = (me.id.clone(), out.clone());
            tokio::task::spawn_blocking(move || {
                while let Ok((from, key, message)) = rx.recv() {
                    let reply = handler(&from, message["method"].as_str().unwrap_or_default(), &message["params"]);
                    let response = match reply.result {
                        Ok(result) => json!({"type": "res", "id": message["id"], "ok": true, "result": result}),
                        Err(error) => json!({"type": "res", "id": message["id"], "ok": false, "error": error}),
                    };
                    let _ = out.send(seal_frame(&key, &me, &from, &response));
                    if let Some((delay, event)) = reply.event {
                        let (out, me) = (out.clone(), me.clone());
                        std::thread::spawn(move || {
                            std::thread::sleep(delay);
                            let _ = out.send(seal_frame(&key, &me, &from, &event));
                        });
                    }
                }
            });
            tx
        });
        let reader = tokio::spawn(read_loop(read, me.id.clone(), keys.clone(), pending.clone(), event_tx, presence_tx, worker));
        presence.recv().await;
        let took = started.elapsed();
        (Peer { id: me.id.clone(), keys, out, pending, events: tokio::sync::Mutex::new(events), tasks: vec![writer, reader] }, took)
    }

    /// Queues a request now (frames leave in call order) and returns its answer.
    fn request(&self, to: &str, method: &str, params: Value) -> Answer {
        let id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id.clone(), tx);
        let frame = seal_frame(&self.keys[to], &self.id, to, &json!({"type": "req", "id": id, "method": method, "params": params}));
        assert!(frame.len() <= MAX_FRAME, "frame too large: {}", frame.len());
        let _ = self.out.send(frame);
        rx
    }

    async fn call(&self, to: &str, method: &str, params: Value) -> Result<Value, String> {
        wait(self.request(to, method, params)).await
    }

    async fn next_event(&self) -> (Instant, Value) {
        self.events.lock().await.recv().await.unwrap()
    }
}

/// client.rs `TIMEOUT`.
async fn wait(answer: Answer) -> Result<Value, String> {
    match tokio::time::timeout(Duration::from_secs(20), answer).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("The connection to the relay was lost.".into()),
        Err(_) => Err("That computer did not answer in time.".into()),
    }
}

async fn read_loop<S: Stream<Item = Result<Message, tungstenite::Error>> + Unpin>(
    mut read: S,
    me: String,
    keys: HashMap<String, crypto::Key>,
    pending: Pending,
    events: mpsc::UnboundedSender<(Instant, Value)>,
    presence: mpsc::UnboundedSender<Instant>,
    worker: Option<std::sync::mpsc::Sender<(String, crypto::Key, Value)>>,
) {
    let mut replay = host::Replay::default();
    while let Some(Ok(message)) = read.next().await {
        let Message::Text(text) = message else { continue };
        let Ok(frame) = serde_json::from_str::<Value>(text.as_str()) else { continue };
        match frame["kind"].as_str() {
            Some("presence") => {
                let _ = presence.send(Instant::now());
            }
            Some("undeliverable") => {
                let waiting = frame["ref"].as_str().and_then(|id| pending.lock().unwrap().remove(id));
                if let Some(tx) = waiting {
                    let _ = tx.send(Err(format!("undeliverable ({})", frame["reason"].as_str().unwrap_or_default())));
                }
            }
            _ => {
                let (Some(from), Some(body)) = (frame["from"].as_str(), frame["body"].as_str()) else { continue };
                let Some(key) = keys.get(from) else { continue };
                let Ok(plain) = crypto::open(key, from, &me, body) else { continue };
                let Ok(message) = serde_json::from_slice::<Value>(&plain) else { continue };
                if replay.check(message["ts"].as_i64(), message["nonce"].as_str(), now_ms()).is_err() {
                    continue;
                }
                match message["type"].as_str() {
                    Some("res") => {
                        let waiting = message["id"].as_str().and_then(|id| pending.lock().unwrap().remove(id));
                        if let Some(tx) = waiting {
                            let _ = tx.send(if message["ok"] == true { Ok(message["result"].clone()) } else { Err(message["error"].as_str().unwrap_or("refused").to_owned()) });
                        }
                    }
                    Some("event") => {
                        let _ = events.send((Instant::now(), message));
                    }
                    Some("req") => {
                        if let Some(worker) = &worker {
                            let _ = worker.send((from.to_owned(), *key, message));
                        }
                    }
                    _ => {}
                }
            }
        }
    }
}

struct Pair {
    relay: Relay,
    host_identity: Identity,
    viewer_identity: Identity,
    host: Peer,
    viewer: Arc<Peer>,
}

async fn pair(profile: Profile, handler: Handler, nagle: bool) -> Pair {
    let (host_identity, viewer_identity) = (Identity::new(), Identity::new());
    let relay = start_relay(profile, &[&host_identity, &viewer_identity]).await;
    let (host, _) = Peer::connect(&relay, &host_identity, &[&viewer_identity], Some(handler), nagle).await;
    let (viewer, _) = Peer::connect(&relay, &viewer_identity, &[&host_identity], None, nagle).await;
    Pair { relay, host_identity, viewer_identity, host, viewer: Arc::new(viewer) }
}

// ---------------------------------------------------------------------------------------
// 1. Crypto

#[test]
#[ignore]
fn crypto_cost() {
    let (a, b) = (crypto::generate(), crypto::generate());
    let mut table = Table::new("Crypto (crypto.rs): X25519 + HKDF pair key; XChaCha20-Poly1305 seal/open incl. base64");
    let derive: Vec<_> = (0..200).map(|_| time(|| crypto::pair_key(&a, "dev-a", &crypto::public_key(&b), "dev-b").unwrap()).1).collect();
    table.add("pair_key (cached per peer by socket.rs)", &derive, "");
    let key = crypto::pair_key(&a, "dev-a", &crypto::public_key(&b), "dev-b").unwrap();
    for bytes in [256, 4 * 1024, 64 * 1024, host::PAGE_BUDGET] {
        let plain = vec![b'x'; bytes];
        let n = if bytes > 64 * 1024 { 200 } else { 1000 };
        let mut sealed = String::new();
        let seal: Vec<_> = (0..n)
            .map(|_| {
                let (body, took) = time(|| crypto::seal(&key, "dev-a", "dev-b", &plain).unwrap());
                sealed = body;
                took
            })
            .collect();
        let open: Vec<_> = (0..n).map(|_| time(|| crypto::open(&key, "dev-a", "dev-b", &sealed).unwrap()).1).collect();
        let message = json!({"type": "res", "id": uuid::Uuid::new_v4().to_string(), "ok": true, "result": {"blob": "x".repeat(bytes)}});
        let send: Vec<_> = (0..n).map(|_| time(|| seal_frame(&key, "dev-a", "dev-b", &message)).1).collect();
        let frame = seal_frame(&key, "dev-a", "dev-b", &message).len();
        let rate = |samples: &[Duration]| bytes as f64 / MB as f64 / median(samples).as_secs_f64();
        table.add(format!("seal {}", size(bytes)), &seal, format!("{:.0} MB/s", rate(&seal)));
        table.add(format!("open {}", size(bytes)), &open, format!("{:.0} MB/s", rate(&open)));
        table.add(format!("send path {} (stamp+JSON+seal+frame)", size(bytes)), &send, format!("frame {frame} B = {:.2}x payload", frame as f64 / bytes as f64));
    }
    table.print();
}

// ---------------------------------------------------------------------------------------
// 2. Connect and request round trips

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore]
async fn connect_and_rpc() {
    let echo: Handler = Arc::new(|_, _, params| ok(json!({"blob": "x".repeat(params["size"].as_u64().unwrap_or(0) as usize)})));
    let mut table = Table::new("Connect (TCP+WS upgrade until first presence) and RPC round trip by reply size");
    for profile in PROFILES {
        for nagle in [true, false] {
            let label = if nagle { "nagle on (prod)" } else { "nodelay" };
            let Pair { relay, host_identity, viewer_identity, host, viewer } = pair(profile, echo.clone(), nagle).await;
            drop(viewer);
            let mut connects = Vec::new();
            let mut viewer = None;
            for _ in 0..20 {
                drop(viewer.take());
                let (peer, took) = Peer::connect(&relay, &viewer_identity, &[&host_identity], None, nagle).await;
                connects.push(took);
                viewer = Some(peer);
            }
            let viewer = viewer.unwrap();
            let note = if profile.one_way.is_zero() { "loopback, no TLS" } else { "3 modeled RTTs: TCP, TLS 1.3, upgrade" };
            table.add(format!("{} connect, {label}", profile.name), &connects, note);
            for bytes in [64, 4 * 1024, 64 * 1024, 180 * 1024] {
                for _ in 0..3 {
                    viewer.call(&host.id, "bench.echo", json!({"size": bytes})).await.unwrap();
                }
                let mut samples = Vec::new();
                for _ in 0..40 {
                    // Stay under the relay's 20 frames/s per computer.
                    tokio::time::sleep(RATE_GAP).await;
                    let started = Instant::now();
                    viewer.call(&host.id, "bench.echo", json!({"size": bytes})).await.unwrap();
                    samples.push(started.elapsed());
                }
                table.add(format!("{} rpc reply {}, {label}", profile.name, size(bytes)), &samples, "");
            }
        }
    }
    table.print();
}

// ---------------------------------------------------------------------------------------
// 3. Image upload (images.rs chunking and pacing)

/// A noise PNG close to `target` bytes and never above images.rs `MAX_BYTES`.
fn noise_png(target: usize, seed: u64) -> Vec<u8> {
    let mut side = ((target as f64) / 3.0).sqrt() as u32;
    loop {
        let mut rng = Rng(seed | 1);
        let image = image::RgbImage::from_fn(side, side, |_, _| {
            let v = rng.next();
            image::Rgb([v as u8, (v >> 8) as u8, (v >> 16) as u8])
        });
        let mut bytes = Vec::new();
        image.write_to(&mut std::io::Cursor::new(&mut bytes), image::ImageFormat::Png).unwrap();
        if bytes.len() <= images::MAX_BYTES {
            return bytes;
        }
        side = side * 98 / 100;
    }
}

/// images.rs `put` and `Uploads` on the host, storing through the real import.
fn image_host(dir: PathBuf) -> Handler {
    let uploads = Arc::new(Mutex::new(images::Uploads::default()));
    Arc::new(move |from, method, params| {
        if method != "image.put" {
            return refuse("Unknown remote method.");
        }
        let chunk = match images::parse_chunk(params) {
            Ok(chunk) => chunk,
            Err(error) => return refuse(error),
        };
        let whole = uploads.lock().unwrap().add(from, chunk, Instant::now());
        match whole {
            Err(error) => refuse(error),
            Ok(None) => ok(json!({})),
            Ok(Some(bytes)) => match images::store(&dir, &bytes) {
                Ok(id) => {
                    uploads.lock().unwrap().stored(from, &id, Instant::now()).unwrap();
                    ok(json!({"imageId": id}))
                }
                Err(error) => refuse(error),
            },
        }
    })
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Pacing {
    /// images.rs before the fix: one chunk at a time, at most every 75 ms. Slow, so it
    /// runs only with `PANDACODE_BENCH_OLD=1`.
    Before,
    /// One chunk at a time, no pacing.
    Unpaced,
    /// What ships: `images::upload`, the relay's burst first, then 18 frames/s, with up to 8
    /// chunks in flight.
    Shipped,
}

/// Viewer side of images.rs `send`. Returns how many chunks went out, or the failure.
async fn upload(viewer: &Peer, host: &str, list: &[Vec<u8>], pacing: Pacing) -> Result<usize, (usize, String)> {
    if pacing == Pacing::Shipped {
        let total: usize = list.iter().map(|image| image.len().div_ceil(images::CHUNK)).sum();
        let budget = Mutex::new(images::Budget::new(Instant::now()));
        return images::upload(list, &budget, |params| wait(viewer.request(host, "image.put", params))).await.map(|_| total).map_err(|error| (0, error));
    }
    let (mut last, mut sent, mut stored) = (None::<Instant>, 0usize, 0usize);
    for image in list {
        let parts = images::chunks(&uuid::Uuid::new_v4().to_string(), image);
        let count = parts.len();
        for (index, params) in parts.into_iter().enumerate() {
            if let (Pacing::Before, Some(last)) = (pacing, last) {
                tokio::time::sleep_until((last + PACE).into()).await;
            }
            last = Some(Instant::now());
            sent += 1;
            let reply = wait(viewer.request(host, "image.put", params)).await.map_err(|error| (sent, error))?;
            stored += usize::from(index + 1 == count && reply["imageId"].is_string());
        }
    }
    if stored != list.len() {
        return Err((sent, format!("stored {stored} of {}", list.len())));
    }
    Ok(sent)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore]
async fn image_upload() {
    let root = temp_root("images");
    let one = noise_png(MB, 7);
    let five = noise_png(5 * MB - 64 * 1024, 11);
    let mut cost = Table::new("Image work on one computer (images.rs), per image");
    for (label, image) in [("1 MB", &one), ("5 MB", &five)] {
        let encode: Vec<_> = (0..3).map(|_| time(|| images::chunks("bench-upload", image)).1).collect();
        let parts = images::chunks("bench-upload", image);
        let assemble: Vec<_> = (0..3)
            .map(|_| {
                let mut uploads = images::Uploads::default();
                time(|| {
                    for part in &parts {
                        uploads.add("viewer", images::parse_chunk(part).unwrap(), Instant::now()).unwrap();
                    }
                })
                .1
            })
            .collect();
        let store: Vec<_> = (0..3).map(|_| time(|| images::store(&root, image).unwrap()).1).collect();
        cost.add(format!("{label} chunks() base64 encode"), &encode, format!("{} B, {} chunks", image.len(), parts.len()));
        cost.add(format!("{label} host parse_chunk + Uploads::add"), &assemble, "");
        cost.add(format!("{label} host store (decode, PNG kept, write)"), &store, "");
        cost.add(format!("{label} old pacing floor, {} chunks x 75 ms", parts.len()), &[PACE * (parts.len() as u32 - 1)], "images.rs PACE before the fix, serial");
    }
    cost.print();

    let mut table = Table::new("Image upload through the relay, viewer start to last imageId (Before = old images.rs, Shipped = images::upload)");
    for profile in PROFILES {
        for (count, label, image) in [(1usize, "1x1MB", &one), (4, "4x1MB", &one), (1, "1x5MB", &five), (4, "4x5MB", &five)] {
            let list = vec![image.clone(); count];
            let total = image.len() * count;
            let old = std::env::var_os("PANDACODE_BENCH_OLD").is_some();
            for pacing in [Pacing::Before, Pacing::Unpaced, Pacing::Shipped].into_iter().filter(|pacing| old || *pacing != Pacing::Before) {
                let runs = if image.len() > 2 * MB { 2 } else { 3 };
                let (mut samples, mut chunks, mut failure) = (Vec::new(), 0, None);
                for _ in 0..runs {
                    let dir = root.join(uuid::Uuid::new_v4().simple().to_string());
                    std::fs::create_dir_all(&dir).unwrap();
                    let session = pair(profile, image_host(dir), true).await;
                    let started = Instant::now();
                    match upload(&session.viewer, &session.host.id, &list, pacing).await {
                        Ok(sent) => {
                            samples.push(started.elapsed());
                            chunks = sent;
                        }
                        Err((sent, error)) => failure = Some(format!("FAILED after {sent} chunks: {error}")),
                    }
                }
                let note = failure.unwrap_or_else(|| format!("{chunks} chunks, {:.2} MB/s", total as f64 / MB as f64 / median(&samples).as_secs_f64()));
                table.add(format!("{} {label} {pacing:?}", profile.name), &samples, note);
            }
        }
    }
    table.print();
    let _ = std::fs::remove_dir_all(root);
}

// ---------------------------------------------------------------------------------------
// 4. task.start phases (start.rs) against a local bare repository

fn sh(dir: &Path, program: &str, args: &[&str]) -> String {
    let output = Command::new(program).current_dir(dir).args(args).stdin(Stdio::null()).output().unwrap();
    assert!(output.status.success(), "{program} {args:?}: {}", String::from_utf8_lossy(&output.stderr));
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}

/// `git clone --progress` read the way start.rs `read_progress` reads it.
fn clone(url: &str, destination: &Path, extra: &[&str]) -> (Duration, usize) {
    let started = Instant::now();
    let mut child = Command::new("git").args(["clone", "--progress"]).args(extra).arg(url).arg(destination).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped()).spawn().unwrap();
    let mut stderr = String::new();
    child.stderr.take().unwrap().read_to_string(&mut stderr).unwrap();
    assert!(child.wait().unwrap().success(), "{stderr}");
    let took = started.elapsed();
    (took, stderr.split(['\r', '\n']).filter_map(start::clone_percent).count())
}

fn dir_size(path: &Path) -> u64 {
    std::fs::read_dir(path)
        .map(|entries| {
            entries
                .filter_map(std::result::Result::ok)
                .map(|entry| match entry.file_type() {
                    Ok(kind) if kind.is_dir() => dir_size(&entry.path()),
                    Ok(kind) if kind.is_file() => entry.metadata().map(|m| m.len()).unwrap_or(0),
                    _ => 0,
                })
                .sum()
        })
        .unwrap_or(0)
}

#[test]
#[ignore]
fn task_start_phases() {
    let root = temp_root("start");
    let source = std::env::var("PANDACODE_BENCH_REPO").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from(sh(Path::new(env!("CARGO_MANIFEST_DIR")), "git", &["rev-parse", "--show-toplevel"])));
    let bare = root.join("origin.git");
    let (_, setup) = time(|| sh(&root, "git", &["clone", "--quiet", "--bare", "--no-local", &source.to_string_lossy(), &bare.to_string_lossy()]));
    sh(&bare, "git", &["config", "uploadpack.allowFilter", "true"]);
    let branch = sh(&bare, "git", &["symbolic-ref", "--short", "HEAD"]);
    let commits = sh(&bare, "git", &["rev-list", "--count", "HEAD"]);
    let files = sh(&bare, "git", &["ls-tree", "-r", "--name-only", "HEAD"]).lines().count();
    let pack = dir_size(&bare);
    println!("\nBench repository: {commits} commits, {files} files at HEAD, {} on disk as a bare repo (made in {:.1} s, not counted)", size(pack as usize), setup.as_secs_f64());
    let url = format!("file://{}", bare.display());
    let mut table = Table::new("task.start phases (start.rs), local file:// origin instead of GitHub");

    // finding: every registered project's origin is read, then the harness list.
    let projects: Vec<PathBuf> = (0..10)
        .map(|n| {
            let dir = root.join(format!("project-{n}"));
            std::fs::create_dir_all(&dir).unwrap();
            sh(&dir, "git", &["init", "--quiet"]);
            sh(&dir, "git", &["remote", "add", "origin", &format!("https://github.com/bench/p{n}.git")]);
            dir
        })
        .collect();
    let find: Vec<_> = (0..5).map(|_| time(|| projects.iter().filter_map(|p| crate::github_hub::project_repo(p)).count()).1).collect();
    table.add("finding: project_repo over 10 projects (before)", &find, "one `git config` per project, serial");
    let listed: Vec<crate::storage::Project> = projects.iter().enumerate().map(|(n, path)| crate::storage::Project { id: n.to_string(), name: n.to_string(), path: path.to_string_lossy().into_owned() }).collect();
    let found: Vec<_> = (0..5).map(|_| time(|| start::origins(listed.clone()).into_iter().filter(|(_, origin)| origin.is_some()).count()).1).collect();
    table.add("finding: start::origins over 10 projects (now)", &found, "reads .git/config; git only for unusual configs");
    let mut installed = 0;
    let discover: Vec<_> = (0..3)
        .map(|_| {
            let (providers, took) = time(crate::providers::discover);
            installed = providers.iter().filter(|p| p.installed).count();
            took
        })
        .collect();
    table.add("finding: require_installed -> providers::discover() (before)", &discover, format!("{installed} harnesses installed; `--version` each, serial"));
    let lookup: Vec<_> = (0..20).map(|_| time(|| crate::providers::executable("claude").is_some()).1).collect();
    table.add("finding: require_installed -> providers::executable (now)", &lookup, "one harness, PATH lookup only");

    // downloading
    for (label, extra) in [("full", vec![]), ("--depth 1", vec!["--depth", "1"]), ("--filter=blob:none", vec!["--filter=blob:none"]), ("--no-checkout", vec!["--no-checkout"])] {
        let mut samples = Vec::new();
        let (mut lines, mut bytes, mut objects) = (0, 0, 0);
        for n in 0..5 {
            let destination = root.join(format!("clone-{}-{n}", label.replace(['-', '=', ' ', ':'], "")));
            let (took, progress) = clone(&url, &destination, &extra);
            samples.push(took);
            lines = progress;
            bytes = dir_size(&destination);
            objects = dir_size(&destination.join(".git"));
        }
        let note = match label {
            "full" => "what gh repo clone runs for an in-place start",
            "--no-checkout" => "what a worktree start runs now (the tree is filled in later)",
            _ => "not used",
        };
        let wire = objects as f64 / WAN.bytes_per_sec.unwrap();
        table.add(format!("downloading: git clone {label}"), &samples, format!("{note}; .git {} (~{wire:.1} s at 50 Mbit/s), {} on disk, {lines} progress lines", size(objects as usize), size(bytes as usize)));
    }

    // preparing, on the fresh full clones: pick_branch, then checkout or a worktree.
    let mut steps: Vec<(&str, Vec<Duration>)> = ["fetch origin (pick_branch)", "rev-parse origin/<branch> (on_origin)", "symbolic-ref origin/HEAD", "checkout: rev-parse refs/heads", "checkout: switch", "checkout: merge --ff-only", "worktree: create_worktree_with"].into_iter().map(|step| (step, Vec::new())).collect();
    let mut totals = Vec::new();
    for n in 0..5 {
        let clone_root = root.join(format!("clone-full-{n}"));
        let origin_branch = format!("refs/remotes/origin/{branch}");
        let local_branch = format!("refs/heads/{branch}");
        let upstream = format!("origin/{branch}");
        let worktree = format!("pandacode/remote-{n:08}");
        let commands: [&dyn Fn() -> Result<(), String>; 7] = [
            &|| start::git(&clone_root, &["fetch", "--quiet", "origin"], FETCH).map(drop),
            &|| start::git(&clone_root, &["rev-parse", "--verify", "--quiet", &origin_branch], GIT).map(drop),
            &|| start::git(&clone_root, &["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], GIT).map(drop),
            &|| start::git(&clone_root, &["rev-parse", "--verify", "--quiet", &local_branch], GIT).map(drop),
            &|| start::git(&clone_root, &["switch", &branch], GIT).map(drop),
            &|| start::git(&clone_root, &["merge", "--ff-only", "--quiet", &upstream], GIT).map(drop),
            &|| crate::workspace::create_worktree_with(&clone_root, &worktree, Some(&upstream), false).map(drop),
        ];
        let mut total = Duration::ZERO;
        for (index, command) in commands.iter().enumerate() {
            let (result, took) = time(command);
            result.unwrap();
            steps[index].1.push(took);
            if index < 6 {
                total += took;
            }
        }
        totals.push(total);
    }
    for (step, samples) in &steps {
        table.add(format!("preparing: {step}"), samples, "");
    }
    table.add("preparing: total in-place path (6 git steps)", &totals, "fetch right after a fresh clone");

    // A fresh clone's whole start (clone, then the steps start.rs ran before and runs now), each on its own clone.
    let (mut in_place_before, mut in_place_now, mut tree_before, mut tree_now) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    let upstream = format!("origin/{branch}");
    for n in 0..3 {
        let place = |name: &str| root.join(format!("start-{name}-{n}"));
        let origin_branch = format!("refs/remotes/origin/{branch}");
        let local_branch = format!("refs/heads/{branch}");
        let drop_all = |paths: &[&PathBuf]| {
            for path in paths {
                let _ = std::fs::remove_dir_all(path);
            }
        };
        let dir = place("ip-before");
        in_place_before.push(
            time(|| {
                clone(&url, &dir, &[]);
                start::git(&dir, &["fetch", "--quiet", "origin"], FETCH).unwrap();
                start::git(&dir, &["rev-parse", "--verify", "--quiet", &origin_branch], GIT).unwrap();
                start::git(&dir, &["rev-parse", "--verify", "--quiet", &local_branch], GIT).unwrap();
                start::git(&dir, &["switch", &branch], GIT).unwrap();
                start::git(&dir, &["merge", "--ff-only", "--quiet", &upstream], GIT).unwrap();
            })
            .1,
        );
        drop_all(&[&dir]);
        let dir = place("ip-now");
        in_place_now.push(
            time(|| {
                clone(&url, &dir, &[]);
                start::pick_branch(&dir, Some(&branch), false).unwrap();
                start::checkout(&dir, &branch).unwrap();
            })
            .1,
        );
        drop_all(&[&dir]);
        let dir = place("wt-before");
        tree_before.push(
            time(|| {
                clone(&url, &dir, &[]);
                start::git(&dir, &["fetch", "--quiet", "origin"], FETCH).unwrap();
                start::git(&dir, &["rev-parse", "--verify", "--quiet", &origin_branch], GIT).unwrap();
                crate::workspace::create_worktree_with(&dir, &format!("pandacode/remote-{n:08}"), Some(&upstream), false).unwrap();
            })
            .1,
        );
        drop_all(&[&dir, &root.join(format!("start-wt-before-{n}-worktrees"))]);
        let dir = place("wt-now");
        tree_now.push(
            time(|| {
                clone(&url, &dir, &["--no-checkout"]);
                start::pick_branch(&dir, Some(&branch), false).unwrap();
                start::worktree_while_restoring(&dir, &branch).unwrap();
            })
            .1,
        );
        assert_eq!(sh(&dir, "git", &["status", "--porcelain"]), "", "the main checkout is whole");
        drop_all(&[&dir, &root.join(format!("start-wt-now-{n}-worktrees"))]);
    }
    table.add("start, fresh clone, in place: clone + prepare (before)", &in_place_before, "clone, fetch, rev-parse origin/<branch> and refs/heads, switch, merge");
    table.add("start, fresh clone, in place: clone + prepare (now)", &in_place_now, "clone, rev-parse origin/<branch>, symbolic-ref HEAD");
    table.add("start, fresh clone, worktree: clone + prepare (before)", &tree_before, "clone, fetch, rev-parse origin/<branch>, worktree add");
    table.add("start, fresh clone, worktree: clone + prepare (now)", &tree_now, "clone --no-checkout, rev-parse origin/<branch>, worktree add in parallel with reset --hard");
    table.add("starting: create task + send_message", &[], "not measured: needs the app store and a harness");
    table.print();
    let _ = std::fs::remove_dir_all(root);
}

// ---------------------------------------------------------------------------------------
// 5. First event after task.send

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore]
async fn first_event_after_send() {
    let event = json!({"type": "event", "name": "agent.events", "data": {"events": [{"sessionId": "h1", "kind": "text", "text": "Looking at the build"}]}});
    // The host's own pacing: host::flush_delay against when it last sent a frame and how
    // many frames this burst sent (host.rs enqueue/flush).
    let flushed: Mutex<(Option<Instant>, u32)> = Mutex::new((None, 0));
    let handler: Handler = Arc::new(move |_, method, _| match method {
        "task.send" => {
            let mut flushed = flushed.lock().unwrap();
            let now = Instant::now();
            let delay = host::flush_delay(flushed.0, flushed.1, now);
            *flushed = (Some(now + delay), if delay.is_zero() { 1 } else { flushed.1.saturating_add(1) });
            Reply { result: Ok(json!({})), event: Some((delay, event.clone())) }
        }
        _ => Reply { result: Ok(json!({})), event: Some((Duration::ZERO, event.clone())) },
    });
    let mut table = Table::new("task.send: response and first agent.events frame (harness start and model latency excluded)");
    for profile in PROFILES {
        for nagle in [true, false] {
            let label = if nagle { "nagle on (prod)" } else { "nodelay" };
            let session = pair(profile, handler.clone(), nagle).await;
            let paced = format!("host.rs flush_delay: first event at once, then FLUSH = {} ms, SUSTAINED = {} ms after {} frames", host::FLUSH.as_millis(), host::SUSTAINED.as_millis(), host::BURST_FRAMES);
            for (method, note) in [("task.send", paced.as_str()), ("task.send.noflush", "model: flush at once")] {
                let (mut acks, mut firsts) = (Vec::new(), Vec::new());
                for _ in 0..30 {
                    // The host sends two frames per prompt: stay under 20 frames/s.
                    tokio::time::sleep(RATE_GAP * 2).await;
                    let started = Instant::now();
                    session.viewer.call(&session.host.id, method, json!({"sessionId": "h1", "text": "Fix the build"})).await.unwrap();
                    acks.push(started.elapsed());
                    let (at, _) = session.viewer.next_event().await;
                    firsts.push(at - started);
                }
                table.add(format!("{} {method} response, {label}", profile.name), &acks, "");
                table.add(format!("{} {method} first event, {label}", profile.name), &firsts, note);
            }
        }
    }
    table.print();
}

// ---------------------------------------------------------------------------------------
// 6. History sync (mirror.rs `sync` over host.rs `messages_page`)

const WORDS: [&str; 32] = [
    "the", "build", "fails", "because", "test", "module", "function", "returns", "error", "value", "update", "config", "check", "file", "line", "change", "agent", "branch", "commit", "review", "type", "string", "path", "remote", "message", "frame", "relay", "sync", "page", "should", "then", "with",
];

fn prose(rng: &mut Rng, bytes: usize) -> String {
    let mut text = String::with_capacity(bytes + 16);
    while text.len() < bytes {
        text.push_str(WORDS[(rng.next() % WORDS.len() as u64) as usize]);
        text.push(if rng.next().is_multiple_of(12) { '\n' } else { ' ' });
    }
    text
}

fn code(rng: &mut Rng, bytes: usize) -> String {
    let mut text = String::with_capacity(bytes + 64);
    while text.len() < bytes {
        let n = rng.next() % 1000;
        text.push_str(&format!("    let {}_{n} = {}(&{}, {n});\n", WORDS[(n % 32) as usize], WORDS[(rng.next() % 32) as usize], WORDS[(rng.next() % 32) as usize]));
    }
    text
}

/// A realistic mix: short prompts, prose replies, tool output, and now and then a long log.
fn add_history(store: &Store, session: &str, count: usize, rng: &mut Rng) {
    for n in 0..count {
        let jitter = rng.next() as usize;
        let (role, content) = match n % 4 {
            _ if n % 40 == 39 => ("tool", code(rng, 60 * 1024)),
            0 => ("user", prose(rng, 300 + jitter % 300)),
            2 => ("tool", code(rng, 4096 + jitter % 8192)),
            _ => ("assistant", prose(rng, 1024 + jitter % 2048)),
        };
        store.message(session, role, &content).unwrap();
    }
}

fn mirror_store(after: i64) -> (Store, String) {
    let store = Store::open(Path::new(":memory:")).unwrap();
    let project = store.add_project(&std::env::temp_dir()).unwrap();
    let task = store.create_session(&project.id, "claude", "sonnet", "full").unwrap();
    store.db.execute("UPDATE sessions SET remote_device='host',remote_session='h1',remote_synced_id=?2 WHERE id=?1", rusqlite::params![task.id, after]).unwrap();
    (store, task.id)
}

fn synced(store: &Store, local: &str) -> i64 {
    store.db.query_row("SELECT remote_synced_id FROM sessions WHERE id=?1", [local], |r| r.get(0)).unwrap()
}

#[derive(Default)]
struct Synced {
    pages: usize,
    bytes: usize,
    store: Duration,
}

/// mirror.rs `sync`: page by page after the stored position, at most `MAX_PAGES`.
async fn sync(viewer: &Peer, host: &str, remote: &str, store: &Store, local: &str) -> Synced {
    let mut stats = Synced::default();
    for _ in 0..MAX_PAGES {
        let after = synced(store, local);
        let page = viewer.call(host, "task.messages", json!({"sessionId": remote, "afterId": after})).await.unwrap();
        stats.pages += 1;
        stats.bytes += page.to_string().len();
        let (more, took) = time(|| mirror::store_page(store, local, after, &page).unwrap());
        stats.store += took;
        if !more {
            break;
        }
    }
    stats
}

fn history_host(store: Arc<Mutex<Store>>, remote: String) -> Handler {
    Arc::new(move |_, method, params| {
        let store = store.lock().unwrap();
        match method {
            "task.messages" => host::messages_page(&store.db, params["sessionId"].as_str().unwrap_or_default(), params["afterId"].as_i64().unwrap_or(0)).map_or_else(refuse, ok),
            "subscribe" => {
                let last: i64 = store.db.query_row("SELECT COALESCE(MAX(id),0) FROM messages WHERE session_id=?1", [&remote], |r| r.get(0)).unwrap();
                ok(json!({"tasks": [{"sessionId": remote, "status": "idle", "lastId": last}]}))
            }
            _ => refuse("Unknown remote method."),
        }
    })
}

fn host_store() -> (Store, String) {
    let store = Store::open(Path::new(":memory:")).unwrap();
    let project = store.add_project(&std::env::temp_dir()).unwrap();
    let task = store.create_session(&project.id, "claude", "sonnet", "full").unwrap();
    (store, task.id)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore]
async fn history_sync() {
    let mut table = Table::new("History sync (mirror.rs sync, host.rs messages_page, PAGE_BUDGET 180 KB)");
    let mut local_table = Table::new("History sync, local work per page");
    for count in [200usize, 1000, 3000] {
        let (store, remote) = host_store();
        let mut rng = Rng(count as u64 * 31 + 1);
        add_history(&store, &remote, count, &mut rng);
        let total: i64 = store.db.query_row("SELECT COALESCE(SUM(LENGTH(content)),0) FROM messages WHERE session_id=?1", [&remote], |r| r.get(0)).unwrap();
        let first_page = host::messages_page(&store.db, &remote, 0).unwrap().to_string();
        let gzip = gzip_len(first_page.as_bytes()).map_or("gzip n/a".into(), |z| format!("gzip -6 page {:.0}% of raw", z as f64 * 100.0 / first_page.len() as f64));
        let build: Vec<_> = (0..5).map(|_| time(|| host::messages_page(&store.db, &remote, 0).unwrap()).1).collect();
        local_table.add(format!("{count} msgs host messages_page (first page)"), &build, gzip);
        // One more turn for the run-end case.
        let turn_from: i64 = store.db.query_row("SELECT MAX(id) FROM messages WHERE session_id=?1", [&remote], |r| r.get(0)).unwrap();
        add_history(&store, &remote, 30, &mut rng);
        let store = Arc::new(Mutex::new(store));
        for profile in PROFILES {
            let (mut full, mut turn) = (Vec::new(), Vec::new());
            let (mut stats, mut turn_stats, mut stores, mut copied) = (Synced::default(), Synced::default(), Vec::new(), 0);
            for _ in 0..3 {
                // A fresh pair per run, so earlier runs don't spend this one's relay burst.
                let session = pair(profile, history_host(store.clone(), remote.clone()), true).await;
                let (viewer, local) = mirror_store(0);
                let started = Instant::now();
                stats = sync(&session.viewer, &session.host.id, &remote, &viewer, &local).await;
                full.push(started.elapsed());
                stores.push(stats.store / stats.pages as u32);
                copied = viewer.db.query_row("SELECT COUNT(*) FROM messages WHERE session_id=?1", [&local], |r| r.get::<_, i64>(0)).unwrap();
                let (viewer, local) = mirror_store(turn_from);
                let started = Instant::now();
                turn_stats = sync(&session.viewer, &session.host.id, &remote, &viewer, &local).await;
                turn.push(started.elapsed());
            }
            table.add(
                format!("{} first sync, {count}+30 msgs", profile.name),
                &full,
                format!("{} raw content; {} pages, {} sent; copied {copied}/{}", size(total as usize), stats.pages, size(stats.bytes), count + 30),
            );
            table.add(format!("{} run-end sync, 30 new msgs", profile.name), &turn, format!("{} pages, {} sent", turn_stats.pages, size(turn_stats.bytes)));
            if profile.one_way.is_zero() {
                local_table.add(format!("{count} msgs viewer store_page per page"), &stores, "");
            }
        }
    }
    local_table.print();
    table.print();
}

// ---------------------------------------------------------------------------------------
// 7. Reconnect and resume

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore]
async fn reconnect_resume() {
    let mut table = Table::new("Reconnect after a dropped socket: backoff, connect, subscribe, catch-up of 20 new messages");
    for profile in PROFILES {
        let (store, remote) = host_store();
        let mut rng = Rng(5);
        add_history(&store, &remote, 200, &mut rng);
        let store = Arc::new(Mutex::new(store));
        let Pair { relay, host_identity, viewer_identity, host, viewer } = pair(profile, history_host(store.clone(), remote.clone()), true).await;
        let (mirror, local) = mirror_store(0);
        sync(&viewer, &host.id, &remote, &mirror, &local).await;
        let mut viewer = Some(viewer);
        let (mut connects, mut subscribes, mut catchups, mut totals, mut without) = (Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new());
        for _ in 0..5 {
            add_history(&store.lock().unwrap(), &remote, 20, &mut rng);
            let dropped = Instant::now();
            drop(viewer.take());
            tokio::time::sleep(FIRST_BACKOFF).await;
            let (peer, connect) = Peer::connect(&relay, &viewer_identity, &[&host_identity], None, true).await;
            let started = Instant::now();
            let reply = peer.call(&host.id, "subscribe", json!({"sessionIds": [remote]})).await.unwrap();
            subscribes.push(started.elapsed());
            let started = Instant::now();
            if reply["tasks"][0]["lastId"].as_i64().unwrap() > synced(&mirror, &local) {
                sync(&peer, &host.id, &remote, &mirror, &local).await;
            }
            catchups.push(started.elapsed());
            connects.push(connect);
            totals.push(dropped.elapsed());
            without.push(dropped.elapsed() - FIRST_BACKOFF);
            viewer = Some(Arc::new(peer));
        }
        table.add(format!("{} backoff before the first retry", profile.name), &[FIRST_BACKOFF], "socket.rs run(): delay starts at 1 s");
        table.add(format!("{} connect until presence", profile.name), &connects, "");
        table.add(format!("{} subscribe RPC", profile.name), &subscribes, "");
        table.add(format!("{} catch-up sync", profile.name), &catchups, "");
        table.add(format!("{} drop to caught up, excl. backoff", profile.name), &without, "");
        table.add(format!("{} drop to caught up, total", profile.name), &totals, "");
    }
    table.print();
    println!("\nHalf-open socket (no FIN): socket.rs pings every {PING_S} s and gives up after {SILENT_S} s silent, so a dead link is noticed after {SILENT_S}-{} s (computed from constants, not measured).", SILENT_S + PING_S);
}
