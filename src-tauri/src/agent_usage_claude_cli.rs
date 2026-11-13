//! Asking Claude Code itself to refresh an expired login. PandaCode never
//! writes Claude Code's credentials or calls its token endpoint; instead it
//! runs the user's own Claude Code CLI once, `claude -p /usage --output-format
//! json --safe-mode --no-session-persistence --tools "" --max-turns 1`
//! (no tools, one turn at most): a local command (no model call,
//! no tokens spent) that lets Claude Code refresh and save its own login if
//! it needs to, as when the user opens it; it may answer from its own
//! snapshot instead. The store is then read again.
//! Its printed usage lines are a fallback reading. Settings → Providers →
//! Claude Code → "Let PandaCode ask Claude Code for usage when it can’t read it"
//! (on by default).

use super::*;

/// A run's own time limit. Once started it is never cut short by a check's
/// deadline: the check answers meanwhile and the next one reads what Claude
/// Code saved.
pub(super) const RUN_LIMIT: Duration = Duration::from_secs(45);
/// Room kept after a run for reading the store again (test scale in tests).
#[cfg(not(test))]
pub(super) const MARGIN: Duration = Duration::from_secs(3);
#[cfg(test)]
pub(super) const MARGIN: Duration = Duration::from_millis(400);
/// A run is not started with less of the check left than this.
#[cfg(not(test))]
const RUN_MIN: Duration = Duration::from_secs(20);
#[cfg(test)]
const RUN_MIN: Duration = Duration::from_millis(50);
/// The source of a reading Claude Code printed (not from the endpoint).
pub(super) const SOURCE: &str = "Claude Code CLI";
/// At most one run per profile in this window (a manual Refresh may run once more).
pub(super) const RUN_EVERY: Duration = Duration::from_secs(15 * 60);
/// After signs of a Claude Code too old for this (an unknown option, "/usage
/// isn't available"), runs wait this long, doubling up to `OUTDATED_MAX`.
/// Failed runs in a row (offline, say) wait `RUN_EVERY`, doubling up to
/// `FAILED_MAX`. A good run or a manual Refresh ends either.
const OUTDATED_WAIT: Duration = Duration::from_secs(60 * 60);
const OUTDATED_MAX: Duration = Duration::from_secs(24 * 60 * 60);
const FAILED_MAX: Duration = Duration::from_secs(2 * 60 * 60);
const OUTPUT_LIMIT: usize = 256 * 1024;
/// Claude Code's own words, lowercase, read only in its `result` text and
/// stderr (never ids or timings): a Claude Code too old for this run…
const UNKNOWN: [&str; 2] = ["unknown option", "error: unknown"];
const NEW_OPTIONS: [&str; 4] = ["--safe-mode", "--no-session-persistence", "--tools", "--max-turns"];
const UNAVAILABLE: &str = "/usage isn't available";
/// …a login it refused (an auth phrase: "/login" alone, a hint Claude Code
/// prints in many messages, is not one)…
const SIGN_IN: [&str; 6] = ["not logged in", "token expired", "token has expired", "unauthorized", "invalid_grant", "401 "];
/// …and a subscription login whose own usage request failed: the header
/// alone ("You are currently using your subscription…", maybe an overages
/// line), no usage lines. Only a cost summary without it is not a subscription.
const SUBSCRIPTION: &str = "using your subscription";
const COST_SUMMARY: &str = "total cost";
/// After `RUN_LIMIT` a run is asked to stop (SIGTERM to its process group)
/// and given this long before it is killed.
const GRACE: Duration = Duration::from_secs(10);
/// `--tools` takes several values, so it comes after the `/usage` prompt;
/// `""` turns every tool off. `--max-turns` is accepted though not in `--help`.
const ARGS: [&str; 10] = ["-p", "/usage", "--output-format", "json", "--safe-mode", "--no-session-persistence", "--tools", "", "--max-turns", "1"];

