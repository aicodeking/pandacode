//! The bridge: PandaCode's own executable in a mode that stands in for a harness process
//! (docs/cloud-agents.md, step 5). The ordinary provider pipeline spawns it like any agent;
//! it starts (or re-attaches to) the runner on the cloud machine, appends its stdin to
//! `inbox`, and copies `out`/`err` to its stdout/stderr until the remote `exit` appears.
use crate::cloud::{sandbox::Sandbox, shell_quote};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

/// Set to the path of a spec file to run this executable as a bridge.
pub(crate) const ENV: &str = "PANDACODE_CLOUD_BRIDGE";
const RUNNER: &str = include_str!("runner.sh");
const FAST: Duration = Duration::from_millis(300);
const IDLE: Duration = Duration::from_secs(2);
const BACKOFF_MAX: Duration = Duration::from_secs(30);
const READ_MAX: usize = 128 * 1024;
/// How often the run's progress is written while nothing else changes.
const PROGRESS_EVERY: Duration = Duration::from_secs(5);

/// What one bridge runs. Written 0600 by the app and deleted by the bridge once read, since
/// `env` can hold credentials.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Spec {
    pub provider: String,
    pub native: String,
    pub run_id: String,
    pub remote_dir: String,
    /// The mirror worktree; paths in the protocol are mapped between it and `remote_dir`.
    pub local_dir: String,
    pub program: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    /// Re-attach to a run that is already going: start nothing, replay `out` from 0, and
    /// skip as many stdin bytes as `inbox` already holds.
    pub attach: bool,
    /// Where progress is written for the app ([`Status`] as JSON).
    pub status: PathBuf,
    /// The app data dir, so this process reads provider keys from PandaCode's secrets file.
    #[serde(default)]
    pub secrets: Option<PathBuf>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Status {
    /// `running` or `reconnecting`.
    pub stage: String,
    pub detail: Option<String>,
    pub offset: u64,
    pub inbox_lines: u64,
    /// Bytes of `inbox` acknowledged by the machine; appends and re-attach count from here.
    pub inbox_bytes: u64,
}

/// An inbox that does not hold what the bridge acknowledged: nothing can be appended safely.
const INBOX_MISMATCH: &str = "The cloud run's input no longer matches what PandaCode sent";
/// Raw bytes per inbox append, so the whole command stays under 60 KiB.
const APPEND_MAX: usize = crate::cloud::sandbox::CHUNK;

/// The run directory on the machine, under its HOME.
pub(crate) fn run_dir(home: &str, run_id: &str) -> String {
    format!("{}/.pandacode/runs/{run_id}", home.trim_end_matches('/'))
}

pub(crate) fn home(sandbox: &dyn Sandbox, native: &str) -> crate::Result<String> {
    let (code, output) = sandbox.exec(native, "printf %s \"$HOME\"", Duration::from_secs(60))?;
    let home = output.trim().to_owned();
    if code != Some(0) || !home.starts_with('/') {
        return Err("The cloud machine has no home folder.".into());
    }
    Ok(home)
}

/// The harness command, run by `runner.sh`. It removes itself once read: it may hold keys.
pub(crate) fn command_script(spec: &Spec) -> crate::Result<String> {
    let mut script = format!("rm -f -- \"$0\"\ncd {} || exit 126\n", shell_quote(&spec.remote_dir));
    for (key, value) in &spec.env {
        if key.is_empty() || key.starts_with(|c: char| c.is_ascii_digit()) || !key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') {
            return Err("A cloud agent environment variable has an invalid name.".into());
        }
        script.push_str(&format!("export {key}={}\n", shell_quote(value)));
    }
    script.push_str("exec");
    for word in std::iter::once(&spec.program).chain(&spec.args) {
        if word.contains('\0') {
            return Err("A cloud agent argument contains a NUL byte.".into());
        }
        script.push(' ');
        script.push_str(&shell_quote(word));
    }
    script.push('\n');
    Ok(script)
}

