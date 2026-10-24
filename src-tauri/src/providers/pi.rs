use super::goals::RpcReply;
use super::*;
use tokio::io::AsyncBufReadExt;

pub(super) struct Bridge(PathBuf);
impl Bridge {
    pub(super) fn configure(
        command: &mut Command,
        mode: &str,
        server: Option<&mcp_host::Server>,
    ) -> Result<Self, String> {
        let directory = std::env::temp_dir().join(format!("pandacode-pi-{}", uuid::Uuid::new_v4()));
        let mut builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
        builder.create(&directory).map_err(|e| e.to_string())?;
        let bridge = Self(directory);
        let path = bridge.0.join("bridge.mjs");
        std::fs::write(&path, include_str!("pi-extension.mjs")).map_err(|e| e.to_string())?;
        let mut config = server
            .map(mcp_host::Server::pi_config)
            .unwrap_or_else(|| json!({}));
        config["mode"] = json!(mode);
        command
            .arg("--extension")
            .arg(path)
            .env("PANDACODE_PI_BRIDGE", config.to_string());
        Ok(bridge)
    }
}
impl Drop for Bridge {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub(super) fn configure(command: &mut Command, config: &RunConfig) {
    command.args(["--mode", "rpc"]);
    if !config.model.is_empty() && config.model != "default" {
        if let Some((provider, model)) = config.model.split_once('/') {
            command.args(["--provider", provider, "--model", model]);
        } else {
            command.args(["--model", &config.model]);
        }
    }
    if let Some(effort) = &config.reasoning_effort {
        command.args(["--thinking", effort]);
    }
    let omp = config.provider == "omp";
    if let Some(id) = &config.resume_id {
        // `--session` may print and read a fork prompt on the RPC pipes when the
        // ID matches another folder; `--session-id` only opens this folder's session.
        // omp has no `--session-id`; its `--resume` looks in this folder first and
        // fails instead of prompting when stdin is not a terminal.
        command.args([if omp { "--resume" } else { "--session-id" }, id]);
    }
    if omp {
        // The bridge extension is the only approval gate, as with Pi.
        command.args(["--approval-mode", "yolo"]);
    }
    if !config.instructions.is_empty() {
        command.args(["--append-system-prompt", &config.instructions]);
    }
}

pub(super) fn parse_models(data: &Value) -> Result<Vec<ModelInfo>, String> {
    let entries = data["models"]
        .as_array()
        .filter(|v| v.len() <= MODEL_CATALOG_LIMIT)
        .ok_or("Invalid Pi model catalog")?;
    let mut models = vec![ModelInfo::default_choice()];
    let mut seen = HashSet::new();
    for entry in entries {
        let provider = field(entry, "provider");
        let model = field(entry, "id");
        if !valid_model_id(provider) || !valid_model_id(model) {
            return Err("Invalid Pi model ID".into());
        }
        let id = format!("{provider}/{model}");
        if !valid_model_id(&id) {
            return Err("Invalid Pi model ID".into());
        }
        if !seen.insert(id.clone()) {
            continue;
        }
        models.push(ModelInfo {
            name: model_text(entry["name"].as_str(), model, 160),
            description: model_text(Some(provider), "", 200),
            id,
            reasoning_efforts: if entry["reasoning"] == true {
                ["off", "minimal", "low", "medium", "high", "xhigh"]
                    .iter()
                    .map(|id| effort_info(id, None))
                    .collect()
            } else {
                vec![]
            },
            default_reasoning_effort: None,
            context_window: entry["contextWindow"]
                .as_u64()
                .filter(|n| *n > 0 && *n <= 1_000_000_000),
        });
    }
    Ok(models)
}

/// Discovery stdout cap. omp's v2 chunks are base64, so a 12 MiB catalog fits.
const DISCOVERY_OUTPUT_LIMIT: u64 = 16 * 1024 * 1024;
/// omp's advertised reassembled-frame limit (protocol v2).
const MAX_REASSEMBLED_BYTES: u64 = 64 * 1024 * 1024;

fn models_request() -> Value {
    json!({"type":"get_available_models","id":"pandacode-models"})
}

struct Chunks {
    id: String,
    count: u64,
    length: u64,
    next: u64,
    bytes: Vec<u8>,
}

/// Model discovery over Pi's RPC. omp first sends a `ready` frame; when it
/// offers protocol v2 we negotiate it so a catalog over omp's 1 MiB frame
/// limit arrives as `rpc_chunk` frames (omp `docs/rpc.md`, Transport and Framing).
struct Discovery {
    name: &'static str,
    asked: bool,
    chunks: Option<Chunks>,
}

impl Discovery {
    fn new(provider: &str) -> Self {
        Self {
            name: if provider == "omp" { "Oh My Pi" } else { "Pi" },
            // Pi has no ready frame; its request goes out at start.
            asked: provider != "omp",
            chunks: None,
        }
    }

