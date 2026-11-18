use super::*;
use crate::agent_usage_claude_remote::Pending;
use crate::providers::claude_auth::Mode;
use serde_json::json;
use std::collections::VecDeque;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Mutex,
};

const NOW: u64 = 1_800_000_000_000;
const HOUR: u64 = 3_600_000;

fn temp_dir() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("pandacode-claude-usage-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn credential(token: &str, expires: u64, scopes: Value, refresh: Option<&str>) -> Vec<u8> {
    let mut oauth = json!({
        "accessToken": token, "expiresAt": expires, "scopes": scopes,
        "subscriptionType": "max", "rateLimitTier": "default_claude_max_20x"
    });
    if let Some(refresh) = refresh {
        oauth["refreshToken"] = json!(refresh);
    }
    serde_json::to_vec(&json!({"claudeAiOauth": oauth, "mcpOAuth": {"server": {"accessToken": "other-tool"}}}))
        .unwrap()
}

fn profile(token: &str, expires: u64, refresh: Option<&str>) -> Vec<u8> {
    credential(token, expires, json!(["user:profile", "user:inference"]), refresh)
}

fn login(store: Store, token: &str, expires: u64, refresh: Option<&str>) -> Login {
    parse_login(profile(token, expires, refresh), store).login().unwrap()
}

/// The launch environment, with nothing from this machine: no ambient
/// variables, no real Keychain.
pub(super) fn claude_env(mode: Mode, saved: &[(String, String)], connection: &[(String, String)]) -> ClaudeEnv {
    ClaudeEnv { saved: saved.to_vec(), connection: connection.to_vec(), mode, process: |_| None, keychain: false }
}

fn keychain() -> Store {
    Store::Keychain("Claude Code-credentials".into())
}

fn file() -> Store {
    Store::File("/tmp/none/.credentials.json".into())
}

fn gathered(logins: Vec<Login>, unread: Option<Unread>) -> Gathered {
    Gathered { logins, unread, unrecognized: false, from_memory: Vec::new() }
}

fn stored(path: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}

fn limits(weekly: f64) -> Value {
    json!({"five_hour": null, "seven_day": {"utilization": weekly}})
}

/// Offline Claude services: scripted answers, recorded calls.
#[derive(Default)]
struct Mock {
    usage: Mutex<VecDeque<Result<Value, UsageFailure>>>,
    used: Mutex<Vec<String>>,
}

impl Remote for Mock {
    fn usage(&self, access_token: String) -> Pending<'_, Result<Value, UsageFailure>> {
        self.used.lock().unwrap().push(access_token);
        let answer = self.usage.lock().unwrap().pop_front().unwrap_or(Ok(limits(5.0)));
        Box::pin(async move { answer })
    }
}

struct Setup {
    dir: PathBuf,
    path: PathBuf,
    /// PandaCode's app data folder (saved readings, install key).
    app: PathBuf,
    mock: Arc<Mock>,
    check: Check,
}

impl Setup {
    fn new(initial: &[u8], mock: Mock) -> Self {
        let dir = temp_dir();
        let path = dir.join(".credentials.json");
        std::fs::write(&path, initial).unwrap();
        // The account a run's printed usage is saved under (read as it ends).
        std::fs::write(dir.join(".claude.json"), r#"{"oauthAccount":{"emailAddress":"me@example.com"}}"#).unwrap();
        let mock = Arc::new(mock);
        let app = temp_dir();
        let check = Check {
            remote: mock.clone(),
            profile: Profile::new(&dir.to_string_lossy(), Some("me@example.com".into()), Some(app.clone())),
            refresh: false,
            cli: cli::Cli::Missing,
            deadline: Duration::from_secs(30),
            ends: None,
            account_file: Some(dir.join(".claude.json")),
            refresh_lock: Some(dir.join(".oauth_refresh.lock")),
        };
        Self { dir, path, app, mock, check }
    }

    fn store(&self) -> Store {
        Store::File(self.path.clone())
    }

    async fn run(&self) -> Usage {
        usage_with_login(&[self.store()], &self.check).await
    }

    /// A manual refresh.
    async fn refresh(&self) -> Usage {
        usage_with_login(&[self.store()], &Check { refresh: true, ..self.check.clone() }).await
    }
}

impl Drop for Setup {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
        let _ = std::fs::remove_dir_all(&self.app);
    }
}

