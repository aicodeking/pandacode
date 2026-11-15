//! What a run of Claude Code comes to (`cli::classify`), how it is launched,
//! and checks through `fetch_claude` with a scripted CLI.

use super::super::super::cli::{classify, parse, run_env, Outcome};
use super::*;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

fn outcome(status: Option<i32>, stdout: &[u8], stderr: &str) -> Outcome {
    classify(Ok(Exited { status, stdout: stdout.to_vec(), stderr: stderr.as_bytes().to_vec() }))
}

fn kind(outcome: &Outcome) -> &'static str {
    match outcome {
        Outcome::Printed(_) => "printed",
        Outcome::Outdated => "outdated",
        Outcome::NoUsage => "no usage",
        Outcome::SignIn => "sign in",
        Outcome::Failed => "failed",
        Outcome::NotStarted => "not started",
    }
}

#[test]
fn the_printed_usage_lines_are_read_as_windows_whatever_else_it_says() {
    let usage = parse(&answer(PRINTED)).expect("read");
    let windows: Vec<(&str, f64, Option<&str>)> = usage.windows.iter().map(|w| (w.label.as_str(), w.used_percent, w.detail.as_deref())).collect();
    assert_eq!(windows, [
        ("5 hours", 12.0, Some("Resets 3pm (America/New_York)")),
        ("Weekly", 48.0, Some("Resets Nov 15 at 8pm (America/New_York)")),
        ("Weekly · Sonnet", 7.0, None),
    ]);
    assert_eq!((usage.status.as_str(), usage.source.as_deref()), ("ready", Some("Claude Code CLI")));
    // Usage lines count even beside an error flag or an "isn't available" note.
    let flagged = serde_json::to_vec(&json!({"is_error": true, "result": format!("{PRINTED}\nSome section isn't available")})).unwrap();
    assert_eq!(kind(&outcome(Some(1), &flagged, "")), "printed");
    assert!(parse(&answer("You are currently using your subscription")).is_none(), "no usage lines");
}

fn result_with(fields: Value) -> Vec<u8> {
    serde_json::to_vec(&fields).unwrap()
}

#[test]
fn a_run_is_classified_only_by_its_result_text_and_stderr() {
    let header = "You are currently using your subscription to power your Claude Code usage";
    let cases: [(Option<i32>, Vec<u8>, &str, &str); 18] = [
        (Some(1), Vec::new(), "error: unknown option '--safe-mode'", "outdated"),
        (Some(1), Vec::new(), "error: unknown option '--no-session-persistence'", "outdated"),
        (Some(1), Vec::new(), "error: unknown option '--max-turns'", "outdated"),
        (Some(0), answer("/usage isn't available in this environment."), "", "outdated"),
        (Some(1), Vec::new(), "error: unknown option '--verbose-thing'", "failed"),
        (Some(0), answer("Web search isn't available here"), "", "failed"),
        (Some(0), answer("Total cost: $0.00\nTotal duration (API): 0s"), "", "no usage"),
        (Some(0), answer(header), "", "failed"),
        (Some(0), answer(&format!("{header}\nYour overages: off")), "", "failed"),
        (Some(1), Vec::new(), "OAuth error: invalid_grant", "sign in"),
        (Some(1), result_with(json!({"is_error": true, "result": "Not logged in · Please run /login"})), "", "sign in"),
        (Some(1), Vec::new(), "API Error: 401 {\"type\":\"authentication_error\"}", "sign in"),
        (Some(1), result_with(json!({"is_error": true, "result": "OAuth token has expired"})), "", "sign in"),
        // Ids and timings are never read: a session id holding "401" means nothing.
        (Some(1), result_with(json!({"is_error": true, "session_id": "4012-login-401 ", "duration_ms": 401, "result": "fetch failed"})), "", "failed"),
        (Some(0), b"not json".to_vec(), "", "failed"),
        // "/login" alone is a hint, not a refused login; with an auth phrase it is one.
        (Some(1), result_with(json!({"is_error": true, "result": "Something went wrong. Please run /login if this continues."})), "", "failed"),
        (Some(1), Vec::new(), "Unauthorized. Please run /login", "sign in"),
        (Some(1), Vec::new(), "OAuth token expired", "sign in"),
    ];
    for (status, stdout, stderr, expected) in cases {
        assert_eq!(kind(&outcome(status, &stdout, stderr)), expected, "{stderr} {}", String::from_utf8_lossy(&stdout));
    }
    assert_eq!(kind(&classify(Err(RunFailure::TimedOut))), "failed");
    assert_eq!(kind(&classify(Err(RunFailure::NotStarted))), "not started");
}

