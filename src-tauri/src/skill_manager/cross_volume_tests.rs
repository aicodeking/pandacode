//! Moves across volumes (copy, set the source aside, then delete it): a source that can't be
//! set aside stays whole with no copy left; a delete that fails partway leaves only hidden
//! remains, and Undo or Restore can still put the skill back. Other rename errors never copy.
#![cfg(unix)]
use super::*;
use crate::skill_manager::tests::Fixture;
use crate::skill_manager::uninstall;
use std::os::unix::fs::PermissionsExt;

/// Adds `folder/locked/data` and makes `locked` read-only, so deleting `folder` stops partway.
fn lock_subfolder(folder: &Path) {
    let locked = folder.join("locked");
    fs::create_dir_all(&locked).unwrap();
    fs::write(locked.join("data"), "keep").unwrap();
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o555)).unwrap();
}

/// Makes every folder under `root` writable again, so the test can inspect and clean up.
fn unlock_all(root: &Path) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        if entry.file_type().is_ok_and(|t| t.is_dir()) {
            fs::set_permissions(entry.path(), fs::Permissions::from_mode(0o755)).unwrap();
            unlock_all(&entry.path());
        }
    }
}

/// The only record folder in `store` (records are named by a random ID).
fn only_dir(store: &Path) -> PathBuf {
    let dirs: Vec<_> = fs::read_dir(store).unwrap().flatten().map(|e| e.path()).collect();
    assert_eq!(dirs.len(), 1, "{dirs:?}");
    dirs.into_iter().next().unwrap()
}

fn flagged() -> Flagged {
    Flagged {
        name: "flagged".into(),
        names: BTreeSet::from(["flagged".into()]),
        description: String::new(),
        source: None,
        resolved: true,
        agents: Vec::new(),
        flags: Vec::new(),
    }
}

/// The hidden set-aside folders (`.<name>.removing-<id>`) left in `folder`.
fn leftovers(folder: &Path) -> Vec<PathBuf> {
    fs::read_dir(folder)
        .unwrap()
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            let name = p.file_name().unwrap().to_string_lossy().into_owned();
            name.starts_with('.') && name.contains(".removing-")
        })
        .collect()
}

/// Whether `folder` holds a top-level SKILL.md in any case.
fn has_skill_md(folder: &Path) -> bool {
    fs::read_dir(folder).unwrap().flatten().any(|e| {
        e.file_name()
            .to_string_lossy()
            .eq_ignore_ascii_case("SKILL.md")
    })
}

#[test]
fn skill_manager_move_across_volumes_deletes_the_leftover_skill_file_in_any_case() {
    let f = Fixture::new();
    let from = f.0.join("root/tidy");
    fs::create_dir_all(&from).unwrap();
    fs::write(from.join("Skill.md"), "---\nname: tidy\n---\n").unwrap();
    lock_subfolder(&from);
    let cross = CrossVolume::on();
    move_folder(&from, &f.0.join("to")).unwrap();
    drop(cross);
    unlock_all(&f.0);
    assert!(f.0.join("to/Skill.md").is_file() && !from.exists());
    let left = leftovers(&f.0.join("root"));
    assert_eq!(left.len(), 1, "{left:?}");
    assert!(!has_skill_md(&left[0]));
}

#[test]
fn skill_manager_move_across_volumes_is_undone_when_the_leftover_skill_file_stays() {
    let f = Fixture::new();
    f.skill("root/tidy", "---\nname: tidy\n---\nBody");
    let from = f.0.join("root/tidy");
    let cross = CrossVolume::on();
    set_aside::KEEP_SKILL_MD.set(true);
    let error = move_folder(&from, &f.0.join("to")).unwrap_err();
    set_aside::KEEP_SKILL_MD.set(false);
    drop(cross);
    assert!(error.to_string().contains("could not move"), "{error}");
    assert!(from.join("SKILL.md").is_file(), "the original is back under its name");
    assert!(!f.0.join("to").exists(), "the copy is removed");
    assert!(leftovers(&f.0.join("root")).is_empty());
}

