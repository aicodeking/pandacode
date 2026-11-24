//! Aísla el runtime ONNX de Windows x64 del proceso de la aplicación.

use std::{
    ffi::{OsStr, OsString},
    io::{self, Read, Write},
    os::windows::{ffi::{OsStrExt, OsStringExt}, process::CommandExt},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Mutex, OnceLock, TryLockError, mpsc},
    time::Duration,
};

use serde::{Deserialize, Serialize, de::DeserializeOwned};
use windows::Win32::System::{
    Diagnostics::Debug::{SEM_FAILCRITICALERRORS, SEM_NOGPFAULTERRORBOX, SetErrorMode},
    LibraryLoader::{
        LOAD_LIBRARY_SEARCH_APPLICATION_DIR, LOAD_LIBRARY_SEARCH_SYSTEM32, SetDefaultDllDirectories,
    },
    Threading::CREATE_NO_WINDOW,
};

use crate::providers::windows_job::Job;

use super::{onnx::OnnxProfiler, profile::TaskProfile};

const SUBCOMMAND: &str = "__panda-router-worker";
const VERSION: u32 = 1;
const MAX_FRAME: usize = 512 * 1024;
const MAX_BATCH: usize = 16;
const MAX_TEXT: usize = 64 * 1024;
const MAX_PATH: usize = 32_767;
const LOAD_TIMEOUT: Duration = Duration::from_secs(45);
const PROFILE_TIMEOUT: Duration = Duration::from_secs(5);

const NO_EXE: &str = "Could not locate PandaCode for the Windows ONNX worker.";
const NO_DLL: &str = "The bundled Windows ONNX Runtime DLL is missing.";
const NO_CPU: &str = "Windows ONNX requires AVX, AVX2, FMA, F16C, BMI1, BMI2 and SSE4.2.";
const INVALID_REQUEST: &str = "The Windows ONNX worker request exceeded its limits.";
const DIED: &str = "The Windows ONNX worker stopped or could not be started.";
const TIMED_OUT: &str = "The Windows ONNX worker timed out and was stopped.";
const BAD_REPLY: &str = "The Windows ONNX worker returned an invalid response.";
const RUN_FAILED: &str = "The Windows ONNX worker could not profile the task.";
const LOAD_FAILED: &str = "The Windows ONNX worker could not initialize the runtime or model.";

static FAILURE: OnceLock<&'static str> = OnceLock::new();

fn latch(reason: &'static str) -> String {
    FAILURE.get_or_init(|| reason).to_string()
}

fn worker_executable() -> Result<PathBuf, &'static str> {
    #[cfg(test)]
    if let Some(exe) = std::env::var_os("PANDA_ROUTER_TEST_EXE") {
        let exe = PathBuf::from(exe);
        return exe.is_absolute().then_some(exe).ok_or(NO_EXE);
    }
    std::env::current_exe().map_err(|_| NO_EXE)
}

fn bundled_runtime(exe: &Path) -> Result<PathBuf, &'static str> {
    let dll = exe.parent().ok_or(NO_EXE)?.join("panda-router-runtime").join("onnxruntime.dll");
    if dll.is_absolute() && dll.is_file() { Ok(dll) } else { Err(NO_DLL) }
}

fn check_cpu() -> Result<(), &'static str> {
    use std::is_x86_feature_detected as has;
    if has!("avx") && has!("avx2") && has!("fma") && has!("f16c") && has!("bmi1") && has!("bmi2")
        && has!("sse4.2")
    {
        Ok(())
    } else {
        Err(NO_CPU)
    }
}

pub(super) fn unsupported_reason() -> Option<String> {
    check_cpu().and_then(|()| bundled_runtime(&worker_executable()?)).err().map(str::to_owned)
}

pub(super) struct WorkerRuntime(PathBuf);

impl WorkerRuntime {
    pub(super) fn dll(&self) -> &Path {
        &self.0
    }

