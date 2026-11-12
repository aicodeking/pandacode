//! Steering: a message for an agent while its run is open. Steering never stops
//! the run. Claude Code takes it on stream input (mid-turn at the next tool
//! boundary, or as a following turn of the same process); Codex through
//! `turn/steer` on the active turn; Pi through its `steer` command; Muse through
//! MSP `turn/steer` (`muse.rs`); ACP harnesses in `acp.rs`. When no turn can take it (startup, between turns, refused), the
//! run holds it and sends it as the next turn of the same session the moment the
//! current turn ends. Each steer reports `steer` events: `pending` with its mode
//! on acceptance, `delivered` once the harness takes it, and `failed` if the run
//! ends first, so the app can queue it again.

use super::goals::RpcReply;
use super::*;

const MAX_STEERS: usize = 16;
/// How long an idle Claude process may take to start a settled agent's hand-back (recorded: 0.1 s).
const CLAUDE_TURN_GRACE: Duration = Duration::from_secs(10);
/// The same over the cloud bridge, whose polling backs off up to 30 s in a network blip
/// (`cloud_agents/bridge.rs`), so a late frame there says nothing about the agent.
const CLOUD_TURN_GRACE: Duration = Duration::from_secs(120);
/// How long Claude may take to start a turn for input it was given (the prompt or a steer).
/// Hooks run before that turn's first frame (recorded: 15 s for a `sleep 15` UserPromptSubmit
/// hook, 12 s for /cost), so this outlasts Claude's 10-minute default hook timeout. Stop still
/// works throughout.
const CLAUDE_INPUT_GRACE: Duration = Duration::from_secs(15 * 60);
/// How long background commands subagents started may hold a run nothing else keeps open, from
/// the first moment they do. The child is woken when its command ends, but a dev server never
/// does. Well under the team watchdog's 20 silent minutes, so a worker ends instead of being
/// stopped as hung.
const CHILD_SHELL_HOLD: Duration = Duration::from_secs(5 * 60);
/// How long Claude may take to start the one turn that tells it the hold ran out.
const SHELL_NOTICE_GRACE: Duration = Duration::from_secs(120);
/// Codex `turn/steer` request ids, clear of startup ids, cancel (900), ACP steers and goals (10000 up).
const CODEX_STEER_IDS: u64 = 1 << 40;

#[derive(Default)]
pub(super) struct Steers {
    /// Sent into a running turn, waiting for the harness to echo it: (id, text, mode).
    live: Vec<(String, String, &'static str)>,
    /// Waiting for the next turn of this run: (id, text).
    held: Vec<(String, String)>,
    /// Unanswered Codex `turn/steer` requests: (steer id, text, reply).
    requests: HashMap<u64, (String, String, RpcReply)>,
    next_request: u64,
    /// The turn ended while a steer request was unanswered; the answer decides what follows.
    turn_over: bool,
    /// Claude background agents still running, per its `background_tasks_changed`.
    pub(super) agents: Vec<BackgroundAgent>,
    /// Background agents that ended and whose result Claude has not taken, oldest first.
    pub(super) settled: Vec<BackgroundAgent>,
    /// Foreground agents still open: (task, tool use). They never appear in the list, yet an
    /// inner agent reports to them just the same.
    foreground: Vec<(String, String)>,
    /// Every agent's description by task, to name a command's subagent after that agent is gone.
    names: HashMap<String, String>,
    /// Background commands a subagent owns. Its report comes after they end, so they hold the
    /// run, but an ending one owes nothing itself and never lands in `settled`.
    child_shells: Vec<BackgroundAgent>,
    /// The last child command ended: its agent is relisted about 10 ms later, if it is woken.
    child_shell_ended: bool,
    /// When child commands first held this run. Survives later turns, so a steer's `result` does
    /// not restart the clock; only every command ending clears it.
    pub(super) shell_hold_since: Option<tokio::time::Instant>,
    /// The hold ran out and the main agent was given this text, once: commands hold nothing more.
    shell_notice: Option<String>,
    /// UserPromptSubmit hooks running for a turn that has not started.
    prompt_hooks: usize,
    /// A non-notification `result` already answered the opening prompt.
    prompt_answered: bool,
    /// Claude's last turn ended with `result` and no later turn has started.
    idle: bool,
    /// The running turn followed `result` with no steer waiting, so it should be a hand-back.
    hand_back_turn: bool,
    /// The last `result` was a leftover notification's, before Claude took this run's prompt.
    prompt_owed: bool,
    /// The last `result` was an empty notification's: Claude merged it with another notification
    /// and the turn that answers them both follows (recorded about 2 s later), if it is coming.
    batch_owed: bool,
    /// Idle and owed a turn that may never come: the wait began at this time (see `claude_grace`).
    waiting_since: Option<tokio::time::Instant>,
    /// The run reaches its harness over the cloud bridge.
    cloud: bool,
}

#[derive(Clone)]
pub(super) struct BackgroundAgent {
    task: String,
    run: String,
    name: String,
    parent: String,
}

impl Steers {
    /// An inner agent reports to its parent subagent while that is open; only one that outlives
    /// its parent owes the main agent a turn (recorded: origin.runId names it).
    fn reports_to_parent(&self, agent: &BackgroundAgent) -> bool {
        !agent.parent.is_empty()
            && (self.agents.iter().any(|open| open.task == agent.parent) || self.foreground.iter().any(|(task, _)| *task == agent.parent))
    }