/// Uploads the runner and the command, then starts the run detached.
fn start(sandbox: &dyn Sandbox, spec: &Spec, dir: &str) -> crate::Result<()> {
    sandbox.upload(&spec.native, &format!("{dir}/runner.sh"), RUNNER.as_bytes(), false)?;
    sandbox.upload(&spec.native, &format!("{dir}/cmd.sh"), command_script(spec)?.as_bytes(), true)?;
    sandbox.upload(&spec.native, &format!("{dir}/inbox"), b"", true)?;
    sandbox.spawn(&spec.native, &format!("cd {d} && exec sh ./runner.sh", d = shell_quote(dir)))
}

/// Kills a run's process group, confirms it is gone, and records it as stopped (143) unless
/// it already ended. Safe to repeat; an error means the run may still be alive.
pub(crate) fn kill(sandbox: &dyn Sandbox, native: &str, run_id: &str) -> crate::Result<()> {
    let dir = run_dir(&home(sandbox, native)?, run_id);
    let command = format!(
        "d={}; [ -d \"$d\" ] || exit 0; if [ -f \"$d/pid\" ]; then p=$(cat \"$d/pid\"); kill -TERM -\"$p\" 2>/dev/null; i=0; while kill -0 -\"$p\" 2>/dev/null && [ $i -lt 5 ]; do sleep 1; i=$((i+1)); done; kill -KILL -\"$p\" 2>/dev/null; i=0; while kill -0 -\"$p\" 2>/dev/null; do [ $i -ge 5 ] && {{ echo 'The cloud run did not stop.'; exit 1; }}; sleep 1; i=$((i+1)); done; fi; [ -f \"$d/exit\" ] || {{ echo 143 > \"$d/exit.tmp\" && mv \"$d/exit.tmp\" \"$d/exit\"; }}",
        shell_quote(&dir)
    );
    crate::cloud::sandbox::checked(sandbox.exec(native, &command, Duration::from_secs(60))?)
}

/// Waits for a run to end and returns its exit code (None when its folder is gone). After
/// `grace` the process group is killed and its death confirmed. An error (the machine
/// can't be reached, or the run would not die) means it may still be running.
pub(crate) fn finish(sandbox: &dyn Sandbox, native: &str, run_id: &str, grace: Duration) -> crate::Result<Option<i32>> {
    let dir = shell_quote(&run_dir(&home(sandbox, native)?, run_id));
    let command = format!("d={dir}; if [ -f \"$d/exit\" ]; then cat \"$d/exit\"; elif [ -d \"$d\" ]; then echo running; else echo gone; fi");
    let (started, mut killed) = (Instant::now(), false);
    loop {
        let (code, output) = sandbox.exec(native, &command, Duration::from_secs(60))?;
        match (code, output.trim()) {
            (Some(0), "gone") => return Ok(None),
            (Some(0), "running") if killed => return Err("The cloud run did not stop.".into()),
            (Some(0), "running") if started.elapsed() >= grace => {
                kill(sandbox, native, run_id)?;
                killed = true;
            }
            (Some(0), "running") => std::thread::sleep(Duration::from_millis(500)),
            (Some(0), code) if !code.is_empty() => return Ok(Some(code.parse().unwrap_or(1))),
            _ => return Err("The cloud machine could not report the run's state.".into()),
        }
    }
}

/// Appends `bytes` to `inbox` once: the machine checks the acknowledged length first, so a
/// retry after a lost answer is skipped, and the chunk is staged in a file and added with
/// one write, so the runner never forwards half of it.
fn append(sandbox: &dyn Sandbox, native: &str, dir: &str, acked: u64, bytes: &[u8]) -> crate::Result<()> {
    let end = acked + bytes.len() as u64;
    let command = format!(
        "d={}; printf %s {} | base64 -d > \"$d/inbox.part\" && s=$(wc -c < \"$d/inbox\" | tr -d ' ') && if [ \"$s\" -eq {acked} ]; then cat \"$d/inbox.part\" >> \"$d/inbox\"; elif [ \"$s\" -ne {end} ]; then echo \"{INBOX_MISMATCH} ($s bytes).\"; exit 3; fi; rm -f \"$d/inbox.part\"",
        shell_quote(dir),
        STANDARD.encode(bytes)
    );
    if command.len() >= crate::cloud::sandbox::COMMAND_MAX {
        return Err("The cloud run's folder path is too long.".into());
    }
    match sandbox.exec(native, &command, Duration::from_secs(60))? {
        (Some(3), output) => Err(output.trim().to_owned()),
        result => crate::cloud::sandbox::checked(result),
    }
}

