//! Warm Codex and ACP agents: start and initialize the harness before a task's next send.
//! ACP spares stop after `initialize`, with no conversation state. Codex spares can also
//! preload a saved thread (`codex_preload.rs`). Adoption checks the command, environment,
//! folder and harness config/login files, plus any preloaded thread (`handshake_race.rs`).
//! Grok and Kimi put the model on the command line, so a model switch starts a new spare.
//! Cline is excluded because its MCP settings file is per-run. Starts are ordered by
//! generations from `warm::next_generation` and debounced by its tickets (see `warm.rs`).
use super::*;
use std::sync::LazyLock;

#[path = "handshake_key.rs"]
mod handshake_key;
#[path = "handshake_spare.rs"]
mod handshake_spare;
#[path = "handshake_race.rs"]
mod handshake_race;
pub(super) use handshake_race::take;
use handshake_spare::{listen, settle, start, start_from, Reader};
pub(super) use handshake_spare::EARLY_STDERR;
pub(super) use handshake_key::{key, shape};

/// A spare that has not answered `initialize` by then is dropped.
const INITIALIZE: Duration = Duration::from_secs(20);
/// Initial wait for an exact launch still debouncing or not yet spawned. Initialization
/// races and bounded Codex thread-load waits are separate (`handshake_race.rs`).
const GRACE: Duration = Duration::from_millis(1500);
/// A send without its own launch to race (`Cold`) waits at most this much longer for a spare
/// whose process already runs.
const SPAWNED: Duration = Duration::from_secs(5);
/// Delay after spawn before racing a still-initializing spare with the send's cold launch,
/// capped by the send's `GRACE` deadline (`handshake_race.rs`).
const COLD_BUDGET: Duration = Duration::from_millis(1500);

/// The send's own launch, to race a spare that is slow to answer `initialize`.
pub(super) struct Cold<'a> {
    pub(super) command: &'a mut Command,
    pub(super) cwd: &'a Path,
    pub(super) provider: &'a str,
}
pub(super) struct Spare {
    key: String,
    pub(super) child: Child,
    pub(super) group: ProcessGroup,
    /// Everything the spare printed, up to and including its `initialize` reply, for the
    /// adopting run to replay instead of sending `initialize` again.
    pub(super) pending: Vec<u8>,
    born: std::time::Instant,
    /// Reads both pipes while the spare waits; `take` stops it and hands the pipes back.
    reader: Option<Reader>,
    /// The stderr tail from initialization, thread loading and waiting, for the run's errors.
    pub(super) early_stderr: Vec<u8>,
    provider: String,
    /// The Codex thread it already loaded (`codex_preload.rs`).
    pub(super) thread: Option<super::codex_preload::Preloaded>,
}

#[derive(Default)]
struct State {
    spares: HashMap<String, Spare>,
    /// The generation, key, harness and Codex thread (`codex_preload::thread_key`) of each
    /// task's spare still starting; the latest start wins.
    starting: HashMap<String, (u64, String, String, Option<String>)>,
    /// The generation of each task's start that answered `initialize` and is loading its
    /// thread: a send waits for it rather than racing it (`handshake_race.rs`).
    loading: HashMap<String, u64>,
    /// The generation of each task's start whose process already runs (still initializing),
    /// and when it was spawned.
    spawned: HashMap<String, (u64, std::time::Instant)>,
}

static STATE: LazyLock<Mutex<State>> = LazyLock::new(Default::default);

fn state() -> std::sync::MutexGuard<'static, State> {
    STATE.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Harnesses whose launch holds nothing per-launch and that are sent `initialize` first.
/// Not here: Antigravity (a per-launch temp folder in its environment, and its process
/// lingers for the next turn), Cline (each run's MCP settings file is in its environment),
/// Cursor (its own config and login files are not keyed), ZCode, Muse, Pi and OMP (no
/// `initialize` handshake), the Claude family (`warm.rs`).
const PROVIDERS: [&str; 10] = ["codex", "kimi", "opencode", "grok", "deepseek", "commandcode", "kilo", "github-copilot", "devin", "hermes"];

pub fn provider(provider: &str) -> bool {
    PROVIDERS.contains(&provider)
}

/// Local tasks only: a cloud task's process runs on its machine.
pub fn supported(config: &RunConfig) -> bool {
    provider(&config.provider) && !crate::cloud_agents::transport::is_cloud(&config.session_id)
}

/// The first request the harness gets; the run replays the spare's reply to it.
fn initialize_request(provider: &str) -> Value {
    if provider == "codex" { codex_initialize() } else { acp_initialize(provider) }
}

