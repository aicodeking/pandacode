use super::*;

/// Hides only skill-sourced commands, using the same per-harness built-in list as the
/// typed-command guard (`skill_manager::harness_builtin`). `installed` lists skill names
/// installed for this harness and folder, read only when a native command could be a
/// switched-off skill.
pub(super) fn filter(
    harness: &str,
    mut catalog: Catalog,
    disabled: &std::collections::BTreeSet<String>,
    installed: impl FnOnce() -> std::collections::BTreeSet<String>,
) -> Catalog {
    if disabled.is_empty() {
        return catalog;
    }
    let off = |name: &str| crate::skill_manager::is_disabled(disabled, name);
    let mut installed = Some(installed);
    let mut names: Option<std::collections::BTreeSet<String>> = None;
    catalog
        .commands
        .retain(|command| match &command.invocation {
            Invocation::Skill { name, path } => {
                !off(name)
                    && !crate::skill_manager::canonical_name(path).is_some_and(|name| off(&name))
            }
            Invocation::Native if command.kind == "prompt" => {
                let name = command.name.trim_start_matches('/');
                if crate::skill_manager::harness_builtin(harness, name) {
                    return true;
                }
                if let Some(skill) = name.strip_prefix("skill:") {
                    return !off(skill);
                }
                if command.source.to_ascii_lowercase().contains("skill") {
                    return !off(name);
                }
                if !off(name) {
                    return true;
                }
                let names =
                    names.get_or_insert_with(|| installed.take().map(|f| f()).unwrap_or_default());
                !names.contains(name)
            }
            _ => true,
        });
    catalog
}
/// Reads the switches (settings file, SQLite) and maybe the installed SKILL.md files, so it
/// runs on a blocking thread, never on the async runtime.
pub(super) async fn for_path(
    harness: &str,
    catalog: Catalog,
    cwd: &Path,
) -> Result<Catalog, String> {
    let (harness, cwd) = (harness.to_owned(), cwd.to_path_buf());
    crate::blocking(move || {
        note_reader();
        Ok(filter(
            &harness,
            catalog,
            &crate::skill_manager::disabled_at(&cwd),
            || crate::skill_manager::installed_names_for(&harness, &cwd),
        ))
    })
    .await
}
/// Resolves a typed command against the switch-filtered catalog. A command that only the
/// switches hid gets the documented switched-off error instead of "Unknown command".
/// Blocking reads, as in `for_path`.
pub(super) async fn resolve_at(
    harness: &str,
    text: &str,
    catalog: Catalog,
    cwd: &Path,
) -> Result<Resolution, String> {
    let (harness, text, cwd) = (harness.to_owned(), text.to_owned(), cwd.to_path_buf());
    crate::blocking(move || {
        note_reader();
        resolve_with(
            &harness,
            &text,
            catalog,
            &crate::skill_manager::disabled_at(&cwd),
            || crate::skill_manager::installed_names_for(&harness, &cwd),
        )
    })
    .await
}
/// Threads that read switches, so a test can prove the async runtime never does.
#[cfg(test)]
pub(super) static READERS: std::sync::Mutex<Vec<std::thread::ThreadId>> =
    std::sync::Mutex::new(Vec::new());
