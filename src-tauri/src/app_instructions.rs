//! The fixed app instructions every task turn carries, and which PandaCode tool families a
//! run's role lists (`Role`, `HostTrim`). Moved out of `lib.rs`; behaviour is documented on
//! each item.
use crate::providers::{takes_system_instructions, RunConfig, ToolHost};
use crate::storage::Store;
use crate::{custom_tools, explore, run_script, session_titles, turn_changes};
use std::collections::HashSet;
use std::sync::{Arc, Mutex};

mod catalog;
mod state;
pub(crate) use state::{compaction_answered, compactions_after, forget, instructed_as, instructions_due, new_compaction};
use state::{instructions_owed, owe_instructions};
pub(crate) use catalog::{build_host, listing as catalog_listing, remember_listed as remember_catalog_listed, History, HostLayers, RunHost};
#[cfg(test)]
pub(crate) use catalog::remember as remember_catalog;
#[cfg(test)]
pub(crate) use catalog::{fake, Layers};

// Keep `const NAME: &str` and `fn look(` readable by scripts/agent-bench.
/// Agent-made tools only get made and reused when agents are told when to.
pub(crate) const REUSE: &str = "\n\nIf the Project tools note lists a tool that does a multi-step command sequence you need, run it; after doing the same sequence twice, or once when it will clearly recur, save it with pandacode_tool_save.";

/// PandaCode closes the harness when a turn ends, so background waits never come back.
/// Claude Code's background agents are the exception: the run stays open until they hand back.
const TURN_ENDS: &str = "\n\nYour turn ends when you reply, and PandaCode then closes this session's process: background commands, monitors and harness wakeups started in this turn never report back (pandacode_schedule_wakeup, when listed, does: it wakes this thread later). Background Agent subagents in Claude Code are different: they do report back, because the run stays open until they finish. On any other harness, a subagent still running when you reply is stopped and its report is lost: wait for every subagent you started (Codex: its wait tool) before you reply. Wait for long-running commands in the foreground (or poll them) before you reply.";

/// Each extra step re-reads the whole cached prompt, so lookups should take as few as they can.
const LOOK: &str = "\n\nUse {explore} to locate code (search, symbols, outlines, ranged reads), with all your questions in one call. When a reply already names the files and symbols you need, answer; search again only for a named gap. ";

/// The Claude-family edit text (claude, glm, mimo), read by name by scripts/agent-bench.
const EDIT_CLAUDE: &str = "Before editing a file, Read the lines you need with Read (explore reads don't count). Make each file's changes in as few edit calls as your editor allows.";
/// Edit text for harnesses that are not Claude Code.
const EDIT_OTHER: &str = "Make each file's changes in as few edit calls as your tools allow.";

/// `LOOK` for a worker that cannot edit: no edit sentence.
fn look_read_only(explore: explore::RunExplore) -> String {
    LOOK.replace("{explore}", explore.name).trim_end().to_owned()
}

fn look(explore: explore::RunExplore) -> String {
    let edit = if explore.claude_code { EDIT_CLAUDE } else { EDIT_OTHER };
    [&LOOK.replace("{explore}", explore.name), edit].concat()
}

/// Questions to the user render rich Markdown in PandaCode; agents only use it if told.
const RICH_QUESTIONS: &str = "\n\nQuestions you ask through the request_user_input tool, where available, render Markdown in PandaCode: use links, images by workspace path (![alt](relative/path.png)), ```chart blocks with JSON {\"type\":\"bar\"|\"line\"|\"pie\",\"title\",\"labels\":[…],\"series\":[{\"name\",\"values\":[…]}]}, ```svg drawings, or static ```html views when a visual helps the user decide. Remote images show as links; scripts never run.";

