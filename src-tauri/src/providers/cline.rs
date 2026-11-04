//! Cline (`cline --acp`) over the shared ACP transport. Cline keeps its own
//! sign-in (`cline auth`, or `CLINE_API_KEY` in the environment). Its ACP
//! session modes are Plan and Act; approvals arrive as permission requests, and
//! the reasoning effort is a launch flag because Cline has no ACP option for it.
use super::*;

/// Shown when Cline has no stored sign-in and no `CLINE_API_KEY`.
pub(super) const SIGN_IN: &str = "Cline is not signed in. Run `cline auth` in a terminal, then send again.";

/// The efforts `cline --thinking` accepts, least to most.
pub(super) const EFFORTS: [&str; 5] = ["none", "low", "medium", "high", "xhigh"];

const MCP_SETTINGS_ENV: &str = "CLINE_MCP_SETTINGS_PATH";
const MCP_SETTINGS_DIR: &str = "cline-mcp";
const MCP_SETTINGS_FILE: &str = "cline_mcp_settings.json";
const MCP_SETTINGS_FAILED: &str = "Could not prepare the PandaCode tools connection for Cline.";

pub(super) fn configure(command: &mut Command, config: &RunConfig) {
    configure_environment(command);
    if !config.model.is_empty() && config.model != "default" {
        command.env("CLINE_MODEL", &config.model);
    }
    command.arg("--acp");
    if let Some(effort) = &config.reasoning_effort {
        command.args(["--thinking", effort]);
    }
    // Full access skips Cline's per-tool prompts; every other mode keeps them so
    // PandaCode decides (and Plan declines edits).
    command.args(["--auto-approve", if config.mode == "full" { "true" } else { "false" }]);
}

/// Cline's ACP server ignores `mcpServers` and advertises no HTTP MCP (3.0.74), but it
/// reads its servers from the file `CLINE_MCP_SETTINGS_PATH` names. A run's tools go in a
/// private copy of the user's settings, so their own file is never touched. The returned
/// folder is removed when dropped; `sweep_mcp_settings` clears what a crash left behind.
pub(super) fn mcp_settings(command: &mut Command, server: &Value) -> Result<AgentTemp, String> {
    let root = crate::secret_store::dir().ok_or(MCP_SETTINGS_FAILED)?.join(MCP_SETTINGS_DIR);
    let (name, entry) = loopback_entry(server).ok_or(MCP_SETTINGS_FAILED)?;
    let user = user_mcp_settings_path(command).and_then(|path| std::fs::read_to_string(path).ok());
    let folder = write_mcp_settings(&root, &merged_mcp_settings(user.as_deref(), &name, entry)).ok_or(MCP_SETTINGS_FAILED)?;
    command.env(MCP_SETTINGS_ENV, launch::external_path(&folder.0.join(MCP_SETTINGS_FILE)));
    Ok(folder)
}

pub(super) fn sweep_mcp_settings(data: &Path) {
    AgentTemp::sweep(&data.join(MCP_SETTINGS_DIR));
}

/// Cline's entry for PandaCode's tools server, only for the loopback host it always binds.
fn loopback_entry(server: &Value) -> Option<(String, Value)> {
    let url = server["url"].as_str()?;
    url.strip_prefix("http://127.0.0.1:")?.strip_suffix("/mcp")?.parse::<u16>().ok()?;
    let headers: serde_json::Map<String, Value> = server["headers"].as_array()?.iter()
        .filter_map(|header| Some((header["name"].as_str()?.to_string(), header["value"].clone())))
        .collect();
    Some((server["name"].as_str()?.to_string(), json!({"transport":{"type":"streamableHttp","url":url,"headers":headers}})))
}

/// The user's settings with PandaCode's server over them. A file that can't be read as
/// settings counts as empty: their mistake must not stop the run or reach its errors.
fn merged_mcp_settings(user: Option<&str>, name: &str, entry: Value) -> Value {
    let mut settings = user.and_then(|text| serde_json::from_str::<Value>(text).ok()).filter(Value::is_object).unwrap_or_else(|| json!({}));
    if !settings["mcpServers"].is_object() { settings["mcpServers"] = json!({}); }
    settings["mcpServers"][name] = entry;
    settings
}

/// Where Cline itself looks, under the environment this run will have.
fn user_mcp_settings_path(command: &Command) -> Option<PathBuf> {
    let variable = |name: &str| -> Option<PathBuf> {
        let set = command.as_std().get_envs().find(|(key, _)| *key == name).map(|(_, value)| value.map(ToOwned::to_owned));
        set.unwrap_or_else(|| std::env::var_os(name)).filter(|value| !value.to_string_lossy().trim().is_empty()).map(PathBuf::from)
    };
    if let Some(path) = variable(MCP_SETTINGS_ENV) { return Some(path); }
    let data = variable("CLINE_DATA_DIR")
        .or_else(|| variable("CLINE_DIR").map(|dir| dir.join("data")))
        .or_else(|| Some(crate::agent_usage_providers::home()?.join(".cline/data")))?;
    Some(data.join("settings").join("cline_mcp_settings.json"))
}

