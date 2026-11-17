//! Model tools declared by a package and answered by its background service (runtime phase R7, slice R0701).
//!
//! * **Declaration.** `contributes.modelTools[]` (`id`, `name`, `description`, `inputSchema`, `timeoutMs`, `approval`) is
//!   checked twice with the same rules: the schema bounds the shape, [`check`] (called by `contracts.rs`, mirrored by
//!   `src/extensions/runtime-model-tools.ts` for `contracts.ts`) applies the rest: every id starts with the manifest id
//!   plus `/` (`InvalidId`, `ReservedId` for `panda.`), `name` is `^[a-z][a-z0-9_]{0,47}$` and never starts with the
//!   reserved `pandacode_` (`ReservedId`), `inputSchema` is a JSON Schema object of at most 16 KiB that the host can
//!   read (`InvalidShape`; `LimitExceeded` past the size), at most 16 tools, a background service to answer them
//!   (`UnsupportedRuntime`) and the `tools.model` permission declared (`PermissionDenied`).
//! * **Registration.** `panda.modelTools.register(id, handler)` in the service asks the host ([`ModelTools::register`]):
//!   an id the manifest does not declare answers `UnknownReference`; without `tools.model` `PermissionDenied`; a second
//!   handler of one id `DuplicateId`. Disposal unregisters; the end of the service process removes every handler of the
//!   package ([`service_stopped`]).
//! * **Inventory.** One list of what a run may be offered ([`ModelTools::listed`]): tools of enabled, trusted packages
//!   outside safe mode whose `tools.model` grant reaches the run's project, checked natively on every listing and every
//!   call. Two enabled packages with the same `name`: the one that comes later is unavailable with its conflict and is
//!   not listed. [`with_model_tools`] advertises that list on the run's tool host, beside the app's own tools, so the
//!   per-run tool server shows it to every harness that receives the host; [`core_tools_list`] gives a package
//!   provider's `core.tools.list()` the same inventory.
//! * **Call.** The call goes through the host's normal path: a tool whose `approval` is `mode` is in the host's approval
//!   catalog (asked or not as the task's mode says, like any tool), the harness's permission request is the
//!   `tool.before` the deciding hooks see (R0505), and the outer `with_result_hooks` (R0504) delivers `tool.after`.
//!   The host rechecks the grant, validates the arguments against the declared schema, hands them to the service inside
//!   the declared `timeoutMs`, and builds the model's result from the `{ content, isError? }` envelope: at most 64 KiB
//!   of compact JSON. A timeout, a missing handler, a service that is not running and a larger result each give the
//!   model an error result at once; none hangs the turn. The transcript names the package that served the call.
//!
//! Package tool servers (`contributes.toolServers`) and the per-session bridge of ZCode (pending person decision A5)
//! are not part of this slice. Everything here is for predictability and fault isolation (ADR-0005): trust and the named
//! grant are the safeguard; nothing is withheld from a granted package.
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{atomic::{AtomicU64, Ordering}, Arc, LazyLock, Mutex},
    time::Duration,
};

use crate::extensions::runtime_hook_context::Ask;
use crate::extensions::runtime_hook_registration::{self as hooks, Gate};

/// The permission a package must hold to offer model tools (per project).
pub const PERMISSION: &str = "tools.model";
/// `name` of a package tool never starts with this (the app's own tools do).
pub const RESERVED_PREFIX: &str = "pandacode_";
pub const MAX_TOOLS: usize = 16;
pub const MAX_NAME: usize = 48;
pub const MAX_DESCRIPTION: usize = 1_024;
pub const MAX_SCHEMA_BYTES: usize = 16 * 1024;
/// UTF-8 compact JSON of a result's `content`.
pub const MAX_RESULT_BYTES: usize = 64 * 1024;
/// Arguments handed to a service.
pub const MAX_INPUT_BYTES: usize = 256 * 1024;
pub const DEFAULT_TIMEOUT_MS: u64 = 30_000;
pub const MIN_TIMEOUT_MS: u64 = 100;
pub const MAX_TIMEOUT_MS: u64 = 600_000;
pub const APPROVALS: [&str; 2] = ["mode", "never"];
const SCHEMA_DEPTH: usize = 8;
const AT: &str = "contributes/modelTools";

// ---------------------------------------------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------------------------------------------

/// One `contributes.modelTools[]` entry, with its defaults applied.
#[derive(Clone, Debug, PartialEq)]
pub struct Declaration { pub id: String, pub name: String, pub description: String, pub input_schema: Value, pub timeout_ms: u64, pub approval: String }
impl Declaration {
    pub fn json(&self) -> Value {
        json!({"id": self.id, "name": self.name, "description": self.description, "inputSchema": self.input_schema, "timeoutMs": self.timeout_ms, "approval": self.approval})
    }
}

/// A refused declaration: the error code, the manifest-relative place and the ids it names.
#[derive(Debug, PartialEq, Eq)]
pub struct Refusal { pub code: &'static str, pub at: &'static str, pub ids: Vec<String> }
fn refuse(code: &'static str, at: &'static str, id: &str) -> Refusal { Refusal { code, at, ids: vec![id.to_owned()] } }

/// `^[a-z][a-z0-9_]{0,47}$`.
pub fn valid_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|first| first.is_ascii_lowercase())
        && name.len() <= MAX_NAME
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

