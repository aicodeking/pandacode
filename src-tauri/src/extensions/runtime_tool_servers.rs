//! Tool servers declared by a package and attached to a run (runtime phase R7, slice R0702).
//!
//! * **Declaration.** `contributes.toolServers[]` (`id`, `title`, `transport`, `command` | `url`, `authentication`,
//!   `credential`) is checked twice with the same rules: the schema bounds the shape, [`check`] (called by
//!   `contracts.rs`, mirrored by `src/extensions/runtime-tool-servers.ts` for `contracts.ts`) applies the rest, in the
//!   order of `checkToolServerDeclarations`. Every id starts with the manifest id plus `/` (`InvalidId`, `ReservedId`
//!   for `panda.`), at most four per package (`LimitExceeded`), the `tools.model` permission is declared
//!   (`PermissionDenied`). A `stdio` server has a `command` (`{node}`, the pinned runtime, and `{package}`, the code
//!   folder, are the only placeholders) and never an `authentication` or a `credential`: a held value is never put in
//!   a package process's environment or arguments (ADR-0006). An `http` server has an `http(s)` `url` without user
//!   information; its declared credential (R0703) is parsed here but attached by nobody in this slice: the server is
//!   `credentialPending` and is not handed to a harness until R0703 attaches the header host-side.
//! * **Inventory.** [`ToolServers::listed`] is the list of servers a run of one project may be offered: enabled,
//!   trusted packages outside safe mode whose `tools.model` grant reaches the run's project, checked natively on every
//!   listing, so a revoked or narrowed grant, a disable and safe mode remove the servers from the next run.
//! * **Lifecycle.** [`ToolServers::attach_run`] gives each run its own slot per listed server. A `stdio` server is
//!   probed with a bounded MCP handshake (`initialize`, `tools/list`) by a short-lived host-run process: 10 s, at
//!   most 256 KiB of answer, at most 64 tool names, and the process always ends before the probe returns. A failed
//!   probe leaves the slot `failed` with a short code and a bounded line; the server is not handed to the harness. An
//!   `http` server is never contacted by the platform: it is attached as declared. `stop`, `start` and `restart`
//!   move one slot; at most [`MAX_ATTEMPTS`] starts per slot (`LimitExceeded`). [`ToolServers::reconcile`] removes
//!   exactly the slots whose package is no longer listed for that run's project: the other slots stay.
//! * **Attachment.** [`ToolServers::mcp_entries`] is what the harness is given for one run: a `name` that carries the
//!   package (`pkg_<owner>__<server>`, so a tool row names it) and a Claude/Codex/ACP-shaped entry. The harness calls
//!   the server itself, so every call passes the harness's own approval and the hooks see it as the harness reports it
//!   (R0505); [`attribution`] turns a server name back into the package and server titles for the tool row.
//!
//! The per-run provider seam that reads [`ToolServers::mcp_entries`], and ZCode's per-session bridge (pending person
//! decision A5), are not part of this slice. Everything here is for predictability and fault isolation (ADR-0005).
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    io::{BufRead, BufReader, Read, Write},
    path::PathBuf,
    sync::{atomic::{AtomicUsize, Ordering}, Arc, LazyLock, Mutex},
    time::Duration,
};

use crate::extensions::runtime_hook_registration::{self as hooks, Gate};

/// The permission a package must hold to declare tool servers (per project), shared with model tools.
pub const PERMISSION: &str = "tools.model";
pub const MAX_SERVERS: usize = 4;
pub const MAX_TITLE: usize = 80;
pub const MAX_COMMAND_PARTS: usize = 16;
pub const MAX_COMMAND_PART: usize = 1_024;
pub const MAX_URL: usize = 2_048;
pub const MAX_TOOL_NAMES: usize = 64;
pub const MAX_ATTEMPTS: u32 = 5;
pub const MAX_ATTACHMENTS: usize = 32;
pub const MAX_ERROR: usize = 200;
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(10);
pub const PROBE_BYTES: u64 = 256 * 1024;
pub const TRANSPORTS: [&str; 2] = ["stdio", "http"];
pub const AUTHENTICATIONS: [&str; 3] = ["none", "bearer", "header"];
pub const CREDENTIAL_SOURCES: [&str; 3] = ["secret", "entered", "held"];
const PLACEHOLDERS: [&str; 2] = ["{node}", "{package}"];
const AT: &str = "contributes/toolServers";

// ---------------------------------------------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------------------------------------------

/// One `contributes.toolServers[]` entry, with its defaults applied.
#[derive(Clone, Debug, PartialEq)]
pub struct Declaration {
    pub id: String,
    pub title: String,
    pub transport: String,
    pub command: Vec<String>,
    pub url: String,
    pub authentication: String,
    pub credential: Option<Value>,
}
impl Declaration {
    pub fn json(&self) -> Value {
        json!({"id": self.id, "title": self.title, "transport": self.transport, "command": self.command, "url": self.url, "authentication": self.authentication, "credential": self.credential})
    }
    /// A declared credential is attached host-side by R0703; until then the server is not handed to a harness.
    pub fn credential_pending(&self) -> bool { self.authentication != "none" }
}

