//! Claude credential selection is scoped to the child process. Only credential
//! source names and endpoint origins may cross IPC, never credential values.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;
use tokio::process::Command;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Mode {
    #[default]
    Inherit,
    Subscription,
}
impl Mode {
    pub(crate) fn is_inherit(&self) -> bool { *self == Self::Inherit }
}

// https://code.claude.com/docs/en/authentication#authentication-precedence
// Keep unrelated tool credentials and networking settings in the environment.
const OVERRIDES: &[&str] = &[
    "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_CUSTOM_HEADERS",
    "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_PROFILE", "ANTHROPIC_FEDERATION_RULE_ID",
    "ANTHROPIC_ORGANIZATION_ID", "ANTHROPIC_IDENTITY_TOKEN_FILE",
    "ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_DEFAULT_FABLE_MODEL", "ANTHROPIC_SMALL_FAST_MODEL",
    "CLAUDE_CODE_SUBAGENT_MODEL",
];

pub(crate) fn configure(command: &mut Command, provider: &str) {
    apply_mode(command, provider, crate::provider_settings::claude_connection_mode());
}

/// The variables the key-based relays (GLM Coding Plan, MiMo Token Plan) scrub from
/// their Claude process, shared by the harness console and cloud inheritance so a
/// saved variable cannot change the relay's routing remotely.
pub(crate) const RELAY_SCRUB: &[&str] = &[
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "ZAI_API_KEY",
    "MIMO_API_KEY",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
];

pub(crate) fn removed_environment(provider: &str) -> &'static [&'static str] {
    match provider {
        "claude" if crate::provider_settings::claude_connection_mode() == Mode::Subscription => OVERRIDES,
        "glm" | "mimo" => RELAY_SCRUB,
        _ => &[],
    }
}

fn apply_mode(command: &mut Command, provider: &str, mode: Mode) {
    if provider == "claude" && mode == Mode::Subscription {
        for name in OVERRIDES { command.env_remove(name); }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    mode: Mode,
    source: &'static str,
    environment_variables: Vec<&'static str>,
    endpoint: Option<String>,
    saved_login: &'static str,
    conflict: bool,
}

fn endpoint_origin(value: &str) -> Option<String> {
    if value.len() > 8192 || value.chars().any(char::is_control) { return None; }
    let url = reqwest::Url::parse(value).ok()?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() { return None; }
    Some(url.origin().ascii_serialization())
}

fn describe(mode: Mode, env: impl Fn(&str) -> Option<String>, saved_login: &'static str) -> Status {
    let present = |name: &str| env(name).is_some_and(|value| !value.trim().is_empty());
    let enabled = |name: &str| env(name).is_some_and(|value| !matches!(value.trim().to_ascii_lowercase().as_str(), "" | "0" | "false"));
    let environment_variables = OVERRIDES.iter().copied().filter(|name| present(name)).collect();
    let inherited = mode == Mode::Inherit;
    let endpoint = inherited.then(|| env("ANTHROPIC_BASE_URL").and_then(|value| endpoint_origin(&value))).flatten();
    let environment_source = if ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"].iter().any(|name| enabled(name)) {
        Some("Environment cloud provider")
    } else if present("ANTHROPIC_AUTH_TOKEN") { Some("Environment auth token")
    } else if present("ANTHROPIC_API_KEY") { Some("Environment API key")
    } else if present("CLAUDE_CODE_OAUTH_TOKEN") { Some("Environment OAuth token")
    } else if present("ANTHROPIC_PROFILE") || present("ANTHROPIC_FEDERATION_RULE_ID") && present("ANTHROPIC_ORGANIZATION_ID") { Some("Environment Anthropic profile")
    } else { None };
    let source = environment_source.filter(|_| inherited).unwrap_or(match saved_login {
        "signedIn" => "Saved Claude login",
        "notSignedIn" => "Claude is not signed in",
        "otherCredentials" => "Saved API credentials",
        _ => "Claude login not verified",
    });
    let conflict = inherited && saved_login == "signedIn" && (environment_source.is_some() || present("ANTHROPIC_BASE_URL") || present("ANTHROPIC_CUSTOM_HEADERS"));
    Status { mode, source, environment_variables, endpoint, saved_login, conflict }
}

