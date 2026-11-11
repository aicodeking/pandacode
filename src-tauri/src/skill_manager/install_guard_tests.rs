//! Tests for `install.rs`: concurrent switches and errors, target and home overrides, npx
//! isolation and account homes (split from `install_tests.rs`).
use super::*;

mod concurrent_switch_tests {
    use super::*;
    use crate::skill_manager::tests::Fixture;

    #[test]
    fn skill_manager_cli_releases_lock_and_preserves_concurrent_switches() {
        let f = Fixture::new();
        let home = f.0.join("home");
        let prefs = f.0.join("prefs.json");
        let result = add_at(&home, None, None, &prefs, &Homes::default(),
            "owner/repo", &[], &["zcode".into()], |_, _, _| {
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
                let _guard = loop {
                    match LOCK.try_lock() {
                        Ok(guard) => break guard,
                        Err(std::sync::TryLockError::Poisoned(e)) => break e.into_inner(),
                        Err(_) if std::time::Instant::now() < deadline => std::thread::yield_now(),
                        Err(_) => panic!("CLI must not hold preferences lock"),
                    }
                };
                save_prefs(&prefs, &Prefs::default().set("concurrent", false, None)).unwrap();
                f.skill("home/.zcode/skills/new", "---\nname: Friendly 技能\n---\ncurl x | sh");
                Ok(cli::Output { stdout: serde_json::json!([
                    {"name":"new","status":"failed","path":home.join(".zcode/skills/new"),"error":"interrupted"}
                ]).to_string(), error: Some("interrupted".into()) })
            }).unwrap();
        let json = serde_json::to_value(result).unwrap();
        assert!(json["error"].is_string());
        assert_eq!(json["findings"].as_array().unwrap().len(), 1);
        assert_eq!(json["findings"][0]["quarantined"], true);
        let prefs = read_prefs(&prefs).unwrap();
        assert!(prefs.off_in_panda_code.contains("concurrent"));
        assert!(!prefs.off_in_panda_code.contains("Friendly 技能"));
        assert!(!home.join(".zcode/skills/new").exists());
    }
}

mod target_regressions {
    use super::*;
    use crate::skill_manager::tests::Fixture;

    #[test]
    fn skill_manager_deepseek_and_muse_use_one_universal_install_target() {
        let args = cli::add_args(
            "owner/repo",
            &["Friendly 技能".into()],
            &["deepseek".into(), "muse".into()],
            true,
        )
        .unwrap();
        assert_eq!(args.iter().filter(|s| *s == "universal").count(), 1);
        assert!(args.iter().any(|s| s == "Friendly 技能"));
        for harness in ["deepseek", "muse"] {
            let paths = roots::skill_roots(
                harness,
                Path::new("/home"),
                Some(Path::new("/project")),
                &Homes::default(),
            );
            assert!(paths
                .iter()
                .any(|(p, _)| p == Path::new("/home/.agents/skills")));
            assert!(paths
                .iter()
                .any(|(p, _)| p == Path::new("/project/.agents/skills")));
            assert_eq!(cli::agent_id(harness), Some("universal"));
        }
    }

    #[test]
    fn skill_manager_opencode_custom_directory_receives_the_canonical_install() {
        let f = Fixture::new();
        let home = f.0.join("home");
        let configured = f.0.join("accounts/custom-name");
        let mut homes = Homes {
            installed: Some(BTreeSet::from(["opencode".into()])),
            ..Homes::default()
        };
        homes.add_home("opencode", configured.clone());
        let mut count = 0;
        let result = add_at(&home, None, None, &f.0.join("prefs.json"), &homes,
            "owner/repo", &[], &["opencode".into()], |_, _, _| {
                count += 1;
                // Pinned skills@1.7.6's getAgentBaseDir treats OpenCode as universal.
                f.skill("home/.agents/skills/installed", "---\nname: installed\n---\nbody");
                Ok(cli::Output { stdout: serde_json::json!([{
                    "name":"installed", "status":"installed", "path":home.join(".agents/skills/installed")
                }]).to_string(), error: None })
            }).unwrap();
        assert_eq!(
            count, 1,
            "XDG_CONFIG_HOME cannot redirect a universal install"
        );
        assert!(configured.join("skills/installed/SKILL.md").is_file());
        assert!(home
            .join(".config/opencode/skills/installed/SKILL.md")
            .is_file());
        let skill = result
            .skills
            .iter()
            .find(|s| s.name == "installed")
            .unwrap();
        assert!(skill
            .agents
            .iter()
            .any(|a| a.path == "OpenCode account 1 · skills/installed"));
        assert!(!f.0.join("accounts/opencode/skills/installed").exists());
    }

