//! Environment and local paths shared by account identity and usage readers.

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

pub(crate) fn var(env: &[(String, String)], name: &str) -> Option<String> {
    env.iter()
        .rev()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.clone())
        .or_else(|| std::env::var(name).ok())
}

pub(crate) fn home(env: &[(String, String)]) -> Option<PathBuf> {
    let names = if cfg!(windows) {
        ["USERPROFILE", "HOME"]
    } else {
        ["HOME", "USERPROFILE"]
    };
    names.into_iter().find_map(|name| {
        env.iter()
            .rev()
            .find(|(key, _)| key == name)
            .map(|(_, value)| PathBuf::from(value))
            .or_else(|| std::env::var_os(name).map(PathBuf::from))
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
}
