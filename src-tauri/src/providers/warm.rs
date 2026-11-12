//! Warm agents: after a Claude turn ends, the next turn's process starts in the background
//! so a follow-up skips the CLI's own startup (about 1.4 s). A warm agent is adopted only
//! when everything on its command line and in its tool catalog still matches; otherwise it
//! is discarded and the turn starts cold as before.
use super::*;
use std::sync::LazyLock;

/// A warm agent waits at most this long for its follow-up.
const IDLE: Duration = Duration::from_secs(10 * 60);
/// Each one holds an idle CLI process, so only the most recent tasks keep one.
const LIMIT: usize = 2;
/// Team leads waiting on workers keep their spare in a pool of their own (one per team, keyed
/// by the lead's task), so ordinary tasks never evict it; the total stays `LIMIT + LEAD_LIMIT`.
const LEAD_LIMIT: usize = 2;
/// An expired lead spare is started again at most this many times in a row, so one lead holds
/// an idle CLI process for at most `(1 + MAX_RENEWALS) × IDLE` (30 minutes). Each spare is a
/// whole idle Claude Code process (about 178–208 MB resident in two probes on one machine,
/// docs/worker-tokens.md), so the chain stays short.
const MAX_RENEWALS: u32 = 2;

/// Whether a lead is still waiting on its workers, asked once when its spare expires. There is
/// no timer beyond that: one "no" (a worker waiting on the user, the team settled or paused)
/// ends the renewals for good, even if the user answers a moment later.
pub type Renew = Arc<dyn Fn() -> bool + Send + Sync>;
/// What a launch's instructions and tool catalog are built from outside its `RunConfig` (the
/// explorer switch, the task's agent-made tools), read at spawn and again when a lead spare
/// expires: a renewal started on old inputs could never be adopted.
type Inputs = Arc<dyn Fn() -> String + Send + Sync>;
type Starting = std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send>>;
/// A started process for a spare: its warm key, the child, its group and its tool server.
type Spawned = (String, Child, ProcessGroup, Option<mcp_host::Server>);
type Spawning = std::pin::Pin<Box<dyn std::future::Future<Output = Result<Option<Spawned>, String>> + Send>>;

/// How spares start, how long each waits and which pool keeps them: Claude Code, `IDLE` and
/// the app's one pool, or a stub with a pool of its own in tests (so tests running in parallel
/// never evict each other's spares).
#[derive(Clone, Copy)]
struct Lifecycle {
    idle: Duration,
    /// Starts the process for a launch, or `None` when this launch takes no spare.
    spawn: fn(RunConfig, Vec<Value>, HashSet<String>) -> Spawning,
    /// Whether a renewal's launch inputs still give the expired spare's key and the inputs
    /// read at its spawn (`still_current`).
    current: fn(&str, &RunConfig, &[Value], &str, &Inputs) -> bool,
    pool: &'static Pool,
}

fn claude() -> Lifecycle {
    Lifecycle { idle: IDLE, spawn: spawn_claude, current: still_current, pool: &SPARES }
}

pub(super) struct Spare {
    key: String,
    pub(super) child: Child,
    pub(super) group: ProcessGroup,
    pub(super) server: Option<mcp_host::Server>,
    born: std::time::Instant,
    /// How long it may wait: its lifecycle's `idle`.
    idle: Duration,
    /// Started for a team lead waiting on its workers (the lead pool).
    lead: bool,
}

/// The idle spares by task, and why each task's last lead spare left the pool without being
/// adopted (so the adoption log can say why a lead's wake started cold).
#[derive(Default)]
struct Spares {
    spares: HashMap<String, Spare>,
    gone: HashMap<String, Gone>,
    /// Lead wakes that adopted their spare, and those that found one unusable or gone, since
    /// launch: in memory only, read from the adoption log line (docs/worker-tokens.md).
    lead_adopted: u64,
    lead_missed: u64,
}

type Pool = Mutex<Spares>;

/// Why a lead spare left the pool before its wake.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Gone {
    /// A newer lead spare pushed it out of the bounded lead pool.
    Evicted,
    /// Its team stopped or paused, or its task was deleted.
    Discarded,
    /// It waited `IDLE` (and was not renewed, or its renewal has not registered yet).
    Expired,
    /// A newer spare for the same task took its place.
    Replaced,
}

impl Gone {
    fn reason(self) -> &'static str {
        match self {
            Gone::Evicted => "it was evicted by a newer team's spare",
            Gone::Discarded => "it was discarded",
            Gone::Expired => "it expired",
            Gone::Replaced => "it was replaced by a newer spare for the same task",
        }
    }
}

/// `gone` keeps at most this many reasons (tasks deleted with a reason pending never read it).
const GONE_LIMIT: usize = 64;

