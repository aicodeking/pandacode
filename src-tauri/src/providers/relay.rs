//! Key-based relays (GLM, MiMo) that run through Claude Code: the saved credential is read once
//! per launch and applied to the child's environment, and its key is kept to redact errors and
//! logs. Cold launches only (`run_inner`): relays take no warm spare (`warm::supported`).
use super::{glm, mimo, Command};

pub(super) type Environment = Vec<(String, String)>;

/// A key-based relay's credential, checked present by `relay_for`. A MiMo credential always
/// has its endpoint: it cannot be built without one.
enum Credentials {
    Glm { token: String },
    Mimo { endpoint: String, token: String },
}

impl Credentials {
    fn token(&self) -> &str {
        match self {
            Credentials::Glm { token } | Credentials::Mimo { token, .. } => token,
        }
    }
}

/// A provider's relay snapshot, resolved once: for a key-based relay the validated credential.
pub(super) struct Relay {
    credentials: Option<Credentials>,
}

impl Relay {
    /// No relay: plain Claude Code, or a launch that resolved none.
    pub(super) fn none() -> Self {
        Relay { credentials: None }
    }

    /// The relay key, for redacting errors and logs (`None` for plain Claude Code).
    pub(super) fn key(&self) -> Option<&str> {
        self.credentials.as_ref().map(Credentials::token)
    }
}

/// Resolve a provider's relay snapshot once and check its required fields. Plain Claude Code
/// reads nothing and gets no credential; a key-based relay (GLM, MiMo) missing a field is an `Err`.
pub(super) fn relay_for(
    provider: &str,
    environment: impl FnOnce() -> Result<Environment, String>,
) -> Result<Relay, String> {
    if !matches!(provider, "glm" | "mimo") {
        return Ok(Relay::none());
    }
    let env = environment()?;
    let field = |wanted: &str| {
        env.iter()
            .find(|(name, _)| name == wanted)
            .map(|(_, value)| value.clone())
    };
    let credentials = if provider == "mimo" {
        let endpoint = field("ANTHROPIC_BASE_URL").ok_or("The MiMo environment has no endpoint.")?;
        let token = field("ANTHROPIC_AUTH_TOKEN").ok_or("The MiMo environment has no API key.")?;
        Credentials::Mimo { endpoint, token }
    } else {
        let token = field("ANTHROPIC_AUTH_TOKEN").ok_or("The Z.AI environment has no API key.")?;
        Credentials::Glm { token }
    };
    Ok(Relay {
        credentials: Some(credentials),
    })
}

/// The one place a key-based relay is applied: `relay_for`'s snapshot goes onto `command`
/// through the provider's `apply_environment`. Returns the snapshot (its `key()` is for
/// redacting errors; `None` for plain Claude Code).
pub(super) fn configure_relay(
    provider: &str,
    command: &mut Command,
    environment: impl FnOnce() -> Result<Environment, String>,
) -> Result<Relay, String> {
    let relay = relay_for(provider, environment)?;
    match &relay.credentials {
        Some(Credentials::Glm { token }) => glm::apply_environment(command, token),
        Some(Credentials::Mimo { endpoint, token }) => mimo::apply_environment(command, endpoint, token),
        None => {}
    }
    Ok(relay)
}

