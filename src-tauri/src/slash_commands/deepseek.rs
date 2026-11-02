//! DeepSeek Harness skill discovery for the slash menu. dsh's ACP endpoint
//! publishes no command frames (probed on 0.2.1-rc.2), but its skill stack
//! scans fixed filesystem roots and expands a whitespace-bounded `/name`
//! token naming a user-invocable skill in a prompt. The catalog mirrors those
//! roots and offers each skill as a native command, so picking one sends
//! `/name [instructions]` and dsh injects the skill's own instructions.
//! Custom skill directories configured in a dsh profile are not scanned.
use super::{Catalog, Invocation, SlashCommand};
use std::{
    collections::BTreeMap,
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
};

const MAX_SKILLS: usize = 300;
const MAX_SCANNED: usize = 1200;
const MAX_NAME: usize = 64;
// dsh caps its own skill catalog descriptions at 500 characters.
const MAX_DESCRIPTION: usize = 500;
const MAX_FRONTMATTER: usize = 8 * 1024;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Scope {
    Project,
    User,
    Bundled,
}

impl Scope {
    fn label(self) -> &'static str {
        match self {
            Scope::Project => "project",
            Scope::User => "user",
            Scope::Bundled => "bundled",
        }
    }
}

pub fn discover(cwd: &Path) -> Result<Catalog, String> {
    Ok(scan(&roots(
        cwd,
        home_dir().as_deref(),
        env_path("DSH_HOME").as_deref(),
        env_path("DSH_AGENTS_HOME").as_deref(),
        env_path("DSH_BUNDLED_SKILL_DIR").as_deref(),
    )))
}

/// Roots in dsh-skill-filesystem's rank order; the first root holding a name wins.
fn roots(
    cwd: &Path,
    home: Option<&Path>,
    dsh_home: Option<&Path>,
    agents_home: Option<&Path>,
    bundled: Option<&Path>,
) -> Vec<(PathBuf, Scope)> {
    let project = project_root(cwd);
    let mut roots = vec![
        (project.join(".dsh/skills"), Scope::Project),
        (project.join(".agents/skills"), Scope::Project),
    ];
    let Some(home) = home else {
        if let Some(bundled) = bundled {
            roots.push((bundled.to_path_buf(), Scope::Bundled));
        }
        return roots;
    };
    let default_dsh = home.join(".dsh");
    let dsh_home = dsh_home.unwrap_or(default_dsh.as_path());
    roots.push((dsh_home.join("skills"), Scope::User));
    let default_agents = home.join(".agents");
    let agents_home = agents_home.unwrap_or(default_agents.as_path());
    roots.push((agents_home.join("skills"), Scope::User));
    if let Some(bundled) = bundled {
        roots.push((bundled.to_path_buf(), Scope::Bundled));
    }
    roots
}

/// dsh scans the nearest ancestor containing `.git`, else the working directory.
fn project_root(cwd: &Path) -> PathBuf {
    let mut current = cwd.to_path_buf();
    for _ in 0..32 {
        if current.join(".git").exists() {
            return current;
        }
        if !current.pop() {
            break;
        }
    }
    cwd.to_path_buf()
}

fn home_dir() -> Option<PathBuf> {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()
        .map(PathBuf::from)
        .filter(|home| !home.as_os_str().is_empty())
}

fn env_path(key: &str) -> Option<PathBuf> {
    std::env::var(key)
        .ok()
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
}

