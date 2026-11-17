//! Which runs the hooks see, and what each harness lets them see (runtime phase R5, slice R0509).
//!
//! * **Run coverage.** There is no single runner: a turn is started by the composer (`send_prompt`), a package
//!   (`tasks.start`, `tasks.message`), an agent's `pandacode_start_task` / `pandacode_send_message` tool, a team lead
//!   dispatching a worker or a Council reviewer, a bot's gateway, failover or shared channel, a schedule firing, a
//!   request from a paired device (on a desktop host or a headless `pandacode serve`), a cloud machine, or it runs on
//!   another computer and this desktop only mirrors it. Every local path ends in `launch_operation_admitted`, whose
//!   `run_began` asks [`hook_run`] what the run is: the store answers for team workers and their seats, bot
//!   workspaces, cloud machines and package starts; the launch scope a seam puts around the launch ([`within`] with a
//!   [`LaunchOrigin`]) answers for schedules, agent tools and paired devices. The mirrored path has its own seams
//!   ([`mirror_sent`], [`mirror_events`], [`mirror_ended`]) because nothing of it runs here: approvals and tool rows
//!   arrive from the host computer, and no companion can be used there.
//! * **Counters.** While any hook is attached, every launch (by run kind and trigger) and every reported occurrence
//!   (by run kind, event and source) is counted ([`Tally`]); the report carries the counts so a scenario per run
//!   kind can be compared with it.
//! * **Capabilities** (`panda.harnesses.list`, under `harnesses.inventory`). One row per harness: per mode, the
//!   source and coverage `tool.before` has today (`askedCalls`, `escalationsOnly`, or `none` where no request arrives
//!   and the call is seen only by `tool.after`), what other sources are feasible (a companion: `everyCall`; ask at
//!   the harness and answer at the host in `full`), and for every cell a qualification: `sourceFeasible` (from
//!   documentation or source reading), `recorded` (frames or fake fixtures in the repository prove it),
//!   `installedQualified` (a separately authorized capture on an installed harness; none exists yet) or
//!   `unsupported`. A cell is never a bare yes or no.
//!
//! Everything here is for predictability (ADR-0005): it withholds nothing, it reports what is true.
use serde_json::{json, Map, Value};
use std::{collections::BTreeMap, future::Future, sync::{Arc, LazyLock, Mutex}};

use super::runtime_hook_registration::{HookRegistry, Occurrence, RunFacts};

pub const SCHEMA_VERSION: u64 = 1;
/// The permission that reads the report (the existing harness inventory).
pub const PERMISSION: &str = "harnesses.inventory";
/// PandaCode's stored modes; `review` only for the Claude Code family.
pub const MODES: [&str; 5] = ["ask", "auto", "review", "plan", "full"];
pub const QUALIFICATIONS: [&str; 4] = ["sourceFeasible", "recorded", "installedQualified", "unsupported"];
pub const SOURCES: [&str; 5] = ["companion", "askAtHost", "permissionRequest", "hostTool", "activity"];
pub const COVERAGES: [&str; 5] = ["everyCall", "askedCalls", "escalationsOnly", "afterOnly", "none"];
/// `HookRun.trigger`: what started the turn, finer than the run kind.
pub const TRIGGERS: [&str; 10] = ["user", "package", "tool", "team", "council", "bot", "schedule", "remote", "cloud", "mirror"];

const CLAUDE: [&str; 4] = ["claude", "glm", "mimo", "alibaba"];
const ACP: [&str; 12] = ["kimi", "opencode", "antigravity", "grok", "deepseek", "commandcode", "cline", "kilo", "github-copilot", "devin", "hermes", "cursor"];
/// Harnesses whose permission-request and tool frames are recorded in the repository's protocol tests
/// (`providers/claude_stream_tests.rs` for the Claude Code stream GLM, MiMo and Alibaba share,
/// `providers/codex_stream_tests.rs`, `providers/kimi_stream_tests.rs`, `providers/pi.rs`).
pub const RECORDED: [&str; 7] = ["claude", "glm", "mimo", "alibaba", "codex", "kimi", "pi"];
/// `(harness, path)` pairs qualified by a separately authorized capture on an installed harness (R0501's gate, R0606,
/// R1212). None exists: a row is never `installedQualified` without an entry here.
pub const INSTALLED_QUALIFIED: [(&str, &str); 0] = [];

// ---------------------------------------------------------------------------------------------------------------
// Launch scope
// ---------------------------------------------------------------------------------------------------------------

/// What a launch seam knows that the store does not: the turn is a schedule's, an agent tool's, or a paired device's.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LaunchOrigin {
    Schedule { schedule: String },
    Tool { parent: String, tool: String },
    Remote { device: String },
}
impl LaunchOrigin {
    pub fn schedule(schedule: &str) -> Self { Self::Schedule { schedule: schedule.to_owned() } }
    pub fn tool(parent: &str, tool: &str) -> Self { Self::Tool { parent: parent.to_owned(), tool: tool.to_owned() } }
    pub fn remote(device: &str) -> Self { Self::Remote { device: device.to_owned() } }
    /// The fixture form (`{ schedule: { schedule } }`, `{ tool: { parent, tool } }`, `{ remote: { device } }`).
    pub fn from_json(value: &Value) -> Option<Self> {
        if let Some(schedule) = value["schedule"]["schedule"].as_str() { return Some(Self::schedule(schedule)); }
        if let (Some(parent), Some(tool)) = (value["tool"]["parent"].as_str(), value["tool"]["tool"].as_str()) { return Some(Self::tool(parent, tool)); }
        value["remote"]["device"].as_str().map(Self::remote)
    }
}

tokio::task_local! {
    static ORIGIN: LaunchOrigin;
}
/// Runs `launch` with `origin` as its launch scope: a turn that starts inside it (in the same task, as every
/// `launch_operation_admitted` caller awaits it) is classified with it. A launch spawned elsewhere is not inside.
pub async fn within<F: Future>(origin: LaunchOrigin, launch: F) -> F::Output { ORIGIN.scope(origin, launch).await }
/// The innermost launch scope of the current task.
pub fn current() -> Option<LaunchOrigin> { ORIGIN.try_with(LaunchOrigin::clone).ok() }

// ---------------------------------------------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------------------------------------------

/// What the store says about a run when its turn starts.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LaunchFacts {
    /// A team worker's run (`worker_launch`).
    pub worker: bool,
    pub parent: Option<String>,
    pub worker_id: Option<String>,
    /// The lens of a Council reviewer's seat.
    pub council_lens: Option<String>,
    /// The bot whose workspace project holds the task.
    pub bot: Option<String>,
    /// The task runs on a cloud machine (`cloud_agents`).
    pub cloud: bool,
    /// The package that started the task (`tasks.start`).
    pub package: Option<String>,
    /// `desktop` or `headless`.
    pub executor: String,
}
impl LaunchFacts {
    /// The fixture form (`scenarios.json`).
    pub fn from_json(value: &Value) -> Self {
        let text = |key: &str| value[key].as_str().map(str::to_owned);
        Self {
            worker: value["worker"] == true, parent: text("parent"), worker_id: text("workerId"), council_lens: text("councilLens"),
            bot: text("bot"), cloud: value["cloud"] == true, package: text("package"), executor: text("executor").unwrap_or_else(|| "desktop".into()),
        }
    }
}

