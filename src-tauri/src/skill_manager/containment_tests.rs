//! Tests for the skill-root containment in `safety.rs`.
use super::*;
use crate::skill_manager::tests::Fixture;
use std::os::unix::fs::symlink;

fn real(path: PathBuf) -> PathBuf {
    fs::canonicalize(path).unwrap()
}

#[test]
fn skill_manager_project_skill_roots_linked_out_of_the_project_are_not_known() {
    let f = Fixture::new();
    let home = f.0.join("home");
    let project = f.0.join("project");
    f.skill("home/notes", "private");
    f.skill("outside/skills/x", "elsewhere");
    fs::create_dir_all(project.join(".claude")).unwrap();
    fs::create_dir_all(project.join(".cline/skills")).unwrap();
    // .claude/skills → ~ ; .agents → a folder whose skills/ lies outside the project.
    symlink(&home, project.join(".claude/skills")).unwrap();
    symlink(f.0.join("outside"), project.join(".agents")).unwrap();
    let roots = known_roots(&home, Some(&project), &Homes::default());
    assert!(!roots.contains(&real(home.clone())), "{roots:?}");
    assert!(
        !roots.contains(&real(f.0.join("outside/skills"))),
        "{roots:?}"
    );
    assert!(roots.iter().all(|r| !home.starts_with(r)), "{roots:?}");
    assert!(
        roots.contains(&real(project.join(".cline/skills"))),
        "{roots:?}"
    );
    // So nothing under ~ can be removed through the linked root.
    assert!(check_inside_roots(&project.join(".claude/skills/notes"), &roots).is_err());
    assert!(remove_folders(
        &BTreeSet::from([project.join(".claude/skills/notes")]),
        &roots
    )
    .is_err());
    assert!(home.join("notes/SKILL.md").is_file());
}

#[test]
fn skill_manager_user_skill_roots_may_still_be_links() {
    let f = Fixture::new();
    let home = f.0.join("home");
    fs::create_dir_all(f.0.join("dotfiles/skills")).unwrap();
    fs::create_dir_all(home.join(".claude")).unwrap();
    symlink(f.0.join("dotfiles/skills"), home.join(".claude/skills")).unwrap();
    let roots = known_roots(&home, None, &Homes::default());
    assert!(
        roots.contains(&real(f.0.join("dotfiles/skills"))),
        "{roots:?}"
    );
}

#[test]
fn skill_manager_containment_accepts_only_direct_entries_of_a_root() {
    let f = Fixture::new();
    f.skill("root/direct", "x");
    f.skill("root/group/nested", "x");
    let roots = BTreeSet::from([real(f.0.join("root"))]);
    check_inside_roots(&f.0.join("root/direct"), &roots).unwrap();
    assert!(check_inside_roots(&f.0.join("root/group/nested"), &roots).is_err());
    assert!(remove_inside_roots(&f.0.join("root/group/nested"), &roots).is_err());
    assert!(f.0.join("root/group/nested/SKILL.md").is_file());
    // A link entry is direct even when its target is elsewhere; only the link goes.
    f.skill("elsewhere", "keep");
    symlink(f.0.join("elsewhere"), f.0.join("root/alias")).unwrap();
    remove_inside_roots(&f.0.join("root/alias"), &roots).unwrap();
    assert!(f.0.join("elsewhere/SKILL.md").is_file());
}
