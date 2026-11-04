use super::{tests::config, AgentEvent, Protocol};
use serde_json::{json, Value};

fn events(frames: &[Value]) -> Vec<AgentEvent> {
    let mut protocol = Protocol::new(config("claude"));
    frames
        .iter()
        .flat_map(|frame| protocol.receive(frame.clone()).unwrap().events)
        .collect()
}
fn text(events: &[AgentEvent]) -> String {
    events
        .iter()
        .filter(|event| event.kind == "text" || event.kind == "note")
        .map(|event| event.text.as_str())
        .collect()
}

#[test]
fn parent_stream_excludes_subagent_transcripts_without_losing_final_suffix() {
    let events = events(&[
        json!({"type":"stream_event","event":{"type":"message_start","message":{"id":"main"}}}),
        json!({"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}}),
        json!({"type":"stream_event","parent_tool_use_id":"agent-tool","event":{"type":"message_start","message":{"id":"child"}}}),
        json!({"type":"stream_event","parent_tool_use_id":"agent-tool","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"PRIVATE CHILD"}}}),
        json!({"type":"assistant","parent_tool_use_id":"agent-tool","message":{"id":"child","content":[{"type":"text","text":"PRIVATE CHILD"},{"type":"tool_use","id":"nested","name":"Read","input":{}}]}}),
        json!({"type":"assistant","message":{"id":"main","content":[{"type":"text","text":"Hello world"}]}}),
    ]);
    assert_eq!(text(&events), "Hello world");
    assert_eq!(
        events
            .iter()
            .filter(|event| event.kind == "message_start")
            .count(),
        1
    );
    assert!(!events.iter().any(|event| event.kind == "tool"));
}

#[test]
fn completion_fallback_is_scoped_to_its_message_and_deduplicates_replays() {
    let complete = json!({"type":"assistant","message":{"id":"second","content":[{"type":"text","text":"Final response"}]}});
    let events = events(&[
        json!({"type":"stream_event","event":{"type":"message_start","message":{"id":"first"}}}),
        json!({"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Checking."}}}),
        json!({"type":"assistant","message":{"id":"first","content":[{"type":"text","text":"Checking."}]}}),
        complete.clone(),
        complete,
    ]);
    assert_eq!(text(&events), "Checking.Final response");
    let starts: Vec<_> = events
        .iter()
        .filter(|event| event.kind == "message_start")
        .map(|event| event.data.as_ref().unwrap()["messageId"].as_str().unwrap())
        .collect();
    assert_eq!(starts, ["first", "second"]);
}

#[test]
fn initial_text_and_multiple_content_blocks_reconcile_to_exact_final_text() {
    let final_message = json!({"type":"assistant","message":{"id":"main","content":[{"type":"text","text":"Hello, 🦀"},{"type":"text","text":"\nTail"}]}});
    let events = events(&[
        json!({"type":"stream_event","event":{"type":"message_start","message":{"id":"main"}}}),
        json!({"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":"Hello"}}}),
        json!({"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":", "}}}),
        json!({"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"🦀"}}}),
        final_message.clone(),
        final_message,
    ]);
    assert_eq!(text(&events), "Hello, 🦀\nTail");
    assert_eq!(
        events
            .iter()
            .filter(|event| event.kind == "message_start")
            .count(),
        1
    );
}

#[test]
fn cli_launch_enables_partial_stdout_events() {
    let mut command = tokio::process::Command::new("claude");
    super::configure_command(&mut command, &config("claude"));
    let args: Vec<_> = command
        .as_std()
        .get_args()
        .map(|arg| arg.to_string_lossy().to_string())
        .collect();
    assert!(args.iter().any(|arg| arg == "--include-partial-messages"));
    assert!(args
        .windows(2)
        .any(|args| args == ["--output-format", "stream-json"]));
    assert!(args.iter().any(|arg| arg == "--verbose"));
}

#[test]
fn child_permission_requests_still_reach_the_user_and_parent_tools_remain_visible() {
    let mut protocol = Protocol::new(config("claude"));
    let approval = protocol.receive(json!({"type":"control_request","request_id":"child-approval","parent_tool_use_id":"agent","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"git status"}}})).unwrap();
    assert_eq!(approval.events[0].kind, "approval");
    let parent_tool = protocol.receive(json!({"type":"assistant","message":{"id":"main","content":[{"type":"tool_use","id":"agent","name":"Agent","input":{"prompt":"Review"}}]}})).unwrap();
    assert_eq!(parent_tool.events[0].tool.as_ref().unwrap().name, "Agent");
    let result = protocol.receive(json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"agent","content":"Review complete"}]}})).unwrap();
    assert_eq!(
        result.events[0].tool.as_ref().unwrap().output,
        "Review complete"
    );
}

