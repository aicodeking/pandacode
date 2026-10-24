//! Build configuration, the persisted device settings and relay token claims.
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::path::Path;

/// Refresh once fewer than 7 days are left of the token's 30.
pub(crate) fn needs_refresh(token: &str, now: i64) -> bool {
    parse_token(token).is_some_and(|claims| claims.exp - now < 7 * 24 * 3600)
}
const FILE: &str = "remote.json";

/// The relay and GitHub OAuth app this build talks to. Missing either means "not configured".
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Build {
    pub relay: String,
    pub client_id: String,
}

fn setting(name: &str, built: Option<&'static str>) -> Option<String> {
    std::env::var(name).ok().or(built.map(str::to_owned)).map(|v| v.trim().to_owned()).filter(|v| !v.is_empty())
}

pub(crate) fn build() -> Option<Build> {
    parse_build(setting("PANDACODE_RELAY_URL", option_env!("PANDACODE_RELAY_URL")), setting("PANDACODE_GITHUB_CLIENT_ID", option_env!("PANDACODE_GITHUB_CLIENT_ID")))
}

pub(crate) fn parse_build(relay: Option<String>, client_id: Option<String>) -> Option<Build> {
    let relay = relay?.trim_end_matches('/').to_owned();
    let client_id = client_id?;
    // Only HTTPS relays: the token rides every request.
    let host = relay.strip_prefix("https://")?;
    if host.is_empty() || host.contains(char::is_whitespace) || !client_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-') {
        return None;
    }
    Some(Build { relay, client_id })
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Account {
    pub id: String,
    pub login: String,
    #[serde(default)]
    pub avatar_url: String,
}

/// Non-secret state in the app data dir. The token and private key are in `secrets.rs`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Settings {
    #[serde(default)]
    pub device_id: String,
    #[serde(default)]
    pub host_enabled: bool,
    /// Lets remote devices pick Full access (no approvals). Off: they get approving modes only.
    #[serde(default)]
    pub remote_full_access: bool,
    #[serde(default)]
    pub account: Option<Account>,
}

/// Reads the settings, creating the device id once.
pub(crate) fn load(dir: &Path) -> Settings {
    let path = dir.join(FILE);
    let mut settings: Settings = std::fs::read_to_string(&path).ok().and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_default();
    if uuid::Uuid::parse_str(&settings.device_id).is_err() {
        settings.device_id = uuid::Uuid::new_v4().to_string();
        if let Err(error) = save(dir, &settings) {
            eprintln!("Could not save the remote access device id: {error}");
        }
    }
    settings
}

pub(crate) fn save(dir: &Path, settings: &Settings) -> crate::Result<()> {
    let text = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    write_atomic(dir, text.as_bytes()).map_err(|e| format!("Could not save remote access settings: {e}"))
}

