//! Skills library and rules registry (issues #15 and #45). Skills and rules live as files under
//! the app data folder: `skills/<id>/SKILL.md` (or `RULE.md`) plus `skills/<id>.json` with their
//! source, content hash and activations. Activation writes them where each harness reads them
//! (`skills/adapter.rs`), never over a file PandaCode did not write, and reports drift.
mod adapter;
mod github;
mod safety;
pub(crate) mod scoped;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{AppHandle, Manager, State};

use crate::AppState;
use adapter::Surface;
pub(crate) use safety::scan as scan_safety;
pub use safety::Finding;

/// Relative path and bytes of each file in a skill or rule.
pub type Files = Vec<(String, Vec<u8>)>;
pub const MAX_FILES: usize = 64;
pub const MAX_BYTES: usize = 1 << 20;
// ponytail: one lock for the whole library; per-item locks if imports ever get slow.
static LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Skill,
    Rule,
}
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    User,
    Project,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Written {
    pub path: String,
    pub sha256: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    /// `folder` or `github`.
    pub kind: String,
    /// The folder path, or `owner/name/path`.
    pub location: String,
    pub git_ref: Option<String>,
    pub commit: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Activation {
    pub harness: String,
    pub scope: Scope,
    /// The checkout for project scope.
    pub project: Option<String>,
    /// `folder`, `block` or `prompt` (the window injects it; no file surface).
    pub surface: String,
    /// The library hash that was written.
    pub sha256: String,
    pub files: Vec<Written>,
    /// Lines this activation added to the checkout's `.git/info/exclude`.
    #[serde(default)]
    pub excluded: Vec<String>,
    /// The canonical exclude list those lines are in, so they can still be released once the
    /// checkout itself is gone (a removed worktree).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exclude_list: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Meta {
    pub id: String,
    pub name: String,
    pub kind: Kind,
    pub description: String,
    pub source: Source,
    pub sha256: String,
    pub imported_at: u64,
    /// The content hash whose safety findings the user accepted.
    pub acknowledged: Option<String>,
    pub activations: Vec<Activation>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    #[serde(flatten)]
    pub meta: Meta,
    pub files: Vec<String>,
    pub findings: Vec<Finding>,
    /// The library copy's absolute folder, for skills only: Skills → Add skill installs it as a
    /// local-folder source (Rules & library's **Install…**).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub items: Vec<Item>,
    /// Files left in place because they were edited on disk.
    pub kept: Vec<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cell {
    pub id: String,
    pub scope: Scope,
    /// `active`, `outdated`, `drifted`, `missing`, `prompt` or `off`.
    pub status: &'static str,
    /// The file or folder the harness reads, or `prompt`.
    pub surface: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Unmanaged {
    pub scope: Scope,
    pub kind: Kind,
    pub path: String,
    pub detail: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessRow {
    pub harness: String,
    pub installed: bool,
    /// No file surface: active items ride in the prompt.
    pub prompt: bool,
    pub cells: Vec<Cell>,
    pub unmanaged: Vec<Unmanaged>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Matrix {
    pub project: Option<String>,
    pub harnesses: Vec<HarnessRow>,
}

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}
fn content_hash(files: &[(String, Vec<u8>)]) -> String {
    let mut sorted: Vec<_> = files.iter().collect();
    sorted.sort_by(|a, b| a.0.cmp(&b.0));
    let mut hasher = Sha256::new();
    for (path, bytes) in sorted {
        hasher.update(path.as_bytes());
        hasher.update([0]);
        hasher.update((bytes.len() as u64).to_le_bytes());
        hasher.update(bytes);
    }
    hasher.finalize().iter().map(|b| format!("{b:02x}")).collect()
}
fn slug(name: &str) -> String {
    let mut out = String::new();
    for c in name.trim().to_ascii_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    out.trim_end_matches('-').chars().take(64).collect()
}
fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id == slug(id)
}
/// `name:` and `description:` from leading `---` frontmatter, and the text after it.
pub(crate) fn frontmatter(text: &str) -> (Option<String>, Option<String>, &str) {
    let Some(rest) = text
        .strip_prefix("---\n")
        .or_else(|| text.strip_prefix("---\r\n"))
    else {
        return (None, None, text);
    };
    let Some(end) = rest.find("\n---") else {
        return (None, None, text);
    };
    let lines: Vec<&str> = rest[..end].lines().collect();
    let field = |key: &str| {
        let at = lines.iter().position(|line| line.starts_with(key))?;
        let value = lines[at][key.len()..].trim();
        // A YAML block scalar (`description: >-`) continues on the indented lines below it.
        let value = if matches!(value, "|" | ">" | "|-" | ">-" | "|+" | ">+") {
            lines[at + 1..]
                .iter()
                .take_while(|l| l.starts_with([' ', '\t']) || l.trim().is_empty())
                .map(|l| l.trim())
                .filter(|l| !l.is_empty())
                .collect::<Vec<_>>()
                .join(" ")
        } else {
            value.trim_matches(['"', '\'']).to_string()
        };
        Some(value).filter(|v| !v.is_empty())
    };
    let body = rest[end + 4..].trim_start_matches(['\r', '\n']);
    (field("name:"), field("description:"), body)
}
fn main_file(kind: Kind) -> &'static str {
    match kind {
        Kind::Skill => "SKILL.md",
        Kind::Rule => "RULE.md",
    }
}
fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// A skill keeps its folder and needs a SKILL.md; a rule is one Markdown file, kept as RULE.md.
fn normalize(kind: Kind, files: Files) -> Result<Files, String> {
    let markdown: Vec<_> = files.iter().filter(|(p, _)| !p.contains('/') && p.to_ascii_lowercase().ends_with(".md")).collect();
    match kind {
        Kind::Skill if files.iter().any(|(p, _)| p == "SKILL.md") => Ok(files),
        Kind::Skill if files.len() == 1 && markdown.len() == 1 => Ok(vec![("SKILL.md".into(), files[0].1.clone())]),
        Kind::Skill => Err("A skill needs a SKILL.md.".into()),
        Kind::Rule => {
            let chosen = files.iter().find(|(p, _)| p == "RULE.md").or(if markdown.len() == 1 { Some(markdown[0]) } else { None });
            let (_, bytes) = chosen.ok_or("A rule is one Markdown file (or a folder with a RULE.md).")?;
            std::str::from_utf8(bytes).map_err(|_| "The rule is not UTF-8 text.")?;
            Ok(vec![("RULE.md".into(), bytes.clone())])
        }
    }
}

/// Regular, non-hidden files under `path` (or `path` itself), bounded.
pub(crate) fn read_local(path: &Path) -> Result<Files, String> {
    let meta = fs::symlink_metadata(path)
        .map_err(|e| format!("Could not read {}: {e}", path.display()))?;
    if meta.is_file() {
        if meta.len() as usize > MAX_BYTES {
            return Err("That file is larger than 1 MB.".into());
        }
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "SKILL.md".into());
        return Ok(vec![(name, fs::read(path).map_err(|e| e.to_string())?)]);
    }
    let mut files = Vec::new();
    let mut total = 0;
    let mut pending = vec![path.to_path_buf()];
    while let Some(dir) = pending.pop() {
        for entry in fs::read_dir(&dir)
            .map_err(|e| format!("Could not read {}: {e}", dir.display()))?
            .flatten()
        {
            if entry.file_name().to_string_lossy().starts_with('.') {
                continue;
            }
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                pending.push(entry.path());
            } else if kind.is_file() {
                let bytes = fs::read(entry.path()).map_err(|e| e.to_string())?;
                total += bytes.len();
                if files.len() >= MAX_FILES || total > MAX_BYTES {
                    return Err(format!(
                        "That folder holds more than {MAX_FILES} files or 1 MB."
                    ));
                }
                let relative = entry
                    .path()
                    .strip_prefix(path)
                    .map_err(|e| e.to_string())?
                    .to_string_lossy()
                    .replace('\\', "/");
                files.push((relative, bytes));
            }
        }
    }
    Ok(files)
}

