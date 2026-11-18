//! Package tools across the provider paths, and the host-attached credential of an HTTP tool server (runtime phase R7,
//! slice R0703).
//!
//! R0701 gave a run its model tools (served by a package's service through the run's tool host) and R0702 gave it the
//! tool servers a package declares (called by the harness itself). This slice qualifies both and closes what they left:
//!
//! * **Capabilities.** [`row`] and [`matrix`] say, per harness family and per run path (`task`, `worker`, `bot`,
//!   `schedule`, `remote`, with the trigger that started it), how a package tool reaches the model: model tools through
//!   the per-run tool host, tool servers through the launch entry of the family (`claude`, `codex`, `acp`). A harness
//!   without a way to hand it a server (Pi, Muse, ZCode, a package provider, an unknown id) answers
//!   `UnsupportedCapability` with the reason, never a silent no; ZCode's per-session bridge is pending person decision
//!   A5 and stays unwired. A run that only mirrors another computer's turn executes nothing here. A cell is never a
//!   bare yes: it carries its qualification (`sourceFeasible`, `recorded`, `installedQualified`, `unsupported`), and
//!   the tool-server attachment says `entriesReady`: the entries exist, the per-run providers do not read them yet (the
//!   provider seam of R0702 is still provider-owned; not claimed).
//! * **Provider `core.tools`.** [`CoreBridge`] is what a package provider's `core.tools.list()` / `core.tools.call()`
//!   reach: the run's own tool host, so a call takes the same approval and the same `tool.after` hook as the model's
//!   call. The listing drops a package tool that is no longer offered (disable, revoke, safe mode) and a call to it is
//!   refused before anything runs, so inventory and execution agree. A tool that needs approval is asked of the
//!   [`Approver`] the provider seam attaches (a deny wins; no approver means nothing runs).
//! * **Honest outcomes.** [`Outcome`] says whether a call executed (`yes`, `no`, `unknown`) and whether its result was
//!   delivered. A timeout, a service that stopped mid-call or a reconnect is `unknown` and never `completed`; a result
//!   past the bound is `truncated`, executed but not delivered; nothing is retried by the host, so a tool never runs
//!   twice behind the model's back. A tool server's call is made by the harness, so [`server_outcome`] reads only the
//!   row the harness reports and claims success only from a `completed` row that carries its result.
//! * **Held credential on an HTTP tool server (ADR-0006).** [`attach`] adds the user's own held credential, which the
//!   package declared for that server (`credential: { source: "held", id }`) and the user granted (`credentials.use`
//!   for that item), as a header the host writes into the HTTP entry handed to the harness: `Authorization: Bearer`
//!   for `bearer`, the declared header for `header`. Each use is recorded (package, item, address; never the value) by
//!   `HeldUse`. A `stdio` server is package code and never receives a held value: its entry has an empty environment
//!   and only the resolved command, and the declaration refuses a credential on it. The value exists only inside the
//!   entry of [`Attachment::entries`]; [`Attachment::states`], [`Attachment::public_entries`], the `Debug` form, the
//!   trace and every JSON this module returns carry `[held]` or nothing. Other credential sources (`secret`,
//!   `entered`) stay `credentialPending` with `UnsupportedCapability`.
//! * **Disable and safe mode.** [`prune_resumed`] drops from a resumed session's tool names the package names that are
//!   no longer offered, and [`bridge_view`] is the zero-extension bridge when nothing is offered.
//!
//! Everything here is for predictability and fault isolation (ADR-0005): it reports what is true and withholds nothing
//! from a granted package.
use serde_json::{json, Map, Value};
use std::{
    collections::BTreeSet,
    fmt,
    sync::{Arc, Mutex},
};

use crate::extensions::{
    runtime_service_lifetime::runtime_held_credentials::{self as held, HeldUse},
    runtime_model_tools::{CallError, ModelTools, Served},
    runtime_tool_servers::{self as servers, Declaration, ToolServers},
};
use crate::providers::ToolHost;

pub const SCHEMA_VERSION: u64 = 1;
/// The header a `header` authentication uses when the declaration names none.
pub const DEFAULT_HEADER: &str = "X-API-Key";
pub const MAX_HEADER_VALUE: usize = 8_192;
pub const MAX_LINE: usize = 200;
pub const QUALIFICATIONS: [&str; 4] = ["sourceFeasible", "recorded", "installedQualified", "unsupported"];
/// What the tool-server attachment is today: the entries are built, the per-run providers do not read them yet.
pub const SERVER_ATTACHMENT: &str = "entriesReady";
const CLAUDE: [&str; 4] = ["claude", "glm", "mimo", "alibaba"];
const ACP: [&str; 12] = ["kimi", "opencode", "antigravity", "grok", "deepseek", "commandcode", "cline", "kilo", "github-copilot", "devin", "hermes", "cursor"];
/// Harnesses whose tool-host frames are recorded in the repository's protocol tests (the list of
/// `runtime_harness_coverage::RECORDED`).
pub const RECORDED: [&str; 7] = ["claude", "glm", "mimo", "alibaba", "codex", "kimi", "pi"];
/// `(harness, path)` pairs qualified by a separately authorized capture on an installed harness. None exists.
pub const INSTALLED_QUALIFIED: [(&str, &str); 0] = [];

// ---------------------------------------------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------------------------------------------

/// The family a harness id belongs to; `package` for a provider a package declares.
pub fn family(harness: &str, package: bool) -> &'static str {
    if package { "package" }
    else if CLAUDE.contains(&harness) { "claude" }
    else if ACP.contains(&harness) { "acp" }
    else { match harness { "codex" => "codex", "pi" | "omp" => "pi", "muse" => "muse", "zcode" => "zcode", _ => "unknown" } }
}

/// How a family receives the package's model tools: the bridge, or why it cannot.
fn model_bridge(family: &str) -> Result<&'static str, &'static str> {
    match family {
        "claude" => Ok("per-run MCP host (--mcp-config)"),
        "codex" => Ok("per-run MCP host (config mcp_servers)"),
        "acp" => Ok("per-run MCP host (session/new mcpServers)"),
        "pi" => Ok("Pi extension bridge"),
        "muse" => Ok("host tools"),
        "package" => Ok("core.tools of the provider"),
        "zcode" => Err("ZCode's per-session bridge is pending person decision A5 and is not wired."),
        _ => Err("This harness has no way to receive tools from the host."),
    }
}
/// The launch shape a family takes a tool server in, or why it takes none.
fn server_shape(family: &str) -> Result<&'static str, &'static str> {
    match family {
        "claude" => Ok("claude"),
        "codex" => Ok("codex"),
        "acp" => Ok("acp"),
        "pi" => Err("PandaCode's launch of this harness has no place for an MCP server entry."),
        "muse" => Err("PandaCode's launch of this harness has no place for an MCP server entry."),
        "package" => Err("A package provider reaches tools through core.tools, not through an MCP server entry."),
        "zcode" => Err("ZCode's per-session bridge is pending person decision A5 and is not wired."),
        _ => Err("This harness has no way to receive a tool server."),
    }
}
fn installed(harness: &str, path: &str) -> bool { INSTALLED_QUALIFIED.iter().any(|(id, qualified)| *id == harness && *qualified == path) }

