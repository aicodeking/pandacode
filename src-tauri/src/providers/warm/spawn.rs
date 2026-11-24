//! Starting warm spares: the process for a launch, its registration in the pool, and a team
//! lead's renewals when its spare expires.
use super::*;
use super::key::{key_with_disabled, prepared};
use super::stats::{discarded_note_locked, expired_note, not_renewed_note};

pub(super) fn claude() -> Lifecycle {
    Lifecycle { idle: IDLE, spawn: spawn_claude, current: still_current, pool: &SPARES }
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
pub(super) fn until_discarded(pool: &'static Pool, renew: Renew) -> Renew {
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
pub(super) fn renews(renew: Option<&Renew>, launch: u64, epoch: u64, renewals: u32, current: bool) -> bool {
    renewals < MAX_RENEWALS && epoch == launch && current && renew.is_some_and(|waiting| waiting())
}

/// Whether a renewal would start with the same warm key as the spare that expired: the
/// settings read at spawn (environment, login, telemetry, named connection) are read again,
/// and so are the explorer switch and agent-made tools behind its instructions and catalog
/// (`inputs`, compared with `spawned`, what it read at the spare's spawn).
pub(super) fn still_current(spare_key: &str, config: &RunConfig, tools: &[Value], spawned: &str, inputs: &Inputs) -> bool {
    if !enabled_now() {
        return false;
    }
    let mut config = config.clone();
    config.cwd = external_path(&config.cwd);
    // The spawn keyed the config as a cold launch prepares it (skill reminder applied).
    let disabled = crate::skill_manager::disabled_for(&config.session_id);
    let config = prepared(config, &disabled);
    let stdio = mcp_host::stdio_servers(&config.session_id);
    key_with_disabled(&config, tools, &crate::connections::warm_key(&config.session_id, &config.provider), &disabled, &stdio).as_deref() == Some(spare_key)
        && inputs() == spawned
}

/// A lead's renewal check with the inputs its spare was started on.
pub(super) type Lead = (Renew, Inputs);

/// Boxed so the expiry timer can start the next spare (async recursion).
pub(super) fn start(life: Lifecycle, config: RunConfig, tools: Vec<Value>, approval_tools: HashSet<String>, launch: u64, renew: Option<Lead>, renewals: u32) -> Starting {
    Box::pin(async move {
        let result = spawn_spare(life, config, tools, approval_tools, launch, renew, renewals).await;
        if let Err(error) = &result {
            eprintln!("{}", failure_note(renewals, error));
        }
        result
    })
}

/// What a failed start logs; a lead's renewal says which one, so a lost spare can be traced.
pub(super) fn failure_note(renewals: u32, error: &str) -> String {
    if renewals == 0 {
        format!("Could not prepare a warm Claude agent: {error}")
    } else {
        format!("Could not renew the team lead's warm Claude agent (renewal {renewals} of {MAX_RENEWALS}): {error}")
    }
}

/// Starts a spare's process and keeps it until it is adopted, replaced or expires; an expired
/// lead spare may start again (`renews`).
pub(super) async fn spawn_spare(life: Lifecycle, config: RunConfig, tools: Vec<Value>, approval_tools: HashSet<String>, launch: u64, renew: Option<Lead>, renewals: u32) -> Result<(), String> {
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
        let lead = expired.lead;
        retire(&session_id, expired, pending);
        // Expiry is already counted by its removal; the line only reports the totals.
        let Some((renew, inputs, spawned, config, tools, approvals)) = renewal else {
            eprintln!("{}", expired_note(life.pool, lead));
            return;
        };
        let session = session_id.clone();
        // The check reads files (agent-made tools) and takes the store lock (`renew`), so it
        // runs on a blocking thread, never on the timer's runtime worker.
        // Nothing is logged in here: whether to log depends on a launch superseding it meanwhile.
        let check = tokio::task::spawn_blocking(move || {
            let current = (life.current)(&spare_key, &config, &tools, &spawned, &inputs);
            let again = renews(Some(&renew), launch, epoch(&session_id), renewals, current);
            (current, again.then_some((renew, inputs, config, tools, approvals)))
        });
        let (current, again) = check.await.unwrap_or_else(|error| {
            eprintln!("Could not check the team lead's warm Claude agent renewal: {error}");
            (true, None)
        });
        let renewed = match again {
            Some((renew, inputs, config, tools, approvals)) if launch != 0 && epoch(&config.session_id) == launch => {
                // `start` logs a failure with the renewal's number.
                let _ = start(life, config, tools, approvals, launch, Some((renew, inputs)), renewals + 1).await;
                true
            }
            _ => false,
        };
        // Not renewed and not superseded by a launch (whose own log reports `it expired`): the
        // lead's spare simply expired idle, so say so (and why) even if the wake never comes.
        if !renewed && launch != 0 && epoch(&session) == launch {
            let note = if current { expired_note(life.pool, true) } else { not_renewed_note(life.pool, "its launch settings changed") };
            eprintln!("{note}");
        }
        // The old token overlaps `start`'s own guard through its entire handoff.
        drop(renewing);
    });
    Ok(())
}

