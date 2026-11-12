//! Capability-free LPAC + non-breakaway Job Object. No weaker retry path.
use super::*;
use ::windows::{
    core::{PCWSTR, PWSTR},
    Win32::{
        Foundation::*,
        Security::{Isolation::*, *},
        System::{JobObjects::*, Pipes::*, Threading::*},
    },
};
use std::{
    ffi::c_void,
    fs::File,
    io::Read,
    mem::size_of,
    os::windows::io::{FromRawHandle, OwnedHandle},
    ptr,
    sync::atomic::Ordering,
    time::Instant,
};

fn wide(text: &std::ffi::OsStr) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    text.encode_wide().chain(Some(0)).collect()
}
fn failed(error: ::windows::core::Error) -> Error {
    Error::SandboxCreation(format!("Windows isolation failed: {}", error.code()))
}
struct Handle(HANDLE);
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}
impl Handle {
    fn file(self) -> File {
        let raw = self.0 .0;
        std::mem::forget(self);
        unsafe { File::from(OwnedHandle::from_raw_handle(raw)) }
    }
}
struct Sid(PSID);
impl Sid {
    fn new() -> Result<Self, Error> {
        let name = wide(std::ffi::OsStr::new(CONTAINER_NAME));
        unsafe {
            DeriveAppContainerSidFromAppContainerName(PCWSTR(name.as_ptr()))
                .map(Self)
                .map_err(failed)
        }
    }
}
impl Drop for Sid {
    fn drop(&mut self) {
        unsafe {
            FreeSid(self.0);
        }
    }
}

pub fn container_sid() -> Result<String, Error> {
    // SID string conversion is needed by the test-owned packaging ACL step.
    let sid = Sid::new()?;
    unsafe {
        let count = *GetSidSubAuthorityCount(sid.0) as usize;
        let authority = (*GetSidIdentifierAuthority(sid.0))
            .Value
            .iter()
            .fold(0u64, |v, b| (v << 8) | *b as u64);
        let mut text = format!("S-1-{authority}");
        for index in 0..count {
            text.push_str(&format!("-{}", *GetSidSubAuthority(sid.0, index as u32)));
        }
        Ok(text)
    }
}

struct Attributes {
    memory: Vec<usize>,
    list: LPPROC_THREAD_ATTRIBUTE_LIST,
}
impl Attributes {
    fn new(count: u32) -> Result<Self, Error> {
        let mut bytes = 0;
        unsafe {
            let _ = InitializeProcThreadAttributeList(None, count, None, &mut bytes);
        }
        if bytes == 0 {
            return Err(Error::SandboxCreation("No attribute-list size".into()));
        }
        let mut memory = vec![0usize; bytes.div_ceil(size_of::<usize>())];
        let list = LPPROC_THREAD_ATTRIBUTE_LIST(memory.as_mut_ptr().cast());
        unsafe {
            InitializeProcThreadAttributeList(Some(list), count, None, &mut bytes)
                .map_err(failed)?;
        }
        Ok(Self { memory, list })
    }
    fn set<T>(&mut self, key: u32, value: &T) -> Result<(), Error> {
        unsafe {
            UpdateProcThreadAttribute(
                self.list,
                0,
                key as usize,
                Some(ptr::from_ref(value).cast()),
                size_of::<T>(),
                None,
                None,
            )
            .map_err(failed)
        }
    }
}
impl Drop for Attributes {
    fn drop(&mut self) {
        unsafe {
            DeleteProcThreadAttributeList(self.list);
        }
        let _ = self.memory.len();
    }
}

fn pipe() -> Result<(Handle, Handle), Error> {
    let mut read = HANDLE::default();
    let mut write = HANDLE::default();
    let security = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        bInheritHandle: true.into(),
        ..Default::default()
    };
    unsafe {
        CreatePipe(&mut read, &mut write, Some(&security), 4096).map_err(failed)?;
    }
    Ok((Handle(read), Handle(write)))
}

