//! Read-only subscription limits. Credentials and provider responses never cross IPC.

use crate::account_config::var;
use serde::{Deserialize, Serialize};
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
        }
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

fn percentage(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .filter(|v| v.is_finite())
        .map(|v| v.clamp(0.0, 100.0))
}

fn plan_name(value: &str) -> Option<String> {
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

fn text_field(value: &Value, max: usize) -> Option<String> {
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

fn claude_usage(value: &Value, plan: Option<String>) -> Usage {
    let mut result = Usage::empty(
        "claude",
        "unavailable",
        "Claude did not report subscription usage limits.",
    );
    result.plan = plan;
    result.source = Some("Claude OAuth usage".into());
    result.dashboard_url = Some("https://claude.ai/settings/usage".into());
    for (key, label) in [
        ("five_hour", "5 hours"),
        ("seven_day", "Weekly"),
        ("seven_day_opus", "Weekly · Opus"),
        ("seven_day_sonnet", "Weekly · Sonnet"),
        ("seven_day_oauth_apps", "Weekly · OAuth apps"),
    ] {
        let window = &value[key];
        if let Some(used) = percentage(&window["utilization"]) {
            result.windows.push(UsageWindow::new(
                label,
                used,
                reset_string(&window["resets_at"]),
            ));
        }
    }
    for window in value["limits"].as_array().into_iter().flatten().take(16) {
        if window["kind"] != "weekly_scoped" || window["is_active"] == false {
            continue;
        }
        let Some(used) = percentage(&window["percent"]) else {
            continue;
        };
        let Some(model) = text_field(&window["scope"]["model"]["display_name"], 64) else {
            continue;
        };
        let label = format!("Weekly · {model}");
        if !result
            .windows
            .iter()
            .any(|existing| existing.label == label)
        {
            result.windows.push(UsageWindow::new(
                label,
                used,
                reset_string(&window["resets_at"]),
            ));
        }
    }
    if value["extra_usage"]["is_enabled"] == true {
        if let Some(used) = percentage(&value["extra_usage"]["utilization"]) {
            result
                .windows
                .push(UsageWindow::new("Extra usage budget", used, None));
        }
    }
    if !result.windows.is_empty() {
        result.status = "ready".into();
        result.message = None;
    }
    result
}

fn reset_string(value: &Value) -> Option<String> {
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

pub(crate) async fn request_json(request: reqwest::RequestBuilder) -> Result<Value, FetchError> {
    let mut response = request.send().await.map_err(|_| FetchError::Unavailable)?;
    if !response.status().is_success() {
        return Err(FetchError::Http(response.status().as_u16()));
    }
    const LIMIT: usize = 256 * 1024;
    if response.content_length().is_some_and(|n| n > LIMIT as u64) {
        return Err(FetchError::Invalid);
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| FetchError::Unavailable)?
    {
        if bytes.len() + chunk.len() > LIMIT {
            return Err(FetchError::Invalid);
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| FetchError::Invalid)
}

#[derive(Default)]
struct Entry {
    result: Option<Usage>,
    attempted_at: Option<Instant>,
    generation: u64,
    provenance: Option<u64>,
}

#[derive(Default)]
struct CacheSlot {
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

async fn cached<F, Fut, P, Stamp>(slot: &CacheSlot, refresh: bool, source: P, fetch: F) -> Usage
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
    let ttl = Duration::from_secs(if refresh { 10 } else { 60 });
    if entry.attempted_at.is_some_and(|at| at.elapsed() < ttl) {
        if let Some(result) = &entry.result {
            return result.clone();
        }
    }
    let mut result = fetch().await;
    let current = source().await;
    if provenance.is_none() || current != provenance || slot.generation.load(Ordering::SeqCst) != generation {
        *entry = Entry::default();
        return Usage::empty(
            &result.provider,
            "unavailable",
            "The agent configuration changed. Refresh to check the current account.",
        );
    }
    if result.status == "error" {
        if let Some(prior) = &entry.result {
            if !prior.windows.is_empty() {
                let mut stale = prior.clone();
                stale.stale = true;
                stale.message = result.message;
                result = stale;
            }
        }
    }
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

struct ClaudeCredential {
    token: String,
    plan: Option<String>,
}
fn unreadable_claude_login() -> Box<Usage> {
    Box::new(Usage::empty("claude", "unavailable", "No readable Claude login was found. Open Claude Code to verify its sign-in or unlock protected storage, or view usage in your Claude account."))
}

fn parse_claude_credential(bytes: &[u8], now: u64) -> Result<ClaudeCredential, Box<Usage>> {
    // Deserialize only the documented fields. In particular refresh tokens,
    // account identities, and unrelated provider credentials are ignored.
    #[derive(Deserialize)]
    struct File {
        #[serde(rename = "claudeAiOauth")]
        oauth: Option<OAuth>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct OAuth {
        access_token: String,
        expires_at: Option<u64>,
        scopes: Option<Vec<String>>,
        subscription_type: Option<String>,
    }
    let missing = unreadable_claude_login;
    if bytes.len() > 256 * 1024 {
        return Err(missing());
    }
    let oauth = serde_json::from_slice::<File>(bytes)
        .ok()
        .and_then(|file| file.oauth)
        .ok_or_else(missing)?;
    if oauth.access_token.is_empty()
        || oauth.access_token.len() > 16 * 1024
        || !oauth.access_token.bytes().all(|b| b.is_ascii_graphic())
    {
        return Err(missing());
    }
    if oauth.expires_at.is_some_and(|expiry| expiry <= now) {
        return Err(Box::new(Usage::empty(
            "claude",
            "signedOut",
            "The saved Claude login has expired. Open Claude Code to sign in again, then refresh.",
        )));
    }
    if !oauth
        .scopes
        .as_ref()
        .is_some_and(|scopes| scopes.iter().any(|scope| scope == "user:profile"))
    {
        return Err(Box::new(Usage::empty("claude", "unavailable", "This Claude credential cannot read subscription usage. Sign in with Claude Code instead of an inference-only setup token.")));
    }
    Ok(ClaudeCredential {
        token: oauth.access_token,
        plan: oauth.subscription_type.as_deref().and_then(plan_name),
    })
}

pub(crate) fn claude_override(inherit: bool, env: impl Fn(&str) -> Option<String>, settings: &Value) -> bool {
    // Settings apply to the CLI even when PandaCode strips inherited credential
    // environment variables. Helpers are detected, never executed here.
    if settings["apiKeyHelper"]
        .as_str()
        .is_some_and(|s| !s.trim().is_empty())
    {
        return true;
    }
    let connection = |env: &dyn Fn(&str) -> Option<String>| {
        let present = |name| env(name).is_some_and(|s| !s.trim().is_empty());
        let enabled = |name| {
            env(name).is_some_and(|s| {
                !matches!(s.trim().to_ascii_lowercase().as_str(), "" | "0" | "false")
            })
        };
        [
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_AUTH_TOKEN",
            "ANTHROPIC_CUSTOM_HEADERS",
            "CLAUDE_CODE_OAUTH_TOKEN",
            "ANTHROPIC_PROFILE",
            "ANTHROPIC_FEDERATION_RULE_ID",
            "ANTHROPIC_IDENTITY_TOKEN_FILE",
        ]
        .iter()
        .any(|key| present(key))
            || [
                "CLAUDE_CODE_USE_BEDROCK",
                "CLAUDE_CODE_USE_VERTEX",
                "CLAUDE_CODE_USE_FOUNDRY",
            ]
            .iter()
            .any(|key| enabled(key))
            || env("ANTHROPIC_BASE_URL").is_some_and(|s| {
                !matches!(
                    s.trim(),
                    "" | "https://api.anthropic.com" | "https://api.anthropic.com/"
                )
            })
    };
    connection(&|name| settings["env"][name].as_str().map(str::to_owned))
        || inherit && connection(&env)
}

#[cfg(target_os = "macos")]
fn claude_service(config: Option<&str>, secure: Option<&str>) -> String {
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
    Ok(cached(slot, refresh, || provenance(&provider, None), || bounded(&provider, &[])).await)
}

async fn connection_usage(provider: String, id: &str, refresh: bool) -> crate::Result<Usage> {
    let connection = crate::connections::get(id)
        .filter(|c| c.provider == provider)
        .ok_or("This connection no longer exists.")?;
    // Revisions select a fresh slot; local provenance also covers saved environment edits.
    // ponytail: slots of deleted or edited connections stay until restart; tiny.
    static SLOTS: OnceLock<std::sync::Mutex<HashMap<String, Arc<CacheSlot>>>> = OnceLock::new();
    let slot = SLOTS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .entry(format!("{}#{}", connection.id, connection.revision))
        .or_default()
        .clone();
    let fetch_connection = connection.clone();
    Ok(cached(&slot, refresh, || provenance(&provider, Some(&connection)), || async {
        let name = fetch_connection.name.clone();
        match tokio::task::spawn_blocking(move || crate::connections::launch(&fetch_connection)).await {
            Ok(Ok(launch)) => bounded(&provider, &launch.env).await,
            _ => Usage::empty(&provider, "unavailable", &format!("The saved values of “{name}” could not be read. Check the connection in Settings.")),
        }
    })
    .await)
}

async fn bounded(provider: &str, env: &[(String, String)]) -> Usage {
    static LIMIT: Semaphore = Semaphore::const_new(3);
    tokio::time::timeout(Duration::from_secs(35), async {
        let Ok(_permit) = LIMIT.acquire().await else {
            return FetchError::Unavailable.into_usage(provider);
        };
        fetch_provider(provider, env).await
    })
    .await
    .unwrap_or_else(|_| {
        Usage::empty(
            provider,
            "error",
            "The usage check timed out. Try again later.",
        )
    })
}

async fn fetch_provider(provider: &str, env: &[(String, String)]) -> Usage {
    let effective = crate::account_config::environment(provider, env);
    let mut result = match provider {
        "codex" => fetch_codex(&effective).await,
        "claude" => fetch_claude(&effective).await,
        _ if !env.is_empty() => Usage::empty(provider, "unsupported", "Limits are read for each Claude Code and Codex connection. This harness's limits are shown for its global setup only."),
        "kimi" | "glm" | "opencode" | "antigravity" | "deepseek" => {
            crate::agent_usage_providers::fetch(provider).await
        }
        "grok" => Usage::empty(provider, "unsupported", "Grok does not expose subscription usage through this agent. Check your account dashboard."),
        "mimo" => Usage::empty(provider, "unsupported", "MiMo does not expose account limits through this agent. View your Token Plan dashboard."),
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

pub(crate) fn claude_config_dir() -> Option<PathBuf> {
    claude_config_dir_in(&crate::account_config::environment("claude", &[]))
}

fn claude_config_dir_in(env: &[(String, String)]) -> Option<PathBuf> {
    crate::account_config::config_dir("claude", env)
}

async fn fetch_claude(env: &[(String, String)]) -> Usage {
    let Some(config) = claude_config_dir_in(env) else {
        return Usage::empty("claude", "unavailable", "Claude's configuration directory could not be determined. Use an absolute CLAUDE_CONFIG_DIR path.");
    };
    let settings = match crate::agent_usage_providers::credential_bytes(&config.join("settings.json")).await {
        Ok(Some(mut bytes)) => { let parsed = serde_json::from_slice::<Value>(&bytes); bytes.fill(0); match parsed {
            Ok(value) => value,
            Err(_) => return Usage::empty("claude", "unavailable", "Claude's settings could not be read. Check its configuration before viewing subscription usage."),
        } },
        Ok(None) => Value::Null,
        Err(_) => return Usage::empty("claude", "unavailable", "Claude's settings could not be read. Check its configuration before viewing subscription usage."),
    };
    if claude_override(
        true,
        |name| var(env, name),
        &settings,
    ) {
        return Usage::empty("claude", "unavailable", "Claude is configured with an API key, custom endpoint, or environment credentials. Saved Claude subscription limits do not describe that connection.");
    }
    let (credential, source) = match read_claude_credential(&config, env).await {
        Ok(value) => value,
        Err(result) => return *result,
    };
    let client = match http_client() {
        Ok(client) => client,
        Err(error) => return error.into_usage("claude"),
    };
    // Fixed first-party endpoint; redirect following is disabled. Neither the
    // refresh token nor a response body is forwarded to the webview or logged.
    let response = request_json(
        client
            .get("https://api.anthropic.com/api/oauth/usage")
            .bearer_auth(&credential.token)
            .header("anthropic-beta", "oauth-2025-04-20")
            .header("Accept", "application/json"),
    )
    .await;
    let mut result = match response {
        Ok(value) => claude_usage(&value, credential.plan),
        Err(error) => error.into_usage("claude"),
    };
    result.source = Some(source.into());
    result
}

async fn read_claude_credential(
    config: &Path,
    env: &[(String, String)],
) -> Result<(ClaudeCredential, &'static str), Box<Usage>> {
    let unavailable = unreadable_claude_login;
    #[cfg(not(target_os = "macos"))]
    let _ = env;
    #[cfg(target_os = "macos")]
    {
        let service = claude_service(
            var(env, "CLAUDE_CONFIG_DIR").as_deref(),
            var(env, "CLAUDE_SECURESTORAGE_CONFIG_DIR").as_deref(),
        );
        let keychain =
            tokio::task::spawn_blocking(move || crate::usage_keychain::read_claude(&service)).await;
        match keychain {
            Ok(Ok(Some(mut bytes))) => {
                let result = parse_claude_credential(&bytes, crate::storage::now().max(0) as u64);
                bytes.fill(0);
                return result.map(|credential| (credential, "Claude Code login · Keychain"));
            }
            Ok(Ok(None)) => {}
            _ => return Err(unavailable()),
        }
    }
    let mut bytes =
        crate::agent_usage_providers::credential_bytes(&config.join(".credentials.json"))
            .await
            .map_err(|_| unavailable())?
            .ok_or_else(unavailable)?;
    let result = parse_claude_credential(&bytes, crate::storage::now().max(0) as u64);
    bytes.fill(0);
    result.map(|credential| (credential, "Claude Code login · local credential file"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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
        assert!(key.email.is_none());
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
        assert_eq!(result.windows.len(), 2);
        assert_eq!(result.windows[0].used_percent, 24.5);
        assert_eq!(result.windows[1].used_percent, 100.0);
        assert!(!serde_json::to_string(&result).unwrap().contains("SECRET"));
        assert_eq!(
            claude_usage(&json!({"five_hour":null}), None).status,
            "unavailable"
        );
    }

    #[test]
    fn claude_credentials_require_profile_scope_and_valid_access_token() {
        let credential = |expires, scopes| {
            serde_json::to_vec(&json!({"claudeAiOauth":{
            "accessToken":"synthetic-token", "refreshToken":"NEVER_RETURN", "expiresAt":expires,
            "scopes":scopes, "subscriptionType":"max"}}))
            .unwrap()
        };
        let valid = parse_claude_credential(
            &credential(9000, json!(["user:profile", "user:inference"])),
            1000,
        );
        assert!(valid.is_ok());
        let valid = valid.ok().unwrap();
        assert_eq!(valid.token, "synthetic-token");
        assert_eq!(valid.plan.as_deref(), Some("Max"));
        assert_eq!(
            parse_claude_credential(&credential(1000, json!(["user:profile"])), 1000)
                .err()
                .unwrap()
                .status,
            "signedOut"
        );
        assert_eq!(
            parse_claude_credential(&credential(9000, json!(["user:inference"])), 1000)
                .err()
                .unwrap()
                .status,
            "unavailable"
        );
    }

    #[test]
    fn unreadable_login_does_not_claim_claude_is_signed_out() {
        for bytes in [b"{}".as_slice(), b"invalid-json".as_slice()] {
            assert_eq!(
                parse_claude_credential(bytes, 1000).err().unwrap().status,
                "unavailable"
            );
        }
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
        let login = LocalLogin::new("claude", true);
        let fetch = || async {
            count.fetch_add(1, Ordering::SeqCst);
            tokio::task::yield_now().await;
            Usage::empty("claude", "ready", "")
        };
        let (first, second) =
            tokio::join!(cached(&entry, false, || login.stamp(), fetch), cached(&entry, true, || login.stamp(), fetch));
        assert_eq!(count.load(Ordering::SeqCst), 1);
        assert_eq!(first.checked_at, second.checked_at);
    }

    #[tokio::test]
    async fn failed_refresh_preserves_prior_windows_but_signout_clears_them() {
        let entry = CacheSlot {
            entry: Mutex::new(Entry {
                result: Some(claude_usage(&json!({"five_hour":{"utilization":4}}), None)),
                attempted_at: Some(Instant::now() - Duration::from_secs(61)),
                generation: 0,
                provenance: Some(0),
            }),
            generation: AtomicU64::new(0),
        };
        let prior = entry.entry.lock().await.result.as_ref().unwrap().checked_at;
        let failed = cached(&entry, true, || async { Some(0) }, || async {
            FetchError::Unavailable.into_usage("claude")
        })
        .await;
        assert!(failed.stale);
        assert_eq!(failed.windows[0].used_percent, 4.0);
        assert_eq!(failed.checked_at, prior);
        entry.entry.lock().await.attempted_at = Some(Instant::now() - Duration::from_secs(11));
        let signed_out = cached(&entry, true, || async { Some(0) }, || async {
            FetchError::Http(401).into_usage("claude")
        })
        .await;
        assert!(!signed_out.stale);
        assert!(signed_out.windows.is_empty());
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

    #[test]
    fn subscription_mode_ignores_inherited_relay_but_respects_explicit_settings() {
        let env =
            |name: &str| (name == "ANTHROPIC_BASE_URL").then(|| "https://relay.example".into());
        assert!(claude_override(true, env, &Value::Null));
        assert!(!claude_override(false, env, &Value::Null));
        assert!(claude_override(
            false,
            |_| None,
            &json!({"apiKeyHelper":"some-helper"})
        ));
        assert!(claude_override(
            true,
            |_| None,
            &json!({"env":{"ANTHROPIC_API_KEY":"synthetic-key"}})
        ));
        assert!(!claude_override(
            true,
            |name| (name == "CLAUDE_CODE_USE_BEDROCK").then(|| "false".into()),
            &Value::Null
        ));
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
        assert_eq!(
            claude_config_dir_in(&work),
            Some(PathBuf::from("/Users/me/.claude-work"))
        );
        assert_eq!(
            claude_config_dir_in(&[pair("CLAUDE_CONFIG_DIR", "relative")]),
            None
        );
        assert_eq!(claude_config_dir_in(&[]), claude_config_dir());
        #[cfg(target_os = "macos")]
        assert_eq!(
            claude_service(var(&work, "CLAUDE_CONFIG_DIR").as_deref(), None),
            claude_service(Some("/Users/me/.claude-work"), None)
        );
    }

    #[tokio::test]
    async fn connections_of_harnesses_without_a_connection_reader_never_show_global_limits() {
        let env = [("KIMI_SHARE_DIR".to_owned(), "/tmp/kimi-work".to_owned())];
        let usage = fetch_provider("kimi", &env).await;
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
        let usage = fetch_claude(&env).await;
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(usage.status, "unavailable");
        assert!(usage.message.unwrap().contains("API key"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn keychain_lookup_is_scoped_to_exact_config_not_global_fallback() {
        use sha2::{Digest, Sha256};
        assert_eq!(claude_service(None, None), "Claude Code-credentials");
        let config = "/tmp/claude-profile/";
        let hash = format!("{:x}", Sha256::digest(config));
        assert_eq!(
            claude_service(Some(config), None),
            format!("Claude Code-credentials-{}", &hash[..8])
        );
        assert_eq!(
            claude_service(Some(config), Some("")),
            "Claude Code-credentials"
        );
        assert_ne!(
            claude_service(Some(config), None),
            claude_service(Some("/tmp/claude-profile"), None)
        );
        assert_eq!(
            claude_service(Some("/tmp/e\u{301}"), None),
            claude_service(Some("/tmp/é"), None)
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
}
