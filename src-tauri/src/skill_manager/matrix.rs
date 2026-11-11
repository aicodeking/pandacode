//! The one per-harness enforcement table. Task launches, terminal consoles, the typed-command
//! guard and the Skills page (`enforcement`, `consoleEnforcement`, `enforcementOverrides`) all
//! read it, so what the page says is what a launch does.
use super::*;

/// What switching a skill off does for one harness.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Mode {
    /// The harness refuses to load the skill.
    Blocked,
    /// The agent is told not to use it.
    Asked,
    /// Nothing reaches the agent.
    None,
}

/// Which disabled names a harness can deny by exact name.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Exact {
    None,
    /// ASCII identifiers only (`claude_rule_name`): Claude's tool rules and OpenCode's globs.
    Identifiers,
    /// Every switchable name (Codex name selectors).
    All,
}

/// How a PandaCode terminal console delivers switches. Never a channel that starts a turn.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Console {
    /// `--disallowedTools=Skill(name)` rules plus `--append-system-prompt` for other names.
    ClaudeRules,
    /// `-c skills.config=[…]`.
    CodexConfig,
    /// `OPENCODE_CONFIG_CONTENT` denies. No reminder channel: `--prompt` would start a turn.
    OpenCodeConfig,
    /// A system-prompt flag carrying the reminder.
    Flag(&'static str),
    /// `--config run.developer_prompt=…`.
    MuseConfig,
    /// The `HERMES_EPHEMERAL_SYSTEM_PROMPT` environment variable.
    HermesEnvironment,
    /// No channel (Copilot `--interactive` and Devin `--` would start a turn).
    None,
}

pub(crate) struct Rules {
    pub(crate) exact: Exact,
    /// The harness can deny every skill (the fail-closed `*` after unrecoverable settings).
    pub(crate) deny_all: bool,
    pub(crate) console: Console,
}

pub(crate) fn rules(harness: &str) -> Rules {
    let (exact, deny_all, console) = match harness {
        "claude" | "glm" | "mimo" => (Exact::Identifiers, true, Console::ClaudeRules),
        "codex" => (Exact::All, false, Console::CodexConfig),
        "opencode" => (Exact::Identifiers, true, Console::OpenCodeConfig),
        "pi" | "omp" => (Exact::None, false, Console::Flag("--append-system-prompt")),
        "grok" => (Exact::None, false, Console::Flag("--rules")),
        // `cline --system` replaces the whole system prompt and Cline has no append flag.
        "muse" => (Exact::None, false, Console::MuseConfig),
        "hermes" => (Exact::None, false, Console::HermesEnvironment),
        _ => (Exact::None, false, Console::None),
    };
    Rules {
        exact,
        deny_all,
        console,
    }
}

/// A plain identifier: the modes every harness reports as its default.
const PLAIN: &str = "skill";

impl Rules {
    /// The harness denies this disabled name exactly (`*` is the all-skills deny).
    pub(crate) fn blocks(&self, name: &str) -> bool {
        if name == "*" {
            return self.deny_all;
        }
        match self.exact {
            Exact::None => false,
            Exact::Identifiers => claude_rule_name(name),
            Exact::All => validate_name(name).is_ok(),
        }
    }
    fn console_reminds(&self) -> bool {
        matches!(
            self.console,
            Console::ClaudeRules
                | Console::Flag(_)
                | Console::MuseConfig
                | Console::HermesEnvironment
        )
    }
    /// Tasks PandaCode starts: every harness carries the reminder for names it cannot deny.
    pub(crate) fn session(&self, name: &str) -> Mode {
        if self.blocks(name) {
            Mode::Blocked
        } else {
            Mode::Asked
        }
    }
    pub(crate) fn console_mode(&self, name: &str) -> Mode {
        if self.blocks(name) {
            Mode::Blocked
        } else if self.console_reminds() {
            Mode::Asked
        } else {
            Mode::None
        }
    }
}

