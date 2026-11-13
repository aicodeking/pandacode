//! Subscription limits. Credentials and provider responses never cross IPC.
//! Limits are only read; no credential is ever written. For an expired Claude
//! Code login, PandaCode may run Claude Code itself to refresh it
//! (`agent_usage_claude_cli.rs`).

use crate::account_config::var;
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    future::Future,
    hash::{BuildHasher, Hash, Hasher},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, OnceLock, PoisonError,
    },
    time::{Duration, Instant},
};
use tokio::sync::{Mutex, Semaphore};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Usage {
    pub provider: String,
    pub status: String,
    pub windows: Vec<UsageWindow>,
    pub plan: Option<String>,
    pub email: Option<String>,
    pub message: Option<String>,
    pub checked_at: u64,
    pub stale: bool,
    pub source: Option<String>,
    pub dashboard_url: Option<String>,
    /// When a Refresh may ask a rate-limited service again (ms since the epoch).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_at: Option<u64>,
    /// When an automatic check (opening the panel) will ask it again.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_retry_at: Option<u64>,
    /// What fixes an error, when known: `refresh` (press Refresh: a Keychain
    /// latch or a timeout), `retry` (a passing problem: try again later),
    /// `claude` (open Claude Code), `unlock` (unlock the Keychain),
    /// `rateLimited` (wait, then Refresh), `apiConnection` (Claude uses an
    /// API key or other connection), `updateClaude` (Claude Code too old to
    /// refresh its login on request), `expired` (an expired login), `settings`
    /// (expired, and running Claude Code is turned off).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action: Option<&'static str>,
    /// A manual Refresh may ask again at once (a Keychain latch or a timeout,
    /// which the Refresh itself lifts); never sent.
    #[serde(skip)]
    pub refresh_now: bool,
    /// Whose reading this is (Claude: profile key, account hint); never sent.
    #[serde(skip)]
    pub owner: Option<(String, Option<String>)>,
    /// Which Claude message this is, for decisions (never the text); never sent.
    #[serde(skip)]
    pub cause: Option<crate::agent_usage_claude::Cause>,
}

impl Usage {
    pub(crate) fn empty(provider: &str, status: &str, message: &str) -> Self {
        Self {
            provider: provider.into(),
            status: status.into(),
            windows: Vec::new(),
            plan: None,
            email: None,
            message: (!message.is_empty()).then(|| message.into()),
            checked_at: crate::storage::now().max(0) as u64,
            stale: false,
            source: None,
            dashboard_url: None,
            retry_at: None,
            auto_retry_at: None,
            action: None,
            refresh_now: false,
            owner: None,
            cause: None,
        }
    }

