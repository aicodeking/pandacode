//! Agent-made tools: shell scripts an agent saves for a project and any agent in that project
//! can run again. Stored in app data only (`store.rs`), never in the repository, so a cloned
//! repository cannot plant one. Agents save project tools; the user moves them to global.
pub(crate) mod approval;
mod host;
pub(crate) mod ipc;
mod run;
mod store;
#[cfg(test)]
mod review_tests;
#[cfg(test)]
mod test_support;
#[cfg(test)]
mod tests;

pub(crate) use approval::run_ended;
/// A temp dir removed on drop, even when a test panics.
#[cfg(test)]
pub(crate) use tests::temp;
pub(crate) use host::{catalog, definitions, forget, has_catalog, message_note, offered, standard_names, with_custom_tools};
#[cfg(test)]
pub(crate) use host::{test_note, test_noted};
#[cfg(test)]
pub(crate) use test_support::{bench_host, bench_note, test_definitions, test_host, test_save};

use serde::{Deserialize, Serialize};
use std::path::Path;

pub(crate) const TOOL_SAVE: &str = "pandacode_tool_save";
pub(crate) const TOOL_RUN: &str = "pandacode_tool_run";
pub(crate) const TOOL_LIST: &str = "pandacode_tool_list";
/// The UI listens for this after any change, including agent saves and runs.
pub(crate) const CHANGED_EVENT: &str = "custom-tools-changed";

const MAX_TEXT: usize = 300;
const MAX_PARAMS: usize = 8;
const MAX_PARAM_TEXT: usize = 200;
const MAX_SCRIPT: usize = 16 * 1024;
/// The host and the harnesses end a tool call at about 60 s, so a run gets at most 50.
const DEFAULT_TIMEOUT: u64 = run::HOST_LIMIT_SECS;
const MIN_TIMEOUT: u64 = 5;
const MAX_TIMEOUT: u64 = run::HOST_LIMIT_SECS;

/// Every Unicode format character (Cf), plus the line and paragraph separators (Zl, Zp): any
/// of them can make text read differently from what runs (bidi overrides and isolates as in
/// Trojan Source, zero-width characters, tag characters that hide text, the BOM), and the
/// variation selectors (U+FE00–FE0F, U+E0100–E01EF), which are invisible too and can carry
/// hidden bytes. Also the blank-looking letters and the combining grapheme joiner (U+034F,
/// the Hangul fillers U+115F, U+1160, U+3164, U+FFA0), which draw nothing and pass as names.
pub(crate) fn invisible(c: char) -> bool {
    matches!(c,
        '\u{00AD}' | '\u{0600}'..='\u{0605}' | '\u{061C}' | '\u{06DD}' | '\u{070F}' | '\u{0890}'..='\u{0891}' | '\u{08E2}' | '\u{180E}'
        | '\u{200B}'..='\u{200F}' | '\u{2028}'..='\u{202E}' | '\u{2060}'..='\u{2064}' | '\u{2066}'..='\u{206F}' | '\u{FE00}'..='\u{FE0F}' | '\u{FEFF}' | '\u{FFF9}'..='\u{FFFB}'
        | '\u{034F}' | '\u{115F}' | '\u{1160}' | '\u{3164}' | '\u{FFA0}'
        | '\u{110BD}' | '\u{110CD}' | '\u{13430}'..='\u{1343F}' | '\u{1BCA0}'..='\u{1BCA3}' | '\u{1D173}'..='\u{1D17A}' | '\u{E0000}'..='\u{E007F}' | '\u{E0100}'..='\u{E01EF}')
}

/// Text an agent wrote, as one line: newlines and other control characters become spaces and
/// invisible formatting characters are dropped, so a saved `when` or description cannot draw
/// lines of its own, or reorder itself, where later agents read it.
fn one_line(text: &str) -> String {
    text.chars().filter(|c| !invisible(*c)).map(|c| if c.is_control() { ' ' } else { c }).collect()
}

/// Whether `sh` can run here: always on unix; on Windows only when `sh.exe` is on PATH
/// (Git for Windows, MSYS2, WSL shims), checked once per process.
pub(crate) fn shell_available() -> bool {
    #[cfg(windows)]
    {
        static FOUND: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
        *FOUND.get_or_init(|| sh_on_path(std::env::var_os("PATH").as_deref(), true))
    }
    #[cfg(not(windows))]
    true
}

