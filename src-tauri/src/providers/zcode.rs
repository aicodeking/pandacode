//! ZCode (z.ai's CLI) over its `app-server` protocol: newline-delimited JSON on
//! stdio, no handshake and no transport auth — whoever holds the pipe drives the
//! session. Frames recorded from the CLI bundled with ZCode.app (user-agent
//! `ZCode/3.16.3`); see `.agents/state/zcode-harness/protocol.md`. The wire
//! surface (`session/*` v1) predates the in-flight v4 migration, so every frame
//! is parsed defensively: unknown events and reverse requests are ignored or
//! answered `-32601` (the server tolerates that), and nothing outside the
//! session's turn is allowed to fail a run.
use super::*;
use tokio::io::AsyncBufReadExt;

/// Own request ids on the shared connection. Prompts continue the sequence so
/// `turn.completed` echoes them back as `inputId` ("pandacode-<n>").
const ID_CREATE: u64 = 1;
const ID_MODEL: u64 = 2;
const ID_THOUGHT: u64 = 3;
const ID_SUBSCRIBE: u64 = 4;
const ID_MODE: u64 = 5;
const ID_STOP: u64 = 1 << 40;
/// `mcp/list` connect for a resumed session's fresh per-run bridge. High, like
/// stop, so it can never collide with the growing prompt ids.
const ID_MCP: u64 = 1 << 41;
const FIRST_PROMPT_ID: u64 = 6;

pub(super) const SIGN_IN: &str =
    "ZCode requires sign-in. Run `zcode` in a terminal and sign in, then send again.";

/// The CLI bundled with ZCode Desktop (`…/resources/glm/zcode.cjs`), for installs
/// without `zcode` on PATH. The launch layer runs it on the app's own Electron
/// runtime, so no system node is needed.
pub(super) fn bundled() -> Option<PathBuf> {
    bundled_candidates().into_iter().find(|path| runnable(path))
}

/// The launch layer can run the script: it carries an exec bit (direct shebang
/// exec) or a desktop app runtime sits beside it to launch it, so a bundled copy
/// that lost its mode still counts when its app can run it.
#[cfg(unix)]
fn runnable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.metadata().is_ok_and(|metadata| {
        metadata.is_file()
            && (metadata.permissions().mode() & 0o111 != 0
                || super::launch::electron_runtime(path).is_some())
    })
}

#[cfg(not(unix))]
fn runnable(path: &Path) -> bool {
    path.is_file()
}

#[cfg(target_os = "macos")]
fn bundled_candidates() -> Vec<PathBuf> {
    let home = crate::agent_usage_providers::home();
    [Some(PathBuf::from("/Applications")), home.map(|home| home.join("Applications"))]
        .into_iter()
        .flatten()
        .map(|root| root.join("ZCode.app/Contents/Resources/glm/zcode.cjs"))
        .collect()
}

#[cfg(target_os = "windows")]
fn bundled_candidates() -> Vec<PathBuf> {
    // electron-builder's NSIS defaults: per-user under %LOCALAPPDATA%\Programs,
    // per-machine under %ProgramFiles%; the inner layout matches every platform.
    let roots = std::env::var_os("LOCALAPPDATA")
        .filter(|value| !value.is_empty())
        .map(|local| PathBuf::from(local).join("Programs"))
        .into_iter()
        .chain(
            std::env::var_os("ProgramFiles")
                .filter(|value| !value.is_empty())
                .map(PathBuf::from),
        );
    roots
        .flat_map(|root| ["ZCode", "zcode"].map(|name| root.join(name)))
        .map(|root| root.join("resources/glm/zcode.cjs"))
        .collect()
}

#[cfg(target_os = "linux")]
fn bundled_candidates() -> Vec<PathBuf> {
    // electron-builder's deb/rpm default installs under /opt/<product name>.
    ["/opt/ZCode", "/opt/zcode"]
        .iter()
        .map(|root| PathBuf::from(root).join("resources/glm/zcode.cjs"))
        .collect()
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
fn bundled_candidates() -> Vec<PathBuf> {
    Vec::new()
}

/// PandaCode mode → ZCode session mode. `auto` is Accept edits (edits run
/// free, the rest ask); Standard (`ask`) and the reviewer mode run `build`.
pub(super) fn mode(mode: &str) -> &'static str {
    match mode {
        "plan" => "plan",
        "auto" => "edit",
        "full" => "yolo",
        _ => "build",
    }
}

pub(super) fn configure(command: &mut Command) {
    command.arg("app-server");
}

#[derive(Default)]
pub(super) struct State {
    /// Context window of the session's model, captured from the create snapshot.
    context_window: Option<u64>,
    /// Model reference requested via `session/setModel`, verified on the reply.
    requested_model: Option<(String, String)>,
    /// Thought level requested via `session/setThoughtLevel`.
    requested_thought: Option<String>,
    /// Session mode requested via `session/setMode` (create and every resume).
    requested_mode: Option<&'static str>,
    /// Sequence number of the prompt in flight; 0 until the first `session/send`.
    next_input: u64,
    /// The current assistant message streamed reasoning deltas.
    reasoning: bool,
    /// Latest turn failure, held until the turn's completed frame decides the run.
    error: Option<String>,
    /// `mcp/list` was sent and has not answered. The prompt waits for it.
    bridge_pending: bool,
    /// `session/subscribe` already answered while the bridge check was in flight.
    prompt_held: bool,
}

fn same_ref(a: &Value, b: &Value) -> bool {
    a["providerId"] == b["providerId"] && a["modelId"] == b["modelId"]
}

/// The catalog entry matching a session model reference carries the live
/// context window; recorded snapshots restated it per build, so re-read it
/// from whichever snapshot just answered instead of caching the first value.
fn context_window_of(settings: &Value, reference: &Value) -> Option<u64> {
    settings["model"]["available"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|entry| same_ref(&entry["ref"], reference))
        .and_then(|entry| entry["contextWindow"].as_u64())
        .filter(|n| *n > 0 && *n <= 1_000_000_000)
}

/// The catalog entry offers this reasoning level.
fn lists_level(entry: &Value, level: &str) -> bool {
    entry["reasoning"]["levels"]
        .as_array()
        .is_some_and(|levels| levels.iter().any(|item| field(item, "value") == level))
}

fn workspace_of(cwd: &std::path::Path) -> Value {
    let path = cwd.to_string_lossy().to_string();
    json!({"workspacePath": path, "workspaceKey": path})
}

/// `payload.type` carries the discriminator on recorded frames; `type` is the
/// fallback for builds that flattened the envelope.
fn event_kind(params: &Value) -> &str {
    let nested = field(&params["payload"], "type");
    if nested.is_empty() {
        field(params, "type")
    } else {
        nested
    }
}

/// Whether a stopped run's output has reached its end.
pub(super) fn stop_settled(value: &Value) -> bool {
    value["method"] == "session/event" && event_kind(&value["params"]) == "turn.completed"
}

/// The stop request. The run then settles through `turn.completed`.
pub(super) fn stop(remote_id: &str) -> Value {
    json!({"id": ID_STOP, "method": "session/stop", "params": {"sessionId": remote_id}})
}

/// Discovery stdout cap, mirroring the Pi discovery limit.
const DISCOVERY_OUTPUT_LIMIT: u64 = 16 * 1024 * 1024;
const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(20);
const DISCOVERY_STRAY_LIMIT: usize = 50;
const DISCOVERY_EARLY_EXIT: &str = "ZCode exited before returning models";
const DISCOVERY_TIMEOUT_MESSAGE: &str = "ZCode model discovery timed out";
const DISCOVERY_BUILTIN_CONFIG_CAUSE: &str = "ZCode exited before returning models: this ZCode build's CLI could not find its built-in provider config (zcode-builtin.json) and PandaCode could not locate it either. Update PandaCode and ZCode, or set ZCODE_BUILTIN_PROVIDER_CONFIG_FILE to that file's path in Settings → ZCode → environment.";

#[derive(Debug, PartialEq)]
enum DiscoveryLine {
    Blank,
    NonJson,
    Json(Value),
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum DiscoveryFailure {
    Spawn(String),
    EarlyExit { received_json: bool },
    Timeout,
    ServerError(String),
    InvalidJson,
    OutputLimit,
    InvalidCatalog(String),
    Io(String),
}

struct DiscoveryReport {
    failure: DiscoveryFailure,
    exit_status: Option<String>,
    stderr: String,
}

fn classify_discovery_line(line: &[u8]) -> DiscoveryLine {
    if line.iter().all(u8::is_ascii_whitespace) {
        return DiscoveryLine::Blank;
    }
    match serde_json::from_slice::<Value>(line) {
        Ok(value) if value.is_object() => DiscoveryLine::Json(value),
        _ => DiscoveryLine::NonJson,
    }
}

fn accept_discovery_line(line: &[u8], stray: &mut usize) -> Result<Option<Value>, &'static str> {
    match classify_discovery_line(line) {
        DiscoveryLine::Blank => Ok(None),
        DiscoveryLine::NonJson => {
            *stray += 1;
            if *stray > DISCOVERY_STRAY_LIMIT {
                Err("Invalid ZCode discovery JSON")
            } else {
                Ok(None)
            }
        }
        DiscoveryLine::Json(value) => Ok(Some(value)),
    }
}

fn is_missing_builtin_config(stderr: &str) -> bool {
    let lower = stderr.to_ascii_lowercase();
    lower.contains("zcode-builtin.json") || lower.contains("built-in provider config")
}

/// Redacts saved ZCode environment values of 8+ characters, or 4+ for secret-like
/// names. Short flags and status codes stay readable in discovery diagnostics.
fn scrub_env_values(text: &str, env: &[(String, String)]) -> String {
    if text.is_empty() {
        return String::new();
    }
    let mut secrets: Vec<&str> = env
        .iter()
        .filter(|(name, value)| {
            let name = name.to_ascii_lowercase();
            let secret = ["key", "token", "secret", "password", "passwd", "auth", "credential", "cookie", "session", "private"].iter().any(|part| name.contains(part));
            value.chars().count() >= if secret { 4 } else { 8 }
        })
        .map(|(_, value)| value.as_str())
        .collect();
    secrets.sort_by_key(|value| std::cmp::Reverse(value.len()));
    secrets.dedup();
    let mut scrubbed = text.to_owned();
    for secret in secrets {
        scrubbed = scrubbed.replace(secret, "[redacted]");
    }
    scrubbed
}

fn should_retry_discovery(attempt: usize, failure: &DiscoveryFailure, stderr: &str) -> bool {
    attempt == 0
        && matches!(failure, DiscoveryFailure::EarlyExit { received_json: false })
        && !is_missing_builtin_config(stderr)
}

fn format_discovery_failure(
    failure: &DiscoveryFailure,
    exit_status: Option<&str>,
    stderr: &str,
    env: &[(String, String)],
) -> String {
    let scrubbed = scrub_env_values(stderr, env);
    match failure {
        DiscoveryFailure::Spawn(message) => message.clone(),
        DiscoveryFailure::ServerError(message) => short(&scrub_env_values(message, env)),
        DiscoveryFailure::EarlyExit { .. } => {
            let primary = if is_missing_builtin_config(&scrubbed) {
                DISCOVERY_BUILTIN_CONFIG_CAUSE.to_owned()
            } else if let Some(status) = exit_status.filter(|status| !status.is_empty()) {
                format!("{DISCOVERY_EARLY_EXIT} ({status})")
            } else {
                DISCOVERY_EARLY_EXIT.to_owned()
            };
            super::diagnostics::failure(&primary, &scrubbed)
        }
        DiscoveryFailure::Timeout => {
            super::diagnostics::failure(DISCOVERY_TIMEOUT_MESSAGE, &scrubbed)
        }
        DiscoveryFailure::InvalidJson => {
            super::diagnostics::failure("Invalid ZCode discovery JSON", &scrubbed)
        }
        DiscoveryFailure::OutputLimit => {
            super::diagnostics::failure("ZCode model catalog exceeded its output limit", &scrubbed)
        }
        DiscoveryFailure::InvalidCatalog(message) => {
            super::diagnostics::failure(message, &scrubbed)
        }
        DiscoveryFailure::Io(message) => {
            super::diagnostics::failure(&scrub_env_values(message, env), &scrubbed)
        }
    }
}

async fn send_discovery_json(stdin: &mut ChildStdin, value: &Value) -> std::io::Result<()> {
    let mut bytes = serde_json::to_vec(value)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    bytes.push(b'\n');
    stdin.write_all(&bytes).await?;
    stdin.flush().await
}

/// The catalog is session metadata only: never send a prompt during discovery.
pub(super) async fn models(path: &Path) -> Result<Vec<ModelInfo>, String> {
    if let Some(models) = acp_catalog::get("zcode", path) {
        return Ok(models);
    }
    let _refresh = acp_catalog::refresh_lock("zcode", path).await;
    if let Some(models) = acp_catalog::get("zcode", path) {
        return Ok(models);
    }
    let discovery = acp_catalog::begin("zcode", path);
    let models = discover(path).await?;
    acp_catalog::store_models(discovery, models.clone());
    Ok(models)
}

fn qualified_model_id(entry: &Value) -> Option<String> {
    let provider = field(&entry["ref"], "providerId");
    let model = field(&entry["ref"], "modelId");
    if provider.is_empty() || model.is_empty() {
        return None;
    }
    let id = format!("{provider}/{model}");
    valid_model_id(&id).then_some(id)
}

fn resolve_catalog_entry<'a>(
    catalog: &'a [Value],
    current: &Value,
    wanted: &str,
) -> Option<&'a Value> {
    catalog
        .iter()
        .find(|entry| qualified_model_id(entry).as_deref() == Some(wanted))
        .or_else(|| {
            catalog
                .iter()
                .find(|entry| field(entry, "label") == wanted && same_ref(&entry["ref"], current))
        })
        .or_else(|| catalog.iter().find(|entry| field(entry, "label") == wanted))
}

