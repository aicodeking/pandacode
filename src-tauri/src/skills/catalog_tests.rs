//! Repository catalogs and discovery against recorded-shape GitHub fixtures (no network).
use super::catalog::{self, State};
use super::*;
use base64::Engine;
use serde_json::{json, Value};
use std::{cell::RefCell, collections::HashMap};

/// GitHub REST responses by endpoint, plus failures, and a log of what was called.
#[derive(Default)]
struct Fake {
    responses: HashMap<String, Value>,
    failures: HashMap<String, String>,
    calls: RefCell<Vec<String>>,
}
impl Fake {
    fn call(&self, endpoint: &str) -> Result<Value, String> {
        self.calls.borrow_mut().push(endpoint.to_string());
        if let Some(error) = self.failures.get(endpoint) {
            return Err(error.clone());
        }
        self.responses.get(endpoint).cloned().ok_or_else(|| format!("gh: Not Found (HTTP 404) {endpoint}"))
    }
    /// A repository at `commit` holding `files` (path, text).
    fn repo(&mut self, repo: &str, commit: &str, files: &[(String, String)]) {
        self.responses.insert(format!("repos/{repo}/commits/HEAD"), json!({ "sha": commit }));
        self.responses.insert(format!("repos/{repo}/commits/{commit}"), json!({ "sha": commit }));
        let mut tree = Vec::new();
        for (index, (path, text)) in files.iter().enumerate() {
            let sha = format!("{commit}-{index}");
            tree.push(json!({ "path": path, "type": "blob", "sha": sha, "size": text.len() }));
            let content = base64::engine::general_purpose::STANDARD.encode(text);
            self.responses.insert(format!("repos/{repo}/git/blobs/{sha}"), json!({ "content": content, "encoding": "base64" }));
        }
        self.responses.insert(format!("repos/{repo}/git/trees/{commit}?recursive=1"), json!({ "sha": commit, "tree": tree, "truncated": false }));
    }
    fn page(&mut self, page: usize, repos: Value) {
        self.responses.insert(format!("user/repos?affiliation=owner&per_page=100&page={page}&sort=full_name"), repos);
    }
    fn api(&self) -> impl Fn(&str) -> Result<Value, String> + '_ {
        |endpoint| self.call(endpoint)
    }
    fn count(&self, prefix: &str) -> usize {
        self.calls.borrow().iter().filter(|c| c.starts_with(prefix)).count()
    }
}

struct Fixture {
    base: PathBuf,
    library: Library,
}
impl Fixture {
    fn new() -> Self {
        let base = std::env::temp_dir().join(format!("pandacode-catalog-{}", uuid::Uuid::new_v4()));
        let home = base.join("home");
        fs::create_dir_all(home.join(".claude")).unwrap();
        fs::create_dir_all(home.join(".codex")).unwrap();
        Self { library: Library::new(base.join("library"), home), base }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.base);
    }
}

fn skill(name: &str) -> String {
    format!("---\nname: {name}\ndescription: Does {name}.\n---\n# {name}\n")
}
fn files(list: &[(&str, &str)]) -> Vec<(String, String)> {
    list.iter().map(|(p, t)| (p.to_string(), t.to_string())).collect()
}
/// A pstack-like collection: 30 skills of 4 files each (120 files, far past 64 in total).
fn pstack() -> Vec<(String, String)> {
    (0..30).flat_map(|i| {
        let dir = format!("skills/skill-{i:02}");
        [(format!("{dir}/SKILL.md"), skill(&format!("skill-{i:02}"))), (format!("{dir}/scripts/run.sh"), "echo hi\n".into()), (format!("{dir}/reference.md"), "ref\n".into()), (format!("{dir}/templates/a.md"), "a\n".into())]
    }).collect()
}