fn write_mcp_settings(root: &Path, settings: &Value) -> Option<AgentTemp> {
    use std::io::Write;
    let folder = AgentTemp::create_in(root)?;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut file = options.open(folder.0.join(MCP_SETTINGS_FILE)).ok()?;
    file.write_all(settings.to_string().as_bytes()).ok()?;
    Some(folder)
}

/// The PandaCode tool a Cline permission request names, from its `server__tool: input` title.
pub(super) fn host_tool(title: &str) -> Option<&str> {
    title.strip_prefix("pandacode_architect__")?.split(':').next()
}

/// Cline's ACP prompt keeps only text blocks, but its `read_files` tool opens
/// images, so a screenshot is passed by path. Images precede the prompt text.
pub(super) fn image_reference(path: &Path) -> String {
    format!("Attached image: {} (open it with read_files to see it).\n\n", path.display())
}

/// Cline asks before every tool, even reads. Reads and searches are answered
/// here as Standard mode would; Plan also allows fetches and declines changes to files. `None` leaves
/// the request to the shared approval path.
pub(super) fn permission(mode: &str, kind: &str) -> Option<&'static str> {
    match kind {
        "read" | "search" => Some("allow_once"),
        "fetch" if mode == "plan" => Some("allow_once"),
        "edit" | "delete" | "move" if mode == "plan" => Some("reject_once"),
        _ => None,
    }
}

/// Reads Cline's stored provider and API credentials from ~/.cline when
/// not already provided by the environment. Cline CLI's ACP mode expects
/// `CLINE_API_KEY` and `CLINE_PROVIDER` to be set when using API-key providers
/// (like OpenRouter, Anthropic, OpenAI, etc.) rather than hosted Cline OAuth.
pub(super) fn configure_environment(command: &mut Command) {
    let existing_key = std::env::var("CLINE_API_KEY")
        .ok()
        .filter(|s| !s.trim().is_empty());
    if existing_key.is_some() {
        return;
    }
    let Some(home) = crate::agent_usage_providers::home() else {
        return;
    };
    if let Some((provider, key, model)) = detect_credentials(&home) {
        if let Some(key) = key {
            command.env("CLINE_API_KEY", key);
        }
        if let Some(provider) = provider {
            let existing_provider = std::env::var("CLINE_PROVIDER")
                .ok()
                .filter(|s| !s.trim().is_empty());
            if existing_provider.is_none() {
                command.env("CLINE_PROVIDER", provider);
            }
        }
        if let Some(model) = model {
            let existing_model = std::env::var("CLINE_MODEL")
                .ok()
                .filter(|s| !s.trim().is_empty());
            if existing_model.is_none() {
                command.env("CLINE_MODEL", model);
            }
        }
    }
}

fn provider_from_secret_key(key: &str) -> Option<&'static str> {
    let normalized = key.replace(['-', '_'], "").to_lowercase();
    if normalized.contains("openrouter") {
        Some("openrouter")
    } else if normalized.contains("anthropic") {
        Some("anthropic")
    } else if normalized.contains("openai") {
        Some("openai")
    } else if normalized.contains("gemini") {
        Some("gemini")
    } else if normalized.contains("deepseek") {
        Some("deepseek")
    } else if normalized.contains("groq") {
        Some("groq")
    } else if normalized.contains("mistral") {
        Some("mistral")
    } else if normalized.contains("together") {
        Some("together")
    } else if normalized.contains("qwen") {
        Some("qwen")
    } else if normalized.contains("cline") {
        Some("cline")
    } else {
        None
    }
}

fn env_key_for_provider(provider: &str) -> Option<String> {
    let var_name = match provider {
        "openrouter" => "OPENROUTER_API_KEY",
        "anthropic" => "ANTHROPIC_API_KEY",
        "openai" => "OPENAI_API_KEY",
        "gemini" => "GEMINI_API_KEY",
        "deepseek" => "DEEPSEEK_API_KEY",
        "groq" => "GROQ_API_KEY",
        "mistral" => "MISTRAL_API_KEY",
        _ => return None,
    };
    std::env::var(var_name).ok().filter(|s| !s.trim().is_empty())
}

