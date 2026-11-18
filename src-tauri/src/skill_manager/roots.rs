use std::path::{Path, PathBuf};

#[derive(Default)]
pub(crate) struct Homes {
    pub claude: Option<PathBuf>,
    pub codex: Option<PathBuf>,
    pub xdg_config: Option<PathBuf>,
    pub pi: Option<PathBuf>,
    pub grok: Option<PathBuf>,
    pub hermes: Option<PathBuf>,
    pub configured: std::collections::BTreeMap<String, Vec<PathBuf>>,
    /// Task worktrees by project ID; their project skill roots are attributed to the project.
    pub worktrees: Vec<(String, PathBuf)>,
    pub installed: Option<std::collections::BTreeSet<String>>,
    pub projects: Vec<(String, PathBuf)>,
    pub not_shown: usize,
}
impl Homes {
    pub(crate) fn from_env() -> Self {
        Self::from_environment(|name| std::env::var(name).ok())
    }
    fn from_environment(read: impl Fn(&str) -> Option<String>) -> Self {
        let path = |name| {
            read(name)
                .map(|p| PathBuf::from(p.trim()))
                .filter(|p| p.is_absolute())
        };
        let mut homes = Self {
            claude: path("CLAUDE_CONFIG_DIR"),
            codex: path("CODEX_HOME"),
            xdg_config: path("XDG_CONFIG_HOME"),
            pi: path("PI_CODING_AGENT_DIR"),
            grok: path("GROK_HOME"),
            hermes: path("HERMES_HOME"),
            ..Self::default()
        };
        for (harness, key) in [
            ("opencode", "OPENCODE_CONFIG_DIR"),
            ("kilo", "KILO_CONFIG_DIR"),
        ] {
            if let Some(dir) = path(key) {
                homes.add_home(harness, dir);
            }
        }
        homes
    }
    pub(crate) fn resolved() -> Self {
        let mut homes = Self::for_scan();
        homes.installed = Some(
            crate::providers::PROVIDERS
                .iter()
                .filter(|(id, _)| super::installed(id))
                .map(|(id, _)| (*id).into())
                .collect(),
        );
        homes
    }
    /// Every configured home without probing for executables: enough to find skill folders.
    pub(crate) fn for_scan() -> Self {
        let mut homes = Self::from_env();
        for (id, _) in crate::providers::PROVIDERS {
            for (key, value) in crate::provider_settings::environment(id) {
                homes.add_environment(id, &key, PathBuf::from(value));
            }
            for connection in crate::connections::pool_members(id) {
                for (key, value) in &connection.env {
                    homes.add_environment(id, key, PathBuf::from(value));
                }
                if let Some(dir) = connection.config_dir {
                    // Named account config_dir already is the harness directory, not the XDG base.
                    homes.add_home(id, PathBuf::from(dir));
                }
            }
        }
        homes
    }
    fn add_environment(&mut self, harness: &str, key: &str, dir: PathBuf) {
        let dir = if matches!(key, "GROK_HOME" | "HERMES_HOME") {
            PathBuf::from(dir.to_string_lossy().trim())
        } else {
            dir
        };
        if !dir.is_absolute() {
            return;
        }
        match (harness, key) {
            ("claude" | "glm" | "mimo" | "alibaba", "CLAUDE_CONFIG_DIR")
            | ("codex", "CODEX_HOME")
            | ("opencode", "OPENCODE_CONFIG_DIR")
            | ("pi", "PI_CODING_AGENT_DIR")
            | ("kilo", "KILO_CONFIG_DIR")
            | ("grok", "GROK_HOME")
            | ("hermes", "HERMES_HOME") => self.add_home(harness, dir),
            ("opencode" | "kilo" | "devin" | "muse", "XDG_CONFIG_HOME") => {
                self.add_home(harness, dir.join(harness))
            }
            _ => {}
        }
    }
    pub(super) fn add_home(&mut self, harness: &str, dir: PathBuf) {
        if !dir.is_absolute() {
            return;
        }
        let dirs = self.configured.entry(harness.into()).or_default();
        if !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }
}

pub(super) fn display_path(path: &Path, home: &Path, label: &str) -> String {
    path.strip_prefix(home)
        .map(|p| format!("~/{}", p.to_string_lossy().replace('\\', "/")))
        .unwrap_or_else(|_| label.to_owned())
}

