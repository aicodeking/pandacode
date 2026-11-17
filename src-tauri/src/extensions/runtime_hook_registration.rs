//! Hooks declared in a package's manifest, attached by its background service and delivered as normalized,
//! content-bearing events inside the package's grants and match filters (runtime phase R5, slice R0503).
//!
//! * **Declaration.** `contributes.hooks[]` (`id`, `event`, `onFailure`, `budgetMs`, `match`) is checked twice with
//!   the same rules: the schema bounds the shape, [`check`] (called by `contracts.rs`, mirrored by
//!   `src/extensions/runtime-hook-registration.ts` for `contracts.ts`) applies the event-dependent rules: one
//!   declaration per event, `onFailure` and `budgetMs` per event, `toolKinds` only on tool events, `extensions` only on
//!   tool events and `save.before`, the permission that receives the event declared, and a background service to
//!   attach it.
//! * **Registration.** `panda.hooks.on(event, handler)` in the service asks the host ([`HookRegistry::register`]): an
//!   event the manifest does not declare answers `UnknownReference`; without the receiving permission
//!   `PermissionDenied`. Disposal unregisters; the end of the service process (stop, crash, disable, uninstall, safe
//!   mode, a revoked `runtime.service`) removes every registration of the package ([`service_stopped`]).
//! * **Delivery.** The app reports what happens to a run (turn start, the submitted prompt, a permission request for a
//!   tool call, a finished tool call, the end of the turn, a compaction); [`HookRegistry`] turns each into its
//!   normalized payload (`HookTurn`, `HookCall` with the complete input of `runtime_hook_payload`, ...) and hands it
//!   to every attached hook whose `match` filter accepts it and whose grant reaches the run's project, checked
//!   natively on every delivery, so a revoked or narrowed grant stops delivery at once.
//! * **Observe only.** Every delivery of this slice is one-way: the host never awaits it and never reads what a
//!   handler returns (`observeOnly: true`, `can: []`). A slow, failing or absent handler therefore never delays the
//!   agent, never approves and never decides; the agent's normal path (the prompt, the call, the turn) is exactly the
//!   one it takes with no package installed. Decisions, context and failure policies are the later R5 slices.
//!
//! Everything here is for predictability and fault isolation (ADR-0005): trust and the named grant are the
//! safeguard; nothing is withheld from a granted package.
use serde_json::{json, Map, Value};
use std::{collections::{BTreeMap, BTreeSet}, sync::{atomic::{AtomicBool, Ordering}, Arc, LazyLock, Mutex}, time::Instant};

/// The permission that receives every hook event except `save.before`.
pub const OBSERVE: &str = "harness.hooks.observe";
/// The permission that receives `save.before`.
pub const EDITORS: &str = "documents.editors";
/// Every hook a manifest may declare.
pub const EVENTS: [&str; 13] = [
    "turn.start", "prompt.submit", "tool.before", "tool.after", "turn.finish", "turn.fail", "task.idle", "compaction",
    "approval.pending", "approval.resolved", "question.pending", "question.resolved", "save.before",
];
/// The events this slice delivers. `approval.*` and `question.*` are delivered by R0507, `save.before` by the
/// documents slice; registering them succeeds already.
pub const DELIVERED: [&str; 8] = ["turn.start", "prompt.submit", "tool.before", "tool.after", "turn.finish", "turn.fail", "task.idle", "compaction"];
/// `HookCall.tool.kind`, normalized per harness.
pub const TOOL_KINDS: [&str; 7] = ["shell", "read", "write", "edit", "search", "fetch", "other"];
/// `HookRun.kind`.
pub const RUN_KINDS: [&str; 5] = ["task", "worker", "bot", "schedule", "remote"];
/// `budgetMs` when the declaration leaves it out.
pub const DEFAULT_BUDGET_MS: u64 = 2_000;
/// Largest tool output a `tool.after` carries (the interface's preview of it); `outputComplete` says whether it was cut.
pub const OUTPUT_BYTES: usize = 8_192;

/// The range of `budgetMs` for events whose handler may answer; `None` for events nothing waits for (a budget there
/// is refused, so a declaration never promises a wait the host does not do).
pub fn budget_range(event: &str) -> Option<(u64, u64)> {
    match event {
        "tool.before" | "tool.after" => Some((100, 30_000)),
        "prompt.submit" | "save.before" => Some((100, 10_000)),
        "compaction" => Some((100, 120_000)),
        _ => None,
    }
}
/// The `onFailure` values an event accepts: `ask` and `deny` for `tool.before`, `deny` also for `prompt.submit`.
pub fn failure_policies(event: &str) -> &'static [&'static str] {
    match event { "tool.before" => &["continue", "ask", "deny"], "prompt.submit" => &["continue", "deny"], _ => &["continue"] }
}
fn tool_event(event: &str) -> bool { matches!(event, "tool.before" | "tool.after") }
fn extension_event(event: &str) -> bool { tool_event(event) || event == "save.before" }
/// The permission that receives `event`.
pub fn permission_of(event: &str) -> &'static str { if event == "save.before" { EDITORS } else { OBSERVE } }

// ---------------------------------------------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------------------------------------------

/// The host-applied filter of a declaration. `None` accepts everything; `harnesses` accepts `"*"`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Match {
    pub tool_kinds: Option<BTreeSet<String>>,
    pub harnesses: Option<BTreeSet<String>>,
    pub runs: Option<BTreeSet<String>>,
    /// Lowercase file extensions with their dot (`.ts`).
    pub extensions: Option<BTreeSet<String>>,
}
/// One `contributes.hooks[]` entry, with its defaults applied.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Declaration { pub id: String, pub event: String, pub on_failure: String, pub budget_ms: u64, pub matcher: Match }
impl Declaration {
    pub fn json(&self) -> Value {
        let mut matcher = Map::new();
        let list = |set: &BTreeSet<String>| json!(set.iter().collect::<Vec<_>>());
        if let Some(kinds) = &self.matcher.tool_kinds { matcher.insert("toolKinds".into(), list(kinds)); }
        if let Some(harnesses) = &self.matcher.harnesses { matcher.insert("harnesses".into(), list(harnesses)); }
        if let Some(runs) = &self.matcher.runs { matcher.insert("runs".into(), list(runs)); }
        if let Some(extensions) = &self.matcher.extensions { matcher.insert("extensions".into(), list(extensions)); }
        json!({"id": self.id, "event": self.event, "onFailure": self.on_failure, "budgetMs": self.budget_ms, "match": matcher})
    }
}

/// A refused declaration: the error code, the manifest-relative place (`contributes/hooks` or `permissions`) and the
/// ids it names. `contracts.rs` prefixes the package path.
#[derive(Debug, PartialEq, Eq)]
pub struct Refusal { pub code: &'static str, pub at: &'static str, pub ids: Vec<String> }
fn refuse(code: &'static str, at: &'static str, id: &str) -> Refusal { Refusal { code, at, ids: vec![id.to_owned()] } }
const HOOKS_AT: &str = "contributes/hooks";

fn set(value: &Value) -> Option<BTreeSet<String>> {
    value.as_array().map(|items| items.iter().filter_map(Value::as_str).map(str::to_owned).collect())
}
fn distinct(value: &Value) -> bool { value.as_array().is_none_or(|items| items.iter().map(Value::to_string).collect::<BTreeSet<_>>().len() == items.len()) }

