use super::*;
use std::time::Duration;
const PACKAGE: &str = "skills@1.7.6";

#[derive(Debug, Serialize)]
pub(crate) struct PreviewSkill {
    #[serde(serialize_with = "safety::serialize_warning")]
    name: String,
    #[serde(serialize_with = "safety::serialize_warning")]
    description: String,
    /// Why this skill can't be added here (its name fails the switch name policy), so the
    /// dialog lists it but never offers it. Omitted for selectable skills; serialized as
    /// `switchable: false` plus `unswitchableReason`, like inventory rows.
    #[serde(rename = "unswitchableReason", skip_serializing_if = "Option::is_none")]
    unswitchable: Option<String>,
    #[serde(skip_serializing_if = "is_true")]
    switchable: bool,
}
fn is_true(value: &bool) -> bool {
    *value
}
/// A listed name is kept to this many characters.
const MAX_PREVIEW_NAME: usize = 256;
const UNSWITCHABLE: &str =
    "PandaCode can't switch a skill with this name, so it can't be added from here.";
#[derive(Debug, Serialize)]
pub(crate) struct Preview {
    #[serde(serialize_with = "safety::serialize_warning")]
    source: String,
    skills: Vec<PreviewSkill>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(serialize_with = "serialize_selection")]
    selected: Option<Vec<String>>,
}

fn serialize_selection<S: serde::Serializer>(
    selected: &Option<Vec<String>>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    selected
        .as_ref()
        .map(|names| {
            names
                .iter()
                .map(|name| safety::redact_warning(name))
                .collect::<Vec<_>>()
        })
        .serialize(serializer)
}

/// A local folder source: an absolute path to an existing folder with a `SKILL.md` or a
/// `skills/` folder. `.`/`..` segments are refused before anything resolves, and the CLI gets
/// the canonical path (links resolved) as one argument. Not a path: `None`.
fn local_source(source: &str) -> Result<Option<String>, String> {
    let windows_drive = source.len() > 2
        && source.as_bytes()[0].is_ascii_alphabetic()
        && source[1..].starts_with(":\\");
    if !(source.starts_with('/') || source.starts_with('\\') || windows_drive) {
        return Ok(None);
    }
    // `\\server\share`, `//server/share`, `\\?\UNC\…` and other `\\?\`/`\\.\` device paths
    // may reach the network: refused before anything resolves them.
    if network_path(source) {
        return Err("Choose a folder on this computer: network folders can't be added.".into());
    }
    let invalid =
        || "Choose an existing folder that contains SKILL.md or a skills folder.".to_string();
    if source.len() > 4096
        || source.chars().any(char::is_control)
        || source
            .split(['/', '\\'])
            .any(|segment| segment == "." || segment == "..")
        || !Path::new(source).is_absolute()
    {
        return Err(invalid());
    }
    let folder = canonical_folder(Path::new(source)).map_err(|_| invalid())?;
    let has_skills = folder.join("SKILL.md").is_file() || folder.join("skills").is_dir();
    if !folder.is_dir() || !has_skills {
        return Err(invalid());
    }
    let folder = folder.to_str().ok_or_else(invalid)?.to_owned();
    // A mapped drive or link can still resolve to a share.
    if network_path(&folder) {
        return Err("Choose a folder on this computer: network folders can't be added.".into());
    }
    if folder.chars().any(char::is_control) || folder.starts_with('-') {
        return Err(invalid());
    }
    Ok(Some(folder))
}

/// A path that starts with two separators (UNC, `//host`, `\\?\` and `\\.\` prefixes).
fn network_path(source: &str) -> bool {
    let mut chars = source.chars();
    matches!(
        (chars.next(), chars.next()),
        (Some('/' | '\\'), Some('/' | '\\'))
    )
}

/// Links resolved; on Windows without the `\\?\` prefix Node's path handling can't read.
fn canonical_folder(path: &Path) -> std::io::Result<PathBuf> {
    #[cfg(windows)]
    return dunce::canonicalize(path);
    #[cfg(not(windows))]
    fs::canonicalize(path)
}

