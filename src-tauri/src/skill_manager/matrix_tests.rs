//! Tests for `matrix.rs`.
use super::*;

fn config(provider: &str, prompt: &str) -> crate::providers::RunConfig {
    crate::providers::RunConfig {
        session_id: "skill-guard".into(),
        provider: provider.into(),
        model: "default".into(),
        reasoning_effort: None,
        mode: "ask".into(),
        cwd: std::env::temp_dir(),
        resume_id: None,
        prompt: prompt.into(),
        instructions: String::new(),
        skill: None,
        goal: None,
        codex_settings: None,
        images: Vec::new(),
    }
}

#[test]
fn skill_manager_table_is_the_one_source_for_harness_and_skill_modes() {
    use Mode::*;
    for (id, _) in crate::providers::PROVIDERS {
        let expected = match id {
            "claude" | "glm" | "mimo" | "codex" | "opencode" => (Blocked, Blocked),
            "pi" | "omp" | "grok" | "muse" | "hermes" => (Asked, Asked),
            _ => (Asked, None),
        };
        assert_eq!(defaults(id), expected, "{id}");
        // A harness's console mode is backed by a real console channel.
        let args = console_arguments(id, &BTreeSet::from(["review".into()]));
        let env = console_environment(id, &BTreeSet::from(["review".into()]), String::new);
        let delivered = !args.is_empty() || env.is_some() || id == "opencode";
        assert_eq!(delivered, expected.1 != None, "{id}");
    }
    let friendly = overrides("Friendly 技能");
    let asked = Modes {
        enforcement: Asked,
        console_enforcement: Asked,
    };
    assert_eq!(friendly.get("claude"), Some(&asked));
    assert_eq!(friendly.get("glm"), Some(&asked));
    assert_eq!(friendly.get("mimo"), Some(&asked));
    // OpenCode consoles have no reminder channel: not 'asked'.
    assert_eq!(
        friendly.get("opencode"),
        Some(&Modes {
            enforcement: Asked,
            console_enforcement: None,
        })
    );
    assert_eq!(friendly.len(), 4);
    assert!(overrides("review").is_empty());
    assert!(overrides("bad`name").is_empty());
}

#[test]
fn skill_manager_opencode_console_carries_nothing_for_ask_only_names() {
    let names = BTreeSet::from(["Friendly 技能".into()]);
    assert!(console_arguments("opencode", &names).is_empty());
    assert!(console_environment("opencode", &names, String::new).is_none());
    assert_eq!(rules("opencode").console_mode("Friendly 技能"), Mode::None);
}

#[test]
fn skill_manager_hermes_console_reminder_appends_to_the_existing_prompt() {
    let names = BTreeSet::from(["review".into()]);
    let (key, value) = console_environment("hermes", &names, || "Be brief.".into()).unwrap();
    assert_eq!(key, "HERMES_EPHEMERAL_SYSTEM_PROMPT");
    assert_eq!(
        value,
        "Be brief.\nDo not use these skills in this session: review."
    );
    assert!(console_environment("hermes", &BTreeSet::new(), String::new).is_none());
}

#[test]
fn skill_manager_typed_command_for_a_switched_off_skill_is_refused_on_every_harness() {
    let disabled = BTreeSet::from(["deploy".into(), "review".into(), "plugin:tool".into()]);
    let installed = || {
        BTreeSet::from([
            "deploy".into(),
            "review".into(),
            "plugin:tool".into(),
            "other".into(),
        ])
    };
    for (id, _) in crate::providers::PROVIDERS {
        let refused = check_prompt(id, "  /deploy now", &disabled, installed);
        if id == "codex" {
            assert!(refused.is_ok(), "{id}");
            continue;
        }
        assert_eq!(
            refused.unwrap_err(),
            "deploy is switched off in Settings → Tools → Skills.",
            "{id}"
        );
        assert!(
            check_prompt(id, "/skill:deploy", &disabled, installed).is_err(),
            "{id}"
        );
        assert!(
            check_prompt(id, "/plugin:tool", &disabled, installed).is_err(),
            "{id}"
        );
        assert!(check_prompt(id, "/other", &disabled, installed).is_ok());
        assert!(check_prompt(id, "please /deploy", &disabled, installed).is_ok());
        assert!(check_prompt(id, "/deployment", &disabled, installed).is_ok());
    }
    // Claude's own /review is a built-in, not the switched-off skill.
    assert!(check_prompt("claude", "/review", &disabled, installed).is_ok());
    assert!(check_prompt("kimi", "/review", &disabled, installed).is_err());
    // Unrecoverable settings: refuse installed skills only, never other commands.
    let all = BTreeSet::from(["*".into()]);
    let only = || BTreeSet::from(["deploy".into()]);
    assert!(check_prompt("claude", "/deploy", &all, only)
        .unwrap_err()
        .contains("could not recover"));
    assert!(check_prompt("claude", "/custom", &all, only).is_ok());
}

