//! Colab's options in `cloud::Settings.providers["colab"]` and the sign-in's lifecycle on
//! this computer: what Settings → Cloud shows (`config`, instant and local), the compute
//! units it asks for separately (`usage_summary`), saving choices, saving a finished
//! sign-in, and Disconnect.
//!
//! Saves of the Colab options take one lock, so a save racing Disconnect never brings
//! `providers["colab"]` back after it was removed.
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    process::Command,
    sync::{Mutex, MutexGuard},
};

use super::super::http::block;
use super::store::{self, OAuthSecret};
use super::{detail, oauth, parse_accelerator, Colab, Urls, COLAB_CLI_PKG, COLAB_MCP_PKG, INSTALL_HINT, PROVIDER, SECRET};

type Result<T> = std::result::Result<T, String>;

const SIGN_IN_FIRST: &str = "Sign in to Google Colab in Settings → Cloud first.";

static SAVING: Mutex<()> = Mutex::new(());

fn saving() -> MutexGuard<'static, ()> {
    SAVING.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(super) fn options() -> BTreeMap<String, String> {
    super::super::settings().providers.get(PROVIDER).cloned().unwrap_or_default()
}
fn flag(options: &BTreeMap<String, String>, key: &str, default: bool) -> bool {
    options.get(key).map_or(default, |value| value == "true")
}
pub(super) fn auth_mode(options: &BTreeMap<String, String>) -> String {
    options.get("authMode").cloned().unwrap_or_else(|| "oauth2".into())
}

pub fn is_connected() -> bool {
    super::super::secret(SECRET).is_some() && super::super::settings().providers.contains_key(PROVIDER)
}
pub fn native_tools_enabled() -> bool {
    flag(&options(), "nativeTools", true)
}
/// The accelerator and High-RAM choice new runtimes get.
pub fn default_hardware() -> (String, bool) {
    let options = options();
    (options.get("accelerator").and_then(|a| parse_accelerator(a).ok()).unwrap_or_else(|| "NONE".into()), flag(&options, "highMem", false))
}
/// Google's Colab MCP server (pinned) through `uvx`, when the user turned it on.
pub fn colab_mcp_command() -> Option<(String, Vec<String>)> {
    if !is_connected() || !flag(&options(), "colabMcp", false) {
        return None;
    }
    let uvx = crate::token_saver::find_tool("uvx")?;
    Some((uvx.display().to_string(), vec![COLAB_MCP_PKG.into()]))
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ColabConfig {
    pub connected: bool,
    pub email: Option<String>,
    pub auth_mode: String,
    pub accelerator: String,
    pub high_mem: bool,
    pub native_tools: bool,
    pub colab_mcp: bool,
    pub colab_cli_installed: bool,
    pub uvx_installed: bool,
    pub gcloud_installed: bool,
    /// Always empty here: the balance comes from `usage_summary` (`cloud_colab_usage`).
    pub ccu_balance: Option<f64>,
    pub ccu_rate: Option<f64>,
}

/// Compute units left and spent per hour, when Colab reports them.
#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ColabUsage {
    pub ccu_balance: Option<f64>,
    pub ccu_rate: Option<f64>,
}

pub(crate) fn local_config(options: &BTreeMap<String, String>, connected: bool) -> ColabConfig {
    let tool = |name: &str| crate::token_saver::find_tool(name).is_some();
    ColabConfig {
        connected,
        email: options.get("email").cloned(),
        auth_mode: auth_mode(options),
        accelerator: options.get("accelerator").and_then(|a| parse_accelerator(a).ok()).unwrap_or_else(|| "NONE".into()),
        high_mem: flag(options, "highMem", false),
        native_tools: flag(options, "nativeTools", true),
        colab_mcp: flag(options, "colabMcp", false),
        colab_cli_installed: tool("colab"),
        uvx_installed: tool("uvx"),
        gcloud_installed: tool("gcloud"),
        ccu_balance: None,
        ccu_rate: None,
    }
}

/// Settings → Cloud's view: local only, so it never waits on the network.
pub fn config() -> ColabConfig {
    local_config(&options(), is_connected())
}

/// The account's compute-unit balance (one request to Colab).
pub fn usage_summary() -> Result<ColabUsage> {
    let usage = Colab::connected()?.usage()?;
    Ok(ColabUsage { ccu_balance: usage.map(|(balance, _)| balance), ccu_rate: usage.map(|(_, rate)| rate) })
}