pub struct Library {
    dir: PathBuf,
    home: PathBuf,
}

impl Library {
    pub fn new(dir: PathBuf, home: PathBuf) -> Self {
        Self { dir, home }
    }
    fn meta_path(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{id}.json"))
    }
    fn load(&self, id: &str) -> Result<Meta, String> {
        if !valid_id(id) {
            return Err("Unknown skill.".into());
        }
        let bytes = fs::read(self.meta_path(id)).map_err(|_| "That skill is not in the library.".to_string())?;
        serde_json::from_slice(&bytes).map_err(|e| format!("The library entry for {id} is damaged: {e}"))
    }
    fn save(&self, meta: &Meta) -> Result<(), String> {
        #[cfg(test)]
        if tests::FAIL_SAVE.with(std::cell::Cell::get) {
            return Err("Could not save the library: test failure".into());
        }
        let json = serde_json::to_vec_pretty(meta).map_err(|e| e.to_string())?;
        let temp = self.dir.join(format!(".{}.json.tmp", meta.id));
        fs::write(&temp, json).and_then(|_| fs::rename(&temp, self.meta_path(&meta.id))).map_err(|e| format!("Could not save the library: {e}"))
    }
    fn files(&self, id: &str) -> Result<Files, String> {
        let mut files = read_local(&self.dir.join(id))?;
        files.sort_by(|a, b| a.0.cmp(&b.0));
        Ok(files)
    }
    fn item(&self, meta: Meta) -> Result<Item, String> {
        let files = self.files(&meta.id)?;
        let findings = files
            .iter()
            .flat_map(|(path, bytes)| safety::scan(path, &String::from_utf8_lossy(bytes)))
            .collect();
        let folder = Some(self.dir.join(&meta.id))
            .filter(|dir| meta.kind == Kind::Skill && dir.is_absolute() && dir.is_dir())
            .map(|dir| dir.to_string_lossy().into_owned());
        Ok(Item {
            files: files.into_iter().map(|(p, _)| p).collect(),
            findings,
            folder,
            meta,
        })
    }

    pub fn list(&self) -> Result<Vec<Item>, String> {
        let Ok(entries) = fs::read_dir(&self.dir) else {
            return Ok(Vec::new());
        };
        let mut ids: Vec<String> = entries
            .flatten()
            .filter_map(|e| {
                e.file_name()
                    .to_str()?
                    .strip_suffix(".json")
                    .map(str::to_string)
            })
            .filter(|id| valid_id(id))
            .collect();
        ids.sort();
        ids.into_iter()
            .map(|id| self.load(&id).and_then(|meta| self.item(meta)))
            .collect()
    }

    /// Add or update an item. Updating keeps activations; they show as outdated until the
    /// user activates again, so a new version never reaches a harness without them.
    pub fn import(
        &self,
        kind: Kind,
        files: Files,
        fallback_name: &str,
        source: Source,
    ) -> Result<Item, String> {
        self.import_as(kind, files, fallback_name, source, false)
    }

    /// `import`, refusing (under the library lock, so a concurrent import cannot slip in
    /// between a check and the write) to replace an item that came from another source.
    pub(crate) fn import_as(
        &self,
        kind: Kind,
        files: Files,
        fallback_name: &str,
        source: Source,
        same_source_only: bool,
    ) -> Result<Item, String> {
        let files = normalize(kind, files)?;
        let main = files
            .iter()
            .find(|(p, _)| p == main_file(kind))
            .map(|(_, b)| String::from_utf8_lossy(b).into_owned())
            .unwrap_or_default();
        let (name, description, body) = frontmatter(&main);
        let name = name.unwrap_or_else(|| fallback_name.trim_end_matches(".md").to_string());
        let description = description.unwrap_or_else(|| {
            body.lines()
                .map(str::trim)
                .find(|l| !l.is_empty() && !l.starts_with('#'))
                .unwrap_or_default()
                .chars()
                .take(200)
                .collect()
        });
        let id = slug(&name);
        if id.is_empty() {
            return Err("Give the skill a name in its frontmatter.".into());
        }
        let _guard = LOCK.lock().map_err(|e| e.to_string())?;
        fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
        let previous = self.load(&id).ok();
        if previous.as_ref().is_some_and(|p| p.kind != kind) {
            return Err(format!("A {} named {id} is already in the library.", if kind == Kind::Skill { "rule" } else { "skill" }));
        }
        if let Some(taken) = previous.as_ref().filter(|p| same_source_only && !p.source.location.eq_ignore_ascii_case(&source.location)) {
            return Err(format!("{id} is already in the library from {}.", taken.source.location));
        }
        let folder = self.dir.join(&id);
        let _ = fs::remove_dir_all(&folder);
        for (relative, bytes) in &files {
            let path = folder.join(relative);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            fs::write(&path, bytes).map_err(|e| format!("Could not save {relative}: {e}"))?;
        }
        let sha256 = content_hash(&files);
        let meta = Meta {
            acknowledged: previous.as_ref().and_then(|p| p.acknowledged.clone()).filter(|a| *a == sha256),
            activations: previous.map(|p| p.activations).unwrap_or_default(),
            id, name, kind, description, source, sha256, imported_at: now_ms(),
        };
        self.save(&meta)?;
        self.item(meta)
    }

