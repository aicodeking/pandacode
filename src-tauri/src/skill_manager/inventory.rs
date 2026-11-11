#[cfg(test)]
thread_local! { pub(super) static ROOT_READS: std::cell::RefCell<BTreeMap<PathBuf, usize>> = const { std::cell::RefCell::new(BTreeMap::new()) }; }
use super::*;

fn sources(path: &Path) -> BTreeMap<String, String> {
    let Some(value) =
        read_text(path).and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
    else {
        return BTreeMap::new();
    };
    value["skills"]
        .as_object()
        .into_iter()
        .flatten()
        .filter_map(|(name, entry)| {
            entry["source"]
                .as_str()
                .map(|source| (name.clone(), source.to_string()))
        })
        .collect()
}

fn plugin_roots(
    harness: &str,
    home: &Path,
    project: Option<&Path>,
    homes: &Homes,
) -> Vec<(PathBuf, String, Option<String>, &'static str)> {
    let mut result = Vec::new();
    for (skills, display) in roots::skill_roots(harness, home, None, homes) {
        result.extend(plugin_root(&skills, &display, home, project));
    }
    result
}
fn plugin_root(
    skills: &Path,
    display: &str,
    home: &Path,
    project: Option<&Path>,
) -> Vec<(PathBuf, String, Option<String>, &'static str)> {
    let Some(config) = skills.parent() else {
        return Vec::new();
    };
    let Some(registry) = read_text(&config.join("plugins/installed_plugins.json"))
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
    else {
        return Vec::new();
    };
    let mut roots = Vec::new();
    for (key, installs) in registry["plugins"].as_object().into_iter().flatten() {
        let name = key.split('@').next().unwrap_or(key);
        for install in installs.as_array().into_iter().flatten() {
            let user = install["scope"].as_str() == Some("user");
            if !user
                && !project.is_some_and(|p| {
                    install["projectPath"]
                        .as_str()
                        .is_some_and(|path| checkout_key(p) == checkout_key(Path::new(path)))
                })
            {
                continue;
            }
            let Some(path) = install["installPath"].as_str() else {
                continue;
            };
            let root = PathBuf::from(path).join("skills");
            let display = if user {
                roots::display_path(&root, home, &format!("{display} · plugin {name} · skills"))
            } else {
                format!(".claude/plugins/{name}/skills")
            };
            roots.push((
                root,
                display,
                Some(name.to_owned()),
                if user { "user" } else { "project" },
            ));
        }
    }
    roots
}

#[derive(Clone)]
struct Found {
    relative: String,
    fallback: String,
    name: String,
    description: String,
    resolved: bool,
    /// Why the identity is unresolved, shown as the row's `unswitchableReason`.
    reason: &'static str,
}

