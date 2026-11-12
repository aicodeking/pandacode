//! Connections that are not the saved login (in Claude Code's order, named
//! by source), `CLAUDE_CODE_OAUTH_TOKEN`, the check's own deadline, a
//! rejected Keychain login, and a changed Keychain item.

use super::super::*;
use super::*;
use crate::providers::claude_auth::Mode;

fn folder(dir: &Path) -> (String, String) {
    ("CLAUDE_CONFIG_DIR".to_owned(), dir.to_string_lossy().into_owned())
}

#[test]
fn only_variables_that_change_how_claude_signs_in_count_in_its_own_order() {
    use crate::agent_usage_claude::{override_source, OverrideFrom};
    let env = |pairs: &'static [(&'static str, &'static str)]| move |name: &str| pairs.iter().find(|(key, _)| *key == name).map(|(_, value)| (*value).to_owned());
    assert_eq!(override_source(true, env(&[("ANTHROPIC_CUSTOM_HEADERS", "X-Team: a")]), &Value::Null), None, "headers alone change nothing");
    let both = env(&[("CLAUDE_CODE_OAUTH_TOKEN", "t"), ("ANTHROPIC_API_KEY", "k")]);
    assert_eq!(override_source(true, both, &Value::Null), Some(("ANTHROPIC_API_KEY", OverrideFrom::Environment)), "an API key outranks the OAuth token");
    let bedrock = env(&[("ANTHROPIC_API_KEY", "k"), ("CLAUDE_CODE_USE_BEDROCK", "1")]);
    assert_eq!(override_source(true, bedrock, &Value::Null).map(|(name, _)| name), Some("CLAUDE_CODE_USE_BEDROCK"), "a cloud provider comes first");
}

