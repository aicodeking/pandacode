//! Starting agents ahead of a send: when the user picks a task's model, effort, permissions or
//! harness, or starts typing in it, its next launch is prepared in the background
//! (`providers/warm.rs` for Claude, `providers/handshake_warm.rs` for Codex and ACP agents).
//! Settings → Agents → "Start agents ahead" turns all of it off.
use crate::*;

/// A debounced fresh start: its ticket (the newest pick wins; a send cancels it) and the task's
/// launch count, both read before anything is spawned, so a send racing the start can never be
/// warmed for.
struct FreshWarm {
    ticket: u64,
    launch: u64,
    /// The harness it is for: a start finding the task on another one by then does nothing.
    provider: String,
}

/// The launch a plain Claude task's next send would use, without its prompt. `None` for any
/// other task.
#[cfg(test)]
fn plain_launch(store: &Store, session: &Session) -> Option<RunConfig> {
    local_launch(store, session).filter(providers::warms)
}

/// The launch a task's next send would use, without its prompt: local, not a team lead or
/// worker, not mirrored from another machine. `None` for any other task.
fn local_launch(store: &Store, session: &Session) -> Option<RunConfig> {
    if session.remote_device.is_some() || session.cloud.is_some() || cloud_agents::transport::is_cloud(&session.id) {
        return None;
    }
    let team = store.db.query_row(
        "SELECT EXISTS(SELECT 1 FROM architect_teams WHERE session_id=?1) OR EXISTS(SELECT 1 FROM architect_workers WHERE session_id=?1)",
        [&session.id],
        |row| row.get::<_, bool>(0),
    );
    if team.unwrap_or(true) {
        return None;
    }
    let cwd = store.workspace_root(&session.project_id, Some(&session.id)).ok()?;
    let mut config = launch_config(session, cwd);
    apply_system_instructions(&mut config, false);
    Some(config)
}

/// A start ahead could serve this task's next send: the setting is on, the task runs here and
/// its harness warms. Read from the row alone, so the pick's reply never waits on the store or
/// the folder; the start itself re-checks the rest (`local_launch`: teams, the folder) and
/// gives its ticket back if the task cannot be warmed.
fn eligible(session: &Session) -> bool {
    providers::start_ahead()
        && session.remote_device.is_none()
        && session.cloud.is_none()
        && !cloud_agents::transport::is_cloud(&session.id)
        && (session.provider == "claude" || providers::handshake_warm_provider(&session.provider))
}

/// Move the task's recorded warm agent to its new settings. Codex and ACP start afresh (a spare
/// for the same launch is kept; a Codex spare is kept without rebuilding its command, since
/// these switches never reach it), and so does Claude when nothing current was recorded: a new
/// task, or one back from another harness after a turn there. A ticket is reserved only for a
/// task that can be warmed; it is also a send's sign that an agent is on its way.
fn plan_rewarm(session: &Session) -> Option<FreshWarm> {
    if !providers::start_ahead() {
        return None;
    }
    let retargeted = providers::retarget_warm_agent(session);
    let fresh = (providers::handshake_warm_provider(&session.provider) && !providers::handshake_spare_kept(&session.id, &session.provider))
        || (session.provider == "claude" && !retargeted);
    if !(fresh && eligible(session)) {
        // Every pick supersedes a start still pending from an earlier one (say, a quick flip to
        // Codex and back): it must not start, nor stop the agent this pick kept.
        providers::cancel_warm_ticket(&session.id);
        return None;
    }
    // Reserved first: a send after this cancels the ticket, so the launch read next is current.
    let ticket = providers::reserve_warm_agent(&session.id);
    Some(FreshWarm { ticket, launch: providers::warm_epoch(&session.id), provider: session.provider.clone() })
}

/// Plan from the task's row as it is now, read and planned under the store lock: a pick's late
/// reply (an older overlapping pick) can never retarget the agent to settings the task no
/// longer has, since every settings change also takes that lock.
fn plan_current(store: &Store, session_id: &str) -> Option<FreshWarm> {
    let session = store.session(session_id).ok()?;
    plan_rewarm(&session)
}