    /// Takes one stdout frame; returns frames to write, or the catalog.
    fn receive(&mut self, value: Value) -> Result<(Vec<Value>, Option<Vec<ModelInfo>>), String> {
        let Some(value) = self.reassemble(value)? else {
            return Ok((vec![], None));
        };
        match (field(&value, "type"), field(&value, "id")) {
            ("ready", _) if !self.asked => {
                let v2 = value["supportedProtocolVersions"]
                    .as_array()
                    .is_some_and(|versions| versions.contains(&json!(2)));
                if v2 {
                    return Ok((vec![json!({"type":"negotiate_protocol","id":"pandacode-protocol","protocolVersion":2})], None));
                }
                self.asked = true;
                Ok((vec![models_request()], None))
            }
            // A refused negotiation stays on v1; the catalog may still fit.
            ("response", "pandacode-protocol") if !self.asked => {
                self.asked = true;
                Ok((vec![models_request()], None))
            }
            ("response", "pandacode-models") => {
                if value["success"] != true {
                    let error = field(&value, "error");
                    return Err(if error.is_empty() {
                        format!("{} could not load models. Check its login and configuration.", self.name)
                    } else {
                        short(error)
                    });
                }
                parse_models(&value["data"]).map(|models| (vec![], Some(models)))
            }
            _ => Ok((vec![], None)),
        }
    }