/// Shown beside a harness's console mode when the console can still run a switched-off skill.
/// Claude-family consoles deny model-invoked skills, but a `/name` the user types in the
/// console itself is expanded by Claude Code before any tool rule applies.
pub(crate) fn console_note(harness: &str) -> Option<&'static str> {
    (rules(harness).console == Console::ClaudeRules)
        .then_some("Typed /commands still run in the console")
}

/// `(session, console)` defaults reported on each harness.
pub(crate) fn defaults(harness: &str) -> (Mode, Mode) {
    let rules = rules(harness);
    (rules.session(PLAIN), rules.console_mode(PLAIN))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Modes {
    pub(crate) enforcement: Mode,
    pub(crate) console_enforcement: Mode,
}

/// Harnesses whose modes for `name` differ from their defaults.
pub(crate) fn overrides(name: &str) -> BTreeMap<&'static str, Modes> {
    if validate_toggle_name(name).is_err() {
        return BTreeMap::new();
    }
    crate::providers::PROVIDERS
        .iter()
        .filter_map(|(id, _)| {
            let rules = rules(id);
            let modes = (rules.session(name), rules.console_mode(name));
            (modes != defaults(id)).then_some((
                *id,
                Modes {
                    enforcement: modes.0,
                    console_enforcement: modes.1,
                },
            ))
        })
        .collect()
}

/// Names this harness cannot deny, so it is asked not to use them instead.
pub(crate) fn advisory_names(harness: &str, disabled: &BTreeSet<String>) -> BTreeSet<String> {
    let rules = rules(harness);
    disabled
        .iter()
        .filter(|name| !rules.blocks(name))
        .cloned()
        .collect()
}

pub(crate) fn console_arguments(harness: &str, disabled: &BTreeSet<String>) -> Vec<String> {
    if disabled.is_empty() {
        return Vec::new();
    }
    let line = console_advisory(&advisory_names(harness, disabled));
    let reminder = |flag: &str| {
        if line.is_empty() {
            Vec::new()
        } else {
            vec![flag.to_owned(), line.clone()]
        }
    };
    match rules(harness).console {
        Console::ClaudeRules => {
            let rules = claude_disallowed("", disabled);
            let mut args = Vec::new();
            if !rules.is_empty() {
                args.push(format!("--disallowedTools={rules}"));
            }
            args.extend(reminder("--append-system-prompt"));
            args
        }
        Console::CodexConfig => enforcement::codex_arguments(disabled),
        Console::Flag(flag) => reminder(flag),
        Console::MuseConfig if !line.is_empty() => vec![
            "--config".into(),
            format!(
                "run.developer_prompt={}",
                serde_json::to_string(&line).expect("string")
            ),
        ],
        Console::MuseConfig
        | Console::OpenCodeConfig
        | Console::HermesEnvironment
        | Console::None => Vec::new(),
    }
}

/// An environment variable a console carries its reminder in, appended to `existing()`.
pub(crate) fn console_environment(
    harness: &str,
    disabled: &BTreeSet<String>,
    existing: impl FnOnce() -> String,
) -> Option<(&'static str, String)> {
    if rules(harness).console != Console::HermesEnvironment {
        return None;
    }
    let line = console_advisory(&advisory_names(harness, disabled));
    (!line.is_empty()).then(|| {
        (
            "HERMES_EPHEMERAL_SYSTEM_PROMPT",
            format!("{}\n{line}", existing()),
        )
    })
}

/// Unrecoverable settings (`*`) never refuse a launch. A harness that denies by name but has no
/// all-skills deny (Codex) is given a deny for every skill installed for it in `cwd`; the
/// `skills are temporarily off` reminder (`advisory_names` keeps `*`) covers anything unlisted.
/// Harnesses with an all-skills deny, or none by name, get `disabled` back unchanged.
pub(crate) fn launch_disabled(
    harness: &str,
    cwd: &Path,
    disabled: BTreeSet<String>,
) -> BTreeSet<String> {
    launch_disabled_with(harness, disabled, || installed_names_for(harness, cwd))
}

