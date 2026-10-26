//! Images for a task on another computer. The viewer reads its own captures
//! (`browser-captures/<uuid>.png`, where pasted, picked and screenshot images all live) and
//! sends each in `image.put` chunks that fit a relay frame. The host checks the bytes, stores
//! them in its own capture folder under an id it makes, and accepts those ids only in a later
//! `task.send` or `task.start` from the same computer.
use super::client;
use crate::{prompt_attachments, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Mutex, OnceLock};
use std::task::Poll;
use std::time::{Duration, Instant};
use tauri::Manager;

/// Every harness path takes at most four images per message.
pub(crate) const MAX_IMAGES: usize = 4;
/// The capture pipeline's own limit per image.
pub(crate) const MAX_BYTES: usize = 5 * 1024 * 1024;
/// Raw bytes per `image.put`: base64 makes 96 KB, under the client's 110 KB of params and,
/// sealed, well under the relay's 256 KB frame.
pub(crate) const CHUNK: usize = 72 * 1024;
const MAX_CHUNKS: usize = MAX_BYTES.div_ceil(CHUNK);
/// The relay lets a computer send 100 frames at once, then 20 a second (`relay/src/limits.ts`).
/// Image chunks spend at most [`BURST`] of the bucket and refill at [`RATE`], so the rest of
/// the bucket and 2 frames a second stay free for requests, prompts and events.
const BURST: f64 = 80.0;
const RATE: f64 = 18.0;
/// Chunks sent but not yet answered. The host runs `image.put` in arrival order on one
/// lane per computer (`socket.rs`), so a window keeps the link busy without reordering.
const WINDOW: usize = 8;
/// Uploads one computer may have half sent, and stored images it may hold unclaimed.
const MAX_PARTIAL: usize = 4;
const MAX_READY: usize = 16;
/// A half-sent upload, or a stored image nobody claimed, is forgotten after this.
const TTL: Duration = Duration::from_secs(15 * 60);
const RESEND: &str = "An image did not arrive whole. Send the message again.";

/// The image type of `bytes` by its magic number: PNG, JPEG or WebP, the types the
/// attachment pipeline decodes. Anything else is None.
pub(crate) fn kind(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("jpeg")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("webp")
    } else {
        None
    }
}

/// A capture id as the pipeline writes it: a lowercase hyphenated UUID, so it can only
/// ever name `<id>.png` inside the capture folder.
pub(crate) fn valid_image_id(id: &str) -> bool {
    uuid::Uuid::parse_str(id).is_ok_and(|parsed| parsed.to_string() == id)
}

/// `imageIds` in a `task.send` or `task.start`: up to four distinct capture ids.
pub(crate) fn ids_param(params: &Value) -> Result<Vec<String>> {
    let Some(list) = params.get("imageIds").filter(|v| !v.is_null()) else { return Ok(Vec::new()) };
    let list = list.as_array().ok_or("Invalid imageIds.")?;
    if list.len() > MAX_IMAGES {
        return Err(format!("Attach up to {MAX_IMAGES} images per message."));
    }
    let mut ids: Vec<String> = Vec::new();
    for id in list {
        let id = id.as_str().filter(|id| valid_image_id(id)).ok_or("Invalid imageIds.")?;
        if ids.iter().any(|seen| seen == id) {
            return Err("Invalid imageIds.".into());
        }
        ids.push(id.to_owned());
    }
    Ok(ids)
}

/// One `image.put`: chunk `index` of upload `upload`, an image of `size` bytes.
#[derive(Debug, PartialEq)]
pub(crate) struct Chunk {
    pub upload: String,
    pub index: usize,
    pub size: usize,
    pub data: Vec<u8>,
}

pub(crate) fn parse_chunk(params: &Value) -> Result<Chunk> {
    let upload = super::host::id_param(params, "uploadId")?;
    let index = params["index"].as_u64().filter(|index| (*index as usize) < MAX_CHUNKS).ok_or("Invalid index.")? as usize;
    let size = params["size"].as_u64().filter(|size| (1..=MAX_BYTES as u64).contains(size)).ok_or("Each image must be 5 MB or smaller.")? as usize;
    let data = params["data"].as_str().filter(|data| data.len() <= CHUNK.div_ceil(3) * 4).ok_or("Invalid image data.")?;
    let data = STANDARD.decode(data).map_err(|_| "Invalid image data.")?;
    if data.is_empty() || data.len() > CHUNK {
        return Err("Invalid image data.".into());
    }
    Ok(Chunk { upload, index, size, data })
}