/// After a model, effort, mode or harness switch (`debounce`: rapid picks start one agent), or
/// a first keystroke (no debounce): move the task's warm agent to the new settings, or start
/// one with the launch and catalog its next send would use. Never blocks the reply.
fn rewarm(app: &tauri::AppHandle, session_id: &str, debounce: bool) {
    let plan = {
        let state = app.state::<AppState>();
        let Ok(store) = state.store.lock() else { return };
        plan_current(&store, session_id)
    };
    let Some(plan) = plan else { return };
    let (app, id) = (app.clone(), session_id.to_owned());
    tauri::async_runtime::spawn(async move {
        if debounce {
            // Ends early when a send is waiting for this agent.
            providers::warm_debounce(&id).await;
        }
        // A newer pick came in meanwhile.
        if !providers::warm_reserved(&id, plan.ticket) {
            return;
        }
        let store = app.state::<AppState>().store.clone();
        let (task, planned_for) = (id.clone(), plan.provider.clone());
        let planned = blocking(move || {
            // The task as it is now, not as it was at the pick. Released before the catalog is
            // built: its wrappers lock the store themselves.
            let config = {
                let store = store.lock().map_err(|e| e.to_string())?;
                let session = store.session(&task)?;
                if session.provider != planned_for {
                    return Ok(None);
                }
                local_launch(&store, &session)
            };
            let Some(config) = config else { return Ok(None) };
            // The ACP agents get their tools at session start, not on their command line. A
            // Codex spare loads the task's thread ahead, serving its catalog (`codex_preload`).
            if providers::handshake_warms(&config) && config.provider != "codex" {
                return Ok(Some((config, Default::default())));
            }
            if !providers::warms(&config) && !providers::handshake_warms(&config) {
                return Ok(None);
            }
            let stopped = Arc::new(AtomicBool::new(false));
            let (host, _) = task_tool_host(&app, &config.session_id, &stopped, None, false, None, None);
            let tools = host.map(|host| (host.tools, host.approval_tools)).unwrap_or_default();
            Ok(Some((config, tools)))
        })
        .await;
        if let Ok(Some((config, (tools, approvals)))) = planned {
            let _ = providers::prewarm_reserved(plan.ticket, config, tools, approvals, plan.launch).await;
        }
        // Whatever happened, this ticket's start is over: a waiting send stops waiting for it.
        providers::release_warm_ticket(&id, plan.ticket);
    });
}

// The settings commands as the app calls them. `warm` is set by the pickers (the user just
// chose, so a send is likely): the task's warm agent then follows the switch, or one is
// started. Other callers (applying a draft, copying settings to a new task, a remote host)
// leave warm agents alone.

#[tauri::command]
pub async fn configure_session(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    provider: String,
    model: String,
    project_id: Option<String>,
    warm: Option<bool>,
) -> Result<Session> {
    let session = crate::configure_session(app.clone(), state, session_id, provider, model, project_id).await?;
    if warm == Some(true) {
        rewarm(&app, &session.id, true);
    }
    Ok(session)
}