pub(crate) fn launch_disabled_with(
    harness: &str,
    mut disabled: BTreeSet<String>,
    installed: impl FnOnce() -> BTreeSet<String>,
) -> BTreeSet<String> {
    let rules = rules(harness);
    if disabled.contains("*") && !rules.deny_all && rules.exact != Exact::None {
        disabled.extend(installed().into_iter().filter(|name| rules.blocks(name)));
    }
    disabled
}

// Claude Code's built-in commands share its catalog with skills and carry no source. A skill with
// one of these names is still blocked at launch; only the built-in command stays in the menu.
const CLAUDE_BUILTINS: &[&str] = &[
    "add-dir",
    "agents",
    "bashes",
    "bug",
    "clear",
    "compact",
    "config",
    "context",
    "cost",
    "doctor",
    "exit",
    "export",
    "feedback",
    "help",
    "hooks",
    "ide",
    "init",
    "insights",
    "install-github-app",
    "keybindings",
    "login",
    "logout",
    "mcp",
    "memory",
    "migrate-installer",
    "model",
    "output-style",
    "permissions",
    "plan",
    "plugin",
    "pr-comments",
    "privacy-settings",
    "release-notes",
    "rename",
    "resume",
    "review",
    "rewind",
    "sandbox",
    "security-review",
    "skills",
    "stats",
    "status",
    "statusline",
    "tasks",
    "terminal-setup",
    "theme",
    "todos",
    "upgrade",
    "usage",
    "vim",
];

/// A command the harness runs itself rather than as a skill: the one list the composer's slash
/// menu and the typed-command guard share. Codex invokes skills as `$name` (and denies them by
/// name), so its `/name` commands are all its own.
pub(crate) fn harness_builtin(harness: &str, name: &str) -> bool {
    match harness {
        "claude" | "glm" | "mimo" => CLAUDE_BUILTINS.contains(&name),
        "codex" => true,
        _ => false,
    }
}

/// The command a prompt types (`/name args` → `name`), if it starts with one.
pub(crate) fn typed_command(prompt: &str) -> Option<&str> {
    let command = prompt
        .trim_start()
        .strip_prefix('/')?
        .split(char::is_whitespace)
        .next()
        .unwrap_or_default();
    (!command.is_empty()).then_some(command)
}

/// Claude Code also runs a plugin skill `plugin:tool` typed as `/tool` when no other installed
/// skill answers to that name.
fn runs_unprefixed_plugin_skills(harness: &str) -> bool {
    rules(harness).console == Console::ClaudeRules
}

/// The switched-off skill a typed `/command` (or `/skill:name`) would run, when it is one this
/// harness has installed: harness built-ins and custom (non-skill) commands are never skills.
/// `installed` lists the skill names installed for this harness and folder; it is read only
/// when the typed name (or, on Claude-family harnesses, a plugin skill it could stand for) is
/// switched off, so ordinary commands never scan the inventory.
pub(crate) fn typed_off_skill(
    harness: &str,
    command: &str,
    disabled: &BTreeSet<String>,
    installed: impl FnOnce() -> BTreeSet<String>,
) -> Option<String> {
    let name = command.strip_prefix("skill:").unwrap_or(command);
    if name.is_empty() || disabled.is_empty() || harness_builtin(harness, command) {
        return None;
    }
    let off = |name: &str| is_disabled(disabled, name);
    let stands_for = |full: &str| full.split_once(':').is_some_and(|(_, rest)| rest == name);
    let plugin = runs_unprefixed_plugin_skills(harness)
        && (disabled.contains("*") || disabled.iter().any(|d| stands_for(d)));
    if !off(name) && !plugin {
        return None;
    }
    let installed = installed();
    // An installed skill with exactly this name is what runs, on or off.
    if installed.contains(name) {
        return off(name).then(|| name.to_owned());
    }
    if !plugin {
        return None;
    }
    let mut matches = installed.iter().filter(|full| stands_for(full));
    match (matches.next(), matches.next()) {
        (Some(only), None) if off(only) => Some(only.clone()),
        // None, or ambiguous: Claude needs the prefix, so the command is not this skill.
        _ => None,
    }
}

