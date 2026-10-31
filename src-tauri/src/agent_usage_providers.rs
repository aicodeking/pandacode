//! Read-only account quota adapters. Only vendor-owned, fixed usage endpoints
//! receive credentials; neither inference nor OAuth refresh is performed here.
//!
//! Wire contracts:
//! https://github.com/MoonshotAI/kimi-code/blob/main/packages/oauth/src/managed-usage.ts
//! https://github.com/zai-org/zai-coding-plugins/blob/main/plugins/glm-plan-usage/skills/usage-query-skill/scripts/query-usage.mjs
//! https://github.com/anomalyco/opencode/blob/dev/packages/console/app/src/routes/zen/go/v1/usage.ts
//! https://api-docs.deepseek.com/api/get-user-balance
use crate::agent_usage::{http_client, request_json, FetchError, Usage, UsageWindow};
use serde::Deserialize;
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::io::AsyncReadExt;

const CREDENTIAL_LIMIT: u64 = 256 * 1024;
const KIMI_BASE: &str = "https://api.kimi.com/coding/v1";
const KIMI_GLOBAL_BASE: &str = "https://api.kimi.ai/coding/v1";
const GLM_URL: &str = "https://api.z.ai/api/monitor/usage/quota/limit";
const OPENCODE_URL: &str = "https://opencode.ai/zen/go/v1/usage";
const DEEPSEEK_URL: &str = "https://api.deepseek.com/user/balance";

pub(crate) async fn fetch(provider: &str) -> Usage {
    let mut usage = match provider {
        "kimi" => fetch_kimi().await,
        "glm" => fetch_glm().await,
        "deepseek" => fetch_deepseek().await,
        "opencode" => fetch_opencode().await,
        "antigravity" => fetch_antigravity().await,
        _ => Usage::empty(
            provider,
            "unsupported",
            "Account limits are not available from this agent.",
        ),
    };
    if usage.dashboard_url.is_none() {
        usage.dashboard_url = match provider {
            "kimi" => Some("https://www.kimi.com/code/console"),
            "glm" => Some("https://z.ai/manage-apikey/subscription"),
            "opencode" => Some("https://opencode.ai/zen"),
            "antigravity" => Some("https://antigravity.google/docs/plans"),
            _ => None,
        }
        .map(str::to_owned);
    }
    usage
}

fn key(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty() && value.len() <= 16 * 1024 && value.bytes().all(|b| b.is_ascii_graphic()))
        .then(|| value.to_owned())
}

fn env_key(name: &str) -> Option<String> {
    std::env::var(name).ok().and_then(|value| key(&value))
}

pub(crate) fn home() -> Option<PathBuf> {
    let names = if cfg!(windows) {
        ["USERPROFILE", "HOME"]
    } else {
        ["HOME", "USERPROFILE"]
    };
    names.into_iter().find_map(|name| {
        std::env::var_os(name)
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
    })
}

// Bound both bytes and elapsed time. Only the exact harness-owned credential
// file is opened; no directory traversal, browser storage, or credential scan.
pub(crate) async fn credential_bytes(path: &Path) -> Result<Option<Vec<u8>>, ()> {
    tokio::time::timeout(Duration::from_secs(2), async {
        let metadata = match tokio::fs::metadata(path).await {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(()),
        };
        if !metadata.is_file() || metadata.len() > CREDENTIAL_LIMIT {
            return Err(());
        }
        let file = tokio::fs::File::open(path).await.map_err(|_| ())?;
        let mut bytes = Vec::new();
        file.take(CREDENTIAL_LIMIT + 1)
            .read_to_end(&mut bytes)
            .await
            .map_err(|_| ())?;
        if bytes.len() as u64 > CREDENTIAL_LIMIT {
            bytes.fill(0);
            return Err(());
        }
        Ok(Some(bytes))
    })
    .await
    .map_err(|_| ())?
}

async fn fetch_glm() -> Usage {
    // A failed background read cannot establish which key the harness uses.
    // Only fall back to environment after a successful, empty store lookup.
    let saved = tokio::task::spawn_blocking(crate::provider_settings::glm_key_for_usage).await;
    let saved = saved.ok().and_then(Result::ok).ok_or(());
    let api_key = match saved_key_or_environment(saved, env_key("ZAI_API_KEY")) {
        Ok(Some(key)) => key,
        Ok(None) => return Usage::empty("glm", "signedOut", "Add your Z.AI Coding Plan key in Settings → Agents to read its limits."),
        Err(()) => return Usage::empty("glm", "unavailable", "The configured GLM account could not be verified without opening secure storage. View its limits in the Z.AI dashboard."),
    };
    let client = match http_client() {
        Ok(client) => client,
        Err(error) => return error.into_usage("glm"),
    };
    // This is the raw Authorization header used by Z.AI's official quota script.
    match request_json(
        client
            .get(GLM_URL)
            .header("Authorization", api_key)
            .header("Accept", "application/json"),
    )
    .await
    {
        Ok(value) => parse_glm(&value),
        Err(error) => error.into_usage("glm"),
    }
}

fn saved_key_or_environment(
    saved: Result<Option<String>, ()>,
    environment: Option<String>,
) -> Result<Option<String>, ()> {
    match saved? {
        Some(saved) => key(&saved).map(Some).ok_or(()),
        None => Ok(environment.and_then(|value| key(&value))),
    }
}

async fn fetch_deepseek() -> Usage {
    // Same rule as GLM: a failed background read cannot establish which key
    // the harness uses. Only fall back to the environment after a successful,
    // empty store lookup.
    let saved = tokio::task::spawn_blocking(crate::provider_settings::deepseek_key_for_usage).await;
    let saved = saved.ok().and_then(Result::ok).ok_or(());
    let api_key = match saved_key_or_environment(saved, env_key("DEEPSEEK_API_KEY")) {
        Ok(Some(key)) => key,
        Ok(None) => {
            return Usage::empty(
                "deepseek",
                "signedOut",
                "Add your DeepSeek API key in Settings → Agents to read your balance.",
            )
        }
        Err(()) => {
            return Usage::empty(
                "deepseek",
                "unavailable",
                "The configured DeepSeek key could not be verified without opening secure storage. View your balance on the DeepSeek platform.",
            )
        }
    };
    let client = match http_client() {
        Ok(client) => client,
        Err(error) => return error.into_usage("deepseek"),
    };
    match request_json(
        client
            .get(DEEPSEEK_URL)
            .header("Authorization", format!("Bearer {api_key}"))
            .header("Accept", "application/json"),
    )
    .await
    {
        Ok(value) => parse_deepseek(&value),
        Err(error) => error.into_usage("deepseek"),
    }
}

#[derive(Deserialize)]
struct KimiToken {
    access_token: String,
    expires_at: f64,
}

fn kimi_token(bytes: &[u8], now: f64) -> Option<String> {
    let token: KimiToken = serde_json::from_slice(bytes).ok()?;
    (token.expires_at.is_finite() && token.expires_at > now + 30.0)
        .then(|| key(&token.access_token))
        .flatten()
}

