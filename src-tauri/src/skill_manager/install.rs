use super::*;

#[derive(Debug, Serialize, PartialEq, Eq, PartialOrd, Ord)]
pub(super) struct Failure {
    #[serde(serialize_with = "safety::serialize_warning")]
    pub(super) skill: String,
    #[serde(serialize_with = "safety::serialize_warning")]
    pub(super) reason: String,
}

fn environment(home: &Path, homes: &Homes) -> BTreeMap<String, String> {
    [
        ("CLAUDE_CONFIG_DIR", homes.claude.as_ref(), ".claude"),
        ("CODEX_HOME", homes.codex.as_ref(), ".codex"),
        ("XDG_CONFIG_HOME", homes.xdg_config.as_ref(), ".config"),
        ("GROK_HOME", homes.grok.as_ref(), ".grok"),
        ("HERMES_HOME", homes.hermes.as_ref(), ".hermes"),
    ]
    .into_iter()
    .map(|(key, path, default)| {
        (
            key.into(),
            path.filter(|p| p.is_absolute())
                .cloned()
                .unwrap_or_else(|| home.join(default))
                .to_string_lossy()
                .into_owned(),
        )
    })
    .collect()
}

type Invocation = (Vec<String>, BTreeMap<String, String>);

fn invocations(
    home: &Path,
    homes: &Homes,
    source: &str,
    skills: &[String],
    harnesses: &[String],
    global: bool,
) -> Result<Vec<Invocation>, String> {
    let env = environment(home, homes);
    let mut calls = vec![(
        cli::add_args(source, skills, harnesses, global)?,
        env.clone(),
    )];
    if !global {
        return Ok(calls);
    }
    let mut extra: BTreeMap<(&str, String), (PathBuf, Vec<String>)> = BTreeMap::new();
    for (harness, dirs) in &homes.configured {
        if !harnesses
            .iter()
            .any(|id| cli::agent_id(id) == cli::agent_id(harness))
        {
            continue;
        }
        let key = match harness.as_str() {
            "claude" | "glm" | "mimo" => "CLAUDE_CONFIG_DIR",
            // skills 1.7.6 treats OpenCode as universal, so XDG cannot redirect its
            // destination. Link its canonical installs to the exact account roots below.
            "devin" => "XDG_CONFIG_HOME",
            "grok" => "GROK_HOME",
            "hermes" => "HERMES_HOME",
            _ => continue,
        };
        for dir in dirs {
            let config = if key == "XDG_CONFIG_HOME" {
                dir.parent().unwrap_or(dir)
            } else {
                dir
            };
            if !config.is_absolute() || checkout_key(config) == checkout_key(Path::new(&env[key])) {
                continue;
            }
            let (_, targets) = extra
                .entry((key, checkout_key(config)))
                .or_insert_with(|| (config.to_path_buf(), Vec::new()));
            if !targets.contains(harness) {
                targets.push(harness.clone());
            }
        }
    }
    for ((key, _), (path, targets)) in extra {
        let mut env = env.clone();
        env.insert(key.into(), path.to_string_lossy().into_owned());
        calls.push((cli::add_args(source, skills, &targets, true)?, env));
    }
    Ok(calls)
}

impl Failure {
    pub(super) fn new(skill: &str, reason: String) -> Self {
        Self {
            skill: skill.into(),
            reason,
        }
    }
}

/// Entries read per skill root before the CLI runs (fewer in tests, to reach the limit).
const SNAPSHOT_LIMIT: usize = if cfg!(test) { 16 } else { 8192 };

