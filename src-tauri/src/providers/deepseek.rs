//! DeepSeek Harness (`dsh --profile acp`) over the shared ACP transport. dsh reads
//! `DEEPSEEK_API_KEY` from its launch environment ahead of its own credential file,
//! so a key saved in PandaCode is passed only to that process.
use super::*;
use crate::provider_settings::DEEPSEEK_KEY;

/// The key to hand dsh: a saved key wins, then the app's environment. With neither,
/// dsh falls back to the credentials stored in its own home.
fn resolve_key(saved: Result<Option<String>, String>, environment: Option<String>) -> Result<Option<String>, String> {
    let environment = environment.filter(|key| !key.trim().is_empty());
    match saved {
        Ok(Some(key)) => crate::provider_settings::validate_key(&key).map(|key| Some(key.to_owned())),
        Ok(None) => Ok(None),
        Err(_) if environment.is_some() => Ok(None),
        Err(error) => Err(error),
    }
}

/// Selects the ACP profile and supplies the saved key. Returns it for redaction.
pub(super) fn configure(command: &mut Command) -> Result<Option<String>, String> {
    let key = resolve_key(crate::provider_settings::deepseek_key(), std::env::var(DEEPSEEK_KEY.env).ok())?;
    if let Some(key) = &key {
        command.env(DEEPSEEK_KEY.env, key);
    }
    Ok(key)
}

/// dsh picks its sandbox from this variable when a process starts.
pub(super) const PERMISSION_ENV: &str = "DSH_PERMISSION_MODE";

/// The dsh sandbox for a PandaCode mode. dsh cannot ask before each workspace
/// edit: Standard = workspace-write sandbox + ask on escalation.
pub(super) fn sandbox(mode: &str) -> &'static str {
    match mode {
        "plan" => "read-only",
        "full" => "danger-full-access",
        _ => "workspace-write",
    }
}

/// A dsh session pins its sandbox in its own log at creation and `session/resume`
/// replays it, ignoring the new process's environment. So PandaCode saves the
/// sandbox with the session ID (`<id>#<sandbox>`) and resumes only when it still
/// matches; after a mode change the next turn starts a fresh dsh session, which
/// loses dsh's own history of the task (the PandaCode transcript stays).
pub(super) fn saved_session(resume_id: &str, mode: &str) -> Option<String> {
    // IDs saved before the sandbox was recorded ran under dsh's default.
    let (id, saved) = resume_id.rsplit_once('#').unwrap_or((resume_id, "workspace-write"));
    (saved == sandbox(mode)).then(|| id.to_owned())
}

pub(super) fn resume_id(session: &str, mode: &str) -> String {
    format!("{session}#{}", sandbox(mode))
}