/// The JSON-escaped body of a path, as it appears inside protocol strings.
fn escaped(path: &str) -> String {
    let quoted = serde_json::to_string(path).unwrap_or_default();
    quoted[1..quoted.len().saturating_sub(1).max(1)].to_owned()
}

fn replace(bytes: Vec<u8>, from: &str, to: &str) -> Vec<u8> {
    if from.is_empty() || from == to {
        return bytes;
    }
    match String::from_utf8(bytes) {
        Ok(text) if text.contains(from) => text.replace(from, to).into_bytes(),
        Ok(text) => text.into_bytes(),
        Err(error) => error.into_bytes(),
    }
}

fn lines(stdin: impl Read + Send + 'static) -> Receiver<Option<Vec<u8>>> {
    let (tx, rx) = channel();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdin);
        loop {
            let mut line = Vec::new();
            match reader.read_until(b'\n', &mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    if tx.send(Some(line)).is_err() {
                        return;
                    }
                }
            }
        }
        let _ = tx.send(None);
    });
    rx
}

struct Poller {
    failures: u32,
}
impl Poller {
    fn backoff(&mut self) -> Duration {
        self.failures += 1;
        (Duration::from_millis(500) * 2u32.saturating_pow(self.failures.min(8))).min(BACKOFF_MAX)
    }
}