/// Why a run produced nothing at all.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum RunFailure {
    /// Stopped at its time limit.
    TimedOut,
    /// Never started (no folder, no Claude Code, or the spawn failed).
    NotStarted,
    /// Started, then lost (its status or output could not be collected).
    Lost,
}

/// What a `workspace::run_process` error means for a run: only a failed
/// spawn ("Could not start …") is `NotStarted`; once Claude Code ran, a
/// timeout is `TimedOut` and anything else `Lost`.
pub(super) fn failure(message: &str, elapsed: Duration, timeout: Duration) -> RunFailure {
    match () {
        _ if message.starts_with("Could not start") => RunFailure::NotStarted,
        _ if elapsed >= timeout => RunFailure::TimedOut,
        _ => RunFailure::Lost,
    }
}

/// A run that exited: its exit status, stdout and (bounded) stderr, both
/// overwritten with zeros when dropped (best effort: copies the OS or the
/// allocator made may remain). Stderr is only scanned for the signs above, never kept
/// or logged.
pub(super) struct Exited {
    pub status: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

impl Drop for Exited {
    fn drop(&mut self) {
        self.stdout.fill(0);
        self.stderr.fill(0);
    }
}

/// Runs the CLI with exactly `env` (nothing else inherited), stopping it
/// gracefully once `stop` says so (asked every 2 s: a Keychain that locked).
pub(super) trait RunCli: Send + Sync {
    fn run(&self, env: &[(String, String)], timeout: Duration, stop: &dyn Fn() -> bool) -> Result<Exited, RunFailure>;
}

/// Whether a run may start and go on: the Keychain holding Claude's login is
/// still unlocked (a run on a locked one could make macOS ask for it).
pub(super) type Guard = Arc<dyn Fn() -> bool + Send + Sync>;

/// The user's Claude Code, as PandaCode launches it (`providers::executable`),
/// run in its folder of PandaCode's app data (or `app`'s, for the live test).
/// Nothing is looked up or created until a run.
pub(super) struct ProcessCli {
    app: Option<PathBuf>,
}

impl ProcessCli {
    pub(super) fn new(app: Option<PathBuf>) -> Self {
        Self { app }
    }
}

/// The run's command: Claude Code at `path` with `ARGS`, in `folder`, with
/// only what the launcher set itself (a shim's runtime, PandaCode's privacy
/// switches) and `env`. Nothing is inherited, so no API key, endpoint or
/// token reaches it.
pub(super) fn command(path: &Path, env: &[(String, String)], folder: &Path) -> Result<std::process::Command, String> {
    let mut command = crate::providers::std_command(path)?;
    let own: Vec<(std::ffi::OsString, std::ffi::OsString)> =
        command.get_envs().filter_map(|(key, value)| Some((key.to_owned(), value?.to_owned()))).collect();
    command.env_clear().envs(own).envs(env.iter().map(|(key, value)| (key, value)));
    command.args(ARGS).current_dir(folder);
    Ok(command)
}

/// The run's folder, `claude-usage-cli` directly in the app data folder
/// `app` (beside `secrets.json`, not in any secrets folder), owner only;
/// none without app data (never a shared temporary folder, never a project),
/// and then Claude Code is not run.
pub(super) fn working_folder_in(app: Option<&Path>) -> Option<PathBuf> {
    let folder = app?.join("claude-usage-cli");
    std::fs::create_dir_all(&folder).ok()?;
    #[cfg(unix)]
    std::fs::set_permissions(&folder, std::os::unix::fs::PermissionsExt::from_mode(0o700)).ok()?;
    Some(folder)
}

impl RunCli for ProcessCli {
    fn run(&self, env: &[(String, String)], timeout: Duration, stop: &dyn Fn() -> bool) -> Result<Exited, RunFailure> {
        let app = self.app.as_deref().or(crate::secret_store::dir());
        let folder = working_folder_in(app).ok_or(RunFailure::NotStarted)?;
        let path = crate::providers::executable("claude").ok_or(RunFailure::NotStarted)?;
        let command = command(&path, env, &folder).map_err(|_| RunFailure::NotStarted)?;
        let started = Instant::now();
        let graceful = crate::workspace::Graceful { grace: GRACE, stop };
        match crate::workspace::run_process_graceful_until(command, "Claude Code", OUTPUT_LIMIT, timeout, graceful) {
            Ok(mut output) => {
                let stdout = if output.stdout.truncated { Vec::new() } else { std::mem::take(&mut output.stdout.bytes) };
                let stderr = std::mem::take(&mut output.stderr.bytes);
                output.stdout.bytes.fill(0);
                Ok(Exited { status: output.status.code(), stdout, stderr })
            }
            Err(message) => Err(failure(&message, started.elapsed(), timeout)),
        }
    }
}

/// Whether, and how, a check may run Claude Code.
#[derive(Clone)]
pub(super) enum Cli {
    /// The setting is off.
    Off,
    /// No Claude Code to run (tests; the app finds out when it tries).
    #[cfg_attr(not(test), allow(dead_code))]
    Missing,
    /// Already asked in this check: the store is read again, nothing more.
    Used,
    /// Ready: the runner and the environment to give it.
    Ready(Arc<dyn RunCli>, Vec<(String, String)>),
}

/// Variables passed through to the CLI, as Claude gets them (saved provider
/// variables included): where its login lives, how it reaches the network
/// (proxies, certificates), the user's tracking and survey opt-outs, and what
/// a process needs to start (Windows included: its program, profile and
/// user folders). API keys, custom endpoints and OAuth tokens are never among
/// them.
const PASSED: [&str; 39] = [
    "CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy",
    "NO_PROXY", "no_proxy", "ALL_PROXY", "all_proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
    "DO_NOT_TRACK", "CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY", "PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "SystemRoot",
    "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "ComSpec", "PATHEXT", "CLAUDE_CODE_GIT_BASH_PATH",
    "SystemDrive", "WINDIR", "ProgramData", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "HOMEDRIVE",
    "HOMEPATH", "USERNAME",
];

impl Cli {
    /// The CLI as a check of `env` would run it (tests inject theirs):
    /// nothing is looked up or created until a run actually happens.
    #[cfg_attr(test, allow(dead_code))]
    pub(super) fn for_env(env: &ClaudeEnv) -> Self {
        if !crate::provider_settings::claude_cli_refresh() {
            return Self::Off;
        }
        Self::Ready(Arc::new(ProcessCli::new(None)), run_env(env))
    }
}

/// Set for every run PandaCode starts (unattended): no self-update, no
/// telemetry, error reports or other nonessential traffic.
const QUIET: [(&str, &str); 5] = [
    ("TERM", "dumb"),
    ("DISABLE_AUTOUPDATER", "1"),
    ("DISABLE_TELEMETRY", "1"),
    ("DISABLE_ERROR_REPORTING", "1"),
    ("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1"),
];

/// The environment the CLI runs with: the `PASSED` variables as Claude gets
/// them, then `QUIET`.
pub(super) fn run_env(env: &ClaudeEnv) -> Vec<(String, String)> {
    let passed = PASSED.iter().filter_map(|name| env.get(name).map(|value| ((*name).to_owned(), value)));
    passed.chain(QUIET.iter().map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))).collect()
}

