//! One Claude usage check, set up from the environment Claude is launched
//! with (`ClaudeEnv`): its stores, saved-reading profile, whether Claude Code
//! may be asked to refresh an expired login, and whether subscription limits
//! apply at all.

use super::*;
use crate::agent_usage::http_client;

pub(super) fn stores(config: &Path, env: &ClaudeEnv) -> Vec<Store> {
    #[cfg(target_os = "macos")]
    let keychain = env.keychain.then(|| {
        Store::Keychain(claude_service(
            env.get("CLAUDE_CONFIG_DIR").as_deref(),
            env.get("CLAUDE_SECURESTORAGE_CONFIG_DIR").as_deref(),
        ))
    });
    // Off macOS there is no Keychain store; `env` only matters there.
    #[cfg(not(target_os = "macos"))]
    let keychain: Option<Store> = {
        let _ = env;
        None
    };
    keychain.into_iter().chain([Store::File(config.join(".credentials.json"))]).collect()
}

/// The signed-in account, from Claude Code's `.claude.json` (inside an explicit
/// CLAUDE_CONFIG_DIR, else in the home folder), so a saved reading of another
/// account is never shown. Only its email is read; it is keyed before use.
fn claude_json(config: &Path, env: &ClaudeEnv) -> Option<PathBuf> {
    match env.get("CLAUDE_CONFIG_DIR").filter(|dir| !dir.trim().is_empty()) {
        Some(_) => Some(config.join(".claude.json")),
        None => crate::agent_usage_providers::home().map(|home| home.join(".claude.json")),
    }
}

/// Blocking: the account in `.claude.json`, unless the file is huge (it also
/// holds project history).
pub(super) fn account_in(file: &Path) -> Option<String> {
    #[cfg(test)]
    {
        *account_reads().entry(file.to_path_buf()).or_default() += 1;
    }
    let small = std::fs::metadata(file).is_ok_and(|meta| meta.len() <= CLAUDE_JSON_LIMIT);
    small.then(|| crate::account_identity::claude(file).email).flatten()
}

/// The largest `.claude.json` read for the account hint (it also holds
/// project history; the parse is cached by path, size and modification
/// time, so a large file is parsed once per change).
pub(super) const CLAUDE_JSON_LIMIT: u64 = 64 * 1024 * 1024;
/// `late` answers within this, even if the profile cannot be worked out.
const LATE_LIMIT: Duration = Duration::from_secs(3);

/// Why subscription limits do not apply, if they don't: Claude's settings
/// could not be read, or Claude is launched with an API key, custom endpoint
/// or environment credentials. The launch environment is read as Claude gets
/// it: in "Prefer saved Claude login" mode those variables are removed at
/// launch (`claude_auth::stripped`), so they do not count; `settings.json`
/// (read by Claude itself) always does.
pub(super) async fn not_a_subscription(config: &Path, env: &ClaudeEnv) -> Option<Connection> {
    let unreadable = || Some(Connection::Other(Box::new(Usage::empty("claude", "unavailable", "Claude's settings could not be read. Check its configuration before viewing subscription usage."))));
    let (Ok(own), Ok(managed)) = (read_settings(&config.join("settings.json")).await, read_managed(config).await) else {
        return unreadable();
    };
    let settings = with_managed(own, &managed);
    let (name, from) = override_source(true, |name| env.get(name), &settings)?;
    let from = if from == OverrideFrom::Settings && managed_sets(&managed, name) { OverrideFrom::Managed } else { from };
    // Set by a named connection itself (applied last, also in "Prefer saved
    // Claude login" mode): that switch would not change it.
    let own = env.connection.iter().rev().find(|(key, _)| key == name).is_some_and(|(_, value)| !value.trim().is_empty());
    let from = if from == OverrideFrom::Environment && own { OverrideFrom::Connection } else { from };
    if name == OAUTH_TOKEN_VARIABLE {
        if let Some(token) = oauth_token(true, |name| env.get(name), &settings) {
            return Some(Connection::OauthToken(token, from));
        }
    }
    Some(Connection::Other(Box::new(api_connection(name, from))))
}

