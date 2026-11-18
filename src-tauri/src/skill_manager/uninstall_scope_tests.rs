//! Tests for which copies `uninstall.rs` may remove at the edges of a scope: Pi's ancestor
//! `.agents/skills` above a monorepo package, and links in projects to a user-level copy.
use super::*;
use crate::skill_manager::tests::Fixture;

/// `repo/` is a repository (it has `.git`); `repo/packages/app` is the project being viewed.
fn monorepo(f: &Fixture) -> PathBuf {
    fs::create_dir_all(f.0.join("repo/.git")).unwrap();
    let project = f.0.join("repo/packages/app");
    fs::create_dir_all(&project).unwrap();
    project
}

#[test]
fn skill_manager_project_uninstall_keeps_the_repository_roots_shared_copy_and_says_why() {
    let f = Fixture::new();
    let home = f.0.join("home");
    let prefs = f.0.join("prefs.json");
    let lock = Mutex::new(());
    let project = monorepo(&f);
    f.skill("repo/.agents/skills/shared", "---\nname: shared\n---\nRoot");
    f.skill(
        "repo/packages/app/.claude/skills/shared",
        "---\nname: shared\n---\nOwn",
    );
    // A sibling package loads the repository root's copy too.
    fs::create_dir_all(f.0.join("repo/packages/web")).unwrap();

    let result = uninstall_with(
        &lock,
        &home,
        Some(&project),
        Some("p1".into()),
        &prefs,
        &Homes::default(),
        "shared",
    )
    .unwrap();
    assert!(!project.join(".claude/skills/shared").exists());
    assert!(
        f.0.join("repo/.agents/skills/shared/SKILL.md").is_file(),
        "the copy siblings share stays"
    );
    let kept = &result.uninstalled.kept;
    assert_eq!(kept.len(), 1, "{kept:?}");
    assert!(
        kept[0].starts_with("../../.agents/skills/shared")
            && kept[0].ends_with(&format!("({SHARED_ABOVE})")),
        "{kept:?}"
    );
    assert_eq!(result.uninstalled.removed.len(), 1);
    assert!(
        !result.uninstalled.switches_cleared,
        "the shared copy still loads here"
    );

    // With only the shared copy left, nothing is moved and the refusal names why.
    let error = uninstall_with(
        &lock,
        &home,
        Some(&project),
        Some("p1".into()),
        &prefs,
        &Homes::default(),
        "shared",
    )
    .unwrap_err();
    assert!(error.contains("shared with other projects"), "{error}");
    assert!(f.0.join("repo/.agents/skills/shared/SKILL.md").is_file());
}

#[cfg(unix)]
#[test]
fn skill_manager_project_uninstall_unlinks_its_link_but_never_moves_a_shared_target_above_it() {
    let f = Fixture::new();
    let home = f.0.join("home");
    let prefs = f.0.join("prefs.json");
    let lock = Mutex::new(());
    let project = monorepo(&f);
    f.skill("repo/.agents/skills/shared", "---\nname: shared\n---\nRoot");
    fs::create_dir_all(project.join(".claude/skills")).unwrap();
    let link = project.join(".claude/skills/shared");
    std::os::unix::fs::symlink(f.0.join("repo/.agents/skills/shared"), &link).unwrap();

    let result = uninstall_with(
        &lock,
        &home,
        Some(&project),
        Some("p1".into()),
        &prefs,
        &Homes::default(),
        "shared",
    )
    .unwrap();
    assert!(
        fs::symlink_metadata(&link).is_err(),
        "the project's link goes"
    );
    assert!(f.0.join("repo/.agents/skills/shared/SKILL.md").is_file());
    assert_eq!(result.uninstalled.removed.len(), 1);
    assert!(result
        .uninstalled
        .kept
        .iter()
        .all(|kept| kept.ends_with(&format!("({SHARED_ABOVE})"))));
}

#[cfg(unix)]
#[test]
fn skill_manager_user_uninstall_unlinks_project_links_to_the_removed_copy_and_undo_relinks_them() {
    let f = Fixture::new();
    let home = f.0.join("home");
    let prefs = f.0.join("prefs.json");
    let lock = Mutex::new(());
    f.skill("home/.agents/skills/tidy", "---\nname: tidy\n---\nBody");
    let project = f.0.join("project");
    fs::create_dir_all(project.join(".claude/skills")).unwrap();
    let link = project.join(".claude/skills/tidy");
    std::os::unix::fs::symlink(home.join(".agents/skills/tidy"), &link).unwrap();
    // A link to something else, and a project's own folder, are left alone.
    f.skill("elsewhere/other", "---\nname: other\n---\nOther");
    let other = project.join(".claude/skills/other");
    std::os::unix::fs::symlink(f.0.join("elsewhere/other"), &other).unwrap();
    let worktree = f.0.join("worktree");
    f.skill("worktree/.claude/skills/tidy", "---\nname: tidy\n---\nOwn");
    let homes = Homes {
        projects: vec![("p1".into(), project.clone())],
        worktrees: vec![("p1".into(), worktree.clone())],
        ..Homes::default()
    };

    let result = uninstall_with(&lock, &home, None, None, &prefs, &homes, "tidy").unwrap();
    assert!(!home.join(".agents/skills/tidy").exists());
    assert!(
        fs::symlink_metadata(&link).is_err(),
        "no dangling link is left in the project"
    );
    assert!(fs::symlink_metadata(&other).is_ok());
    assert!(worktree.join(".claude/skills/tidy/SKILL.md").is_file());
    assert_eq!(
        result.uninstalled.removed.len(),
        2,
        "{:?}",
        result.uninstalled.removed
    );

    undo_with(&lock, &prefs, &result.uninstalled.id).unwrap();
    assert!(home.join(".agents/skills/tidy/SKILL.md").is_file());
    assert_eq!(
        fs::read_link(&link).unwrap(),
        home.join(".agents/skills/tidy"),
        "Undo puts the project's link back"
    );
}

