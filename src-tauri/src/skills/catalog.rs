//! Repository catalogs (#114) and discovery of the user's own skill repositories (#115).
//! A catalog source is a GitHub repository scanned for `SKILL.md` packages whose frontmatter has
//! a `name` and a `description`. A source is an index only: importing copies chosen skills into
//! the library, and nothing here activates a skill, runs a script or changes a harness.
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::BTreeMap, fs, path::PathBuf, sync::Mutex};

use super::{frontmatter, github, now_ms, slug, Item, Kind, Library, Source, MAX_BYTES, MAX_FILES};

/// One GitHub REST call (`gh api <endpoint>` in the app, a fixture in tests).
pub type Api<'a> = &'a dyn Fn(&str) -> Result<Value, String>;

/// Files and folders read from one repository tree.
pub const MAX_TREE_ENTRIES: usize = 20_000;
/// `SKILL.md` files indexed from one repository.
pub const MAX_SKILLS: usize = 300;
/// Pages of 100 repositories that discovery reads.
pub const MAX_REPO_PAGES: usize = 10;
const PER_PAGE: usize = 100;
// ponytail: one lock for every catalog change, held across the network calls of a scan.
static STORE: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum State {
    Enabled,
    Disabled,
    Ignored,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogSkill {
    /// The folder that holds the SKILL.md, empty for the repository root.
    pub path: String,
    /// The library id the skill imports as.
    pub id: String,
    pub name: String,
    pub description: String,
    pub files: usize,
    pub bytes: u64,
    /// The commit of the library copy imported from this same path.
    #[serde(default, skip_deserializing)]
    pub imported: Option<String>,
    /// Other places (catalog paths or library sources) with a skill of the same id.
    #[serde(default, skip_deserializing)]
    pub conflicts: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogSource {
    pub repo: String,
    pub git_ref: Option<String>,
    /// The commit the index was read from; imports use it.
    pub commit: Option<String>,
    /// `manual` or `discovered`.
    pub origin: String,
    pub state: State,
    #[serde(default)]
    pub private: bool,
    pub pushed_at: Option<String>,
    pub scanned_at: u64,
    pub skills: Vec<CatalogSkill>,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Discovery {
    pub at: u64,
    pub checked: usize,
    pub registered: Vec<String>,
    pub failures: Vec<String>,
    pub note: Option<String>,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalogs {
    pub sources: Vec<CatalogSource>,
    pub discovery: Option<Discovery>,
    /// Repositories discovery found without skills, by `pushed_at`, so unchanged ones are skipped.
    #[serde(default)]
    pub empty: BTreeMap<String, String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Skipped {
    pub path: String,
    pub name: String,
    pub reason: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Imported {
    pub items: Vec<Item>,
    pub imported: Vec<String>,
    pub skipped: Vec<Skipped>,
}

/// `owner/name` or `owner/name/path`, the same form a single GitHub import records.
pub fn location(repo: &str, path: &str) -> String {
    if path.is_empty() { repo.to_string() } else { format!("{repo}/{path}") }
}
fn same(a: &str, b: &str) -> bool {
    a.eq_ignore_ascii_case(b)
}
fn under(path: &str, dir: &str) -> bool {
    dir.is_empty() || path.strip_prefix(dir).is_some_and(|rest| rest.starts_with('/'))
}

/// A GitHub CLI error in words the user can act on. Rate limits and sign-in stop discovery.
pub fn explain(error: &str) -> String {
    let lower = error.to_ascii_lowercase();
    if lower.contains("rate limit") || lower.contains("http 429") {
        format!("GitHub's rate limit was reached. Try again later. ({})", error.trim())
    } else if lower.contains("http 401") || lower.contains("gh auth login") || lower.contains("not logged in") || lower.contains("bad credentials") {
        "The GitHub CLI is not signed in. Run `gh auth login`, then try again.".into()
    } else if lower.contains("http 404") || lower.contains("not found") {
        "That repository was not found, or your GitHub login cannot read it.".into()
    } else {
        error.trim().to_string()
    }
}
fn fatal(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    lower.contains("rate limit") || lower.contains("http 429") || lower.contains("http 401") || lower.contains("gh auth login") || lower.contains("not logged in") || lower.contains("bad credentials")
}

struct Blob {
    path: String,
    sha: String,
    size: u64,
}
struct Tree {
    commit: String,
    blobs: Vec<Blob>,
    /// Folders that hold a SKILL.md.
    dirs: Vec<String>,
}
impl Tree {
    /// The files of the skill in `dir`, leaving out any nested skill folder.
    fn files_of(&self, dir: &str) -> Vec<&Blob> {
        self.blobs.iter().filter(|b| under(&b.path, dir) && !self.dirs.iter().any(|d| d != dir && under(d, dir) && under(&b.path, d))).collect()
    }
}

fn tree(api: Api, repo: &str, git_ref: Option<&str>) -> Result<Tree, String> {
    if !github::valid_repo(repo) {
        return Err("Enter the repository as owner/name.".into());
    }
    if git_ref.is_some_and(|r| !github::valid_ref(r)) {
        return Err("That branch, tag or commit is not valid.".into());
    }
    let commit = api(&format!("repos/{repo}/commits/{}", git_ref.unwrap_or("HEAD")))?["sha"].as_str().ok_or("GitHub did not return a commit for that ref.")?.to_string();
    let value = api(&format!("repos/{repo}/git/trees/{commit}?recursive=1"))?;
    if value["truncated"].as_bool() == Some(true) {
        return Err(format!("{repo} is too large for GitHub to list at once. Import a path from it instead."));
    }
    let entries = value["tree"].as_array().ok_or("GitHub returned an unexpected tree.")?;
    if entries.len() > MAX_TREE_ENTRIES {
        return Err(format!("{repo} has more than {MAX_TREE_ENTRIES} files and folders. Import a path from it instead."));
    }
    let blobs: Vec<Blob> = entries
        .iter()
        .filter(|e| e["type"] == "blob")
        .filter_map(|e| {
            let path = e["path"].as_str()?;
            if !github::valid_path(path) || path.split('/').any(|p| p.starts_with('.')) {
                return None;
            }
            Some(Blob { path: path.into(), sha: e["sha"].as_str()?.into(), size: e["size"].as_u64().unwrap_or(0) })
        })
        .collect();
    let dirs: Vec<String> = blobs.iter().filter(|b| b.path == "SKILL.md" || b.path.ends_with("/SKILL.md")).map(|b| b.path.rsplit_once('/').map(|(d, _)| d).unwrap_or("").to_string()).collect();
    if dirs.len() > MAX_SKILLS {
        return Err(format!("{repo} has more than {MAX_SKILLS} SKILL.md files. Import a path from it instead."));
    }
    Ok(Tree { commit, blobs, dirs })
}

fn blob(api: Api, repo: &str, sha: &str) -> Result<Vec<u8>, String> {
    let value = api(&format!("repos/{repo}/git/blobs/{sha}"))?;
    let content = value["content"].as_str().ok_or("GitHub returned an unexpected file.")?;
    base64::engine::general_purpose::STANDARD.decode(content.replace(['\n', '\r'], "")).map_err(|_| "GitHub returned unreadable content.".to_string())
}

/// The commit and the valid skill packages of `repo` at `git_ref` (default branch when `None`).
pub fn scan(api: Api, repo: &str, git_ref: Option<&str>) -> Result<(String, Vec<CatalogSkill>), String> {
    let tree = tree(api, repo, git_ref)?;
    let mut skills = Vec::new();
    for dir in &tree.dirs {
        let main = if dir.is_empty() { "SKILL.md".to_string() } else { format!("{dir}/SKILL.md") };
        let Some(entry) = tree.blobs.iter().find(|b| b.path == main) else { continue };
        if entry.size as usize > MAX_BYTES {
            continue;
        }
        let text = String::from_utf8(blob(api, repo, &entry.sha)?).unwrap_or_default();
        let (Some(name), Some(description), _) = frontmatter(&text) else { continue };
        let id = slug(&name);
        if id.is_empty() {
            continue;
        }
        let files = tree.files_of(dir);
        skills.push(CatalogSkill { path: dir.clone(), id, name, description, files: files.len(), bytes: files.iter().map(|b| b.size).sum(), imported: None, conflicts: Vec::new() });
    }
    skills.sort_by(|a, b| a.path.cmp(&b.path));
    Ok((tree.commit, skills))
}

fn upsert(catalogs: &mut Catalogs, source: CatalogSource) {
    catalogs.empty.remove(&source.repo);
    match catalogs.sources.iter_mut().find(|s| same(&s.repo, &source.repo)) {
        Some(existing) => *existing = source,
        None => catalogs.sources.push(source),
    }
    catalogs.sources.sort_by_key(|s| s.repo.to_ascii_lowercase());
}

/// Marks each indexed skill with its library copy and any same-id skill from elsewhere.
fn annotate(mut catalogs: Catalogs, items: &[Item]) -> Catalogs {
    let mut holders: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for item in items {
        holders.entry(item.meta.id.clone()).or_default().push(item.meta.source.location.clone());
    }
    for source in catalogs.sources.iter().filter(|s| s.state != State::Ignored) {
        for skill in &source.skills {
            holders.entry(skill.id.clone()).or_default().push(location(&source.repo, &skill.path));
        }
    }
    for source in &mut catalogs.sources {
        for skill in &mut source.skills {
            let here = location(&source.repo, &skill.path);
            let mut others: Vec<String> = holders.get(&skill.id).into_iter().flatten().filter(|l| !same(l, &here)).cloned().collect();
            others.sort();
            others.dedup();
            skill.conflicts = others;
            skill.imported = items.iter().find(|i| i.meta.id == skill.id && i.meta.source.kind == "github" && same(&i.meta.source.location, &here)).and_then(|i| i.meta.source.commit.clone());
        }
    }
    catalogs
}

impl Library {
    fn catalogs_path(&self) -> PathBuf {
        // Hidden, so `list()` never reads it as a library entry.
        self.dir.join(".catalogs.json")
    }
    fn load_catalogs(&self) -> Result<Catalogs, String> {
        match fs::read(self.catalogs_path()) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| format!("The catalog list is damaged: {e}")),
            Err(_) => Ok(Catalogs::default()),
        }
    }
    fn save_catalogs(&self, catalogs: &Catalogs) -> Result<(), String> {
        fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
        let json = serde_json::to_vec_pretty(catalogs).map_err(|e| e.to_string())?;
        let temp = self.dir.join(".catalogs.json.tmp");
        fs::write(&temp, json).and_then(|_| fs::rename(&temp, self.catalogs_path())).map_err(|e| format!("Could not save the catalogs: {e}"))
    }

    pub fn catalogs(&self) -> Result<Catalogs, String> {
        Ok(annotate(self.load_catalogs()?, &self.list()?))
    }

    /// Scan a repository the user named and add (or refresh) it as an enabled source.
    pub fn add_catalog(&self, api: Api, repo: &str, git_ref: Option<String>) -> Result<Catalogs, String> {
        let _guard = STORE.lock().map_err(|e| e.to_string())?;
        let (commit, skills) = scan(api, repo, git_ref.as_deref()).map_err(|e| explain(&e))?;
        if skills.is_empty() {
            return Err(format!("{repo} has no SKILL.md with a name and description in its frontmatter."));
        }
        let mut catalogs = self.load_catalogs()?;
        let previous = catalogs.sources.iter().find(|s| same(&s.repo, repo)).cloned();
        let source = CatalogSource {
            repo: previous.as_ref().map(|p| p.repo.clone()).unwrap_or_else(|| repo.to_string()),
            origin: previous.as_ref().map(|p| p.origin.clone()).unwrap_or_else(|| "manual".into()),
            private: previous.as_ref().is_some_and(|p| p.private),
            pushed_at: previous.and_then(|p| p.pushed_at),
            git_ref, commit: Some(commit), state: State::Enabled, scanned_at: now_ms(), skills,
        };
        upsert(&mut catalogs, source);
        self.save_catalogs(&catalogs)?;
        drop(_guard);
        self.catalogs()
    }

    /// Read a source again at its ref. Only the index changes; library copies stay as imported.
    pub fn refresh_catalog(&self, api: Api, repo: &str) -> Result<Catalogs, String> {
        let _guard = STORE.lock().map_err(|e| e.to_string())?;
        let mut catalogs = self.load_catalogs()?;
        let source = catalogs.sources.iter().find(|s| same(&s.repo, repo)).cloned().ok_or("That repository is not in your catalogs.")?;
        if source.state == State::Ignored {
            return Err(format!("{} is ignored. Stop ignoring it to refresh.", source.repo));
        }
        let (commit, skills) = scan(api, &source.repo, source.git_ref.as_deref()).map_err(|e| explain(&e))?;
        upsert(&mut catalogs, CatalogSource { commit: Some(commit), skills, scanned_at: now_ms(), ..source });
        self.save_catalogs(&catalogs)?;
        drop(_guard);
        self.catalogs()
    }

    pub fn set_catalog_state(&self, repo: &str, state: State) -> Result<Catalogs, String> {
        let _guard = STORE.lock().map_err(|e| e.to_string())?;
        let mut catalogs = self.load_catalogs()?;
        let source = catalogs.sources.iter_mut().find(|s| same(&s.repo, repo)).ok_or("That repository is not in your catalogs.")?;
        source.state = state;
        self.save_catalogs(&catalogs)?;
        drop(_guard);
        self.catalogs()
    }

    /// List the signed-in user's own repositories, page by page, and register each one that has
    /// valid skill packages. Ignored and disabled sources are skipped, unchanged repositories are
    /// not read again, and a rate limit or sign-in failure stops the run after saving progress.
    pub fn discover(&self, api: Api) -> Result<Catalogs, String> {
        let _guard = STORE.lock().map_err(|e| e.to_string())?;
        let mut catalogs = self.load_catalogs()?;
        let mut report = Discovery { at: now_ms(), ..Discovery::default() };
        let mut outcome = Ok(());
        'pages: for page in 1..=MAX_REPO_PAGES {
            let repos = match api(&format!("user/repos?affiliation=owner&per_page={PER_PAGE}&page={page}&sort=full_name")) {
                Ok(Value::Array(repos)) => repos,
                Ok(_) => {
                    outcome = Err("GitHub returned an unexpected repository list.".to_string());
                    break;
                }
                Err(e) => {
                    outcome = Err(explain(&e));
                    break;
                }
            };
            for repo in &repos {
                let Some(name) = repo["full_name"].as_str() else { continue };
                let pushed = repo["pushed_at"].as_str().map(str::to_string);
                report.checked += 1;
                let existing = catalogs.sources.iter().find(|s| same(&s.repo, name)).cloned();
                match &existing {
                    Some(s) if s.state != State::Enabled => continue,
                    Some(s) if pushed.is_some() && s.pushed_at == pushed => continue,
                    None if pushed.is_some() && catalogs.empty.get(name) == pushed.as_ref() => continue,
                    _ => {}
                }
                if repo["size"].as_u64() == Some(0) {
                    catalogs.empty.insert(name.to_string(), pushed.unwrap_or_default());
                    continue;
                }
                let git_ref = existing.as_ref().and_then(|s| s.git_ref.clone());
                match scan(api, name, git_ref.as_deref()) {
                    Ok((_, skills)) if skills.is_empty() && existing.is_none() => {
                        catalogs.empty.insert(name.to_string(), pushed.unwrap_or_default());
                    }
                    Ok((commit, skills)) => {
                        if existing.is_none() {
                            report.registered.push(name.to_string());
                        }
                        let origin = existing.as_ref().map(|s| s.origin.clone()).unwrap_or_else(|| "discovered".into());
                        let private = repo["private"].as_bool().unwrap_or(false);
                        upsert(&mut catalogs, CatalogSource { repo: name.to_string(), git_ref, commit: Some(commit), origin, state: State::Enabled, private, pushed_at: pushed, scanned_at: now_ms(), skills });
                    }
                    Err(e) if fatal(&e) => {
                        outcome = Err(explain(&e));
                        break 'pages;
                    }
                    Err(e) => report.failures.push(format!("{name}: {}", explain(&e))),
                }
            }
            if repos.len() < PER_PAGE {
                break;
            }
            if page == MAX_REPO_PAGES {
                report.note = Some(format!("Checked the first {} repositories.", MAX_REPO_PAGES * PER_PAGE));
            }
        }
        catalogs.discovery = Some(report);
        self.save_catalogs(&catalogs)?;
        drop(_guard);
        outcome?;
        self.catalogs()
    }

    /// Copy chosen skills (all when `paths` is `None`) from a source at its indexed commit.
    /// A skill whose id the library already holds from another source is skipped, never
    /// overwritten. Nothing is activated.
    pub fn import_catalog(&self, api: Api, repo: &str, paths: Option<&[String]>) -> Result<Imported, String> {
        let catalogs = self.load_catalogs()?;
        let source = catalogs.sources.iter().find(|s| same(&s.repo, repo)).ok_or("That repository is not in your catalogs.")?;
        if source.state != State::Enabled {
            return Err(format!("{} is {}. Enable it to import from it.", source.repo, if source.state == State::Ignored { "ignored" } else { "disabled" }));
        }
        let commit = source.commit.clone().ok_or("Refresh this source before importing.")?;
        let chosen: Vec<&CatalogSkill> = source.skills.iter().filter(|s| paths.is_none_or(|p| p.contains(&s.path))).collect();
        if chosen.is_empty() {
            return Err("Choose at least one skill to import.".into());
        }
        let tree = tree(api, &source.repo, Some(&commit)).map_err(|e| explain(&e))?;
        let (mut imported, mut skipped) = (Vec::new(), Vec::new());
        for skill in chosen {
            let here = location(&source.repo, &skill.path);
            let skip = |reason: String| Skipped { path: skill.path.clone(), name: skill.name.clone(), reason };
            if let Some(taken) = self.load(&skill.id).ok().filter(|m| !same(&m.source.location, &here)) {
                skipped.push(skip(format!("{} is already in the library from {}.", skill.id, taken.source.location)));
                continue;
            }
            let files = tree.files_of(&skill.path);
            if files.len() > MAX_FILES {
                skipped.push(skip(format!("{} has more than {MAX_FILES} files.", skill.name)));
                continue;
            }
            if files.iter().map(|b| b.size as usize).sum::<usize>() > MAX_BYTES {
                skipped.push(skip(format!("{} is larger than 1 MB.", skill.name)));
                continue;
            }
            let mut fetched = Vec::new();
            for file in files {
                let relative = if skill.path.is_empty() { file.path.clone() } else { file.path[skill.path.len() + 1..].to_string() };
                fetched.push((relative, blob(api, &source.repo, &file.sha).map_err(|e| explain(&e))?));
            }
            let origin = Source { kind: "github".into(), location: here, git_ref: source.git_ref.clone(), commit: Some(commit.clone()) };
            // Checked again at commit: another import may have taken the id while this one fetched.
            match self.import_as(Kind::Skill, fetched, &skill.name, origin, true) {
                Ok(item) => imported.push(item.meta.name),
                Err(reason) => skipped.push(skip(reason)),
            }
        }
        Ok(Imported { items: self.list()?, imported, skipped })
    }
}
