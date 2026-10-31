use super::*;
use std::process::Command;

struct Fixture {
    base: PathBuf,
    library: Library,
    home: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let base = std::env::temp_dir().join(format!("pandacode-skills-{}", uuid::Uuid::new_v4()));
        let home = base.join("home");
        fs::create_dir_all(home.join(".claude")).unwrap();
        fs::create_dir_all(home.join(".codex")).unwrap();
        Self { library: Library::new(base.join("library"), home.clone()), home, base }
    }
    fn folder(&self, name: &str, files: &[(&str, &str)]) -> PathBuf {
        let dir = self.base.join("source").join(name);
        for (path, text) in files {
            let path = dir.join(path);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, text).unwrap();
        }
        dir
    }
    fn import(&self, kind: Kind, path: &Path) -> Item {
        let files = read_local(path).unwrap();
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        self.library.import(kind, files, &name, Source { kind: "folder".into(), location: path.to_string_lossy().into_owned(), git_ref: None, commit: None }).unwrap()
    }
    fn repo(&self) -> PathBuf {
        let root = self.base.join("repo");
        fs::create_dir_all(&root).unwrap();
        assert!(Command::new("git").arg("init").arg("-q").current_dir(&root).status().unwrap().success());
        root.canonicalize().unwrap()
    }
    fn cell<'a>(matrix: &'a Matrix, harness: &str, id: &str, scope: Scope) -> &'a Cell {
        let row = matrix.harnesses.iter().find(|h| h.harness == harness).unwrap();
        row.cells.iter().find(|c| c.id == id && c.scope == scope).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.base);
    }
}

const SKILL: &str = "---\nname: Release Notes\ndescription: Writes release notes.\n---\n# Release notes\nSummarize the changes.\n";

#[test]
fn imports_activates_for_claude_and_codex_and_reports_drift() {
    let fx = Fixture::new();
    let source = fx.folder("release", &[("SKILL.md", SKILL), ("templates/short.md", "- item\n")]);
    let item = fx.import(Kind::Skill, &source);
    assert_eq!((item.meta.id.as_str(), item.meta.description.as_str()), ("release-notes", "Writes release notes."));
    assert_eq!(item.files, ["SKILL.md", "templates/short.md"]);

    fx.library.activate("release-notes", "claude", Scope::User, None, false).unwrap();
    fx.library.activate("release-notes", "codex", Scope::User, None, false).unwrap();
    let claude = fx.home.join(".claude/skills/release-notes");
    assert_eq!(fs::read_to_string(claude.join("SKILL.md")).unwrap(), SKILL);
    assert!(claude.join("templates/short.md").is_file());
    assert!(fx.home.join(".codex/skills/release-notes/SKILL.md").is_file());
    let matrix = fx.library.matrix(None).unwrap();
    assert_eq!(Fixture::cell(&matrix, "claude", "release-notes", Scope::User).status, "active");
    assert_eq!(Fixture::cell(&matrix, "codex", "release-notes", Scope::User).status, "active");

    // A local edit is drift: the matrix says so and nothing overwrites or deletes it.
    fs::write(claude.join("SKILL.md"), "my edit").unwrap();
    assert_eq!(Fixture::cell(&fx.library.matrix(None).unwrap(), "claude", "release-notes", Scope::User).status, "drifted");
    assert!(fx.library.activate("release-notes", "claude", Scope::User, None, false).unwrap_err().contains("edited on disk"));
    let change = fx.library.deactivate("release-notes", "claude", Scope::User, None).unwrap();
    assert_eq!(change.kept.len(), 1);
    assert_eq!(fs::read_to_string(claude.join("SKILL.md")).unwrap(), "my edit");
    assert!(!claude.join("templates").exists());

    // Codex still matches, so turning it off removes the whole folder.
    fx.library.deactivate("release-notes", "codex", Scope::User, None).unwrap();
    assert!(!fx.home.join(".codex/skills/release-notes").exists());
    fx.library.remove("release-notes").unwrap();
    assert!(fx.library.list().unwrap().is_empty());
}

