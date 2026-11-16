//! Asking Claude Code to refresh an expired login: the scripted CLI stands in
//! for the user's Claude Code (and, like it, saves a fresh login).

use super::super::cli::{self, Cli, Exited, RunCli, RunFailure};
use super::*;
use crate::providers::claude_auth::Mode;

/// Claude Code's JSON answer for `-p /usage`, with `result` text.
fn answer(result: &str) -> Vec<u8> {
    serde_json::to_vec(&json!({"type": "result", "subtype": "success", "is_error": false, "num_turns": 0, "total_cost_usd": 0, "result": result})).unwrap()
}

const PRINTED: &str = "You are currently using your subscription to power your Claude Code usage\n\nCurrent session: 12% used · resets 3pm (America/New_York)\nCurrent week (all models): 48% used · resets Nov 15 at 8pm (America/New_York)\nCurrent week (Sonnet only): 7% used\n\nWhat's contributing to your usage?\nLast 24h · 3 requests · 1 session";

/// How a scripted run ends: exit status, stdout, stderr.
type Exit = Result<(Option<i32>, Vec<u8>, Vec<u8>), RunFailure>;

/// A scripted Claude Code: how it exits, what it saves when run, and the
/// gate it waits at (open unless a test holds the run).
pub(super) struct FakeCli {
    exit: Exit,
    on_run: Box<dyn Fn() + Send + Sync>,
    gate: Gate,
    runs: AtomicUsize,
}

impl RunCli for FakeCli {
    fn run(&self, _env: &[(String, String)], _timeout: Duration, _stop: &dyn Fn() -> bool) -> Result<Exited, RunFailure> {
        self.runs.fetch_add(1, Ordering::SeqCst);
        self.gate.wait();
        (self.on_run)();
        self.exit.clone().map(|(status, stdout, stderr)| Exited { status, stdout, stderr })
    }
}

fn fake(exit: Exit, on_run: impl Fn() + Send + Sync + 'static) -> Arc<FakeCli> {
    Arc::new(FakeCli { exit, on_run: Box::new(on_run), gate: open_gate(), runs: AtomicUsize::new(0) })
}

/// A scripted run held until the test opens its gate: it outlasts any check
/// that waits for it, however late the timers fire.
fn held(exit: Exit, on_run: impl Fn() + Send + Sync + 'static) -> (Arc<FakeCli>, Gate) {
    let gate = Gate::default();
    (Arc::new(FakeCli { exit, on_run: Box::new(on_run), gate: gate.clone(), runs: AtomicUsize::new(0) }), gate)
}

/// An open gate: the run goes straight through.
pub(super) fn open_gate() -> Gate {
    let gate = Gate::default();
    gate.open();
    gate
}

/// Where a held run waits (`held`); `open` lets it finish.
#[derive(Clone, Default)]
pub(super) struct Gate(Arc<(Mutex<bool>, std::sync::Condvar)>);

impl Gate {
    pub(super) fn open(&self) {
        *self.0 .0.lock().unwrap() = true;
        self.0 .1.notify_all();
    }

    fn wait(&self) {
        let mut open = self.0 .0.lock().unwrap();
        while !*open {
            open = self.0 .1.wait(open).unwrap();
        }
    }
}

fn printed() -> Exit {
    exits(Some(0), &answer(PRINTED), "")
}

fn exits(status: Option<i32>, stdout: &[u8], stderr: &str) -> Exit {
    Ok((status, stdout.to_vec(), stderr.as_bytes().to_vec()))
}

fn with_cli(setup: &mut Setup, cli: &Arc<FakeCli>) {
    setup.check.cli = Cli::Ready(cli.clone(), Vec::new());
}

/// A check whose login has expired.
fn expired() -> Setup {
    Setup::new(&profile("old", 1000, Some("old-refresh")), Mock::default())
}

/// Claude Code saving a fresh login to `path`, as it does when it refreshes.
fn saves_fresh_login(path: &Path) -> impl Fn() + Send + Sync + 'static {
    let path = path.to_path_buf();
    move || save_atomically(&path, &profile("fresh", now_ms() + 8 * HOUR, Some("fresh-refresh")))
}

/// Writes `bytes` to `path` in one step (a temporary file renamed over it),
/// so a check reading meanwhile sees the old login or the new, never half of one.
fn save_atomically(path: &Path, bytes: &[u8]) {
    let next = path.with_extension("next");
    std::fs::write(&next, bytes).unwrap();
    std::fs::rename(&next, path).unwrap();
}