fn script<T>(items: impl IntoIterator<Item = T>) -> Mutex<VecDeque<T>> {
    Mutex::new(items.into_iter().collect())
}

#[test]
fn claude_omits_unknown_windows_instead_of_claiming_zero() {
    let result = claude_usage(
        &json!({
            "five_hour":{"utilization":24.5,"resets_at":"2026-09-23T01:00:00Z"},
            "seven_day":{"utilization":null},
            "seven_day_sonnet":{"utilization":101},
            "extra_usage":{"is_enabled":false,"utilization":0},
            "refreshToken":"SECRET"
        }),
        Some("Max".into()),
    );
    assert_eq!(result.status, "ready");
    let labels: Vec<_> = result.windows.iter().map(|w| (w.label.as_str(), w.used_percent)).collect();
    assert_eq!(labels, [("5 hours", 24.5), ("Weekly · Sonnet", 100.0)]);
    assert!(!serde_json::to_string(&result).unwrap().contains("SECRET"));
    assert_eq!(claude_usage(&json!({"five_hour":null}), None).status, "unavailable");
}

#[test]
fn claude_reads_the_current_response_with_a_null_five_hour_window() {
    let result = claude_usage(
        &json!({
            "five_hour": null,
            "seven_day": {"utilization": 24.0, "resets_at": "2026-11-16T00:59:59.731478+00:00"},
            "seven_day_opus": null,
            "limits": [
                {"kind": "weekly_all", "percent": 24, "resets_at": "2026-11-16T00:59:59.731478+00:00", "is_active": true},
                {"kind": "weekly_scoped", "percent": 3, "is_active": false, "scope": {"model": {"display_name": "Opus"}}}
            ],
            "extra_usage": {"is_enabled": false}
        }),
        Some("Max".into()),
    );
    assert_eq!(result.status, "ready");
    // A null five_hour is left out, never shown as 0%.
    let labels: Vec<_> = result.windows.iter().map(|w| (w.label.as_str(), w.used_percent)).collect();
    assert_eq!(labels, [("Weekly", 24.0)], "weekly_all repeats seven_day");
    assert_eq!(result.windows[0].resets_at.as_deref(), Some("2026-11-16T00:59:59.731478+00:00"));
    let only_limits = claude_usage(
        &json!({"five_hour": null, "seven_day": null, "limits": [
            {"kind": "weekly_all", "percent": 41, "is_active": true},
            {"kind": "five_hour", "percent": 7, "is_active": true}
        ]}),
        None,
    );
    let labels: Vec<_> = only_limits.windows.iter().map(|w| (w.label.as_str(), w.used_percent)).collect();
    assert_eq!(labels, [("5 hours", 7.0), ("Weekly", 41.0)]);
}

#[test]
fn windows_are_ordered_five_hours_weekly_then_the_rest() {
    let result = claude_usage(
        &json!({
            "seven_day_opus": {"utilization": 3},
            "extra_usage": {"is_enabled": true, "utilization": 10},
            "seven_day": {"utilization": 20},
            "five_hour": {"utilization": 50},
            "limits": [{"kind": "five_hour", "percent": 99, "is_active": true}]
        }),
        None,
    );
    let labels: Vec<_> = result.windows.iter().map(|w| (w.label.as_str(), w.used_percent)).collect();
    assert_eq!(
        labels,
        [("5 hours", 50.0), ("Weekly", 20.0), ("Weekly · Opus", 3.0), ("Extra usage budget", 10.0)]
    );
}

#[test]
fn claude_model_scoped_limits_preserve_real_percentages() {
    let result = claude_usage(
        &json!({"limits":[
            {"kind":"weekly_scoped","group":"weekly","percent":12,"is_active":true,"scope":{"model":{"id":"sonnet","display_name":"Sonnet"}},"resets_at":"2026-09-24T12:00:00Z"},
            {"kind":"weekly_scoped","percent":99,"is_active":false,"scope":{"model":{"display_name":"Retired"}}}
        ]}),
        None,
    );
    assert_eq!(result.windows.len(), 1);
    assert_eq!(result.windows[0].label, "Weekly · Sonnet");
    assert_eq!(result.windows[0].used_percent, 12.0);
}

