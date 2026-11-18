//! OpenCode agents a skill deny must reach: built-ins plus agents defined in config files and
//! agent Markdown files. OpenCode (1.19) loads `{agent,agents}/**/*.md` (a nested file is the
//! agent `sub/name`) and `{mode,modes}/*.md` from every config directory, then merges
//! `OPENCODE_CONFIG_CONTENT` on top of all of them, so a deny written for each agent it could
//! run wins, including over an agent whose Markdown allows skills itself.
use super::*;

/// Primary and subagent built-ins (OpenCode 1.x: build, plan, general, explore).
const BUILTIN: [&str; 4] = ["build", "plan", "general", "explore"];
const MAX_AGENTS: usize = 256;
const MAX_LEVELS: usize = 32;
const CONFIG_FILES: [&str; 3] = ["opencode.json", "opencode.jsonc", "config.json"];
/// Agent folders are read recursively, mode folders only at their top level, like OpenCode.
const AGENT_FOLDERS: [(&str, bool); 4] = [
    ("agent", true),
    ("agents", true),
    ("mode", false),
    ("modes", false),
];
const MAX_DEPTH: usize = 8;

/// The agents found, and whether that is every agent OpenCode could run. It is not when the
/// agent limit or a folder's file budget ran out, or a defined agent's name could not be used.
pub(super) struct Agents {
    pub(super) names: BTreeSet<String>,
    pub(super) complete: bool,
}

pub(super) fn agents(cwd: &Path, home: &Path, homes: &Homes) -> Agents {
    let mut names: BTreeSet<String> = BUILTIN.iter().map(|n| (*n).to_owned()).collect();
    let mut complete = true;
    let mut add = |name: Option<&str>| match name {
        Some(name) if names.contains(name) => {}
        Some(name) if names.len() < MAX_AGENTS && valid(name) => {
            names.insert(name.to_owned());
        }
        _ => complete = false,
    };
    let mut config_dirs = vec![homes
        .xdg_config
        .clone()
        .filter(|p| p.is_absolute())
        .unwrap_or_else(|| home.join(".config"))
        .join("opencode")];
    config_dirs.extend(
        homes
            .configured
            .get("opencode")
            .into_iter()
            .flatten()
            .cloned(),
    );
    config_dirs.push(home.join(".opencode"));
    config_dirs.extend(
        std::env::var_os("OPENCODE_CONFIG_DIR")
            .map(PathBuf::from)
            .filter(|p| p.is_absolute()),
    );
    for dir in &config_dirs {
        read_dir_agents(dir, &mut add);
    }
    if let Some(file) = std::env::var_os("OPENCODE_CONFIG").map(PathBuf::from) {
        config_agents(&file, &mut add);
    }
    // Project configs from the task folder up to its repository root.
    for dir in cwd.ancestors().take(MAX_LEVELS) {
        for file in CONFIG_FILES.iter().take(2) {
            config_agents(&dir.join(file), &mut add);
        }
        read_dir_agents(&dir.join(".opencode"), &mut add);
        if dir.join(".git").exists() || dir == home {
            break;
        }
    }
    Agents { names, complete }
}

fn read_dir_agents(dir: &Path, add: &mut impl FnMut(Option<&str>)) {
    for file in CONFIG_FILES {
        config_agents(&dir.join(file), add);
    }
    for (folder, nested) in AGENT_FOLDERS {
        let mut budget = MAX_AGENTS;
        markdown_agents(&dir.join(folder), "", nested, 0, &mut budget, add);
    }
}

/// Agent names from Markdown files: the path below the folder without `.md`, `/`-separated.
fn markdown_agents(
    dir: &Path,
    prefix: &str,
    nested: bool,
    depth: usize,
    budget: &mut usize,
    add: &mut impl FnMut(Option<&str>),
) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if *budget == 0 {
            // Files left unread may define agents: the denies can't be known to reach them.
            add(None);
            return;
        }
        *budget -= 1;
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            // A name that isn't UTF-8 may still be an agent (`*.md`) OpenCode loads.
            add(None);
            continue;
        };
        // OpenCode follows links, so a linked folder or file counts as what it points at.
        if path.is_dir() {
            if nested && depth < MAX_DEPTH {
                markdown_agents(
                    &path,
                    &format!("{prefix}{name}/"),
                    nested,
                    depth + 1,
                    budget,
                    add,
                );
            }
        } else if let Some(stem) = name.strip_suffix(".md") {
            add(Some(&format!("{prefix}{stem}")));
        }
    }
}