/// The `HookRun` of a turn: `kind` (one of the five run kinds a `match.runs` filter names), `trigger`, `executor` and
/// the ids that say whose run it is. A team worker is `worker` whatever started its lead; a bot's thread is `bot`
/// whatever delivered the message (the trigger says what did); then a schedule, a paired device, a cloud machine; an
/// agent tool's or a package's start is a `task` with its trigger.
pub fn classify(facts: &LaunchFacts, origin: Option<&LaunchOrigin>) -> Value {
    let by_origin = |fallback: &'static str| match origin {
        Some(LaunchOrigin::Schedule { .. }) => "schedule",
        Some(LaunchOrigin::Remote { .. }) => "remote",
        Some(LaunchOrigin::Tool { .. }) => "tool",
        None if facts.package.is_some() => "package",
        None => fallback,
    };
    let (kind, trigger) = if facts.worker {
        ("worker", if facts.council_lens.is_some() { "council" } else { "team" })
    } else if facts.bot.is_some() {
        ("bot", by_origin("bot"))
    } else {
        match origin {
            Some(LaunchOrigin::Schedule { .. }) => ("schedule", "schedule"),
            Some(LaunchOrigin::Remote { .. }) => ("remote", "remote"),
            _ if facts.cloud => ("remote", by_origin("cloud")),
            Some(LaunchOrigin::Tool { .. }) => ("task", "tool"),
            None => ("task", by_origin("user")),
        }
    };
    let mut run = Map::new();
    run.insert("kind".into(), json!(kind));
    run.insert("trigger".into(), json!(trigger));
    run.insert("executor".into(), json!(if facts.cloud { "cloud" } else { facts.executor.as_str() }));
    if facts.worker {
        if let Some(parent) = &facts.parent { run.insert("parentTaskId".into(), json!(parent)); }
        if let Some(worker) = &facts.worker_id { run.insert("workerId".into(), json!(worker)); }
        if let Some(lens) = &facts.council_lens { run.insert("lens".into(), json!(lens)); }
    }
    if let Some(bot) = &facts.bot { if !facts.worker { run.insert("botId".into(), json!(bot)); } }
    match origin {
        Some(LaunchOrigin::Schedule { schedule }) if kind != "worker" => { run.insert("scheduleId".into(), json!(schedule)); }
        Some(LaunchOrigin::Remote { device }) if kind != "worker" => { run.insert("deviceId".into(), json!(device)); }
        Some(LaunchOrigin::Tool { parent, tool }) if kind != "worker" => {
            run.insert("parentTaskId".into(), json!(parent));
            run.insert("tool".into(), json!(tool));
        }
        _ => {}
    }
    if let Some(package) = &facts.package { if trigger == "package" { run.insert("package".into(), json!(package)); } }
    Value::Object(run)
}

/// The run of a task that runs on another computer, as this desktop mirrors it.
pub fn mirror_run(host: &str) -> Value { json!({"kind": "remote", "trigger": "mirror", "executor": "remote", "hostId": host}) }

fn executor() -> &'static str { super::runtime_service_lifetime::runtime_executor_placement::this_executor().as_str() }

/// What the store says about `session` (the caller holds the store lock; nothing here takes it).
pub fn launch_facts(app: &tauri::AppHandle, store: &crate::storage::Store, session: &str, project: &str, worker: bool) -> LaunchFacts {
    let mut facts = LaunchFacts { worker, executor: executor().to_owned(), ..LaunchFacts::default() };
    if worker {
        facts.parent = crate::architect::parent_of(store, session).ok().flatten();
        if let Some(Ok(Some(team))) = facts.parent.as_deref().map(|parent| crate::architect::load(store, parent)) {
            if let Some(member) = team.workers.iter().find(|member| member.session_id == session) {
                facts.worker_id = Some(member.id.clone());
                facts.council_lens = member.council.as_ref().map(|seat| seat.lens.clone());
            }
        }
    }
    facts.bot = store.db.query_row("SELECT id FROM bots WHERE project_id=?1 ORDER BY id LIMIT 1", [project], |row| row.get::<_, String>(0)).ok();
    facts.cloud = crate::cloud_agents::load(store, session).ok().flatten().is_some();
    facts.package = super::runtime_tasks_start::origins(app).and_then(|ledger| ledger.get(session)).map(|origin| origin.owner);
    facts
}

/// `facts_of` (the turn's facts): the `HookRun` of this turn. Counting is [`launched`]'s.
pub fn hook_run(app: &tauri::AppHandle, store: &crate::storage::Store, session: &str, project: &str, worker: bool) -> Value {
    classify(&launch_facts(app, store, session, project, worker), current().as_ref())
}
/// `run_began` (while a hook is attached): one launch of `run`.
pub fn launched(run: &Value) { tally().launch(run); }

// ---------------------------------------------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------------------------------------------

/// Launches by run kind and trigger, occurrences by run kind, event and source (`host` for events without one).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Tally {
    launches: BTreeMap<String, BTreeMap<String, u64>>,
    events: BTreeMap<String, BTreeMap<String, BTreeMap<String, u64>>>,
}
impl Tally {
    pub fn launch(&mut self, run: &Value) {
        let kind = run["kind"].as_str().unwrap_or("task").to_owned();
        let trigger = run["trigger"].as_str().unwrap_or("user").to_owned();
        *self.launches.entry(kind).or_default().entry(trigger).or_default() += 1;
    }
    pub fn event(&mut self, kind: &str, event: &str, payload: &Value) {
        let source = payload["source"].as_str().unwrap_or("host").to_owned();
        *self.events.entry(kind.to_owned()).or_default().entry(event.to_owned()).or_default().entry(source).or_default() += 1;
    }
    pub fn observe(&mut self, occurrence: &Occurrence) { self.event(&occurrence.run, occurrence.event, &occurrence.payload); }
    /// `{ <kind>: { launches, triggers: { <trigger>: n }, events: { <event>: { <source>: n } } } }` for every run kind.
    pub fn json(&self) -> Value {
        let mut out = Map::new();
        for kind in super::runtime_hook_registration::RUN_KINDS {
            let triggers = self.launches.get(kind).cloned().unwrap_or_default();
            let events = self.events.get(kind).cloned().unwrap_or_default();
            out.insert(kind.into(), json!({"launches": triggers.values().sum::<u64>(), "triggers": triggers, "events": events}));
        }
        Value::Object(out)
    }
}
static TALLY: LazyLock<Mutex<Tally>> = LazyLock::new(Mutex::default);
fn tally() -> std::sync::MutexGuard<'static, Tally> { TALLY.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) }
/// The app's counters.
pub fn counters() -> Value { tally().json() }
/// The observer the app's hook registry calls for every occurrence it publishes (installed with its grant check).
pub fn observer() -> Arc<dyn Fn(&Occurrence) + Send + Sync> { Arc::new(|occurrence: &Occurrence| tally().observe(occurrence)) }