/// What a run of Claude Code came to.
pub(super) enum Outcome {
    /// It printed usage lines (a fallback reading).
    Printed(Box<Usage>),
    /// Too old for this: an unknown option, or "/usage isn't available".
    Outdated,
    /// It ran cleanly but printed no usage (no subscription login, say).
    NoUsage,
    /// Its login was refused: sign in again in Claude Code.
    SignIn,
    /// Anything else, a run stopped at its limit included.
    Failed,
    /// It could not be started.
    NotStarted,
}

/// Per profile: the last run, whether a manual Refresh used its extra run
/// since, any backoff, and whether a run is under way (even one detached
/// from the check that started it).
#[derive(Clone, Copy)]
struct Runs {
    at: Instant,
    manual_used: bool,
    backoff: Option<Backoff>,
    running: bool,
    /// When its last run ended, on tokio's clock like a check's `ends`.
    ended_at: Option<tokio::time::Instant>,
}

/// Runs held back until `until` (the wait was `wait`), after an outdated
/// Claude Code or failed runs in a row.
#[derive(Clone, Copy)]
struct Backoff {
    until: Instant,
    wait: Duration,
    outdated: bool,
}

fn runs() -> std::sync::MutexGuard<'static, HashMap<String, Runs>> {
    static RUNS: OnceLock<std::sync::Mutex<HashMap<String, Runs>>> = OnceLock::new();
    RUNS.get_or_init(Default::default).lock().unwrap_or_else(PoisonError::into_inner)
}