    fn remember_name(&mut self, agent: &BackgroundAgent) {
        if !agent.name.is_empty() {
            self.names.insert(agent.task.clone(), agent.name.clone());
        }
    }
}

/// Background task types that report back to the parent and finish on their own. The rest of
/// Claude's types must not hold a run: shells and monitors may run forever, and teammates idle
/// until told to stop. An unknown type does not hold either.
pub(super) fn holds_run(task_type: &str) -> bool {
    matches!(task_type, "local_agent" | "remote_agent" | "local_workflow")
}

/// A background task its subagent owns, not an agent itself: a list row or a `task_started`.
fn child_shell(task: &Value) -> bool {
    !holds_run(field(task, "task_type")) && !field(task, "parent_task_id").is_empty()
}

impl BackgroundAgent {
    fn of(task: &Value) -> Self {
        Self { task: string(task, "task_id"), run: string(task, "run_id"), name: limited(field(task, "description"), 120), parent: string(task, "parent_task_id") }
    }
}

/// The commands' descriptions for a sentence, if the CLI gave any.
fn shell_names(shells: &[BackgroundAgent]) -> Option<String> {
    let names: Vec<String> = shells.iter().filter(|shell| !shell.name.is_empty()).map(|shell| format!("\"{}\"", shell.name)).collect();
    (!names.is_empty()).then(|| names.join(", "))
}

/// Text blocks of a user message given as a string or a content array.
fn texts(content: &Value) -> Vec<&str> {
    match content {
        Value::String(text) => vec![text.as_str()],
        Value::Array(blocks) => blocks.iter().filter(|block| block["type"] == "text").filter_map(|block| block["text"].as_str()).collect(),
        _ => Vec::new(),
    }
}

fn lost_report_note(lost: &[String]) -> String {
    format!("The report from {} did not reach the agent: its process ended before handing it back.", lost.join(", "))
}

impl Protocol {
    fn claude_family(&self) -> bool {
        matches!(self.config.provider.as_str(), "claude" | "glm" | "mimo")
    }

    pub(super) fn steer(&mut self, id: String, text: String, reply: RpcReply) -> Step {
        if matches!(self.config.provider.as_str(), "kimi" | "opencode" | "antigravity" | "grok" | "deepseek" | "commandcode" | "cline" | "kilo" | "github-copilot" | "devin" | "hermes" | "cursor") {
            return self.acp_steer(id, text, reply);
        }
        let mut step = Step::default();
        let text = text.trim().to_owned();
        if text.is_empty() || text.len() > crate::MESSAGE_LIMIT {
            let _ = reply.send(Err("Write a steering message under 16 MiB.".into()));
            return step;
        }
        let waiting = self.steers.live.len() + self.steers.held.len() + self.steers.requests.len() + self.pi.steers.len() + self.muse_steer_count();
        if waiting >= MAX_STEERS {
            let _ = reply.send(Err("Too many steering messages are waiting; the message stays queued.".into()));
            return step;
        }
        match self.config.provider.as_str() {
            // Before the opening prompt is written the steer would overtake it; it follows the prompt instead.
            _ if self.claude_family() && self.phase == 0 => self.accept(id, text, "next-turn", reply, &mut step),
            _ if self.claude_family() => {
                step.write.push(self.claude_input(&text));
                self.accept(id, text, "live", reply, &mut step);
                if self.steers.waiting_since.is_some() {
                    self.steers.waiting_since = Some(tokio::time::Instant::now());
                }
            }
            "codex" if !self.remote_id.is_empty() && !self.turn_id.is_empty() => {
                let request = CODEX_STEER_IDS + self.steers.next_request;
                self.steers.next_request += 1;
                step.write.push(json!({"id":request,"method":"turn/steer","params":{"threadId":self.remote_id,"expectedTurnId":self.turn_id,"input":[{"type":"text","text":text,"text_elements":[]}]}}));
                self.steers.requests.insert(request, (id, text, reply));
            }
            "codex" => self.accept(id, text, "next-turn", reply, &mut step),
            "pi" | "omp" => return self.pi_steer(id, text, reply),
            "muse" => return self.muse_steer(id, text, reply),
            // A busy ZCode session queues a `session/send` server-side, but the
            // queue's delivery is not observable enough to report live; hold it.
            "zcode" => self.accept(id, text, "next-turn", reply, &mut step),
            _ => {
                let _ = reply.send(Err("This agent cannot be steered; the message stays queued.".into()));
            }
        }
        step
    }

    /// Reports an accepted steer and keeps it until the harness takes it.
    pub(super) fn accept(&mut self, id: String, text: String, mode: &'static str, reply: RpcReply, step: &mut Step) {
        step.events.push(self.steer_event(&id, &text, "pending", mode));
        let _ = reply.send(Ok(json!({"steered":true,"id":id,"mode":mode})));
        if mode == "live" {
            self.steers.live.push((id, text, mode));
        } else {
            self.steers.held.push((id, text));
        }
    }

    fn claude_input(&self, text: &str) -> Value {
        let mut request = json!({"type":"user","message":{"role":"user","content":[{"type":"text","text":text}]},"parent_tool_use_id":null});
        if !self.remote_id.is_empty() {
            request["session_id"] = json!(self.remote_id);
        }
        request
    }

    /// Writes steers that arrived before Claude's opening prompt right after it.
    pub(super) fn claude_send_held(&mut self, step: &mut Step) {
        for (id, text) in std::mem::take(&mut self.steers.held) {
            step.write.push(self.claude_input(&text));
            self.steers.live.push((id, text, "next-turn"));
        }
    }