/// Polls `done` for up to five seconds.
async fn eventually(done: impl Fn() -> bool) -> bool {
    for _ in 0..100 {
        if done() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    false
}

fn runs(cli: &FakeCli) -> usize {
    cli.runs.load(Ordering::SeqCst)
}

/// Drives `check` on the paused clock (`start_paused`), moving time past its
/// `deadline` only once `cli`'s held run has begun: the check answers "still
/// running" while the run goes on, however loaded the machine. (The run's
/// blocking thread holds paused time still, so nothing else moves it.)
pub(super) async fn cut_off(cli: &FakeCli, deadline: Duration, check: impl std::future::Future<Output = Usage>) -> Usage {
    let drive = async {
        while runs(cli) == 0 {
            tokio::task::yield_now().await;
        }
        tokio::time::advance(deadline).await;
    };
    tokio::join!(check, drive).0
}

#[tokio::test]
async fn an_expired_login_is_refreshed_by_claude_code_then_read_again() {
    let mut setup = expired();
    let cli = fake(printed(), saves_fresh_login(&setup.path));
    with_cli(&mut setup, &cli);
    let result = setup.run().await;
    assert_eq!((result.status.as_str(), result.source.as_deref()), ("ready", Some("Claude Code login · local credential file")), "{:?}", result.message);
    assert_eq!(*setup.mock.used.lock().unwrap(), ["fresh"], "the expired token is never sent");
    assert_eq!(runs(&cli), 1);
    assert_eq!(stored(&setup.path)["claudeAiOauth"]["refreshToken"], "fresh-refresh", "written by Claude Code, not PandaCode");
}

#[tokio::test]
async fn a_run_that_fails_after_refreshing_is_still_followed_by_a_reread() {
    let mut setup = expired();
    let cli = fake(exits(Some(1), b"something went wrong", ""), saves_fresh_login(&setup.path));
    with_cli(&mut setup, &cli);
    let result = setup.run().await;
    assert_eq!(result.status, "ready", "{:?}", result.message);
    assert_eq!(*setup.mock.used.lock().unwrap(), ["fresh"]);
}

#[tokio::test]
async fn when_the_store_still_fails_the_usage_claude_code_printed_stands_in() {
    let mut setup = expired();
    let cli = fake(printed(), || {});
    with_cli(&mut setup, &cli);
    let result = setup.run().await;
    assert_eq!((result.status.as_str(), result.source.as_deref()), ("ready", Some("Claude Code CLI")));
    assert_eq!(result.windows[1].used_percent, 48.0);
    assert!(setup.mock.used.lock().unwrap().is_empty(), "nothing sent with the expired login");
}

#[tokio::test]
async fn printed_numbers_win_over_a_saved_reading_shown_for_a_rate_limit() {
    let mut setup = Setup::new(&profile("valid", now_ms() + HOUR, Some("r")), Mock {
        usage: script([Ok(limits(10.0)), Err(UsageFailure { error: FetchError::Http(429), retry_after: Some("60".into()) })]),
        ..Mock::default()
    });
    assert_eq!(setup.run().await.windows[0].used_percent, 10.0, "a saved reading now exists");
    std::fs::write(&setup.path, profile("old", 1000, Some("old-refresh"))).unwrap();
    let cli = fake(printed(), saves_fresh_login(&setup.path));
    with_cli(&mut setup, &cli);
    // Claude Code refreshes; the re-read is rate limited (the saved 10% would stand in).
    let result = setup.run().await;
    assert_eq!((result.source.as_deref(), result.windows[1].used_percent), (Some("Claude Code CLI"), 48.0));
}

#[tokio::test]
async fn a_fresh_429_runs_claude_code_only_without_a_server_wait() {
    // With Retry-After the server set a wait: Claude Code is not run inside it.
    let waiting = Err(UsageFailure { error: FetchError::Http(429), retry_after: Some("600".into()) });
    let mut setup = Setup::new(&profile("valid", now_ms() + HOUR, Some("r")), Mock { usage: script([waiting]), ..Mock::default() });
    let cli = fake(printed(), || {});
    with_cli(&mut setup, &cli);
    let blocked = setup.run().await;
    assert_eq!((blocked.action, blocked.cause, runs(&cli)), (Some("rateLimited"), Some(Cause::RateLimitBlocked), 0));
    // Without one, nothing saved: Claude Code's numbers.
    let bare = Err(UsageFailure { error: FetchError::Http(429), retry_after: None });
    let mut setup = Setup::new(&profile("valid", now_ms() + HOUR, Some("r")), Mock { usage: script([bare]), ..Mock::default() });
    let cli = fake(printed(), || {});
    with_cli(&mut setup, &cli);
    let result = setup.run().await;
    assert_eq!((result.source.as_deref(), result.windows[1].used_percent, runs(&cli)), (Some("Claude Code CLI"), 48.0, 1));
    assert_eq!(*setup.mock.used.lock().unwrap(), ["valid"], "no second request into the rate limit");
}

#[tokio::test]
async fn an_old_claude_code_shows_the_update_message_and_runs_back_off() {
    for exit in [exits(Some(1), b"", "error: unknown option '--safe-mode'"), exits(Some(0), &answer("/usage isn't available in this environment."), "")] {
        let mut setup = expired();
        let cli = fake(exit, || {});
        with_cli(&mut setup, &cli);
        let result = setup.run().await;
        assert_eq!((result.message.as_deref(), result.action), (Some(UPDATE_CLAUDE.1), Some("updateClaude")));
        // Fifteen minutes on, an outdated Claude Code still holds runs back
        // (an hour, doubling), and the card keeps saying why.
        cli::age_runs(&setup.check.profile.key, Duration::from_secs(16 * 60));
        let waiting = setup.run().await;
        assert_eq!((runs(&cli), waiting.message.as_deref(), waiting.action), (1, Some(UPDATE_CLAUDE.1), Some("updateClaude")), "backing off");
        // …until a Refresh you press.
        setup.refresh().await;
        assert_eq!(runs(&cli), 2);
    }
}

#[tokio::test]
async fn a_run_that_could_not_start_hands_its_slot_back_and_keeps_the_expired_message() {
    let mut setup = expired();
    let cli = fake(Err(RunFailure::NotStarted), || {});
    with_cli(&mut setup, &cli);
    let result = setup.run().await;
    assert_eq!((result.message.as_deref(), result.action), (Some(EXPIRED.1), Some("expired")));
    setup.run().await;
    assert_eq!(runs(&cli), 2, "the slot was not spent");
}

/// Minutes from now to `at` (ms since the epoch), rounded.
fn minutes_until(at: Option<u64>) -> u64 {
    (at.unwrap_or(0).saturating_sub(now_ms()) + 30_000) / 60_000
}

#[tokio::test]
async fn failed_runs_back_off_doubling_and_say_when_the_next_try_is() {
    for exit in [Err(RunFailure::TimedOut), exits(Some(1), b"", "fetch failed")] {
        let mut setup = expired();
        let cli = fake(exit, || {});
        with_cli(&mut setup, &cli);
        let key = setup.check.profile.key.clone();
        let first = setup.run().await;
        assert_eq!((first.message.as_deref(), first.action, first.cause), (Some(CLI_FAILED.1), Some("expired"), Some(Cause::CliFailed)));
        // No promise of a background retry: when opening the panel asks again.
        assert_eq!(minutes_until(first.auto_retry_at), 15);
        // Offline: the second failure in a row waits 30 minutes, not 15.
        cli::age_runs(&key, Duration::from_secs(16 * 60));
        let second = setup.run().await;
        assert_eq!((runs(&cli), minutes_until(second.auto_retry_at)), (2, 30));
        cli::age_runs(&key, Duration::from_secs(16 * 60));
        setup.run().await;
        assert_eq!(runs(&cli), 2, "still backing off");
        cli::age_runs(&key, Duration::from_secs(15 * 60));
        setup.run().await;
        assert_eq!(runs(&cli), 3, "after 30 minutes");
        // A Refresh you press runs it once more, but the backoff stands (and grows).
        let manual = setup.refresh().await;
        assert_eq!((runs(&cli), minutes_until(manual.auto_retry_at)), (4, 120));
        cli::age_runs(&key, Duration::from_secs(16 * 60));
        setup.run().await;
        assert_eq!(runs(&cli), 4, "not wiped by the Refresh");
    }
}

#[tokio::test]
async fn a_refused_login_or_no_subscription_usage_is_named_with_its_fix() {
    let no_usage = answer("Total cost: $0.00\nTotal duration (API): 0s");
    for (exit, message) in [(exits(Some(1), b"", "OAuth error: invalid_grant"), CLI_SIGN_IN), (exits(Some(0), &no_usage, ""), CLI_NO_USAGE)] {
        let mut setup = expired();
        with_cli(&mut setup, &fake(exit, || {}));
        let result = setup.run().await;
        assert_eq!((result.message.as_deref(), result.action), (Some(message.1), Some(message.2)));
    }
}

#[tokio::test]
async fn claude_code_runs_at_most_once_per_fifteen_minutes_and_a_manual_refresh_once_more() {
    let mut setup = expired();
    let cli = fake(exits(Some(1), b"", "fetch failed"), || {});
    with_cli(&mut setup, &cli);
    setup.run().await;
    setup.run().await;
    assert_eq!(runs(&cli), 1, "not again on the next automatic check");
    setup.refresh().await;
    assert_eq!(runs(&cli), 2, "a manual Refresh runs it once more");
    setup.refresh().await;
    assert_eq!(runs(&cli), 2, "but only once");
}

#[tokio::test(start_paused = true)]
async fn a_deadline_during_the_run_answers_meanwhile_and_the_next_check_reads_what_claude_code_saved() {
    let mut setup = expired();
    let (cli, gate) = held(printed(), saves_fresh_login(&setup.path));
    with_cli(&mut setup, &cli);
    setup.check.deadline = Duration::from_millis(1000);
    let cut_off = cut_off(&cli, setup.check.deadline, setup.run()).await;
    assert_eq!((cut_off.message.as_deref(), cut_off.cause), (Some(STILL_RUNNING.1), Some(Cause::StillRunning)));
    // The run finishes in the background; the next check reads the store afresh.
    gate.open();
    cli::wait_for_run(&setup.check.profile.key, Duration::from_secs(30)).await;
    assert_eq!(stored(&setup.path)["claudeAiOauth"]["refreshToken"], "fresh-refresh");
    setup.check.deadline = Duration::from_secs(30);
    let next = setup.run().await;
    assert_eq!((next.status.as_str(), runs(&cli)), ("ready", 1), "{:?}", next.message);
}

#[tokio::test]
async fn a_fresh_login_the_service_rejects_is_refreshed_by_claude_code_once() {
    let mut setup = Setup::new(&profile("valid", now_ms() + HOUR, Some("r")), Mock { usage: script([Err(FetchError::Http(401).into()), Ok(limits(31.0))]), ..Mock::default() });
    let cli = fake(printed(), saves_fresh_login(&setup.path));
    with_cli(&mut setup, &cli);
    let result = setup.run().await;
    assert_eq!((result.status.as_str(), result.windows[0].used_percent), ("ready", 31.0), "{:?}", result.message);
    assert_eq!(*setup.mock.used.lock().unwrap(), ["valid", "fresh"]);
    assert_eq!(runs(&cli), 1);
}

#[tokio::test]
async fn with_the_setting_off_an_expired_login_says_so_and_nothing_runs() {
    let mut setup = expired();
    setup.check.cli = Cli::Off;
    let result = setup.run().await;
    assert_eq!(result.message.as_deref(), Some(EXPIRED_OFF.1));
    assert!(EXPIRED_OFF.1.contains("Let PandaCode ask Claude Code for usage when it can’t read it"));
    assert!(setup.mock.used.lock().unwrap().is_empty());
    let mut missing = expired();
    missing.check.cli = Cli::Missing;
    assert_eq!(missing.run().await.message.as_deref(), Some(EXPIRED.1), "no Claude Code found");
}

#[tokio::test]
async fn the_reset_text_claude_code_printed_is_kept_in_the_saved_reading() {
    let mut setup = expired();
    with_cli(&mut setup, &fake(printed(), || {}));
    assert_eq!(setup.run().await.source.as_deref(), Some("Claude Code CLI"));
    // A later transient error shows the saved reading, reset text included.
    setup.check.cli = Cli::Missing;
    std::fs::write(&setup.path, profile("valid", now_ms() + HOUR, None)).unwrap();
    *setup.mock.usage.lock().unwrap() = [Err(FetchError::Http(503).into())].into();
    let saved = setup.run().await;
    assert!(saved.stale);
    assert_eq!(saved.windows[1].detail.as_deref(), Some("Resets Nov 15 at 8pm (America/New_York)"));
}

/// The usage service's scripted answers.
type Answers = Vec<Result<Value, UsageFailure>>;

#[tokio::test]
async fn any_problem_but_an_active_rate_limit_asks_claude_code_and_shows_what_it_printed() {
    let fresh = profile("valid", now_ms() + HOUR, None);
    // No login, an unrecognized store, an unreadable one, a 5xx from the service.
    let unavailable = || vec![Err(FetchError::Http(503).into()), Err(FetchError::Http(503).into())];
    let cases: [(&[u8], &str, Answers); 4] = [
        (b"", "missing", Vec::new()),
        (b"not json", "write", Vec::new()),
        (b"", "folder", Vec::new()),
        (&fresh, "write", unavailable()),
    ];
    for (content, how, answer) in cases {
        let mut setup = Setup::new(b"{}", Mock { usage: script(answer), ..Mock::default() });
        match how {
            "missing" => std::fs::remove_file(&setup.path).unwrap(),
            "folder" => {
                std::fs::remove_file(&setup.path).unwrap();
                std::fs::create_dir(&setup.path).unwrap();
            }
            _ => std::fs::write(&setup.path, content).unwrap(),
        }
        let cli = fake(printed(), || {});
        with_cli(&mut setup, &cli);
        let result = setup.run().await;
        assert_eq!((result.source.as_deref(), runs(&cli)), (Some("Claude Code CLI"), 1), "{how}: {:?}", result.message);
    }
}

#[tokio::test]
async fn nothing_runs_claude_code_inside_the_servers_wait_not_even_a_refresh() {
    let mut setup = Setup::new(&profile("valid", now_ms() + HOUR, None), Mock {
        usage: script([Err(UsageFailure { error: FetchError::Http(429), retry_after: Some("600".into()) })]),
        ..Mock::default()
    });
    assert_eq!(setup.run().await.action, Some("rateLimited"), "no CLI yet");
    let cli = fake(printed(), || {});
    with_cli(&mut setup, &cli);
    for result in [setup.run().await, setup.refresh().await] {
        assert_eq!((result.action, result.cause, runs(&cli)), (Some("rateLimited"), Some(Cause::RateLimitBlocked), 0));
    }
    assert_eq!(setup.mock.used.lock().unwrap().len(), 1, "nothing sent inside the server's wait");
}

#[tokio::test]
async fn after_the_servers_wait_a_new_429_over_an_old_saved_reading_asks_claude_code() {
    for (exit, expected) in [(printed(), 48.0), (exits(Some(1), b"", "fetch failed"), 10.0)] {
        let limited = || Err(UsageFailure { error: FetchError::Http(429), retry_after: Some("600".into()) });
        let bare = Err(UsageFailure { error: FetchError::Http(429), retry_after: None });
        let mut setup = Setup::new(&profile("valid", now_ms() + HOUR, None), Mock { usage: script([Ok(limits(10.0)), limited(), bare]), ..Mock::default() });
        setup.run().await;
        let cli = fake(exit, || {});
        with_cli(&mut setup, &cli);
        // A fresh saved reading stands in without a run.
        let fresh = setup.run().await;
        assert_eq!((fresh.action, fresh.windows[0].used_percent, runs(&cli)), (Some("rateLimited"), 10.0, 0));
        // The saved reading grows old, but the server's wait still holds: no run.
        limits::age_saved(&setup.check.profile, Duration::from_secs(20 * 60)).await;
        assert_eq!((setup.run().await.cause, runs(&cli)), (Some(Cause::RateLimitBlocked), 0));
        // Once it has passed, the service is asked; a new 429 without a wait,
        // over an old reading, runs Claude Code.
        limits::unblock(&setup.check.profile);
        let result = setup.run().await;
        let weekly = result.windows.iter().find(|w| w.label == "Weekly").map(|w| w.used_percent);
        assert_eq!((runs(&cli), weekly), (1, Some(expected)), "{:?}", result.message);
        assert_eq!(setup.mock.used.lock().unwrap().len(), 3);
    }
}

/// A usage service that rejects the first request (401), then never answers.
#[derive(Default)]
struct RejectsThenStalls(AtomicUsize);

impl Remote for RejectsThenStalls {
    fn usage(&self, _token: String) -> crate::agent_usage_claude_remote::Pending<'_, Result<Value, UsageFailure>> {
        let first = self.0.fetch_add(1, Ordering::SeqCst) == 0;
        Box::pin(async move {
            if first {
                return Err(FetchError::Http(401).into());
            }
            // Never answers: only the check's deadline ends it.
            std::future::pending::<()>().await;
            Ok(limits(77.0))
        })
    }
}

