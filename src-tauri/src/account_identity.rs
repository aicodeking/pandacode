//! Who a pool account is, for labelling it in Settings and Usage: the email and plan name the
//! harness saved when it signed in. Read locally from the CLI's own files (Claude's
//! `.claude.json` `oauthAccount`; the claims of Codex's `auth.json` ID token), only these two
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
type Entry = (u64, Option<SystemTime>, Identity);
static CACHE: Mutex<Option<HashMap<PathBuf, Entry>>> = Mutex::new(None);

fn cached(path: &Path, read: impl FnOnce(std::fs::File) -> Identity) -> Identity {
    let Ok(file) = std::fs::File::open(path) else { return Identity::default() };
    let Ok(meta) = file.metadata() else { return Identity::default() };
    if meta.len() > MAX_FILE {
        return Identity::default();
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
fn clean(value: &Value) -> Option<String> {
    let text: String = value.as_str()?.trim().chars().filter(|c| !c.is_control()).take(120).collect();
    (!text.is_empty()).then_some(text)
}

/// Only the two fields read from `.claude.json`; serde skips the rest (project history) without
/// building it.
#[derive(Deserialize)]
struct ClaudeRoot {
    #[serde(rename = "oauthAccount")]
    account: Option<ClaudeAccount>,
}

#[derive(Deserialize)]
struct ClaudeAccount {
    #[serde(rename = "emailAddress")]
    email: Option<Value>,
    #[serde(rename = "planDisplayName")]
    plan: Option<Value>,
}

/// Claude Code: `oauthAccount` in `.claude.json`.
pub fn claude(claude_json: &Path) -> Identity {
    cached(claude_json, |file| {
        let Some(account) = read_json::<ClaudeRoot>(file).and_then(|root| root.account) else { return Identity::default() };
        Identity { email: account.email.as_ref().and_then(clean), plan: account.plan.as_ref().and_then(clean) }
    })
}

/// Codex: the claims of the ID token in `auth.json` (decoded without verifying; only shown).
pub fn codex(auth_json: &Path) -> Identity {
    cached(auth_json, codex_claims)
}

fn codex_claims(file: std::fs::File) -> Identity {
    let Some(root) = read_json::<Value>(file) else { return Identity::default() };
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
    fn api_key_only_and_padded_tokens() {
        let key_only = temp("auth.json", r#"{"OPENAI_API_KEY":"sk-test"}"#);
        assert_eq!(codex(&key_only), Identity::default());
        let claims = base64::engine::general_purpose::URL_SAFE.encode(r#"{"email":"c@example.com"}"#);
        let padded = temp("auth.json", &format!(r#"{{"tokens":{{"id_token":"h.{claims}.s"}}}}"#));
        assert_eq!(codex(&padded).email.as_deref(), Some("c@example.com"));
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