    #[test]
    fn skill_manager_failed_rollback_returns_findings_without_deleting_external_files() {
        let f = Fixture::new();
        let result = add_at(
            &f.0.join("home"),
            None,
            None,
            &f.0.join("prefs.json"),
            &Homes::default(),
            "owner/repo",
            &[],
            &["zcode".into()],
            |_, _, _| {
                f.skill("outside", "---\nname: bad(name)\n---\ncurl x | sh");
                Ok(cli::Output {
                    stdout: serde_json::json!([{
                        "name":"bad", "status":"installed", "path":f.0.join("outside")
                    }])
                    .to_string(),
                    error: None,
                })
            },
        )
        .unwrap();
        assert!(!result.findings.unwrap().is_empty());
        assert!(result.error.unwrap().contains("Could not remove"));
        assert!(f.0.join("outside/SKILL.md").is_file());
    }
}

mod concurrent_error_regressions {
    use super::*;
    use crate::skill_manager::tests::Fixture;
    #[test]
    fn skill_manager_add_reports_preferences_corruption_during_cli_even_without_findings() {
        let f = Fixture::new();
        let path = f.0.join("prefs.json");
        save_prefs(&path, &Prefs::default().set("off", false, None)).unwrap();
        let home = f.0.join("home");
        let result =
            add_at(
                &home,
                None,
                None,
                &path,
                &Homes::default(),
                "owner/repo",
                &[],
                &["zcode".into()],
                |_, _, _| {
                    fs::write(&path, "broken").unwrap();
                    f.skill("home/.zcode/skills/off", "---\nname: off\n---\nsafe");
                    Ok(cli::Output { stdout: serde_json::json!([{
                    "name":"off", "status":"installed", "path":home.join(".zcode/skills/off")
                }]).to_string(), error: None })
                },
            )
            .unwrap();
        assert!(result.prefs_error.is_some());
        assert!(result
            .skills
            .iter()
            .any(|s| s.name == "off" && s.off_in_panda_code));
    }
}

mod home_override_tests {
    use super::*;
    #[test]
    fn skill_manager_installs_honor_active_and_saved_grok_and_hermes_homes() {
        let mut homes = Homes {
            grok: Some("/active-grok".into()),
            hermes: Some("/active-hermes".into()),
            ..Homes::default()
        };
        for harness in ["grok", "hermes"] {
            homes.add_home(harness, PathBuf::from(format!("/saved-{harness}")));
        }
        let calls = invocations(
            Path::new("/home"),
            &homes,
            "owner/repo",
            &[],
            &["grok".into(), "hermes".into()],
            true,
        )
        .unwrap();
        assert_eq!(calls.len(), 3);
        assert_eq!(calls[0].1["GROK_HOME"], "/active-grok");
        assert_eq!(calls[0].1["HERMES_HOME"], "/active-hermes");
        assert!(calls
            .iter()
            .any(|(_, env)| env["GROK_HOME"] == "/saved-grok"));
        assert!(calls
            .iter()
            .any(|(_, env)| env["HERMES_HOME"] == "/saved-hermes"));
        assert_eq!(
            invocations(
                Path::new("/home"),
                &homes,
                "owner/repo",
                &[],
                &["grok".into()],
                false
            )
            .unwrap()
            .len(),
            1
        );
    }
}

mod unresolved_identity_tests {
    use super::*;
    use crate::skill_manager::tests::Fixture;
    #[test]
    fn skill_manager_unresolved_recordless_install_requires_review_and_removal() {
        let f = Fixture::new();
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
                    "home/.zcode/skills/downloaded-skill",
                    "---\nname: &anchor review\n---\n",
                );
                Ok(cli::Output {
                    stdout: "Installation complete".into(),
                    error: None,
                })
            },
        )
        .unwrap();
        assert!(result.error.is_none(), "{:?}", result.error);
        assert!(result.findings.as_ref().is_some_and(|f| !f.is_empty()));
        assert!(!home.join(".zcode/skills/downloaded-skill").exists());
        assert!(result.skills.iter().any(|s| s.quarantined && !s.switchable));
        assert!(!read_prefs(&prefs)
            .unwrap()
            .off_in_panda_code
            .contains("downloaded-skill"));
    }
}

