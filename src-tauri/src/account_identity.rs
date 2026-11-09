//! Who a pool account is, for labelling it in Settings and Usage: the email and plan name the
//! harness saved when it signed in. Read locally from the CLI's own files (Claude's
//! `.config.json` / legacy `.claude.json` `oauthAccount`; Codex's `auth.json` ID token), only these two
//! fields, never a token; nothing is sent anywhere.

use base64::Engine;
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

/// Largest login file read; `.claude.json` also holds project history.
const MAX_FILE: u64 = 32 << 20;

#[derive(Clone, Debug, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub email: Option<String>,
    pub plan: Option<String>,
}

/// Results by file, kept while the file's size and modification time stay the same, so the
/// Settings refresh does not re-parse a large `.claude.json` each minute.
#[derive(Clone)]
struct Login {
    identity: Identity,
    signed_in: bool,
}
type Entry = (u64, Option<SystemTime>, Option<Login>);
static CACHE: Mutex<Option<HashMap<PathBuf, Entry>>> = Mutex::new(None);

fn cached(path: &Path, read: impl FnOnce(std::fs::File) -> Option<Login>) -> Option<Login> {
    let Ok(file) = std::fs::File::open(path) else { return None };
    let Ok(meta) = file.metadata() else { return None };
    if !meta.is_file() || meta.len() > MAX_FILE {
        return None;
    }
    let stamp = (meta.len(), meta.modified().ok());
    let mut guard = CACHE.lock().unwrap_or_else(|poison| poison.into_inner());
    let cache = guard.get_or_insert_with(HashMap::new);
    if let Some((len, modified, identity)) = cache.get(path) {
        if (*len, *modified) == stamp {
            return identity.clone();
        }
    }
    drop(guard);
    let identity = read(file);
    let mut guard = CACHE.lock().unwrap_or_else(|poison| poison.into_inner());
    let cache = guard.get_or_insert_with(HashMap::new);
    // ponytail: one entry per login file; a handful of accounts, so no eviction.
    cache.insert(path.to_path_buf(), (stamp.0, stamp.1, identity.clone()));
    identity
}

fn read_json<T: for<'de> Deserialize<'de>>(file: std::fs::File) -> Option<T> {
    serde_json::from_reader(std::io::BufReader::new(file)).ok()
}

/// A short display string: printable, trimmed, at most 120 characters.
pub(crate) fn clean(value: &Value) -> Option<String> {
    let text: String = value.as_str()?.trim().chars().filter(|c| !c.is_control()).take(120).collect();
    (!text.is_empty()).then_some(text)
}

/// Only the two fields read from `.claude.json`; serde skips the rest (project history) without
/// building it.
#[derive(Deserialize)]
struct ClaudeRoot {
    #[serde(rename = "oauthAccount")]
    account: Option<Value>,
}

fn claude_config(claude_json: &Path) -> Option<Login> {
    cached(claude_json, |file| {
        let account = read_json::<ClaudeRoot>(file)?.account.unwrap_or_default();
        Some(Login { signed_in: account.is_object(), identity: Identity { email: clean(&account["emailAddress"]), plan: clean(&account["planDisplayName"]) } })
    })
}

/// A valid modern config is authoritative even when it contains no account.
pub(crate) fn claude_json(env: &[(String, String)]) -> Option<PathBuf> {
    let modern = crate::account_config::config_dir("claude", env)?.join(".config.json");
    if claude_config(&modern).is_some() { Some(modern) } else { crate::account_config::claude_legacy(env) }
}

pub fn claude(claude_json: &Path) -> Identity {
    claude_config(claude_json).map(|login| login.identity).unwrap_or_default()
}

pub(crate) fn claude_signed_in(claude_json: &Path) -> bool {
    claude_config(claude_json).is_some_and(|login| login.signed_in)
}