/// Runs the bridge until the remote run's `exit` appears (stdin closing only ends the
/// harness's input); returns its exit code. `status` receives progress. Network errors never
/// end it: it backs off (up to 30 s) and keeps trying, so only the run's end or a signal stops it.
pub(crate) fn run(sandbox: &dyn Sandbox, spec: &Spec, stdin: impl Read + Send + 'static, stdout: &mut dyn Write, stderr: &mut dyn Write, status: &mut dyn FnMut(&Status)) -> i32 {
    let native = spec.native.as_str();
    let mut poller = Poller { failures: 0 };
    let mut report = Status { stage: "running".into(), ..Status::default() };
    let reconnecting = |report: &mut Status, status: &mut dyn FnMut(&Status), error: &str| {
        if report.stage != "reconnecting" {
            report.stage = "reconnecting".into();
            report.detail = Some(error.chars().take(200).collect());
            status(report);
        }
    };
    // Setup: a new run fails fast; an attach waits for the machine to answer.
    let (dir, skip) = loop {
        let prepared = home(sandbox, native).and_then(|home| {
            let dir = run_dir(&home, &spec.run_id);
            if !spec.attach {
                return start(sandbox, spec, &dir).map(|()| (dir, (0, 0)));
            }
            let (code, counts) = sandbox.exec(native, &format!("f={}/inbox; [ -f \"$f\" ] && printf '%s %s' $(wc -c < \"$f\") $(wc -l < \"$f\")", shell_quote(&dir)), Duration::from_secs(60))?;
            let counts: Vec<u64> = counts.split_whitespace().filter_map(|n| n.parse().ok()).collect();
            match (code, counts.as_slice()) {
                (Some(0), [bytes, lines]) => Ok((dir, (*bytes, *lines))),
                _ => Err("This cloud run is no longer on the machine.".into()),
            }
        });
        match prepared {
            Ok(ready) => break ready,
            Err(error) if !spec.attach || error.starts_with("This cloud run") => {
                let _ = writeln!(stderr, "{error}");
                return 1;
            }
            Err(error) => {
                reconnecting(&mut report, status, &error);
                std::thread::sleep(poller.backoff());
            }
        }
    };
    (report.inbox_bytes, report.inbox_lines) = skip;
    let mut skip = skip.0;
    report.stage = "running".into();
    report.detail = None;
    status(&report);
    let (local, remote) = (escaped(&spec.local_dir), escaped(&spec.remote_dir));
    let input = lines(stdin);
    let (out, err, exit) = (format!("{dir}/out"), format!("{dir}/err"), format!("{dir}/exit"));
    let mut pending: Vec<u8> = Vec::new();
    let mut partial: Vec<u8> = Vec::new();
    let (mut eof, mut eof_sent, mut err_offset, mut wait) = (false, false, 0u64, FAST);
    let mut exit_code: Option<i32> = None;
    let mut reported = Instant::now();
    loop {
        // Gather what PandaCode wrote, waking at once when it writes.
        let mut first = match input.recv_timeout(if pending.is_empty() { wait } else { Duration::ZERO }) {
            Ok(line) => Some(line),
            Err(RecvTimeoutError::Timeout) => None,
            Err(RecvTimeoutError::Disconnected) => Some(None),
        };
        while let Some(line) = first.take().or_else(|| input.try_recv().ok()) {
            match line {
                None => eof = true,
                // A replayed protocol writes what the inbox already holds: skip those bytes.
                Some(line) => {
                    let line = replace(line, &local, &remote);
                    let already = skip.min(line.len() as u64) as usize;
                    skip -= already as u64;
                    pending.extend_from_slice(&line[already..]);
                }
            }
        }
        let result = (|| -> crate::Result<bool> {
            let mut active = false;
            if !pending.is_empty() {
                // In order, whole lines when they fit; a failed append is retried (and
                // skipped by the machine if it already landed) before anything newer.
                let cut = pending.iter().take(APPEND_MAX).rposition(|b| *b == b'\n').map_or(pending.len().min(APPEND_MAX), |i| i + 1);
                append(sandbox, native, &dir, report.inbox_bytes, &pending[..cut])?;
                report.inbox_bytes += cut as u64;
                report.inbox_lines += pending[..cut].iter().filter(|b| **b == b'\n').count() as u64;
                pending.drain(..cut);
                active = true;
            }
            // Stdin closed: the harness's input ends, and the bridge waits for its `exit`.
            if eof && pending.is_empty() && !eof_sent {
                sandbox.upload(native, &format!("{dir}/eof"), b"", false)?;
                eof_sent = true;
            }
            let bytes = sandbox.download(native, &out, report.offset, READ_MAX)?;
            if !bytes.is_empty() {
                report.offset += bytes.len() as u64;
                partial.extend(bytes);
                if let Some(end) = partial.iter().rposition(|b| *b == b'\n') {
                    let rest = partial.split_off(end + 1);
                    let _ = stdout.write_all(&replace(std::mem::replace(&mut partial, rest), &remote, &local));
                    let _ = stdout.flush();
                }
                return Ok(true);
            }
            let bytes = sandbox.download(native, &err, err_offset, 16 * 1024)?;
            if !bytes.is_empty() {
                err_offset += bytes.len() as u64;
                let _ = stderr.write_all(&bytes);
                active = true;
            }
            if exit_code.is_none() {
                let code = sandbox.download(native, &exit, 0, 32)?;
                // Read `out` once more after `exit` appears: it is written last.
                exit_code = String::from_utf8_lossy(&code).trim().parse().ok();
                return Ok(active || exit_code.is_some());
            }
            Ok(active)
        })();
        match result {
            Ok(active) => {
                poller.failures = 0;
                if report.stage != "running" {
                    report.stage = "running".into();
                    report.detail = None;
                    status(&report);
                    reported = Instant::now();
                }
                if let Some(code) = exit_code.filter(|_| !active) {
                    let _ = stdout.write_all(&replace(std::mem::take(&mut partial), &remote, &local));
                    let _ = stdout.flush();
                    status(&report);
                    return code;
                }
                wait = if active { FAST } else { (wait * 3 / 2).min(IDLE) };
            }
            Err(error) if error.starts_with(INBOX_MISMATCH) => {
                let _ = writeln!(stderr, "{error}");
                status(&report);
                return 1;
            }
            Err(error) => {
                reconnecting(&mut report, status, &error);
                wait = poller.backoff();
            }
        }
        if reported.elapsed() >= PROGRESS_EVERY {
            status(&report);
            reported = Instant::now();
        }
    }
}

