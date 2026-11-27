//! OpenCode agents a skill deny must reach: built-ins plus agents defined in config files and
//! agent Markdown files. OpenCode (1.19) loads `{agent,agents}/**/*.md` (a nested file is the
//! agent `sub/name`) and `{mode,modes}/*.md` from every config directory, then merges
//! `OPENCODE_CONFIG_CONTENT` on top of all of them, so a deny written for each agent it could
//! run wins, including over an agent whose Markdown allows skills itself.
use super::*;
use super::enforcement::{discover_opencode_config, OpenCodeToolDenies};

/// Primary and subagent built-ins (OpenCode 1.x/2.x: build, plan, general, explore).
pub(super) const BUILTIN: [&str; 4] = ["build", "plan", "general", "explore"];
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
    pub(super) denied_tools: OpenCodeToolDenies,
}

/// Effective launch paths: `None` also represents an explicit environment removal.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct OpenCodeEnv {
    pub(crate) config: Option<PathBuf>,
    pub(crate) config_dir: Option<PathBuf>,
    pub(crate) xdg_config: Option<PathBuf>,
}

impl OpenCodeEnv {
    pub(crate) fn from_environment(read: impl Fn(&str) -> Option<std::ffi::OsString>) -> Self {
        Self {
            config: read("OPENCODE_CONFIG").map(PathBuf::from),
            config_dir: read("OPENCODE_CONFIG_DIR").map(PathBuf::from),
            xdg_config: read("XDG_CONFIG_HOME").map(PathBuf::from),
        }
    }
}

pub(super) fn agents(cwd: &Path, home: &Path, homes: &Homes) -> Agents {
    agents_opt(Some(cwd), home, homes)
}

pub(super) fn agents_opt(cwd: Option<&Path>, home: &Path, homes: &Homes) -> Agents {
    let mut env = OpenCodeEnv::from_environment(|name| std::env::var_os(name));
    env.xdg_config = homes.xdg_config.clone();
    agents_with_env(cwd, Some(home), homes, &env)
}

pub(super) fn agents_with_env(
    cwd: Option<&Path>,
    home: Option<&Path>,
    homes: &Homes,
    env: &OpenCodeEnv,
) -> Agents {
    let mut names: BTreeSet<String> = BUILTIN.iter().map(|n| (*n).to_owned()).collect();
    let mut complete = true;
    let mut denied_tools = OpenCodeToolDenies::default();
    let mut add = |name: Option<&str>| match name {
        Some(name) if names.contains(name) => {}
        Some(name) if names.len() < MAX_AGENTS && valid(name) => {
            names.insert(name.to_owned());
        }
        _ => complete = false,
    };
    let xdg_config = env
        .xdg_config
        .as_ref()
        .filter(|p| p.is_absolute())
        .cloned()
        .or_else(|| home.map(|home| home.join(".config")));
    let config_dirs = xdg_config
        .map(|dir| dir.join("opencode"))
        .into_iter()
        .chain(home.map(|home| home.join(".opencode")))
        .chain(env.config_dir.iter().map(|dir| resolved(cwd, dir)));
    for dir in config_dirs {
        read_dir_agents(&dir, &mut add, &mut denied_tools);
    }
    // Other saved connections contribute agent names for Skills, but their permission
    // rules only apply when their directory is part of this launch's effective paths.
    let mut other_denies = OpenCodeToolDenies::default();
    for dir in homes.configured.get("opencode").into_iter().flatten() {
        read_dir_agents(dir, &mut add, &mut other_denies);
    }
    if let Some(file) = &env.config {
        config_agents(&resolved(cwd, file), &mut add, &mut denied_tools);
    }
    // Project configs from the task folder up to its repository root.
    if let Some(cwd) = cwd {
        for dir in cwd.ancestors().take(MAX_LEVELS) {
            for file in CONFIG_FILES.iter().take(2) {
                config_agents(&dir.join(file), &mut add, &mut denied_tools);
            }
            read_dir_agents(&dir.join(".opencode"), &mut add, &mut denied_tools);
            if dir.join(".git").exists() || Some(dir) == home {
                break;
            }
        }
    }
    Agents { names, complete, denied_tools }
}

fn resolved(cwd: Option<&Path>, path: &Path) -> PathBuf {
    cwd.map_or_else(|| path.to_path_buf(), |cwd| cwd.join(path))
}