/// Replies may carry generative UI blocks that PandaCode draws in the thread.
const GENERATIVE_UI: &str = "\n\nGenerative UI: when a visual beats prose, a reply may include a ```ui block holding JSON {\"type\":…}; ```chart, ```svg and ```html work too. Types (fields): callout(tone info|success|warning|danger|note,title,body), card(title,body,footer,actions,children), stats(items[{label,value,delta,hint,spark[]}]), table(title,columns[],rows[[…]]), chart(chart bar|line|pie|area|sparkline,title,labels,series[{name,values}]), progress(label,value,max), plan|steps|timeline(title,summary,items[{title,detail,status done|active|pending|error|skipped,time}],actions), checklist(items[{text,done}]), tabs|accordion(items[{label,body,children}]), tree(paths[] or items[{name,status,children}]), diff(file,diff), code(file,language,code), terminal(command,output,exitCode), compare(items[{title,pros,cons,verdict}]), gallery(images[{path,caption}]), actions(buttons[{label,prompt,tone}]), chips|followups(options[{label,prompt}]), or inline :codex-followup[Label]{prompt=\"…\"}, form(title,fields[{name,label,type text|textarea|number|select|checkbox,options}],submit,prompt with {name}), stack|grid(columns,children), custom(html,css,state; data-ui-toggle=\"#id\", data-ui-tab/data-ui-panel, data-ui-set=\"k=v\", data-ui-bind=\"k\", data-ui-prompt). Bodies are Markdown. Buttons and forms only put a prompt in the user's composer; nothing runs, and remote URLs are not loaded. ```mermaid shows as labelled source. For a page that needs scripts, write an HTML file and open it with pandacode_preview_file.";

/// Agents building a GUI post one annotated screenshot per iteration to the progress timeline.
const VISUAL_PROGRESS: &str = "\n\nVisual progress: only when your work has a graphical interface you can actually capture (a web page, desktop or mobile app, simulator, VM screen or design artboard), after each meaningful visual iteration save a screenshot of only that app's own window or page (a headless browser screenshot, a simulator or VM screenshot tool, or `screencapture -l<windowid>` on macOS; never the whole screen or other windows) under .pandacode/progress-shots/, call pandacode_progress_snapshot with a short title, an optional note and a few annotations pointing at what changed, then delete the file, since the image is copied. Before a UI exists you may post an svg idea sketch instead. Post at most one per iteration, and skip this entirely for CLIs, libraries, backend or docs work, or when no such screenshot can be taken.";

/// What decides the app instructions' bytes (see `app_instructions` for each field).
#[derive(Clone, Copy)]
pub(crate) struct InstructionOptions {
    pub chat: bool,
    pub role: Role,
    pub explore: Option<explore::RunExplore>,
    pub tools: bool,
    pub cloud: bool,
}

/// Fixed instructions for every task turn: sidebar titles, the run script, change tracking.
/// Projectless chats have nothing to run, so they skip the run script. Managed team workers
/// report to their lead, not the user: no titles (they never get a title run), run script,
/// rich questions or generative UI.
///
/// `explore` is how this run's agent has `pandacode_explore` (its name for it, and whether the
/// harness is Claude Code), or `None` when the run does not have it. It depends only on the
/// harness and on the run being local, so the prompt's bytes stay the same turn after turn.
///
/// `tools`: the run is offered agent-made tools, so it hears the one fixed `REUSE` sentence.
/// Whether the project has any tool rides the Project tools note on the message
/// (`custom_tools::message_note`), so a first save or a last removal never changes these bytes.
///
/// `cloud`: the run's checkout is on a cloud machine, which never lists
/// `pandacode_progress_snapshot` (`catalog.rs`), so it is not told about visual progress.
///
/// Nothing here depends on the run's mode, allow rules or connection: these bytes are cached
/// as Claude's system prompt, and a change rewrites the whole history's cache. Mode-dependent
/// guidance rides the turn's message instead (`turn_changes::turn_note`).
pub(crate) fn app_instructions(options: &InstructionOptions) -> String {
    let InstructionOptions { chat, role, explore, tools, cloud } = *options;
    // A read-only worker edits nothing, so it hears no edit sentence. Fixed per role, so its
    // cached bytes never change.
    let writes = role.writes();
    let look = explore.map_or_else(String::new, |explore| if writes { look(explore) } else { look_read_only(explore) });
    let reuse = if tools { REUSE } else { "" };
    if role.managed() {
        let track = if writes { turn_changes::instruction() } else { "" };
        return [track, TURN_ENDS, &look, reuse].concat();
    }
    let run = if chat { "" } else { run_script::INSTRUCTIONS };
    let progress = if cloud { "" } else { VISUAL_PROGRESS };
    [session_titles::GUIDANCE, run, turn_changes::instruction(), TURN_ENDS, &look, reuse, RICH_QUESTIONS, GENERATIVE_UI, progress].concat()
}

