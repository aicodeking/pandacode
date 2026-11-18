//! DeepSeek Harness skills for the slash menu. dsh's ACP endpoint publishes no
//! command frames (probed on 0.2.1-rc.2), but its skill stack scans fixed roots
//! and expands a `/name` prompt token naming a user-invocable skill. The menu
//! mirrors those roots and sends `/name [instructions]` natively. Custom skill
//! directories configured in a dsh profile are not scanned.
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
const MAX_FRONTMATTER: u64 = 8 * 1024;

pub fn discover(cwd: &Path) -> Result<Catalog, String> {
    let env = |key| {
        std::env::var_os(key)
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
    };
    Ok(scan(&roots(
        cwd,
        crate::agent_usage_providers::home().as_deref(),
        env("DSH_HOME"),
        env("DSH_AGENTS_HOME"),
    )))
}

/// Roots in dsh-skill-filesystem's rank order (first root holding a name wins),
/// each with its menu scope.
fn roots(
    cwd: &Path,
    home: Option<&Path>,
    dsh_home: Option<PathBuf>,
    agents_home: Option<PathBuf>,
) -> Vec<(PathBuf, &'static str)> {
    let project = project_root(cwd);
    let mut roots = vec![
        (project.join(".dsh/skills"), "project"),
        (project.join(".agents/skills"), "project"),
    ];
    for (custom, default) in [(dsh_home, ".dsh"), (agents_home, ".agents")] {
        if let Some(dir) = custom.or_else(|| home.map(|home| home.join(default))) {
            roots.push((dir.join("skills"), "user"));
        }
    }
    roots
}

/// dsh scans the nearest ancestor containing `.git`, else the working directory.
fn project_root(cwd: &Path) -> PathBuf {
    cwd.ancestors()
        .take(32)
        .find(|dir| dir.join(".git").exists())
        .unwrap_or(cwd)
        .to_path_buf()
}

fn scan(roots: &[(PathBuf, &str)]) -> Catalog {
    let mut skills: BTreeMap<String, (PathBuf, &str, String)> = BTreeMap::new();
    let (mut scanned, mut invalid, mut capped) = (0usize, false, false);
    'roots: for (root, scope) in roots {
        let Ok(items) = fs::read_dir(root) else {
            continue;
        };
        for item in items.flatten() {
            scanned += 1;
            if scanned > MAX_SCANNED || skills.len() >= MAX_SKILLS {
                capped = true;
                break 'roots;
            }
            let name = item.file_name();
            let Some(name) = name.to_str().filter(|name| !name.starts_with('.')) else {
                continue;
            };
            // A `<name>/SKILL.md` bundle or a flat `<name>.md` at the top level only.
            let path = item.path();
            let file = if path.is_dir() {
                path.join("SKILL.md")
            } else if name.to_ascii_lowercase().ends_with(".md") {
                path.clone()
            } else {
                continue;
            };
            if !file.is_file() {
                continue;
            }
            match parse(&file) {
                Ok(Some((name, description))) => {
                    skills.entry(name).or_insert((path, scope, description));
                }
                Ok(None) => {}
                Err(()) => invalid = true,
            }
        }
    }
    let mut catalog = Catalog::default();
    for (name, (path, scope, description)) in skills {
        catalog.commands.push(SlashCommand {
            id: super::hashed_id("deepseek:skill", &name, &path.to_string_lossy()),
            name: format!("/{name}"),
            description,
            argument_hint: Some("[instructions]".into()),
            kind: "prompt".into(),
            source: format!("DeepSeek skill · {scope}"),
            reason: None,
            invocation: Invocation::Native,
        });
    }
    if invalid {
        catalog
            .warnings
            .push("Some DeepSeek skill files were invalid and were omitted.".into());
    }
    if capped {
        catalog.warnings.push(
            "The DeepSeek skill folders exceeded the command catalog limit; additional skills were omitted."
                .into(),
        );
    }
    catalog
}

