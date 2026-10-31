//! Hermes Agent over its local ACP stdio server (`hermes acp`). Authentication and
//! model provider configuration remain with the installed Hermes runtime (~/.hermes/).
use super::*;

pub(super) fn configure(command: &mut Command, config: &RunConfig) {
    if config.mode == "full" {
        command.env("HERMES_YOLO_MODE", "1");
    }
    let program = command.as_std().get_program().to_os_string();
    configure_command(command, Path::new(&program));
}

pub(crate) fn configure_command(command: &mut Command, path: &Path) {
    if path.file_stem().is_none_or(|name| name != "hermes-acp") {
        command.arg("acp");
    }
}

pub(super) async fn models(path: &Path) -> Result<Vec<ModelInfo>, String> {
    if let Some(models) = acp_catalog::get("hermes", path) {
        return Ok(models);
    }
    let _refresh = acp_catalog::refresh_lock("hermes", path).await;
    if let Some(models) = acp_catalog::get("hermes", path) {
        return Ok(models);
    }
    let discovery = acp_catalog::begin("hermes", path);
    let mut command = super::command(path)?;
    configure_command(&mut command, path);
    let (metadata, _) = acp::inspect(command, &std::env::temp_dir(), false).await.map_err(|error| {
        if error.contains("No LLM provider configured") || error.contains("ProviderNotConfiguredError") {
            "Hermes Agent has no inference provider configured. Run `hermes model` or set model.provider in ~/.hermes/config.yaml (e.g. 'openrouter'), then retry.".to_owned()
        } else if error.contains("storage_unavailable") || error.contains("-32000") || error.contains("not authenticated") {
            "Hermes Agent is not configured with a default model. Run `hermes model` or `hermes acp --setup` in a terminal (or set model.default in ~/.hermes/config.yaml), then retry.".to_owned()
        } else {
            error
        }
    })?;
    acp_catalog::store(discovery, &metadata);
    Ok(acp::parse_models(&metadata))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session_empty() -> Value {
        json!({
            "sessionId": "hermes-session-1",
            "configOptions": []
        })
    }

    fn session_with_models() -> Value {
        json!({
            "sessionId": "hermes-session-2",
            "configOptions": [
                {
                    "type": "select",
                    "id": "model",
                    "name": "Model",
                    "category": "model",
                    "currentValue": "nous/hermes-3-llama-3.1-405b",
                    "options": [
                        { "value": "nous/hermes-3-llama-3.1-405b", "name": "Hermes 3 Llama 3.1 405B" },
                        { "value": "anthropic/claude-sonnet-4", "name": "Claude Sonnet 4" }
                    ]
                }
            ]
        })
    }

    #[test]
    fn hermes_session_without_models_resolves_to_default_only() {
        let models = acp::parse_models(&session_empty());
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "default");
    }

    #[test]
    fn hermes_session_advertised_models_are_parsed_and_default_is_retained() {
        let models = acp::parse_models(&session_with_models());
        assert_eq!(models.len(), 3);
        assert_eq!(models[0].id, "default");
        assert_eq!(models[1].id, "nous/hermes-3-llama-3.1-405b");
        assert_eq!(models[1].name, "Hermes 3 Llama 3.1 405B");
        assert_eq!(models[2].id, "anthropic/claude-sonnet-4");
    }

    #[test]
    fn configure_command_handles_hermes_and_hermes_acp_binary() {
        let mut cmd = Command::new("test");
        configure_command(&mut cmd, Path::new("/usr/local/bin/hermes"));
        assert_eq!(cmd.as_std().get_args().collect::<Vec<_>>(), ["acp"]);

        let mut cmd_acp = Command::new("test");
        configure_command(&mut cmd_acp, Path::new("/usr/local/bin/hermes-acp"));
        assert!(cmd_acp.as_std().get_args().next().is_none());

        let mut cmd_windows = Command::new("test");
        configure_command(&mut cmd_windows, Path::new("C:/bin/hermes-acp.exe"));
        assert!(cmd_windows.as_std().get_args().next().is_none());
    }

    #[tokio::test]
    #[ignore = "requires an installed, configured Hermes CLI"]
    async fn installed_hermes_lists_models() {
        let path = executable("hermes").expect("Install Hermes CLI first");
        let started = std::time::Instant::now();
        let models = models(&path).await.expect("Hermes ACP discovery should succeed");
        eprintln!("{} models in {:?}", models.len(), started.elapsed());
        assert!(!models.is_empty());
        assert!(models.iter().any(|m| m.id == "default"));
    }

    #[tokio::test]
    #[ignore = "requires an installed, configured Hermes CLI; sends a prompt"]
    async fn installed_hermes_runs_a_task() {
        let cwd = std::env::temp_dir().join(format!("pandacode-hermes-live-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&cwd).unwrap();
        let turn = |prompt: &str, resume: Option<String>| {
            let mut config = super::super::tests::config("hermes");
            config.cwd = cwd.clone();
            config.prompt = prompt.into();
            config.resume_id = resume;
            let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::<crate::providers::AgentEvent>::new()));
            let seen = events.clone();
            let sink: crate::providers::Sink = std::sync::Arc::new(move |event| seen.lock().unwrap().push(event));
            let (input, receiver) = tokio::sync::mpsc::unbounded_channel::<crate::providers::RunInput>();
            async move {
                let _input = input;
                super::super::run(config, sink, receiver).await.expect("the turn should finish");
                let events = events.lock().unwrap().clone();
                events
            }
        };
        let text = |events: &[crate::providers::AgentEvent]| events.iter().filter(|e| e.kind == "text" || e.kind == "delta").map(|e| e.text.as_str()).collect::<String>();
        let first = turn("Reply with exactly the word PANDA and nothing else.", None).await;
        let session = first.iter().find(|event| event.kind == "session").expect("a session id").text.clone();
        assert!(text(&first).contains("PANDA"), "{:?}", first.iter().map(|e| (&e.kind, &e.text)).collect::<Vec<_>>());
        let second = turn("Reply with exactly the word CODE and nothing else.", Some(session)).await;
        assert!(text(&second).contains("CODE"), "{:?}", second.iter().map(|e| (&e.kind, &e.text)).collect::<Vec<_>>());
        let _ = std::fs::remove_dir_all(&cwd);
    }
}