    /// Protocol v2 `rpc_chunk` reassembly; any irregular sequence is fatal.
    fn reassemble(&mut self, value: Value) -> Result<Option<Value>, String> {
        if value["type"] != "rpc_chunk" {
            if self.chunks.is_some() {
                return Err(format!("{} interrupted a chunked response", self.name));
            }
            return Ok(Some(value));
        }
        let invalid = || format!("{} sent an invalid response chunk", self.name);
        let id = field(&value, "chunkId");
        let (Some(index), Some(count), Some(length)) = (
            value["index"].as_u64(),
            value["count"].as_u64(),
            value["byteLength"].as_u64(),
        ) else {
            return Err(invalid());
        };
        if id.is_empty() || index >= count || length > MAX_REASSEMBLED_BYTES {
            return Err(invalid());
        }
        use base64::Engine;
        let data = base64::engine::general_purpose::STANDARD
            .decode(field(&value, "data"))
            .map_err(|_| invalid())?;
        let chunks = match &mut self.chunks {
            Some(chunks) => chunks,
            None if index == 0 => self.chunks.insert(Chunks {
                id: id.to_owned(),
                count,
                length,
                next: 0,
                bytes: Vec::new(),
            }),
            None => return Err(invalid()),
        };
        if chunks.id != id || chunks.count != count || chunks.length != length || chunks.next != index {
            return Err(invalid());
        }
        chunks.bytes.extend_from_slice(&data);
        chunks.next += 1;
        if chunks.bytes.len() as u64 > length {
            return Err(invalid());
        }
        if chunks.next < count {
            return Ok(None);
        }
        let bytes = self.chunks.take().map(|c| c.bytes).unwrap_or_default();
        if bytes.len() as u64 != length {
            return Err(invalid());
        }
        let frame: Value = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
        if !frame.is_object() {
            return Err(invalid());
        }
        Ok(Some(frame))
    }
}

pub(super) async fn models(path: &Path, provider: &str) -> Result<Vec<ModelInfo>, String> {
    let mut command = super::command(path)?;
    command.args(["--mode", "rpc", "--no-session", "--no-extensions", "--no-skills"]);
    if provider == "omp" {
        command.args(["--no-rules", "--no-lsp", "--no-title"]);
    } else {
        command.args(["--no-prompt-templates", "--no-mcp", "--no-context-files", "--offline"]);
    }
    command
        .current_dir(std::env::temp_dir())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command
        .spawn()
        .map_err(|e| format!("Could not start Pi: {e}"))?;
    let group = ProcessGroup::register(child.id());
    let mut discovery = Discovery::new(provider);
    let result = tokio::time::timeout(Duration::from_secs(15), async {
        let mut stdin = child.stdin.take().ok_or("Pi stdin unavailable")?;
        if discovery.asked {
            write_json(&mut stdin, &models_request()).await?;
        }
        let mut stdout =
            tokio::io::BufReader::new(child.stdout.take().ok_or("Pi stdout unavailable")?)
                .take(DISCOVERY_OUTPUT_LIMIT + 1);
        let mut total = 0;
        loop {
            let mut line = Vec::new();
            let count = stdout
                .read_until(b'\n', &mut line)
                .await
                .map_err(|e| e.to_string())?;
            total += count as u64;
            if total > DISCOVERY_OUTPUT_LIMIT {
                return Err("Pi model catalog exceeded its output limit".into());
            }
            if count == 0 {
                return Err("Pi exited before returning models".into());
            }
            let value: Value =
                serde_json::from_slice(&line).map_err(|_| "Invalid Pi discovery JSON")?;
            let (writes, models) = discovery.receive(value)?;
            for frame in writes {
                write_json(&mut stdin, &frame).await?;
            }
            if let Some(models) = models {
                return Ok(models);
            }
        }
    })
    .await
    .unwrap_or_else(|_| Err("Pi model discovery timed out".into()));
    drop(group);
    let _ = child.start_kill();
    let _ = tokio::time::timeout(Duration::from_secs(1), child.wait()).await;
    result
}

/// Whether a stopped run's output has reached its end.
pub(super) fn stop_settled(provider: &str, value: &Value) -> bool {
    match provider {
        // Pi stays up after `abort`; settling is the end of the stopped run.
        "pi" => value["type"] == "agent_settled",
        "omp" => value["type"] == "prompt_result" || value["type"] == "session_settled",
        // Muse ends an interrupted turn with `turn/completed` (terminal `cancelled`).
        "muse" => value["method"] == "turn/completed",
        _ => false,
    }
}

/// Pi run state. `agent_settled`, not `agent_end`, finishes a run: retries,
/// compaction recovery and steering can follow an `agent_end`.
#[derive(Default)]
pub(super) struct State {
    ready: bool,
    /// `get_state` can answer before the bridge reports ready; it waits here.
    held_state: Option<Value>,
    /// Latest assistant failure. A successful retry or answer clears it.
    error: Option<String>,
    pub(super) settled: bool,
    /// omp's `prompt_result` outcome, held until the session settles.
    prompt_result: Option<Value>,
    /// Unanswered `steer` commands: wire id -> (steer id, text, reply).
    pub(super) steers: HashMap<String, (String, String, RpcReply)>,
    steer_sequence: u64,
}

impl Protocol {
    pub(super) fn pi(&mut self, value: Value) -> Result<Step, String> {
        let mut step = Step::default();
        match field(&value, "type") {
            "response" => self.pi_response(value, &mut step)?,
            "message_start" if value["message"]["role"] == "assistant" => {
                self.claude_message_id = self.next_text_id();
            }
            // Pi takes a queued steer as a user message before its next model call.
            "message_start" if value["message"]["role"] == "user" => {
                self.steers_consumed(&value["message"]["content"], &mut step);
            }
            "message_update" => {
                let event = &value["assistantMessageEvent"];
                if event["type"] == "text_delta" {
                    let id = self.claude_message_id.clone();
                    self.text_delta(&id, None, field(event, "delta"), &mut step);
                } else if event["type"] == "thinking_start" {
                    step.events.push(self.event("status", "Reasoning", None));
                }
            }
            "message_end" if value["message"]["role"] == "assistant" => {
                let message = &value["message"];
                match field(message, "stopReason") {
                    // Pi may retry; agent_settled decides whether this failed the run.
                    "error" => {
                        self.pi.error = Some(short(field(message, "errorMessage")))
                    }
                    "aborted" => {}
                    _ => {
                        self.pi.error = None;
                        let text = message["content"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter(|v| v["type"] == "text")
                            .map(|v| field(v, "text"))
                            .collect::<String>();
                        let id = self.claude_message_id.clone();
                        self.text_snapshot(&id, None, &text, &mut step);
                    }
                }
            }
            "tool_execution_start" => {
                let name = field(&value, "toolName");
                let id = field(&value, "toolCallId");
                self.tool_update(
                    id,
                    Some(name),
                    Some("running"),
                    Some(preview_json(&value["args"], TOOL_INPUT_LIMIT)),
                    None,
                    &mut step,
                );
                let paths = match name {
                    "edit" | "write" => Some(
                        value["args"]["path"]
                            .as_str()
                            .map(str::to_owned)
                            .into_iter()
                            .collect(),
                    ),
                    "bash" => Some(vec![]),
                    _ => None,
                };
                self.tool_paths(id, paths, &mut step);
            }
            "tool_execution_update" | "tool_execution_end" => {
                let done = value["type"] == "tool_execution_end";
                let status = if !done {
                    "running"
                } else if value["isError"] == true {
                    "failed"
                } else {
                    "completed"
                };
                let result = if done {
                    &value["result"]
                } else {
                    &value["partialResult"]
                };
                self.tool_update(
                    field(&value, "toolCallId"),
                    Some(field(&value, "toolName")),
                    Some(status),
                    None,
                    Some(content_preview(result, TOOL_OUTPUT_LIMIT)),
                    &mut step,
                );
            }
            "auto_retry_start" => step.events.push(self.event(
                "status",
                format!(
                    "Retrying (attempt {} of {}): {}",
                    value["attempt"],
                    value["maxAttempts"],
                    field(&value, "errorMessage")
                ),
                None,
            )),
            "auto_retry_end" => {
                if value["success"] == true {
                    self.pi.error = None;
                } else if let Some(error) = value["finalError"].as_str() {
                    self.pi.error = Some(short(error));
                }
            }
            "compaction_start" => step
                .events
                .push(self.event("status", "Compacting context", None)),
            "compaction_end" => {
                if let Some(error) = value["errorMessage"].as_str() {
                    step.events.push(
                        self.event("status", format!("Context compaction failed: {error}"), None),
                    );
                } else if value["aborted"] != true {
                    step.events
                        .push(self.event("status", "Context compacted", None));
                }
            }
            "agent_settled" => self.pi_settled(value["aborted"] == true, &mut step)?,
            // omp reports each prompt's outcome once its work settles; background
            // work it started may keep the session busy until `session_settled`.
            "prompt_result" if value["id"] == "pandacode-prompt" => {
                let settled = value["sessionSettled"] == true;
                self.pi.prompt_result = Some(value);
                if settled {
                    self.omp_settled(&mut step)?;
                }
            }
            "session_settled" if self.pi.prompt_result.is_some() && !self.pi.settled => {
                self.omp_settled(&mut step)?
            }
            "extension_ui_request" => self.pi_ui(value, &mut step)?,
            // Only the permission bridge is required; other extensions fail on their own.
            "extension_error" if !field(&value, "extensionPath").contains("pandacode-pi") => {
                step.events.push(self.event(
                    "status",
                    format!("Pi extension error: {}", field(&value, "error")),
                    None,
                ))
            }
            "extension_error" => {
                return Err(format!(
                    "Pi extension failed: {}",
                    short(field(&value, "error"))
                ))
            }
            _ => {}
        }
        Ok(step)
    }

    fn pi_settled(&mut self, aborted: bool, step: &mut Step) -> Result<(), String> {
        self.pi.settled = true;
        if aborted {
            return Err("Pi response was aborted".into());
        }
        if let Some(error) = self.pi.error.take() {
            return Err(error);
        }
        step.write
            .push(json!({"type":"get_session_stats","id":"pandacode-usage"}));
        Ok(())
    }

    fn omp_settled(&mut self, step: &mut Step) -> Result<(), String> {
        let result = self.pi.prompt_result.take().unwrap_or_default();
        if result["status"] == "error" {
            let error = result["error"]["message"].as_str().unwrap_or("omp could not finish the response");
            self.pi.error = Some(short(error));
        }
        self.pi_settled(result["status"] == "aborted", step)
    }

    fn pi_response(&mut self, value: Value, step: &mut Step) -> Result<(), String> {
        let id = field(&value, "id");
        if let Some((steer, text, reply)) = self.pi.steers.remove(id) {
            // Refused (e.g. not streaming any more): it becomes the next turn instead.
            let mode = if value["success"] == true { "live" } else { "next-turn" };
            self.accept(steer, text, mode, reply, step);
            self.steer_answered(step);
            return Ok(());
        }
        if id == "pandacode-usage" {
            // Stats are optional: a failed or unsupported request still ends the run.
            let usage = &value["data"]["contextUsage"];
            if let Some(used) = usage["tokens"].as_u64().filter(|_| value["success"] == true) {
                self.usage(used, usage["contextWindow"].as_u64(), step);
            }
            step.done = true;
            return Ok(());
        }
        if value["success"] != true {
            return Err(short(field(&value, "error")));
        }
        match id {
            "pandacode-init" if !self.pi.ready => self.pi.held_state = Some(value),
            "pandacode-init" => self.pi_started(&value, step)?,
            // An extension command consumed the prompt; no run started.
            "pandacode-prompt" if value["data"]["disposition"] == "handled" => step.done = true,
            _ => {}
        }
        Ok(())
    }

    fn pi_started(&mut self, value: &Value, step: &mut Step) -> Result<(), String> {
        let data = &value["data"];
        self.remote_id = string(data, "sessionId");
        if uuid::Uuid::parse_str(&self.remote_id).is_err() {
            return Err("Pi did not return a valid session ID".into());
        }
        // `--session-id` creates an empty session when the saved one is missing.
        if self.config.resume_id.is_some() && data["messageCount"] == 0 {
            return Err("Pi could not find this task's saved session in this folder.".into());
        }
        step.events
            .push(self.event("session", self.remote_id.clone(), None));
        if self
            .config
            .reasoning_effort
            .as_deref()
            .is_some_and(|effort| data["thinkingLevel"].as_str() != Some(effort))
        {
            return Err("Pi did not apply the selected thinking level".into());
        }
        let model = &data["model"];
        let applied = match self.config.model.split_once('/') {
            Some((provider, id)) => model["provider"] == provider && model["id"] == id,
            None => {
                self.config.model.is_empty()
                    || self.config.model == "default"
                    || model["id"] == self.config.model.as_str()
            }
        };
        if !applied {
            return Err("Pi did not apply the selected model".into());
        }
        self.phase = 1;
        step.write.push(json!({"type":"prompt","id":"pandacode-prompt","message":self.config.prompt,"images":self.image_blocks}));
        Ok(())
    }

    fn pi_ui(&mut self, value: Value, step: &mut Step) -> Result<(), String> {
        match field(&value, "method") {
            "setStatus" if value["statusKey"] == "pandacode-bridge" => {
                if value["statusText"] == "ready" {
                    self.pi.ready = true;
                    if let Some(state) = self.pi.held_state.take() {
                        self.pi_started(&state, step)?;
                    }
                }
            }
            "confirm" => self.approval(
                value.clone(),
                format!("{}\n{}", field(&value, "title"), field(&value, "message")),
                step,
            )?,
            // PandaCode's question form speaks Codex/MCP shapes; Pi dialogs decline for now.
            "select" | "input" | "editor" => step.write.push(
                json!({"type":"extension_ui_response","id":value["id"],"cancelled":true}),
            ),
            "notify" => step
                .events
                .push(self.event("status", field(&value, "message"), None)),
            "setStatus" if !field(&value, "statusText").is_empty() => step
                .events
                .push(self.event("status", field(&value, "statusText"), None)),
            // setTitle, setWidget and set_editor_text drive Pi's own terminal UI.
            _ => {}
        }
        Ok(())
    }

    pub(super) fn pi_steer(&mut self, id: String, text: String, reply: RpcReply) -> Step {
        let mut step = Step::default();
        if self.phase == 0 || self.pi.settled {
            self.accept(id, text, "next-turn", reply, &mut step);
            return step;
        }
        self.pi.steer_sequence += 1;
        let request = format!("pandacode-steer-{}", self.pi.steer_sequence);
        step.write
            .push(json!({"type":"steer","id":request,"message":text}));
        self.pi.steers.insert(request, (id, text, reply));
        step
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ready() -> Protocol {
        let mut p = Protocol::new(super::super::tests::config("pi"));
        p.receive(json!({"type":"extension_ui_request","method":"setStatus","statusKey":"pandacode-bridge","statusText":"ready"})).unwrap();
        p
    }

    fn state() -> Value {
        json!({"type":"response","command":"get_state","id":"pandacode-init","success":true,"data":{"sessionId":"01a15ba3-9096-76db-bd69-35168c0ecfa9","thinkingLevel":"medium"}})
    }

    #[test]
    fn bridge_must_be_ready_before_any_prompt() {
        // get_state may answer before the bridge's ready status; it waits for it.
        let mut early = Protocol::new(super::super::tests::config("pi"));
        let held = early.receive(state()).unwrap();
        assert!(held.write.is_empty() && held.events.is_empty());
        assert_eq!(early.phase, 0);
        let step = early.receive(json!({"type":"extension_ui_request","method":"setStatus","statusKey":"pandacode-bridge","statusText":"ready"})).unwrap();
        assert_eq!(step.events[0].kind, "session");
        assert_eq!(step.write[0]["type"], "prompt");
        let mut p = ready();
        p.image_blocks
            .push(json!({"type":"image","mimeType":"image/png","data":"image"}));
        let step = p.receive(state()).unwrap();
        assert_eq!(step.events[0].kind, "session");
        assert_eq!(step.write[0]["type"], "prompt");
        assert_eq!(step.write[0]["images"][0]["data"], "image");
        assert_eq!(p.cancel()["type"], "abort");
    }

    #[test]
    fn selected_models_are_verified_with_or_without_a_provider() {
        let mut state = state();
        state["data"]["model"] = json!({"provider":"anthropic","id":"sonnet"});
        for (model, applied) in [("default", true), ("sonnet", true), ("anthropic/sonnet", true), ("opus", false), ("openai/sonnet", false)] {
            let mut p = ready();
            p.config.model = model.into();
            assert_eq!(p.receive(state.clone()).is_ok(), applied, "{model}");
        }
    }

    #[test]
    fn resumed_sessions_must_exist_in_this_folder() {
        let mut command = Command::new("pi");
        let mut config = super::super::tests::config("pi");
        config.resume_id = Some("01a15ba3-9096-76db-bd69-35168c0ecfa9".into());
        configure(&mut command, &config);
        let args: Vec<_> = command.as_std().get_args().map(|a| a.to_str().unwrap()).collect();
        assert!(args.windows(2).any(|a| a == ["--session-id", "01a15ba3-9096-76db-bd69-35168c0ecfa9"]));
        let mut p = Protocol::new(config);
        p.pi.ready = true;
        let mut empty = state();
        empty["data"]["messageCount"] = json!(0);
        assert!(p.receive(empty).err().unwrap().contains("saved session"));
    }

    #[test]
    fn a_failed_turn_is_retried_before_settling() {
        let mut p = ready();
        p.receive(state()).unwrap();
        p.receive(json!({"type":"message_start","message":{"role":"assistant"}})).unwrap();
        let failed = p.receive(json!({"type":"message_end","message":{"role":"assistant","stopReason":"error","errorMessage":"529 overloaded"}})).unwrap();
        assert!(!failed.done);
        let end = p.receive(json!({"type":"agent_end","messages":[],"willRetry":true})).unwrap();
        assert!(end.write.is_empty(), "agent_end does not finish a run");
        let retry = p.receive(json!({"type":"auto_retry_start","attempt":1,"maxAttempts":3,"delayMs":2000,"errorMessage":"529 overloaded"})).unwrap();
        assert!(retry.events[0].text.contains("attempt 1 of 3"));
        p.receive(json!({"type":"compaction_start","reason":"overflow"})).unwrap();
        p.receive(json!({"type":"auto_retry_end","success":true,"attempt":2})).unwrap();
        p.receive(json!({"type":"message_start","message":{"role":"assistant"}})).unwrap();
        p.receive(json!({"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Done"}],"stopReason":"stop"}})).unwrap();
        p.receive(json!({"type":"agent_end","messages":[],"willRetry":false})).unwrap();
        let settled = p.receive(json!({"type":"agent_settled","aborted":false})).unwrap();
        assert_eq!(settled.write[0]["type"], "get_session_stats");

