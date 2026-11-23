//! Explicit boundaries for shell/script writes that provider events cannot name.
use super::*;
use crate::providers::{ToolActivity, ToolHost};
use serde_json::{json, Value};

pub(crate) const TOOL: &str = "pandacode_track_files";

#[path = "claude_policy.rs"]
mod claude_policy;
#[cfg(test)]
pub(crate) use claude_policy::edits_wait_for_approval;
#[cfg(test)]
use claude_policy::*;
pub(crate) use claude_policy::{
    claude_restricts_reads, edits_wait_for_run, host_managed_settings_paths, project_config_roots,
    resolve_claude_config_dir_env,
};

/// The tracking instruction, the same for every run: every edit batch, native tools included,
/// begins a capture first, which is correct whether or not native edits wait for approval.
/// It is part of the cached app instructions (Claude's `--append-system-prompt`), so it must
/// not depend on the run's mode, allow rules or connection: a different prefix would make the
/// harness rewrite the whole history's cache. Runs whose native edits wait for approval learn
/// from `turn_note` in the turn's own message that they may skip the native-edit handshake.
pub(crate) fn instruction() -> &'static str {
    "\n\nFile change tracking: when pandacode_track_files is available, before any file-edit batch (native editing tools, shell commands, or scripts), call pandacode_track_files with action begin and the exact project-relative paths you intend to modify (include both paths for a rename). After that batch finishes, call action complete with the returned captureId and only the paths you actually changed. Do not report files changed by other tasks or the user, and do not use Git status as ownership evidence. Always begin the capture before editing and await its result; provider notifications alone may arrive after a fast write."
}

/// One line added to the turn's message when `edits_wait` (`edits_wait_for_run`, for a run that
/// lists the tracking tool): native edit tools wait for approval, so their baseline is taken in
/// time and only shell or script edits need the handshake. In the message, not the cached
/// system prompt, so switching modes never rewrites the cache.
pub(crate) fn turn_note(edits_wait: bool) -> Option<&'static str> {
    edits_wait.then_some(EDITS_NOTE)
}

const EDITS_NOTE: &str = "\n\n(This turn your native edit tools are tracked automatically: call pandacode_track_files begin/complete only around shell commands or scripts that edit files.)";

/// Keep the catalog stable across resumed turns; control-only turns have no tracker.
pub(crate) fn with_host(
    base: Option<ToolHost>,
    tracker: Option<Arc<Mutex<Tracker>>>,
    stopped: Arc<AtomicBool>,
) -> ToolHost {
    let mut tools = base
        .as_ref()
        .map_or_else(Vec::new, |host| host.tools.clone());
    tools.push(json!({"type":"function","name":TOOL,
        "description":"Track this task's file edits (shell commands and scripts, and native edit tools unless the turn's message says they are tracked automatically). Before writing, begin a capture of exact project-relative paths; after, complete that capture with only paths actually changed. Does not edit files or authorize writes. Include source and destination of a rename. Do not report other tasks' or user edits.",
        "inputSchema":{"type":"object","properties":{
            "action":{"type":"string","enum":["begin","complete"]},
            "paths":{"type":"array","items":{"type":"string","minLength":1,"maxLength":4096},"maxItems":200},
            "captureId":{"type":"string","maxLength":256}},"required":["action","paths"],"additionalProperties":false}}));
    ToolHost {
        tools,
        approval_tools: base
            .as_ref()
            .map_or_else(Default::default, |host| host.approval_tools.clone()),
        handler: Arc::new(move |name, args| {
            let (base, tracker, stopped) = (base.clone(), tracker.clone(), stopped.clone());
            Box::pin(async move {
                if stopped.load(Ordering::SeqCst) {
                    return Err("Task has stopped.".into());
                }
                if name != TOOL {
                    return match base {
                        Some(base) => (base.handler)(name, args).await,
                        None => Err("Unknown PandaCode tool.".into()),
                    };
                }
                let tracker = tracker.ok_or("No file tracking is active for this turn.")?;
                tauri::async_runtime::spawn_blocking(move || {
                    if stopped.load(Ordering::SeqCst) {
                        return Err("Task has stopped.".into());
                    }
                    tracker
                        .lock()
                        .map_err(|_| "File tracking is unavailable.".to_string())?
                        .report(args)
                })
                .await
                .map_err(|_| "File tracking could not complete.".to_string())?
            })
        }),
    }
}

impl Tracker {
    fn report(&mut self, args: Value) -> Result<Value> {
        if !self.dirty_since_boundary {
            return Err("This turn has already completed.".into());
        }
        let paths = args["paths"]
            .as_array()
            .ok_or("Provide exact project-relative paths.")?;
        if paths.len() > CHANGE_FILES {
            return Err("Report at most 200 paths per batch.".into());
        }
        let paths: Vec<String> = paths.iter().map(|path| {
            let path = path.as_str().filter(|p| safe_relative(p)).ok_or("Every path must be relative to this task's folder, without parent traversal or .git.")?;
            self.relative_path(path).ok_or_else(|| "Every path must be relative to this task's folder, without parent traversal or .git.".to_string())
        }).collect::<Result<_>>()?;
        let action = args["action"].as_str().ok_or("Choose begin or complete.")?;
        let id = match action {
            "begin" if !paths.is_empty() => format!("reported:{}", storage::id()),
            "complete" => {
                let id = args["captureId"]
                    .as_str()
                    .filter(|id| id.starts_with("reported:"))
                    .ok_or("Provide this batch's captureId.")?;
                let pending = self
                    .pending
                    .get(id)
                    .ok_or("This capture is unavailable or already completed.")?;
                if paths.iter().any(|path| !pending.known.contains(path)) {
                    return Err("A completed path was not included when this batch began.".into());
                }
                id.to_string()
            }
            _ => return Err("Begin requires at least one path; choose begin or complete.".into()),
        };
        self.observe_tool(
            &id,
            &ToolActivity {
                id: id.clone(),
                name: TOOL.into(),
                status: if action == "begin" {
                    "running"
                } else {
                    "completed"
                }
                .into(),
                input: String::new(),
                output: String::new(),
                write_paths: Some(paths.clone()),
            },
        );
        if action == "begin"
            && !self.pending.get(&id).is_some_and(|pending| {
                paths
                    .iter()
                    .all(|path| pending.entries.contains_key(path) || pending.absent.contains(path))
            })
        {
            self.pending.remove(&id);
            return Err(
                "A baseline could not be captured for every path; this batch cannot be tracked."
                    .into(),
            );
        }
        Ok(json!({"captureId":id,"status":if action == "begin" {"started"} else {"completed"}}))
    }
}

#[cfg(test)]
#[path = "host_tests.rs"]
mod tests;