#[test]
fn only_a_failed_spawn_is_not_started_once_claude_code_ran_a_lost_run_is_a_failure() {
    let (limit, early) = (Duration::from_secs(45), Duration::from_secs(1));
    assert_eq!(cli::failure("Could not start Claude Code: No such file or directory", early, limit), RunFailure::NotStarted);
    assert_eq!(cli::failure("Claude Code operation timed out. Check the repository before retrying.", limit, limit), RunFailure::TimedOut);
    for after_start in ["Claude Code output stream did not close", "Missing Claude Code stdout", "Interrupted system call (os error 4)"] {
        assert_eq!(cli::failure(after_start, early, limit), RunFailure::Lost, "{after_start}");
        assert_eq!(kind(&classify(Err(cli::failure(after_start, early, limit)))), "failed", "slot kept, store read again");
    }
}

#[test]
fn printed_percentages_are_clamped_like_the_endpoints() {
    let usage = parse(&answer("Current session: 120% used\nCurrent week (all models): 0% used")).unwrap();
    let percents: Vec<f64> = usage.windows.iter().map(|w| w.used_percent).collect();
    assert_eq!(percents, [100.0, 0.0]);
    let endpoint = claude_usage(&json!({"five_hour": {"utilization": 120}, "seven_day": {"utilization": -3}}), None);
    assert_eq!(endpoint.windows.iter().map(|w| w.used_percent).collect::<Vec<_>>(), [100.0, 0.0]);
}

#[test]
fn the_current_session_is_the_five_hour_window_and_a_named_plan_is_read() {
    let usage = parse(&answer(PRINTED)).unwrap();
    assert_eq!((usage.windows[0].label.as_str(), usage.windows[0].used_percent, usage.plan.as_deref()), ("5 hours", 12.0, None));
    for (line, plan) in [("Plan: Claude Max", "Max"), ("Plan: Pro", "Pro"), ("You are currently using your Claude Team subscription", "Team")] {
        let usage = parse(&answer(&format!("{line}\nCurrent session: 3% used"))).unwrap();
        assert_eq!(usage.plan.as_deref(), Some(plan), "{line}");
    }
    // Only a Plan line or the subscription header names it.
    for line in ["Upgrade to Claude Max for more usage", "Claude Pro and Claude Max plans share these limits"] {
        assert_eq!(parse(&answer(&format!("{line}\nCurrent session: 3% used"))).unwrap().plan, None, "{line}");
    }
}

fn launch_env() -> ClaudeEnv {
    let saved = [
        ("CLAUDE_CONFIG_DIR", "/Users/me/.claude-work"),
        ("CLAUDE_SECURESTORAGE_CONFIG_DIR", "/Users/me/.claude-work"),
        ("HTTPS_PROXY", "http://proxy.example:8080"),
        ("NODE_EXTRA_CA_CERTS", "/etc/corp-ca.pem"),
        ("SSL_CERT_FILE", "/etc/ssl/cert.pem"),
        ("DISABLE_TELEMETRY", "0"),
        ("DISABLE_ERROR_REPORTING", "0"),
        ("DO_NOT_TRACK", "1"),
        ("CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY", "1"),
        ("DISABLE_AUTOUPDATER", "0"),
        ("CLAUDE_CODE_GIT_BASH_PATH", "C:\\\\Git\\\\bin\\\\bash.exe"),
        ("ProgramFiles(x86)", "C:\\\\Program Files (x86)"),
        ("HOMEPATH", "\\\\Users\\\\me"),
        ("USERNAME", "me"),
        ("ANTHROPIC_API_KEY", "synthetic-key"),
        ("ANTHROPIC_AUTH_TOKEN", "synthetic-auth"),
        ("ANTHROPIC_BASE_URL", "https://relay.example"),
        ("CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat01-synthetic"),
    ];
    let saved: Vec<(String, String)> = saved.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect();
    claude_env(Mode::Inherit, &saved, &[])
}