#[test]
fn detects_root_collections_and_nested_skills_by_frontmatter() {
    let mut fake = Fake::default();
    fake.repo("me/kit", "c1", &files(&[
        ("SKILL.md", &skill("Kit")),
        ("helper.md", "root helper"),
        ("skills/pdf/SKILL.md", &skill("PDF")),
        ("skills/pdf/forms.md", "forms"),
        ("collections/writing/skills/blog/SKILL.md", "---\nname: Blog\ndescription: >-\n  Writes blog\n  posts.\n---\nbody"),
        ("skills/broken/SKILL.md", "---\nname: Broken\n---\nno description"),
        ("skills/plain/SKILL.md", "# no frontmatter"),
        (".github/skills/hidden/SKILL.md", &skill("Hidden")),
        ("README.md", "skills!"),
    ]));
    let (commit, skills) = catalog::scan(&fake.api(), "me/kit", None).unwrap();
    assert_eq!(commit, "c1");
    let found: Vec<(&str, &str, usize)> = skills.iter().map(|s| (s.path.as_str(), s.name.as_str(), s.files)).collect();
    // The root skill keeps its own files, never a nested skill's.
    assert_eq!(found, vec![("", "Kit", 3), ("collections/writing/skills/blog", "Blog", 1), ("skills/pdf", "PDF", 2)]);
    assert_eq!(skills[1].description, "Writes blog posts.");
}

#[test]
fn collections_past_64_files_import_per_skill_with_provenance_and_no_activation() {
    let fx = Fixture::new();
    let mut fake = Fake::default();
    fake.repo("acme/pstack", "abc123", &pstack());
    let catalogs = fx.library.add_catalog(&fake.api(), "acme/pstack", None).unwrap();
    assert_eq!(catalogs.sources[0].skills.len(), 30);
    let chosen = vec!["skills/skill-03".to_string()];
    let one = fx.library.import_catalog(&fake.api(), "acme/pstack", Some(&chosen)).unwrap();
    assert_eq!(one.imported, vec!["skill-03"]);
    assert_eq!(one.items.len(), 1);
    let all = fx.library.import_catalog(&fake.api(), "acme/pstack", None).unwrap();
    assert_eq!((all.imported.len(), all.skipped.len(), all.items.len()), (30, 0, 30));
    let item = all.items.iter().find(|i| i.meta.id == "skill-07").unwrap();
    assert_eq!(item.files, vec!["SKILL.md", "reference.md", "scripts/run.sh", "templates/a.md"]);
    assert_eq!(item.meta.source.location, "acme/pstack/skills/skill-07");
    assert_eq!(item.meta.source.commit.as_deref(), Some("abc123"));
    // Importing is not activation: nothing written for any harness.
    assert!(all.items.iter().all(|i| i.meta.activations.is_empty()));
    assert!(fs::read_dir(fx.base.join("home/.claude")).unwrap().next().is_none());
    let annotated = fx.library.catalogs().unwrap();
    assert!(annotated.sources[0].skills.iter().all(|s| s.imported.as_deref() == Some("abc123") && s.conflicts.is_empty()));
}

#[test]
fn per_skill_and_per_catalog_limits_have_clear_errors() {
    let fx = Fixture::new();
    let mut fake = Fake::default();
    let mut big: Vec<(String, String)> = vec![("SKILL.md".into(), skill("Big"))];
    big.extend((0..64).map(|i| (format!("extra/{i}.md"), "x".to_string())));
    fake.repo("me/big", "b1", &big);
    fx.library.add_catalog(&fake.api(), "me/big", None).unwrap();
    let result = fx.library.import_catalog(&fake.api(), "me/big", None).unwrap();
    assert!(result.skipped[0].reason.contains("more than 64 files"), "{:?}", result.skipped);

    let many: Vec<(String, String)> = (0..=catalog::MAX_SKILLS).map(|i| (format!("s/{i}/SKILL.md"), skill(&format!("s{i}")))).collect();
    fake.repo("me/many", "m1", &many);
    assert!(fx.library.add_catalog(&fake.api(), "me/many", None).unwrap_err().contains("more than 300 SKILL.md"));
    fake.responses.insert("repos/me/huge/commits/HEAD".into(), json!({ "sha": "h1" }));
    fake.responses.insert("repos/me/huge/git/trees/h1?recursive=1".into(), json!({ "tree": [], "truncated": true }));
    assert!(fx.library.add_catalog(&fake.api(), "me/huge", None).unwrap_err().contains("too large"));
    fake.repo("me/notes", "n1", &files(&[("README.md", "skills")]));
    assert!(fx.library.add_catalog(&fake.api(), "me/notes", None).unwrap_err().contains("no SKILL.md"));
}

