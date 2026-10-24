//! Named provider connections: several setups of one harness (work and personal
//! subscriptions, separate Pi profiles). Each has its own executable, extra
//! arguments, environment and config folder. Non-secret values live in
//! `connections.json` beside the provider settings; secret values live in the
//! OS secure store under one account per connection and variable, and never
//! reach the webview, logs or errors. A task without a connection uses the
//! global provider configuration, exactly as before.
use crate::Result;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};

const SERVICE: &str = "app.pandacode.connections";
const MAX_CONNECTIONS: usize = 50;
const MAX_ARGS: usize = 32;
const MAX_ARG_LEN: usize = 1024;
const MAX_ENV: usize = 64;
const MAX_ENV_VALUE: usize = 4096;
const MAX_NAME: usize = 60;
// ponytail: assignments of deleted tasks stay until the cap trims them; prune
// on task deletion if this ever matters.
const MAX_TASKS: usize = 5000;
const PROVIDERS: &[&str] = &[
    "claude", "codex", "kimi", "opencode", "glm", "antigravity", "grok", "mimo", "pi", "deepseek", "commandcode", "cline", "kilo", "omp", "github-copilot", "muse",
];

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Connection {
    pub id: String,
    pub provider: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub executable: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    /// Non-secret variables with their values.
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// Names of variables whose values are in the secure store.
    #[serde(default)]
    pub secret_env: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config_dir: Option<String>,
    /// Bumped on every save, so a warm agent never outlives a changed connection.
    #[serde(default)]
    pub revision: u64,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Snapshot {
    connections: Vec<Connection>,
    /// Task id → connection id.
    tasks: BTreeMap<String, String>,
}

struct Runtime {
    path: PathBuf,
    data: Snapshot,
}
static CONFIG: OnceLock<Mutex<Runtime>> = OnceLock::new();

pub fn setup(dir: &Path) -> Result<()> {
    let path = dir.join("connections.json");
    let data = match std::fs::read(&path) {
        Ok(bytes) if bytes.len() > 1024 * 1024 => return Err("Connections file is too large.".into()),
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| "Could not load provider connections.".to_owned())?,
        Err(_) => Snapshot::default(),
    };
    CONFIG
        .set(Mutex::new(Runtime { path, data }))
        .map_err(|_| "Provider connections are already initialized.".into())
}

fn runtime() -> Result<std::sync::MutexGuard<'static, Runtime>> {
    CONFIG
        .get()
        .ok_or("Provider connections are not initialized.")?
        .lock()
        .map_err(|e| e.to_string())
}

fn persist(runtime: &mut Runtime, next: Snapshot) -> Result<()> {
    let temp = runtime.path.with_extension("json.tmp");
    std::fs::write(&temp, serde_json::to_vec_pretty(&next).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    if let Err(error) = std::fs::rename(&temp, &runtime.path) {
        let _ = std::fs::remove_file(&temp);
        return Err(error.to_string());
    }
    runtime.data = next;
    Ok(())
}

/// The connection a task launches with, if it has one for this provider.
/// An assignment left from another provider is ignored.
pub fn for_task(session_id: &str, provider: &str) -> Option<Connection> {
    let runtime = CONFIG.get()?.lock().ok()?;
    let id = runtime.data.tasks.get(session_id)?;
    runtime.data.connections.iter().find(|c| &c.id == id && c.provider == provider).cloned()
}

/// The folder variable each harness reads for its own config and login.
fn config_dir_var(provider: &str) -> Option<&'static str> {
    match provider {
        "claude" | "glm" | "mimo" => Some("CLAUDE_CONFIG_DIR"),
        "codex" => Some("CODEX_HOME"),
        "pi" => Some("PI_CODING_AGENT_DIR"),
        "opencode" => Some("OPENCODE_CONFIG_DIR"),
        "kilo" => Some("KILO_CONFIG_DIR"),
        _ => None,
    }
}

fn secret_account(id: &str, name: &str) -> String {
    format!("{id}/{name}")
}

/// Everything a launch needs from a connection. `secrets` are only for redaction.
pub struct Launch {
    pub executable: Option<PathBuf>,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub secrets: Vec<String>,
}

pub fn launch(connection: &Connection) -> Result<Launch> {
    launch_with(connection, |account| crate::secret_store::get(SERVICE, account))
}

fn launch_with(connection: &Connection, secret: impl Fn(&str) -> Option<String>) -> Result<Launch> {
    let mut env: Vec<(String, String)> = connection.env.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    let mut secrets = Vec::new();
    for name in &connection.secret_env {
        let value = secret(&secret_account(&connection.id, name)).ok_or_else(|| {
            format!("The saved value of {name} for the connection “{}” is missing. Enter it again in Settings.", connection.name)
        })?;
        secrets.push(value.clone());
        env.push((name.clone(), value));
    }
    if let (Some(dir), Some(var)) = (&connection.config_dir, config_dir_var(&connection.provider)) {
        env.push((var.into(), dir.clone()));
    }
    Ok(Launch { executable: connection.executable.as_ref().map(PathBuf::from), args: connection.args.clone(), env, secrets })
}