fn detect_credentials(home: &Path) -> Option<(Option<String>, Option<String>, Option<String>)> {
    let providers_path = home.join(".cline/data/settings/providers.json");
    let providers_val: Option<Value> = std::fs::read_to_string(&providers_path)
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok());

    let global_state_path = home.join(".cline/data/globalState.json");
    let global_state_val: Option<Value> = std::fs::read_to_string(&global_state_path)
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok());

    let secrets_path = home.join(".cline/data/secrets.json");
    let secrets_val: Option<Value> = std::fs::read_to_string(&secrets_path)
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok());

    let mut provider = providers_val
        .as_ref()
        .and_then(|v| v.get("lastUsedProvider"))
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .map(str::to_owned)
        .or_else(|| {
            global_state_val.as_ref().and_then(|v| {
                v.get("actModeApiProvider")
                    .or_else(|| v.get("planModeApiProvider"))
                    .or_else(|| v.get("apiProvider"))
                    .and_then(Value::as_str)
                    .filter(|s| !s.trim().is_empty())
                    .map(str::to_owned)
            })
        });

    let mut key = None;
    let mut model = None;

    if let Some(ref p) = provider {
        if let Some(settings) = providers_val
            .as_ref()
            .and_then(|v| v.get("providers"))
            .and_then(|entry| entry.get(p))
            .and_then(|entry| entry.get("settings"))
        {
            if let Some(k) = settings
                .get("apiKey")
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
            {
                key = Some(k.to_string());
            }
            if let Some(m) = settings
                .get("model")
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
            {
                model = Some(m.to_string());
            }
        }
    }

    if key.is_none() {
        if let Some(obj) = secrets_val.as_ref().and_then(Value::as_object) {
            if let Some(ref p) = provider {
                let target = format!("{}apikey", p.replace(['-', '_'], "").to_lowercase());
                for (k, v) in obj {
                    if k.replace(['-', '_'], "").to_lowercase() == target {
                        if let Some(val) = v.as_str().filter(|s| !s.trim().is_empty()) {
                            key = Some(val.to_string());
                            break;
                        }
                    }
                }
            }
        }
    }

    if key.is_none() {
        if let Some(ref p) = provider {
            if let Some(k) = env_key_for_provider(p) {
                key = Some(k);
            }
        }
    }

    if key.is_none() {
        if let Some(providers_map) = providers_val
            .as_ref()
            .and_then(|v| v.get("providers"))
            .and_then(Value::as_object)
        {
            for (p_name, p_entry) in providers_map {
                if let Some(settings) = p_entry.get("settings") {
                    if let Some(k) = settings
                        .get("apiKey")
                        .and_then(Value::as_str)
                        .filter(|s| !s.trim().is_empty())
                    {
                        provider = Some(p_name.clone());
                        key = Some(k.to_string());
                        model = settings
                            .get("model")
                            .and_then(Value::as_str)
                            .filter(|s| !s.trim().is_empty())
                            .map(str::to_owned)
                            .or(model);
                        break;
                    }
                }
            }
        }
    }

    if key.is_none() {
        if let Some(obj) = secrets_val.as_ref().and_then(Value::as_object) {
            for (k, v) in obj {
                if let Some(val) = v.as_str().filter(|s| !s.trim().is_empty()) {
                    if let Some(inferred_provider) = provider_from_secret_key(k) {
                        provider = Some(inferred_provider.to_string());
                        key = Some(val.to_string());
                        if let Some(p_model) = providers_val
                            .as_ref()
                            .and_then(|v| v.get("providers"))
                            .and_then(|entries| entries.get(inferred_provider))
                            .and_then(|entry| entry.get("settings"))
                            .and_then(|s| s.get("model"))
                            .and_then(Value::as_str)
                            .filter(|s| !s.trim().is_empty())
                        {
                            model = Some(p_model.to_string());
                        }
                        break;
                    }
                }
            }
        }
    }

    if key.is_none() {
        for candidate_provider in ["openrouter", "anthropic", "openai", "gemini", "deepseek"] {
            if let Some(k) = env_key_for_provider(candidate_provider) {
                provider = Some(candidate_provider.to_string());
                key = Some(k);
                break;
            }
        }
    }

    if model.is_none() {
        if let Some(ref gv) = global_state_val {
            model = gv
                .get("actModeOpenRouterModelId")
                .or_else(|| gv.get("planModeOpenRouterModelId"))
                .or_else(|| gv.get("actModeModelId"))
                .or_else(|| gv.get("planModeModelId"))
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .map(str::to_owned);
        }
    }

    if provider.is_some() || key.is_some() || model.is_some() {
        Some((provider, key, model))
    } else {
        None
    }
}

/// Models come from `session/new` (no prompt, no inference); every model gets
/// Cline's `--thinking` levels, with the CLI default left unset.
pub(super) async fn models(path: &Path) -> Result<Vec<ModelInfo>, String> {
    let models = if let Some(models) = acp_catalog::get("cline", path) {
        models
    } else {
        let _refresh = acp_catalog::refresh_lock("cline", path).await;
        if let Some(models) = acp_catalog::get("cline", path) {
            models
        } else {
            let discovery = acp_catalog::begin("cline", path);
            let mut command = super::provider_command("cline", path)?;
            configure_environment(&mut command);
            command.arg("--acp");
            let (metadata, _) = acp::inspect(command, &std::env::temp_dir(), false)
                .await
                .map_err(|error| {
                    if error.contains("Authentication is required")
                        || error.contains("Call authenticate")
                        || error.contains("code: -32000")
                    {
                        SIGN_IN.to_owned()
                    } else {
                        error
                    }
                })?;
            acp_catalog::store(discovery, &metadata);
            acp::parse_models(&metadata)
        }
    };
    Ok(with_efforts(models))
}

