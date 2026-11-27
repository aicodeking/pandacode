//! Skills other harnesses already installed on this computer: where to look for them
//! (`roots`), and the library scan that lists them for one-click import. Read-only; nothing
//! reaches a harness until the user imports a skill and activates it.
use std::path::{Path, PathBuf};

use serde::Serialize;

use super::{adapter, frontmatter, read_local, Library, MAX_FOUND};

/// One copy of a found skill on disk: the root it lives under, labeled as the capabilities
/// panel labels it (`~/.claude/skills`), and its absolute folder.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FoundLocation {
    pub label: String,
    pub path: String,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FoundSkill {
    pub name: String,
    pub description: String,
    /// The content hash, so a skill already in the library at the same version is recognized.
    pub sha256: String,
    /// Every folder holding this content, sorted by label.
    pub locations: Vec<FoundLocation>,
    /// A library item holds exactly this content.
    pub in_library: bool,
    /// A library item goes by the same folder id (any content).
    pub library_id: Option<String>,
}

/// User-scope skill roots of every harness PandaCode knows (`skill_manager::roots::skill_roots`,
/// which also feeds the Tools & add-ons inventory), plus the shared `~/.agents/skills`
/// convention. Duplicated roots (GLM and MiMo read Claude's) collapse.
pub(crate) fn roots(home: &Path) -> Vec<(PathBuf, String)> {
    roots_with_homes(home, &crate::skill_manager::roots::Homes::for_scan())
}

fn roots_with_homes(home: &Path, homes: &crate::skill_manager::roots::Homes) -> Vec<(PathBuf, String)> {
    let mut roots: Vec<(PathBuf, String)> = Vec::new();
    let mut push = |path: PathBuf, label: String| {
        if !roots.iter().any(|(known, _)| *known == path) {
            roots.push((path, label));
        }
    };
    for (harness, _) in crate::providers::PROVIDERS {
        for (path, label) in crate::skill_manager::roots::skill_roots(harness, home, None, homes) {
            push(path, label);
        }
    }
    push(home.join(".agents/skills"), "~/.agents/skills".to_string());
    roots
}

impl Library {
    /// Every skill folder under the roots, grouped by content: the same skill installed for
    /// two harnesses is one entry with two locations. Folders that cannot be read (too many
    /// files, over 1 MB, no SKILL.md) are skipped, and the scan stops at `MAX_FOUND` folders.
    pub fn found(&self) -> Vec<FoundSkill> {
        let library: Vec<_> = self.list().unwrap_or_default().into_iter().map(|item| item.meta).collect();
        let mut by_hash: Vec<FoundSkill> = Vec::new();
        let mut seen = 0usize;
        for (root, label) in roots(&self.home) {
            for (name, path) in adapter::skill_folders(&root) {
                if seen == MAX_FOUND {
                    return finish(by_hash);
                }
                seen += 1;
                let Ok(files) = read_local(&path) else { continue };
                let main = files.iter().find(|(p, _)| p == "SKILL.md").map(|(_, b)| String::from_utf8_lossy(b).into_owned());
                let Some(main) = main else { continue };
                let (front_name, description, body) = frontmatter(&main);
                let sha256 = super::content_hash(&files);
                let folder_id = super::slug(front_name.as_deref().unwrap_or(&name));
                let location = FoundLocation { label: label.to_string(), path: path.to_string_lossy().into_owned() };
                if let Some(entry) = by_hash.iter_mut().find(|found| found.sha256 == sha256) {
                    if !entry.locations.iter().any(|l| l.path == location.path) {
                        entry.locations.push(location);
                        entry.locations.sort_by(|a, b| a.label.cmp(&b.label));
                    }
                    continue;
                }
                by_hash.push(FoundSkill {
                    name: front_name.unwrap_or_else(|| name.clone()),
                    description: description.unwrap_or_else(|| {
                        // The same first-line fallback the library import uses.
                        body.lines().map(str::trim).find(|l| !l.is_empty() && !l.starts_with('#')).unwrap_or_default().chars().take(200).collect()
                    }),
                    in_library: library.iter().any(|meta| meta.kind == super::Kind::Skill && meta.sha256 == sha256),
                    library_id: library.iter().find(|meta| meta.kind == super::Kind::Skill && meta.id == folder_id).map(|meta| meta.id.clone()),
                    sha256,
                    locations: vec![location],
                });
            }
        }
        finish(by_hash)
    }
}

fn finish(mut found: Vec<FoundSkill>) -> Vec<FoundSkill> {
    found.sort_by_key(|skill| skill.name.to_ascii_lowercase());
    found
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn roots_include_configured_and_account_homes_without_duplicates() {
        let home = std::env::temp_dir().join("pandacode-found-home");
        let account = home.join("accounts/claude");
        let config = home.join("config");
        let homes = crate::skill_manager::roots::Homes {
            claude: Some(account.clone()),
            xdg_config: Some(config.clone()),
            configured: std::collections::BTreeMap::from([
                ("claude".into(), vec![account.clone(), home.join("accounts/other")]),
            ]),
            ..Default::default()
        };
        let roots = roots_with_homes(&home, &homes);
        assert_eq!(roots.iter().filter(|(path, _)| *path == account.join("skills")).count(), 1);
        assert!(roots.iter().any(|(path, _)| *path == home.join("accounts/other/skills")));
        assert!(roots.iter().any(|(path, _)| *path == config.join("opencode/skills")));
        assert!(roots.iter().any(|(path, _)| *path == config.join("opencode/skill")));
    }

    #[test]
    fn roots_cover_every_known_harness_once() {
        let base = std::env::temp_dir().join(format!("pandacode-skills-roots-{}", uuid::Uuid::new_v4()));
        let home = &base;
        let labels: Vec<String> = roots_with_homes(home, &crate::skill_manager::roots::Homes::default()).into_iter().map(|(_, label)| label).collect();
        let expect = [
            "~/.claude/skills",
            "~/.codex/skills",
            "~/.agents/skills",
            "~/.config/opencode/skills",
            "~/.config/opencode/skill",
            "~/.agents/skill",
            "~/.claude/skill",
            "~/.kimi-code/skills",
            "~/.kimi/skills",
            "~/.pi/agent/skills",
            "~/.cline/skills",
            "~/.zcode/skills",
        ];
        for label in expect {
            assert!(labels.iter().any(|actual| actual == label), "missing {label}");
        }
        let homes = crate::skill_manager::roots::Homes::default();
        let found_roots = roots_with_homes(home, &homes);
        for (harness, _) in crate::providers::PROVIDERS {
            for (path, _) in crate::skill_manager::roots::skill_roots(harness, home, None, &homes) {
                assert_eq!(found_roots.iter().filter(|(actual, _)| actual == &path).count(), 1,
                    "{harness}: {} must appear once", path.display());
            }
        }
        let _ = fs::remove_dir_all(&base);
    }
}
