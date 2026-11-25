//! Warm agents: after a Claude turn ends, the next turn's process starts in the background
//! so a follow-up skips the CLI's own startup (about 0.17–1.71 s, see docs/worker-tokens.md).
//! A warm agent is adopted only when everything on its command line and in its tool catalog
//! still matches; otherwise it is discarded and the turn starts cold as before.
use super::exit::{pending_in_cwd, retire_gracefully_in_cwd, retire_parts_in_cwd, Pending};
use super::*;
use crate::path_match::{path_in_folder, resolve_path};
use std::sync::LazyLock;

mod adopt;
mod key;
mod memory;
mod spawn;
mod stats;
pub(super) use self::adopt::adopt_for_launch;
#[cfg(test)]
use self::adopt::launched_without_key_since;
use self::key::{age_expired, miss};
use self::stats::{decision_miss, decision_miss_in, discarded_note, no_spare_note, record_adopted, Gone, MissStreak, PoolChurn, PoolStats, WarmStatsSnapshot};
pub(super) use self::key::{key_fields, lead_git_status_digest, with_git_status};
#[cfg(test)]
pub(super) use self::key::{key, lead_key};
pub use self::spawn::prewarm;
#[cfg(test)]
mod test_support;
#[cfg(test)]
pub(super) use self::test_support::waiting;
#[cfg(all(test, unix))]
pub(crate) use self::test_support::{has_spare_for_test, insert_spare_in_cwd_for_test, process_gone_for_test, spare_pool_test_lock};

/// Default-on switch shared by the desktop app and headless host.
const WARM_SPARES_OFF_FILE: &str = "warm-spares-off";

/// Unreadable settings fail closed: no idle CLI or ahead-of-turn SessionStart hooks.
pub fn enabled(app: &tauri::AppHandle) -> bool {
    enabled_in(crate::app_marker::data_dir(app))
}

/// The one on/off decision, also exercised directly by the unit tests.
fn enabled_in(dir: Result<PathBuf, String>) -> bool {
    crate::app_marker::default_on_in(dir, WARM_SPARES_OFF_FILE)
}

#[cfg(test)]
thread_local! {
    static ENABLED_OVERRIDE: std::cell::Cell<Option<bool>> = const { std::cell::Cell::new(None) };
}

/// Provider launch paths have no handle argument: this reads through the one both app entry
/// points save (`app_marker::init`). Unreadable settings (or a missing handle in production)
/// fail closed. Unit tests without an app handle default to enabled so warm-pool and adoption
/// tests run directly, unless overridden.
pub(super) fn enabled_now() -> bool {
    #[cfg(test)]
    if let Some(enabled) = ENABLED_OVERRIDE.with(std::cell::Cell::get) {
        return enabled;
    }
    crate::app_marker::default_on_now(WARM_SPARES_OFF_FILE)
}

/// `enabled_now`, read on a blocking thread so the async runtime never waits on the marker file.
/// A test's thread-local override is read here first: the blocking thread would not see it.
async fn enabled_off_runtime() -> bool {
    #[cfg(test)]
    if let Some(enabled) = ENABLED_OVERRIDE.with(std::cell::Cell::get) {
        return enabled;
    }
    crate::app_marker::default_on_off_runtime(WARM_SPARES_OFF_FILE).await
}

/// Each pool's lifecycle totals since launch: a pure in-memory read (no file, no network).
/// Async so Tauri runs it on the async runtime, never taking the pool lock on the main thread.
#[tauri::command]
pub(crate) async fn warm_spare_stats() -> WarmStatsSnapshot {
    WarmStatsSnapshot::of(&spares(&SPARES))
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
        disable_all();
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
/// whole idle Claude Code process (about 195–255 MiB resident on Claude Code 2.1.325,
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
/// A start: `Ok(true)` once its spare registered in the pool (`spawn::spawn_spare`).
type Starting = std::pin::Pin<Box<dyn std::future::Future<Output = Result<bool, String>> + Send>>;
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
    /// Starts the process for a launch (`bool`: a lead's), or `None` when it takes no spare.
    spawn: fn(RunConfig, Vec<Value>, HashSet<String>, u64, bool) -> Spawning,
    /// Whether a renewal's launch inputs still give the expired spare's key and the inputs
    /// read at its spawn (`still_current`).
    current: fn(&str, &RunConfig, &[Value], &str, &Inputs) -> bool,
    pool: &'static Pool,
}