fn scan(roots: &[(PathBuf, Scope)]) -> Catalog {
    let mut catalog = Catalog::default();
    let mut skills: BTreeMap<String, (PathBuf, Scope, String)> = BTreeMap::new();
    let mut scanned = 0usize;
    let mut invalid = 0usize;
    let mut capped = false;
    'roots: for (root, scope) in roots {
        let Ok(items) = fs::read_dir(root) else {
            continue;
        };
        for item in items.flatten() {
            scanned += 1;
            if scanned > MAX_SCANNED {
                capped = true;
                break 'roots;
            }
            if skills.len() >= MAX_SKILLS {
                capped = true;
                break 'roots;
            }
            let file_name = item.file_name();
            let Some(name) = file_name.to_str() else {
                continue;
            };
            if name.starts_with('.') {
                continue;
            }
            let path = item.path();
            // A skill is a `<name>/SKILL.md` bundle or a flat `<name>.md` at the
            // top level; nested `**/SKILL.md` files are deliberately not skills.
            let file = if path.is_dir() {
                let file = path.join("SKILL.md");
                if !file.is_file() {
                    continue;
                }
                file
            } else if name.to_ascii_lowercase().ends_with(".md") {
                path.clone()
            } else {
                continue;
            };
            match parse(&file) {
                Ok(Some((name, description))) => {
                    // Discovery order must not decide which root wins a name.
                    skills.entry(name).or_insert((path, *scope, description));
                }
                // A skill that deliberately hides from the user is not invalid.
                Ok(None) => {}
                Err(malformed) => invalid += usize::from(malformed),
            }
        }
    }
    for (name, (path, scope, description)) in skills {
        catalog.commands.push(SlashCommand {
            id: skill_id(&name, &path),
            name: format!("/{name}"),
            description,
            argument_hint: Some("[instructions]".into()),
            kind: "prompt".into(),
            source: format!("DeepSeek skill · {}", scope.label()),
            reason: None,
            invocation: Invocation::Native,
        });
    }
    if invalid > 0 {
        catalog
            .warnings
            .push("Some DeepSeek skill files were invalid and were omitted.".into());
    }
    if capped {
        catalog
            .warnings
            .push("The DeepSeek skill folders exceeded the command catalog limit; additional skills were omitted.".into());
    }
    catalog
}

/// `Some((name, description))` from the skill's frontmatter, `None` for a file
/// that is not a user-invocable skill (including `user-invocable: false`),
/// and `Err(true)` for malformed frontmatter worth one generic warning.
fn parse(file: &Path) -> Result<Option<(String, String)>, bool> {
    let Ok(file) = File::open(file) else {
        return Err(false);
    };
    let mut bytes = Vec::new();
    if file.take(MAX_FRONTMATTER as u64).read_to_end(&mut bytes).is_err() {
        return Err(false);
    }
    // Lossy so a cut inside a multi-byte character cannot drop an otherwise valid skill.
    let text = String::from_utf8_lossy(&bytes);
    let Some(rest) = text
        .strip_prefix("---\n")
        .or_else(|| text.strip_prefix("---\r\n"))
    else {
        return Err(false);
    };
    let Some(end) = frontmatter_close(rest) else {
        return Err(true);
    };
    let lines: Vec<&str> = rest[..end].lines().collect();
    let field = |key: &str| {
        lines.iter().position(|line| line.starts_with(key)).map(|at| {
            (at, lines[at][key.len()..].trim())
        })
    };
    // dsh's YAML parser would resolve duplicate keys differently than first-wins,
    // so a skill whose menu name could disagree with dsh's own is dropped.
    if ["name:", "description:", "user-invocable:"]
        .iter()
        .any(|key| lines.iter().filter(|line| line.starts_with(key)).count() > 1)
    {
        return Err(true);
    }
    let invalid_name = |name: &str| {
        name.is_empty()
            || name.len() > MAX_NAME
            || !name.as_bytes()[0].is_ascii_alphanumeric()
            || !name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"_-.".contains(&byte))
    };
    let Some((_, name)) = field("name:") else {
        return Err(true);
    };
    let name = name.trim_matches(['"', '\'']);
    if invalid_name(name) {
        return Err(true);
    }
    let Some((at, description)) = field("description:") else {
        return Err(true);
    };
    // A YAML block scalar (`description: >-`) continues on the indented lines below it.
    let description = if matches!(description, "|" | ">" | "|-" | ">-" | "|+" | ">+") {
        lines[at + 1..]
            .iter()
            .take_while(|line| line.starts_with([' ', '\t']) || line.trim().is_empty())
            .map(|line| line.trim())
            .filter(|line| !line.is_empty())
            .collect::<Vec<_>>()
            .join(" ")
    } else {
        description.trim_matches(['"', '\'']).to_owned()
    };
    if description.is_empty() {
        return Err(true);
    }
    // dsh accepts true/false, yes/no, on/off and 1/0 in any casing; a rejected
    // spelling drops the whole skill rather than permitting a surface silently.
    let user_invocable = match field("user-invocable:").map(|(_, value)| value) {
        Some(value) => match value.to_ascii_lowercase().as_str() {
            "true" | "yes" | "on" | "1" => true,
            "false" | "no" | "off" | "0" => false,
            _ => return Err(true),
        },
        None => true,
    };
    if !user_invocable {
        return Err(false);
    }
    let description: String = description
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(MAX_DESCRIPTION)
        .collect();
    Ok(Some((name.to_owned(), description.trim().to_owned())))
}