#[test]
fn same_name_skills_from_different_sources_are_shown_and_never_overwritten() {
    let fx = Fixture::new();
    let mut fake = Fake::default();
    fake.repo("me/one", "o1", &files(&[("skills/pdf/SKILL.md", &skill("PDF")), ("skills/pdf/a.md", "mine")]));
    fake.repo("you/two", "t1", &files(&[("pdf/SKILL.md", &skill("PDF")), ("pdf/b.md", "theirs")]));
    fx.library.add_catalog(&fake.api(), "me/one", None).unwrap();
    let catalogs = fx.library.add_catalog(&fake.api(), "you/two", None).unwrap();
    let conflicts = |repo: &str| catalogs.sources.iter().find(|s| s.repo == repo).unwrap().skills[0].conflicts.clone();
    assert_eq!(conflicts("me/one"), vec!["you/two/pdf"]);
    assert_eq!(conflicts("you/two"), vec!["me/one/skills/pdf"]);

    fx.library.import_catalog(&fake.api(), "me/one", None).unwrap();
    let second = fx.library.import_catalog(&fake.api(), "you/two", None).unwrap();
    assert!(second.imported.is_empty());
    assert!(second.skipped[0].reason.contains("already in the library from me/one/skills/pdf"));
    let pdf = second.items.iter().find(|i| i.meta.id == "pdf").unwrap();
    assert_eq!(pdf.meta.source.location, "me/one/skills/pdf");
    assert!(pdf.files.contains(&"a.md".to_string()));
}

#[test]
fn an_import_that_lands_while_another_fetches_is_never_overwritten() {
    let fx = Fixture::new();
    let mut fake = Fake::default();
    fake.repo("you/two", "t1", &files(&[("pdf/SKILL.md", &skill("PDF")), ("pdf/b.md", "theirs")]));
    fx.library.add_catalog(&fake.api(), "you/two", None).unwrap();
    // The id is free when the import checks; another source takes it during the fetch.
    let raced = std::cell::Cell::new(false);
    let api = |endpoint: &str| {
        if endpoint.contains("/git/blobs/") && !raced.replace(true) {
            let mine = vec![("SKILL.md".to_string(), skill("PDF").into_bytes()), ("a.md".to_string(), b"mine".to_vec())];
            fx.library.import(Kind::Skill, mine, "pdf", Source { kind: "folder".into(), location: "/me/pdf".into(), git_ref: None, commit: None }).unwrap();
        }
        fake.call(endpoint)
    };
    let result = fx.library.import_catalog(&api, "you/two", None).unwrap();
    assert!(raced.get());
    assert!(result.imported.is_empty());
    assert!(result.skipped[0].reason.contains("already in the library from /me/pdf"), "{:?}", result.skipped);
    let pdf = result.items.iter().find(|i| i.meta.id == "pdf").unwrap();
    assert_eq!(pdf.meta.source.location, "/me/pdf");
    assert!(pdf.files.contains(&"a.md".to_string()));
}

#[test]
fn refresh_records_upstream_changes_without_touching_the_library() {
    let fx = Fixture::new();
    let mut fake = Fake::default();
    fake.repo("me/kit", "v1", &files(&[("SKILL.md", &skill("Kit"))]));
    fx.library.add_catalog(&fake.api(), "me/kit", None).unwrap();
    fx.library.import_catalog(&fake.api(), "me/kit", None).unwrap();
    fake.repo("me/kit", "v2", &files(&[("SKILL.md", &skill("Kit")), ("new.md", "new")]));
    let catalogs = fx.library.refresh_catalog(&fake.api(), "me/kit").unwrap();
    assert_eq!(catalogs.sources[0].commit.as_deref(), Some("v2"));
    assert_eq!(catalogs.sources[0].skills[0].imported.as_deref(), Some("v1"));
    assert_eq!(fx.library.list().unwrap()[0].files, vec!["SKILL.md"]);
}

fn repos(names: &[(&str, &str)]) -> Value {
    Value::Array(names.iter().map(|(name, pushed)| json!({ "full_name": name, "pushed_at": pushed, "private": name.contains("private"), "size": 10 })).collect())
}

