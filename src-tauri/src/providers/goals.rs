//! Codex owns goal scheduling, accounting and continuation. This adapter only
//! retains its connection and reflects authoritative state; it never generates
//! continuation prompts or infers success from the end of a single turn.
use super::*;
use crate::goal_state::{GoalRequest, GoalState};
use tokio::{sync::oneshot, time::Instant};

const MAX_PENDING: usize = 16;
const RPC_TIMEOUT: Duration = Duration::from_secs(30);
const IDLE_TIMEOUT: Duration = Duration::from_secs(60);

type GoalReply = oneshot::Sender<Result<Option<GoalState>, String>>;
pub(super) type RpcReply = oneshot::Sender<Result<Value, String>>;

pub(super) struct Acknowledgement {
    reply: GoalReply,
    result: Result<Option<GoalState>, String>,
}
impl Acknowledgement {
    pub fn send(self) {
        let _ = self.reply.send(self.result);
    }
}

pub(super) enum Purpose {
    Goal {
        request: GoalRequest,
        reply: Option<GoalReply>,
        startup: bool,
    },
    Boundary {
        failure: Option<String>,
    },
    Stop,
    Preflight,
    PauseBeforeResume,
    Settings(Value),
    Rpc(RpcReply),
}
struct Pending {
    purpose: Purpose,
    deadline: Instant,
}

pub(super) struct Runtime {
    pub state: Option<GoalState>,
    pub turn_running: bool,
    pub stopping: bool,
    pub resolved_effort: Option<String>,
    pub collaboration_mode: Option<Value>,
    supported_tiers: Option<HashSet<String>>,
    model_catalog_pages: u8,
    model_catalog_cursors: HashSet<String>,
    pending: HashMap<u64, Pending>,
    next_id: u64,
    idle_deadline: Option<Instant>,
    stop_deadline: Option<Instant>,
}
impl Default for Runtime {
    fn default() -> Self {
        Self {
            state: None,
            turn_running: false,
            stopping: false,
            resolved_effort: None,
            collaboration_mode: None,
            supported_tiers: None,
            model_catalog_pages: 0,
            model_catalog_cursors: HashSet::new(),
            pending: HashMap::new(),
            next_id: 10_000,
            idle_deadline: None,
            stop_deadline: None,
        }
    }
}
impl Runtime {
    pub fn active(&self) -> bool {
        self.state
            .as_ref()
            .is_some_and(|state| state.status == "active")
    }
    pub fn deadline(&self) -> Option<Instant> {
        self.pending
            .values()
            .map(|pending| pending.deadline)
            .chain(self.idle_deadline)
            .chain(self.stop_deadline)
            .min()
    }
    pub fn cancel_pending(&mut self) {
        for (_, pending) in self.pending.drain() {
            match pending.purpose {
                Purpose::Goal {
                    reply: Some(reply), ..
                } => {
                    let _ = reply.send(Err(
                        "The agent stopped before the goal operation completed.".into(),
                    ));
                }
                Purpose::Rpc(reply) => {
                    let _ = reply.send(Err(
                        "The agent stopped before the operation completed.".into()
                    ));
                }
                _ => {}
            }
        }
    }
}

fn goal_params(request: &GoalRequest, thread_id: &str) -> Result<(&'static str, Value), String> {
    let mut params = json!({"threadId":thread_id});
    let method = match request {
        GoalRequest::Get => "thread/goal/get",
        GoalRequest::Clear => "thread/goal/clear",
        GoalRequest::Pause => {
            params["status"] = json!("paused");
            "thread/goal/set"
        }
        GoalRequest::Resume => {
            params["status"] = json!("active");
            "thread/goal/set"
        }
        GoalRequest::Set {
            objective,
            token_budget,
        } => {
            if objective.trim().is_empty() || objective.len() > 32 * 1024 {
                return Err("Enter a goal between 1 and 32,768 bytes.".into());
            }
            if token_budget.is_some_and(|budget| budget == 0 || budget > 9_007_199_254_740_991) {
                return Err("A goal token budget must be a positive whole number.".into());
            }
            params["objective"] = json!(objective.trim());
            params["status"] = json!("active");
            params["tokenBudget"] = json!(token_budget);
            "thread/goal/set"
        }
    };
    Ok((method, params))
}

fn snapshot(value: &Value, thread_id: &str) -> Result<Option<GoalState>, String> {
    if value.is_null() {
        return Ok(None);
    }
    let state: GoalState = serde_json::from_value(value.clone())
        .map_err(|_| "Codex returned an invalid goal snapshot")?;
    if state.thread_id != thread_id || !state.is_valid() {
        return Err("Codex returned an invalid goal snapshot".into());
    }
    Ok(Some(state))
}