/// The closing `---` must sit alone on its line, so a `----` rule or a
/// `--- heading` inside a block scalar stays content instead of ending the
/// frontmatter early.
fn frontmatter_close(rest: &str) -> Option<usize> {
    let mut from = 0;
    while let Some(at) = rest[from..].find("\n---") {
        let at = from + at;
        let after = &rest[at + 4..];
        if after.is_empty() || after.starts_with('\n') || after.starts_with('\r') {
            return Some(at);
        }
        from = at + 4;
    }
    None
}

fn skill_id(name: &str, path: &Path) -> String {
    // Stable FNV-1a identifies the native name/path pair without exposing paths in UI metadata.
    let mut hash = 0xcbf29ce484222325_u64;
    let path = path.to_string_lossy();
    for byte in name.bytes().chain(std::iter::once(0)).chain(path.bytes()) {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("deepseek:skill:{hash:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, path::Path};

    fn fixture(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "pandacode-deepseek-{name}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn bundle(root: &Path, dir: &str, frontmatter: &str) {
        let path = root.join(dir);
        fs::create_dir_all(&path).unwrap();
        fs::write(path.join("SKILL.md"), frontmatter).unwrap();
    }

    fn flat(root: &Path, file: &str, frontmatter: &str) {
        fs::write(root.join(file), frontmatter).unwrap();
    }

    fn names(catalog: &Catalog) -> Vec<&str> {
        catalog
            .commands
            .iter()
            .map(|command| command.name.as_str())
            .collect()
    }

    #[test]
    fn bundles_and_flat_files_become_native_skill_commands() {
        let project = fixture("project");
        let skills = project.join(".agents/skills");
        bundle(
            &skills,
            "ds-tdd",
            "---\nname: ds-tdd\ndescription: Test-first loop for this repo\n---\nBody.",
        );
        flat(
            &skills,
            "ds-review.md",
            "---\nname: ds-review\ndescription: \"Review a change\"\n---\nBody.",
        );
        let catalog = scan(&[(skills, Scope::Project)]);
        assert_eq!(names(&catalog), ["/ds-review", "/ds-tdd"]);
        let tdd = catalog
            .commands
            .iter()
            .find(|command| command.name == "/ds-tdd")
            .unwrap();
        assert_eq!(tdd.kind, "prompt");
        assert_eq!(tdd.source, "DeepSeek skill · project");
        assert_eq!(tdd.argument_hint.as_deref(), Some("[instructions]"));
        assert!(matches!(tdd.invocation, Invocation::Native));
        assert!(tdd.id.starts_with("deepseek:skill:"));
        assert!(catalog.warnings.is_empty());
        fs::remove_dir_all(project).unwrap();
    }

    #[test]
    fn project_roots_win_over_user_roots_in_rank_order() {
        let project = fixture("rank-project");
        fs::create_dir_all(project.join(".git")).unwrap();
        let dsh_home = fixture("rank-dsh");
        let agents_home = fixture("rank-agents");
        bundle(
            &project.join(".dsh/skills"),
            "deploy",
            "---\nname: deploy\ndescription: project dsh copy\n---",
        );
        bundle(
            &project.join(".agents/skills"),
            "deploy",
            "---\nname: deploy\ndescription: project agents copy\n---",
        );
        bundle(
            &dsh_home.join("skills"),
            "deploy",
            "---\nname: deploy\ndescription: user dsh copy\n---",
        );
        bundle(
            &agents_home.join("skills"),
            "deploy",
            "---\nname: deploy\ndescription: user agents copy\n---",
        );
        let roots = roots(
            &project.join("nested"),
            Some(&dsh_home),
            None,
            Some(&agents_home),
            None,
        );
        // The nearest .git ancestor is the project root, and .dsh/skills outranks .agents/skills.
        assert_eq!(roots[0].0, project.join(".dsh/skills"));
        assert_eq!(roots[1].0, project.join(".agents/skills"));
        let catalog = scan(&roots);
        assert_eq!(names(&catalog), ["/deploy"]);
        assert_eq!(catalog.commands[0].description, "project dsh copy");
        assert_eq!(catalog.commands[0].source, "DeepSeek skill · project");
        fs::remove_dir_all(project).unwrap();
        fs::remove_dir_all(dsh_home).unwrap();
        fs::remove_dir_all(agents_home).unwrap();
    }

    #[test]
    fn user_roots_use_dsh_and_agents_homes_and_honour_their_overrides() {
        let project = fixture("homes-project");
        let dsh_home = fixture("homes-dsh");
        let agents_home = fixture("homes-agents");
        let bundled = fixture("homes-bundled");
        bundle(
            &dsh_home.join("skills"),
            "from-dsh",
            "---\nname: from-dsh\ndescription: dsh home\n---",
        );
        bundle(
            &agents_home.join("skills"),
            "from-agents",
            "---\nname: from-agents\ndescription: agents home\n---",
        );
        bundle(
            &bundled,
            "from-bundled",
            "---\nname: from-bundled\ndescription: bundled\n---",
        );
        let catalog = scan(&roots(
            &project,
            Some(&dsh_home),
            Some(&dsh_home),
            Some(&agents_home),
            Some(&bundled),
        ));
        assert_eq!(
            names(&catalog),
            ["/from-agents", "/from-bundled", "/from-dsh"]
        );
        assert!(catalog
            .commands
            .iter()
            .all(|command| command.source.contains("· user") || command.source.contains("· bundled")));
        fs::remove_dir_all(project).unwrap();
        fs::remove_dir_all(dsh_home).unwrap();
        fs::remove_dir_all(agents_home).unwrap();
        fs::remove_dir_all(bundled).unwrap();
    }

    #[test]
    fn user_invocable_false_and_invalid_booleans_drop_the_skill() {
        let project = fixture("invocable");
        let skills = project.join(".agents/skills");
        bundle(
            &skills,
            "hidden",
            "---\nname: hidden\ndescription: not for the menu\nuser-invocable: false\n---",
        );
        bundle(
            &skills,
            "broken",
            "---\nname: broken\ndescription: bad flag\nuser-invocable: maybe\n---",
        );
        bundle(
            &skills,
            "numeric-off",
            "---\nname: numeric-off\ndescription: false spelling\nuser-invocable: 0\n---",
        );
        for (dir, value) in [
            ("spelled-true", "TRUE"),
            ("spelled-yes", "yes"),
            ("spelled-on", "On"),
            ("spelled-one", "1"),
        ] {
            bundle(
                &skills,
                dir,
                &format!("---\nname: {dir}\ndescription: accepted spelling\nuser-invocable: {value}\n---"),
            );
        }
        let catalog = scan(&[(skills, Scope::Project)]);
        assert_eq!(
            names(&catalog),
            ["/spelled-on", "/spelled-one", "/spelled-true", "/spelled-yes"]
        );
        assert_eq!(catalog.warnings.len(), 1);
        assert!(catalog.warnings[0].contains("invalid"));
        fs::remove_dir_all(project).unwrap();
    }

    #[test]
    fn malformed_frontmatter_is_dropped_and_plain_markdown_stays_quiet() {
        let project = fixture("malformed");
        let skills = project.join(".agents/skills");
        bundle(&skills, "no-description", "---\nname: only-name\n---");
        bundle(&skills, "no-name", "---\ndescription: only description\n---");
        bundle(&skills, "unclosed", "---\nname: unclosed\ndescription: runs on");
        flat(&skills, "README.md", "Ordinary notes, no frontmatter here.");
        let catalog = scan(&[(skills, Scope::Project)]);
        assert!(catalog.commands.is_empty());
        assert_eq!(catalog.warnings.len(), 1);
        assert!(!catalog.warnings[0].contains("README"));
        fs::remove_dir_all(project).unwrap();
    }

    #[test]
    fn invalid_names_never_become_commands() {
        let project = fixture("names");
        let skills = project.join(".agents/skills");
        bundle(&skills, "spaces", "---\nname: has spaces\ndescription: d\n---");
        bundle(&skills, "injected", "---\nname: /etc-passwd\ndescription: d\n---");
        bundle(&skills, "leading", "---\nname: -dash\ndescription: d\n---");
        bundle(&skills, "over", &format!("---\nname: {}\ndescription: d\n---", "x".repeat(65)));
        bundle(&skills, "empty", "---\nname: \"\"\ndescription: d\n---");
        let catalog = scan(&[(skills, Scope::Project)]);
        assert!(catalog.commands.is_empty());
        assert!(!catalog.warnings.is_empty());
        fs::remove_dir_all(project).unwrap();
    }

    #[test]
    fn dot_directories_and_nested_skill_files_are_not_scanned() {
        let project = fixture("nested");
        let skills = project.join(".agents/skills");
        bundle(
            &skills.join(".system"),
            "system-skill",
            "---\nname: system-skill\ndescription: hidden root\n---",
        );
        bundle(
            &skills.join("group/deeper"),
            "deeper",
            "---\nname: deeper\ndescription: nested bundle\n---",
        );
        flat(
            &skills.join("group"),
            "leaf.md",
            "---\nname: leaf\ndescription: nested flat\n---",
        );
        let catalog = scan(&[(skills, Scope::Project)]);
        assert!(catalog.commands.is_empty());
        assert!(catalog.warnings.is_empty());
        fs::remove_dir_all(project).unwrap();
    }

    #[test]
    fn the_catalog_is_bounded_and_descriptions_stay_valid() {
        let project = fixture("bounded");
        let skills = project.join(".agents/skills");
        for index in 0..MAX_SKILLS {
            bundle(
                &skills,
                &format!("skill-{index}"),
                &format!(
                    "---\nname: skill-{index}\ndescription: {}\n---",
                    "🦀".repeat(600)
                ),
            );
        }
        let catalog = scan(&[(skills.clone(), Scope::Project)]);
        assert_eq!(catalog.commands.len(), MAX_SKILLS);
        assert!(catalog
            .commands
            .iter()
            .all(|command| command.description.chars().count() == MAX_DESCRIPTION));
        // A full catalog omits nothing, so no limit warning yet.
        assert!(!catalog.warnings.iter().any(|warning| warning.contains("limit")));
        for index in MAX_SKILLS..MAX_SKILLS + 5 {
            bundle(
                &skills,
                &format!("skill-{index}"),
                &format!("---\nname: skill-{index}\ndescription: extra\n---"),
            );
        }
        let catalog = scan(&[(skills, Scope::Project)]);
        assert_eq!(catalog.commands.len(), MAX_SKILLS);
        assert!(catalog.warnings.iter().any(|warning| warning.contains("limit")));
        fs::remove_dir_all(project).unwrap();
    }

    #[test]
    fn dash_rules_inside_frontmatter_and_duplicate_keys_are_not_offered() {
        let project = fixture("delimiters");
        let skills = project.join(".agents/skills");
        // The `----` rule is frontmatter noise, so the later user-invocable flag still applies.
        bundle(
            &skills,
            "rule-line",
            "---\nname: rule-line\ndescription: d\n----\nuser-invocable: false\n---",
        );
        bundle(
            &skills,
            "duplicated",
            "---\nname: first\ndescription: d\nname: second\n---",
        );
        let catalog = scan(&[(skills, Scope::Project)]);
        assert!(catalog.commands.is_empty());
        assert_eq!(catalog.warnings.len(), 1);
        fs::remove_dir_all(project).unwrap();
    }

    #[test]
    fn a_missing_home_still_scans_the_project_roots() {
        let project = fixture("no-home");
        fs::create_dir_all(project.join(".git")).unwrap();
        bundle(
            &project.join(".agents/skills"),
            "local",
            "---\nname: local\ndescription: project only\n---",
        );
        let catalog = scan(&roots(&project, None, None, None, None));
        assert_eq!(names(&catalog), ["/local"]);
        fs::remove_dir_all(project).unwrap();
    }
}
