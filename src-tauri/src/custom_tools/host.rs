//! The agent side: `pandacode_tool_save`, `pandacode_tool_run` and `pandacode_tool_list`.
use super::{
    approval::{self, Place},
    one_line, run, save, store, visible, Author, Draft, Scope, Stats, Tool, CHANGED_EVENT, TOOL_LIST, TOOL_RUN, TOOL_SAVE,
};
use crate::{agent_tools::spec, design::listed, providers::ToolHost, AppState};
use serde_json::{json, Value};
use crate::session_state::{self, Note};
use sha2::{Digest, Sha256};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tauri::{Emitter, Manager};

/// Tools listed in the per-message note, and the bytes they may take.
const CATALOG_TOOLS: usize = 25;
pub(super) const CATALOG_BYTES: usize = 2048;
/// The note is sent again every this many messages, even when the catalog is unchanged.
const NOTE_EVERY: u64 = 8;
/// Each tool's `when` in the note, at most, in characters; `pandacode_tool_list` shows it all.
pub(super) const NOTE_WHEN: usize = 120;

const RUN_DESCRIPTION: &str = "Run a saved project tool: a reusable shell script made by an agent in this project, or a global one. args maps each param to a string; the script reads it as $PC_<PARAM>. Runs in the task's checkout and asks the user first unless the task has Full access. Returns {exit, stdout, stderr} (the tail of each). A run is cut at its timeoutSecs, at most 50 s; split longer work or run it directly. Prefer a saved tool over retyping the same commands. Messages name this project's tools; pandacode_tool_list lists them all.";

pub(super) const SAVE_DESCRIPTION: &str = "Save a reusable shell command as a project tool. You and every other agent in this project can then run it with pandacode_tool_run.

Make one when:
- you are about to run a sequence that will clearly come up again. Examples: a build with flags, a test subset, a log or data query, a codegen step, a lint-then-fix chain; or
- you have run the same multi-step command sequence twice in this project.

Don't make one when:
- the command is a one-off;
- one plain command already does it;
- an existing tool covers it. Update that tool instead: save with the same name, which bumps its version.

A good tool:
- has one job and a verb-noun name, such as run-e2e-subset;
- has a `description` that says what it prints;
- has a `when` that names the situation it fits;
- takes params for what changes between uses. Params reach the script as $PC_<NAME>, so quote them;
- is safe to re-run;
- finishes within 50 s (longer work: split it or run it directly);
- exits non-zero on failure;
- prints only what the next step needs.

After saving, check it by running its commands directly (or with pandacode_tool_run in Full access). Fix it if it fails.";

const LIST_DESCRIPTION: &str = "List this project's saved tools and the global ones: name, when to use it, params, version, uses, scope and whether it is disabled. Run one with pandacode_tool_run.";

/// Whether a run gets the tools: never for a cloud agent, whose checkout is on its machine,
/// nor where `sh` cannot be found (`super::shell_available`). A mirror task is refused later
/// by `Store::workspace_root`, which finds no checkout here.
pub(crate) fn offered(cloud: bool) -> bool {
    !cloud && super::shell_available()
}

fn signature(tool: &Tool) -> String {
    let params: Vec<String> = tool.params.iter().map(|p| if p.required { p.name.clone() } else { format!("{}?", p.name) }).collect();
    format!("{}({})", tool.name, params.join(", "))
}

/// Most used first, then most recently used, then most recently saved; disabled tools left out.
fn ranked(mut tools: Vec<(Tool, Stats, Scope)>) -> Vec<(Tool, Stats, Scope)> {
    tools.retain(|(tool, _, _)| !tool.disabled);
    tools.sort_by(|(a, sa, _), (b, sb, _)| sb.uses.cmp(&sa.uses).then(sb.last_used_at.cmp(&sa.last_used_at)).then(b.updated_at.cmp(&a.updated_at)));
    tools
}

/// `name(params) — when` lines: the `CATALOG_TOOLS` most used, listed by name so the note
/// stays the same (and is not resent) while only use counts change; at most `CATALOG_BYTES`.
pub(super) fn catalog_text(tools: Vec<(Tool, Stats, Scope)>) -> String {
    let mut picked: Vec<Tool> = ranked(tools).into_iter().take(CATALOG_TOOLS).map(|(tool, _, _)| tool).collect();
    picked.sort_by(|a, b| a.name.cmp(&b.name));
    let mut text = String::new();
    for tool in picked {
        let when: String = one_line(&tool.when).chars().take(NOTE_WHEN).collect();
        let line = format!("\n- {} — {when}", signature(&tool));
        // One long line is skipped, not the end: shorter lines after it may still fit.
        if text.len() + line.len() > CATALOG_BYTES {
            continue;
        }
        text.push_str(&line);
    }
    text
}