    pub fn scan(&self, id: &str) -> Result<Vec<Finding>, String> {
        Ok(self.item(self.load(id)?)?.findings)
    }

    fn base<'a>(&'a self, scope: Scope, root: Option<&'a Path>) -> Result<&'a Path, String> {
        match scope {
            Scope::User => Ok(&self.home),
            Scope::Project => root.ok_or_else(|| "Choose a project for project scope.".to_string()),
        }
    }

    /// `activation`'s recorded files split into those inside the surface it writes
    /// ([`adapter::recorded_in_surface`]) and the paths of the rest, which a tampered record
    /// added: those are logged and never removed or rewritten. A project activation whose
    /// folder is not plain ([`adapter::plain_project`]) has every file refused.
    fn vetted(&self, id: &str, kind: Kind, activation: &Activation, base: &Path) -> (Vec<Written>, Vec<String>) {
        let plain = activation.scope == Scope::User || adapter::plain_project(base, &self.home);
        let (ok, refused): (Vec<Written>, Vec<Written>) = activation
            .files
            .iter()
            .cloned()
            .partition(|w| plain && adapter::recorded_in_surface(&activation.harness, kind, activation.scope, base, id, Path::new(&w.path)));
        for w in &refused {
            eprintln!("[skills] {} is not where {id} is written for {} in {}; PandaCode left it alone", w.path, activation.harness, base.display());
        }
        (ok, refused.into_iter().map(|w| w.path).collect())
    }

    pub fn activate(&self, id: &str, harness: &str, scope: Scope, root: Option<&Path>, acknowledge: bool) -> Result<Change, String> {
        if !adapter::known(harness) {
            return Err("Unknown harness.".into());
        }
        let base = self.base(scope, root)?;
        let _guard = LOCK.lock().map_err(|e| e.to_string())?;
        let item = self.item(self.load(id)?)?;
        let meta = item.meta;
        let acknowledged = if item.findings.is_empty() || meta.acknowledged.as_deref() == Some(meta.sha256.as_str()) {
            meta.acknowledged.clone()
        } else if acknowledge {
            Some(meta.sha256.clone())
        } else {
            return Err(format!("Review the {} safety finding(s) before activating {}.", item.findings.len(), meta.name));
        };
        let project = (scope == Scope::Project).then(|| base.to_string_lossy().into_owned());
        let matches = |a: &Activation| a.harness == harness && a.scope == scope && a.project == project;
        let previous = meta.activations.iter().find(|a| matches(a)).cloned();
        // Only recorded files inside the surface are ever removed or rewritten.
        let (old_files, mut kept) = previous.as_ref().map(|a| self.vetted(id, meta.kind, a, base)).unwrap_or_default();
        let mut excluded = previous.as_ref().map(|a| a.excluded.clone()).unwrap_or_default();
        // Judged on the vetted files: a refused path is not an old surface to move from.
        let moved = previous.as_ref().is_some_and(|a| outside_surface(meta.kind, &Activation { files: old_files.clone(), ..a.clone() }));
        // What the previous activation had in place, to put back if the save fails.
        let mut restore = Restore::Remove;
        // Old lines a surface move releases, only once the new record is saved.
        let mut release = Vec::new();
        let mut items = Vec::new();
        let files = self.files(id)?;
        let checkout = (scope == Scope::Project).then_some(base);
        // A project's exclude line is added after the write's read-only checks pass (so a
        // refused write, such as the user's own folder already there, never hides anything)
        // and before any file is written, so a failed exclude update leaves the files (and the
        // recorded activation's hashes) exactly as they were. A line this call added is taken
        // back when the write then fails; files it wrote that had to stay are named instead.
        let add_exclude = |path: &Path, folder: bool| -> Result<Option<String>, String> {
            let Some(root) = checkout else { return Ok(None) };
            let Some(entry) = adapter::exclude_entry(root, path, folder)? else { return Ok(None) };
            Ok(adapter::exclude(base, &entry)?.then_some(entry))
        };
        // Taking a line back can fail too (the list changed since); that is said, not hidden.
        let undo_exclude = |added: &Option<String>| match added.as_deref().map(|entry| (entry, adapter::unexclude(base, entry))) {
            Some((entry, Err(e))) => format!(" Could not remove the exclude line {entry}: {e}."),
            _ => String::new(),
        };
        let surface_target = match adapter::surface(harness, meta.kind, scope, base) {
            Surface::Folder(dir) => Some(dir.join(id)),
            Surface::Block(file) => Some(file),
            Surface::Prompt => None,
        };
        if let Some(target) = &surface_target {
            shared_target(id, meta.activations.iter().filter(|a| !matches(a)), base, target)?;
        }
        let mut checkouts = Checkouts::default();
        let (surface, written, added) = match adapter::surface(harness, meta.kind, scope, base) {
            Surface::Folder(dir) => {
                // After a surface move the new folder must be free, as for a first activation;
                // the old copy goes only once the new one is written, and an edited file stays.
                let previous_files = if moved { &[][..] } else { &old_files[..] };
                adapter::check_folder(&dir, id, &files, previous_files, checkout)?;
                // Loaded before anything is written, so a damaged entry refuses the move cleanly.
                if moved {
                    items = self.list()?;
                } else if previous.is_some() {
                    restore = Restore::Folder(dir.clone(), snapshot(&dir.join(id), &old_files));
                }
                let added = add_exclude(&dir.join(id), true)?;
                let written = adapter::write_folder(&dir, id, &files, previous_files, checkout).map_err(|(e, left)| {
                    // Nothing stays hidden: files that had to stay are named and show in Git.
                    format!("{e}{}{}", undo_exclude(&added), left_in_place(&left))
                })?;
                if moved {
                    // The old copy goes once the new record is saved (below); its lines too.
                    release = excluded.drain(..).filter(|entry| Some(entry) != added.as_ref()).collect();
                }
                ("folder", written, added)
            }
            Surface::Block(file) => {
                adapter::check_block(&file, id, old_files.first(), checkout)?;
                let added = if file.exists() { None } else { add_exclude(&file, false)? };
                let text = files.first().map(|(_, b)| String::from_utf8_lossy(b).into_owned()).unwrap_or_default();
                let (_, _, body) = frontmatter(&text);
                // Checked against the record by `check_block`, so it is what the record holds.
                let old_body = old_files.first().and_then(|w| adapter::read_text(Path::new(&w.path)).ok()).and_then(|text| adapter::block(&text, id)).map(|(body, _)| body);
                if let Some(body) = old_body {
                    restore = Restore::Block(file.clone(), body);
                }
                // A failed block write wrote nothing that counts, so the line always goes.
                let written = adapter::write_block(&file, id, body, old_files.first(), checkout).map_err(|e| format!("{e}{}", undo_exclude(&added)))?;
                ("block", vec![written], added)
            }
            Surface::Prompt => ("prompt", Vec::new(), None),
        };
        if let Some(entry) = added.as_ref().filter(|entry| !excluded.contains(entry)) {
            excluded.push(entry.clone());
        }
        let exclude_list = if excluded.is_empty() {
            None
        } else {
            checkouts.get(base).map(|(list, _)| list.to_string_lossy().into_owned()).or_else(|| previous.as_ref().and_then(|a| a.exclude_list.clone()))
        };
        let written_now = written.clone();
        let activation = Activation {
            harness: harness.into(),
            scope,
            project: project.clone(),
            surface: surface.into(),
            sha256: meta.sha256.clone(),
            files: written,
            excluded,
            exclude_list,
        };
        let activations: Vec<Activation> = meta
            .activations
            .iter()
            .filter(|a| !matches(a))
            .cloned()
            .chain([activation])
            .collect();
        if let Err(e) = self.save(&Meta { acknowledged, activations, ..meta }) {
            // The previous record is still the saved one, so what it records is put back: its
            // files where this call replaced them, nothing where it had none (unrecorded files
            // would be refused as the user's own next time). A moved copy was not touched yet.
            // The old lines stay with the previous record.
            let left = restore.apply(id, surface, &written_now, checkout);
            return Err(format!("{e}{}{}", undo_exclude(&added), left_in_place(&left)));
        }
        if moved {
            // An edited file stays, unmanaged, and its line goes too, as on deactivate.
            kept.extend(adapter::remove_folder(&old_files, checkout));
        }
        // Lines another activation still has files under stay and are handed to it.
        if let (false, Some(previous)) = (release.is_empty(), &previous) {
            let others = other_activations(&items, id, previous);
            let heirs = release_excludes(base, previous.exclude_list.as_deref(), release, &others, &mut checkouts);
            self.hand_over(heirs);
        }
        drop(_guard);
        Ok(Change {
            items: self.list()?,
            kept,
        })
    }