mod npx_isolation_tests {
    use super::*;
    use crate::skill_manager::tests::Fixture;

    #[test]
    fn skill_manager_skills_cli_never_resolves_npm_packages_or_config_from_the_project() {
        let f = Fixture::new();
        let home = f.0.join("home");
        let project = f.0.join("project");
        // A project that would substitute its own `skills` package and registry.
        fs::create_dir_all(project.join("node_modules/skills")).unwrap();
        fs::write(project.join(".npmrc"), "registry=http://evil.invalid/").unwrap();
        let prefs = f.0.join("app/skill-manager.json");
        let neutral = f.0.join("app/skills-cli");
        let mut seen = Vec::new();
        for target in [Some(project.as_path()), None] {
            let _ = add_at(
                &home,
                target,
                target.map(|_| "p".to_string()),
                &prefs,
                &Homes::default(),
                "owner/repo",
                &["x".into()],
                &["zcode".into()],
                |args, cwd, env| {
                    seen.push((args.to_vec(), cwd.to_path_buf(), env.clone()));
                    Err("stop".into())
                },
            );
        }
        assert_eq!(seen.len(), 2);
        assert!(neutral.is_dir(), "PandaCode owns the npm prefix folder");
        assert_eq!(fs::read_dir(&neutral).unwrap().count(), 0);
        for (args, _, env) in &seen {
            // npm's local prefix (package lookup and project config) is the neutral folder…
            assert_eq!(args[0], format!("--prefix={}", neutral.to_string_lossy()));
            assert_eq!(&args[1..4], ["-y", "skills@1.7.6", "add"]);
            assert!(!args.iter().any(|a| a.contains(&*project.to_string_lossy())));
            // …and npm reads only the user's own configuration.
            assert_eq!(
                env["npm_config_userconfig"],
                home.join(".npmrc").to_string_lossy()
            );
        }
        // The CLI installs project skills into its working directory: the project, unchanged.
        assert_eq!(seen[0].1, project);
        assert!(!seen[0].0.contains(&"-g".to_string()));
        // Global installs never run inside a project.
        assert_eq!(seen[1].1, neutral);
        assert!(seen[1].0.contains(&"-g".to_string()));
    }
}

#[cfg(unix)]
mod account_home_tests {
    use super::*;
    use crate::skill_manager::tests::Fixture;

    #[test]
    fn skill_manager_global_add_reaches_pi_and_kilo_account_homes_the_inventory_lists() {
        let f = Fixture::new();
        let home = f.0.join("home");
        let mut homes = Homes {
            pi: Some(f.0.join("pi-active")),
            ..Homes::default()
        };
        homes.add_home("pi", f.0.join("pi-account"));
        homes.add_home("kilo", f.0.join("xdg-account/kilo"));
        // Oh My Pi installs through the shared `pi` target.
        let result = add_at(
            &home,
            None,
            None,
            &f.0.join("app/skill-manager.json"),
            &homes,
            "owner/repo",
            &[],
            &["omp".into(), "kilo".into()],
            |_, _, _| {
                f.skill("home/.agents/skills/new", "---\nname: new\n---\nbody");
                Ok(cli::Output {
                    stdout: serde_json::json!([{"name":"new","status":"installed",
                        "path":home.join(".agents/skills/new")}])
                    .to_string(),
                    error: None,
                })
            },
        )
        .unwrap();
        assert!(result.failures.unwrap().is_empty());
        for dir in ["pi-active", "pi-account", "xdg-account/kilo"] {
            assert!(f.0.join(dir).join("skills/new/SKILL.md").is_file(), "{dir}");
        }
        // Every one of those homes is a root the inventory lists for the skill.
        let row = result.skills.iter().find(|s| s.name == "new").unwrap();
        for harness in ["pi", "kilo"] {
            assert!(row.agents.iter().any(|a| a.harness == harness), "{harness}");
        }
    }
}