const SCHEMA_TYPES: [&str; 7] = ["object", "string", "number", "integer", "boolean", "array", "null"];
/// Whether `schema` is a JSON Schema the host can read: only the keywords it applies, `$ref` and other references
/// refused, nested at most eight deep.
fn schema_unreadable(schema: &Value, depth: usize) -> bool {
    let Some(fields) = schema.as_object() else { return true };
    if depth > SCHEMA_DEPTH { return true; }
    for (key, value) in fields {
        let bad = match key.as_str() {
            "type" => match value {
                Value::String(kind) => !SCHEMA_TYPES.contains(&kind.as_str()),
                Value::Array(kinds) => kinds.is_empty() || kinds.iter().any(|kind| kind.as_str().is_none_or(|kind| !SCHEMA_TYPES.contains(&kind))),
                _ => true,
            },
            "properties" => value.as_object().is_none_or(|properties| properties.values().any(|property| schema_unreadable(property, depth + 1))),
            "required" => value.as_array().is_none_or(|required| {
                let names: BTreeSet<&str> = required.iter().filter_map(Value::as_str).collect();
                names.len() != required.len()
                    || fields.get("properties").and_then(Value::as_object).is_some_and(|properties| names.iter().any(|name| !properties.contains_key(*name)))
            }),
            "enum" => value.as_array().is_none_or(Vec::is_empty),
            "items" => schema_unreadable(value, depth + 1),
            "additionalProperties" => !value.is_boolean() && schema_unreadable(value, depth + 1),
            "minimum" | "maximum" | "minLength" | "maxLength" | "minItems" | "maxItems" => !value.is_number(),
            "description" | "title" | "default" | "examples" => false,
            // `$ref`, `oneOf`, `patternProperties`, ... : nothing the host could check an argument against.
            _ => true,
        };
        if bad { return true; }
    }
    false
}
/// The top level of a model tool's input is an object.
fn object_schema(schema: &Value) -> bool { schema.get("type").and_then(Value::as_str) == Some("object") }

/// The rules of `contributes.modelTools` after the schema checked the shape. The order of the checks is the order of
/// `checkModelToolDeclarations` in `runtime-model-tools.ts`, so both validators answer the same first refusal.
pub fn check(manifest: &Value) -> Result<Vec<Declaration>, Refusal> {
    let Some(tools) = manifest["contributes"]["modelTools"].as_array().filter(|tools| !tools.is_empty()) else { return Ok(vec![]) };
    let package = manifest["id"].as_str().unwrap_or_default();
    // A model tool is answered by the package's background service; without one it could never answer.
    if manifest["runtime"]["service"].is_null() { return Err(refuse("UnsupportedRuntime", AT, package)); }
    if tools.len() > MAX_TOOLS { return Err(refuse("LimitExceeded", AT, package)); }
    let permissions: BTreeSet<&str> = manifest["permissions"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
    let (mut ids, mut names, mut out) = (BTreeSet::new(), BTreeSet::new(), Vec::new());
    for tool in tools {
        let id = tool["id"].as_str().unwrap_or_default();
        let name = tool["name"].as_str().unwrap_or_default();
        if id.starts_with("panda.") { return Err(refuse("ReservedId", AT, id)); }
        if !id.starts_with(&format!("{package}/")) { return Err(refuse("InvalidId", AT, id)); }
        if !ids.insert(id) { return Err(refuse("DuplicateId", AT, id)); }
        if name.starts_with(RESERVED_PREFIX) { return Err(refuse("ReservedId", AT, id)); }
        if !valid_name(name) { return Err(refuse("InvalidShape", AT, id)); }
        if !names.insert(name) { return Err(refuse("DuplicateId", AT, id)); }
        let Some(description) = tool["description"].as_str().filter(|text| !text.trim().is_empty() && text.chars().count() <= MAX_DESCRIPTION) else { return Err(refuse("InvalidShape", AT, id)) };
        let schema = &tool["inputSchema"];
        if !schema.is_object() { return Err(refuse("InvalidShape", AT, id)); }
        if serde_json::to_string(schema).map_or(true, |text| text.len() > MAX_SCHEMA_BYTES) { return Err(refuse("LimitExceeded", AT, id)); }
        if !object_schema(schema) || schema_unreadable(schema, 0) { return Err(refuse("InvalidShape", AT, id)); }
        let timeout_ms = match tool.get("timeoutMs") {
            None => DEFAULT_TIMEOUT_MS,
            Some(value) => match value.as_u64().filter(|ms| (MIN_TIMEOUT_MS..=MAX_TIMEOUT_MS).contains(ms)) { Some(ms) => ms, None => return Err(refuse("InvalidShape", AT, id)) },
        };
        let approval = match tool.get("approval") {
            None => "mode",
            Some(value) => match value.as_str().filter(|approval| APPROVALS.contains(approval)) { Some(approval) => approval, None => return Err(refuse("InvalidShape", AT, id)) },
        };
        out.push(Declaration { id: id.to_owned(), name: name.to_owned(), description: description.to_owned(), input_schema: schema.clone(), timeout_ms, approval: approval.to_owned() });
    }
    if !permissions.contains(PERMISSION) { return Err(refuse("PermissionDenied", "permissions", package)); }
    Ok(out)
}

// ---------------------------------------------------------------------------------------------------------------
// Arguments and results
// ---------------------------------------------------------------------------------------------------------------

fn kind_matches(kind: &str, value: &Value) -> bool {
    match kind {
        "object" => value.is_object(),
        "string" => value.is_string(),
        "boolean" => value.is_boolean(),
        "array" => value.is_array(),
        "null" => value.is_null(),
        "number" => value.is_number(),
        "integer" => value.as_i64().is_some() || value.as_u64().is_some() || value.as_f64().is_some_and(|number| number.fract() == 0.0 && number.abs() < 9.0e15),
        _ => false,
    }
}
/// The first way `value` does not fit `schema` (the keywords [`schema_unreadable`] allows), as a model-readable line.
pub fn input_problem(schema: &Value, value: &Value, path: &str) -> Option<String> {
    if let Some(kind) = schema.get("type") {
        let kinds: Vec<&str> = match kind { Value::String(kind) => vec![kind.as_str()], Value::Array(kinds) => kinds.iter().filter_map(Value::as_str).collect(), _ => vec![] };
        if !kinds.iter().any(|kind| kind_matches(kind, value)) { return Some(format!("{path} must be {}", kinds.join(" or "))); }
    }
    if let Some(options) = schema.get("enum").and_then(Value::as_array) {
        if !options.contains(value) { return Some(format!("{path} must be one of {}", options.iter().map(Value::to_string).collect::<Vec<_>>().join(", "))); }
    }
    if let Some(number) = value.as_f64().filter(|_| value.is_number()) {
        if schema.get("minimum").and_then(Value::as_f64).is_some_and(|minimum| number < minimum) { return Some(format!("{path} is below the minimum")); }
        if schema.get("maximum").and_then(Value::as_f64).is_some_and(|maximum| number > maximum) { return Some(format!("{path} is above the maximum")); }
    }
    if let Some(text) = value.as_str() {
        let length = text.chars().count() as u64;
        if schema.get("minLength").and_then(Value::as_u64).is_some_and(|minimum| length < minimum) { return Some(format!("{path} is too short")); }
        if schema.get("maxLength").and_then(Value::as_u64).is_some_and(|maximum| length > maximum) { return Some(format!("{path} is too long")); }
    }
    if let Some(items) = value.as_array() {
        let length = items.len() as u64;
        if schema.get("minItems").and_then(Value::as_u64).is_some_and(|minimum| length < minimum) { return Some(format!("{path} has too few items")); }
        if schema.get("maxItems").and_then(Value::as_u64).is_some_and(|maximum| length > maximum) { return Some(format!("{path} has too many items")); }
        if let Some(item) = schema.get("items") {
            for (index, entry) in items.iter().enumerate() { if let Some(problem) = input_problem(item, entry, &format!("{path}[{index}]")) { return Some(problem); } }
        }
    }
    if let Some(fields) = value.as_object() {
        let properties = schema.get("properties").and_then(Value::as_object);
        for name in schema.get("required").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) {
            if !fields.contains_key(name) { return Some(format!("{path}.{name} is required")); }
        }
        for (name, entry) in fields {
            match properties.and_then(|properties| properties.get(name)) {
                Some(property) => { if let Some(problem) = input_problem(property, entry, &format!("{path}.{name}")) { return Some(problem); } }
                None => match schema.get("additionalProperties") {
                    Some(Value::Bool(false)) => return Some(format!("{path}.{name} is not accepted")),
                    Some(extra @ Value::Object(_)) => { if let Some(problem) = input_problem(extra, entry, &format!("{path}.{name}")) { return Some(problem); } }
                    _ => {}
                },
            }
        }
    }
    None
}

