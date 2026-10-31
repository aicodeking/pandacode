//! Skills library and rules registry (issues #15 and #45). Skills and rules live as files under
//! the app data folder: `skills/<id>/SKILL.md` (or `RULE.md`) plus `skills/<id>.json` with their
//! source, content hash and activations. Activation writes them where each harness reads them
//! (`skills/adapter.rs`), never over a file PandaCode did not write, and reports drift.
mod adapter;
mod catalog;
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
fn frontmatter(text: &str) -> (Option<String>, Option<String>, &str) {
    let Some(rest) = text.strip_prefix("---\n").or_else(|| text.strip_prefix("---\r\n")) else { return (None, None, text) };
    let Some(end) = rest.find("\n---") else { return (None, None, text) };
    let lines: Vec<&str> = rest[..end].lines().collect();
    let field = |key: &str| {
        let at = lines.iter().position(|line| line.starts_with(key))?;
        let value = lines[at][key.len()..].trim();
        // A YAML block scalar (`description: >-`) continues on the indented lines below it.
        let value = if matches!(value, "|" | ">" | "|-" | ">-" | "|+" | ">+") {
            lines[at + 1..].iter().take_while(|l| l.starts_with([' ', '\t']) || l.trim().is_empty()).map(|l| l.trim()).filter(|l| !l.is_empty()).collect::<Vec<_>>().join(" ")
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
fn read_local(path: &Path) -> Result<Files, String> {
    let meta = fs::symlink_metadata(path).map_err(|e| format!("Could not read {}: {e}", path.display()))?;
    if meta.is_file() {
        if meta.len() as usize > MAX_BYTES {
            return Err("That file is larger than 1 MB.".into());
        }
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "SKILL.md".into());
        return Ok(vec![(name, fs::read(path).map_err(|e| e.to_string())?)]);
    }
    let mut files = Vec::new();
    let mut total = 0;
    let mut pending = vec![path.to_path_buf()];
    while let Some(dir) = pending.pop() {
        for entry in fs::read_dir(&dir).map_err(|e| format!("Could not read {}: {e}", dir.display()))?.flatten() {
            if entry.file_name().to_string_lossy().starts_with('.') {
                continue;
            }
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_dir() {
                pending.push(entry.path());
            } else if kind.is_file() {
                let bytes = fs::read(entry.path()).map_err(|e| e.to_string())?;
                total += bytes.len();
                if files.len() >= MAX_FILES || total > MAX_BYTES {
                    return Err(format!("That folder holds more than {MAX_FILES} files or 1 MB."));
                }
                let relative = entry.path().strip_prefix(path).map_err(|e| e.to_string())?.to_string_lossy().replace('\\', "/");
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
        let findings = files.iter().flat_map(|(path, bytes)| safety::scan(path, &String::from_utf8_lossy(bytes))).collect();
        Ok(Item { files: files.into_iter().map(|(p, _)| p).collect(), findings, meta })
    }

    pub fn list(&self) -> Result<Vec<Item>, String> {
        let Ok(entries) = fs::read_dir(&self.dir) else { return Ok(Vec::new()) };
        let mut ids: Vec<String> = entries
            .flatten()
            .filter_map(|e| e.file_name().to_str()?.strip_suffix(".json").map(str::to_string))
            .filter(|id| valid_id(id))
            .collect();
        ids.sort();
        ids.into_iter().map(|id| self.load(&id).and_then(|meta| self.item(meta))).collect()
    }

    /// Add or update an item. Updating keeps activations; they show as outdated until the
    /// user activates again, so a new version never reaches a harness without them.
    pub fn import(&self, kind: Kind, files: Files, fallback_name: &str, source: Source) -> Result<Item, String> {
        self.import_as(kind, files, fallback_name, source, false)
    }

    /// `import`, refusing (under the library lock, so a concurrent import cannot slip in
    /// between a check and the write) to replace an item that came from another source.
    pub(crate) fn import_as(&self, kind: Kind, files: Files, fallback_name: &str, source: Source, same_source_only: bool) -> Result<Item, String> {
        let files = normalize(kind, files)?;
        let main = files.iter().find(|(p, _)| p == main_file(kind)).map(|(_, b)| String::from_utf8_lossy(b).into_owned()).unwrap_or_default();
        let (name, description, body) = frontmatter(&main);
        let name = name.unwrap_or_else(|| fallback_name.trim_end_matches(".md").to_string());
        let description = description.unwrap_or_else(|| body.lines().map(str::trim).find(|l| !l.is_empty() && !l.starts_with('#')).unwrap_or_default().chars().take(200).collect());
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
        let old_files = previous.as_ref().map(|a| a.files.clone()).unwrap_or_default();
        let mut excluded = previous.as_ref().map(|a| a.excluded.clone()).unwrap_or_default();
        let files = self.files(id)?;
        let (surface, written) = match adapter::surface(harness, meta.kind, scope, base) {
            Surface::Folder(dir) => {
                let written = adapter::write_folder(&dir, id, &files, &old_files)?;
                if scope == Scope::Project {
                    if let Some(entry) = adapter::exclude_entry(base, &dir.join(id), true) {
                        if adapter::exclude(base, &entry)? {
                            excluded.push(entry);
                        }
                    }
                }
                ("folder", written)
            }
            Surface::Block(file) => {
                let created = !file.exists();
                let text = files.first().map(|(_, b)| String::from_utf8_lossy(b).into_owned()).unwrap_or_default();
                let (_, _, body) = frontmatter(&text);
                let written = adapter::write_block(&file, id, body, old_files.first())?;
                if scope == Scope::Project && created {
                    if let Some(entry) = adapter::exclude_entry(base, &file, false) {
                        if adapter::exclude(base, &entry)? {
                            excluded.push(entry);
                        }
                    }
                }
                ("block", vec![written])
            }
            Surface::Prompt => ("prompt", Vec::new()),
        };
        let activation = Activation { harness: harness.into(), scope, project: project.clone(), surface: surface.into(), sha256: meta.sha256.clone(), files: written, excluded };
        let activations = meta.activations.iter().filter(|a| !matches(a)).cloned().chain([activation]).collect();
        self.save(&Meta { acknowledged, activations, ..meta })?;
        drop(_guard);
        Ok(Change { items: self.list()?, kept: Vec::new() })
    }

    pub fn deactivate(&self, id: &str, harness: &str, scope: Scope, root: Option<&Path>) -> Result<Change, String> {
        let base = self.base(scope, root)?;
        let project = (scope == Scope::Project).then(|| base.to_string_lossy().into_owned());
        let _guard = LOCK.lock().map_err(|e| e.to_string())?;
        let meta = self.load(id)?;
        let matches = |a: &Activation| a.harness == harness && a.scope == scope && a.project == project;
        let Some(activation) = meta.activations.iter().find(|a| matches(a)).cloned() else {
            return Err(format!("{} is not active there.", meta.name));
        };
        let kept = match activation.surface.as_str() {
            "folder" => adapter::remove_folder(&activation.files),
            "block" => activation.files.iter().filter(|w| !matches!(adapter::remove_block(w, id), Ok(true))).map(|w| w.path.clone()).collect(),
            _ => Vec::new(),
        };
        if scope == Scope::Project && kept.is_empty() {
            for entry in &activation.excluded {
                adapter::unexclude(base, entry);
            }
        }
        let activations = meta.activations.iter().filter(|a| !matches(a)).cloned().collect();
        self.save(&Meta { activations, ..meta })?;
        drop(_guard);
        Ok(Change { items: self.list()?, kept })
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
        let present = |w: &Written| match activation.surface.as_str() {
            "block" => fs::read_to_string(&w.path).ok().map(|text| adapter::block(&text, &meta.id).map(|(body, _)| sha256_hex(body.as_bytes()) == w.sha256)),
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
                    if let Ok(text) = fs::read_to_string(&file) {
                        let (ids, other) = adapter::blocks_in(&text);
                        let path = file.to_string_lossy().into_owned();
                        for id in ids.iter().filter(|id| !managed.contains(&id.as_str())) {
                            unmanaged.push(Unmanaged { scope: *scope, kind: Kind::Rule, path: path.clone(), detail: format!("Has a PandaCode block for {id} that the library does not track.") });
                        }
                        if other {
                            unmanaged.push(Unmanaged { scope: *scope, kind: Kind::Rule, path, detail: "Has instructions PandaCode does not manage.".into() });
                        }
                    }
                }
            }
            harnesses.push(HarnessRow { harness: harness.to_string(), installed, prompt, cells, unmanaged });
        }
        Ok(Matrix { project, harnesses })
    }
}

fn active_in<'m>(meta: &'m Meta, harness: &str, scope: Scope, project: &Option<String>) -> Option<&'m Activation> {
    meta.activations.iter().find(|a| a.harness == harness && a.scope == scope && a.project == *project)
}

