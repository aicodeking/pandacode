//! Warm agents: after a Claude turn ends, the next turn's process starts in the background
//! so a follow-up skips the CLI's own startup (about 1.4 s). A warm agent is adopted only
//! when everything on its command line and in its tool catalog still matches; otherwise it
//! is discarded and the turn starts cold as before.
use super::exit::{pending_in_cwd, retire_parts_in_cwd, Pending};
use super::*;
use std::sync::LazyLock;

static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

pub(crate) fn init(app: &tauri::AppHandle) {
    let _ = APP.set(app.clone());
}

/// Default-on switch shared by the desktop app and headless host.
const WARM_SPARES_OFF_FILE: &str = "warm-spares-off";

/// Unreadable settings fail closed: no idle CLI or ahead-of-turn SessionStart hooks.
pub fn enabled(app: &tauri::AppHandle) -> bool {
    enabled_in(crate::app_marker::data_dir(app))
}

/// The one on/off decision, also exercised directly by the unit tests.
fn enabled_in(dir: Result<PathBuf, String>) -> bool {
    crate::app_marker::exists_in(dir, WARM_SPARES_OFF_FILE).is_ok_and(|present| !present)
}

#[cfg(test)]
thread_local! {
    static ENABLED_OVERRIDE: std::cell::Cell<Option<bool>> = const { std::cell::Cell::new(None) };
}

/// Provider launch paths have no handle argument; both app entry points initialize this handle.
/// Unreadable settings (or a missing handle in production) fail closed. Unit tests without an
/// app handle default to enabled so warm-pool and adoption tests run directly, unless overridden.
pub(super) fn enabled_now() -> bool {
    #[cfg(test)]
    if let Some(enabled) = ENABLED_OVERRIDE.with(std::cell::Cell::get) {
        return enabled;
    }
    match APP.get() {
        Some(app) => enabled(app),
        None => cfg!(test),
    }
}

#[tauri::command]
pub(crate) async fn warm_spares_enabled(app: tauri::AppHandle) -> Result<bool, String> {
    crate::blocking(move || Ok(!crate::app_marker::exists(&app, WARM_SPARES_OFF_FILE)?)).await
}

#[tauri::command]
pub(crate) async fn set_warm_spares_enabled(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    crate::blocking(move || crate::app_marker::set(&app, WARM_SPARES_OFF_FILE, !enabled)).await?;
    if !enabled {
        // Keep retirement on the runtime so each killed process registers its pending exit.
        discard_all();
    }
    Ok(())
}

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
/// A started process for a spare: its warm key, the child, its group, its tool server and the
/// pending exit that covers the time before the spare is registered (dropped right after).
pub(super) struct Spawned {
    pub(super) key: String,
    pub(super) child: Child,
    pub(super) group: ProcessGroup,
    pub(super) server: Option<mcp_host::Server>,
    pub(super) starting: Pending,
}
type Spawning = std::pin::Pin<Box<dyn std::future::Future<Output = Result<Option<Spawned>, String>> + Send>>;

/// How spares start, how long each waits and which pool keeps them: Claude Code, `IDLE` and
/// the app's one pool, or a stub with a pool of its own in tests (so tests running in parallel
/// never evict each other's spares).
#[derive(Clone, Copy)]
struct Lifecycle {
    idle: Duration,
    /// Starts the process for a launch, or `None` when this launch takes no spare.
    spawn: fn(RunConfig, Vec<Value>, HashSet<String>, u64) -> Spawning,
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
    cwd: Option<PathBuf>,
}

/// The idle spares by task, and why each task's last lead spare left the pool without being
/// adopted (so the adoption log can say why a lead's wake started cold).
#[derive(Default)]
struct Spares {
    spares: HashMap<String, Spare>,
    /// Cancels whole renewal chains, including expired leads whose bounded `gone` note was cleared.
    discard_epoch: u64,
    /// In-flight starts and expiry renewal checks, keyed by a token, recording `(session_id, cwd)`
    /// so folder-scoped `discard_in` can advance their launch epochs before they spawn or register.
    starting: HashMap<u64, (String, PathBuf)>,
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
    /// Remove `session_id` from the pool and register a `Pending` exit under the pool lock, so
    /// a concurrent `quiesce`/`await_exit` cannot slip between removal and `retire`.
    fn remove(&mut self, session_id: &str, why: Gone) -> Option<(Spare, Pending)> {
        let spare = self.spares.remove(session_id)?;
        let pending = pending_in_cwd(session_id, spare.cwd.clone());
        if spare.lead {
            if self.gone.len() >= GONE_LIMIT {
                self.gone.clear();
            }
            self.gone.insert(session_id.to_owned(), why);
        }
        Some((spare, pending))
    }
}