#[test]
fn claude_code_runs_with_its_login_folders_network_settings_and_opt_outs_but_no_keys_endpoints_or_tokens() {
    let env = run_env(&launch_env());
    let names: Vec<&str> = env.iter().map(|(name, _)| name.as_str()).collect();
    assert_eq!(names, [
        "CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR", "HTTPS_PROXY", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE",
        "DO_NOT_TRACK", "CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY", "CLAUDE_CODE_GIT_BASH_PATH", "ProgramFiles(x86)", "HOMEPATH",
        "USERNAME", "TERM", "DISABLE_AUTOUPDATER",
        "DISABLE_TELEMETRY", "DISABLE_ERROR_REPORTING", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
    ]);
    // An unattended run: no update, telemetry, error reports or nonessential traffic, whatever the user set.
    for quiet in ["DISABLE_AUTOUPDATER", "DISABLE_TELEMETRY", "DISABLE_ERROR_REPORTING", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"] {
        assert_eq!(env.iter().filter(|(name, _)| name == quiet).map(|(_, value)| value.as_str()).collect::<Vec<_>>(), ["1"], "{quiet}");
    }
    assert!(!env.iter().any(|(_, value)| value.contains("synthetic") || value.contains("relay")));
}

#[test]
fn the_command_runs_usage_in_safe_mode_in_pandacodes_folder_with_only_that_environment() {
    let app = temp_dir();
    // Nothing is looked up or created until a run.
    let _runner = cli::ProcessCli::new(Some(app.clone()));
    assert!(!app.join("claude-usage-cli").exists());
    let folder = cli::working_folder_in(Some(&app)).expect("a working folder");
    assert_eq!(folder, app.join("claude-usage-cli"), "directly in the app data folder, beside secrets.json");
    #[cfg(unix)]
    assert_eq!(std::fs::metadata(&folder).unwrap().permissions().mode() & 0o777, 0o700, "owner only");
    assert_eq!(cli::working_folder_in(None), None, "no app data: Claude Code is not run (no shared temporary folder)");
    let command = cli::command(Path::new("/usr/bin/env"), &run_env(&launch_env()), &folder).unwrap();
    let args: Vec<String> = command.get_args().map(|arg| arg.to_string_lossy().into_owned()).collect();
    let wanted = ["-p", "/usage", "--output-format", "json", "--safe-mode", "--no-session-persistence", "--tools", "", "--max-turns", "1"];
    assert!(args.ends_with(&wanted.map(String::from)), "no tools, one turn at most: {args:?}");
    assert_eq!(command.get_current_dir(), Some(folder.as_path()));
    let envs: Vec<(String, String)> = command
        .get_envs()
        .filter_map(|(key, value)| Some((key.to_string_lossy().into_owned(), value?.to_string_lossy().into_owned())))
        .collect();
    for wanted in [("CLAUDE_CONFIG_DIR", "/Users/me/.claude-work"), ("DISABLE_AUTOUPDATER", "1"), ("DO_NOT_TRACK", "1"), ("CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY", "1")] {
        assert!(envs.contains(&(wanted.0.into(), wanted.1.into())), "{wanted:?}");
    }
    assert!(!envs.iter().any(|(key, _)| key.starts_with("ANTHROPIC_") || key == "CLAUDE_CODE_OAUTH_TOKEN"), "{envs:?}");
    let _ = std::fs::remove_dir_all(app);
}

#[test]
fn a_login_whose_access_token_is_rejected_is_unrecognized() {
    // Its refresh token is wiped on this path too (not observable from here).
    let raw = serde_json::to_vec(&json!({"claudeAiOauth": {"accessToken": "bad token", "refreshToken": "kept-nowhere"}})).unwrap();
    assert!(matches!(parse_login(raw, file()), super::super::super::Parsed::Unrecognized));
}