struct Partial {
    size: usize,
    bytes: Vec<u8>,
    next: usize,
    touched: Instant,
}

/// The host's uploads in progress and its stored images not yet claimed, by sender.
#[derive(Default)]
pub(crate) struct Uploads {
    partial: HashMap<(String, String), Partial>,
    ready: HashMap<String, (String, Instant)>,
}

impl Uploads {
    fn expire(&mut self, now: Instant) {
        self.partial.retain(|_, partial| now.duration_since(partial.touched) < TTL);
        self.ready.retain(|_, (_, stored)| now.duration_since(*stored) < TTL);
    }

    /// Adds one chunk in order. Returns the whole image once its last chunk is in and its
    /// bytes are an image; a chunk out of order, too long or not an image drops the upload.
    pub(crate) fn add(&mut self, from: &str, chunk: Chunk, now: Instant) -> Result<Option<Vec<u8>>> {
        self.expire(now);
        let key = (from.to_owned(), chunk.upload);
        if chunk.index == 0 {
            let open = self.partial.keys().filter(|(sender, upload)| sender == from && *upload != key.1).count();
            if open >= MAX_PARTIAL {
                return Err("Too many images are on their way. Try again in a moment.".into());
            }
            self.partial.insert(key.clone(), Partial { size: chunk.size, bytes: Vec::with_capacity(chunk.size), next: 0, touched: now });
        }
        let partial = self.partial.get_mut(&key).ok_or(RESEND)?;
        if chunk.index != partial.next || chunk.size != partial.size || partial.bytes.len() + chunk.data.len() > partial.size {
            self.partial.remove(&key);
            return Err(RESEND.into());
        }
        partial.bytes.extend_from_slice(&chunk.data);
        partial.next += 1;
        partial.touched = now;
        if partial.bytes.len() < partial.size {
            return Ok(None);
        }
        let bytes = self.partial.remove(&key).map(|partial| partial.bytes).unwrap_or_default();
        kind(&bytes).ok_or("Only PNG, JPEG and WebP images can be sent to another computer.")?;
        Ok(Some(bytes))
    }

    /// Records an image stored for `from`, which only `from` may claim.
    pub(crate) fn stored(&mut self, from: &str, id: &str, now: Instant) -> Result<()> {
        self.expire(now);
        if self.ready.values().filter(|(sender, _)| sender == from).count() >= MAX_READY {
            return Err("Too many images are waiting on this computer. Send the message again.".into());
        }
        self.ready.insert(id.to_owned(), (from.to_owned(), now));
        Ok(())
    }

    /// Takes the images a message names, all or none: each must have been sent by `from`.
    pub(crate) fn claim(&mut self, from: &str, ids: &[String], now: Instant) -> Result<()> {
        self.expire(now);
        if !ids.iter().all(|id| self.ready.get(id).is_some_and(|(sender, _)| sender == from)) {
            return Err("An image for this message is missing on this computer. Send it again.".into());
        }
        for id in ids {
            self.ready.remove(id);
        }
        Ok(())
    }
}

fn capture_dir(app: &tauri::AppHandle) -> Result<PathBuf> {
    Ok(app.path().app_cache_dir().map_err(|e| e.to_string())?.join("browser-captures"))
}

/// Writes a received image into `dir` under a new id, through the same import the
/// composer uses: it decodes the bytes (so only a real image is kept), normalizes them to
/// the pipeline's PNG and names the file itself. Returns the new id.
pub(crate) fn store(dir: &Path, bytes: &[u8]) -> Result<String> {
    let kind = kind(bytes).ok_or("Only PNG, JPEG and WebP images can be sent to another computer.")?;
    if bytes.len() > MAX_BYTES {
        return Err("Each image must be 5 MB or smaller.".into());
    }
    let source = prompt_attachments::ImageSource::Data { name: "Image from another computer.png".into(), data_url: format!("data:image/{kind};base64,{}", STANDARD.encode(bytes)) };
    Ok(prompt_attachments::import_image(dir, source)?.id)
}

