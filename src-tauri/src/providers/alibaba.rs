//! Alibaba Cloud Model Studio Token Plan through Claude Code: the plan's
//! Anthropic-compatible endpoint with its dedicated `sk-sp-` key. Overrides are
//! private to this child; the user's Claude configuration is untouched.
//! Documented at https://www.alibabacloud.com/help/en/model-studio/claude-code-token-plan
//! (models: .../token-plan-personal-overview, "Supported models").
use super::ModelInfo;
use tokio::process::Command;

/// The plan is sold in Singapore only (Personal Edition overview), so there is
/// one endpoint and nothing to choose.
pub(super) const ENDPOINT: &str = "https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic";
/// Every Claude Code slot must name a Token Plan model or requests fail; the
/// documented mapping puts Max in the main/Opus slots and Flash in Sonnet/Haiku.
pub(super) const DEFAULT_MODEL: &str = "qwen3.8-max";
pub(super) const FAST_MODEL: &str = "qwen3.8-flash";

const KEY_HINT: &str = "Token Plan keys start with sk-sp-; a Coding Plan or pay-as-you-go key is rejected with 401.";

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
        format!("Add your Alibaba Token Plan API key in Settings → Agents → Provider connections, or set ALIBABA_TOKEN_PLAN_API_KEY. {KEY_HINT}")
    })
}

pub(super) fn environment() -> Result<Vec<(String, String)>, String> {
    let key = resolve_key(
        crate::provider_settings::alibaba_key(),
        std::env::var(crate::provider_settings::ALIBABA_KEY.env).ok(),
    )?;
    Ok(vec![
        ("ANTHROPIC_AUTH_TOKEN".into(), key),
        ("ANTHROPIC_BASE_URL".into(), ENDPOINT.into()),
        ("ANTHROPIC_MODEL".into(), DEFAULT_MODEL.into()),
        ("ANTHROPIC_DEFAULT_SONNET_MODEL".into(), FAST_MODEL.into()),
        ("ANTHROPIC_DEFAULT_OPUS_MODEL".into(), DEFAULT_MODEL.into()),
        ("ANTHROPIC_DEFAULT_HAIKU_MODEL".into(), FAST_MODEL.into()),
        ("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC".into(), "1".into()),
    ])
}

pub(super) fn configure(command: &mut Command) -> Result<String, String> {
    let env = environment()?;
    let key = env.iter().find(|(name, _)| name == "ANTHROPIC_AUTH_TOKEN").unwrap().1.clone();
    apply_environment(command, &key);
    Ok(key)
}

/// Settings-file isolation, as for GLM and MiMo: inherited Claude credentials or
/// gateways must never replace the Token Plan endpoint; the key stays out of argv.
pub(super) fn arguments() -> Vec<String> {
    vec!["--setting-sources".into(), "".into(), "--settings".into(), serde_json::json!({"env":{
        "ANTHROPIC_BASE_URL": ENDPOINT,
        "ANTHROPIC_API_KEY":"", "CLAUDE_CODE_OAUTH_TOKEN":"",
        "CLAUDE_CODE_USE_BEDROCK":"", "CLAUDE_CODE_USE_VERTEX":"", "CLAUDE_CODE_USE_FOUNDRY":"",
        "ANTHROPIC_DEFAULT_SONNET_MODEL":FAST_MODEL,"ANTHROPIC_DEFAULT_OPUS_MODEL":DEFAULT_MODEL,
        "ANTHROPIC_DEFAULT_HAIKU_MODEL":FAST_MODEL, "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB":"1",
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC":"1"
    }}).to_string()]
}

fn apply_environment(command: &mut Command, key: &str) {
    command.args(arguments());
    command
        .env("ANTHROPIC_BASE_URL", ENDPOINT)
        .env("ANTHROPIC_AUTH_TOKEN", key)
        .env_remove("ANTHROPIC_API_KEY")
        .env_remove("CLAUDE_CODE_OAUTH_TOKEN")
        .env_remove("ZAI_API_KEY")
        .env_remove("MIMO_API_KEY")
        .env_remove("ALIBABA_TOKEN_PLAN_API_KEY")
        .env("CLAUDE_CODE_SUBPROCESS_ENV_SCRUB", "1")
        .env("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1")
        .env_remove("CLAUDE_CODE_USE_BEDROCK")
        .env_remove("CLAUDE_CODE_USE_VERTEX")
        .env_remove("CLAUDE_CODE_USE_FOUNDRY")
        .env("ANTHROPIC_MODEL", DEFAULT_MODEL)
        .env("ANTHROPIC_DEFAULT_SONNET_MODEL", FAST_MODEL)
        .env("ANTHROPIC_DEFAULT_OPUS_MODEL", DEFAULT_MODEL)
        .env("ANTHROPIC_DEFAULT_HAIKU_MODEL", FAST_MODEL);
}

