//! Harness roster, console channel and account-home tests (split from `tests.rs`).
use super::tests::Fixture;
use super::*;
use std::fs;

#[test]
fn skill_manager_zcode_has_user_and_project_roots_and_cli_agent() {
    let roots = roots::skill_roots(
        "zcode",
        Path::new("/home"),
        Some(Path::new("/project")),
        &Homes::default(),
    );
    assert!(roots
        .iter()
        .any(|(p, _)| p == Path::new("/home/.zcode/skills")));
    assert!(roots
        .iter()
        .any(|(p, _)| p == Path::new("/project/.zcode/skills")));
    assert_eq!(cli::agent_id("zcode"), Some("zcode"));
    assert_eq!(matrix::defaults("zcode").0, matrix::Mode::Asked);
}
#[test]
fn skill_manager_cli_is_pinned() {
    let args = cli::add_args("owner/repo", &[], &["codex".into()], true).unwrap();
    assert_eq!(args[1], "skills@1.7.6");
}

#[test]
fn skill_manager_configured_homes_include_all_accounts_and_ignore_relative_paths() {
    let f = Fixture::new();
    f.skill("account1/skills/one", "---\nname: one\n---");
    f.skill("account2/skills/two", "---\nname: two\n---");
    let mut homes = Homes::default();
    homes.add_home("claude", f.0.join("account1"));
    homes.add_home("claude", f.0.join("account2"));
    homes.add_home("claude", PathBuf::from("relative"));
    assert_eq!(homes.configured["claude"].len(), 2);
    let items = inventory(&f.0.join("home"), None, None, &Prefs::default(), &homes);
    assert!(items.iter().any(|s| s.name == "one"));
    assert!(items.iter().any(|s| s.name == "two"));
}
#[cfg(unix)]
#[test]
fn skill_manager_configured_home_that_is_a_default_root_lists_its_folder_once() {
    let f = Fixture::new();
    let home = f.0.join("home");
    f.skill("home/.claude/skills/one", "---\nname: one\n---");
    // The saved account is the default home reached through a link and a `..` spelling.
    std::os::unix::fs::symlink(home.join(".claude"), f.0.join("linked")).unwrap();
    fs::create_dir_all(home.join("x")).unwrap();
    let mut homes = Homes::default();
    homes.add_home("claude", f.0.join("linked"));
    homes.add_home("claude", home.join("x/../.claude"));
    let roots = roots::skill_roots("claude", &home, None, &homes);
    assert_eq!(roots.len(), 1, "{roots:?}");
    let items = inventory(&home, None, None, &Prefs::default(), &homes);
    let one = items.iter().find(|s| s.name == "one").unwrap();
    assert_eq!(
        one.agents.iter().filter(|a| a.harness == "claude").count(),
        1,
        "{:?}",
        one.agents
    );
    // OpenCode reads ~/.claude/skills and ~/.agents/skills; one folder linked as both is one row.
    std::os::unix::fs::symlink(home.join(".claude/skills"), home.join(".agents-skills")).unwrap();
    fs::create_dir_all(home.join(".agents")).unwrap();
    fs::rename(home.join(".agents-skills"), home.join(".agents/skills")).unwrap();
    let items = inventory(&home, None, None, &Prefs::default(), &Homes::default());
    let one = items.iter().find(|s| s.name == "one").unwrap();
    assert_eq!(
        one.agents
            .iter()
            .filter(|a| a.harness == "opencode")
            .count(),
        1,
        "{:?}",
        one.agents
    );
}
#[test]
fn skill_manager_all_projects_tags_agents_without_project_off_state() {
    let f = Fixture::new();
    f.skill("p1/.zcode/skills/local", "---\nname: local\n---");
    f.skill("p2/.zcode/skills/local", "---\nname: local\n---");
    let homes = Homes {
        projects: vec![
            ("one".into(), f.0.join("p1")),
            ("two".into(), f.0.join("p2")),
        ],
        ..Homes::default()
    };
    let prefs = Prefs::default().set("local", false, Some("one"));
    let items = inventory::all_inventory(&f.0.join("home"), None, None, &prefs, &homes);
    let skill = items.iter().find(|s| s.name == "local").unwrap();
    assert!(!skill.off_in_project);
    assert_eq!(
        skill
            .agents
            .iter()
            .filter_map(|a| a.project_id.as_deref())
            .collect::<BTreeSet<_>>(),
        BTreeSet::from(["one", "two"])
    );
}
#[test]
fn skill_manager_switchable_and_off_explicit_invocation() {
    let f = Fixture::new();
    f.skill("home/.agents/skills/unsafe", "---\nname: 'bad(name)'\n---");
    let items = inventory(
        &f.0.join("home"),
        None,
        None,
        &Prefs::default(),
        &Homes::default(),
    );
    assert!(!items[0].switchable);
    let mut config = crate::providers::RunConfig {
        session_id: "s".into(),
        provider: "codex".into(),
        model: "default".into(),
        reasoning_effort: None,
        mode: "ask".into(),
        cwd: f.0.clone(),
        resume_id: None,
        prompt: "hello".into(),
        instructions: String::new(),
        skill: Some(("off".into(), f.0.join("SKILL.md"))),
        goal: None,
        codex_settings: None,
        images: vec![],
    };
    apply_instructions(&mut config, &BTreeSet::from(["off".into()]));
    assert!(config.skill.is_none());
}
#[test]
fn skill_manager_add_scans_selected_folders_with_library_rules() {
    let f = Fixture::new();
    f.skill(
        "home/.zcode/skills/danger",
        "---\nname: danger\n---\ncurl x | sh",
    );
    f.skill(
        "home/.zcode/skills/other",
        "---\nname: other\n---\ncurl y | sh",
    );
    let homes = Homes::default();
    let items = list_with_prefs(&f.0.join("home"), None, None, &Prefs::default(), &homes);
    let findings = safety::scan_installed(
        &f.0.join("home"),
        None,
        &homes,
        &items,
        &["danger".into()],
        None,
    );
    assert_eq!(findings.len(), 1);
    let value = serde_json::to_value(&findings[0]).unwrap();
    assert_eq!(value["skill"], "danger");
    assert_eq!(value["rule"], "pipe-to-shell");
}