    fn for_child() -> Result<Self, LoadFailure> {
        check_cpu().map_err(|_| LoadFailure::Runtime)?;
        let exe = std::env::current_exe().map_err(|_| LoadFailure::Runtime)?;
        let dll = bundled_runtime(&exe).map_err(|_| LoadFailure::Runtime)?;
        // SAFETY: solo el hijo cambia esta política; libloading llama a LoadLibraryExW con flags 0.
        unsafe {
            SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_APPLICATION_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32)
        }
        .map_err(|_| LoadFailure::Runtime)?;
        Ok(Self(dll))
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum Request {
    Load { version: u32, dir: Vec<u16> },
    Profile { texts: Vec<String> },
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum LoadFailure {
    ReadAssets,
    HashAssets,
    Runtime,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum Reply {
    Ready { version: u32 },
    LoadFailed { reason: LoadFailure },
    Profiles { profiles: Vec<TaskProfile> },
    ProfileFailed,
}

fn invalid_frame() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "Trama ONNX inválida")
}

fn bounded_payload(value: &impl Serialize) -> io::Result<Vec<u8>> {
    let payload = serde_json::to_vec(value).map_err(|_| invalid_frame())?;
    if payload.is_empty() || payload.len() > MAX_FRAME { Err(invalid_frame()) } else { Ok(payload) }
}

fn write_frame(output: &mut impl Write, payload: &[u8]) -> io::Result<()> {
    output.write_all(&(payload.len() as u32).to_le_bytes())?;
    output.write_all(payload)?;
    output.flush()
}

fn read_frame<T: DeserializeOwned>(input: &mut impl Read) -> io::Result<Option<T>> {
    let mut header = [0; 4];
    loop {
        match input.read(&mut header[..1]) {
            Ok(0) => return Ok(None),
            Ok(_) => break,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    input.read_exact(&mut header[1..])?;
    let size = u32::from_le_bytes(header) as usize;
    if !(1..=MAX_FRAME).contains(&size) {
        return Err(invalid_frame());
    }
    let mut payload = vec![0; size];
    input.read_exact(&mut payload)?;
    serde_json::from_slice(&payload).map(Some).map_err(|_| invalid_frame())
}

fn valid_batch(texts: &[String]) -> bool {
    (1..=MAX_BATCH).contains(&texts.len()) && texts.iter().all(|text| text.len() <= MAX_TEXT)
}

fn valid_profiles(profiles: &[TaskProfile], count: usize) -> bool {
    let probability = |p: &f64| (0.0..=1.0).contains(p);
    let distribution = |values: &[f64]| {
        values.iter().all(probability) && (values.iter().sum::<f64>() - 1.0).abs() <= 1e-6
    };
    profiles.len() == count && profiles.iter().all(|p| {
        p.out_p50.is_finite()
            && distribution(&p.category)
            && distribution(&p.difficulty)
            && p.skills.iter().all(|axis| distribution(axis))
            && p.flags.iter().chain(&p.checklist).all(probability)
    })
}

struct Process {
    child: Child,
    _job: Option<Job>,
}

impl Process {
    fn new(child: Child) -> Self {
        let job = Job::attach(child.id());
        Self { child, _job: job }
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

struct Session {
    _process: Process,
    requests: mpsc::SyncSender<Vec<u8>>,
    replies: mpsc::Receiver<io::Result<Option<Reply>>>,
}

impl Session {
    fn spawn(command: &mut Command) -> Result<Self, &'static str> {
        let child = command
            .creation_flags(CREATE_NO_WINDOW.0)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| DIED)?;
        let mut process = Process::new(child);
        let mut input = process.child.stdin.take().ok_or(DIED)?;
        let mut output = process.child.stdout.take().ok_or(DIED)?;
        let (requests, outgoing) = mpsc::sync_channel::<Vec<u8>>(1);
        let (incoming, replies) = mpsc::sync_channel(1);
        // Tanto la lectura como la escritura pueden bloquearse en una tubería de Windows.
        std::thread::Builder::new().name("panda-router-io".into()).spawn(move || {
            for payload in outgoing {
                let result = write_frame(&mut input, &payload).and_then(|()| read_frame(&mut output));
                let can_continue = matches!(result, Ok(Some(_)));
                if incoming.send(result).is_err() || !can_continue {
                    break;
                }
            }
        }).map_err(|_| DIED)?;
        Ok(Self { _process: process, requests, replies })
    }

    fn request(&self, payload: Vec<u8>, timeout: Duration) -> Result<Reply, &'static str> {
        self.requests.try_send(payload).map_err(|_| DIED)?;
        match self.replies.recv_timeout(timeout) {
            Ok(Ok(Some(reply))) => Ok(reply),
            Ok(Err(e)) if e.kind() == io::ErrorKind::InvalidData => Err(BAD_REPLY),
            Err(mpsc::RecvTimeoutError::Timeout) => Err(TIMED_OUT),
            _ => Err(DIED),
        }
    }
}

pub(super) struct WindowsOnnx(Mutex<Option<Session>>);

impl WindowsOnnx {
    pub(super) fn failure_reason() -> Option<&'static str> {
        FAILURE.get().copied()
    }

    pub(super) fn load(dir: &Path) -> Result<Self, String> {
        if let Some(reason) = Self::failure_reason() {
            return Err(reason.to_owned());
        }
        check_cpu()?;
        let exe = worker_executable()?;
        bundled_runtime(&exe)?;
        let dir = std::path::absolute(dir).map_err(|_| "cannot read ONNX profiler assets")?;
        let dir: Vec<_> = dir.as_os_str().encode_wide().collect();
        if dir.is_empty() || dir.len() > MAX_PATH || dir.contains(&0) {
            return Err("cannot read ONNX profiler assets: invalid directory".into());
        }
        let load = bounded_payload(&Request::Load { version: VERSION, dir }).map_err(|_| INVALID_REQUEST)?;
        let session = Session::spawn(Command::new(exe).arg(SUBCOMMAND).env_remove("ORT_DYLIB_PATH"))
            .map_err(latch)?;
        match session.request(load, LOAD_TIMEOUT).map_err(latch)? {
            Reply::Ready { version: VERSION } => Ok(Self(Mutex::new(Some(session)))),
            Reply::LoadFailed { reason: LoadFailure::ReadAssets } => Err("cannot read ONNX profiler assets".into()),
            Reply::LoadFailed { reason: LoadFailure::HashAssets } => Err("ONNX profiler assets did not match sha256".into()),
            Reply::LoadFailed { reason: LoadFailure::Runtime } => Err(latch(LOAD_FAILED)),
            _ => Err(latch(BAD_REPLY)),
        }
    }

    pub(super) fn profile_batch(&self, texts: &[String]) -> Result<Vec<TaskProfile>, String> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        if let Some(reason) = Self::failure_reason() {
            return Err(reason.to_owned());
        }
        if !valid_batch(texts) {
            return Err(INVALID_REQUEST.into());
        }
        let payload = bounded_payload(&Request::Profile { texts: texts.to_vec() }).map_err(|_| INVALID_REQUEST)?;
        let mut slot = match self.0.try_lock() {
            Ok(slot) => slot,
            Err(TryLockError::WouldBlock) => return Err("The Windows ONNX worker is busy.".into()),
            Err(TryLockError::Poisoned(error)) => {
                let reason = latch(DIED);
                drop(error.into_inner().take());
                return Err(reason);
            }
        };
        let session = slot.as_ref().ok_or(DIED)?;
        let reason = match session.request(payload, PROFILE_TIMEOUT) {
            Ok(Reply::Profiles { profiles }) if valid_profiles(&profiles, texts.len()) => return Ok(profiles),
            Ok(Reply::ProfileFailed) => RUN_FAILED,
            Ok(_) => BAD_REPLY,
            Err(reason) => reason,
        };
        let error = latch(reason);
        drop(slot.take());
        Err(error)
    }
}