/// A refused declaration: the error code, the manifest-relative place and the ids it names.
#[derive(Debug, PartialEq, Eq)]
pub struct Refusal { pub code: &'static str, pub at: &'static str, pub ids: Vec<String> }
fn refuse(code: &'static str, at: &'static str, id: &str) -> Refusal { Refusal { code, at, ids: vec![id.to_owned()] } }

/// Every `{…}` in a command part is one of the two placeholders.
fn placeholders_known(part: &str) -> bool {
    let mut rest = part;
    while let Some(open) = rest.find('{') {
        let tail = &rest[open..];
        let Some(close) = tail.find('}') else { return false };
        if !PLACEHOLDERS.contains(&&tail[..=close]) { return false; }
        rest = &tail[close + 1..];
    }
    !rest.contains('}')
}

/// `http(s)://host[:port]/…` with no user information and no whitespace.
pub fn valid_url(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://").or_else(|| url.strip_prefix("http://")) else { return false };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    url.len() <= MAX_URL && !authority.is_empty() && !authority.contains('@') && !url.chars().any(|c| c.is_whitespace() || c.is_control())
}

/// The rules of `contributes.toolServers` after the schema checked the shape. The order of the checks is the order of
/// `checkToolServerDeclarations` in `runtime-tool-servers.ts`, so both validators answer the same first refusal.
pub fn check(manifest: &Value) -> Result<Vec<Declaration>, Refusal> {
    let Some(servers) = manifest["contributes"]["toolServers"].as_array().filter(|servers| !servers.is_empty()) else { return Ok(vec![]) };
    let package = manifest["id"].as_str().unwrap_or_default();
    if servers.len() > MAX_SERVERS { return Err(refuse("LimitExceeded", AT, package)); }
    let permissions: BTreeSet<&str> = manifest["permissions"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
    let (mut ids, mut out) = (BTreeSet::new(), Vec::new());
    for server in servers {
        let id = server["id"].as_str().unwrap_or_default();
        if id.starts_with("panda.") { return Err(refuse("ReservedId", AT, id)); }
        if !id.starts_with(&format!("{package}/")) { return Err(refuse("InvalidId", AT, id)); }
        if !ids.insert(id) { return Err(refuse("DuplicateId", AT, id)); }
        let Some(title) = server["title"].as_str().filter(|text| !text.trim().is_empty() && text.chars().count() <= MAX_TITLE) else { return Err(refuse("InvalidShape", AT, id)) };
        let Some(transport) = server["transport"].as_str().filter(|transport| TRANSPORTS.contains(transport)) else { return Err(refuse("InvalidShape", AT, id)) };
        let authentication = match server.get("authentication") {
            None => "none",
            Some(value) => match value.as_str().filter(|kind| AUTHENTICATIONS.contains(kind)) { Some(kind) => kind, None => return Err(refuse("InvalidShape", AT, id)) },
        };
        let credential = server.get("credential").filter(|value| !value.is_null());
        let (mut command, mut url) = (Vec::new(), String::new());
        match transport {
            "stdio" => {
                // A package process never receives a held value (ADR-0006): no credential field at all.
                if authentication != "none" || credential.is_some() || server.get("url").is_some() { return Err(refuse("InvalidShape", AT, id)); }
                let Some(parts) = server["command"].as_array().filter(|parts| !parts.is_empty() && parts.len() <= MAX_COMMAND_PARTS) else { return Err(refuse("InvalidShape", AT, id)) };
                for part in parts {
                    let Some(part) = part.as_str().filter(|part| !part.is_empty() && part.len() <= MAX_COMMAND_PART && placeholders_known(part)) else { return Err(refuse("InvalidShape", AT, id)) };
                    command.push(part.to_owned());
                }
            }
            _ => {
                if server.get("command").is_some() { return Err(refuse("InvalidShape", AT, id)); }
                let Some(address) = server["url"].as_str().filter(|address| valid_url(address)) else { return Err(refuse("InvalidShape", AT, id)) };
                url = address.to_owned();
                match (authentication, credential) {
                    ("none", None) => {}
                    ("none", Some(_)) | (_, None) => return Err(refuse("InvalidShape", AT, id)),
                    (_, Some(credential)) => {
                        let source = credential["source"].as_str().filter(|source| CREDENTIAL_SOURCES.contains(source));
                        let named = match source { Some("held") => credential["id"].as_str(), _ => credential["key"].as_str() }.is_some_and(|name| !name.is_empty() && name.len() <= 200);
                        if source.is_none() || !named { return Err(refuse("InvalidShape", AT, id)); }
                    }
                }
            }
        }
        out.push(Declaration { id: id.to_owned(), title: title.to_owned(), transport: transport.to_owned(), command, url, authentication: authentication.to_owned(), credential: credential.cloned() });
    }
    if !permissions.contains(PERMISSION) { return Err(refuse("PermissionDenied", "permissions", package)); }
    Ok(out)
}

/// The command with `{node}` and `{package}` replaced. `None` when a placeholder has nothing to resolve to.
pub fn resolve_command(command: &[String], node: Option<&str>, package: Option<&str>) -> Option<Vec<String>> {
    command.iter().map(|part| {
        let mut text = part.clone();
        if text.contains("{node}") { text = text.replace("{node}", node?); }
        if text.contains("{package}") { text = text.replace("{package}", package?); }
        Some(text)
    }).collect()
}

// ---------------------------------------------------------------------------------------------------------------
// The inventory
// ---------------------------------------------------------------------------------------------------------------

/// Where the code folder and the pinned runtime are found, only asked when a `stdio` server is probed.
pub type Resolver = Arc<dyn Fn() -> Option<String> + Send + Sync>;
/// An enabled, trusted package with declarations, in the order the host keeps them.
#[derive(Clone)]
pub struct Entry { pub owner: String, pub version: String, pub package_name: String, pub declarations: Vec<Declaration>, pub package_dir: Option<Resolver> }
/// Where the registry reads the enabled packages from: the app's manager, a fixture in tests.
pub type Source = Arc<dyn Fn() -> Vec<Entry> + Send + Sync>;
/// The bounded handshake of a launched `stdio` server: the names of its tools, or the error code.
pub type Probe = Arc<dyn Fn(&[String], &str) -> Result<Vec<String>, &'static str> + Send + Sync>;

/// A server a run of one project may be offered.
#[derive(Clone)]
pub struct Listed { pub owner: String, pub version: String, pub package_name: String, pub declaration: Declaration, package_dir: Option<Resolver> }
impl Listed {
    pub fn json(&self) -> Value {
        json!({"id": self.declaration.id, "title": self.declaration.title, "transport": self.declaration.transport, "owner": self.owner, "package": self.package_name, "credentialPending": self.declaration.credential_pending()})
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Run attachments
// ---------------------------------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State { Attached, Failed, Stopped, CredentialPending }
impl State {
    pub fn as_str(self) -> &'static str {
        match self { State::Attached => "attached", State::Failed => "failed", State::Stopped => "stopped", State::CredentialPending => "credentialPending" }
    }
}

type Key = (String, String, String);
#[derive(Clone, Debug)]
struct Slot { project: String, version: String, package_name: String, declaration: Declaration, cwd: String, state: State, tools: Vec<String>, error: Option<String>, attempts: u32, argv: Vec<String> }
impl Slot {
    fn json(&self, run: &str) -> Value {
        json!({"run": run, "owner": self.declaration.id.split('/').next().unwrap_or_default(), "id": self.declaration.id, "title": self.declaration.title, "package": self.package_name,
            "transport": self.declaration.transport, "state": self.state.as_str(), "tools": self.tools, "error": self.error, "attempts": self.attempts, "name": server_name(&self.declaration.id)})
    }
}
fn bounded(text: &str) -> String { text.chars().take(MAX_ERROR).collect() }

/// The name a harness knows a server by: it carries the package, so a tool row (`mcp__<name>__<tool>`) names it.
/// `pkg_<owner>__<server>`, lowercase `[a-z0-9_]`, at most 48 characters.
pub fn server_name(id: &str) -> String {
    let (owner, tail) = id.split_once('/').unwrap_or((id, ""));
    let clean = |text: &str| text.chars().map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '_' }).collect::<String>();
    let name = format!("pkg_{}__{}", clean(owner), clean(tail));
    name.chars().take(48).collect()
}

