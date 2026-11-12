//! What the user approves for `pandacode_tool_run`: the tool's args and whole script, kept per
//! approval request. The MCP host's `authorize` asks `prepare` for the text, hands the approved
//! request id to the handler in the call's args (`TOKEN`), and the handler runs exactly that
//! snapshot, once. Nothing is loaded from disk after an approval, and a declined, expired or
//! cancelled request leaves nothing a later call could use.
use super::{run, Scope, Tool, TOOL_RUN};
use serde_json::Value;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Mutex, MutexGuard},
};

/// The argument that carries an approved request id from `authorize` to the handler. Any
/// value an agent sends under it is removed first (`strip`).
pub(crate) const TOKEN: &str = "_pandacodeApproval";
/// Each arg value shown in an approval, at most; `run::MAX_ARG` keeps every value within it.
pub(super) const ARG_PREVIEW: usize = 1000;

/// Where a task's tools live, set when its turn's host is built.
#[derive(Clone)]
pub(super) struct Place {
    pub base: PathBuf,
    pub project: String,
}

/// The tool one approval request showed.
struct Shown {
    session: String,
    name: String,
    tool: Tool,
    scope: Scope,
}

type Map<T> = Mutex<Option<HashMap<String, T>>>;
static PLACES: Map<Place> = Mutex::new(None);
/// Request id → what it shows, until the user answers.
static PENDING: Map<Shown> = Mutex::new(None);
/// Request id → what the user approved, until the handler runs it.
static APPROVED: Map<Shown> = Mutex::new(None);