    /// A frame of the parent's own turn. Claude runs one turn per hand-back, so a new turn does
    /// not settle what is owed; its `result` says which one it took.
    pub(super) fn claude_turn_activity(&mut self, value: &Value) {
        let turn = match field(value, "type") {
            "assistant" | "stream_event" | "user" => true,
            "system" => field(value, "subtype") == "init",
            _ => false,
        };
        if turn && self.steers.idle {
            self.steers.idle = false;
            self.steers.waiting_since = None;
            self.steers.child_shell_ended = false;
            self.steers.prompt_hooks = 0;
            self.steers.hand_back_turn = self.steers.live.is_empty() && !self.steers.prompt_owed && self.steers.shell_notice.is_none();
        }
    }

    /// Hooks run before a turn's first frame, so a UserPromptSubmit hook means the owed turn has
    /// begun, however long the hook takes. If the hooks end and no turn follows (one blocked
    /// it), the ordinary wait applies again from there.
    pub(super) fn claude_hook(&mut self, value: &Value) {
        if field(value, "hook_event") != "UserPromptSubmit" || !self.steers.idle {
            return;
        }
        let steers = &mut self.steers;
        if field(value, "subtype") == "hook_started" {
            steers.prompt_hooks += 1;
        } else {
            steers.prompt_hooks = steers.prompt_hooks.saturating_sub(1);
        }
        if steers.waiting_since.is_some() {
            steers.waiting_since = Some(tokio::time::Instant::now());
        }
    }

    /// `background_tasks_changed` lists every background task; only agents hand back,
    /// and a dev server or monitor of the parent's must never hold the run.
    pub(super) fn claude_background_tasks(&mut self, value: &Value) {
        let running: Vec<BackgroundAgent> = value["tasks"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|task| holds_run(field(task, "task_type")))
            .map(BackgroundAgent::of)
            .collect();
        let shells: Vec<BackgroundAgent> = value["tasks"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|task| child_shell(task))
            .map(BackgroundAgent::of)
            .collect();
        let shell_ended = !self.steers.child_shells.is_empty() && shells.is_empty();
        self.steers.child_shells = shells;
        if shell_ended {
            self.claude_child_shell_ended();
        }
        running.iter().for_each(|agent| self.steers.remember_name(agent));
        let previous = std::mem::replace(&mut self.steers.agents, running);
        // The list is the authority: a task it lists again has not settled after all.
        let steers = &mut self.steers;
        steers.settled.retain(|agent| !steers.agents.iter().any(|still| still.task == agent.task));
        for agent in previous {
            let gone = !steers.agents.iter().any(|still| still.task == agent.task) && !steers.settled.iter().any(|done| done.task == agent.task);
            if gone && !steers.reports_to_parent(&agent) {
                steers.settled.push(agent);
            }
        }
        self.claude_recheck_idle();
    }

    /// A CLI that never sends `background_tasks_changed` still announces each agent here, and
    /// this is the only sign of a foreground agent, which may be a parent.
    pub(super) fn claude_task_started(&mut self, value: &Value) {
        let task = field(value, "task_id");
        if task.is_empty() {
            return;
        }
        if holds_run(field(value, "task_type")) {
            self.steers.remember_name(&BackgroundAgent::of(value));
        }
        if value["is_backgrounded"] != true {
            if holds_run(field(value, "task_type")) && self.steers.foreground.iter().all(|(open, _)| open != task) {
                self.steers.foreground.push((task.to_owned(), string(value, "tool_use_id")));
            }
            return;
        }
        if child_shell(value) {
            if self.steers.child_shells.iter().all(|shell| shell.task != task) {
                self.steers.child_shells.push(BackgroundAgent::of(value));
            }
            return;
        }
        if holds_run(field(value, "task_type")) && self.steers.agents.iter().chain(&self.steers.settled).all(|agent| agent.task != task) {
            self.steers.agents.push(BackgroundAgent::of(value));
            if self.steers.idle {
                self.claude_owed();
            }
        }
    }

    /// The woken child may be relisted a moment later, so the short wait starts over from here.
    /// Mid-turn nothing is owed: the relist, if any, reaches the list before this turn's `result`.
    fn claude_child_shell_ended(&mut self) {
        self.steers.child_shell_ended = self.steers.idle;
        self.steers.shell_hold_since = None;
        self.steers.shell_notice = None;
        if self.steers.waiting_since.is_some() {
            self.steers.waiting_since = Some(tokio::time::Instant::now());
        }
        if self.steers.idle {
            self.claude_owed();
        }
    }

    /// A task's end is enough on its own: the list may never follow, and the run would stay
    /// open until Stop. A list that follows finds it already moved.
    pub(super) fn claude_task_ended(&mut self, value: &Value) {
        let ended = match field(value, "subtype") {
            "task_notification" => subagents::status(field(value, "status")).is_none_or(|status| !subagents::active(status)),
            _ => subagents::status(field(&value["patch"], "status")).is_some_and(|status| !subagents::active(status)),
        };
        let task = field(value, "task_id");
        if ended {
            self.steers.foreground.retain(|(open, _)| open != task);
        }
        if let Some(index) = self.steers.child_shells.iter().position(|shell| shell.task == task).filter(|_| ended) {
            self.steers.child_shells.remove(index);
            if self.steers.child_shells.is_empty() {
                self.claude_child_shell_ended();
            }
            return;
        }
        if let Some(index) = self.steers.agents.iter().position(|agent| agent.task == task).filter(|_| ended) {
            let agent = self.steers.agents.remove(index);
            if !self.steers.reports_to_parent(&agent) {
                self.steers.settled.push(agent);
            }
            self.claude_recheck_idle();
        }
    }