fn kimi_endpoint(base: Option<&str>) -> Option<&'static str> {
    match base
        .map(|s| s.trim().trim_end_matches('/'))
        .unwrap_or(KIMI_BASE)
    {
        KIMI_BASE => Some("https://api.kimi.com/coding/v1/usages"),
        KIMI_GLOBAL_BASE => Some("https://api.kimi.ai/coding/v1/usages"),
        _ => None,
    }
}

fn default_kimi_oauth(base: Option<&str>, host: Option<&str>, legacy_host: Option<&str>) -> bool {
    base.is_none_or(|v| v.trim().trim_end_matches('/') == KIMI_BASE)
        && [host, legacy_host].into_iter().all(|value| {
            value.is_none_or(|v| v.trim().trim_end_matches('/') == "https://auth.kimi.com")
        })
}

// Both official CLIs use config.toml, with snake_case in Python and
// snake_case/camelCase compatibility in kimi-code. Select only the default
// model's provider; unrelated provider keys never become usage credentials.
#[derive(Deserialize)]
struct KimiConfig {
    #[serde(default, alias = "defaultModel")]
    default_model: String,
    #[serde(default)]
    models: std::collections::HashMap<String, KimiModel>,
    #[serde(default)]
    providers: std::collections::HashMap<String, KimiProvider>,
}
#[derive(Deserialize)]
struct KimiModel {
    provider: String,
}
#[derive(Deserialize)]
struct KimiProvider {
    #[serde(rename = "type")]
    kind: String,
    #[serde(alias = "baseUrl")]
    base_url: Option<String>,
    #[serde(alias = "apiKey")]
    api_key: Option<String>,
    oauth: Option<KimiOAuthRef>,
    env: Option<std::collections::HashMap<String, String>>,
}
#[derive(Deserialize)]
struct KimiOAuthRef {
    storage: String,
    key: String,
    #[serde(alias = "oauthHost")]
    oauth_host: Option<String>,
}
struct KimiAuth {
    endpoint: &'static str,
    key: String,
}

fn selected_kimi_provider(config: KimiConfig) -> Result<KimiProvider, Box<Usage>> {
    let provider_id = config
        .models
        .get(&config.default_model)
        .map(|model| model.provider.as_str());
    let Some(provider) = provider_id.and_then(|id| config.providers.get(id)) else {
        return Err(Box::new(Usage::empty("kimi", "unavailable", "Kimi’s default model does not identify a configured account. Check its CLI configuration.")));
    };
    if provider.kind != "kimi" {
        return Err(Box::new(Usage::empty(
            "kimi",
            "unsupported",
            "Kimi’s configured model uses another provider. Check that provider’s account limits.",
        )));
    }
    let id = provider_id.unwrap().to_owned();
    let mut providers = config.providers;
    Ok(providers.remove(&id).unwrap())
}

async fn read_kimi_config(directory: &Path) -> Result<Option<KimiConfig>, Box<Usage>> {
    for (filename, json) in [("config.toml", false), ("config.json", true)] {
        let bytes = credential_bytes(&directory.join(filename))
            .await
            .map_err(|_| {
                Usage::empty(
                    "kimi",
                    "unavailable",
                    "The Kimi CLI configuration could not be read.",
                )
            })?;
        if let Some(mut bytes) = bytes {
            let config = if json {
                serde_json::from_slice(&bytes).ok()
            } else {
                std::str::from_utf8(&bytes)
                    .ok()
                    .and_then(|text| toml::from_str(text).ok())
            };
            bytes.fill(0);
            return config.map(Some).ok_or_else(|| {
                Box::new(Usage::empty(
                    "kimi",
                    "unavailable",
                    "The Kimi CLI configuration could not be parsed.",
                ))
            });
        }
    }
    Ok(None)
}

fn kimi_directories() -> Result<Vec<PathBuf>, Box<Usage>> {
    // Explicit homes are authoritative; never fall back to another account.
    for name in ["KIMI_CODE_HOME", "KIMI_SHARE_DIR"] {
        if let Some(value) = std::env::var_os(name).filter(|v| !v.is_empty()) {
            let path = PathBuf::from(value);
            return if path.is_absolute() {
                Ok(vec![path])
            } else {
                Err(Box::new(Usage::empty(
                    "kimi",
                    "unavailable",
                    "Kimi usage needs an absolute CLI configuration directory.",
                )))
            };
        }
    }
    home()
        .map(|home| vec![home.join(".kimi-code"), home.join(".kimi")])
        .ok_or_else(|| {
            Box::new(Usage::empty(
                "kimi",
                "unavailable",
                "The Kimi CLI configuration location is unavailable.",
            ))
        })
}

async fn configured_kimi_auth() -> Result<KimiAuth, Box<Usage>> {
    let code_base = std::env::var("KIMI_CODE_BASE_URL").ok();
    let directories = kimi_directories()?;
    if let Some((directory, config)) = unambiguous_kimi_config(&directories).await? {
        let provider = selected_kimi_provider(config)?;
        let provider_env = provider.env.as_ref();
        let base = std::env::var("KIMI_BASE_URL")
            .ok()
            .or(code_base.clone())
            .or_else(|| {
                provider_env
                    .and_then(|env| env.get("KIMI_BASE_URL"))
                    .cloned()
            })
            .or(provider.base_url);
        // A generic KIMI_API_KEY can belong to Moonshot Open Platform. Require
        // an explicit supported Code base from the selected CLI provider.
        let endpoint = base.as_deref().and_then(|base| kimi_endpoint(Some(base)))
            .ok_or_else(|| Usage::empty("kimi", "unsupported", "Kimi’s configured endpoint does not expose supported Code subscription limits."))?;
        if let Some(oauth) = provider.oauth {
            let host = std::env::var("KIMI_CODE_OAUTH_HOST")
                .ok()
                .or(oauth.oauth_host);
            let legacy_host = std::env::var("KIMI_OAUTH_HOST").ok();
            if oauth.storage != "file"
                || oauth.key != "oauth/kimi-code"
                || !default_kimi_oauth(base.as_deref(), host.as_deref(), legacy_host.as_deref())
            {
                return Err(Box::new(Usage::empty("kimi", "unavailable", "This Kimi login uses a credential scope that cannot be reused safely for usage.")));
            }
            let mut bytes = credential_bytes(&directory.join("credentials/kimi-code.json"))
                .await
                .map_err(|_| {
                    Usage::empty(
                        "kimi",
                        "unavailable",
                        "The Kimi CLI credential could not be read.",
                    )
                })?
                .ok_or_else(|| {
                    Usage::empty(
                        "kimi",
                        "signedOut",
                        "Sign in with Kimi Code CLI to read account limits.",
                    )
                })?;
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs_f64();
            let access_token = kimi_token(&bytes, now);
            bytes.fill(0);
            return access_token.map(|key| KimiAuth { endpoint, key }).ok_or_else(||
                Box::new(Usage::empty("kimi", "signedOut", "The Kimi CLI session needs to be refreshed. Sign in with Kimi, then refresh usage.")));
        }
        let api_key = env_key("KIMI_API_KEY")
            .or_else(|| {
                provider_env
                    .and_then(|env| env.get("KIMI_API_KEY"))
                    .and_then(|value| key(value))
            })
            .or_else(|| provider.api_key.as_deref().and_then(key));
        return api_key
            .map(|key| KimiAuth { endpoint, key })
            .ok_or_else(|| {
                Box::new(Usage::empty(
                    "kimi",
                    "signedOut",
                    "Kimi’s selected provider has no readable account credential.",
                ))
            });
    }
    Err(Box::new(Usage::empty(
        "kimi",
        "signedOut",
        "Configure a Kimi Code account in the Kimi CLI to read its limits.",
    )))
}

