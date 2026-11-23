//! The launch's tool-host layering and launch helpers, moved out of `lib.rs` unchanged: what a
//! run's tool host is built from (`HostInputs`, `AppLayers`, `run_host`), its role
//! (`launch_role`), its screenshots (`screenshot_paths`), its event sink (`RunSink`), the next
//! turn's warm spare (`start_spare`) and what a spare's renewal compares (`launch_inputs`).
use crate::app_instructions::{self, HostPlan, Role};
use crate::providers::{self, AgentEvent, RunConfig, RunInput, ToolHost};
use crate::storage::{self, ContextUsage, Store};
use crate::{
    agent_tools, architect, blocking_snapshot, bots, bounded_tail, cloud, custom_tools, design, emit_coalesced, explore, goal_state, lead_spare,
    lock_agents, persist_turn_changes, progress, record_request_event, remote, run_tool_id, save_agent_activity, schedules, session_titles, settle_account_switch,
    simulator, subagent_state, tray, turn_changes, vm, worker_approvals, Agents, AppState,
};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, AtomicI64, Ordering},
    Arc, Mutex,
};
use tauri::Manager;

/// What a task's next launch builds its instructions and tool catalog from besides its
/// `RunConfig`: the explorer for its harness, the agent-made tools switch, Colab's native tools
/// (`cloud::colab_tools::with_colab`) and whether the task has a catalog here at all. Whether that catalog is empty is left out: it rides only the
/// message note, never the instructions or the tool list. A lead's warm spare is renewed only
/// while this is unchanged (`warm::still_current`).
pub(crate) fn launch_inputs(app: &tauri::AppHandle, session_id: &str, provider: &str, cwd: &Path) -> String {
    // One store lookup, bounded Claude settings reads, and marker-file stats (`explore-off`/
    // `explore-on-<provider>`, the tools switch); `warm.rs` calls it on a blocking thread, once
    // per spare start and lead-spare renewal (at most `warm::MAX_RENEWALS`).
    let catalog = custom_tools::has_catalog(app, session_id);
    let colab = cloud::colab::is_connected() && cloud::colab::native_tools_enabled();
    launch_inputs_key(
        explore::enabled_for_run(app, session_id, provider, cwd),
        custom_tools::ipc::enabled_for(app),
        catalog,
        colab,
    )
}

/// The `launch_inputs` key for these switches.
fn launch_inputs_key(explore: bool, custom: bool, catalog: bool, colab: bool) -> String {
    format!("explore:{explore} custom:{custom} catalog:{catalog} colab:{colab}")
}
/// What a run's tool host is built for, besides its `HostPlan`.
pub(crate) struct HostInputs<'a> {
    pub(crate) app: &'a tauri::AppHandle,
    pub(crate) session_id: &'a str,
    pub(crate) stopped: &'a Arc<AtomicBool>,
    pub(crate) team: Option<&'a architect::Admission>,
    /// The agent-made tools' real definitions, for names the conversation holds but this turn
    /// does not offer.
    pub(crate) custom_definitions: &'a [serde_json::Value],
}

/// The app's builders for each family of a run's tool host (`app_instructions::build_host`
/// decides which are listed and refused). `custom` adds the agent-made tools, when the run is
/// offered them.
struct AppLayers<'a, F> {
    at: &'a HostInputs<'a>,
    custom: Option<F>,
    tracker: Option<Arc<Mutex<turn_changes::Tracker>>>,
    title_run: Option<&'a session_titles::TitleRun>,
}