/// The `{ content, isError? }` envelope a handler returns: nothing else is accepted (`InvalidShape`), and the compact
/// JSON of `content` stays inside 64 KiB (`LimitExceeded`).
pub fn envelope(answer: &Value) -> Result<(Value, bool), &'static str> {
    let fields = answer.as_object().ok_or("InvalidShape")?;
    if fields.keys().any(|key| key != "content" && key != "isError") { return Err("InvalidShape"); }
    let content = fields.get("content").ok_or("InvalidShape")?;
    let is_error = match fields.get("isError") { None => false, Some(Value::Bool(flag)) => *flag, Some(_) => return Err("InvalidShape") };
    if serde_json::to_string(content).map_or(true, |text| text.len() > MAX_RESULT_BYTES) { return Err("LimitExceeded"); }
    Ok((content.clone(), is_error))
}

// ---------------------------------------------------------------------------------------------------------------
// The inventory
// ---------------------------------------------------------------------------------------------------------------

/// An enabled, trusted package with declarations, in the order the host keeps them (the earlier one keeps a name).
#[derive(Clone, Debug)]
pub struct Entry { pub owner: String, pub version: String, pub package_name: String, pub declarations: Vec<Declaration> }
/// Where the registry reads the enabled packages from: the app's manager, a fixture in tests.
pub type Source = Arc<dyn Fn() -> Vec<Entry> + Send + Sync>;

/// A tool a run may be offered.
#[derive(Clone, Debug, PartialEq)]
pub struct Listed { pub owner: String, pub version: String, pub package_name: String, pub declaration: Declaration }
impl Listed {
    /// The host tool specification the harness is shown; the description names the package.
    pub fn spec(&self) -> Value {
        json!({"type": "function", "name": self.declaration.name, "description": format!("{} (Provided by {}.)", self.declaration.description, self.package_name), "inputSchema": self.declaration.input_schema})
    }
    pub fn json(&self) -> Value {
        json!({"id": self.declaration.id, "name": self.declaration.name, "description": self.declaration.description, "inputSchema": self.declaration.input_schema,
            "timeoutMs": self.declaration.timeout_ms, "approval": self.declaration.approval, "owner": self.owner, "package": self.package_name})
    }
}
/// A tool that is not listed because an earlier package already holds its name.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Conflict { pub owner: String, pub id: String, pub name: String, pub held_by: String }

/// Splits the declared tools of `entries` into those available and those that lost their name.
pub fn resolve(entries: &[Entry]) -> (Vec<Listed>, Vec<Conflict>) {
    let (mut held, mut available, mut conflicts): (BTreeMap<&str, &str>, Vec<Listed>, Vec<Conflict>) = (BTreeMap::new(), vec![], vec![]);
    for entry in entries {
        for declaration in &entry.declarations {
            let holder = held.get(declaration.name.as_str()).copied();
            match holder {
                Some(owner) if owner != entry.owner => conflicts.push(Conflict { owner: entry.owner.clone(), id: declaration.id.clone(), name: declaration.name.clone(), held_by: owner.to_owned() }),
                _ => {
                    held.insert(&declaration.name, &entry.owner);
                    available.push(Listed { owner: entry.owner.clone(), version: entry.version.clone(), package_name: entry.package_name.clone(), declaration: declaration.clone() });
                }
            }
        }
    }
    (available, conflicts)
}