// ---------------------------------------------------------------------------------------------------------------
// Harness capabilities
// ---------------------------------------------------------------------------------------------------------------

/// A harness of the roster: a built-in id, or a package provider (`publisher.extension/local-id`) with its owner.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Harness { pub id: String, pub name: String, pub package: Option<String>, pub installed: &'static str }

fn family(harness: &Harness) -> &'static str {
    let id = harness.id.as_str();
    if harness.package.is_some() { "package" }
    else if CLAUDE.contains(&id) { "claude" }
    else if ACP.contains(&id) { "acp" }
    else { match id { "codex" => "codex", "pi" | "omp" => "pi", "muse" => "muse", "zcode" => "zcode", _ => "unknown" } }
}
fn installed_qualified(id: &str, path: &str) -> bool { INSTALLED_QUALIFIED.iter().any(|(harness, qualified)| *harness == id && *qualified == path) }
/// A delivered path's qualification: installed qualification first, then a recorded frame, else source reading.
fn qualify(harness: &Harness, path: &str, recorded: bool) -> &'static str {
    if installed_qualified(&harness.id, path) { "installedQualified" } else if recorded { "recorded" } else { "sourceFeasible" }
}
fn recorded(harness: &Harness) -> bool { harness.package.is_some() || RECORDED.contains(&harness.id.as_str()) }

/// The modes a harness has.
pub fn modes(harness: &Harness) -> Vec<&'static str> {
    if family(harness) == "claude" { MODES.to_vec() } else { vec!["ask", "auto", "plan", "full"] }
}

/// What a permission request covers in `mode` (PLAN-contracts, "Expected values per harness"): the calls the harness
/// asks about, only sandbox escalations, or none (the call is then seen only by `tool.after`).
pub fn request_coverage(harness: &Harness, mode: &str) -> &'static str {
    let id = harness.id.as_str();
    match (family(harness), id, mode) {
        ("package", _, _) => "askedCalls",
        ("claude", _, "full") => "escalationsOnly",
        ("claude", _, _) => "askedCalls",
        (_, "codex", "ask" | "auto") => "escalationsOnly",
        (_, "codex", _) => "none",
        (_, "kimi" | "commandcode", "auto") => "escalationsOnly",
        (_, "opencode" | "kilo", "plan") => "escalationsOnly",
        (_, "commandcode" | "pi" | "omp", "plan") => "none",
        (_, "antigravity", _) => "askedCalls",
        (_, "deepseek", "full") | (_, "muse", "plan" | "full") => "none",
        (_, "deepseek" | "muse" | "devin", _) => "escalationsOnly",
        (_, "zcode", "full") => "escalationsOnly",
        (_, _, "full") => "none",
        _ => "askedCalls",
    }
}

/// The per-run companion: `sourceFeasible` where its mechanism is established by documentation or source reading
/// (no companion is installed for hooks yet), `unknown` where nothing was established, `none` where there is none.
fn companion(harness: &Harness) -> (&'static str, &'static str) {
    match (family(harness), harness.id.as_str()) {
        ("claude", _) => ("sourceFeasible", "hook callbacks registered in the initialize control request"),
        (_, "codex") => ("sourceFeasible", "hook declarations in the session configuration, trusted for the session"),
        (_, "opencode") => ("sourceFeasible", "a plugin named in the inline configuration (V1 file or V2 directory by version)"),
        (_, "kilo") => ("sourceFeasible", "a V1 plugin named in the inline configuration"),
        (_, "pi" | "omp") => ("sourceFeasible", "the bridge extension PandaCode already loads, consulting the host"),
        (_, "cline") => ("unknown", ""),
        _ => ("none", ""),
    }
}
/// Source B: in `full`, keep the harness in a mode that asks and answer at the host; not where the mode also selects
/// a sandbox (Codex, DeepSeek, Muse), already how Antigravity's `full` works, not established for Devin and Cursor.
fn ask_at_host(harness: &Harness) -> Option<&'static str> {
    matches!(harness.id.as_str(), "opencode" | "kilo" | "cline" | "kimi" | "grok" | "commandcode" | "github-copilot" | "hermes" | "zcode").then_some("askedCalls")
}
fn input_complete(harness: &Harness) -> bool { matches!(family(harness), "claude" | "acp" | "package") }
fn tool_servers(harness: &Harness) -> bool { !matches!(family(harness), "zcode" | "package") }
/// How PandaCode starts a compaction: Codex's own request, a harness command, or not at all.
fn compact(harness: &Harness) -> (&'static str, &'static str) {
    match (family(harness), harness.id.as_str()) {
        (_, "codex") => ("request", "recorded"),
        ("claude", _) | (_, "kimi") => ("command", "recorded"),
        ("acp", _) => ("command", "sourceFeasible"),
        _ => ("none", "unsupported"),
    }
}
/// Whether a finished compaction reaches the `compaction` hook (a "Compact context" step the adapter reports).
fn compaction_seen(harness: &Harness) -> bool { matches!(family(harness), "claude" | "codex") }
/// What a companion could still change around a compaction.
fn compaction_can(harness: &Harness) -> Vec<&'static str> {
    match (family(harness), harness.id.as_str()) {
        ("claude", _) => vec!["instructions", "cancel"],
        (_, "codex") => vec!["cancel"],
        ("pi", _) => vec!["summary", "instructions", "cancel"],
        (_, "opencode") => vec!["summary"],
        _ => vec![],
    }
}
/// What a companion could do to a tool result.
fn rewrite_result(harness: &Harness) -> &'static str {
    match (family(harness), harness.id.as_str()) {
        ("claude" | "pi", _) | (_, "opencode" | "kilo") => "replace",
        (_, "codex") => "feedback",
        _ => "none",
    }
}
fn evidence(harness: &Harness) -> &'static str {
    if recorded(harness) { "frame" } else if matches!(harness.id.as_str(), "opencode" | "kilo") { "spike" } else { "documentation" }
}
fn support(harness: &Harness) -> super::runtime_hook_payload::Support {
    if harness.package.is_some() { super::runtime_hook_payload::provider_support(&Value::Null) } else { super::runtime_hook_payload::builtin_support(&harness.id) }
}

