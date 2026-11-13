use super::*;

fn protocol() -> Protocol {
    let mut protocol = Protocol::new(RunConfig {
        session_id: "local".into(),
        provider: "codex".into(),
        model: "default".into(),
        reasoning_effort: None,
        mode: "ask".into(),
        cwd: PathBuf::from("/tmp"),
        resume_id: None,
        prompt: "Explain this project".into(),
        instructions: String::new(),
        skill: None,
        goal: None,
        codex_settings: None,
        images: Vec::new(),
    });
    protocol.remote_id = "main".into();
    protocol.turn_id = "turn-main".into();
    protocol
}

fn item(method: &str, id: &str, phase: &str, text: &str) -> Value {
    json!({"method":method,"params":{"threadId":"main","turnId":"turn-main","item":{"type":"agentMessage","id":id,"phase":phase,"text":text}}})
}

fn delta(id: &str, text: &str) -> Value {
    json!({"method":"item/agentMessage/delta","params":{"threadId":"main","turnId":"turn-main","itemId":id,"delta":text}})
}

fn text(step: &Step) -> String {
    step.events
        .iter()
        .filter(|event| event.kind == "text")
        .map(|event| event.text.as_str())
        .collect()
}

#[test]
fn commentary_and_final_messages_start_separately_before_their_text() {
    let mut p = protocol();
    let mut events = Vec::new();
    for envelope in [
        item("item/started", "commentary", "commentary", ""),
        delta("commentary", "Checking files."),
        item(
            "item/completed",
            "commentary",
            "commentary",
            "Checking files.",
        ),
        item("item/started", "answer", "final_answer", ""),
        delta("answer", "The issue is fixed."),
        item(
            "item/completed",
            "answer",
            "final_answer",
            "The issue is fixed.",
        ),
    ] {
        events.extend(p.receive(envelope).unwrap().events);
    }
    assert_eq!(
        events
            .iter()
            .map(|event| event.kind.as_str())
            .collect::<Vec<_>>(),
        ["message_start", "text", "message_start", "text"]
    );
    assert_eq!(events[1].text, "Checking files.");
    assert_eq!(events[3].text, "The issue is fixed.");
    assert_eq!(events[0].data.as_ref().unwrap()["messageId"], "commentary");
    assert_eq!(events[0].data.as_ref().unwrap()["phase"], "commentary");
    assert_eq!(events[2].data.as_ref().unwrap()["messageId"], "answer");
    assert_eq!(events[2].data.as_ref().unwrap()["phase"], "final_answer");
}

#[test]
fn child_thread_and_stale_turn_events_cannot_change_main_conversation() {
    for (thread_id, turn_id) in [("child", "turn-child"), ("main", "previous-turn")] {
        let mut p = protocol();
        for envelope in [
            json!({"method":"turn/started","params":{"threadId":thread_id,"turn":{"id":turn_id}}}),
            json!({"method":"item/agentMessage/delta","params":{"threadId":thread_id,"turnId":turn_id,"itemId":"foreign","delta":"Foreign response"}}),
            json!({"method":"item/completed","params":{"threadId":thread_id,"turnId":turn_id,"item":{"type":"agentMessage","id":"foreign","text":"Foreign snapshot"}}}),
            json!({"method":"item/started","params":{"threadId":thread_id,"turnId":turn_id,"item":{"type":"commandExecution","id":"foreign-tool","command":"pwd"}}}),
            json!({"method":"item/commandExecution/outputDelta","params":{"threadId":thread_id,"turnId":turn_id,"itemId":"foreign-tool","delta":"Foreign output"}}),
            json!({"method":"turn/completed","params":{"threadId":thread_id,"turn":{"id":turn_id,"status":"completed"}}}),
            json!({"method":"error","params":{"threadId":thread_id,"turnId":turn_id,"error":{"message":"Foreign failure"},"willRetry":false}}),
        ] {
            let step = p.receive(envelope).expect("unrelated failure is ignored");
            assert!(
                step.events.is_empty(),
                "foreign event reached main conversation"
            );
            assert!(!step.done, "foreign completion ended main turn");
            assert_eq!(p.turn_id, "turn-main");
        }
    }
}

