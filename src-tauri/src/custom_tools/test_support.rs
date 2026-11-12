//! Test and benchmark helpers for agent-made tools (`custom_tools_mcp_serve`, the MCP host's
//! approval tests, the catalog tests); compiled only under `cfg(test)`.
use super::{save, visible, Author, Draft, Param};
use std::path::Path;

/// The tools over nothing else for `project` in `base`, run in `root`, as `with_custom_tools`
/// builds them for a task, for the MCP host's approval tests (they have no app).
pub(crate) fn test_host(base: std::path::PathBuf, project: &str, root: std::path::PathBuf, session: &str, mode: &str) -> crate::providers::ToolHost {
    composed(None, base, project, root, session, mode)
}

/// A project's `Catalog::definitions`, as `run_host` receives them.
pub(crate) fn test_definitions(base: &Path, project: &str) -> Vec<serde_json::Value> {
    super::host::Catalog::read(base.to_owned(), project.into(), std::path::PathBuf::new()).definitions()
}

/// For the benchmark server (`custom_tools_mcp_serve`): `test_host` composed onto `base`, in
/// Full access so a run never waits for an approval.
pub(crate) fn bench_host(base: Option<crate::providers::ToolHost>, tools_dir: std::path::PathBuf, project: &str, root: std::path::PathBuf, session: &str) -> crate::providers::ToolHost {
    composed(base, tools_dir, project, root, session, "full")
}

fn composed(base: Option<crate::providers::ToolHost>, tools_dir: std::path::PathBuf, project: &str, root: std::path::PathBuf, session: &str, mode: &str) -> crate::providers::ToolHost {
    let author = Author { session_id: session.into(), ..Author::default() };
    super::host::turn_host(base, super::host::Catalog::read(tools_dir, project.into(), root), author, std::sync::Arc::default(), mode, Box::new(|| {}))
}

/// For the benchmark: the catalog note `message_note` adds to a new task's first message.
pub(crate) fn bench_note(tools_dir: &Path, project: &str) -> Option<String> {
    Some(super::host::note_text(&super::host::catalog_text(visible(tools_dir, project))))
}

/// Saves a project tool directly, for the MCP host's approval tests.
pub(crate) fn test_save(base: &Path, project: &str, name: &str, script: &str) {
    let dir = super::store::scope_dir(base, Some(project)).unwrap();
    let draft = Draft { name: name.into(), description: "d".into(), when: "w".into(), params: vec![Param { name: "x".into(), description: String::new(), required: false }], script: script.into(), timeout_secs: None };
    save(&dir, draft, Author::default(), 1).unwrap();
}
