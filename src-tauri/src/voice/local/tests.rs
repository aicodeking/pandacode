use super::audio::{self, RunError};
use super::catalog::{self, Catalog};
use super::store::{Active, Item, Store};
use super::worker::{self, Failure, TranscribeRequest, Worker, WorkerCommand};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const REV: &str = "0123456789abcdef0123456789abcdef01234567";

struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("pandacode-speech-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn model_json(id: &str, filename: &str, languages: &[&str], detect: bool) -> serde_json::Value {
    serde_json::json!({
        "id": id, "revision": REV, "name": "Test", "description": "A test model",
        "filename": filename, "size": 4096, "sha256": "a".repeat(64), "license": "mit",
        "languages": languages, "benchmark": null, "recommended": false,
        "supportsStreaming": false, "supportsLanguageDetection": detect, "supportsTranslation": false
    })
}

fn catalog_json(models: Vec<serde_json::Value>) -> String {
    serde_json::json!({
        "source": "test", "sourceVersion": "1", "engineVersion": "0.4.1", "generated": "test",
        "vad": { "id": "test/vad", "revision": REV, "filename": "vad.gguf", "size": 10, "sha256": "b".repeat(64) },
        "defaultModel": "test/one",
        "models": models,
    })
    .to_string()
}

fn model(languages: &[&str], detect: bool) -> catalog::Model {
    serde_json::from_value(model_json("test/m", "m.gguf", languages, detect)).unwrap()
}

mod catalog_audio;
mod download;
mod model_test;
mod prefs;
mod test_recordings;
mod timeouts_and_platform;
mod worker_child;

const ECHO_ENV: &str = "PANDACODE_SPEECH_ECHO_CHILD";

/// Not a real test: the body of the echo child that worker tests spawn from this test binary.
#[test]
#[ignore]
fn speech_echo_child() {
    if std::env::var_os(ECHO_ENV).is_some() {
        let _ = worker::run_child(&mut worker::Echo);
        std::process::exit(0);
    }
}

fn echo_command() -> WorkerCommand {
    WorkerCommand {
        program: std::env::current_exe().unwrap(),
        args: ["voice::local::tests::speech_echo_child", "--exact", "--ignored", "--nocapture", "--test-threads=1"]
            .map(String::from)
            .to_vec(),
        env: vec![(ECHO_ENV.into(), "1".into())],
    }
}

#[cfg(unix)]
fn alive(pid: u32) -> bool {
    unsafe { libc::kill(pid as i32, 0) == 0 }
}
#[cfg(not(unix))]
fn alive(_pid: u32) -> bool {
    false
}

// ---- downloads ----

#[derive(Clone, Copy, PartialEq)]
enum Mode {
    Normal,
    IgnoreRange,
    WrongRange,
    RedirectSameHost,
    RedirectAway,
    /// Send headers and the first 1000 bytes, then stall.
    Stall,
    /// Serve models normally but stall the VAD (`vad.gguf`) like `Stall`.
    StallVad,
    /// Read the request, then never answer.
    HangHeaders,
}

struct Mock {
    base: String,
    requests: Arc<Mutex<Vec<String>>>,
}

async fn mock(body: Vec<u8>, mode: Mode) -> Mock {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let requests = Arc::new(Mutex::new(Vec::new()));
    let log = requests.clone();
    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else { break };
            let (body, log) = (body.clone(), log.clone());
            tokio::spawn(async move {
                let mut buf = Vec::new();
                let mut byte = [0u8; 1];
                while !buf.ends_with(b"\r\n\r\n") {
                    if socket.read(&mut byte).await.unwrap_or(0) == 0 { return; }
                    buf.push(byte[0]);
                }
                let head = String::from_utf8_lossy(&buf).to_string();
                let path = head.split_whitespace().nth(1).unwrap_or("").to_owned();
                let range = head.lines().find_map(|l| {
                    let l = l.to_ascii_lowercase();
                    l.strip_prefix("range: bytes=").map(|r| r.trim().trim_end_matches('-').parse::<usize>().unwrap())
                });
                log.lock().unwrap().push(format!("{path} {range:?}"));
                if mode == Mode::HangHeaders {
                    tokio::time::sleep(Duration::from_secs(60)).await;
                    return;
                }
                let redirect = |to: &str| format!("HTTP/1.1 302 Found\r\nLocation: {to}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                let head = if !path.starts_with("/moved") && mode == Mode::RedirectSameHost {
                    redirect(&format!("/moved{path}"))
                } else if mode == Mode::RedirectAway {
                    redirect("http://evil.example/model.gguf")
                } else if let (Some(start), Mode::Normal | Mode::Stall | Mode::WrongRange) = (range, mode) {
                    let shown = if mode == Mode::WrongRange { start + 1 } else { start };
                    let head = format!("HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {shown}-{}/{}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len() - 1, body.len(), body.len() - start);
                    let _ = socket.write_all(head.as_bytes()).await;
                    let _ = socket.write_all(&body[start..]).await;
                    return;
                } else {
                    format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len())
                };
                let _ = socket.write_all(head.as_bytes()).await;
                if head.starts_with("HTTP/1.1 200") {
                    if mode == Mode::Stall || (mode == Mode::StallVad && path.ends_with("vad.gguf")) {
                        let _ = socket.write_all(&body[..1000]).await;
                        let _ = socket.flush().await;
                        tokio::time::sleep(Duration::from_secs(60)).await;
                    } else {
                        let _ = socket.write_all(&body).await;
                    }
                }
            });
        }
    });
    Mock { base, requests }
}