/// `Some((name, description))` for a user-invocable skill, `None` for a file that
/// is not one (no frontmatter, unreadable, `user-invocable: false`), and `Err`
/// for malformed frontmatter worth one generic warning.
fn parse(file: &Path) -> Result<Option<(String, String)>, ()> {
    let mut bytes = Vec::new();
    let Ok(file) = File::open(file) else {
        return Ok(None);
    };
    if file.take(MAX_FRONTMATTER).read_to_end(&mut bytes).is_err() {
        return Ok(None);
    }
    // Lossy so a cut inside a multi-byte character cannot drop a valid skill.
    let text = String::from_utf8_lossy(&bytes);
    let Some(rest) = text
        .strip_prefix("---\n")
        .or_else(|| text.strip_prefix("---\r\n"))
    else {
        return Ok(None);
    };
    let end = frontmatter_close(rest).ok_or(())?;
    let lines: Vec<&str> = rest[..end].lines().collect();
    let keys = ["name:", "description:", "user-invocable:"];
    // dsh's YAML parser would not resolve duplicate keys first-wins, so drop them.
    if keys
        .iter()
        .any(|key| lines.iter().filter(|line| line.starts_with(key)).count() > 1)
    {
        return Err(());
    }
    let field = |key: &str| {
        let at = lines.iter().position(|line| line.starts_with(key))?;
        Some((at, lines[at][key.len()..].trim()))
    };
    let name = field("name:").ok_or(())?.1.trim_matches(['"', '\'']);
    if name.is_empty()
        || name.len() > MAX_NAME
        || !name.as_bytes()[0].is_ascii_alphanumeric()
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_-.".contains(&byte))
    {
        return Err(());
    }
    let (at, description) = field("description:").ok_or(())?;
    // A YAML block scalar (`description: >-`) continues on the indented lines below.
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
    // dsh accepts these spellings in any casing; anything else drops the skill.
    match field("user-invocable:")
        .map(|(_, value)| value.to_ascii_lowercase())
        .as_deref()
    {
        None | Some("true" | "yes" | "on" | "1") => {}
        Some("false" | "no" | "off" | "0") => return Ok(None),
        Some(_) => return Err(()),
    }
    let description: String = description
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(MAX_DESCRIPTION)
        .collect();
    let description = description.trim();
    if description.is_empty() {
        return Err(());
    }
    Ok(Some((name.to_owned(), description.to_owned())))
}