static SPARES: LazyLock<Pool> = LazyLock::new(Pool::default);
/// Monotonic token for `Spares::starting` entries.
static NEXT_INFLIGHT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
/// Each task's latest Claude launch, numbered from one app-wide sequence (`NEXT_LAUNCH`) so a
/// forgotten task's number never comes back. A spare started for launch N is useless once a
/// later launch has begun: it would resume the conversation without that turn.
static NEXT_LAUNCH: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
static LAUNCHES: LazyLock<Mutex<HashMap<String, u64>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

struct InFlight {
    pool: &'static Pool,
    token: u64,
}

impl InFlight {
    #[cfg(all(test, unix))]
    fn enter(pool: &'static Pool, session_id: String, cwd: PathBuf) -> Self {
        Self::enter_locked(pool, &mut spares(pool), session_id, cwd)
    }

    fn enter_locked(pool: &'static Pool, locked: &mut Spares, session_id: String, cwd: PathBuf) -> Self {
        let token = NEXT_INFLIGHT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        locked.starting.insert(token, (session_id, cwd));
        Self { pool, token }
    }
}

impl Drop for InFlight {
    fn drop(&mut self) {
        spares(self.pool).starting.remove(&self.token);
    }
}

/// Set once the app begins quitting (`on_run_event` in `lib.rs`): a spare already waiting on
/// an exit, or a lead's renewal, must not start a process the quit would then wait for.
static QUITTING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn begin_quit() {
    QUITTING.store(true, std::sync::atomic::Ordering::SeqCst);
}

fn quitting() -> bool {
    QUITTING.load(std::sync::atomic::Ordering::SeqCst)
}

/// The task's current launch count, read when a turn ends and before the next can begin.
pub fn epoch(session_id: &str) -> u64 {
    LAUNCHES.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).get(session_id).copied().unwrap_or(0)
}

fn spares(pool: &Pool) -> std::sync::MutexGuard<'_, Spares> {
    pool.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Plain Claude only: an idle relay spare made a network request (see docs/worker-tokens.md).
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

/// Whether this launch passes `--settings {"fastMode":true}` (`configure_command_with_agents`).
fn claude_fast_mode(config: &RunConfig) -> bool {
    config.provider == "claude"
        && config
            .codex_settings
            .as_ref()
            .is_some_and(|settings| settings["serviceTier"] == "fast")
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
        "mode": config.mode, "cwd": config.cwd, "resume": config.resume_id,
        "instructions": config.instructions, "tools": tools,
        // Claude's fast mode passes `--settings {"fastMode":true}` at spawn (`configure_command_with_agents`).
        "fastMode": claude_fast_mode(config),
        // A team worker's tool trim (read-only, skills) is on its command line.
        "worker": config.worker,
        // The deny set read once per turn from the conversation's history (`lib.rs`), so a
        // spare launched with another `--disallowedTools` is never adopted.
        "disallowedTools": config.disallowed_tools,
        "disabledSkills": disabled,
        // The login a process starts with (API key or subscription) is fixed at spawn.
        "connection": format!("{:?}", crate::provider_settings::claude_connection_mode()),
        // A saved environment variable change starts the next turn cold.
        "environment": crate::provider_settings::environment_fingerprint(&config.provider),
        // So do the telemetry opt-outs (`privacy.rs`).
        "telemetryOff": super::privacy::telemetry_off(),
        // So does a saved executable location.
        "executable": crate::provider_settings::executable_override(&config.provider),
        // Config files Claude reads only at startup: an edit while a spare idles starts cold.
        "claudeConfig": claude_config_fingerprint(&config.cwd),
    })
    .to_string()
}

/// Project-scoped files under the working folder that Claude Code reads at startup.
const PROJECT_CLAUDE_CONFIG: [&str; 6] =
    [".mcp.json", ".claude/settings.json", ".claude/settings.local.json", "CLAUDE.md", ".claude/CLAUDE.md", ".claude/skills"];
/// User-scoped files under the effective Claude config folder.
const USER_CLAUDE_CONFIG: [&str; 3] = ["settings.json", "CLAUDE.md", "skills"];

/// Metadata only (never contents or paths) of the Claude config files, so a spare started
/// before one was created, edited or removed is never adopted.
fn claude_config_fingerprint(cwd: &Path) -> Vec<Value> {
    let env = crate::provider_settings::environment("claude");
    let user_dir = crate::account_config::config_dir("claude", &env);
    let project = PROJECT_CLAUDE_CONFIG.iter().map(|name| config_file_stamp(&cwd.join(name)));
    let user = USER_CLAUDE_CONFIG
        .iter()
        .map(|name| user_dir.as_ref().map_or(Value::Null, |dir| config_file_stamp(&dir.join(name))));
    project.chain(user).collect()
}