fn read_dir_agents(
    dir: &Path,
    add: &mut impl FnMut(Option<&str>),
    denied: &mut OpenCodeToolDenies,
) {
    for file in CONFIG_FILES {
        config_agents(&dir.join(file), add, denied);
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

fn config_agents(file: &Path, add: &mut impl FnMut(Option<&str>), denied: &mut OpenCodeToolDenies) {
    if let Some(text) = read_text(file) {
        discover_opencode_config(&text, add, denied);
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
    fn skill_manager_opencode_agents_use_effective_paths_and_keep_configured_homes() {
        let f = Fixture::new();
        let home = f.0.join("home");
        let repo = f.0.join("repo");
        let xdg = f.0.join("launch-xdg");
        let dir = f.0.join("launch-config-dir");
        let saved_home = f.0.join("saved-config-dir");
        let old_xdg = f.0.join("old-xdg");
        fs::create_dir_all(repo.join(".git")).unwrap();
        for (folder, name) in [
            (xdg.join("opencode"), "from-launch-xdg"),
            (dir.clone(), "from-launch-dir"),
            (saved_home.clone(), "from-configured-home"),
            (old_xdg.join("opencode"), "from-old-xdg"),
            (home.join(".config/opencode"), "from-default-home"),
        ] {
            fs::create_dir_all(folder.join("agents")).unwrap();
            fs::write(folder.join("agents").join(format!("{name}.md")), "Review").unwrap();
        }
        fs::write(repo.join("launch.json"), r#"{"agents":{"from-launch-file":{}}}"#).unwrap();
        let mut homes = Homes { xdg_config: Some(old_xdg), ..Default::default() };
        // Homes::for_scan contributes saved provider/connection homes; keep their coverage.
        homes.configured.insert("opencode".into(), vec![saved_home]);
        let env = OpenCodeEnv { config: Some("launch.json".into()), config_dir: Some(dir), xdg_config: Some(xdg) };
        let found = agents_with_env(Some(&repo), Some(&home), &homes, &env);
        assert!(found.complete);
        for name in ["from-launch-xdg", "from-launch-dir", "from-launch-file", "from-configured-home"] {
            assert!(found.names.contains(name), "{name}: {:?}", found.names);
        }
        assert!(!found.names.contains("from-old-xdg"));
        // Explicitly absent effective paths don't fall back to the scanner's primary XDG home.
        let removed = agents_with_env(Some(&repo), Some(&home), &homes, &OpenCodeEnv::default());
        assert!(removed.complete);
        for name in ["from-launch-xdg", "from-launch-dir", "from-launch-file", "from-old-xdg"] {
            assert!(!removed.names.contains(name), "{name}: {:?}", removed.names);
        }
        assert!(removed.names.contains("from-default-home"));
        assert!(removed.names.contains("from-configured-home"));
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

    #[test]
    fn skill_manager_opencode_agents_discover_v2_agents_keys() {
        let f = Fixture::new();
        let home = f.0.join("home");
        let repo = f.0.join("repo");
        let cwd = repo.join("packages/web");
        fs::create_dir_all(repo.join(".git")).unwrap();
        fs::create_dir_all(&cwd).unwrap();
        fs::create_dir_all(home.join(".config/opencode")).unwrap();
        fs::write(
            home.join(".config/opencode/opencode.json"),
            r#"{"agents":{"global-v2":{"permissions":[{"action":"*","resource":"*","effect":"deny"}]}}}"#,
        )
        .unwrap();
        fs::write(
            repo.join("opencode.json"),
            r#"{"agents":{"project-v2":{"permissions":[{"action":"*","resource":"*","effect":"ask"}]}},"agent":{"project-v1":{}},"mode":{"project-mode":{}}}"#,
        )
        .unwrap();
        fs::write(
            cwd.join("opencode.jsonc"),
            "{ // 2.x package agent\n \"agents\": {\"nested-v2\": {}} }",
        )
        .unwrap();

        let found = agents(&cwd, &home, &Homes::default());
        assert!(found.complete);
        for name in [
            "build",
            "plan",
            "general",
            "explore",
            "global-v2",
            "project-v2",
            "project-v1",
            "project-mode",
            "nested-v2",
        ] {
            assert!(found.names.contains(name), "{name}: {:?}", found.names);
        }

        // User-only scan (no cwd) still discovers built-ins and global 2.x `agents`, skipping project files.
        let user_only = agents_opt(None, &home, &Homes::default());
        assert!(user_only.complete);
        for name in ["build", "plan", "general", "explore", "global-v2"] {
            assert!(
                user_only.names.contains(name),
                "{name}: {:?}",
                user_only.names
            );
        }
        assert!(!user_only.names.contains("project-v2"), "{:?}", user_only.names);
    }

    #[test]
    fn skill_manager_opencode_agents_scrub_env_file_tokens_and_mark_invalid_json_incomplete() {
        let f = Fixture::new();
        let home = f.0.join("home");
        let repo = f.0.join("repo");
        fs::create_dir_all(repo.join(".git")).unwrap();
        fs::create_dir_all(home.join(".config/opencode")).unwrap();

        // Valid JSONC on disk containing unquoted `{env:...}` and `{file:...}` tokens discovers
        // custom 1.x `agent` and 2.x `agents` cleanly with `complete = true`.
        fs::write(
            repo.join("opencode.jsonc"),
            r#"{
                // project config with OpenCode substitutions
                "provider": {"work": {"options": {"timeout": {env:TIMEOUT}, "cert": {file:./cert.pem}}}},
                "agent": {"from-v1": {"temperature": {env:TEMP}}},
                "agents": {"from-v2": {"system": {file:./prompt.md}}},
            }"#,
        )
        .unwrap();
        let found = agents(&repo, &home, &Homes::default());
        assert!(found.complete, "env/file tokens should not mark scan incomplete");
        assert!(found.names.contains("from-v1"), "{:?}", found.names);
        assert!(found.names.contains("from-v2"), "{:?}", found.names);

        // Unquoted token standing in for the whole `agents` map cannot be enumerated statically.
        fs::write(
            repo.join("opencode.jsonc"),
            r#"{"agents": {file:./agents.json}}"#,
        )
        .unwrap();
        let opaque_map = agents(&repo, &home, &Homes::default());
        assert!(!opaque_map.complete, "opaque agents map must set complete = false");

        // Genuinely unparseable JSON on disk must set `complete = false` rather than staying true.
        fs::write(repo.join("opencode.jsonc"), r#"{"agents": {"broken": "#).unwrap();
        let broken = agents(&repo, &home, &Homes::default());
        assert!(!broken.complete, "invalid JSON must set complete = false");

        // Non-object JSON root on disk also marks `complete = false`.
        fs::write(repo.join("opencode.jsonc"), "[]").unwrap();
        let non_object = agents(&repo, &home, &Homes::default());
        assert!(!non_object.complete, "non-object JSON must set complete = false");
    }
}
