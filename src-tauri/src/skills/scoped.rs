//! Bot-scoped skills (#114): a bot references library skills by id. Its own workspace gets
//! them through the ordinary adapter at project scope; a project task with a bot gets the
//! bot's skills in its brief instead, so nothing is written into a checkout other tasks share.
use std::path::Path;

use super::{adapter, frontmatter, Kind, Library, Scope};

/// Bounds for skills carried in a prompt.
const SKILL_CHARS: usize = 16 * 1024;
const TOTAL_CHARS: usize = 64 * 1024;

/// One skill a task receives, and where it came from: `bot`, `project` or `both`.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Resolved {
    pub id: String,
    pub provenance: &'static str,
}

/// The union of a bot's and a project's skills, deduplicated by id, bot order first.
pub fn resolve(bot: &[String], project: &[String]) -> Vec<Resolved> {
    let mut out: Vec<Resolved> = Vec::new();
    for (ids, from) in [(bot, "bot"), (project, "project")] {
        for id in ids {
            match out.iter_mut().find(|r| r.id == *id) {
                Some(existing) if existing.provenance != from => existing.provenance = "both",
                Some(_) => {}
                None => out.push(Resolved { id: id.clone(), provenance: from }),
            }
        }
    }
    out
}

impl Library {
    /// Skill ids active for `harness` at project scope in `root`.
    pub fn project_active(&self, harness: &str, root: &Path) -> Vec<String> {
        let project = Some(root.to_string_lossy().into_owned());
        let Ok(items) = self.list() else { return Vec::new() };
        items.into_iter().filter(|i| i.meta.kind == Kind::Skill && super::active_in(&i.meta, harness, Scope::Project, &project).is_some()).map(|i| i.meta.id).collect()
    }

    /// Makes exactly `ids` active for `harness` in a bot's own workspace `root`; other harnesses
    /// are left alone. Returns a message for each skill that could not be turned on or off.
    pub fn sync_project(&self, harness: &str, root: &Path, ids: &[String]) -> Vec<String> {
        if !adapter::known(harness) {
            return Vec::new();
        }
        let project = Some(root.to_string_lossy().into_owned());
        let Ok(items) = self.list() else { return vec!["The skills library could not be read.".into()] };
        let mut errors = Vec::new();
        for item in &items {
            let active = super::active_in(&item.meta, harness, Scope::Project, &project);
            let wanted = item.meta.kind == Kind::Skill && ids.contains(&item.meta.id);
            let result = match (wanted, active) {
                (true, Some(a)) if Self::status(&item.meta, Some(a)) == "active" || a.surface == "prompt" && a.sha256 == item.meta.sha256 => Ok(()),
                (true, _) => self.activate(&item.meta.id, harness, Scope::Project, Some(root), false).map(|_| ()),
                (false, Some(_)) => self.deactivate(&item.meta.id, harness, Scope::Project, Some(root)).map(|_| ()),
                (false, None) => Ok(()),
            };
            if let Err(error) = result {
                errors.push(error);
            }
        }
        for id in ids.iter().filter(|id| !items.iter().any(|i| i.meta.id == **id)) {
            errors.push(format!("{id} is no longer in the skills library."));
        }
        errors
    }

    /// Skills as prompt text, for harnesses without a skill folder and for project tasks.
    /// Items with safety findings the user has not accepted are left out, with a reason.
    pub fn prompt_text(&self, ids: &[String]) -> (String, Vec<String>) {
        let mut text = String::new();
        let mut skipped = Vec::new();
        for id in ids {
            let item = match self.load(id).and_then(|meta| self.item(meta)) {
                Ok(item) if item.meta.kind == Kind::Skill => item,
                _ => {
                    skipped.push(format!("{id} is no longer in the skills library."));
                    continue;
                }
            };
            if !item.findings.is_empty() && item.meta.acknowledged.as_deref() != Some(item.meta.sha256.as_str()) {
                skipped.push(format!("Review the safety findings for {} in Settings → Skills & rules first.", item.meta.name));
                continue;
            }
            let folder = self.dir.join(id);
            let main = std::fs::read_to_string(folder.join("SKILL.md")).unwrap_or_default();
            let (_, _, body) = frontmatter(&main);
            let body: String = body.chars().take(SKILL_CHARS).collect();
            let section = format!("\n### {}\n{}\nFolder (supporting files): {}\n\n{}\n", item.meta.name, item.meta.description, folder.display(), body.trim());
            if text.chars().count() + section.chars().count() > TOTAL_CHARS {
                skipped.push(format!("{} did not fit in the prompt.", item.meta.name));
                continue;
            }
            text.push_str(&section);
        }
        (text, skipped)
    }
}

/// Whether `harness` reads skill folders, so a bot workspace gets files instead of prompt text.
pub fn has_skill_folder(harness: &str) -> bool {
    adapter::FILE_HARNESSES.contains(&harness)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn union_deduplicates_by_id_and_keeps_provenance() {
        let ids = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let resolved = resolve(&ids(&["review", "deploy", "review"]), &ids(&["lint", "deploy"]));
        let pairs: Vec<_> = resolved.iter().map(|r| (r.id.as_str(), r.provenance)).collect();
        assert_eq!(pairs, [("review", "bot"), ("deploy", "both"), ("lint", "project")]);
        assert!(resolve(&[], &[]).is_empty());
    }
}
