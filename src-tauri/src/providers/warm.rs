//! Warm agents: after a Claude turn ends, the next turn's process starts in the background
//! so a follow-up skips the CLI's own startup (about 1.4 s). A warm agent is adopted only
//! when everything on its command line and in its tool catalog still matches; otherwise it
//! is discarded and the turn starts cold as before. A model or permission switch is applied to
//! a waiting agent in place (`warm_switch.rs`); other switches restart it.
//!
//! Ordering, shared with `handshake_warm.rs` through one counter (`next_generation`):
//! - a ticket (`reserve`) holds a debounced first start for any harness; only the task's newest
//!   ticket may start an agent, and a send ends the debounce early and adopts what it starts;
//! - a Claude generation (`Target`) orders the starts and switches of a task's Claude agent:
//!   only the current one may store its agent;
//! - a handshake generation orders the starts of a task's Codex or ACP spare likewise.
//!
//! A send waits for whichever of these is in flight for its exact launch (`wait_while`).
use super::*;
use std::sync::LazyLock;

#[path = "warm_state.rs"]
mod state;
pub use state::{debounce, release, reserve, reserved, touch};
pub(super) use state::*;
#[path = "warm_switch.rs"]
mod switch;
pub use switch::retarget;
#[cfg(test)]
use switch::retargeted;

/// Rapid switches (clicking through models or efforts) start only the last one's agent.
pub const DEBOUNCE: Duration = Duration::from_millis(200);
/// A warm agent waits at most this long for its follow-up.
pub(super) const IDLE: Duration = Duration::from_secs(10 * 60);
/// Each one holds an idle CLI process, so only the most recent tasks keep one, counted across
/// every harness (`super::limit_spares`).
pub(super) const LIMIT: usize = 2;
/// A send waits at most this long for an agent still starting, switching or debouncing for its
/// exact launch: about a cold Claude start, so waiting never costs much more than not having a
/// spare. Past it the send starts cold and the late agent is discarded (`launched`).
pub(super) const GRACE: Duration = Duration::from_millis(1500);

pub(super) struct Spare {
    key: String,
    pub(super) child: Child,
    pub(super) group: ProcessGroup,
    pub(super) server: Option<mcp_host::Server>,
    born: std::time::Instant,
    generation: u64,
    /// What the agent printed before it was adopted, owed to the turn that adopts it.
    pub(super) pending: Vec<u8>,
    /// Ids of switch requests (`warm_switch.rs`) written to it but not yet answered: the
    /// adopting run waits for their replies before its first message, and drops them.
    pub(super) unanswered: HashSet<String>,
}

/// The inputs of a task's newest prewarm, so a model or effort switch can restart its spare.
/// Only the prewarm holding the current generation may insert a spare.
struct Target {
    config: RunConfig,
    tools: Vec<Value>,
    approval_tools: HashSet<String>,
    launch: u64,
    generation: u64,
    /// This generation's agent is still starting, debouncing or switching.
    busy: bool,
    /// The key that agent will carry, once known.
    key: Option<String>,
}

static TARGETS: LazyLock<Mutex<HashMap<String, Target>>> = LazyLock::new(Default::default);

static SPARES: LazyLock<Mutex<HashMap<String, Spare>>> = LazyLock::new(Default::default);
/// Counts each task's launches. A spare started for launch N is useless once launch N+1
/// has begun: it would resume the conversation without that turn.
static LAUNCHES: LazyLock<Mutex<HashMap<String, u64>>> = LazyLock::new(Default::default);

/// The task's current launch count, read when a turn ends and before the next can begin.
pub fn epoch(session_id: &str) -> u64 {
    LAUNCHES.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).get(session_id).copied().unwrap_or(0)
}

fn spares() -> std::sync::MutexGuard<'static, HashMap<String, Spare>> {
    SPARES.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Lock order: SPARES before TARGETS whenever both are held.
fn targets() -> std::sync::MutexGuard<'static, HashMap<String, Target>> {
    TARGETS.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The key this generation's agent will carry, so a send can wait for exactly that agent.
