#![cfg(all(
    target_os = "windows",
    target_arch = "x86_64",
    feature = "native-probes"
))]
use pandacode_native_runtime::{run, Error, JOB_COMMIT_BYTES};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};
fn binary(name: &str) -> PathBuf {
    PathBuf::from(
        std::env::var_os("PANDACODE_RUNTIME_STAGE")
            .expect("Use the native-runtime packaging runner; no unconfined fallback"),
    )
    .join(format!("{name}.exe"))
}
fn probe(request: Value) -> Result<pandacode_native_runtime::Report, Error> {
    run(
        &binary("pandacode-runtime-probe"),
        &serde_json::to_vec(&request).unwrap(),
        Duration::from_secs(5),
        &AtomicBool::new(false),
    )
}
#[test]
fn native_denials_and_whole_job_commit_are_enforced() {
    let stage = binary("pandacode-runtime-probe")
        .parent()
        .unwrap()
        .to_path_buf();
    let outside = stage
        .parent()
        .unwrap()
        .join("extensibility-runtime-canary.txt");
    std::fs::write(&outside, b"synthetic-canary-not-a-secret").unwrap();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    std::env::set_var("PANDACODE_NATIVE_SENTINEL", "synthetic-only");
    let report = probe(json!({"case":"denials","canary":outside,"listener":listener.local_addr().unwrap().to_string(),"parent":std::process::id()})).unwrap();
    let value: Value = serde_json::from_slice(&report.body).unwrap();
    println!(
        "denials: {value}; peakJobCommitBytes={}",
        report.peak_job_commit_bytes
    );
    for key in [
        "filesystemDenied",
        "writeDenied",
        "loopbackDenied",
        "processDenied",
        "environmentEmpty",
    ] {
        assert_eq!(value[key], true, "{key}");
    }
    assert!(
        listener.accept().is_err(),
        "No loopback connection accepted"
    );
    assert_eq!(
        std::fs::read(&outside).unwrap(),
        b"synthetic-canary-not-a-secret"
    );
    let report = probe(json!({"case":"allocation"})).unwrap();
    let value: Value = serde_json::from_slice(&report.body).unwrap();
    println!(
        "allocation: {value}; peakJobCommitBytes={}",
        report.peak_job_commit_bytes
    );
    assert_eq!(value["commitDenied"], true);
    assert!(value["nativeAllocatedBytes"].as_u64().unwrap() > 100 * 1024 * 1024);
    assert!(
        report.peak_job_commit_bytes > 100 * 1024 * 1024
            && report.peak_job_commit_bytes <= JOB_COMMIT_BYTES
    );
}
#[test]
fn real_failures_cancel_deadline_crash_frame_and_recovery() {
    let path = binary("pandacode-runtime-probe");
    let request = br#"{"case":"loop"}"#;
    let cancel = AtomicBool::new(false);
    std::thread::scope(|scope| {
        scope.spawn(|| {
            std::thread::sleep(Duration::from_millis(100));
            cancel.store(true, Ordering::Release);
        });
        let start = Instant::now();
        assert_eq!(
            run(&path, request, Duration::from_secs(5), &cancel).unwrap_err(),
            Error::Cancelled
        );
        assert!(start.elapsed() < Duration::from_secs(1));
    });
    let start = Instant::now();
    assert_eq!(
        run(
            &path,
            request,
            Duration::from_millis(200),
            &AtomicBool::new(false)
        )
        .unwrap_err(),
        Error::Timeout
    );
    assert!(start.elapsed() < Duration::from_secs(1));
    assert!(matches!(
        probe(json!({"case":"crash"})),
        Err(Error::HostExited(_))
    ));
    assert_eq!(
        probe(json!({"case":"oversized"})).unwrap_err(),
        Error::InvalidFrame
    );
    let next = probe(json!({"case":"independent"})).unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&next.body).unwrap()["independent"],
        true
    );
    // Holding a kernel process handle prevents PID reuse while checking reap.
    unsafe {
        use windows::Win32::{Foundation::*, System::Threading::*};
        match OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
            false,
            next.process_id,
        ) {
            Ok(handle) => {
                assert_eq!(WaitForSingleObject(handle, 0), WAIT_OBJECT_0);
                CloseHandle(handle).unwrap();
            }
            Err(error) => assert_eq!(
                error.code(),
                windows::core::HRESULT::from_win32(ERROR_INVALID_PARAMETER.0)
            ),
        }
    }
    println!("native cancellation/deadline <1000ms; crash/oversized response rejected; fresh host/reap verified");
}
#[test]
fn companion_engine_is_staged_and_startup_remains_fail_closed() {
    let path = binary("pandacode-extension-host");
    for (source, status) in [
        ("1+1", "Completed"),
        ("throw Error('synthetic')", "EngineError"),
        (
            "const x=[];for(;;)x.push(new Array(10000).fill(1));",
            "EngineError",
        ),
    ] {
        let report = run(
            &path,
            source.as_bytes(),
            Duration::from_secs(5),
            &AtomicBool::new(false),
        )
        .unwrap();
        let value: Value = serde_json::from_slice(&report.body).unwrap();
        assert_eq!(value["status"], status);
        assert!(report.peak_job_commit_bytes <= JOB_COMMIT_BYTES);
        println!(
            "companion: {value}; peakJobCommitBytes={}",
            report.peak_job_commit_bytes
        );
    }
    assert!(matches!(
        run(
            &path.with_file_name("absent.exe"),
            b"1",
            Duration::from_secs(5),
            &AtomicBool::new(false)
        ),
        Err(Error::SandboxCreation(_))
    ));
    assert_eq!(
        run(
            &path,
            &vec![0; 2049],
            Duration::from_secs(5),
            &AtomicBool::new(false)
        )
        .unwrap_err(),
        Error::InvalidRequest
    );
    assert_eq!(
        run(&path, b"1", Duration::ZERO, &AtomicBool::new(false)).unwrap_err(),
        Error::InvalidRequest
    );
}