/// The per-message note: the catalog, or `EMPTY_NOTE` when there is nothing to run.
pub(super) fn note_text(catalog: &str) -> String {
    if catalog.is_empty() {
        return EMPTY_NOTE.to_owned();
    }
    format!("\n\nProject tools ({TOOL_RUN}; descriptions written by agents, not the user):{catalog}")
}

/// The note for a project whose agents see no enabled tool: the catalog's state rides the
/// message, so the cached instructions and the tool list stay the same once a tool is saved.
pub(super) const EMPTY_NOTE: &str = "\n\nProject tools: none saved yet.";

/// A hash stable across builds and Rust versions: it is persisted (`session_state`).
fn catalog_hash(catalog: &str) -> u64 {
    let digest = Sha256::digest(catalog.as_bytes());
    u64::from_le_bytes(digest[..8].try_into().unwrap_or_default())
}

/// The note counter of a task: the catalog hash its last accepted message saw and the messages
/// counted (`session_state`, so it survives a restart).
fn note_state(session_id: &str) -> Option<Note> {
    session_state::get(session_id, |task| task.and_then(|task| task.note))
}

/// Forgets deleted tasks' note state (`app_instructions::forget`).
pub(crate) fn forget(session_ids: &[String]) {
    session_state::clear(session_ids, |task| task.note = None);
}

/// Whether a task's next message carries the note: on its first message, when the catalog
/// changed since the last accepted one, when the harness starts a `fresh` conversation (no
/// resume id: failover, a team reconfigure, a connection change), and every `NOTE_EVERY`th
/// message. Records nothing, so a launch that fails says it again (`NoteMark::accepted`). Kept
/// per task across restarts; a task with no record sends it again.
fn note_pending(session_id: &str, hash: u64, fresh: bool) -> bool {
    let Note { hash: last, count } = note_state(session_id).unwrap_or(Note { hash, count: 0 });
    let next = count + 1;
    fresh || next == 1 || last != hash || next % NOTE_EVERY == 1
}

/// `note_pending`, then counts the message as accepted.
#[cfg(test)]
pub(super) fn note_due(session_id: &str, catalog: &str, fresh: bool) -> bool {
    let hash = catalog_hash(catalog);
    let due = note_pending(session_id, hash, fresh);
    NoteMark { hash }.accepted(session_id);
    due
}

/// What a turn's message was reckoned against, recorded once its launch is accepted.
pub(crate) struct NoteMark {
    hash: u64,
}

impl NoteMark {
    /// The launch was accepted: counts the message and remembers the catalog it saw.
    pub(crate) fn accepted(self, session_id: &str) {
        session_state::update(session_id, |task| {
            let count = task.note.map_or(0, |note| note.count);
            task.note = Some(Note { hash: self.hash, count: count + 1 });
        });
    }
}

/// A task's tools as one turn sees them, read once so its message note (`message_note`) and
/// host (`with_custom_tools`) cannot disagree.
pub(crate) struct Catalog {
    base: PathBuf,
    project: String,
    root: PathBuf,
    text: String,
}

impl Catalog {
    pub(super) fn read(base: PathBuf, project: String, root: PathBuf) -> Self {
        Self { text: catalog_text(visible(&base, &project)), base, project, root }
    }
    /// Marks this turn's message for `NoteMark::accepted`.
    pub(crate) fn note_mark(&self) -> NoteMark {
        NoteMark { hash: catalog_hash(&self.text) }
    }
    /// Every tool's real definition for this catalog (`definitions`).
    pub(crate) fn definitions(&self) -> Vec<Value> {
        super::definitions()
    }
}

pub(crate) fn definitions() -> Vec<Value> {
    specs(false)
}

/// The turn's catalog, or `None` when the task has no checkout here (a mirror) or no app data:
/// then the turn is offered no tools.
pub(crate) fn catalog(app: &tauri::AppHandle, session_id: &str) -> Option<Catalog> {
    let (base, project, root) = place(app, session_id)?;
    Some(Catalog::read(base, project, root))
}

