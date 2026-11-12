//! Experimental native launch foundation, not accepted for production use.
//! Native startup qualification is blocked; this API never grants package eligibility.
use std::{path::Path, sync::atomic::AtomicBool, time::Duration};

pub const JOB_COMMIT_BYTES: usize = 128 * 1024 * 1024;
pub const HEAP_BYTES: usize = 96 * 1024 * 1024;
pub const FRAME_BYTES: usize = 1024 * 1024;
// One request, one response, no queue or unbounded writer thread. The request fits
// in the initially empty 4096-byte pipe before the suspended worker is resumed.
pub const REQUEST_BYTES: usize = 2048;
pub const CONTAINER_NAME: &str = "PandaCode.ExtensionRuntime.Foundation";

#[derive(Debug, PartialEq, Eq)]
pub enum Error {
    UnsupportedTarget,
    InvalidRequest,
    SandboxCreation(String),
    Timeout,
    Cancelled,
    InvalidFrame,
    HostExited(u32),
    DisposalFailed,
}

#[derive(Debug)]
pub struct Report {
    pub body: Vec<u8>,
    /// JobObjectExtendedLimitInformation.PeakJobMemoryUsed: committed memory, not RSS.
    pub peak_job_commit_bytes: usize,
    pub exit_code: u32,
    pub process_id: u32,
}

#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
mod windows;
#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
pub use windows::container_sid;

/// Blocking native worker operation; callers must use their existing blocking executor.
/// `binary` must be the host-owned, read-only companion, never a package-provided path.
/// ACL provisioning is an explicit packaging concern; launch never mutates file ACLs.
pub fn run(
    binary: &Path,
    request: &[u8],
    deadline: Duration,
    cancel: &AtomicBool,
) -> Result<Report, Error> {
    if request.len() > REQUEST_BYTES || deadline.is_zero() || deadline > Duration::from_secs(5) {
        return Err(Error::InvalidRequest);
    }
    if cancel.load(std::sync::atomic::Ordering::Acquire) {
        return Err(Error::Cancelled);
    }
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        windows::run(binary, request, deadline, cancel)
    }
    #[cfg(not(all(target_os = "windows", target_arch = "x86_64")))]
    {
        let _ = (binary, request, deadline, cancel);
        Err(Error::UnsupportedTarget)
    }
}

/// The child protocol bounds allocation before accepting an untrusted frame body.
pub fn read_frame(mut input: impl std::io::Read) -> std::io::Result<Vec<u8>> {
    let mut header = [0; 4];
    input.read_exact(&mut header)?;
    let size = u32::from_le_bytes(header) as usize;
    if size > FRAME_BYTES {
        return Err(std::io::Error::other("Frame limit exceeded"));
    }
    let mut body = vec![0; size];
    input.read_exact(&mut body)?;
    Ok(body)
}

pub fn write_frame(mut output: impl std::io::Write, body: &[u8]) -> std::io::Result<()> {
    if body.len() > FRAME_BYTES {
        return Err(std::io::Error::other("Frame limit exceeded"));
    }
    output.write_all(&(body.len() as u32).to_le_bytes())?;
    output.write_all(body)?;
    output.flush()
}

#[cfg(test)]
mod tests {
    #[test]
    fn oversized_header_is_rejected_without_reading_or_allocating_its_body() {
        assert!(
            super::read_frame((super::FRAME_BYTES as u32 + 1).to_le_bytes().as_slice()).is_err()
        );
    }
}
