//! ZCode slash commands from a throwaway `session/create` snapshot. The
//! app-server lists builtins (`/goal`, `/compact`) and the user's custom
//! commands on that result; nothing is sent as a prompt.
use super::{
    claude::{parse_entries, Pipe},
    Catalog,
};
use serde_json::{json, Value};
use std::{collections::HashSet, path::Path, time::Duration};

const DISCOVERY_FAILED: &str =
    "ZCode commands could not be loaded. Check the installed CLI and try again.";

pub async fn discover(cwd: &Path) -> Result<Catalog, String> {
    let path =
        crate::providers::executable("zcode").ok_or("Install ZCode to discover its commands.")?;
    let mut command = crate::providers::provider_command("zcode", &path)?;
    command.arg("app-server");
    let mut pipe = Pipe::spawn(command, cwd, Duration::from_secs(20))
        .map_err(|_| DISCOVERY_FAILED.to_owned())?;
    let result = async {
        let workspace = cwd.to_string_lossy().to_string();
        pipe.send(&json!({"id": 1, "method": "session/create", "params": {
            "workspace": {"workspacePath": workspace, "workspaceKey": workspace},
            "persistence": "deferred",
            "mode": "plan",
            "titleGenerationEnabled": false,
        }}))
        .await?;
        loop {
            let value = pipe.read().await?;
            if value.get("method").is_some() && value.get("id").is_some() {
                pipe.send(&json!({"id": value["id"], "error": {"code": -32601, "message": "Method not found"}}))
                    .await?;
                continue;
            }
            if value["id"] != 1 {
                continue;
            }
            if value.get("error").is_some() {
                return Err(());
            }
            if let Some(session) = value["result"]["session"]["sessionId"].as_str() {
                let _ = pipe
                    .send(&json!({"id": 2, "method": "session/close", "params": {"sessionId": session}}))
                    .await;
            }
            return parse_snapshot(&value["result"]).ok_or(());
        }
    }
    .await;
    pipe.finish().await;
    result.map_err(|_| DISCOVERY_FAILED.to_owned())
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