fn parse_models(snapshot: &Value) -> Result<Vec<ModelInfo>, String> {
    let entries = snapshot["settings"]["model"]["available"]
        .as_array()
        .filter(|v| v.len() <= MODEL_CATALOG_LIMIT)
        .ok_or("Invalid ZCode model catalog")?;
    let mut label_counts: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    for entry in entries {
        let label = field(entry, "label");
        if valid_model_id(label) {
            *label_counts.entry(label).or_insert(0) += 1;
        }
    }
    let mut models = vec![ModelInfo::default_choice()];
    let mut seen = HashSet::from([String::from("default")]);
    for entry in entries {
        let label = field(entry, "label").to_owned();
        if !valid_model_id(&label) {
            continue;
        }
        let repeated = label_counts.get(label.as_str()).copied().unwrap_or(0) > 1;
        let id = if repeated {
            let Some(qualified) = qualified_model_id(entry) else {
                continue;
            };
            qualified
        } else {
            label.clone()
        };
        if !seen.insert(id.clone()) {
            continue;
        }
        let reasoning = &entry["reasoning"];
        let efforts: Vec<_> = reasoning["levels"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|level| (field(level, "value"), level["description"].as_str()))
            .filter(|(value, _)| validate_reasoning_effort("zcode", Some(value)).is_ok())
            .map(|(value, description)| effort_info(value, description))
            .collect();
        let default_reasoning_effort = reasoning["defaultLevel"]
            .as_str()
            .filter(|level| efforts.iter().any(|effort| effort.id.as_str() == *level))
            .map(str::to_owned);
        let description = model_text(entry["providerLabel"].as_str(), "", 200);
        let base_name = model_text(entry["label"].as_str(), &id, 160);
        let name = if repeated && !description.is_empty() {
            model_text(Some(&format!("{base_name} ({description})")), &base_name, 160)
        } else {
            base_name
        };
        models.push(ModelInfo {
            speed_tiers: Vec::new(),
            name,
            description,
            id,
            reasoning_efforts: efforts,
            default_reasoning_effort,
            context_window: entry["contextWindow"]
                .as_u64()
                .filter(|n| *n > 0 && *n <= 1_000_000_000),
        });
    }
    Ok(models)
}

async fn discover(path: &Path) -> Result<Vec<ModelInfo>, String> {
    let deadline = tokio::time::Instant::now() + DISCOVERY_TIMEOUT;
    let env = crate::provider_settings::environment("zcode");
    for attempt in 0..=1 {
        match discover_attempt(path, deadline).await {
            Ok(models) => return Ok(models),
            Err(report) => {
                let scrubbed = scrub_env_values(&report.stderr, &env);
                if should_retry_discovery(attempt, &report.failure, &scrubbed)
                    && tokio::time::Instant::now() < deadline
                {
                    continue;
                }
                return Err(format_discovery_failure(
                    &report.failure,
                    report.exit_status.as_deref(),
                    &report.stderr,
                    &env,
                ));
            }
        }
    }
    unreachable!()
}

async fn discover_attempt(
    path: &Path,
    deadline: tokio::time::Instant,
) -> Result<Vec<ModelInfo>, DiscoveryReport> {
    let mut command = super::provider_command("zcode", path).map_err(|message| DiscoveryReport {
        failure: DiscoveryFailure::Spawn(message),
        exit_status: None,
        stderr: String::new(),
    })?;
    command.arg("app-server");
    let workspace = std::env::temp_dir();
    command
        .current_dir(&workspace)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command.spawn().map_err(|e| DiscoveryReport {
        failure: DiscoveryFailure::Spawn(format!("Could not start ZCode: {e}")),
        exit_status: None,
        stderr: String::new(),
    })?;
    let group = ProcessGroup::register(child.id());
    let mut stderr_task = child
        .stderr
        .take()
        .map(|stderr| StderrReader(tokio::spawn(read_stderr(stderr))));
    let result = tokio::time::timeout_at(deadline, async {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| DiscoveryFailure::Io("ZCode stdin unavailable".into()))?;
        let mut stdout = tokio::io::BufReader::new(
            child
                .stdout
                .take()
                .ok_or_else(|| DiscoveryFailure::Io("ZCode stdout unavailable".into()))?,
        )
        .take(DISCOVERY_OUTPUT_LIMIT + 1);
        if send_discovery_json(
            &mut stdin,
            &json!({"id": ID_CREATE, "method": "session/create", "params": {
                "workspace": workspace_of(&workspace),
                "persistence": "deferred",
                "mode": "plan",
                "titleGenerationEnabled": false,
            }}),
        )
        .await
        .is_err()
        {
            return Err(DiscoveryFailure::EarlyExit {
                received_json: false,
            });
        }
        let mut total = 0u64;
        let mut stray = 0usize;
        let mut received_json = false;
        loop {
            let mut line = Vec::new();
            let count = stdout
                .read_until(b'\n', &mut line)
                .await
                .map_err(|e| DiscoveryFailure::Io(e.to_string()))?;
            total += count as u64;
            if total > DISCOVERY_OUTPUT_LIMIT {
                return Err(DiscoveryFailure::OutputLimit);
            }
            if count == 0 {
                return Err(DiscoveryFailure::EarlyExit { received_json });
            }
            let Some(value) =
                accept_discovery_line(&line, &mut stray).map_err(|_| DiscoveryFailure::InvalidJson)?
            else {
                continue;
            };
            received_json = true;
            if value.get("method").is_some() && value.get("id").is_some() {
                // The server blocks on client requests (runtime preferences);
                // declining them like the run path does unblocks the create.
                if send_discovery_json(
                    &mut stdin,
                    &json!({"id": value["id"], "error": {"code": -32601, "message": "Method not found"}}),
                )
                .await
                .is_err()
                {
                    return Err(DiscoveryFailure::EarlyExit {
                        received_json: true,
                    });
                }
                continue;
            }
            if value["id"] != ID_CREATE {
                continue;
            }
            if let Some(error) = value.get("error") {
                return Err(DiscoveryFailure::ServerError(field(error, "message").to_owned()));
            }
            let _ = send_discovery_json(
                &mut stdin,
                &json!({"id": 2, "method": "session/close", "params": {
                    "sessionId": value["result"]["session"]["sessionId"],
                }}),
            )
            .await;
            return parse_models(&value["result"]).map_err(DiscoveryFailure::InvalidCatalog);
        }
    })
    .await
    .unwrap_or(Err(DiscoveryFailure::Timeout));
    // Stdin closed when the inner future dropped; drop any untaken handle too
    // before waiting for the child's own exit status.
    drop(child.stdin.take());
    let exit_status = if matches!(result, Err(DiscoveryFailure::EarlyExit { .. })) {
        tokio::time::timeout(Duration::from_millis(500), child.wait())
            .await
            .ok()
            .and_then(Result::ok)
            .map(|status| status.to_string())
    } else {
        None
    };
    drop(group);
    if exit_status.is_none() {
        let _ = child.start_kill();
        let _ = tokio::time::timeout(Duration::from_secs(1), child.wait()).await;
    }
    let stderr = match stderr_task.as_mut() {
        Some(task) if result.is_err() => tokio::time::timeout(Duration::from_millis(500), &mut task.0)
            .await
            .ok()
            .and_then(Result::ok)
            .unwrap_or_default(),
        _ => String::new(),
    };
    drop(stderr_task);
    result.map_err(|failure| DiscoveryReport {
        failure,
        exit_status,
        stderr,
    })
}

impl Protocol {
    /// Opens the run's session. Deferred persistence keeps captures and failed
    /// starts out of the user's ZCode history; resume attaches by saved id.
    pub(super) fn zcode_initial(&self) -> Value {
        match &self.config.resume_id {
            Some(id) => json!({"id": ID_CREATE, "method": "session/resume",
                "params": {"sessionId": id, "workspace": workspace_of(&self.config.cwd)}}),
            None => self.zcode_create(),
        }
    }

    fn zcode_create(&self) -> Value {
        let mut request = json!({"id": ID_CREATE, "method": "session/create", "params": {
            "workspace": workspace_of(&self.config.cwd),
            "mode": mode(&self.config.mode),
            "persistence": "deferred",
            "titleGenerationEnabled": false,
        }});
        // A fresh session takes its tools server (and any extra stdio servers,
        // such as Colab's) inline; a resumed one cannot (its schema has no
        // mcpServers) and gets `mcp/list` instead.
        let servers = self.zcode_mcp_servers();
        if !servers.is_empty() {
            request["params"]["mcpServers"] = json!(servers);
        }
        request
    }

    /// ZCode's `mcpServers`: the bridge, then any extra stdio servers, each scoped to
    /// this session and loaded up front so their tools reach the model.
    fn zcode_mcp_servers(&self) -> Vec<Value> {
        self.acp_mcp_servers().into_iter().map(super::mcp_host::zcode_scoped).collect()
    }

    pub(super) fn zcode(&mut self, value: Value) -> Result<Step, String> {
        let mut step = Step::default();
        if value.get("method").is_some() {
            self.zcode_frame(value, &mut step)?;
            return Ok(step);
        }
        if let Some(error) = value.get("error") {
            // The bridge check reads the error itself: a CLI without `mcp/list`
            // only loses optional tools, or fails clearly when they are required.
            if value["id"] == ID_MCP {
                self.finish_bridge(&value, &mut step)?;
                return Ok(step);
            }
            // Deferred persistence promotes a session on its first send, so a
            // start that failed before it left nothing on disk and this
            // per-run server cannot resume it. Start fresh instead of failing
            // the thread for good; a create's own error is never swallowed.
            if value["id"] == ID_CREATE
                && self.config.resume_id.is_some()
                && (error["code"] == -32004
                    || field(error, "message")
                        .to_lowercase()
                        .starts_with("session not found"))
            {
                self.config.resume_id = None;
                self.remote_id.clear();
                step.events.push(self.event(
                    "status",
                    "The saved ZCode session is gone, so a new session started without its history",
                    None,
                ));
                step.write.push(self.zcode_create());
                return Ok(step);
            }
            let message = short(field(error, "message"));
            let auth = field(error, "data").to_lowercase().contains("auth")
                || message.to_lowercase().contains("account")
                || message.to_lowercase().contains("sign");
            return Err(if auth { SIGN_IN.into() } else { message });
        }
        match value["id"].as_u64() {
            Some(ID_CREATE) => self.zcode_created(&value, &mut step)?,
            Some(ID_MODEL) => {
                let session = &value["result"]["session"];
                let applied = self
                    .zcode
                    .requested_model
                    .as_ref()
                    .is_some_and(|(provider, model)| {
                        session["model"]["providerId"] == *provider
                            && session["model"]["modelId"] == *model
                    });
                if !applied {
                    return Err("ZCode did not apply the selected model".into());
                }
                self.zcode.context_window =
                    context_window_of(&value["result"]["settings"], &session["model"]);
            }
            Some(ID_MODE) => {
                // ZCode 3.18.2 turns `plan` into execution mode `build` plus an internal
                // `planEnabled` flag that the snapshot does not expose, so a clean reply
                // reporting `build` after requesting `plan` counts as applied.
                let reported = value["result"]["settings"]["mode"]["current"].as_str();
                let applied = self.zcode.requested_mode.is_some_and(|wanted| {
                    reported == Some(wanted) || (wanted == "plan" && reported == Some("build"))
                });
                if !applied {
                    return Err("ZCode did not apply the selected access mode".into());
                }
            }
            Some(ID_THOUGHT) => {
                let applied = self.zcode.requested_thought.as_deref().is_some_and(|effort| {
                    value["result"]["settings"]["thoughtLevel"]["current"] == *effort
                });
                if !applied {
                    return Err("ZCode did not apply the selected thinking level".into());
                }
            }
            Some(ID_MCP) => self.finish_bridge(&value, &mut step)?,
            Some(ID_SUBSCRIBE) => {
                if self.zcode.bridge_pending {
                    self.zcode.prompt_held = true;
                } else {
                    self.zcode_prompt(self.config.prompt.clone(), &mut step);
                }
            }
            _ => {}
        }
        Ok(step)
    }

    /// Notifications and the server's reverse requests. Unknown reverse requests
    /// get `-32601`, which recorded servers answer and carry on from.
    fn zcode_frame(&mut self, value: Value, step: &mut Step) -> Result<(), String> {
        match (field(&value, "method"), value.get("id").is_some()) {
            ("interaction/requestPermission", true)
                if self.config.mode == "full" && !super::lasting_only(&value) =>
            {
                // yolo should not ask; a policy request that still arrives takes
                // the offered one-time allow, never a standing grant.
                step.write.push(permission_decision(&value, true));
            }
            ("interaction/requestPermission", true) => {
                // Offering only a lasting allow (e.g. `allow_project` adding rules) is
                // never answered automatically, even in Full: it asks, marked `LASTING_ONLY`.
                let params = &value["params"];
                let text = format!(
                    "{}\n{}\n{}",
                    field(params, "toolName"),
                    field(params, "reason"),
                    preview_json(&params["input"], TOOL_INPUT_LIMIT),
                );
                self.approval(value, text, step);
                // A denial needs no offered option (`permission_decision` falls back to a
                // plain deny), so a team worker's automatic answer can always decline it.
                if let Some(data) = step.events.last_mut().and_then(|event| event.data.as_mut()) {
                    if data[super::LASTING_ONLY] == true {
                        data[super::LASTING_DECLINABLE] = json!(true);
                    }
                }
            }
            ("interaction/requestUserInput", true) => step.write.push(
                json!({"id": value["id"], "result": {"action": "decline",
                       "reason": "PandaCode cannot answer interactive questions yet"}}),
            ),
            ("session/event", false) => self.zcode_event(&value, step)?,
            (_, true) => step.write.push(
                json!({"id": value["id"], "error": {"code": -32601, "message": "Method not found"}}),
            ),
            _ => {}
        }
        Ok(())
    }

