//! The speech engine runs in a killable child: PandaCode's own binary with the hidden
//! `__speech-worker` subcommand (dispatched by main.rs before Tauri starts). A hung or crashed
//! model never takes the app down; timeouts and cancels kill the child, and the next request
//! starts a fresh one.
//!
//! Wire format, both directions, after the child's 8-byte `PCSPEECH` hello on stdout:
//! `u32 LE length | u8 kind | compact JSON header | '\n' | f32 LE PCM (rest, may be empty)`.
//! Requests: 1 load `{path, backend: "auto"|"cpu"}`, 2 transcribe `{language?, task?, vadPath?,
//! filterSilence, chunkSamples?}` + 16 kHz mono PCM, 3 reset `{}`.
//! Replies: 0x81 ok `{backend, languages, supportsStreaming, supportsLongForm,
//! supportsTranslation}` (load), 0x82 text `{text}` (transcribe, reset → ""), 0x83 err `{message}`.
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{
    io::{self, Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    time::{Duration, Instant},
};

pub const KIND_LOAD: u8 = 1;
pub const KIND_TRANSCRIBE: u8 = 2;
pub const KIND_RESET: u8 = 3;
pub const KIND_OK: u8 = 0x81;
pub const KIND_TEXT: u8 = 0x82;
pub const KIND_ERR: u8 = 0x83;
pub const HELLO: &[u8; 8] = b"PCSPEECH";
/// 120 s of 16 kHz f32 is 7.7 MB; anything far beyond is a corrupt stream.
const MAX_FRAME: usize = 64 * 1024 * 1024;
/// Stray bytes the parent skips while waiting for the hello (e.g. a test harness banner).
const MAX_PREAMBLE: usize = 64 * 1024;
/// Base model-load limit; `LOAD_PER_GB` is added per GB of model file.
pub const LOAD_TIMEOUT: Duration = Duration::from_secs(120);
const LOAD_PER_GB: Duration = Duration::from_secs(30);
const POLL: Duration = Duration::from_millis(25);
pub const SUBCOMMAND: &str = "__speech-worker";
/// Read by ggml at backend init: the CPU-only retry after a GPU load failure.
const CPU_ONLY_ENV: (&str, &str) = ("TRANSCRIBE_BACKENDS", "cpu");

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Backend {
    Auto,
    Cpu,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadRequest {
    pub path: String,
    pub backend: Backend,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscribeRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    /// `"transcribe"` (default) or `"translate"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vad_path: Option<String>,
    #[serde(default)]
    pub filter_silence: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chunk_samples: Option<usize>,
    /// Parent only (never sent): the model's benchmark pace, which sets the timeout.
    #[serde(skip)]
    pub seconds_per30s: Option<f64>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Loaded {
    pub backend: String,
    pub languages: Vec<String>,
    pub supports_streaming: bool,
    pub supports_long_form: bool,
    pub supports_translation: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Text {
    pub text: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ErrorReply {
    pub message: String,
}

#[derive(Debug)]
pub struct Frame {
    pub kind: u8,
    pub header: Vec<u8>,
    pub pcm: Vec<f32>,
}

impl Frame {
    pub fn parse<T: DeserializeOwned>(&self) -> io::Result<T> {
        serde_json::from_slice(&self.header).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
    }
}

pub fn encode(kind: u8, header: &impl Serialize, pcm: &[f32]) -> io::Result<Vec<u8>> {
    let json = serde_json::to_vec(header).map_err(io::Error::other)?;
    let len = 1 + json.len() + 1 + pcm.len() * 4;
    if len > MAX_FRAME {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "frame too large"));
    }
    let mut out = Vec::with_capacity(4 + len);
    out.extend_from_slice(&(len as u32).to_le_bytes());
    out.push(kind);
    out.extend_from_slice(&json);
    out.push(b'\n');
    for s in pcm {
        out.extend_from_slice(&s.to_le_bytes());
    }
    Ok(out)
}

/// `Ok(None)` on a clean end of stream between frames.
pub fn read_frame(input: &mut impl Read) -> io::Result<Option<Frame>> {
    let mut len = [0u8; 4];
    match input.read_exact(&mut len) {
        Ok(()) => (),
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let len = u32::from_le_bytes(len) as usize;
    let bad = |what: &str| io::Error::new(io::ErrorKind::InvalidData, what.to_owned());
    if !(2..=MAX_FRAME).contains(&len) {
        return Err(bad("bad frame length"));
    }
    let mut body = vec![0u8; len];
    input.read_exact(&mut body)?;
    let newline = body[1..]
        .iter()
        .position(|&b| b == b'\n')
        .ok_or_else(|| bad("frame header unterminated"))?
        + 1;
    let raw = &body[newline + 1..];
    if !raw.len().is_multiple_of(4) {
        return Err(bad("frame audio misaligned"));
    }
    Ok(Some(Frame {
        kind: body[0],
        header: body[1..newline].to_vec(),
        pcm: raw
            .chunks_exact(4)
            .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
            .collect(),
    }))
}

/// What the child does with each request; the real one wraps transcribe-cpp (engine.rs).
pub trait Handler {
    fn load(&mut self, request: LoadRequest) -> Result<Loaded, String>;
    fn transcribe(&mut self, request: TranscribeRequest, pcm: Vec<f32>) -> Result<String, String>;
    fn reset(&mut self);
}

/// Child side: one request at a time until stdin closes.
pub fn serve(mut input: impl Read, mut output: impl Write, handler: &mut dyn Handler) -> io::Result<()> {
    output.write_all(HELLO)?;
    output.flush()?;
    while let Some(frame) = read_frame(&mut input)? {
        let reply = match frame.kind {
            KIND_LOAD => frame
                .parse::<LoadRequest>()
                .map_err(|e| e.to_string())
                .and_then(|r| handler.load(r))
                .map(|ok| encode(KIND_OK, &ok, &[])),
            KIND_TRANSCRIBE => frame
                .parse::<TranscribeRequest>()
                .map_err(|e| e.to_string())
                .and_then(|r| handler.transcribe(r, frame.pcm))
                .map(|text| encode(KIND_TEXT, &Text { text }, &[])),
            KIND_RESET => {
                handler.reset();
                Ok(encode(KIND_TEXT, &Text { text: String::new() }, &[]))
            }
            _ => Err("Unknown speech worker request.".to_owned()),
        };
        let bytes = match reply {
            Ok(bytes) => bytes?,
            Err(message) => encode(KIND_ERR, &ErrorReply { message }, &[])?,
        };
        output.write_all(&bytes)?;
        output.flush()?;
    }
    Ok(())
}

/// Protocol-only stand-in for tests (`__speech-worker --echo`): no model, deterministic replies.
/// Language `__hang` never answers; `__exit` dies mid-request; `__fail_auto` fails `auto` loads;
/// `__hang_auto` never answers an `auto` load. Test and debug builds only.
#[cfg(any(test, debug_assertions))]
pub struct Echo;
#[cfg(any(test, debug_assertions))]
impl Handler for Echo {
    fn load(&mut self, request: LoadRequest) -> Result<Loaded, String> {
        if request.path.ends_with("__fail_auto") && request.backend == Backend::Auto {
            return Err("GPU init failed".into());
        }
        if request.path.ends_with("__hang_auto") && request.backend == Backend::Auto {
            loop {
                std::thread::sleep(Duration::from_secs(3600));
            }
        }
        let cpu_env = std::env::var(CPU_ONLY_ENV.0).is_ok_and(|v| v == CPU_ONLY_ENV.1);
        Ok(Loaded {
            backend: format!("echo-{:?}{}", request.backend, if cpu_env { "-env" } else { "" }).to_lowercase(),
            languages: vec!["en".into()],
            ..Loaded::default()
        })
    }
    fn transcribe(&mut self, request: TranscribeRequest, pcm: Vec<f32>) -> Result<String, String> {
        match request.language.as_deref() {
            Some("__hang") => loop {
                std::thread::sleep(Duration::from_secs(3600));
            },
            Some("__exit") => std::process::exit(3),
            Some(l) if l.starts_with("__sleep_ms=") => {
                std::thread::sleep(Duration::from_millis(l["__sleep_ms=".len()..].parse().unwrap_or(0)));
                Ok(format!("{} samples", pcm.len()))
            }
            _ => Ok(format!("{} samples", pcm.len())),
        }
    }
    fn reset(&mut self) {}
}

/// Child entry: keeps the protocol on a private copy of stdout and points fd 1 at stderr, so
/// native libraries that print can never corrupt a frame.
pub fn run_child(handler: &mut dyn Handler) -> io::Result<()> {
    #[cfg(unix)]
    let output = {
        use std::os::fd::FromRawFd;
        // SAFETY: plain descriptor duplication on this process's own standard streams.
        let fd = unsafe { libc::dup(1) };
        if fd < 0 || unsafe { libc::dup2(2, 1) } < 0 {
            return Err(io::Error::last_os_error());
        }
        unsafe { std::fs::File::from_raw_fd(fd) }
    };
    #[cfg(not(unix))]
    let output = io::stdout();
    serve(io::stdin().lock(), io::BufWriter::new(output), handler)
}

#[derive(Clone, Debug)]
pub struct WorkerCommand {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

impl WorkerCommand {
    pub fn current() -> Result<Self, String> {
        Ok(Self {
            program: std::env::current_exe()
                .map_err(|_| "Could not locate PandaCode to start the speech engine.".to_owned())?,
            args: vec![SUBCOMMAND.into()],
            env: Vec::new(),
        })
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Failure {
    TimedOut,
    Cancelled,
    /// The child exited or broke the protocol.
    Died,
    /// The engine answered with an error.
    Engine(String),
}

impl Failure {
    pub fn message(&self) -> String {
        match self {
            Self::TimedOut => "The local speech model took too long and was stopped. Retry, or choose a smaller model.".into(),
            Self::Cancelled => super::super::CANCELLED.into(),
            Self::Died => "The local speech engine stopped unexpectedly. Retry the recording.".into(),
            Self::Engine(message) => format!("The local speech model failed: {message}"),
        }
    }
}

struct Child {
    process: std::process::Child,
    writer: mpsc::Sender<Vec<u8>>,
    frames: mpsc::Receiver<io::Result<Frame>>,
    loaded: Option<(PathBuf, Loaded)>,
    /// Runs on the CPU (the fallback child, or a load that found no GPU).
    cpu: bool,
    last_used: Instant,
}

impl Child {
    fn spawn(command: &WorkerCommand, cpu_only: bool) -> Result<Self, Failure> {
        let mut process = command_for(command, cpu_only).spawn().map_err(|_| Failure::Died)?;
        let (Some(stdin), Some(stdout)) = (process.stdin.take(), process.stdout.take()) else {
            let _ = process.kill();
            let _ = process.wait();
            return Err(Failure::Died);
        };
        let writer = spawn_writer(stdin)?;
        let frames = spawn_reader(stdout)?;
        Ok(Self {
            process,
            writer,
            frames,
            loaded: None,
            cpu: cpu_only,
            last_used: Instant::now(),
        })
    }

    fn kill(mut self) {
        let _ = self.process.kill();
        let _ = self.process.wait();
    }

    fn request(
        &mut self,
        bytes: Vec<u8>,
        timeout: Duration,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<Frame, Failure> {
        self.writer.send(bytes).map_err(|_| Failure::Died)?;
        let deadline = Instant::now() + timeout;
        loop {
            if cancelled() {
                return Err(Failure::Cancelled);
            }
            let now = Instant::now();
            if now >= deadline {
                return Err(Failure::TimedOut);
            }
            match self.frames.recv_timeout(POLL.min(deadline - now)) {
                Ok(Ok(frame)) => {
                    self.last_used = Instant::now();
                    return match frame.kind {
                        KIND_ERR => Err(Failure::Engine(
                            frame.parse::<ErrorReply>().map(|e| e.message).map_err(|_| Failure::Died)?,
                        )),
                        _ => Ok(frame),
                    };
                }
                Ok(Err(_)) | Err(mpsc::RecvTimeoutError::Disconnected) => return Err(Failure::Died),
                Err(mpsc::RecvTimeoutError::Timeout) => (),
            }
        }
    }
}

fn command_for(command: &WorkerCommand, cpu_only: bool) -> Command {
    let mut cmd = Command::new(&command.program);
    cmd.args(&command.args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    for (k, v) in &command.env {
        cmd.env(k, v);
    }
    if cpu_only {
        cmd.env(CPU_ONLY_ENV.0, CPU_ONLY_ENV.1);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    cmd
}

/// Feeds queued frames to the child's stdin until either side closes.
fn spawn_writer(mut stdin: std::process::ChildStdin) -> Result<mpsc::Sender<Vec<u8>>, Failure> {
    let (writer, outgoing) = mpsc::channel::<Vec<u8>>();
    std::thread::Builder::new()
        .name("speech-worker-in".into())
        .spawn(move || {
            for bytes in outgoing {
                if stdin.write_all(&bytes).and_then(|()| stdin.flush()).is_err() {
                    break;
                }
            }
        })
        .map_err(|_| Failure::Died)?;
    Ok(writer)
}

/// Waits for the hello, then forwards each reply frame (or the first read error).
fn spawn_reader(mut stdout: std::process::ChildStdout) -> Result<mpsc::Receiver<io::Result<Frame>>, Failure> {
    let (incoming, frames) = mpsc::channel();
    std::thread::Builder::new()
        .name("speech-worker-out".into())
        .spawn(move || {
            if let Err(e) = skip_to_hello(&mut stdout) {
                let _ = incoming.send(Err(e));
                return;
            }
            loop {
                match read_frame(&mut stdout) {
                    Ok(Some(frame)) => {
                        if incoming.send(Ok(frame)).is_err() {
                            break;
                        }
                    }
                    Ok(None) => break,
                    Err(e) => {
                        let _ = incoming.send(Err(e));
                        break;
                    }
                }
            }
        })
        .map_err(|_| Failure::Died)?;
    Ok(frames)
}

fn skip_to_hello(input: &mut impl Read) -> io::Result<()> {
    let mut window = [0u8; 8];
    let mut seen = 0usize;
    let mut byte = [0u8; 1];
    while seen < MAX_PREAMBLE + HELLO.len() {
        input.read_exact(&mut byte)?;
        window.rotate_left(1);
        window[7] = byte[0];
        seen += 1;
        if seen >= 8 && &window == HELLO {
            return Ok(());
        }
    }
    Err(io::Error::new(io::ErrorKind::InvalidData, "speech worker never said hello"))
}

/// Headroom over a model's benchmark pace (`secondsPer30s`, measured on a GPU).
const BENCHMARK_HEADROOM: f64 = 3.0;
/// Least allowance per second of audio for a benchmarked model.
const MIN_PER_AUDIO: f64 = 2.0;
/// Allowance per second of audio for a model too large to benchmark.
const UNBENCHMARKED_PER_AUDIO: f64 = 10.0;
/// How much slower the CPU fallback may be than the benchmark.
const CPU_SLOWDOWN: f64 = 4.0;

/// Transcription limit after any load: `floor` plus the audio scaled by the model's pace
/// (3x its benchmark, at least 2x the audio; 10x when unbenchmarked), 4x that on the CPU.
pub fn transcribe_timeout(floor: Duration, audio: Duration, seconds_per30s: Option<f64>, cpu: bool) -> Duration {
    let per_audio = seconds_per30s
        .filter(|s| s.is_finite() && *s >= 0.0)
        .map_or(UNBENCHMARKED_PER_AUDIO, |s| (s / 30.0 * BENCHMARK_HEADROOM).max(MIN_PER_AUDIO));
    floor + audio.mul_f64(if cpu { per_audio * CPU_SLOWDOWN } else { per_audio })
}

/// Parent side: at most one child, one request at a time (the mutex is held for the request).
pub struct Worker {
    command: WorkerCommand,
    child: Mutex<Option<Child>>,
    busy: AtomicBool,
    /// Ticket of the newest request; each request takes the next one before waiting for the lock.
    issued: AtomicU64,
    /// `unload` cancels every request whose ticket is at most this, never one issued after it.
    cancel_through: AtomicU64,
    /// Transcription allowance before audio length (15 s; see `transcribe_timeout`), and the
    /// base load limit (120 s).
    floor: Duration,
    load_timeout: Duration,
}

impl Worker {
    pub fn new(command: WorkerCommand) -> Arc<Self> {
        Self::with_timeouts(command, Duration::from_secs(15), LOAD_TIMEOUT)
    }

    pub fn with_timeouts(command: WorkerCommand, floor: Duration, load_timeout: Duration) -> Arc<Self> {
        Arc::new(Self {
            command,
            child: Mutex::new(None),
            busy: AtomicBool::new(false),
            issued: AtomicU64::new(0),
            cancel_through: AtomicU64::new(0),
            floor,
            load_timeout,
        })
    }

    /// The load limit plus 30 s per GB of model file (a missing file adds nothing).
    pub fn load_timeout_for(&self, model: &Path) -> Duration {
        let bytes = std::fs::metadata(model).map_or(0, |m| m.len());
        self.load_timeout + LOAD_PER_GB.mul_f64(bytes as f64 / 1e9)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Option<Child>> {
        self.child.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Path of the loaded model; a busy worker reports `busy = true` instead of waiting.
    #[cfg(test)]
    pub fn status(&self) -> (Option<PathBuf>, bool) {
        match self.child.try_lock() {
            Ok(guard) => (guard.as_ref().and_then(|c| c.loaded.as_ref().map(|l| l.0.clone())), false),
            Err(_) => (None, true),
        }
    }

    #[cfg(test)]
    pub fn is_busy(&self) -> bool {
        self.busy.load(Ordering::Acquire)
    }

    /// Spawns and loads `model` unless it is already loaded; falls back to a CPU-only child
    /// when the automatic (GPU) load fails or crashes.
    fn ensure_loaded(
        &self,
        slot: &mut Option<Child>,
        model: &Path,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<Loaded, Failure> {
        if let Some(loaded) = slot.as_ref().and_then(|c| c.loaded.as_ref()).filter(|l| l.0 == model) {
            return Ok(loaded.1.clone());
        }
        // A cancelled (queued) request never unloads the model in memory.
        if cancelled() {
            return Err(Failure::Cancelled);
        }
        if let Some(old) = slot.take() {
            old.kill();
        }
        let path = model.to_string_lossy().into_owned();
        let timeout = self.load_timeout_for(model);
        let mut last = Failure::Died;
        for (backend, cpu_only) in [(Backend::Auto, false), (Backend::Cpu, true)] {
            let mut child = Child::spawn(&self.command, cpu_only)?;
            let bytes = encode(KIND_LOAD, &LoadRequest { path: path.clone(), backend }, &[])
                .map_err(|_| Failure::Died)?;
            match child
                .request(bytes, timeout, cancelled)
                .and_then(|f| f.parse::<Loaded>().map_err(|_| Failure::Died))
            {
                Ok(loaded) => {
                    child.cpu |= loaded.backend.to_ascii_lowercase().contains("cpu");
                    child.loaded = Some((model.to_path_buf(), loaded.clone()));
                    *slot = Some(child);
                    return Ok(loaded);
                }
                Err(failure) => {
                    child.kill();
                    // A GPU load that failed, crashed or timed out still gets one CPU attempt.
                    if failure == Failure::Cancelled {
                        return Err(failure);
                    }
                    last = failure;
                }
            }
        }
        Err(last)
    }

    fn with_child<T>(
        &self,
        model: &Path,
        cancelled: &dyn Fn() -> bool,
        work: impl FnOnce(&mut Child, &dyn Fn() -> bool) -> Result<T, Failure>,
    ) -> Result<T, Failure> {
        let ticket = self.issued.fetch_add(1, Ordering::AcqRel) + 1;
        let stop = || cancelled() || self.cancel_through.load(Ordering::Acquire) >= ticket;
        let mut slot = self.lock_unless(&stop)?;
        if stop() {
            return Err(Failure::Cancelled);
        }
        self.busy.store(true, Ordering::Release);
        // A failed load leaves the slot as it was (or empty); only a failed request kills.
        let result = self.ensure_loaded(&mut slot, model, &stop).and_then(|_| {
            let result = work(slot.as_mut().ok_or(Failure::Died)?, &stop);
            if result.as_ref().is_err_and(|f| !matches!(f, Failure::Engine(_))) {
                if let Some(child) = slot.take() {
                    child.kill();
                }
            }
            result
        });
        self.busy.store(false, Ordering::Release);
        result
    }

    /// Waits for the engine lock, giving up when `stop` turns true.
    fn lock_unless(&self, stop: &dyn Fn() -> bool) -> Result<std::sync::MutexGuard<'_, Option<Child>>, Failure> {
        loop {
            match self.child.try_lock() {
                Ok(guard) => return Ok(guard),
                Err(std::sync::TryLockError::Poisoned(e)) => return Ok(e.into_inner()),
                Err(std::sync::TryLockError::WouldBlock) if stop() => return Err(Failure::Cancelled),
                Err(std::sync::TryLockError::WouldBlock) => std::thread::sleep(POLL),
            }
        }
    }

    /// Loads (see `load_timeout_for`) and reports the engine's capabilities.
    #[cfg(test)]
    pub fn load(&self, model: &Path, cancelled: &dyn Fn() -> bool) -> Result<Loaded, Failure> {
        self.with_child(model, cancelled, |child, _| {
            child.loaded.as_ref().map(|l| l.1.clone()).ok_or(Failure::Died)
        })
    }

    /// Timeout: see `transcribe_timeout` (the request's benchmark pace and the child's backend).
    pub fn transcribe(
        &self,
        model: &Path,
        request: &TranscribeRequest,
        pcm: &[f32],
        cancelled: &dyn Fn() -> bool,
    ) -> Result<String, Failure> {
        let bytes = encode(KIND_TRANSCRIBE, request, pcm).map_err(|_| Failure::Died)?;
        let audio = super::audio::duration(pcm.len());
        self.with_child(model, cancelled, |child, stop| {
            let timeout = transcribe_timeout(self.floor, audio, request.seconds_per30s, child.cpu);
            child
                .request(bytes, timeout, stop)?
                .parse::<Text>()
                .map(|t| t.text)
                .map_err(|_| Failure::Died)
        })
    }

    /// Kills the child; requests issued before this call are cancelled first (later ones run).
    pub fn unload(&self) {
        self.cancel_through.fetch_max(self.issued.load(Ordering::Acquire), Ordering::AcqRel);
        if let Some(child) = self.lock().take() {
            child.kill();
        }
    }

    /// Delete: runs `then` holding the idle engine (`None`, without running it, while a request
    /// holds the engine), then unloads `model` if it is loaded. The check and the unload share
    /// the engine lock, so nothing is cancelled: a request for another model that queues
    /// meanwhile runs after it.
    pub fn unload_for_delete<T>(&self, model: &Path, then: impl FnOnce() -> T) -> Option<T> {
        let mut slot = match self.child.try_lock() {
            Ok(guard) => guard,
            Err(std::sync::TryLockError::Poisoned(e)) => e.into_inner(),
            Err(std::sync::TryLockError::WouldBlock) => return None,
        };
        let result = then();
        if slot.as_ref().and_then(|c| c.loaded.as_ref()).is_some_and(|l| l.0 == model) {
            if let Some(child) = slot.take() {
                child.kill();
            }
        }
        Some(result)
    }

    /// "Unload immediately" after a dictation: kills an idle child, leaves a busy one alone.
    pub fn unload_idle(&self) {
        self.unload_if_idle(Duration::ZERO);
    }

    /// Unloads when idle for `after`; never waits on an in-flight request.
    pub fn unload_if_idle(&self, after: Duration) {
        if let Ok(mut slot) = self.child.try_lock() {
            if slot.as_ref().is_some_and(|c| c.last_used.elapsed() >= after) {
                if let Some(child) = slot.take() {
                    child.kill();
                }
            }
        }
    }

    #[cfg(test)]
    pub fn child_pid(&self) -> Option<u32> {
        self.lock().as_ref().map(|c| c.process.id())
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        if let Some(child) = self.child.get_mut().ok().and_then(Option::take) {
            child.kill();
        }
    }
}