/// `main` calls this first: true when this process was a bridge (and has finished).
pub fn handle() -> bool {
    let Some(path) = std::env::var_os(ENV) else { return false };
    let code = (|| -> crate::Result<i32> {
        let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let _ = std::fs::remove_file(&path);
        let spec: Spec = serde_json::from_str(&text).map_err(|e| e.to_string())?;
        if let Some(dir) = &spec.secrets {
            crate::secret_store::setup(dir);
        }
        let sandbox = crate::cloud::sandbox::connected(&spec.provider)?;
        let status_path = spec.status.clone();
        let mut status = move |status: &Status| {
            let temporary = status_path.with_extension("tmp");
            if std::fs::write(&temporary, serde_json::to_vec(status).unwrap_or_default()).is_ok() {
                let _ = std::fs::rename(&temporary, &status_path);
            }
        };
        Ok(run(&*sandbox, &spec, std::io::stdin(), &mut std::io::stdout(), &mut std::io::stderr(), &mut status))
    })();
    let code = code.unwrap_or_else(|error| {
        eprintln!("{error}");
        1
    });
    std::process::exit(code)
}

#[cfg(all(test, unix))]
pub(crate) mod tests {
    use super::*;
    use crate::cloud::Machine;
    use std::os::unix::process::CommandExt;
    use std::path::Path;
    use std::process::{Command, Stdio};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    /// A sandbox that is this computer, with HOME in a temp folder. `offline` makes every
    /// call fail, like a laptop without network.
    pub(crate) struct Local {
        pub home: PathBuf,
        pub offline: Arc<AtomicBool>,
    }
    impl Local {
        pub(crate) fn new() -> Self {
            let home = std::env::temp_dir().join(format!("pandacode-cloud-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&home).unwrap();
            Self { home: home.canonicalize().unwrap(), offline: Arc::new(AtomicBool::new(false)) }
        }
        fn shell(&self, command: &str) -> Command {
            let mut shell = Command::new("sh");
            shell.arg("-c").arg(command).env("HOME", &self.home);
            shell
        }
    }
    impl Drop for Local {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.home);
        }
    }
    impl Sandbox for Local {
        fn info(&self) -> crate::cloud::sandbox::Info {
            crate::cloud::sandbox::Info { persistent: true, max_unattended_minutes: 60 }
        }
        fn list(&self) -> crate::Result<Vec<Machine>> {
            Ok(Vec::new())
        }
        fn create(&self, _name: &str) -> crate::Result<Machine> {
            Err("no".into())
        }
        fn power(&self, _native: &str, _action: &str) -> crate::Result<()> {
            Ok(())
        }
        fn exec(&self, _native: &str, command: &str, _timeout: Duration) -> crate::Result<(Option<i32>, String)> {
            if self.offline.load(Ordering::SeqCst) {
                return Err("offline".into());
            }
            let output = self.shell(command).output().map_err(|e| e.to_string())?;
            Ok((output.status.code(), format!("{}{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr))))
        }
        fn keep_alive(&self, _native: &str, _minutes: u32) -> crate::Result<()> {
            Ok(())
        }
        // macOS has no `setsid` command: start the runner in its own process group instead.
        fn spawn(&self, _native: &str, command: &str) -> crate::Result<()> {
            let mut child = self.shell(command).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).process_group(0).spawn().map_err(|e| e.to_string())?;
            // Reaped like a real detached run, so a killed group really is gone.
            std::thread::spawn(move || child.wait());
            Ok(())
        }
    }

    /// The local sandbox, but the answer to the `lose`-th inbox append is lost after it ran,
    /// like a network drop between the machine and PandaCode.
    struct Lossy {
        local: Local,
        appends: std::sync::atomic::AtomicUsize,
        lose: usize,
    }
    impl Sandbox for Lossy {
        fn info(&self) -> crate::cloud::sandbox::Info {
            self.local.info()
        }
        fn list(&self) -> crate::Result<Vec<Machine>> {
            self.local.list()
        }
        fn create(&self, name: &str) -> crate::Result<Machine> {
            self.local.create(name)
        }
        fn power(&self, native: &str, action: &str) -> crate::Result<()> {
            self.local.power(native, action)
        }
        fn exec(&self, native: &str, command: &str, timeout: Duration) -> crate::Result<(Option<i32>, String)> {
            assert!(command.len() < crate::cloud::sandbox::COMMAND_MAX, "a {} byte command", command.len());
            let result = self.local.exec(native, command, timeout);
            if command.contains("inbox.part") && self.appends.fetch_add(1, Ordering::SeqCst) + 1 == self.lose {
                return Err("connection reset".into());
            }
            result
        }
        fn keep_alive(&self, native: &str, minutes: u32) -> crate::Result<()> {
            self.local.keep_alive(native, minutes)
        }
        fn spawn(&self, native: &str, command: &str) -> crate::Result<()> {
            self.local.spawn(native, command)
        }
    }

    /// A fake harness: answers each stdin line with a JSON line naming its working folder.
    fn harness(dir: &Path) -> String {
        let path = dir.join("harness.sh");
        std::fs::write(&path, "echo \"{\\\"cwd\\\":\\\"$(pwd)\\\",\\\"key\\\":\\\"$KEY\\\"}\"\nwhile read -r line; do echo \"{\\\"got\\\":$line}\"; done\necho bye >&2\nexit 3\n").unwrap();
        path.to_string_lossy().into_owned()
    }

    fn spec(local: &Local, run: &str) -> Spec {
        spec_with(local, run, harness(&local.home))
    }

    fn spec_with(local: &Local, run: &str, harness: String) -> Spec {
        let remote = local.home.join("pandacode/task");
        std::fs::create_dir_all(&remote).unwrap();
        Spec {
            provider: "local".into(),
            native: "m".into(),
            run_id: run.into(),
            remote_dir: remote.to_string_lossy().into_owned(),
            local_dir: "/Users/me/project".into(),
            program: "sh".into(),
            args: vec![harness],
            env: vec![("KEY".into(), "it's secret".into())],
            attach: false,
            status: PathBuf::new(),
            secrets: None,
        }
    }

    fn bridge(local: &Local, spec: &Spec, input: &'static [u8]) -> (i32, String, String, Vec<Status>) {
        let (mut out, mut err, mut statuses) = (Vec::new(), Vec::new(), Vec::new());
        let code = run(local, spec, input, &mut out, &mut err, &mut |s: &Status| statuses.push(s.clone()));
        (code, String::from_utf8(out).unwrap(), String::from_utf8(err).unwrap(), statuses)
    }

    /// Stdin that never closes until `release` is set, like a pipeline still running.
    struct Held(&'static [u8], Arc<AtomicBool>);
    impl Read for Held {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            if !self.0.is_empty() {
                let n = self.0.len().min(buf.len());
                buf[..n].copy_from_slice(&self.0[..n]);
                self.0 = &self.0[n..];
                return Ok(n);
            }
            while !self.1.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(20));
            }
            Ok(0)
        }
    }

