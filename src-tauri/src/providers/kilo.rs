//! Kilo Code (`kilo acp`) shares the ACP transport, with its own code/plan modes.
//! Credentials and connected model providers stay with the installed Kilo CLI.
use super::*;

pub(super) const SIGN_IN: &str = "Kilo Code requires sign-in. Run `kilo auth login` in a terminal, then send again.";

pub(super) fn mode_id(mode: &str) -> &'static str {
    if mode == "plan" { "plan" } else { "code" }
}

fn configuration(mode: &str, inherited: Option<&str>) -> String {
    let mut inline = inherited
        .and_then(|text| serde_json::from_str::<Value>(text).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    // Kilo requires an object for per-agent permissions. Keep every tool on the
    // ACP approval path except in Full access; the adapter applies finer modes.
    let policy = json!({"*": if mode == "full" { "allow" } else { "ask" }});
    inline["permission"] = policy.clone();
    // Kilo merges legacy modes into agents after loading inline configuration.
    for section in ["agent", "mode"] {
        if !inline[section].is_object() { inline[section] = json!({}); }
        for agent in ["code", "plan"] {
            if !inline[section][agent].is_object() { inline[section][agent] = json!({}); }
            inline[section][agent]["permission"] = policy.clone();
        }
    }
    inline.to_string()
}

pub(super) fn configure(command: &mut Command) {
    command.arg("acp");
}

/// Apply after named connections so their model/provider settings survive, but
/// their environment cannot weaken the task's explicitly selected permissions.
pub(super) fn configure_environment(command: &mut Command, config: &RunConfig) -> String {
    let inherited = command.as_std().get_envs()
        .find(|(key, _)| *key == "KILO_CONFIG_CONTENT")
        .map(|(_, value)| value.and_then(|value| value.to_str()).map(str::to_owned))
        .unwrap_or_else(|| std::env::var("KILO_CONFIG_CONTENT").ok());
    let inline = configuration(&config.mode, inherited.as_deref());
    command.env("KILO_CONFIG_CONTENT", &inline);
    // This variable is applied after inline configuration by Kilo.
    command.env_remove("KILO_PERMISSION");
    command.env("KILO_DISABLE_AUTOUPDATE", "true");
    inline
}

pub(super) fn permission(mode: &str, kind: &str) -> Option<&'static str> {
    match kind {
        "read" | "search" | "fetch" | "think" => Some("allow_once"),
        _ if mode == "plan" => Some("reject_once"),
        _ => None,
    }
}