/// Host side of `image.put`.
pub(crate) async fn put(app: &tauri::AppHandle, from: &str, chunk: Chunk) -> Result<Value> {
    let whole = super::remote(app).lock().uploads.add(from, chunk, Instant::now())?;
    let Some(bytes) = whole else { return Ok(json!({})) };
    let dir = capture_dir(app)?;
    let id = tauri::async_runtime::spawn_blocking({
        let dir = dir.clone();
        move || store(&dir, &bytes)
    })
    .await
    .map_err(|e| e.to_string())??;
    if let Err(error) = super::remote(app).lock().uploads.stored(from, &id, Instant::now()) {
        let _ = std::fs::remove_file(dir.join(format!("{id}.png")));
        return Err(error);
    }
    Ok(json!({"imageId": id}))
}

/// Host side of a message naming images: they must be this sender's uploads.
pub(crate) fn claim(app: &tauri::AppHandle, from: &str, ids: &[String]) -> Result<()> {
    if ids.is_empty() {
        return Ok(());
    }
    super::remote(app).lock().uploads.claim(from, ids, Instant::now())
}

/// One of this computer's captures, checked like `send_message` checks it.
pub(crate) fn read_capture(dir: &Path, id: &str) -> Result<Vec<u8>> {
    if !valid_image_id(id) {
        return Err("Invalid screenshot attachment.".into());
    }
    let path = dir.join(format!("{id}.png"));
    let metadata = std::fs::symlink_metadata(&path).map_err(|_| "Screenshot is unavailable. Capture it again.".to_string())?;
    if !metadata.file_type().is_file() || metadata.len() as usize > MAX_BYTES {
        return Err("Invalid screenshot attachment.".into());
    }
    let bytes = std::fs::read(&path).map_err(|_| "Screenshot is unavailable. Capture it again.".to_string())?;
    kind(&bytes).ok_or("Invalid screenshot attachment.")?;
    Ok(bytes)
}

/// The `image.put` params for one capture, in order.
pub(crate) fn chunks(upload: &str, bytes: &[u8]) -> Vec<Value> {
    bytes.chunks(CHUNK).enumerate().map(|(index, data)| json!({"uploadId": upload, "index": index, "size": bytes.len(), "data": STANDARD.encode(data)})).collect()
}

/// A local copy of the relay's frame bucket as image chunks spend it: [`BURST`] frames
/// at once, then [`RATE`] a second. `tokens` goes negative while callers queue for frames.
pub(crate) struct Budget {
    tokens: f64,
    at: Instant,
}

impl Budget {
    pub(crate) fn new(now: Instant) -> Self {
        Self { tokens: BURST, at: now }
    }

    /// Reserves one frame and returns how long to wait before sending it.
    fn take(&mut self, now: Instant) -> Duration {
        let idle = now.saturating_duration_since(self.at).as_secs_f64();
        self.tokens = (self.tokens + idle * RATE).min(BURST) - 1.0;
        self.at = now;
        Duration::from_secs_f64((-self.tokens).max(0.0) / RATE)
    }
}

/// Every upload from this computer shares the relay's bucket, so they share this one.
fn shared_budget() -> &'static Mutex<Budget> {
    static BUDGET: OnceLock<Mutex<Budget>> = OnceLock::new();
    BUDGET.get_or_init(|| Mutex::new(Budget::new(Instant::now())))
}

fn settle(whole: bool, reply: &Value, stored: &mut Vec<String>) -> Result<()> {
    if whole {
        let id = reply["imageId"].as_str().filter(|id| valid_image_id(id)).ok_or("The other computer did not take the image.")?;
        stored.push(id.to_owned());
    }
    Ok(())
}

