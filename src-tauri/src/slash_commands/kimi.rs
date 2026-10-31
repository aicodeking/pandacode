//! The ACP command surface differs from Kimi's interactive terminal commands.
use super::{
    claude::{parse_entries, Pipe},
    Catalog, Invocation, SlashCommand,
};
use crate::providers::executable;
use serde_json::{json, Value};
use std::{collections::HashSet, path::Path, time::Duration};
use tokio::process::Command;

const DISCOVERY_FAILED: &str = "Kimi Code commands could not be loaded. Check the installed CLI and its account setup, then try again.";
pub(super) const AUTH_REQUIRED: &str =
    "Kimi Code requires authentication. Run kimi login in a terminal, then refresh commands.";

pub async fn discover(cwd: &Path) -> Result<Catalog, String> {
    let path = executable("kimi").ok_or("Install Kimi Code to discover its commands.")?;
    let mut command = crate::providers::provider_command("kimi", &path)?;
    command.arg("acp");
    discover_process(command, cwd, Duration::from_secs(20)).await
}

async fn discover_process(
    command: Command,
    cwd: &Path,
    timeout: Duration,
) -> Result<Catalog, String> {
    let mut pipe = Pipe::spawn(command, cwd, timeout).map_err(|_| DISCOVERY_FAILED.to_owned())?;
    let mut failure_warning = DISCOVERY_FAILED;
    let result = async {
        pipe.send(&json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{},"clientInfo":{"name":"PandaCode","version":env!("CARGO_PKG_VERSION")}}})).await?;
        loop {
            let value = pipe.read().await?;
            if reject_request(&mut pipe, &value).await? { continue; }
            if value["id"] == 1 {
                if authentication_required(&value) { failure_warning = AUTH_REQUIRED; }
                if !value["result"].is_object() || value.get("error").is_some() { return Err(()); }
                break;
            }
        }
        // This creates only a provider session so its scoped skills can load;
        // it never sends a prompt, starts login, or touches an existing session.
        pipe.send(&json!({"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":cwd,"mcpServers":[]}})).await?;
        let mut session_id: Option<String> = None;
        let mut pending: Option<(String, Catalog)> = None;
        loop {
            let value = pipe.read().await?;
            if reject_request(&mut pipe, &value).await? { continue; }
            if value["id"] == 2 {
                if authentication_required(&value) { failure_warning = AUTH_REQUIRED; }
                if value.get("error").is_some() { return Err(()); }
                let id = value["result"]["sessionId"].as_str().filter(|id| id.len() <= 256).ok_or(())?;
                if let Some((pending_id, catalog)) = pending.take() {
                    if pending_id == id { return Ok(catalog); }
                }
                session_id = Some(id.to_owned());
            } else if let Some(catalog) = parse_runtime(&value) {
                let id = value["params"]["sessionId"].as_str().filter(|id| id.len() <= 256).ok_or(())?;
                if session_id.as_deref() == Some(id) { return Ok(catalog); }
                if session_id.is_none() { pending = Some((id.to_owned(), catalog)); }
            }
        }
    }.await;
    pipe.finish().await;
    result.map_err(|_| failure_warning.to_owned())
}

fn authentication_required(value: &Value) -> bool {
    value["error"]["code"].as_i64() == Some(-32000)
        && value["error"]["message"].as_str() == Some("Authentication required")
}

async fn reject_request(pipe: &mut Pipe, value: &Value) -> Result<bool, ()> {
    if value.get("method").is_some() {
        if let Some(id) = value
            .get("id")
            .filter(|id| id.is_string() || id.is_number())
        {
            pipe.send(&json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"Command discovery does not execute requests"}})).await?;
            return Ok(true);
        }
    }
    Ok(false)
}

pub fn parse_runtime(value: &Value) -> Option<Catalog> {
    if value["method"] != "session/update"
        || value["params"]["update"]["sessionUpdate"] != "available_commands_update"
    {
        return None;
    }
    let commands = value["params"]["update"]["availableCommands"].as_array()?;
    Some(parse_entries(commands, "kimi", &HashSet::new()))
}

