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

/// The catalog is session metadata only: never send a prompt during discovery.
pub(super) async fn models(path: &Path) -> Result<Vec<ModelInfo>, String> {
    if let Some(models) = acp_catalog::get("zcode", path) {
        return Ok(models);
    }
    let _refresh = acp_catalog::refresh_lock("zcode", path).await;
    if let Some(models) = acp_catalog::get("zcode", path) {
        return Ok(models);
    }
    let models = discover(path).await?;
    acp_catalog::store_models(None, models.clone());
    Ok(models)
}

fn parse_models(snapshot: &Value) -> Result<Vec<ModelInfo>, String> {
    let entries = snapshot["settings"]["model"]["available"]
        .as_array()
        .filter(|v| v.len() <= MODEL_CATALOG_LIMIT)
        .ok_or("Invalid ZCode model catalog")?;
    let mut models = vec![ModelInfo::default_choice()];
    let mut seen = HashSet::new();
    for entry in entries {
        let label = field(entry, "label").to_owned();
        if !valid_model_id(&label) || !seen.insert(label.clone()) {
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
        models.push(ModelInfo {
            name: model_text(entry["label"].as_str(), &label, 160),
            description: model_text(entry["providerLabel"].as_str(), "", 200),
            id: label,
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
    let mut command = super::command(path)?;
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
    let mut child = command
        .spawn()
        .map_err(|e| format!("Could not start ZCode: {e}"))?;
    let group = ProcessGroup::register(child.id());
    let result = tokio::time::timeout(Duration::from_secs(20), async {
        let mut stdin = child.stdin.take().ok_or("ZCode stdin unavailable")?;
        write_json(
            &mut stdin,
            &json!({"id": ID_CREATE, "method": "session/create", "params": {
                "workspace": workspace_of(&workspace),
                "persistence": "deferred",
                "mode": "plan",
                "titleGenerationEnabled": false,
            }}),
        )
        .await?;
        let mut stdout = tokio::io::BufReader::new(
            child.stdout.take().ok_or("ZCode stdout unavailable")?,
        )
        .take(DISCOVERY_OUTPUT_LIMIT + 1);
        let mut total = 0u64;
        loop {
            let mut line = Vec::new();
            let count = stdout
                .read_until(b'\n', &mut line)
                .await
                .map_err(|e| e.to_string())?;
            total += count as u64;
            if total > DISCOVERY_OUTPUT_LIMIT {
                return Err("ZCode model catalog exceeded its output limit".into());
            }
            if count == 0 {
                return Err("ZCode exited before returning models".into());
            }
            let value: Value =
                serde_json::from_slice(&line).map_err(|_| "Invalid ZCode discovery JSON")?;
            if value.get("method").is_some() && value.get("id").is_some() {
                // The server blocks on client requests (runtime preferences);
                // declining them like the run path does unblocks the create.
                write_json(
                    &mut stdin,
                    &json!({"id": value["id"], "error": {"code": -32601, "message": "Method not found"}}),
                )
                .await?;
                continue;
            }
            if value["id"] != ID_CREATE {
                continue;
            }
            if let Some(error) = value.get("error") {
                return Err(short(field(error, "message")));
            }
            let _ = write_json(
                &mut stdin,
                &json!({"id": 2, "method": "session/close", "params": {
                    "sessionId": value["result"]["session"]["sessionId"],
                }}),
            )
            .await;
            return parse_models(&value["result"]);
        }
    })
    .await
    .unwrap_or_else(|_| Err("ZCode model discovery timed out".into()));
    drop(group);
    let _ = child.start_kill();
    let _ = tokio::time::timeout(Duration::from_secs(1), child.wait()).await;
    result
}

impl Protocol {
    /// Opens the run's session. Deferred persistence keeps captures and failed
    /// starts out of the user's ZCode history; resume attaches by saved id.
    pub(super) fn zcode_initial(&self) -> Value {
        let workspace = workspace_of(&self.config.cwd);
        match &self.config.resume_id {
            Some(id) => json!({"id": ID_CREATE, "method": "session/resume",
                "params": {"sessionId": id, "workspace": workspace}}),
            None => json!({"id": ID_CREATE, "method": "session/create", "params": {
                "workspace": workspace,
                "mode": mode(&self.config.mode),
                "persistence": "deferred",
                "titleGenerationEnabled": false,
            }}),
        }
    }

    pub(super) fn zcode(&mut self, value: Value) -> Result<Step, String> {
        let mut step = Step::default();
        if value.get("method").is_some() {
            self.zcode_frame(value, &mut step)?;
            return Ok(step);
        }
        if let Some(error) = value.get("error") {
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
                let applied = self.zcode.requested_mode.is_some_and(|wanted| {
                    value["result"]["settings"]["mode"]["current"] == wanted
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
            Some(ID_SUBSCRIBE) => self.zcode_prompt(self.config.prompt.clone(), &mut step),
            _ => {}
        }
        Ok(step)
    }

    /// Notifications and the server's reverse requests. Unknown reverse requests
    /// get `-32601`, which recorded servers answer and carry on from.
    fn zcode_frame(&mut self, value: Value, step: &mut Step) -> Result<(), String> {
        match (field(&value, "method"), value.get("id").is_some()) {
            ("interaction/requestPermission", true) if self.config.mode == "full" => {
                // yolo should not ask; a policy request that still arrives takes
                // the offered one-time allow, never a standing grant.
                step.write.push(permission_decision(&value, true));
            }
            ("interaction/requestPermission", true) => {
                let params = &value["params"];
                let text = format!(
                    "{}\n{}\n{}",
                    field(params, "toolName"),
                    field(params, "reason"),
                    preview_json(&params["input"], TOOL_INPUT_LIMIT),
                );
                self.approval(value, text, step)?;
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
            "turn.failed" => {
                self.zcode.error = Some(short(field(payload, "error")));
            }
            "turn.completed" => {
                // A late completed frame from an earlier input never ends this run.
                let input = field(payload, "inputId");
                if !input.is_empty() && input != format!("pandacode-{}", self.zcode.next_input) {
                    return Ok(());
                }
                let usage = &payload["usage"];
                let used = usage["inputTokens"]
                    .as_u64()
                    .unwrap_or(0)
                    .saturating_add(usage["cacheReadTokens"].as_u64().unwrap_or(0));
                let used = if used > 0 {
                    used
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
        if settings["mode"]["current"].as_str() != Some(wanted) {
            self.zcode.requested_mode = Some(wanted);
            step.write.push(json!({
                "id": ID_MODE, "method": "session/setMode",
                "params": {"sessionId": self.remote_id, "mode": wanted},
            }));
        }
        let catalog = &settings["model"]["available"];
        let wanted = &self.config.model;
        if !wanted.is_empty() && wanted != "default" {
            let entry = catalog
                .as_array()
                .into_iter()
                .flatten()
                .find(|entry| field(entry, "label") == *wanted);
            let reference = match entry {
                Some(entry) => entry["ref"].clone(),
                // A custom model id rides the session's current provider.
                None => json!({"providerId": current["providerId"], "modelId": wanted}),
            };
            self.zcode.requested_model = Some((
                string(&reference, "providerId"),
                string(&reference, "modelId"),
            ));
            step.write.push(json!({
                "id": ID_MODEL, "method": "session/setModel",
                "params": {"sessionId": self.remote_id, "model": reference},
            }));
        }
        if let Some(effort) = &self.config.reasoning_effort {
            self.zcode.requested_thought = Some(effort.clone());
            step.write.push(json!({
                "id": ID_THOUGHT, "method": "session/setThoughtLevel",
                "params": {"sessionId": self.remote_id, "thoughtLevel": effort},
            }));
        }
        step.write.push(json!({
            "id": ID_SUBSCRIBE, "method": "session/subscribe",
            "params": {"sessionId": self.remote_id, "deliveryKind": "desktop-continuous"},
        }));
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
        assert_eq!(usage.data.as_ref().unwrap()["usedTokens"], 49067);

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
        let mut config = super::super::tests::config("zcode");
        config.cwd = PathBuf::from("/tmp");
        config.resume_id = Some("sess_saved".into());
        config.mode = "plan".into();
        let mut p = Protocol::new(config);
        assert_eq!(p.initial()["method"], "session/resume");
        let step = p.receive(json!({"id": ID_CREATE, "result": snapshot()})).unwrap();
        // The saved session ran as build; Plan re-applies before subscribing.
        let set_mode = step.write.iter()
            .find(|frame| frame["method"] == "session/setMode")
            .expect("setMode on resume");
        assert_eq!(set_mode["params"]["mode"], "plan");
        assert!(p.receive(json!({"id": ID_MODE, "result": snapshot()})).is_err(), "mode not applied yet");
        let mut applied = snapshot();
        applied["settings"]["mode"]["current"] = json!("plan");
        let step = p.receive(json!({"id": ID_MODE, "result": applied})).unwrap();
        assert!(step.write.iter().all(|frame| frame["method"] != "session/setMode"));
        // A create whose snapshot already matches sends no setMode.
        let (mut p, _) = created();
        subscribe_acked(&mut p);
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

    #[tokio::test]
    #[ignore = "needs the ZCode CLI; metadata only, never sends a prompt"]
    async fn installed_zcode_lists_models() {
        let path = executable("zcode").expect("Install ZCode first");
        let models = models(&path).await.unwrap();
        assert!(models.len() > 1, "{models:?}");
    }
}
