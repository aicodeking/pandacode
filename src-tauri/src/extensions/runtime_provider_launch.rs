//! Declared ACP harnesses of trusted packages (`contributes.providers[].launch`, runtime phase R8, slice R0801).
//!
//! A provider that declares `"launch": { "protocol": "acp", "command": [...], "env": {...} }` names an executable and
//! a protocol and carries no adapter code. The host starts the command when a task sends (never for discovery, a
//! model list or a draft) and speaks ACP over its stdio: `initialize`, `session/new` or a resume, `session/prompt`,
//! `session/update` notifications, `session/request_permission` and `session/cancel`. Everything the harness says is
//! translated into the same bounded core conversation events a handler provider uses (`dynamic_harness::Conversation`),
//! so identity, pending approvals and cancellation stay owned by core.
//!
//! * `command` is an argument list, never a shell string. Placeholders: `{node}` (the packaged Node runtime),
//!   `{package}` (the package's code folder: it exists once `runtime.files` is materialized, runtime slice R0105; until
//!   then it is an explicit readiness error) and `{data}` (the package's data directory, created on first use).
//! * Readiness is explicit and recomputed at every read: a missing or unsupported protocol, an executable that cannot
//!   be found, an unresolved placeholder and a package whose executable content is not trusted each give one error
//!   string that the model picker and the send path show unchanged.
//! * All runs of one package share one `State`: one token manager that issues a token per run, counts handshakes and
//!   active runs, and records readiness transitions. Two concurrent conversations see the same state, never two.
//! * A credential PandaCode holds is never placed in the launched program's environment (ADR-0006): the environment
//!   is the app's own plus the manifest's fixed `env` text.
use crate::providers::RunInput;
use serde_json::{json, Value};
use std::{collections::BTreeMap, path::{Path, PathBuf}, process::Stdio, sync::{Arc, Mutex, OnceLock, atomic::{AtomicBool, Ordering}}, time::Duration};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

/// The ACP protocol version the host speaks (`initialize.protocolVersion`).
const ACP_VERSION: u64 = 1;
/// Longest stdout frame the host accepts from a launched harness.
const MAX_LINE: usize = 1 << 20;
/// Longest text delta forwarded as one core event (core refuses larger events).
const CHUNK: usize = 8_000;
const STARTUP: Duration = Duration::from_secs(60);
const STOP_GRACE: Duration = Duration::from_secs(3);

/// The fully resolved command of a declared harness.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Resolved { pub program: PathBuf, pub arguments: Vec<String>, pub env: BTreeMap<String, String> }

/// Where placeholders resolve. `None` leaves the placeholder an explicit readiness error.
#[derive(Clone, Default)]
pub(crate) struct Places { pub node: Option<PathBuf>, pub package: Option<PathBuf>, pub data: Option<PathBuf> }

/// The declared launch of a provider definition, when it has one.
pub(crate) fn declared(definition: &Value) -> Option<&Value> { definition.get("launch").filter(|launch| launch.is_object()) }

fn substitute(text: &str, places: &Places) -> Result<String, String> {
    let mut out = String::new();
    let mut rest = text;
    while let Some(start) = rest.find('{') {
        out.push_str(&rest[..start]);
        let Some(end) = rest[start..].find('}') else { return Err(format!("InvalidShape: unclosed placeholder in {text:?}")); };
        let name = &rest[start + 1..start + end];
        let value = match name {
            "node" => places.node.as_ref().ok_or("UnsupportedRuntime: this target's trusted Node runtime is not qualified, so {node} cannot be resolved")?,
            "package" => places.package.as_ref().ok_or("UnsupportedRuntime: {package} needs the package's code folder (runtime.files), which is not available")?,
            "data" => places.data.as_ref().ok_or("UnsupportedRuntime: {data} needs the package's data directory, which is not available")?,
            other => return Err(format!("InvalidShape: unknown placeholder {{{other}}}")),
        };
        out.push_str(&value.to_string_lossy());
        rest = &rest[start + end + 1..];
    }
    out.push_str(rest);
    Ok(out)
}