fn saved_login(value: &Value) -> &'static str {
    match (value["loggedIn"].as_bool(), value["authMethod"].as_str(), value["apiProvider"].as_str()) {
        (Some(false), _, _) => "notSignedIn",
        (Some(true), Some("oauth_token" | "claude.ai"), Some("firstParty")) => "signedIn",
        (Some(true), Some("api_key"), Some("firstParty")) => "otherCredentials",
        _ => "unknown",
    }
}

fn inspect_saved_login() -> &'static str {
    let Some(path) = super::executable("claude") else { return "unknown"; };
    let Ok(command) = super::provider_command("claude", &path) else { return "unknown"; };
    inspect_saved_login_command(command)
}

fn inspect_saved_login_command(mut command: Command) -> &'static str {
    // Inspect the saved login separately from environment credentials and
    // project helpers. Claude still enforces managed organization settings.
    apply_mode(&mut command, "claude", Mode::Subscription);
    command.args(["--setting-sources", "", "auth", "status", "--json"])
        .current_dir(super::external_path(&std::env::temp_dir()));
    let Ok(mut output) = crate::workspace::run_process(command.into_std(), "Claude authentication", 32 * 1024, Duration::from_secs(5)) else { return "unknown"; };
    let result = if output.stdout.truncated { "unknown" } else {
        serde_json::from_slice(&output.stdout.bytes).ok().map(|value| saved_login(&value)).unwrap_or("unknown")
    };
    output.stdout.bytes.fill(0); output.stderr.bytes.fill(0);
    result
}

