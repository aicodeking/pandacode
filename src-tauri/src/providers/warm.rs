//! Warm agents: after a Claude turn ends, the next turn's process starts in the background
//! so a follow-up skips the CLI's own startup (about 1.4 s). A warm agent is adopted only
//! when everything on its command line and in its tool catalog still matches; otherwise it
//! is discarded and the turn starts cold as before.
use super::*;
use std::sync::{atomic::{AtomicU64, Ordering}, LazyLock};

/// A warm agent waits at most this long for its follow-up.
const IDLE: Duration = Duration::from_secs(90);
/// Each one holds an idle CLI process, so only the most recent tasks keep one.
const LIMIT: usize = 1;
static PREPARING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
/// Invalidates preparation that was in flight when concurrent admission retired spares.
static RETIREMENTS: AtomicU64 = AtomicU64::new(0);

pub fn has_capacity(running: usize) -> bool {
    running < 2
}

pub(super) struct Spare {
    key: String,
    cwd: PathBuf,
    pub(super) child: Child,
    pub(super) group: ProcessGroup,
    pub(super) server: Option<mcp_host::Server>,
    born: std::time::Instant,
}

static SPARES: LazyLock<Mutex<HashMap<String, Spare>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
/// Counts each task's Claude launches. A spare started for launch N is useless once launch N+1
/// has begun: it would resume the conversation without that turn.
static LAUNCHES: LazyLock<Mutex<HashMap<String, u64>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// The task's current launch count, read when a turn ends and before the next can begin.
pub fn epoch(session_id: &str) -> u64 {
    LAUNCHES.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).get(session_id).copied().unwrap_or(0)
}

fn spares() -> std::sync::MutexGuard<'static, HashMap<String, Spare>> {
    SPARES.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
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

/// The warm agent for this turn, if one exists, is still running and was started for
/// exactly this launch. Any other warm agent for the task is discarded.
/// Every launch of the task counts, with or without a spare to adopt.
pub(super) fn launched(session_id: &str) {
    *LAUNCHES.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).entry(session_id.to_owned()).or_default() += 1;
}