/// The closing `---` must sit alone on its line, so a `----` rule stays content.
fn frontmatter_close(rest: &str) -> Option<usize> {
    let mut from = 0;
    while let Some(at) = rest[from..].find("\n---") {
        let at = from + at;
        let after = &rest[at + 4..];
        if after.is_empty() || after.starts_with(['\n', '\r']) {
            return Some(at);
        }
        from = at + 4;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "pandacode-deepseek-{name}-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn bundle(root: &Path, dir: &str, frontmatter: &str) {
        fs::create_dir_all(root.join(dir)).unwrap();
        fs::write(root.join(dir).join("SKILL.md"), frontmatter).unwrap();
    }

    fn skill(name: &str, extra: &str) -> String {
        format!("---\nname: {name}\ndescription: {name} skill\n{extra}---\nBody.")
    }

    fn names(catalog: &Catalog) -> Vec<&str> {
        catalog.commands.iter().map(|c| c.name.as_str()).collect()
    }

    #[test]
    fn bundles_and_flat_files_become_native_commands_in_rank_order() {
        let project = fixture("project");
        fs::create_dir_all(project.join(".git")).unwrap();
        let (dsh, agents) = (fixture("dsh"), fixture("agents"));
        let skills = project.join(".agents/skills");
        bundle(
            &skills,
            "ds-tdd",
            "---\nname: ds-tdd\ndescription: >-\n  Test-first\n  loop\n---",
        );
        fs::write(
            skills.join("ds-review.md"),
            "---\nname: ds-review\ndescription: \"Review\"\n---",
        )
        .unwrap();
        fs::write(skills.join("README.md"), "Notes, no frontmatter.").unwrap();
        bundle(&skills.join("group"), "nested", &skill("nested", ""));
        bundle(
            &project.join(".dsh/skills"),
            "deploy",
            "---\nname: deploy\ndescription: project copy\n---",
        );
        bundle(
            &dsh.join("skills"),
            "deploy",
            "---\nname: deploy\ndescription: user copy\n---",
        );
        bundle(
            &agents.join("skills"),
            "from-agents",
            &skill("from-agents", ""),
        );
        let catalog = scan(&roots(
            &project.join("nested/dir"),
            None,
            Some(dsh.clone()),
            Some(agents.clone()),
        ));
        assert_eq!(
            names(&catalog),
            ["/deploy", "/ds-review", "/ds-tdd", "/from-agents"]
        );
        let by = |n: &str| catalog.commands.iter().find(|c| c.name == n).unwrap();
        assert_eq!(by("/deploy").description, "project copy");
        assert_eq!(by("/ds-tdd").description, "Test-first loop");
        assert_eq!(by("/from-agents").source, "DeepSeek skill · user");
        assert!(matches!(by("/ds-tdd").invocation, Invocation::Native));
        assert!(by("/ds-tdd").id.starts_with("deepseek:skill:"));
        assert!(catalog.warnings.is_empty(), "{:?}", catalog.warnings);
        for dir in [project, dsh, agents] {
            fs::remove_dir_all(dir).unwrap();
        }
    }

    #[test]
    fn hidden_malformed_and_unsafe_skills_never_become_commands() {
        let project = fixture("invalid");
        let skills = project.join(".agents/skills");
        bundle(
            &skills,
            "hidden",
            &skill("hidden", "user-invocable: false\n"),
        );
        bundle(&skills, "zero", &skill("zero", "user-invocable: 0\n"));
        bundle(
            &skills,
            "rule",
            &skill("rule", "----\nuser-invocable: off\n"),
        );
        bundle(&skills, "on", &skill("on", "user-invocable: On\n"));
        bundle(&skills, "maybe", &skill("maybe", "user-invocable: maybe\n"));
        bundle(
            &skills,
            "dup",
            "---\nname: first\ndescription: d\nname: second\n---",
        );
        bundle(&skills, "no-desc", "---\nname: no-desc\n---");
        bundle(&skills, "unclosed", "---\nname: unclosed\ndescription: d");
        bundle(
            &skills,
            "spaces",
            "---\nname: has spaces\ndescription: d\n---",
        );
        bundle(
            &skills,
            "slash",
            "---\nname: /etc-passwd\ndescription: d\n---",
        );
        bundle(&skills, "long", &skill(&"x".repeat(65), ""));
        let catalog = scan(&[(skills, "project")]);
        assert_eq!(names(&catalog), ["/on"]);
        assert_eq!(catalog.warnings.len(), 1);
        fs::remove_dir_all(project).unwrap();
    }

    #[test]
    fn the_catalog_and_descriptions_are_bounded() {
        let project = fixture("bounded");
        let skills = project.join(".agents/skills");
        for index in 0..=MAX_SKILLS {
            let name = format!("skill-{index}");
            bundle(
                &skills,
                &name,
                &format!("---\nname: {name}\ndescription: {}\n---", "🦀".repeat(600)),
            );
        }
        let catalog = scan(&[(skills, "project")]);
        assert_eq!(catalog.commands.len(), MAX_SKILLS);
        assert!(catalog
            .commands
            .iter()
            .all(|c| c.description.chars().count() == MAX_DESCRIPTION));
        assert!(catalog.warnings.iter().any(|w| w.contains("limit")));
        fs::remove_dir_all(project).unwrap();
    }
}
