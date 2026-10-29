//! Nanobot personal AI agent over an embedded ACP stdio bridge or standalone `nanobot-acp`.
//! Model providers and instance configuration remain with the installed Nanobot runtime (~/.nanobot/).
use super::*;
use std::sync::OnceLock;

static BRIDGE_CODE: &str = include_str!("nanobot_bridge.py");

pub(crate) fn bridge_path() -> Result<PathBuf, String> {
    static PATH: OnceLock<PathBuf> = OnceLock::new();
    if let Some(path) = PATH.get() {
        return Ok(path.clone());
    }
    #[cfg(unix)]
    let filename = format!("pandacode-nanobot-bridge-{}.py", unsafe { libc::getuid() });
    #[cfg(not(unix))]
    let filename = "pandacode-nanobot-bridge.py".to_string();
    let path = std::env::temp_dir().join(filename);
    let needs_write = match std::fs::read_to_string(&path) {
        Ok(existing) => existing != BRIDGE_CODE,
        Err(_) => true,
    };
    if needs_write {
        std::fs::write(&path, BRIDGE_CODE)
            .map_err(|e| format!("Failed to write Nanobot ACP bridge: {e}"))?;
    }
    let _ = PATH.set(path.clone());
    Ok(path)
}

pub(crate) fn python_for_nanobot(path: &Path) -> Option<PathBuf> {
    if path.file_stem().is_some_and(|name| name == "python" || name == "python3") && path.is_file() {
        return Some(path.to_path_buf());
    }
    let venv_python = path.with_file_name(if cfg!(windows) { "python.exe" } else { "python" });
    if venv_python.is_file() {
        return Some(venv_python);
    }
    #[cfg(unix)]
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        let p = home.join(".nanobot/venv/bin/python");
        if p.is_file() {
            return Some(p);
        }
    }
    #[cfg(windows)]
    if let Some(userprofile) = std::env::var_os("USERPROFILE").map(PathBuf::from) {
        let p = userprofile.join(".nanobot\\venv\\Scripts\\python.exe");
        if p.is_file() {
            return Some(p);
        }
    }
    if let Ok(content) = std::fs::read_to_string(path) {
        for line in content.lines() {
            if let Some(rest) = line.strip_prefix("#!") {
                let mut parts = rest.split_whitespace();
                if let Some(first) = parts.next() {
                    if first.ends_with("/env") {
                        let second = parts.find(|part| !part.starts_with('-'));
                        if let Some(cmd) = second {
                            if let Some(found) = launch::find(cmd) {
                                return Some(found);
                            }
                        }
                    } else {
                        let candidate = PathBuf::from(first);
                        if candidate.is_file() {
                            return Some(candidate);
                        }
                    }
                }
            } else if line.contains("python") {
                if let Some(start) = line.find('/') {
                    let part = &line[start..];
                    let py = part.split_whitespace().next().unwrap_or("");
                    let candidate = PathBuf::from(py);
                    if candidate.is_file() {
                        return Some(candidate);
                    }
                }
            }
        }
    }
    launch::find("python3").or_else(|| launch::find("python"))
}

pub(crate) fn command(path: &Path) -> Result<Command, String> {
    if path.file_stem().is_some_and(|name| name == "nanobot-acp") {
        return super::command(path);
    }
    let python = python_for_nanobot(path).ok_or_else(|| {
        "Python interpreter for Nanobot could not be found. Ensure Nanobot is installed in ~/.nanobot/venv/ or python3 is on PATH.".to_string()
    })?;
    let bridge = bridge_path()?;
    let mut cmd = Command::new(python);
    cmd.args(["-u", bridge.to_str().unwrap()]);
    Ok(cmd)
}

pub(super) fn configure(command: &mut Command, config: &RunConfig) {
    if config.mode == "full" {
        command.env("NANOBOT_YOLO_MODE", "1");
    }
    let program = command.as_std().get_program().to_os_string();
    configure_command(command, Path::new(&program));
}