fn expect(session_id: &str, generation: u64, key: &str) {
    if let Some(target) = targets().get_mut(session_id).filter(|target| target.generation == generation) {
        target.key = Some(key.to_owned());
    }
    changed();
}

fn current(session_id: &str, generation: u64) -> bool {
    targets().get(session_id).is_some_and(|target| target.generation == generation)
}

/// Forget a task's prewarm inputs unless a newer prewarm has replaced them.
fn forget(session_id: &str, generation: u64) {
    let mut targets = targets();
    if targets.get(session_id).is_some_and(|target| target.generation == generation) {
        targets.remove(session_id);
    }
    drop(targets);
    changed();
}

/// Record a prewarm's inputs as the task's newest; returns its generation.
fn record(config: &RunConfig, tools: &[Value], approval_tools: &HashSet<String>, launch: u64) -> u64 {
    let generation = next_generation();
    let mut targets = targets();
    // "Start agents ahead" was turned off meanwhile: record nothing, so the start is dropped.
    if !start_ahead() {
        return generation;
    }
    targets.insert(
        config.session_id.clone(),
        Target { config: config.clone(), tools: tools.to_vec(), approval_tools: approval_tools.clone(), launch, generation, busy: true, key: None },
    );
    generation
}

/// Only plain Claude Code: key-based relays carry per-launch credentials.
pub fn supported(config: &RunConfig) -> bool {
    config.provider == "claude" && config.goal.is_none() && config.skill.is_none()
}

/// Everything that shapes the launch: the command line, the folder and the tool catalog.
pub(super) fn key(config: &RunConfig, tools: &[Value]) -> String {
    key_with(config, tools, &crate::connections::warm_key(&config.session_id, &config.provider))
}

/// `connection` is the task's named connection and its revision, or empty for the global setup.
fn key_with(config: &RunConfig, tools: &[Value], connection: &str) -> String {
    let disabled = crate::skill_manager::disabled_for(&config.session_id);
    key_with_disabled(config, tools, connection, &disabled)
}

fn key_with_disabled(
    config: &RunConfig,
    tools: &[Value],
    connection: &str,
    disabled: &std::collections::BTreeSet<String>,
) -> String {
    json!({
        "namedConnection": connection,
        "provider": config.provider, "model": config.model, "effort": config.reasoning_effort,
        "fastMode": super::claude_fast_mode(config),
        "mode": config.mode, "cwd": config.cwd, "resume": config.resume_id,
        "instructions": config.instructions, "tools": tools,
        "disabledSkills": disabled,
        // The login a process starts with (API key or subscription) is fixed at spawn.
        "connection": format!("{:?}", crate::provider_settings::claude_connection_mode()),
        // A saved environment variable change starts the next turn cold.
        "environment": crate::provider_settings::environment_fingerprint(&config.provider),
        // So do the telemetry opt-outs (`privacy.rs`).
        "telemetryOff": super::privacy::telemetry_off(),
        // So does a saved executable location.
        "executable": crate::provider_settings::executable_override(&config.provider),
    })
    .to_string()
}

/// The spare launches with the instructions a cold launch would use (`run_inner` applies the
/// skill reminder before keying), so its key and its `--append-system-prompt` both match.
fn prepared(mut config: RunConfig, disabled: &std::collections::BTreeSet<String>) -> RunConfig {
    crate::skill_manager::apply_instructions(&mut config, disabled);
    config
}

/// The spare's launch as it will run, its key, and the switched-off skills it was keyed with.
pub(super) fn keyed(mut config: RunConfig, tools: &[Value]) -> (RunConfig, String, std::collections::BTreeSet<String>) {
    config.cwd = external_path(&config.cwd);
    let disabled = crate::skill_manager::disabled_for(&config.session_id);
    let config = prepared(config, &disabled);
    let key = key_with_disabled(&config, tools, &crate::connections::warm_key(&config.session_id, &config.provider), &disabled);
    (config, key, disabled)
}