/// The catalog is session metadata only: never send a prompt during discovery.
pub(super) async fn models(path: &Path) -> Result<Vec<ModelInfo>, String> {
    if let Some(models) = acp_catalog::get("kilo", path) { return Ok(models); }
    let _refresh = acp_catalog::refresh_lock("kilo", path).await;
    if let Some(models) = acp_catalog::get("kilo", path) { return Ok(models); }
    let discovery = acp_catalog::begin("kilo", path);
    let mut command = super::command(path)?;
    command.arg("acp").env("KILO_DISABLE_AUTOUPDATE", "true");
    let (metadata, _) = acp::inspect(command, &std::env::temp_dir(), false).await?;
    acp_catalog::store(discovery, &metadata);
    Ok(acp::parse_models(&metadata))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Recorded from `kilo acp` 7.3.41; catalog shortened, session ID anonymized.
    fn initialize() -> Value {
        json!({"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,
            "agentCapabilities":{"loadSession":true,"mcpCapabilities":{"http":true,"sse":true},"promptCapabilities":{"embeddedContext":true,"image":true},"sessionCapabilities":{"close":{},"fork":{},"list":{},"resume":{}}},
            "authMethods":[{"description":"Run `kilo auth login` in the terminal","name":"Login with Kilo","id":"kilo-login"}],"agentInfo":{"name":"Kilo","version":"7.3.41"}}})
    }

    fn session() -> Value {
        json!({"sessionId":"ses_kilo_test","configOptions":[
            {"id":"model","name":"Model","category":"model","type":"select","currentValue":"kilo/stealth/claude-sonnet-4.6","options":[
                {"value":"kilo/stealth/claude-sonnet-4.6","name":"Kilo Gateway/Stealth: Claude Sonnet 4.6 (20% off)"},
                {"value":"kilo/anthropic/claude-sonnet-4.6","name":"Kilo Gateway/Anthropic: Claude Sonnet 4.6"}]},
            {"id":"effort","name":"Effort","description":"Available effort levels for this model","category":"thought_level","type":"select","currentValue":"none","options":[
                {"value":"none","name":"None"},{"value":"low","name":"Low"},{"value":"medium","name":"Medium"},{"value":"high","name":"High"},{"value":"xhigh","name":"Xhigh"},{"value":"max","name":"Max"}]},
            {"id":"mode","name":"Session Mode","category":"mode","type":"select","currentValue":"code","options":[
                {"value":"code","name":"code"},{"value":"ask","name":"ask"},{"value":"debug","name":"debug"},{"value":"orchestrator","name":"orchestrator"},{"value":"plan","name":"plan"}]}],
            "models":{"currentModelId":"kilo/stealth/claude-sonnet-4.6","availableModels":[
                {"modelId":"kilo/stealth/claude-sonnet-4.6","name":"Kilo Gateway/Stealth: Claude Sonnet 4.6 (20% off)"},
                {"modelId":"kilo/anthropic/claude-sonnet-4.6","name":"Kilo Gateway/Anthropic: Claude Sonnet 4.6"}]},
            "modes":{"availableModes":[{"id":"code","name":"code"},{"id":"plan","name":"plan"}],"currentModeId":"code"},
            "_meta":{"opencode":{"modelId":"kilo/stealth/claude-sonnet-4.6","variant":null,"availableVariants":["none","low","medium","high","xhigh","max"]}}})
    }

    fn ready(mode: &str) -> (Protocol, Step) {
        let mut cfg = super::super::tests::config("kilo");
        cfg.mode = mode.into();
        let mut p = Protocol::new(cfg);
        let request = p.receive(initialize()).unwrap();
        assert_eq!(request.write[0]["method"], "session/new");
        let step = p.receive(json!({"jsonrpc":"2.0","id":2,"result":session()})).unwrap();
        (p, step)
    }

    #[test]
    fn recorded_modes_and_effort_wait_for_acknowledgements_before_prompting() {
        for mode in ["ask", "auto", "plan", "full"] {
            let (mut p, step) = ready(mode);
            assert_eq!(step.write[0]["method"], "session/set_config_option");
            assert_eq!(step.write[0]["params"]["value"], mode_id(mode));
            p.config.model = "kilo/stealth/claude-sonnet-4.6".into();
            p.config.reasoning_effort = Some("max".into());
            let model = p.receive(json!({"jsonrpc":"2.0","id":4,"result":{}})).unwrap();
            assert_eq!(model.write[0]["params"]["configId"], "model");
            assert_eq!(model.write[0]["params"]["value"], p.config.model);
            let effort = p.receive(json!({"jsonrpc":"2.0","id":5,"result":{}})).unwrap();
            assert_eq!(effort.write[0]["params"]["configId"], "effort");
            assert_eq!(effort.write[0]["params"]["value"], "max");
            let prompt = p.receive(json!({"jsonrpc":"2.0","id":6,"result":{}})).unwrap();
            assert_eq!(prompt.write[0]["method"], "session/prompt");
        }
    }

    #[test]
    fn recorded_models_scope_efforts_to_the_current_model_only() {
        let models = acp::parse_models(&session());
        assert_eq!(models.len(), 3);
        assert_eq!(models[0].id, "default");
        assert_eq!(models[1].name, "Kilo Gateway/Stealth: Claude Sonnet 4.6 (20% off)");
        assert_eq!(models[1].reasoning_efforts.len(), 6);
        assert_eq!(models[1].default_reasoning_effort.as_deref(), Some("none"));
        assert!(models[2].reasoning_efforts.is_empty());
    }

    #[test]
    fn launch_replaces_saved_permission_rules_and_clears_the_later_override() {
        let inherited = r#"{"model":"custom/model","permission":{"bash":"allow"},"agent":{"code":{"permission":{"bash":"allow"},"temperature":0.2},"plan":{"permission":"allow"}},"mode":{"code":{"permission":"allow"},"plan":{"permission":{"*":"allow"},"temperature":0.3}}}"#;
        for mode in ["ask", "auto", "plan", "full"] {
            let config: Value = serde_json::from_str(&configuration(mode, Some(inherited))).unwrap();
            let policy = json!({"*": if mode == "full" { "allow" } else { "ask" }});
            assert_eq!(config["permission"], policy);
            assert_eq!(config["agent"]["code"]["permission"], policy);
            assert_eq!(config["agent"]["plan"]["permission"], policy);
            assert_eq!(config["mode"]["code"]["permission"], policy);
            assert_eq!(config["mode"]["plan"]["permission"], policy);
            assert_eq!(config["model"], "custom/model");
            assert_eq!(config["agent"]["code"]["temperature"], 0.2);
            assert_eq!(config["mode"]["plan"]["temperature"], 0.3);
        }
        let mut command = Command::new("kilo");
        configure(&mut command);
        command.env("KILO_CONFIG_CONTENT", inherited).env("KILO_PERMISSION", r#"{"*":"allow"}"#);
        configure_environment(&mut command, &super::super::tests::config("kilo"));
        assert_eq!(command.as_std().get_args().collect::<Vec<_>>(), ["acp"]);
        assert!(command.as_std().get_envs().any(|(key, value)| key == "KILO_PERMISSION" && value.is_none()));
        let inline = command.as_std().get_envs().find(|(key, _)| *key == "KILO_CONFIG_CONTENT").unwrap().1.unwrap();
        let inline: Value = serde_json::from_str(inline.to_str().unwrap()).unwrap();
        assert_eq!(inline["model"], "custom/model");
        assert_eq!(inline["permission"]["*"], "ask");
    }

    #[test]
    fn rewritten_secret_connection_configuration_stays_redacted() {
        let original = r#"{ "provider": { "fixture": { "options": { "apiKey": "fixture-credential" } } } }"#;
        let mut connection = crate::connections::Launch {
            executable: None, args: Vec::new(),
            env: vec![("KILO_CONFIG_CONTENT".into(), original.into())],
            secrets: vec![original.into()],
        };
        let mut command = Command::new("kilo");
        connection.apply(&mut command);
        let effective = configure_environment(&mut command, &super::super::tests::config("kilo"));
        assert_ne!(effective, original);
        connection.secrets.push(effective.clone());
        let failure = format!("Invalid configuration: {effective}; original: {original}");
        assert_eq!(connection.redact(&failure), "Invalid configuration: [redacted]; original: [redacted]");
    }

    fn permission_request(kind: &str, reject: bool) -> Value {
        let mut options = vec![json!({"optionId":"once","kind":"allow_once","name":"Allow once"})];
        if reject { options.push(json!({"optionId":"reject","kind":"reject_once","name":"Reject"})); }
        json!({"jsonrpc":"2.0","id":9,"method":"session/request_permission","params":{"sessionId":"ses_kilo_test",
            "toolCall":{"toolCallId":"tool-1","title":"Tool action","kind":kind,"status":"pending"},"options":options}})
    }

    #[test]
    fn permissions_enforce_plan_and_keep_standard_and_auto_command_approvals() {
        for (mode, kind, expected) in [
            ("ask", "read", Some("once")), ("auto", "edit", Some("once")),
            ("full", "execute", Some("once")), ("plan", "search", Some("once")),
            ("plan", "edit", Some("reject")), ("plan", "execute", Some("reject")),
            ("plan", "other", Some("reject")), ("ask", "edit", None), ("auto", "execute", None),
        ] {
            let (mut p, _) = ready(mode);
            let step = p.receive(permission_request(kind, true)).unwrap();
            if let Some(expected) = expected {
                assert_eq!(step.write[0]["result"]["outcome"]["optionId"], expected, "{mode} {kind}");
            } else {
                assert!(step.events.iter().any(|event| event.kind == "approval"), "{mode} {kind}");
            }
        }
        let (mut p, _) = ready("plan");
        let step = p.receive(permission_request("execute", false)).unwrap();
        assert_eq!(step.write[0]["result"]["outcome"]["outcome"], "cancelled");
        assert!(!step.events.iter().any(|event| event.kind == "approval"));
    }

    #[test]
    fn resume_cancel_and_authentication_use_kilos_protocol() {
        let mut cfg = super::super::tests::config("kilo");
        cfg.resume_id = Some("ses_kilo_test".into());
        let mut p = Protocol::new(cfg);
        let step = p.receive(initialize()).unwrap();
        assert_eq!(step.write[0]["method"], "session/resume");
        assert_eq!(step.write[0]["params"]["sessionId"], "ses_kilo_test");
        assert_eq!(p.cancel()["method"], "session/cancel");
        let error = p.receive(json!({"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":"Authentication required"}})).err().unwrap();
        assert_eq!(error, SIGN_IN);
        let mut unsupported = session();
        unsupported["configOptions"][2]["options"] = json!([]);
        let (mut p, _) = ready("ask");
        assert!(p.receive(json!({"jsonrpc":"2.0","id":2,"result":unsupported})).is_err());
        let mut init = initialize();
        init["result"]["agentCapabilities"].as_object_mut().unwrap().remove("sessionCapabilities");
        let mut cfg = super::super::tests::config("kilo");
        cfg.resume_id = Some("ses_kilo_test".into());
        let mut p = Protocol::new(cfg);
        assert_eq!(p.receive(init).unwrap().write[0]["method"], "session/load");
    }

    /// Recorded from Kilo 7.3.41 with a loopback mock model and `echo kilo-smoke`.
    #[test]
    fn recorded_tool_text_and_usage_frames_use_the_shared_stream() {
        let (mut p, _) = ready("full");
        p.receive(json!({"jsonrpc":"2.0","id":4,"result":{}})).unwrap();
        let update = |update| json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"ses_kilo_test","update":update}});
        let started = p.receive(update(json!({"sessionUpdate":"tool_call","toolCallId":"call_smoke","title":"bash","kind":"execute","status":"pending","locations":[],"rawInput":{}}))).unwrap();
        assert!(started.events.iter().any(|event| event.kind == "tool"));
        let completed = p.receive(update(json!({"sessionUpdate":"tool_call_update","toolCallId":"call_smoke","status":"completed","kind":"execute","title":"Harmless integration smoke test",
            "rawInput":{"command":"echo kilo-smoke","description":"Harmless integration smoke test"},
            "content":[{"type":"content","content":{"type":"text","text":"kilo-smoke\r\n"}}],
            "rawOutput":{"output":"kilo-smoke\r\n","metadata":{"exit":0,"truncated":false}}}))).unwrap();
        let tool = completed.events.iter().find_map(|event| event.tool.as_ref()).unwrap();
        assert_eq!(tool.status, "completed");
        assert!(tool.output.contains("kilo-smoke"));
        let text = p.receive(update(json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Kilo smoke complete."}}))).unwrap();
        assert!(text.events.iter().any(|event| event.kind == "text" && event.text == "Kilo smoke complete."));
        let usage = p.receive(update(json!({"sessionUpdate":"usage_update","used":0,"size":100000,"cost":{"amount":0,"currency":"USD"}}))).unwrap();
        assert!(usage.events.iter().any(|event| event.kind == "usage"));
        assert!(p.receive(json!({"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn","_meta":{}}})).unwrap().done);
    }

    #[tokio::test]
    #[ignore = "needs the Kilo CLI; metadata only, never sends a prompt"]
    async fn live_kilo_lists_models() {
        widen_process_path();
        let path = executable("kilo").expect("Install Kilo Code first");
        let models = models(&path).await.unwrap();
        assert!(models.len() > 1, "{models:?}");
        // A rejected inline config can still produce a valid catalog. Check that
        // this CLI accepts the exact permission format used for task processes.
        let mut command = super::super::command(&path).unwrap();
        command.args(["debug", "config", "--pure"])
            .env("KILO_CONFIG_CONTENT", configuration("ask", Some(r#"{"model":"pandacode/config-check","mode":{"code":{"permission":{"*":"allow"}},"plan":{"permission":{"*":"allow"}}}}"#)))
            .env_remove("KILO_PERMISSION")
            .current_dir(std::env::temp_dir())
            .kill_on_drop(true);
        let output = tokio::time::timeout(Duration::from_secs(30), command.output()).await.unwrap().unwrap();
        assert!(output.status.success());
        let effective: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(effective["model"], "pandacode/config-check");
        assert_eq!(effective["permission"]["*"], "ask");
        assert_eq!(effective["agent"]["code"]["permission"]["*"], "ask");
        assert_eq!(effective["agent"]["plan"]["permission"]["*"], "ask");
        assert_eq!(effective["mode"]["code"]["permission"]["*"], "ask");
        assert_eq!(effective["mode"]["plan"]["permission"]["*"], "ask");
    }
}