    pub fn deactivate(
        &self,
        id: &str,
        harness: &str,
        scope: Scope,
        root: Option<&Path>,
    ) -> Result<Change, String> {
        let base = self.base(scope, root)?;
        let project = (scope == Scope::Project).then(|| base.to_string_lossy().into_owned());
        let _guard = LOCK.lock().map_err(|e| e.to_string())?;
        let meta = self.load(id)?;
        let matches =
            |a: &Activation| a.harness == harness && a.scope == scope && a.project == project;
        let Some(activation) = meta.activations.iter().find(|a| matches(a)).cloned() else {
            return Err(format!("{} is not active there.", meta.name));
        };
        let items = self.list()?;
        let others = other_activations(&items, id, &activation);
        let (kept, heirs) = self.undo(id, meta.kind, &activation, Some(base), &others, &mut Checkouts::default());
        let mut activations: Vec<Activation> = meta
            .activations
            .iter()
            .filter(|a| !matches(a))
            .cloned()
            .collect();
        let heirs = heirs.into_iter().filter(|h| h.id != id || !inherit(&mut activations, h)).collect();
        self.save(&Meta {
            activations,
            ..meta
        })?;
        self.hand_over(heirs);
        drop(_guard);
        Ok(Change {
            items: self.list()?,
            kept,
        })
    }

    /// Records each kept exclude line in the activation of another item that relies on it.
    /// Runs after the change itself was saved, so a failure is logged, not returned: the line
    /// stays in the exclude list, only unowned.
    fn hand_over(&self, heirs: Vec<Heir>) {
        for heir in heirs {
            let handed = self.load(&heir.id).and_then(|mut meta| if inherit(&mut meta.activations, &heir) { self.save(&meta) } else { Ok(()) });
            if let Err(e) = handed {
                eprintln!("[skills] could not hand the exclude line {} to {}: {e}", heir.entry, heir.id);
            }
        }
    }

    /// Turns an item off for every harness and scope it was activated in, including
    /// activations an older build made that the page no longer offers a switch for. Each
    /// project activation is undone in the checkout it recorded; edited files stay (`kept`).
    pub fn deactivate_all(&self, id: &str) -> Result<Change, String> {
        let _guard = LOCK.lock().map_err(|e| e.to_string())?;
        let meta = self.load(id)?;
        let items = self.list()?;
        let mut kept = Vec::new();
        let mut checkouts = Checkouts::default();
        // Lines handed over within the loop go to the activations still to be undone.
        let mut pending = meta.activations.clone();
        for at in 0..pending.len() {
            let activation = pending[at].clone();
            // Heirs are only activations that remain after this loop's step: other items', and
            // this item's still to be undone (ones undone earlier are dropped with the record).
            let rest = pending[at + 1..].to_vec();
            let others: Vec<(&str, &Activation)> = items
                .iter()
                .filter(|item| item.meta.id != id)
                .flat_map(|item| item.meta.activations.iter().map(move |a| (item.meta.id.as_str(), a)))
                .chain(rest.iter().map(|a| (id, a)))
                .collect();
            let base = match activation.scope {
                Scope::User => Some(self.home.as_path()),
                Scope::Project => activation.project.as_deref().map(Path::new),
            };
            // A project activation without its checkout can't be undone: its record goes (no
            // place could ever turn it off) and its files are reported as kept.
            let (left, heirs) = self.undo(id, meta.kind, &activation, base, &others, &mut checkouts);
            kept.extend(left);
            let heirs = heirs.into_iter().filter(|h| h.id != id || !inherit(&mut pending[at + 1..], h)).collect();
            self.hand_over(heirs);
        }
        self.save(&Meta {
            activations: Vec::new(),
            ..meta
        })?;
        drop(_guard);
        Ok(Change {
            items: self.list()?,
            kept,
        })
    }