pub(super) fn normalize_source(source: &str) -> Result<(String, Option<Vec<String>>), String> {
    if let Some(folder) = local_source(source)? {
        return Ok((folder, None));
    }
    if source.starts_with("https://skills.sh/") {
        if source.len() > 1024 || source.chars().any(char::is_control) {
            return Err("Invalid skills.sh link.".into());
        }
        let url = reqwest::Url::parse(source).map_err(|_| "Invalid skills.sh link.")?;
        let parts: Vec<_> = url
            .path()
            .trim_end_matches('/')
            .split('/')
            .skip(1)
            .collect();
        if !(2..=3).contains(&parts.len()) {
            return Err("Enter a skills.sh owner/repo or owner/repo/skill link.".into());
        }
        let source = format!("{}/{}", parts[0], parts[1]);
        validate_source(&source)?;
        let selected = if let Some(skill) = parts.get(2) {
            // URL path components stay URI-safe; arbitrary display names can be selected
            // directly in the preview/add payload under the common toggle name policy.
            validate_source(skill)?;
            validate_name(skill)?;
            Some(vec![(*skill).to_string()])
        } else {
            None
        };
        Ok((source, selected))
    } else {
        validate_source(source)?;
        Ok((source.to_owned(), None))
    }
}

pub(super) fn agent_id(harness: &str) -> Option<&'static str> {
    Some(match harness {
        "claude" | "glm" | "mimo" | "alibaba" => "claude-code",
        "codex" => "codex",
        "deepseek" | "muse" => "universal",
        "kimi" => "kimi-code-cli",
        "opencode" => "opencode",
        "antigravity" => "antigravity",
        "pi" | "omp" => "pi",
        "cline" => "cline",
        "kilo" => "kilo",
        "github-copilot" => "github-copilot",
        "commandcode" => "command-code",
        "devin" => "devin",
        "grok" => "grok",
        "hermes" => "hermes-agent",
        "zcode" => "zcode",
        "cursor" => "cursor",
        _ => return None,
    })
}
pub(super) fn add_args(
    source: &str,
    skills: &[String],
    harnesses: &[String],
    global: bool,
) -> Result<Vec<String>, String> {
    let (source, selected) = normalize_source(source)?;
    let skills = if skills.is_empty() {
        selected.as_deref().unwrap_or(skills)
    } else {
        skills
    };
    if harnesses.is_empty() {
        return Err("Choose at least one agent to install skills for.".into());
    }
    let mut agents = Vec::new();
    for harness in harnesses {
        let agent = agent_id(harness)
            .ok_or_else(|| format!("The skills CLI does not support the {harness} harness."))?;
        if !agents.contains(&agent) {
            agents.push(agent);
        }
    }
    for skill in skills {
        validate_name(skill)?;
    }
    let mut args: Vec<String> = ["-y", PACKAGE, "add", &source, "-y", "--json", "--skill"]
        .into_iter()
        .map(str::to_owned)
        .collect();
    if skills.is_empty() {
        args.push("*".into());
    } else {
        args.extend_from_slice(skills);
    }
    args.push("--agent".into());
    args.extend(agents.into_iter().map(str::to_owned));
    if global {
        args.push("-g".into());
    }
    Ok(args)
}
fn plain(output: &str) -> String {
    // ANSI CSI cursor and color controls occur even with NO_COLOR in non-TTY output.
    regex::Regex::new(r"\x1b\[[0-?]*[ -/]*[@-~]")
        .expect("ANSI pattern")
        .replace_all(output, "")
        .into_owned()
}
/// Parses `skills add <source> --list` (skills 1.7.6 has no machine-readable listing: it rejects
/// `--json` with `--list`). The listing is clack `log.message` output after the "Available
/// Skills" step: each message starts after a bare bar line, as `<bar>    name` then
/// `<bar>      description`; a description's own extra lines follow with no bar line between,
/// at the two-space message indent. Plugin group titles are unbarred lines, and clack draws
/// ASCII (`|`, `o`, `—`) where Unicode isn't supported. Anything else is ignored.
fn parse_preview(output: &str) -> Result<Vec<PreviewSkill>, String> {
    let output = plain(output).replace("\r\n", "\n");
    let mut lines = output
        .lines()
        .skip_while(|line| !line.contains("Available Skills"));
    lines.next();
    let mut skills: Vec<PreviewSkill> = Vec::new();
    // Whether description text now belongs to the last listed skill.
    let mut in_skill = false;
    let mut new_message = true;
    for line in lines {
        let trimmed = line.trim_start();
        if ["└", "—"].iter().any(|end| trimmed.starts_with(end))
            || line.contains("Use --skill")
            || line.contains("Run without --list")
        {
            break;
        }
        let Some(rest) = ["│", "|"].iter().find_map(|bar| trimmed.strip_prefix(bar)) else {
            // A group title (or stray output): the next message starts fresh.
            if !trimmed.is_empty() {
                in_skill = false;
            }
            new_message = true;
            continue;
        };
        let indent = rest.chars().take_while(|c| *c == ' ').count();
        let text = rest.trim();
        if text.is_empty() {
            new_message = true;
            continue;
        }
        let starts = std::mem::replace(&mut new_message, false);
        if starts && indent == 4 {
            // A repeated name is left out together with its description; an unswitchable one
            // is listed with the reason it can't be added.
            let name: String = text.chars().take(MAX_PREVIEW_NAME).collect();
            in_skill = skills.iter().all(|s| s.name != name);
            if in_skill {
                let unswitchable = validate_name(&name).err().map(|_| UNSWITCHABLE.to_string());
                skills.push(PreviewSkill {
                    switchable: unswitchable.is_none(),
                    unswitchable,
                    name,
                    description: String::new(),
                });
            }
            continue;
        }
        if starts && indent >= 6 && text.starts_with("Files: ") {
            continue;
        }
        let continues = !starts || indent >= 6;
        if in_skill && continues {
            if let Some(skill) = skills.last_mut() {
                if !skill.description.is_empty() {
                    skill.description.push(' ');
                }
                skill.description.push_str(text);
            }
        }
    }
    if skills.is_empty() {
        Err("The skills CLI returned no available skills. Check the source and try again.".into())
    } else {
        Ok(skills)
    }
}
fn error_message(output: &str, error: &str) -> String {
    let text = plain(&format!("{output}\n{error}"));
    let errors: Vec<_> = text
        .lines()
        .map(str::trim)
        .filter(|line| {
            let line = line.trim_start_matches(['│', '◇', '└', ' ']);
            line.starts_with('■')
                || line.to_ascii_lowercase().starts_with("error")
                || line.starts_with("npm ERR!")
        })
        .collect();
    let message = if errors.is_empty() {
        text.lines()
            .rev()
            .map(str::trim)
            .find(|line| line.starts_with("fatal:") || line.starts_with("Failed "))
            .unwrap_or("The skills CLI failed. Check the source and try again.")
            .to_string()
    } else {
        errors[errors.len().saturating_sub(2)..].join(" ")
    };
    format!(
        "Could not add or preview skills: {}",
        safety::redact_warning(&message)
            .chars()
            .take(267)
            .collect::<String>()
    )
}
/// npm's local prefix for every skills CLI run: an empty PandaCode-owned folder in app data, so a
/// project's `node_modules`, `package.json` or `.npmrc` can never supply or configure the
/// `skills` package. (`--prefix` on the command line is npm's local prefix, project config
/// location and local package lookup, and wins over any `npm_config_prefix`.)
pub(super) fn npm_prefix(prefs: &Path) -> PathBuf {
    prefs.with_file_name("skills-cli")
}
pub(super) fn ensure_prefix(prefix: &Path) -> Result<(), String> {
    fs::create_dir_all(prefix).map_err(|e| format!("Could not prepare the skills CLI folder: {e}"))
}