fn fake_model() -> (Vec<u8>, Item) {
    use sha2::{Digest, Sha256};
    let body: Vec<u8> = (0..4096u32).map(|i| (i * 7 % 251) as u8).collect();
    let item = Item {
        id: "test/model".into(),
        revision: REV.into(),
        filename: "model.gguf".into(),
        size: body.len() as u64,
        sha256: format!("{:x}", Sha256::digest(&body)),
    };
    (body, item)
}

fn active() -> Active {
    Active {
        model_id: "test/model".into(),
        owner: "test/model".into(),
        cancel: Arc::new(AtomicBool::new(false)),
        downloaded: Arc::new(AtomicU64::new(0)),
        verifying: Arc::new(AtomicBool::new(false)),
    }
}

fn store(dir: &Path, base: &str) -> Store {
    Store::for_test(dir, base.into(), Box::new(|_| Ok(u64::MAX)))
}

// ---- live smoke test (network, ~35 MB) ----

const ENGINE_ENV: &str = "PANDACODE_SPEECH_ENGINE_CHILD";

#[test]
#[ignore]
fn speech_engine_child() {
    if std::env::var_os(ENGINE_ENV).is_some() {
        let _ = worker::run_child(&mut super::engine::Engine::default());
        std::process::exit(0);
    }
}

/// `cargo test speech_live_smoke -- --ignored --nocapture`: downloads moonshine-tiny to /tmp,
/// transcribes a generated clip in a real worker, then deletes it.
#[test]
#[ignore]
fn speech_live_smoke() {
    if std::env::var_os(ENGINE_ENV).is_some() || std::env::var_os(ECHO_ENV).is_some() {
        return;
    }
    let dir = PathBuf::from("/tmp").join(format!("pandacode-speech-smoke-{}", uuid::Uuid::new_v4()));
    let temp = Temp(dir.clone());
    let catalog = Catalog::bundled();
    let model = catalog.model("handy-computer/moonshine-tiny-gguf").unwrap();
    let store = Store::new(&temp.0);
    let item = Item::from(model);
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
    let path = rt.block_on(store.fetch(&item, &active())).unwrap();
    assert!(store.installed(&item));
    let command = WorkerCommand {
        program: std::env::current_exe().unwrap(),
        args: ["voice::local::tests::speech_engine_child", "--exact", "--ignored", "--nocapture", "--test-threads=1"].map(String::from).to_vec(),
        env: vec![(ENGINE_ENV.into(), "1".into())],
    };
    let worker = Worker::new(command);
    let loaded = worker.load(&path, &|| false).unwrap();
    eprintln!("loaded on {}: {:?}", loaded.backend, loaded.languages);
    let pcm: Vec<f32> = (0..32_000).map(|i| if i < 16_000 { 0.0 } else { (i as f32 * 0.1).sin() * 0.1 }).collect();
    let request = TranscribeRequest { language: catalog::run_language(model, "auto"), chunk_samples: model.chunk_samples(), ..Default::default() };
    let text = worker.transcribe(&path, &request, &pcm, &|| false).unwrap();
    eprintln!("smoke transcript: {text:?}");
    worker.unload();
    store.delete(&item).unwrap();
    assert!(!path.exists());
}

/// A catalog whose model `test/one` (`one.gguf`) and VAD (`vad.gguf`) both match `body`.
fn local_with(dir: &Path, base: &str, body: &[u8]) -> Arc<super::Local> {
    use sha2::{Digest, Sha256};
    let sha = format!("{:x}", Sha256::digest(body));
    let mut raw: serde_json::Value = serde_json::from_str(&catalog_json(vec![model_json("test/one", "one.gguf", &["en"], false)])).unwrap();
    for entry in ["vad", "models"] {
        let entry = if entry == "vad" { &mut raw["vad"] } else { &mut raw["models"][0] };
        entry["size"] = body.len().into();
        entry["sha256"] = sha.clone().into();
    }
    let catalog = Arc::new(Catalog::parse(&raw.to_string()).unwrap());
    Arc::new(super::Local::with(catalog, store(dir, base), echo_command()))
}

fn view(local: &super::Local) -> serde_json::Value {
    serde_json::to_value(local.catalog_view(None)).unwrap()
}

/// A `Voice` whose on-device side is `local` (see `local_with`).
fn voice_with(dir: &Path, local: Arc<super::Local>) -> super::Voice {
    super::Voice {
        dir: dir.to_path_buf(),
        config_lock: Arc::default(),
        session: Arc::default(),
        cancelled: Arc::default(),
        local,
        closing: Arc::default(),
    }
}

fn patch(value: serde_json::Value) -> super::config::PreferencesPatch {
    serde_json::from_value(value).unwrap()
}

/// Installs `body` as `test/one` (see `local_with`).
fn install_one(local: &super::Local, body: &[u8]) {
    local.store.install_for_test(&Item::from(local.catalog.model("test/one").unwrap()), body);
}