async fn unambiguous_kimi_config(
    directories: &[PathBuf],
) -> Result<Option<(PathBuf, KimiConfig)>, Box<Usage>> {
    let mut selected = None;
    for directory in directories {
        if let Some(config) = read_kimi_config(directory).await? {
            if selected.is_some() {
                return Err(Box::new(Usage::empty("kimi", "unavailable", "Both Kimi CLI configurations are present. Set the active CLI’s home directory explicitly before reading account limits.")));
            }
            selected = Some((directory.clone(), config));
        }
    }
    Ok(selected)
}

async fn fetch_kimi() -> Usage {
    let KimiAuth {
        endpoint,
        key: api_key,
    } = match configured_kimi_auth().await {
        Ok(auth) => auth,
        Err(usage) => return *usage,
    };
    let client = match http_client() {
        Ok(client) => client,
        Err(error) => return error.into_usage("kimi"),
    };
    let mut result = match request_json(
        client
            .get(endpoint)
            .bearer_auth(api_key)
            .header("Accept", "application/json"),
    )
    .await
    {
        Ok(value) => parse_kimi(&value),
        Err(error) => error.into_usage("kimi"),
    };
    if endpoint.contains("api.kimi.ai/") {
        result.dashboard_url = Some("https://www.kimi.ai/code/console".into());
    }
    result
}

#[derive(Deserialize)]
struct OpenCodeAuth {
    #[serde(rename = "opencode-go")]
    go: Option<OpenCodeKey>,
    opencode: Option<OpenCodeKey>,
}

#[derive(Deserialize)]
struct OpenCodeKey {
    #[serde(rename = "type")]
    kind: String,
    key: Option<String>,
}

fn opencode_key(bytes: &[u8]) -> Option<String> {
    let auth: OpenCodeAuth = serde_json::from_slice(bytes).ok()?;
    let entry = auth.go.or(auth.opencode)?;
    (entry.kind == "api")
        .then(|| entry.key.as_deref().and_then(key))
        .flatten()
}

async fn fetch_opencode() -> Usage {
    let path = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| home().map(|p| p.join(".local/share")))
        .map(|p| p.join("opencode/auth.json"));
    let content = std::env::var("OPENCODE_AUTH_CONTENT").ok();
    let saved = match opencode_auth_bytes(path.as_deref(), content.as_deref()).await {
        Ok(bytes) => bytes,
        Err(()) => {
            return Usage::empty(
                "opencode",
                "unavailable",
                "OpenCode’s account configuration could not be read safely.",
            )
        }
    };
    let api_key = match opencode_usage_key(saved.as_deref(), env_key("OPENCODE_API_KEY")) {
        Ok(key) => key,
        Err(()) => {
            return Usage::empty(
                "opencode",
                "unavailable",
                "OpenCode’s account credential could not be identified safely.",
            )
        }
    };
    if let Some(mut bytes) = saved {
        bytes.fill(0);
    }
    let Some(api_key) = api_key else {
        return Usage::empty("opencode", "unsupported", "OpenCode Go limits need an existing Go or Zen API key in OpenCode. Other connected providers have separate limits.");
    };
    let client = match http_client() {
        Ok(client) => client,
        Err(error) => return error.into_usage("opencode"),
    };
    match request_json(client.get(OPENCODE_URL).bearer_auth(api_key).header("Accept", "application/json")).await {
        Ok(value) => parse_opencode(&value),
        Err(FetchError::Http(403)) => Usage::empty("opencode", "unavailable", "This OpenCode key has no Go subscription. Zen balance and other providers’ limits are available in their dashboards."),
        Err(error) => error.into_usage("opencode"),
    }
}

async fn opencode_auth_bytes(
    path: Option<&Path>,
    content: Option<&str>,
) -> Result<Option<Vec<u8>>, ()> {
    if let Some(content) = content.filter(|value| !value.is_empty()) {
        if content.len() as u64 > CREDENTIAL_LIMIT {
            return Err(());
        }
        // Auth.all() uses valid OPENCODE_AUTH_CONTENT instead of the file; an
        // empty/malformed JSON environment value falls back to the saved file.
        if serde_json::from_str::<Value>(content).is_ok() {
            return Ok(Some(content.as_bytes().to_vec()));
        }
    }
    credential_bytes(path.ok_or(())?).await
}

fn opencode_usage_key(
    saved: Option<&[u8]>,
    environment: Option<String>,
) -> Result<Option<String>, ()> {
    if let Some(bytes) = saved {
        // Auth content replaces the file, and saved API credentials override
        // environment keys in the official provider loader. Invalid explicit
        // credentials are not replaced with a potentially different account.
        let parsed: OpenCodeAuth = serde_json::from_slice(bytes).map_err(|_| ())?;
        if parsed.go.is_some() || parsed.opencode.is_some() {
            let saved = opencode_key(bytes).ok_or(())?;
            // Go and Zen are distinct provider entries. A Zen-only saved key
            // plus a different environment key does not identify the Go account.
            if parsed.go.is_none() && environment.as_deref().is_some_and(|env| env != saved) {
                return Err(());
            }
            return Ok(Some(saved));
        }
    }
    Ok(environment.and_then(|value| key(&value)))
}

// Native /usage JSON is supported starting with agy 1.1.11. An older CLI can
// interpret an unknown slash command as a model prompt, so this gate precedes
// every print invocation; prereleases and ambiguous output fail closed.
// https://antigravity.google/docs/cli/headless/
// https://github.com/steipete/CodexBar/blob/main/Tests/CodexBarTests/AntigravityCLIUsageReportTests.swift
fn antigravity_version_supported(bytes: &[u8]) -> bool {
    let Ok(text) = std::str::from_utf8(bytes) else {
        return false;
    };
    let parts: Vec<_> = text.trim().split('.').collect();
    if parts.len() != 3 {
        return false;
    }
    let mut version = [0_u32; 3];
    for (index, part) in parts.into_iter().enumerate() {
        if part.is_empty() || part.len() > 5 || !part.bytes().all(|b| b.is_ascii_digit()) {
            return false;
        }
        let Ok(value) = part.parse() else {
            return false;
        };
        version[index] = value;
    }
    version >= [1, 1, 11]
}

fn antigravity_command(
    path: &Path,
    cwd: &Path,
    args: &[&str],
    limit: usize,
    timeout: Duration,
) -> Result<Vec<u8>, ()> {
    let mut command = crate::providers::provider_command("antigravity", path).map_err(|_|())?.into_std();
    command.args(args).current_dir(cwd);
    let output = crate::workspace::run_process(command, "Antigravity usage", limit, timeout)
        .map_err(|_| ())?;
    if !output.status.success() || output.stdout.truncated {
        return Err(());
    }
    // Raw stderr can contain authentication details. It never leaves native code.
    Ok(output.stdout.bytes)
}