/// The npx arguments and environment for one skills CLI invocation. skills 1.7.6 has no option
/// naming the project: it installs project skills into its working directory, which the caller
/// sets to the project (or to `prefix` for global installs and previews). npm itself only reads
/// `prefix` and the user's own `~/.npmrc`.
pub(super) fn npx_call(
    args: &[String],
    prefix: &Path,
    home: &Path,
    env: &BTreeMap<String, String>,
) -> (Vec<String>, BTreeMap<String, String>) {
    let args = std::iter::once(format!("--prefix={}", prefix.to_string_lossy()))
        .chain(args.iter().cloned())
        .collect();
    let mut env = env.clone();
    env.insert(
        "npm_config_userconfig".into(),
        home.join(".npmrc").to_string_lossy().into_owned(),
    );
    (args, env)
}

pub(super) struct Output {
    pub stdout: String,
    pub error: Option<String>,
}
fn finish_output(stdout: &str, stderr: &str, success: bool) -> Result<Output, String> {
    Ok(Output {
        stdout: plain(stdout),
        error: (!success).then(|| error_message(stdout, stderr)),
    })
}
pub(super) fn run(
    args: &[String],
    cwd: &Path,
    env: &BTreeMap<String, String>,
) -> Result<Output, String> {
    let path = crate::providers::tool_path("npx")
        .ok_or("Install Node.js to add skills (npx was not found).")?;
    // Reuse the launcher to resolve Windows npm shims without invoking a shell.
    let mut command = crate::providers::command(&path)
        .map_err(|error| {
            if error.to_lowercase().contains("node") {
                "Install Node.js to add skills.".to_string()
            } else {
                error
            }
        })?
        .into_std();
    // Only the npm configuration `npx_call` chose: no inherited prefix or user config.
    for key in [
        "NPM_CONFIG_USERCONFIG",
        "NPM_CONFIG_PREFIX",
        "npm_config_prefix",
        "NPM_CONFIG_GLOBALCONFIG",
        "npm_config_globalconfig",
    ] {
        command.env_remove(key);
    }
    command
        .args(args)
        .envs(env)
        .current_dir(cwd)
        .env("DISABLE_TELEMETRY", "1")
        .env("DO_NOT_TRACK", "1")
        .env("NO_COLOR", "1")
        .env("GIT_TERMINAL_PROMPT", "0");
    run_bounded(command, Duration::from_secs(120))
}
/// Bytes kept from each of the CLI's streams. npm and the CLI print progress and warnings on
/// stderr, so it gets the same room as stdout: a long log must not fail a finished install.
const OUTPUT_LIMIT: usize = 1024 * 1024;
fn run_bounded(command: std::process::Command, timeout: Duration) -> Result<Output, String> {
    let result = crate::workspace::run_process_with_input(
        command,
        "skills CLI",
        OUTPUT_LIMIT,
        timeout,
        None,
    )?;
    if result.stdout.truncated || result.stderr.truncated {
        return Err("The skills CLI output exceeded its limit. Try selecting fewer skills.".into());
    }
    finish_output(
        &String::from_utf8_lossy(&result.stdout.bytes),
        &String::from_utf8_lossy(&result.stderr.bytes),
        result.status.success(),
    )
}
pub(super) fn preview(source: String, prefs: &Path) -> Result<Preview, String> {
    let (source, selected) = normalize_source(&source)?;
    let home =
        crate::agent_usage_providers::home().ok_or("Could not locate the home directory.")?;
    let prefix = npm_prefix(prefs);
    ensure_prefix(&prefix)?;
    // skills 1.7.6 explicitly rejects --json together with --list.
    let args = ["-y", PACKAGE, "add", &source, "--list", "-y"].map(str::to_owned);
    let (args, env) = npx_call(&args, &prefix, &home, &BTreeMap::new());
    let output = run(&args, &prefix, &env)?;
    if let Some(error) = output.error {
        return Err(error);
    }
    let skills = parse_preview(&output.stdout)?;
    Ok(Preview {
        source,
        skills,
        selected,
    })
}