pub(crate) fn skill_roots(
    harness: &str,
    home: &Path,
    project: Option<&Path>,
    homes: &Homes,
) -> Vec<(PathBuf, String)> {
    let mut roots = Vec::new();
    let mut ancestors = Vec::new();
    match harness {
        "claude" | "glm" | "mimo" | "alibaba" => {
            roots.push(if let Some(dir) = &homes.claude {
                (dir.join("skills"), "$CLAUDE_CONFIG_DIR/skills")
            } else {
                (home.join(".claude/skills"), "~/.claude/skills")
            });
            if let Some(project) = project {
                roots.push((project.join(".claude/skills"), ".claude/skills"));
            }
        }
        "codex" => {
            roots.push(if let Some(dir) = &homes.codex {
                (dir.join("skills"), "$CODEX_HOME/skills")
            } else {
                (home.join(".codex/skills"), "~/.codex/skills")
            });
            if let Some(project) = project {
                roots.push((project.join(".agents/skills"), ".agents/skills"));
            }
        }
        "opencode" | "devin" => {
            let config = homes.xdg_config.as_ref().filter(|p| p.is_absolute());
            roots.push((
                config
                    .cloned()
                    .unwrap_or_else(|| home.join(".config"))
                    .join(harness)
                    .join("skills"),
                match (harness, config.is_some()) {
                    ("opencode", true) => "$XDG_CONFIG_HOME/opencode/skills",
                    ("opencode", false) => "~/.config/opencode/skills",
                    (_, true) => "$XDG_CONFIG_HOME/devin/skills",
                    (_, false) => "~/.config/devin/skills",
                },
            ));
            if let Some(project) = project {
                let local = if harness == "opencode" {
                    ".opencode/skills"
                } else {
                    ".devin/skills"
                };
                roots.push((project.join(local), local));
            }
        }
        "kimi" => {
            roots.push((home.join(".kimi-code/skills"), "~/.kimi-code/skills"));
            roots.push((home.join(".kimi/skills"), "~/.kimi/skills"));
            if let Some(project) = project {
                roots.push((project.join(".kimi/skills"), ".kimi/skills"));
            }
        }
        "pi" | "omp" => {
            roots.push(
                if let Some(dir) = homes.pi.as_ref().filter(|p| p.is_absolute()) {
                    (dir.join("skills"), "$PI_CODING_AGENT_DIR/skills")
                } else {
                    (home.join(".pi/agent/skills"), "~/.pi/agent/skills")
                },
            );
            if let Some(project) = project {
                roots.push((project.join(".pi/skills"), ".pi/skills"));
                ancestors = ancestor_agent_roots(project, home);
            }
        }
        "cline" => {
            roots.push((home.join(".cline/skills"), "~/.cline/skills"));
            if let Some(project) = project {
                roots.push((project.join(".cline/skills"), ".cline/skills"));
                roots.push((project.join(".clinerules/skills"), ".clinerules/skills"));
                roots.push((project.join(".claude/skills"), ".claude/skills"));
            }
        }
        "deepseek" => {
            roots.push((home.join(".dsh/skills"), "~/.dsh/skills"));
            roots.push((home.join(".agents/skills"), "~/.agents/skills"));
            if let Some(project) = project {
                roots.push((project.join(".dsh/skills"), ".dsh/skills"));
                roots.push((project.join(".agents/skills"), ".agents/skills"));
            }
        }
        "muse" => {
            // Muse Code discovers project skills in .agents/skills (shared below), not .muse.
            roots.push(
                if let Some(dir) = homes.xdg_config.as_ref().filter(|p| p.is_absolute()) {
                    (dir.join("muse/skills"), "$XDG_CONFIG_HOME/muse/skills")
                } else {
                    (home.join(".config/muse/skills"), "~/.config/muse/skills")
                },
            );
            roots.push((home.join(".claude/skills"), "~/.claude/skills"));
            roots.push(if let Some(dir) = &homes.codex {
                (dir.join("skills"), "$CODEX_HOME/skills")
            } else {
                (home.join(".codex/skills"), "~/.codex/skills")
            });
        }
        "antigravity" => {
            // agy also accepts the visible _agents spelling of its .agents project root.
            if let Some(project) = project {
                roots.push((project.join("_agents/skills"), "_agents/skills"));
            }
            roots.push((
                home.join(".gemini/antigravity/skills"),
                "~/.gemini/antigravity/skills",
            ));
        }
        "kilo" => {
            roots.push((
                homes
                    .xdg_config
                    .as_ref()
                    .filter(|p| p.is_absolute())
                    .cloned()
                    .unwrap_or_else(|| home.join(".config"))
                    .join("kilo/skills"),
                if homes.xdg_config.as_ref().is_some_and(|p| p.is_absolute()) {
                    "$XDG_CONFIG_HOME/kilo/skills"
                } else {
                    "~/.config/kilo/skills"
                },
            ));
            for (dir, label) in [
                (".kilo/skills", "~/.kilo/skills"),
                (".kilocode/skills", "~/.kilocode/skills"),
            ] {
                roots.push((home.join(dir), label));
                if let Some(project) = project {
                    roots.push((project.join(dir), dir));
                }
            }
        }
        "cursor" => {
            // Cursor's CLI also loads the Claude, Codex, Grok and shared agents locations
            // (the shared ones are added below); `skills-cursor` holds its built-ins.
            for (dir, label) in [
                (".cursor/skills", "~/.cursor/skills"),
                (".claude/skills", "~/.claude/skills"),
                (".codex/skills", "~/.codex/skills"),
                (".grok/skills", "~/.grok/skills"),
            ] {
                roots.push((home.join(dir), label));
                if let Some(project) = project {
                    roots.push((project.join(dir), dir));
                }
            }
        }
        "zcode" | "github-copilot" | "commandcode" | "grok" | "hermes" => {
            let (user, display, local) = match harness {
                "zcode" => (".zcode/skills", "~/.zcode/skills", ".zcode/skills"),
                "github-copilot" => (".copilot/skills", "~/.copilot/skills", ".github/skills"),
                "commandcode" => (
                    ".commandcode/skills",
                    "~/.commandcode/skills",
                    ".commandcode/skills",
                ),
                "grok" => (".grok/skills", "~/.grok/skills", ".grok/skills"),
                _ => (".hermes/skills", "~/.hermes/skills", ".hermes/skills"),
            };
            let custom = match harness {
                "grok" => homes.grok.as_ref(),
                "hermes" => homes.hermes.as_ref(),
                _ => None,
            }
            .filter(|p| p.is_absolute());
            roots.push(if let Some(dir) = custom {
                (
                    dir.join("skills"),
                    if harness == "grok" {
                        "$GROK_HOME/skills"
                    } else {
                        "$HERMES_HOME/skills"
                    },
                )
            } else {
                (home.join(user), display)
            });
            if let Some(project) = project {
                roots.push((project.join(local), local));
            }
        }
        _ => {}
    }
    // These harnesses also discover skills installed in the shared agents location.
    if matches!(
        harness,
        "codex"
            | "opencode"
            | "kimi"
            | "pi"
            | "omp"
            | "cline"
            | "kilo"
            | "github-copilot"
            | "antigravity"
            | "muse"
            | "cursor"
    ) {
        roots.push((home.join(".agents/skills"), "~/.agents/skills"));
    }
    if matches!(
        harness,
        "opencode"
            | "kimi"
            | "pi"
            | "omp"
            | "cline"
            | "kilo"
            | "github-copilot"
            | "antigravity"
            | "muse"
            | "cursor"
    ) {
        if let Some(project) = project {
            roots.push((project.join(".agents/skills"), ".agents/skills"));
        }
    }
    if harness == "opencode" {
        roots.push((home.join(".claude/skills"), "~/.claude/skills"));
        if let Some(project) = project {
            roots.push((project.join(".claude/skills"), ".claude/skills"));
        }
    }
    let mut roots: Vec<_> = roots
        .into_iter()
        .map(|(path, display)| (path, display.to_owned()))
        .chain(ancestors)
        .collect();
    if let Some(dirs) = homes.configured.get(harness) {
        let name = crate::providers::PROVIDERS
            .iter()
            .find(|(id, _)| *id == harness)
            .map_or(harness, |(_, name)| *name);
        // A configured home that is one of the roots above (by canonical path, so links and
        // `$VAR` spellings of one folder match) is not listed a second time.
        let real = |path: &Path| std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        let mut seen: std::collections::BTreeSet<PathBuf> =
            roots.iter().map(|(path, _)| real(path)).collect();
        for (i, dir) in dirs.iter().enumerate() {
            let path = dir.join("skills");
            if !seen.insert(real(&path)) {
                continue;
            }
            roots.push((
                path.clone(),
                display_path(&path, home, &format!("{name} account {} · skills", i + 1)),
            ));
        }
    }
    if matches!(harness, "opencode" | "kilo") {
        let legacy: Vec<_> = roots
            .iter()
            .filter_map(|(path, label)| {
                Some((
                    path.parent()?.join("skill"),
                    format!("{}skill", label.strip_suffix("skills")?),
                ))
            })
            .collect();
        roots.extend(legacy);
    }
    if harness == "codex" {
        roots.extend(
            codex_plugins(home, homes)
                .into_iter()
                .map(|(path, display, _)| (path, display)),
        );
    }
    roots
}

