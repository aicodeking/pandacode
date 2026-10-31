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
        .filter(|event| event.kind == "text")
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