/// A unique 0600 temp file beside `remote.json`, fsynced, then renamed over it.
// ponytail: same steps as secret_store's private write_atomic; share it if that one is made pub(crate).
fn write_atomic(dir: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let temp = dir.join(format!("{FILE}.{}.tmp", uuid::Uuid::new_v4()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let renamed = options
        .open(&temp)
        .and_then(|mut file| {
            file.write_all(bytes)?;
            file.sync_all()
        })
        .and_then(|_| std::fs::rename(&temp, dir.join(FILE)));
    if renamed.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    renamed
}

/// The stored key, or a new one written once when none (or an unreadable value) is stored.
pub(crate) fn load_or_create_key(stored: Option<String>, write: impl FnOnce(&str) -> crate::Result<()>) -> crate::Result<x25519_dalek::StaticSecret> {
    if let Some(secret) = stored.and_then(|text| super::crypto::decode_secret(&text)) {
        return Ok(secret);
    }
    let secret = super::crypto::generate();
    write(&super::crypto::encode_secret(&secret))?;
    Ok(secret)
}

/// The payload half of a relay token. The signature is the relay's to check.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub(crate) struct Claims {
    pub acct: String,
    pub dev: String,
    pub iat: i64,
    pub exp: i64,
}

pub(crate) fn parse_token(token: &str) -> Option<Claims> {
    let (payload, signature) = token.split_once('.')?;
    let engine = base64::engine::general_purpose::URL_SAFE_NO_PAD;
    if signature.is_empty() || signature.contains('.') || engine.decode(signature).is_err() {
        return None;
    }
    let claims: Claims = serde_json::from_slice(&engine.decode(payload).ok()?).ok()?;
    (claims.exp > claims.iat && !claims.acct.is_empty() && !claims.dev.is_empty()).then_some(claims)
}

/// A token is usable while it is unexpired (`exp` in seconds).
pub(crate) fn token_valid(token: &str, now_seconds: i64) -> bool {
    parse_token(token).is_some_and(|claims| claims.exp > now_seconds)
}

pub(crate) fn device_name() -> String {
    #[cfg(unix)]
    let name = {
        let mut buffer = [0u8; 256];
        // SAFETY: the buffer is valid for its length, and gethostname NUL-terminates within it.
        let ok = unsafe { libc::gethostname(buffer.as_mut_ptr().cast(), buffer.len()) } == 0;
        let end = buffer.iter().position(|&b| b == 0).unwrap_or(0);
        ok.then(|| String::from_utf8_lossy(&buffer[..end]).into_owned())
    };
    #[cfg(not(unix))]
    let name = std::env::var("COMPUTERNAME").ok();
    let name = name.unwrap_or_default();
    let name = name.trim().trim_end_matches(".local").chars().filter(|c| !c.is_control()).take(64).collect::<String>();
    if name.is_empty() { "This computer".into() } else { name }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn token(payload: &str) -> String {
        let engine = base64::engine::general_purpose::URL_SAFE_NO_PAD;
        format!("{}.{}", engine.encode(payload), engine.encode([7u8; 32]))
    }

    #[test]
    fn tokens_parse_and_expire() {
        let good = token(r#"{"acct":"gh:1","dev":"d1","iat":100,"exp":200}"#);
        assert_eq!(parse_token(&good), Some(Claims { acct: "gh:1".into(), dev: "d1".into(), iat: 100, exp: 200 }));
        assert!(token_valid(&good, 150));
        assert!(!token_valid(&good, 200));
        assert_eq!(parse_token("nodot"), None);
        assert_eq!(parse_token(&format!("{}.", token(r#"{"acct":"a","dev":"d","iat":1,"exp":2}"#).split('.').next().unwrap())), None);
        assert_eq!(parse_token(&token(r#"{"acct":"","dev":"d","iat":1,"exp":2}"#)), None);
        assert_eq!(parse_token(&token("not json")), None);
    }

    #[test]
    fn tokens_refresh_in_their_last_week() {
        let day = 24 * 3600;
        let t = token(&format!(r#"{{"acct":"gh:1","dev":"d1","iat":0,"exp":{}}}"#, 30 * day));
        assert!(!needs_refresh(&t, 0));
        assert!(!needs_refresh(&t, 23 * day));
        assert!(needs_refresh(&t, 23 * day + 1));
        assert!(!needs_refresh("garbage", 0));
    }

    #[test]
    fn an_existing_key_is_never_replaced() {
        let written = std::cell::Cell::new(false);
        let write = |_: &str| {
            written.set(true);
            Ok(())
        };
        let existing = super::super::crypto::generate();
        let kept = load_or_create_key(Some(super::super::crypto::encode_secret(&existing)), write).unwrap();
        assert_eq!(kept.to_bytes(), existing.to_bytes());
        assert!(!written.get());
        load_or_create_key(None, write).unwrap();
        assert!(written.get());
    }

    #[test]
    fn build_config_needs_https_and_a_client_id() {
        let some = |s: &str| Some(s.to_owned());
        assert_eq!(parse_build(some("https://relay.example/"), some("Iv1.abc")), Some(Build { relay: "https://relay.example".into(), client_id: "Iv1.abc".into() }));
        assert_eq!(parse_build(some("http://relay.example"), some("Iv1.abc")), None);
        assert_eq!(parse_build(some("https://relay.example"), None), None);
        assert_eq!(parse_build(None, some("x")), None);
        assert_eq!(parse_build(some("https://relay.example"), some("bad id")), None);
    }

    #[test]
    fn settings_keep_one_device_id_and_default_host_off() {
        let dir = std::env::temp_dir().join(format!("pandacode-remote-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let first = load(&dir);
        assert!(!first.host_enabled && !first.remote_full_access);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(dir.join(FILE)).unwrap().permissions().mode() & 0o777, 0o600);
        }
        save(&dir, &Settings { remote_full_access: true, ..first.clone() }).unwrap();
        assert!(load(&dir).remote_full_access);
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1, "no temp files left behind");
        assert!(first.account.is_none());
        assert_eq!(load(&dir).device_id, first.device_id);
        let parsed: Settings = serde_json::from_str(r#"{"deviceId":"x","hostEnabled":true,"account":{"id":"gh:1","login":"a","avatarUrl":"u"},"trusted":{"old-device":"old-key"}}"#).unwrap();
        assert!(parsed.host_enabled);
        assert_eq!(parsed.account.as_ref().unwrap().avatar_url, "u");
        assert!(serde_json::to_value(parsed).unwrap().get("trusted").is_none());
        let _ = std::fs::remove_dir_all(dir);
    }
}