fn guard<T>(lock: &'static Map<T>) -> MutexGuard<'static, Option<HashMap<String, T>>> {
    lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(super) fn register(session: &str, place: Place) {
    guard(&PLACES).get_or_insert_with(HashMap::new).insert(session.to_owned(), place);
}

/// Forgets a task's place and every snapshot of its calls; at run end.
pub(crate) fn run_ended(session: &str) {
    if let Some(places) = guard(&PLACES).as_mut() {
        places.remove(session);
    }
    for map in [&PENDING, &APPROVED] {
        if let Some(shown) = guard(map).as_mut() {
            shown.retain(|_, shown| shown.session != session);
        }
    }
}

/// For an approval of `tool`: `None` when it is not `pandacode_tool_run` (the caller shows
/// its usual prompt), else the text to show, or why the call is refused with no prompt (an
/// unknown or disabled tool, or args the tool does not take).
pub(crate) fn prepare(session: &str, request: &str, tool: &str, args: &Value) -> Option<Result<String, String>> {
    (tool == TOOL_RUN).then(|| prepare_run(session, request, args))
}

fn prepare_run(session: &str, request: &str, args: &Value) -> Result<String, String> {
    let place = guard(&PLACES).as_ref().and_then(|places| places.get(session).cloned()).ok_or("Project tools are unavailable in this task.")?;
    if args.as_object().is_some_and(|map| map.keys().any(|key| key != "name" && key != "args")) {
        return Err("Only name and args are accepted.".into());
    }
    let name = args["name"].as_str().ok_or("name is required.")?;
    let (tool, scope) = super::resolve(&place.base, &place.project, name).ok_or_else(|| format!("No tool named {name} in this project."))?;
    if tool.disabled {
        return Err(format!("The tool {name} is disabled in Settings."));
    }
    run::environment(&tool.params, &args["args"])?;
    let text = describe(&tool, scope, &args["args"]);
    let shown = Shown { session: session.to_owned(), name: name.to_owned(), tool, scope };
    guard(&PENDING).get_or_insert_with(HashMap::new).insert(request.to_owned(), shown);
    Ok(text)
}

/// The user approved `request`: its snapshot moves on to the handler, named in `args`.
pub(crate) fn approve(request: &str, args: &mut Value) {
    let Some(shown) = guard(&PENDING).as_mut().and_then(|pending| pending.remove(request)) else { return };
    guard(&APPROVED).get_or_insert_with(HashMap::new).insert(request.to_owned(), shown);
    args[TOKEN] = Value::String(request.to_owned());
}

/// The request ended unapproved (declined, expired or cancelled): drops its snapshot.
pub(crate) fn forget(request: &str) {
    if let Some(pending) = guard(&PENDING).as_mut() {
        pending.remove(request);
    }
}

/// Removes an approval id an agent put in its own arguments.
pub(crate) fn strip(args: &mut Value) -> Option<String> {
    args.as_object_mut()?.remove(TOKEN).and_then(|value| value.as_str().map(str::to_owned))
}

/// The approved snapshot for `token`, once, if it was for this task and tool.
pub(super) fn take(token: &str, session: &str, name: &str) -> Option<(Tool, Scope)> {
    let shown = guard(&APPROVED).as_mut()?.remove(token)?;
    (shown.session == session && shown.name == name).then_some((shown.tool, shown.scope))
}

/// A value as one JSON string, in full up to `ARG_PREVIEW` characters, then how many bytes
/// were left out. Newlines and quotes stay escaped and invisible formatting characters are
/// shown as `\uXXXX`, so a value cannot draw lines of its own or reorder the approval.
pub(super) fn preview(value: &Value) -> String {
    let text = value.as_str().map_or_else(|| value.to_string(), str::to_owned);
    let cut: String = text.chars().take(ARG_PREVIEW).collect();
    let more = if cut.len() < text.len() { format!("… ({} more bytes)", text.len() - cut.len()) } else { String::new() };
    let quoted: String = serde_json::to_string(&cut).unwrap_or_default().chars().map(|c| if super::invisible(c) { format!("\\u{:04X}", c as u32) } else { c.to_string() }).collect();
    format!("{quoted}{more}")
}

/// The approval's first line, which the collapsed approval bar shows.
fn header(scope: Scope, name: &str, version: u64) -> String {
    format!("Run {} tool {name} v{version}?", scope.label())
}

/// Whether an approval's text is for `pandacode_tool_run`: its first line is a `header`. Bots
/// never save or apply allow rules to these (`bots::guard`). Another prompt that happens to
/// match only asks every time.
pub(crate) fn is_run(text: &str) -> bool {
    let first = text.lines().next().unwrap_or_default();
    let Some(rest) = first.strip_prefix("Run project tool ").or_else(|| first.strip_prefix("Run global tool ")) else { return false };
    let Some((name, version)) = rest.strip_suffix('?').and_then(|rest| rest.split_once(" v")) else { return false };
    super::valid_name(name) && !version.is_empty() && version.bytes().all(|b| b.is_ascii_digit())
}

/// Opens and ends the environment lines inside an approval's fence, before the script.
const ENV_HEADER: &str = "# Environment:\n";
const SCRIPT_HEADER: &str = "# Script:\n";

/// The approval: header, then one fence holding the environment lines (if any) and the script,
/// so no value or script line can render as a link, a mention or anything but text.
pub(super) fn describe(tool: &Tool, scope: Scope, args: &Value) -> String {
    let given: Vec<String> = tool.params.iter().filter_map(|param| args.get(&param.name).map(|value| format!("{}={}", run::env_name(&param.name), preview(value)))).collect();
    let body = if given.is_empty() { tool.script.clone() } else { format!("{ENV_HEADER}{}\n{SCRIPT_HEADER}{}", given.join("\n"), tool.script) };
    format!("{}\nIt runs in this task's checkout.\nScript (v{}):\n{}", header(scope, &tool.name, tool.version), tool.version, fenced(&body))
}

/// The script an approval's text shows, without its environment lines. Values are previewed
/// as one JSON string each (no raw newline), so the first `SCRIPT_HEADER` line is the real one.
pub(crate) fn script_in(text: &str) -> Option<&str> {
    let (_, rest) = text.split_once("\nScript (v")?;
    let body = rest.split_once('\n').map(|(_, fence)| unfenced(fence).unwrap_or(fence))?;
    Some(body.strip_prefix(ENV_HEADER).and_then(|env| env.split_once(&format!("\n{SCRIPT_HEADER}"))).map_or(body, |(_, script)| script))
}

/// The script as a fenced `sh` code block, its fence longer than any backtick run inside, so
/// Markdown renderers (the phone, the bot web chat) show every line as text: outside a fence a
/// line such as `[x]: $(curl …|sh)` is a link definition and renders as nothing.
pub(crate) fn fenced(script: &str) -> String {
    let longest = script.split(|c| c != '`').map(str::len).max().unwrap_or(0);
    let fence = "`".repeat(longest.max(2) + 1);
    format!("{fence}sh\n{script}\n{fence}")
}

/// The script inside `fenced` text: what lies between its first and last line.
pub(crate) fn unfenced(text: &str) -> Option<&str> {
    let (open, rest) = text.split_once('\n')?;
    let fence = open.strip_suffix("sh").filter(|fence| fence.len() >= 3 && fence.bytes().all(|b| b == b'`'))?;
    rest.strip_suffix(fence)?.strip_suffix('\n')
}
