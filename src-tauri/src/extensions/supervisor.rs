//! Trusted Node process supervision. API integrity/resilience, not OS confinement.
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{path::{Path, PathBuf}, process::Stdio, sync::{Arc, atomic::{AtomicBool, Ordering}}, time::Duration};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub const MAX_FRAME: usize = 64 * 1024;
pub const DEADLINE: Duration = Duration::from_secs(5);
pub const BOOTSTRAP: &str = include_str!("node-host.cjs");
pub type Result<T> = std::result::Result<T, &'static str>;

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RuntimeManifest { schema_version: u8, target: String, node_version: String, node_sha256: String, license_sha256: String }
#[derive(Clone)]
pub struct Runtime { pub binary: PathBuf, pub directory: PathBuf }
fn digest(path: &Path, max: u64) -> Result<String> {
    use std::io::Read;
    let metadata = path.symlink_metadata().map_err(|_| "UnsupportedRuntime")?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > max { return Err("UnsupportedRuntime"); }
    let mut file = std::fs::File::open(path).map_err(|_| "UnsupportedRuntime")?;
    let mut hash = Sha256::new(); let mut bytes = [0; 65536]; let mut total = 0;
    loop { let count = file.read(&mut bytes).map_err(|_| "UnsupportedRuntime")?; if count == 0 { break; } total += count as u64; if total > max { return Err("UnsupportedRuntime"); } hash.update(&bytes[..count]); }
    Ok(format!("{:x}", hash.finalize()))
}
impl Runtime {
    /// Fixed app-owned resource directory, never PATH or a package-supplied executable.
    pub fn packaged(directory: &Path) -> Result<Self> {
        if !cfg!(all(target_os = "windows", target_arch = "x86_64")) { return Err("UnsupportedRuntime"); }
        let metadata = directory.symlink_metadata().map_err(|_| "UnsupportedRuntime")?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() { return Err("UnsupportedRuntime"); }
        let manifest_path = directory.join("manifest.json");
        if manifest_path.metadata().map_err(|_| "UnsupportedRuntime")?.len() > 4096 { return Err("UnsupportedRuntime"); }
        let manifest: RuntimeManifest = serde_json::from_slice(&std::fs::read(manifest_path).map_err(|_| "UnsupportedRuntime")?).map_err(|_| "UnsupportedRuntime")?;
        let binary = directory.join("node.exe");
        if manifest.schema_version != 1 || manifest.target != "windows-x64" || manifest.node_version != "v26.1.0" || manifest.node_sha256 != "35ebb74da6acb56fdf570de64f1ae510d6d18ca09da494a3e1ac87edd32d263b" || manifest.license_sha256 != "d94dd7496d4de9cd130f1eb6e661e43422483663fd48cf3a450d244b9cda6fdc" || digest(&binary, 150 * 1024 * 1024)? != manifest.node_sha256 || digest(&directory.join("LICENSE"), 1024 * 1024)? != manifest.license_sha256 { return Err("UnsupportedRuntime"); }
        Ok(Self { binary, directory: directory.to_owned() })
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Message { schema_version: u8, token: String, id: u32, method: String, params: Value }
pub async fn read_frame(reader: &mut (impl AsyncRead + Unpin)) -> Result<Value> {
    let length = reader.read_u32_le().await.map_err(|_| "HostUnavailable")? as usize;
    if length == 0 || length > MAX_FRAME { return Err("LimitExceeded"); }
    let mut bytes = vec![0; length]; reader.read_exact(&mut bytes).await.map_err(|_| "HostUnavailable")?;
    serde_json::from_slice(&bytes).map_err(|_| "InvalidShape")
}
async fn write_frame(writer: &mut (impl AsyncWrite + Unpin), value: &Value, max: usize) -> Result<()> {
    let bytes = serde_json::to_vec(value).map_err(|_| "InvalidShape")?;
    if bytes.len() > max { return Err("LimitExceeded"); }
    writer.write_u32_le(bytes.len() as u32).await.map_err(|_| "HostUnavailable")?;
    writer.write_all(&bytes).await.map_err(|_| "HostUnavailable")?;
    writer.flush().await.map_err(|_| "HostUnavailable")
}

/// No package code is supplied before Windows assigns the app bootstrap to its owned job.
pub async fn run(runtime: &Runtime, source: &str, context: Value, cancel: Arc<AtomicBool>, mut dispatch: impl FnMut(&str, Value) -> Value) -> Result<Vec<Value>> {
    run_owned(runtime, source, context, cancel, &runtime.directory, DEADLINE, &mut dispatch).await
}

pub async fn run_owned(runtime: &Runtime, source: &str, context: Value, cancel: Arc<AtomicBool>, cwd: &Path, deadline: Duration, mut dispatch: impl FnMut(&str, Value) -> Value) -> Result<Vec<Value>> {
    if cancel.load(Ordering::Acquire) { return Err("Cancelled"); }
    let mut command = tokio::process::Command::new(&runtime.binary);
    command.args(["--max-old-space-size=64", "--input-type=commonjs", "--eval", BOOTSTRAP]).current_dir(cwd)
        .env_clear().stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    // Keep only OS bootstrap variables, never app credentials, NODE_OPTIONS or arbitrary parent env.
    for name in ["SystemRoot", "WINDIR", "TEMP", "TMP"] { if let Some(value) = std::env::var_os(name) { command.env(name, value); } }
    #[cfg(windows)]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW; no elevation or shell.
    let mut child = command.spawn().map_err(|_| "HostUnavailable")?;
    #[cfg(windows)]
    let job = match job::Job::attach(&child) { Ok(job) => job, Err(error) => { let _ = child.kill().await; let _ = child.wait().await; return Err(error); } };
    let mut stdin = child.stdin.take().ok_or("HostUnavailable")?;
    let mut stdout = child.stdout.take().ok_or("HostUnavailable")?;
    let mut stderr = child.stderr.take().ok_or("HostUnavailable")?;
    let token = uuid::Uuid::new_v4().to_string();
    #[cfg(all(test, feature = "extension-runtime-native-tests"))]
    let mut last_message = "bootstrap";
    let exchange = async {
        write_frame(&mut stdin, &json!({"token":token,"source":source,"context":context}), 300000).await?;
        let mut dialogs = Vec::new();
        for expected in 1..=128 {
            let raw = read_frame(&mut stdout).await?;
            let message: Message = serde_json::from_value(raw).map_err(|_| "InvalidShape")?;
            #[cfg(all(test, feature = "extension-runtime-native-tests"))]
            { last_message = match message.method.as_str() { "context" => "context", "dialog" => "dialog", "storage" => "storage", "complete" => "complete", "failed" => "failed", _ => "unsupported" }; }
            if message.schema_version != 1 { return Err("IncompatibleApi"); }
            if message.token != token || message.id != expected { return Err("PermissionDenied"); }
            let reply = match message.method.as_str() {
                "failed" if message.params.is_null() => return Err("HostUnavailable"),
                "complete" if message.params.is_null() => return Ok(dialogs),
                "context" | "dialog" | "storage" | "jobs" | "jobProgress" | "jobResult" => dispatch(&message.method, message.params.clone()),
                _ => return Err("UnsupportedCapability"),
            };
            if message.method == "dialog" && reply["ok"] == true {
                if !dialogs.is_empty() { return Err("LimitExceeded"); }
                dialogs.push(message.params);
            }
            write_frame(&mut stdin, &json!({"id":message.id,"reply":reply}), MAX_FRAME).await?;
        }
        Err("LimitExceeded")
    };
    let cancelled = async { loop { if cancel.load(Ordering::Acquire) { break; } tokio::time::sleep(Duration::from_millis(10)).await; } };
    let noise = async { let mut total = 0; let mut chunk = [0; 4096]; loop { let count = stderr.read(&mut chunk).await.unwrap_or(0); if count == 0 { std::future::pending::<()>().await; } total += count; if total > MAX_FRAME { break; } } };
    let result = tokio::select! {
        value = exchange => value,
        () = cancelled => Err("Cancelled"),
        () = noise => Err("LimitExceeded"),
        () = tokio::time::sleep(deadline) => Err("Timeout"),
    };
    // Always terminate/reap even after success; package timers/owned helpers cannot outlive this call.
    #[cfg(windows)]
    let disposed = job.terminate();
    #[cfg(not(windows))]
    let disposed: Result<()> = Ok(());
    let _ = child.start_kill();
    let reaped = tokio::time::timeout(Duration::from_secs(1), child.wait()).await;
    #[cfg(all(test, feature = "extension-runtime-native-tests"))]
    eprintln!("TRUSTED_SUPERVISOR error={:?} last={last_message} terminated={disposed:?} reaped={reaped:?}", result.as_ref().err());
    if disposed.is_err() || !matches!(reaped, Ok(Ok(_))) { return Err("HostUnavailable"); }
    if cancel.load(Ordering::Acquire) { return Err("Cancelled"); }
    result
}

#[cfg(windows)]
mod job {
    use super::*;
    use windows::Win32::{Foundation::HANDLE, System::JobObjects::*};
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    pub struct Job(OwnedHandle);
    impl Job {
        pub fn attach(child: &tokio::process::Child) -> Result<Self> {
            unsafe {
                let job = Self(OwnedHandle::from_raw_handle(CreateJobObjectW(None, None).map_err(|_| "HostUnavailable")?.0));
                let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
                limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_JOB_MEMORY;
                limits.JobMemoryLimit = 384 * 1024 * 1024;
                SetInformationJobObject(HANDLE(job.0.as_raw_handle()), JobObjectExtendedLimitInformation, std::ptr::from_ref(&limits).cast(), std::mem::size_of_val(&limits) as u32).map_err(|_| "HostUnavailable")?;
                let handle = HANDLE(child.raw_handle().ok_or("HostUnavailable")?);
                AssignProcessToJobObject(HANDLE(job.0.as_raw_handle()), handle).map_err(|_| "HostUnavailable")?;
                Ok(job)
            }
        }
        pub fn terminate(&self) -> Result<()> { unsafe { TerminateJobObject(HANDLE(self.0.as_raw_handle()), 1).map_err(|_| "HostUnavailable") } }
    }
    impl Drop for Job { fn drop(&mut self) { let _ = self.terminate(); } }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn oversized_header_rejects_before_body_allocation_and_truncated_data_rejects() {
        let bytes = ((MAX_FRAME + 1) as u32).to_le_bytes();
        assert_eq!(read_frame(&mut bytes.as_slice()).await.unwrap_err(), "LimitExceeded");
        assert_eq!(read_frame(&mut [5u8, 0, 0, 0, b'{'].as_slice()).await.unwrap_err(), "HostUnavailable");
    }
    #[cfg(all(feature = "extension-runtime-native-tests", target_os = "windows", target_arch = "x86_64"))]
    #[tokio::test]
    async fn real_native_channel_rejects_forgery_version_unknown_fields_and_oversized_frames() {
        let runtime = Runtime::packaged(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../_work/00-tmp/extensibility-trusted-runtime")).unwrap();
        for (source, expected) in [
            ("exports.activate=()=>{const body=Buffer.from(JSON.stringify({schemaVersion:1,token:'forged',id:1,method:'complete',params:null}));const h=Buffer.alloc(4);h.writeUInt32LE(body.length);process.stdout.write(Buffer.concat([h,body]));return new Promise(()=>{});}", "PermissionDenied"),
            ("exports.activate=()=>{const body=Buffer.from(JSON.stringify({schemaVersion:2,token:'forged',id:1,method:'complete',params:null}));const h=Buffer.alloc(4);h.writeUInt32LE(body.length);process.stdout.write(Buffer.concat([h,body]));return new Promise(()=>{});}", "IncompatibleApi"),
            ("exports.activate=()=>{const body=Buffer.from(JSON.stringify({schemaVersion:1,token:'forged',id:1,method:'complete',params:null,extensionId:'panda.core'}));const h=Buffer.alloc(4);h.writeUInt32LE(body.length);process.stdout.write(Buffer.concat([h,body]));return new Promise(()=>{});}", "InvalidShape"),
            ("exports.activate=()=>{const h=Buffer.alloc(4);h.writeUInt32LE(65537);process.stdout.write(h);return new Promise(()=>{});}", "LimitExceeded"),
        ] {
            let result = run(&runtime, source, Value::Null, Arc::new(AtomicBool::new(false)), |_, _| panic!("forged request reached adapter")).await;
            assert_eq!(result.unwrap_err(), expected);
        }
    }
    #[cfg(all(feature = "extension-runtime-native-tests", target_os = "windows", target_arch = "x86_64"))]
    #[tokio::test]
    async fn packaging_resources_use_the_production_loader_without_checkout_fallback() {
        let directory = Path::new(env!("CARGO_MANIFEST_DIR")).join("target/extension-runtime");
        let runtime = Runtime::packaged(&directory).expect("Stage the default packaging resources with --trusted-bundle before the native feature gate");
        assert_eq!(runtime.binary, directory.join("node.exe"));
        assert!(run(&runtime, "exports.activate=()=>{};", Value::Null, Arc::new(AtomicBool::new(false)), |_, _| panic!("No package API call expected")).await.unwrap().is_empty());
    }
}
