//! A team lead's warm spare: after the lead's dispatch turn its next process starts in the
//! background (in the lead pool, `providers/warm.rs`), so the review wake skips the CLI's own
//! startup. Moved out of `lib.rs`; `launch_operation_admitted` calls `renewal` and
//! `spare_config` when a turn ends.
use crate::providers::{self, RunConfig, WarmRenew};
use crate::storage::{Session, Store};
use crate::architect;
use std::sync::{Arc, Mutex};

/// The next turn's launch as its warm spare starts it: this turn's launch (instructions, tools'
/// role, folder) with the task's saved conversation, model, mode, effort and settings, and no message.
pub(crate) fn spare_config(mut next: RunConfig, task: Session) -> RunConfig {
    next.resume_id = task.resume_id;
    next.model = task.model;
    next.mode = task.mode;
    next.reasoning_effort = task.reasoning_effort;
    next.codex_settings = task.codex_settings;
    next.prompt.clear();
    next.images.clear();
    next
}

/// Whether a turn's end starts a spare for the next turn. Team workers rarely get a follow-up, and
/// their spares would push out the architect's. A maintenance turn starts none: `/compact` is
/// the turn that changes what a resumed process would load, and the next real turn can start
/// cold once.
pub(crate) fn starts_spare(config: &RunConfig, managed_worker: bool, cloud: bool, maintenance: bool) -> bool {
    providers::warms(config) && !managed_worker && !cloud && !maintenance
}

/// Team states in which a lead's review wake can still come by itself (`architect::active`).
/// A paused or stopped team (the UI's Pause/Stop go through `architect_control`, which leaves
/// parked workers unsettled) wakes nobody until the user resumes it.
fn team_active(status: &str) -> bool {
    matches!(status, "running" | "waiting")
}

/// Team states the user chose (Pause/Stop through `architect_control`): nothing wakes the lead.
fn team_held(status: &str) -> bool {
    matches!(status, "paused" | "stopped")
}

/// The lead's live workers (not abandoned, not settled), with whether each waits on the user
/// (an approval or a question): such a worker owes no result until the user answers. Empty
/// while the team is not active.
fn workers(store: &Mutex<Store>, session_id: &str) -> Vec<bool> {
    let Ok(db) = store.lock() else { return Vec::new() };
    load_team(&db, session_id).map_or_else(Vec::new, |team| live_workers(&db, &team))
}

/// The lead's team, or `None` when it is gone or cannot be read (logged).
fn load_team(db: &Store, session_id: &str) -> Option<architect::TeamSnapshot> {
    match architect::load(db, session_id) {
        Ok(team) => team,
        Err(error) => {
            eprintln!("PandaCode: could not read the team for its lead's warm agent: {error}");
            None
        }
    }
}

/// `workers` for a team already loaded.
fn live_workers(db: &Store, team: &architect::TeamSnapshot) -> Vec<bool> {
    if !team_active(&team.status) {
        return Vec::new();
    }
    team.workers
        .iter()
        .filter(|worker| !worker.abandoned && architect::unsettled(&worker.status))
        .map(|worker| db.session(&worker.session_id).is_ok_and(|task| task.status == "waiting"))
        .collect()
}

/// Whether a lead's review wake can come without the user: every live worker is working (or
/// parked on working sub-workers). The review wakes it only once all settle, so one worker
/// waiting on the user holds it until they answer, however long that takes.
fn waiting(store: &Mutex<Store>, session_id: &str) -> bool {
    let workers = workers(store, session_id);
    !workers.is_empty() && !workers.contains(&true)
}

/// For a lead with live workers: the check its warm spare renews on, else `None`. The first
/// spare is kept (in the lead pool) even while a worker waits on the user. The check is asked
/// once per expiry (`warm::renews`): a "no" then (a worker waiting on the user, the team
/// settled) ends the renewals for good, even if the user answers later.
/// (`pool` decides this at run end; this form reads the team on its own.)
#[cfg(test)]
pub(crate) fn renewal(store: &Arc<Mutex<Store>>, session_id: &str, lead: bool) -> Option<WarmRenew> {
    if !lead || workers(store, session_id).is_empty() {
        return None;
    }
    Some(renew_check(store, session_id))
}

/// The check a lead spare renews on (`waiting`, read again at each expiry).
fn renew_check(store: &Arc<Mutex<Store>>, session_id: &str) -> WarmRenew {
    let (store, session_id) = (store.clone(), session_id.to_owned());
    Arc::new(move || waiting(&store, &session_id))
}