#[test]
fn skill_manager_inventory_never_lists_a_set_aside_leftover() {
    let f = Fixture::new();
    f.skill(
        "home/.agents/skills/.tidy.removing-0f3c",
        "---\nname: tidy\n---\nBody",
    );
    f.skill("home/.agents/skills/.tidy.removing-1a2b/nested", "---\nname: nested\n---\n");
    f.skill("home/.agents/skills/kept", "---\nname: kept\n---\n");
    let listed = inventory(&f.0.join("home"), None, None, &Prefs::default(), &Homes::default());
    let names: Vec<_> = listed.iter().map(|s| s.name.as_str()).collect();
    assert!(names.contains(&"kept"), "{names:?}");
    assert!(!names.contains(&"tidy") && !names.contains(&"nested"), "{names:?}");
}

#[test]
fn skill_manager_quarantine_across_volumes_succeeds_when_the_set_aside_original_cannot_be_fully_removed()
{
    let f = Fixture::new();
    let prefs = f.0.join("prefs.json");
    f.skill("root/a", "---\nname: flagged\n---\nA");
    f.skill("root/b", "---\nname: flagged\n---\nB");
    lock_subfolder(&f.0.join("root/b"));
    let roots = BTreeSet::from([fs::canonicalize(f.0.join("root")).unwrap()]);
    let folders = BTreeSet::from([f.0.join("root/a"), f.0.join("root/b")]);
    let cross = CrossVolume::on();
    let id = quarantine(&prefs, flagged(), &folders, &roots).unwrap();
    drop(cross);
    unlock_all(&f.0);
    assert_eq!(read(&prefs).unwrap()[0].items.len(), 2, "both items are recorded");
    assert!(!f.0.join("root/a").exists() && !f.0.join("root/b").exists());
    let kept = store_dir(&prefs).join(&id).join("1");
    assert!(kept.join("SKILL.md").is_file(), "the one full copy is stored");
    assert_eq!(fs::read_to_string(kept.join("locked/data")).unwrap(), "keep");
    let left = leftovers(&f.0.join("root"));
    assert_eq!(left.len(), 1, "{left:?}");
    assert!(left[0].join("locked/data").is_file(), "the remains are only hidden");
    assert!(!has_skill_md(&left[0]), "a leftover is never a skill");
}