/// The event-dependent rules of `contributes.hooks`, after the schema checked the shape. The order of the checks is
/// the order of `checkHookDeclarations` in `runtime-hook-registration.ts`, so both validators answer the same first
/// refusal.
pub fn check(manifest: &Value) -> Result<Vec<Declaration>, Refusal> {
    let Some(hooks) = manifest["contributes"]["hooks"].as_array().filter(|hooks| !hooks.is_empty()) else { return Ok(vec![]) };
    let package = manifest["id"].as_str().unwrap_or_default();
    // A hook is attached by the package's background service; without one it could never receive anything.
    if manifest["runtime"]["service"].is_null() { return Err(refuse("UnsupportedRuntime", HOOKS_AT, package)); }
    let permissions: BTreeSet<&str> = manifest["permissions"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
    let (mut ids, mut events, mut out) = (BTreeSet::new(), BTreeSet::new(), Vec::new());
    for hook in hooks {
        let id = hook["id"].as_str().unwrap_or_default();
        let event = hook["event"].as_str().unwrap_or_default();
        if id.starts_with("panda.") { return Err(refuse("ReservedId", HOOKS_AT, id)); }
        if !id.starts_with(&format!("{package}/")) { return Err(refuse("InvalidId", HOOKS_AT, id)); }
        if !ids.insert(id) { return Err(refuse("DuplicateId", HOOKS_AT, id)); }
        if !EVENTS.contains(&event) { return Err(refuse("InvalidShape", HOOKS_AT, id)); }
        if !events.insert(event) { return Err(refuse("DuplicateId", HOOKS_AT, event)); }
        let on_failure = hook["onFailure"].as_str().unwrap_or("continue");
        if !failure_policies(event).contains(&on_failure) { return Err(refuse("InvalidShape", HOOKS_AT, id)); }
        let budget_ms = match hook.get("budgetMs") {
            None => DEFAULT_BUDGET_MS,
            Some(budget) => {
                let (Some(budget), Some((low, high))) = (budget.as_u64(), budget_range(event)) else { return Err(refuse("InvalidShape", HOOKS_AT, id)) };
                if budget < low || budget > high { return Err(refuse("InvalidShape", HOOKS_AT, id)); }
                budget
            }
        };
        let filter = &hook["match"];
        if !filter["toolKinds"].is_null() && !tool_event(event) { return Err(refuse("InvalidShape", HOOKS_AT, id)); }
        if !filter["extensions"].is_null() && !extension_event(event) { return Err(refuse("InvalidShape", HOOKS_AT, id)); }
        if ["toolKinds", "harnesses", "runs", "extensions"].iter().any(|key| !distinct(&filter[*key])) { return Err(refuse("DuplicateId", HOOKS_AT, id)); }
        let matcher = Match {
            tool_kinds: set(&filter["toolKinds"]),
            harnesses: set(&filter["harnesses"]),
            runs: set(&filter["runs"]),
            extensions: set(&filter["extensions"]).map(|extensions| extensions.into_iter().map(|extension| extension.to_lowercase()).collect()),
        };
        if matcher.tool_kinds.as_ref().is_some_and(|kinds| kinds.iter().any(|kind| !TOOL_KINDS.contains(&kind.as_str())))
            || matcher.runs.as_ref().is_some_and(|runs| runs.iter().any(|run| !RUN_KINDS.contains(&run.as_str()))) { return Err(refuse("InvalidShape", HOOKS_AT, id)); }
        if !permissions.contains(permission_of(event)) { return Err(refuse("PermissionDenied", "permissions", package)); }
        out.push(Declaration { id: id.to_owned(), event: event.to_owned(), on_failure: on_failure.to_owned(), budget_ms, matcher });
    }
    Ok(out)
}

// ---------------------------------------------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------------------------------------------

/// `tool.kind` from the harness's tool name (built-in names, ACP kinds and common MCP names); `other` when the name
/// says nothing, then [`kind_of_input`] may still tell from the input.
pub fn tool_kind(name: &str) -> &'static str {
    let lower = name.to_ascii_lowercase();
    let base = lower.rsplit(['.', ':']).next().unwrap_or(&lower);
    let base = base.strip_prefix("mcp__").map_or(base, |rest| rest.rsplit("__").next().unwrap_or(rest));
    match base {
        "bash" | "command" | "shell" | "exec" | "exec_command" | "execute" | "run_terminal_cmd" | "terminal" | "powershell" | "local_shell" | "run_shell_command" => "shell",
        "read" | "read_file" | "readfile" | "view" | "cat" | "notebookread" | "open_file" => "read",
        "write" | "write_file" | "writefile" | "create" | "create_file" => "write",
        "edit" | "multiedit" | "str_replace" | "str_replace_editor" | "str_replace_based_edit_tool" | "apply_patch" | "patch" | "notebookedit" | "replace" | "delete" | "move" => "edit",
        "grep" | "glob" | "search" | "find" | "ls" | "list" | "list_dir" | "codebase_search" | "file_search" | "grep_search" => "search",
        "webfetch" | "fetch" | "websearch" | "web_search" | "web_fetch" | "http" => "fetch",
        _ => "other",
    }
}
/// The kind an input's fields show when the name did not: a `command` is a shell call, `old_string` an edit, a path
/// with `content` a write, a bare path a read.
pub fn kind_of_input(input: &Value) -> &'static str {
    if input["command"].is_string() || input["command"].is_array() { "shell" }
    else if input.get("old_string").is_some() || input.get("patch").is_some() { "edit" }
    else if (input.get("file_path").is_some() || input.get("path").is_some()) && input.get("content").is_some() { "write" }
    else if input["url"].is_string() { "fetch" }
    else if input["pattern"].is_string() || input["query"].is_string() { "search" }
    else { "other" }
}
/// File paths an input names (`file_path`, `filePath`, `path`, `notebook_path`, `paths`), for `extensions` and
/// `writePaths`.
pub fn input_paths(input: &Value) -> Vec<String> {
    let mut paths: Vec<String> = ["file_path", "filePath", "path", "notebook_path"].iter().filter_map(|key| input[*key].as_str()).map(str::to_owned).collect();
    paths.extend(input["paths"].as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_owned));
    paths.retain(|path| !path.is_empty() && path.len() <= 4_096);
    paths.truncate(64);
    paths
}
/// The lowercase extension of a path with its dot (`src/A.TS` gives `.ts`).
pub fn extension_of(path: &str) -> Option<String> {
    let name = path.rsplit(['/', '\\']).next()?;
    let dot = name.rfind('.').filter(|dot| *dot > 0 && *dot + 1 < name.len())?;
    Some(name[dot..].to_lowercase())
}
/// `HookCall.shell` of a shell call: the command as text and its dialect.
pub fn shell(name: &str, input: &Value) -> Option<Value> {
    let command = match &input["command"] {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(" "),
        _ => input["cmd"].as_str()?.to_owned(),
    };
    let lower = name.to_ascii_lowercase();
    let dialect = if lower.contains("powershell") { "powershell" } else if lower == "bash" || lower.ends_with("bash") { "posix" } else if lower == "cmd" { "cmd" } else { "unknown" };
    Some(json!({"dialect": dialect, "command": command}))
}

/// What a run is, for its payloads and the `match` filter. Built once when the turn starts.
#[derive(Clone, Debug, PartialEq)]
pub struct RunFacts {
    pub task_id: String,
    pub project_id: String,
    pub project_root: String,
    pub cwd: String,
    pub harness: String,
    pub model: Option<String>,
    pub mode: String,
    /// `HookRun`: `{ kind, parentTaskId?, workerId?, botId?, hostId? }`.
    pub run: Value,
    /// 1 for the first message of the task.
    pub index: u64,
    /// The user's message (empty for a goal or command run, which submits no prompt).
    pub text: String,
    pub attachments: Vec<Value>,
    pub started_by: Value,
    /// Cursor of the turn's first transcript item for `panda.context.query({ resource: 'transcript' })`.
    pub transcript_cursor: u64,
}
impl RunFacts {
    fn run_kind(&self) -> &str { self.run["kind"].as_str().unwrap_or("task") }
}

/// One normalized occurrence, with what the filter needs beside its payload.
#[derive(Clone, Debug, PartialEq)]
pub struct Occurrence {
    pub event: &'static str,
    pub project: String,
    pub harness: String,
    pub run: String,
    pub tool_kind: Option<String>,
    pub paths: Vec<String>,
    pub payload: Value,
}

/// Whether a declaration's filter accepts an occurrence.
pub fn matches(filter: &Match, occurrence: &Occurrence) -> bool {
    filter.harnesses.as_ref().is_none_or(|harnesses| harnesses.contains("*") || harnesses.contains(&occurrence.harness))
        && filter.runs.as_ref().is_none_or(|runs| runs.contains(&occurrence.run))
        && filter.tool_kinds.as_ref().is_none_or(|kinds| occurrence.tool_kind.as_ref().is_some_and(|kind| kinds.contains(kind)))
        && filter.extensions.as_ref().is_none_or(|extensions| occurrence.paths.iter().any(|path| extension_of(path).is_some_and(|extension| extensions.contains(&extension))))
}