#[test]
fn final_result_recovers_a_missing_tail_without_repeating_streamed_text() {
    let events = events(&[
        json!({"type":"stream_event","event":{"type":"message_start","message":{"id":"main"}}}),
        json!({"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}}),
        json!({"type":"result","subtype":"success","result":"Hello world"}),
    ]);
    assert_eq!(text(&events), "Hello world");
    assert_eq!(
        events
            .iter()
            .filter(|event| event.kind == "message_start")
            .count(),
        1
    );
}
#[test]
fn cancelled_approval_notifies_its_original_ui_request() {
    let mut protocol = Protocol::new(config("claude"));
    let approval = protocol.receive(json!({"type":"control_request","request_id":"cancel-me","request":{"subtype":"can_use_tool","tool_name":"Read","input":{}}})).unwrap();
    let id = approval.events[0].request_id.clone();
    let cancelled = protocol
        .receive(json!({"type":"control_cancel_request","request_id":"cancel-me"}))
        .unwrap();
    assert_eq!(cancelled.events.len(), 1);
    assert_eq!(cancelled.events[0].kind, "approval_cancelled");
    assert_eq!(cancelled.events[0].request_id, id);
    assert!(protocol.pending.is_empty());
}

#[test]
fn app_instructions_ride_the_cached_system_prompt_not_every_message() {
    let args_for = |provider: &str, instructions: &str| -> Vec<String> {
        let mut config = config(provider);
        config.instructions = instructions.into();
        let mut command = tokio::process::Command::new(provider);
        super::configure_command(&mut command, &config);
        command.as_std().get_args().map(|arg| arg.to_string_lossy().to_string()).collect()
    };
    let args = args_for("claude", "Run and preview workflow: keep pandacode-run.sh current.");
    assert!(args.windows(2).any(|pair| pair == ["--append-system-prompt", "Run and preview workflow: keep pandacode-run.sh current."]));
    // Nothing to add, no flag; relays that wrap Claude Code take it the same way.
    assert!(!args_for("claude", "").iter().any(|arg| arg == "--append-system-prompt"));
    // Background waits need a session that outlives the turn; PandaCode's does not.
    assert!(args.iter().any(|arg| arg == "--disallowedTools=ScheduleWakeup,Monitor,CronCreate"));
    assert!(args_for("glm", "x").iter().any(|arg| arg == "--append-system-prompt"));
    assert!(super::takes_system_instructions("mimo"));
    assert!(!super::takes_system_instructions("codex"));
}

/// Frames recorded from Claude Code 2.1.308 (`-p --input-format stream-json
/// --replay-user-messages`, haiku) with a steer written to stdin as the first
/// turn ended: Claude answers it as a second turn of the same process.
#[test]
fn steer_written_as_the_turn_ends_runs_as_a_second_turn_of_the_same_run() {
    let mut protocol = Protocol::new(config("claude"));
    protocol.phase = 1;
    let (reply, _rx) = tokio::sync::oneshot::channel();
    protocol.steer("s1".into(), "Also append the word STEERED to your final reply.".into(), reply);
    let frames = [
        json!({"type":"user","isReplay":true,"session_id":"s","message":{"role":"user","content":"Reply with just the word DONE."}}),
        json!({"type":"assistant","session_id":"s","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"DONE"}]}}),
        json!({"type":"result","subtype":"success","is_error":false,"result":"DONE","session_id":"s"}),
        json!({"type":"system","subtype":"init","session_id":"s"}),
        json!({"type":"user","isReplay":true,"session_id":"s","message":{"role":"user","content":[{"type":"text","text":"Also append the word STEERED to your final reply."}]}}),
        json!({"type":"assistant","session_id":"s","message":{"id":"m2","role":"assistant","content":[{"type":"text","text":"DONE STEERED"}]}}),
        json!({"type":"result","subtype":"success","is_error":false,"result":"DONE STEERED","session_id":"s"}),
    ];
    let mut done = Vec::new();
    let mut delivered = 0;
    for frame in frames {
        let step = protocol.receive(frame).unwrap();
        delivered += step.events.iter().filter(|event| event.kind == "steer" && event.data.as_ref().unwrap()["status"] == "delivered").count();
        done.push(step.done);
    }
    assert_eq!(done, [false, false, false, false, false, false, true], "only the steered turn's result ends the run");
    assert_eq!(delivered, 1);
}

#[test]
fn thinking_deltas_surface_as_thinking_events() {
    let events = events(&[
        json!({"type":"stream_event","event":{"type":"message_start","message":{"id":"main"}}}),
        json!({"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}}),
        json!({"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Check the "}}}),
        json!({"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"tests."}}}),
        json!({"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Done"}}}),
    ]);
    let thinking: String = events.iter().filter(|e| e.kind == "thinking").map(|e| e.text.as_str()).collect();
    assert_eq!(thinking, "Check the tests.");
    assert_eq!(text(&events), "Done");
}

// Frames below are recorded from Claude Code 2.1.317 (`-p --input-format stream-json
// --replay-user-messages`, haiku), trimmed to the fields PandaCode reads.
const SESSION: &str = "e7b99c90-d1ab-4918-bb0f-cca55c156547";
const AGENT_TOOL: &str = "toolu_01QcnBrfVFeGUfP9zZ57gih3";
const AGENT_TASK: &str = "a7454d677a51b568a";

fn tasks(tasks: Value) -> Value {
    json!({"type":"system","subtype":"background_tasks_changed","tasks":tasks,"session_id":SESSION})
}
fn agent_listed() -> Value {
    tasks(json!([{"task_id":AGENT_TASK,"run_id":"0mw0lwebe-a48ca1f2","task_type":"local_agent","subagent_type":"general-purpose","description":"bg"}]))
}
fn reply(id: &str, text: &str) -> Value {
    json!({"type":"assistant","message":{"id":id,"role":"assistant","content":[{"type":"text","text":text}]},"session_id":SESSION,"parent_tool_use_id":null})
}
fn result(text: &str) -> Value {
    json!({"type":"result","subtype":"success","is_error":false,"result":text,"stop_reason":"end_turn","session_id":SESSION})
}
fn launch() -> [Value; 4] {
    [
        json!({"type":"assistant","message":{"id":"m1","role":"assistant","content":[{"type":"tool_use","id":AGENT_TOOL,"name":"Agent","input":{"description":"bg","prompt":"Run sleep 20, reply BAR","run_in_background":true}}]},"session_id":SESSION,"parent_tool_use_id":null}),
        agent_listed(),
        json!({"type":"system","subtype":"task_started","task_id":AGENT_TASK,"tool_use_id":AGENT_TOOL,"description":"bg","subagent_type":"general-purpose","is_backgrounded":true,"spawn_depth":1,"task_type":"local_agent","session_id":SESSION}),
        json!({"type":"user","message":{"role":"user","content":[{"tool_use_id":AGENT_TOOL,"type":"tool_result","content":[{"type":"text","text":"Async agent launched successfully."}]}]},"session_id":SESSION,"parent_tool_use_id":null}),
    ]
}
fn agent_settled() -> [Value; 3] {
    [
        json!({"type":"system","subtype":"task_updated","task_id":AGENT_TASK,"patch":{"status":"completed","end_time":1793705464063_u64},"session_id":SESSION}),
        json!({"type":"system","subtype":"task_notification","task_id":AGENT_TASK,"tool_use_id":AGENT_TOOL,"status":"completed","summary":"BAR","session_id":SESSION}),
        tasks(json!([])),
    ]
}
fn init() -> Value {
    json!({"type":"system","subtype":"init","cwd":"/private/tmp/pc-capture","session_id":SESSION})
}
fn running(protocol: &mut Protocol, frames: impl IntoIterator<Item = Value>) -> Vec<super::Step> {
    frames.into_iter().map(|frame| protocol.receive(frame).unwrap()).collect()
}
fn child_status(events: &[AgentEvent], id: &str) -> Option<String> {
    events
        .iter()
        .rev()
        .filter(|event| event.kind == "subagent")
        .filter_map(|event| event.data.as_ref())
        .find(|data| data["id"] == id)
        .map(|data| data["status"].as_str().unwrap().to_owned())
}
/// A run past its prompt's echo.
fn open(provider: &str) -> Protocol {
    let mut protocol = Protocol::new(config(provider));
    protocol.phase = 1;
    protocol.prompt_replayed = true;
    protocol.subagents.as_mut().unwrap().send_every_snapshot();
    protocol
}

/// bg.log: `result` at 7 s, the child runs, a new parent turn, a second `result` at 42 s.
#[test]
fn the_run_stays_open_for_a_background_agent_and_ends_with_its_hand_back_turn() {
    let mut protocol = open("claude");
    let launched = running(&mut protocol, launch());
    assert_eq!(child_status(&launched.iter().flat_map(|step| step.events.clone()).collect::<Vec<_>>(), AGENT_TOOL).as_deref(), Some("running"), "the launch result does not settle it");
    let first = running(&mut protocol, [reply("m2", "LAUNCHED"), result("LAUNCHED")]);
    assert!(!first[1].done, "the first result keeps the run open while the agent runs");
    assert!(protocol.claude_grace().is_none(), "a running agent holds the run for as long as it runs");
    let settled = running(&mut protocol, agent_settled());
    assert_eq!(child_status(&settled[0].events, AGENT_TOOL).as_deref(), Some("completed"), "task_updated has no tool_use_id");
    assert!(protocol.claude_grace().is_some());
    let hand_back = running(&mut protocol, [init(), reply("m3", "GOT")]);
    assert!(protocol.claude_grace().is_none(), "the new turn took the hand-back");
    let last = protocol.receive(result("GOT")).unwrap();
    assert!(last.done, "the hand-back turn's result ends the run");
    let replies: Vec<_> = first.iter().chain(&hand_back).flat_map(|step| step.events.iter()).filter(|event| event.kind == "text").map(|event| event.text.as_str()).collect();
    assert_eq!(replies, ["LAUNCHED", "GOT"]);
    let turns = first.iter().chain(&hand_back).flat_map(|step| step.events.iter()).filter(|event| event.kind == "message_start").count();
    assert_eq!(turns, 2, "the later turn is its own saved reply");
}

/// bash.log: the CLI lists it in `background_tasks_changed`, and even wakes for it later.
#[test]
fn a_background_command_never_holds_the_run() {
    let mut protocol = open("claude");
    let listed = tasks(json!([{"task_id":"bhe85a3pb","run_id":"0mw0m233i-f04a52ed","task_type":"local_bash","description":"Sleep 30 seconds in background"}]));
    protocol.receive(listed).unwrap();
    protocol.receive(json!({"type":"system","subtype":"task_started","task_id":"bhe85a3pb","tool_use_id":"toolu_01Pe1EfccUVRhY2MsAT9sE5j","description":"Sleep 30 seconds in background","is_backgrounded":true,"task_type":"local_bash"})).unwrap();
    assert!(protocol.receive(result("LAUNCHED")).unwrap().done);
}

/// race.log: the agent settles at 7.8 s while the parent is still answering; the parent's
/// `result` at 10.5 s has not taken it, and another turn starts 0.1 s later.
#[test]
fn an_agent_settling_mid_turn_waits_for_the_following_turn() {
    let mut protocol = open("claude");
    running(&mut protocol, launch());
    running(&mut protocol, agent_settled());
    protocol.receive(reply("m2", "Step 1 ran")).unwrap();
    assert!(!protocol.receive(result("Step 1 ran")).unwrap().done, "the hand-back turn is still to come");
    assert!(protocol.claude_grace().is_some(), "but it may not come, so the wait is bounded");
    running(&mut protocol, [init(), reply("m3", "GOT")]);
    assert!(protocol.receive(result("GOT")).unwrap().done);
}

/// race2.log: settled at 9.2 s and taken in the same turn at a tool boundary at 11.8 s:
/// replayed as a user message, with one `result` at 16.2 s and no later turn.
#[test]
fn an_agent_handed_back_inside_the_turn_finishes_with_that_turn() {
    let mut protocol = open("claude");
    let (reply_tx, _rx) = tokio::sync::oneshot::channel();
    protocol.receive(json!({"type":"user","isReplay":true,"message":{"role":"user","content":[{"type":"text","text":"prompt"}]}})).unwrap();
    running(&mut protocol, launch());
    running(&mut protocol, agent_settled());
    protocol.steer("s1".into(), "steer".into(), reply_tx);
    let taken = protocol.receive(json!({"type":"user","message":{"role":"user","content":format!("<task-notification>\n<task-id>{AGENT_TASK}</task-id>\n<tool-use-id>{AGENT_TOOL}</tool-use-id>\n<status>completed</status>\n<summary>Agent \"bg\" finished</summary>\n<result>BAR</result>\n</task-notification>")},"session_id":SESSION,"parent_tool_use_id":null,"isReplay":true,"origin":{"kind":"task-notification","producer":"session-task"}})).unwrap();
    assert!(!taken.events.iter().any(|event| event.kind == "steer"), "a hand-back is not the steer's echo");
    protocol.receive(json!({"type":"user","isReplay":true,"message":{"role":"user","content":[{"type":"text","text":"steer"}]}})).unwrap();
    assert!(protocol.receive(result("The background agent finished")).unwrap().done);
}

#[test]
fn a_following_turn_that_never_comes_ends_the_run_cleanly_after_the_grace() {
    let mut protocol = open("claude");
    running(&mut protocol, launch());
    protocol.receive(result("LAUNCHED")).unwrap();
    running(&mut protocol, agent_settled());
    assert!(protocol.claude_idle() && protocol.claude_grace().is_some());
    let end = protocol.claude_end_idle();
    assert!(end.done && end.failure.is_none());
    assert!(text(&end.events).contains("The report from \"bg\" did not reach the agent"), "the loss is said, not silent");
    assert!(protocol.claude_grace().is_none());
}

#[test]
fn a_process_that_dies_with_agents_running_says_whose_reports_were_lost() {
    let mut protocol = open("claude");
    running(&mut protocol, launch());
    protocol.receive(result("LAUNCHED")).unwrap();
    assert!(protocol.claude_idle(), "the run loop treats this EOF as a clean end");
    let end = protocol.claude_end_idle();
    assert!(end.done && text(&end.events).contains("\"bg\""));
}

// three.log: three agents; the CLI runs one turn per hand-back, and each `result` names its task.
const RUN_A: &str = "0mw0njaoj-4b07677a";
const RUN_B: &str = "0mw0njaw7-f19f2711";
const RUN_C: &str = "0mw0njb6a-cea0b522";
fn listed(agents: &[(&str, &str)]) -> Value {
    tasks(agents.iter().map(|(name, run)| json!({"task_id":format!("task-{name}"),"run_id":run,"task_type":"local_agent","subagent_type":"general-purpose","description":name})).collect())
}
fn hand_back_result(run: &str) -> Value {
    json!({"type":"result","subtype":"success","is_error":false,"result":"GOT","stop_reason":"end_turn","session_id":SESSION,"origin":{"kind":"task-notification","producer":"session-task","runId":run}})
}

/// 7.5/7.6 s: b and a settle while idle. `init` 7.7, `result` 8.9, `init` 9.0, `result` 10.0;
/// c settles at 10.4, `init` 10.6, `result` 12.1.
#[test]
fn one_hand_back_turn_runs_per_agent_and_the_run_waits_for_every_one() {
    let mut protocol = open("claude");
    let all = [("a", RUN_A), ("b", RUN_B), ("c", RUN_C)];
    protocol.receive(listed(&all)).unwrap();
    assert!(!protocol.receive(result("LAUNCHED")).unwrap().done);
    protocol.receive(listed(&[("a", RUN_A), ("c", RUN_C)])).unwrap();
    protocol.receive(listed(&[("c", RUN_C)])).unwrap();
    running(&mut protocol, [init(), reply("m1", "GOT")]);
    assert!(!protocol.receive(hand_back_result(RUN_B)).unwrap().done, "a's hand-back and c are still to come");
    running(&mut protocol, [init(), reply("m2", "GOT")]);
    assert!(!protocol.receive(hand_back_result(RUN_A)).unwrap().done, "c is still running");
    assert!(protocol.claude_grace().is_none(), "a running agent waits without a clock");
    protocol.receive(listed(&[])).unwrap();
    assert!(protocol.claude_grace().is_some());
    running(&mut protocol, [init(), reply("m3", "GOT")]);
    assert!(protocol.receive(hand_back_result(RUN_C)).unwrap().done);
}

/// b and c settle during T2's model call: T2 took a, so two more turns are owed. Without
/// `origin` (a CLI that doesn't send it) each turn takes the oldest entry.
#[test]
fn agents_settling_during_a_hand_back_turn_each_get_their_own_turn() {
    for named in [true, false] {
        let end = |run: &str| if named { hand_back_result(run) } else { result("GOT") };
        let mut protocol = open("claude");
        protocol.receive(listed(&[("a", RUN_A), ("b", RUN_B), ("c", RUN_C)])).unwrap();
        protocol.receive(result("LAUNCHED")).unwrap();
        protocol.receive(listed(&[("b", RUN_B), ("c", RUN_C)])).unwrap();
        running(&mut protocol, [init(), reply("m1", "GOT")]);
        protocol.receive(listed(&[("c", RUN_C)])).unwrap();
        protocol.receive(listed(&[])).unwrap();
        assert!(protocol.claude_grace().is_none(), "the turn is running");
        assert!(!protocol.receive(end(RUN_A)).unwrap().done, "b's and c's turns are owed");
        assert!(protocol.claude_grace().is_some());
        running(&mut protocol, [init(), reply("m2", "GOT")]);
        assert!(!protocol.receive(end(RUN_B)).unwrap().done, "c's turn is owed");
        running(&mut protocol, [init(), reply("m3", "GOT")]);
        assert!(protocol.receive(end(RUN_C)).unwrap().done);
    }
}

/// bash.log's second `result`: a background command wakes a turn that takes no agent's report.
#[test]
fn a_turn_for_a_background_command_or_a_steer_takes_no_agent_report() {
    let mut protocol = open("claude");
    protocol.receive(listed(&[("a", RUN_A)])).unwrap();
    protocol.receive(listed(&[])).unwrap();
    assert!(!protocol.receive(result("first")).unwrap().done);
    running(&mut protocol, [init(), reply("m1", "GOT")]);
    assert!(!protocol.receive(hand_back_result("0mw0m233i-f04a52ed")).unwrap().done, "a's report is still owed");
    let (answer, _rx) = tokio::sync::oneshot::channel();
    protocol.steer("s1".into(), "steer".into(), answer);
    running(&mut protocol, [init(), json!({"type":"user","isReplay":true,"message":{"role":"user","content":[{"type":"text","text":"steer"}]}}), reply("m2", "ok")]);
    assert!(!protocol.receive(result("ok")).unwrap().done, "a steer's turn took nothing either");
    running(&mut protocol, [init(), reply("m3", "GOT")]);
    assert!(protocol.receive(hand_back_result(RUN_A)).unwrap().done);
}

// r2.log: Claude Code 2.1.317 resumed after its last process left a background command behind.
fn leftover_notification() -> Value {
    json!({"type":"system","subtype":"task_notification","task_id":"bkxtb3hvz","tool_use_id":"toolu_01FpT5a29fd39K8hE4FcG5Yy","status":"stopped","output_file":"","summary":"Background shell command didn't finish before the session ended","session_id":SESSION})
}
fn leftover_result() -> Value {
    json!({"type":"result","subtype":"success","is_error":false,"duration_api_ms":0,"num_turns":0,"result":"","stop_reason":null,"session_id":SESSION,"total_cost_usd":0,"modelUsage":{},"origin":{"kind":"task-notification"}})
}
fn resumed_with_prompt_written() -> Protocol {
    let mut protocol = Protocol::new(config("claude"));
    protocol.receive(leftover_notification()).unwrap();
    let started = protocol.receive(json!({"type":"control_response","response":{"subtype":"success","request_id":"pandacode-init","response":{}}})).unwrap();
    assert!(started.write.iter().any(|frame| frame["type"] == "user"), "the prompt is written");
    protocol
}

/// 5.19 s: `init`, then an empty `result` for the leftover. 5.52 s: `init`. 7.88 s: the prompt's
/// echo. 7.96 s: its `result`. Ending at the first one closed the process with the answer in
/// flight, and the turn settled as finished with no reply (session d51fbaa9, message 326221).
#[test]
fn a_leftover_notification_result_does_not_end_the_run_before_the_prompt_is_answered() {
    let mut protocol = resumed_with_prompt_written();
    protocol.receive(init()).unwrap();
    assert!(!protocol.receive(leftover_result()).unwrap().done, "the prompt has not been taken");
    assert!(protocol.claude_grace().is_some(), "the wait is bounded");
    protocol.receive(init()).unwrap();
    assert!(protocol.claude_grace().is_none(), "the prompt's turn began");
    protocol.receive(json!({"type":"user","isReplay":true,"session_id":SESSION,"parent_tool_use_id":null,"message":{"role":"user","content":"Explain this project"}})).unwrap();
    let answered = protocol.receive(reply("m1", "ANSWERED")).unwrap();
    assert_eq!(text(&answered.events), "ANSWERED");
    assert!(protocol.receive(json!({"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"ANSWERED","stop_reason":"end_turn","session_id":SESSION})).unwrap().done);
}

const BATCH_AGENT_RUN: &str = "0mw0xkeh3-e71bf11c";
const BATCH_SHELL_RUN: &str = "0mw0xkf4i-28e2adea";
/// batch2.log: a background agent and the main agent's own background Bash both end during the
/// turn, agent first, and Claude Code merges their notifications.
fn batched_turn() -> [Value; 7] {
    let agent = json!({"task_id":"aee8efb075ceb8904","run_id":BATCH_AGENT_RUN,"task_type":"local_agent","subagent_type":"general-purpose","description":"a"});
    let shell = json!({"task_id":"bh6crv2jo","run_id":BATCH_SHELL_RUN,"task_type":"local_bash","description":"Sleep 11 seconds then echo S"});
    [
        init(),
        tasks(json!([agent])),
        tasks(json!([agent, shell])),
        json!({"type":"system","subtype":"task_notification","task_id":"aee8efb075ceb8904","run_id":BATCH_AGENT_RUN,"status":"completed","session_id":SESSION}),
        tasks(json!([shell])),
        json!({"type":"system","subtype":"task_notification","task_id":"bh6crv2jo","run_id":BATCH_SHELL_RUN,"status":"completed","session_id":SESSION}),
        tasks(json!([])),
    ]
}
fn empty_notification(run: &str) -> Value {
    json!({"type":"result","subtype":"success","is_error":false,"result":"","num_turns":0,"duration_ms":33,"origin":{"kind":"task-notification","producer":"session-task","runId":run},"session_id":SESSION})
}

/// Recorded: the opening `result` (turns 3); 52.30 s an empty `result` for the agent's run (turns
/// 0); 54.51 s `result` "GOT" for the shell's run (turns 1), the real hand-back. Ending at the
/// empty one killed the process about 2 s before the report, with no note.
#[test]
fn an_empty_batched_notification_keeps_the_run_open_for_the_real_hand_back() {
    let mut protocol = Protocol::new(config("claude"));
    protocol.phase = 1;
    let mut steps = running(&mut protocol, batched_turn());
    steps.extend(running(&mut protocol, [reply("m1", "1\n2\n3")]));
    assert!(!protocol.receive(json!({"type":"result","subtype":"success","is_error":false,"result":"1\n2\n3","num_turns":3,"session_id":SESSION})).unwrap().done);
    protocol.receive(init()).unwrap();

    let empty = protocol.receive(empty_notification(BATCH_AGENT_RUN)).unwrap();
    assert!(!empty.done, "the turn that answers both is on its way");
    assert!(protocol.steers.settled.is_empty(), "the agent was named, so nothing is lost if none comes");
    assert!(wait_left(&protocol) <= SHORT_WAIT, "the ordinary turn grace");

    steps.extend(running(&mut protocol, [init(), reply("m2", "GOT")]));
    assert!(protocol.claude_grace().is_none(), "the turn began");
    let last = protocol.receive(notified(BATCH_SHELL_RUN, "GOT")).unwrap();
    assert!(last.done, "the real hand-back ends the run");
    let all: Vec<_> = steps.into_iter().chain([empty, last]).flat_map(|step| step.events).collect();
    assert!(text(&all).contains("GOT"));
    assert!(!text(&all).contains("did not reach"), "{}", text(&all));
}

/// A shell killed with its process owes nothing, so the empty `result` costs the grace at most
/// and the run ends cleanly, with no lost report and no failure.
#[test]
fn an_empty_notification_with_no_turn_after_it_ends_cleanly_at_the_grace() {
    let mut protocol = Protocol::new(config("claude"));
    protocol.phase = 1;
    let agent = json!({"task_id":"aee8efb075ceb8904","run_id":BATCH_AGENT_RUN,"task_type":"local_agent","description":"a"});
    running(&mut protocol, [init(), tasks(json!([agent])), tasks(json!([])), reply("m1", "Started.")]);
    assert!(!protocol.receive(result("Started.")).unwrap().done);
    protocol.receive(init()).unwrap();
    let empty = protocol.receive(empty_notification(BATCH_AGENT_RUN)).unwrap();
    assert!(!empty.done);
    assert!(wait_left(&protocol) <= SHORT_WAIT);
    let end = protocol.claude_wait_over();
    assert!(end.done && end.failure.is_none() && end.write.is_empty());
    assert!(!text(&end.events).contains("did not reach"), "{}", text(&end.events));
}

/// The other empty shape, before the prompt's echo, keeps its own long wait and ends with the
/// prompt's `result`, so the promise adds nothing there.
#[test]
fn an_empty_notification_before_the_prompt_is_not_delayed_by_the_batch_wait() {
    let mut protocol = resumed_with_prompt_written();
    protocol.receive(leftover_result()).unwrap();
    assert!(wait_left(&protocol) > SHORT_WAIT, "the wait for the prompt, as before");
    running(&mut protocol, [init(), json!({"type":"user","isReplay":true,"session_id":SESSION,"parent_tool_use_id":null,"message":{"role":"user","content":"Explain this project"}}), reply("m1", "ANSWERED")]);
    assert!(protocol.receive(json!({"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"ANSWERED","session_id":SESSION})).unwrap().done);
}

/// One replayed message can carry several notifications, each naming its task.
#[test]
fn a_notification_message_settles_every_task_it_names() {
    let mut protocol = Protocol::new(config("claude"));
    protocol.phase = 1;
    let agent = |id: &str| json!({"task_id":id,"run_id":format!("run-{id}"),"task_type":"local_agent","description":id});
    running(&mut protocol, [init(), tasks(json!([agent("a"), agent("b")])), tasks(json!([]))]);
    assert_eq!(protocol.steers.settled.len(), 2);
    protocol.receive(json!({"type":"user","isReplay":true,"session_id":SESSION,"parent_tool_use_id":null,"message":{"role":"user","content":[{"type":"text","text":"<task-notification><task-id>a</task-id><summary>A</summary></task-notification>\n<task-notification><task-id>b</task-id><summary>B</summary></task-notification>"}]}})).unwrap();
    assert!(protocol.steers.settled.is_empty());
    assert!(protocol.receive(result("Both in.")).unwrap().done);
}

#[test]
fn a_prompt_never_taken_after_a_leftover_fails_rather_than_finishing_with_no_reply() {
    let mut protocol = resumed_with_prompt_written();
    protocol.receive(leftover_result()).unwrap();
    let end = protocol.claude_end_idle();
    assert!(end.done);
    assert!(end.failure.as_deref().is_some_and(|error| error.contains("never took this message")));
}

/// s_compact.log and s_context.log: a local command neither echoes nor names an origin.
#[test]
fn a_local_slash_command_without_an_echo_still_ends_the_run_at_once() {
    let mut protocol = Protocol::new(config("claude"));
    protocol.receive(json!({"type":"control_response","response":{"subtype":"success","request_id":"pandacode-init","response":{}}})).unwrap();
    protocol.receive(init()).unwrap();
    protocol.receive(json!({"type":"assistant","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"Not enough messages to compact."}]},"session_id":SESSION,"parent_tool_use_id":null})).unwrap();
    assert!(protocol.receive(json!({"type":"result","subtype":"success","is_error":false,"duration_api_ms":0,"num_turns":0,"result":"Not enough messages to compact.","stop_reason":null,"session_id":SESSION})).unwrap().done);
}

fn wait_left(protocol: &Protocol) -> std::time::Duration {
    protocol.claude_grace().expect("a bounded wait").saturating_duration_since(tokio::time::Instant::now())
}
const QUARTER_HOUR: std::time::Duration = std::time::Duration::from_secs(15 * 60);

/// r_hook.log: a plain prompt with a `sleep 15` UserPromptSubmit hook, resumed after a leftover.
/// 0.30 s: the leftover's `result`. 15.32 s: `init` (15.02 s later). 17.20 s: echo and answer.
/// A 10 s limit failed this turn, killed the process and counted against the model's health.
#[test]
fn a_slow_prompt_hook_after_a_leftover_is_waited_out_and_answered() {
    let mut protocol = resumed_with_prompt_written();
    protocol.receive(init()).unwrap();
    assert!(!protocol.receive(leftover_result()).unwrap().done);
    assert!(wait_left(&protocol) > QUARTER_HOUR - std::time::Duration::from_secs(5), "outlasts any hook, not just the recorded 15.02 s");
    protocol.receive(init()).unwrap();
    assert!(protocol.claude_grace().is_none());
    protocol.receive(json!({"type":"system","subtype":"status","status":"requesting","session_id":SESSION})).unwrap();
    protocol.receive(json!({"type":"user","isReplay":true,"session_id":SESSION,"parent_tool_use_id":null,"message":{"role":"user","content":"Reply with exactly the word ANSWERED."}})).unwrap();
    assert_eq!(text(&protocol.receive(reply("msg_011Cgg7TWBbjGWwz8arnGyda", "ANSWERED")).unwrap().events), "ANSWERED");
    let end = protocol.receive(json!({"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"ANSWERED","stop_reason":"end_turn","terminal_reason":"completed","session_id":SESSION})).unwrap();
    assert!(end.done && end.failure.is_none());
}

/// r_cost.log (/cost): 0.32 s the leftover's `result`, 12.69 s (12.37 s later) `init`, a synthetic
/// reply and a `result` with no echo and no origin. r_compact.log has the same shape at 10.93 s.
#[test]
fn a_slow_local_command_after_a_leftover_ends_the_run_without_a_failure() {
    let mut protocol = resumed_with_prompt_written();
    protocol.receive(init()).unwrap();
    assert!(!protocol.receive(leftover_result()).unwrap().done);
    assert!(wait_left(&protocol) > QUARTER_HOUR - std::time::Duration::from_secs(5));
    protocol.receive(init()).unwrap();
    assert!(protocol.claude_grace().is_none());
    let usage = "You are currently using your subscription to power your Claude Code usage";
    let shown = protocol.receive(json!({"type":"assistant","message":{"id":"9d62679f-0eaf-4d20-861c-f60b729332cc","model":"<synthetic>","role":"assistant","type":"message","stop_reason":"end_turn","content":[{"type":"text","text":usage}]},"session_id":SESSION,"parent_tool_use_id":null})).unwrap();
    assert_eq!(text(&shown.events), usage);
    let end = protocol.receive(json!({"type":"result","subtype":"success","is_error":false,"duration_api_ms":0,"num_turns":0,"result":usage,"stop_reason":null,"session_id":SESSION})).unwrap();
    assert!(end.done && end.failure.is_none());
    assert!(protocol.claude_grace().is_none());
}

/// A settled agent keeps the short wait, and takes the long one only while input is owed too.
#[test]
fn only_input_gets_the_long_wait_and_a_settled_agent_keeps_ten_seconds() {
    let mut protocol = open("claude");
    protocol.receive(listed(&[("a", RUN_A)])).unwrap();
    protocol.receive(listed(&[])).unwrap();
    assert!(!protocol.receive(result("first")).unwrap().done);
    assert!(wait_left(&protocol) <= std::time::Duration::from_secs(10));
    let (answer, _rx) = tokio::sync::oneshot::channel();
    protocol.steer("s1".into(), "late".into(), answer);
    assert!(wait_left(&protocol) > QUARTER_HOUR - std::time::Duration::from_secs(5), "a hook may delay the steer's turn");
    running(&mut protocol, [init(), json!({"type":"user","isReplay":true,"message":{"role":"user","content":[{"type":"text","text":"late"}]}}), reply("m1", "ok")]);
    assert!(!protocol.receive(result("ok")).unwrap().done, "the agent's report is still owed");
    assert!(wait_left(&protocol) <= std::time::Duration::from_secs(10), "the steer was taken, so the short wait is back");
}

/// A steer Claude has not echoed when its turn ends gets the same long wait as the prompt.
#[test]
fn a_late_unechoed_steer_waits_as_long_as_a_prompt() {
    let mut protocol = open("claude");
    let (answer, _rx) = tokio::sync::oneshot::channel();
    protocol.steer("s1".into(), "steer".into(), answer);
    assert!(!protocol.receive(result("first")).unwrap().done);
    assert!(wait_left(&protocol) > QUARTER_HOUR - std::time::Duration::from_secs(5));
}

/// The bridge polls with a backoff up to 30 s, so a blip must not end a healthy cloud run.
#[test]
fn the_cloud_bridge_gets_a_longer_wait_for_a_settled_agent() {
    let mut protocol = open("claude");
    protocol.claude_over_cloud();
    protocol.receive(listed(&[("a", RUN_A)])).unwrap();
    protocol.receive(listed(&[])).unwrap();
    assert!(!protocol.receive(result("first")).unwrap().done);
    assert!(wait_left(&protocol) > std::time::Duration::from_secs(60));
}

/// The recorded end is task_updated, task_notification, then the list (c_bg.log, 10.40 s).
fn agent_ended(task: &str, run: &str) -> Value {
    json!({"type":"system","subtype":"task_notification","task_id":task,"run_id":run,"tool_use_id":format!("tool-{task}"),"status":"completed","summary":"BAR"})
}
fn agent_started(task: &str, run: &str) -> Value {
    json!({"type":"system","subtype":"task_started","task_id":task,"run_id":run,"tool_use_id":format!("tool-{task}"),"description":"bg","is_backgrounded":true,"task_type":"local_agent"})
}

#[test]
fn an_agents_end_without_the_list_still_lets_the_run_finish() {
    let mut protocol = open("claude");
    protocol.receive(listed(&[("a", RUN_A)])).unwrap();
    assert!(!protocol.receive(result("LAUNCHED")).unwrap().done);
    assert!(protocol.claude_grace().is_none(), "it runs");
    protocol.receive(agent_ended("task-a", RUN_A)).unwrap();
    assert!(protocol.claude_grace().is_some(), "it settled though no list came");
    protocol.receive(init()).unwrap();
    assert!(protocol.receive(hand_back_result(RUN_A)).unwrap().done);
}

#[test]
fn the_list_following_an_agents_end_changes_nothing() {
    let mut protocol = open("claude");
    protocol.receive(listed(&[("a", RUN_A), ("b", RUN_B)])).unwrap();
    assert!(!protocol.receive(result("LAUNCHED")).unwrap().done);
    protocol.receive(json!({"type":"system","subtype":"task_updated","task_id":"task-a","run_id":RUN_A,"patch":{"status":"completed"}})).unwrap();
    protocol.receive(agent_ended("task-a", RUN_A)).unwrap();
    assert_eq!(protocol.steers.settled.len(), 1, "the update and the notification are one end");
    protocol.receive(listed(&[("b", RUN_B)])).unwrap();
    assert_eq!(protocol.steers.settled.len(), 1);
    protocol.receive(init()).unwrap();
    assert!(!protocol.receive(hand_back_result(RUN_A)).unwrap().done, "b still runs");
    protocol.receive(listed(&[])).unwrap();
    protocol.receive(init()).unwrap();
    assert!(protocol.receive(hand_back_result(RUN_B)).unwrap().done, "a was counted once");
}

/// `task_updated` also carries patches that are no end: only a final status settles the agent.
#[test]
fn a_task_update_that_is_not_an_end_keeps_the_agent_running() {
    let mut protocol = open("claude");
    protocol.receive(listed(&[("a", RUN_A)])).unwrap();
    assert!(!protocol.receive(result("LAUNCHED")).unwrap().done);
    for patch in [json!({"status":"running"}), json!({"is_backgrounded":true})] {
        protocol.receive(json!({"type":"system","subtype":"task_updated","task_id":"task-a","patch":patch})).unwrap();
        assert!(protocol.claude_grace().is_none());
    }
}

#[test]
fn a_cli_without_the_list_registers_background_agents_from_their_start() {
    let mut protocol = open("claude");
    protocol.receive(agent_started("a", RUN_A)).unwrap();
    protocol.receive(agent_started("b", RUN_B)).unwrap();
    protocol.receive(json!({"type":"system","subtype":"task_started","task_id":"fg","task_type":"local_agent","is_backgrounded":false})).unwrap();
    protocol.receive(json!({"type":"system","subtype":"task_started","task_id":"sh","task_type":"local_bash","is_backgrounded":true})).unwrap();
    assert!(!protocol.receive(result("LAUNCHED")).unwrap().done, "they hold the run");
    assert!(protocol.claude_grace().is_none());
    protocol.receive(agent_ended("a", RUN_A)).unwrap();
    assert!(protocol.claude_grace().is_none(), "b still runs");
    protocol.receive(init()).unwrap();
    assert!(!protocol.receive(hand_back_result(RUN_A)).unwrap().done);
    protocol.receive(agent_ended("b", RUN_B)).unwrap();
    protocol.receive(init()).unwrap();
    assert!(protocol.receive(hand_back_result(RUN_B)).unwrap().done);
}

/// Recorded order: the list, then `task_started`, which must not register the agent twice.
#[test]
fn a_start_after_the_list_does_not_count_the_agent_twice() {
    let mut protocol = open("claude");
    protocol.receive(listed(&[("a", RUN_A)])).unwrap();
    protocol.receive(agent_started("task-a", RUN_A)).unwrap();
    assert_eq!(protocol.steers.agents.len(), 1);
    protocol.receive(listed(&[])).unwrap();
    assert!(!protocol.receive(result("LAUNCHED")).unwrap().done);
    protocol.receive(init()).unwrap();
    assert!(protocol.receive(hand_back_result(RUN_A)).unwrap().done);
}

/// A turn for a prompt the CLI is slow to take: the whole long wait must stay stoppable.
#[tokio::test]
async fn stop_ends_the_long_wait_for_an_owed_prompt_at_once() {
    use std::sync::Arc;
    let (sender, receiver) = tokio::sync::mpsc::unbounded_channel();
    let mut command = tokio::process::Command::new("sh");
    let frames = format!("{}\n{}\n", json!({"type":"control_response","response":{"subtype":"success","request_id":"pandacode-init","response":{}}}), leftover_result());
    command.args(["-c", "read _; printf '%s' \"$0\"; read _; sleep 120", &frames]);
    let seen = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let events = seen.clone();
    let sink: super::Sink = Arc::new(move |event: AgentEvent| events.lock().unwrap().push(event.kind));
    let run = tokio::spawn(super::run_process(config("claude"), sink, receiver, command, Vec::new()));
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    let started = std::time::Instant::now();
    sender.send(super::RunInput::Stop).unwrap();
    let outcome = tokio::time::timeout(std::time::Duration::from_secs(10), run).await.expect("Stop ended the wait").unwrap();
    assert!(started.elapsed() < std::time::Duration::from_secs(5), "{:?}", started.elapsed());
    outcome.unwrap();
    assert!(!seen.lock().unwrap().iter().any(|kind| kind == "error"), "a stop is no failure");
}

/// A background agent settling during the prompt's turn keeps its own hand-back after a leftover.
#[test]
fn the_prompts_turn_after_a_leftover_does_not_take_an_agents_report() {
    let mut protocol = resumed_with_prompt_written();
    protocol.receive(leftover_result()).unwrap();
    protocol.receive(init()).unwrap();
    protocol.receive(json!({"type":"user","isReplay":true,"message":{"role":"user","content":"Explain this project"}})).unwrap();
    protocol.receive(listed(&[("a", RUN_A)])).unwrap();
    protocol.receive(listed(&[])).unwrap();
    assert!(!protocol.receive(result("first")).unwrap().done, "a's hand-back is owed");
    protocol.receive(init()).unwrap();
    assert!(protocol.receive(hand_back_result(RUN_A)).unwrap().done);
}

/// Task types in the 2.1.317 binary: agents and workflows report back and end on their own.
#[test]
fn only_agents_and_workflows_hold_the_run() {
    for task_type in ["local_agent", "remote_agent", "local_workflow"] {
        assert!(super::steering::holds_run(task_type), "{task_type}");
    }
    for task_type in ["local_bash", "monitor", "monitor_mcp", "monitor_ws", "in_process_teammate", "dream", "post_turn_memory", "mcp_task", "something_new", ""] {
        let mut protocol = open("claude");
        protocol.receive(tasks(json!([{"task_id":"t","run_id":"r","task_type":task_type,"description":"x"}]))).unwrap();
        assert!(protocol.receive(result("ok")).unwrap().done, "{task_type} must not hold the run");
    }
}

#[test]
fn a_steer_never_echoed_is_bounded_and_reported_failed_once() {
    let mut protocol = open("claude");
    let (reply, _rx) = tokio::sync::oneshot::channel();
    protocol.steer("s1".into(), "urgent".into(), reply);
    assert!(!protocol.claude_idle());
    assert!(!protocol.receive(result("done")).unwrap().done);
    let deadline = protocol.claude_grace().expect("bounded");
    let end = protocol.claude_end_idle();
    assert!(end.done);
    assert_eq!(end.events.len(), 1);
    assert_eq!(end.events[0].data.as_ref().unwrap()["status"], "failed");
    assert!(protocol.steers_ended(true).is_empty(), "a clean end must not call it delivered");
    assert!(deadline > tokio::time::Instant::now());
}

#[test]
fn a_steer_during_the_wait_for_an_agent_is_not_timed_until_the_agent_ends() {
    let mut protocol = open("claude");
    running(&mut protocol, launch());
    protocol.receive(result("LAUNCHED")).unwrap();
    let (answer, _rx) = tokio::sync::oneshot::channel();
    protocol.steer("s1".into(), "look at the tests too".into(), answer);
    assert!(protocol.claude_grace().is_none());
    running(&mut protocol, [init(), json!({"type":"user","isReplay":true,"message":{"role":"user","content":[{"type":"text","text":"look at the tests too"}]}}), reply("m9", "ok")]);
    assert!(!protocol.receive(result("ok")).unwrap().done, "the agent still runs");
    assert!(protocol.claude_grace().is_none());
}

/// fg.log: `is_backgrounded:false`; the Agent tool result is the hand-back.
#[test]
fn a_foreground_child_settles_from_its_tool_result_without_a_notification() {
    let mut protocol = open("claude");
    let tool = "toolu_016dTitbsWx56TyBpsFYfhyq";
    protocol.receive(json!({"type":"assistant","message":{"id":"m1","role":"assistant","content":[{"type":"tool_use","id":tool,"name":"Agent","input":{"description":"fg","prompt":"Reply with the single word FOO and nothing else.","run_in_background":false}}]},"session_id":SESSION})).unwrap();
    protocol.receive(json!({"type":"system","subtype":"task_started","task_id":"a20e669c36e5968a5","tool_use_id":tool,"description":"fg","subagent_type":"general-purpose","is_backgrounded":false,"spawn_depth":1,"task_type":"local_agent","session_id":SESSION})).unwrap();
    let handed = protocol.receive(json!({"type":"user","message":{"role":"user","content":[{"tool_use_id":tool,"type":"tool_result","content":[{"type":"text","text":"FOO"}]}]},"session_id":SESSION})).unwrap();
    assert_eq!(child_status(&handed.events, tool).as_deref(), Some("completed"));
    assert!(protocol.receive(result("DONE")).unwrap().done, "a foreground child never holds the run");
}

enum LiveAction {
    Wait,
    KillHarness,
    Stop,
}

/// Runs the real CLI through `run()`; `action` happens once the first turn has replied.
async fn live_background_run(action: LiveAction) -> (Result<(), String>, Vec<AgentEvent>, std::time::Duration) {
    live_run(action, "Use the Agent tool with description \"bg\", run_in_background true, and prompt: run the Bash command \"sleep 20\" then reply with the word BAR. After launching, end your turn immediately by replying LAUNCHED. When it reports back reply GOT.").await
}

fn live_config(prompt: &str) -> super::RunConfig {
    let marker = format!("pandacode-live-{}", uuid::Uuid::new_v4());
    let root = std::env::temp_dir().join(&marker);
    std::fs::create_dir_all(&root).unwrap();
    let mut cfg = config("claude");
    cfg.session_id = marker.clone();
    cfg.model = "haiku".into();
    cfg.cwd = root;
    cfg.instructions = marker;
    cfg.prompt = prompt.into();
    cfg
}

async fn live_run(action: LiveAction, prompt: &str) -> (Result<(), String>, Vec<AgentEvent>, std::time::Duration) {
    let cfg = live_config(prompt);
    let root = cfg.cwd.clone();
    let outcome = live_turn(cfg, action, None).await;
    let _ = std::fs::remove_dir_all(root);
    outcome
}

async fn live_turn(cfg: super::RunConfig, action: LiveAction, host: Option<super::ToolHost>) -> (Result<(), String>, Vec<AgentEvent>, std::time::Duration) {
    use std::sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex};
    let (sender, receiver) = tokio::sync::mpsc::unbounded_channel();
    let seen = Arc::new(Mutex::new(Vec::<AgentEvent>::new()));
    let (captured, acted, target) = (seen.clone(), AtomicBool::new(false), cfg.instructions.clone());
    let sink: super::Sink = Arc::new(move |event: AgentEvent| {
        if event.kind == "approval" {
            let _ = sender.send(super::RunInput::Approval { request_id: event.request_id.clone().unwrap(), approved: true });
        }
        if event.kind == "text" && event.text.contains("LAUNCHED") && !acted.swap(true, Ordering::SeqCst) {
            match action {
                LiveAction::Wait => {}
                // The text streams before `result`; the delay lands these in the kept-open wait.
                LiveAction::KillHarness => {
                    let target = target.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_secs(4));
                        std::process::Command::new("pkill").args(["-9", "-f", &target]).status().unwrap();
                    });
                }
                LiveAction::Stop => {
                    let sender = sender.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_secs(4));
                        let _ = sender.send(super::RunInput::Stop);
                    });
                }
            }
        }
        captured.lock().unwrap().push(event);
    });
    let start = std::time::Instant::now();
    let harness = Arc::new(AtomicBool::new(false));
    let result = tokio::time::timeout(std::time::Duration::from_secs(420), super::run_with_tools(cfg, sink, receiver, host, harness)).await.expect("the run hung");
    let elapsed = start.elapsed();
    let events = seen.lock().unwrap().clone();
    (result, events, elapsed)
}

/// hook.log: a UserPromptSubmit hook longer than the short wait runs before the hand-back's turn.
/// Explicitly opt in: cargo test --lib live_slow_prompt_hook -- --ignored --nocapture
#[tokio::test]
#[ignore]
async fn live_slow_prompt_hook_keeps_the_hand_back() {
    let cfg = live_config("Launch exactly one background agent with the Agent tool, run_in_background true, description \"bg\", prompt: Reply with one word: BAR. Use no tools. Then end your turn immediately replying LAUNCHED. When its report arrives reply GOT.");
    let root = cfg.cwd.clone();
    std::fs::create_dir_all(root.join(".claude")).unwrap();
    std::fs::write(root.join(".claude/settings.json"), r#"{"hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command","command":"sleep 15"}]}]}}"#).unwrap();
    let (result, events, elapsed) = live_turn(cfg, LiveAction::Wait, None).await;
    let _ = std::fs::remove_dir_all(root);
    result.unwrap();
    let reply = text(&events);
    println!("slow hook: {elapsed:?}, text {reply:?}");
    assert!(reply.contains("LAUNCHED") && reply.contains("GOT"), "{reply}");
    assert!(!reply.contains("did not reach"), "{reply}");
}

/// A subagent backgrounds its own command, reports early and is woken when the command ends.
/// Explicitly opt in: cargo test --lib live_child_backgrounded -- --ignored --nocapture
#[tokio::test]
#[ignore]
async fn live_child_backgrounded_command_report_reaches_the_parent() {
    let (result, events, elapsed) = live_run(LiveAction::Wait, "Launch exactly one background agent with the Agent tool, run_in_background true, description \"bg\", telling it to run Bash \"sleep 25\" then reply exactly BAR. Then end your turn immediately replying LAUNCHED. When it reports that the command finished or that it replied BAR, reply GOT followed by the word it returned.").await;
    result.unwrap();
    let reply = text(&events);
    println!("child shell: {elapsed:?}, text {reply:?}, statuses {:?}", events.iter().filter(|e| e.kind == "subagent").map(|e| e.data.as_ref().unwrap()["status"].clone()).collect::<Vec<_>>());
    assert!(reply.contains("LAUNCHED") && reply.contains("GOT"), "{reply}");
    assert!(reply.contains("BAR"), "the report after the command reached the parent: {reply}");
    assert!(!reply.contains("did not reach"), "{reply}");
    assert!(elapsed > std::time::Duration::from_secs(25), "the run stayed open for the command: {elapsed:?}");
}

/// Explicitly opt in, this makes small billable requests:
/// cargo test --lib live_background_agent -- --ignored --nocapture
#[tokio::test]
#[ignore]
async fn live_background_agent_hands_back_to_the_parent() {
    let (result, events, elapsed) = live_background_run(LiveAction::Wait).await;
    result.unwrap();
    let reply = text(&events);
    println!("hand-back: {elapsed:?}, text {reply:?}, statuses {:?}", events.iter().filter(|e| e.kind == "subagent").map(|e| e.data.as_ref().unwrap()["status"].clone()).collect::<Vec<_>>());
    assert!(reply.contains("LAUNCHED") && reply.contains("GOT"), "{reply}");
    assert!(events.iter().rev().find(|e| e.kind == "subagent").is_some_and(|e| e.data.as_ref().unwrap()["status"] == "completed"));
}

#[tokio::test]
#[ignore]
async fn live_background_agents_both_reach_the_parent() {
    let (result, events, elapsed) = live_run(LiveAction::Wait, "Launch exactly two background agents in one single assistant message, using the Agent tool twice with run_in_background true, descriptions a and b. Prompt for a: Reply with one word: AAA. Use no tools. Prompt for b: Reply with one word: BBB. Use no tools. After launching, immediately reply with the single word LAUNCHED. Each time one reports back, reply with GOT and the word it returned.").await;
    result.unwrap();
    let reply = text(&events);
    println!("two agents: {elapsed:?}, text {reply:?}");
    assert!(reply.contains("AAA") && reply.contains("BBB"), "{reply}");
    assert!(!reply.contains("did not reach the agent"), "{reply}");
}

/// batch2.log live: the notifications of a background agent and the main agent's own background
/// Bash merge while the long reply is written, and the report still reaches the parent.
/// cargo test --lib live_batched_notifications -- --ignored --nocapture
#[tokio::test]
#[ignore]
async fn live_batched_notifications_reach_the_parent() {
    let (result, events, elapsed) = live_run(LiveAction::Wait, "Do exactly these steps. 1) In one single assistant message make two tool calls: Bash with run_in_background true running: sleep 11; echo S  and Agent with run_in_background true, description \"a\", prompt \"Use Bash to run: sleep 5. Then reply OK.\" 2) After both launched, with no more tools, write the integers from 1 to 6000 in plain text, one per line, in full with no abbreviation, as your final message. Do nothing else. When you later get notified of anything, reply with one word: GOT.").await;
    result.unwrap();
    let reply = text(&events);
    println!("batched: {elapsed:?}, ends {:?}", &reply[reply.len().saturating_sub(40)..]);
    assert!(reply.trim_end().ends_with("GOT"), "the report reached the parent");
    assert!(!reply.contains("did not reach"));
}

/// A run leaves a background command behind; the next one resumes, cold or through a spare.
async fn live_resume_after_background_command(warm: bool) {
    use std::{collections::HashSet, sync::Arc};
    let mut cfg = live_config("Start the Bash command \"sleep 600\" with run_in_background true. Then end your turn immediately replying LAUNCHED.");
    let root = cfg.cwd.clone();
    let (first, events, _) = live_turn(cfg.clone(), LiveAction::Wait, None).await;
    first.unwrap();
    cfg.resume_id = Some(events.iter().rev().find(|event| event.kind == "session").unwrap().text.clone());
    cfg.prompt = "Reply with exactly the word ANSWERED.".into();
    let host = warm.then(|| super::ToolHost {
        tools: vec![json!({"type":"function","name":"pandacode_live_noop","description":"Does nothing.","inputSchema":{"type":"object","properties":{}}})],
        approval_tools: HashSet::new(),
        handler: Arc::new(|_, args| Box::pin(async move { Ok(args) })),
    });
    if let Some(host) = &host {
        let mut next = cfg.clone();
        next.prompt.clear();
        super::prewarm_agent(next, host.tools.clone(), HashSet::new(), super::warm_epoch(&cfg.session_id)).await.unwrap();
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        assert!(super::warm::waiting(&cfg.session_id), "a spare is waiting");
    }
    let session = cfg.session_id.clone();
    let (second, events, elapsed) = live_turn(cfg, LiveAction::Wait, host).await;
    println!("resumed (warm {warm}): {elapsed:?}, {second:?}, text {:?}", text(&events));
    assert!(!super::warm::waiting(&session), "the spare was adopted");
    let _ = std::fs::remove_dir_all(root);
    second.unwrap();
    assert!(text(&events).contains("ANSWERED"));
}

#[tokio::test]
#[ignore]
async fn live_background_command_cold_resume_answers_the_prompt() {
    live_resume_after_background_command(false).await;
}

#[tokio::test]
#[ignore]
async fn live_background_command_warm_spare_answers_the_prompt() {
    live_resume_after_background_command(true).await;
}

#[tokio::test]
#[ignore]
async fn live_background_agent_harness_exit_ends_the_run_cleanly() {
    let (result, events, elapsed) = live_background_run(LiveAction::KillHarness).await;
    println!("killed: {elapsed:?}, {result:?}, text {:?}", text(&events));
    result.unwrap();
    assert!(!text(&events).contains("GOT"));
    assert!(text(&events).contains("The report from \"bg\" did not reach the agent"));
    // The note is its own row after the agent's reply, saved as the app saves a run's events.
    let store = crate::storage::Store::open(std::path::Path::new(":memory:")).unwrap();
    let project = store.add_project(&std::env::temp_dir()).unwrap();
    let task = store.create_session(&project.id, "claude", "default", "ask").unwrap();
    let assistant = std::sync::Mutex::new(String::new());
    for mut event in events.into_iter().filter(|event| matches!(event.kind.as_str(), "text" | "note" | "message_start")) {
        event.session_id = task.id.clone();
        if event.kind == "text" { assistant.lock().unwrap().push_str(&event.text); }
        else { crate::save_agent_activity(&store, &assistant, &mut event, None).unwrap(); }
    }
    let rows = store.messages(&task.id, None).unwrap();
    let (note, report) = (&rows[rows.len() - 1], &rows[rows.len() - 2]);
    println!("saved rows: {:?}", rows.iter().map(|row| (&row.role, &row.content)).collect::<Vec<_>>());
    assert!(note.role == "system" && note.content.contains("did not reach the agent"), "{rows:?}");
    assert!(report.role == "assistant" && report.content.contains("LAUNCHED"), "{rows:?}");
}

#[tokio::test]
#[ignore]
async fn live_background_agent_stop_ends_the_kept_open_run() {
    let (result, events, elapsed) = live_background_run(LiveAction::Stop).await;
    println!("stopped: {elapsed:?}, {result:?}, text {:?}", text(&events));
    result.unwrap();
    assert!(!text(&events).contains("GOT"), "Stop must not wait for the agent ({elapsed:?})");
}

const CHILD_SHELL: &str = "bg7wkbbff";
const FIRST_RUN: &str = "0mw0lwebe-a48ca1f2";
const WOKEN_RUN: &str = "0mw0s43lb-47f282b4";
const SHORT_WAIT: std::time::Duration = std::time::Duration::from_secs(10);
const SHELL_HOLD: std::time::Duration = std::time::Duration::from_secs(5 * 60);

fn child_shell() -> Value {
    json!({"task_id":CHILD_SHELL,"run_id":"0mw0s3ka5-89099bf7","task_type":"local_bash","description":"Sleep for 25 seconds in background","parent_task_id":AGENT_TASK})
}
fn notified(run: &str, text: &str) -> Value {
    json!({"type":"result","subtype":"success","is_error":false,"result":text,"num_turns":1,"origin":{"kind":"task-notification","producer":"session-task","runId":run},"session_id":SESSION})
}
fn child_shell_started() -> [Value; 2] {
    [
        tasks(json!([{"task_id":AGENT_TASK,"run_id":FIRST_RUN,"task_type":"local_agent","description":"bg"}, child_shell()])),
        json!({"type":"system","subtype":"task_started","task_id":CHILD_SHELL,"run_id":"0mw0s3ka5-89099bf7","owned_by_subagent":true,"description":"Sleep for 25 seconds in background","is_backgrounded":true,"parent_task_id":AGENT_TASK,"task_type":"local_bash","session_id":SESSION}),
    ]
}
/// The child's first report, with its command still running.
fn interim_report() -> [Value; 3] {
    [
        json!({"type":"system","subtype":"task_updated","task_id":AGENT_TASK,"run_id":FIRST_RUN,"patch":{"status":"completed"},"session_id":SESSION}),
        json!({"type":"system","subtype":"task_notification","task_id":AGENT_TASK,"tool_use_id":AGENT_TOOL,"status":"completed","run_id":FIRST_RUN,"session_id":SESSION}),
        tasks(json!([child_shell()])),
    ]
}
fn child_shell_finished() -> [Value; 3] {
    [
        json!({"type":"system","subtype":"task_updated","task_id":CHILD_SHELL,"run_id":"0mw0s3ka5-89099bf7","patch":{"status":"completed"},"session_id":SESSION}),
        json!({"type":"system","subtype":"task_notification","task_id":CHILD_SHELL,"tool_use_id":"toolu_shell","status":"completed","run_id":"0mw0s3ka5-89099bf7","session_id":SESSION}),
        tasks(json!([])),
    ]
}
fn opened_with_agent() -> Protocol {
    let mut protocol = Protocol::new(config("claude"));
    protocol.phase = 1;
    protocol.prompt_replayed = true;
    running(&mut protocol, launch());
    running(&mut protocol, [reply("m2", "LAUNCHED")]);
    assert!(!protocol.receive(result("LAUNCHED")).unwrap().done);
    protocol
}

/// st_idle.log: the CLI refuses a child's foreground `sleep 25`, so it backgrounds the command,
/// reports early, and is woken under a new run when the command ends. 23.11 s: the hand-back of
/// the early report. 37.18 s: the list empties. 37.19 s: the child is relisted. 41.48 s: GOT.
#[test]
fn a_subagents_background_command_holds_the_run_for_its_real_report() {
    let mut protocol = opened_with_agent();
    let mut steps = running(&mut protocol, child_shell_started());
    steps.extend(running(&mut protocol, interim_report()));
    steps.extend(running(&mut protocol, [init(), reply("m3", "Not finished yet.")]));
    let handed = protocol.receive(notified(FIRST_RUN, "Not finished yet.")).unwrap();
    assert!(!handed.done, "the child's command is still running, and its real report comes after");
    assert!(protocol.steers.settled.is_empty(), "the command is not an agent that owes a report");
    assert!(wait_left(&protocol) > SHORT_WAIT && wait_left(&protocol) <= SHELL_HOLD, "bounded: a child's dev server may never exit");
    let status = handed.events.iter().find(|event| event.kind == "status").expect("the thread says why it is open");
    assert!(status.text.contains("Sleep for 25 seconds in background") && status.text.contains("up to 5 minutes"), "{}", status.text);

    running(&mut protocol, child_shell_finished());
    assert!(protocol.claude_idle() && protocol.steers.settled.is_empty());
    assert!(wait_left(&protocol) <= SHORT_WAIT, "the child is relisted about 10 ms later, if at all");
    running(&mut protocol, [
        tasks(json!([{"task_id":AGENT_TASK,"run_id":WOKEN_RUN,"task_type":"local_agent","description":"bg"}])),
        json!({"type":"system","subtype":"task_started","task_id":AGENT_TASK,"run_id":WOKEN_RUN,"tool_use_id":AGENT_TOOL,"is_backgrounded":true,"task_type":"local_agent","description":"bg","session_id":SESSION}),
    ]);
    assert!(protocol.claude_grace().is_none(), "a running agent waits without a clock");
    running(&mut protocol, agent_settled());
    running(&mut protocol, [init(), reply("m4", "GOT")]);
    let last = protocol.receive(notified(WOKEN_RUN, "GOT")).unwrap();
    assert!(last.done, "the real report ends the run");
    assert!(!text(&steps.into_iter().chain([handed, last]).flat_map(|step| step.events).collect::<Vec<_>>()).contains("did not reach"));
}

/// A steer answered during the hold must not buy another five minutes: the dev server that held
/// the run would then hold it for as long as anyone keeps talking to it, past the team watchdog.
#[test]
fn a_steer_never_restarts_the_hold_on_a_subagents_command() {
    let mut protocol = opened_with_agent();
    running(&mut protocol, child_shell_started());
    running(&mut protocol, interim_report());
    running(&mut protocol, [init(), reply("m3", "Not finished yet.")]);
    protocol.receive(notified(FIRST_RUN, "Not finished yet.")).unwrap();
    let minutes_ago = |minutes: u64| tokio::time::Instant::now().checked_sub(std::time::Duration::from_secs(minutes * 60));
    protocol.steers.shell_hold_since = minutes_ago(4);

    let (reply_to, _answer) = tokio::sync::oneshot::channel();
    protocol.steer("s1".into(), "how is it going?".into(), reply_to);
    running(&mut protocol, [json!({"type":"user","isReplay":true,"message":{"role":"user","content":[{"type":"text","text":"how is it going?"}]}}), init(), reply("m4", "Still running.")]);
    let answered = protocol.receive(result("Still running.")).unwrap();
    assert!(!answered.done);
    assert!(wait_left(&protocol) <= std::time::Duration::from_secs(60), "the 5 minutes kept running: {:?}", wait_left(&protocol));
    assert!(answered.events.iter().any(|event| event.kind == "status" && event.text.contains("up to 1 minute")), "the status counts down too");

    // Past the cap, a further steer's turn ends the run as soon as it is answered.
    protocol.steers.shell_hold_since = minutes_ago(6);
    let (reply_to, _answer) = tokio::sync::oneshot::channel();
    protocol.steer("s2".into(), "and now?".into(), reply_to);
    running(&mut protocol, [json!({"type":"user","isReplay":true,"message":{"role":"user","content":[{"type":"text","text":"and now?"}]}}), init(), reply("m5", "Same.")]);
    let answered = protocol.receive(result("Same.")).unwrap();
    assert_eq!(wait_left(&protocol), std::time::Duration::ZERO);
    assert!(!answered.events.iter().any(|event| event.kind == "status"), "nothing is left to wait for");
    let end = protocol.claude_end_idle();
    assert!(end.done && end.failure.is_none());
    assert!(text(&end.events).contains("still running"), "{}", text(&end.events));
}

/// The hold can run out during other work: an agent settling after that still hands back.
#[test]
fn an_expired_hold_never_cuts_off_a_settled_agents_hand_back() {
    let mut protocol = opened_with_agent();
    running(&mut protocol, child_shell_started());
    running(&mut protocol, interim_report());
    running(&mut protocol, [init(), reply("m3", "Not finished yet.")]);
    protocol.receive(notified(FIRST_RUN, "Not finished yet.")).unwrap();
    protocol.steers.shell_hold_since = tokio::time::Instant::now().checked_sub(std::time::Duration::from_secs(10 * 60));
    let shell = json!({"task_id":CHILD_SHELL,"parent_task_id":AGENT_TASK,"run_id":"r","task_type":"local_bash","description":"Dev server"});
    let other = json!({"task_id":"second","run_id":"r2","task_type":"local_agent","description":"second"});
    running(&mut protocol, [tasks(json!([shell, other]))]);
    assert!(protocol.claude_grace().is_none(), "a running agent waits without a clock");
    running(&mut protocol, [tasks(json!([shell]))]);
    assert!(wait_left(&protocol) > SHORT_WAIT - std::time::Duration::from_secs(1) && wait_left(&protocol) <= SHORT_WAIT, "{:?}", wait_left(&protocol));
    let last = protocol.receive(notified("r2", "GOT")).unwrap();
    assert_eq!(wait_left(&protocol), std::time::Duration::ZERO, "reported: only the command is left, and its time is up");
    assert!(!last.events.iter().any(|event| event.kind == "status"));
    assert!(!text(&protocol.claude_end_idle().events).contains("did not reach"));
}

/// A woken child's command is real progress: its next command gets a hold of its own.
#[test]
fn a_new_command_after_the_last_one_ended_gets_its_own_hold() {
    let mut protocol = opened_with_agent();
    running(&mut protocol, child_shell_started());
    running(&mut protocol, interim_report());
    running(&mut protocol, [init(), reply("m3", "Not finished yet.")]);
    protocol.receive(notified(FIRST_RUN, "Not finished yet.")).unwrap();
    protocol.steers.shell_hold_since = tokio::time::Instant::now().checked_sub(std::time::Duration::from_secs(4 * 60));
    running(&mut protocol, child_shell_finished());
    assert!(protocol.steers.shell_hold_since.is_none());
    running(&mut protocol, child_shell_started());
    running(&mut protocol, [tasks(json!([{"task_id":CHILD_SHELL,"parent_task_id":AGENT_TASK,"run_id":"r2","task_type":"local_bash","description":"Second command"}]))]);
    assert!(wait_left(&protocol) > std::time::Duration::from_secs(4 * 60), "{:?}", wait_left(&protocol));
}

/// A command with no description still ends the run with a sentence that reads.
#[test]
fn a_command_with_no_description_is_not_named_in_the_note() {
    let mut protocol = opened_with_agent();
    running(&mut protocol, [tasks(json!([{"task_id":AGENT_TASK,"run_id":FIRST_RUN,"task_type":"local_agent","description":"bg"},{"task_id":CHILD_SHELL,"parent_task_id":AGENT_TASK,"run_id":"r","task_type":"local_bash","description":""}]))]);
    running(&mut protocol, interim_report());
    running(&mut protocol, [tasks(json!([{"task_id":CHILD_SHELL,"parent_task_id":AGENT_TASK,"run_id":"r","task_type":"local_bash","description":""}])), init(), reply("m3", "Done.")]);
    let handed = protocol.receive(notified(FIRST_RUN, "Done.")).unwrap();
    let status = handed.events.iter().find(|event| event.kind == "status").unwrap();
    assert!(status.text.starts_with("Waiting on a subagent's background command for up to"), "{}", status.text);
    let note = text(&protocol.claude_end_idle().events);
    assert!(note.contains("A background command a subagent started was still running"), "{note}");
}

/// After a slash command answered the prompt (never echoed), a leftover notification's `result`
/// owes no prompt: the run ends at the batch grace instead of failing with "never took this message".
#[test]
fn a_notification_after_the_prompt_was_answered_owes_no_prompt() {
    let mut protocol = Protocol::new(config("claude"));
    protocol.phase = 1;
    assert!(protocol.receive(json!({"type":"result","subtype":"success","result":"cost","num_turns":0})).unwrap().done);
    let leftover = protocol.receive(json!({"type":"result","subtype":"success","result":"","num_turns":0,"origin":{"kind":"task-notification"}})).unwrap();
    assert!(!leftover.done && leftover.failure.is_none());
    assert!(wait_left(&protocol) <= SHORT_WAIT);
    let end = protocol.claude_wait_over();
    assert!(end.done && end.failure.is_none());
    assert!(protocol.claude_grace().is_none());
}

/// run(): a subagent backgrounds a command that outlives the cap and reports. At the cap the main
/// agent gets one turn saying so, and its `result` ends the run. Takes the real 5 minutes.
/// Explicitly opt in: cargo test --lib live_child_shell_hold -- --ignored --nocapture
#[tokio::test]
#[ignore]
async fn live_child_shell_hold_ends_the_run_at_the_cap() {
    let (result, events, elapsed) = live_turn(live_config("Launch exactly one background agent with the Agent tool, run_in_background true, description \"bg\", telling it to start the Bash command \"sleep 400\" with run_in_background true and description \"Sleep for 400 seconds\", then immediately reply exactly STARTED without waiting for it. Then end your turn immediately replying LAUNCHED. When it reports, reply GOT. If you are later told a command is still running, reply NOTED."), LiveAction::Wait, None).await;
    let reply = text(&events);
    let statuses: Vec<_> = events.iter().filter(|event| event.kind == "status").map(|event| event.text.clone()).collect();
    println!("hold: {elapsed:?}, {result:?}\ntext {reply:?}\nstatuses {statuses:?}");
    result.unwrap();
    assert!(reply.contains("NOTED"), "the main agent was told: {reply}");
    assert!(reply.contains("was still running when this run ended"), "{reply}");
    assert!(statuses.iter().any(|status| status.starts_with("Waiting on a subagent's background command")), "{statuses:?}");
    assert!(elapsed >= SHELL_HOLD && elapsed < std::time::Duration::from_secs(400), "ended at the cap, not when the command did: {elapsed:?}");
}

fn past_the_hold() -> Protocol {
    let mut protocol = opened_with_agent();
    running(&mut protocol, child_shell_started());
    running(&mut protocol, interim_report());
    running(&mut protocol, [init(), reply("m3", "Not finished yet.")]);
    protocol.receive(notified(FIRST_RUN, "Not finished yet.")).unwrap();
    protocol.steers.shell_hold_since = tokio::time::Instant::now().checked_sub(SHELL_HOLD + std::time::Duration::from_secs(1));
    protocol
}

fn user_echo(text: &str) -> Value {
    json!({"type":"user","isReplay":true,"message":{"role":"user","content":[{"type":"text","text":text}]}})
}

/// At the cap the report is lost, and only Claude's own session can act on that: one plain turn,
/// and its `result` ends the run, so the command can never hold the run a second time.
#[test]
fn a_hold_that_runs_out_gives_the_main_agent_one_turn_then_ends() {
    let mut protocol = past_the_hold();
    assert_eq!(wait_left(&protocol), std::time::Duration::ZERO);
    let told = protocol.claude_wait_over();
    assert!(!told.done && told.events.is_empty());
    let sent = told.write[0]["message"]["content"][0]["text"].as_str().unwrap().to_owned();
    assert_eq!(told.write[0]["type"], "user");
    assert!(sent.contains("subagent \"bg\"'s command \"Sleep for 25 seconds in background\"") && sent.contains("will not arrive") && sent.contains("foreground"), "{sent}");
    assert!(!sent.contains('<'), "plain text: {sent}");
    assert!(wait_left(&protocol) > SHORT_WAIT && wait_left(&protocol) <= std::time::Duration::from_secs(120), "{:?}", wait_left(&protocol));
    running(&mut protocol, [user_echo(&sent), init(), reply("m4", "It is still running.")]);
    assert!(protocol.claude_grace().is_none(), "the turn started");
    let last = protocol.receive(result("It is still running.")).unwrap();
    assert!(last.done, "that turn's result ends the run");
    assert!(protocol.claude_grace().is_none());
    assert!(text(&last.events).contains("Sleep for 25 seconds in background") && text(&last.events).contains("still running"), "the transcript says it stopped");
    assert!(!text(&last.events).contains("did not reach"));
}

#[test]
fn a_notice_no_turn_takes_ends_the_run_with_the_note() {
    let mut protocol = past_the_hold();
    protocol.claude_wait_over();
    let end = protocol.claude_wait_over();
    assert!(end.done && end.failure.is_none() && end.write.is_empty(), "never told twice");
    assert!(text(&end.events).contains("still running"));
}

/// The notice's echo is not a reworded steer, and an agent that settles during its turn still gets
/// its own hand-back from the result that names it.
#[test]
fn a_notice_keeps_a_steers_echo_and_a_settling_agents_hand_back() {
    let mut protocol = past_the_hold();
    let told = protocol.claude_wait_over();
    let sent = told.write[0]["message"]["content"][0]["text"].as_str().unwrap().to_owned();
    let (reply_to, _answer) = tokio::sync::oneshot::channel();
    protocol.steer("s1".into(), "steered".into(), reply_to);
    let echo = protocol.receive(user_echo(&sent)).unwrap();
    assert!(echo.events.iter().all(|event| event.kind != "steer"), "the steer is still waiting");
    let shell = child_shell();
    running(&mut protocol, [tasks(json!([{"task_id":"late","run_id":"late-run","task_type":"local_agent","description":"late"}, shell])), tasks(json!([shell]))]);
    let echoed = protocol.receive(user_echo("steered")).unwrap();
    assert!(echoed.events.iter().any(|event| event.kind == "steer"));
    running(&mut protocol, [init(), reply("m4", "Noted.")]);
    assert!(!protocol.receive(result("Noted.")).unwrap().done, "late still owes its hand-back");
    running(&mut protocol, [init(), reply("m5", "GOT")]);
    assert!(protocol.receive(notified("late-run", "GOT")).unwrap().done);
}

/// Real progress after the notice: a command of a woken child's gets a hold of its own.
#[test]
fn a_command_ending_after_the_notice_clears_it() {
    let mut protocol = past_the_hold();
    protocol.claude_wait_over();
    running(&mut protocol, child_shell_finished());
    running(&mut protocol, child_shell_started());
    running(&mut protocol, [tasks(json!([child_shell()]))]);
    assert!(wait_left(&protocol) > std::time::Duration::from_secs(4 * 60), "{:?}", wait_left(&protocol));
    running(&mut protocol, [init(), reply("m4", "Woken.")]);
    assert!(!protocol.receive(notified(FIRST_RUN, "Woken.")).unwrap().done, "the new command holds");
    assert!(!protocol.claude_wait_over().write.is_empty(), "and gets its own notice");
}

fn agent_row(task: &str, run: &str, name: &str, parent: &str) -> Value {
    let mut row = json!({"task_id":task,"run_id":run,"task_type":"local_agent","subagent_type":"general-purpose","description":name});
    if !parent.is_empty() {
        row["parent_task_id"] = json!(parent);
    }
    row
}
fn nested_started(task: &str, run: &str, tool: &str, parent: &str, backgrounded: bool) -> Value {
    let mut frame = json!({"type":"system","subtype":"task_started","task_id":task,"run_id":run,"tool_use_id":tool,"is_backgrounded":backgrounded,"task_type":"local_agent","session_id":SESSION});
    if !parent.is_empty() {
        frame["parent_task_id"] = json!(parent);
    }
    frame
}
fn nested_ended(task: &str, run: &str, tool: &str) -> [Value; 2] {
    [
        json!({"type":"system","subtype":"task_updated","task_id":task,"run_id":run,"patch":{"status":"completed"},"session_id":SESSION}),
        json!({"type":"system","subtype":"task_notification","task_id":task,"run_id":run,"tool_use_id":tool,"status":"completed","session_id":SESSION}),
    ]
}

/// nested2.log: inner settles at 11.67 s inside a running outer and reports to it; outer settles
/// at 39.98 s and its hand-back's `result` at 41.73 s ends the run, with no wait and no false note.
#[test]
fn an_inner_agent_settling_inside_its_background_parent_owes_the_main_agent_nothing() {
    let (outer, inner, outer_run, inner_run) = ("a55bc381f46632c40", "a05af594a36d765bc", "0mw0wjpgv-4c1422fa", "0mw0wjs8h-8695e624");
    let mut protocol = Protocol::new(config("claude"));
    protocol.phase = 1;
    protocol.prompt_replayed = true;
    running(&mut protocol, [tasks(json!([agent_row(outer, outer_run, "outer", "")])), nested_started(outer, outer_run, "t1", "", true), reply("m1", "LAUNCHED")]);
    assert!(!protocol.receive(result("LAUNCHED")).unwrap().done);
    running(&mut protocol, [tasks(json!([agent_row(outer, outer_run, "outer", ""), agent_row(inner, inner_run, "inner", outer)])), nested_started(inner, inner_run, "t2", outer, true)]);
    running(&mut protocol, nested_ended(inner, inner_run, "t2"));
    running(&mut protocol, [tasks(json!([agent_row(outer, outer_run, "outer", "")]))]);
    assert!(protocol.steers.settled.is_empty(), "inner reported to outer");
    running(&mut protocol, [json!({"type":"system","subtype":"task_started","task_id":"bnt1n74j3","run_id":"0mw0wk1ji-46655a76","tool_use_id":"t3","is_backgrounded":false,"parent_task_id":outer,"task_type":"local_bash","session_id":SESSION})]);
    running(&mut protocol, nested_ended("bnt1n74j3", "0mw0wk1ji-46655a76", "t3"));
    running(&mut protocol, nested_ended(outer, outer_run, "t1"));
    running(&mut protocol, [tasks(json!([])), init(), reply("m2", "OUTER")]);
    let last = protocol.receive(notified(outer_run, "OUTER")).unwrap();
    assert!(last.done, "nothing is left to wait for");
    assert!(protocol.claude_grace().is_none());
    assert!(!text(&last.events).contains("did not reach"));
}

/// nested3.log: the same inside a foreground outer, which never appears in the list. Its one
/// `result` at 39.64 s is the end of the run.
#[test]
fn an_inner_agent_settling_inside_its_foreground_parent_owes_the_main_agent_nothing() {
    let (outer, inner, outer_run, inner_run) = ("af4f150ba799aa830", "afb00f2040cc1f847", "0mw0wlvua-85fa62f5", "0mw0wlyx4-d99d2279");
    let mut protocol = Protocol::new(config("claude"));
    protocol.phase = 1;
    protocol.prompt_replayed = true;
    running(&mut protocol, [nested_started(outer, outer_run, "t1", "", false), tasks(json!([agent_row(inner, inner_run, "inner", outer)])), nested_started(inner, inner_run, "t2", outer, true)]);
    running(&mut protocol, nested_ended(inner, inner_run, "t2"));
    running(&mut protocol, [tasks(json!([]))]);
    assert!(protocol.steers.settled.is_empty());
    running(&mut protocol, nested_ended(outer, outer_run, "t1"));
    running(&mut protocol, [reply("m1", "FIRST")]);
    let last = protocol.receive(result("FIRST")).unwrap();
    assert!(last.done, "the run ends at once");
    assert!(!text(&last.events).contains("did not reach"));
}

/// A nested agent reports to a foreground parent whose end never arrives. Nothing is owed and no
/// frame may follow, so the wait still ends the run.
#[test]
fn an_idle_run_with_a_stale_nested_parent_ends_through_the_wait() {
    let (outer, inner) = ("outer-task", "inner-task");
    let mut protocol = Protocol::new(config("claude"));
    protocol.phase = 1;
    protocol.prompt_replayed = true;
    running(&mut protocol, [nested_started(outer, "r1", "t1", "", false), tasks(json!([agent_row(inner, "r2", "inner", outer)])), nested_started(inner, "r2", "t2", outer, true), reply("m1", "FIRST")]);
    assert!(!protocol.receive(result("FIRST")).unwrap().done, "the agent still runs");
    assert!(protocol.claude_grace().is_none());
    running(&mut protocol, nested_ended(inner, "r2", "t2"));
    assert!(protocol.claude_grace().is_some(), "or the run would hang until Stop");
    let last = protocol.claude_wait_over();
    assert!(last.done);
    assert!(!text(&last.events).contains("did not reach"), "it reported to its parent");
}

/// Parallel first runs ask the CLI once.
#[cfg(unix)]
#[test]
fn parallel_first_runs_share_one_help_probe() {
    use std::os::unix::fs::PermissionsExt;
    let dir = std::env::temp_dir().join(format!("pandacode-help-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let (script, count) = (dir.join("claude"), dir.join("count"));
    std::fs::write(&script, format!("#!/bin/sh\necho x >> '{}'\nsleep 0.2\necho --include-hook-events\n", count.display())).unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::thread::scope(|scope| {
        let runs: Vec<_> = (0..4).map(|_| scope.spawn(|| super::claude_lists_hook_events(&tokio::process::Command::new(&script)))).collect();
        assert!(runs.into_iter().all(|run| run.join().unwrap()));
    });
    assert_eq!(std::fs::read_to_string(&count).unwrap().lines().count(), 1);
    let _ = std::fs::remove_dir_all(dir);
}

/// nested.log: outer ends first (13.84 s), so inner's report (13.98 s) gets its own main-agent
/// turn: `result` at 17.61 s names outer's run and at 25.04 s inner's.
#[test]
fn an_inner_agent_outliving_its_parent_gets_its_own_hand_back() {
    let (outer, inner, outer_run, inner_run, again) = ("a36162c399ae7bbaa", "afcd967482bae1dc2", "0mw0wi6j9-9972c6a9", "0mw0wiaa7-c8a593de", "0mw0wik1a-9167ef11");
    let mut protocol = Protocol::new(config("claude"));
    protocol.phase = 1;
    protocol.prompt_replayed = true;
    running(&mut protocol, [tasks(json!([agent_row(outer, outer_run, "outer", "")])), nested_started(outer, outer_run, "t1", "", true)]);
    assert!(!protocol.receive(result("LAUNCHED")).unwrap().done);
    running(&mut protocol, [tasks(json!([agent_row(outer, outer_run, "outer", ""), agent_row(inner, inner_run, "inner", outer)])), nested_started(inner, inner_run, "t2", outer, true)]);
    running(&mut protocol, nested_ended(outer, outer_run, "t1"));
    running(&mut protocol, [tasks(json!([agent_row(inner, inner_run, "inner", outer)])), init()]);
    running(&mut protocol, nested_ended(inner, inner_run, "t2"));
    running(&mut protocol, [tasks(json!([]))]);
    assert_eq!(protocol.steers.settled.len(), 2, "outer was gone, so inner's report goes to the main agent");
    assert!(!protocol.receive(notified(outer_run, "one")).unwrap().done, "inner's turn is owed");
    assert!(protocol.claude_grace().is_some());
    running(&mut protocol, [init(), tasks(json!([agent_row(outer, again, "outer", "")])), nested_started(outer, again, "t3", "", true)]);
    assert!(!protocol.receive(notified(inner_run, "two")).unwrap().done, "the agent it launched runs");
    running(&mut protocol, nested_ended(outer, again, "t3"));
    running(&mut protocol, [tasks(json!([])), init()]);
    let last = protocol.receive(notified(again, "three")).unwrap();
    assert!(last.done);
    assert!(!text(&last.events).contains("did not reach"));
}

/// fg.log's CLI ends a foreground agent with only its tool result: past that, it is no parent.
#[test]
fn a_foreground_agent_closed_by_its_tool_result_is_no_longer_a_parent() {
    let mut protocol = Protocol::new(config("claude"));
    protocol.phase = 1;
    protocol.prompt_replayed = true;
    running(&mut protocol, [nested_started("fg", "r1", "tool", "", false), tasks(json!([agent_row("inner", "r2", "inner", "fg")]))]);
    running(&mut protocol, [json!({"type":"user","message":{"role":"user","content":[{"tool_use_id":"tool","type":"tool_result","content":[{"type":"text","text":"ok"}]}]},"session_id":SESSION})]);
    assert!(!protocol.receive(result("first")).unwrap().done, "inner still runs");
    running(&mut protocol, nested_ended("inner", "r2", "t2"));
    assert_eq!(protocol.steers.settled.len(), 1, "inner's report goes to the main agent");
}

/// Runs an inner background agent inside a background outer through run().
/// Explicitly opt in: cargo test --lib live_nested -- --ignored --nocapture
#[tokio::test]
#[ignore]
async fn live_nested_background_agent_reports_to_its_parent() {
    let (result, events, elapsed) = live_run(LiveAction::Wait, "Use the Agent tool with description \"outer\", run_in_background true, and this exact prompt: \"First use the Agent tool with description \\\"inner\\\", run_in_background true, prompt \\\"Reply INNER.\\\". Then run the Bash command sleep 15 in the foreground. Then reply OUTER.\". After launching, end your turn immediately replying LAUNCHED. When it reports back reply GOT.").await;
    result.unwrap();
    let reply = text(&events);
    println!("nested: {elapsed:?}, text {reply:?}");
    assert!(reply.contains("LAUNCHED") && reply.contains("GOT"), "{reply}");
    assert!(!reply.contains("did not reach"), "{reply}");
}

#[test]
fn a_subagents_command_that_never_ends_is_cut_off_with_a_note() {
    let mut protocol = opened_with_agent();
    running(&mut protocol, child_shell_started());
    running(&mut protocol, interim_report());
    running(&mut protocol, [init(), reply("m3", "Not finished yet.")]);
    protocol.receive(notified(FIRST_RUN, "Not finished yet.")).unwrap();
    let end = protocol.claude_end_idle();
    assert!(end.done && end.failure.is_none());
    let note = text(&end.events);
    assert!(note.contains("Sleep for 25 seconds in background") && note.contains("still running"), "{note}");
    assert!(!note.contains("did not reach"), "the command owed no report: {note}");
}

/// The list is empty a moment before the child is relisted, so a child's command that ended with
/// nothing to wake still gets the short wait, then ends the run with no note.
#[test]
fn a_subagents_command_ending_with_nothing_relisted_ends_cleanly() {
    let mut protocol = opened_with_agent();
    running(&mut protocol, child_shell_started());
    running(&mut protocol, interim_report());
    running(&mut protocol, [init(), reply("m3", "Done.")]);
    protocol.receive(notified(FIRST_RUN, "Done.")).unwrap();
    running(&mut protocol, child_shell_finished());
    let end = protocol.claude_end_idle();
    assert!(end.done && end.failure.is_none());
    assert!(text(&end.events).is_empty());
}

/// fgshell.log: a foreground child backgrounds `sleep 30` and returns; the CLI kills the command
/// (8.59 s) and ends the child (8.61 s), and the parent answers (10.30 s) with nothing owed.
#[test]
fn a_foreground_childs_command_ending_mid_turn_never_delays_the_final_answer() {
    let (agent, tool, shell) = ("a56865248f71daaa9", "toolu_01WVY9Gn37QZkAFyvdgrGwAd", "bnzvwr0tu");
    let (agent_run, shell_run) = ("0mw0vonhy-cfa6438b", "0mw0vopoy-007441fe");
    let mut protocol = Protocol::new(config("claude"));
    protocol.phase = 1;
    protocol.prompt_replayed = true;
    running(&mut protocol, [
        init(),
        json!({"type":"assistant","message":{"id":"m1","role":"assistant","content":[{"type":"tool_use","id":tool,"name":"Agent","input":{"description":"fg","prompt":"Start sleep 30","run_in_background":false}}]},"session_id":SESSION,"parent_tool_use_id":null}),
        json!({"type":"system","subtype":"task_started","task_id":agent,"run_id":agent_run,"tool_use_id":tool,"description":"fg","is_backgrounded":false,"task_type":"local_agent","session_id":SESSION}),
        tasks(json!([{"task_id":shell,"run_id":shell_run,"task_type":"local_bash","description":"Run delayed echo in background","parent_task_id":agent}])),
        json!({"type":"system","subtype":"task_started","task_id":shell,"run_id":shell_run,"owned_by_subagent":true,"description":"Run delayed echo in background","is_backgrounded":true,"parent_task_id":agent,"task_type":"local_bash","session_id":SESSION}),
        json!({"type":"system","subtype":"task_updated","task_id":shell,"run_id":shell_run,"patch":{"status":"killed"},"session_id":SESSION}),
        json!({"type":"system","subtype":"task_notification","task_id":shell,"status":"stopped","run_id":shell_run,"session_id":SESSION}),
        tasks(json!([])),
        json!({"type":"system","subtype":"task_updated","task_id":agent,"run_id":agent_run,"patch":{"status":"completed"},"session_id":SESSION}),
        json!({"type":"system","subtype":"task_notification","task_id":agent,"tool_use_id":tool,"status":"completed","run_id":agent_run,"session_id":SESSION}),
        json!({"type":"user","message":{"role":"user","content":[{"tool_use_id":tool,"type":"tool_result","content":[{"type":"text","text":"STARTED"}]}]},"session_id":SESSION,"parent_tool_use_id":null}),
        reply("m2", "FIRST"),
    ]);
    let last = protocol.receive(result("FIRST")).unwrap();
    assert!(last.done, "the final answer ends the run at once");
    assert!(protocol.claude_grace().is_none());
}

#[test]
fn the_parents_own_background_command_never_holds_the_run() {
    let mut protocol = Protocol::new(config("claude"));
    protocol.phase = 1;
    protocol.prompt_replayed = true;
    running(&mut protocol, [
        tasks(json!([{"task_id":"own","run_id":"r","task_type":"local_bash","description":"dev server"}])),
        json!({"type":"system","subtype":"task_started","task_id":"own","run_id":"r","description":"dev server","is_backgrounded":true,"task_type":"local_bash","session_id":SESSION}),
    ]);
    assert!(protocol.receive(result("started")).unwrap().done);
}

/// hook.log and hook2.log: a 15 s UserPromptSubmit hook runs between a hand-back's notification
/// (20.09 s) and its `init` (35.11 s), and with --include-hook-events the hook shows at 20.10 s.
#[test]
fn a_slow_prompt_hook_counts_as_the_owed_turn_starting() {
    let hook = |subtype: &str, id: &str| json!({"type":"system","subtype":subtype,"hook_id":id,"hook_name":"UserPromptSubmit","hook_event":"UserPromptSubmit","exit_code":0,"outcome":"success","session_id":SESSION});
    let mut protocol = opened_with_agent();
    running(&mut protocol, agent_settled());
    assert!(wait_left(&protocol) <= SHORT_WAIT, "a late turn is short until something shows it started");
    let started = running(&mut protocol, [hook("hook_started", "fast"), hook("hook_started", "slow"), hook("hook_response", "fast")]);
    assert!(started.iter().all(|step| step.events.is_empty() && step.write.is_empty() && !step.done), "hook frames add nothing to the transcript");
    assert!(protocol.claude_idle(), "the process may still die in the hook, and that end stays clean");
    assert!(wait_left(&protocol) > SHORT_WAIT * 10, "a hook is still running");
    running(&mut protocol, [hook("hook_response", "slow")]);
    assert!(wait_left(&protocol) <= SHORT_WAIT, "a turn the hooks blocked must not hold for 15 minutes");
    running(&mut protocol, [hook("hook_started", "again")]);
    running(&mut protocol, [init(), reply("m3", "GOT")]);
    assert!(protocol.claude_grace().is_none());
    assert!(protocol.receive(notified(FIRST_RUN, "GOT")).unwrap().done);
}

#[test]
fn other_hooks_never_disturb_a_turn_or_a_wait() {
    let mut protocol = opened_with_agent();
    running(&mut protocol, agent_settled());
    let before = wait_left(&protocol);
    for event in ["Stop", "SubagentStop", "PreToolUse", "SessionStart"] {
        let step = protocol.receive(json!({"type":"system","subtype":"hook_started","hook_id":event,"hook_name":event,"hook_event":event,"session_id":SESSION})).unwrap();
        assert!(step.events.is_empty() && !step.done);
    }
    assert!(protocol.claude_idle());
    assert!(wait_left(&protocol) <= before);
}

#[cfg(unix)]
#[test]
fn hook_events_are_requested_only_from_a_cli_that_lists_the_flag() {
    use std::os::unix::fs::PermissionsExt;
    let root = std::env::temp_dir().join(format!("pandacode-hook-flag-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let launched = |name: &str, help: &str, provider: &str| {
        let path = root.join(name);
        std::fs::write(&path, format!("#!/bin/sh\necho '{help}'\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mut command = tokio::process::Command::new(&path);
        super::configure_command(&mut command, &config(provider));
        command.as_std().get_args().any(|arg| arg == "--include-hook-events")
    };
    assert!(launched("new", "  --include-hook-events  Include all hook lifecycle events", "claude"));
    assert!(launched("relay", "  --include-hook-events  Include all hook lifecycle events", "glm"), "relays run the same CLI");
    assert!(!launched("old", "  --verbose", "claude"), "an unknown flag would stop an older CLI at launch");
    // The cloud bridge configures a placeholder; its machine's CLI is unknown.
    let mut placeholder = tokio::process::Command::new("harness");
    super::configure_command(&mut placeholder, &config("claude"));
    assert!(!placeholder.as_std().get_args().any(|arg| arg == "--include-hook-events"));
    let _ = std::fs::remove_dir_all(root);
}

fn steer(protocol: &mut Protocol, text: &str) -> super::Step {
    let (reply, _) = tokio::sync::oneshot::channel();
    protocol.steer(format!("steer-{text}"), text.into(), reply)
}
fn steer_status(step: &super::Step) -> Vec<String> {
    step.events.iter().filter(|event| event.kind == "steer").map(|event| event.data.as_ref().unwrap()["status"].as_str().unwrap().to_owned()).collect()
}

/// st_tool.log: /cost sent as a steer gets `init`, one assistant message and a `result` with no
/// turns and no echo, and must not read as an untaken message for 15 minutes.
#[test]
fn a_local_slash_command_sent_as_a_steer_is_delivered_by_its_result() {
    let mut protocol = Protocol::new(config("claude"));
    protocol.phase = 1;
    protocol.prompt_replayed = true;
    steer(&mut protocol, "/cost");
    assert!(!protocol.receive(result("FIRST")).unwrap().done, "the steer is still owed");
    running(&mut protocol, [init(), reply("m2", "You are currently using your subscription")]);
    let end = protocol.receive(json!({"type":"result","subtype":"success","is_error":false,"duration_api_ms":0,"num_turns":0,"result":"You are currently using your subscription","session_id":SESSION})).unwrap();
    assert_eq!(steer_status(&end), ["delivered"]);
    assert!(end.done);
}

#[test]
fn a_no_turn_result_delivers_only_a_slash_steer_and_not_for_the_prompts_own_command() {
    let no_turns = json!({"type":"result","subtype":"success","is_error":false,"num_turns":0,"result":"x","session_id":SESSION});
    // A plain steer is echoed when taken, so a no-turn result says nothing about it.
    let mut plain = Protocol::new(config("claude"));
    plain.phase = 1;
    plain.prompt_replayed = true;
    steer(&mut plain, "also add tests");
    let step = plain.receive(no_turns.clone()).unwrap();
    assert!(steer_status(&step).is_empty() && !step.done);
    // An opening /cost answers first; the steer behind it still has its own turn to come.
    let mut opening = Protocol::new(config("claude"));
    opening.phase = 1;
    steer(&mut opening, "/usage");
    let step = opening.receive(no_turns.clone()).unwrap();
    assert!(steer_status(&step).is_empty() && !step.done, "this result is the prompt's");
    let step = opening.receive(no_turns).unwrap();
    assert_eq!(steer_status(&step), ["delivered"]);
    assert!(step.done);
}

/// A slow `--help` (a cold start, a loaded machine) says nothing about the CLI: it is asked again
/// at the next run, and only an answer is remembered.
#[test]
fn a_slow_help_probe_is_not_remembered_but_an_answer_is() {
    let key = || std::path::PathBuf::from(format!("/slow-help-{}", std::process::id()));
    assert!(!super::hook_events_answer(key(), || None), "timed out");
    assert!(super::hook_events_answer(key(), || Some("--include-hook-events".into())), "asked again");
    assert!(super::hook_events_answer(key(), || panic!("remembered")));
}