pub(crate) fn library(app: &AppHandle) -> Result<Library, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("skills");
    let home = crate::agent_usage_providers::home().ok_or("Could not find your home folder.")?;
    Ok(Library::new(dir, home))
}
fn repo_name(repo: &str) -> String {
    repo.trim().trim_start_matches("https://github.com/").trim_end_matches('/').trim_end_matches(".git").to_string()
}
fn root(state: &AppState, project_id: Option<String>, session_id: Option<String>) -> Result<Option<PathBuf>, String> {
    project_id.map(|id| state.root(&id, session_id.as_deref())).transpose()
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
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let source = Source { kind: "folder".into(), location: path.to_string_lossy().into_owned(), git_ref: None, commit: None };
        library(&app)?.import(kind, files, &name, source)
    })
    .await
}
#[tauri::command]
pub async fn skills_import_github(app: AppHandle, repo: String, path: String, git_ref: Option<String>, kind: Kind) -> crate::Result<Item> {
    crate::blocking(move || {
        let repo = repo_name(&repo);
        let (files, commit) = github::fetch(&repo, &path, git_ref.as_deref())?;
        let path = path.trim_matches('/').to_string();
        let name = path.rsplit('/').next().filter(|n| !n.is_empty()).unwrap_or(repo.rsplit('/').next().unwrap_or_default()).to_string();
        let location = if path.is_empty() { repo } else { format!("{repo}/{path}") };
        library(&app)?.import(kind, files, &name, Source { kind: "github".into(), location, git_ref, commit: Some(commit) })
    })
    .await
}
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn skills_activate(app: AppHandle, state: State<'_, AppState>, id: String, harness: String, scope: Scope, project_id: Option<String>, session_id: Option<String>, acknowledge: Option<bool>) -> crate::Result<Change> {
    let root = root(&state, project_id, session_id)?;
    crate::blocking(move || library(&app)?.activate(&id, &harness, scope, root.as_deref(), acknowledge.unwrap_or(false))).await
}
#[tauri::command]
pub async fn skills_deactivate(app: AppHandle, state: State<'_, AppState>, id: String, harness: String, scope: Scope, project_id: Option<String>, session_id: Option<String>) -> crate::Result<Change> {
    let root = root(&state, project_id, session_id)?;
    crate::blocking(move || library(&app)?.deactivate(&id, &harness, scope, root.as_deref())).await
}
#[tauri::command]
pub async fn skills_matrix(app: AppHandle, state: State<'_, AppState>, project_id: Option<String>, session_id: Option<String>) -> crate::Result<Matrix> {
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

#[tauri::command]
pub async fn skills_catalogs(app: AppHandle) -> crate::Result<catalog::Catalogs> {
    crate::blocking(move || library(&app)?.catalogs()).await
}
#[tauri::command]
pub async fn skills_catalog_add(app: AppHandle, repo: String, git_ref: Option<String>) -> crate::Result<catalog::Catalogs> {
    let git_ref = git_ref.map(|r| r.trim().to_string()).filter(|r| !r.is_empty());
    crate::blocking(move || library(&app)?.add_catalog(&github::api, &repo_name(&repo), git_ref)).await
}
#[tauri::command]
pub async fn skills_catalog_refresh(app: AppHandle, repo: String) -> crate::Result<catalog::Catalogs> {
    crate::blocking(move || library(&app)?.refresh_catalog(&github::api, &repo)).await
}
#[tauri::command]
pub async fn skills_catalog_state(app: AppHandle, repo: String, state: catalog::State) -> crate::Result<catalog::Catalogs> {
    crate::blocking(move || library(&app)?.set_catalog_state(&repo, state)).await
}
#[tauri::command]
pub async fn skills_catalog_import(app: AppHandle, repo: String, paths: Option<Vec<String>>) -> crate::Result<catalog::Imported> {
    crate::blocking(move || library(&app)?.import_catalog(&github::api, &repo, paths.as_deref())).await
}
#[tauri::command]
pub async fn skills_discover(app: AppHandle) -> crate::Result<catalog::Catalogs> {
    crate::blocking(move || library(&app)?.discover(&github::api)).await
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod catalog_tests;