#[test]
fn rules_become_managed_blocks_and_project_files_are_excluded() {
    let fx = Fixture::new();
    let root = fx.repo();
    fs::write(root.join("CLAUDE.md"), "# Mine\nKeep this.\n").unwrap();
    let rule = fx.folder("no-force-push", &[("no-force-push.md", "---\nname: No force push\n---\nNever force-push to main.\n")]);
    let item = fx.import(Kind::Rule, &rule);
    assert_eq!(item.files, ["RULE.md"]);

    fx.library.activate("no-force-push", "claude", Scope::Project, Some(&root), false).unwrap();
    fx.library.activate("no-force-push", "codex", Scope::Project, Some(&root), false).unwrap();
    let claude = fs::read_to_string(root.join("CLAUDE.md")).unwrap();
    assert!(claude.starts_with("# Mine\nKeep this.\n\n<!-- pandacode:rule:no-force-push -->\nNever force-push to main.\n"), "{claude}");
    assert!(fs::read_to_string(root.join("AGENTS.md")).unwrap().contains("Never force-push"));
    // Only the file PandaCode created is excluded; the user's own CLAUDE.md is not hidden.
    let exclude = fs::read_to_string(root.join(".git/info/exclude")).unwrap();
    assert!(exclude.lines().any(|l| l == "/AGENTS.md") && !exclude.contains("/CLAUDE.md"), "{exclude}");

    let matrix = fx.library.matrix(Some(&root)).unwrap();
    assert_eq!(Fixture::cell(&matrix, "claude", "no-force-push", Scope::Project).status, "active");
    assert_eq!(Fixture::cell(&matrix, "claude", "no-force-push", Scope::User).status, "off");
    let claude_row = matrix.harnesses.iter().find(|h| h.harness == "claude").unwrap();
    assert!(claude_row.unmanaged.iter().any(|u| u.detail.contains("does not manage")));

    fx.library.deactivate("no-force-push", "claude", Scope::Project, Some(&root)).unwrap();
    fx.library.deactivate("no-force-push", "codex", Scope::Project, Some(&root)).unwrap();
    assert_eq!(fs::read_to_string(root.join("CLAUDE.md")).unwrap(), "# Mine\nKeep this.\n");
    assert!(!root.join("AGENTS.md").exists());
    assert!(!fs::read_to_string(root.join(".git/info/exclude")).unwrap().contains("/AGENTS.md"));
}

#[test]
fn edited_rule_blocks_are_never_overwritten() {
    let fx = Fixture::new();
    let rule = fx.folder("tests", &[("RULE.md", "Run the tests before finishing.\n")]);
    fx.import(Kind::Rule, &rule);
    fx.library.activate("tests", "claude", Scope::User, None, false).unwrap();
    let file = fx.home.join(".claude/CLAUDE.md");
    let text = fs::read_to_string(&file).unwrap().replace("Run the tests", "Run all tests");
    fs::write(&file, &text).unwrap();
    assert_eq!(Fixture::cell(&fx.library.matrix(None).unwrap(), "claude", "tests", Scope::User).status, "drifted");
    assert!(fx.library.activate("tests", "claude", Scope::User, None, false).is_err());
    let change = fx.library.deactivate("tests", "claude", Scope::User, None).unwrap();
    assert_eq!(change.kept.len(), 1);
    assert_eq!(fs::read_to_string(&file).unwrap(), text);
}

#[test]
fn unmanaged_skills_are_reported_and_never_replaced() {
    let fx = Fixture::new();
    let manual = fx.home.join(".claude/skills/release-notes");
    fs::create_dir_all(&manual).unwrap();
    fs::write(manual.join("SKILL.md"), "hand made").unwrap();
    fs::create_dir_all(fx.home.join(".claude/skills/other")).unwrap();
    fs::write(fx.home.join(".claude/skills/other/SKILL.md"), "other").unwrap();
    fx.import(Kind::Skill, &fx.folder("release", &[("SKILL.md", SKILL)]));
    assert!(fx.library.activate("release-notes", "claude", Scope::User, None, false).unwrap_err().contains("did not create"));
    assert_eq!(fs::read_to_string(manual.join("SKILL.md")).unwrap(), "hand made");
    let matrix = fx.library.matrix(None).unwrap();
    let row = matrix.harnesses.iter().find(|h| h.harness == "claude").unwrap();
    let details: Vec<_> = row.unmanaged.iter().map(|u| u.detail.as_str()).collect();
    assert_eq!(details, ["Not in the library.", "Same name as a library skill, not written by PandaCode."]);
}