/// Entries of every skill root in this scope before the CLI runs; anything else is new. A root
/// with more entries than the limit is `overflowed`: every entry in it counts as pre-existing,
/// so nothing there is ever quarantine-moved (it is switched off instead).
#[derive(Default)]
struct Snapshot {
    entries: BTreeSet<PathBuf>,
    overflowed: BTreeSet<PathBuf>,
}
impl Snapshot {
    /// `key` is an `entry_key`.
    fn existed(&self, key: &Path) -> bool {
        self.entries.contains(key) || key.parent().is_some_and(|p| self.overflowed.contains(p))
    }
}
fn snapshot(home: &Path, project: Option<&Path>, homes: &Homes) -> Snapshot {
    let mut snapshot = Snapshot::default();
    for (id, _) in crate::providers::PROVIDERS {
        for (root, _) in roots::skill_roots(id, home, project, homes) {
            let Ok(entries) = fs::read_dir(&root) else {
                continue;
            };
            let mut entries = entries.flatten();
            for entry in entries.by_ref().take(SNAPSHOT_LIMIT) {
                snapshot.entries.insert(entry_key(&entry.path()));
            }
            if entries.next().is_some() {
                eprintln!(
                    "Warning: {} has more than {SNAPSHOT_LIMIT} entries; a flagged install there is switched off instead of quarantined.",
                    root.display()
                );
                snapshot
                    .overflowed
                    .insert(fs::canonicalize(&root).unwrap_or(root));
            }
        }
    }
    snapshot
}
/// The path with a canonical parent, so links and aliases of a root compare equal.
fn entry_key(path: &Path) -> PathBuf {
    match (
        path.parent().and_then(|p| fs::canonicalize(p).ok()),
        path.file_name(),
    ) {
        (Some(parent), Some(name)) => parent.join(name),
        _ => path.to_path_buf(),
    }
}

fn failed_all<'a>(skills: &'a [String], reason: &str) -> impl Iterator<Item = Failure> + 'a {
    let reason = reason.to_owned();
    skills
        .iter()
        .map(String::as_str)
        .chain(skills.is_empty().then_some("*"))
        .map(move |skill| Failure::new(skill, reason.clone()))
}

/// Held across one add's snapshot → CLI → contain: a second add's folders (created while the
/// first runs) would otherwise look created by the first, and be quarantined or deleted by it.
pub(super) static ADD: Mutex<()> = Mutex::new(());

