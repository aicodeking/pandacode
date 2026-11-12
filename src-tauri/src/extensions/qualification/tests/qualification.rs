//! Test-owned children only. Drop always kills/reaps, including assertion/timeout failures.
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Write},
    process::{Child, Command, Stdio},
    sync::mpsc,
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

struct Host {
    child: Child,
    lines: mpsc::Receiver<String>,
    reader: Option<JoinHandle<()>>,
}
impl Host {
    fn new(case: &str) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_pandacode-runtime-qualification"))
            .arg(case)
            .env_clear()
            .env("QUALIFICATION_SENTINEL", "synthetic-not-a-secret")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        let (send, lines) = mpsc::channel();
        let reader = thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                if let Ok(line) = line {
                    if send.send(line).is_err() {
                        break;
                    }
                } else {
                    break;
                }
            }
        });
        let host = Self {
            child,
            lines,
            reader: Some(reader),
        };
        assert!(host.line().get("ready").is_some());
        host
    }
    fn line(&self) -> Value {
        serde_json::from_str(
            &self
                .lines
                .recv_timeout(Duration::from_secs(10))
                .expect("bounded child result"),
        )
        .unwrap()
    }
    fn send(&mut self, bytes: &[u8]) {
        self.child.stdin.as_mut().unwrap().write_all(bytes).unwrap();
    }
    fn finish(&mut self) {
        let end = Instant::now() + Duration::from_secs(2);
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                assert!(status.success());
                break;
            }
            assert!(Instant::now() < end, "child did not exit");
            thread::sleep(Duration::from_millis(5));
        }
    }
}
impl Drop for Host {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Some(reader) = self.reader.take() {
            reader.join().unwrap();
        }
    }
}

#[test]
fn deadline_allocation_exception_and_ambient_denials_are_real_engine_experiments() {
    for (case, expected) in [
        ("loop", "Timeout"),
        ("allocation", "EngineError"),
        ("exception", "EngineError"),
        ("denials", "Completed"),
    ] {
        let mut host = Host::new(case);
        let report = host.line();
        println!("{report}");
        assert_eq!(report["status"], expected);
        assert_eq!(report["osSandboxEnforced"], false);
        assert_eq!(report["processMemoryLimitEnforced"], false);
        let bytes = report["engineMallocBytes"].as_u64().unwrap();
        assert!(bytes <= 128 * 1024 * 1024, "engine allocator cap");
        if case == "allocation" {
            assert_eq!(report["fixtureError"], "out of memory");
            assert!(
                bytes > 120 * 1024 * 1024,
                "allocation actually approached the cap"
            );
            assert!(
                report["elapsedMs"].as_u64().unwrap() < 5000,
                "not merely a timeout"
            );
        }
        if case == "loop" {
            assert!((5000..6000).contains(&report["elapsedMs"].as_u64().unwrap()));
        }
        host.finish();
    }
}

#[test]
fn cancellation_interrupts_execution_and_termination_reaps_only_the_owned_child() {
    let mut host = Host::new("cancel");
    let start = Instant::now();
    host.send(b"C");
    let report = host.line();
    println!("{report}");
    assert_eq!(report["status"], "Cancelled");
    assert!(start.elapsed() < Duration::from_secs(1));
    host.finish();
    let mut killed = Host::new("loop");
    let start = Instant::now();
    killed.child.kill().unwrap();
    assert!(!killed.child.wait().unwrap().success());
    assert!(start.elapsed() < Duration::from_secs(1));
    assert!(killed.child.try_wait().unwrap().is_some());
    // Failure of one child does not poison the next independent runtime.
    let mut next = Host::new("denials");
    assert_eq!(next.line()["status"], "Completed");
    next.finish();
    println!("cancellation and kill/reap <1000ms; independent subsequent runtime passed");
}

#[test]
fn rpc_limit_precedes_allocation_and_payload_cannot_forge_channel_identity() {
    let mut large = Host::new("rpc");
    large.send(&(1024_u32 * 1024 + 1).to_le_bytes());
    assert_eq!(large.line()["status"], "LimitExceeded"); // No body sent or allocated.
    large.finish();
    for (body, expected) in [
        (json!({"operation":"ping"}), "Completed"),
        (
            json!({"operation":"ping", "extensionId":"panda.core"}),
            "PermissionDenied",
        ),
        (
            json!({"operation":"readFile", "path":"qualification-sentinel"}),
            "PermissionDenied",
        ),
    ] {
        let mut host = Host::new("rpc");
        let bytes = serde_json::to_vec(&body).unwrap();
        host.send(&(bytes.len() as u32).to_le_bytes());
        host.send(&bytes);
        let report = host.line();
        println!("{report}");
        assert_eq!(report["status"], expected);
        assert_eq!(report["principal"], "qualification.fixture");
        host.finish();
    }
}