#[tauri::command]
pub async fn provider_claude_status() -> crate::Result<Status> {
    crate::blocking(|| {
        // Launches overlay the saved provider environment (Settings → Providers),
        // so the status reports what tasks will actually see, not just this process.
        let saved = crate::provider_settings::environment("claude");
        Ok(describe(crate::provider_settings::claude_connection_mode(), |name| {
            std::env::var(name).ok().or_else(|| saved.iter().find(|(key, _)| key == name).map(|(_, value)| value.clone()))
        }, inspect_saved_login()))
    }).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{collections::HashMap, ffi::OsStr};

    #[test]
    fn inherit_preserves_credentials_and_subscription_only_changes_claude_children() {
        for (provider, mode) in [("claude", Mode::Inherit), ("glm", Mode::Subscription), ("mimo", Mode::Subscription)] {
            let mut command = tokio::process::Command::new("claude");
            command.env("ANTHROPIC_API_KEY", "test-secret").env("ANTHROPIC_BASE_URL", "https://gateway.example");
            apply_mode(&mut command, provider, mode);
            let env: HashMap<_, _> = command.as_std().get_envs().collect();
            assert_eq!(env[OsStr::new("ANTHROPIC_API_KEY")], Some(OsStr::new("test-secret")));
            assert_eq!(env[OsStr::new("ANTHROPIC_BASE_URL")], Some(OsStr::new("https://gateway.example")));
        }
        let before = std::env::var_os("ANTHROPIC_API_KEY");
        let mut command = tokio::process::Command::new("claude");
        command.env("PATH", "keep-path").env("ZAI_API_KEY", "relay-key");
        apply_mode(&mut command, "claude", Mode::Subscription);
        let env: HashMap<_, _> = command.as_std().get_envs().collect();
        for name in OVERRIDES { assert_eq!(env[OsStr::new(name)], None, "{name}"); }
        assert_eq!(env[OsStr::new("PATH")], Some(OsStr::new("keep-path")));
        assert_eq!(env[OsStr::new("ZAI_API_KEY")], Some(OsStr::new("relay-key")));
        assert_eq!(std::env::var_os("ANTHROPIC_API_KEY"), before);
    }

    #[test]
    fn status_reports_precedence_and_sanitizes_endpoints_without_credentials() {
        let mut env = HashMap::from([
            ("ANTHROPIC_API_KEY", "sk-secret"),
            ("ANTHROPIC_AUTH_TOKEN", "bearer-secret"),
            ("ANTHROPIC_BASE_URL", "https://user:password@gateway.example:8443/v1/private?key=query-secret#fragment-secret"),
        ]);
        let status = describe(Mode::Inherit, |name| env.get(name).map(|value| value.to_string()), "signedIn");
        assert_eq!(status.source, "Environment auth token");
        assert_eq!(status.endpoint.as_deref(), Some("https://gateway.example:8443"));
        assert!(status.conflict);
        let serialized = serde_json::to_string(&status).unwrap();
        for secret in ["sk-secret", "bearer-secret", "user", "password", "private", "query-secret", "fragment-secret"] {
            assert!(!serialized.contains(secret), "{secret}");
        }
        env.insert("CLAUDE_CODE_USE_BEDROCK", "1");
        let status = describe(Mode::Inherit, |name| env.get(name).map(|value| value.to_string()), "signedIn");
        assert_eq!(status.source, "Environment cloud provider");
        let status = describe(Mode::Subscription, |name| env.get(name).map(|value| value.to_string()), "signedIn");
        assert_eq!(status.source, "Saved Claude login");
        assert!(!status.conflict);
        assert_eq!(status.endpoint, None);
    }

    #[test]
    fn unknown_login_and_malformed_endpoints_never_claim_subscription_access() {
        assert_eq!(saved_login(&json!({"loggedIn":false,"authMethod":"none"})), "notSignedIn");
        assert_eq!(saved_login(&json!({"loggedIn":true,"authMethod":"oauth_token","apiProvider":"firstParty"})), "signedIn");
        assert_eq!(saved_login(&json!({"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"})), "signedIn");
        assert_eq!(saved_login(&json!({"loggedIn":true,"authMethod":"api_key","apiProvider":"firstParty"})), "otherCredentials");
        assert_eq!(saved_login(&json!({"loggedIn":true,"authMethod":"future-mode"})), "unknown");
        let status = describe(Mode::Inherit, |_| None, "unknown");
        assert_eq!(status.source, "Claude login not verified");
        for endpoint in ["secret-token", "file:///secret", "https://", "https://host.example\nsecret"] {
            assert_eq!(endpoint_origin(endpoint), None);
        }
    }

    #[test]
    #[ignore = "Uses the installed Claude CLI with isolated synthetic credentials; sends no prompt"]
    fn installed_claude_status_reads_saved_login_with_environment_overrides_removed() {
        let path = super::super::executable("claude").expect("Claude is installed");
        let directory = std::env::temp_dir().join(format!("pandacode-claude-auth-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let expires_at = (std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() + 3_600_000) as u64;
        std::fs::write(directory.join(".credentials.json"), json!({"claudeAiOauth":{
            "accessToken":"fixture-oauth-token", "refreshToken":"fixture-refresh-token", "expiresAt":expires_at,
            "scopes":["user:inference","user:profile"], "subscriptionType":"max"
        }}).to_string()).unwrap();
        let mut command = super::super::command(&path).unwrap();
        command.env("CLAUDE_CONFIG_DIR", &directory).env("ANTHROPIC_API_KEY", "fixture-api-key")
            .env("ANTHROPIC_AUTH_TOKEN", "fixture-auth-token").env("ANTHROPIC_BASE_URL", "https://invalid.example");
        let status = inspect_saved_login_command(command);
        let _ = std::fs::remove_dir_all(directory);
        assert_eq!(status, "signedIn");
    }
}