/// The command `run_inner` builds for this task's launch, its key and its folder.
fn launch(config: &RunConfig) -> Result<(Command, String, PathBuf), String> {
    let provider = config.provider.as_str();
    let mut connection = crate::connections::for_task(&config.session_id, provider)
        .map(|connection| crate::connections::launch(&connection))
        .transpose()?;
    let path = connection
        .as_ref()
        .and_then(|connection| connection.executable.clone())
        .or_else(|| executable(provider))
        .ok_or_else(|| format!("{provider} is not installed"))?;
    // Same order as `run_inner`: switches and agents read with the task's folder, then the
    // external path.
    let disabled = crate::skill_manager::launch_disabled(provider, &config.cwd, crate::skill_manager::disabled_for(&config.session_id));
    let agents = if provider == "opencode" { crate::skill_manager::opencode_agents_at(&disabled, &config.cwd) } else { Default::default() };
    let mut config = RunConfig { cwd: external_path(&config.cwd), ..config.clone() };
    let (command, _) = local_command(&mut config, &path, &disabled, &agents, connection.as_mut())?;
    let key = key(provider, &command, &config.cwd);
    Ok((command, key, config.cwd))
}

/// Start (or keep) the task's spare for the launch its next send would use.
///
/// A Codex spare of a task with a saved thread also loads it (`codex_preload.rs`), serving
/// `tools` (the catalog the send will use) from a placeholder MCP server. `ticket` is a
/// debounced first start's (`warm::reserve`): released once this start is claimed, so a send
/// waiting for it always sees the ticket or the claim. `epoch` is the task's launch count it
/// was asked for (`warm::epoch`): once another launch has begun, a spare (whose thread would
/// miss that turn) is neither started nor kept.
pub async fn prewarm(config: RunConfig, ticket: Option<u64>, epoch: u64, tools: Vec<Value>, approval_tools: HashSet<String>) -> Result<(), String> {
    if !supported(&config) || ticket.is_some_and(|ticket| !warm::reserved(&config.session_id, ticket)) {
        if let Some(ticket) = ticket {
            warm::release(&config.session_id, ticket);
        }
        return Ok(());
    }
    let loading = config.clone();
    // Reads the task's switches, connection, keys and config files: off the runtime.
    let launched = crate::blocking(move || launch(&config)).await;
    prewarm_launched(loading, ticket, epoch, tools, approval_tools, launched).await
}

/// Continue with the resolved launch; tests supply a local fake CLI at this boundary.
async fn prewarm_launched(config: RunConfig, ticket: Option<u64>, epoch: u64, tools: Vec<Value>, approval_tools: HashSet<String>, launched: Result<(Command, String, PathBuf), String>) -> Result<(), String> {
    let session_id = config.session_id.clone();
    let release = |session_id: &str| {
        if let Some(ticket) = ticket {
            warm::release(session_id, ticket);
        }
    };
    let (provider, request) = (config.provider.clone(), initialize_request(&config.provider));
    let thread = super::codex_preload::expected(&config, &tools, &approval_tools);
    let loading = config;
    // A later pick (say, back to Claude) cancelled this start while it was keyed: it must not
    // start, nor stop the agent that pick kept.
    if ticket.is_some_and(|ticket| !warm::reserved(&session_id, ticket)) {
        return Ok(());
    }
    let claimed = launched.as_ref().ok().and_then(|(_, key, _)| claim_thread(&session_id, Claim { key, provider: &provider, thread: thread.as_deref(), ticket, launch: epoch }));
    if launched.is_ok() {
        // This harness's start begins (or its spare already fits): one spare per task.
        warm::other_start(&session_id);
    }
    release(&session_id);
    let (command, key, cwd) = launched?;
    let Some(generation) = claimed else { return Ok(()) };
    // Cancel before initialize's timeout when a pick, send or setting retires this launch.
    // Dropping the losing start future kills its child and registered process group.
    let turned_away = warm::wait_while(tokio::time::Instant::now() + 2 * INITIALIZE, || current(&session_id, generation) && start_ahead() && warm::epoch(&session_id) == epoch);
    let started = tokio::select! {
        biased;
        _ = turned_away => {
            store(&session_id, generation, epoch, None);
            return Ok(());
        }
        started = start(command, &cwd, &request, || spawned(&session_id, generation)) => started,
    };
    if let Err(error) = &started {
        eprintln!("Could not prepare a warm agent: {error}");
    }
    let (mut child, group, mut pending, mut early_stderr) = match started {
        Ok(started) => started,
        Err(error) => {
            store(&session_id, generation, epoch, None);
            return Err(error);
        }
    };
    let thread = match thread {
        Some(_) => {
            mark_loading(&session_id, generation);
            // A start turned away (a send went cold, a discard) stops loading at once.
            let turned_away = warm::wait_while(tokio::time::Instant::now() + 2 * super::codex_preload::LOAD, || current(&session_id, generation));
            let loaded = tokio::select! {
                loaded = super::codex_preload::preload(&mut child, &mut pending, &mut early_stderr, &loading, tools, approval_tools) => loaded,
                _ = turned_away => Err("it was no longer wanted".to_string()),
            };
            match loaded {
                Ok(thread) => thread,
                Err(error) => {
                    // The process is past `initialize` for a load it never finished: not reusable.
                    eprintln!("Could not load the Codex thread ahead: {error}");
                    store(&session_id, generation, epoch, None);
                    return Ok(());
                }
            }
        }
        None => None,
    };
    let reader = listen(&mut child);
    let born = std::time::Instant::now();
    if !store(&session_id, generation, epoch, Some(Spare { key, child, group, pending, born, reader, early_stderr, provider, thread })) {
        return Ok(());
    }
    super::limit_spares();
    tokio::spawn(async move {
        tokio::time::sleep(warm::IDLE).await;
        evict(&session_id, born);
    });
    Ok(())
}