    /// Removes one activation's files (an edited file stays, unmanaged, and is returned) and
    /// the project exclude lines it added to `base` that no other activation in `others` still
    /// relies on, so a kept file shows in Git; the lines kept for others are returned for them
    /// to own. Recorded paths outside the activation's surface, and every path of a project
    /// activation whose folder is not plain, are returned as kept and never touched.
    fn undo(&self, id: &str, kind: Kind, activation: &Activation, base: Option<&Path>, others: &[(&str, &Activation)], checkouts: &mut Checkouts) -> (Vec<String>, Vec<Heir>) {
        let all = || activation.files.iter().map(|w| w.path.clone()).collect();
        let (base, checkout) = match (activation.scope, base) {
            (Scope::User, _) => (self.home.as_path(), None),
            (Scope::Project, Some(base)) if adapter::plain_project(base, &self.home) => (base, Some(base)),
            (Scope::Project, Some(base)) => {
                eprintln!("[skills] {} is not a project folder PandaCode works in; {id}'s files and exclude lines there were left alone", base.display());
                return (all(), Vec::new());
            }
            // A project activation without its checkout can't be checked for links: left as it is.
            (Scope::Project, None) => return (all(), Vec::new()),
        };
        let (files, mut kept) = self.vetted(id, kind, activation, base);
        kept.extend(remove_written(id, &activation.surface, &files, checkout));
        let heirs = match checkout {
            Some(base) => release_excludes(base, activation.exclude_list.as_deref(), activation.excluded.iter().cloned(), others, checkouts),
            None => Vec::new(),
        };
        (kept, heirs)
    }

    /// Refuses while anything is active, so no harness keeps files the library forgot.
    pub fn remove(&self, id: &str) -> Result<Vec<Item>, String> {
        {
            let _guard = LOCK.lock().map_err(|e| e.to_string())?;
            let meta = self.load(id)?;
            if !meta.activations.is_empty() {
                return Err(format!("Turn {} off everywhere before removing it.", meta.name));
            }
            fs::remove_dir_all(self.dir.join(id)).ok();
            fs::remove_file(self.meta_path(id)).map_err(|e| format!("Could not remove {id}: {e}"))?;
        }
        self.list()
    }

    fn status(meta: &Meta, activation: Option<&Activation>) -> &'static str {
        let Some(activation) = activation else { return "off" };
        if outside_surface(meta.kind, activation) {
            return "outdated";
        }
        let present = |w: &Written| match activation.surface.as_str() {
            "block" => adapter::read_text(Path::new(&w.path)).ok().map(|text| adapter::block(&text, &meta.id).map(|(body, _)| sha256_hex(body.as_bytes()) == w.sha256)),
            _ => adapter::file_hash(Path::new(&w.path)).map(|hash| Some(hash == w.sha256)),
        }
        .flatten();
        let states: Vec<Option<bool>> = activation.files.iter().map(present).collect();
        if activation.surface == "prompt" {
            "prompt"
        } else if states.iter().all(Option::is_none) {
            "missing"
        } else if states.iter().any(|s| *s != Some(true)) {
            "drifted"
        } else if activation.sha256 != meta.sha256 {
            "outdated"
        } else {
            "active"
        }
    }

    pub fn matrix(&self, root: Option<&Path>) -> Result<Matrix, String> {
        let metas: Vec<Meta> = self.list()?.into_iter().map(|i| i.meta).collect();
        let project = root.map(|r| r.to_string_lossy().into_owned());
        let mut scopes = vec![(Scope::User, self.home.as_path(), None)];
        if let Some(root) = root {
            scopes.push((Scope::Project, root, project.clone()));
        }
        let mut harnesses = Vec::new();
        for harness in adapter::FILE_HARNESSES.iter().chain(adapter::PROMPT_HARNESSES) {
            let prompt = !adapter::FILE_HARNESSES.contains(harness);
            let in_use = metas.iter().any(|m| m.activations.iter().any(|a| a.harness == *harness));
            let installed = !prompt && adapter::installed(harness, &self.home);
            if !installed && !in_use {
                continue;
            }
            let mut cells = Vec::new();
            let mut unmanaged = Vec::new();
            for (scope, base, scope_project) in &scopes {
                for meta in &metas {
                    let surface = match adapter::surface(harness, meta.kind, *scope, base) {
                        Surface::Folder(dir) => dir.join(&meta.id).to_string_lossy().into_owned(),
                        Surface::Block(file) => file.to_string_lossy().into_owned(),
                        Surface::Prompt => "prompt".into(),
                    };
                    cells.push(Cell { id: meta.id.clone(), scope: *scope, status: Self::status(meta, active_in(meta, harness, *scope, scope_project)), surface });
                }
                if prompt {
                    continue;
                }
                let managed: Vec<&str> = metas.iter().filter(|m| active_in(m, harness, *scope, scope_project).is_some()).map(|m| m.id.as_str()).collect();
                if let Surface::Folder(dir) = adapter::surface(harness, Kind::Skill, *scope, base) {
                    for (name, path) in adapter::skill_folders(&dir) {
                        if !managed.contains(&name.as_str()) {
                            let detail = if metas.iter().any(|m| m.id == name) { "Same name as a library skill, not written by PandaCode." } else { "Not in the library." };
                            unmanaged.push(Unmanaged { scope: *scope, kind: Kind::Skill, path: path.to_string_lossy().into_owned(), detail: detail.into() });
                        }
                    }
                }
                if let Surface::Block(file) = adapter::surface(harness, Kind::Rule, *scope, base) {
                    let path = file.to_string_lossy().into_owned();
                    match adapter::read_text(&file) {
                        Ok(text) => {
                            let (ids, other) = adapter::blocks_in(&text);
                            for id in ids.iter().filter(|id| !managed.contains(&id.as_str())) {
                                unmanaged.push(Unmanaged { scope: *scope, kind: Kind::Rule, path: path.clone(), detail: format!("Has a PandaCode block for {id} that the library does not track.") });
                            }
                            if other {
                                unmanaged.push(Unmanaged { scope: *scope, kind: Kind::Rule, path, detail: "Has instructions PandaCode does not manage.".into() });
                            }
                        }
                        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                        // Round 24: oversized, not text, or not a regular file (a link to
                        // `/dev/zero`, a FIFO) is never read in full.
                        Err(_) => unmanaged.push(Unmanaged { scope: *scope, kind: Kind::Rule, path, detail: "Has instructions PandaCode does not manage.".into() }),
                    }
                }
            }
            harnesses.push(HarnessRow {
                harness: harness.to_string(),
                installed,
                prompt,
                cells,
                unmanaged,
            });
        }
        Ok(Matrix { project, harnesses })
    }
}