fn config_agents(file: &Path, add: &mut impl FnMut(Option<&str>)) {
    let Some(text) = read_text(file) else {
        return;
    };
    let Ok(value) =
        serde_json::from_str::<serde_json::Value>(&crate::vsix_themes::strip_jsonc(&text))
    else {
        return;
    };
    for key in ["agent", "mode"] {
        for name in value[key].as_object().into_iter().flat_map(|m| m.keys()) {
            add(Some(name));
        }
    }
}

fn valid(name: &str) -> bool {
    !name.is_empty() && name.len() <= 128 && !name.chars().any(char::is_control)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::skill_manager::tests::Fixture;
    #[test]
    fn skill_manager_opencode_agents_include_builtins_config_and_nested_markdown_agents() {
        let f = Fixture::new();
        let home = f.0.join("home");
        let repo = f.0.join("repo");
        let cwd = repo.join("packages/app");
        fs::create_dir_all(repo.join(".git")).unwrap();
        fs::create_dir_all(cwd.join(".opencode/agent")).unwrap();
        fs::create_dir_all(home.join(".config/opencode/agents")).unwrap();
        fs::write(cwd.join(".opencode/agent/reviewer.md"), "---\n---").unwrap();
        fs::create_dir_all(cwd.join(".opencode/agents/team/deep")).unwrap();
        fs::write(cwd.join(".opencode/agents/team/deep/auditor.md"), "x").unwrap();
        fs::create_dir_all(cwd.join(".opencode/mode/nested")).unwrap();
        fs::write(cwd.join(".opencode/mode/nested/ignored.md"), "x").unwrap();
        fs::write(home.join(".config/opencode/agents/global-writer.md"), "x").unwrap();
        fs::write(
            home.join(".config/opencode/opencode.json"),
            r#"{"agent":{"from-global":{}}}"#,
        )
        .unwrap();
        fs::write(
            repo.join("opencode.jsonc"),
            "{ // comment\n \"agent\": {\"from-project\": {}}, \"mode\": {\"legacy\": {}} }",
        )
        .unwrap();
        let found = agents(&cwd, &home, &Homes::default());
        assert!(found.complete);
        let names = found.names;
        for name in [
            "build",
            "plan",
            "general",
            "explore",
            "reviewer",
            "global-writer",
            "from-global",
            "from-project",
            "legacy",
            "team/deep/auditor",
        ] {
            assert!(names.contains(name), "{name}: {names:?}");
        }
        // Like OpenCode, mode folders are not nested.
        assert!(!names.contains("nested/ignored"), "{names:?}");
    }

    #[test]
    fn skill_manager_opencode_agents_report_incomplete_past_the_limit_or_for_unusable_names() {
        let f = Fixture::new();
        let home = f.0.join("home");
        let cwd = f.0.join("repo");
        fs::create_dir_all(cwd.join(".git")).unwrap();
        fs::create_dir_all(cwd.join(".opencode/agents")).unwrap();
        assert!(agents(&cwd, &home, &Homes::default()).complete);
        // A defined agent whose name can't carry a deny.
        fs::write(
            cwd.join("opencode.json"),
            r#"{"agent":{"fine":{},"bad\u0001name":{}}}"#,
        )
        .unwrap();
        let found = agents(&cwd, &home, &Homes::default());
        assert!(found.names.contains("fine"));
        assert!(!found.complete);
        fs::remove_file(cwd.join("opencode.json")).unwrap();
        // More agent files than one folder's budget.
        for index in 0..=MAX_AGENTS {
            fs::write(cwd.join(format!(".opencode/agents/a{index}.md")), "x").unwrap();
        }
        let found = agents(&cwd, &home, &Homes::default());
        assert!(!found.complete);
        assert!(found.names.len() <= MAX_AGENTS);
    }
}
