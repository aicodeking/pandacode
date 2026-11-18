//! Switch saves reuse the last scan; the page reports OpenCode's real state per folder.
use super::tests::Fixture;
use super::*;

fn scans() -> usize {
    inventory::SCANS.with(std::cell::Cell::get)
}

#[test]
fn skill_manager_switch_save_reuses_the_last_scan_without_rescanning_roots() {
    let f = Fixture::new();
    let home = f.0.join("home");
    let path = f.0.join("prefs.json");
    f.skill("home/.agents/skills/review", "---\nname: review\n---\n");
    f.skill("home/.agents/skills/other", "---\nname: other\n---\n");
    list_at(&home, None, None, &path, &Homes::default()).unwrap();
    let before = scans();
    let view = set_counted(&home, None, None, &path, "review", false, &Homes::default()).unwrap();
    assert_eq!(scans(), before, "a save answers from the last scan");
    let review = view.skills.iter().find(|s| s.name == "review").unwrap();
    assert!(review.off_in_panda_code);
    assert!(
        !view
            .skills
            .iter()
            .find(|s| s.name == "other")
            .unwrap()
            .off_in_panda_code
    );
    // A second save keeps using it, with the first save's flags still right.
    let view = set_counted(&home, None, None, &path, "other", false, &Homes::default()).unwrap();
    assert_eq!(scans(), before);
    assert!(view.skills.iter().all(|s| s.off_in_panda_code));
    // Without a remembered scan (an add or project change forgot it), a save scans once.
    scan_cache::forget();
    let view = set_counted(&home, None, None, &path, "review", true, &Homes::default()).unwrap();
    assert_eq!(scans(), before + 1);
    assert!(
        !view
            .skills
            .iter()
            .find(|s| s.name == "review")
            .unwrap()
            .off_in_panda_code
    );
    assert!(
        view.skills
            .iter()
            .find(|s| s.name == "other")
            .unwrap()
            .off_in_panda_code
    );
}

#[test]
fn skill_manager_turning_a_missing_switch_on_from_the_cached_scan_removes_its_row() {
    let f = Fixture::new();
    let home = f.0.join("home");
    let path = f.0.join("prefs.json");
    save_prefs(&path, &Prefs::default().set("gone", false, None)).unwrap();
    let listed = list_at(&home, None, None, &path, &Homes::default()).unwrap();
    assert!(listed.skills.iter().any(|s| s.name == "gone" && s.missing));
    let view = set_counted(&home, None, None, &path, "gone", true, &Homes::default()).unwrap();
    assert!(view.skills.iter().all(|s| s.name != "gone"));
}

#[test]
fn skill_manager_opencode_modes_say_asked_and_none_where_an_agent_cannot_be_listed() {
    let f = Fixture::new();
    let home = f.0.join("home");
    let project = f.0.join("project");
    fs::create_dir_all(project.join(".git")).unwrap();
    f.skill("home/.agents/skills/review", "---\nname: review\n---\n");
    f.skill(
        "home/.agents/skills/friendly",
        "---\nname: Friendly 技能\n---\n",
    );
    let path = f.0.join("prefs.json");
    let opencode = |view: &SkillInventory| {
        let value = serde_json::to_value(view).unwrap();
        let harness = value["harnesses"]
            .as_array()
            .unwrap()
            .iter()
            .find(|h| h["id"] == "opencode")
            .cloned()
            .unwrap();
        let friendly = value["skills"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["name"] == "Friendly 技能")
            .unwrap()["enforcementOverrides"]
            .get("opencode")
            .cloned();
        (harness, friendly)
    };
    let complete = list_at(
        &home,
        Some(&project),
        Some("p".into()),
        &path,
        &Homes::default(),
    )
    .unwrap();
    let (harness, friendly) = opencode(&complete);
    assert_eq!(harness["enforcement"], "blocked");
    assert!(friendly.is_some(), "ask-only names differ from the default");
    // An agent with an unusable name: its denies can't be written, so launches only ask.
    fs::write(project.join("opencode.json"), r#"{"agent":{"":{}}}"#).unwrap();
    let partial = list_at(
        &home,
        Some(&project),
        Some("p".into()),
        &path,
        &Homes::default(),
    )
    .unwrap();
    let (harness, friendly) = opencode(&partial);
    assert_eq!(harness["enforcement"], "asked");
    assert_eq!(harness["consoleEnforcement"], "none");
    assert!(harness["consoleNote"]
        .as_str()
        .unwrap()
        .contains("only asked"));
    assert!(
        friendly.is_none(),
        "every name is asked/none, the harness default here"
    );
    // The switch save answers with the same state.
    let saved = set_counted(
        &home,
        Some(&project),
        Some("p"),
        &path,
        "review",
        false,
        &Homes::default(),
    )
    .unwrap();
    assert_eq!(opencode(&saved).0["enforcement"], "asked");
}

#[test]
fn skill_manager_switch_save_for_a_skill_installed_after_the_last_scan_looks_again() {
    let f = Fixture::new();
    let home = f.0.join("home");
    let path = f.0.join("prefs.json");
    list_at(&home, None, None, &path, &Homes::default()).unwrap();
    f.skill("home/.agents/skills/late", "---\nname: late\n---\n");
    let view = set_counted(&home, None, None, &path, "late", false, &Homes::default()).unwrap();
    assert!(view
        .skills
        .iter()
        .any(|s| s.name == "late" && s.off_in_panda_code));
}