    fn zcode_event(&mut self, value: &Value, step: &mut Step) -> Result<(), String> {
        let params = &value["params"];
        let payload = &params["payload"];
        match event_kind(params) {
            "turn.started" => self.zcode.reasoning = false,
            "model.streaming" => match field(payload, "kind") {
                "text_delta" => {
                    let id = field(payload, "assistantMessageId");
                    if self.claude_message_id != id {
                        self.claude_message_id = id.to_owned();
                        self.zcode.reasoning = false;
                    }
                    self.text_delta(id, None, field(payload, "delta"), step);
                }
                "tool_call" => {
                    let id = field(payload, "assistantMessageId");
                    if !id.is_empty() && self.claude_message_id != id {
                        self.claude_message_id = id.to_owned();
                    }
                    self.zcode.reasoning = false;
                    let input = &payload["input"];
                    if input.is_object() || input.as_str().is_some_and(|text| !text.is_empty()) {
                        self.tool_update(
                            field(payload, "toolCallId"),
                            Some(field(payload, "toolName")),
                            Some("running"),
                            Some(preview_json(input, TOOL_INPUT_LIMIT)),
                            None,
                            step,
                        );
                    }
                }
                "reasoning_delta" if !self.zcode.reasoning => {
                    self.zcode.reasoning = true;
                    step.events.push(self.event("status", "Reasoning", None));
                }
                _ => {}
            },
            "tool.updated" => {
                let id = field(payload, "toolCallId");
                match field(payload, "kind") {
                    "scheduled" | "started" => {
                        self.tool_update(
                            id,
                            Some(field(payload, "toolName")),
                            Some("running"),
                            payload["input"]
                                .as_object()
                                .map(|_| preview_json(&payload["input"], TOOL_INPUT_LIMIT)),
                            None,
                            step,
                        );
                    }
                    "result" => {
                        let result = &payload["result"];
                        let status = if result["success"] == true {
                            "completed"
                        } else {
                            "failed"
                        };
                        self.tool_update(
                            id,
                            Some(field(payload, "toolName")),
                            Some(status),
                            None,
                            Some(content_preview(&result["content"], TOOL_OUTPUT_LIMIT)),
                            step,
                        );
                    }
                    "error" => self.tool_update(
                        id,
                        Some(field(payload, "toolName")),
                        Some("failed"),
                        None,
                        Some(content_preview(&payload["error"], TOOL_OUTPUT_LIMIT)),
                        step,
                    ),
                    _ => {}
                }
            }
            "subagent.lifecycle" => self.zcode_subagent(payload, step),
            "checkpoint.created" => {
                let id = field(payload, "checkpointId");
                if !id.is_empty() {
                    step.events.push(self.event(
                        "status",
                        format!("Checkpoint {id}"),
                        None,
                    ));
                }
            }
            "turn.failed" => {
                self.zcode.error = Some(short(field(payload, "error")));
            }
            "turn.completed" => {
                // A late completed frame from an earlier input never ends this run.
                let input = field(payload, "inputId");
                if !input.is_empty() && input != format!("pandacode-{}", self.zcode.next_input) {
                    return Ok(());
                }
                // `usage.inputTokens` already includes `cacheReadTokens`.
                let input_tokens = payload["usage"]["inputTokens"].as_u64().unwrap_or(0);
                let used = if input_tokens > 0 {
                    input_tokens
                } else {
                    payload["tokenCount"].as_u64().unwrap_or(0)
                };
                self.usage(used, self.zcode.context_window, step);
                match field(payload, "resultType") {
                    "success" => step.done = true,
                    "cancelled" => return Err("ZCode run was stopped".into()),
                    other => {
                        let held = self.zcode.error.take();
                        return Err(held.unwrap_or_else(|| match other {
                            "error_max_turns" => "ZCode reached its turn limit".into(),
                            "error_max_budget" => "ZCode reached its budget limit".into(),
                            "error_max_tool_calls" => "ZCode reached its tool-call limit".into(),
                            _ => "ZCode could not finish the response".into(),
                        }));
                    }
                }
            }
            _ => {}
        }
        Ok(())
    }

    /// Maps `subagent.lifecycle` onto the existing Agent-tool observer so the
    /// transcript shows the child without a second display path.
    fn zcode_subagent(&mut self, payload: &Value, step: &mut Step) {
        let id = field(payload, "agentId");
        if id.is_empty() {
            return;
        }
        let name = match field(payload, "agentType") {
            "" => "Subagent",
            other => other,
        };
        let (status, output) = match field(payload, "phase") {
            "spawned" => ("running", None),
            "stopped" if !field(payload, "errorMessage").is_empty() => {
                ("failed", Some(field(payload, "errorMessage").to_owned()))
            }
            "stopped" => {
                let status = match field(payload, "status") {
                    "failed" | "errored" => "failed",
                    "stopped" | "cancelled" | "killed" => "stopped",
                    _ => "completed",
                };
                (status, None)
            }
            _ => return,
        };
        let input = json!({"name": name, "subagent_type": name}).to_string();
        self.tool_update(
            id,
            Some("Agent"),
            Some(status),
            Some(limited(&input, TOOL_INPUT_LIMIT)),
            output.as_deref().map(|text| limited(text, TOOL_OUTPUT_LIMIT)),
            step,
        );
    }