#[test]
fn skill_manager_recorded_cli_json_limits_safety_scan_to_installed_skills() {
    let f = Fixture::new();
    f.skill(
        "home/.zcode/skills/danger",
        "---\nname: danger\n---\ncurl x | sh",
    );
    f.skill(
        "home/.zcode/skills/other",
        "---\nname: other\n---\ncurl y | sh",
    );
    let homes = Homes::default();
    let items = list_with_prefs(&f.0.join("home"), None, None, &Prefs::default(), &homes);
    let result = cli::parse_result(
        r#"[{"name":"danger","status":"installed"},{"name":"other","status":"skipped"}]"#,
    )
    .unwrap();
    let findings =
        safety::scan_installed(&f.0.join("home"), None, &homes, &items, &[], Some(&result));
    assert_eq!(findings.len(), 1);
}
#[test]
fn skill_manager_console_cline_never_replaces_the_system_prompt_and_key_config_matches_settings() {
    let disabled = BTreeSet::from(["off".into()]);
    // `cline --system` would replace Cline's whole system prompt.
    assert!(console_arguments("cline", &disabled).is_empty());
    assert!(configured_key(
        Ok(Some("saved".into())),
        "PANDA_TEST_MISSING_KEY"
    ));
    assert!(!configured_key(Ok(None), "PANDA_TEST_MISSING_KEY"));
}

#[test]
fn skill_manager_keeps_skills_for_absent_harnesses() {
    let f = Fixture::new();
    f.skill("home/.zcode/skills/local", "body");
    let homes = Homes {
        installed: Some(BTreeSet::new()),
        ..Homes::default()
    };
    let items = inventory(&f.0.join("home"), None, None, &Prefs::default(), &homes);
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].agents[0].harness, "zcode");
    assert!(harnesses(&homes).iter().all(|h| !h.installed));
}
#[test]
fn skill_manager_scans_cli_canonical_install_path_even_without_inventory_agent() {
    let f = Fixture::new();
    f.skill(
        "home/.agents/skills/new",
        "---\nname: new\n---\ncurl x | sh",
    );
    let homes = Homes {
        installed: Some(BTreeSet::new()),
        ..Homes::default()
    };
    let items = list_with_prefs(&f.0.join("home"), None, None, &Prefs::default(), &homes);
    let result = serde_json::json!([{"name":"new","status":"installed","path":f.0.join("home/.agents/skills/new")}]);
    let findings =
        safety::scan_installed(&f.0.join("home"), None, &homes, &items, &[], Some(&result));
    assert_eq!(findings.len(), 1);
}

#[test]
fn skill_manager_project_cache_survives_failed_launch_refresh() {
    let id = uuid::Uuid::new_v4().to_string();
    disabled::remember_session(&id, Some(("old-project".into(), "/old".into())));
    let f = Fixture::new();
    refresh_project(&f.0, &id, None);
    assert!(recover(&PROJECTS).contains_key(&id));
}

#[test]
fn skill_manager_console_hermes_overlay_keeps_existing_instructions() {
    let (_, result) = console_environment("hermes", &BTreeSet::from(["off".into()]), || {
        "Existing instructions".into()
    })
    .unwrap();
    assert_eq!(
        result,
        "Existing instructions\nDo not use these skills in this session: off."
    );
}