/// The `tool.before` cell of `mode`: the source and coverage delivered today, what the source could carry once
/// decisions are delivered (`sourceCan`; `can` is what a deciding hook can do there, R0505), and the other sources
/// that are feasible, each with its own qualification.
fn before_cell(harness: &Harness, mode: &str) -> Value {
    let coverage = request_coverage(harness, mode);
    let support = support(harness);
    let mut cell = if coverage == "none" {
        json!({"source": null, "coverage": "none", "can": [], "sourceCan": [], "qualification": "unsupported"})
    } else {
        let path = format!("toolBefore.permissionRequest.{mode}");
        // `can`: what a deciding hook can do with a request of this mode for a call the mode allows (R0505: no approve
        // where the sandbox or the mode holds the request); `sourceCan`: what the source carries at all.
        let can = super::runtime_hook_decisions::mode_can(support, &harness.id, mode);
        json!({"source": "permissionRequest", "coverage": coverage, "can": can, "sourceCan": support.can(), "qualification": qualify(harness, &path, recorded(harness))})
    };
    let mut feasible = Vec::new();
    if companion(harness).0 == "sourceFeasible" {
        let path = format!("toolBefore.companion.{mode}");
        let qualification = if installed_qualified(&harness.id, &path) { "installedQualified" } else { "sourceFeasible" };
        feasible.push(json!({"source": "companion", "coverage": "everyCall", "qualification": qualification}));
    }
    if mode == "full" && coverage != "askedCalls" {
        if let Some(coverage) = ask_at_host(harness) { feasible.push(json!({"source": "askAtHost", "coverage": coverage, "qualification": "sourceFeasible"})); }
    }
    cell["feasible"] = json!(feasible);
    cell
}

/// One `HarnessCapabilities` row.
pub fn row(harness: &Harness) -> Value {
    let (companion_state, mechanism) = companion(harness);
    let support = support(harness);
    let before: Map<String, Value> = modes(harness).into_iter().map(|mode| (mode.to_owned(), before_cell(harness, mode))).collect();
    let (how, compact_qualification) = compact(harness);
    let seen = compaction_seen(harness);
    let host_tools = if tool_servers(harness) { json!({"source": "hostTool", "coverage": "everyCall", "qualification": "sourceFeasible"}) } else { Value::Null };
    let rewrite = rewrite_result(harness);
    let compaction_feasible = if compaction_can(harness).is_empty() { json!([]) } else { json!([{"source": "companion", "can": compaction_can(harness), "qualification": "sourceFeasible"}]) };
    let mut row = json!({
        "schemaVersion": SCHEMA_VERSION,
        "id": harness.id, "name": harness.name, "kind": if harness.package.is_some() { "package" } else { "builtin" },
        "installed": harness.installed,
        "modes": modes(harness),
        "evidence": evidence(harness),
        "toolServers": {"value": tool_servers(harness), "qualification": if !tool_servers(harness) { "unsupported" } else if recorded(harness) { "recorded" } else { "sourceFeasible" }},
        "compact": {"how": how, "qualification": compact_qualification},
        "denyReason": support.json()["denyReason"], "rewriteInput": support.rewrite_input,
        "companion": {"state": companion_state, "mechanism": if mechanism.is_empty() { Value::Null } else { json!(mechanism) }, "qualification": if companion_state == "sourceFeasible" { "sourceFeasible" } else { "unsupported" }},
        "hooks": {
            "toolBefore": before,
            "toolAfter": {
                "source": "activity", "coverage": "afterOnly", "rewriteResult": "none", "inputComplete": input_complete(harness),
                "qualification": qualify(harness, "toolAfter.activity", recorded(harness)),
                "feasible": if rewrite == "none" { json!([]) } else { json!([{"source": "companion", "rewriteResult": rewrite, "qualification": "sourceFeasible"}]) },
            },
            "hostTools": {"delivered": {"source": "activity", "coverage": "afterOnly"}, "feasible": host_tools},
            "promptSubmit": {"source": "host", "can": [], "qualification": "recorded"},
            "turn": {"source": "host", "qualification": "recorded"},
            "compaction": {
                "phase": if seen { "after" } else { "none" }, "can": [],
                "qualification": if seen { qualify(harness, "compaction.after", true) } else { "unsupported" },
                "feasible": compaction_feasible,
            },
        },
    });
    if let Some(package) = &harness.package { row["owner"] = json!(package); }
    row
}

