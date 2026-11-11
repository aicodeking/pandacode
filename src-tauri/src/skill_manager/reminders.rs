//! Reminders for switched-off skills a harness cannot deny: the session advisory line, carried
//! in the system instructions or the prompt, never inside a built-in command's arguments.
use super::*;

/// Skill names installed for `harness` in a folder (its user and project roots): the names a
/// typed `/name` in that harness could run as a skill.
pub(crate) fn installed_names_for(harness: &str, cwd: &Path) -> BTreeSet<String> {
    let Some(home) = crate::agent_usage_providers::home() else {
        return BTreeSet::new();
    };
    names_for(
        inventory::with_counts(
            &home,
            Some(cwd),
            None,
            &Prefs::default(),
            &Homes::for_scan(),
        )
        .0,
        harness,
    )
}
fn names_for(skills: Vec<ManagedSkill>, harness: &str) -> BTreeSet<String> {
    skills
        .into_iter()
        .filter(|skill| !skill.missing && skill.agents.iter().any(|a| a.harness == harness))
        .map(|skill| skill.name)
        .collect()
}
pub(crate) fn is_disabled(disabled: &BTreeSet<String>, name: &str) -> bool {
    disabled.contains("*") || disabled.contains(name)
}
/// A skill name as reminders render it: a bare identifier, anything else JSON-quoted (newlines
/// and control characters escaped) and bounded, so a name never reads as an instruction.
pub(crate) fn quoted_name(name: &str) -> String {
    if claude_rule_name(name) {
        return name.into();
    }
    let bounded: String = name.chars().take(200).collect();
    serde_json::to_string(&safety::redact_warning(&bounded)).expect("skill name")
}
pub(crate) fn console_advisory(disabled: &BTreeSet<String>) -> String {
    if disabled.contains("*") {
        return "Skills are temporarily off in this session: PandaCode could not recover skill settings. Do not use any skills.".into();
    }
    let names: Vec<_> = disabled
        .iter()
        .filter(|name| validate_name(name).is_ok())
        .cloned()
        .collect();
    if names.is_empty() {
        return String::new();
    }
    format!(
        "Do not use these skills in this session: {}.",
        if names.iter().all(|name| claude_rule_name(name)) {
            names.join(", ")
        } else {
            serde_json::to_string(&names).expect("skill names")
        }
    )
}
/// Names a harness cannot deny get a reminder every session turn, including resumes.
pub(crate) fn apply_instructions(
    config: &mut crate::providers::RunConfig,
    disabled: &BTreeSet<String>,
) {
    apply_instructions_with(config, disabled, installed_names_for);
}
/// `installed` lists the skills installed for a harness and folder; it is read only when a
/// reminder is due on a prompt-channel harness and the prompt types a `/command`.
pub(super) fn apply_instructions_with(
    config: &mut crate::providers::RunConfig,
    disabled: &BTreeSet<String>,
    installed: impl Fn(&str, &Path) -> BTreeSet<String>,
) {
    if config
        .skill
        .as_ref()
        .is_some_and(|(name, _)| is_disabled(disabled, name))
    {
        config.skill = None;
    }
    let names = advisory_names(&config.provider, disabled);
    remind(config, &names, installed);
}
/// A launch whose denies could not reach everything (OpenCode agents past the limit): every
/// switched-off name is asked about, as for a harness that cannot deny it.
pub(crate) fn remind_unenforced(
    config: &mut crate::providers::RunConfig,
    disabled: &BTreeSet<String>,
) {
    remind(config, disabled, installed_names_for);
}
/// Harnesses with a system channel (`takes_system_instructions`) carry the reminder there.
/// Others carry it in the prompt; a prompt that types a `/command` gets it on a trailing line
/// only when the command is a skill invocation, whose arguments are free text the agent reads
/// (`/skill:name args`, or `/name` for a skill installed for this harness). Built-ins and
/// custom commands get no reminder that turn: appended text would change their arguments.
pub(super) fn remind(
    config: &mut crate::providers::RunConfig,
    names: &BTreeSet<String>,
    installed: impl Fn(&str, &Path) -> BTreeSet<String>,
) {
    let advisory = console_advisory(names);
    if advisory.is_empty() {
        return;
    }
    let line = format!("\n{advisory}\n");
    let instructions = if crate::providers::takes_system_instructions(&config.provider) {
        &mut config.instructions
    } else if let Some(command) = typed_command(&config.prompt) {
        if !skill_invocation(&config.provider, command, || {
            installed(&config.provider, &config.cwd)
        }) {
            return;
        }
        &mut config.prompt
    } else {
        &mut config.prompt
    };
    if !instructions.contains(&line) {
        instructions.push_str(&line);
    }
}
/// A typed `/command` that runs a skill (so its arguments are free text), never a built-in.
fn skill_invocation(
    harness: &str,
    command: &str,
    installed: impl FnOnce() -> BTreeSet<String>,
) -> bool {
    if harness_builtin(harness, command) {
        return false;
    }
    match command.strip_prefix("skill:") {
        Some(name) => !name.is_empty(),
        None => installed().contains(command),
    }
}
