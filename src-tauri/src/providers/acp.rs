//! ACP v1 transport for OpenCode, Kilo, Antigravity, Grok Build, Command Code, Cline and
//! GitHub Copilot CLI. Kimi retains its provider-specific mode mapping.
use super::*;
use crate::slash_commands::claude::Pipe;

const DISCOVERY_STARTUP: Duration = Duration::from_secs(60);
const COMMAND_GRACE: Duration = Duration::from_secs(1);
pub(crate) const ACP_STARTUP_TIMEOUT: &str = "ACP startup timed out after 60 seconds. Check the harness installation and sign-in, then refresh.";

fn rpc_error(frame: &Value, stage: &str) -> String {
    let message = model_text(frame["error"]["message"].as_str(), "ACP request failed", 1000);
    let data = &frame["error"]["data"];
    let detail = data.as_str().or_else(|| data["message"].as_str()).or_else(|| data["details"].as_str()).unwrap_or("");
    super::diagnostics::failure(&format!("ACP {stage}: {message}"), detail)
}

fn transport_error(pipe: &Pipe, stage: &str) -> String {
    if pipe.timed_out() {
        ACP_STARTUP_TIMEOUT.into()
    } else {
        format!("ACP {stage} ended before a valid response. Check the harness installation and sign-in, then refresh.")
    }
}

/// Shown when Grok Build has no usable cached credentials.
pub(super) const GROK_SIGN_IN: &str =
    "Grok Build is not signed in. Run `grok login` in a terminal, then send again.";
/// Grok Build has no read-only session mode over ACP; plan mode is enforced by
/// declining state-changing permission requests and telling the model up front.
pub(super) const GROK_PLAN_PREFIX: &str = "Plan mode is on for this session: work read-only. Investigate with read-only tools, then reply with a concrete, step-by-step plan. Do not edit files or run commands that change state; requests to do so will be declined.";

/// DeepSeek Harness serves ACP from its `acp` profile.
pub(super) const DEEPSEEK_ARGS: [&str; 2] = ["--profile", "acp"];
/// dsh reports every tool as kind "other"; these are its file-editing tools.
const DEEPSEEK_EDIT_TOOLS: [&str; 3] = ["edit", "write", "str_replace_editor"];

pub(super) fn configure(command: &mut Command, config: &RunConfig) {
    match config.provider.as_str() {
        "deepseek" => {
            command.args(DEEPSEEK_ARGS);
            // Overrides any inherited value so PandaCode's mode picks the sandbox.
            command.env(super::deepseek::PERMISSION_ENV, super::deepseek::sandbox(&config.mode));
        }
        "commandcode" => {
            // Modes are Command Code's own session modes; the saved key is set by the run.
            command.args(super::commandcode::ACP_ARGS);
        }
        "opencode" => {
            command.arg("acp");
            command.env("OPENCODE_CONFIG_CONTENT", configuration(&config.mode));
        }
        "grok" => {
            // Global flags precede `agent`; agent flags precede the `stdio` transport.
            // The permission mode overrides the user's config.toml so PandaCode's
            // approval choice, not the TUI's saved yolo setting, decides prompts.
            command.args(["--no-auto-update", "--permission-mode", grok_permission_mode(&config.mode), "agent"]);
            if config.mode == "full" {
                command.arg("--always-approve");
            }
            if !config.model.is_empty() && config.model != "default" {
                command.args(["--model", &config.model]);
            }
            if let Some(effort) = &config.reasoning_effort {
                command.args(["--reasoning-effort", effort]);
            }
            command.arg("stdio");
        }
        "github-copilot" => {
            command.args(["--no-auto-update", "--acp", "--stdio"]);
        }
        "cline" => super::cline::configure(command, config),
        "kilo" => super::kilo::configure(command),
        _ => {
            #[cfg(target_os = "linux")]
            command.arg("--uid=");
        }
    }
}

pub(crate) fn grok_permission_mode(mode: &str) -> &'static str {
    match mode {
        "full" => "bypassPermissions",
        "auto" => "acceptEdits",
        _ => "default",
    }
}

/// The auth method Grok Build advertises for its cached credentials, if any.
fn cached_auth_method(result: &Value) -> Option<String> {
    let methods = result["authMethods"].as_array()?;
    let advertised = |id: &str| methods.iter().any(|method| method["id"] == id);
    result["_meta"]["defaultAuthMethodId"]
        .as_str()
        .filter(|id| advertised(id))
        .or_else(|| advertised("cached_token").then_some("cached_token"))
        .map(str::to_owned)
}

/// Read-only tools stay automatic in plan mode; anything that changes state is declined.
fn grok_read_only(tool: &Value) -> bool {
    tool["_meta"]["x.ai/tool"]["read_only"] == true
        || matches!(field(tool, "kind"), "read" | "search" | "fetch" | "think")
}

pub(super) fn configuration(mode: &str) -> String {
    let permission = match mode {
        "full" => json!({"*":"allow"}),
        "auto" => json!({"*":"ask","read":"allow","glob":"allow","grep":"allow","edit":"allow"}),
        "plan" => json!({"*":"deny","read":"allow","glob":"allow","grep":"allow","lsp":"allow"}),
        _ => json!({"*":"ask","read":"allow","glob":"allow","grep":"allow"}),
    };
    // Inline settings have the highest documented precedence and are private
    // to this process. Preserve existing inline settings, except permissions
    // which must follow the explicitly selected PandaCode policy.
    let mut inline = std::env::var("OPENCODE_CONFIG_CONTENT")
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    inline["permission"] = permission.clone();
    if !inline["agent"].is_object() {
        inline["agent"] = json!({});
    }
    for mode in ["build", "plan"] {
        if !inline["agent"][mode].is_object() {
            inline["agent"][mode] = json!({});
        }
        inline["agent"][mode]["permission"] = permission.clone();
    }
    inline.to_string()
}

fn options<'a>(config: &'a Value, category: &str) -> Option<&'a Value> {
    let selects = || config["configOptions"].as_array().into_iter().flatten().take(64).filter(|option| option["type"] == "select");
    // An exact ID wins: Cline files its account `provider` option under the model category too.
    selects()
        .find(|option| option["id"] == category)
        .or_else(|| selects().find(|option| option["category"] == category))
}
fn choices(option: &Value) -> Vec<&Value> {
    option["options"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|entry| {
            entry["options"]
                .as_array()
                .map(Vec::as_slice)
                .unwrap_or_else(|| std::slice::from_ref(entry))
        })
        // Match discovery's catalog limit and bound the flattened total, rather
        // than discarding valid choices after the first 1,000 in each group.
        .take(MODEL_CATALOG_LIMIT)
        .collect()
}
fn choice_request(session: &str, id: u64, option: &Value, value: &str) -> Result<Value, String> {
    if !choices(option).iter().any(|entry| entry["value"] == value) {
        return Err("The harness does not advertise the selected setting. Refresh its models or choose the harness default.".into());
    }
    Ok(
        json!({"jsonrpc":"2.0","id":id,"method":"session/set_config_option","params":{"sessionId":session,"configId":option["id"],"value":value}}),
    )
}