        let mut p = ready();
        p.receive(state()).unwrap();
        p.receive(json!({"type":"message_end","message":{"role":"assistant","stopReason":"error","errorMessage":"529 overloaded"}})).unwrap();
        p.receive(json!({"type":"auto_retry_end","success":false,"attempt":3,"finalError":"Still overloaded"})).unwrap();
        assert_eq!(p.receive(json!({"type":"agent_settled","aborted":false})).err().unwrap(), "Still overloaded");
        let mut p = ready();
        p.receive(state()).unwrap();
        assert!(p.receive(json!({"type":"agent_settled","aborted":true})).is_err());
    }

    #[test]
    fn failed_stats_and_handled_prompts_still_finish() {
        let mut p = ready();
        p.receive(state()).unwrap();
        p.receive(json!({"type":"agent_settled","aborted":false})).unwrap();
        let end = p.receive(json!({"type":"response","command":"get_session_stats","id":"pandacode-usage","success":false,"error":"Unknown command"})).unwrap();
        assert!(end.done);
        assert!(end.events.is_empty());
        let mut p = ready();
        p.receive(state()).unwrap();
        let started = p.receive(json!({"type":"response","command":"prompt","id":"pandacode-prompt","success":true,"data":{"disposition":"started"}})).unwrap();
        assert!(!started.done);
        let handled = p.receive(json!({"type":"response","command":"prompt","id":"pandacode-prompt","success":true,"data":{"disposition":"handled"}})).unwrap();
        assert!(handled.done);
    }