pub(super) struct Spare {
    key: String,
    pub(super) child: Child,
    pub(super) group: ProcessGroup,
    pub(super) server: Option<mcp_host::Server>,
    born: std::time::Instant,
    /// `born` on the wall clock, which keeps running while the machine sleeps (`Instant` may not).
    born_wall: std::time::SystemTime,
    /// How long it may wait: its lifecycle's `idle`.
    idle: Duration,
    /// Started for a team lead waiting on its workers (the lead pool).
    lead: bool,
    /// A lead spare whose chain still had a renewal left (`renewals < MAX_RENEWALS`): expiring,
    /// it would have started again, so a launch finding it past its window says nothing about
    /// the chain running out unused. False for ordinary spares and a chain's last lead spare.
    pub(super) renewal_due: bool,
    cwd: Option<PathBuf>,
}

/// The idle spares by task, and why each task's last lead spare left the pool without being
/// adopted (so the adoption log can say why a lead's wake started cold).
#[derive(Default)]
struct Spares {
    spares: HashMap<String, Spare>,
    /// Moved only by a switch-off (`disable_all`): cancels whole renewal chains, including expired
    /// leads whose bounded `gone` note was cleared, and keeps a launch keyed meanwhile from
    /// counting a cold start. A settings discard (`discard_all`) leaves it.
    discard_epoch: u64,
    /// In-flight starts and expiry renewal checks, keyed by a token, so `quiesce_spares_in` can
    /// advance their launch epochs before they spawn or register, and `spawn_spare` caps each
    /// pool's starts in flight. An entry stays until its `InFlight` drops, even once cancelled.
    starting: HashMap<u64, StartingEntry>,
    gone: HashMap<String, Gone>,
    /// Each pool's lifecycle totals since launch: in memory only, read from the adoption log
    /// line (docs/worker-tokens.md) and `warm_spare_stats`.
    lead: PoolStats,
    ordinary: PoolStats,
    /// Each pool's eviction, unused-expiry and launch-time miss streaks and backoff (`spawn_spare`).
    lead_churn: PoolChurn,
    ordinary_churn: PoolChurn,
}

/// A start or renewal check in flight. `cancelled`: a switch-off or folder discard already
/// advanced its launch epoch, so it can no longer register, but its task still runs (and still
/// counts against the pool's cap) until its `InFlight` guard drops.
struct StartingEntry {
    session_id: String,
    cwd: PathBuf,
    lead: bool,
    cancelled: bool,
}

type Pool = Mutex<Spares>;

/// `gone` keeps at most this many reasons (tasks deleted with a reason pending never read it).
const GONE_LIMIT: usize = 64;

