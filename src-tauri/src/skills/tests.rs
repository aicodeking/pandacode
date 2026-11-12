use super::*;
use std::process::Command;
#[cfg_attr(not(unix), allow(unused_imports))] // only Unix link tests use it
use super::adapter::Links;

thread_local!(pub(super) static FAIL_SAVE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) });

/// Runs `f` with every library save on this thread failing.
fn failing_saves<T>(f: impl FnOnce() -> T) -> T {
    FAIL_SAVE.with(|fail| fail.set(true));
    let out = f();
    FAIL_SAVE.with(|fail| fail.set(false));
    out
}

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
fn codex_project_skills_go_where_codex_reads_them() {
    let fx = Fixture::new();
    let root = fx.repo();
    fx.import(Kind::Skill, &fx.folder("release", &[("SKILL.md", SKILL)]));
    fx.library.activate("release-notes", "codex", Scope::Project, Some(&root), false).unwrap();
    assert!(root.join(".agents/skills/release-notes/SKILL.md").is_file());
    assert!(!root.join(".codex/skills").exists());
    fx.library.deactivate("release-notes", "codex", Scope::Project, Some(&root)).unwrap();
    assert!(!root.join(".agents/skills/release-notes").exists());
}

/// Rewrites a Codex project activation as the old adapter recorded it, in `.codex/skills`.
fn plant_old_codex_activation(fx: &Fixture, root: &Path, id: &str) -> PathBuf {
    let old = root.join(".codex/skills").join(id);
    fs::create_dir_all(&old).unwrap();
    let new = root.join(".agents/skills").join(id);
    fs::rename(new.join("SKILL.md"), old.join("SKILL.md")).unwrap();
    fs::remove_dir_all(&new).unwrap();
    let entry = format!("/.codex/skills/{id}/");
    fs::write(root.join(".git/info/exclude"), format!("{entry}\n")).unwrap();
    let meta = fx.library.load(id).unwrap();
    let activations = meta.activations.iter().cloned().map(|a| Activation {
        files: vec![Written { path: old.join("SKILL.md").to_string_lossy().into_owned(), sha256: a.files[0].sha256.clone() }],
        excluded: vec![entry.clone()],
        ..a
    }).collect();
    fx.library.save(&Meta { activations, ..meta }).unwrap();
    old
}

#[test]
fn old_codex_project_activations_read_outdated_and_sync_moves_them() {
    let fx = Fixture::new();
    let root = fx.repo();
    fx.import(Kind::Skill, &fx.folder("release", &[("SKILL.md", SKILL)]));
    let ids = vec!["release-notes".to_string()];
    assert!(fx.library.sync_project("codex", &root, &ids).is_empty());
    let old = plant_old_codex_activation(&fx, &root, "release-notes");

    let matrix = fx.library.matrix(Some(&root)).unwrap();
    assert_eq!(Fixture::cell(&matrix, "codex", "release-notes", Scope::Project).status, "outdated");
    assert!(fx.library.project_active("codex", &root).is_empty(), "Codex cannot read the old folder");

    assert!(fx.library.sync_project("codex", &root, &ids).is_empty());
    assert!(root.join(".agents/skills/release-notes/SKILL.md").is_file());
    assert!(!old.exists());
    let exclude = fs::read_to_string(root.join(".git/info/exclude")).unwrap();
    assert!(exclude.lines().any(|l| l == "/.agents/skills/release-notes/") && !exclude.contains(".codex"), "{exclude}");
    let matrix = fx.library.matrix(Some(&root)).unwrap();
    assert_eq!(Fixture::cell(&matrix, "codex", "release-notes", Scope::Project).status, "active");
    assert_eq!(fx.library.project_active("codex", &root), ids);
}