#[test]
fn skill_manager_typed_command_guard_never_refuses_a_command_that_is_not_an_installed_skill() {
    let disabled = BTreeSet::from(["deploy".into()]);
    // A harness's own custom `/deploy` (no skill of that name installed for it) still runs.
    for id in ["claude", "kimi", "pi", "opencode"] {
        assert!(
            check_prompt(id, "/deploy", &disabled, BTreeSet::new).is_ok(),
            "{id}"
        );
    }
    // Built-ins are never scanned for: they are the harness's, whatever is installed.
    let review = BTreeSet::from(["review".into(), "compact".into()]);
    for builtin in ["/review", "/compact"] {
        assert!(check_prompt("claude", builtin, &review, || panic!("no scan")).is_ok());
    }
    assert!(check_prompt("codex", "/deploy", &disabled, || panic!("no scan")).is_ok());
    // Nothing switched off: nothing is scanned.
    assert!(check_prompt("kimi", "/deploy", &BTreeSet::new(), || panic!("no scan")).is_ok());
}

#[test]
fn skill_manager_claude_family_refuses_an_unprefixed_plugin_skill_when_it_is_unambiguous() {
    let disabled = BTreeSet::from(["plugin:tool".into()]);
    let one = || BTreeSet::from(["plugin:tool".into(), "other".into()]);
    for id in ["claude", "glm", "mimo"] {
        assert_eq!(
            check_prompt(id, "/tool now", &disabled, one).unwrap_err(),
            "plugin:tool is switched off in Settings → Tools → Skills.",
            "{id}"
        );
    }
    // Other harnesses never run `/tool` as the plugin skill.
    for id in ["kimi", "opencode", "pi", "codex"] {
        assert!(
            check_prompt(id, "/tool", &disabled, || panic!("no scan")).is_ok(),
            "{id}"
        );
    }
    // Two plugins answer to `/tool`: Claude needs the prefix, so `/tool` is not the skill.
    let two = || BTreeSet::from(["plugin:tool".into(), "extra:tool".into()]);
    assert!(check_prompt("claude", "/tool", &disabled, two).is_ok());
    // A skill named exactly `tool` (switched on) is what `/tool` runs.
    let exact = || BTreeSet::from(["plugin:tool".into(), "tool".into()]);
    assert!(check_prompt("claude", "/tool", &disabled, exact).is_ok());
    // Built-ins stay the harness's own, whatever plugin skill shares the name.
    let review = BTreeSet::from(["plugin:review".into()]);
    assert!(check_prompt("claude", "/review", &review, || panic!("no scan")).is_ok());
    // Unrecoverable settings refuse the plugin skill too.
    let all = BTreeSet::from(["*".into()]);
    assert!(check_prompt("claude", "/tool", &all, one)
        .unwrap_err()
        .contains("could not recover"));
}

#[test]
fn skill_manager_typed_command_guard_scans_only_when_the_typed_name_could_be_off() {
    let disabled = BTreeSet::from(["deploy".into(), "plugin:tool".into()]);
    for id in ["claude", "kimi", "pi", "opencode"] {
        assert!(
            check_prompt(id, "/other args", &disabled, || panic!("no scan")).is_ok(),
            "{id}"
        );
        assert!(check_prompt(id, "Ship it", &disabled, || panic!("no scan")).is_ok());
    }
    let mut scanned = false;
    let _ = check_prompt("kimi", "/deploy", &disabled, || {
        scanned = true;
        BTreeSet::new()
    });
    assert!(
        scanned,
        "a switched-off name is checked against what is installed"
    );
}