/// Resolves and checks the declared command: protocol, argument shape, placeholders and the executable itself.
pub(crate) fn resolve(launch: &Value, places: &Places) -> Result<Resolved, String> {
    match launch["protocol"].as_str() {
        Some("acp") => {}
        Some(other) => return Err(format!("UnsupportedCapability: launch protocol {other:?} is not supported; the only protocol is \"acp\".")),
        None => return Err("InvalidShape: the provider's launch declares no protocol.".into()),
    }
    let command: Vec<&str> = launch["command"].as_array().map(|items| items.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
    if command.is_empty() || command.len() > 32 || command.len() != launch["command"].as_array().map_or(0, Vec::len) || command.iter().any(|item| item.len() > 1024) {
        return Err("InvalidShape: the provider's launch command must be 1 to 32 strings of at most 1,024 characters.".into());
    }
    let mut parts = command.iter().map(|item| substitute(item, places)).collect::<Result<Vec<_>, _>>()?;
    let program = parts.remove(0);
    if program.is_empty() { return Err("InvalidShape: the launch command names no executable.".into()); }
    let path = PathBuf::from(&program);
    let program = if path.components().count() > 1 || path.is_absolute() {
        if path.is_file() { path } else { return Err(format!("ExecutableMissing: the declared harness executable was not found at {program}.")); }
    } else {
        crate::providers::tool_path(&program).ok_or_else(|| format!("ExecutableMissing: the declared harness executable {program:?} is not installed or is not on PATH."))?
    };
    let mut env = BTreeMap::new();
    for (name, value) in launch["env"].as_object().into_iter().flatten() {
        if name.is_empty() || name.contains(['=', '\0']) { return Err("InvalidShape: an environment name of the launch is invalid.".into()); }
        env.insert(name.clone(), substitute(value.as_str().ok_or("InvalidShape: an environment value of the launch is not text.")?, places)?);
    }
    Ok(Resolved { program, arguments: parts, env })
}

/// The one shared state of a package's launched runs.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct State {
    /// Whether the package also declares a background service (`runtime.service`); its runs join that one lifetime.
    pub service: bool,
    pub tokens_issued: u64,
    pub handshakes: u64,
    pub active: u64,
    pub peak: u64,
    pub finished: u64,
    /// Readiness states in the order they were observed, consecutive duplicates collapsed.
    pub readiness: Vec<String>,
    pub last_error: Option<String>,
    /// Every process started for this package, by a send or as a warm spare (R0807).
    pub spawns: u64,
    /// Warm spares of an opted-in package (R0807): started ahead, adopted by a send, discarded unused, failed to start.
    pub warm_started: u64,
    pub warm_adopted: u64,
    pub warm_discarded: u64,
    pub warm_failed: u64,
}
type Shared = Arc<Mutex<State>>;
fn registry() -> &'static Mutex<BTreeMap<String, Shared>> {
    static STATES: OnceLock<Mutex<BTreeMap<String, Shared>>> = OnceLock::new();
    STATES.get_or_init(Default::default)
}
/// The package's single state, created on first use.
pub(crate) fn shared(owner: &str) -> Shared {
    registry().lock().unwrap_or_else(|poisoned| poisoned.into_inner()).entry(owner.to_owned()).or_default().clone()
}
/// A copy of the package's state (the one state every run and every warm spare of the package shares).
pub(crate) fn current(owner: &str) -> State { with(&shared(owner), |state| state.clone()) }
/// Changes the package's one state; the closure must be short and must not wait.
pub(crate) fn update(owner: &str, change: impl FnOnce(&mut State)) { with(&shared(owner), change); }
/// Records whether the package also declares a background service (`runtime.service`).
pub(crate) fn mark_service(owner: &str, service: bool) { with(&shared(owner), |state| state.service = service); }
/// A copy of the package's state, and how many states exist for it (always one once used).
#[cfg(test)]
pub(crate) fn snapshot(owner: &str) -> State {
    registry().lock().unwrap_or_else(|poisoned| poisoned.into_inner()).get(owner).map(|state| state.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone()).unwrap_or_default()
}
/// Drops a package's state (uninstall, tests).
#[cfg(test)]
pub(crate) fn forget(owner: &str) { registry().lock().unwrap_or_else(|poisoned| poisoned.into_inner()).remove(owner); }
fn with<T>(state: &Shared, change: impl FnOnce(&mut State) -> T) -> T { change(&mut state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())) }
fn observe(state: &Shared, readiness: &str, error: Option<&str>) {
    with(state, |state| {
        if state.readiness.last().map(String::as_str) != Some(readiness) { state.readiness.push(readiness.into()); }
        state.last_error = error.map(str::to_owned);
    });
}

/// The readiness the model picker and the send path report for a declared harness: the manifest's own metadata with
/// `readiness` replaced by what can be resolved right now. A manifest that is not ready stays as it declared.
pub(crate) fn overlay(owner: &str, definition: &Value, mut metadata: Value, places: &Places) -> Value {
    let Some(launch) = declared(definition) else { return metadata };
    let state = shared(owner);
    if metadata["readiness"]["state"] != "ready" { observe(&state, metadata["readiness"]["state"].as_str().unwrap_or("unavailable"), None); return metadata; }
    match resolve(launch, places) {
        Ok(_) => observe(&state, "ready", None),
        Err(reason) => {
            observe(&state, "unavailable", Some(&reason));
            metadata["readiness"] = json!({"state":"unavailable","reason":reason});
        }
    }
    metadata
}

/// What the installed package says about one of its launch providers.
#[derive(Clone, Debug)]
pub(crate) struct Facts {
    /// The package's executable content is trusted (a launch provider is code the computer runs).
    pub trusted: bool,
    /// The package also declares a background service.
    pub service: bool,
    /// The package's data directory (`{data}`), created when missing.
    pub data: Option<PathBuf>,
    /// The package's code folder (`{package}`), when it is materialized.
    pub package: Option<PathBuf>,
}
/// Facts of `provider` (a launch provider of `owner`), `None` when the package or the declaration does not exist.
pub(crate) fn facts(packages: &super::packages::Packages, owner: &str, provider: &str) -> Option<Facts> {
    let snapshot = serde_json::to_value(packages.snapshot()).ok()?;
    let package = snapshot["packages"].as_array()?.iter().find(|package| package["manifest"]["id"] == owner)?;
    package["manifest"]["contributes"]["providers"].as_array()?.iter().find(|entry| entry["id"] == provider && entry.get("launch").is_some())?;
    Some(Facts {
        trusted: package["executable"]["trusted"] == true,
        service: super::runtime_service_lifetime::declares_service(&package["manifest"]),
        data: packages.launch_data_directory(owner).ok(),
        // The package's code folder joins here once `runtime.files` is materialized (slice R0105).
        package: None,
    })
}

/// The installed packages as JSON (the same snapshot the grants and the manager read), without waiting for the package
/// lock: a busy lock is `HostUnavailable`. Used by the warm-spare opt-in (R0807), which lives outside `extensions`.
pub(crate) fn package_snapshot(app: &tauri::AppHandle) -> Result<Value, String> {
    use tauri::Manager;
    let packages = app.state::<super::packages::ExtensionPackages>();
    let packages = packages.0.try_lock().map_err(|_| "HostUnavailable".to_owned())?;
    serde_json::to_value(packages.snapshot()).map_err(|_| "MalformedData".to_owned())
}

/// The explicit readiness error of an installed launch provider whose executable content is not trusted.
pub(crate) const TRUST_REQUIRED: &str = "ExecutableTrustRequired: review this version and its executable content in Settings → Extensions before this harness can run.";