    #[test]
    fn a_run_carries_stdin_out_err_and_exit_and_maps_the_checkout_path() {
        let local = Local::new();
        let spec = spec(&local, "r1");
        let (code, out, err, statuses) = bridge(&local, &spec, b"{\"cwd\":\"/Users/me/project/a\"}\n2\n");
        // Stdin closed: `eof` ends the harness's input; the bridge waits for its `exit`.
        assert_eq!(code, 3);
        assert_eq!(out, "{\"cwd\":\"/Users/me/project\",\"key\":\"it's secret\"}\n{\"got\":{\"cwd\":\"/Users/me/project/a\"}}\n{\"got\":2}\n");
        assert_eq!(err.trim(), "bye");
        let dir = run_dir(&local.home.to_string_lossy(), "r1");
        assert!(Path::new(&format!("{dir}/exit")).exists());
        let inbox = std::fs::read_to_string(format!("{dir}/inbox")).unwrap();
        assert_eq!(inbox, format!("{{\"cwd\":\"{}/a\"}}\n2\n", spec.remote_dir));
        assert!(Path::new(&format!("{dir}/eof")).exists());
        assert!(statuses.iter().all(|s| s.stage == "running"));
        // Attach: replays everything from 0, skips the inbox bytes already there, ends with the exit code.
        assert!(!Path::new(&format!("{dir}/cmd.sh")).exists(), "the command with keys removes itself");
        // The replayed protocol writes the same lines again while its stdin stays open.
        let attach = Spec { attach: true, ..spec.clone() };
        let release = Arc::new(AtomicBool::new(false));
        let (mut out, mut err, mut statuses) = (Vec::new(), Vec::new(), Vec::new());
        let code = run(&local, &attach, Held(b"{\"cwd\":\"/Users/me/project/a\"}\n2\n", release.clone()), &mut out, &mut err, &mut |s: &Status| statuses.push(s.clone()));
        release.store(true, Ordering::SeqCst);
        let (out, err) = (String::from_utf8(out).unwrap(), String::from_utf8(err).unwrap());
        assert_eq!(code, 3);
        assert_eq!(out, "{\"cwd\":\"/Users/me/project\",\"key\":\"it's secret\"}\n{\"got\":{\"cwd\":\"/Users/me/project/a\"}}\n{\"got\":2}\n");
        assert_eq!(err.trim(), "bye");
        assert_eq!(std::fs::read_to_string(format!("{dir}/inbox")).unwrap().lines().count(), 2, "nothing written twice");
        assert_eq!(statuses.last().unwrap().inbox_lines, 2);
    }