#[cfg(all(test, unix))]
#[path = "handshake_cancel_tests.rs"]
mod handshake_cancel_tests;

/// A generation for a new spare, or `None` when one with this key is already waiting or
/// starting (a model, effort or mode switch leaves the launch unchanged).
/// End a start: keep its spare if the start is still the task's current one and starting ahead
/// is still on; otherwise (a newer start, a send, a discard, the setting turned off) dropping
/// the spare kills it. Returns whether it was kept.
fn store(session_id: &str, generation: u64, launch: u64, spare: Option<Spare>) -> bool {
    let mut state = state();
    let current = state.starting.get(session_id).is_some_and(|(started, ..)| *started == generation);
    if current {
        state.starting.remove(session_id);
        state.loading.remove(session_id);
    }
    // Another launch began meanwhile (it counts before it drops what it did not take): this
    // spare's thread would miss that turn.
    let kept = current && start_ahead() && warm::epoch(session_id) == launch && spare.is_some();
    // A turned-away spare, or one this replaces, is killed outside the lock.
    let stale = match spare {
        Some(spare) if kept => state.spares.insert(session_id.to_owned(), spare),
        other => other,
    };
    drop(state);
    warm::changed();
    drop(stale);
    kept
}

#[cfg(all(test, unix))]
fn claim(session_id: &str, key: &str, provider: &str) -> Option<u64> {
    claim_thread(session_id, Claim { key, provider, thread: None, ticket: None, launch: warm::epoch(session_id) })
}

/// What a start would claim the task's slot for.
struct Claim<'a> {
    key: &'a str,
    provider: &'a str,
    /// The Codex thread it would load (`codex_preload::expected`).
    thread: Option<&'a str>,
    ticket: Option<u64>,
    launch: u64,
}

/// A generation for a new spare, or `None` when the start is no longer wanted (its ticket was
/// superseded, or another launch began: checked under the lock a send's take and discard use)
/// or one with this command and thread is already waiting or starting.
fn claim_thread(session_id: &str, claim: Claim<'_>) -> Option<u64> {
    let mut state = state();
    if !start_ahead() || claim.ticket.is_some_and(|ticket| !warm::reserved(session_id, ticket)) || warm::epoch(session_id) != claim.launch {
        return None;
    }
    let loads = |thread: Option<&str>| thread == claim.thread;
    let waiting = state.spares.get_mut(session_id).is_some_and(|spare| {
        spare.key == claim.key && loads(super::codex_preload::key_of(spare.thread.as_ref())) && matches!(spare.child.try_wait(), Ok(None))
    });
    if waiting || state.starting.get(session_id).is_some_and(|(_, starting, _, thread)| starting == claim.key && loads(thread.as_deref())) {
        return None;
    }
    let generation = warm::next_generation();
    state.starting.insert(session_id.to_owned(), (generation, claim.key.to_owned(), claim.provider.to_owned(), claim.thread.map(str::to_owned)));
    Some(generation)
}

/// This generation's start is still the task's current one.
fn current(session_id: &str, generation: u64) -> bool {
    state().starting.get(session_id).is_some_and(|(started, ..)| *started == generation)
}

/// This generation's start answered `initialize` and now loads its thread.
fn mark_loading(session_id: &str, generation: u64) {
    let mut state = state();
    if state.starting.get(session_id).is_some_and(|(started, ..)| *started == generation) {
        state.loading.insert(session_id.to_owned(), generation);
    }
    drop(state);
    warm::changed();
}

/// The start of this generation has a running process now: a send waits for it past `GRACE`.
fn spawned(session_id: &str, generation: u64) {
    let mut state = state();
    if state.starting.get(session_id).is_some_and(|(current, ..)| *current == generation) {
        state.spawned.insert(session_id.to_owned(), (generation, std::time::Instant::now()));
    }
    drop(state);
    warm::changed();
}

