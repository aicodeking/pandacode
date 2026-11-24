//! Test-only helpers shared by the warm-spare test modules and, through `providers`, by other
//! modules' tests (`insert_spare_in_cwd_for_test` and its kin).
use super::spawn::{register, take_expired_for_renewal, Lead};
use super::*;

pub(in crate::providers) fn waiting(session_id: &str) -> bool {
    waiting_in(&SPARES, session_id)
}

pub(super) fn waiting_in(pool: &Pool, session_id: &str) -> bool {
    spares(pool).spares.contains_key(session_id)
}

pub(crate) fn spare_pool_test_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: LazyLock<tokio::sync::Mutex<()>> = LazyLock::new(|| tokio::sync::Mutex::new(()));
    &LOCK
}

pub(crate) fn insert_spare_in_cwd_for_test(session_id: &str, cwd: PathBuf, lead: bool) -> u32 {
    launched(session_id);
    let mut command = idle_sleep_command();
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
        born_wall: std::time::SystemTime::now(),
        idle: IDLE,
        lead,
        cwd: Some(external_path(&cwd)),
    };
    let registered = register(&SPARES, session_id, epoch(session_id), spare);
    assert!(registered, "test spare must register for {session_id}");
    pid
}

#[cfg(unix)]
pub(crate) fn has_spare_for_test(session_id: &str) -> bool {
    waiting_in(&SPARES, session_id)
}

#[cfg(unix)]
pub(crate) fn process_gone_for_test(pid: u32) -> bool {
    // SAFETY: signal 0 only checks that the process exists.
    unsafe { libc::kill(pid as i32, 0) == -1 }
}

/// `process_gone_for_test`, for the warm tests that poll it.
#[cfg(unix)]
pub(super) fn process_gone(pid: u32) -> bool {
    process_gone_for_test(pid)
}

/// After `await_exit`: on Windows the exit task already awaited the process handle (`child.wait()`).
pub(super) fn assert_process_gone(pid: u32) {
    #[cfg(unix)]
    assert!(process_gone_for_test(pid), "process {pid} still runs");
    #[cfg(windows)]
    let _ = pid;
}

/// An idle stand-in for a spare's CLI that runs about 30 s on every platform.
pub(super) fn idle_sleep_command() -> Command {
    #[cfg(unix)]
    let (program, args) = ("sleep", &["30"][..]);
    #[cfg(windows)]
    let (program, args) = ("ping", &["-n", "30", "127.0.0.1"][..]);
    let mut command = Command::new(program);
    command.args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).kill_on_drop(true);
    command
}

/// `take_since` for an ordinary launch with no switch-off since the pool's current discard epoch,
/// committing a match as `Adopting::into_parts` does (counted and logged as adopted).
pub(super) fn take_in(pool: &Pool, session_id: &str, key: &str, ordinary_eligible: bool) -> (Option<(Spare, Pending)>, Option<String>) {
    let discard_epoch = spares(pool).discard_epoch;
    let (spare, note) = take_since(pool, session_id, key, ordinary_eligible, false, discard_epoch);
    let note = note.or_else(|| spare.as_ref().map(|(spare, _)| record_adopted(pool, spare.lead)));
    (spare, note)
}

/// A supported ordinary launch as `run_process_launch` makes it with spares on: `prepare_launch_in`,
/// then the cold launch counted when the pool allows it. Whether a spare is pooled, and the line logged.
pub(super) fn launch_in(pool: &Pool, session_id: &str, ordinary_eligible: bool) -> (bool, Option<String>) {
    match prepare_launch_in(pool, session_id, ordinary_eligible, false) {
        (LaunchPool::Pooled { .. }, note) => (true, note),
        (LaunchPool::Empty { may_record_cold: true, lead }, None) => (false, Some(cold_without_spare_note(&mut spares(pool), lead))),
        (LaunchPool::Empty { .. }, note) => (false, note),
    }
}