// ---------------------------------------------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------------------------------------------

/// Why a call gave the model an error result: the code (`InvalidShape`, `LimitExceeded`, `Timeout`, `HostUnavailable`,
/// `PermissionDenied`, `NotFound`) and the line the model reads.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CallError { pub code: &'static str, pub message: String }
fn fail(code: &'static str, message: impl Into<String>) -> CallError { CallError { code, message: message.into() } }
/// What a served call answers: the content, whether the handler called it an error, and who served it.
#[derive(Clone, Debug, PartialEq)]
pub struct Served { pub content: Value, pub is_error: bool, pub owner: String, pub package_name: String }

/// Every registered handler and the wiring to the app. The app has one ([`registry`]); tests build their own.
#[derive(Default)]
pub struct ModelTools {
    /// `(owner, tool id)` of a handler registered by a running service.
    handlers: Mutex<BTreeSet<(String, String)>>,
    gate: Mutex<Option<Gate>>,
    source: Mutex<Option<Source>>,
    ask: Mutex<Option<Ask>>,
}
impl ModelTools {
    pub fn set_gate(&self, gate: Gate) { if let Ok(mut slot) = self.gate.lock() { *slot = Some(gate); } }
    pub fn set_source(&self, source: Source) { if let Ok(mut slot) = self.source.lock() { *slot = Some(source); } }
    pub fn set_ask(&self, ask: Ask) { if let Ok(mut slot) = self.ask.lock() { *slot = Some(ask); } }
    fn gate(&self) -> Option<Gate> { self.gate.lock().ok().and_then(|slot| slot.clone()) }
    fn entries(&self) -> Vec<Entry> { self.source.lock().ok().and_then(|slot| slot.clone()).map(|source| source()).unwrap_or_default() }
    fn holds(&self, owner: &str, version: &str, project: Option<&str>) -> bool { self.gate().is_some_and(|gate| gate(owner, version, PERMISSION, project)) }
    fn handlers(&self) -> std::sync::MutexGuard<'_, BTreeSet<(String, String)>> { self.handlers.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) }

    /// `panda.modelTools.register(id)` of `owner`'s service. `UnknownReference` for an id the manifest does not declare,
    /// `PermissionDenied` without `tools.model`, `DuplicateId` for a second handler, `HostUnavailable` for a package
    /// that is not enabled and trusted. Answers the declaration and whether the tool is offered (a lost name is not).
    pub fn register(&self, owner: &str, id: &str) -> Result<Value, &'static str> {
        let entries = self.entries();
        let entry = entries.iter().find(|entry| entry.owner == owner).ok_or("HostUnavailable")?;
        let declaration = entry.declarations.iter().find(|declaration| declaration.id == id).ok_or("UnknownReference")?;
        if !self.holds(owner, &entry.version, None) { return Err("PermissionDenied"); }
        if !self.handlers().insert((owner.to_owned(), id.to_owned())) { return Err("DuplicateId"); }
        let (_, conflicts) = resolve(&entries);
        let conflict = conflicts.iter().find(|conflict| conflict.owner == owner && conflict.id == id);
        let mut answer = declaration.json();
        answer["available"] = json!(conflict.is_none());
        if let Some(conflict) = conflict { answer["conflict"] = json!({"name": conflict.name, "heldBy": conflict.held_by}); }
        Ok(answer)
    }
    /// A handler was disposed.
    pub fn unregister(&self, owner: &str, id: &str) { self.handlers().remove(&(owner.to_owned(), id.to_owned())); }
    /// The service of `owner` ended: none of its handlers stays. Answers how many were removed.
    pub fn remove_owner(&self, owner: &str) -> usize {
        let mut handlers = self.handlers();
        let before = handlers.len();
        handlers.retain(|(registered, _)| registered != owner);
        before - handlers.len()
    }
    /// Whether the service of `owner` has a handler for tool `id`.
    pub fn registered(&self, owner: &str, id: &str) -> bool { self.handlers().contains(&(owner.to_owned(), id.to_owned())) }

    /// The tools a run of `project` may be offered, by the grant checked now.
    pub fn listed(&self, project: &str) -> Vec<Listed> {
        resolve(&self.entries()).0.into_iter().filter(|listed| self.holds(&listed.owner, &listed.version, Some(project))).collect()
    }
    /// The package a tool name belongs to (for the `tool.owner` of its calls).
    pub fn owner_of(&self, name: &str) -> Option<String> { resolve(&self.entries()).0.into_iter().find(|listed| listed.declaration.name == name).map(|listed| listed.owner) }
    /// Tools that lost their name to an earlier package, for the extension's own page.
    pub fn conflicts(&self) -> Vec<Conflict> { resolve(&self.entries()).1 }

    /// One call: the tool is looked up and its grant checked now, the arguments are validated, the service answers
    /// inside `timeoutMs` and its envelope becomes the result. `context` is the `ModelToolCall` the handler receives.
    pub async fn call(&self, project: &str, name: &str, input: Value, context: Value) -> Result<Served, CallError> {
        let listed = self.listed(project).into_iter().find(|listed| listed.declaration.name == name).ok_or_else(|| fail("NotFound", format!("The tool {name} is not available.")))?;
        let declaration = &listed.declaration;
        let package = &listed.package_name;
        if let Some(problem) = input_problem(&declaration.input_schema, &input, "input") { return Err(fail("InvalidShape", format!("The input of {name} is invalid: {problem}."))); }
        if serde_json::to_string(&input).map_or(true, |text| text.len() > MAX_INPUT_BYTES) { return Err(fail("LimitExceeded", format!("The input of {name} is too large."))); }
        if !self.registered(&listed.owner, &declaration.id) { return Err(fail("HostUnavailable", format!("The service of {package} is not running, so {name} cannot answer."))); }
        let ask = self.ask.lock().ok().and_then(|slot| slot.clone()).ok_or_else(|| fail("HostUnavailable", format!("The service of {package} is not reachable.")))?;
        let frame = json!({"schemaVersion": 1, "kind": "modelTool", "observeOnly": false, "toolId": declaration.id, "input": input, "call": context});
        let receiver = ask(&listed.owner, frame).map_err(|code| fail(code, format!("The service of {package} did not take the call ({code}).")))?;
        let answer = match tokio::time::timeout(Duration::from_millis(declaration.timeout_ms), receiver).await {
            Err(_) => return Err(fail("Timeout", format!("{name} did not answer within {} ms.", declaration.timeout_ms))),
            Ok(Err(_)) => return Err(fail("HostUnavailable", format!("The service of {package} stopped before {name} answered."))),
            Ok(Ok(Err(code))) => return Err(fail("HostUnavailable", format!("{name} failed in {package} ({code})."))),
            Ok(Ok(Ok(answer))) => answer,
        };
        let (content, is_error) = envelope(&answer).map_err(|code| match code {
            "LimitExceeded" => fail(code, format!("The result of {name} is larger than {} KiB.", MAX_RESULT_BYTES / 1024)),
            _ => fail(code, format!("{package} answered {name} in a shape the host cannot use.")),
        })?;
        Ok(Served { content, is_error, owner: listed.owner, package_name: listed.package_name })
    }
}

