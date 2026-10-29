use super::{claude::parse_entries, Catalog};
use serde_json::Value;
use std::{collections::HashSet, path::Path};

pub(super) const NO_COMMANDS: &str = "The harness did not advertise additional commands. Start a task or refresh to sync its command list.";

pub(super) async fn discover(provider: &str, cwd: &Path) -> Result<Catalog, String> {
    let path = crate::providers::executable(provider)
        .ok_or("Install the harness ACP server or choose its executable in Settings → Agents.")?;
    if provider == "devin" {
        // Devin's discovery session is deleted afterwards, and its models come
        // from their own fuller probe, so this catalog never replaces them.
        let frame = crate::providers::devin_commands(&path, cwd).await?;
        return frame.as_ref().and_then(|frame| parse_runtime(provider, frame)).ok_or(NO_COMMANDS.into());
    }
    let mut command = crate::providers::provider_command(provider, &path)?;
    match provider {
        "opencode" => {
            command.arg("acp");
        }
        "kilo" => {
            command.arg("acp").env("KILO_DISABLE_AUTOUPDATE", "true");
        }
        // Command Code serves ACP from its `acp` command and reads the saved key
        // before its own login.
        "commandcode" => {
            command.arg("acp");
            crate::providers::commandcode_key_environment(&mut command);
        }
        // Grok Build publishes its command list right after session/new, which
        // needs the cached-credential authenticate step first.
        "cline" => {
            command.arg("--acp");
        }
        "grok" => {
            command.args(["--no-auto-update", "agent", "stdio"]);
        }
        "github-copilot" => {
            command.args(["--no-auto-update", "--acp", "--stdio"]);
        }
        "hermes" => {
            crate::providers::hermes::configure_command(&mut command, &path);
        }
        "nanobot" => {
            crate::providers::nanobot::configure_command(&mut command, &path);
        }
        _ => {
            #[cfg(target_os = "linux")]
            command.arg("--uid=");
        }
    }
    let discovery = crate::providers::acp_catalog::begin(provider, &path);
    let (metadata, frame) = crate::providers::acp::inspect_with(command, cwd, true, provider == "grok").await?;
    // Model choices can be reused by the model picker, even when this session
    // never advertises commands. Commands themselves remain scoped to cwd.
    crate::providers::acp_catalog::store(discovery, &metadata);
    frame
        .as_ref()
        .and_then(|frame| parse_runtime(provider, frame))
        .ok_or(NO_COMMANDS.into())
}

pub(super) fn parse_runtime(provider: &str, frame: &Value) -> Option<Catalog> {
    if frame["method"] != "session/update"
        || frame["params"]["update"]["sessionUpdate"] != "available_commands_update"
    {
        return None;
    }
    let entries = frame["params"]["update"]["availableCommands"].as_array()?;
    if provider == "devin" {
        let hidden = |entry: &&Value| entry["name"].as_str().is_some_and(|name| crate::providers::DEVIN_HIDDEN_COMMANDS.contains(&name));
        let shown: Vec<Value> = entries.iter().filter(|entry| !hidden(entry)).cloned().collect();
        return Some(parse_entries(&shown, provider, &HashSet::new()));
    }
    Some(parse_entries(entries, provider, &HashSet::new()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn devin_account_and_mode_commands_stay_with_its_cli_and_the_mode_picker() {
        let frame = json!({"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"available_commands_update","availableCommands":[
            {"name":"login","description":"Authenticate with an API key","input":{"hint":"[api-key]"}},
            {"name":"bypass","description":"Switch to Bypass Permissions mode"},
            {"name":"compact","description":"Compact the conversation"},
            {"name":"review","description":"Review changes"}]}}});
        let catalog = parse_runtime("devin", &frame).unwrap();
        let ids: Vec<_> = catalog.commands.iter().map(|command| command.id.as_str()).collect();
        assert_eq!(ids, ["devin:/compact", "devin:/review"]);
    }

    #[test]
    fn commands_use_real_provider_names_and_advertised_hints() {
        for provider in ["opencode", "kilo", "antigravity", "grok", "github-copilot", "hermes", "nanobot"] {
            let catalog = parse_runtime(provider,&json!({"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"available_commands_update","availableCommands":[{"name":"review","description":"Review changes","input":{"hint":"[focus]"}}]}}})).unwrap();
            assert_eq!(catalog.commands[0].id, format!("{provider}:/review"));
            assert_eq!(
                catalog.commands[0].argument_hint.as_deref(),
                Some("[focus]")
            );
        }
    }
}