/// `HookTurn` of a run.
pub(crate) fn turn_payload(facts: &RunFacts, since_compaction: u64) -> Map<String, Value> {
    let mut turn = Map::new();
    turn.insert("schemaVersion".into(), json!(1));
    turn.insert("taskId".into(), json!(facts.task_id));
    turn.insert("projectId".into(), json!(facts.project_id));
    turn.insert("projectRoot".into(), json!(facts.project_root));
    turn.insert("harness".into(), json!(facts.harness));
    turn.insert("model".into(), json!(facts.model));
    turn.insert("mode".into(), json!(facts.mode));
    turn.insert("run".into(), facts.run.clone());
    turn.insert("index".into(), json!(facts.index));
    // The text a frame can carry: at most 1 MiB, cut so that escaped it stays inside the 2 MiB hook frame.
    turn.insert("text".into(), json!(super::runtime_hook_payload::preview(&facts.text)));
    if !facts.attachments.is_empty() { turn.insert("attachments".into(), json!(facts.attachments)); }
    turn.insert("sinceCompaction".into(), json!(since_compaction));
    turn.insert("startedBy".into(), facts.started_by.clone());
    turn
}

// ---------------------------------------------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------------------------------------------

/// `(owner, version, permission, project)`: does this package hold `permission` (for this project; `None`: at all)?
pub type Gate = Arc<dyn Fn(&str, &str, &str, Option<&str>) -> bool + Send + Sync>;
/// Hands one frame to the running service of `owner`, without waiting for it.
pub type Deliver = Arc<dyn Fn(&str, Value) -> Result<(), &'static str> + Send + Sync>;
/// Builds the `HookCall` of a recorded call: `runtime_hook_payload::hook_call` in the app and the tests.
pub type CallPayload<'a> = &'a dyn Fn(&Value, &str) -> Result<Value, &'static str>;

struct Attached { version: String, declaration: Declaration, handlers: u32 }
struct Run {
    facts: RunFacts,
    since_compaction: u64,
    started: Instant,
    /// Harness call ids whose `tool.before` was reported, and whose `tool.after` was.
    before: BTreeSet<String>,
    after: BTreeSet<String>,
    tool_calls: u64,
    /// Tool names of the calls whose `tool.before` was reported (for a `tool.after` the harness never reports).
    names: BTreeMap<String, String>,
}
/// `compacted`: turn index of a task's last compaction (for `sinceCompaction`, across turns); `None` when it happened
/// while no turn ran, so the next turn is the first after it. `steps`: compaction steps already counted (R0504).
/// `submitted`: tasks whose next `prompt.submit` the awaited chain already delivered (R0504).
#[derive(Default)]
struct Inner { attached: BTreeMap<(String, String), Attached>, runs: BTreeMap<String, Run>, compacted: BTreeMap<String, Option<u64>>, steps: BTreeSet<String>, submitted: BTreeSet<String>, counters: Counters }
/// `sinceCompaction` of turn `index` of a task.
fn since(inner: &Inner, task: &str, index: u64) -> u64 {
    match inner.compacted.get(task) { Some(Some(at)) => index.saturating_sub(at + 1), Some(None) => 0, None => index.saturating_sub(1) }
}
/// An attached hook a delivery reaches (filter and observe grant checked), for the awaited chains of R0504.
#[derive(Clone, Debug)]
pub struct Target { pub owner: String, pub version: String, pub declaration: Declaration }

/// What one report did, for the counters and the tests.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Published { pub delivered: usize, pub filtered: usize, pub failed: usize }
impl std::ops::AddAssign for Published { fn add_assign(&mut self, other: Self) { self.delivered += other.delivered; self.filtered += other.filtered; self.failed += other.failed; } }
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Counters { pub delivered: u64, pub filtered: u64, pub failed: u64 }

/// Every attached hook and the runs they observe. The app has one ([`registry`]); tests build their own.
#[derive(Default)]
pub struct HookRegistry {
    inner: Mutex<Inner>,
    gate: Mutex<Option<Gate>>,
    deliver: Mutex<Option<Deliver>>,
    /// Any hook attached: the app's reports are free when this is off.
    active: AtomicBool,
    /// The app's registry also switches complete-input recording of built-in runs (`runtime_hook_payload::observed`).
    global: bool,
}