/// The app instructions for a launch. `offered`: the run is offered agent-made tools and has a
/// catalog. `config.mode` must not decide anything here (see `app_instructions`).
pub(crate) fn launch_instructions(config: &RunConfig, role: Role, explore: Option<explore::RunExplore>, offered: bool) -> String {
    let cloud = crate::cloud_agents::transport::is_cloud(&config.session_id);
    app_instructions(&InstructionOptions { chat: crate::chats::is_chat_folder(&config.cwd), role, explore, tools: offered, cloud })
}

/// What decides a launch's instructions, besides its config.
pub(crate) struct LaunchText {
    pub role: Role,
    pub explore: Option<explore::RunExplore>,
    /// `custom_tools_offered` for this run, with a catalog to offer.
    pub offered: bool,
    /// The message must stay the bare command (`bare_command`): a maintenance turn (`/context`,
    /// `/compact`…) or any slash command the harness runs itself, where anything appended would
    /// become the command's arguments.
    pub maintenance: bool,
}

/// Whether a turn's message must reach the harness exactly as typed: a maintenance turn, or any
/// slash command the harness executes natively (Claude Code and Codex pass everything after the
/// name, hidden notes included, as `$ARGUMENTS`). Such a turn carries no message-borne note
/// (tracking, Plan, Project tools, instructions) and records none as sent, so the notes ride the
/// next ordinary turn.
pub(crate) fn bare_command(maintenance: bool, command: bool) -> bool {
    maintenance || command
}

/// What a clean end of the run records (`instructed_as`, `compaction_answered`).
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Instructed {
    pub role: Option<Role>,
    pub compaction: Option<i64>,
}

/// Puts this turn's instructions on its launch. System-prompt harnesses get them on every launch,
/// maintenance included: they are part of the warm key, so a maintenance turn without them would
/// miss the task's spare and kill it. Anything riding the message skips maintenance and other
/// native slash-command turns (`bare_command`).
pub(crate) fn instruct_launch(store: &Mutex<Store>, config: &mut RunConfig, text: LaunchText) -> Instructed {
    let LaunchText { role, explore, offered, maintenance } = text;
    if !maintenance {
        // Mode-dependent tracking guidance rides the message, never the cached instructions.
        if let Some(note) = turn_changes::turn_note(role.writes() && turn_changes::edits_wait_for_run(config)) {
            config.prompt.push_str(note);
        }
    }
    let instructions = launch_instructions(config, role, explore, offered);
    if takes_system_instructions(&config.provider) {
        // Cached with the system prompt: paid once, then read at a tenth of the price.
        config.instructions = instructions;
        return Instructed::default();
    }
    if maintenance {
        // A new conversation still needs its instructions: they go with the next message.
        if config.resume_id.is_none() {
            owe_instructions(&config.session_id);
        }
        return Instructed::default();
    }
    // In the message: on a new conversation, then as a periodic reminder.
    let turns = store.lock().ok().and_then(|db| db.user_turns(&config.session_id).ok()).unwrap_or(1);
    // A worker's follow-up may flip `read_only`: its instructions go out again only then (the
    // role is persisted per task, so a restart alone does not resend them; a task with no
    // record, lost or evicted, says them again).
    let flipped = instructions_due(&config.session_id, role) && role.managed();
    // A reported compaction dropped the first message, so the reminder is not enough.
    let compaction = store.lock().ok().and_then(|db| new_compaction(&db, &config.session_id));
    let resend_all = config.resume_id.is_none() || flipped || compaction.is_some() || instructions_owed(&config.session_id);
    if let Some(instructions) = turn_instructions(instructions, resend_all, turns) {
        config.prompt.push_str(&instructions);
    }
    Instructed { role: Some(role), compaction }
}

