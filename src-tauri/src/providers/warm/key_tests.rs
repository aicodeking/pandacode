//! The warm key: which launch fields, config files and git metadata it stamps, and why a spare
//! was not adopted.
use super::*;
use super::key::*;
use super::spawn::chain_expired;
use super::test_support::*;

#[test]
fn a_warm_agent_is_used_only_for_the_exact_launch_it_was_started_for() {
    let base = crate::providers::tests::config("claude");
    let tools = vec![json!({"type":"function","name":"pandacode_title"})];
    let original = key(&base, &tools);
    assert!(original.is_some(), "a resolvable config folder is keyed");
    assert_eq!(original, key(&base.clone(), &tools));
    let changed = |edit: fn(&mut RunConfig)| { let mut config = base.clone(); edit(&mut config); key(&config, &tools) };
    for different in [
        changed(|c| c.model = "claude-sonnet-5-5".into()),
        changed(|c| c.mode = "full".into()),
        changed(|c| c.reasoning_effort = Some("high".into())),
        changed(|c| c.resume_id = Some("another".into())),
        changed(|c| c.instructions = "new".into()),
        key(&base, &[]),
        key_with(&base, &tools, "work#1", None),
    ] {
        assert_ne!(different, original);
    }
    // A spare started before the telemetry switch changed is never adopted.
    super::super::privacy::FORCE.with(|force| force.set(Some(true)));
    assert_ne!(key(&base, &tools), original);
    super::super::privacy::FORCE.with(|force| force.set(None));
    // A different named connection, or a saved change to the same one, starts cold.
    for different in [key_with(&base, &tools, "personal#1", None), key_with(&base, &tools, "work#2", None)] {
        assert_ne!(different, key_with(&base, &tools, "work#1", None));
    }
    // Relays, goals and skills always start cold.
    assert!(supported(&base));
    // Relay spares are off (see `supported`).
    assert!(!supported(&crate::providers::tests::config("glm")));
    assert!(!supported(&crate::providers::tests::config("mimo")));
    assert!(!supported(&crate::providers::tests::config("codex")));
    assert!(!supported(&RunConfig { skill: Some(("review".into(), PathBuf::from("/skills/review"))), ..base.clone() }));
}

#[test]
fn turning_the_local_code_explorer_off_starts_the_next_turn_cold() {
    let base = crate::providers::tests::config("claude");
    // What a run sends for each setting: the tool in the catalog and its instruction clause.
    let launch = |enabled: bool| {
        let explore = crate::explore::run_name(false, enabled, &base.provider);
        let tools = if explore.is_some() { crate::explore::catalog() } else { Vec::new() };
        key(&RunConfig { instructions: crate::app_instructions(&crate::app_instructions::InstructionOptions { chat: false, role: crate::Role::Task, explore, tools: false, cloud: false }), ..base.clone() }, &tools).unwrap()
    };
    assert_eq!(launch(true), launch(true));
    assert_ne!(launch(true), launch(false));
    assert!(!launch(false).contains("pandacode_explore"));
}

#[test]
fn switching_modes_changes_only_the_mode_field_of_the_warm_key() {
    // The cached instructions are the same in every mode, so the prompt prefix survives a
    // switch; only the process (whose command line carries the mode) starts cold.
    // Built as the launch builds them, for a run offered agent-made tools.
    let base = RunConfig { session_id: format!("warm-modes-{}", uuid::Uuid::new_v4()), ..crate::providers::tests::config("claude") };
    let launch = |mode: &str| {
        let config = RunConfig { mode: mode.into(), ..base.clone() };
        let instructions = crate::app_instructions::launch_instructions(&config, crate::Role::Task, None, true);
        key(&RunConfig { instructions, ..config }, &[]).unwrap()
    };
    for mode in ["auto", "review", "plan", "full"] {
        assert_eq!(miss(true, &launch("ask"), &launch(mode), false).as_deref(), Some("changed: mode"), "{mode}");
    }
}

#[test]
fn a_first_saved_tool_does_not_change_the_warm_key() {
    // The instructions and the agent-made tool specs are the same whether or not the project
    // has a tool; only the message note (not part of the key) differs.
    let dir = crate::custom_tools::temp();
    let base = crate::providers::tests::config("claude");
    let launch = || {
        let tools = crate::custom_tools::test_host(dir.0.clone(), "project", dir.0.clone(), "warm-tools", "ask").tools;
        let instructions = crate::app_instructions::launch_instructions(&base, crate::Role::Task, None, true);
        key(&RunConfig { instructions, ..base.clone() }, &tools).unwrap()
    };
    let empty = launch();
    crate::custom_tools::test_save(&dir.0, "project", "build-app", "true");
    assert_eq!(launch(), empty);
}

#[test]
fn a_worker_trim_change_starts_the_next_turn_cold() {
    use crate::providers::WorkerTrim;
    let base = crate::providers::tests::config("claude");
    let with = |worker: Option<WorkerTrim>| key(&RunConfig { worker, ..base.clone() }, &[]).unwrap();
    let trims = [
        None,
        Some(WorkerTrim { read_only: false, skills: false, trim: true }),
        Some(WorkerTrim { read_only: true, skills: false, trim: true }),
        Some(WorkerTrim { read_only: false, skills: true, trim: true }),
        Some(WorkerTrim { read_only: false, skills: true, trim: false }),
    ];
    for (i, a) in trims.iter().enumerate() {
        for b in &trims[i + 1..] {
            assert_ne!(with(*a), with(*b), "{a:?} vs {b:?}");
        }
    }
    let missed = miss(true, &with(None), &with(trims[1]), false);
    assert_eq!(missed.as_deref(), Some("changed: worker"));
}

#[test]
fn a_changed_deny_set_starts_the_next_turn_cold() {
    let base = crate::providers::tests::config("claude");
    let with = |denied: Option<&str>| key(&RunConfig { disallowed_tools: denied.map(str::to_owned), ..base.clone() }, &[]).unwrap();
    let (a, b) = ("--disallowedTools=ScheduleWakeup,Monitor,CronCreate", "--disallowedTools=ScheduleWakeup,Monitor,CronCreate,Skill");
    assert_eq!(with(Some(a)), with(Some(a)));
    assert_ne!(with(Some(a)), with(Some(b)));
    assert_ne!(with(None), with(Some(a)));
    assert_eq!(miss(true, &with(Some(a)), &with(Some(b)), false).as_deref(), Some("changed: disallowedTools"));
}

