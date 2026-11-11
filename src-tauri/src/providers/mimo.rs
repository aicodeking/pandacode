//! Xiaomi MiMo through Claude Code: the Token Plan's per-cluster Anthropic-
//! compatible endpoints (or pay-as-you-go) with a `tp-`/`ttp-`/`sk-` key.
//! Overrides are private to this child; the user's Claude configuration is untouched.
//! Documented at https://mimo.mi.com/docs/en-US/tokenplan/integration/claudecode.
use super::ModelInfo;
use tokio::process::Command;

pub(super) const DEFAULT_MODEL: &str = "mimo-v2.6-pro";
/// Claude Code's Haiku slot runs background work; Flash costs a third of Pro there.
pub(super) const FAST_MODEL: &str = "mimo-v2.6-flash";

/// Clusters shown on the Token Plan page, plus the pay-as-you-go API.
pub(crate) const ENDPOINTS: [(&str, &str, &str); 4] = [
    ("token-plan-cn", "https://token-plan-cn.xiaomimimo.com/anthropic", "Token Plan · China cluster"),
    ("token-plan-sgp", "https://token-plan-sgp.xiaomimimo.com/anthropic", "Token Plan · Singapore cluster"),
    ("token-plan-ams", "https://token-plan-ams.xiaomimimo.com/anthropic", "Token Plan · Europe cluster"),
    ("api", "https://api.xiaomimimo.com/anthropic", "Pay-as-you-go API"),
];

pub(crate) fn endpoint_url(id: &str) -> Option<&'static str> {
    ENDPOINTS.iter().find(|(known, _, _)| *known == id).map(|(_, url, _)| *url)
}

fn resolve_endpoint(saved: Option<String>) -> Result<&'static str, String> {
    saved
        .as_deref()
        .and_then(endpoint_url)
        .ok_or_else(|| "Choose your MiMo Token Plan cluster in Settings → Agents → Provider connections.".into())
}

fn resolve_key(
    saved: Result<Option<String>, String>,
    environment: Option<String>,
) -> Result<String, String> {
    let saved = saved.and_then(|key| {
        key.map(|key| crate::provider_settings::validate_key(&key).map(str::to_owned))
            .transpose()
    });
    if let Ok(Some(key)) = &saved {
        return Ok(key.clone());
    }
    if let Some(key) = environment.filter(|key| !key.trim().is_empty()) {
        return crate::provider_settings::validate_key(&key).map(str::to_owned);
    }
    saved?.ok_or_else(|| {
        "Add your MiMo API key in Settings → Agents → Provider connections, or set MIMO_API_KEY.".into()
    })
}

pub(super) fn environment() -> Result<Vec<(String, String)>, String> {
    let endpoint = resolve_endpoint(crate::provider_settings::mimo_endpoint())?;
    let key = resolve_key(
        crate::provider_settings::mimo_key(),
        std::env::var(crate::provider_settings::MIMO_KEY.env).ok(),
    )?;
    Ok(vec![
        ("ANTHROPIC_AUTH_TOKEN".into(), key),
        ("ANTHROPIC_BASE_URL".into(), endpoint.into()),
        ("ANTHROPIC_MODEL".into(), DEFAULT_MODEL.into()),
        ("ANTHROPIC_DEFAULT_SONNET_MODEL".into(), DEFAULT_MODEL.into()),
        ("ANTHROPIC_DEFAULT_OPUS_MODEL".into(), DEFAULT_MODEL.into()),
        ("ANTHROPIC_DEFAULT_HAIKU_MODEL".into(), FAST_MODEL.into()),
        ("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC".into(), "1".into()),
    ])
}

pub(super) fn configure(command: &mut Command) -> Result<String, String> {
    let env = environment()?;
    let endpoint = env.iter().find(|(name, _)| name == "ANTHROPIC_BASE_URL").unwrap().1.clone();
    let key = env.iter().find(|(name, _)| name == "ANTHROPIC_AUTH_TOKEN").unwrap().1.clone();
    apply_environment(command, &endpoint, &key);
    Ok(key)
}

/// Settings-file isolation, as for GLM: inherited Claude credentials or gateways
/// must never replace the MiMo endpoint; the key itself stays out of argv.
pub(super) fn arguments(endpoint: &str) -> Vec<String> {
    vec!["--setting-sources".into(), "".into(), "--settings".into(), serde_json::json!({"env":{
        "ANTHROPIC_BASE_URL": endpoint,
        "ANTHROPIC_API_KEY":"", "CLAUDE_CODE_OAUTH_TOKEN":"",
        "CLAUDE_CODE_USE_BEDROCK":"", "CLAUDE_CODE_USE_VERTEX":"", "CLAUDE_CODE_USE_FOUNDRY":"",
        "ANTHROPIC_DEFAULT_SONNET_MODEL":DEFAULT_MODEL,"ANTHROPIC_DEFAULT_OPUS_MODEL":DEFAULT_MODEL,
        "ANTHROPIC_DEFAULT_HAIKU_MODEL":FAST_MODEL, "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB":"1",
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC":"1"
    }}).to_string()]
}

pub(super) fn saved_arguments() -> Result<Vec<String>, String> {
    Ok(arguments(resolve_endpoint(crate::provider_settings::mimo_endpoint())?))
}

