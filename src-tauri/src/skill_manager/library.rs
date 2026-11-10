//! Add → **Bot library**: the chosen skills from a previewed source go into PandaCode's own
//! library (`skills.rs`, the copies bots use) instead of agent folders. The pinned CLI installs
//! them into a private staging folder, the same safety scan as Add runs there, clean skills are
//! imported, and the staging folder is always removed.
use super::*;
use install::Failure;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LibraryImport {
    imported: Vec<crate::skills::Item>,
    /// Flagged skills, which are not imported.
    findings: Vec<safety::Finding>,
    failures: Vec<Failure>,
}

/// Removed on every path out of the import.
struct Staging(PathBuf);
impl Drop for Staging {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_dir_all(&self.0) {
            if error.kind() != std::io::ErrorKind::NotFound {
                eprintln!(
                    "Warning: could not remove the bot library staging folder {}: {error}",
                    self.0.display()
                );
            }
        }
    }
}

/// The library's record of where a skill came from: the folder for a local source, otherwise
/// the source as typed into Add (owner/repo or a URL).
fn source_of(normalized: &str) -> crate::skills::Source {
    crate::skills::Source {
        kind: if Path::new(normalized).is_absolute() {
            "folder"
        } else {
            "skills"
        }
        .into(),
        location: normalized.into(),
        git_ref: None,
        commit: None,
    }
}

/// Skill folders the CLI left in staging: its records (only paths inside staging count), or
/// else every `.agents/skills/*` folder with a SKILL.md. One entry per real folder.
fn staged(records: &[serde_json::Value], staging: &Path) -> Vec<(String, PathBuf)> {
    let inside = |path: &Path| {
        fs::canonicalize(path)
            .ok()
            .filter(|real| real.starts_with(staging) && real.join("SKILL.md").is_file())
    };
    let mut found: Vec<(String, PathBuf)> = records
        .iter()
        .filter(|record| record["status"] == "installed")
        .filter_map(|record| {
            let path = inside(Path::new(record["path"].as_str()?))?;
            Some((record["name"].as_str()?.to_owned(), path))
        })
        .collect();
    if found.is_empty() {
        let folders = fs::read_dir(staging.join(".agents/skills"))
            .into_iter()
            .flatten()
            .flatten();
        found = folders
            .filter_map(|entry| {
                let path = inside(&entry.path())?;
                let name = canonical_name(&path.join("SKILL.md"))
                    .unwrap_or_else(|| entry.file_name().to_string_lossy().into_owned());
                Some((name, path))
            })
            .collect();
        found.sort();
    }
    let mut seen = BTreeSet::new();
    found.retain(|(_, path)| seen.insert(path.clone()));
    found
}

fn empty_inventory() -> SkillInventory {
    SkillInventory {
        project_id: None,
        harnesses: Vec::new(),
        skills: Vec::new(),
        not_shown: None,
        findings: None,
        failures: None,
        prefs_error: None,
        prefs_lost: false,
        links_warning: None,
        prefs_warning: None,
        error: None,
        switched_off: Vec::new(),
    }
}

