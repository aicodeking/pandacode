//! Codex command metadata and installed skill discovery; no prompt or tool execution.
use super::{Catalog, Invocation, SlashCommand};
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashSet},
    path::{Component, Path, PathBuf},
};

const MAX_SKILLS: usize = 300;
const MAX_ENTRIES: usize = 16;
const MAX_SCANNED_SKILLS: usize = 1200;
const MAX_NAME_BYTES: usize = 128;
const MAX_PATH_BYTES: usize = 4096;
const MAX_DESCRIPTION_BYTES: usize = 1024;

#[derive(PartialEq, Eq, PartialOrd, Ord)]
struct SkillInfo {
    description: String,
    scope: Option<String>,
    plugin: Option<String>,
}

pub async fn discover(cwd: &Path) -> Result<Catalog, String> {
    let mut catalog = match crate::integrations::discover_skills(cwd).await {
        Ok(value) => parse_skills(&value),
        Err(_) => Catalog {
            commands: Vec::new(),
            warnings: vec![
                "Installed Codex skills could not be loaded. Check Codex availability and refresh."
                    .into(),
            ],
        },
    };
    let mut commands = builtins();
    commands.append(&mut catalog.commands);
    catalog.commands = commands;
    Ok(catalog)
}

fn parse_skills(value: &Value) -> Catalog {
    let mut catalog = Catalog {
        commands: Vec::new(),
        warnings: Vec::new(),
    };
    let Some(entries) = value.get("data").and_then(Value::as_array) else {
        catalog
            .warnings
            .push("Codex returned an invalid skill inventory.".into());
        return catalog;
    };
    let mut skills = BTreeMap::new();
    let mut malformed = false;
    let mut load_errors = false;
    let mut limited = entries.len() > MAX_ENTRIES;
    let mut scanned = 0;
    'entries: for entry in entries.iter().take(MAX_ENTRIES) {
        if let Some(errors) = entry.get("errors") {
            match errors.as_array() {
                Some(errors) => load_errors |= !errors.is_empty(),
                None => malformed = true,
            }
        }
        let Some(items) = entry.get("skills").and_then(Value::as_array) else {
            malformed = true;
            continue;
        };
        for item in items {
            if scanned == MAX_SCANNED_SKILLS {
                limited = true;
                break 'entries;
            }
            scanned += 1;
            match item.get("enabled").and_then(Value::as_bool) {
                Some(false) => continue,
                Some(true) => {}
                None => {
                    malformed = true;
                    continue;
                }
            }
            let Some((name, path, metadata)) = skill_metadata(item) else {
                malformed = true;
                continue;
            };
            let key = (name.to_owned(), path.to_owned());
            if let Some(existing) = skills.get_mut(&key) {
                // Discovery order must not decide duplicate metadata or IDs.
                if metadata < *existing {
                    *existing = metadata;
                }
            } else if skills.len() < MAX_SKILLS {
                skills.insert(key, metadata);
            } else {
                limited = true;
            }
        }
    }
    let mut used_names: HashSet<_> = builtins().into_iter().map(|command| command.name).collect();
    let mut name_counts = BTreeMap::new();
    for (name, _) in skills.keys() {
        *name_counts.entry(name.clone()).or_insert(0_usize) += 1;
    }
    let mut candidates: Vec<_> = skills
        .into_iter()
        .map(|((name, path), metadata)| {
            let id = skill_id(&name, &path);
            let base = if used_names.contains(&format!("/{name}")) {
                format!("/skills:{name}")
            } else {
                format!("/{name}")
            };
            let qualifier = metadata
                .plugin
                .as_deref()
                .map(|plugin| plugin.split('@').next().unwrap_or(plugin))
                .or(metadata.scope.as_deref());
            let visible_name = if name_counts[&name] > 1 {
                qualifier
                    .map(|qualifier| format!("{base}:{qualifier}"))
                    .filter(|candidate| candidate.len() <= 160)
                    .unwrap_or_else(|| hashed_alias(&base, &id))
            } else {
                base.clone()
            };
            let mut source = "Codex skill".to_owned();
            if let Some(scope) = &metadata.scope {
                source.push_str(&format!(" · {scope}"));
            }
            if let Some(plugin) = &metadata.plugin {
                source.push_str(&format!(" · {plugin}"));
            }
            (
                base,
                SlashCommand {
                    id,
                    name: visible_name,
                    description: metadata.description,
                    argument_hint: Some("[instructions]".into()),
                    kind: "prompt".into(),
                    source,
                    reason: None,
                    invocation: Invocation::Skill {
                        name,
                        path: PathBuf::from(path),
                    },
                },
            )
        })
        .collect();
    let mut candidate_counts = BTreeMap::new();
    for (_, command) in &candidates {
        *candidate_counts
            .entry(command.name.clone())
            .or_insert(0_usize) += 1;
    }
    for (base, command) in &mut candidates {
        if candidate_counts[&command.name] > 1 || used_names.contains(&command.name) {
            command.name = hashed_alias(base, &command.id);
        }
        if !used_names.insert(command.name.clone()) {
            command.name = format!(
                "/skills:{}",
                command.id.rsplit(':').next().unwrap_or(&command.id)
            );
            used_names.insert(command.name.clone());
        }
    }
    catalog.commands = candidates.into_iter().map(|(_, command)| command).collect();
    if malformed {
        catalog
            .warnings
            .push("Some Codex skill metadata was invalid and was omitted.".into());
    }
    if load_errors {
        catalog.warnings.push(
            "Codex could not load some installed skills. Check their definitions in Codex.".into(),
        );
    }
    if limited {
        catalog.warnings.push("The Codex skill inventory exceeded the command catalog limit; additional skills were omitted.".into());
    }
    catalog
}