/// Refuses a write to `target` when it is a link (`AGENTS.md -> CLAUDE.md`, `.agents/skills ->
/// ../.claude/skills`) to where another activation of the same item already wrote: writing it
/// twice would trip the edited-on-disk checks, and turning one off would break the other.
/// Only what is still there counts: a recorded block or file since removed does not.
fn shared_target<'a>(id: &str, others: impl Iterator<Item = &'a Activation>, base: &Path, target: &Path) -> Result<(), String> {
    let Some(real) = adapter::real_location(target) else { return Ok(()) };
    // Compared canonical on both sides: `base` itself may sit behind a link (`/var` on macOS).
    let plain = target.strip_prefix(base).ok().and_then(|inside| Some(adapter::real_location(base)?.join(inside)));
    let present = |surface: &str, path: &Path| match surface {
        "block" => adapter::read_text(path).ok().is_some_and(|text| adapter::block(&text, id).is_some()),
        _ => path.exists(),
    };
    for other in others {
        let lands_there = other.files.iter().any(|w| {
            let path = Path::new(&w.path);
            adapter::real_location(path).is_some_and(|at| at.starts_with(&real)) && present(&other.surface, path)
        });
        if lands_there {
            return Err(if plain.as_ref() == Some(&real) {
                format!("PandaCode already manages {} for {}.", target.display(), other.harness)
            } else {
                format!("{} is a link to {}, which PandaCode already manages for {}.", target.display(), real.display(), other.harness)
            });
        }
    }
    Ok(())
}

/// Every recorded activation of every item except `activation` of `id`, with its item's id.
fn other_activations<'a>(items: &'a [Item], id: &str, activation: &Activation) -> Vec<(&'a str, &'a Activation)> {
    let same = |a: &Activation| a.harness == activation.harness && a.scope == activation.scope && a.project == activation.project;
    items
        .iter()
        .flat_map(|item| item.meta.activations.iter().filter(move |a| item.meta.id != id || !same(a)).map(move |a| (item.meta.id.as_str(), a)))
        .collect()
}

/// Each checkout's exclude list and repository top level, resolved once per operation.
#[derive(Default)]
struct Checkouts(std::collections::HashMap<PathBuf, Option<(PathBuf, adapter::Checkout)>>);

impl Checkouts {
    fn get(&mut self, root: &Path) -> Option<&(PathBuf, adapter::Checkout)> {
        self.0.entry(root.to_path_buf()).or_insert_with(|| Some((adapter::exclude_list(root)?, adapter::Checkout::open(root)?))).as_ref()
    }
}

/// The other project activations that still have a file in place that `entry` of the
/// exclude list `list` hides: a rule sharing the CLAUDE.md the first one created, or the same
/// skill in another worktree sharing the repository's exclude list. Only activations whose
/// checkout uses `list` count.
fn exclude_heirs<'a>(list: &Path, entry: &str, others: &[(&'a str, &'a Activation)], checkouts: &mut Checkouts) -> Vec<(&'a str, &'a Activation)> {
    let covers = |line: &str| line == entry || (entry.ends_with('/') && line.starts_with(entry));
    others
        .iter()
        .filter(|(_, other)| {
            let (Scope::Project, Some(project)) = (other.scope, other.project.as_deref()) else { return false };
            let Some((theirs, checkout)) = checkouts.get(Path::new(project)) else { return false };
            theirs == list && other.files.iter().any(|w| {
                let path = Path::new(&w.path);
                path.exists() && checkout.entry(path, false).is_some_and(|line| covers(&line))
            })
        })
        .copied()
        .collect()
}

/// An exclude line handed to another activation (item `id`'s activation `harness`, `scope`,
/// `project`) that still relies on it, so the last one relying on it removes it.
struct Heir {
    id: String,
    harness: String,
    scope: Scope,
    project: Option<String>,
    entry: String,
    /// The exclude list holding `entry`.
    list: PathBuf,
}

/// Drops each of `entries` from `base`'s exclude list unless another activation in `others`
/// still relies on it; those lines are returned as handed to every such activation. When the
/// checkout can't be resolved (deleted, or its `.git` pruned), `stored` (the list recorded with
/// the lines) stands in for its list, but only while it still is a Git exclude list and is
/// vouched for: its Git folder still registers `base` as a worktree, or another live
/// activation's checkout uses it. Anything else is logged and the lines stay.
fn release_excludes(base: &Path, stored: Option<&str>, entries: impl IntoIterator<Item = String>, others: &[(&str, &Activation)], checkouts: &mut Checkouts) -> Vec<Heir> {
    let entries: Vec<String> = entries.into_iter().collect();
    if entries.is_empty() {
        return Vec::new();
    }
    let live = checkouts.get(base).map(|(list, _)| list.clone());
    if live.is_none() {
        eprintln!("[skills] could not resolve the Git exclude list of {}; using the recorded one if it is still valid", base.display());
    }
    let list = match (live.clone(), stored) {
        (Some(list), _) => list,
        (None, Some(stored)) => {
            let stored = PathBuf::from(stored);
            let vouched = adapter::trusted_exclude_list(&stored) && (adapter::registers_worktree(&stored, base) || live_lists(others, checkouts).contains(&stored));
            if !vouched {
                eprintln!("[skills] {} is not the Git exclude list of {} any more; its lines {} were left there", stored.display(), base.display(), entries.join(", "));
                return Vec::new();
            }
            stored
        }
        (None, None) => return hand_to_siblings(base, entries, others, checkouts),
    };
    let mut heirs = Vec::new();
    for entry in entries {
        let relying = exclude_heirs(&list, &entry, others, checkouts);
        if relying.is_empty() {
            let dropped = if live.is_some() { adapter::unexclude(base, &entry) } else { adapter::unexclude_at(&list, &entry) };
            if let Err(e) = dropped {
                eprintln!("[skills] could not remove the exclude line {entry}: {e}");
            }
        }
        heirs.extend(relying.into_iter().map(|(id, a)| Heir { id: id.into(), harness: a.harness.clone(), scope: a.scope, project: a.project.clone(), entry: entry.clone(), list: list.clone() }));
    }
    heirs
}

/// The exclude lists the live project checkouts of `others` use.
fn live_lists(others: &[(&str, &Activation)], checkouts: &mut Checkouts) -> Vec<PathBuf> {
    others.iter().filter_map(|(_, a)| a.project.as_deref().filter(|_| a.scope == Scope::Project)).filter_map(|project| checkouts.get(Path::new(project)).map(|(list, _)| list.clone())).collect()
}