impl Spares {
    fn remove(&mut self, session_id: &str, why: Gone) -> Option<Spare> {
        let spare = self.spares.remove(session_id)?;
        if spare.lead {
            if self.gone.len() >= GONE_LIMIT {
                self.gone.clear();
            }
            self.gone.insert(session_id.to_owned(), why);
        }
        Some(spare)
    }
}

static SPARES: LazyLock<Pool> = LazyLock::new(Pool::default);
/// Each task's latest Claude launch, numbered from one app-wide sequence (`NEXT_LAUNCH`) so a
/// forgotten task's number never comes back. A spare started for launch N is useless once a
/// later launch has begun: it would resume the conversation without that turn.
static NEXT_LAUNCH: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
static LAUNCHES: LazyLock<Mutex<HashMap<String, u64>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// The task's current launch count, read when a turn ends and before the next can begin.
pub fn epoch(session_id: &str) -> u64 {
    LAUNCHES.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).get(session_id).copied().unwrap_or(0)
}

fn spares(pool: &Pool) -> std::sync::MutexGuard<'_, Spares> {
    pool.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
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
    json!({
        "namedConnection": connection,
        "provider": config.provider, "model": config.model, "effort": config.reasoning_effort,
        "mode": config.mode, "cwd": config.cwd, "resume": config.resume_id,
        "instructions": config.instructions, "tools": tools,
        // A team worker's tool trim (read-only, skills) is on its command line.
        "worker": config.worker,
        // The deny set read once per turn from the conversation's history (`lib.rs`), so a
        // spare launched with another `--disallowedTools` is never adopted.
        "disallowedTools": config.disallowed_tools,
        // The login a process starts with (API key or subscription) is fixed at spawn.
        "connection": format!("{:?}", crate::provider_settings::claude_connection_mode()),
        // A saved environment variable change starts the next turn cold.
        "environment": crate::provider_settings::environment_fingerprint(&config.provider),
        // So do the telemetry opt-outs (`privacy.rs`).
        "telemetryOff": super::privacy::telemetry_off(),
    })
    .to_string()
}

/// The warm agent for this turn, if one exists, is still running and was started for
/// exactly this launch. Any other warm agent for the task is discarded.
/// Every launch of the task counts, with or without a spare to adopt.
pub(crate) fn launched(session_id: &str) {
    let launch = NEXT_LAUNCH.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    LAUNCHES.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).insert(session_id.to_owned(), launch);
}

pub(super) fn take(session_id: &str, key: &str) -> Option<Spare> {
    let (spare, note) = take_in(&SPARES, session_id, key);
    // A miss costs the CLI's whole startup; say why so slow turns can be traced. Every lead
    // spare's hit and miss is logged too, so the lead pool's speed-up can be measured.
    if let Some(note) = note {
        eprintln!("{note}");
    }
    spare
}

/// The spare this launch adopts, if any, and what to log about it (never any contents: only
/// the outcome and the names of warm-key fields that changed).
fn take_in(pool: &Pool, session_id: &str, key: &str) -> (Option<Spare>, Option<String>) {
    launched(session_id);
    let (spare, gone) = {
        let mut pool = spares(pool);
        let gone = pool.gone.remove(session_id);
        (pool.spares.remove(session_id), gone)
    };
    let Some(mut spare) = spare else {
        return (None, gone.map(|why| lead_decision(pool, Some(why.reason()))));
    };
    let alive = matches!(spare.child.try_wait(), Ok(None));
    match miss(alive, &spare.key, key, spare.born.elapsed(), spare.idle) {
        None => {
            let note = spare.lead.then(|| lead_decision(pool, None));
            (Some(spare), note)
        }
        Some(reason) if spare.lead => (None, Some(lead_decision(pool, Some(&reason)))),
        Some(reason) => (None, Some(format!("Warm Claude agent not used ({reason}); starting cold."))),
    }
}

/// A lead wake's adoption log line (`lead_note`), counted, with the pool's totals since launch.
fn lead_decision(pool: &Pool, miss: Option<&str>) -> String {
    let (adopted, missed) = {
        let mut pool = spares(pool);
        if miss.is_none() { pool.lead_adopted += 1 } else { pool.lead_missed += 1 }
        (pool.lead_adopted, pool.lead_missed)
    };
    format!("{} Lead spares since launch: {adopted} adopted, {missed} not used.", lead_note(miss))
}

/// A lead spare's adoption log line: adopted (`None`) or why its wake starts cold.
fn lead_note(miss: Option<&str>) -> String {
    match miss {
        None => "Team lead's warm Claude agent adopted.".into(),
        Some(reason) => format!("Team lead's warm Claude agent not used ({reason}); starting cold."),
    }
}