/// Sends every image as `image.put` chunks and returns the ids the host stored them under,
/// in order. `put` makes one request; its first poll must send the frame, which this does
/// at once, so frames leave in chunk order. Up to [`WINDOW`] requests are unanswered at a
/// time, and `budget` paces the frames under the relay's rate limit.
pub(crate) async fn upload<F, Fut>(images: &[Vec<u8>], budget: &Mutex<Budget>, mut put: F) -> Result<Vec<String>>
where
    F: FnMut(Value) -> Fut,
    Fut: Future<Output = Result<Value>>,
{
    let mut stored = Vec::with_capacity(images.len());
    let mut flight: VecDeque<(bool, Pin<Box<Fut>>)> = VecDeque::new();
    for bytes in images {
        if bytes.is_empty() {
            return Err("Invalid screenshot attachment.".into());
        }
        let parts = chunks(&uuid::Uuid::new_v4().to_string(), bytes);
        let last = parts.len() - 1;
        for (index, params) in parts.into_iter().enumerate() {
            let wait = budget.lock().map_err(|e| e.to_string())?.take(Instant::now());
            if !wait.is_zero() {
                tokio::time::sleep(wait).await;
            }
            let whole = index == last;
            let mut call = Box::pin(put(params));
            match std::future::poll_fn(|cx| Poll::Ready(call.as_mut().poll(cx))).await {
                Poll::Ready(reply) => settle(whole, &reply?, &mut stored)?,
                Poll::Pending => flight.push_back((whole, call)),
            }
            while flight.len() >= WINDOW {
                let (whole, call) = flight.pop_front().expect("a full window");
                settle(whole, &call.await?, &mut stored)?;
            }
        }
    }
    while let Some((whole, call)) = flight.pop_front() {
        settle(whole, &call.await?, &mut stored)?;
    }
    Ok(stored)
}