fn load_child(dir: Vec<u16>) -> Result<OnnxProfiler, LoadFailure> {
    if dir.is_empty() || dir.len() > MAX_PATH || dir.contains(&0) {
        return Err(LoadFailure::ReadAssets);
    }
    let dir = PathBuf::from(OsString::from_wide(&dir));
    if !dir.is_absolute() {
        return Err(LoadFailure::ReadAssets);
    }
    let runtime = WorkerRuntime::for_child()?;
    let profiler = OnnxProfiler::load_in_child(&dir, &runtime)?;
    let smoke = ["[ctx] none\n[task] Rename a variable.".to_owned()];
    let profiles = profiler.profile_batch(&smoke).map_err(|_| LoadFailure::Runtime)?;
    if !valid_profiles(&profiles, 1) {
        return Err(LoadFailure::Runtime);
    }
    Ok(profiler)
}

fn send_reply(output: &mut impl Write, reply: Reply) -> io::Result<()> {
    write_frame(output, &bounded_payload(&reply)?)
}

fn run_child(input: &mut impl Read, output: &mut impl Write) -> io::Result<()> {
    let profiler = match read_frame(input)? {
        None => return Ok(()),
        Some(Request::Load { version: VERSION, dir }) => match load_child(dir) {
            Ok(profiler) => profiler,
            Err(reason) => return send_reply(output, Reply::LoadFailed { reason }),
        },
        _ => return Err(invalid_frame()),
    };
    send_reply(output, Reply::Ready { version: VERSION })?;
    while let Some(request) = read_frame(input)? {
        let Request::Profile { texts } = request else { return Err(invalid_frame()) };
        if !valid_batch(&texts) {
            return Err(invalid_frame());
        }
        match profiler.profile_batch(&texts) {
            Ok(profiles) if valid_profiles(&profiles, texts.len()) => {
                send_reply(output, Reply::Profiles { profiles })?;
            }
            _ => return send_reply(output, Reply::ProfileFailed),
        }
    }
    Ok(())
}