/// A config folder with its own scripted CLI for checks through `fetch_claude`.
pub(super) fn folder_with(cli: &Arc<FakeCli>, keychain: bool) -> (PathBuf, ClaudeEnv) {
    let dir = temp_dir();
    let config = dir.to_string_lossy().into_owned();
    setup::test_cli(&config, Cli::Ready(cli.clone(), Vec::new()));
    let env = ClaudeEnv { keychain, ..claude_env(Mode::Subscription, &[("CLAUDE_CONFIG_DIR".into(), config)], &[]) };
    (dir, env)
}

#[tokio::test]
async fn fetch_claude_runs_claude_code_for_an_expired_login_and_reads_what_it_saved() {
    let dir = temp_dir();
    let path = dir.join(".credentials.json");
    std::fs::write(&path, profile("old", 1000, Some("old-refresh"))).unwrap();
    let cli = fake(printed(), saves_fresh_login(&path));
    setup::test_cli(&dir.to_string_lossy(), Cli::Ready(cli.clone(), Vec::new()));
    let env = claude_env(Mode::Subscription, &[("CLAUDE_CONFIG_DIR".into(), dir.to_string_lossy().into_owned())], &[]);
    let mock = Arc::new(Mock::default());
    let result = setup::fetch_claude_with(&env, false, mock.clone()).await;
    assert_eq!((result.status.as_str(), runs(&cli)), ("ready", 1), "{:?}", result.message);
    assert_eq!(*mock.used.lock().unwrap(), ["fresh"]);
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn a_connection_that_is_not_the_subscription_never_runs_claude_code() {
    let cli = fake(printed(), || {});
    let (dir, _) = folder_with(&cli, false);
    let config = dir.to_string_lossy().into_owned();
    let env = claude_env(Mode::Inherit, &[("CLAUDE_CONFIG_DIR".into(), config), ("ANTHROPIC_API_KEY".into(), "synthetic".into())], &[]);
    let result = setup::fetch_claude_with(&env, false, Arc::new(Mock::default())).await;
    assert_eq!((result.action, runs(&cli)), (Some("apiConnection"), 0));
    let _ = std::fs::remove_dir_all(dir);
}

#[cfg(target_os = "macos")]
#[tokio::test]
async fn a_keychain_read_the_user_denied_runs_claude_code_only_on_a_manual_refresh() {
    use crate::usage_keychain::fake_backend::{install, Answer};
    let cli = fake(printed(), || {});
    let (dir, env) = folder_with(&cli, true);
    install(&claude_service(env.get("CLAUDE_CONFIG_DIR").as_deref(), None), Answer::Denied);
    let automatic = setup::fetch_claude_with(&env, false, Arc::new(Mock::default())).await;
    assert_eq!((automatic.cause, runs(&cli)), (Some(Cause::KeychainLatched), 0), "never on its own");
    assert!(KEYCHAIN_LATCHED.1.contains("also lets Claude Code read its own login"));
    let manual = setup::fetch_claude_with(&env, true, Arc::new(Mock::default())).await;
    assert_eq!((manual.source.as_deref(), runs(&cli)), (Some("Claude Code CLI"), 1), "{:?}", manual.message);
    let _ = std::fs::remove_dir_all(dir);
}

#[cfg(target_os = "macos")]
#[tokio::test]
async fn a_keychain_dialog_nobody_answered_runs_claude_code_only_on_a_manual_refresh() {
    use crate::usage_keychain::fake_backend::{install, Answer};
    let cli = fake(printed(), || {});
    let (dir, env) = folder_with(&cli, true);
    install(&claude_service(env.get("CLAUDE_CONFIG_DIR").as_deref(), None), Answer::Unanswered);
    // The dialog times out; the next automatic check finds the read backing
    // off. Neither runs Claude Code, which could show that dialog again.
    for check in ["timed out", "backing off"] {
        let automatic = setup::fetch_claude_with(&env, false, Arc::new(Mock::default())).await;
        assert_eq!((automatic.cause, runs(&cli)), (Some(Cause::KeychainLatched), 0), "{check}: {:?}", automatic.message);
    }
    let manual = setup::fetch_claude_with(&env, true, Arc::new(Mock::default())).await;
    assert_eq!((manual.source.as_deref(), runs(&cli)), (Some("Claude Code CLI"), 1), "{:?}", manual.message);
    let _ = std::fs::remove_dir_all(dir);
}

#[cfg(target_os = "macos")]
#[tokio::test]
async fn a_locked_keychain_never_starts_a_run() {
    use crate::usage_keychain::fake_backend::{install, Answer};
    let cli = fake(printed(), || {});
    let (dir, env) = folder_with(&cli, true);
    install(&claude_service(env.get("CLAUDE_CONFIG_DIR").as_deref(), None), Answer::Locked);
    for refresh in [false, true] {
        let result = setup::fetch_claude_with(&env, refresh, Arc::new(Mock::default())).await;
        assert_eq!((result.action, runs(&cli)), (Some("unlock"), 0));
    }
    let _ = std::fs::remove_dir_all(dir);
}

#[cfg(target_os = "macos")]
#[tokio::test]
async fn inside_the_fifteen_minutes_an_expired_keychain_login_is_not_read_again() {
    use crate::usage_keychain::fake_backend::{install, waits, Answer};
    let cli = fake(exits(Some(1), b"", "fetch failed"), || {});
    let (dir, env) = folder_with(&cli, true);
    let service = claude_service(env.get("CLAUDE_CONFIG_DIR").as_deref(), None);
    install(&service, Answer::Found(profile("old", 1000, Some("old-refresh"))));
    let mock = Arc::new(Mock::default());
    setup::fetch_claude_with(&env, false, mock.clone()).await;
    assert_eq!((waits(&service).len(), runs(&cli)), (2, 1), "read, run, read again");
    // The run allowance is spent: the remembered login is kept, so no `security` reads.
    for _ in 0..2 {
        assert_eq!(setup::fetch_claude_with(&env, false, mock.clone()).await.message.as_deref(), Some(EXPIRED.1));
    }
    assert_eq!((waits(&service).len(), runs(&cli)), (2, 1));
    let _ = std::fs::remove_dir_all(dir);
}

/// Opt-in: runs the real Claude Code once against `PANDACODE_LIVE_CLI_CONFIG_DIR`
/// (`claude -p /usage`, no model call) and classifies what it prints.
#[tokio::test]
#[ignore = "Opt-in live run of the user's Claude Code CLI (no model call)"]
async fn live_claude_code_usage_command_is_read() {
    let Ok(dir) = std::env::var("PANDACODE_LIVE_CLI_CONFIG_DIR") else { return };
    let app = temp_dir();
    let cli = cli::ProcessCli::new(Some(app.clone()));
    let launch = ClaudeEnv::launch(&[("CLAUDE_CONFIG_DIR".to_owned(), dir)]);
    let started = Instant::now();
    let exited = tokio::task::spawn_blocking(move || cli.run(&run_env(&launch), cli::RUN_LIMIT, &|| false)).await.unwrap().expect("ran");
    let value: Value = serde_json::from_slice(&exited.stdout).unwrap();
    eprintln!("cli ran in {:?}: exit {:?} num_turns={} total_cost_usd={}", started.elapsed(), exited.status, value["num_turns"], value["total_cost_usd"]);
    assert_eq!((value["num_turns"].as_u64(), value["total_cost_usd"].as_f64()), (Some(0), Some(0.0)));
    let _ = std::fs::remove_dir_all(&app);
    // Printed usage, or (as when Claude Code just refreshed an expired login)
    // only the outcome's kind: never the output itself.
    match classify(Ok(exited)) {
        Outcome::Printed(usage) => {
            for window in &usage.windows {
                eprintln!("  window {} {}% {}", window.label, window.used_percent, window.detail.as_deref().unwrap_or(""));
            }
        }
        other => eprintln!("  no usage lines: {}", kind(&other)),
    }
}

#[path = "agent_usage_claude_cli_keychain_tests.rs"]
mod keychain;

/// A shell stub for `run_process_graceful`: `script` runs as `sh -c`.
#[cfg(unix)]
fn stub(script: &str) -> std::process::Command {
    let mut command = std::process::Command::new("/bin/sh");
    command.args(["-c", script]);
    command
}

#[cfg(unix)]
#[test]
fn a_run_past_its_limit_is_asked_to_stop_then_given_time_before_it_is_killed() {
    let dir = temp_dir();
    let marker = dir.join("got-term");
    // Traps TERM: it saves what it was doing and exits cleanly within the
    // grace, so its own output comes back, not a timeout.
    let polite = stub(&format!("trap 'echo saved > \"{}\"; echo done; exit 0' TERM; sleep 30 & wait", marker.display()));
    let started = Instant::now();
    // A grace far longer than any load delay: leaving early is unmistakable.
    let result = crate::workspace::run_process_graceful(polite, "stub", 1024, Duration::from_millis(300), Duration::from_secs(60)).expect("a clean exit");
    assert_eq!((result.status.success(), String::from_utf8_lossy(&result.stdout.bytes).trim()), (true, "done"));
    assert_eq!(std::fs::read_to_string(&marker).unwrap().trim(), "saved", "it got SIGTERM first");
    assert!(started.elapsed() < Duration::from_secs(30), "and was not held for the whole grace");
    // Exiting with an error when asked is still a timeout.
    let failing = stub("trap 'exit 3' TERM; sleep 30 & wait");
    assert!(crate::workspace::run_process_graceful(failing, "stub", 1024, Duration::from_millis(300), Duration::from_secs(5)).is_err());
    // Ignores TERM: killed once the grace is over.
    let stubborn = stub("trap '' TERM; sleep 30 & wait; sleep 30");
    let started = Instant::now();
    assert!(crate::workspace::run_process_graceful(stubborn, "stub", 1024, Duration::from_millis(300), Duration::from_millis(700)).is_err());
    let took = started.elapsed();
    // Never before limit + grace; well before the 30 s sleeps would end.
    assert!(took >= Duration::from_millis(900) && took < Duration::from_secs(25), "{took:?}");
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test(start_paused = true)]
async fn asking_claude_code_is_per_setup_and_reads_no_files_or_secrets_per_poll() {
    let dir_a = temp_dir();
    let config_a = dir_a.to_string_lossy().into_owned();
    std::fs::write(dir_a.join(".credentials.json"), profile("old", 1000, Some("old-refresh"))).unwrap();
    std::fs::write(dir_a.join(".claude.json"), r#"{"oauthAccount":{"emailAddress":"a@example.com"}}"#).unwrap();
    let (slow, gate) = held(printed(), || {});
    setup::test_cli(&config_a, Cli::Ready(slow.clone(), Vec::new()));
    let env_a = claude_env(Mode::Subscription, &[("CLAUDE_CONFIG_DIR".into(), config_a)], &[]);
    let dir_b = temp_dir();
    let env_b = claude_env(Mode::Subscription, &[("CLAUDE_CONFIG_DIR".into(), dir_b.to_string_lossy().into_owned())], &[]);
    // Each card's check notes its profile, as `agent_usage` does.
    let (id_a, id_b) = (format!("conn-{}", uuid::Uuid::new_v4()), format!("conn-{}", uuid::Uuid::new_v4()));
    for (id, env) in [(&id_a, &env_a), (&id_b, &env_b)] {
        let (key, account) = setup::owner_now(env).await.unwrap();
        note_check(id, crate::agent_usage_claude_limits::Profile { key, account, dir: None });
    }
    let deadline = Duration::from_millis(1000);
    let cut_off = cut_off(&slow, deadline, setup::fetch_claude_within(&env_a, false, Arc::new(Mock::default()), deadline)).await;
    assert_eq!(cut_off.cause, Some(Cause::StillRunning));
    let reads = setup::account_reads().get(&dir_a.join(".claude.json")).copied();
    assert!(crate::agent_usage::asking_claude(Some(&id_a)), "setup A's run is under way");
    assert!(!crate::agent_usage::asking_claude(Some(&id_b)), "not setup B's");
    assert!(!crate::agent_usage::asking_claude(Some("never-checked")));
    assert_eq!(setup::account_reads().get(&dir_a.join(".claude.json")).copied(), reads, "the poll reads no account file");
    gate.open();
    assert!(eventually(|| runs(&slow) == 1 && !asking_for(&id_a)).await);
    let _ = (std::fs::remove_dir_all(dir_a), std::fs::remove_dir_all(dir_b));
}

#[cfg(unix)]
#[test]
fn a_run_told_to_stop_midway_is_asked_to_stop_like_at_its_limit() {
    // A Keychain that locks mid-run: `stop` turns true; within its 2 s poll the
    // run gets SIGTERM, saves and exits cleanly, long before its 60 s limit.
    let started = Instant::now();
    let stop = || started.elapsed() > Duration::from_millis(300);
    let polite = stub("trap 'echo done; exit 0' TERM; sleep 60 & wait");
    let graceful = crate::workspace::Graceful { grace: Duration::from_secs(30), stop: &stop };
    let result = crate::workspace::run_process_graceful_until(polite, "stub", 1024, Duration::from_secs(60), graceful).expect("a clean exit");
    assert_eq!(String::from_utf8_lossy(&result.stdout.bytes).trim(), "done");
    assert!(started.elapsed() < Duration::from_secs(25), "{:?}", started.elapsed());
}

#[cfg(unix)]
#[test]
fn the_whole_group_is_killed_after_the_grace_even_when_its_leader_already_left() {
    let dir = temp_dir();
    let pid_file = dir.join("straggler");
    // The leader leaves on TERM; a child that ignores TERM stays behind.
    let script = format!("(trap '' TERM; sh -c 'echo $PPID' > \"{}\"; sleep 30) & trap 'exit 0' TERM; wait", pid_file.display());
    let _ = crate::workspace::run_process_graceful(stub(&script), "stub", 1024, Duration::from_millis(400), Duration::from_secs(2));
    let straggler: i32 = std::fs::read_to_string(&pid_file).unwrap().trim().parse().unwrap();
    let gone = (0..50).any(|_| {
        std::thread::sleep(Duration::from_millis(20));
        (unsafe { libc::kill(straggler, 0) }) != 0
    });
    assert!(gone, "the group was killed, the straggler too");
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn a_check_reads_claude_json_once_when_its_owner_is_known() {
    let dir = temp_dir();
    std::fs::write(dir.join(".claude.json"), r#"{"oauthAccount":{"emailAddress":"me@example.com"}}"#).unwrap();
    std::fs::write(dir.join(".credentials.json"), profile("valid", now_ms() + HOUR, None)).unwrap();
    let env = claude_env(Mode::Subscription, &[("CLAUDE_CONFIG_DIR".into(), dir.to_string_lossy().into_owned())], &[]);
    let owner = setup::owner_now(&env).await;
    assert!(owner.as_ref().is_some_and(|(_, account)| account.is_none()), "no app data in tests: no keyed account");
    let result = setup::fetch_claude_owned(&env, false, Arc::new(Mock::default()), owner).await;
    assert_eq!(result.status, "ready");
    assert_eq!(setup::account_reads().get(&dir.join(".claude.json")).copied(), Some(1), "owner_now's read, not a second");
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn admin_managed_settings_count_and_claude_code_is_never_run_for_them() {
    let dir = temp_dir();
    std::fs::write(dir.join(".credentials.json"), profile("old", 1000, Some("old-refresh"))).unwrap();
    let managed = dir.join("managed-settings.json");
    std::fs::write(&managed, r#"{"apiKeyHelper": "/opt/corp/get-key.sh"}"#).unwrap();
    setup::test_managed().insert(dir.clone(), managed.clone());
    let cli = fake(printed(), || {});
    setup::test_cli(&dir.to_string_lossy(), Cli::Ready(cli.clone(), Vec::new()));
    let env = claude_env(Mode::Subscription, &[("CLAUDE_CONFIG_DIR".into(), dir.to_string_lossy().into_owned())], &[]);
    let result = setup::fetch_claude_with(&env, false, Arc::new(Mock::default())).await;
    assert_eq!((result.action, runs(&cli)), (Some("apiConnection"), 0), "{:?}", result.message);
    assert!(result.message.as_deref().is_some_and(|text| text.contains("administrator") && text.contains("apiKeyHelper") && !text.contains("get-key")));
    // A managed env key counts too; managed settings that set nothing don't.
    std::fs::write(&managed, r#"{"env": {"ANTHROPIC_API_KEY": "synthetic"}}"#).unwrap();
    assert_eq!(setup::fetch_claude_with(&env, false, Arc::new(Mock::default())).await.action, Some("apiConnection"));
    std::fs::write(&managed, r#"{"permissions": {}}"#).unwrap();
    assert_ne!(setup::fetch_claude_with(&env, false, Arc::new(Mock::default())).await.action, Some("apiConnection"));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn the_saved_reading_key_names_each_store_by_kind_and_place() {
    let stores = [Store::Keychain("Claude Code-credentials-1a2b3c4d".into()), Store::File("/Users/me/.claude/.credentials.json".into())];
    assert_eq!(setup::identity(&stores), "keychain:Claude Code-credentials-1a2b3c4d\nfile:/Users/me/.claude/.credentials.json");
}

#[tokio::test]
async fn a_claude_check_waiting_on_claude_code_frees_its_shared_slot() {
    let check = crate::agent_usage::with_slot(async {
        let before = crate::agent_usage::holds_slot();
        let during = crate::agent_usage::without_slot(async { crate::agent_usage::holds_slot() }).await;
        (before, during, crate::agent_usage::holds_slot())
    });
    assert_eq!(check.await, (true, false, true), "given up while it waits, taken back afterwards");
}

#[tokio::test]
async fn still_refreshing_is_never_cached_so_reopening_asks_again() {
    let slot = crate::agent_usage::tests_slot();
    let fetches = AtomicUsize::new(0);
    let fetch = |message: Message| {
        let fetches = &fetches;
        move || async move {
            fetches.fetch_add(1, Ordering::SeqCst);
            *usage(message)
        }
    };
    crate::agent_usage::cached(&slot, false, || async { Some(0) }, fetch(STILL_RUNNING)).await;
    crate::agent_usage::cached(&slot, false, || async { Some(0) }, fetch(EXPIRED)).await;
    assert_eq!(fetches.load(Ordering::SeqCst), 2, "reopened: asked again");
    crate::agent_usage::cached(&slot, false, || async { Some(0) }, fetch(EXPIRED)).await;
    assert_eq!(fetches.load(Ordering::SeqCst), 2, "an ordinary answer is kept for a minute");
}

// Paused clock (`cut_off`): the run is held while the check answers.
#[tokio::test(start_paused = true)]
async fn still_refreshing_with_a_saved_reading_is_never_cached_either() {
    let mut setup = Setup::new(&profile("valid", now_ms() + HOUR, None), Mock { usage: script([Ok(limits(21.0))]), ..Mock::default() });
    assert_eq!(setup.run().await.status, "ready", "a reading is saved");
    std::fs::write(&setup.path, profile("old", 1000, Some("old-refresh"))).unwrap();
    let (cli, gate) = held(printed(), || {});
    with_cli(&mut setup, &cli);
    setup.check.deadline = Duration::from_millis(1000);
    let slot = crate::agent_usage::tests_slot();
    let fetches = AtomicUsize::new(0);
    let check = || async {
        fetches.fetch_add(1, Ordering::SeqCst);
        cut_off(&cli, setup.check.deadline, setup.run()).await
    };
    let first = crate::agent_usage::cached(&slot, false, || async { Some(0) }, check).await;
    assert_eq!((first.stale, first.windows[0].used_percent, first.cause), (true, 21.0, Some(Cause::StillRunning)), "{:?}", first.message);
    // Meanwhile the card's poll gets "asking" and the saved reading, from the noted profile only.
    let card = format!("conn-{}", uuid::Uuid::new_v4());
    note_check(&card, setup.check.profile.clone());
    let waiting = crate::agent_usage::claude_waiting(vec![card.clone(), "never-checked".into()]).await;
    let saved = waiting[&card].saved.as_ref().map(|saved| (saved.stale, saved.windows[0].used_percent));
    assert_eq!((waiting[&card].asking, saved), (true, Some((true, 21.0))));
    assert!(!waiting["never-checked"].asking && waiting["never-checked"].saved.is_none());
    // Reopened while the run goes on: asked again, not served from the cache.
    let again = crate::agent_usage::cached(&slot, false, || async { Some(0) }, || async {
        fetches.fetch_add(1, Ordering::SeqCst);
        Usage::empty("claude", "error", "asked again")
    })
    .await;
    assert_eq!((fetches.load(Ordering::SeqCst), again.message.as_deref()), (2, Some("asked again")));
    gate.open();
    cli::wait_for_run(&setup.check.profile.key, Duration::from_secs(30)).await;
}
