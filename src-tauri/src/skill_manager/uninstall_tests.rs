//! Tests for `uninstall.rs`.
use super::*;
use crate::skill_manager::tests::Fixture;

fn off(prefs: &Path) -> Prefs {
    read_prefs(prefs).unwrap()
}

#[cfg(unix)]
#[test]
fn skill_manager_uninstall_moves_user_copies_aside_unlinks_links_and_undo_puts_them_back() {
    let f = Fixture::new();
    let home = f.0.join("home");
    let prefs = f.0.join("prefs.json");
    let lock = Mutex::new(());
    f.skill("home/.agents/skills/tidy", "---\nname: tidy\n---\nBody");
    fs::create_dir_all(home.join(".claude/skills")).unwrap();
    let link = home.join(".claude/skills/tidy");
    std::os::unix::fs::symlink(home.join(".agents/skills/tidy"), &link).unwrap();
    f.skill("home/.claude/skills/other", "---\nname: other\n---\nKeep");
    // A project copy is another scope: a user-level uninstall leaves it.
    f.skill(
        "project/.claude/skills/tidy",
        "---\nname: tidy\n---\nProject",
    );
    save_prefs(&prefs, &Prefs::default().set("tidy", false, None)).unwrap();

    let result =
        uninstall_with(&lock, &home, None, None, &prefs, &Homes::default(), "tidy").unwrap();
    assert!(fs::symlink_metadata(&link).is_err(), "the link is unlinked");
    assert!(
        !home.join(".agents/skills/tidy").exists(),
        "the copy is moved aside"
    );
    assert!(f.0.join("project/.claude/skills/tidy/SKILL.md").is_file());
    assert!(home.join(".claude/skills/other/SKILL.md").is_file());
    assert!(!result
        .inventory
        .skills
        .iter()
        .any(|s| s.name == "tidy" && !s.agents.is_empty()));
    let uninstalled = &result.uninstalled;
    assert!(uninstalled.switches_cleared && uninstalled.kept.is_empty());
    assert_eq!(uninstalled.removed.len(), 2, "{:?}", uninstalled.removed);
    assert!(!off(&prefs).off_in_panda_code.contains("tidy"));
    let kept = store_dir(&prefs).join(&uninstalled.id);
    assert!(fs::read_dir(&kept)
        .unwrap()
        .flatten()
        .any(|e| e.path().join("SKILL.md").is_file()));
    let value = serde_json::to_value(&result).unwrap();
    assert_eq!(value["uninstalled"]["id"], uninstalled.id.as_str());
    assert!(
        value["skills"].is_array(),
        "the inventory is flattened beside `uninstalled`"
    );

    // Undo refuses to replace anything that appeared at an original path.
    fs::create_dir_all(home.join(".agents/skills/tidy")).unwrap();
    assert_eq!(
        undo_with(&lock, &prefs, &uninstalled.id).unwrap_err(),
        OCCUPIED
    );
    fs::remove_dir(home.join(".agents/skills/tidy")).unwrap();
    undo_with(&lock, &prefs, &uninstalled.id).unwrap();
    assert!(home.join(".agents/skills/tidy/SKILL.md").is_file());
    assert_eq!(
        fs::read_link(&link).unwrap(),
        home.join(".agents/skills/tidy")
    );
    assert!(
        off(&prefs).off_in_panda_code.contains("tidy"),
        "the cleared switch is set again"
    );
    assert!(!kept.exists());
    assert!(
        undo_with(&lock, &prefs, &uninstalled.id).is_err(),
        "an undo runs once"
    );
}