/// An initialize-only Codex spare (waiting or starting) needs no new one for a model, effort
/// or mode switch: those never reach its command line. A preload must rebuild its thread key.
pub fn kept_across_switch(session_id: &str, provider: &str) -> bool {
    let state = state();
    // A loaded or loading thread is keyed by model and effort too: rebuild to check it.
    provider == "codex"
        && (state.spares.get(session_id).is_some_and(|spare| spare.provider == provider && spare.thread.is_none())
            || state.starting.get(session_id).is_some_and(|(_, _, starting, thread)| starting == provider && thread.is_none()))
}

/// When each idle spare started, for the shared limit.
pub(super) fn births() -> Vec<(std::time::Instant, String)> {
    state().spares.iter().map(|(id, spare)| (spare.born, id.clone())).collect()
}

/// Drop the task's idle spare if it is still the one born then; dropping kills its process.
pub(super) fn evict(session_id: &str, born: std::time::Instant) {
    let mut state = state();
    let evicted = state.spares.get(session_id).is_some_and(|spare| spare.born == born).then(|| state.spares.remove(session_id)).flatten();
    drop(state);
    drop(evicted);
}

/// Drop every task's spare and pending start.
pub(super) fn discard_all() {
    let mut state = state();
    let stale = std::mem::take(&mut state.spares);
    state.starting.clear();
    state.spawned.clear();
    state.loading.clear();
    drop(state);
    warm::changed();
    // Killed outside the lock.
    drop(stale);
}

/// The task has a live spare waiting, or one starting. A waiting spare whose process exited
/// goes now, so the next pick or keystroke starts a new one.
pub(super) fn present(session_id: &str) -> bool {
    let mut state = state();
    let exited = state.spares.get_mut(session_id).is_some_and(|spare| !matches!(spare.child.try_wait(), Ok(None)));
    let stale = exited.then(|| state.spares.remove(session_id)).flatten();
    let present = state.spares.contains_key(session_id) || state.starting.contains_key(session_id);
    drop(state);
    drop(stale);
    present
}

#[cfg(test)]
pub(super) fn insert_for_test(session_id: &str, provider: &str) -> u32 {
    #[cfg(unix)]
    let mut cmd = {
        let mut c = Command::new("sleep");
        c.arg("30");
        c
    };
    #[cfg(not(unix))]
    let mut cmd = {
        let mut c = Command::new("ping");
        c.args(["-n", "31", "127.0.0.1"]);
        c
    };
    let child = cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).kill_on_drop(true).spawn().unwrap();
    let pid = child.id().unwrap();
    let spare = Spare { key: "k".into(), child, group: ProcessGroup::register(None), pending: Vec::new(), born: std::time::Instant::now(), reader: None, early_stderr: Vec::new(), provider: provider.into(), thread: None };
    state().spares.insert(session_id.into(), spare);
    pid
}

#[cfg(all(test, unix))]
pub(super) async fn start_for_test(command: Command, cwd: &Path) -> Result<(Child, ProcessGroup, Vec<u8>), String> {
    let (child, group, pending, _) = start(command, cwd, &codex_initialize(), || {}).await?;
    Ok((child, group, pending))
}

#[cfg(all(test, unix))]
pub(super) fn insert_preloaded_for_test(session_id: &str, command: &Command, cwd: &Path, child: Child, group: ProcessGroup, pending: Vec<u8>, thread: Option<super::codex_preload::Preloaded>) {
    let key = key("codex", command, cwd);
    let spare = Spare { key, child, group, pending, born: std::time::Instant::now(), reader: None, early_stderr: Vec::new(), provider: "codex".into(), thread };
    state().spares.insert(session_id.into(), spare);
}

#[cfg(test)]
pub(super) fn spare_pid(session_id: &str) -> Option<u32> {
    state().spares.get(session_id).and_then(|spare| spare.child.id())
}

/// A Claude start begins for the task: its spare goes (one spare per task).
pub(super) fn other_start(session_id: &str) {
    discard(session_id);
}

/// Take out a task's spare and pending start (it left these harnesses, changed folder, or was
/// deleted). Dropping the spare kills it: callers holding a lock drop it after releasing it.
pub(super) fn take_out(session_id: &str) -> Option<Spare> {
    let mut state = state();
    let stale = state.spares.remove(session_id);
    state.starting.remove(session_id);
    state.loading.remove(session_id);
    drop(state);
    warm::changed();
    stale
}

