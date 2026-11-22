//! Running a tool: arguments reach the script only as `PC_<NAME>` environment variables, the
//! script runs with `sh -c` in the task's checkout in its own process group (or Windows Job
//! Object, so Stop and the timeout end everything it started), and the reply keeps the tail
//! of each stream.
use super::{Param, Tool};
use serde_json::{json, Map, Value};
use std::{
    io::Read,
    path::Path,
    process::{Child, Command, ExitStatus, Stdio},
    thread,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    time::{Duration, Instant},
};

/// Bytes of each stream an agent gets back: the end, where errors are.
pub(super) const KEEP: usize = 16 * 1024;
/// How long a stopped script gets between SIGTERM and SIGKILL.
#[cfg(unix)]
const GRACE: Duration = Duration::from_millis(500);
/// How long the output readers get, once the script has ended, for their pipes to close.
const READ_WAIT: Duration = Duration::from_secs(1);
/// Harnesses end a tool call at about 60 s and the host at 60 s, so a run stops before that
/// whatever its `timeoutSecs`.
pub(super) const HOST_LIMIT_SECS: u64 = 50;
/// Bytes per arg value: at most `approval::ARG_PREVIEW` characters, so the approval shows
/// every value in full.
pub(super) const MAX_ARG: usize = 1000;
const FIX: &str = "save a corrected version with pandacode_tool_save (same name)";

/// The environment name of a param.
pub(super) fn env_name(param: &str) -> String {
    format!("PC_{}", param.to_ascii_uppercase())
}

/// Every param value as `(PC_NAME, value)`, unset optional params as empty strings so
/// `set -u` scripts work. All problems in one error.
pub(super) fn environment(params: &[Param], args: &Value) -> Result<Vec<(String, String)>, String> {
    let empty = Map::new();
    let given = match args {
        Value::Null => &empty,
        Value::Object(map) => map,
        _ => return Err("args must be an object of strings.".into()),
    };
    let mut problems = Vec::new();
    for (key, value) in given {
        if !params.iter().any(|param| &param.name == key) {
            problems.push(format!("unknown param {key}"));
        } else if !value.as_str().is_some_and(|text| text.len() <= MAX_ARG && !text.contains('\0')) {
            problems.push(format!("{key} must be a string of at most {MAX_ARG} bytes"));
        }
    }
    for param in params.iter().filter(|param| param.required && !given.contains_key(&param.name)) {
        problems.push(format!("missing required param {}", param.name));
    }
    if !problems.is_empty() {
        let expected: Vec<String> = params.iter().map(|p| if p.required { p.name.clone() } else { format!("{}?", p.name) }).collect();
        return Err(format!("{}. Params: {}.", problems.join("; "), if expected.is_empty() { "none".into() } else { expected.join(", ") }));
    }
    Ok(params.iter().map(|param| (env_name(&param.name), given.get(&param.name).and_then(Value::as_str).unwrap_or_default().to_owned())).collect())
}

/// The last `limit` bytes of `bytes`, starting on a character boundary.
pub(super) fn tail(bytes: &[u8], limit: usize) -> (String, bool) {
    let text = String::from_utf8_lossy(bytes);
    if text.len() <= limit {
        return (text.into_owned(), false);
    }
    let mut start = text.len() - limit;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    (text[start..].to_owned(), true)
}

/// The finished run: the reply and the exit code for stats (`None`: it never finished), and
/// whether it was cut at its timeout (counted in the stats as a failed use).
pub(super) struct Outcome {
    pub reply: Result<Value, String>,
    pub exit: Option<i32>,
    pub timed_out: bool,
}

/// What a reader has kept so far: the last bytes of a pipe, and whether more came before.
type Kept = Arc<Mutex<(Vec<u8>, bool)>>;

/// Keeps the last `KEEP` bytes a pipe writes; the receiver hears when the pipe closed.
fn read_tail(mut pipe: impl Read + Send + 'static) -> (Kept, mpsc::Receiver<()>) {
    let kept: Kept = Arc::default();
    let (done, closed) = mpsc::channel();
    let sink = kept.clone();
    thread::spawn(move || {
        let mut buffer = [0; 8192];
        while let Ok(size) = pipe.read(&mut buffer) {
            if size == 0 {
                break;
            }
            let mut kept = sink.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            kept.0.extend_from_slice(&buffer[..size]);
            if kept.0.len() > 2 * KEEP {
                let cut = kept.0.len() - KEEP;
                kept.0.drain(..cut);
                kept.1 = true;
            }
        }
        let _ = done.send(());
    });
    (kept, closed)
}