impl<F: FnOnce(Option<ToolHost>) -> ToolHost> app_instructions::HostLayers for AppLayers<'_, F> {
    fn base(&mut self, _plan: &HostPlan) -> (Option<ToolHost>, bool) {
        let (app, sid, stopped) = (self.at.app, self.at.session_id, self.at.stopped);
        let host = match self.at.team {
            // Workers keep their scoped team tools; only the lead may manage other tasks.
            Some(admission) => architect::host(app.clone(), sid.to_owned(), stopped.clone(), admission).map(|host| {
                if admission.parent == sid {
                    agent_tools::with_app_host(host, agent_tools::host(app.clone(), sid.to_owned(), stopped.clone()))
                } else {
                    host
                }
            }),
            None => Some(agent_tools::host(app.clone(), sid.to_owned(), stopped.clone())),
        };
        let missing = self.at.team.is_some() && host.is_none();
        let host = agent_tools::with_jev(host, app.clone(), sid.to_owned(), stopped.clone());
        (bots::tools::with_bot(host, app.clone(), sid.to_owned(), stopped.clone()), missing)
    }
    fn schedules(&mut self, host: Option<ToolHost>) -> Option<ToolHost> {
        schedules::tools::with_schedules(host, self.at.app.clone(), self.at.session_id.to_owned(), self.at.stopped.clone())
    }
    fn devices(&mut self, host: Option<ToolHost>, plan: &HostPlan) -> Option<ToolHost> {
        let (app, sid, stopped) = (self.at.app, self.at.session_id, self.at.stopped);
        let host = simulator::tools::with_simulator_for(host, app.clone(), sid.to_owned(), stopped.clone());
        let host = vm::tools::with_vm(host, app.clone(), sid.to_owned(), stopped.clone());
        // A cloud agent already runs on its machine; Colab tools are for local agents.
        let host = if plan.cloud { host } else { cloud::colab_tools::with_colab(host, app.clone(), sid.to_owned(), stopped.clone()) };
        let host = remote::orchestrate::with_machines(host, app.clone(), sid.to_owned(), stopped.clone(), plan.team);
        design::with_design(host, app.clone(), sid.to_owned(), stopped.clone())
    }
    fn progress(&mut self, host: Option<ToolHost>) -> Option<ToolHost> {
        progress::with_progress(host, self.at.app.clone(), self.at.session_id.to_owned(), self.at.stopped.clone())
    }
    fn explore(&mut self, host: Option<ToolHost>, strict: bool) -> ToolHost {
        explore::with_explore(host, self.at.app.clone(), self.at.session_id.to_owned(), self.at.stopped.clone(), strict)
    }
    fn custom(&mut self, host: Option<ToolHost>) -> Option<ToolHost> {
        match self.custom.take() {
            Some(add) => Some(add(host)),
            None => host,
        }
    }
    fn custom_definitions(&self) -> Vec<serde_json::Value> {
        self.at.custom_definitions.to_vec()
    }
    fn always(&mut self, host: Option<ToolHost>) -> ToolHost {
        let (app, sid, stopped) = (self.at.app, self.at.session_id, self.at.stopped);
        let host = cloud::deploy::with_deploy(host, app.clone(), sid.to_owned(), stopped.clone());
        agent_tools::with_preview(host, app.clone(), sid.to_owned(), stopped.clone())
    }
    fn track(&mut self, host: Option<ToolHost>) -> ToolHost {
        turn_changes::with_host(host, self.tracker.take(), self.at.stopped.clone())
    }
    fn titles(&mut self, host: Option<ToolHost>) -> ToolHost {
        session_titles::with_host(self.title_run, host, self.at.stopped.clone())
    }
}

/// A run's whole tool host, built from its plan (`app_instructions::build_host`), with the
/// names its handler refuses. `history`: what the conversation may already hold.
pub(crate) fn run_host<F>(plan: &HostPlan, at: &HostInputs, history: &app_instructions::History, custom: Option<F>, tracker: Option<Arc<Mutex<turn_changes::Tracker>>>, title_run: Option<&session_titles::TitleRun>) -> app_instructions::RunHost
where
    F: FnOnce(Option<ToolHost>) -> ToolHost,
{
    app_instructions::build_host(plan, history, &mut AppLayers { at, custom, tracker, title_run })
}

/// Whether this launch is a managed team worker, and the role its instructions and tools take.
/// Shared by every turn, so a lead's wake builds the same launch as the spare it adopts.
pub(crate) fn launch_role(team: Option<&architect::Admission>, session_id: &str, worker: Option<providers::WorkerTrim>) -> (bool, Role) {
    let managed_worker = team.is_some_and(|admission| admission.parent != session_id);
    (managed_worker, Role::of(managed_worker, worker.is_some_and(|trim| trim.read_only)))
}