#[test]
fn skill_manager_uninstall_in_a_project_removes_only_its_copies_and_clears_switches_when_none_remain(
) {
    let f = Fixture::new();
    let home = f.0.join("home");
    let project = f.0.join("project");
    let prefs = f.0.join("prefs.json");
    let lock = Mutex::new(());
    f.skill("project/.claude/skills/lint", "---\nname: lint\n---\nx");
    f.skill("project/.claude/skills/both", "---\nname: both\n---\nx");
    f.skill("home/.claude/skills/both", "---\nname: both\n---\nx");
    let saved = Prefs::default()
        .set("lint", false, Some("p1"))
        .set("both", false, Some("p1"));
    save_prefs(&prefs, &saved).unwrap();
    let uninstall = |name: &str| {
        uninstall_with(
            &lock,
            &home,
            Some(&project),
            Some("p1".into()),
            &prefs,
            &Homes::default(),
            name,
        )
    };

    let lint = uninstall("lint").unwrap();
    assert!(!project.join(".claude/skills/lint").exists());
    assert!(lint.uninstalled.switches_cleared);
    assert!(!off(&prefs)
        .projects
        .get("p1")
        .is_some_and(|n| n.contains("lint")));

    // The user-level copy still loads in this project, so its switch stays.
    let both = uninstall("both").unwrap();
    assert!(!project.join(".claude/skills/both").exists());
    assert!(home.join(".claude/skills/both/SKILL.md").is_file());
    assert!(!both.uninstalled.switches_cleared);
    assert!(off(&prefs).projects["p1"].contains("both"));
    // Nothing of `both` is left in the project's own roots.
    assert_eq!(
        uninstall("both").unwrap_err(),
        "PandaCode found no copy of this skill it can remove here."
    );
    assert!(uninstall("missing")
        .unwrap_err()
        .contains("no longer installed"));
}

#[cfg(unix)]
#[test]
fn skill_manager_uninstall_removes_owned_account_links_and_keeps_the_users_own_copies() {
    let f = Fixture::new();
    let home = f.0.join("home");
    let prefs = f.0.join("prefs.json");
    let lock = Mutex::new(());
    let mut homes = Homes::default();
    homes.add_home("codex", f.0.join("mine"));
    homes.add_home("codex", f.0.join("linked"));
    f.skill("home/.agents/skills/acct", "---\nname: acct\n---\nx");
    f.skill("mine/skills/acct", "---\nname: acct\n---\nmine");
    let record = serde_json::json!({"name":"acct","status":"installed","path":home.join(".agents/skills/acct")});
    let (failures, written) = accounts::link(&home, &homes, "codex", &[record], &prefs);
    assert!(failures.is_empty() && written.len() == 1, "{failures:?}");
    let owned = f.0.join("linked/skills/acct");
    assert!(fs::symlink_metadata(&owned)
        .unwrap()
        .file_type()
        .is_symlink());

    let result = uninstall_with(&lock, &home, None, None, &prefs, &homes, "acct").unwrap();
    assert!(
        fs::symlink_metadata(&owned).is_err(),
        "PandaCode's own link goes"
    );
    assert!(!home.join(".agents/skills/acct").exists());
    assert_eq!(
        fs::read_to_string(f.0.join("mine/skills/acct/SKILL.md")).unwrap(),
        "---\nname: acct\n---\nmine",
        "the user's own copy in an account home stays"
    );
    assert_eq!(
        result.uninstalled.kept.len(),
        1,
        "{:?}",
        result.uninstalled.kept
    );
    assert!(!result.uninstalled.switches_cleared, "a copy is left");
}

#[test]
fn skill_manager_uninstall_and_undo_refuse_while_an_install_runs() {
    let f = Fixture::new();
    let home = f.0.join("home");
    let prefs = f.0.join("prefs.json");
    f.skill("home/.claude/skills/busy", "---\nname: busy\n---\nx");
    let lock = Mutex::new(());
    let held = lock.lock().unwrap();
    let error = uninstall_with(&lock, &home, None, None, &prefs, &Homes::default(), "busy");
    assert_eq!(error.err().as_deref(), Some(BUSY));
    assert_eq!(
        undo_with(&lock, &prefs, "00000000-0000-0000-0000-000000000000").unwrap_err(),
        BUSY
    );
    assert!(home.join(".claude/skills/busy/SKILL.md").is_file());
    drop(held);
    uninstall_with(&lock, &home, None, None, &prefs, &Homes::default(), "busy").unwrap();
    assert!(!home.join(".claude/skills/busy").exists());
}

