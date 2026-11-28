//! OpenCode launch configuration after connection overrides: skill denies, the effective
//! discovery environment and served-tool grants (moved from `providers.rs`).
use std::collections::HashSet;

use tokio::process::Command;

use super::{acp, opencode_allowed, RunConfig};

/// Rescans after provider and connection overrides, using the same launch paths as tool grants.
/// Call off the async runtime: the agent scan reads configuration and Markdown files.
pub(super) fn enforce_opencode_after_connection_with_env(
    command: &mut Command,
    config: &mut RunConfig,
    disabled: &std::collections::BTreeSet<String>,
) {
    let env = opencode_environment(command);
    let agents = crate::skill_manager::opencode_agents_at_with_env(disabled, &config.cwd, &env);
    if !agents.complete && !disabled.is_empty() {
        // The initial scan may already have added this reminder; it is deduplicated.
        crate::skill_manager::remind_unenforced(config, disabled);
    }
    enforce_opencode_after_connection(command, config, disabled, &agents);
}

/// Apply the selected mode and skill denies after the connection's inline configuration.
/// The denies also always go through `OPENCODE_PERMISSION` (kept rules, merged last by OpenCode).
/// Text that can't be read stays untouched and the launch also asks, as for names OpenCode can't deny.
pub(super) fn enforce_opencode_after_connection(
    command: &mut Command,
    config: &mut RunConfig,
    disabled: &std::collections::BTreeSet<String>,
    agents: &crate::skill_manager::OpenCodeAgents,
) {
    let inline = command_environment(command, "OPENCODE_CONFIG_CONTENT").unwrap_or_else(|| "{}".into());
    let permission = command_environment(command, "OPENCODE_PERMISSION");
    let launch = crate::skill_manager::opencode_launch_with(
        &inline,
        permission.as_deref(),
        disabled,
        agents,
    );
    let content = if launch.enforced {
        acp::configuration(&config.mode, Some(&inline), disabled, agents)
    } else {
        launch.content
    };
    command.env("OPENCODE_CONFIG_CONTENT", content);
    if let Some(permission) = launch.permission {
        command.env("OPENCODE_PERMISSION", permission);
    }
    if !launch.enforced {
        crate::skill_manager::remind_unenforced(config, disabled);
    }
}

pub(super) fn command_environment(command: &Command, name: &str) -> Option<String> {
    command
        .as_std()
        .get_envs()
        .find(|(key, _)| *key == name)
        .map(|(_, value)| value.and_then(|value| value.to_str()).map(str::to_owned))
        .unwrap_or_else(|| std::env::var(name).ok())
}

/// Effective OpenCode discovery paths after saved provider and named-connection overrides.
pub(super) fn opencode_environment(command: &Command) -> crate::skill_manager::OpenCodeEnv {
    opencode_environment_with(command, |name| std::env::var_os(name))
}

fn opencode_environment_with(
    command: &Command,
    inherited: impl Fn(&str) -> Option<std::ffi::OsString>,
) -> crate::skill_manager::OpenCodeEnv {
    crate::skill_manager::OpenCodeEnv::from_environment(|name| {
        command
            .as_std()
            .get_envs()
            .find(|(key, _)| *key == name)
            .map(|(_, value)| value.map(std::ffi::OsStr::to_os_string))
            .unwrap_or_else(|| inherited(name))
    })
}

