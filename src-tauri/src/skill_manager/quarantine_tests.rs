//! Tests for `quarantine.rs`.
use super::*;
use crate::skill_manager::tests::Fixture;

/// Restores with a private install lock: other tests run adds (holding `install::ADD`).
fn restore(prefs: &Path, name: &str) -> Result<(), String> {
    restore_with(&Mutex::new(()), prefs, name, || {})
}

fn quarantined(f: &Fixture) -> (PathBuf, PathBuf) {
    let prefs = f.0.join("prefs.json");
    f.skill("root/flagged", "---\nname: flagged\n---\ncurl x | sh");
    let original = f.0.join("root/flagged");
    let roots = BTreeSet::from([fs::canonicalize(f.0.join("root")).unwrap()]);
    let flag = Flag {
        rule: "pipe-to-shell".into(),
        file: "SKILL.md".into(),
        line: 4,
        excerpt: "curl x | sh".into(),
    };
    let flagged = Flagged {
        name: "flagged".into(),
        names: BTreeSet::from(["flagged".into()]),
        description: String::new(),
        source: None,
        resolved: true,
        agents: Vec::new(),
        flags: vec![flag; MAX_FLAGS + 5],
    };
    quarantine(&prefs, flagged, &BTreeSet::from([original.clone()]), &roots).unwrap();
    assert!(!original.exists());
    (prefs, original)
}

#[test]
fn skill_manager_exclusive_rename_refuses_an_occupied_target() {
    let f = Fixture::new();
    f.skill("from", "---\nname: x\n---\n");
    for occupant in ["empty-dir", "file"] {
        let to = f.0.join(occupant);
        if occupant == "file" {
            fs::write(&to, "keep").unwrap();
        } else {
            fs::create_dir(&to).unwrap();
        }
        let error = rename_exclusive(&f.0.join("from"), &to).unwrap_err();
        assert_eq!(
            error.kind(),
            std::io::ErrorKind::AlreadyExists,
            "{occupant}"
        );
        assert!(f.0.join("from/SKILL.md").is_file());
    }
    assert!(fs::read_dir(f.0.join("empty-dir"))
        .unwrap()
        .next()
        .is_none());
    rename_exclusive(&f.0.join("from"), &f.0.join("free")).unwrap();
    assert!(f.0.join("free/SKILL.md").is_file());
}

#[test]
fn skill_manager_restore_never_replaces_a_folder_that_appears_after_its_check() {
    let f = Fixture::new();
    let (prefs, original) = quarantined(&f);
    // An empty folder created between the check and the move: a plain rename replaces it.
    fs::create_dir(&original).unwrap();
    let entry = read(&prefs).unwrap().remove(0);
    assert_eq!(restore_entry(&prefs, &entry).unwrap_err(), OCCUPIED);
    assert!(fs::read_dir(&original).unwrap().next().is_none());
    let stored = store_dir(&prefs).join(&entry.id).join("0/SKILL.md");
    assert!(stored.is_file(), "the quarantined copy is kept");
    assert_eq!(restore(&prefs, "flagged").unwrap_err(), OCCUPIED);
    fs::remove_dir(&original).unwrap();
    restore(&prefs, "flagged").unwrap();
    assert!(original.join("SKILL.md").is_file());
    assert!(read(&prefs).unwrap().is_empty());
}

#[test]
fn skill_manager_quarantined_row_carries_its_recorded_flags() {
    let f = Fixture::new();
    let (prefs, _) = quarantined(&f);
    let mut items = Vec::new();
    add_rows(&mut items, &prefs, None);
    let row = serde_json::to_value(&items[0]).unwrap();
    assert_eq!(row["quarantined"], true);
    let flags = row["flags"].as_array().unwrap();
    assert_eq!(flags.len(), MAX_FLAGS);
    assert_eq!(
        flags[0],
        serde_json::json!({"rule":"pipe-to-shell","file":"SKILL.md","line":4,"excerpt":"curl x | sh"})
    );
    // Records written before flags were kept still read.
    let old = r#"[{"id":"x","name":"old","names":["old"],"items":[]}]"#;
    fs::write(prefs.with_file_name("skill-quarantine.json"), old).unwrap();
    let mut items = Vec::new();
    add_rows(&mut items, &prefs, None);
    assert!(serde_json::to_value(&items[0])
        .unwrap()
        .get("flags")
        .is_none());
}