/// Every launch of the task counts, with or without a spare to adopt. It makes the task's
/// recorded Claude inputs and idle Claude agent stale (the launch may be another harness's,
/// or a skill or goal turn): they go now rather than idling.
pub(super) fn launched(session_id: &str) {
    *LAUNCHES.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).entry(session_id.to_owned()).or_default() += 1;
    spares().remove(session_id);
    targets().remove(session_id);
    changed();
}

/// The task has a Claude agent waiting, recorded inputs (an agent starting or switching), or a
/// first start debouncing.
pub(super) fn present(session_id: &str) -> bool {
    spares().contains_key(session_id) || targets().get(session_id).is_some_and(|target| target.busy) || pending_ticket(session_id)
}

/// A debounced first start, if its ticket is still the newest. It records its inputs before
/// releasing the ticket, so a waiting send always sees one or the other, and a newer pick
/// always records (and wins) after this one.
pub async fn prewarm_reserved(ticket: u64, config: RunConfig, tools: Vec<Value>, approval_tools: HashSet<String>, launch: u64) -> Result<(), String> {
    let session_id = config.session_id.clone();
    if !reserved(&session_id, ticket) || !supported(&config) {
        release(&session_id, ticket);
        return Ok(());
    }
    let generation = record(&config, &tools, &approval_tools, launch);
    release(&session_id, ticket);
    start(config, tools, approval_tools, launch, generation).await
}

/// The task's warm agent for exactly this launch. One still starting or switching for it (or a
/// first start still debouncing) is waited for until it is ready, has failed, or `GRACE` has
/// passed (longer for one already being spawned or switched). Any other warm agent for the
/// task is discarded.
pub(super) async fn take(session_id: &str, key: &str) -> Option<Spare> {
    hurry(session_id);
    wait_while(tokio::time::Instant::now() + GRACE, || starting(session_id, key)).await;
    // An agent whose process is being spawned, or which is being switched, is never slower
    // than a cold start: wait for it up to the switch's own bound.
    if starting(session_id, key) && (spawning(session_id) || switch::in_flight(session_id)) {
        wait_while(tokio::time::Instant::now() + switch::SPAWN, || starting(session_id, key)).await;
    }
    let spare = spares().remove(session_id);
    launched(session_id);
    let mut spare = spare?;
    let alive = matches!(spare.child.try_wait(), Ok(None));
    match miss(alive, &spare.key, key, spare.born.elapsed()) {
        None => Some(spare),
        Some(reason) => {
            // A miss costs the CLI's whole startup; say why so slow turns can be traced.
            eprintln!("Warm Claude agent not used ({reason}); starting cold.");
            None
        }
    }
}

/// No ready agent has this key yet, but one that may is on its way.
fn starting(session_id: &str, key: &str) -> bool {
    if spares().get(session_id).is_some_and(|spare| spare.key == key) {
        return false;
    }
    if reservations().contains_key(session_id) {
        return true;
    }
    targets()
        .get(session_id)
        .is_some_and(|target| target.busy && target.key.as_deref().is_none_or(|expected| expected == key))
}

/// Why a warm agent cannot take this launch, if it cannot.
pub(super) fn miss(alive: bool, spare_key: &str, key: &str, age: Duration) -> Option<String> {
    if !alive {
        return Some("its process exited".into());
    }
    if age >= IDLE {
        return Some("it expired".into());
    }
    if spare_key == key {
        return None;
    }
    let (Ok(Value::Object(spare)), Ok(Value::Object(next))) = (serde_json::from_str::<Value>(spare_key), serde_json::from_str::<Value>(key)) else {
        return Some("its launch changed".into());
    };
    let changed: Vec<&str> = next.iter().filter(|(field, value)| spare.get(*field) != Some(value)).map(|(field, _)| field.as_str()).collect();
    Some(format!("changed: {}", changed.join(", ")))
}

