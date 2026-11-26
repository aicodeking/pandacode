//! Explicit boundaries for shell/script writes that provider events cannot name.
use super::*;
use crate::providers::{ToolActivity, ToolHost};
use serde_json::{json, Value};

pub(crate) const TOOL: &str = "pandacode_track_files";

pub(crate) fn instruction() -> &'static str {
    "\n\nFile change tracking: when pandacode_track_files is available, before any file-edit batch (native editing tools, shell commands, or scripts), call pandacode_track_files with action begin and the exact project-relative paths you intend to modify (include both paths for a rename). After that batch finishes, call action complete with the returned captureId and only the paths you actually changed. Do not report files changed by other tasks or the user, and do not use Git status as ownership evidence. Always begin the capture before editing and await its result; provider notifications alone may arrive after a fast write."
}

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
        "description":"Track this task's file edits, including native tools, shell commands and scripts. Before writing, begin a capture of exact project-relative paths. After writing, complete that capture with only paths actually changed. Does not edit files or authorize writes. Include source and destination of a rename. Do not report other tasks' or user edits.",
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
mod tests {
    use super::*;

    fn assert_reported_path_spelling(begin_path: &str, complete_path: &str) {
        let f = crate::turn_changes::tests::Fixture::new(false);
        f.write("src/ours.txt", "before batch\n");
        let mut tracker = Tracker::start(f.root.clone(), f.cache.clone());
        let begun = tracker
            .report(json!({"action":"begin","paths":[begin_path]}))
            .unwrap();
        f.write("src/ours.txt", "before batch\nour edit\n");
        tracker
            .report(json!({"action":"complete","captureId":begun["captureId"],"paths":[complete_path]}))
            .unwrap();
        let captured = tracker.finish().unwrap();
        assert_eq!(captured.summary.files.len(), 1);
        assert_eq!(captured.summary.files[0].path, "src/ours.txt");
        assert_eq!((captured.summary.additions, captured.summary.deletions), (1, 0));
        assert!(!captured.summary.truncated);
        assert!(captured.details[0].patch.contains("+our edit"));
    }

    #[test]
    fn reported_paths_normalize_repeated_separators_at_begin_and_complete() {
        for (begin, complete) in [
            ("src//ours.txt", "src/ours.txt"),
            ("src/ours.txt", "src//ours.txt"),
            ("src//ours.txt", "src//ours.txt"),
        ] {
            assert_reported_path_spelling(begin, complete);
        }
    }

    #[cfg(windows)]
    #[test]
    fn reported_windows_paths_normalize_backslashes_at_begin_and_complete() {
        for (begin, complete) in [
            (r"src\ours.txt", "src/ours.txt"),
            ("src/ours.txt", r"src\ours.txt"),
            (r"src\ours.txt", r"src\ours.txt"),
        ] {
            assert_reported_path_spelling(begin, complete);
        }
    }

    #[tokio::test]
    async fn reported_shell_batch_is_scoped_frozen_and_cannot_be_reused_by_another_task() {
        let f = crate::turn_changes::tests::Fixture::new(false);
        f.write("ours.txt", "dirty before batch\n");
        let tracker = Arc::new(Mutex::new(Tracker::start(f.root.clone(), f.cache.clone())));
        let stopped = Arc::new(AtomicBool::new(false));
        let host = with_host(None, Some(tracker.clone()), stopped.clone());
        let begun = (host.handler)(TOOL.into(), json!({"action":"begin","paths":["ours.txt"]}))
            .await
            .unwrap();
        // A native edit within an acknowledged batch must not replace its
        // earlier baseline, even if the notification arrives after the write.
        f.write("ours.txt", "dirty before batch\nour script edit\n");
        let native = ToolActivity {
            id: "native".into(),
            name: "Write".into(),
            status: "running".into(),
            input: String::new(),
            output: String::new(),
            write_paths: Some(vec!["ours.txt".into()]),
        };
        tracker.lock().unwrap().observe_tool("native", &native);
        tracker.lock().unwrap().observe_tool(
            "native",
            &ToolActivity {
                status: "completed".into(),
                ..native
            },
        );
        f.write("external.txt", "someone else\n");
        let other = with_host(
            None,
            Some(Arc::new(Mutex::new(Tracker::start(
                f.root.clone(),
                f.cache.clone(),
            )))),
            stopped.clone(),
        );
        let completed =
            json!({"action":"complete","captureId":begun["captureId"],"paths":["ours.txt"]});
        assert!((other.handler)(TOOL.into(), completed.clone())
            .await
            .is_err());
        assert!((host.handler)(
            TOOL.into(),
            json!({"action":"complete","captureId":begun["captureId"],"paths":["external.txt"]})
        )
        .await
        .is_err());
        (host.handler)(TOOL.into(), completed.clone())
            .await
            .unwrap();
        assert!((host.handler)(TOOL.into(), completed).await.is_err());
        f.write("ours.txt", "later editor change\n");
        let captured = tracker.lock().unwrap().finish().unwrap();
        assert_eq!(captured.summary.files.len(), 1);
        assert_eq!(captured.summary.files[0].path, "ours.txt");
        assert_eq!(
            (captured.summary.additions, captured.summary.deletions),
            (1, 0)
        );
        assert!(captured.details[0].patch.contains("+our script edit"));
        assert!(!captured.details[0].patch.contains("later editor change"));
    }

    #[tokio::test]
    async fn report_tool_rejects_traversal_and_stopped_tasks_and_preserves_base_tools() {
        let f = crate::turn_changes::tests::Fixture::new(false);
        let tracker = Arc::new(Mutex::new(Tracker::start(f.root.clone(), f.cache.clone())));
        let stopped = Arc::new(AtomicBool::new(false));
        let base = ToolHost {
            tools: vec![],
            approval_tools: ["other".into()].into(),
            handler: Arc::new(|name, args| {
                Box::pin(async move { Ok(json!({"name":name,"args":args})) })
            }),
        };
        let host = with_host(Some(base), Some(tracker), stopped.clone());
        assert!(host.approval_tools.contains("other"));
        assert_eq!(
            (host.handler)("other".into(), json!({"hello":true}))
                .await
                .unwrap()["args"]["hello"],
            true
        );
        for path in ["../outside", "src/../outside", ".git/config", ".GIT/config", "src//.git/config", "/tmp/absolute"] {
            assert!(
                (host.handler)(TOOL.into(), json!({"action":"begin","paths":[path]}))
                    .await
                    .is_err()
            );
        }
        stopped.store(true, Ordering::SeqCst);
        assert!(
            (host.handler)(TOOL.into(), json!({"action":"begin","paths":["file.txt"]}))
                .await
                .is_err()
        );
    }
}