/// Why a warm agent cannot take this launch, if it cannot.
fn miss(alive: bool, spare_key: &str, key: &str, age: Duration, idle: Duration) -> Option<String> {
    if !alive {
        return Some("its process exited".into());
    }
    if age >= idle {
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

/// Drop a task's warm agent (its team stopped or paused, the task was deleted, or its model or
/// mode changed: `update_session` in `lib.rs` calls this so a lead's spare cannot renew on the
/// old launch until its next wake; an ordinary spare would already miss on its key). It also forgets the task's launch number (so a deleted task leaves nothing
/// behind): a spare (or a lead's renewal) still starting for the old launch, numbered at least 1,
/// never matches the forgotten 0 and is dropped instead of idling for `IDLE`.
pub fn discard(session_id: &str) {
    discard_in(&SPARES, session_id);
}

fn discard_in(pool: &Pool, session_id: &str) {
    LAUNCHES.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).remove(session_id);
    // Dropping the spare kills its process (outside the lock).
    let dropped = spares(pool).remove(session_id, Gone::Discarded);
    drop(dropped);
}

/// Start the next turn's agent for a task. `tools` is the catalog its last turn used; the
/// placeholder server answers the agent's startup listing and is rebound on adoption.
/// `renew` marks a team lead waiting on its workers: its spare joins the lead pool and, if
/// `renew` holds at the moment it expires and no turn has launched, starts once more (see
/// `Renew`: a "no" at an expiry ends the chain). `inputs` reads what the launch was built from
/// outside `config` (`Inputs`); it is called only for a lead's spare.
pub async fn prewarm(config: RunConfig, tools: Vec<Value>, approval_tools: HashSet<String>, launch: u64, renew: Option<Renew>, inputs: impl Fn() -> String + Send + Sync + 'static) -> Result<(), String> {
    start(claude(), config, tools, approval_tools, launch, renew.map(|renew| (renew, Arc::new(inputs) as Inputs)), 0).await
}

/// Whether an expired spare starts again: only a lead's, while its team still waits, before
/// its wake launched, while its launch inputs are unchanged (`current` is false once a setting
/// in its warm key changed, so it could never be adopted), and at most `MAX_RENEWALS` times.
/// Called once per expiry, never again for the same chain.
fn renews(renew: Option<&Renew>, launch: u64, epoch: u64, renewals: u32, current: bool) -> bool {
    renewals < MAX_RENEWALS && epoch == launch && current && renew.is_some_and(|waiting| waiting())
}

/// Whether a renewal would start with the same warm key as the spare that expired: the
/// settings read at spawn (environment, login, telemetry, named connection) are read again,
/// and so are the explorer switch and agent-made tools behind its instructions and catalog
/// (`inputs`, compared with `spawned`, what it read at the spare's spawn).
fn still_current(spare_key: &str, config: &RunConfig, tools: &[Value], spawned: &str, inputs: &Inputs) -> bool {
    let mut config = config.clone();
    config.cwd = external_path(&config.cwd);
    key(&config, tools) == spare_key && inputs() == spawned
}

/// A lead's renewal check with the inputs its spare was started on.
type Lead = (Renew, Inputs);

/// Boxed so the expiry timer can start the next spare (async recursion).
fn start(life: Lifecycle, config: RunConfig, tools: Vec<Value>, approval_tools: HashSet<String>, launch: u64, renew: Option<Lead>, renewals: u32) -> Starting {
    Box::pin(async move {
        let result = spawn_spare(life, config, tools, approval_tools, launch, renew, renewals).await;
        if let Err(error) = &result {
            eprintln!("{}", failure_note(renewals, error));
        }
        result
    })
}

/// What a failed start logs; a lead's renewal says which one, so a lost spare can be traced.
fn failure_note(renewals: u32, error: &str) -> String {
    if renewals == 0 {
        format!("Could not prepare a warm Claude agent: {error}")
    } else {
        format!("Could not renew the team lead's warm Claude agent (renewal {renewals} of {MAX_RENEWALS}): {error}")
    }
}

/// Starts a spare's process and keeps it until it is adopted, replaced or expires; an expired
/// lead spare may start again (`renews`).
async fn spawn_spare(life: Lifecycle, config: RunConfig, tools: Vec<Value>, approval_tools: HashSet<String>, launch: u64, renew: Option<Lead>, renewals: u32) -> Result<(), String> {
    // What a renewal starts again with, unchanged: no turn launched in between.
    // `inputs` reads files, so on a blocking thread.
    let renewal = match renew {
        Some((renew, inputs)) => {
            let read = inputs.clone();
            let spawned = tokio::task::spawn_blocking(move || read()).await.map_err(|error| format!("Could not read the launch inputs: {error}"))?;
            Some((renew, inputs, spawned, config.clone(), tools.clone(), approval_tools.clone()))
        }
        None => None,
    };
    let session_id = config.session_id.clone();
    let Some((key, child, group, server)) = (life.spawn)(config, tools, approval_tools).await? else { return Ok(()) };
    let spare_key = key.clone();
    let born = std::time::Instant::now();
    if !register(life.pool, &session_id, launch, Spare { key, child, group, server, born, idle: life.idle, lead: renewal.is_some() }) {
        return Ok(());
    }
    tokio::spawn(async move {
        tokio::time::sleep(life.idle).await;
        // Dropping the expired spare kills its process (outside the lock).
        let expired = {
            let mut pool = spares(life.pool);
            if pool.spares.get(&session_id).is_some_and(|spare| spare.born == born) { pool.remove(&session_id, Gone::Expired) } else { None }
        };
        let Some(expired) = expired else { return };
        drop(expired);
        let Some((renew, inputs, spawned, config, tools, approvals)) = renewal else { return };
        // The check reads files (agent-made tools) and takes the store lock (`renew`), so it
        // runs on a blocking thread, never on the timer's runtime worker.
        let check = tokio::task::spawn_blocking(move || {
            let current = (life.current)(&spare_key, &config, &tools, &spawned, &inputs);
            if !current {
                eprintln!("{}", lead_note(Some("its launch settings changed; not renewed")));
            }
            let again = renews(Some(&renew), launch, epoch(&session_id), renewals, current);
            again.then_some((renew, inputs, config, tools, approvals))
        });
        if let Ok(Some((renew, inputs, config, tools, approvals))) = check.await {
            // `start` logs a failure with the renewal's number.
            let _ = start(life, config, tools, approvals, launch, Some((renew, inputs)), renewals + 1).await;
        }
    });
    Ok(())
}

/// Claude Code's process for a spare, with a placeholder tool server; `None` for a launch
/// that takes no spare (`supported`).
fn spawn_claude(config: RunConfig, tools: Vec<Value>, approval_tools: HashSet<String>) -> Spawning {
    Box::pin(spawn_claude_process(config, tools, approval_tools))
}

async fn spawn_claude_process(mut config: RunConfig, tools: Vec<Value>, approval_tools: HashSet<String>) -> Result<Option<Spawned>, String> {
    if !supported(&config) {
        return Ok(None);
    }
    let connection = crate::connections::for_task(&config.session_id, &config.provider)
        .map(|connection| crate::connections::launch(&connection))
        .transpose()?;
    let path = connection
        .as_ref()
        .and_then(|connection| connection.executable.clone())
        .or_else(|| executable(&config.provider))
        .ok_or("Claude Code is not installed")?;
    config.cwd = external_path(&config.cwd);
    let key = key(&config, &tools);
    let mut command = command(&path)?;
    crate::provider_settings::apply_environment(&config.provider, &mut command);
    configure_command(&mut command, &config);
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
    Ok(Some((key, child, group, server)))
}

/// Keep a started spare, unless the task launched again (a team review, a queued message) or
/// its spare was discarded (settings changed, team stopped) since `launch`: it would carry an
/// outdated conversation, or wait for a turn that is not coming. Dropping it kills its process.
fn register(pool: &Pool, session_id: &str, launch: u64, spare: Spare) -> bool {
    let evicted = {
        let mut pool = spares(pool);
        if epoch(session_id) != launch {
            drop(pool);
            // Dropping the refused spare kills its process (outside the lock).
            drop(spare);
            return false;
        }
        admit(&mut pool, session_id.to_owned(), spare)
    };
    // Dropping the evicted spares kills their processes (outside the lock).
    drop(evicted);
    true
}

/// Add a spare, keeping only the newest few in its pool (ordinary or lead); returns the spares
/// it pushed out (including one it replaced for the same task), which the caller drops (killing their processes) after releasing the lock.
fn admit(pool: &mut Spares, session_id: String, spare: Spare) -> Vec<Spare> {
    let lead = spare.lead;
    let limit = if lead { LEAD_LIMIT } else { LIMIT };
    pool.gone.remove(&session_id);
    let mut evicted: Vec<Spare> = pool.remove(&session_id, Gone::Replaced).into_iter().collect();
    pool.spares.insert(session_id, spare);
    while pool.spares.values().filter(|spare| spare.lead == lead).count() > limit {
        let Some(oldest) = pool.spares.iter().filter(|(_, spare)| spare.lead == lead).min_by_key(|(_, spare)| spare.born).map(|(id, _)| id.clone()) else { break };
        evicted.extend(pool.remove(&oldest, Gone::Evicted));
    }
    evicted
}

#[cfg(test)]
fn waiting_in(pool: &Pool, session_id: &str) -> bool {
    spares(pool).spares.contains_key(session_id)
}

#[cfg(test)]
mod tests;