/// A failure the registry reports: the code and the line the user sees.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StateError { pub code: &'static str }

/// Every run's slots and the wiring to the app. The app has one ([`registry`]); tests build their own.
#[derive(Default)]
pub struct ToolServers {
    slots: Mutex<BTreeMap<Key, Slot>>,
    gate: Mutex<Option<Gate>>,
    source: Mutex<Option<Source>>,
    probe: Mutex<Option<Probe>>,
    node: Mutex<Option<Resolver>>,
}
impl ToolServers {
    pub fn set_gate(&self, gate: Gate) { if let Ok(mut slot) = self.gate.lock() { *slot = Some(gate); } }
    pub fn set_source(&self, source: Source) { if let Ok(mut slot) = self.source.lock() { *slot = Some(source); } }
    pub fn set_probe(&self, probe: Probe) { if let Ok(mut slot) = self.probe.lock() { *slot = Some(probe); } }
    pub fn set_node(&self, node: Resolver) { if let Ok(mut slot) = self.node.lock() { *slot = Some(node); } }
    fn gate(&self) -> Option<Gate> { self.gate.lock().ok().and_then(|slot| slot.clone()) }
    fn entries(&self) -> Vec<Entry> { self.source.lock().ok().and_then(|slot| slot.clone()).map(|source| source()).unwrap_or_default() }
    fn probe(&self) -> Option<Probe> { self.probe.lock().ok().and_then(|slot| slot.clone()) }
    fn node(&self) -> Option<String> { self.node.lock().ok().and_then(|slot| slot.clone()).and_then(|node| node()) }
    fn slots(&self) -> std::sync::MutexGuard<'_, BTreeMap<Key, Slot>> { self.slots.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) }
    fn holds(&self, owner: &str, version: &str, project: &str) -> bool { self.gate().is_some_and(|gate| gate(owner, version, PERMISSION, Some(project))) }