/// Where a screenshot attachment's file is: each ID must be a canonical UUID naming a regular
/// capture file of at most 5 MB.
pub(crate) fn screenshot_paths(capture_dir: &Path, image_ids: Vec<String>) -> crate::Result<Vec<PathBuf>> {
    image_ids
        .into_iter()
        .map(|id| {
            let parsed = uuid::Uuid::parse_str(&id)
                .map_err(|_| "Invalid screenshot attachment.".to_string())?;
            if parsed.to_string() != id {
                return Err("Invalid screenshot attachment.".to_string());
            }
            let path = capture_dir.join(format!("{id}.png"));
            let metadata = std::fs::symlink_metadata(&path)
                .map_err(|_| "Screenshot is unavailable. Capture it again.".to_string())?;
            if !metadata.file_type().is_file() || metadata.len() > 5 * 1024 * 1024 {
                return Err("Invalid screenshot attachment.".to_string());
            }
            Ok(path)
        })
        .collect()
}

/// A goal operation's answer, sent once.
type GoalReply = tokio::sync::oneshot::Sender<crate::Result<Option<goal_state::GoalState>>>;

/// What a run's event sink writes to: the run's shared state (`launch_operation_admitted`).
pub(crate) struct RunSink {
    pub(crate) app: tauri::AppHandle,
    /// A cloud run's events are dropped while PandaCode quits (the remote run continues).
    pub(crate) cloud: bool,
    pub(crate) last_event: Arc<AtomicI64>,
    pub(crate) tracker: Option<Arc<Mutex<turn_changes::Tracker>>>,
    pub(crate) run_id: String,
    pub(crate) assistant: Arc<Mutex<String>>,
    pub(crate) subagents: Arc<Mutex<subagent_state::SubagentState>>,
    pub(crate) store: Arc<Mutex<Store>>,
    /// The run's own pending requests and stop handle (`worker_approvals`).
    pub(crate) own_run: worker_approvals::Run,
    /// Whether the run is a team worker's: its requests are resolved by the team, not asked.
    pub(crate) team_worker: bool,
    /// The first persistence error of the run.
    pub(crate) errors: Arc<Mutex<Option<String>>>,
    pub(crate) agents: Agents,
    pub(crate) goal_reply: Arc<Mutex<Option<GoalReply>>>,
    pub(crate) team: Option<architect::Admission>,
    pub(crate) coalescer: Arc<Mutex<providers::Coalescer>>,
}

/// Events whose persistence goes through the pending-approval bookkeeping.
fn is_request(kind: &str) -> bool {
    matches!(kind, "approval" | "approval_cancelled" | "input_request" | "input_cancelled")
}

impl RunSink {
    /// The provider sink: saves, tracks and forwards each event of the run.
    pub(crate) fn sink(self) -> providers::Sink {
        let native_turn = Mutex::new(String::new());
        Arc::new(move |event: AgentEvent| self.handle(&native_turn, event))
    }

    fn handle(&self, native_turn: &Mutex<String>, mut e: AgentEvent) {
        if self.cloud && self.app.state::<AppState>().shutdown.load(Ordering::SeqCst) != 0 {
            return;
        }
        self.last_event.store(storage::now(), Ordering::SeqCst);
        if e.kind == "done" || e.kind == providers::HEARTBEAT {
            return;
        }
        let usage = if e.kind == "usage" {
            let Some(usage) = e.data.as_ref().and_then(ContextUsage::from_value) else {
                return;
            };
            // Forward only bounded, recognized metadata, never the raw
            // provider response or cumulative billing totals.
            e.data = serde_json::to_value(&usage).ok();
            Some(usage)
        } else {
            None
        };
        self.track(native_turn, &mut e);
        if e.kind == providers::ACCOUNT_SWITCHED {
            self.account_switched(&e);
            return;
        }
        if e.kind == providers::UNANSWERED_APPROVAL {
            worker_approvals::stop_unanswered(self.team_worker, &self.own_run, &e);
            return;
        }
        self.record(&mut e, usage.as_ref());
        if e.kind == "goal_ready" {
            self.answer_goal(&e);
        }
        if is_request(&e.kind) {
            architect::activity(&self.app, &e.session_id, self.team.as_ref());
        }
        // Cloned only for the turn boundary below.
        let completed = (e.kind == "turn_complete").then(|| e.session_id.clone());
        emit_coalesced(&self.app, &self.coalescer, e);
        if let Some(session_id) = completed {
            self.finish_turn(&session_id);
        }
    }