    /// The last agent left while idle. Owing nothing (it reported to a parent that never closed)
    /// still ends the run through the wait: no other frame may ever come.
    fn claude_recheck_idle(&mut self) {
        if self.steers.idle && !self.claude_owed() {
            self.steers.waiting_since.get_or_insert_with(tokio::time::Instant::now);
        }
    }

    /// Recorded in two shapes: an agent that settles before a tool boundary is handed over
    /// inside the turn as this replayed user message; otherwise Claude starts another turn.
    pub(super) fn claude_notification_taken(&mut self, value: &Value) -> bool {
        // Some CLIs end a foreground agent with only its tool result (fg.log).
        for block in value["message"]["content"].as_array().into_iter().flatten().filter(|block| block["type"] == "tool_result") {
            self.steers.foreground.retain(|(_, tool)| tool != field(block, "tool_use_id"));
        }
        let mut taken = false;
        for text in texts(&value["message"]["content"]) {
            if !text.trim_start().starts_with("<task-notification>") {
                continue;
            }
            taken = true;
            let mut rest = text;
            while let Some((id, after)) = rest.split_once("<task-id>").and_then(|(_, tail)| tail.split_once("</task-id>")) {
                self.steers.settled.retain(|agent| agent.task != id);
                rest = after;
            }
        }
        taken
    }

    /// A Claude turn ended cleanly: true when the run is finished. A hand-back turn's `result`
    /// names its task's run (a background command wakes a turn too, and takes nothing owed). A
    /// CLI that names none gets the worst case of a grace wait: its turn takes the oldest entry.
    ///
    /// A resumed process first drains what its last process left queued (a background command
    /// it killed): recorded as an empty `result` with `origin.kind` task-notification, no turns,
    /// before the prompt's echo. Only that shape waits for the prompt; a local slash command
    /// never echoes either, but its `result` has no `origin` and really ends the run. Sent as a
    /// steer, such a command answers with no turns and no echo: that `result` delivers it.
    pub(super) fn claude_turn_ended(&mut self, value: &Value, step: &mut Step) -> bool {
        let origin = &value["origin"];
        let notification = origin["kind"] == "task-notification";
        if !notification {
            // Until the prompt is answered, an unechoed `result` is its own slash command's.
            let prompt_pending = !self.prompt_replayed && !self.steers.prompt_answered;
            self.steers.prompt_answered = true;
            if !prompt_pending && value["num_turns"] == 0 {
                if let Some(index) = self.steers.live.iter().position(|(_, text, _)| text.starts_with('/')) {
                    let (id, text, mode) = self.steers.live.remove(index);
                    step.events.push(self.steer_event(&id, &text, "delivered", mode));
                }
            }
        }
        self.steers.prompt_owed = notification && !self.prompt_replayed && !self.steers.prompt_answered;
        self.steers.batch_owed = notification && value["num_turns"] == 0 && field(value, "result").trim().is_empty();
        let run = field(origin, "runId");
        if notification && !run.is_empty() {
            self.steers.settled.retain(|agent| agent.run != run);
        } else if self.steers.hand_back_turn && !self.steers.settled.is_empty() {
            self.steers.settled.remove(0);
        }
        self.steers.hand_back_turn = false;
        self.steers.idle = true;
        let finished = !self.claude_owed();
        if finished {
            self.claude_shell_note(step);
        }
        if let Some(status) = self.claude_shell_hold_status() {
            step.events.push(self.event("status", &status, None));
        }
        finished
    }

    /// The thread's status line while only child commands keep the run open, or None if the hold
    /// is over and the run is about to end.
    fn claude_shell_hold_status(&self) -> Option<String> {
        let steers = &self.steers;
        if steers.child_shells.is_empty() || steers.shell_notice.is_some() || !steers.agents.is_empty() || !steers.settled.is_empty() || steers.prompt_owed || steers.batch_owed || !steers.live.is_empty() {
            return None;
        }
        let left = (steers.shell_hold_since? + CHILD_SHELL_HOLD).checked_duration_since(tokio::time::Instant::now())?;
        let minutes = left.as_secs().div_ceil(60).max(1);
        let unit = if minutes == 1 { "minute" } else { "minutes" };
        Some(format!("Waiting on a subagent's background command{} for up to {minutes} {unit}. Stop ends it now.", shell_names(&steers.child_shells).map_or(String::new(), |names| format!(" ({names})"))))
    }

    /// True while Claude may still start a turn: agents running keep the run open for as
    /// long as they run; a settled agent or input Claude has not taken only until `claude_grace`.
    fn claude_owed(&mut self) -> bool {
        let steers = &mut self.steers;
        let shells_hold = !steers.child_shells.is_empty() && steers.shell_notice.is_none();
        if shells_hold && steers.agents.is_empty() {
            steers.shell_hold_since.get_or_insert_with(tokio::time::Instant::now);
        }
        if !steers.agents.is_empty() {
            steers.child_shell_ended = false;
            steers.waiting_since = None;
            return true;
        }
        if steers.settled.is_empty() && steers.live.is_empty() && !steers.prompt_owed && !steers.batch_owed && !shells_hold && !steers.child_shell_ended {
            return false;
        }
        steers.waiting_since.get_or_insert_with(tokio::time::Instant::now);
        true
    }

    pub(super) fn claude_idle(&self) -> bool {
        self.steers.idle
    }