/// Plan mode lists at most `pandacode_tool_list`, so the cached sentence about saving and
/// running needs this caveat on the turn's own message.
const PLAN_TOOLS_NOTE: &str = "\n\nPlan mode: agent-made tools cannot be saved or run this turn.";

/// The caveat for a turn offered agent-made tools; `None` outside Plan mode.
pub(crate) fn plan_tools_note(mode: &str) -> Option<&'static str> {
    (mode == "plan").then_some(PLAN_TOOLS_NOTE)
}

/// Who a run reports to, which decides the instructions and PandaCode tools it gets.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Role {
    /// A plain task or a team's lead: everything.
    Task,
    /// A managed team worker that may edit.
    Worker,
    /// A managed team worker the lead marked read-only (`WorkerTrim::read_only`).
    ReadOnlyWorker,
}

/// PandaCode tool families a run wants, decided again on every turn from the worker's current
/// assignment (`architect::worker_trim`) and the Local code explorer setting. A worker stays a
/// worker, but a lead's follow-up may flip `read_only` (`architect.rs`, follow-up `readOnly`).
///
/// A family a turn does not want is still listed, and its calls refused, while a resumed
/// conversation may hold it (`catalog`: Claude can keep a ToolSearch reference to it, and
/// dropping the definition would break the request); only a new conversation drops it. A
/// read-only → writer flip adds the families, which Claude-family and ACP harnesses pick up
/// from the next launch's MCP catalog; Codex lists the families that can flip from its
/// thread's first turn, since it never hears of a dynamic tool added later. The instructions
/// follow the current role (`Role::writes`) and are re-sent when it flips
/// (`instructions_due`). Workers never keep a warm agent, so a flip never adopts a process
/// started with the old catalog. Reviewers keep what they read with: design list/comments,
/// `pandacode_preview_file` and `pandacode_run_project` stay for every role.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct HostTrim {
    /// `pandacode_title`: workers never get a title run (`TitleRun::prepare`).
    pub titles: bool,
    /// `pandacode_schedule_*`: a worker's turn ends with its assignment; the lead schedules.
    pub schedules: bool,
    /// Agent-made tools (`custom_tools_offered`): never for managed workers, trimmed or not, nor
    /// while the opt-in Settings switch is off (`HostPlan::custom_tools`).
    pub custom: bool,
    /// `pandacode_explore`: the Local code explorer setting is on (and the run can list it).
    pub explore: bool,
    /// `pandacode_progress_snapshot`: posts a picture of new work.
    pub progress: bool,
    /// `pandacode_design_write` and `pandacode_design_resolve`: change the design canvas.
    pub design_writes: bool,
    /// `pandacode_track_files` and its instruction: only for runs that may edit.
    pub track: bool,
}

/// Which layers a run's tool host gets (`run_host` in `lib.rs`): everything about the run that
/// decides its catalog, and so the warm key's `tools`, apart from the computer's own state
/// (simulators, VMs, linked machines, agent-made tools) and what the conversation already holds
/// (`catalog::History`). A lead's dispatch and review-wake turns must build the same plan, or
/// the spare started after one never serves the other.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct HostPlan {
    /// A team task: the team's coordination tools (and no machine tools).
    pub team: bool,
    /// Codex: its thread persists the tool schema, so a family can flip on its first turn
    /// (`catalog::History`). Every harness gets PandaCode's agent tools, a team's only on its lead.
    pub codex: bool,
    /// A cloud agent's checkout is on its machine: no progress snapshots, ever.
    pub cloud: bool,
    /// The families this turn wants.
    pub trim: HostTrim,
    /// `Some(strict)` when the run can list `pandacode_explore` at all (local, a harness that
    /// takes it; strict in Plan mode), whether or not the setting is on (`trim.explore`).
    pub explore: Option<bool>,
}