/// Lines an older record (no recorded exclude list) left for a checkout that can't be
/// resolved: each is handed to the live activations of the same folder, or of a sibling
/// worktree whose Git folder still registers it, whose exclude list holds the line, so the
/// last one of them removes it. Lines nobody takes stay and are logged.
fn hand_to_siblings(base: &Path, entries: Vec<String>, others: &[(&str, &Activation)], checkouts: &mut Checkouts) -> Vec<Heir> {
    let mut heirs = Vec::new();
    for entry in entries {
        let before = heirs.len();
        for (id, other) in others {
            let (Scope::Project, Some(project)) = (other.scope, other.project.as_deref()) else { continue };
            let Some((list, _)) = checkouts.get(Path::new(project)) else { continue };
            let sibling = Path::new(project) == base || adapter::registers_worktree(list, base);
            if sibling && adapter::lists_line(list, &entry) {
                heirs.push(Heir { id: (*id).into(), harness: other.harness.clone(), scope: other.scope, project: other.project.clone(), entry: entry.clone(), list: list.clone() });
            }
        }
        if heirs.len() == before {
            eprintln!("[skills] the exclude line {entry} of {} was left in place: its checkout is gone and no other activation uses that exclude list", base.display());
        }
    }
    heirs
}

/// Adds `heir`'s line to the matching record in `activations`; whether one matched.
fn inherit(activations: &mut [Activation], heir: &Heir) -> bool {
    let Some(a) = activations.iter_mut().find(|a| a.harness == heir.harness && a.scope == heir.scope && a.project == heir.project) else { return false };
    if !a.excluded.contains(&heir.entry) {
        a.excluded.push(heir.entry.clone());
    }
    a.exclude_list = Some(heir.list.to_string_lossy().into_owned());
    true
}

/// What a failed save puts back: the previous activation's skill files (relative path and
/// bytes, written into the folder), its rule block's body, or nothing (the write is removed).
enum Restore {
    Remove,
    Folder(PathBuf, Files),
    Block(PathBuf, String),
}

impl Restore {
    /// Undoes the write `written` of `surface`; returns the files it had to leave in place.
    fn apply(self, id: &str, surface: &str, written: &[Written], checkout: Option<&Path>) -> Vec<String> {
        match self {
            Restore::Remove => remove_written(id, surface, written, checkout),
            Restore::Folder(dir, files) => adapter::write_folder(&dir, id, &files, written, checkout).map_or_else(|(e, left)| {
                eprintln!("[skills] could not put back the previous {id}: {e}");
                left
            }, |_| Vec::new()),
            Restore::Block(file, body) => match adapter::write_block(&file, id, &body, written.first(), checkout) {
                Ok(_) => Vec::new(),
                Err(e) => {
                    eprintln!("[skills] could not put back the previous {id} block: {e}");
                    vec![file.to_string_lossy().into_owned()]
                }
            },
        }
    }
}

/// The recorded files under `target` that still hold what was written, as relative paths and
/// bytes, so a failed save can write them back.
fn snapshot(target: &Path, written: &[Written]) -> Files {
    written
        .iter()
        .filter_map(|w| {
            let path = Path::new(&w.path);
            let relative = path.strip_prefix(target).ok()?.to_string_lossy().replace('\\', "/");
            let bytes = crate::workspace::read_regular_target(path, adapter::READ_LIMIT).ok()?;
            (sha256_hex(&bytes) == w.sha256).then_some((relative, bytes))
        })
        .collect()
}

/// Removes the files of a `surface` write that still match; returns the ones left in place.
fn remove_written(id: &str, surface: &str, files: &[Written], checkout: Option<&Path>) -> Vec<String> {
    match surface {
        "folder" => adapter::remove_folder(files, checkout),
        "block" => files.iter().filter(|w| !matches!(adapter::remove_block(w, id, checkout), Ok(true))).map(|w| w.path.clone()).collect(),
        _ => Vec::new(),
    }
}

/// ` Left in place: a, b.` for files a failed change could not take back, or nothing.
fn left_in_place(left: &[String]) -> String {
    if left.is_empty() { String::new() } else { format!(" Left in place: {}.", left.join(", ")) }
}

fn active_in<'m>(
    meta: &'m Meta,
    harness: &str,
    scope: Scope,
    project: &Option<String>,
) -> Option<&'m Activation> {
    meta.activations
        .iter()
        .find(|a| a.harness == harness && a.scope == scope && a.project == *project)
}

/// Whether a project activation's files sit outside the folder its harness reads now, as Codex
/// skills recorded under `.codex/skills` do since it moved to `.agents/skills`.
fn outside_surface(kind: Kind, activation: &Activation) -> bool {
    let Some(project) = activation
        .project
        .as_deref()
        .filter(|_| activation.surface == "folder")
    else {
        return false;
    };
    let Surface::Folder(dir) = adapter::surface(
        &activation.harness,
        kind,
        activation.scope,
        Path::new(project),
    ) else {
        return false;
    };
    activation
        .files
        .iter()
        .any(|file| !Path::new(&file.path).starts_with(&dir))
}

pub(crate) fn library(app: &AppHandle) -> Result<Library, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("skills");
    let home = crate::agent_usage_providers::home().ok_or("Could not find your home folder.")?;
    Ok(Library::new(dir, home))
}
fn repo_name(repo: &str) -> String {
    repo.trim()
        .trim_start_matches("https://github.com/")
        .trim_end_matches('/')
        .trim_end_matches(".git")
        .to_string()
}
fn root(
    state: &AppState,
    project_id: Option<String>,
    session_id: Option<String>,
) -> Result<Option<PathBuf>, String> {
    project_id
        .map(|id| state.root(&id, session_id.as_deref()))
        .transpose()
}