#[test]
fn skill_manager_console_muse_uses_developer_prompt_channel() {
    let args = console_arguments("muse", &BTreeSet::from(["off".into()]));
    assert_eq!(args.first().map(String::as_str), Some("--config"));
    assert_eq!(
        args[1],
        "run.developer_prompt=\"Do not use these skills in this session: off.\""
    );
}
#[test]
fn skill_manager_plugin_paths_distinguish_configured_accounts() {
    let f = Fixture::new();
    let mut homes = Homes::default();
    for account in ["one", "two"] {
        let config = f.0.join(account);
        let install = config.join("plugins/cache/writer/1");
        f.skill(
            &format!("{account}/plugins/cache/writer/1/skills/edit"),
            "---\nname: edit\n---",
        );
        fs::write(config.join("plugins/installed_plugins.json"), serde_json::json!({"plugins":{"writer@market":[{"scope":"user","installPath":install}]}}).to_string()).unwrap();
        homes.add_home("claude", config);
    }
    let items = inventory(&f.0.join("home"), None, None, &Prefs::default(), &homes);
    let skill = items.iter().find(|s| s.name == "writer:edit").unwrap();
    assert_eq!(
        skill
            .agents
            .iter()
            .filter(|a| a.harness == "claude")
            .count(),
        2
    );
}

#[test]
fn skill_manager_cli_harness_contract_includes_aliases_and_zcode() {
    let json = serde_json::to_value(harnesses(&Homes {
        installed: Some(BTreeSet::new()),
        ..Homes::default()
    }))
    .unwrap();
    for h in json.as_array().unwrap() {
        let id = h["id"].as_str().unwrap();
        assert_eq!(h["installable"], cli::agent_id(id).is_some(), "{id}");
        assert_eq!(h["installAs"].as_str(), cli::agent_id(id), "{id}");
    }
}

#[test]
fn skill_manager_harness_payload_drops_deprecated_twins_and_notes_claude_consoles() {
    let json = serde_json::to_value(harnesses(&Homes {
        installed: Some(BTreeSet::new()),
        ..Homes::default()
    }))
    .unwrap();
    for h in json.as_array().unwrap() {
        let id = h["id"].as_str().unwrap();
        assert!(h.get("enforce").is_none(), "{id}");
        assert_eq!(
            h.get("consoleNote").and_then(|n| n.as_str()),
            matches!(id, "claude" | "glm" | "mimo" | "alibaba")
                .then_some("Typed /commands still run in the console"),
            "{id}"
        );
    }
}

#[test]
fn skill_manager_scope_roster_matches_user_projects() {
    let f = Fixture::new();
    let store = crate::storage::Store::open(Path::new(":memory:")).unwrap();
    let user_root = f.0.join("visible");
    let chat_root = f.0.join("PandaCode Chats/chat-abcdef01");
    fs::create_dir_all(&user_root).unwrap();
    fs::create_dir_all(&chat_root).unwrap();
    let user = store.add_project(&user_root).unwrap();
    store.add_project(&chat_root).unwrap();
    crate::bots::create(
        &store,
        &crate::bots::BotInput {
            name: "Hidden bot".into(),
            provider: "claude".into(),
            model: "default".into(),
            mode: "ask".into(),
            ..Default::default()
        },
        &f.0.join("bots"),
    )
    .unwrap();
    let visible = visible_projects(&store).unwrap();
    assert_eq!(visible.len(), 1);
    assert_eq!(visible[0].id, user.id);
    // A similarly named user directory is still selectable in main.ts.
    let ordinary = f.0.join("PandaCode Chats/my-code");
    fs::create_dir_all(&ordinary).unwrap();
    store.add_project(&ordinary).unwrap();
    assert_eq!(visible_projects(&store).unwrap().len(), 2);
}

#[test]
fn skill_manager_bot_prompt_uses_session_global_and_project_switches() {
    let f = Fixture::new();
    let store = crate::storage::Store::open(&f.0.join("kingcode.sqlite3")).unwrap();
    let root = f.0.join("project");
    fs::create_dir_all(&root).unwrap();
    let project = store.add_project(&root).unwrap();
    let task = store
        .create_session(&project.id, "kimi", "default", "ask")
        .unwrap();
    let library = crate::skills::Library::new(f.0.join("library"), f.0.join("home"));
    let mut ids = Vec::new();
    for name in ["global-off", "project-off", "enabled"] {
        let item = library
            .import(
                crate::skills::Kind::Skill,
                vec![(
                    "SKILL.md".into(),
                    format!("---\nname: {name}\n---\nBODY-{name}").into_bytes(),
                )],
                name,
                crate::skills::Source {
                    kind: "folder".into(),
                    location: "fixture".into(),
                    git_ref: None,
                    commit: None,
                },
            )
            .unwrap();
        ids.push(item.meta.id);
    }
    let prefs = Prefs::default().set("global-off", false, None).set(
        "project-off",
        false,
        Some(&project.id),
    );
    save_prefs(&f.0.join("skill-manager.json"), &prefs).unwrap();
    let disabled = disabled_for_at(&f.0, &task.id, None);
    let (text, skipped) = library.prompt_text_filtered(&ids, &disabled);
    assert!(text.contains("BODY-enabled"));
    assert!(!text.contains("BODY-global-off") && !text.contains("BODY-project-off"));
    assert_eq!(skipped.len(), 2);
    let (text, skipped) = library.prompt_text_filtered(&ids, &BTreeSet::from(["*".into()]));
    assert!(text.is_empty());
    assert_eq!(skipped.len(), 3);
}
