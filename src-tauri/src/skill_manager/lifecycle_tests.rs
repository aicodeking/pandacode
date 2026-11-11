//! Quarantine and restore, switches left for removed skills, Pi ancestors and worktree roots.
use super::tests::Fixture;
use super::*;

fn flagged_install(f: &Fixture, home: &Path, prefs: &Path) -> SkillInventory {
    install::add_at(
        home,
        None,
        None,
        prefs,
        &Homes::default(),
        "owner/repo",
        &[],
        &["zcode".into()],
        |_, _, _| {
            f.skill("home/.zcode/skills/new", "---\nname: new\n---\ncurl x | sh");
            Ok(cli::Output {
                stdout: serde_json::json!([{"name":"new","status":"installed",
                    "path":home.join(".zcode/skills/new")}])
                .to_string(),
                error: None,
            })
        },
    )
    .unwrap()
}

#[test]
fn skill_manager_flagged_install_is_quarantined_listed_and_restored_on_request() {
    let f = Fixture::new();
    let home = f.0.join("home");
    let prefs = f.0.join("app/skill-manager.json");
    let folder = home.join(".zcode/skills/new");
    let result = flagged_install(&f, &home, &prefs);
    // No agent can load it: the folder left every skill root for app data.
    assert!(!folder.exists());
    assert!(
        fs::read_dir(f.0.join("app/skill-quarantine"))
            .unwrap()
            .count()
            == 1
    );
    let row = result.skills.iter().find(|s| s.name == "new").unwrap();
    let json = serde_json::to_value(row).unwrap();
    assert_eq!(json["quarantined"], true);
    assert_eq!(json["agents"][0]["path"], "~/.zcode/skills/new");
    let listed = list_at(&home, None, None, &prefs, &Homes::default()).unwrap();
    assert!(listed
        .skills
        .iter()
        .any(|s| s.name == "new" && s.quarantined));
    // "Turn on anyway" moves it back where it was installed.
    let restored = restore_at(
        &Mutex::new(()),
        &home,
        None,
        None,
        &prefs,
        &Homes::default(),
        "new",
    )
    .unwrap();
    assert!(folder.join("SKILL.md").is_file());
    let row = restored.skills.iter().find(|s| s.name == "new").unwrap();
    assert!(!row.quarantined && !row.off_in_panda_code);
    assert!(serde_json::to_value(row)
        .unwrap()
        .get("quarantined")
        .is_none());
    assert!(restore_at(
        &Mutex::new(()),
        &home,
        None,
        None,
        &prefs,
        &Homes::default(),
        "new"
    )
    .is_err());
}

#[test]
fn skill_manager_restore_never_overwrites_a_folder_that_took_its_place() {
    let f = Fixture::new();
    let home = f.0.join("home");
    let prefs = f.0.join("app/skill-manager.json");
    flagged_install(&f, &home, &prefs);
    f.skill("home/.zcode/skills/new", "---\nname: new\n---\nmine");
    assert!(restore_at(
        &Mutex::new(()),
        &home,
        None,
        None,
        &prefs,
        &Homes::default(),
        "new"
    )
    .is_err());
    let text = fs::read_to_string(home.join(".zcode/skills/new/SKILL.md")).unwrap();
    assert!(text.contains("mine"));
    // The quarantined copy is kept for a later attempt.
    assert!(quarantine::names(&prefs).contains("new"));
}

#[test]
fn skill_manager_updated_preexisting_folder_is_switched_off_not_moved() {
    let f = Fixture::new();
    let home = f.0.join("home");
    let prefs = f.0.join("prefs.json");
    f.skill("home/.zcode/skills/new", "---\nname: new\n---\nSafe");
    let result = flagged_install(&f, &home, &prefs);
    assert!(home.join(".zcode/skills/new/SKILL.md").is_file());
    assert!(!result.findings.unwrap()[0].quarantined);
    assert!(read_prefs(&prefs)
        .unwrap()
        .off_in_panda_code
        .contains("new"));
}

#[test]
fn skill_manager_switches_for_removed_skills_are_listed_and_can_be_cleared() {
    let f = Fixture::new();
    let home = f.0.join("home");
    let path = f.0.join("prefs.json");
    let homes = Homes {
        projects: vec![("p".into(), f.0.join("p"))],
        ..Homes::default()
    };
    save_prefs(
        &path,
        &Prefs::default()
            .set("gone", false, None)
            .set("gone", false, Some("p")),
    )
    .unwrap();
    let listed = list_at(&home, None, None, &path, &homes).unwrap();
    let json = serde_json::to_value(&listed.skills).unwrap();
    assert_eq!(json[0]["name"], "gone");
    assert_eq!(json[0]["missing"], true);
    assert_eq!(json[0]["offInPandaCode"], true);
    assert_eq!(json[0]["agents"], serde_json::json!([]));
    // Turning a removed skill off is refused; turning it on clears every switch for it.
    assert!(set_at(&home, None, None, &path, "gone", false, &homes).is_err());
    let items = set_at(&home, None, None, &path, "gone", true, &homes).unwrap();
    assert!(items.is_empty());
    assert_eq!(read_prefs(&path).unwrap(), Prefs::default());
    assert!(set_at(&home, None, None, &path, "never-saved", true, &homes).is_err());
}