    /// The servers a run of `project` may be offered, by the grant checked now.
    pub fn listed(&self, project: &str) -> Vec<Listed> {
        self.entries().into_iter().filter(|entry| self.holds(&entry.owner, &entry.version, project)).flat_map(|entry| {
            let Entry { owner, version, package_name, declarations, package_dir } = entry;
            declarations.into_iter().map(move |declaration| Listed { owner: owner.clone(), version: version.clone(), package_name: package_name.clone(), declaration, package_dir: package_dir.clone() })
        }).collect()
    }

    fn launch(&self, listed: &Listed, cwd: &str) -> (State, Vec<String>, Option<String>, Vec<String>) {
        let declaration = &listed.declaration;
        if declaration.credential_pending() { return (State::CredentialPending, vec![], Some("Waiting for its credential to be attached by the host.".into()), vec![]); }
        if declaration.transport == "http" { return (State::Attached, vec![], None, vec![]); }
        let package = listed.package_dir.as_ref().and_then(|dir| dir());
        let Some(argv) = resolve_command(&declaration.command, self.node().as_deref(), package.as_deref()) else { return (State::Failed, vec![], Some("The runtime or the package folder is not available.".into()), vec![]) };
        let Some(probe) = self.probe() else { return (State::Failed, vec![], Some("The host cannot start servers here.".into()), argv) };
        match probe(&argv, cwd) {
            Ok(tools) => (State::Attached, tools.into_iter().take(MAX_TOOL_NAMES).collect(), None, argv),
            Err(code) => (State::Failed, vec![], Some(bounded(&format!("{} could not connect ({code}).", declaration.title))), argv),
        }
    }

    /// Gives `run` (of `project`, working in `cwd`) a slot per listed server, replacing what the run held before. Answers
    /// the states. At most [`MAX_ATTACHMENTS`] servers are attached to one run.
    pub fn attach_run(&self, run: &str, project: &str, cwd: &str) -> Vec<Value> {
        self.detach_run(run);
        let mut out = Vec::new();
        for listed in self.listed(project).into_iter().take(MAX_ATTACHMENTS) {
            let (state, tools, error, argv) = self.launch(&listed, cwd);
            let slot = Slot { project: project.to_owned(), version: listed.version.clone(), package_name: listed.package_name.clone(), declaration: listed.declaration.clone(), cwd: cwd.to_owned(), state, tools, error, attempts: 1, argv };
            out.push(slot.json(run));
            self.slots().insert((run.to_owned(), listed.owner.clone(), listed.declaration.id.clone()), slot);
        }
        out
    }
    /// The run ended: its slots go, nobody else's.
    pub fn detach_run(&self, run: &str) { self.slots().retain(|(held, _, _), _| held != run); }

    fn find(&self, run: &str, id: &str) -> Option<(Key, Slot)> { self.slots().iter().find(|((held, _, server), _)| held == run && server == id).map(|(key, slot)| (key.clone(), slot.clone())) }
    /// Stops one server of one run. It stays listed as `stopped` and is not handed to the harness.
    pub fn stop(&self, run: &str, id: &str) -> Result<Value, &'static str> {
        let (key, _) = self.find(run, id).ok_or("NotFound")?;
        let mut slots = self.slots();
        let slot = slots.get_mut(&key).ok_or("NotFound")?;
        slot.state = State::Stopped; slot.tools.clear(); slot.error = None;
        Ok(slot.json(run))
    }
    /// Starts a stopped or failed server again (`restart` also works on an attached one). A package that lost its grant
    /// answers `PermissionDenied`; more than [`MAX_ATTEMPTS`] starts of one slot answer `LimitExceeded`.
    pub fn start(&self, run: &str, id: &str) -> Result<Value, &'static str> {
        let (key, slot) = self.find(run, id).ok_or("NotFound")?;
        if slot.attempts >= MAX_ATTEMPTS { return Err("LimitExceeded"); }
        let listed = self.listed(&slot.project).into_iter().find(|listed| listed.declaration.id == id).ok_or("PermissionDenied")?;
        let (state, tools, error, argv) = self.launch(&listed, &slot.cwd);
        let mut slots = self.slots();
        let held = slots.get_mut(&key).ok_or("NotFound")?;
        (held.state, held.tools, held.error, held.argv, held.attempts) = (state, tools, error, argv, slot.attempts + 1);
        Ok(held.json(run))
    }
    pub fn restart(&self, run: &str, id: &str) -> Result<Value, &'static str> { self.start(run, id) }

    /// A grant, an enablement or the safe mode changed: the slots whose package is no longer listed for the run's
    /// project are removed, and nothing else moves. Answers the removed `(run, server id)` pairs.
    pub fn reconcile(&self) -> Vec<(String, String)> {
        let mut projects: BTreeMap<String, BTreeSet<(String, String)>> = BTreeMap::new();
        let held: Vec<(Key, String)> = self.slots().iter().map(|(key, slot)| (key.clone(), slot.project.clone())).collect();
        for (_, project) in &held {
            projects.entry(project.clone()).or_insert_with(|| self.listed(project).into_iter().map(|listed| (listed.owner, listed.declaration.id)).collect());
        }
        let mut removed = Vec::new();
        self.slots().retain(|key, slot| {
            let keep = projects.get(&slot.project).is_some_and(|listed| listed.contains(&(key.1.clone(), key.2.clone())));
            if !keep { removed.push((key.0.clone(), key.2.clone())); }
            keep
        });
        removed
    }

    /// The states of every server of `run`.
    pub fn state(&self, run: &str) -> Vec<Value> { self.slots().iter().filter(|((held, _, _), _)| held == run).map(|(_, slot)| slot.json(run)).collect() }
    /// The names of the tools the run's attached servers announced, per server id (a stopped or failed server has none).
    pub fn tools(&self, run: &str) -> BTreeMap<String, Vec<String>> {
        self.slots().iter().filter(|((held, _, _), slot)| held == run && slot.state == State::Attached).map(|((_, _, id), slot)| (id.clone(), slot.tools.clone())).collect()
    }
    /// How many servers are attached across every run.
    pub fn attached_count(&self) -> usize { self.slots().values().filter(|slot| slot.state == State::Attached).count() }

    /// What a harness is given for `run`: `(name, entry)` of each attached server that is not waiting for a credential.
    /// The `stdio` entry has no value but the resolved command: an empty `env`, never a held value. `shape` is
    /// `claude` (an `mcpServers` map entry), `codex` (a `[mcp_servers]` entry) or `acp` (an `mcpServers` array entry).
    pub fn mcp_entries(&self, run: &str, shape: &str) -> Vec<(String, Value)> {
        self.slots().iter().filter(|((held, _, _), slot)| held == run && slot.state == State::Attached).map(|(_, slot)| {
            let name = server_name(&slot.declaration.id);
            let entry = match (slot.declaration.transport.as_str(), shape) {
                ("http", "claude") => json!({"type": "http", "url": slot.declaration.url}),
                ("http", "codex") => json!({"url": slot.declaration.url, "enabled": true}),
                ("http", _) => json!({"type": "http", "name": name, "url": slot.declaration.url, "headers": []}),
                (_, "claude") => json!({"type": "stdio", "command": slot.argv[0], "args": &slot.argv[1..], "env": {}}),
                (_, "codex") => json!({"command": slot.argv[0], "args": &slot.argv[1..], "enabled": true}),
                (_, _) => json!({"name": name, "command": slot.argv[0], "args": &slot.argv[1..], "env": []}),
            };
            (name, entry)
        }).collect()
    }
    /// `(package, server title)` of a server name, for the tool row of a call it served.
    pub fn attribution(&self, run: &str, name: &str) -> Option<(String, String)> {
        self.slots().iter().find(|((held, _, id), _)| held == run && server_name(id) == name).map(|(_, slot)| (slot.package_name.clone(), slot.declaration.title.clone()))
    }
}