#[test]
fn skill_manager_steered_message_gets_the_same_guard_without_reading_switches_for_plain_text() {
    let disabled = || BTreeSet::from(["deploy".into()]);
    let installed = || BTreeSet::from(["deploy".into()]);
    for id in ["claude", "kimi"] {
        assert_eq!(
            check_session_prompt_with(id, "/deploy", disabled, installed).unwrap_err(),
            "deploy is switched off in Settings → Tools → Skills."
        );
        assert!(check_session_prompt_with(
            id,
            "please deploy",
            || panic!("no switch lookup"),
            || panic!("no scan")
        )
        .is_ok());
    }
}

#[test]
fn skill_manager_opencode_launch_whose_denies_miss_an_agent_asks_for_every_off_skill() {
    let disabled = BTreeSet::from(["review".into()]);
    let mut turn = config("opencode", "Ship it");
    prepare_turn_with(&mut turn, &disabled, |_, _| BTreeSet::new()).unwrap();
    // Blocked by name: no reminder while every agent carries the deny.
    assert!(!turn.prompt.contains("review") && !turn.instructions.contains("review"));
    crate::skill_manager::remind_unenforced(&mut turn, &disabled);
    let carried = format!("{}{}", turn.prompt, turn.instructions);
    assert!(
        carried.contains("Do not use these skills in this session: review."),
        "{carried}"
    );
}

#[test]
fn skill_manager_unrecoverable_settings_send_the_turn_with_the_skills_off_reminder() {
    let all = BTreeSet::from(["*".into()]);
    for provider in ["kimi", "devin", "grok"] {
        let mut turn = config(provider, "Ship it");
        prepare_turn_with(&mut turn, &all, |_, _| BTreeSet::new()).unwrap();
        assert!(
            turn.prompt.contains("Skills are temporarily off"),
            "{provider}"
        );
    }
    for provider in ["pi", "omp"] {
        let mut turn = config(provider, "Ship it");
        prepare_turn_with(&mut turn, &all, |_, _| BTreeSet::new()).unwrap();
        assert!(
            turn.instructions.contains("Skills are temporarily off"),
            "{provider}"
        );
    }
    // Harnesses with an all-skills deny need no reminder.
    let mut turn = config("claude", "Ship it");
    prepare_turn_with(&mut turn, &all, |_, _| BTreeSet::new()).unwrap();
    assert!(turn.instructions.is_empty() && turn.prompt == "Ship it");
}

#[test]
fn skill_manager_slash_prompts_carry_the_reminder_only_when_they_invoke_a_skill() {
    let disabled = BTreeSet::from(["Friendly 技能".into()]);
    let installed = |_: &str, _: &Path| BTreeSet::from(["writer".into()]);
    let reminded = |provider: &str, prompt: &str| {
        let mut turn = config(provider, prompt);
        crate::skill_manager::apply_instructions_with(&mut turn, &disabled, installed);
        turn
    };
    for prompt in ["/skill:writer draft it", "/writer draft it"] {
        let turn = reminded("kimi", prompt);
        assert!(turn.prompt.starts_with(prompt), "{prompt}");
        // On its own trailing line, after the skill's free-text arguments.
        assert!(
            turn.prompt
                .ends_with("\nDo not use these skills in this session: [\"Friendly 技能\"].\n"),
            "{}",
            turn.prompt
        );
    }
    // Custom commands and built-ins keep their arguments untouched.
    for (provider, prompt) in [
        ("kimi", "/deploy now"),
        ("kimi", "/skill:"),
        ("codex", "/writer"),
    ] {
        assert_eq!(
            reminded(provider, prompt).prompt,
            prompt,
            "{provider} {prompt}"
        );
    }
    assert_eq!(
        reminded("claude", "/review").prompt,
        "/review",
        "a system channel carries it instead"
    );
    assert!(reminded("claude", "/review")
        .instructions
        .contains("Friendly"));
    // A built-in is never scanned for.
    let mut turn = config("claude", "/compact");
    crate::skill_manager::remind(&mut turn, &disabled, |_, _| panic!("no scan"));
}