/// Where a turn's warm spare goes, decided when the turn ends.
pub(crate) enum Pool {
    /// A plain task, a worker, a lead of an active team with no live worker, or a lead whose
    /// team ended by itself.
    Ordinary,
    /// A lead of an active team waiting on its workers: the lead pool, renewed on this check.
    Lead(WarmRenew),
    /// A lead whose team the user paused or stopped, or whose team cannot be read: no wake is
    /// coming until the user resumes it, so no spare is kept in either pool. A team that ended
    /// by itself (completed, ready, failed) gets `Ordinary`: the user's follow-up is likely.
    Drop,
}

impl Pool {
    pub(crate) fn keeps(&self) -> bool {
        !matches!(self, Pool::Drop)
    }
    pub(crate) fn renewal(self) -> Option<WarmRenew> {
        match self {
            Pool::Lead(renew) => Some(renew),
            Pool::Ordinary | Pool::Drop => None,
        }
    }
}

/// The pool for the spare `session_id`'s turn would start; `lead`: the turn was its team's lead.
/// Takes the store lock and loads the team once.
pub(crate) fn pool(store: &Arc<Mutex<Store>>, session_id: &str, lead: bool) -> Pool {
    if !lead {
        return Pool::Ordinary;
    }
    let live = {
        let Ok(db) = store.lock() else {
            eprintln!("PandaCode: could not read the team for its lead's warm agent: the store is unavailable");
            return Pool::Drop;
        };
        match load_team(&db, session_id) {
            Some(team) if !team_held(&team.status) => live_workers(&db, &team),
            _ => return Pool::Drop,
        }
    };
    if live.is_empty() {
        return Pool::Ordinary;
    }
    Pool::Lead(renew_check(store, session_id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::*;

    /// Saves `lead`'s running team with these workers (`(session id, status)`); returns its generation.
    fn save_team(store: &Store, lead: &str, workers: &[(&str, &str)]) -> u64 {
        let config = architect::TeamConfig {
            auto: false, roster_only: false, name: None, workers: vec![], catalog: vec![],
            max_parallel: 3, max_rounds: 5, max_assignments: 10, workspace: "shared".into(), summary_limit: 2000, lead_guidance: None, council: None,
        };
        let mut team = architect::new_team(lead.into(), config);
        team.status = "running".into();
        for (i, (session, status)) in workers.iter().enumerate() {
            team.workers.push(serde_json::from_value(serde_json::json!({
                "id": format!("w{i}"), "sessionId": session, "name": format!("w{i}"), "profileId": "fast", "provider": "claude", "model": "default",
                "reasoningEffort": null, "status": status, "assignment": "Small task", "summary": "", "error": null,
                "dependsOn": [], "files": [], "attempt": 1, "createdAt": 1, "updatedAt": 1,
            })).unwrap());
        }
        store.db.execute(
            "INSERT INTO architect_teams(session_id,content) VALUES(?1,?2) ON CONFLICT(session_id) DO UPDATE SET content=excluded.content",
            rusqlite::params![lead, serde_json::to_string(&team).unwrap()],
        ).unwrap();
        team.generation
    }

    fn lead_store() -> (Arc<Mutex<Store>>, String, String) {
        let store = Store::open(std::path::Path::new(":memory:")).unwrap();
        let project = store.add_project(&std::env::temp_dir()).unwrap();
        let lead = store.create_session(&project.id, "claude", "default", "ask").unwrap().id;
        (Arc::new(Mutex::new(store)), project.id, lead)
    }

    #[test]
    fn a_leads_spare_survives_a_worker_wait_and_stops_renewing_once_they_settle() {
        let (store, _, lead) = lead_store();
        save_team(&store.lock().unwrap(), &lead, &[("task-w1", "running")]);
        // Right after a dispatch the workers run: the lead still gets a spare, in the lead pool.
        let renew = renewal(&store, &lead, true).expect("a waiting lead keeps a spare");
        assert!(renew(), "it renews on expiry while the workers run");
        assert!(renewal(&store, &lead, false).is_none(), "ordinary tasks and workers use the ordinary pool");
        // Once every worker settled (the wake is due or done), an expired spare is not restarted.
        save_team(&store.lock().unwrap(), &lead, &[("task-w1", "completed")]);
        assert!(!renew());
        assert!(renewal(&store, &lead, true).is_none());
        save_team(&store.lock().unwrap(), &lead, &[("task-w1", "parked")]);
        assert!(renew(), "a parked worker still owes the lead a wake");
    }

    #[test]
    fn a_worker_waiting_on_the_user_keeps_the_first_spare_but_never_renews_it() {
        let (store, project, lead) = lead_store();
        let asking = store.lock().unwrap().create_session(&project, "claude", "default", "ask").unwrap().id;
        save_team(&store.lock().unwrap(), &lead, &[(&asking, "running"), ("task-w2", "running")]);
        let renew = renewal(&store, &lead, true).expect("live workers: the first spare is kept");
        assert!(renew());
        // An approval or a question holds the worker, and with it the review wake, until the
        // user answers: no more idle processes for a wake that is not coming.
        store.lock().unwrap().status(&asking, "waiting").unwrap();
        assert!(!renew(), "a worker waiting on the user stops renewals");
        assert!(renewal(&store, &lead, true).is_some(), "but the lead still keeps its first spare");
        // Also when it is the only live worker, or under a parked parent.
        save_team(&store.lock().unwrap(), &lead, &[(&asking, "running"), ("task-w2", "completed")]);
        assert!(!renew());
        save_team(&store.lock().unwrap(), &lead, &[("task-w1", "parked"), (&asking, "running")]);
        assert!(!renew());
        // Once the user answers the check holds again, but it is asked only when a spare
        // expires: a chain whose expiry landed during the wait has already ended for good.
        store.lock().unwrap().status(&asking, "running").unwrap();
        assert!(renew());
    }

    #[test]
    fn a_paused_or_stopped_team_never_keeps_or_renews_its_leads_spare() {
        let (store, _, lead) = lead_store();
        save_team(&store.lock().unwrap(), &lead, &[("task-w1", "parked")]);
        let renew = renewal(&store, &lead, true).expect("a running team with a parked worker keeps a spare");
        assert!(renew());
        // The UI's Stop and Pause go through `architect_control`, not `stop_session`, and leave
        // the parked worker unsettled: no wake is coming, so the spare is never renewed.
        for status in ["paused", "stopped", "failed", "completed", "ready"] {
            set_team_status(&store.lock().unwrap(), &lead, status);
            assert!(!renew(), "{status}");
            assert!(renewal(&store, &lead, true).is_none(), "{status}");
        }
        // "waiting" is the team's own state while its lead's turn has ended and workers run.
        for status in ["running", "waiting"] {
            set_team_status(&store.lock().unwrap(), &lead, status);
            assert!(renew(), "{status}");
        }
    }

    #[test]
    fn a_paused_or_stopped_leads_spare_is_dropped_and_a_settled_teams_lead_gets_an_ordinary_one() {
        let (store, _, lead) = lead_store();
        save_team(&store.lock().unwrap(), &lead, &[("task-w1", "running")]);
        assert!(matches!(pool(&store, &lead, true), Pool::Lead(_)), "a waiting lead uses the lead pool");
        assert!(matches!(pool(&store, &lead, false), Pool::Ordinary), "workers and plain tasks use the ordinary pool");
        // Pause or Stop lands after the lead's run exited but before its run end: the user held
        // the team, so the spare must not fall back to the ordinary pool for ten minutes.
        for status in ["paused", "stopped"] {
            set_team_status(&store.lock().unwrap(), &lead, status);
            let pool = pool(&store, &lead, true);
            assert!(matches!(pool, Pool::Drop) && !pool.keeps(), "{status}");
        }
        // A team that ended by itself: the user's follow-up to the lead is likely, so it gets an
        // ordinary spare like any task, never the lead pool's renewals.
        for status in ["completed", "ready", "failed"] {
            set_team_status(&store.lock().unwrap(), &lead, status);
            let pool = pool(&store, &lead, true);
            assert!(matches!(pool, Pool::Ordinary) && pool.keeps() && pool.renewal().is_none(), "{status}");
        }
        // An active team whose workers all settled: an ordinary spare for the lead's next turn.
        save_team(&store.lock().unwrap(), &lead, &[("task-w1", "completed")]);
        let pool = pool(&store, &lead, true);
        assert!(matches!(pool, Pool::Ordinary) && pool.keeps() && pool.renewal().is_none());
        // A lead whose team cannot be found keeps none either.
        let (empty, _, other) = lead_store();
        assert!(matches!(super::pool(&empty, &other, true), Pool::Drop));
    }

    fn set_team_status(store: &Store, lead: &str, status: &str) {
        let mut team = architect::load(store, lead).unwrap().unwrap();
        team.status = status.into();
        store.db.execute("UPDATE architect_teams SET content=?2 WHERE session_id=?1", rusqlite::params![lead, serde_json::to_string(&team).unwrap()]).unwrap();
    }

    /// The launch `launch_operation_admitted` builds for this turn: its config with the real
    /// instructions, and the real catalog (`build_host`) its warm key hashes.
    fn prepare(state: &AppState, lead: &str, text: &str, generation: u64, kind: Option<architect::internal_turns::CoordinationKind>, explore_on: bool) -> (RunConfig, Vec<serde_json::Value>) {
        let (tx, _rx) = unbounded_channel();
        let team = Some(architect::Admission { parent: lead.into(), generation });
        let prepared = prepare_task_run_in_project(state, lead.into(), Some(text.into()), Vec::new(), tx, Arc::new(AtomicBool::new(false)), RunAdmission { team: team.clone(), kind, ..Default::default() }).unwrap();
        let mut config = prepared.config;
        let (managed, role) = launch_role(team.as_ref(), lead, config.worker);
        assert!(!managed && role == Role::Task, "a lead is never trimmed like a worker");
        let tools = finish_launch(&state.store, &mut config, role, managed, true, explore_on, prepared.restore_stage.is_some());
        (config, tools)
    }

    /// The steps after admission, for a turn with agent-made tools saved.
    fn finish_launch(store: &Mutex<Store>, config: &mut RunConfig, role: Role, managed: bool, team: bool, explore_on: bool, maintenance: bool) -> Vec<serde_json::Value> {
        let history = app_instructions::History::of(&config.session_id, &config.provider, config.resume_id.as_deref());
        let offered = custom_tools_offered(false, managed);
        let explore = crate::explore::run_name(false, explore_on, &config.provider);
        let explore_offered = crate::explore::run_name(false, true, &config.provider).is_some();
        let plan = HostPlan::of(config, team, role, false, explore_offered, explore_on);
        instruct_launch(store, config, LaunchText { role, explore, offered, maintenance });
        let mut layers = app_instructions::fake::FakeLayers { custom: offered, ..Default::default() };
        let host = app_instructions::build_host(&plan, &history, &mut layers).host;
        app_instructions::remember_catalog(&config.session_id, config.resume_id.as_deref(), host.as_ref(), &providers::claude_kept_natives(config.worker, &history));
        host.expect("a task always lists tools").tools
    }

    /// Every field the warm key reads (`warm::key`; its own test pins that list).
    fn shape(c: &RunConfig) -> impl PartialEq + std::fmt::Debug {
        (
            c.provider.clone(),
            c.model.clone(),
            c.reasoning_effort.clone(),
            c.mode.clone(),
            c.cwd.clone(),
            c.resume_id.clone(),
            c.instructions.clone(),
            c.worker,
            c.disallowed_tools.clone(),
            c.codex_settings.clone(),
            c.goal.is_none(),
            c.skill.is_none(),
        )
    }

    fn names(tools: &[serde_json::Value]) -> Vec<&str> {
        tools.iter().filter_map(|tool| tool["name"].as_str()).collect()
    }

    #[test]
    fn a_leads_wake_turn_builds_the_same_launch_as_the_spare_it_adopts() {
        for explore_on in [true, false] {
            let (state, project) = concurrent_task_tests::test_state();
            let lead = {
                let store = state.store.lock().unwrap();
                let lead = store.create_session(&project, "claude", "claude-opus-5-5", "ask").unwrap().id;
                save_team(&store, &lead, &[("task-w1", "running")]);
                lead
            };
            let generation = architect::load(&state.store.lock().unwrap(), &lead).unwrap().unwrap().generation;
            // The dispatch turn: the user's objective, while the workers are still to run.
            let (dispatch, dispatch_tools) = prepare(&state, &lead, "Build the feature with a team.", generation, None, explore_on);
            // The run ends: the harness saved its conversation, and the spare starts from the task.
            state.agents.lock().unwrap().remove(&lead);
            {
                let store = state.store.lock().unwrap();
                store.resume(&lead, "lead-conversation").unwrap();
                store.message(&lead, "assistant", "Dispatched one worker.").unwrap();
                store.finish_task_turn(&lead, true, false).unwrap();
            }
            assert!(starts_spare(&dispatch, false, false, false));
            let spare = spare_config(dispatch.clone(), state.store.lock().unwrap().session(&lead).unwrap());
            // The workers settle and the scheduler wakes the lead with its review.
            save_team(&state.store.lock().unwrap(), &lead, &[("task-w1", "completed")]);
            let (wake, wake_tools) = prepare(&state, &lead, "Review the settled workers for this objective.", generation, Some(architect::internal_turns::CoordinationKind::WorkerReview), explore_on);
            assert_eq!(shape(&spare), shape(&wake), "a mismatch makes every lead spare (and renewal) a wasted process");
            assert_eq!(dispatch_tools, wake_tools, "the warm key hashes the catalog: explore={explore_on}");
            assert_eq!(wake.resume_id.as_deref(), Some("lead-conversation"));
            assert!(spare.prompt.is_empty() && spare.images.is_empty());
            // The launch really carries what the parity is about.
            assert_eq!(wake.instructions.contains("pandacode_explore"), explore_on, "{explore_on}");
            assert_eq!(names(&wake_tools).contains(&"pandacode_explore"), explore_on, "{explore_on}");
            assert!(wake.instructions.contains(crate::app_instructions::REUSE));
            assert!(names(&wake_tools).contains(&crate::custom_tools::TOOL_RUN));
        }
    }

    #[test]
    fn a_maintenance_turn_matches_the_good_spare_and_starts_no_empty_one() {
        let (state, project) = concurrent_task_tests::test_state();
        let task = state.store.lock().unwrap().create_session(&project, "claude", "claude-opus-5-5", "ask").unwrap().id;
        let launch = |text: &str, maintenance: bool| {
            let (tx, _rx) = unbounded_channel();
            let command = maintenance.then(|| PreparedCommand {
                provider: "claude".into(),
                cwd: state.store.lock().unwrap().workspace_root(&project, Some(&task)).unwrap(),
                original: text.into(),
                resolution: slash_commands::Resolution { action: None, arguments: String::new(), accepts_attachments: false, maintenance: true, prompt: text.into(), skill: None },
            });
            let prepared = prepare_task_run_in_project(&state, task.clone(), Some(text.into()), Vec::new(), tx, Arc::new(AtomicBool::new(false)), RunAdmission { command, ..Default::default() }).unwrap();
            assert_eq!(prepared.restore_stage.is_some(), maintenance);
            let mut config = prepared.config;
            let tools = finish_launch(&state.store, &mut config, Role::Task, false, false, true, maintenance);
            state.agents.lock().unwrap().remove(&task);
            let store = state.store.lock().unwrap();
            store.resume(&task, "conversation").unwrap();
            store.message(&task, "assistant", "Done.").unwrap();
            store.finish_task_turn(&task, true, false).unwrap();
            (config, tools)
        };
        let (turn, turn_tools) = launch("Explain the parser.", false);
        assert!(starts_spare(&turn, false, false, false));
        let spare = spare_config(turn, state.store.lock().unwrap().session(&task).unwrap());
        assert!(!spare.instructions.is_empty());
        let (context, context_tools) = launch("/context", true);
        // The same warm key, so the maintenance turn takes the good spare instead of killing it.
        assert_eq!(shape(&spare), shape(&context));
        assert_eq!(turn_tools, context_tools);
        assert_eq!(context.prompt, "/context", "the message stays the bare command");
        assert!(!starts_spare(&context, false, false, true), "a maintenance turn starts no spare");
    }

    #[tokio::test]
    async fn fast_mode_updates_spare_config_and_invalidates_stale_lead_spares() {
        let (state, project) = concurrent_task_tests::test_state();
        let lead = {
            let store = state.store.lock().unwrap();
            let lead = store.create_session(&project, "claude", "claude-opus-5-5", "ask").unwrap().id;
            save_team(&store, &lead, &[("task-w1", "running")]);
            lead
        };
        let generation = architect::load(&state.store.lock().unwrap(), &lead).unwrap().unwrap().generation;
        // Dispatch starts at standard speed, then fast mode is enabled mid-turn before the turn finishes.
        let (dispatch, dispatch_tools) = prepare(&state, &lead, "Build the feature with a team.", generation, None, false);
        assert!(dispatch.codex_settings.is_none());
        providers::warm_launched(&lead);
        let mid_turn_before = providers::warm_epoch(&lead);
        assert_ne!(mid_turn_before, 0);
        task_controls::save_claude_preference(&state, &lead, task_controls::TaskPreference::Fast { enabled: true }).unwrap();
        let mid_turn_after = providers::warm_epoch(&lead);
        assert_ne!(mid_turn_after, 0, "mid-turn /fast must keep warm_epoch nonzero so post-turn start_spare succeeds");
        assert!(mid_turn_after > mid_turn_before, "mid-turn /fast must advance the epoch to invalidate prior spares");
        state.agents.lock().unwrap().remove(&lead);
        {
            let store = state.store.lock().unwrap();
            store.resume(&lead, "lead-conversation").unwrap();
            store.message(&lead, "assistant", "Dispatched one worker.").unwrap();
            store.finish_task_turn(&lead, true, false).unwrap();
        }
        // `spare_config` refreshes `codex_settings` from the saved task so the post-turn spare
        // matches the wake at fast speed (and `warm_epoch` is still nonzero for `prewarm_agent`).
        let fast_spare = spare_config(dispatch.clone(), state.store.lock().unwrap().session(&lead).unwrap());
        assert_eq!(fast_spare.codex_settings, Some(serde_json::json!({"serviceTier": "fast"})));
        assert_eq!(providers::warm_epoch(&lead), mid_turn_after);
        save_team(&state.store.lock().unwrap(), &lead, &[("task-w1", "completed")]);
        let (fast_wake, fast_wake_tools) = prepare(&state, &lead, "Review the settled workers.", generation, Some(architect::internal_turns::CoordinationKind::WorkerReview), false);
        assert_eq!(shape(&fast_spare), shape(&fast_wake));
        assert_eq!(dispatch_tools, fast_wake_tools);
        // Simulate a fast-mode lead spare waiting while a second worker runs, then toggling fast mode off.
        state.agents.lock().unwrap().remove(&lead);
        {
            let store = state.store.lock().unwrap();
            store.message(&lead, "assistant", "Dispatched a second worker.").unwrap();
            store.finish_task_turn(&lead, true, false).unwrap();
        }
        save_team(&state.store.lock().unwrap(), &lead, &[("task-w2", "running")]);
        assert!(matches!(pool(&state.store, &lead, true), Pool::Lead(_)));
        let waiting_spare = spare_config(fast_wake.clone(), state.store.lock().unwrap().session(&lead).unwrap());
        #[cfg(unix)]
        let _serial = providers::spare_pool_test_lock().lock().await;
        #[cfg(unix)]
        let stale_pid = providers::insert_spare_in_cwd_for_test(&lead, waiting_spare.cwd.clone(), true);
        #[cfg(not(unix))]
        providers::warm_launched(&lead);
        let launch_before = providers::warm_epoch(&lead);
        assert_ne!(launch_before, 0);
        // Turning fast mode off retires the stale fast spare and advances its renewal epoch without zeroing it.
        task_controls::save_claude_preference(&state, &lead, task_controls::TaskPreference::Fast { enabled: false }).unwrap();
        let launch_after = providers::warm_epoch(&lead);
        assert_ne!(launch_after, 0, "invalidation preserves a nonzero epoch");
        assert!(launch_after > launch_before, "the stale fast-mode lead spare must not renew");
        #[cfg(unix)]
        {
            assert!(!providers::has_spare_for_test(&lead), "stale fast spare must be retired");
            providers::await_exit(&lead).await.unwrap();
            assert!(providers::process_gone_for_test(stale_pid));
        }
        // The next wake runs at standard speed, so the old fast spare's shape no longer matches.
        save_team(&state.store.lock().unwrap(), &lead, &[("task-w2", "completed")]);
        let (standard_wake, _) = prepare(&state, &lead, "Review the second worker.", generation, Some(architect::internal_turns::CoordinationKind::WorkerReview), false);
        assert_eq!(standard_wake.codex_settings, Some(serde_json::json!({"serviceTier": null})));
        assert_ne!(shape(&waiting_spare), shape(&standard_wake));
        // After that wake finishes, a fresh spare picks up standard speed cleanly.
        let standard_spare = spare_config(waiting_spare, state.store.lock().unwrap().session(&lead).unwrap());
        assert_eq!(shape(&standard_spare), shape(&standard_wake));
    }
}