fn config_file_stamp(path: &Path) -> Value {
    match std::fs::metadata(path) {
        Ok(meta) => {
            let modified = meta
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|since| since.as_nanos().to_string());
            json!([meta.is_dir(), meta.len(), modified])
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Value::Null,
        Err(error) => json!(format!("err:{:?}", error.kind())),
    }
}

/// The spare launches with the instructions a cold launch would use (`run_inner` applies the
/// skill reminder before keying), so its key and its `--append-system-prompt` both match.
fn prepared(mut config: RunConfig, disabled: &std::collections::BTreeSet<String>) -> RunConfig {
    crate::skill_manager::apply_instructions(&mut config, disabled);
    config
}

/// The warm agent for this turn, if one exists, is still running and was started for
/// exactly this launch. Any other warm agent for the task is discarded.
/// Every launch of the task counts, with or without a spare to adopt.
pub(crate) fn launched(session_id: &str) {
    let launch = NEXT_LAUNCH.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    LAUNCHES.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).insert(session_id.to_owned(), launch);
}

pub(super) fn take(session_id: &str, key: &str) -> Option<Adopting> {
    // Re-read after the caller awaited its key: the user may have switched spares off meanwhile.
    if !enabled_now() {
        launched_without_spare(session_id);
        return None;
    }
    let (spare, note) = take_in(&SPARES, session_id, key);
    // A miss costs the CLI's whole startup; say why so slow turns can be traced. Every lead
    // spare's hit and miss is logged too, so the lead pool's speed-up can be measured.
    if let Some(note) = note {
        eprintln!("{note}");
    }
    spare.map(|spare| Adopting { session_id: session_id.to_owned(), spare: Some(spare) })
}

/// A spare taken for adoption. Dropping it before `into_parts` (a launch that fails between
/// taking the spare and owning its streams) retires the process like any other removal, so the
/// next same-session launch waits for it instead of resuming beside it.
pub(super) struct Adopting {
    session_id: String,
    spare: Option<(Spare, Pending)>,
}

impl Adopting {
    /// The spare's tool server, handed to the run.
    pub(super) fn server(&mut self) -> Option<mcp_host::Server> {
        self.spare.as_mut().and_then(|(spare, _)| spare.server.take())
    }

    /// Adopted: the run owns the process from here and must retire it itself on failure.
    pub(super) fn into_parts(mut self) -> (Child, ProcessGroup) {
        let (spare, _pending) = self.spare.take().expect("an adopted spare is taken once");
        (spare.child, spare.group)
    }
}

impl Drop for Adopting {
    fn drop(&mut self) {
        if let Some((spare, pending)) = self.spare.take() {
            retire(&self.session_id, spare, pending);
        }
    }
}

/// The spare this launch adopts, if any, and what to log about it (never any contents: only
/// the outcome and the names of warm-key fields that changed).
fn take_in(pool: &Pool, session_id: &str, key: &str) -> (Option<(Spare, Pending)>, Option<String>) {
    launched(session_id);
    let (removed, gone) = {
        let mut pool = spares(pool);
        let gone = pool.gone.remove(session_id);
        let removed = pool.spares.remove(session_id).map(|spare| {
            let pending = pending_in_cwd(session_id, spare.cwd.clone());
            (spare, pending)
        });
        (removed, gone)
    };
    let Some((mut spare, pending)) = removed else {
        return (None, gone.map(|why| lead_decision(pool, Some(why.reason()))));
    };
    let alive = matches!(spare.child.try_wait(), Ok(None));
    match miss(alive, &spare.key, key, spare.born.elapsed(), spare.idle) {
        None => {
            let note = spare.lead.then(|| lead_decision(pool, None));
            (Some((spare, pending)), note)
        }
        Some(reason) => {
            // The cold launch's `await_exit` waits for this process, so two never share a session.
            let note = if spare.lead { lead_decision(pool, Some(&reason)) } else { format!("Warm Claude agent not used ({reason}); starting cold.") };
            retire(session_id, spare, pending);
            (None, Some(note))
        }
    }
}

