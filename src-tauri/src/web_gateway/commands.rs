use serde::{Deserialize, Serialize};

pub const MAX_JSON_BYTES: usize = 1024 * 1024;
pub const MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_BINARY_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Exposure {
    Broker,
    BinaryBroker,
    Blocked,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Guard {
    None,
    RelativePath,
    OptionalRelativePath,
    RelativePaths,
    GrantedPath,
    GrantedPaths,
    InlineOrGrantedImage,
    UiAction,
    TerminalCreate,
    TerminalUse,
    TerminalClose,
    Decision,
}

#[derive(Clone, Copy, Debug)]
pub struct CommandPolicy {
    pub name: &'static str,
    pub exposure: Exposure,
    pub guard: Guard,
    pub mutation: bool,
    pub reason: &'static str,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrokerRequest {
    pub id: String,
    pub command: String,
    #[serde(default)]
    pub args: serde_json::Value,
}

include!("registry_generated.rs");

/// Commands may move into this set only after their Rust handler has been source-audited as
/// observational. The conservative initial classification intentionally leaves this empty.
#[cfg(test)]
pub const AUDITED_READ_ONLY_COMMANDS: &[&str] = &[];

static WEB_UI_ACTION: CommandPolicy = CommandPolicy {
    name: "web_ui_action",
    exposure: Exposure::Broker,
    guard: Guard::UiAction,
    mutation: true,
    reason: "finite host-owned queue and limit actions",
};

pub fn policy(command: &str) -> Option<&'static CommandPolicy> {
    if command == WEB_UI_ACTION.name {
        return Some(&WEB_UI_ACTION);
    }
    COMMANDS.iter().find(|policy| policy.name == command)
}

pub fn validate_ui_action(args: &serde_json::Value) -> Result<(), &'static str> {
    let object = args.as_object().ok_or("UI action arguments required")?;
    if object
        .keys()
        .any(|key| !matches!(key.as_str(), "action" | "sessionId" | "id" | "text"))
    {
        return Err("unknown UI action argument");
    }
    let action = object
        .get("action")
        .and_then(serde_json::Value::as_str)
        .ok_or("UI action required")?;
    object
        .get("sessionId")
        .and_then(serde_json::Value::as_str)
        .filter(|id| valid_ui_id(id))
        .ok_or("valid UI action session required")?;
    let id = object.get("id").and_then(serde_json::Value::as_str);
    let text = object.get("text").and_then(serde_json::Value::as_str);
    if object.get("id").is_some_and(|value| !value.is_string())
        || object.get("text").is_some_and(|value| !value.is_string())
    {
        return Err("invalid UI action argument");
    }
    match action {
        "queue-resume" if id.is_none() && text.is_none() => Ok(()),
        "queue-send-now" | "queue-steer" if id.is_some_and(valid_ui_id) && text.is_none() => Ok(()),
        "continue-after-limit"
            if id.is_none()
                && text.is_none_or(|value| {
                    !value.trim().is_empty()
                        && value.len() <= 16 * 1024
                        && !value.chars().any(|character| character == '\0')
                }) =>
        {
            Ok(())
        }
        _ => Err("invalid UI action"),
    }
}

fn valid_ui_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 256 && !id.chars().any(char::is_control)
}

pub fn terminal_id(args: &serde_json::Value) -> Result<&str, &'static str> {
    args.get("terminalId")
        .and_then(serde_json::Value::as_str)
        .filter(|id| !id.is_empty() && id.len() <= 128)
        .ok_or("terminal id required")
}

pub fn validate_binary_envelope(value: &serde_json::Value) -> Result<(), &'static str> {
    use base64::Engine as _;
    let encoded = value
        .as_object()
        .filter(|object| object.len() == 1)
        .and_then(|object| object.get("__pandacode_web_binary__"))
        .and_then(serde_json::Value::as_str)
        .ok_or("invalid binary response")?;
    if encoded.len() > MAX_BINARY_BYTES.saturating_mul(4).saturating_add(4) / 3 + 4 {
        return Err("binary response exceeds limit");
    }
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| "invalid binary response")?;
    if decoded.len() > MAX_BINARY_BYTES {
        return Err("binary response exceeds limit");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_is_unique_and_finite() {
        let mut names = COMMANDS
            .iter()
            .map(|command| command.name)
            .collect::<Vec<_>>();
        let count = names.len();
        names.sort_unstable();
        names.dedup();
        assert_eq!(count, 397);
        assert_eq!(names.len(), count);
        assert!(policy("definitely_not_a_command").is_none());
    }

    #[test]
    fn only_the_document_reader_accepts_binary() {
        let binary = COMMANDS
            .iter()
            .filter(|command| command.exposure == Exposure::BinaryBroker)
            .collect::<Vec<_>>();
        assert_eq!(binary.len(), 1);
        assert_eq!(binary[0].name, "read_document_file");
    }

    #[test]
    fn every_exposed_inventory_command_has_conservative_replay_protection() {
        assert!(AUDITED_READ_ONLY_COMMANDS.is_empty());
        let exposed = COMMANDS
            .iter()
            .filter(|command| command.exposure != Exposure::Blocked)
            .collect::<Vec<_>>();
        assert_eq!(exposed.len(), 352);
        assert!(exposed.iter().all(|command| command.mutation));
    }

    #[test]
    fn raw_host_paths_require_grants_and_os_surfaces_remain_blocked() {
        for name in [
            "provider_set_executable",
            "theme_import",
            "skills_import_folder",
            "read_document",
            "describe_folder",
            "github_clone_repo",
        ] {
            assert_eq!(policy(name).unwrap().guard, Guard::GrantedPath, "{name}");
        }
        for name in [
            "save_task_export",
            "read_clipboard_image",
            "reveal_path",
            "dragged_file_paths",
        ] {
            assert_eq!(policy(name).unwrap().exposure, Exposure::Blocked, "{name}");
        }
    }

    #[test]
    fn ui_action_adapter_accepts_only_the_finite_host_owned_contract() {
        let policy = policy("web_ui_action").unwrap();
        assert_eq!(policy.guard, Guard::UiAction);
        assert!(policy.mutation);
        for args in [
            serde_json::json!({"action":"queue-resume","sessionId":"session-1"}),
            serde_json::json!({"action":"queue-send-now","sessionId":"session-1","id":"queued-1"}),
            serde_json::json!({"action":"queue-steer","sessionId":"session-1","id":"queued-1"}),
            serde_json::json!({"action":"continue-after-limit","sessionId":"session-1"}),
            serde_json::json!({"action":"continue-after-limit","sessionId":"session-1","text":"Continue."}),
        ] {
            assert!(validate_ui_action(&args).is_ok(), "{args}");
        }
        for args in [
            serde_json::json!({"action":"eval","sessionId":"session-1"}),
            serde_json::json!({"action":"queue-send-now","sessionId":"session-1"}),
            serde_json::json!({"action":"queue-resume","sessionId":"session-1","id":"queued-1"}),
            serde_json::json!({"action":"queue-resume","sessionId":"session-1","extra":true}),
            serde_json::json!({"action":"continue-after-limit","sessionId":"session-1","text":""}),
        ] {
            assert!(validate_ui_action(&args).is_err(), "{args}");
        }
    }
}