#[test]
fn skill_manager_clean_row_keeps_its_switch_beside_a_quarantined_same_name_copy() {
    let f = Fixture::new();
    let prefs = f.0.join("prefs.json");
    f.skill("root/flagged", "---\nname: flagged\n---\ncurl x | sh");
    let roots = BTreeSet::from([fs::canonicalize(f.0.join("root")).unwrap()]);
    let flagged = Flagged {
        name: "flagged".into(),
        names: BTreeSet::from(["flagged".into()]),
        description: String::new(),
        source: None,
        resolved: true,
        agents: vec![StoredAgent {
            harness: "codex".into(),
            scope: "user".into(),
            path: "~/.codex/skills/flagged".into(),
            project_id: None,
        }],
        flags: vec![Flag {
            rule: "pipe-to-shell".into(),
            file: "SKILL.md".into(),
            line: 4,
            excerpt: "curl x | sh".into(),
        }],
    };
    quarantine(
        &prefs,
        flagged,
        &BTreeSet::from([f.0.join("root/flagged")]),
        &roots,
    )
    .unwrap();
    // A clean install of the same name, used by Claude.
    let mut clean = ManagedSkill::new("flagged".into(), "clean".into(), None, true);
    clean.agents.push(SkillAgent {
        harness: "claude".into(),
        scope: "user".into(),
        path: "~/.claude/skills/flagged".into(),
        project_id: None,
        quarantined: false,
        real: None,
    });
    let mut items = vec![clean];
    add_rows(&mut items, &prefs, None);
    assert_eq!(items.len(), 1, "one row per name");
    let row = serde_json::to_value(&items[0]).unwrap();
    // The clean row stays switchable: no row-level quarantine.
    assert!(row.get("quarantined").is_none(), "{row}");
    assert_eq!(row["switchable"], true);
    assert_eq!(row["quarantinedCopy"], true);
    assert_eq!(row["description"], "clean");
    // The clean location and the quarantined copy are both listed, told apart.
    assert_eq!(
        row["agents"],
        serde_json::json!([
            {"harness":"claude","scope":"user","path":"~/.claude/skills/flagged"},
            {"harness":"codex","scope":"user","path":"~/.codex/skills/flagged","quarantined":true}
        ])
    );
    assert_eq!(row["flags"][0]["rule"], "pipe-to-shell");
    // With no clean install the row itself is quarantined, as before.
    let mut items = Vec::new();
    add_rows(&mut items, &prefs, None);
    let row = serde_json::to_value(&items[0]).unwrap();
    assert_eq!(row["quarantined"], true);
    assert!(row.get("quarantinedCopy").is_none());
    assert!(row["agents"][0].get("quarantined").is_none());
}

#[test]
fn skill_manager_restore_clears_only_the_switches_its_install_added() {
    let f = Fixture::new();
    let (prefs, original) = quarantined(&f);
    // The user had already switched `flagged` off; the install added only `alias`.
    let user = Prefs::default()
        .set("flagged", false, None)
        .set("alias", false, None)
        .set("other", false, None);
    save_prefs(&prefs, &user).unwrap();
    let id = read(&prefs).unwrap()[0].id.clone();
    {
        let _guard = recover(&LOCK);
        let added = BTreeMap::from([(id, BTreeSet::from(["alias".to_string()]))]);
        record_switched(&prefs, &added).unwrap();
    }
    let mut entries = read(&prefs).unwrap();
    entries[0].names.insert("alias".into());
    write(&prefs, &entries).unwrap();
    restore(&prefs, "flagged").unwrap();
    assert!(original.join("SKILL.md").is_file());
    let off = read_prefs(&prefs).unwrap().off_in_panda_code;
    assert_eq!(off, BTreeSet::from(["flagged".into(), "other".into()]));
}