    /// A pooled run moved to another account (any run, a user's too): the old account's requests
    /// can no longer be answered, so their cards go.
    fn account_switched(&self, e: &AgentEvent) {
        let cancelled = settle_account_switch(&self.store, &self.own_run, &e.session_id);
        if cancelled.is_empty() {
            return;
        }
        for event in cancelled {
            emit_coalesced(&self.app, &self.coalescer, event);
        }
        tray::refresh(&self.app);
    }

    /// Turn starts, run-scoped tool ids and the change tracker's view of tools and subagents.
    fn track(&self, native_turn: &Mutex<String>, e: &mut AgentEvent) {
        if e.kind == "turn_start" {
            if let Some(tracker) = &self.tracker {
                blocking_snapshot(|| {
                    if let Ok(mut tracker) = tracker.lock() {
                        tracker.started();
                    }
                });
            }
            if let Some(turn) = e.data.as_ref().and_then(|data| data["turnId"].as_str()) {
                *native_turn.lock().unwrap_or_else(|poison| poison.into_inner()) = turn.into();
            }
        }
        if let Some(tool) = &mut e.tool {
            let turn = native_turn.lock().unwrap_or_else(|poison| poison.into_inner());
            tool.id = run_tool_id(&self.run_id, &turn, &tool.id);
        }
        if let Some(tracker) = self.tracker.as_ref().filter(|_| e.tool.is_some() || e.kind == "subagent") {
            blocking_snapshot(|| {
                if let Ok(mut tracker) = tracker.lock() {
                    tracker.observe(e);
                }
            });
        }
    }

    /// Keeps the reply text, or saves the event; a failed save is the run's error and stops a goal.
    fn record(&self, e: &mut AgentEvent, usage: Option<&ContextUsage>) {
        if e.kind == "text" {
            if let Ok(mut text) = self.assistant.lock() {
                text.push_str(&e.text);
                bounded_tail(&mut text, 512 * 1024);
            }
            return;
        }
        let Err(error) = self.save(e, usage) else {
            return;
        };
        if let Ok(mut slot) = self.errors.lock() {
            *slot = Some(error);
        }
        if matches!(e.kind.as_str(), "goal" | "goal_input") {
            if let Ok(registry) = lock_agents(&self.agents) {
                if let Some(agent) = registry.get(&e.session_id) {
                    let _ = agent.send(RunInput::Stop);
                }
            }
        }
    }

    fn save(&self, e: &mut AgentEvent, usage: Option<&ContextUsage>) -> crate::Result<()> {
        if e.kind == "subagent" {
            return self
                .subagents
                .lock()
                .map_err(|error| error.to_string())
                .and_then(|mut children| children.record(&self.store, &self.run_id, e));
        }
        if !is_request(&e.kind) {
            return self
                .store
                .lock()
                .map_err(|error| error.to_string())
                .and_then(|db| save_agent_activity(&db, &self.assistant, e, usage));
        }
        // Locks `agents`: this sink is never called with that lock held (see its doc).
        let saved = record_request_event(&self.store, &self.own_run, self.team_worker, &self.agents, e);
        if saved.is_ok() && e.kind == "approval" {
            if let Some(request_id) = &e.request_id {
                let lasting_only = e.data.as_ref().is_some_and(|data| data[providers::LASTING_ONLY] == true);
                bots::approval_requested(&self.app, &e.session_id, request_id, &e.text, lasting_only);
            }
            tray::refresh(&self.app);
        }
        saved
    }

    /// Answers a waiting goal operation with the run's first save error or the goal metadata.
    fn answer_goal(&self, e: &AgentEvent) {
        let result = self
            .errors
            .lock()
            .map_err(|_| "Goal persistence is unavailable.".to_string())
            .and_then(|error| {
                if let Some(error) = error.as_ref() {
                    Err(error.clone())
                } else {
                    e.data
                        .clone()
                        .filter(|v| !v.is_null())
                        .map(serde_json::from_value)
                        .transpose()
                        .map_err(|_| "Invalid goal metadata.".to_string())
                }
            });
        if let Ok(mut slot) = self.goal_reply.lock() {
            if let Some(reply) = slot.take() {
                let _ = reply.send(result);
            }
        }
    }

