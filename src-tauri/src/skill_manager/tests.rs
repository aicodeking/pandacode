use super::*;
use std::fs;

pub(super) struct Fixture(pub(super) PathBuf);
impl Fixture {
    pub(super) fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("pandacode-skill-manager-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
    pub(super) fn skill(&self, path: &str, text: &str) {
        let path = self.0.join(path);
        fs::create_dir_all(&path).unwrap();
        fs::write(path.join("SKILL.md"), text).unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn inventory_groups_frontmatter_names_and_keeps_project_scope_separate() {
    let f = Fixture::new();
    f.skill(
        "home/.claude/skills/folder",
        "---\nname: shared\ndescription: >-\n  First line\n  second line\n---\nBody",
    );
    f.skill(
        "home/.agents/skills/alias",
        "---\nname: shared\ndescription: Shared description\n---",
    );
    f.skill("project/.agents/skills/local", "No frontmatter");
    let home = f.0.join("home");
    let project = f.0.join("project");
    let prefs = Prefs::default()
        .set("shared", false, None)
        .set("local", false, Some("project-id"));
    let items = inventory(
        &home,
        Some(&project),
        Some("project-id"),
        &prefs,
        &Homes::default(),
    );
    let shared = items.iter().find(|s| s.name == "shared").unwrap();
    assert!(shared.off_in_panda_code);
    assert!(!shared.off_in_project);
    assert!(shared
        .agents
        .iter()
        .any(|a| a.harness == "claude" && a.path == "~/.claude/skills/folder"));
    assert!(shared
        .agents
        .iter()
        .any(|a| a.harness == "codex" && a.path == "~/.agents/skills/alias"));
    assert!(
        shared.description.contains("description")
            || shared.description == "First line second line"
    );
    assert_eq!(items.iter().filter(|s| s.name == "shared").count(), 1);
    let local = items.iter().find(|s| s.name == "local").unwrap();
    assert!(local.off_in_project);
    assert!(local
        .agents
        .iter()
        .all(|a| a.scope == "project" && a.path == ".agents/skills/local"));
    let global = inventory(&home, None, None, &prefs, &Homes::default());
    assert!(!global.iter().any(|s| s.name == "local"));
    assert!(global.iter().all(|s| !s.off_in_project));
}

#[cfg(unix)]
#[test]
fn inventory_follows_symlinks_and_reads_nested_skill_collections_with_a_cap() {
    let f = Fixture::new();
    f.skill("target", "---\nname: linked\ndescription: Link\n---");
    fs::create_dir_all(f.0.join("home/.codex/skills/.system")).unwrap();
    std::os::unix::fs::symlink(f.0.join("target"), f.0.join("home/.codex/skills/link")).unwrap();
    f.skill(
        "home/.codex/skills/.system/nested",
        "---\nname: nested\n---",
    );
    f.skill("home/.codex/skills/huge", &"x".repeat(256 * 1024 + 1));
    let items = inventory(
        &f.0.join("home"),
        None,
        None,
        &Prefs::default(),
        &Homes::default(),
    );
    assert!(items.iter().any(|s| s.name == "linked"));
    assert!(items.iter().any(|s| s.name == "nested"));
    assert!(items.iter().any(|s| s.name == "huge"));
}

#[test]
fn prefs_updates_are_immutable_atomic_and_scoped_to_project_id() {
    let f = Fixture::new();
    let project = f.0.join("checkout");
    let path = f.0.join("skill-manager.json");
    let original = Prefs::default();
    let prefs = original
        .set("global", false, None)
        .set("local", false, Some("project-id"));
    assert_eq!(original, Prefs::default());
    save_prefs(&path, &prefs).unwrap();
    assert_eq!(read_prefs(&path).unwrap(), prefs);
    assert_eq!(
        prefs.disabled(Some("project-id"), Some(&project)),
        BTreeSet::from(["global".into(), "local".into()])
    );
    assert_eq!(
        prefs.disabled(Some("other-id"), Some(&f.0.join("other"))),
        BTreeSet::from(["global".into()])
    );
    let enabled = prefs
        .set("global", true, None)
        .set("local", true, Some("project-id"));
    assert!(enabled
        .disabled(Some("project-id"), Some(&project))
        .is_empty());
    assert!(enabled.projects.is_empty());
    fs::write(&path, b"broken").unwrap();
    assert!(read_prefs(&path).is_err());
    assert_eq!(fs::read_dir(&f.0).unwrap().count(), 2);
}

#[test]
fn claude_arg_merges_without_losing_session_bound_tools_or_duplicates() {
    let disabled = BTreeSet::from(["alpha".into(), "beta".into()]);
    assert_eq!(
        claude_disallowed("ScheduleWakeup,Monitor,CronCreate,Skill(alpha)", &disabled),
        "ScheduleWakeup,Monitor,CronCreate,Skill(alpha),Skill(beta)"
    );
    assert_eq!(
        claude_disallowed(
            crate::providers::CLAUDE_SESSION_BOUND_TOOLS,
            &BTreeSet::new()
        ),
        crate::providers::CLAUDE_SESSION_BOUND_TOOLS
    );
}

#[test]
fn validates_sources_and_names_before_cli_arguments_or_instructions() {
    for source in [
        "owner/repo",
        "owner/repo/skills/foo",
        "https://github.com/owner/repo/tree/main/skills",
        "https://gitlab.com/group/repo",
        "notion",
        "https://skills.sh/vercel-labs/agent-skills/web-design",
    ] {
        assert!(validate_source(source).is_ok(), "{source}");
    }
    for source in [
        "",
        "-g",
        "--help",
        "a b",
        "a\nb",
        "$(id)",
        "a;b",
        "a&b",
        "a|b",
        "a`id`",
        "a>b",
        "a<b",
        "a'",
        "a\"",
        "a\\b",
        "../repo",
        "a/../b",
        "http://github.com/a/b",
        "https://evil.example/a/b",
        "https://github.com@evil.example/a/b",
        "https://gith\nub.com/a/b",
        "https://github.com\t/a/b",
    ] {
        assert!(validate_source(source).is_err(), "{source}");
    }
    for name in [
        "alpha",
        "web-design",
        "documents:documents",
        "a_b.v2",
        "Friendly 技能",
        "a/b",
        "a;cmd",
        "..",
    ] {
        assert!(validate_name(name).is_ok());
    }
    for name in ["", "-a", "a,b", "a(b)", "a\nb", "*", "a`b", "<b>"] {
        assert!(validate_name(name).is_err(), "{name}");
    }
}

#[test]
fn soft_instructions_are_idempotent_on_resumes_and_claude_uses_only_tools() {
    let disabled = BTreeSet::from(["alpha".into(), "beta".into()]);
    for provider in ["codex", "kimi", "pi", "claude", "glm", "mimo"] {
        let mut config = crate::providers::RunConfig {
            session_id: "fixture".into(),
            provider: provider.into(),
            model: "default".into(),
            reasoning_effort: None,
            mode: "ask".into(),
            cwd: PathBuf::from("/fixture"),
            resume_id: None,
            prompt: String::new(),
            instructions: String::new(),
            skill: None,
            goal: None,
            codex_settings: None,
            images: Vec::new(),
        };
        config.resume_id = Some("existing".into());
        config.prompt = "User prompt".into();
        config.instructions = "App instructions".into();
        apply_instructions(&mut config, &disabled);
        apply_instructions(&mut config, &disabled);
        let all = format!("{}{}", config.prompt, config.instructions);
        assert_eq!(
            all.matches("Do not use these skills in this session: alpha, beta.")
                .count(),
            usize::from(!matrix::rules(provider).blocks("alpha"))
        );
        assert!(config.prompt.starts_with("User prompt"));
        assert!(config.instructions.starts_with("App instructions"));
    }
}

#[test]
fn inventory_reads_cli_source_from_scope_lock_files() {
    let f = Fixture::new();
    f.skill("home/.agents/skills/foo", "---\nname: foo\n---");
    f.skill("project/.agents/skills/bar", "---\nname: bar\n---");
    fs::write(
        f.0.join("home/.agents/.skill-lock.json"),
        r#"{"skills":{"foo":{"source":"owner/repo"}}}"#,
    )
    .unwrap();
    fs::write(
        f.0.join("project/skills-lock.json"),
        r#"{"skills":{"bar":{"source":"other/repo"}}}"#,
    )
    .unwrap();
    let items = inventory(
        &f.0.join("home"),
        Some(&f.0.join("project")),
        Some("project-id"),
        &Prefs::default(),
        &Homes::default(),
    );
    assert_eq!(
        items
            .iter()
            .find(|s| s.name == "foo")
            .unwrap()
            .source
            .as_deref(),
        Some("owner/repo")
    );
    assert_eq!(
        items
            .iter()
            .find(|s| s.name == "bar")
            .unwrap()
            .source
            .as_deref(),
        Some("other/repo")
    );
}

#[test]
fn project_id_switches_apply_when_the_task_uses_a_distinct_worktree() {
    let f = Fixture::new();
    let main = f.0.join("main");
    let worktree = f.0.join("worktree");
    fs::create_dir_all(&main).unwrap();
    fs::create_dir_all(&worktree).unwrap();
    let prefs = Prefs {
        projects: BTreeMap::from([("project-id".into(), BTreeSet::from(["local".into()]))]),
        ..Prefs::default()
    };
    let store = crate::storage::Store::open(Path::new(":memory:")).unwrap();
    let project = store.add_project(&main).unwrap();
    let task = store
        .create_session(&project.id, "claude", "default", "ask")
        .unwrap();
    let task = store
        .create_worktree_session_on(&task, &worktree, None)
        .unwrap();
    assert_ne!(task.worktree_path.as_deref(), Some(project.path.as_str()));
    let prefs = Prefs {
        projects: BTreeMap::from([(project.id, prefs.projects["project-id"].clone())]),
        ..prefs
    };
    assert_eq!(
        disabled_for_session(&prefs, &store.db, &task.id),
        BTreeSet::from(["local".into()])
    );
}

#[test]
fn unreadable_settings_have_a_clear_error_for_the_ui() {
    let f = Fixture::new();
    let path = f.0.join("skill-manager.json");
    {
        let text = "broken";
        fs::write(&path, text).unwrap();
        assert!(read_prefs(&path)
            .unwrap_err()
            .starts_with("Skill settings file is unreadable:"));
    }
}

#[test]
fn existing_skill_names_with_spaces_and_unicode_can_be_saved() {
    let f = Fixture::new();
    let path = f.0.join("skill-manager.json");
    let prefs = Prefs::default().set("Friendly 技能", false, None);
    save_prefs(&path, &prefs).unwrap();
    assert_eq!(read_prefs(&path).unwrap(), prefs);
}

#[test]
fn inventory_attributes_shared_roots_to_known_harnesses_even_when_absent() {
    let f = Fixture::new();
    f.skill("home/.agents/skills/shared", "---\nname: shared\n---");
    f.skill("project/.agents/skills/local", "---\nname: local\n---");
    let homes = Homes {
        installed: Some(BTreeSet::from(["codex".into()])),
        ..Homes::default()
    };
    let items = inventory(
        &f.0.join("home"),
        Some(&f.0.join("project")),
        Some("p"),
        &Prefs::default(),
        &homes,
    );
    for skill in items {
        assert!(skill.agents.iter().any(|a| a.harness == "codex"));
        assert!(skill.agents.iter().any(|a| a.harness == "kimi"));
    }
}

#[test]
fn inventory_includes_registered_claude_plugins_with_namespaces() {
    let f = Fixture::new();
    let install = f.0.join("home/.claude/plugins/cache/market/writer/1.2.3");
    f.skill(
        "home/.claude/plugins/cache/market/writer/1.2.3/skills/edit",
        "---\nname: edit\ndescription: Edit prose\n---",
    );
    fs::write(
        f.0.join("home/.claude/plugins/installed_plugins.json"),
        serde_json::json!({
            "version": 2, "plugins": {"writer@market": [{"scope": "user", "installPath": install}]}
        })
        .to_string(),
    )
    .unwrap();
    let items = inventory(
        &f.0.join("home"),
        None,
        None,
        &Prefs::default(),
        &Homes::default(),
    );
    let skill = items
        .iter()
        .find(|s| s.name == "writer:edit")
        .expect("registered plugin skill");
    assert_eq!(skill.source.as_deref(), Some("writer"));
    assert!(skill
        .agents
        .iter()
        .any(|a| a.harness == "claude" && a.scope == "user"));
    assert_eq!(
        claude_disallowed("", &BTreeSet::from([skill.name.clone()])),
        "Skill(writer:edit)"
    );
}

#[test]
fn launch_blocks_skills_without_history_and_inventory_reports_corrupt_settings() {
    let f = Fixture::new();
    let path = f.0.join("skill-manager.json");
    let home = f.0.join("home");
    f.skill("home/.agents/skills/foo", "---\nname: foo\n---");
    {
        let text = "broken";
        fs::write(&path, text).unwrap();
        assert_eq!(
            launch_prefs(&path).off_in_panda_code,
            BTreeSet::from(["*".into()])
        );
        assert!(list_at(&home, None, None, &path, &Homes::default())
            .unwrap()
            .prefs_error
            .unwrap()
            .starts_with("Skill settings file is unreadable:"));
        assert!(
            set_at(&home, None, None, &path, "foo", false, &Homes::default())
                .unwrap_err()
                .starts_with("Skill settings file is unreadable:")
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), text);
    }
    fs::remove_file(&path).unwrap();
    fs::create_dir(&path).unwrap();
    assert_eq!(
        launch_prefs(&path).off_in_panda_code,
        BTreeSet::from(["*".into()])
    );
    assert!(read_prefs(&path)
        .unwrap_err()
        .starts_with("Skill settings file is unreadable:"));
}

#[test]
fn set_requires_an_installed_name_and_migrates_main_checkout_preferences() {
    let f = Fixture::new();
    let home = f.0.join("home");
    let main = f.0.join("main");
    fs::create_dir_all(&main).unwrap();
    let path = f.0.join("skill-manager.json");
    for name in [
        "Friendly 技能",
        "-unsafe",
        "bad,name",
        "bad(name)",
        "bad\nname",
    ] {
        f.skill(
            &format!("home/.agents/skills/{}", uuid::Uuid::new_v4()),
            &format!("---\nname: '{name}'\n---"),
        );
    }
    let legacy = Prefs {
        projects: BTreeMap::from([(
            checkout_key(&main),
            BTreeSet::from(["Friendly 技能".into()]),
        )]),
        ..Prefs::default()
    };
    save_prefs(&path, &legacy).unwrap();
    assert!(legacy
        .disabled(Some("project-id"), Some(&main))
        .contains("Friendly 技能"));
    set_at(
        &home,
        Some(&main),
        Some("project-id"),
        &path,
        "Friendly 技能",
        true,
        &Homes::default(),
    )
    .unwrap();
    assert!(read_prefs(&path).unwrap().projects.is_empty());
    set_at(
        &home,
        Some(&main),
        Some("project-id"),
        &path,
        "Friendly 技能",
        false,
        &Homes::default(),
    )
    .unwrap();
    let prefs = read_prefs(&path).unwrap();
    assert!(prefs.projects["project-id"].contains("Friendly 技能"));
    assert!(!prefs.projects.contains_key(&checkout_key(&main)));
    assert!(set_at(
        &home,
        None,
        None,
        &path,
        "missing",
        false,
        &Homes::default()
    )
    .is_err());
    for name in ["-unsafe", "bad,name", "bad(name)", "bad\nname"] {
        assert!(
            set_at(&home, None, None, &path, name, false, &Homes::default())
                .unwrap_err()
                .starts_with("This skill name can't be switched")
        );
    }
    assert_eq!(read_prefs(&path).unwrap(), prefs);
}

#[test]
fn inventory_honours_injected_claude_home_for_skills_and_plugins() {
    let f = Fixture::new();
    f.skill("custom-claude/skills/custom", "---\nname: custom\n---");
    f.skill(
        "home/.claude/skills/default-only",
        "---\nname: default-only\n---",
    );
    f.skill(
        "custom-claude/plugins/cache/market/writer/1/skills/edit",
        "---\nname: edit\n---",
    );
    let config = f.0.join("custom-claude");
    fs::write(config.join("plugins/installed_plugins.json"), serde_json::json!({
        "version": 2, "plugins": {"writer@market": [{"scope": "user", "installPath": config.join("plugins/cache/market/writer/1")}]}
    }).to_string()).unwrap();
    let homes = Homes {
        claude: Some(config),
        ..Homes::default()
    };
    let items = inventory(&f.0.join("home"), None, None, &Prefs::default(), &homes);
    let custom = items.iter().find(|s| s.name == "custom").unwrap();
    for harness in ["claude", "glm", "mimo", "alibaba"] {
        assert!(custom.agents.iter().any(|a| a.harness == harness
            && a.scope == "user"
            && a.path == "$CLAUDE_CONFIG_DIR/skills/custom"));
        assert!(!items
            .iter()
            .any(|s| s.name == "default-only" && s.agents.iter().any(|a| a.harness == harness)));
    }
    let plugin = items.iter().find(|s| s.name == "writer:edit").unwrap();
    assert_eq!(plugin.source.as_deref(), Some("writer"));
    assert!(plugin.agents.iter().any(|a| a.harness == "claude"));
}

#[test]
fn skill_manager_keeps_invalid_stored_names_off_without_losing_valid_preferences() {
    let f = Fixture::new();
    let path = f.0.join("skill-manager.json");
    fs::write(
        &path,
        r#"{"offInPandaCode":["valid","bad(name)"],"projects":{"p":["other","-bad"]}}"#,
    )
    .unwrap();
    let prefs = read_prefs(&path).unwrap();
    // Fail closed: names today's policy refuses stay off and are reported, never dropped.
    assert_eq!(
        prefs.off_in_panda_code,
        BTreeSet::from(["valid".into(), "bad(name)".into()])
    );
    assert_eq!(
        prefs.projects["p"],
        BTreeSet::from(["other".into(), "-bad".into()])
    );
    assert_eq!(prefs.invalid_names(), 2);
}