    #[test]
    fn a_held_run_streams_survives_an_outage_and_stops_on_kill() {
        let local = Local::new();
        let spec = spec(&local, "r2");
        let release = Arc::new(AtomicBool::new(false));
        let offline = local.offline.clone();
        let local = Arc::new(local);
        let (worker, held) = (local.clone(), Held(b"1\n", release.clone()));
        let thread = std::thread::spawn(move || {
            let (mut out, mut err, mut statuses) = (Vec::new(), Vec::new(), Vec::new());
            let code = run(&*worker, &spec, held, &mut out, &mut err, &mut |s: &Status| statuses.push(s.stage.clone()));
            (code, String::from_utf8(out).unwrap(), statuses)
        });
        std::thread::sleep(Duration::from_millis(1500));
        offline.store(true, Ordering::SeqCst);
        std::thread::sleep(Duration::from_millis(1500));
        offline.store(false, Ordering::SeqCst);
        std::thread::sleep(Duration::from_millis(500));
        kill(&*local, "m", "r2").unwrap();
        let (code, out, statuses) = thread.join().unwrap();
        release.store(true, Ordering::SeqCst);
        assert_eq!(code, 143);
        assert!(out.contains("{\"got\":1}"), "{out}");
        assert!(statuses.contains(&"reconnecting".to_string()), "{statuses:?}");
        assert_eq!(statuses.last().map(String::as_str), Some("running"));
        let dir = run_dir(&local.home.to_string_lossy(), "r2");
        let pid: i32 = std::fs::read_to_string(format!("{dir}/pid")).unwrap().trim().parse().unwrap();
        assert_ne!(unsafe { libc::kill(-pid, 0) }, 0, "the process group is gone");
    }