pub(crate) fn configure_command(_command: &mut Command, _path: &Path) {
    // The embedded bridge and nanobot-acp are both native ACP servers and require no subcommand argument.
}

pub(super) async fn models(path: &Path) -> Result<Vec<ModelInfo>, String> {
    if let Some(models) = acp_catalog::get("nanobot", path) {
        return Ok(models);
    }
    let _refresh = acp_catalog::refresh_lock("nanobot", path).await;
    if let Some(models) = acp_catalog::get("nanobot", path) {
        return Ok(models);
    }
    let discovery = acp_catalog::begin("nanobot", path);
    let mut cmd = command(path)?;
    configure_command(&mut cmd, path);
    let (metadata, _) = acp::inspect(cmd, &std::env::temp_dir(), false).await.map_err(|error| {
        unmask_error(&error)
    })?;
    acp_catalog::store(discovery, &metadata);
    Ok(acp::parse_models(&metadata))
}

pub(crate) fn unmask_error(error: &str) -> String {
    if error.contains("No LLM provider configured")
        || error.contains("ProviderNotConfiguredError")
        || error.contains("unconfigured provider")
        || error.contains("No active provider")
        || error.contains("No provider is configured")
    {
        "Nanobot has no inference provider configured. Run `nanobot onboard` or set provider in ~/.nanobot/config.json (e.g. OpenRouter, OpenAI, or Anthropic), then retry.".to_owned()
    } else if error.contains("storage_unavailable") || error.contains("-32000") || error.contains("not authenticated") {
        "Nanobot is not configured with a default model. Run `nanobot onboard` in a terminal (or set agents.defaults in ~/.nanobot/config.json), then retry.".to_owned()
    } else if error.contains("GitHub Copilot is not logged in") {
        "GitHub Copilot in Nanobot is not logged in. Run `nanobot provider login github-copilot` in a terminal, then retry.".to_owned()
    } else if error.contains("No such command 'acp'")
        || error.contains("No such command \"acp\"")
        || (error.contains("No such command") && error.contains("acp"))
    {
        "Nanobot does not currently include a built-in 'acp' command in this release. PandaCode uses its built-in ACP bridge to drive Nanobot, or you can use 'Open terminal' to interact with Nanobot directly via 'nanobot agent'.".to_owned()
    } else {
        error.to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session_empty() -> Value {
        json!({
            "sessionId": "nanobot-session-1",
            "configOptions": []
        })
    }

    fn session_with_models() -> Value {
        json!({
            "sessionId": "nanobot-session-2",
            "configOptions": [
                {
                    "type": "select",
                    "id": "model",
                    "name": "Model",
                    "category": "model",
                    "currentValue": "anthropic/claude-sonnet-4",
                    "options": [
                        { "value": "anthropic/claude-sonnet-4", "name": "Claude Sonnet 4" },
                        { "value": "openai/gpt-4o", "name": "GPT-4o" }
                    ]
                }
            ]
        })
    }

    #[test]
    fn nanobot_session_without_models_resolves_to_default_only() {
        let models = acp::parse_models(&session_empty());
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "default");
    }

    #[test]
    fn nanobot_session_advertised_models_are_parsed_and_default_is_retained() {
        let models = acp::parse_models(&session_with_models());
        assert_eq!(models.len(), 3);
        assert_eq!(models[0].id, "default");
        assert_eq!(models[1].id, "anthropic/claude-sonnet-4");
        assert_eq!(models[1].name, "Claude Sonnet 4");
        assert_eq!(models[2].id, "openai/gpt-4o");
    }

    #[test]
    fn configure_command_requires_no_subcommand_for_acp_bridge() {
        let mut cmd = Command::new("python");
        configure_command(&mut cmd, Path::new("/usr/local/bin/nanobot"));
        assert!(cmd.as_std().get_args().next().is_none());
    }

    #[test]
    fn configure_command_skips_acp_for_nanobot_acp_wrapper() {
        let mut cmd = Command::new("nanobot-acp");
        configure_command(&mut cmd, Path::new("/usr/local/bin/nanobot-acp"));
        assert!(cmd.as_std().get_args().next().is_none());
    }

    #[test]
    fn configure_sets_yolo_env_in_full_mode() {
        let mut cmd = Command::new("nanobot");
        let mut config = super::super::tests::config("nanobot");
        config.mode = "full".into();
        configure(&mut cmd, &config);
        assert_eq!(
            cmd.as_std().get_envs().find(|(k, _)| *k == "NANOBOT_YOLO_MODE").and_then(|(_, v)| v),
            Some(std::ffi::OsStr::new("1"))
        );
        let args: Vec<_> = cmd.as_std().get_args().collect();
        assert!(!args.contains(&std::ffi::OsStr::new("--yolo")));
        assert!(!args.contains(&std::ffi::OsStr::new("acp")));
    }

    #[test]
    fn bridge_path_writes_file_successfully() {
        let path = bridge_path().unwrap();
        assert!(path.is_file());
        let content = std::fs::read_to_string(path).unwrap();
        assert!(content.contains("PandaCode ACP Bridge for Nanobot"));
    }

    #[test]
    fn python_for_nanobot_locates_interpreter() {
        let py = python_for_nanobot(Path::new("/usr/local/bin/nanobot"));
        assert!(py.is_some());
    }

    #[test]
    fn python_for_nanobot_parses_env_shebang() {
        let temp = std::env::temp_dir().join(format!("mock-nanobot-{}", std::process::id()));
        std::fs::write(&temp, "#!/usr/bin/env python3\n# mock script").unwrap();
        let py = python_for_nanobot(&temp);
        let _ = std::fs::remove_file(&temp);
        assert!(py.is_some());
    }

    #[tokio::test]
    #[ignore]
    async fn installed_nanobot_catalog() {
        let path = crate::providers::executable("nanobot").expect("Install Nanobot to check its catalog");
        let models = models(&path).await.unwrap();
        assert!(!models.is_empty());
        for model in models {
            println!("{}: {}", model.id, model.name);
        }
    }

    #[test]
    fn unmask_error_translates_missing_provider() {
        let err = unmask_error("Error: ProviderNotConfiguredError: No LLM provider configured");
        assert!(err.contains("nanobot onboard"));
        assert!(err.contains("~/.nanobot/config.json"));
    }

    #[test]
    fn unmask_error_translates_missing_acp_command() {
        let err = unmask_error("Usage: nanobot [OPTIONS] COMMAND [ARGS]...\nError: No such command 'acp'.");
        assert!(err.contains("built-in 'acp' command"));
        assert!(err.contains("Open terminal"));
    }

    #[test]
    fn nanobot_bridge_advertises_http_mcp_support() {
        let path = bridge_path().unwrap();
        let content = std::fs::read_to_string(path).unwrap();
        assert!(content.contains("\"agentCapabilities\": caps"));
        assert!(content.contains("\"http\": True") || content.contains("\"http\": true"));
    }

    #[test]
    fn nanobot_session_with_required_mcp_succeeds_when_http_mcp_advertised() {
        let mut p = super::Protocol::new(super::super::tests::config("nanobot"));
        p.mcp_server = Some(serde_json::json!({
            "type": "http",
            "name": "pandacode_architect",
            "url": "http://127.0.0.1:9/mcp"
        }));
        p.mcp_required = true;
        let cap = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "result": {
                "protocolVersion": 1,
                "agentCapabilities": {
                    "loadSession": true,
                    "promptCapabilities": { "image": true },
                    "mcpCapabilities": { "http": true, "sse": true },
                    "sessionCapabilities": { "list": {}, "resume": {}, "close": {} }
                }
            }
        });
        let step = p.receive(cap).expect("Nanobot ACP handshake must accept HTTP MCP");
        assert_eq!(step.write[0]["method"], "session/new");
        assert_eq!(step.write[0]["params"]["mcpServers"][0]["name"], "pandacode_architect");
    }
}