impl HookRegistry {
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> { self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) }
    pub fn set_gate(&self, gate: Gate) { if let Ok(mut slot) = self.gate.lock() { *slot = Some(gate); } }
    pub fn set_deliver(&self, deliver: Deliver) { if let Ok(mut slot) = self.deliver.lock() { *slot = Some(deliver); } }
    fn gate(&self) -> Option<Gate> { self.gate.lock().ok().and_then(|slot| slot.clone()) }
    fn deliverer(&self) -> Option<Deliver> { self.deliver.lock().ok().and_then(|slot| slot.clone()) }
    /// Whether any hook is attached.
    pub fn active(&self) -> bool { self.active.load(Ordering::Acquire) }
    /// Called with the lock held after every change of the attached set.
    fn refresh(&self, inner: &mut Inner) {
        let on = !inner.attached.is_empty();
        self.active.store(on, Ordering::Release);
        // With no hook attached nothing observes a run: its facts go (the next turn starts them again).
        if !on { inner.runs.clear(); }
        if self.global { super::runtime_hook_payload::set_observed(on); }
    }

    /// `panda.hooks.on(event)` of `owner`'s service. `InvalidShape` for a name that is no hook, `UnknownReference` for
    /// an event the manifest does not declare, `PermissionDenied` without the permission that receives it. Answers
    /// the declaration as the host applies it.
    pub fn register(&self, owner: &str, version: &str, declarations: &[Declaration], event: &str) -> Result<Value, &'static str> {
        if !EVENTS.contains(&event) { return Err("InvalidShape"); }
        let declaration = declarations.iter().find(|declaration| declaration.event == event).ok_or("UnknownReference")?;
        if !self.gate().is_some_and(|gate| gate(owner, version, permission_of(event), None)) { return Err("PermissionDenied"); }
        let mut inner = self.lock();
        let entry = inner.attached.entry((owner.to_owned(), event.to_owned())).or_insert_with(|| Attached { version: version.to_owned(), declaration: declaration.clone(), handlers: 0 });
        entry.handlers += 1;
        entry.version = version.to_owned();
        entry.declaration = declaration.clone();
        self.refresh(&mut inner);
        let mut answer = declaration.json();
        answer["observeOnly"] = json!(true);
        answer["delivered"] = json!(DELIVERED.contains(&event));
        Ok(answer)
    }
    /// A handler was disposed; the hook stays attached while another handler of the event lives.
    pub fn unregister(&self, owner: &str, event: &str) -> Result<(), &'static str> {
        if !EVENTS.contains(&event) { return Err("InvalidShape"); }
        let mut inner = self.lock();
        let key = (owner.to_owned(), event.to_owned());
        if let Some(entry) = inner.attached.get_mut(&key) {
            entry.handlers = entry.handlers.saturating_sub(1);
            if entry.handlers == 0 { inner.attached.remove(&key); }
        }
        self.refresh(&mut inner);
        Ok(())
    }
    /// The service of `owner` ended: none of its hooks stays attached. Answers how many were removed.
    pub fn remove_owner(&self, owner: &str) -> usize {
        let mut inner = self.lock();
        let before = inner.attached.len();
        inner.attached.retain(|(attached, _), _| attached != owner);
        let removed = before - inner.attached.len();
        self.refresh(&mut inner);
        removed
    }
    /// Events `owner` has attached.
    pub fn listeners(&self, owner: &str) -> Vec<String> { self.lock().attached.keys().filter(|(attached, _)| attached == owner).map(|(_, event)| event.clone()).collect() }
    /// The package version an attached hook was registered for (the grant `hooks.input` is checked against).
    pub fn version(&self, owner: &str) -> Option<String> { self.lock().attached.iter().find(|((attached, _), _)| attached == owner).map(|(_, entry)| entry.version.clone()) }
    pub fn counters(&self) -> Counters { self.lock().counters }

    /// Hands an occurrence to every attached hook of its event whose filter accepts it and whose grant reaches the
    /// run's project. Never waits, never fails the reporter.
    pub fn publish(&self, occurrence: &Occurrence) -> Published {
        let targets: Vec<(String, String, Declaration)> = self.lock().attached.iter()
            .filter(|((_, event), _)| event == occurrence.event)
            .map(|((owner, _), entry)| (owner.clone(), entry.version.clone(), entry.declaration.clone())).collect();
        let (gate, deliver) = (self.gate(), self.deliverer());
        let mut out = Published::default();
        for (owner, version, declaration) in targets {
            if !matches(&declaration.matcher, occurrence) || !gate.as_ref().is_some_and(|gate| gate(&owner, &version, permission_of(occurrence.event), Some(&occurrence.project))) { out.filtered += 1; continue; }
            let frame = json!({"schemaVersion": 1, "hookId": declaration.id, "event": occurrence.event, "observeOnly": true, "payload": occurrence.payload});
            match deliver.as_ref().map(|deliver| deliver(&owner, frame)) { Some(Ok(())) => out.delivered += 1, _ => out.failed += 1 }
        }
        let mut inner = self.lock();
        inner.counters.delivered += out.delivered as u64; inner.counters.filtered += out.filtered as u64; inner.counters.failed += out.failed as u64;
        out
    }

    fn occurrence(facts: &RunFacts, event: &'static str, payload: Value) -> Occurrence {
        Occurrence { event, project: facts.project_id.clone(), harness: facts.harness.clone(), run: facts.run_kind().to_owned(), tool_kind: None, paths: vec![], payload }
    }

    /// The attached hooks of `occurrence`'s event whose filter accepts it and whose observe grant reaches its project,
    /// in registration order (R0504 asks them one after another). The others count as filtered.
    pub fn targets(&self, occurrence: &Occurrence) -> Vec<Target> {
        let attached: Vec<Target> = self.lock().attached.iter()
            .filter(|((_, event), _)| event == occurrence.event)
            .map(|((owner, _), entry)| Target { owner: owner.clone(), version: entry.version.clone(), declaration: entry.declaration.clone() }).collect();
        let gate = self.gate();
        let (reached, filtered): (Vec<Target>, Vec<Target>) = attached.into_iter().partition(|target| matches(&target.declaration.matcher, occurrence) && gate.as_ref().is_some_and(|gate| gate(&target.owner, &target.version, permission_of(occurrence.event), Some(&occurrence.project))));
        self.lock().counters.filtered += filtered.len() as u64;
        reached
    }
    /// Whether `owner` holds `permission` for `project`, by the same gate deliveries use.
    pub fn holds(&self, owner: &str, version: &str, permission: &str, project: Option<&str>) -> bool { self.gate().is_some_and(|gate| gate(owner, version, permission, project)) }
    /// One one-way frame to `owner`'s service (receipts).
    pub fn deliver_to(&self, owner: &str, frame: Value) -> Result<(), &'static str> { self.deliverer().ok_or("HostUnavailable").and_then(|deliver| deliver(owner, frame)) }
    /// The awaited chain delivered the task's `prompt.submit`; the turn's start does not deliver it again.
    pub fn mark_submitted(&self, task: &str) { let mut inner = self.lock(); if inner.submitted.len() > 4_096 { inner.submitted.clear(); } inner.submitted.insert(task.to_owned()); }
    /// A compaction of `task` happened while no turn ran, and its next turn has not started yet.
    pub fn pending_compaction(&self, task: &str) -> bool { self.lock().compacted.get(task) == Some(&None) }
    /// `sinceCompaction` of turn `index` of `task`.
    pub fn since_compaction(&self, task: &str, index: u64) -> u64 { since(&self.lock(), task, index) }
    /// `HookTurn` of a run as an occurrence of `event`.
    pub fn turn_occurrence(facts: &RunFacts, event: &'static str, since_compaction: u64) -> Occurrence { Self::occurrence(facts, event, Value::Object(turn_payload(facts, since_compaction))) }

    /// A turn begins: `prompt.submit` (when the user's message is sent and the awaited chain did not already deliver
    /// it; observed, never changed here), then `turn.start`.
    pub fn turn_started(&self, facts: RunFacts) -> Published {
        let (since, submitted) = {
            let mut inner = self.lock();
            let since = since(&inner, &facts.task_id, facts.index);
            // A compaction while no turn ran: this turn is the first after it.
            if inner.compacted.get(&facts.task_id) == Some(&None) { inner.compacted.insert(facts.task_id.clone(), Some(facts.index.saturating_sub(1))); }
            let submitted = inner.submitted.remove(&facts.task_id);
            if !self.active() { return Published::default(); }
            inner.runs.insert(facts.task_id.clone(), Run { facts: facts.clone(), since_compaction: since, started: Instant::now(), before: BTreeSet::new(), after: BTreeSet::new(), tool_calls: 0, names: BTreeMap::new() });
            (since, submitted)
        };
        let turn = Value::Object(turn_payload(&facts, since));
        let mut out = Published::default();
        if !facts.text.is_empty() && !submitted { out += self.publish(&Self::occurrence(&facts, "prompt.submit", turn.clone())); }
        out += self.publish(&Self::occurrence(&facts, "turn.start", turn));
        out
    }

    /// The facts of a run in progress.
    pub fn run(&self, task: &str) -> Option<RunFacts> { self.lock().runs.get(task).map(|run| run.facts.clone()) }

    pub(crate) fn call_base(facts: &RunFacts, name: &str, kind: &str, request: Option<&str>, source: &str, coverage: &str) -> Value {
        let mut base = json!({
            "taskId": facts.task_id, "projectId": facts.project_id, "projectRoot": facts.project_root, "cwd": facts.cwd,
            "harness": facts.harness, "model": facts.model, "mode": facts.mode, "turn": facts.index, "run": facts.run,
            "tool": {"kind": kind, "name": name}, "source": source, "coverage": coverage, "can": [],
        });
        if let Some(request) = request { base["requestId"] = json!(request); }
        base
    }
    /// Kind, shell and paths of a built call, from its complete input when the payload carries it.
    pub(crate) fn complete(call: &mut Value, name: &str) -> (String, Vec<String>) {
        let input = call["input"].clone();
        let mut kind = tool_kind(name);
        if kind == "other" { kind = kind_of_input(&input); }
        call["tool"]["kind"] = json!(kind);
        if kind == "shell" { if let Some(shell) = shell(name, &input) { call["shell"] = shell; } }
        let paths = input_paths(&input);
        if matches!(kind, "write" | "edit") { call["writePaths"] = json!(paths); }
        (kind.to_owned(), paths)
    }

    /// A permission request is open for a call of the run: `tool.before` (source `permissionRequest`, coverage
    /// `askedCalls`), once per call. `call_id` is the host's call id (`runtime_hook_payload`), whose complete input
    /// the payload carries.
    pub fn tool_before(&self, task: &str, harness_call: &str, call_id: &str, name: &str, request: Option<&str>, payload: CallPayload<'_>) -> Published {
        if !self.active() { return Published::default(); }
        let facts = {
            let mut inner = self.lock();
            let Some(run) = inner.runs.get_mut(task) else { return Published::default() };
            if !run.before.insert(harness_call.to_owned()) { return Published::default(); }
            run.names.insert(harness_call.to_owned(), name.to_owned());
            run.facts.clone()
        };
        let base = Self::call_base(&facts, name, tool_kind(name), request, "permissionRequest", "askedCalls");
        let Ok(mut call) = payload(&base, call_id) else { return Published::default() };
        let (kind, paths) = Self::complete(&mut call, name);
        self.publish(&Occurrence { tool_kind: Some(kind), paths, ..Self::occurrence(&facts, "tool.before", call) })
    }

    /// A call of the run ended (`completed`, `failed`, `cancelled` or `denied`): `tool.after`, once per call. A call
    /// no `tool.before` was reported for arrives with source `activity` and coverage `afterOnly`.
    #[allow(clippy::too_many_arguments)]
    pub fn tool_after(&self, task: &str, harness_call: &str, call_id: &str, name: &str, status: &str, output: &str, payload: CallPayload<'_>) -> Published {
        if !self.active() { return Published::default(); }
        let (facts, seen_before, duration) = {
            let mut inner = self.lock();
            let Some(run) = inner.runs.get_mut(task) else { return Published::default() };
            if !run.after.insert(harness_call.to_owned()) { return Published::default(); }
            run.tool_calls += 1;
            (run.facts.clone(), run.before.contains(harness_call), run.started.elapsed().as_millis() as u64)
        };
        let (source, coverage) = if seen_before { ("permissionRequest", "askedCalls") } else { ("activity", "afterOnly") };
        let base = Self::call_base(&facts, name, tool_kind(name), None, source, coverage);
        let Ok(mut call) = payload(&base, call_id) else { return Published::default() };
        let (kind, paths) = Self::complete(&mut call, name);
        // A call whose permission request was denied is `denied` whatever the harness reports, and the decline text
        // it echoes is the host's own, not output (R0504); a denied or cancelled call without output has none.
        let denied = super::runtime_hook_context::denied(task, call_id);
        let status = if denied { "denied" } else { match status { "completed" | "success" | "succeeded" | "done" => "completed", "denied" | "rejected" => "denied", "cancelled" | "canceled" | "interrupted" => "cancelled", _ => "failed" } };
        let mut cut = output.len().min(OUTPUT_BYTES);
        while !output.is_char_boundary(cut) { cut -= 1; }
        call["status"] = json!(status);
        let none = denied || (matches!(status, "denied" | "cancelled") && output.trim().is_empty());
        call["output"] = if none { Value::Null } else { json!(&output[..cut]) };
        call["outputComplete"] = json!(none || (cut == output.len() && output.len() < OUTPUT_BYTES));
        call["durationMs"] = json!(duration);
        call["decidedBy"] = Value::Null;
        self.publish(&Occurrence { tool_kind: Some(kind), paths, ..Self::occurrence(&facts, "tool.after", call) })
    }

    /// The turn is ending: a call whose `tool.before` was reported but whose row never came still gets its
    /// `tool.after`, `denied` when its request was denied and `cancelled` otherwise, with no output (R0504).
    pub fn flush_unpaired(&self, task: &str, payload: CallPayload<'_>) -> Published {
        if !self.active() { return Published::default(); }
        let unpaired: Vec<(String, String)> = {
            let inner = self.lock();
            inner.runs.get(task).map(|run| run.before.difference(&run.after).map(|call| (call.clone(), run.names.get(call).cloned().unwrap_or_else(|| "tool".to_owned()))).collect()).unwrap_or_default()
        };
        let mut out = Published::default();
        for (call, name) in unpaired {
            let status = if super::runtime_hook_context::denied(task, &call) { "denied" } else { "cancelled" };
            out += self.tool_after(task, &call, &call, &name, status, "", payload);
        }
        out
    }

    /// A compaction of the task finished (the harness exposes no point before it here): `compaction` with phase
    /// `after` and nothing it could still change. `sinceCompaction` starts again, also when no hook observes the
    /// run or no turn runs (then the next turn is the first after it).
    pub fn compaction(&self, task: &str) -> Published {
        let facts = {
            let mut inner = self.lock();
            let facts = inner.runs.get_mut(task).map(|run| { run.since_compaction = 0; run.facts.clone() });
            inner.compacted.insert(task.to_owned(), facts.as_ref().map(|facts| facts.index));
            facts
        };
        let Some(facts) = facts else { return Published::default() };
        if !self.active() { return Published::default(); }
        self.publish(&Self::occurrence(&facts, "compaction", json!({"taskId": facts.task_id, "projectId": facts.project_id, "harness": facts.harness, "phase": "after", "can": []})))
    }
    /// A finished compaction step `step` of the task, counted once however often it is reported.
    pub fn compacted(&self, task: &str, step: &str) -> Published {
        {
            let mut inner = self.lock();
            if inner.steps.len() > 4_096 { inner.steps.clear(); }
            if !inner.steps.insert(format!("{task}/{step}")) { return Published::default(); }
        }
        self.compaction(task)
    }

    /// The turn ended: `turn.finish` or `turn.fail` (a stop by the user ends it without finishing), then `task.idle`.
    pub fn turn_ended(&self, task: &str, successful: bool, error: Option<&str>) -> Published {
        if !self.active() { self.lock().runs.remove(task); return Published::default(); }
        let Some(run) = self.lock().runs.remove(task) else { return Published::default() };
        let mut turn = turn_payload(&run.facts, run.since_compaction);
        let mut out = Published::default();
        if successful {
            turn.insert("transcript".into(), json!({"cursor": run.facts.transcript_cursor}));
            turn.insert("durationMs".into(), json!(run.started.elapsed().as_millis() as u64));
            turn.insert("toolCalls".into(), json!(run.tool_calls));
            out += self.publish(&Self::occurrence(&run.facts, "turn.finish", Value::Object(turn)));
        } else {
            let message: String = error.unwrap_or("The turn ended with an error.").chars().take(4_000).collect();
            turn.insert("error".into(), json!({"message": message}));
            out += self.publish(&Self::occurrence(&run.facts, "turn.fail", Value::Object(turn)));
        }
        let idle = json!({"taskId": run.facts.task_id, "projectId": run.facts.project_id, "harness": run.facts.harness, "turn": run.facts.index, "pending": {"approvals": 0, "questions": 0}});
        out += self.publish(&Self::occurrence(&run.facts, "task.idle", idle));
        out
    }

    /// A task was deleted: nothing of it stays.
    pub fn forget_task(&self, task: &str) { let mut inner = self.lock(); inner.runs.remove(task); inner.compacted.remove(task); }
}