// Paused clock: the run (a blocking task) holds time still, so it always
// finishes inside the check; the stalled re-read then meets the deadline in
// virtual time, never racing the machine's load.
#[tokio::test(start_paused = true)]
async fn a_reread_that_cannot_finish_in_time_leaves_the_printed_numbers() {
    let mut setup = Setup::new(&profile("valid", now_ms() + HOUR, None), Mock::default());
    setup.check.remote = Arc::new(RejectsThenStalls::default());
    let cli = fake(printed(), saves_fresh_login(&setup.path));
    with_cli(&mut setup, &cli);
    setup.check.deadline = Duration::from_millis(600);
    let started = tokio::time::Instant::now();
    let result = setup.run().await;
    assert_eq!((result.source.as_deref(), result.windows.get(1).map(|w| w.used_percent)), (Some("Claude Code CLI"), Some(48.0)), "{:?}", result.message);
    assert!(started.elapsed() <= Duration::from_millis(600), "the re-read was cut short at the deadline: {:?}", started.elapsed());
}

#[path = "agent_usage_claude_cli_outcome_tests.rs"]
mod outcome;

/// What Claude Code 2.1.322 prints when its own usage request fails (429,
/// network, 5xx): the subscription header, no usage lines, exit 0.
fn header_only() -> Exit {
    exits(Some(0), &answer("You are currently using your subscription to power your Claude Code usage"), "")
}