/// dsh advertises its catalog as session config options, so discovery opens an
/// empty session (no prompt, no inference).
pub(super) async fn models(path: &Path) -> Result<Vec<ModelInfo>, String> {
    if let Some(models) = acp_catalog::get("deepseek", path) { return Ok(models); }
    let _refresh = acp_catalog::refresh_lock("deepseek", path).await;
    if let Some(models) = acp_catalog::get("deepseek", path) { return Ok(models); }
    let discovery = acp_catalog::begin("deepseek", path);
    let mut command = super::provider_command("deepseek", path)?;
    command.args(acp::DEEPSEEK_ARGS);
    let key = configure(&mut command)?;
    let (metadata, _) = acp::inspect(command, &std::env::temp_dir(), false)
        .await
        .map_err(|error| key.as_ref().map_or(error.clone(), |key| error.replace(key, "[redacted]")))?;
    acp_catalog::store(discovery, &metadata);
    Ok(acp::parse_models_for("deepseek", &metadata))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saved_key_wins_and_missing_key_defers_to_dsh() {
        let env = Some("sk-env".to_owned());
        assert_eq!(resolve_key(Ok(Some(" sk-saved ".into())), env.clone()).unwrap().as_deref(), Some("sk-saved"));
        assert_eq!(resolve_key(Ok(None), env.clone()).unwrap(), None);
        assert_eq!(resolve_key(Ok(None), None).unwrap(), None);
        assert_eq!(resolve_key(Err("locked".into()), env).unwrap(), None);
        assert!(resolve_key(Err("locked".into()), None).is_err());
    }

    /// Recorded from `dsh --profile acp` 0.1.5-rc.1 `session/new`.
    #[test]
    fn recorded_session_options_become_models_with_efforts() {
        let metadata = json!({"sessionId":"s","configOptions":[
            {"id":"model","name":"Model","category":"model","type":"select","currentValue":"[\"deepseek-official\",\"deepseek-v4-flash\"]","options":[{"group":"deepseek-official","name":"DeepSeek","options":[
                {"value":"[\"deepseek-official\",\"deepseek-v4-flash\"]","name":"DeepSeek-V4-Flash","description":"Fast, efficient, and economical; suited to focused, routine, or parallel tasks."},
                {"value":"[\"deepseek-official\",\"deepseek-v4-pro\"]","name":"DeepSeek-V4-Pro"}]}]},
            {"id":"reasoning_effort","name":"Reasoning effort","category":"thought_level","type":"select","currentValue":"high","options":[
                {"value":"off","name":"Off"},{"value":"low","name":"Low"},{"value":"high","name":"High"},{"value":"max","name":"Max"}]}]});
        let models = acp::parse_models_for("deepseek", &metadata);
        assert_eq!(models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["default", "[\"deepseek-official\",\"deepseek-v4-flash\"]", "[\"deepseek-official\",\"deepseek-v4-pro\"]"]);
        assert_eq!(models[1].name, "DeepSeek-V4-Flash");
        for model in models.iter().skip(1) {
            assert_eq!(model.reasoning_efforts.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(), ["off", "low", "high", "max"]);
            assert_eq!(model.default_reasoning_effort.as_deref(), Some("high"));
        }
        for effort in ["off", "low", "high", "max"] {
            assert!(validate_reasoning_effort("deepseek", Some(effort)).is_ok());
        }
    }

    fn ready(mode: &str, model: &str, effort: Option<&str>) -> (Protocol, Vec<Value>) {
        let mut cfg = super::super::tests::config("deepseek");
        cfg.mode = mode.into();
        cfg.model = model.into();
        cfg.reasoning_effort = effort.map(str::to_owned);
        let mut p = Protocol::new(cfg);
        let mut writes = Vec::new();
        // dsh initialization and session options, including an Account model.
        writes.extend(p.receive(json!({"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentInfo":{"name":"deepseek-harness-acp","version":"0.0.1"},"agentCapabilities":{"mcpCapabilities":{"http":true},"promptCapabilities":{"image":false,"audio":false,"embeddedContext":false},"sessionCapabilities":{"close":{},"list":{},"resume":{}}},"authMethods":[]}})).unwrap().write);
        assert_eq!(writes[0]["method"], "session/new");
        writes.extend(p.receive(json!({"jsonrpc":"2.0","id":2,"result":{"sessionId":"ds-1","configOptions":[
            {"id":"model","category":"model","type":"select","currentValue":"[\"deepseek-official\",\"deepseek-v4-flash\"]","options":[{"group":"deepseek-official","name":"DeepSeek","options":[{"value":"[\"deepseek-official\",\"deepseek-v4-flash\"]","name":"DeepSeek-V4-Flash"},{"value":"[\"deepseek-official\",\"deepseek-v4-pro\"]","name":"DeepSeek-V4-Pro"}]},{"group":"deepseek-account","options":[{"value":"[\"deepseek-account\",\"DeepSeek-V4.1-Flash\"]","name":"DeepSeek-V4.1-Flash"}]}]},
            {"id":"reasoning_effort","category":"thought_level","type":"select","currentValue":"high","options":[{"value":"off"},{"value":"low"},{"value":"high"},{"value":"max"}]}]}})).unwrap().write);
        (p, writes)
    }

    #[test]
    fn sets_model_and_effort_options_then_prompts_with_plan_prefix() {
        for pro in ["[\"deepseek-official\",\"deepseek-v4-pro\"]", "[\"deepseek-account\",\"DeepSeek-V4.1-Flash\"]"] {
            let (mut p, writes) = ready("plan", pro, Some("max"));
            let set = &writes[1];
            assert_eq!((set["id"].clone(), set["method"].clone()), (json!(5), json!("session/set_config_option")));
            assert_eq!((set["params"]["configId"].clone(), set["params"]["value"].clone()), (json!("model"), json!(pro)));
            let set = p.receive(json!({"jsonrpc":"2.0","id":5,"result":{"configOptions":[
                {"id":"reasoning_effort","category":"thought_level","type":"select","currentValue":"high","options":[
                    {"value":"off"},{"value":"low"},{"value":"high"},{"value":"max"}]}]}})).unwrap().write.remove(0);
            assert_eq!((set["params"]["configId"].clone(), set["params"]["value"].clone()), (json!("reasoning_effort"), json!("max")));
            let prompt = p.receive(json!({"jsonrpc":"2.0","id":6,"result":{}})).unwrap().write.remove(0);
            assert_eq!(prompt["method"], "session/prompt");
            assert!(prompt["params"]["prompt"][0]["text"].as_str().unwrap().starts_with("Plan mode is on"));
        }
    }

    fn permission(p: &mut Protocol, tool: &str) -> Step {
        p.receive(json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"ds-1","update":{"sessionUpdate":"tool_call","toolCallId":"c1","title":tool,"kind":"other","status":"in_progress","rawInput":{}}}})).unwrap();
        p.receive(json!({"jsonrpc":"2.0","id":9,"method":"session/request_permission","params":{"sessionId":"ds-1","toolCall":{"toolCallId":"c1"},
            "options":[{"optionId":"allow-once","name":"Allow once","kind":"allow_once"},{"optionId":"reject-once","name":"Reject","kind":"reject_once"}]}})).unwrap()
    }

    #[test]
    fn permissions_follow_the_task_mode() {
        let outcome = |step: &Step| step.write.first().map(|w| w["result"]["outcome"]["optionId"].clone());
        let (mut p, _) = ready("plan", "default", None);
        assert_eq!(outcome(&permission(&mut p, "write")), Some(json!("reject-once")));
        let (mut p, _) = ready("auto", "default", None);
        assert_eq!(outcome(&permission(&mut p, "str_replace_editor")), Some(json!("allow-once")));
        let (mut p, _) = ready("auto", "default", None);
        let step = permission(&mut p, "bash");
        assert!(step.write.is_empty() && step.events.iter().any(|e| e.kind == "approval"));
        let (mut p, _) = ready("full", "default", None);
        assert_eq!(outcome(&permission(&mut p, "bash")), Some(json!("allow-once")));
    }

    #[test]
    fn mode_picks_the_dsh_sandbox() {
        for (mode, expected) in [("plan", "read-only"), ("ask", "workspace-write"), ("auto", "workspace-write"), ("full", "danger-full-access")] {
            let mut cfg = super::super::tests::config("deepseek");
            cfg.mode = mode.into();
            let mut command = Command::new("dsh");
            acp::configure(&mut command, &cfg);
            let env = command.as_std().get_envs().find(|(key, _)| *key == PERMISSION_ENV).and_then(|(_, value)| value);
            assert_eq!(env.and_then(|value| value.to_str()), Some(expected), "{mode}");
        }
    }

    /// dsh keeps the sandbox a session was created with, so a mode change starts fresh.
    #[test]
    fn resumes_only_when_the_saved_sandbox_matches() {
        assert_eq!(saved_session("ds-1#read-only", "plan").as_deref(), Some("ds-1"));
        assert_eq!(saved_session("ds-1", "auto").as_deref(), Some("ds-1"));
        assert_eq!(saved_session("ds-1#workspace-write", "full"), None);
        let initialize = json!({"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentCapabilities":{"mcpCapabilities":{"http":true},"sessionCapabilities":{"resume":{}}}}});
        for (mode, method) in [("ask", "session/resume"), ("plan", "session/new")] {
            let mut cfg = super::super::tests::config("deepseek");
            cfg.mode = mode.into();
            cfg.resume_id = Some("ds-1#workspace-write".into());
            let mut p = Protocol::new(cfg);
            let request = p.receive(initialize.clone()).unwrap().write.remove(0);
            assert_eq!(request["method"], method);
            let step = p.receive(json!({"jsonrpc":"2.0","id":2,"result":{"sessionId":"ds-2"}})).unwrap();
            let saved = step.events.iter().find(|e| e.kind == "session").unwrap();
            assert_eq!(saved.text, format!("ds-2#{}", sandbox(mode)));
        }
    }

    #[tokio::test]
    #[ignore = "needs dsh on PATH"]
    async fn live_dsh_lists_models() {
        super::super::widen_process_path(); // as the app does at startup
        let path = executable("deepseek").expect("dsh is installed");
        let models = models(&path).await.unwrap();
        assert!(models.len() > 1, "{models:?}");
    }
}