#[allow(clippy::too_many_arguments)]
pub(super) fn add_at(
    home: &Path,
    project: Option<&Path>,
    project_id: Option<String>,
    path: &Path,
    homes: &Homes,
    source: &str,
    skills: &[String],
    harnesses: &[String],
    mut run: impl FnMut(&[String], &Path, &BTreeMap<String, String>) -> Result<cli::Output, String>,
) -> Result<SkillInventory, String> {
    let calls = invocations(home, homes, source, skills, harnesses, project_id.is_none())?;
    let _add = recover(&ADD);
    let mut prefs = {
        let _guard = recover(&LOCK);
        read_prefs(path)?
    };
    let prefix = cli::npm_prefix(path);
    cli::ensure_prefix(&prefix)?;
    let before = snapshot(home, project, homes);
    let mut records = Vec::new();
    let mut failures = Vec::new();
    let mut error = None;
    let mut succeeded = false;
    // Some call failed (timeout, output limit, non-zero exit): its records may be missing.
    let mut failed = false;
    for (args, env) in calls {
        let (args, env) = cli::npx_call(&args, &prefix, home, &env);
        // The CLI installs project skills in its working directory; global installs never
        // need one, so they run in PandaCode's own folder.
        match run(&args, project.unwrap_or(&prefix), &env) {
            Ok(output) => {
                succeeded |= output.error.is_none();
                failed |= output.error.is_some();
                let parsed = cli::parse_result(&output.stdout);
                if let Some(parsed) = parsed.as_ref().and_then(|v| v.as_array()) {
                    records.extend(parsed.iter().cloned());
                } else if let Some(reason) = &output.error {
                    failures.extend(failed_all(skills, reason));
                }
                if output.error.is_some() {
                    error = output.error;
                }
            }
            Err(reason) => {
                failed = true;
                failures.extend(failed_all(skills, &reason));
                error = Some(reason);
            }
        }
    }
    for record in records.iter().filter(|r| r["status"] != "installed") {
        if let Some(skill) = record["name"].as_str() {
            let reason = record["error"]
                .as_str()
                .or_else(|| record["reason"].as_str())
                .unwrap_or("Skipped by the skills CLI.");
            failures.push(Failure::new(skill, reason.into()));
        }
    }
    let mut written = BTreeSet::new();
    if project_id.is_none() {
        for harness in accounts::LINKED {
            // Oh My Pi installs as `pi` and shares its homes.
            if harnesses
                .iter()
                .any(|id| cli::agent_id(id) == cli::agent_id(harness))
            {
                let (failed, linked) = accounts::link(home, homes, harness, &records, path);
                failures.extend(failed);
                written.extend(linked.iter().map(|p| entry_key(p)));
            }
        }
    }
    let created = |folder: &Path| {
        let key = entry_key(folder);
        !before.existed(&key) || written.contains(&key)
    };
    let mut inventory = list_with_prefs(home, project, project_id, &prefs, homes);
    let reported_success = records.iter().any(|r| r["status"] == "installed");
    if records.is_empty() || failed {
        let listed: BTreeSet<String> = records
            .iter()
            .filter_map(|r| r["name"].as_str().map(str::to_owned))
            .collect();
        let scope = if project.is_some() { "project" } else { "user" };
        // Rescan the requested scope for skills without a record: after a reported success
        // (an update in place) the requested ones; after a failure every requested skill there,
        // created or not, since the CLI may have rewritten a copy before it stopped. With no
        // names requested, a failure can only point at the folders this run created.
        records.extend(
            inventory
                .skills
                .iter()
                .filter(|s| !listed.contains(&s.name))
                .filter(|s| {
                    let requested = skills.is_empty() || skills.contains(&s.name);
                    s.agents.iter().any(|agent| {
                        agent.scope == scope
                            && ((requested
                                && (if failed {
                                    !skills.is_empty()
                                } else {
                                    succeeded && harnesses.contains(&agent.harness)
                                }))
                                || safety::agent_folders(agent, home, project, homes)
                                    .iter()
                                    .any(|folder| created(folder)))
                    })
                })
                .map(|s| serde_json::json!({"name":s.name,"status":"installed"})),
        );
    }
    let installed = records.iter().any(|r| r["status"] == "installed");
    let result = serde_json::Value::Array(records);
    let mut findings = safety::scan_installed(home, project, homes, &inventory, &[], Some(&result));
    if !findings.is_empty() {
        let outcome = contain(
            path,
            home,
            project,
            homes,
            &inventory,
            &mut findings,
            &created,
        );
        if outcome.moved {
            let refreshed =
                list_with_prefs(home, project, inventory.project_id.clone(), &prefs, homes);
            inventory.skills = refreshed.skills;
            inventory.not_shown = refreshed.not_shown;
        }
        inventory.error = outcome.error;
        inventory.switched_off = outcome.switched_off.into_iter().collect();
    }
    let (latest, prefs_error) = {
        let _guard = recover(&LOCK);
        recovered_prefs(path)
    };
    inventory.set_prefs_error(&latest, prefs_error);
    inventory.links_warning = accounts::links_warning(path);
    prefs = latest;
    if !installed || (!succeeded && !reported_success) {
        let error = safety::redact_warning(
            &error
                .or_else(|| failures.first().map(|f| f.reason.clone()))
                .unwrap_or_else(|| "The skills CLI installed no skills.".into()),
        );
        if findings.is_empty() {
            return Err(error);
        }
        inventory.error.get_or_insert(error);
    }
    quarantine::add_rows(&mut inventory.skills, path, inventory.project_id.as_deref());
    inventory::attribute(
        &mut inventory.skills,
        &prefs,
        inventory.project_id.as_deref(),
        project,
        homes,
    );
    failures.sort();
    failures.dedup();
    inventory.findings = Some(findings);
    inventory.failures = Some(failures);
    Ok(inventory)
}