/// What the model receives for a served call: the content as the tool result, or an error result carrying it.
pub fn model_result(served: &Served) -> Result<Value, String> {
    if !served.is_error { return Ok(served.content.clone()); }
    Err(match &served.content { Value::String(text) => text.clone(), other => other.to_string() })
}

/// `core.tools.list()` of a package provider: the app's tools (`core`, as the host lists them) and, when the
/// requesting package holds `tools.model` for the project, the package model tools of the same inventory. The provider
/// is never handed a token: a call goes through [`ModelTools::call`] with the grant checked then.
pub fn core_tools_list(registry: &ModelTools, core: &[Value], approval_core: &BTreeSet<String>, project: &str, requester: (&str, &str)) -> Vec<Value> {
    let mut out: Vec<Value> = core.iter().map(|tool| {
        let name = tool["name"].as_str().unwrap_or_default();
        json!({"name": name, "description": tool["description"], "inputSchema": tool["inputSchema"], "owner": Value::Null, "needsApproval": approval_core.contains(name)})
    }).collect();
    if registry.holds(requester.0, requester.1, Some(project)) {
        out.extend(registry.listed(project).iter().map(|listed| json!({"name": listed.declaration.name, "description": listed.declaration.description, "inputSchema": listed.declaration.input_schema, "owner": listed.owner, "needsApproval": listed.declaration.approval != "never"})));
    }
    out
}

// ---------------------------------------------------------------------------------------------------------------
// The app
// ---------------------------------------------------------------------------------------------------------------

static REGISTRY: LazyLock<ModelTools> = LazyLock::new(ModelTools::default);
static INSTALLED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// The app's registry.
pub fn registry() -> &'static ModelTools { &REGISTRY }

/// The enabled, trusted packages outside safe mode with model tools, in the manager's order.
fn app_entries(app: &tauri::AppHandle) -> Vec<Entry> {
    use tauri::Manager;
    let Some(packages) = app.try_state::<crate::extensions::packages::ExtensionPackages>() else { return vec![] };
    let Some(snapshot) = packages.0.lock().ok().and_then(|packages| serde_json::to_value(packages.snapshot()).ok()) else { return vec![] };
    if snapshot["safeMode"] == true { return vec![]; }
    snapshot["packages"].as_array().into_iter().flatten()
        .filter(|package| package["enabled"] == true && package["executable"]["trusted"] == true)
        .filter_map(|package| {
            let manifest = &package["manifest"];
            let declarations = check(manifest).ok().filter(|declarations| !declarations.is_empty())?;
            let owner = manifest["id"].as_str()?.to_owned();
            let package_name = manifest["name"].as_str().filter(|name| !name.trim().is_empty()).unwrap_or(&owner).to_owned();
            Some(Entry { version: manifest["version"].as_str()?.to_owned(), package_name, owner, declarations })
        }).collect()
}

/// Wires the app's registry once: the grants file answers every check, the manager lists the packages and a call
/// reaches the running service through the same host call a hook uses.
fn install(app: &tauri::AppHandle) {
    if INSTALLED.swap(true, Ordering::AcqRel) { return; }
    use tauri::Manager;
    let gated = app.clone();
    REGISTRY.set_gate(Arc::new(move |owner, version, permission, project| gated.try_state::<crate::extensions::runtime_grants::RuntimeGrants>().is_some_and(|grants| hooks::holds(&grants, owner, version, permission, project))));
    let listing = app.clone();
    REGISTRY.set_source(Arc::new(move || app_entries(&listing)));
    let asking = app.clone();
    REGISTRY.set_ask(Arc::new(move |owner: &str, frame: Value| asking.try_state::<crate::extensions::runtime_service_lifetime::ServiceLifetime>().ok_or("HostUnavailable")?.send_hook(owner, frame)));
}

