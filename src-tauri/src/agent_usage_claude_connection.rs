//! Which connection Claude uses when it is not the saved subscription login:
//! cloud providers, custom endpoints, API keys, helpers, workload identity,
//! or a `CLAUDE_CODE_OAUTH_TOKEN`, in Claude Code's own order.

use super::*;

#[cfg(test)]
pub(crate) fn claude_override(
    inherit: bool,
    env: impl Fn(&str) -> Option<String>,
    settings: &Value,
) -> bool {
    override_source(inherit, env, settings).is_some()
}

/// Where a non-subscription connection comes from: Claude's `settings.json`
/// (read by Claude itself, always in effect), an administrator's
/// `managed-settings.json` (over it), the launch environment, or a named
/// connection's own variables.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum OverrideFrom {
    Settings,
    Managed,
    Environment,
    Connection,
}

const PROVIDER_SWITCHES: [&str; 3] = ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"];
const KEY_VARIABLES: [&str; 2] = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"];
const IDENTITY_VARIABLES: [&str; 3] = ["ANTHROPIC_PROFILE", "ANTHROPIC_FEDERATION_RULE_ID", "ANTHROPIC_IDENTITY_TOKEN_FILE"];
/// A token Claude Code uses instead of the saved login; it may be a
/// subscription OAuth token, so its usage is read rather than dismissed.
pub(crate) const OAUTH_TOKEN_VARIABLE: &str = "CLAUDE_CODE_OAUTH_TOKEN";

/// A variable's value as Claude gets it: `settings.json` first (Claude
/// applies its `env` over the process), else the launch environment.
fn variable(inherit: bool, env: &impl Fn(&str) -> Option<String>, settings: &Value, name: &str) -> Option<(String, OverrideFrom)> {
    settings["env"][name]
        .as_str()
        .map(|value| (value.to_owned(), OverrideFrom::Settings))
        .or_else(|| inherit.then(|| env(name)).flatten().map(|value| (value, OverrideFrom::Environment)))
}

/// Where `name` is set to something that counts (`test`), its value wiped.
fn set_where(inherit: bool, env: &impl Fn(&str) -> Option<String>, settings: &Value, name: &str, test: fn(&str) -> bool) -> Option<OverrideFrom> {
    let (mut value, from) = variable(inherit, env, settings, name)?;
    let counts = test(value.trim());
    wipe(&mut value);
    counts.then_some(from)
}

/// The first setting or variable that makes Claude use something other than
/// its saved login, in Claude Code's own order: a cloud provider switch, a
/// custom endpoint, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`,
/// `apiKeyHelper`, workload identity, then `CLAUDE_CODE_OAUTH_TOKEN`. By
/// name only (never its value). Variables that do not change how Claude
/// signs in (`ANTHROPIC_CUSTOM_HEADERS`, say) do not count.
pub(crate) fn override_source(
    inherit: bool,
    env: impl Fn(&str) -> Option<String>,
    settings: &Value,
) -> Option<(&'static str, OverrideFrom)> {
    let enabled = |value: &str| !matches!(value.to_ascii_lowercase().as_str(), "" | "0" | "false");
    let present = |value: &str| !value.is_empty();
    let custom_url = |value: &str| !matches!(value, "" | "https://api.anthropic.com" | "https://api.anthropic.com/");
    let find = |names: &[&'static str], test: fn(&str) -> bool| names.iter().find_map(|name| set_where(inherit, &env, settings, name, test).map(|from| (*name, from)));
    find(&PROVIDER_SWITCHES, enabled)
        .or_else(|| find(&["ANTHROPIC_BASE_URL"], custom_url))
        .or_else(|| find(&KEY_VARIABLES, present))
        .or_else(|| settings["apiKeyHelper"].as_str().is_some_and(|s| !s.trim().is_empty()).then_some(("apiKeyHelper", OverrideFrom::Settings)))
        .or_else(|| find(&IDENTITY_VARIABLES, present))
        .or_else(|| find(&[OAUTH_TOKEN_VARIABLE], present))
}

/// The value of `CLAUDE_CODE_OAUTH_TOKEN` as Claude gets it (wiped by the caller).
pub(crate) fn oauth_token(inherit: bool, env: impl Fn(&str) -> Option<String>, settings: &Value) -> Option<String> {
    let (mut value, _) = variable(inherit, &env, settings, OAUTH_TOKEN_VARIABLE)?;
    let found = token(Some(value.trim().to_owned()));
    wipe(&mut value);
    found
}


/// Where an administrator's Claude Code settings live; Claude Code applies
/// them over the user's own. A connection set there (an `apiKeyHelper`, say)
/// makes the setup "not your subscription", so PandaCode never runs Claude
/// Code for it, and so never runs that helper unattended.
pub(crate) fn managed_settings_paths() -> Vec<PathBuf> {
    let paths: Vec<&str> = if cfg!(target_os = "macos") {
        vec!["/Library/Application Support/ClaudeCode/managed-settings.json"]
    } else if cfg!(windows) {
        vec![r"C:\Program Files\ClaudeCode\managed-settings.json", r"C:\ProgramData\ClaudeCode\managed-settings.json"]
    } else {
        vec!["/etc/claude-code/managed-settings.json"]
    };
    paths.into_iter().map(PathBuf::from).collect()
}

/// `settings` with an administrator's `managed` ones laid over it, as Claude
/// Code applies them: its `apiKeyHelper` and `env` win.
pub(crate) fn with_managed(mut settings: Value, managed: &Value) -> Value {
    if !settings.is_object() {
        settings = Value::Object(Default::default());
    }
    if let Some(helper) = managed.get("apiKeyHelper") {
        settings["apiKeyHelper"] = helper.clone();
    }
    if let Some(env) = managed["env"].as_object() {
        if !settings["env"].is_object() {
            settings["env"] = Value::Object(Default::default());
        }
        for (name, value) in env {
            settings["env"][name] = value.clone();
        }
    }
    settings
}

/// Whether an administrator's `managed` settings themselves set `name`.
pub(crate) fn managed_sets(managed: &Value, name: &str) -> bool {
    match name {
        "apiKeyHelper" => managed["apiKeyHelper"].as_str().is_some_and(|helper| !helper.trim().is_empty()),
        _ => managed["env"][name].is_string(),
    }
}