    /// First frame of the session chain: create (or resume) answers, then the
    /// model/effort/subscribe writes queue up in order.
    fn zcode_created(&mut self, value: &Value, step: &mut Step) -> Result<(), String> {
        let result = &value["result"];
        self.remote_id = string(&result["session"], "sessionId");
        if self.remote_id.is_empty() {
            return Err("ZCode did not return a session ID".into());
        }
        step.events
            .push(self.event("session", self.remote_id.clone(), None));
        let settings = &result["settings"];
        let current = &result["session"]["model"];
        self.zcode.context_window = context_window_of(settings, current);
        let wanted = mode(&self.config.mode);
        // 3.18.2 reports Plan as build with a hidden planEnabled flag. A resumed
        // Standard session must explicitly clear that flag even when build matches.
        if settings["mode"]["current"].as_str() != Some(wanted) || (wanted == "build" && self.config.resume_id.is_some()) {
            self.zcode.requested_mode = Some(wanted);
            step.write.push(json!({
                "id": ID_MODE, "method": "session/setMode",
                "params": {"sessionId": self.remote_id, "mode": wanted},
            }));
        }
        let entries = settings["model"]["available"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        let wanted = &self.config.model;
        let mut thought = self.config.reasoning_effort.clone();
        if !wanted.is_empty() && wanted != "default" {
            let entry = resolve_catalog_entry(entries, current, wanted);
            let mut reference = match entry {
                Some(entry) => entry["ref"].clone(),
                // A custom model id rides the session's current provider.
                None => json!({"providerId": current["providerId"], "modelId": wanted}),
            };
            // The selection itself must carry the reasoning level: the server
            // validates `options.reasoningLevel` inside setModel and rejects the
            // frame without it, so the later setThoughtLevel cannot repair it.
            // An effort this model does not list falls to its default, and is
            // not sent to setThoughtLevel either, which would fail the run.
            if let Some(entry) = entry {
                thought = thought.filter(|effort| lists_level(entry, effort));
                let default = entry["reasoning"]["defaultLevel"]
                    .as_str()
                    .filter(|level| lists_level(entry, level));
                if let Some(level) = thought.as_deref().or(default) {
                    reference["options"] = json!({"reasoningLevel": level});
                }
            }
            self.zcode.requested_model = Some((
                string(&reference, "providerId"),
                string(&reference, "modelId"),
            ));
            step.write.push(json!({
                "id": ID_MODEL, "method": "session/setModel",
                "params": {"sessionId": self.remote_id, "model": reference},
            }));
        } else if let Some(entry) = entries.iter().find(|entry| same_ref(&entry["ref"], current)) {
            thought = thought.filter(|effort| lists_level(entry, effort));
        }
        if let Some(effort) = thought {
            step.write.push(json!({
                "id": ID_THOUGHT, "method": "session/setThoughtLevel",
                "params": {"sessionId": self.remote_id, "thoughtLevel": effort},
            }));
            self.zcode.requested_thought = Some(effort);
        }
        // Resume cannot carry mcpServers (`session/update` is not implemented),
        // so the fresh per-run server rides `mcp/list`. A required fresh session
        // confirms the inline server the same way: an unreachable one does not
        // fail `session/create`, and the prompt waits until this check settles.
        // An optional fresh bridge (title suggestions) stays inline only.
        // A resume also reconnects the extra stdio servers there, since nothing
        // else can carry them; a fresh session already has them inline.
        // Colab alone on a resume still reconnects, without holding the prompt.
        let resumed = self.config.resume_id.is_some();
        let bridge = self.mcp_server.clone().filter(|_| resumed || self.mcp_required);
        if bridge.is_some() || (resumed && !self.extra_mcp_servers.is_empty()) {
            self.zcode.bridge_pending = bridge.is_some();
            let servers = match bridge {
                Some(server) if !resumed => vec![server],
                _ => self.zcode_mcp_servers(),
            };
            step.write.push(json!({
                "id": ID_MCP, "method": "mcp/list",
                "params": {"workspace": workspace_of(&self.config.cwd),
                           "mode": "connect", "mcpServers": servers},
            }));
        }
        step.write.push(json!({
            "id": ID_SUBSCRIBE, "method": "session/subscribe",
            "params": {"sessionId": self.remote_id, "deliveryKind": "desktop-continuous"},
        }));
        Ok(())
    }

    /// Applies the bridge check, then sends a prompt that was held for it.
    /// A required failure drops the held prompt: the run is not started.
    fn finish_bridge(&mut self, value: &Value, step: &mut Step) -> Result<(), String> {
        let settled = self.zcode_bridge(value);
        self.zcode.bridge_pending = false;
        if let Err(error) = settled {
            self.zcode.prompt_held = false;
            return Err(error);
        }
        if self.zcode.prompt_held {
            self.zcode.prompt_held = false;
            self.zcode_prompt(self.config.prompt.clone(), step);
        }
        Ok(())
    }

    /// Reads the `mcp/list` connect answer. A server that did not come up leaves
    /// the session without host tools: when they are required (a team worker,
    /// or a solo task whose tools are required) the run fails instead of
    /// prompting a session that cannot answer; an optional bridge (title
    /// suggestions) drops out quietly, as the ACP path does. `connecting` counts
    /// as up: the recorded CLI can report it while the handshake finishes, and
    /// this reply is the only check before the prompt.
    fn zcode_bridge(&mut self, value: &Value) -> Result<(), String> {
        let name = self.mcp_server.as_ref().map(|server| field(server, "name")).unwrap_or_default();
        let status = field(&value["result"]["statuses"][name], "status");
        let connected = value.get("error").is_none()
            && (status == "connected" || status == "connecting");
        if connected {
            return Ok(());
        }
        let detail = if let Some(error) = value.get("error") {
            short(field(error, "message"))
        } else if !status.is_empty() {
            format!("the PandaCode tools server reported {status:?}")
        } else {
            "the PandaCode tools server did not report a status".into()
        };
        if self.mcp_required {
            return Err(format!("ZCode cannot load the PandaCode tools this task needs: {detail}"));
        }
        self.mcp_server = None;
        self.mcp_tool_names.clear();
        Ok(())
    }

    /// Writes the prompt (or a steered next turn) as `session/send`.
    pub(super) fn zcode_prompt(&mut self, text: String, step: &mut Step) {
        self.zcode.next_input += 1;
        step.write.push(json!({
            "id": FIRST_PROMPT_ID - 1 + self.zcode.next_input,
            "method": "session/send",
            "params": {
                "sessionId": self.remote_id,
                "content": text,
                "inputId": format!("pandacode-{}", self.zcode.next_input),
            },
        }));
        self.phase = 1;
    }
}

/// Permission answers reuse the option's own `response` object, which carries
/// the exact decision (and any rule updates) the server offered for that button.
pub(super) fn permission_decision(request: &Value, approved: bool) -> Value {
    let options = request["params"]["options"].as_array();
    let kinds: &[&str] = if approved {
        &["allow_once", "allow_always"]
    } else {
        &["deny_once", "deny_always", "reject_once", "reject_always"]
    };
    let selected = kinds.iter().find_map(|kind| {
        options.and_then(|options| {
            options
                .iter()
                .find(|option| option["kind"].as_str() == Some(*kind))
        })
    });
    let decision = selected
        .map(|option| option["response"].clone())
        .unwrap_or_else(|| {
            json!({
                "decision": if approved { "allow" } else { "deny" },
                "reason": if approved { "Approved" } else { "Declined by the user" },
            })
        });
    json!({"id": request["id"], "result": decision})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    fn bundled_candidates_cover_the_desktop_app_bundle() {
        let expected = if cfg!(target_os = "macos") {
            "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs"
        } else {
            "/opt/ZCode/resources/glm/zcode.cjs"
        };
        assert!(bundled_candidates()
            .iter()
            .any(|path| path == Path::new(expected)), "missing {expected}");
    }

    /// Recorded from the CLI bundled with ZCode.app (user-agent ZCode/3.16.3);
    /// session IDs, models and paths anonymized, catalog shortened to one entry.
    fn snapshot() -> Value {
        json!({
            "protocol": {"name": "ZCode Protocol", "version": 1},
            "session": {
                "createdAt": 1792931010147_u64, "mode": "build",
                "model": {"providerId": "omnirouter", "modelId": "zcproxy/GLM-5.3"},
                "sessionId": "sess_540e3d16-8f19-449f-8576-7b0133fea47a",
                "sessionKind": "interactive", "status": "idle", "title": "",
            },
            "settings": {
                "mode": {"current": "build"},
                "model": {"available": [
                    {"ref": {"providerId": "omnirouter", "modelId": "zcproxy/GLM-5.3"},
                     "label": "zcproxy/GLM-5.3", "providerLabel": "OmniRouter",
                     "contextWindow": 200000, "maxOutputTokens": 131072,
                     "reasoning": {"levels": [{"value": "low"}, {"value": "high"}, {"value": "max"}],
                                   "defaultLevel": "max"}}
                ]},
                "thoughtLevel": {"enabled": true, "current": "max",
                                 "available": [{"value": "low"}, {"value": "high"}, {"value": "max"}]},
            },
            "messages": [],
        })
    }

    fn event(kind: &str, payload: Value) -> Value {
        json!({"method": "session/event", "params": {
            "type": kind, "payload": payload, "seq": 1,
            "sessionId": "sess_540e3d16-8f19-449f-8576-7b0133fea47a",
            "turnId": "turn_test", "eventId": "evt", "timestamp": 1,
        }})
    }

    fn created() -> (Protocol, Step) {
        let mut p = Protocol::new(super::super::tests::config("zcode"));
        p.config.cwd = PathBuf::from("/tmp");
        let request = p.initial();
        assert_eq!(request["method"], "session/create");
        assert_eq!(request["params"]["workspace"]["workspaceKey"], "/tmp");
        let step = p
            .receive(json!({"id": ID_CREATE, "result": snapshot()}))
            .unwrap();
        (p, step)
    }

    fn subscribe_acked(p: &mut Protocol) -> Step {
        p.receive(json!({"id": ID_SUBSCRIBE, "result": {"eventSeq": 0, "events": []}}))
            .unwrap()
    }

    #[test]
    fn create_chains_model_effort_and_subscribe_before_prompting() {
        let (mut p, _) = created();
        p.config.model = "zcproxy/GLM-5.3".into();
        p.config.reasoning_effort = Some("high".into());
        let step = p.receive(json!({"id": ID_CREATE, "result": snapshot()})).unwrap();
        assert_eq!(step.events[0].kind, "session");
        assert_eq!(step.write.len(), 3);
        assert_eq!(step.write[0]["method"], "session/setModel");
        assert_eq!(step.write[0]["params"]["model"]["modelId"], "zcproxy/GLM-5.3");
        assert_eq!(step.write[0]["params"]["model"]["options"]["reasoningLevel"], "high");
        assert_eq!(step.write[1]["method"], "session/setThoughtLevel");
        assert_eq!(step.write[1]["params"]["thoughtLevel"], "high");
        assert_eq!(step.write[2]["method"], "session/subscribe");

        let step = p.receive(json!({"id": ID_MODEL, "result": snapshot()})).unwrap();
        assert!(step.write.is_empty());
        assert!(p.receive(json!({"id": ID_THOUGHT, "result": snapshot()})).is_err(), "thought not applied yet");
        let mut applied = snapshot();
        applied["settings"]["thoughtLevel"]["current"] = json!("high");
        let step = p.receive(json!({"id": ID_THOUGHT, "result": applied})).unwrap();
        assert!(step.write.is_empty());
        let prompt = subscribe_acked(&mut p);
        assert_eq!(prompt.write[0]["method"], "session/send");
        assert_eq!(prompt.write[0]["params"]["inputId"], "pandacode-1");
        assert_eq!(p.phase, 1);
    }

    /// The bridge entry `mcp_host::zcode_config` produces, as recorded from the
    /// live CLI handshake: session isolation and always-load are what put the
    /// tools in the model's list.
    /// Dummy loopback entry. The bearer is a fixture literal, not a credential.
    fn bridge() -> Value {
        json!({"type":"http","name":"pandacode_architect","url":"http://127.0.0.1:9/mcp",
            "headers":[{"name":"Authorization","value":"Bearer test-token"}],
            "isolation":"session","alwaysLoad":true})
    }

    fn bridged(resume: bool) -> Protocol {
        let mut config = super::super::tests::config("zcode");
        config.cwd = PathBuf::from("/tmp");
        if resume {
            config.resume_id = Some("sess_saved".into());
        }
        let mut p = Protocol::new(config);
        p.mcp_server = Some(bridge());
        p
    }

    #[test]
    fn a_fresh_session_carries_the_tools_server_inline() {
        let p = bridged(false);
        let request = p.initial();
        assert_eq!(request["method"], "session/create");
        assert_eq!(request["params"]["mcpServers"][0]["name"], "pandacode_architect");
        assert_eq!(request["params"]["mcpServers"][0]["isolation"], "session");
        assert_eq!(request["params"]["mcpServers"][0]["alwaysLoad"], true);
        assert_eq!(request["params"]["mcpServers"][0]["url"], "http://127.0.0.1:9/mcp");
        assert_eq!(request["params"]["mcpServers"][0]["headers"][0]["value"], "Bearer test-token");
        let wire = request.to_string();
        assert!(!wire.contains("sk-") && !wire.contains("ghp_") && !wire.contains("github_pat_"));
        // A run without host tools keeps the field off the wire.
        let mut plain = Protocol::new(super::super::tests::config("zcode"));
        plain.config.cwd = PathBuf::from("/tmp");
        assert!(plain.initial()["params"].get("mcpServers").is_none());
    }

    fn stdio() -> [super::super::mcp_host::Stdio; 1] {
        [super::super::mcp_host::Stdio::new(super::super::mcp_host::COLAB_MCP, "/bin/uvx".into(), vec!["colab-mcp".into()])]
    }
    /// What `run_process_with_tools` hands ZCode.
    fn colab() -> Vec<Value> {
        super::super::mcp_host::zcode_mcp_servers(&stdio())
    }

    fn assert_zcode_colab(entry: &Value) {
        assert_eq!(entry["name"], "colab-mcp");
        assert_eq!(entry["command"], "/bin/uvx");
        assert_eq!(entry["args"], json!(["colab-mcp"]));
        assert_eq!(entry["env"], json!([]));
        assert_eq!(entry["isolation"], "session");
        assert_eq!(entry["alwaysLoad"], true);
    }

    #[test]
    fn colab_mcp_rides_beside_the_bridge_in_create_and_resume() {
        let mut p = bridged(false);
        p.extra_mcp_servers = colab();
        let servers = &p.initial()["params"]["mcpServers"];
        assert_eq!(servers.as_array().unwrap().len(), 2);
        assert_eq!(servers[0], bridge());
        assert_zcode_colab(&servers[1]);
        // Plain ACP entries are scoped the same way.
        p.extra_mcp_servers = super::super::mcp_host::acp_mcp_servers(&stdio());
        assert_zcode_colab(&p.initial()["params"]["mcpServers"][1]);
        // Colab alone still attaches the field.
        let mut alone = Protocol::new(super::super::tests::config("zcode"));
        alone.config.cwd = PathBuf::from("/tmp");
        alone.extra_mcp_servers = colab();
        assert_eq!(alone.initial()["params"]["mcpServers"], json!(colab()));
        // A resume reconnects Colab with the bridge through `mcp/list`.
        let mut p = bridged(true);
        p.extra_mcp_servers = colab();
        let step = p.receive(json!({"id": ID_CREATE, "result": snapshot()})).unwrap();
        let connect = step.write.iter().find(|write| write["method"] == "mcp/list").unwrap();
        assert_eq!(connect["params"]["mcpServers"][0], bridge());
        assert_zcode_colab(&connect["params"]["mcpServers"][1]);
        assert!(p.zcode.bridge_pending);
        // Colab alone on a resume reconnects too, without holding the prompt.
        let mut alone = Protocol::new(super::super::tests::config("zcode"));
        alone.config.cwd = PathBuf::from("/tmp");
        alone.config.resume_id = Some("sess_saved".into());
        alone.extra_mcp_servers = colab();
        let step = alone.receive(json!({"id": ID_CREATE, "result": snapshot()})).unwrap();
        let connect = step.write.iter().find(|write| write["method"] == "mcp/list").expect("Colab reconnects");
        assert_eq!(connect["params"]["mcpServers"].as_array().unwrap().len(), 1);
        assert_zcode_colab(&connect["params"]["mcpServers"][0]);
        assert!(!alone.zcode.bridge_pending);
        // Off by default: the create carries exactly the bridge, a resume no extra server.
        assert_eq!(bridged(false).initial()["params"]["mcpServers"], json!([bridge()]));
        let mut plain = bridged(true);
        let step = plain.receive(json!({"id": ID_CREATE, "result": snapshot()})).unwrap();
        let connect = step.write.iter().find(|write| write["method"] == "mcp/list").unwrap();
        assert_eq!(connect["params"]["mcpServers"], json!([bridge()]));
    }

    #[test]
    fn a_resumed_session_reconnects_its_per_run_tools_server() {
        let mut p = bridged(true);
        assert_eq!(p.initial()["method"], "session/resume");
        let step = p.receive(json!({"id": ID_CREATE, "result": snapshot()})).unwrap();
        let connect = step
            .write
            .iter()
            .find(|write| write["method"] == "mcp/list")
            .expect("the fresh bridge rides mcp/list after a resume");
        assert_eq!(connect["params"]["mode"], "connect");
        assert_eq!(connect["params"]["mcpServers"][0]["name"], "pandacode_architect");
        assert_eq!(connect["params"]["workspace"]["workspaceKey"], "/tmp");
        assert!(step.write.iter().any(|write| write["method"] == "session/subscribe"));
        let step = p
            .receive(json!({"id": ID_MCP, "result": {"statuses": {
                "pandacode_architect": {"status": "connected", "toolCount": 2}}}}))
            .unwrap();
        assert!(step.write.is_empty());
        assert!(p.mcp_server.is_some(), "a connected bridge stays for the run");
    }

    #[test]
    fn a_failed_reconnect_fails_required_runs_and_drops_optional_tools() {
        let failed = json!({"id": ID_MCP, "result": {"statuses": {
            "pandacode_architect": {"status": "failed", "error": "dial failed"}}}});
        let mut required = bridged(true);
        required.mcp_required = true;
        required.mcp_tool_names.insert("mcp__pandacode_architect__dispatch_worker".into());
        required.receive(json!({"id": ID_CREATE, "result": snapshot()})).unwrap();
        assert!(required.receive(failed).is_err(), "a team worker cannot run without its tools");

        // A CLI without `mcp/list` answers an error; an optional bridge (title
        // suggestions) drops out quietly and the run carries on.
        let mut optional = bridged(true);
        optional.mcp_required = false;
        optional.mcp_tool_names.insert("mcp__pandacode_architect__suggest_title".into());
        optional.receive(json!({"id": ID_CREATE, "result": snapshot()})).unwrap();
        let step = optional
            .receive(json!({"id": ID_MCP, "error": {"code": -32601, "message": "Method not found"}}))
            .unwrap();
        assert!(step.write.is_empty());
        assert!(optional.mcp_server.is_none());
        assert!(optional.mcp_tool_names.is_empty());
    }

    #[test]
    fn the_prompt_waits_until_a_required_bridge_settles() {
        let connected = json!({"id": ID_MCP, "result": {"statuses": {
            "pandacode_architect": {"status": "connected", "toolCount": 1}}}});
        let mut fresh = bridged(false);
        fresh.mcp_required = true;
        fresh.config.prompt = "dispatch".into();
        let step = fresh.receive(json!({"id": ID_CREATE, "result": snapshot()})).unwrap();
        let connect_at = step.write.iter().position(|write| write["method"] == "mcp/list").unwrap();
        let subscribe_at = step.write.iter().position(|write| write["method"] == "session/subscribe").unwrap();
        assert!(connect_at < subscribe_at, "the check is on the wire before subscribe");
        // Subscribe can answer first. The prompt stays held until the bridge does.
        let early = fresh
            .receive(json!({"id": ID_SUBSCRIBE, "result": {"eventSeq": 0, "events": []}}))
            .unwrap();
        assert!(early.write.iter().all(|write| write["method"] != "session/send"));
        let step = fresh.receive(connected).unwrap();
        assert_eq!(step.write[0]["method"], "session/send");
        assert_eq!(step.write[0]["params"]["content"], "dispatch");

        let mut resumed = bridged(true);
        resumed.mcp_required = true;
        resumed.config.prompt = "follow up".into();
        resumed.receive(json!({"id": ID_CREATE, "result": snapshot()})).unwrap();
        let early = resumed
            .receive(json!({"id": ID_SUBSCRIBE, "result": {"eventSeq": 0, "events": []}}))
            .unwrap();
        assert!(early.write.is_empty());
        let failed = json!({"id": ID_MCP, "result": {"statuses": {
            "pandacode_architect": {"status": "failed", "error": "dial failed"}}}});
        let Err(error) = resumed.receive(failed) else {
            panic!("a required bridge failure must stop the run before the prompt");
        };
        assert!(error.contains("cannot load"), "{error}");

        // An optional resume that loses the bridge still prompts, once the check
        // has dropped the tools. A fresh optional bridge never sends mcp/list.
        let mut optional = bridged(true);
        optional.mcp_required = false;
        optional.config.prompt = "title".into();
        optional.receive(json!({"id": ID_CREATE, "result": snapshot()})).unwrap();
        optional
            .receive(json!({"id": ID_SUBSCRIBE, "result": {"eventSeq": 0, "events": []}}))
            .unwrap();
        let step = optional
            .receive(json!({"id": ID_MCP, "error": {"code": -32601, "message": "Method not found"}}))
            .unwrap();
        assert_eq!(step.write[0]["method"], "session/send");
        assert!(optional.mcp_server.is_none());

        let mut titles = bridged(false);
        titles.mcp_required = false;
        titles.config.prompt = "title".into();
        let step = titles.receive(json!({"id": ID_CREATE, "result": snapshot()})).unwrap();
        assert!(step.write.iter().all(|write| write["method"] != "mcp/list"));
        let prompt = titles
            .receive(json!({"id": ID_SUBSCRIBE, "result": {"eventSeq": 0, "events": []}}))
            .unwrap();
        assert_eq!(prompt.write[0]["method"], "session/send");
    }

    #[test]
    fn a_dead_resume_keeps_a_required_bridge_on_the_fresh_create() {
        let mut p = bridged(true);
        p.mcp_required = true;
        assert!(p.initial()["params"].get("mcpServers").is_none());
        let step = p
            .receive(json!({"id": ID_CREATE, "error": {"code": -32004, "message": "Session not found: sess_saved"}}))
            .unwrap();
        assert_eq!(step.write[0]["method"], "session/create");
        assert_eq!(step.write[0]["params"]["mcpServers"][0]["url"], "http://127.0.0.1:9/mcp");
        assert_eq!(step.write[0]["params"]["mcpServers"][0]["headers"][0]["value"], "Bearer test-token");
        let step = p.receive(json!({"id": ID_CREATE, "result": snapshot()})).unwrap();
        assert!(step.write.iter().any(|write| write["method"] == "mcp/list"));
    }

    #[test]
    fn set_model_without_an_effort_sends_the_catalog_default_level() {
        let (mut p, _) = created();
        p.config.model = "zcproxy/GLM-5.3".into();
        let step = p.receive(json!({"id": ID_CREATE, "result": snapshot()})).unwrap();
        assert_eq!(step.write[0]["params"]["model"]["options"]["reasoningLevel"], "max");

        // A custom id has no catalog entry to default from; the bare
        // reference stands and the server validates it.
        let mut custom = super::super::tests::config("zcode");
        custom.cwd = PathBuf::from("/tmp");
        custom.model = "pandacode/custom-model".into();
        let mut p = Protocol::new(custom);
        assert_eq!(p.initial()["method"], "session/create");
        let step = p.receive(json!({"id": ID_CREATE, "result": snapshot()})).unwrap();
        assert_eq!(step.write[0]["method"], "session/setModel");
        assert!(step.write[0]["params"]["model"].get("options").is_none());
    }

    #[test]
    fn set_model_sends_an_explicit_effort_only_when_the_catalog_lists_it() {
        let chain = |model: &str, effort: &str, snapshot: Value| {
            let mut config = super::super::tests::config("zcode");
            config.cwd = PathBuf::from("/tmp");
            config.model = model.into();
            config.reasoning_effort = Some(effort.into());
            let mut p = Protocol::new(config);
            p.receive(json!({"id": ID_CREATE, "result": snapshot})).unwrap().write
        };
        let glm = "zcproxy/GLM-5.3";

        let write = chain(glm, "low", snapshot());
        assert_eq!(write[0]["params"]["model"]["options"]["reasoningLevel"], "low");
        assert_eq!(write[1]["params"]["thoughtLevel"], "low");

        // An unlisted effort takes the model's default, and setThoughtLevel is
        // skipped: the server would not apply it and the run would fail.
        let write = chain(glm, "medium", snapshot());
        assert_eq!(write[0]["params"]["model"]["options"]["reasoningLevel"], "max");
        assert_eq!(write[1]["method"], "session/subscribe");

        // A model with no levels has no default to fall back to.
        let mut levelless = snapshot();
        levelless["settings"]["model"]["available"][0]["reasoning"] = json!({"levels": []});
        let write = chain(glm, "high", levelless);
        assert!(write[0]["params"]["model"].get("options").is_none());
        assert_eq!(write[1]["method"], "session/subscribe");

        // A default the entry does not list is not sent either.
        let mut stale = snapshot();
        stale["settings"]["model"]["available"][0]["reasoning"]["defaultLevel"] = json!("ultra");
        let write = chain(glm, "medium", stale);
        assert!(write[0]["params"]["model"].get("options").is_none());

        // A custom id has no entry to check: no options, setThoughtLevel still runs.
        let write = chain("pandacode/custom-model", "high", snapshot());
        assert!(write[0]["params"]["model"].get("options").is_none());
        assert_eq!(write[1]["params"]["thoughtLevel"], "high");
    }

    #[test]
    fn default_model_sends_directly_and_custom_ids_ride_the_current_provider() {
        let (mut p, step) = created();
        assert_eq!(step.write.len(), 1, "no model or effort is configured");
        assert_eq!(step.write[0]["method"], "session/subscribe");
        subscribe_acked(&mut p);
        let mut custom = super::super::tests::config("zcode");
        custom.cwd = PathBuf::from("/tmp");
        custom.model = "pandacode/custom-model".into();
        let mut p = Protocol::new(custom);
        assert_eq!(p.initial()["method"], "session/create");
        let step = p.receive(json!({"id": ID_CREATE, "result": snapshot()})).unwrap();
        assert_eq!(step.write[0]["params"]["model"]["providerId"], "omnirouter");
        assert_eq!(step.write[0]["params"]["model"]["modelId"], "pandacode/custom-model");
    }

    #[test]
    fn resume_reuses_the_saved_session() {
        let mut config = super::super::tests::config("zcode");
        config.resume_id = Some("sess_saved".into());
        let p = Protocol::new(config);
        let request = p.initial();
        assert_eq!(request["method"], "session/resume");
        assert_eq!(request["params"]["sessionId"], "sess_saved");
        assert_eq!(p.cancel()["method"], "session/stop");
        // Protocol::new pre-seeds the resume id, so a stop before the snapshot
        // already names the saved session.
        assert_eq!(p.cancel()["params"]["sessionId"], "sess_saved");
    }

    #[test]
    fn a_dead_resume_id_falls_back_to_a_fresh_create() {
        let mut config = super::super::tests::config("zcode");
        config.cwd = PathBuf::from("/tmp");
        config.resume_id = Some("sess_gone".into());
        let mut p = Protocol::new(config);
        assert_eq!(p.initial()["method"], "session/resume");
        let step = p
            .receive(json!({"id": ID_CREATE, "error": {"code": -32004,
                            "message": "Session not found: sess_gone"}}))
            .unwrap();
        assert_eq!(step.write[0]["method"], "session/create");
        assert!(p.config.resume_id.is_none(), "the dead id is dropped");

        // The fresh create answers like any other and runs the chain.
        let step = p.receive(json!({"id": ID_CREATE, "result": snapshot()})).unwrap();
        assert_eq!(step.events[0].kind, "session");
        assert_eq!(step.write[0]["method"], "session/subscribe");

        // A create's own error is never swallowed into another create.
        let Err(message) = p
            .receive(json!({"id": ID_CREATE, "error": {"code": -32004,
                            "message": "Session not found: sess_540e3d16-8f19-449f-8576-7b0133fea47a"}}))
        else {
            panic!("a fresh create's error must fail the run");
        };
        assert_eq!(message, "Session not found: sess_540e3d16-8f19-449f-8576-7b0133fea47a");
    }

    #[test]
    fn a_dead_resume_id_reports_the_lost_history() {
        let mut config = super::super::tests::config("zcode");
        config.cwd = PathBuf::from("/tmp");
        config.resume_id = Some("sess_gone".into());
        let mut p = Protocol::new(config);
        let step = p
            .receive(json!({"id": ID_CREATE, "error": {"code": -32004,
                            "message": "Session not found: sess_gone"}}))
            .unwrap();
        assert_eq!(step.events.len(), 1);
        assert_eq!(step.events[0].kind, "status");
        assert!(step.events[0].text.contains("without its history"), "{}", step.events[0].text);
    }

    #[test]
    fn recorded_stream_and_tool_frames_drive_the_shared_transcript() {
        let (mut p, _) = created();
        subscribe_acked(&mut p);
        let reasoning = p
            .receive(event("model.streaming", json!({"assistantMessageId": "msg_a", "delta": "th", "kind": "reasoning_delta"})))
            .unwrap();
        assert!(reasoning.events.iter().any(|e| e.kind == "status" && e.text == "Reasoning"));
        let text = p
            .receive(event("model.streaming", json!({"assistantMessageId": "msg_a", "delta": "Hello", "kind": "text_delta"})))
            .unwrap();
        assert!(text.events.iter().any(|e| e.kind == "text" && e.text == "Hello"));
        let more = p
            .receive(event("model.streaming", json!({"assistantMessageId": "msg_a", "delta": " world", "kind": "text_delta"})))
            .unwrap();
        assert_eq!(more.events.iter().filter(|e| e.kind == "text").map(|e| e.text.as_str()).collect::<String>(), " world");
        let started = p
            .receive(event("tool.updated", json!({"toolCallId": "call_1", "toolName": "Bash", "kind": "started", "readOnly": false})))
            .unwrap();
        let tool = started.events.iter().find_map(|e| e.tool.as_ref()).unwrap();
        assert_eq!(tool.status, "running");
        let done = p
            .receive(event("tool.updated", json!({"toolCallId": "call_1", "toolName": "Bash", "kind": "result",
                "result": {"success": true, "content": "(Bash completed with no output)"}, "duration": 1275})))
            .unwrap();
        let tool = done.events.iter().find_map(|e| e.tool.as_ref()).unwrap();
        assert_eq!(tool.status, "completed");
        assert!(tool.output.contains("no output"));
    }

    #[test]
    fn recorded_turn_completed_finishes_with_usage_and_reports_failures() {
        let (mut p, _) = created();
        subscribe_acked(&mut p);
        let completed = p
            .receive(event("turn.completed", json!({
                "response": "ok", "tokenCount": 49030,
                "usage": {"inputTokens": 49003, "outputTokens": 27, "totalTokens": 49030, "cacheReadTokens": 64},
                "resultType": "success", "duration": 17944, "inputId": "pandacode-1",
            })))
            .unwrap();
        assert!(completed.done);
        let usage = completed.events.iter().find(|e| e.kind == "usage").unwrap();
        assert_eq!(usage.data.as_ref().unwrap()["usedTokens"], 49003);

        // A stale completed frame from an earlier input never ends the run.
        let (mut p, _) = created();
        subscribe_acked(&mut p);
        let mut stale = event("turn.completed", json!({"resultType": "success", "inputId": "pandacode-9"}));
        stale["params"]["payload"]["tokenCount"] = json!(1);
        let step = p.receive(stale).unwrap();
        assert!(!step.done);

        let (mut p, _) = created();
        subscribe_acked(&mut p);
        p.receive(event("turn.failed", json!({"error": "429 rate limited", "turnPhase": "model"}))).unwrap();
        let Err(failed) = p.receive(event(
            "turn.completed",
            json!({"resultType": "error_during_execution", "inputId": "pandacode-1"}),
        )) else {
            panic!("an errored turn must fail the run");
        };
        assert_eq!(failed, "429 rate limited");
        let Err(stopped) = p.receive(event(
            "turn.completed",
            json!({"resultType": "cancelled", "inputId": "pandacode-1"}),
        )) else {
            panic!("a cancelled turn must fail the run");
        };
        assert_eq!(stopped, "ZCode run was stopped");
    }

    #[test]
    fn permissions_round_trip_through_the_offered_response() {
        let (mut p, _) = created();
        subscribe_acked(&mut p);
        let request = p
            .receive(json!({"id": "perm_1", "method": "interaction/requestPermission", "params": {
                "requestId": "perm_1", "sessionId": "sess_test", "toolCallId": "call_1",
                "toolName": "Bash", "reason": "High risk tools require explicit approval",
                "riskLevel": "high", "input": {"command": "printf 'ok' > out.txt"},
                "options": [
                    {"optionId": "allow_once", "kind": "allow_once", "name": "Allow once",
                     "response": {"decision": "allow", "reason": "Approved once"}},
                    {"optionId": "deny_once", "kind": "deny_once", "name": "Deny",
                     "response": {"decision": "deny", "reason": "Denied"}},
                ],
            }}))
            .unwrap();
        assert!(request.events.iter().any(|e| e.kind == "approval"));
        let id = request.events.iter().find(|e| e.kind == "approval").unwrap().request_id.clone().unwrap();
        assert_eq!(
            p.approve(&id, true).unwrap(),
            json!({"id": "perm_1", "result": {"decision": "allow", "reason": "Approved once"}}),
        );
        let request = p
            .receive(json!({"id": "perm_2", "method": "interaction/requestPermission", "params": {
                "requestId": "perm_2", "sessionId": "sess_test", "toolCallId": "call_2",
                "toolName": "Bash", "reason": "risk", "riskLevel": "high", "input": {},
                "options": [{"optionId": "allow_once", "kind": "allow_once", "name": "Allow once",
                             "response": {"decision": "allow"}}],
            }}))
            .unwrap();
        let id = request.events.iter().find(|e| e.kind == "approval").unwrap().request_id.clone().unwrap();
        let denied = p.approve(&id, false).unwrap();
        assert_eq!(denied["result"]["decision"], "deny", "falls back to a plain denial");
        // Interactive questions decline for now; unknown reverse requests get -32601.
        let question = p
            .receive(json!({"id": "q_1", "method": "interaction/requestUserInput", "params": {"requestId": "q_1"}}))
            .unwrap();
        assert_eq!(question.write[0]["result"]["action"], "decline");
        let unknown = p
            .receive(json!({"id": "r_1", "method": "session/requestRuntimePreferences", "params": {}}))
            .unwrap();
        assert_eq!(unknown.write[0]["error"]["code"], -32601);
    }

    #[test]
    fn steered_messages_wait_for_the_next_turn() {
        let (mut p, _) = created();
        subscribe_acked(&mut p);
        let (tx, mut reply) = tokio::sync::oneshot::channel();
        let step = p.steer("steer-1".into(), "also check tests".into(), tx);
        assert!(step.write.is_empty(), "zcode holds steers for the next turn");
        assert_eq!(reply.try_recv().unwrap().unwrap()["mode"], "next-turn");
        // The completed turn re-opens the run and writes the steered turn itself.
        let turn = p
            .receive(event("turn.completed", json!({"resultType": "success", "inputId": "pandacode-1"})))
            .unwrap();
        assert!(!turn.done);
        assert_eq!(turn.write[0]["method"], "session/send");
        assert_eq!(turn.write[0]["params"]["content"], "also check tests");
        assert_eq!(turn.write[0]["params"]["inputId"], "pandacode-2");
        let ack = p.receive(json!({"id": 7, "result": {"accepted": true}})).unwrap();
        assert!(ack.write.is_empty());
        let done = p
            .receive(event("turn.completed", json!({"resultType": "success", "inputId": "pandacode-2"})))
            .unwrap();
        assert!(done.done);
    }

    #[test]
    fn resumed_sessions_get_the_selected_mode_reapplied() {
        for (mode_name, wire_mode) in [("auto", "edit"), ("full", "yolo")] {
            let mut config = super::super::tests::config("zcode");
            config.cwd = PathBuf::from("/tmp");
            config.resume_id = Some("sess_saved".into());
            config.mode = mode_name.into();
            let mut p = Protocol::new(config);
            assert_eq!(p.initial()["method"], "session/resume");
            let step = p.receive(json!({"id": ID_CREATE, "result": snapshot()})).unwrap();
            let set_mode = step.write.iter()
                .find(|frame| frame["method"] == "session/setMode")
                .expect("setMode on resume");
            assert_eq!(set_mode["params"]["mode"], wire_mode);
            let Err(err) = p.receive(json!({"id": ID_MODE, "result": snapshot()})) else {
                panic!("{wire_mode} mismatch must fail");
            };
            assert_eq!(err, "ZCode did not apply the selected access mode");
            let mut applied = snapshot();
            applied["settings"]["mode"]["current"] = json!(wire_mode);
            let step = p.receive(json!({"id": ID_MODE, "result": applied})).unwrap();
            assert!(step.write.iter().all(|frame| frame["method"] != "session/setMode"));
        }
        // A create whose snapshot already matches sends no setMode.
        let (mut p, _) = created();
        subscribe_acked(&mut p);
    }

    #[test]
    fn resumed_standard_clears_hidden_plan_before_model_and_subscribe() {
        let mut config = super::super::tests::config("zcode");
        config.cwd = PathBuf::from("/tmp");
        config.resume_id = Some("sess_saved".into());
        config.mode = "ask".into();
        config.model = "zcproxy/GLM-5.3".into();
        let mut p = Protocol::new(config);
        assert_eq!(p.initial()["method"], "session/resume");
        let step = p.receive(json!({"id": ID_CREATE, "result": snapshot()})).unwrap();
        assert_eq!(step.write.iter().map(|frame| field(frame, "method")).collect::<Vec<_>>(), ["session/setMode", "session/setModel", "session/subscribe"]);
        assert_eq!(step.write[0]["params"]["mode"], "build");
        assert!(p.receive(json!({"id": ID_MODE, "result": snapshot()})).is_ok());

        // A matching fresh session needs no reset.
        let (mut p, step) = created();
        assert!(step.write.iter().all(|frame| frame["method"] != "session/setMode"));
        subscribe_acked(&mut p);
    }

    #[test]
    fn plan_mode_accepts_3182_build_snapshot_and_rejects_other_modes() {
        let mut config = super::super::tests::config("zcode");
        config.cwd = PathBuf::from("/tmp");
        config.resume_id = Some("sess_saved".into());
        config.mode = "plan".into();
        let mut p = Protocol::new(config);
        let step = p.receive(json!({"id": ID_CREATE, "result": snapshot()})).unwrap();
        let set_mode = step.write.iter()
            .find(|frame| frame["method"] == "session/setMode")
            .expect("setMode for plan");
        assert_eq!(set_mode["params"]["mode"], "plan");
        // Recorded 3.18.2 reply: no error, mode still reports "build" while planEnabled is true.
        let reply_3182 = json!({
            "id": ID_MODE,
            "result": {
                "session": {"mode": "build", "model": {"providerId": "bigmodel-standard-api", "modelId": "GLM-5.3"}},
                "settings": {"mode": {"current": "build"}},
            }
        });
        assert!(p.receive(reply_3182).unwrap().write.is_empty());
        // Older builds that report "plan" directly still pass.
        let mut reply_plan = snapshot();
        reply_plan["settings"]["mode"]["current"] = json!("plan");
        assert!(p.receive(json!({"id": ID_MODE, "result": reply_plan})).is_ok());
        // Any other reported mode (or missing mode) still fails.
        let mut wrong = snapshot();
        wrong["settings"]["mode"]["current"] = json!("yolo");
        assert_eq!(
            p.receive(json!({"id": ID_MODE, "result": wrong})).err().as_deref(),
            Some("ZCode did not apply the selected access mode")
        );
        assert_eq!(
            p.receive(json!({"id": ID_MODE, "result": {"settings": {}}})).err().as_deref(),
            Some("ZCode did not apply the selected access mode")
        );
    }

    #[test]
    fn full_access_answers_policy_requests_with_the_offered_once_allow() {
        let mut config = super::super::tests::config("zcode");
        config.cwd = PathBuf::from("/tmp");
        config.mode = "full".into();
        let mut p = Protocol::new(config);
        p.initial();
        p.receive(json!({"id": ID_CREATE, "result": snapshot()})).unwrap();
        let step = p
            .receive(json!({"id": "perm_1", "method": "interaction/requestPermission", "params": {
                "requestId": "perm_1", "sessionId": "sess_test", "toolCallId": "call_1",
                "toolName": "Bash", "reason": "Organization policy", "riskLevel": "medium",
                "input": {"command": "ls"},
                "options": [
                    {"optionId": "allow_once", "kind": "allow_once", "name": "Allow once",
                     "response": {"decision": "allow", "reason": "Approved once"}},
                    {"optionId": "allow_project", "kind": "allow_always", "name": "Always",
                     "response": {"decision": "allow", "permissionUpdates": [{"type": "addRules"}]}},
                ],
            }}))
            .unwrap();
        assert!(!step.events.iter().any(|e| e.kind == "approval"), "Full access does not prompt");
        assert_eq!(step.write[0]["result"]["decision"], "allow");
        assert!(
            step.write[0]["result"].get("permissionUpdates").is_none(),
            "never a standing grant",
        );
    }

    #[test]
    fn full_access_asks_when_only_a_lasting_allow_is_offered() {
        let mut config = super::super::tests::config("zcode");
        config.cwd = PathBuf::from("/tmp");
        config.mode = "full".into();
        let mut p = Protocol::new(config);
        p.initial();
        p.receive(json!({"id": ID_CREATE, "result": snapshot()})).unwrap();
        let step = p
            .receive(json!({"id": "perm_1", "method": "interaction/requestPermission", "params": {
                "requestId": "perm_1", "sessionId": "sess_test", "toolCallId": "call_1",
                "toolName": "Bash", "reason": "Organization policy", "riskLevel": "medium",
                "input": {"command": "ls"},
                "options": [
                    {"optionId": "allow_project", "kind": "allow_always", "name": "Always",
                     "response": {"decision": "allow", "permissionUpdates": [{"type": "addRules"}]}},
                ],
            }}))
            .unwrap();
        assert!(step.write.is_empty(), "never granted automatically");
        let approval = step.events.iter().find(|e| e.kind == "approval").expect("asks instead");
        let data = approval.data.as_ref().unwrap();
        assert_eq!(data[super::super::LASTING_ONLY], true);
        assert_eq!(data[super::super::LASTING_DECLINABLE], true);
        // The automatic decline answers with a plain denial, no rule updates.
        let id = approval.request_id.clone().unwrap();
        let denied = p.approve(&id, false).unwrap();
        assert_eq!(denied["result"]["decision"], "deny");
        assert!(denied["result"].get("permissionUpdates").is_none());
    }

    #[test]
    fn subagent_lifecycle_becomes_an_agent_tool() {
        let (mut p, _) = created();
        let step = p
            .receive(event("subagent.lifecycle", json!({
                "phase": "spawned", "agentId": "agt_1", "agentType": "explore",
                "childSessionId": "sess_child", "background": false,
            })))
            .unwrap();
        let tool = step.events.iter().find_map(|e| e.tool.as_ref()).expect("agent tool");
        assert_eq!(tool.name, "Agent");
        assert_eq!(tool.status, "running");
        assert_eq!(tool.id, "agt_1");
        assert!(
            step.events.iter().any(|e| e.kind == "subagent"),
            "the existing observer publishes the child",
        );
        let stopped = p
            .receive(event("subagent.lifecycle", json!({
                "phase": "stopped", "agentId": "agt_1", "agentType": "explore",
                "childSessionId": "sess_child", "background": false, "status": "completed",
            })))
            .unwrap();
        let tool = stopped.events.iter().find_map(|e| e.tool.as_ref()).expect("completed");
        assert_eq!(tool.status, "completed");
        let failed = p
            .receive(event("subagent.lifecycle", json!({
                "phase": "stopped", "agentId": "agt_2", "errorMessage": "timed out",
                "childSessionId": "sess_other", "background": true,
            })))
            .unwrap();
        let tool = failed.events.iter().find_map(|e| e.tool.as_ref()).expect("failed");
        assert_eq!(tool.status, "failed");
        assert!(tool.output.contains("timed out"));
    }

    #[test]
    fn checkpoint_created_is_a_status_line() {
        let (mut p, _) = created();
        let step = p
            .receive(event("checkpoint.created", json!({"checkpointId": "cp_9"})))
            .unwrap();
        assert!(step.events.iter().any(|e| e.kind == "status" && e.text.contains("cp_9")));
        let empty = p.receive(event("checkpoint.created", json!({}))).unwrap();
        assert!(!empty.events.iter().any(|e| e.kind == "status"));
    }

    #[test]
    fn catalog_effort_values_are_validated_before_use() {
        let mut mixed = snapshot();
        mixed["settings"]["model"]["available"][0]["reasoning"]["levels"] = json!([
            {"label": "no value"}, {"value": "高"}, {"value": "with space"}, {"value": "max"},
        ]);
        mixed["settings"]["model"]["available"][0]["reasoning"]["defaultLevel"] = json!("高");
        let models = parse_models(&mixed).unwrap();
        assert_eq!(
            models[1]
                .reasoning_efforts
                .iter()
                .map(|e| e.id.as_str())
                .collect::<Vec<_>>(),
            ["max"],
        );
        assert_eq!(models[1].default_reasoning_effort.as_deref(), None);
    }

    #[test]
    fn parse_models_reads_labels_efforts_and_context_windows() {
        let models = parse_models(&snapshot()).unwrap();
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "default");
        assert_eq!(models[1].id, "zcproxy/GLM-5.3");
        assert_eq!(models[1].description, "OmniRouter");
        assert_eq!(models[1].context_window, Some(200000));
        assert_eq!(
            models[1]
                .reasoning_efforts
                .iter()
                .map(|e| e.id.as_str())
                .collect::<Vec<_>>(),
            ["low", "high", "max"]
        );
        assert_eq!(models[1].default_reasoning_effort.as_deref(), Some("max"));
        let mut broken = snapshot();
        broken["settings"]["model"] = json!("not-a-catalog");
        assert!(parse_models(&broken).is_err());
    }