impl Spares {
    /// Remove `session_id` from the pool and register a `Pending` exit under the pool lock, so
    /// a concurrent `quiesce`/`await_exit` cannot slip between removal and `retire`.
    fn remove(&mut self, session_id: &str, why: Gone) -> Option<(Spare, Pending)> {
        let spare = self.spares.remove(session_id)?;
        let pending = pending_in_cwd(session_id, spare.cwd.clone());
        self.stats_mut(spare.lead).count(why);
        // An expiry joins the expiry streak only once its spare settles unused with spares on
        // and unrenewed (`spawn::settle_expiry`, `spawn::settle_lead_expiry`): a lead's whole
        // renewal chain counts once, and an expiry with spares off counts nothing.
        if why == Gone::Evicted {
            let limit = if spare.lead { LEAD_LIMIT } else { LIMIT };
            self.churn_mut(spare.lead).evicted(limit, std::time::Instant::now(), std::time::SystemTime::now());
        }
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
    #[cfg(test)]
    fn enter(pool: &'static Pool, session_id: String, cwd: PathBuf, lead: bool) -> Self {
        Self::enter_locked(pool, &mut spares(pool), session_id, cwd, lead)
    }

    fn enter_locked(pool: &'static Pool, locked: &mut Spares, session_id: String, cwd: PathBuf, lead: bool) -> Self {
        let token = NEXT_INFLIGHT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        locked.starting.insert(token, StartingEntry { session_id, cwd, lead, cancelled: false });
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

/// Every launch of the task counts, with or without a spare to adopt.
pub(crate) fn launched(session_id: &str) {
    let launch = NEXT_LAUNCH.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    LAUNCHES.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).insert(session_id.to_owned(), launch);
}

/// The warm agent for this turn, if one exists, is still running and was started for
/// exactly this launch. Any other warm agent for the task is discarded.
#[cfg(test)]
pub(super) fn take(session_id: &str, key: &str) -> Option<Adopting> {
    if !enabled_now() {
        launched_without_spare(session_id);
        return None;
    }
    let discard_epoch = spares(&SPARES).discard_epoch;
    take_checked(session_id, key, true, false, discard_epoch)
}

/// `take` for a caller that has just checked `enabled_now()` off the runtime (with its key).
/// Switching spares off meanwhile empties the pool (`disable_all`), so nothing is adopted then.
/// A spare that vanished meanwhile counts a cold launch (in the lead pool for a `lead` launch)
/// only for an `ordinary_eligible` launch whose pool was not emptied by a switch-off since
/// `prepare_launch` read `discard_epoch`.
pub(super) fn take_checked(session_id: &str, key: &str, ordinary_eligible: bool, lead: bool, discard_epoch: u64) -> Option<Adopting> {
    let (spare, note) = take_since(&SPARES, session_id, key, ordinary_eligible, lead, discard_epoch);
    // A miss costs the CLI's whole startup; say why so slow turns can be traced. Every hit is
    // logged too (by `into_parts`), with lead and ordinary totals, so each pool's speed-up can
    // be measured.
    if let Some(note) = note {
        eprintln!("{note}");
    }
    spare.map(|spare| Adopting { pool: &SPARES, session_id: session_id.to_owned(), spare: Some(spare) })
}

/// A spare taken for adoption, counted as adopted only once `into_parts` commits to it. Dropping
/// it first (a failed rebind, a Stop before the launch owned its streams) counts a miss, outside
/// the pool's miss streak (the spare was usable), and retires the process like any other
/// removal, so the next same-session launch waits for it instead of resuming beside it.
pub(super) struct Adopting {
    pool: &'static Pool,
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
        eprintln!("{}", record_adopted(self.pool, spare.lead));
        (spare.child, spare.group)
    }
}

impl Drop for Adopting {
    fn drop(&mut self) {
        if let Some((spare, pending)) = self.spare.take() {
            eprintln!("{}", decision_miss(self.pool, spare.lead, "its launch ended before adoption", false));
            retire_now(&self.session_id, spare, pending);
        }
    }
}

/// The spare this launch adopts, if any, and what to log about it (never any contents: only
/// the outcome and the names of warm-key fields that changed).
fn take_since(pool: &Pool, session_id: &str, key: &str, ordinary_eligible: bool, lead: bool, discard_epoch: u64) -> (Option<(Spare, Pending)>, Option<String>) {
    let (removed, gone) = remove_for_launch(pool, session_id);
    let Some((mut spare, pending)) = removed else {
        // Expired or evicted during the key walk: never an uncounted launch (discarded by a
        // switch-off: spares are off, so nothing counts as a cold launch without one).
        return (None, no_spare_since(pool, gone, ordinary_eligible, lead, discard_epoch));
    };
    let alive = matches!(spare.child.try_wait(), Ok(None));
    // Either clock: a laptop asleep overnight stops `Instant` on some platforms, not the wall.
    let expired = age_expired(spare.born.elapsed(), spare.born_wall.elapsed().ok(), spare.idle);
    match miss(alive, &spare.key, key, expired) {
        // Counted and logged only once the launch commits to it (`Adopting::into_parts`).
        None => (Some((spare, pending)), None),
        Some(reason) => {
            // A dead or stale spare joins the pool's miss streak; one that merely outlived its
            // window says only that the follow-up came late, so it joins the expiry streak (the
            // expiry timer, or a sleeping laptop, left it for this launch to remove), unless it
            // was a lead spare with a renewal still due: its chain had not run out its budget.
            let streak = match (alive && expired, spare.renewal_due) {
                (true, true) => MissStreak::Neither,
                (true, false) => MissStreak::Expired,
                (false, _) => MissStreak::Stale,
            };
            let note = decision_miss_in(pool, spare.lead, &reason, streak);
            // The cold launch's `await_exit` waits for this process, so two never share a session.
            retire_now(session_id, spare, pending);
            (None, Some(note))
        }
    }
}

/// Counts the launch and removes the task's spare and lead `gone` note. The removed spare's exit is
/// registered (`pending_in_cwd`) under the pool lock, so nothing resumes the session beside it.
fn remove_for_launch(pool: &Pool, session_id: &str) -> (Option<(Spare, Pending)>, Option<Gone>) {
    launched(session_id);
    let mut locked = spares(pool);
    let gone = locked.gone.remove(session_id);
    let removed = locked.spares.remove(session_id).map(|spare| {
        let pending = pending_in_cwd(session_id, spare.cwd.clone());
        (spare, pending)
    });
    (removed, gone)
}

/// Retire a spare that left the pool without being adopted, in the background: its stdin closes so
/// Claude Code exits on its own (running its `SessionEnd` hooks) within `exit::SPARE_RETIRE_WAIT`,
/// or at once when a launch hurries it (`await_exit`), before it is killed. Its exit is registered
/// under the session like a finished turn's (`exit::spawn_exit_in_cwd`), so whatever resumes the
/// session next (a cold launch, the harness console) waits until the process is really gone
/// instead of overlapping it. For removals nothing waits on (expiry, eviction, a discard or
/// switch-off); urgent removals (a launch's own misses, a same-task replacement, a refused
/// registration, quiesce) use `retire_now`. Never called holding the pool
/// lock; `pending` was registered under it and drops only after the real exit is chained behind
/// it. Outside a runtime nothing can wait: dropping it still kills it.
fn retire(session_id: &str, spare: Spare, pending: Pending) {
    let Spare { child, group, server, cwd, .. } = spare;
    retire_gracefully_in_cwd(session_id, child, group, server, cwd);
    drop(pending);
}

/// Kill the process at once for a launch about to start cold, a same-task replacement,
/// a refused registration, or a session or folder being quiesced.
fn retire_now(session_id: &str, spare: Spare, pending: Pending) {
    let Spare { child, group, server, cwd, .. } = spare;
    retire_parts_in_cwd(session_id, child, group, server, cwd);
    drop(pending);
}

/// A launch that takes no spare (a host-less or unsupported one) still counts as a launch and
/// retires whatever spare the task holds, so none idles beside its cold process.
pub(super) fn launched_without_spare(session_id: &str) {
    launched_without_spare_in(&SPARES, session_id);
}

/// Counted as discarded, but with no `gone` note: this very launch already starts cold, and a
/// note would make the lead's next supported launch log a miss for a spare it never could use.
fn launched_without_spare_in(pool: &Pool, session_id: &str) {
    let (removed, _gone) = remove_for_launch(pool, session_id);
    if let Some((spare, pending)) = removed {
        spares(pool).stats_mut(spare.lead).discarded += 1;
        retire_now(session_id, spare, pending);
    }
}

/// `no_spare_note`, counting a cold launch only if no switch-off emptied the pool since `discard_epoch`.
fn no_spare_since(pool: &Pool, gone: Option<Gone>, ordinary_eligible: bool, lead: bool, discard_epoch: u64) -> Option<String> {
    let mut locked = spares(pool);
    let eligible = ordinary_eligible && locked.discard_epoch == discard_epoch;
    no_spare_note(&mut locked, gone, eligible, lead)
}

/// What `prepare_launch` found in the pool for a supported launch.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum LaunchPool {
    /// A spare is pooled: key the launch off the runtime (with the working tree's git status when
    /// the pooled spare is a `lead` one), then `take_checked` with this epoch.
    Pooled { discard_epoch: u64, lead: bool },
    /// None pooled. `gone`: the lead's pending reason its last spare left the pool, taken from the
    /// pool here; `may_record_cold`: an eligible launch with no such note. `finish_empty_launch`
    /// counts and logs either (a lead miss, or a cold start in the lead pool for a `lead` launch)
    /// once it has seen spares on, off the runtime.
    Empty { may_record_cold: bool, lead: bool, gone: Option<Gone> },
}