fn antigravity_report(path: &Path, cwd: &Path, timeout: Duration) -> Usage {
    let version = match antigravity_command(path, cwd, &["--version"], 256, Duration::from_secs(3))
    {
        Ok(bytes) => bytes,
        Err(()) => {
            return Usage::empty(
                "antigravity",
                "unavailable",
                "The Antigravity CLI version could not be verified.",
            )
        }
    };
    if !antigravity_version_supported(&version) {
        return Usage::empty("antigravity", "unsupported", "Account limits need the standalone agy CLI version 1.1.11 or later. Your agent connection can still be used.");
    }
    let bytes = match antigravity_command(
        path,
        cwd,
        &[
            "-p",
            "/usage",
            "--output-format",
            "json",
            "--print-timeout",
            "12s",
        ],
        CREDENTIAL_LIMIT as usize,
        timeout,
    ) {
        Ok(bytes) => bytes,
        Err(()) => {
            return Usage::empty(
                "antigravity",
                "unavailable",
                "Antigravity could not report usage. Check the agy CLI sign-in and try again.",
            )
        }
    };
    match serde_json::from_slice(&bytes) {
        Ok(value) => parse_antigravity(&value),
        Err(_) => Usage::empty(
            "antigravity",
            "unavailable",
            "Antigravity did not return a supported usage report.",
        ),
    }
}

async fn fetch_antigravity() -> Usage {
    if std::env::var_os("ANTIGRAVITY_OAUTH_CREDENTIALS_JSON").is_some() {
        return Usage::empty("antigravity", "unavailable", "This Antigravity connection uses explicit credentials that the CLI usage report cannot identify safely.");
    }
    // Resolve the standalone CLI independently. The ACP server executable and
    // its saved override must never be replaced or invoked in print mode.
    let Some(path) = crate::providers::executable("agy") else {
        return Usage::empty(
            "antigravity",
            "unsupported",
            "Account limits need the standalone agy CLI version 1.1.11 or later.",
        );
    };
    tokio::task::spawn_blocking(move || {
        let directory =
            std::env::temp_dir().join(format!("pandacode-usage-{}", uuid::Uuid::new_v4()));
        if std::fs::create_dir(&directory).is_err() {
            return Usage::empty(
                "antigravity",
                "unavailable",
                "A temporary directory for the usage check could not be created.",
            );
        }
        let usage = antigravity_report(&path, &directory, Duration::from_secs(12));
        let _ = std::fs::remove_dir_all(directory);
        usage
    })
    .await
    .unwrap_or_else(|_| {
        Usage::empty(
            "antigravity",
            "unavailable",
            "The Antigravity usage check could not finish.",
        )
    })
}

fn parse_antigravity(value: &Value) -> Usage {
    if value["status"] != "SUCCESS"
        || value["command"]["name"] != "usage"
        || number(&value["num_turns"]).is_some_and(|n| n > 0.0)
        || number(&value["usage"]["total_tokens"]).is_some_and(|n| n > 0.0)
    {
        return Usage::empty(
            "antigravity",
            "unavailable",
            "Antigravity did not return a successful native usage report.",
        );
    }
    let mut windows = Vec::new();
    if let Some(groups) = value["command"]["data"]["groups"].as_array() {
        for group in groups.iter().take(8) {
            if group["disabled"] == true {
                continue;
            }
            let name = group["name"]
                .as_str()
                .filter(|name| {
                    !name.trim().is_empty()
                        && name.len() <= 80
                        && !name.chars().any(char::is_control)
                })
                .unwrap_or("Models");
            let Some(buckets) = group["buckets"].as_array() else {
                continue;
            };
            for bucket in buckets.iter().take(8) {
                if bucket["disabled"] == true {
                    continue;
                }
                let Some(remaining) = number(&bucket["remaining_fraction"]).filter(|n| *n <= 1.0)
                else {
                    continue;
                };
                let duration = match bucket["window"].as_str().or_else(|| bucket["id"].as_str()) {
                    Some("5h" | "gemini-5h" | "3p-5h") => "5 hours",
                    Some("weekly" | "gemini-weekly" | "3p-weekly") => "7 days",
                    Some("monthly") => "Monthly",
                    _ => continue,
                };
                windows.push(UsageWindow::new(
                    format!("{name} · {duration}"),
                    (1.0 - remaining) * 100.0,
                    reset(&bucket["reset_time"]),
                ));
            }
        }
    }
    let mut usage = ready("antigravity", windows, "Antigravity CLI usage report");
    if usage.status == "ready" {
        usage.message = Some("From the account signed in to the standalone agy CLI.".into());
    }
    usage
}

fn number(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| {
            value
                .as_str()
                .filter(|s| !s.trim().is_empty())
                .and_then(|s| s.parse().ok())
        })
        .filter(|n| n.is_finite() && *n >= 0.0)
}

fn reset(value: &Value) -> Option<String> {
    let value = value.as_str()?;
    let bytes = value.as_bytes();
    (bytes.len() >= 20
        && bytes.len() <= 64
        && bytes.get(4) == Some(&b'-')
        && bytes.get(7) == Some(&b'-')
        && bytes.get(10) == Some(&b'T')
        && bytes
            .iter()
            .all(|b| b.is_ascii_digit() || b"-T:Z+.".contains(b)))
    .then(|| value.to_owned())
}

fn ready(provider: &str, windows: Vec<UsageWindow>, source: &str) -> Usage {
    if windows.is_empty() {
        return Usage::empty(
            provider,
            "unavailable",
            "The provider did not return a supported account quota window.",
        );
    }
    let mut usage = Usage::empty(provider, "ready", "");
    usage.message = None;
    usage.windows = windows;
    usage.source = Some(source.into());
    usage
}

fn count_window(label: &str, value: &Value) -> Option<UsageWindow> {
    let total = number(&value["limit"])?;
    if total <= 0.0 {
        return None;
    }
    let used = number(&value["used"]).or_else(|| {
        number(&value["remaining"])
            .filter(|r| *r <= total)
            .map(|remaining| total - remaining)
    })?;
    Some(UsageWindow::new(
        label,
        (used / total * 100.0).min(100.0),
        reset(&value["resetTime"]),
    ))
}

fn parse_kimi(value: &Value) -> Usage {
    let mut windows = Vec::new();
    for (field, label) in [
        ("limit_5h", "5 hours"),
        ("limit_7d", "7 days"),
        ("limit_month_total", "Monthly total"),
        ("limit_month_code", "Monthly coding"),
    ] {
        let entry = &value["usages"][field];
        if let Some(ratio) = number(&entry["used_ratio"]) {
            windows.push(UsageWindow::new(
                label,
                (ratio * 100.0).min(100.0),
                reset(&entry["reset_time"]),
            ));
        }
    }
    if !windows.iter().any(|w| w.label == "5 hours") {
        if let Some(limits) = value["limits"].as_array() {
            for limit in limits.iter().take(16) {
                let window = &limit["window"];
                let is_five_hours = match window["timeUnit"].as_str() {
                    Some("TIME_UNIT_MINUTE") => number(&window["duration"]) == Some(300.0),
                    Some("TIME_UNIT_HOUR") => number(&window["duration"]) == Some(5.0),
                    Some("TIME_UNIT_SECOND") => number(&window["duration"]) == Some(18000.0),
                    _ => false,
                };
                if is_five_hours {
                    if let Some(window) = count_window("5 hours", &limit["detail"]) {
                        windows.insert(0, window);
                        break;
                    }
                }
            }
        }
    }
    if !windows.iter().any(|w| w.label == "7 days") {
        if let Some(window) = count_window("7 days", &value["usage"]) {
            windows.push(window);
        }
    }
    ready("kimi", windows, "Kimi Code usage API")
}