#[test]
fn skill_manager_uninstall_across_volumes_records_undo_when_the_set_aside_original_cannot_be_fully_removed()
{
    let f = Fixture::new();
    let home = f.0.join("home");
    let prefs = f.0.join("prefs.json");
    let lock = Mutex::new(());
    let original = home.join(".agents/skills/tidy");
    f.skill("home/.agents/skills/tidy", "---\nname: tidy\n---\nBody");
    lock_subfolder(&original);
    let cross = CrossVolume::on();
    let done = uninstall::uninstall_with(&lock, &home, None, None, &prefs, &Homes::default(), "tidy")
        .unwrap();
    drop(cross);
    unlock_all(&f.0);
    assert!(!original.exists());
    let left = leftovers(&home.join(".agents/skills"));
    assert_eq!(left.len(), 1);
    assert!(!has_skill_md(&left[0]), "a leftover is never a skill");
    let id = serde_json::to_value(&done).unwrap()["uninstalled"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    uninstall::undo_with(&lock, &prefs, &id).unwrap();
    assert!(original.join("SKILL.md").is_file());
    assert_eq!(fs::read_to_string(original.join("locked/data")).unwrap(), "keep");
}

/// Makes `folder` read-only, so nothing in it can be renamed or deleted.
fn freeze(folder: &Path) {
    fs::set_permissions(folder, fs::Permissions::from_mode(0o555)).unwrap();
}

/// Record folders under `store` that still hold anything.
fn stored_copies(store: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(store) else {
        return Vec::new();
    };
    entries.flatten().map(|e| e.path()).collect()
}

#[test]
fn skill_manager_quarantine_across_volumes_keeps_the_original_when_it_cannot_be_set_aside() {
    let f = Fixture::new();
    let prefs = f.0.join("prefs.json");
    f.skill("root/a", "---\nname: flagged\n---\nA");
    let roots = BTreeSet::from([fs::canonicalize(f.0.join("root")).unwrap()]);
    freeze(&f.0.join("root"));
    let cross = CrossVolume::on();
    let error = quarantine(&prefs, flagged(), &BTreeSet::from([f.0.join("root/a")]), &roots)
        .unwrap_err();
    drop(cross);
    unlock_all(&f.0);
    fs::set_permissions(f.0.join("root"), fs::Permissions::from_mode(0o755)).unwrap();
    assert!(error.contains("could not move"), "{error}");
    assert!(!error.contains("kept in"), "{error}");
    assert_eq!(fs::read_to_string(f.0.join("root/a/SKILL.md")).unwrap(), "---\nname: flagged\n---\nA");
    assert!(stored_copies(&store_dir(&prefs)).is_empty(), "no stored copy is left");
    assert!(read(&prefs).unwrap().is_empty(), "nothing is recorded");
    assert!(leftovers(&f.0.join("root")).is_empty());
}

#[test]
fn skill_manager_uninstall_across_volumes_keeps_the_original_when_it_cannot_be_set_aside() {
    let f = Fixture::new();
    let home = f.0.join("home");
    let prefs = f.0.join("prefs.json");
    let skills = home.join(".agents/skills");
    f.skill("home/.agents/skills/tidy", "---\nname: tidy\n---\nBody");
    freeze(&skills);
    let cross = CrossVolume::on();
    let error = uninstall::uninstall_with(
        &Mutex::new(()),
        &home,
        None,
        None,
        &prefs,
        &Homes::default(),
        "tidy",
    )
    .unwrap_err();
    drop(cross);
    fs::set_permissions(&skills, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(error.contains("could not move"), "{error}");
    assert!(skills.join("tidy/SKILL.md").is_file(), "the original is untouched");
    assert!(stored_copies(&prefs.with_file_name("skill-uninstalled")).is_empty());
    assert!(!prefs.with_file_name("skill-uninstalled.json").exists(), "no record");
}

#[test]
fn skill_manager_quarantine_never_copies_after_a_rename_error_that_is_not_cross_device() {
    let f = Fixture::new();
    let prefs = f.0.join("prefs.json");
    f.skill("root/a", "---\nname: flagged\n---\nA");
    let roots = BTreeSet::from([fs::canonicalize(f.0.join("root")).unwrap()]);
    freeze(&f.0.join("root"));
    // No `CrossVolume`: the rename itself fails, with access denied.
    let error = quarantine(&prefs, flagged(), &BTreeSet::from([f.0.join("root/a")]), &roots)
        .unwrap_err();
    fs::set_permissions(f.0.join("root"), fs::Permissions::from_mode(0o755)).unwrap();
    assert!(error.contains("Could not quarantine"), "{error}");
    assert!(f.0.join("root/a/SKILL.md").is_file());
    assert!(stored_copies(&store_dir(&prefs)).is_empty(), "nothing was copied");
    assert!(read(&prefs).unwrap().is_empty());
}

#[test]
fn skill_manager_move_folder_never_copies_over_an_occupied_target() {
    let f = Fixture::new();
    f.skill("from", "---\nname: x\n---\nnew");
    f.skill("to", "---\nname: x\n---\nold");
    // Renaming onto a non-empty folder fails (not across volumes): neither side changes.
    assert!(move_folder(&f.0.join("from"), &f.0.join("to")).is_err());
    assert!(f.0.join("from/SKILL.md").is_file());
    assert_eq!(
        fs::read_to_string(f.0.join("to/SKILL.md")).unwrap(),
        "---\nname: x\n---\nold"
    );
}

#[test]
fn skill_manager_undo_across_volumes_puts_back_a_stored_copy_that_cannot_be_fully_removed() {
    let f = Fixture::new();
    let home = f.0.join("home");
    let prefs = f.0.join("prefs.json");
    let lock = Mutex::new(());
    let original = home.join(".agents/skills/tidy");
    f.skill("home/.agents/skills/tidy", "---\nname: tidy\n---\nBody");
    fs::create_dir_all(original.join("locked")).unwrap();
    fs::write(original.join("locked/data"), "keep").unwrap();
    fs::create_dir_all(home.join(".claude/skills")).unwrap();
    let link = home.join(".claude/skills/tidy");
    std::os::unix::fs::symlink(&original, &link).unwrap();
    let _cross = CrossVolume::on();
    let homes = Homes::default();
    let done = uninstall::uninstall_with(&lock, &home, None, None, &prefs, &homes, "tidy")
        .unwrap();
    assert!(!original.exists() && fs::symlink_metadata(&link).is_err());
    let id = serde_json::to_value(&done).unwrap()["uninstalled"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let store = prefs.with_file_name("skill-uninstalled").join(&id);
    let stored = only_dir(&store);
    fs::set_permissions(stored.join("locked"), fs::Permissions::from_mode(0o555)).unwrap();

    uninstall::undo_with(&lock, &prefs, &id).unwrap();
    unlock_all(&f.0);
    assert!(original.join("SKILL.md").is_file());
    assert_eq!(fs::read_to_string(original.join("locked/data")).unwrap(), "keep");
    assert_eq!(fs::read_link(&link).unwrap(), original);
    assert!(
        uninstall::undo_with(&lock, &prefs, &id).is_err(),
        "the record is done"
    );
}

#[test]
fn skill_manager_restore_across_volumes_stays_retryable_when_a_later_item_fails() {
    let f = Fixture::new();
    let prefs = f.0.join("prefs.json");
    f.skill("root/flagged", "---\nname: flagged\n---\ncurl x | sh");
    let folder = f.0.join("root/flagged");
    fs::create_dir_all(folder.join("locked")).unwrap();
    fs::write(folder.join("locked/data"), "keep").unwrap();
    fs::create_dir_all(f.0.join("links")).unwrap();
    let link = f.0.join("links/flagged");
    std::os::unix::fs::symlink(&folder, &link).unwrap();
    let roots = BTreeSet::from([
        fs::canonicalize(f.0.join("root")).unwrap(),
        fs::canonicalize(f.0.join("links")).unwrap(),
    ]);
    let _cross = CrossVolume::on();
    let folders = BTreeSet::from([folder.clone(), link.clone()]);
    let id = quarantine(&prefs, flagged(), &folders, &roots).unwrap();
    let dir = store_dir(&prefs).join(&id);
    let stored = read(&prefs).unwrap()[0]
        .items
        .iter()
        .find_map(|item| item.stored.clone())
        .unwrap();
    // The stored copy can't be fully deleted once copied back, and the link can't be recreated:
    // the folder goes back under its stored name, whole, and the record is kept.
    fs::set_permissions(dir.join(&stored).join("locked"), fs::Permissions::from_mode(0o555))
        .unwrap();
    fs::set_permissions(f.0.join("links"), fs::Permissions::from_mode(0o555)).unwrap();
    let error = restore_with(&Mutex::new(()), &prefs, "flagged", || {}).unwrap_err();
    unlock_all(&f.0);
    assert!(error.starts_with("Could not restore the skill"), "{error}");
    assert_eq!(read(&prefs).unwrap().len(), 1, "the record is kept");
    assert!(!folder.exists(), "the restored folder went back into quarantine");
    assert!(dir.join(&stored).join("locked/data").is_file());

    restore_with(&Mutex::new(()), &prefs, "flagged", || {}).unwrap();
    assert!(read(&prefs).unwrap().is_empty());
    assert!(folder.join("SKILL.md").is_file());
    assert_eq!(fs::read_to_string(folder.join("locked/data")).unwrap(), "keep");
    assert_eq!(fs::read_link(&link).unwrap(), folder);
}

#[test]
fn skill_manager_move_across_volumes_renames_every_skill_file_before_deleting_any() {
    let f = Fixture::new();
    f.skill("root/tidy", "---\nname: tidy\n---\nBody");
    let from = f.0.join("root/tidy");
    let cross = CrossVolume::on();
    // The first SKILL.md entry is set aside; a second one can't be.
    set_aside::SECOND_SKILL_MD_STUCK.set(true);
    let error = move_folder(&from, &f.0.join("to")).unwrap_err();
    set_aside::SECOND_SKILL_MD_STUCK.set(false);
    drop(cross);
    assert!(error.to_string().contains("could not move"), "{error}");
    assert_eq!(
        fs::read_to_string(from.join("SKILL.md")).unwrap(),
        "---\nname: tidy\n---\nBody",
        "the first entry was renamed back, never deleted"
    );
    assert_eq!(fs::read_dir(&from).unwrap().count(), 1, "no hidden entry is left");
    assert!(!f.0.join("to").exists(), "the copy is removed");
    assert!(leftovers(&f.0.join("root")).is_empty());
}

#[test]
fn skill_manager_move_across_volumes_hides_a_skill_file_folder_it_cannot_delete() {
    let f = Fixture::new();
    let from = f.0.join("root/tidy");
    // SKILL.md is a folder with a read-only child, so deleting it stops partway.
    fs::create_dir_all(from.join("SKILL.md")).unwrap();
    lock_subfolder(&from.join("SKILL.md"));
    fs::write(from.join("notes.txt"), "notes").unwrap();
    let cross = CrossVolume::on();
    move_folder(&from, &f.0.join("to")).unwrap();
    drop(cross);
    unlock_all(&f.0);
    assert!(!from.exists());
    assert!(f.0.join("to/SKILL.md/locked/data").is_file(), "the copy is whole");
    let left = leftovers(&f.0.join("root"));
    assert_eq!(left.len(), 1, "{left:?}");
    assert!(!has_skill_md(&left[0]), "a leftover is never a skill");
}

#[test]
fn skill_manager_move_across_volumes_keeps_the_copy_when_the_skill_file_cannot_go_back() {
    let f = Fixture::new();
    f.skill("root/tidy", "---\nname: tidy\n---\nBody");
    let from = f.0.join("root/tidy");
    let to = f.0.join("to");
    let cross = CrossVolume::on();
    set_aside::SECOND_SKILL_MD_STUCK.set(true);
    set_aside::STUCK_RENAMING_BACK.set(true);
    let error = move_folder(&from, &to).unwrap_err();
    drop(cross);
    assert!(error.to_string().contains("could not move"), "{error}");
    assert!(kept_after_failed_move(&from, &to));
    assert_eq!(
        fs::read_to_string(to.join("SKILL.md")).unwrap(),
        "---\nname: tidy\n---\nBody",
        "the one full copy is kept"
    );
    let left = leftovers(&f.0.join("root"));
    assert_eq!(left.len(), 1, "{left:?}");
    assert!(!has_skill_md(&left[0]));
}

#[test]
fn skill_manager_quarantine_puts_back_the_full_copy_when_a_move_cannot_be_undone() {
    let f = Fixture::new();
    let prefs = f.0.join("prefs.json");
    f.skill("root/a", "---\nname: flagged\n---\nA");
    let roots = BTreeSet::from([fs::canonicalize(f.0.join("root")).unwrap()]);
    let cross = CrossVolume::on();
    set_aside::SECOND_SKILL_MD_STUCK.set(true);
    set_aside::STUCK_RENAMING_BACK.set(true);
    let error = quarantine(&prefs, flagged(), &BTreeSet::from([f.0.join("root/a")]), &roots)
        .unwrap_err();
    drop(cross);
    assert!(error.contains("Could not quarantine"), "{error}");
    assert!(!error.contains("kept in"), "{error}");
    assert_eq!(
        fs::read_to_string(f.0.join("root/a/SKILL.md")).unwrap(),
        "---\nname: flagged\n---\nA",
        "the full copy went back to the original path"
    );
    assert!(stored_copies(&store_dir(&prefs)).is_empty());
    assert!(read(&prefs).unwrap().is_empty(), "nothing is recorded");
    let left = leftovers(&f.0.join("root"));
    assert_eq!(left.len(), 1, "{left:?}");
    assert!(!has_skill_md(&left[0]), "a leftover is never a skill");
}