/// Kill a spare that left the pool without being adopted and register its exit under the session
/// like a finished turn's (`exit::spawn_exit_in_cwd`), so whatever resumes the session next (a
/// cold launch, the harness console) waits until the process is really gone instead of overlapping
/// it. Every removal (a miss, expiry, a refused registration, eviction, replacement, discard)
/// comes here, never holding the pool lock; `pending` was registered under the pool lock and
/// drops only after `retire_parts_in_cwd` has chained the real exit behind it. Outside a runtime
/// nothing can wait: dropping it still kills it.
fn retire(session_id: &str, spare: Spare, pending: Pending) {
    let Spare { child, group, server, cwd, .. } = spare;
    retire_parts_in_cwd(session_id, child, group, server, cwd);
    drop(pending);
}

/// A launch that takes no spare (a host-less or unsupported one) still counts as a launch and
/// retires whatever spare the task holds, so none idles beside its cold process.
pub(super) fn launched_without_spare(session_id: &str) {
    launched(session_id);
    let dropped = spares(&SPARES).remove(session_id, Gone::Discarded);
    if let Some((spare, pending)) = dropped {
        retire(session_id, spare, pending);
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

/// Best-effort canonical path: uses `canonicalize` when `path` exists, and otherwise
/// canonicalizes the deepest existing ancestor so deleted folders (e.g. during
/// `recreate_worktree`) still match spares recorded under a canonical or symlinked spelling.
pub(super) fn resolve_path(path: &Path) -> PathBuf {
    if let Ok(canonical) = path.canonicalize() {
        return external_path(&canonical);
    }
    let mut suffix = Vec::new();
    let mut cursor = path;
    loop {
        if let Ok(canonical) = cursor.canonicalize() {
            let mut resolved = external_path(&canonical);
            for component in suffix.into_iter().rev() {
                match component {
                    std::path::Component::CurDir => {}
                    std::path::Component::ParentDir => {
                        resolved.pop();
                    }
                    other => resolved.push(other.as_os_str()),
                }
            }
            return resolved;
        }
        let Some(parent) = cursor.parent() else {
            return external_path(path);
        };
        if let Some(last) = cursor.components().next_back() {
            suffix.push(last);
        }
        if parent == cursor {
            return external_path(path);
        }
        cursor = parent;
    }
}

/// Whether `candidate` lies inside (or equals) `folder`, literally or once both resolve
/// through [`resolve_path`]. `folder_resolved` is `resolve_path(folder)` computed once.
pub(super) fn path_in_folder(candidate: &Path, folder: &Path, folder_resolved: &Path) -> bool {
    let candidate_ext = external_path(candidate);
    let folder_ext = external_path(folder);
    if candidate_ext == folder_ext || candidate_ext.starts_with(&folder_ext) {
        return true;
    }
    if candidate_ext == folder_resolved || candidate_ext.starts_with(folder_resolved) {
        return true;
    }
    let resolved = resolve_path(candidate);
    resolved == folder_resolved || resolved.starts_with(folder_resolved)
}

/// Advance `session_id`'s launch epoch when it already has one, without forgetting the task
/// or inserting an entry for a task that never launched.
fn advance_launch_if_present(launches: &mut HashMap<String, u64>, session_id: &str) {
    if let Some(slot) = launches.get_mut(session_id) {
        *slot = NEXT_LAUNCH.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    }
}

/// Drop a task's pooled warm spare and advance its launch epoch (when one exists) without
/// forgetting the task: any spare or lead renewal still starting for the old epoch is refused,
/// while a turn currently running still reads a nonzero epoch at turn end so its post-turn spare
/// starts with the updated settings.
/// Must run inside a tokio runtime: only there does the killed spare register its exit, so a
/// later `await_exit` waits for it.
pub fn invalidate(session_id: &str) {
    invalidate_from(&SPARES, session_id);
}

fn invalidate_from(pool: &Pool, session_id: &str) {
    if let Some((spare, pending)) = take_for_invalidate(pool, session_id) {
        retire(session_id, spare, pending);
    }
}

fn take_for_invalidate(pool: &Pool, session_id: &str) -> Option<(Spare, Pending)> {
    // Lock order: SPARES before LAUNCHES (matching `register`), so no concurrent `register` can
    // slip between advancing the epoch and removing an already-pooled spare.
    let mut pool = spares(pool);
    {
        let mut launches = LAUNCHES.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        advance_launch_if_present(&mut launches, session_id);
    }
    pool.remove(session_id, Gone::Discarded)
}

/// Drop a task's warm agent and forget its launch number: its team stopped or paused, or the task
/// was deleted / quiesced. A spare (or a lead's renewal) still starting for the old launch,
/// numbered at least 1, never matches the forgotten 0 and is dropped instead of idling for `IDLE`.
/// Must run inside a tokio runtime: only there does the killed spare register its exit, so a
/// later `await_exit` waits for it.
pub fn discard(session_id: &str) {
    discard_from(&SPARES, session_id);
}

/// Retire both pools and invalidate starts and expiry checks already in flight. The gone
/// entries include a lead between expiry and renewal; advancing its epoch cancels that chain
/// even if the user switches spares back on before the check finishes.
pub fn discard_all() {
    discard_all_from(&SPARES);
}

fn discard_all_from(pool: &Pool) {
    let removed = {
        let mut pool = spares(pool);
        pool.discard_epoch = pool.discard_epoch.wrapping_add(1);
        let affected: HashSet<String> = pool.spares.keys().chain(pool.gone.keys())
            .chain(pool.starting.values().map(|(id, _)| id)).cloned().collect();
        {
            // Same lock order as registration: pool, then launch epochs.
            let mut launches = LAUNCHES.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            for id in affected {
                advance_launch_if_present(&mut launches, &id);
            }
        }
        pool.starting.clear();
        let ids: Vec<_> = pool.spares.keys().cloned().collect();
        ids.into_iter().filter_map(|id| pool.remove(&id, Gone::Discarded)
            .map(|(spare, pending)| (id, spare, pending))).collect::<Vec<_>>()
    };
    for (id, spare, pending) in removed {
        retire(&id, spare, pending);
    }
}

/// Drop every pooled warm spare whose working directory lies in `folder`, and advance the launch
/// epochs of those sessions and any in-flight spare spawns targeting `folder` so none can race
/// back into the pool. Returns the affected session IDs.
/// Must run inside a tokio runtime so retired spares register their exits.
pub fn discard_in(folder: &Path) -> Vec<String> {
    discard_pool_in(&SPARES, folder)
}

/// `discard`, then wait (bounded by `await_exit`'s hard cap) until every process of the session
/// has exited, so nothing holds its conversation or checkout open afterwards: the harness
/// console, a worktree removal and a task deletion all need that. Never call with a lock held.
pub async fn quiesce(session_id: &str) -> Result<(), String> {
    // An Antigravity agent lingering after its turn (`linger_agent`) owns a process of the
    // session outside the exit registry; it ends here, as before the next turn.
    super::end_lingering(session_id).await;
    quiesce_in(&SPARES, session_id).await
}

/// Retire every pooled warm spare in `folder` and wait (bounded by `EXIT_HARD_CAP`) until those
/// spares and any other pending exits in `folder` have exited. Never call with a lock held.
pub async fn quiesce_spares_in(folder: &Path) -> Result<(), String> {
    quiesce_spares_in_with(&SPARES, folder, discard_in).await
}

async fn quiesce_in(pool: &Pool, session_id: &str) -> Result<(), String> {
    discard_from(pool, session_id);
    await_exit(session_id).await
}

fn discard_from(pool: &Pool, session_id: &str) {
    // Killed outside the lock; `Pending` was registered under the pool lock so `await_exit`
    // waits even before `retire` registers the real exit.
    if let Some((spare, pending)) = take_for_discard(pool, session_id) {
        retire(session_id, spare, pending);
    }
}

fn take_for_discard(pool: &Pool, session_id: &str) -> Option<(Spare, Pending)> {
    let mut pool = spares(pool);
    LAUNCHES.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).remove(session_id);
    pool.remove(session_id, Gone::Discarded)
}

fn take_for_discard_in(pool: &Pool, folder: &Path) -> (Vec<(String, Spare, Pending)>, Vec<String>) {
    let folder_resolved = resolve_path(folder);
    let mut pool = spares(pool);
    let matching_spares: Vec<String> = pool
        .spares
        .iter()
        .filter(|(_, spare)| {
            spare
                .cwd
                .as_deref()
                .is_some_and(|cwd| path_in_folder(cwd, folder, &folder_resolved))
        })
        .map(|(id, _)| id.clone())
        .collect();
    let matching_starting: Vec<(u64, String)> = pool
        .starting
        .iter()
        .filter(|(_, (_, cwd))| path_in_folder(cwd, folder, &folder_resolved))
        .map(|(token, (id, _))| (*token, id.clone()))
        .collect();
    let mut affected = Vec::with_capacity(matching_spares.len() + matching_starting.len());
    for id in &matching_spares {
        if !affected.contains(id) {
            affected.push(id.clone());
        }
    }
    for (token, id) in matching_starting {
        pool.starting.remove(&token);
        if !affected.contains(&id) {
            affected.push(id);
        }
    }
    if !affected.is_empty() {
        // Lock order: SPARES before LAUNCHES (matching `register`).
        let mut launches = LAUNCHES.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        for id in &affected {
            advance_launch_if_present(&mut launches, id);
        }
    }
    let mut removed = Vec::with_capacity(matching_spares.len());
    for id in matching_spares {
        if let Some((spare, pending)) = pool.remove(&id, Gone::Discarded) {
            removed.push((id, spare, pending));
        }
    }
    (removed, affected)
}

fn discard_pool_in(pool: &Pool, folder: &Path) -> Vec<String> {
    let (removed, affected) = take_for_discard_in(pool, folder);
    for (id, spare, pending) in removed {
        retire(&id, spare, pending);
    }
    affected
}

fn has_spare_in(pool: &Pool, folder: &Path) -> bool {
    let folder_resolved = resolve_path(folder);
    let pool = spares(pool);
    pool.spares.values().any(|spare| {
        spare
            .cwd
            .as_deref()
            .is_some_and(|cwd| path_in_folder(cwd, folder, &folder_resolved))
    }) || pool
        .starting
        .values()
        .any(|(_, cwd)| path_in_folder(cwd, folder, &folder_resolved))
}

#[cfg(all(test, unix))]
async fn quiesce_pool_spares_in(pool: &Pool, folder: &Path) -> Result<(), String> {
    quiesce_spares_in_with(pool, folder, |dir| discard_pool_in(pool, dir)).await
}

async fn quiesce_spares_in_with(
    pool: &Pool,
    folder: &Path,
    discard: impl Fn(&Path) -> Vec<String>,
) -> Result<(), String> {
    let wait = async {
        loop {
            let affected = discard(folder);
            if !affected.is_empty() {
                let results = futures_util::future::join_all(
                    affected.iter().map(|id| await_exit(id)),
                )
                .await;
                if let Some(error) = results.into_iter().find_map(Result::err) {
                    return Err(error);
                }
            }
            await_exits_in(folder).await?;
            if !has_spare_in(pool, folder) {
                return Ok(());
            }
        }
    };
    tokio::time::timeout(EXIT_HARD_CAP, wait)
        .await
        .map_err(|_| "A previous run in this folder is still shutting down. Try again.".to_string())?
}

/// Keep the renewal visible to folder discard from the moment its expired spare leaves the
/// pool. Both the exit and the renewal token are registered before releasing the pool lock.
fn take_expired_for_renewal(
    pool: &'static Pool,
    session_id: &str,
    born: std::time::Instant,
    renewing: bool,
) -> Option<(Spare, Pending, Option<InFlight>)> {
    let mut locked = spares(pool);
    if locked.spares.get(session_id).is_none_or(|spare| spare.born != born) {
        return None;
    }
    let (spare, pending) = locked.remove(session_id, Gone::Expired)?;
    let inflight = if renewing {
        spare.cwd.clone().map(|cwd| InFlight::enter_locked(pool, &mut locked, session_id.to_owned(), cwd))
    } else {
        None
    };
    Some((spare, pending, inflight))
}

/// Non-renewing expiry used by the process-retirement tests.
#[cfg(all(test, unix))]
fn take_expired(pool: &'static Pool, session_id: &str, born: std::time::Instant) -> Option<(Spare, Pending)> {
    take_expired_for_renewal(pool, session_id, born, false).map(|(spare, pending, _)| (spare, pending))
}

/// Start the next turn's agent for a task. `tools` is the catalog its last turn used; the
/// placeholder server answers the agent's startup listing and is rebound on adoption.
/// `renew` marks a team lead waiting on its workers: its spare joins the lead pool and, if
/// `renew` holds at the moment it expires and no turn has launched, starts once more (see
/// `Renew`: a "no" at an expiry ends the chain). `inputs` reads what the launch was built from
/// outside `config` (`Inputs`); it is called only for a lead's spare.
pub async fn prewarm(config: RunConfig, tools: Vec<Value>, approval_tools: HashSet<String>, launch: u64, renew: Option<Renew>, inputs: impl Fn() -> String + Send + Sync + 'static) -> Result<(), String> {
    if !enabled_now() {
        return Ok(());
    }
    start(claude(), config, tools, approval_tools, launch,
        renew.map(|renew| (until_discarded(&SPARES, renew), Arc::new(inputs) as Inputs)), 0).await
}

/// A switch-off ends this chain permanently, even if spares are re-enabled before an expiry
/// check finishes and its bounded `gone` note has already been evicted.
fn until_discarded(pool: &'static Pool, renew: Renew) -> Renew {
    let epoch = spares(pool).discard_epoch;
    Arc::new(move || {
        let current = spares(pool).discard_epoch == epoch;
        current && renew()
    })
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
    if !enabled_now() {
        return false;
    }
    let mut config = config.clone();
    config.cwd = external_path(&config.cwd);
    // The spawn keyed the config as a cold launch prepares it (skill reminder applied).
    let disabled = crate::skill_manager::disabled_for(&config.session_id);
    let config = prepared(config, &disabled);
    key_with_disabled(&config, tools, &crate::connections::warm_key(&config.session_id, &config.provider), &disabled) == spare_key && inputs() == spawned
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
    let session_id = config.session_id.clone();
    let cwd_path = external_path(&config.cwd);
    let inflight = {
        let mut pool = spares(life.pool);
        // SPARES -> LAUNCHES, matching folder discard: a cancelled renewal cannot insert
        // a stale token after quiescence, read inputs or invoke the spawn callback.
        if launch == 0 || epoch(&session_id) != launch {
            return Ok(());
        }
        InFlight::enter_locked(life.pool, &mut pool, session_id.clone(), cwd_path.clone())
    };
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
    if launch == 0 || epoch(&session_id) != launch {
        return Ok(());
    }
    let cwd = Some(cwd_path);
    let Some(Spawned { key, child, group, server, starting }) = (life.spawn)(config, tools, approval_tools, launch).await? else { return Ok(()) };
    let spare_key = key.clone();
    let born = std::time::Instant::now();
    let registered = register(life.pool, &session_id, launch, Spare { key, child, group, server, born, idle: life.idle, lead: renewal.is_some(), cwd });
    drop(inflight);
    // The spare is now pooled, or killed with its own exit registered (`retire`).
    drop(starting);
    if !registered {
        return Ok(());
    }
    tokio::spawn(async move {
        tokio::time::sleep(life.idle).await;
        // Retired outside the lock: killed, and same-session launches wait for its exit.
        let Some((expired, pending, renewing)) = take_expired_for_renewal(life.pool, &session_id, born, renewal.is_some()) else { return };
        retire(&session_id, expired, pending);
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
            if launch == 0 || epoch(&config.session_id) != launch {
                return;
            }
            // `start` logs a failure with the renewal's number.
            let _ = start(life, config, tools, approvals, launch, Some((renew, inputs)), renewals + 1).await;
        }
        // The old token overlaps `start`'s own guard through its entire handoff.
        drop(renewing);
    });
    Ok(())
}