fn skill_metadata(value: &Value) -> Option<(&str, &str, SkillInfo)> {
    let name = value.get("name")?.as_str()?;
    if name.is_empty()
        || name.len() > MAX_NAME_BYTES
        || !name.as_bytes()[0].is_ascii_alphanumeric()
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_-.:".contains(&byte))
    {
        return None;
    }
    let path = value.get("path")?.as_str()?;
    let native_path = Path::new(path);
    if path.len() > MAX_PATH_BYTES
        || path.chars().any(char::is_control)
        || !native_path.is_absolute()
        || native_path
            .components()
            .any(|component| component == Component::ParentDir)
    {
        return None;
    }
    let description = value.get("description")?.as_str()?;
    let scope = value
        .get("scope")
        .and_then(Value::as_str)
        .filter(|scope| matches!(*scope, "repo" | "user" | "admin" | "system"))
        .map(str::to_owned);
    let plugin = value
        .get("pluginId")
        .and_then(Value::as_str)
        .filter(|plugin| {
            !plugin.is_empty()
                && plugin.len() <= 96
                && plugin.as_bytes()[0].is_ascii_alphanumeric()
                && plugin
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"_-.:@".contains(&byte))
        })
        .map(str::to_owned);
    Some((
        name,
        path,
        SkillInfo {
            description: bounded_description(description),
            scope,
            plugin,
        },
    ))
}

fn hashed_alias(base: &str, id: &str) -> String {
    format!("{base}:{}", id.rsplit(':').next().unwrap_or(id))
}

fn bounded_description(value: &str) -> String {
    let mut result = String::new();
    for character in value.chars() {
        let character = if character.is_whitespace() {
            ' '
        } else {
            character
        };
        if character.is_control() {
            continue;
        }
        if result.len() + character.len_utf8() > MAX_DESCRIPTION_BYTES {
            break;
        }
        result.push(character);
    }
    result.trim().to_owned()
}