/// Another harness's agent is starting for the task: its Claude agent goes (one spare per
/// task). Its inputs stay, so switching back to Claude starts a new one.
pub(super) fn other_start(session_id: &str) {
    spares().remove(session_id);
    changed();
}

/// Drop every task's agent, inputs and pending start.
pub(super) fn discard_all() {
    spares().clear();
    targets().clear();
    reservations().clear();
    changed();
}

/// Drop a task's warm agent (its folder changed, or it was deleted).
pub fn discard(session_id: &str) {
    spares().remove(session_id);
    targets().remove(session_id);
    reservations().remove(session_id);
    changed();
}

/// Start the next turn's agent for a task. `tools` is the catalog its last turn used; the
/// placeholder server answers the agent's startup listing and is rebound on adoption.
pub async fn prewarm(config: RunConfig, tools: Vec<Value>, approval_tools: HashSet<String>, launch: u64) -> Result<(), String> {
    if !supported(&config) {
        return Ok(());
    }
    let generation = record(&config, &tools, &approval_tools, launch);
    start(config, tools, approval_tools, launch, generation).await
}

/// Key the launch (its skill scan and settings are read off the runtime) and start it.
async fn start(config: RunConfig, tools: Vec<Value>, approval_tools: HashSet<String>, launch: u64, generation: u64) -> Result<(), String> {
    // A Claude start begins: the task's Codex or ACP spare goes (one spare per task).
    super::handshake_warm::other_start(&config.session_id);
    let (session_id, catalog) = (config.session_id.clone(), tools.clone());
    let prepared = crate::blocking(move || Ok(keyed(config, &catalog))).await;
    let result = match prepared {
        Ok(prepared) => spawn_spare(prepared, tools, approval_tools, launch, generation).await,
        Err(error) => Err(error),
    };
    if let Err(error) = &result {
        forget(&session_id, generation);
        eprintln!("Could not prepare a warm Claude agent: {error}");
    }
    result
}