/// What both readers kept, waiting at most `READ_WAIT` in all for their pipes to close. A
/// process that left the group (`setsid`) can hold a pipe open for as long as it lives; its
/// reader is then left behind, blocked on that pipe alone.
fn collect(readers: [(Kept, mpsc::Receiver<()>); 2]) -> [(Vec<u8>, bool); 2] {
    let until = Instant::now() + READ_WAIT;
    readers.map(|(kept, closed)| {
        let _ = closed.recv_timeout(until.saturating_duration_since(Instant::now()));
        std::mem::take(&mut *kept.lock().unwrap_or_else(|poisoned| poisoned.into_inner()))
    })
}

/// Whether the shell has exited, without reaping it on unix: until `stop` reaps it, its PID
/// (the group's ID) cannot be reused, so the group signals reach only this script's processes.
fn exited(child: &mut Child) -> bool {
    #[cfg(unix)]
    {
        // SAFETY: a zeroed siginfo_t is valid; WNOWAIT leaves the child to `Child::wait`.
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        let flags = libc::WEXITED | libc::WNOHANG | libc::WNOWAIT;
        let found = unsafe { libc::waitid(libc::P_PID, child.id() as libc::id_t, &mut info, flags) };
        found != 0 || unsafe { info.si_pid() } != 0
    }
    #[cfg(not(unix))]
    !matches!(child.try_wait(), Ok(None))
}

/// A spawned shell and, on Windows, the Job Object owning its process tree.
struct Run {
    child: Child,
    #[cfg(windows)]
    job: Option<crate::providers::windows_job::Job>,
}

/// Ends the script and everything it started, then reaps it: on unix its process group gets
/// SIGTERM, then SIGKILL after `GRACE` (at once when the shell has already exited); on Windows
/// its Job Object is closed (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`) to end the entire process
/// tree (falling back to `kill_group` if attaching the job failed) before killing and reaping
/// the shell.
fn stop(run: &mut Run) -> Option<ExitStatus> {
    #[cfg(unix)]
    {
        let group = -(run.child.id() as i32);
        // SAFETY: signals only the group made for this script (`process_group(0)`), whose
        // leader is not reaped yet.
        unsafe { libc::kill(group, libc::SIGTERM) };
        let until = Instant::now() + GRACE;
        while Instant::now() < until && !exited(&mut run.child) {
            thread::sleep(Duration::from_millis(10));
        }
        unsafe { libc::kill(group, libc::SIGKILL) };
    }
    #[cfg(windows)]
    {
        let job = run.job.take();
        let attached = job.is_some();
        drop(job);
        if !attached {
            crate::providers::kill_group(run.child.id());
        }
        let _ = run.child.kill();
    }
    #[cfg(not(any(unix, windows)))]
    let _ = run.child.kill();
    run.child.wait().ok()
}

/// How a run ended before the script exited on its own.
enum Cut {
    Stopped,
    TimedOut,
}

/// Waits for the shell to exit, cutting it on `stopped` or at `deadline`.
fn wait(child: &mut Child, deadline: Instant, stopped: &AtomicBool) -> Result<(), Cut> {
    while !exited(child) {
        if stopped.load(Ordering::SeqCst) {
            return Err(Cut::Stopped);
        }
        if Instant::now() >= deadline {
            return Err(Cut::TimedOut);
        }
        thread::sleep(Duration::from_millis(10));
    }
    Ok(())
}

fn start(mut command: Command) -> std::io::Result<Run> {
    crate::child_env::sanitize(&mut command);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        let (child, job) = crate::providers::windows_job::Job::spawn(&mut command)?;
        Ok(Run { child, job })
    }
    #[cfg(not(windows))]
    Ok(Run { child: command.spawn()? })
}