impl Protocol {
    pub(super) fn acp(&mut self, value: Value) -> Result<Step, String> {
        let mut step = Step::default();
        let grok = self.config.provider == "grok";
        if self.acp_live_answered(&value, &mut step) {
            return Ok(step);
        }
        if value.get("error").is_some() {
            if self.config.provider == "github-copilot" && value["error"]["code"] == -32000 {
                return Err("GitHub Copilot CLI requires sign-in. Run `copilot login` in a terminal, then retry.".into());
            }
            if grok && (value["id"] == 7 || value["error"]["code"] == -32000) {
                return Err(GROK_SIGN_IN.into());
            }
            if self.config.provider == "commandcode" && value["error"]["code"] == -32000 {
                return Err(super::commandcode::SIGN_IN.into());
            }
            if self.config.provider == "cline" && value["error"]["code"] == -32000 {
                return Err(super::cline::SIGN_IN.into());
            }
            if self.config.provider == "kilo" && value["error"]["code"] == -32000 {
                return Err(super::kilo::SIGN_IN.into());
            }
            if value["error"]["code"] == -32000 {
                return Err(format!("{} requires authentication. Sign in using its own CLI or official extension, then retry.", self.config.provider));
            }
            let stage = match value["id"].as_u64() {
                Some(1) => "initialize",
                Some(2) => "session creation or resume",
                Some(3) => "session/prompt",
                Some(4) => "mode selection",
                Some(5) => "model selection",
                Some(6) => "reasoning selection",
                _ => "request",
            };
            return Err(format!("{}: {}", self.config.provider, rpc_error(&value, stage)));
        }
        if grok {
            self.grok_observe(&value, &mut step);
        }
        if let Some(id) = value["id"]
            .as_u64()
            .filter(|_| value.get("result").is_some())
        {
            let result = &value["result"];
            match id {
                1 => {
                    if self.config.provider == "deepseek" && !self.remote_id.is_empty() {
                        match super::deepseek::saved_session(&self.remote_id, &self.config.mode) {
                            Some(id) => self.remote_id = id,
                            None => {
                                self.remote_id.clear();
                                step.events.push(self.event("status", "Approval mode changed: starting a fresh DeepSeek session", None));
                            }
                        }
                    }
                    if result["protocolVersion"] != 1 {
                        return Err("This harness does not support ACP protocol v1.".into());
                    }
                    let capabilities = &result["agentCapabilities"];
                    if !self.image_blocks.is_empty()
                        && capabilities["promptCapabilities"]["image"] != true
                    {
                        return Err(if grok {
                            "Grok Build does not accept images yet. Remove them and describe what they show.".into()
                        } else {
                            "This harness does not advertise image input. Remove the images or update the harness.".into()
                        });
                    }
                    if self.mcp_server.is_some() && capabilities["mcpCapabilities"]["http"] != true
                    {
                        if self.mcp_required {
                            return Err("This harness does not advertise HTTP MCP support required for PandaCode tools. Update its ACP server.".into());
                        }
                        // Title suggestions are optional metadata. Older ACP
                        // agents can continue normally using the local fallback.
                        self.mcp_server = None;
                    }
                    let mut params = json!({"cwd":launch::external_path(&self.config.cwd),"mcpServers":self.mcp_server.iter().collect::<Vec<_>>()});
                    let method = if self.remote_id.is_empty() {
                        "session/new"
                    } else {
                        params["sessionId"] = json!(self.remote_id);
                        if capabilities["sessionCapabilities"].get("resume").is_some() {
                            "session/resume"
                        } else if capabilities["loadSession"] == true {
                            "session/load"
                        } else {
                            return Err("This ACP server cannot resume saved tasks. Update the server or start a new task.".into());
                        }
                    };
                    let session = json!({"jsonrpc":"2.0","id":2,"method":method,"params":params});
                    if grok {
                        // Grok Build wants an explicit authenticate before any session call,
                        // even with cached credentials. No cached method means no sign-in.
                        let method = cached_auth_method(result).ok_or(GROK_SIGN_IN)?;
                        self.acp_pending_session = Some(session);
                        step.write.push(json!({"jsonrpc":"2.0","id":7,"method":"authenticate","params":{"methodId":method}}));
                    } else {
                        step.write.push(session);
                    }
                }
                7 => {
                    if let Some(session) = self.acp_pending_session.take() {
                        step.write.push(session);
                    }
                }
                2 => {
                    let returned = field(result, "sessionId");
                    if !returned.is_empty() && returned.len() <= 256 {
                        self.remote_id = returned.into();
                    }
                    if self.remote_id.is_empty() {
                        return Err("ACP did not return a session ID".into());
                    }
                    self.acp_config = result.clone();
                    if let Some(bytes) = self.early_kimi_commands.take() {
                        if let Ok(frame) = serde_json::from_slice::<Value>(&bytes) {
                            if frame["params"]["sessionId"] == self.remote_id {
                                self.commands_changed(&frame, &mut step);
                            }
                        }
                    }
                    let saved = if self.config.provider == "deepseek" {
                        super::deepseek::resume_id(&self.remote_id, &self.config.mode)
                    } else {
                        self.remote_id.clone()
                    };
                    step.events.push(self.event("session", saved, None));
                    self.acp_mode(&mut step)?;
                }
                4 => {
                    self.acp_update_config(result);
                    if self.config.provider == "github-copilot" {
                        self.acp_copilot_permissions(&mut step)?;
                    } else {
                        self.acp_model(&mut step)?;
                    }
                }
                8 if self.config.provider == "github-copilot" => {
                    self.acp_update_config(result);
                    self.acp_model(&mut step)?;
                }
                5 => {
                    self.acp_update_config(result);
                    self.acp_effort(&mut step)?;
                }
                6 => self.kimi_prompt(&mut step),
                3 => {
                    if let Some(total) = result["_meta"]["totalTokens"].as_u64().filter(|_| grok) {
                        let window = self.grok_context_window();
                        self.usage(total, window, &mut step);
                    }
                    self.acp_turn_end(result, &mut step);
                }
                _ => {}
            }
            self.acp_startup_status(&mut step);
            return Ok(step);
        }
        if value["method"] == "session/update"
            && value["params"]["sessionId"] == self.remote_id
            && value["params"]["update"]["sessionUpdate"] == "config_option_update"
        {
            self.acp_update_config(&value["params"]["update"]);
        }
        if value["method"] == "session/request_permission" {
            if value["params"]["sessionId"]
                .as_str()
                .is_some_and(|id| id != self.remote_id)
            {
                step.write.push(json!({"jsonrpc":"2.0","id":value["id"],"result":{"outcome":{"outcome":"cancelled"}}}));
                return Ok(step);
            }
            // ACP modes aren't universally approval policies. Keep user prompts
            // intact unless Full access, or Auto edits for an explicit edit call.
            let options = value["params"]["options"].as_array();
            let deepseek = self.config.provider == "deepseek";
            let copilot = self.config.provider == "github-copilot";
            if self.config.provider == "kilo" {
                let tool = &value["params"]["toolCall"];
                if let Some(wanted) = super::kilo::permission(&self.config.mode, field(tool, "kind")) {
                    let selected = options.and_then(|values| values.iter().find(|entry| entry["kind"] == wanted));
                    let outcome = match selected {
                        Some(selected) => json!({"outcome":"selected","optionId":selected["optionId"]}),
                        None => json!({"outcome":"cancelled"}),
                    };
                    if wanted == "reject_once" {
                        let title = model_text(tool["title"].as_str(), "a state-changing action", 200);
                        step.events.push(self.event("status", format!("Plan mode declined: {title}"), None));
                    }
                    step.write.push(json!({"jsonrpc":"2.0","id":value["id"],"result":{"outcome":outcome}}));
                    return Ok(step);
                }
            }
            if deepseek && self.config.mode == "plan" {
                // dsh runs read-only here and asks only to escalate past it.
                if let Some(selected) = options.and_then(|values| values.iter().find(|entry| entry["kind"] == "reject_once")) {
                    let name = self.tools.get(field(&value["params"]["toolCall"], "toolCallId")).map_or("a state-changing action", |tool| tool.name.as_str());
                    step.events.push(self.event("status", format!("Plan mode declined: {}", model_text(Some(name), "a state-changing action", 200)), None));
                    step.write.push(json!({"jsonrpc":"2.0","id":value["id"],"result":{"outcome":{"outcome":"selected","optionId":selected["optionId"]}}}));
                    return Ok(step);
                }
            }
            if grok && self.config.mode == "plan" {
                let tool = &value["params"]["toolCall"];
                let wanted = if grok_read_only(tool) { "allow_once" } else { "reject_once" };
                let choice = options.and_then(|values| values.iter().find(|entry| entry["kind"] == wanted));
                if let Some(selected) = choice {
                    if wanted == "reject_once" {
                        let title = model_text(tool["title"].as_str(), "a state-changing action", 200);
                        step.events.push(self.event("status", format!("Plan mode declined: {title}"), None));
                    }
                    step.write.push(json!({"jsonrpc":"2.0","id":value["id"],"result":{"outcome":{"outcome":"selected","optionId":selected["optionId"]}}}));
                    return Ok(step);
                }
            }
            // Read and search requests keep the ordinary approval path, as in Standard mode.
            if copilot
                && self.config.mode == "plan"
                && !matches!(field(&value["params"]["toolCall"], "kind"), "read" | "search")
            {
                let tool = &value["params"]["toolCall"];
                let kind = field(tool, "kind");
                let read_only = kind == "think";
                let wanted = if read_only {
                    "allow_once"
                } else {
                    "reject_once"
                };
                let choice =
                    options.and_then(|values| values.iter().find(|entry| entry["kind"] == wanted));
                if let Some(selected) = choice {
                    if !read_only {
                        let title =
                            model_text(tool["title"].as_str(), "a state-changing action", 200);
                        step.events.push(self.event(
                            "status",
                            format!("Plan mode declined: {title}"),
                            None,
                        ));
                    }
                    step.write.push(json!({"jsonrpc":"2.0","id":value["id"],"result":{"outcome":{"outcome":"selected","optionId":selected["optionId"]}}}));
                } else {
                    // A Plan task must not turn an unrecognized ACP permission
                    // request into a user-overridable write approval.
                    step.write.push(json!({"jsonrpc":"2.0","id":value["id"],"result":{"outcome":{"outcome":"cancelled"}}}));
                }
                return Ok(step);
            }
            if self.config.provider == "cline" {
                let tool = &value["params"]["toolCall"];
                let wanted = super::cline::permission(&self.config.mode, field(tool, "kind"));
                if let Some(selected) = wanted.and_then(|wanted| options.and_then(|values| values.iter().find(|entry| entry["kind"] == wanted))) {
                    if selected["kind"] == "reject_once" {
                        let title = model_text(tool["title"].as_str(), "a file change", 200);
                        step.events.push(self.event("status", format!("Plan mode declined: {title}"), None));
                    }
                    step.write.push(json!({"jsonrpc":"2.0","id":value["id"],"result":{"outcome":{"outcome":"selected","optionId":selected["optionId"]}}}));
                    return Ok(step);
                }
            }
            let one_allow = options.is_some_and(|values| {
                values
                    .iter()
                    .filter(|entry| entry["kind"] == "allow_once")
                    .count()
                    == 1
            });
            let edit = value["params"]["toolCall"]["kind"] == "edit"
                || (deepseek
                    && self.tools.get(field(&value["params"]["toolCall"], "toolCallId"))
                        .is_some_and(|tool| DEEPSEEK_EDIT_TOOLS.contains(&tool.name.as_str())));
            let auto = self.config.mode == "full" || (self.config.mode == "auto" && edit);
            let structured_question = options.is_some_and(|options| {
                options.iter().any(|option| {
                    field(option, "optionId")
                        .strip_prefix('q')
                        .and_then(|id| id.split_once("_opt_"))
                        .is_some_and(|(number, _)| number.parse::<usize>().is_ok())
                })
            });
            if auto && one_allow && !structured_question {
                let selected = options
                    .unwrap()
                    .iter()
                    .find(|entry| entry["kind"] == "allow_once")
                    .unwrap();
                step.write.push(json!({"jsonrpc":"2.0","id":value["id"],"result":{"outcome":{"outcome":"selected","optionId":selected["optionId"]}}}));
                return Ok(step);
            }
        }
        // ACP's streaming text, tools, usage, cancel, and interactive approvals
        // share the same schema as Kimi, without Kimi's initialization rules.
        // Provider observations gathered above lead the shared step.
        let mut inner = self.kimi(value)?;
        if step.events.is_empty() && step.write.is_empty() {
            return Ok(inner);
        }
        step.events.append(&mut inner.events);
        step.write.append(&mut inner.write);
        step.calls.append(&mut inner.calls);
        step.goal_acknowledgements.append(&mut inner.goal_acknowledgements);
        step.done |= inner.done;
        step.failure = step.failure.or(inner.failure);
        Ok(step)
    }
    fn acp_update_config(&mut self, result: &Value) {
        if result["configOptions"].is_array() {
            self.acp_config["configOptions"] = result["configOptions"].clone();
        }
    }

    fn acp_startup_status(&self, step: &mut Step) {
        let label = step.write.iter().find_map(|request| match field(request, "method") {
            "authenticate" => Some("Checking harness sign-in"),
            "session/new" => Some("Opening session"),
            "session/load" | "session/resume" => Some("Restoring session"),
            "session/set_mode" => Some("Applying task mode"),
            "session/set_model" => Some("Applying model settings"),
            "session/set_config_option" => Some(match request["id"].as_u64() {
                Some(4) => "Applying task mode",
                Some(6) => "Applying reasoning settings",
                _ => "Applying model settings",
            }),
            "session/prompt" => Some("Waiting for response"),
            _ => None,
        });
        if let Some(label) = label { step.events.push(self.event("status", label, None)); }
    }
    /// Grok Build annotates every frame with the context it currently holds and
    /// reports model switches on its own notification channel.
    fn grok_observe(&mut self, value: &Value, step: &mut Step) {
        let params = &value["params"];
        if params["sessionId"] != self.remote_id || self.remote_id.is_empty() {
            return;
        }
        if value["method"] == "session/update" {
            if let Some(total) = value["_meta"]["totalTokens"].as_u64() {
                if total != self.grok_context_used {
                    self.grok_context_used = total;
                    let window = self.grok_context_window();
                    self.usage(total, window, step);
                }
            }
            match field(&params["update"], "sessionUpdate") {
                "agent_thought_chunk" if !self.grok_reasoning => {
                    self.grok_reasoning = true;
                    step.events.push(self.event("status", "Reasoning", None));
                }
                "agent_message_chunk" | "tool_call" => self.grok_reasoning = false,
                _ => {}
            }
        } else if value["method"] == "_x.ai/session_notification"
            && params["update"]["sessionUpdate"] == "model_changed"
        {
            let model = field(&params["update"], "model_id");
            if valid_model_id(model) {
                self.active_model = model.into();
            }
        }
    }
    fn grok_context_window(&self) -> Option<u64> {
        let models = &self.acp_config["models"];
        let current = if self.active_model.is_empty() || self.active_model == "default" {
            field(models, "currentModelId")
        } else {
            self.active_model.as_str()
        };
        models["availableModels"]
            .as_array()?
            .iter()
            .find(|model| model["modelId"] == current)
            .and_then(|model| model["_meta"]["totalContextTokens"].as_u64())
    }
    fn acp_mode(&mut self, step: &mut Step) -> Result<(), String> {
        if matches!(self.config.provider.as_str(), "grok" | "deepseek") {
            // No session modes over ACP; plan mode lives in the permission policy.
            return self.acp_model(step);
        }
        let candidates: &[&str] = if self.config.provider == "commandcode" {
            // Command Code's ACP modes are its permission modes, so each PandaCode
            // choice has exactly one, and a missing one must not widen access.
            &[super::commandcode::mode_id(&self.config.mode)]
        } else if self.config.provider == "kilo" {
            &[super::kilo::mode_id(&self.config.mode)]
        } else if self.config.provider == "cline" {
            // Cline has Plan and Act; approvals ride on permission requests.
            &[if self.config.mode == "plan" { "plan" } else { "act" }]
        } else if self.config.provider == "github-copilot" {
            let suffix = if self.config.mode == "plan" {
                "#plan"
            } else {
                "#agent"
            };
            if let Some(option) = options(&self.acp_config, "mode") {
                let mode_choices = choices(option);
                let found = mode_choices
                    .iter()
                    .find(|entry| field(entry, "value").ends_with(suffix));
                let Some(found) = found else {
                    return Err("GitHub Copilot CLI does not advertise the selected task mode. Update Copilot CLI, then refresh.".into());
                };
                step.write.push(choice_request(
                    &self.remote_id,
                    4,
                    option,
                    field(found, "value"),
                )?);
                return Ok(());
            }
            let Some(mode) = self.acp_config["modes"]["availableModes"]
                .as_array()
                .and_then(|modes| {
                    modes
                        .iter()
                        .find(|mode| field(mode, "id").ends_with(suffix))
                })
            else {
                return Err("GitHub Copilot CLI does not advertise the selected task mode. Update Copilot CLI, then refresh.".into());
            };
            step.write.push(json!({"jsonrpc":"2.0","id":4,"method":"session/set_mode","params":{"sessionId":self.remote_id,"modeId":mode["id"]}}));
            return Ok(());
        } else if self.config.provider == "opencode" {
            if self.config.mode == "plan" {
                &["plan"]
            } else {
                &["build"]
            }
        } else if self.config.mode == "plan" {
            &["plan", "planning"]
        } else {
            &["default", "ask", "code"]
        };
        if let Some(option) = options(&self.acp_config, "mode") {
            let found = candidates
                .iter()
                .find(|id| choices(option).iter().any(|entry| entry["value"] == **id));
            if let Some(id) = found {
                step.write
                    .push(choice_request(&self.remote_id, 4, option, id)?);
                return Ok(());
            }
            if self.config.mode == "plan" || matches!(self.config.provider.as_str(), "opencode" | "kilo" | "commandcode" | "cline") {
                return Err("This harness does not advertise the selected task mode.".into());
            }
        } else if let Some(modes) = self.acp_config["modes"]["availableModes"].as_array() {
            if let Some(mode) = candidates
                .iter()
                .find_map(|id| modes.iter().find(|mode| mode["id"] == *id))
            {
                step.write.push(json!({"jsonrpc":"2.0","id":4,"method":"session/set_mode","params":{"sessionId":self.remote_id,"modeId":mode["id"]}}));
                return Ok(());
            }
            if self.config.mode == "plan" || matches!(self.config.provider.as_str(), "opencode" | "kilo" | "commandcode" | "cline") {
                return Err("This harness does not advertise the selected task mode.".into());
            }
        } else if self.config.mode == "plan" || self.config.provider == "kilo" {
            return Err(if self.config.provider == "kilo" {
                "This harness does not advertise the selected task mode."
            } else {
                "This harness does not advertise a read-only planning mode."
            }.into());
        }
        self.acp_model(step)
    }
    fn acp_copilot_permissions(&mut self, step: &mut Step) -> Result<(), String> {
        let option = options(&self.acp_config, "allow_all")
            .ok_or("GitHub Copilot CLI does not advertise the Allow All setting required for PandaCode permissions. Update Copilot CLI, then retry.")?;
        let wanted = if self.config.mode == "full" {
            "on"
        } else {
            "off"
        };
        step.write
            .push(choice_request(&self.remote_id, 8, option, wanted)?);
        Ok(())
    }
    fn acp_model(&mut self, step: &mut Step) -> Result<(), String> {
        if self.config.model.is_empty() || self.config.model == "default" {
            return self.acp_effort(step);
        }
        if let Some(option) = options(&self.acp_config, "model") {
            step.write.push(choice_request(
                &self.remote_id,
                5,
                option,
                &self.config.model,
            )?);
        } else {
            // Legacy ACP servers expose availableModels + session/set_model.
            if !self.acp_config["models"]["availableModels"]
                .as_array()
                .is_some_and(|models| {
                    models
                        .iter()
                        .any(|model| model["modelId"] == self.config.model)
                })
            {
                if self.config.provider == "grok" {
                    // A resumed Grok session may not re-advertise options; the
                    // launch flags already selected the model.
                    return self.acp_effort(step);
                }
                return Err(
                    "This harness does not advertise the selected model. Refresh the model list."
                        .into(),
                );
            }
            step.write.push(json!({"jsonrpc":"2.0","id":5,"method":"session/set_model","params":{"sessionId":self.remote_id,"modelId":self.config.model}}));
        }
        Ok(())
    }
    fn acp_effort(&mut self, step: &mut Step) -> Result<(), String> {
        if let Some(effort) = &self.config.reasoning_effort {
            let option = options(&self.acp_config, "thought_level").or_else(|| options(&self.acp_config, "effort"));
            match option {
                Some(option) => step
                    .write
                    .push(choice_request(&self.remote_id, 6, option, effort)?),
                // Grok and Cline take the effort as a launch flag.
                None if matches!(self.config.provider.as_str(), "grok" | "cline") => self.kimi_prompt(step),
                None => return Err("This model does not advertise an adjustable reasoning effort. Choose harness settings.".into()),
            }
        } else {
            self.kimi_prompt(step);
        }
        Ok(())
    }
}