    #[test]
    fn repeated_catalog_labels_are_qualified_and_resolved_across_providers() {
        let mut multi = snapshot();
        multi["session"]["model"] = json!({"providerId": "bigmodel-standard-api-2", "modelId": "GLM-5.3"});
        multi["settings"]["model"]["available"] = json!([
            {"ref": {"providerId": "bigmodel-standard-api", "modelId": "GLM-5.3"},
             "label": "GLM-5.3", "providerLabel": "BigModel API",
             "contextWindow": 200000,
             "reasoning": {"levels": [{"value": "low"}, {"value": "max"}], "defaultLevel": "max"}},
            {"ref": {"providerId": "bigmodel-standard-api-2", "modelId": "GLM-5.3"},
             "label": "GLM-5.3", "providerLabel": "BigModel API 2",
             "contextWindow": 200000,
             "reasoning": {"levels": [{"value": "low"}, {"value": "high"}], "defaultLevel": "high"}},
            {"ref": {"providerId": "", "modelId": "GLM-5.3"},
             "label": "GLM-5.3", "providerLabel": "Broken", "contextWindow": 200000},
            {"ref": {"providerId": "bigmodel-no-label", "modelId": "GLM-5.3"},
             "label": "GLM-5.3", "providerLabel": "", "contextWindow": 200000},
            {"ref": {"providerId": "bigmodel-standard-api", "modelId": "glm-x-preview[1m]"},
             "label": "glm-x-preview[1m]", "providerLabel": "BigModel API",
             "contextWindow": 1000000,
             "reasoning": {"levels": [{"value": "max"}], "defaultLevel": "max"}},
            {"ref": {"providerId": "bigmodel-standard-api", "modelId": "default"},
             "label": "default", "providerLabel": "BigModel API", "contextWindow": 200000},
        ]);

        let models = parse_models(&multi).unwrap();
        let ids: Vec<&str> = models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(
            ids,
            [
                "default",
                "bigmodel-standard-api/GLM-5.3",
                "bigmodel-standard-api-2/GLM-5.3",
                "bigmodel-no-label/GLM-5.3",
                "glm-x-preview[1m]",
            ]
        );
        assert_eq!(models[1].name, "GLM-5.3 (BigModel API)");
        assert_eq!(models[1].description, "BigModel API");
        assert_eq!(models[2].name, "GLM-5.3 (BigModel API 2)");
        assert_eq!(models[2].description, "BigModel API 2");
        assert_eq!(models[3].name, "GLM-5.3");
        assert_eq!(models[4].name, "glm-x-preview[1m]");

        // Qualified selection picks the exact provider even when the session is on the other one.
        for (wanted, expected_provider, expected_model) in [
            ("bigmodel-standard-api/GLM-5.3", "bigmodel-standard-api", "GLM-5.3"),
            ("bigmodel-standard-api-2/GLM-5.3", "bigmodel-standard-api-2", "GLM-5.3"),
            // Legacy bare label resolves to the session's current matching entry first.
            ("GLM-5.3", "bigmodel-standard-api-2", "GLM-5.3"),
            // Unmatched custom id with "/" rides the session's current provider without splitting.
            ("custom-org/my-model", "bigmodel-standard-api-2", "custom-org/my-model"),
        ] {
            let mut config = super::super::tests::config("zcode");
            config.cwd = PathBuf::from("/tmp");
            config.model = wanted.into();
            let mut p = Protocol::new(config);
            let step = p.receive(json!({"id": ID_CREATE, "result": multi.clone()})).unwrap();
            let set_model = &step.write[0];
            assert_eq!(set_model["method"], "session/setModel", "{wanted}");
            assert_eq!(set_model["params"]["model"]["providerId"], expected_provider, "{wanted}");
            assert_eq!(set_model["params"]["model"]["modelId"], expected_model, "{wanted}");
            let mut reply = multi.clone();
            reply["session"]["model"] = json!({"providerId": expected_provider, "modelId": expected_model});
            assert!(p.receive(json!({"id": ID_MODEL, "result": reply})).is_ok(), "{wanted}");
        }

        // When the session's current model has a different label, a bare saved label picks the first match.
        let mut other_current = multi.clone();
        other_current["session"]["model"] = json!({"providerId": "bigmodel-standard-api", "modelId": "glm-x-preview[1m]"});
        let mut config = super::super::tests::config("zcode");
        config.cwd = PathBuf::from("/tmp");
        config.model = "GLM-5.3".into();
        let mut p = Protocol::new(config);
        let step = p.receive(json!({"id": ID_CREATE, "result": other_current})).unwrap();
        assert_eq!(step.write[0]["params"]["model"]["providerId"], "bigmodel-standard-api");
        assert_eq!(step.write[0]["params"]["model"]["modelId"], "GLM-5.3");
    }