#[test]
fn credentials_require_profile_scope_and_classify_expiry() {
    let valid = login(file(), "synthetic-token", NOW + 60_000, Some("synthetic-refresh"));
    assert_eq!(valid.fitness(NOW), Fitness::Valid);
    assert_eq!(valid.plan.as_deref(), Some("Max"));
    assert_eq!(login(file(), "t", NOW + 5_000, Some("r")).fitness(NOW), Fitness::Refreshable);
    assert_eq!(login(file(), "t", NOW - 1, None).fitness(NOW), Fitness::Expired);
    assert_eq!(login(file(), "t", u64::MAX, None).fitness(u64::MAX), Fitness::Expired);
    let inference = parse_login(credential("t", NOW + 60_000, json!(["user:inference"]), None), file());
    assert_eq!(inference.login().unwrap().fitness(NOW), Fitness::NoProfile);
    let float = br#"{"claudeAiOauth":{"accessToken":"t","expiresAt":1.9e12,"scopes":["user:profile"]}}"#;
    assert_eq!(parse_login(float.to_vec(), file()).login().unwrap().fitness(NOW), Fitness::Valid);
    for bytes in [&b"invalid-json"[..], br#"{"claudeAiOauth":{"accessToken":""}}"#, br#"{"claudeAiOauth":{}}"#] {
        assert!(matches!(parse_login(bytes.to_vec(), file()), Parsed::Unrecognized));
    }
    // Valid JSON without a Claude login: an API-key setup or only MCP entries.
    for bytes in [&b"{}"[..], br#"{"mcpOAuth":{"server":{"accessToken":"other-tool"}}}"#] {
        assert!(matches!(parse_login(bytes.to_vec(), file()), Parsed::NoLogin));
    }
}

