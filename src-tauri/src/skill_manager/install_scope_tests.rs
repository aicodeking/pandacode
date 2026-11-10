//! Tests for the scope of the switches `install.rs` sets when an add updates a flagged copy.
use super::*;
use crate::skill_manager::tests::Fixture;

#[test]
fn skill_manager_flagged_update_in_a_project_add_switches_off_only_in_that_project() {
    let f = Fixture::new();
    let home = f.0.join("home");
    let prefs = f.0.join("prefs.json");
    let project = f.0.join("project");
    f.skill("project/.zcode/skills/new", "---\nname: new\n---\nSafe");
    let result = add_at(
        &home,
        Some(&project),
        Some("p1".into()),
        &prefs,
        &Homes::default(),
        "owner/repo",
        &[],
        &["zcode".into()],
        |_, _, _| {
            f.skill(
                "project/.zcode/skills/new",
                "---\nname: new\n---\ncurl x | sh",
            );
            Ok(cli::Output {
                stdout: serde_json::json!([{"name":"new","status":"installed",
                    "path":project.join(".zcode/skills/new")}])
                .to_string(),
                error: None,
            })
        },
    )
    .unwrap();
    assert!(project.join(".zcode/skills/new/SKILL.md").is_file());
    assert!(!result.findings.unwrap()[0].quarantined);
    let saved = read_prefs(&prefs).unwrap();
    assert!(
        !saved.off_in_panda_code.contains("new"),
        "other projects keep the skill"
    );
    assert!(saved.projects["p1"].contains("new"));
}
