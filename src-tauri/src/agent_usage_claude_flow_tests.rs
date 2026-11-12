//! Flows through `usage_with_login` and `fetch_claude`: saving past a read
//! backoff, one rotation per check, saved readings, undated logins, env order.

use super::*;
use crate::providers::claude_auth::Mode;
use std::sync::atomic::AtomicUsize;

#[tokio::test]
async fn a_transient_error_shows_the_saved_reading_but_a_sign_out_does_not() {
    let setup = Setup::new(
        &profile("valid", now_ms() + HOUR, None),
        Mock { usage: script([Ok(limits(33.0)), Err(FetchError::Http(503).into())]), ..Mock::default() },
    );
    assert_eq!(setup.run().await.windows[0].used_percent, 33.0);
    let failed = setup.run().await;
    assert_eq!((failed.status.as_str(), failed.stale, failed.windows.len()), ("ready", true, 1));
    assert_eq!(failed.message.as_deref(), Some("The usage service could not be reached. Try again later."));
    std::fs::write(&setup.path, br#"{"mcpOAuth":{}}"#).unwrap();
    let signed_out = setup.run().await;
    assert_eq!((signed_out.status.as_str(), signed_out.windows.len()), ("signedOut", 0));
}

#[tokio::test]
async fn a_repeated_connection_variable_uses_its_last_value_like_a_process_environment() {
    let dir = temp_dir();
    let folder = ("CLAUDE_CONFIG_DIR".to_owned(), dir.to_string_lossy().into_owned());
    let key = |value: &str| ("ANTHROPIC_API_KEY".to_owned(), value.to_owned());
    let cleared = fetch_claude(&claude_env(Mode::Inherit, &[], &[folder.clone(), key("synthetic-key"), key("")]), false, None).await;
    assert_ne!(cleared.status, "unavailable", "the later empty value wins");
    let set = fetch_claude(&claude_env(Mode::Inherit, &[], &[folder, key(""), key("synthetic-key")]), false, None).await;
    let message = set.message.unwrap();
    assert!(message.contains("This connection sets ANTHROPIC_API_KEY"), "{message}");
    assert!(!message.contains("synthetic-key"), "the name only, never the value");
    assert_eq!(set.action, Some("apiConnection"));
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn with_the_setting_off_an_expired_login_shows_the_saved_reading_and_nothing_runs() {
    let setup = Setup::new(&profile("valid", now_ms() + HOUR, Some("r1")), Mock { usage: script([Ok(limits(52.0))]), ..Mock::default() });
    assert_eq!(setup.run().await.windows[0].used_percent, 52.0);
    std::fs::write(&setup.path, profile("valid", 1000, Some("r1"))).unwrap();
    let off = Check { cli: cli::Cli::Off, ..setup.check.clone() };
    let result = usage_with_login(&[setup.store()], &off).await;
    assert_eq!((result.stale, result.windows[0].used_percent), (true, 52.0));
    assert_eq!(result.message.as_deref(), Some(EXPIRED_OFF.1));
    assert_eq!(setup.mock.used.lock().unwrap().len(), 1, "the expired token is not sent");
    assert_eq!(stored(&setup.path)["claudeAiOauth"]["refreshToken"], "r1", "nothing written");
}

/// A config folder whose Keychain item is served by the fake backend, and a
/// launch environment that reads it through the real `read_claude` path.
#[cfg(target_os = "macos")]
fn keychain_profile(answer: crate::usage_keychain::fake_backend::Answer) -> (PathBuf, ClaudeEnv) {
    let dir = temp_dir();
    let config = dir.to_string_lossy().into_owned();
    crate::usage_keychain::fake_backend::install(&claude_service(Some(&config), None), answer);
    let env = ClaudeEnv { keychain: true, ..claude_env(Mode::Subscription, &[("CLAUDE_CONFIG_DIR".into(), config)], &[]) };
    (dir, env)
}

#[cfg(target_os = "macos")]
#[tokio::test]
async fn fetch_claude_reads_the_keychain_through_security_when_the_reader_is_refused() {
    use crate::usage_keychain::fake_backend::Answer;
    let (dir, env) = keychain_profile(Answer::Found(profile("from-keychain", now_ms() + HOUR, None)));
    let mock = Arc::new(Mock { usage: script([Ok(limits(23.0))]), ..Mock::default() });
    let result = setup::fetch_claude_with(&env, false, mock.clone()).await;
    assert_eq!((result.status.as_str(), result.source.as_deref()), ("ready", Some("Claude Code login · Keychain")));
    assert_eq!(*mock.used.lock().unwrap(), ["from-keychain"]);
    let _ = std::fs::remove_dir_all(&dir);
}

#[cfg(target_os = "macos")]
#[tokio::test]
async fn a_manual_refresh_lifts_the_latch_before_reading_and_waits_longer() {
    use crate::usage_keychain::fake_backend::{install, waits, Answer};
    let (dir, env) = keychain_profile(Answer::Denied);
    let mock = Arc::new(Mock::default());
    let denied = setup::fetch_claude_with(&env, false, mock.clone()).await;
    assert_eq!(denied.message.as_deref(), Some(KEYCHAIN_LATCHED.1));
    // The user allows it now; an automatic check still does not ask.
    let service = claude_service(env.get("CLAUDE_CONFIG_DIR").as_deref(), None);
    install(&service, Answer::Found(profile("allowed", now_ms() + HOUR, None)));
    assert_eq!(setup::fetch_claude_with(&env, false, mock.clone()).await.message.as_deref(), Some(KEYCHAIN_LATCHED.1));
    assert!(waits(&service).is_empty(), "no `security` while latched");
    // Refresh: the latch is lifted before the read, with time to answer a dialog.
    let refreshed = setup::fetch_claude_with(&env, true, mock.clone()).await;
    assert_eq!(refreshed.status, "ready", "{:?}", refreshed.message);
    assert_eq!(waits(&service), [Duration::from_secs(20)]);
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_manual_refresh_skips_the_minimum_only_after_an_unlock_a_keychain_latch_or_a_timeout() {
    // Each answer, then a Refresh within ten seconds: is it asked again?
    async fn asked_again(first: Usage) -> bool {
        let slot = crate::agent_usage::tests_slot();
        let reads = AtomicUsize::new(0);
        let read = |answer: Usage| {
            let reads = &reads;
            move || async move {
                reads.fetch_add(1, Ordering::SeqCst);
                answer
            }
        };
        crate::agent_usage::cached(&slot, true, || async { Some(0) }, read(first)).await;
        crate::agent_usage::cached(&slot, true, || async { Some(0) }, read(Usage::empty("claude", "ready", ""))).await;
        reads.load(Ordering::SeqCst) == 2
    }
    assert!(!asked_again(Usage::empty("claude", "ready", "")).await, "a good reading is served");
    assert!(asked_again(*usage(KEYCHAIN_LATCHED)).await, "a latch the Refresh lifts");
    assert!(asked_again(*usage(TIMED_OUT)).await, "a timeout");
    assert!(asked_again(*usage(KEYCHAIN_LOCKED)).await, "unlock, then Refresh");
    // A Keychain backing off after a dialog nobody answered stays KEYCHAIN_LATCHED.
    assert!(asked_again(*usage(READ_FAILED)).await, "a read failure");
    assert!(!asked_again(*usage(EXPIRED)).await, "and anything Claude Code must fix");
}

#[cfg(target_os = "macos")]
#[tokio::test]
async fn a_keychain_login_is_reused_and_read_again_only_on_refresh_or_rejection() {
    use crate::usage_keychain::fake_backend::{waits, Answer};
    let (dir, env) = keychain_profile(Answer::Found(profile("remembered", now_ms() + 2 * HOUR, None)));
    let service = claude_service(env.get("CLAUDE_CONFIG_DIR").as_deref(), None);
    let mock = Arc::new(Mock { usage: script([Ok(limits(1.0)), Ok(limits(2.0)), Ok(limits(3.0)), Err(FetchError::Http(401).into()), Ok(limits(4.0))]), ..Mock::default() });
    for _ in 0..2 {
        assert_eq!(setup::fetch_claude_with(&env, false, mock.clone()).await.status, "ready");
    }
    assert_eq!(waits(&service).len(), 1, "automatic checks reuse the login read once");
    assert_eq!(setup::fetch_claude_with(&env, true, mock.clone()).await.status, "ready");
    assert_eq!(waits(&service).len(), 2, "a manual refresh reads again");
    // Rejected: the Keychain is read once more and the check retried.
    assert_eq!(setup::fetch_claude_with(&env, false, mock.clone()).await.status, "ready");
    assert_eq!(waits(&service).len(), 3);
    let _ = std::fs::remove_dir_all(&dir);
}

#[cfg(target_os = "macos")]
#[tokio::test]
async fn a_remembered_login_near_expiry_is_read_again() {
    use crate::usage_keychain::fake_backend::{waits, Answer};
    let (dir, env) = keychain_profile(Answer::Found(profile("short", now_ms() + 2 * 60_000, None)));
    let service = claude_service(env.get("CLAUDE_CONFIG_DIR").as_deref(), None);
    let mock = Arc::new(Mock::default());
    setup::fetch_claude_with(&env, false, mock.clone()).await;
    setup::fetch_claude_with(&env, false, mock.clone()).await;
    assert_eq!(waits(&service).len(), 2, "within five minutes of expiry: not reused");
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_successful_read_ends_a_rate_limit_block() {
    let setup = Setup::new(
        &profile("valid", now_ms() + HOUR, None),
        Mock {
            usage: script([Err(UsageFailure { error: FetchError::Http(429), retry_after: Some("0".into()) }), Ok(limits(8.0)), Ok(limits(9.0))]),
            ..Mock::default()
        },
    );
    assert_eq!(setup.run().await.status, "error", "rate limited, nothing saved yet");
    // The server's own wait (0 s) has passed: a manual refresh asks, and succeeds.
    assert_eq!(setup.refresh().await.status, "ready");
    // The block is gone: an automatic check asks again too.
    assert_eq!(setup.run().await.windows[0].used_percent, 9.0);
}

#[cfg(target_os = "macos")]
#[tokio::test]
async fn a_refresh_after_a_latched_read_asks_at_once_even_with_a_saved_reading_shown() {
    use crate::usage_keychain::fake_backend::{install, Answer};
    let setup = Setup::new(b"{}", Mock::default());
    let service = format!("Claude Code-credentials-{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);
    let store = Store::Keychain(service.clone());
    install(&service, Answer::Found(profile("first", now_ms() + HOUR, None)));
    let reads = AtomicUsize::new(0);
    let check = |refresh: bool| {
        let (store, reads, check) = (store.clone(), &reads, Check { refresh, ..setup.check.clone() });
        move || async move {
            reads.fetch_add(1, Ordering::SeqCst);
            if refresh {
                crate::usage_keychain::clear_backoff(&service_of(&store));
            }
            usage_with_login(&[store], &check).await
        }
    };
    // A good reading is saved; then the Keychain read is denied (latched).
    assert_eq!(crate::agent_usage::cached(&crate::agent_usage::tests_slot(), false, || async { Some(0) }, check(false)).await.status, "ready");
    remembered().remove(&store);
    install(&service, Answer::Denied);
    let slot = crate::agent_usage::tests_slot();
    let latched = crate::agent_usage::cached(&slot, false, || async { Some(0) }, check(false)).await;
    assert_eq!((latched.status.as_str(), latched.stale, latched.action), ("ready", true, Some("refresh")), "the saved reading stands in");
    // The card asks for a Refresh: it runs at once, within the ten seconds.
    install(&service, Answer::Found(profile("allowed", now_ms() + HOUR, None)));
    let refreshed = crate::agent_usage::cached(&slot, true, || async { Some(0) }, check(true)).await;
    assert_eq!((refreshed.status.as_str(), refreshed.stale), ("ready", false), "{:?}", refreshed.message);
    assert_eq!(reads.load(Ordering::SeqCst), 3);
}

#[cfg(target_os = "macos")]
fn service_of(store: &Store) -> String {
    match store {
        Store::Keychain(service) => service.clone(),
        _ => unreachable!(),
    }
}

#[cfg(target_os = "macos")]
#[tokio::test]
async fn without_an_account_hint_a_remembered_login_is_reused_only_while_its_item_exists() {
    use crate::usage_keychain::fake_backend::{install, lookups, Answer};
    let (dir, env) = keychain_profile(Answer::Found(profile("remembered", now_ms() + 2 * HOUR, None)));
    let service = claude_service(env.get("CLAUDE_CONFIG_DIR").as_deref(), None);
    let mock = Arc::new(Mock::default());
    assert_eq!(setup::fetch_claude_with(&env, false, mock.clone()).await.status, "ready");
    // No account in `.claude.json`: each automatic check compares the item's
    // modification date (attributes only; one lookup was made at the read).
    assert_eq!(setup::fetch_claude_with(&env, false, mock.clone()).await.status, "ready");
    assert_eq!(lookups(&service), 2);
    assert_eq!(*mock.used.lock().unwrap(), ["remembered", "remembered"], "reused while it exists");
    // Signed out in Claude Code: the item is gone, so the remembered login is dropped.
    install(&service, Answer::Gone);
    let gone = setup::fetch_claude_with(&env, false, mock.clone()).await;
    assert_eq!(gone.status, "signedOut", "{:?}", gone.message);
    assert_eq!(mock.used.lock().unwrap().len(), 2, "the remembered login is not sent");
    let _ = std::fs::remove_dir_all(&dir);
}

#[cfg(target_os = "macos")]
#[tokio::test]
async fn an_expired_keychain_login_that_cannot_be_renewed_is_not_read_again_on_every_check() {
    use crate::usage_keychain::fake_backend::{waits, Answer};
    // Expired, with no refresh token: nothing can renew it here.
    let (dir, env) = keychain_profile(Answer::Found(profile("expired", now_ms() - HOUR, None)));
    let service = claude_service(env.get("CLAUDE_CONFIG_DIR").as_deref(), None);
    let mock = Arc::new(Mock::default());
    setup::fetch_claude_with(&env, false, mock.clone()).await;
    setup::fetch_claude_with(&env, false, mock.clone()).await;
    setup::fetch_claude_with(&env, false, mock.clone()).await;
    assert_eq!(waits(&service).len(), 1, "read once, then reused for up to 15 minutes");
    setup::fetch_claude_with(&env, true, mock.clone()).await;
    assert_eq!(waits(&service).len(), 2, "a Refresh reads it again");
    let _ = std::fs::remove_dir_all(&dir);
}