impl HostPlan {
    /// `explore_offered`: the run could list `pandacode_explore` (`explore::run_name` with the
    /// setting on); `explore_on`: explore is on for this harness (`explore::enabled_for`);
    pub(crate) fn of(config: &crate::providers::RunConfig, team: bool, role: Role, cloud: bool, explore_offered: bool, explore_on: bool) -> Self {
        // Trim off (the default): a worker wants what a plain task wants, minus the writes.
        let mut trim = if config.worker.is_none_or(|worker| worker.trim) { role.wants() } else { role.untrimmed() };
        trim.progress &= !cloud;
        trim.explore = explore_offered && explore_on;
        HostPlan { team, codex: config.provider == "codex", cloud, trim, explore: explore_offered.then_some(config.mode == "plan") }
    }
    /// This plan with agent-made tools wanted only while `on` (the opt-in Settings switch,
    /// `custom_tools::ipc::enabled_for`). Off, a conversation that may hold them keeps them
    /// listed and refused (`catalog::build_host`); a new one lists none.
    pub(crate) fn custom_tools(self, on: bool) -> Self {
        HostPlan { trim: HostTrim { custom: self.trim.custom && on, ..self.trim }, ..self }
    }
}

/// Design tools that change the canvas; read-only workers keep only list and comments.
pub(crate) const DESIGN_WRITES: [&str; 2] = ["pandacode_design_write", "pandacode_design_resolve"];

impl Role {
    pub(crate) fn of(managed_worker: bool, read_only: bool) -> Self {
        match (managed_worker, read_only) {
            (false, _) => Self::Task,
            (true, false) => Self::Worker,
            (true, true) => Self::ReadOnlyWorker,
        }
    }
    pub(crate) fn managed(self) -> bool {
        self != Self::Task
    }
    /// Whether this role may edit: everyone but a read-only worker.
    pub(crate) fn writes(self) -> bool {
        self != Self::ReadOnlyWorker
    }
    /// The families this role wants (explore and agent-made tools follow their settings, in
    /// `HostPlan::of`).
    pub(crate) fn wants(self) -> HostTrim {
        let task = !self.managed();
        let writes = self.writes();
        HostTrim { titles: task, schedules: task, custom: task, explore: true, progress: writes, design_writes: writes, track: writes }
    }
    /// `wants` with Settings → Agents → Trim worker tools off: a worker gets a plain task's
    /// families. A read-only worker still gets no design writes and no change tracking: that is
    /// read-only enforcement, not trim. Agent-made tools stay off: workers are never offered them
    /// (`custom_tools_offered`).
    pub(crate) fn untrimmed(self) -> HostTrim {
        let writes = self.writes();
        HostTrim { custom: false, design_writes: writes, track: writes, ..Role::Task.wants() }
    }
}

/// `host` without the named tools: they leave the catalog and the approval list, and a call
/// to one is refused rather than passed on.
pub(crate) fn without_tools(host: Option<ToolHost>, dropped: &'static [&'static str]) -> Option<ToolHost> {
    let host = host?;
    let tools = host.tools.iter().filter(|tool| !tool["name"].as_str().is_some_and(|name| dropped.contains(&name))).cloned().collect();
    let approval_tools: HashSet<String> = host.approval_tools.iter().filter(|name| !dropped.contains(&name.as_str())).cloned().collect();
    Some(refusing(host, tools, approval_tools, dropped.iter().map(|name| (*name).to_owned()).collect()))
}

