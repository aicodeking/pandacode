//! Optional turn-end project checks: one fast command the checkout itself
//! declares through its manifests, run once by the app after a clean turn
//! when the user turned checks on in Settings → Agents. Bounded like every
//! external tool; a failure goes back to the agent through the ordinary
//! message queue, where the user can edit or cancel the repair request.
use serde_json::{json, Value};
use std::{path::Path, process::Command, time::Duration};

use crate::workspace::run_process;

const OUTPUT_LIMIT: usize = 64 * 1024;
const TIMEOUT: Duration = Duration::from_secs(120);
/// How much of a failed check's output rides back to the agent.
const TAIL_BYTES: usize = 4000;

const NO_PLAN: &str = "This project declares no fast check (no npm test script and no Cargo.toml).";

/// One fast check a checkout declares through its own manifests.
pub(crate) struct Plan {
    pub name: String,
    program: String,
    args: Vec<String>,
}

/// The npm `test` script when package.json declares one, otherwise `cargo
/// check` for a Rust checkout. Nothing is invented beyond the manifests.
pub(crate) fn plan(root: &Path) -> Option<Plan> {
    if let Some(package) = read_manifest(&root.join("package.json")) {
        let declares_test = serde_json::from_str::<Value>(&package)
            .ok()
            .is_some_and(|package| {
                package["scripts"]["test"]
                    .as_str()
                    .map(str::trim)
                    .is_some_and(|script| !script.is_empty())
            });
        if declares_test {
            return Some(Plan { name: "npm test".into(), program: "npm".into(), args: vec!["test".into(), "--silent".into()] });
        }
    }
    if root.join("Cargo.toml").is_file() {
        return Some(Plan { name: "cargo check".into(), program: "cargo".into(), args: vec!["check".into()] });
    }
    None
}

/// Largest package.json [`plan`] reads.
const MANIFEST_LIMIT: u64 = 1024 * 1024;

/// A manifest's text, only when it is a regular file of at most [`MANIFEST_LIMIT`]. Round 23:
/// the phone's `checks.plan` (View) reads it, and a FIFO named package.json once hung that read,
/// so the open never blocks (`O_NONBLOCK`) and the type is checked on the opened handle.
fn read_manifest(path: &Path) -> Option<String> {
    use std::io::Read;
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    let file = options.open(path).ok()?;
    let meta = file.metadata().ok()?;
    if !meta.is_file() || meta.len() > MANIFEST_LIMIT {
        return None;
    }
    let mut text = String::new();
    file.take(MANIFEST_LIMIT).read_to_string(&mut text).ok()?;
    Some(text)
}

/// Runs the checkout's declared check and reports the outcome as data for the
/// composer queue. A missing plan is a result, not an error.
pub(crate) fn turn_report(root: &Path) -> Value {
    let Some(plan) = plan(root) else {
        return json!({"checked": false, "reason": NO_PLAN});
    };
    match run(root, &plan) {
        Ok(report) => report,
        // A check that cannot start (say, npm is missing) or finish in time is
        // not the agent's doing: it is skipped, never reported as a failure.
        Err(error) => json!({"checked": false, "reason": error}),
    }
}

fn run(root: &Path, plan: &Plan) -> Result<Value, String> {
    // npm is npm.cmd on Windows, which std cannot exec directly.
    let mut command = if cfg!(windows) {
        let mut command = Command::new("cmd");
        command.arg("/C").arg(&plan.program).args(&plan.args);
        command
    } else {
        let mut command = Command::new(&plan.program);
        command.args(&plan.args);
        command
    };
    command.current_dir(root);
    let output = run_process(command, &plan.name, OUTPUT_LIMIT, TIMEOUT)?;
    let ok = output.status.success();
    let stdout = String::from_utf8_lossy(&output.stdout.bytes);
    let combined = if stdout.trim().is_empty() {
        String::from_utf8_lossy(&output.stderr.bytes).into_owned()
    } else {
        stdout.into_owned()
    };
    Ok(json!({
        "checked": true,
        "name": plan.name,
        "ok": ok,
        "output": if ok { String::new() } else { tail(&combined) },
        "truncated": output.stdout.truncated || output.stderr.truncated,
    }))
}