fn spawn(root: &Path, tool: &Tool, env: Vec<(String, String)>) -> std::io::Result<Run> {
    let mut command = Command::new("sh");
    command
        .arg("-c")
        .arg(&tool.script)
        .current_dir(root)
        .envs(env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    start(command)
}

/// A timeout is no script bug: it says which limit the run hit and what to do instead.
pub(super) fn timeout_message(name: &str, seconds: u64) -> String {
    if seconds >= HOST_LIMIT_SECS {
        format!("{name} timed out: it hit the {HOST_LIMIT_SECS} s cap on a tool run and was stopped. Split longer work into steps or run it directly.")
    } else {
        format!("{name} timed out after {seconds} s (its timeoutSecs) and was stopped. Save it with a longer timeoutSecs (at most {HOST_LIMIT_SECS}), split the work, or run it directly.")
    }
}

/// Runs `tool` in `root`, blocking until it exits, times out or `stopped` is set.
pub(super) fn execute(root: &Path, tool: &Tool, args: &Value, stopped: &AtomicBool) -> Outcome {
    let failed = |reply: String| Outcome { reply: Err(reply), exit: None, timed_out: false };
    let env = match environment(&tool.params, args) {
        Ok(env) => env,
        Err(error) => return failed(error),
    };
    let seconds = tool.timeout_secs.min(HOST_LIMIT_SECS);
    let started = Instant::now();
    let mut run = match spawn(root, tool, env) {
        Ok(run) => run,
        Err(error) => return failed(format!("Could not start {}: {error}", tool.name)),
    };
    let (Some(out), Some(err)) = (run.child.stdout.take(), run.child.stderr.take()) else {
        let _ = stop(&mut run);
        return failed("Could not read the script's output.".into());
    };
    let readers = [read_tail(out), read_tail(err)];
    let ended = wait(&mut run.child, started + Duration::from_secs(seconds), stopped);
    // A tool is one-shot: background jobs it left behind are ended with it, so they cannot
    // hold its output pipes open (or outlive the task) after the shell exits.
    let status = stop(&mut run);
    let [(stdout, dropped_out), (stderr, dropped_err)] = collect(readers);
    let status = match (ended, status) {
        (Ok(()), Some(status)) => status,
        (Ok(()), None) => return failed(format!("Could not read how {} ended.", tool.name)),
        (Err(Cut::Stopped), _) => return failed("Task has stopped.".into()),
        (Err(Cut::TimedOut), _) => return Outcome { timed_out: true, ..failed(timeout_message(&tool.name, seconds)) },
    };
    // A script ended by a signal has no code: -1, so the agent and the trace see a failure.
    let exit = status.code().unwrap_or(-1);
    let (stdout, cut_out) = tail(&stdout, KEEP);
    let (stderr, cut_err) = tail(&stderr, KEEP);
    let mut reply = json!({
        "tool": tool.name, "version": tool.version, "exit": exit,
        "ms": started.elapsed().as_millis() as u64,
        "stdout": stdout, "stderr": stderr,
        "truncated": cut_out || cut_err || dropped_out || dropped_err,
    });
    if exit != 0 {
        reply["fix"] = json!(FIX);
    }
    Outcome { reply: Ok(reply), exit: Some(exit), timed_out: false }
}

/// `execute` on a blocking thread; `stopped` ends the script within about `GRACE`.
pub(super) async fn execute_async(root: std::path::PathBuf, tool: Tool, args: Value, stopped: Arc<AtomicBool>) -> Outcome {
    tauri::async_runtime::spawn_blocking(move || execute(&root, &tool, &args, &stopped))
        .await
        .unwrap_or_else(|error| Outcome { reply: Err(error.to_string()), exit: None, timed_out: false })
}

/// How long `sh -n` gets in all, streams included. It runs nothing, so it starts no process
/// that could hold its pipes open: its own exit closes them, however slowly a busy machine
/// schedules the readers (`workspace::run_process` gives them only 1 s after the exit).
const SYNTAX_LIMIT: Duration = Duration::from_secs(10);

/// `sh -n`: refuses a script that does not parse, with the shell's message.
pub(super) fn syntax_check(script: &str) -> Result<(), String> {
    let mut command = Command::new("sh");
    command
        .arg("-n")
        .arg("-c")
        .arg(script)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let mut run = start(command).map_err(|error| format!("Could not start sh: {error}"))?;
    let Some(err) = run.child.stderr.take() else {
        let _ = stop(&mut run);
        return Err("Could not read the syntax check's output.".into());
    };
    let (kept, closed) = read_tail(err);
    let deadline = Instant::now() + SYNTAX_LIMIT;
    let ended = wait(&mut run.child, deadline, &AtomicBool::new(false));
    let status = stop(&mut run);
    if ended.is_err() {
        return Err("The syntax check timed out.".into());
    }
    let status = status.ok_or("Could not read how the syntax check ended.")?;
    if status.success() {
        return Ok(());
    }
    // A failed check needs its message: wait for the pipe to close, within the same limit.
    let _ = closed.recv_timeout(deadline.saturating_duration_since(Instant::now()));
    let stderr = std::mem::take(&mut *kept.lock().unwrap_or_else(|poisoned| poisoned.into_inner()));
    let (message, _) = tail(&stderr.0, 8 * 1024);
    Err(format!("The script has a syntax error: {}", message.trim()))
}