/// Counts the launch and says whether the task has a pooled spare worth keying it against, so a
/// cold launch skips the warm key's config walk. With none, a lead's pending `gone` reason is
/// taken (for `finish_empty_launch`, never logged here); no file is read, so this is safe on the
/// async runtime. `lead`: the launch is a team lead's (it offers `pandacode_dispatch_workers`).
pub(super) fn prepare_launch(session_id: &str, ordinary_eligible: bool, lead: bool) -> LaunchPool {
    prepare_launch_in(&SPARES, session_id, ordinary_eligible, lead)
}

fn prepare_launch_in(pool: &Pool, session_id: &str, ordinary_eligible: bool, lead: bool) -> LaunchPool {
    let mut locked = spares(pool);
    // Lock order: SPARES before LAUNCHES (matching `register`), so no spare for the old launch can
    // register after this check. Advanced with a spare pooled too: a lead spare expiring during the
    // off-runtime key walk then sees a newer launch and is not renewed beside this one.
    launched(session_id);
    if let Some(spare) = locked.spares.get(session_id) {
        return LaunchPool::Pooled { discard_epoch: locked.discard_epoch, lead: spare.lead };
    }
    let gone = locked.gone.remove(session_id);
    LaunchPool::Empty { may_record_cold: ordinary_eligible && gone.is_none(), lead, gone }
}