#[test]
fn moving_a_codex_activation_keeps_user_files() {
    let fx = Fixture::new();
    let root = fx.repo();
    fx.import(Kind::Skill, &fx.folder("release", &[("SKILL.md", SKILL)]));
    let ids = vec!["release-notes".to_string()];
    fx.library.sync_project("codex", &root, &ids);
    let old = plant_old_codex_activation(&fx, &root, "release-notes");

    // A folder the user made at the new location is refused, and the old copy stays recorded.
    let manual = root.join(".agents/skills/release-notes");
    fs::create_dir_all(&manual).unwrap();
    fs::write(manual.join("SKILL.md"), "hand made").unwrap();
    let exclude_before = fs::read_to_string(root.join(".git/info/exclude")).unwrap();
    assert!(fx.library.sync_project("codex", &root, &ids)[0].contains("did not create"));
    assert_eq!(fs::read_to_string(root.join(".git/info/exclude")).unwrap(), exclude_before, "the user's folder is not hidden");
    assert_eq!(fs::read_to_string(manual.join("SKILL.md")).unwrap(), "hand made");
    assert!(old.join("SKILL.md").is_file());
    assert!(fx.library.project_active("codex", &root).is_empty());
    fs::remove_dir_all(&manual).unwrap();

    // An edited old copy moves too: the edit is left where it was and reported.
    fs::write(old.join("SKILL.md"), "my edit").unwrap();
    let change = fx.library.activate("release-notes", "codex", Scope::Project, Some(&root), false).unwrap();
    assert_eq!(change.kept, [old.join("SKILL.md").to_string_lossy().into_owned()]);
    assert_eq!(fs::read_to_string(old.join("SKILL.md")).unwrap(), "my edit");
    assert_eq!(fs::read_to_string(manual.join("SKILL.md")).unwrap(), SKILL);
    assert!(!fs::read_to_string(root.join(".git/info/exclude")).unwrap().contains("/.codex/skills/release-notes/"), "the unmanaged leftover shows in Git");
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

/// Round 24: a project's `CLAUDE.md` linked to `/dev/zero` or an `AGENTS.md` FIFO is never read
/// in full or waited on: the matrix calls it content PandaCode does not manage, activation is
/// refused, and an activation's status reads missing.
#[cfg(unix)]
#[test]
fn special_rule_files_are_never_read_in_full() {
    let fx = Fixture::new();
    let root = fx.repo();
    let rule = fx.folder("tests", &[("RULE.md", "Run the tests before finishing.\n")]);
    fx.import(Kind::Rule, &rule);
    fx.library.activate("tests", "claude", Scope::Project, Some(&root), false).unwrap();
    fs::remove_file(root.join("CLAUDE.md")).unwrap();
    std::os::unix::fs::symlink("/dev/zero", root.join("CLAUDE.md")).unwrap();
    let fifo = std::ffi::CString::new(root.join("AGENTS.md").to_string_lossy().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);

    let started = std::time::Instant::now();
    let matrix = fx.library.matrix(Some(&root)).unwrap();
    assert_eq!(Fixture::cell(&matrix, "claude", "tests", Scope::Project).status, "missing");
    for harness in ["claude", "codex"] {
        let row = matrix.harnesses.iter().find(|h| h.harness == harness).unwrap();
        assert!(row.unmanaged.iter().any(|u| u.scope == Scope::Project && u.detail == "Has instructions PandaCode does not manage."), "{harness}");
    }
    let refused = fx.library.activate("tests", "codex", Scope::Project, Some(&root), false).unwrap_err();
    assert!(refused.contains("not a text file"), "{refused}");
    assert!(started.elapsed() < std::time::Duration::from_secs(5), "nothing blocks");
    assert!(adapter::file_hash(&root.join("CLAUDE.md")).is_none() && adapter::file_hash(&root.join("AGENTS.md")).is_none());

    // A symlink to a regular rule file (AGENTS.md -> CLAUDE.md) still works as before.
    fs::remove_file(root.join("CLAUDE.md")).unwrap();
    fs::remove_file(root.join("AGENTS.md")).unwrap();
    fs::write(root.join("CLAUDE.md"), "# Mine\n").unwrap();
    std::os::unix::fs::symlink("CLAUDE.md", root.join("AGENTS.md")).unwrap();
    fx.library.activate("tests", "codex", Scope::Project, Some(&root), false).unwrap();
    assert!(fs::read_to_string(root.join("CLAUDE.md")).unwrap().contains("Run the tests"));
    assert_eq!(Fixture::cell(&fx.library.matrix(Some(&root)).unwrap(), "codex", "tests", Scope::Project).status, "active");
}

/// A project's `CLAUDE.md` (or skills folder) linked to a file outside the project is never
/// written through: activation is refused and the outside file keeps its bytes.
#[cfg(unix)]
#[test]
fn project_links_to_outside_files_are_never_written() {
    let fx = Fixture::new();
    let root = fx.repo();
    let outside = fx.base.join("outside.md");
    fs::write(&outside, "# Elsewhere\n").unwrap();
    std::os::unix::fs::symlink(&outside, root.join("CLAUDE.md")).unwrap();
    let rule = fx.folder("tests", &[("RULE.md", "Run the tests before finishing.\n")]);
    fx.import(Kind::Rule, &rule);
    let refused = fx.library.activate("tests", "claude", Scope::Project, Some(&root), false).unwrap_err();
    assert!(refused.contains("is a link; PandaCode does not write through links."), "{refused}");
    assert_eq!(fs::read_to_string(&outside).unwrap(), "# Elsewhere\n");

    let skills = fx.base.join("outside-skills");
    fs::create_dir_all(&skills).unwrap();
    fs::create_dir_all(root.join(".claude")).unwrap();
    std::os::unix::fs::symlink(&skills, root.join(".claude/skills")).unwrap();
    let skill = fx.folder("release-notes", &[("SKILL.md", SKILL)]);
    fx.import(Kind::Skill, &skill);
    let refused = fx.library.activate("release-notes", "claude", Scope::Project, Some(&root), false).unwrap_err();
    assert!(refused.contains("is a link"), "{refused}");
    assert_eq!(fs::read_dir(&skills).unwrap().count(), 0);
}

/// User scope still writes through links: dotfiles setups link `~/.claude/CLAUDE.md` and
/// `~/.claude/skills` into a repository elsewhere.
#[cfg(unix)]
#[test]
fn user_scope_still_writes_through_dotfile_links() {
    let fx = Fixture::new();
    let dotfiles = fx.base.join("dotfiles");
    fs::create_dir_all(dotfiles.join("skills")).unwrap();
    fs::write(dotfiles.join("CLAUDE.md"), "# Mine\n").unwrap();
    std::os::unix::fs::symlink(dotfiles.join("CLAUDE.md"), fx.home.join(".claude/CLAUDE.md")).unwrap();
    std::os::unix::fs::symlink(dotfiles.join("skills"), fx.home.join(".claude/skills")).unwrap();
    let rule = fx.folder("tests", &[("RULE.md", "Run the tests before finishing.\n")]);
    fx.import(Kind::Rule, &rule);
    let skill = fx.folder("release-notes", &[("SKILL.md", SKILL)]);
    fx.import(Kind::Skill, &skill);

    fx.library.activate("tests", "claude", Scope::User, None, false).unwrap();
    fx.library.activate("release-notes", "claude", Scope::User, None, false).unwrap();
    assert!(fs::read_to_string(dotfiles.join("CLAUDE.md")).unwrap().contains("Run the tests"));
    assert_eq!(fs::read_to_string(dotfiles.join("skills/release-notes/SKILL.md")).unwrap(), SKILL);
    assert!(fs::symlink_metadata(fx.home.join(".claude/CLAUDE.md")).unwrap().file_type().is_symlink(), "the link stays");

    fx.library.deactivate("tests", "claude", Scope::User, None).unwrap();
    assert_eq!(fs::read_to_string(dotfiles.join("CLAUDE.md")).unwrap(), "# Mine\n");
}

/// Turning a rule off when its block is all a linked file holds empties the link's target
/// instead of deleting the link (which would leave the block in the target).
#[cfg(unix)]
#[test]
fn removing_the_last_block_through_a_link_empties_the_target() {
    let fx = Fixture::new();
    let rule = fx.folder("tests", &[("RULE.md", "Run the tests before finishing.\n")]);
    fx.import(Kind::Rule, &rule);

    let dotfiles = fx.base.join("dotfiles");
    fs::create_dir_all(&dotfiles).unwrap();
    fs::write(dotfiles.join("CLAUDE.md"), "").unwrap();
    std::os::unix::fs::symlink(dotfiles.join("CLAUDE.md"), fx.home.join(".claude/CLAUDE.md")).unwrap();
    fx.library.activate("tests", "claude", Scope::User, None, false).unwrap();
    assert!(fs::read_to_string(dotfiles.join("CLAUDE.md")).unwrap().contains("Run the tests"));
    fx.library.deactivate("tests", "claude", Scope::User, None).unwrap();
    assert!(!fs::read_to_string(dotfiles.join("CLAUDE.md")).unwrap().contains("Run the tests"));
    assert!(fs::symlink_metadata(fx.home.join(".claude/CLAUDE.md")).unwrap().file_type().is_symlink(), "the link stays");

    let root = fx.repo();
    fs::write(root.join("CLAUDE.md"), "").unwrap();
    std::os::unix::fs::symlink("CLAUDE.md", root.join("AGENTS.md")).unwrap();
    fx.library.activate("tests", "codex", Scope::Project, Some(&root), false).unwrap();
    assert!(fs::read_to_string(root.join("CLAUDE.md")).unwrap().contains("Run the tests"));
    fx.library.deactivate("tests", "codex", Scope::Project, Some(&root)).unwrap();
    assert!(!fs::read_to_string(root.join("CLAUDE.md")).unwrap().contains("Run the tests"));
    assert!(fs::symlink_metadata(root.join("AGENTS.md")).unwrap().file_type().is_symlink(), "the link stays");
}

/// A project link whose target stays inside the project (`.agents/skills -> ../.claude/skills`)
/// is written through; a linked Git exclude file leading elsewhere is never written.
#[cfg(unix)]
#[test]
fn in_project_links_are_written_through_and_linked_excludes_are_not() {
    let fx = Fixture::new();
    let root = fx.repo();
    fs::create_dir_all(root.join(".claude/skills")).unwrap();
    fs::create_dir_all(root.join(".agents")).unwrap();
    std::os::unix::fs::symlink("../.claude/skills", root.join(".agents/skills")).unwrap();
    let skill = fx.folder("release-notes", &[("SKILL.md", SKILL)]);
    fx.import(Kind::Skill, &skill);
    fx.library.activate("release-notes", "codex", Scope::Project, Some(&root), false).unwrap();
    assert_eq!(fs::read_to_string(root.join(".claude/skills/release-notes/SKILL.md")).unwrap(), SKILL);
    fx.library.deactivate("release-notes", "codex", Scope::Project, Some(&root)).unwrap();
    assert!(!root.join(".claude/skills/release-notes").exists());

    let outside = fx.base.join("outside-exclude");
    fs::write(&outside, "").unwrap();
    fs::remove_file(root.join(".git/info/exclude")).ok();
    std::os::unix::fs::symlink(&outside, root.join(".git/info/exclude")).unwrap();
    let refused = fx.library.activate("release-notes", "claude", Scope::Project, Some(&root), false).unwrap_err();
    assert!(refused.contains("is a link"), "{refused}");
    assert_eq!(fs::read_to_string(&outside).unwrap(), "");
}

/// A refused exclude update leaves nothing behind: the activation fails before any skill
/// file is written, and a retry once the exclude file is fixed succeeds.
#[cfg(unix)]
#[test]
fn a_refused_exclude_update_writes_nothing_and_a_retry_succeeds() {
    let fx = Fixture::new();
    let root = fx.repo();
    let outside = fx.base.join("outside-exclude");
    fs::write(&outside, "").unwrap();
    fs::remove_file(root.join(".git/info/exclude")).ok();
    std::os::unix::fs::symlink(&outside, root.join(".git/info/exclude")).unwrap();
    let skill = fx.folder("release-notes", &[("SKILL.md", SKILL)]);
    fx.import(Kind::Skill, &skill);
    let rule = fx.folder("tests", &[("RULE.md", "Run the tests before finishing.\n")]);
    fx.import(Kind::Rule, &rule);

    let refused = fx.library.activate("release-notes", "claude", Scope::Project, Some(&root), false).unwrap_err();
    assert!(refused.contains("is a link"), "{refused}");
    assert!(!root.join(".claude/skills/release-notes").exists(), "no skill files remain");
    let refused = fx.library.activate("tests", "codex", Scope::Project, Some(&root), false).unwrap_err();
    assert!(refused.contains("is a link"), "{refused}");
    assert!(!root.join("AGENTS.md").exists(), "no rule file remains");
    assert_eq!(fs::read_to_string(&outside).unwrap(), "");

    fs::remove_file(root.join(".git/info/exclude")).unwrap();
    fx.library.activate("release-notes", "claude", Scope::Project, Some(&root), false).unwrap();
    fx.library.activate("tests", "codex", Scope::Project, Some(&root), false).unwrap();
    assert_eq!(fs::read_to_string(root.join(".claude/skills/release-notes/SKILL.md")).unwrap(), SKILL);
    let exclude = fs::read_to_string(root.join(".git/info/exclude")).unwrap();
    assert!(exclude.contains("/.claude/skills/release-notes/") && exclude.contains("/AGENTS.md"), "{exclude}");
}

/// Turning a skill off for a project folder that was deleted reports nothing as kept.
#[test]
fn deactivating_in_a_deleted_project_keeps_nothing() {
    let fx = Fixture::new();
    let root = fx.repo();
    let skill = fx.folder("release-notes", &[("SKILL.md", SKILL)]);
    fx.import(Kind::Skill, &skill);
    fx.library.activate("release-notes", "claude", Scope::Project, Some(&root), false).unwrap();
    fs::remove_dir_all(&root).unwrap();
    let change = fx.library.deactivate("release-notes", "claude", Scope::Project, Some(&root)).unwrap();
    assert!(change.kept.is_empty(), "{:?}", change.kept);
}

/// A committed link into the Git directory (`CLAUDE.md -> .git/config`) stays inside the
/// project but is still never written through.
#[cfg(unix)]
#[test]
fn links_into_the_git_directory_are_never_written() {
    let fx = Fixture::new();
    let root = fx.repo();
    let config = fs::read_to_string(root.join(".git/config")).unwrap();
    std::os::unix::fs::symlink(".git/config", root.join("CLAUDE.md")).unwrap();
    let rule = fx.folder("tests", &[("RULE.md", "Run the tests before finishing.\n")]);
    fx.import(Kind::Rule, &rule);
    let refused = fx.library.activate("tests", "claude", Scope::Project, Some(&root), false).unwrap_err();
    assert!(refused.contains("is a link; PandaCode does not write through links."), "{refused}");
    assert_eq!(fs::read_to_string(root.join(".git/config")).unwrap(), config);
}

/// A failed exclude update on re-activation in place writes nothing: the files stay those of
/// the recorded activation, whose hashes still match disk (outdated, not drifted), and a
/// retry once the exclude file is writable again succeeds.
#[cfg(unix)]
#[test]
fn a_failed_exclude_update_on_reactivation_writes_nothing() {
    use std::os::unix::fs::PermissionsExt;
    let fx = Fixture::new();
    let root = fx.repo();
    let source = fx.folder("release-notes", &[("SKILL.md", SKILL)]);
    fx.import(Kind::Skill, &source);
    fx.library.activate("release-notes", "claude", Scope::Project, Some(&root), false).unwrap();
    let updated = format!("{SKILL}Mention breaking changes first.\n");
    fs::write(source.join("SKILL.md"), &updated).unwrap();
    fx.import(Kind::Skill, &source);
    let exclude = root.join(".git/info/exclude");
    fs::write(&exclude, "").unwrap();
    fs::set_permissions(&exclude, fs::Permissions::from_mode(0o444)).unwrap();
    let result = fx.library.activate("release-notes", "claude", Scope::Project, Some(&root), false);
    fs::set_permissions(&exclude, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(result.is_err(), "the exclude update must fail");
    let skill = root.join(".claude/skills/release-notes/SKILL.md");
    assert_eq!(fs::read_to_string(&skill).unwrap(), SKILL);
    let meta = fx.library.load("release-notes").unwrap();
    assert!(meta.activations[0].files.iter().all(|w| adapter::file_hash(Path::new(&w.path)).as_deref() == Some(w.sha256.as_str())));
    assert_eq!(Fixture::cell(&fx.library.matrix(Some(&root)).unwrap(), "claude", "release-notes", Scope::Project).status, "outdated");

    fx.library.activate("release-notes", "claude", Scope::Project, Some(&root), false).unwrap();
    assert_eq!(fs::read_to_string(&skill).unwrap(), updated);
    assert_eq!(fx.library.load("release-notes").unwrap().activations[0].excluded, ["/.claude/skills/release-notes/"]);
}

/// A failed exclude update while moving an activation writes nothing at the new place and
/// leaves the old copy and its exclude line alone.
#[cfg(unix)]
#[test]
fn a_failed_exclude_update_on_a_moved_activation_writes_nothing() {
    use std::os::unix::fs::PermissionsExt;
    let fx = Fixture::new();
    let root = fx.repo();
    fx.import(Kind::Skill, &fx.folder("release", &[("SKILL.md", SKILL)]));
    fx.library.activate("release-notes", "codex", Scope::Project, Some(&root), false).unwrap();
    let old = plant_old_codex_activation(&fx, &root, "release-notes");
    let exclude = root.join(".git/info/exclude");
    fs::set_permissions(&exclude, fs::Permissions::from_mode(0o444)).unwrap();
    let result = fx.library.activate("release-notes", "codex", Scope::Project, Some(&root), false);
    fs::set_permissions(&exclude, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(result.is_err(), "the exclude update must fail");
    assert!(!root.join(".agents/skills/release-notes").exists());
    assert_eq!(fs::read_to_string(old.join("SKILL.md")).unwrap(), SKILL);
    assert_eq!(fs::read_to_string(&exclude).unwrap(), "/.codex/skills/release-notes/\n");
}

/// The path a write opens is checked again after it is resolved, so a link swapped in after
/// the first check (to a file outside, as a parent folder, or into `.git`) is refused. With
/// no resolvable root, any link along the path is refused and plain paths still pass.
#[cfg(unix)]
#[test]
fn the_resolved_write_target_is_checked_again() {
    let fx = Fixture::new();
    let root = fx.repo();
    let outside = fx.base.join("outside");
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("CLAUDE.md"), "").unwrap();
    std::os::unix::fs::symlink(outside.join("CLAUDE.md"), root.join("CLAUDE.md")).unwrap();
    std::os::unix::fs::symlink(&outside, root.join(".claude")).unwrap();
    std::os::unix::fs::symlink(".git/config", root.join("AGENTS.md")).unwrap();
    fs::create_dir_all(root.join("sub")).unwrap();
    fs::write(root.join("README.md"), "").unwrap();
    fs::write(root.join("sub/CLAUDE.md"), "").unwrap();
    std::os::unix::fs::symlink("README.md", root.join("GEMINI.md")).unwrap();
    std::os::unix::fs::symlink("CLAUDE.md", root.join("sub/AGENTS.md")).unwrap();
    for refused in ["CLAUDE.md", ".claude/SKILL.md", "AGENTS.md", "GEMINI.md"] {
        assert_eq!(adapter::resolved_target(&root, &root.join(refused), Links::Rule), None, "{refused}");
    }
    assert_eq!(adapter::resolved_target(&root, &root.join("sub/AGENTS.md"), Links::Rule), Some(root.join("sub/CLAUDE.md")));
    assert_eq!(adapter::resolved_target(&root, &root.join("CLAUDE.new"), Links::Rule), None);
    assert_eq!(adapter::resolved_target(&root, &root.join("sub/CLAUDE.md"), Links::Rule), Some(root.join("sub/CLAUDE.md")));
    assert_eq!(adapter::resolved_target(&root, &root.join("GEMINI.md"), Links::Git), Some(root.join("README.md")));

    assert_eq!(adapter::outside_link(&root, None, &root.join("new.md"), Links::Rule), None);
    assert_eq!(adapter::outside_link(&root, None, &root.join("sub/AGENTS.md"), Links::Rule), Some(root.join("sub/AGENTS.md")));
    assert_eq!(adapter::outside_link(&root, Some(&root), &root.join("sub/AGENTS.md"), Links::Rule), None);
    assert_eq!(adapter::outside_link(&root, Some(&root), &root.join("GEMINI.md"), Links::Rule), Some(root.join("GEMINI.md")));
}

/// An in-project link to a file that is not a rule file (`AGENTS.md -> Makefile`), or a
/// skills folder linked anywhere but another skills folder, is never written through.
#[cfg(unix)]
#[test]
fn in_project_links_to_other_files_are_never_written() {
    let fx = Fixture::new();
    let root = fx.repo();
    fs::write(root.join("Makefile"), "all:\n").unwrap();
    std::os::unix::fs::symlink("Makefile", root.join("AGENTS.md")).unwrap();
    fx.import(Kind::Rule, &fx.folder("tests", &[("RULE.md", "Run the tests before finishing.\n")]));
    let refused = fx.library.activate("tests", "codex", Scope::Project, Some(&root), false).unwrap_err();
    assert!(refused.contains("is a link; PandaCode does not write through links."), "{refused}");
    assert_eq!(fs::read_to_string(root.join("Makefile")).unwrap(), "all:\n");

    fs::create_dir_all(root.join(".github/workflows")).unwrap();
    fs::create_dir_all(root.join(".agents")).unwrap();
    std::os::unix::fs::symlink("../.github/workflows", root.join(".agents/skills")).unwrap();
    fx.import(Kind::Skill, &fx.folder("release-notes", &[("SKILL.md", SKILL)]));
    let refused = fx.library.activate("release-notes", "codex", Scope::Project, Some(&root), false).unwrap_err();
    assert!(refused.contains("is a link"), "{refused}");
    assert!(!root.join(".github/workflows/release-notes").exists());
}

#[cfg_attr(not(unix), allow(dead_code))] // only Unix tests call it
fn ignored(root: &Path, path: &str) -> bool {
    Command::new("git").args(["check-ignore", "-q", path]).current_dir(root).status().unwrap().success()
}

/// The exclude line names where the files really land, relative to the repository's top
/// level: through an in-project link (`.agents/skills -> ../.claude/skills`, which Git does
/// not follow for ignores) and from a project that is a subfolder of its repository.
#[cfg(unix)]
#[test]
fn exclude_lines_follow_links_and_the_repository_top_level() {
    let fx = Fixture::new();
    let root = fx.repo();
    fs::create_dir_all(root.join(".claude/skills")).unwrap();
    fs::create_dir_all(root.join(".agents")).unwrap();
    std::os::unix::fs::symlink("../.claude/skills", root.join(".agents/skills")).unwrap();
    fx.import(Kind::Skill, &fx.folder("release-notes", &[("SKILL.md", SKILL)]));
    fx.library.activate("release-notes", "codex", Scope::Project, Some(&root), false).unwrap();
    assert!(ignored(&root, ".claude/skills/release-notes/SKILL.md"));
    let status = Command::new("git").args(["status", "--porcelain", "--untracked-files=all"]).current_dir(&root).output().unwrap();
    assert!(!String::from_utf8_lossy(&status.stdout).contains("release-notes"), "{}", String::from_utf8_lossy(&status.stdout));
    fx.library.deactivate("release-notes", "codex", Scope::Project, Some(&root)).unwrap();
    assert!(!fs::read_to_string(root.join(".git/info/exclude")).unwrap().contains("release-notes"));

    let sub = root.join("app");
    fs::create_dir_all(&sub).unwrap();
    fx.library.activate("release-notes", "claude", Scope::Project, Some(&sub), false).unwrap();
    assert_eq!(fx.library.load("release-notes").unwrap().activations[0].excluded, ["/app/.claude/skills/release-notes/"]);
    assert!(ignored(&root, "app/.claude/skills/release-notes/SKILL.md"));
}

/// A project rule file or Git exclude file hard-linked to a file elsewhere is never rewritten
/// in place: the write is refused and the other file keeps its bytes.
#[cfg(unix)]
#[test]
fn hard_linked_project_files_are_never_written() {
    let fx = Fixture::new();
    let root = fx.repo();
    let outside = fx.base.join("outside.md");
    fs::write(&outside, "# Elsewhere\n").unwrap();
    fs::hard_link(&outside, root.join("CLAUDE.md")).unwrap();
    fx.import(Kind::Rule, &fx.folder("tests", &[("RULE.md", "Run the tests before finishing.\n")]));
    let refused = fx.library.activate("tests", "claude", Scope::Project, Some(&root), false).unwrap_err();
    assert!(refused.contains("hard-linked elsewhere"), "{refused}");
    assert_eq!(fs::read_to_string(&outside).unwrap(), "# Elsewhere\n");

    let outside_exclude = fx.base.join("outside-exclude");
    fs::write(&outside_exclude, "").unwrap();
    fs::remove_file(root.join(".git/info/exclude")).ok();
    fs::hard_link(&outside_exclude, root.join(".git/info/exclude")).unwrap();
    fx.import(Kind::Skill, &fx.folder("release-notes", &[("SKILL.md", SKILL)]));
    let refused = fx.library.activate("release-notes", "claude", Scope::Project, Some(&root), false).unwrap_err();
    assert!(refused.contains("hard-linked elsewhere"), "{refused}");
    assert_eq!(fs::read_to_string(&outside_exclude).unwrap(), "");
    assert!(!root.join(".claude/skills/release-notes").exists());
}

/// An exclude line added before a write that is then refused is taken back.
#[cfg(unix)]
#[test]
fn an_exclude_line_is_rolled_back_when_the_write_is_refused() {
    let fx = Fixture::new();
    let root = fx.repo();
    let exclude = root.join(".git/info/exclude");
    let before = fs::read_to_string(&exclude).unwrap_or_default();
    fs::create_dir_all(root.join(".git/planted")).unwrap();
    std::os::unix::fs::symlink(".git/planted", root.join(".claude")).unwrap();
    fx.import(Kind::Skill, &fx.folder("release-notes", &[("SKILL.md", SKILL)]));
    let refused = fx.library.activate("release-notes", "claude", Scope::Project, Some(&root), false).unwrap_err();
    assert!(refused.contains("is a link"), "{refused}");
    assert_eq!(fs::read_to_string(&exclude).unwrap_or_default(), before);
}

/// A project activation recorded without its checkout is left alone by deactivate_all: its
/// files are reported as kept and its record goes, so nothing is stuck and remove succeeds.
#[test]
fn deactivate_all_drops_a_project_record_without_its_checkout_and_keeps_its_files() {
    let fx = Fixture::new();
    let root = fx.repo();
    fx.import(Kind::Skill, &fx.folder("release-notes", &[("SKILL.md", SKILL)]));
    fx.library.activate("release-notes", "claude", Scope::Project, Some(&root), false).unwrap();
    fx.library.activate("release-notes", "claude", Scope::User, None, false).unwrap();
    let mut meta = fx.library.load("release-notes").unwrap();
    meta.activations.iter_mut().filter(|a| a.scope == Scope::Project).for_each(|a| a.project = None);
    fx.library.save(&meta).unwrap();
    let change = fx.library.deactivate_all("release-notes").unwrap();
    assert_eq!(change.kept, [root.join(".claude/skills/release-notes/SKILL.md").to_string_lossy()]);
    assert!(fx.library.load("release-notes").unwrap().activations.is_empty());
    assert!(root.join(".claude/skills/release-notes/SKILL.md").is_file());
    assert!(!fx.home.join(".claude/skills/release-notes").exists());
    fx.library.remove("release-notes").unwrap();
}

/// Every file is checked before anything is removed: a new file of an updated skill that is
/// hard-linked elsewhere refuses the update, and the previous activation stays as it was.
#[cfg(unix)]
#[test]
fn a_refused_file_in_an_update_removes_and_writes_nothing() {
    let fx = Fixture::new();
    let root = fx.repo();
    let source = fx.folder("release-notes", &[("SKILL.md", SKILL)]);
    fx.import(Kind::Skill, &source);
    fx.library.activate("release-notes", "claude", Scope::Project, Some(&root), false).unwrap();
    let before = fx.library.load("release-notes").unwrap().activations;
    let exclude = fs::read_to_string(root.join(".git/info/exclude")).unwrap();

    fs::write(source.join("SKILL.md"), format!("{SKILL}See extra.md.\n")).unwrap();
    fs::write(source.join("extra.md"), "Extra.\n").unwrap();
    fx.import(Kind::Skill, &source);
    let outside = fx.base.join("outside.md");
    fs::write(&outside, "# Elsewhere\n").unwrap();
    let folder = root.join(".claude/skills/release-notes");
    fs::hard_link(&outside, folder.join("extra.md")).unwrap();
    let refused = fx.library.activate("release-notes", "claude", Scope::Project, Some(&root), false).unwrap_err();
    assert!(refused.contains("hard-linked elsewhere"), "{refused}");
    assert_eq!(fs::read_to_string(folder.join("SKILL.md")).unwrap(), SKILL, "the previous file stays");
    assert_eq!(fs::read_to_string(&outside).unwrap(), "# Elsewhere\n");
    let after = fx.library.load("release-notes").unwrap().activations;
    assert_eq!(serde_json::to_string(&after).unwrap(), serde_json::to_string(&before).unwrap());
    assert_eq!(fs::read_to_string(root.join(".git/info/exclude")).unwrap(), exclude);
}

/// A write that fails partway on a first activation removes what it wrote and its exclude
/// line, so the folder neither shows in `git status` nor blocks a retry.
#[cfg(unix)]
#[test]
fn a_write_failing_partway_removes_what_it_wrote() {
    let fx = Fixture::new();
    let root = fx.repo();
    let source = fx.folder("release-notes", &[("SKILL.md", SKILL), ("z/extra.md", "Extra.\n")]);
    fx.import(Kind::Skill, &source);
    let before = fs::read_to_string(root.join(".git/info/exclude")).unwrap_or_default();
    // `z` is a file where a folder must go, so the second file can't be written.
    let skills = root.join(".claude/skills");
    let written = adapter::write_folder(&skills, "release-notes", &[("SKILL.md".into(), SKILL.into()), ("z".into(), b"x".to_vec()), ("z/extra.md".into(), b"y".to_vec())], &[], Some(&root));
    assert!(written.is_err());
    assert!(!skills.join("release-notes").exists(), "nothing this call wrote remains");
    assert_eq!(fs::read_to_string(root.join(".git/info/exclude")).unwrap_or_default(), before);
    fx.library.activate("release-notes", "claude", Scope::Project, Some(&root), false).unwrap();
}

/// With `AGENTS.md -> CLAUDE.md` or `.agents/skills -> ../.claude/skills`, an item already
/// active for Claude is refused for Codex with a clear message, and Claude's copy stays.
#[cfg(unix)]
#[test]
fn a_linked_surface_another_harness_manages_is_refused_clearly() {
    let fx = Fixture::new();
    let root = fx.repo();
    std::os::unix::fs::symlink("CLAUDE.md", root.join("AGENTS.md")).unwrap();
    fs::create_dir_all(root.join(".claude/skills")).unwrap();
    fs::create_dir_all(root.join(".agents")).unwrap();
    std::os::unix::fs::symlink("../.claude/skills", root.join(".agents/skills")).unwrap();
    fx.import(Kind::Rule, &fx.folder("tests", &[("RULE.md", "Run the tests before finishing.\n")]));
    fx.import(Kind::Skill, &fx.folder("release-notes", &[("SKILL.md", SKILL)]));
    for id in ["tests", "release-notes"] {
        fx.library.activate(id, "claude", Scope::Project, Some(&root), false).unwrap();
        let refused = fx.library.activate(id, "codex", Scope::Project, Some(&root), false).unwrap_err();
        assert!(refused.contains("is a link to") && refused.contains("PandaCode already manages for claude."), "{refused}");
        assert!(fx.library.deactivate(id, "codex", Scope::Project, Some(&root)).is_err(), "not active for Codex");
        assert_eq!(Fixture::cell(&fx.library.matrix(Some(&root)).unwrap(), "claude", id, Scope::Project).status, "active");
    }
    assert!(fs::read_to_string(root.join("CLAUDE.md")).unwrap().contains("Run the tests"));
    assert_eq!(fs::read_to_string(root.join(".claude/skills/release-notes/SKILL.md")).unwrap(), SKILL);
}

/// A planted `.git` file pointing at another repository never gets that repository's exclude
/// list written; activation still succeeds. A genuine linked worktree still gets its line.
#[cfg(unix)]
#[test]
fn planted_git_dirs_are_not_trusted_and_worktrees_are() {
    let fx = Fixture::new();
    let other = fx.repo();
    let exclude = other.join(".git/info/exclude");
    let before = fs::read_to_string(&exclude).unwrap_or_default();
    let planted = fx.base.join("planted");
    fs::create_dir_all(&planted).unwrap();
    fs::write(planted.join(".git"), format!("gitdir: {}\n", other.join(".git").display())).unwrap();
    fx.import(Kind::Skill, &fx.folder("release-notes", &[("SKILL.md", SKILL)]));
    fx.library.activate("release-notes", "claude", Scope::Project, Some(&planted), false).unwrap();
    assert_eq!(fs::read_to_string(&exclude).unwrap_or_default(), before);
    assert!(planted.join(".claude/skills/release-notes/SKILL.md").is_file());

    let git = |args: &[&str]| assert!(Command::new("git").args(["-c", "user.name=t", "-c", "user.email=t@t"]).args(args).current_dir(&other).status().unwrap().success());
    git(&["commit", "-q", "--allow-empty", "-m", "init"]);
    let worktree = fx.base.join("wt");
    git(&["worktree", "add", "-q", worktree.to_str().unwrap()]);
    fx.library.activate("release-notes", "claude", Scope::Project, Some(&worktree), false).unwrap();
    assert!(fs::read_to_string(&exclude).unwrap().contains("/.claude/skills/release-notes/"));
}

/// The user's own untracked skill folder at the target refuses activation before the exclude
/// list changes, so it never vanishes from `git status`.
#[test]
fn a_refused_activation_over_the_users_folder_leaves_the_exclude_list_alone() {
    let fx = Fixture::new();
    let root = fx.repo();
    let exclude = root.join(".git/info/exclude");
    let before = fs::read_to_string(&exclude).unwrap_or_default();
    let mine = root.join(".claude/skills/release-notes");
    fs::create_dir_all(&mine).unwrap();
    fs::write(mine.join("SKILL.md"), "mine").unwrap();
    fx.import(Kind::Skill, &fx.folder("release-notes", &[("SKILL.md", SKILL)]));
    let refused = fx.library.activate("release-notes", "claude", Scope::Project, Some(&root), false).unwrap_err();
    assert!(refused.contains("did not create"), "{refused}");
    assert_eq!(fs::read_to_string(&exclude).unwrap_or_default(), before);
    assert_eq!(fs::read_to_string(mine.join("SKILL.md")).unwrap(), "mine");
}

/// Two rules share the CLAUDE.md the first one created: turning the first off keeps the
/// file and its exclude line for the second; turning the second off removes both.
#[test]
fn rules_sharing_a_created_claude_md_keep_its_exclude_line() {
    let fx = Fixture::new();
    let root = fx.repo();
    let exclude = root.join(".git/info/exclude");
    fx.import(Kind::Rule, &fx.folder("tests", &[("RULE.md", "Run the tests.\n")]));
    fx.import(Kind::Rule, &fx.folder("lint", &[("RULE.md", "Run the linter.\n")]));
    fx.library.activate("tests", "claude", Scope::Project, Some(&root), false).unwrap();
    fx.library.activate("lint", "claude", Scope::Project, Some(&root), false).unwrap();
    assert!(fs::read_to_string(&exclude).unwrap().lines().any(|l| l == "/CLAUDE.md"));

    fx.library.deactivate("tests", "claude", Scope::Project, Some(&root)).unwrap();
    assert!(fs::read_to_string(root.join("CLAUDE.md")).unwrap().contains("Run the linter."));
    assert!(fs::read_to_string(&exclude).unwrap().lines().any(|l| l == "/CLAUDE.md"), "still needed by lint");

    fx.library.deactivate("lint", "claude", Scope::Project, Some(&root)).unwrap();
    assert!(!root.join("CLAUDE.md").exists());
    assert!(!fs::read_to_string(&exclude).unwrap().lines().any(|l| l == "/CLAUDE.md"), "the last one relying on it removes it");
}

/// The same skill in a linked worktree shares the repository's exclude line that the main
/// checkout's activation added. Turning both off at once removes it, though the activation
/// left last never added it.
#[cfg(unix)]
#[test]
fn deactivate_all_removes_a_shared_line_the_last_activation_did_not_add() {
    let fx = Fixture::new();
    let root = fx.repo();
    let git = |args: &[&str]| assert!(Command::new("git").args(["-c", "user.name=t", "-c", "user.email=t@t"]).args(args).current_dir(&root).status().unwrap().success());
    git(&["commit", "-q", "--allow-empty", "-m", "init"]);
    let worktree = fx.base.join("wt");
    git(&["worktree", "add", "-q", worktree.to_str().unwrap()]);
    let worktree = worktree.canonicalize().unwrap();
    fx.import(Kind::Skill, &fx.folder("release-notes", &[("SKILL.md", SKILL)]));
    for checkout in [&root, &worktree] {
        fx.library.activate("release-notes", "claude", Scope::Project, Some(checkout), false).unwrap();
    }
    let meta = fx.library.load("release-notes").unwrap();
    assert_eq!(meta.activations.iter().map(|a| a.excluded.len()).collect::<Vec<_>>(), [1, 0], "only the first added it");
    let exclude = root.join(".git/info/exclude");
    fs::write(&exclude, format!("# mine\n/.claude/skills/\n{}", fs::read_to_string(&exclude).unwrap())).unwrap();

    fx.library.deactivate_all("release-notes").unwrap();
    let text = fs::read_to_string(&exclude).unwrap();
    assert!(!text.contains("release-notes"), "{text}");
    assert!(text.lines().any(|l| l == "/.claude/skills/"), "the user's own line stays: {text}");
}

/// A FIFO planted where a skill file goes is refused instead of blocking the write forever.
#[cfg(unix)]
#[test]
fn a_fifo_at_a_skill_file_path_is_refused_without_blocking() {
    let fx = Fixture::new();
    let root = fx.repo();
    fx.import(Kind::Skill, &fx.folder("release-notes", &[("SKILL.md", SKILL)]));
    fx.library.activate("release-notes", "claude", Scope::Project, Some(&root), false).unwrap();
    fx.import(Kind::Skill, &fx.folder("release-notes", &[("SKILL.md", SKILL), ("extra.md", "Extra.\n")]));
    let fifo = root.join(".claude/skills/release-notes/extra.md");
    let name = std::ffi::CString::new(fifo.to_string_lossy().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
    let started = std::time::Instant::now();
    let refused = fx.library.activate("release-notes", "claude", Scope::Project, Some(&root), false).unwrap_err();
    assert!(refused.contains("not a regular file"), "{refused}");
    assert!(started.elapsed() < std::time::Duration::from_secs(5), "nothing blocks");
}

/// Moving an activation keeps an old exclude line another activation still has files under:
/// the same skill's old Codex copy in a linked worktree sharing the exclude list. Once that
/// one moves too, the line goes.
#[cfg(unix)]
#[test]
fn moving_an_activation_keeps_a_shared_old_exclude_line() {
    let fx = Fixture::new();
    let root = fx.repo();
    let git = |args: &[&str]| assert!(Command::new("git").args(["-c", "user.name=t", "-c", "user.email=t@t"]).args(args).current_dir(&root).status().unwrap().success());
    git(&["commit", "-q", "--allow-empty", "-m", "init"]);
    let worktree = fx.base.join("wt");
    git(&["worktree", "add", "-q", worktree.to_str().unwrap()]);
    let worktree = worktree.canonicalize().unwrap();
    fx.import(Kind::Skill, &fx.folder("release-notes", &[("SKILL.md", SKILL)]));
    for checkout in [&root, &worktree] {
        fx.library.activate("release-notes", "codex", Scope::Project, Some(checkout), false).unwrap();
    }
    // Rewrite both as the old adapter recorded them, in `.codex/skills`.
    let entry = "/.codex/skills/release-notes/".to_string();
    let meta = fx.library.load("release-notes").unwrap();
    let activations = meta.activations.iter().cloned().map(|a| {
        let checkout = PathBuf::from(a.project.clone().unwrap());
        let (old, new) = (checkout.join(".codex/skills/release-notes"), checkout.join(".agents/skills/release-notes"));
        fs::create_dir_all(&old).unwrap();
        fs::rename(new.join("SKILL.md"), old.join("SKILL.md")).unwrap();
        fs::remove_dir_all(&new).unwrap();
        Activation { files: vec![Written { path: old.join("SKILL.md").to_string_lossy().into_owned(), sha256: a.files[0].sha256.clone() }], excluded: vec![entry.clone()], ..a }
    }).collect();
    fx.library.save(&Meta { activations, ..meta }).unwrap();
    let exclude = root.join(".git/info/exclude");
    fs::write(&exclude, format!("{entry}\n")).unwrap();

    fx.library.activate("release-notes", "codex", Scope::Project, Some(&root), false).unwrap();
    assert!(!root.join(".codex/skills/release-notes").exists());
    assert!(fs::read_to_string(&exclude).unwrap().lines().any(|l| l == entry), "the worktree's old copy still needs it");

    fx.library.activate("release-notes", "codex", Scope::Project, Some(&worktree), false).unwrap();
    let text = fs::read_to_string(&exclude).unwrap();
    assert!(!text.contains(".codex") && text.lines().any(|l| l == "/.agents/skills/release-notes/"), "{text}");
}

/// A new rule file whose write failed is removed only while it is still the file this call
/// created and holds nothing but a start of what was being written.
#[cfg(unix)]
#[test]
fn a_failed_new_rule_file_is_removed_only_while_it_is_ours() {
    let fx = Fixture::new();
    let path = fx.base.join("CLAUDE.md");
    let create = || fs::OpenOptions::new().write(true).create_new(true).open(&path).unwrap();
    let file = create();
    adapter::discard_created(&path, &file, b"block");
    assert!(!path.exists(), "an empty file this call created goes");

    let file = create();
    fs::write(&path, "blo").unwrap();
    adapter::discard_created(&path, &file, b"block");
    assert!(!path.exists(), "so does a partial write of it");

    let file = create();
    fs::write(&path, "theirs").unwrap();
    adapter::discard_created(&path, &file, b"block");
    assert_eq!(fs::read_to_string(&path).unwrap(), "theirs", "other content stays");

    fs::remove_file(&path).unwrap();
    let file = create();
    fs::remove_file(&path).unwrap();
    fs::write(&path, "").unwrap();
    adapter::discard_created(&path, &file, b"block");
    assert!(path.exists(), "another file now at the path stays");
}

/// An exclude list that is not UTF-8 text is refused and left byte for byte; nothing is written.
#[test]
fn a_non_utf8_exclude_list_is_refused_and_left_unchanged() {
    let fx = Fixture::new();
    let root = fx.repo();
    let exclude = root.join(".git/info/exclude");
    let mine = b"# mine\n\xff\xfe/build\n".to_vec();
    fs::write(&exclude, &mine).unwrap();
    fx.import(Kind::Skill, &fx.folder("release-notes", &[("SKILL.md", SKILL)]));
    let refused = fx.library.activate("release-notes", "claude", Scope::Project, Some(&root), false).unwrap_err();
    assert!(refused.contains("not UTF-8") && refused.contains("left it unchanged"), "{refused}");
    assert_eq!(fs::read(&exclude).unwrap(), mine);
    assert!(!root.join(".claude/skills/release-notes").exists());
}

/// A FIFO at `info/exclude` is refused instead of blocking under the library lock.
#[cfg(unix)]
#[test]
fn a_fifo_exclude_list_is_refused_without_blocking() {
    use std::os::unix::fs::FileTypeExt as _;
    let fx = Fixture::new();
    let root = fx.repo();
    let exclude = root.join(".git/info/exclude");
    let _ = fs::remove_file(&exclude);
    fs::create_dir_all(exclude.parent().unwrap()).unwrap();
    let name = std::ffi::CString::new(exclude.to_string_lossy().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
    fx.import(Kind::Skill, &fx.folder("release-notes", &[("SKILL.md", SKILL)]));
    let started = std::time::Instant::now();
    let refused = fx.library.activate("release-notes", "claude", Scope::Project, Some(&root), false).unwrap_err();
    assert!(refused.contains("Git exclude list"), "{refused}");
    assert!(started.elapsed() < std::time::Duration::from_secs(5), "nothing blocks");
    assert!(fs::symlink_metadata(&exclude).unwrap().file_type().is_fifo());
}

/// A main checkout and a linked worktree, with `release-notes` imported.
#[cfg(unix)]
fn repo_with_worktree(fx: &Fixture) -> (PathBuf, PathBuf) {
    let root = fx.repo();
    let git = |args: &[&str]| assert!(Command::new("git").args(["-c", "user.name=t", "-c", "user.email=t@t"]).args(args).current_dir(&root).status().unwrap().success());
    git(&["commit", "-q", "--allow-empty", "-m", "init"]);
    let worktree = fx.base.join("wt");
    git(&["worktree", "add", "-q", worktree.to_str().unwrap()]);
    fx.import(Kind::Skill, &fx.folder("release-notes", &[("SKILL.md", SKILL)]));
    (root, worktree.canonicalize().unwrap())
}

/// A line owned by an activation whose worktree was deleted is handed to the main checkout's
/// activation that still needs it, through the exclude list recorded with it; with no one left
/// relying on it, it is removed from that list.
#[cfg(unix)]
#[test]
fn a_line_from_a_deleted_worktree_is_handed_over_or_removed() {
    let fx = Fixture::new();
    let (root, worktree) = repo_with_worktree(&fx);
    let entry = "/.claude/skills/release-notes/";
    let exclude = root.join(".git/info/exclude");
    let has_line = || fs::read_to_string(&exclude).unwrap().lines().any(|l| l == entry);
    for checkout in [&worktree, &root] {
        fx.library.activate("release-notes", "claude", Scope::Project, Some(checkout), false).unwrap();
    }
    let owner = |project: &Path| fx.library.load("release-notes").unwrap().activations.into_iter().find(|a| a.project.as_deref() == Some(&*project.to_string_lossy())).unwrap();
    assert_eq!(owner(&worktree).exclude_list.as_deref(), Some(&*exclude.canonicalize().unwrap().to_string_lossy()));
    fs::remove_dir_all(&worktree).unwrap();

    fx.library.deactivate("release-notes", "claude", Scope::Project, Some(&worktree)).unwrap();
    assert!(has_line(), "the main checkout's copy still needs it");
    assert_eq!(owner(&root).excluded, [entry]);
    fx.library.deactivate("release-notes", "claude", Scope::Project, Some(&root)).unwrap();
    assert!(!has_line());

    // No heir: the recorded list itself loses the line.
    let worktree = fx.base.join("wt2");
    let git = |args: &[&str]| assert!(Command::new("git").args(args).current_dir(&root).status().unwrap().success());
    git(&["worktree", "add", "-q", worktree.to_str().unwrap()]);
    let worktree = worktree.canonicalize().unwrap();
    fx.library.activate("release-notes", "claude", Scope::Project, Some(&worktree), false).unwrap();
    assert!(has_line());
    fs::remove_dir_all(&worktree).unwrap();
    fx.library.deactivate_all("release-notes").unwrap();
    assert!(!has_line());
}

/// `deactivate_all` hands a line only to activations that remain: another item's (a rule
/// sharing a created CLAUDE.md), never one of its own it already undid. Its own worktree copy
/// undone first and kept (edited) does not keep the main checkout's line alive.
#[cfg(unix)]
#[test]
fn deactivate_all_hands_lines_only_to_activations_that_remain() {
    let fx = Fixture::new();
    let root = fx.repo();
    let exclude = root.join(".git/info/exclude");
    let has = |line: &str| fs::read_to_string(&exclude).unwrap().lines().any(|l| l == line);
    fx.import(Kind::Rule, &fx.folder("tests", &[("RULE.md", "Run the tests.\n")]));
    fx.import(Kind::Rule, &fx.folder("lint", &[("RULE.md", "Run the linter.\n")]));
    fx.library.activate("tests", "claude", Scope::Project, Some(&root), false).unwrap();
    fx.library.activate("lint", "claude", Scope::Project, Some(&root), false).unwrap();
    fx.library.deactivate_all("tests").unwrap();
    assert!(has("/CLAUDE.md"));
    assert_eq!(fx.library.load("lint").unwrap().activations[0].excluded, ["/CLAUDE.md"]);
    fx.library.deactivate_all("lint").unwrap();
    assert!(!has("/CLAUDE.md"));

    let fx = Fixture::new();
    let (root, worktree) = repo_with_worktree(&fx);
    let exclude = root.join(".git/info/exclude");
    let entry = "/.claude/skills/release-notes/";
    for checkout in [&root, &worktree, &root] {
        fx.library.activate("release-notes", "claude", Scope::Project, Some(checkout), false).unwrap();
    }
    let order: Vec<_> = fx.library.load("release-notes").unwrap().activations.into_iter().map(|a| (a.project.unwrap(), a.excluded.len())).collect();
    assert_eq!(order, [(worktree.to_string_lossy().into_owned(), 0), (root.to_string_lossy().into_owned(), 1)]);
    let edited = worktree.join(".claude/skills/release-notes/SKILL.md");
    fs::write(&edited, "mine").unwrap();
    let change = fx.library.deactivate_all("release-notes").unwrap();
    assert_eq!(change.kept, [edited.to_string_lossy().into_owned()]);
    assert!(!fs::read_to_string(&exclude).unwrap().lines().any(|l| l == entry), "no undone activation keeps it");
}

/// When the library record can't be saved after a write, the files and the exclude line this
/// call added are taken back, so nothing is left unrecorded.
#[cfg(unix)]
#[test]
fn a_failed_save_after_a_write_rolls_the_write_back() {
    use std::os::unix::fs::PermissionsExt;
    let fx = Fixture::new();
    let root = fx.repo();
    let exclude = root.join(".git/info/exclude");
    let before = fs::read_to_string(&exclude).unwrap_or_default();
    fx.import(Kind::Skill, &fx.folder("release-notes", &[("SKILL.md", SKILL)]));
    let library = fx.base.join("library");
    fs::set_permissions(&library, fs::Permissions::from_mode(0o500)).unwrap();
    let refused = fx.library.activate("release-notes", "claude", Scope::Project, Some(&root), false);
    fs::set_permissions(&library, fs::Permissions::from_mode(0o755)).unwrap();
    let refused = refused.unwrap_err();
    assert!(refused.contains("Could not save the library"), "{refused}");
    assert!(!root.join(".claude/skills/release-notes").exists());
    assert_eq!(fs::read_to_string(&exclude).unwrap_or_default(), before);
}

/// A project rule file is replaced whole through a temporary file: the user's text around the
/// block and the file's permissions stay, and no temporary file is left behind.
#[cfg(unix)]
#[test]
fn project_rule_files_are_replaced_whole_and_keep_their_permissions() {
    use std::os::unix::fs::PermissionsExt;
    let fx = Fixture::new();
    let root = fx.repo();
    let file = root.join("CLAUDE.md");
    fs::write(&file, "# Mine\nKeep this.\n").unwrap();
    fs::set_permissions(&file, fs::Permissions::from_mode(0o640)).unwrap();
    fx.import(Kind::Rule, &fx.folder("tests", &[("RULE.md", "Run the tests.\n")]));
    fx.library.activate("tests", "claude", Scope::Project, Some(&root), false).unwrap();
    let text = fs::read_to_string(&file).unwrap();
    assert!(text.starts_with("# Mine\nKeep this.") && text.contains("Run the tests."), "{text}");
    assert_eq!(fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o640);
    fx.library.deactivate("tests", "claude", Scope::Project, Some(&root)).unwrap();
    assert_eq!(fs::read_to_string(&file).unwrap(), "# Mine\nKeep this.\n");
    assert!(fs::read_dir(&root).unwrap().flatten().all(|e| !e.file_name().to_string_lossy().ends_with(".tmp")));
}

#[cfg_attr(not(unix), allow(dead_code))] // only Unix tests call it
fn git_status(root: &Path) -> String {
    let out = Command::new("git").args(["status", "--porcelain", "--untracked-files=all"]).current_dir(root).output().unwrap();
    String::from_utf8_lossy(&out.stdout).into_owned()
}

/// A committed folder whose name holds a newline, reached through an allowed skills link, can
/// never add lines of its own (`*`) to the shared exclude list: the activation is refused
/// before anything is written.
#[cfg(unix)]
#[test]
fn a_folder_name_with_a_newline_is_refused_before_anything_is_written() {
    let fx = Fixture::new();
    let root = fx.repo();
    let planted = root.join(".claude/skills/x\n*\n#");
    fs::create_dir_all(&planted).unwrap();
    fs::create_dir_all(root.join(".agents")).unwrap();
    std::os::unix::fs::symlink("../.claude/skills/x\n*\n#", root.join(".agents/skills")).unwrap();
    let exclude = root.join(".git/info/exclude");
    let before = fs::read(&exclude).unwrap();
    fx.import(Kind::Skill, &fx.folder("release-notes", &[("SKILL.md", SKILL)]));
    let refused = fx.library.activate("release-notes", "codex", Scope::Project, Some(&root), false).unwrap_err();
    assert!(refused.contains("control character"), "{refused}");
    assert_eq!(fs::read(&exclude).unwrap(), before);
    assert!(!planted.join("release-notes").exists());
    assert!(fx.library.load("release-notes").unwrap().activations.is_empty());
}

/// Gitignore specials in a folder name are escaped, so the line hides only that literal path,
/// and turning the skill off removes exactly that line.
#[cfg(unix)]
#[test]
fn gitignore_specials_in_a_path_are_escaped_and_removed_again() {
    let fx = Fixture::new();
    let root = fx.repo();
    fs::create_dir_all(root.join(".claude/skills/a*b")).unwrap();
    fs::create_dir_all(root.join(".claude/skills/aXb/release-notes")).unwrap();
    fs::write(root.join(".claude/skills/aXb/release-notes/SKILL.md"), "mine").unwrap();
    fs::create_dir_all(root.join(".agents")).unwrap();
    std::os::unix::fs::symlink("../.claude/skills/a*b", root.join(".agents/skills")).unwrap();
    fx.import(Kind::Skill, &fx.folder("release-notes", &[("SKILL.md", SKILL)]));
    fx.library.activate("release-notes", "codex", Scope::Project, Some(&root), false).unwrap();
    let line = "/.claude/skills/a\\*b/release-notes/";
    assert_eq!(fx.library.load("release-notes").unwrap().activations[0].excluded, [line]);
    let exclude = root.join(".git/info/exclude");
    assert!(fs::read_to_string(&exclude).unwrap().lines().any(|l| l == line));
    assert!(ignored(&root, ".claude/skills/a*b/release-notes/SKILL.md"));
    assert!(!ignored(&root, ".claude/skills/aXb/release-notes/SKILL.md"), "only the literal path is hidden");
    fx.library.deactivate("release-notes", "codex", Scope::Project, Some(&root)).unwrap();
    assert!(!fs::read_to_string(&exclude).unwrap().contains("a\\*b"));
}

/// A tampered record whose exclude list names some other file never gets that file edited.
#[cfg(unix)]
#[test]
fn a_tampered_exclude_list_record_is_never_edited() {
    for victim in ["victim.txt", "fake/info/exclude"] {
        let fx = Fixture::new();
        let root = fx.repo();
        fx.import(Kind::Skill, &fx.folder("release-notes", &[("SKILL.md", SKILL)]));
        fx.library.activate("release-notes", "claude", Scope::Project, Some(&root), false).unwrap();
        let victim = fx.base.join(victim);
        fs::create_dir_all(victim.parent().unwrap()).unwrap();
        fs::write(&victim, "keep\n/.claude/skills/release-notes/\n").unwrap();
        let victim = victim.canonicalize().unwrap();
        let mut meta = fx.library.load("release-notes").unwrap();
        meta.activations[0].exclude_list = Some(victim.to_string_lossy().into_owned());
        fx.library.save(&meta).unwrap();
        fs::remove_dir_all(&root).unwrap();
        fx.library.deactivate("release-notes", "claude", Scope::Project, Some(&root)).unwrap();
        assert_eq!(fs::read_to_string(&victim).unwrap(), "keep\n/.claude/skills/release-notes/\n");
    }
}

/// A skill file that fails after part of it landed is removed with its exclude line, so
/// nothing shows in Git and a retry succeeds.
#[cfg(unix)]
#[test]
fn a_skill_file_failing_partway_is_removed_and_a_retry_succeeds() {
    let fx = Fixture::new();
    let root = fx.repo();
    let exclude = root.join(".git/info/exclude");
    let before = fs::read(&exclude).unwrap();
    fx.import(Kind::Skill, &fx.folder("release-notes", &[("SKILL.md", SKILL)]));
    adapter::fail_point::set(|path| if path.ends_with("SKILL.md") { Err(std::io::Error::other("disk full")) } else { Ok(()) });
    let refused = fx.library.activate("release-notes", "claude", Scope::Project, Some(&root), false);
    adapter::fail_point::clear();
    let refused = refused.unwrap_err();
    assert!(refused.contains("disk full") && !refused.contains("Left in place"), "{refused}");
    assert!(!root.join(".claude/skills/release-notes").exists());
    assert_eq!(git_status(&root), "");
    assert_eq!(fs::read(&exclude).unwrap(), before);
    fx.library.activate("release-notes", "claude", Scope::Project, Some(&root), false).unwrap();
    assert_eq!(fs::read_to_string(root.join(".claude/skills/release-notes/SKILL.md")).unwrap(), SKILL);
}

/// A file this call wrote that was edited before a later file failed stays and is named.
#[cfg(unix)]
#[test]
fn a_failed_write_names_the_files_it_left_in_place() {
    let fx = Fixture::new();
    let root = fx.repo();
    fx.import(Kind::Skill, &fx.folder("release-notes", &[("SKILL.md", SKILL), ("notes.md", "notes")]));
    let mut first: Option<PathBuf> = None;
    adapter::fail_point::set(move |path| match &first {
        None => {
            first = Some(path.to_path_buf());
            Ok(())
        }
        Some(earlier) => {
            fs::write(earlier, "edited meanwhile").unwrap();
            Err(std::io::Error::other("disk full"))
        }
    });
    let refused = fx.library.activate("release-notes", "claude", Scope::Project, Some(&root), false);
    adapter::fail_point::clear();
    let refused = refused.unwrap_err();
    assert!(refused.contains(" Left in place: ") && refused.contains(".claude/skills/release-notes/"), "{refused}");
}

/// A line the failed write's rollback cannot take back is said, not hidden.
#[cfg(unix)]
#[test]
fn a_rollback_that_cannot_remove_its_exclude_line_says_so() {
    let fx = Fixture::new();
    let root = fx.repo();
    let exclude = root.join(".git/info/exclude");
    fx.import(Kind::Skill, &fx.folder("release-notes", &[("SKILL.md", SKILL)]));
    let list = exclude.clone();
    adapter::fail_point::set(move |path| {
        if path.ends_with("SKILL.md") {
            let mut bytes = fs::read(&list).unwrap();
            bytes.push(0xff);
            fs::write(&list, bytes).unwrap();
            return Err(std::io::Error::other("disk full"));
        }
        Ok(())
    });
    let refused = fx.library.activate("release-notes", "claude", Scope::Project, Some(&root), false);
    adapter::fail_point::clear();
    let refused = refused.unwrap_err();
    assert!(refused.contains("Could not remove the exclude line /.claude/skills/release-notes/"), "{refused}");
}

/// Turning a skill off keeps an edited file, which is no longer managed: its exclude line goes
/// so the file shows in Git.
#[cfg(unix)]
#[test]
fn a_kept_file_loses_its_exclude_line_and_shows_in_git() {
    let fx = Fixture::new();
    let root = fx.repo();
    fx.import(Kind::Skill, &fx.folder("release-notes", &[("SKILL.md", SKILL)]));
    fx.library.activate("release-notes", "claude", Scope::Project, Some(&root), false).unwrap();
    let file = root.join(".claude/skills/release-notes/SKILL.md");
    fs::write(&file, "my edit").unwrap();
    let change = fx.library.deactivate("release-notes", "claude", Scope::Project, Some(&root)).unwrap();
    assert_eq!(change.kept, [file.to_string_lossy().into_owned()]);
    assert!(!fs::read_to_string(root.join(".git/info/exclude")).unwrap().contains("release-notes"));
    assert!(git_status(&root).contains(".claude/skills/release-notes/SKILL.md"));
}

/// Adds `paths` to the files recorded for `release-notes`'s activations, each with the hash
/// of what it holds now, as a tampered record would.
fn tamper_files(fx: &Fixture, paths: &[&Path]) {
    let mut meta = fx.library.load("release-notes").unwrap();
    for activation in &mut meta.activations {
        for path in paths {
            activation.files.push(Written { path: path.to_string_lossy().into_owned(), sha256: sha256_hex(&fs::read(path).unwrap()) });
        }
    }
    fx.library.save(&meta).unwrap();
}

/// Recorded paths outside the skill's own folder (`…/release-notes/../../../victim`, or an
/// unrelated file) are never removed or rewritten, by re-activation or turning off, in user
/// and project scope; they are reported as kept.
#[test]
fn recorded_paths_outside_the_surface_are_never_touched() {
    for scope in [Scope::User, Scope::Project] {
        let fx = Fixture::new();
        let root = fx.repo();
        let base = if scope == Scope::User { fx.home.clone() } else { root.clone() };
        let project = (scope == Scope::Project).then_some(root.as_path());
        fx.import(Kind::Skill, &fx.folder("release-notes", &[("SKILL.md", SKILL)]));
        fx.library.activate("release-notes", "claude", scope, project, false).unwrap();
        let victim = base.join("victim.md");
        let unrelated = fx.base.join("unrelated.md");
        for file in [&victim, &unrelated] {
            fs::write(file, "keep me").unwrap();
        }
        let dotted = base.join(".claude/skills/release-notes/../../../victim.md");
        tamper_files(&fx, &[&dotted, &unrelated]);
        let kept = fx.library.activate("release-notes", "claude", scope, project, false).unwrap().kept;
        assert_eq!(kept, [dotted.to_string_lossy().into_owned(), unrelated.to_string_lossy().into_owned()]);
        tamper_files(&fx, &[&dotted, &unrelated]);
        let change = if scope == Scope::User { fx.library.deactivate("release-notes", "claude", scope, project) } else { fx.library.deactivate_all("release-notes") }.unwrap();
        assert_eq!(change.kept.len(), 2, "{:?}", change.kept);
        for file in [&victim, &unrelated] {
            assert_eq!(fs::read_to_string(file).unwrap(), "keep me");
        }
        assert!(!base.join(".claude/skills/release-notes").exists(), "the real copy still goes");
    }
}

/// A record whose project is `/` (or not a plain absolute folder) has nothing removed and no
/// exclude line touched; its files are reported as kept.
#[test]
fn a_record_with_project_root_deletes_nothing() {
    let fx = Fixture::new();
    let root = fx.repo();
    fx.import(Kind::Skill, &fx.folder("release-notes", &[("SKILL.md", SKILL)]));
    fx.library.activate("release-notes", "claude", Scope::Project, Some(&root), false).unwrap();
    let copy = root.join(".claude/skills/release-notes/SKILL.md");
    for project in ["/", "relative/folder", &format!("{}/../repo", root.display())] {
        let mut meta = fx.library.load("release-notes").unwrap();
        meta.activations[0].project = Some(project.into());
        fx.library.save(&meta).unwrap();
        let change = fx.library.deactivate_all("release-notes").unwrap();
        assert_eq!(change.kept, [copy.to_string_lossy().into_owned()], "{project}");
        assert!(copy.is_file());
        assert!(fs::read_to_string(root.join(".git/info/exclude")).unwrap().contains("/.claude/skills/release-notes/"));
        // Recorded again for the next case.
        meta.activations[0].project = Some(root.to_string_lossy().into_owned());
        fx.library.save(&meta).unwrap();
    }
}

/// A save that fails after a re-activation puts the previous version back (files replaced,
/// added ones removed, a rule's old block body), so the saved record still matches the disk.
#[test]
fn a_failed_save_on_reactivation_keeps_the_previous_activation_installed() {
    let fx = Fixture::new();
    let root = fx.repo();
    let skill = fx.folder("release-notes", &[("SKILL.md", SKILL)]);
    fx.import(Kind::Skill, &skill);
    fx.library.activate("release-notes", "claude", Scope::Project, Some(&root), false).unwrap();
    let copy = root.join(".claude/skills/release-notes");
    let exclude = fs::read_to_string(root.join(".git/info/exclude")).unwrap();
    // The same version again, then an updated one with an extra file.
    assert!(failing_saves(|| fx.library.activate("release-notes", "claude", Scope::Project, Some(&root), false)).is_err());
    assert_eq!(fs::read_to_string(copy.join("SKILL.md")).unwrap(), SKILL);
    fs::write(skill.join("SKILL.md"), SKILL.replace("Summarize", "List")).unwrap();
    fs::write(skill.join("extra.md"), "extra").unwrap();
    fx.import(Kind::Skill, &skill);
    let refused = failing_saves(|| fx.library.activate("release-notes", "claude", Scope::Project, Some(&root), false)).unwrap_err();
    assert!(refused.contains("Could not save the library") && !refused.contains("Left in place"), "{refused}");
    assert_eq!(fs::read_to_string(copy.join("SKILL.md")).unwrap(), SKILL);
    assert!(!copy.join("extra.md").exists());
    assert_eq!(fs::read_to_string(root.join(".git/info/exclude")).unwrap(), exclude);
    let matrix = fx.library.matrix(Some(&root)).unwrap();
    assert_eq!(Fixture::cell(&matrix, "claude", "release-notes", Scope::Project).status, "outdated");

    let rule = fx.folder("tests", &[("RULE.md", "Run the tests.\n")]);
    fx.import(Kind::Rule, &rule);
    fx.library.activate("tests", "claude", Scope::User, None, false).unwrap();
    fs::write(rule.join("RULE.md"), "Run every test.\n").unwrap();
    fx.import(Kind::Rule, &rule);
    assert!(failing_saves(|| fx.library.activate("tests", "claude", Scope::User, None, false)).is_err());
    let text = fs::read_to_string(fx.home.join(".claude/CLAUDE.md")).unwrap();
    assert!(text.contains("Run the tests.") && !text.contains("every"), "{text}");
    let matrix = fx.library.matrix(None).unwrap();
    assert_eq!(Fixture::cell(&matrix, "claude", "tests", Scope::User).status, "outdated");
}

/// A save that fails after a surface move leaves the old copy and its line where they were and
/// removes the new copy, so the skill is still installed where the record says.
#[test]
fn a_failed_save_on_a_move_keeps_the_old_copy() {
    let fx = Fixture::new();
    let root = fx.repo();
    fx.import(Kind::Skill, &fx.folder("release", &[("SKILL.md", SKILL)]));
    fx.library.sync_project("codex", &root, &["release-notes".to_string()]);
    let old = plant_old_codex_activation(&fx, &root, "release-notes");
    let refused = failing_saves(|| fx.library.activate("release-notes", "codex", Scope::Project, Some(&root), false)).unwrap_err();
    assert!(refused.contains("Could not save the library"), "{refused}");
    assert_eq!(fs::read_to_string(old.join("SKILL.md")).unwrap(), SKILL);
    assert!(!root.join(".agents/skills/release-notes").exists());
    assert_eq!(fs::read_to_string(root.join(".git/info/exclude")).unwrap(), "/.codex/skills/release-notes/\n");
    assert_eq!(fx.library.load("release-notes").unwrap().activations[0].files[0].path, old.join("SKILL.md").to_string_lossy());
}

/// A record from before exclude lists were recorded, for a deleted worktree: its line goes to
/// the main checkout's activation whose list holds it (the repository still registers the
/// worktree), and is removed once that one is turned off. With no such activation it stays.
#[cfg(unix)]
#[test]
fn an_old_record_from_a_deleted_worktree_hands_its_line_to_a_sibling() {
    let fx = Fixture::new();
    let (root, worktree) = repo_with_worktree(&fx);
    let entry = "/.claude/skills/release-notes/";
    let exclude = root.join(".git/info/exclude");
    let has_line = || fs::read_to_string(&exclude).unwrap().lines().any(|l| l == entry);
    let strip = || {
        let mut meta = fx.library.load("release-notes").unwrap();
        meta.activations.iter_mut().for_each(|a| a.exclude_list = None);
        fx.library.save(&meta).unwrap();
    };
    for checkout in [&worktree, &root] {
        fx.library.activate("release-notes", "claude", Scope::Project, Some(checkout), false).unwrap();
    }
    strip();
    fs::remove_dir_all(&worktree).unwrap();
    fx.library.deactivate("release-notes", "claude", Scope::Project, Some(&worktree)).unwrap();
    assert!(has_line());
    assert_eq!(fx.library.load("release-notes").unwrap().activations[0].excluded, [entry]);
    fx.library.deactivate("release-notes", "claude", Scope::Project, Some(&root)).unwrap();
    assert!(!has_line());

    // Nobody left to take it: the line stays (and is logged).
    let worktree = fx.base.join("wt2");
    assert!(Command::new("git").args(["worktree", "add", "-q", worktree.to_str().unwrap()]).current_dir(&root).status().unwrap().success());
    fx.library.activate("release-notes", "claude", Scope::Project, Some(&worktree.canonicalize().unwrap()), false).unwrap();
    strip();
    fs::remove_dir_all(&worktree).unwrap();
    fx.library.deactivate_all("release-notes").unwrap();
    assert!(has_line());
}

/// A recorded exclude list that is a real Git exclude list, but of an unrelated repository
/// nobody's checkout uses, is never edited once the activation's checkout is gone.
#[test]
fn another_repositorys_exclude_list_in_a_record_is_never_edited() {
    let fx = Fixture::new();
    let root = fx.repo();
    let other = fx.base.join("other");
    fs::create_dir_all(&other).unwrap();
    assert!(Command::new("git").args(["init", "-q"]).current_dir(&other).status().unwrap().success());
    let victim = other.join(".git/info/exclude").canonicalize().unwrap();
    fs::write(&victim, "keep\n/.claude/skills/release-notes/\n").unwrap();
    fx.import(Kind::Skill, &fx.folder("release-notes", &[("SKILL.md", SKILL)]));
    fx.library.activate("release-notes", "claude", Scope::Project, Some(&root), false).unwrap();
    let mut meta = fx.library.load("release-notes").unwrap();
    meta.activations[0].exclude_list = Some(victim.to_string_lossy().into_owned());
    fx.library.save(&meta).unwrap();
    fs::remove_dir_all(&root).unwrap();
    fx.library.deactivate("release-notes", "claude", Scope::Project, Some(&root)).unwrap();
    assert_eq!(fs::read_to_string(&victim).unwrap(), "keep\n/.claude/skills/release-notes/\n");
}
