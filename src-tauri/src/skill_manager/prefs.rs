use super::*;

pub(super) static LAST_PREFS: std::sync::LazyLock<Mutex<BTreeMap<PathBuf, Prefs>>> =
    std::sync::LazyLock::new(|| Mutex::new(BTreeMap::new()));
#[derive(Clone, Default, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(super) struct Prefs {
    #[serde(default)]
    pub(super) off_in_panda_code: BTreeSet<String>,
    #[serde(default)]
    pub(super) projects: BTreeMap<String, BTreeSet<String>>,
}
impl Prefs {
    pub(super) fn set(&self, name: &str, enabled: bool, project: Option<&str>) -> Self {
        let mut next = self.clone();
        let names = if let Some(project) = project {
            next.projects.entry(project.to_owned()).or_default()
        } else {
            &mut next.off_in_panda_code
        };
        if enabled {
            names.remove(name);
        } else {
            names.insert(name.into());
        }
        next.projects.retain(|_, names| !names.is_empty());
        next
    }
    pub(super) fn project_names(
        &self,
        project_id: Option<&str>,
        project: Option<&Path>,
    ) -> BTreeSet<String> {
        project_id
            .and_then(|id| self.projects.get(id))
            .into_iter()
            .flatten()
            .chain(
                project
                    .and_then(|p| self.projects.get(&checkout_key(p)))
                    .into_iter()
                    .flatten(),
            )
            .cloned()
            .collect()
    }
    pub(super) fn disabled(
        &self,
        project_id: Option<&str>,
        project: Option<&Path>,
    ) -> BTreeSet<String> {
        self.off_in_panda_code
            .union(&self.project_names(project_id, project))
            .cloned()
            .collect()
    }
}
pub(super) fn backup_path(path: &Path) -> PathBuf {
    path.with_extension("json.backup")
}
pub(super) fn read_prefs(path: &Path) -> Result<Prefs, String> {
    let result = (|| {
        let prefs = match fs::metadata(path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                if backup_path(path).exists() {
                    heal_from_backup(path)?
                } else if recover(&LAST_PREFS).contains_key(path) {
                    return Err(e.to_string());
                } else {
                    return Ok(Prefs::default());
                }
            }
            Err(e) => return Err(e.to_string()),
            Ok(_) => parse_prefs(path)?,
        };
        recover(&LAST_PREFS).insert(path.to_owned(), prefs.clone());
        Ok(prefs)
    })();
    result.map_err(|e: String| {
        format!(
            "Skill settings file is unreadable: {}",
            safety::redact_warning(&e)
        )
    })
}
fn parse_prefs(path: &Path) -> Result<Prefs, String> {
    let text = read_text(path).ok_or("Could not read skill-manager.json (maximum 256 KB).")?;
    // Names that fail today's switch policy stay off (fail closed): dropping them would turn
    // their skills back on. `prefs_warning` reports them; Reset switches clears them.
    serde_json::from_str(&text).map_err(|e| e.to_string())
}
impl Prefs {
    /// Stored names that no longer pass the switch name policy (`*` is the recovery marker).
    pub(super) fn invalid_names(&self) -> usize {
        self.off_in_panda_code
            .iter()
            .chain(self.projects.values().flatten())
            .filter(|name| *name != "*" && validate_toggle_name(name).is_err())
            .count()
    }
}
/// A calm notice for stored names kept off although they can no longer be switched here.
pub(super) fn prefs_warning(prefs: &Prefs) -> Option<String> {
    match prefs.invalid_names() {
        0 => None,
        1 => Some("1 saved switch uses a skill name PandaCode no longer accepts. It stays off; Reset switches clears it.".into()),
        n => Some(format!("{n} saved switches use skill names PandaCode no longer accepts. They stay off; Reset switches clears them.")),
    }
}
/// The primary is gone but `save_prefs` wrote the backup first: put the primary back from it.
fn heal_from_backup(path: &Path) -> Result<Prefs, String> {
    let prefs = parse_prefs(&backup_path(path))
        .map_err(|e| format!("the primary is missing and its backup is unreadable: {e}"))?;
    let bytes = serde_json::to_vec_pretty(&prefs).map_err(|e| e.to_string())?;
    write_prefs_file(path, &bytes)?;
    eprintln!("Warning: restored missing skill settings from their backup.");
    Ok(prefs)
}
pub(super) fn recovered_prefs(path: &Path) -> (Prefs, Option<String>) {
    match read_prefs(path) {
        Ok(prefs) => (prefs, None),
        Err(error) => {
            let cached = recover(&LAST_PREFS).get(path).cloned();
            let prefs = cached
                .or_else(|| {
                    backup_path(path)
                        .is_file()
                        .then(|| read_prefs(&backup_path(path)).ok())
                        .flatten()
                })
                .unwrap_or_else(|| {
                    // No readable history: block every skill until settings can be recovered.
                    Prefs {
                        off_in_panda_code: BTreeSet::from(["*".into()]),
                        ..Prefs::default()
                    }
                });
            (prefs, Some(error))
        }
    }
}
pub(super) fn launch_prefs(path: &Path) -> Prefs {
    let _guard = recover(&LOCK);
    let (prefs, error) = recovered_prefs(path);
    if let Some(error) = error {
        eprintln!("Warning: {error}; using last good skill settings or blocking all skills.");
    }
    prefs
}
pub(super) fn save_prefs(path: &Path, prefs: &Prefs) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(prefs).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("Skill manager preferences exceed 256 KB.".into());
    }
    // Write recovery data before replacing the primary. Never lose a newly saved disable.
    write_prefs_file(&backup_path(path), &bytes)?;
    write_prefs_file(path, &bytes)?;
    // Only a saved primary becomes the last good settings.
    recover(&LAST_PREFS).insert(path.to_owned(), prefs.clone());
    Ok(())
}
pub(super) fn write_prefs_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or("Invalid skill manager preferences path.")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let temp = parent.join(format!(".skill-manager-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&temp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result.map_err(|e| format!("Could not save skill manager preferences: {e}"))
}
// Explicit reset retains both damaged files before atomically writing fresh preferences.
pub(super) fn reset_prefs(path: &Path) -> Result<(), String> {
    let _guard = recover(&LOCK);
    let stamp = format!(
        "{}-{}",
        chrono::Utc::now().format("%Y%m%dT%H%M%S%.3fZ"),
        uuid::Uuid::new_v4()
    );
    for original in [path.to_path_buf(), backup_path(path)] {
        match fs::symlink_metadata(&original) {
            Ok(_) => {
                let backup = original.with_extension(format!(
                    "{}.{stamp}.backup",
                    original.extension().unwrap_or_default().to_string_lossy()
                ));
                fs::copy(&original, backup)
                    .map_err(|e| format!("Could not back up damaged skill settings: {e}"))?;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("Could not back up damaged skill settings: {e}")),
        }
    }
    save_prefs(path, &Prefs::default())
}

#[cfg(test)]
mod behavior_tests {
    use crate::skill_manager::tests::Fixture;
    use crate::skill_manager::*;
    #[test]
    fn skill_manager_launch_recovers_last_good_preferences() {
        let f = Fixture::new();
        let path = f.0.join("prefs.json");
        let expected =
            Prefs::default()
                .set("flagged", false, None)
                .set("local", false, Some("project"));
        save_prefs(&path, &expected).unwrap();
        fs::write(&path, "broken").unwrap();
        assert_eq!(launch_prefs(&path), expected);
        let inventory = list_at(&f.0.join("home"), None, None, &path, &Homes::default()).unwrap();
        assert!(serde_json::to_value(inventory).unwrap()["prefsError"].is_string());
    }

    #[test]
    fn skill_manager_prefs_backup_recovers_across_cache_loss_and_missing_primary() {
        let f = Fixture::new();
        let path = f.0.join("prefs.json");
        let expected = Prefs::default().set("flagged", false, None);
        save_prefs(&path, &expected).unwrap();
        recover(&LAST_PREFS).remove(&path);
        fs::write(&path, "broken").unwrap();
        assert_eq!(launch_prefs(&path), expected);
        fs::remove_file(&path).unwrap();
        recover(&LAST_PREFS).remove(&path);
        assert_eq!(launch_prefs(&path), expected);
    }

    #[test]
    fn skill_manager_catalog_skips_sqlite_for_empty_prefs_and_known_worktree_project() {
        let f = Fixture::new();
        assert!(disabled_for_path(&Prefs::default(), &f.0, || panic!(
            "Empty prefs must not open SQLite"
        ))
        .is_empty());
        let empty = Prefs {
            projects: BTreeMap::from([("empty-project".into(), BTreeSet::new())]),
            ..Prefs::default()
        };
        assert!(disabled_for_path(&empty, &f.0, || panic!(
            "Empty project switches need no lookup"
        ))
        .is_empty());
        let global = Prefs::default().set("global", false, None);
        assert!(disabled_for_path(&global, &f.0, || panic!(
            "Global prefs need no project lookup"
        ))
        .contains("global"));
        let cwd = f.0.join("worktree");
        remember_project(&cwd, "p", &f.0.join("main"));
        let prefs = global.set("local", false, Some("p"));
        assert_eq!(
            disabled_for_path(&prefs, &cwd, || panic!(
                "Known session project must be reused"
            )),
            BTreeSet::from(["global".into(), "local".into()])
        );
        recover(path_projects()).forget(&cwd);
    }

    #[test]
    fn skill_manager_stored_names_failing_todays_policy_stay_off_and_are_reported() {
        let f = Fixture::new();
        let path = f.0.join("prefs.json");
        fs::write(
            &path,
            r#"{"offInPandaCode":["ok","old(name)"],"projects":{"p":["old`name"]}}"#,
        )
        .unwrap();
        recover(&LAST_PREFS).remove(&path);
        let prefs = read_prefs(&path).unwrap();
        // Kept, so every exact-name check (catalogs, typed commands, bots) still treats them off.
        assert!(prefs.off_in_panda_code.contains("old(name)"));
        assert!(prefs.disabled(Some("p"), None).contains("old`name"));
        assert!(is_disabled(
            &launch_prefs(&path).off_in_panda_code,
            "old(name)"
        ));
        f.skill("home/.agents/skills/other", "---\nname: other\n---\n");
        let inventory = list_at(&f.0.join("home"), None, None, &path, &Homes::default()).unwrap();
        let value = serde_json::to_value(&inventory).unwrap();
        assert!(value["prefsWarning"]
            .as_str()
            .unwrap()
            .starts_with("2 saved switches"));
        assert!(value.get("prefsError").is_none());
        // A later save keeps them off rather than silently dropping them.
        set_at(
            &f.0.join("home"),
            None,
            None,
            &path,
            "other",
            false,
            &Homes::default(),
        )
        .unwrap();
        assert!(read_prefs(&path)
            .unwrap()
            .off_in_panda_code
            .contains("old(name)"));
        assert_eq!(prefs_warning(&Prefs::default()), None);
    }

    #[test]
    fn skill_manager_recovers_a_poisoned_preference_mutex() {
        let mutex = Mutex::new(());
        let _ = std::panic::catch_unwind(|| {
            let _guard = mutex.lock().unwrap();
            panic!("test poison");
        });
        drop(recover(&mutex));
    }

    #[test]
    fn skill_manager_reset_keeps_bad_files_and_clears_fail_closed_state() {
        let f = Fixture::new();
        let path = f.0.join("skill-manager.json");
        fs::write(&path, "broken primary").unwrap();
        fs::write(backup_path(&path), "broken recovery").unwrap();
        assert!(launch_prefs(&path).off_in_panda_code.contains("*"));
        reset_prefs(&path).unwrap();
        assert_eq!(read_prefs(&path).unwrap(), Prefs::default());
        assert_eq!(launch_prefs(&path), Prefs::default());
        let saved: Vec<_> = fs::read_dir(&f.0)
            .unwrap()
            .flatten()
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".backup"))
            .map(|entry| fs::read_to_string(entry.path()).unwrap())
            .collect();
        assert!(saved.iter().any(|v| v == "broken primary"));
        assert!(saved.iter().any(|v| v == "broken recovery"));
        assert_eq!(saved.len(), 3); // Timestamped originals plus the new recovery file.
    }

    #[test]
    fn skill_manager_missing_primary_self_heals_from_its_backup_so_toggling_works() {
        let f = Fixture::new();
        let path = f.0.join("prefs.json");
        let expected = Prefs::default().set("flagged", false, None);
        save_prefs(&path, &expected).unwrap();
        fs::remove_file(&path).unwrap();
        // With and without the in-memory copy, a strict read restores the primary.
        for forget in [false, true] {
            if forget {
                fs::remove_file(&path).unwrap();
                recover(&LAST_PREFS).remove(&path);
            }
            assert_eq!(read_prefs(&path).unwrap(), expected);
            assert!(path.is_file());
        }
        let home = f.0.join("home");
        f.skill("home/.agents/skills/other", "---\nname: other\n---\n");
        fs::remove_file(&path).unwrap();
        set_at(&home, None, None, &path, "other", false, &Homes::default()).unwrap();
        let saved = read_prefs(&path).unwrap();
        assert!(saved.off_in_panda_code.contains("flagged"));
        assert!(saved.off_in_panda_code.contains("other"));
        // An unreadable backup still refuses rather than guessing.
        fs::remove_file(&path).unwrap();
        fs::write(backup_path(&path), "broken").unwrap();
        assert!(read_prefs(&path).is_err());
    }

    #[test]
    fn skill_manager_failed_primary_save_does_not_become_the_last_good_settings() {
        let f = Fixture::new();
        let path = f.0.join("prefs.json");
        let before = Prefs::default().set("before", false, None);
        save_prefs(&path, &before).unwrap();
        // A non-empty folder at the primary path makes the final rename fail.
        fs::remove_file(&path).unwrap();
        fs::create_dir_all(path.join("occupied")).unwrap();
        let after = before.set("after", false, None);
        assert!(save_prefs(&path, &after).is_err());
        assert_eq!(recover(&LAST_PREFS).get(&path), Some(&before));
    }
}