/// Whether a PATH value holds an `sh` that `Command::new("sh")` runs. On Windows std appends
/// `.exe` to an extensionless program and ignores PATHEXT, so only `sh.exe` counts there: an
/// extensionless `sh` (a Cygwin-style script) or `sh.bat`/`sh.cmd` would pass a check and then
/// fail every run.
#[cfg(any(windows, test))]
fn sh_on_path(path: Option<&std::ffi::OsStr>, windows: bool) -> bool {
    let name = if windows { "sh.exe" } else { "sh" };
    path.is_some_and(|path| std::env::split_paths(path).any(|dir| dir.join(name).is_file()))
}

/// The tools that only read or write tool files, and so may run without a prompt where a
/// harness's frames were recorded. `pandacode_tool_run` is never among them.
pub(crate) fn auto_allowed(name: &str) -> bool {
    name == TOOL_LIST || name == TOOL_SAVE
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Param {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub required: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Author {
    pub session_id: String,
    pub harness: String,
    pub model: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Tool {
    pub name: String,
    #[serde(default)]
    pub id: String,
    pub description: String,
    pub when: String,
    #[serde(default)]
    pub params: Vec<Param>,
    pub script: String,
    #[serde(default = "default_timeout")]
    pub timeout_secs: u64,
    #[serde(default = "first_version")]
    pub version: u64,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
    #[serde(default)]
    pub created_by: Author,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_by: Option<Author>,
    #[serde(default)]
    pub disabled: bool,
}

pub(super) fn same_identity(a: &Tool, b: &Tool) -> bool {
    if !a.id.is_empty() || !b.id.is_empty() {
        a.id == b.id
    } else {
        a.created_at == b.created_at && a.created_by == b.created_by
    }
}

fn default_timeout() -> u64 {
    DEFAULT_TIMEOUT
}
fn first_version() -> u64 {
    1
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Stats {
    pub uses: u64,
    pub failures: u64,
    pub last_used_at: Option<i64>,
    /// Distinct sessions that ran it, newest last, at most `store::MAX_TASKS`.
    pub tasks: Vec<String>,
    pub last_exit: Option<i32>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Scope {
    Global,
    Project,
}

impl Scope {
    fn label(self) -> &'static str {
        match self {
            Self::Global => "global",
            Self::Project => "project",
        }
    }
}

/// `[a-z0-9][a-z0-9-]{1,47}`.
pub(crate) fn valid_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    (2..=48).contains(&bytes.len()) && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit()) && bytes.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

/// `[a-z][a-z0-9_]{0,31}`.
fn valid_param_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    (1..=32).contains(&bytes.len()) && bytes[0].is_ascii_lowercase() && bytes.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'_')
}

/// A control character other than newline and tab, or an invisible formatting character:
/// either can make the text a user approves read differently from what runs.
fn spoofing_problem(field: &str, text: &str) -> Option<String> {
    let found = text.chars().find(|c| (c.is_control() && !matches!(c, '\n' | '\t')) || invisible(*c))?;
    Some(format!("{field} contains U+{:04X}, a control or invisible formatting character", found as u32))
}

fn text_problem(field: &str, text: &str, max: usize) -> Option<String> {
    if text.trim().is_empty() {
        Some(format!("{field} is empty"))
    } else if text.chars().count() > max {
        Some(format!("{field} is over {max} characters"))
    } else {
        spoofing_problem(field, text)
    }
}

impl Tool {
    /// Every limit at once, so an agent fixes all of them in one try.
    fn validate(&self) -> Result<(), String> {
        let mut problems = Vec::new();
        if !valid_name(&self.name) {
            problems.push(format!("name {:?} must match [a-z0-9][a-z0-9-]{{1,47}}", self.name));
        }
        problems.extend(text_problem("description", &self.description, MAX_TEXT));
        problems.extend(text_problem("when", &self.when, MAX_TEXT));
        if self.params.len() > MAX_PARAMS {
            problems.push(format!("at most {MAX_PARAMS} params"));
        }
        for (at, param) in self.params.iter().enumerate() {
            if !valid_param_name(&param.name) {
                problems.push(format!("param name {:?} must match [a-z][a-z0-9_]{{0,31}}", param.name));
            }
            if self.params[..at].iter().any(|earlier| earlier.name == param.name) {
                problems.push(format!("param {} is listed twice", param.name));
            }
            if param.description.chars().count() > MAX_PARAM_TEXT {
                problems.push(format!("param {} description is over {MAX_PARAM_TEXT} characters", param.name));
            }
            problems.extend(spoofing_problem(&format!("param {} description", param.name), &param.description));
        }
        if self.script.len() > MAX_SCRIPT {
            problems.push(format!("script is over {} KB", MAX_SCRIPT / 1024));
        } else if let Some(problem) = text_problem("script", &self.script, MAX_SCRIPT) {
            problems.push(problem);
        }
        if !(MIN_TIMEOUT..=MAX_TIMEOUT).contains(&self.timeout_secs) {
            problems.push(format!("timeoutSecs must be {MIN_TIMEOUT}..={MAX_TIMEOUT}"));
        }
        if problems.is_empty() { Ok(()) } else { Err(format!("Invalid tool: {}.", problems.join("; "))) }
    }
}

/// What an agent sends to `pandacode_tool_save`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Draft {
    name: String,
    description: String,
    when: String,
    #[serde(default)]
    params: Vec<Param>,
    script: String,
    timeout_secs: Option<u64>,
}