// ---------------------------------------------------------------------------------------------------------------
// The app
// ---------------------------------------------------------------------------------------------------------------

static REGISTRY: LazyLock<HookRegistry> = LazyLock::new(|| HookRegistry { global: true, ..HookRegistry::default() });
static INSTALLED: AtomicBool = AtomicBool::new(false);
/// The app's registry.
pub fn registry() -> &'static HookRegistry { &REGISTRY }

/// Whether `owner` holds `permission` (for `project`; `None`: anywhere), from the grants file.
pub fn holds(grants: &super::runtime_grants::RuntimeGrants, owner: &str, version: &str, permission: &str, project: Option<&str>) -> bool {
    use super::runtime_grants::Target;
    match project {
        Some(project) => grants.check(owner, version, permission, &Target::project(project)).is_ok(),
        None => grants.projection()["packages"].as_array().into_iter().flatten().any(|package| {
            package["id"] == owner && package["version"] == version && package["authorized"] == true
                && package["grants"].as_array().into_iter().flatten().any(|grant| grant["permission"] == permission)
        }),
    }
}

/// Wires the app's registry's grant check once (the grants file answers every delivery). Delivery into the running
/// service is installed by the service lifetime (`reconcile_app`): a host call the service answers at once, so the
/// 64-pending bound never fills, never awaited here.
fn install(app: &tauri::AppHandle) {
    if INSTALLED.swap(true, Ordering::AcqRel) { return; }
    use tauri::Manager;
    let gated = app.clone();
    REGISTRY.set_gate(Arc::new(move |owner, version, permission, project| gated.try_state::<super::runtime_grants::RuntimeGrants>().is_some_and(|grants| holds(&grants, owner, version, permission, project))));
}

/// The declarations and version of an enabled, trusted package outside safe mode (the only packages whose service
/// runs); `None` otherwise.
fn declared(app: &tauri::AppHandle, owner: &str) -> Option<(String, Vec<Declaration>)> {
    use tauri::Manager;
    let packages = app.try_state::<super::packages::ExtensionPackages>()?;
    let snapshot = serde_json::to_value(packages.0.lock().ok()?.snapshot()).ok()?;
    if snapshot["safeMode"] == true { return None; }
    let package = snapshot["packages"].as_array()?.iter().find(|package| package["manifest"]["id"] == owner)?;
    if package["enabled"] != true || package["executable"]["trusted"] != true { return None; }
    let version = package["manifest"]["version"].as_str()?.to_owned();
    Some((version, check(&package["manifest"]).unwrap_or_default()))
}