/// One traced launch path: the seam that starts it, the seam that reports its events, and what reaches the hooks.
struct Path { kind: &'static str, trigger: &'static str, launch: &'static str, events: &'static str, companions: &'static str }
const PATHS: [Path; 12] = [
    Path { kind: "task", trigger: "user", launch: "send", events: "agentEvents", companions: "perHarness" },
    Path { kind: "task", trigger: "package", launch: "tasksStart", events: "agentEvents", companions: "perHarness" },
    Path { kind: "task", trigger: "tool", launch: "agentTool", events: "agentEvents", companions: "perHarness" },
    Path { kind: "worker", trigger: "team", launch: "teamWorker", events: "agentEvents", companions: "perHarness" },
    Path { kind: "worker", trigger: "council", launch: "teamWorker", events: "agentEvents", companions: "perHarness" },
    Path { kind: "bot", trigger: "bot", launch: "botWorkspace", events: "agentEvents", companions: "perHarness" },
    Path { kind: "bot", trigger: "remote", launch: "remoteRequest", events: "agentEvents", companions: "perHarness" },
    Path { kind: "schedule", trigger: "schedule", launch: "scheduleFiring", events: "agentEvents", companions: "perHarness" },
    Path { kind: "remote", trigger: "remote", launch: "remoteRequest", events: "agentEvents", companions: "perHarness" },
    Path { kind: "remote", trigger: "remote", launch: "remoteStart", events: "agentEvents", companions: "perHarness" },
    Path { kind: "remote", trigger: "cloud", launch: "cloudRun", events: "agentEvents", companions: "perHarness" },
    Path { kind: "remote", trigger: "mirror", launch: "mirrorSend", events: "mirrorEvents", companions: "unavailable" },
];

/// Run coverage: per run kind, its traced paths and the counters.
pub fn runs(counters: &Value) -> Value {
    let delivered = super::runtime_hook_registration::DELIVERED;
    let rows: Vec<Value> = super::runtime_hook_registration::RUN_KINDS.iter().map(|kind| {
        let paths: Vec<Value> = PATHS.iter().filter(|path| path.kind == *kind).map(|path| json!({
            "trigger": path.trigger, "launch": path.launch, "events": path.events,
            "toolBefore": {"source": "permissionRequest", "companions": path.companions},
            "delivered": delivered,
            "qualification": "recorded",
        })).collect();
        json!({"kind": kind, "paths": paths, "counters": counters[*kind].clone()})
    }).collect();
    json!(rows)
}

/// The whole answer of `panda.harnesses.list`.
pub fn report(harnesses: &[Harness], counters: &Value, only: Option<&str>) -> Value {
    let rows: Vec<Value> = harnesses.iter().filter(|harness| only.is_none_or(|id| harness.id == id)).map(row).collect();
    // R0505: `tool.before` decisions are delivered (approve, deny, ask, rewrite where `can` lists it).
    let lifecycle = super::runtime_companion_lifetime::registry().lock()
        .map(|companions| companions.report())
        .unwrap_or_else(|_| json!({"code": "HostUnavailable"}));
    json!({"schemaVersion": SCHEMA_VERSION, "decisions": "delivered", "harnesses": rows,
        "runs": runs(counters), "companionLifecycle": lifecycle, "companionCoverage": harnesses.iter().filter(|h| only.is_none_or(|id| h.id == id)).map(|h| super::runtime_package_companions::coverage(&h.id)).collect::<Vec<_>>()})
}

/// The built-in roster and the package providers of enabled, trusted packages (`snapshot` is `extensions_snapshot`
/// JSON). `installed` probes a built-in harness's executable.
pub fn roster(snapshot: &Value, installed: impl Fn(&str) -> bool) -> Vec<Harness> {
    let mut out: Vec<Harness> = crate::providers::PROVIDERS.iter()
        .map(|(id, name)| Harness { id: (*id).to_owned(), name: (*name).to_owned(), package: None, installed: if installed(id) { "Installed" } else { "Absent" } })
        .collect();
    if snapshot["safeMode"] == true { return out; }
    for package in snapshot["packages"].as_array().into_iter().flatten() {
        if package["enabled"] != true || package["executable"]["trusted"] != true { continue; }
        let Some(owner) = package["manifest"]["id"].as_str() else { continue };
        for provider in package["manifest"]["contributes"]["providers"].as_array().into_iter().flatten() {
            let (Some(id), Some(name)) = (provider["id"].as_str(), provider["name"].as_str()) else { continue };
            let installed = match provider["metadata"]["readiness"]["state"].as_str() { None | Some("ready") => "Installed", Some(_) => "Unknown" };
            out.push(Harness { id: id.to_owned(), name: name.to_owned(), package: Some(owner.to_owned()), installed });
        }
    }
    out
}

// ---------------------------------------------------------------------------------------------------------------
// The service request
// ---------------------------------------------------------------------------------------------------------------

/// `panda.harnesses.list(options?)`: `{}` or `{ harness?, includeModels?: false }`. Models stay with the context
/// inventory (`includeModels: true` answers `UnsupportedCapability`).
pub fn read_options(params: &Value) -> Result<Option<String>, &'static str> {
    let fields = params.as_object().ok_or("InvalidShape")?;
    if fields.keys().any(|key| !matches!(key.as_str(), "harness" | "includeModels")) { return Err("InvalidShape"); }
    match fields.get("includeModels") { None | Some(Value::Null) | Some(Value::Bool(false)) => {} Some(Value::Bool(true)) => return Err("UnsupportedCapability"), Some(_) => return Err("InvalidShape") }
    match fields.get("harness") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(id)) if !id.is_empty() && id.len() <= 160 && !id.chars().any(char::is_control) => Ok(Some(id.clone())),
        Some(_) => Err("InvalidShape"),
    }
}

/// The version of an enabled, trusted package outside safe mode, and the snapshot it was read from.
fn package(app: &tauri::AppHandle, owner: &str) -> Option<(String, Value)> {
    use tauri::Manager;
    let packages = app.try_state::<super::packages::ExtensionPackages>()?;
    let snapshot = serde_json::to_value(packages.0.lock().ok()?.snapshot()).ok()?;
    if snapshot["safeMode"] == true { return None; }
    let package = snapshot["packages"].as_array()?.iter().find(|package| package["manifest"]["id"] == owner)?;
    if package["enabled"] != true || package["executable"]["trusted"] != true { return None; }
    let version = package["manifest"]["version"].as_str()?.to_owned();
    Some((version, snapshot))
}

/// The service request `harnessesList`; the owner is the connection's, never the request's.
pub async fn serve(app: tauri::AppHandle, request: super::runtime_service_lifetime::DispatchRequest) -> Value {
    tauri::async_runtime::spawn_blocking(move || serve_now(&app, &request.owner, &request.params)).await.unwrap_or_else(|_| super::context::failure("HostUnavailable"))
}
fn serve_now(app: &tauri::AppHandle, owner: &str, params: &Value) -> Value {
    use tauri::Manager;
    let only = match read_options(params) { Ok(only) => only, Err(code) => return super::context::failure(code) };
    let Some((version, snapshot)) = package(app, owner) else { return super::context::failure("HostUnavailable") };
    let Some(grants) = app.try_state::<super::runtime_grants::RuntimeGrants>() else { return super::context::failure("HostUnavailable") };
    if !super::runtime_hook_registration::holds(&grants, owner, &version, PERMISSION, None) { return super::context::failure("PermissionDenied"); }
    let harnesses = roster(&snapshot, |id| crate::providers::executable(id).is_some());
    if let Some(id) = &only { if !harnesses.iter().any(|harness| harness.id == *id) { return super::context::failure("NotFound"); } }
    let mut value = report(&harnesses, &counters(), only.as_deref());
    value["packageCompanions"] = json!(harnesses.iter().filter(|h| only.as_ref().is_none_or(|id| h.id == *id)).flat_map(|h| {
        let installed = super::runtime_companion_lifetime::InstalledApi { harness: h.id.clone(), version: None, apis: vec![] };
        super::runtime_package_companions::listing(&snapshot, None, &installed, |id, version| grants.check(id, version, super::runtime_package_companions::PERMISSION, &super::runtime_grants::Target::default()).is_ok())
    }).collect::<Vec<_>>());
    json!({"ok": true, "value": value})
}

// ---------------------------------------------------------------------------------------------------------------
// A task that runs on another computer (the desktop's mirror)
// ---------------------------------------------------------------------------------------------------------------

/// Kinds of mirrored events that show the host's turn is under way.
const STARTING: [&str; 7] = ["turn_start", "message_start", "text", "tool", "status", "approval", "input_request"];

/// The facts of a mirror's turn, read from this computer's store.
fn mirror_facts(app: &tauri::AppHandle, local: &str, host: &str, text: &str) -> Option<RunFacts> {
    use tauri::Manager;
    let state = app.try_state::<crate::AppState>()?;
    let store = state.store.lock().ok()?;
    let task = store.session(local).ok()?;
    let root = store.project(&task.project_id).map(|project| project.path).unwrap_or_default();
    let users = store.db.query_row("SELECT COUNT(*) FROM messages WHERE session_id=?1 AND role='user'", [local], |row| row.get::<_, i64>(0)).unwrap_or(0).max(0) as u64;
    Some(RunFacts {
        task_id: local.to_owned(), project_id: task.project_id, project_root: root.clone(), cwd: root,
        harness: task.provider, model: Some(task.model).filter(|model| !model.is_empty()), mode: task.mode,
        run: mirror_run(host), index: (users + u64::from(!text.is_empty())).max(1), text: text.to_owned(),
        attachments: vec![], started_by: json!("user"), transcript_cursor: 0,
    })
}

