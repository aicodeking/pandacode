//! Claude Code subscription usage. The login is the one Claude Code uses: its
//! Keychain item first (macOS), else `<config>/.credentials.json`, read only:
//! PandaCode never writes Claude Code's credentials or calls its token
//! endpoint. An expired login (or one the usage service rejects) is refreshed
//! by Claude Code itself (`cli`, when Settings allow), then read again.
//! Tokens never reach the webview or logs.

use crate::agent_usage::{percentage, plan_name, reset_string, text_field, FetchError, Usage, UsageWindow};
use crate::agent_usage_claude_env::ClaudeEnv;
use crate::agent_usage_claude_limits::{self as limits, Profile};
use crate::agent_usage_claude_remote::{token, wipe, wipe_value, Http, Remote, UsageFailure};
use crate::agent_usage_claude_store::{keychain_item_stamp, keychain_unlocked, read_store, read_store_manual, Read, Store, Unread};
use serde::Deserialize;
use serde_json::Value;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, OnceLock, PoisonError},
    time::{Duration, Instant},
};

const PROFILE_SCOPE: &str = "user:profile";
/// A token this close to expiry counts as expired: Claude Code refreshes it.
const EXPIRY_MARGIN_MS: u64 = 10_000;
const STORE_LIMIT: usize = 256 * 1024;
/// How long a Claude check may take before the panel gets an answer (the
/// saved reading): room for a run of Claude Code (`cli::RUN_LIMIT`) and the
/// reads around it. `agent_usage::bounded` allows a little more.
pub(crate) const DEADLINE: Duration = Duration::from_secs(60);
/// A manual refresh's deadline: room as well for a 20 s Keychain read (which
/// may wait for a dialog).
pub(crate) const MANUAL_DEADLINE: Duration = Duration::from_secs(75);

/// Which message a result carries, for decisions: never the text itself.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Cause {
    KeychainLocked,
    ReadFailed,
    KeychainLatched,
    NotFound,
    SignInAgain,
    CantReadUsage,
    Expired,
    ExpiredOff,
    UpdateClaude,
    CliSignIn,
    CliNoUsage,
    CliFailed,
    TimedOut,
    /// A check stopped waiting while its run of Claude Code goes on.
    StillRunning,
    /// Rate limited, and the server's `Retry-After` is still in force.
    RateLimitBlocked,
}

