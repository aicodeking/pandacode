//! Provider-specific configuration. API keys never enter the settings file or IPC replies.
use crate::Result;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashSet},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};
use tauri::Emitter;

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Settings {
    executable_paths: BTreeMap<String, String>,
    /// Environment variables applied to every harness, unless a provider opts
    /// out — a proxy setup shared by all agents, for example.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    global_environment: BTreeMap<String, String>,
    /// Extra environment variables per provider, applied to every process
    /// PandaCode starts for that harness (runs, discovery, its console).
    /// Plain values only: a variable that needs a secret belongs to a named
    /// connection, whose secret values live in the secure store.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    environment: BTreeMap<String, BTreeMap<String, String>>,
    /// Providers with the global environment turned off. Absent means on.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    global_environment_disabled: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    opencode_models: Vec<String>,
    /// MiMo cluster (`token-plan-cn`, `token-plan-sgp`, `token-plan-ams`) or `api`
    /// for pay-as-you-go. The key itself never enters this file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    mimo_endpoint: Option<String>,
    #[serde(default, skip_serializing_if = "crate::providers::claude_auth::Mode::is_inherit")]
    claude_connection_mode: crate::providers::claude_auth::Mode,
}
struct Runtime {
    path: PathBuf,
    settings: Settings,
}
static CONFIG: OnceLock<Mutex<Runtime>> = OnceLock::new();
const SERVICE: &str = "app.pandacode.providers";
/// The same limits the named-connection environment applies, so both editors behave alike.
pub(crate) const MAX_ENV: usize = 64;
pub(crate) const MAX_ENV_VALUE: usize = 4096;

/// A provider API key in the platform's secure store, with the environment
/// variable that can supply it instead. Labels appear in user-facing errors only.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Credential {
    account: &'static str,
    label: &'static str,
    pub env: &'static str,
}
pub const GLM_KEY: Credential = Credential {
    account: "zai-coding-plan",
    label: "GLM",
    env: "ZAI_API_KEY",
};
pub const MIMO_KEY: Credential = Credential {
    account: "mimo-token-plan",
    label: "MiMo",
    env: "MIMO_API_KEY",
};
pub const DEEPSEEK_KEY: Credential = Credential {
    account: "deepseek-api",
    label: "DeepSeek",
    env: "DEEPSEEK_API_KEY",
};
pub const COMMANDCODE_KEY: Credential = Credential {
    account: "command-code-api",
    label: "Command Code",
    env: "COMMAND_CODE_API_KEY",
};

pub fn setup(dir: &Path) -> Result<()> {
    let path = dir.join("provider-settings.json");
    let settings = if path.exists() {
        let file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
        if file.metadata().map_err(|e| e.to_string())?.len() > 64 * 1024 {
            return Err("Provider settings file is too large.".into());
        }
        let mut settings: Settings = serde_json::from_reader(file)
            .map_err(|_| "Could not load provider settings.".to_owned())?;
        settings.opencode_models = validated_opencode_models(settings.opencode_models)?;
        settings.mimo_endpoint = settings
            .mimo_endpoint
            .filter(|id| crate::providers::mimo_endpoint_url(id).is_some());
        settings.global_environment = valid_global_environment(settings.global_environment);
        settings.environment = valid_environment(settings.environment);
        settings
            .global_environment_disabled
            .retain(|provider| known_provider(provider));
        settings
    } else {
        Settings::default()
    };
    CONFIG
        .set(Mutex::new(Runtime { path, settings }))
        .map_err(|_| "Provider settings are already initialized.".into())
}

pub fn executable_override(provider: &str) -> Option<PathBuf> {
    CONFIG
        .get()?
        .lock()
        .ok()?
        .settings
        .executable_paths
        .get(provider)
        .map(PathBuf::from)
}

/// A POSIX-style environment variable name, shared with the named-connection editor.
pub(crate) fn valid_env_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        && !name.starts_with(|c: char| c.is_ascii_digit())
}

fn known_provider(provider: &str) -> bool {
    crate::providers::PROVIDERS.iter().any(|(id, _)| *id == provider)
}

/// Keeps only variables with valid names and values, so a hand-edited settings
/// file cannot inject junk into a launch.
fn valid_vars(vars: BTreeMap<String, String>) -> BTreeMap<String, String> {
    vars.into_iter()
        .filter(|(name, value)| valid_env_name(name) && value.len() <= MAX_ENV_VALUE && !value.contains('\0'))
        .collect()
}

/// The global set from a hand-edited file: junk is dropped, and an over-cap set
/// is dropped entirely (saves can never produce one — `persist` refuses first).
fn valid_global_environment(vars: BTreeMap<String, String>) -> BTreeMap<String, String> {
    let vars = valid_vars(vars);
    if vars.len() > MAX_ENV { BTreeMap::new() } else { vars }
}

/// Keeps only providers PandaCode knows and variables with valid names and
/// values.
fn valid_environment(
    environment: BTreeMap<String, BTreeMap<String, String>>,
) -> BTreeMap<String, BTreeMap<String, String>> {
    environment
        .into_iter()
        .filter(|(provider, _)| known_provider(provider))
        .filter_map(|(provider, vars)| {
            if vars.len() > MAX_ENV {
                return None;
            }
            let vars = valid_vars(vars);
            (!vars.is_empty()).then_some((provider, vars))
        })
        .collect()
}

/// The provider's effective environment: the global list unless the provider
/// opted out, with the provider's own variables overriding shared names.
fn effective_environment(settings: &Settings, provider: &str) -> Vec<(String, String)> {
    let mut vars = BTreeMap::new();
    if !settings.global_environment_disabled.iter().any(|id| id == provider) {
        vars.extend(settings.global_environment.iter().map(|(k, v)| (k.clone(), v.clone())));
    }
    if let Some(own) = settings.environment.get(provider) {
        vars.extend(own.iter().map(|(k, v)| (k.clone(), v.clone())));
    }
    vars.into_iter().collect()
}

/// The provider's effective environment variables, in name order.
pub fn environment(provider: &str) -> Vec<(String, String)> {
    let Some(runtime) = CONFIG.get().and_then(|runtime| runtime.lock().ok()) else {
        return Vec::new();
    };
    effective_environment(&runtime.settings, provider)
}

/// Applies the provider's saved environment to a command about to start its CLI.
/// Provider sign-in and endpoint configuration is applied after this and wins.
pub fn apply_environment(provider: &str, command: &mut impl crate::child_env::EnvTarget) {
    apply_vars(&environment(provider), command);
}

fn apply_vars(vars: &[(String, String)], command: &mut impl crate::child_env::EnvTarget) {
    for (name, value) in vars {
        command.set_var(std::ffi::OsStr::new(name.as_str()), std::ffi::OsStr::new(value.as_str()));
    }
}

/// Fingerprint of the saved variables for the warm-agent key: a changed
/// environment never adopts a process started with the old one.
pub(crate) fn environment_fingerprint(provider: &str) -> String {
    serde_json::to_string(&environment(provider)).unwrap_or_default()
}

pub fn glm_key() -> Result<Option<String>> {
    stored_key(GLM_KEY)
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn glm_usage_access() -> Result<std::sync::MutexGuard<'static, ()>> {
    static ACCESS: Mutex<()> = Mutex::new(());
    ACCESS.try_lock().map_err(|_| "The GLM secure-store usage check is busy.".into())
}