/// One capability cell: `support`, the qualification and, when unsupported, `UnsupportedCapability` with the reason.
fn cell(harness: &str, supported: Result<&'static str, &'static str>, recorded: bool, path: &str) -> Value {
    match supported {
        Ok(bridge) => {
            let qualification = if installed(harness, path) { "installedQualified" } else if recorded { "recorded" } else { "sourceFeasible" };
            json!({"support": "supported", "qualification": qualification, "bridge": bridge, "code": Value::Null, "reason": Value::Null})
        }
        Err(reason) => json!({"support": "unsupported", "qualification": "unsupported", "bridge": Value::Null, "code": "UnsupportedCapability", "reason": reason}),
    }
}

/// The row of one harness: its family, model tools and tool servers. A tool-server cell is never `recorded`: no frame of
/// a real harness launched with such an entry exists.
pub fn row(harness: &str, package: bool) -> Value {
    let family = family(harness, package);
    let servers = server_shape(family);
    let mut tool_servers = cell(harness, servers, false, "toolServers");
    if let (Some(object), Ok(shape)) = (tool_servers.as_object_mut(), servers) {
        object.insert("shape".into(), json!(shape));
        object.insert("attachment".into(), json!(SERVER_ATTACHMENT));
    }
    json!({"harness": harness, "family": family, "modelTools": cell(harness, model_bridge(family), package || RECORDED.contains(&harness), "modelTools"), "toolServers": tool_servers})
}

/// A run path: the run kind, what started it, and whether the turn executes on this computer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Path { pub kind: &'static str, pub trigger: &'static str, pub here: bool, pub note: &'static str }
/// Every run path the host classifies (`runtime_harness_coverage::classify`). Only a mirrored run executes elsewhere.
pub const PATHS: [Path; 10] = [
    Path { kind: "task", trigger: "user", here: true, note: "" },
    Path { kind: "task", trigger: "package", here: true, note: "" },
    Path { kind: "task", trigger: "tool", here: true, note: "" },
    Path { kind: "worker", trigger: "team", here: true, note: "" },
    Path { kind: "worker", trigger: "council", here: true, note: "" },
    Path { kind: "bot", trigger: "bot", here: true, note: "" },
    Path { kind: "schedule", trigger: "schedule", here: true, note: "" },
    Path { kind: "remote", trigger: "remote", here: true, note: "A paired device's turn runs on this computer." },
    Path { kind: "remote", trigger: "cloud", here: true, note: "The cloud agent's tool host is built here." },
    Path { kind: "remote", trigger: "mirror", here: false, note: "The turn runs on another computer; this desktop only mirrors it." },
];

/// One cell of the matrix: the harness's two capabilities on one path.
pub fn path_cell(harness: &str, package: bool, path: &Path) -> Value {
    let base = row(harness, package);
    let on = |key: &str| {
        let mut capability = base[key].clone();
        if !path.here {
            capability = json!({"support": "unsupported", "qualification": "unsupported", "bridge": Value::Null, "code": "UnsupportedCapability", "reason": path.note});
        }
        capability
    };
    json!({"harness": harness, "kind": path.kind, "trigger": path.trigger, "modelTools": on("modelTools"), "toolServers": on("toolServers")})
}

/// Every harness against every run path. `harnesses` are `(id, is a package provider)`.
pub fn matrix(harnesses: &[(&str, bool)]) -> Vec<Value> {
    harnesses.iter().flat_map(|(harness, package)| PATHS.iter().map(move |path| path_cell(harness, *package, path))).collect()
}

/// The report: the schema version, the rows and the matrix.
pub fn report(harnesses: &[(&str, bool)]) -> Value {
    json!({"schemaVersion": SCHEMA_VERSION, "paths": PATHS.iter().map(|path| json!({"kind": path.kind, "trigger": path.trigger, "here": path.here})).collect::<Vec<_>>(),
        "rows": harnesses.iter().map(|(harness, package)| row(harness, *package)).collect::<Vec<_>>(), "matrix": matrix(harnesses)})
}

/// The launch shape of a harness's tool-server entries, `None` when it takes none.
pub fn shape_of(harness: &str, package: bool) -> Option<&'static str> { server_shape(family(harness, package)).ok() }

// ---------------------------------------------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------------------------------------------

/// Whether the tool ran.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Executed { No, Yes, Unknown }
impl Executed {
    pub fn as_str(self) -> &'static str { match self { Executed::No => "no", Executed::Yes => "yes", Executed::Unknown => "unknown" } }
}

/// What one tool call came to. `succeeded` is true only for a tool that ran and whose result reached the model.
#[derive(Clone, Debug, PartialEq)]
pub struct Outcome {
    /// `completed`, `failed`, `refused`, `unavailable`, `interrupted` or `truncated`.
    pub status: &'static str,
    pub executed: Executed,
    pub delivered: bool,
    pub code: Option<&'static str>,
    pub line: String,
    /// What the model receives; never part of [`Outcome::json`].
    pub result: Option<Value>,
}
fn bounded(text: &str) -> String { text.chars().take(MAX_LINE).collect() }
impl Outcome {
    fn new(status: &'static str, executed: Executed, delivered: bool, code: Option<&'static str>, line: &str) -> Self {
        Self { status, executed, delivered, code, line: bounded(line), result: None }
    }
    pub fn succeeded(&self) -> bool { self.status == "completed" && self.executed == Executed::Yes && self.delivered }
    /// The diagnostics and recorder form: the status and the line, never the result.
    pub fn json(&self) -> Value {
        json!({"status": self.status, "executed": self.executed.as_str(), "delivered": self.delivered, "code": self.code, "line": self.line,
            "resultBytes": self.result.as_ref().map(|result| result.to_string().len())})
    }
}

/// What a failed call of the package model-tool registry came to. The service may have run the tool when it timed
/// out, stopped mid-call or answered something the host cannot use, so those are `unknown` or `failed`, never `no`.
pub fn classify_error(error: &CallError) -> Outcome {
    let line = error.message.as_str();
    let (status, executed, delivered) = match error.code {
        "NotFound" | "PermissionDenied" => ("refused", Executed::No, false),
        "InvalidShape" if line.contains("answered") => ("failed", Executed::Yes, false),
        "InvalidShape" => ("refused", Executed::No, false),
        "LimitExceeded" if line.starts_with("The result") => ("truncated", Executed::Yes, false),
        "LimitExceeded" => ("refused", Executed::No, false),
        "Timeout" => ("interrupted", Executed::Unknown, false),
        "HostUnavailable" if line.contains("stopped before") || line.contains("failed in") => ("interrupted", Executed::Unknown, false),
        _ => ("unavailable", Executed::No, false),
    };
    Outcome::new(status, executed, delivered, Some(error.code), line)
}