/// Grok Build lists its models, context sizes and reasoning efforts in the
/// `initialize` result, so discovery never has to create a session.
pub(super) async fn grok_models(path: &Path) -> Result<Vec<ModelInfo>, String> {
    let mut command = super::command(path)?;
    command.args(["--no-auto-update", "agent", "stdio"]);
    let capabilities = handshake(command, &std::env::temp_dir()).await?;
    let models = parse_grok_models(&capabilities["_meta"]["modelState"]);
    if models.len() > 1 {
        return Ok(models);
    }
    let mut command = super::command(path)?;
    command.args(["--no-auto-update", "agent", "stdio"]);
    let (metadata, _) = inspect_with(command, &std::env::temp_dir(), false, true).await?;
    Ok(parse_models(&metadata))
}

pub(super) fn parse_grok_models(state: &Value) -> Vec<ModelInfo> {
    let mut models = vec![ModelInfo::default_choice()];
    for entry in state["availableModels"].as_array().into_iter().flatten().take(MODEL_CATALOG_LIMIT) {
        let id = field(entry, "modelId");
        if !valid_model_id(id) {
            continue;
        }
        let meta = &entry["_meta"];
        let mut efforts: Vec<ReasoningEffortInfo> = meta["reasoningEfforts"]
            .as_array()
            .into_iter()
            .flatten()
            .take(16)
            .filter_map(|choice| {
                let id = choice["id"].as_str().or_else(|| choice["value"].as_str())?;
                super::validate_reasoning_effort("grok", Some(id)).ok()?;
                Some(ReasoningEffortInfo {
                    id: id.into(),
                    name: model_text(choice["label"].as_str().or_else(|| choice["name"].as_str()), id, 80),
                    description: model_text(choice["description"].as_str(), "", 500),
                })
            })
            .collect();
        // Grok lists efforts strongest first; the slider reads least to most, like the other harnesses.
        let rank = |id: &str| ["low", "medium", "high", "xhigh"].iter().position(|known| *known == id).unwrap_or(usize::MAX);
        efforts.sort_by_key(|effort| rank(&effort.id));
        let default_effort = meta["reasoningEfforts"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|choice| choice["default"] == true)
            .and_then(|choice| choice["id"].as_str().or_else(|| choice["value"].as_str()))
            .or_else(|| meta["reasoningEffort"].as_str())
            .filter(|id| efforts.iter().any(|effort| effort.id == *id))
            .map(str::to_owned);
        models.push(ModelInfo {
            id: id.into(),
            name: model_text(entry["name"].as_str(), id, 160),
            description: model_text(entry["description"].as_str(), "", 500),
            reasoning_efforts: efforts,
            default_reasoning_effort: default_effort,
            context_window: meta["totalContextTokens"].as_u64().filter(|value| *value > 0 && *value <= 1_000_000_000),
        });
    }
    models
}

/// Send `initialize` alone and return its result; the process is then stopped.
pub(crate) async fn handshake(command: Command, cwd: &Path) -> Result<Value, String> {
    let mut pipe = Pipe::spawn(command, cwd, DISCOVERY_STARTUP)
        .map_err(|_| "Could not start ACP metadata discovery")?;
    let result = async {
        pipe.send(&json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{},"clientInfo":{"name":"pandacode","version":"0.1.0"}}})).await.map_err(|_| transport_error(&pipe, "initialize"))?;
        loop {
            let frame = pipe.read().await.map_err(|_| transport_error(&pipe, "initialize"))?;
            if frame.get("method").is_some() && frame.get("id").is_some() {
                pipe.send(&json!({"jsonrpc":"2.0","id":frame["id"],"error":{"code":-32601,"message":"Metadata discovery does not execute requests"}})).await.map_err(|_| transport_error(&pipe, "initialize"))?;
            } else if frame["id"] == 1 {
                if frame.get("error").is_some() { return Err(rpc_error(&frame, "initialize")); }
                if frame["result"]["protocolVersion"] != 1 { return Err("This harness does not support ACP protocol v1.".into()); }
                return Ok(frame["result"].clone());
            }
        }
    }.await;
    pipe.finish().await;
    result.map_err(|error| super::diagnostics::failure(&error, pipe.diagnostic()))
}

pub(super) async fn models(path: &Path) -> Result<Vec<ModelInfo>, String> {
    if let Some(models) = super::acp_catalog::get("antigravity", path) { return Ok(models); }
    let _refresh = super::acp_catalog::refresh_lock("antigravity", path).await;
    if let Some(models) = super::acp_catalog::get("antigravity", path) { return Ok(models); }
    let discovery = super::acp_catalog::begin("antigravity", path);
    #[allow(unused_mut)]
    let mut command = super::command(path)?;
    #[cfg(target_os = "linux")]
    command.arg("--uid=");
    let (metadata, _) = inspect(command, &std::env::temp_dir(), false).await?;
    super::acp_catalog::store(discovery, &metadata);
    Ok(parse_models(&metadata))
}
pub(crate) fn parse_models(metadata: &Value) -> Vec<ModelInfo> {
    let mut models = vec![ModelInfo::default_choice()];
    if let Some(option) = options(metadata, "model") {
        for choice in choices(option) {
            let id = field(choice, "value");
            if !valid_model_id(id) {
                continue;
            }
            models.push(ModelInfo {
                id: id.into(),
                name: model_text(choice["name"].as_str(), id, 160),
                description: model_text(choice["description"].as_str(), "", 500),
                reasoning_efforts: Vec::new(),
                default_reasoning_effort: None,
                context_window: None,
            });
        }
    } else if let Some(available) = metadata["models"]["availableModels"].as_array() {
        for entry in available.iter().take(MODEL_CATALOG_LIMIT) {
            let id = field(entry, "modelId");
            if !valid_model_id(id) {
                continue;
            }
            models.push(ModelInfo {
                id: id.into(),
                name: model_text(entry["name"].as_str(), id, 160),
                description: model_text(entry["description"].as_str(), "", 500),
                reasoning_efforts: Vec::new(),
                default_reasoning_effort: None,
                context_window: None,
            });
        }
    }
    // Reasoning options describe the current model, never claim they apply to all.
    let current = options(metadata, "model")
        .map(|option| field(option, "currentValue"))
        .unwrap_or_else(|| field(&metadata["models"], "currentModelId"));
    if let Some(effort) = options(metadata, "thought_level").or_else(|| options(metadata, "effort"))
    {
        if let Some(model) = models.iter_mut().find(|model| model.id == current) {
            model.reasoning_efforts = choices(effort)
                .into_iter()
                .filter_map(|choice| {
                    let id = field(choice, "value");
                    super::validate_reasoning_effort("antigravity", Some(id)).ok()?;
                    Some(effort_info(id, choice["description"].as_str()))
                })
                .collect();
            model.default_reasoning_effort = effort["currentValue"]
                .as_str()
                .filter(|id| {
                    model
                        .reasoning_efforts
                        .iter()
                        .any(|effort| effort.id == *id)
                })
                .map(str::to_owned);
        }
    }
    models
}

pub(crate) async fn inspect(
    command: Command,
    cwd: &Path,
    wait_commands: bool,
) -> Result<(Value, Option<Value>), String> {
    inspect_with(command, cwd, wait_commands, false).await
}

/// `authenticate` runs between `initialize` and `session/new` when the server
/// advertises cached credentials (Grok Build refuses sessions without it).
pub(crate) async fn inspect_with(
    command: Command,
    cwd: &Path,
    wait_commands: bool,
    authenticate: bool,
) -> Result<(Value, Option<Value>), String> {
    inspect_state(command, cwd, wait_commands, authenticate, DISCOVERY_STARTUP, COMMAND_GRACE)
        .await.map_err(|failure| failure.message)
}

#[derive(Debug)]
struct DiscoveryFailure {
    acp_ready: bool,
    authentication_required: bool,
    message: String,
}

