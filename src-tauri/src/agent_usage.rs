//! Read-only subscription limits. Credentials and provider responses never cross IPC.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    future::Future,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        OnceLock,
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

async fn cached<F, Fut>(slot: &CacheSlot, refresh: bool, fetch: F) -> Usage
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Usage>,
{
    // Holding the provider lock across the bounded fetch coalesces both opening
    // the dialog and rapid Refresh clicks. Other providers remain independent.
    let mut entry = slot.entry.lock().await;
    let generation = slot.generation.load(Ordering::SeqCst);
    if entry.generation != generation {
        *entry = Entry {
            generation,
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
    if slot.generation.load(Ordering::SeqCst) != generation {
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

fn claude_override(inherit: bool, env: impl Fn(&str) -> Option<String>, settings: &Value) -> bool {
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

#[tauri::command]
pub(crate) async fn agent_usage(
    window: tauri::WebviewWindow,
    provider: String,
    refresh: bool,
) -> crate::Result<Usage> {
    if window.label() != "main" {
        return Err("Usage limits are available only in the main application window.".into());
    }
    query_usage(provider, refresh).await
}

pub(crate) async fn query_usage(provider: String, refresh: bool) -> crate::Result<Usage> {
    let slot = cache().get(provider.as_str()).ok_or("Unknown agent.")?;
    Ok(cached(slot, refresh, || async {
        static LIMIT: Semaphore = Semaphore::const_new(3);
        tokio::time::timeout(Duration::from_secs(35), async {
            let Ok(_permit) = LIMIT.acquire().await else {
                return FetchError::Unavailable.into_usage(&provider);
            };
            fetch_provider(&provider).await
        })
        .await
        .unwrap_or_else(|_| {
            Usage::empty(
                &provider,
                "error",
                "The usage check timed out. Try again later.",
            )
        })
    })
    .await)
}

async fn fetch_provider(provider: &str) -> Usage {
    let mut result = match provider {
        "codex" => fetch_codex().await,
        "claude" => fetch_claude().await,
        "kimi" | "glm" | "opencode" | "antigravity" => crate::agent_usage_providers::fetch(provider).await,
        "grok" => Usage::empty(provider, "unsupported", "Grok does not expose subscription usage through this agent. Check your account dashboard."),
        "mimo" => Usage::empty(provider, "unsupported", "MiMo does not expose account limits through this agent. View your Token Plan dashboard."),
        "omp" => Usage::empty(provider, "unsupported", "omp uses the model provider you configured for it. Check that provider's dashboard for limits."),
        "pi" => Usage::empty(provider, "unsupported", "Pi uses the model provider you configured for it. Check that provider's dashboard for limits."),
        "deepseek" => Usage::empty(provider, "unsupported", "DeepSeek does not expose balance or limits through this agent. Check the DeepSeek platform."),
        "commandcode" => Usage::empty(provider, "unsupported", "Command Code does not expose credits or limits through this agent. Check Command Code Studio."),
        "cline" => Usage::empty(provider, "unsupported", "Cline does not expose credits or limits through this agent. Check your Cline account."),
        "kilo" => Usage::empty(provider, "unsupported", "Kilo Code does not expose credits or limits through this agent. Check your Kilo account or the model provider's dashboard."),
        "github-copilot" => Usage::empty(provider, "unsupported", "GitHub Copilot CLI does not expose usage limits through this agent. Check your GitHub Copilot settings."),
        "muse" => Usage::empty(provider, "unsupported", "Muse Code reports its usage windows only inside a running session. Check them with /usage in Muse Code."),
        _ => Usage::empty(provider, "unsupported", "Usage limits are not available for this agent."),
    };
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

async fn fetch_codex() -> Usage {
    let cwd = crate::agent_usage_providers::home().unwrap_or_else(std::env::temp_dir);
    let Ok(mut client) = crate::integrations::ControlClient::start(&cwd).await else {
        return Usage::empty("codex", "error", "Codex usage is unavailable. Check that its CLI is installed and signed in, then refresh.");
    };
    let result = match client
        .request("account/read", json!({"refreshToken":false}))
        .await
    {
        Ok(account) if account["account"]["type"] == "chatgpt" => {
            // New Codex versions can omit reset-credit details, which this view
            // does not use. Older versions ignore this additional optional key.
            match client.request("account/rateLimits/read", json!({"excludeResetCreditDetails":true})).await {
                Ok(limits) => codex_usage(&account, &limits),
                Err(_) => Usage::empty("codex", "error", "Codex could not read subscription limits. Check its sign-in status and refresh."),
            }
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
    match std::env::var_os("CLAUDE_CONFIG_DIR").filter(|value| !value.is_empty()) {
        Some(path) => {
            let path = PathBuf::from(path);
            path.is_absolute().then_some(path)
        }
        None => crate::agent_usage_providers::home().map(|home| home.join(".claude")),
    }
}

async fn fetch_claude() -> Usage {
    let Some(config) = claude_config_dir() else {
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
        crate::provider_settings::claude_connection_mode().is_inherit(),
        |name| std::env::var(name).ok(),
        &settings,
    ) {
        return Usage::empty("claude", "unavailable", "Claude is configured with an API key, custom endpoint, or environment credentials. Saved Claude subscription limits do not describe that connection.");
    }
    let (credential, source) = match read_claude_credential(&config).await {
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
) -> Result<(ClaudeCredential, &'static str), Box<Usage>> {
    let unavailable = unreadable_claude_login;
    #[cfg(target_os = "macos")]
    {
        let service = claude_service(
            std::env::var("CLAUDE_CONFIG_DIR").ok().as_deref(),
            std::env::var("CLAUDE_SECURESTORAGE_CONFIG_DIR")
                .ok()
                .as_deref(),
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

    #[test]
    fn codex_prefers_named_limits_and_omits_missing_percentages() {
        let result = codex_usage(
            &json!({"account":{"type":"chatgpt","planType":"plus","email":"PRIVATE"}}),
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
        assert!(!encoded.contains("PRIVATE"));
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
        let fetch = || async {
            count.fetch_add(1, Ordering::SeqCst);
            tokio::task::yield_now().await;
            Usage::empty("claude", "ready", "")
        };
        let (first, second) =
            tokio::join!(cached(&entry, false, fetch), cached(&entry, true, fetch));
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
            }),
            generation: AtomicU64::new(0),
        };
        let prior = entry.entry.lock().await.result.as_ref().unwrap().checked_at;
        let failed = cached(&entry, true, || async {
            FetchError::Unavailable.into_usage("claude")
        })
        .await;
        assert!(failed.stale);
        assert_eq!(failed.windows[0].used_percent, 4.0);
        assert_eq!(failed.checked_at, prior);
        entry.entry.lock().await.attempted_at = Some(Instant::now() - Duration::from_secs(11));
        let signed_out = cached(&entry, true, || async {
            FetchError::Http(401).into_usage("claude")
        })
        .await;
        assert!(!signed_out.stale);
        assert!(signed_out.windows.is_empty());
    }

    #[tokio::test]
    async fn account_change_during_fetch_discards_old_response() {
        let slot = CacheSlot::default();
        let result = cached(&slot, false, || async {
            slot.generation.fetch_add(1, Ordering::SeqCst);
            claude_usage(&json!({"five_hour":{"utilization":50}}), None)
        })
        .await;
        assert!(result.windows.is_empty());
        assert!(slot.entry.lock().await.result.is_none());
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
            }),
            generation: AtomicU64::new(0),
        };
        let normal = cached(&slot, false, || async {
            panic!("The 60-second cache should avoid this request")
        })
        .await;
        assert_eq!(normal.windows[0].used_percent, 4.0);
        let refreshed = cached(&slot, true, || async {
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