    #[test]
    fn recorded_3182_tool_call_streaming_and_usage_sequence() {
        let (mut p, _) = created();
        subscribe_acked(&mut p);

        let r1 = p.receive(event("model.streaming", json!({
            "assistantMessageId": "msg_a", "delta": "thinking", "kind": "reasoning_delta"
        }))).unwrap();
        assert!(r1.events.iter().any(|e| e.kind == "status" && e.text == "Reasoning"));

        // Recorded 3.18.2 sequence: input arrives on model.streaming tool_call, omitted on scheduled, no toolName on result.
        let call = p.receive(json!({"method":"session/event","params":{"sessionId":"sess_test","turnId":"turn_1","type":"model.streaming","payload":{
            "kind":"tool_call","assistantMessageId":"msg_a","toolCallId":"call_1","toolName":"Bash",
            "input":{"command":"printf 'ok' > out.txt","description":"Write a file"},"delta":"","done":false
        }}})).unwrap();
        let tool = call.events.iter().find_map(|e| e.tool.as_ref()).expect("tool_call emits tool");
        assert_eq!(tool.name, "Bash");
        assert_eq!(tool.status, "running");
        assert!(tool.input.contains("printf 'ok' > out.txt"), "{}", tool.input);
        assert_eq!(tool.write_paths, Some(vec![]));

        let scheduled = p.receive(json!({"method":"session/event","params":{"type":"tool.updated","payload":{
            "kind":"scheduled","toolCallId":"call_1","assistantMessageId":"msg_a","toolName":"Bash",
            "dependencies":[],"parallelGroupIndex":0,"canRunParallel":false,
            "schedule":{"parallelGroups":[["call_1"]],"executionOrder":["call_1"]},
            "inputByteLength":86,"inputOmitted":true,"inputRef":"model_stream"
        }}})).unwrap();
        assert!(scheduled.events.is_empty(), "identical running state deduplicated without losing input");

        let started = p.receive(json!({"method":"session/event","params":{"type":"tool.updated","payload":{
            "kind":"started","toolCallId":"call_1","toolName":"Bash","startedAt":1795226336716_u64
        }}})).unwrap();
        assert!(started.events.is_empty());

        let result = p.receive(json!({"method":"session/event","params":{"type":"tool.updated","payload":{
            "kind":"result","toolCallId":"call_1",
            "result":{"success":true,"content":"ok","truncated":false},"duration":1806
        }}})).unwrap();
        let tool = result.events.iter().find_map(|e| e.tool.as_ref()).expect("result emits completed tool");
        assert_eq!(tool.name, "Bash");
        assert_eq!(tool.status, "completed");
        assert!(tool.input.contains("printf 'ok' > out.txt"), "{}", tool.input);
        assert_eq!(tool.output, "ok");
        assert_eq!(tool.write_paths, Some(vec![]));

        // A file-writing tool_call captures explicit write_paths and keeps them through omitted scheduled/result.
        let write_call = p.receive(event("model.streaming", json!({
            "kind":"tool_call","assistantMessageId":"msg_a","toolCallId":"call_2","toolName":"Write",
            "input":{"file_path":"out.txt","content":"ok"},"delta":"","done":false
        }))).unwrap();
        let tool = write_call.events.iter().find_map(|e| e.tool.as_ref()).expect("Write tool_call emits tool");
        assert_eq!(tool.write_paths, Some(vec!["out.txt".into()]));
        assert!(p.receive(event("tool.updated", json!({
            "kind":"scheduled","toolCallId":"call_2","toolName":"Write","inputOmitted":true
        }))).unwrap().events.is_empty());
        let write_done = p.receive(event("tool.updated", json!({
            "kind":"result","toolCallId":"call_2","result":{"success":true,"content":"wrote"}
        }))).unwrap();
        let tool = write_done.events.iter().find_map(|e| e.tool.as_ref()).expect("Write result emits completed tool");
        assert_eq!(tool.name, "Write");
        assert_eq!(tool.status, "completed");
        assert_eq!(tool.write_paths, Some(vec!["out.txt".into()]));

        let batch = p.receive(json!({"method":"session/event","params":{"type":"tool.updated","payload":{
            "kind":"batch","toolCallIds":["call_1"],"successCount":1,"errorCount":0
        }}})).unwrap();
        assert!(batch.events.is_empty());

        // Null or empty tool_call input is ignored (never records "null" as input).
        for empty_input in [json!(null), json!("")] {
            let ignored = p.receive(event("model.streaming", json!({
                "kind":"tool_call","assistantMessageId":"msg_a","toolCallId":"call_empty","toolName":"Bash","input":empty_input
            }))).unwrap();
            assert!(ignored.events.is_empty());
        }

        // tool_call reset reasoning, so a second reasoning phase emits "Reasoning" again.
        let r2 = p.receive(event("model.streaming", json!({
            "assistantMessageId": "msg_b", "delta": "more", "kind": "reasoning_delta"
        }))).unwrap();
        assert!(r2.events.iter().any(|e| e.kind == "status" && e.text == "Reasoning"));

        // Recorded 3.18.2 turn.completed: inputTokens already includes cacheReadTokens.
        let done = p.receive(json!({"method":"session/event","params":{"type":"turn.completed","payload":{
            "response":"OK","tokenCount":39643,
            "usage":{"inputTokens":39613,"outputTokens":30,"totalTokens":39643,"cacheReadTokens":28672,"cacheWriteTokens":0,"reasoningTokens":0},
            "toolCallCount":1,"historyRoundCount":2,"duration":18797,"resultType":"success","inputId":"pandacode-1"
        }}})).unwrap();
        assert!(done.done);
        let usage = done.events.iter().find(|e| e.kind == "usage").unwrap();
        assert_eq!(usage.data.as_ref().unwrap()["usedTokens"], 39613);

        // Zero inputTokens falls back to tokenCount.
        let (mut p, _) = created();
        subscribe_acked(&mut p);
        let fallback = p.receive(event("turn.completed", json!({
            "tokenCount": 512, "usage": {"inputTokens": 0, "cacheReadTokens": 128},
            "resultType": "success", "inputId": "pandacode-1",
        }))).unwrap();
        let usage = fallback.events.iter().find(|e| e.kind == "usage").unwrap();
        assert_eq!(usage.data.as_ref().unwrap()["usedTokens"], 512);
    }