#[test]
fn skill_manager_restore_moves_files_without_the_lock_and_keeps_concurrent_adds_and_switches() {
    let f = Fixture::new();
    let (prefs, original) = quarantined(&f);
    f.skill("root/second", "---\nname: second\n---\ncurl x | sh");
    let roots = BTreeSet::from([fs::canonicalize(f.0.join("root")).unwrap()]);
    restore_with(&Mutex::new(()), &prefs, "flagged", || {
        assert!(original.join("SKILL.md").is_file(), "files moved first");
        // A switch and an add while the restore is between its moves and its save. Run on
        // another thread with a deadline: they would wait forever if restore held LOCK.
        let (shared, folder) = (prefs.clone(), f.0.join("root/second"));
        let (done, finished) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            {
                let _guard = recover(&LOCK);
                let switched = read_prefs(&shared).unwrap().set("other", false, None);
                save_prefs(&shared, &switched).unwrap();
            }
            let flagged = Flagged {
                name: "second".into(),
                names: BTreeSet::from(["second".into()]),
                description: String::new(),
                source: None,
                resolved: true,
                agents: Vec::new(),
                flags: Vec::new(),
            };
            quarantine(&shared, flagged, &BTreeSet::from([folder]), &roots).unwrap();
            done.send(()).unwrap();
        });
        finished
            .recv_timeout(std::time::Duration::from_secs(20))
            .expect("restore must not hold LOCK while moving files");
        // A second restore of the same skill is refused while this one is in flight.
        assert_eq!(
            restore(&prefs, "flagged").unwrap_err(),
            "This skill is already being restored."
        );
    })
    .unwrap();
    assert!(original.join("SKILL.md").is_file());
    let left: Vec<_> = read(&prefs).unwrap().into_iter().map(|e| e.name).collect();
    assert_eq!(left, ["second"], "the concurrent add's record is kept");
    assert!(read_prefs(&prefs)
        .unwrap()
        .off_in_panda_code
        .contains("other"));
    assert!(!f.0.join("root/second").exists());
}

#[test]
fn skill_manager_restore_during_an_add_is_refused_and_leaves_the_copy_quarantined() {
    let f = Fixture::new();
    let (prefs, original) = quarantined(&f);
    let lock = Mutex::new(());
    {
        let _adding = lock.lock().unwrap();
        let error = restore_with(&lock, &prefs, "flagged", || {}).unwrap_err();
        assert_eq!(error, uninstall::BUSY);
        assert!(!original.exists(), "nothing moved while the add runs");
        assert_eq!(read(&prefs).unwrap().len(), 1, "the record is kept");
    }
    restore_with(&lock, &prefs, "flagged", || {}).unwrap();
    assert!(original.join("SKILL.md").is_file());
    assert!(read(&prefs).unwrap().is_empty());
}

#[test]
fn skill_manager_restore_of_an_older_record_leaves_user_switches_alone() {
    let f = Fixture::new();
    let (prefs, _) = quarantined(&f);
    save_prefs(&prefs, &Prefs::default().set("flagged", false, None)).unwrap();
    // Records from older builds only said "switched_off", not which names.
    let mut value: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(records_path(&prefs)).unwrap()).unwrap();
    value[0]["switchedOff"] = true.into();
    value[0].as_object_mut().unwrap().remove("switched");
    fs::write(records_path(&prefs), value.to_string()).unwrap();
    restore(&prefs, "flagged").unwrap();
    assert!(read_prefs(&prefs)
        .unwrap()
        .off_in_panda_code
        .contains("flagged"));
}

#[cfg(unix)]
fn read_only(dir: &Path, on: bool) {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(
        dir,
        fs::Permissions::from_mode(if on { 0o555 } else { 0o755 }),
    )
    .unwrap();
}