fn note_reader() {
    #[cfg(test)]
    READERS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .push(std::thread::current().id());
}
pub(super) fn resolve_with(
    harness: &str,
    text: &str,
    catalog: Catalog,
    disabled: &std::collections::BTreeSet<String>,
    installed: impl FnOnce() -> std::collections::BTreeSet<String>,
) -> Result<Resolution, String> {
    if disabled.is_empty() {
        return resolve_from_catalog(harness, text, &catalog);
    }
    let shown = filter(harness, catalog.clone(), disabled, installed);
    resolve_from_catalog(harness, text, &shown)
        .map_err(|error| hidden_skill_error(&catalog, &shown, text, disabled).unwrap_or(error))
}
/// The switched-off error for a typed name that only the switches removed from the catalog.
fn hidden_skill_error(
    catalog: &Catalog,
    shown: &Catalog,
    text: &str,
    disabled: &std::collections::BTreeSet<String>,
) -> Option<String> {
    let (name, _) = split_command(text)?;
    if shown.commands.iter().any(|command| command.name == name) {
        return None;
    }
    let off = |name: &str| crate::skill_manager::is_disabled(disabled, name);
    let hidden = catalog
        .commands
        .iter()
        .find(|command| command.name == name)?;
    let skill = match &hidden.invocation {
        Invocation::Skill { name, path } => match crate::skill_manager::canonical_name(path) {
            Some(canonical) if !off(name) => canonical,
            _ => name.clone(),
        },
        _ => {
            let typed = name.trim_start_matches('/');
            typed.strip_prefix("skill:").unwrap_or(typed).to_owned()
        }
    };
    Some(crate::skill_manager::off_error(disabled, &skill))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn slash_typed_switched_off_skill_says_it_is_switched_off_not_unknown() {
        let off = std::collections::BTreeSet::from(["deploy".into()]);
        let installed = || std::collections::BTreeSet::from(["deploy".into()]);
        for (harness, command) in [
            ("claude", native("claude:/deploy", "/deploy", "claude")),
            (
                "deepseek",
                native("deepseek:skill:deploy", "/deploy", "DeepSeek skill · user"),
            ),
            (
                "claude",
                native("claude:/skill:deploy", "/skill:deploy", "claude"),
            ),
        ] {
            let typed = command.name.clone();
            let catalog = Catalog {
                commands: vec![command, native("claude:/other", "/other", "claude")],
                ..Catalog::default()
            };
            let error = resolve_with(
                harness,
                &format!("{typed} now"),
                catalog.clone(),
                &off,
                installed,
            )
            .err()
            .unwrap();
            assert_eq!(
                error, "deploy is switched off in Settings → Tools → Skills.",
                "{harness} {typed}"
            );
            // A name the harness never listed is still unknown.
            let unknown = resolve_with(harness, "/missing", catalog.clone(), &off, installed)
                .err()
                .unwrap();
            assert!(unknown.starts_with("Unknown command /missing"), "{unknown}");
            // Other commands still resolve while the skill is off.
            assert!(resolve_with(harness, "/other", catalog, &off, installed).is_ok());
        }
        // Unrecoverable settings name the reset, as the send guard does.
        let catalog = Catalog {
            commands: vec![native("claude:/deploy", "/deploy", "claude")],
            ..Catalog::default()
        };
        let all = std::collections::BTreeSet::from(["*".into()]);
        let error = resolve_with("claude", "/deploy", catalog, &all, installed)
            .err()
            .unwrap();
        assert!(
            error.contains("could not recover skill settings"),
            "{error}"
        );
    }
    #[test]
    fn slash_skill_switches_resolve_yaml_identity_at_the_explicit_skill_path() {
        let path =
            std::env::temp_dir().join(format!("pandacode-skill-switch-{}", uuid::Uuid::new_v4()));
        std::fs::write(&path, "---\nname: review # comment\n---").unwrap();
        let mut catalog = Catalog::default();
        catalog.commands.push(SlashCommand {
            id: "review".into(),
            name: "/review".into(),
            description: String::new(),
            argument_hint: None,
            kind: "prompt".into(),
            source: String::new(),
            reason: None,
            invocation: Invocation::Skill {
                name: "review # comment".into(),
                path: path.clone(),
            },
        });
        let result = filter(
            "claude",
            catalog,
            &std::collections::BTreeSet::from(["review".into()]),
            || panic!("explicit skill paths need no scan"),
        );
        std::fs::remove_file(path).unwrap();
        assert!(result.commands.is_empty());
    }
    #[test]
    fn slash_skill_switches_filter_explicit_and_native_skill_commands_keep_actions() {
        let disabled = std::collections::BTreeSet::from(["off".into()]);
        let mut catalog = Catalog::default();
        for (name, invocation) in [
            ("/off", Invocation::Native),
            ("/skill:off", Invocation::Native),
            (
                "/alias",
                Invocation::Skill {
                    name: "off".into(),
                    path: PathBuf::from("/skill"),
                },
            ),
            ("/on", Invocation::Native),
            ("/off", Invocation::Action("help".into())),
        ] {
            catalog.commands.push(SlashCommand {
                id: name.into(),
                name: name.into(),
                description: String::new(),
                argument_hint: None,
                kind: "prompt".into(),
                source: String::new(),
                reason: None,
                invocation,
            });
        }
        let installed = || std::collections::BTreeSet::from(["off".into(), "on".into()]);
        let closed = filter(
            "kimi",
            catalog.clone(),
            &std::collections::BTreeSet::from(["*".into()]),
            installed,
        );
        assert_eq!(closed.commands.len(), 1);
        assert!(matches!(
            closed.commands[0].invocation,
            Invocation::Action(_)
        ));
        let filtered = filter("kimi", catalog, &disabled, installed);
        assert_eq!(filtered.commands.len(), 2);
        assert_eq!(filtered.commands[0].name, "/on");
        assert!(matches!(
            filtered.commands[1].invocation,
            Invocation::Action(_)
        ));
    }

    fn native(id: &str, name: &str, source: &str) -> SlashCommand {
        SlashCommand {
            id: id.into(),
            name: name.into(),
            description: String::new(),
            argument_hint: None,
            kind: "prompt".into(),
            source: source.into(),
            reason: None,
            invocation: Invocation::Native,
        }
    }
    #[test]
    fn slash_skill_switches_keep_builtin_and_native_commands_with_a_switched_off_name() {
        let catalog = Catalog {
            commands: vec![
                native("claude:/review", "/review", "claude"),
                native("codex:builtin:compact", "/compact", "Codex"),
                native("claude:/deploy", "/deploy", "claude"),
                native("claude:/my-skill", "/my-skill", "claude"),
                native("deepseek:skill:x", "/ds-skill", "DeepSeek skill · user"),
            ],
            ..Catalog::default()
        };
        let installed = || {
            std::collections::BTreeSet::from(["review".into(), "compact".into(), "my-skill".into()])
        };
        let names = |c: Catalog| c.commands.into_iter().map(|c| c.name).collect::<Vec<_>>();
        let off = std::collections::BTreeSet::from([
            "review".into(),
            "compact".into(),
            "deploy".into(),
            "my-skill".into(),
            "ds-skill".into(),
        ]);
        // Built-ins stay even when a same-named skill is off; a custom command is not a skill.
        assert_eq!(
            names(filter("claude", catalog.clone(), &off, installed)),
            ["/review", "/compact", "/deploy"]
        );
        // Recovery `*` hides skills only, never harness-native commands.
        let all = std::collections::BTreeSet::from(["*".into()]);
        assert_eq!(
            names(filter("claude", catalog.clone(), &all, installed)),
            ["/review", "/compact", "/deploy"]
        );
        // No switch off: nothing is scanned or hidden.
        assert_eq!(
            filter("claude", catalog, &Default::default(), || panic!(
                "no scan without switches"
            ))
            .commands
            .len(),
            5
        );
    }

    #[test]
    fn slash_skill_switches_menu_and_send_guard_agree_on_every_harness() {
        let off = std::collections::BTreeSet::from(["review".into(), "deploy".into()]);
        for (harness, _) in crate::providers::PROVIDERS {
            for (name, installed) in [
                ("review", true),
                ("deploy", true),
                ("deploy", false),
                ("compact", true),
            ] {
                let skills = || {
                    if installed {
                        std::collections::BTreeSet::from([name.to_string()])
                    } else {
                        Default::default()
                    }
                };
                let catalog = Catalog {
                    commands: vec![native(
                        &format!("{harness}:/{name}"),
                        &format!("/{name}"),
                        harness,
                    )],
                    ..Catalog::default()
                };
                let shown = !filter(harness, catalog, &off, skills).commands.is_empty();
                let sendable =
                    crate::skill_manager::check_prompt(harness, &format!("/{name}"), &off, skills)
                        .is_ok();
                assert_eq!(shown, sendable, "{harness} /{name} installed={installed}");
            }
        }
    }
}
