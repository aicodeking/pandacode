//! GitHub Copilot CLI over its local ACP stdio server. Authentication remains
//! owned by Copilot CLI; discovery and task startup do not add an app auth flow.
use super::*;

pub(super) async fn models(path: &Path) -> Result<Vec<ModelInfo>, String> {
    if let Some(models) = acp_catalog::get("github-copilot", path) {
        return Ok(models);
    }
    let _refresh = acp_catalog::refresh_lock("github-copilot", path).await;
    if let Some(models) = acp_catalog::get("github-copilot", path) {
        return Ok(models);
    }
    let discovery = acp_catalog::begin("github-copilot", path);
    let mut command = super::provider_command("github-copilot", path)?;
    command.args(["--no-auto-update", "--acp", "--stdio"]);
    let (metadata, _) = acp::inspect(command, &std::env::temp_dir(), false).await.map_err(|error| {
        if error.contains("Authentication is required") {
            "GitHub Copilot CLI requires sign-in. Run `copilot login` in a terminal, then retry.".to_owned()
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

    /// Recorded from Copilot CLI 1.0.82 `session/new`; it advertises modes and
    /// Allow All but no model option, so PandaCode keeps the Default choice.
    fn session() -> Value {
        json!({"sessionId":"copilot-session","configOptions":[
            {"type":"select","id":"mode","name":"Mode","currentValue":"https://agentclientprotocol.com/protocol/session-modes#agent","options":[
                {"value":"https://agentclientprotocol.com/protocol/session-modes#agent","name":"Agent"},
                {"value":"https://agentclientprotocol.com/protocol/session-modes#plan","name":"Plan"},
                {"value":"https://agentclientprotocol.com/protocol/session-modes#autopilot","name":"Autopilot"}],"category":"mode"},
            {"type":"select","id":"allow_all","name":"Allow All","currentValue":"off","options":[{"value":"on","name":"On"},{"value":"off","name":"Off"}],"category":"permissions"}],
            "modes":{"availableModes":[
                {"id":"https://agentclientprotocol.com/protocol/session-modes#agent","name":"Agent"},
                {"id":"https://agentclientprotocol.com/protocol/session-modes#plan","name":"Plan"},
                {"id":"https://agentclientprotocol.com/protocol/session-modes#autopilot","name":"Autopilot"}]}})
    }

    #[test]
    fn copilot_session_without_a_catalog_resolves_to_default_only() {
        let models = acp::parse_models(&session());
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "default");
    }

    #[test]
    fn copilot_session_advertised_models_are_used_and_default_is_retained() {
        let mut metadata = session();
        metadata["configOptions"]
            .as_array_mut()
            .unwrap()
            .push(json!({
                "type":"select","id":"model","category":"model","currentValue":"gpt-test",
                "options":[{"value":"gpt-test","name":"Copilot Test Model"}]
            }));
        let models = acp::parse_models(&metadata);
        assert_eq!(
            models
                .iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>(),
            ["default", "gpt-test"]
        );
        assert_eq!(models[1].name, "Copilot Test Model");
    }

    /// Requires GitHub Copilot CLI to be installed and signed in with `copilot login`.
    #[tokio::test]
    #[ignore = "requires installed and authenticated GitHub Copilot CLI"]
    async fn installed_authenticated_copilot_cli_opens_metadata_session_without_prompt() {
        let path = executable("github-copilot").expect("Install GitHub Copilot CLI first");
        let models = models(&path)
            .await
            .expect("Copilot ACP metadata session should open");
        assert!(models.iter().any(|model| model.id == "default"));
    }
}