/// A project `app` with one task worktree `wt-1` (outside the project, as PandaCode makes them).
fn with_worktree(f: &Fixture) -> (PathBuf, PathBuf, Homes) {
    let project = f.0.join("app");
    let worktree = f.0.join("worktrees/wt-1");
    fs::create_dir_all(project.join(".git")).unwrap();
    fs::create_dir_all(&worktree).unwrap();
    fs::write(worktree.join(".git"), "gitdir: ../../app/.git/worktrees/wt-1\n").unwrap();
    let homes = Homes {
        worktrees: vec![("p1".into(), worktree.clone())],
        ..Homes::default()
    };
    (project, worktree, homes)
}

#[test]
fn skill_manager_project_uninstall_removes_a_copy_only_in_a_task_worktree_and_undo_restores_it() {
    let f = Fixture::new();
    let home = f.0.join("home");
    let prefs = f.0.join("prefs.json");
    let lock = Mutex::new(());
    let (project, worktree, homes) = with_worktree(&f);
    f.skill("worktrees/wt-1/.claude/skills/tidy", "---\nname: tidy\n---\nWorktree");
    save_prefs(&prefs, &Prefs::default().set("tidy", false, Some("p1"))).unwrap();

    let result = uninstall_with(
        &lock,
        &home,
        Some(&project),
        Some("p1".into()),
        &prefs,
        &homes,
        "tidy",
    )
    .unwrap();
    assert!(!worktree.join(".claude/skills/tidy").exists());
    let uninstalled = &result.uninstalled;
    assert_eq!(
        uninstalled.removed,
        vec!["Worktree wt-1 · .claude/skills/tidy".to_owned()]
    );
    assert!(uninstalled.kept.is_empty(), "{:?}", uninstalled.kept);
    assert!(uninstalled.switches_cleared, "no copy is left in the project");
    assert!(!result.inventory.skills.iter().any(|s| s.name == "tidy" && !s.agents.is_empty()));

    undo_with(&lock, &prefs, &uninstalled.id).unwrap();
    assert!(worktree.join(".claude/skills/tidy/SKILL.md").is_file());
    assert!(read_prefs(&prefs).unwrap().projects["p1"].contains("tidy"));
}

#[cfg(unix)]
#[test]
fn skill_manager_project_uninstall_removes_main_and_worktree_copies_but_not_another_projects() {
    let f = Fixture::new();
    let home = f.0.join("home");
    let prefs = f.0.join("prefs.json");
    let lock = Mutex::new(());
    let (project, worktree, mut homes) = with_worktree(&f);
    f.skill("app/.claude/skills/tidy", "---\nname: tidy\n---\nMain");
    f.skill("worktrees/wt-1/.agents/skills/tidy", "---\nname: tidy\n---\nWorktree");
    // The worktree's Claude root links to its own copy: unlinked, never dangling.
    fs::create_dir_all(worktree.join(".claude/skills")).unwrap();
    let link = worktree.join(".claude/skills/tidy");
    std::os::unix::fs::symlink(worktree.join(".agents/skills/tidy"), &link).unwrap();
    // Another project's worktree with the same folder name is not this project's.
    let other = f.0.join("elsewhere/wt-1");
    f.skill("elsewhere/wt-1/.claude/skills/tidy", "---\nname: tidy\n---\nOther");
    homes.worktrees.push(("p2".into(), other.clone()));

    let result = uninstall_with(
        &lock,
        &home,
        Some(&project),
        Some("p1".into()),
        &prefs,
        &homes,
        "tidy",
    )
    .unwrap();
    assert!(!project.join(".claude/skills/tidy").exists());
    assert!(!worktree.join(".agents/skills/tidy").exists());
    assert!(fs::symlink_metadata(&link).is_err(), "the worktree's link is unlinked");
    assert!(other.join(".claude/skills/tidy/SKILL.md").is_file());
    let removed = &result.uninstalled.removed;
    assert_eq!(removed.len(), 3, "{removed:?}");
    assert!(removed.contains(&".claude/skills/tidy".to_owned()), "{removed:?}");
    assert!(
        removed.contains(&"Worktree wt-1 · .agents/skills/tidy".to_owned()),
        "{removed:?}"
    );
    assert!(result.uninstalled.kept.is_empty());

    undo_with(&lock, &prefs, &result.uninstalled.id).unwrap();
    assert!(project.join(".claude/skills/tidy/SKILL.md").is_file());
    assert!(worktree.join(".agents/skills/tidy/SKILL.md").is_file());
    assert_eq!(fs::read_link(&link).unwrap(), worktree.join(".agents/skills/tidy"));
}
