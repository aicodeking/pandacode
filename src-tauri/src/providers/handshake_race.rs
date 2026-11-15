//! A send taking its handshake spare: waiting for one still starting, racing one slow to
//! answer `initialize` with the send's own launch, and waiting for a Codex spare that already
//! answered and is loading the task's thread (`codex_preload.rs`).
use super::*;

/// A spare's thread fits a send that would load `thread` if it loaded exactly that one, or none
/// (an `initialize`-only spare serves any send).
fn fits(spare: Option<&str>, thread: Option<&str>) -> bool {
    spare.is_none() || spare == thread
}

/// A spare for exactly this launch is starting.
fn starting_for(session_id: &str, key: &str, thread: Option<&str>) -> bool {
    state().starting.get(session_id).is_some_and(|(_, starting, _, loads)| starting == key && fits(loads.as_deref(), thread))
}

/// A spare for exactly this launch is starting and its process already runs.
fn spawned_at(session_id: &str, key: &str, thread: Option<&str>) -> Option<std::time::Instant> {
    let state = state();
    let (generation, starting, _, loads) = state.starting.get(session_id)?;
    let (spawned, at) = state.spawned.get(session_id)?;
    (starting == key && fits(loads.as_deref(), thread) && spawned == generation).then_some(*at)
}

/// A spare for exactly this launch answered `initialize` and is loading its thread.
fn loading(session_id: &str, key: &str, thread: Option<&str>) -> bool {
    let state = state();
    let current = state.starting.get(session_id).filter(|(_, starting, _, loads)| starting == key && fits(loads.as_deref(), thread));
    current.is_some_and(|(generation, ..)| state.loading.get(session_id) == Some(generation))
}

/// The task's spare, if it was started for exactly this launch (`key`, and `thread`: the Codex
/// thread the send would load, `codex_preload::thread_key`) and still runs. A spare for any
/// other launch is discarded without being waited for.
pub(in crate::providers) async fn take(session_id: &str, key: &str, thread: Option<&str>, cold: Option<Cold<'_>>) -> Option<Spare> {
    // A spare for exactly this launch may still be starting (or a first start debouncing):
    // wait until it is ready, has failed, its process runs, or `GRACE` has passed.
    warm::hurry(session_id);
    let grace = tokio::time::Instant::now() + GRACE;
    warm::wait_while(grace, || warm::pending_ticket(session_id) || (starting_for(session_id, key, thread) && spawned_at(session_id, key, thread).is_none())).await;
    if let Some(spawned) = spawned_at(session_id, key, thread).filter(|_| !loading(session_id, key, thread)) {
        match cold {
            // Its process runs: race it with the send's own launch once that would be as fast.
            Some(cold) => {
                let from = tokio::time::Instant::from_std(spawned + COLD_BUDGET).min(grace);
                return race(session_id, key, thread, from, cold).await;
            }
            None => warm::wait_while(tokio::time::Instant::now() + SPAWNED, || starting_for(session_id, key, thread) && !loading(session_id, key, thread)).await,
        }
    }
    if loading(session_id, key, thread) {
        return loaded(session_id, key, thread).await;
    }
    ready(session_id, key, thread).await
}

/// Wait for a spare loading this send's thread: a cold launch would have to load it too. Only
/// a load that fails or outlasts its own bound (`codex_preload::LOAD`) leaves the send cold.
async fn loaded(session_id: &str, key: &str, thread: Option<&str>) -> Option<Spare> {
    warm::wait_while(tokio::time::Instant::now() + super::codex_preload::LOAD, || starting_for(session_id, key, thread)).await;
    if starting_for(session_id, key, thread) {
        eprintln!("Warm Codex thread still loading; starting cold.");
        turn_away(session_id);
        return None;
    }
    ready(session_id, key, thread).await
}