/// Saves `draft` as a tool in `dir`: new at version 1, or the next version of the same name.
fn save(dir: &Path, draft: Draft, author: Author, now: i64) -> Result<Tool, String> {
    let mut tool = Tool {
        name: draft.name,
        id: String::new(),
        description: draft.description,
        when: draft.when,
        params: draft.params,
        script: draft.script,
        timeout_secs: draft.timeout_secs.unwrap_or(DEFAULT_TIMEOUT).clamp(MIN_TIMEOUT, MAX_TIMEOUT),
        version: 1,
        created_at: now,
        updated_at: now,
        created_by: author.clone(),
        updated_by: None,
        disabled: false,
    };
    tool.validate()?;
    run::syntax_check(&tool.script)?;
    let _guard = store::lock();
    if let Some(old) = store::try_load(dir, &tool.name)? {
        tool.id = old.id;
        tool.version = old.version + 1;
        tool.created_at = old.created_at;
        tool.created_by = old.created_by;
        tool.updated_by = Some(author);
        tool.disabled = old.disabled;
    } else {
        tool.id = uuid::Uuid::new_v4().simple().to_string();
    }
    store::store(dir, &tool)?;
    Ok(tool)
}

/// The tool `name` as a project's agents see it: the project's own, else the global one.
/// Fails closed with the underlying error if reading a tool file fails (e.g. `EACCES`),
/// so an unreadable project file never falls through to a shadowed global tool of the same name.
fn resolve(base: &Path, project: &str, name: &str) -> Result<Option<(Tool, Scope)>, String> {
    let project_dir = store::scope_dir(base, Some(project))?;
    if let Some(tool) = store::try_load(&project_dir, name)? {
        return Ok(Some((tool, Scope::Project)));
    }
    let global_dir = store::scope_dir(base, None)?;
    Ok(store::try_load(&global_dir, name)?.map(|tool| (tool, Scope::Global)))
}

/// Every tool a project's agents see, a project tool hiding a global one of the same name.
fn visible(base: &Path, project: &str) -> Vec<(Tool, Stats, Scope)> {
    let mut seen = Vec::new();
    for (scope, id) in [(Scope::Project, Some(project)), (Scope::Global, None)] {
        let Ok(dir) = store::scope_dir(base, id) else { continue };
        let mut stats = store::read_stats(&dir);
        for tool in store::load_all(&dir) {
            if !seen.iter().any(|(shown, _, _): &(Tool, Stats, Scope)| shown.name == tool.name) {
                let used = stats.remove(&tool.name).unwrap_or_default();
                seen.push((tool, used, scope));
            }
        }
    }
    seen
}
