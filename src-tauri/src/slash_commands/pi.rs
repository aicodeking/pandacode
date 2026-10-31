//! Pi lists extension commands, prompt templates and skills over RPC `get_commands`.
//! The process runs in the task folder so project resources load; no prompt is sent.
use super::{
    claude::{parse_entries, Pipe},
    Catalog,
};
use serde_json::{json, Value};
use std::{collections::HashSet, path::Path, time::Duration};
use tokio::process::Command;

const DISCOVERY_FAILED: &str =
    "Pi commands could not be loaded. Check the installed CLI and its configuration, then try again.";
const REQUEST_ID: &str = "pandacode-commands";

/// Pi and its fork omp (which names the request `get_available_commands`).
pub async fn discover(provider: &str, cwd: &Path) -> Result<Catalog, String> {
    let path = crate::providers::executable(provider).ok_or("Install the harness to discover its commands.")?;
    let mut command = crate::providers::provider_command(provider, &path)?;
    command.args(["--mode", "rpc", "--no-session"]);
    let request = if provider == "omp" { "get_available_commands" } else { "get_commands" };
    discover_process(command, cwd, Duration::from_secs(15), provider, request).await
}

async fn discover_process(command: Command, cwd: &Path, timeout: Duration, provider: &str, request: &str) -> Result<Catalog, String> {
    let mut pipe = Pipe::spawn(command, cwd, timeout).map_err(|_| DISCOVERY_FAILED.to_owned())?;
    let result = async {
        pipe.send(&json!({"type":request,"id":REQUEST_ID})).await?;
        loop {
            let value = pipe.read().await?;
            if value["type"] == "response" && value["id"] == REQUEST_ID {
                return parse(&value, provider).ok_or(());
            }
        }
    }
    .await;
    pipe.finish().await;
    result.map_err(|_| DISCOVERY_FAILED.to_owned())
}

fn parse(response: &Value, provider: &str) -> Option<Catalog> {
    if response["success"] != true {
        return None;
    }
    let commands = response["data"]["commands"].as_array()?;
    Some(parse_entries(commands, provider, &HashSet::new()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn response() -> Value {
        json!({"type":"response","command":"get_commands","id":REQUEST_ID,"success":true,"data":{"commands":[
            {"name":"fix-tests","description":"Fix failing tests","source":"prompt","sourceInfo":{"path":"/p/.pi/agent/prompts/fix-tests.md","source":"local","scope":"project","origin":"top-level"}},
            {"name":"skill:brave-search","description":"Web search","source":"skill"},
            {"name":"deploy","source":"extension"},
            {"name":"bad name!","source":"extension"}
        ]}})
    }

    #[test]
    fn maps_prompts_skills_and_extensions() {
        let catalog = parse(&response(), "pi").unwrap();
        let names: Vec<_> = catalog.commands.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["/fix-tests", "/skill:brave-search", "/deploy"]);
        assert_eq!(catalog.commands[0].id, "pi:/fix-tests");
        assert_eq!(catalog.commands[0].description, "Fix failing tests");
        assert_eq!(catalog.commands[2].description, "");
    }

    #[test]
    fn maps_omp_available_commands() {
        let frame = json!({"type":"response","command":"get_available_commands","id":REQUEST_ID,"success":true,"data":{"commands":[
            {"name":"review","description":"Review changes","input":{"hint":"[path]"},"source":"builtin"}
        ]}});
        let catalog = parse(&frame, "omp").unwrap();
        assert_eq!(catalog.commands[0].id, "omp:/review");
    }

    #[test]
    fn failed_response_is_an_error() {
        assert!(parse(&json!({"type":"response","success":false,"error":"x"}), "pi").is_none());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn reads_commands_from_a_process_and_ignores_other_frames() {
        let script = format!(
            "read line; echo '{{\"type\":\"agent_start\"}}'; echo '{}'",
            response()
        );
        let mut command = Command::new("sh");
        command.args(["-c", &script]);
        let catalog = discover_process(command, &std::env::temp_dir(), Duration::from_secs(5), "pi", "get_commands")
            .await
            .unwrap();
        assert_eq!(catalog.commands.len(), 3);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn exit_without_response_fails() {
        let mut command = Command::new("sh");
        command.args(["-c", "read line"]);
        assert!(discover_process(command, &std::env::temp_dir(), Duration::from_secs(5), "pi", "get_commands")
            .await
            .is_err());
    }
}
