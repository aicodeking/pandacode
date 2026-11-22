//! Owned Windows process trees. Closing a job also terminates its descendants.
#![cfg(windows)]

use std::{
    collections::{hash_map::Entry, HashMap},
    io,
    mem::size_of,
    os::windows::{
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
        process::CommandExt,
    },
    process::{Child, Command},
    sync::{Mutex, OnceLock},
};
use windows::{
    core::PCWSTR,
    Win32::{
        Foundation::HANDLE,
        System::{
            JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicAccountingInformation,
                JobObjectExtendedLimitInformation, QueryInformationJobObject,
                SetInformationJobObject, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
                JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            },
            Threading::{
                OpenProcess, CREATE_NO_WINDOW, CREATE_SUSPENDED, PROCESS_SET_QUOTA,
                PROCESS_SUSPEND_RESUME, PROCESS_TERMINATE,
            },
        },
    },
};

pub(crate) struct Job(OwnedHandle);

#[link(name = "ntdll")]
unsafe extern "system" {
    fn NtResumeProcess(process_handle: HANDLE) -> i32;
}

impl Job {
    /// Assign the suspended child before it can run user code or spawn descendants.
    /// Attachment failure preserves the caller's process-tree fallback; resume failure
    /// always terminates and reaps the child, so no suspended process is left behind.
    pub(crate) fn spawn(command: &mut Command) -> io::Result<(Child, Option<Self>)> {
        command.creation_flags(CREATE_SUSPENDED.0 | CREATE_NO_WINDOW.0);
        let mut child = command.spawn()?;
        // SAFETY: OpenProcess returns an owned handle. The child remains suspended
        // until after job assignment, so it cannot create an unowned descendant.
        let process = unsafe {
            OpenProcess(
                PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_SUSPEND_RESUME,
                false,
                child.id(),
            )
            .ok()
            .map(|handle| OwnedHandle::from_raw_handle(handle.0))
        };
        let job = process
            .as_ref()
            .and_then(|process| Self::for_process(HANDLE(process.as_raw_handle())));
        // SAFETY: both handles refer to the child and remain owned throughout the call.
        // CreateProcess gives Child a handle with full access: it can resume the child
        // even if opening a separate handle (and therefore attaching the job) failed.
        let handle = process
            .as_ref()
            .map_or(child.as_raw_handle(), AsRawHandle::as_raw_handle);
        let status = unsafe { NtResumeProcess(HANDLE(handle)) };
        if status < 0 {
            drop(job);
            let _ = child.kill();
            let _ = child.wait();
            return Err(io::Error::other(format!(
                "Could not resume the suspended process (NTSTATUS {status:#010x})"
            )));
        }
        Ok((child, job))
    }

    /// Call immediately after spawning. Failure leaves the caller's fallback intact.
    pub(crate) fn attach(pid: u32) -> Option<Self> {
        // SAFETY: OpenProcess returns an owned handle, kept alive through assignment.
        let process = unsafe {
            OwnedHandle::from_raw_handle(
                OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid)
                    .ok()?
                    .0,
            )
        };
        Self::for_process(HANDLE(process.as_raw_handle()))
    }

    fn for_process(process: HANDLE) -> Option<Self> {
        // SAFETY: successful Win32 constructors return owned, valid handles. Each is
        // immediately wrapped for cleanup, including every early return below.
        unsafe {
            let job = Self(OwnedHandle::from_raw_handle(
                CreateJobObjectW(None, PCWSTR::null()).ok()?.0,
            ));
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(
                job.handle(),
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
            .ok()?;
            AssignProcessToJobObject(job.handle(), process).ok()?;
            Some(job)
        }
    }

    fn handle(&self) -> HANDLE {
        HANDLE(self.0.as_raw_handle())
    }

    fn active(&self) -> bool {
        let mut info = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        // SAFETY: the handle remains owned and the output buffer has the declared size.
        let result = unsafe {
            QueryInformationJobObject(
                Some(self.handle()),
                JobObjectBasicAccountingInformation,
                (&mut info as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                None,
            )
        };
        result.is_err() || info.ActiveProcesses > 0
    }
}

fn registry() -> &'static Mutex<HashMap<u32, Job>> {
    static JOBS: OnceLock<Mutex<HashMap<u32, Job>>> = OnceLock::new();
    JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) fn register(pid: u32) {
    let mut jobs = registry().lock().unwrap_or_else(|error| error.into_inner());
    // Retain orphaned descendants, but never accumulate completed process trees.
    jobs.retain(|_, job| job.active());
    if let Entry::Vacant(entry) = jobs.entry(pid) {
        if let Some(job) = Job::attach(pid) {
            entry.insert(job);
        }
    }
}