    #[test]
    fn clamped_thinking_is_reported_instead_of_silently_changed() {
        let mut p = ready();
        p.config.reasoning_effort = Some("high".into());
        assert!(p.receive(state()).err().unwrap().contains("thinking level"));
    }

    #[test]
    fn stream_snapshots_do_not_duplicate_deltas_and_tools_keep_write_paths() {
        let mut p = ready();
        p.receive(state()).unwrap();
        p.receive(json!({"type":"message_start","message":{"role":"assistant"}}))
            .unwrap();
        let step = p.receive(json!({"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"Hello"}})).unwrap();
        assert_eq!(
            step.events
                .iter()
                .filter(|e| e.kind == "text")
                .map(|e| e.text.as_str())
                .collect::<String>(),
            "Hello"
        );
        let end = p.receive(json!({"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Hello"}],"stopReason":"stop"}})).unwrap();
        assert!(end.events.iter().all(|e| e.kind != "text"));
        let tool = p.receive(json!({"type":"tool_execution_start","toolCallId":"call","toolName":"write","args":{"path":"src/app.ts","content":"ok"}})).unwrap();
        assert_eq!(
            tool.events[0]
                .tool
                .as_ref()
                .unwrap()
                .write_paths
                .as_ref()
                .unwrap(),
            &["src/app.ts"]
        );
        let tool = p.receive(json!({"type":"tool_execution_end","toolCallId":"call","toolName":"write","result":{"content":[{"type":"text","text":"saved"}]},"isError":false})).unwrap();
        assert_eq!(tool.events[0].tool.as_ref().unwrap().status, "completed");
        assert!(p.receive(json!({"type":"agent_end","messages":[]})).unwrap().write.is_empty());
        assert_eq!(
            p.receive(json!({"type":"agent_settled","aborted":false}))
                .unwrap()
                .write[0]["type"],
            "get_session_stats"
        );
        let end = p.receive(json!({"type":"response","id":"pandacode-usage","success":true,"data":{"contextUsage":{"tokens":123,"contextWindow":200000}}})).unwrap();
        assert!(end.done);
        assert_eq!(end.events[0].data.as_ref().unwrap()["usedTokens"], 123);
    }

