//! The environment Claude Code is launched with, as a usage check sees it,
//! layered exactly as `providers.rs` launches Claude: this process's
//! environment, then PandaCode's saved provider variables
//! (`provider_settings::apply_environment`), then in "Prefer saved Claude
//! login" mode the credential overrides removed by `claude_auth::configure`,
//! then a named connection's own variables, which win.

use crate::providers::claude_auth::{self, Mode};
use std::path::PathBuf;

pub(crate) struct ClaudeEnv {
    /// Settings → Providers → Claude Code environment variables.
    pub saved: Vec<(String, String)>,
    /// A named connection's variables (empty for the default setup).
    pub connection: Vec<(String, String)>,
    pub mode: Mode,
    /// This process's environment.
    pub process: fn(&str) -> Option<String>,
    /// Whether the macOS Keychain store is read (off in tests: no real Keychain).
    /// Read only on macOS, where the store exists.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub keychain: bool,
}

fn last(pairs: &[(String, String)], name: &str) -> Option<String> {
    pairs.iter().rev().find(|(key, _)| key == name).map(|(_, value)| value.clone())
}

fn process_env(name: &str) -> Option<String> {
    std::env::var(name).ok()
}

impl ClaudeEnv {
    /// How PandaCode launches Claude now, plus `connection`'s own variables.
    pub(crate) fn launch(connection: &[(String, String)]) -> Self {
        Self {
            saved: crate::provider_settings::environment("claude"),
            connection: connection.to_vec(),
            mode: crate::provider_settings::claude_connection_mode(),
            process: process_env,
            keychain: cfg!(target_os = "macos"),
        }
    }

    /// A variable as the launched Claude process sees it.
    pub(crate) fn get(&self, name: &str) -> Option<String> {
        if let Some(value) = last(&self.connection, name) {
            return Some(value);
        }
        if claude_auth::stripped(self.mode).contains(&name) {
            return None;
        }
        last(&self.saved, name).or_else(|| (self.process)(name))
    }

    /// Claude's config folder: an absolute `CLAUDE_CONFIG_DIR`, else `~/.claude`.
    pub(crate) fn config_dir(&self) -> Option<PathBuf> {
        match self.get("CLAUDE_CONFIG_DIR").filter(|value| !value.is_empty()) {
            Some(path) => Some(PathBuf::from(path)).filter(|path| path.is_absolute()),
            None => crate::agent_usage_providers::home().map(|home| home.join(".claude")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pair(name: &str, value: &str) -> (String, String) {
        (name.to_owned(), value.to_owned())
    }

    fn env(mode: Mode, saved: &[(String, String)], connection: &[(String, String)]) -> ClaudeEnv {
        ClaudeEnv {
            saved: saved.to_vec(),
            connection: connection.to_vec(),
            mode,
            process: |name| (name == "ANTHROPIC_BASE_URL").then(|| "https://ambient.example".into()),
            keychain: false,
        }
    }

    #[test]
    fn variables_are_layered_as_claude_is_launched() {
        let saved = [pair("ANTHROPIC_API_KEY", "saved-key"), pair("CLAUDE_CONFIG_DIR", "/saved"), pair("HTTPS_PROXY", "p")];
        let inherit = env(Mode::Inherit, &saved, &[]);
        assert_eq!(inherit.get("ANTHROPIC_API_KEY").as_deref(), Some("saved-key"));
        assert_eq!(inherit.get("ANTHROPIC_BASE_URL").as_deref(), Some("https://ambient.example"));
        // Prefer saved Claude login: credential overrides are removed at launch, folders kept.
        let subscription = env(Mode::Subscription, &saved, &[]);
        assert_eq!(subscription.get("ANTHROPIC_API_KEY"), None);
        assert_eq!(subscription.get("ANTHROPIC_BASE_URL"), None);
        assert_eq!(subscription.get("HTTPS_PROXY").as_deref(), Some("p"));
        assert_eq!(subscription.config_dir(), Some(PathBuf::from("/saved")));
        // A connection's own variables are applied after that, and win; the last value counts.
        let connection = [pair("ANTHROPIC_API_KEY", "a"), pair("ANTHROPIC_API_KEY", "b"), pair("CLAUDE_CONFIG_DIR", "relative")];
        let named = env(Mode::Subscription, &saved, &connection);
        assert_eq!(named.get("ANTHROPIC_API_KEY").as_deref(), Some("b"));
        assert_eq!(named.config_dir(), None, "a relative folder is refused");
    }
}