#[test]
fn skill_manager_matrix_fixture_matches_the_native_table() {
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/skill-matrix.json");
    let homes = Homes {
        installed: Some(BTreeSet::new()),
        ..Homes::default()
    };
    // The IPC's own serialization, minus what depends on this computer.
    let rows: Vec<String> = crate::skill_manager::harnesses(&homes)
        .iter()
        .map(|harness| {
            let mut value = serde_json::to_value(harness).unwrap();
            let object = value.as_object_mut().unwrap();
            let id = object.remove("id").unwrap();
            object.remove("installed");
            object.remove("installable");
            format!("  {id}: {value}")
        })
        .collect();
    let expected = format!("{{\n{}\n}}\n", rows.join(",\n"));
    if std::env::var_os("UPDATE_SKILL_MATRIX").is_some() {
        fs::create_dir_all(fixture.parent().unwrap()).unwrap();
        fs::write(&fixture, &expected).unwrap();
    }
    let committed = fs::read_to_string(&fixture).unwrap_or_default();
    assert!(
        committed == expected,
        "tests/fixtures/skill-matrix.json is out of date with skill_manager/matrix.rs; regenerate it with UPDATE_SKILL_MATRIX=1 cargo test skill_manager_matrix_fixture"
    );
}

#[test]
fn skill_manager_cline_console_reports_none_because_system_replaces_the_prompt() {
    let names = BTreeSet::from(["review".into()]);
    assert!(console_arguments("cline", &names).is_empty());
    assert_eq!(defaults("cline"), (Mode::Asked, Mode::None));
}

#[test]
fn skill_manager_claude_family_consoles_note_that_typed_commands_still_run() {
    for (id, _) in crate::providers::PROVIDERS {
        let expected = matches!(id, "claude" | "glm" | "mimo")
            .then_some("Typed /commands still run in the console");
        assert_eq!(console_note(id), expected, "{id}");
    }
}

#[test]
fn skill_manager_send_path_refuses_a_switched_off_command_before_sending() {
    let disabled = BTreeSet::from(["deploy".into()]);
    for provider in ["claude", "opencode", "kimi", "pi"] {
        let installed = |harness: &str, _: &Path| {
            assert_eq!(harness, provider, "the scan is for this harness");
            BTreeSet::from(["deploy".into()])
        };
        let mut turn = config(provider, "/deploy staging");
        let error = prepare_turn_with(&mut turn, &disabled, installed).unwrap_err();
        assert_eq!(
            error,
            "deploy is switched off in Settings → Tools → Skills."
        );
        let mut allowed = config(provider, "/compact");
        assert!(
            prepare_turn_with(&mut allowed, &disabled, installed).is_ok(),
            "{provider}"
        );
        let mut plain = config(provider, "Ship it");
        prepare_turn_with(&mut plain, &disabled, installed).unwrap();
    }
}

#[test]
fn skill_manager_turn_with_a_switched_off_attached_skill_is_refused_not_dropped() {
    let disabled = BTreeSet::from(["deploy".into()]);
    let mut turn = config("codex", "Ship it");
    turn.skill = Some(("deploy".into(), "/missing/SKILL.md".into()));
    let error = prepare_turn_with(&mut turn, &disabled, |_, _| BTreeSet::new()).unwrap_err();
    assert_eq!(
        error,
        "deploy is switched off in Settings → Tools → Skills."
    );
    // Its SKILL.md name counts too, as the composer menu matches it.
    let dir = std::env::temp_dir().join(format!("pandacode-attached-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("SKILL.md"), "---\nname: deploy\n---\n").unwrap();
    let mut alias = config("codex", "Ship it");
    alias.skill = Some(("Deploy helper".into(), dir.join("SKILL.md")));
    let error = prepare_turn_with(&mut alias, &disabled, |_, _| BTreeSet::new()).unwrap_err();
    std::fs::remove_dir_all(&dir).unwrap();
    assert_eq!(
        error,
        "deploy is switched off in Settings → Tools → Skills."
    );
    // Unrecoverable settings refuse it with the reset prompt.
    let mut all = config("codex", "Ship it");
    all.skill = Some(("review".into(), "/missing/SKILL.md".into()));
    let error = prepare_turn_with(&mut all, &BTreeSet::from(["*".into()]), |_, _| {
        BTreeSet::new()
    })
    .unwrap_err();
    assert!(
        error.contains("could not recover skill settings"),
        "{error}"
    );
    // An attached skill that is on still runs.
    let mut on = config("codex", "Ship it");
    on.skill = Some(("review".into(), "/missing/SKILL.md".into()));
    prepare_turn_with(&mut on, &disabled, |_, _| BTreeSet::new()).unwrap();
    assert!(on.skill.is_some());
}