fn glm_window_label(entry: &Value, kind: &str) -> String {
    if kind == "TIME_LIMIT" {
        return "Monthly MCP tools".into();
    }
    let period = match (entry["unit"].as_u64(), entry["number"].as_u64()) {
        (Some(3), Some(5)) => "5 hours",
        (Some(6), Some(1)) | (Some(1), Some(7)) => "7 days",
        (Some(1), Some(1)) => "Daily",
        (Some(5), Some(1)) => "1 minute",
        _ => "Coding quota",
    };
    period.into()
}

fn parse_glm(value: &Value) -> Usage {
    if value["success"] == false
        || value
            .get("code")
            .is_some_and(|code| !code.is_null() && code != 200 && code != 0)
    {
        return Usage::empty(
            "glm",
            "unavailable",
            "Z.AI could not return Coding Plan limits. Check the account dashboard.",
        );
    }
    let mut windows = Vec::new();
    if let Some(limits) = value["data"]["limits"].as_array() {
        for entry in limits.iter().take(16) {
            let Some(kind @ ("TOKENS_LIMIT" | "CREDIT_LIMIT" | "TIME_LIMIT")) =
                entry["type"].as_str()
            else {
                continue;
            };
            let percent = number(&entry["usage"])
                .filter(|v| *v > 0.0)
                .and_then(|total| {
                    number(&entry["currentValue"])
                        .or_else(|| {
                            number(&entry["remaining"])
                                .filter(|r| *r <= total)
                                .map(|r| total - r)
                        })
                        .map(|used| used / total * 100.0)
                })
                .or_else(|| number(&entry["percentage"]));
            if let Some(percent) = percent.filter(|n| n.is_finite()) {
                let reset = entry["nextResetTime"]
                    .as_i64()
                    .filter(|n| *n > 0)
                    .and_then(|ms| epoch_iso(ms / 1000));
                windows.push(UsageWindow::new(
                    glm_window_label(entry, kind),
                    percent.min(100.0),
                    reset,
                ));
            }
        }
    }
    ready("glm", windows, "Z.AI Coding Plan quota API")
}

/// DeepSeek's only account endpoint returns a prepaid balance, not plan
/// windows, so the card is a ready message without progress bars.
fn parse_deepseek(value: &Value) -> Usage {
    let mut usage = Usage::empty("deepseek", "ready", "");
    usage.source = Some("DeepSeek balance API".into());
    if value["is_available"].as_bool() == Some(false) {
        usage.status = "unavailable".into();
        usage.message = Some(
            "DeepSeek reports the balance is insufficient for API calls. Top up on the DeepSeek platform."
                .into(),
        );
        return usage;
    }
    let parts: Vec<String> = value["balance_infos"]
        .as_array()
        .map(|entries| entries.iter().take(4).filter_map(deepseek_part).collect())
        .unwrap_or_default();
    if parts.is_empty() {
        usage.status = "unavailable".into();
        usage.message =
            Some("DeepSeek did not return a readable balance. Check the DeepSeek platform.".into());
        return usage;
    }
    usage.message = Some(format!("Balance {}.", parts.join(" · ")));
    usage
}

fn deepseek_part(entry: &Value) -> Option<String> {
    let currency = entry["currency"].as_str().map(str::trim).filter(|name| {
        !name.is_empty() && name.len() <= 8 && name.bytes().all(|b| b.is_ascii_alphanumeric())
    })?;
    let total = deepseek_amount(&entry["total_balance"])?;
    let extras = [
        ("granted_balance", "granted"),
        ("topped_up_balance", "topped up"),
    ]
    .iter()
    .filter_map(|(field, label)| {
        deepseek_amount(&entry[field]).map(|value| format!("{label} {value}"))
    })
    .collect::<Vec<_>>();
    if extras.is_empty() {
        Some(format!("{currency} {total}"))
    } else {
        Some(format!("{currency} {total} ({})", extras.join(", ")))
    }
}

fn deepseek_amount(value: &Value) -> Option<String> {
    let text = value.as_str()?.trim();
    (!text.is_empty()
        && text.len() <= 24
        && text.bytes().all(|b| b.is_ascii_digit() || b == b'.')
        && text.parse::<f64>().is_ok())
        .then(|| text.to_owned())
}

fn parse_opencode(value: &Value) -> Usage {
    let mut windows = Vec::new();
    for (field, label) in [
        ("rolling", "Go · 5 hours"),
        ("weekly", "Go · 7 days"),
        ("monthly", "Go · Monthly"),
    ] {
        let entry = &value["usage"][field];
        if !matches!(entry["status"].as_str(), Some("ok" | "rate-limited")) {
            continue;
        }
        if let Some(percent) = number(&entry["percent"]) {
            windows.push(UsageWindow::new(
                label,
                percent.min(100.0),
                reset(&entry["resetsAt"]),
            ));
        }
    }
    let mut usage = ready("opencode", windows, "OpenCode Go usage API");
    if usage.status == "ready" {
        usage.plan = Some("OpenCode Go".into());
        usage.message = Some(
            "These limits apply to OpenCode Go. Other connected providers have separate limits."
                .into(),
        );
    }
    usage
}