#[derive(Default)]
struct Scan {
    roots: BTreeMap<PathBuf, Vec<Found>>,
    not_shown: usize,
}
impl Scan {
    fn root(&mut self, root: &Path) -> &[Found] {
        let key = fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
        let not_shown = &mut self.not_shown;
        self.roots.entry(key.clone()).or_insert_with(|| {
            #[cfg(test)]
            if key.exists() {
                ROOT_READS.with(|reads| *reads.borrow_mut().entry(key).or_default() += 1);
            }
            let mut found = Vec::new();
            let mut pending = vec![(root.to_path_buf(), 0)];
            let mut visited = BTreeSet::new();
            let mut count = 0;
            while let Some((dir, depth)) = pending.pop() {
                if count >= 4096 {
                    *not_shown += pending.len() + 1;
                    break;
                }
                count += 1;
                let real = match fs::canonicalize(&dir) {
                    Ok(real) => real,
                    Err(error) => {
                        *not_shown += usize::from(error.kind() != std::io::ErrorKind::NotFound);
                        continue;
                    }
                };
                if !visited.insert(real) {
                    continue;
                }
                if dir != root {
                    let fallback = || {
                        dir.file_name()
                            .unwrap_or_default()
                            .to_string_lossy()
                            .into_owned()
                    };
                    let relative = || {
                        dir.strip_prefix(root)
                            .unwrap_or(&dir)
                            .to_string_lossy()
                            .replace('\\', "/")
                    };
                    if skill_md_escapes(&dir.join("SKILL.md")) {
                        found.push(Found {
                            relative: relative(),
                            name: fallback(),
                            fallback: fallback(),
                            description: String::new(),
                            resolved: false,
                            reason: LINKED_OUT,
                        });
                        continue;
                    }
                    if let Some(text) = skill_text(&dir.join("SKILL.md")) {
                        let (name, description) = metadata::frontmatter(&text);
                        found.push(Found {
                            relative: relative(),
                            resolved: name.is_some(),
                            reason: UNRESOLVED,
                            name: name.unwrap_or_else(fallback),
                            fallback: fallback(),
                            description: description.unwrap_or_default(),
                        });
                        continue;
                    }
                }
                let Ok(entries) = fs::read_dir(&dir) else {
                    *not_shown += usize::from(dir.exists());
                    continue;
                };
                let mut dirs = Vec::new();
                for entry in entries {
                    match entry {
                        // What a failed delete of a moved folder left behind.
                        Ok(entry) if quarantine::set_aside::is_set_aside(&entry.file_name()) => {}
                        Ok(entry) if entry.path().is_dir() => {
                            if depth >= 4 || dirs.len() + pending.len() + count >= 4096 {
                                *not_shown += 1;
                            } else {
                                dirs.push(entry.path());
                            }
                        }
                        Err(_) => *not_shown += 1,
                        _ => {}
                    }
                }
                dirs.sort();
                pending.extend(dirs.into_iter().rev().map(|path| (path, depth + 1)));
            }
            found
        })
    }
    #[allow(clippy::too_many_arguments)]
    fn collect(
        &mut self,
        home: &Path,
        project: Option<&Path>,
        project_id: Option<&str>,
        homes: &Homes,
        include_user: bool,
        label: Option<&str>,
        skills: &mut BTreeMap<String, ManagedSkill>,
    ) {
        let global_sources = if include_user {
            sources(&home.join(".agents/.skill-lock.json"))
        } else {
            BTreeMap::new()
        };
        let project_sources = project
            .map(|p| sources(&p.join("skills-lock.json")))
            .unwrap_or_default();
        for (harness, _) in crate::providers::PROVIDERS {
            let plugins = if harness == "codex" {
                roots::codex_plugins(home, homes)
            } else {
                Vec::new()
            };
            let user_roots = roots::skill_roots(harness, home, None, homes);
            let mut roots: Vec<_> = roots::skill_roots(harness, home, project, homes)
                .into_iter()
                .map(|(root, display)| {
                    let scope = if user_roots.iter().any(|(p, _)| *p == root) {
                        "user"
                    } else {
                        "project"
                    };
                    let plugin = plugins
                        .iter()
                        .find(|(path, _, _)| *path == root)
                        .map(|(_, _, name)| name.clone());
                    (root, display, plugin, scope)
                })
                .collect();
            if matches!(harness, "claude" | "glm" | "mimo") {
                roots.extend(plugin_roots(harness, home, project, homes));
            }
            for (root, display, plugin, scope) in roots {
                if !include_user && scope == "user" {
                    continue;
                }
                let real_root = fs::canonicalize(&root).unwrap_or_else(|_| root.clone());
                for found in self.root(&root) {
                    let name = plugin
                        .as_ref()
                        .map(|p| format!("{p}:{}", found.name))
                        .unwrap_or_else(|| found.name.clone());
                    let sources = if scope == "user" {
                        &global_sources
                    } else {
                        &project_sources
                    };
                    let source = plugin.clone().or_else(|| {
                        sources
                            .get(&name)
                            .or_else(|| sources.get(&found.fallback))
                            .cloned()
                    });
                    let skill = skills.entry(name.clone()).or_insert_with(|| {
                        ManagedSkill::new(
                            name,
                            found.description.clone(),
                            source.clone(),
                            found.resolved,
                        )
                    });
                    if !found.resolved {
                        skill.switchable = false;
                        skill.unswitchable_reason = Some(found.reason);
                    }
                    if skill.description.is_empty() {
                        skill.description.clone_from(&found.description);
                    }
                    if skill.source.is_none() {
                        skill.source = source;
                    }
                    let project_id = (scope == "project")
                        .then(|| project_id.map(str::to_owned))
                        .flatten();
                    let real = real_root.join(&found.relative);
                    if skill.agents.iter().any(|agent| {
                        agent.harness == harness
                            && agent.scope == scope
                            && agent.project_id == project_id
                            && agent.real.as_ref() == Some(&real)
                    }) {
                        continue;
                    }
                    skill.agents.push(SkillAgent {
                        harness: harness.into(),
                        scope: scope.into(),
                        path: match label.filter(|_| scope == "project") {
                            Some(label) => {
                                format!("{label}{LABEL_SEP}{display}/{}", found.relative)
                            }
                            None => format!("{display}/{}", found.relative),
                        },
                        project_id,
                        quarantined: false,
                        real: Some(real),
                    });
                }
            }
        }
    }
}