struct Contained {
    moved: bool,
    error: Option<String>,
    /// Names this add switched off in its scope (not ones the user had already turned off).
    switched_off: BTreeSet<String>,
}

/// Quarantines flagged folders this install created; copies it only updated (or could not move)
/// are switched off in the add's scope (All projects for a global add, else only that project),
/// and created ones are deleted if even that fails.
fn contain(
    path: &Path,
    home: &Path,
    project: Option<&Path>,
    homes: &Homes,
    inventory: &SkillInventory,
    findings: &mut [safety::Finding],
    created: &dyn Fn(&Path) -> bool,
) -> Contained {
    let roots = safety::known_roots(home, project, homes);
    let mut groups: BTreeMap<BTreeSet<PathBuf>, (BTreeSet<String>, BTreeSet<String>)> =
        BTreeMap::new();
    for finding in findings.iter() {
        let (names, disabled) = groups.entry(finding.folders.clone()).or_default();
        names.insert(finding.skill.clone());
        disabled.extend(finding.disabled_names.iter().cloned());
    }
    let flags = |folders: &BTreeSet<PathBuf>| -> Vec<quarantine::Flag> {
        findings
            .iter()
            .filter(|f| &f.folders == folders)
            .map(safety::Finding::flag)
            .take(quarantine::MAX_FLAGS)
            .collect()
    };
    let mut moved = false;
    let mut quarantined = BTreeSet::new();
    // Quarantine record → the names its install switches off for copies left in place.
    let mut records: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut remaining: Vec<(BTreeSet<String>, BTreeSet<PathBuf>)> = Vec::new();
    let mut errors = Vec::new();
    for (folders, (names, disabled)) in groups {
        let existing: BTreeSet<_> = folders
            .iter()
            .filter(|f| fs::symlink_metadata(f).is_ok())
            .cloned()
            .collect();
        let (new, old): (BTreeSet<_>, BTreeSet<_>) = existing.into_iter().partition(|f| created(f));
        let mut left = old.clone();
        if !new.is_empty() {
            let mut flagged =
                flagged_skill(inventory, &names, &disabled, &new, home, project, homes);
            flagged.flags = flags(&folders);
            match quarantine::quarantine(path, flagged, &new, &roots) {
                Ok(id) => {
                    moved = true;
                    quarantined.extend(names.iter().cloned());
                    if !old.is_empty() {
                        records.insert(id, disabled.clone());
                    }
                }
                Err(error) => {
                    errors.push(error);
                    left.extend(new.iter().cloned());
                }
            }
        }
        // Nothing left on disk to move (an unresolvable folder): the switch is all there is.
        if !left.is_empty() || new.is_empty() {
            remaining.push((disabled, left));
        }
    }
    for finding in findings.iter_mut() {
        finding.quarantined = quarantined.contains(&finding.skill);
    }
    if remaining.is_empty() {
        return Contained {
            moved,
            error: (!errors.is_empty()).then(|| safety::redact_warning(&errors.join(" "))),
            switched_off: BTreeSet::new(),
        };
    }
    let disable = (|| {
        let _guard = recover(&LOCK);
        // A switch may change while the CLI is running. Merge into its latest settings.
        let mut prefs = read_prefs(path)?;
        let scope = switch_scope(project, inventory.project_id.as_deref());
        let mut added = BTreeSet::new();
        for (names, _) in &remaining {
            if names.is_empty() {
                return Err(
                    "Skill identity could not be resolved safely from SKILL.md or the CLI result."
                        .to_string(),
                );
            }
            for name in names {
                validate_toggle_name(name)?;
                // A switch the user already set stays theirs: restore never clears it.
                let off = match &scope {
                    Some(key) => prefs.projects.entry(key.clone()).or_default(),
                    None => &mut prefs.off_in_panda_code,
                };
                if off.insert(name.clone()) {
                    added.insert(name.clone());
                }
            }
        }
        save_prefs(path, &prefs)?;
        let switched: BTreeMap<_, BTreeSet<_>> = records
            .iter()
            .map(|(id, names)| (id.clone(), names.intersection(&added).cloned().collect()))
            .collect();
        // The switches are saved; a record that can't say which ones only means restore
        // leaves them on for the user to clear.
        if let Err(error) = quarantine::record_switched_in(path, &switched, scope.as_deref()) {
            eprintln!("Warning: could not record quarantine switches: {error}");
        }
        Ok(added)
    })();
    let mut switched_off = BTreeSet::new();
    let error = match disable {
        Ok(added) => {
            switched_off = added;
            (!errors.is_empty()).then(|| errors.join(" "))
        }
        Err(error) => {
            // Delete only what this install created; never a folder that was already there.
            let ours: BTreeSet<_> = remaining
                .iter()
                .flat_map(|(_, folders)| folders.iter().filter(|f| created(f)).cloned())
                .collect();
            let kept = remaining.iter().any(|(_, f)| f.iter().any(|f| !created(f)));
            moved |= !ours.is_empty();
            Some(match (safety::remove_folders(&ours, &roots), kept) {
                (Ok(()), false) => format!("Flagged skill files were removed because PandaCode could not turn them off: {error}"),
                (Ok(()), true) => format!("Could not turn off flagged skills: {error}. Files this install created were removed; turn off or remove the updated skill before starting an agent."),
                (Err(removal), _) => format!("Could not turn off flagged skills: {error}. {removal}"),
            })
        }
    };
    Contained {
        moved,
        error: error.map(|e| safety::redact_warning(&e)),
        switched_off,
    }
}

