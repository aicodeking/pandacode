//! Muse Code lists its skills over MSP `skill/list`, which needs a session. The
//! host runs memory-only (`--no-session-log`) in the task folder, so project
//! skills load and nothing is saved; no prompt is sent.
use super::{
    claude::{parse_entries, Pipe},
    Catalog,
};
use serde_json::{json, Value};
use std::{collections::HashSet, path::Path, time::Duration};

const DISCOVERY_FAILED: &str =
    "Muse Code skills could not be loaded. Check the installed CLI and its login, then try again.";

pub async fn discover(cwd: &Path) -> Result<Catalog, String> {
    let path = crate::providers::executable("muse").ok_or("Install the harness to discover its commands.")?;
    let mut command = crate::providers::provider_command("muse", &path)?;
    command.args(["serve", "--no-session-log"]).args(crate::providers::privacy::muse_arguments()).env("MUSE_LOGIN", "0");
    let mut pipe = Pipe::spawn(command, cwd, Duration::from_secs(20)).map_err(|_| DISCOVERY_FAILED.to_owned())?;
    let result = async {
        pipe.send(&json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"pandacode","version":env!("CARGO_PKG_VERSION")}}})).await?;
        loop {
            let value = pipe.read().await?;
            if value.get("error").is_some() {
                return Err(());
            }
            match value["id"].as_u64() {
                Some(1) => {
                    pipe.send(&json!({"jsonrpc":"2.0","method":"initialized"})).await?;
                    let params = json!({"commandId":uuid::Uuid::now_v7().to_string(),"workspaceRoot":cwd});
                    pipe.send(&json!({"jsonrpc":"2.0","id":2,"method":"session/start","params":params})).await?;
                }
                Some(2) => {
                    let session = value["result"]["session"]["sessionId"].as_str().ok_or(())?;
                    pipe.send(&json!({"jsonrpc":"2.0","id":3,"method":"skill/list","params":{"sessionId":session}})).await?;
                }
                Some(3) => return parse(&value["result"]).ok_or(()),
                _ => {}
            }
        }
    }
    .await;
    pipe.finish().await;
    result.map_err(|_| DISCOVERY_FAILED.to_owned())
}

/// Each skill's selector is its `/command`; the run sends it as an MSP skill part.
fn parse(result: &Value) -> Option<Catalog> {
    let entries: Vec<_> = result["skills"]
        .as_array()?
        .iter()
        .map(|skill| json!({"name":skill["selector"],"description":skill["description"],"argumentHint":skill["argumentHint"]}))
        .collect();
    Some(parse_entries(&entries, "muse", &HashSet::new()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skills_become_commands() {
        // Recorded `skill/list` entries (descriptions shortened).
        let catalog = parse(&json!({"skills":[
            {"selector":"agents-sdk","displayName":"agents-sdk","description":"Build Cloudflare Agents SDK applications.","source":"user"},
            {"selector":"review","displayName":"review","description":"Review changes","argumentHint":"[path]","source":"plugin","pluginId":"p"}
        ]}))
        .unwrap();
        let names: Vec<_> = catalog.commands.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["/agents-sdk", "/review"]);
        assert_eq!(catalog.commands[0].id, "muse:/agents-sdk");
        assert_eq!(catalog.commands[1].argument_hint.as_deref(), Some("[path]"));
        assert!(parse(&json!({})).is_none());
    }
}