/// Takes a run for `profile` if one is allowed now: never beside one under
/// way, once per `RUN_EVERY`, one extra for a manual Refresh, none while
/// backing off (a manual Refresh runs anyway, but the backoff stands). Gives
/// what was recorded before, to hand the slot back.
fn take_run(profile: &str, manual: bool) -> Result<Option<Runs>, NotRun> {
    let mut runs = runs();
    let now = Instant::now();
    let entry = runs.get(profile).copied();
    if entry.is_some_and(|entry| entry.running) {
        return Err(NotRun::Running);
    }
    let backoff = entry.and_then(|entry| entry.backoff);
    if let Some(waiting) = backoff.filter(|backoff| !manual && now < backoff.until) {
        return Err(if waiting.outdated { NotRun::Outdated } else { NotRun::Waiting });
    }
    let next = match entry {
        Some(old) if now.duration_since(old.at) < RUN_EVERY => {
            if !manual || old.manual_used {
                return Err(NotRun::Waiting);
            }
            Runs { manual_used: true, running: true, ..old }
        }
        _ => Runs { at: now, manual_used: false, backoff, running: true, ended_at: entry.and_then(|entry| entry.ended_at) },
    };
    runs.insert(profile.to_owned(), next);
    Ok(entry)
}

/// Whether a run for `profile` ended after `since` (a check that began
/// before it may hold a login Claude Code has since replaced). The same
/// instant counts (a paused clock, or a coarse one): reading again is harmless.
pub(super) fn ended_since(profile: &str, since: tokio::time::Instant) -> bool {
    runs().get(profile).and_then(|entry| entry.ended_at).is_some_and(|ended| ended >= since)
}

/// Whether a run for `profile` is under way.
pub(super) fn running(profile: &str) -> bool {
    runs().get(profile).is_some_and(|entry| entry.running)
}

