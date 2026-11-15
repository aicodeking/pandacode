//! Runs of Claude Code around a Keychain login (macOS): never on a locked
//! Keychain, and what a run that outlives its check leaves behind.

#![cfg(target_os = "macos")]

use super::*;
use crate::usage_keychain::fake_backend::{install, Answer};

fn service_of(env: &ClaudeEnv) -> String {
    claude_service(env.get("CLAUDE_CONFIG_DIR").as_deref(), None)
}

#[tokio::test]
async fn a_keychain_that_locks_after_a_read_drops_the_remembered_login_and_never_starts_a_run() {
    let limited = Err(UsageFailure { error: FetchError::Http(429), retry_after: Some("600".into()) });
    for (failure, label) in [(limited, "rate limited, nothing saved"), (Err(FetchError::Http(503).into()), "network error")] {
        let cli = fake(printed(), || {});
        let (dir, env) = super::folder_with(&cli, true);
        install(&service_of(&env), Answer::Found(profile("valid", now_ms() + 2 * HOUR, None)));
        let mock = Arc::new(Mock { usage: script([Ok(limits(1.0)), failure]), ..Mock::default() });
        assert_eq!(setup::fetch_claude_with(&env, false, mock.clone()).await.status, "ready");
        assert!(remembered().contains_key(&Store::Keychain(service_of(&env))));
        // The Keychain locks: the remembered login is dropped, not reused.
        install(&service_of(&env), Answer::Locked);
        for refresh in [false, true] {
            let result = setup::fetch_claude_with(&env, refresh, mock.clone()).await;
            assert_eq!((result.cause, runs(&cli)), (Some(Cause::KeychainLocked), 0), "{label}: {:?}", result.message);
        }
        assert!(!remembered().contains_key(&Store::Keychain(service_of(&env))), "{label}");
        assert_eq!(mock.used.lock().unwrap().len(), 1, "{label}: nothing sent while locked");
        let _ = std::fs::remove_dir_all(dir);
    }
}

#[tokio::test(start_paused = true)]
async fn a_check_during_a_run_joins_it_and_keeps_the_fresh_login_not_the_copy_it_read_first() {
    let dir = temp_dir();
    let config = dir.to_string_lossy().into_owned();
    // A known account: a remembered login is not looked up again for 5 minutes.
    std::fs::write(dir.join(".claude.json"), r#"{"oauthAccount":{"emailAddress":"me@example.com"}}"#).unwrap();
    let env = ClaudeEnv { keychain: true, ..claude_env(Mode::Subscription, &[("CLAUDE_CONFIG_DIR".into(), config.clone())], &[]) };
    let service = service_of(&env);
    install(&service, Answer::Found(profile("old", 1000, Some("old-refresh"))));
    let refreshed = service.clone();
    let saves = move || install(&refreshed, Answer::Found(profile("fresh", now_ms() + 8 * HOUR, None)));
    let (cli, gate) = held(printed(), saves);
    setup::test_cli(&config, Cli::Ready(cli.clone(), Vec::new()));
    let mock = Arc::new(Mock::default());
    let deadline = Duration::from_millis(1200);
    let cut_off = super::cut_off(&cli, deadline, setup::fetch_claude_within(&env, false, mock.clone(), deadline)).await;
    assert_eq!(cut_off.cause, Some(Cause::StillRunning));
    // A check while it still runs reads the expired login first, then waits
    // for the run (let go once the check has begun) and reads what Claude Code saved.
    let (joined, ()) = tokio::join!(setup::fetch_claude_with(&env, false, mock.clone()), async { gate.open() });
    assert_eq!((joined.status.as_str(), runs(&cli)), ("ready", 1), "{:?}", joined.message);
    // What is remembered is the fresh login, never the expired copy.
    let store = Store::Keychain(service.clone());
    assert_eq!(remembered().get(&store).map(|entry| entry.login.access_token.clone()).as_deref(), Some("fresh"));
    let next = setup::fetch_claude_with(&env, false, mock.clone()).await;
    assert_eq!(next.status, "ready");
    assert_eq!(*mock.used.lock().unwrap(), ["fresh", "fresh"]);
    let _ = std::fs::remove_dir_all(dir);
}

/// A run that goes on until it is asked to stop (at most 20 s).
#[derive(Default)]
struct UntilStopped {
    started: std::sync::atomic::AtomicBool,
    stopped: std::sync::atomic::AtomicBool,
}

impl RunCli for UntilStopped {
    fn run(&self, _env: &[(String, String)], _timeout: Duration, stop: &dyn Fn() -> bool) -> Result<Exited, RunFailure> {
        self.started.store(true, Ordering::SeqCst);
        let until = Instant::now() + Duration::from_secs(20);
        while Instant::now() < until {
            if stop() {
                self.stopped.store(true, Ordering::SeqCst);
                return Err(RunFailure::Lost);
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        Err(RunFailure::TimedOut)
    }
}

#[tokio::test]
async fn a_keychain_that_locks_during_a_run_stops_it() {
    let dir = temp_dir();
    let config = dir.to_string_lossy().into_owned();
    let env = ClaudeEnv { keychain: true, ..claude_env(Mode::Subscription, &[("CLAUDE_CONFIG_DIR".into(), config.clone())], &[]) };
    install(&service_of(&env), Answer::Found(profile("old", 1000, Some("old-refresh"))));
    let runner = Arc::new(UntilStopped::default());
    setup::test_cli(&config, Cli::Ready(runner.clone(), Vec::new()));
    let locks = async {
        while !runner.started.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        install(&service_of(&env), Answer::Locked);
    };
    let (result, ()) = tokio::join!(setup::fetch_claude_with(&env, false, Arc::new(Mock::default())), locks);
    assert!(runner.stopped.load(Ordering::SeqCst), "asked to stop once the Keychain locked: {:?}", result.message);
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn the_remembered_login_keeps_parsed_fields_only() {
    let cli = fake(exits(Some(1), b"", "fetch failed"), || {});
    let (dir, env) = super::folder_with(&cli, true);
    install(&service_of(&env), Answer::Found(profile("old", 1000, Some("old-refresh"))));
    setup::fetch_claude_with(&env, false, Arc::new(Mock::default())).await;
    let store = Store::Keychain(service_of(&env));
    let remembered = remembered();
    let login = &remembered.get(&store).expect("remembered").login;
    // Whether it can be refreshed is kept; the refresh token itself never is.
    assert!(login.refreshable && login.access_token == "old");
    assert_eq!(login.fitness(now_ms()), Fitness::Refreshable);
    drop(remembered);
    let _ = std::fs::remove_dir_all(dir);
}
