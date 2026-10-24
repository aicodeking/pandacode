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
    let (paths, mimo_endpoint, claude_connection_mode) = {
        let runtime = CONFIG
            .get()
            .ok_or("Provider settings are not initialized.")?
            .lock()
            .map_err(|e| e.to_string())?;
        (runtime.settings.executable_paths.clone(), runtime.settings.mimo_endpoint.clone(), runtime.settings.claude_connection_mode)
    };
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
        "opencode" | "antigravity" | "glm" | "grok" | "mimo" | "pi" | "deepseek" | "commandcode" | "cline" | "kilo" | "omp" | "github-copilot" | "muse"
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
    let temp = runtime.path.with_extension("json.tmp");
    std::fs::write(
        &temp,
        serde_json::to_vec_pretty(&next).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
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
        crate::providers::acp_catalog::invalidate("deepseek");
        configuration()
    })
    .await
}
#[tauri::command]
pub async fn provider_remove_deepseek_key() -> Result<Configuration> {
    crate::blocking(|| {
        remove_key(DEEPSEEK_KEY)?;
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