    /// When the wait for an owed turn ends. Derived, so what is owed can change during the wait.
    pub(super) fn claude_grace(&self) -> Option<tokio::time::Instant> {
        let steers = &self.steers;
        let since = steers.waiting_since?;
        let turn = since + if steers.cloud { CLOUD_TURN_GRACE } else { CLAUDE_TURN_GRACE };
        if steers.prompt_owed || !steers.live.is_empty() || steers.prompt_hooks > 0 {
            return Some(since + CLAUDE_INPUT_GRACE);
        }
        if steers.child_shells.is_empty() {
            return Some(turn);
        }
        let hold = if steers.shell_notice.is_some() { since + SHELL_NOTICE_GRACE } else { steers.shell_hold_since.unwrap_or(since) + CHILD_SHELL_HOLD };
        // An agent that just settled still gets its hand-back, however long the commands have held.
        Some(if steers.settled.is_empty() && !steers.batch_owed { hold } else { hold.max(turn) })
    }

    pub(super) fn claude_over_cloud(&mut self) {
        self.steers.cloud = true;
    }

    /// The wait ran out. A subagent's command that outlasted its hold costs that subagent's report,
    /// and only Claude's own session can act on that, so the main agent gets one plain turn saying
    /// so; its `result` ends the run. Anything else ends the run now.
    pub(super) fn claude_wait_over(&mut self) -> Step {
        let steers = &self.steers;
        if steers.child_shells.is_empty() || steers.shell_notice.is_some() || !steers.settled.is_empty() || !steers.live.is_empty() || steers.prompt_owed || steers.prompt_hooks > 0 {
            return self.claude_end_idle();
        }
        let commands: Vec<String> = steers.child_shells.iter().map(|shell| {
            let subagent = steers.names.get(&shell.parent).map_or("a subagent".to_owned(), |name| format!("subagent \"{name}\""));
            if shell.name.is_empty() { format!("{subagent}'s background command") } else { format!("{subagent}'s command \"{}\"", shell.name) }
        }).collect();
        let text = format!("Still running: {}. The report that would follow it will not arrive, because this run is ending. Rerun the command in the foreground if you need its result, or say so in your report.", commands.join(", "));
        let mut step = Step::default();
        step.write.push(self.claude_input(&text));
        self.steers.shell_notice = Some(text);
        self.steers.waiting_since = Some(tokio::time::Instant::now());
        step
    }

    /// The owed turn never came, or the process closed: the run ends, a steer Claude never
    /// echoed is reported failed so the composer queues it again, and the transcript says whose
    /// report was lost. An `error` event would mark the turn failed and hold the queue.
    pub(super) fn claude_end_idle(&mut self) -> Step {
        let mut step = Step { done: true, ..Step::default() };
        self.steers.waiting_since = None;
        // Ending clean here would report an unanswered message as a finished turn.
        if self.steers.prompt_owed {
            step.failure = Some("Claude Code finished a leftover background notification but never took this message. Send it again.".into());
        }
        let lost: Vec<String> = self.steers.settled.drain(..).chain(self.steers.agents.drain(..))
            .map(|agent| if agent.name.is_empty() { "Subagent".to_owned() } else { format!("\"{}\"", agent.name) })
            .collect();
        if !lost.is_empty() {
            step.events.push(self.event("note", lost_report_note(&lost), None));
        }
        self.claude_shell_note(&mut step);
        for (id, text, mode) in std::mem::take(&mut self.steers.live) {
            step.events.push(self.steer_event(&id, &text, "failed", mode));
        }
        step
    }

    /// A clean run end closes the harness and its subagents: the transcript says whose report was lost.
    /// Claude Code's run stays open for them, and `claude_end_idle` says this itself.
    pub(super) fn lost_reports_note(&mut self) -> Vec<AgentEvent> {
        let lost = self.subagents.as_ref().map(subagents::Subagents::active_names).unwrap_or_default();
        if lost.is_empty() || matches!(self.config.provider.as_str(), "claude" | "glm" | "mimo") {
            return Vec::new();
        }
        vec![self.event("note", lost_report_note(&lost), None)]
    }

    /// Ending now stops the commands subagents still have running: the transcript says so.
    fn claude_shell_note(&mut self, step: &mut Step) {
        let shells = std::mem::take(&mut self.steers.child_shells);
        if !shells.is_empty() {
            let names = shell_names(&shells).map_or(String::new(), |names| format!(" ({names})"));
            let note = format!("A background command a subagent started{names} was still running when this run ended, so it was stopped and any report after it is lost.");
            step.events.push(self.event("note", note, None));
        }
    }

    /// The harness echoed a user message: the live steers it carries are delivered.
    pub(super) fn steers_consumed(&mut self, content: &Value, step: &mut Step) -> bool {
        let mut found = false;
        for text in texts(content) {
            if let Some(index) = self.steers.live.iter().position(|(_, steer, _)| steer == text.trim()) {
                let (id, text, mode) = self.steers.live.remove(index);
                step.events.push(self.steer_event(&id, &text, "delivered", mode));
                found = true;
            }
        }
        found
    }

    /// The harness took the live steer `id`.
    pub(super) fn steer_delivered(&mut self, id: &str, step: &mut Step) {
        if let Some(index) = self.steers.live.iter().position(|(steer, _, _)| steer == id) {
            let (id, text, mode) = self.steers.live.remove(index);
            step.events.push(self.steer_event(&id, &text, "delivered", mode));
        }
    }

    /// Claude echoes the opening prompt first; each later echo is a consumed steer.
    pub(super) fn claude_replay(&mut self, content: &Value, step: &mut Step) {
        if self.steers_consumed(content, step) {
            return;
        }
        if texts(content).iter().any(|text| self.steers.shell_notice.as_deref() == Some(text.trim())) {
            return;
        }
        // A `result` before any echo means the prompt never echoes (a local slash command), so
        // this echo is a steer's even if its text differs.
        let prompts_echo = !self.prompt_replayed && !self.steers.prompt_answered;
        self.prompt_replayed = true;
        if !prompts_echo && !self.steers.live.is_empty() {
            // Claude merged or reworded it; the oldest steer is the one it took.
            let (id, text, mode) = self.steers.live.remove(0);
            step.events.push(self.steer_event(&id, &text, "delivered", mode));
        }
    }

