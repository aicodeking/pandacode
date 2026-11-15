//! What a handshake spare is keyed by: its command line, environment and folder, and the state
//! of the harness's own config and login files, so an edited config or another account's
//! login starts the next send afresh. Holds environment values and file contents only in
//! memory: never log a key.
use super::*;

/// Everything the process starts with, and the state of the harness's own config and login
/// files. Holds environment values (a connection's keys among them) only in memory: never log
/// it.
pub(in crate::providers) fn key(provider: &str, command: &Command, cwd: &Path) -> String {
    shape(command).key(provider, cwd)
}

/// A launch's program, arguments and environment, owned, so its key (which reads files) can be
/// computed off the runtime.
pub(in crate::providers) struct Shape {
    program: std::ffi::OsString,
    args: Vec<std::ffi::OsString>,
    envs: Vec<(std::ffi::OsString, Option<std::ffi::OsString>)>,
}

pub(in crate::providers) fn shape(command: &Command) -> Shape {
    let command = command.as_std();
    let mut envs: Vec<_> = command.get_envs().map(|(name, value)| (name.to_owned(), value.map(ToOwned::to_owned))).collect();
    envs.sort();
    Shape { program: command.get_program().to_owned(), args: command.get_args().map(ToOwned::to_owned).collect(), envs }
}

impl Shape {
    pub(in crate::providers) fn key(&self, provider: &str, cwd: &Path) -> String {
        let files = fingerprint(provider, &config_files(provider, self, cwd));
        format!("{:?}", (&self.program, &self.args, &self.envs, cwd, files))
    }

    fn variable(&self, name: &str) -> Option<std::ffi::OsString> {
        self.envs.iter().find(|(key, _)| key == name).and_then(|(_, value)| value.clone())
    }
}

/// The config and login files each harness reads at startup, as far as PandaCode knows them:
/// an edited config or a new login means the next send must start the harness afresh.
fn config_files(provider: &str, launch: &Shape, cwd: &Path) -> Vec<PathBuf> {
    // The launch's own value first (a connection may set it), then PandaCode's environment.
    let variable = |name: &str| launch.variable(name).or_else(|| std::env::var_os(name)).filter(|value| !value.is_empty()).map(PathBuf::from);
    let home = crate::agent_usage_providers::home();
    let under = |dir: Option<PathBuf>, names: &[&str]| dir.map(|dir| names.iter().map(|name| dir.join(name)).collect::<Vec<_>>()).unwrap_or_default();
    match provider {
        "codex" => {
            let dir = variable("CODEX_HOME").or_else(|| home.as_ref().map(|home| home.join(".codex")));
            [under(dir, &["config.toml", "auth.json"]), vec![cwd.join(".codex/config.toml")]].concat()
        }
        "kimi" => {
            let files = ["config.toml", "config.json", "credentials/kimi-code.json"];
            [
                under(home.as_ref().map(|home| home.join(".kimi-code")), &files),
                under(home.as_ref().map(|home| home.join(".kimi")), &files),
                vec![cwd.join(".kimi/config.toml"), cwd.join(".kimi-code/config.toml")],
            ]
            .concat()
        }
        "opencode" => {
            let config = variable("XDG_CONFIG_HOME").or_else(|| home.as_ref().map(|home| home.join(".config")));
            let data = variable("XDG_DATA_HOME").or_else(|| home.as_ref().map(|home| home.join(".local/share")));
            [
                under(config.map(|dir| dir.join("opencode")), &["opencode.json", "opencode.jsonc", "config.json"]),
                under(home.as_ref().map(|home| home.join(".opencode")), &["opencode.json"]),
                // OpenCode 2.x keeps logins in opencode.db, which changes with every session:
                // only the older auth.json is watched.
                under(data.map(|dir| dir.join("opencode")), &["auth.json"]),
                vec![cwd.join("opencode.json"), cwd.join("opencode.jsonc")],
            ]
            .concat()
        }
        "hermes" => under(home.map(|home| home.join(".hermes")), &["config.yaml", ".env", "auth.json"]),
        "grok" => under(home.map(|home| home.join(".grok")), &["config.toml", "auth.json"]),
        "commandcode" => under(home.map(|home| home.join(".commandcode")), &["config.json", "settings.json", "auth.json"]),
        "kilo" => {
            let config = variable("XDG_CONFIG_HOME").or_else(|| home.as_ref().map(|home| home.join(".config")));
            let data = variable("XDG_DATA_HOME").or_else(|| home.as_ref().map(|home| home.join(".local/share")));
            [under(config.map(|dir| dir.join("kilo")), &["config.json"]), under(data.map(|dir| dir.join("kilo")), &["auth.json"])].concat()
        }
        // GitHub Copilot keeps its tokens in the system keychain; its config lists who is signed in.
        "github-copilot" => under(home.map(|home| home.join(".copilot")), &["config.json"]),
        "devin" => [
            under(home.as_ref().map(|home| home.join(".config/devin")), &["config.json"]),
            under(home.map(|home| home.join(".local/share/devin")), &["credentials.toml"]),
        ]
        .concat(),
        // DeepSeek's key reaches it through the environment, which the key already holds.
        _ => Vec::new(),
    }
}