    #[test]
    fn command_scripts_quote_every_word_and_refuse_bad_names() {
        let spec = Spec { remote_dir: "/h/a b".into(), program: "/bin/claude".into(), args: vec!["-p".into(), "it's".into()], env: vec![("A_1".into(), "x y".into())], ..Spec::default() };
        assert_eq!(command_script(&spec).unwrap(), "rm -f -- \"$0\"\ncd '/h/a b' || exit 126\nexport A_1='x y'\nexec '/bin/claude' '-p' 'it'\\''s'\n");
        assert!(command_script(&Spec { env: vec![("A;B".into(), String::new())], ..spec.clone() }).is_err());
        assert!(command_script(&Spec { env: vec![("1A".into(), String::new())], ..spec }).is_err());
    }

    #[test]
    fn lost_append_answers_and_long_lines_never_duplicate_or_split_input() {
        let local = Local::new();
        let script = local.home.join("lengths.sh");
        std::fs::write(&script, "while read -r line; do echo \"{\\\"len\\\":${#line}}\"; done\n").unwrap();
        let spec = spec_with(&local, "r3", script.to_string_lossy().into_owned());
        // One line longer than two appends, then a short one; the second append's answer is lost.
        let mut input = vec![b'a'; 2 * APPEND_MAX + 100];
        input.extend_from_slice(b"\nx\n");
        let input: &'static [u8] = Box::leak(input.into_boxed_slice());
        let lossy = Lossy { local, appends: Default::default(), lose: 2 };
        let (mut out, mut err, mut statuses) = (Vec::new(), Vec::new(), Vec::new());
        let code = run(&lossy, &spec, input, &mut out, &mut err, &mut |s: &Status| statuses.push(s.clone()));
        assert_eq!(code, 0);
        let expected = format!("{{\"len\":{}}}\n{{\"len\":1}}\n", 2 * APPEND_MAX + 100);
        assert_eq!(String::from_utf8(out).unwrap(), expected);
        assert!(statuses.iter().any(|s| s.stage == "reconnecting"));
        let dir = run_dir(&lossy.local.home.to_string_lossy(), "r3");
        assert_eq!(std::fs::read(format!("{dir}/inbox")).unwrap(), input, "each byte exactly once");
        assert_eq!(statuses.last().unwrap().inbox_bytes, input.len() as u64);
        // A re-attach replaying the same writes adds nothing and reads the same output.
        let release = Arc::new(AtomicBool::new(false));
        let (mut out, mut err) = (Vec::new(), Vec::new());
        let code = run(&lossy.local, &Spec { attach: true, ..spec }, Held(input, release.clone()), &mut out, &mut err, &mut |_: &Status| {});
        release.store(true, Ordering::SeqCst);
        assert_eq!((code, String::from_utf8(out).unwrap()), (0, expected));
        assert_eq!(std::fs::read(format!("{dir}/inbox")).unwrap().len(), input.len());
    }

    #[test]
    fn finish_waits_for_exit_kills_a_run_that_would_not_end_and_knows_a_gone_run() {
        let local = Arc::new(Local::new());
        assert_eq!(finish(&*local, "m", "never-started", Duration::ZERO).unwrap(), None);
        let spec = spec(&local, "r4");
        let release = Arc::new(AtomicBool::new(false));
        let (worker, held) = (local.clone(), Held(b"1\n", release.clone()));
        let thread = std::thread::spawn(move || run(&*worker, &spec, held, &mut Vec::new(), &mut Vec::new(), &mut |_: &Status| {}));
        std::thread::sleep(Duration::from_millis(800));
        // The harness keeps waiting for input: after the grace period it is killed, confirmed dead.
        assert_eq!(finish(&*local, "m", "r4", Duration::from_secs(1)).unwrap(), Some(143));
        assert_eq!(thread.join().unwrap(), 143, "the bridge ends only once `exit` exists");
        release.store(true, Ordering::SeqCst);
        let dir = run_dir(&local.home.to_string_lossy(), "r4");
        let pid: i32 = std::fs::read_to_string(format!("{dir}/pid")).unwrap().trim().parse().unwrap();
        assert_ne!(unsafe { libc::kill(-pid, 0) }, 0);
        // Finished runs answer at once with their code.
        assert_eq!(finish(&*local, "m", "r4", Duration::ZERO).unwrap(), Some(143));
    }
}