#[tokio::test]
async fn header_only_output_after_a_rate_limit_or_network_failure_leaves_the_checks_own_answer() {
    let limited = || Err(UsageFailure { error: FetchError::Http(429), retry_after: None });
    for (first, label) in [(limited(), "rate limit"), (Err(FetchError::Http(503).into()), "network")] {
        let unavailable = Err(FetchError::Http(503).into());
        let mut setup = Setup::new(&profile("valid", now_ms() + HOUR, None), Mock { usage: script([first, unavailable]), ..Mock::default() });
        let cli = fake(header_only(), || {});
        with_cli(&mut setup, &cli);
        let result = setup.run().await;
        assert_eq!(runs(&cli), 1, "{label}");
        assert_ne!(result.message.as_deref(), Some(CLI_NO_USAGE.1), "{label}: not called a missing subscription");
        assert!(result.windows.is_empty() && result.status == "error", "{label}: {:?}", result.message);
        if label == "rate limit" {
            assert_eq!(result.action, Some("rateLimited"));
        }
    }
}

#[tokio::test]
async fn header_only_output_with_a_saved_reading_shows_the_saved_reading() {
    let limited = || Err(UsageFailure { error: FetchError::Http(429), retry_after: Some("600".into()) });
    let unavailable = || Err(FetchError::Http(503).into());
    // A 429 with a saved reading shows it without a run; a network failure runs
    // Claude Code, which prints only the header, and the saved reading stands.
    for (failures, label, expected_runs) in [(vec![limited()], "rate limit", 0), (vec![unavailable(), unavailable()], "network", 1)] {
        let answers: Answers = std::iter::once(Ok(limits(10.0))).chain(failures).collect();
        let mut setup = Setup::new(&profile("valid", now_ms() + HOUR, None), Mock { usage: script(answers), ..Mock::default() });
        assert_eq!(setup.run().await.windows[0].used_percent, 10.0, "a saved reading");
        let cli = fake(header_only(), || {});
        with_cli(&mut setup, &cli);
        let result = setup.run().await;
        assert_eq!((result.stale, result.windows[0].used_percent, runs(&cli)), (true, 10.0, expected_runs), "{label}: {:?}", result.message);
        assert_ne!(result.message.as_deref(), Some(CLI_NO_USAGE.1));
    }
    // An expired login whose refresh by Claude Code met the same failure.
    let mut setup = Setup::new(&profile("valid", now_ms() + HOUR, None), Mock { usage: script([Ok(limits(10.0))]), ..Mock::default() });
    setup.run().await;
    std::fs::write(&setup.path, profile("old", 1000, Some("old-refresh"))).unwrap();
    with_cli(&mut setup, &fake(header_only(), || {}));
    let result = setup.run().await;
    assert_eq!((result.stale, result.windows[0].used_percent, result.message.as_deref()), (true, 10.0, Some(CLI_FAILED.1)));
}