#[test]
fn child_approval_requests_wait_for_the_user_and_preserve_the_rpc_id() {
    for method in [
        "item/commandExecution/requestApproval",
        "item/fileChange/requestApproval",
        "item/permissions/requestApproval",
    ] {
        for approved in [true, false] {
            let mut p = protocol();
            let rpc_id = json!(format!("child-{method}-{approved}"));
            let permissions = json!({"fileSystem":{"write":["/tmp"]}});
            let step = p.receive(json!({"id":rpc_id,"method":method,"params":{"threadId":"child","turnId":"child-turn","itemId":"tool","command":"pwd","permissions":permissions}})).unwrap();
            assert!(step.write.is_empty());
            assert_eq!(step.events.len(), 1);
            assert_eq!(step.events[0].kind, "approval");
            let request_id = step.events[0].request_id.as_ref().unwrap();
            assert_eq!(p.pending.len(), 1);
            let response = p.approve(request_id, approved).unwrap();
            assert_eq!(response["id"], rpc_id);
            assert!(p.pending.is_empty());
            assert!(p.approve(request_id, approved).is_none());
            let result = if method == "item/permissions/requestApproval" {
                json!({"permissions":if approved {permissions} else {json!({})},"scope":"turn"})
            } else {
                json!({"decision":if approved {"accept"} else {"decline"}})
            };
            assert_eq!(response["result"], result);
        }
    }
}

#[test]
fn unknown_foreign_requests_receive_an_error_without_entering_pending_queue() {
    let mut p = protocol();
    let step = p.receive(json!({"id":77,"method":"item/unknownInteractiveRequest","params":{"threadId":"child","turnId":"child-turn","itemId":"tool"}})).unwrap();
    assert!(step.events.is_empty());
    assert!(p.pending.is_empty());
    assert_eq!(step.write.len(), 1);
    assert_eq!(step.write[0]["id"], 77);
    assert_eq!(step.write[0]["error"]["code"], -32602);
}

#[test]
fn repeated_completed_snapshots_are_not_duplicated_without_deltas() {
    let mut p = protocol();
    let envelope = item(
        "item/completed",
        "answer",
        "final_answer",
        "A complete answer.",
    );
    assert_eq!(
        text(&p.receive(envelope.clone()).unwrap()),
        "A complete answer."
    );
    assert!(p.receive(envelope).unwrap().events.is_empty());
}

#[test]
fn completion_recovers_only_the_missing_streamed_suffix() {
    let mut p = protocol();
    assert_eq!(
        text(&p.receive(delta("answer", "Hello ")).unwrap()),
        "Hello "
    );
    let completed = p
        .receive(item(
            "item/completed",
            "answer",
            "final_answer",
            "Hello world.",
        ))
        .unwrap();
    assert_eq!(text(&completed), "world.");
    assert!(completed
        .events
        .iter()
        .all(|event| event.kind != "message_start"));
    assert!(p
        .receive(item(
            "item/completed",
            "answer",
            "final_answer",
            "Hello world."
        ))
        .unwrap()
        .events
        .is_empty());
}

#[test]
fn empty_delta_does_not_discard_the_completed_answer() {
    let mut p = protocol();
    assert!(p.receive(delta("answer", "")).unwrap().events.is_empty());
    assert_eq!(
        text(
            &p.receive(item("item/completed", "answer", "final_answer", "Answer."))
                .unwrap()
        ),
        "Answer."
    );
}

#[test]
fn notifications_without_routing_ids_keep_legacy_compatibility() {
    let mut p = protocol();
    let step = p.receive(json!({"method":"item/agentMessage/delta","params":{"itemId":"answer","delta":"Legacy answer."}})).unwrap();
    assert_eq!(text(&step), "Legacy answer.");
    assert!(
        p.receive(json!({"method":"turn/completed","params":{"turn":{"status":"completed"}}}))
            .unwrap()
            .done
    );
}

#[test]
fn reasoning_summary_deltas_surface_as_thinking_events() {
    let mut p = protocol();
    let mut thinking = String::new();
    for frame in [
        json!({"method":"item/reasoning/summaryTextDelta","params":{"threadId":"main","turnId":"turn-main","itemId":"r1","delta":"Plan","summaryIndex":0}}),
        json!({"method":"item/reasoning/summaryPartAdded","params":{"threadId":"main","turnId":"turn-main","itemId":"r1","summaryIndex":1}}),
        json!({"method":"item/reasoning/summaryTextDelta","params":{"threadId":"main","turnId":"turn-main","itemId":"r1","delta":"Act","summaryIndex":1}}),
    ] {
        for event in p.receive(frame).unwrap().events {
            assert_eq!(event.kind, "thinking");
            thinking.push_str(&event.text);
        }
    }
    assert_eq!(thinking, "Plan\n\nAct");
}

fn tool_item(p: &mut Protocol, method: &str, item: Value) -> ToolActivity {
    let step = p.receive(json!({"method":method,"params":{"threadId":"main","turnId":"turn-main","item":item}})).unwrap();
    step.events.iter().rev().find_map(|event| event.tool.clone()).expect("tool event")
}