/// The saved settings of a provider's relay, read at launch.
pub(super) fn saved_relay(provider: &str) -> Result<Environment, String> {
    match provider {
        "glm" => glm::environment(),
        "mimo" => mimo::environment(),
        _ => Ok(Vec::new()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::collections::HashMap;

    #[test]
    fn a_launch_applies_the_one_snapshot_it_resolved_despite_a_settings_change() {
        for provider in ["glm", "mimo"] {
            let endpoint_a = if provider == "glm" {
                glm::ENDPOINT
            } else {
                mimo::endpoint_url("token-plan-sgp").unwrap()
            };
            let endpoint_b = if provider == "glm" {
                glm::ENDPOINT
            } else {
                mimo::endpoint_url("token-plan-ams").unwrap()
            };
            let env = |key: &str, endpoint: &str| {
                vec![
                    ("ANTHROPIC_AUTH_TOKEN".into(), key.into()),
                    ("ANTHROPIC_BASE_URL".into(), endpoint.into()),
                ]
            };
            let a = env("synthetic-key-a", endpoint_a);
            let b = env("synthetic-key-b", endpoint_b);
            let mut settings = a.clone();
            let mut reads = 0;
            let mut command = Command::new("claude");
            let relay = configure_relay(provider, &mut command, || {
                reads += 1;
                let resolved = settings.clone();
                settings = b.clone(); // A settings write after resolution, before child configuration.
                Ok(resolved)
            })
            .unwrap();
            assert_eq!(settings, b);
            settings = a.clone(); // The next turn sees A again.
            let child: HashMap<_, _> = command.as_std().get_envs().collect();
            let value = |name: &str| {
                child[std::ffi::OsStr::new(name)].map(|v| v.to_string_lossy().into_owned())
            };
            assert_eq!(
                value("ANTHROPIC_AUTH_TOKEN").as_deref(),
                Some("synthetic-key-a"),
                "{provider}: child must use the credential resolved for this turn"
            );
            assert_eq!(value("ANTHROPIC_BASE_URL").as_deref(), Some(endpoint_a));
            assert_eq!(
                relay.key(),
                Some("synthetic-key-a"),
                "{provider}: the key comes back for redaction"
            );
            assert_eq!(reads, 1, "{provider}: resolve only once");
            for name in [
                "ANTHROPIC_API_KEY",
                "CLAUDE_CODE_OAUTH_TOKEN",
                "ZAI_API_KEY",
                "CLAUDE_CODE_USE_BEDROCK",
                "CLAUDE_CODE_USE_VERTEX",
                "CLAUDE_CODE_USE_FOUNDRY",
            ] {
                assert_eq!(value(name), None, "{provider}: remove {name}");
            }
            if provider == "mimo" {
                assert_eq!(value("MIMO_API_KEY"), None);
                assert_eq!(
                    value("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC").as_deref(),
                    Some("1")
                );
            }
            assert_eq!(
                value("CLAUDE_CODE_SUBPROCESS_ENV_SCRUB").as_deref(),
                Some("1")
            );
            let args: Vec<_> = command
                .as_std()
                .get_args()
                .map(|arg| arg.to_string_lossy().into_owned())
                .collect();
            assert_eq!(args[0..2], ["--setting-sources", ""]);
            assert_eq!(args[2], "--settings");
            let inline: Value = serde_json::from_str(&args[3]).unwrap();
            assert_eq!(inline["env"]["ANTHROPIC_BASE_URL"], endpoint_a);
            for name in [
                "ANTHROPIC_API_KEY",
                "CLAUDE_CODE_OAUTH_TOKEN",
                "CLAUDE_CODE_USE_BEDROCK",
                "CLAUDE_CODE_USE_VERTEX",
                "CLAUDE_CODE_USE_FOUNDRY",
            ] {
                assert_eq!(inline["env"][name], "");
            }
            for secret in ["synthetic-key-a", "synthetic-key-b"] {
                assert!(args.iter().all(|arg| !arg.contains(secret)));
            }
        }
    }

    #[test]
    fn a_resolution_error_is_returned_and_plain_claude_reads_no_relay() {
        for provider in ["glm", "mimo"] {
            let mut command = Command::new("claude");
            assert_eq!(
                configure_relay(provider, &mut command, || Err(
                    "synthetic resolution error".into()
                ))
                .err()
                .unwrap(),
                "synthetic resolution error"
            );
            assert_eq!(command.as_std().get_envs().count(), 0);
            assert_eq!(command.as_std().get_args().count(), 0);
        }
        let mut command = Command::new("claude");
        let plain = configure_relay("claude", &mut command, || panic!(
            "plain Claude must not resolve relay settings"
        ))
        .unwrap();
        assert_eq!(plain.key(), None);
        assert_eq!(command.as_std().get_envs().count(), 0);
        assert_eq!(command.as_std().get_args().count(), 0);
    }

    #[test]
    fn a_relay_snapshot_needs_its_fields_and_plain_claude_none() {
        let env = || Ok(vec![
            ("ANTHROPIC_AUTH_TOKEN".to_owned(), "synthetic-key".to_owned()),
            ("ANTHROPIC_BASE_URL".to_owned(), "https://e".to_owned()),
        ]);
        for provider in ["glm", "mimo"] {
            assert_eq!(relay_for(provider, env).unwrap().key(), Some("synthetic-key"), "{provider}");
        }
        assert!(
            relay_for("glm", || Ok(vec![])).is_err()
                && relay_for("mimo", || Ok(vec![("ANTHROPIC_AUTH_TOKEN".into(), "k".into())])).is_err()
        );
        assert_eq!(relay_for("claude", || Err("unread".into())).unwrap().key(), None);
    }

    // A cold relay launch whose CLI fails with the key in its stderr: the error `run_inner`
    // returns (`redact_launch_error`, applied to every launch error) must not carry the key.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_failed_relay_launch_error_hides_the_resolved_key() {
        use crate::providers::{redact_launch_error, run_process_launch, tests::config, Launch, ToolHost};
        use std::{collections::HashSet, sync::Arc, time::Duration};
        let _serial = crate::providers::concurrent_process_tests::process_test_lock().lock().await;
        for provider in ["glm", "mimo"] {
            let endpoint = if provider == "glm" { glm::ENDPOINT } else { mimo::endpoint_url("token-plan-sgp").unwrap() };
            let mut command = Command::new("/bin/sh");
            command.args(["-c", "printf 'fatal: cold child rejected %s\\n' \"$ANTHROPIC_AUTH_TOKEN\" >&2; IFS= read -r init; exit 1"]);
            let relay = configure_relay(provider, &mut command, || {
                Ok(vec![
                    ("ANTHROPIC_AUTH_TOKEN".into(), "synthetic-key-a".into()),
                    ("ANTHROPIC_BASE_URL".into(), endpoint.into()),
                ])
            })
            .unwrap();
            let host = ToolHost { tools: Vec::new(), approval_tools: HashSet::new(), handler: Arc::new(|_, _| Box::pin(async { Ok(Value::Null) })) };
            let (_sender, input) = tokio::sync::mpsc::unbounded_channel();
            let session = format!("relay-error-{provider}");
            let config = crate::providers::RunConfig { session_id: session, ..config(provider) };
            let launch = Launch { secrets: relay.key().map(str::to_owned).into_iter().collect(), reap_in_background: true };
            let raw = tokio::time::timeout(
                Duration::from_secs(5),
                run_process_launch(config, Arc::new(|_| {}), input, command, Vec::new(), Some(host), launch),
            )
            .await
            .unwrap()
            .unwrap_err();
            let error = redact_launch_error(&raw, &[relay.key()], None);
            assert!(error.contains("cold child rejected [redacted]"), "{provider}: {error}");
            assert!(!error.contains("synthetic-key-a"), "{provider}: exposed the key: {error}");
        }
    }
}