    /// Codex answered a `turn/steer`: steered live, or held for the next turn when its turn was over.
    pub(super) fn codex_steer_response(&mut self, value: &Value, step: &mut Step) -> bool {
        let Some((id, text, reply)) = value["id"].as_u64().and_then(|request| self.steers.requests.remove(&request)) else {
            return false;
        };
        let mode = if value.get("result").is_some() { "live" } else { "next-turn" };
        self.accept(id, text, mode, reply, step);
        self.steer_answered(step);
        true
    }

    /// Called after each steer answer: a turn that ended while it was open continues now.
    pub(super) fn steer_answered(&mut self, step: &mut Step) {
        if self.steers.turn_over && self.steers.requests.is_empty() && self.pi.steers.is_empty() {
            self.steers.turn_over = false;
            self.next_steered_turn(step);
        }
    }

    /// A Codex or Pi turn ended cleanly (Muse calls `next_steered_turn` itself). Held steers become the next turn of this
    /// session instead of the run finishing.
    pub(super) fn steer_turn_end(&mut self, step: &mut Step) {
        if !step.done || step.failure.is_some() {
            return;
        }
        if !self.steers.requests.is_empty() || !self.pi.steers.is_empty() {
            step.done = false;
            self.steers.turn_over = true;
            return;
        }
        self.next_steered_turn(step);
    }

    pub(super) fn next_steered_turn(&mut self, step: &mut Step) {
        if matches!(self.config.provider.as_str(), "pi" | "omp") {
            // Pi takes a queued steer before its next model call; one still here never reached it.
            let missed: Vec<_> = self.steers.live.drain(..).map(|(id, text, _)| (id, text)).collect();
            self.steers.held.extend(missed);
        }
        if self.steers.held.is_empty() {
            step.done = true;
            return;
        }
        step.done = false;
        let held = std::mem::take(&mut self.steers.held);
        let text = held.iter().map(|(_, text)| text.as_str()).collect::<Vec<_>>().join("\n\n");
        if self.config.provider == "codex" {
            self.config.prompt = text;
            if let Err(error) = self.codex_prompt(step) {
                step.failure = Some(error);
            }
        } else if self.config.provider == "muse" {
            self.config.prompt = text;
            self.muse_turn(step);
        } else if self.config.provider == "zcode" {
            self.zcode_prompt(text, step);
        } else {
            self.pi.settled = false;
            step.write.push(json!({"type":"prompt","id":"pandacode-prompt","message":text}));
        }
        for (id, text) in held {
            step.events.push(self.steer_event(&id, &text, "delivered", "next-turn"));
        }
    }