/// Non-renewing expiry used by the process-retirement tests.
pub(super) fn take_expired(pool: &'static Pool, session_id: &str, born: std::time::Instant) -> Option<(Spare, Pending)> {
    take_expired_for_renewal(pool, session_id, born, false).map(|(spare, pending, _)| (spare, pending))
}

/// `launched_without_key_since` for an ordinary launch with no switch-off since the pool's
/// current discard epoch.
pub(super) fn launched_without_key_in(pool: &Pool, session_id: &str, why: &str, ordinary_eligible: bool) -> Option<String> {
    let discard_epoch = spares(pool).discard_epoch;
    launched_without_key_since(pool, session_id, why, ordinary_eligible, false, discard_epoch)
}

/// Removes a test's temporary folder when dropped, so a failed assertion never leaks it.
pub(super) struct TempDir(pub(super) PathBuf);

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// An idle spare that has waited `age` on both clocks.
pub(super) fn idle_spare(lead: bool, age: Duration) -> Spare {
    let child = idle_sleep_command().spawn().unwrap();
    let born = std::time::Instant::now().checked_sub(age).unwrap_or_else(std::time::Instant::now);
    let born_wall = std::time::SystemTime::now().checked_sub(age).unwrap_or_else(std::time::SystemTime::now);
    Spare { key: "launch".into(), child, group: ProcessGroup::register(None), server: None, born, born_wall, idle: IDLE, lead, cwd: None }
}

/// A pool of the test's own, so tests running in parallel never share spares.
pub(super) fn own_pool() -> &'static Pool {
    Box::leak(Box::default())
}

/// Spares the stub lifecycle started, per task.
static STUB_STARTS: LazyLock<Mutex<HashMap<String, u32>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// A stand-in for Claude Code: an idle process (`idle_sleep_command`), counted per task. Its start
/// guard is registered like production's and dropped right after `register`.
pub(super) fn stub_spawn(config: RunConfig, _: Vec<Value>, _: HashSet<String>, _: u64, _: bool) -> Spawning {
    Box::pin(async move {
        *STUB_STARTS.lock().unwrap().entry(config.session_id.clone()).or_default() += 1;
        let child = idle_sleep_command().spawn().map_err(|error| error.to_string())?;
        let starting = pending_in_cwd(&config.session_id, None);
        Ok(Some(Spawned { key: "stub".to_owned(), child, group: ProcessGroup::register(None), server: None, starting }))
    })
}

/// A lead's renewal check whose launch inputs never change.
pub(super) fn lead(renew: Renew) -> Option<Lead> {
    Some((renew, Arc::new(String::new)))
}

/// The stub lifecycle with a pool of its own.
pub(super) fn stub() -> Lifecycle {
    Lifecycle { idle: Duration::from_millis(400), spawn: stub_spawn, current: |_, _, _, _, _| true, pool: own_pool() }
}

pub(super) fn stub_starts(session: &str) -> u32 {
    STUB_STARTS.lock().unwrap().get(session).copied().unwrap_or(0)
}

/// Waits (up to 20 s) until `done` holds.
pub(super) async fn eventually(done: impl Fn() -> bool) -> bool {
    for _ in 0..400 {
        if done() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    done()
}

pub(super) fn pid_of(spare: &Spare) -> u32 {
    spare.child.id().unwrap()
}

/// The reason `launched_without_key` logs when the config folder cannot be resolved.
pub(super) const NO_CONFIG: &str = "its config folder cannot be known";

/// What a supported ordinary launch with no pooled spare (and no lead `gone` note) logs.
pub(super) const NOT_POOLED: &str = "Warm Claude agent not pooled; starting cold.";

/// A legacy connection keeping `name` (a folder variable) as a secret, whose value is never read.
pub(super) fn legacy_secret_connection(name: &str) -> crate::connections::Connection {
    crate::connections::Connection {
        id: "legacy".into(),
        provider: "claude".into(),
        name: "Legacy".into(),
        executable: None,
        args: vec![],
        env: Default::default(),
        secret_env: vec![name.into()],
        config_dir: None,
        revision: 1,
    }
}