/// Waits (up to `budget`) for `profile`'s run under way to end.
pub(super) async fn wait_for_run(profile: &str, budget: Duration) {
    // The same clock as the sleeps (paused in timing tests).
    let until = tokio::time::Instant::now() + budget;
    while running(profile) && tokio::time::Instant::now() < until {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// Why no run was started.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum NotRun {
    /// Off, missing, used already in this check, or too little time left.
    Unavailable,
    /// Too soon after the last run, or backing off after failed runs.
    Waiting,
    /// Backing off after signs of an outdated Claude Code.
    Outdated,
    /// A run for this profile is under way.
    Running,
}

/// How long until `profile` may run Claude Code again on its own.
/// How long until a Refresh you press may run Claude Code for `profile`
/// again: the end of its 15-minute slot once the extra run is used (backoffs
/// never hold a manual run back).
pub(super) fn until_slot(profile: &str) -> Duration {
    let now = Instant::now();
    runs().get(profile).map_or(Duration::ZERO, |entry| (entry.at + RUN_EVERY).saturating_duration_since(now))
}

pub(super) fn until_next(profile: &str) -> Duration {
    let now = Instant::now();
    let next = runs().get(profile).map_or(now, |entry| {
        let slot = entry.at + RUN_EVERY;
        entry.backoff.map_or(slot, |backoff| backoff.until.max(slot))
    });
    next.saturating_duration_since(now)
}

/// A run that never started: the slot is `profile`'s again.
fn give_back(profile: &str, before: Option<Runs>) {
    match before {
        Some(before) => runs().insert(profile.to_owned(), before),
        None => runs().remove(profile),
    };
}

/// As if `profile`'s last run was `ago` earlier (tests).
#[cfg(test)]
pub(super) fn age_runs(profile: &str, ago: Duration) {
    if let Some(entry) = runs().get_mut(profile) {
        entry.at -= ago;
        if let Some(backoff) = entry.backoff.as_mut() {
            backoff.until -= ago;
        }
    }
}

/// After a run: it is no longer under way. Printed usage ends any backoff;
/// an outdated Claude Code backs further runs off from an hour, any other
/// outcome without usage (failed, refused login, no usage) from `RUN_EVERY`,
/// doubling while it repeats. A backoff is never shortened: a longer one
/// already in force (an outdated Claude Code's, say) stands.
fn record(profile: &str, outcome: &Outcome) {
    let mut runs = runs();
    let Some(entry) = runs.get_mut(profile) else { return };
    entry.running = false;
    entry.ended_at = Some(tokio::time::Instant::now());
    let outdated = match outcome {
        Outcome::Printed(_) | Outcome::NotStarted => {
            entry.backoff = None;
            return;
        }
        Outcome::Outdated => true,
        Outcome::Failed | Outcome::SignIn | Outcome::NoUsage => false,
    };
    let (first, max) = if outdated { (OUTDATED_WAIT, OUTDATED_MAX) } else { (RUN_EVERY, FAILED_MAX) };
    let wait = entry.backoff.filter(|backoff| backoff.outdated == outdated).map_or(first, |backoff| backoff.wait.saturating_mul(2).min(max));
    let next = Backoff { until: Instant::now() + wait, wait, outdated };
    entry.backoff = Some(match entry.backoff {
        Some(longer) if longer.until > next.until => longer,
        _ => next,
    });
}

/// Whether a Refresh you press may still run Claude Code for `profile` now
/// (its one extra run in this interval not yet used).
pub(super) fn manual_left(profile: &str) -> bool {
    runs().get(profile).is_none_or(|entry| !entry.running && (!entry.manual_used || entry.at.elapsed() >= RUN_EVERY))
}

/// Whether PandaCode is running Claude Code for `profile`'s check now (its
/// card says "Asking Claude Code…").
pub(crate) fn asking(profile: &str) -> bool {
    running(profile)
}

/// The profile (key, account hash, app data) each Claude usage card last checked, by
/// setup (`""`: the global one, else a connection id): the panel asks whether
/// that setup is running Claude Code, and for its saved reading, without
/// reading any of its login files or secrets again.
fn checked_setups() -> std::sync::MutexGuard<'static, HashMap<String, limits::Profile>> {
    static SETUPS: OnceLock<std::sync::Mutex<HashMap<String, limits::Profile>>> = OnceLock::new();
    SETUPS.get_or_init(Default::default).lock().unwrap_or_else(PoisonError::into_inner)
}

/// Notes that the card for `setup` (`""` or a connection id) checks the
/// `profile` (cached per check).
pub(crate) fn note_check(setup: &str, profile: limits::Profile) {
    checked_setups().insert(setup.to_owned(), profile);
}

/// Whether PandaCode is running Claude Code for `setup`'s check right now.
pub(crate) fn asking_for(setup: &str) -> bool {
    let key = checked_setups().get(setup).map(|profile| profile.key.clone());
    key.is_some_and(|key| asking(&key))
}