/// Claude Code's process for a spare, with a placeholder tool server; `None` for a launch
/// that takes no spare (`supported`).
fn spawn_claude(config: RunConfig, tools: Vec<Value>, approval_tools: HashSet<String>, launch: u64) -> Spawning {
    Box::pin(spawn_claude_process(config, tools, approval_tools, launch))
}

async fn spawn_claude_process(mut config: RunConfig, tools: Vec<Value>, approval_tools: HashSet<String>, launch: u64) -> Result<Option<Spawned>, String> {
    if !enabled_now() || !supported(&config) || launch == 0 || epoch(&config.session_id) != launch || quitting() {
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
    // Switches, settings and the reminder's skill scan are read off the runtime.
    let catalog = tools.clone();
    let (config, key, disabled) = crate::blocking(move || {
        let disabled = crate::skill_manager::disabled_for(&config.session_id);
        let config = prepared(config, &disabled);
        let key = key_with_disabled(
            &config,
            &catalog,
            &crate::connections::warm_key(&config.session_id, &config.provider),
            &disabled,
        );
        Ok((config, key, disabled))
    })
    .await?;
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
    // The turn it follows may still be exiting; resuming before then could read a half-flushed session.
    let exit = await_exit_patiently(&config.session_id);
    let Some((child, starting)) = spawn_when_current(&config.session_id, launch, exit, &mut command, || quitting() || !enabled_now()).await? else {
        eprintln!("No warm Claude agent prepared: its launch changed or the previous turn did not exit.");
        return Ok(None);
    };
    let group = ProcessGroup::register(child.id());
    Ok(Some(Spawned { key, child, group, server, starting }))
}

/// Spawn once the previous process has exited, unless the task launched again meanwhile: that
/// follow-up missed the pool and waits on the same exit, so spawning now would overlap it on one
/// session. The returned `Pending` is registered before the spawn: until the caller drops it
/// (after `register`), `await_exit` waits for this spare, so a launch or the harness console
/// landing between the spawn and the pool never resumes the session beside it. `Ok(None)`
/// means nothing was spawned, also once the app is quitting (`quitting`, read at the last moment).
async fn spawn_when_current(
    session_id: &str,
    launch: u64,
    exit: impl std::future::Future<Output = Result<(), String>>,
    command: &mut Command,
    quitting: impl Fn() -> bool,
) -> Result<Option<(tokio::process::Child, Pending)>, String> {
    if exit.await.is_err() {
        return Ok(None);
    }
    let starting = pending_in_cwd(session_id, command.as_std().get_current_dir().map(Path::to_path_buf));
    // Checked after registering: a launch before this point moved the epoch and is refused here;
    // one after it waits for `starting`, and `register` kills the child (epoch moved).
    if launch == 0 || epoch(session_id) != launch || quitting() {
        return Ok(None);
    }
    command.spawn().map(|child| Some((child, starting))).map_err(|e| format!("Could not start Claude Code: {e}"))
}

/// Keep a started spare, unless the task launched again (a team review, a queued message) or
/// its spare was discarded (settings changed, team stopped) since `launch`: it would carry an
/// outdated conversation, or wait for a turn that is not coming. A refused, replaced or evicted
/// spare is retired (killed outside the lock, its exit registered).
fn register(pool: &Pool, session_id: &str, launch: u64, spare: Spare) -> bool {
    let evicted = {
        let mut pool = spares(pool);
        // Launch 0 is a forgotten task (`discard`): a spare read from it is never current.
        if launch == 0 || epoch(session_id) != launch {
            let pending = pending_in_cwd(session_id, spare.cwd.clone());
            drop(pool);
            retire(session_id, spare, pending);
            return false;
        }
        admit(&mut pool, session_id.to_owned(), spare)
    };
    for (id, spare, pending) in evicted {
        retire(&id, spare, pending);
    }
    true
}

/// Add a spare, keeping only the newest few in its pool (ordinary or lead); returns the spares
/// it pushed out (including one it replaced for the same task) with their tasks and `Pending`
/// guards, which the caller retires after releasing the lock.
fn admit(pool: &mut Spares, session_id: String, spare: Spare) -> Vec<(String, Spare, Pending)> {
    let lead = spare.lead;
    let limit = if lead { LEAD_LIMIT } else { LIMIT };
    pool.gone.remove(&session_id);
    let mut evicted: Vec<(String, Spare, Pending)> = pool
        .remove(&session_id, Gone::Replaced)
        .map(|(old, pending)| (session_id.clone(), old, pending))
        .into_iter()
        .collect();
    pool.spares.insert(session_id, spare);
    while pool.spares.values().filter(|spare| spare.lead == lead).count() > limit {
        let Some(oldest) = pool.spares.iter().filter(|(_, spare)| spare.lead == lead).min_by_key(|(_, spare)| spare.born).map(|(id, _)| id.clone()) else { break };
        evicted.extend(pool.remove(&oldest, Gone::Evicted).map(|(old, pending)| (oldest, old, pending)));
    }
    evicted
}

#[cfg(test)]
pub(super) fn waiting(session_id: &str) -> bool {
    waiting_in(&SPARES, session_id)
}

#[cfg(test)]
fn waiting_in(pool: &Pool, session_id: &str) -> bool {
    spares(pool).spares.contains_key(session_id)
}

#[cfg(all(test, unix))]
pub(crate) fn spare_pool_test_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: LazyLock<tokio::sync::Mutex<()>> = LazyLock::new(|| tokio::sync::Mutex::new(()));
    &LOCK
}

