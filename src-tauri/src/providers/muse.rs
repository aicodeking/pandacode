//! Muse Code (`muse serve`) over MSP, its JSON-RPC session protocol on stdio.
//! Muse has no ACP mode. Approval mode is selected on the wire; sandbox posture is
//! fixed by process flags, so each PandaCode mode maps onto both.
use super::goals::RpcReply;
use super::*;

/// Shown when Muse reports `authRequired`.
pub(super) const SIGN_IN: &str =
    "Muse Code is not signed in. Run `muse login` in a terminal, then send again.";

// Lifecycle request IDs. Steers, decisions and answers use IDs from `FIRST_COMMAND`.
const INITIALIZE: u64 = 1;
const SESSION: u64 = 2;
const APPROVAL_MODE: u64 = 3;
const MODEL: u64 = 4;
const SKILLS: u64 = 5;
const TURN: u64 = 6;
const FIRST_COMMAND: u64 = 100;
const EFFORTS: [&str; 8] = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

/// MSP commands carry a client-minted UUIDv7; Muse refuses any other version.
fn command_id() -> String {
    uuid::Uuid::now_v7().to_string()
}

pub(super) fn valid_effort(effort: &str) -> bool {
    EFFORTS.contains(&effort)
}

pub(super) fn configure(command: &mut Command, config: &RunConfig) {
    command.arg("serve").args(super::privacy::muse_arguments());
    // The launcher may start a device login when its update check is denied;
    // it must never wait for one on PandaCode's pipes.
    command.env("MUSE_LOGIN", "0");
    command.args(sandbox_args(&config.mode));
}

/// Process flags for each mode. Plan is read-only: no file writes and no shell.
pub(super) fn sandbox_args(mode: &str) -> &'static [&'static str] {
    match mode {
        "plan" => &["--disable-write", "--disable-shell"],
        "full" => &["--disable-sandbox"],
        _ => &[],
    }
}

/// MSP approval modes: Standard prompts for anything Muse's rules do not match;
/// Accept edits runs sandboxed work and prompts only to leave the sandbox.
pub(super) fn approval_mode(mode: &str) -> &'static str {
    match mode {
        "auto" => "onRequest",
        "plan" => "denyUnmatched",
        "full" => "allowAll",
        _ => "promptUnmatched",
    }
}

#[derive(Default)]
pub(super) struct State {
    next_id: u64,
    /// Unanswered `turn/steer` requests: RPC id → (steer id, text, MSP command id, reply).
    steers: HashMap<u64, (String, String, String, RpcReply)>,
    /// Accepted live steers not yet taken, by MSP command id → steer id. Muse may
    /// take one into the running turn or run it as its own following turn.
    live: HashMap<String, String>,
    /// Steers Muse took before their acknowledgement arrived.
    consumed_steers: HashSet<String>,
    /// The run's turn completed while a steer was still unresolved.
    turn_finished: bool,
    skills: Option<Vec<String>>,
}

pub(super) fn parse_models(result: &Value) -> Result<Vec<ModelInfo>, String> {
    let entries = result["models"]
        .as_array()
        .filter(|v| v.len() <= MODEL_CATALOG_LIMIT)
        .ok_or("Invalid Muse model catalog")?;
    let mut models = vec![ModelInfo::default_choice()];
    let mut seen = HashSet::new();
    for entry in entries {
        let id = field(entry, "modelId");
        if !valid_model_id(id) {
            return Err("Invalid Muse model ID".into());
        }
        if !seen.insert(id.to_owned()) {
            continue;
        }
        let efforts: Vec<_> = entry["variants"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter(|effort| valid_effort(effort))
            .map(|effort| effort_info(effort, None))
            .collect();
        let default = entry["defaultReasoningEffort"]
            .as_str()
            .filter(|effort| efforts.iter().any(|option| option.id == *effort))
            .map(str::to_owned);
        models.push(ModelInfo {
            name: model_text(entry["displayLabel"].as_str(), id, 160),
            description: model_text(entry["description"].as_str(), "", 200),
            id: id.into(),
            reasoning_efforts: efforts,
            default_reasoning_effort: default,
            context_window: entry["contextLimit"]
                .as_u64()
                .filter(|n| *n > 0 && *n <= 1_000_000_000),
        });
    }
    Ok(models)
}

fn initialize() -> Value {
    json!({"jsonrpc":"2.0","id":INITIALIZE,"method":"initialize","params":{
        "clientInfo":{"name":"pandacode","title":"PandaCode","version":env!("CARGO_PKG_VERSION")},
        "capabilities":{"requestedCapabilities":["sessionMcp"]}
    }})
}

/// Reads the model catalog from a memory-only host. No session and no prompt.
pub(super) async fn models(path: &Path) -> Result<Vec<ModelInfo>, String> {
    let mut command = super::command(path)?;
    command.args(["serve", "--no-session-log"]).args(super::privacy::muse_arguments()).env("MUSE_LOGIN", "0");
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
        .map_err(|e| format!("Could not start Muse Code: {e}"))?;
    let group = ProcessGroup::register(child.id());
    let result = tokio::time::timeout(Duration::from_secs(20), async {
        use tokio::io::AsyncBufReadExt;
        let mut stdin = child.stdin.take().ok_or("Muse stdin unavailable")?;
        let mut stdout =
            tokio::io::BufReader::new(child.stdout.take().ok_or("Muse stdout unavailable")?)
                .take(4 * 1024 * 1024 + 1);
        write_json(&mut stdin, &initialize()).await?;
        let mut total = 0;
        loop {
            let mut line = Vec::new();
            let count = stdout.read_until(b'\n', &mut line).await.map_err(|e| e.to_string())?;
            total += count;
            if total > 4 * 1024 * 1024 {
                return Err("Muse model catalog exceeded its output limit".into());
            }
            if count == 0 {
                return Err("Muse Code exited before returning models".into());
            }
            let value: Value =
                serde_json::from_slice(&line).map_err(|_| "Invalid Muse discovery JSON")?;
            if value.get("error").is_some() {
                return Err(format!("Muse Code could not list models: {}", short(field(&value["error"], "message"))));
            }
            match value["id"].as_u64() {
                Some(INITIALIZE) => {
                    write_json(&mut stdin, &json!({"jsonrpc":"2.0","method":"initialized"})).await?;
                    write_json(&mut stdin, &json!({"jsonrpc":"2.0","id":2,"method":"model/list","params":{}})).await?;
                }
                Some(2) => return parse_models(&value["result"]),
                _ => {}
            }
        }
    })
    .await
    .unwrap_or_else(|_| Err("Muse model discovery timed out".into()));
    drop(group);
    let _ = child.start_kill();
    let _ = tokio::time::timeout(Duration::from_secs(1), child.wait()).await;
    result
}

/// MSP `mcpServers` entry for PandaCode's per-run tool server.
fn mcp_servers(server: &Value) -> Value {
    let headers: serde_json::Map<String, Value> = server["headers"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|header| Some((header["name"].as_str()?.to_owned(), header["value"].clone())))
        .collect();
    json!({field(server, "name"): {"transport":"streamableHttp","url":server["url"],"headers":headers}})
}

fn tool_status(status: &str) -> &'static str {
    match status {
        "inProgress" => "running",
        "completed" => "completed",
        _ => "failed",
    }
}

/// Paths a Muse file tool writes, from its JSON arguments.
fn write_paths(tool: &str, args: &Value) -> Option<Vec<String>> {
    match tool {
        "bash" | "shell" => Some(vec![]),
        "apply_patch" => Some(
            field(args, "input")
                .lines()
                .chain(field(args, "patch").lines())
                .filter_map(|line| {
                    ["*** Add File: ", "*** Update File: ", "*** Delete File: ", "*** Move to: "]
                        .iter()
                        .find_map(|prefix| line.strip_prefix(prefix))
                })
                .map(|path| path.trim().to_owned())
                .collect(),
        ),
        _ if tool.contains("write") || tool.contains("edit") => Some(
            ["path", "file_path"]
                .iter()
                .filter_map(|key| args[key].as_str())
                .filter(|path| path.len() <= 4096)
                .map(str::to_owned)
                .collect(),
        ),
        _ => None,
    }
}