/// The saved options with `changes` applied (`accelerator`, `highMem`, `nativeTools`,
/// `colabMcp`; booleans as JSON booleans or "true"/"false"), and `detail` recomputed.
pub(crate) fn apply_options(current: &BTreeMap<String, String>, changes: &Value) -> Result<BTreeMap<String, String>> {
    let mut next = current.clone();
    if let Some(accelerator) = changes.get("accelerator").filter(|v| !v.is_null()) {
        next.insert("accelerator".into(), parse_accelerator(accelerator.as_str().ok_or("Choose a Colab accelerator.")?)?);
    }
    for key in ["highMem", "nativeTools", "colabMcp"] {
        match changes.get(key) {
            None | Some(Value::Null) => {}
            Some(Value::Bool(on)) => {
                next.insert(key.into(), on.to_string());
            }
            Some(Value::String(text)) if matches!(text.as_str(), "true" | "false") => {
                next.insert(key.into(), text.clone());
            }
            Some(_) => return Err(format!("{key} must be true or false.")),
        }
    }
    let accelerator = next.get("accelerator").cloned().unwrap_or_else(|| "NONE".into());
    let detail_text = detail(next.get("email").map_or("Google account", String::as_str), &accelerator, flag(&next, "highMem", false));
    next.insert("detail".into(), detail_text);
    Ok(next)
}

/// Save option changes. Refused once disconnected, checked under the save lock, so a save
/// that raced Disconnect never recreates the Colab options.
pub fn update_config(changes: &Value) -> Result<ColabConfig> {
    {
        let _saving = saving();
        if !is_connected() {
            return Err(SIGN_IN_FIRST.into());
        }
        let mut settings = super::super::settings();
        let next = apply_options(&options(), changes)?;
        settings.providers.insert(PROVIDER.into(), next);
        super::super::save_settings(&settings)?;
    }
    Ok(config())
}

/// After a sign-in: defaults for a first sign-in, the user's choices kept on a re-sign-in.
pub(crate) fn signed_in_options(current: &BTreeMap<String, String>, email: &str, mode: &str) -> Result<BTreeMap<String, String>> {
    let mut base = current.clone();
    base.insert("email".into(), email.to_string());
    base.insert("authMode".into(), mode.to_string());
    for (key, default) in [("nativeTools", "true"), ("colabMcp", "false"), ("accelerator", "NONE"), ("highMem", "false")] {
        base.entry(key.into()).or_insert_with(|| default.into());
    }
    apply_options(&base, &json!({}))
}

/// Save a finished sign-in; returns the Settings detail line.
pub(crate) fn persist(email: &str, mode: &str, secret: &OAuthSecret) -> Result<String> {
    let _saving = saving();
    secret.save()?;
    let mut settings = super::super::settings();
    let next = signed_in_options(&options(), email, mode)?;
    let line = next.get("detail").cloned().unwrap_or_default();
    settings.providers.insert(PROVIDER.into(), next);
    super::super::save_settings(&settings)?;
    Ok(line)
}

/// `cloud_connect` for Colab: `authMode: "adc"` connects with gcloud's existing login;
/// otherwise a signed-in account saves its options (sign-in itself is `sign_in_start`).
pub fn connect(options: &Value) -> Result<()> {
    if options["authMode"].as_str() == Some("adc") {
        let signed = block(oauth::adc_verify(&Urls::default()))?;
        persist(&signed.email, "adc", &signed.secret)?;
    }
    if !is_connected() {
        return Err("Use Sign in with Google to connect Google Colab.".into());
    }
    update_config(options).map(|_| ())
}

/// Install Google's Colab CLI (pinned) with uv, whose OAuth client the sign-in uses.
pub fn install_cli() -> Result<ColabConfig> {
    let uv = crate::token_saver::find_tool("uv").ok_or_else(|| format!("uv is not installed. {INSTALL_HINT}"))?;
    oauth::run_install(&uv)?;
    Ok(config())
}

/// The token Disconnect revokes: PandaCode's own refresh token (revoking it ends the
/// grant). An ADC sign-in revokes nothing: its grant is gcloud's, shared with other tools.
pub(crate) fn token_to_revoke(mode: &str, secret: &OAuthSecret) -> Option<String> {
    (mode != "adc").then(|| if secret.refresh_token.is_empty() { secret.access_token.clone() } else { secret.refresh_token.clone() }).filter(|token| !token.is_empty())
}

/// Forget the sign-in and runtimes; runtimes already running end on Colab's idle timeout.
/// A sign-in in progress is cancelled first, so it can no longer save anything.
pub fn disconnect() -> Result<()> {
    oauth::sign_in_cancel();
    let _saving = saving();
    if let Some(token) = OAuthSecret::load().and_then(|secret| token_to_revoke(&auth_mode(&options()), &secret)) {
        block(oauth::revoke(&Urls::default(), &token));
    }
    super::super::remove_secret(SECRET);
    let mut settings = super::super::settings();
    settings.providers.remove(PROVIDER);
    super::super::save_settings(&settings)?;
    if let Ok(path) = store::path() {
        let _ = std::fs::remove_file(path);
    }
    Ok(())
}

/// `uv tool install google-colab-cli==<pinned>`, bounded.
pub(crate) fn uv_install_command(uv: &std::path::Path) -> Command {
    let mut command = Command::new(uv);
    command.args(["tool", "install", COLAB_CLI_PKG]);
    command
}