fn with_efforts(models: Vec<ModelInfo>) -> Vec<ModelInfo> {
    models
        .into_iter()
        .map(|model| ModelInfo { reasoning_efforts: EFFORTS.iter().map(|id| effort_info(id, None)).collect(), ..model })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const INITIALIZE: &str = r#"{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentCapabilities":{"loadSession":true,"promptCapabilities":{"image":true,"audio":false,"embeddedContext":false}},"agentInfo":{"name":"cline","version":"3.0.73"},"authMethods":[{"id":"cline","name":"Sign in with Cline"},{"id":"cline-pass","name":"Sign in with ClinePass"},{"id":"openai-codex","name":"Sign in with ChatGPT Subscription"}]}}"#;

    /// Recorded from `cline --acp` 3.0.73 `session/new` (model list shortened).
    fn session() -> Value {
        json!({"sessionId":"1792719287191_NBdt7_cli",
            "modes":{"availableModes":[{"id":"plan","name":"Plan","description":"Explore the codebase and plan changes without modifying files"},{"id":"act","name":"Act","description":"Make changes to the codebase"}],"currentModeId":"act"},
            "models":{"availableModels":[{"modelId":"anthropic/claude-sonnet-5.5","name":"Claude Sonnet 5.5"},{"modelId":"anthropic/claude-opus-5.5","name":"Claude Opus 5.5"}],"currentModelId":"anthropic/claude-sonnet-5.5"},
            "configOptions":[
                {"type":"select","id":"provider","name":"Provider","description":"The authentication provider to use","category":"model","currentValue":"cline","options":[{"value":"cline","name":"Cline Usage-Billing"},{"value":"cline-pass","name":"ClinePass"},{"value":"openai-codex","name":"OpenAI ChatGPT Subscription"}]},
                {"type":"select","id":"model","name":"Model","category":"model","currentValue":"anthropic/claude-sonnet-5.5","options":[{"value":"anthropic/claude-sonnet-5.5","name":"Claude Sonnet 5.5"},{"value":"anthropic/claude-opus-5.5","name":"Claude Opus 5.5"}]},
                {"type":"select","id":"mode","name":"Session Mode","description":"Controls whether the agent can modify files","category":"mode","currentValue":"act","options":[{"value":"plan","name":"Plan","description":"Explore the codebase and plan changes without modifying files"},{"value":"act","name":"Act","description":"Make changes to the codebase"}]},
                {"type":"boolean","id":"auto_approve","name":"Auto-approve tools","description":"Automatically approve all tool calls without asking for permission","currentValue":false}]})
    }

    fn ready(mode: &str, model: &str, effort: Option<&str>) -> (Protocol, Vec<Value>) {
        let mut cfg = super::super::tests::config("cline");
        cfg.mode = mode.into();
        cfg.model = model.into();
        cfg.reasoning_effort = effort.map(str::to_owned);
        let mut p = Protocol::new(cfg);
        let mut writes = p.receive(serde_json::from_str(INITIALIZE).unwrap()).unwrap().write;
        assert_eq!(writes[0]["method"], "session/new");
        writes.extend(p.receive(json!({"jsonrpc":"2.0","id":2,"result":session()})).unwrap().write);
        (p, writes)
    }

    /// Recorded from `cline --acp` 3.0.73 with an empty config directory.
    #[test]
    fn a_session_without_sign_in_names_the_auth_command() {
        let mut p = Protocol::new(super::super::tests::config("cline"));
        p.receive(serde_json::from_str(INITIALIZE).unwrap()).unwrap();
        let error = p.receive(json!({"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":"Authentication required: Call authenticate before starting a session"}})).err().unwrap();
        assert_eq!(error, SIGN_IN);
    }

    #[test]
    fn cline_without_http_mcp_starts_normal_session_but_rejects_required_tools() {
        for required in [false, true] {
            let mut p = Protocol::new(super::super::tests::config("cline"));
            p.mcp_server = Some(json!({"type":"http","name":"pandacode_architect"}));
            p.mcp_required = required;
            let result = p.receive(serde_json::from_str(INITIALIZE).unwrap());
            if required {
                assert!(result.err().unwrap().contains("HTTP MCP"));
            } else {
                let step = result.unwrap();
                assert_eq!(step.write[0]["method"], "session/new");
                assert_eq!(step.write[0]["params"]["mcpServers"], json!([]));
                assert!(p.mcp_server.is_none());
            }
        }
    }

    #[test]
    fn plan_and_act_follow_the_approval_choice() {
        for (mode, expected) in [("ask", "act"), ("auto", "act"), ("plan", "plan"), ("full", "act")] {
            let (mut p, writes) = ready(mode, "default", None);
            let set = &writes[1];
            assert_eq!(set["method"], "session/set_config_option", "{mode}");
            assert_eq!((set["params"]["configId"].clone(), set["params"]["value"].clone()), (json!("mode"), json!(expected)), "{mode}");
            let prompt = p.receive(json!({"jsonrpc":"2.0","id":4,"result":{"configOptions":session()["configOptions"]}})).unwrap().write.remove(0);
            assert_eq!(prompt["method"], "session/prompt");
        }
    }

    #[test]
    fn model_is_set_and_effort_rides_on_the_launch_flag() {
        let (mut p, writes) = ready("ask", "anthropic/claude-opus-5.5", Some("high"));
        assert_eq!(writes[1]["params"]["configId"], "mode");
        let set = p.receive(json!({"jsonrpc":"2.0","id":4,"result":{}})).unwrap().write.remove(0);
        assert_eq!((set["params"]["configId"].clone(), set["params"]["value"].clone()), (json!("model"), json!("anthropic/claude-opus-5.5")));
        let prompt = p.receive(json!({"jsonrpc":"2.0","id":5,"result":{}})).unwrap().write.remove(0);
        assert_eq!(prompt["method"], "session/prompt");

        let mut cfg = super::super::tests::config("cline");
        cfg.mode = "full".into();
        cfg.reasoning_effort = Some("xhigh".into());
        let mut command = Command::new("cline");
        configure(&mut command, &cfg);
        let args: Vec<_> = command.as_std().get_args().map(|arg| arg.to_string_lossy().into_owned()).collect();
        assert_eq!(args, ["--acp", "--thinking", "xhigh", "--auto-approve", "true"]);
    }

    #[test]
    fn recorded_catalog_lists_models_with_thinking_levels() {
        let models = with_efforts(acp::parse_models(&session()));
        assert_eq!(models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["default", "anthropic/claude-sonnet-5.5", "anthropic/claude-opus-5.5"]);
        assert_eq!(models[2].reasoning_efforts.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(), EFFORTS);
        for effort in EFFORTS {
            assert!(validate_reasoning_effort("cline", Some(effort)).is_ok());
        }
    }

    /// Cline's recorded permission options and tool kinds.
    fn permission_step(p: &mut Protocol, kind: &str) -> Step {
        p.receive(json!({"jsonrpc":"2.0","id":9,"method":"session/request_permission","params":{"sessionId":"1792719287191_NBdt7_cli",
            "toolCall":{"toolCallId":"c1","title":"editor: a.txt","kind":kind,"status":"pending"},
            "options":[{"optionId":"allow_once","name":"Allow once","kind":"allow_once"},{"optionId":"allow_always","name":"Allow always","kind":"allow_always"},{"optionId":"reject_once","name":"Reject","kind":"reject_once"}]}})).unwrap()
    }

    #[test]
    fn permissions_follow_the_task_mode() {
        let outcome = |step: &Step| step.write.first().map(|w| w["result"]["outcome"]["optionId"].clone());
        for (mode, kind, expected) in [
            ("ask", "read", Some(json!("allow_once"))),
            ("plan", "search", Some(json!("allow_once"))),
            ("plan", "edit", Some(json!("reject_once"))),
            ("plan", "fetch", Some(json!("allow_once"))),
            ("ask", "fetch", None),
            ("auto", "edit", Some(json!("allow_once"))),
            ("full", "execute", Some(json!("allow_once"))),
            ("ask", "edit", None),
            ("auto", "execute", None),
            ("plan", "execute", None),
        ] {
            let (mut p, _) = ready(mode, "default", None);
            let step = permission_step(&mut p, kind);
            assert_eq!(outcome(&step), expected, "{mode} {kind}");
            if expected.is_none() {
                assert!(step.events.iter().any(|e| e.kind == "approval"), "{mode} {kind}");
            }
        }
    }

    #[test]
    fn a_resumed_task_loads_its_saved_session() {
        let mut cfg = super::super::tests::config("cline");
        cfg.resume_id = Some("1792719287191_NBdt7_cli".into());
        let mut p = Protocol::new(cfg);
        let request = p.receive(serde_json::from_str(INITIALIZE).unwrap()).unwrap().write.remove(0);
        assert_eq!(request["method"], "session/load");
        assert_eq!(request["params"]["sessionId"], "1792719287191_NBdt7_cli");
        let mut loaded = session();
        loaded.as_object_mut().unwrap().remove("sessionId");
        let saved = p.receive(json!({"jsonrpc":"2.0","id":2,"result":loaded})).unwrap().events;
        assert_eq!(saved.iter().find(|e| e.kind == "session").unwrap().text, "1792719287191_NBdt7_cli");
    }

    #[test]
    fn images_become_path_references() {
        assert_eq!(image_reference(Path::new("/tmp/a.png")), "Attached image: /tmp/a.png (open it with read_files to see it).\n\n");
    }

    #[test]
    fn detects_credentials_from_providers_and_secrets_json() {
        let home = std::env::temp_dir().join(format!("cline-creds-test-{}", uuid::Uuid::new_v4()));
        let settings = home.join(".cline/data/settings");
        std::fs::create_dir_all(&settings).unwrap();
        std::fs::write(
            settings.join("providers.json"),
            r#"{"lastUsedProvider":"openrouter","providers":{"openrouter":{"settings":{"provider":"openrouter","apiKey":"sk-direct","model":"recursive/flint"}}}}"#,
        )
        .unwrap();
        assert_eq!(
            detect_credentials(&home),
            Some((
                Some("openrouter".into()),
                Some("sk-direct".into()),
                Some("recursive/flint".into())
            ))
        );

        // Fallback to secrets.json when apiKey is omitted in settings
        std::fs::write(
            settings.join("providers.json"),
            r#"{"lastUsedProvider":"anthropic","providers":{"anthropic":{"settings":{"model":"claude-3-5"}}}}"#,
        )
        .unwrap();
        std::fs::write(
            home.join(".cline/data/secrets.json"),
            r#"{"anthropicApiKey":"sk-ant-secret"}"#,
        )
        .unwrap();
        assert_eq!(
            detect_credentials(&home),
            Some((
                Some("anthropic".into()),
                Some("sk-ant-secret".into()),
                Some("claude-3-5".into())
            ))
        );

        // Fallback to globalState.json + secrets.json when providers.json is missing
        std::fs::remove_file(settings.join("providers.json")).unwrap();
        std::fs::write(
            home.join(".cline/data/globalState.json"),
            r#"{"actModeApiProvider":"openai","actModeModelId":"gpt-4o"}"#,
        )
        .unwrap();
        std::fs::write(
            home.join(".cline/data/secrets.json"),
            r#"{"openAiApiKey":"sk-openai-key"}"#,
        )
        .unwrap();
        assert_eq!(
            detect_credentials(&home),
            Some((
                Some("openai".into()),
                Some("sk-openai-key".into()),
                Some("gpt-4o".into())
            ))
        );

        // Fallback to another provider in providers.json if lastUsedProvider has no key
        std::fs::write(
            settings.join("providers.json"),
            r#"{"lastUsedProvider":"sapaicore","providers":{"sapaicore":{"settings":{"model":"claude"}},"openrouter":{"settings":{"apiKey":"sk-or-found","model":"qwen"}}}}"#,
        )
        .unwrap();
        assert_eq!(
            detect_credentials(&home),
            Some((
                Some("openrouter".into()),
                Some("sk-or-found".into()),
                Some("qwen".into())
            ))
        );

        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn mcp_settings_keep_the_users_servers_and_win_a_name_clash() {
        let entry = json!({"transport":{"type":"streamableHttp","url":"http://127.0.0.1:9/mcp"}});
        let user = r#"{"theme":"x","mcpServers":{"mine":{"command":"run-me"},"pandacode_architect":{"command":"impostor"}}}"#;
        let merged = merged_mcp_settings(Some(user), "pandacode_architect", entry.clone());
        assert_eq!(merged["theme"], "x");
        assert_eq!(merged["mcpServers"]["mine"]["command"], "run-me");
        assert_eq!(merged["mcpServers"]["pandacode_architect"], entry);
    }

    #[test]
    fn malformed_user_mcp_settings_count_as_empty() {
        let entry = json!({"transport":{}});
        for user in [None, Some("{ not json SECRET"), Some("[1]"), Some(r#"{"mcpServers":[1]}"#)] {
            let merged = merged_mcp_settings(user, "pandacode_architect", entry.clone());
            assert_eq!(merged["mcpServers"], json!({"pandacode_architect":entry}), "{user:?}");
            assert!(!merged.to_string().contains("SECRET"));
        }
    }

    #[test]
    fn mcp_entry_is_loopback_only() {
        let server = |url: &str| json!({"type":"http","name":"pandacode_architect","url":url,"headers":[{"name":"Authorization","value":"Bearer t"}]});
        let (name, entry) = loopback_entry(&server("http://127.0.0.1:4310/mcp")).unwrap();
        assert_eq!(name, "pandacode_architect");
        assert_eq!(entry["transport"]["headers"]["Authorization"], "Bearer t");
        for url in ["http://example.com/mcp", "https://127.0.0.1:4310/mcp", "http://127.0.0.1:1@example.com/mcp", "http://127.0.0.1.example.com:1/mcp", "http://127.0.0.1:4310/other"] {
            assert!(loopback_entry(&server(url)).is_none(), "{url}");
        }
    }

    #[test]
    fn user_mcp_settings_path_follows_clines_own_lookup() {
        let mut command = Command::new("cline");
        command.env("CLINE_DIR", "/c").env("CLINE_DATA_DIR", "").env(MCP_SETTINGS_ENV, " ");
        assert_eq!(user_mcp_settings_path(&command).unwrap(), Path::new("/c/data/settings/cline_mcp_settings.json"));
        command.env("CLINE_DATA_DIR", "/d");
        assert_eq!(user_mcp_settings_path(&command).unwrap(), Path::new("/d/settings/cline_mcp_settings.json"));
        command.env(MCP_SETTINGS_ENV, "/e.json");
        assert_eq!(user_mcp_settings_path(&command).unwrap(), Path::new("/e.json"));
    }

    #[test]
    fn mcp_settings_file_is_private_and_removed_on_drop() {
        let root = std::env::temp_dir().join(format!("cline-mcp-test-{}", uuid::Uuid::new_v4()));
        let folder = write_mcp_settings(&root, &json!({"mcpServers":{}})).unwrap();
        let (directory, file) = (folder.0.clone(), folder.0.join(MCP_SETTINGS_FILE));
        assert_eq!(std::fs::read_to_string(&file).unwrap(), r#"{"mcpServers":{}}"#);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
            assert_eq!(std::fs::metadata(&directory).unwrap().permissions().mode() & 0o777, 0o700);
            assert_eq!(std::fs::metadata(&root).unwrap().permissions().mode() & 0o777, 0o700);
        }
        drop(folder);
        for _ in 0..50 {
            if !directory.exists() { break; }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(!directory.exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn the_token_reaches_cline_only_through_the_settings_file() {
        crate::secret_store::setup(&std::env::temp_dir().join(format!("cline-mcp-setup-{}", uuid::Uuid::new_v4())));
        let token = "Bearer token-7741";
        let server = json!({"type":"http","name":"pandacode_architect","url":"http://127.0.0.1:4310/mcp","headers":[{"name":"Authorization","value":token}]});
        let mut command = Command::new("cline");
        command.env(MCP_SETTINGS_ENV, "/nonexistent/settings.json");
        let folder = mcp_settings(&mut command, &server).unwrap();
        let std_command = command.as_std();
        assert!(std_command.get_args().all(|arg| !arg.to_string_lossy().contains("token-7741")));
        assert!(std_command.get_envs().all(|(_, value)| !value.is_some_and(|value| value.to_string_lossy().contains("token-7741"))));
        let path = std_command.get_envs().find(|(key, _)| *key == MCP_SETTINGS_ENV).and_then(|(_, value)| value).unwrap();
        assert!(Path::new(path).starts_with(&folder.0));
        let written: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        assert_eq!(written["mcpServers"]["pandacode_architect"]["transport"]["headers"]["Authorization"], token);
        // A server that is not the loopback host gets no file and leaves the command alone.
        let mut command = Command::new("cline");
        let remote = json!({"name":"pandacode_architect","url":"http://example.com/mcp","headers":[]});
        assert_eq!(mcp_settings(&mut command, &remote).err().unwrap(), MCP_SETTINGS_FAILED);
        assert_eq!(command.as_std().get_envs().count(), 0);
    }

    #[test]
    fn a_host_tool_shows_one_row_from_the_host_not_a_second_from_cline() {
        let update = |title: &str| json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"tool_call","toolCallId":title,"title":title,"status":"in_progress","rawInput":{}}}});
        let mut p = Protocol::new(super::super::tests::config("cline"));
        p.remote_id = "s".into();
        p.phase = 1;
        p.mcp_tool_names.insert("pandacode_probe".into());
        let rows = |step: Step| step.events.iter().filter(|event| event.tool.is_some()).count();
        assert_eq!(rows(p.receive(update("pandacode_architect__pandacode_probe: {}")).unwrap()), 0);
        assert_eq!(rows(p.receive(update("other__pandacode_probe: {}")).unwrap()), 1);
    }

    #[test]
    fn permission_titles_name_host_tools_only_for_pandacode() {
        assert_eq!(host_tool(r#"pandacode_architect__pandacode_title: {"title":"a:b"}"#), Some("pandacode_title"));
        assert_eq!(host_tool("other__pandacode_title: {}"), None);
        assert_eq!(host_tool("run_commands: {}"), None);
    }

    #[test]
    fn registered_self_scoped_tools_skip_the_prompt_and_others_keep_it() {
        let permission = |title: &str| json!({"jsonrpc":"2.0","id":9,"method":"session/request_permission","params":{"sessionId":"s","toolCall":{"toolCallId":"c","title":title,"kind":"other"},"options":[{"optionId":"y","kind":"allow_once"},{"optionId":"n","kind":"reject_once"}]}});
        let mut p = Protocol::new(super::super::tests::config("cline"));
        p.remote_id = "s".into();
        p.mcp_tool_names.insert("pandacode_title".into());
        p.mcp_tool_names.insert("pandacode_run_project".into());
        let step = p.receive(permission("pandacode_architect__pandacode_title: {}")).unwrap();
        assert_eq!(step.write[0]["result"]["outcome"]["optionId"], "y");
        for title in ["pandacode_architect__pandacode_run_project: {}", "other__pandacode_title: {}"] {
            assert!(p.receive(permission(title)).unwrap().write.is_empty(), "{title} must wait for the user");
        }
        // Not registered for this run: the host would refuse it, so it never skips the prompt.
        let mut p = Protocol::new(super::super::tests::config("cline"));
        p.remote_id = "s".into();
        assert!(p.receive(permission("pandacode_architect__pandacode_title: {}")).unwrap().write.is_empty());
    }

    /// The gate for this route: Cline lists a tool from the real host and calls reach it.
    /// Sends one short prompt on a free model. PANDACODE_CLINE_LIVE_MODEL overrides it.
    #[tokio::test]
    #[ignore = "needs the Cline CLI and a sign-in; sends one short prompt"]
    async fn live_cline_calls_pandacode_tools_through_the_real_host() {
        super::super::widen_process_path();
        let root = std::env::temp_dir().join(format!("cline-live-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        crate::secret_store::setup(&root);
        let path = executable("cline").expect("Install Cline first");
        let calls = Arc::new(Mutex::new(Vec::<String>::new()));
        let seen = calls.clone();
        let host = ToolHost {
            tools: ["pandacode_title", "pandacode_probe"].iter().map(|name| json!({"type":"function","name":name,"description":"Call this once with a short text.","inputSchema":{"type":"object","properties":{"title":{"type":"string"}},"required":["title"]}})).collect(),
            approval_tools: Default::default(),
            handler: Arc::new(move |name, _| {
                seen.lock().unwrap().push(name);
                Box::pin(async { Ok(json!({"content":[{"type":"text","text":"HOST-OK-7741"}]})) })
            }),
        };
        let mut cfg = super::super::tests::config("cline");
        cfg.session_id = "cline-live-tools".into();
        cfg.model = std::env::var("PANDACODE_CLINE_LIVE_MODEL").unwrap_or_else(|_| "recursive/flint-v1.0:free".into());
        cfg.mode = "ask".into();
        cfg.cwd = root.clone();
        cfg.prompt = "Call the tool whose name ends in pandacode_title with title \"probe\", then the tool whose name ends in pandacode_probe with title \"probe\". Then reply with what they returned.".into();
        let mut command = crate::providers::provider_command("cline", &path).unwrap();
        super::super::configure_command(&mut command, &cfg);
        // The free model is on the signed-in account, whatever provider this machine last used.
        command.env_remove("CLINE_PROVIDER").env_remove("CLINE_API_KEY");
        let (sender, receiver) = tokio::sync::mpsc::unbounded_channel();
        let events = Arc::new(Mutex::new(Vec::<String>::new()));
        let log = events.clone();
        let sink: Sink = Arc::new(move |event| {
            if event.kind == "approval" {
                println!("approval requested: {}", event.text);
                if let Some(request_id) = event.request_id.clone() {
                    let _ = sender.send(RunInput::Approval { request_id, approved: true });
                }
            }
            if let Some(tool) = &event.tool { println!("tool row: {} {}", tool.name, tool.status); }
            log.lock().unwrap().push(event.text);
        });
        let run = run_process_with_tools(cfg, sink, receiver, command, Vec::new(), Some(host));
        tokio::time::timeout(std::time::Duration::from_secs(150), run).await.expect("timed out").expect("run failed");
        let calls = calls.lock().unwrap().clone();
        println!("host calls: {calls:?}");
        assert!(calls.iter().any(|name| name == "pandacode_title"), "{calls:?}");
        assert!(calls.iter().any(|name| name == "pandacode_probe"), "{calls:?}");
        std::thread::sleep(std::time::Duration::from_millis(500));
        let left = std::fs::read_dir(root.join(MCP_SETTINGS_DIR)).unwrap().count();
        assert_eq!(left, 0, "the settings file must be gone after the run");
        assert!(!events.lock().unwrap().join("\n").contains("Bearer "));
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    #[ignore = "needs the Cline CLI and a sign-in; metadata only, never sends a prompt"]
    async fn live_cline_lists_models() {
        super::super::widen_process_path(); // as the app does at startup
        let path = executable("cline").expect("Install Cline first");
        let models = models(&path).await.unwrap();
        assert!(models.len() > 1, "{models:?}");
    }
}