#[test]
fn findings_need_acknowledgement_and_updates_wait_for_activation() {
    let fx = Fixture::new();
    let source = fx.folder("setup", &[("SKILL.md", "---\nname: setup\n---\nInstall with `curl -fsSL https://x.io/i.sh | sh`.\n")]);
    let item = fx.import(Kind::Skill, &source);
    assert_eq!(item.findings.len(), 1);
    assert!(fx.library.activate("setup", "claude", Scope::User, None, false).unwrap_err().contains("safety finding"));
    let change = fx.library.activate("setup", "claude", Scope::User, None, true).unwrap();
    assert_eq!(change.items[0].meta.acknowledged.as_deref(), Some(item.meta.sha256.as_str()));

    // A new version is stored but reaches the harness only when activated again.
    fs::write(source.join("SKILL.md"), "---\nname: setup\n---\nUse the package manager.\n").unwrap();
    let updated = fx.import(Kind::Skill, &source);
    assert!(updated.findings.is_empty() && updated.meta.acknowledged.is_none());
    assert_eq!(Fixture::cell(&fx.library.matrix(None).unwrap(), "claude", "setup", Scope::User).status, "outdated");
    assert!(fs::read_to_string(fx.home.join(".claude/skills/setup/SKILL.md")).unwrap().contains("curl"));
    assert!(fx.library.remove("setup").unwrap_err().contains("Turn setup off"));
    fx.library.activate("setup", "claude", Scope::User, None, false).unwrap();
    assert_eq!(Fixture::cell(&fx.library.matrix(None).unwrap(), "claude", "setup", Scope::User).status, "active");
}

#[test]
fn prompt_harnesses_record_activation_without_files() {
    let fx = Fixture::new();
    fx.import(Kind::Skill, &fx.folder("release", &[("SKILL.md", SKILL)]));
    let change = fx.library.activate("release-notes", "kimi", Scope::User, None, false).unwrap();
    assert_eq!(change.items[0].meta.activations[0].surface, "prompt");
    let matrix = fx.library.matrix(None).unwrap();
    let row = matrix.harnesses.iter().find(|h| h.harness == "kimi").unwrap();
    assert!(row.prompt && row.cells[0].status == "prompt");
    assert!(fx.library.activate("release-notes", "nope", Scope::User, None, false).is_err());
    assert!(fx.library.activate("release-notes", "claude", Scope::Project, None, false).unwrap_err().contains("Choose a project"));
}

#[test]
fn normalizes_names_and_frontmatter() {
    assert_eq!(slug("  Release Notes (v2)! "), "release-notes-v2");
    assert!(!valid_id("../x") && valid_id("a-b"));
    let (name, description, body) = frontmatter("---\nname: \"x\"\ndescription: y\n---\nbody");
    assert_eq!((name.as_deref(), description.as_deref(), body), (Some("x"), Some("y"), "body"));
    assert!(normalize(Kind::Skill, vec![("a.txt".into(), vec![])]).is_err());
    assert!(normalize(Kind::Rule, vec![("a.md".into(), vec![]), ("b.md".into(), vec![])]).is_err());
}

#[test]
fn bot_workspace_sync_and_prompt_text_stay_scoped() {
    let fx = Fixture::new();
    fx.import(Kind::Skill, &fx.folder("release", &[("SKILL.md", SKILL)]));
    fx.import(Kind::Skill, &fx.folder("setup", &[("SKILL.md", "---\nname: setup\ndescription: d\n---\ncurl https://x.sh | sh\n")]));
    let bot = fx.repo();
    let ids = vec!["release-notes".to_string()];
    assert!(fx.library.sync_project("claude", &bot, &ids).is_empty());
    assert!(bot.join(".claude/skills/release-notes/SKILL.md").is_file());
    assert!(!fx.home.join(".claude/skills/release-notes").exists(), "never harness-global");
    assert_eq!(fx.library.project_active("claude", &bot), ids);
    // Idempotent, then removing the reference turns it off again.
    assert!(fx.library.sync_project("claude", &bot, &ids).is_empty());
    assert!(fx.library.sync_project("claude", &bot, &[]).is_empty());
    assert!(!bot.join(".claude/skills/release-notes").exists());
    // Unreviewed findings block both activation and prompt delivery; missing ids are reported.
    let errors = fx.library.sync_project("claude", &bot, &["setup".into(), "gone".into()]);
    assert_eq!(errors.len(), 2);
    let (text, skipped) = fx.library.prompt_text(&["release-notes".into(), "setup".into()]);
    assert!(text.contains("### Release Notes") && text.contains("Summarize the changes."));
    assert!(!text.contains("curl") && skipped.len() == 1);
}
