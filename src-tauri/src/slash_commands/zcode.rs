//! ZCode slash commands from a throwaway `session/create` snapshot. The
//! app-server lists builtins (`/goal`, `/compact`) and the user's custom
//! commands on that result; nothing is sent as a prompt.
use super::{claude::parse_entries, Catalog};
use serde_json::{json, Value};
use std::{collections::HashSet, path::Path};

const DISCOVERY_FAILED: &str =
    "ZCode commands could not be loaded. Check the installed CLI and try again.";
/// Stdout cap for slash discovery, matching the shared `Pipe` total-bytes cap.
const DISCOVERY_OUTPUT_LIMIT: u64 = 8 * 1024 * 1024;

pub async fn discover(cwd: &Path) -> Result<Catalog, String> {
    let path =
        crate::providers::executable("zcode").ok_or("Install ZCode to discover its commands.")?;
    let mut command = crate::providers::provider_command("zcode", &path)?;
    command.arg("app-server");
    let snapshot = crate::providers::zcode::create_snapshot(command, cwd, DISCOVERY_OUTPUT_LIMIT)
        .await
        .map_err(|_| DISCOVERY_FAILED.to_owned())?;
    parse_snapshot(&snapshot).ok_or_else(|| DISCOVERY_FAILED.to_owned())
}

/// Create-snapshot `slashCommands`: `{name, description, inputHint, source}`.
pub(super) fn parse_snapshot(result: &Value) -> Option<Catalog> {
    let entries: Vec<_> = result["slashCommands"]
        .as_array()?
        .iter()
        .map(|entry| {
            json!({
                "name": entry["name"],
                "description": entry["description"],
                "argumentHint": entry["inputHint"],
            })
        })
        .collect();
    Some(parse_entries(&entries, "zcode", &HashSet::new()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_commands_become_native_prompts() {
        let catalog = parse_snapshot(&json!({
            "slashCommands": [
                {"name": "goal", "description": "Set the session goal", "inputHint": "<goal>", "source": "builtin"},
                {"name": "compact", "description": "Compact the conversation", "source": "builtin"},
                {"name": "ship", "description": "Prepare a PR", "inputHint": "[title]", "source": "user"},
            ]
        }))
        .unwrap();
        let names: Vec<_> = catalog.commands.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["/goal", "/compact", "/ship"]);
        assert_eq!(catalog.commands[0].argument_hint.as_deref(), Some("<goal>"));
        assert_eq!(catalog.commands[1].kind, "prompt");
        assert!(matches!(
            catalog.commands[1].invocation,
            super::super::Invocation::Native
        ));
        assert_eq!(catalog.commands[2].source, "zcode");
        assert!(parse_snapshot(&json!({})).is_none());
    }
}