/// Switches saved for names that are no longer installed stay visible so they can be cleared.
fn add_missing(
    skills: &mut BTreeMap<String, ManagedSkill>,
    prefs: &Prefs,
    project_id: Option<&str>,
    project: Option<&Path>,
    homes: &Homes,
) {
    let mut names: BTreeSet<String> = prefs.off_in_panda_code.clone();
    if project_id.is_some() {
        names.extend(prefs.project_names(project_id, project));
    } else {
        for (id, path) in &homes.projects {
            names.extend(prefs.project_names(Some(id), Some(path)));
        }
    }
    for name in names {
        if name == "*" || skills.contains_key(&name) {
            continue;
        }
        let mut skill = ManagedSkill::new(name.clone(), String::new(), None, true);
        skill.missing = true;
        skills.insert(name, skill);
    }
}

pub(super) fn attribute(
    items: &mut [ManagedSkill],
    prefs: &Prefs,
    project_id: Option<&str>,
    project: Option<&Path>,
    homes: &Homes,
) {
    let project_off = prefs.project_names(project_id, project);
    let projects: BTreeMap<_, _> = homes
        .projects
        .iter()
        .map(|(id, path)| (id.clone(), prefs.project_names(Some(id), Some(path))))
        .collect();
    for skill in items {
        skill.off_in_panda_code =
            prefs.off_in_panda_code.contains("*") || prefs.off_in_panda_code.contains(&skill.name);
        skill.off_in_project = project_id.is_some() && project_off.contains(&skill.name);
        skill.off_in_projects = projects
            .iter()
            .filter(|(_, names)| names.contains(&skill.name))
            .map(|(id, _)| id.clone())
            .collect();
        if let Some(id) = project_id.filter(|_| skill.off_in_project) {
            if !skill.off_in_projects.iter().any(|p| p == id) {
                skill.off_in_projects.push(id.into());
                skill.off_in_projects.sort();
            }
        }
    }
}

#[cfg(test)]
pub(super) fn inventory(
    home: &Path,
    project: Option<&Path>,
    project_id: Option<&str>,
    prefs: &Prefs,
    homes: &Homes,
) -> Vec<ManagedSkill> {
    collect(home, project, project_id, prefs, homes, false).0
}

/// Between a task worktree's label and a location in it (`Worktree app · .claude/skills/x`).
pub(super) const LABEL_SEP: &str = " · ";

/// How the inventory labels a task worktree's locations; `safety::worktree_folders` maps the
/// label back to the worktree.
pub(super) fn worktree_label(path: &Path) -> String {
    let folder = path.file_name().unwrap_or_default().to_string_lossy();
    format!("Worktree {folder}")
}

