//! Tests for `agent_usage`: cache, IPC guards, Codex and connection readers.

use super::*;
use crate::agent_usage_claude::claude_usage;
use serde_json::json;

#[test]
fn codex_prefers_named_limits_and_omits_missing_percentages() {
    let result = codex_usage(
        &json!({"account":{"type":"chatgpt","planType":"plus","email":"user@example.test"}}),
        &json!({
            "rateLimitsByLimitId":{"codex":{"limitName":"Codex","primary":{"usedPercent":17.5,"windowDurationMins":300,"resetsAt":1800576000},"secondary":{"usedPercent":null,"windowDurationMins":10080}}},
            "rateLimits":{"primary":{"usedPercent":99}},"accessToken":"SECRET"
        }),
    );
    assert_eq!(result.status, "ready");
    assert_eq!(result.windows.len(), 1);
    assert_eq!(result.windows[0].used_percent, 17.5);
    assert_eq!(result.windows[0].label, "Codex · 5 hours");
    assert_eq!(result.plan.as_deref(), Some("Plus"));
    let encoded = serde_json::to_string(&result).unwrap();
    assert_eq!(result.email.as_deref(), Some("user@example.test"));
    assert!(!encoded.contains("SECRET"));
}

#[test]
fn codex_signed_out_and_key_accounts_never_show_unrelated_limits() {
    let limits = json!({"rateLimits":{"primary":{"usedPercent":9}}});
    assert_eq!(
        codex_usage(&json!({"account":null}), &limits).status,
        "signedOut"
    );
    let key = codex_usage(&json!({"account":{"type":"apiKey"}}), &limits);
    assert_eq!(key.status, "unavailable");
    assert!(key.windows.is_empty());
}


#[tokio::test]
async fn credential_client_rejects_cleartext_before_connecting() {
    let error = http_client()
        .ok()
        .unwrap()
        .get("http://127.0.0.1:9/")
        .bearer_auth("synthetic-test-token")
        .send()
        .await
        .err()
        .unwrap();
    assert!(error.is_builder());
}

#[tokio::test]
async fn simultaneous_and_rapid_forced_refreshes_share_one_fetch() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let count = AtomicUsize::new(0);
    let entry = CacheSlot::default();
    let fetch = || async {
        count.fetch_add(1, Ordering::SeqCst);
        tokio::task::yield_now().await;
        Usage::empty("claude", "ready", "")
    };
    let (first, second) =
        tokio::join!(cached(&entry, false, || async { Some(0) }, fetch), cached(&entry, true, || async { Some(0) }, fetch));
    assert_eq!(count.load(Ordering::SeqCst), 1);
    assert_eq!(first.checked_at, second.checked_at);
}

#[tokio::test]
async fn failed_refresh_preserves_prior_windows_but_signout_clears_them() {
    let slot = |provider: &str| {
        let mut prior = Usage::empty(provider, "ready", "");
        prior.windows = vec![UsageWindow::new("5 hours", 4.0, None)];
        CacheSlot {
            entry: Mutex::new(Entry { result: Some(prior), attempted_at: Some(Instant::now() - Duration::from_secs(61)), generation: 0, provenance: Some(0) }),
            generation: AtomicU64::new(0),
        }
    };
    let entry = slot("codex");
    let prior = entry.entry.lock().await.result.as_ref().unwrap().checked_at;
    let failed = cached(&entry, true, || async { Some(0) }, || async {
        let mut failure = FetchError::Http(429).into_usage("codex");
        failure.retry_at = Some(42);
        failure
    })
    .await;
    assert!(failed.stale);
    assert_eq!(failed.windows[0].used_percent, 4.0);
    assert_eq!((failed.checked_at, failed.retry_at), (prior, Some(42)), "keeps retry_at");
    entry.entry.lock().await.attempted_at = Some(Instant::now() - Duration::from_secs(11));
    let signed_out = cached(&entry, true, || async { Some(0) }, || async { FetchError::Http(401).into_usage("codex") }).await;
    assert!(!signed_out.stale);
    assert!(signed_out.windows.is_empty());
    // Claude's in-memory reading could be another account's: Claude
    // brings back only its own account-checked saved reading.
    let claude = slot("claude");
    let failed = cached(&claude, true, || async { Some(0) }, || async { FetchError::Unavailable.into_usage("claude") }).await;
    assert!(!failed.stale && failed.windows.is_empty());
}