impl Protocol {
    pub(super) fn goal_request(
        &mut self,
        method: &str,
        params: Value,
        purpose: Purpose,
        step: &mut Step,
    ) -> Result<(), String> {
        if self.goals.pending.len() >= MAX_PENDING {
            return Err("Too many pending Codex operations. Try again shortly.".into());
        }
        let id = self.goals.next_id;
        self.goals.next_id = id
            .checked_add(1)
            .ok_or("Codex operation ID limit reached")?;
        self.goals.pending.insert(
            id,
            Pending {
                purpose,
                deadline: Instant::now() + RPC_TIMEOUT,
            },
        );
        step.write
            .push(json!({"id":id,"method":method,"params":params}));
        Ok(())
    }
    fn goal_snapshot(&mut self, state: Option<GoalState>, step: &mut Step) {
        let previous = self.goals.state.as_ref().map(|state| &state.status);
        let next = state.as_ref().map(|state| &state.status);
        let changed = previous != next;
        self.goals.state = state;
        let mut event = self.event("goal", "", None);
        event.data = Some(json!(self.goals.state));
        step.events.push(event);
        if self.goals.active() && !self.goals.turn_running {
            self.goals
                .idle_deadline
                .get_or_insert(Instant::now() + IDLE_TIMEOUT);
        } else {
            self.goals.idle_deadline = None;
        }
        if changed {
            if let Some(goal) = &self.goals.state {
                let label = match goal.status.as_str() {
                    "active" => "Working toward goal",
                    "paused" => "Goal paused",
                    "blocked" => "Goal needs attention",
                    "budgetLimited" => "Goal token budget reached",
                    "usageLimited" => "Goal paused at the account usage limit",
                    "complete" => "Goal completed",
                    _ => "Goal updated",
                };
                step.events.push(self.event("status", label, None));
            }
        }
    }
    pub(super) fn codex_bootstrap(&mut self, step: &mut Step) -> Result<(), String> {
        if self.remote_id.is_empty() {
            self.codex_load_thread(step);
        } else if matches!(
            self.config.goal,
            Some(GoalRequest::Get | GoalRequest::Pause | GoalRequest::Clear)
        ) {
            // These operations work directly against the saved thread. Loading
            // it could let a previously active goal start before we pause it.
            self.codex_goal_or_prompt(step)?;
        } else {
            self.goal_request(
                "thread/goal/get",
                json!({"threadId":self.remote_id}),
                Purpose::Preflight,
                step,
            )?;
        }
        Ok(())
    }
    fn codex_load_thread(&mut self, step: &mut Step) {
        let mut params = self.codex_permissions(false);
        params["cwd"] = json!(self.config.cwd);
        if let Some(effort) = &self.config.reasoning_effort {
            params["config"] = json!({"model_reasoning_effort": effort});
        }
        if let Some(servers) = &self.codex_mcp_servers {
            if !params["config"].is_object() {
                params["config"] = json!({});
            }
            if let Some(servers) = servers.as_object() {
                for (name, server) in servers {
                    // Dotted overrides preserve the user's other MCP servers.
                    params["config"][format!("mcp_servers.{name}")] = server.clone();
                }
            }
        }
        if self.config.model != "default" && !self.config.model.is_empty() {
            params["model"] = json!(self.config.model);
        }
        if self
            .config
            .codex_settings
            .as_ref()
            .is_some_and(|settings| settings.get("serviceTier").is_some())
        {
            // A tier selected for the previous model must not influence resume
            // before we can validate the newly selected model's capabilities.
            params["serviceTier"] = Value::Null;
        }
        let method = if self.remote_id.is_empty() {
            if let Some(host) = &self.host {
                params["dynamicTools"] = json!(host.host.tools);
            }
            "thread/start"
        } else {
            params["threadId"] = json!(self.remote_id);
            params["excludeTurns"] = json!(true);
            "thread/resume"
        };
        step.write
            .push(json!({"id":2,"method":method,"params":params}));
    }
    pub(super) fn codex_goal_ready(&mut self, step: &mut Step) -> Result<(), String> {
        // A team worker's tier is required: its saved catalog id must be there, never null.
        if let Some(key) = &self.config.required_tier {
            if !self.config.codex_settings.as_ref().is_some_and(|settings| settings["serviceTier"].is_string()) {
                return Err(format!(
                    "This worker must run at its {} speed tier, which was not set for {}; it will not run at the default speed.",
                    crate::command_operations::tier_label(key),
                    self.tier_model()
                ));
            }
        }
        if let Some(mut settings) = self.config.codex_settings.take() {
            self.normalize_codex_settings(&mut settings, step)?;
            let params = self.valid_live_params("thread/settings/update", settings.clone())?;
            self.goal_request(
                "thread/settings/update",
                params,
                Purpose::Settings(settings),
                step,
            )?;
            return Ok(());
        }
        self.codex_goal_or_prompt(step)
    }
    pub(super) fn wants_tier_catalog(&self) -> bool {
        self.config.required_tier.is_some()
            || self
                .config
                .codex_settings
                .as_ref()
                .is_some_and(|settings| settings["serviceTier"].is_string())
    }
    /// The model a speed tier is checked for, as Codex resolved it.
    fn tier_model(&self) -> &str {
        if self.config.model.is_empty() || self.config.model == "default" {
            if self.active_model.is_empty() { "default" } else { &self.active_model }
        } else {
            &self.config.model
        }
    }
    pub(super) fn remember_model_tiers(&mut self, result: &Value) -> bool {
        self.goals.model_catalog_pages = self.goals.model_catalog_pages.saturating_add(1);
        let model = result["data"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|model| model["model"].as_str() == Some(&self.active_model));
        if let Some(model) = model {
            let mut tiers: HashSet<String> = model["serviceTiers"]
                .as_array()
                .into_iter()
                .flatten()
                .take(32)
                .filter_map(|tier| tier["id"].as_str())
                .filter(|tier| tier.len() <= 64)
                .map(str::to_owned)
                .collect();
            tiers.extend(
                model["additionalSpeedTiers"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .take(32)
                    .filter_map(Value::as_str)
                    .filter(|tier| tier.len() <= 64)
                    .map(str::to_owned),
            );
            self.goals.supported_tiers = Some(tiers);
            true
        } else {
            false
        }
    }
    pub(super) fn next_model_page(
        &mut self,
        result: &Value,
        step: &mut Step,
    ) -> Result<bool, String> {
        let Some(cursor) = result["nextCursor"]
            .as_str()
            .filter(|cursor| !cursor.is_empty())
        else {
            return Ok(false);
        };
        if cursor.len() > 2048
            || self.goals.model_catalog_pages >= 10
            || !self.goals.model_catalog_cursors.insert(cursor.into())
        {
            return Err("Codex returned an invalid or oversized model catalog.".into());
        }
        step.write.push(json!({"id":6,"method":"model/list","params":{"limit":100,"includeHidden":false,"cursor":cursor}}));
        Ok(true)
    }
    fn normalize_codex_settings(
        &self,
        settings: &mut Value,
        step: &mut Step,
    ) -> Result<(), String> {
        if let Some(mode) = settings.get_mut("collaborationMode") {
            if !matches!(mode["mode"].as_str(), Some("plan" | "default")) {
                return Err("The saved collaboration mode is invalid.".into());
            }
            let model = if self.config.model.is_empty() || self.config.model == "default" {
                &self.active_model
            } else {
                &self.config.model
            };
            if model.is_empty() || model == "default" {
                return Err("Codex did not resolve a model for this collaboration mode.".into());
            }
            // A preset's stale embedded model/effort must never undo a newer
            // choice in PandaCode's composer. Null restores native instructions.
            mode["settings"] = json!({"model":model,"reasoning_effort":self.config.reasoning_effort.as_ref().or(self.goals.resolved_effort.as_ref()),"developer_instructions":null});
        }
        if let Some(tier) = settings["serviceTier"].as_str() {
            let Some(supported) = &self.goals.supported_tiers else {
                return Err("Codex could not confirm this model's speed options. Set /fast off or refresh models and try again.".into());
            };
            if !supported.contains(tier) {
                // A team worker's tier is required: refuse rather than run at the default speed.
                if let Some(key) = &self.config.required_tier {
                    return Err(crate::command_operations::tier_missing(key, self.tier_model()));
                }
                settings["serviceTier"] = Value::Null;
                step.events.push(self.event(
                    "status",
                    "The chosen speed tier is unavailable for the selected model; using its standard speed",
                    None,
                ));
            }
        }
        Ok(())
    }
    fn codex_goal_or_prompt(&mut self, step: &mut Step) -> Result<(), String> {
        if let Some(request) = self.config.goal.take() {
            if !self.config.images.is_empty() || self.config.skill.is_some() {
                return Err("Goal controls cannot include attachments or skills. Add these in a separate message.".into());
            }
            let (method, params) = goal_params(&request, &self.remote_id)?;
            self.goal_request(
                method,
                params,
                Purpose::Goal {
                    request,
                    reply: None,
                    startup: true,
                },
                step,
            )?;
            self.phase = 1;
            Ok(())
        } else {
            self.codex_prompt(step)
        }
    }
    pub(super) fn goal_control(&mut self, request: GoalRequest, reply: GoalReply) -> Step {
        let mut step = Step::default();
        let prepared = if self.config.provider != "codex" {
            Err("Goals require the Codex harness.".into())
        } else if self.remote_id.is_empty() || self.phase == 0 {
            Err("Wait for the Codex session to finish connecting.".into())
        } else if self.goals.stopping {
            Err("The agent is stopping. Wait before changing its goal.".into())
        } else {
            goal_params(&request, &self.remote_id)
        };
        match prepared {
            Ok((method, params)) if self.goals.pending.len() < MAX_PENDING => {
                // Bounds are checked before moving the acknowledgement sender.
                let _ = self.goal_request(
                    method,
                    params,
                    Purpose::Goal {
                        request,
                        reply: Some(reply),
                        startup: false,
                    },
                    &mut step,
                );
            }
            Ok(_) => {
                let _ = reply.send(Err(
                    "Too many pending Codex operations. Try again shortly.".into()
                ));
            }
            Err(error) => {
                let _ = reply.send(Err(error));
            }
        }
        step
    }
    pub(super) fn codex_control(&mut self, method: String, params: Value, reply: RpcReply) -> Step {
        let mut step = Step::default();
        let prepared =
            if self.config.provider != "codex" || self.remote_id.is_empty() || self.phase == 0 {
                Err("This operation requires a connected Codex agent.".into())
            } else {
                self.valid_live_params(&method, params)
            };
        match prepared {
            Ok(params) if self.goals.pending.len() < MAX_PENDING => {
                let _ = self.goal_request(&method, params, Purpose::Rpc(reply), &mut step);
            }
            Ok(_) => {
                let _ = reply.send(Err(
                    "Too many pending Codex operations. Try again shortly.".into()
                ));
            }
            Err(error) => {
                let _ = reply.send(Err(error));
            }
        }
        step
    }
    fn valid_live_params(&self, method: &str, mut params: Value) -> Result<Value, String> {
        let allowed: &[&str] = match method {
            "thread/backgroundTerminals/list" => &["cursor", "limit"],
            "thread/backgroundTerminals/terminate" => &["processId"],
            "thread/backgroundTerminals/clean" => &[],
            "thread/settings/update" => &[
                "personality",
                "serviceTier",
                "collaborationMode",
                "model",
                "effort",
                "approvalPolicy",
                "approvalsReviewer",
                "sandboxPolicy",
            ],
            // Guardian retry intentionally is not accepted here: its event must
            // first come from a native assessment cache, never arbitrary JSON.
            _ => return Err("This Codex operation is not available on the running task.".into()),
        };
        if preview_json(&params, 32 * 1024 + 1).len() > 32 * 1024 {
            return Err("Codex operation arguments are too large.".into());
        }
        let object = params
            .as_object_mut()
            .ok_or("Codex operation arguments must be an object")?;
        if object.keys().any(|key| !allowed.contains(&key.as_str())) {
            return Err("Invalid or oversized Codex operation arguments.".into());
        }
        object.insert("threadId".into(), json!(self.remote_id));
        Ok(params)
    }
    pub(super) fn goal_response(&mut self, value: &Value, step: &mut Step) -> Result<bool, String> {
        let Some(id) = value["id"].as_u64() else {
            return Ok(false);
        };
        let Some(pending) = self.goals.pending.remove(&id) else {
            return Ok(id >= 10_000 && id < self.goals.next_id);
        };
        let response = if let Some(error) = value.get("error") {
            Err(error["message"]
                .as_str()
                .map(short)
                .unwrap_or_else(|| "Codex operation failed".into()))
        } else if value.get("result").is_some() {
            Ok(value["result"].clone())
        } else {
            Err("Codex returned an invalid operation response".into())
        };
        match pending.purpose {
            Purpose::Rpc(reply) => {
                let response = response.and_then(|value| {
                    if preview_json(&value, 256 * 1024 + 1).len() > 256 * 1024 {
                        Err("Codex returned too much data for this control. Narrow the request and try again.".into())
                    } else { Ok(value) }
                });
                let _ = reply.send(response);
            }
            Purpose::Preflight => {
                let state =
                    response.and_then(|result| snapshot(&result["goal"], &self.remote_id))?;
                if state.as_ref().is_some_and(|goal| goal.status == "active") {
                    self.goal_request(
                        "thread/goal/set",
                        json!({"threadId":self.remote_id,"status":"paused"}),
                        Purpose::PauseBeforeResume,
                        step,
                    )?;
                } else {
                    self.goal_snapshot(state, step);
                    self.codex_load_thread(step);
                }
            }
            Purpose::PauseBeforeResume => {
                let state =
                    response.and_then(|result| snapshot(&result["goal"], &self.remote_id))?;
                if state.as_ref().is_none_or(|goal| goal.status != "paused") {
                    return Err(
                        "Codex did not confirm the paused goal; its thread was not loaded.".into(),
                    );
                }
                self.goal_snapshot(state, step);
                self.codex_load_thread(step);
            }
            Purpose::Settings(settings) => {
                response?;
                self.goals.collaboration_mode = settings.get("collaborationMode").cloned();
                let mut event = self.event("task_settings", "", None);
                event.data = Some(settings);
                step.events.push(event);
                self.codex_goal_or_prompt(step)?;
            }
            Purpose::Goal {
                request,
                reply,
                startup,
            } => {
                let result = response.and_then(|result| {
                    if matches!(request, GoalRequest::Clear) {
                        Ok(None)
                    } else {
                        let state = snapshot(&result["goal"], &self.remote_id)?;
                        if state.is_none() && !matches!(request, GoalRequest::Get) {
                            return Err("Codex did not return the updated goal.".into());
                        }
                        Ok(state)
                    }
                });
                if let Ok(state) = &result {
                    if !startup {
                        if let GoalRequest::Set { objective, .. } = &request {
                            step.events
                                .push(self.event("goal_input", objective.trim(), None));
                        }
                    }
                    self.goal_snapshot(state.clone(), step);
                    if self.goals.stopping && self.goals.active() {
                        self.goal_request(
                            "thread/goal/set",
                            json!({"threadId":self.remote_id,"status":"paused"}),
                            Purpose::Stop,
                            step,
                        )?;
                    }
                    if matches!(request, GoalRequest::Pause | GoalRequest::Clear) {
                        self.interrupt_goal_turn(step);
                    }
                    // Get is observational and must not stop an ordinary turn.
                    if !matches!(request, GoalRequest::Get)
                        && !self.goals.active()
                        && !self.goals.turn_running
                    {
                        step.done = true;
                    }
                    if startup && matches!(request, GoalRequest::Get) {
                        step.done = true;
                    }
                }
                if let Some(reply) = reply {
                    step.goal_acknowledgements.push(Acknowledgement {
                        reply,
                        result: result.clone(),
                    });
                }
                if startup {
                    let state = result?;
                    let mut event = self.event("goal_ready", "", None);
                    event.data = Some(json!(state));
                    step.events.push(event);
                }
            }
            Purpose::Boundary { failure } => {
                let state =
                    response.and_then(|result| snapshot(&result["goal"], &self.remote_id))?;
                self.goal_snapshot(state, step);
                step.failure = failure;
                step.done = !self.goals.active() && !self.goals.turn_running;
            }
            Purpose::Stop => {
                let state =
                    response.and_then(|result| snapshot(&result["goal"], &self.remote_id))?;
                self.goal_snapshot(state, step);
                self.interrupt_goal_turn(step);
                if !self.goals.turn_running {
                    step.done = true;
                }
            }
        }
        Ok(true)
    }
    fn interrupt_goal_turn(&mut self, step: &mut Step) {
        if self.goals.turn_running && !self.turn_id.is_empty() {
            step.write.push(self.cancel());
            self.goals.stop_deadline = Some(Instant::now() + Duration::from_secs(5));
        }
    }
    pub(super) fn stop_goal(&mut self) -> Option<Step> {
        let starting = self.goals.pending.values().any(|pending| {
            matches!(
                pending.purpose,
                Purpose::Goal {
                    request: GoalRequest::Set { .. } | GoalRequest::Resume,
                    ..
                }
            )
        });
        if self.config.provider != "codex"
            || self.remote_id.is_empty()
            || (!self.goals.active() && !starting)
        {
            return None;
        }
        self.goals.stopping = true;
        self.goals.idle_deadline = None;
        self.goals.stop_deadline = Some(Instant::now() + Duration::from_secs(5));
        let mut step = Step::default();
        // Let the in-flight setter materialize the goal before pausing it.
        // Otherwise a concurrent pause can fail with "no goal exists".
        if !self.goals.active() && starting {
            return Some(step);
        }
        if let Err(error) = self.goal_request(
            "thread/goal/set",
            json!({"threadId":self.remote_id,"status":"paused"}),
            Purpose::Stop,
            &mut step,
        ) {
            step.failure = Some(error);
        }
        Some(step)
    }
    pub(super) fn goal_notification(
        &mut self,
        method: &str,
        params: &Value,
        step: &mut Step,
    ) -> Result<bool, String> {
        match method {
            "thread/goal/updated" => {
                let state = snapshot(&params["goal"], &self.remote_id)?;
                self.goal_snapshot(state, step);
                // A terminal notification can precede the final text/completion.
                // Keep consuming until that turn has actually finished.
                if !self.goals.turn_running
                    && !self.goals.active()
                    && self.phase == 1
                    && self.goals.pending.is_empty()
                {
                    step.done = true;
                }
            }
            "thread/goal/cleared" => {
                self.goal_snapshot(None, step);
                if !self.goals.turn_running && self.phase == 1 && self.goals.pending.is_empty() {
                    step.done = true;
                }
            }
            _ => return Ok(false),
        }
        Ok(true)
    }
    pub(super) fn goal_turn_started(&mut self, turn_id: String, step: &mut Step) {
        let new_turn = self.turn_id != turn_id;
        self.turn_id = turn_id;
        self.goals.turn_running = true;
        self.goals.idle_deadline = None;
        if new_turn {
            self.text_streams = text_stream::TextStreams::default();
            self.tools.clear();
            self.tool_order.clear();
            self.partial_tools.clear();
        }
        let mut event = self.event("turn_start", "", None);
        event.data = Some(
            json!({"turnId":self.turn_id,"trigger":if self.goals.active() {"goal"} else {"user"}}),
        );
        step.events.push(event);
    }
    pub(super) fn goal_turn_completed(
        &mut self,
        params: &Value,
        step: &mut Step,
    ) -> Result<(), String> {
        let status = field(&params["turn"], "status");
        let failure = (status == "failed").then(|| string(&params["turn"]["error"], "message"));
        let mut event = self.event("turn_complete", "", None);
        event.data = Some(json!({"turnId":self.turn_id,"status":status}));
        step.events.push(event);
        self.goals.turn_running = false;
        self.turn_id.clear();
        self.goals.stop_deadline = None;
        if self.goals.state.is_some() {
            self.goal_request(
                "thread/goal/get",
                json!({"threadId":self.remote_id}),
                Purpose::Boundary { failure },
                step,
            )?;
        } else {
            if let Some(error) = failure {
                return Err(error);
            }
            step.done = true;
        }
        Ok(())
    }
    pub(super) fn goal_failure(&mut self, error: String, step: &mut Step) -> Result<(), String> {
        // Codex settles the goal to blocked/usageLimited on non-retryable
        // errors. Read that authoritative accounting before ending the stream.
        self.goals.turn_running = false;
        self.goal_request(
            "thread/goal/get",
            json!({"threadId":self.remote_id}),
            Purpose::Boundary {
                failure: Some(error),
            },
            step,
        )
    }
    pub(super) fn goal_tick(&mut self) -> Step {
        let now = Instant::now();
        let mut step = Step::default();
        let expired: Vec<_> = self
            .goals
            .pending
            .iter()
            .filter(|(_, pending)| pending.deadline <= now)
            .map(|(id, _)| *id)
            .collect();
        for id in expired {
            let pending = self.goals.pending.remove(&id).unwrap();
            let error = "Codex did not acknowledge the operation within 30 seconds.".to_owned();
            match pending.purpose {
                Purpose::Goal {
                    reply: Some(reply),
                    startup: false,
                    ..
                } => {
                    let _ = reply.send(Err(error));
                }
                Purpose::Rpc(reply) => {
                    let _ = reply.send(Err(error));
                }
                _ => {
                    step.failure = Some(error);
                }
            }
        }
        if self
            .goals
            .stop_deadline
            .is_some_and(|deadline| deadline <= now)
        {
            step.failure = Some("Codex did not finish pausing the goal. Its saved status will be refreshed when the task is reopened.".into());
        } else if self
            .goals
            .idle_deadline
            .is_some_and(|deadline| deadline <= now)
        {
            self.goals.idle_deadline = None;
            self.goals.stopping = true;
            self.goals.stop_deadline = Some(now + Duration::from_secs(5));
            step.events.push(self.event(
                "status",
                "Codex did not continue the goal; pausing it for attention",
                None,
            ));
            if let Err(error) = self.goal_request(
                "thread/goal/set",
                json!({"threadId":self.remote_id,"status":"paused"}),
                Purpose::Stop,
                &mut step,
            ) {
                step.failure = Some(error);
            }
        }
        step
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn state(status: &str) -> Value {
        json!({"threadId":"thread","objective":"Finish the application","status":status,"tokenBudget":50000,"tokensUsed":1234,"timeUsedSeconds":42,"createdAt":100,"updatedAt":142})
    }
    fn ready(request: GoalRequest) -> (Protocol, Step) {
        let mut config = super::super::tests::config("codex");
        config.goal = Some(request);
        config.prompt.clear();
        let mut p = Protocol::new(config);
        let step = p
            .receive(json!({"id":2,"result":{"thread":{"id":"thread"}}}))
            .unwrap();
        (p, step)
    }
    fn accept(p: &mut Protocol, request: &Value, status: &str) -> Step {
        let mut step = p
            .receive(json!({"id":request["id"],"result":{"goal":state(status)}}))
            .unwrap();
        for reply in step.goal_acknowledgements.drain(..) {
            reply.send();
        }
        step
    }
    fn active() -> Protocol {
        let (mut p, step) = ready(GoalRequest::Set {
            objective: "Finish the application".into(),
            token_budget: Some(50000),
        });
        accept(&mut p, &step.write[0], "active");
        p
    }
    fn started(p: &mut Protocol, id: &str) -> Step {
        p.receive(json!({"method":"turn/started","params":{"threadId":"thread","turn":{"id":id}}}))
            .unwrap()
    }
    fn completed(p: &mut Protocol, id: &str) -> Step {
        p.receive(json!({"method":"turn/completed","params":{"threadId":"thread","turn":{"id":id,"status":"completed"}}})).unwrap()
    }
    #[test]
    fn native_goal_set_and_resume_never_manufacture_turn_prompts() {
        for action in [
            GoalRequest::Set {
                objective: "Finish the application".into(),
                token_budget: None,
            },
            GoalRequest::Resume,
        ] {
            let (mut p, step) = ready(action);
            assert_eq!(step.write.len(), 1);
            assert_eq!(step.write[0]["method"], "thread/goal/set");
            assert_eq!(step.write[0]["params"]["status"], "active");
            let accepted = accept(&mut p, &step.write[0], "active");
            assert!(!accepted.done);
            assert!(accepted.write.is_empty());
            assert!(p.goals.active());
            assert!(accepted.events.iter().any(|event| event.kind == "goal"));
        }
        let (_, step) = ready(GoalRequest::Set {
            objective: "No ceiling".into(),
            token_budget: None,
        });
        assert!(step.write[0]["params"]
            .get("tokenBudget")
            .is_some_and(Value::is_null));
    }
    #[test]
    fn automatic_turns_keep_streaming_and_final_goal_waits_for_final_text() {
        let mut p = active();
        started(&mut p, "one");
        let first = p.receive(json!({"method":"item/agentMessage/delta","params":{"threadId":"thread","turnId":"one","itemId":"same","delta":"First turn."}})).unwrap();
        assert_eq!(first.events.last().unwrap().text, "First turn.");
        let end = completed(&mut p, "one");
        assert!(!end.done);
        assert_eq!(end.write[0]["method"], "thread/goal/get");
        let next = started(&mut p, "two");
        assert_eq!(next.events[0].kind, "turn_start");
        assert!(!accept(&mut p, &end.write[0], "active").done);
        let goal = p.receive(json!({"method":"thread/goal/updated","params":{"threadId":"thread","turnId":"two","goal":state("complete")}})).unwrap();
        assert!(!goal.done);
        let final_text = p.receive(json!({"method":"item/agentMessage/delta","params":{"threadId":"thread","turnId":"two","itemId":"same","delta":"Finished."}})).unwrap();
        assert_eq!(final_text.events[0].kind, "message_start");
        assert_eq!(final_text.events[1].text, "Finished.");
        let end = completed(&mut p, "two");
        let final_state = accept(&mut p, &end.write[0], "complete");
        assert!(final_state.done);
        assert!(final_state.write.is_empty());
    }
    #[test]
    fn inactive_goals_never_launch_another_turn() {
        for status in [
            "paused",
            "blocked",
            "budgetLimited",
            "usageLimited",
            "complete",
        ] {
            let mut p = active();
            started(&mut p, "turn");
            let end = completed(&mut p, "turn");
            let state = accept(&mut p, &end.write[0], status);
            assert!(state.done, "{status}");
            assert!(state.write.is_empty());
        }
    }
    #[test]
    fn pause_is_acknowledged_before_interrupt_and_does_not_drop_the_final_snapshot() {
        let mut p = active();
        started(&mut p, "turn");
        let (tx, mut rx) = oneshot::channel();
        let pause = p.goal_control(GoalRequest::Pause, tx);
        assert_eq!(pause.write[0]["params"]["status"], "paused");
        assert!(rx.try_recv().is_err());
        let paused = accept(&mut p, &pause.write[0], "paused");
        assert_eq!(rx.try_recv().unwrap().unwrap().unwrap().status, "paused");
        assert_eq!(paused.write[0]["method"], "turn/interrupt");
        assert!(!paused.done);
        let end = completed(&mut p, "turn");
        assert!(accept(&mut p, &end.write[0], "paused").done);
    }
    #[test]
    fn stop_during_goal_creation_waits_for_the_goal_before_pausing() {
        let (mut p, initial) = ready(GoalRequest::Resume);
        let stop = p.stop_goal().unwrap();
        assert!(stop.write.is_empty());
        let ack = accept(&mut p, &initial.write[0], "active");
        assert_eq!(ack.write[0]["method"], "thread/goal/set");
        assert_eq!(ack.write[0]["params"]["status"], "paused");
        assert!(accept(&mut p, &ack.write[0], "paused").done);
    }
    #[test]
    fn status_notifications_from_subagents_cannot_settle_the_root_goal() {
        let mut p = active();
        started(&mut p, "turn");
        let ignored = p.receive(json!({"method":"thread/goal/updated","params":{"threadId":"other","turnId":"turn","goal":state("complete")}})).unwrap();
        assert!(ignored.events.is_empty());
        assert!(p.goals.active());
    }
    #[test]
    fn goal_errors_preserve_authoritative_usage_and_status_before_failing() {
        let mut p = active();
        started(&mut p, "turn");
        let error = p.receive(json!({"method":"error","params":{"threadId":"thread","turnId":"turn","willRetry":false,"error":{"message":"Usage exhausted"}}})).unwrap();
        let final_state = accept(&mut p, &error.write[0], "usageLimited");
        assert_eq!(final_state.failure.as_deref(), Some("Usage exhausted"));
        assert_eq!(
            final_state.events[0].data.as_ref().unwrap()["tokensUsed"],
            1234
        );
        assert_eq!(p.goals.state.as_ref().unwrap().status, "usageLimited");
    }
    #[test]
    fn stale_rpc_replies_do_not_end_the_running_goal() {
        let mut p = active();
        let (tx, mut rx) = oneshot::channel();
        let request = p.goal_control(GoalRequest::Get, tx);
        let id = request.write[0]["id"].as_u64().unwrap();
        p.goals.pending.get_mut(&id).unwrap().deadline = Instant::now() - Duration::from_secs(1);
        assert!(p.goal_tick().failure.is_none());
        assert!(rx.try_recv().unwrap().is_err());
        assert!(p
            .receive(json!({"id":id,"error":{"message":"late"}}))
            .is_ok());
        assert!(p.goals.active());
    }
    #[test]
    fn live_operations_are_scoped_bounded_and_explicitly_allowlisted() {
        let mut p = active();
        let (tx, mut rx) = oneshot::channel();
        let request = p.codex_control(
            "thread/backgroundTerminals/list".into(),
            json!({"limit":20}),
            tx,
        );
        assert_eq!(request.write[0]["params"]["threadId"], "thread");
        p.receive(json!({"id":request.write[0]["id"],"result":{"data":[]}}))
            .unwrap();
        assert_eq!(rx.try_recv().unwrap().unwrap()["data"], json!([]));
        for (method, params) in [
            (
                "thread/backgroundTerminals/list",
                json!({"threadId":"other"}),
            ),
            ("thread/shellCommand", json!({"command":"echo x"})),
            ("thread/approveGuardianDeniedAction", json!({"event":{}})),
        ] {
            let (tx, mut rx) = oneshot::channel();
            assert!(p.codex_control(method.into(), params, tx).write.is_empty());
            assert!(rx.try_recv().unwrap().is_err());
        }
    }
    #[test]
    fn stalled_automatic_continuation_pauses_instead_of_inventing_a_prompt() {
        let mut p = active();
        p.goals.idle_deadline = Some(Instant::now() - Duration::from_secs(1));
        let step = p.goal_tick();
        assert_eq!(step.write[0]["method"], "thread/goal/set");
        assert_eq!(step.write[0]["params"]["status"], "paused");
        assert!(step
            .write
            .iter()
            .all(|request| request["method"] != "turn/start"));
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn process_consumes_two_harness_scheduled_turns_before_releasing_its_slot() {
        let _guard = concurrent_process_tests::process_test_lock().lock().await;
        let script = r#"
read -r line
printf '%s\n' '{"id":1,"result":{}}'
read -r line
read -r line
printf '%s\n' '{"id":2,"result":{"thread":{"id":"thread"}}}'
read -r line
printf '%s\n' '{"id":10000,"result":{"goal":{"threadId":"thread","objective":"Finish","status":"active","tokenBudget":10000,"tokensUsed":0,"timeUsedSeconds":0,"createdAt":1,"updatedAt":1}}}'
printf '%s\n' '{"method":"turn/started","params":{"threadId":"thread","turn":{"id":"first"}}}' '{"method":"item/agentMessage/delta","params":{"threadId":"thread","turnId":"first","itemId":"one","delta":"First turn."}}' '{"method":"turn/completed","params":{"threadId":"thread","turn":{"id":"first","status":"completed"}}}'
read -r line
printf '%s\n' '{"method":"turn/started","params":{"threadId":"thread","turn":{"id":"second"}}}' '{"id":10001,"result":{"goal":{"threadId":"thread","objective":"Finish","status":"active","tokenBudget":10000,"tokensUsed":25,"timeUsedSeconds":1,"createdAt":1,"updatedAt":2}}}' '{"method":"item/agentMessage/delta","params":{"threadId":"thread","turnId":"second","itemId":"two","delta":"Second turn."}}' '{"method":"thread/goal/updated","params":{"threadId":"thread","turnId":"second","goal":{"threadId":"thread","objective":"Finish","status":"complete","tokenBudget":10000,"tokensUsed":50,"timeUsedSeconds":2,"createdAt":1,"updatedAt":3}}}' '{"method":"turn/completed","params":{"threadId":"thread","turn":{"id":"second","status":"completed"}}}'
read -r line
printf '%s\n' '{"id":10002,"result":{"goal":{"threadId":"thread","objective":"Finish","status":"complete","tokenBudget":10000,"tokensUsed":50,"timeUsedSeconds":2,"createdAt":1,"updatedAt":3}}}'
"#;
        let mut config = super::super::tests::config("codex");
        config.goal = Some(GoalRequest::Set {
            objective: "Finish".into(),
            token_budget: Some(10000),
        });
        config.prompt.clear();
        let (_tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured = events.clone();
        let sink: Sink = Arc::new(move |event| captured.lock().unwrap().push(event));
        let mut command = Command::new("/bin/sh");
        command.args(["-c", script]);
        tokio::time::timeout(
            Duration::from_secs(5),
            run_process(config, sink, rx, command, Vec::new()),
        )
        .await
        .unwrap()
        .unwrap();
        let events = events.lock().unwrap();
        assert_eq!(
            events
                .iter()
                .filter(|event| event.kind == "text")
                .map(|event| event.text.as_str())
                .collect::<Vec<_>>(),
            ["First turn.", "Second turn."]
        );
        assert_eq!(
            events
                .iter()
                .filter(|event| event.kind == "turn_complete")
                .count(),
            2
        );
        assert_eq!(
            events
                .iter()
                .rfind(|event| event.kind == "goal")
                .unwrap()
                .data
                .as_ref()
                .unwrap()["status"],
            "complete"
        );
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn stopping_a_goal_persists_pause_before_the_provider_process_exits() {
        let _guard = concurrent_process_tests::process_test_lock().lock().await;
        let script = r#"
read -r line
printf '%s\n' '{"id":1,"result":{}}'
read -r line
read -r line
printf '%s\n' '{"id":2,"result":{"thread":{"id":"thread"}}}'
read -r line
printf '%s\n' '{"id":10000,"result":{"goal":{"threadId":"thread","objective":"Finish","status":"active","tokenBudget":10000,"tokensUsed":0,"timeUsedSeconds":0,"createdAt":1,"updatedAt":1}}}' '{"method":"turn/started","params":{"threadId":"thread","turn":{"id":"first"}}}' '{"method":"item/agentMessage/delta","params":{"threadId":"thread","turnId":"first","itemId":"one","delta":"Working."}}'
read -r line
case "$line" in *'"status":"paused"'*) ;; *) exit 71;; esac
printf '%s\n' '{"id":10001,"result":{"goal":{"threadId":"thread","objective":"Finish","status":"paused","tokenBudget":10000,"tokensUsed":12,"timeUsedSeconds":1,"createdAt":1,"updatedAt":2}}}'
read -r line
case "$line" in *'turn/interrupt'*) ;; *) exit 72;; esac
printf '%s\n' '{"method":"turn/completed","params":{"threadId":"thread","turn":{"id":"first","status":"interrupted"}}}'
read -r line
printf '%s\n' '{"id":10002,"result":{"goal":{"threadId":"thread","objective":"Finish","status":"paused","tokenBudget":10000,"tokensUsed":12,"timeUsedSeconds":1,"createdAt":1,"updatedAt":2}}}'
"#;
        let mut config = super::super::tests::config("codex");
        config.goal = Some(GoalRequest::Resume);
        config.prompt.clear();
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured = events.clone();
        let sink: Sink = Arc::new(move |event| {
            if event.kind == "text" {
                let _ = tx.send(RunInput::Stop);
            }
            captured.lock().unwrap().push(event);
        });
        let mut command = Command::new("/bin/sh");
        command.args(["-c", script]);
        tokio::time::timeout(
            Duration::from_secs(5),
            run_process(config, sink, rx, command, Vec::new()),
        )
        .await
        .unwrap()
        .unwrap();
        let events = events.lock().unwrap();
        assert_eq!(
            events
                .iter()
                .rfind(|event| event.kind == "goal")
                .unwrap()
                .data
                .as_ref()
                .unwrap()["status"],
            "paused"
        );
        assert_eq!(
            events
                .iter()
                .filter(|event| event.kind == "turn_complete")
                .count(),
            1
        );
    }
    #[test]
    fn saved_goal_controls_do_not_load_the_thread_or_start_any_turn() {
        for request in [GoalRequest::Get, GoalRequest::Pause, GoalRequest::Clear] {
            let mut config = super::super::tests::config("codex");
            config.resume_id = Some("thread".into());
            config.goal = Some(request);
            config.prompt.clear();
            let mut p = Protocol::new(config);
            let step = p.receive(json!({"id":1,"result":{}})).unwrap();
            assert_eq!(step.write.len(), 2);
            assert!(step.write[1]["method"]
                .as_str()
                .unwrap()
                .starts_with("thread/goal/"));
            assert!(step
                .write
                .iter()
                .all(|request| request["method"] != "thread/resume"
                    && request["method"] != "turn/start"));
        }
    }
    #[test]
    fn resume_pauses_existing_goal_before_loading_and_applies_requested_goal_afterward() {
        for action in [None, Some(GoalRequest::Resume)] {
            let mut config = super::super::tests::config("codex");
            config.resume_id = Some("thread".into());
            config.goal = action;
            let mut p = Protocol::new(config);
            let handshake = p.receive(json!({"id":1,"result":{}})).unwrap();
            assert_eq!(handshake.write[1]["method"], "thread/goal/get");
            let pause = accept(&mut p, &handshake.write[1], "active");
            assert_eq!(pause.write[0]["method"], "thread/goal/set");
            assert_eq!(pause.write[0]["params"]["status"], "paused");
            assert!(pause.events.iter().all(|event| event.kind != "goal_ready"));
            let load = accept(&mut p, &pause.write[0], "paused");
            assert_eq!(load.write[0]["method"], "thread/resume");
            assert_eq!(load.write[0]["params"]["excludeTurns"], true);
            assert!(load.events.iter().all(|event| event.kind != "goal_ready"));
            let intended_goal = p.config.goal.is_some();
            let ready = p
                .receive(json!({"id":2,"result":{"thread":{"id":"thread"}}}))
                .unwrap();
            assert_eq!(
                ready.write[0]["method"],
                if intended_goal {
                    "thread/goal/set"
                } else {
                    "turn/start"
                }
            );
            if intended_goal {
                assert_eq!(ready.write[0]["params"]["status"], "active");
                let accepted = accept(&mut p, &ready.write[0], "active");
                assert!(accepted
                    .events
                    .iter()
                    .any(|event| event.kind == "goal_ready"));
            }
        }
    }
    #[test]
    fn failed_preflight_pause_never_loads_the_active_goal() {
        let mut config = super::super::tests::config("codex");
        config.resume_id = Some("thread".into());
        let mut p = Protocol::new(config);
        let handshake = p.receive(json!({"id":1,"result":{}})).unwrap();
        let pause = accept(&mut p, &handshake.write[1], "active");
        assert!(p
            .receive(json!({"id":pause.write[0]["id"],"error":{"message":"Cannot save goal"}}))
            .is_err());
        assert_eq!(p.phase, 0);
        assert!(!p.goals.turn_running);
    }
    #[test]
    fn saved_plan_preset_cannot_override_a_new_model_or_effort_selection() {
        let mut config = super::super::tests::config("codex");
        config.model = "new-model".into();
        config.reasoning_effort = Some("high".into());
        config.codex_settings = Some(
            json!({"collaborationMode":{"mode":"plan","settings":{"model":"old-model","reasoning_effort":"low","developer_instructions":"stale"}}}),
        );
        let mut p = Protocol::new(config);
        let ready = p.receive(json!({"id":2,"result":{"thread":{"id":"thread"},"model":"new-model","reasoningEffort":"medium"}})).unwrap();
        assert_eq!(ready.write[0]["method"], "model/list");
        let settings = p.receive(json!({"id":6,"result":{"data":[{"model":"new-model","supportedReasoningEfforts":[{"reasoningEffort":"high"}]}]}})).unwrap();
        let expected = json!({"mode":"plan","settings":{"model":"new-model","reasoning_effort":"high","developer_instructions":null}});
        assert_eq!(settings.write[0]["params"]["collaborationMode"], expected);
        let turn = p
            .receive(json!({"id":settings.write[0]["id"],"result":{}}))
            .unwrap();
        assert_eq!(turn.events[0].kind, "task_settings");
        assert_eq!(
            turn.events[0].data.as_ref().unwrap()["collaborationMode"],
            expected
        );
        assert_eq!(turn.write[0]["method"], "turn/start");
        assert_eq!(turn.write[0]["params"]["collaborationMode"], expected);
        assert_eq!(turn.write[0]["params"]["effort"], "high");
        assert_eq!(
            turn.write[0]["params"]["sandboxPolicy"]["type"],
            "workspaceWrite"
        );
    }
    #[test]
    fn harness_model_and_effort_defaults_are_resolved_before_applying_plan() {
        let mut config = super::super::tests::config("codex");
        config.codex_settings = Some(
            json!({"collaborationMode":{"mode":"plan","settings":{"model":"old","reasoning_effort":"low"}}}),
        );
        let mut p = Protocol::new(config);
        let settings = p.receive(json!({"id":2,"result":{"thread":{"id":"thread"},"model":"resolved-model","reasoningEffort":"xhigh"}})).unwrap();
        assert_eq!(settings.write[0]["method"], "thread/settings/update");
        assert_eq!(
            settings.write[0]["params"]["collaborationMode"]["settings"]["model"],
            "resolved-model"
        );
        assert_eq!(
            settings.write[0]["params"]["collaborationMode"]["settings"]["reasoning_effort"],
            "xhigh"
        );
    }
    #[test]
    fn persisted_fast_tier_is_cleared_before_resume_then_checked_against_the_new_model() {
        let mut config = super::super::tests::config("codex");
        config.model = "new-model".into();
        config.resume_id = Some("thread".into());
        config.codex_settings = Some(json!({"serviceTier":"priority"}));
        let mut p = Protocol::new(config);
        let init = p.receive(json!({"id":1,"result":{}})).unwrap();
        let load = p
            .receive(json!({"id":init.write[1]["id"],"result":{"goal":null}}))
            .unwrap();
        assert_eq!(load.write[0]["method"], "thread/resume");
        assert!(load.write[0]["params"]["serviceTier"].is_null());
        let ready = p
            .receive(json!({"id":2,"result":{"thread":{"id":"thread"},"model":"new-model"}}))
            .unwrap();
        assert_eq!(ready.write[0]["method"], "model/list");
        let settings = p.receive(json!({"id":6,"result":{"data":[{"model":"new-model","serviceTiers":[]}],"nextCursor":null}})).unwrap();
        assert!(settings.write[0]["params"]["serviceTier"].is_null());
        assert!(settings
            .events
            .iter()
            .any(|event| event.text.contains("standard speed")));
        let applied = p
            .receive(json!({"id":settings.write[0]["id"],"result":{}}))
            .unwrap();
        assert!(applied.events[0].data.as_ref().unwrap()["serviceTier"].is_null());
    }
    #[test]
    fn a_team_workers_required_tier_is_refused_rather_than_dropped() {
        // A plain user task keeps today's behavior: an unavailable tier becomes the standard speed.
        let mut config = super::super::tests::config("codex");
        config.model = "gpt-6-luna".into();
        config.codex_settings = Some(json!({"serviceTier":"ultrafast"}));
        let mut plain = Protocol::new(config.clone());
        plain.receive(json!({"id":2,"result":{"thread":{"id":"thread"},"model":"gpt-6-luna"}})).unwrap();
        let catalog = json!({"id":6,"result":{"data":[{"model":"gpt-6-luna","serviceTiers":[{"id":"priority","name":"Fast"}]}],"nextCursor":null}});
        let settings = plain.receive(catalog.clone()).unwrap();
        assert!(settings.write[0]["params"]["serviceTier"].is_null());
        // A team worker with a required tier refuses, with the reason.
        config.required_tier = Some("ultrafast".into());
        let mut worker = Protocol::new(config.clone());
        worker.receive(json!({"id":2,"result":{"thread":{"id":"thread"},"model":"gpt-6-luna"}})).unwrap();
        assert_eq!(worker.receive(catalog.clone()).err().as_deref(), Some("Ultrafast is not available for gpt-6-luna in the installed Codex catalog."));
        // A null or absent saved tier is never accepted for it, even without a catalog request.
        for saved in [Some(json!({"serviceTier":null})), None] {
            config.codex_settings = saved;
            let mut worker = Protocol::new(config.clone());
            let ready = worker.receive(json!({"id":2,"result":{"thread":{"id":"thread"},"model":"gpt-6-luna"}})).unwrap();
            assert_eq!(ready.write[0]["method"], "model/list", "the required tier always checks the catalog");
            let error = worker.receive(catalog.clone()).err().unwrap();
            assert!(error.contains("must run at its Ultrafast speed tier") && error.contains("gpt-6-luna"), "{error}");
        }
        // A supported tier goes through.
        config.codex_settings = Some(json!({"serviceTier":"priority"}));
        config.required_tier = Some("fast".into());
        let mut worker = Protocol::new(config);
        worker.receive(json!({"id":2,"result":{"thread":{"id":"thread"},"model":"gpt-6-luna"}})).unwrap();
        assert_eq!(worker.receive(catalog).unwrap().write[0]["params"]["serviceTier"], "priority");
    }
    #[test]
    fn speed_validation_follows_model_pages_and_does_not_guess_when_metadata_is_missing() {
        let mut config = super::super::tests::config("codex");
        config.model = "selected".into();
        config.codex_settings = Some(json!({"serviceTier":"priority"}));
        let mut p = Protocol::new(config.clone());
        p.receive(json!({"id":2,"result":{"thread":{"id":"thread"},"model":"selected"}}))
            .unwrap();
        let next = p.receive(json!({"id":6,"result":{"data":[{"model":"other","serviceTiers":[]}],"nextCursor":"page-two"}})).unwrap();
        assert_eq!(next.write[0]["method"], "model/list");
        assert_eq!(next.write[0]["params"]["cursor"], "page-two");
        let supported = p.receive(json!({"id":6,"result":{"data":[{"model":"selected","serviceTiers":[{"id":"priority","name":"Fast"}]}],"nextCursor":null}})).unwrap();
        assert_eq!(supported.write[0]["params"]["serviceTier"], "priority");
        let mut missing = Protocol::new(config);
        missing
            .receive(json!({"id":2,"result":{"thread":{"id":"thread"},"model":"selected"}}))
            .unwrap();
        let error = missing.receive(json!({"id":6,"result":{"data":[{"model":"other","serviceTiers":[]}],"nextCursor":null}}));
        assert!(matches!(error, Err(message) if message.contains("speed options")));
    }
}