/// Pi's collectAncestorAgentsSkillDirs: `.agents/skills` in each folder above the project, up to
/// and including the repository root. Without a repository above it, there are none.
fn ancestor_agent_roots(project: &Path, home: &Path) -> Vec<(PathBuf, String)> {
    if project.join(".git").exists() {
        return Vec::new();
    }
    let mut found = Vec::new();
    let mut label = String::new();
    for dir in project.ancestors().skip(1).take(32) {
        label.push_str("../");
        if dir == home || dir.parent().is_none() {
            break;
        }
        found.push((dir.join(".agents/skills"), format!("{label}.agents/skills")));
        if dir.join(".git").exists() {
            return found;
        }
    }
    Vec::new()
}

pub(super) fn codex_plugins(home: &Path, homes: &Homes) -> Vec<(PathBuf, String, String)> {
    let main = homes
        .codex
        .clone()
        .filter(|p| p.is_absolute())
        .unwrap_or_else(|| home.join(".codex"));
    let mut seen = std::collections::BTreeSet::new();
    std::iter::once(&main)
        .chain(homes.configured.get("codex").into_iter().flatten())
        .filter(|p| seen.insert(super::checkout_key(p)))
        .enumerate()
        .flat_map(|(i, config)| {
            super::plugins::codex_roots(config, home, &format!("Codex account {}", i + 1))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn skill_manager_muse_uses_its_managed_root_and_import_roots() {
        for (env, expected) in [
            (None, PathBuf::from("/home/.config/muse/skills")),
            (
                Some(PathBuf::from("/config")),
                PathBuf::from("/config/muse/skills"),
            ),
        ] {
            let roots = skill_roots(
                "muse",
                Path::new("/home"),
                Some(Path::new("/project")),
                &Homes {
                    xdg_config: env,
                    ..Homes::default()
                },
            );
            for path in [
                expected,
                PathBuf::from("/home/.agents/skills"),
                PathBuf::from("/home/.claude/skills"),
                PathBuf::from("/home/.codex/skills"),
                PathBuf::from("/project/.agents/skills"),
            ] {
                assert!(roots.iter().any(|(p, _)| *p == path), "{path:?}");
            }
        }
    }
    #[test]
    fn skill_manager_custom_config_homes_replace_default_user_roots() {
        let homes = Homes {
            claude: Some(PathBuf::from("/custom/CLAUDE_CONFIG_DIR")),
            codex: Some(PathBuf::from("/custom/CODEX_HOME")),
            ..Homes::default()
        };
        for (harness, var, default) in [
            ("claude", "CLAUDE_CONFIG_DIR", ".claude/skills"),
            ("glm", "CLAUDE_CONFIG_DIR", ".claude/skills"),
            ("mimo", "CLAUDE_CONFIG_DIR", ".claude/skills"),
            ("codex", "CODEX_HOME", ".codex/skills"),
        ] {
            let roots = skill_roots(
                harness,
                Path::new("/home"),
                Some(Path::new("/project")),
                &homes,
            );
            let expected = PathBuf::from(format!("/custom/{var}/skills"));
            assert!(roots.iter().any(|(p, _)| *p == expected), "{harness}");
            assert!(!roots
                .iter()
                .any(|(p, _)| *p == Path::new("/home").join(default)));
        }
    }
}

#[cfg(test)]
mod account_regressions {
    use super::*;

    #[test]
    fn skill_manager_account_homes_are_direct_and_xdg_homes_are_harness_specific() {
        let mut homes = Homes::default();
        for (harness, key) in [
            ("opencode", "OPENCODE_CONFIG_DIR"),
            ("pi", "PI_CODING_AGENT_DIR"),
            ("kilo", "KILO_CONFIG_DIR"),
        ] {
            homes.add_environment(harness, key, PathBuf::from(format!("/accounts/{harness}")));
            homes.add_environment(harness, key, PathBuf::from("relative"));
            homes.add_home(harness, PathBuf::from(format!("/connections/{harness}")));
            let roots = skill_roots(harness, Path::new("/home"), None, &homes);
            for base in ["accounts", "connections"] {
                let expected = format!("/{base}/{harness}/skills");
                assert!(
                    roots.iter().any(|(p, _)| p == Path::new(&expected)),
                    "{roots:?}"
                );
            }
            assert_eq!(homes.configured[harness].len(), 2);
        }
        for harness in ["opencode", "kilo"] {
            homes.add_environment(harness, "XDG_CONFIG_HOME", PathBuf::from("/xdg"));
            let roots = skill_roots(harness, Path::new("/home"), None, &homes);
            for kind in ["skill", "skills"] {
                let expected = format!("/xdg/{harness}/{kind}");
                assert!(roots.iter().any(|(p, _)| p == Path::new(&expected)));
            }
        }
    }

    #[test]
    fn skill_manager_pi_override_and_kilo_xdg_default_have_correct_skill_suffix() {
        let homes = Homes {
            pi: Some("/pi-agent".into()),
            xdg_config: Some("/xdg".into()),
            ..Homes::default()
        };
        let pi = skill_roots("pi", Path::new("/home"), None, &homes);
        assert!(pi.iter().any(|(p, _)| *p == Path::new("/pi-agent/skills")));
        assert!(!pi
            .iter()
            .any(|(p, _)| *p == Path::new("/home/.pi/agent/skills")));
        let kilo = skill_roots("kilo", Path::new("/home"), None, &homes);
        assert!(kilo
            .iter()
            .any(|(p, _)| *p == Path::new("/xdg/kilo/skills")));
        assert!(kilo
            .iter()
            .any(|(p, _)| *p == Path::new("/home/.kilo/skills")));
    }
}

#[cfg(test)]
mod home_override_tests {
    use super::*;
    #[test]
    fn skill_manager_grok_and_hermes_account_homes_match_cli_roots() {
        for (harness, key) in [("grok", "GROK_HOME"), ("hermes", "HERMES_HOME")] {
            let mut homes = Homes::default();
            homes.add_environment(harness, key, "/account".into());
            homes.add_environment(harness, key, " /account ".into());
            homes.add_environment(harness, key, "relative".into());
            let roots = skill_roots(
                harness,
                Path::new("/home"),
                Some(Path::new("/project")),
                &homes,
            );
            assert!(
                roots
                    .iter()
                    .any(|(p, _)| *p == Path::new("/account/skills")),
                "{roots:?}"
            );
            assert!(roots
                .iter()
                .any(|(p, _)| *p == Path::new(&format!("/project/.{harness}/skills"))));
            assert_eq!(homes.configured[harness].len(), 1);
        }
    }
}

#[cfg(test)]
mod behavior_tests {
    use crate::skill_manager::*;
    #[test]
    fn skill_manager_xdg_roots_require_absolute_paths() {
        for (config, expected) in [("/config", "/config"), ("relative", "/home/.config")] {
            let homes = Homes {
                xdg_config: Some(config.into()),
                ..Homes::default()
            };
            for harness in ["opencode", "devin", "muse"] {
                let roots = roots::skill_roots(harness, Path::new("/home"), None, &homes);
                assert!(
                    roots
                        .iter()
                        .any(|(p, _)| *p == Path::new(expected).join(harness).join("skills")),
                    "{harness}: {roots:?}"
                );
            }
        }
    }
}

#[cfg(test)]
mod environment_tests {
    use super::*;
    #[test]
    fn skill_manager_grok_and_hermes_environment_homes_are_trimmed_and_replace_defaults() {
        for harness in ["grok", "hermes"] {
            for value in [" /active ", "relative", "  "] {
                let key = format!("{}_HOME", harness.to_uppercase());
                let homes = Homes::from_environment(|name| (name == key).then(|| value.into()));
                let roots = skill_roots(
                    harness,
                    Path::new("/home"),
                    Some(Path::new("/project")),
                    &homes,
                );
                let expected = if value.trim() == "/active" {
                    PathBuf::from("/active/skills")
                } else {
                    PathBuf::from(format!("/home/.{harness}/skills"))
                };
                assert!(roots.iter().any(|(p, _)| *p == expected), "{roots:?}");
                assert!(roots
                    .iter()
                    .any(|(p, _)| p == Path::new(&format!("/project/.{harness}/skills"))));
                if value.trim() == "/active" {
                    assert!(!roots
                        .iter()
                        .any(|(p, _)| p == Path::new(&format!("/home/.{harness}/skills"))));
                }
            }
        }
    }
    #[test]
    fn skill_manager_muse_and_antigravity_project_roots_match_installed_clis() {
        for harness in ["muse", "antigravity"] {
            let roots = skill_roots(
                harness,
                Path::new("/home"),
                Some(Path::new("/project")),
                &Homes::default(),
            );
            assert!(roots
                .iter()
                .any(|(p, _)| *p == Path::new("/project/.agents/skills")));
            if harness == "antigravity" {
                assert!(roots
                    .iter()
                    .any(|(p, _)| *p == Path::new("/project/_agents/skills")));
            }
        }
    }
}