/// The package and server a tool of `mcp__<server>__<tool>` (or a bare server name) came from, in `run`.
pub fn attribution(registry: &ToolServers, run: &str, tool: &str) -> Option<(String, String)> {
    let name = tool.strip_prefix("mcp__").map(|rest| rest.split("__").take_while(|part| !part.is_empty()).collect::<Vec<_>>());
    match name {
        Some(parts) if parts.len() >= 2 => {
            // `pkg_<owner>__<server>` holds one `__`; a tool name follows.
            let candidate = format!("{}__{}", parts[0], parts[1]);
            registry.attribution(run, &candidate).or_else(|| registry.attribution(run, parts[0]))
        }
        _ => registry.attribution(run, tool),
    }
}

// ---------------------------------------------------------------------------------------------------------------
// The real probe
// ---------------------------------------------------------------------------------------------------------------

static LIVE_PROBES: AtomicUsize = AtomicUsize::new(0);
/// Probe processes alive right now (zero when no probe is running).
pub fn live_probes() -> usize { LIVE_PROBES.load(Ordering::Acquire) }
struct Live { child: std::process::Child }
impl Live { fn new(child: std::process::Child) -> Self { LIVE_PROBES.fetch_add(1, Ordering::AcqRel); Self { child } } }
impl Drop for Live {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        LIVE_PROBES.fetch_sub(1, Ordering::AcqRel);
    }
}

fn tool_names(answer: &Value) -> Vec<String> {
    answer["result"]["tools"].as_array().into_iter().flatten().filter_map(|tool| tool["name"].as_str()).filter(|name| !name.is_empty() && name.len() <= 200).take(MAX_TOOL_NAMES).map(str::to_owned).collect()
}