impl Launch {
    pub fn apply(&self, command: &mut tokio::process::Command) {
        command.args(&self.args).envs(self.env.iter().map(|(k, v)| (k, v)));
    }
    pub fn redact(&self, text: &str) -> String {
        self.secrets.iter().filter(|s| !s.is_empty()).fold(text.to_owned(), |text, secret| text.replace(secret.as_str(), "[redacted]"))
    }
}

/// Part of the warm-agent key: a different connection (or a changed one) never adopts
/// another's process. Holds only the id and revision, never values.
pub fn warm_key(session_id: &str, provider: &str) -> String {
    for_task(session_id, provider).map(|c| format!("{}#{}", c.id, c.revision)).unwrap_or_default()
}

fn valid_env_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        && !name.starts_with(|c: char| c.is_ascii_digit())
}

/// One variable from the settings form. A secret without a value keeps its saved one.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EnvInput {
    name: String,
    #[serde(default)]
    value: Option<String>,
    #[serde(default)]
    secret: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Input {
    #[serde(default)]
    id: Option<String>,
    provider: String,
    name: String,
    #[serde(default)]
    executable: Option<String>,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: Vec<EnvInput>,
    #[serde(default)]
    config_dir: Option<String>,
}

fn validate_args(args: &[String]) -> Result<()> {
    if args.len() > MAX_ARGS {
        return Err(format!("Use up to {MAX_ARGS} launch arguments."));
    }
    if args.iter().any(|a| a.is_empty() || a.len() > MAX_ARG_LEN || a.contains('\0')) {
        return Err(format!("Launch arguments must be non-empty, under {MAX_ARG_LEN} characters and contain no NUL."));
    }
    Ok(())
}

fn validate_dir(dir: Option<String>, provider: &str) -> Result<Option<String>> {
    let Some(dir) = dir.filter(|d| !d.trim().is_empty()) else { return Ok(None) };
    if config_dir_var(provider).is_none() {
        return Err("Set this harness's config folder variable under Environment instead.".into());
    }
    if dir.len() > 4096 || dir.chars().any(char::is_control) || !Path::new(&dir).is_absolute() {
        return Err("Choose an absolute config folder path.".into());
    }
    Ok(Some(dir))
}

/// Checks everything except secret values, which go straight to the secure store.
/// Returns the stored connection and the secrets to save (name, value).
fn validated(input: Input, existing: Option<&Connection>) -> Result<(Connection, Vec<(String, String)>)> {
    if !PROVIDERS.contains(&input.provider.as_str()) {
        return Err("Choose an available harness.".into());
    }
    if let Some(existing) = existing {
        if existing.provider != input.provider {
            return Err("A connection's harness cannot change. Add a new connection instead.".into());
        }
    }
    let name = input.name.trim().to_owned();
    if name.is_empty() || name.chars().count() > MAX_NAME || name.chars().any(char::is_control) {
        return Err(format!("Give the connection a name of up to {MAX_NAME} characters."));
    }
    validate_args(&input.args)?;
    let executable = match input.executable.filter(|p| !p.trim().is_empty()) {
        Some(path) => crate::provider_settings::validated_executable_path(&path)?,
        None => None,
    };
    let config_dir = validate_dir(input.config_dir, &input.provider)?;
    if input.env.len() > MAX_ENV {
        return Err(format!("Use up to {MAX_ENV} environment variables."));
    }
    let mut env = BTreeMap::new();
    let mut secret_env = Vec::new();
    let mut secrets = Vec::new();
    for var in input.env {
        if !valid_env_name(&var.name) {
            return Err("Environment variable names use letters, digits and underscores, and do not start with a digit.".into());
        }
        if env.contains_key(&var.name) || secret_env.contains(&var.name) {
            return Err(format!("{} is listed twice.", var.name));
        }
        let value = var.value.filter(|v| !v.is_empty());
        if value.as_ref().is_some_and(|v| v.len() > MAX_ENV_VALUE || v.contains('\0')) {
            return Err(format!("The value of {} is too long or contains NUL.", var.name));
        }
        if var.secret {
            match value {
                Some(value) => secrets.push((var.name.clone(), value)),
                None if existing.is_some_and(|c| c.secret_env.contains(&var.name)) => {}
                None => return Err(format!("Enter a value for {}.", var.name)),
            }
            secret_env.push(var.name);
        } else {
            env.insert(var.name, value.unwrap_or_default());
        }
    }
    let connection = Connection {
        id: existing.map_or_else(|| uuid::Uuid::new_v4().to_string(), |c| c.id.clone()),
        provider: input.provider,
        name,
        executable,
        args: input.args,
        env,
        secret_env,
        config_dir,
        revision: existing.map_or(1, |c| c.revision + 1),
    };
    Ok((connection, secrets))
}