fn skill_id(name: &str, path: &str) -> String {
    // Stable FNV-1a identifies the native name/path pair without exposing paths in UI metadata.
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in name.bytes().chain(std::iter::once(0)).chain(path.bytes()) {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("codex:skill:{hash:016x}")
}

// Authoritative command names, not copied implementation:
// https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/tui/src/slash_command.rs
// Runtime flags and catalog service tiers further restrict availability:
// https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/tui/src/bottom_pane/slash_commands.rs
fn builtins() -> Vec<SlashCommand> {
    builtins_for_platform(std::env::consts::OS)
}

fn builtins_for_platform(platform: &str) -> Vec<SlashCommand> {
    let mut commands = Vec::new();
    for (name, description, action) in [
        ("model", "Choose a model and reasoning effort", "model"),
        (
            "permissions",
            "Choose the task permission mode",
            "permissions",
        ),
        ("skills", "Browse available skills", "skills"),
        ("new", "Start a new task", "new"),
        ("diff", "Inspect project changes", "diff"),
        ("status", "Show the current task status", "status"),
        ("mcp", "Inspect configured MCP integrations", "integrations"),
        ("apps", "Inspect available app integrations", "integrations"),
        (
            "plugins",
            "Inspect installed plugin integrations",
            "plugins",
        ),
    ] {
        commands.push(descriptor(
            name,
            description,
            None,
            "Codex built-in",
            Invocation::Action(action.into()),
            None,
        ));
    }
    for (name, description, action, hint) in [
        ("help", "Browse PandaCode commands", "help", None),
        (
            "integrations",
            "Inspect available integrations",
            "integrations",
            None,
        ),
        ("settings", "Open PandaCode settings", "settings", None),
        ("theme", "Change PandaCode's appearance", "theme", None),
        (
            "resume",
            "Choose a Codex conversation to continue",
            "conversations",
            Some("[search]"),
        ),
        (
            "rename",
            "Rename the current task",
            "rename",
            Some("<title>"),
        ),
        ("copy", "Copy the latest agent response", "copy", None),
        ("pwd", "Show the task's working directory", "pwd", None),
        ("cwd", "Show the task's working directory", "pwd", None),
    ] {
        commands.push(descriptor(
            name,
            description,
            hint,
            "PandaCode",
            Invocation::Action(action.into()),
            None,
        ));
    }
    commands.push(descriptor(
        "compact",
        "Compact this Codex task's context",
        None,
        "Codex built-in",
        Invocation::Native,
        None,
    ));
    commands.push(descriptor(
        "review",
        "Ask Codex to review project changes",
        Some("[review instructions]"),
        "Codex built-in",
        Invocation::Native,
        None,
    ));

    for (name, description, action, hint) in [
        (
            "goal",
            "Manage a persistent goal and its token budget",
            "goal",
            Some("[objective|pause|resume|clear]"),
        ),
        (
            "usage",
            "Inspect Codex account and token usage",
            "usage",
            Some("[daily|weekly|cumulative]"),
        ),
        ("hooks", "Inspect configured lifecycle hooks", "hooks", None),
        (
            "import",
            "Choose setup and chats to import",
            "imports",
            None,
        ),
        ("archive", "Archive this task", "archive", None),
        (
            "delete",
            "Delete this task after confirmation",
            "delete",
            None,
        ),
        (
            "fork",
            "Create a separate task with this conversation",
            "fork",
            Some("[instructions]"),
        ),
        (
            "side",
            "Continue this context in a separate task",
            "fork",
            Some("[instructions]"),
        ),
        (
            "export",
            "Export this conversation",
            "export",
            Some("[file]"),
        ),
        (
            "worktree",
            "Create a worktree task in this project",
            "worktree",
            Some("[branch]"),
        ),
        (
            "plan",
            "Choose Codex collaboration mode",
            "plan",
            Some("[instructions]"),
        ),
        (
            "fast",
            "Choose a model-supported service tier",
            "fast",
            Some("[on|off]"),
        ),
        ("agents", "Browse running tasks", "agents", None),
        (
            "subagents",
            "Browse this task's child agents",
            "subagents",
            None,
        ),
        (
            "mention",
            "Attach a workspace file",
            "mention",
            Some("<path>"),
        ),
        (
            "cd",
            "Choose the task's working directory",
            "cd",
            Some("<directory>"),
        ),
        (
            "init",
            "Ask the agent to create project instructions",
            "init",
            Some("[instructions]"),
        ),
        (
            "recap",
            "Ask the agent to summarize this conversation",
            "recap",
            Some("[instructions]"),
        ),
        (
            "personality",
            "Choose Codex response style",
            "preferences",
            None,
        ),
        (
            "experimental",
            "Manage Codex experimental features",
            "preferences",
            None,
        ),
        (
            "memories",
            "Manage Codex memory preferences",
            "preferences",
            None,
        ),
        ("ps", "Inspect background jobs", "jobs", None),
        ("stop", "Choose background jobs to stop", "jobs", None),
        ("clean", "Choose background jobs to stop", "jobs", None),
    ] {
        commands.push(descriptor(
            name,
            description,
            hint,
            "PandaCode",
            Invocation::Action(action.into()),
            None,
        ));
    }
    // These operate on the real harness's terminal state. The app opens its
    // scoped console and shows the exact command for an explicit Ready action.
    // They never become a model message or a shell command.
    for (name, description, hint) in [
        (
            "keymap",
            "Configure Codex terminal keyboard shortcuts",
            None,
        ),
        ("vim", "Change Codex terminal editing mode", None),
        (
            "raw",
            "Change Codex terminal scrollback formatting",
            Some("[on|off]"),
        ),
        ("title", "Configure the Codex terminal title", None),
        (
            "statusline",
            "Configure the Codex terminal status line",
            None,
        ),
        ("pets", "Choose a Codex terminal pet", Some("[off]")),
        ("pet", "Choose a Codex terminal pet", Some("[off]")),
        ("quit", "Close the Codex terminal session", None),
        ("exit", "Close the Codex terminal session", None),
        (
            "clear",
            "Clear the Codex terminal and create a new chat",
            Some("[name]"),
        ),
        (
            "app",
            "Open this Codex task in the official desktop app",
            None,
        ),
        (
            "ide",
            "Attach context from a connected editor",
            Some("[instructions]"),
        ),
        ("logout", "Sign out of Codex in its console", None),
        ("feedback", "Open Codex feedback and diagnostics", None),
        (
            "approve",
            "Retry an action denied by Codex automatic review",
            None,
        ),
    ] {
        if name == "app" && !matches!(platform, "macos" | "windows") {
            commands.push(descriptor(
                name,
                description,
                hint,
                "Codex built-in",
                Invocation::Unsupported,
                Some("The Codex desktop app is available only on macOS and Windows."),
            ));
            continue;
        }
        commands.push(descriptor(
            name,
            description,
            hint,
            "Codex console",
            Invocation::Action(format!("console:{name}")),
            None,
        ));
    }
    for (name, description, hint) in [
        (
            "setup-default-sandbox",
            "Set up the Windows agent sandbox",
            None,
        ),
        (
            "sandbox-add-read-dir",
            "Add Windows sandbox read access",
            Some("<directory>"),
        ),
    ] {
        let (source, invocation, reason) = if platform == "windows" {
            (
                "Codex console",
                Invocation::Action(format!("console:{name}")),
                None,
            )
        } else {
            (
                "Codex built-in",
                Invocation::Unsupported,
                Some("This command is available only on Windows."),
            )
        };
        commands.push(descriptor(
            name,
            description,
            hint,
            source,
            invocation,
            reason,
        ));
    }
    for name in [
        "debug-config",
        "rollout",
        "test-approval",
        "debug-m-drop",
        "debug-m-update",
    ] {
        commands.push(descriptor(
            name,
            "Codex internal diagnostics",
            None,
            "Codex built-in",
            Invocation::Unsupported,
            Some("Internal Codex diagnostic command; unavailable in PandaCode."),
        ));
    }
    commands
}

fn descriptor(
    name: &str,
    description: &str,
    hint: Option<&str>,
    source: &str,
    invocation: Invocation,
    reason: Option<&str>,
) -> SlashCommand {
    let kind = match &invocation {
        Invocation::Action(_) => "action",
        Invocation::Unsupported => "unsupported",
        _ => "prompt",
    };
    SlashCommand {
        id: format!("codex:builtin:{name}"),
        name: format!("/{name}"),
        description: description.into(),
        argument_hint: hint.map(str::to_owned),
        kind: kind.into(),
        source: source.into(),
        reason: reason.map(str::to_owned),
        invocation,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashSet;

    fn fixture_path(path: &str) -> String {
        if cfg!(windows) && path.starts_with('/') {
            format!("C:{path}")
        } else {
            path.to_owned()
        }
    }

    fn skill(name: &str, path: &str) -> Value {
        json!({"name": name, "path": fixture_path(path), "description": "Review a change", "enabled": true})
    }

    fn envelope(skills: Vec<Value>) -> Value {
        json!({"data": [{"cwd": "/project", "skills": skills, "errors": []}]})
    }

    #[test]
    fn native_commands_are_only_operations_supported_by_the_adapter() {
        let commands = builtins();
        for name in ["/compact", "/review"] {
            let command = commands
                .iter()
                .find(|command| command.name == name)
                .unwrap();
            assert!(matches!(command.invocation, Invocation::Native));
            assert_eq!(command.kind, "prompt");
        }
        let native: Vec<_> = commands
            .iter()
            .filter(|command| matches!(command.invocation, Invocation::Native))
            .collect();
        assert_eq!(native.len(), 2);
        for (name, expected) in [
            ("/new", "new"),
            ("/mcp", "integrations"),
            ("/apps", "integrations"),
            ("/plugins", "plugins"),
            ("/skills", "skills"),
            ("/diff", "diff"),
            ("/theme", "theme"),
            ("/resume", "conversations"),
            ("/rename", "rename"),
            ("/copy", "copy"),
            ("/pwd", "pwd"),
            ("/cwd", "pwd"),
        ] {
            let command = commands
                .iter()
                .find(|command| command.name == name)
                .unwrap();
            assert!(
                matches!(&command.invocation, Invocation::Action(action) if action == expected)
            );
        }
    }

    #[test]
    fn every_public_command_has_an_app_or_real_console_route() {
        let commands = builtins();
        for command in &commands {
            if (!cfg!(windows)
                && matches!(
                    command.name.as_str(),
                    "/setup-default-sandbox" | "/sandbox-add-read-dir"
                ))
                || (!cfg!(any(target_os = "macos", target_os = "windows"))
                    && command.name == "/app")
                || matches!(
                    command.name.as_str(),
                    "/debug-config"
                        | "/rollout"
                        | "/test-approval"
                        | "/debug-m-drop"
                        | "/debug-m-update"
                )
            {
                assert!(matches!(command.invocation, Invocation::Unsupported));
                assert!(command
                    .reason
                    .as_ref()
                    .is_some_and(|reason| !reason.is_empty()));
            } else {
                assert!(
                    !matches!(command.invocation, Invocation::Unsupported),
                    "{} has no route",
                    command.name
                );
                if let Invocation::Action(action) = &command.invocation {
                    assert!(
                        action.starts_with("console:")
                            || [
                                "model",
                                "permissions",
                                "skills",
                                "new",
                                "diff",
                                "status",
                                "integrations",
                                "plugins",
                                "help",
                                "settings",
                                "theme",
                                "conversations",
                                "rename",
                                "copy",
                                "pwd",
                                "goal",
                                "usage",
                                "hooks",
                                "imports",
                                "archive",
                                "delete",
                                "fork",
                                "export",
                                "worktree",
                                "plan",
                                "fast",
                                "agents",
                                "subagents",
                                "mention",
                                "cd",
                                "init",
                                "recap",
                                "preferences",
                                "jobs"
                            ]
                            .contains(&action.as_str()),
                        "Unknown action {action}"
                    );
                }
            }
        }
        for (name, action) in [
            ("/goal", "goal"),
            ("/worktree", "worktree"),
            ("/export", "export"),
            ("/approve", "console:approve"),
            ("/raw", "console:raw"),
            ("/resume", "conversations"),
        ] {
            let command = commands.iter().find(|entry| entry.name == name).unwrap();
            assert!(matches!(&command.invocation, Invocation::Action(value) if value == action));
        }
        let ids: HashSet<_> = commands.iter().map(|command| &command.id).collect();
        let names: HashSet<_> = commands.iter().map(|command| &command.name).collect();
        assert_eq!(ids.len(), commands.len());
        assert_eq!(names.len(), commands.len());
    }

    #[test]
    fn platform_commands_route_to_the_console_only_where_supported() {
        for platform in ["linux", "macos", "windows"] {
            let commands = builtins_for_platform(platform);
            for name in ["setup-default-sandbox", "sandbox-add-read-dir"] {
                let command = commands
                    .iter()
                    .find(|entry| entry.name == format!("/{name}"))
                    .unwrap();
                if platform == "windows" {
                    assert!(
                        matches!(&command.invocation, Invocation::Action(action) if action == &format!("console:{name}"))
                    );
                    assert_eq!(command.kind, "action");
                    assert!(command.reason.is_none());
                } else {
                    assert!(matches!(command.invocation, Invocation::Unsupported));
                    assert_eq!(
                        command.reason.as_deref(),
                        Some("This command is available only on Windows.")
                    );
                }
            }
            let app = commands.iter().find(|entry| entry.name == "/app").unwrap();
            if platform == "linux" {
                assert!(matches!(app.invocation, Invocation::Unsupported));
                assert!(app.reason.as_deref().unwrap().contains("macOS and Windows"));
            } else {
                assert!(
                    matches!(&app.invocation, Invocation::Action(action) if action == "console:app")
                );
                assert!(app.reason.is_none());
            }
        }
    }

    #[test]
    fn only_enabled_skills_have_native_paths_and_stable_distinct_ids() {
        let first = skill("review", "/one/SKILL.md");
        let second = skill("review", "/two/SKILL.md");
        let mut disabled = skill("disabled", "/disabled/SKILL.md");
        disabled["enabled"] = json!(false);
        let a = parse_skills(&envelope(vec![
            first.clone(),
            second.clone(),
            first.clone(),
            disabled,
        ]));
        let b = parse_skills(&envelope(vec![second, first]));
        assert_eq!(a.commands.len(), 2);
        assert_eq!(
            a.commands
                .iter()
                .map(|command| &command.id)
                .collect::<Vec<_>>(),
            b.commands
                .iter()
                .map(|command| &command.id)
                .collect::<Vec<_>>()
        );
        assert_ne!(a.commands[0].id, a.commands[1].id);
        assert!(
            a.commands
                .iter()
                .all(|command| command.name.starts_with("/skills:review:")
                    && command.kind == "prompt")
        );
        assert_ne!(a.commands[0].name, a.commands[1].name);
        assert!(
            matches!(&a.commands[0].invocation, Invocation::Skill {name, path} if name == "review" && path == Path::new(&fixture_path("/one/SKILL.md")))
        );
        assert!(a
            .commands
            .iter()
            .all(|command| !command.description.contains("/one/")
                && !command.source.contains("/one/")));
    }

    #[test]
    fn malformed_skill_metadata_never_becomes_an_invocable_command() {
        let mut missing_enabled = skill("missing", "/missing/SKILL.md");
        missing_enabled.as_object_mut().unwrap().remove("enabled");
        let commands = vec![
            skill("name with spaces", "/a/SKILL.md"),
            skill("/injected", "/b/SKILL.md"),
            skill(&"x".repeat(129), "/c/SKILL.md"),
            skill("relative", "relative/SKILL.md"),
            skill("control", "/unsafe\n/SKILL.md"),
            skill("traversal", "/a/../b/SKILL.md"),
            missing_enabled,
        ];
        let parsed = parse_skills(&envelope(commands));
        assert!(parsed.commands.is_empty());
        assert!(!parsed.warnings.is_empty());
    }

    #[test]
    fn skill_paths_require_native_absolute_paths_and_preserve_their_spelling() {
        let valid = if cfg!(windows) {
            vec![
                r"C:\Users\Example User\skills\SKILL.md",
                r"\\server\share\skills\SKILL.md",
            ]
        } else {
            vec!["/home/example user/skills/SKILL.md"]
        };
        for path in valid {
            let catalog = parse_skills(&envelope(vec![skill("native", path)]));
            assert_eq!(catalog.commands.len(), 1);
            assert!(
                matches!(&catalog.commands[0].invocation, Invocation::Skill { path: bound, .. } if bound == Path::new(path))
            );
        }
        let invalid = if cfg!(windows) {
            vec![
                r"C:skills\SKILL.md",
                r"\skills\SKILL.md",
                r"C:\skills\..\SKILL.md",
            ]
        } else {
            vec![
                r"C:\skills\SKILL.md",
                "skills/SKILL.md",
                "/skills/../SKILL.md",
            ]
        };
        for path in invalid {
            let catalog = parse_skills(&envelope(vec![skill("invalid", path)]));
            assert!(
                catalog.commands.is_empty(),
                "Accepted non-native path {path}"
            );
        }
    }

    #[test]
    fn discovery_errors_are_generic_and_good_entries_survive() {
        let response = json!({"data": [
            {"cwd": "/secret-project", "skills": [skill("usable", "/usable/SKILL.md")], "errors": [{"message": "SECRET provider diagnostic", "path": "/secret"}]},
            {"skills": "SECRET malformed"}
        ]});
        let parsed = parse_skills(&response);
        assert_eq!(parsed.commands.len(), 1);
        assert!(!parsed.warnings.is_empty());
        assert!(!format!("{:?}", parsed.warnings).contains("SECRET"));
        assert!(!format!("{:?}", parsed.warnings).contains("secret"));
        assert!(!parse_skills(&json!({"unexpected": true}))
            .warnings
            .is_empty());
    }

    #[test]
    fn discovery_is_bounded_and_descriptions_remain_valid_utf8() {
        let mut entries = (0..400)
            .map(|i| skill(&format!("skill-{i}"), &format!("/skill-{i}/SKILL.md")))
            .collect::<Vec<_>>();
        entries[0]["description"] = json!(format!("{}\u{001b}[31m", "🦀".repeat(2000)));
        let parsed = parse_skills(&envelope(entries));
        assert_eq!(parsed.commands.len(), 300);
        assert!(!parsed.warnings.is_empty());
        assert!(parsed
            .commands
            .iter()
            .all(|command| command.description.len() <= 1024
                && !command.description.contains('\u{001b}')));
    }

    #[test]
    fn skill_aliases_preserve_normal_names_and_qualify_collisions() {
        let mut repo = skill("deploy", "/repo/SKILL.md");
        repo["scope"] = json!("repo");
        let mut plugin = skill("deploy", "/plugin/SKILL.md");
        plugin["scope"] = json!("user");
        plugin["pluginId"] = json!("release@workspace");
        let parsed = parse_skills(&envelope(vec![
            repo,
            plugin,
            skill("review", "/review/SKILL.md"),
            skill("unique", "/unique/SKILL.md"),
        ]));
        let names: HashSet<_> = parsed
            .commands
            .iter()
            .map(|command| command.name.as_str())
            .collect();
        assert_eq!(
            names,
            HashSet::from([
                "/deploy:repo",
                "/deploy:release",
                "/skills:review",
                "/unique"
            ])
        );
        let plugin = parsed
            .commands
            .iter()
            .find(|command| command.name == "/deploy:release")
            .unwrap();
        assert!(plugin.source.contains("release@workspace") && plugin.source.contains("user"));
        assert!(
            matches!(&plugin.invocation, Invocation::Skill {name, path} if name == "deploy" && path == Path::new(&fixture_path("/plugin/SKILL.md")))
        );
    }

    #[test]
    fn long_and_ambiguous_skill_qualifiers_fall_back_without_exposing_paths() {
        let long_name = "x".repeat(128);
        let entries = ["/private-one/SKILL.md", "/private-two/SKILL.md"]
            .into_iter()
            .map(|path| {
                let mut value = skill(&long_name, path);
                value["scope"] = json!("user");
                value["pluginId"] =
                    json!("very-long-plugin-namespace-that-does-not-fit@marketplace");
                value
            })
            .collect();
        let parsed = parse_skills(&envelope(entries));
        assert_eq!(parsed.commands.len(), 2);
        assert_ne!(parsed.commands[0].name, parsed.commands[1].name);
        assert!(parsed
            .commands
            .iter()
            .all(|command| command.name.len() <= 160
                && !command.name.contains("private-")
                && !command.source.contains("private-")));
    }
}