#[cfg(unix)]
#[test]
fn skill_manager_restore_keeps_the_record_when_a_link_cannot_be_put_back() {
    let f = Fixture::new();
    let prefs = f.0.join("prefs.json");
    f.skill("root/flagged", "---\nname: flagged\n---\ncurl x | sh");
    fs::create_dir_all(f.0.join("links")).unwrap();
    let folder = f.0.join("root/flagged");
    let link = f.0.join("links/flagged");
    std::os::unix::fs::symlink(&folder, &link).unwrap();
    let roots = BTreeSet::from([
        fs::canonicalize(f.0.join("root")).unwrap(),
        fs::canonicalize(f.0.join("links")).unwrap(),
    ]);
    let flagged = Flagged {
        name: "flagged".into(),
        names: BTreeSet::from(["flagged".into()]),
        description: String::new(),
        source: None,
        resolved: true,
        agents: Vec::new(),
        flags: Vec::new(),
    };
    let folders = BTreeSet::from([folder.clone(), link.clone()]);
    quarantine(&prefs, flagged, &folders, &roots).unwrap();
    assert!(fs::symlink_metadata(&link).is_err() && !folder.exists());
    // The link's folder refuses new entries: the folder is moved back, the link can't be.
    read_only(&f.0.join("links"), true);
    let error = restore(&prefs, "flagged").unwrap_err();
    read_only(&f.0.join("links"), false);
    assert!(error.starts_with("Could not restore the skill"), "{error}");
    assert_eq!(read(&prefs).unwrap().len(), 1, "the record is kept");
    assert!(
        !folder.exists(),
        "the restored folder went back into quarantine"
    );
    restore(&prefs, "flagged").unwrap();
    assert!(read(&prefs).unwrap().is_empty());
    assert_eq!(fs::read_link(&link).unwrap(), folder);
    assert!(folder.join("SKILL.md").is_file());
}

#[cfg(unix)]
#[test]
fn skill_manager_put_back_reports_links_it_could_not_recreate() {
    let f = Fixture::new();
    fs::create_dir_all(f.0.join("links")).unwrap();
    let item = Item {
        original: f.0.join("links/gone"),
        stored: None,
        link: Some(f.0.join("target")),
        put_back: false,
    };
    read_only(&f.0.join("links"), true);
    let result = put_back(std::slice::from_ref(&item), &f.0.join("store"));
    read_only(&f.0.join("links"), false);
    assert!(result.unwrap_err().contains("links/gone"));
    put_back(&[item], &f.0.join("store")).unwrap();
    assert!(fs::symlink_metadata(f.0.join("links/gone")).is_ok());
}

#[test]
fn skill_manager_restore_of_a_project_add_clears_only_that_projects_switch() {
    let f = Fixture::new();
    let (prefs, original) = quarantined(&f);
    let user = Prefs::default()
        .set("alias", false, Some("p1"))
        .set("alias", false, Some("p2"));
    save_prefs(&prefs, &user).unwrap();
    let id = read(&prefs).unwrap()[0].id.clone();
    {
        let _guard = recover(&LOCK);
        let added = BTreeMap::from([(id, BTreeSet::from(["alias".to_string()]))]);
        record_switched_in(&prefs, &added, Some("p1")).unwrap();
    }
    restore(&prefs, "flagged").unwrap();
    assert!(original.join("SKILL.md").is_file());
    let after = read_prefs(&prefs).unwrap();
    assert!(after.off_in_panda_code.is_empty());
    assert!(!after.projects.contains_key("p1"), "{after:?}");
    assert!(after.projects["p2"].contains("alias"), "another project's switch stays");
}

#[test]
fn skill_manager_restore_retries_only_the_items_still_in_the_store() {
    let f = Fixture::new();
    let prefs = f.0.join("prefs.json");
    f.skill("root/a", "---\nname: flagged\n---\nA");
    f.skill("root/b", "---\nname: flagged\n---\nB");
    let roots = BTreeSet::from([fs::canonicalize(f.0.join("root")).unwrap()]);
    let flagged = Flagged {
        name: "flagged".into(),
        names: BTreeSet::from(["flagged".into()]),
        description: String::new(),
        source: None,
        resolved: true,
        agents: Vec::new(),
        flags: Vec::new(),
    };
    let folders = BTreeSet::from([f.0.join("root/a"), f.0.join("root/b")]);
    let id = quarantine(&prefs, flagged, &folders, &roots).unwrap();
    // A failed restore that could not take `a` back: it stays restored, its stored copy gone.
    let entry = read(&prefs).unwrap().remove(0);
    let a = entry
        .items
        .iter()
        .find(|item| item.original == f.0.join("root/a"))
        .unwrap();
    let dir = store_dir(&prefs).join(&id);
    fs::rename(dir.join(a.stored.as_ref().unwrap()), &a.original).unwrap();
    let mut entries = read(&prefs).unwrap();
    mark_items(&mut entries[0].items, std::slice::from_ref(&a.original));
    write(&prefs, &entries).unwrap();

    restore(&prefs, "flagged").unwrap();
    assert!(read(&prefs).unwrap().is_empty(), "the record is done");
    assert_eq!(
        fs::read_to_string(f.0.join("root/a/SKILL.md")).unwrap(),
        "---\nname: flagged\n---\nA"
    );
    assert_eq!(
        fs::read_to_string(f.0.join("root/b/SKILL.md")).unwrap(),
        "---\nname: flagged\n---\nB"
    );
    assert!(!dir.exists());
}