    #[test]
    fn confirmations_and_errors_use_native_protocol() {
        let mut p = ready();
        let request = p.receive(json!({"type":"extension_ui_request","id":"dialog","method":"confirm","title":"Allow bash?","message":"pwd"})).unwrap();
        let id = request.events[0].request_id.as_ref().unwrap();
        assert_eq!(
            p.approve(id, false).unwrap(),
            json!({"type":"extension_ui_response","id":"dialog","confirmed":false})
        );
        p.receive(json!({"type":"message_end","message":{"role":"assistant","stopReason":"error","errorMessage":"Rate limit"}})).unwrap();
        assert!(p.receive(json!({"type":"agent_settled","aborted":false})).err().unwrap().contains("Rate limit"));
        let dialog = p.receive(json!({"type":"extension_ui_request","id":"pick","method":"select","title":"Pick","options":["A"]})).unwrap();
        assert_eq!(dialog.write[0], json!({"type":"extension_ui_response","id":"pick","cancelled":true}));
    }

    #[test]
    fn model_metadata_is_provider_qualified_and_whitelisted() {
        let entries = parse_models(&json!({"models":[{"provider":"anthropic","id":"sonnet","name":"Sonnet","reasoning":true,"contextWindow":200000,"apiKey":"secret"}]})).unwrap();
        assert_eq!(entries[1].id, "anthropic/sonnet");
        assert_eq!(entries[1].context_window, Some(200000));
        assert!(!serde_json::to_string(&entries).unwrap().contains("secret"));
        assert!(
            parse_models(&json!({"models":[{"provider":"bad\nprovider","id":"model"}]})).is_err()
        );
    }