#[test]
fn image_view_items_keep_the_viewed_path() {
    let mut p = protocol();
    let item = json!({"type":"imageView","id":"img1","path":"/tmp/shot.png"});
    let started = tool_item(&mut p, "item/started", item.clone());
    assert_eq!((started.name.as_str(), started.status.as_str()), ("View image", "running"));
    let done = tool_item(&mut p, "item/completed", item);
    assert_eq!(done.name, "View image");
    assert_eq!(done.status, "completed");
    assert_eq!(serde_json::from_str::<Value>(&done.input).unwrap(), json!({"path":"/tmp/shot.png"}));
    assert!(done.input.contains('\n'), "pretty JSON like other inputs");
    assert_eq!(done.output, "");
}

#[test]
fn web_search_items_keep_query_action_and_result_links() {
    let mut p = protocol();
    let started = tool_item(&mut p, "item/started", json!({"type":"webSearch","id":"ws1","query":""}));
    assert_eq!((started.name.as_str(), started.input.as_str()), ("web_search", ""));
    let done = tool_item(&mut p, "item/completed", json!({
        "type":"webSearch","id":"ws1","query":"rust serde",
        "action":{"type":"search","query":"rust serde","queries":["rust serde","serde json"],"secret":{"nested":"HIDDEN"}},
        "results":[
            {"title":"Serde","url":"https://serde.rs","extra":{"nested":"HIDDEN"}},
            {"url":"https://docs.rs/serde"},
            {"title":"No url"}
        ]
    }));
    assert_eq!(done.name, "web_search");
    assert_eq!(done.status, "completed");
    assert_eq!(serde_json::from_str::<Value>(&done.input).unwrap(), json!({
        "query":"rust serde",
        "action":{"type":"search","query":"rust serde","queries":["rust serde","serde json"]}
    }));
    let links = done.output.strip_prefix("Links: ").expect("Links prefix");
    assert_eq!(serde_json::from_str::<Value>(links).unwrap(), json!([
        {"title":"Serde","url":"https://serde.rs"},
        {"title":"https://docs.rs/serde","url":"https://docs.rs/serde"}
    ]));
    assert!(!done.output.contains("HIDDEN") && !done.input.contains("HIDDEN"));
}

#[test]
fn web_search_without_results_has_empty_output_and_bounded_links() {
    let mut p = protocol();
    let done = tool_item(&mut p, "item/completed", json!({"type":"webSearch","id":"ws2","query":"q","action":{"type":"openPage","url":"https://example.com"}}));
    assert_eq!(serde_json::from_str::<Value>(&done.input).unwrap(), json!({"query":"q","action":{"type":"openPage","url":"https://example.com"}}));
    assert_eq!(done.output, "");
    let many: Vec<Value> = (0..50).map(|i| json!({"title":"t".repeat(300),"url":format!("https://example.com/{i}/{}", "p".repeat(400))})).collect();
    let done = tool_item(&mut p, "item/completed", json!({"type":"webSearch","id":"ws3","query":"q","results":many}));
    assert!(done.output.len() <= TOOL_OUTPUT_LIMIT);
    let links: Vec<Value> = serde_json::from_str(done.output.strip_prefix("Links: ").unwrap()).unwrap();
    assert!(!links.is_empty() && links.len() < 50);
}

#[test]
fn sleep_and_agent_items_keep_named_fields() {
    let mut p = protocol();
    let sleep = tool_item(&mut p, "item/completed", json!({"type":"sleep","id":"s1","durationMs":1500}));
    assert_eq!(sleep.name, "sleep");
    assert_eq!(serde_json::from_str::<Value>(&sleep.input).unwrap(), json!({"durationMs":1500}));
    let agent = tool_item(&mut p, "item/completed", json!({
        "type":"collabAgentToolCall","id":"a1","tool":"spawnAgent","status":"completed","senderThreadId":"main",
        "prompt":"Review the diff","model":"gpt-5","receiverThreadIds":["child"],
        "agentsStates":{"child":{"status":"completed","message":"Looks good"}}
    }));
    assert_eq!(agent.name, "Agent · spawnAgent");
    assert_eq!(serde_json::from_str::<Value>(&agent.input).unwrap(), json!({"prompt":"Review the diff","model":"gpt-5","receiverThreadIds":["child"]}));
    assert_eq!(agent.output, "child: completed — Looks good");
    let unknown = tool_item(&mut p, "item/completed", json!({"type":"futureThing","id":"u1","payload":{"secret":"HIDDEN"}}));
    assert_eq!((unknown.name.as_str(), unknown.input.as_str(), unknown.output.as_str()), ("futureThing", "", ""));
}