    #[test]
    fn default_model_filters_thinking_level_against_the_current_catalog_entry() {
        let chain = |model: &str, effort: &str, snapshot: Value| {
            let mut config = super::super::tests::config("zcode");
            config.cwd = PathBuf::from("/tmp");
            config.model = model.into();
            config.reasoning_effort = Some(effort.into());
            let mut p = Protocol::new(config);
            p.receive(json!({"id": ID_CREATE, "result": snapshot})).unwrap().write
        };

        for default_selection in ["default", ""] {
            // Listed effort for the session's current model still sends setThoughtLevel.
            let write = chain(default_selection, "low", snapshot());
            assert_eq!(write.len(), 2);
            assert_eq!(write[0]["method"], "session/setThoughtLevel");
            assert_eq!(write[0]["params"]["thoughtLevel"], "low");
            assert_eq!(write[1]["method"], "session/subscribe");

            // Unlisted effort for the current model is skipped so setThoughtLevel cannot fail the run.
            let write = chain(default_selection, "medium", snapshot());
            assert_eq!(write.len(), 1);
            assert_eq!(write[0]["method"], "session/subscribe");
        }

        // When no catalog entry matches the current model, keep sending setThoughtLevel as before.
        let mut unmatched = snapshot();
        unmatched["session"]["model"] = json!({"providerId": "other", "modelId": "unlisted"});
        let write = chain("default", "medium", unmatched);
        assert_eq!(write.len(), 2);
        assert_eq!(write[0]["method"], "session/setThoughtLevel");
        assert_eq!(write[0]["params"]["thoughtLevel"], "medium");
    }

