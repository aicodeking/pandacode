use super::{tests::config, AgentEvent, Protocol};
use serde_json::json;

fn chunk(id: Option<&str>, text: &str) -> serde_json::Value {
    let mut update =
        json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":text}});
    if let Some(id) = id {
        update["messageId"] = json!(id);
    }
    json!({"method":"session/update","params":{"sessionId":"main","update":update}})
}
fn starts(events: &[AgentEvent]) -> Vec<String> {
    events
        .iter()
        .filter(|event| event.kind == "message_start")
        .map(|event| {
            event.data.as_ref().unwrap()["messageId"]
                .as_str()
                .unwrap()
                .to_owned()
        })
        .collect()
}

#[test]
fn acp_message_ids_preserve_boundaries_and_chunks_remain_incremental() {
    let mut protocol = Protocol::new(config("kimi"));
    protocol.remote_id = "main".into();
    protocol.phase = 1;
    let events: Vec<_> = [
        chunk(Some("first"), "A"),
        chunk(Some("first"), "B"),
        chunk(Some("second"), "C"),
    ]
    .into_iter()
    .flat_map(|value| protocol.receive(value).unwrap().events)
    .collect();
    assert_eq!(starts(&events), ["first", "second"]);
    let text: String = events
        .iter()
        .filter(|event| event.kind == "text")
        .map(|event| event.text.as_str())
        .collect();
    assert_eq!(text, "ABC");
}

#[test]
fn legacy_acp_separates_text_around_tools_and_ignores_resume_history() {
    let mut protocol = Protocol::new(config("kimi"));
    protocol.remote_id = "main".into();
    assert!(protocol
        .receive(chunk(None, "history"))
        .unwrap()
        .events
        .is_empty());
    protocol.phase = 1;
    let first = protocol.receive(chunk(None, "Before")).unwrap().events;
    protocol.receive(json!({"method":"session/update","params":{"sessionId":"main","update":{"sessionUpdate":"tool_call","toolCallId":"read","title":"Read","status":"in_progress"}}})).unwrap();
    let second = protocol.receive(chunk(None, "After")).unwrap().events;
    assert_eq!(starts(&first).len(), 1);
    assert_eq!(starts(&second).len(), 1);
    assert_ne!(starts(&first), starts(&second));
    protocol.receive(json!({"method":"session/update","params":{"sessionId":"main","update":{"sessionUpdate":"tool_call_update","toolCallId":"read","status":"completed"}}})).unwrap();
    let continuation = protocol.receive(chunk(None, " completion")).unwrap().events;
    assert!(
        starts(&continuation).is_empty(),
        "late tool results must not split the answer"
    );
}

#[test]
fn foreign_sessions_nontext_content_and_thoughts_do_not_become_answer_text() {
    let mut protocol = Protocol::new(config("kimi"));
    protocol.remote_id = "main".into();
    protocol.phase = 1;
    let mut foreign = chunk(None, "foreign");
    foreign["params"]["sessionId"] = json!("child");
    assert!(protocol.receive(foreign).unwrap().events.is_empty());
    let mut image = chunk(None, "not text");
    image["params"]["update"]["content"]["type"] = json!("image");
    assert!(protocol.receive(image).unwrap().events.is_empty());
    let first = protocol.receive(chunk(None, "Commentary")).unwrap().events;
    let mut thinking = chunk(None, "internal thought");
    thinking["params"]["update"]["sessionUpdate"] = json!("agent_thought_chunk");
    assert!(protocol.receive(thinking).unwrap().events.iter().all(|e| e.kind == "thinking"));
    let answer = protocol.receive(chunk(None, "Answer")).unwrap().events;
    assert_ne!(starts(&first), starts(&answer));
}

#[test]
fn acp_thought_chunks_surface_as_thinking_events() {
    let mut protocol = Protocol::new(config("kimi"));
    protocol.remote_id = "main".into();
    protocol.phase = 1;
    let step = protocol.receive(json!({"method":"session/update","params":{"sessionId":"main","update":{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"Considering"}}}})).unwrap();
    assert!(step.events.iter().any(|e| e.kind == "thinking" && e.text == "Considering"));
}
