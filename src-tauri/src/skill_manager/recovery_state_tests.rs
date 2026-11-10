//! Tests for what the inventory says when saved state can't be read: `prefsLost` (no switches
//! recovered) and `linksWarning` (an unreadable `skill-manager-links.json`).
use super::tests::Fixture;
use super::*;

#[test]
fn skill_manager_inventory_says_prefs_lost_only_when_no_switches_could_be_recovered() {
    let f = Fixture::new();
    let home = f.0.join("home");
    let path = f.0.join("prefs.json");
    fs::write(&path, "broken").unwrap();
    let lost = serde_json::to_value(list_at(&home, None, None, &path, &Homes::default()).unwrap())
        .unwrap();
    assert!(lost["prefsError"].is_string());
    assert_eq!(lost["prefsLost"], true);

    // With a readable backup the last saved switches are used: nothing is lost.
    let other = f.0.join("other.json");
    save_prefs(&other, &Prefs::default().set("kept", false, None)).unwrap();
    recover(&LAST_PREFS).remove(&other);
    fs::write(&other, "broken").unwrap();
    let recovered =
        serde_json::to_value(list_at(&home, None, None, &other, &Homes::default()).unwrap())
            .unwrap();
    assert!(recovered["prefsError"].is_string());
    assert!(recovered.get("prefsLost").is_none(), "{recovered}");

    let fine = f.0.join("fine.json");
    let healthy =
        serde_json::to_value(list_at(&home, None, None, &fine, &Homes::default()).unwrap())
            .unwrap();
    assert!(healthy.get("prefsLost").is_none() && healthy.get("prefsError").is_none());
}

#[cfg(unix)]
#[test]
fn skill_manager_unreadable_link_records_are_kept_aside_not_overwritten_and_reported() {
    let f = Fixture::new();
    let home = f.0.join("home");
    let prefs = f.0.join("prefs.json");
    let records = f.0.join("skill-manager-links.json");
    let mut homes = Homes::default();
    homes.add_home("codex", f.0.join("acct"));
    f.skill("home/.agents/skills/old", "---\nname: old\n---\nx");
    let record = |name: &str| serde_json::json!({"name":name,"status":"installed","path":home.join(".agents/skills").join(name)});
    let (failures, _) = accounts::link(&home, &homes, "codex", &[record("old")], &prefs);
    assert!(failures.is_empty(), "{failures:?}");
    let owned_link = f.0.join("acct/skills/old");
    assert!(!accounts::foreign_account_copy(
        &home,
        &homes,
        &prefs,
        &owned_link
    ));

    fs::write(&records, "{ not json").unwrap();
    // Unreadable: every account copy counts as the user's, and the page is told.
    assert!(accounts::foreign_account_copy(
        &home,
        &homes,
        &prefs,
        &owned_link
    ));
    let listed = list_at(&home, None, None, &prefs, &homes).unwrap();
    let warning = serde_json::to_value(&listed).unwrap()["linksWarning"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(warning.contains("skill-manager-links.json"), "{warning}");
    assert_eq!(
        fs::read_to_string(&records).unwrap(),
        "{ not json",
        "a list never writes it"
    );

    // The next add keeps the unreadable file under a timestamped name before starting anew.
    f.skill("home/.agents/skills/new", "---\nname: new\n---\nx");
    let (failures, written) = accounts::link(&home, &homes, "codex", &[record("new")], &prefs);
    assert!(failures.is_empty() && written.len() == 1, "{failures:?}");
    let backups: Vec<_> = fs::read_dir(&f.0)
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with("skill-manager-links.json.") && n.ends_with(".backup"))
        .collect();
    assert_eq!(backups.len(), 1, "{backups:?}");
    assert_eq!(
        fs::read_to_string(f.0.join(&backups[0])).unwrap(),
        "{ not json"
    );
    let saved: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&records).unwrap()).unwrap();
    assert_eq!(
        saved.as_object().unwrap().len(),
        1,
        "only the new link is recorded"
    );
    let listed = list_at(&home, None, None, &prefs, &homes).unwrap();
    let warning = serde_json::to_value(&listed).unwrap()["linksWarning"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(warning.contains(&backups[0]), "{warning}");
}

#[test]
fn skill_manager_inventory_has_no_links_warning_without_link_records() {
    let f = Fixture::new();
    let listed = list_at(
        &f.0.join("home"),
        None,
        None,
        &f.0.join("prefs.json"),
        &Homes::default(),
    )
    .unwrap();
    assert!(serde_json::to_value(listed)
        .unwrap()
        .get("linksWarning")
        .is_none());
}
