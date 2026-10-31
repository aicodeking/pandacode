//! Command Code (`command-code acp`) over the shared ACP transport. The CLI keeps
//! its own login; a key saved in PandaCode (or `COMMAND_CODE_API_KEY`) authenticates
//! the same account and is passed only to that process.
use super::*;
use crate::provider_settings::COMMANDCODE_KEY;

/// Command Code serves ACP from its `acp` command.
pub(super) const ACP_ARGS: [&str; 1] = ["acp"];

/// Command Code's ACP session modes are its own permission modes, so PandaCode's
/// choice maps onto one of them.
pub(super) fn mode_id(mode: &str) -> &'static str {
    match mode {
        "plan" => "plan",
        "auto" => "auto-accept",
        "full" => "bypass",
        _ => "default",
    }
}

/// Shown when Command Code has neither a saved key nor a CLI login.
pub(super) const SIGN_IN: &str = "Command Code is not signed in. Run `command-code login` in a terminal, or save an API key in Settings → Agents, then send again.";

/// The key to hand Command Code: a saved key wins, then the app's environment. A
/// locked or unavailable secure store is not fatal here, because the CLI can use
/// the account from `command-code login` instead.
fn resolve_key(saved: Result<Option<String>, String>, environment: Option<String>) -> Option<String> {
    let environment = environment.filter(|key| !key.trim().is_empty());
    saved
        .ok()
        .flatten()
        .and_then(|key| crate::provider_settings::validate_key(&key).ok().map(str::to_owned))
        .or(environment)
}

/// Supplies the saved key when there is one; the CLI reads it ahead of its own
/// stored login. Returns the key so callers can redact it from failures.
pub(super) fn key_environment(command: &mut Command) -> Option<String> {
    let key = resolve_key(
        crate::provider_settings::commandcode_key(),
        std::env::var(COMMANDCODE_KEY.env).ok(),
    );
    if let Some(key) = &key {
        command.env(COMMANDCODE_KEY.env, key);
    }
    key
}

pub(super) fn redact(error: String, key: Option<&str>) -> String {
    key.map_or(error.clone(), |key| error.replace(key, "[redacted]"))
}