#[tauri::command]
pub async fn skills_list(app: AppHandle) -> crate::Result<Vec<Item>> {
    crate::blocking(move || library(&app)?.list()).await
}
#[tauri::command]
pub async fn skills_import_folder(app: AppHandle, path: String, kind: Kind) -> crate::Result<Item> {
    crate::blocking(move || {
        let path = PathBuf::from(path.trim());
        if !path.is_absolute() {
            return Err("Choose a folder or Markdown file.".into());
        }
        let files = read_local(&path)?;
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let source = Source {
            kind: "folder".into(),
            location: path.to_string_lossy().into_owned(),
            git_ref: None,
            commit: None,
        };
        library(&app)?.import(kind, files, &name, source)
    })
    .await
}
#[tauri::command]
pub async fn skills_import_github(
    app: AppHandle,
    repo: String,
    path: String,
    git_ref: Option<String>,
    kind: Kind,
) -> crate::Result<Item> {
    crate::blocking(move || {
        let repo = repo_name(&repo);
        let (files, commit) = github::fetch(&repo, &path, git_ref.as_deref())?;
        let path = path.trim_matches('/').to_string();
        let name = path
            .rsplit('/')
            .next()
            .filter(|n| !n.is_empty())
            .unwrap_or(repo.rsplit('/').next().unwrap_or_default())
            .to_string();
        let location = if path.is_empty() {
            repo
        } else {
            format!("{repo}/{path}")
        };
        library(&app)?.import(
            kind,
            files,
            &name,
            Source {
                kind: "github".into(),
                location,
                git_ref,
                commit: Some(commit),
            },
        )
    })
    .await
}
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn skills_activate(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    harness: String,
    scope: Scope,
    project_id: Option<String>,
    session_id: Option<String>,
    acknowledge: Option<bool>,
) -> crate::Result<Change> {
    let root = root(&state, project_id, session_id)?;
    crate::blocking(move || {
        library(&app)?.activate(
            &id,
            &harness,
            scope,
            root.as_deref(),
            acknowledge.unwrap_or(false),
        )
    })
    .await
}
#[tauri::command]
pub async fn skills_deactivate(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    harness: String,
    scope: Scope,
    project_id: Option<String>,
    session_id: Option<String>,
) -> crate::Result<Change> {
    let root = root(&state, project_id, session_id)?;
    crate::blocking(move || library(&app)?.deactivate(&id, &harness, scope, root.as_deref())).await
}
/// Turns a library item off everywhere it is active (Rules & library's way out of legacy
/// activations before **Remove**).
#[tauri::command]
pub async fn skills_deactivate_all(app: AppHandle, id: String) -> crate::Result<Change> {
    crate::blocking(move || library(&app)?.deactivate_all(&id)).await
}
#[tauri::command]
pub async fn skills_matrix(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: Option<String>,
    session_id: Option<String>,
) -> crate::Result<Matrix> {
    let root = root(&state, project_id, session_id)?;
    crate::blocking(move || library(&app)?.matrix(root.as_deref())).await
}
#[tauri::command]
pub async fn skills_scan(app: AppHandle, id: String) -> crate::Result<Vec<Finding>> {
    crate::blocking(move || library(&app)?.scan(&id)).await
}
#[tauri::command]
pub async fn skills_remove(app: AppHandle, id: String) -> crate::Result<Vec<Item>> {
    crate::blocking(move || library(&app)?.remove(&id)).await
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod folder_tests {
    use super::*;
    #[test]
    fn skills_list_items_carry_the_library_copy_folder_for_skills_only() {
        let base =
            std::env::temp_dir().join(format!("pandacode-skills-folder-{}", uuid::Uuid::new_v4()));
        let library = Library::new(base.join("library"), base.join("home"));
        let source = |kind: &str| Source {
            kind: kind.into(),
            location: "/source".into(),
            git_ref: None,
            commit: None,
        };
        let skill = library
            .import(
                Kind::Skill,
                vec![(
                    "SKILL.md".into(),
                    b"---\nname: Release\n---\nBody\n".to_vec(),
                )],
                "release",
                source("folder"),
            )
            .unwrap();
        let rule = library
            .import(
                Kind::Rule,
                vec![(
                    "guard.md".into(),
                    b"---\nname: Guard\n---\nNever.\n".to_vec(),
                )],
                "guard",
                source("folder"),
            )
            .unwrap();
        let folder = PathBuf::from(skill.folder.as_deref().unwrap());
        assert!(folder.is_absolute() && folder.join("SKILL.md").is_file());
        assert!(rule.folder.is_none());
        let listed = library.list().unwrap();
        let value = serde_json::to_value(&listed).unwrap();
        let by_id = |id: &str| {
            value
                .as_array()
                .unwrap()
                .iter()
                .find(|item| item["id"] == id)
                .unwrap()
                .clone()
        };
        assert_eq!(
            by_id(&skill.meta.id)["folder"],
            folder.to_string_lossy().as_ref()
        );
        assert!(by_id(&rule.meta.id).get("folder").is_none());
        let _ = fs::remove_dir_all(base);
    }
}
#[cfg(test)]
mod deactivate_all_tests {
    use super::*;
    #[test]
    fn skills_deactivate_all_undoes_legacy_activations_everywhere_so_remove_succeeds() {
        let base =
            std::env::temp_dir().join(format!("pandacode-skills-off-{}", uuid::Uuid::new_v4()));
        let home = base.join("home");
        fs::create_dir_all(home.join(".claude")).unwrap();
        fs::create_dir_all(home.join(".codex")).unwrap();
        let project = base.join("project");
        fs::create_dir_all(&project).unwrap();
        let library = Library::new(base.join("library"), home.clone());
        let source = Source {
            kind: "folder".into(),
            location: "/source".into(),
            git_ref: None,
            commit: None,
        };
        let item = library
            .import(
                Kind::Skill,
                vec![(
                    "SKILL.md".into(),
                    b"---\nname: Release\n---\nBody\n".to_vec(),
                )],
                "release",
                source,
            )
            .unwrap();
        let id = item.meta.id.clone();
        library
            .activate(&id, "claude", Scope::User, None, false)
            .unwrap();
        library
            .activate(&id, "codex", Scope::User, None, false)
            .unwrap();
        library
            .activate(&id, "claude", Scope::Project, Some(&project), false)
            .unwrap();
        let user_copy = home.join(".claude/skills").join(&id).join("SKILL.md");
        let project_copy = project.join(".claude/skills").join(&id).join("SKILL.md");
        assert!(user_copy.is_file() && project_copy.is_file());
        assert!(library.remove(&id).unwrap_err().contains("off everywhere"));
        // An edited copy stays where it is and is reported.
        fs::write(&project_copy, "my edit").unwrap();
        let change = library.deactivate_all(&id).unwrap();
        assert_eq!(change.kept, [project_copy.to_string_lossy().into_owned()]);
        assert!(!user_copy.exists());
        assert!(!home.join(".codex/skills").join(&id).exists());
        assert_eq!(fs::read_to_string(&project_copy).unwrap(), "my edit");
        assert!(change.items.iter().all(|i| i.meta.activations.is_empty()));
        assert!(library.remove(&id).unwrap().is_empty());
        assert!(library.deactivate_all("missing").is_err());
        let _ = fs::remove_dir_all(base);
    }
}