    #[tokio::test]
    #[ignore]
    async fn installed_pi_lists_models_without_prompting() {
        let path = executable("pi").expect("Pi is installed");
        assert!(!models(&path, "pi").await.unwrap().is_empty());
    }

    fn omp_ready() -> Protocol {
        let mut p = Protocol::new(super::super::tests::config("omp"));
        p.receive(json!({"type":"ready","protocolVersion":1,"supportedProtocolVersions":[1,2]})).unwrap();
        p.receive(json!({"type":"extension_ui_request","id":"s","method":"setStatus","statusKey":"pandacode-bridge","statusText":"ready"})).unwrap();
        let step = p.receive(state()).unwrap();
        assert_eq!(step.write[0]["type"], "prompt");
        p
    }

    #[test]
    fn omp_resumes_with_its_own_flag_and_owns_no_approvals() {
        let mut command = Command::new("omp");
        let mut config = super::super::tests::config("omp");
        config.resume_id = Some("01a15ba3-9096-76db-bd69-35168c0ecfa9".into());
        configure(&mut command, &config);
        let args: Vec<_> = command.as_std().get_args().map(|a| a.to_str().unwrap()).collect();
        assert!(args.windows(2).any(|a| a == ["--resume", "01a15ba3-9096-76db-bd69-35168c0ecfa9"]));
        assert!(args.windows(2).any(|a| a == ["--approval-mode", "yolo"]));
        assert!(!args.contains(&"--session-id"));
    }