#[test]
fn discovery_pages_registers_only_skill_repos_and_is_idempotent() {
    let fx = Fixture::new();
    let mut fake = Fake::default();
    let mut first: Vec<(String, String)> = (0..99).map(|i| (format!("me/app-{i:02}"), "t1".to_string())).collect();
    first.push(("me/private-skills".into(), "t1".into()));
    let first: Vec<(&str, &str)> = first.iter().map(|(a, b)| (a.as_str(), b.as_str())).collect();
    fake.page(1, repos(&first));
    fake.page(2, repos(&[("me/skills-named-but-empty", "t1"), ("me/tools", "t1")]));
    for i in 0..99 {
        fake.repo(&format!("me/app-{i:02}"), &format!("a{i}"), &files(&[("README.md", "app")]));
    }
    fake.repo("me/private-skills", "p1", &files(&[("skills/a/SKILL.md", &skill("A")), ("skills/b/SKILL.md", &skill("B"))]));
    fake.repo("me/skills-named-but-empty", "e1", &files(&[("skills/README.md", "soon")]));
    fake.repo("me/tools", "w1", &files(&[("SKILL.md", &skill("Tools"))]));

    let catalogs = fx.library.discover(&fake.api()).unwrap();
    let repos_found: Vec<&str> = catalogs.sources.iter().map(|s| s.repo.as_str()).collect();
    assert_eq!(repos_found, vec!["me/private-skills", "me/tools"]);
    assert!(catalogs.sources.iter().all(|s| s.origin == "discovered" && s.state == State::Enabled));
    assert!(catalogs.sources[0].private);
    let report = catalogs.discovery.unwrap();
    assert_eq!((report.checked, report.registered.len()), (102, 2));
    assert_eq!(fake.count("user/repos"), 2);
    // Discovery never imports or activates.
    assert!(fx.library.list().unwrap().is_empty());

    let trees = fake.count("repos/");
    let again = fx.library.discover(&fake.api()).unwrap();
    assert_eq!(again.sources.len(), 2);
    assert!(again.discovery.unwrap().registered.is_empty());
    assert_eq!(fake.count("repos/"), trees, "unchanged repositories are not read again");
}

#[test]
fn ignored_and_disabled_sources_stay_that_way() {
    let fx = Fixture::new();
    let mut fake = Fake::default();
    fake.page(1, repos(&[("me/kit", "t1"), ("me/more", "t1")]));
    fake.repo("me/kit", "k1", &files(&[("SKILL.md", &skill("Kit"))]));
    fake.repo("me/more", "m1", &files(&[("SKILL.md", &skill("More"))]));
    fx.library.discover(&fake.api()).unwrap();
    fx.library.set_catalog_state("me/kit", State::Ignored).unwrap();
    fx.library.set_catalog_state("me/more", State::Disabled).unwrap();
    fake.page(1, repos(&[("me/kit", "t2"), ("me/more", "t2")]));
    let catalogs = fx.library.discover(&fake.api()).unwrap();
    let state = |repo: &str| catalogs.sources.iter().find(|s| s.repo == repo).unwrap().state;
    assert_eq!((state("me/kit"), state("me/more")), (State::Ignored, State::Disabled));
    assert!(fx.library.import_catalog(&fake.api(), "me/kit", None).unwrap_err().contains("ignored"));
    assert!(fx.library.import_catalog(&fake.api(), "me/more", None).unwrap_err().contains("disabled"));
    assert!(fx.library.refresh_catalog(&fake.api(), "me/kit").unwrap_err().contains("ignored"));
}

#[test]
fn access_failures_are_explained_and_progress_is_kept() {
    let fx = Fixture::new();
    let mut fake = Fake::default();
    fake.failures.insert("user/repos?affiliation=owner&per_page=100&page=1&sort=full_name".into(), "gh: To get started with GitHub CLI, please run:  gh auth login".into());
    assert!(fx.library.discover(&fake.api()).unwrap_err().contains("not signed in"));

    fake.failures.clear();
    fake.page(1, repos(&[("me/a-kit", "t1"), ("me/b-locked", "t1"), ("me/c-later", "t1")]));
    fake.repo("me/a-kit", "k1", &files(&[("SKILL.md", &skill("Kit"))]));
    fake.failures.insert("repos/me/b-locked/commits/HEAD".into(), "gh: Repository access blocked (HTTP 451)".into());
    fake.failures.insert("repos/me/c-later/commits/HEAD".into(), "gh: API rate limit exceeded for user ID 1. (HTTP 403)".into());
    let error = fx.library.discover(&fake.api()).unwrap_err();
    assert!(error.contains("rate limit"), "{error}");
    let saved = fx.library.catalogs().unwrap();
    assert_eq!(saved.sources.len(), 1, "sources found before the rate limit are kept");
    assert!(saved.discovery.unwrap().failures[0].starts_with("me/b-locked: "));
    assert!(fx.library.add_catalog(&fake.api(), "me/missing", None).unwrap_err().contains("not found, or your GitHub login cannot read it"));
}