/// Local labels must describe the selected login, never a default file under external auth.
pub(crate) fn local(provider: &str, env: &[(String, String)]) -> Identity {
    let Some(dir) = crate::account_config::config_dir(provider, env) else { return Identity::default() };
    if provider == "codex" {
        if ["CODEX_API_KEY", "OPENAI_API_KEY"].iter().any(|name| crate::account_config::var(env, name).is_some_and(|value| !value.trim().is_empty())) {
            return Identity::default();
        }
        return codex(&dir.join("auth.json"));
    }
    let settings = match std::fs::File::open(dir.join("settings.json")) {
        Ok(file) if file.metadata().is_ok_and(|meta| meta.is_file() && meta.len() <= 256 * 1024) => {
            let Some(value) = read_json::<Value>(file) else { return Identity::default() };
            value
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Value::Null,
        _ => return Identity::default(),
    };
    if crate::agent_usage::claude_override(true, |name| crate::account_config::var(env, name), &settings) {
        return Identity::default();
    }
    claude_json(env).map(|file| claude(&file)).unwrap_or_default()
}

/// Codex: the claims of the ID token in `auth.json` (decoded without verifying; only shown).
pub fn codex(auth_json: &Path) -> Identity {
    cached(auth_json, |file| Some(Login { identity: codex_claims(file), signed_in: false })).map(|login| login.identity).unwrap_or_default()
}

fn codex_claims(file: std::fs::File) -> Identity {
    let Some(root) = read_json::<Value>(file) else { return Identity::default() };
    // Codex selects auth_mode before token data (rust-v0.167.0 login/src/auth/manager.rs).
    let mode = root.get("auth_mode").filter(|value| !value.is_null());
    if mode.is_some_and(|value| !matches!(value.as_str(), Some("chatgpt" | "chatgptAuthTokens")))
        || mode.is_none() && root.get("OPENAI_API_KEY").is_some_and(|value| !value.is_null())
    {
        return Identity::default();
    }
    let Some(payload) = root["tokens"]["id_token"].as_str().and_then(|token| token.split('.').nth(1)) else { return Identity::default() };
    let Some(claims) = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload.trim_end_matches('='))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
    else {
        return Identity::default();
    };
    let plan = clean(&claims["https://api.openai.com/auth"]["chatgpt_plan_type"]).map(|plan| {
        let mut chars = plan.chars();
        chars.next().map_or_else(String::new, |first| first.to_uppercase().chain(chars).collect())
    });
    Identity { email: clean(&claims["email"]), plan }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A file in its own temp folder, removed when the guard drops.
    struct Temp(std::path::PathBuf);
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(self.0.parent().unwrap());
        }
    }
    impl std::ops::Deref for Temp {
        type Target = Path;
        fn deref(&self) -> &Path {
            &self.0
        }
    }

    fn temp(name: &str, text: &str) -> Temp {
        let dir = std::env::temp_dir().join(format!("pool-identity-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        std::fs::write(&path, text).unwrap();
        Temp(path)
    }

    fn local_env(provider: &str, dir: &Path) -> Vec<(String, String)> {
        let mut env: Vec<_> = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_CUSTOM_HEADERS", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_PROFILE", "ANTHROPIC_FEDERATION_RULE_ID", "ANTHROPIC_IDENTITY_TOKEN_FILE", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "ANTHROPIC_BASE_URL", "CODEX_API_KEY", "OPENAI_API_KEY"].into_iter().map(|name| (name.into(), String::new())).collect();
        env.push((if provider == "claude" { "CLAUDE_CONFIG_DIR" } else { "CODEX_HOME" }.into(), dir.to_string_lossy().into_owned()));
        env
    }

    #[test]
    fn default_claude_uses_modern_then_home_legacy_without_named_account_fallback() {
        let path = temp(".claude.json", r#"{"oauthAccount":{"emailAddress":"legacy@example.test"}}"#);
        let root = path.parent().unwrap();
        let config = root.join(".claude");
        std::fs::create_dir_all(&config).unwrap();
        let mut env = local_env("claude", &config);
        env.extend([("CLAUDE_CONFIG_DIR".into(), String::new()), ("HOME".into(), root.to_string_lossy().into_owned()), ("USERPROFILE".into(), root.to_string_lossy().into_owned())]);
        assert_eq!(claude_json(&env), Some(path.0.clone()));
        assert_eq!(local("claude", &env).email.as_deref(), Some("legacy@example.test"));
        let modern = config.join(".config.json");
        std::fs::write(&modern, r#"{"oauthAccount":{"emailAddress":"modern@example.test","planDisplayName":"Max"}}"#).unwrap();
        assert_eq!(claude_json(&env), Some(modern.clone()));
        assert_eq!(local("claude", &env).plan.as_deref(), Some("Max"));
        std::fs::write(&modern, "invalid").unwrap();
        assert_eq!(local("claude", &env).email.as_deref(), Some("legacy@example.test"));
        std::fs::write(&modern, "{}").unwrap();
        assert_eq!(local("claude", &env), Identity::default());
        env.push(("CLAUDE_CONFIG_DIR".into(), root.join("missing-named-account").to_string_lossy().into_owned()));
        assert_eq!(local("claude", &env), Identity::default());
    }

    #[test]
    fn external_tokens_api_keys_and_settings_never_borrow_disk_identity() {
        let path = temp(".config.json", r#"{"oauthAccount":{"emailAddress":"disk@example.test","planDisplayName":"Max"}}"#);
        let root = path.parent().unwrap();
        let base = local_env("claude", root);
        assert_eq!(local("claude", &base).email.as_deref(), Some("disk@example.test"));
        for name in ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] {
            let mut env = base.clone();
            env.push((name.into(), "synthetic-external-token".into()));
            assert_eq!(local("claude", &env), Identity::default());
        }
        std::fs::write(root.join("settings.json"), r#"{"env":{"ANTHROPIC_API_KEY":"synthetic-key"}}"#).unwrap();
        assert_eq!(local("claude", &base), Identity::default());
        std::fs::write(root.join("settings.json"), "malformed").unwrap();
        assert_eq!(local("claude", &base), Identity::default());

        let claims = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(r#"{"email":"codex-disk@example.test"}"#);
        std::fs::write(root.join("auth.json"), format!(r#"{{"tokens":{{"id_token":"h.{claims}.s"}}}}"#)).unwrap();
        let base = local_env("codex", root);
        assert_eq!(local("codex", &base).email.as_deref(), Some("codex-disk@example.test"));
        for name in ["CODEX_API_KEY", "OPENAI_API_KEY"] {
            let mut env = base.clone();
            env.push((name.into(), "synthetic-key".into()));
            assert_eq!(local("codex", &env), Identity::default());
        }
    }

    #[test]
    fn values_are_trimmed_stripped_of_control_characters_and_capped() {
        let long = "x".repeat(300);
        let path = temp(".claude.json", &format!(r#"{{"oauthAccount":{{"emailAddress":"a\u0007b@example.com","planDisplayName":"{long}"}}}}"#));
        let identity = claude(&path);
        assert_eq!(identity.email.as_deref(), Some("ab@example.com"));
        assert_eq!(identity.plan.map(|p| p.chars().count()), Some(120));
    }

    #[test]
    fn a_changed_file_is_read_again() {
        let path = temp(".claude.json", r#"{"oauthAccount":{"emailAddress":"old@example.com"}}"#);
        assert_eq!(claude(&path).email.as_deref(), Some("old@example.com"));
        std::fs::write(&*path, r#"{"oauthAccount":{"emailAddress":"newer@example.com"}}"#).unwrap();
        assert_eq!(claude(&path).email.as_deref(), Some("newer@example.com"), "the size changed, so the cache is not used");
    }

    #[test]
    fn large_history_is_skipped_and_only_a_valid_account_counts_as_signed_in() {
        let history = "x".repeat(9 << 20);
        let path = temp(".config.json", &format!(r#"{{"projects":{{"history":"{history}"}},"oauthAccount":{{}}}}"#));
        assert!(claude_signed_in(&path));
        assert_eq!(claude(&path), Identity::default());
        std::fs::write(&*path, r#"{"oauthAccount":{}"#).unwrap();
        assert!(!claude_signed_in(&path));
    }

    #[test]
    fn api_key_only_and_padded_tokens() {
        let key_only = temp("auth.json", r#"{"OPENAI_API_KEY":"sk-test"}"#);
        assert_eq!(codex(&key_only), Identity::default());
        let claims = base64::engine::general_purpose::URL_SAFE.encode(r#"{"email":"c@example.com"}"#);
        let padded = temp("auth.json", &format!(r#"{{"tokens":{{"id_token":"h.{claims}.s"}}}}"#));
        assert_eq!(codex(&padded).email.as_deref(), Some("c@example.com"));
    }

    #[test]
    fn codex_selected_auth_mode_wins_over_leftover_id_tokens() {
        let claims = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(r#"{"email":"stale@example.test","https://api.openai.com/auth":{"chatgpt_plan_type":"plus"}}"#);
        for mode in ["apikey", "headers", "agentIdentity", "personalAccessToken", "bedrockApiKey", "unknown"] {
            let path = temp("auth.json", &format!(r#"{{"auth_mode":"{mode}","OPENAI_API_KEY":"synthetic-key","tokens":{{"id_token":"h.{claims}.s"}}}}"#));
            assert_eq!(codex(&path), Identity::default(), "mode {mode} must not use a leftover ID token");
        }
        let legacy_key = temp("auth.json", &format!(r#"{{"OPENAI_API_KEY":"synthetic-key","tokens":{{"id_token":"h.{claims}.s"}}}}"#));
        assert_eq!(codex(&legacy_key), Identity::default());
        for mode in ["chatgpt", "chatgptAuthTokens"] {
            let path = temp("auth.json", &format!(r#"{{"auth_mode":"{mode}","OPENAI_API_KEY":"stale-key","tokens":{{"id_token":"h.{claims}.s"}}}}"#));
            assert_eq!(codex(&path).email.as_deref(), Some("stale@example.test"));
        }
    }

    #[test]
    fn claude_reads_only_the_email_and_plan() {
        let path = temp(".claude.json", r#"{"projects":{},"oauthAccount":{"emailAddress":" a@example.com ","planDisplayName":"Max","accountUuid":"x"}}"#);
        assert_eq!(claude(&path), Identity { email: Some("a@example.com".into()), plan: Some("Max".into()) });
        assert_eq!(claude(&path.with_file_name("missing.json")), Identity::default());
    }

    #[test]
    fn codex_reads_the_id_token_claims_and_never_fails_loudly() {
        let claims = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(r#"{"email":"b@example.com","https://api.openai.com/auth":{"chatgpt_plan_type":"plus"}}"#);
        let path = temp("auth.json", &format!(r#"{{"tokens":{{"id_token":"h.{claims}.s","access_token":"secret"}}}}"#));
        assert_eq!(codex(&path), Identity { email: Some("b@example.com".into()), plan: Some("Plus".into()) });
        let bad = temp("auth.json", r#"{"tokens":{"id_token":"not-a-jwt"}}"#);
        assert_eq!(codex(&bad), Identity::default());
    }
}