    /// At a turn boundary, persists the files the turn changed.
    // Runs at the `turn_complete` frame, before the process exits; `boundary()` only compares the
    // snapshots the tools already took (it never rereads the tree), so it needs no `await_exit`.
    fn finish_turn(&self, session_id: &str) {
        let Some(tracker) = &self.tracker else {
            return;
        };
        let capture = blocking_snapshot(|| {
            tracker.lock().ok().and_then(|mut tracker| {
                let last_write = tracker.last_write();
                tracker.boundary().map(|capture| (capture, last_write))
            })
        });
        if let Some((capture, last_write)) = capture {
            persist_turn_changes(&self.app, &self.store, session_id, capture, last_write);
        }
    }
}

/// Start the next turn's agent after a clean run, so a follow-up skips the CLI's own startup.
/// `next` is this launch and the tools it listed; `launch` the task's launch count read at run end.
pub(crate) fn start_spare(app: &tauri::AppHandle, store: &Arc<Mutex<Store>>, session_id: &str, team: Option<&architect::Admission>, launch: u64, next: (RunConfig, (Vec<serde_json::Value>, HashSet<String>))) {
    // Once quitting begins (`on_run_event`), no process may start that the quit would then wait for.
    if !providers::warm_spares_on(app) || app.state::<AppState>().shutdown.load(Ordering::SeqCst) != 0 {
        return;
    }
    let (next, (tools, approvals)) = next;
    // A turn that ended without any reply (seen after background commands) may have
    // left the session in a state a spare would inherit: start the next one fresh.
    let replied = store.lock().ok().and_then(|db| db.db.query_row(
        "SELECT EXISTS(SELECT 1 FROM messages WHERE session_id=?1 AND role='assistant' AND id>(SELECT COALESCE(MAX(id),0) FROM messages WHERE session_id=?1 AND role IN ('user','coordination')))",
        [session_id],
        |row| row.get::<_, bool>(0),
    ).ok()).unwrap_or(false);
    // A lead waiting on its workers keeps a spare for its review wake: in the lead pool,
    // started again on expiry while the workers still run. A lead whose team is not
    // running or waiting (paused by the user, settled) keeps none: a Pause that landed
    // after this run exited but before here leaves no wake to serve.
    let lead = team.is_some_and(|admission| admission.parent == session_id);
    let pool = lead_spare::pool(store, session_id, lead);
    let task = store.lock().ok().filter(|_| replied && pool.keeps()).and_then(|db| db.session(session_id).ok());
    if let Some(task) = task {
        let renew = pool.renewal().map(|renew| {
            let app = app.clone();
            Arc::new(move || providers::warm_spares_on(&app) && renew()) as providers::WarmRenew
        });
        let next = lead_spare::spare_config(next, task);
        let (inputs_app, inputs_session, inputs_provider, inputs_cwd) = (app.clone(), session_id.to_owned(), next.provider.clone(), next.cwd.clone());
        let inputs = move || launch_inputs(&inputs_app, &inputs_session, &inputs_provider, &inputs_cwd);
        tauri::async_runtime::spawn(async move {
            let _ = providers::prewarm_agent(next, tools, approvals, launch, renew, inputs).await;
        });
    }
}

#[cfg(test)]
mod tests {
    use super::launch_inputs_key;

    #[test]
    fn every_launch_input_switch_changes_the_key() {
        let base = launch_inputs_key(false, false, false, false);
        for key in [
            launch_inputs_key(true, false, false, false),
            launch_inputs_key(false, true, false, false),
            launch_inputs_key(false, false, true, false),
            launch_inputs_key(false, false, false, true),
        ] {
            assert_ne!(key, base);
        }
        assert_ne!(launch_inputs_key(false, false, false, true), launch_inputs_key(true, false, false, false));
        assert_eq!(launch_inputs_key(true, true, true, true), launch_inputs_key(true, true, true, true));
    }
}