/// The pinned CLI prints JSON on success; tolerate plain output from older npm wrappers.
pub(super) fn parse_result(output: &str) -> Option<serde_json::Value> {
    let output = plain(output);
    serde_json::from_str(&output).ok().or_else(|| {
        output
            .lines()
            .rev()
            .find_map(|line| serde_json::from_str(line).ok())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn skill_manager_nonzero_cli_output_retains_partial_install_json() {
        let json = r#"[{"name":"one","status":"installed"},{"name":"two","status":"failed","error":"Denied"}]"#;
        let output = finish_output(json, "", false).unwrap();
        assert!(output.error.is_some());
        assert_eq!(
            parse_result(&output.stdout).unwrap()[0]["status"],
            "installed"
        );
    }
    #[cfg(unix)]
    #[test]
    fn skill_manager_cli_long_stderr_log_keeps_a_successful_install() {
        let mut command = std::process::Command::new("sh");
        command.args([
            "-c",
            r#"head -c 40000 /dev/zero | tr '\000' w >&2; printf '[{"name":"one","status":"installed"}]'"#,
        ]);
        let output = run_bounded(command, Duration::from_secs(20)).unwrap();
        assert!(output.error.is_none());
        assert_eq!(
            parse_result(&output.stdout).unwrap()[0]["status"],
            "installed"
        );
        let mut flood = std::process::Command::new("sh");
        flood.args(["-c", "head -c 1100000 /dev/zero >&2"]);
        assert!(run_bounded(flood, Duration::from_secs(20))
            .err()
            .unwrap()
            .contains("exceeded its limit"));
    }
    #[test]
    fn skill_manager_preview_serializes_only_link_selection() {
        for (source, expected) in [
            (
                "https://skills.sh/vercel-labs/agent-skills/web-design-guidelines/?ref=share",
                Some(vec!["web-design-guidelines".to_string()]),
            ),
            (
                "https://skills.sh/vercel-labs/agent-skills/?ref=share",
                None,
            ),
            ("vercel-labs/agent-skills", None),
        ] {
            let (source, selected) = normalize_source(source).unwrap();
            assert_eq!(source, "vercel-labs/agent-skills");
            assert_eq!(selected, expected);
            let value = serde_json::to_value(Preview {
                source,
                skills: Vec::new(),
                selected,
            })
            .unwrap();
            assert_eq!(value.get("selected").is_some(), expected.is_some());
        }
        for source in [
            "https://skills.sh/owner",
            "https://skills.sh/o/r/skill/extra",
            "https://skills.sh/o/r/-bad",
            "https://skills.sh/o/r/with%20space",
            "https://skills.sh/o/r\n",
        ] {
            assert!(normalize_source(source).is_err(), "{source}");
        }
    }
    #[test]
    fn skill_manager_preview_metadata_and_selection_mask_secrets() {
        let token = "ghp_1234567890abcdefghijklmnopqrstuvwxyz";
        let preview = Preview {
            source: token.into(),
            skills: vec![PreviewSkill {
                name: token.into(),
                description: token.into(),
                unswitchable: None,
                switchable: true,
            }],
            selected: Some(vec![token.into()]),
        };
        let value = serde_json::to_string(&preview).unwrap();
        assert!(!value.contains(token));
        assert!(value.contains("[secret redacted]"));
    }
    #[test]
    fn skill_manager_errors_strip_stdout_banner_and_spinner_art() {
        let stdout = "\x1b[1m████ SKILLS ████\x1b[0m\n◇ Cloning repository...\n│ ⠹ Downloading\n\x1b[31m■ Downloaded URL is not a valid SKILL.md\x1b[0m\n└ Installation failed\n";
        let message = error_message(stdout, "npm notice A newer version is available");
        assert!(
            message.contains("Downloaded URL is not a valid SKILL.md"),
            "{message}"
        );
        assert!(!message.contains('█') && !message.contains('⠹') && !message.contains('\x1b'));
        assert!(
            error_message(&format!("Error: {}", "long ".repeat(300)), "")
                .chars()
                .count()
                <= 300
        );
    }
    #[test]
    fn skill_manager_skills_sh_links_normalize_before_installing() {
        for suffix in [
            "",
            "/",
            "?utm_source=skills",
            "/web-design",
            "/web-design/?ref=share",
        ] {
            let source = format!("https://skills.sh/vercel-labs/agent-skills{suffix}");
            let args = add_args(&source, &[], &["claude".into()], false).unwrap();
            assert_eq!(args[3], "vercel-labs/agent-skills");
            assert_eq!(
                args[7],
                if suffix.contains("web-design") {
                    "web-design"
                } else {
                    "*"
                }
            );
        }
    }
    #[test]
    fn skill_manager_preview_parses_recorded_list_output_with_ansi_and_multiline_descriptions() {
        let text = "\x1b[?25l│\n◇  Source: https://github.com/vercel-labs/agent-skills.git\n◇  Available Skills\n│\n│    web-design-guidelines\n│\n│      Review UI code for Web Interface Guidelines compliance.\n│      Continued description.\n│\n│    writing-guidelines\n│\n│      Review prose.\n└  Use --skill <name> to install specific skills\n";
        let skills = parse_preview(text).unwrap();
        assert_eq!(skills.len(), 2);
        assert_eq!(skills[0].name, "web-design-guidelines");
        assert_eq!(
            skills[0].description,
            "Review UI code for Web Interface Guidelines compliance. Continued description."
        );
        assert!(parse_preview("Failed to clone").is_err());
    }

    fn listed(text: &str) -> Vec<(String, String)> {
        parse_preview(text)
            .unwrap()
            .into_iter()
            .map(|s| (s.name, s.description))
            .collect()
    }
    fn pairs(expected: &[(&str, &str)]) -> Vec<(String, String)> {
        expected
            .iter()
            .map(|(n, d)| ((*n).into(), (*d).into()))
            .collect()
    }

    /// Recorded from skills 1.7.6 (clack prompts) for a repository with plugin groups, a
    /// description with its own line breaks, colors and CRLF line ends.
    #[test]
    fn skill_manager_preview_parses_grouped_listing_with_wrapped_descriptions() {
        let text = "npm warn exec The following package was not found and will be installed: skills@1.7.6\r\n\x1b[?25l\x1b[90m│\x1b[39m\r\n\x1b[32m◇\x1b[39m  Found \x1b[32m3\x1b[39m skills\r\n\r\n\x1b[90m│\x1b[39m\r\n\x1b[32m◇\x1b[39m  \x1b[1mAvailable Skills\x1b[22m\r\n\x1b[1mCode Review\x1b[22m\r\n\x1b[90m│\x1b[39m\r\n\x1b[90m│\x1b[39m    \x1b[36mreview\x1b[39m\r\n\x1b[90m│\x1b[39m\r\n\x1b[90m│\x1b[39m      \x1b[2mReviews diffs.\r\n\x1b[90m│\x1b[39m  Second line of the description.\r\n\x1b[90m│\x1b[39m    indented third line\x1b[22m\r\n\r\n\x1b[1mGeneral\x1b[22m\r\n\x1b[90m│\x1b[39m\r\n\x1b[90m│\x1b[39m    \x1b[36mplugin:lint\x1b[39m\r\n\x1b[90m│\x1b[39m\r\n\x1b[90m│\x1b[39m      \x1b[2mLints.\x1b[22m\r\n\r\n\x1b[90m└\x1b[39m  Use --skill <name> to install specific skills\r\n";
        assert_eq!(
            listed(text),
            pairs(&[
                (
                    "review",
                    "Reviews diffs. Second line of the description. indented third line"
                ),
                ("plugin:lint", "Lints."),
            ])
        );
    }

    /// The well-known/URL layout: install names, `Files: N` lines, a different outro, and the
    /// ASCII glyphs clack falls back to without Unicode support.
    #[test]
    fn skill_manager_preview_parses_ascii_well_known_listing_and_skips_unknown_lines() {
        let text = "|\no  Found 2 skills\n|\n|  Skill one\n|\no  Available Skills\n|\n|    alpha\n|\n|      First skill.\n|\n|      Files: 3\n|\n|  stray note the parser does not know\n|\n|    beta\n|\n|      Second skill.\n|\n—  Run without --list to install\n|\n|    after-outro\n";
        assert_eq!(
            listed(text),
            pairs(&[("alpha", "First skill."), ("beta", "Second skill.")])
        );
    }

    #[test]
    fn skill_manager_preview_ignores_names_before_the_listing_and_lists_invalid_names_as_unswitchable(
    ) {
        let text = "│\n│    not-listed-yet\n◇  Available Skills\n│\n│    bad(name)\n│\n│      Unswitchable.\n│\n│    good\n│\n│      Fine.\n│\n│    good\n│\n│      Duplicate.\n└  Use --skill <name> to install specific skills\n";
        assert_eq!(
            listed(text),
            pairs(&[("bad(name)", "Unswitchable."), ("good", "Fine.")])
        );
        let value = serde_json::to_value(parse_preview(text).unwrap()).unwrap();
        assert_eq!(value[0]["switchable"], false);
        assert_eq!(value[0]["unswitchableReason"], UNSWITCHABLE);
        assert!(value[1].get("switchable").is_none());
        assert!(value[1].get("unswitchableReason").is_none());
        assert!(parse_preview("◇  Available Skills\n└  Use --skill <name>\n").is_err());
    }
    #[test]
    fn skill_manager_preview_of_only_unswitchable_skills_lists_them_instead_of_none() {
        let text =
            "◇  Available Skills\n│\n│    bad(name)\n│\n│      Odd.\n└  Use --skill <name>\n";
        let skills = parse_preview(text).unwrap();
        assert_eq!(skills.len(), 1);
        assert!(skills[0].unswitchable.is_some());
        // Still never installable by name.
        assert!(add_args(
            "owner/repo",
            &["bad(name)".into()],
            &["claude".into()],
            false
        )
        .is_err());
    }
    #[test]
    fn skill_manager_network_and_unc_paths_are_refused_as_local_sources() {
        for source in [
            r"\\server\share\skills",
            "//server/share/skills",
            r"\\?\UNC\server\share\skills",
            r"\\?\C:\skills",
            r"\\.\pipe\skills",
            r"\/server/share",
        ] {
            assert_eq!(
                local_source(source).unwrap_err(),
                "Choose a folder on this computer: network folders can't be added.",
                "{source}"
            );
            assert!(normalize_source(source).is_err(), "{source}");
        }
        assert!(!network_path("/Users/me/skills"));
        assert!(!network_path(r"C:\skills"));
    }

    #[test]
    fn skill_manager_local_folder_source_is_validated_and_passed_canonically() {
        let f = crate::skill_manager::tests::Fixture::new();
        f.skill("pack/one", "---\nname: one\n---\n");
        let single = f.0.join("pack/one");
        fs::create_dir_all(f.0.join("repo/skills")).unwrap();
        fs::create_dir_all(f.0.join("empty")).unwrap();
        let canonical = |p: &Path| canonical_folder(p).unwrap().to_str().unwrap().to_owned();
        for folder in [single.clone(), f.0.join("repo")] {
            let (source, selected) = normalize_source(folder.to_str().unwrap()).unwrap();
            assert_eq!(source, canonical(&folder));
            assert!(selected.is_none());
            let args = add_args(folder.to_str().unwrap(), &[], &["claude".into()], false).unwrap();
            assert_eq!(args[3], canonical(&folder));
        }
        let dotted = format!("{}/../pack/one", f.0.join("repo").display());
        let with_dot = format!("{}/./one", f.0.join("pack").display());
        for bad in [
            f.0.join("empty").to_str().unwrap().to_owned(),
            f.0.join("missing").to_str().unwrap().to_owned(),
            single.join("SKILL.md").to_str().unwrap().to_owned(),
            dotted,
            with_dot,
            format!("{}\n", single.display()),
        ] {
            assert_eq!(
                normalize_source(&bad).unwrap_err(),
                "Choose an existing folder that contains SKILL.md or a skills folder.",
                "{bad}"
            );
        }
        // Relative paths are not local sources: they stay owner/repo-style and fail as such.
        assert!(normalize_source("./pack").is_err());
        assert_eq!(normalize_source("owner/repo").unwrap().0, "owner/repo");
    }
    #[test]
    fn skill_manager_add_uses_verified_agents_noninteractive_scope_and_all_skills() {
        let args = add_args(
            "owner/repo",
            &[],
            &["claude".into(), "glm".into(), "kimi".into()],
            true,
        )
        .unwrap();
        assert_eq!(
            args,
            [
                "-y",
                "skills@1.7.6",
                "add",
                "owner/repo",
                "-y",
                "--json",
                "--skill",
                "*",
                "--agent",
                "claude-code",
                "kimi-code-cli",
                "-g"
            ]
        );
        assert!(add_args("owner/repo", &[], &[], false).is_err());
        assert!(add_args("owner/repo", &[], &["unknown".into()], false).is_err());
    }
}

#[cfg(test)]
mod warning_regressions {
    use super::*;
    #[test]
    fn skill_manager_cli_error_masks_secrets_before_truncating() {
        let token = "ghp_1234567890abcdefghijklmnopqrstuvwxyz";
        assert!(!error_message(&format!("Error: {token} {token}"), "").contains(token));
    }
}

#[cfg(test)]
mod live_tests {
    use super::*;
    /// `cargo test skill_manager_live_skills_cli -- --ignored`. Needs Node.js and the network.
    #[test]
    #[ignore = "Runs the pinned skills CLI through npx over the network; never installs anything"]
    fn skill_manager_live_skills_cli_previews_a_public_repo_and_knows_every_agent_id() {
        let dir =
            std::env::temp_dir().join(format!("pandacode-skills-live-{}", uuid::Uuid::new_v4()));
        let prefs = dir.join("skill-manager.json");
        let preview = preview("vercel-labs/agent-skills".into(), &prefs).expect("preview");
        assert!(!preview.skills.is_empty());
        assert!(preview
            .skills
            .iter()
            .all(|s| validate_name(&s.name).is_ok()));
        // An unknown agent makes the CLI print its agent IDs before it reads anything.
        let home = crate::agent_usage_providers::home().expect("home");
        let args = ["-y", PACKAGE, "list", "-g", "--agent", "not-an-agent"].map(str::to_owned);
        let prefix = npm_prefix(&prefs);
        let (args, env) = npx_call(&args, &prefix, &home, &BTreeMap::new());
        let output = run(&args, &prefix, &env).expect("skills CLI");
        let _ = fs::remove_dir_all(&dir);
        let valid: BTreeSet<&str> = output
            .stdout
            .lines()
            .find_map(|line| line.trim().strip_prefix("Valid agents:"))
            .expect("the CLI lists its agent IDs")
            .split(',')
            .map(str::trim)
            .collect();
        for (id, _) in crate::providers::PROVIDERS {
            let agent = agent_id(id).unwrap_or_else(|| panic!("{id} has no CLI agent"));
            assert!(valid.contains(agent), "{id} maps to unknown agent {agent}");
        }
    }
}