/// ACP omits parts of the interactive UI registry. These compatibility names
/// are from active Kimi Code 0.26.0's `src/tui/commands/registry.ts` (the bundled
/// TypeScript CLI, not the separate legacy Python package). ACP metadata wins
/// whenever it advertises the same spelling; fallbacks only open the real TUI.
pub(super) fn terminal_commands() -> Vec<SlashCommand> {
    [
        (
            "yolo",
            "Toggle YOLO mode: AI auto-approves safe actions, asks for approval on risky ones.",
        ),
        (
            "yes",
            "Toggle YOLO mode: AI auto-approves safe actions, asks for approval on risky ones.",
        ),
        (
            "auto",
            "Toggle Auto mode: run all actions automatically, including risky ones.",
        ),
        ("permission", "Select permission mode"),
        ("settings", "Open TUI settings"),
        ("config", "Open TUI settings"),
        ("plan", "Toggle plan mode"),
        ("swarm", "Toggle swarm mode or run one task in swarm mode"),
        ("model", "Switch LLM model"),
        ("effort", "Switch thinking effort"),
        ("thinking", "Switch thinking effort"),
        ("provider", "Manage AI providers (add / delete / refresh)"),
        ("providers", "Manage AI providers (add / delete / refresh)"),
        ("btw", "Ask a forked side agent a question"),
        ("help", "Show available commands and shortcuts"),
        ("h", "Show available commands and shortcuts"),
        ("?", "Show available commands and shortcuts"),
        ("new", "Start a fresh session in the current workspace"),
        ("clear", "Start a fresh session in the current workspace"),
        ("sessions", "Browse and resume sessions"),
        ("resume", "Browse and resume sessions"),
        ("tasks", "Browse background tasks"),
        ("task", "Browse background tasks"),
        ("mcp", "Show MCP server status"),
        ("plugins", "Manage plugins"),
        ("add-dir", "Add or list an additional workspace directory"),
        ("experiments", "Manage experimental features"),
        ("experimental", "Manage experimental features"),
        (
            "reload",
            "Reload session and apply config.toml settings plus tui.toml UI preferences",
        ),
        ("reload-tui", "Reload only tui.toml UI preferences"),
        ("compact", "Compact the conversation context"),
        ("goal", "Start or manage an autonomous goal"),
        ("init", "Analyze the codebase and generate AGENTS.md"),
        ("fork", "Fork the current session"),
        ("title", "Set or show session title"),
        ("rename", "Set or show session title"),
        (
            "usage",
            "Show session tokens + context window + plan quotas",
        ),
        ("status", "Show current session and runtime status"),
        ("feedback", "Send feedback to make Kimi Code better"),
        ("undo", "Withdraw the last prompt from the transcript"),
        ("editor", "Set the external editor for Ctrl-G"),
        ("theme", "Set the terminal UI theme"),
        ("logout", "Log out of a configured provider"),
        ("disconnect", "Log out of a configured provider"),
        ("login", "Select a platform and authenticate"),
        ("export-md", "Export current session as a Markdown file"),
        ("export", "Export current session as a Markdown file"),
        (
            "export-debug-zip",
            "Export current session as a debug ZIP archive",
        ),
        (
            "web",
            "Open the current session in the Web UI and exit the terminal",
        ),
        ("exit", "Exit the application"),
        ("quit", "Exit the application"),
        ("q", "Exit the application"),
        ("version", "Show version information"),
    ]
    .into_iter()
    .map(|(name, description)| SlashCommand {
        id: format!("kimi:console:{name}"),
        name: format!("/{name}"),
        description: description.into(),
        argument_hint: Some("[arguments]".into()),
        kind: "action".into(),
        source: "Kimi console".into(),
        reason: None,
        invocation: Invocation::Action(format!("console:{name}")),
    })
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commands_are_authoritative_including_empty_replacements() {
        let value = json!({"method":"session/update","params":{"sessionId":"one","update":{"sessionUpdate":"available_commands_update","availableCommands":[
            {"name":"help","description":"Show ACP commands"},
            {"name":"skill:review","description":"Review code","input":{"hint":"[path]"}}
        ]}}});
        let catalog = parse_runtime(&value).unwrap();
        assert_eq!(catalog.commands.len(), 2);
        assert_eq!(catalog.commands[1].name, "/skill:review");
        assert_eq!(catalog.commands[1].argument_hint.as_deref(), Some("[path]"));
        assert!(matches!(
            catalog.commands[0].invocation,
            super::super::Invocation::Native
        ));
        let mut empty = value;
        empty["params"]["update"]["availableCommands"] = json!([]);
        assert!(parse_runtime(&empty).unwrap().commands.is_empty());
        assert!(parse_runtime(&json!({"method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"text":"/help"}}}})).is_none());
    }

    #[test]
    fn authentication_warning_requires_the_exact_public_protocol_error() {
        assert!(authentication_required(
            &json!({"error":{"code":-32000,"message":"Authentication required","data":{"private":"not forwarded"}}})
        ));
        for value in [
            json!({"error":{"code":-32001,"message":"Authentication required"}}),
            json!({"error":{"code":-32000,"message":"Authentication required: SECRET"}}),
            json!({"error":{"code":"-32000","message":"Authentication required"}}),
            json!({"error":{"code":-32000}}),
        ] {
            assert!(!authentication_required(&value));
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn discovers_early_notification_without_prompt_or_authentication() {
        let _serial = crate::providers::concurrent_process_tests::process_test_lock()
            .lock()
            .await;
        let mut command = Command::new("/bin/sh");
        command.args(["-c", r#"
            read -r init
            case "$init" in *'"method":"initialize"'*) ;; *) exit 1 ;; esac
            printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}'
            read -r request
            case "$request" in *'"method":"session/new"'*) ;; *) exit 2 ;; esac
            printf '%s\n' '{"method":"session/update","params":{"sessionId":"new-session","update":{"sessionUpdate":"available_commands_update","availableCommands":[{"name":"help","description":"Show ACP help"},{"name":"compact","description":"Compact context"}]}}}'
            printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"sessionId":"new-session"}}'
            read -r unexpected
            exit 3
        "#]);
        let result = discover_process(command, &std::env::temp_dir(), Duration::from_secs(2))
            .await
            .unwrap();
        assert_eq!(
            result
                .commands
                .iter()
                .map(|c| c.name.as_str())
                .collect::<Vec<_>>(),
            ["/help", "/compact"]
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn rejects_reverse_requests_and_does_not_accept_another_sessions_catalog() {
        let _serial = crate::providers::concurrent_process_tests::process_test_lock()
            .lock()
            .await;
        let mut command = Command::new("/bin/sh");
        command.args(["-c", r#"
            read -r init
            printf '%s\n' '{"id":1,"result":{}}'
            read -r request
            printf '%s\n' '{"id":9,"method":"session/request_permission","params":{}}'
            read -r denied
            case "$denied" in *'"code":-32601'*) ;; *) exit 2 ;; esac
            printf '%s\n' '{"id":2,"result":{"sessionId":"current"}}'
            printf '%s\n' '{"method":"session/update","params":{"sessionId":"other","update":{"sessionUpdate":"available_commands_update","availableCommands":[{"name":"wrong"}]}}}'
            printf '%s\n' '{"method":"session/update","params":{"sessionId":"current","update":{"sessionUpdate":"available_commands_update","availableCommands":[{"name":"status"}]}}}'
        "#]);
        let result = discover_process(command, &std::env::temp_dir(), Duration::from_secs(2))
            .await
            .unwrap();
        assert_eq!(result.commands.len(), 1);
        assert_eq!(result.commands[0].name, "/status");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn auth_error_is_generic_and_does_not_trigger_login() {
        let _serial = crate::providers::concurrent_process_tests::process_test_lock()
            .lock()
            .await;
        let mut command = Command::new("/bin/sh");
        command.args(["-c", r#"
            read -r init
            printf '%s\n' '{"id":1,"result":{}}'
            read -r request
            printf '%s\n' '{"id":2,"error":{"code":-32000,"message":"SECRET /private/credential.json"}}'
            read -r unexpected
        "#]);
        let error = discover_process(command, &std::env::temp_dir(), Duration::from_secs(2))
            .await
            .err()
            .unwrap();
        assert_eq!(error, DISCOVERY_FAILED);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn known_auth_error_returns_only_the_static_sign_in_warning() {
        let _serial = crate::providers::concurrent_process_tests::process_test_lock()
            .lock()
            .await;
        let mut command = Command::new("/bin/sh");
        command.args(["-c", r#"
            read -r init
            printf '%s\n' '{"id":1,"result":{}}'
            read -r request
            printf '%s\n' '{"id":2,"error":{"code":-32000,"message":"Authentication required","data":{"private":"SECRET /private/credential.json"}}}'
            read -r unexpected
        "#]);
        let error = discover_process(command, &std::env::temp_dir(), Duration::from_secs(2))
            .await
            .err()
            .unwrap();
        assert_eq!(error, AUTH_REQUIRED);
    }
}