impl Protocol {
    pub(super) fn muse_initial(&self) -> Value {
        initialize()
    }

    fn muse_request(&mut self, method: &str, params: Value) -> (u64, Value) {
        let id = FIRST_COMMAND + self.muse.next_id;
        self.muse.next_id += 1;
        (id, json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))
    }

    pub(super) fn muse(&mut self, value: Value) -> Result<Step, String> {
        let mut step = Step::default();
        let method = field(&value, "method").to_owned();
        if method.is_empty() {
            self.muse_response(value, &mut step)?;
            return Ok(step);
        }
        let params = &value["params"];
        if value.get("id").is_some() {
            // Server requests: acknowledge presentation, then decide with a command.
            match method.as_str() {
                "approval/request" | "userInput/request" if field(params, "sessionId") == self.remote_id => {
                    step.write.push(json!({"jsonrpc":"2.0","id":value["id"],"result":{}}));
                    if method == "approval/request" {
                        self.muse_approval(value, &mut step)?;
                    } else {
                        self.muse_question(&value, &mut step);
                    }
                }
                _ => step.write.push(json!({"jsonrpc":"2.0","id":value["id"],"error":{"code":-32601,"message":"This client does not support this request"}})),
            }
            return Ok(step);
        }
        if params.get("sessionId").is_some() && field(params, "sessionId") != self.remote_id {
            return Ok(step);
        }
        match method.as_str() {
            "turn/started" => {
                let turn = field(params, "turnId");
                if self.muse_steer_seen(turn, &mut step) {
                    // A late steer runs as its own turn; the run follows it.
                    self.turn_id = turn.into();
                    self.muse.turn_finished = false;
                }
            }
            "item/started" | "item/updated" | "item/completed" => {
                self.muse_item(&params["item"], method == "item/completed", &mut step)
            }
            "item/delta" => {
                let id = field(params, "itemId");
                let delta = field(params, "delta");
                if let Some(tool) = self.tools.get(id) {
                    let mut output = tool.output.clone();
                    append_preview(&mut output, delta, TOOL_OUTPUT_LIMIT);
                    self.tool_update(id, None, None, None, Some(output), &mut step);
                } else if field(params, "field") == "text" {
                    self.text_delta(id, None, delta, &mut step);
                }
            }
            "session/contextUsage" => {
                if let Some(used) = params["usedTokens"].as_u64() {
                    self.usage(used, params["windowTokens"].as_u64(), &mut step);
                }
            }
            "approval/resolved" => {
                // Muse's own judge, a rule, or another client decided it first.
                let approval = field(params, "approvalId");
                let ids: Vec<_> = self
                    .pending
                    .iter()
                    .filter(|(_, request)| field(&request["params"], "approvalId") == approval)
                    .map(|(id, _)| id.clone())
                    .collect();
                for id in ids {
                    self.pending.remove(&id);
                    let mut event = self.event("approval_cancelled", "", None);
                    event.request_id = Some(id);
                    step.events.push(event);
                }
            }
            "userInput/settled" => self.resolved_request(&params["userInputId"], &mut step),
            "turn/retryScheduled" => step.events.push(self.event("status", "Provider is retrying", None)),
            "turn/completed" if field(params, "turnId") == self.turn_id => self.muse_completed(params, &mut step)?,
            "session/closed" => return Err("Muse Code closed the session".into()),
            _ => {}
        }
        Ok(step)
    }

    fn muse_response(&mut self, value: Value, step: &mut Step) -> Result<(), String> {
        let Some(id) = value["id"].as_u64() else { return Ok(()) };
        let error = value.get("error").map(|error| short(field(error, "message")));
        if let Some((steer, text, command, reply)) = self.muse.steers.remove(&id) {
            // The echo may precede this acknowledgement, so a taken steer is delivered at once.
            let consumed = self.muse.consumed_steers.remove(&command);
            if error.is_some() {
                // Refused (usually the turn ended first): it becomes the next turn instead.
                self.accept(steer, text, "next-turn", reply, step);
            } else {
                self.accept(steer.clone(), text, "live", reply, step);
                if consumed {
                    self.steer_delivered(&steer, step);
                } else {
                    self.muse.live.insert(command, steer);
                }
            }
            if self.muse.turn_finished {
                self.muse_turn_over(step);
            }
            return Ok(());
        }
        if id >= FIRST_COMMAND {
            // A refused decision or answer leaves the request pending in Muse; never fail the run.
            if let Some(error) = error {
                step.events.push(self.event("status", format!("Muse Code refused the response: {error}"), None));
            }
            return Ok(());
        }
        if let Some(error) = error {
            if id == SESSION && self.config.resume_id.is_some() {
                return Err(format!("Muse Code could not resume this task's session: {error}"));
            }
            return Err(error);
        }
        let result = &value["result"];
        match id {
            INITIALIZE => {
                step.write.push(json!({"jsonrpc":"2.0","method":"initialized"}));
                let mut params = json!({"commandId":command_id()});
                if let Some(server) = &self.mcp_server {
                    let granted = result["grantedCapabilities"].as_array().is_some_and(|c| c.iter().any(|c| c == "sessionMcp"));
                    if granted {
                        params["config"] = json!({"mcpServers":mcp_servers(server)});
                    } else if self.mcp_required {
                        return Err("This Muse Code version cannot attach PandaCode's agent tools. Update Muse Code and retry.".into());
                    }
                }
                let method = if let Some(session) = &self.config.resume_id {
                    params["sessionId"] = json!(session);
                    params["excludeItems"] = json!(true);
                    "session/resume"
                } else {
                    params["workspaceRoot"] = json!(self.config.cwd);
                    params["approvalMode"] = json!(approval_mode(&self.config.mode));
                    if self.config.model != "default" && !self.config.model.is_empty() {
                        params["modelId"] = json!(self.config.model);
                    }
                    "session/start"
                };
                step.write.push(json!({"jsonrpc":"2.0","id":SESSION,"method":method,"params":params}));
            }
            SESSION => {
                self.remote_id = string(&result["session"], "sessionId");
                if self.remote_id.is_empty() {
                    return Err("Muse Code did not return a session ID".into());
                }
                step.events.push(self.event("session", self.remote_id.clone(), None));
                if self.config.resume_id.is_some() {
                    // A resumed session keeps its last mode; always apply this task's.
                    let params = json!({"commandId":command_id(),"sessionId":self.remote_id,"mode":approval_mode(&self.config.mode)});
                    step.write.push(json!({"jsonrpc":"2.0","id":APPROVAL_MODE,"method":"session/setApprovalMode","params":params}));
                } else {
                    self.muse_ready(step);
                }
            }
            APPROVAL_MODE => {
                if self.config.model != "default" && !self.config.model.is_empty() {
                    let params = json!({"commandId":command_id(),"sessionId":self.remote_id,"model":{"modelId":self.config.model}});
                    step.write.push(json!({"jsonrpc":"2.0","id":MODEL,"method":"session/setModel","params":params}));
                } else {
                    self.muse_ready(step);
                }
            }
            MODEL => self.muse_ready(step),
            SKILLS => {
                self.muse.skills = Some(
                    result["skills"].as_array().into_iter().flatten().take(1000)
                        .filter_map(|skill| skill["selector"].as_str().map(str::to_owned))
                        .collect(),
                );
                self.muse_turn(step);
            }
            TURN => {
                self.turn_id = string(result, "turnId");
                if self.turn_id.is_empty() {
                    return Err("Muse Code did not start a turn".into());
                }
            }
            _ => {}
        }
        Ok(())
    }

    /// The session is configured. A leading `/name` may be a Muse skill, which
    /// travels as a skill part, so the catalog is read first.
    fn muse_ready(&mut self, step: &mut Step) {
        if self.config.prompt.trim_start().starts_with('/') {
            step.write.push(json!({"jsonrpc":"2.0","id":SKILLS,"method":"skill/list","params":{"sessionId":self.remote_id}}));
        } else {
            self.muse_turn(step);
        }
    }

    pub(super) fn muse_turn(&mut self, step: &mut Step) {
        let prompt = self.config.prompt.trim_start();
        let skill = prompt
            .strip_prefix('/')
            .map(|rest| rest.split_once(char::is_whitespace).unwrap_or((rest, "")))
            .filter(|(name, _)| self.muse.skills.iter().flatten().any(|skill| skill == name))
            .map(|(name, arguments)| (name.to_owned(), arguments.trim().to_owned()));
        let input = if let Some((selector, arguments)) = skill {
            self.config.prompt.clear();
            let mut input = self.prompt_content();
            let mut part = json!({"type":"skill","selector":selector});
            if !arguments.is_empty() {
                part["arguments"] = json!(arguments);
            }
            input.push(part);
            input
        } else {
            self.prompt_content()
        };
        let mut params = json!({"commandId":command_id(),"sessionId":self.remote_id,"input":input});
        if let Some(effort) = &self.config.reasoning_effort {
            params["reasoningEffort"] = json!(effort);
        }
        step.write.push(json!({"jsonrpc":"2.0","id":TURN,"method":"turn/start","params":params}));
        self.phase = 1;
    }

    fn muse_item(&mut self, item: &Value, completed: bool, step: &mut Step) {
        let id = field(item, "itemId");
        match field(item, "kind") {
            "agentMessage" => {
                let phase = match field(item, "messagePhase") {
                    "finalAnswer" => Some("final_answer"),
                    "commentary" => Some("commentary"),
                    _ => None,
                };
                if completed {
                    self.text_snapshot(id, phase, field(item, "text"), step);
                } else {
                    self.remember_text_phase(id, phase);
                }
            }
            "reasoning" if !completed => step.events.push(self.event("status", "Reasoning", None)),
            "userMessage" if item["steered"] == true || item.get("commandId").is_some() => {
                // A steer taken into the running turn.
                if !self.muse_steer_seen(field(item, "commandId"), step) && item["steered"] == true && item.get("commandId").is_none() {
                    for (_, steer) in std::mem::take(&mut self.muse.live) {
                        self.steer_delivered(&steer, step);
                    }
                }
            }
            "toolCall" | "webSearch" | "subagent" | "userShell" => {
                let kind = field(item, "kind");
                let name = match kind {
                    "toolCall" => field(item, "tool"),
                    "webSearch" => "Web search",
                    "subagent" => "Subagent",
                    _ => "Shell",
                };
                let input = item["args"].as_str().or(item["commandText"].as_str()).or(item["objective"].as_str());
                let output = item["visibleOutput"].as_str().or(item["finalSummary"].as_str());
                self.tool_update(
                    id,
                    Some(name),
                    Some(tool_status(field(item, "status"))),
                    input.map(|text| limited(text, TOOL_INPUT_LIMIT)),
                    output.map(|text| limited(text, TOOL_OUTPUT_LIMIT)),
                    step,
                );
                if kind == "toolCall" {
                    let args = serde_json::from_str(field(item, "args")).unwrap_or(Value::Null);
                    self.tool_paths(id, write_paths(name, &args), step);
                }
            }
            "compaction" => step.events.push(self.event(
                "status",
                if completed { "Context compacted" } else { "Compacting context" },
                None,
            )),
            _ => {}
        }
    }

    fn muse_completed(&mut self, params: &Value, step: &mut Step) -> Result<(), String> {
        match field(params, "terminal") {
            "completed" => {
                self.muse.turn_finished = true;
                self.muse_turn_over(step);
                Ok(())
            }
            "cancelled" => Err("Muse Code cancelled the turn".into()),
            _ => {
                let error = &params["error"];
                if error["kind"] == "authRequired" {
                    return Err(SIGN_IN.into());
                }
                let message = error["message"].as_str().or(params["reason"].as_str()).unwrap_or("Muse Code could not finish the turn");
                if let Some(resets) = error["quota"]["resetsAtMs"].as_i64() {
                    step.events.push(self.limited_event(Some(resets), None));
                    step.failure = Some(short(message));
                    return Ok(());
                }
                Err(short(message))
            }
        }
    }

    fn muse_approval(&mut self, value: Value, step: &mut Step) -> Result<(), String> {
        let params = &value["params"];
        let subject = &params["subject"];
        let label = subject["command"]
            .as_str()
            .map(|command| format!("Run `{command}`"))
            .or_else(|| subject["path"].as_str().map(|path| format!("{} {path}", field(params, "toolName"))))
            .unwrap_or_else(|| format!("Allow {}?", field(params, "toolName")));
        self.approval(value, label, step)
    }

    /// MSP questions become the shared structured-input form. `isOther` lets the
    /// user type an answer, which Muse takes as free text.
    fn muse_question(&mut self, value: &Value, step: &mut Step) {
        let params = &value["params"];
        let questions: Vec<_> = params["questions"].as_array().into_iter().flatten().map(|q| json!({
            "id":q["id"],"header":q["header"],"question":q["question"],"isOther":true,"isSecret":false,"options":q["options"].as_array().map(|options| options.iter().map(|o| json!({"label":o["label"],"description":o["description"].as_str().unwrap_or("")})).collect::<Vec<_>>())
        })).collect();
        let request = json!({"id":params["userInputId"],"method":"item/tool/requestUserInput","params":{"questions":questions}});
        self.input_request(request, step);
        // The shared form validates text and options; selection mode is Muse's own.
        let selections: HashMap<String, Value> = params["questions"].as_array().into_iter().flatten()
            .filter(|q| q["selection"]["mode"] == "multiple")
            .filter_map(|q| Some((q["id"].as_str()?.to_owned(), q["selection"].clone())))
            .collect();
        if let Some(event) = step.events.last_mut().filter(|e| e.kind == "input_request") {
            let id = event.request_id.clone().unwrap_or_default();
            let mark = |questions: &mut Value| {
                for question in questions.as_array_mut().into_iter().flatten() {
                    if let Some(selection) = question["id"].as_str().and_then(|id| selections.get(id)) {
                        question["multiSelect"] = json!(true);
                        question["minSelections"] = selection["minSelections"].clone();
                        question["maxSelections"] = selection["maxSelections"].clone();
                    }
                }
            };
            if let Some(data) = event.data.as_mut() {
                mark(&mut data["questions"]);
            }
            if let Some(stored) = self.inputs.get_mut(&id) {
                mark(&mut stored["params"]["questions"]);
            }
        }
        if step.write.last().is_some_and(|frame| frame["error"].is_object()) {
            // The form was refused; answer Muse so the turn does not wait forever.
            step.write.pop();
            let (_, cancel) = self.muse_request("userInput/cancel", json!({"commandId":command_id(),"sessionId":self.remote_id,"userInputId":params["userInputId"]}));
            step.write.push(cancel);
        }
    }

    /// Validates the form response `{answers:{id:[text, …]}}` against the stored
    /// questions and sends `userInput/answer`: offered labels as `selectedLabel(s)`,
    /// the typed answer as `freeText`. An empty response cancels the question.
    pub(super) fn muse_user_input(&mut self, id: &str, response: Value) -> Result<Step, String> {
        let request = self.inputs.get(id).ok_or("This input request is no longer active")?;
        let answers = response.as_object()
            .filter(|object| object.len() == 1)
            .and_then(|object| object.get("answers")?.as_object())
            .ok_or("Invalid answer format")?;
        let questions = request["params"]["questions"].as_array().cloned().unwrap_or_default();
        if !answers.is_empty() && answers.len() != questions.len() {
            return Err("Answer every question before continuing".into());
        }
        let mut output = Vec::with_capacity(answers.len());
        for (question_id, values) in answers {
            let question = questions.iter().find(|q| q["id"] == question_id.as_str()).ok_or("Response contains an unknown question")?;
            let multiple = question["multiSelect"] == true;
            let values: Vec<&str> = values.as_array().ok_or("Invalid answer format")?.iter()
                .map(|value| value.as_str().filter(|text| !text.trim().is_empty() && text.len() <= 8192).ok_or("Invalid answer"))
                .collect::<Result<_, _>>()?;
            let min = if multiple { question["minSelections"].as_u64().unwrap_or(1).max(1) } else { 1 } as usize;
            let max = if multiple { question["maxSelections"].as_u64().map_or(usize::MAX, |n| n as usize) } else { 1 };
            if values.len() < min || values.len() > max {
                return Err(format!("Choose the requested number of answers for “{}”", field(question, "header")));
            }
            let offered: Vec<&str> = question["options"].as_array().into_iter().flatten().filter_map(|o| o["label"].as_str()).collect();
            let (labels, typed): (Vec<&str>, Vec<&str>) = values.iter().partition(|value| offered.contains(value));
            if typed.len() > 1 {
                return Err("Give at most one typed answer".into());
            }
            let mut answer = json!({"questionId":question_id});
            if multiple {
                if !labels.is_empty() {
                    answer["selectedLabels"] = json!(labels);
                }
            } else if let Some(label) = labels.first() {
                answer["selectedLabel"] = json!(label);
            }
            if let Some(text) = typed.first() {
                answer["freeText"] = json!(text);
            }
            output.push(answer);
        }
        let request = self.inputs.remove(id).unwrap();
        let frame = if output.is_empty() {
            self.muse_answer(&request, &json!({"answers":{}}))
        } else {
            self.muse_request("userInput/answer", json!({"commandId":command_id(),"sessionId":self.remote_id,"userInputId":request["id"],"answers":output})).1
        };
        let mut event = self.event("input_cancelled", "", None);
        event.request_id = Some(id.into());
        Ok(Step { write: vec![frame], events: vec![event], ..Step::default() })
    }

    /// `userInput/answer` for a validated form result `{answers:{id:{answers:[text]}}}`.
    pub(super) fn muse_answer(&mut self, request: &Value, result: &Value) -> Value {
        let options = |id: &str| -> Vec<String> {
            request["params"]["questions"].as_array().into_iter().flatten()
                .filter(|q| q["id"] == id)
                .flat_map(|q| q["options"].as_array().into_iter().flatten())
                .filter_map(|o| o["label"].as_str().map(str::to_owned))
                .collect()
        };
        let empty = serde_json::Map::new();
        let answers: Vec<_> = result["answers"].as_object().unwrap_or(&empty).iter().map(|(id, value)| {
            let text = value["answers"][0].as_str().unwrap_or_default();
            if options(id).iter().any(|label| label == text) {
                json!({"questionId":id,"selectedLabel":text})
            } else {
                json!({"questionId":id,"freeText":text})
            }
        }).collect();
        let (method, params) = if answers.is_empty() {
            ("userInput/cancel", json!({"commandId":command_id(),"sessionId":self.remote_id,"userInputId":request["id"]}))
        } else {
            ("userInput/answer", json!({"commandId":command_id(),"sessionId":self.remote_id,"userInputId":request["id"],"answers":answers}))
        };
        self.muse_request(method, params).1
    }

    /// `approval/decide` with an offered choice. Approve picks the narrowest grant
    /// (this call, then this session); decline picks a plain rejection, then `abort`
    /// (reject and stop the call). Choices that write a lasting rule are never picked
    /// for a one-time PandaCode decision. `None` when Muse offered no such choice, so
    /// the prompt stays open instead of sending an ID Muse would refuse.
    pub(super) fn muse_decide(&mut self, request: &Value, approved: bool) -> Option<Value> {
        let params = &request["params"];
        let wanted: &[&str] = if approved { &["approved", "approvedForSession"] } else { &["denied", "abort"] };
        let choice = wanted.iter().find_map(|decision| {
            params["availableChoices"].as_array().into_iter().flatten()
                .find(|c| c["decision"] == *decision && c["choiceId"].as_str().is_some_and(|id| !id.is_empty()))
        })?;
        Some(self.muse_request("approval/decide", json!({
            "commandId":command_id(),"sessionId":params["sessionId"],"approvalId":params["approvalId"],
            "choiceId":choice["choiceId"],"requirementId":params["currentRequirementId"]
        })).1)
    }

    /// Marks a steer as taken (echoed or started as its own turn), in either order
    /// relative to its acknowledgement. Returns whether `command` was a steer.
    fn muse_steer_seen(&mut self, command: &str, step: &mut Step) -> bool {
        if let Some(steer) = self.muse.live.remove(command) {
            self.steer_delivered(&steer, step);
            return true;
        }
        if self.muse.steers.values().any(|(_, _, id, _)| id == command) {
            self.muse.consumed_steers.insert(command.to_owned());
            return true;
        }
        false
    }

    /// The run's turn completed. An unanswered steer decides what follows; an
    /// accepted one Muse has not taken runs as its own turn next; held steers
    /// become the next `turn/start` of this session; otherwise the run is done.
    fn muse_turn_over(&mut self, step: &mut Step) {
        if !self.muse.steers.is_empty() || !self.muse.live.is_empty() {
            return;
        }
        self.muse.turn_finished = false;
        self.next_steered_turn(step);
    }

    pub(super) fn muse_steer_count(&self) -> usize {
        self.muse.steers.len()
    }

    /// `turn/steer` into the running turn; with no turn to take it (startup or
    /// between turns), the steer is held for the next turn of this session.
    pub(super) fn muse_steer(&mut self, id: String, text: String, reply: RpcReply) -> Step {
        let mut step = Step::default();
        if self.remote_id.is_empty() || self.turn_id.is_empty() || self.muse.turn_finished {
            self.accept(id, text, "next-turn", reply, &mut step);
            return step;
        }
        let command = command_id();
        let mut params = json!({"commandId":command,"sessionId":self.remote_id,"expectedTurnId":self.turn_id,"input":[{"type":"text","text":text}]});
        if let Some(effort) = &self.config.reasoning_effort {
            params["reasoningEffort"] = json!(effort);
        }
        let (request_id, request) = self.muse_request("turn/steer", params);
        self.muse.steers.insert(request_id, (id, text, command, reply));
        step.write.push(request);
        step
    }

    pub(super) fn muse_cancel(&self) -> Value {
        let mut params = json!({"commandId":command_id(),"sessionId":self.remote_id});
        if !self.turn_id.is_empty() {
            params["turnId"] = json!(self.turn_id);
        }
        json!({"jsonrpc":"2.0","id":900,"method":"turn/interrupt","params":params})
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SESSION_ID: &str = "01a16681-4036-7383-ab96-9dd8865524d8";
    const TURN_ID: &str = "01a16681-41b4-771e-a65f-9bffe29d423d";

    /// Recorded from `muse serve` 1.4.12: the `initialize` result.
    fn initialized() -> Value {
        json!({"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"muse","version":"1.4.12"},"userAgent":"muse-build/1.4.12 (serve; macos-aarch64)","museHome":"/Users/sample/.local/share/muse","platformFamily":"unix","platformOs":"macos","schema":{"version":1,"fingerprint":"sha256:cfdb"},"grantedCapabilities":["sessionMcp"],"experimentalApi":false,"sessionDurability":"durable","sandboxAvailability":"available"}})
    }

    fn session_result() -> Value {
        json!({"jsonrpc":"2.0","id":2,"result":{"session":{"sessionId":SESSION_ID,"path":"/s/session.jsonl","status":"idle","activeTurnId":null,"createdAt":"2026-10-23T02:05:09.072691Z","updatedAt":"2026-10-23T02:05:09.082737Z","workspaceRoot":"/tmp","providerId":"meta","modelId":"muse-spark-1.3","turnCount":0,"forkedFrom":null,"sideFrom":null,"approvalMode":{"mode":"promptUnmatched","source":"startup","lastCommandId":null},"kind":"root"},"viewCursor":format!("v4:{SESSION_ID}:1")}})
    }

    fn turn_result() -> Value {
        json!({"jsonrpc":"2.0","id":6,"result":{"commandId":TURN_ID,"status":"accepted","turnId":TURN_ID,"startedNewTurn":true,"disposition":"started"}})
    }

    fn started(mode: &str, model: &str, resume: bool) -> (Protocol, Vec<Value>) {
        let mut cfg = super::super::tests::config("muse");
        cfg.mode = mode.into();
        cfg.model = model.into();
        cfg.reasoning_effort = Some("low".into());
        if resume {
            cfg.resume_id = Some(SESSION_ID.into());
        }
        let mut p = Protocol::new(cfg);
        let mut writes = vec![p.initial()];
        writes.extend(p.receive(initialized()).unwrap().write);
        let step = p.receive(session_result()).unwrap();
        assert_eq!(step.events[0].kind, "session");
        assert_eq!(step.events[0].text, SESSION_ID);
        writes.extend(step.write);
        if resume {
            writes.extend(p.receive(json!({"jsonrpc":"2.0","id":3,"result":{"commandId":"c","status":"accepted","applyOutcome":"completed"}})).unwrap().write);
            if model != "default" {
                writes.extend(p.receive(json!({"jsonrpc":"2.0","id":4,"result":{"commandId":"c","status":"accepted"}})).unwrap().write);
            }
        }
        p.receive(turn_result()).unwrap();
        (p, writes)
    }

    fn is_v7(id: &Value) -> bool {
        uuid::Uuid::parse_str(id.as_str().unwrap()).unwrap().get_version_num() == 7
    }

    fn frame(method: &str, params: Value) -> Value {
        let mut params = params;
        params["sessionId"] = json!(SESSION_ID);
        json!({"jsonrpc":"2.0","method":method,"params":params})
    }

    #[test]
    fn modes_map_to_wire_approval_modes_and_process_sandbox_flags() {
        assert_eq!(approval_mode("ask"), "promptUnmatched");
        assert_eq!(approval_mode("auto"), "onRequest");
        assert_eq!(approval_mode("plan"), "denyUnmatched");
        assert_eq!(approval_mode("full"), "allowAll");
        assert_eq!(sandbox_args("plan"), ["--disable-write", "--disable-shell"]);
        assert_eq!(sandbox_args("full"), ["--disable-sandbox"]);
        assert!(sandbox_args("ask").is_empty() && sandbox_args("auto").is_empty());
        let mut command = Command::new("muse");
        let mut cfg = super::super::tests::config("muse");
        cfg.mode = "full".into();
        configure(&mut command, &cfg);
        let args: Vec<_> = command.as_std().get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        assert_eq!(args, ["serve", "--disable-sandbox"]);
        // With telemetry off, the opt-out follows `serve`: Muse refuses root options before it.
        super::super::privacy::FORCE.with(|force| force.set(Some(true)));
        let mut command = Command::new("muse");
        configure(&mut command, &cfg);
        super::super::privacy::FORCE.with(|force| force.set(None));
        let args: Vec<_> = command.as_std().get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        assert_eq!(args, ["serve", "-c", "telemetry.enabled=false", "--disable-sandbox"]);
    }

    #[test]
    fn new_session_starts_with_mode_model_and_tools_then_streams_the_turn() {
        let mut cfg = super::super::tests::config("muse");
        cfg.model = "muse-spark-1.3".into();
        cfg.reasoning_effort = Some("low".into());
        let mut p = Protocol::new(cfg);
        p.mcp_server = Some(json!({"type":"http","name":"pandacode_architect","url":"http://127.0.0.1:9/mcp","headers":[{"name":"Authorization","value":"Bearer t"}]}));
        assert_eq!(p.initial()["params"]["capabilities"]["requestedCapabilities"][0], "sessionMcp");
        let writes = p.receive(initialized()).unwrap().write;
        assert_eq!(writes[0]["method"], "initialized");
        let start = &writes[1];
        assert_eq!(start["method"], "session/start");
        assert!(is_v7(&start["params"]["commandId"]));
        assert_eq!(start["params"]["approvalMode"], "promptUnmatched");
        assert_eq!(start["params"]["modelId"], "muse-spark-1.3");
        assert_eq!(start["params"]["workspaceRoot"], "/tmp");
        let server = &start["params"]["config"]["mcpServers"]["pandacode_architect"];
        assert_eq!(server["transport"], "streamableHttp");
        assert_eq!(server["headers"]["Authorization"], "Bearer t");
        let turn = p.receive(session_result()).unwrap().write;
        assert_eq!(turn[0]["method"], "turn/start");
        assert_eq!(turn[0]["params"]["sessionId"], SESSION_ID);
        assert_eq!(turn[0]["params"]["reasoningEffort"], "low");
        assert_eq!(turn[0]["params"]["input"], json!([{"type":"text","text":"Explain this project"}]));
        p.receive(turn_result()).unwrap();

        // Recorded frames of a turn answering "hi".
        let item = "ee208876-6212-48ea-85ee-148fbff061a4";
        p.receive(frame("turn/started", json!({"turnId":TURN_ID,"commandId":TURN_ID}))).unwrap();
        p.receive(frame("item/started", json!({"item":{"itemId":"r","kind":"reminderChild","turnId":TURN_ID,"revision":1,"status":"inProgress","fallbackText":"Reminder child session"}}))).unwrap();
        p.receive(frame("item/started", json!({"item":{"itemId":item,"kind":"agentMessage","turnId":TURN_ID,"revision":1,"status":"inProgress","text":""}}))).unwrap();
        let step = p.receive(frame("item/delta", json!({"itemId":item,"field":"text","delta":"hi"}))).unwrap();
        assert!(step.events.iter().any(|e| e.kind == "text" && e.text == "hi"));
        let step = p.receive(frame("item/completed", json!({"item":{"itemId":item,"kind":"agentMessage","turnId":TURN_ID,"revision":2,"status":"completed","text":"hi","messagePhase":"finalAnswer"}}))).unwrap();
        assert!(!step.events.iter().any(|e| e.kind == "text"), "the snapshot does not repeat streamed text");
        let step = p.receive(frame("session/contextUsage", json!({"windowTokens":1007997,"usedTokens":31669,"pressure":"normal"}))).unwrap();
        assert_eq!(step.events[0].kind, "usage");
        assert_eq!(step.events[0].data.as_ref().unwrap()["usedTokens"], 31669);
        let step = p.receive(frame("turn/foregroundCompleted", json!({"turnId":TURN_ID,"blockingAgents":["goal-reminder"]}))).unwrap();
        assert!(!step.done, "blocking reminders still run");
        let step = p.receive(frame("turn/completed", json!({"turnId":TURN_ID,"terminal":"completed","durationMs":10826}))).unwrap();
        assert!(step.done);
    }

    #[test]
    fn resume_applies_mode_and_model_before_the_turn() {
        let (_, writes) = started("plan", "muse-wonder-1.0", true);
        let methods: Vec<_> = writes.iter().filter_map(|w| w["method"].as_str()).collect();
        assert_eq!(methods, ["initialize", "initialized", "session/resume", "session/setApprovalMode", "session/setModel", "turn/start"]);
        assert_eq!(writes[2]["params"]["sessionId"], SESSION_ID);
        assert_eq!(writes[3]["params"]["mode"], "denyUnmatched");
        assert_eq!(writes[4]["params"]["model"]["modelId"], "muse-wonder-1.0");
        // Plan mode also tells the model to stay read-only.
        assert!(writes[5]["params"]["input"][0]["text"].as_str().unwrap().starts_with(acp::GROK_PLAN_PREFIX));
    }

    #[test]
    fn missing_login_fails_with_the_muse_login_hint() {
        let (mut p, _) = started("ask", "default", false);
        let error = p.receive(frame("turn/completed", json!({"turnId":TURN_ID,"terminal":"failed","reason":"not logged in: run /login to add an API key","error":{"kind":"authRequired","message":"not logged in: run /login to add an API key","retryable":false}}))).err().unwrap();
        assert_eq!(error, SIGN_IN);
        let (mut p, _) = started("ask", "default", false);
        let step = p.receive(frame("turn/completed", json!({"turnId":TURN_ID,"terminal":"failed","error":{"kind":"modelError","message":"quota","retryable":false,"quota":{"limitKind":"tierLimit","resetsAtMs":1792739112000_i64}}}))).unwrap();
        assert_eq!(step.events[0].kind, "limited");
        assert_eq!(step.failure.as_deref(), Some("quota"));
    }

    #[test]
    fn tool_calls_show_arguments_output_and_write_provenance() {
        let (mut p, _) = started("ask", "default", false);
        let item = json!({"itemId":"t1","kind":"toolCall","turnId":TURN_ID,"revision":1,"status":"inProgress","tool":"bash","callId":"call_1","args":"{\"command\":\"touch a.txt\",\"description\":\"Create empty file a.txt\"}"});
        let step = p.receive(frame("item/started", json!({"item":item}))).unwrap();
        let tool = step.events[0].tool.as_ref().unwrap();
        assert_eq!((tool.name.as_str(), tool.status.as_str()), ("bash", "running"));
        assert!(tool.input.contains("touch a.txt"));
        assert_eq!(tool.write_paths, Some(vec![]));
        let mut done = item.clone();
        done["status"] = json!("completed");
        done["visibleOutput"] = json!("{\"exit_code\": 0}");
        let step = p.receive(frame("item/completed", json!({"item":done}))).unwrap();
        let tool = step.events[0].tool.as_ref().unwrap();
        assert_eq!(tool.status, "completed");
        assert!(tool.output.contains("exit_code"));
        assert_eq!(write_paths("write_file", &json!({"path":"src/a.rs"})), Some(vec!["src/a.rs".into()]));
        assert_eq!(write_paths("apply_patch", &json!({"input":"*** Begin Patch\n*** Update File: b.rs\n*** End Patch"})), Some(vec!["b.rs".into()]));
        assert_eq!(write_paths("read_file", &json!({"path":"a"})), None);
    }

    /// Recorded `approval/request` for a sandbox escalation.
    fn approval_request() -> Value {
        json!({"jsonrpc":"2.0","id":1,"method":"approval/request","params":{"sessionId":SESSION_ID,"approvalId":"01a16683-f9d7-70e2-b1f4-2fb1747918af","turnId":TURN_ID,"taskId":"01a16683-f9d7-70e2-b1f4-2fb1747918af","itemId":"01a16683-f9d7-70e2-b1f4-2fb1747918af","toolCallId":"call_1","toolName":"bash","rawArgs":"{\"command\":\"git config --global user.musetest yes\",\"sandbox_permissions\":\"require_escalated\"}","viewCursor":"v4:x:30","subject":{"kind":"shell","command":"git config --global user.musetest yes","workspaceRoot":"/private/tmp/ws","stages":[]},"currentRequirementId":{"approvalId":"01a16683-f9d7-70e2-b1f4-2fb1747918af","sourceIndex":0},"availableChoices":[{"choiceId":"allow_once","label":"Allow once","decision":"approved","scope":"once"},{"choiceId":"abort","label":"Reject","decision":"abort","scope":"once","acceptsFeedback":true}],"protectedWrite":false,"judgeEscalated":false}})
    }

    #[test]
    fn approvals_are_acknowledged_shown_and_decided_with_an_offered_choice() {
        for approved in [true, false] {
            let (mut p, _) = started("ask", "default", false);
            let step = p.receive(approval_request()).unwrap();
            assert_eq!(step.write[0], json!({"jsonrpc":"2.0","id":1,"result":{}}));
            let event = &step.events[0];
            assert_eq!(event.kind, "approval");
            assert_eq!(event.text, "Run `git config --global user.musetest yes`");
            let step = p.approval_step(event.request_id.as_ref().unwrap(), approved);
            let decide = &step.write[0];
            assert_eq!(decide["method"], "approval/decide");
            assert_eq!(decide["params"]["choiceId"], if approved { "allow_once" } else { "abort" });
            assert_eq!(decide["params"]["requirementId"]["sourceIndex"], 0);
            assert!(is_v7(&decide["params"]["commandId"]));
        }
        // Muse's judge resolving first closes the prompt.
        let (mut p, _) = started("ask", "default", false);
        p.receive(approval_request()).unwrap();
        let step = p.receive(frame("approval/resolved", json!({"approvalId":"01a16683-f9d7-70e2-b1f4-2fb1747918af","decision":"approved","resolvedBy":"llmJudge"}))).unwrap();
        assert_eq!(step.events[0].kind, "approval_cancelled");
        assert!(p.pending.is_empty());
    }

    #[test]
    fn questions_use_the_shared_form_and_answer_with_labels_or_free_text() {
        let (mut p, _) = started("ask", "default", false);
        let request = json!({"jsonrpc":"2.0","id":1,"method":"userInput/request","params":{"sessionId":SESSION_ID,"userInputId":"01a16681-cd7e-76c0-ace5-1e54691d6731","turnId":TURN_ID,"itemId":"i","toolCallId":"call_2","toolName":"request_user_input","viewCursor":"v","questions":[{"id":"color_pref","header":"Color","question":"Do you prefer red or blue?","selection":{"mode":"single"},"options":[{"label":"Red"},{"label":"Blue"}]}]}});
        let step = p.receive(request.clone()).unwrap();
        assert_eq!(step.write[0]["result"], json!({}));
        let event = &step.events[0];
        assert_eq!(event.kind, "input_request");
        assert_eq!(event.data.as_ref().unwrap()["questions"][0]["options"][1]["label"], "Blue");
        let id = event.request_id.clone().unwrap();
        let step = p.muse_user_input(&id, json!({"answers":{"color_pref":["Red"]}})).unwrap();
        let answer = &step.write[0];
        assert_eq!(answer["method"], "userInput/answer");
        assert_eq!(answer["params"]["userInputId"], "01a16681-cd7e-76c0-ace5-1e54691d6731");
        assert_eq!(answer["params"]["answers"], json!([{"questionId":"color_pref","selectedLabel":"Red"}]));

        let step = p.receive(request).unwrap();
        let id = step.events[0].request_id.clone().unwrap();
        let step = p.muse_user_input(&id, json!({"answers":{"color_pref":["Green"]}})).unwrap();
        assert_eq!(step.write[0]["params"]["answers"][0]["freeText"], "Green");
        // Stopping cancels an open question instead of sending a malformed reply.
        let (mut p, _) = started("ask", "default", false);
        let step = p.receive(json!({"jsonrpc":"2.0","id":2,"method":"userInput/request","params":{"sessionId":SESSION_ID,"userInputId":"u2","questions":[{"id":"q","header":"","question":"Which?","selection":{"mode":"single"},"options":[{"label":"A"}]}]}})).unwrap();
        assert_eq!(step.events[0].kind, "input_request");
        let step = p.cancel_requests();
        assert_eq!(step.write[0]["method"], "userInput/cancel");
    }

    fn steer_statuses(step: &Step) -> Vec<(String, String)> {
        step.events.iter().filter(|e| e.kind == "steer").map(|e| {
            let data = e.data.as_ref().unwrap();
            (data["status"].as_str().unwrap().to_owned(), data["mode"].as_str().unwrap().to_owned())
        }).collect()
    }

    fn pair(status: &str, mode: &str) -> (String, String) {
        (status.into(), mode.into())
    }

    #[test]
    fn steers_target_the_turn_and_a_late_steer_keeps_the_run_open() {
        let (mut p, _) = started("ask", "default", false);
        let (tx, mut reply) = tokio::sync::oneshot::channel();
        let step = p.steer("s1".into(), "Actually keep it to 4 lines.".into(), tx);
        let steer = &step.write[0];
        assert_eq!(steer["method"], "turn/steer");
        assert_eq!(steer["params"]["expectedTurnId"], TURN_ID);
        let command = steer["params"]["commandId"].as_str().unwrap().to_owned();
        let step = p.receive(json!({"jsonrpc":"2.0","id":steer["id"],"result":{"commandId":command,"status":"accepted","turnId":TURN_ID}})).unwrap();
        assert_eq!(steer_statuses(&step), [pair("pending", "live")]);
        assert_eq!(reply.try_recv().unwrap().unwrap(), json!({"steered":true,"id":"s1","mode":"live"}));
        // Recorded: the turn ended before taking the steer, which then ran as its own turn.
        let step = p.receive(frame("turn/completed", json!({"turnId":TURN_ID,"terminal":"completed"}))).unwrap();
        assert!(!step.done);
        let step = p.receive(frame("turn/started", json!({"turnId":command,"commandId":command}))).unwrap();
        assert_eq!(steer_statuses(&step), [pair("delivered", "live")]);
        let step = p.receive(frame("turn/completed", json!({"turnId":command,"terminal":"completed"}))).unwrap();
        assert!(step.done);
        assert_eq!(p.cancel()["params"]["turnId"], json!(command));
        assert_eq!(p.cancel()["method"], "turn/interrupt");
    }

    #[test]
    fn steers_without_a_running_turn_become_the_next_turn_of_the_session() {
        // Before the opening turn has an id: held, not refused.
        let mut cfg = super::super::tests::config("muse");
        cfg.reasoning_effort = Some("low".into());
        let mut p = Protocol::new(cfg);
        p.receive(initialized()).unwrap();
        p.receive(session_result()).unwrap();
        let (tx, mut early) = tokio::sync::oneshot::channel();
        let step = p.steer("s1".into(), "first steer".into(), tx);
        assert!(step.write.is_empty());
        assert_eq!(steer_statuses(&step), [pair("pending", "next-turn")]);
        assert_eq!(early.try_recv().unwrap().unwrap()["mode"], "next-turn");
        p.receive(turn_result()).unwrap();
        // A steer that loses the race with the turn's end is refused by Muse, then held too.
        let (tx, mut late) = tokio::sync::oneshot::channel();
        let steer = p.steer("s2".into(), "second steer".into(), tx).write.remove(0);
        let end = p.receive(frame("turn/completed", json!({"turnId":TURN_ID,"terminal":"completed"}))).unwrap();
        assert!(!end.done, "the run waits for the steer's answer");
        let next = p.receive(json!({"jsonrpc":"2.0","id":steer["id"],"error":{"code":-32030,"message":"expected turn is not running","data":{"kind":"commandRejected"}}})).unwrap();
        assert_eq!(late.try_recv().unwrap().unwrap()["mode"], "next-turn");
        assert!(!next.done, "the run continues with the steered turn");
        let turn = next.write.iter().find(|frame| frame["method"] == "turn/start").expect("next turn");
        assert_eq!(turn["params"]["sessionId"], SESSION_ID);
        assert_eq!(turn["params"]["input"], json!([{"type":"text","text":"first steer\n\nsecond steer"}]));
        assert_eq!(turn["params"]["reasoningEffort"], "low");
        assert_eq!(steer_statuses(&next), [pair("pending", "next-turn"), pair("delivered", "next-turn"), pair("delivered", "next-turn")]);
        let next_turn = "01a166b0-0000-7000-8000-000000000001";
        p.receive(json!({"jsonrpc":"2.0","id":6,"result":{"commandId":next_turn,"status":"accepted","turnId":next_turn,"startedNewTurn":true,"disposition":"started"}})).unwrap();
        assert!(p.receive(frame("turn/completed", json!({"turnId":next_turn,"terminal":"completed"}))).unwrap().done);
    }

    #[test]
    fn a_failed_run_reports_steers_it_never_delivered() {
        let (mut p, _) = started("ask", "default", false);
        let (tx, _reply) = tokio::sync::oneshot::channel();
        let steer = p.steer("s1".into(), "never taken".into(), tx).write.remove(0);
        let command = steer["params"]["commandId"].as_str().unwrap().to_owned();
        p.receive(json!({"jsonrpc":"2.0","id":steer["id"],"result":{"commandId":command,"status":"accepted","turnId":TURN_ID}})).unwrap();
        assert!(p.receive(frame("turn/completed", json!({"turnId":TURN_ID,"terminal":"cancelled"}))).is_err());
        let events = p.steers_ended(false);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].data.as_ref().unwrap()["status"], "failed");
    }

    #[test]
    fn a_leading_slash_runs_a_listed_skill_as_a_skill_part() {
        let mut cfg = super::super::tests::config("muse");
        cfg.prompt = "/review focus on tests".into();
        let mut p = Protocol::new(cfg);
        p.receive(initialized()).unwrap();
        let step = p.receive(session_result()).unwrap();
        assert_eq!(step.write[0]["method"], "skill/list");
        let step = p.receive(json!({"jsonrpc":"2.0","id":5,"result":{"skills":[{"selector":"review","displayName":"review","description":"Review","source":"user"}]}})).unwrap();
        assert_eq!(step.write[0]["params"]["input"], json!([{"type":"skill","selector":"review","arguments":"focus on tests"}]));
        let mut cfg = super::super::tests::config("muse");
        cfg.prompt = "/unknown thing".into();
        let mut p = Protocol::new(cfg);
        p.receive(initialized()).unwrap();
        p.receive(session_result()).unwrap();
        let step = p.receive(json!({"jsonrpc":"2.0","id":5,"result":{"skills":[]}})).unwrap();
        assert_eq!(step.write[0]["params"]["input"][0]["text"], "/unknown thing");
    }

    #[test]
    fn catalog_lists_models_with_their_reasoning_tiers() {
        let models = parse_models(&json!({"providerId":"meta","profileId":"tbh","source":"providerCatalog","models":[
            {"modelId":"muse-wonder-1.0","displayLabel":"muse-wonder-1.0","providerId":"meta","releaseDate":"2026-10-12","description":null,"contextLimit":1007997,"outputLimit":128000,"cost":null,"isActive":false,"isDefault":true,"variants":["minimal","low","medium","high","xhigh","max"],"reasoningEffortVariants":[],"defaultReasoningEffort":"high"},
            {"modelId":"muse-spark-1.2","displayLabel":"muse-spark-1.2","description":null,"contextLimit":1007997,"isDefault":false,"variants":["minimal","low","medium","high","xhigh"],"defaultReasoningEffort":"high"}
        ]})).unwrap();
        assert_eq!(models[0].id, "default");
        assert_eq!(models[1].id, "muse-wonder-1.0");
        assert_eq!(models[1].reasoning_efforts.len(), 6);
        assert_eq!(models[1].default_reasoning_effort.as_deref(), Some("high"));
        assert_eq!(models[1].context_window, Some(1007997));
        assert_eq!(models[2].reasoning_efforts.last().unwrap().id, "xhigh");
        assert!(parse_models(&json!({"models":[{"modelId":""}]})).is_err());
    }

    #[test]
    fn frames_for_other_sessions_and_unknown_requests_are_ignored_or_refused() {
        let (mut p, _) = started("ask", "default", false);
        let step = p.receive(json!({"jsonrpc":"2.0","method":"item/delta","params":{"sessionId":"child","itemId":"x","field":"text","delta":"no"}})).unwrap();
        assert!(step.events.is_empty());
        let step = p.receive(json!({"jsonrpc":"2.0","id":9,"method":"computerUse/whatever","params":{}})).unwrap();
        assert_eq!(step.write[0]["error"]["code"], -32601);
    }

    #[test]
    fn resume_reattaches_pandacode_tools_as_session_mcp() {
        let mut cfg = super::super::tests::config("muse");
        cfg.resume_id = Some(SESSION_ID.into());
        let mut p = Protocol::new(cfg);
        p.mcp_server = Some(json!({"type":"http","name":"pandacode_architect","url":"http://127.0.0.1:9/mcp","headers":[{"name":"Authorization","value":"Bearer fresh"}]}));
        let writes = p.receive(initialized()).unwrap().write;
        assert_eq!(writes[1]["method"], "session/resume");
        let server = &writes[1]["params"]["config"]["mcpServers"]["pandacode_architect"];
        assert_eq!(server["url"], "http://127.0.0.1:9/mcp");
        assert_eq!(server["headers"]["Authorization"], "Bearer fresh");
    }

    /// Recorded `userInput/request` with a multi-select question (Muse 1.4.12).
    fn multi_select_request() -> Value {
        json!({"jsonrpc":"2.0","id":1,"method":"userInput/request","params":{"sessionId":SESSION_ID,"userInputId":"01a166a3-7c4a-7a20-963b-428d600daa92","turnId":TURN_ID,"itemId":"01a166a3-7c4a-7a20-963b-428d600daa92","toolCallId":"call_01a166a3772775eea5640b1ef0ec4ef4","toolName":"request_user_input","viewCursor":"v4:x:9","questions":[{"id":"which-fruits","header":"Fruits","question":"Which fruits?","selection":{"mode":"multiple","minSelections":1,"maxSelections":3},"options":[{"label":"Apple"},{"label":"Banana"},{"label":"Cherry"}]}]}})
    }

    #[test]
    fn multi_select_questions_keep_their_mode_and_answer_with_every_label() {
        let (mut p, _) = started("ask", "default", false);
        let step = p.receive(multi_select_request()).unwrap();
        let event = &step.events[0];
        let question = &event.data.as_ref().unwrap()["questions"][0];
        assert_eq!(question["multiSelect"], true);
        assert_eq!(question["maxSelections"], 3);
        let id = event.request_id.clone().unwrap();
        // An empty selection is refused before anything is sent.
        assert!(p.muse_user_input(&id, json!({"answers":{"which-fruits":[]}})).is_err());
        let step = p.muse_user_input(&id, json!({"answers":{"which-fruits":["Apple","Cherry","Kiwi"]}})).unwrap();
        // The answer Muse accepted in the recording, plus the typed one as free text.
        assert_eq!(step.write[0]["method"], "userInput/answer");
        assert_eq!(step.write[0]["params"]["answers"], json!([{"questionId":"which-fruits","selectedLabels":["Apple","Cherry"],"freeText":"Kiwi"}]));
        // A single-answer question still takes exactly one.
        let (mut p, _) = started("ask", "default", false);
        let mut single = multi_select_request();
        single["params"]["questions"][0]["selection"] = json!({"mode":"single"});
        let id = p.receive(single).unwrap().events[0].request_id.clone().unwrap();
        assert!(p.muse_user_input(&id, json!({"answers":{"which-fruits":["Apple","Banana"]}})).is_err());
        let step = p.muse_user_input(&id, json!({"answers":{"which-fruits":["Banana"]}})).unwrap();
        assert_eq!(step.write[0]["params"]["answers"], json!([{"questionId":"which-fruits","selectedLabel":"Banana"}]));
    }

    #[test]
    fn decisions_use_only_offered_choices_and_keep_the_prompt_otherwise() {
        // Recorded choices without a one-time approval: only session and lasting rules.
        let mut request = approval_request();
        request["params"]["availableChoices"] = json!([
            {"choiceId":"allow_session","label":"Allow for this session","decision":"approvedForSession","scope":"session"},
            {"choiceId":"allow_local_prefix","label":"Always allow in this workspace: git config ...","decision":"approvedPolicyAmendment","scope":"localPersistent"}
        ]);
        let (mut p, _) = started("ask", "default", false);
        let id = p.receive(request.clone()).unwrap().events[0].request_id.clone().unwrap();
        let step = p.approval_step(&id, true);
        assert_eq!(step.write[0]["params"]["choiceId"], "allow_session");
        // No reject choice is offered: nothing is sent and the prompt stays.
        let (mut p, _) = started("ask", "default", false);
        let id = p.receive(request).unwrap().events[0].request_id.clone().unwrap();
        assert!(p.approval_step(&id, false).write.is_empty());
        assert!(p.pending.contains_key(&id));
        // A lasting rule is never chosen for a one-time approval.
        let mut only_rule = approval_request();
        only_rule["params"]["availableChoices"] = json!([{"choiceId":"allow_local_prefix","label":"Always allow","decision":"approvedPolicyAmendment","scope":"localPersistent"}]);
        let (mut p, _) = started("ask", "default", false);
        let id = p.receive(only_rule).unwrap().events[0].request_id.clone().unwrap();
        assert!(p.approval_step(&id, true).write.is_empty());
        assert!(p.pending.contains_key(&id));
    }

    #[test]
    fn a_steer_echoed_before_its_acknowledgement_still_lets_the_run_end() {
        let (mut p, _) = started("ask", "default", false);
        let (tx, mut reply) = tokio::sync::oneshot::channel();
        let steer = p.steer("s1".into(), "Also mention the word STEERED.".into(), tx).write.remove(0);
        let command = steer["params"]["commandId"].as_str().unwrap().to_owned();
        // Recorded echo of an absorbed steer, delivered before the acknowledgement.
        let echo = p.receive(frame("item/completed", json!({"item":{"itemId":"e88a9af9-9827-509f-b0cf-4a8765561621","kind":"userMessage","turnId":TURN_ID,"revision":1,"status":"completed","text":"Also mention the word STEERED.","commandId":command,"steered":true}}))).unwrap();
        assert!(steer_statuses(&echo).is_empty(), "not reported before it is accepted");
        let ack = p.receive(json!({"jsonrpc":"2.0","id":steer["id"],"result":{"commandId":command,"status":"accepted","turnId":TURN_ID}})).unwrap();
        assert_eq!(steer_statuses(&ack), [pair("pending", "live"), pair("delivered", "live")]);
        assert!(!ack.done);
        assert_eq!(reply.try_recv().unwrap().unwrap()["mode"], "live");
        assert!(p.receive(frame("turn/completed", json!({"turnId":TURN_ID,"terminal":"completed","durationMs":21947}))).unwrap().done);

        // The turn may also complete before an absorbed steer is acknowledged.
        let (mut p, _) = started("ask", "default", false);
        let (tx, _reply) = tokio::sync::oneshot::channel();
        let steer = p.steer("s1".into(), "Also mention the word STEERED.".into(), tx).write.remove(0);
        let command = steer["params"]["commandId"].as_str().unwrap().to_owned();
        p.receive(frame("item/completed", json!({"item":{"itemId":"e","kind":"userMessage","turnId":TURN_ID,"revision":1,"status":"completed","text":"x","commandId":command,"steered":true}}))).unwrap();
        assert!(!p.receive(frame("turn/completed", json!({"turnId":TURN_ID,"terminal":"completed"}))).unwrap().done);
        assert!(p.receive(json!({"jsonrpc":"2.0","id":steer["id"],"result":{"commandId":command,"status":"accepted","turnId":TURN_ID}})).unwrap().done);
    }

    #[tokio::test]
    #[ignore = "requires an installed Muse Code CLI"]
    async fn installed_muse_catalog() {
        let path = executable("muse").expect("muse is installed");
        let models = models(&path).await.unwrap();
        assert!(models.len() > 1, "{models:?}");
    }
}