#[cfg(test)]
thread_local! {
    /// Root scans run on this thread (tests prove a save reuses the last scan).
    pub(super) static SCANS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

fn collect(
    home: &Path,
    project: Option<&Path>,
    project_id: Option<&str>,
    prefs: &Prefs,
    homes: &Homes,
    all: bool,
) -> (Vec<ManagedSkill>, usize) {
    #[cfg(test)]
    SCANS.with(|scans| scans.set(scans.get() + 1));
    let mut scan = Scan::default();
    let mut skills = BTreeMap::new();
    scan.collect(home, project, project_id, homes, true, None, &mut skills);
    if all && project_id.is_none() {
        for (id, path) in &homes.projects {
            scan.collect(home, Some(path), Some(id), homes, false, None, &mut skills);
        }
    }
    if all {
        let mains: BTreeSet<_> = homes
            .projects
            .iter()
            .map(|(_, p)| p.as_path())
            .chain(project)
            .map(checkout_key)
            .collect();
        for (id, path) in &homes.worktrees {
            // A project view shows its own worktrees; All projects shows every listed project's.
            if project_id.is_some_and(|current| current != id)
                || mains.contains(&checkout_key(path))
            {
                continue;
            }
            let label = worktree_label(path);
            scan.collect(
                home,
                Some(path),
                Some(id),
                homes,
                false,
                Some(&label),
                &mut skills,
            );
        }
    }
    add_missing(&mut skills, prefs, project_id, project, homes);
    let mut items: Vec<_> = skills.into_values().collect();
    for skill in &mut items {
        skill.agents.sort_by(|a, b| {
            (&a.harness, &a.scope, &a.path, &a.project_id).cmp(&(
                &b.harness,
                &b.scope,
                &b.path,
                &b.project_id,
            ))
        });
        skill.agents.dedup_by(|a, b| {
            a.harness == b.harness
                && a.scope == b.scope
                && a.path == b.path
                && a.project_id == b.project_id
        });
    }
    attribute(&mut items, prefs, project_id, project, homes);
    (items, scan.not_shown + homes.not_shown)
}

#[cfg(test)]
pub(super) fn all_inventory(
    home: &Path,
    project: Option<&Path>,
    project_id: Option<&str>,
    prefs: &Prefs,
    homes: &Homes,
) -> Vec<ManagedSkill> {
    with_counts(home, project, project_id, prefs, homes).0
}

pub(super) fn with_counts(
    home: &Path,
    project: Option<&Path>,
    project_id: Option<&str>,
    prefs: &Prefs,
    homes: &Homes,
) -> (Vec<ManagedSkill>, usize) {
    collect(home, project, project_id, prefs, homes, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::skill_manager::tests::Fixture;
    #[test]
    fn skill_manager_unresolved_identity_cannot_save_a_guessed_selector() {
        let f = Fixture::new();
        f.skill(
            "home/.agents/skills/downloaded-skill",
            "---\nname: &anchor review\n---\n",
        );
        let home = f.0.join("home");
        let homes = Homes::default();
        let items = inventory(&home, None, None, &Prefs::default(), &homes);
        assert!(!items[0].switchable);
        assert!(serde_json::to_value(&items[0]).unwrap()["unswitchableReason"].is_string());
        assert!(set_at(
            &home,
            None,
            None,
            &f.0.join("prefs.json"),
            "downloaded-skill",
            false,
            &homes
        )
        .is_err());
        let listed = list_with_prefs(&home, None, None, &Prefs::default(), &homes);
        let findings = safety::scan_installed(&home, None, &homes, &listed, &[], None);
        assert!(findings.iter().any(|f| f.skill == "downloaded-skill"));
    }
    #[test]
    fn skill_manager_multiline_description_disables_the_declared_name() {
        let f = Fixture::new();
        f.skill(
            "home/.agents/skills/downloaded-skill",
            "---\nname: review\ndescription: \"First line\n\n  second line\"\n---\n",
        );
        let items = set_at(
            &f.0.join("home"),
            None,
            None,
            &f.0.join("prefs.json"),
            "review",
            false,
            &Homes::default(),
        )
        .unwrap();
        assert_eq!(items[0].name, "review");
        assert!(items[0].switchable && items[0].off_in_panda_code);
    }
    #[test]
    fn skill_manager_codex_plugins_only_include_enabled_active_cache_versions() {
        let f = Fixture::new();
        let config = f.0.join("account");
        for (plugin, version, skill) in [
            ("enabled", "1.9.0", "old"),
            ("enabled", "1.10.0", "current"),
            ("disabled", "1.0.0", "disabled"),
            ("absent", "1.0.0", "absent"),
        ] {
            let root = format!("account/plugins/cache/market/{plugin}/{version}");
            f.skill(
                &format!("{root}/skills/{skill}"),
                &format!("---\nname: {skill}\n---\n"),
            );
            let manifest = f.0.join(&root).join(".codex-plugin");
            fs::create_dir_all(&manifest).unwrap();
            fs::write(
                manifest.join("plugin.json"),
                serde_json::json!({"name":plugin,"skills":"./skills"}).to_string(),
            )
            .unwrap();
        }
        fs::write(config.join("config.toml"), "[plugins.\"enabled@market\"]\nenabled=true\n[plugins.\"disabled@market\"]\nenabled=false\n").unwrap();
        let homes = Homes {
            codex: Some(config),
            ..Homes::default()
        };
        let items = inventory(&f.0.join("home"), None, None, &Prefs::default(), &homes);
        assert_eq!(items.len(), 1, "{items:?}");
        assert_eq!(items[0].name, "enabled:current");
        assert!(items[0]
            .agents
            .iter()
            .all(|a| a.harness == "codex" && a.scope == "user"));
        assert!(!serde_json::to_string(&items)
            .unwrap()
            .contains(f.0.to_str().unwrap()));
    }
}

#[cfg(test)]
mod behavior_tests {
    use crate::skill_manager::tests::Fixture;
    use crate::skill_manager::*;
    #[test]
    fn skill_manager_configured_paths_and_capabilities_never_expose_absolute_dirs() {
        let f = Fixture::new();
        f.skill("private-account/skills/one", "body");
        f.skill("home/account/skills/two", "body");
        let home = f.0.join("home");
        let mut homes = Homes::default();
        homes.add_home("claude", f.0.join("private-account"));
        homes.add_home("claude", home.join("account"));
        let roots = roots::skill_roots("claude", &home, None, &homes);
        assert!(roots.iter().any(|(_, label)| label == "~/account/skills"));
        assert!(roots
            .iter()
            .all(|(_, label)| !label.contains(f.0.to_str().unwrap())));
        let items = inventory(&home, None, None, &Prefs::default(), &homes);
        let json = serde_json::to_string(&items).unwrap();
        assert!(!json.contains(f.0.to_str().unwrap()));
        assert!(items
            .iter()
            .flat_map(|s| &s.agents)
            .all(|a| a.scope == "user"));
    }

    #[test]
    fn skill_manager_all_projects_reports_off_project_ids_and_set_keeps_them() {
        let f = Fixture::new();
        f.skill("home/.agents/skills/shared", "---\nname: shared\n---\nbody");
        let homes = Homes {
            projects: vec![
                ("one".into(), f.0.join("p1")),
                ("two".into(), f.0.join("p2")),
            ],
            ..Homes::default()
        };
        let prefs =
            Prefs::default()
                .set("shared", false, Some("two"))
                .set("shared", false, Some("one"));
        let path = f.0.join("prefs.json");
        save_prefs(&path, &prefs).unwrap();
        let items = inventory::all_inventory(&f.0.join("home"), None, None, &prefs, &homes);
        assert_eq!(
            serde_json::to_value(&items[0]).unwrap()["offInProjects"],
            serde_json::json!(["one", "two"])
        );
        let items = set_at(
            &f.0.join("home"),
            None,
            None,
            &path,
            "shared",
            false,
            &homes,
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(&items[0]).unwrap()["offInProjects"],
            serde_json::json!(["one", "two"])
        );
    }

    #[test]
    fn skill_manager_inventory_scans_each_canonical_root_once_for_three_projects_and_set() {
        let f = Fixture::new();
        f.skill("home/.agents/skills/shared", "---\nname: shared\n---\nbody");
        let mut homes = Homes::default();
        for i in 1..=3 {
            f.skill(&format!("p{i}/.agents/skills/local"), "body");
            homes
                .projects
                .push((i.to_string(), f.0.join(format!("p{i}"))));
        }
        let home = f.0.join("home");
        let assert_once = || {
            inventory::ROOT_READS.with(|reads| {
                let reads = reads.borrow();
                assert_eq!(reads.len(), 4, "{reads:?}");
                assert!(reads.values().all(|count| *count == 1), "{reads:?}");
            })
        };
        inventory::ROOT_READS.with(|r| r.borrow_mut().clear());
        inventory::all_inventory(&home, None, None, &Prefs::default(), &homes);
        assert_once();
        inventory::ROOT_READS.with(|r| r.borrow_mut().clear());
        set_at(
            &home,
            None,
            None,
            &f.0.join("prefs.json"),
            "shared",
            false,
            &homes,
        )
        .unwrap();
        assert_once();
    }

    #[test]
    fn skill_manager_library_and_inventory_share_block_frontmatter_behavior() {
        let f = Fixture::new();
        let text =
        "---\nname: >-\n  Friendly skill\ndescription: |+\n  First line\n  second line\n---\nBody";
        f.skill("home/.agents/skills/fallback", text);
        let (name, description, body) = crate::skills::frontmatter(text);
        assert_eq!(name.as_deref(), Some("Friendly skill"));
        assert_eq!(description.as_deref(), Some("First line second line"));
        assert_eq!(body, "Body");
        let items = inventory(
            &f.0.join("home"),
            None,
            None,
            &Prefs::default(),
            &Homes::default(),
        );
        assert_eq!(items[0].name, "Friendly skill");
        assert_eq!(items[0].description, "First line second line");
    }

    #[test]
    fn skill_manager_oversized_non_utf8_skill_is_visible_but_not_switchable() {
        let f = Fixture::new();
        f.skill("home/.agents/skills/visible", "body");
        fs::write(
            f.0.join("home/.agents/skills/visible/SKILL.md"),
            vec![255; MAX_BYTES as usize + 1],
        )
        .unwrap();
        let items = inventory(
            &f.0.join("home"),
            None,
            None,
            &Prefs::default(),
            &Homes::default(),
        );
        assert!(items.iter().any(|s| s.name == "visible" && !s.switchable));
    }

    #[test]
    fn skill_manager_metadata_redacts_secrets_at_ipc_without_changing_identity() {
        let f = Fixture::new();
        let token = "ghp_1234567890abcdefghijklmnopqrstuvwxyz";
        f.skill(
            &format!("home/.agents/skills/{token}"),
            &format!("---\nname: {token}\ndescription: a {token} b\n---"),
        );
        let items = list_with_prefs(
            &f.0.join("home"),
            None,
            None,
            &Prefs::default(),
            &Homes::default(),
        );
        assert_eq!(items.skills[0].name, token);
        assert!(!items.skills[0].switchable);
        let json = serde_json::to_string(&items).unwrap();
        assert!(!json.contains(token));
        assert!(json.contains("[secret redacted]"));
    }

    #[test]
    fn skill_manager_inventory_counts_omitted_directories_once_and_projects() {
        let f = Fixture::new();
        f.skill("home/.agents/skills/a/b/c/d/e/hidden", "body");
        let homes = Homes {
            not_shown: 2,
            ..Homes::default()
        };
        let items = list_with_prefs(&f.0.join("home"), None, None, &Prefs::default(), &homes);
        // The universal root is shared by several harnesses but counted only once.
        assert_eq!(items.not_shown, Some(3));
    }

    #[test]
    fn skill_manager_inventory_reports_directory_entry_cap() {
        let f = Fixture::new();
        let root = f.0.join("home/.agents/skills");
        fs::create_dir_all(&root).unwrap();
        for i in 0..4100 {
            fs::create_dir(root.join(i.to_string())).unwrap();
        }
        let items = list_with_prefs(
            &f.0.join("home"),
            None,
            None,
            &Prefs::default(),
            &Homes::default(),
        );
        assert!(items.not_shown.is_some_and(|count| count >= 5));
    }
}