/// The service requests of this slice: `modelTools` (`{ op: 'register' | 'unregister', id }`). The owner is the
/// connection's, never the request's.
pub async fn serve(app: tauri::AppHandle, request: crate::extensions::runtime_service_lifetime::DispatchRequest) -> Value {
    install(&app);
    tauri::async_runtime::spawn_blocking(move || serve_now(&request.owner, &request.method, &request.params)).await.unwrap_or_else(|_| crate::extensions::context::failure("HostUnavailable"))
}
fn serve_now(owner: &str, method: &str, params: &Value) -> Value {
    if method != "modelTools" { return crate::extensions::context::failure("UnsupportedCapability"); }
    let (Some(op), Some(id)) = (params["op"].as_str(), params["id"].as_str()) else { return crate::extensions::context::failure("InvalidShape") };
    if params.as_object().is_none_or(|fields| fields.len() != 2) { return crate::extensions::context::failure("InvalidShape"); }
    match op {
        "register" => match REGISTRY.register(owner, id) { Ok(value) => json!({"ok": true, "value": value}), Err(code) => crate::extensions::context::failure(code) },
        "unregister" => { REGISTRY.unregister(owner, id); json!({"ok": true, "value": Value::Null}) }
        _ => crate::extensions::context::failure("InvalidShape"),
    }
}

/// The service of `owner` ended (any reason): its handlers go with it.
pub fn service_stopped(owner: &str) { REGISTRY.remove_owner(owner); }

fn system_line(app: &tauri::AppHandle, task: &str, text: &str) {
    use tauri::{Emitter, Manager};
    let Some(state) = app.try_state::<crate::AppState>() else { return };
    let saved = state.store.lock().ok().map(|store| store.insert_message(task, "system", text));
    if saved.is_some() { let _ = app.emit("sessions-changed", ()); }
}

/// `ModelToolCall` of a run: what the handler receives beside its input.
pub fn call_context(facts: &hooks::RunFacts, call_id: &str) -> Value {
    json!({"callId": call_id, "taskId": facts.task_id, "projectId": facts.project_id, "projectRoot": facts.project_root, "cwd": facts.cwd,
        "harness": facts.harness, "model": facts.model, "mode": facts.mode, "run": facts.run})
}

/// Adds the package model tools of the run's project to its tool host (`build_task_host`, inside `with_result_hooks`).
/// A tool whose `approval` is `mode` joins the host's approval catalog; a name the host already serves is skipped.
/// With no model tool listed the host is returned unchanged. A call is looked up again when it arrives, so a package
/// disabled, revoked or stopped meanwhile answers an error result instead of running.
pub fn with_model_tools(base: crate::providers::ToolHost, app: tauri::AppHandle, session_id: String) -> crate::providers::ToolHost {
    install(&app);
    let Some(facts) = hooks::facts_of(&app, &session_id, None, None, false) else { return base };
    let taken: BTreeSet<String> = base.tools.iter().filter_map(|tool| tool["name"].as_str().map(str::to_owned)).collect();
    let listed: Vec<Listed> = REGISTRY.listed(&facts.project_id).into_iter().filter(|listed| !taken.contains(&listed.declaration.name)).collect();
    if listed.is_empty() { return base; }
    let (mut tools, mut approval_tools) = (base.tools.clone(), base.approval_tools.clone());
    for tool in &listed {
        tools.push(tool.spec());
        if tool.declaration.approval != "never" { approval_tools.insert(tool.declaration.name.clone()); }
    }
    let names: BTreeSet<String> = listed.iter().map(|tool| tool.declaration.name.clone()).collect();
    let (inner, project, serial) = (base.handler.clone(), facts.project_id.clone(), Arc::new(AtomicU64::new(0)));
    crate::providers::ToolHost {
        tools,
        approval_tools,
        handler: Arc::new(move |name: String, arguments: Value| {
            let (inner, app, session_id, project, serial, names) = (inner.clone(), app.clone(), session_id.clone(), project.clone(), serial.clone(), names.clone());
            Box::pin(async move {
                if !names.contains(&name) { return inner(name, arguments).await; }
                let call_id = format!("model-{}", serial.fetch_add(1, Ordering::Relaxed));
                let Some(facts) = hooks::facts_of(&app, &session_id, None, None, false) else { return Err("The task is no longer available.".to_owned()) };
                match REGISTRY.call(&project, &name, arguments, call_context(&facts, &call_id)).await {
                    Ok(served) => {
                        system_line(&app, &session_id, &format!("{} served {name}.", served.package_name));
                        model_result(&served)
                    }
                    Err(error) => Err(error.message),
                }
            }) as std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value, String>> + Send>>
        }),
    }
}