/// Drop a task's spare (it left these harnesses, changed folder, or was deleted).
pub fn discard(session_id: &str) {
    drop(take_out(session_id));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    fn sleeper() -> (Child, ProcessGroup) {
        let child = Command::new("sleep").arg("30").stdin(Stdio::piped()).stdout(Stdio::piped()).kill_on_drop(true).spawn().unwrap();
        (child, ProcessGroup::register(None))
    }

    #[cfg(unix)]
    fn spare(key: &str, (child, group): (Child, ProcessGroup)) -> Spare {
        Spare { key: key.into(), child, group, pending: Vec::new(), born: std::time::Instant::now(), reader: None, early_stderr: Vec::new(), provider: "codex".into(), thread: None }
    }


    #[test]
    fn model_effort_and_mode_do_not_reach_the_codex_command_line() {
        let base = RunConfig { session_id: "codex-warm-launch".into(), ..crate::providers::tests::config("codex") };
        let key_for = |config: &RunConfig| {
            let mut command = Command::new("/bin/codex");
            configure_command_with_agents(&mut command, config, &Default::default(), &Default::default());
            key("codex", &command, &config.cwd)
        };
        let switched = RunConfig { model: "gpt-other".into(), reasoning_effort: Some("high".into()), mode: "full".into(), resume_id: Some("thread".into()), prompt: "hi".into(), ..base.clone() };
        assert_eq!(key_for(&base), key_for(&switched), "a switch keeps the spare");
        assert!(supported(&base));
        assert!(!supported(&crate::providers::tests::config("claude")));
    }

    /// A Codex app-server for a whole turn that logs every request it gets to `$1`.
    #[cfg(unix)]
    fn fake_turn(log: &Path) -> Command {
        let script = r#"while IFS= read -r line; do
  printf '%s\n' "$line" >> "$1"
  case "$line" in
    *'"method":"initialize"'*) printf '%s\n' '{"id":1,"result":{}}' ;;
    *'"method":"thread/start"'*) printf '%s\n' '{"id":2,"result":{"thread":{"id":"root"}}}' ;;
    *'"method":"turn/start"'*)
      printf '%s\n' '{"id":3,"result":{"turn":{"id":"t1"}}}'
      printf '%s\n' '{"method":"item/completed","params":{"threadId":"root","turnId":"t1","item":{"type":"agentMessage","id":"m","text":"warm reply"}}}'
      printf '%s\n' '{"method":"turn/completed","params":{"threadId":"root","turn":{"id":"t1","status":"completed"}}}'
      ;;
  esac