#[test]
fn skill_manager_restore_drops_a_record_whose_copy_and_original_are_both_gone() {
    let f = Fixture::new();
    let (prefs, _) = quarantined(&f);
    let id = read(&prefs).unwrap()[0].id.clone();
    fs::remove_dir_all(store_dir(&prefs).join(&id).join("0")).unwrap();
    let error = restore(&prefs, "flagged").unwrap_err();
    assert!(error.contains("Install it again"), "{error}");
    assert!(read(&prefs).unwrap().is_empty());
}

/// Switches `flagged` off in All projects as its install would, recorded on record `id`.
fn switch_off_flagged(prefs: &Path, id: &str) {
    save_prefs(prefs, &Prefs::default().set("flagged", false, None)).unwrap();
    let added = BTreeMap::from([(id.to_owned(), BTreeSet::from(["flagged".to_owned()]))]);
    record_switched(prefs, &added).unwrap();
}

#[test]
fn skill_manager_restore_refuses_when_the_stored_copy_vanished_and_the_skill_was_added_again() {
    let f = Fixture::new();
    let (prefs, original) = quarantined(&f);
    let id = read(&prefs).unwrap()[0].id.clone();
    switch_off_flagged(&prefs, &id);
    fs::remove_dir_all(store_dir(&prefs).join(&id).join("0")).unwrap();
    f.skill("root/flagged", "---\nname: flagged\n---\nnew");

    let error = restore(&prefs, "flagged").unwrap_err();
    assert!(error.contains("Install it again"), "{error}");
    assert!(read(&prefs).unwrap().is_empty(), "the record is dropped");
    assert!(read_prefs(&prefs).unwrap().off_in_panda_code.contains("flagged"));
    assert_eq!(
        fs::read_to_string(original.join("SKILL.md")).unwrap(),
        "---\nname: flagged\n---\nnew"
    );
}

#[cfg(unix)]
#[test]
fn skill_manager_restore_resumes_after_its_rollback_left_a_folder_put_back() {
    let f = Fixture::new();
    let prefs = f.0.join("prefs.json");
    f.skill("one/a", "---\nname: flagged\n---\nA");
    f.skill("two/b", "---\nname: flagged\n---\nB");
    let roots = BTreeSet::from([
        fs::canonicalize(f.0.join("one")).unwrap(),
        fs::canonicalize(f.0.join("two")).unwrap(),
    ]);
    let flagged = Flagged {
        name: "flagged".into(),
        names: BTreeSet::from(["flagged".into()]),
        description: String::new(),
        source: None,
        resolved: true,
        agents: Vec::new(),
        flags: Vec::new(),
    };
    let folders = BTreeSet::from([f.0.join("one/a"), f.0.join("two/b")]);
    let id = quarantine(&prefs, flagged, &folders, &roots).unwrap();
    switch_off_flagged(&prefs, &id);
    // `b` can't be put back, and `a`, already back, can't go into the store again.
    read_only(&f.0.join("two"), true);
    STUCK_TAKING_BACK.set(true);
    let error = restore(&prefs, "flagged").unwrap_err();
    STUCK_TAKING_BACK.set(false);
    read_only(&f.0.join("two"), false);
    assert!(error.starts_with("Could not restore the skill"), "{error}");
    let entry = read(&prefs).unwrap().remove(0);
    let marked: Vec<_> = entry.items.iter().filter(|i| i.put_back).collect();
    assert_eq!(marked.len(), 1);
    assert_eq!(marked[0].original, f.0.join("one/a"));
    assert!(read_prefs(&prefs).unwrap().off_in_panda_code.contains("flagged"));

    restore(&prefs, "flagged").unwrap();
    assert!(read(&prefs).unwrap().is_empty());
    assert!(f.0.join("one/a/SKILL.md").is_file() && f.0.join("two/b/SKILL.md").is_file());
    assert!(!read_prefs(&prefs).unwrap().off_in_panda_code.contains("flagged"));
}