/// This desktop sent a prompt to a mirrored task (`mirror::send`, after the host took it): `prompt.submit` and
/// `turn.start`, unless the host's events already started the turn here.
pub fn mirror_sent(app: &tauri::AppHandle, local: &str, host: &str, text: &str) {
    let hub = super::runtime_hook_registration::registry();
    if !hub.active() || hub.run(local).is_some() { return; }
    let Some(facts) = mirror_facts(app, local, host, text) else { return };
    tally().launch(&facts.run);
    hub.turn_started(facts);
}

/// Events of mirrored tasks, as `mirror::show` emits them (relabelled to local ids).
pub fn mirror_events(app: &tauri::AppHandle, host: &str, events: &[Value]) {
    // Pending approvals and questions of the mirrored task (R0507), whether or not a hook is attached yet.
    super::runtime_pending_requests::mirror_events(app, events);
    let hub = super::runtime_hook_registration::registry();
    if !hub.active() { return; }
    feed(hub, events, |local| mirror_facts(app, local, host, ""), |run| tally().launch(run));
}

/// Hands mirrored events to `hub`: a turn the host started without this desktop starts here with its first sign of
/// work (`start` answers its facts, `None` for a task not mirrored here); a permission request is `tool.before`
/// (source `permissionRequest`, decided on the host by its user: no companion is available for a run on another
/// computer); a finished tool row is `tool.after` (source `activity`), a finished "Compact context" step
/// `compaction`. The complete input is what the host sent: the request's `data.input`, else the row's input text.
pub fn feed(hub: &HookRegistry, events: &[Value], start: impl Fn(&str) -> Option<RunFacts>, mut launched: impl FnMut(&Value)) {
    use super::runtime_hook_payload as payloads;
    let payload: super::runtime_hook_registration::CallPayload<'_> = &payloads::hook_call;
    for event in events {
        let (Some(local), Some(kind)) = (event["sessionId"].as_str(), event["kind"].as_str()) else { continue };
        if hub.run(local).is_none() {
            if !STARTING.contains(&kind) { continue; }
            let Some(facts) = start(local) else { continue };
            launched(&facts.run);
            hub.turn_started(facts);
        }
        let Some(project) = hub.run(local).map(|facts| facts.project_id) else { continue };
        if kind == "approval" {
            let Some(request) = event["requestId"].as_str() else { continue };
            let data = &event["data"];
            let name = ["name", "tool_name", "title"].iter().find_map(|key| data[*key].as_str()).unwrap_or("tool").to_owned();
            let input = [&data["input"], &data["rawInput"]].into_iter().find(|input| !input.is_null()).cloned().unwrap_or_else(|| json!({"preview": event["text"]}));
            let Ok(recorded) = payloads::record(local, Some(project.as_str()), &format!("request:{request}"), &input) else { continue };
            hub.tool_before(local, &recorded.call_id, &recorded.call_id, &name, Some(request), payload);
            continue;
        }
        let tool = &event["tool"];
        let (Some(id), Some(name), Some(status)) = (tool["id"].as_str(), tool["name"].as_str(), tool["status"].as_str()) else { continue };
        if name == "Compact context" {
            if status == "completed" { hub.compaction(local); }
            continue;
        }
        if !matches!(status, "completed" | "success" | "failed" | "error" | "cancelled" | "canceled" | "denied" | "rejected" | "interrupted") { continue; }
        let text = tool["input"].as_str().unwrap_or_default();
        let input = serde_json::from_str(text).unwrap_or_else(|_| json!({"preview": text}));
        let call = payloads::call_id(local, id).or_else(|| payloads::record(local, Some(project.as_str()), id, &input).ok().map(|recorded| recorded.call_id));
        let Some(call) = call else { continue };
        hub.tool_after(local, &call, &call, name, status, tool["output"].as_str().unwrap_or_default(), payload);
    }
}

