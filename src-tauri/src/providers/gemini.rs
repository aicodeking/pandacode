//! Google's Gemini CLI over its ACP stdio server (`gemini --acp`). The harness is
//! offered only when a Gemini API key is available: in PandaCode's saved
//! environment for the harness, in the app's own environment, or in the CLI's
//! `~/.gemini/.env` (which the CLI loads itself). PandaCode never reads the key's
//! value into a run; it only checks that one is set. Session modes are Default,
//! Auto Edit, YOLO and Plan, and each PandaCode approval mode maps to one of them.
use super::*;

/// The variables the Gemini CLI accepts for the Gemini Developer API.
pub(crate) const KEY_VARIABLES: [&str; 2] = ["GEMINI_API_KEY", "GOOGLE_API_KEY"];
/// The ACP auth method for an API key; sessions use it instead of a saved Google sign-in.
const API_KEY_METHOD: &str = "gemini-api-key";
/// Shown when the CLI rejects or cannot find the key.
pub(super) const SIGN_IN: &str = "Gemini CLI could not use a Gemini API key. Put GEMINI_API_KEY=<your key> in ~/.gemini/.env (from https://aistudio.google.com/apikey), then send again.";

pub(crate) fn configure(command: &mut Command) {
    // PandaCode already asks before opening a project, so trust it for this
    // process instead of letting the CLI ignore its settings and key there.
    command.args(["--acp", "--skip-trust"]);
}

/// The Gemini session mode for a PandaCode approval mode.
pub(super) fn mode_id(mode: &str) -> &'static str {
    match mode {
        "plan" => "plan",
        "auto" => "autoEdit",
        "full" => "yolo",
        _ => "default",
    }
}

/// The API key method when this initialize result advertises it, so a CLI set
/// to Google sign-in still uses the key instead of opening a browser.
pub(super) fn login_method<'a>(provider: &str, result: &'a Value) -> Option<&'a str> {
    if provider != "gemini" {
        return None;
    }
    result["authMethods"].as_array()?.iter().find_map(|method| {
        let id = method["id"].as_str()?;
        (id == API_KEY_METHOD).then_some(id)
    })
}

/// Whether a `.env` file assigns a non-empty Gemini key.
fn env_file_has_key(text: &str) -> bool {
    text.lines().any(|line| {
        let line = line.trim();
        let line = line.strip_prefix("export ").unwrap_or(line);
        let Some((name, value)) = line.split_once('=') else {
            return false;
        };
        let value = value.trim().trim_matches(|c| c == '"' || c == '\'');
        KEY_VARIABLES.contains(&name.trim()) && !value.is_empty()
    })
}

fn has_key(saved: &[(String, String)], process: impl Fn(&str) -> Option<String>, env_files: &[PathBuf]) -> bool {
    let set = |value: &str| !value.trim().is_empty();
    saved.iter().any(|(name, value)| KEY_VARIABLES.contains(&name.as_str()) && set(value))
        || KEY_VARIABLES.iter().any(|name| process(name).is_some_and(|value| set(&value)))
        || env_files.iter().any(|path| {
            std::fs::read_to_string(path).is_ok_and(|text| env_file_has_key(&text))
        })
}

/// The `.env` files the CLI falls back to outside a project: its own, then the home one.
fn home_env_files() -> Vec<PathBuf> {
    dirs::home_dir()
        .map(|home| vec![home.join(".gemini").join(".env"), home.join(".env")])
        .unwrap_or_default()
}

pub(crate) fn api_key_set() -> bool {
    has_key(
        &crate::provider_settings::environment("gemini"),
        |name| std::env::var(name).ok(),
        &home_env_files(),
    )
}