#[test]
fn skill_manager_uninstall_reports_older_uninstalls_whose_undo_expired_at_the_file_limit() {
    let f = Fixture::new();
    let home = f.0.join("home");
    let prefs = f.0.join("prefs.json");
    let lock = Mutex::new(());
    // An older uninstall whose record nearly fills the file limit, with its kept copy.
    let old_id = "11111111-1111-1111-1111-111111111111";
    let item = |i: usize| Item {
        original: f.0.join(i.to_string()),
        stored: Some(i.to_string()),
        link: None,
        put_back: false,
    };
    let old = |count: usize| {
        vec![Record {
            id: old_id.into(),
            name: "old".into(),
            project_id: None,
            items: (0..count).map(item).collect(),
            cleared_all: false,
            cleared_projects: Vec::new(),
            removed_at: 1,
        }]
    };
    let size = |records: &Vec<Record>| serde_json::to_vec_pretty(records).unwrap().len() as u64;
    let (one, per) = (size(&old(1)), size(&old(2)) - size(&old(1)));
    let mut count = ((MAX_BYTES - one) / per) as usize + 1;
    while size(&old(count)) > MAX_BYTES {
        count -= 1;
    }
    let mut records = old(count);
    // Full to within one small item: the next uninstall's record cannot fit beside it.
    assert!(size(&records) > MAX_BYTES - 2 * per, "{}", size(&records));
    assert!(write(&prefs, &mut records, "").unwrap().is_empty());
    fs::create_dir_all(store_dir(&prefs).join(old_id).join("0")).unwrap();
    f.skill("home/.claude/skills/fresh", "---\nname: fresh\n---\nx");

    let result =
        uninstall_with(&lock, &home, None, None, &prefs, &Homes::default(), "fresh").unwrap();
    assert_eq!(result.uninstalled.expired_undo, ["old"]);
    assert_eq!(result.uninstalled.expired_undo_ids, [old_id]);
    let value = serde_json::to_value(&result).unwrap();
    assert_eq!(
        value["uninstalled"]["expiredUndo"],
        serde_json::json!(["old"])
    );
    assert_eq!(
        value["uninstalled"]["expiredUndoIds"],
        serde_json::json!([old_id])
    );
    assert!(
        !store_dir(&prefs).join(old_id).exists(),
        "its kept copy goes"
    );
    assert_eq!(
        undo_with(&lock, &prefs, old_id).unwrap_err(),
        "This uninstall can no longer be undone."
    );
    // Nothing expires when the file has room: the field is left out.
    undo_with(&lock, &prefs, &result.uninstalled.id).unwrap();
    let again =
        uninstall_with(&lock, &home, None, None, &prefs, &Homes::default(), "fresh").unwrap();
    assert!(again.uninstalled.expired_undo.is_empty());
    let value = serde_json::to_value(&again).unwrap();
    assert!(value["uninstalled"].get("expiredUndo").is_none());
}

#[test]
fn skill_manager_undo_resumes_after_a_partial_undo_left_items_back_in_place() {
    let f = Fixture::new();
    let home = f.0.join("home");
    let prefs = f.0.join("prefs.json");
    let lock = Mutex::new(());
    f.skill("home/.agents/skills/tidy", "---\nname: tidy\n---\nA");
    f.skill("home/.claude/skills/tidy", "---\nname: tidy\n---\nB");
    let done =
        uninstall_with(&lock, &home, None, None, &prefs, &Homes::default(), "tidy").unwrap();
    let id = done.uninstalled.id.clone();
    let record = read(&prefs).unwrap().into_iter().find(|r| r.id == id).unwrap();
    assert_eq!(record.items.len(), 2);
    // An earlier Undo put the first item back and its rollback could not move it again.
    let first = &record.items[0];
    let dir = store_dir(&prefs).join(&id);
    fs::rename(dir.join(first.stored.as_ref().unwrap()), &first.original).unwrap();
    let mut records = read(&prefs).unwrap();
    for record in records.iter_mut().filter(|r| r.id == id) {
        record.items[0].put_back = true;
    }
    write(&prefs, &mut records, "").unwrap();
    // The retry counts that item as done and finishes the rest.
    undo_with(&lock, &prefs, &id).unwrap();
    assert!(home.join(".agents/skills/tidy/SKILL.md").is_file());
    assert!(home.join(".claude/skills/tidy/SKILL.md").is_file());
    assert!(!dir.exists());
    assert!(read(&prefs).unwrap().iter().all(|r| r.id != id));
    // Something new at a path still waiting to go back is refused, as before.
    let again =
        uninstall_with(&lock, &home, None, None, &prefs, &Homes::default(), "tidy").unwrap();
    let record = read(&prefs).unwrap().into_iter().find(|r| r.id == again.uninstalled.id);
    let pending = &record.unwrap().items[1];
    fs::create_dir_all(&pending.original).unwrap();
    assert_eq!(
        undo_with(&lock, &prefs, &again.uninstalled.id).unwrap_err(),
        OCCUPIED
    );
}