#[tokio::test]
async fn never_signed_in_or_a_locked_keychain_never_runs_claude_code() {
    let mut setup = Setup::new(b"{}", Mock::default());
    std::fs::remove_file(&setup.path).unwrap();
    setup.check.profile = Profile::new(&setup.dir.to_string_lossy(), None, Some(setup.app.clone()));
    let cli = fake(printed(), || {});
    with_cli(&mut setup, &cli);
    let result = setup.run().await;
    assert_eq!((result.message.as_deref(), runs(&cli)), (Some(NOT_FOUND.1), 0), "no account in .claude.json: never signed in");
}

/// A usage service that takes 700 ms over each request.
struct Delayed;

impl Remote for Delayed {
    fn usage(&self, _token: String) -> crate::agent_usage_claude_remote::Pending<'_, Result<Value, UsageFailure>> {
        Box::pin(async {
            tokio::time::sleep(Duration::from_millis(700)).await;
            Ok(limits(77.0))
        })
    }
}

// Paused clock: the run takes no virtual time, so exactly 1 s is left.
#[tokio::test(start_paused = true)]
async fn the_reread_after_a_run_gets_all_the_time_the_check_has_left() {
    let mut setup = expired();
    setup.check.remote = Arc::new(Delayed);
    let cli = fake(printed(), saves_fresh_login(&setup.path));
    with_cli(&mut setup, &cli);
    // 1 s is left after the run: enough for a 700 ms re-read, not with the
    // margin (400 ms in tests) taken off.
    setup.check.deadline = Duration::from_millis(1000);
    let result = setup.run().await;
    assert_eq!((result.status.as_str(), result.windows[0].used_percent), ("ready", 77.0), "{:?}", result.source);
}