    #[test]
    fn discovery_line_classification_tolerates_stray_output_up_to_the_bound() {
        assert_eq!(classify_discovery_line(b""), DiscoveryLine::Blank);
        assert_eq!(classify_discovery_line(b"   \t\r\n"), DiscoveryLine::Blank);
        assert_eq!(classify_discovery_line(b"starting zcode...\n"), DiscoveryLine::NonJson);
        assert_eq!(classify_discovery_line(b"42\n"), DiscoveryLine::NonJson);
        assert!(matches!(
            classify_discovery_line(br#"{"id":1,"result":{}}"#),
            DiscoveryLine::Json(_)
        ));

        let mut stray = 0;
        for _ in 0..10 {
            assert_eq!(accept_discovery_line(b" \n", &mut stray), Ok(None));
        }
        assert_eq!(stray, 0, "blank lines do not consume the non-JSON budget");
        for i in 0..DISCOVERY_STRAY_LIMIT {
            assert_eq!(
                accept_discovery_line(format!("banner line {i}\n").as_bytes(), &mut stray),
                Ok(None),
                "stray line {i} within bound"
            );
        }
        assert!(accept_discovery_line(br#"{"method":"startup/storageState"}"#, &mut stray).unwrap().is_some());
        assert_eq!(
            accept_discovery_line(b"one stray line too many\n", &mut stray),
            Err("Invalid ZCode discovery JSON")
        );
    }

    #[test]
    fn early_exit_message_keeps_prefix_exit_status_and_cleaned_stderr() {
        let message = format_discovery_failure(
            &DiscoveryFailure::EarlyExit { received_json: false },
            Some("exit status: 1"),
            "\u{1b}[31mError: failed to open runtime config\u{1b}[0m\nstack detail",
            &[],
        );
        assert!(message.starts_with("ZCode exited before returning models (exit status: 1)"), "{message}");
        assert!(message.contains("Error: failed to open runtime config"), "{message}");
        assert!(message.contains("stack detail"), "{message}");
        assert!(!message.contains('\u{1b}'), "ANSI escapes stripped: {message}");

        let bare = format_discovery_failure(
            &DiscoveryFailure::EarlyExit { received_json: false },
            None,
            "",
            &[],
        );
        assert_eq!(bare, "ZCode exited before returning models");
    }

    #[test]
    fn missing_builtin_provider_config_maps_to_known_cause_and_is_not_retried() {
        let stderr_zh = "无法定位 CLI ZCode Built-in Provider Config：/Applications/ZCode.app/Contents/Resources/glm/provider/zcode-builtin.json";
        assert!(is_missing_builtin_config(stderr_zh));
        assert!(is_missing_builtin_config("cannot open zcode-builtin.json"));
        assert!(is_missing_builtin_config("missing Built-in Provider Config file"));
        assert!(!is_missing_builtin_config("Error: transient socket reset"));

        let message = format_discovery_failure(
            &DiscoveryFailure::EarlyExit { received_json: false },
            Some("exit status: 1"),
            stderr_zh,
            &[],
        );
        assert!(message.starts_with(DISCOVERY_BUILTIN_CONFIG_CAUSE), "{message}");
        assert!(message.contains("zcode-builtin.json"), "{message}");
        assert!(message.contains("Details:\n"), "{message}");

        assert!(!should_retry_discovery(
            0,
            &DiscoveryFailure::EarlyExit { received_json: false },
            stderr_zh,
        ));
        assert!(!should_retry_discovery(
            0,
            &DiscoveryFailure::EarlyExit { received_json: false },
            "ENOENT: /tmp/zcode-builtin.json",
        ));
    }

    #[test]
    fn discovery_retry_policy_retries_once_only_on_pre_json_early_exit() {
        let early_pre_json = DiscoveryFailure::EarlyExit { received_json: false };
        assert!(should_retry_discovery(0, &early_pre_json, "transient crash"));
        assert!(!should_retry_discovery(1, &early_pre_json, "transient crash"));

        assert!(!should_retry_discovery(
            0,
            &DiscoveryFailure::EarlyExit { received_json: true },
            "crashed after notification",
        ));
        assert!(!should_retry_discovery(0, &DiscoveryFailure::Timeout, "still booting"));
        assert!(!should_retry_discovery(
            0,
            &DiscoveryFailure::ServerError("Account not signed in".into()),
            "",
        ));
        assert!(!should_retry_discovery(
            0,
            &DiscoveryFailure::Spawn("Could not start ZCode: not found".into()),
            "",
        ));
        assert!(!should_retry_discovery(0, &DiscoveryFailure::InvalidJson, ""));
        assert!(!should_retry_discovery(0, &DiscoveryFailure::OutputLimit, ""));

        let server = format_discovery_failure(
            &DiscoveryFailure::ServerError("Account not signed in".into()),
            None,
            "noisy startup warning",
            &[],
        );
        assert_eq!(server, "Account not signed in");

        let timeout = format_discovery_failure(
            &DiscoveryFailure::Timeout,
            None,
            "\u{1b}[33mwaiting for local lock\u{1b}[0m",
            &[],
        );
        assert!(timeout.starts_with("ZCode model discovery timed out"), "{timeout}");
        assert!(timeout.contains("waiting for local lock"), "{timeout}");
        assert!(!timeout.contains('\u{1b}'));
    }

    #[test]
    fn discovery_diagnostics_redact_credentials_and_saved_environment_values() {
        let env = vec![
            ("SHORT_FLAG".into(), "1234567".into()),
            ("ZCODE_EXACT_8".into(), "secret88".into()),
            ("ZCODE_TOKEN".into(), "super-secret-env-value-xyz".into()),
            ("ZCODE_TOKEN_PREFIX".into(), "super-secret".into()),
        ];
        let stderr = concat!(
            "Authorization: Bearer header-secret-token\n",
            "api_key=inline-api-secret\n",
            "boot failed with super-secret-env-value-xyz and secret88 and 1234567\n",
        );
        let scrubbed = scrub_env_values(stderr, &env);
        assert!(!scrubbed.contains("super-secret-env-value-xyz"), "{scrubbed}");
        assert!(!scrubbed.contains("-env-value-xyz"), "longest secret replaced first: {scrubbed}");
        assert!(!scrubbed.contains("secret88"), "{scrubbed}");
        assert!(scrubbed.contains("[redacted]"), "{scrubbed}");
        assert!(scrubbed.contains("1234567"), "values under 8 chars stay intact: {scrubbed}");

        let message = format_discovery_failure(
            &DiscoveryFailure::EarlyExit { received_json: false },
            Some("exit status: 1"),
            stderr,
            &env,
        );
        assert!(!message.contains("header-secret-token"), "{message}");
        assert!(!message.contains("inline-api-secret"), "{message}");
        assert!(!message.contains("super-secret-env-value-xyz"), "{message}");
        assert!(!message.contains("secret88"), "{message}");
        assert!(message.contains("[Credential detail omitted]"), "{message}");
        assert!(message.contains("[redacted]"), "{message}");
    }

    #[test]
    fn discovery_diagnostics_redact_short_secrets_by_environment_name() {
        let stderr = "Error: login rejected hunter2; exit status: 123";
        for name in ["KEY", "token", "Secret", "PASSWORD", "passwd", "AUTH", "credential", "cookie", "session", "private"] {
            let env = vec![(format!("ZCODE_{name}_VALUE"), "hunter2".into()), ("AUTH_CODE".into(), "123".into())];
            let message = format_discovery_failure(&DiscoveryFailure::EarlyExit { received_json: false }, None, stderr, &env);
            assert!(!message.contains("hunter2"), "{name}: {message}");
            assert!(message.contains("[redacted]"), "{name}: {message}");
            assert!(message.contains("exit status: 123"), "three-character values stay intact: {message}");
        }
        assert_eq!(scrub_env_values(stderr, &[("ORDINARY_VALUE".into(), "hunter2".into())]), stderr);
        assert_eq!(scrub_env_values("exit status: 1", &[("AUTH_CODE".into(), "1".into())]), "exit status: 1");
        assert_eq!(scrub_env_values("Error: test", &[("AUTH_CODE".into(), "test".into())]), "Error: [redacted]");
    }

    #[test]
    fn discovery_server_error_redacts_before_shortening() {
        let secret = "secret-straddling-the-old-limit";
        let message = format!("{}{}{}", "x".repeat(3995), secret, "y".repeat(100));
        let env = vec![("ZCODE_TOKEN".into(), secret.into())];
        let formatted = format_discovery_failure(&DiscoveryFailure::ServerError(message.clone()), None, "", &env);
        assert_eq!(formatted, short(&message.replace(secret, "[redacted]")));
        assert!(!formatted.contains("secret"), "{formatted}");
        assert_eq!(formatted.chars().count(), 4000);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn discovery_drains_stderr_retries_transient_exit_and_caches_catalog() {
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join(format!(
            "pandacode-zcode-discover-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let make_script = |name: &str, body: &str| {
            let path = dir.join(name);
            std::fs::write(&path, body).unwrap();
            let mut perms = std::fs::metadata(&path).unwrap().permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&path, perms).unwrap();
            path
        };

        // 1. Heavy stderr before reading stdin never deadlocks, and known cause is not retried.
        let known_count = dir.join("known.count");
        let known_script = make_script(
            "known.sh",
            &format!(
                "#!/bin/sh\necho x >> \"{}\"\n\
                 i=0; while [ $i -lt 2000 ]; do printf 'noise-line-0123456789012345678901234567890123456789\\n' >&2; i=$((i+1)); done\n\
                 printf '无法定位 CLI ZCode Built-in Provider Config：/tmp/zcode-builtin.json\\n' >&2\n\
                 exit 1\n",
                known_count.display()
            ),
        );
        let err = discover(&known_script).await.unwrap_err();
        assert!(err.starts_with(DISCOVERY_BUILTIN_CONFIG_CAUSE), "{err}");
        assert!(err.contains("zcode-builtin.json"), "{err}");
        assert_eq!(
            std::fs::read_to_string(&known_count).unwrap().lines().count(),
            1,
            "known cause must not retry"
        );

        // 2. Transient early exit retries once, tolerates stray stdout, and models() caches the catalog.
        let retry_count = dir.join("retry.count");
        let reply = json!({"id": ID_CREATE, "result": snapshot()}).to_string();
        let retry_script = make_script(
            "retry.sh",
            &format!(
                "#!/bin/sh\necho x >> \"{count}\"\n\
                 n=$(wc -l < \"{count}\" | tr -d ' ')\n\
                 if [ \"$n\" -eq 1 ]; then\n\
                   printf 'Error: transient boot hiccup\\n' >&2\n\
                   exit 2\n\
                 fi\n\
                 IFS= read -r _req\n\
                 printf '\\nstray banner line\\n'\n\
                 printf '%s\\n' '{reply}'\n",
                count = retry_count.display(),
            ),
        );
        let first = models(&retry_script).await.unwrap();
        assert_eq!(first.len(), 2);
        assert_eq!(first[1].id, "zcproxy/GLM-5.3");
        assert_eq!(
            std::fs::read_to_string(&retry_count).unwrap().lines().count(),
            2,
            "first attempt exited early, second succeeded"
        );
        let second = models(&retry_script).await.unwrap();
        assert_eq!(second.len(), 2);
        assert_eq!(
            std::fs::read_to_string(&retry_count).unwrap().lines().count(),
            2,
            "cached catalog must not spawn a third CLI process"
        );

        // 3. Keep the server error whole until its saved environment values are scrubbed.
        let secret = "secret-straddling-the-old-limit";
        let message = format!("{}{}{}", "x".repeat(3995), secret, "y".repeat(100));
        let reply = json!({"id": ID_CREATE, "error": {"code": -32603, "message": message}});
        let server_script = make_script("server-error.sh", &format!("#!/bin/sh\nIFS= read -r _req\nprintf '%s\\n' '{reply}'\n"));
        let report = discover_attempt(&server_script, tokio::time::Instant::now() + DISCOVERY_TIMEOUT).await.unwrap_err();
        assert_eq!(report.failure, DiscoveryFailure::ServerError(message.clone()));
        let formatted = format_discovery_failure(&report.failure, report.exit_status.as_deref(), &report.stderr, &[("ZCODE_TOKEN".into(), secret.into())]);
        assert_eq!(formatted, short(&message.replace(secret, "[redacted]")));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    #[ignore = "needs the ZCode CLI; metadata only, never sends a prompt"]
    async fn installed_zcode_lists_models() {
        // Prefer the desktop bundle: a PATH shim (or a stale install) may not
        // speak the current protocol, and the bundle is what the pin records.
        let path = bundled().unwrap_or_else(|| executable("zcode").expect("Install ZCode first"));
        let models = models(&path).await.unwrap();
        assert!(models.len() > 1, "{models:?}");
    }

    /// Metadata re-verification against the current desktop CLI: the create
    /// snapshot carries per-model capability properties and slash commands,
    /// and `session/usage` answers a zero-state session. Never sends a prompt,
    /// so turn event names stay pinned to the recorded frames.
    #[tokio::test]
    #[ignore = "needs the ZCode CLI; metadata only, never sends a prompt"]
    async fn installed_zcode_snapshot_capabilities() {
        // Prefer the desktop bundle: a PATH shim (or a stale install) may not
        // speak the current protocol, and the bundle is what the pin records.
        let path = bundled().unwrap_or_else(|| executable("zcode").expect("Install ZCode first"));
        // The bundled CLI runs on the desktop app's Electron runtime, so the
        // launch layer builds the process (direct exec of zcode.cjs fails).
        let mut command = super::launch::command(&path).unwrap();
        command.arg("app-server");
        let workspace = std::env::temp_dir();
        command
            .current_dir(&workspace)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(unix)]
        command.process_group(0);
        let mut child = command.spawn().expect("start ZCode");
        let group = ProcessGroup::register(child.id());
        let snapshot = tokio::time::timeout(Duration::from_secs(25), async {
            let mut stdin = child.stdin.take().unwrap();
            write_json(
                &mut stdin,
                &json!({"id": ID_CREATE, "method": "session/create", "params": {
                    "workspace": workspace_of(&workspace),
                    "persistence": "deferred",
                    "mode": "plan",
                    "titleGenerationEnabled": false,
                }}),
            )
            .await
            .unwrap();
            let mut stdout = tokio::io::BufReader::new(child.stdout.take().unwrap());
            loop {
                let mut line = String::new();
                let count = stdout.read_line(&mut line).await.unwrap();
                assert!(count > 0, "ZCode exited before the create reply");
                let value: Value = serde_json::from_str(&line).unwrap();
                if value.get("method").is_some() && value.get("id").is_some() {
                    // Decline reverse requests like the run path does; the
                    // create waits on them (runtime preferences).
                    write_json(
                        &mut stdin,
                        &json!({"id": value["id"], "error": {"code": -32601, "message": "Method not found"}}),
                    )
                    .await
                    .unwrap();
                    continue;
                }
                if value["id"] == ID_CREATE {
                    assert!(value.get("error").is_none(), "create failed: {value}");
                    let session_id = value["result"]["session"]["sessionId"].clone();
                    let result = value["result"].clone();
                    // A fresh deferred session may be known to usage only
                    // after its first send; a zero-state reply proves the
                    // method, a session-not-found error proves the same on
                    // builds that defer harder. Anything else has changed.
                    write_json(
                        &mut stdin,
                        &json!({"id": 90, "method": "session/usage", "params": {"sessionId": session_id}}),
                    )
                    .await
                    .unwrap();
                    loop {
                        let mut line = String::new();
                        stdout.read_line(&mut line).await.unwrap();
                        let value: Value = serde_json::from_str(&line).unwrap();
                        if value.get("method").is_some() && value.get("id").is_some() {
                            write_json(
                                &mut stdin,
                                &json!({"id": value["id"], "error": {"code": -32601, "message": "Method not found"}}),
                            )
                            .await
                            .unwrap();
                            continue;
                        }
                        if value["id"] == 90 {
                            if let Some(result) = value.get("result") {
                                assert_eq!(result["totalTokens"], 0, "{result}");
                                assert!(result["inputTokens"].is_number(), "{result}");
                            } else {
                                assert_eq!(value["error"]["code"], -32004, "{value}");
                            }
                            break;
                        }
                    }
                    return result;
                }
            }
        })
        .await
        .expect("ZCode snapshot timed out");
        drop(group);
        let _ = child.start_kill();

        let entries = snapshot["settings"]["model"]["available"].as_array().unwrap();
        assert!(!entries.is_empty());
        for entry in entries {
            let input = &entry["properties"]["inputFormat"];
            assert!(input["supportsText"].is_boolean(), "no inputFormat on {entry}");
            assert!(input["supportsImage"].is_boolean(), "no supportsImage on {entry}");
            assert!(input["supportsPdf"].is_boolean(), "no supportsPdf on {entry}");
            // The catalog schema is strict and carries no speed or tier
            // field; the GLM Coding Plan sells speed per plan, not per model.
            assert!(entry.get("capabilities").is_none(), "{entry}");
            assert!(entry.get("speedTiers").is_none(), "{entry}");
            assert!(entry.get("serviceTiers").is_none(), "{entry}");
        }
        let commands = snapshot["slashCommands"].as_array().unwrap();
        assert!(
            commands.iter().any(|c| c["name"] == "goal" && c["source"] == "builtin"),
            "expected the builtin /goal command in {commands:?}"
        );
        assert!(
            commands.iter().any(|c| c["name"] == "compact"),
            "expected /compact in {commands:?}"
        );
        assert!(snapshot["projection"]["contextWindow"].is_number());
        assert!(snapshot["todos"].is_array());
    }
}