    #[test]
    fn omp_finishes_on_prompt_result_once_the_session_settles() {
        // Frame shapes from omp 18.12 `modes/rpc/rpc-types.ts`.
        let mut p = omp_ready();
        p.receive(json!({"type":"response","command":"prompt","id":"pandacode-prompt","success":true,"data":{"agentInvoked":true}})).unwrap();
        p.receive(json!({"type":"message_start","message":{"role":"assistant"}})).unwrap();
        p.receive(json!({"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"Hi"}})).unwrap();
        p.receive(json!({"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Hi"}],"stopReason":"stop"}})).unwrap();
        assert!(p.receive(json!({"type":"agent_end","messages":[]})).unwrap().write.is_empty());
        assert!(p.receive(json!({"type":"session_settled"})).unwrap().write.is_empty(), "no prompt_result yet");
        let pending = p.receive(json!({"type":"prompt_result","id":"pandacode-prompt","agentInvoked":true,"status":"completed","sessionSettled":false})).unwrap();
        assert!(pending.write.is_empty(), "background work still runs");
        let settled = p.receive(json!({"type":"session_settled"})).unwrap();
        assert_eq!(settled.write[0]["type"], "get_session_stats");
        assert!(p.receive(json!({"type":"session_settled"})).unwrap().write.is_empty());

        let mut p = omp_ready();
        let settled = p.receive(json!({"type":"prompt_result","id":"pandacode-prompt","agentInvoked":false,"status":"completed","sessionSettled":true})).unwrap();
        assert_eq!(settled.write[0]["type"], "get_session_stats");
    }

    #[test]
    fn omp_failures_and_aborts_fail_the_run() {
        let mut p = omp_ready();
        let error = p.receive(json!({"type":"prompt_result","id":"pandacode-prompt","agentInvoked":true,"status":"error","error":{"message":"429 rate limited","retryable":true},"sessionSettled":true}));
        assert!(error.err().unwrap().contains("429"));
        let mut p = omp_ready();
        assert!(p.receive(json!({"type":"prompt_result","id":"pandacode-prompt","agentInvoked":true,"status":"aborted","sessionSettled":true})).is_err());
        assert!(stop_settled("omp", &json!({"type":"prompt_result"})));
        assert!(stop_settled("pi", &json!({"type":"agent_settled"})));
        assert!(!stop_settled("pi", &json!({"type":"session_settled"})));
    }

    #[test]
    fn omp_discovery_negotiates_v2_and_reassembles_chunks() {
        use base64::Engine;
        // Ready frame from omp 18.12 (issue #91) and chunk shape from omp `docs/rpc.md`.
        let mut d = Discovery::new("omp");
        let (write, _) = d.receive(json!({"type":"ready","protocolVersion":1,"supportedProtocolVersions":[1,2],"maxFrameBytes":1048576,"maxReassembledFrameBytes":67108864})).unwrap();
        assert_eq!(write, [json!({"type":"negotiate_protocol","id":"pandacode-protocol","protocolVersion":2})]);
        let (write, _) = d.receive(json!({"type":"response","command":"negotiate_protocol","id":"pandacode-protocol","success":true,"data":{"protocolVersion":2}})).unwrap();
        assert_eq!(write, [models_request()]);
        let response = json!({"type":"response","command":"get_available_models","id":"pandacode-models","success":true,"data":{"models":[{"provider":"anthropic","id":"sonnet"}]}}).to_string();
        let (a, b) = response.as_bytes().split_at(40);
        let chunk = |index: u64, part: &[u8]| json!({"type":"rpc_chunk","chunkId":"rpc-1","index":index,"count":2,"byteLength":response.len(),"data":base64::engine::general_purpose::STANDARD.encode(part)});
        assert!(d.receive(chunk(0, a)).unwrap().1.is_none());
        let models = d.receive(chunk(1, b)).unwrap().1.unwrap();
        assert_eq!(models[1].id, "anthropic/sonnet");

        // Interrupted or out-of-order sequences fail instead of parsing a fragment.
        let mut d = Discovery::new("omp");
        d.receive(chunk(0, a)).unwrap();
        assert!(d.receive(json!({"type":"session_settled"})).is_err());
        assert!(Discovery::new("omp").receive(chunk(1, b)).is_err());
    }

    #[test]
    fn discovery_reports_the_harness_error() {
        let mut d = Discovery::new("omp");
        let (write, _) = d.receive(json!({"type":"ready","protocolVersion":1})).unwrap();
        assert_eq!(write, [models_request()], "v1-only omp is asked directly");
        let error = d.receive(json!({"id":"pandacode-models","type":"response","command":"get_available_models","success":false,"error":"RPC response exceeded the transport limit"})).err().unwrap();
        assert_eq!(error, "RPC response exceeded the transport limit");
        // Pi asks at start and keeps the generic hint when no reason is given.
        let mut d = Discovery::new("pi");
        assert!(d.asked);
        assert!(d.receive(json!({"type":"response","id":"pandacode-models","success":false})).err().unwrap().contains("Check its login"));
    }

    #[tokio::test]
    #[ignore]
    async fn installed_omp_lists_models_without_prompting() {
        let path = executable("omp").expect("omp is installed");
        assert!(!models(&path, "omp").await.unwrap().is_empty());
    }
}