#[tokio::test(start_paused = true)]
async fn a_refresh_during_a_run_joins_it_instead_of_starting_another() {
    let mut setup = expired();
    let (cli, gate) = held(printed(), saves_fresh_login(&setup.path));
    with_cli(&mut setup, &cli);
    setup.check.deadline = Duration::from_millis(1000);
    assert_eq!(cut_off(&cli, setup.check.deadline, setup.run()).await.cause, Some(Cause::StillRunning), "the run outlives its check");
    assert!(cli::asking(&setup.check.profile.key), "its card says Asking Claude Code…");
    // A Refresh pressed now waits for that run (let go once it has begun),
    // then reads what it saved.
    setup.check.deadline = Duration::from_secs(30);
    let key = setup.check.profile.key.clone();
    // `join!` can open the gate on Refresh's first await, before it sees the
    // run still under way, so the blocking thread finishes it and Refresh
    // starts a second one. Release the run only once Refresh is waiting on it.
    let refresh = tokio::spawn(async move { setup.refresh().await });
    for _ in 0..10_000 {
        if cli::waiting_for(&key) {
            break;
        }
        tokio::task::yield_now().await;
    }
    assert!(cli::waiting_for(&key), "refresh never joined the in-progress run");
    gate.open();
    let refreshed = refresh.await.expect("refresh task");
    assert_eq!((refreshed.status.as_str(), runs(&cli)), ("ready", 1), "{:?}", refreshed.message);
    // The Refresh may read the saved login just before the run marks itself over.
    assert!(eventually(|| !cli::asking(&key)).await);
}

/// A Claude Code runner that panics.
struct Panics(AtomicUsize);

impl RunCli for Panics {
    fn run(&self, _env: &[(String, String)], _timeout: Duration, _stop: &dyn Fn() -> bool) -> Result<Exited, RunFailure> {
        self.0.fetch_add(1, Ordering::SeqCst);
        panic!("the runner broke");
    }
}