/// Atiende el subcomando interno antes de arrancar la interfaz.
pub fn handle_router_worker() -> bool {
    if std::env::args_os().nth(1).as_deref() != Some(OsStr::new(SUBCOMMAND)) {
        return false;
    }
    // SAFETY: no se muestra UI de errores críticos en este proceso descartable.
    unsafe { SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX) };
    if run_child(&mut io::stdin().lock(), &mut io::stdout().lock()).is_err() {
        std::process::exit(1);
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::windows::io::{AsHandle, AsRawHandle};
    use windows::Win32::{
        Foundation::{HANDLE, WAIT_OBJECT_0},
        System::Threading::WaitForSingleObject,
    };

    #[test]
    fn frames_round_trip_and_reject_invalid_lengths_or_json() {
        let request = Request::Profile { texts: vec!["uno\0\n🧪".into(), "dos".into()] };
        let mut frame = Vec::new();
        write_frame(&mut frame, &bounded_payload(&request).unwrap()).unwrap();
        let mut input = frame.as_slice();
        let Some(Request::Profile { texts }) = read_frame(&mut input).unwrap() else { panic!() };
        assert_eq!(texts, ["uno\0\n🧪", "dos"]);
        assert!(read_frame::<Request>(&mut input).unwrap().is_none());
        assert!(read_frame::<Request>(&mut &frame[..frame.len() - 1]).is_err());
        assert!(read_frame::<Request>(&mut &b"\x01\0\0\0x"[..]).is_err());
        let oversized = ((MAX_FRAME + 1) as u32).to_le_bytes();
        assert_eq!(read_frame::<Request>(&mut oversized.as_slice()).unwrap_err().kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn child_rejects_wrong_protocol_version_before_loading() {
        let mut bytes = Vec::new();
        let load = Request::Load { version: VERSION + 1, dir: Vec::new() };
        write_frame(&mut bytes, &bounded_payload(&load).unwrap()).unwrap();
        let mut output = Vec::new();
        assert!(run_child(&mut bytes.as_slice(), &mut output).is_err());
        assert!(output.is_empty());
    }

    fn powershell(script: &str) -> Session {
        let exe = PathBuf::from(std::env::var_os("SystemRoot").unwrap())
            .join(r"System32\WindowsPowerShell\v1.0\powershell.exe");
        Session::spawn(Command::new(exe).args(["-NoProfile", "-NonInteractive", "-Command", script])).unwrap()
    }

    #[test]
    fn a_hung_child_times_out_even_if_its_stdin_is_full_and_drop_reaps_it() {
        let session = powershell("[Threading.Thread]::Sleep(-1)");
        let handle = session._process.child.as_handle().try_clone_to_owned().unwrap();
        assert_eq!(session.request(vec![b'x'; MAX_FRAME], Duration::from_millis(100)).unwrap_err(), TIMED_OUT);
        drop(session);
        assert_eq!(unsafe { WaitForSingleObject(HANDLE(handle.as_raw_handle()), 0) }, WAIT_OBJECT_0);
    }

    #[test]
    fn child_exit_is_reported_as_worker_death() {
        let session = powershell("[Environment]::Exit(7)");
        assert_eq!(session.request(vec![b'x'], Duration::from_secs(10)).unwrap_err(), DIED);
    }

    #[test]
    fn invalid_profile_probabilities_are_rejected() {
        let mut p = TaskProfile {
            category: [1.0 / 13.0; 13],
            difficulty: [0.1; 10],
            skills: [[1.0 / 11.0; 11]; 10],
            flags: [0.5; 7],
            checklist: [0.5; 24],
            out_p50: 6.0,
        };
        assert!(valid_profiles(std::slice::from_ref(&p), 1));
        assert!(!valid_profiles(std::slice::from_ref(&p), 2));
        p.flags[0] = f64::NAN;
        assert!(!valid_profiles(&[p], 1));
    }
}