async fn inspect_state(
    command: Command,
    cwd: &Path,
    wait_commands: bool,
    authenticate: bool,
    startup_timeout: Duration,
    command_grace: Duration,
) -> Result<(Value, Option<Value>), DiscoveryFailure> {
    let mut pipe = Pipe::spawn(command, cwd, startup_timeout)
        .map_err(|_| DiscoveryFailure { acp_ready: false, authentication_required: false, message: "Could not start ACP metadata discovery. Check the selected executable.".into() })?;
    let mut acp_ready = false;
    let mut authentication_required = false;
    let mut stage = "initialize";
    let result: Result<(Value, Option<Value>), String> = async {
        pipe.send(&json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{},"clientInfo":{"name":"pandacode","version":"0.1.0"}}})).await.map_err(|_| transport_error(&pipe, stage))?;
        let mut metadata = None;
        let mut commands = None;
        let session = json!({"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":launch::external_path(cwd),"mcpServers":[]}});
        loop {
            let frame = match pipe.read().await {
                Ok(frame) => frame,
                // A command notification is optional. Once session creation
                // succeeded, neither silence nor exit can erase its models.
                Err(()) if metadata.is_some() => return Ok((metadata.unwrap(), commands)),
                Err(()) => return Err(transport_error(&pipe, stage)),
            };
            if frame.get("method").is_some() && frame.get("id").is_some() {
                pipe.send(&json!({"jsonrpc":"2.0","id":frame["id"],"error":{"code":-32601,"message":"Metadata discovery does not execute requests"}})).await.map_err(|_| transport_error(&pipe, stage))?;
            } else if matches!(frame["id"].as_u64(), Some(1 | 2 | 7)) && frame.get("error").is_some() {
                authentication_required = frame["error"]["code"] == -32000 || frame["id"] == 7;
                let error = rpc_error(&frame, stage);
                return Err(if authentication_required {
                    format!("Authentication is required by the ACP server. Sign in using its official extension, then check again.\n{error}")
                } else { error });
            } else if frame["id"] == 1 {
                if frame["result"]["protocolVersion"] != 1 { return Err("This harness does not support ACP protocol v1.".into()); }
                acp_ready = true;
                match cached_auth_method(&frame["result"]).filter(|_| authenticate) {
                    Some(method) => {
                        stage = "authenticate";
                        pipe.send(&json!({"jsonrpc":"2.0","id":7,"method":"authenticate","params":{"methodId":method}})).await.map_err(|_| transport_error(&pipe, stage))?;
                    }
                    None => {
                        stage = "session/new";
                        pipe.send(&session).await.map_err(|_| transport_error(&pipe, stage))?;
                    }
                }
            } else if frame["id"] == 7 {
                stage = "session/new";
                pipe.send(&session).await.map_err(|_| transport_error(&pipe, stage))?;
            } else if frame["id"] == 2 {
                if !frame["result"]["sessionId"].as_str().is_some_and(|id| !id.is_empty() && id.len() <= 256) {
                    return Err("ACP session/new did not return a valid session ID.".into());
                }
                metadata = Some(frame["result"].clone());
                pipe.set_deadline_after(command_grace);
            } else if frame["method"] == "session/update" && frame["params"]["update"]["sessionUpdate"] == "available_commands_update" {
                commands = Some(frame);
            }
            if let Some(metadata) = &metadata {
                if commands.as_ref().is_some_and(|frame| frame["params"]["sessionId"] != metadata["sessionId"]) { commands = None; }
                if !wait_commands || commands.is_some() { return Ok((metadata.clone(),commands)); }
            }
        }
    }.await;
    pipe.finish().await;
    result.map_err(|error| DiscoveryFailure {
        acp_ready,
        authentication_required,
        message: super::diagnostics::failure(&error, pipe.diagnostic()),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionStatus {
    installed: bool,
    acp_ready: bool,
    session_ready: bool,
    state: &'static str,
    message: String,
}

fn connection_status(result: Result<(Value, Option<Value>), DiscoveryFailure>) -> ConnectionStatus {
    match result {
        Ok(_) => ConnectionStatus { installed: true, acp_ready: true, session_ready: true, state: "ready", message: "Antigravity ACP initialized and opened a session. No prompt was sent; model access and quota are checked when you send.".into() },
        Err(failure) => ConnectionStatus { installed: true, acp_ready: failure.acp_ready, session_ready: false,
            state: if failure.authentication_required { "authenticationRequired" } else if failure.acp_ready { "sessionFailed" } else { "startupFailed" },
            message: failure.message },
    }
}

/// Explicit Settings check. Never authenticates, sends a prompt, or accepts an
/// agent request. The official ACP server owns its sign-in; finding its binary
/// alone does not establish that its account can open a session.
#[tauri::command]
pub async fn provider_check_connection(provider: String) -> Result<ConnectionStatus, String> {
    if provider != "antigravity" { return Err("Connection checks are supported for Antigravity ACP.".into()); }
    let Some(path) = super::executable(&provider).filter(|path| path.is_file()) else {
        return Ok(ConnectionStatus { installed: false, acp_ready: false, session_ready: false, state: "missing", message: "Select the installed official Antigravity ACP server executable.".into() });
    };
    let command = match super::command(&path) {
        Ok(command) => command,
        Err(message) => return Ok(connection_status(Err(DiscoveryFailure { acp_ready: false, authentication_required: false, message }))),
    };
    #[allow(unused_mut)]
    let mut command = command;
    #[cfg(target_os = "linux")]
    command.arg("--uid=");
    let discovery = super::acp_catalog::begin("antigravity", &path);
    let result = inspect_state(command, &std::env::temp_dir(), false, false, DISCOVERY_STARTUP, COMMAND_GRACE).await;
    if let Ok((metadata, _)) = &result { super::acp_catalog::store(discovery, metadata); }
    Ok(connection_status(result))
}

const MAX_STEER_BYTES: usize = 128 * 1024;
const MAX_STEERS: usize = 16;
/// Request ids for live steering prompts, clear of startup (1-7), cancel (900) and goals (10000+).
const STEER_IDS: std::ops::Range<u64> = 2000..9000;

/// Steering for ACP runs. OpenCode folds a second `session/prompt` into the running
/// loop at its next step (both requests answer at turn end), so it steers live.
/// Kimi rejects a busy prompt and Grok only queues one natively as a later turn,
/// so for every other agent the text waits here and goes out as the next
/// `session/prompt` on the same session when the current one ends.
#[derive(Default)]
pub(super) struct Steers {
    held: Vec<(String, String)>,
    live: Vec<(u64, String, String)>,
    next: u64,
    /// The opening prompt answered while live steers were still outstanding.
    turn_over: bool,
}

impl Protocol {
    pub(super) fn steer_event(&self, id: &str, text: &str, status: &str, mode: &str) -> AgentEvent {
        // `event()` keeps only generic metadata keys; a steer needs its mode too.
        let mut event = self.event("steer", text, None);
        event.data = Some(json!({"id":id,"status":status,"mode":mode}));
        event
    }

    pub(super) fn acp_steer(&mut self, id: String, text: String, reply: super::goals::RpcReply) -> Step {
        let mut step = Step::default();
        let text = text.trim().to_owned();
        if text.is_empty() || text.len() > MAX_STEER_BYTES {
            let _ = reply.send(Err("Write a steering message under 128 KiB.".into()));
            return step;
        }
        let steers = &mut self.acp_steers;
        if steers.held.len() + steers.live.len() >= MAX_STEERS {
            let _ = reply.send(Err("Too many steering messages are waiting; the message stays queued.".into()));
            return step;
        }
        let live = self.config.provider == "opencode" && self.phase == 1 && !steers.turn_over && !self.remote_id.is_empty();
        let mode = if live { "live" } else { "next-turn" };
        step.events.push(self.steer_event(&id, &text, "pending", mode));
        if live {
            let steers = &mut self.acp_steers;
            let request = STEER_IDS.start + steers.next % (STEER_IDS.end - STEER_IDS.start);
            steers.next += 1;
            step.write.push(json!({"jsonrpc":"2.0","id":request,"method":"session/prompt","params":{"sessionId":self.remote_id,"prompt":[{"type":"text","text":text}]}}));
            step.events.push(self.steer_event(&id, &text, "delivered", mode));
            self.acp_steers.live.push((request, id.clone(), text));
        } else {
            self.acp_steers.held.push((id.clone(), text));
        }
        let _ = reply.send(Ok(json!({"steered":true,"id":id,"mode":mode})));
        step
    }

    /// Steers that will never reach the agent (stop, error, process exit).
    pub(super) fn acp_steers_failed(&mut self) -> Step {
        let mut step = Step::default();
        for (id, text) in std::mem::take(&mut self.acp_steers.held) {
            step.events.push(self.steer_event(&id, &text, "failed", "next-turn"));
        }
        self.acp_steers.live.clear();
        step
    }

    /// The running `session/prompt` answered: send held steers as the next turn, or finish.
    fn acp_turn_end(&mut self, result: &Value, step: &mut Step) {
        if result["stopReason"] == "cancelled" {
            let mut failed = self.acp_steers_failed();
            step.events.append(&mut failed.events);
            step.done = true;
            return;
        }
        if !self.acp_steers.live.is_empty() {
            self.acp_steers.turn_over = true;
            return;
        }
        self.acp_steers.turn_over = false;
        let held = std::mem::take(&mut self.acp_steers.held);
        if held.is_empty() {
            step.done = true;
            return;
        }
        self.config.prompt = held.iter().map(|(_, text)| text.as_str()).collect::<Vec<_>>().join("\n\n");
        self.kimi_prompt(step);
        for (id, text) in held {
            step.events.push(self.steer_event(&id, &text, "delivered", "next-turn"));
        }
    }

    /// Kimi's ACP frames, with its turn end routed through held steers.
    pub(super) fn kimi_steered(&mut self, value: Value) -> Result<Step, String> {
        let result = (value["id"] == 3).then(|| value["result"].clone()).filter(|result| !result.is_null());
        let mut step = self.kimi(value)?;
        if let Some(result) = result.filter(|_| step.done) {
            step.done = false;
            self.acp_turn_end(&result, &mut step);
        }
        Ok(step)
    }

    /// A live steer request answered. Returns false when the id is not one.
    fn acp_live_answered(&mut self, value: &Value, step: &mut Step) -> bool {
        let Some(index) = value["id"].as_u64().and_then(|id| self.acp_steers.live.iter().position(|(request, ..)| *request == id)) else {
            return false;
        };
        let (_, id, text) = self.acp_steers.live.remove(index);
        if value.get("error").is_some() {
            // Refused mid-turn: carry it into the next turn instead of failing the run.
            self.acp_steers.held.push((id, text));
        }
        if self.acp_steers.turn_over && self.acp_steers.live.is_empty() {
            self.acp_turn_end(&value["result"], step);
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::config;
    use super::*;

    #[test]
    fn acp_errors_preserve_structured_cause_without_serializing_opaque_data() {
        let mut p = Protocol::new(config("antigravity"));
        let error = p.receive(json!({"id":2,"error":{"code":-32603,"message":"Internal error","data":{"message":"ValueError: invalid working directory","apiKey":"fixture-secret","stack":"private opaque metadata"}}})).err().unwrap();
        assert!(error.contains("session creation or resume"));
        assert!(error.contains("ValueError: invalid working directory"));
        assert!(!error.contains("fixture-secret"));
        assert!(!error.contains("private opaque metadata"));
    }

    #[cfg(unix)]
    fn fixture(script: &str) -> Command {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", script]);
        command
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn metadata_survives_missing_commands_after_slow_startup() {
        assert!(DISCOVERY_STARTUP >= Duration::from_secs(60));
        let command = fixture(r#"
            sleep 0.1
            read -r initialize
            printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}'
            read -r session
            printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"sessionId":"fixture","models":{"availableModels":[{"modelId":"model-fixture","name":"Model fixture"}]}}}'
            read -r forbidden
        "#);
        let start = std::time::Instant::now();
        let (metadata, commands) = inspect_state(command, &std::env::temp_dir(), true, false, Duration::from_secs(2), Duration::from_millis(20)).await.unwrap();
        assert_eq!(metadata["sessionId"], "fixture");
        assert!(parse_models(&metadata).iter().any(|model| model.id == "model-fixture"));
        assert!(commands.is_none());
        assert!(start.elapsed() < Duration::from_secs(1));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn readiness_distinguishes_startup_authentication_and_session_failures() {
        for (reply, state, acp_ready) in [
            (r#"{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":2}}"#, "startupFailed", false),
            (r#"{"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":"Login required"}}"#, "authenticationRequired", true),
            (r#"{"jsonrpc":"2.0","id":2,"error":{"code":-32603,"message":"Invalid working directory"}}"#, "sessionFailed", true),
            (r#"{"jsonrpc":"2.0","id":2,"result":{"sessionId":"ready"}}"#, "ready", true),
        ] {
            let startup = if acp_ready { "read -r init; printf '%s\\n' '{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"protocolVersion\":1}}';" } else { "" };
            let command = fixture(&format!("{startup} read -r request; printf '%s\\n' '{reply}'; read -r forbidden"));
            let status = connection_status(inspect_state(command, &std::env::temp_dir(), false, false, Duration::from_secs(2), Duration::from_millis(20)).await);
            assert_eq!(status.state, state);
            assert!(status.installed);
            assert_eq!(status.acp_ready, acp_ready);
            assert_eq!(status.session_ready, state == "ready");
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn readiness_reports_timeout_and_stderr_cause_without_credentials() {
        let failure = inspect_state(fixture("read -r init; sleep 2"), &std::env::temp_dir(), false, false, Duration::from_millis(20), COMMAND_GRACE).await.unwrap_err();
        assert_eq!(failure.message, ACP_STARTUP_TIMEOUT);
        assert!(!failure.acp_ready);
        let failure = inspect_state(fixture("printf '%s\\n' 'FutureWarning: Python is deprecated' 'Authorization: Bearer fixture-secret' 'ValueError: invalid cwd' >&2; exit 1"), &std::env::temp_dir(), false, false, Duration::from_secs(2), COMMAND_GRACE).await.unwrap_err();
        assert!(failure.message.contains("ValueError: invalid cwd"));
        assert!(!failure.message.contains("fixture-secret"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn readiness_declines_agent_requests_without_authentication_or_prompts() {
        let command = fixture(r#"
            read -r request
            case "$request" in *'"method":"initialize"'*) ;; *) exit 1;; esac
            printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"authMethods":[{"id":"oauth-personal"}]}}'
            read -r request
            case "$request" in *'"method":"session/new"'*) ;; *) exit 1;; esac
            printf '%s\n' '{"jsonrpc":"2.0","id":90,"method":"fs/write_text_file","params":{"path":"unused","content":"must not write"}}'
            read -r request
            case "$request" in *'"code":-32601'*) ;; *) exit 1;; esac
            printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"sessionId":"ready"}}'
            read -r forbidden
        "#);
        let status = connection_status(inspect_state(command, &std::env::temp_dir(), false, false, Duration::from_secs(2), COMMAND_GRACE).await);
        assert_eq!(status.state, "ready");
    }

    #[cfg(windows)]
    #[test]
    fn antigravity_new_and_resumed_sessions_use_ordinary_windows_cwd() {
        for resume_id in [None, Some("saved-session".into())] {
            let mut cfg = config("antigravity");
            cfg.cwd = PathBuf::from(r"\\?\C:\project");
            cfg.resume_id = resume_id;
            let request = Protocol::new(cfg).receive(capabilities()).unwrap().write.remove(0);
            assert_eq!(request["params"]["cwd"], r"C:\project");
        }
    }

    #[tokio::test]
    #[ignore = "Needs installed and signed-in official Antigravity ACP server; never sends a prompt"]
    async fn installed_antigravity_opens_session_without_prompt() {
        let status = provider_check_connection("antigravity".into()).await.unwrap();
        assert_eq!(status.state, "ready", "{}", status.message);
    }
    fn capabilities() -> Value {
        json!({"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentCapabilities":{"loadSession":true,"promptCapabilities":{"image":true},"mcpCapabilities":{"http":true}}}})
    }
    fn metadata() -> Value {
        json!({"sessionId":"remote","configOptions":[
            {"id":"model","category":"model","type":"select","currentValue":"vendor/a","options":[{"value":"vendor/a","name":"Model A"},{"value":"vendor/b","name":"Model B"}]},
            {"id":"mode","category":"mode","type":"select","currentValue":"build","options":[{"value":"build","name":"Build"},{"value":"plan","name":"Plan"}]}
        ]})
    }
    fn response(id: u64, result: Value) -> Value {
        json!({"jsonrpc":"2.0","id":id,"result":result})
    }
    fn copilot_session() -> Value {
        json!({"sessionId":"copilot-session","configOptions":[
            {"type":"select","id":"mode","category":"mode","currentValue":"https://agentclientprotocol.com/protocol/session-modes#agent","options":[
                {"value":"https://agentclientprotocol.com/protocol/session-modes#agent","name":"Agent"},
                {"value":"https://agentclientprotocol.com/protocol/session-modes#plan","name":"Plan"},
                {"value":"https://agentclientprotocol.com/protocol/session-modes#autopilot","name":"Autopilot"}]},
            {"type":"select","id":"allow_all","category":"permissions","currentValue":"off","options":[{"value":"on"},{"value":"off"}]}],
            "modes":{"availableModes":[
                {"id":"https://agentclientprotocol.com/protocol/session-modes#agent","name":"Agent"},
                {"id":"https://agentclientprotocol.com/protocol/session-modes#plan","name":"Plan"},
                {"id":"https://agentclientprotocol.com/protocol/session-modes#autopilot","name":"Autopilot"}]}})
    }
    #[test]
    fn copilot_initializes_via_acp_and_applies_only_advertised_mode_and_permission_values() {
        for (mode, expected_mode, expected_allow_all) in [
            ("ask", "#agent", "off"),
            ("plan", "#plan", "off"),
            ("full", "#agent", "on"),
        ] {
            let mut cfg = config("github-copilot");
            cfg.mode = mode.into();
            let mut p = Protocol::new(cfg);
            assert_eq!(p.initial()["method"], "initialize");
            assert_eq!(
                p.receive(capabilities()).unwrap().write[0]["method"],
                "session/new"
            );
            let selected_mode = p.receive(response(2, copilot_session())).unwrap();
            assert_eq!(
                selected_mode.write[0]["method"],
                "session/set_config_option"
            );
            assert!(selected_mode.write[0]["params"]["value"]
                .as_str()
                .unwrap()
                .ends_with(expected_mode));
            let permissions = p.receive(response(4, json!({}))).unwrap();
            assert_eq!(permissions.write[0]["params"]["configId"], "allow_all");
            assert_eq!(permissions.write[0]["params"]["value"], expected_allow_all);
            let prompt = p.receive(response(8, json!({}))).unwrap();
            assert_eq!(prompt.write[0]["id"], 3);
            assert_eq!(prompt.write[0]["method"], "session/prompt");
        }
    }
    #[test]
    fn copilot_plan_mode_allows_think_and_declines_other_permissions() {
        let mut cfg = config("github-copilot");
        cfg.mode = "plan".into();
        let mut p = Protocol::new(cfg);
        p.remote_id = "copilot-session".into();
        for (kind, expected) in [
            ("think", "yes"),
            ("execute", "no"),
            ("edit", "no"),
            ("other", "cancelled"),
        ] {
            let mut request = json!({"jsonrpc":"2.0","id":"permission","method":"session/request_permission","params":{"sessionId":"copilot-session","toolCall":{"title":"Requested action","kind":kind},"options":[{"optionId":"yes","kind":"allow_once"},{"optionId":"no","kind":"reject_once"}]}});
            if expected == "cancelled" {
                request["params"]["options"] = json!([]);
            }
            let step = p.receive(request).unwrap();
            assert_eq!(
                step.write[0]["result"]["outcome"]["outcome"],
                if expected == "cancelled" {
                    "cancelled"
                } else {
                    "selected"
                }
            );
            if expected != "cancelled" {
                assert_eq!(step.write[0]["result"]["outcome"]["optionId"], expected);
            }
            if expected == "no" {
                assert!(step
                    .events
                    .iter()
                    .any(|event| event.text.contains("Plan mode declined")));
            }
        }
    }
    #[test]
    fn copilot_plan_mode_sends_read_and_search_through_normal_approval() {
        let mut cfg = config("github-copilot");
        cfg.mode = "plan".into();
        let mut p = Protocol::new(cfg);
        p.remote_id = "copilot-session".into();
        for kind in ["read", "search"] {
            let request = json!({"jsonrpc":"2.0","id":"permission","method":"session/request_permission","params":{"sessionId":"copilot-session","toolCall":{"title":"Requested action","kind":kind},"options":[{"optionId":"yes","kind":"allow_once"},{"optionId":"no","kind":"reject_once"}]}});
            let step = p.receive(request).unwrap();
            assert!(step.write.is_empty(), "{kind} must wait for the user");
        }
    }
    #[test]
    fn copilot_requires_advertised_permission_and_model_settings() {
        let mut p = Protocol::new(config("github-copilot"));
        p.receive(capabilities()).unwrap();
        let mut session = copilot_session();
        session["configOptions"] = json!([session["configOptions"][0].clone()]);
        p.receive(response(2, session)).unwrap();
        assert!(p
            .receive(response(4, json!({})))
            .err()
            .unwrap()
            .contains("Allow All"));
        let mut p = Protocol::new(config("github-copilot"));
        p.remote_id = "copilot-session".into();
        p.acp_config = copilot_session();
        let mut cfg = config("github-copilot");
        cfg.model = "unadvertised-model".into();
        p.config = cfg;
        assert!(p
            .receive(response(8, json!({})))
            .err()
            .unwrap()
            .contains("does not advertise the selected model"));
    }
    #[test]
    fn copilot_authentication_errors_name_its_login_command() {
        let mut p = Protocol::new(config("github-copilot"));
        let error = p
            .receive(
                json!({"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":"Unauthorized"}}),
            )
            .err()
            .unwrap();
        assert!(error.contains("copilot login"));
    }
    #[test]
    fn copilot_launch_uses_direct_stdio_acp_arguments() {
        let mut command = Command::new("copilot");
        configure(&mut command, &config("github-copilot"));
        assert_eq!(
            command.as_std().get_args().collect::<Vec<_>>(),
            [
                std::ffi::OsStr::new("--no-auto-update"),
                std::ffi::OsStr::new("--acp"),
                std::ffi::OsStr::new("--stdio"),
            ]
        );
    }
    #[test]
    fn startup_status_identifies_each_acknowledged_acp_stage() {
        let status = |step: &Step| step.events.iter().filter(|event| event.kind == "status").map(|event| event.text.as_str()).collect::<Vec<_>>().join(", ");
        for (resume, expected) in [(None, "Opening session"), (Some("saved".into()), "Restoring session")] {
            let mut cfg = config("antigravity");
            cfg.model = "vendor/b".into();
            cfg.reasoning_effort = Some("high".into());
            cfg.resume_id = resume;
            let mut p = Protocol::new(cfg);
            assert_eq!(status(&p.receive(capabilities()).unwrap()), expected);
            let metadata = json!({"sessionId":"remote","configOptions":[
                {"id":"mode","category":"mode","type":"select","options":[{"value":"default"}]},
                {"id":"model","category":"model","type":"select","options":[{"value":"vendor/b"}]},
                {"id":"effort","category":"thought_level","type":"select","options":[{"value":"high"}]}
            ]});
            assert_eq!(status(&p.receive(response(2, metadata)).unwrap()), "Applying task mode");
            assert_eq!(status(&p.receive(response(4, json!({}))).unwrap()), "Applying model settings");
            assert_eq!(status(&p.receive(response(5, json!({}))).unwrap()), "Applying reasoning settings");
            let prompt = p.receive(response(6, json!({}))).unwrap();
            assert_eq!(status(&prompt), "Waiting for response");
            assert_eq!(prompt.write[0]["method"], "session/prompt");
            assert!(p.receive(response(3, json!({}))).unwrap().done);
        }
    }
    #[test]
    fn opencode_waits_for_mode_model_and_dynamic_effort_before_prompt() {
        let mut cfg = config("opencode");
        cfg.model = "vendor/b".into();
        cfg.reasoning_effort = Some("high".into());
        let mut p = Protocol::new(cfg);
        assert_eq!(p.initial()["params"]["protocolVersion"], 1);
        assert_eq!(
            p.receive(capabilities()).unwrap().write[0]["method"],
            "session/new"
        );
        let step = p.receive(response(2, metadata())).unwrap();
        assert_eq!(step.write[0]["params"]["configId"], "mode");
        assert_eq!(step.write[0]["params"]["value"], "build");
        let step = p.receive(response(4, json!({}))).unwrap();
        assert_eq!(step.write[0]["params"]["configId"], "model");
        assert_eq!(step.write[0]["params"]["value"], "vendor/b");
        let step=p.receive(response(5,json!({"configOptions":[{"id":"variant","category":"thought_level","type":"select","currentValue":"low","options":[{"value":"low"},{"value":"high"}]}]}))).unwrap();
        assert_eq!(step.write[0]["params"]["configId"], "variant");
        assert_eq!(step.write[0]["params"]["value"], "high");
        assert_eq!(p.phase, 0);
        assert_eq!(
            p.receive(response(6, json!({}))).unwrap().write[0]["method"],
            "session/prompt"
        );
        assert_eq!(p.phase, 1);
    }
    #[test]
    fn opencode_selects_later_models_from_large_flat_and_grouped_catalogs() {
        for grouped in [false, true] {
            for effort in [None, Some("max")] {
                let mut cfg = config("opencode");
                cfg.model = "deepseek/deepseek-flash".into();
                cfg.reasoning_effort = effort.map(str::to_owned);
                let mut options: Vec<Value> = (0..2023)
                    .map(|index| json!({"value":format!("vendor/model-{index}"),"name":format!("Model {index}")}))
                    .collect();
                options[1996] = json!({"value":cfg.model,"name":"DeepSeek Flash"});
                let mut session = metadata();
                session["configOptions"][0]["options"] = if grouped {
                    json!([{"group":"provider","name":"Provider","options":options}])
                } else {
                    json!(options)
                };
                assert!(parse_models(&session).iter().any(|model| model.id == cfg.model));
                assert!(choice_request("remote", 5, &session["configOptions"][0], "vendor/missing").is_err());
                let mut p = Protocol::new(cfg);
                p.receive(capabilities()).unwrap();
                let mode = p.receive(response(2, session)).unwrap();
                assert_eq!(mode.write[0]["params"]["value"], "build");
                let model = p.receive(response(4, json!({}))).unwrap();
                assert_eq!(model.write[0]["method"], "session/set_config_option");
                assert_eq!(model.write[0]["params"]["value"], "deepseek/deepseek-flash");
                let configured = p.receive(response(5, json!({"configOptions":[{
                    "id":"effort","category":"thought_level","type":"select",
                    "currentValue":"default","options":[{"value":"default"},{"value":"max"}]
                }]}))).unwrap();
                let prompt = if effort.is_some() {
                    assert_eq!(configured.write[0]["params"]["configId"], "effort");
                    assert_eq!(configured.write[0]["params"]["value"], "max");
                    p.receive(response(6, json!({}))).unwrap()
                } else {
                    configured
                };
                assert_eq!(prompt.write[0]["method"], "session/prompt");
            }
        }
    }
    #[test]
    fn acp_catalog_limit_bounds_the_flattened_total() {
        let per_group = 20;
        let groups: Vec<Value> = (0..1000)
            .map(|group| json!({"group":format!("group-{group}"),"options":(0..per_group)
                .map(|index| json!({"value":format!("vendor/model-{}",group*per_group+index)}))
                .collect::<Vec<_>>()}))
            .collect();
        let option = json!({"id":"model","options":groups});
        let selected = choices(&option);
        assert_eq!(selected.len(), MODEL_CATALOG_LIMIT);
        let last = format!("vendor/model-{}", MODEL_CATALOG_LIMIT - 1);
        assert_eq!(selected.last().unwrap()["value"], last);
        assert!(choice_request("remote", 5, &option, &last).is_ok());
        assert!(choice_request("remote", 5, &option, "vendor/model-10000").is_err());
    }
    #[test]
    fn legacy_acp_catalog_keeps_later_models() {
        let available: Vec<Value> = (0..2023)
            .map(|index| json!({"modelId":format!("vendor/model-{index}"),"name":format!("Model {index}")}))
            .collect();
        let models = parse_models(&json!({"models":{"availableModels":available}}));
        assert_eq!(models.len(), 2024);
        assert_eq!(models.last().unwrap().id, "vendor/model-2022");
    }
    #[tokio::test]
    #[ignore = "Needs installed OpenCode; metadata only, never sends a prompt"]
    async fn installed_opencode_negotiates_selected_model_without_prompt() {
        let mut cfg = config("opencode");
        cfg.model = std::env::var("PANDACODE_OPENCODE_SMOKE_MODEL")
            .expect("Set PANDACODE_OPENCODE_SMOKE_MODEL to an available provider/model ID");
        cfg.reasoning_effort = std::env::var("PANDACODE_OPENCODE_SMOKE_EFFORT").ok();
        cfg.cwd = std::env::temp_dir().join(format!("pandacode-acp-smoke-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&cfg.cwd).unwrap();
        let path = executable("opencode").expect("Install OpenCode first");
        let mut command = super::super::command(&path).unwrap();
        configure(&mut command, &cfg);
        let mut pipe = Pipe::spawn(command, &cfg.cwd, Duration::from_secs(30)).unwrap();
        let mut protocol = Protocol::new(cfg.clone());
        let result: Result<(), String> = async {
            pipe.send(&protocol.initial()).await.map_err(|_| "Could not initialize OpenCode")?;
            loop {
                let frame = pipe.read().await.map_err(|_| "Could not read OpenCode metadata")?;
                if frame.get("method").is_some() && frame.get("id").is_some() {
                    pipe.send(&json!({"jsonrpc":"2.0","id":frame["id"],"error":{"code":-32601,"message":"Metadata smoke test does not execute requests"}}))
                        .await.map_err(|_| "Could not reject server request")?;
                    continue;
                }
                for request in protocol.receive(frame)?.write {
                    if request["method"] == "session/prompt" {
                        // Reaching this boundary proves settings were accepted.
                        // Never submit the prompt or spend model tokens.
                        return Ok(());
                    }
                    pipe.send(&request).await.map_err(|_| "Could not negotiate OpenCode settings")?;
                }
            }
        }.await;
        pipe.finish().await;
        let _ = std::fs::remove_dir(&cfg.cwd);
        result.unwrap();
    }
    // Shapes recorded from `grok agent stdio` 1.0.30/1.0.40 on 2026-09-21.
    fn grok_capabilities() -> Value {
        json!({"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,
            "agentCapabilities":{"loadSession":true,"promptCapabilities":{"image":false,"audio":false,"embeddedContext":true},"mcpCapabilities":{"http":true,"sse":true},"sessionCapabilities":{"list":{},"resume":{},"close":{}}},
            "authMethods":[{"id":"cached_token","name":"cached_token","description":"Cached token from ~/.grok/auth.json"},{"id":"grok.com","name":"Grok","description":"Sign in with Grok"}],
            "_meta":{"defaultAuthMethodId":"cached_token","agentVersion":"1.0.40","modelState":grok_model_state()}}})
    }
    fn grok_model_state() -> Value {
        json!({"currentModelId":"grok-4.7","availableModels":[
            {"modelId":"grok-4.7","name":"Grok 4.7","description":"SpaceXAI's latest frontier model","_meta":{"totalContextTokens":500000,"supportsReasoningEffort":true,"reasoningEffort":"high","reasoningEfforts":[
                {"id":"xhigh","value":"xhigh","label":"Extra High","description":"Maximum reasoning for the hardest tasks.","default":false},
                {"id":"high","value":"high","label":"High","description":"Thorough reasoning and quality. Recommended.","default":true},
                {"id":"medium","value":"medium","label":"Medium","description":"Strong quality with a faster turnaround.","default":false},
                {"id":"low","value":"low","label":"Low","description":"Fastest responses. Best for simple tasks.","default":false}]}},
            {"modelId":"grok-4.6","name":"Grok 4.6","description":"","_meta":{"totalContextTokens":256000,"supportsReasoningEffort":false}},
            {"modelId":"my-model","name":"GLM Coding Plan","description":"","_meta":{}}]})
    }
    fn grok_session() -> Value {
        json!({"sessionId":"01a0c6e4-07e8-7751-a18f-902b23e7446c","models":grok_model_state(),"configOptions":[
            {"id":"model","name":"Model","category":"model","type":"select","currentValue":"grok-4.7","options":[{"value":"grok-4.7","name":"Grok 4.7"},{"value":"grok-4.7-build-fast","name":"Grok 4.7 Fast"},{"value":"grok-4.6","name":"Grok 4.6"}]},
            {"id":"reasoning_effort","name":"Reasoning Effort","category":"thought_level","type":"select","currentValue":"high","options":[{"value":"xhigh","name":"Extra High"},{"value":"high","name":"High"},{"value":"medium","name":"Medium"},{"value":"low","name":"Low"}]}]})
    }
    fn grok_permission(kind: &str, read_only: bool) -> Value {
        json!({"jsonrpc":"2.0","id":0,"method":"session/request_permission","params":{"sessionId":"01a0c6e4-07e8-7751-a18f-902b23e7446c",
            "toolCall":{"toolCallId":"call-1","kind":kind,"title":"Write `hello.txt`","rawInput":{"file_path":"hello.txt"},"_meta":{"x.ai/tool":{"name":"write","read_only":read_only}}},
            "options":[{"optionId":"allow-edits-session","name":"Yes, allow all edits during this session","kind":"allow_always"},{"optionId":"allow-once","name":"Yes","kind":"allow_once"},{"optionId":"reject-once","name":"No, and tell Grok what to do differently","kind":"reject_once"}]}})
    }
    /// A Grok protocol past its handshake, plus the prompt text it sent.
    fn grok_ready(mode: &str) -> (Protocol, String) {
        let mut cfg = config("grok");
        cfg.mode = mode.into();
        let mut p = Protocol::new(cfg);
        p.receive(grok_capabilities()).unwrap();
        p.receive(response(7, json!({"_meta":{"email":"you@example.com"}}))).unwrap();
        let step = p.receive(response(2, grok_session())).unwrap();
        assert_eq!(step.write[0]["method"], "session/prompt", "default model and effort go straight to the prompt");
        let text = step.write[0]["params"]["prompt"][0]["text"].as_str().unwrap().to_owned();
        (p, text)
    }

    #[test]
    fn grok_authenticates_with_cached_credentials_then_sets_model_and_effort_before_prompting() {
        let mut cfg = config("grok");
        cfg.model = "grok-4.7-build-fast".into();
        cfg.reasoning_effort = Some("medium".into());
        let mut p = Protocol::new(cfg);
        assert_eq!(p.initial()["method"], "initialize");
        let step = p.receive(grok_capabilities()).unwrap();
        assert_eq!(step.write.len(), 1);
        assert_eq!(step.write[0]["id"], 7);
        assert_eq!(step.write[0]["method"], "authenticate");
        assert_eq!(step.write[0]["params"]["methodId"], "cached_token");
        let step = p.receive(response(7, json!({"_meta":{"subscription_tier":"X Premium"}}))).unwrap();
        assert_eq!(step.write[0]["method"], "session/new");
        assert_eq!(step.write[0]["params"]["cwd"], "/tmp");
        // No session mode exists for Grok, so the model is configured directly.
        let step = p.receive(response(2, grok_session())).unwrap();
        assert!(step.events.iter().any(|event| event.kind == "session"));
        assert_eq!(step.write[0]["method"], "session/set_config_option");
        assert_eq!(step.write[0]["params"]["configId"], "model");
        assert_eq!(step.write[0]["params"]["value"], "grok-4.7-build-fast");
        let step = p.receive(response(5, json!({}))).unwrap();
        assert_eq!(step.write[0]["params"]["configId"], "reasoning_effort");
        assert_eq!(step.write[0]["params"]["value"], "medium");
        let step = p.receive(response(6, json!({}))).unwrap();
        assert_eq!(step.write[0]["method"], "session/prompt");
        assert_eq!(step.write[0]["params"]["prompt"][0]["text"], "Explain this project");
        assert_eq!(p.phase, 1);
    }

    #[test]
    fn grok_without_cached_credentials_or_with_a_failed_authenticate_asks_to_sign_in() {
        let mut p = Protocol::new(config("grok"));
        let mut capabilities = grok_capabilities();
        capabilities["result"]["authMethods"] = json!([{"id":"grok.com","name":"Grok"}]);
        capabilities["result"]["_meta"]["defaultAuthMethodId"] = Value::Null;
        assert_eq!(p.receive(capabilities).err().unwrap(), GROK_SIGN_IN);
        let mut p = Protocol::new(config("grok"));
        p.receive(grok_capabilities()).unwrap();
        let failed = json!({"jsonrpc":"2.0","id":7,"error":{"code":-32603,"message":"token expired"}});
        assert_eq!(p.receive(failed).err().unwrap(), GROK_SIGN_IN);
        // Images are refused up front because the agent does not advertise them.
        let mut p = Protocol::new(config("grok"));
        p.image_blocks.push(json!({"type":"image"}));
        assert!(p.receive(grok_capabilities()).err().unwrap().contains("does not accept images"));
    }

    #[test]
    fn grok_plan_mode_prefixes_the_prompt_and_declines_state_changing_permissions() {
        let (mut p, text) = grok_ready("plan");
        assert!(text.starts_with(GROK_PLAN_PREFIX));
        assert!(text.ends_with("Explain this project"));
        let step = p.receive(grok_permission("edit", false)).unwrap();
        assert_eq!(step.write[0]["result"]["outcome"]["optionId"], "reject-once");
        assert!(step.events.iter().any(|event| event.kind == "status" && event.text.contains("Plan mode declined")));
        assert!(p.pending.is_empty(), "nothing waits on the user");
        let step = p.receive(grok_permission("read", true)).unwrap();
        assert_eq!(step.write[0]["result"]["outcome"]["optionId"], "allow-once");
        // Other modes keep the user in the loop for edits and leave the prompt alone.
        let (mut p, text) = grok_ready("ask");
        assert_eq!(text, "Explain this project");
        let step = p.receive(grok_permission("edit", false)).unwrap();
        assert!(step.write.is_empty());
        assert!(step.events.iter().any(|event| event.kind == "approval"));
        let (mut p, text) = grok_ready("auto");
        assert!(!text.contains("Plan mode"));
        let step = p.receive(grok_permission("edit", false)).unwrap();
        assert_eq!(step.write[0]["result"]["outcome"]["optionId"], "allow-once");
    }

    #[test]
    fn grok_reports_context_usage_from_frame_metadata_and_follows_model_switches() {
        let (mut p, _) = grok_ready("ask");
        p.phase = 1;
        let session = "01a0c6e4-07e8-7751-a18f-902b23e7446c";
        let chunk = |text: &str, total: u64| json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":session,"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":text}}},"_meta":{"totalTokens":total}});
        let step = p.receive(chunk("OK", 2281)).unwrap();
        let usage = step.events.iter().find(|event| event.kind == "usage").expect("usage");
        assert_eq!(usage.data.as_ref().unwrap()["usedTokens"], 2281);
        assert_eq!(usage.data.as_ref().unwrap()["contextWindow"], 500000);
        assert!(step.events.iter().any(|event| event.kind == "text" && event.text == "OK"));
        // The same total again is not re-announced.
        assert!(!p.receive(chunk(" then", 2281)).unwrap().events.iter().any(|event| event.kind == "usage"));
        p.receive(json!({"jsonrpc":"2.0","method":"_x.ai/session_notification","params":{"sessionId":session,"update":{"sessionUpdate":"model_changed","model_id":"grok-4.6","reasoning_effort":"high"}}})).unwrap();
        assert_eq!(p.active_model, "grok-4.6");
        let step = p.receive(chunk(".", 4000)).unwrap();
        assert_eq!(step.events.iter().find(|event| event.kind == "usage").unwrap().data.as_ref().unwrap()["contextWindow"], 256000);
        // Extension notifications for other sessions and unknown methods are ignored.
        assert!(p.receive(json!({"jsonrpc":"2.0","method":"_x.ai/queue/changed","params":{"sessionId":session,"entries":[]}})).unwrap().events.is_empty());
        let step = p.receive(json!({"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn","_meta":{"totalTokens":27703,"modelId":"grok-4.7"}}})).unwrap();
        assert!(step.done);
        assert_eq!(step.events.iter().find(|event| event.kind == "usage").unwrap().data.as_ref().unwrap()["usedTokens"], 27703);
    }

    #[test]
    fn grok_thoughts_surface_as_one_reasoning_status_per_stretch() {
        let (mut p, _) = grok_ready("ask");
        p.phase = 1;
        let session = "01a0c6e4-07e8-7751-a18f-902b23e7446c";
        let thought = json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":session,"update":{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"The user"}}}});
        let statuses = |step: &Step| step.events.iter().filter(|event| event.kind == "status" && event.text == "Reasoning").count();
        assert_eq!(statuses(&p.receive(thought.clone()).unwrap()), 1);
        assert_eq!(statuses(&p.receive(thought.clone()).unwrap()), 0);
        p.receive(json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":session,"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"OK"}}}})).unwrap();
        assert_eq!(statuses(&p.receive(thought).unwrap()), 1);
    }

    #[test]
    fn grok_launch_flags_follow_the_approval_mode_and_selection() {
        let args = |mode: &str, model: &str, effort: Option<&str>| {
            let mut cfg = config("grok");
            cfg.mode = mode.into();
            cfg.model = model.into();
            cfg.reasoning_effort = effort.map(str::to_owned);
            let mut command = Command::new("grok");
            configure(&mut command, &cfg);
            command.as_std().get_args().map(|arg| arg.to_string_lossy().into_owned()).collect::<Vec<_>>()
        };
        assert_eq!(args("ask", "default", None), ["--no-auto-update", "--permission-mode", "default", "agent", "stdio"]);
        assert_eq!(args("plan", "default", None), ["--no-auto-update", "--permission-mode", "default", "agent", "stdio"]);
        assert_eq!(args("auto", "grok-4.7", Some("low")), ["--no-auto-update", "--permission-mode", "acceptEdits", "agent", "--model", "grok-4.7", "--reasoning-effort", "low", "stdio"]);
        assert_eq!(args("full", "default", None), ["--no-auto-update", "--permission-mode", "bypassPermissions", "agent", "--always-approve", "stdio"]);
    }

    #[test]
    fn grok_models_come_from_the_initialize_model_state_with_context_and_efforts() {
        let models = parse_grok_models(&grok_model_state());
        assert_eq!(models.iter().map(|model| model.id.as_str()).collect::<Vec<_>>(), ["default", "grok-4.7", "grok-4.6", "my-model"]);
        let flagship = &models[1];
        assert_eq!(flagship.name, "Grok 4.7");
        assert_eq!(flagship.context_window, Some(500000));
        assert_eq!(flagship.reasoning_efforts.iter().map(|effort| effort.id.as_str()).collect::<Vec<_>>(), ["low", "medium", "high", "xhigh"]);
        assert_eq!(flagship.reasoning_efforts[3].name, "Extra High");
        assert_eq!(flagship.default_reasoning_effort.as_deref(), Some("high"));
        assert_eq!(models[2].context_window, Some(256000));
        assert!(models[2].reasoning_efforts.is_empty());
        assert_eq!(models[3].context_window, None);
        assert_eq!(parse_grok_models(&json!({})).len(), 1, "no state means only the default choice");
    }

    #[tokio::test]
    #[ignore = "Needs installed and signed-in Grok Build; metadata only, never sends a prompt"]
    async fn installed_grok_negotiates_settings_without_prompt() {
        let path = executable("grok").expect("Install Grok Build first");
        let models = grok_models(&path).await.unwrap();
        assert!(models.len() > 1, "{models:?}");
        let chosen = models.iter().find(|model| model.id != "default" && !model.reasoning_efforts.is_empty()).expect("a model with efforts");
        let mut cfg = config("grok");
        cfg.model = chosen.id.clone();
        cfg.reasoning_effort = Some(chosen.reasoning_efforts.last().unwrap().id.clone());
        cfg.cwd = std::env::temp_dir().join(format!("pandacode-grok-smoke-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&cfg.cwd).unwrap();
        let mut command = super::super::command(&path).unwrap();
        configure(&mut command, &cfg);
        let mut pipe = Pipe::spawn(command, &cfg.cwd, Duration::from_secs(30)).unwrap();
        let mut protocol = Protocol::new(cfg.clone());
        let result: Result<(), String> = async {
            pipe.send(&protocol.initial()).await.map_err(|_| "Could not initialize Grok")?;
            loop {
                let frame = pipe.read().await.map_err(|_| "Could not read Grok metadata")?;
                if frame.get("method").is_some() && frame.get("id").is_some() {
                    pipe.send(&json!({"jsonrpc":"2.0","id":frame["id"],"error":{"code":-32601,"message":"Metadata smoke test does not execute requests"}}))
                        .await.map_err(|_| "Could not reject server request")?;
                    continue;
                }
                for request in protocol.receive(frame)?.write {
                    if request["method"] == "session/prompt" {
                        return Ok(());
                    }
                    pipe.send(&request).await.map_err(|_| "Could not negotiate Grok settings")?;
                }
            }
        }.await;
        pipe.finish().await;
        let _ = std::fs::remove_dir(&cfg.cwd);
        result.unwrap();
    }

    #[test]
    fn resume_uses_capabilities_without_silently_starting_fresh() {
        for provider in ["opencode", "antigravity"] {
            let mut cfg = config(provider);
            cfg.resume_id = Some("existing".into());
            let mut p = Protocol::new(cfg.clone());
            let request = p.receive(capabilities()).unwrap().write.remove(0);
            assert_eq!(request["method"], "session/load");
            assert_eq!(request["params"]["sessionId"], "existing");
            let mut supported = capabilities();
            supported["result"]["agentCapabilities"]["sessionCapabilities"] = json!({"resume":{}});
            let mut p = Protocol::new(cfg.clone());
            assert_eq!(
                p.receive(supported).unwrap().write[0]["method"],
                "session/resume"
            );
            let mut unsupported = capabilities();
            unsupported["result"]["agentCapabilities"]["loadSession"] = json!(false);
            assert!(Protocol::new(cfg)
                .receive(unsupported)
                .err()
                .unwrap()
                .contains("resume"));
        }
    }
    #[test]
    fn unsupported_images_mcp_effort_or_plan_fail_before_any_prompt() {
        let mut p = Protocol::new(config("antigravity"));
        p.image_blocks.push(json!({"type":"image"}));
        let mut cap = capabilities();
        cap["result"]["agentCapabilities"]["promptCapabilities"]["image"] = json!(false);
        assert!(p.receive(cap).err().unwrap().contains("image"));
        let mut p = Protocol::new(config("antigravity"));
        p.mcp_server = Some(json!({}));
        let mut cap = capabilities();
        cap["result"]["agentCapabilities"]["mcpCapabilities"]["http"] = json!(false);
        assert!(p.receive(cap).err().unwrap().contains("MCP"));
        let mut p = Protocol::new(config("antigravity"));
        p.mcp_server = Some(json!({}));
        p.mcp_required = false;
        let mut cap = capabilities();
        cap["result"]["agentCapabilities"]["mcpCapabilities"]["http"] = json!(false);
        let step = p.receive(cap).unwrap();
        assert_eq!(step.write[0]["method"], "session/new");
        assert_eq!(step.write[0]["params"]["mcpServers"], json!([]));
        let mut cfg = config("antigravity");
        cfg.mode = "plan".into();
        assert!(Protocol::new(cfg)
            .receive(response(2, json!({"sessionId":"remote"})))
            .err()
            .unwrap()
            .contains("planning"));
        let mut cfg = config("opencode");
        cfg.reasoning_effort = Some("ultra".into());
        let mut p = Protocol::new(cfg);
        p.acp_config = metadata();
        p.remote_id = "remote".into();
        assert!(p.receive(response(4, json!({}))).is_err());
    }
    fn permission() -> Value {
        json!({"jsonrpc":"2.0","id":"p1","method":"session/request_permission","params":{"sessionId":"remote","toolCall":{"title":"Run command","kind":"execute"},"options":[{"optionId":"yes","kind":"allow_once"},{"optionId":"no","kind":"reject_once"}]}})
    }
    #[test]
    fn acp_approvals_wait_in_standard_and_auto_edit_modes_and_cancel_foreign_requests() {
        for provider in ["opencode", "antigravity"] {
            for mode in ["ask", "auto"] {
                let mut cfg = config(provider);
                cfg.mode = mode.into();
                let mut p = Protocol::new(cfg);
                p.remote_id = "remote".into();
                let step = p.receive(permission()).unwrap();
                assert!(step.write.is_empty());
                let request = step
                    .events
                    .iter()
                    .find(|event| event.kind == "approval")
                    .unwrap()
                    .request_id
                    .as_ref()
                    .unwrap();
                assert_eq!(
                    p.approve(request, false).unwrap()["result"]["outcome"]["optionId"],
                    "no"
                );
                let mut foreign = permission();
                foreign["params"]["sessionId"] = json!("other");
                assert_eq!(
                    p.receive(foreign).unwrap().write[0]["result"]["outcome"]["outcome"],
                    "cancelled"
                );
            }
            let mut cfg = config(provider);
            cfg.mode = "full".into();
            let mut p = Protocol::new(cfg);
            p.remote_id = "remote".into();
            assert_eq!(
                p.receive(permission()).unwrap().write[0]["result"]["outcome"]["optionId"],
                "yes"
            );
        }
    }
    #[test]
    fn full_acp_permissions_do_not_answer_questions_or_guess_between_grants() {
        for provider in ["opencode", "antigravity"] {
            for options in [
                json!([{"optionId":"q0_opt_0","kind":"allow_once"},{"optionId":"no","kind":"reject_once"}]),
                json!([{"optionId":"one","kind":"allow_once"},{"optionId":"two","kind":"allow_once"}]),
            ] {
                let mut cfg = config(provider);
                cfg.mode = "full".into();
                let mut p = Protocol::new(cfg);
                p.remote_id = "remote".into();
                let mut request = permission();
                request["params"]["options"] = options;
                let step = p.receive(request).unwrap();
                assert_eq!(step.write[0]["result"]["outcome"]["outcome"], "cancelled");
                assert!(step.events.iter().any(|event| event.kind == "status"));
            }
        }
        let full: Value = serde_json::from_str(&configuration("full")).unwrap();
        assert_eq!(full["permission"]["*"], "allow");
        assert_eq!(full["agent"]["build"]["permission"]["*"], "allow");
        assert_eq!(full["agent"]["plan"]["permission"]["*"], "allow");
    }

    #[test]
    fn acp_streaming_preserves_boundaries_tools_usage_and_isolation() {
        for provider in ["opencode", "antigravity"] {
            let mut p = Protocol::new(config(provider));
            p.remote_id = "remote".into();
            let chunk = json!({"method":"session/update","params":{"sessionId":"remote","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hello"}}}});
            assert!(p.receive(chunk.clone()).unwrap().events.is_empty());
            p.phase = 1;
            let before = p.receive(chunk.clone()).unwrap();
            assert_eq!(before.events.last().unwrap().text, "hello");
            let tool = json!({"method":"session/update","params":{"sessionId":"remote","update":{"sessionUpdate":"tool_call","toolCallId":"one","title":"Read file","status":"in_progress","rawInput":{"path":"src/main.ts"}}}});
            assert!(p.receive(tool).unwrap().events.iter().any(|event| event
                .tool
                .as_ref()
                .is_some_and(|tool| tool.input.contains("main.ts"))));
            let after = p.receive(chunk.clone()).unwrap();
            assert_ne!(before.events[0].data, after.events[0].data);
            let mut foreign = chunk;
            foreign["params"]["sessionId"] = json!("other");
            assert!(p.receive(foreign).unwrap().events.is_empty());
            assert_eq!(p.cancel()["method"], "session/cancel");
            assert!(
                p.receive(response(3, json!({"stopReason":"end_turn"})))
                    .unwrap()
                    .done
            );
        }
    }
    #[test]
    fn commands_use_supported_binary_args_and_permissions_are_process_local() {
        let mut c = Command::new("opencode");
        let mut cfg = config("opencode");
        cfg.mode = "plan".into();
        configure(&mut c, &cfg);
        assert_eq!(
            c.as_std().get_args().collect::<Vec<_>>(),
            [std::ffi::OsStr::new("acp")]
        );
        let inline = c
            .as_std()
            .get_envs()
            .find(|(k, _)| *k == "OPENCODE_CONFIG_CONTENT")
            .unwrap()
            .1
            .unwrap();
        let value: Value = serde_json::from_str(inline.to_str().unwrap()).unwrap();
        assert_eq!(value["permission"]["*"], "deny");
        assert_eq!(value["permission"]["read"], "allow");
        assert_eq!(value["agent"]["plan"]["permission"]["*"], "deny");
        let mut c = Command::new("agy_acp_server.par");
        configure(&mut c, &config("antigravity"));
        assert!(!c.as_std().get_args().any(|arg| arg == "acp"));
    }
    #[test]
    fn glm_explicit_model_remains_a_cli_override_and_default_is_real_glm() {
        for model in ["default", "glm-5.3-flash"] {
            let mut cfg = config("glm");
            cfg.model = model.into();
            let mut command = Command::new("claude");
            super::super::configure_command(&mut command, &cfg);
            let args = command
                .as_std()
                .get_args()
                .map(|arg| arg.to_string_lossy().to_string())
                .collect::<Vec<_>>();
            let index = args.iter().position(|arg| arg == "--model").unwrap();
            assert_eq!(
                args[index + 1],
                if model == "default" { "glm-5.3" } else { model }
            );
        }
    }

    #[test]
    fn grouped_acp_models_keep_labels_and_do_not_infer_effort_for_other_models() {
        let models = parse_models(
            &json!({"configOptions":[{"id":"model","category":"model","type":"select","currentValue":"a","options":[{"group":"vendor","options":[{"value":"a","name":"Actual A"},{"value":"b","name":"Actual B"}]}]},{"id":"effort","category":"thought_level","type":"select","currentValue":"high","options":[{"value":"high"}]}]}),
        );
        assert_eq!(models[1].name, "Actual A");
        assert_eq!(models[2].name, "Actual B");
        assert_eq!(models[1].reasoning_efforts.len(), 1);
        assert!(models[2].reasoning_efforts.is_empty());
    }

    fn acp_steer(p: &mut Protocol, id: &str, text: &str) -> (Step, Result<Value, String>) {
        let (tx, mut rx) = tokio::sync::oneshot::channel();
        let step = p.acp_steer(id.into(), text.into(), tx);
        (step, rx.try_recv().unwrap())
    }

    fn steer_statuses(step: &Step) -> Vec<(String, String, String)> {
        step.events.iter().filter(|event| event.kind == "steer").map(|event| {
            let data = event.data.as_ref().unwrap();
            (data["id"].as_str().unwrap().into(), data["status"].as_str().unwrap().into(), data["mode"].as_str().unwrap().into())
        }).collect()
    }

    // Recorded from grok 1.0.62 `agent stdio`: a turn end, trimmed to the fields read here.
    fn grok_turn_end() -> Value {
        json!({"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn","_meta":{"sessionId":"01a16446-2e56-77e2-8bb5-ed2ce3a57f81","requestId":"59162bb0-f403-47e6-a050-70c29e8c39e9","promptId":"59162bb0-f403-47e6-a050-70c29e8c39e9","totalTokens":27887,"modelId":"grok-4.7","inputTokens":27849,"outputTokens":31}}})
    }

    #[test]
    fn held_steers_go_out_as_the_next_prompt_and_keep_the_run_open() {
        let (mut p, _) = grok_ready("plan");
        let (step, reply) = acp_steer(&mut p, "s1", "  use the parser  ");
        assert!(step.write.is_empty(), "Grok cannot take input mid-turn");
        assert_eq!(reply.unwrap(), json!({"steered":true,"id":"s1","mode":"next-turn"}));
        assert_eq!(steer_statuses(&step), [("s1".into(), "pending".into(), "next-turn".into())]);
        acp_steer(&mut p, "s2", "and add tests").1.unwrap();

        let step = p.receive(grok_turn_end()).unwrap();
        assert!(!step.done, "the run waits for the steered turn");
        assert_eq!(step.write.len(), 1);
        let prompt = &step.write[0];
        assert_eq!(prompt["method"], "session/prompt");
        assert_eq!(prompt["id"], 3);
        assert_eq!(prompt["params"]["sessionId"], p.remote_id);
        let text = prompt["params"]["prompt"][0]["text"].as_str().unwrap();
        assert!(text.starts_with(GROK_PLAN_PREFIX) && text.ends_with("use the parser\n\nand add tests"), "{text}");
        let delivered: Vec<_> = steer_statuses(&step).into_iter().map(|(id, status, _)| (id, status)).collect();
        assert_eq!(delivered, [("s1".into(), "delivered".into()), ("s2".into(), "delivered".into())]);

        let step = p.receive(grok_turn_end()).unwrap();
        assert!(step.done && step.write.is_empty());
    }

    #[test]
    fn steers_before_the_first_prompt_wait_and_cancelled_turns_fail_them() {
        let mut p = Protocol::new(config("kimi"));
        let (step, reply) = acp_steer(&mut p, "early", "hi");
        assert!(step.write.is_empty());
        assert_eq!(reply.unwrap()["mode"], "next-turn");
        p.remote_id = "main".into();
        p.phase = 1;
        // Recorded Kimi Code 0.26 cancel answer.
        let step = p.kimi_steered(json!({"jsonrpc":"2.0","id":3,"result":{"stopReason":"cancelled"}})).unwrap();
        assert!(step.done && step.write.is_empty());
        assert_eq!(steer_statuses(&step), [("early".into(), "failed".into(), "next-turn".into())]);

        let mut p = Protocol::new(config("kimi"));
        p.remote_id = "main".into();
        p.phase = 1;
        acp_steer(&mut p, "k", "next").1.unwrap();
        let step = p.kimi_steered(json!({"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}})).unwrap();
        assert!(!step.done);
        assert_eq!(step.write[0]["params"]["prompt"][0]["text"], "next");
        acp_steer(&mut p, "lost", "never sent").1.unwrap();
        assert_eq!(steer_statuses(&p.acp_steers_failed()), [("lost".into(), "failed".into(), "next-turn".into())]);
    }

    #[test]
    fn steers_are_bounded_and_validated() {
        let mut p = Protocol::new(config("deepseek"));
        assert!(acp_steer(&mut p, "a", "   ").1.is_err());
        assert!(acp_steer(&mut p, "a", &"x".repeat(MAX_STEER_BYTES + 1)).1.is_err());
        for n in 0..MAX_STEERS {
            acp_steer(&mut p, &n.to_string(), "ok").1.unwrap();
        }
        let (step, reply) = acp_steer(&mut p, "over", "ok");
        assert!(reply.is_err() && step.events.is_empty());
    }

    #[test]
    fn opencode_steers_live_and_finishes_when_both_prompts_answer() {
        let mut p = Protocol::new(config("opencode"));
        p.remote_id = "ses_e9bb8a9f5ffeWeueZ0ePLK1srM".into();
        p.phase = 1;
        let (step, reply) = acp_steer(&mut p, "live", "The codeword is BANANA.");
        assert_eq!(reply.unwrap(), json!({"steered":true,"id":"live","mode":"live"}));
        assert_eq!(step.write[0]["method"], "session/prompt");
        assert_eq!(step.write[0]["params"]["prompt"][0]["text"], "The codeword is BANANA.");
        let request = step.write[0]["id"].as_u64().unwrap();
        assert!(STEER_IDS.contains(&request));
        let statuses: Vec<_> = steer_statuses(&step).into_iter().map(|(_, status, _)| status).collect();
        assert_eq!(statuses, ["pending", "delivered"]);
        // Recorded from OpenCode 1.19.0: both requests answer together at turn end.
        let usage = json!({"inputTokens":113,"outputTokens":4,"totalTokens":23054,"thoughtTokens":25,"cachedReadTokens":22912});
        let first = p.receive(json!({"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn","usage":usage,"_meta":{}}})).unwrap();
        assert!(!first.done, "the live steer is still open");
        let (step, reply) = acp_steer(&mut p, "late", "one more");
        assert!(step.write.is_empty(), "after the turn answered, a steer waits for the next turn");
        assert_eq!(reply.unwrap()["mode"], "next-turn");
        let second = p.receive(json!({"jsonrpc":"2.0","id":request,"result":{"stopReason":"end_turn","usage":usage,"_meta":{}}})).unwrap();
        assert!(!second.done);
        assert_eq!(second.write[0]["params"]["prompt"][0]["text"], "one more");
        assert!(p.receive(json!({"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn","_meta":{}}})).unwrap().done);

        // A refused live steer never fails the run; it goes with the next turn instead.
        let mut p = Protocol::new(config("opencode"));
        p.remote_id = "s".into();
        p.phase = 1;
        let request = acp_steer(&mut p, "busy", "retry me").0.write[0]["id"].clone();
        let step = p.receive(json!({"jsonrpc":"2.0","id":request,"error":{"code":-32603,"message":"busy"}})).unwrap();
        assert!(!step.done);
        let step = p.receive(json!({"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}})).unwrap();
        assert!(!step.done);
        assert_eq!(step.write[0]["params"]["prompt"][0]["text"], "retry me");
    }
}