#[tauri::command]
pub async fn connections_list() -> Result<Snapshot> {
    Ok(runtime()?.data.clone())
}

#[tauri::command]
pub async fn connection_save(connection: Input) -> Result<Snapshot> {
    crate::blocking(move || {
        let mut runtime = runtime()?;
        let index = match &connection.id {
            Some(id) => Some(runtime.data.connections.iter().position(|c| &c.id == id).ok_or("This connection no longer exists.")?),
            None if runtime.data.connections.len() >= MAX_CONNECTIONS => return Err(format!("Use up to {MAX_CONNECTIONS} connections.")),
            None => None,
        };
        let previous = index.map(|i| runtime.data.connections[i].clone());
        let (saved, secrets) = validated(connection, previous.as_ref())?;
        for (name, value) in &secrets {
            crate::secret_store::set(SERVICE, &secret_account(&saved.id, name), value)?;
        }
        for dropped in previous.iter().flat_map(|c| &c.secret_env).filter(|n| !saved.secret_env.contains(n)) {
            crate::secret_store::remove(SERVICE, &secret_account(&saved.id, dropped));
        }
        let mut next = runtime.data.clone();
        match index {
            Some(i) => next.connections[i] = saved,
            None => next.connections.push(saved),
        }
        persist(&mut runtime, next)?;
        Ok(runtime.data.clone())
    })
    .await
}

#[tauri::command]
pub async fn connection_delete(id: String) -> Result<Snapshot> {
    crate::blocking(move || {
        let mut runtime = runtime()?;
        let Some(removed) = runtime.data.connections.iter().find(|c| c.id == id).cloned() else {
            return Ok(runtime.data.clone());
        };
        let mut next = runtime.data.clone();
        next.connections.retain(|c| c.id != id);
        next.tasks.retain(|_, connection| *connection != id);
        persist(&mut runtime, next)?;
        for name in &removed.secret_env {
            crate::secret_store::remove(SERVICE, &secret_account(&removed.id, name));
        }
        Ok(runtime.data.clone())
    })
    .await
}

/// Set (or clear, with `None`) the connection a task launches with.
#[tauri::command]
pub async fn connection_assign(
    state: tauri::State<'_, crate::AppState>,
    session_id: String,
    connection_id: Option<String>,
) -> Result<Snapshot> {
    if state.agents.lock().map_err(|e| e.to_string())?.contains_key(&session_id) {
        return Err("Stop the agent before changing its connection.".into());
    }
    if session_id.is_empty() || session_id.len() > 128 {
        return Err("Unknown task.".into());
    }
    crate::blocking(move || {
        let mut runtime = runtime()?;
        let mut next = runtime.data.clone();
        assign(&mut next, session_id, connection_id)?;
        persist(&mut runtime, next)?;
        Ok(runtime.data.clone())
    })
    .await
}