/// Launches `argv` in `cwd` with a null stderr and piped stdio, speaks `initialize` and `tools/list` (newline-delimited
/// JSON-RPC, the stdio transport of MCP) inside [`PROBE_TIMEOUT`], and ends the process before it returns.
pub fn probe_stdio(argv: &[String], cwd: &str) -> Result<Vec<String>, &'static str> {
    let (program, args) = argv.split_first().ok_or("InvalidShape")?;
    let mut command = std::process::Command::new(program);
    command.args(args).stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null());
    if !cwd.is_empty() && std::path::Path::new(cwd).is_dir() { command.current_dir(cwd); }
    // The host's own PANDACODE_* variables and NODE_OPTIONS never reach a package process (the service rule).
    for (name, _) in std::env::vars_os() {
        let upper = name.to_string_lossy().to_ascii_uppercase();
        if upper == "NODE_OPTIONS" || upper.starts_with("PANDACODE_") { command.env_remove(&name); }
    }
    crate::child_env::sanitize(&mut command);
    #[cfg(windows)]
    { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
    let mut live = Live::new(command.spawn().map_err(|_| "HostUnavailable")?);
    let (mut stdin, stdout) = (live.child.stdin.take().ok_or("HostUnavailable")?, live.child.stdout.take().ok_or("HostUnavailable")?);
    let (sender, lines) = std::sync::mpsc::channel::<Value>();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout.take(PROBE_BYTES));
        let mut line = String::new();
        while reader.read_line(&mut line).is_ok_and(|count| count > 0) {
            if let Ok(value) = serde_json::from_str::<Value>(line.trim()) { if sender.send(value).is_err() { break; } }
            line.clear();
        }
    });
    let deadline = std::time::Instant::now() + PROBE_TIMEOUT;
    let ask = |stdin: &mut std::process::ChildStdin, id: u64, method: &str, params: Value| -> Result<Value, &'static str> {
        let frame = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        writeln!(stdin, "{frame}").and_then(|()| stdin.flush()).map_err(|_| "HostUnavailable")?;
        loop {
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            let answer = lines.recv_timeout(left).map_err(|error| if matches!(error, std::sync::mpsc::RecvTimeoutError::Timeout) { "Timeout" } else { "HostUnavailable" })?;
            if answer["id"] == json!(id) { return if answer.get("error").is_some() { Err("HostUnavailable") } else { Ok(answer) }; }
        }
    };
    ask(&mut stdin, 1, "initialize", json!({"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "pandacode", "version": "1"}}))?;
    writeln!(stdin, "{}", json!({"jsonrpc": "2.0", "method": "notifications/initialized"})).and_then(|()| stdin.flush()).map_err(|_| "HostUnavailable")?;
    let listing = ask(&mut stdin, 2, "tools/list", json!({}))?;
    Ok(tool_names(&listing))
}

// ---------------------------------------------------------------------------------------------------------------
// The app
// ---------------------------------------------------------------------------------------------------------------

static REGISTRY: LazyLock<ToolServers> = LazyLock::new(ToolServers::default);
static INSTALLED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// The app's registry.
pub fn registry() -> &'static ToolServers { &REGISTRY }

/// The enabled, trusted packages outside safe mode with tool servers, in the manager's order.
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
            let (lookup, id) = (app.clone(), owner.clone());
            let package_dir: Resolver = Arc::new(move || {
                let packages = lookup.try_state::<crate::extensions::packages::ExtensionPackages>()?;
                let packages = packages.0.lock().ok()?;
                let (checksum, files) = packages.code_files(&id).ok()?;
                crate::extensions::packages::runtime_code_folders::materialize(&packages.app_data(), &id, &checksum, &files).ok().map(|path| path.to_string_lossy().into_owned())
            });
            Some(Entry { version: manifest["version"].as_str()?.to_owned(), package_name, owner, declarations, package_dir: Some(package_dir) })
        }).collect()
}

/// Wires the app's registry once: the grants file answers every check, the manager lists the packages and the pinned
/// runtime comes from the same fixed directories a service uses.
fn install(app: &tauri::AppHandle) {
    if INSTALLED.swap(true, Ordering::AcqRel) { return; }
    use tauri::Manager;
    let gated = app.clone();
    REGISTRY.set_gate(Arc::new(move |owner, version, permission, project| gated.try_state::<crate::extensions::runtime_grants::RuntimeGrants>().is_some_and(|grants| hooks::holds(&grants, owner, version, permission, project))));
    let listing = app.clone();
    REGISTRY.set_source(Arc::new(move || app_entries(&listing)));
    let runtime = app.clone();
    REGISTRY.set_node(Arc::new(move || crate::extensions::runtime_service_lifetime::runtime_directories(&runtime).iter().find_map(|directory| crate::extensions::supervisor::Runtime::packaged(directory).ok()).map(|runtime| runtime.binary.to_string_lossy().into_owned())));
    REGISTRY.set_probe(Arc::new(probe_stdio));
}

fn system_line(app: &tauri::AppHandle, task: &str, text: &str) {
    use tauri::{Emitter, Manager};
    let Some(state) = app.try_state::<crate::AppState>() else { return };
    let saved = state.store.lock().ok().map(|store| store.insert_message(task, "system", text));
    if saved.is_some() { let _ = app.emit("sessions-changed", ()); }
}

/// Attaches the run's declared servers (`build_task_host`, beside the model tools). The host is returned unchanged: a
/// tool server is called by the harness itself, so its calls pass the harness's approval and the hooks. A server that
/// failed to connect puts one line, naming the package, in the transcript; none blocks the turn. The probe runs on the
/// calling thread's blocking budget, at most [`PROBE_TIMEOUT`] per server.
pub fn with_tool_servers(base: crate::providers::ToolHost, app: tauri::AppHandle, session_id: String) -> crate::providers::ToolHost {
    install(&app);
    // A revoked or disabled package's slots in other runs go now; the other runs' servers stay.
    REGISTRY.reconcile();
    let Some(facts) = hooks::facts_of(&app, &session_id, None, None, false) else { return base };
    if REGISTRY.listed(&facts.project_id).is_empty() { REGISTRY.detach_run(&session_id); return base; }
    for state in REGISTRY.attach_run(&session_id, &facts.project_id, &facts.cwd) {
        if state["state"] == "failed" { system_line(&app, &session_id, &format!("{}: {}", state["package"].as_str().unwrap_or_default(), state["error"].as_str().unwrap_or("The server could not connect."))); }
    }
    base
}