/// The mirrored turn ended here (`mirror::finish`): `turn.finish` or `turn.fail`, then `task.idle`.
pub fn mirror_ended(local: &str, successful: bool, stopped: bool) {
    super::runtime_hook_registration::run_ended(local, successful, stopped);
    // R0507: the mirrored turn's open requests end with it.
    super::runtime_pending_requests::run_ended(local, None);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::extensions::runtime_hook_registration::{check, OBSERVE};

    const MATRIX: &str = include_str!("../../../tests/fixtures/extensions/runtime-harness-coverage/matrix.json");
    const SCENARIOS: &str = include_str!("../../../tests/fixtures/extensions/runtime-harness-coverage/scenarios.json");
    const MANIFEST: &str = include_str!("../../../tests/fixtures/extensions/runtime-harness-coverage/extension.json");
    const OWNER: &str = "sample.coverage-reader";

    fn matrix() -> Value { serde_json::from_str(MATRIX).unwrap() }
    fn scenarios() -> Value { serde_json::from_str(SCENARIOS).unwrap() }
    fn builtin(id: &str) -> Harness { Harness { id: id.into(), name: id.into(), package: None, installed: "Unknown" } }
    fn harness(id: &str) -> Harness { if id.contains('/') { Harness { id: id.into(), name: "Fake agent".into(), package: Some("fake.agent".into()), installed: "Installed" } } else { builtin(id) } }

    #[test]
    fn every_built_in_harness_has_an_expected_row_and_the_rows_agree_with_it() {
        let matrix = matrix();
        let expected = matrix["harnesses"].as_object().unwrap();
        for (id, _) in crate::providers::PROVIDERS { assert!(expected.contains_key(id), "{id} has no expected row"); }
        for (id, want) in expected {
            let row = row(&harness(id));
            let modes: Vec<&str> = want["before"].as_object().unwrap().keys().map(String::as_str).collect();
            let mut have: Vec<&str> = row["modes"].as_array().unwrap().iter().map(|mode| mode.as_str().unwrap()).collect();
            have.sort_unstable();
            let mut sorted = modes.clone();
            sorted.sort_unstable();
            assert_eq!(have, sorted, "{id} modes");
            for mode in modes {
                let cell = &row["hooks"]["toolBefore"][mode];
                assert_eq!(cell["coverage"], want["before"][mode], "{id} {mode}");
                let qualification = if want["before"][mode] == "none" { json!("unsupported") } else { want["request"].clone() };
                assert_eq!(cell["qualification"], qualification, "{id} {mode} qualification");
                // R0505: the delivered `can`, never more than the source carries, never approve where the sandbox or mode holds it.
                let source_can: Vec<&str> = cell["sourceCan"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
                assert!(cell["can"].as_array().unwrap().iter().all(|entry| source_can.contains(&entry.as_str().unwrap())), "{id} {mode}: can within sourceCan");
                if crate::extensions::runtime_hook_decisions::mode_holds(id, mode) { assert!(!cell["can"].as_array().unwrap().contains(&json!("approve")), "{id} {mode}: held by the mode"); }
                let companion = cell["feasible"].as_array().unwrap().iter().any(|feasible| feasible["source"] == "companion" && feasible["coverage"] == "everyCall");
                assert_eq!(companion, want["companion"] == "sourceFeasible", "{id} {mode} companion");
                let ask = cell["feasible"].as_array().unwrap().iter().find(|feasible| feasible["source"] == "askAtHost").map(|feasible| feasible["coverage"].clone());
                if mode == "full" && want["before"]["full"] != "askedCalls" { assert_eq!(ask.unwrap_or(Value::Null), want["askAtHost"], "{id} askAtHost"); } else { assert!(ask.is_none(), "{id} {mode}"); }
            }
            assert_eq!(row["companion"]["state"], want["companion"], "{id}");
            assert_eq!(row["hooks"]["toolAfter"]["inputComplete"], want["inputComplete"], "{id}");
            assert_eq!(row["toolServers"]["value"], want["toolServers"], "{id}");
            assert_eq!(row["compact"]["how"], want["compact"], "{id}");
            assert_eq!(row["hooks"]["compaction"]["phase"], want["compaction"], "{id}");
            let rewrite = row["hooks"]["toolAfter"]["feasible"].as_array().unwrap().first().map(|feasible| feasible["rewriteResult"].clone()).unwrap_or(json!("none"));
            assert_eq!(rewrite, want["rewriteResult"], "{id}");
            assert_eq!(row["denyReason"], want["denyReason"], "{id}");
            assert_eq!(row["rewriteInput"], want["rewriteInput"], "{id}");
            assert_eq!(row["evidence"], want["evidence"], "{id}");
        }
    }

    /// Every capability is an object with a qualification from the four words; the only booleans are facts with
    /// their own qualified parent (`toolServers.value`, `rewriteInput`, `toolAfter.inputComplete`).
    fn no_blanket_boolean(value: &Value, path: &str) {
        match value {
            Value::Bool(_) => assert!(["toolServers.value", "rewriteInput", "hooks.toolAfter.inputComplete"].contains(&path), "bare boolean at {path}"),
            Value::Object(fields) => {
                if let Some(qualification) = fields.get("qualification") { assert!(QUALIFICATIONS.contains(&qualification.as_str().unwrap()), "{path}"); }
                if let Some(coverage) = fields.get("coverage") { assert!(COVERAGES.contains(&coverage.as_str().unwrap()), "{path}"); }
                if let Some(Value::String(source)) = fields.get("source") { assert!(SOURCES.contains(&source.as_str()) || source == "host", "{path}"); }
                for (key, item) in fields { no_blanket_boolean(item, &if path.is_empty() { key.clone() } else { format!("{path}.{key}") }); }
            }
            Value::Array(items) => items.iter().for_each(|item| no_blanket_boolean(item, path)),
            _ => {}
        }
    }

    #[test]
    fn rows_are_qualified_cells_never_booleans_and_nothing_claims_an_installed_qualification() {
        for id in matrix()["harnesses"].as_object().unwrap().keys() {
            let row = row(&harness(id));
            no_blanket_boolean(&row, "");
            for mode in row["modes"].as_array().unwrap() {
                let cell = &row["hooks"]["toolBefore"][mode.as_str().unwrap()];
                assert!(cell.is_object() && cell["qualification"].is_string(), "{id} {mode}");
            }
            assert!(!row.to_string().contains("installedQualified"), "{id}: no authorized capture exists");
            for hook in ["toolAfter", "promptSubmit", "turn", "compaction"] { assert!(row["hooks"][hook]["qualification"].is_string(), "{id} {hook}"); }
        }
        assert!(matrix()["installedQualified"].as_array().unwrap().is_empty());
    }

    #[test]
    fn every_traced_path_classifies_its_run_as_the_scenario_expects() {
        for scenario in scenarios()["scenarios"].as_array().unwrap() {
            let facts = LaunchFacts::from_json(&scenario["facts"]);
            let origin = LaunchOrigin::from_json(&scenario["origin"]);
            assert_eq!(classify(&facts, origin.as_ref()), scenario["expect"], "{}", scenario["id"]);
            let paths = runs(&Tally::default().json());
            let kind = scenario["expect"]["kind"].as_str().unwrap();
            let traced = paths.as_array().unwrap().iter().find(|row| row["kind"] == kind).unwrap();
            assert!(traced["paths"].as_array().unwrap().iter().any(|path| path["launch"] == scenario["seam"] && path["trigger"] == scenario["expect"]["trigger"]), "{} is traced", scenario["id"]);
        }
        let script = scenarios();
        let mirror = &script["mirror"];
        assert_eq!(mirror_run(mirror["host"].as_str().unwrap()), mirror["expect"]);
        for kind in super::super::runtime_hook_registration::RUN_KINDS { assert!(runs(&Value::Null).as_array().unwrap().iter().any(|row| row["kind"] == kind)); }
        for path in &PATHS { assert!(TRIGGERS.contains(&path.trigger)); }
    }

    #[test]
    fn the_launch_scope_reaches_a_turn_started_inside_it_and_nothing_outside() {
        tauri::async_runtime::block_on(async {
            assert_eq!(current(), None);
            let inside = within(LaunchOrigin::schedule("s-1"), async { current() }).await;
            assert_eq!(inside, Some(LaunchOrigin::schedule("s-1")));
            let nested = within(LaunchOrigin::remote("phone"), within(LaunchOrigin::tool("t", "pandacode_start_task"), async { current() })).await;
            assert_eq!(nested, Some(LaunchOrigin::tool("t", "pandacode_start_task")), "the innermost scope wins");
            assert_eq!(current(), None);
            // A launch spawned elsewhere is not inside the scope.
            let spawned = within(LaunchOrigin::schedule("s-2"), async { tauri::async_runtime::spawn(async { current() }).await.unwrap() }).await;
            assert_eq!(spawned, None);
        });
    }

    type Seen = Arc<Mutex<Vec<Value>>>;
    fn counting_registry(tally: Arc<Mutex<Tally>>) -> (HookRegistry, Seen) {
        let hub = HookRegistry::default();
        hub.set_gate(Arc::new(|_, _, permission, _| permission == OBSERVE));
        let seen: Seen = Arc::default();
        let sink = seen.clone();
        hub.set_deliver(Arc::new(move |_, frame| { sink.lock().unwrap().push(frame); Ok(()) }));
        hub.set_observer(Arc::new(move |occurrence: &Occurrence| tally.lock().unwrap().observe(occurrence)));
        let manifest: Value = serde_json::from_str(MANIFEST).unwrap();
        let mut declarations = check(&manifest).unwrap();
        // Every delivered event, observed everywhere.
        for event in super::super::runtime_hook_registration::DELIVERED {
            if !declarations.iter().any(|declaration| declaration.event == event) {
                declarations.push(super::super::runtime_hook_registration::Declaration { id: format!("{OWNER}/{event}"), event: event.into(), on_failure: "continue".into(), budget_ms: 2_000, matcher: Default::default() });
            }
        }
        for declaration in &declarations { hub.register(OWNER, "1.0.0", &declarations, &declaration.event).unwrap(); }
        (hub, seen)
    }
    fn turn(task: &str, run: Value, text: &str) -> RunFacts {
        RunFacts { task_id: task.into(), project_id: "A".into(), project_root: "/work/A".into(), cwd: "/work/A".into(), harness: "fake.agent/agent".into(), model: None, mode: "ask".into(), run, index: 1, text: text.into(), attachments: vec![], started_by: json!("user"), transcript_cursor: 0 }
    }

    #[test]
    fn one_scenario_per_run_kind_and_the_mirror_match_the_report_counters() {
        let tally = Arc::new(Mutex::new(Tally::default()));
        let (hub, seen) = counting_registry(tally.clone());
        let payload: super::super::runtime_hook_registration::CallPayload<'_> = &super::super::runtime_hook_payload::hook_call;
        let script = scenarios();
        for (index, scenario) in script["scenarios"].as_array().unwrap().iter().enumerate() {
            let task = format!("r0509-{index}-{}", scenario["id"].as_str().unwrap());
            let run = classify(&LaunchFacts::from_json(&scenario["facts"]), LaunchOrigin::from_json(&scenario["origin"]).as_ref());
            tally.lock().unwrap().launch(&run);
            hub.turn_started(turn(&task, run, "go"));
            let recorded = super::super::runtime_hook_payload::record(&task, Some("A"), "c1", &json!({"command": "ls"})).unwrap();
            hub.tool_before(&task, &recorded.call_id, &recorded.call_id, "Bash", Some("r1"), payload);
            hub.tool_after(&task, &recorded.call_id, &recorded.call_id, "Bash", "completed", "a.ts", payload);
            hub.turn_ended(&task, true, None);
        }
        // The desktop's view of a task on another computer: sent here, decided on the host, no companion.
        let mirror = &script["mirror"];
        let local = format!("r0509-{}", mirror["task"].as_str().unwrap());
        let host = mirror["host"].as_str().unwrap().to_owned();
        let relabel = |event: &Value| { let mut event = event.clone(); if event["sessionId"] == mirror["task"] { event["sessionId"] = json!(local); } event };
        let events: Vec<Value> = mirror["events"].as_array().unwrap().iter().map(relabel).collect();
        let sent = turn(&local, mirror_run(&host), "go");
        tally.lock().unwrap().launch(&sent.run);
        hub.turn_started(sent);
        seen.lock().unwrap().clear();
        feed(&hub, &events, |_| None, |run| tally.lock().unwrap().launch(run));
        hub.turn_ended(&local, true, None);
        let frames = seen.lock().unwrap().clone();
        let delivered: Vec<&str> = frames.iter().map(|frame| frame["event"].as_str().unwrap()).collect();
        assert_eq!(delivered, ["tool.before", "tool.after", "compaction", "turn.finish", "task.idle"]);
        let before = &frames[0]["payload"];
        assert_eq!([&before["source"], &before["coverage"], &before["run"]["kind"], &before["run"]["hostId"], &before["requestId"]], [&json!("permissionRequest"), &json!("askedCalls"), &json!("remote"), &json!(host), &json!("run:r9")]);
        assert_eq!(before["input"], json!({"command": "ls"}));
        assert_eq!([&frames[1]["payload"]["source"], &frames[1]["payload"]["coverage"]], [&json!("activity"), &json!("afterOnly")]);
        assert!(frames.iter().all(|frame| frame["payload"]["taskId"] != "t-other"), "a task not mirrored here starts nothing");

        let counted = tally.lock().unwrap().json();
        for (kind, want) in script["counters"].as_object().unwrap() { assert_eq!(counted[kind], *want, "{kind}"); }
        let report = report(&[harness("claude")], &counted, None);
        for row in report["runs"].as_array().unwrap() { assert_eq!(row["counters"], script["counters"][row["kind"].as_str().unwrap()], "{}", row["kind"]); }
        let remote = report["runs"].as_array().unwrap().iter().find(|row| row["kind"] == "remote").unwrap();
        let mirrored = remote["paths"].as_array().unwrap().iter().find(|path| path["trigger"] == "mirror").unwrap();
        assert_eq!(mirrored["toolBefore"], json!({"source": "permissionRequest", "companions": "unavailable"}));
    }

    #[test]
    fn list_options_are_read_strictly_and_the_report_filters_by_harness() {
        assert_eq!(read_options(&json!({})), Ok(None));
        assert_eq!(read_options(&json!({"includeModels": false, "harness": "codex"})), Ok(Some("codex".into())));
        assert_eq!(read_options(&json!({"includeModels": true})), Err("UnsupportedCapability"));
        for bad in [json!(null), json!([]), json!({"harness": 3}), json!({"harness": ""}), json!({"other": 1}), json!({"includeModels": "no"})] { assert_eq!(read_options(&bad), Err("InvalidShape"), "{bad}"); }
        let snapshot = json!({"safeMode": false, "packages": [
            {"enabled": true, "executable": {"trusted": true}, "manifest": {"id": "fake.agent", "contributes": {"providers": [{"id": "fake.agent/agent", "name": "Fake agent"}]}}},
            {"enabled": false, "executable": {"trusted": true}, "manifest": {"id": "off.agent", "contributes": {"providers": [{"id": "off.agent/agent", "name": "Off"}]}}},
        ]});
        let harnesses = roster(&snapshot, |id| id == "claude");
        assert_eq!(harnesses.len(), crate::providers::PROVIDERS.len() + 1);
        assert_eq!(harnesses.iter().find(|harness| harness.id == "claude").unwrap().installed, "Installed");
        assert_eq!(harnesses.iter().find(|harness| harness.id == "codex").unwrap().installed, "Absent");
        let package = harnesses.iter().find(|harness| harness.id == "fake.agent/agent").unwrap();
        assert_eq!(package.package.as_deref(), Some("fake.agent"));
        assert_eq!(roster(&json!({"safeMode": true, "packages": snapshot["packages"]}), |_| false).len(), crate::providers::PROVIDERS.len());
        let only = report(&harnesses, &Value::Null, Some("fake.agent/agent"));
        assert_eq!(only["harnesses"].as_array().unwrap().len(), 1);
        assert_eq!([&only["harnesses"][0]["kind"], &only["harnesses"][0]["owner"], &only["decisions"]], [&json!("package"), &json!("fake.agent"), &json!("delivered")]);
        // The reader's manifest declares what it needs.
        let manifest: Value = serde_json::from_str(MANIFEST).unwrap();
        assert!(manifest["permissions"].as_array().unwrap().iter().any(|permission| permission == PERMISSION));
    }
}