fn assign(data: &mut Snapshot, session_id: String, connection_id: Option<String>) -> Result<()> {
    match connection_id {
        Some(id) => {
            if !data.connections.iter().any(|c| c.id == id) {
                return Err("This connection no longer exists.".into());
            }
            if !data.tasks.contains_key(&session_id) && data.tasks.len() >= MAX_TASKS {
                let oldest = data.tasks.keys().next().cloned();
                if let Some(oldest) = oldest {
                    data.tasks.remove(&oldest);
                }
            }
            data.tasks.insert(session_id, id);
        }
        None => {
            data.tasks.remove(&session_id);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(provider: &str) -> Input {
        Input { id: None, provider: provider.into(), name: "Claude Work".into(), executable: None, args: vec![], env: vec![], config_dir: None }
    }

    #[test]
    fn validation_rejects_bad_names_args_env_and_folders() {
        assert!(validated(input("claude"), None).is_ok());
        assert!(validated(Input { provider: "nope".into(), ..input("claude") }, None).is_err());
        assert!(validated(Input { name: " ".into(), ..input("claude") }, None).is_err());
        assert!(validated(Input { name: "x".repeat(61), ..input("claude") }, None).is_err());
        assert!(validated(Input { args: vec!["a\0b".into()], ..input("claude") }, None).is_err());
        assert!(validated(Input { args: vec!["x".repeat(1025)], ..input("claude") }, None).is_err());
        assert!(validated(Input { args: vec!["--x".into(); 33], ..input("claude") }, None).is_err());
        assert!(validated(Input { args: vec!["--verbose".into(); 32], ..input("claude") }, None).is_ok());
        for name in ["", "1ABC", "A-B", "A B", "A=B"] {
            let env = vec![EnvInput { name: name.into(), value: Some("v".into()), secret: false }];
            assert!(validated(Input { env, ..input("claude") }, None).is_err(), "{name}");
        }
        let nul = vec![EnvInput { name: "A".into(), value: Some("a\0".into()), secret: false }];
        assert!(validated(Input { env: nul, ..input("claude") }, None).is_err());
        let twice = vec![EnvInput { name: "A".into(), value: None, secret: false }, EnvInput { name: "A".into(), value: Some("k".into()), secret: true }];
        assert!(validated(Input { env: twice, ..input("claude") }, None).is_err());
        assert!(validated(Input { config_dir: Some("relative/dir".into()), ..input("claude") }, None).is_err());
        assert!(validated(Input { config_dir: Some("/tmp/x".into()), ..input("grok") }, None).is_err());
        assert!(validated(Input { executable: Some("/definitely/missing".into()), ..input("claude") }, None).is_err());
    }

    #[test]
    fn secrets_are_split_out_and_kept_when_left_blank() {
        let env = vec![
            EnvInput { name: "PLAIN".into(), value: Some("1".into()), secret: false },
            EnvInput { name: "API_KEY".into(), value: Some("fixture-secret".into()), secret: true },
        ];
        let (saved, secrets) = validated(Input { env, ..input("claude") }, None).unwrap();
        assert_eq!(secrets, [("API_KEY".to_string(), "fixture-secret".to_string())]);
        assert_eq!(saved.secret_env, ["API_KEY"]);
        assert!(!serde_json::to_string(&saved).unwrap().contains("fixture-secret"));
        // Editing without retyping the secret keeps it; a new secret needs a value.
        let env = vec![EnvInput { name: "API_KEY".into(), value: None, secret: true }];
        let (edited, secrets) = validated(Input { id: Some(saved.id.clone()), env, ..input("claude") }, Some(&saved)).unwrap();
        assert!(secrets.is_empty());
        assert_eq!((edited.id.as_str(), edited.revision), (saved.id.as_str(), 2));
        let env = vec![EnvInput { name: "OTHER".into(), value: None, secret: true }];
        assert!(validated(Input { env, ..input("claude") }, Some(&saved)).is_err());
        assert!(validated(input("codex"), Some(&saved)).is_err(), "a connection keeps its harness");
    }

    #[test]
    fn launch_applies_args_env_secrets_and_config_dir_and_redacts() {
        let connection = Connection {
            id: "c1".into(),
            provider: "claude".into(),
            name: "Work".into(),
            args: vec!["--verbose".into()],
            env: BTreeMap::from([("PLAIN".into(), "1".into())]),
            secret_env: vec!["API_KEY".into()],
            config_dir: Some("/Users/me/.claude-work".into()),
            ..Default::default()
        };
        let launch = launch_with(&connection, |account| (account == "c1/API_KEY").then(|| "fixture-secret".to_string())).unwrap();
        let mut command = tokio::process::Command::new("true");
        launch.apply(&mut command);
        let std = command.as_std();
        assert_eq!(std.get_args().collect::<Vec<_>>(), ["--verbose"]);
        let envs: BTreeMap<_, _> = std.get_envs().map(|(k, v)| (k.to_str().unwrap().to_owned(), v.unwrap().to_str().unwrap().to_owned())).collect();
        assert_eq!(envs["PLAIN"], "1");
        assert_eq!(envs["API_KEY"], "fixture-secret");
        assert_eq!(envs["CLAUDE_CONFIG_DIR"], "/Users/me/.claude-work");
        assert_eq!(launch.redact("auth failed for fixture-secret"), "auth failed for [redacted]");
        let missing = launch_with(&connection, |_| None).err().unwrap();
        assert!(missing.contains("API_KEY") && !missing.contains("fixture"));
        let codex = launch_with(&Connection { provider: "codex".into(), secret_env: vec![], ..connection }, |_| None).unwrap();
        assert!(codex.env.contains(&("CODEX_HOME".into(), "/Users/me/.claude-work".into())));
    }

    #[test]
    fn assignment_requires_a_known_connection_and_clears() {
        let mut data = Snapshot { connections: vec![Connection { id: "c1".into(), ..Default::default() }], tasks: BTreeMap::new() };
        assert!(assign(&mut data, "t1".into(), Some("missing".into())).is_err());
        assign(&mut data, "t1".into(), Some("c1".into())).unwrap();
        assert_eq!(data.tasks["t1"], "c1");
        assign(&mut data, "t1".into(), None).unwrap();
        assert!(data.tasks.is_empty());
    }
}