pub(super) async fn models(path: &Path) -> Result<Vec<ModelInfo>, String> {
    if let Some(models) = acp_catalog::get("gemini", path) {
        return Ok(models);
    }
    let _refresh = acp_catalog::refresh_lock("gemini", path).await;
    if let Some(models) = acp_catalog::get("gemini", path) {
        return Ok(models);
    }
    let discovery = acp_catalog::begin("gemini", path);
    let mut command = super::provider_command("gemini", path)?;
    configure(&mut command);
    let (metadata, _) = acp::inspect_with(command, &std::env::temp_dir(), false, true)
        .await
        .map_err(|error| if error.contains("Authentication") || error.contains("API key") { format!("{SIGN_IN}\n{error}") } else { error })?;
    acp_catalog::store(discovery, &metadata);
    Ok(acp::parse_models(&metadata))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// initialize and session/new as recorded from Gemini CLI 0.70.0.
    fn initialize() -> Value {
        json!({"protocolVersion":1,"authMethods":[
            {"id":"oauth-personal","name":"Log in with Google"},
            {"id":"gemini-api-key","name":"Gemini API key","_meta":{"api-key":{"provider":"google"}}},
            {"id":"vertex-ai","name":"Vertex AI"},
            {"id":"gateway","name":"AI API Gateway"}],
            "agentInfo":{"name":"gemini-cli","title":"Gemini CLI","version":"0.70.0"},
            "agentCapabilities":{"loadSession":true,"promptCapabilities":{"image":true,"audio":true,"embeddedContext":true},"mcpCapabilities":{"http":true,"sse":true}}})
    }

    fn session() -> Value {
        json!({"sessionId":"7ce92899-e8a3-42a3-a4a8-ef8b2cc6dc5b",
            "modes":{"availableModes":[
                {"id":"default","name":"Default"},{"id":"autoEdit","name":"Auto Edit"},
                {"id":"yolo","name":"YOLO"},{"id":"plan","name":"Plan"}],"currentModeId":"default"},
            "models":{"availableModels":[
                {"modelId":"auto","name":"Auto","description":"Let Gemini CLI decide the best model for the task"},
                {"modelId":"gemini-2.5-pro","name":"gemini-2.5-pro"},
                {"modelId":"gemini-3.8-flash","name":"gemini-3.8-flash"}],"currentModelId":"auto"}})
    }

    #[test]
    fn gemini_session_models_are_parsed_after_default() {
        let models = acp::parse_models(&session());
        assert_eq!(models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["default", "auto", "gemini-2.5-pro", "gemini-3.8-flash"]);
    }

    #[test]
    fn every_approval_mode_maps_to_an_advertised_session_mode() {
        let advertised = session();
        let ids: Vec<&str> = advertised["modes"]["availableModes"].as_array().unwrap().iter().map(|m| m["id"].as_str().unwrap()).collect();
        for mode in ["plan", "ask", "auto", "full"] {
            assert!(ids.contains(&mode_id(mode)), "{mode}");
        }
        assert_eq!(mode_id("plan"), "plan");
        assert_eq!(mode_id("ask"), "default");
        assert_eq!(mode_id("auto"), "autoEdit");
        assert_eq!(mode_id("full"), "yolo");
    }

    #[test]
    fn api_key_auth_is_chosen_only_for_gemini() {
        assert_eq!(login_method("gemini", &initialize()), Some("gemini-api-key"));
        assert_eq!(login_method("cursor", &initialize()), None);
        assert_eq!(login_method("gemini", &json!({"authMethods":[{"id":"oauth-personal"}]})), None);
    }

    #[test]
    fn configure_starts_acp_and_trusts_the_project() {
        let mut command = Command::new("gemini");
        configure(&mut command);
        assert_eq!(command.as_std().get_args().collect::<Vec<_>>(), ["--acp", "--skip-trust"]);
    }

    #[test]
    fn key_is_found_in_saved_environment_process_or_env_file() {
        let none = |_: &str| None;
        assert!(!has_key(&[], none, &[]));
        assert!(has_key(&[("GEMINI_API_KEY".into(), "k".into())], none, &[]));
        assert!(!has_key(&[("GEMINI_API_KEY".into(), "  ".into())], none, &[]));
        assert!(!has_key(&[("OTHER".into(), "k".into())], none, &[]));
        assert!(has_key(&[], |name| (name == "GOOGLE_API_KEY").then(|| "k".into()), &[]));
        let dir = std::env::temp_dir().join(format!("pandacode-gemini-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join(".env");
        std::fs::write(&file, "# comment\nOTHER=1\nGEMINI_API_KEY=\n").unwrap();
        assert!(!has_key(&[], none, std::slice::from_ref(&file)));
        std::fs::write(&file, "export GEMINI_API_KEY=\"abc\"\n").unwrap();
        assert!(has_key(&[], none, std::slice::from_ref(&file)));
        assert!(!has_key(&[], none, &[dir.join("missing.env")]));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_turn_authenticates_with_the_key_then_selects_the_mode() {
        let mut config = super::super::tests::config("gemini");
        config.mode = "full".into();
        let mut p = Protocol::new(config);
        let auth = p.receive(json!({"jsonrpc":"2.0","id":1,"result":initialize()})).unwrap();
        assert_eq!(auth.write[0]["method"], "authenticate");
        assert_eq!(auth.write[0]["params"]["methodId"], "gemini-api-key");
        let new = p.receive(json!({"jsonrpc":"2.0","id":7,"result":{}})).unwrap();
        assert_eq!(new.write[0]["method"], "session/new");
        let mode = p.receive(json!({"jsonrpc":"2.0","id":2,"result":session()})).unwrap();
        let set = mode.write.iter().find(|frame| frame["method"] == "session/set_mode").expect("a mode request");
        assert_eq!(set["params"]["modeId"], "yolo");
    }

    #[test]
    fn a_rejected_key_names_where_to_put_it() {
        let mut p = Protocol::new(super::super::tests::config("gemini"));
        p.receive(json!({"jsonrpc":"2.0","id":1,"result":initialize()})).unwrap();
        let error = p.receive(json!({"jsonrpc":"2.0","id":7,"error":{"code":-32000,"message":"Authentication required"}})).err().unwrap();
        assert!(error.starts_with(SIGN_IN), "{error}");
    }

    #[tokio::test]
    #[ignore = "requires an installed Gemini CLI with a Gemini API key"]
    async fn installed_gemini_lists_models() {
        let path = executable("gemini").expect("Install Gemini CLI and set GEMINI_API_KEY first");
        let models = models(&path).await.expect("Gemini ACP discovery should succeed");
        assert!(models.len() > 1, "{models:?}");
    }

    #[tokio::test]
    #[ignore = "requires an installed Gemini CLI with a Gemini API key; sends a prompt"]
    async fn installed_gemini_runs_a_task() {
        let cwd = std::env::temp_dir().join(format!("pandacode-gemini-live-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&cwd).unwrap();
        let mut config = super::super::tests::config("gemini");
        config.cwd = cwd.clone();
        config.prompt = "Reply with exactly the word PANDA and nothing else.".into();
        let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::<crate::providers::AgentEvent>::new()));
        let seen = events.clone();
        let sink: crate::providers::Sink = std::sync::Arc::new(move |event| seen.lock().unwrap().push(event));
        let (_input, receiver) = tokio::sync::mpsc::unbounded_channel::<crate::providers::RunInput>();
        super::super::run(config, sink, receiver).await.expect("the turn should finish");
        let text = events.lock().unwrap().iter().filter(|e| e.kind == "text" || e.kind == "delta").map(|e| e.text.clone()).collect::<String>();
        assert!(text.contains("PANDA"), "{text}");
        let _ = std::fs::remove_dir_all(&cwd);
    }
}