/// Use whichever answers `initialize` first: the spare, or the send's own launch begun at
/// `from`. The other is killed (the launch future is dropped; the spare's start is turned
/// away). A send is so never much slower than a cold start because of a stalled spare. Once
/// the spare has answered and loads its thread, the send's launch is dropped and the load
/// waited for (`loaded`).
async fn race(session_id: &str, key: &str, thread: Option<&str>, from: tokio::time::Instant, cold: Cold<'_>) -> Option<Spare> {
    let Cold { command, cwd, provider } = cold;
    let request = initialize_request(provider);
    let spare_ready = warm::wait_while(tokio::time::Instant::now() + SPAWNED, || starting_for(session_id, key, thread) && !loading(session_id, key, thread));
    // Boxed, so it can be dropped (killing its process) while the spare's load is waited for.
    let mut launch = Box::pin(async move {
        tokio::time::sleep_until(from).await;
        start_from(command, cwd, &request, || {}).await
    });
    tokio::pin!(spare_ready);
    let adopted = |(child, group, pending, early_stderr)| Spare {
        key: key.to_owned(),
        child,
        group,
        pending,
        born: std::time::Instant::now(),
        reader: None,
        early_stderr,
        provider: provider.to_owned(),
        thread: None,
    };
    tokio::select! {
        _ = &mut spare_ready => {
            if loading(session_id, key, thread) {
                drop(launch);
                return loaded(session_id, key, thread).await;
            }
            if let Some(spare) = ready(session_id, key, thread).await {
                return Some(spare);
            }
            // The spare failed or stalled: the send's own launch is already on its way.
            launch.await.ok().map(adopted)
        }
        started = &mut launch => {
            // The send's launch won: the stalled start is turned away (its process is killed
            // when it finishes) and the launch is used as the spare would have been.
            turn_away(session_id);
            match started {
                Ok(started) => Some(adopted(started)),
                Err(error) => {
                    eprintln!("A cold start raced with a warm agent failed ({error}).");
                    None
                }
            }
        }
    }
}

/// End the task's start in flight: its spare is not kept, and a thread it loads is abandoned.
pub(super) fn turn_away(session_id: &str) {
    let mut state = state();
    state.starting.remove(session_id);
    state.spawned.remove(session_id);
    state.loading.remove(session_id);
    drop(state);
    warm::changed();
}