/// Claude Code's process for a spare, with a placeholder tool server; `None` for a launch
/// that takes no spare (`supported`).
pub(super) fn spawn_claude(config: RunConfig, tools: Vec<Value>, approval_tools: HashSet<String>, launch: u64) -> Spawning {
    Box::pin(spawn_claude_process(config, tools, approval_tools, launch))
}

pub(super) async fn spawn_claude_process(config: RunConfig, tools: Vec<Value>, approval_tools: HashSet<String>, launch: u64) -> Result<Option<Spawned>, String> {
    if !enabled_now() || !supported(&config) || launch == 0 || epoch(&config.session_id) != launch || quitting() {
        return Ok(None);
    }
    spawn_claude_keyed(config, tools, approval_tools, launch, |config, catalog, disabled, stdio| {
        key_with_disabled(config, catalog, &crate::connections::warm_key(&config.session_id, &config.provider), disabled, stdio)
    })
    .await
}

/// The spare's process once `key_for` has keyed its prepared launch. A launch with no key (its
/// Claude config folder cannot be known, `key_with_disabled`) is declined first: no secret is
/// read, no executable searched for, no tool server or process started.
pub(super) async fn spawn_claude_keyed(
    mut config: RunConfig,
    tools: Vec<Value>,
    approval_tools: HashSet<String>,
    launch: u64,
    key_for: impl FnOnce(&RunConfig, &[Value], &std::collections::BTreeSet<String>, &[mcp_host::Stdio]) -> Option<String> + Send + 'static,
) -> Result<Option<Spawned>, String> {
    config.cwd = external_path(&config.cwd);
    // Switches, settings and the reminder's skill scan are read off the runtime.
    let catalog = tools.clone();
    let (config, key, disabled, stdio) = crate::blocking(move || {
        let disabled = crate::skill_manager::disabled_for(&config.session_id);
        let config = prepared(config, &disabled);
        let stdio = mcp_host::stdio_servers(&config.session_id);
        let key = key_for(&config, &catalog, &disabled, &stdio);
        Ok((config, key, disabled, stdio))
    })
    .await?;
    let Some(key) = key else {
        eprintln!("No warm Claude agent: its config folder cannot be known.");
        return Ok(None);
    };
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
        Some(server)
    };
    // The same `--mcp-config` a cold launch builds, Colab's MCP included.
    if let Some(servers) = mcp_host::claude_mcp_config(server.as_ref().map(mcp_host::Server::claude_config), &stdio) {
        command.args(["--mcp-config", &servers.to_string()]);
    }
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
pub(super) async fn spawn_when_current(
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
/// spare is retired (killed outside the lock, its exit registered). A refused one already started
/// (and ran its `SessionStart` hooks), so it counts as started and discarded, keeping
/// `started == adopted + missed + expired + evicted + replaced + discarded` exact.
pub(super) fn register(pool: &Pool, session_id: &str, launch: u64, spare: Spare) -> bool {
    let evicted = {
        let mut pool = spares(pool);
        // Launch 0 is a forgotten task (`discard`): a spare read from it is never current.
        if launch == 0 || epoch(session_id) != launch {
            let pending = pending_in_cwd(session_id, spare.cwd.clone());
            let stats = pool.stats_mut(spare.lead);
            stats.started += 1;
            stats.discarded += 1;
            let note = discarded_note_locked(&pool, spare.lead);
            drop(pool);
            retire(session_id, spare, pending);
            eprintln!("{note}");
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
pub(super) fn admit(pool: &mut Spares, session_id: String, spare: Spare) -> Vec<(String, Spare, Pending)> {
    let lead = spare.lead;
    let limit = if lead { LEAD_LIMIT } else { LIMIT };
    let mut evicted: Vec<(String, Spare, Pending)> = pool
        .remove(&session_id, Gone::Replaced)
        .map(|(old, pending)| (session_id.clone(), old, pending))
        .into_iter()
        .collect();
    // After the replacement: a fresh spare never sits beside a stale `Gone::Replaced` note.
    pool.gone.remove(&session_id);
    pool.stats_mut(lead).started += 1;
    pool.spares.insert(session_id, spare);
    while pool.spares.values().filter(|spare| spare.lead == lead).count() > limit {
        let Some(oldest) = pool.spares.iter().filter(|(_, spare)| spare.lead == lead).min_by_key(|(_, spare)| spare.born).map(|(id, _)| id.clone()) else { break };
        evicted.extend(pool.remove(&oldest, Gone::Evicted).map(|(old, pending)| (oldest, old, pending)));
    }
    evicted
}