/// A launch `prepare_launch` found no spare for: a lead's `gone` reason is counted and logged as
/// its miss, and an eligible launch (`may_record_cold`) as a cold start in its pool, both only
/// while spares are on (read off the runtime, so an unreadable switch says nothing either).
pub(super) async fn finish_empty_launch(may_record_cold: bool, lead: bool, gone: Option<Gone>) {
    if let Some(note) = finish_empty_launch_with(&SPARES, may_record_cold, lead, gone, enabled_off_runtime).await {
        eprintln!("{note}");
    }
}

/// `finish_empty_launch` with its switch read by `enabled`, which a launch with nothing to count
/// or log never calls.
async fn finish_empty_launch_with<Fut: std::future::Future<Output = bool>>(pool: &Pool, may_record_cold: bool, lead: bool, gone: Option<Gone>, enabled: impl FnOnce() -> Fut) -> Option<String> {
    if !may_record_cold && gone.is_none() {
        return None;
    }
    if !enabled().await {
        return None;
    }
    no_spare_note(&mut spares(pool), gone, may_record_cold, lead)
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

/// A setting or CLI behind every spare changed (Colab's MCP, an agent update): retire both pools
/// and invalidate starts and expiry checks already in flight (the gone entries include a lead
/// between expiry and renewal). Spares stay on: `discard_epoch` and the leads' `gone` notes are
/// kept, so launches keyed meanwhile still count and a lead's wake still reports its miss.
pub fn discard_all() {
    discard_all_from(&SPARES);
}

/// Spares switched off: `discard_all`, plus moving `discard_epoch` (a launch keyed meanwhile
/// counts no cold start, and every renewal chain ends even if spares come back on before its
/// check finishes, `until_discarded`) and clearing every lead's `gone` note.
fn disable_all() {
    disable_all_from(&SPARES);
}

fn discard_all_from(pool: &Pool) {
    retire_all_from(pool, false);
}

fn disable_all_from(pool: &Pool) {
    retire_all_from(pool, true);
}

fn retire_all_from(pool: &Pool, disable: bool) {
    let removed = {
        let mut pool = spares(pool);
        if disable {
            pool.discard_epoch = pool.discard_epoch.wrapping_add(1);
        }
        let affected: HashSet<String> = pool.spares.keys().chain(pool.gone.keys())
            .chain(pool.starting.values().map(|entry| &entry.session_id)).cloned().collect();
        {
            // Same lock order as registration: pool, then launch epochs.
            let mut launches = LAUNCHES.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            for id in affected {
                advance_launch_if_present(&mut launches, &id);
            }
        }
        // Kept, not cleared: those starts still run until their guards drop, so a quick off → on
        // must still count them against each pool's cap (`spawn::in_flight`).
        for entry in pool.starting.values_mut() {
            entry.cancelled = true;
        }
        let ids: Vec<_> = pool.spares.keys().cloned().collect();
        let removed = ids.into_iter().filter_map(|id| pool.remove(&id, Gone::Discarded)
            .map(|(spare, pending)| (id, spare, pending))).collect::<Vec<_>>();
        // Spares are off: no lead's next launch may report a miss (or count one) for them.
        if disable {
            pool.gone.clear();
        }
        removed
    };
    let (mut ordinary, mut lead) = (false, false);
    for (id, spare, pending) in removed {
        if spare.lead { lead = true } else { ordinary = true }
        retire(&id, spare, pending);
    }
    // Already counted by `remove`; these lines only report the totals.
    for (removed, is_lead) in [(ordinary, false), (lead, true)] {
        if removed {
            eprintln!("{}", discarded_note(pool, is_lead));
        }
    }
}

/// Kill the pooled spare, then wait (bounded by `await_exit`'s hard cap) until every process of the session
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
    quiesce_pool_spares_in(&SPARES, folder).await
}