pub(super) fn take(session_id: &str, key: &str) -> Option<Spare> {
    launched(session_id);
    let mut spare = spares().remove(session_id)?;
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

/// Why a warm agent cannot take this launch, if it cannot.
fn miss(alive: bool, spare_key: &str, key: &str, age: Duration) -> Option<String> {
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

/// Drop a task's warm agent (its settings changed, or it was deleted) and cancel any prewarm in flight.
pub fn discard(session_id: &str) {
    launched(session_id);
    spares().remove(session_id);
}

/// Drop every warm agent running inside `folder` (worktree or chat folder removal) and cancel in-flight prewarms.
pub fn discard_in(folder: &Path) {
    let folder = folder.canonicalize().unwrap_or_else(|_| folder.to_owned());
    let removed: Vec<Spare> = {
        let mut spares = spares();
        RETIREMENTS.fetch_add(1, Ordering::SeqCst);
        let keys: Vec<String> = spares
            .iter()
            .filter(|(_, spare)| spare.cwd.starts_with(&folder))
            .map(|(session_id, _)| session_id.clone())
            .collect();
        keys.into_iter()
            .filter_map(|session_id| {
                launched(&session_id);
                spares.remove(&session_id)
            })
            .collect()
    };
    drop(removed);
}

/// Drop a deleted task's warm agent and remove its launch counter so deleted tasks/drafts leave no map entry.
pub fn forget_session(session_id: &str) {
    discard(session_id);
    {
        let mut spares = spares();
        RETIREMENTS.fetch_add(1, Ordering::SeqCst);
        spares.remove(session_id);
    }
    LAUNCHES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(session_id);
}

/// Called under the agents lock after admission; a matching spare is still adoptable.
pub fn retire_unrelated(session_id: &str, running: usize) {
    if !has_capacity(running) {
        let mut spares = spares();
        RETIREMENTS.fetch_add(1, Ordering::SeqCst);
        spares.retain(|task, _| task == session_id);
    }
}

/// Start the next turn's agent for a task. `tools` is the catalog its last turn used; the
/// placeholder server answers the agent's startup listing and is rebound on adoption.
pub async fn prewarm(config: RunConfig, tools: Vec<Value>, approval_tools: HashSet<String>, launch: u64, can_start: impl Fn() -> bool) -> Result<(), String> {
    let _preparing = PREPARING.lock().await;
    let result = start(config, tools, approval_tools, launch, can_start).await;
    if let Err(error) = &result {
        eprintln!("Could not prepare a warm Claude agent: {error}");
    }
    result
}

async fn start(mut config: RunConfig, tools: Vec<Value>, approval_tools: HashSet<String>, launch: u64, can_start: impl Fn() -> bool) -> Result<(), String> {
    let retirement = RETIREMENTS.load(Ordering::SeqCst);
    if !supported(&config) || !can_start() {
        return Ok(());
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
    if !can_start() || epoch(&config.session_id) != launch {
        return Ok(());
    }
    let cwd = PathBuf::from(&config.cwd)
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from(&config.cwd));
    let born = std::time::Instant::now();
    let session_id = config.session_id.clone();
    {
        let mut spares = spares();
        // Admission and publication share this lock, so no in-flight spare survives retirement.
        if epoch(&session_id) != launch || RETIREMENTS.load(Ordering::SeqCst) != retirement {
            return Ok(());
        }
        // Retire the old spare before spawning, so replacement never doubles the idle CLIs.
        make_room(&mut spares);
        let child = command.spawn().map_err(|e| format!("Could not start Claude Code: {e}"))?;
        let group = ProcessGroup::register(child.id());
        spares.insert(session_id.clone(), Spare { key, cwd, child, group, server, born });
    }
    tokio::spawn(async move {
        tokio::time::sleep(IDLE).await;
        let mut spares = spares();
        if spares.get(&session_id).is_some_and(|spare| spare.born == born) {
            spares.remove(&session_id);
        }
    });
    Ok(())
}

fn make_room(spares: &mut HashMap<String, Spare>) {
    while spares.len() >= LIMIT {
        let Some(oldest) = spares.iter().min_by_key(|(_, spare)| spare.born).map(|(id, _)| id.clone()) else { break };
        spares.remove(&oldest);
    }
}

#[cfg(test)]
pub(super) fn waiting(session_id: &str) -> bool {
    spares().contains_key(session_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    static TEST_SPARES_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    #[test]
    fn warm_policy_skips_busy_agents_and_expires_after_ninety_seconds() {
        assert!(has_capacity(0));
        assert!(has_capacity(1));
        assert!(!has_capacity(2));
        assert!(!has_capacity(20));
        assert_eq!(LIMIT, 1);
        assert_eq!(miss(true, "same", "same", Duration::from_secs(89)), None);
        assert_eq!(miss(true, "same", "same", Duration::from_secs(90)).as_deref(), Some("it expired"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn replacing_a_warm_agent_retires_it_before_starting_another() {
        let mut child = Command::new("sleep");
        child.arg("30").kill_on_drop(true);
        let mut spares = HashMap::from([("previous".into(), Spare {
            key: "same".into(), cwd: std::env::temp_dir(), child: child.spawn().unwrap(), group: ProcessGroup::register(None),
            server: None, born: std::time::Instant::now(),
        })]);
        make_room(&mut spares);
        assert!(spares.is_empty(), "no old CLI survives to overlap its replacement");
        let config = crate::providers::tests::config("claude");
        prewarm(config, vec![], HashSet::new(), 0, || has_capacity(2)).await.unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn admission_retires_unrelated_warm_process_trees_under_load() {
        use tokio::io::AsyncBufReadExt;
        let _guard = TEST_SPARES_LOCK.lock().await;
        let store = crate::Store::open(Path::new(":memory:")).unwrap();
        let project = store.add_project(&std::env::temp_dir()).unwrap();
        let owner = store.create_session(&project.id, "claude", "sonnet", "ask").unwrap();
        let others: Vec<_> = (0..5).map(|_| store.create_session(&project.id, "claude", "sonnet", "ask").unwrap()).collect();
        let state = crate::AppState {
            store: Arc::new(Mutex::new(store)), agents: Arc::new(Mutex::new(HashMap::new())),
            terminals: Default::default(), shutdown: std::sync::atomic::AtomicU8::new(0),
        };
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "sleep 30 & echo $!; wait"]).stdout(Stdio::piped()).kill_on_drop(true).process_group(0);
        let mut child = command.spawn().unwrap();
        let pid = child.id().unwrap();
        let descendant: i32 = tokio::io::BufReader::new(child.stdout.take().unwrap()).lines().next_line().await.unwrap().unwrap().parse().unwrap();
        spares().insert(owner.id.clone(), Spare {
            key: "same".into(), cwd: std::env::temp_dir(), child, group: ProcessGroup::register(Some(pid)), server: None, born: std::time::Instant::now(),
        });
        let mut waiting_after_admission = Vec::new();
        for task in &others {
            let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
            crate::prepare_task_run(&state, task.id.clone(), Some("hello".into()), vec![], tx, Arc::new(std::sync::atomic::AtomicBool::new(false))).unwrap();
            waiting_after_admission.push(waiting(&owner.id));
        }
        // Clean up even when the regression assertion fails.
        discard(&owner.id);
        let mut command = Command::new("sleep");
        command.arg("30").kill_on_drop(true).process_group(0);
        let child = command.spawn().unwrap();
        let group = ProcessGroup::register(child.id());
        spares().insert(owner.id.clone(), Spare { key: "same".into(), cwd: std::env::temp_dir(), child, group, server: None, born: std::time::Instant::now() });
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        crate::prepare_task_run(&state, owner.id.clone(), Some("hello".into()), vec![], tx, Arc::new(std::sync::atomic::AtomicBool::new(false))).unwrap();
        let adopted = take(&owner.id, "same");
        assert!(adopted.is_some(), "the admitted task keeps its own spare under load");
        drop(adopted);
        assert_eq!(waiting_after_admission, [true, false, false, false, false]);
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while (unsafe { libc::kill(pid as i32, 0) } == 0 || unsafe { libc::kill(descendant, 0) } == 0) && std::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(unsafe { libc::kill(pid as i32, 0) }, -1, "the warm CLI is reaped");
        assert_eq!(unsafe { libc::kill(descendant, 0) }, -1, "its descendant is retired too");
    }

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
        assert!(!supported(&crate::providers::tests::config("glm")));
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
    #[tokio::test]
    async fn a_mismatched_or_exited_warm_agent_is_discarded() {
        let _guard = TEST_SPARES_LOCK.lock().await;
        let spawn = || {
            let mut command = Command::new("sleep");
            command.arg("30").kill_on_drop(true);
            let child = command.spawn().unwrap();
            let group = ProcessGroup::register(None);
            (child, group)
        };
        let (child, group) = spawn();
        spares().insert("warm-test".into(), Spare { key: "launch-a".into(), cwd: std::env::temp_dir(), child, group, server: None, born: std::time::Instant::now() });
        assert!(take("warm-test", "launch-b").is_none(), "a different launch starts cold");
        assert!(!waiting("warm-test"), "and the stale agent is gone");
        let (child, group) = spawn();
        spares().insert("warm-test".into(), Spare { key: "launch-a".into(), cwd: std::env::temp_dir(), child, group, server: None, born: std::time::Instant::now() });
        let mut adopted = take("warm-test", "launch-a").expect("the matching agent is adopted");
        adopted.child.kill().await.unwrap();
        let (mut child, group) = spawn();
        child.kill().await.unwrap();
        child.wait().await.unwrap();
        spares().insert("warm-test".into(), Spare { key: "launch-a".into(), cwd: std::env::temp_dir(), child, group, server: None, born: std::time::Instant::now() });
        assert!(take("warm-test", "launch-a").is_none(), "an agent that exited is never adopted");
        forget_session("warm-test");
    }

    #[test]
    fn discarding_a_warm_agent_invalidates_in_flight_prewarm_epoch() {
        let before = epoch("warm-epoch-discard");
        discard("warm-epoch-discard");
        assert!(epoch("warm-epoch-discard") > before, "discard bumps the launch epoch so in-flight prewarm cancels");
        forget_session("warm-epoch-discard");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn discard_in_reaps_spares_inside_target_folder_and_keeps_unrelated_spares() {
        let _guard = TEST_SPARES_LOCK.lock().await;
        let root = std::env::temp_dir().join(format!("pandacode-warm-discard-in-{}", uuid::Uuid::new_v4()));
        let target = root.join("worktree-a");
        let nested = target.join("sub");
        let unrelated = root.join("worktree-b");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::create_dir_all(&unrelated).unwrap();

        let spawn_in = |cwd: &Path| {
            let mut command = Command::new("sleep");
            command.arg("30").kill_on_drop(true).process_group(0);
            let child = command.spawn().unwrap();
            let pid = child.id().unwrap();
            let group = ProcessGroup::register(Some(pid));
            let spare = Spare {
                key: "launch".into(),
                cwd: cwd.canonicalize().unwrap(),
                child,
                group,
                server: None,
                born: std::time::Instant::now(),
            };
            (spare, pid)
        };

        let (target_spare, target_pid) = spawn_in(&target);
        let (nested_spare, nested_pid) = spawn_in(&nested);
        let (other_spare, other_pid) = spawn_in(&unrelated);

        spares().insert("warm-in-target".into(), target_spare);
        spares().insert("warm-in-nested".into(), nested_spare);
        spares().insert("warm-unrelated".into(), other_spare);

        let target_epoch_before = epoch("warm-in-target");
        let nested_epoch_before = epoch("warm-in-nested");
        let other_epoch_before = epoch("warm-unrelated");
        let retirements_before = RETIREMENTS.load(Ordering::SeqCst);

        discard_in(&target);

        assert!(!waiting("warm-in-target"), "spare directly in target folder is removed");
        assert!(!waiting("warm-in-nested"), "spare in nested subfolder is removed");
        assert!(waiting("warm-unrelated"), "unrelated spare outside target folder stays warm");
        assert!(epoch("warm-in-target") > target_epoch_before);
        assert!(epoch("warm-in-nested") > nested_epoch_before);
        assert_eq!(epoch("warm-unrelated"), other_epoch_before);
        assert!(RETIREMENTS.load(Ordering::SeqCst) > retirements_before);

        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while (unsafe { libc::kill(target_pid as i32, 0) } == 0
            || unsafe { libc::kill(nested_pid as i32, 0) } == 0)
            && std::time::Instant::now() < deadline
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(unsafe { libc::kill(target_pid as i32, 0) }, -1);
        assert_eq!(unsafe { libc::kill(nested_pid as i32, 0) }, -1);
        assert_eq!(unsafe { libc::kill(other_pid as i32, 0) }, 0);

        forget_session("warm-in-target");
        forget_session("warm-in-nested");
        forget_session("warm-unrelated");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn forget_session_removes_task_from_spares_and_launches() {
        let _guard = TEST_SPARES_LOCK.lock().await;
        let mut command = Command::new("sleep");
        command.arg("30").kill_on_drop(true).process_group(0);
        let child = command.spawn().unwrap();
        let pid = child.id().unwrap();
        let group = ProcessGroup::register(Some(pid));

        spares().insert(
            "warm-forget-target".into(),
            Spare {
                key: "launch".into(),
                cwd: std::env::temp_dir(),
                child,
                group,
                server: None,
                born: std::time::Instant::now(),
            },
        );
        launched("warm-forget-target");
        launched("warm-forget-keep");
        assert!(waiting("warm-forget-target"));
        assert!(LAUNCHES.lock().unwrap().contains_key("warm-forget-target"));

        let retirements_before = RETIREMENTS.load(Ordering::SeqCst);
        forget_session("warm-forget-target");

        assert!(!waiting("warm-forget-target"), "spare is removed from SPARES");
        assert!(
            !LAUNCHES.lock().unwrap().contains_key("warm-forget-target"),
            "launch counter is removed from LAUNCHES"
        );
        assert_eq!(epoch("warm-forget-target"), 0);
        assert!(RETIREMENTS.load(Ordering::SeqCst) > retirements_before);
        assert!(LAUNCHES.lock().unwrap().contains_key("warm-forget-keep"));

        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while unsafe { libc::kill(pid as i32, 0) } == 0 && std::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(unsafe { libc::kill(pid as i32, 0) }, -1);

        forget_session("warm-forget-keep");
    }
}
