use super::{claude::parse_entries, Catalog};
use serde_json::Value;
use std::{collections::HashSet, path::Path};

pub(super) const NO_COMMANDS: &str = "The harness did not advertise additional commands. Start a task or refresh to sync its command list.";

pub(super) async fn discover(provider: &str, cwd: &Path) -> Result<Catalog, String> {
    let path = crate::providers::executable(provider)
        .ok_or("Install the harness ACP server or choose its executable in Settings → Agents.")?;
    let mut command = crate::providers::command(&path)?;
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
    Some(parse_entries(
        frame["params"]["update"]["availableCommands"].as_array()?,
        provider,
        &HashSet::new(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn commands_use_real_provider_names_and_advertised_hints() {
        for provider in ["opencode", "kilo", "antigravity", "grok", "github-copilot"] {
            let catalog = parse_runtime(provider,&json!({"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"available_commands_update","availableCommands":[{"name":"review","description":"Review changes","input":{"hint":"[focus]"}}]}}})).unwrap();
            assert_eq!(catalog.commands[0].id, format!("{provider}:/review"));
            assert_eq!(
                catalog.commands[0].argument_hint.as_deref(),
                Some("[focus]")
            );
        }
    }
}
