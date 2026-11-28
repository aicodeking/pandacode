//! Environment and local paths shared by account identity and usage readers.

use std::ffi::OsString;
use std::path::PathBuf;

pub(crate) fn environment(
    provider: &str,
    connection: &[(String, String)],
) -> Vec<(String, String)> {
    let mut env = crate::provider_settings::environment(provider);
    // Subscription mode strips inherited credentials before a connection is applied.
    if provider == "claude" {
        env.extend(
            crate::providers::claude_auth::removed_environment(provider)
                .iter()
                .map(|name| ((*name).into(), String::new())),
        );
    }
    env.extend_from_slice(connection);
    env
}

/// Windows environment names are case-insensitive (`UserProfile` is `USERPROFILE`).
fn env_matches(key: &str, name: &str, ignore_case: bool) -> bool {
    if ignore_case {
        key.eq_ignore_ascii_case(name)
    } else {
        key == name
    }
}

/// The last value `env` gives `name` (later entries override earlier ones), if any.
pub(crate) fn last_value<'a>(
    env: &'a [(String, String)],
    name: &str,
    ignore_case: bool,
) -> Option<&'a str> {
    env.iter()
        .rev()
        .find(|(key, _)| env_matches(key, name, ignore_case))
        .map(|(_, value)| value.as_str())
}

pub(crate) fn var(env: &[(String, String)], name: &str) -> Option<String> {
    var_with(env, name, cfg!(windows))
}

pub(crate) fn var_with(env: &[(String, String)], name: &str, ignore_case: bool) -> Option<String> {
    last_value(env, name, ignore_case)
        .map(str::to_owned)
        .or_else(|| std::env::var(name).ok())
}

pub(crate) fn home(env: &[(String, String)]) -> Option<PathBuf> {
    home_with(env, cfg!(windows))
}

/// `home` with explicit name matching: `ignore_case` is `cfg!(windows)` for a real launch.
pub(crate) fn home_with(env: &[(String, String)], ignore_case: bool) -> Option<PathBuf> {
    home_in(env, ignore_case, process_var)
}

fn process_var(name: &str) -> Option<OsString> {
    std::env::var_os(name)
}

/// `process` stands in for PandaCode's own environment, so tests never read the real one.
fn home_in(
    env: &[(String, String)],
    ignore_case: bool,
    process: impl Fn(&str) -> Option<OsString>,
) -> Option<PathBuf> {
    let names = if cfg!(windows) {
        ["USERPROFILE", "HOME"]
    } else {
        ["HOME", "USERPROFILE"]
    };
    names.into_iter().find_map(|name| {
        last_value(env, name, ignore_case)
            .map(PathBuf::from)
            .or_else(|| process(name).map(PathBuf::from))
            .filter(|path| path.is_absolute())
    })
}

pub(crate) fn config_dir(provider: &str, env: &[(String, String)]) -> Option<PathBuf> {
    let (name, default) = match provider {
        "claude" => ("CLAUDE_CONFIG_DIR", ".claude"),
        "codex" => ("CODEX_HOME", ".codex"),
        _ => return None,
    };
    match var(env, name).filter(|value| !value.is_empty()) {
        Some(value) => {
            let path = PathBuf::from(value);
            path.is_absolute().then_some(path)
        }
        None => home(env).map(|home| home.join(default)),
    }
}

pub(crate) fn claude_legacy(env: &[(String, String)]) -> Option<PathBuf> {
    if var(env, "CLAUDE_CONFIG_DIR").is_some_and(|value| !value.is_empty()) {
        config_dir("claude", env).map(|dir| dir.join(".claude.json"))
    } else {
        home(env).map(|home| home.join(".claude.json"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn last_value_wins_and_empty_config_uses_effective_home() {
        let root = std::env::temp_dir().join("pandacode-synthetic-home");
        let own = vec![
            ("HOME".into(), root.to_string_lossy().into_owned()),
            ("USERPROFILE".into(), root.to_string_lossy().into_owned()),
            ("CODEX_HOME".into(), "relative-old-value".into()),
            ("CODEX_HOME".into(), String::new()),
            ("CLAUDE_CONFIG_DIR".into(), String::new()),
        ];
        let env = environment("codex", &own);
        assert_eq!(var(&env, "CODEX_HOME").as_deref(), Some(""));
        assert_eq!(config_dir("codex", &env), Some(root.join(".codex")));
        assert_eq!(config_dir("claude", &env), Some(root.join(".claude")));
        assert_eq!(claude_legacy(&env), Some(root.join(".claude.json")));
        let mut env = env;
        let named = root.join("named");
        env.push((
            "CLAUDE_CONFIG_DIR".into(),
            named.to_string_lossy().into_owned(),
        ));
        assert_eq!(config_dir("claude", &env), Some(named.clone()));
        assert_eq!(claude_legacy(&env), Some(named.join(".claude.json")));
        env.push(("CLAUDE_CONFIG_DIR".into(), "relative".into()));
        assert_eq!(config_dir("claude", &env), None);
        assert_eq!(claude_legacy(&env), None);
    }

    #[test]
    fn home_and_var_names_match_case_insensitively_only_when_asked() {
        let root = std::env::temp_dir().join("pandacode-synthetic-case-home");
        let value = root.to_string_lossy().into_owned();
        for name in ["UserProfile", "Home", "userprofile", "home"] {
            let env = vec![(name.to_owned(), value.clone())];
            assert_eq!(home_in(&env, true, |_| None), Some(root.clone()), "{name}");
            assert_eq!(home_in(&env, false, |_| None), None, "{name}");
        }
        // An explicit, exactly spelled HOME outranks the process environment either way.
        let other = std::env::temp_dir().join("pandacode-synthetic-other-home");
        let env = vec![
            ("HOME".to_owned(), other.to_string_lossy().into_owned()),
            ("USERPROFILE".to_owned(), other.to_string_lossy().into_owned()),
            ("Home".to_owned(), value.clone()),
            ("UserProfile".to_owned(), value.clone()),
        ];
        assert_eq!(home_with(&env, true), Some(root.clone()), "the last spelling wins");
        assert_eq!(home_with(&env, false), Some(other));
        let env = vec![("claude_config_dir".to_owned(), value.clone())];
        assert_eq!(last_value(&env, "CLAUDE_CONFIG_DIR", true), Some(value.as_str()));
        assert_eq!(last_value(&env, "CLAUDE_CONFIG_DIR", false), None);
        assert_eq!(var_with(&env, "CLAUDE_CONFIG_DIR", true), Some(value));
    }
}