async fn quiesce_in(pool: &Pool, session_id: &str) -> Result<(), String> {
    if let Some((spare, pending)) = take_for_discard(pool, session_id) {
        retire_now(session_id, spare, pending);
    }
    await_exit(session_id).await
}

fn discard_from(pool: &Pool, session_id: &str) {
    // Retired outside the lock; `Pending` was registered under the pool lock so `await_exit`
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

/// Pooled spares and in-flight starts (not yet cancelled) with their working directories, copied
/// under the pool lock so folder matching (`path_in_folder` may `canonicalize`) never runs with a
/// lock held.
struct InFolder {
    spares: Vec<(String, PathBuf)>,
    starting: Vec<(u64, String, PathBuf)>,
}

impl InFolder {
    fn snapshot(pool: &Pool) -> Self {
        let locked = spares(pool);
        Self {
            spares: locked.spares.iter().filter_map(|(id, spare)| Some((id.clone(), spare.cwd.clone()?))).collect(),
            starting: locked.starting.iter().filter(|(_, entry)| !entry.cancelled)
                .map(|(token, entry)| (*token, entry.session_id.clone(), entry.cwd.clone())).collect(),
        }
    }

    /// Only the entries inside `folder`. May touch the filesystem: never call it under a lock.
    fn within(self, folder: &Path) -> Self {
        if self.is_empty() {
            return self;
        }
        let resolved = resolve_path(folder);
        let inside = |cwd: &Path| path_in_folder(cwd, folder, &resolved);
        Self {
            spares: self.spares.into_iter().filter(|(_, cwd)| inside(cwd.as_path())).collect(),
            starting: self.starting.into_iter().filter(|(_, _, cwd)| inside(cwd.as_path())).collect(),
        }
    }

    /// `within`, on a blocking thread so the async runtime never waits on the filesystem.
    async fn within_off_runtime(self, folder: &Path) -> Result<Self, String> {
        if self.is_empty() {
            return Ok(self);
        }
        let folder = folder.to_path_buf();
        tokio::task::spawn_blocking(move || self.within(&folder))
            .await
            .map_err(|error| format!("Could not check this folder's warm agents: {error}"))
    }

    fn is_empty(&self) -> bool {
        self.spares.is_empty() && self.starting.is_empty()
    }
}

/// Drop the matched spares still pooled with the same working directory and cancel the matched
/// in-flight starts still present (kept until their guards drop, so `in_flight` never undercounts
/// them), advancing those sessions' launch epochs once so none can race back into the pool.
/// Returns the removed spares (to retire outside the lock) and the affected session IDs.
fn discard_within(pool: &Pool, within: InFolder) -> (Vec<(String, Spare, Pending)>, Vec<String>) {
    let mut locked = spares(pool);
    let ids: Vec<String> = within
        .spares
        .into_iter()
        .filter(|(id, cwd)| locked.spares.get(id).is_some_and(|spare| spare.cwd.as_ref() == Some(cwd)))
        .map(|(id, _)| id)
        .collect();
    let mut affected = ids.clone();
    for (token, id, _) in within.starting {
        let cancelled_now = locked.starting.get_mut(&token).is_some_and(|entry| !std::mem::replace(&mut entry.cancelled, true));
        if cancelled_now && !affected.contains(&id) {
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
    let removed = ids
        .into_iter()
        .filter_map(|id| locked.remove(&id, Gone::Discarded).map(|(spare, pending)| (id, spare, pending)))
        .collect();
    (removed, affected)
}

#[cfg(all(test, unix))]
fn take_for_discard_in(pool: &Pool, folder: &Path) -> (Vec<(String, Spare, Pending)>, Vec<String>) {
    discard_within(pool, InFolder::snapshot(pool).within(folder))
}

#[cfg(test)]
fn has_spare_in(pool: &Pool, folder: &Path) -> bool {
    !InFolder::snapshot(pool).within(folder).is_empty()
}

/// Retire every spare in `folder` (folder matching off the runtime and outside the pool lock),
/// wait for their exits, and look again until none is pooled or starting there.
async fn quiesce_pool_spares_in(pool: &Pool, folder: &Path) -> Result<(), String> {
    let wait = async {
        loop {
            let within = InFolder::snapshot(pool).within_off_runtime(folder).await?;
            let (removed, affected) = discard_within(pool, within);
            for (id, spare, pending) in removed {
                retire_now(&id, spare, pending);
            }
            if !affected.is_empty() {
                let results = futures_util::future::join_all(affected.iter().map(|id| await_exit(id))).await;
                if let Some(error) = results.into_iter().find_map(Result::err) {
                    return Err(error);
                }
            }
            await_exits_in(folder).await?;
            if InFolder::snapshot(pool).within_off_runtime(folder).await?.is_empty() {
                return Ok(());
            }
        }
    };
    tokio::time::timeout(EXIT_HARD_CAP, wait)
        .await
        .map_err(|_| "A previous run in this folder is still shutting down. Try again.".to_string())?
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod key_tests;
#[cfg(test)]
mod lifecycle_tests;
/// Each pool's eviction, unused-expiry and launch-time miss backoff.
#[cfg(test)]
mod churn_tests;

/// Regression coverage for the warm-spare switch and retirement races.
#[cfg(test)]
mod switch_tests;
/// Graceful background retirement and urgent session quiescence.
#[cfg(test)]
mod retire_tests;