pub(super) fn models() -> Vec<ModelInfo> {
    // The text models from the Token Plan's "Supported models" list (image,
    // audio, video and dated snapshots left out). Custom IDs stay available.
    [
        ("qwen3.8-max", "Qwen3.8-Max", "Qwen flagship."),
        ("qwen3.8-flash", "Qwen3.8-Flash", "Fast Qwen model; used for background work."),
        ("qwen4-max-preview", "Qwen4-Max-Preview", "Preview; retires after November 25, 2026."),
        ("qwen3.7-max", "Qwen3.7-Max", "Previous Qwen flagship."),
        ("qwen3.7-plus", "Qwen3.7-Plus", "Balanced Qwen model."),
        ("qwen3.6-flash", "Qwen3.6-Flash", "Lightweight Qwen model."),
        ("auto", "Auto", "Token Plan picks the model. No forced tool choice or thinking budgets."),
        ("deepseek-v4-pro", "DeepSeek-V4-Pro", "DeepSeek on Token Plan."),
        ("deepseek-v4.1-flash", "DeepSeek-V4.1-Flash", "Fast DeepSeek on Token Plan."),
        ("glm-5.3", "GLM-5.3", "Zhipu GLM on Token Plan."),
        ("glm-5.2", "GLM-5.2", "Previous Zhipu GLM on Token Plan."),
    ]
    .into_iter()
    .map(|(id, name, description)| ModelInfo {
        speed_tiers: Vec::new(),
        id: id.into(),
        name: name.into(),
        description: format!("{description} Availability depends on your plan."),
        reasoning_efforts: Vec::new(),
        default_reasoning_effort: None,
        context_window: None,
    })
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_is_the_documented_token_plan_url() {
        assert_eq!(ENDPOINT, "https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic");
        assert!(!ENDPOINT.contains("coding") && !ENDPOINT.contains("dashscope"));
    }

    #[test]
    fn key_resolution_prefers_saved_then_environment_and_never_echoes_values() {
        assert_eq!(resolve_key(Ok(Some("sk-sp-saved".into())), Some("sk-sp-env".into())).unwrap(), "sk-sp-saved");
        assert_eq!(resolve_key(Ok(None), Some(" sk-sp-env ".into())).unwrap(), "sk-sp-env");
        assert_eq!(resolve_key(Err("Keyring is locked".into()), Some("sk-sp-env".into())).unwrap(), "sk-sp-env");
        assert_eq!(resolve_key(Err("Keyring is locked".into()), None).unwrap_err(), "Keyring is locked");
        let missing = resolve_key(Ok(None), None).unwrap_err();
        assert!(missing.contains("ALIBABA_TOKEN_PLAN_API_KEY") && missing.contains("Provider connections"));
        assert!(missing.contains("Coding Plan") && missing.contains("401"));
        assert!(resolve_key(Ok(None), Some("bad\nkey".into())).is_err());
    }

    #[test]
    fn credentials_are_environment_only_and_settings_isolate_the_endpoint() {
        let mut command = Command::new("claude");
        apply_environment(&mut command, "sk-sp-test-secret");
        let env: std::collections::HashMap<_, _> = command.as_std().get_envs().collect();
        let value = |name: &str| env[std::ffi::OsStr::new(name)].map(|v| v.to_string_lossy().into_owned());
        assert_eq!(value("ANTHROPIC_AUTH_TOKEN").as_deref(), Some("sk-sp-test-secret"));
        assert_eq!(value("ANTHROPIC_BASE_URL").as_deref(), Some(ENDPOINT));
        for slot in ["ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL"] {
            let model = value(slot).unwrap();
            assert!(models().iter().any(|known| known.id == model), "{slot} = {model} is not a Token Plan model");
        }
        assert_eq!(value("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC").as_deref(), Some("1"));
        assert_eq!(env[std::ffi::OsStr::new("ANTHROPIC_API_KEY")], None);
        assert_eq!(env[std::ffi::OsStr::new("ALIBABA_TOKEN_PLAN_API_KEY")], None);
        let args: Vec<String> = command.as_std().get_args().map(|arg| arg.to_string_lossy().into_owned()).collect();
        assert!(args.iter().all(|arg| !arg.contains("sk-sp-test-secret")));
        assert_eq!(args[0..2], ["--setting-sources", ""]);
        let settings: serde_json::Value = serde_json::from_str(&args[3]).unwrap();
        assert_eq!(settings["env"]["ANTHROPIC_BASE_URL"], ENDPOINT);
        assert_eq!(settings["env"]["ANTHROPIC_API_KEY"], "");
        assert_eq!(settings["env"]["ANTHROPIC_DEFAULT_HAIKU_MODEL"], FAST_MODEL);
        assert_eq!(models()[0].id, DEFAULT_MODEL);
    }
}