struct Run { state: Shared }
impl Run {
    fn begin(state: Shared) -> (Self, u64) {
        let token = with(&state, |state| {
            state.tokens_issued += 1;
            state.active += 1;
            state.peak = state.peak.max(state.active);
            state.tokens_issued
        });
        (Self { state }, token)
    }
}
impl Drop for Run {
    fn drop(&mut self) { with(&self.state, |state| { state.active = state.active.saturating_sub(1); state.finished += 1; }); }
}

fn chunks(text: &str) -> impl Iterator<Item = String> + '_ {
    let mut chars = text.chars().peekable();
    std::iter::from_fn(move || {
        chars.peek()?;
        Some(chars.by_ref().take(CHUNK).collect())
    })
}

fn rpc_error(frame: &Value, stage: &str) -> String {
    let message = frame["error"]["message"].as_str().unwrap_or("no message");
    format!("{stage} failed: {}", message.chars().take(300).collect::<String>())
}

fn tool_event(update: &Value) -> Option<Value> {
    let id = update["toolCallId"].as_str()?;
    let status = match update["status"].as_str() {
        Some("completed") => "completed",
        Some("failed") => "failed",
        _ if update["sessionUpdate"] == "tool_call_update" => "running",
        _ => "running",
    };
    let name = update["title"].as_str().or_else(|| update["kind"].as_str()).unwrap_or("tool");
    let preview = |value: &Value| -> String {
        let text = match value { Value::Null => String::new(), Value::String(text) => text.clone(), other => other.to_string() };
        text.chars().take(2_000).collect()
    };
    let output = update["content"].as_array().map(|items| items.iter().filter_map(|item| item["content"]["text"].as_str().or_else(|| item["text"].as_str())).collect::<Vec<_>>().join("\n")).unwrap_or_default();
    Some(json!({"kind":"tool","tool":{"id":id.chars().take(200).collect::<String>(),"name":name.chars().take(200).collect::<String>(),"status":status,"input":preview(&update["rawInput"]),"output":if output.is_empty() { preview(&update["rawOutput"]) } else { output.chars().take(2_000).collect() }}}))
}

/// Maps one `session/update` onto core events. Unknown kinds are ignored, as built-in ACP harnesses do.
fn update_events(update: &Value) -> Vec<Value> {
    match update["sessionUpdate"].as_str() {
        Some("agent_message_chunk") => update["content"]["text"].as_str().map(|text| chunks(text).map(|text| json!({"kind":"text","text":text})).collect()).unwrap_or_default(),
        Some("agent_thought_chunk") => update["content"]["text"].as_str().map(|text| chunks(text).map(|text| json!({"kind":"thinking","text":text})).collect()).unwrap_or_default(),
        Some("tool_call" | "tool_call_update") => tool_event(update).into_iter().collect(),
        Some("usage_update") => match update["used"].as_u64() {
            Some(used) => vec![json!({"kind":"usage","usedTokens":used,"contextWindow":update["size"].as_u64().filter(|size| *size > 0)})],
            None => vec![],
        },
        _ => vec![],
    }
}

fn permission_choice<'a>(options: &'a [Value], approved: bool) -> Option<&'a Value> {
    let (wanted, fallback) = if approved { ("allow_once", "allow_always") } else { ("reject_once", "reject_always") };
    options.iter().find(|option| option["kind"] == wanted).or_else(|| options.iter().find(|option| option["kind"] == fallback))
}

/// Whether a `session/request_permission` is a structured question rather than a tool approval: more than one allow
/// option, or answer ids of the `q<N>_opt_<M>` form (the rule of the built-in ACP harnesses in `providers.rs`).
pub(crate) fn structured_question(request: &Value) -> bool {
    let options = request["params"]["options"].as_array().map(Vec::as_slice).unwrap_or_default();
    options.iter().filter(|option| option["kind"] == "allow_once").count() > 1
        || options.iter().any(|option| option["optionId"].as_str().and_then(|id| id.strip_prefix('q')).and_then(|id| id.split_once("_opt_")).is_some_and(|(number, _)| number.parse::<usize>().is_ok()))
}

/// A started harness process with its pipes: what a send owns while it talks, and what a warm spare (R0807) holds
/// after `initialize` until a send adopts it.
pub(crate) struct Started {
    child: tokio::process::Child,
    stdin: tokio::process::ChildStdin,
    stdout: BufReader<tokio::process::ChildStdout>,
    stderr_task: tokio::task::JoinHandle<()>,
    diagnostics: Arc<Mutex<String>>,
}
impl Started {
    /// Whether the process is still running (a warm spare that exited is never adopted).
    pub(crate) fn alive(&mut self) -> bool { matches!(self.child.try_wait(), Ok(None)) }
    /// The operating-system process id (tests end a spare with it).
    #[allow(dead_code)]
    pub(crate) fn pid(&self) -> Option<u32> { self.child.id() }
    /// Ends the process: stdin EOF, a bounded wait, then a kill. Never called with a lock held.
    pub(crate) async fn end(self) {
        let Started { mut child, stdin, stderr_task, .. } = self;
        drop(stdin);
        let waited = tokio::time::timeout(STOP_GRACE, child.wait()).await;
        if waited.is_err() { let _ = child.kill().await; let _ = child.wait().await; }
        let _ = stderr_task.await;
    }
}