/// The last `TAIL_BYTES` bytes of a failed check's output, cut at a char
/// boundary: summaries and error counts sit at the end.
fn tail(text: &str) -> String {
    let text = text.trim();
    if text.len() <= TAIL_BYTES {
        return text.to_owned();
    }
    let mut start = text.len() - TAIL_BYTES;
    while !text.is_char_boundary(start) {
        start -= 1;
    }
    text[start..].to_owned()
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::{fs, os::unix::fs::PermissionsExt, path::PathBuf};

    struct Scratch(PathBuf);
    impl Scratch {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!("pandacode-turn-checks-{name}"));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn fake(path: &Path, body: &str) {
        fs::write(path, format!("#!/bin/sh\n{body}\n")).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[test]
    fn the_checkout_manifests_decide_the_check() {
        let temp = Scratch::new("plan");
        let root = temp.path();
        fs::write(root.join("package.json"), r#"{"scripts":{"test":"vitest run"}}"#).unwrap();
        let found = plan(root).unwrap();
        assert_eq!(found.name, "npm test");
        assert_eq!(found.args, vec!["test", "--silent"]);

        // An empty or malformed test script counts as no script at all.
        fs::write(root.join("package.json"), r#"{"scripts":{"test":""}}"#).unwrap();
        assert!(plan(root).is_none());
        fs::write(root.join("package.json"), "not json").unwrap();
        assert!(plan(root).is_none());

        // A Rust checkout falls back to cargo check.
        fs::write(root.join("Cargo.toml"), "[package]\nname = \"x\"\n").unwrap();
        let found = plan(root).unwrap();
        assert_eq!(found.name, "cargo check");
    }

    #[test]
    fn a_failing_check_carries_a_bounded_tail_and_a_passing_one_nothing() {
        let temp = Scratch::new("run");
        let root = temp.path();
        fs::write(root.join("package.json"), r#"{"scripts":{"test":"noop"}}"#).unwrap();
        let failing = root.join("npm");
        fake(&failing, "echo '  3 tests failed  ' >&2\nexit 1");
        let plan = Plan { name: "npm test".into(), program: failing.to_str().unwrap().into(), args: vec![] };
        let report = run(root, &plan).unwrap();
        assert_eq!(report["checked"], true);
        assert_eq!(report["ok"], false);
        assert_eq!(report["output"], "3 tests failed");

        fake(&failing, "echo 'all quiet on stdout'\nexit 0");
        let report = run(root, &plan).unwrap();
        assert_eq!(report["ok"], true);
        assert_eq!(report["output"], "");

        let long = "x".repeat(TAIL_BYTES + 500);
        fake(&failing, &format!("printf '%s' '{long}'\nexit 1"));
        let report = run(root, &plan).unwrap();
        assert_eq!(report["output"].as_str().unwrap().len(), TAIL_BYTES);
    }

    #[test]
    fn a_check_that_cannot_run_is_skipped_not_failed() {
        let temp = Scratch::new("spawn");
        let report = turn_report(temp.path());
        assert_eq!(report["checked"], false);
        assert!(report["reason"].as_str().unwrap().contains("no fast check"));

        let plan = Plan { name: "npm test".into(), program: "/nonexistent/pandacode-npm".into(), args: vec![] };
        let report = run(temp.path(), &plan).unwrap_err();
        assert!(report.contains("Could not start"), "{report}");
    }

    /// Round 23: a FIFO (or folder) named package.json is skipped, never read, so `checks.plan`
    /// cannot hang on it.
    #[test]
    fn a_fifo_manifest_is_skipped_without_blocking() {
        let temp = Scratch::new("fifo");
        let root = temp.path();
        let fifo = root.join("package.json");
        let path = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
        let (done, wait) = std::sync::mpsc::channel();
        let scan = root.to_path_buf();
        std::thread::spawn(move || {
            let _ = done.send(plan(&scan).map(|plan| plan.name));
        });
        assert_eq!(wait.recv_timeout(Duration::from_secs(5)).expect("plan did not hang"), None);
        fs::write(root.join("Cargo.toml"), "[package]\n").unwrap();
        assert_eq!(plan(root).map(|plan| plan.name).as_deref(), Some("cargo check"), "falls through to Cargo.toml");
        fs::remove_file(&fifo).unwrap();
        fs::create_dir(&fifo).unwrap();
        assert!(read_manifest(&fifo).is_none(), "a folder is not a manifest");
    }

    #[test]
    fn tails_cut_at_char_boundaries() {
        let text = "ж".repeat(TAIL_BYTES); // 2 bytes each, so the cut lands mid-character
        let cut = tail(&text);
        assert_eq!(cut.chars().count(), TAIL_BYTES / 2);
        assert_eq!(tail("done"), "done");
    }
}