/// The preview mock's and the tests' view of the inventory as the SDK shows it.
pub fn inventory_json(registry: &ModelTools, project: &str) -> Value {
    let (_, conflicts) = resolve(&registry.entries());
    json!({
        "tools": registry.listed(project).iter().map(Listed::json).collect::<Vec<_>>(),
        "conflicts": conflicts.iter().map(|conflict| json!({"owner": conflict.owner, "id": conflict.id, "name": conflict.name, "heldBy": conflict.held_by})).collect::<Vec<_>>(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::oneshot;

    const CASES: &str = include_str!("../../../tests/fixtures/extensions/runtime-model-tools/cases.json");
    const MANIFEST: &str = include_str!("../../../tests/fixtures/extensions/runtime-model-tools/extension.json");
    const OWNER: &str = "sample.memory";

    /// `"{pad:N}"` anywhere in a fixture stands for N `x` characters.
    fn expand(value: &Value) -> Value {
        match value {
            Value::String(text) => match text.strip_prefix("{pad:").and_then(|rest| rest.strip_suffix('}')).and_then(|count| count.parse::<usize>().ok()) { Some(count) => json!("x".repeat(count)), None => value.clone() },
            Value::Array(items) => Value::Array(items.iter().map(expand).collect()),
            Value::Object(fields) => Value::Object(fields.iter().map(|(key, value)| (key.clone(), expand(value))).collect()),
            other => other.clone(),
        }
    }
    fn cases() -> Value { serde_json::from_str(CASES).unwrap() }
    fn manifest() -> Value { serde_json::from_str(MANIFEST).unwrap() }
    fn tool(name: &str) -> Value { manifest()["contributes"]["modelTools"].as_array().unwrap().iter().find(|tool| tool["name"] == name).unwrap().clone() }

    /// The manifest of a refusal case: the base tool with the case's changes, and the manifest-level switches.
    fn refusal_manifest(case: &Value) -> Value {
        let mut base = tool("memory");
        for (key, value) in case["set"].as_object().into_iter().flatten() { base[key] = expand(value); }
        for key in case["drop"].as_array().into_iter().flatten().filter_map(Value::as_str) { base.as_object_mut().unwrap().remove(key); }
        let mut tools = vec![base.clone()];
        for extra in case["extra"].as_array().into_iter().flatten() {
            let mut more = base.clone();
            for (key, value) in extra["set"].as_object().into_iter().flatten() { more[key] = expand(value); }
            tools.push(more);
        }
        if let Some(count) = case["count"].as_u64() {
            tools = (0..count).map(|index| { let mut more = tool("memory"); more["id"] = json!(format!("{OWNER}/t{index}")); more["name"] = json!(format!("t{index}")); more }).collect();
        }
        let mut manifest = manifest();
        manifest["contributes"]["modelTools"] = Value::Array(tools);
        if let Some(permissions) = case.get("permissions") { manifest["permissions"] = permissions.clone(); }
        if case["noService"] == true { manifest["runtime"].as_object_mut().unwrap().remove("service"); }
        manifest
    }

    #[test]
    fn the_fixture_manifest_declares_valid_tools() {
        let declarations = check(&manifest()).unwrap();
        assert_eq!(declarations.iter().map(|declaration| declaration.name.as_str()).collect::<Vec<_>>(), ["memory", "slow_recall", "big_dump", "bare_value", "broken"]);
        assert_eq!(declarations[0].timeout_ms, DEFAULT_TIMEOUT_MS);
        assert_eq!(declarations[1].timeout_ms, 100);
        assert_eq!(declarations[4].approval, "never");
    }

    #[test]
    fn refusals_answer_the_same_code_as_the_twin() {
        for case in cases()["refusals"].as_array().unwrap() {
            let label = case["id"].as_str().unwrap();
            let refusal = check(&refusal_manifest(case)).expect_err(label);
            assert_eq!((refusal.code, refusal.at), (case["expect"]["code"].as_str().unwrap(), case["expect"]["at"].as_str().unwrap()), "{label}");
            if let Some(ids) = case["expect"]["ids"].as_array() { assert_eq!(refusal.ids, ids.iter().map(|id| id.as_str().unwrap().to_owned()).collect::<Vec<_>>(), "{label}"); }
        }
    }

    #[test]
    fn inputs_are_checked_against_the_declared_schema() {
        let schema = tool("memory")["inputSchema"].clone();
        for case in cases()["inputs"].as_array().unwrap() {
            let problem = input_problem(&schema, &expand(&case["input"]), "input");
            assert_eq!(problem.is_none(), case["valid"] == true, "{}: {problem:?}", case["id"]);
        }
    }

    #[test]
    fn envelopes_are_checked_and_bounded() {
        for case in cases()["envelopes"].as_array().unwrap() {
            let label = case["id"].as_str().unwrap();
            match (envelope(&expand(&case["answer"])), case["expect"]["code"].as_str()) {
                (Ok((content, is_error)), None) => assert_eq!((content, is_error), (expand(&case["expect"]["content"]), case["expect"]["isError"] == true), "{label}"),
                (Err(code), Some(expected)) => assert_eq!(code, expected, "{label}"),
                (other, expected) => panic!("{label}: {other:?} against {expected:?}"),
            }
        }
    }

    fn entries_of(raw: &Value) -> Vec<Entry> {
        raw.as_array().unwrap().iter().map(|entry| {
            let owner = entry["owner"].as_str().unwrap();
            Entry {
                owner: owner.to_owned(), version: "1.0.0".into(), package_name: entry["package"].as_str().unwrap_or(owner).to_owned(),
                declarations: entry["names"].as_array().unwrap().iter().map(|name| { let mut declaration = check(&manifest()).unwrap().remove(0); declaration.name = name.as_str().unwrap().to_owned(); declaration.id = format!("{owner}/{}", name.as_str().unwrap()); declaration }).collect(),
            }
        }).collect()
    }

    #[test]
    fn the_later_package_loses_a_shared_name() {
        for case in cases()["collisions"].as_array().unwrap() {
            let (available, conflicts) = resolve(&entries_of(&case["entries"]));
            let available: Vec<Value> = available.iter().map(|listed| json!([listed.owner, listed.declaration.name])).collect();
            let conflicts: Vec<Value> = conflicts.iter().map(|conflict| json!([conflict.owner, conflict.name, conflict.held_by])).collect();
            assert_eq!(available, case["available"].as_array().unwrap().clone(), "{}", case["id"]);
            assert_eq!(conflicts, case["conflicts"].as_array().unwrap().clone(), "{}", case["id"]);
        }
    }

    /// A registry over the fixture package with the given grants: `granted` tells whether `tools.model` is held.
    fn fixture(granted: bool, answer: impl Fn(Value) -> Option<Value> + Send + Sync + 'static) -> ModelTools {
        let registry = ModelTools::default();
        let declarations = check(&manifest()).unwrap();
        registry.set_source(Arc::new(move || vec![Entry { owner: OWNER.into(), version: "1.0.0".into(), package_name: "Memory".into(), declarations: declarations.clone() }]));
        registry.set_gate(Arc::new(move |owner, _, permission, _| granted && owner == OWNER && permission == PERMISSION));
        // A stand-in service: it answers from `answer`, or never (the sender is kept alive so the wait times out).
        registry.set_ask(Arc::new(move |_, frame: Value| {
            let (reply, receiver) = oneshot::channel();
            match answer(frame) { Some(value) => { let _ = reply.send(Ok(value)); } None => std::mem::forget(reply) }
            Ok(receiver)
        }));
        registry
    }
    fn run(registry: &ModelTools, name: &str, input: Value) -> Result<Served, CallError> {
        tauri::async_runtime::block_on(registry.call("p1", name, input, json!({"callId": "model-0", "taskId": "t1", "projectId": "p1"})))
    }

    #[test]
    fn registering_an_unknown_id_or_without_the_grant_is_refused() {
        let registry = fixture(true, |_| None);
        assert_eq!(registry.register(OWNER, "sample.memory/ghost").unwrap_err(), "UnknownReference");
        assert_eq!(registry.register("sample.other", "sample.memory/memory").unwrap_err(), "HostUnavailable");
        assert!(registry.register(OWNER, "sample.memory/memory").unwrap()["available"] == true);
        assert_eq!(registry.register(OWNER, "sample.memory/memory").unwrap_err(), "DuplicateId");
        assert_eq!(fixture(false, |_| None).register(OWNER, "sample.memory/memory").unwrap_err(), "PermissionDenied");
        assert_eq!(registry.remove_owner(OWNER), 1);
        assert!(!registry.registered(OWNER, "sample.memory/memory"));
    }

    #[test]
    fn a_call_reaches_the_service_and_returns_its_content() {
        let registry = fixture(true, |frame| Some(json!({"content": {"echo": frame["input"], "task": frame["call"]["taskId"]}})));
        registry.register(OWNER, "sample.memory/memory").unwrap();
        let served = run(&registry, "memory", json!({"mode": "add", "content": "pnpm"})).unwrap();
        assert_eq!((&served.content, served.is_error, served.owner.as_str()), (&json!({"echo": {"mode": "add", "content": "pnpm"}, "task": "t1"}), false, OWNER));
        assert_eq!(model_result(&served).unwrap()["task"], "t1");
        let failed = Served { content: json!("nothing found"), is_error: true, owner: OWNER.into(), package_name: "Memory".into() };
        assert_eq!(model_result(&failed).unwrap_err(), "nothing found");
    }

    #[test]
    fn a_call_that_cannot_be_served_gives_an_error_result_at_once() {
        let registry = fixture(true, |_| Some(json!({"content": "ok"})));
        assert_eq!(run(&registry, "memory", json!({"mode": "list"})).unwrap_err().code, "HostUnavailable", "no handler registered: the service is not running");
        registry.register(OWNER, "sample.memory/memory").unwrap();
        assert_eq!(run(&registry, "memory", json!({"mode": "drop"})).unwrap_err().code, "InvalidShape");
        assert_eq!(run(&registry, "ghost", json!({})).unwrap_err().code, "NotFound");
        assert_eq!(run(&fixture(false, |_| Some(json!({"content": 1}))), "memory", json!({"mode": "list"})).unwrap_err().code, "NotFound", "without tools.model nothing is listed");
        let silent = fixture(true, |_| None);
        silent.register(OWNER, "sample.memory/slow_recall").unwrap();
        assert_eq!(run(&silent, "slow_recall", json!({})).unwrap_err().code, "Timeout");
        let bare = fixture(true, |_| Some(json!("just text")));
        bare.register(OWNER, "sample.memory/bare_value").unwrap();
        assert_eq!(run(&bare, "bare_value", json!({})).unwrap_err().code, "InvalidShape");
        let big = fixture(true, |_| Some(json!({"content": "x".repeat(MAX_RESULT_BYTES)})));
        big.register(OWNER, "sample.memory/big_dump").unwrap();
        assert_eq!(run(&big, "big_dump", json!({})).unwrap_err().code, "LimitExceeded");
    }

    #[test]
    fn the_host_tool_specification_names_the_package_and_core_listing_shares_the_inventory() {
        let registry = fixture(true, |_| None);
        let listed = registry.listed("p1");
        assert_eq!(listed.len(), 5);
        let spec = listed[0].spec();
        assert_eq!((spec["type"].as_str(), spec["name"].as_str()), (Some("function"), Some("memory")));
        assert!(spec["description"].as_str().unwrap().ends_with("(Provided by Memory.)"));
        let core = vec![json!({"type": "function", "name": "pandacode_preview_file", "description": "Open a preview.", "inputSchema": {"type": "object"}})];
        let approval: BTreeSet<String> = ["pandacode_preview_file".to_owned()].into();
        let both = core_tools_list(&registry, &core, &approval, "p1", (OWNER, "1.0.0"));
        assert_eq!(both.len(), 6);
        assert_eq!((both[0]["needsApproval"].as_bool(), both[0]["owner"].is_null()), (Some(true), true));
        assert_eq!(both.iter().find(|tool| tool["name"] == "broken").unwrap()["needsApproval"], false);
        assert_eq!(core_tools_list(&fixture(false, |_| None), &core, &approval, "p1", (OWNER, "1.0.0")).len(), 1, "without tools.model only the app's tools are listed");
    }
}