/// Starts the resolved command with piped stdio (a hidden window on Windows). The environment is the app's own plus
/// the manifest's fixed `env`; no held credential is placed in it (ADR-0006).
pub(crate) fn spawn_process(owner: &str, resolved: &Resolved, cwd: &Path) -> Result<Started, String> {
    let state = shared(owner);
    let mut command = tokio::process::Command::new(&resolved.program);
    command.args(&resolved.arguments).current_dir(cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    for (name, value) in &resolved.env { command.env(name, value); }
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command.spawn().map_err(|error| { observe(&state, "unavailable", Some("spawn")); format!("ExecutableMissing: the declared harness could not start ({})", error.kind()) })?;
    with(&state, |state| state.spawns += 1);
    #[cfg(windows)]
    if let Some(pid) = child.id() { crate::providers::windows_job::register(pid); }
    let stdin = child.stdin.take().ok_or("HostUnavailable")?;
    let stdout = BufReader::new(child.stdout.take().ok_or("HostUnavailable")?);
    let mut stderr = child.stderr.take().ok_or("HostUnavailable")?;
    let diagnostics = Arc::new(Mutex::new(String::new()));
    let drain = diagnostics.clone();
    let stderr_task = tokio::spawn(async move {
        let mut buffer = [0u8; 4096];
        while let Ok(count) = stderr.read(&mut buffer).await {
            if count == 0 { break; }
            let mut text = drain.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            if text.len() < 4096 { text.push_str(&String::from_utf8_lossy(&buffer[..count])); }
        }
    });
    Ok(Started { child, stdin, stdout, stderr_task, diagnostics })
}

fn frame_bytes(value: &Value) -> Vec<u8> {
    let mut line = serde_json::to_vec(value).unwrap_or_default();
    line.push(b'\n');
    line
}
fn initialize_frame() -> Value { json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":ACP_VERSION,"clientCapabilities":{}}}) }

/// Starts the command and completes `initialize` within `limit`: a warm spare (runtime slice R0807). The reply is kept
/// for the send that adopts the process, which replays it instead of sending `initialize` again. Nothing here holds a
/// lock; the caller owns the process.
pub(crate) async fn start_initialized(owner: &str, resolved: &Resolved, cwd: &Path, limit: Duration) -> Result<(Started, Value), String> {
    let mut started = spawn_process(owner, resolved, cwd)?;
    let outcome = tokio::time::timeout(limit, async {
        started.stdin.write_all(&frame_bytes(&initialize_frame())).await.map_err(|_| "HostUnavailable".to_owned())?;
        let mut line = Vec::new();
        loop {
            line.clear();
            match started.stdout.read_until(b'\n', &mut line).await {
                Ok(0) | Err(_) => return Err("The declared harness exited before it answered initialize.".to_owned()),
                Ok(_) => {
                    if line.len() > MAX_LINE { return Err("LimitExceeded: a harness frame was too large.".to_owned()); }
                    let Ok(frame) = serde_json::from_slice::<Value>(&line) else { continue };
                    if frame["id"] == 1 && frame.get("method").is_none() {
                        if frame.get("error").is_some() { return Err(rpc_error(&frame, "initialize")); }
                        if frame["result"]["protocolVersion"] != ACP_VERSION { return Err("This harness does not support ACP protocol v1.".to_owned()); }
                        return Ok(frame);
                    }
                }
            }
        }
    }).await;
    match outcome {
        Ok(Ok(reply)) => Ok((started, reply)),
        Ok(Err(error)) => { started.end().await; Err(error) }
        Err(_) => { started.end().await; Err("Agent initialization timed out: the declared harness did not answer initialize.".into()) }
    }
}

/// Starts the declared command and speaks ACP until the prompt completes, fails or is stopped.
/// `event` and `input` are the core conversation's (see `dynamic_harness::Conversation`).
#[allow(clippy::too_many_arguments)]
pub(crate) async fn drive(
    owner: &str,
    resolved: Resolved,
    cwd: &Path,
    prompt: &str,
    resume_id: Option<&str>,
    event: impl Fn(Value) -> Result<Value, String>,
    input: impl Fn(RunInput) -> Option<Value>,
    inputs: tokio::sync::mpsc::Receiver<RunInput>,
    cancel: Arc<AtomicBool>,
) -> Result<(), String> {
    drive_adopted(owner, resolved, cwd, prompt, resume_id, event, input, inputs, cancel, None, None).await
}

/// `drive`, optionally on an adopted warm spare (R0807) and with the selection `_meta` of `session/new`.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn drive_adopted(
    owner: &str,
    resolved: Resolved,
    cwd: &Path,
    prompt: &str,
    resume_id: Option<&str>,
    event: impl Fn(Value) -> Result<Value, String>,
    input: impl Fn(RunInput) -> Option<Value>,
    mut inputs: tokio::sync::mpsc::Receiver<RunInput>,
    cancel: Arc<AtomicBool>,
    adopted: Option<(Started, Value)>,
    meta: Option<Value>,
) -> Result<(), String> {
    let state = shared(owner);
    let (_run, _token) = Run::begin(state.clone());
    // A warm spare (R0807) is already initialized: its reply is replayed as the first frame instead of asking again.
    let (started, mut replay) = match adopted {
        Some((started, reply)) => (started, Some(reply)),
        None => (spawn_process(owner, &resolved, cwd)?, None),
    };
    let Started { mut child, mut stdin, mut stdout, stderr_task, diagnostics } = started;
    let write = |value: Value| {
        let mut line = serde_json::to_vec(&value).unwrap_or_default();
        line.push(b'\n');
        line
    };
    let mut remote: Option<String> = None;
    let mut pending_permission: Option<Value> = None;
    let mut prompt_id: Option<u64> = None;
    let mut cancelled_sent = false;
    let mut stop_deadline: Option<tokio::time::Instant> = None;
    let started = tokio::time::Instant::now();
    if replay.is_none() { stdin.write_all(&write(initialize_frame())).await.map_err(|_| "HostUnavailable")?; }
    let mut outcome: Result<(), String> = Ok(());
    let mut line = Vec::new();
    'frames: loop {
        if cancel.load(Ordering::Acquire) && !cancelled_sent {
            cancelled_sent = true;
            if let Some(session) = &remote { let _ = stdin.write_all(&write(json!({"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":session}}))).await; }
            stop_deadline = Some(tokio::time::Instant::now() + STOP_GRACE);
            if prompt_id.is_none() { break 'frames; }
        }
        if prompt_id.is_none() && started.elapsed() > STARTUP {
            outcome = Err("Agent initialization timed out after 60 s: the declared harness did not open a session.".into());
            break;
        }
        let wait = stop_deadline.map_or(Duration::from_millis(100), |deadline| deadline.saturating_duration_since(tokio::time::Instant::now()).min(Duration::from_millis(100)));
        let frame = if let Some(reply) = replay.take() { Some(reply) } else { line.clear(); tokio::select! {
            read = stdout.read_until(b'\n', &mut line) => match read {
                Ok(0) | Err(_) => { if !cancel.load(Ordering::Acquire) { let note = diagnostics.lock().map(|text| text.trim().chars().take(300).collect::<String>()).unwrap_or_default(); outcome = Err(format!("The declared harness exited before it finished.{}", if note.is_empty() { String::new() } else { format!(" {note}") })); } break 'frames; }
                Ok(_) => {
                    if line.len() > MAX_LINE { outcome = Err("LimitExceeded: a harness frame was too large.".into()); break 'frames; }
                    match serde_json::from_slice::<Value>(&line) { Ok(frame) => Some(frame), Err(_) => None }
                }
            },
            received = inputs.recv() => {
                match received {
                    Some(RunInput::Stop) => { input(RunInput::Stop); }
                    // ACP v1 has no live steering frame: say so instead of claiming delivery.
                    Some(RunInput::Steer { reply, .. }) => { let _ = reply.send(Err("UnsupportedCapability: this declared ACP harness cannot take live steering".into())); }
                    Some(other) => { if let Some(answer) = input(other) { if answer["kind"] == "approval" {
                        if let Some(request) = pending_permission.take() {
                            let options = request["params"]["options"].as_array().cloned().unwrap_or_default();
                            let approved = answer["approved"] == true;
                            let result = match permission_choice(&options, approved) {
                                Some(option) => json!({"outcome":{"outcome":"selected","optionId":option["optionId"]}}),
                                None => json!({"outcome":{"outcome":"cancelled"}}),
                            };
                            let _ = stdin.write_all(&write(json!({"jsonrpc":"2.0","id":request["id"],"result":result}))).await;
                        }
                    } } }
                    None => cancel.store(true, Ordering::Release),
                }
                None
            },
            _ = tokio::time::sleep(wait) => { if stop_deadline.is_some_and(|deadline| tokio::time::Instant::now() >= deadline) { break 'frames; } None }
        } };
        let Some(frame) = frame else { continue };
        if frame.get("error").is_some() && frame.get("id").is_some() && frame.get("method").is_none() {
            let stage = match frame["id"].as_u64() { Some(1) => "initialize", Some(2) => "session creation", Some(3) => "session/prompt", _ => "request" };
            if cancel.load(Ordering::Acquire) { break; }
            outcome = Err(rpc_error(&frame, stage));
            break;
        }
        if let Some(method) = frame["method"].as_str() {
            match method {
                "session/update" => for value in update_events(&frame["params"]["update"]) {
                    if let Err(error) = event(value) { if !cancel.load(Ordering::Acquire) { outcome = Err(format!("The harness sent an event core refused: {error}")); } break 'frames; }
                },
                // A structured question is not a tool approval: approving it would silently pick its first answer.
                // Like the built-in ACP harnesses, decline it as cancelled (normalized questions are slice R0502).
                "session/request_permission" if frame.get("id").is_some() && structured_question(&frame) => {
                    let _ = stdin.write_all(&write(json!({"jsonrpc":"2.0","id":frame["id"],"result":{"outcome":{"outcome":"cancelled"}}}))).await;
                }
                "session/request_permission" if frame.get("id").is_some() => {
                    let title = frame["params"]["toolCall"]["title"].as_str().unwrap_or("The agent asks to run a tool.");
                    let text: String = title.chars().take(2_000).collect();
                    match event(json!({"kind":"approval","text":text})) {
                        Ok(_) => pending_permission = Some(frame.clone()),
                        Err(_) => { let _ = stdin.write_all(&write(json!({"jsonrpc":"2.0","id":frame["id"],"result":{"outcome":{"outcome":"cancelled"}}}))).await; }
                    }
                }
                _ if frame.get("id").is_some() => { let _ = stdin.write_all(&write(json!({"jsonrpc":"2.0","id":frame["id"],"error":{"code":-32601,"message":"Method not found"}}))).await; }
                _ => {}
            }
            continue;
        }
        match frame["id"].as_u64() {
            Some(1) => {
                if frame["result"]["protocolVersion"] != ACP_VERSION { outcome = Err("This harness does not support ACP protocol v1.".into()); break; }
                with(&state, |state| state.handshakes += 1);
                let capabilities = &frame["result"]["agentCapabilities"];
                let mut params = json!({"cwd":cwd.to_string_lossy(),"mcpServers":[]});
                // The selected model, effort and speed tier travel in the ACP extension point (`_meta`), attributed to the package (R0807).
                if let Some(meta) = &meta { params["_meta"] = json!({"pandacode": meta}); }
                let method = match resume_id.filter(|id| !id.is_empty()) {
                    None => "session/new",
                    Some(id) => {
                        params["sessionId"] = json!(id);
                        if capabilities["sessionCapabilities"].get("resume").is_some() { "session/resume" }
                        else if capabilities["loadSession"] == true { "session/load" }
                        else { outcome = Err("This ACP harness cannot resume saved tasks. Start a new task.".into()); break; }
                    }
                };
                stdin.write_all(&write(json!({"jsonrpc":"2.0","id":2,"method":method,"params":params}))).await.map_err(|_| "HostUnavailable")?;
            }
            Some(2) => {
                let session = frame["result"]["sessionId"].as_str().or(resume_id).unwrap_or_default().to_owned();
                if session.is_empty() || session.len() > 200 { outcome = Err("The harness returned no usable session id.".into()); break; }
                if let Err(error) = event(json!({"kind":"session","id":session})) { outcome = Err(error); break; }
                remote = Some(session.clone());
                prompt_id = Some(3);
                stdin.write_all(&write(json!({"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"sessionId":session,"prompt":[{"type":"text","text":prompt}]}}))).await.map_err(|_| "HostUnavailable")?;
            }
            Some(3) => {
                if frame["result"]["stopReason"] == "cancelled" && !cancel.load(Ordering::Acquire) { outcome = Err("The harness cancelled the turn.".into()); }
                break;
            }
            _ => {}
        }
    }
    drop(stdin);
    let waited = tokio::time::timeout(STOP_GRACE, child.wait()).await;
    if waited.is_err() { let _ = child.kill().await; let _ = child.wait().await; }
    let _ = stderr_task.await;
    if let Err(error) = &outcome { observe(&state, "ready", Some(error)); }
    outcome
}

/// Package-store helpers for tests that live outside `extensions` (the warm-spare tests of R0807), where the store's
/// install, trust and enable steps are not visible.
#[cfg(test)]
pub(crate) mod support {
    use super::super::packages::ExtensionPackages;
    pub(crate) fn install(packages: &ExtensionPackages, archive: &[u8]) { packages.0.lock().unwrap().install(archive).unwrap(); }
    pub(crate) fn digest(packages: &ExtensionPackages) -> String { serde_json::to_value(packages.0.lock().unwrap().snapshot()).unwrap()["packages"][0]["executable"]["digest"].as_str().unwrap().to_owned() }
    pub(crate) fn trust_and_enable(packages: &ExtensionPackages, id: &str) {
        let guard = packages.0.lock().unwrap();
        let digest = serde_json::to_value(guard.snapshot()).unwrap()["packages"][0]["executable"]["digest"].as_str().unwrap().to_owned();
        guard.trust(id, &digest, true).unwrap();
        guard.enable(id, true).unwrap();
    }
    pub(crate) fn disable(packages: &ExtensionPackages, id: &str) { packages.0.lock().unwrap().enable(id, false).unwrap(); }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn places() -> Places { Places { node: Some(std::env::current_exe().unwrap()), package: None, data: Some(std::env::temp_dir()) } }

    #[test]
    fn placeholders_resolve_and_unavailable_ones_are_explicit_errors() {
        let exe = std::env::current_exe().unwrap();
        let launch = json!({"protocol":"acp","command":["{node}","--flag","{data}/x.log"],"env":{"LOG":"{data}/frames.log","FIXED":"text"}});
        let resolved = resolve(&launch, &places()).unwrap();
        assert_eq!(resolved.program, exe);
        assert_eq!(resolved.arguments[0], "--flag");
        assert!(resolved.arguments[1].ends_with("x.log"));
        assert_eq!(resolved.env["FIXED"], "text");
        assert!(resolve(&launch, &Places::default()).unwrap_err().starts_with("UnsupportedRuntime"));
        let package = json!({"protocol":"acp","command":["{node}","{package}/agent.mjs"]});
        assert!(resolve(&package, &places()).unwrap_err().contains("runtime.files"));
        assert!(resolve(&json!({"protocol":"acp","command":["{nope}"]}), &places()).unwrap_err().starts_with("InvalidShape"));
    }

    #[test]
    fn missing_protocol_executable_and_shape_are_explicit() {
        assert!(resolve(&json!({"command":["x"]}), &places()).unwrap_err().starts_with("InvalidShape"));
        assert!(resolve(&json!({"protocol":"mcp","command":["x"]}), &places()).unwrap_err().starts_with("UnsupportedCapability"));
        assert!(resolve(&json!({"protocol":"acp","command":[]}), &places()).unwrap_err().starts_with("InvalidShape"));
        assert!(resolve(&json!({"protocol":"acp","command":[1]}), &places()).unwrap_err().starts_with("InvalidShape"));
        let missing = std::env::temp_dir().join("pandacode-no-such-harness-executable.exe");
        assert!(resolve(&json!({"protocol":"acp","command":[missing.to_string_lossy()]}), &places()).unwrap_err().starts_with("ExecutableMissing"));
        assert!(resolve(&json!({"protocol":"acp","command":["pandacode-no-such-harness-executable"]}), &places()).unwrap_err().starts_with("ExecutableMissing"));
    }

    #[test]
    fn overlay_replaces_readiness_and_records_transitions_once() {
        let owner = "sample.launch-overlay";
        forget(owner);
        let definition = json!({"id":"sample.launch-overlay/agent","launch":{"protocol":"acp","command":["pandacode-no-such-harness-executable"]}});
        let ready = json!({"readiness":{"state":"ready","reason":"Ready."}});
        let first = overlay(owner, &definition, ready.clone(), &places());
        assert_eq!(first["readiness"]["state"], "unavailable");
        assert!(first["readiness"]["reason"].as_str().unwrap().starts_with("ExecutableMissing"));
        overlay(owner, &definition, ready.clone(), &places());
        let fixed = json!({"id":"sample.launch-overlay/agent","launch":{"protocol":"acp","command":[std::env::current_exe().unwrap().to_string_lossy()]}});
        assert_eq!(overlay(owner, &fixed, ready, &places())["readiness"]["state"], "ready");
        assert_eq!(snapshot(owner).readiness, ["unavailable", "ready"]);
        // A package without launch is untouched.
        let handler = json!({"id":"sample.launch-overlay/other"});
        let metadata = json!({"readiness":{"state":"signedOut","reason":"Sign in."}});
        assert_eq!(overlay(owner, &handler, metadata.clone(), &places()), metadata);
        forget(owner);
    }

    #[test]
    fn session_updates_become_bounded_core_events() {
        let long = "x".repeat(CHUNK * 2 + 5);
        let events = update_events(&json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":long}}));
        assert_eq!(events.len(), 3);
        assert!(events.iter().all(|event| event["text"].as_str().unwrap().len() <= CHUNK));
        assert_eq!(update_events(&json!({"sessionUpdate":"agent_thought_chunk","content":{"text":"hm"}}))[0]["kind"], "thinking");
        let tool = update_events(&json!({"sessionUpdate":"tool_call_update","toolCallId":"t1","title":"Bash","status":"completed","rawInput":{"command":"x"},"content":[{"content":{"text":"out"}}]}));
        assert_eq!(tool[0]["tool"]["status"], "completed");
        assert_eq!(tool[0]["tool"]["output"], "out");
        assert_eq!(update_events(&json!({"sessionUpdate":"usage_update","used":64,"size":128}))[0]["usedTokens"], 64);
        assert!(update_events(&json!({"sessionUpdate":"plan"})).is_empty());
        let options = [json!({"optionId":"a","kind":"allow_once"}), json!({"optionId":"r","kind":"reject_once"})];
        assert_eq!(permission_choice(&options, true).unwrap()["optionId"], "a");
        assert_eq!(permission_choice(&options, false).unwrap()["optionId"], "r");
        assert!(permission_choice(&[], true).is_none());
    }

    #[test]
    fn structured_questions_are_never_tool_approvals() {
        let request = |options: Value| json!({"jsonrpc":"2.0","id":7,"method":"session/request_permission","params":{"options":options}});
        assert!(structured_question(&request(json!([{"optionId":"q0_opt_0","kind":"allow_once","name":"Postgres"},{"optionId":"q0_skip","kind":"reject_once"}]))));
        assert!(structured_question(&request(json!([{"optionId":"a","kind":"allow_once"},{"optionId":"b","kind":"allow_once"}]))));
        assert!(!structured_question(&request(json!([{"optionId":"allow","kind":"allow_once"},{"optionId":"deny","kind":"reject_once"}]))));
        assert!(!structured_question(&request(json!([{"optionId":"quick_opt","kind":"allow_once"}]))));
        assert!(!structured_question(&json!({"method":"session/request_permission"})));
    }

    /// A really installed package (archive, trust, enable) with an empty model list launches the Node fake agent
    /// (the adopted B5 state machine) through `providers::run`, the app's own send path.
    #[cfg(all(feature = "extension-runtime-native-tests", target_os = "windows", target_arch = "x86_64"))]
    mod installed {
        use super::super::*;
        use crate::{extensions::packages::ExtensionPackages, providers};
        use std::io::Write;

        const MANIFEST: &str = include_str!("../../../tests/fixtures/extensions/runtime-provider-launch/extension.json");
        const AGENT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/fixtures/extensions/backends/fake-agent.mjs");
        const ID: &str = "sample.launch-agent";
        const PROVIDER: &str = "sample.launch-agent/fake";

        struct Dir(PathBuf);
        impl Dir { fn new() -> Self { let path = std::env::temp_dir().join(format!("pandacode-launch-test-{}", uuid::Uuid::new_v4())); std::fs::create_dir(&path).unwrap(); Self(path) } }
        impl Drop for Dir { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }

        fn manifest(id: &str, agent: &str) -> String {
            let mut manifest: Value = serde_json::from_str(MANIFEST).unwrap();
            manifest["id"] = json!(id);
            manifest["contributes"]["providers"][0]["id"] = json!(format!("{id}/fake"));
            manifest["contributes"]["providers"][0]["launch"]["command"][1] = json!(agent);
            serde_json::to_string(&manifest).unwrap()
        }
        fn archive(manifest: &str) -> Vec<u8> {
            let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
            writer.start_file("extension.json", zip::write::SimpleFileOptions::default()).unwrap();
            writer.write_all(manifest.as_bytes()).unwrap();
            writer.finish().unwrap().into_inner()
        }
        fn install(packages: &ExtensionPackages, manifest: &str, trusted: bool) {
            let guard = packages.0.lock().unwrap();
            guard.install(&archive(manifest)).unwrap();
            let id = serde_json::from_str::<Value>(manifest).unwrap()["id"].as_str().unwrap().to_owned();
            assert!(guard.enable(&id, true).unwrap_err().contains("ExecutableTrustRequired"), "a launch provider needs executable trust to enable");
            if trusted {
                let digest = serde_json::to_value(guard.snapshot()).unwrap()["packages"].as_array().unwrap().iter().find(|package| package["manifest"]["id"] == id.as_str()).unwrap()["executable"]["digest"].as_str().unwrap().to_owned();
                guard.trust(&id, &digest, true).unwrap();
                guard.enable(&id, true).unwrap();
            }
        }
        async fn send(dir: &Path, provider: &str, session: &str, prompt: &str) -> (Result<(), String>, Vec<providers::AgentEvent>) {
            let config = providers::RunConfig { session_id: session.into(), provider: provider.into(), model: "default".into(), reasoning_effort: None, mode: "ask".into(), cwd: dir.to_path_buf(), resume_id: None, prompt: prompt.into(), instructions: String::new(), skill: None, goal: None, codex_settings: None, images: vec![] };
            let (_input, rx) = tokio::sync::mpsc::unbounded_channel();
            let (events, mut output) = tokio::sync::mpsc::unbounded_channel();
            let result = tokio::time::timeout(Duration::from_secs(60), providers::run(config, Arc::new(move |event| { let _ = events.send(event); }), rx)).await.expect("the launched run finishes");
            let mut seen = Vec::new();
            while let Ok(event) = output.try_recv() { seen.push(event); }
            (result, seen)
        }

        #[tokio::test]
        async fn a_declared_acp_harness_launches_the_fake_agent_and_runs_share_one_state() {
            let dir = Dir::new();
            let packages = ExtensionPackages::new(&dir.0, false);
            providers::dynamic_adapter::configure(&packages.0, Some(Path::new(env!("CARGO_MANIFEST_DIR")).join("../_work/00-tmp/extensibility-trusted-runtime")));
            forget(ID);
            // Installed but not trusted: an explicit readiness error, nothing registered, nothing started.
            install(&packages, &manifest(ID, AGENT), false);
            assert!(providers::dynamic_adapter::discover().is_empty());
            assert_eq!(providers::dynamic_adapter::require_available(PROVIDER).unwrap_err(), TRUST_REQUIRED);
            // Trusted and enabled: an empty initial model list, ready, no process yet.
            { let guard = packages.0.lock().unwrap(); let digest = serde_json::to_value(guard.snapshot()).unwrap()["packages"][0]["executable"]["digest"].as_str().unwrap().to_owned(); guard.trust(ID, &digest, true).unwrap(); guard.enable(ID, true).unwrap(); }
            let found = providers::dynamic_adapter::discover();
            assert_eq!(found.len(), 1);
            assert!(found[0].models.is_empty());
            assert_eq!(found[0].metadata.as_ref().unwrap()["readiness"]["state"], "ready");
            assert!(found[0].installed);
            assert_eq!(providers::package_starts::count("launch-one"), 0, "nothing starts before the first send");
            assert!(providers::dynamic_adapter::models(PROVIDER).unwrap().is_empty());
            // Two concurrent conversations of the one package.
            let slow = |text: &str| format!("#script [{{\"sleep\":600}},{{\"say\":\"{text}\"}}]");
            let (first, second) = (slow("first"), slow("second"));
            let (one, two) = tokio::join!(send(&dir.0, PROVIDER, "launch-one", &first), send(&dir.0, PROVIDER, "launch-two", &second));
            for (result, events, text, session) in [(&one.0, &one.1, "first", "launch-one"), (&two.0, &two.1, "second", "launch-two")] {
                assert!(result.is_ok(), "{result:?} {events:?}");
                assert!(events.iter().all(|event| event.session_id == session));
                assert!(events.iter().any(|event| event.kind == "session" && event.text.starts_with("fixture-")));
                assert!(events.iter().any(|event| event.kind == "text" && event.text == text), "{events:?}");
                assert_eq!(events.iter().filter(|event| event.kind == "done").count(), 1);
            }
            assert_eq!((providers::package_starts::count("launch-one"), providers::package_starts::count("launch-two")), (1, 1));
            let state = snapshot(ID);
            assert_eq!((state.tokens_issued, state.handshakes, state.peak, state.active, state.finished), (2, 2, 2, 0, 2), "{state:?}");
            assert_eq!(state.readiness, ["ready"]);
            // The handshake record of the fake agent: two initialize and two prompt frames, one per conversation.
            let data = packages.0.lock().unwrap().launch_data_directory(ID).unwrap();
            let log = std::fs::read_to_string(data.join("frames.log")).unwrap();
            let methods: Vec<String> = log.lines().filter_map(|line| serde_json::from_str::<Value>(line).ok()).filter_map(|frame| frame["method"].as_str().map(str::to_owned)).collect();
            assert_eq!(methods.iter().filter(|method| *method == "initialize").count(), 2, "{methods:?}");
            assert_eq!(methods.iter().filter(|method| *method == "session/prompt").count(), 2, "{methods:?}");
            // A stop cancels the turn and ends the process.
            let config = providers::RunConfig { session_id: "launch-stop".into(), provider: PROVIDER.into(), model: "default".into(), reasoning_effort: None, mode: "ask".into(), cwd: dir.0.clone(), resume_id: None, prompt: "#script [{\"sleep\":30000}]".into(), instructions: String::new(), skill: None, goal: None, codex_settings: None, images: vec![] };
            let (input, rx) = tokio::sync::mpsc::unbounded_channel();
            let (events, _output) = tokio::sync::mpsc::unbounded_channel();
            let runner = tokio::spawn(providers::run(config, Arc::new(move |event| { let _ = events.send(event); }), rx));
            tokio::time::sleep(Duration::from_millis(1500)).await;
            input.send(RunInput::Stop).unwrap();
            assert!(tokio::time::timeout(Duration::from_secs(20), runner).await.expect("stop ends the run").unwrap().is_ok());
            assert_eq!(snapshot(ID).active, 0);
            // A missing executable is an explicit readiness error, at discovery and at send.
            let missing = "sample.launch-missing";
            let mut declared: Value = serde_json::from_str(&manifest(missing, AGENT)).unwrap();
            declared["contributes"]["providers"][0]["launch"]["command"] = json!([dir.0.join("no-such-agent.exe").to_string_lossy()]);
            install(&packages, &declared.to_string(), true);
            let readiness = providers::dynamic_adapter::discover().into_iter().find(|provider| provider.id == format!("{missing}/fake")).unwrap().metadata.unwrap()["readiness"].clone();
            assert_eq!(readiness["state"], "unavailable");
            assert!(readiness["reason"].as_str().unwrap().starts_with("UnsupportedRuntime") || readiness["reason"].as_str().unwrap().starts_with("ExecutableMissing"), "{readiness}");
            let (failed, events) = send(&dir.0, &format!("{missing}/fake"), "launch-missing", "hello").await;
            assert!(failed.is_err() && events.iter().any(|event| event.kind == "error"), "{failed:?}");
            assert_eq!(snapshot(missing).readiness, ["unavailable"]);
            forget(ID); forget(missing);
        }
    }

    #[test]
    fn one_state_serves_concurrent_runs_with_distinct_tokens() {
        let owner = "sample.launch-state";
        forget(owner);
        let (first, one) = Run::begin(shared(owner));
        let (second, two) = Run::begin(shared(owner));
        assert_ne!(one, two);
        assert_eq!(registry().lock().unwrap().keys().filter(|key| key.as_str() == owner).count(), 1);
        assert_eq!((snapshot(owner).active, snapshot(owner).peak), (2, 2));
        drop(first); drop(second);
        let state = snapshot(owner);
        assert_eq!((state.active, state.peak, state.finished, state.tokens_issued), (0, 2, 2, 2));
        forget(owner);
    }
}