fn apply_environment(command: &mut Command, endpoint: &str, key: &str) {
    command.args(arguments(endpoint));
    command
        .env("ANTHROPIC_BASE_URL", endpoint)
        .env("ANTHROPIC_AUTH_TOKEN", key)
        .env_remove("ANTHROPIC_API_KEY")
        .env_remove("CLAUDE_CODE_OAUTH_TOKEN")
        .env_remove("ZAI_API_KEY")
        .env_remove("MIMO_API_KEY")
        .env("CLAUDE_CODE_SUBPROCESS_ENV_SCRUB", "1")
        .env("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1")
        .env_remove("CLAUDE_CODE_USE_BEDROCK")
        .env_remove("CLAUDE_CODE_USE_VERTEX")
        .env_remove("CLAUDE_CODE_USE_FOUNDRY")
        .env("ANTHROPIC_MODEL", DEFAULT_MODEL)
        .env("ANTHROPIC_DEFAULT_SONNET_MODEL", DEFAULT_MODEL)
        .env("ANTHROPIC_DEFAULT_OPUS_MODEL", DEFAULT_MODEL)
        .env("ANTHROPIC_DEFAULT_HAIKU_MODEL", FAST_MODEL);
}

pub(super) fn models() -> Vec<ModelInfo> {
    // Documented Token Plan IDs. `[1m]` is Claude Code's suffix for the 1M-token
    // context mode on models that support it. Custom IDs stay available.
    [
        ("mimo-v2.6-pro", "MiMo-V2.6-Pro", "Flagship. Token Plan and pay-as-you-go."),
        ("mimo-v2.6-pro[1m]", "MiMo-V2.6-Pro · 1M context", "Flagship with the extended 1M-token context window."),
        ("mimo-v2.6-flash", "MiMo-V2.6-Flash", "Fast and a third of Pro's credit cost."),
        ("mimo-v2.5-pro", "MiMo-V2.5-Pro", "Previous flagship. Retires on October 21, 2026."),
        ("mimo-v2.5", "MiMo-V2.5", "Previous omni model. Retires on October 21, 2026."),
    ]
    .into_iter()
    .map(|(id, name, description)| ModelInfo {
        id: id.into(),
        name: name.into(),
        description: format!("{description} Availability depends on your plan."),
        reasoning_efforts: Vec::new(),
        default_reasoning_effort: None,
        context_window: None,
        ..ModelInfo::default()
    })
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoints_are_the_documented_clusters_and_nothing_else() {
        assert_eq!(endpoint_url("token-plan-cn"), Some("https://token-plan-cn.xiaomimimo.com/anthropic"));
        assert_eq!(endpoint_url("token-plan-ams"), Some("https://token-plan-ams.xiaomimimo.com/anthropic"));
        assert_eq!(endpoint_url("api"), Some("https://api.xiaomimimo.com/anthropic"));
        assert_eq!(endpoint_url("https://token-plan-cn.xiaomimimo.com/anthropic"), None);
        assert!(resolve_endpoint(None).unwrap_err().contains("cluster"));
        assert!(resolve_endpoint(Some("nope".into())).is_err());
    }

    #[test]
    fn key_resolution_prefers_saved_then_environment_and_never_echoes_values() {
        assert_eq!(resolve_key(Ok(Some("tp-saved".into())), Some("tp-env".into())).unwrap(), "tp-saved");
        assert_eq!(resolve_key(Ok(None), Some(" tp-env ".into())).unwrap(), "tp-env");
        assert_eq!(resolve_key(Err("Keyring is locked".into()), Some("tp-env".into())).unwrap(), "tp-env");
        assert_eq!(resolve_key(Err("Keyring is locked".into()), None).unwrap_err(), "Keyring is locked");
        let missing = resolve_key(Ok(None), None).unwrap_err();
        assert!(missing.contains("MIMO_API_KEY") && missing.contains("Provider connections"));
        assert!(resolve_key(Ok(None), Some("bad\nkey".into())).is_err());
    }

    #[test]
    fn credentials_are_environment_only_and_settings_isolate_the_endpoint() {
        let mut command = Command::new("claude");
        apply_environment(&mut command, endpoint_url("token-plan-sgp").unwrap(), "tp-test-secret");
        let env: std::collections::HashMap<_, _> = command.as_std().get_envs().collect();
        let value = |name: &str| env[std::ffi::OsStr::new(name)].map(|v| v.to_string_lossy().into_owned());
        assert_eq!(value("ANTHROPIC_AUTH_TOKEN").as_deref(), Some("tp-test-secret"));
        assert_eq!(value("ANTHROPIC_BASE_URL").as_deref(), Some("https://token-plan-sgp.xiaomimimo.com/anthropic"));
        assert_eq!(value("ANTHROPIC_DEFAULT_HAIKU_MODEL").as_deref(), Some(FAST_MODEL));
        assert_eq!(value("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC").as_deref(), Some("1"));
        assert_eq!(env[std::ffi::OsStr::new("ANTHROPIC_API_KEY")], None);
        assert_eq!(env[std::ffi::OsStr::new("MIMO_API_KEY")], None);
        let args: Vec<String> = command.as_std().get_args().map(|arg| arg.to_string_lossy().into_owned()).collect();
        assert!(args.iter().all(|arg| !arg.contains("tp-test-secret")));
        assert_eq!(args[0..2], ["--setting-sources", ""]);
        let settings: serde_json::Value = serde_json::from_str(&args[3]).unwrap();
        assert_eq!(settings["env"]["ANTHROPIC_BASE_URL"], "https://token-plan-sgp.xiaomimimo.com/anthropic");
        assert_eq!(settings["env"]["ANTHROPIC_API_KEY"], "");
        assert!(models().iter().all(|model| model.id.starts_with("mimo-") && model.name.starts_with("MiMo-")));
        assert_eq!(models()[0].id, DEFAULT_MODEL);
        assert!(models().iter().any(|model| model.id == "mimo-v2.6-pro[1m]"));
    }
}