/// The service requests of this slice: `hooks` (`{ op: 'register' | 'unregister', event }`) and `hooksInput`
/// (`panda.hooks.input`, `{ callId, cursor }`). The owner is the connection's, never the request's.
pub async fn serve(app: tauri::AppHandle, request: super::runtime_service_lifetime::DispatchRequest) -> Value {
    install(&app);
    tauri::async_runtime::spawn_blocking(move || serve_now(&app, &request.owner, &request.method, &request.params)).await.unwrap_or_else(|_| super::context::failure("HostUnavailable"))
}
fn serve_now(app: &tauri::AppHandle, owner: &str, method: &str, params: &Value) -> Value {
    let answer = |result: Result<Value, &'static str>| match result { Ok(value) => json!({"ok": true, "value": value}), Err(code) => super::context::failure(code) };
    match method {
        "hooks" => {
            let (Some(op), Some(event)) = (params["op"].as_str(), params["event"].as_str()) else { return super::context::failure("InvalidShape") };
            if params.as_object().is_none_or(|fields| fields.len() != 2) { return super::context::failure("InvalidShape"); }
            match op {
                "register" => {
                    let Some((version, declarations)) = declared(app, owner) else { return super::context::failure("HostUnavailable") };
                    answer(REGISTRY.register(owner, &version, &declarations, event))
                }
                "unregister" => answer(REGISTRY.unregister(owner, event).map(|()| Value::Null)),
                _ => super::context::failure("InvalidShape"),
            }
        }
        "hooksInput" => answer(input(app, owner, params)),
        _ => super::context::failure("UnsupportedCapability"),
    }
}
/// `panda.hooks.input`: the call's project must be inside the package's `harness.hooks.observe` grant, checked now.
fn input(app: &tauri::AppHandle, owner: &str, params: &Value) -> Result<Value, &'static str> {
    use tauri::Manager;
    let call = params["callId"].as_str().ok_or("InvalidShape")?;
    let version = REGISTRY.version(owner).ok_or("PermissionDenied")?;
    if let Some((_, project)) = super::runtime_hook_payload::scope(call) {
        let grants = app.try_state::<super::runtime_grants::RuntimeGrants>().ok_or("HostUnavailable")?;
        if !holds(&grants, owner, &version, OBSERVE, project.as_deref()) { return Err("PermissionDenied"); }
    }
    super::runtime_hook_payload::serve(params).map_err(|code| match code.as_str() { "NotFound" => "NotFound", "StaleContext" => "StaleContext", "LimitExceeded" => "LimitExceeded", _ => "InvalidShape" })
}

/// The service of `owner` ended (any reason): its hooks go with it.
pub fn service_stopped(_app: &tauri::AppHandle, owner: &str) { REGISTRY.remove_owner(owner); }

/// A run of `session_id` begins (`launch_operation_admitted`): the facts every payload of the turn carries, then
/// `prompt.submit` and `turn.start`. Free when no hook is attached.
pub fn run_began(app: &tauri::AppHandle, session_id: &str, cwd: &std::path::Path, prompt: Option<&str>, worker: bool) {
    // With no hook attached only a compaction recorded while no turn ran needs this turn's index.
    if !REGISTRY.active() && !REGISTRY.pending_compaction(session_id) { return; }
    let Some(facts) = facts_of(app, session_id, Some(cwd), prompt, worker) else { return };
    REGISTRY.turn_started(facts);
}
/// The facts of a run of `session_id` about to begin; `cwd` defaults to the task's checkout (R0504 asks before the
/// run is prepared).
pub fn facts_of(app: &tauri::AppHandle, session_id: &str, cwd: Option<&std::path::Path>, prompt: Option<&str>, worker: bool) -> Option<RunFacts> {
    use tauri::Manager;
    let state = app.try_state::<crate::AppState>()?;
    let facts = {
        let store = state.store.lock().ok()?;
        let task = store.session(session_id).ok()?;
        let root = store.project(&task.project_id).map(|project| project.path).unwrap_or_default();
        let cwd = match cwd { Some(cwd) => cwd.to_path_buf(), None => store.workspace_root(&task.project_id, Some(session_id)).unwrap_or_else(|_| std::path::PathBuf::from(&root)) };
        let count = |sql: &str| store.db.query_row(sql, rusqlite::params![session_id], |row| row.get::<_, i64>(0)).unwrap_or(0).max(0) as u64;
        let index = count("SELECT COUNT(*) FROM messages WHERE session_id=?1 AND role='user'").max(1);
        let cursor = count("SELECT COUNT(*) FROM messages WHERE session_id=?1 AND role NOT IN ('tool','changes') AND id < COALESCE((SELECT MAX(id) FROM messages WHERE session_id=?1 AND role='user'), 0)");
        let origin = super::runtime_tasks_start::origins(app).and_then(|ledger| ledger.get(session_id));
        let started_by = match origin { Some(origin) => json!({"package": origin.owner}), None if worker => json!("team"), None => json!("user") };
        RunFacts {
            task_id: session_id.to_owned(), project_id: task.project_id, project_root: root, cwd: cwd.to_string_lossy().into_owned(),
            harness: task.provider, model: Some(task.model).filter(|model| !model.is_empty()), mode: task.mode,
            run: json!({"kind": if worker { "worker" } else { "task" }}), index, text: prompt.unwrap_or_default().to_owned(),
            attachments: vec![], started_by, transcript_cursor: cursor,
        }
    };
    Some(facts)
}
/// The run ended: the `tool.after` of calls whose row never came, `turn.finish` or `turn.fail`, then `task.idle`.
pub fn run_ended(session_id: &str, successful: bool, stopped: bool) {
    REGISTRY.flush_unpaired(session_id, &super::runtime_hook_payload::hook_call);
    REGISTRY.turn_ended(session_id, successful && !stopped, stopped.then_some("Stopped by the user."));
    super::runtime_hook_context::forget_run(session_id);
}
/// The agent event sink (`emit_coalesced`): a permission request is `tool.before`, a finished tool call `tool.after`,
/// a finished "Compact context" step `compaction` (recorded for `sinceCompaction` even when no hook is attached).
pub fn agent_event(event: &crate::providers::AgentEvent) {
    if let Some(tool) = event.tool.as_ref().filter(|tool| tool.name == "Compact context" && tool.status == "completed") {
        REGISTRY.compacted(&event.session_id, &tool.id);
        return;
    }
    if !REGISTRY.active() { return; }
    let run = event.session_id.as_str();
    let payload: CallPayload<'_> = &super::runtime_hook_payload::hook_call;
    if event.kind == "approval" {
        let Some(request) = event.request_id.as_deref() else { return };
        let Some(call) = super::runtime_hook_payload::request_call(run, request) else { return };
        let data = event.data.as_ref().cloned().unwrap_or(Value::Null);
        let name = ["name", "tool_name", "title"].iter().find_map(|key| data[*key].as_str()).unwrap_or("tool").to_owned();
        REGISTRY.tool_before(run, &call, &call, &name, Some(request), payload);
        return;
    }
    let Some(tool) = &event.tool else { return };
    if tool.name == "Compact context" { return; }
    if !matches!(tool.status.as_str(), "completed" | "success" | "failed" | "error" | "cancelled" | "canceled" | "denied" | "rejected" | "interrupted") { return; }
    // A host-served call whose `tool.after` the awaited chain already delivered (R0504).
    if super::runtime_hook_context::take_hosted(run, &tool.name) { return; }
    // The complete input an adapter recorded, or (a run whose adapter recorded nothing) the interface's preview.
    let call_id = super::runtime_hook_payload::call_id(run, &tool.id).or_else(|| {
        let project = REGISTRY.run(run).map(|facts| facts.project_id);
        let input = serde_json::from_str(&tool.input).unwrap_or_else(|_| json!({"preview": tool.input}));
        super::runtime_hook_payload::record(run, project.as_deref(), &tool.id, &input).ok().map(|recorded| recorded.call_id)
    });
    let Some(call_id) = call_id else { return };
    // `tool.before` was keyed by the host call id (from the request); `tool.after` by the same id.
    REGISTRY.tool_after(run, &call_id, &call_id, &tool.name, &tool.status, &tool.output, payload);
}
/// A task was deleted.
pub fn task_removed(session_id: &str) { REGISTRY.forget_task(session_id); }