/// Each file's modification time and size (or that it is missing): a few `stat` calls. Codex
/// rewrites `auth.json` on every token refresh, so that file counts only by the account it
/// signs in (`account`).
fn fingerprint(provider: &str, files: &[PathBuf]) -> Vec<(PathBuf, String)> {
    let stat = |file: &Path| match std::fs::metadata(file).ok().and_then(|meta| Some((meta.modified().ok()?, meta.len()))) {
        Some((modified, len)) => format!("{modified:?}/{len}"),
        None => "missing".into(),
    };
    files
        .iter()
        .map(|file| {
            let account = (file.file_name().is_some_and(|name| name == "auth.json"))
                .then(|| std::fs::read(file).ok().and_then(|bytes| account(provider, &bytes)))
                .flatten();
            (file.clone(), account.unwrap_or_else(|| stat(file)))
        })
        .collect()
}

/// A hash of who an `auth.json` signs in, for the harnesses that rewrite it on every token
/// refresh: account ids, auth modes and API keys, never refreshable tokens. `None` when it
/// cannot be read as JSON or the harness's file is not known to be refreshed in place.
fn account(provider: &str, bytes: &[u8]) -> Option<String> {
    use std::hash::{Hash, Hasher};
    let auth: Value = serde_json::from_slice(bytes).ok()?;
    let entries = |fields: &[&str]| -> Vec<(String, Vec<Option<String>>)> {
        auth.as_object()
            .into_iter()
            .flatten()
            .map(|(name, entry)| (name.clone(), fields.iter().map(|field| entry[*field].as_str().map(str::to_owned)).collect()))
            .collect()
    };
    let identity = match provider {
        "codex" => json!([auth["auth_mode"], auth["tokens"]["account_id"], auth["OPENAI_API_KEY"]]),
        // One entry per signed-in account; `key` and `refresh_token` change on refresh.
        "grok" => json!(entries(&["user_id", "auth_mode", "team_id", "principal_id"])),
        "commandcode" => json!([auth["userId"], auth["keyName"], auth["apiKey"]]),
        // Per provider: an API key (`key`), or an OAuth login known by its account id (its
        // `access`/`refresh` change on refresh). An OAuth login without one counts the whole
        // file by size and time instead, so another login still changes the key.
        "kilo" => {
            let oauth_id = |entry: &Value| ["accountId", "account_id", "userId", "user_id", "email"].iter().find_map(|field| entry[*field].as_str().map(str::to_owned));
            let logins = auth.as_object()?.values().filter(|entry| entry["type"] == "oauth");
            if logins.clone().any(|entry| oauth_id(entry).is_none()) {
                return None;
            }
            json!(auth.as_object()?.iter().map(|(name, entry)| (name, &entry["type"], &entry["key"], oauth_id(entry))).collect::<Vec<_>>())
        }
        _ => return None,
    };
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    identity.to_string().hash(&mut hasher);
    Some(format!("account:{:x}", hasher.finish()))
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_codex_spare_is_keyed_by_its_whole_launch() {
        let base = || {
            let mut command = Command::new("/bin/codex");
            command.args(["app-server", "--enable", "goals"]).env("CODEX_HOME", "/a");
            command
        };
        let key_of = |command: &Command, cwd: &str| key("codex", command, Path::new(cwd));
        let original = key_of(&base(), "/work");
        assert_eq!(original, key_of(&base(), "/work"));
        let mut extra = base();
        extra.args(["-c", "x=1"]);
        let mut home = base();
        home.env("CODEX_HOME", "/b");
        for different in [key_of(&base(), "/elsewhere"), key_of(&extra, "/work"), key_of(&home, "/work"), key_of(&Command::new("/other/codex"), "/work")] {
            assert_ne!(different, original);
        }
    }

    #[test]
    fn an_edited_config_or_a_new_login_changes_the_spare_key() {
        let dir = std::env::temp_dir().join(format!("codex-warm-files-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("home")).unwrap();
        let mut command = Command::new("/bin/codex");
        command.arg("app-server").env("CODEX_HOME", dir.join("home"));
        let key_now = || key("codex", &command, &dir);
        let none = key_now();
        let auth = |account: &str, access: &str| {
            let file = json!({"auth_mode": "chatgpt", "tokens": {"account_id": account, "access_token": access, "refresh_token": access}, "last_refresh": access});
            std::fs::write(dir.join("home/auth.json"), file.to_string()).unwrap();
        };
        auth("account-a", "token-1");
        let login = key_now();
        assert_ne!(login, none, "a login appeared");
        // A token refresh rewrites the file for the same account: the spare stays.
        auth("account-a", "token-2-refreshed-and-longer");
        assert_eq!(key_now(), login, "a refresh keeps the spare");
        // Signing in to another account does not.
        auth("account-b", "token-2-refreshed-and-longer");
        assert_ne!(key_now(), login, "another account starts afresh");
        auth("account-a", "token-3");
        std::fs::write(dir.join("home/config.toml"), "model = \"a\"").unwrap();
        let configured = key_now();
        assert_ne!(configured, login, "the config appeared");
        std::fs::write(dir.join("home/config.toml"), "model = \"other\"").unwrap();
        assert_ne!(key_now(), configured, "the config was edited");
        assert_eq!(key_now(), key_now(), "unchanged files keep the key");
        assert_eq!(
            config_files("kimi", &shape(&command), &dir).iter().filter(|file| file.ends_with("credentials/kimi-code.json")).count(),
            2,
            "both Kimi homes' logins are watched"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_token_refresh_keeps_the_key_but_another_account_does_not() {
        let hash = |provider: &str, auth: Value| account(provider, auth.to_string().as_bytes()).unwrap();
        let grok = |user: &str, token: &str| json!({"https://auth.x.ai::a": {"user_id": user, "auth_mode": "oauth", "team_id": "t", "principal_id": "p", "key": token, "refresh_token": token, "expires_at": token}});
        assert_eq!(hash("grok", grok("u1", "old")), hash("grok", grok("u1", "refreshed")));
        assert_ne!(hash("grok", grok("u1", "old")), hash("grok", grok("u2", "old")));
        let kilo = |key: &str, account: &str, access: &str| json!({"openrouter": {"type": "api", "key": key}, "kilo": {"type": "oauth", "accountId": account, "access": access, "refresh": access, "expires": 1}});
        assert_eq!(hash("kilo", kilo("k1", "a1", "old")), hash("kilo", kilo("k1", "a1", "refreshed")));
        assert_ne!(hash("kilo", kilo("k1", "a1", "old")), hash("kilo", kilo("k2", "a1", "old")), "a new API key");
        assert_ne!(hash("kilo", kilo("k1", "a1", "old")), hash("kilo", kilo("k1", "a2", "old")), "another OAuth login");
        // An OAuth login with no account id: the file counts by size and time.
        let anonymous = json!({"kilo": {"type": "oauth", "access": "t", "refresh": "t", "expires": 1}});
        assert!(account("kilo", anonymous.to_string().as_bytes()).is_none());
        let commandcode = |key: &str| json!({"apiKey": key, "userId": "u", "userName": "n", "keyName": "k", "authenticatedAt": "now"});
        assert_ne!(hash("commandcode", commandcode("a")), hash("commandcode", commandcode("b")));
        assert!(account("devin", b"{}").is_none(), "other harnesses' files count by size and time");
        for (provider, file) in [("grok", ".grok/auth.json"), ("commandcode", ".commandcode/auth.json"), ("kilo", "kilo/auth.json"), ("github-copilot", ".copilot/config.json"), ("devin", "devin/credentials.toml")] {
            let files = config_files(provider, &shape(&Command::new("/bin/agent")), Path::new("/work"));
            assert!(files.iter().any(|path| path.ends_with(file)), "{provider}: {files:?}");
        }
    }
}