/// Usage checks must never open an unlock or credential-access dialog. Keep
/// normal agent launch/settings behavior in `glm_key` unchanged.
#[cfg(target_os = "macos")]
pub(crate) fn glm_key_for_usage() -> Result<Option<String>> {
    let _access = glm_usage_access()?;
    if let Some(key) = crate::secret_store::peek(SERVICE, GLM_KEY.account) {
        return Ok(Some(key));
    }
    // Not moved out of the Keychain yet: read it in the noninteractive child.
    crate::usage_keychain::read_glm()
        .map_err(|_| "The GLM Keychain item could not be read without interaction.".to_owned())?
        .map(|bytes| String::from_utf8(bytes).map_err(|_| invalid_key_error(GLM_KEY)))
        .transpose()
}

#[cfg(target_os = "windows")]
pub(crate) fn glm_key_for_usage() -> Result<Option<String>> {
    let _access = glm_usage_access()?;
    // Credential Manager's read is noninteractive.
    glm_key()
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub(crate) fn glm_key_for_usage() -> Result<Option<String>> {
    // keyring's Secret Service backend unconditionally unlocks matching locked
    // items during get_password(). It has no noninteractive read option, so the
    // background check cannot establish whether a saved key overrides env.
    Err("Noninteractive GLM secure-store access is unavailable.".into())
}

pub fn mimo_key() -> Result<Option<String>> {
    stored_key(MIMO_KEY)
}

pub fn deepseek_key() -> Result<Option<String>> {
    stored_key(DEEPSEEK_KEY)
}

/// Usage checks must never open an unlock or credential-access dialog. This
/// provider's keys have only ever lived in the secrets file (the harness
/// shipped after the file store), so a noninteractive peek is the whole store
/// on macOS; keep normal agent launch/settings behavior in `deepseek_key`.
#[cfg(target_os = "macos")]
pub(crate) fn deepseek_key_for_usage() -> Result<Option<String>> {
    Ok(crate::secret_store::peek(SERVICE, DEEPSEEK_KEY.account))
}

/// Credential Manager's read is noninteractive.
#[cfg(target_os = "windows")]
pub(crate) fn deepseek_key_for_usage() -> Result<Option<String>> {
    deepseek_key()
}

/// keyring's Secret Service backend unconditionally unlocks matching locked
/// items during get_password(). It has no noninteractive read option, so the
/// background check cannot establish whether a saved key overrides env.
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub(crate) fn deepseek_key_for_usage() -> Result<Option<String>> {
    Err("Noninteractive DeepSeek secure-store access is unavailable.".into())
}

pub fn commandcode_key() -> Result<Option<String>> {
    stored_key(COMMANDCODE_KEY)
}

/// macOS keeps keys in PandaCode's secrets file (`secret_store`), never prompting.
#[cfg(target_os = "macos")]
pub fn stored_key(credential: Credential) -> Result<Option<String>> {
    crate::secret_store::get(SERVICE, credential.account)
        .map(|key| validate_key(&key).map(str::to_owned).map_err(|_| invalid_key_error(credential)))
        .transpose()
}
#[cfg(any(target_os = "linux", target_os = "windows"))]
pub fn stored_key(credential: Credential) -> Result<Option<String>> {
    let _access = store_lock(credential)?;
    native_key_result(credential, store_entry(credential)?.get_password())
}
#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
pub fn stored_key(_credential: Credential) -> Result<Option<String>> {
    Ok(None)
}

fn invalid_key_error(credential: Credential) -> String {
    format!("The saved {} key is invalid. Replace it in Settings.", credential.label)
}

// The native stores can fail when the same credential is accessed concurrently.
// Keep each blocking access serialized without holding the settings lock.
#[cfg(any(target_os = "linux", target_os = "windows"))]
fn store_lock(credential: Credential) -> Result<std::sync::MutexGuard<'static, ()>> {
    static STORE: Mutex<()> = Mutex::new(());
    STORE
        .lock()
        .map_err(|_| native_storage_error(credential, "access"))
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
fn store_entry(credential: Credential) -> Result<keyring::Entry> {
    keyring::Entry::new(SERVICE, credential.account)
        .map_err(|_| native_storage_error(credential, "access"))
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
fn native_storage_error(credential: Credential, operation: &str) -> String {
    let recovery = if cfg!(target_os = "windows") {
        "Check that Windows Credential Manager is available for your account"
    } else {
        "Start and unlock a Secret Service keyring for your Linux desktop session"
    };
    format!(
        "Could not {operation} the {} key in secure storage. {recovery}, or set {} in the app environment.",
        credential.label, credential.env
    )
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
fn native_key_result(credential: Credential, result: keyring::Result<String>) -> Result<Option<String>> {
    match result {
        Ok(key) => validate_key(&key)
            .map(|key| Some(key.to_owned()))
            .map_err(|_| invalid_key_error(credential)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(keyring::Error::BadEncoding(_)) => Err(invalid_key_error(credential)),
        Err(_) => Err(native_storage_error(credential, "access")),
    }
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
fn save_native_key(credential: Credential, key: &str) -> Result<()> {
    let _access = store_lock(credential)?;
    store_entry(credential)?
        .set_password(key)
        .map_err(|_| native_storage_error(credential, "save"))
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
fn remove_native_key(credential: Credential) -> Result<()> {
    let _access = store_lock(credential)?;
    native_key_removal_result(credential, store_entry(credential)?.delete_credential())
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
fn native_key_removal_result(credential: Credential, result: keyring::Result<()>) -> Result<()> {
    match result {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err(native_storage_error(credential, "remove")),
    }
}

/// Save a key in the platform store; platforms without one point at the environment variable.
fn save_key(credential: Credential, key: &str) -> Result<()> {
    let key = validate_key(key)?;
    #[cfg(target_os = "macos")]
    return crate::secret_store::set(SERVICE, credential.account, key)
        .map_err(|error| format!("Could not save the {} key: {error}", credential.label));
    #[cfg(any(target_os = "linux", target_os = "windows"))]
    return save_native_key(credential, key);
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        let _ = key;
        Err(format!("Set {} in the app's environment on this platform.", credential.env))
    }
}
fn remove_key(credential: Credential) -> Result<()> {
    #[cfg(target_os = "macos")]
    crate::secret_store::remove(SERVICE, credential.account);
    #[cfg(any(target_os = "linux", target_os = "windows"))]
    remove_native_key(credential)?;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MimoEndpoint {
    id: &'static str,
    url: &'static str,
    label: &'static str,
}
fn mimo_endpoints() -> Vec<MimoEndpoint> {
    crate::providers::mimo_endpoints()
        .iter()
        .map(|(id, url, label)| MimoEndpoint { id, url, label })
        .collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Configuration {
    executable_paths: BTreeMap<String, String>,
    /// Names of the global environment variables applied to every harness.
    /// Values never reach the webview, like API keys.
    global_environment: Vec<String>,
    /// Per provider, the names of its own saved environment variables.
    environment: BTreeMap<String, Vec<String>>,
    /// Whether each provider's launches include the global environment.
    use_global_environment: BTreeMap<String, bool>,
    glm_key_saved: bool,
    glm_key_from_environment: bool,
    mimo_key_saved: bool,
    mimo_key_from_environment: bool,
    deepseek_key_saved: bool,
    deepseek_key_from_environment: bool,
    commandcode_key_saved: bool,
    commandcode_key_from_environment: bool,
    mimo_endpoint: Option<String>,
    /// The clusters the app knows; the UI offers exactly these.
    mimo_endpoints: Vec<MimoEndpoint>,
    claude_connection_mode: crate::providers::claude_auth::Mode,
    secure_storage_available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    credential_storage_error: Option<String>,
}
fn configuration() -> Result<Configuration> {
    let (paths, mimo_endpoint, claude_connection_mode, environment, global_environment, global_environment_disabled) = {
        let runtime = CONFIG
            .get()
            .ok_or("Provider settings are not initialized.")?
            .lock()
            .map_err(|e| e.to_string())?;
        (
            runtime.settings.executable_paths.clone(),
            runtime.settings.mimo_endpoint.clone(),
            runtime.settings.claude_connection_mode,
            runtime.settings.environment.clone(),
            runtime.settings.global_environment.keys().cloned().collect(),
            runtime.settings.global_environment_disabled.clone(),
        )
    };
    let environment: BTreeMap<String, Vec<String>> = environment
        .into_iter()
        .map(|(provider, vars)| (provider, vars.into_keys().collect()))
        .collect();
    let use_global_environment: BTreeMap<String, bool> = crate::providers::PROVIDERS
        .iter()
        .map(|(id, _)| (id.to_string(), !global_environment_disabled.iter().any(|name| name == id)))
        .collect();
    #[cfg(target_os = "macos")]
    let (glm_key_saved, mimo_key_saved, deepseek_key_saved, commandcode_key_saved, credential_storage_error) = (
        glm_key()?.is_some(),
        mimo_key()?.is_some(),
        deepseek_key()?.is_some(),
        commandcode_key()?.is_some(),
        None,
    );
    #[cfg(not(target_os = "macos"))]
    let (glm_key_saved, mimo_key_saved, deepseek_key_saved, commandcode_key_saved, credential_storage_error) = {
        let (glm, glm_error) = credential_status(glm_key());
        let (mimo, mimo_error) = credential_status(mimo_key());
        let (deepseek, deepseek_error) = credential_status(deepseek_key());
        let (commandcode, commandcode_error) = credential_status(commandcode_key());
        (glm, mimo, deepseek, commandcode, glm_error.or(mimo_error).or(deepseek_error).or(commandcode_error))
    };
    let from_environment = |name: &str| std::env::var(name).is_ok_and(|key| validate_key(&key).is_ok());
    Ok(Configuration {
        executable_paths: paths,
        global_environment,
        environment,
        use_global_environment,
        glm_key_saved,
        glm_key_from_environment: from_environment(GLM_KEY.env),
        mimo_key_saved,
        mimo_key_from_environment: from_environment(MIMO_KEY.env),
        deepseek_key_saved,
        deepseek_key_from_environment: from_environment(DEEPSEEK_KEY.env),
        commandcode_key_saved,
        commandcode_key_from_environment: from_environment(COMMANDCODE_KEY.env),
        mimo_endpoint,
        mimo_endpoints: mimo_endpoints(),
        claude_connection_mode,
        secure_storage_available: cfg!(any(
            target_os = "macos",
            target_os = "linux",
            target_os = "windows"
        )),
        credential_storage_error,
    })
}

#[cfg(any(not(target_os = "macos"), test))]
fn credential_status(key: Result<Option<String>>) -> (bool, Option<String>) {
    match key {
        Ok(key) => (key.is_some(), None),
        Err(error) => (false, Some(error)),
    }
}
#[tauri::command]
pub async fn provider_configuration() -> Result<Configuration> {
    crate::blocking(configuration).await
}

fn validated_executable(provider: &str, path: &str) -> Result<Option<String>> {
    if !matches!(
        provider,
        "opencode" | "antigravity" | "glm" | "grok" | "mimo" | "pi" | "deepseek" | "commandcode" | "cline" | "kilo" | "omp" | "github-copilot" | "muse" | "devin" | "zcode" | "hermes"
    ) {
        return Err("This provider does not support an executable override.".into());
    }
    if path.trim().is_empty() {
        return Ok(None);
    }
    validated_executable_path(path)
}
/// An absolute path to an existing executable file, canonicalized.
pub(crate) fn validated_executable_path(path: &str) -> Result<Option<String>> {
    if path.len() > 4096 || path.chars().any(char::is_control) || !Path::new(path).is_absolute() {
        return Err("Choose an absolute path to the installed executable.".into());
    }
    let path = Path::new(path)
        .canonicalize()
        .map_err(|_| "The executable could not be found.".to_string())?;
    let meta = path.metadata().map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("Choose an executable file, not a folder.".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if meta.permissions().mode() & 0o111 == 0 {
            return Err("This file is not executable.".into());
        }
    }
    Ok(Some(path.to_string_lossy().into_owned()))
}
fn save_executable(provider: &str, path: &str) -> Result<()> {
    let path = validated_executable(provider, path)?;
    let mut runtime = CONFIG
        .get()
        .ok_or("Provider settings are not initialized.")?
        .lock()
        .map_err(|e| e.to_string())?;
    let mut next = runtime.settings.clone();
    if let Some(path) = path {
        next.executable_paths.insert(provider.into(), path);
    } else {
        next.executable_paths.remove(provider);
    }
    persist(&mut runtime, next)
}
fn persist(runtime: &mut Runtime, next: Settings) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(&next).map_err(|e| e.to_string())?;
    // Every save passes through here, so this is the one guard that keeps the
    // file under the load-time cap (64 KiB) — crossing it would refuse the
    // file on the next launch, with no UI left to shrink it.
    if bytes.len() > 56 * 1024 {
        return Err("Provider settings would grow past their storage budget. Remove some environment variables and try again.".into());
    }
    // Environment values can embed proxy credentials, so the file gets the
    // app's secret-file treatment: 0600 (unix), flushed, then renamed into place.
    let temp = runtime.path.with_extension("json.tmp");
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        std::fs::File::options()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&temp)
            .and_then(|mut file| file.write_all(&bytes).and_then(|_| file.sync_all()))
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(unix))]
    std::fs::write(&temp, &bytes).map_err(|e| e.to_string())?;
    if let Err(error) = std::fs::rename(&temp, &runtime.path) {
        let _ = std::fs::remove_file(&temp);
        return Err(error.to_string());
    }
    runtime.settings = next;
    Ok(())
}
#[tauri::command]
pub async fn provider_set_executable(
    app: tauri::AppHandle,
    provider: String,
    path: String,
) -> Result<Configuration> {
    let changed = provider.clone();
    let result = crate::blocking(move || {
        save_executable(&provider, &path)?;
        crate::agent_usage::invalidate(&provider);
        crate::providers::acp_catalog::invalidate(&provider);
        crate::slash_commands::invalidate_provider(&provider);
        configuration()
    })
    .await?;
    let _ = app.emit(
        "provider-models-changed",
        serde_json::json!({"provider":changed}),
    );
    Ok(result)
}

fn validated_env_name(name: &str) -> Result<()> {
    if !valid_env_name(name) {
        return Err("Environment variable names use letters, digits and underscores, and do not start with a digit.".into());
    }
    Ok(())
}

fn validated_environment_variable(provider: &str, name: &str, value: &str) -> Result<()> {
    if !known_provider(provider) {
        return Err("This provider does not support environment variables.".into());
    }
    validated_env_name(name)?;
    if value.len() > MAX_ENV_VALUE || value.contains('\0') {
        return Err(format!("The value of {name} is too long or contains NUL."));
    }
    Ok(())
}

fn save_global_environment_variable(name: &str, value: &str) -> Result<()> {
    let mut runtime = CONFIG
        .get()
        .ok_or("Provider settings are not initialized.")?
        .lock()
        .map_err(|e| e.to_string())?;
    let mut next = runtime.settings.clone();
    insert_var(&mut next.global_environment, name, value)?;
    persist(&mut runtime, next)
}

fn remove_global_environment_variable(name: &str) -> Result<bool> {
    let mut runtime = CONFIG
        .get()
        .ok_or("Provider settings are not initialized.")?
        .lock()
        .map_err(|e| e.to_string())?;
    let mut next = runtime.settings.clone();
    let removed = drop_var(&mut next.global_environment, name);
    if removed {
        persist(&mut runtime, next)?;
    }
    Ok(removed)
}

/// Turns the global environment on or off for one provider.
fn set_use_global_environment(provider: &str, use_global: bool) -> Result<()> {
    if !known_provider(provider) {
        return Err("This provider does not support environment variables.".into());
    }
    let mut runtime = CONFIG
        .get()
        .ok_or("Provider settings are not initialized.")?
        .lock()
        .map_err(|e| e.to_string())?;
    let mut next = runtime.settings.clone();
    next.global_environment_disabled.retain(|id| id != provider);
    if !use_global {
        next.global_environment_disabled.push(provider.into());
    }
    persist(&mut runtime, next)
}

fn insert_var(vars: &mut BTreeMap<String, String>, name: &str, value: &str) -> Result<()> {
    validated_env_name(name)?;
    if value.len() > MAX_ENV_VALUE || value.contains('\0') {
        return Err(format!("The value of {name} is too long or contains NUL."));
    }
    if vars.len() >= MAX_ENV && !vars.contains_key(name) {
        return Err(format!("Use up to {MAX_ENV} environment variables."));
    }
    vars.insert(name.into(), value.into());
    Ok(())
}

/// Returns whether the variable existed.
fn drop_var(vars: &mut BTreeMap<String, String>, name: &str) -> bool {
    if !valid_env_name(name) {
        return false;
    }
    vars.remove(name).is_some()
}

fn insert_env_var(
    environment: &mut BTreeMap<String, BTreeMap<String, String>>,
    provider: &str,
    name: &str,
    value: &str,
) -> Result<()> {
    validated_environment_variable(provider, name, value)?;
    let vars = environment.entry(provider.into()).or_default();
    insert_var(vars, name, value)
}

/// Returns whether the variable existed.
fn drop_env_var(
    environment: &mut BTreeMap<String, BTreeMap<String, String>>,
    provider: &str,
    name: &str,
) -> bool {
    if validated_environment_variable(provider, name, "").is_err() {
        return false;
    }
    let removed = environment
        .get_mut(provider)
        .is_some_and(|vars| drop_var(vars, name));
    if removed {
        environment.retain(|_, vars| !vars.is_empty());
    }
    removed
}

fn save_environment_variable(provider: &str, name: &str, value: &str) -> Result<()> {
    let mut runtime = CONFIG
        .get()
        .ok_or("Provider settings are not initialized.")?
        .lock()
        .map_err(|e| e.to_string())?;
    let mut next = runtime.settings.clone();
    insert_env_var(&mut next.environment, provider, name, value)?;
    persist(&mut runtime, next)
}

fn remove_environment_variable(provider: &str, name: &str) -> Result<bool> {
    let mut runtime = CONFIG
        .get()
        .ok_or("Provider settings are not initialized.")?
        .lock()
        .map_err(|e| e.to_string())?;
    let mut next = runtime.settings.clone();
    let removed = drop_env_var(&mut next.environment, provider, name);
    if removed {
        persist(&mut runtime, next)?;
    }
    Ok(removed)
}

/// Refresh caches whose discovery spawns the harness, so a new variable (for
/// example a proxy) reaches the next catalog, command and usage query.
fn refresh_provider(app: &tauri::AppHandle, provider: &str, result: Configuration) -> Result<Configuration> {
    crate::agent_usage::invalidate(provider);
    crate::providers::acp_catalog::invalidate(provider);
    crate::slash_commands::invalidate_provider(provider);
    let _ = app.emit("provider-models-changed", serde_json::json!({"provider":provider}));
    Ok(result)
}

/// A global variable affects every provider's discovery.
fn refresh_all(app: &tauri::AppHandle, result: Configuration) -> Result<Configuration> {
    for (provider, _) in crate::providers::PROVIDERS {
        crate::agent_usage::invalidate(provider);
        crate::providers::acp_catalog::invalidate(provider);
        crate::slash_commands::invalidate_provider(provider);
        // Listeners match literal provider ids, so each one gets its own event.
        let _ = app.emit("provider-models-changed", serde_json::json!({"provider":provider}));
    }
    Ok(result)
}

#[tauri::command]
pub async fn provider_set_environment_variable(
    app: tauri::AppHandle,
    provider: String,
    name: String,
    value: String,
) -> Result<Configuration> {
    let changed = provider.clone();
    let result = crate::blocking(move || {
        save_environment_variable(&provider, &name, &value)?;
        configuration()
    })
    .await?;
    refresh_provider(&app, &changed, result)
}

#[tauri::command]
pub async fn provider_remove_environment_variable(
    app: tauri::AppHandle,
    provider: String,
    name: String,
) -> Result<Configuration> {
    let changed = provider.clone();
    let result = crate::blocking(move || {
        remove_environment_variable(&provider, &name)?;
        configuration()
    })
    .await?;
    refresh_provider(&app, &changed, result)
}

#[tauri::command]
pub async fn provider_set_global_environment_variable(
    app: tauri::AppHandle,
    name: String,
    value: String,
) -> Result<Configuration> {
    let result = crate::blocking(move || {
        save_global_environment_variable(&name, &value)?;
        configuration()
    })
    .await?;
    refresh_all(&app, result)
}

#[tauri::command]
pub async fn provider_remove_global_environment_variable(
    app: tauri::AppHandle,
    name: String,
) -> Result<Configuration> {
    let result = crate::blocking(move || {
        remove_global_environment_variable(&name)?;
        configuration()
    })
    .await?;
    refresh_all(&app, result)
}

/// Turns the global environment on or off for one provider (default on).
#[tauri::command]
pub async fn provider_set_use_global_environment(
    app: tauri::AppHandle,
    provider: String,
    use_global: bool,
) -> Result<Configuration> {
    let changed = provider.clone();
    let result = crate::blocking(move || {
        set_use_global_environment(&provider, use_global)?;
        configuration()
    })
    .await?;
    refresh_provider(&app, &changed, result)
}

pub(crate) fn opencode_model_ids() -> Result<Vec<String>> {
    let Some(runtime) = CONFIG.get() else {
        return Ok(Vec::new());
    };
    Ok(runtime
        .lock()
        .map_err(|e| e.to_string())?
        .settings
        .opencode_models
        .clone())
}

fn validated_opencode_models(ids: Vec<String>) -> Result<Vec<String>> {
    if ids.len() > 100 {
        return Err("Choose up to 100 OpenCode models.".into());
    }
    let mut seen = HashSet::new();
    let mut models = Vec::new();
    for id in ids {
        if id.len() > 200
            || id.chars().any(char::is_whitespace)
            || id.chars().any(char::is_control)
            || !id
                .split_once('/')
                .is_some_and(|(provider, model)| !provider.is_empty() && !model.is_empty())
        {
            return Err("Choose valid models from the OpenCode model list.".into());
        }
        if seen.insert(id.clone()) {
            models.push(id);
        }
    }
    Ok(models)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeModels {
    models: Vec<crate::providers::ModelInfo>,
    selected_model_ids: Vec<String>,
    error: Option<String>,
}

#[tauri::command]
pub async fn list_opencode_models() -> Result<OpenCodeModels> {
    let selected_model_ids = opencode_model_ids()?;
    let (models, error) = match crate::providers::list_model_catalog("opencode").await {
        Ok(models) => (models, None),
        Err(error) => (Vec::new(), Some(error)),
    };
    Ok(OpenCodeModels {
        models,
        selected_model_ids,
        error,
    })
}

#[tauri::command]
pub async fn save_opencode_models(
    app: tauri::AppHandle,
    model_ids: Vec<String>,
) -> Result<Vec<String>> {
    let models = validated_opencode_models(model_ids)?;
    let result = crate::blocking(move || {
        let mut runtime = CONFIG
            .get()
            .ok_or("Provider settings are not initialized.")?
            .lock()
            .map_err(|e| e.to_string())?;
        let mut next = runtime.settings.clone();
        next.opencode_models = models.clone();
        persist(&mut runtime, next)?;
        Ok(models)
    })
    .await?;
    let _ = app.emit(
        "provider-models-changed",
        serde_json::json!({"provider":"opencode"}),
    );
    Ok(result)
}

pub(crate) fn validate_key(key: &str) -> Result<&str> {
    let key = key.trim();
    if key.is_empty() || key.len() > 4096 || key.chars().any(char::is_control) {
        Err("Enter a valid API key.".into())
    } else {
        Ok(key)
    }
}
#[tauri::command]
pub async fn provider_save_glm_key(key: String) -> Result<Configuration> {
    crate::blocking(move || {
        save_key(GLM_KEY, &key)?;
        crate::agent_usage::invalidate("glm");
        configuration()
    })
    .await
}
#[tauri::command]
pub async fn provider_remove_glm_key() -> Result<Configuration> {
    crate::blocking(|| {
        remove_key(GLM_KEY)?;
        crate::agent_usage::invalidate("glm");
        configuration()
    })
    .await
}
#[tauri::command]
pub async fn provider_save_mimo_key(key: String) -> Result<Configuration> {
    crate::blocking(move || {
        save_key(MIMO_KEY, &key)?;
        crate::agent_usage::invalidate("mimo");
        configuration()
    })
    .await
}
#[tauri::command]
pub async fn provider_remove_mimo_key() -> Result<Configuration> {
    crate::blocking(|| {
        remove_key(MIMO_KEY)?;
        crate::agent_usage::invalidate("mimo");
        configuration()
    })
    .await
}
#[tauri::command]
pub async fn provider_save_deepseek_key(key: String) -> Result<Configuration> {
    crate::blocking(move || {
        save_key(DEEPSEEK_KEY, &key)?;
        crate::agent_usage::invalidate("deepseek");
        crate::providers::acp_catalog::invalidate("deepseek");
        configuration()
    })
    .await
}
#[tauri::command]
pub async fn provider_remove_deepseek_key() -> Result<Configuration> {
    crate::blocking(|| {
        remove_key(DEEPSEEK_KEY)?;
        crate::agent_usage::invalidate("deepseek");
        crate::providers::acp_catalog::invalidate("deepseek");
        configuration()
    })
    .await
}
#[tauri::command]
pub async fn provider_save_commandcode_key(key: String) -> Result<Configuration> {
    crate::blocking(move || {
        save_key(COMMANDCODE_KEY, &key)?;
        crate::providers::acp_catalog::invalidate("commandcode");
        configuration()
    })
    .await
}
#[tauri::command]
pub async fn provider_remove_commandcode_key() -> Result<Configuration> {
    crate::blocking(|| {
        remove_key(COMMANDCODE_KEY)?;
        crate::providers::acp_catalog::invalidate("commandcode");
        configuration()
    })
    .await
}

pub(crate) fn mimo_endpoint() -> Option<String> {
    CONFIG.get()?.lock().ok()?.settings.mimo_endpoint.clone()
}

pub(crate) fn claude_connection_mode() -> crate::providers::claude_auth::Mode {
    CONFIG.get().and_then(|runtime| runtime.lock().ok().map(|runtime| runtime.settings.claude_connection_mode)).unwrap_or_default()
}

#[tauri::command]
pub async fn provider_set_claude_connection_mode(
    app: tauri::AppHandle,
    mode: String,
) -> Result<Configuration> {
    let mode = match mode.as_str() {
        "inherit" => crate::providers::claude_auth::Mode::Inherit,
        "subscription" => crate::providers::claude_auth::Mode::Subscription,
        _ => return Err("Choose an available Claude connection mode.".into()),
    };
    let result = crate::blocking(move || {
        let mut runtime = CONFIG.get().ok_or("Provider settings are not initialized.")?
            .lock().map_err(|e| e.to_string())?;
        let mut next = runtime.settings.clone();
        next.claude_connection_mode = mode;
        persist(&mut runtime, next)?;
        drop(runtime);
        crate::slash_commands::invalidate_provider("claude");
        crate::agent_usage::invalidate("claude");
        configuration()
    }).await?;
    let _ = app.emit("provider-models-changed", serde_json::json!({"provider":"claude"}));
    Ok(result)
}
/// Choose the MiMo cluster shown on the Token Plan page, or pay-as-you-go.
#[tauri::command]
pub async fn provider_set_mimo_endpoint(
    app: tauri::AppHandle,
    endpoint: String,
) -> Result<Configuration> {
    if crate::providers::mimo_endpoint_url(&endpoint).is_none() {
        return Err("Choose one of the MiMo endpoints listed in Settings.".into());
    }
    let result = crate::blocking(move || {
        let mut runtime = CONFIG
            .get()
            .ok_or("Provider settings are not initialized.")?
            .lock()
            .map_err(|e| e.to_string())?;
        let mut next = runtime.settings.clone();
        next.mimo_endpoint = Some(endpoint);
        persist(&mut runtime, next)?;
        drop(runtime);
        crate::agent_usage::invalidate("mimo");
        configuration()
    })
    .await?;
    let _ = app.emit(
        "provider-models-changed",
        serde_json::json!({"provider":"mimo"}),
    );
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configuration_keeps_storage_errors_recoverable_without_serializing_keys() {
        assert_eq!(credential_status(Ok(None)), (false, None));
        let (glm_key_saved, credential_storage_error) =
            credential_status(Ok(Some("fixture-private-key".into())));
        let configuration = Configuration {
            executable_paths: BTreeMap::new(),
            global_environment: Vec::new(),
            environment: BTreeMap::new(),
            use_global_environment: BTreeMap::new(),
            glm_key_saved,
            glm_key_from_environment: false,
            mimo_key_saved: false,
            mimo_key_from_environment: false,
            deepseek_key_saved: false,
            deepseek_key_from_environment: false,
            commandcode_key_saved: false,
            commandcode_key_from_environment: false,
            mimo_endpoint: None,
            mimo_endpoints: mimo_endpoints(),
            claude_connection_mode: Default::default(),
            secure_storage_available: true,
            credential_storage_error,
        };
        let encoded = serde_json::to_value(&configuration).unwrap();
        assert_eq!(encoded["glmKeySaved"], true);
        assert!(encoded.get("credentialStorageError").is_none());
        assert!(!encoded.to_string().contains("fixture-private-key"));

        let warning = "Secure storage is locked. Set ZAI_API_KEY in the app environment.";
        let (glm_key_saved, credential_storage_error) = credential_status(Err(warning.into()));
        let configuration = Configuration {
            executable_paths: BTreeMap::from([("glm".into(), "installed-executable".into())]),
            global_environment: vec!["HTTP_PROXY".into()],
            environment: BTreeMap::from([("glm".into(), vec!["HTTPS_PROXY".into()])]),
            use_global_environment: BTreeMap::from([("glm".into(), false), ("claude".into(), true)]),
            glm_key_saved,
            glm_key_from_environment: true,
            mimo_key_saved: true,
            mimo_key_from_environment: false,
            deepseek_key_saved: false,
            deepseek_key_from_environment: false,
            commandcode_key_saved: false,
            commandcode_key_from_environment: false,
            mimo_endpoint: Some("token-plan-sgp".into()),
            mimo_endpoints: mimo_endpoints(),
            claude_connection_mode: Default::default(),
            secure_storage_available: true,
            credential_storage_error,
        };
        let encoded = serde_json::to_value(&configuration).unwrap();
        assert_eq!(encoded["executablePaths"]["glm"], "installed-executable");
        assert_eq!(encoded["glmKeySaved"], false);
        assert_eq!(encoded["glmKeyFromEnvironment"], true);
        assert_eq!(encoded["mimoKeySaved"], true);
        assert_eq!(encoded["mimoEndpoint"], "token-plan-sgp");
        assert_eq!(encoded["mimoEndpoints"][0]["id"], "token-plan-cn");
        assert_eq!(encoded["mimoEndpoints"][3]["url"], "https://api.xiaomimimo.com/anthropic");
        assert_eq!(encoded["secureStorageAvailable"], true);
        assert_eq!(encoded["credentialStorageError"], warning);
    }

    #[cfg(any(target_os = "linux", target_os = "windows"))]
    #[test]
    fn native_key_results_distinguish_absence_invalid_keys_and_store_failures() {
        assert_eq!(
            native_key_result(GLM_KEY, Err(keyring::Error::NoEntry)).unwrap(),
            None
        );
        assert_eq!(
            native_key_result(GLM_KEY, Ok(" fixture-key ".into())).unwrap(),
            Some("fixture-key".into())
        );
        let invalid_error = "The saved GLM key is invalid. Replace it in Settings.";
        for key in [String::new(), "fixture\nkey".into(), "x".repeat(4097)] {
            assert_eq!(native_key_result(GLM_KEY, Ok(key)).unwrap_err(), invalid_error);
        }
        assert_eq!(
            native_key_result(GLM_KEY, Err(keyring::Error::BadEncoding(b"private bytes".to_vec())))
                .unwrap_err(),
            invalid_error
        );
        for error in [
            keyring::Error::NoStorageAccess(Box::new(std::io::Error::other("private diagnostic"))),
            keyring::Error::PlatformFailure(Box::new(std::io::Error::other("private diagnostic"))),
            keyring::Error::Ambiguous(Vec::new()),
        ] {
            let error = native_key_result(GLM_KEY, Err(error)).unwrap_err();
            assert!(error.contains("ZAI_API_KEY"));
            assert!(!error.contains("private"));
            assert!(error.contains(if cfg!(target_os = "windows") {
                "Windows Credential Manager"
            } else {
                "Secret Service"
            }));
        }
    }

    #[cfg(any(target_os = "linux", target_os = "windows"))]
    #[test]
    fn native_key_removal_is_idempotent_and_sanitizes_failures() {
        assert!(native_key_removal_result(GLM_KEY, Ok(())).is_ok());
        assert!(native_key_removal_result(GLM_KEY, Err(keyring::Error::NoEntry)).is_ok());
        let error = native_key_removal_result(GLM_KEY, Err(keyring::Error::NoStorageAccess(Box::new(
            std::io::Error::other("private store diagnostic"),
        ))))
        .unwrap_err();
        assert!(error.contains("remove") && error.contains("ZAI_API_KEY"));
        assert!(!error.contains("private"));
    }

    #[test]
    fn selected_opencode_models_round_trip_with_legacy_settings() {
        let legacy: Settings =
            serde_json::from_value(serde_json::json!({"executablePaths":{}})).unwrap();
        let mut data = serde_json::to_value(legacy).unwrap();
        data["opencodeModels"] = serde_json::json!(["provider/model-one", "provider/model-two"]);
        let settings: Settings = serde_json::from_value(data).unwrap();
        assert_eq!(
            serde_json::to_value(settings).unwrap()["opencodeModels"],
            serde_json::json!(["provider/model-one", "provider/model-two"])
        );
    }
    #[test]
    fn settings_only_serialize_executable_paths() {
        let mut settings = Settings::default();
        settings
            .executable_paths
            .insert("opencode".into(), "/opt/bin/opencode".into());
        let value = serde_json::to_value(&settings).unwrap();
        assert_eq!(value.as_object().unwrap().len(), 1);
        assert!(serde_json::from_value::<Settings>(
            serde_json::json!({"executablePaths":{},"apiKey":"secret"})
        )
        .is_err());
    }
    #[test]
    fn saves_selected_models_across_reload_without_losing_connections() {
        let directory =
            std::env::temp_dir().join(format!("pandacode-model-settings-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let mut runtime = Runtime {
            path: directory.join("provider-settings.json"),
            settings: Settings::default(),
        };
        let mut next = runtime.settings.clone();
        next.executable_paths
            .insert("opencode".into(), "/opt/bin/opencode".into());
        next.opencode_models =
            validated_opencode_models(vec!["vendor/model-one".into(), "vendor/model-two".into()])
                .unwrap();
        persist(&mut runtime, next).unwrap();
        let reloaded: Settings =
            serde_json::from_slice(&std::fs::read(&runtime.path).unwrap()).unwrap();
        assert_eq!(
            reloaded.opencode_models,
            ["vendor/model-one", "vendor/model-two"]
        );
        assert_eq!(reloaded.executable_paths["opencode"], "/opt/bin/opencode");
        let mut cleared = reloaded;
        cleared.opencode_models.clear();
        persist(&mut runtime, cleared).unwrap();
        let reloaded: Settings =
            serde_json::from_slice(&std::fs::read(&runtime.path).unwrap()).unwrap();
        assert!(reloaded.opencode_models.is_empty());
        assert_eq!(reloaded.executable_paths["opencode"], "/opt/bin/opencode");
        std::fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn failed_save_keeps_previous_selection_in_memory() {
        let mut runtime = Runtime {
            path: std::env::temp_dir()
                .join(uuid::Uuid::new_v4().to_string())
                .join("settings.json"),
            settings: Settings::default(),
        };
        runtime.settings.opencode_models = vec!["vendor/current".into()];
        let mut next = runtime.settings.clone();
        next.opencode_models = vec!["vendor/new".into()];
        assert!(persist(&mut runtime, next).is_err());
        assert_eq!(runtime.settings.opencode_models, ["vendor/current"]);
    }
    #[test]
    fn validates_saved_model_ids_without_echoing_untrusted_values() {
        assert_eq!(
            validated_opencode_models(vec!["vendor/model:free".into(), "vendor/model:free".into()])
                .unwrap(),
            ["vendor/model:free"]
        );
        for id in [
            "default",
            "/model",
            "vendor/",
            "vendor/secret\nvalue",
            "vendor/model name",
        ] {
            let error = validated_opencode_models(vec![id.into()]).unwrap_err();
            assert!(!error.contains(id));
        }
        assert!(validated_opencode_models(vec![format!("vendor/{}", "x".repeat(200))]).is_err());
        assert!(validated_opencode_models(
            (0..101)
                .map(|index| format!("vendor/model-{index}"))
                .collect()
        )
        .is_err());
    }

    #[test]
    fn environment_variables_are_validated_before_they_are_saved() {
        assert!(validated_environment_variable("claude", "HTTPS_PROXY", "http://127.0.0.1:7890").is_ok());
        assert!(validated_environment_variable("claude", "EMPTY_ALLOWED", "").is_ok());
        for provider in ["nope", ""] {
            assert!(validated_environment_variable(provider, "A", "1").is_err(), "{provider}");
        }
        for name in ["", "1ABC", "A-B", "A B", "A=B", &"x".repeat(129)] {
            assert!(validated_environment_variable("claude", name, "1").is_err(), "{name}");
        }
        for value in [&"x".repeat(MAX_ENV_VALUE + 1), "a\0b"] {
            assert!(validated_environment_variable("claude", "A", value).is_err());
        }
        assert!(valid_env_name(&"x".repeat(128)));
    }

    #[test]
    fn saved_environment_survives_a_reload_and_junk_entries_are_dropped() {
        let settings: Settings = serde_json::from_value(serde_json::json!({
            "executablePaths": {},
            "environment": {"claude": {"HTTPS_PROXY": "http://127.0.0.1:7890", "NO_PROXY": "localhost"}, "nope": {"A": "1"}}
        }))
        .unwrap();
        assert_eq!(
            valid_environment(settings.environment)["claude"],
            BTreeMap::from([("HTTPS_PROXY".into(), "http://127.0.0.1:7890".into()), ("NO_PROXY".into(), "localhost".into())])
        );
        let mut junk: BTreeMap<String, BTreeMap<String, String>> = BTreeMap::from([
            ("claude".into(), BTreeMap::from([("BAD-NAME".into(), "1".into()), ("OK".into(), "2".into())])),
            ("codex".into(), (0..MAX_ENV + 1).map(|index| (format!("V{index}"), "1".into())).collect()),
        ]);
        junk.insert("kimi".into(), BTreeMap::new());
        let kept = valid_environment(junk);
        assert_eq!(kept["claude"], BTreeMap::from([("OK".into(), "2".into())]));
        assert!(!kept.contains_key("codex"), "an over-cap provider is dropped entirely");
        assert!(!kept.contains_key("kimi"), "an empty provider is dropped");
    }

    #[test]
    fn saved_global_environment_survives_a_reload_and_junk_entries_are_dropped() {
        let settings: Settings = serde_json::from_value(serde_json::json!({
            "executablePaths": {},
            "globalEnvironment": {"HTTPS_PROXY": "http://127.0.0.1:7890", "BAD-NAME": "1", "A\0B": "1"},
            "globalEnvironmentDisabled": ["claude", "nope"]
        }))
        .unwrap();
        assert_eq!(
            valid_vars(settings.global_environment),
            BTreeMap::from([("HTTPS_PROXY".into(), "http://127.0.0.1:7890".into())])
        );
        // The opt-out list keeps only providers PandaCode knows (in setup()).
        assert_eq!(settings.global_environment_disabled, ["claude", "nope"]);
        // Default is on: an absent list means every provider uses the global set.
        let legacy: Settings = serde_json::from_value(serde_json::json!({"executablePaths": {}})).unwrap();
        assert!(legacy.global_environment_disabled.is_empty());
        assert!(legacy.global_environment.is_empty());
    }

    #[test]
    fn a_save_that_would_cross_the_load_cap_is_refused_and_keeps_the_previous_settings() {
        let directory =
            std::env::temp_dir().join(format!("pandacode-env-budget-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let mut runtime = Runtime {
            path: directory.join("provider-settings.json"),
            settings: Settings::default(),
        };
        let mut next = runtime.settings.clone();
        next.environment.insert(
            "claude".into(),
            (0..MAX_ENV).map(|index| (format!("VAR_{index}"), "x".repeat(900))).collect(),
        );
        let refused = persist(&mut runtime, next.clone());
        assert!(refused.is_err(), "64 × 900-byte values cross the 56 KiB save budget");
        assert!(refused.unwrap_err().contains("storage budget"));
        assert!(runtime.settings.environment.is_empty(), "the in-memory settings keep the previous state");
        // A modest set still saves, and the global cap drops an over-cap hand-edited set.
        next.environment.insert("claude".into(), BTreeMap::from([("A".into(), "1".into())]));
        persist(&mut runtime, next).unwrap();
        let over_cap: BTreeMap<String, String> =
            (0..MAX_ENV + 1).map(|index| (format!("V{index}"), "1".into())).collect();
        assert!(valid_global_environment(over_cap).is_empty());
        let under_cap = valid_global_environment(BTreeMap::from([("A".into(), "1".into())]));
        assert_eq!(under_cap.len(), 1);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn apply_environment_sets_saved_variables_on_a_command() {
        let vars = vec![
            ("HTTPS_PROXY".to_string(), "http://127.0.0.1:7890".to_string()),
            ("NO_PROXY".to_string(), "localhost,127.0.0.1".to_string()),
        ];
        let mut command = tokio::process::Command::new("claude");
        apply_vars(&vars, &mut command);
        let env: std::collections::HashMap<_, _> = command.as_std().get_envs().collect();
        assert_eq!(
            env[std::ffi::OsStr::new("HTTPS_PROXY")],
            Some(std::ffi::OsStr::new("http://127.0.0.1:7890"))
        );
        assert_eq!(
            env[std::ffi::OsStr::new("NO_PROXY")],
            Some(std::ffi::OsStr::new("localhost,127.0.0.1"))
        );
        let fingerprint = serde_json::to_string(&vars).unwrap();
        assert!(fingerprint.contains("HTTPS_PROXY"));
        assert_ne!(fingerprint, serde_json::to_string(&Vec::<(String, String)>::new()).unwrap());
    }

    #[test]
    fn configuration_lists_environment_names_but_never_values() {
        let (glm_key_saved, _) = credential_status(Ok(None));
        let configuration = Configuration {
            executable_paths: BTreeMap::new(),
            global_environment: vec!["HTTP_PROXY".into()],
            environment: BTreeMap::from([(
                "claude".into(),
                vec!["HTTPS_PROXY".into(), "NO_PROXY".into()],
            )]),
            use_global_environment: BTreeMap::from([("glm".into(), false), ("claude".into(), true)]),
            glm_key_saved,
            glm_key_from_environment: false,
            mimo_key_saved: false,
            mimo_key_from_environment: false,
            deepseek_key_saved: false,
            deepseek_key_from_environment: false,
            commandcode_key_saved: false,
            commandcode_key_from_environment: false,
            mimo_endpoint: None,
            mimo_endpoints: mimo_endpoints(),
            claude_connection_mode: Default::default(),
            secure_storage_available: true,
            credential_storage_error: None,
        };
        let encoded = serde_json::to_value(&configuration).unwrap();
        assert_eq!(encoded["environment"]["claude"], serde_json::json!(["HTTPS_PROXY", "NO_PROXY"]));
        assert_eq!(encoded["globalEnvironment"], serde_json::json!(["HTTP_PROXY"]));
        assert_eq!(encoded["useGlobalEnvironment"]["glm"], false);
        assert_eq!(encoded["useGlobalEnvironment"]["claude"], true);
    }

    #[test]
    fn the_effective_environment_merges_global_and_provider_variables() {
        let settings = Settings {
            global_environment: BTreeMap::from([
                ("HTTP_PROXY".into(), "http://127.0.0.1:7890".into()),
                ("HTTPS_PROXY".into(), "http://127.0.0.1:7890".into()),
            ]),
            environment: BTreeMap::from([(
                "claude".into(),
                BTreeMap::from([("HTTPS_PROXY".into(), "http://127.0.0.1:1080".into())]),
            )]),
            global_environment_disabled: vec!["codex".into()],
            ..Settings::default()
        };
        // Global on for claude; the provider's own value overrides the shared name.
        assert_eq!(
            effective_environment(&settings, "claude"),
            [
                ("HTTPS_PROXY".to_string(), "http://127.0.0.1:1080".to_string()),
                ("HTTP_PROXY".to_string(), "http://127.0.0.1:7890".to_string()),
            ]
        );
        // The opt-out leaves codex with nothing of its own.
        assert_eq!(effective_environment(&settings, "codex"), Vec::new());
        // Different effective environments produce different warm-key fingerprints.
        assert_ne!(
            serde_json::to_string(&effective_environment(&settings, "claude")).unwrap(),
            serde_json::to_string(&effective_environment(&settings, "codex")).unwrap()
        );
    }

    #[test]
    fn saving_and_removing_environment_variables_updates_the_map_and_prunes_empty_providers() {
        let mut environment = BTreeMap::new();
        insert_env_var(&mut environment, "claude", "HTTPS_PROXY", "http://127.0.0.1:7890").unwrap();
        assert_eq!(environment["claude"]["HTTPS_PROXY"], "http://127.0.0.1:7890");
        // Saving again replaces the value instead of duplicating the name.
        insert_env_var(&mut environment, "claude", "HTTPS_PROXY", "http://127.0.0.1:1080").unwrap();
        assert_eq!(environment["claude"]["HTTPS_PROXY"], "http://127.0.0.1:1080");
        assert!(drop_env_var(&mut environment, "claude", "HTTPS_PROXY"));
        assert!(!environment.contains_key("claude"), "the last variable prunes the provider");
        assert!(!drop_env_var(&mut environment, "claude", "HTTPS_PROXY"), "removing is idempotent");
        insert_env_var(&mut environment, "claude", "A", "1").unwrap();
        for index in 1..MAX_ENV {
            insert_env_var(&mut environment, "claude", &format!("V{index}"), "1").unwrap();
        }
        assert!(insert_env_var(&mut environment, "claude", "ONE_MORE", "1").is_err());
        // A saved name can always be replaced, even at the cap.
        insert_env_var(&mut environment, "claude", "A", "2").unwrap();
        assert_eq!(environment["claude"]["A"], "2");
    }
    #[test]
    fn rejects_command_strings_directories_and_unknown_providers() {
        assert!(validated_executable("codex", "").is_err());
        assert!(validated_executable("opencode", "opencode --flag").is_err());
        assert!(validated_executable("opencode", "/tmp").is_err());
        assert!(validated_executable("antigravity", "/tmp/foo\nbar").is_err());
        assert_eq!(validated_executable("glm", "").unwrap(), None);
        assert_eq!(validated_executable("mimo", "").unwrap(), None);
    }
    #[test]
    fn mimo_endpoint_survives_reload_and_unknown_clusters_are_dropped() {
        let settings: Settings = serde_json::from_value(serde_json::json!({"executablePaths":{},"mimoEndpoint":"token-plan-ams"})).unwrap();
        assert_eq!(settings.mimo_endpoint.as_deref(), Some("token-plan-ams"));
        assert_eq!(serde_json::to_value(&settings).unwrap()["mimoEndpoint"], "token-plan-ams");
        let unknown: Settings = serde_json::from_value(serde_json::json!({"executablePaths":{},"mimoEndpoint":"https://evil.example/anthropic"})).unwrap();
        assert!(unknown.mimo_endpoint.filter(|id| crate::providers::mimo_endpoint_url(id).is_some()).is_none());
    }

    #[test]
    fn claude_connection_mode_defaults_to_inherit_and_persists_without_affecting_relays() {
        use crate::providers::claude_auth::Mode;
        let mut settings: Settings = serde_json::from_value(serde_json::json!({"executablePaths":{},"mimoEndpoint":"token-plan-ams"})).unwrap();
        assert_eq!(settings.claude_connection_mode, Mode::Inherit);
        assert!(serde_json::to_value(&settings).unwrap().get("claudeConnectionMode").is_none());
        settings.claude_connection_mode = Mode::Subscription;
        let persisted = serde_json::to_value(&settings).unwrap();
        assert_eq!(persisted["claudeConnectionMode"], "subscription");
        assert_eq!(persisted["mimoEndpoint"], "token-plan-ams");
        assert_eq!(serde_json::from_value::<Settings>(persisted).unwrap().claude_connection_mode, Mode::Subscription);
        assert!(serde_json::from_value::<Settings>(serde_json::json!({"executablePaths":{},"claudeConnectionMode":"unknown"})).is_err());
    }
    #[test]
    fn validates_key_without_echoing_it() {
        assert_eq!(validate_key(" key ").unwrap(), "key");
        assert!(validate_key("secret\nvalue")
            .unwrap_err()
            .contains("valid API key"));
        assert!(validate_key("").is_err());
        assert!(validate_key(&"x".repeat(4097)).is_err());
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    #[test]
    fn usage_secure_store_busy_check_returns_without_another_os_read() {
        let _access = glm_usage_access().unwrap();
        assert!(glm_key_for_usage().unwrap_err().contains("busy"));
    }
}
