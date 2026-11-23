//! How a team worker's Claude Code launch is trimmed: the native tools its role denies, the
//! deferred tools a conversation keeps, and the `PreToolUse` hooks that refuse kept ones
//! (moved from `providers.rs`).
use serde::Serialize;
use serde_json::{json, Value};

use super::CLAUDE_SESSION_BOUND_TOOLS;

/// Claude Code tools a team worker's brief already forbids: native subagents and workflows,
/// other sessions, worktrees and cloud routines. Their definitions and listings ride every
/// request of every step (docs/worker-tokens.md). `TaskStop` stays: it also stops background Bash.
pub(crate) const CLAUDE_WORKER_DENIED_TOOLS: &str = "Agent,Task,Workflow,ListAgents,SendMessage,RemoteTrigger,CronDelete,CronList,EnterWorktree,ExitWorktree";
/// The edit tools a read-only worker is told not to use.
pub(crate) const CLAUDE_READ_ONLY_DENIED_TOOLS: &str = "Edit,Write,NotebookEdit";
/// The denied tools Claude Code defers: history can hold a ToolSearch reference to one, removing
/// its definition invalidates later requests, and adding one changes the deferred-tool list. So
/// a conversation keeps the set it started with (`History::lists_native`); one the role denies
/// but the conversation keeps is refused (`claude_refuses_native`).
pub(super) const CLAUDE_DEFERRED_TOOLS: [&str; 7] = ["SendMessage", "RemoteTrigger", "CronDelete", "CronList", "EnterWorktree", "ExitWorktree", CLAUDE_NOTEBOOK_TOOL];
pub(super) const CLAUDE_NOTEBOOK_TOOL: &str = "NotebookEdit";
/// The `PreToolUse` callback that refuses kept deferred tools (`claude_refusal_hooks`).
pub(super) const CLAUDE_REFUSAL_HOOK: &str = "pandacode-refuse-native";
/// Denied to team workers only while Settings → Agents → Workers can use skills is off (it is on
/// by default, so user rules naming a skill keep working); off saves its listing, about 8k
/// cache-write tokens per worker with a real skills library.
pub(crate) const CLAUDE_SKILL_TOOL: &str = "Skill";

/// How a team worker's Claude Code launch is trimmed (`RunConfig::worker`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerTrim {
    pub read_only: bool,
    /// Settings → Agents → Workers can use skills.
    pub skills: bool,
    /// Settings → Agents → Trim worker tools (`architect::worker_trim_on`, off by default): the
    /// token trim (`CLAUDE_WORKER_DENIED_TOOLS`, `Role::wants`). Read-only enforcement and the
    /// Skill switch apply either way.
    pub trim: bool,
}

/// Every tool `worker`'s role denies, in `--disallowedTools` order.
fn claude_role_denied(worker: Option<WorkerTrim>) -> Vec<&'static str> {
    let mut lists = vec![CLAUDE_SESSION_BOUND_TOOLS];
    if let Some(trim) = worker {
        if trim.trim {
            lists.push(CLAUDE_WORKER_DENIED_TOOLS);
        }
        if trim.read_only {
            lists.push(CLAUDE_READ_ONLY_DENIED_TOOLS);
        }
        if !trim.skills {
            lists.push(CLAUDE_SKILL_TOOL);
        }
    }
    lists.into_iter().flat_map(|list| list.split(',')).collect()
}

/// `--disallowedTools` for a Claude Code launch: `worker` is set for a team worker; `history` is
/// what the conversation may hold, which decides the deferred tools.
pub(crate) fn claude_disallowed_tools(worker: Option<WorkerTrim>, history: &crate::app_instructions::History) -> String {
    let role = claude_role_denied(worker);
    // Keep NotebookEdit from the first turn: read-only enforcement refuses calls instead of
    // removing a deferred definition that a later writer turn cannot safely add back.
    let kept = |tool: &str| history.lists_native(tool, role.contains(&tool) && tool != CLAUDE_NOTEBOOK_TOOL);
    let denied = role.iter().copied().filter(|tool| !CLAUDE_DEFERRED_TOOLS.contains(tool) || !kept(tool));
    // A deferred tool the role now allows stays denied if the conversation started without it.
    let sticky = CLAUDE_DEFERRED_TOOLS.iter().copied().filter(|tool| !role.contains(tool) && !kept(tool));
    format!("--disallowedTools={}", denied.chain(sticky).collect::<Vec<_>>().join(","))
}

/// The deferred tools a launch leaves defined, for `app_instructions::remember_catalog`.
pub(crate) fn claude_kept_natives(worker: Option<WorkerTrim>, history: &crate::app_instructions::History) -> Vec<String> {
    let role = claude_role_denied(worker);
    CLAUDE_DEFERRED_TOOLS.iter().filter(|tool| history.lists_native(tool, role.contains(*tool) && **tool != CLAUDE_NOTEBOOK_TOOL)).map(|tool| (*tool).to_owned()).collect()
}

/// Whether `name` is a listed deferred tool the worker role forbids calling.
pub(super) fn claude_refuses_native(worker: Option<WorkerTrim>, name: &str) -> bool {
    CLAUDE_DEFERRED_TOOLS.contains(&name) && claude_role_denied(worker).contains(&name)
}

/// The `initialize` hooks of a Claude Code launch. `can_use_tool` is not consulted in
/// bypassPermissions, nor for edits in acceptEdits, so a `PreToolUse` callback refuses the
/// deferred tools a resumed worker keeps. Fresh read-only workers also keep NotebookEdit,
/// so they register its refusal from the first turn; other fresh denied tools are removed.
pub(super) fn claude_refusal_hooks(worker: Option<WorkerTrim>, resumed: bool) -> Value {
    let refused: Vec<&str> = claude_role_denied(worker).into_iter()
        .filter(|tool| CLAUDE_DEFERRED_TOOLS.contains(tool) && (resumed || *tool == CLAUDE_NOTEBOOK_TOOL)).collect();
    if refused.is_empty() {
        return Value::Null;
    }
    json!({"PreToolUse":[{"matcher":refused.join("|"),"hookCallbackIds":[CLAUDE_REFUSAL_HOOK]}]})
}