/// Uninstalls `tidy` (switched off in All projects) and returns the Undo ID.
fn uninstall_switched_off(f: &Fixture, lock: &Mutex<()>) -> String {
    let prefs = f.0.join("prefs.json");
    save_prefs(&prefs, &Prefs::default().set("tidy", false, None)).unwrap();
    let done =
        uninstall_with(lock, &f.0.join("home"), None, None, &prefs, &Homes::default(), "tidy")
            .unwrap();
    assert!(done.uninstalled.switches_cleared);
    assert!(!off(&prefs).off_in_panda_code.contains("tidy"));
    done.uninstalled.id
}

#[test]
fn skill_manager_undo_refuses_when_the_kept_copy_vanished_and_the_skill_was_added_again() {
    let f = Fixture::new();
    let prefs = f.0.join("prefs.json");
    let lock = Mutex::new(());
    f.skill("home/.agents/skills/tidy", "---\nname: tidy\n---\nold");
    let id = uninstall_switched_off(&f, &lock);
    let record = read(&prefs).unwrap().into_iter().find(|r| r.id == id).unwrap();
    let stored = record.items[0].stored.clone().unwrap();
    fs::remove_dir_all(store_dir(&prefs).join(&id).join(stored)).unwrap();
    // The user adds the skill again at the same path.
    f.skill("home/.agents/skills/tidy", "---\nname: tidy\n---\nnew");

    assert_eq!(undo_with(&lock, &prefs, &id).unwrap_err(), MISSING);
    assert!(!off(&prefs).off_in_panda_code.contains("tidy"), "switches untouched");
    assert!(read(&prefs).unwrap().iter().all(|r| r.id != id), "the record is dropped");
    assert_eq!(
        fs::read_to_string(f.0.join("home/.agents/skills/tidy/SKILL.md")).unwrap(),
        "---\nname: tidy\n---\nnew"
    );
}

#[cfg(unix)]
#[test]
fn skill_manager_undo_resumes_after_its_rollback_left_a_folder_put_back() {
    use std::os::unix::fs::PermissionsExt;
    let f = Fixture::new();
    let home = f.0.join("home");
    let prefs = f.0.join("prefs.json");
    let lock = Mutex::new(());
    let original = home.join(".agents/skills/tidy");
    f.skill("home/.agents/skills/tidy", "---\nname: tidy\n---\nBody");
    let links = home.join(".claude/skills");
    fs::create_dir_all(&links).unwrap();
    std::os::unix::fs::symlink(&original, links.join("tidy")).unwrap();
    let id = uninstall_switched_off(&f, &lock);
    // The link can't be recreated, and the folder put back can't go back into the store.
    fs::set_permissions(&links, fs::Permissions::from_mode(0o555)).unwrap();
    quarantine::STUCK_TAKING_BACK.set(true);
    let error = undo_with(&lock, &prefs, &id).unwrap_err();
    quarantine::STUCK_TAKING_BACK.set(false);
    fs::set_permissions(&links, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(error.starts_with("Could not put the skill back"), "{error}");
    let record = read(&prefs).unwrap().into_iter().find(|r| r.id == id).unwrap();
    let folder = record.items.iter().find(|i| i.stored.is_some()).unwrap();
    assert!(folder.put_back, "the folder left in place is marked");
    assert!(record.items.iter().all(|i| i.stored.is_some() || !i.put_back));
    assert!(!off(&prefs).off_in_panda_code.contains("tidy"));

    undo_with(&lock, &prefs, &id).unwrap();
    assert!(original.join("SKILL.md").is_file());
    assert_eq!(fs::read_link(links.join("tidy")).unwrap(), original);
    assert!(off(&prefs).off_in_panda_code.contains("tidy"), "the switch is set again");
    assert!(read(&prefs).unwrap().iter().all(|r| r.id != id));
}