/// A Claude settings file as JSON (`Null` when absent); `Err` when it exists
/// but can't be read or parsed.
async fn read_settings(path: &Path) -> Result<Value, ()> {
    match crate::agent_usage_providers::credential_bytes(path).await? {
        Some(mut bytes) => {
            let parsed = serde_json::from_slice::<Value>(&bytes);
            bytes.fill(0);
            parsed.map_err(|_| ())
        }
        None => Ok(Value::Null),
    }
}

/// An administrator's managed settings (`Null` when there are none).
async fn read_managed(config: &Path) -> Result<Value, ()> {
    for path in managed_paths(config) {
        let managed = read_settings(&path).await?;
        if !managed.is_null() {
            return Ok(managed);
        }
    }
    Ok(Value::Null)
}

fn managed_paths(config: &Path) -> Vec<PathBuf> {
    #[cfg(test)]
    if let Some(path) = test_managed().get(config) {
        return vec![path.clone()];
    }
    let _ = config;
    managed_settings_paths()
}

/// Managed settings files by config folder (tests).
#[cfg(test)]
pub(super) fn test_managed() -> std::sync::MutexGuard<'static, HashMap<PathBuf, PathBuf>> {
    static MANAGED: OnceLock<std::sync::Mutex<HashMap<PathBuf, PathBuf>>> = OnceLock::new();
    MANAGED.get_or_init(Default::default).lock().unwrap_or_else(PoisonError::into_inner)
}

/// How Claude connects when it is not with the saved login.
pub(super) enum Connection {
    /// An API key, endpoint, provider or unreadable settings: no subscription usage.
    Other(Box<Usage>),
    /// `CLAUDE_CODE_OAUTH_TOKEN`: possibly a subscription token; its usage is read.
    OauthToken(String, OverrideFrom),
}

/// Usage read with `CLAUDE_CODE_OAUTH_TOKEN`, which Claude Code uses instead
/// of the saved login. Never renewed or saved; a token the usage service
/// rejects is reported as not a login PandaCode can read usage for.
async fn oauth_token_usage(remote: &dyn Remote, mut token: String, from: OverrideFrom) -> Usage {
    let answer = remote.usage(token.clone()).await;
    wipe(&mut token);
    match answer {
        Ok(mut value) => {
            let mut usage = claude_usage(&value, None);
            wipe_value(&mut value);
            usage.source = Some(format!("Claude Code OAuth token ({OAUTH_TOKEN_VARIABLE})"));
            usage
        }
        Err(UsageFailure { error: FetchError::Http(401 | 403), .. }) => api_connection(OAUTH_TOKEN_VARIABLE, from),
        Err(failure) => failure.error.into_usage("claude"),
    }
}

/// The card for a Claude connection that is not the subscription login: the
/// setting or variable by name (never its value), and how to switch back.
pub(super) fn api_connection(name: &str, from: OverrideFrom) -> Usage {
    let message = match from {
        OverrideFrom::Environment => format!(
            "Claude is launched with {name} set, so it does not use your subscription and its limits don't apply. To use your saved Claude login, turn on Settings → Providers → Claude Code → Prefer saved Claude login."
        ),
        OverrideFrom::Settings => format!(
            "Claude's settings.json sets {name}, so Claude does not use your subscription and its limits don't apply. Remove it there to use your saved Claude login (Prefer saved Claude login does not override settings.json)."
        ),
        OverrideFrom::Managed => format!(
            "Your administrator's Claude Code settings (managed-settings.json) set {name}, so Claude does not use your subscription and its limits don't apply. Ask your administrator to change it to use your saved Claude login."
        ),
        OverrideFrom::Connection => format!(
            "This connection sets {name}, so Claude does not use your subscription with it and its limits don't apply. Remove {name} from the connection to use your saved Claude login."
        ),
    };
    let mut usage = Usage::empty("claude", "unavailable", &message);
    usage.action = Some("apiConnection");
    usage
}