done"#;
        let mut command = Command::new("sh");
        command.args(["-c", script, "fake-codex"]).arg(log);
        command
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_run_adopts_the_codex_spare_and_skips_its_own_initialize() {
        let _serial = super::super::concurrent_process_tests::process_test_lock().lock().await;
        let config = RunConfig { session_id: "codex-warm-run".into(), ..crate::providers::tests::config("codex") };
        let log = std::env::temp_dir().join(format!("codex-warm-run-{}", uuid::Uuid::new_v4()));
        let (child, group, pending, early_stderr) = start(fake_turn(&log), &config.cwd, &codex_initialize(), || {}).await.expect("initialized");
        let spare = Spare { key: key("codex", &fake_turn(&log), &config.cwd), child, group, pending, born: std::time::Instant::now(), reader: None, early_stderr, provider: "codex".into(), thread: None };
        state().spares.insert(config.session_id.clone(), spare);
        let events = Arc::new(Mutex::new(Vec::new()));
        let seen = events.clone();
        let sink: Sink = Arc::new(move |event: AgentEvent| seen.lock().unwrap().push(event));
        let (_input, receiver) = tokio::sync::mpsc::unbounded_channel();
        let run = run_process(config.clone(), sink, receiver, fake_turn(&log), Vec::new());
        tokio::time::timeout(Duration::from_secs(10), run).await.expect("the turn ends").expect("the turn succeeds");
        assert!(!state().spares.contains_key(&config.session_id), "the spare was adopted");
        let sent = std::fs::read_to_string(&log).unwrap();
        let methods: Vec<String> = sent.lines().map(|line| serde_json::from_str::<Value>(line).unwrap()["method"].as_str().unwrap_or_default().to_owned()).collect();
        assert_eq!(methods[..4], ["initialize", "initialized", "thread/start", "turn/start"], "{sent}");
        assert_eq!(methods.iter().filter(|method| *method == "initialize").count(), 1, "one process, one initialize");
        assert!(events.lock().unwrap().iter().any(|event| event.kind == "session" && event.text == "root"));
        let _ = std::fs::remove_file(&log);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn claude_and_codex_spares_share_one_limit_and_the_most_recently_wanted_stay() {
        let (child, group) = sleeper();
        warm::insert_for_test("warm-limit-claude-old", "k", child, group);
        tokio::time::sleep(Duration::from_millis(5)).await;
        state().spares.insert("warm-limit-codex".into(), spare("k", sleeper()));
        tokio::time::sleep(Duration::from_millis(5)).await;
        let (child, group) = sleeper();
        warm::insert_for_test("warm-limit-claude-new", "k", child, group);
        super::super::limit_spares();
        let claude: Vec<String> = warm::births().into_iter().map(|(_, id)| id).filter(|id| id.starts_with("warm-limit-")).collect();
        assert_eq!(claude, ["warm-limit-claude-new"], "the oldest, a Claude agent, went");
        assert!(state().spares.contains_key("warm-limit-codex"), "two spares in all remain");
        // Recent use beats birth: the task just used keeps its spare when two others are
        // warmed after it.
        warm::touch("warm-limit-codex");
        tokio::time::sleep(Duration::from_millis(5)).await;
        let (child, group) = sleeper();
        warm::insert_for_test("warm-limit-claude-newer", "k", child, group);
        super::super::limit_spares();
        assert!(state().spares.contains_key("warm-limit-codex"), "the task just used keeps its spare");
        let claude: Vec<String> = warm::births().into_iter().map(|(_, id)| id).filter(|id| id.starts_with("warm-limit-")).collect();
        assert_eq!(claude, ["warm-limit-claude-newer"], "the least recently wanted went");
        warm::discard("warm-limit-claude-newer");
        discard("warm-limit-codex");
    }

    #[test]
    fn acp_harnesses_with_nothing_per_launch_are_warmed() {
        for warmed in ["kimi", "opencode", "grok", "deepseek", "commandcode", "kilo", "github-copilot", "devin", "hermes"] {
            assert!(supported(&crate::providers::tests::config(warmed)), "{warmed}");
            assert_eq!(initialize_request(warmed), acp_initialize(warmed));
        }
        for cold in ["antigravity", "cline", "cursor", "zcode", "muse", "pi", "omp", "claude", "glm", "mimo", "alibaba"] {
            assert!(!supported(&crate::providers::tests::config(cold)), "{cold}");
        }
        assert_eq!(initialize_request("codex"), codex_initialize());
    }

    /// An ACP agent for a whole turn that logs every request it gets to `$1`.
    #[cfg(unix)]
    fn fake_acp(log: &Path) -> Command {
        let script = r#"while IFS= read -r line; do
  printf '%s\n' "$line" >> "$1"
  id=$(printf '%s' "$line" | sed -nE 's/.*"id":([0-9]+).*/\1/p')
  case "$line" in
    *'"method":"initialize"'*) printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentCapabilities":{"mcpCapabilities":{"http":true}}}}' ;;
    *'"method":"session/new"'*) printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"sessionId":"acp-root","modes":{"currentModeId":"default","availableModes":[{"id":"default","name":"Default"}]}}}' ;;
    *'"method":"session/prompt"'*)
      printf '%s\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"acp-root","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"warm reply"}}}}'
      printf '{"jsonrpc":"2.0","id":%s,"result":{"stopReason":"end_turn"}}\n' "$id"
      ;;
    *'"method"'*) [ -n "$id" ] && printf '{"jsonrpc":"2.0","id":%s,"result":{}}\n' "$id" ;;
  esac