/// Whether `catalog` would return one, without reading any tool file: only the store lookup
/// `place` makes (for the warm key's launch inputs, `launch_inputs` in `launch_host.rs`).
pub(crate) fn has_catalog(app: &tauri::AppHandle, session_id: &str) -> bool {
    place(app, session_id).is_some()
}

/// The note for a task's next message, from its project's tools and the global ones; `fresh`
/// when the harness starts a new conversation (see `note_pending`).
pub(crate) fn message_note(catalog: &Catalog, session_id: &str, fresh: bool) -> Option<String> {
    note_pending(session_id, catalog_hash(&catalog.text), fresh).then(|| note_text(&catalog.text))
}

/// Where a local task's tools live: app data and its project, or `None` for a task with no
/// checkout here (a mirror) or no app data.
fn place(app: &tauri::AppHandle, session_id: &str) -> Option<(PathBuf, String, PathBuf)> {
    let dir = app.path().app_data_dir().ok()?;
    let state = app.state::<AppState>();
    let store = state.store.lock().ok()?;
    let task = store.session(session_id).ok()?;
    let root = store.workspace_root(&task.project_id, Some(session_id)).ok()?;
    Some((super::ipc::base_dir(&dir), task.project_id, root))
}

/// The tool specs for a turn; Plan mode only lists. They never depend on whether the project
/// has tools (that rides the message note), so a first save changes neither the tool list nor
/// the warm key. A name left out here is still listed and refused when the conversation may
/// hold it or will list it on a later turn (`app_instructions::Layers::hold`, `standard_names`).
pub(super) fn specs(plan: bool) -> Vec<Value> {
    let list = spec("tool_list", LIST_DESCRIPTION, json!({}), &[]);
    if plan {
        return listed(vec![list]);
    }
    let param = json!({"type":"object","properties":{"name":{"type":"string"},"description":{"type":"string"},"required":{"type":"boolean"}},"required":["name"]});
    let save = spec(
        "tool_save",
        SAVE_DESCRIPTION,
        json!({
            "name": {"type":"string","description":"verb-noun, [a-z0-9-]"},
            "description": {"type":"string","description":"What it does and prints; at most 300 characters"},
            "when": {"type":"string","description":"The situation it fits; at most 300 characters"},
            "params": {"type":"array","maxItems":8,"items":param},
            "script": {"type":"string","description":"POSIX sh body; params as \"$PC_<NAME>\""},
            "timeoutSecs": {"type":"integer","description":"Seconds, 5 to 50 (default 50): at most 50 s; split longer work or run it directly"},
        }),
        &["name", "description", "when", "script"],
    );
    let run = spec(
        "tool_run",
        RUN_DESCRIPTION,
        json!({"name": {"type":"string"}, "args": {"type":"object","description":"param name → string value"}}),
        &["name"],
    );
    listed(vec![list, save, run])
}

/// What every call of one turn shares.
pub(super) struct Ctx {
    pub base: PathBuf,
    pub project: String,
    pub root: PathBuf,
    pub author: Author,
    /// Full access: runs need no approval, so a run without one loads the current version.
    pub full: bool,
    pub changed: Box<dyn Fn() + Send + Sync>,
}

pub(super) fn list(ctx: &Ctx) -> Value {
    let tools: Vec<Value> = visible(&ctx.base, &ctx.project)
        .into_iter()
        .map(|(tool, stats, scope)| json!({"name": tool.name, "when": one_line(&tool.when), "description": one_line(&tool.description), "params": tool.params, "version": tool.version, "uses": stats.uses, "scope": scope, "disabled": tool.disabled}))
        .collect();
    json!({"tools": tools})
}

pub(super) fn save_call(ctx: &Ctx, args: Value) -> Result<Value, String> {
    let draft: Draft = serde_json::from_value(args).map_err(|e| format!("Invalid arguments: {e}"))?;
    let asked = draft.timeout_secs;
    let dir = store::scope_dir(&ctx.base, Some(&ctx.project))?;
    let tool = save(&dir, draft, ctx.author.clone(), crate::storage::now())?;
    (ctx.changed)();
    let mut reply = json!({"saved": tool.name, "version": tool.version, "scope": "project", "run": "pandacode_tool_run {name, args}"});
    if let Some(asked) = asked.filter(|asked| *asked != tool.timeout_secs) {
        reply["note"] = json!(format!("timeoutSecs {asked} is outside 5 to 50; saved with {}. A run gets at most 50 s: split longer work or run it directly.", tool.timeout_secs));
    }
    Ok(reply)
}