/// UTC ISO timestamp for vendor Unix seconds, without platform/local-time APIs.
pub(crate) fn epoch_iso(seconds: i64) -> Option<String> {
    if !(0..=253_402_300_799).contains(&seconds) {
        return None;
    }
    let days = seconds / 86_400 + 719_468;
    let era = days / 146_097;
    let day_of_era = days - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_part = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_part + 2) / 5 + 1;
    let month = month_part + if month_part < 10 { 3 } else { -9 };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    Some(format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        seconds / 3600 % 24,
        seconds / 60 % 60,
        seconds % 60
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn opencode_saved_auth_overrides_environment_and_auth_content_overrides_file() {
        let directory =
            std::env::temp_dir().join(format!("pandacode-usage-auth-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let file = directory.join("auth.json");
        std::fs::write(
            &file,
            br#"{"opencode-go":{"type":"api","key":"file-account-A"}}"#,
        )
        .unwrap();
        for (content, expected) in [
            (None, "file-account-A"),
            (Some(""), "file-account-A"),
            (Some("malformed-json"), "file-account-A"),
            (
                Some(r#"{"opencode-go":{"type":"api","key":"explicit-account-C"}}"#),
                "explicit-account-C",
            ),
            (Some("{}"), "environment-account-B"),
        ] {
            let bytes = opencode_auth_bytes(Some(&file), content).await.unwrap();
            let selected =
                opencode_usage_key(bytes.as_deref(), Some("environment-account-B".into())).unwrap();
            assert_eq!(selected.as_deref(), Some(expected));
        }
        assert!(opencode_usage_key(
            Some(br#"{"opencode-go":{"type":"oauth","access":"unrelated-token"}}"#),
            Some("environment-account-B".into())
        )
        .is_err());
        assert!(opencode_usage_key(
            Some(br#"{"opencode-go":{"type":"api","key":"bad\nheader"}}"#),
            Some("environment-account-B".into())
        )
        .is_err());
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn opencode_does_not_mix_go_and_zen_accounts() {
        let zen = br#"{"opencode":{"type":"api","key":"zen-A"}}"#;
        assert_eq!(
            opencode_usage_key(Some(zen), None).unwrap().as_deref(),
            Some("zen-A")
        );
        assert!(opencode_usage_key(Some(zen), Some("different-Go-environment-B".into())).is_err());
        let wrong_go = br#"{"opencode-go":{"type":"oauth","access":"unusable"},"opencode":{"type":"api","key":"zen-A"}}"#;
        assert!(opencode_usage_key(Some(wrong_go), None).is_err());
    }

    #[test]
    fn usage_key_never_falls_back_to_a_different_account_when_saved_key_is_unreadable() {
        assert_eq!(
            saved_key_or_environment(Ok(Some("saved-A".into())), Some("environment-B".into()))
                .unwrap()
                .as_deref(),
            Some("saved-A")
        );
        assert_eq!(
            saved_key_or_environment(Ok(None), Some("environment-B".into()))
                .unwrap()
                .as_deref(),
            Some("environment-B")
        );
        assert!(saved_key_or_environment(Err(()), Some("environment-B".into())).is_err());
        assert!(saved_key_or_environment(
            Ok(Some("invalid\nkey".into())),
            Some("environment-B".into())
        )
        .is_err());
        assert_eq!(saved_key_or_environment(Ok(None), None).unwrap(), None);
    }

    #[test]
    fn deepseek_balance_parses_totals_and_flags_insufficiency() {
        let usage = parse_deepseek(&json!({
            "is_available": true,
            "balance_infos": [
                {"currency": "CNY", "total_balance": "110.00", "granted_balance": "10.00", "topped_up_balance": "100.00"},
                {"currency": "USD", "total_balance": "12.50", "granted_balance": "0.00", "topped_up_balance": "12.50"}
            ]
        }));
        assert_eq!(usage.status, "ready");
        assert!(usage.windows.is_empty());
        assert_eq!(usage.source.as_deref(), Some("DeepSeek balance API"));
        assert_eq!(
            usage.message.as_deref(),
            Some("Balance CNY 110.00 (granted 10.00, topped up 100.00) · USD 12.50 (granted 0.00, topped up 12.50).")
        );

        let plain = parse_deepseek(&json!({
            "is_available": true,
            "balance_infos": [{"currency": "CNY", "total_balance": "5.00"}]
        }));
        assert_eq!(plain.message.as_deref(), Some("Balance CNY 5.00."));

        let insufficient = parse_deepseek(&json!({
            "is_available": false,
            "balance_infos": [{"currency": "CNY", "total_balance": "0.00"}]
        }));
        assert_eq!(insufficient.status, "unavailable");
        assert!(
            insufficient
                .message
                .as_deref()
                .is_some_and(|message| message.contains("insufficient")),
            "unexpected message: {:?}",
            insufficient.message
        );
    }

    #[test]
    fn deepseek_rejects_unreadable_balances() {
        for body in [
            json!({}),
            json!({"is_available": true}),
            json!({"is_available": true, "balance_infos": []}),
            json!({"is_available": true, "balance_infos": [{"currency": "CNY", "total_balance": "about 110"}]}),
            json!({"is_available": true, "balance_infos": [{"currency": "CNY", "total_balance": "1.2.3"}]}),
            json!({"is_available": true, "balance_infos": [{"currency": "CNY", "total_balance": "."}]}),
            json!({"is_available": true, "balance_infos": [{"currency": "C\nY", "total_balance": "110.00"}]}),
            json!({"is_available": true, "balance_infos": [{"currency": "CNY", "total_balance": 110}]}),
        ] {
            let usage = parse_deepseek(&body);
            assert_eq!(usage.status, "unavailable", "case: {body}");
            assert!(usage.windows.is_empty());
        }
    }

    #[tokio::test]
    async fn kimi_dual_config_roots_require_an_explicit_home_before_reading_credentials() {
        let directory = std::env::temp_dir().join(format!(
            "pandacode-usage-kimi-roots-{}",
            uuid::Uuid::new_v4()
        ));
        let modern = directory.join(".kimi-code");
        let legacy = directory.join(".kimi");
        std::fs::create_dir_all(&modern).unwrap();
        std::fs::create_dir_all(&legacy).unwrap();
        let fixture = |key| {
            json!({"default_model":"model","models":{"model":{"provider":"kimi"}},"providers":{"kimi":{"type":"kimi","base_url":KIMI_BASE,"api_key":key}}}).to_string()
        };
        std::fs::write(legacy.join("config.json"), fixture("legacy-A")).unwrap();
        let selected = unambiguous_kimi_config(&[modern.clone(), legacy.clone()])
            .await
            .unwrap()
            .unwrap();
        assert_eq!(selected.0, legacy);
        std::fs::write(modern.join("config.json"), fixture("modern-B")).unwrap();
        let error = unambiguous_kimi_config(&[modern.clone(), legacy.clone()])
            .await
            .err()
            .unwrap();
        assert_eq!(error.status, "unavailable");
        assert!(error.windows.is_empty());
        let (_, selected) = unambiguous_kimi_config(&[modern]).await.unwrap().unwrap();
        assert_eq!(
            selected_kimi_provider(selected).unwrap().api_key.as_deref(),
            Some("modern-B")
        );
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn kimi_raw_ratio_pools_preserve_precision_and_absent_windows() {
        let usage = parse_kimi(&json!({"usages":{
            "limit_5h":{"used_ratio":"0.0125","reset_time":"2026-09-22T18:00:00Z"},
            "limit_7d":{"used_ratio":0},
            "limit_month_total":{"used_ratio":0.4},
            "limit_month_code":{"used_ratio":null}
        },"usage":{"limit":"100","used":"99"}}));
        assert_eq!(usage.status, "ready");
        assert_eq!(usage.windows.len(), 3);
        assert_eq!(usage.windows[0].used_percent, 1.25);
        assert_eq!(usage.windows[1].used_percent, 0.0);
        assert_eq!(usage.windows[2].used_percent, 40.0);
    }

    #[test]
    fn kimi_legacy_counts_do_not_guess_missing_or_zero_denominators() {
        let usage = parse_kimi(
            &json!({"usage":{"limit":"2048","used":"214","resetTime":"2026-01-09T15:23:13.716839300Z"},"limits":[{"window":{"duration":300,"timeUnit":"TIME_UNIT_MINUTE"},"detail":{"limit":"200","used":"139"}}]}),
        );
        assert_eq!(usage.windows.len(), 2);
        assert_eq!(usage.windows[0].used_percent, 69.5);
        assert_eq!(usage.windows[1].used_percent, 214.0 / 2048.0 * 100.0);
        for body in [
            json!({}),
            json!({"usage":{"limit":0,"used":0}}),
            json!({"usage":{"limit":100}}),
            json!({"usages":{"limit_5h":{"used_ratio":"NaN"}}}),
        ] {
            let result = parse_kimi(&body);
            assert_eq!(result.status, "unavailable");
            assert!(result.windows.is_empty());
        }
    }

    #[test]
    fn opencode_percent_is_already_a_percentage_and_scope_is_explicit() {
        let usage = parse_opencode(
            &json!({"usage":{"rolling":{"status":"ok","percent":1,"resetsAt":"2026-09-22T12:30:00.000Z"},"weekly":{"status":"ok","percent":0.5},"monthly":{"status":"rate-limited","percent":100}}}),
        );
        assert_eq!(
            usage
                .windows
                .iter()
                .map(|w| w.used_percent)
                .collect::<Vec<_>>(),
            vec![1.0, 0.5, 100.0]
        );
        assert_eq!(usage.plan.as_deref(), Some("OpenCode Go"));
        assert!(usage.message.unwrap().contains("Other connected providers"));
        assert!(parse_opencode(&json!({"usage":{"rolling":{"percent":0}}}))
            .windows
            .is_empty());
        assert!(
            parse_opencode(&json!({"usage":{"rolling":{"status":"ok","percent":null}}}))
                .windows
                .is_empty()
        );
    }

    #[test]
    fn glm_supports_token_credit_and_separate_mcp_quotas() {
        let usage = parse_glm(&json!({"success":true,"code":200,"data":{"limits":[
            {"type":"TOKENS_LIMIT","unit":3,"number":5,"percentage":23,"nextResetTime":0},
            {"type":"CREDIT_LIMIT","unit":6,"number":1,"usage":200,"currentValue":50,"percentage":99,"nextResetTime":1789437600000_i64},
            {"type":"TIME_LIMIT","unit":5,"number":1,"percentage":0},
            {"type":"UNKNOWN","percentage":100},
            {"type":"TOKENS_LIMIT","percentage":null}
        ]}}));
        assert_eq!(usage.windows.len(), 3);
        assert_eq!(usage.windows[0].label, "5 hours");
        assert_eq!(usage.windows[1].used_percent, 25.0);
        assert_eq!(usage.windows[1].label, "7 days");
        assert_eq!(usage.windows[2].label, "Monthly MCP tools");
        assert!(usage.windows[0].resets_at.is_none());
        assert_eq!(
            usage.windows[1].resets_at.as_deref(),
            Some("2026-09-15T02:00:00Z")
        );
    }

    #[test]
    fn upstream_errors_and_unknown_fields_never_become_usage_or_leak_diagnostics() {
        let value = json!({"success":false,"code":401,"message":"PRIVATE_TOKEN","data":{"limits":[{"type":"TOKENS_LIMIT","percentage":0}]}});
        let usage = parse_glm(&value);
        assert_eq!(usage.status, "unavailable");
        assert!(!serde_json::to_string(&usage)
            .unwrap()
            .contains("PRIVATE_TOKEN"));
        assert!(
            parse_glm(&json!({"data":{"limits":[{"type":"TOKENS_LIMIT","percentage":null}]}}))
                .windows
                .is_empty()
        );
    }

    #[test]
    fn exact_opencode_auth_fields_ignore_downstream_and_oauth_keys() {
        assert_eq!(opencode_key(br#"{"opencode-go":{"type":"api","key":"go-key"},"opencode":{"type":"api","key":"zen-key"},"openai":{"type":"oauth","access":"PRIVATE"}}"#).as_deref(), Some("go-key"));
        assert_eq!(
            opencode_key(br#"{"opencode":{"type":"api","key":"zen-key"}}"#).as_deref(),
            Some("zen-key")
        );
        assert!(opencode_key(br#"{"opencode-go":{"type":"oauth","key":"wrong-type"},"openai":{"type":"api","key":"wrong-provider"}}"#).is_none());
        assert!(opencode_key(br#"{"opencode":{"type":"api","key":"bad\nheader"}}"#).is_none());
    }

    #[test]
    fn kimi_credentials_require_fresh_access_token_and_default_issuer_context() {
        let fixture =
            br#"{"access_token":"fresh-token","expires_at":2000,"refresh_token":"NEVER_USE"}"#;
        assert_eq!(kimi_token(fixture, 1000.0).as_deref(), Some("fresh-token"));
        assert!(kimi_token(fixture, 1980.0).is_none());
        assert!(kimi_token(br#"{"refresh_token":"NEVER_USE"}"#, 0.0).is_none());
        assert!(default_kimi_oauth(None, None, None));
        assert!(!default_kimi_oauth(Some(KIMI_GLOBAL_BASE), None, None));
        assert!(!default_kimi_oauth(
            None,
            Some("https://custom.invalid"),
            None
        ));
        for endpoint in [
            "https://api.kimi.com.evil.test/coding/v1",
            "http://api.kimi.com/coding/v1",
            "https://secret@api.kimi.com/coding/v1",
            "https://api.kimi.com/coding/v1?key=secret",
        ] {
            assert!(kimi_endpoint(Some(endpoint)).is_none());
        }
    }

    #[test]
    fn kimi_toml_selects_only_the_default_models_provider() {
        let legacy = r#"
default_model = "coding-model"
[models.coding-model]
provider = "my-kimi"
[providers.my-kimi]
type = "kimi"
base_url = "https://api.kimi.com/coding/v1"
api_key = "selected-key"
[providers.other]
type = "openai"
base_url = "https://unrelated.invalid"
api_key = "PRIVATE_UNRELATED_KEY"
"#;
        let config: KimiConfig = toml::from_str(legacy).unwrap();
        let selected = selected_kimi_provider(config).unwrap();
        assert_eq!(selected.api_key.as_deref(), Some("selected-key"));
        assert_eq!(
            kimi_endpoint(selected.base_url.as_deref()),
            Some("https://api.kimi.com/coding/v1/usages")
        );
        let modern = r#"
defaultModel = "kimi-code/k3"
[models."kimi-code/k3"]
provider = "managed:kimi-code"
[providers."managed:kimi-code"]
type = "kimi"
baseUrl = "https://api.kimi.com/coding/v1"
apiKey = ""
[providers."managed:kimi-code".oauth]
storage = "file"
key = "oauth/kimi-code"
"#;
        let config: KimiConfig = toml::from_str(modern).unwrap();
        assert_eq!(
            selected_kimi_provider(config).unwrap().oauth.unwrap().key,
            "oauth/kimi-code"
        );
        for config in [
            json!({"providers":{"managed:kimi-code":{"type":"kimi","api_key":"UNSELECTED"}}}),
            json!({"default_model":"other","models":{"other":{"provider":"missing"}},"providers":{}}),
            json!({"default_model":"other","models":{"other":{"provider":"openai"}},"providers":{"openai":{"type":"openai","api_key":"WRONG_PROVIDER"}}}),
        ] {
            let result = selected_kimi_provider(serde_json::from_value(config).unwrap());
            let error = result.err().unwrap();
            assert!(error.windows.is_empty());
            let serialized = serde_json::to_string(&error).unwrap();
            assert!(!serialized.contains("UNSELECTED") && !serialized.contains("WRONG_PROVIDER"));
        }
    }

    #[tokio::test]
    async fn kimi_config_uses_toml_before_legacy_json_without_account_fallback_on_error() {
        let directory =
            std::env::temp_dir().join(format!("pandacode-usage-kimi-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        assert!(read_kimi_config(&directory).await.unwrap().is_none());
        let json_config = json!({"default_model":"model","models":{"model":{"provider":"kimi"}},"providers":{"kimi":{"type":"kimi","base_url":KIMI_BASE,"api_key":"fixture-key"}}});
        std::fs::write(directory.join("config.json"), json_config.to_string()).unwrap();
        let config = read_kimi_config(&directory).await.unwrap().unwrap();
        assert_eq!(
            selected_kimi_provider(config).unwrap().api_key.as_deref(),
            Some("fixture-key")
        );
        std::fs::write(directory.join("config.toml"), "INVALID PRIVATE_DIAGNOSTIC").unwrap();
        let error = read_kimi_config(&directory).await.err().unwrap();
        assert!(!serde_json::to_string(&error)
            .unwrap()
            .contains("PRIVATE_DIAGNOSTIC"));
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn credential_reader_is_bounded_and_read_only() {
        let directory =
            std::env::temp_dir().join(format!("pandacode-usage-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join("auth.json");
        assert!(credential_bytes(&path).await.unwrap().is_none());
        std::fs::write(&path, b"{}\n").unwrap();
        assert_eq!(credential_bytes(&path).await.unwrap().unwrap(), b"{}\n");
        assert_eq!(std::fs::read(&path).unwrap(), b"{}\n");
        std::fs::write(&path, vec![b' '; CREDENTIAL_LIMIT as usize + 1]).unwrap();
        assert!(credential_bytes(&path).await.is_err());
        assert!(credential_bytes(&directory).await.is_err());
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn timestamps_are_utc_and_handle_leap_centuries_and_bounds() {
        assert_eq!(epoch_iso(0).as_deref(), Some("1970-01-01T00:00:00Z"));
        assert_eq!(
            epoch_iso(951_782_400).as_deref(),
            Some("2000-02-29T00:00:00Z")
        );
        assert_eq!(
            epoch_iso(4_107_542_400).as_deref(),
            Some("2100-03-01T00:00:00Z")
        );
        assert_eq!(
            epoch_iso(253_402_300_799).as_deref(),
            Some("9999-12-31T23:59:59Z")
        );
        assert!(epoch_iso(-1).is_none());
        assert!(epoch_iso(i64::MAX).is_none());
        assert!(reset(&json!("PRIVATE_TOKEN")).is_none());
    }

    #[test]
    fn antigravity_version_gate_rejects_older_and_ambiguous_versions() {
        for version in ["1.1.11", "1.2.2", "2.0.0", "1.1.11\n"] {
            assert!(
                antigravity_version_supported(version.as_bytes()),
                "{version}"
            );
        }
        for version in [
            "1.0.6",
            "1.1.10",
            "1.2.2-preview",
            "1.2.2.3",
            "+1.2.2",
            "",
            "unknown",
            "agy 1.2.2",
        ] {
            assert!(
                !antigravity_version_supported(version.as_bytes()),
                "{version}"
            );
        }
    }

    fn antigravity_fixture() -> Value {
        json!({"status":"SUCCESS","num_turns":0,"usage":{"total_tokens":0},"command":{"name":"usage","data":{"groups":[
            {"name":"Gemini Models","buckets":[{"id":"gemini-5h","remaining_fraction":0.95,"reset_time":"2026-09-23T03:48:04Z"},{"id":"gemini-weekly","remaining_fraction":0.86}]},
            {"name":"Claude and GPT models","buckets":[{"window":"5h","remaining_fraction":1.0},{"window":"weekly","remaining_fraction":0.89},{"window":"monthly","disabled":true,"remaining_fraction":0.0},{"window":"monthly","remaining_fraction":null}]}
        ]}}})
    }

    #[test]
    fn antigravity_uses_native_remaining_fractions_and_skips_unavailable_buckets() {
        let result = parse_antigravity(&antigravity_fixture());
        assert_eq!(result.status, "ready");
        assert_eq!(result.windows.len(), 4);
        assert!((result.windows[0].used_percent - 5.0).abs() < 0.0001);
        assert_eq!(result.windows[2].used_percent, 0.0);
        for replacement in [json!("ERROR"), json!("PENDING"), json!("success")] {
            let mut fixture = antigravity_fixture();
            fixture["status"] = replacement;
            assert_eq!(parse_antigravity(&fixture).status, "unavailable");
        }
        let mut fixture = antigravity_fixture();
        fixture["command"]["name"] = json!("models");
        assert!(parse_antigravity(&fixture).windows.is_empty());
        let mut fixture = antigravity_fixture();
        fixture["usage"]["total_tokens"] = json!(100);
        assert!(parse_antigravity(&fixture).windows.is_empty());
    }

    #[cfg(unix)]
    fn agy_script(directory: &Path, version: &str, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = directory.join("agy");
        std::fs::write(&path, format!("#!/bin/sh\nif [ \"$1\" = '--version' ]; then printf '%s' '{version}'; exit 0; fi\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        path
    }

    #[cfg(unix)]
    #[test]
    fn antigravity_old_cli_never_gets_a_prompt_and_new_cli_uses_exact_report_command() {
        let directory =
            std::env::temp_dir().join(format!("pandacode-usage-agy-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let path = agy_script(&directory, "1.0.6", "touch prompt-was-invoked; exit 7");
        assert_eq!(
            antigravity_report(&path, &directory, Duration::from_secs(1)).status,
            "unsupported"
        );
        assert!(!directory.join("prompt-was-invoked").exists());
        let body = format!("[ \"$*\" = '-p /usage --output-format json --print-timeout 12s' ] || exit 7\n[ -z \"${{ANTIGRAVITY_OAUTH_CREDENTIALS_JSON+x}}\" ] || exit 8\ncat <<'REPORT'\n{}\nREPORT", antigravity_fixture());
        let path = agy_script(&directory, "1.1.11", &body);
        assert_eq!(
            antigravity_report(&path, &directory, Duration::from_secs(1)).status,
            "ready"
        );
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn antigravity_report_timeout_output_limit_and_stderr_are_bounded() {
        let directory =
            std::env::temp_dir().join(format!("pandacode-usage-agy-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        for body in [
            "printf PRIVATE_DIAGNOSTIC >&2; exit 7",
            "/usr/bin/head -c 300000 /dev/zero",
            "exec /bin/sleep 10",
        ] {
            let started_file = directory.join("report-started");
            let path = agy_script(
                &directory,
                "1.1.11",
                &format!("printf ran > report-started\n{body}"),
            );
            let started = std::time::Instant::now();
            let result = antigravity_report(&path, &directory, Duration::from_millis(100));
            assert!(
                started_file.exists(),
                "The report must run after the version check"
            );
            assert_eq!(result.status, "unavailable");
            assert!(!serde_json::to_string(&result)
                .unwrap()
                .contains("PRIVATE_DIAGNOSTIC"));
            // Includes the separate three-second version check and process
            // startup. Still fails if the ten-second fixture is not killed.
            assert!(started.elapsed() < Duration::from_secs(5));
            std::fs::remove_file(started_file).unwrap();
        }
        std::fs::remove_dir_all(directory).unwrap();
    }
}