#[test]
fn skill_manager_ask_only_reminder_skips_slash_command_turns() {
    let disabled = BTreeSet::from(["review".into()]);
    let config = |provider: &str, prompt: &str| crate::providers::RunConfig {
        session_id: "slash".into(),
        provider: provider.into(),
        model: "default".into(),
        reasoning_effort: None,
        mode: "ask".into(),
        cwd: PathBuf::from("/tmp"),
        resume_id: None,
        prompt: prompt.into(),
        instructions: String::new(),
        skill: None,
        goal: None,
        codex_settings: None,
        images: Vec::new(),
    };
    for prompt in ["/compact", "  /review src"] {
        let mut slash = config("kimi", prompt);
        apply_instructions(&mut slash, &disabled);
        assert_eq!(slash.prompt, prompt);
    }
    let mut plain = config("kimi", "Fix the tests");
    apply_instructions(&mut plain, &disabled);
    assert!(plain.prompt.contains("Do not use these skills"));
    // System-prompt harnesses keep it: it never reaches the typed command.
    let mut pi = config("pi", "/compact");
    apply_instructions(&mut pi, &disabled);
    assert_eq!(pi.prompt, "/compact");
    assert!(pi.instructions.contains("Do not use these skills"));
}

#[test]
fn skill_manager_consoles_without_a_system_channel_report_no_enforcement() {
    let homes = Homes {
        installed: Some(BTreeSet::new()),
        ..Homes::default()
    };
    let list = harnesses(&homes);
    let console = |id: &str| {
        list.iter()
            .find(|h| h.id == id)
            .unwrap()
            .console_enforcement
    };
    assert_eq!(console("devin"), Mode::None);
    assert_eq!(console("github-copilot"), Mode::None);
    assert_eq!(console("opencode"), Mode::Blocked);
    assert_eq!(console("pi"), Mode::Asked);
}

#[test]
fn skill_manager_pi_project_scope_includes_ancestor_agent_skills_up_to_the_repo_root() {
    let f = Fixture::new();
    let repo = f.0.join("repo");
    let project = repo.join("packages/app");
    fs::create_dir_all(repo.join(".git")).unwrap();
    fs::create_dir_all(&project).unwrap();
    f.skill(
        "repo/.agents/skills/from-root",
        "---\nname: from-root\n---\n",
    );
    f.skill(
        "repo/packages/.agents/skills/from-parent",
        "---\nname: from-parent\n---\n",
    );
    f.skill(".agents/skills/above-repo", "---\nname: above-repo\n---\n");
    for harness in ["pi", "omp"] {
        let roots = roots::skill_roots(
            harness,
            &f.0.join("home"),
            Some(&project),
            &Homes::default(),
        );
        assert!(
            roots
                .iter()
                .any(|(p, label)| *p == repo.join(".agents/skills")
                    && label == "../../.agents/skills")
        );
        assert!(roots
            .iter()
            .any(|(p, _)| *p == repo.join("packages/.agents/skills")));
        assert!(!roots.iter().any(|(p, _)| *p == f.0.join(".agents/skills")));
    }
    let items = inventory(
        &f.0.join("home"),
        Some(&project),
        Some("p"),
        &Prefs::default(),
        &Homes::default(),
    );
    let root = items.iter().find(|s| s.name == "from-root").unwrap();
    assert!(root
        .agents
        .iter()
        .all(|a| matches!(a.harness.as_str(), "pi" | "omp") && a.scope == "project"));
    assert!(!items.iter().any(|s| s.name == "above-repo"));
    // Without a repository above the project, Pi reads no ancestors.
    let lone = f.0.join("lone/app");
    fs::create_dir_all(&lone).unwrap();
    let roots = roots::skill_roots("pi", &f.0.join("home"), Some(&lone), &Homes::default());
    assert!(!roots.iter().any(|(_, label)| label.starts_with("../")));
}

#[test]
fn skill_manager_worktree_only_project_skills_are_listed_for_their_project() {
    let f = Fixture::new();
    let home = f.0.join("home");
    f.skill("main/.agents/skills/shared", "---\nname: shared\n---\n");
    f.skill(
        "wt/feature/.claude/skills/branch-only",
        "---\nname: branch-only\n---\n",
    );
    let homes = Homes {
        projects: vec![("p".into(), f.0.join("main"))],
        worktrees: vec![
            ("p".into(), f.0.join("wt/feature")),
            ("other".into(), f.0.join("wt/other")),
        ],
        ..Homes::default()
    };
    let all = inventory::with_counts(&home, None, None, &Prefs::default(), &homes).0;
    let skill = all.iter().find(|s| s.name == "branch-only").unwrap();
    assert!(skill.agents.iter().all(|a| a.scope == "project"
        && a.project_id.as_deref() == Some("p")
        && a.path == "Worktree feature · .claude/skills/branch-only"));
    let project = inventory::with_counts(
        &home,
        Some(&f.0.join("main")),
        Some("p"),
        &Prefs::default(),
        &homes,
    )
    .0;
    assert!(project.iter().any(|s| s.name == "branch-only"));
    let other = inventory::with_counts(
        &home,
        Some(&f.0.join("x")),
        Some("x"),
        &Prefs::default(),
        &homes,
    )
    .0;
    assert!(!other.iter().any(|s| s.name == "branch-only"));
}