/// The grants, the enablement or the safe mode changed: servers of packages no longer listed are removed from every run.
pub fn reconcile() -> usize { REGISTRY.reconcile().len() }
/// A run ended.
pub fn run_ended(run: &str) { REGISTRY.detach_run(run); }

#[cfg(test)]
mod tests {
    use super::*;

    const CASES: &str = include_str!("../../../tests/fixtures/extensions/runtime-tool-servers/cases.json");
    const MANIFEST: &str = include_str!("../../../tests/fixtures/extensions/runtime-tool-servers/extension.json");
    const OWNER: &str = "sample.docs";

    fn cases() -> Value { serde_json::from_str(CASES).unwrap() }
    fn manifest() -> Value { serde_json::from_str(MANIFEST).unwrap() }
    fn server(id: &str) -> Value { manifest()["contributes"]["toolServers"].as_array().unwrap().iter().find(|server| server["id"] == id).unwrap().clone() }

    /// The manifest of a refusal case: the base server with the case's changes, and the manifest-level switches.
    fn refusal_manifest(case: &Value) -> Value {
        let mut base = server(case["base"].as_str().unwrap_or("sample.docs/local"));
        for (key, value) in case["set"].as_object().into_iter().flatten() { base[key] = value.clone(); }
        for key in case["drop"].as_array().into_iter().flatten().filter_map(Value::as_str) { base.as_object_mut().unwrap().remove(key); }
        let mut servers = vec![base.clone()];
        for extra in case["extra"].as_array().into_iter().flatten() {
            let mut more = base.clone();
            for (key, value) in extra["set"].as_object().into_iter().flatten() { more[key] = value.clone(); }
            servers.push(more);
        }
        if let Some(count) = case["count"].as_u64() {
            servers = (0..count).map(|index| { let mut more = server("sample.docs/local"); more["id"] = json!(format!("{OWNER}/s{index}")); more }).collect();
        }
        let mut manifest = manifest();
        manifest["contributes"]["toolServers"] = Value::Array(servers);
        if let Some(permissions) = case.get("permissions") { manifest["permissions"] = permissions.clone(); }
        manifest
    }

    #[test]
    fn the_fixture_manifest_declares_valid_servers() {
        let declarations = check(&manifest()).unwrap();
        assert_eq!(declarations.iter().map(|declaration| declaration.id.as_str()).collect::<Vec<_>>(), ["sample.docs/local", "sample.docs/hosted", "sample.docs/silent", "sample.docs/secured"]);
        assert_eq!((declarations[0].transport.as_str(), declarations[1].transport.as_str()), ("stdio", "http"));
        assert!(declarations[3].credential_pending() && !declarations[1].credential_pending());
    }

    #[test]
    fn refusals_answer_the_same_code_as_the_twin() {
        for case in cases()["refusals"].as_array().unwrap() {
            let label = case["id"].as_str().unwrap();
            let refusal = check(&refusal_manifest(case)).expect_err(label);
            assert_eq!((refusal.code, refusal.at), (case["expect"]["code"].as_str().unwrap(), case["expect"]["at"].as_str().unwrap()), "{label}");
        }
    }

    /// A registry over the fixture package. `granted` lists the projects whose run holds `tools.model`; the probe
    /// answers `["docs_search"]` for the server whose command mentions `local` and fails for `silent`.
    fn fixture(granted: Arc<Mutex<BTreeSet<String>>>, spawned: Arc<AtomicUsize>) -> ToolServers {
        let registry = ToolServers::default();
        let declarations = check(&manifest()).unwrap();
        let resolver: Resolver = Arc::new(|| Some("C:/code/sample.docs".to_owned()));
        registry.set_source(Arc::new(move || vec![Entry { owner: OWNER.into(), version: "1.0.0".into(), package_name: "Docs".into(), declarations: declarations.clone(), package_dir: Some(resolver.clone()) }]));
        registry.set_gate(Arc::new(move |owner, _, permission, project| owner == OWNER && permission == PERMISSION && project.is_some_and(|project| granted.lock().unwrap().contains(project))));
        registry.set_node(Arc::new(|| Some("C:/runtime/node.exe".to_owned())));
        registry.set_probe(Arc::new(move |argv: &[String], _| {
            spawned.fetch_add(1, Ordering::SeqCst);
            if argv.iter().any(|part| part.contains("silent")) { Err("Timeout") } else { Ok(vec!["docs_search".to_owned(), "docs_read".to_owned()]) }
        }));
        registry
    }
    fn grants(projects: &[&str]) -> Arc<Mutex<BTreeSet<String>>> { Arc::new(Mutex::new(projects.iter().map(|project| (*project).to_owned()).collect())) }