struct Worker {
    process: Handle,
    job: Handle,
}
impl Worker {
    fn reap(&self) -> Result<(), Error> {
        unsafe {
            TerminateJobObject(self.job.0, 1).map_err(|_| Error::DisposalFailed)?;
            if WaitForSingleObject(self.process.0, 1000) != WAIT_OBJECT_0 {
                return Err(Error::DisposalFailed);
            }
            let mut counts = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
            QueryInformationJobObject(
                Some(self.job.0),
                JobObjectBasicAccountingInformation,
                ptr::from_mut(&mut counts).cast(),
                size_of_val(&counts) as u32,
                None,
            )
            .map_err(|_| Error::DisposalFailed)?;
            if counts.ActiveProcesses != 0 {
                return Err(Error::DisposalFailed);
            }
        }
        Ok(())
    }
}
impl Drop for Worker {
    fn drop(&mut self) {
        let _ = self.reap();
    }
}

pub(super) fn run(
    binary: &Path,
    request: &[u8],
    deadline: Duration,
    cancel: &AtomicBool,
) -> Result<Report, Error> {
    let start = Instant::now();
    let original = binary.to_str().ok_or(Error::InvalidRequest)?;
    if !binary.is_absolute() || original.contains(['"', '\0']) {
        return Err(Error::InvalidRequest);
    }
    // Resolve the packaging path before passing it to Win32. The working
    // directory is the explicitly granted companion directory, not a host path.
    let resolved = binary
        .canonicalize()
        .map_err(|error| Error::SandboxCreation(format!("Resolve companion: {error}")))?;
    let binary = resolved.as_path();
    // Reject ambiguous command lines and non-absolute paths. The binary is host-owned.
    let text = binary.to_str().ok_or(Error::InvalidRequest)?;
    if !binary.is_absolute() || text.contains(['"', '\0']) {
        return Err(Error::InvalidRequest);
    }
    let application = wide(binary.as_os_str());
    let mut command = wide(std::ffi::OsStr::new(&format!("\"{text}\"")));
    let sid = Sid::new()?;
    let capabilities = SECURITY_CAPABILITIES {
        AppContainerSid: sid.0,
        ..Default::default()
    };
    let job = Handle(unsafe { CreateJobObjectW(None, PCWSTR::null()).map_err(failed)? });
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_JOB_MEMORY
        | JOB_OBJECT_LIMIT_ACTIVE_PROCESS
        | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
    limits.BasicLimitInformation.ActiveProcessLimit = 1;
    limits.JobMemoryLimit = JOB_COMMIT_BYTES;
    unsafe {
        SetInformationJobObject(
            job.0,
            JobObjectExtendedLimitInformation,
            ptr::from_ref(&limits).cast(),
            size_of_val(&limits) as u32,
        )
        .map_err(failed)?;
    }
    let (input, parent_input) = pipe()?;
    let (parent_output, output) = pipe()?;
    unsafe {
        SetHandleInformation(parent_input.0, HANDLE_FLAG_INHERIT.0, HANDLE_FLAGS(0))
            .map_err(failed)?;
        SetHandleInformation(parent_output.0, HANDLE_FLAG_INHERIT.0, HANDLE_FLAGS(0))
            .map_err(failed)?;
    }
    let inherited = [input.0, output.0];
    let jobs = [job.0];
    let lpac: u32 = 1; // PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT
    let no_children: u32 = 1; // PROCESS_CREATION_CHILD_PROCESS_RESTRICTED
    let mut attributes = Attributes::new(5)?;
    attributes.set(PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, &capabilities)?;
    attributes.set(PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY, &lpac)?;
    attributes.set(PROC_THREAD_ATTRIBUTE_CHILD_PROCESS_POLICY, &no_children)?;
    attributes.set(PROC_THREAD_ATTRIBUTE_HANDLE_LIST, &inherited)?;
    attributes.set(PROC_THREAD_ATTRIBUTE_JOB_LIST, &jobs)?;
    let startup = STARTUPINFOEXW {
        StartupInfo: STARTUPINFOW {
            cb: size_of::<STARTUPINFOEXW>() as u32,
            dwFlags: STARTF_USESTDHANDLES,
            hStdInput: input.0,
            hStdOutput: output.0,
            hStdError: output.0,
            ..Default::default()
        },
        lpAttributeList: attributes.list,
    };
    // Empty explicit Unicode environment: never inherit parent credentials or PATH.
    let environment = [0u16, 0u16];
    let cwd = wide(binary.parent().ok_or(Error::InvalidRequest)?.as_os_str());
    let mut info = PROCESS_INFORMATION::default();
    unsafe {
        CreateProcessW(
            PCWSTR(application.as_ptr()),
            Some(PWSTR(command.as_mut_ptr())),
            None,
            None,
            true,
            CREATE_SUSPENDED
                | CREATE_UNICODE_ENVIRONMENT
                | CREATE_NO_WINDOW
                | EXTENDED_STARTUPINFO_PRESENT,
            Some(environment.as_ptr().cast::<c_void>()),
            PCWSTR(cwd.as_ptr()),
            &startup.StartupInfo,
            &mut info,
        )
        .map_err(|error| {
            Error::SandboxCreation(format!(
                "CreateProcessW (LPAC, explicit handles, atomic job): {}",
                error.code()
            ))
        })?;
    }
    let worker = Worker {
        process: Handle(info.hProcess),
        job,
    };
    let thread = Handle(info.hThread);
    drop(input);
    drop(output);
    let mut writer = parent_input.file();
    // At most 2052 bytes in an empty 4096-byte pipe: cannot wait on guest reads.
    if write_frame(&mut writer, request).is_err() {
        return Err(Error::InvalidFrame);
    }
    drop(writer);
    unsafe {
        if ResumeThread(thread.0) == u32::MAX {
            return Err(failed(::windows::core::Error::from_thread()));
        }
    }
    drop(thread);
    let output_handle = parent_output.0;
    let mut reader = parent_output.file();
    let mut bytes = Vec::new();
    let mut body_size = None;
    loop {
        let mut available = 0;
        unsafe {
            let _ = PeekNamedPipe(output_handle, None, 0, None, Some(&mut available), None);
        }
        if available > 0 {
            let mut chunk = [0; 4096];
            let size = (available as usize).min(chunk.len());
            let n = reader
                .read(&mut chunk[..size])
                .map_err(|_| Error::InvalidFrame)?;
            if bytes.len() + n > FRAME_BYTES + 4 {
                return Err(Error::InvalidFrame);
            }
            bytes.extend_from_slice(&chunk[..n]);
            if bytes.len() >= 4 {
                let size = u32::from_le_bytes(bytes[..4].try_into().unwrap()) as usize;
                if size > FRAME_BYTES {
                    return Err(Error::InvalidFrame);
                }
                body_size = Some(size);
                if bytes.len() > size + 4 {
                    return Err(Error::InvalidFrame);
                }
            }
        }
        if cancel.load(Ordering::Acquire) {
            worker.reap()?;
            return Err(Error::Cancelled);
        }
        if start.elapsed() >= deadline {
            worker.reap()?;
            return Err(Error::Timeout);
        }
        if unsafe { WaitForSingleObject(worker.process.0, 0) } == WAIT_OBJECT_0 && available == 0 {
            let mut code = 0;
            unsafe {
                GetExitCodeProcess(worker.process.0, &mut code).map_err(failed)?;
            }
            if code != 0 {
                return Err(Error::HostExited(code));
            }
            if body_size.is_none_or(|size| bytes.len() != size + 4) {
                return Err(Error::InvalidFrame);
            }
            let mut usage = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            unsafe {
                QueryInformationJobObject(
                    Some(worker.job.0),
                    JobObjectExtendedLimitInformation,
                    ptr::from_mut(&mut usage).cast(),
                    size_of_val(&usage) as u32,
                    None,
                )
                .map_err(failed)?;
            }
            worker.reap()?;
            return Ok(Report {
                body: bytes.split_off(4),
                peak_job_commit_bytes: usage.PeakJobMemoryUsed,
                exit_code: code,
                process_id: info.dwProcessId,
            });
        }
        std::thread::sleep(Duration::from_millis(2));
    }
}