#[cfg(test)]
mod tests {
    use super::*;
    use crate::extensions::runtime_hook_payload as payloads;

    const MANIFEST: &str = include_str!("../../../tests/fixtures/extensions/runtime-hook-registration/extension.json");
    const DECLARATIONS: &str = include_str!("../../../tests/fixtures/extensions/runtime-hook-registration/declarations.json");
    const REPLAY: &str = include_str!("../../../tests/fixtures/extensions/runtime-hook-registration/replay.json");
    const OWNER: &str = "sample.hook-observer";

    fn manifest() -> Value { serde_json::from_str(MANIFEST).unwrap() }
    type Seen = Arc<Mutex<Vec<(String, Value)>>>;
    /// A registry whose gate grants `projects` (`None`: everywhere) and whose delivery records every frame.
    fn registry(projects: Option<&'static [&'static str]>) -> (HookRegistry, Seen) {
        let hub = HookRegistry::default();
        hub.set_gate(Arc::new(move |_, _, permission, project| permission == OBSERVE && project.is_none_or(|project| projects.is_none_or(|allowed| allowed.contains(&project)))));
        let seen: Seen = Arc::default();
        let sink = seen.clone();
        hub.set_deliver(Arc::new(move |owner, frame| { sink.lock().unwrap().push((owner.to_owned(), frame)); Ok(()) }));
        (hub, seen)
    }
    fn attach_all(hub: &HookRegistry) -> Vec<Declaration> {
        let declarations = check(&manifest()).unwrap();
        for declaration in &declarations { hub.register(OWNER, "1.0.0", &declarations, &declaration.event).unwrap(); }
        declarations
    }
    fn facts(task: &str, project: &str, harness: &str, run: &str, text: &str) -> RunFacts {
        RunFacts {
            task_id: task.into(), project_id: project.into(), project_root: format!("/work/{project}"), cwd: format!("/work/{project}"), harness: harness.into(),
            model: Some("fake-model".into()), mode: "ask".into(), run: json!({"kind": run}), index: 1, text: text.into(), attachments: vec![],
            started_by: json!("user"), transcript_cursor: 0,
        }
    }

    /// Replays the shared script (B5-shaped runs in two projects and two run kinds) and answers `(event, taskId)` of
    /// every delivered frame, in order.
    fn replay(hub: &HookRegistry, seen: &Seen) -> Vec<(String, String)> {
        let script: Value = serde_json::from_str(REPLAY).unwrap();
        let runs: BTreeMap<String, Value> = script["runs"].as_array().unwrap().iter().map(|run| (run["task"].as_str().unwrap().to_owned(), run.clone())).collect();
        for step in script["steps"].as_array().unwrap() {
            let task = step["task"].as_str().unwrap();
            let run = &runs[task];
            let run_id = format!("{}-{}", task, std::process::id());
            match step["op"].as_str().unwrap() {
                "turn" => { hub.turn_started(RunFacts { task_id: run_id.clone(), ..facts(task, run["project"].as_str().unwrap(), run["harness"].as_str().unwrap(), run["run"].as_str().unwrap(), step["text"].as_str().unwrap_or_default()) }); }
                "approval" => {
                    let recorded = payloads::record(&run_id, run["project"].as_str(), step["call"].as_str().unwrap(), &step["input"]).unwrap();
                    payloads::open_approval(&run_id, step["request"].as_str().unwrap(), step["call"].as_str(), payloads::Support::BARE);
                    hub.tool_before(&run_id, &recorded.call_id, &recorded.call_id, step["tool"].as_str().unwrap(), step["request"].as_str(), &payloads::hook_call);
                }
                "tool" => {
                    let recorded = payloads::record(&run_id, run["project"].as_str(), step["call"].as_str().unwrap(), &step["input"]).unwrap();
                    hub.tool_after(&run_id, &recorded.call_id, &recorded.call_id, step["tool"].as_str().unwrap(), step["status"].as_str().unwrap(), step["output"].as_str().unwrap_or_default(), &payloads::hook_call);
                }
                "compaction" => { hub.compaction(&run_id); }
                "end" => { hub.turn_ended(&run_id, step["successful"] == true, step["error"].as_str()); }
                other => panic!("unknown step {other}"),
            }
        }
        let suffix = format!("-{}", std::process::id());
        seen.lock().unwrap().iter().map(|(_, frame)| (frame["event"].as_str().unwrap().to_owned(), frame["payload"]["taskId"].as_str().unwrap().trim_end_matches(&suffix).to_owned())).collect()
    }

    #[test]
    fn declarations_fail_the_same_way_in_the_check_and_in_the_native_contract() {
        let cases: Value = serde_json::from_str(DECLARATIONS).unwrap();
        let base = &cases["base"];
        for case in cases["cases"].as_array().unwrap() {
            let mut manifest = base.clone();
            for (key, value) in case["patch"].as_object().into_iter().flatten() { manifest[key] = value.clone(); }
            for key in case["remove"].as_array().into_iter().flatten().filter_map(Value::as_str) { manifest.as_object_mut().unwrap().remove(key); }
            manifest["contributes"]["hooks"] = case["hooks"].clone();
            let native = crate::extensions::contracts::validate_contract("packages", &json!([manifest]));
            let label = case["id"].as_str().unwrap();
            match case["expect"].as_object() {
                None => {
                    assert_eq!(native["ok"], true, "{label}: {native}");
                    assert!(check(&manifest).is_ok(), "{label}");
                }
                Some(expect) => {
                    assert_eq!(native["ok"], false, "{label}");
                    assert_eq!(native["error"]["code"], expect["code"], "{label}: {native}");
                    assert_eq!(native["error"]["path"], json!(format!("$/0{}", expect["path"].as_str().unwrap())), "{label}");
                    if let Some(ids) = expect.get("ids") { assert_eq!(&native["error"]["ids"], ids, "{label}"); }
                    // Shape refusals come from the schema; the event-dependent ones from `check`, with the same code.
                    if expect["source"] == "check" { assert_eq!(check(&manifest).unwrap_err().code, expect["code"].as_str().unwrap(), "{label}"); }
                }
            }
        }
        // The fixture package itself is valid and declares the eight delivered events.
        let declarations = check(&manifest()).unwrap();
        assert_eq!(declarations.iter().map(|declaration| declaration.event.as_str()).collect::<BTreeSet<_>>(), DELIVERED.into_iter().collect());
        assert_eq!(crate::extensions::contracts::validate_contract("packages", &json!([manifest()]))["ok"], true);
    }

    #[test]
    fn an_observer_receives_every_event_only_inside_its_grant_and_match_filters() {
        let (hub, seen) = registry(Some(&["A"]));
        attach_all(&hub);
        let delivered = replay(&hub, &seen);
        let script: Value = serde_json::from_str(REPLAY).unwrap();
        let expected: Vec<(String, String)> = script["expect"].as_array().unwrap().iter().map(|entry| (entry["event"].as_str().unwrap().to_owned(), entry["task"].as_str().unwrap().to_owned())).collect();
        assert_eq!(delivered, expected);
        // All eight events arrived, none of project B.
        assert_eq!(delivered.iter().map(|(event, _)| event.as_str()).collect::<BTreeSet<_>>(), DELIVERED.into_iter().collect());
        let frames = seen.lock().unwrap().clone();
        assert!(frames.iter().all(|(owner, frame)| owner == OWNER && frame["payload"]["projectId"] == "A" && frame["observeOnly"] == true && frame["schemaVersion"] == 1));
        // Content: the prompt text, the complete input, the shell command and the write paths.
        let first = |event: &str| frames.iter().find(|(_, frame)| frame["event"] == event).map(|(_, frame)| frame["payload"].clone()).unwrap();
        assert_eq!(first("prompt.submit")["text"], "list the files");
        assert_eq!(first("turn.start")["sinceCompaction"], 0);
        let before = first("tool.before");
        assert_eq!((before["inputComplete"].clone(), before["input"]["command"].clone(), before["shell"]["command"].clone(), before["tool"]["kind"].clone()), (json!(true), json!("ls -la"), json!("ls -la"), json!("shell")));
        assert_eq!((before["source"].clone(), before["coverage"].clone(), before["can"].clone()), (json!("permissionRequest"), json!("askedCalls"), json!([])));
        assert!(before["callId"].as_str().unwrap().starts_with("call-") && before["requestId"] == "r1");
        let after = first("tool.after");
        assert_eq!((after["tool"]["kind"].clone(), after["writePaths"].clone(), after["status"].clone(), after["source"].clone(), after["coverage"].clone()), (json!("edit"), json!(["src/app.ts"]), json!("completed"), json!("activity"), json!("afterOnly")));
        assert_eq!(first("compaction"), json!({"taskId": format!("t-a1-{}", std::process::id()), "projectId": "A", "harness": "fake-agent", "phase": "after", "can": []}));
        let finish = first("turn.finish");
        assert_eq!((finish["toolCalls"].clone(), finish["transcript"]["cursor"].clone(), finish["sinceCompaction"].clone()), (json!(3), json!(0), json!(0)));
        assert_eq!(first("turn.fail")["error"]["message"], "fake agent crashed");
        assert_eq!(first("task.idle")["pending"], json!({"approvals": 0, "questions": 0}));
        // Every filtered delivery is counted, never queued.
        assert!(hub.counters().filtered > 0);
    }

    #[test]
    fn undeclared_and_ungranted_registrations_are_refused() {
        let (hub, _) = registry(None);
        let declarations = check(&manifest()).unwrap();
        assert_eq!(hub.register(OWNER, "1.0.0", &declarations, "save.before"), Err("UnknownReference"));
        assert_eq!(hub.register(OWNER, "1.0.0", &declarations, "approval.pending"), Err("UnknownReference"));
        assert_eq!(hub.register(OWNER, "1.0.0", &declarations, "tool.during"), Err("InvalidShape"));
        assert!(hub.listeners(OWNER).is_empty() && !hub.active());
        let ungranted = HookRegistry::default();
        assert_eq!(ungranted.register(OWNER, "1.0.0", &declarations, "turn.start"), Err("PermissionDenied"), "no gate, no delivery");
        ungranted.set_gate(Arc::new(|_, _, _, _| false));
        assert_eq!(ungranted.register(OWNER, "1.0.0", &declarations, "turn.start"), Err("PermissionDenied"));
        let answer = hub.register(OWNER, "1.0.0", &declarations, "tool.before").unwrap();
        assert_eq!((answer["onFailure"].clone(), answer["budgetMs"].clone(), answer["observeOnly"].clone()), (json!("ask"), json!(2000), json!(true)));
        assert!(hub.active());
    }

    #[test]
    fn observe_only_deliveries_never_decide_and_never_hold_the_call() {
        // A service that answers with a decision: the host never reads it, so the request stays open and the answer
        // the adapter claims is the bare one the user gives.
        let hub = HookRegistry::default();
        hub.set_gate(Arc::new(|_, _, _, _| true));
        let answered = Arc::new(Mutex::new(0));
        let count = answered.clone();
        hub.set_deliver(Arc::new(move |_, frame| {
            if frame["event"] == "tool.before" { assert_eq!((frame["observeOnly"].clone(), frame["payload"]["can"].clone()), (json!(true), json!([]))); *count.lock().unwrap() += 1; }
            Ok(())
        }));
        attach_all(&hub);
        let run = format!("observe-only-{}", std::process::id());
        hub.turn_started(RunFacts { task_id: run.clone(), ..facts("t", "A", "fake-agent", "task", "") });
        let recorded = payloads::record(&run, Some("A"), "tool-1", &json!({"command": "rm -rf build"})).unwrap();
        payloads::open_approval(&run, "req-1", Some("tool-1"), payloads::Support::BARE);
        assert_eq!(hub.tool_before(&run, &recorded.call_id, &recorded.call_id, "Bash", Some("req-1"), &payloads::hook_call).delivered, 1);
        assert_eq!(*answered.lock().unwrap(), 1);
        assert!(payloads::support(&run, "req-1").is_some(), "the prompt stays open for the user");
        assert_eq!(payloads::take(&run, "req-1", false), payloads::Answer::plain(false));
        payloads::forget_run(&run);
    }

    #[test]
    fn disposal_revoke_and_service_end_remove_delivery_and_a_failing_service_never_fails_the_run() {
        let granted = Arc::new(AtomicBool::new(true));
        let hub = HookRegistry::default();
        let gate = granted.clone();
        hub.set_gate(Arc::new(move |_, _, _, _| gate.load(Ordering::SeqCst)));
        let seen: Seen = Arc::default();
        let sink = seen.clone();
        hub.set_deliver(Arc::new(move |owner, frame| { sink.lock().unwrap().push((owner.to_owned(), frame)); Ok(()) }));
        let declarations = attach_all(&hub);
        let turn = |hub: &HookRegistry, task: &str| hub.turn_started(RunFacts { task_id: task.into(), ..facts(task, "A", "fake-agent", "task", "hello") });
        assert_eq!(turn(&hub, "t1").delivered, 2);
        // Two handlers of one event: disposing one keeps the hook; disposing both removes it.
        hub.register(OWNER, "1.0.0", &declarations, "turn.start").unwrap();
        hub.unregister(OWNER, "turn.start").unwrap();
        assert!(hub.listeners(OWNER).contains(&"turn.start".to_owned()));
        hub.unregister(OWNER, "turn.start").unwrap();
        assert!(!hub.listeners(OWNER).contains(&"turn.start".to_owned()));
        assert_eq!(turn(&hub, "t2").delivered, 1, "only prompt.submit is left");
        // A revoked grant: attached, but nothing arrives.
        granted.store(false, Ordering::SeqCst);
        assert_eq!(turn(&hub, "t3"), Published { delivered: 0, filtered: 1, failed: 0 });
        granted.store(true, Ordering::SeqCst);
        // A service that cannot take the frame (crashed, restarting, parked): counted, the run goes on.
        hub.set_deliver(Arc::new(|_, _| Err("HostUnavailable")));
        assert_eq!(turn(&hub, "t4"), Published { delivered: 0, filtered: 0, failed: 1 });
        assert!(hub.turn_ended("t4", true, None).failed > 0);
        // The service ends (disable, uninstall, safe mode, stop): every hook goes, the registry is quiet again.
        assert_eq!(hub.remove_owner(OWNER), 7);
        assert!(hub.listeners(OWNER).is_empty() && !hub.active());
        assert_eq!(turn(&hub, "t5"), Published::default());
        assert!(hub.run("t5").is_none(), "nothing is kept for a run no hook observes");
        let delivered = seen.lock().unwrap().len();
        assert_eq!(delivered, 3);
    }

    #[test]
    fn normalization_tables() {
        for (name, kind) in [("Bash", "shell"), ("mcp__pandacode__exec_command", "shell"), ("Read", "read"), ("Write", "write"), ("MultiEdit", "edit"), ("apply_patch", "edit"), ("Grep", "search"), ("WebFetch", "fetch"), ("deepseek_tool", "other")] {
            assert_eq!(tool_kind(name), kind, "{name}");
        }
        assert_eq!(kind_of_input(&json!({"command": ["ls", "-la"]})), "shell");
        assert_eq!(kind_of_input(&json!({"file_path": "a", "content": "b"})), "write");
        assert_eq!(shell("Bash", &json!({"command": ["ls", "-la"]})), Some(json!({"dialect": "posix", "command": "ls -la"})));
        assert_eq!(extension_of("src/App.TS"), Some(".ts".into()));
        assert_eq!(extension_of(".gitignore"), None);
        assert_eq!(extension_of("C:\\work\\Makefile"), None);
        let filter = Match { extensions: Some([".ts".to_owned()].into()), ..Match::default() };
        let mut occurrence = Occurrence { event: "tool.after", project: "A".into(), harness: "h".into(), run: "task".into(), tool_kind: Some("edit".into()), paths: vec!["x.md".into()], payload: Value::Null };
        assert!(!matches(&filter, &occurrence));
        occurrence.paths.push("y.TS".into());
        assert!(matches(&filter, &occurrence));
    }
}