    #[test]
    fn a_server_is_advertised_only_to_the_projects_that_hold_the_grant() {
        let registry = fixture(grants(&["p1"]), Arc::default());
        assert_eq!(registry.listed("p1").len(), 4);
        assert!(registry.listed("p2").is_empty());
        assert!(registry.attach_run("run-2", "p2", "C:/work/p2").is_empty());
        let states = registry.attach_run("run-1", "p1", "C:/work/p1");
        let by_id = |id: &str| states.iter().find(|state| state["id"] == id).unwrap().clone();
        assert_eq!(by_id("sample.docs/local")["state"], "attached");
        assert_eq!(by_id("sample.docs/local")["tools"], json!(["docs_search", "docs_read"]));
        assert_eq!(by_id("sample.docs/hosted")["state"], "attached");
        assert_eq!(by_id("sample.docs/silent")["state"], "failed");
        assert!(by_id("sample.docs/silent")["error"].as_str().unwrap().len() <= MAX_ERROR);
        assert_eq!(by_id("sample.docs/secured")["state"], "credentialPending");
    }

    #[test]
    fn start_stop_and_restart_are_bounded() {
        let spawned = Arc::new(AtomicUsize::new(0));
        let registry = fixture(grants(&["p1"]), spawned.clone());
        registry.attach_run("run-1", "p1", "");
        assert_eq!(registry.stop("run-1", "sample.docs/local").unwrap()["state"], "stopped");
        assert!(registry.tools("run-1").get("sample.docs/local").is_none());
        assert_eq!(registry.start("run-1", "sample.docs/local").unwrap()["state"], "attached");
        let mut last = Ok(json!(null));
        for _ in 0..MAX_ATTEMPTS { last = registry.restart("run-1", "sample.docs/local"); }
        assert_eq!(last.unwrap_err(), "LimitExceeded");
        assert_eq!(registry.stop("run-1", "sample.docs/ghost").unwrap_err(), "NotFound");
    }

    #[test]
    fn revoking_one_package_grant_removes_only_its_attachments() {
        let held = grants(&["p1", "p2"]);
        let registry = fixture(held.clone(), Arc::default());
        registry.attach_run("run-1", "p1", "");
        registry.attach_run("run-2", "p2", "");
        let before = registry.attached_count();
        held.lock().unwrap().remove("p1");
        let removed = registry.reconcile();
        assert!(removed.iter().all(|(run, _)| run == "run-1") && !removed.is_empty());
        assert!(registry.state("run-1").is_empty());
        assert_eq!(registry.tools("run-2").len(), 2, "the run of the other project keeps its servers");
        assert!(registry.attached_count() < before && registry.attached_count() > 0);
        registry.detach_run("run-2");
        assert_eq!(registry.attached_count(), 0);
    }

    #[test]
    fn entries_carry_the_package_and_never_a_held_value() {
        let registry = fixture(grants(&["p1"]), Arc::default());
        registry.attach_run("run-1", "p1", "");
        let entries = registry.mcp_entries("run-1", "claude");
        assert_eq!(entries.len(), 2, "the failed and the credential-pending servers are not handed over");
        let local = entries.iter().find(|(name, _)| name == "pkg_sample_docs__local").unwrap();
        assert_eq!(local.1["env"], json!({}));
        assert_eq!(local.1["command"], "C:/runtime/node.exe");
        assert!(local.1["args"][0].as_str().unwrap().starts_with("C:/code/sample.docs"));
        assert_eq!(attribution(&registry, "run-1", "mcp__pkg_sample_docs__local__docs_search"), Some(("Docs".to_owned(), "Docs".to_owned())));
        for shape in ["claude", "codex", "acp"] {
            assert!(!registry.mcp_entries("run-1", shape).iter().any(|(_, entry)| entry.to_string().contains("Authorization")), "{shape}");
        }
    }

    #[test]
    fn placeholders_and_urls_are_checked() {
        for case in cases()["placeholders"].as_array().unwrap() { assert_eq!(placeholders_known(case["part"].as_str().unwrap()), case["ok"] == true, "{}", case["part"]); }
        for case in cases()["urls"].as_array().unwrap() { assert_eq!(valid_url(case["url"].as_str().unwrap()), case["ok"] == true, "{}", case["url"]); }
        assert_eq!(resolve_command(&["{node}".into(), "{package}/a.mjs".into()], Some("n"), Some("p")), Some(vec!["n".into(), "p/a.mjs".into()]));
        assert_eq!(resolve_command(&["{node}".into()], None, Some("p")), None);
    }

    /// The fixture server (`server/index.mjs`) answered by the real probe: only with the pinned runtime present, so it
    /// is skipped elsewhere. It proves the handshake and that no probe process outlives the call.
    #[test]
    fn the_real_probe_ends_its_process() {
        let Some(node) = std::env::var_os("PANDACODE_TEST_NODE").map(|path| path.to_string_lossy().into_owned()).filter(|path| std::path::Path::new(path).is_file()) else { return };
        let script = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/extensions/runtime-tool-servers/server/index.mjs");
        let tools = probe_stdio(&[node, script.to_string_lossy().into_owned()], "").unwrap();
        assert_eq!(tools, ["docs_search", "docs_read"]);
        assert_eq!(live_probes(), 0);
    }
}