/// What a served call came to: an error result of the handler ran and was delivered, but is not a success.
pub fn served_outcome(served: &Served) -> Outcome {
    let mut outcome = if served.is_error { Outcome::new("failed", Executed::Yes, true, None, "The tool answered an error result.") } else { Outcome::new("completed", Executed::Yes, true, None, "") };
    outcome.result = Some(served.content.clone());
    outcome
}

/// A tool server's call is made by the harness; the host sees the row the harness reports. Success is claimed only for a
/// `completed` row that carries its output and was not cut; a reconnect, a cancel or a row without its result is
/// `unknown`.
pub fn server_outcome(row: &Value) -> Outcome {
    let output = row.get("output").filter(|output| !output.is_null());
    match (row["status"].as_str().unwrap_or_default(), output) {
        ("completed", Some(output)) if row["truncated"] == true => { let mut outcome = Outcome::new("truncated", Executed::Yes, false, Some("LimitExceeded"), "The result was cut by the harness."); outcome.result = Some(output.clone()); outcome }
        ("completed", Some(output)) => { let mut outcome = Outcome::new("completed", Executed::Yes, true, None, ""); outcome.result = Some(output.clone()); outcome }
        ("completed", None) => Outcome::new("interrupted", Executed::Unknown, false, Some("HostUnavailable"), "The harness reported the call done without its result."),
        ("failed", _) => Outcome::new("failed", Executed::Unknown, false, None, "The harness reported the call failed."),
        _ => Outcome::new("interrupted", Executed::Unknown, false, Some("HostUnavailable"), "The server was cancelled, reconnected or never answered."),
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Provider core.tools over the run's tool host
// ---------------------------------------------------------------------------------------------------------------

/// What a tool name is right now.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Lookup { Core, Package { owner: String }, Gone }
/// Looks a tool name up against the live inventory: a package tool that is no longer offered is `Gone`.
pub type Resolve = Arc<dyn Fn(&str) -> Lookup + Send + Sync>;
/// The decision on a tool that needs approval.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Verdict { Allow, Deny(String) }
/// What an approver is asked about: the call, never its input.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CallFacts { pub run: String, pub kind: String, pub mode: String, pub tool: String, pub package: Option<String>, pub input_bytes: usize }
/// Decides a call that needs approval. It stands for the harness's own request (the `tool.before` the deciding hooks see).
pub type Approver = Arc<dyn Fn(&CallFacts) -> Verdict + Send + Sync>;
/// What the bridge and the stand-ins record, without any input or result.
pub type Trace = Arc<Mutex<Vec<Value>>>;

/// The mode's rule for a tool that needs approval, as the per-run tool host applies it: `plan` refuses, `full` allows,
/// the other modes ask (`user_allows` is the answer to the prompt).
pub fn mode_verdict(mode: &str, user_allows: bool) -> Verdict {
    match mode {
        "plan" => Verdict::Deny("This host action is unavailable in Plan mode".into()),
        "full" => Verdict::Allow,
        _ if user_allows => Verdict::Allow,
        _ => Verdict::Deny("The user declined.".into()),
    }
}

/// `core.tools.list()` and `core.tools.call()` of a package provider, over the run's own tool host.
#[derive(Clone)]
pub struct CoreBridge { host: ToolHost, resolve: Resolve, approver: Option<Approver>, trace: Trace }
impl CoreBridge {
    pub fn new(host: ToolHost, resolve: Resolve, approver: Option<Approver>, trace: Trace) -> Self { Self { host, resolve, approver, trace } }
    fn note(&self, entry: Value) { if let Ok(mut trace) = self.trace.lock() { trace.push(entry); } }

    /// The tools the run offers now: the host's own list without a package tool that is no longer offered.
    pub fn list(&self) -> Vec<Value> {
        self.host.tools.iter().filter_map(|tool| {
            let name = tool["name"].as_str()?;
            let owner = match (self.resolve)(name) { Lookup::Gone => return None, Lookup::Core => Value::Null, Lookup::Package { owner } => json!(owner) };
            Some(json!({"name": name, "description": tool["description"], "inputSchema": tool["inputSchema"], "owner": owner, "needsApproval": self.host.approval_tools.contains(name)}))
        }).collect()
    }

    /// One call. The tool is looked up again (a disabled or revoked package answers `NotFound` and nothing runs), a tool
    /// that needs approval is decided by the approver, and then the run's own handler serves it, which is where the
    /// `tool.after` hook and the package's grant check live. The host never retries.
    pub async fn call(&self, run: &str, kind: &str, mode: &str, name: &str, input: Value) -> Outcome {
        let known = self.host.tools.iter().any(|tool| tool["name"] == name);
        let lookup = (self.resolve)(name);
        if !known || lookup == Lookup::Gone {
            self.note(json!({"event": "tool.refused", "tool": name, "code": "NotFound"}));
            return Outcome::new("refused", Executed::No, false, Some("NotFound"), &format!("The tool {name} is not available."));
        }
        let package = match &lookup { Lookup::Package { owner } => Some(owner.clone()), _ => None };
        let needs = self.host.approval_tools.contains(name);
        if needs {
            let facts = CallFacts { run: run.into(), kind: kind.into(), mode: mode.into(), tool: name.into(), package: package.clone(), input_bytes: input.to_string().len() };
            match self.approver.as_ref().map(|approver| approver(&facts)) {
                None => {
                    self.note(json!({"event": "tool.before", "tool": name, "asked": true, "verdict": "unavailable"}));
                    return Outcome::new("unavailable", Executed::No, false, Some("HostUnavailable"), &format!("{name} needs approval and no approval is attached to this call."));
                }
                Some(Verdict::Deny(reason)) => {
                    self.note(json!({"event": "tool.before", "tool": name, "asked": true, "verdict": "deny"}));
                    return Outcome::new("refused", Executed::No, false, Some("PermissionDenied"), &reason);
                }
                Some(Verdict::Allow) => self.note(json!({"event": "tool.before", "tool": name, "asked": true, "verdict": "allow"})),
            }
        } else {
            self.note(json!({"event": "tool.before", "tool": name, "asked": false, "verdict": "allow"}));
        }
        match (self.host.handler)(name.to_owned(), input).await {
            Ok(result) => { let mut outcome = Outcome::new("completed", Executed::Yes, true, None, ""); outcome.result = Some(result); outcome }
            // The handler's error is a line, not a code: the tool may or may not have run, so nothing is claimed.
            Err(line) => Outcome::new("failed", Executed::Unknown, false, None, &line),
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------
// The held credential of an HTTP tool server
// ---------------------------------------------------------------------------------------------------------------

/// A header name: letters, digits and hyphens.
pub fn valid_header(name: &str) -> bool { (1..=64).contains(&name.len()) && name.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-') }

/// How a server's credential becomes a header.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Plan { pub item: String, pub header: String, pub prefix: &'static str }

/// The header a declaration asks for. `Ok(None)`: no credential (a `stdio` server never has one). `UnsupportedCapability`:
/// a credential source this slice does not attach (`secret`, `entered`).
pub fn header_plan(declaration: &Declaration) -> Result<Option<Plan>, &'static str> {
    if declaration.transport != "http" || declaration.authentication == "none" { return Ok(None); }
    let credential = declaration.credential.as_ref().ok_or("InvalidShape")?;
    if credential["source"] != "held" { return Err("UnsupportedCapability"); }
    let item = credential["id"].as_str().filter(|item| held::valid_item(item)).ok_or("InvalidShape")?;
    let (header, prefix) = if declaration.authentication == "bearer" { ("Authorization".to_owned(), "Bearer ") } else {
        let name = match credential.get("header") {
            None | Some(Value::Null) => DEFAULT_HEADER,
            Some(value) => value.as_str().filter(|name| valid_header(name)).ok_or("InvalidShape")?,
        };
        (name.to_owned(), "")
    };
    Ok(Some(Plan { item: item.to_owned(), header, prefix }))
}

/// The HTTP entry of a harness shape with one host-added header.
fn http_entry(shape: &str, name: &str, url: &str, header: &str, value: &str) -> Value {
    match shape {
        "claude" => { let mut headers = Map::new(); headers.insert(header.to_owned(), json!(value)); json!({"type": "http", "url": url, "headers": headers}) }
        "codex" => { let mut headers = Map::new(); headers.insert(header.to_owned(), json!(value)); json!({"url": url, "enabled": true, "http_headers": headers}) }
        _ => json!({"type": "http", "name": name, "url": url, "headers": [{"name": header, "value": value}]}),
    }
}

/// Replaces every occurrence of a held value in a JSON tree with `[held]`.
pub fn scrub(value: &mut Value, secrets: &[String]) {
    match value {
        Value::String(text) => { if secrets.iter().any(|secret| !secret.is_empty() && text.contains(secret.as_str())) { *text = "[held]".into(); } }
        Value::Array(items) => items.iter_mut().for_each(|item| scrub(item, secrets)),
        Value::Object(fields) => fields.values_mut().for_each(|item| scrub(item, secrets)),
        _ => {}
    }
}

/// The entries a harness is given for one run and the states the user sees. [`Attachment::entries`] is the only place a
/// held value lives; hand it to the harness launch and nowhere else.
#[derive(Default)]
pub struct Attachment { states: Vec<Value>, entries: Vec<(String, Value)>, secrets: Vec<String> }
impl Attachment {
    /// The states of every server of the run, with the credential's item and header and never its value.
    pub fn states(&self) -> &[Value] { &self.states }
    /// `(name, entry)` for the harness launch. An http entry with a credential carries its header value.
    pub fn entries(&self) -> &[(String, Value)] { &self.entries }
    /// The same entries with every held value replaced by `[held]`: for diagnostics, the recorder and the tests.
    pub fn public_entries(&self) -> Vec<(String, Value)> {
        self.entries.iter().map(|(name, entry)| { let mut entry = entry.clone(); scrub(&mut entry, &self.secrets); (name.clone(), entry) }).collect()
    }
    pub fn names(&self) -> Vec<String> { self.entries.iter().map(|(name, _)| name.clone()).collect() }
}
impl fmt::Debug for Attachment {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_struct("Attachment").field("states", &self.states).field("entries", &self.public_entries()).finish()
    }
}

/// What [`attach`] reads: the run registry, the held store and the answer to "did the user grant `credentials.use` for
/// this item to this package version".
pub struct Ports<'a> { pub servers: &'a ToolServers, pub held: &'a HeldUse, pub holds_item: &'a dyn Fn(&str, &str, &str) -> bool }

fn state_line(base: &Value, state: &str, error: Option<&str>, credential: Value) -> Value {
    let mut out = base.clone();
    out["state"] = json!(state);
    out["error"] = error.map_or(Value::Null, |line| json!(bounded(line)));
    out["credential"] = credential;
    out
}

/// The entries of `run` (`project`) for one harness `shape` (`claude`, `codex`, `acp`): what the registry attached, plus
/// each credential-pending HTTP server whose held credential the package declared, the user granted and PandaCode holds,
/// with the header the host adds. A server whose credential cannot be attached stays out of the entries and says why in
/// its state (`credentialDenied`, `credentialMissing`, `credentialInvalid`, `credentialUnavailable`, or
/// `credentialPending` for a source this slice does not attach). Every attached use is recorded by `HeldUse`.
pub fn attach(ports: &Ports, run: &str, project: &str, shape: &str) -> Attachment {
    let mut out = Attachment { entries: ports.servers.mcp_entries(run, shape), ..Attachment::default() };
    let listed = ports.servers.listed(project);
    for base in ports.servers.state(run) {
        if base["state"] != "credentialPending" { out.states.push(base); continue; }
        let id = base["id"].as_str().unwrap_or_default();
        let Some(server) = listed.iter().find(|server| server.declaration.id == id) else { out.states.push(state_line(&base, "failed", Some("The server is no longer offered."), Value::Null)); continue };
        let plan = match header_plan(&server.declaration) {
            Ok(Some(plan)) => plan,
            Ok(None) => { out.states.push(base); continue; }
            Err(code) => { out.states.push(state_line(&base, "credentialPending", Some(&format!("Its credential source is not attached by the host ({code}).")), json!({"state": "unsupported", "code": code}))); continue; }
        };
        let credential = |state: &str| json!({"item": plan.item, "header": plan.header, "state": state});
        if !(ports.holds_item)(&server.owner, &server.version, &plan.item) {
            out.states.push(state_line(&base, "credentialDenied", Some("The package was not granted this credential."), credential("denied")));
            continue;
        }
        let Ok(address) = reqwest::Url::parse(&server.declaration.url).map(|url| held::address_of(&url)) else {
            out.states.push(state_line(&base, "failed", Some("The server address is not valid."), credential("invalid")));
            continue;
        };
        let value = match ports.held.use_credential(&server.owner, &server.version, &plan.item, &address) {
            Ok(value) => value,
            Err("NotFound") => { out.states.push(state_line(&base, "credentialMissing", Some("PandaCode holds no such credential."), credential("missing"))); continue; }
            Err(code) => { out.states.push(state_line(&base, "credentialUnavailable", Some(&format!("The credential could not be used ({code}).")), credential("unavailable"))); continue; }
        };
        let header_value = format!("{}{value}", plan.prefix);
        if header_value.len() > MAX_HEADER_VALUE || header_value.bytes().any(|byte| byte < 0x20 || byte == 0x7f) {
            out.states.push(state_line(&base, "credentialInvalid", Some("The credential cannot be sent as a header."), credential("invalid")));
            continue;
        }
        let name = servers::server_name(id);
        out.entries.push((name.clone(), http_entry(shape, &name, &server.declaration.url, &plan.header, &header_value)));
        out.secrets.extend([value, header_value]);
        out.states.push(state_line(&base, "attached", None, credential("attached")));
    }
    out.entries.sort_by(|left, right| left.0.cmp(&right.0));
    out
}

/// The same attachment for a live run: the app's registry, the user's held store and the grants file.
pub fn attach_for_run(app: &tauri::AppHandle, run: &str, shape: &str) -> Attachment {
    use crate::extensions::runtime_grants::{RuntimeGrants, Target};
    use tauri::Manager;
    let Some(facts) = crate::extensions::runtime_hook_registration::facts_of(app, run, None, None, false) else { return Attachment::default() };
    let holds = |owner: &str, version: &str, item: &str| app.try_state::<RuntimeGrants>().is_some_and(|grants| grants.check(owner, version, held::PERMISSION, &Target::item(item)).is_ok());
    let shared = held::shared();
    attach(&Ports { servers: servers::registry(), held: &shared, holds_item: &holds }, run, &facts.project_id, shape)
}

/// Whether any entry that runs a package's own command (`stdio`) carries `needle` in its arguments or environment.
pub fn stdio_carries(entries: &[(String, Value)], needle: &str) -> bool {
    entries.iter().filter(|(_, entry)| entry.get("command").is_some()).any(|(_, entry)| entry.to_string().contains(needle))
}

// ---------------------------------------------------------------------------------------------------------------
// Disable, safe mode and a resumed session
// ---------------------------------------------------------------------------------------------------------------

/// The package tool names a run is offered now: the model tools of its project and, per attached server, `mcp__<server>__<tool>`
/// (or `mcp__<server>__*` when the server announced no tool names).
pub fn offered_names(model: &ModelTools, tool_servers: &ToolServers, attachment: &Attachment, run: &str, project: &str) -> BTreeSet<String> {
    let mut out: BTreeSet<String> = model.listed(project).iter().map(|listed| listed.declaration.name.clone()).collect();
    for (id, tools) in tool_servers.tools(run) {
        let name = servers::server_name(&id);
        if tools.is_empty() { out.insert(format!("mcp__{name}__*")); }
        out.extend(tools.into_iter().map(|tool| format!("mcp__{name}__{tool}")));
    }
    out.extend(attachment.names().into_iter().map(|name| format!("mcp__{name}__*")));
    out
}

/// A resumed session's tool names after the package names that are no longer offered are removed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pruned { pub kept: Vec<String>, pub removed: Vec<String> }

/// `previous` is the tool names the session was holding; `package_known` the package tool names it was ever offered (the
/// plain model-tool names cannot be told apart otherwise); `current` is [`offered_names`] now. A name that is a package's
/// (known, or `mcp__pkg_…`) and not offered now is removed, so a disabled package, a revoked grant or safe mode leaves no
/// stale tool in the resumed session.
pub fn prune_resumed(previous: &[String], package_known: &BTreeSet<String>, current: &BTreeSet<String>) -> Pruned {
    let covered = |name: &str| current.contains(name) || current.iter().any(|offered| offered.strip_suffix('*').is_some_and(|prefix| name.starts_with(prefix)));
    let (mut kept, mut removed) = (Vec::new(), Vec::new());
    for name in previous {
        if (package_known.contains(name) || name.starts_with("mcp__pkg_")) && !covered(name) { removed.push(name.clone()); } else { kept.push(name.clone()); }
    }
    Pruned { kept, removed }
}

/// The bridge of a run: its package tools and servers, or the zero-extension bridge when nothing is offered.
pub fn bridge_view(offered: &BTreeSet<String>) -> Value {
    let (models, servers): (Vec<&String>, Vec<&String>) = offered.iter().partition(|name| !name.starts_with("mcp__"));
    json!({"zeroExtension": offered.is_empty(), "modelTools": models, "toolServers": servers})
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::extensions::{
        runtime_service_lifetime::runtime_held_credentials::{Files, Held},
        runtime_hook_registration::RUN_KINDS,
        runtime_model_tools::{self as model, MAX_RESULT_BYTES},
        runtime_tool_servers::Resolver,
    };
    use std::{
        collections::{BTreeMap, HashSet},
        future::Future,
        pin::Pin,
        sync::atomic::{AtomicUsize, Ordering},
    };
    use tokio::sync::oneshot;

    const SCENARIOS: &str = include_str!("../../../tests/fixtures/extensions/runtime-model-tool-parity/scenarios.json");
    const MANIFEST: &str = include_str!("../../../tests/fixtures/extensions/runtime-model-tool-parity/extension.json");
    const OWNER: &str = "sample.parity";
    const PROJECT: &str = "p1";

    fn scenarios() -> Value { serde_json::from_str(SCENARIOS).unwrap() }
    fn manifest() -> Value { serde_json::from_str(MANIFEST).unwrap() }
    fn sentinel() -> String { scenarios()["sentinel"].as_str().unwrap().to_owned() }

    struct Dir(std::path::PathBuf);
    impl Dir { fn new() -> Self { let path = std::env::temp_dir().join(format!("pandacode-tool-parity-{}", uuid::Uuid::new_v4())); std::fs::create_dir(&path).unwrap(); Self(path) } }
    impl Drop for Dir { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }
    struct Fake(BTreeMap<String, String>);
    impl Held for Fake { fn value(&self, item: &str) -> Option<String> { self.0.get(item).cloned() } }

    /// Both registries over the fixture package, with the grant, the enablement and the held store under test control.
    struct World {
        model: Arc<ModelTools>,
        servers: ToolServers,
        enabled: Arc<Mutex<bool>>,
        projects: Arc<Mutex<BTreeSet<String>>>,
        items: Arc<Mutex<BTreeSet<String>>>,
        held: HeldUse,
        _dir: Dir,
    }
    fn world(answer: impl Fn(Value) -> Option<Value> + Send + Sync + 'static) -> World {
        let enabled = Arc::new(Mutex::new(true));
        let projects: Arc<Mutex<BTreeSet<String>>> = Arc::new(Mutex::new([PROJECT.to_owned()].into()));
        let items: Arc<Mutex<BTreeSet<String>>> = Arc::new(Mutex::new(scenarios()["held"].as_object().unwrap().keys().cloned().collect()));
        let gate = { let (enabled, projects) = (enabled.clone(), projects.clone()); move |owner: &str, _: &str, permission: &str, project: Option<&str>| {
            *enabled.lock().unwrap() && owner == OWNER && permission == model::PERMISSION && project.map_or_else(|| !projects.lock().unwrap().is_empty(), |project| projects.lock().unwrap().contains(project))
        } };
        let model = Arc::new(ModelTools::default());
        let declarations = model::check(&manifest()).unwrap();
        let source = { let enabled = enabled.clone(); move || if *enabled.lock().unwrap() { vec![model::Entry { owner: OWNER.into(), version: "1.0.0".into(), package_name: "Parity".into(), declarations: declarations.clone() }] } else { vec![] } };
        model.set_source(Arc::new(source));
        model.set_gate(Arc::new(gate.clone()));
        model.set_ask(Arc::new(move |_, frame: Value| {
            let (reply, receiver) = oneshot::channel();
            match answer(frame) { Some(value) => { let _ = reply.send(Ok(value)); } None => drop(reply) }
            Ok(receiver)
        }));
        let tool_servers = ToolServers::default();
        let server_declarations = servers::check(&manifest()).unwrap();
        let resolver: Resolver = Arc::new(|| Some("C:/code/sample.parity".to_owned()));
        let source = { let enabled = enabled.clone(); move || if *enabled.lock().unwrap() { vec![servers::Entry { owner: OWNER.into(), version: "1.0.0".into(), package_name: "Parity".into(), declarations: server_declarations.clone(), package_dir: Some(resolver.clone()) }] } else { vec![] } };
        tool_servers.set_source(Arc::new(source));
        tool_servers.set_gate(Arc::new(gate));
        tool_servers.set_node(Arc::new(|| Some("C:/runtime/node.exe".to_owned())));
        tool_servers.set_probe(Arc::new(|_: &[String], _: &str| Ok(vec!["docs_search".to_owned()])));
        let dir = Dir::new();
        let values: BTreeMap<String, String> = scenarios()["held"].as_object().unwrap().iter().map(|(item, value)| (item.clone(), value.as_str().unwrap().to_owned())).collect();
        let held = HeldUse::new(Box::new(Fake(values)), Files::open(&dir.0));
        World { model, servers: tool_servers, enabled, projects, items, held, _dir: dir }
    }
    impl World {
        fn ports<'a>(&'a self, holds: &'a dyn Fn(&str, &str, &str) -> bool) -> Ports<'a> { Ports { servers: &self.servers, held: &self.held, holds_item: holds } }
        fn holds(&self) -> impl Fn(&str, &str, &str) -> bool + '_ { move |owner, _, item| owner == OWNER && self.items.lock().unwrap().contains(item) }
        fn register_all(&self) { for tool in ["recall", "quiet", "big_dump"] { self.model.register(OWNER, &format!("{OWNER}/{tool}")).unwrap(); } }
    }

    /// The run's tool host as `build_task_host` leaves it: one app tool, the listed package tools, and a handler that serves
    /// a package tool through the registry (its grant checked then) and records the `tool.after` the result hooks deliver.
    fn host(world: &World, trace: &Trace) -> ToolHost {
        let core = json!({"type": "function", "name": "pandacode_preview_file", "description": "Open a preview.", "inputSchema": {"type": "object"}});
        let listed = world.model.listed(PROJECT);
        let mut tools = vec![core];
        let mut approval: HashSet<String> = HashSet::new();
        for tool in &listed { tools.push(tool.spec()); if tool.declaration.approval != "never" { approval.insert(tool.declaration.name.clone()); } }
        let names: BTreeSet<String> = listed.iter().map(|tool| tool.declaration.name.clone()).collect();
        let (registry, trace) = (world.model.clone(), trace.clone());
        ToolHost {
            tools,
            approval_tools: approval,
            handler: Arc::new(move |name: String, input: Value| {
                let (registry, trace, names) = (registry.clone(), trace.clone(), names.clone());
                Box::pin(async move {
                    if !names.contains(&name) { return Ok(json!({"core": true})); }
                    let result = registry.call(PROJECT, &name, input, json!({"callId": "model-0", "taskId": "t1", "projectId": PROJECT})).await;
                    trace.lock().unwrap().push(json!({"event": "tool.after", "tool": name, "ok": result.is_ok()}));
                    match result { Ok(served) => model::model_result(&served), Err(error) => Err(error.message) }
                }) as Pin<Box<dyn Future<Output = Result<Value, String>> + Send>>
            }),
        }
    }
    fn bridge(world: &World, trace: &Trace, mode: &str, allow: bool) -> CoreBridge {
        let mode = mode.to_owned();
        let model = world.model.clone();
        let resolve: Resolve = Arc::new(move |name| match model.listed(PROJECT).into_iter().find(|listed| listed.declaration.name == name) {
            Some(listed) => Lookup::Package { owner: listed.owner },
            None if ["recall", "quiet", "big_dump"].contains(&name) => Lookup::Gone,
            None => Lookup::Core,
        });
        let approver: Approver = Arc::new(move |_| mode_verdict(&mode, allow));
        CoreBridge::new(host(world, trace), resolve, Some(approver), trace.clone())
    }
    fn echo() -> impl Fn(Value) -> Option<Value> + Send + Sync + 'static { |frame| Some(json!({"content": {"echo": frame["input"]}})) }
    fn call(bridge: &CoreBridge, mode: &str, name: &str, input: Value) -> Outcome { tauri::async_runtime::block_on(bridge.call("run-1", "task", mode, name, input)) }

    #[test]
    fn every_path_kind_is_a_run_kind_and_unsupported_harnesses_say_why() {
        assert!(PATHS.iter().all(|path| RUN_KINDS.contains(&path.kind)));
        for kind in RUN_KINDS { assert!(PATHS.iter().any(|path| path.kind == kind), "{kind}"); }
        let cases = scenarios();
        for case in cases["capabilities"].as_array().unwrap() {
            let row = row(case["harness"].as_str().unwrap(), case["package"] == true);
            let label = case["harness"].as_str().unwrap();
            assert_eq!(row["family"], case["family"], "{label}");
            for key in ["modelTools", "toolServers"] {
                assert_eq!(row[key]["support"], case[key]["support"], "{label} {key}");
                assert_eq!(row[key]["qualification"], case[key]["qualification"], "{label} {key}");
                if case[key]["support"] == "unsupported" { assert_eq!((&row[key]["code"], row[key]["reason"].is_string()), (&json!("UnsupportedCapability"), true), "{label} {key}"); }
            }
            assert_eq!(shape_of(label, case["package"] == true), case["shape"].as_str(), "{label}");
        }
        assert!(row("claude", false)["toolServers"]["qualification"] != "recorded", "no recorded frame carries a tool-server entry");
        assert_eq!(row("claude", false)["toolServers"]["attachment"], SERVER_ATTACHMENT);
    }

    #[test]
    fn a_mirrored_run_executes_nothing_here() {
        let mirror = PATHS.iter().find(|path| path.trigger == "mirror").unwrap();
        let cell = path_cell("claude", false, mirror);
        assert_eq!((cell["modelTools"]["support"].as_str(), cell["toolServers"]["code"].as_str()), (Some("unsupported"), Some("UnsupportedCapability")));
        assert_eq!(matrix(&[("claude", false), ("kimi", false)]).len(), 2 * PATHS.len());
    }

    /// One scenario per supported run path: discover the package tool through the provider bridge and invoke it with the
    /// approval and hook path of the run's mode, then attach the servers of the harness shape with the held header.
    #[test]
    fn each_supported_run_path_discovers_and_invokes_the_package_tool() {
        let secret = sentinel();
        for path in scenarios()["paths"].as_array().unwrap() {
            let label = path["id"].as_str().unwrap();
            let (harness, mode) = (path["harness"].as_str().unwrap(), path["mode"].as_str().unwrap());
            let world = world(echo());
            world.register_all();
            let trace: Trace = Arc::default();
            let bridge = bridge(&world, &trace, mode, true);
            let listed = bridge.list();
            let recall = listed.iter().find(|tool| tool["name"] == "recall").unwrap_or_else(|| panic!("{label}: not discovered"));
            assert_eq!((recall["owner"].as_str(), recall["needsApproval"].as_bool()), (Some(OWNER), Some(true)), "{label}");
            assert_eq!(listed.iter().find(|tool| tool["name"] == "quiet").unwrap()["needsApproval"], false, "{label}");
            assert!(listed.iter().any(|tool| tool["owner"].is_null()), "{label}: the app's own tool is listed too");

            let outcome = call(&bridge, mode, "recall", json!({"query": "pnpm"}));
            if path["expect"] == "denied" {
                assert_eq!((outcome.status, outcome.executed, outcome.code), ("refused", Executed::No, Some("PermissionDenied")), "{label}");
                assert!(!trace.lock().unwrap().iter().any(|event| event["event"] == "tool.after"), "{label}: a denied tool never runs");
            } else {
                assert!(outcome.succeeded(), "{label}: {outcome:?}");
                assert_eq!(outcome.result.unwrap()["echo"]["query"], "pnpm", "{label}");
                let events: Vec<String> = trace.lock().unwrap().iter().map(|event| event["event"].as_str().unwrap().to_owned()).collect();
                assert_eq!(events, ["tool.before", "tool.after"], "{label}: the approval and the hook are the model tool's own");
            }
            assert!(call(&bridge, mode, "quiet", json!({})).succeeded(), "{label}: a tool declared without approval is not asked");
            assert!(call(&bridge, mode, "pandacode_preview_file", json!({})).succeeded(), "{label}: the app's own tool");

            // The tool servers of this harness's launch shape.
            let shape = shape_of(harness, false).expect(label);
            world.servers.attach_run("run-1", PROJECT, "C:/work/p1");
            let holds = world.holds();
            let attached = attach(&world.ports(&holds), "run-1", PROJECT, shape);
            let by_name = |name: &str| attached.entries().iter().find(|(held, _)| held == name).map(|(_, entry)| entry.clone()).unwrap_or_else(|| panic!("{label}: {name}"));
            assert_eq!(attached.entries().len(), 4, "{label}");
            let (secured, keyed) = (by_name("pkg_sample_parity__secured").to_string(), by_name("pkg_sample_parity__keyed").to_string());
            assert!(secured.contains(&format!("Bearer {}", scenarios()["held"]["provider:glm"].as_str().unwrap())), "{label}: bearer header");
            assert!(keyed.contains("X-Docs-Key") && keyed.contains(scenarios()["held"]["connection:docs"].as_str().unwrap()), "{label}: declared header");
            assert!(!stdio_carries(attached.entries(), &secret) && !stdio_carries(attached.entries(), "Bearer"), "{label}: a stdio server never receives a held value");
            let everything = format!("{:?}{}{}{}", attached, json!(attached.states()), json!(attached.public_entries()), json!(trace.lock().unwrap().clone()));
            for value in scenarios()["held"].as_object().unwrap().values() { assert!(!everything.contains(value.as_str().unwrap()), "{label}: a held value leaked into a public form"); }
            assert!(!everything.contains(&secret), "{label}");
            world.servers.detach_run("run-1");
        }
    }

    #[test]
    fn a_stdio_server_gets_no_environment_value_in_any_shape() {
        let world = world(echo());
        world.servers.attach_run("run-1", PROJECT, "");
        let holds = world.holds();
        for shape in ["claude", "codex", "acp"] {
            let attached = attach(&world.ports(&holds), "run-1", PROJECT, shape);
            let local = attached.entries().iter().find(|(name, _)| name == "pkg_sample_parity__local").unwrap().1.clone();
            assert!(local.get("env").is_none_or(|env| env == &json!({}) || env == &json!([])), "{shape}");
            assert!(local.get("headers").is_none() && local.get("http_headers").is_none(), "{shape}");
            for value in scenarios()["held"].as_object().unwrap().values() { assert!(!stdio_carries(attached.entries(), value.as_str().unwrap()), "{shape}"); }
        }
        let mut declaration = servers::check(&manifest()).unwrap().remove(0);
        assert_eq!(declaration.transport, "stdio");
        assert_eq!(header_plan(&declaration), Ok(None));
        declaration.authentication = "bearer".into();
        assert_eq!(header_plan(&declaration), Ok(None), "even a hand-built stdio declaration is given no header");
    }

    #[test]
    fn the_credential_is_attached_only_when_declared_granted_and_held() {
        let world = world(echo());
        world.servers.attach_run("run-1", PROJECT, "");
        let state_of = |attached: &Attachment, id: &str| attached.states().iter().find(|state| state["id"] == id).unwrap().clone();
        let holds = world.holds();
        let attached = attach(&world.ports(&holds), "run-1", PROJECT, "claude");
        assert_eq!(state_of(&attached, "sample.parity/secured")["state"], "attached");
        assert_eq!(state_of(&attached, "sample.parity/secured")["credential"], json!({"item": "provider:glm", "header": "Authorization", "state": "attached"}));
        let uses = world.held.files().activity(OWNER);
        assert_eq!(uses.len(), 2, "each attached use is recorded");
        assert!(uses.iter().all(|entry| entry.kind == "credential.use" && entry.package == OWNER && entry.address.as_deref().is_some_and(|address| address == "https://docs.example.com/mcp" || address == "https://keyed.example.com/mcp")));
        assert!(!format!("{uses:?}").contains(&sentinel()));

        world.items.lock().unwrap().remove("provider:glm");
        let denied = attach(&world.ports(&holds), "run-1", PROJECT, "claude");
        assert_eq!(state_of(&denied, "sample.parity/secured")["state"], "credentialDenied");
        assert!(!denied.names().contains(&"pkg_sample_parity__secured".to_owned()), "a server without its credential is not handed over");
        assert_eq!(world.held.files().activity(OWNER).len(), 3, "a refused use writes nothing");

        let none = Fake(BTreeMap::new());
        let empty = HeldUse::new(Box::new(none), Files::open(&world._dir.0));
        let all = |_: &str, _: &str, _: &str| true;
        let missing = attach(&Ports { servers: &world.servers, held: &empty, holds_item: &all }, "run-1", PROJECT, "codex");
        assert_eq!(state_of(&missing, "sample.parity/keyed")["state"], "credentialMissing");

        // A credential source this slice does not attach stays pending, with the reason.
        let mut declaration = servers::check(&manifest()).unwrap().remove(3);
        declaration.credential = Some(json!({"source": "secret", "key": "docs-token"}));
        assert_eq!(header_plan(&declaration), Err("UnsupportedCapability"));
        declaration.credential = Some(json!({"source": "held", "id": "connection:docs", "header": "Bad Header"}));
        assert_eq!(header_plan(&declaration), Err("InvalidShape"));
    }

    #[test]
    fn a_revoked_grant_or_safe_mode_leaves_no_attachment() {
        let world = world(echo());
        let all = |_: &str, _: &str, _: &str| true;
        world.servers.attach_run("run-1", PROJECT, "");
        assert!(attach(&world.ports(&all), "run-1", PROJECT, "claude").entries().len() >= 3);
        *world.enabled.lock().unwrap() = false;
        world.servers.reconcile();
        let gone = attach(&world.ports(&all), "run-1", PROJECT, "claude");
        assert!(gone.entries().is_empty() && gone.states().is_empty());
    }

    #[test]
    fn disable_and_revoke_keep_the_inventory_and_the_execution_coherent() {
        let world = world(echo());
        world.register_all();
        let trace: Trace = Arc::default();
        let bridge = bridge(&world, &trace, "ask", true);
        assert!(call(&bridge, "ask", "recall", json!({"query": "a"})).succeeded());
        world.projects.lock().unwrap().clear();
        assert!(bridge.list().iter().all(|tool| tool["name"] != "recall" && tool["name"] != "quiet"), "a revoked grant removes the listing");
        let refused = call(&bridge, "ask", "recall", json!({"query": "a"}));
        assert_eq!((refused.status, refused.executed, refused.code), ("refused", Executed::No, Some("NotFound")));
        assert!(call(&bridge, "ask", "pandacode_preview_file", json!({})).succeeded(), "the app's own tools stay");
        world.projects.lock().unwrap().insert(PROJECT.to_owned());
        *world.enabled.lock().unwrap() = false;
        assert!(bridge.list().iter().all(|tool| tool["name"] != "recall"), "a disabled package is not listed");
        assert_eq!(call(&bridge, "ask", "quiet", json!({})).executed, Executed::No);
    }

    #[test]
    fn approval_modes_apply_to_a_provider_call_like_to_the_models() {
        let world = world(echo());
        world.register_all();
        let trace: Trace = Arc::default();
        assert_eq!(call(&bridge(&world, &trace, "plan", true), "plan", "recall", json!({"query": "a"})).code, Some("PermissionDenied"));
        assert_eq!(call(&bridge(&world, &trace, "ask", false), "ask", "recall", json!({"query": "a"})).code, Some("PermissionDenied"));
        assert!(call(&bridge(&world, &trace, "full", false), "full", "recall", json!({"query": "a"})).succeeded());
        let nobody = CoreBridge::new(host(&world, &trace), bridge(&world, &trace, "ask", true).resolve, None, trace.clone());
        let outcome = call(&nobody, "ask", "recall", json!({"query": "a"}));
        assert_eq!((outcome.status, outcome.executed), ("unavailable", Executed::No), "no approver, nothing runs");
        assert!(!trace.lock().unwrap().iter().any(|event| event["tool"] == "recall" && event["event"] == "tool.after" && event["ok"] == false));
    }

    #[test]
    fn truncation_and_reconnect_never_claim_an_unexecuted_tool_succeeded() {
        // Past the bound: the tool ran, the model did not get the result.
        let big = world(|_| Some(json!({"content": "x".repeat(MAX_RESULT_BYTES)})));
        big.register_all();
        let outcome = tauri::async_runtime::block_on(big.model.call(PROJECT, "big_dump", json!({}), json!({}))).map(|served| served_outcome(&served)).unwrap_or_else(|error| classify_error(&error));
        assert_eq!((outcome.status, outcome.executed, outcome.delivered, outcome.succeeded()), ("truncated", Executed::Yes, false, false));
        // The service stops mid-call: unknown, never completed, and the host does not run it again.
        let calls = Arc::new(AtomicUsize::new(0));
        let seen = calls.clone();
        let dropped = world(move |_| { seen.fetch_add(1, Ordering::SeqCst); None });
        dropped.register_all();
        let outcome = tauri::async_runtime::block_on(dropped.model.call(PROJECT, "quiet", json!({}), json!({}))).map(|served| served_outcome(&served)).unwrap_or_else(|error| classify_error(&error));
        assert_eq!((outcome.status, outcome.executed, outcome.succeeded()), ("interrupted", Executed::Unknown, false));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        // The service is gone before the call: not executed.
        dropped.model.remove_owner(OWNER);
        let outcome = tauri::async_runtime::block_on(dropped.model.call(PROJECT, "quiet", json!({}), json!({}))).map(|served| served_outcome(&served)).unwrap_or_else(|error| classify_error(&error));
        assert_eq!((outcome.status, outcome.executed), ("unavailable", Executed::No));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        for case in scenarios()["serverRows"].as_array().unwrap() {
            let outcome = server_outcome(&case["row"]);
            assert_eq!((outcome.status, outcome.executed.as_str(), outcome.succeeded()), (case["status"].as_str().unwrap(), case["executed"].as_str().unwrap(), case["succeeded"] == true), "{}", case["id"]);
            assert!(!outcome.json().to_string().contains("secret-output"), "{}: the recorder form carries no result", case["id"]);
        }
    }

    #[test]
    fn a_resumed_session_loses_the_names_of_a_disabled_package() {
        let world = world(echo());
        world.register_all();
        world.servers.attach_run("run-1", PROJECT, "");
        let all = |_: &str, _: &str, _: &str| true;
        let attached = attach(&world.ports(&all), "run-1", PROJECT, "claude");
        let before = offered_names(&world.model, &world.servers, &attached, "run-1", PROJECT);
        assert!(before.contains("recall") && before.contains("mcp__pkg_sample_parity__local__docs_search") && before.contains("mcp__pkg_sample_parity__secured__*"));
        assert_eq!(bridge_view(&before)["zeroExtension"], false);
        let previous: Vec<String> = ["pandacode_preview_file", "recall", "mcp__pkg_sample_parity__local__docs_search", "mcp__other__tool"].iter().map(|name| (*name).to_owned()).collect();
        let known: BTreeSet<String> = ["recall".to_owned(), "quiet".to_owned()].into();
        assert!(prune_resumed(&previous, &known, &before).removed.is_empty());

        *world.enabled.lock().unwrap() = false;
        world.servers.reconcile();
        let after = offered_names(&world.model, &world.servers, &attach(&world.ports(&all), "run-1", PROJECT, "claude"), "run-1", PROJECT);
        assert!(after.is_empty());
        assert_eq!(bridge_view(&after), json!({"zeroExtension": true, "modelTools": [], "toolServers": []}));
        let pruned = prune_resumed(&previous, &known, &after);
        assert_eq!(pruned.removed, ["recall", "mcp__pkg_sample_parity__local__docs_search"]);
        assert_eq!(pruned.kept, ["pandacode_preview_file", "mcp__other__tool"]);
    }
}