    /// This (earlier) reading standing in for `failed`, marked stale: it
    /// carries the failure's message, fix, times and `cause`, so the cache
    /// treats it as that failure (a "still running" answer is never kept).
    pub(crate) fn standing_in_for(mut self, failed: &Usage) -> Self {
        self.stale = true;
        self.message = failed.message.clone();
        self.retry_at = failed.retry_at;
        self.auto_retry_at = failed.auto_retry_at;
        self.refresh_now = failed.refresh_now;
        self.action = failed.action;
        self.cause = failed.cause;
        self
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UsageWindow {
    pub label: String,
    pub used_percent: f64,
    pub resets_at: Option<String>,
    pub detail: Option<String>,
}
impl UsageWindow {
    pub(crate) fn new(label: impl Into<String>, used: f64, resets: Option<String>) -> Self {
        Self {
            label: label.into(),
            used_percent: used,
            resets_at: resets,
            detail: None,
        }
    }
}

pub(crate) fn percentage(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .filter(|v| v.is_finite())
        .map(|v| v.clamp(0.0, 100.0))
}

pub(crate) fn plan_name(value: &str) -> Option<String> {
    Some(
        match value {
            "free" => "Free",
            "plus" => "Plus",
            "pro" => "Pro",
            "max" => "Max",
            "team" => "Team",
            "business" => "Business",
            "enterprise" => "Enterprise",
            "edu" => "Edu",
            "go" => "Go",
            _ => return None,
        }
        .into(),
    )
}

pub(crate) fn text_field(value: &Value, max: usize) -> Option<String> {
    value
        .as_str()
        .map(|s| {
            s.chars()
                .filter(|c| !c.is_control())
                .take(max)
                .collect::<String>()
        })
        .filter(|s| !s.trim().is_empty())
}

fn codex_usage(account: &Value, limits: &Value) -> Usage {
    let mut result = Usage::empty(
        "codex",
        "unavailable",
        "Codex did not report subscription usage limits.",
    );
    result.source = Some("Codex account service".into());
    result.dashboard_url = Some("https://chatgpt.com/codex/settings/usage".into());
    match account["account"]["type"].as_str() {
        Some("chatgpt") => {}
        Some("apiKey" | "amazonBedrock") => {
            result.message = Some(
                "Codex is using API credentials. ChatGPT subscription limits do not apply.".into(),
            );
            return result;
        }
        _ => {
            result.status = "signedOut".into();
            result.message = Some("Sign in to Codex to view subscription usage.".into());
            return result;
        }
    }
    result.plan = account["account"]["planType"].as_str().and_then(plan_name);
    result.email = crate::account_identity::clean(&account["account"]["email"]);
    let mut add = |bucket: &Value| {
        let name = text_field(&bucket["limitName"], 64).unwrap_or_else(|| "Codex".into());
        for (key, fallback) in [
            ("primary", "Primary window"),
            ("secondary", "Secondary window"),
        ] {
            let window = &bucket[key];
            let Some(used) = percentage(&window["usedPercent"]) else {
                continue;
            };
            let duration = match window["windowDurationMins"].as_u64().filter(|n| *n > 0) {
                Some(10080) => "Weekly".into(),
                Some(n) if n % 1440 == 0 => format!("{} days", n / 1440),
                Some(n) if n % 60 == 0 => format!("{} hours", n / 60),
                Some(n) => format!("{n} minutes"),
                None => fallback.into(),
            };
            result.windows.push(UsageWindow::new(
                format!("{name} · {duration}"),
                used,
                window["resetsAt"]
                    .as_i64()
                    .and_then(crate::agent_usage_providers::epoch_iso),
            ));
        }
    };
    if let Some(buckets) = limits["rateLimitsByLimitId"]
        .as_object()
        .filter(|b| !b.is_empty())
    {
        for bucket in buckets.values().take(16) {
            add(bucket);
        }
    } else {
        add(&limits["rateLimits"]);
    }
    if !result.windows.is_empty() {
        result.status = "ready".into();
        result.message = None;
    }
    result
}

fn codex_limits(account: &Value, limits: Result<Value, String>) -> Usage {
    match limits {
        Ok(limits) => codex_usage(account, &limits),
        Err(_) => {
            let mut result = codex_usage(account, &Value::Null);
            result.status = "error".into();
            result.message = Some("Codex could not read subscription limits. Check its sign-in status and refresh.".into());
            result
        }
    }
}

pub(crate) fn reset_string(value: &Value) -> Option<String> {
    value
        .as_str()
        .filter(|s| {
            s.len() >= 20
                && s.len() <= 40
                && s.as_bytes().get(4) == Some(&b'-')
                && s.chars()
                    .all(|c| c.is_ascii_digit() || matches!(c, '-' | ':' | '.' | 'T' | 'Z' | '+'))
        })
        .map(str::to_owned)
}

pub(crate) enum FetchError {
    Http(u16),
    Unavailable,
    Invalid,
}
impl FetchError {
    pub(crate) fn into_usage(self, provider: &str) -> Usage {
        let (status, message) = match self {
            Self::Http(401) => (
                "signedOut",
                "The saved login has expired or was rejected. Sign in using the agent and refresh.",
            ),
            Self::Http(403) => (
                "unavailable",
                "This account does not allow access to subscription usage limits.",
            ),
            Self::Http(429) => (
                "error",
                "The usage service is rate limited. Try again later.",
            ),
            Self::Http(_) | Self::Unavailable => (
                "error",
                "The usage service could not be reached. Try again later.",
            ),
            Self::Invalid => (
                "error",
                "The usage service returned an unreadable response.",
            ),
        };
        Usage::empty(provider, status, message)
    }
}

pub(crate) fn http_client() -> Result<reqwest::Client, FetchError> {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    reqwest::Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(12))
        .user_agent(concat!("PandaCode/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|_| FetchError::Unavailable)
}

/// One bounded HTTPS exchange: the status, a `Retry-After` header and the
/// JSON body when there is one. Error bodies are read too (OAuth errors carry
/// their code there); an oversized successful body is `Invalid`.
pub(crate) struct Reply {
    pub status: u16,
    pub retry_after: Option<String>,
    pub body: Option<Value>,
}

pub(crate) async fn exchange(request: reqwest::RequestBuilder) -> Result<Reply, FetchError> {
    const LIMIT: usize = 256 * 1024;
    let mut response = request.send().await.map_err(|_| FetchError::Unavailable)?;
    let status = response.status().as_u16();
    let success = response.status().is_success();
    let retry_after = response
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .filter(|value| value.len() <= 64)
        .map(str::to_owned);
    let mut bytes = Vec::new();
    let mut oversized = response.content_length().is_some_and(|n| n > LIMIT as u64);
    while !oversized {
        let Some(chunk) = response.chunk().await.map_err(|_| FetchError::Unavailable)? else {
            break;
        };
        oversized = bytes.len() + chunk.len() > LIMIT;
        if !oversized {
            bytes.extend_from_slice(&chunk);
        }
    }
    if oversized && success {
        bytes.fill(0);
        return Err(FetchError::Invalid);
    }
    let body = (!oversized).then(|| serde_json::from_slice(&bytes).ok()).flatten();
    bytes.fill(0);
    Ok(Reply { status, retry_after, body })
}

pub(crate) async fn request_json(request: reqwest::RequestBuilder) -> Result<Value, FetchError> {
    let reply = exchange(request).await?;
    if !(200..300).contains(&reply.status) {
        return Err(FetchError::Http(reply.status));
    }
    reply.body.ok_or(FetchError::Invalid)
}

#[derive(Default)]
struct Entry {
    result: Option<Usage>,
    attempted_at: Option<Instant>,
    generation: u64,
    provenance: Option<u64>,
}

#[derive(Default)]
pub(crate) struct CacheSlot {
    entry: Mutex<Entry>,
    generation: AtomicU64,
}

fn cache() -> &'static HashMap<&'static str, CacheSlot> {
    static CACHE: OnceLock<HashMap<&'static str, CacheSlot>> = OnceLock::new();
    CACHE.get_or_init(|| {
        [
            "codex",
            "claude",
            "kimi",
            "glm",
            "opencode",
            "antigravity",
            "grok",
            "mimo",
            "alibaba",
            "pi",
            "deepseek",
            "commandcode",
            "cline",
            "kilo",
            "omp",
            "github-copilot",
            "muse",
            "devin",
            "zcode",
            "hermes",
        ]
        .into_iter()
        .map(|id| (id, CacheSlot::default()))
        .collect()
    })
}

pub(crate) fn invalidate(provider: &str) {
    if let Some(slot) = cache().get(provider) {
        slot.generation.fetch_add(1, Ordering::SeqCst);
    }
}

/// Like `invalidate`, and also every named connection's cached reading.
pub(crate) fn invalidate_all(provider: &str) {
    invalidate(provider);
    for slot in connection_slots().values() {
        slot.generation.fetch_add(1, Ordering::SeqCst);
    }
}

/// The cache generations of `provider`'s default slot and of the named
/// connection slot `connection` (made if missing): any bump drops a reading.
#[cfg(test)]
pub(crate) fn generations(provider: &str, connection: &str) -> (u64, u64) {
    let default = cache().get(provider).map_or(0, |slot| slot.generation.load(Ordering::SeqCst));
    let named = connection_slots().entry(connection.into()).or_default().generation.load(Ordering::SeqCst);
    (default, named)
}

/// Cache slots of named connections, keyed by id and revision, so an edited
/// connection never shows the old account.
// ponytail: slots of deleted or edited connections stay until restart; tiny.
fn connection_slots() -> std::sync::MutexGuard<'static, HashMap<String, Arc<CacheSlot>>> {
    static SLOTS: OnceLock<std::sync::Mutex<HashMap<String, Arc<CacheSlot>>>> = OnceLock::new();
    SLOTS.get_or_init(Default::default).lock().unwrap_or_else(PoisonError::into_inner)
}

/// Which profile the Claude card for `setup` (`""` or a connection id) checks.
fn note_claude_check(setup: &str, owner: &Option<(String, Option<String>)>) {
    if let Some((key, account)) = owner {
        let dir = crate::secret_store::dir().map(std::path::Path::to_path_buf);
        crate::agent_usage_claude::note_check(setup, crate::agent_usage_claude_limits::Profile { key: key.clone(), account: account.clone(), dir });
    }
}

/// Whose Claude reading a check would give now (`None` for other providers).
async fn owner_now(provider: &str, env: &[(String, String)]) -> Option<(String, Option<String>)> {
    if provider != "claude" {
        return None;
    }
    crate::agent_usage_claude::owner_now(&crate::agent_usage_claude_env::ClaudeEnv::launch(env)).await
}

#[cfg(test)]
pub(crate) async fn cached<F, Fut, P, Stamp>(slot: &CacheSlot, refresh: bool, source: P, fetch: F) -> Usage
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Usage>,
    P: Fn() -> Stamp,
    Stamp: Future<Output = Option<u64>>,
{
    cached_for(slot, refresh, None, source, fetch).await
}

/// How soon a Refresh may ask a provider again: ten seconds, or at once when
/// the last answer asked to unlock the Keychain (`action: unlock`) or was a
/// Keychain latch or timeout that the Refresh itself lifts (`refresh_now`),
/// even when a saved reading stands in for it (status ready, stale).
const REFRESH_MINIMUM: Duration = Duration::from_secs(10);

/// Whether a manual Refresh skips the minimum for this last result.
fn refresh_fixes(result: &Usage) -> bool {
    result.refresh_now || result.action == Some("unlock")
}

/// `owner`: whose reading a check would give now (Claude); a cached reading
/// of another owner (an account switch or sign-out since) is never served.
/// `source`: the local provenance stamp (`provenance`); a change drops the
/// cached reading, and a change during the fetch discards its result, except
/// a Claude reading of the very owner the check began with: Claude Code
/// rewriting its own files while PandaCode runs it to refresh the login.
async fn cached_for<F, Fut, P, Stamp>(slot: &CacheSlot, refresh: bool, owner: Option<(String, Option<String>)>, source: P, fetch: F) -> Usage
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Usage>,
    P: Fn() -> Stamp,
    Stamp: Future<Output = Option<u64>>,
{
    // Holding the provider lock across the bounded fetch coalesces both opening
    // the dialog and rapid Refresh clicks. Other providers remain independent.
    let mut entry = slot.entry.lock().await;
    let provenance = source().await;
    let generation = slot.generation.load(Ordering::SeqCst);
    if entry.generation != generation || entry.provenance != provenance || provenance.is_none() {
        *entry = Entry {
            generation,
            provenance,
            ..Entry::default()
        };
    }
    let minimum = if entry.result.as_ref().is_some_and(refresh_fixes) { Duration::ZERO } else { REFRESH_MINIMUM };
    let ttl = if refresh { minimum } else { Duration::from_secs(60) };
    if entry.attempted_at.is_some_and(|at| at.elapsed() < ttl) {
        if let Some(result) = entry.result.as_ref().filter(|result| owner.is_none() || result.owner.is_none() || result.owner == owner) {
            return result.clone();
        }
    }
    let mut result = fetch().await;
    let current = source().await;
    let same_owner = owner.is_some() && result.owner == owner;
    let moved = current != provenance && !(same_owner && current.is_some());
    if provenance.is_none() || moved || slot.generation.load(Ordering::SeqCst) != generation {
        *entry = Entry::default();
        return Usage::empty(
            &result.provider,
            "unavailable",
            "The agent configuration changed. Refresh to check the current account.",
        );
    }
    if let Some(stale) = stand_in(&entry, &result) {
        result = stale;
    }
    // "Still refreshing" is never kept: reopening the panel asks again and
    // shows what the run saved.
    if result.cause == Some(crate::agent_usage_claude::Cause::StillRunning) {
        *entry = Entry { generation, ..Entry::default() };
        return result;
    }
    entry.provenance = current;
    entry.attempted_at = Some(Instant::now());
    entry.result = Some(result.clone());
    result
}

// This stamp is process-local and never serialized or logged. Protected-store-only
// external changes without a local signal are not observable here.
async fn provenance(provider: &str, connection: Option<&crate::connections::Connection>) -> Option<u64> {
    if !matches!(provider, "claude" | "codex") {
        return Some(0);
    }
    if let Some(connection) = connection {
        if crate::connections::get(&connection.id).is_none_or(|current| current.revision != connection.revision) {
            return None;
        }
    }
    let env = provenance_environment(provider, connection);
    let provider = provider.to_owned();
    tokio::task::spawn_blocking(move || local_provenance(&provider, &env)).await.ok()
}

fn provenance_environment(provider: &str, connection: Option<&crate::connections::Connection>) -> Vec<(String, String)> {
    let mut own = Vec::new();
    if let Some(connection) = connection {
        own.extend(connection.env.iter().map(|(name, value)| (name.clone(), value.clone())));
        // Opaque overrides suppress unrelated disk labels without reading protected storage.
        own.extend(connection.secret_env.iter().map(|name| (name.clone(), "<protected>".into())));
        if let Some(dir) = &connection.config_dir {
            own.push((if provider == "claude" { "CLAUDE_CONFIG_DIR" } else { "CODEX_HOME" }.into(), dir.clone()));
        }
    }
    crate::account_config::environment(provider, &own)
}

fn local_provenance(provider: &str, env: &[(String, String)]) -> u64 {
    static HASHER: OnceLock<std::collections::hash_map::RandomState> = OnceLock::new();
    let mut hash = HASHER.get_or_init(Default::default).build_hasher();
    provider.hash(&mut hash);
    env.hash(&mut hash);
    for name in [
        "HOME", "USERPROFILE", "CODEX_HOME", "CODEX_API_KEY", "OPENAI_API_KEY",
        "CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN",
        "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_CUSTOM_HEADERS",
        "ANTHROPIC_PROFILE", "ANTHROPIC_FEDERATION_RULE_ID", "ANTHROPIC_IDENTITY_TOKEN_FILE",
        "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "ANTHROPIC_BASE_URL",
    ] {
        var(env, name).hash(&mut hash);
    }
    let dir = crate::account_config::config_dir(provider, env);
    dir.hash(&mut hash);
    let identity = crate::account_identity::local(provider, env);
    identity.email.hash(&mut hash);
    identity.plan.hash(&mut hash);
    if let Some(dir) = dir {
        let files: &[&str] = if provider == "claude" {
            &[".config.json", ".credentials.json", "settings.json"]
        } else {
            &["auth.json", "config.toml"]
        };
        for file in files {
            file_state(&dir.join(file), &mut hash);
        }
        if provider == "claude" {
            crate::account_identity::claude_json(env).hash(&mut hash);
            if let Some(legacy) = crate::account_config::claude_legacy(env) {
                file_state(&legacy, &mut hash);
            }
        }
    }
    hash.finish()
}

fn file_state(path: &Path, hash: &mut impl Hasher) {
    path.hash(hash);
    match std::fs::metadata(path) {
        Ok(meta) => {
            true.hash(hash);
            (meta.is_file(), meta.len(), meta.modified().ok(), meta.created().ok()).hash(hash);
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                (meta.dev(), meta.ino(), meta.ctime(), meta.ctime_nsec()).hash(hash);
            }
        }
        Err(error) => {
            false.hash(hash);
            error.kind().hash(hash);
        }
    }
}

/// The earlier reading, marked stale and carrying the failure's message and
/// fix, when it may stand in for a failed one with nothing to show.
fn stand_in(entry: &Entry, failed: &Usage) -> Option<Usage> {
    if failed.status != "error" || !failed.windows.is_empty() {
        return None;
    }
    let prior = entry.result.as_ref().filter(|prior| !prior.windows.is_empty() && may_stand_in(prior, failed, entry.attempted_at))?;
    Some(prior.clone().standing_in_for(failed))
}

/// How old an in-memory Claude reading may be to stand in when its account
/// is unknown.
const UNKNOWN_ACCOUNT_STANDIN: Duration = Duration::from_secs(15 * 60);

/// Whether an earlier reading may stand in for a failed one. For Claude, only
/// one of the same profile and the same account (or, when no account is
/// known, one under 15 minutes old); its saved reading is tried first
/// (`agent_usage_claude_limits::or_saved`).
fn may_stand_in(prior: &Usage, failed: &Usage, at: Option<Instant>) -> bool {
    if failed.provider != "claude" {
        return true;
    }
    match (&prior.owner, &failed.owner) {
        (Some((key, hint)), Some((now_key, now_hint))) if key == now_key && hint == now_hint => {
            hint.is_some() || at.is_some_and(|at| at.elapsed() < UNKNOWN_ACCOUNT_STANDIN)
        }
        _ => false,
    }
}

/// A Claude card still checking: whether PandaCode is running Claude Code
/// for it ("Asking Claude Code…"), and its saved reading to show meanwhile.
#[derive(Serialize)]
pub(crate) struct ClaudeWaiting {
    pub asking: bool,
    pub saved: Option<Usage>,
}

/// The most setups one poll asks about (the panel's cards).
const WAITING_LIMIT: usize = 64;

/// For each Claude setup whose card is still checking (`""`: the global one,
/// else a connection id), one poll for all: whether PandaCode is running
/// Claude Code for it and its saved reading. Answered from the profile the
/// setup's last check noted: no login files, Keychain, connection secrets or
/// network per poll, only PandaCode's small saved-reading file.
#[tauri::command]
pub(crate) async fn agent_usage_asking_claude(window: tauri::WebviewWindow, connections: Vec<String>) -> crate::Result<HashMap<String, ClaudeWaiting>> {
    if window.label() != "main" {
        return Err("Usage limits are available only in the main application window.".into());
    }
    if connections.len() > WAITING_LIMIT || connections.iter().any(|id| id.len() > 200) {
        return Err("Too many usage cards to check.".into());
    }
    Ok(claude_waiting(connections).await)
}

/// `agent_usage_asking_claude` past its checks.
pub(crate) async fn claude_waiting(connections: Vec<String>) -> HashMap<String, ClaudeWaiting> {
    let mut answers = HashMap::new();
    for id in connections {
        let saved = crate::agent_usage_claude::saved_for(&id).await;
        let asking = asking_claude(Some(id.as_str()));
        answers.insert(id, ClaudeWaiting { asking, saved });
    }
    answers
}

/// `agent_usage_asking_claude` past its window check.
pub(crate) fn asking_claude(connection: Option<&str>) -> bool {
    crate::agent_usage_claude::asking_for(connection.unwrap_or_default())
}

/// `connection` reads one named connection through its own config folder and
/// environment; without it the global setup is read, as before.
#[tauri::command]
pub(crate) async fn agent_usage(
    window: tauri::WebviewWindow,
    provider: String,
    refresh: bool,
    connection: Option<String>,
) -> crate::Result<Usage> {
    if window.label() != "main" {
        return Err("Usage limits are available only in the main application window.".into());
    }
    match connection {
        Some(id) => connection_usage(provider, &id, refresh).await,
        None => query_usage(provider, refresh).await,
    }
}

pub(crate) async fn query_usage(provider: String, refresh: bool) -> crate::Result<Usage> {
    let slot = cache().get(provider.as_str()).ok_or("Unknown agent.")?;
    let owner = owner_now(&provider, &[]).await;
    note_claude_check("", &owner);
    let known = owner.clone();
    Ok(cached_for(slot, refresh, owner, || provenance(&provider, None), || bounded(&provider, &[], refresh, known)).await)
}

async fn connection_usage(provider: String, id: &str, refresh: bool) -> crate::Result<Usage> {
    let connection = crate::connections::get(id)
        .filter(|c| c.provider == provider)
        .ok_or("This connection no longer exists.")?;
    // Revisions select a fresh slot; local provenance also covers saved environment edits.
    let slot = connection_slots().entry(format!("{}#{}", connection.id, connection.revision)).or_default().clone();
    let name = connection.name.clone();
    let launched = connection.clone();
    let Ok(Ok(launch)) = tokio::task::spawn_blocking(move || crate::connections::launch(&launched)).await else {
        return Ok(Usage::empty(&provider, "unavailable", &format!("The saved values of “{name}” could not be read. Check the connection in Settings.")));
    };
    let owner = owner_now(&provider, &launch.env).await;
    note_claude_check(id, &owner);
    let known = owner.clone();
    Ok(cached_for(&slot, refresh, owner, || provenance(&provider, Some(&connection)), || async { bounded(&provider, &launch.env, refresh, known).await }).await)
}

/// The deadline for one provider's check, counted once it has a slot.
const CHECK_DEADLINE: Duration = Duration::from_secs(35);

/// `owner`: whose Claude reading this is, already worked out (`owner_now`).
async fn bounded(provider: &str, env: &[(String, String)], refresh: bool, owner: Option<(String, Option<String>)>) -> Usage {
    let late = async {
        if provider == "claude" {
            crate::agent_usage_claude::late(&crate::agent_usage_claude_env::ClaudeEnv::launch(env)).await
        } else {
            Usage::empty(provider, "error", "The usage check timed out. Try again later.")
        }
    };
    // A Claude check may run Claude Code (and, on a manual refresh, wait on a
    // Keychain dialog): its own deadline must end before this one, so no
    // result is lost.
    let deadline = match (provider, refresh) {
        ("claude", true) => crate::agent_usage_claude::MANUAL_DEADLINE + Duration::from_secs(5),
        ("claude", false) => crate::agent_usage_claude::DEADLINE + Duration::from_secs(5),
        _ => CHECK_DEADLINE,
    };
    bounded_with(provider, deadline, fetch_provider(provider, env, refresh, owner), late).await
}

/// At most three checks at once. The wait for a slot does not count toward
/// a check's deadline (each slot holder is bounded, so the wait is too). Past
/// the deadline the answer is `late`: for Claude, its saved reading.
async fn bounded_with(
    provider: &str,
    deadline: Duration,
    fetch: impl Future<Output = Usage>,
    late: impl Future<Output = Usage>,
) -> Usage {
    let Ok(permit) = LIMIT.acquire().await else {
        return FetchError::Unavailable.into_usage(provider);
    };
    match tokio::time::timeout(deadline, PERMIT.scope(std::cell::RefCell::new(Some(permit)), fetch)).await {
        Ok(result) => result,
        Err(_) => late.await,
    }
}

/// Runs `check` holding one shared slot, as `bounded_with` does (tests).
#[cfg(test)]
pub(crate) async fn with_slot<T>(check: impl Future<Output = T>) -> T {
    let permit = LIMIT.acquire().await.expect("slots");
    PERMIT.scope(std::cell::RefCell::new(Some(permit)), check).await
}

/// Whether the current check holds its shared slot (tests).
#[cfg(test)]
pub(crate) fn holds_slot() -> bool {
    PERMIT.try_with(|slot| slot.borrow().is_some()).unwrap_or(false)
}

/// The three shared check slots (`bounded_with`).
static LIMIT: Semaphore = Semaphore::const_new(3);

tokio::task_local! {
    /// The slot the current check holds, so it can give it up while it waits.
    static PERMIT: std::cell::RefCell<Option<tokio::sync::SemaphorePermit<'static>>>;
}

/// Runs `wait` without holding the current check's shared slot (a Claude
/// check waiting on a run of Claude Code), so other providers' cards don't
/// wait behind it; the slot is taken back afterwards. Outside a bounded check
/// it just runs `wait`.
pub(crate) async fn without_slot<T>(wait: impl Future<Output = T>) -> T {
    let held = PERMIT.try_with(|slot| slot.borrow_mut().take().is_some()).unwrap_or(false);
    let result = wait.await;
    if held {
        if let Ok(permit) = LIMIT.acquire().await {
            let _ = PERMIT.try_with(|slot| *slot.borrow_mut() = Some(permit));
        }
    }
    result
}

async fn fetch_provider(provider: &str, env: &[(String, String)], refresh: bool, owner: Option<(String, Option<String>)>) -> Usage {
    let effective = crate::account_config::environment(provider, env);
    let mut result = match provider {
        "codex" => fetch_codex(&effective).await,
        "claude" => {
            let env = crate::agent_usage_claude_env::ClaudeEnv::launch(env);
            crate::agent_usage_claude::fetch_claude(&env, refresh, owner).await
        }
        _ if !env.is_empty() => Usage::empty(provider, "unsupported", "Limits are read for each Claude Code and Codex connection. This harness's limits are shown for its global setup only."),
        "kimi" | "glm" | "opencode" | "antigravity" | "deepseek" => {
            crate::agent_usage_providers::fetch(provider).await
        }
        "grok" => Usage::empty(provider, "unsupported", "Grok does not expose subscription usage through this agent. Check your account dashboard."),
        "mimo" => Usage::empty(provider, "unsupported", "MiMo does not expose account limits through this agent. View your Token Plan dashboard."),
        "alibaba" => Usage::empty(provider, "unsupported", "Alibaba Token Plan does not expose plan usage through this agent. Check your Model Studio subscription page."),
        "omp" => Usage::empty(provider, "unsupported", "omp uses the model provider you configured for it. Check that provider's dashboard for limits."),
        "pi" => Usage::empty(provider, "unsupported", "Pi uses the model provider you configured for it. Check that provider's dashboard for limits."),
        "commandcode" => Usage::empty(provider, "unsupported", "Command Code does not expose credits or limits through this agent. Check Command Code Studio."),
        "cline" => Usage::empty(provider, "unsupported", "Cline does not expose credits or limits through this agent. Check your Cline account."),
        "kilo" => Usage::empty(provider, "unsupported", "Kilo Code does not expose credits or limits through this agent. Check your Kilo account or the model provider's dashboard."),
        "github-copilot" => Usage::empty(provider, "unsupported", "GitHub Copilot CLI does not expose usage limits through this agent. Check your GitHub Copilot settings."),
        "muse" => Usage::empty(provider, "unsupported", "Muse Code reports its usage windows only inside a running session. Check them with /usage in Muse Code."),
        "devin" => Usage::empty(provider, "unsupported", "Devin does not expose plan limits through its ACP server. Check usage in your Devin account settings."),
        "zcode" => Usage::empty(provider, "unsupported", "ZCode does not expose plan usage. Check usage in ZCode itself."),
        "hermes" => Usage::empty(provider, "unsupported", "Hermes Agent does not expose usage limits through its ACP server. Check your LLM provider's dashboard."),
        _ => Usage::empty(provider, "unsupported", "Usage limits are not available for this agent."),
    };
    if provider == "claude" && result.status != "signedOut" {
        let identity = tokio::task::spawn_blocking(move || crate::account_identity::local("claude", &effective)).await.unwrap_or_default();
        result.email = identity.email;
        if result.plan.is_none() { result.plan = identity.plan; }
    }
    if result.dashboard_url.is_none() {
        result.dashboard_url = match provider {
            "codex" => Some("https://chatgpt.com/codex/settings/usage"),
            "claude" => Some("https://claude.ai/settings/usage"),
            "grok" => Some("https://grok.com"),
            "mimo" => Some("https://platform.xiaomimimo.com/token-plan"),
            "alibaba" => Some("https://modelstudio.console.alibabacloud.com/subscription/token-plan"),
            "deepseek" => Some("https://platform.deepseek.com/usage"),
            "commandcode" => Some("https://commandcode.ai/studio"),
            "cline" => Some("https://app.cline.bot"),
            "kilo" => Some("https://app.kilo.ai"),
            _ => None,
        }
        .map(str::to_owned);
    }
    result
}

async fn fetch_codex(env: &[(String, String)]) -> Usage {
    let cwd = crate::account_config::home(env).unwrap_or_else(std::env::temp_dir);
    let Ok(mut client) = crate::integrations::ControlClient::start_with_env(&cwd, env).await else {
        return Usage::empty("codex", "error", "Codex usage is unavailable. Check that its CLI is installed and signed in, then refresh.");
    };
    let result = match client
        .request("account/read", json!({"refreshToken":false}))
        .await
    {
        Ok(account) if account["account"]["type"] == "chatgpt" => {
            // New Codex versions can omit reset-credit details, which this view
            // does not use. Older versions ignore this additional optional key.
            codex_limits(&account, client.request("account/rateLimits/read", json!({"excludeResetCreditDetails":true})).await)
        }
        Ok(account) => codex_usage(&account, &Value::Null),
        Err(_) => Usage::empty(
            "codex",
            "error",
            "Codex could not read the current account. Check its sign-in status and refresh.",
        ),
    };
    // Explicit cleanup on every completed request path. ControlClient's Drop
    // guard also kills/reaps the process if the outer deadline cancels us.
    client.finish().await;
    result
}

/// Claude's config folder resolved as Claude is launched (saved provider
/// variables, then this process's: `ClaudeEnv`), so cost estimates
/// (`usage_ledger`) read the same folder the limits do.
pub(crate) fn claude_config_dir() -> Option<PathBuf> {
    crate::agent_usage_claude_env::ClaudeEnv::launch(&[]).config_dir()
}

/// For tests elsewhere: a fresh cache slot (see `cached`).
#[cfg(test)]
pub(crate) fn tests_slot() -> CacheSlot {
    CacheSlot::default()
}

#[cfg(test)]
#[path = "agent_usage_tests.rs"]
mod tests;