/// The saved reading (marked stale) of the account `setup`'s last check
/// noted, shown while its check still runs: one small file in PandaCode's app
/// data, never the network, the Keychain or Claude Code's files. `None`
/// before any check noted it, or without a reading for that account.
pub(crate) async fn saved_for(setup: &str) -> Option<Usage> {
    let profile = checked_setups().get(setup).cloned()?;
    limits::saved_reading(&profile).await
}

/// A run taken for a profile, not yet started.
pub(super) struct Run {
    runner: Arc<dyn RunCli>,
    env: Vec<(String, String)>,
    profile: String,
    before: Option<Runs>,
    guard: Guard,
}

/// Takes a run for `profile` if Claude Code may run (ready, allowed now, and
/// `budget` leaves at least `RUN_MIN`).
pub(super) fn start(cli: &Cli, profile: &str, manual: bool, budget: Duration) -> Result<Run, NotRun> {
    let Cli::Ready(runner, env) = cli else { return Err(NotRun::Unavailable) };
    if budget < RUN_MIN {
        return Err(NotRun::Unavailable);
    }
    let before = take_run(profile, manual)?;
    Ok(Run { runner: runner.clone(), env: env.clone(), profile: profile.to_owned(), before, guard: Arc::new(|| true) })
}

impl Run {
    /// Checked right before Claude Code starts (else it never starts and
    /// hands its slot back) and every 2 s while it runs (else it is stopped).
    pub(super) fn guarded(self, guard: Guard) -> Self {
        Self { guard, ..self }
    }

    /// Runs Claude Code on a blocking thread, detached: dropping the handle
    /// (a check past its deadline) lets it finish on its own `RUN_LIMIT`, and
    /// `done` gets its outcome when it ends either way. A run that could not
    /// start hands its slot back.
    pub(super) fn spawn(self, done: impl FnOnce(&Outcome) + Send + 'static) -> tokio::task::JoinHandle<Outcome> {
        tokio::task::spawn_blocking(move || {
            // A panic in the runner is a failed run (the slot is kept, the store read again).
            let stop = || !(self.guard)();
            let run = match stop() {
                true => Ok(Err(RunFailure::NotStarted)),
                false => std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| self.runner.run(&self.env, RUN_LIMIT, &stop))),
            };
            let outcome = run.map_or(Outcome::Failed, classify);
            // Saved and forgotten (`done`) before the run counts as over, so
            // a check waiting for it reads what it left. A panic there still
            // ends the run: it is recorded and no longer under way.
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| done(&outcome)));
            match outcome {
                Outcome::NotStarted => give_back(&self.profile, self.before),
                _ => record(&self.profile, &outcome),
            }
            outcome
        })
    }
}

/// What a run's result means, from Claude Code's `result` text and stderr
/// only. Only the kind and exit status are logged, never output.
pub(super) fn classify(result: Result<Exited, RunFailure>) -> Outcome {
    let exited = match result {
        Ok(exited) => exited,
        Err(RunFailure::TimedOut | RunFailure::Lost) => return Outcome::Failed,
        Err(RunFailure::NotStarted) => return Outcome::NotStarted,
    };
    if let Some(usage) = parse(&exited.stdout) {
        return Outcome::Printed(usage);
    }
    let mut json = serde_json::from_slice::<Value>(&exited.stdout).unwrap_or_default();
    let clean = exited.status == Some(0) && json["is_error"] == false;
    let mut result = json["result"].as_str().unwrap_or_default().to_lowercase();
    let mut stderr = String::from_utf8_lossy(&exited.stderr).to_lowercase();
    let outcome = outcome_of(clean, &result, &stderr);
    wipe_value(&mut json);
    wipe(&mut result);
    wipe(&mut stderr);
    let kind = match outcome {
        Outcome::Outdated => "it may need an update",
        Outcome::NoUsage => "not a subscription login",
        Outcome::SignIn => "its login was refused",
        _ => "it failed",
    };
    eprintln!("Claude Code's /usage gave no usage (exit status {:?}): {kind}.", exited.status);
    outcome
}