#[test]
fn a_saved_agent_tool_keeps_the_warm_key() {
    // The catalog rides the message note, so saving a tool must not start the next turn cold.
    let base = crate::providers::tests::config("claude");
    let (tools, root) = (crate::custom_tools::temp(), crate::custom_tools::temp());
    let session = format!("warm-{}", uuid::Uuid::new_v4());
    let specs = || crate::custom_tools::test_host(tools.0.clone(), "p1", root.0.clone(), &session, "ask").tools;
    // An empty project is offered the same specs as one with tools: the first save keeps the key.
    let empty = key(&base, &specs()).unwrap();
    crate::custom_tools::test_save(&tools.0, "p1", "build-app", "echo built");
    assert_eq!(key(&base, &specs()).unwrap(), empty, "the first save");
    crate::custom_tools::test_save(&tools.0, "p1", "test-app", "echo tested");
    assert_eq!(key(&base, &specs()).unwrap(), empty, "a later save");
    crate::custom_tools::run_ended(&session);
}

#[test]
fn the_warm_key_reads_only_the_launch_not_the_message() {
    // `lead_spare::tests` compares every `RunConfig` input to these fields between a lead's spare and its wake.
    let base = crate::providers::tests::config("claude");
    let message = RunConfig { prompt: "Review the settled workers.".into(), images: vec![PathBuf::from("/tmp/shot.png")], ..base.clone() };
    assert_eq!(key(&base, &[]), key(&message, &[]));
    let field_names: Vec<String> = match serde_json::from_str::<Value>(&key(&base, &[]).unwrap()).unwrap() {
        Value::Object(fields) => fields.keys().cloned().collect(),
        _ => unreachable!(),
    };
    let mut config_fields = ["provider", "model", "effort", "mode", "cwd", "resume", "instructions", "tools", "fastMode", "worker", "disallowedTools"].map(String::from).to_vec();
    config_fields.extend(["namedConnection", "connection", "environment", "telemetryOff"].map(String::from));
    // Read from the session, provider and cwd, which a lead's spare and its wake share.
    config_fields.extend(["disabledSkills", "executable", "claudeConfig", "gitHead", "stdioMcp"].map(String::from));
    let (mut a, mut b) = (field_names, config_fields);
    a.sort();
    b.sort();
    assert_eq!(a, b, "a new key field must be added to the lead wake test too");
}

#[test]
fn toggling_colab_mcp_starts_the_next_turn_cold() {
    let config = crate::providers::tests::config("claude");
    let none = std::collections::BTreeSet::new();
    let colab = |args: &str| vec![mcp_host::Stdio::new(mcp_host::COLAB_MCP, "/bin/uvx".into(), vec![args.into()])];
    let off = key_with_disabled(&config, &[], "", &none, &[], None).unwrap();
    let on = key_with_disabled(&config, &[], "", &none, &colab("colab-mcp"), None).unwrap();
    assert_ne!(off, on);
    assert_eq!(key_with_disabled(&config, &[], "", &none, &colab("colab-mcp"), None).as_deref(), Some(on.as_str()));
    assert_ne!(key_with_disabled(&config, &[], "", &none, &colab("other"), None).as_deref(), Some(on.as_str()));
    assert_eq!(miss(true, &off, &on, false).as_deref(), Some("changed: stdioMcp"));
}

#[test]
fn a_missed_warm_agent_names_what_changed() {
    let base = crate::providers::tests::config("claude");
    let original = key(&base, &[]).unwrap();
    assert_eq!(miss(true, &original, &original, false), None);
    assert_eq!(miss(false, &original, &original, false).as_deref(), Some("its process exited"));
    assert!(age_expired(IDLE, Some(IDLE), IDLE));
    assert_eq!(miss(true, &original, &original, age_expired(IDLE, Some(IDLE), IDLE)).as_deref(), Some("it expired"));
    // A lifecycle with a shorter idle expires its spares at that idle, not at `IDLE`.
    let short = Duration::from_millis(50);
    assert!(age_expired(short, Some(short), short));
    assert!(!age_expired(Duration::from_millis(10), Some(Duration::from_millis(10)), short));
    assert_eq!(miss(true, &original, &original, age_expired(Duration::from_millis(10), None, short)), None);
    let next = key(&RunConfig { resume_id: Some("another".into()), model: "claude-sonnet-5-5".into(), ..base.clone() }, &[]).unwrap();
    assert_eq!(miss(true, &original, &next, false).as_deref(), Some("changed: model, resume"));
}

#[test]
fn skill_manager_disabled_skills_invalidate_a_warm_launch() {
    let config = crate::providers::tests::config("claude");
    let none = std::collections::BTreeSet::new();
    let disabled = std::collections::BTreeSet::from(["alpha".into()]);
    assert_ne!(key_with_disabled(&config, &[], "", &none, &[], None), key_with_disabled(&config, &[], "", &disabled, &[], None));
}