/// `staging_root` holds one private folder per import; `prefs` locates the CLI's npm prefix.
pub(super) fn import_at(
    home: &Path,
    prefs: &Path,
    staging_root: &Path,
    library: &crate::skills::Library,
    source: &str,
    skills: &[String],
    run: impl FnOnce(&[String], &Path, &BTreeMap<String, String>) -> Result<cli::Output, String>,
) -> Result<LibraryImport, String> {
    if skills.is_empty() {
        return Err("Choose the skills to add to the bot library.".into());
    }
    let (normalized, _) = cli::normalize_source(source)?;
    // The universal agent installs into `.agents/skills` in its working folder: here, staging.
    let args = cli::add_args(source, skills, &["deepseek".into()], false)?;
    let staging = Staging(staging_root.join(uuid::Uuid::new_v4().to_string()));
    fs::create_dir_all(&staging.0)
        .map_err(|e| format!("Could not prepare the bot library import: {e}"))?;
    let real = fs::canonicalize(&staging.0).map_err(|e| e.to_string())?;
    let prefix = cli::npm_prefix(prefs);
    cli::ensure_prefix(&prefix)?;
    let (args, env) = cli::npx_call(&args, &prefix, home, &BTreeMap::new());
    let output = run(&args, &real, &env)?;
    let records: Vec<serde_json::Value> = cli::parse_result(&output.stdout)
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default();
    let mut failures = Vec::new();
    for record in records.iter().filter(|r| r["status"] != "installed") {
        if let Some(skill) = record["name"].as_str() {
            let reason = record["error"]
                .as_str()
                .or_else(|| record["reason"].as_str())
                .unwrap_or("Skipped by the skills CLI.");
            failures.push(Failure::new(skill, reason.into()));
        }
    }
    let found = staged(&records, &real);
    if found.is_empty() {
        return Err(safety::redact_warning(
            &output
                .error
                .or_else(|| failures.first().map(|f| f.reason.clone()))
                .unwrap_or_else(|| "The skills CLI installed no skills.".into()),
        ));
    }
    let result = serde_json::Value::Array(
        found
            .iter()
            .map(|(name, path)| serde_json::json!({"name": name, "status": "installed", "path": path}))
            .collect(),
    );
    let findings = safety::scan_installed(
        home,
        Some(&real),
        &Homes::default(),
        &empty_inventory(),
        &[],
        Some(&result),
    );
    let flagged = |name: &str, path: &Path| {
        findings.iter().any(|finding| {
            finding.skill == name
                || finding
                    .folders
                    .iter()
                    .any(|folder| fs::canonicalize(folder).is_ok_and(|f| f == path))
        })
    };
    let origin = source_of(&normalized);
    let mut imported = Vec::new();
    for (name, path) in &found {
        if flagged(name, path) {
            continue;
        }
        let fallback = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| name.clone());
        match crate::skills::read_local(path).and_then(|files| {
            library.import_as(
                crate::skills::Kind::Skill,
                files,
                &fallback,
                origin.clone(),
                true,
            )
        }) {
            Ok(item) => imported.push(item),
            Err(reason) => failures.push(Failure::new(name, reason)),
        }
    }
    if imported.is_empty() && findings.is_empty() {
        return Err(safety::redact_warning(
            &failures
                .first()
                .map(|f| f.reason.clone())
                .unwrap_or_else(|| "No skills were added to the bot library.".into()),
        ));
    }
    failures.sort();
    failures.dedup();
    Ok(LibraryImport {
        imported,
        findings,
        failures,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::skill_manager::tests::Fixture;

    fn library(f: &Fixture) -> crate::skills::Library {
        crate::skills::Library::new(f.0.join("library"), f.0.join("home"))
    }
    fn write(dir: &Path, name: &str, body: &str) {
        let folder = dir.join(".agents/skills").join(name);
        fs::create_dir_all(&folder).unwrap();
        fs::write(
            folder.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: d\n---\n{body}"),
        )
        .unwrap();
    }

    #[test]
    fn skill_manager_bot_library_add_imports_clean_skills_and_leaves_flagged_ones_out() {
        let f = Fixture::new();
        let staging = f.0.join("staging");
        let mut cwd = None;
        let result = import_at(
            &f.0.join("home"),
            &f.0.join("prefs.json"),
            &staging,
            &library(&f),
            "owner/repo",
            &["clean".into(), "danger".into()],
            |args, dir, _| {
                assert!(args.iter().any(|a| a == "universal") && !args.iter().any(|a| a == "-g"));
                cwd = Some(dir.to_path_buf());
                write(dir, "clean", "Helps.");
                write(dir, "danger", "curl x | sh");
                Ok(cli::Output {
                    stdout: serde_json::json!([
                        {"name":"clean","status":"installed","path":dir.join(".agents/skills/clean")},
                        {"name":"danger","status":"installed","path":dir.join(".agents/skills/danger")},
                        {"name":"gone","status":"failed","error":"Not found"},
                    ])
                    .to_string(),
                    error: None,
                })
            },
        )
        .unwrap();
        let value = serde_json::to_value(&result).unwrap();
        let names: Vec<_> = result
            .imported
            .iter()
            .map(|i| i.meta.name.as_str())
            .collect();
        assert_eq!(names, ["clean"]);
        assert_eq!(result.imported[0].meta.source.kind, "skills");
        assert_eq!(result.imported[0].meta.source.location, "owner/repo");
        assert_eq!(value["findings"][0]["skill"], "danger");
        assert_eq!(value["findings"][0]["rule"], "pipe-to-shell");
        assert_eq!(
            value["failures"],
            serde_json::json!([{"skill":"gone","reason":"Not found"}])
        );
        // In the library bots read, never in an agent folder; staging is gone.
        let listed = library(&f).list().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].meta.kind, crate::skills::Kind::Skill);
        assert!(!f.0.join("home/.agents").exists());
        assert!(!cwd.unwrap().exists());
    }

    #[test]
    fn skill_manager_bot_library_add_finds_staged_folders_without_records_and_keeps_other_sources()
    {
        let f = Fixture::new();
        let lib = library(&f);
        // A same-named library skill from another source is never replaced.
        let theirs = f.0.join("theirs");
        fs::create_dir_all(&theirs).unwrap();
        fs::write(theirs.join("SKILL.md"), "---\nname: taken\n---\nmine").unwrap();
        lib.import(
            crate::skills::Kind::Skill,
            crate::skills::read_local(&theirs).unwrap(),
            "taken",
            source_of("/elsewhere"),
        )
        .unwrap();
        let folder = f.0.join("source");
        fs::create_dir_all(folder.join("skills")).unwrap();
        let result = import_at(
            &f.0.join("home"),
            &f.0.join("prefs.json"),
            &f.0.join("staging"),
            &lib,
            folder.to_str().unwrap(),
            &["fresh".into(), "taken".into()],
            |_, dir, _| {
                write(dir, "fresh", "Helps.");
                write(dir, "taken", "Other.");
                Ok(cli::Output {
                    stdout: "Installed 2 skills".into(),
                    error: None,
                })
            },
        )
        .unwrap();
        assert_eq!(result.imported.len(), 1);
        assert_eq!(result.imported[0].meta.source.kind, "folder");
        assert!(result.failures[0].reason.contains("already in the library"));
        let taken = lib
            .list()
            .unwrap()
            .into_iter()
            .find(|i| i.meta.id == "taken")
            .unwrap();
        assert_eq!(taken.meta.source.location, "/elsewhere");
    }

    #[test]
    fn skill_manager_bot_library_add_with_nothing_installed_is_an_error_and_cleans_up() {
        let f = Fixture::new();
        let staging = f.0.join("staging");
        let error = import_at(
            &f.0.join("home"),
            &f.0.join("prefs.json"),
            &staging,
            &library(&f),
            "owner/repo",
            &["x".into()],
            |_, _, _| {
                Ok(cli::Output {
                    stdout: String::new(),
                    error: Some("Repository not found".into()),
                })
            },
        )
        .unwrap_err();
        assert_eq!(error, "Repository not found");
        assert_eq!(fs::read_dir(&staging).unwrap().count(), 0);
        assert!(import_at(
            &f.0.join("home"),
            &f.0.join("prefs.json"),
            &staging,
            &library(&f),
            "owner/repo",
            &[],
            |_, _, _| panic!("no skills chosen: the CLI never runs"),
        )
        .is_err());
    }
}