    /// The run ended. Steers it never delivered are reported failed so the app can
    /// queue them again; after a clean finish, an accepted live steer was taken.
    pub(super) fn steers_ended(&mut self, clean: bool) -> Vec<AgentEvent> {
        let mut events = self.acp_steers_failed().events;
        for (id, text, mode) in std::mem::take(&mut self.steers.live) {
            events.push(self.steer_event(&id, &text, if clean { "delivered" } else { "failed" }, mode));
        }
        for (id, text) in std::mem::take(&mut self.steers.held) {
            events.push(self.steer_event(&id, &text, "failed", "next-turn"));
        }
        // Unanswered requests drop their replies; the app keeps those messages queued.
        self.steers.requests.clear();
        self.pi.steers.clear();
        events
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::config;
    use super::*;

    fn steer(protocol: &mut Protocol, text: &str) -> (Step, tokio::sync::oneshot::Receiver<Result<Value, String>>) {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let id = format!("steer-{text}");
        (protocol.steer(id, text.into(), tx), rx)
    }

    fn steer_events(step: &Step) -> Vec<(String, String)> {
        step.events
            .iter()
            .filter(|event| event.kind == "steer")
            .map(|event| {
                let data = event.data.as_ref().unwrap();
                (data["status"].as_str().unwrap().to_owned(), data["mode"].as_str().unwrap().to_owned())
            })
            .collect()
    }

    fn pair(status: &str, mode: &str) -> (String, String) {
        (status.into(), mode.into())
    }

    #[test]
    fn claude_steers_on_stream_input_and_waits_for_a_late_steer_turn() {
        let mut p = Protocol::new(config("claude"));
        p.phase = 1;
        p.remote_id = "session".into();
        let (step, mut reply) = steer(&mut p, "  also add tests  ");
        assert_eq!(step.write.len(), 1);
        assert_eq!(step.write[0]["type"], "user");
        assert_eq!(step.write[0]["message"]["content"][0]["text"], "also add tests");
        assert_eq!(step.write[0]["session_id"], "session");
        assert_eq!(reply.try_recv().unwrap().unwrap(), json!({"steered":true,"id":"steer-  also add tests  ","mode":"live"}));
        assert_eq!(steer_events(&step), [pair("pending", "live")]);
        // The opening prompt is echoed first; it is not a steering message.
        let step = p.receive(json!({"type":"user","isReplay":true,"message":{"role":"user","content":"original"}})).unwrap();
        assert!(steer_events(&step).is_empty());
        // A result before the steer is echoed means Claude will answer it in another turn.
        let early = p.receive(json!({"type":"result","subtype":"success","result":"first answer"})).unwrap();
        assert!(!early.done, "the run stays open for the steered turn");
        let step = p.receive(json!({"type":"user","isReplay":true,"message":{"role":"user","content":[{"type":"text","text":"also add tests"}]}})).unwrap();
        assert_eq!(steer_events(&step), [pair("delivered", "live")]);
        assert!(p.receive(json!({"type":"result","subtype":"success","result":"done"})).unwrap().done);
    }

    #[test]
    fn claude_steer_consumed_mid_turn_finishes_with_one_result() {
        let mut p = Protocol::new(config("glm"));
        p.phase = 1;
        let _ = steer(&mut p, "steer");
        for text in ["prompt", "steer"] {
            p.receive(json!({"type":"user","isReplay":true,"message":{"role":"user","content":[{"type":"text","text":text}]}})).unwrap();
        }
        assert!(p.receive(json!({"type":"result","subtype":"success","result":"ok"})).unwrap().done);
    }

    /// A local slash command's prompt never echoes, so a reworded steer's echo is not the prompt's:
    /// its `result` came first, and the steer does not wait out the 15 minutes.
    #[test]
    fn claude_pairs_a_reworded_steer_after_a_prompt_with_no_echo() {
        let mut p = Protocol::new(config("claude"));
        p.phase = 1;
        let _ = steer(&mut p, "add tests");
        assert!(!p.receive(json!({"type":"result","subtype":"success","result":"cost","num_turns":0})).unwrap().done, "the steer is owed its turn");
        let step = p.receive(json!({"type":"user","isReplay":true,"message":{"role":"user","content":[{"type":"text","text":"please add tests"}]}})).unwrap();
        assert_eq!(steer_events(&step), [pair("delivered", "live")]);
        assert!(p.receive(json!({"type":"result","subtype":"success","result":"ok","num_turns":1})).unwrap().done);
    }

    #[test]
    fn claude_holds_a_steer_until_the_opening_prompt_is_written() {
        let mut p = Protocol::new(config("claude"));
        let (step, mut reply) = steer(&mut p, "early");
        assert!(step.write.is_empty(), "nothing may overtake the opening prompt");
        assert_eq!(reply.try_recv().unwrap().unwrap()["mode"], "next-turn");
        let step = p.receive(json!({"type":"control_response","response":{"subtype":"success","request_id":"pandacode-init","response":{}}})).unwrap();
        let users: Vec<_> = step.write.iter().filter(|frame| frame["type"] == "user").collect();
        assert_eq!(users.len(), 2);
        assert_eq!(users[1]["message"]["content"][0]["text"], "early");
        p.receive(json!({"type":"user","isReplay":true,"message":{"role":"user","content":"Explain this project"}})).unwrap();
        assert!(!p.receive(json!({"type":"result","subtype":"success","result":"a"})).unwrap().done);
        let step = p.receive(json!({"type":"user","isReplay":true,"message":{"role":"user","content":[{"type":"text","text":"early"}]}})).unwrap();
        assert_eq!(steer_events(&step), [pair("delivered", "next-turn")]);
        assert!(p.receive(json!({"type":"result","subtype":"success","result":"b"})).unwrap().done);
    }

    #[test]
    fn a_failed_or_stopped_run_reports_undelivered_steers() {
        let mut p = Protocol::new(config("claude"));
        p.phase = 1;
        let _ = steer(&mut p, "never echoed");
        assert!(p.receive(json!({"type":"result","subtype":"error_during_execution","is_error":true,"result":"boom"})).is_err());
        let events = p.steers_ended(false);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].data.as_ref().unwrap()["status"], "failed");
        assert_eq!(events[0].text, "never echoed");
        assert!(p.steers_ended(false).is_empty(), "reported once");
    }