/// Status, text, what fixes it (`Usage::action`), whether a manual Refresh
/// may skip the ten-second minimum for it (`Usage::refresh_now`: a Keychain
/// latch or a timeout, which a Refresh itself lifts), and its `Cause`.
type Message = (&'static str, &'static str, &'static str, bool, Cause);
const KEYCHAIN_LOCKED: Message = ("error", "Your login Keychain is locked, so PandaCode can't read Claude's login. Unlock it, then refresh.", "unlock", false, Cause::KeychainLocked);
const READ_FAILED: Message = ("error", "PandaCode couldn't read Claude's login just now. Press Refresh to try again.", "retry", true, Cause::ReadFailed);
const KEYCHAIN_LATCHED: Message = ("error", "macOS didn't let PandaCode read Claude's login (denied or not answered). Press Refresh to try again, which also lets Claude Code read its own login; if macOS asks, choose Always Allow.", "refresh", true, Cause::KeychainLatched);
const NOT_FOUND: Message = ("signedOut", "No Claude Code login was found for this setup. Sign in with Claude Code, then refresh.", "claude", false, Cause::NotFound);
const SIGN_IN_AGAIN: Message = ("signedOut", "Claude no longer accepts the saved login. Open Claude Code and sign in again (/login), then refresh.", "claude", false, Cause::SignInAgain);
const CANT_READ_USAGE: Message = ("unavailable", "This Claude login can't read subscription usage. Sign in with Claude Code (/login), then refresh.", "claude", false, Cause::CantReadUsage);
const EXPIRED: Message = ("error", "Your Claude login has expired. Open Claude Code to refresh it, then press Refresh.", "expired", false, Cause::Expired);
const EXPIRED_OFF: Message = ("error", "Your Claude login has expired. Open Claude Code, or turn on Let PandaCode ask Claude Code for usage when it can’t read it in Settings.", "settings", false, Cause::ExpiredOff);
const UPDATE_CLAUDE: Message = ("error", "Update Claude Code to let PandaCode refresh an expired login. Until then, open Claude Code to refresh it.", "updateClaude", false, Cause::UpdateClaude);
const CLI_SIGN_IN: Message = ("signedOut", "Claude Code's login was refused. Sign in again in Claude Code (/login), then refresh.", "claude", false, Cause::CliSignIn);
const CLI_NO_USAGE: Message = ("unavailable", "Claude Code ran but reported no subscription usage: it may not be signed in with a Claude subscription. Sign in with /login in Claude Code, then refresh.", "claude", false, Cause::CliNoUsage);
/// When opening the panel asks Claude Code again goes in `auto_retry_at`
/// (`cli_failed`); the panel words it, in the user's locale.
const CLI_FAILED: Message = ("error", "Claude Code couldn't refresh the login.", "expired", false, Cause::CliFailed);
const STILL_RUNNING: Message = ("error", "Claude Code is still refreshing the login; open this again shortly.", "refresh", true, Cause::StillRunning);
const TIMED_OUT: Message = ("error", "The usage check took too long. Press Refresh to try again.", "refresh", true, Cause::TimedOut);

/// Windows in a fixed order: 5 hours, Weekly, then the rest as reported.
/// A window the service did not report is left out, never shown as 0%.
fn order_windows(windows: &mut [UsageWindow]) {
    windows.sort_by_key(|w| match w.label.as_str() {
        "5 hours" => 0,
        "Weekly" => 1,
        _ => 2,
    });
}

pub(crate) fn claude_usage(value: &Value, plan: Option<String>) -> Usage {
    let mut result = Usage::empty("claude", "unavailable", "Claude did not report subscription usage limits.");
    result.plan = plan;
    result.source = Some("Claude OAuth usage".into());
    result.dashboard_url = Some("https://claude.ai/settings/usage".into());
    let mut add = |label: String, used: Option<f64>, resets: &Value| {
        if let Some(used) = used.filter(|_| !result.windows.iter().any(|w| w.label == label)) {
            result.windows.push(UsageWindow::new(label, used, reset_string(resets)));
        }
    };
    for (key, label) in [
        ("five_hour", "5 hours"),
        ("seven_day", "Weekly"),
        ("seven_day_opus", "Weekly · Opus"),
        ("seven_day_sonnet", "Weekly · Sonnet"),
        ("seven_day_oauth_apps", "Weekly · OAuth apps"),
    ] {
        add(label.into(), percentage(&value[key]["utilization"]), &value[key]["resets_at"]);
    }
    // These repeat the keys above (deduplicated by label) and stand in when those are null.
    for window in value["limits"].as_array().into_iter().flatten().take(16) {
        let label = match window["kind"].as_str() {
            _ if window["is_active"] == false => continue,
            Some("weekly_all") => "Weekly".to_owned(),
            Some("five_hour") => "5 hours".to_owned(),
            Some("weekly_scoped") => match text_field(&window["scope"]["model"]["display_name"], 64) {
                Some(model) => format!("Weekly · {model}"),
                None => continue,
            },
            _ => continue,
        };
        add(label, percentage(&window["percent"]), &window["resets_at"]);
    }
    if value["extra_usage"]["is_enabled"] == true {
        add("Extra usage budget".into(), percentage(&value["extra_usage"]["utilization"]), &Value::Null);
    }
    order_windows(&mut result.windows);
    if !result.windows.is_empty() {
        result.status = "ready".into();
        result.message = None;
    }
    result
}

fn usage(message: Message) -> Box<Usage> {
    let mut result = Usage::empty("claude", message.0, message.1);
    result.action = Some(message.2);
    result.refresh_now = message.3;
    result.cause = Some(message.4);
    Box::new(result)
}

fn unread_message(unread: Unread) -> Message {
    match unread {
        Unread::KeychainLocked => KEYCHAIN_LOCKED,
        Unread::Keychain => READ_FAILED,
        Unread::KeychainLatched => KEYCHAIN_LATCHED,
        Unread::File => READ_FAILED,
    }
}

fn now_ms() -> u64 {
    crate::storage::now().max(0) as u64
}

/// One parsed login: only what a check needs (its access token wiped when
/// dropped). A refresh token is never kept, only whether there was one.
#[derive(Clone)]
struct Login {
    store: Store,
    access_token: String,
    refreshable: bool,
    expires_at: Option<u64>,
    scopes: Option<Vec<String>>,
    plan: Option<String>,
}

impl Drop for Login {
    fn drop(&mut self) {
        wipe(&mut self.access_token);
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Fitness {
    NoProfile,
    Expired,
    Refreshable,
    Valid,
}

impl Login {
    fn fitness(&self, now: u64) -> Fitness {
        let profile = self.scopes.as_ref().is_some_and(|s| s.iter().any(|s| s == PROFILE_SCOPE));
        if !profile {
            Fitness::NoProfile
        } else if self.expires_at.is_none_or(|expiry| expiry > now.saturating_add(EXPIRY_MARGIN_MS)) {
            Fitness::Valid
        } else if self.refreshable {
            Fitness::Refreshable
        } else {
            Fitness::Expired
        }
    }
}

/// What a store holds.
enum Parsed {
    Login(Login),
    /// Valid JSON without a Claude login (only MCP entries, an API-key
    /// setup): nobody is signed in to Claude here.
    NoLogin,
    /// Not JSON, oversized, or a `claudeAiOauth` without a usable token.
    Unrecognized,
}

#[cfg(test)]
impl Parsed {
    fn login(self) -> Option<Login> {
        match self {
            Self::Login(login) => Some(login),
            _ => None,
        }
    }
}

/// Reads only the documented `claudeAiOauth` fields.
fn parse_login(raw: Vec<u8>, store: Store) -> Parsed {
    #[derive(Deserialize)]
    struct File {
        #[serde(rename = "claudeAiOauth")]
        oauth: Option<OAuth>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct OAuth {
        access_token: Option<String>,
        refresh_token: Option<String>,
        expires_at: Option<f64>,
        scopes: Option<Vec<String>>,
        subscription_type: Option<String>,
    }
    let mut raw = raw;
    let file = (raw.len() <= STORE_LIMIT).then(|| serde_json::from_slice::<File>(&raw).ok()).flatten();
    let Some(file) = file else {
        raw.fill(0);
        return Parsed::Unrecognized;
    };
    let Some(mut oauth) = file.oauth else {
        raw.fill(0);
        return Parsed::NoLogin;
    };
    let Some(access_token) = token(oauth.access_token.take()) else {
        raw.fill(0);
        if let Some(refresh) = oauth.refresh_token.as_mut() {
            wipe(refresh);
        }
        return Parsed::Unrecognized;
    };
    raw.fill(0);
    let refreshable = token(oauth.refresh_token.take()).map(|mut refresh| wipe(&mut refresh)).is_some();
    Parsed::Login(Login {
        store,
        access_token,
        refreshable,
        expires_at: oauth.expires_at.filter(|n| n.is_finite() && *n >= 0.0).map(|n| n as u64),
        scopes: oauth.scopes,
        plan: oauth.subscription_type.as_deref().and_then(plan_name),
    })
}

/// The login Claude Code would use (see `choose`).
fn choose(logins: Vec<Login>, now: u64) -> Option<Login> {
    // Claude Code's own rule: the Keychain's login whenever it holds one, the
    // credential file only when it does not.
    let (keychain, others): (Vec<_>, Vec<_>) = logins.into_iter().partition(|login| matches!(login.store, Store::Keychain(_)));
    // Among the rest, a login without an expiry cannot be checked: any known expiry beats it.
    let rank = |login: &Login| (login.fitness(now), login.expires_at.unwrap_or(0));
    keychain.into_iter().next().or_else(|| {
        others.into_iter().fold(None, |best, login| match best {
            Some(best) if rank(&best) >= rank(&login) => Some(best),
            _ => Some(login),
        })
    })
}

#[derive(Default)]
struct Gathered {
    logins: Vec<Login>,
    unread: Option<Unread>,
    unrecognized: bool,
    /// Stores whose login came from `remembered`, not a fresh Keychain read.
    from_memory: Vec<Store>,
}

/// The Keychain login last read, per item, with the account it was read for.
/// Automatic checks reuse it, so `security` runs rarely; it is read again
/// only when it is within 5 minutes of expiry, the usage service rejects it,
/// `.claude.json` names another account, or the user presses Refresh.
struct Remembered {
    /// The parsed login (no refresh token, no raw JSON).
    login: Login,
    hint: Option<String>,
    /// When it was read, and whether it had already expired then: such a
    /// login (expired, and not refreshed) is read again at most every
    /// `REREAD_STALE`, or on Refresh, not on every check.
    read_at: Instant,
    stale_when_read: bool,
    /// When the item was last checked (read, or an attribute-only lookup),
    /// and its modification date then: a change forces a real read.
    checked_at: Instant,
    stamp: Option<String>,
}

const REUSE_MARGIN_MS: u64 = 5 * 60_000;
const REREAD_STALE: Duration = Duration::from_secs(15 * 60);
/// With a known account, how often a reused login's item is confirmed to exist.
const RECHECK_ITEM: Duration = Duration::from_secs(5 * 60);

/// Whether a login's expiry is more than `margin_ms` away (or unknown).
fn lasts(login: &Login, margin_ms: u64) -> bool {
    login.expires_at.is_none_or(|at| at > now_ms().saturating_add(margin_ms))
}

/// Per store, how many runs of Claude Code for it have ended: a read that
/// began before one ended is not remembered (it may hold the login Claude
/// Code just replaced).
fn runs_ended_map() -> std::sync::MutexGuard<'static, HashMap<Store, u64>> {
    static ENDED: OnceLock<std::sync::Mutex<HashMap<Store, u64>>> = OnceLock::new();
    ENDED.get_or_init(Default::default).lock().unwrap_or_else(PoisonError::into_inner)
}

fn runs_ended(store: &Store) -> u64 {
    runs_ended_map().get(store).copied().unwrap_or(0)
}

/// A run ended: forget `stores`' remembered logins, and any read under way.
fn forget_after_run(stores: &[Store]) {
    let mut remembered = remembered();
    let mut ended = runs_ended_map();
    for store in stores {
        *ended.entry(store.clone()).or_default() += 1;
    }
    remembered.retain(|store, _| !stores.contains(store));
}

fn remembered() -> std::sync::MutexGuard<'static, HashMap<Store, Remembered>> {
    static REMEMBERED: OnceLock<std::sync::Mutex<HashMap<Store, Remembered>>> = OnceLock::new();
    REMEMBERED.get_or_init(Default::default).lock().unwrap_or_else(PoisonError::into_inner)
}

/// The remembered login for `store`, if it may be reused for `hint` now:
/// while fresh; once it nears expiry it is read again (Claude Code may have
/// refreshed it), and if it had already expired when read, reused for
/// `REREAD_STALE` before the next read (a run of Claude Code drops it at once).
fn reusable(store: &Store, hint: &Option<String>) -> Option<Login> {
    let remembered = remembered();
    let entry = remembered.get(store).filter(|entry| &entry.hint == hint)?;
    let recent_stale = entry.stale_when_read && entry.read_at.elapsed() < REREAD_STALE;
    (recent_stale || lasts(&entry.login, REUSE_MARGIN_MS)).then(|| entry.login.clone())
}

/// Whether checks remember this store's login between reads: a Keychain
/// item (reads may run `security`), and scripted test stores that ask to.
fn remembers(store: &Store) -> bool {
    match store {
        Store::Keychain(_) => true,
        Store::File(_) => false,
    }
}

/// Remembers `login`, read for `hint` when `runs_ended()` was `ended`;
/// not if a run of Claude Code ended since (it may have replaced it).
async fn remember(store: &Store, login: &Login, hint: &Option<String>, ended: u64) {
    if !remembers(store) {
        return;
    }
    let stamp = keychain_item_stamp(store).await.flatten();
    let stale_when_read = !lasts(login, EXPIRY_MARGIN_MS);
    let now = Instant::now();
    let entry = Remembered { login: login.clone(), hint: hint.clone(), read_at: now, stale_when_read, checked_at: now, stamp };
    let mut remembered = remembered();
    if runs_ended(store) == ended {
        remembered.insert(store.clone(), entry);
    }
}

fn item_check_due(store: &Store, check: &Check) -> bool {
    check.profile.account.is_none() || remembered().get(store).is_none_or(|entry| entry.checked_at.elapsed() >= RECHECK_ITEM)
}

/// Whether the remembered login's item is unchanged: present, with the same
/// modification date as at the read (or one unknown then, recorded now), or
/// not known to have changed (the lookup failed).
async fn item_unchanged(store: &Store) -> bool {
    let now = keychain_item_stamp(store).await;
    let mut remembered = remembered();
    let Some(entry) = remembered.get_mut(store) else { return false };
    match now {
        Some(None) => false,
        Some(Some(stamp)) if entry.stamp.as_ref().is_some_and(|before| *before != stamp) => false,
        Some(Some(stamp)) => {
            entry.stamp = Some(stamp);
            entry.checked_at = Instant::now();
            true
        }
        None => {
            entry.checked_at = Instant::now();
            true
        }
    }
}

/// What one store gave a check.
enum Got {
    Login(Login),
    NoLogin,
    Unrecognized,
    Missing,
    Failed(Unread),
}

fn got(read: Read, store: &Store) -> Got {
    match read {
        Read::Found(bytes) => match parse_login(bytes, store.clone()) {
            Parsed::Login(login) => Got::Login(login),
            Parsed::NoLogin => Got::NoLogin,
            Parsed::Unrecognized => Got::Unrecognized,
        },
        Read::Missing => Got::Missing,
        Read::Failed(why) => Got::Failed(why),
    }
}

/// One store's read for a check: a Keychain item's remembered login when it
/// may be reused, else a real read (its login remembered for next time).
async fn read_for_check(store: &Store, check: &Check, reuse: bool) -> (Got, bool) {
    if !remembers(store) {
        return (got(read_store(store).await, store), false);
    }
    // A locked Keychain: its remembered login is not used either.
    if !keychain_unlocked(store) {
        remembered().remove(store);
    }
    if reuse && !check.refresh {
        if let Some(login) = reusable(store, &check.profile.account) {
            // An attribute-only lookup (no secret, no prompt) compares the
            // item's modification date with the one at the read: on every
            // check when `.claude.json` names no account (a switch could not
            // be seen there), else at most every `RECHECK_ITEM`. A gone or
            // changed item is read for real.
            if !item_check_due(store, check) || item_unchanged(store).await {
                return (Got::Login(login), true);
            }
            remembered().remove(store);
        }
    }
    let ended = runs_ended(store);
    let read = if check.refresh { read_store_manual(store).await } else { read_store(store).await };
    let got = got(read, store);
    match &got {
        Got::Login(login) => remember(store, login, &check.profile.account, ended).await,
        _ => {
            remembered().remove(store);
        }
    }
    (got, false)
}

async fn gather(stores: &[Store], check: &Check, reuse: bool) -> Gathered {
    let mut gathered = Gathered::default();
    for store in stores {
        let (got, from_memory) = read_for_check(store, check, reuse).await;
        if from_memory {
            gathered.from_memory.push(store.clone());
        }
        match got {
            Got::Login(login) => gathered.logins.push(login),
            Got::NoLogin | Got::Missing => {}
            Got::Unrecognized => gathered.unrecognized = true,
            Got::Failed(why) => gathered.unread = gathered.unread.or(Some(why)),
        }
    }
    gathered
}

/// The login Claude Code would use, or the accurate reason there is none.
/// If the Keychain could not be read, no credential-file login stands in
/// (Claude Code would have used the Keychain); a credential file that could
/// not be read matters only when the Keychain holds no login.
fn pick(gathered: Gathered, now: u64) -> Result<Login, Box<Usage>> {
    let (unread, unrecognized) = (gathered.unread, gathered.unrecognized);
    if let Some(why) = unread.filter(|why| why.keychain()) {
        return Err(usage(unread_message(why)));
    }
    let best = choose(gathered.logins, now);
    match (best.as_ref().map(|login| login.fitness(now)), unread) {
        (Some(Fitness::Valid | Fitness::Refreshable), _) => best.ok_or_else(|| usage(NOT_FOUND)),
        (_, Some(why)) => Err(usage(unread_message(why))),
        (Some(Fitness::Expired), None) => Err(usage(SIGN_IN_AGAIN)),
        (Some(Fitness::NoProfile), None) | (None, None) if unrecognized || best.is_some() => Err(usage(CANT_READ_USAGE)),
        (_, None) => Err(usage(NOT_FOUND)),
    }
}

/// Everything one usage check needs besides the stores.
#[derive(Clone)]
struct Check {
    remote: Arc<dyn Remote>,
    profile: Profile,
    /// A manual refresh.
    refresh: bool,
    /// Whether an expired login may be refreshed by running Claude Code.
    cli: cli::Cli,
    /// When the panel gets an answer even if the check is still running.
    deadline: Duration,
    /// When that is (set as the check starts): a run of Claude Code gets
    /// what is left, minus a margin.
    /// On tokio's clock: the real one in the app, paused and driven in
    /// timing tests.
    ends: Option<tokio::time::Instant>,
    /// Claude Code's `.claude.json`, read again when a run ends: its printed
    /// usage is saved under the account signed in then.
    account_file: Option<PathBuf>,
    /// Claude Code's own refresh lock, `<config>/.oauth_refresh.lock`.
    refresh_lock: Option<PathBuf>,
}

/// Reads usage with the best login. A good reading is saved; a transient
/// error, or a check that outlives its deadline, shows the saved one instead.
async fn usage_with_login(stores: &[Store], check: &Check) -> Usage {
    let check = &Check { ends: Some(tokio::time::Instant::now() + check.deadline), ..check.clone() };
    // A margin past `ends`, so a re-read given all that is left settles first.
    let Ok(result) = tokio::time::timeout(check.deadline + cli::MARGIN, check_usage(stores, check)).await else {
        return timed_out(&check.profile).await;
    };
    // Only the endpoint answering ends a rate limit; printed numbers do not.
    if result.status == "ready" && !result.stale && result.source.as_deref() != Some(cli::SOURCE) {
        limits::unblock(&check.profile);
    }
    limits::remember(&check.profile, &result).await;
    owned(&check.profile, limits::or_saved(&check.profile, result).await)
}

/// Tags a result with whose it is, so `agent_usage::cached` never lets
/// another profile's or account's reading stand in for it.
fn owned(profile: &Profile, mut result: Usage) -> Usage {
    result.owner = Some((profile.key.clone(), profile.account.clone()));
    result
}

/// A check past its deadline: the saved reading.
pub(crate) async fn timed_out(profile: &Profile) -> Usage {
    owned(profile, limits::or_saved(profile, *usage(TIMED_OUT)).await)
}

async fn check_usage(stores: &[Store], check: &Check) -> Usage {
    // Rate limited: nothing is sent until the service's wait is over (for a
    // manual refresh, the server's own Retry-After). An automatic check reads
    // nothing either; the saved reading it shows is tied to the account
    // `.claude.json` names now, so after a sign-out or an account switch
    // there is none to show. A manual refresh re-reads the stores.
    let blocked = limits::blocked(&check.profile, Instant::now(), check.refresh);
    if let (Some(_), false) = (blocked, check.refresh) {
        // The wait is in force: nothing is asked, Claude Code included; the
        // saved reading (or the rate-limit card) stands in.
        return blocked_by_rate_limit(&check.profile).await;
    }
    let mut checked = check_stores(stores, check, blocked, true).await;
    // A Keychain login reused from memory that the service rejects: read the
    // Keychain once more (Claude Code may have refreshed or signed in again).
    if let Some(store) = checked.reread.take() {
        remembered().remove(&store);
        checked = check_stores(stores, check, blocked, false).await;
    }
    if worth_asking(&checked.usage, check) {
        return ask_claude(stores, check, blocked, checked.usage).await;
    }
    checked.usage
}

/// Whether Claude Code may help: any result but a reading (a rate limit with
/// a saved reading is one), a connection that is not the subscription, a
/// locked Keychain (it couldn't read it either), no login where
/// `.claude.json` names no account (never signed in), or, except on a manual
/// Refresh, a Keychain read the user denied.
fn worth_asking(usage: &Usage, check: &Check) -> bool {
    let never_signed_in = usage.cause == Some(Cause::NotFound) && check.profile.account.is_none();
    let denied = usage.cause == Some(Cause::KeychainLatched) && !check.refresh;
    let in_server_wait = usage.cause == Some(Cause::RateLimitBlocked);
    !in_server_wait && usage_missing(usage) && !matches!(usage.action, Some("apiConnection" | "unlock")) && !never_signed_in && !denied
}

/// Rate limited inside the server's `Retry-After`: the saved reading or the
/// rate-limit card, and never a run of Claude Code (`worth_asking`).
async fn blocked_by_rate_limit(profile: &Profile) -> Usage {
    let mut limited = limits::rate_limited(profile).await;
    limited.cause = Some(Cause::RateLimitBlocked);
    limited
}

/// No reading, or only a saved one standing in for a rate limit that has
/// lasted longer than a run's interval.
fn usage_missing(usage: &Usage) -> bool {
    let saved_age = Duration::from_millis(now_ms().saturating_sub(usage.checked_at));
    let old_saved = usage.action == Some("rateLimited") && usage.stale && saved_age > cli::RUN_EVERY;
    usage.status != "ready" || old_saved
}

/// How long the check has left (a check without a deadline: a whole run).
fn left(check: &Check) -> Duration {
    check.ends.map_or(cli::RUN_LIMIT + cli::MARGIN, |ends| ends.saturating_duration_since(tokio::time::Instant::now()))
}

/// One pass over the stores: its result, and the store to read once more
/// when the remembered Keychain login was rejected.
struct Checked {
    usage: Usage,
    reread: Option<Store>,
}

impl From<Usage> for Checked {
    fn from(usage: Usage) -> Self {
        Self { usage, reread: None }
    }
}

/// Reads the stores (reusing a remembered Keychain login when `reuse`),
/// picks the login and reads usage with it, or says what to do next.
async fn check_stores(stores: &[Store], check: &Check, blocked: Option<Instant>, reuse: bool) -> Checked {
    let found = gather(stores, check, reuse).await;
    let (unread, from_memory) = (found.unread, found.from_memory.clone());
    let login = match pick(found, now_ms()) {
        Ok(login) => login,
        Err(result) => return (*result).into(),
    };
    if blocked.is_some() {
        return blocked_by_rate_limit(&check.profile).await.into();
    }
    if login.fitness(now_ms()) == Fitness::Refreshable {
        return (*usage(if matches!(check.cli, cli::Cli::Off) { EXPIRED_OFF } else { EXPIRED })).into();
    }
    let (usage, rejected) = read_limits(check, &login.access_token, login.plan.clone(), &login.store, unread).await;
    let reread = (rejected && from_memory.contains(&login.store)).then(|| login.store.clone());
    Checked { usage, reread }
}

/// One request to the usage endpoint: what its answer means, and whether
/// the login was rejected (401).
async fn read_limits(check: &Check, token: &str, plan: Option<String>, store: &Store, unread: Option<Unread>) -> (Usage, bool) {
    let mut result = match check.remote.usage(token.to_owned()).await {
        Ok(mut value) => {
            let result = claude_usage(&value, plan);
            wipe_value(&mut value);
            result
        }
        // Rejected: Claude Code must sign in again (or refresh: see
        // `ask_claude`), unless this was a credential-file login and another
        // store could not be read (it may hold the current login). The
        // Keychain's login is the one Claude Code uses whenever there is
        // one: an unreadable file beside it changes nothing.
        Err(UsageFailure { error: FetchError::Http(401), .. }) => {
            let unread = unread.filter(|_| !matches!(store, Store::Keychain(_)));
            return (*usage(unread.map_or(SIGN_IN_AGAIN, unread_message)), true);
        }
        Err(UsageFailure { error: FetchError::Http(429), retry_after }) => {
            let now = Instant::now();
            limits::block(&check.profile, now, retry_after.as_deref());
            // The server just set a wait (`Retry-After`): Claude Code is not
            // run inside it either. Without one, it may be (`worth_asking`).
            let mut limited = limits::rate_limited(&check.profile).await;
            if limits::blocked(&check.profile, now, true).is_some() {
                limited.cause = Some(Cause::RateLimitBlocked);
            }
            return (limited, false);
        }
        Err(failure) => failure.error.into_usage("claude"),
    };
    result.source = Some(store.label().into());
    (result, false)
}

#[cfg(target_os = "macos")]
pub(crate) fn claude_service(config: Option<&str>, secure: Option<&str>) -> String {
    use sha2::{Digest, Sha256};
    // Claude hashes the raw NFC-normalized config string, without resolving
    // symlinks, expanding ~, or removing a trailing slash. The secure-storage
    // override takes precedence, including an explicitly empty override.
    let Some(scope) = secure.or(config).filter(|s| !s.is_empty()) else {
        return "Claude Code-credentials".into();
    };
    let normalized = objc2_foundation::NSString::from_str(scope)
        .precomposedStringWithCanonicalMapping()
        .to_string();
    let hash = format!("{:x}", Sha256::digest(normalized));
    format!("Claude Code-credentials-{}", &hash[..8])
}


#[path = "agent_usage_claude_cli.rs"]
mod cli;
#[path = "agent_usage_claude_run.rs"]
mod run;
use run::ask_claude;
pub(crate) use cli::{asking_for, note_check, saved_for};

#[path = "agent_usage_claude_connection.rs"]
mod connection;
pub(crate) use connection::{managed_sets, managed_settings_paths, oauth_token, override_source, with_managed, OverrideFrom, OAUTH_TOKEN_VARIABLE};
#[cfg(test)]
pub(crate) use connection::claude_override;

#[path = "agent_usage_claude_setup.rs"]
mod setup;
pub(crate) use setup::{fetch_claude, late, owner_now};

#[cfg(test)]
#[path = "agent_usage_claude_tests.rs"]
mod tests;