#[tokio::test]
async fn account_change_during_fetch_discards_old_response() {
    let slot = CacheSlot::default();
    let result = cached(&slot, false, || async { Some(0) }, || async {
        slot.generation.fetch_add(1, Ordering::SeqCst);
        claude_usage(&json!({"five_hour":{"utilization":50}}), None)
    })
    .await;
    assert!(result.windows.is_empty());
    assert!(slot.entry.lock().await.result.is_none());
}

#[test]
fn connection_environment_selects_its_own_config_folder_and_login() {
    let pair = |k: &str, v: &str| (k.to_owned(), v.to_owned());
    let work = [
        pair("CLAUDE_CONFIG_DIR", "/tmp/old"),
        pair("CLAUDE_CONFIG_DIR", "/Users/me/.claude-work"),
    ];
    // The connection's last value wins; anything it doesn't set comes from PandaCode's environment.
    assert_eq!(
        var(&work, "CLAUDE_CONFIG_DIR").as_deref(),
        Some("/Users/me/.claude-work")
    );
    assert_eq!(var(&work, "PATH"), std::env::var("PATH").ok());
    let launched = crate::agent_usage_claude_env::ClaudeEnv::launch(&work);
    assert_eq!(launched.config_dir(), Some(PathBuf::from("/Users/me/.claude-work")));
    assert_eq!(crate::agent_usage_claude_env::ClaudeEnv::launch(&[pair("CLAUDE_CONFIG_DIR", "relative")]).config_dir(), None);
    // Cost estimates resolve the folder the same way as the limits.
    assert_eq!(crate::agent_usage_claude_env::ClaudeEnv::launch(&[]).config_dir(), claude_config_dir());
    #[cfg(target_os = "macos")]
    assert_eq!(
        crate::agent_usage_claude::claude_service(var(&work, "CLAUDE_CONFIG_DIR").as_deref(), None),
        crate::agent_usage_claude::claude_service(Some("/Users/me/.claude-work"), None)
    );
}

#[tokio::test]
async fn connections_of_harnesses_without_a_connection_reader_never_show_global_limits() {
    let env = [("KIMI_SHARE_DIR".to_owned(), "/tmp/kimi-work".to_owned())];
    let usage = fetch_provider("kimi", &env, false, None).await;
    assert_eq!(usage.status, "unsupported");
    assert!(usage.windows.is_empty());
}