/// The outcome of a run without usage lines, from its lowercase `result`
/// text and stderr.
fn outcome_of(clean: bool, result: &str, stderr: &str) -> Outcome {
    let either = |sign: &str| result.contains(sign) || stderr.contains(sign);
    let unknown_option = [result, stderr].iter().flat_map(|text| text.lines()).any(|line| {
        UNKNOWN.iter().any(|sign| line.contains(sign)) && NEW_OPTIONS.iter().any(|option| line.contains(option))
    });
    match () {
        _ if unknown_option || either(UNAVAILABLE) => Outcome::Outdated,
        _ if SIGN_IN.iter().any(|sign| either(sign)) => Outcome::SignIn,
        _ if clean && result.contains(COST_SUMMARY) && !result.contains(SUBSCRIPTION) => Outcome::NoUsage,
        _ => Outcome::Failed,
    }
}

/// Reads the CLI's JSON result: its `result` text's usage lines,
/// "<title>: N% used · resets <when>", become windows (source "Claude Code
/// CLI"), whatever else it says.
pub(super) fn parse(stdout: &[u8]) -> Option<Box<Usage>> {
    let value = serde_json::from_slice::<Value>(stdout).ok()?;
    let text = value["result"].as_str().unwrap_or_default();
    let mut windows: Vec<UsageWindow> = text.lines().filter_map(window).collect();
    if windows.is_empty() {
        return None;
    }
    order_windows(&mut windows);
    let mut usage = Usage::empty("claude", "ready", "");
    usage.windows = windows;
    usage.plan = text.lines().find_map(plan);
    usage.source = Some(SOURCE.into());
    usage.dashboard_url = Some("https://claude.ai/settings/usage".into());
    Some(Box::new(usage))
}

/// The plan, only where the printout states it: a "Plan: Max" line, or the
/// subscription header ("You are using your Claude Max subscription…"); a
/// mention elsewhere ("upgrade to Claude Max") is not the plan.
fn plan(line: &str) -> Option<String> {
    let line = line.trim().to_lowercase();
    if let Some(name) = line.strip_prefix("plan:") {
        return name.trim().trim_start_matches("claude ").split_whitespace().next().and_then(plan_name);
    }
    if !(line.contains("using your") && line.contains("subscription")) {
        return None;
    }
    let words: Vec<&str> = line.split(|c: char| !c.is_ascii_alphanumeric()).filter(|w| !w.is_empty()).collect();
    words.windows(2).find(|pair| pair[0] == "claude" && ["pro", "max", "team", "enterprise"].contains(&pair[1])).and_then(|pair| plan_name(pair[1]))
}

/// One usage line, e.g. "Current week (all models): 48% used · resets Nov 15
/// at 8pm (America/New_York)"; the reset stays as Claude Code wrote it (shown
/// when there is no timestamp).
fn window(line: &str) -> Option<UsageWindow> {
    let (title, rest) = line.trim().split_once(": ")?;
    let (percent, after) = rest.split_once("% used")?;
    // Clamped to 0–100, as the endpoint's percentages are (`agent_usage::percentage`).
    let percent = crate::agent_usage::percentage(&Value::from(percent.trim().parse::<f64>().ok()?))?;
    let label = match title {
        "Current session" => "5 hours".to_owned(),
        "Current week (all models)" => "Weekly".to_owned(),
        other => {
            let model = other.strip_prefix("Current week (")?.strip_suffix(')')?;
            format!("Weekly · {}", model.trim_end_matches(" only"))
        }
    };
    let mut window = UsageWindow::new(label, percent, None);
    // "Resets Nov 15 at 8pm (…)", capitalized like the panel's other reset times.
    window.detail = after.trim().strip_prefix("· ").map(|reset| {
        let mut chars = reset.chars();
        chars.next().map(|first| first.to_uppercase().chain(chars).take(80).collect()).unwrap_or_default()
    });
    Some(window)
}