/// Viewer side: sends this computer's captures to `device` and returns the ids it stored
/// them under, in the same order.
pub(crate) async fn send(app: &tauri::AppHandle, device: &str, ids: &[String]) -> Result<Vec<String>> {
    if ids.len() > MAX_IMAGES {
        return Err(format!("Attach up to {MAX_IMAGES} images per message."));
    }
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let dir = capture_dir(app)?;
    let images = ids.iter().map(|id| read_capture(&dir, id)).collect::<Result<Vec<_>>>()?;
    upload(&images, shared_budget(), |params| client::call(app, device, "image.put", params)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

    fn png() -> Vec<u8> {
        STANDARD.decode(PNG).unwrap()
    }

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pandacode-remote-images-{label}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn chunk(upload: &str, index: usize, size: usize, data: &[u8]) -> Chunk {
        Chunk { upload: upload.into(), index, size, data: data.to_vec() }
    }

    #[test]
    fn images_are_known_by_their_magic_bytes_only() {
        assert_eq!(kind(&png()), Some("png"));
        assert_eq!(kind(&[0xff, 0xd8, 0xff, 0xe0, 0, 0]), Some("jpeg"));
        assert_eq!(kind(b"RIFF\x10\0\0\0WEBPVP8 "), Some("webp"));
        for other in [&b"GIF89a......"[..], b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>", b"%PDF-1.7", b"RIFF\x10\0\0\0WAVE", b"\x89PN", b""] {
            assert_eq!(kind(other), None, "{other:?}");
        }
    }

    #[test]
    fn image_ids_are_canonical_uuids_and_at_most_four() {
        let id = || uuid::Uuid::new_v4().to_string();
        let (a, b) = (id(), id());
        assert_eq!(ids_param(&json!({})).unwrap(), Vec::<String>::new());
        assert_eq!(ids_param(&json!({"imageIds": null})).unwrap(), Vec::<String>::new());
        assert_eq!(ids_param(&json!({"imageIds": [a, b]})).unwrap(), vec![a.clone(), b.clone()]);
        assert!(ids_param(&json!({"imageIds": [id(), id(), id(), id(), id()]})).unwrap_err().contains("up to 4"));
        for bad in [json!([a, a]), json!(["../../etc/passwd"]), json!([a.to_uppercase()]), json!([format!("{a}.png")]), json!([a.replace('-', "")]), json!([1]), json!("x")] {
            assert!(ids_param(&json!({"imageIds": bad})).is_err(), "{bad}");
        }
    }

    #[test]
    fn chunks_fit_a_request_and_parse_back() {
        let bytes: Vec<u8> = (0..CHUNK * 2 + 10).map(|i| i as u8).collect();
        let parts = chunks("up-1", &bytes);
        assert_eq!(parts.len(), 3);
        for part in &parts {
            // Under `client::MAX_PARAMS` (110 KB), so it seals under the relay's 256 KB frame.
            assert!(part.to_string().len() < 110 * 1024);
        }
        let parsed: Vec<Chunk> = parts.iter().map(|part| parse_chunk(part).unwrap()).collect();
        assert_eq!(parsed.iter().flat_map(|c| c.data.clone()).collect::<Vec<_>>(), bytes);
        assert!(parsed.iter().all(|c| c.size == bytes.len() && c.upload == "up-1"));
        let base = parts[0].clone();
        let with = |key: &str, value: Value| {
            let mut params = base.clone();
            params[key] = value;
            params
        };
        assert!(parse_chunk(&with("size", json!(MAX_BYTES + 1))).unwrap_err().contains("5 MB"));
        assert!(parse_chunk(&with("size", json!(0))).is_err());
        assert!(parse_chunk(&with("index", json!(MAX_CHUNKS))).is_err());
        assert!(parse_chunk(&with("data", json!("not base64!"))).is_err());
        assert!(parse_chunk(&with("data", json!(STANDARD.encode(vec![0u8; CHUNK + 1])))).is_err());
        assert!(parse_chunk(&with("data", json!(""))).is_err());
        assert!(parse_chunk(&with("uploadId", json!("has space"))).is_err());
    }

    #[test]
    fn uploads_assemble_in_order_and_refuse_what_is_not_an_image() {
        let now = Instant::now();
        let mut uploads = Uploads::default();
        let image = png();
        let (head, tail) = image.split_at(10);
        assert_eq!(uploads.add("viewer", chunk("u1", 0, image.len(), head), now).unwrap(), None);
        assert_eq!(uploads.add("viewer", chunk("u1", 1, image.len(), tail), now).unwrap(), Some(image.clone()));
        // Out of order, a changed size, or more bytes than announced drop the upload.
        uploads.add("viewer", chunk("u2", 0, image.len(), head), now).unwrap();
        assert_eq!(uploads.add("viewer", chunk("u2", 2, image.len(), tail), now).unwrap_err(), RESEND);
        assert_eq!(uploads.add("viewer", chunk("u2", 1, image.len(), tail), now).unwrap_err(), RESEND, "it was dropped");
        uploads.add("viewer", chunk("u3", 0, 12, head), now).unwrap();
        assert!(uploads.add("viewer", chunk("u3", 1, 12, tail), now).is_err());
        // Another computer can't continue someone else's upload.
        uploads.add("viewer", chunk("u4", 0, image.len(), head), now).unwrap();
        assert!(uploads.add("intruder", chunk("u4", 1, image.len(), tail), now).is_err());
        // Whole, but not an image by its bytes.
        let text = b"#!/bin/sh\nrm -rf /\n";
        assert!(uploads.add("viewer", chunk("u5", 0, text.len(), text), now).unwrap_err().contains("PNG, JPEG and WebP"));
        // Half-sent uploads are capped per computer and expire.
        let mut uploads = Uploads::default();
        for n in 0..MAX_PARTIAL {
            uploads.add("viewer", chunk(&format!("p{n}"), 0, image.len(), head), now).unwrap();
        }
        assert!(uploads.add("viewer", chunk("one-more", 0, image.len(), head), now).unwrap_err().contains("Too many"));
        uploads.add("other", chunk("theirs", 0, image.len(), head), now).unwrap();
        uploads.add("viewer", chunk("later", 0, image.len(), head), now + TTL).unwrap();
    }

    #[test]
    fn only_the_sender_claims_its_stored_images_once() {
        let now = Instant::now();
        let mut uploads = Uploads::default();
        let (a, b) = (uuid::Uuid::new_v4().to_string(), uuid::Uuid::new_v4().to_string());
        uploads.stored("viewer", &a, now).unwrap();
        uploads.stored("viewer", &b, now).unwrap();
        assert!(uploads.claim("intruder", std::slice::from_ref(&a), now).is_err());
        // All or none: an unknown id leaves the others claimable.
        assert!(uploads.claim("viewer", &[a.clone(), uuid::Uuid::new_v4().to_string()], now).is_err());
        uploads.claim("viewer", &[a.clone(), b.clone()], now).unwrap();
        assert!(uploads.claim("viewer", &[a], now).is_err(), "claimed once");
        uploads.claim("viewer", &[], now).unwrap();
        let c = uuid::Uuid::new_v4().to_string();
        uploads.stored("viewer", &c, now).unwrap();
        assert!(uploads.claim("viewer", &[c], now + TTL).is_err(), "unclaimed images expire");
        for _ in 0..MAX_READY {
            uploads.stored("viewer", &uuid::Uuid::new_v4().to_string(), now).unwrap();
        }
        assert!(uploads.stored("viewer", &uuid::Uuid::new_v4().to_string(), now).is_err());
    }

    #[test]
    fn the_frame_budget_spends_a_burst_then_refills_below_the_relay_rate() {
        let start = Instant::now();
        let mut budget = Budget::new(start);
        const {
            assert!(BURST < 100.0 && RATE < 20.0, "headroom under the relay's 100 burst and 20/s");
        }
        for _ in 0..BURST as usize {
            assert_eq!(budget.take(start), Duration::ZERO);
        }
        let wait = |n: f64| Duration::from_secs_f64(n / RATE);
        let close = |a: Duration, b: Duration| a.abs_diff(b) < Duration::from_millis(1);
        assert!(close(budget.take(start), wait(1.0)));
        assert!(close(budget.take(start), wait(2.0)), "queued callers line up");
        // Idle time pays the queue back, then refills up to the burst and no further.
        assert!(close(budget.take(start + wait(2.0)), wait(1.0)));
        let mut budget = Budget::new(start);
        budget.take(start);
        for _ in 0..5 {
            assert_eq!(budget.take(start + Duration::from_secs(60)), Duration::ZERO);
        }
        assert!((budget.tokens - (BURST - 5.0)).abs() < 1e-9);
        // Never faster than the rate in the long run: 284 chunks (4 x 5 MB) fit the relay.
        let mut budget = Budget::new(start);
        let finish = (0..284).map(|_| budget.take(start)).last().unwrap();
        assert!(finish.as_secs_f64() * 20.0 + 100.0 >= 284.0, "{finish:?}");
    }

    /// A host that answers after a delay and records what arrived and the most requests it
    /// had unanswered at once, checking chunks with the real `Uploads`.
    struct Host {
        uploads: Mutex<Uploads>,
        arrived: Mutex<Vec<(String, usize)>>,
        open: std::sync::atomic::AtomicUsize,
        most: std::sync::atomic::AtomicUsize,
    }

    impl Host {
        fn new() -> Arc<Self> {
            Arc::new(Self { uploads: Mutex::default(), arrived: Mutex::default(), open: 0.into(), most: 0.into() })
        }

        /// The frame arrives when this is called, so arrival order is call order.
        fn put(self: &Arc<Self>, params: Value) -> impl Future<Output = Result<Value>> {
            use std::sync::atomic::Ordering::SeqCst;
            let chunk = parse_chunk(&params).unwrap();
            self.arrived.lock().unwrap().push((chunk.upload.clone(), chunk.index));
            let open = self.open.fetch_add(1, SeqCst) + 1;
            self.most.fetch_max(open, SeqCst);
            let reply = self.uploads.lock().unwrap().add("viewer", chunk, Instant::now());
            let host = self.clone();
            async move {
                tokio::time::sleep(Duration::from_millis(5)).await;
                host.open.fetch_sub(1, SeqCst);
                reply.map(|whole| whole.map_or(json!({}), |_| json!({"imageId": uuid::Uuid::new_v4().to_string()})))
            }
        }
    }

    fn fake_image(len: usize, tag: u8) -> Vec<u8> {
        let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
        bytes.resize(len, tag);
        bytes
    }

    #[tokio::test]
    async fn uploads_pipeline_chunks_in_order_and_return_ids_in_image_order() {
        let host = Host::new();
        let images = [fake_image(CHUNK * 20 + 5, 1), fake_image(CHUNK * 3, 2), fake_image(100, 3)];
        let budget = Mutex::new(Budget::new(Instant::now()));
        let ids = upload(&images, &budget, |params| host.put(params)).await.unwrap();
        assert_eq!(ids.len(), 3);
        assert!(ids.iter().all(|id| valid_image_id(id)));
        // Chunk indexes arrive 0, 1, 2… within each upload, and uploads don't interleave.
        let arrived = host.arrived.lock().unwrap().clone();
        let expected: Vec<usize> = (0..21).chain(0..3).chain(0..1).collect();
        assert_eq!(arrived.iter().map(|(_, index)| *index).collect::<Vec<_>>(), expected);
        assert_eq!(arrived.iter().map(|(upload, _)| upload.clone()).collect::<std::collections::HashSet<_>>().len(), 3);
        let most = host.most.load(std::sync::atomic::Ordering::SeqCst);
        assert!(most > 1 && most <= WINDOW, "{most} in flight");
    }

    #[tokio::test]
    async fn uploads_wait_for_the_budget_and_stop_at_the_first_failure() {
        let host = Host::new();
        let images = [fake_image(CHUNK * 3, 1)];
        // An empty bucket makes each chunk wait one frame's refill after the last.
        let budget = Mutex::new(Budget { tokens: 0.0, at: Instant::now() });
        let started = Instant::now();
        upload(&images, &budget, |params| host.put(params)).await.unwrap();
        assert!(started.elapsed() >= Duration::from_secs_f64(2.5 / RATE), "{:?}", started.elapsed());
        // A refused chunk ends the upload: nothing after the failing reply is sent past the window.
        let calls = std::sync::atomic::AtomicUsize::new(0);
        let budget = Mutex::new(Budget::new(Instant::now()));
        let failing = upload(&[fake_image(CHUNK * 40, 1)], &budget, |_| {
            let n = calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            async move {
                tokio::time::sleep(Duration::from_millis(5)).await;
                if n == 0 { Err("The other computer did not answer in time.".to_owned()) } else { Ok(json!({})) }
            }
        })
        .await;
        assert_eq!(failing.unwrap_err(), "The other computer did not answer in time.");
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), WINDOW);
        // A missing id, or no image at all, is an error too.
        assert!(upload(&[fake_image(10, 1)], &budget, |_| async { Ok(json!({})) }).await.unwrap_err().contains("did not take"));
        assert!(upload(&[Vec::new()], &budget, |_| async { Ok(json!({})) }).await.is_err());
    }

    #[test]
    fn the_host_stores_images_under_its_own_id_and_refuses_disguises() {
        let dir = temp_dir("store");
        let id = store(&dir, &png()).unwrap();
        assert!(valid_image_id(&id));
        let saved = dir.join(format!("{id}.png"));
        assert!(std::fs::read(&saved).unwrap().starts_with(b"\x89PNG"));
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1, "nothing else is written");
        // PNG magic with a broken body is not decoded, so it is not kept.
        let mut broken = b"\x89PNG\r\n\x1a\n".to_vec();
        broken.extend_from_slice(&[0; 64]);
        assert!(store(&dir, &broken).is_err());
        assert!(store(&dir, b"GIF89a\x01\0\x01\0").is_err());
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        // The viewer reads only its own capture ids, never another path.
        assert_eq!(read_capture(&dir, &id).unwrap(), std::fs::read(&saved).unwrap());
        assert!(read_capture(&dir, "../secret").is_err());
        assert!(read_capture(&dir, &uuid::Uuid::new_v4().to_string()).is_err());
        let fake = uuid::Uuid::new_v4().to_string();
        std::fs::write(dir.join(format!("{fake}.png")), b"plain text").unwrap();
        assert!(read_capture(&dir, &fake).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }
}