pub(super) fn allow_opencode_tools(
    command: &mut Command,
    config: &RunConfig,
    bound: bool,
    names: &HashSet<String>,
    agents: Option<&crate::skill_manager::OpenCodeAgents>,
) {
    let served = opencode_allowed(&config.provider, bound, names);
    if served.is_empty() {
        return;
    }
    match agents {
        Some(agents) => acp::allow_tools_with_agents(command, &served, agents),
        None if !config.cwd.as_os_str().is_empty() => {
            let env = opencode_environment(command);
            let agents = crate::skill_manager::opencode_all_agents_with_env(Some(&config.cwd), &env);
            acp::allow_tools_with_agents(command, &served, &agents);
        }
        None => acp::allow_tools(command, &served),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::tests::{config, env_of};
    use crate::providers::{configure_command, configure_command_with_skills, EXPLORE_TOOL};
    use serde_json::{json, Value};
    use std::path::PathBuf;

    #[test]
    fn opencode_connection_config_agents_keep_skill_denies_after_tool_grants() {
        let root = std::env::temp_dir().join(format!(
            "pandacode-opencode-connection-skill-denies-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(root.join(".git")).unwrap();
        let file = root.join("launch.json");
        std::fs::write(
            &file,
            r#"{"agent":{"external-reviewer":{"permission":{"skill":{"review":"allow"}}}}}"#,
        )
        .unwrap();
        let mut cfg = config("opencode");
        cfg.cwd = root.clone();
        let disabled = std::collections::BTreeSet::from(["review".into()]);
        // Both absolute and cwd-relative connection paths use the launch environment.
        for path in [file, PathBuf::from("launch.json")] {
            let mut command = Command::new("opencode");
            configure_command_with_skills(&mut command, &cfg, &disabled);
            command.env("OPENCODE_CONFIG", path);
            enforce_opencode_after_connection_with_env(&mut command, &mut cfg, &disabled);
            let value: Value =
                serde_json::from_str(&env_of(&command, "OPENCODE_CONFIG_CONTENT")).unwrap();
            assert_eq!(value["permission"]["skill"]["review"], "deny");
            assert_eq!(
                value["agent"]["external-reviewer"]["permission"]["skill"]["review"],
                "deny"
            );
            let permission: Value =
                serde_json::from_str(&env_of(&command, "OPENCODE_PERMISSION")).unwrap();
            assert_eq!(permission["skill"]["review"], "deny");

            allow_opencode_tools(
                &mut command,
                &cfg,
                true,
                &HashSet::from([EXPLORE_TOOL.into()]),
                None,
            );
            let value: Value =
                serde_json::from_str(&env_of(&command, "OPENCODE_CONFIG_CONTENT")).unwrap();
            assert_eq!(value["permission"]["skill"]["review"], "deny");
            let agent = &value["agent"]["external-reviewer"]["permission"];
            assert_eq!(agent["skill"]["review"], "deny");
            assert_eq!(agent["pandacode_architect_pandacode_explore"], "allow");
            assert_eq!(agent["pandacode_architect_pandacode_explore *"], "allow");
            let permission: Value =
                serde_json::from_str(&env_of(&command, "OPENCODE_PERMISSION")).unwrap();
            assert_eq!(permission["skill"]["review"], "deny");
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn opencode_connection_incomplete_agents_add_one_skill_reminder() {
        let root = std::env::temp_dir().join(format!(
            "pandacode-opencode-connection-incomplete-agents-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(root.join(".git")).unwrap();
        let file = root.join("launch.json");
        // An unusable agent name makes this connection's roster incomplete.
        std::fs::write(&file, r#"{"agent":{"":{"permission":{"skill":"allow"}}}}"#).unwrap();
        let mut cfg = config("opencode");
        cfg.cwd = root.clone();
        let disabled = std::collections::BTreeSet::from(["review".into()]);
        let mut command = Command::new("opencode");
        command.env("OPENCODE_CONFIG", file);
        command.env("OPENCODE_CONFIG_CONTENT", "{}");
        for _ in 0..2 {
            enforce_opencode_after_connection_with_env(&mut command, &mut cfg, &disabled);
            assert_eq!(
                format!("{}{}", cfg.prompt, cfg.instructions)
                    .matches("Do not use these skills in this session: review.")
                    .count(),
                1
            );
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn opencode_served_tools_preserve_connection_config_and_skill_denies() {
        let mut cfg = config("opencode");
        cfg.mode = "plan".into();
        let disabled = std::collections::BTreeSet::from(["review".into()]);
        let mut command = Command::new("opencode");
        configure_command_with_skills(&mut command, &cfg, &disabled);
        crate::connections::Launch {
            executable: None,
            args: Vec::new(),
            env: vec![("OPENCODE_CONFIG_CONTENT".into(), r#"{"provider":{"work":{"name":"Named provider"}},"mcp":{"work":{"url":"https://example.invalid/mcp"}},"permission":{"bash":{"deploy *":"deny","*":"ask"},"skill":{"*":"allow"}},"agent":{"plan":{"model":"work/model","permission":{"bash":"deny","skill":{"*":"allow"}}},"reviewer":{"prompt":"Keep this agent","permission":{"edit":"deny"}}}}"#.into())],
            secrets: Vec::new(),
        }.apply(&mut command);
        command.env("OPENCODE_PERMISSION", r#"{"bash":{"deploy *":"deny","*":"ask"}}"#);
        enforce_opencode_after_connection(&mut command, &mut cfg, &disabled, &Default::default());
        let before = env_of(&command, "OPENCODE_CONFIG_CONTENT");
        let names = HashSet::from([EXPLORE_TOOL.into(), crate::custom_tools::TOOL_RUN.into()]);
        allow_opencode_tools(&mut command, &cfg, true, &names, None);
        let after = env_of(&command, "OPENCODE_CONFIG_CONTENT");
        let value: Value = serde_json::from_str(&after).unwrap();
        assert_eq!(value["provider"]["work"]["name"], "Named provider");
        assert_eq!(value["mcp"]["work"]["url"], "https://example.invalid/mcp");
        assert_eq!(value["agent"]["plan"]["model"], "work/model");
        assert_eq!(value["agent"]["reviewer"]["prompt"], "Keep this agent");
        assert_eq!(value["permission"]["skill"]["review"], "deny");
        assert_eq!(value["agent"]["plan"]["permission"]["skill"]["review"], "deny");
        assert_eq!(value["agent"]["plan"]["permission"]["*"], "deny");
        assert!(value["permission"].get("bash").is_none(), "{after}");
        assert_eq!(value["permission"]["pandacode_architect_pandacode_explore"], "allow");
        assert_eq!(value["agent"]["plan"]["permission"]["pandacode_architect_pandacode_explore"], "allow");
        assert!(value["permission"].get("pandacode_architect_pandacode_tool_run").is_none());
        let permission = env_of(&command, "OPENCODE_PERMISSION");
        assert!(permission.contains(r#""bash":{"deploy *":"deny","*":"ask"}"#));
        assert!(permission.contains(r#""review":"deny""#));
        let permission: Value = serde_json::from_str(&permission).unwrap();
        assert_eq!(permission["pandacode_architect_pandacode_explore"], "allow");
        assert!(permission.get("pandacode_architect_pandacode_tool_run").is_none());
        assert_eq!(value["agent"]["reviewer"]["permission"]["edit"], "deny");
        assert_eq!(value["agent"]["reviewer"]["permission"]["skill"]["review"], "deny");
        assert!(before.contains(r#""review":"deny""#));
    }

    #[test]
    fn opencode_served_tools_keep_unreadable_and_unserved_launches_unchanged() {
        let raw = r#"{"provider":{"work":{"options":{"timeout":}}}}"#;
        let env_token = r#"{"provider":{"work":{"options":{"timeout":{env:TIMEOUT}}}}}"#;
        let jsonc = "// named connection\n{\"permission\":{\"bash\":\"deny\"},}";
        let names = HashSet::from([EXPLORE_TOOL.into()]);

        // Genuinely unreadable inline config stays verbatim while bound-tool grants fall back to OPENCODE_PERMISSION.
        let mut command = Command::new("unused");
        command.env("OPENCODE_CONFIG_CONTENT", raw);
        command.env("OPENCODE_PERMISSION", r#"{"skill":{"review":"deny"}}"#);
        allow_opencode_tools(&mut command, &config("opencode"), true, &names, None);
        assert_eq!(env_of(&command, "OPENCODE_CONFIG_CONTENT"), raw);
        let permission: Value =
            serde_json::from_str(&env_of(&command, "OPENCODE_PERMISSION")).unwrap();
        assert_eq!(permission["skill"]["review"], "deny");
        assert_eq!(permission["pandacode_architect_pandacode_explore"], "allow");
        assert_eq!(permission["pandacode_architect_pandacode_explore *"], "allow");

        // Unquoted {env:...} value tokens stay verbatim while top-level and per-agent grants merge into OPENCODE_CONFIG_CONTENT.
        let mut command = Command::new("unused");
        command.env("OPENCODE_CONFIG_CONTENT", env_token);
        command.env("OPENCODE_PERMISSION", r#"{"skill":{"review":"deny"}}"#);
        allow_opencode_tools(&mut command, &config("opencode"), true, &names, None);
        let merged = env_of(&command, "OPENCODE_CONFIG_CONTENT");
        assert!(merged.contains(r#""timeout":{env:TIMEOUT}"#), "merged: {merged}");
        assert!(merged.contains(r#""explore":{"permission":{"pandacode_architect_pandacode_explore":"allow""#), "merged: {merged}");

        // Unserved launches leave both OPENCODE_CONFIG_CONTENT and OPENCODE_PERMISSION untouched.
        for (provider, bound, names, inline) in [
            ("opencode", false, &names, raw),
            ("opencode", false, &names, env_token),
            ("opencode", false, &names, jsonc),
            ("opencode", true, &HashSet::new(), jsonc),
            ("kimi", true, &names, jsonc),
        ] {
            let mut command = Command::new("unused");
            command.env("OPENCODE_CONFIG_CONTENT", inline);
            command.env("OPENCODE_PERMISSION", r#"{"skill":{"review":"deny"}}"#);
            allow_opencode_tools(&mut command, &config(provider), bound, names, None);
            assert_eq!(env_of(&command, "OPENCODE_CONFIG_CONTENT"), inline);
            assert_eq!(env_of(&command, "OPENCODE_PERMISSION"), r#"{"skill":{"review":"deny"}}"#);
        }
    }

    #[test]
    fn opencode_served_tools_discover_project_agents_from_config_cwd() {
        let root = std::env::temp_dir().join(format!(
            "pandacode-opencode-project-agent-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::write(
            root.join("opencode.json"),
            r#"{
                "agent": {"custom-reviewer": {"permission": {"*": "deny"}}},
                "agents": {"custom-v2": {"permissions": [{"action": "*", "resource": "*", "effect": "deny"}]}}
            }"#,
        )
        .unwrap();

        let mut cfg = config("opencode");
        cfg.cwd = root.clone();
        let names = HashSet::from([EXPLORE_TOOL.into()]);
        let tool = "pandacode_architect_pandacode_explore";
        let trailing = "pandacode_architect_pandacode_explore *";

        // Pre-scanned agents path (mirrors `run_process_launch`, before `command.current_dir`).
        let mut command = Command::new("opencode");
        configure_command(&mut command, &cfg);
        assert!(command.as_std().get_current_dir().is_none());
        let agents = crate::skill_manager::opencode_all_agents_with_env(Some(&cfg.cwd), &opencode_environment(&command));
        allow_opencode_tools(&mut command, &cfg, true, &names, Some(&agents));
        let value: Value =
            serde_json::from_str(&env_of(&command, "OPENCODE_CONFIG_CONTENT")).unwrap();
        for agent in ["build", "plan", "general", "explore", "custom-reviewer", "custom-v2"] {
            let rules = value["agents"][agent]["permissions"].as_array().unwrap();
            for action in [tool, trailing] {
                assert!(rules.iter().any(|rule| rule["action"] == action && rule["effect"] == "allow"), "{agent}");
            }
        }

        // Direct path with `agents: None` also discovers project agents from `config.cwd`.
        let mut command = Command::new("opencode");
        configure_command(&mut command, &cfg);
        assert!(command.as_std().get_current_dir().is_none());
        allow_opencode_tools(&mut command, &cfg, true, &names, None);
        let value: Value =
            serde_json::from_str(&env_of(&command, "OPENCODE_CONFIG_CONTENT")).unwrap();
        for agent in ["build", "plan", "general", "explore", "custom-reviewer", "custom-v2"] {
            let rules = value["agents"][agent]["permissions"].as_array().unwrap();
            for action in [tool, trailing] {
                assert!(rules.iter().any(|rule| rule["action"] == action && rule["effect"] == "allow"), "{agent}");
            }
        }

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn opencode_launch_environment_respects_overrides_removals_and_inheritance() {
        use crate::skill_manager::OpenCodeEnv;
        let inherited = || Some(std::ffi::OsString::from("inherited-path"));
        assert_eq!(opencode_environment_with(&Command::new("unused"), |_| inherited()),
            OpenCodeEnv::from_environment(|_| inherited()));
        for key in ["OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "XDG_CONFIG_HOME"] {
            let mut command = Command::new("unused");
            command.env(key, "launch-path");
            let effective = opencode_environment_with(&command, |name| {
                assert_ne!(name, key, "an override must not read the inherited value");
                inherited()
            });
            assert_eq!(effective, OpenCodeEnv::from_environment(|name| {
                if name == key { Some("launch-path".into()) } else { inherited() }
            }));
            command.env_remove(key);
            let effective = opencode_environment_with(&command, |name| {
                assert_ne!(name, key, "an explicit removal must not restore the inherited value");
                inherited()
            });
            assert_eq!(effective, OpenCodeEnv::from_environment(|name| {
                if name == key { None } else { inherited() }
            }));
        }
    }

    #[test]
    fn opencode_served_tools_discover_agents_from_launch_config_file() {
        let root = std::env::temp_dir().join(format!("pandacode-opencode-launch-env-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join(".git")).unwrap();
        let file = root.join("connection.json");
        let agent = format!("launch-reviewer-{}", uuid::Uuid::new_v4());
        std::fs::write(&file, json!({"agent":{(agent.as_str()):{"permission":{"*":"deny"}}}}).to_string()).unwrap();
        let mut cfg = config("opencode");
        cfg.cwd = root.clone();
        let names = HashSet::from([EXPLORE_TOOL.into()]);
        for path in [file, PathBuf::from("connection.json")] {
            // The launch command alone names this file; no process environment is changed.
            for prescanned in [false, true] {
                let mut command = Command::new("opencode");
                command.env("OPENCODE_CONFIG", &path);
                command.env("OPENCODE_CONFIG_CONTENT", "{}");
                assert!(command.as_std().get_current_dir().is_none());
                let agents = prescanned.then(|| crate::skill_manager::opencode_all_agents_with_env(
                    Some(&cfg.cwd), &opencode_environment(&command)));
                allow_opencode_tools(&mut command, &cfg, true, &names, agents.as_ref());
                let value: Value = serde_json::from_str(&env_of(&command, "OPENCODE_CONFIG_CONTENT")).unwrap();
                for tool in ["pandacode_architect_pandacode_explore", "pandacode_architect_pandacode_explore *"] {
                    assert_eq!(value["agent"][&agent]["permission"][tool], "allow", "{value}");
                }
            }
            // Direct ACP callers use the command's cwd and effective environment too.
            let mut command = Command::new("opencode");
            command.current_dir(&root).env("OPENCODE_CONFIG", &path).env("OPENCODE_CONFIG_CONTENT", "{}");
            acp::allow_tools(&mut command, &[EXPLORE_TOOL]);
            let value: Value = serde_json::from_str(&env_of(&command, "OPENCODE_CONFIG_CONTENT")).unwrap();
            assert_eq!(value["agent"][&agent]["permission"]["pandacode_architect_pandacode_explore"], "allow");
            assert_eq!(value["agent"][&agent]["permission"]["pandacode_architect_pandacode_explore *"], "allow");
        }
        // No task directory is needed for an absolute launch config file.
        cfg.cwd = PathBuf::new();
        let mut command = Command::new("opencode");
        command.env("OPENCODE_CONFIG", root.join("connection.json")).env("OPENCODE_CONFIG_CONTENT", "{}");
        allow_opencode_tools(&mut command, &cfg, true, &names, None);
        let value: Value = serde_json::from_str(&env_of(&command, "OPENCODE_CONFIG_CONTENT")).unwrap();
        assert_eq!(value["agent"][&agent]["permission"]["pandacode_architect_pandacode_explore"], "allow");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn opencode_served_tools_discover_launch_config_and_xdg_directories() {
        let root = std::env::temp_dir().join(format!("pandacode-opencode-launch-dirs-{}", uuid::Uuid::new_v4()));
        let config_dir = root.join("connection-config");
        let xdg = root.join("connection-xdg");
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::create_dir_all(config_dir.join("agent")).unwrap();
        std::fs::create_dir_all(xdg.join("opencode/agents")).unwrap();
        let directory_agent = format!("directory-reviewer-{}", uuid::Uuid::new_v4());
        let xdg_agent = format!("xdg-reviewer-{}", uuid::Uuid::new_v4());
        std::fs::write(config_dir.join("agent").join(format!("{directory_agent}.md")), "Review").unwrap();
        std::fs::write(xdg.join("opencode/agents").join(format!("{xdg_agent}.md")), "Review").unwrap();
        let mut cfg = config("opencode");
        cfg.cwd = root.clone();
        let mut command = Command::new("opencode");
        command.env("OPENCODE_CONFIG_DIR", config_dir).env("XDG_CONFIG_HOME", xdg).env("OPENCODE_CONFIG_CONTENT", "{}");
        allow_opencode_tools(&mut command, &cfg, true, &HashSet::from([EXPLORE_TOOL.into()]), None);
        let value: Value = serde_json::from_str(&env_of(&command, "OPENCODE_CONFIG_CONTENT")).unwrap();
        for agent in [directory_agent, xdg_agent] {
            for tool in ["pandacode_architect_pandacode_explore", "pandacode_architect_pandacode_explore *"] {
                assert_eq!(value["agent"][&agent]["permission"][tool], "allow", "{agent}: {value}");
            }
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn opencode_served_tools_append_exact_grants_after_existing_permission_rules() {
        let explore = "pandacode_architect_pandacode_explore";
        let names = HashSet::from([
            EXPLORE_TOOL.into(),
            crate::custom_tools::TOOL_LIST.into(),
            crate::custom_tools::TOOL_SAVE.into(),
            crate::custom_tools::TOOL_RUN.into(),
            "pandacode_explore2".into(),
        ]);
        for mode in ["auto", "plan"] {
            let mut cfg = config("opencode");
            cfg.mode = mode.into();
            for exact_deny in ["", r#""pandacode_architect_pandacode_explore":"deny","#] {
                let mut command = Command::new("unused");
                command.env(
                    "OPENCODE_CONFIG_CONTENT",
                    format!(concat!(
                        "// named connection\n{{\"permission\":{{{exact_deny}",
                        "\"pandacode_architect_*\":\"deny\",\"bash\":{{\"deploy *\":\"deny\",\"*\":\"ask\"}}}},",
                        "\"agent\":{{\"plan\":{{\"permission\":\"deny\"}}}},}}"
                    ), exact_deny = exact_deny),
                );
                command.env("OPENCODE_PERMISSION", r#""ask""#);
                allow_opencode_tools(
                    &mut command, &cfg, true, &names, Some(&Default::default()),
                );
                let inline = env_of(&command, "OPENCODE_CONFIG_CONTENT");
                assert!(inline.contains(r#""bash":{"deploy *":"deny","*":"ask"}"#));
                assert!(inline.find(r#""pandacode_architect_*":"deny""#).unwrap()
                    < inline.find(r#""pandacode_architect_pandacode_tool_list":"allow""#).unwrap());
                let value: Value = serde_json::from_str(&inline).unwrap();
                assert_eq!(value["agent"]["plan"]["permission"]["*"], "deny");
                let env = env_of(&command, "OPENCODE_PERMISSION");
                assert!(env.starts_with(r#"{"*":"ask","#));
                let env: Value = serde_json::from_str(&env).unwrap();
                let explore_effect = if exact_deny.is_empty() { "allow" } else { "deny" };
                for rules in [
                    &value["permission"],
                    &value["agent"]["plan"]["permission"],
                    &value["agent"]["build"]["permission"],
                    &env,
                ] {
                    assert_eq!(rules[explore], explore_effect, "{mode}: {rules}");
                    assert_eq!(rules[format!("{explore} *")], explore_effect, "{mode}: {rules}");
                    for name in [crate::custom_tools::TOOL_LIST, crate::custom_tools::TOOL_SAVE] {
                        let tool = format!("pandacode_architect_{name}");
                        assert_eq!(rules[&tool], "allow");
                        assert_eq!(rules[format!("{tool} *")], "allow");
                    }
                    assert!(rules.get("pandacode_architect_pandacode_tool_run").is_none());
                    assert!(rules.get("pandacode_architect_pandacode_explore2").is_none());
                }
            }
        }
    }

    #[test]
    fn opencode_saved_inline_denies_survive_mode_setup_and_grants() {
        let tool = "pandacode_architect_pandacode_explore";
        let trailing = format!("{tool} *");
        let names = HashSet::from([EXPLORE_TOOL.into()]);
        for (mode, wildcard) in [("auto", "ask"), ("full", "allow"), ("plan", "deny")] {
            for action in [tool, trailing.as_str()] {
                for native in [false, true] {
                    let mut command = Command::new("unused");
                    command.env_remove("OPENCODE_PERMISSION");
                    let mut cfg = config("opencode");
                    cfg.mode = mode.into();
                    let saved = if native {
                        json!({"agents": {
                            "plan": {"permissions": [
                                {"action": action, "resource": "*", "effect": "deny"}
                            ]},
                            "build": {"permissions": []}
                        }})
                    } else {
                        json!({"agent": {
                            "plan": {"permission": {(action): "deny", "read": "deny"}}
                        }})
                    };
                    command.env("OPENCODE_CONFIG_CONTENT", saved.to_string());
                    configure_command(&mut command, &cfg);
                    let configured: Value =
                        serde_json::from_str(&env_of(&command, "OPENCODE_CONFIG_CONTENT")).unwrap();
                    assert_eq!(configured["permission"]["*"], wildcard);
                    if !native {
                        let plan = &configured["agent"]["plan"]["permission"];
                        assert_eq!(plan[action], "deny");
                        assert_ne!(plan["read"], "deny");
                    }
                    allow_opencode_tools(
                        &mut command, &cfg, true, &names, Some(&Default::default()),
                    );
                    let value: Value =
                        serde_json::from_str(&env_of(&command, "OPENCODE_CONFIG_CONTENT")).unwrap();
                    assert_eq!(value["permission"][tool], "allow", "{mode}: {value}");
                    if native {
                        for (agent, effect) in [("plan", "deny"), ("build", "allow")] {
                            let rules = value["agents"][agent]["permissions"].as_array().unwrap();
                            for alias in [tool, trailing.as_str()] {
                                assert!(rules.iter().any(|rule| rule["action"] == alias));
                                assert!(rules.iter().filter(|rule| rule["action"] == alias)
                                    .all(|rule| rule["effect"] == effect), "{mode}: {value}");
                            }
                        }
                    } else {
                        for alias in [tool, trailing.as_str()] {
                            assert_eq!(value["agent"]["plan"]["permission"][alias], "deny");
                            assert_eq!(value["agent"]["build"]["permission"][alias], "allow");
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn opencode_markdown_permissions_withhold_unsafe_grants() {
        let root = std::env::temp_dir().join(format!(
            "pandacode-opencode-markdown-{}",
            uuid::Uuid::new_v4()
        ));
        let agents = root.join(".opencode/agents");
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::create_dir_all(&agents).unwrap();
        let tool = "pandacode_architect_pandacode_explore";
        let cases = [
            ("legacy", format!("---\npermission:\n  {tool}: deny\n---\nReview")),
            ("legacy-flow", format!("---\npermission: {{ '{tool} *': deny }}\n---\nReview")),
            ("native", format!("---\npermissions:\n  - action: \"{tool} *\"\n    resource: '*'\n    effect: deny\n---\nReview")),
            ("ambiguous", format!("---\npermission: &deny\n  {tool}: deny\n---\nReview")),
            ("malformed", format!("---\npermission: {{ {tool}: deny\n---\nReview")),
            ("oversized", "x".repeat(256 * 1024 + 1)),
            ("prose", "Review changes.".into()),
            ("metadata", "---\ndescription: |\n  permission: deny\n---\nReview".into()),
            ("scalar", "---\npermission: deny\n---\nReview".into()),
        ];
        for (name, contents) in &cases {
            std::fs::write(agents.join(format!("{name}.md")), contents).unwrap();
        }
        let mut cfg = config("opencode");
        cfg.cwd = root.clone();
        let mut command = Command::new("unused");
        command.env("OPENCODE_CONFIG_CONTENT", "{}");
        command.env_remove("OPENCODE_PERMISSION");
        command.env_remove("OPENCODE_CONFIG");
        command.env_remove("OPENCODE_CONFIG_DIR");
        command.env("XDG_CONFIG_HOME", root.join("xdg"));
        configure_command(&mut command, &cfg);
        allow_opencode_tools(
            &mut command,
            &cfg,
            true,
            &HashSet::from([EXPLORE_TOOL.into()]),
            None,
        );
        let value: Value =
            serde_json::from_str(&env_of(&command, "OPENCODE_CONFIG_CONTENT")).unwrap();
        for (name, _) in cases {
            let last = value["agents"][name]["permissions"]
                .as_array()
                .into_iter()
                .flatten()
                .rfind(|rule| rule["action"] == tool);
            match name {
                "legacy" | "legacy-flow" | "native" => {
                    assert_eq!(last.unwrap()["effect"], "deny", "{name}")
                }
                "ambiguous" | "malformed" | "oversized" => {
                    assert!(last.is_none(), "{name}: {value}")
                }
                _ => assert_eq!(last.unwrap()["effect"], "allow", "{name}"),
            }
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn opencode_connection_disk_only_v2_mode_is_applied_without_skill_switches() {
        let root = std::env::temp_dir().join(format!(
            "pandacode-opencode-v2-mode-{}",
            uuid::Uuid::new_v4()
        ));
        let project = root.join("project");
        let connection = root.join("connection");
        std::fs::create_dir_all(project.join(".git")).unwrap();
        std::fs::create_dir_all(&connection).unwrap();
        let saved = r#"{"agents":{"plan":{"permissions":[
            {"action":"edit","resource":"*","effect":"allow"},
            {"action":"shell","resource":"*","effect":"allow"}
        ]}}}"#;
        std::fs::write(connection.join("opencode.json"), saved).unwrap();
        let disk: Value = serde_json::from_str(saved).unwrap();
        for (mode, shell, edit) in [
            ("plan", "deny", "deny"),
            ("auto", "ask", "allow"),
            ("ask", "ask", "ask"),
            ("full", "allow", "allow"),
        ] {
            let mut cfg = config("opencode");
            cfg.cwd = project.clone();
            cfg.mode = mode.into();
            let mut command = Command::new("unused");
            command.env("OPENCODE_CONFIG_CONTENT", "{}");
            command.env("XDG_CONFIG_HOME", root.join("xdg"));
            command.env("OPENCODE_CONFIG_DIR", &connection);
            command.env_remove("OPENCODE_CONFIG");
            command.env_remove("OPENCODE_PERMISSION");
            enforce_opencode_after_connection_with_env(&mut command, &mut cfg, &Default::default());
            let value: Value =
                serde_json::from_str(&env_of(&command, "OPENCODE_CONFIG_CONTENT")).unwrap();
            let rules = [
                &disk["agents"]["plan"]["permissions"],
                &value["permissions"],
                &value["agents"]["plan"]["permissions"],
            ];
            for (action, expected) in [("shell", shell), ("edit", edit)] {
                let rule = rules
                    .iter()
                    .flat_map(|rules| rules.as_array().unwrap())
                    .rfind(|rule| rule["action"] == action || rule["action"] == "*")
                    .unwrap();
                assert_eq!(rule["effect"], expected, "{mode}/{action}: {value}");
            }
            assert_eq!(value["agent"]["plan"]["permission"]["*"], shell);
            assert_eq!(value["agent"]["build"]["permission"]["*"], shell);
            assert_eq!(value["agents"]["build"]["permissions"][0]["effect"], shell);
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn opencode_disk_denies_survive_mode_setup_and_grants() {
        let root = std::env::temp_dir().join(format!("pandacode-opencode-denies-{}", uuid::Uuid::new_v4()));
        let project = root.join("project");
        let config_dir = root.join("config");
        std::fs::create_dir_all(project.join(".git")).unwrap();
        std::fs::create_dir_all(&config_dir).unwrap();
        let tool = "pandacode_architect_pandacode_explore";
        let names = HashSet::from([EXPLORE_TOOL.into()]);
        for file in [project.join("opencode.json"), config_dir.join("opencode.json")] {
            for exact_rules in [
                format!(r#""{tool}":"deny""#),
                format!(r#""{tool} *":"deny""#),
                format!(r#""{tool} *":"deny","{tool}":"allow""#),
            ] {
                let expected = if exact_rules.ends_with(r#""allow""#) { "allow" } else { "deny" };
                std::fs::write(&file, format!(r#"{{"permission":{{{exact_rules}}}}}"#)).unwrap();
                for mode in ["auto", "full", "plan"] {
                    let mut cfg = config("opencode");
                    cfg.cwd = project.clone();
                    cfg.mode = mode.into();
                    let mut command = Command::new("unused");
                    command.env("OPENCODE_CONFIG_CONTENT", "{}");
                    command.env_remove("OPENCODE_PERMISSION");
                    command.env_remove("OPENCODE_CONFIG");
                    command.env("OPENCODE_CONFIG_DIR", &config_dir);
                    command.env("XDG_CONFIG_HOME", root.join("xdg"));
                    configure_command(&mut command, &cfg);
                    allow_opencode_tools(&mut command, &cfg, true, &names, None);
                    let value: Value =
                        serde_json::from_str(&env_of(&command, "OPENCODE_CONFIG_CONTENT")).unwrap();
                    for rules in [
                        &value["permission"],
                        &value["agent"]["build"]["permission"],
                        &value["agent"]["plan"]["permission"],
                    ] {
                        assert_eq!(rules[tool], expected, "{mode}: {rules}");
                        assert_eq!(rules[format!("{tool} *")], expected, "{mode}: {rules}");
                    }
                }
            }
            std::fs::remove_file(file).unwrap();
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn opencode_opaque_inline_config_is_preserved_when_no_skills_are_disabled() {
        let disabled = std::collections::BTreeSet::new();
        let names = HashSet::from([EXPLORE_TOOL.into()]);
        for opaque in [
            r#"{"provider":{"work": broken"#,
            r#"{"permission":{env:PERM},"mcp":{"x":{}}}"#,
            r#"{"agents":{file:./agents.json}}"#,
        ] {
            for mode in ["ask", "auto", "plan", "full"] {
                let mut cfg = config("opencode");
                cfg.mode = mode.into();
                let mut command = Command::new("opencode");
                command.env("OPENCODE_CONFIG_CONTENT", opaque);
                command.env("OPENCODE_PERMISSION", r#"{"bash":"ask"}"#);
                enforce_opencode_after_connection(
                    &mut command,
                    &mut cfg,
                    &disabled,
                    &Default::default(),
                );
                assert_eq!(
                    env_of(&command, "OPENCODE_CONFIG_CONTENT"),
                    opaque,
                    "{mode}: opaque inline must be preserved verbatim when disabled is empty"
                );
                assert_eq!(
                    env_of(&command, "OPENCODE_PERMISSION"),
                    r#"{"bash":"ask"}"#,
                    "{mode}: existing OPENCODE_PERMISSION must stay untouched"
                );
                assert!(cfg.instructions.is_empty(), "{mode}: no reminder when nothing disabled");

                // Bound-tool grants still keep the opaque inline config verbatim and route via OPENCODE_PERMISSION.
                allow_opencode_tools(
                    &mut command,
                    &cfg,
                    true,
                    &names,
                    Some(&Default::default()),
                );
                assert_eq!(env_of(&command, "OPENCODE_CONFIG_CONTENT"), opaque);
                let permission: Value =
                    serde_json::from_str(&env_of(&command, "OPENCODE_PERMISSION")).unwrap();
                assert_eq!(permission["bash"], "ask");
                assert_eq!(permission["pandacode_architect_pandacode_explore"], "allow");
                assert_eq!(permission["pandacode_architect_pandacode_explore *"], "allow");
            }
        }
    }
}