/// `prepared` is the launch as it will run, its key and its switched-off skills (`keyed`),
/// computed once by the caller.
async fn spawn_spare(
    prepared: (RunConfig, String, std::collections::BTreeSet<String>),
    tools: Vec<Value>,
    approval_tools: HashSet<String>,
    launch: u64,
    generation: u64,
) -> Result<(), String> {
    let (config, key, disabled) = prepared;
    expect(&config.session_id, generation, &key);
    // A switch landing meanwhile waits for this agent instead of spawning another.
    let _spawning = Spawning::mark(&config.session_id);
    let connection = crate::connections::for_task(&config.session_id, &config.provider)
        .map(|connection| crate::connections::launch(&connection))
        .transpose()?;
    let path = connection
        .as_ref()
        .and_then(|connection| connection.executable.clone())
        .or_else(|| executable(&config.provider))
        .ok_or("Claude Code is not installed")?;
    let mut command = command(&path)?;
    crate::provider_settings::apply_environment(&config.provider, &mut command);
    configure_command_with_skills(&mut command, &config, &disabled);
    if let Some(connection) = &connection {
        connection.apply(&mut command);
    }
    let server = if tools.is_empty() {
        None
    } else {
        let placeholder = ToolHost {
            tools,
            approval_tools,
            handler: Arc::new(|_, _| Box::pin(async { Err("This turn has not started yet.".to_string()) })),
        };
        let sink: Sink = Arc::new(|_| {});
        let server = mcp_host::Server::start_with_approvals(placeholder, config.session_id.clone(), sink, &config.mode).await?;
        command.args(["--mcp-config", &server.claude_config().to_string()]);
        Some(server)
    };
    command
        .current_dir(&config.cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    let child = command.spawn().map_err(|e| format!("Could not start Claude Code: {e}"))?;
    let group = ProcessGroup::register(child.id());
    let born = std::time::Instant::now();
    let session_id = config.session_id.clone();
    if !adopt(Spare { key, child, group, server, born, generation, pending: Vec::new(), unanswered: HashSet::new() }, &session_id, launch) {
        return Ok(());
    }
    tokio::spawn(async move {
        tokio::time::sleep(IDLE).await;
        let mut spares = spares();
        // A switched agent keeps its birth time but carries a newer generation.
        if let Some(generation) = spares.get(&session_id).filter(|spare| spare.born == born).map(|spare| spare.generation) {
            spares.remove(&session_id);
            forget(&session_id, generation);
        }
    });
    Ok(())
}

/// Store a freshly started (or switched) spare if it is still wanted; otherwise dropping it
/// kills its process.
fn adopt(spare: Spare, session_id: &str, launch: u64) -> bool {
    let kept = keep(spare, session_id, launch);
    changed();
    if kept {
        super::limit_spares();
    }
    kept
}

fn keep(spare: Spare, session_id: &str, launch: u64) -> bool {
    let mut spares = spares();
    // "Start agents ahead" was turned off while it started: nothing may stay running.
    if !start_ahead() {
        forget(session_id, spare.generation);
        return false;
    }
    // The next turn already started (a team review, a queued message): this spare would
    // carry an outdated conversation.
    if epoch(session_id) != launch {
        forget(session_id, spare.generation);
        return false;
    }
    // A newer retarget or prewarm owns the task's spare now: the latest settings win. An agent
    // superseded mid-switch is still kept while the slot is empty, so the newer switch can
    // switch it again instead of starting another CLI; anything newer replaces it.
    if !current(session_id, spare.generation) {
        // Only while a newer generation is on its way (not after a discard).
        if spares.contains_key(session_id) || !targets().contains_key(session_id) {
            return false;
        }
        spares.insert(session_id.to_owned(), spare);
        return true;
    }
    if let Some(target) = targets().get_mut(session_id) {
        target.busy = false;
    }
    spares.insert(session_id.to_owned(), spare);
    true
}

/// When each idle agent started, for the shared limit.
pub(super) fn births() -> Vec<(std::time::Instant, String)> {
    spares().iter().map(|(id, spare)| (spare.born, id.clone())).collect()
}

/// Drop the task's idle agent if it is still the one born then; dropping kills its process.
pub(super) fn evict(session_id: &str, born: std::time::Instant) {
    let mut spares = spares();
    if spares.get(session_id).is_some_and(|spare| spare.born == born) {
        if let Some(spare) = spares.remove(session_id) {
            forget(session_id, spare.generation);
        }
    }
}

#[cfg(all(test, unix))]
pub(super) fn insert_for_test(session_id: &str, key: &str, child: Child, group: ProcessGroup) {
    let spare = Spare { key: key.into(), child, group, server: None, born: std::time::Instant::now(), generation: 0, pending: Vec::new(), unanswered: HashSet::new() };
    spares().insert(session_id.into(), spare);
}

#[cfg(test)]
pub(super) fn record_for_test(config: &RunConfig) {
    record(config, &[], &HashSet::new(), epoch(&config.session_id));
}

#[cfg(test)]
pub(super) fn waiting(session_id: &str) -> bool {
    spares().contains_key(session_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skill_manager_disabled_skills_invalidate_a_warm_launch() {
        let config = crate::providers::tests::config("claude");
        let none = std::collections::BTreeSet::new();
        let disabled = std::collections::BTreeSet::from(["alpha".into()]);
        assert_ne!(
            key_with_disabled(&config, &[], "", &none),
            key_with_disabled(&config, &[], "", &disabled)
        );
    }

    #[test]
    fn skill_manager_warm_spare_applies_the_same_skill_instructions_as_a_cold_launch() {
        let disabled = std::collections::BTreeSet::from(["Friendly skill".into()]);
        let base = crate::providers::tests::config("claude");
        // Cold path: run_inner applies the reminder, then keys the launch.
        let mut cold = base.clone();
        crate::skill_manager::apply_instructions(&mut cold, &disabled);
        let spare = prepared(base.clone(), &disabled);
        assert!(spare.instructions.contains("Friendly skill"));
        assert_eq!(
            key_with_disabled(&spare, &[], "", &disabled),
            key_with_disabled(&cold, &[], "", &disabled)
        );
        // Applying twice (spare prepared, then adopted by run_inner) changes nothing.
        assert_eq!(
            prepared(spare.clone(), &disabled).instructions,
            spare.instructions
        );
        let mut command = Command::new("claude");
        configure_command_with_skills(&mut command, &spare, &disabled);
        let args: Vec<_> = command
            .as_std()
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert!(args
            .windows(2)
            .any(|a| a[0] == "--append-system-prompt" && a[1].contains("Friendly skill")));
    }

    #[test]
    fn a_warm_agent_is_used_only_for_the_exact_launch_it_was_started_for() {
        let base = crate::providers::tests::config("claude");
        let tools = vec![json!({"type":"function","name":"pandacode_title"})];
        let original = key(&base, &tools);
        assert_eq!(original, key(&base.clone(), &tools));
        let changed = |edit: fn(&mut RunConfig)| { let mut config = base.clone(); edit(&mut config); key(&config, &tools) };
        for different in [
            changed(|c| c.model = "claude-sonnet-5-5".into()),
            changed(|c| c.mode = "full".into()),
            changed(|c| c.reasoning_effort = Some("high".into())),
            changed(|c| c.codex_settings = Some(json!({"serviceTier": "fast"}))),
            changed(|c| c.resume_id = Some("another".into())),
            changed(|c| c.instructions = "new".into()),
            key(&base, &[]),
            key_with(&base, &tools, "work#1"),
        ] {
            assert_ne!(different, original);
        }
        // A spare started before the telemetry switch changed is never adopted.
        super::super::privacy::FORCE.with(|force| force.set(Some(true)));
        assert_ne!(key(&base, &tools), original);
        super::super::privacy::FORCE.with(|force| force.set(None));
        // A different named connection, or a saved change to the same one, starts cold.
        for different in [key_with(&base, &tools, "personal#1"), key_with(&base, &tools, "work#2")] {
            assert_ne!(different, key_with(&base, &tools, "work#1"));
        }
        // Relays, goals and skills always start cold.
        assert!(supported(&base));
        for relay in ["glm", "mimo", "alibaba"] {
            assert!(!supported(&crate::providers::tests::config(relay)), "{relay}");
        }
        assert!(!supported(&RunConfig { skill: Some(("review".into(), PathBuf::from("/skills/review"))), ..base.clone() }));
    }

    #[test]
    fn a_missed_warm_agent_names_what_changed() {
        let base = crate::providers::tests::config("claude");
        let original = key(&base, &[]);
        let fresh = Duration::from_secs(1);
        assert_eq!(miss(true, &original, &original, fresh), None);
        assert_eq!(miss(false, &original, &original, fresh).as_deref(), Some("its process exited"));
        assert_eq!(miss(true, &original, &original, IDLE).as_deref(), Some("it expired"));
        let next = key(&RunConfig { resume_id: Some("another".into()), model: "claude-sonnet-5-5".into(), ..base.clone() }, &[]);
        assert_eq!(miss(true, &original, &next, fresh).as_deref(), Some("changed: model, resume"));
    }

    #[cfg(unix)]
    fn sleeper() -> (Child, ProcessGroup) {
        let child = Command::new("sleep").arg("30").kill_on_drop(true).spawn().unwrap();
        (child, ProcessGroup::register(None))
    }

    #[cfg(unix)]
    fn spare(key: String, generation: u64, (child, group): (Child, ProcessGroup)) -> Spare {
        Spare { key, child, group, server: None, born: std::time::Instant::now(), generation, pending: Vec::new(), unanswered: HashSet::new() }
    }

    /// The launch `lib.rs` and `run_inner` build for a send: settings from the task row,
    /// empty instructions, then the switched-off skills and the reminder, then the folder.
    pub(super) fn cold_key(row: &RunConfig, prompt: &str, tools: &[Value]) -> String {
        let mut config = RunConfig { prompt: prompt.into(), instructions: String::new(), ..row.clone() };
        let disabled = crate::skill_manager::launch_disabled(&config.provider, &config.cwd, crate::skill_manager::disabled_for(&config.session_id));
        crate::skill_manager::prepare_turn(&mut config, &disabled).unwrap();
        config.cwd = external_path(&config.cwd);
        key(&config, tools)
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn another_harness_launch_drops_the_claude_agent_and_its_inputs_at_once() {
        let base = RunConfig { session_id: "warm-other-launch".into(), ..crate::providers::tests::config("claude") };
        let launch = epoch(&base.session_id);
        let generation = record(&base, &[], &HashSet::new(), launch);
        assert!(adopt(spare(key(&base, &[]), generation, sleeper()), &base.session_id, launch));
        // A Codex (or skill, or goal) turn launches without taking the spare.
        launched(&base.session_id);
        assert!(!waiting(&base.session_id), "no idle agent left for ten minutes");
        assert!(!targets().contains_key(&base.session_id));
        // So switching back reports nothing retargeted: `rewarm` then starts afresh.
        assert!(retargeted(&base.session_id, |c| c.model = "claude-opus-5-5".into()).is_none());
    }

    #[tokio::test]
    async fn rapid_first_picks_start_only_the_latest() {
        let config = RunConfig { session_id: "warm-first-picks".into(), provider: "kimi".into(), ..crate::providers::tests::config("claude") };
        let first = reserve(&config.session_id);
        let latest = reserve(&config.session_id);
        assert!(!reserved(&config.session_id, first) && reserved(&config.session_id, latest));
        // The superseded pick starts nothing and leaves the latest ticket alone.
        prewarm_reserved(first, config.clone(), Vec::new(), HashSet::new(), 0).await.unwrap();
        assert!(reserved(&config.session_id, latest), "the stale pick did not use the latest ticket");
        prewarm_reserved(latest, config.clone(), Vec::new(), HashSet::new(), 0).await.unwrap();
        assert!(!reserved(&config.session_id, latest), "the latest pick's start is over");
        // A send cancels a pending pick.
        let pending = reserve(&config.session_id);
        launch_settled(&config.session_id);
        assert!(!reserved(&config.session_id, pending));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_send_during_the_debounce_ends_it_and_adopts_the_agent_as_it_starts() {
        let base = RunConfig { session_id: "warm-debounce-send".into(), ..crate::providers::tests::config("claude") };
        let (id, wanted) = (base.session_id.clone(), key(&base, &[]));
        let launch = epoch(&id);
        // `plan_rewarm` reserved a ticket; the switch's debounce is running.
        let ticket = reserve(&id);
        let (config, ready) = (base.clone(), wanted.clone());
        let rewarm = tokio::spawn(async move {
            debounce(&config.session_id).await;
            // What `prewarm_reserved` and `spawn_spare` do, with a stand-in process.
            let generation = record(&config, &[], &HashSet::new(), launch);
            release(&config.session_id, ticket);
            expect(&config.session_id, generation, &ready);
            assert!(adopt(spare(ready, generation, sleeper()), &config.session_id, launch));
        });
        let started = std::time::Instant::now();
        let mut adopted = take(&id, &wanted).await.expect("the debounced agent is adopted, not a second cold one");
        assert!(started.elapsed() < DEBOUNCE, "the send ended the debounce early");
        rewarm.await.unwrap();
        adopted.child.kill().await.unwrap();
        launch_settled(&id);
        // A first start abandoned during the debounce (nothing to warm) does not hold a send.
        let ticket = reserve(&id);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            release("warm-debounce-send", ticket);
        });
        let started = std::time::Instant::now();
        assert!(take(&id, &wanted).await.is_none());
        assert!(started.elapsed() < Duration::from_secs(1));
        launch_settled(&id);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn turning_start_ahead_off_drops_a_claude_start_in_flight() {
        let base = RunConfig { session_id: "warm-off-in-flight".into(), ..crate::providers::tests::config("claude") };
        let launch = epoch(&base.session_id);
        let generation = record(&base, &[], &HashSet::new(), launch);
        // Turned off while the CLI was spawning: the finished agent is not kept.
        crate::provider_settings::START_AHEAD_FORCE.with(|force| force.set(Some(false)));
        assert!(!adopt(spare(key(&base, &[]), generation, sleeper()), &base.session_id, launch));
        assert!(!waiting(&base.session_id) && !targets().contains_key(&base.session_id));
        // Nor is a new start recorded.
        record(&base, &[], &HashSet::new(), launch);
        assert!(!targets().contains_key(&base.session_id));
        crate::provider_settings::START_AHEAD_FORCE.with(|force| force.set(None));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_send_waits_for_the_warm_agent_that_is_still_starting() {
        let base = RunConfig { session_id: "warm-starting".into(), ..crate::providers::tests::config("claude") };
        let launch = epoch(&base.session_id);
        let generation = record(&base, &[], &HashSet::new(), launch);
        let wanted = key(&base, &[]);
        let ready = wanted.clone();
        // Ready within the grace: the send adopts it, woken as it lands.
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(1000)).await;
            expect("warm-starting", generation, &ready);
            assert!(adopt(spare(ready, generation, sleeper()), "warm-starting", launch));
        });
        let started = std::time::Instant::now();
        let mut adopted = take(&base.session_id, &wanted).await.expect("the starting agent is adopted");
        assert!(started.elapsed() < Duration::from_millis(1400), "no polling delay after it is ready");
        adopted.child.kill().await.unwrap();
        launch_settled(&base.session_id);
        // One that never gets ready costs the send the grace, not more: it starts cold, and
        // the late agent is turned away.
        let launch = epoch(&base.session_id);
        let generation = record(&base, &[], &HashSet::new(), launch);
        let started = std::time::Instant::now();
        assert!(take(&base.session_id, &wanted).await.is_none());
        let waited = started.elapsed();
        assert!(waited >= GRACE && waited < GRACE + Duration::from_millis(400), "{waited:?}");
        assert!(!adopt(spare(wanted.clone(), generation, sleeper()), &base.session_id, launch));
        launch_settled(&base.session_id);
        // A start that fails ends the wait at once: the send goes cold without the full bound.
        let generation = record(&base, &[], &HashSet::new(), epoch(&base.session_id));
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            forget("warm-starting", generation);
        });
        let started = std::time::Instant::now();
        assert!(take(&base.session_id, &wanted).await.is_none());
        assert!(started.elapsed() < Duration::from_secs(1));
        launch_settled(&base.session_id);
        // A starting agent for other settings is not worth waiting for.
        let generation = record(&base, &[], &HashSet::new(), epoch(&base.session_id));
        expect(&base.session_id, generation, "other settings");
        let started = std::time::Instant::now();
        assert!(take(&base.session_id, &wanted).await.is_none());
        assert!(started.elapsed() < Duration::from_millis(500));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_mismatched_or_exited_warm_agent_is_discarded() {
        spares().insert("warm-test".into(), spare("launch-a".into(), 0, sleeper()));
        assert!(take("warm-test", "launch-b").await.is_none(), "a different launch starts cold");
        assert!(!waiting("warm-test"), "and the stale agent is gone");
        spares().insert("warm-test".into(), spare("launch-a".into(), 0, sleeper()));
        let mut adopted = take("warm-test", "launch-a").await.expect("the matching agent is adopted");
        adopted.child.kill().await.unwrap();
        let (mut child, group) = sleeper();
        child.kill().await.unwrap();
        child.wait().await.unwrap();
        spares().insert("warm-test".into(), spare("launch-a".into(), 0, (child, group)));
        assert!(take("warm-test", "launch-a").await.is_none(), "an agent that exited is never adopted");
        discard("warm-test");
    }
}