#[tokio::test]
async fn claude_connection_with_its_own_api_key_is_not_a_subscription() {
    let dir =
        std::env::temp_dir().join(format!("pandacode-usage-conn-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let env = [
        (
            "CLAUDE_CONFIG_DIR".to_owned(),
            dir.to_string_lossy().into_owned(),
        ),
        ("ANTHROPIC_API_KEY".to_owned(), "synthetic-key".to_owned()),
    ];
    let launch = crate::agent_usage_claude_env::ClaudeEnv {
        saved: Vec::new(),
        connection: env.to_vec(),
        mode: crate::providers::claude_auth::Mode::Subscription,
        process: |_| None,
        keychain: false,
    };
    let usage = crate::agent_usage_claude::fetch_claude(&launch, false, None).await;
    let _ = std::fs::remove_dir_all(&dir);
    assert_eq!(usage.status, "unavailable");
    let message = usage.message.unwrap();
    assert!(message.contains("This connection sets ANTHROPIC_API_KEY"), "{message}");
}



#[tokio::test]
async fn normal_ttl_and_forced_minimum_have_distinct_budgets() {
    let slot = CacheSlot {
        entry: Mutex::new(Entry {
            result: Some(claude_usage(&json!({"five_hour":{"utilization":4}}), None)),
            attempted_at: Some(Instant::now() - Duration::from_secs(11)),
            generation: 0,
            provenance: Some(0),
        }),
        generation: AtomicU64::new(0),
    };
    let normal = cached(&slot, false, || async { Some(0) }, || async {
        panic!("The 60-second cache should avoid this request")
    })
    .await;
    assert_eq!(normal.windows[0].used_percent, 4.0);
    let refreshed = cached(&slot, true, || async { Some(0) }, || async {
        claude_usage(&json!({"five_hour":{"utilization":9}}), None)
    })
    .await;
    assert_eq!(refreshed.windows[0].used_percent, 9.0);
}

#[tokio::test]
#[ignore = "Opt-in real read-only usage checks; no inference or explicit token refresh"]
async fn live_installed_usage() {
    let configured = std::env::var("PANDACODE_USAGE_SMOKE_PROVIDERS")
        .unwrap_or_else(|_| "codex,claude".into());
    for provider in configured
        .split(',')
        .map(str::trim)
        .filter(|id| cache().contains_key(*id))
    {
        if crate::providers::executable(provider).is_none() {
            continue;
        }
        invalidate(provider);
        let result = query_usage(provider.into(), true).await.unwrap();
        eprintln!(
            "usage provider={provider} status={} windows={}",
            result.status,
            result.windows.len()
        );
        assert_eq!(result.provider, provider);
        for window in result.windows {
            assert!(
                window.used_percent.is_finite() && (0.0..=100.0).contains(&window.used_percent)
            );
            assert!(window
                .resets_at
                .as_ref()
                .is_none_or(|reset| reset.len() <= 64));
        }
    }
}

/// A saved reading for a throwaway profile, as a finished Claude check leaves it.
async fn saved_profile() -> crate::agent_usage_claude_limits::Profile {
    let dir = std::env::temp_dir().join(format!("pandacode-usage-late-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let profile = crate::agent_usage_claude_limits::Profile::new("late", Some("me@example.com".into()), Some(dir));
    let mut good = Usage::empty("claude", "ready", "");
    good.windows = vec![UsageWindow::new("Weekly", 44.0, None)];
    crate::agent_usage_claude_limits::remember(&profile, &good).await;
    profile
}

#[tokio::test]
async fn a_claude_check_past_the_outer_deadline_shows_its_saved_reading_not_a_blank_card() {
    let profile = saved_profile().await;
    let slow = async {
        tokio::time::sleep(Duration::from_secs(5)).await;
        Usage::empty("claude", "ready", "")
    };
    let late = crate::agent_usage_claude::timed_out(&profile);
    let result = bounded_with("claude", Duration::from_millis(50), slow, late).await;
    assert_eq!((result.stale, result.windows.len()), (true, 1));
    let message = result.message.unwrap();
    assert!(message.contains("took too long") && !message.contains("renew"), "no renewal is running: {message}");
    let _ = std::fs::remove_dir_all(profile.dir.unwrap());
}

#[tokio::test]
async fn waiting_for_a_check_slot_does_not_count_toward_the_deadline() {
    let busy = |ms| async move {
        tokio::time::sleep(Duration::from_millis(ms)).await;
        Usage::empty("codex", "ready", "")
    };
    let never = || async { Usage::empty("codex", "error", "late") };
    // Three slots held for 150 ms; the fourth waits for one, then needs 100 ms
    // of its 200 ms deadline: 250 ms in all, but only 100 ms counted.
    let (a, b, c, d) = tokio::join!(
        bounded_with("codex", Duration::from_secs(5), busy(150), never()),
        bounded_with("codex", Duration::from_secs(5), busy(150), never()),
        bounded_with("codex", Duration::from_secs(5), busy(150), never()),
        async {
            tokio::time::sleep(Duration::from_millis(10)).await;
            bounded_with("codex", Duration::from_millis(200), busy(100), never()).await
        },
    );
    for result in [a, b, c, d] {
        assert_eq!(result.status, "ready");
    }
}

#[tokio::test]
async fn an_in_memory_claude_reading_stands_in_only_for_the_same_profile_and_account() {
    let owner = |key: &str, hint: Option<&str>| Some((key.to_owned(), hint.map(str::to_owned)));
    let check = |prior_owner, failed_owner, age: u64| async move {
        let mut prior = Usage::empty("claude", "ready", "");
        prior.windows = vec![UsageWindow::new("Weekly", 30.0, None)];
        prior.owner = prior_owner;
        let slot = CacheSlot {
            entry: Mutex::new(Entry { result: Some(prior), attempted_at: Some(Instant::now() - Duration::from_secs(age)), generation: 0, provenance: Some(0) }),
            generation: AtomicU64::new(0),
        };
        let failed = cached(&slot, true, || async { Some(0) }, || async move {
            let mut failed = FetchError::Unavailable.into_usage("claude");
            failed.owner = failed_owner;
            failed
        })
        .await;
        failed.stale
    };
    assert!(check(owner("p", Some("acct")), owner("p", Some("acct")), 3600).await, "same profile and account");
    assert!(!check(owner("p", Some("acct")), owner("p", Some("other")), 60).await, "another account");
    assert!(!check(owner("p", Some("acct")), owner("q", Some("acct")), 60).await, "another profile");
    assert!(check(owner("p", None), owner("p", None), 60).await, "no account known, recent");
    assert!(!check(owner("p", None), owner("p", None), 16 * 60).await, "no account known, too old");
    assert!(!check(None, owner("p", None), 60).await, "unknown owner");
}

#[tokio::test]
async fn a_cached_claude_reading_of_another_account_is_never_served() {
    let slot = CacheSlot::default();
    let owner = |hint: &str| Some(("profile".to_owned(), Some(hint.to_owned())));
    let read = |n: f64, who: Option<(String, Option<String>)>| async move {
        let mut usage = Usage::empty("claude", "ready", "");
        usage.windows = vec![UsageWindow::new("Weekly", n, None)];
        usage.owner = who;
        usage
    };
    let first = cached_for(&slot, false, owner("a"), || async { Some(0) }, || read(1.0, owner("a"))).await;
    assert_eq!(first.windows[0].used_percent, 1.0);
    let same = cached_for(&slot, false, owner("a"), || async { Some(0) }, || read(2.0, owner("a"))).await;
    assert_eq!(same.windows[0].used_percent, 1.0, "cached for the same account");
    let switched = cached_for(&slot, false, owner("b"), || async { Some(0) }, || read(3.0, owner("b"))).await;
    assert_eq!(switched.windows[0].used_percent, 3.0, "another account: read again");
}

#[tokio::test]
async fn toggling_renewal_clears_the_default_and_every_connection_reading() {
    let before = cache()["claude"].generation.load(Ordering::SeqCst);
    let connection = connection_slots().entry("conn#1".into()).or_default().clone();
    let connection_before = connection.generation.load(Ordering::SeqCst);
    invalidate_all("claude");
    assert!(cache()["claude"].generation.load(Ordering::SeqCst) > before);
    assert!(connection.generation.load(Ordering::SeqCst) > connection_before);
}

struct LocalLogin {
    root: PathBuf,
    dir: PathBuf,
    provider: &'static str,
    env: Vec<(String, String)>,
}

impl LocalLogin {
    fn new(provider: &'static str, named: bool) -> Self {
        let root = std::env::temp_dir().join(format!("quota-source-{}", uuid::Uuid::new_v4()));
        let dir = root.join(if named { "named" } else if provider == "claude" { ".claude" } else { ".codex" });
        std::fs::create_dir_all(&dir).unwrap();
        let mut env: Vec<_> = [
            "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_CUSTOM_HEADERS",
            "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_PROFILE", "ANTHROPIC_FEDERATION_RULE_ID",
            "ANTHROPIC_IDENTITY_TOKEN_FILE", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX",
            "CLAUDE_CODE_USE_FOUNDRY", "ANTHROPIC_BASE_URL", "CODEX_API_KEY", "OPENAI_API_KEY",
        ].into_iter().map(|name| (name.into(), String::new())).collect();
        env.extend([
            ("HOME".into(), root.to_string_lossy().into_owned()),
            ("USERPROFILE".into(), root.to_string_lossy().into_owned()),
            (if provider == "claude" { "CLAUDE_CONFIG_DIR" } else { "CODEX_HOME" }.into(),
                if named { dir.to_string_lossy().into_owned() } else { String::new() }),
        ]);
        let login = Self { root, dir, provider, env };
        login.write("account-a@example.test");
        login
    }

    fn write(&self, email: &str) {
        let (name, value) = if self.provider == "claude" {
            (".config.json", json!({"oauthAccount":{"emailAddress":email,"planDisplayName":"Max"}}))
        } else {
            use base64::Engine;
            let claims = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json!({"email":email}).to_string());
            ("auth.json", json!({"auth_mode":"chatgpt","tokens":{"id_token":format!("h.{claims}.s")}}))
        };
        std::fs::write(self.dir.join(name), value.to_string()).unwrap();
    }

    async fn stamp(&self) -> Option<u64> {
        Some(local_provenance(self.provider, &self.env))
    }

    fn usage(&self, percent: f64) -> Usage {
        let mut result = Usage::empty(self.provider, "ready", "");
        result.email = crate::account_identity::local(self.provider, &self.env).email;
        result.windows.push(UsageWindow::new("Primary", percent, None));
        result
    }
}

impl Drop for LocalLogin {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[tokio::test]
async fn local_login_changes_invalidate_default_and_named_quota_caches() {
    for provider in ["claude", "codex"] {
        for named in [false, true] {
            let login = LocalLogin::new(provider, named);
            let slot = CacheSlot::default();
            let first = cached(&slot, false, || login.stamp(), || async { login.usage(17.0) }).await;
            assert_eq!(first.email.as_deref(), Some("account-a@example.test"));
            login.write("account-b-longer@example.test");
            let next = cached(&slot, true, || login.stamp(), || async { login.usage(42.0) }).await;
            assert_eq!(next.email.as_deref(), Some("account-b-longer@example.test"));
            assert_eq!(next.windows[0].used_percent, 42.0);
            login.write("account-c-even-longer@example.test");
            let failed = cached(&slot, false, || login.stamp(), || async {
                Usage::empty(provider, "error", "Synthetic failure")
            }).await;
            assert!(failed.windows.is_empty());
            assert!(!failed.stale);
        }
    }
}

#[tokio::test]
async fn local_login_change_during_fetch_rejects_the_obsolete_windows() {
    for provider in ["claude", "codex"] {
        let login = LocalLogin::new(provider, true);
        let slot = CacheSlot::default();
        let obsolete = cached(&slot, false, || login.stamp(), || async {
            let result = login.usage(17.0);
            tokio::task::yield_now().await;
            login.write("account-b-longer@example.test");
            result
        }).await;
        assert_eq!(obsolete.status, "unavailable");
        assert!(obsolete.windows.is_empty());
        assert!(obsolete.email.is_none());
        assert!(slot.entry.lock().await.result.is_none());
    }
}

#[tokio::test]
async fn token_refresh_metadata_rejects_success_then_recovers_and_caches_same_login() {
    use base64::Engine;
    use std::sync::atomic::AtomicUsize;

    for provider in ["claude", "codex"] {
        for named in [false, true] {
            let login = LocalLogin::new(provider, named);
            let path = login.dir.join(if provider == "claude" { ".config.json" } else { "auth.json" });
            let mut metadata: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            if provider == "codex" {
                let claims = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json!({
                    "email":"account-a@example.test",
                    "https://api.openai.com/auth":{"chatgpt_plan_type":"plus"}
                }).to_string());
                metadata["tokens"]["id_token"] = json!(format!("h.{claims}.s"));
            }
            metadata["lastRefresh"] = json!("before");
            std::fs::write(&path, metadata.to_string()).unwrap();
            let identity = crate::account_identity::local(provider, &login.env);
            assert_eq!(identity.email.as_deref(), Some("account-a@example.test"));
            assert_eq!(identity.plan.as_deref(), Some(if provider == "claude" { "Max" } else { "Plus" }));
            let before = login.stamp().await;
            let before_len = std::fs::metadata(&path).unwrap().len();
            let slot = CacheSlot::default();
            let count = AtomicUsize::new(0);
            let rejected = cached(&slot, false, || login.stamp(), || async {
                count.fetch_add(1, Ordering::SeqCst);
                let mut result = login.usage(17.0);
                result.plan = identity.plan.clone();
                metadata["lastRefresh"] = json!("after-synthetic-token-refresh");
                std::fs::write(&path, metadata.to_string()).unwrap();
                result
            }).await;
            assert_ne!(before_len, std::fs::metadata(&path).unwrap().len());
            assert_ne!(before, login.stamp().await);
            assert_eq!(identity, crate::account_identity::local(provider, &login.env));
            assert_eq!(count.load(Ordering::SeqCst), 1);
            // Even a same-login rewrite conservatively discards the successful reply.
            assert_eq!(rejected.status, "unavailable");
            assert!(rejected.email.is_none());
            assert!(rejected.plan.is_none());
            assert!(rejected.windows.is_empty());
            assert!(!rejected.stale);
            {
                let entry = slot.entry.lock().await;
                assert!(entry.result.is_none());
                assert!(entry.attempted_at.is_none());
            }
            let recovered = cached(&slot, true, || login.stamp(), || async {
                count.fetch_add(1, Ordering::SeqCst);
                let mut result = login.usage(42.0);
                result.plan = identity.plan.clone();
                result
            }).await;
            assert_eq!(count.load(Ordering::SeqCst), 2);
            assert_eq!(recovered.status, "ready");
            assert_eq!(recovered.email, identity.email);
            assert_eq!(recovered.plan, identity.plan);
            assert_eq!(recovered.windows[0].used_percent, 42.0);
            assert!(!recovered.stale);
            let reused = cached(&slot, false, || login.stamp(), || async {
                count.fetch_add(1, Ordering::SeqCst);
                login.usage(99.0)
            }).await;
            assert_eq!(count.load(Ordering::SeqCst), 2);
            assert_eq!(serde_json::to_value(reused).unwrap(), serde_json::to_value(recovered).unwrap());
        }
    }
}

#[test]
fn local_provenance_tracks_credential_config_and_legacy_file_state() {
    for provider in ["claude", "codex"] {
        let login = LocalLogin::new(provider, false);
        let paths = if provider == "claude" {
            vec![login.dir.join(".credentials.json"), login.dir.join("settings.json"), login.root.join(".claude.json")]
        } else {
            vec![login.dir.join("auth.json"), login.dir.join("config.toml")]
        };
        for path in paths {
            let before = local_provenance(provider, &login.env);
            std::fs::write(&path, "synthetic-local-state").unwrap();
            let written = local_provenance(provider, &login.env);
            assert_ne!(before, written);
            assert_eq!(written, local_provenance(provider, &login.env));
            std::fs::remove_file(&path).unwrap();
            assert_ne!(written, local_provenance(provider, &login.env));
        }
        let mut moved = login.env.clone();
        moved.push((if provider == "claude" { "CLAUDE_CONFIG_DIR" } else { "CODEX_HOME" }.into(), login.root.join("other").to_string_lossy().into_owned()));
        assert_ne!(local_provenance(provider, &login.env), local_provenance(provider, &moved));
    }
}

#[test]
fn provenance_environment_keeps_connection_paths_authoritative_without_secret_reads() {
    for provider in ["claude", "codex"] {
        let login = LocalLogin::new(provider, true);
        let config = if provider == "claude" { "CLAUDE_CONFIG_DIR" } else { "CODEX_HOME" };
        let credential = if provider == "claude" { "CLAUDE_CODE_OAUTH_TOKEN" } else { "CODEX_API_KEY" };
        let mut connection = crate::connections::Connection {
            provider: provider.into(),
            env: login.env.iter().cloned().collect(),
            secret_env: vec![config.into(), credential.into()],
            config_dir: Some(login.dir.to_string_lossy().into_owned()),
            ..Default::default()
        };
        let effective = provenance_environment(provider, Some(&connection));
        assert_eq!(crate::account_config::config_dir(provider, &effective), Some(login.dir.clone()));
        assert_eq!(var(&effective, credential).as_deref(), Some("<protected>"));
        assert_eq!(crate::account_identity::local(provider, &effective), crate::account_identity::Identity::default());
        connection.config_dir = None;
        assert_eq!(crate::account_config::config_dir(provider, &provenance_environment(provider, Some(&connection))), None);
    }
}

#[tokio::test]
async fn quota_cache_unknown_provenance_clears_old_and_rejects_new_results() {
    let slot = CacheSlot::default();
    cached(&slot, false, || async { Some(1) }, || async {
        claude_usage(&json!({"five_hour":{"utilization":17}}), None)
    }).await;
    let result = cached(&slot, false, || async { None }, || async {
        claude_usage(&json!({"five_hour":{"utilization":42}}), None)
    }).await;
    assert_eq!(result.status, "unavailable");
    assert!(result.windows.is_empty());
    assert!(slot.entry.lock().await.result.is_none());
}

#[test]
fn codex_account_identity_survives_missing_limits() {
    let account = json!({"account":{"type":"chatgpt","planType":"plus","email":" user\u{7}@example.test "},"accessToken":"NEVER_EXPOSE"});
    let result = codex_usage(&account, &Value::Null);
    let encoded = serde_json::to_value(&result).unwrap();
    assert_eq!(encoded["email"], "user@example.test");
    assert_eq!(result.plan.as_deref(), Some("Plus"));
    assert!(!encoded.to_string().contains("NEVER_EXPOSE"));
    let failure = codex_limits(&account, Err("PRIVATE_ERROR_WITH_TOKEN".into()));
    assert_eq!(failure.status, "error");
    assert_eq!(failure.email.as_deref(), Some("user@example.test"));
    assert_eq!(failure.plan.as_deref(), Some("Plus"));
    assert!(failure.windows.is_empty());
    assert!(!serde_json::to_string(&failure).unwrap().contains("PRIVATE_ERROR_WITH_TOKEN"));
}


#[tokio::test]
async fn quota_cache_switches_provenance_within_both_ttls() {
    for refresh in [false, true] {
        let slot = CacheSlot::default();
        let source = AtomicU64::new(1);
        let stamp = || async { Some(source.load(Ordering::SeqCst)) };
        cached(&slot, false, stamp, || async {
            claude_usage(&json!({"five_hour":{"utilization":17}}), None)
        }).await;
        source.store(2, Ordering::SeqCst);
        let result = cached(&slot, refresh, stamp, || async {
            claude_usage(&json!({"five_hour":{"utilization":42}}), None)
        }).await;
        assert_eq!(result.windows[0].used_percent, 42.0);
    }
}

#[tokio::test]
async fn quota_cache_new_account_failure_never_keeps_old_windows() {
    let slot = CacheSlot::default();
    let source = AtomicU64::new(1);
    let stamp = || async { Some(source.load(Ordering::SeqCst)) };
    cached(&slot, false, stamp, || async {
        let mut result = claude_usage(&json!({"five_hour":{"utilization":17}}), None);
        result.email = Some("account-a@example.test".into());
        result
    }).await;
    source.store(2, Ordering::SeqCst);
    let result = cached(&slot, true, stamp, || async {
        let mut result = Usage::empty("claude", "error", "Synthetic failure");
        result.email = Some("account-b@example.test".into());
        result
    }).await;
    assert!(result.windows.is_empty());
    assert!(!result.stale);
    assert_eq!(result.email.as_deref(), Some("account-b@example.test"));
    let again = cached(&slot, false, stamp, || async { panic!("same source stays throttled") }).await;
    assert_eq!(again.status, "error");
}

#[tokio::test]
async fn quota_cache_rejects_obsolete_inflight_reply() {
    let slot = CacheSlot::default();
    let source = AtomicU64::new(1);
    let stamp = || async { Some(source.load(Ordering::SeqCst)) };
    let started = tokio::sync::Notify::new();
    let changed = tokio::sync::Notify::new();
    let old = cached(&slot, false, stamp, || async {
        started.notify_one();
        changed.notified().await;
        claude_usage(&json!({"five_hour":{"utilization":17}}), None)
    });
    let current = async {
        started.notified().await;
        source.store(2, Ordering::SeqCst);
        changed.notify_one();
        cached(&slot, false, stamp, || async {
            claude_usage(&json!({"five_hour":{"utilization":42}}), None)
        }).await
    };
    let (obsolete, current) = tokio::join!(old, current);
    assert!(obsolete.windows.is_empty());
    assert_eq!(obsolete.status, "unavailable");
    assert_eq!(current.windows[0].used_percent, 42.0);
    assert_eq!(slot.entry.lock().await.result.as_ref().unwrap().windows[0].used_percent, 42.0);
}


#[tokio::test]
async fn claude_code_rewriting_its_files_for_the_same_owner_keeps_the_reading() {
    let owner = |hint: &str| Some(("profile".to_string(), Some(hint.to_string())));
    let read = |used: f64, who: Option<(String, Option<String>)>| {
        let mut result = claude_usage(&json!({"five_hour":{"utilization":used}}), None);
        result.owner = who;
        result
    };
    // Claude Code refreshed and saved its own login while the check ran it.
    let slot = CacheSlot::default();
    let source = AtomicU64::new(1);
    let stamp = || async { Some(source.load(Ordering::SeqCst)) };
    let kept = cached_for(&slot, false, owner("a"), stamp, || async {
        source.store(2, Ordering::SeqCst);
        read(17.0, owner("a"))
    }).await;
    assert_eq!(kept.windows[0].used_percent, 17.0);
    let again = cached_for(&slot, false, owner("a"), stamp, || async { panic!("kept under the new stamp") }).await;
    assert_eq!(again.windows[0].used_percent, 17.0);
    // An account switch during the check still discards the reading.
    let slot = CacheSlot::default();
    let switched = cached_for(&slot, false, owner("a"), stamp, || async {
        source.store(3, Ordering::SeqCst);
        read(42.0, owner("b"))
    }).await;
    assert!(switched.windows.is_empty());
    assert_eq!(switched.status, "unavailable");
    // Without a known owner (other providers), any change during the check discards it.
    let slot = CacheSlot::default();
    let anonymous = cached_for(&slot, false, None, stamp, || async {
        source.store(4, Ordering::SeqCst);
        read(9.0, None)
    }).await;
    assert!(anonymous.windows.is_empty());
}