/// The task's waiting spare, if it fits this launch and still runs.
async fn ready(session_id: &str, key: &str, thread: Option<&str>) -> Option<Spare> {
    let mut spare = {
        let mut state = state();
        state.starting.remove(session_id);
        state.loading.remove(session_id);
        state.spares.remove(session_id)?
    };
    let alive = matches!(spare.child.try_wait(), Ok(None));
    // The key is not JSON, so a changed launch is never itemized (it holds environment values).
    let reason = match warm::miss(alive, &spare.key, key, spare.born.elapsed()) {
        None if !fits(super::codex_preload::key_of(spare.thread.as_ref()), thread) => "it loaded another thread".to_string(),
        None => match settle(spare).await {
            Ok(spare) => return Some(spare),
            Err(reason) => reason,
        },
        Some(reason) => reason,
    };
    eprintln!("Warm agent not used ({reason}); starting cold.");
    None
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn spare(key: &str, thread: Option<&str>) -> Spare {
        let child = Command::new("sleep").arg("30").stdin(Stdio::piped()).stdout(Stdio::piped()).kill_on_drop(true).spawn().unwrap();
        let thread = thread.map(super::super::codex_preload::preloaded_for_test);
        Spare { key: key.into(), child, group: ProcessGroup::register(None), pending: Vec::new(), born: std::time::Instant::now(), reader: None, early_stderr: Vec::new(), provider: "codex".into(), thread }
    }

    fn claim_for(id: &str, thread: Option<&'static str>, ticket: Option<u64>, launch: u64) -> Option<u64> {
        claim_thread(id, Claim { key: "launch-a", provider: "codex", thread, ticket, launch })
    }

    #[tokio::test]
    async fn a_start_outdated_by_another_launch_is_neither_claimed_nor_kept() {
        let id = "codex-warm-epoch";
        let launch = warm::epoch(id);
        let generation = claim_for(id, Some("thread-a"), None, launch).expect("a start");
        // The next turn begins while it loads: it counts, then drops what it did not take.
        crate::providers::warm_launched(id);
        assert!(!store(id, generation, launch, Some(spare("launch-a", Some("thread-a")))), "its thread would miss that turn");
        assert!(take(id, "launch-a", Some("thread-a"), None).await.is_none(), "a later send never adopts it");
        assert!(claim_for(id, Some("thread-a"), None, launch).is_none(), "nor may a start claim after that launch");
        // A debounced start whose ticket a newer pick replaced claims nothing either.
        let ticket = warm::reserve(id);
        warm::reserve(id);
        assert!(claim_for(id, Some("thread-a"), Some(ticket), warm::epoch(id)).is_none());
        warm::cancel_ticket(id);
        discard(id);
    }

    #[tokio::test]
    async fn a_spare_for_another_thread_is_replaced_and_never_waited_for() {
        let id = "codex-warm-other-thread";
        let launch = warm::epoch(id);
        let a = claim_for(id, Some("thread-a"), None, launch).expect("a start");
        // A switch that changes the load starts anew, even with the same command line.
        let b = claim_for(id, Some("thread-b"), None, launch).expect("another thread starts anew");
        assert!(b > a);
        assert!(claim_for(id, Some("thread-b"), None, launch).is_none(), "that thread is already starting");
        // A send for thread-a does not wait for the start loading thread-b.
        let started = std::time::Instant::now();
        assert!(take(id, "launch-a", Some("thread-a"), None).await.is_none());
        assert!(started.elapsed() < Duration::from_millis(500), "no wait-then-cold: {:?}", started.elapsed());
        assert!(!store(id, b, launch, Some(spare("launch-a", Some("thread-b")))), "and that start is turned away");
        // A waiting spare with another thread is discarded unused; one that loaded none fits.
        state().spares.insert(id.into(), spare("launch-a", Some("thread-b")));
        assert!(take(id, "launch-a", Some("thread-a"), None).await.is_none());
        assert!(!present(id));
        state().spares.insert(id.into(), spare("launch-a", None));
        let mut adopted = take(id, "launch-a", Some("thread-a"), None).await.expect("an initialize-only spare serves any send");
        adopted.child.kill().await.unwrap();
        warm::launch_settled(id);
    }

    #[tokio::test]
    async fn a_send_arriving_mid_load_adopts_the_spare_once_it_has_loaded() {
        let id = "codex-warm-mid-load";
        let dir = std::env::temp_dir().join(format!("codex-warm-mid-load-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let launch = warm::epoch(id);
        let generation = claim_for(id, Some("thread-a"), None, launch).expect("a start");
        spawned(id, generation);
        // It answered `initialize` and loads its thread past the point a cold launch would race.
        mark_loading(id, generation);
        tokio::spawn(async move {
            tokio::time::sleep(COLD_BUDGET + Duration::from_millis(1000)).await;
            assert!(store(id, generation, launch, Some(spare("launch-a", Some("thread-a")))));
        });
        let mut command = Command::new("sh");
        command.args(["-c", r#": > "$1"; IFS= read -r line; printf '%s\n' '{"id":1,"result":{}}'; while IFS= read -r line; do :; done"#, "fake-cold"]).arg(dir.join("cold"));
        let started = std::time::Instant::now();
        let mut adopted = take(id, "launch-a", Some("thread-a"), Some(Cold { command: &mut command, cwd: &dir, provider: "codex" })).await.expect("the loaded spare");
        assert!(adopted.thread.is_some(), "the spare with its thread, not a cold launch");
        assert!(started.elapsed() >= COLD_BUDGET + Duration::from_millis(900), "it waited for the load");
        assert!(!dir.join("cold").exists(), "the send's own launch never ran");
        adopted.child.kill().await.unwrap();
        warm::launch_settled(id);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_stalled_spare_is_raced_by_the_sends_own_launch() {
        let id = "codex-warm-spawned-stuck";
        let dir = std::env::temp_dir().join(format!("codex-warm-race-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let generation = claim(id, "launch-a", "codex").unwrap();
        spawned(id, generation);
        // Its `initialize` never answers: the send's own launch starts once a cold start would
        // be as fast, answers, and is used; the stalled start is turned away.
        let mut command = fake_initialize(&dir.join("cold"));
        let started = std::time::Instant::now();
        let mut adopted = take(id, "launch-a", None, Some(Cold { command: &mut command, cwd: &dir, provider: "codex" })).await.expect("the cold launch won");
        let waited = started.elapsed();
        assert!(waited >= COLD_BUDGET && waited < COLD_BUDGET + Duration::from_millis(700), "about a cold start, not 6.5 s: {waited:?}");
        assert!(String::from_utf8_lossy(&adopted.pending).contains("\"id\":1"), "its reply is replayed");
        assert!(!present(id) && !state().starting.contains_key(id));
        assert!(!store(id, generation, warm::epoch(id), None), "the stalled start is not kept when it ends");
        adopted.child.kill().await.unwrap();
        warm::launch_settled(id);
        // A spare that answers first is used, and the send's launch never starts.
        let generation = claim(id, "launch-a", "codex").unwrap();
        spawned(id, generation);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(400)).await;
            assert!(store(id, generation, warm::epoch(id), Some(spare("launch-a", None))));
        });
        let mut command = fake_initialize(&dir.join("unused"));
        let mut adopted = take(id, "launch-a", None, Some(Cold { command: &mut command, cwd: &dir, provider: "codex" })).await.expect("the spare won");
        assert_eq!(adopted.key, "launch-a");
        assert!(!dir.join("unused").exists(), "the send's own launch never ran");
        adopted.child.kill().await.unwrap();
        warm::launch_settled(id);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn startup_stderr_is_drained_when_the_cold_contender_wins() {
        let id = "startup-stderr-cold";
        let cwd = std::env::temp_dir();
        let generation = claim(id, "startup", "codex").unwrap();
        spawned(id, generation);
        let mut command = handshake_spare::startup_stderr_command("answer");
        let started = std::time::Instant::now();
        let result = tokio::time::timeout(Duration::from_secs(4), take(id, "startup", None, Some(Cold { command: &mut command, cwd: &cwd, provider: "codex" }))).await;
        let mut adopted = match result {
            Ok(Some(spare)) => spare,
            _ => {
                turn_away(id);
                warm::launch_settled(id);
                panic!("startup stderr must not block the raced cold initialize");
            }
        };
        adopted.child.kill().await.unwrap();
        warm::launch_settled(id);
        assert!(started.elapsed() >= COLD_BUDGET && started.elapsed() < Duration::from_secs(4));
        assert_eq!(adopted.early_stderr.len(), EARLY_STDERR);
        assert!(adopted.early_stderr.ends_with(b"latest startup diagnostic\n"));
        assert_eq!(String::from_utf8(adopted.pending).unwrap(), "{\"method\":\"configWarning\",\"params\":{}}\n{\"id\":1,\"result\":{}}\n");
        assert!(!present(id) && !state().starting.contains_key(id));
    }

    /// A harness that answers `initialize` at once, after creating `$1`.
    fn fake_initialize(marker: &Path) -> Command {
        let mut command = Command::new("sh");
        command.args(["-c", r#": > "$1"; IFS= read -r line; printf '%s\n' '{"id":1,"result":{}}'; while IFS= read -r line; do :; done"#, "fake-cold"]).arg(marker);
        command
    }
}