#[test]
fn claude_config_file_edits_invalidate_a_warm_launch() {
    let cwd = std::env::temp_dir().join(format!("pandacode-warm-config-{}", uuid::Uuid::new_v4().simple()));
    let _cleanup = TempDir(cwd.clone());
    std::fs::create_dir_all(cwd.join(".claude")).unwrap();
    let mut config = crate::providers::tests::config("claude");
    config.cwd = cwd.clone();
    let none = std::collections::BTreeSet::new();
    let key = || key_with_disabled(&config, &[], "", &none, &[], None).unwrap();
    let mut previous = key();
    assert_eq!(previous, key(), "unchanged config files keep the key");
    // Every write changes the byte length, so coarse mtime granularity cannot hide it.
    for (name, contents) in [
        (".mcp.json", "{}"),
        (".mcp.json", r#"{"mcpServers":{}}"#),
        (".claude/settings.json", "{}"),
        (".claude/settings.json", r#"{"model":"x"}"#),
        ("CLAUDE.md", "a"),
        ("CLAUDE.md", "ab"),
    ] {
        std::fs::write(cwd.join(name), contents).unwrap();
        let next = key();
        assert_ne!(next, previous, "writing {name} must start the next turn cold");
        previous = next;
    }
    std::fs::remove_file(cwd.join("CLAUDE.md")).unwrap();
    assert_ne!(key(), previous, "removing CLAUDE.md must start the next turn cold");
}

/// Write `contents` to `root/name`, creating its folders.
fn write_config(root: &Path, name: &str, contents: &str) {
    let path = root.join(name);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, contents).unwrap();
}

#[test]
fn claude_local_memory_rules_agents_and_commands_edits_invalidate_a_warm_launch() {
    let cwd = std::env::temp_dir().join(format!("pandacode-warm-config-dirs-{}", uuid::Uuid::new_v4().simple()));
    let _cleanup = TempDir(cwd.clone());
    std::fs::create_dir_all(cwd.join(".claude")).unwrap();
    let mut config = crate::providers::tests::config("claude");
    config.cwd = cwd.clone();
    let none = std::collections::BTreeSet::new();
    let key = || key_with_disabled(&config, &[], "", &none, &[], None).unwrap();
    let mut previous = key();
    // Every write changes the byte length, so coarse mtime granularity cannot hide it.
    for name in ["CLAUDE.local.md", ".claude/rules/common/style.md", ".claude/agents/reviewer.md", ".claude/commands/check.md"] {
        for contents in ["a", "ab"] {
            write_config(&cwd, name, contents);
            let next = key();
            assert_ne!(next, previous, "writing {name} must start the next turn cold");
            previous = next;
        }
    }
    std::fs::remove_file(cwd.join(".claude/rules/common/style.md")).unwrap();
    assert_ne!(key(), previous, "removing a nested rule must start the next turn cold");
}

#[test]
fn a_named_connections_claude_folder_is_fingerprinted_instead_of_the_global_one() {
    let root = std::env::temp_dir().join(format!("pandacode-warm-connection-{}", uuid::Uuid::new_v4().simple()));
    let _cleanup = TempDir(root.clone());
    let (cwd, global, own, by_env) = (root.join("project"), root.join("global"), root.join("own"), root.join("by-env"));
    for dir in [&cwd, &global, &own, &by_env] {
        std::fs::create_dir_all(dir).unwrap();
    }
    let text = |path: &Path| path.to_string_lossy().into_owned();
    let provider_env = vec![("CLAUDE_CONFIG_DIR".to_string(), text(&global))];
    assert_eq!(claude_config_dir_from(provider_env.clone(), None, &cwd), Some(global.clone()));
    let folder = crate::connections::Connection {
        id: "work".into(),
        provider: "claude".into(),
        name: "Work".into(),
        config_dir: Some(text(&own)),
        ..Default::default()
    };
    assert_eq!(claude_config_dir_from(provider_env.clone(), Some(&folder), &cwd), Some(own.clone()));
    let env = |value: String| std::collections::BTreeMap::from([("CLAUDE_CONFIG_DIR".to_string(), value)]);
    let variable = crate::connections::Connection { config_dir: None, env: env(text(&by_env)), ..folder.clone() };
    assert_eq!(claude_config_dir_from(provider_env.clone(), Some(&variable), &cwd), Some(by_env.clone()));
    // The connection's own folder is applied after its variables, as at launch.
    let both = crate::connections::Connection { env: env(text(&by_env)), ..folder.clone() };
    assert_eq!(claude_config_dir_from(provider_env.clone(), Some(&both), &cwd), Some(own.clone()));
    // A relative folder resolves against the working folder the process starts in.
    let relative = crate::connections::Connection { config_dir: None, env: env("connection-config".into()), ..folder.clone() };
    assert_eq!(claude_config_dir_from(provider_env.clone(), Some(&relative), &cwd), Some(cwd.join("connection-config")));

    let user = claude_config_dir_from(provider_env, Some(&folder), &cwd).unwrap();
    let stamp = || claude_config_fingerprint_with(&cwd, UserConfigRoot::Resolved(&user), None, &[]).unwrap();
    let mut previous = stamp();
    write_config(&global, "settings.json", "{}");
    write_config(&global, "rules/common/rule.md", "a");
    assert_eq!(stamp(), previous, "the global folder is not this connection's");
    for (name, contents) in [("settings.json", "{}"), ("settings.json", "{ }"), ("rules/common/rule.md", "a"), ("rules/common/rule.md", "ab")] {
        write_config(&own, name, contents);
        let next = stamp();
        assert_ne!(next, previous, "writing {name} in the connection's folder must start the next turn cold");
        previous = next;
    }
}

#[cfg(unix)]
#[test]
fn a_config_folder_walk_follows_symlinked_folders_once_and_is_capped() {
    let root = std::env::temp_dir().join(format!("pandacode-warm-walk-{}", uuid::Uuid::new_v4().simple()));
    let _cleanup = TempDir(root.clone());
    let skills = root.join("skills");
    let external = root.join("external");
    std::fs::create_dir_all(skills.join("a")).unwrap();
    write_config(&external, "SKILL.md", "a");
    std::os::unix::fs::symlink(&skills, skills.join("a/loop")).unwrap();
    std::os::unix::fs::symlink(&external, skills.join("linked")).unwrap();
    let paths = |stamp: &Value| -> Vec<String> {
        stamp.as_array().unwrap().iter().filter_map(|item| item.get(0).and_then(Value::as_str).map(str::to_owned)).collect()
    };
    let before = config_dir_stamp(&skills);
    let walked = paths(&before);
    assert!(walked.contains(&"a/loop".to_string()));
    assert!(!walked.iter().any(|path| path.starts_with("a/loop/")), "a link back to a visited folder is not walked: {walked:?}");
    assert!(walked.contains(&"linked/SKILL.md".to_string()), "a symlinked skill folder is walked: {walked:?}");
    write_config(&external, "SKILL.md", "ab");
    assert_ne!(config_dir_stamp(&skills), before, "editing a linked skill in place must start the next turn cold");
    for index in 0..140 {
        std::fs::write(skills.join(format!("f{index:03}.md")), "x").unwrap();
    }
    let capped = config_dir_stamp(&skills);
    assert_eq!(capped.as_array().unwrap().last(), Some(&json!("capped")));
    assert!(capped.as_array().unwrap().len() <= 128 + 2, "the entry cap holds");
    assert_eq!(config_dir_stamp(&skills), capped, "a capped walk is deterministic");
    assert_eq!(config_dir_stamp(&root.join("missing")), Value::Null);
}

#[test]
fn agents_md_ancestor_and_main_checkout_config_edits_invalidate_a_warm_launch() {
    let root = std::env::temp_dir().join(format!("pandacode-warm-roots-{}", uuid::Uuid::new_v4().simple()));
    let _cleanup = TempDir(root.clone());
    let repo = root.join("repo");
    let nested = repo.join("src/deep");
    std::fs::create_dir_all(repo.join(".git")).unwrap();
    std::fs::create_dir_all(&nested).unwrap();
    let user = root.join("user");
    let home = root.join("home/.claude");
    let stamp = |cwd: &Path| claude_config_fingerprint_with(cwd, UserConfigRoot::Resolved(&user), Some(&home), &[]).unwrap();
    let mut previous = stamp(&nested);
    for (name, contents) in [("AGENTS.md", "a"), ("AGENTS.md", "ab"), (".claude/settings.json", "{}"), ("CLAUDE.md", "a")] {
        write_config(&repo, name, contents);
        let next = stamp(&nested);
        assert_ne!(next, previous, "writing the repository root's {name} must start a nested launch cold");
        previous = next;
    }
    write_config(&nested, "AGENTS.md", "a");
    assert_ne!(stamp(&nested), previous, "writing AGENTS.md in the working folder must start the next turn cold");

    for (parent, name) in [
        (&root, "CLAUDE.md"),
        (&root, ".claude/rules/common/rule.md"),
        (&home, "CLAUDE.md"),
        (&home, "rules/common/rule.md"),
    ] {
        write_config(parent, name, "a");
        let before = stamp(&nested);
        write_config(parent, name, "ab");
        assert_ne!(
            stamp(&nested),
            before,
            "writing {parent:?}/{name} must start the next turn cold"
        );
    }

    // A linked worktree inherits configuration from its main checkout.
    let main = root.join("main");
    let gitdir = main.join(".git/worktrees/wt");
    let worktree = root.join("wt");
    std::fs::create_dir_all(&gitdir).unwrap();
    std::fs::create_dir_all(&worktree).unwrap();
    std::fs::write(main.join(".git/config"), "[core]\n bare = false\n").unwrap();
    std::fs::write(gitdir.join("commondir"), "../..\n").unwrap();
    std::fs::write(worktree.join(".git"), format!("gitdir: {}\n", gitdir.display())).unwrap();
    // Only the untracked local settings are inherited, as in `claude_policy.rs`: committed
    // `.claude/` files are in the worktree's own checkout.
    let mut previous = stamp(&worktree);
    for contents in ["{}", "{ }"] {
        write_config(&main, ".claude/settings.local.json", contents);
        let next = stamp(&worktree);
        assert_ne!(next, previous, "writing the main checkout's local settings must start a worktree launch cold");
        previous = next;
    }
    for name in [
        ".claude/settings.json",
        ".claude/rules/rule.md",
        "AGENTS.md",
        "CLAUDE.md",
        "CLAUDE.local.md",
        ".claude/CLAUDE.md",
        ".mcp.json",
    ] {
        write_config(&main, name, "a");
        assert_eq!(
            stamp(&worktree),
            previous,
            "writing the main checkout's {name} must preserve the warm key"
        );
    }
}

#[test]
fn skill_manager_warm_spare_applies_the_same_skill_instructions_as_a_cold_launch() {
    let disabled = std::collections::BTreeSet::from(["Friendly skill".into()]);
    let base = crate::providers::tests::config("claude");
    // Cold path: run_inner applies the reminder, then keys the launch.
    let mut cold = base.clone();
    crate::skill_manager::apply_instructions(&mut cold, &disabled);
    let spare = prepared(base.clone(), &disabled);
    assert!(spare.instructions.contains("Friendly skill"));
    let spare_key = key_with_disabled(&spare, &[], "", &disabled, &[], None).expect("spare warm key");
    let cold_key = key_with_disabled(&cold, &[], "", &disabled, &[], None).expect("cold warm key");
    assert_eq!(spare_key, cold_key);
    // Applying twice (spare prepared, then adopted by run_inner) changes nothing.
    assert_eq!(prepared(spare.clone(), &disabled).instructions, spare.instructions);
    let mut command = Command::new("claude");
    configure_command_with_skills(&mut command, &spare, &disabled);
    let args: Vec<_> = command.as_std().get_args().map(|a| a.to_string_lossy().into_owned()).collect();
    assert!(args.windows(2).any(|a| a[0] == "--append-system-prompt" && a[1].contains("Friendly skill")));
}

#[test]
fn a_dotfiles_repos_own_local_settings_edits_invalidate_a_warm_launch() {
    // A repository rooted at the user's home: its `.claude/` is the user folder, so the project
    // stamps skip it and the user stamps must cover `settings.local.json`.
    let root = std::env::temp_dir().join(format!("pandacode-warm-dotfiles-{}", uuid::Uuid::new_v4().simple()));
    let _cleanup = TempDir(root.clone());
    let repo = root.join("home");
    std::fs::create_dir_all(repo.join(".git")).unwrap();
    std::fs::create_dir_all(repo.join(".claude")).unwrap();
    let user = repo.join(".claude");
    let stamp = || claude_config_fingerprint_with(&repo, UserConfigRoot::Resolved(&user), Some(&user), &[]).unwrap();
    let mut previous = stamp();
    assert_eq!(previous, stamp(), "unchanged config files keep the key");
    for contents in ["{}", "{ }"] {
        write_config(&repo, ".claude/settings.local.json", contents);
        let next = stamp();
        assert_ne!(next, previous, "writing the user folder's settings.local.json must start the next turn cold");
        previous = next;
    }
}

#[test]
fn an_upgraded_claude_binary_changes_the_executable_stamp() {
    let root = std::env::temp_dir().join(format!("pandacode-warm-binary-{}", uuid::Uuid::new_v4().simple()));
    let _cleanup = TempDir(root.clone());
    std::fs::create_dir_all(&root).unwrap();
    let binary = root.join("claude");
    std::fs::write(&binary, "v1").unwrap();
    let stamp = || executable_stamp_for(None, Some(binary.clone()));
    let before = stamp();
    assert_eq!(before, stamp(), "an unchanged binary keeps the key");
    // A different length, so coarse mtime granularity cannot hide the upgrade.
    std::fs::write(&binary, "v2.0").unwrap();
    assert_ne!(stamp(), before, "upgrading the binary in place must start the next turn cold");
    assert_ne!(executable_stamp_for(Some(binary.clone()), Some(binary.clone())), stamp(), "a saved location counts");
    assert_ne!(executable_stamp_for(None, None), stamp(), "a missing binary counts");
    #[cfg(unix)]
    {
        // The native installer moves a link to a new version folder.
        let (old, new, link) = (root.join("v1"), root.join("v2"), root.join("link"));
        std::fs::write(&old, "same").unwrap();
        std::fs::write(&new, "same").unwrap();
        std::os::unix::fs::symlink(&old, &link).unwrap();
        let linked = executable_stamp_for(None, Some(link.clone()));
        std::fs::remove_file(&link).unwrap();
        std::os::unix::fs::symlink(&new, &link).unwrap();
        assert_ne!(executable_stamp_for(None, Some(link.clone())), linked, "a relinked binary must start the next turn cold");
    }
}

#[test]
fn a_named_connections_own_executable_is_stamped_instead_of_the_global_one() {
    let root = std::env::temp_dir().join(format!("pandacode-warm-conn-binary-{}", uuid::Uuid::new_v4().simple()));
    let _cleanup = TempDir(root.clone());
    std::fs::create_dir_all(&root).unwrap();
    let (own, global) = (root.join("claude-work"), root.join("claude"));
    std::fs::write(&own, "v1").unwrap();
    std::fs::write(&global, "global").unwrap();
    let connection = crate::connections::Connection {
        id: "work".into(),
        provider: "claude".into(),
        name: "Work".into(),
        executable: Some(own.to_string_lossy().into_owned()),
        ..Default::default()
    };
    let stamp = |connection: Option<&crate::connections::Connection>| {
        let (saved, resolved) = executable_for(connection, None, || Some(global.clone()));
        executable_stamp_for(saved, resolved)
    };
    assert_eq!(executable_for(Some(&connection), None, || Some(global.clone())), (Some(own.clone()), Some(own.clone())));
    let without = crate::connections::Connection { executable: None, ..connection.clone() };
    assert_eq!(executable_for(Some(&without), None, || Some(global.clone())), (None, Some(global.clone())), "no own executable uses the global one");
    let before = stamp(Some(&connection));
    assert_eq!(before, stamp(Some(&connection)), "an unchanged binary keeps the key");
    assert_ne!(before, stamp(None), "the connection's binary is not the global one");
    let global_before = stamp(None);
    // A different length, so coarse mtime granularity cannot hide the upgrade.
    std::fs::write(&own, "v2.0").unwrap();
    assert_ne!(stamp(Some(&connection)), before, "upgrading the connection's binary in place must start the next turn cold");
    assert_eq!(stamp(None), global_before, "the global binary is unchanged");
}

#[test]
fn an_empty_claude_config_dir_fingerprints_the_cwd_and_home_claude_folders() {
    let root = std::env::temp_dir().join(format!("pandacode-warm-empty-config-{}", uuid::Uuid::new_v4().simple()));
    let _cleanup = TempDir(root.clone());
    let (cwd, home) = (root.join("project"), root.join("home/.claude"));
    std::fs::create_dir_all(&cwd).unwrap();
    std::fs::create_dir_all(&home).unwrap();
    // `CLAUDE_CONFIG_DIR=""` makes Claude Code read user config relative to `cwd`, with legacy
    // paths under `~/.claude`; unset resolves to `~/.claude`.
    let empty = || claude_config_fingerprint_with(&cwd, UserConfigRoot::EmptyConfigDir, Some(&home), &[]).unwrap();
    let unset = || claude_config_fingerprint_with(&cwd, UserConfigRoot::Resolved(&home), Some(&home), &[]).unwrap();
    let mut previous = empty();
    assert_eq!(previous, empty(), "unchanged config files keep the key");
    assert_ne!(previous, unset(), "an empty CLAUDE_CONFIG_DIR never shares a spare with an unset one");
    for (name, contents) in [
        ("settings.json", "{}"),
        ("settings.local.json", "{}"),
        ("skills/a/SKILL.md", "a"),
        ("agents/a.md", "a"),
        ("commands/a.md", "a"),
        ("rules/a.md", "a"),
    ] {
        write_config(&cwd, name, contents);
        let next = empty();
        assert_ne!(next, previous, "writing <cwd>/{name} with an empty CLAUDE_CONFIG_DIR must start the next turn cold");
        previous = next;
    }
    for (name, contents) in [
        ("settings.json", "{}"),
        ("settings.local.json", "{}"),
        ("skills/a/SKILL.md", "a"),
        ("agents/a.md", "a"),
        ("commands/a.md", "a"),
    ] {
        write_config(&home, name, contents);
        let next = empty();
        assert_ne!(next, previous, "writing ~/.claude/{name} with an empty CLAUDE_CONFIG_DIR must start the next turn cold");
        previous = next;
    }
    // Two `<cwd>` and `<home>/.claude` user stamps, under a marker no unset variable carries.
    assert_eq!(previous.first(), Some(&json!("empty-config-dir")));
    assert_eq!(unset().first(), Some(&json!("resolved")));
    assert_eq!(
        claude_config_fingerprint_with(&cwd, UserConfigRoot::EmptyConfigDir, None, &[]),
        None,
        "an empty CLAUDE_CONFIG_DIR with no known home starts no spare"
    );
}

const LEGACY_SECRET_FOLDER_VARIABLES: [&str; 4] = ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "claude_config_dir"];

