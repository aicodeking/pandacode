use super::*;

mod basics;
mod close_window;
mod profiles;
mod requests;
mod sessions;
mod transport_http;

struct Temp(std::path::PathBuf);
impl Temp {
    fn new() -> Self {
        let dir =
            std::env::temp_dir().join(format!("pandacode-voice-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        Self(dir)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn input(id: Option<String>, endpoint: &str, key: Option<&str>) -> ProfileInput {
    ProfileInput {
        id,
        name: "Local speech".into(),
        provider: config::Provider::Custom,
        endpoint: endpoint.into(),
        model: "whisper-test".into(),
        language: Some("en".into()),
        key: key.map(str::to_owned),
    }
}
fn json(value: impl Serialize) -> serde_json::Value {
    serde_json::to_value(value).unwrap()
}
fn profile_id(value: &Configuration) -> String {
    json(value)["profiles"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

fn install_session(
    voice: &Voice,
    id: &str,
    phase: Phase,
) -> (watch::Receiver<bool>, std::sync::mpsc::Receiver<()>) {
    let (stop, rx) = std::sync::mpsc::channel();
    let (cancel, cancelled) = watch::channel(false);
    let (_, audio) = watch::channel(None);
    *voice.session.lock().unwrap() = Some(Session {
        id: id.into(),
        request_id: "request".into(),
        profile: Snapshot {
            endpoint: "http://127.0.0.1:8080/stt".into(),
            model: "test".into(),
            language: None,
            key: None,
        },
        route: None,
        phase,
        confirmed: phase != Phase::Starting,
        started: Instant::now(),
        elapsed_ms: 0,
        stop,
        cancel,
        audio,
        thread: None,
    });
    (cancelled, rx)
}

use std::sync::atomic::{AtomicBool, Ordering};

type Spawn = Box<dyn FnOnce(StartIo) -> std::io::Result<std::thread::JoinHandle<()>> + Send>;

/// Stands in for `capture::run`: waits on `device` (a slow device open), then commits and "plays"
/// exactly where the real worker would, without touching a microphone.
fn fake_worker(
    device: Option<std::sync::mpsc::Receiver<()>>,
    played: Arc<AtomicBool>,
    after_commit: impl FnOnce() + Send + 'static,
) -> Spawn {
    Box::new(move |io: StartIo| {
        std::thread::Builder::new().spawn(move || {
            if let Some(device) = device {
                let _ = device.recv_timeout(Duration::from_secs(5));
            }
            if *io.cancel.borrow() || !io.voice.recording(&io.id) {
                let _ = io.ready.send(Err(CANCELLED.into()));
                return;
            }
            played.store(true, Ordering::Release);
            after_commit();
            let _ = io.ready.send(Ok(()));
            while !*io.cancel.borrow() {
                match io.stop.recv_timeout(Duration::from_millis(5)) {
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => (),
                    _ => break,
                }
            }
        })
    })
}

fn never_spawn(called: Arc<AtomicBool>) -> Spawn {
    Box::new(move |_| {
        called.store(true, Ordering::Release);
        Err(std::io::Error::other("must not open the device"))
    })
}

async fn wait_for(what: &str, mut ready: impl FnMut() -> bool) {
    for _ in 0..2500 {
        if ready() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    panic!("timed out waiting for {what}");
}

async fn cancel_request(voice: &Voice, request: &str) {
    let (voice, request) = (voice.clone(), request.to_owned());
    tokio::task::spawn_blocking(move || voice.cancel(None, None, Some(&request)))
        .await
        .unwrap()
        .unwrap();
}

fn profile() -> Target {
    Target { remote: snapshot("http://127.0.0.1:1/never".into()), route: None }
}

fn session_phase(voice: &Voice) -> Option<(String, String, bool)> {
    voice.session.lock().unwrap().as_ref().map(|s| {
        (
            s.id.clone(),
            s.request_id.clone(),
            s.phase == Phase::Cancelled,
        )
    })
}

/// A fresh request starts and cancels cleanly; proves a cancelled request never blocks the next one.
async fn fresh_start_works(voice: &Voice, request: &str) {
    let played = Arc::new(AtomicBool::new(false));
    let id = voice
        .start_with(
            request.into(),
            profile(),
            async { Ok(()) },
            fake_worker(None, played.clone(), || ()),
        )
        .await
        .unwrap();
    assert!(played.load(Ordering::Acquire));
    let s = session_phase(voice).unwrap();
    assert_eq!((s.0.as_str(), s.1.as_str()), (id.as_str(), request));
    cancel_request(voice, request).await;
    assert!(voice.session.lock().unwrap().is_none());
}

async fn mock(
    response: String,
) -> (
    String,
    tokio::sync::oneshot::Receiver<Vec<u8>>,
    tokio::task::JoinHandle<()>,
) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/transcribe", listener.local_addr().unwrap());
    let (tx, rx) = tokio::sync::oneshot::channel();
    let handle = tokio::spawn(async move {
        let (mut socket, _) = tokio::time::timeout(Duration::from_secs(3), listener.accept())
            .await
            .unwrap()
            .unwrap();
        let mut request = Vec::new();
        loop {
            let mut buf = [0u8; 4096];
            let read = socket.read(&mut buf).await.unwrap();
            if read == 0 {
                break;
            }
            request.extend_from_slice(&buf[..read]);
            if let Some(end) = request.windows(4).position(|s| s == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&request[..end]).to_lowercase();
                let size: usize = headers
                    .lines()
                    .find_map(|l| l.strip_prefix("content-length: "))
                    .unwrap()
                    .parse()
                    .unwrap();
                if request.len() >= end + 4 + size {
                    break;
                }
            }
        }
        let _ = tx.send(request);
        if response.is_empty() {
            let mut probe = [0u8; 1];
            let _ = tokio::time::timeout(Duration::from_secs(3), socket.read(&mut probe)).await;
        } else {
            let _ = socket.write_all(response.as_bytes()).await;
        }
    });
    (endpoint, rx, handle)
}

fn response(status: &str, body: &str, headers: &str) -> String {
    format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n{headers}\r\n{body}", body.len())
}
fn wav() -> Arc<Vec<u8>> {
    let mut pcm = capture::Pcm::new(16_000, 1).unwrap();
    pcm.push(&[0.25f32; 160]);
    Arc::new(pcm.wav().unwrap())
}
fn snapshot(endpoint: String) -> Snapshot {
    Snapshot {
        endpoint,
        model: "whisper-local".into(),
        language: Some("en".into()),
        key: Some("mock-only-token".into()),
    }
}