#[cfg(all(test, unix))]
pub(crate) fn insert_spare_in_cwd_for_test(session_id: &str, cwd: PathBuf, lead: bool) -> u32 {
    launched(session_id);
    let mut command = Command::new("sleep");
    command.arg("30").kill_on_drop(true);
    if cwd.exists() {
        command.current_dir(&cwd);
    }
    let child = command.spawn().unwrap();
    let pid = child.id().unwrap();
    let spare = Spare {
        key: "test-spare".into(),
        child,
        group: ProcessGroup::register(Some(pid)),
        server: None,
        born: std::time::Instant::now(),
        idle: IDLE,
        lead,
        cwd: Some(external_path(&cwd)),
    };
    let registered = register(&SPARES, session_id, epoch(session_id), spare);
    assert!(registered, "test spare must register for {session_id}");
    pid
}

#[cfg(all(test, unix))]
pub(crate) fn has_spare_for_test(session_id: &str) -> bool {
    waiting_in(&SPARES, session_id)
}

#[cfg(all(test, unix))]
pub(crate) fn process_gone_for_test(pid: u32) -> bool {
    // SAFETY: signal 0 only checks that the process exists.
    unsafe { libc::kill(pid as i32, 0) == -1 }
}

#[cfg(test)]
mod tests;

/// Regression coverage for the warm-spare switch and retirement races.
#[cfg(test)]
mod switch_tests;