#[tokio::test]
async fn a_panic_in_the_run_is_a_failed_run_not_a_timeout() {
    let mut setup = expired();
    let panics = Arc::new(Panics(AtomicUsize::new(0)));
    setup.check.cli = Cli::Ready(panics.clone(), Vec::new());
    let result = setup.run().await;
    assert_eq!(result.cause, Some(Cause::CliFailed), "{:?}", result.message);
    // The setup is not left marked as running: a Refresh may run it again.
    assert!(!cli::asking(&setup.check.profile.key));
    setup.refresh().await;
    assert_eq!(panics.0.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn claude_code_is_not_run_while_another_claude_code_holds_its_refresh_lock() {
    let mut setup = expired();
    let cli = fake(printed(), saves_fresh_login(&setup.path));
    with_cli(&mut setup, &cli);
    let lock = setup.dir.join(".oauth_refresh.lock");
    std::fs::create_dir(&lock).unwrap();
    assert_eq!((setup.run().await.cause, runs(&cli)), (Some(Cause::Expired), 0), "held: no second refresher");
    // Not touched for over a minute: stale, so Claude Code runs.
    let old = std::time::SystemTime::now() - Duration::from_secs(90);
    std::fs::File::open(&lock).unwrap().set_modified(old).unwrap();
    assert_eq!((setup.run().await.status.as_str(), runs(&cli)), ("ready", 1));
}

#[tokio::test]
async fn a_keychain_locked_right_before_the_run_never_starts_it_and_gives_the_slot_back() {
    let cli = fake(printed(), || {});
    let key = format!("locked-before-{}", uuid::Uuid::new_v4());
    let ready = || Cli::Ready(cli.clone(), Vec::new());
    let run = cli::start(&ready(), &key, false, Duration::from_secs(30)).expect("a run").guarded(Arc::new(|| false));
    assert!(matches!(run.spawn(|_| {}).await.unwrap(), cli::Outcome::NotStarted));
    assert_eq!(runs(&cli), 0, "Claude Code never started");
    assert!(cli::start(&ready(), &key, false, Duration::from_secs(30)).is_ok(), "the slot is the profile's again");
}

#[tokio::test]
async fn a_panic_after_the_run_still_records_it_and_ends_it() {
    let cli = fake(exits(Some(1), b"", "fetch failed"), || {});
    let key = format!("panicking-done-{}", uuid::Uuid::new_v4());
    let ready = || Cli::Ready(cli.clone(), Vec::new());
    let run = cli::start(&ready(), &key, false, Duration::from_secs(30)).expect("a run");
    let outcome = run.spawn(|_| panic!("saving what it printed broke")).await.expect("the run's thread survives");
    assert!(matches!(outcome, cli::Outcome::Failed));
    assert!(!cli::running(&key), "no longer under way");
    // Recorded: the failure backs off, so an automatic check may not run it again.
    assert_eq!(cli::start(&ready(), &key, false, Duration::from_secs(30)).err(), Some(cli::NotRun::Waiting));
    assert!(cli::start(&ready(), &key, true, Duration::from_secs(30)).is_ok(), "a Refresh still may");
}

#[tokio::test(start_paused = true)]
async fn usage_a_run_prints_after_its_check_stopped_waiting_is_saved_for_the_next_check() {
    let mut setup = expired();
    let (cli, gate) = held(printed(), || {});
    with_cli(&mut setup, &cli);
    setup.check.deadline = Duration::from_millis(1000);
    let cut_off = cut_off(&cli, setup.check.deadline, setup.run()).await;
    assert_eq!((cut_off.cause, cut_off.windows.len()), (Some(Cause::StillRunning), 0), "nothing saved yet");
    gate.open();
    cli::wait_for_run(&setup.check.profile.key, Duration::from_secs(30)).await;
    // The login is still expired (and the slot spent): the printed numbers stand in, marked saved.
    setup.check.deadline = Duration::from_secs(30);
    let next = setup.run().await;
    let weekly = next.windows.iter().find(|w| w.label == "Weekly").map(|w| w.used_percent);
    assert_eq!((next.stale, weekly, next.source.as_deref(), runs(&cli)), (true, Some(48.0), Some(cli::SOURCE), 1), "{:?}", next.message);
}

#[tokio::test]
async fn a_refused_login_or_no_usage_backs_off_like_a_failed_run() {
    let no_usage = answer("Total cost: $0.00");
    for exit in [exits(Some(1), b"", "OAuth error: invalid_grant"), exits(Some(0), &no_usage, "")] {
        let mut setup = expired();
        let cli = fake(exit, || {});
        with_cli(&mut setup, &cli);
        let key = setup.check.profile.key.clone();
        setup.run().await;
        cli::age_runs(&key, Duration::from_secs(16 * 60));
        setup.run().await;
        assert_eq!(runs(&cli), 2, "15 minutes after the first");
        cli::age_runs(&key, Duration::from_secs(16 * 60));
        setup.run().await;
        assert_eq!(runs(&cli), 2, "30 minutes after the second");
    }
}

#[tokio::test]
async fn a_failed_refresh_during_an_outdated_backoff_keeps_the_longer_wait() {
    let mut setup = expired();
    let outdated = Arc::new(FakeCli { exit: exits(Some(1), b"", "error: unknown option '--safe-mode'"), on_run: Box::new(|| {}), gate: open_gate(), runs: AtomicUsize::new(0) });
    with_cli(&mut setup, &outdated);
    assert_eq!(setup.run().await.cause, Some(Cause::UpdateClaude), "an hour's backoff");
    let failing = fake(exits(Some(1), b"", "fetch failed"), || {});
    with_cli(&mut setup, &failing);
    setup.refresh().await;
    assert_eq!(runs(&failing), 1, "a Refresh you press still runs it");
    // A failure would wait 15 minutes; the outdated hour stands, and says why.
    cli::age_runs(&setup.check.profile.key, Duration::from_secs(20 * 60));
    let later = setup.run().await;
    assert_eq!((runs(&failing), later.cause), (1, Some(Cause::UpdateClaude)));
}

#[tokio::test]
async fn once_the_extra_refresh_is_used_the_card_says_when_claude_code_may_be_asked_again() {
    let mut setup = expired();
    let cli = fake(exits(Some(1), b"", "fetch failed"), || {});
    with_cli(&mut setup, &cli);
    let first = setup.run().await;
    assert!(first.auto_retry_at.is_some() && first.retry_at.is_none(), "a Refresh may still run it");
    let manual = setup.refresh().await;
    assert_eq!(runs(&cli), 2);
    let again = setup.refresh().await;
    assert_eq!(runs(&cli), 2, "the extra run is used");
    for result in [manual, again] {
        assert!(matches!(result.cause, Some(Cause::CliFailed | Cause::Expired)), "{:?}", result.cause);
        // "Next try after": the 15-minute slot, not the (longer) failure backoff.
        assert!(result.retry_at.is_some_and(|at| minutes_until(Some(at)) <= 15 && Some(at) <= result.auto_retry_at), "{:?} {:?}", result.retry_at, result.auto_retry_at);
    }
}

/// A usage service whose first answer (a 401) waits until the test lets it go,
/// then answers normally.
struct Gated {
    calls: AtomicUsize,
    release: tokio::sync::Notify,
}

impl Remote for Gated {
    fn usage(&self, _token: String) -> crate::agent_usage_claude_remote::Pending<'_, Result<Value, UsageFailure>> {
        let first = self.calls.fetch_add(1, Ordering::SeqCst) == 0;
        Box::pin(async move {
            if first {
                self.release.notified().await;
                return Err(FetchError::Http(401).into());
            }
            Ok(limits(66.0))
        })
    }
}

#[tokio::test(start_paused = true)]
async fn a_check_that_read_the_old_login_before_a_run_saved_reads_again_after_it_ends() {
    let mut setup = expired();
    let (go, wait) = std::sync::mpsc::channel::<()>();
    let wait = Mutex::new(wait);
    let path = setup.path.clone();
    // Claude Code saves its fresh login only when the test says so.
    let saves = move || {
        wait.lock().unwrap().recv().unwrap();
        save_atomically(&path, &profile("fresh", now_ms() + 8 * HOUR, None));
    };
    let cli = Arc::new(FakeCli { exit: printed(), on_run: Box::new(saves), gate: open_gate(), runs: AtomicUsize::new(0) });
    with_cli(&mut setup, &cli);
    let gated = Arc::new(Gated { calls: AtomicUsize::new(0), release: tokio::sync::Notify::new() });
    setup.check.remote = gated.clone();
    // Check A starts the run and stops waiting for it.
    let a_check = Check { deadline: Duration::from_millis(1000), ..setup.check.clone() };
    let a = cut_off(&cli, a_check.deadline, usage_with_login(&[setup.store()], &a_check)).await;
    assert_eq!(a.cause, Some(Cause::StillRunning));
    // Check B reads the login before Claude Code saved (a valid-looking old copy)…
    std::fs::write(&setup.path, profile("old-copy", now_ms() + HOUR, None)).unwrap();
    let key = setup.check.profile.key.clone();
    let drive = async {
        // (Yields, not sleeps: the held run keeps paused time still.)
        while gated.calls.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
        // …the run then saves and ends…
        go.send(()).unwrap();
        while cli::running(&key) {
            tokio::task::yield_now().await;
        }
        // …and only then is B's copy rejected: "too soon" to run again, so it reads the store again.
        gated.release.notify_one();
    };
    let (b, ()) = tokio::join!(setup.run(), drive);
    assert_eq!((b.status.as_str(), b.windows.first().map(|w| w.used_percent), runs(&cli)), ("ready", Some(66.0), 1), "{:?}", b.message);
}

#[tokio::test(start_paused = true)]
async fn printed_usage_from_a_run_is_saved_under_the_account_signed_in_when_it_ends() {
    let mut setup = expired();
    let file = setup.dir.join(".claude.json");
    let switch = file.clone();
    // While it runs, Claude Code is signed in to another account.
    let switches = move || std::fs::write(&switch, r#"{"oauthAccount":{"emailAddress":"other@example.com"}}"#).unwrap();
    let (cli, gate) = held(printed(), switches);
    with_cli(&mut setup, &cli);
    setup.check.deadline = Duration::from_millis(1000);
    assert_eq!(cut_off(&cli, setup.check.deadline, setup.run()).await.cause, Some(Cause::StillRunning));
    gate.open();
    cli::wait_for_run(&setup.check.profile.key, Duration::from_secs(30)).await;
    let failed = || Usage::empty("claude", "error", "offline");
    let other = setup.check.profile.with_email(Some("other@example.com".into()));
    assert_eq!(limits::or_saved(&other, failed()).await.windows.len(), 3, "saved for the account signed in at the end");
    assert!(limits::or_saved(&setup.check.profile, failed()).await.windows.is_empty(), "not for the one at the start");
}