/// The tool a call runs: the snapshot its approval showed, or in Full access (no approval)
/// the current version. Outside Full access a call without an approval runs nothing.
fn approved_tool(ctx: &Ctx, token: Option<String>, name: &str) -> Result<(Tool, Scope), String> {
    match token {
        Some(token) => approval::take(&token, &ctx.author.session_id, name).ok_or_else(|| "This approval is no longer valid; call pandacode_tool_run again.".to_owned()),
        None if ctx.full => super::resolve(&ctx.base, &ctx.project, name)?.ok_or_else(|| format!("No tool named {name} in this project.")),
        None => Err("pandacode_tool_run runs only after the user approves it in PandaCode; call it again.".into()),
    }
}

pub(super) async fn run_call(ctx: Arc<Ctx>, mut args: Value, stopped: Arc<AtomicBool>) -> Result<Value, String> {
    let token = approval::strip(&mut args);
    let name = args["name"].as_str().ok_or("name is required.")?.to_owned();
    if args.as_object().is_some_and(|map| map.keys().any(|key| key != "name" && key != "args")) {
        return Err("Only name and args are accepted.".into());
    }
    let (tool, scope) = approved_tool(&ctx, token, &name)?;
    if tool.disabled {
        return Err(format!("The tool {name} is disabled in Settings."));
    }
    let tool_for_stats = tool.clone();
    let outcome = run::execute_async(ctx.root.clone(), tool, args["args"].clone(), stopped).await;
    if outcome.exit.is_some() || outcome.timed_out {
        let base = ctx.base.clone();
        let project = ctx.project.clone();
        let session = ctx.author.session_id.clone();
        let exit = outcome.exit;
        let recorded = crate::blocking(move || store::record_for_tool(&base, &project, scope, &tool_for_stats, &session, exit, crate::storage::now())).await;
        match recorded {
            Ok(true) => (ctx.changed)(),
            Ok(false) => {}
            Err(error) => eprintln!("PandaCode: could not record tool stats: {error}"),
        }
    }
    outcome.reply
}

/// The tools over `base`, reading the catalog now; Plan mode only lists.
#[cfg(test)]
pub(super) fn host(base: Option<ToolHost>, ctx: Ctx, stopped: Arc<AtomicBool>, plan: bool) -> ToolHost {
    host_for(base, ctx, stopped, plan)
}

/// The tools over `base`; Plan mode only lists.
pub(super) fn host_for(base: Option<ToolHost>, ctx: Ctx, stopped: Arc<AtomicBool>, plan: bool) -> ToolHost {
    let mut tools = base.as_ref().map_or_else(Vec::new, |host| host.tools.clone());
    let mut approval_tools = base.as_ref().map_or_else(Default::default, |host| host.approval_tools.clone());
    let offered = specs(plan);
    let names: Vec<String> = offered.iter().filter_map(|spec| spec["name"].as_str().map(str::to_owned)).collect();
    if names.iter().any(|name| name == TOOL_RUN) {
        approval_tools.insert(TOOL_RUN.to_owned());
    }
    tools.extend(offered);
    let ctx = Arc::new(ctx);
    ToolHost {
        tools,
        approval_tools,
        handler: Arc::new(move |name, args| {
            let (base, ctx, stopped, mine) = (base.clone(), ctx.clone(), stopped.clone(), names.contains(&name));
            Box::pin(async move {
                if stopped.load(Ordering::SeqCst) {
                    return Err("Task has stopped.".into());
                }
                match name.as_str() {
                    TOOL_LIST if mine => crate::blocking(move || Ok(list(&ctx))).await,
                    TOOL_SAVE if mine => crate::blocking(move || save_call(&ctx, args)).await,
                    TOOL_RUN if mine => run_call(ctx, args, stopped).await,
                    _ => match base {
                        Some(base) => (base.handler)(name, args).await,
                        None => Err("Unknown PandaCode tool.".into()),
                    },
                }
            })
        }),
    }
}