#[tokio::test]
async fn a_named_connection_that_sets_a_key_is_named_as_the_source() {
    let dir = temp_dir();
    let launch = claude_env(Mode::Subscription, &[folder(&dir)], &[("ANTHROPIC_API_KEY".into(), "synthetic-key".into())]);
    let result = fetch_claude(&launch, false, None).await;
    let message = result.message.unwrap();
    assert!(message.contains("This connection sets ANTHROPIC_API_KEY"), "{message}");
    assert!(!message.contains("Prefer saved Claude login") && !message.contains("synthetic-key"));
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn an_oauth_token_claude_code_uses_is_read_and_reported_when_it_cannot_read_usage() {
    let dir = temp_dir();
    let launch = claude_env(Mode::Inherit, &[folder(&dir), ("CLAUDE_CODE_OAUTH_TOKEN".into(), "sk-ant-oat01-synthetic".into())], &[]);
    let works = Arc::new(Mock { usage: script([Ok(limits(12.0))]), ..Mock::default() });
    let read = setup::fetch_claude_with(&launch, false, works.clone()).await;
    assert_eq!((read.status.as_str(), read.windows[0].used_percent), ("ready", 12.0));
    assert_eq!(read.source.as_deref(), Some("Claude Code OAuth token (CLAUDE_CODE_OAUTH_TOKEN)"));
    assert_eq!(*works.used.lock().unwrap(), ["sk-ant-oat01-synthetic"]);
    let rejected = Arc::new(Mock { usage: script([Err(FetchError::Http(401).into())]), ..Mock::default() });
    let not_login = setup::fetch_claude_with(&launch, false, rejected).await;
    assert_eq!((not_login.status.as_str(), not_login.action), ("unavailable", Some("apiConnection")));
    assert!(not_login.message.unwrap().contains("CLAUDE_CODE_OAUTH_TOKEN"));
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn the_checks_own_deadline_covers_setup_so_it_answers_as_timed_out() {
    let dir = temp_dir();
    // Setup takes a while here: a large `.claude.json` to read the account from.
    let padding = "x".repeat(20 * 1024 * 1024);
    std::fs::write(dir.join(".claude.json"), format!(r#"{{"oauthAccount":{{"emailAddress":"me@example.com"}},"projects":"{padding}"}}"#)).unwrap();
    let launch = claude_env(Mode::Subscription, &[folder(&dir)], &[]);
    let result = setup::fetch_claude_within(&launch, false, Arc::new(Mock::default()), Duration::ZERO).await;
    assert_eq!((result.message.as_deref(), result.refresh_now), (Some(TIMED_OUT.1), true), "not a generic outer timeout");
    let _ = std::fs::remove_dir_all(&dir);
}

#[cfg(target_os = "macos")]
#[tokio::test]
async fn without_an_account_hint_a_changed_item_is_read_again() {
    use crate::usage_keychain::fake_backend::{install, waits, Answer};
    let dir = temp_dir();
    let config = dir.to_string_lossy().into_owned();
    let service = claude_service(Some(&config), None);
    install(&service, Answer::Found(profile("first", now_ms() + 2 * HOUR, None)));
    let env = ClaudeEnv { keychain: true, ..claude_env(Mode::Subscription, &[("CLAUDE_CONFIG_DIR".into(), config)], &[]) };
    let mock = Arc::new(Mock::default());
    assert_eq!(setup::fetch_claude_with(&env, false, mock.clone()).await.status, "ready");
    assert_eq!(setup::fetch_claude_with(&env, false, mock.clone()).await.status, "ready");
    assert_eq!(waits(&service).len(), 1, "unchanged: reused");
    // Claude Code signs in again (another account, perhaps): the item changes.
    install(&service, Answer::Found(profile("second", now_ms() + 2 * HOUR, None)));
    assert_eq!(setup::fetch_claude_with(&env, false, mock.clone()).await.status, "ready");
    assert_eq!(waits(&service).len(), 1, "changed: read once more (the new item's first read)");
    assert_eq!(*mock.used.lock().unwrap(), ["first", "first", "second"]);
    let _ = std::fs::remove_dir_all(&dir);
}

#[cfg(target_os = "macos")]
#[tokio::test]
async fn a_rejected_keychain_login_says_sign_in_again_even_beside_an_unreadable_file() {
    use crate::usage_keychain::fake_backend::{install, Answer};
    let service = format!("Claude Code-credentials-{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);
    install(&service, Answer::Found(profile("rejected", now_ms() + HOUR, None)));
    let setup = Setup::new(b"{}", Mock { usage: script([Err(FetchError::Http(401).into())]), ..Mock::default() });
    let unreadable = setup.dir.join("unreadable");
    std::fs::create_dir_all(unreadable.join(".credentials.json")).unwrap();
    let stores = [Store::Keychain(service), Store::File(unreadable.join(".credentials.json"))];
    let result = usage_with_login(&stores, &Check { refresh: true, ..setup.check.clone() }).await;
    assert_eq!(result.message.as_deref(), Some(SIGN_IN_AGAIN.1), "not 'couldn't read'");
}

#[test]
fn a_connection_that_is_not_the_subscription_is_named_never_valued() {
    use crate::agent_usage_claude::{override_source, OverrideFrom};
    let env = |name: &str| (name == "ANTHROPIC_BASE_URL").then(|| "https://proxy.example".to_owned());
    assert_eq!(override_source(true, env, &Value::Null), Some(("ANTHROPIC_BASE_URL", OverrideFrom::Environment)));
    assert_eq!(override_source(false, env, &Value::Null), None, "stripped at launch: does not count");
    let settings = json!({"env": {"CLAUDE_CODE_USE_BEDROCK": "1"}});
    assert_eq!(override_source(false, |_| None, &settings), Some(("CLAUDE_CODE_USE_BEDROCK", OverrideFrom::Settings)));
    let from_settings = super::super::setup::api_connection("CLAUDE_CODE_USE_BEDROCK", OverrideFrom::Settings);
    assert!(from_settings.message.as_deref().unwrap().contains("settings.json sets CLAUDE_CODE_USE_BEDROCK"));
    assert_eq!((from_settings.status.as_str(), from_settings.action), ("unavailable", Some("apiConnection")));
}