/// What a read-only worker may not call: change tracking, progress snapshots, design writes
/// (`Role::wants` decides it; tests check the refused set against this list).
#[cfg(test)]
pub(crate) const READ_ONLY_WRITES: [&str; 4] = [turn_changes::TRACK_TOOL, "pandacode_progress_snapshot", DESIGN_WRITES[0], DESIGN_WRITES[1]];

/// `host` with the named tools still listed (the catalog stays stable for a resumed session)
/// but every call to one refused, and none of them approval-gated in PandaCode's own tool host.
/// A harness's own permission check should not ask for them either: Claude's lets exactly this
/// set through (`RunHost::refused`, carried to its `can_use_tool` handling as
/// `providers::RunTools::refused`), so the user is never asked to approve a call that would
/// fail. Codex's and ACP harnesses' own permission layers do not read the set and may still
/// prompt for a refused tool; its handler refuses the call either way.
pub(crate) fn refuse_tools(host: Option<ToolHost>, refused: HashSet<String>) -> Option<ToolHost> {
    let host = host?;
    let approval_tools = host.approval_tools.iter().filter(|name| !refused.contains(name.as_str())).cloned().collect();
    let tools = host.tools.clone();
    Some(refusing(host, tools, approval_tools, refused))
}

/// `host` listing `tools` (gated by `approval_tools`), except that a call to one of `refused`
/// fails with a note instead of reaching its handler.
fn refusing(host: ToolHost, tools: Vec<serde_json::Value>, approval_tools: HashSet<String>, refused: HashSet<String>) -> ToolHost {
    let inner = host.handler;
    let refused = Arc::new(refused);
    ToolHost {
        tools,
        approval_tools,
        handler: Arc::new(move |name, args| {
            if refused.contains(&name) {
                return Box::pin(async move { Err(format!("{name} is not available in this turn; continue without it.")) });
            }
            inner(name, args)
        }),
    }
}

/// Agent-made tools (host, note and `REUSE`): never for managed team workers, which report to
/// their lead; 0 saves or runs were seen in real worker transcripts. `lib.rs` also requires the
/// opt-in Settings switch (`custom_tools::ipc::enabled_for`).
pub(crate) fn custom_tools_offered(cloud: bool, managed_worker: bool) -> bool {
    custom_tools::offered(cloud) && !managed_worker
}

/// Harnesses without a system prompt hear the app instructions again every few turns.
const INSTRUCTION_REMINDER_EVERY: i64 = 8;
fn reminder_turn(turns: i64) -> bool {
    turns > 0 && turns % INSTRUCTION_REMINDER_EVERY == 1
}

/// Periodic turns name the rich guidance in one line instead of resending it (about 1.6 KB
/// less). Self-contained, so it stays true after a compaction dropped the first message.
const RICH_REMINDER: &str = "\n\nRich replies and questions: PandaCode renders Markdown, workspace images by relative path (![alt](path.png)), ```ui blocks of JSON {\"type\":…} (callout, card, stats, table, chart, plan, checklist, diff, actions, form…), ```chart JSON bar|line|pie, ```svg and static ```html; scripts never run and remote images show as links.";

/// The app instructions for a periodic reminder: `RICH_QUESTIONS` and `GENERATIVE_UI` are sent
/// once per conversation, then replaced by `RICH_REMINDER`.
fn periodic_instructions(full: &str) -> String {
    let trimmed = full.replace(RICH_QUESTIONS, "").replace(GENERATIVE_UI, "");
    if trimmed.len() == full.len() {
        return trimmed;
    }
    trimmed + RICH_REMINDER
}

/// What a harness without a system prompt hears in this turn's message: everything when
/// `resend_all` (a new conversation, or a worker whose role flipped since its instructions
/// last went out), the periodic form every `INSTRUCTION_REMINDER_EVERY` turns, else nothing.
pub(crate) fn turn_instructions(full: String, resend_all: bool, turns: i64) -> Option<String> {
    if resend_all {
        Some(full)
    } else if reminder_turn(turns) {
        Some(periodic_instructions(&full))
    } else {
        None
    }
}

#[cfg(test)]
mod tests;