/// The switch an add's containment sets: `None` is All projects (a global add); a project add
/// switches the name off only in that project (its ID, else its checkout key).
fn switch_scope(project: Option<&Path>, project_id: Option<&str>) -> Option<String> {
    let project = project?;
    Some(project_id.map_or_else(|| checkout_key(project), str::to_owned))
}

fn flagged_skill(
    inventory: &SkillInventory,
    names: &BTreeSet<String>,
    disabled: &BTreeSet<String>,
    folders: &BTreeSet<PathBuf>,
    home: &Path,
    project: Option<&Path>,
    homes: &Homes,
) -> quarantine::Flagged {
    let row = inventory
        .skills
        .iter()
        .find(|s| disabled.contains(&s.name))
        .or_else(|| inventory.skills.iter().find(|s| names.contains(&s.name)));
    let keys: BTreeSet<_> = folders.iter().map(|f| entry_key(f)).collect();
    let agents = row
        .into_iter()
        .flat_map(|s| &s.agents)
        .filter(|agent| {
            safety::agent_folders(agent, home, project, homes)
                .iter()
                .any(|f| keys.contains(&entry_key(f)))
        })
        .map(|a| quarantine::StoredAgent {
            harness: a.harness.clone(),
            scope: a.scope.clone(),
            path: a.path.clone(),
            project_id: a.project_id.clone(),
        })
        .collect();
    quarantine::Flagged {
        name: row
            .map(|s| s.name.clone())
            .or_else(|| disabled.iter().next().cloned())
            .or_else(|| names.iter().next().cloned())
            .unwrap_or_default(),
        names: names.iter().chain(disabled).cloned().collect(),
        description: row.map(|s| s.description.clone()).unwrap_or_default(),
        source: row.and_then(|s| s.source.clone()),
        resolved: row.is_some_and(|s| s.switchable),
        agents,
        flags: Vec::new(),
    }
}

#[cfg(test)]
#[path = "install_tests.rs"]
mod tests;
#[cfg(test)]
#[path = "install_guard_tests.rs"]
mod guard_tests;
#[cfg(test)]
#[path = "install_scope_tests.rs"]
mod scope_tests;