pub(crate) fn terminate(pid: u32) -> bool {
    let job = registry()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .remove(&pid);
    let handled = job.is_some();
    drop(job);
    handled
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        process::{Command, Stdio},
        time::{Duration, Instant},
    };
    use windows::Win32::{
        Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT},
        System::Threading::{
            WaitForSingleObject, CREATE_NEW_PROCESS_GROUP, DETACHED_PROCESS, PROCESS_SYNCHRONIZE,
        },
    };

    #[test]
    fn descendant_fixture() {
        let Some(path) = std::env::var_os("PANDACODE_WINDOWS_JOB_FIXTURE") else {
            return;
        };
        // Spawn immediately, without a parent handshake. Detaching from the console
        // must not let a descendant escape the job inherited at process creation.
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "providers::windows_job::tests::leaf_fixture"])
            .env("PANDACODE_WINDOWS_JOB_LEAF", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(DETACHED_PROCESS.0 | CREATE_NEW_PROCESS_GROUP.0)
            .spawn()
            .unwrap();
        std::fs::write(path, format!("{}\n", child.id())).unwrap();
        let _ = child.wait();
    }

    #[test]
    fn leaf_fixture() {
        if std::env::var_os("PANDACODE_WINDOWS_JOB_LEAF").is_some() {
            std::thread::sleep(Duration::from_secs(60));
        }
    }

    #[test]
    fn dropping_job_terminates_child_and_immediate_detached_descendant() {
        let path = std::env::temp_dir().join(format!("pandacode-job-{}", uuid::Uuid::new_v4()));
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "providers::windows_job::tests::descendant_fixture",
            ])
            .env("PANDACODE_WINDOWS_JOB_FIXTURE", &path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let (mut child, job) = Job::spawn(&mut command).unwrap();
        let job = match job {
            Some(job) => job,
            None => {
                let _ = child.kill();
                let _ = child.wait();
                panic!("Could not assign the fixture process to a Windows Job Object");
            }
        };
        let deadline = Instant::now() + Duration::from_secs(10);
        let pid = loop {
            if let Some(pid) = std::fs::read_to_string(&path)
                .ok()
                .and_then(|text| text.strip_suffix('\n')?.parse::<u32>().ok())
            {
                break pid;
            }
            assert!(
                Instant::now() < deadline,
                "Descendant fixture did not start"
            );
            std::thread::sleep(Duration::from_millis(10));
        };
        std::fs::remove_file(path).unwrap();
        // SAFETY: OpenProcess transfers a valid handle; both process handles stay
        // owned until all bounded waits finish.
        unsafe {
            let descendant = OwnedHandle::from_raw_handle(
                OpenProcess(PROCESS_SYNCHRONIZE, false, pid).unwrap().0,
            );
            assert_eq!(
                WaitForSingleObject(HANDLE(descendant.as_raw_handle()), 0),
                WAIT_TIMEOUT
            );
            drop(job);
            assert_eq!(
                WaitForSingleObject(HANDLE(child.as_raw_handle()), 5000),
                WAIT_OBJECT_0
            );
            assert_eq!(
                WaitForSingleObject(HANDLE(descendant.as_raw_handle()), 5000),
                WAIT_OBJECT_0
            );
        }
        let _ = child.wait().unwrap();
    }
}