#[tauri::command]
pub async fn set_reasoning_effort(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    reasoning_effort: Option<String>,
    warm: Option<bool>,
) -> Result<Session> {
    let session = crate::set_reasoning_effort(app.clone(), state, session_id, reasoning_effort).await?;
    if warm == Some(true) {
        rewarm(&app, &session.id, true);
    }
    Ok(session)
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn update_session(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    title: Option<String>,
    archived: Option<bool>,
    model: Option<String>,
    mode: Option<String>,
    warm: Option<bool>,
) -> Result<()> {
    let switched = model.is_some() || mode.is_some();
    crate::update_session(app.clone(), state.clone(), session_id.clone(), title, archived, model, mode).await?;
    if warm == Some(true) && switched {
        rewarm(&app, &session_id, true);
    }
    Ok(())
}

/// Warm a task the user started typing in (its first keystroke): no debounce, since a send is
/// near. A cheap no-op when the task already has a warm agent for its harness (or one
/// starting), is running, cannot be warmed, or the setting is off.
#[tauri::command]
pub async fn warm_task(app: tauri::AppHandle, state: State<'_, AppState>, session_id: String) -> Result<()> {
    // The user is writing here: this task's spare outlives ones only warmed for others.
    providers::touch_warm_agent(&session_id);
    let session = state.store.lock().map_err(|e| e.to_string())?.session(&session_id)?;
    if providers::has_warm_agent(&session) || run_requests::lock_agents(&state.agents).map_err(|e| e.to_string())?.contains_key(&session_id) {
        return Ok(());
    }
    rewarm(&app, &session_id, false);
    Ok(())
}

/// Settings → Agents → "Start agents ahead".
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartAhead {
    on: bool,
}

#[tauri::command]
pub async fn start_ahead_get() -> Result<StartAhead> {
    Ok(StartAhead { on: providers::start_ahead() })
}

/// Turning it off also stops every agent already started ahead.
#[tauri::command]
pub async fn start_ahead_set(on: bool) -> Result<StartAhead> {
    blocking(move || provider_settings::set_start_ahead(on)).await?;
    if !on {
        providers::discard_all_warm_agents();
    }
    Ok(StartAhead { on })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (Store, String) {
        let store = Store::open(std::path::Path::new(":memory:")).unwrap();
        let project = store.add_project(&std::env::temp_dir()).unwrap().id;
        (store, project)
    }

    #[test]
    fn warm_task_starts_only_when_nothing_is_warm_or_starting() {
        let (store, project) = store();
        let task = store.create_session(&project, "claude", "claude-sonnet-5-5", "ask").unwrap();
        let session = store.session(&task.id).unwrap();
        // A task just opened: nothing warm, so `warm_task` plans a start.
        assert!(!providers::has_warm_agent(&session));
        let plan = plan_rewarm(&session).expect("a fresh agent");
        // While it debounces (or starts, or waits), a second `warm_task` is a no-op.
        assert!(providers::has_warm_agent(&session));
        providers::release_warm_ticket(&task.id, plan.ticket);
        assert!(!providers::has_warm_agent(&session), "an abandoned start leaves nothing behind");
    }

    #[test]
    fn nothing_is_reserved_for_a_task_that_cannot_be_warmed() {
        let (store, project) = store();
        // A harness with a per-launch process: decided from the row, nothing reserved.
        let antigravity = store.create_session(&project, "antigravity", "default", "ask").unwrap();
        let session = store.session(&antigravity.id).unwrap();
        assert!(plan_rewarm(&session).is_none());
        assert!(!providers::has_warm_agent(&session), "no ticket for nothing");
        // A team task needs the store: its start (off the reply path) finds no plain launch and
        // gives the ticket back.
        let team = store.create_session(&project, "claude", "claude-sonnet-5-5", "ask").unwrap();
        store.db.execute("INSERT INTO architect_teams(session_id,content) VALUES(?1,'{}')", [&team.id]).unwrap();
        let session = store.session(&team.id).unwrap();
        let plan = plan_rewarm(&session).expect("reserved from the row");
        assert!(local_launch(&store, &session).is_none());
        providers::release_warm_ticket(&team.id, plan.ticket);
        assert!(!providers::has_warm_agent(&session));
    }

    #[test]
    fn a_late_reply_from_an_older_pick_plans_from_the_current_row() {
        let (store, project) = store();
        let task = store.create_session(&project, "claude", "claude-sonnet-5-5", "ask").unwrap();
        // Two overlapping picks: Codex, then back to Claude. Both rows are saved before the
        // first pick's reply plans its rewarm.
        let first_reply = store.configure(&task.id, "codex", "default", None).unwrap();
        store.configure(&task.id, "claude", "claude-sonnet-5-5", None).unwrap();
        assert_eq!(first_reply.provider, "codex", "the reply's row is stale");
        let plan = plan_current(&store, &task.id).expect("a start is planned");
        assert_eq!(plan.provider, "claude", "planned from the task as it is now");
        providers::release_warm_ticket(&task.id, plan.ticket);
    }

    #[tokio::test]
    async fn a_quick_codex_claude_codex_flip_keeps_the_same_codex_process() {
        let (store, project) = store();
        let task = store.create_session(&project, "codex", "default", "ask").unwrap();
        let pid = providers::handshake_insert_for_test(&task.id, "codex");
        // To Claude: nothing recorded, so a Claude start is planned; the Codex spare stays.
        store.configure(&task.id, "claude", "claude-sonnet-5-5", None).unwrap();
        let claude = plan_rewarm(&store.session(&task.id).unwrap()).expect("a Claude start is planned");
        assert_eq!(providers::handshake_spare_pid(&task.id), Some(pid), "a pick does not kill it");
        // Back to Codex before the debounce ends: its spare fits, and the Claude start is off.
        store.configure(&task.id, "codex", "default", None).unwrap();
        assert!(plan_rewarm(&store.session(&task.id).unwrap()).is_none(), "the kept spare serves");
        assert!(!providers::warm_reserved(&task.id, claude.ticket), "the Claude start will not run");
        assert_eq!(providers::handshake_spare_pid(&task.id), Some(pid), "the same process");
        providers::discard_warm_agent(&task.id);
    }

    #[test]
    fn a_switch_with_nothing_recorded_starts_afresh_and_a_racing_send_cancels_it() {
        let (store, project) = store();
        // Back on Claude after a turn on Codex: that launch dropped the Claude record, so
        // nothing is retargeted and a fresh agent is planned.
        let task = store.create_session(&project, "claude", "claude-sonnet-5-5", "ask").unwrap();
        providers::warm_launched(&task.id);
        let session = store.session(&task.id).unwrap();
        let first = plan_rewarm(&session).expect("a fresh Claude agent");
        // A quick second pick supersedes the first.
        let plan = plan_rewarm(&session).expect("a fresh Claude agent");
        assert!(!providers::warm_reserved(&task.id, first.ticket));
        assert!(providers::warm_reserved(&task.id, plan.ticket));
        // The launch count was read when the switch happened: a send now cancels the start
        // instead of having an agent keyed to its own launch.
        assert_eq!(plan.launch, providers::warm_epoch(&task.id));
        providers::warm_launched(&task.id);
        assert!(!providers::warm_reserved(&task.id, plan.ticket));
        assert_ne!(plan.launch, providers::warm_epoch(&task.id));
        // Codex and the ACP agents always plan one (an unchanged launch keeps its spare).
        for warmed in ["codex", "kimi"] {
            let task = store.create_session(&project, warmed, "default", "ask").unwrap();
            let plan = plan_rewarm(&store.session(&task.id).unwrap());
            assert!(plan.is_some(), "{warmed}");
            providers::release_warm_ticket(&task.id, plan.unwrap().ticket);
        }
    }

    #[test]
    fn picking_back_cancels_a_start_still_pending_from_an_earlier_pick() {
        let (store, project) = store();
        let task = store.create_session(&project, "claude", "claude-sonnet-5-5", "ask").unwrap();
        let session = store.session(&task.id).unwrap();
        // The task's Claude agent is recorded (a turn ended).
        providers::warm_record_for_test(&local_launch(&store, &session).unwrap());
        // A quick pick to Codex left a start pending...
        let pending = providers::reserve_warm_agent(&task.id);
        // ...and the pick back to Claude, which keeps the recorded agent, cancels it.
        assert!(plan_rewarm(&session).is_none(), "the Claude agent is retargeted, not restarted");
        assert!(!providers::warm_reserved(&task.id, pending), "the Codex start will not run");
        providers::discard_warm_agent(&task.id);
    }

    #[test]
    fn a_plain_claude_task_is_warmed_with_the_launch_its_next_send_uses() {
        let (store, project) = store();
        let task = store.create_session(&project, "claude", "claude-sonnet-5-5", "ask").unwrap();
        let session = store.session(&task.id).unwrap();
        let warm = plain_launch(&store, &session).expect("a plain Claude task warms");
        // What prepare_task_run_in_project and the run's instruction step build for a send.
        let cwd = store.workspace_root(&session.project_id, Some(&session.id)).unwrap();
        let mut sent = RunConfig { prompt: "hi".into(), ..launch_config(&session, cwd) };
        assert!(apply_system_instructions(&mut sent, false));
        assert!(!sent.instructions.is_empty());
        assert_eq!(format!("{:?}", RunConfig { prompt: String::new(), ..sent }), format!("{warm:?}"));
        // Other harnesses, and team leads or workers (whose catalog is the team's), are not.
        let codex = store.create_session(&project, "codex", "default", "ask").unwrap();
        assert!(plain_launch(&store, &store.session(&codex.id).unwrap()).is_none());
        store.db.execute("INSERT INTO architect_teams(session_id,content) VALUES(?1,'{}')", [&task.id]).unwrap();
        assert!(plain_launch(&store, &session).is_none());
    }

    /// A package harness is never started ahead (no opt-in exists yet; R0807 adds the explicit
    /// one), however often its task is picked, switched away and back, or typed in, and a start
    /// pending from a built-in pick is cancelled by picking it. Its first send starts it once.
    #[tokio::test]
    async fn a_package_harness_is_never_started_ahead_and_its_first_send_starts_it_once() {
        let (store, project) = store();
        provider_settings::START_AHEAD_FORCE.with(|force| force.set(Some(true)));
        // An identity no test installs: the send's start is counted, then refused with recovery.
        let package = "sample.warm-counter/recorded";
        let task = store.create_session(&project, package, "recorded-model", "ask").unwrap();
        for round in 0..3 {
            // A pick to a built-in plans its start; picking the package back cancels it.
            store.configure(&task.id, "claude", "claude-sonnet-5-5", None).unwrap();
            let claude = plan_current(&store, &task.id).expect("a Claude start is planned");
            store.configure(&task.id, package, "recorded-model", None).unwrap();
            let session = store.session(&task.id).unwrap();
            assert!(!eligible(&session), "round {round}");
            // Model, effort and permission picks (`configure_session`, `set_reasoning_effort`,
            // `update_session` with `warm`) and a first keystroke (`warm_task`) all plan here.
            for _ in 0..4 {
                assert!(plan_current(&store, &task.id).is_none(), "round {round}");
            }
            assert!(!providers::warm_reserved(&task.id, claude.ticket), "the built-in start will not run");
            assert!(!providers::has_warm_agent(&session));
            // A turn end's prewarm and a debounced start that got through anyway do nothing.
            let launch = local_launch(&store, &session).expect("a local package task");
            assert!(!providers::warms(&launch) && !providers::handshake_warms(&launch));
            providers::prewarm_agent(launch.clone(), Vec::new(), Default::default(), providers::warm_epoch(&task.id)).await.unwrap();
            let ticket = providers::reserve_warm_agent(&task.id);
            providers::prewarm_reserved(ticket, launch, Vec::new(), Default::default(), providers::warm_epoch(&task.id)).await.unwrap();
            assert!(!providers::warm_reserved(&task.id, ticket), "the ticket is given back");
            assert!(!providers::retarget_warm_agent(&session));
            assert!(!providers::has_warm_agent(&session));
            assert_eq!(providers::package_starts::count(&task.id), 0, "round {round}");
        }
        provider_settings::START_AHEAD_FORCE.with(|force| force.set(None));
        // The first send is the first start.
        let session = store.session(&task.id).unwrap();
        let config = RunConfig { prompt: "First send".into(), ..local_launch(&store, &session).unwrap() };
        let events = Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink_events = events.clone();
        let (_input, input) = tokio::sync::mpsc::unbounded_channel();
        let result = providers::run_with_tools(config, Arc::new(move |event| sink_events.lock().unwrap().push(event)), input, None, Arc::new(AtomicBool::new(false))).await;
        assert_eq!(providers::package_starts::count(&task.id), 1);
        // Not installed here: recovery, not an unknown identity.
        assert_eq!(result.unwrap_err(), crate::extensions::providers::PROVIDER_RECOVERY);
        let kinds: Vec<String> = events.lock().unwrap().iter().map(|event| event.kind.clone()).collect();
        assert_eq!(kinds, ["error", "done"]);
    }

    #[tokio::test]
    async fn with_start_ahead_off_nothing_is_planned_or_started() {
        let (store, project) = store();
        let task = store.create_session(&project, "claude", "claude-sonnet-5-5", "ask").unwrap();
        let session = store.session(&task.id).unwrap();
        provider_settings::START_AHEAD_FORCE.with(|force| force.set(Some(false)));
        assert!(plan_rewarm(&session).is_none());
        // The turn-end prewarm does nothing either (on, it would spawn Claude Code).
        let config = local_launch(&store, &session).unwrap();
        providers::prewarm_agent(config, Vec::new(), Default::default(), providers::warm_epoch(&task.id)).await.unwrap();
        assert!(!providers::has_warm_agent(&session));
        provider_settings::START_AHEAD_FORCE.with(|force| force.set(None));
    }
}