#[test]
fn an_unresolvable_user_config_folder_is_never_adopted() {
    let root = std::env::temp_dir().join(format!("pandacode-warm-unresolvable-{}", uuid::Uuid::new_v4().simple()));
    let _cleanup = TempDir(root.clone());
    let (cwd, home) = (root.join("project"), root.join("home/.claude"));
    std::fs::create_dir_all(&cwd).unwrap();
    // Saved `HOME=""` makes Node's `os.homedir()` return `""`, so Claude Code reads
    // `<cwd>/.claude` rather than the real home, and a relative `HOME` resolves differently
    // across platforms: the folder is not known for certain, so no spare is keyed.
    assert_eq!(user_config_root(None, false, false), UserConfigRoot::Unresolvable);
    assert_eq!(claude_config_fingerprint_with(&cwd, UserConfigRoot::Unresolvable, Some(&home), &[]), None);
    assert_eq!(claude_config_fingerprint_with(&cwd, UserConfigRoot::Unresolvable, None, &[]), None);
    assert_eq!(claude_config_fingerprint_with(&cwd, UserConfigRoot::EmptyConfigDir, None, &[]), None);
    // A legacy connection keeping a folder variable as a secret is unresolvable whatever the rest says.
    assert_eq!(user_config_root(Some(home.as_path()), false, true), UserConfigRoot::Unresolvable);
    assert_eq!(user_config_root(None, true, true), UserConfigRoot::Unresolvable);
    assert_eq!(user_config_root(None, true, false), UserConfigRoot::EmptyConfigDir);
    assert_eq!(user_config_root(Some(home.as_path()), false, false), UserConfigRoot::Resolved(home.as_path()));
    let base = crate::providers::tests::config("claude");
    let none = std::collections::BTreeSet::new();
    assert!(key_for_connection(&base, &[], "", None, &none, &[], None).is_some(), "the global setup is keyed");
    for name in LEGACY_SECRET_FOLDER_VARIABLES {
        let legacy = legacy_secret_connection(name);
        assert_eq!(claude_config_fingerprint(&base, Some(&legacy)), None, "a legacy secret {name} has no fingerprint");
        assert_eq!(key_for_connection(&base, &[], "legacy#1", Some(&legacy), &none, &[], None), None, "a legacy secret {name} has no warm key");
    }
}