done"#;
        let mut command = Command::new("sh");
        command.args(["-c", script, "fake-acp"]).arg(log);
        command
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_run_adopts_the_acp_spare_and_parses_its_replayed_reply() {
        let _serial = super::super::concurrent_process_tests::process_test_lock().lock().await;
        let config = RunConfig { session_id: "acp-warm-run".into(), ..crate::providers::tests::config("kimi") };
        let log = std::env::temp_dir().join(format!("acp-warm-run-{}", uuid::Uuid::new_v4()));
        let (child, group, pending, early_stderr) = start(fake_acp(&log), &config.cwd, &initialize_request("kimi"), || {}).await.expect("initialized");
        assert_eq!(std::fs::read_to_string(&log).unwrap().lines().count(), 1, "a spare is sent initialize alone");
        let spare = Spare { key: key(&config.provider, &fake_acp(&log), &config.cwd), child, group, pending, born: std::time::Instant::now(), reader: None, early_stderr, provider: config.provider.clone(), thread: None };
        state().spares.insert(config.session_id.clone(), spare);
        let events = Arc::new(Mutex::new(Vec::new()));
        let seen = events.clone();
        let sink: Sink = Arc::new(move |event: AgentEvent| seen.lock().unwrap().push(event));
        let (_input, receiver) = tokio::sync::mpsc::unbounded_channel();
        let run = run_process(config.clone(), sink, receiver, fake_acp(&log), Vec::new());
        tokio::time::timeout(Duration::from_secs(10), run).await.expect("the turn ends").expect("the turn succeeds");
        assert!(!state().spares.contains_key(&config.session_id), "the spare was adopted");
        let sent = std::fs::read_to_string(&log).unwrap();
        let methods: Vec<String> = sent.lines().map(|line| serde_json::from_str::<Value>(line).unwrap()["method"].as_str().unwrap_or_default().to_owned()).collect();
        assert_eq!(methods[..2], ["initialize", "session/new"], "the replayed reply led straight to the session: {sent}");
        assert_eq!(methods.iter().filter(|method| *method == "initialize").count(), 1, "one process, one initialize");
        assert!(methods.iter().any(|method| method == "session/prompt"), "{sent}");
        let events = events.lock().unwrap();
        assert!(events.iter().any(|event| event.kind == "session" && event.text == "acp-root"), "{events:?}");
        assert!(events.iter().any(|event| event.text.contains("warm reply")), "{events:?}");
        let _ = std::fs::remove_file(&log);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_codex_spare_is_adopted_only_on_its_exact_key() {
        let id = "codex-warm-take";
        state().spares.insert(id.into(), spare("launch-a", sleeper()));
        assert!(take(id, "launch-b", None, None).await.unwrap().is_none(), "a different launch starts cold");
        assert!(!state().spares.contains_key(id), "and the stale spare is gone");
        state().spares.insert(id.into(), spare("launch-a", sleeper()));
        let mut adopted = take(id, "launch-a", None, None).await.unwrap().expect("the matching spare is adopted");
        adopted.child.kill().await.unwrap();
        let (mut child, group) = sleeper();
        child.kill().await.unwrap();
        child.wait().await.unwrap();
        state().spares.insert(id.into(), spare("launch-a", (child, group)));
        assert!(take(id, "launch-a", None, None).await.unwrap().is_none(), "a spare that exited is never adopted");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_latest_codex_start_wins_and_a_same_launch_switch_keeps_the_spare() {
        let id = "codex-warm-claim";
        let first = claim(id, "launch-a", "codex").expect("a start");
        assert!(claim(id, "launch-a", "codex").is_none(), "the same launch is already starting");
        let second = claim(id, "launch-b", "codex").expect("a newer start");
        assert!(second > first && state().starting.get(id).is_some_and(|(generation, ..)| *generation == second));
        state().starting.remove(id);
        state().spares.insert(id.into(), spare("launch-b", sleeper()));
        assert!(claim(id, "launch-b", "codex").is_none(), "a waiting spare with the same launch is kept");
        discard(id);
        assert!(!state().spares.contains_key(id) && !state().starting.contains_key(id));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_send_waits_for_the_codex_spare_still_starting() {
        let id = "codex-warm-starting";
        let generation = claim(id, "launch-a", "codex").unwrap();
        // Ready within the grace: the send adopts it, woken as it lands.
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(500)).await;
            let mut state = state();
            assert!(state.starting.get(id).is_some_and(|(current, ..)| *current == generation));
            state.starting.remove(id);
            state.spares.insert(id.into(), spare("launch-a", sleeper()));
            drop(state);
            warm::changed();
        });
        let started = std::time::Instant::now();
        let mut adopted = take(id, "launch-a", None, None).await.unwrap().expect("the starting spare is adopted");
        assert!(started.elapsed() < Duration::from_millis(900), "no polling delay after it is ready");
        adopted.child.kill().await.unwrap();
        warm::launch_settled(id);
        // One that never answers `initialize` costs the send the grace, not its 20 s limit; the
        // late spare is turned away.
        let generation = claim(id, "launch-a", "codex").unwrap();
        let started = std::time::Instant::now();
        assert!(take(id, "launch-a", None, None).await.unwrap().is_none());
        let waited = started.elapsed();
        assert!(waited >= GRACE && waited < GRACE + Duration::from_millis(400), "{waited:?}");
        assert!(state().starting.get(id).is_none_or(|(current, ..)| *current != generation));
        warm::launch_settled(id);
        // A start that fails ends the wait at once.
        let generation = claim(id, "launch-a", "codex").unwrap();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            let mut state = state();
            if state.starting.get(id).is_some_and(|(current, ..)| *current == generation) {
                state.starting.remove(id);
            }
            drop(state);
            warm::changed();
        });
        let started = std::time::Instant::now();
        assert!(take(id, "launch-a", None, None).await.unwrap().is_none());
        assert!(started.elapsed() < Duration::from_secs(1));
        warm::launch_settled(id);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_send_keeps_waiting_for_a_spare_whose_process_runs() {
        let id = "codex-warm-spawned";
        let generation = claim(id, "launch-a", "codex").unwrap();
        spawned(id, generation);
        // Its `initialize` reply lands past the grace: the send still adopts it.
        tokio::spawn(async move {
            tokio::time::sleep(GRACE + Duration::from_millis(800)).await;
            let mut state = state();
            state.starting.remove(id);
            state.spares.insert(id.into(), spare("launch-a", sleeper()));
            drop(state);
            warm::changed();
        });
        let mut adopted = take(id, "launch-a", None, None).await.unwrap().expect("the spawned spare is adopted, not a second cold start");
        adopted.child.kill().await.unwrap();
        warm::launch_settled(id);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn turning_start_ahead_off_drops_a_handshake_start_in_flight() {
        let id = "codex-warm-off-in-flight";
        let generation = claim(id, "launch-a", "codex").unwrap();
        // Turned off while it was initializing: the finished spare is not kept.
        crate::provider_settings::START_AHEAD_FORCE.with(|force| force.set(Some(false)));
        assert!(!store(id, generation, warm::epoch(id), Some(spare("launch-a", sleeper()))));
        assert!(!state().spares.contains_key(id) && !state().starting.contains_key(id));
        // Nor does a new start begin.
        assert!(claim(id, "launch-a", "codex").is_none());
        crate::provider_settings::START_AHEAD_FORCE.with(|force| force.set(None));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_cancelled_pick_neither_starts_nor_stops_the_claude_agent() {
        let id = "codex-warm-cancelled-pick";
        let (child, group) = sleeper();
        warm::insert_for_test(id, "claude", child, group);
        // A pick to Codex reserved a start; a pick back to Claude cancelled it.
        let ticket = warm::reserve(id);
        warm::cancel_ticket(id);
        let config = RunConfig { session_id: id.into(), ..crate::providers::tests::config("codex") };
        prewarm(config, Some(ticket), warm::epoch(id), Vec::new(), HashSet::new()).await.unwrap();
        assert!(warm::births().iter().any(|(_, task)| task == id), "the Claude agent was kept");
        assert!(!present(id), "no Codex start began");
        warm::discard(id);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_send_during_the_debounce_ends_it_and_adopts_the_spare_as_it_starts() {
        let id = "codex-warm-debounce-send";
        let ticket = warm::reserve(id);
        let rewarm = tokio::spawn(async move {
            warm::debounce(id).await;
            // What `prewarm(config, Some(ticket))` does, with a stand-in process.
            let generation = claim(id, "launch-a", "codex").unwrap();
            warm::release(id, ticket);
            let mut state = state();
            if state.starting.get(id).is_some_and(|(current, ..)| *current == generation) {
                state.starting.remove(id);
                state.spares.insert(id.into(), spare("launch-a", sleeper()));
            }
            drop(state);
            warm::changed();
        });
        let started = std::time::Instant::now();
        let mut adopted = take(id, "launch-a", None, None).await.unwrap().expect("the debounced spare is adopted, not a second cold start");
        assert!(started.elapsed() < warm::DEBOUNCE, "the send ended the debounce early");
        rewarm.await.unwrap();
        adopted.child.kill().await.unwrap();
        warm::launch_settled(id);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_codex_spare_is_kept_across_a_switch_without_rebuilding_its_command() {
        let id = "codex-warm-kept";
        assert!(!kept_across_switch(id, "codex"));
        claim(id, "launch-a", "codex").unwrap();
        assert!(kept_across_switch(id, "codex"), "a spare still starting counts");
        assert!(!kept_across_switch(id, "kimi"), "Kimi puts the model on its command line");
        state().starting.remove(id);
        state().spares.insert(id.into(), spare("launch-a", sleeper()));
        assert!(kept_across_switch(id, "codex"));
        discard(id);

        let config = RunConfig { session_id: id.into(), model: "gpt-old".into(), resume_id: Some("thread-1".into()), ..crate::providers::tests::config("codex") };
        let expected = |config: &RunConfig| super::super::codex_preload::expected(config, &[], &HashSet::new()).unwrap();
        let thread = expected(&config);
        for switched in [RunConfig { model: "gpt-new".into(), ..config.clone() }, RunConfig { reasoning_effort: Some("high".into()), ..config.clone() }] {
            let claim = |thread: &str| claim_thread(id, Claim { key: "launch-a", provider: "codex", thread: Some(thread), ticket: None, launch: warm::epoch(id) });
            let first = claim(&thread).expect("a thread preload starts");
            assert!(!kept_across_switch(id, "codex"), "a starting preload must rebuild its expected thread key");
            assert!(claim(&expected(&config)).is_none(), "an unchanged preload is still deduplicated");
            assert!(current(id, first), "the matching preload keeps its generation");
            let changed = expected(&switched);
            assert_ne!(thread, changed, "a model without effort or a first effort override changes the key");
            let next = claim(&changed).expect("the mismatched preload can be replaced");
            assert!(!current(id, first) && current(id, next), "the previous preload is cancelled");
            discard(id);
        }
    }

}