/// Command Code advertises its catalog as session config options, so discovery
/// opens an empty session (no prompt, no inference).
pub(super) async fn models(path: &Path) -> Result<Vec<ModelInfo>, String> {
    if let Some(models) = acp_catalog::get("commandcode", path) { return Ok(models); }
    let _refresh = acp_catalog::refresh_lock("commandcode", path).await;
    if let Some(models) = acp_catalog::get("commandcode", path) { return Ok(models); }
    let discovery = acp_catalog::begin("commandcode", path);
    let mut command = super::provider_command("commandcode", path)?;
    command.args(ACP_ARGS);
    let key = key_environment(&mut command);
    let (metadata, _) = acp::inspect(command, &std::env::temp_dir(), false)
        .await
        .map_err(|error| redact(error, key.as_deref()))?;
    acp_catalog::store(discovery, &metadata);
    Ok(acp::parse_models(&metadata))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saved_key_wins_and_a_locked_store_falls_back_to_the_cli_login() {
        let env = Some("cmd-env".to_owned());
        assert_eq!(resolve_key(Ok(Some(" cmd-saved ".into())), env.clone()).as_deref(), Some("cmd-saved"));
        assert_eq!(resolve_key(Ok(None), env.clone()).as_deref(), Some("cmd-env"));
        assert_eq!(resolve_key(Ok(None), None), None);
        assert_eq!(resolve_key(Ok(Some("  ".into())), env).as_deref(), Some("cmd-env"));
        assert_eq!(resolve_key(Ok(Some("bad\nkey".into())), None), None);
        assert_eq!(resolve_key(Err("locked".into()), None), None);
        assert_eq!(redact("failed with cmd-saved".into(), Some("cmd-saved")), "failed with [redacted]");
    }

    /// Recorded from `command-code acp` 1.87.1 `initialize` and `session/new`.
    fn ready(mode: &str, model: &str, effort: Option<&str>) -> (Protocol, Vec<Value>) {
        let mut cfg = super::super::tests::config("commandcode");
        cfg.mode = mode.into();
        cfg.model = model.into();
        cfg.reasoning_effort = effort.map(str::to_owned);
        let mut p = Protocol::new(cfg);
        let mut writes = Vec::new();
        writes.extend(p.receive(json!({"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentCapabilities":{"loadSession":true,"promptCapabilities":{"audio":false,"image":true,"embeddedContext":true},"mcpCapabilities":{"http":true,"sse":false},"sessionCapabilities":{"list":{},"resume":{},"close":{}}},"authMethods":[{"id":"command-code-cli","name":"Command Code CLI login"}],"agentInfo":{"name":"Command Code","version":"1.87.1"}}})).unwrap().write);
        assert_eq!(writes[0]["method"], "session/new");
        writes.extend(p.receive(json!({"jsonrpc":"2.0","id":2,"result":{"sessionId":"cc-1","modes":{"currentModeId":"default","availableModes":[
            {"id":"default","name":"Standard"},{"id":"auto-accept","name":"Accept Edits"},{"id":"plan","name":"Plan"},{"id":"dont-ask","name":"Don't Ask"},{"id":"bypass","name":"Bypass Permissions"}]},
            "configOptions":[
            {"id":"model","name":"Model","category":"model","type":"select","currentValue":"deepseek/deepseek-v4.1-flash","options":[
                {"value":"deepseek/deepseek-v4.1-flash","name":"DeepSeek V4.1 Flash","description":"fast hybrid-attention reasoning"},
                {"value":"claude-sonnet-5-5","name":"Claude Sonnet 5.5","description":"best combo of speed & intelligence"}]},
            {"id":"effort","name":"Effort","category":"thought_level","type":"select","currentValue":"max","options":[
                {"value":"off","name":"Off"},{"value":"low","name":"Low"},{"value":"high","name":"High"},{"value":"max","name":"Max"}]}]}})).unwrap().write);
        (p, writes)
    }

    /// Recorded from `command-code acp` 1.87.1 without a login or key.
    #[test]
    fn a_session_without_sign_in_names_the_login_command() {
        let mut p = Protocol::new(super::super::tests::config("commandcode"));
        p.receive(json!({"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentCapabilities":{},"authMethods":[{"id":"command-code-cli","name":"Command Code CLI login"}]}})).unwrap();
        let error = p.receive(json!({"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":"Not authenticated. Run `cmd login` in a terminal first."}})).err().unwrap();
        assert_eq!(error, SIGN_IN);
    }

    #[test]
    fn recorded_session_modes_map_onto_the_approval_choice() {
        for (mode, expected) in [("ask", "default"), ("auto", "auto-accept"), ("plan", "plan"), ("full", "bypass")] {
            let (mut p, writes) = ready(mode, "default", None);
            let set = &writes[1];
            assert_eq!((set["method"].clone(), set["params"]["modeId"].clone()), (json!("session/set_mode"), json!(expected)), "{mode}");
            let prompt = p.receive(json!({"jsonrpc":"2.0","id":4,"result":{}})).unwrap().write.remove(0);
            assert_eq!(prompt["method"], "session/prompt");
        }
    }

    #[test]
    fn recorded_catalog_becomes_models_with_the_current_models_efforts() {
        let (_, writes) = ready("ask", "default", None);
        assert!(writes.iter().all(|request| request["method"] != "session/set_config_option"), "a default model sets no model or effort");
        let metadata = json!({"sessionId":"cc-1","configOptions":[
            {"id":"model","name":"Model","category":"model","type":"select","currentValue":"deepseek/deepseek-v4.1-flash","options":[
                {"value":"deepseek/deepseek-v4.1-flash","name":"DeepSeek V4.1 Flash","description":"fast hybrid-attention reasoning"},
                {"value":"claude-sonnet-5-5","name":"Claude Sonnet 5.5","description":"best combo of speed & intelligence"}]},
            {"id":"effort","name":"Effort","category":"thought_level","type":"select","currentValue":"max","options":[
                {"value":"off","name":"Off"},{"value":"low","name":"Low"},{"value":"high","name":"High"},{"value":"max","name":"Max"}]}]});
        let models = acp::parse_models(&metadata);
        assert_eq!(models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["default", "deepseek/deepseek-v4.1-flash", "claude-sonnet-5-5"]);
        assert_eq!(models[1].name, "DeepSeek V4.1 Flash");
        assert_eq!(models[1].description, "fast hybrid-attention reasoning");
        assert_eq!(models[1].reasoning_efforts.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(), ["off", "low", "high", "max"]);
        assert_eq!(models[1].default_reasoning_effort.as_deref(), Some("max"));
        assert!(models[2].reasoning_efforts.is_empty(), "efforts belong to the current model only");
        for effort in ["off", "low", "high", "max"] {
            assert!(validate_reasoning_effort("commandcode", Some(effort)).is_ok());
        }
    }

    #[test]
    fn sets_the_selected_model_and_effort_before_prompting() {
        let (mut p, writes) = ready("ask", "claude-sonnet-5-5", Some("high"));
        assert_eq!(writes[1]["method"], "session/set_mode");
        let set = p.receive(json!({"jsonrpc":"2.0","id":4,"result":{}})).unwrap().write.remove(0);
        assert_eq!((set["id"].clone(), set["method"].clone()), (json!(5), json!("session/set_config_option")));
        assert_eq!((set["params"]["configId"].clone(), set["params"]["value"].clone()), (json!("model"), json!("claude-sonnet-5-5")));
        let set = p.receive(json!({"jsonrpc":"2.0","id":5,"result":{}})).unwrap().write.remove(0);
        assert_eq!((set["params"]["configId"].clone(), set["params"]["value"].clone()), (json!("effort"), json!("high")));
        let prompt = p.receive(json!({"jsonrpc":"2.0","id":6,"result":{}})).unwrap().write.remove(0);
        assert_eq!(prompt["method"], "session/prompt");
        assert!(!prompt["params"]["prompt"][0]["text"].as_str().unwrap().contains("Plan mode"));
    }

    fn permission(p: &mut Protocol) -> Step {
        p.receive(json!({"jsonrpc":"2.0","id":9,"method":"session/request_permission","params":{"sessionId":"cc-1","toolCall":{"toolCallId":"c1","kind":"edit"},
            "options":[{"optionId":"allow-once","name":"Allow once","kind":"allow_once"},{"optionId":"reject-once","name":"Reject","kind":"reject_once"}]}})).unwrap()
    }

    #[test]
    fn permissions_follow_the_task_mode() {
        let outcome = |step: &Step| step.write.first().map(|w| w["result"]["outcome"]["optionId"].clone());
        let (mut p, _) = ready("auto", "default", None);
        assert_eq!(outcome(&permission(&mut p)), Some(json!("allow-once")));
        let (mut p, _) = ready("full", "default", None);
        assert_eq!(outcome(&permission(&mut p)), Some(json!("allow-once")));
        let (mut p, _) = ready("ask", "default", None);
        let step = permission(&mut p);
        assert!(step.write.is_empty() && step.events.iter().any(|e| e.kind == "approval"));
    }

    #[test]
    fn a_resumed_session_keeps_its_saved_id() {
        let mut cfg = super::super::tests::config("commandcode");
        cfg.resume_id = Some("cc-saved".into());
        let mut p = Protocol::new(cfg);
        let request = p.receive(json!({"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentCapabilities":{"sessionCapabilities":{"resume":{}}}}})).unwrap().write.remove(0);
        assert_eq!(request["method"], "session/resume");
        assert_eq!(request["params"]["sessionId"], "cc-saved");
        let saved = p.receive(json!({"jsonrpc":"2.0","id":2,"result":{"sessionId":"cc-saved"}})).unwrap().events;
        assert_eq!(saved.iter().find(|e| e.kind == "session").unwrap().text, "cc-saved");
    }

    #[tokio::test]
    #[ignore = "needs the Command Code CLI and a login; metadata only, never sends a prompt"]
    async fn live_command_code_lists_models() {
        super::super::widen_process_path(); // as the app does at startup
        let path = executable("commandcode").expect("Install Command Code first");
        let models = models(&path).await.unwrap();
        assert!(models.len() > 1, "{models:?}");
    }
}