/// A repository's metadata written directly (git is never run), on branch `main`.
fn fake_repo(root: &Path) -> PathBuf {
    let git = root.join(".git");
    std::fs::create_dir_all(git.join("refs/heads")).unwrap();
    std::fs::write(git.join("HEAD"), "ref: refs/heads/main\n").unwrap();
    std::fs::write(git.join("refs/heads/main"), format!("{}\n", "a".repeat(40))).unwrap();
    git
}

#[test]
fn branch_switches_and_commits_change_the_warm_key_but_edits_do_not() {
    let root = std::env::temp_dir().join(format!("warm-git-head-{}", uuid::Uuid::new_v4()));
    let git = fake_repo(&root);
    let config = RunConfig { cwd: root.join("src"), ..crate::providers::tests::config("claude") };
    std::fs::create_dir_all(&config.cwd).unwrap();
    let none = std::collections::BTreeSet::new();
    let key_now = || key_with_disabled(&config, &[], "", &none, &[], None).unwrap();
    let changed = |before: &str, after: &str| miss(true, before, after, false);
    let base = key_now();
    assert_eq!(git_head_stamp(&config.cwd)["head"], "ref: refs/heads/main");
    // Uncommitted edits (and staging) keep the spare.
    std::fs::write(config.cwd.join("lib.rs"), "fn main() {}").unwrap();
    std::fs::write(root.join("README.md"), "edited").unwrap();
    std::fs::write(git.join("index"), "staged").unwrap();
    assert_eq!(key_now(), base, "working-tree edits never change the warm key");
    // A branch switch.
    std::fs::write(git.join("refs/heads/feature"), format!("{}\n", "a".repeat(40))).unwrap();
    std::fs::write(git.join("HEAD"), "ref: refs/heads/feature\n").unwrap();
    let switched = key_now();
    assert_eq!(changed(&base, &switched).as_deref(), Some("changed: gitHead"));
    // A commit moves the branch's loose ref.
    std::fs::write(git.join("refs/heads/feature"), format!("{}\n", "b".repeat(40))).unwrap();
    let committed = key_now();
    assert_eq!(changed(&switched, &committed).as_deref(), Some("changed: gitHead"));
    // A branch kept only in `packed-refs` (after `git pack-refs`), then updated there.
    std::fs::remove_file(git.join("refs/heads/feature")).unwrap();
    std::fs::write(git.join("packed-refs"), format!("{} refs/heads/feature\n", "b".repeat(40))).unwrap();
    let packed = key_now();
    assert_eq!(changed(&committed, &packed).as_deref(), Some("changed: gitHead"));
    std::fs::write(git.join("packed-refs"), format!("# pack-refs with: peeled\n{} refs/heads/feature\n", "c".repeat(40))).unwrap();
    assert_eq!(changed(&packed, &key_now()).as_deref(), Some("changed: gitHead"));
    // A detached HEAD is its commit.
    std::fs::write(git.join("HEAD"), format!("{}\n", "d".repeat(40))).unwrap();
    assert_eq!(git_head_stamp(&config.cwd), json!({"head": "d".repeat(40)}));
    std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn a_linked_worktree_tracks_its_own_head_and_the_shared_branch() {
    let root = std::env::temp_dir().join(format!("warm-git-worktree-{}", uuid::Uuid::new_v4()));
    let git = fake_repo(&root.join("main"));
    let worktree_git = git.join("worktrees").join("feature");
    std::fs::create_dir_all(&worktree_git).unwrap();
    std::fs::write(worktree_git.join("HEAD"), "ref: refs/heads/feature\n").unwrap();
    std::fs::write(worktree_git.join("commondir"), "../..\n").unwrap();
    std::fs::write(git.join("refs/heads/feature"), format!("{}\n", "a".repeat(40))).unwrap();
    let checkout = root.join("feature");
    std::fs::create_dir_all(checkout.join("src")).unwrap();
    std::fs::write(checkout.join(".git"), format!("gitdir: {}\n", worktree_git.display())).unwrap();
    let cwd = checkout.join("src");
    let base = git_head_stamp(&cwd);
    assert_eq!(base["head"], "ref: refs/heads/feature");
    assert_eq!(base["ref"], json!("a".repeat(40)), "the branch is read from the common folder");
    // A commit in the worktree moves the shared branch.
    std::fs::write(git.join("refs/heads/feature"), format!("{}\n", "b".repeat(40))).unwrap();
    let committed = git_head_stamp(&cwd);
    assert_ne!(committed, base);
    // Its own HEAD switching branches changes it too; the main checkout's HEAD does not.
    std::fs::write(git.join("HEAD"), "ref: refs/heads/other\n").unwrap();
    assert_eq!(git_head_stamp(&cwd), committed, "the main checkout's HEAD is not this worktree's");
    std::fs::write(worktree_git.join("HEAD"), "ref: refs/heads/main\n").unwrap();
    assert_eq!(git_head_stamp(&cwd)["ref"], json!("a".repeat(40)));
    // A relative `gitdir:` resolves against the `.git` file's folder.
    std::fs::write(checkout.join(".git"), "gitdir: ../main/.git/worktrees/feature\n").unwrap();
    assert_eq!(git_head_stamp(&cwd)["head"], "ref: refs/heads/main");
    std::fs::remove_dir_all(&root).unwrap();
}


#[test]
fn a_loose_branch_ignores_packed_refs_rewrites() {
    let root = std::env::temp_dir().join(format!("warm-git-loose-{}", uuid::Uuid::new_v4()));
    let _cleanup = TempDir(root.clone());
    let git = fake_repo(&root);
    let base = git_head_stamp(&root);
    assert_eq!(base, json!({"head": "ref: refs/heads/main", "ref": "a".repeat(40)}), "a loose ref never stamps packed-refs");
    // `git fetch --prune` or `git gc` rewrite `packed-refs` while the branch stays loose.
    std::fs::write(git.join("packed-refs"), format!("{} refs/remotes/origin/gone\n", "e".repeat(40))).unwrap();
    assert_eq!(git_head_stamp(&root), base);
    std::fs::write(git.join("packed-refs"), "# pack-refs with: peeled\n").unwrap();
    assert_eq!(git_head_stamp(&root), base, "rewriting packed-refs never refuses a spare on a loose branch");
}

#[test]
fn a_packed_only_branch_falls_back_to_packed_refs_metadata() {
    let root = std::env::temp_dir().join(format!("warm-git-packed-{}", uuid::Uuid::new_v4()));
    let _cleanup = TempDir(root.clone());
    let git = fake_repo(&root);
    std::fs::remove_file(git.join("refs/heads/main")).unwrap();
    std::fs::write(git.join("packed-refs"), format!("{} refs/heads/main\n", "a".repeat(40))).unwrap();
    let packed = git_head_stamp(&root);
    assert_eq!(packed["ref"], Value::Null);
    assert!(packed["packedRefs"].is_array(), "{packed}");
    // A commit on a packed branch rewrites `packed-refs` (a different length here).
    std::fs::write(git.join("packed-refs"), format!("# pack-refs with: peeled\n{} refs/heads/main\n", "b".repeat(40))).unwrap();
    assert_ne!(git_head_stamp(&root), packed);
}

#[test]
fn a_reftable_repository_stamps_its_table_list() {
    let root = std::env::temp_dir().join(format!("warm-git-reftable-{}", uuid::Uuid::new_v4()));
    let _cleanup = TempDir(root.clone());
    let git = root.join(".git");
    std::fs::create_dir_all(git.join("reftable")).unwrap();
    // Reftable repositories keep a placeholder `HEAD`; every ref lives in the tables.
    std::fs::write(git.join("HEAD"), "ref: refs/heads/.invalid\n").unwrap();
    std::fs::write(git.join("reftable/tables.list"), "0x000000000001-0x000000000001-aaaa.ref\n").unwrap();
    let base = git_head_stamp(&root);
    assert!(base.get("reftable").is_some_and(Value::is_array), "{base}");
    assert!(base.get("head").is_none(), "the placeholder HEAD is not the branch: {base}");
    // A commit or branch switch adds a table (a different length here).
    std::fs::write(git.join("reftable/tables.list"), "0x000000000001-0x000000000001-aaaa.ref\n0x000000000002-0x000000000002-bbbb.ref\n").unwrap();
    let committed = git_head_stamp(&root);
    assert_ne!(committed, base, "a reftable change must start the next turn cold");
    let config = RunConfig { cwd: root.clone(), ..crate::providers::tests::config("claude") };
    let none = std::collections::BTreeSet::new();
    let key_now = key_with_disabled(&config, &[], "", &none, &[], None).unwrap();
    std::fs::write(git.join("reftable/tables.list"), "0x000000000003-0x000000000003-cccc.ref\n").unwrap();
    let next = key_with_disabled(&config, &[], "", &none, &[], None).unwrap();
    assert_eq!(miss(true, &key_now, &next, false).as_deref(), Some("changed: gitHead"));
}

#[test]
fn wall_clock_age_expires_a_spare_even_when_its_monotonic_age_is_zero() {
    // A laptop asleep overnight: `Instant` stood still, the wall clock did not.
    assert!(age_expired(Duration::ZERO, Some(IDLE), IDLE));
    assert!(age_expired(Duration::ZERO, Some(IDLE * 50), IDLE));
    assert!(age_expired(IDLE, None, IDLE), "the monotonic clock alone still expires it");
    assert!(age_expired(IDLE, Some(Duration::ZERO), IDLE), "a wall clock set back cannot keep it alive");
    assert!(!age_expired(Duration::ZERO, None, IDLE), "an unreadable wall clock (set back) falls back to the monotonic one");
    assert!(!age_expired(Duration::from_secs(1), Some(Duration::from_secs(1)), IDLE));
    let original = key(&crate::providers::tests::config("claude"), &[]).unwrap();
    assert_eq!(miss(true, &original, &original, true).as_deref(), Some("it expired"));
    assert_eq!(miss(false, &original, &original, true).as_deref(), Some("its process exited"));
}

#[test]
fn a_renewal_chain_is_bounded_on_the_wall_clock() {
    let ago = |windows: u32| std::time::SystemTime::now().checked_sub(IDLE * windows).unwrap();
    assert!(!chain_expired(std::time::SystemTime::now(), IDLE));
    assert!(!chain_expired(ago(MAX_RENEWALS), IDLE), "the last renewal check comes within the chain's windows");
    assert!(chain_expired(ago(1 + MAX_RENEWALS), IDLE), "a chain that slept through its windows stops");
    assert!(!chain_expired(std::time::SystemTime::now() + IDLE, IDLE), "a wall clock set back never ends a chain early");
}

#[test]
fn every_spare_key_carries_the_working_tree_status() {
    let base = crate::providers::tests::config("claude");
    let fields = key_fields(&base, &[]).expect("a resolvable config folder is keyed");
    let stamped = with_git_status(fields.clone(), Some("digest-a"));
    assert!(stamped.contains("gitStatus"), "an ordinary spare's key carries its working tree's status");
    assert_eq!(lead_key(&base, &[], "digest-a").unwrap(), stamped, "a lead's key carries the same stamp");
    let edited = with_git_status(fields, Some("digest-b"));
    assert_eq!(miss(true, &stamped, &edited, false).as_deref(), Some("changed: gitStatus"));
    assert_eq!(miss(true, &stamped, &lead_key(&base, &[], "digest-b").unwrap(), false).as_deref(), Some("changed: gitStatus"));
    // Fields without a stamp (`key`) never match a stamped spare.
    let plain = key(&base, &[]).unwrap();
    assert!(!plain.contains("gitStatus"));
    assert_eq!(miss(true, &plain, &stamped, false).as_deref(), Some("changed: gitStatus"));
}

#[test]
fn a_key_walked_beside_its_git_status_is_byte_identical_to_the_spares_key() {
    let base = crate::providers::tests::config("claude");
    let tools = vec![json!({"type":"function","name":"pandacode_title"})];
    let fields = key_fields(&base, &tools).expect("a resolvable config folder is keyed");
    assert_eq!(with_git_status(fields.clone(), None), key(&base, &tools).unwrap(), "fields without a stamp");
    let lead = lead_key(&base, &tools, "digest-a").unwrap();
    assert_eq!(with_git_status(fields.clone(), Some("digest-a")), lead, "`gitStatus` merged after the walk");
    // The key a spare is spawned (and a lead's renewed) with (`key_with_disabled`).
    let (connection, disabled) = (crate::connections::warm_key(&base.session_id, &base.provider), crate::skill_manager::disabled_for(&base.session_id));
    let spawned = key_with_disabled(&base, &tools, &connection, &disabled, &mcp_host::stdio_servers(&base.session_id), Some("digest-a"));
    assert_eq!(spawned.as_deref(), Some(lead.as_str()));
}

#[tokio::test]
async fn a_git_status_digest_tracks_the_working_tree() {
    let outside = std::env::temp_dir().join(format!("warm-git-status-none-{}", uuid::Uuid::new_v4()));
    let _outside = TempDir(outside.clone());
    std::fs::create_dir_all(&outside).unwrap();
    assert_eq!(git_status(&outside).as_deref(), Some(NOT_GIT), "outside a repository");
    let repo = std::env::temp_dir().join(format!("warm-git-status-{}", uuid::Uuid::new_v4()));
    let _repo = TempDir(repo.clone());
    std::fs::create_dir_all(&repo).unwrap();
    let init = std::process::Command::new("git").args(["init", "-q"]).current_dir(&repo).status().unwrap();
    assert!(init.success());
    let clean = git_status(&repo).expect("a fresh repository's status is known");
    assert_ne!(clean, NOT_GIT);
    assert_eq!(git_status(&repo).as_deref(), Some(clean.as_str()), "an unchanged tree keeps its digest");
    // A new or edited file (a worker's, the user's) changes what Claude Code would snapshot as `gitStatus`.
    std::fs::write(repo.join("new.rs"), "fn main() {}").unwrap();
    let edited = git_status(&repo).unwrap();
    assert_ne!(edited, clean);
    assert_eq!(git_status_digest(&repo).await.as_deref(), Some(edited.as_str()), "the async form reads the same digest");
    // An unreadable repository is unknown, never a stale or "not a repository" digest.
    let broken = repo.join("broken");
    std::fs::create_dir_all(&broken).unwrap();
    std::fs::write(broken.join(".git"), "gitdir: missing\n").unwrap();
    assert_eq!(git_status(&broken), None);
}

/// A fresh repository at a new temp folder, removed when the returned guard drops.
fn init_status_repo(name: &str) -> (PathBuf, TempDir) {
    let repo = std::env::temp_dir().join(format!("warm-git-status-{name}-{}", uuid::Uuid::new_v4()));
    let cleanup = TempDir(repo.clone());
    std::fs::create_dir_all(&repo).unwrap();
    let init = std::process::Command::new("git").args(["init", "-q"]).current_dir(&repo).status().unwrap();
    assert!(init.success());
    (repo, cleanup)
}

#[test]
fn a_file_added_inside_an_untracked_folder_changes_the_git_status_digest() {
    let (repo, _cleanup) = init_status_repo("untracked");
    std::fs::create_dir_all(repo.join("untracked")).unwrap();
    std::fs::write(repo.join("untracked/a.txt"), "a").unwrap();
    let one = git_status(&repo).expect("the status is known");
    // `--untracked-files=normal` would list only `untracked/` both times.
    std::fs::write(repo.join("untracked/b.txt"), "b").unwrap();
    let two = git_status(&repo).expect("the status is known");
    assert_ne!(one, two, "a new file inside an already-untracked folder changes the digest");
}

#[test]
fn a_checkout_with_submodules_has_no_git_status_digest() {
    // `.gitmodules` at the working tree's root, even read from a subfolder.
    let (repo, _cleanup) = init_status_repo("gitmodules");
    let sub = repo.join("src");
    std::fs::create_dir_all(&sub).unwrap();
    assert!(git_status(&sub).is_some(), "a plain checkout's status is known");
    std::fs::write(repo.join(".gitmodules"), "[submodule \"x\"]\n\tpath = x\n\turl = https://example.com/x.git\n").unwrap();
    assert_eq!(git_status(&repo), None, "submodules fail closed");
    assert_eq!(git_status(&sub), None, "submodules fail closed from a subfolder too");
    // A `modules` folder in the git directory.
    let (repo, _cleanup) = init_status_repo("modules");
    assert!(git_status(&repo).is_some(), "a plain checkout's status is known");
    std::fs::create_dir_all(repo.join(".git").join("modules")).unwrap();
    assert_eq!(git_status(&repo), None, "a git directory's submodules fail closed");
}

#[test]
fn a_checkout_with_config_includes_has_no_git_status_digest() {
    let (repo, _cleanup) = init_status_repo("include");
    std::fs::write(repo.join(".git").join("config"), "[include]\n path = missing\n").unwrap();
    assert_eq!(git_status(&repo), None, "even a missing include fails closed");
}

#[test]
fn git_status_allows_binary_and_refuses_root_filter_attributes() {
    let (repo, _cleanup) = init_status_repo("attributes");
    let attributes = repo.join(".gitattributes");
    std::fs::write(&attributes, "*.pdf binary\n").unwrap();
    assert!(git_status(&repo).is_some(), "a binary attribute leaves status available");

    std::fs::write(&attributes, "*.txt filter=g\n").unwrap();
    let subdirectory = repo.join("src");
    std::fs::create_dir(&subdirectory).unwrap();
    assert_eq!(git_status(&repo), None, "a root filter may rely on global configuration");
    assert_eq!(git_status(&subdirectory), None, "a subdirectory probe still checks root attributes");
}

#[cfg(unix)]
#[test]
fn git_status_fails_closed_on_local_content_transforming_clean_filter() {
    use std::process::Command;
    let (repo, _cleanup) = init_status_repo("filter");
    let git = |args: &[&str]| {
        let output = Command::new("git")
            .args(["-c", "user.name=PandaCode", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"])
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .args(args)
            .current_dir(&repo)
            .output()
            .unwrap();
        assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
        output.stdout
    };
    let marker = repo.join(".git").join("filter-ran");
    std::fs::write(repo.join(".gitattributes"), "*.txt filter=norm\n").unwrap();
    git(&["config", "filter.norm.clean", "touch '.git/filter-ran'; tr a-z A-Z"]);
    git(&["config", "filter.norm.required", "true"]);
    let tracked = repo.join("tracked.txt");
    std::fs::write(&tracked, "one\n").unwrap();
    git(&["add", ".gitattributes", "tracked.txt"]);
    git(&["commit", "-q", "-m", "Tracked"]);
    std::fs::remove_file(&marker).unwrap();

    // A case-only edit and a distinct mtime make status hash the file through the filter.
    std::fs::write(&tracked, "One\n").unwrap();
    assert!(Command::new("touch").args(["-t", "200001010000"]).arg(&tracked).status().unwrap().success());
    assert_eq!(git_status(&repo), None, "a transforming filter makes the probe unreliable");
    assert!(!marker.exists(), "no checkout filter ran");
    assert!(git(&["status", "--porcelain"]).is_empty(), "the clean filter normalizes the edit");
    assert!(marker.exists(), "plain status ran the clean filter");
}