/// The names a turn outside Plan mode lists for a catalog with these `definitions`: all of
/// them. A Plan turn lists these too, so moving from Plan to Standard does not change the list.
pub(crate) fn standard_names(definitions: &[Value]) -> Vec<String> {
    definitions.iter().filter_map(|spec| spec["name"].as_str()).map(str::to_owned).collect()
}

/// Adds the tools of the turn's `catalog` to a local task's turn.
pub(crate) fn with_custom_tools(base: Option<ToolHost>, catalog: Catalog, app: tauri::AppHandle, author: Author, stopped: Arc<AtomicBool>, mode: &str) -> ToolHost {
    let changed = Box::new(move || {
        let _ = app.emit(CHANGED_EVENT, ());
    });
    turn_host(base, catalog, author, stopped, mode, changed)
}

/// `with_custom_tools` without the app: `changed` is called after a save or a recorded run.
pub(super) fn turn_host(base: Option<ToolHost>, catalog: Catalog, author: Author, stopped: Arc<AtomicBool>, mode: &str, changed: Box<dyn Fn() + Send + Sync>) -> ToolHost {
    let Catalog { base: base_dir, project, root, .. } = catalog;
    approval::register(&author.session_id, Place { base: base_dir.clone(), project: project.clone() });
    let ctx = Ctx { base: base_dir, project, root, author, full: mode == "full", changed };
    host_for(base, ctx, stopped, mode == "plan")
}

/// Records one accepted message for `session_id`.
#[cfg(test)]
pub(crate) fn test_note(session_id: &str) {
    NoteMark { hash: 0 }.accepted(session_id);
}

/// Whether `session_id` has note state.
#[cfg(test)]
pub(crate) fn test_noted(session_id: &str) -> bool {
    note_state(session_id).is_some()
}

#[cfg(test)]
mod note_tests {
    use super::*;

    fn catalog(text: &str) -> Catalog {
        Catalog { base: PathBuf::new(), project: String::new(), root: PathBuf::new(), text: text.to_owned() }
    }

    fn session() -> String {
        format!("note-{}", uuid::Uuid::new_v4())
    }

    #[test]
    fn a_launch_that_fails_does_not_lose_a_changed_catalogs_note() {
        let task = session();
        let (old, new) = (catalog("\n- a() — w"), catalog("\n- a() — w\n- b() — w"));
        assert!(message_note(&old, &task, false).is_some());
        old.note_mark().accepted(&task);
        assert!(message_note(&old, &task, false).is_none(), "an accepted note is not resent");
        // The launch carrying the changed catalog never starts: nothing is recorded.
        assert!(message_note(&new, &task, false).is_some());
        assert!(message_note(&new, &task, false).is_some(), "the retry still carries it");
        new.note_mark().accepted(&task);
        assert!(message_note(&new, &task, false).is_none());
    }

    #[test]
    fn a_first_message_that_fails_is_still_a_first_message() {
        let task = session();
        let note = catalog("\n- a() — w");
        assert!(message_note(&note, &task, false).is_some());
        assert!(message_note(&note, &task, false).is_some());
    }

    #[test]
    fn deleted_tasks_lose_their_note_state() {
        let task = session();
        let note = catalog("\n- a() — w");
        note.note_mark().accepted(&task);
        assert!(message_note(&note, &task, false).is_none());
        crate::app_instructions::forget(std::slice::from_ref(&task));
        assert!(!test_noted(&task));
        assert!(message_note(&note, &task, false).is_some(), "a forgotten task starts over");
    }

    #[test]
    fn standard_names_are_what_a_standard_turn_lists() {
        let listed: Vec<String> = specs(false).iter().filter_map(|spec| spec["name"].as_str().map(str::to_owned)).collect();
        assert_eq!(standard_names(&specs(false)), listed);
        assert_eq!(listed, [TOOL_LIST, TOOL_SAVE, TOOL_RUN]);
        assert!(standard_names(&[]).is_empty(), "no catalog keeps nothing");
    }

    #[test]
    fn an_empty_catalog_rides_the_note_and_changes_no_tool_spec() {
        let empty = Catalog::read(PathBuf::from("/nonexistent-pandacode-tools"), "p".into(), PathBuf::new());
        assert_eq!(empty.definitions(), specs(false));
        let task = session();
        assert_eq!(message_note(&empty, &task, false).as_deref(), Some(EMPTY_NOTE));
    }
}