#[test]
fn the_keychain_login_wins_whenever_the_keychain_holds_one_as_in_claude_code() {
    let pick_one = |logins| pick(gathered(logins, None), NOW).ok().unwrap();
    // Valid or expired, a Keychain login is the one Claude Code uses.
    let chosen = pick_one(vec![login(keychain(), "keychain", NOW + 60_000, Some("r")), login(file(), "file", NOW - 76 * 24 * HOUR, Some("r"))]);
    assert_eq!(chosen.store, keychain());
    let chosen = pick_one(vec![login(keychain(), "keychain", NOW - 1, Some("r")), login(file(), "file", NOW + 60_000, Some("r"))]);
    assert_eq!((chosen.access_token.as_str(), chosen.fitness(NOW)), ("keychain", Fitness::Refreshable));
    let chosen = pick_one(vec![login(keychain(), "keychain", NOW + 60_000, None), login(file(), "file", NOW + 90_000, None)]);
    assert_eq!(chosen.access_token, "keychain");
    // No Keychain login: the credential file.
    assert_eq!(pick_one(vec![login(file(), "file", NOW + 60_000, None)]).access_token, "file");
    // Among non-Keychain logins, one without an expiry ranks below a dated one, in either order.
    let undated = || parse_login(br#"{"claudeAiOauth":{"accessToken":"undated","scopes":["user:profile"]}}"#.to_vec(), file()).login().unwrap();
    let other = || login(Store::File("/tmp/other/.credentials.json".into()), "dated", NOW + 60_000, None);
    assert_eq!(pick_one(vec![other(), undated()]).access_token, "dated");
    assert_eq!(pick_one(vec![undated(), other()]).access_token, "dated");
}

#[test]
fn each_failure_gets_an_accurate_message() {
    let message = |g| *pick(g, NOW).err().unwrap();
    let failed = message(gathered(vec![login(file(), "f", NOW - 1, Some("r"))], Some(Unread::Keychain)));
    assert_eq!((failed.status.as_str(), failed.message.as_deref()), ("error", Some(READ_FAILED.1)));
    let locked = message(gathered(vec![], Some(Unread::KeychainLocked)));
    assert!(locked.message.unwrap().contains("locked"));
    assert_eq!(message(gathered(vec![], Some(Unread::File))).message.as_deref(), Some(READ_FAILED.1));
    // The Keychain could not be read: a valid credential-file login does not
    // stand in (Claude Code would use the Keychain).
    assert_eq!(message(gathered(vec![login(file(), "f", NOW + 60_000, None)], Some(Unread::Keychain))).message.as_deref(), Some(READ_FAILED.1));
    // The credential file could not be read: the Keychain's login is used.
    assert!(pick(gathered(vec![login(keychain(), "k", NOW - 1, Some("r"))], Some(Unread::File)), NOW).is_ok());
    assert_eq!(message(gathered(vec![], None)).status, "signedOut");
    assert_eq!(message(gathered(vec![login(file(), "f", NOW - 1, None)], None)).status, "signedOut");
    assert_eq!(message(Gathered { logins: vec![], unread: None, unrecognized: true, from_memory: Vec::new() }).status, "unavailable");
    let inference = parse_login(credential("t", NOW + 60_000, json!(["user:inference"]), None), file()).login().unwrap();
    assert_eq!(message(gathered(vec![inference], None)).status, "unavailable");
}

#[tokio::test]
async fn a_rate_limit_shows_the_last_reading_without_asking_again() {
    let setup = Setup::new(
        &profile("valid", now_ms() + HOUR, None),
        Mock {
            usage: script([
                Ok(limits(41.0)),
                Err(UsageFailure { error: FetchError::Http(429), retry_after: Some("900".into()) }),
            ]),
            ..Mock::default()
        },
    );
    assert_eq!(setup.run().await.windows[0].used_percent, 41.0);
    let limited = setup.run().await;
    assert_eq!((limited.status.as_str(), limited.stale), ("ready", true));
    assert_eq!(limited.windows[0].used_percent, 41.0);
    assert_eq!(limited.message.as_deref(), Some("Claude's usage service is rate limited; showing the last good reading."));
    assert!(limited.retry_at.is_some_and(|at| at >= now_ms() + 899_000), "the panel shows when Refresh may ask again");
    assert!(limited.auto_retry_at.is_some_and(|at| at >= now_ms() + 899_000), "and when opening it checks again");
    assert_eq!(limited.action, Some("rateLimited"));
    let calls = setup.mock.used.lock().unwrap().len();
    assert!(setup.run().await.stale);
    assert!(setup.refresh().await.stale, "a manual refresh does not ask either");
    assert_eq!(setup.mock.used.lock().unwrap().len(), calls, "no request until Retry-After");
    // A manual refresh still re-reads the store: a sign-out shows at once.
    std::fs::write(&setup.path, br#"{"mcpOAuth":{}}"#).unwrap();
    let signed_out = setup.refresh().await;
    assert_eq!((signed_out.status.as_str(), signed_out.message.as_deref()), ("signedOut", Some(NOT_FOUND.1)));
    assert_eq!(setup.mock.used.lock().unwrap().len(), calls);
}

#[tokio::test]
async fn a_store_without_a_claude_login_asks_to_sign_in() {
    let setup = Setup::new(br#"{"mcpOAuth":{"server":{"accessToken":"other-tool"}}}"#, Mock::default());
    let result = setup.run().await;
    assert_eq!((result.status.as_str(), result.message.as_deref()), ("signedOut", Some(NOT_FOUND.1)));
}

#[tokio::test]
async fn saved_credentials_follow_the_claude_connection_mode_as_at_launch() {
    let dir = temp_dir();
    let folder = ("CLAUDE_CONFIG_DIR".to_owned(), dir.to_string_lossy().into_owned());
    for (name, value) in [
        ("ANTHROPIC_API_KEY", "synthetic-key"),
        ("ANTHROPIC_BASE_URL", "https://relay.example"),
        ("CLAUDE_CODE_USE_BEDROCK", "1"),
        ("CLAUDE_CODE_USE_VERTEX", "1"),
    ] {
        let saved = [folder.clone(), (name.to_owned(), value.to_owned())];
        // Use current environment: launched with it, so not a subscription.
        let inherit = fetch_claude(&claude_env(Mode::Inherit, &saved, &[]), false, None).await;
        assert!(inherit.message.unwrap().contains(&format!("launched with {name} set")), "{name}");
        // Prefer saved Claude login: removed at launch, so the saved login counts.
        let subscription = fetch_claude(&claude_env(Mode::Subscription, &saved, &[]), false, None).await;
        assert_eq!((subscription.status.as_str(), subscription.message.as_deref()), ("signedOut", Some(NOT_FOUND.1)), "{name}");
        // A named connection's own variable is applied after that, and counts.
        let named = fetch_claude(&claude_env(Mode::Subscription, std::slice::from_ref(&folder), &saved), false, None).await;
        assert!(named.message.unwrap().contains(&format!("This connection sets {name}")), "{name}");
    }
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn subscription_mode_ignores_inherited_relay_but_respects_explicit_settings() {
    let env = |name: &str| (name == "ANTHROPIC_BASE_URL").then(|| "https://relay.example".into());
    assert!(claude_override(true, env, &Value::Null));
    assert!(!claude_override(false, env, &Value::Null));
    assert!(claude_override(false, |_| None, &json!({"apiKeyHelper":"some-helper"})));
    assert!(claude_override(true, |_| None, &json!({"env":{"ANTHROPIC_API_KEY":"synthetic-key"}})));
    assert!(!claude_override(true, |name| (name == "CLAUDE_CODE_USE_BEDROCK").then(|| "false".into()), &Value::Null));
}

#[cfg(target_os = "macos")]
#[test]
fn keychain_lookup_is_scoped_to_exact_config_not_global_fallback() {
    use sha2::{Digest, Sha256};
    assert_eq!(claude_service(None, None), "Claude Code-credentials");
    let config = "/tmp/claude-profile/";
    let hash = format!("{:x}", Sha256::digest(config));
    assert_eq!(claude_service(Some(config), None), format!("Claude Code-credentials-{}", &hash[..8]));
    assert_eq!(claude_service(Some(config), Some("")), "Claude Code-credentials");
    assert_ne!(claude_service(Some(config), None), claude_service(Some("/tmp/claude-profile"), None));
    assert_eq!(claude_service(Some("/tmp/e\u{301}"), None), claude_service(Some("/tmp/é"), None));
    assert_eq!(
        setup::stores(Path::new("/tmp/claude-profile"), &ClaudeEnv { keychain: true, ..claude_env(Mode::Inherit, &[("CLAUDE_CONFIG_DIR".into(), config.into())], &[]) }),
        [
            Store::Keychain(claude_service(Some(config), None)),
            Store::File("/tmp/claude-profile/.credentials.json".into())
        ]
    );
}

/// `PANDACODE_SMOKE_CLAUDE_CONFIG_DIR` checks one connection's config folder.
/// Read-only (never renews or writes a login); prints status only, never tokens.
#[tokio::test]
#[ignore = "Opt-in live Claude usage check against the real login"]
async fn live_claude_usage_smoke() {
    let env: Vec<(String, String)> = std::env::var("PANDACODE_SMOKE_CLAUDE_CONFIG_DIR")
        .ok()
        .map(|dir| vec![("CLAUDE_CONFIG_DIR".to_owned(), dir)])
        .unwrap_or_default();
    // Read-only: tests never run Claude Code (`cli_for`), so an expired
    // login is only reported.
    let result = fetch_claude(&ClaudeEnv::launch(&env), true, None).await;
    eprintln!(
        "claude usage status={} plan={:?} source={:?} message={:?}",
        result.status, result.plan, result.source, result.message
    );
    for window in &result.windows {
        eprintln!("  window {} {}% resets {:?}", window.label, window.used_percent, window.resets_at);
    }
    assert_eq!(result.status, "ready");
    assert!(!result.windows.is_empty());
}

// Round-trip flows through `usage_with_login`, kept apart to keep files short.
#[path = "agent_usage_claude_flow_tests.rs"]
mod flow;
#[path = "agent_usage_claude_connection_tests.rs"]
mod connection_tests;
#[path = "agent_usage_claude_cli_tests.rs"]
mod cli_tests;