/// A manual refresh tries a backing-off, prompted or denied Keychain item once more.
fn retry_keychain(stores: &[Store], refresh: bool) {
    #[cfg(target_os = "macos")]
    for store in stores.iter().filter(|_| refresh) {
        if let Store::Keychain(service) = store {
            crate::usage_keychain::clear_backoff(service);
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (stores, refresh);
}

/// A stable name for where a setup's login lives: each store's kind and its
/// service or path. (Saved readings keyed by the older, `Debug`-formatted
/// name are not found once; the next good reading is saved under this one.)
pub(super) fn identity(stores: &[Store]) -> String {
    let named: Vec<String> = stores
        .iter()
        .map(|store| match store {
            Store::Keychain(service) => format!("keychain:{service}"),
            Store::File(path) => format!("file:{}", path.display()),
        })
        .collect();
    named.join("\n")
}

/// Where this profile's last reading is kept, and for which account.
async fn profile_for(config: &Path, env: &ClaudeEnv, stores: &[Store]) -> Profile {
    let file = claude_json(config, env);
    let identity = identity(stores);
    let dir = crate::secret_store::dir().map(Path::to_path_buf);
    tokio::task::spawn_blocking(move || Profile::new(&identity, file.as_deref().and_then(account_in), dir))
        .await
        .unwrap_or_else(|_| Profile::new("", None, None))
}

/// Whose reading a check of `env` would give now: its profile and the account
/// `.claude.json` names. `agent_usage` never serves a cached reading of
/// another owner (an account switch or sign-out since).
pub(crate) async fn owner_now(env: &ClaudeEnv) -> Option<(String, Option<String>)> {
    let config = env.config_dir()?;
    let stores = stores(&config, env);
    let profile = profile_for(&config, env, &stores).await;
    Some((profile.key, profile.account))
}

/// Reads of each `.claude.json` (tests).
#[cfg(test)]
pub(super) fn account_reads() -> std::sync::MutexGuard<'static, HashMap<PathBuf, usize>> {
    static READS: OnceLock<std::sync::Mutex<HashMap<PathBuf, usize>>> = OnceLock::new();
    READS.get_or_init(Default::default).lock().unwrap_or_else(PoisonError::into_inner)
}

const NO_CONFIG: &str = "Claude's configuration directory could not be determined. Use an absolute CLAUDE_CONFIG_DIR path.";

/// Whose reading a check gives (`owner_now`): its profile key and account.
pub(crate) type Owner = (String, Option<String>);

/// `refresh` is a manual refresh. Whether Claude Code may be run to refresh an
/// expired login comes from Settings (`provider_settings::claude_cli_refresh`).
/// `owner`, when the caller has just worked it out (`owner_now`), spares a
/// second read of `.claude.json`.
pub(crate) async fn fetch_claude(env: &ClaudeEnv, refresh: bool, owner: Option<Owner>) -> Usage {
    match http_client() {
        Ok(client) => fetch_claude_owned(env, refresh, Arc::new(Http(client)), owner).await,
        Err(error) => error.into_usage("claude"),
    }
}

/// `fetch_claude` with the Claude services given (tests use an offline one).
#[cfg(test)]
pub(super) async fn fetch_claude_with(env: &ClaudeEnv, refresh: bool, remote: Arc<dyn Remote>) -> Usage {
    fetch_claude_owned(env, refresh, remote, None).await
}

pub(super) async fn fetch_claude_owned(env: &ClaudeEnv, refresh: bool, remote: Arc<dyn Remote>, owner: Option<Owner>) -> Usage {
    // A manual refresh may wait for a Keychain dialog to be answered.
    let deadline = if refresh { MANUAL_DEADLINE } else { DEADLINE };
    fetch_within(env, refresh, remote, deadline, owner).await
}

/// The whole check within `deadline` (tests).
#[cfg(test)]
pub(super) async fn fetch_claude_within(env: &ClaudeEnv, refresh: bool, remote: Arc<dyn Remote>, deadline: Duration) -> Usage {
    fetch_within(env, refresh, remote, deadline, None).await
}

/// The whole check within `deadline`, setup included (settings, the account
/// hint), so the outer bound never cuts it short with a generic timeout; a
/// setup that uses it all up answers like any timeout, with the saved reading.
async fn fetch_within(env: &ClaudeEnv, refresh: bool, remote: Arc<dyn Remote>, deadline: Duration, owner: Option<Owner>) -> Usage {
    let started = Instant::now();
    let Ok(prepared) = tokio::time::timeout(deadline, prepare(env, refresh, remote, owner)).await else {
        return late(env).await;
    };
    match prepared {
        Prepared::Done(result) => result,
        Prepared::Check(stores, mut check) => {
            check.deadline = deadline.saturating_sub(started.elapsed());
            usage_with_login(&stores, &check).await
        }
    }
}

/// A check ready to run, or its answer already (not a subscription).
enum Prepared {
    Done(Usage),
    Check(Vec<Store>, Check),
}

async fn prepare(env: &ClaudeEnv, refresh: bool, remote: Arc<dyn Remote>, owner: Option<Owner>) -> Prepared {
    let Some(config) = env.config_dir() else {
        return Prepared::Done(Usage::empty("claude", "unavailable", NO_CONFIG));
    };
    match not_a_subscription(&config, env).await {
        Some(Connection::Other(result)) => return Prepared::Done(*result),
        Some(Connection::OauthToken(token, from)) => return Prepared::Done(oauth_token_usage(remote.as_ref(), token, from).await),
        None => {}
    }
    let stores = stores(&config, env);
    // A manual refresh lifts the Keychain backoff and latch before reading.
    retry_keychain(&stores, refresh);
    let check = Check {
        remote,
        profile: match owner {
            Some((key, account)) => Profile { key, account, dir: crate::secret_store::dir().map(Path::to_path_buf) },
            None => profile_for(&config, env, &stores).await,
        },
        refresh,
        cli: cli_for(env),
        deadline: Duration::ZERO,
        ends: None,
        account_file: claude_json(&config, env),
        refresh_lock: Some(config.join(run::REFRESH_LOCK)),
    };
    Prepared::Check(stores, check)
}

/// How a check of `env` may run Claude Code. In tests, a scripted CLI given
/// to `test_cli` for the check's `CLAUDE_CONFIG_DIR`, else none (the real
/// CLI runs only in the ignored live test, which builds its own).
fn cli_for(env: &ClaudeEnv) -> cli::Cli {
    #[cfg(test)]
    {
        let key = env.get("CLAUDE_CONFIG_DIR").unwrap_or_default();
        test_clis().get(&key).cloned().unwrap_or(cli::Cli::Missing)
    }
    #[cfg(not(test))]
    cli::Cli::for_env(env)
}

/// Scripted CLIs by `CLAUDE_CONFIG_DIR` (tests run in parallel, each with its own folder).
#[cfg(test)]
fn test_clis() -> std::sync::MutexGuard<'static, HashMap<String, cli::Cli>> {
    static CLIS: OnceLock<std::sync::Mutex<HashMap<String, cli::Cli>>> = OnceLock::new();
    CLIS.get_or_init(Default::default).lock().unwrap_or_else(PoisonError::into_inner)
}

/// Gives checks of the config folder `dir` this CLI (tests).
#[cfg(test)]
pub(super) fn test_cli(dir: &str, cli: cli::Cli) {
    test_clis().insert(dir.to_owned(), cli);
}

/// What a Claude check shows when `agent_usage::bounded`'s outer deadline
/// fires: the saved reading, never a blank card.
pub(crate) async fn late(env: &ClaudeEnv) -> Usage {
    let Some(config) = env.config_dir() else {
        return Usage::empty("claude", "unavailable", NO_CONFIG);
    };
    let stores = stores(&config, env);
    let answer = async { timed_out(&profile_for(&config, env, &stores).await).await };
    tokio::time::timeout(LATE_LIMIT, answer)
        .await
        .unwrap_or_else(|_| *usage(TIMED_OUT))
}