/// Refuses a turn that types a switched-off skill as `/name` (or `/skill:name`, or `/tool` for
/// a Claude plugin skill `plugin:tool`): harnesses such as Claude expand a typed command
/// themselves, past any tool rule or reminder. `installed` lists the skill names installed for
/// this harness and folder; it is read only when the typed name could be a switched-off skill,
/// so a same-named custom command is never refused.
pub(crate) fn check_prompt(
    harness: &str,
    prompt: &str,
    disabled: &BTreeSet<String>,
    installed: impl FnOnce() -> BTreeSet<String>,
) -> Result<(), String> {
    let Some(command) = typed_command(prompt) else {
        return Ok(());
    };
    let Some(name) = typed_off_skill(harness, command, disabled, installed) else {
        return Ok(());
    };
    Err(off_error(disabled, &name))
}

/// Where the skill switches live, as user-facing text names it.
pub(crate) const SKILLS_SETTINGS: &str = "Settings → Tools → Skills";

/// Why a switched-off skill can't run: its own switch, or settings that could not be recovered.
pub(crate) fn off_error(disabled: &BTreeSet<String>, name: &str) -> String {
    if disabled.contains(name) {
        format!(
            "{} is switched off in {SKILLS_SETTINGS}.",
            safety::redact_warning(name)
        )
    } else {
        format!(
            "{} can't run: PandaCode could not recover skill settings. Reset them in {SKILLS_SETTINGS}.",
            safety::redact_warning(name)
        )
    }
}

/// The typed-command guard for a message sent to a session that is already running (a steer,
/// or a message queued for its next turn): the same check a new turn gets. A message that types
/// no command never reads the switches.
pub(crate) fn check_session_prompt(
    session_id: &str,
    harness: &str,
    cwd: &Path,
    prompt: &str,
) -> Result<(), String> {
    check_session_prompt_with(
        harness,
        prompt,
        || disabled_for(session_id),
        || installed_names_for(harness, cwd),
    )
}

pub(crate) fn check_session_prompt_with(
    harness: &str,
    prompt: &str,
    disabled: impl FnOnce() -> BTreeSet<String>,
    installed: impl FnOnce() -> BTreeSet<String>,
) -> Result<(), String> {
    if typed_command(prompt).is_none() {
        return Ok(());
    }
    check_prompt(harness, prompt, &disabled(), installed)
}

/// The shared send path for every harness turn: refuse what the switches forbid, then carry
/// the reminder for names the harness cannot deny.
pub(crate) fn prepare_turn(
    config: &mut crate::providers::RunConfig,
    disabled: &BTreeSet<String>,
) -> Result<(), String> {
    prepare_turn_with(config, disabled, installed_names_for)
}

fn prepare_turn_with(
    config: &mut crate::providers::RunConfig,
    disabled: &BTreeSet<String>,
    installed: impl Fn(&str, &Path) -> BTreeSet<String>,
) -> Result<(), String> {
    check_prompt(&config.provider, &config.prompt, disabled, || {
        installed(&config.provider, &config.cwd)
    })?;
    check_attached_skill(config, disabled)?;
    apply_instructions_with(config, disabled, |harness, cwd| installed(harness, cwd));
    Ok(())
}

/// A skill attached from the picker (`config.skill`) that is switched off refuses the turn,
/// as typing it would, instead of being dropped silently.
fn check_attached_skill(
    config: &crate::providers::RunConfig,
    disabled: &BTreeSet<String>,
) -> Result<(), String> {
    let Some((name, path)) = &config.skill else {
        return Ok(());
    };
    if is_disabled(disabled, name) {
        return Err(off_error(disabled, name));
    }
    match canonical_name(path) {
        Some(canonical) if is_disabled(disabled, &canonical) => {
            Err(off_error(disabled, &canonical))
        }
        _ => Ok(()),
    }
}

#[cfg(test)]
#[path = "matrix_tests.rs"]
mod tests;