    #[test]
    fn codex_steers_the_active_turn_live() {
        let mut p = Protocol::new(config("codex"));
        p.phase = 1;
        p.remote_id = "thread-1".into();
        p.turn_id = "turn-7".into();
        let (step, mut reply) = steer(&mut p, "focus on the parser");
        let request = step.write.iter().find(|request| request["method"] == "turn/steer").expect("turn/steer request");
        assert_eq!(request["params"]["expectedTurnId"], "turn-7");
        assert_eq!(request["params"]["threadId"], "thread-1");
        assert_eq!(request["params"]["input"][0]["text"], "focus on the parser");
        let id = request["id"].clone();
        let step = p.receive(json!({"id":id,"result":{"turnId":"turn-7"}})).unwrap();
        assert_eq!(steer_events(&step), [pair("pending", "live")]);
        assert_eq!(reply.try_recv().unwrap().unwrap()["mode"], "live");
        // Recorded from codex app-server: the steer is echoed as a userMessage item when consumed.
        let step = p.receive(json!({"method":"item/started","params":{"threadId":"thread-1","turnId":"turn-7","item":{"type":"userMessage","id":"u2","content":[{"type":"text","text":"focus on the parser","text_elements":[]}]}}})).unwrap();
        assert_eq!(steer_events(&step), [pair("delivered", "live")]);
        let end = p.receive(json!({"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-7","status":"completed"}}})).unwrap();
        assert!(end.done);
    }

    #[test]
    fn codex_holds_a_steer_for_the_next_turn_of_the_same_thread() {
        let mut p = Protocol::new(config("codex"));
        p.phase = 1;
        p.remote_id = "thread-1".into();
        // No turn yet: held instead of refused.
        let (step, mut early) = steer(&mut p, "first steer");
        assert!(step.write.is_empty());
        assert_eq!(early.try_recv().unwrap().unwrap()["mode"], "next-turn");
        p.turn_id = "turn-7".into();
        // A turn/steer that loses the race with the turn's end is refused, then held.
        let (step, mut late) = steer(&mut p, "second steer");
        let id = step.write[0]["id"].clone();
        let end = p.receive(json!({"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-7","status":"completed"}}})).unwrap();
        assert!(!end.done, "the run waits for the steer's answer");
        let next = p.receive(json!({"id":id,"error":{"code":-32600,"message":"no active turn"}})).unwrap();
        assert!(!next.done, "the run continues with the steered turn");
        assert_eq!(late.try_recv().unwrap().unwrap()["mode"], "next-turn");
        let turn = next.write.iter().find(|request| request["method"] == "turn/start").expect("next turn");
        assert_eq!(turn["params"]["threadId"], "thread-1");
        assert_eq!(turn["params"]["input"][0]["text"], "first steer\n\nsecond steer");
        assert_eq!(steer_events(&next), [pair("pending", "next-turn"), pair("delivered", "next-turn"), pair("delivered", "next-turn")]);
        p.receive(json!({"method":"turn/started","params":{"threadId":"thread-1","turn":{"id":"turn-8"}}})).unwrap();
        assert!(p.receive(json!({"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-8","status":"completed"}}})).unwrap().done);
    }

    #[test]
    fn pi_steers_live_and_holds_when_not_streaming() {
        let mut idle = Protocol::new(config("pi"));
        let (step, mut reply) = steer(&mut idle, "too early");
        assert!(step.write.is_empty());
        assert_eq!(reply.try_recv().unwrap().unwrap()["mode"], "next-turn");

        let mut p = Protocol::new(config("pi"));
        p.phase = 1;
        let (step, mut accepted) = steer(&mut p, " check the docs ");
        assert_eq!(step.write[0]["type"], "steer");
        assert_eq!(step.write[0]["message"], "check the docs");
        let id = step.write[0]["id"].as_str().unwrap().to_owned();
        let (step, mut refused) = steer(&mut p, "second");
        let refused_id = step.write[0]["id"].clone();
        let step = p.receive(json!({"type":"response","command":"steer","id":id,"success":true,"data":{"disposition":"queued"}})).unwrap();
        assert_eq!(steer_events(&step), [pair("pending", "live")]);
        assert_eq!(accepted.try_recv().unwrap().unwrap()["mode"], "live");
        // A refused steer never fails the run; it waits for the next turn.
        let step = p.receive(json!({"type":"response","command":"steer","id":refused_id,"success":false,"error":"Not streaming"})).unwrap();
        assert!(!step.done);
        assert_eq!(refused.try_recv().unwrap().unwrap()["mode"], "next-turn");
        let step = p.receive(json!({"type":"message_start","message":{"role":"user","content":[{"type":"text","text":"check the docs"}]}})).unwrap();
        assert_eq!(steer_events(&step), [pair("delivered", "live")]);
        p.receive(json!({"type":"agent_settled","aborted":false})).unwrap();
        let (step, mut late) = steer(&mut p, "after settling");
        assert!(step.write.is_empty());
        assert_eq!(late.try_recv().unwrap().unwrap()["mode"], "next-turn");
        let next = p.receive(json!({"type":"response","command":"get_session_stats","id":"pandacode-usage","success":true,"data":{}})).unwrap();
        assert!(!next.done);
        assert_eq!(next.write[0]["type"], "prompt");
        assert_eq!(next.write[0]["message"], "second\n\nafter settling");
        p.receive(json!({"type":"agent_settled","aborted":false})).unwrap();
        assert!(p.receive(json!({"type":"response","command":"get_session_stats","id":"pandacode-usage","success":true,"data":{}})).unwrap().done);
    }

    #[test]
    fn acp_harnesses_steer_and_empty_messages_are_refused() {
        for provider in ["kimi", "opencode", "kilo", "grok", "antigravity", "deepseek", "commandcode", "hermes", "cursor"] {
            let mut p = Protocol::new(config(provider));
            let (_, mut reply) = steer(&mut p, "hello");
            assert!(reply.try_recv().unwrap().is_ok(), "{provider} holds the steer");
        }
        let mut p = Protocol::new(config("claude"));
        p.phase = 1;
        let (_, mut reply) = steer(&mut p, "   ");
        assert!(reply.try_recv().unwrap().is_err());
    }

    /// The composer's message stays queued; an agent's went nowhere, and it must be told.
    #[test]
    fn an_agent_is_told_a_refused_steer_was_not_delivered() {
        let refused = |provider: &str, sent: usize| {
            let mut p = Protocol::new(config(provider));
            p.phase = 1;
            for n in 0..sent {
                let _ = steer(&mut p, &format!("steer {n}"));
            }
            let (_, mut reply) = steer(&mut p, "one more");
            reply.try_recv().unwrap().unwrap_err()
        };
        for (provider, sent, reason) in [("claude", MAX_STEERS, "Too many steering messages are waiting"), ("kimi", MAX_STEERS, "Too many steering messages are waiting"), ("unknown", 0, "This agent cannot be steered")] {
            let composer = refused(provider, sent);
            assert!(composer.contains("stays queued"), "{composer}");
            let agent = crate::message_queue::steer_refusal(&composer, "Use queue_message.");
            assert_eq!(agent, format!("Not delivered: {reason}. Use queue_message."));
        }
        let timed_out = crate::message_queue::steer_refusal("The agent did not accept the message in time; it stays queued.", "Use queue_message.");
        assert_eq!(timed_out, "Not delivered: The agent did not accept the message in time. Use queue_message.");
    }
}
