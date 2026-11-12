//! Approval-gated MCP tools: scoped approval, denial, modes, expiry and cancellation.
use super::*;

#[tokio::test]
async fn protected_mcp_tools_wait_for_scoped_approval_and_honor_denial() {
    for mode in ["ask", "auto", "accept"] {
        for approved in [true, false] {
            let count = Arc::new(AtomicUsize::new(0));
            let called = count.clone();
            let mut protected = host();
            protected.approval_tools.insert("pandacode_delegate".into());
            protected.handler = Arc::new(move |_, _| {
                called.fetch_add(1, Ordering::SeqCst);
                Box::pin(async { Ok(json!({"started":true})) })
            });
            let (sender, mut events) = tokio::sync::mpsc::unbounded_channel();
            let server = Server::start_with_approvals(
                protected,
                "task".into(),
                Arc::new(move |event| {
                    let _ = sender.send(event);
                }),
                mode,
            )
            .await
            .unwrap();
            let request = request(&server, call(json!(1), json!({})), "");
            let answer = async {
                let pending = loop {
                    let event = tokio::time::timeout(Duration::from_secs(2), events.recv())
                        .await
                        .unwrap()
                        .unwrap();
                    if event.kind == "approval" {
                        break event.request_id.unwrap();
                    }
                };
                assert_eq!(
                    count.load(Ordering::SeqCst),
                    0,
                    "callback must not precede approval"
                );
                assert!(!server.approve("different-request", true));
                assert!(server.approve(&pending, approved));
                assert!(!server.approve(&pending, true), "approval is single use");
            };
            let ((code, result), ()) = tokio::join!(request, answer);
            assert_eq!(code, 200);
            assert_eq!(result["result"]["isError"], !approved);
            assert_eq!(count.load(Ordering::SeqCst), usize::from(approved));
            assert!(server.current().approvals.lock().unwrap().is_empty());
        }
    }
}
/// The approval of an agent-made tool shows its script, hands that snapshot to the
/// handler, ignores an id the agent made up, and refuses an unknown tool without asking.
#[tokio::test]
async fn an_agent_made_tool_runs_the_script_its_approval_showed() {
    let temp = crate::custom_tools::temp();
    let base = temp.0.clone();
    let root = base.join("root");
    std::fs::create_dir_all(&root).unwrap();
    crate::custom_tools::test_save(&base, "p1", "show-it", "echo approved");
    let session = format!("mcp-tools-{}", uuid::Uuid::new_v4());
    let tools = crate::custom_tools::test_host(base.clone(), "p1", root.clone(), &session, "ask");
    let (sender, mut events) = tokio::sync::mpsc::unbounded_channel();
    let server = Server::start_with_approvals(tools, session.clone(), Arc::new(move |event| {
        let _ = sender.send(event);
    }), "ask").await.unwrap();
    let run = |id: u64, name: &str| json!({"jsonrpc":"2.0","id":id,"method":"tools/call","params":{"name":"pandacode_tool_run","arguments":{"name":name,"_pandacodeApproval":"made-up"}}});
    let first = request(&server, run(1, "show-it"), "");
    let answer = async {
        let event = loop {
            let event = tokio::time::timeout(Duration::from_secs(5), events.recv()).await.unwrap().unwrap();
            if event.kind == "approval" {
                break event;
            }
        };
        assert!(event.text.contains("Script (v1):\n```sh\necho approved\n```"), "{}", event.text);
        // Saved again while the approval waits: what was shown still runs.
        crate::custom_tools::test_save(&base, "p1", "show-it", "echo swapped");
        assert!(server.approve(event.request_id.as_deref().unwrap(), true));
    };
    let ((_, result), ()) = tokio::join!(first, answer);
    let text = result["result"]["content"][0]["text"].as_str().unwrap().to_owned();
    assert!(text.contains(r#""stdout":"approved\n""#), "{text}");
    let (_, missing) = request(&server, run(2, "nope"), "").await;
    assert_eq!(missing["result"]["isError"], true);
    assert_eq!(missing["result"]["content"][0]["text"], "No tool named nope in this project.");
    while let Ok(event) = events.try_recv() {
        assert_ne!(event.kind, "approval", "an unknown tool is refused without a prompt");
    }
    crate::custom_tools::run_ended(&session);
}
#[tokio::test]
async fn protected_mcp_tools_never_execute_in_plan_and_full_mode_needs_no_prompt() {
    for mode in ["plan", "full"] {
        let count = Arc::new(AtomicUsize::new(0));
        let called = count.clone();
        let mut protected = host();
        protected.approval_tools.insert("pandacode_delegate".into());
        protected.handler = Arc::new(move |_, _| {
            called.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Ok(json!({})) })
        });
        let server = Server::start_with_approvals(
            protected,
            "task".into(),
            Arc::new(|event| assert_ne!(event.kind, "approval")),
            mode,
        )
        .await
        .unwrap();
        let (_, result) = request(&server, call(json!(1), json!({})), "").await;
        assert_eq!(result["result"]["isError"], mode == "plan");
        assert_eq!(count.load(Ordering::SeqCst), usize::from(mode == "full"));
    }
}
#[tokio::test]
async fn a_call_the_client_gave_up_on_expires_its_approval() {
    let count = Arc::new(AtomicUsize::new(0));
    let called = count.clone();
    let mut protected = host();
    protected.approval_tools.insert("pandacode_delegate".into());
    protected.handler = Arc::new(move |_, _| {
        called.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Ok(json!({})) })
    });
    let (sender, mut events) = tokio::sync::mpsc::unbounded_channel();
    let server = Server::start_with_approvals(protected, "task".into(), Arc::new(move |event| { let _ = sender.send(event); }), "ask").await.unwrap();
    let body = serde_json::to_vec(&call(json!(1), json!({}))).unwrap();
    let mut stream = TcpStream::connect(&server.authority).await.unwrap();
    stream.write_all(format!("POST /mcp HTTP/1.1\r\nHost: {}\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n", server.authority, server.token, body.len()).as_bytes()).await.unwrap();
    stream.write_all(&body).await.unwrap();
    async fn next(events: &mut tokio::sync::mpsc::UnboundedReceiver<AgentEvent>, kind: &str) -> String {
        loop {
            let event = tokio::time::timeout(Duration::from_secs(2), events.recv()).await.unwrap().unwrap();
            if event.kind == kind { break event.request_id.unwrap(); }
        }
    }
    let pending = next(&mut events, "approval").await;
    // The harness timed out the call and closed its connection.
    drop(stream);
    assert_eq!(next(&mut events, "approval_cancelled").await, pending);
    assert!(!server.approve(&pending, true), "a late Approve finds nothing");
    tokio::task::yield_now().await;
    assert_eq!(count.load(Ordering::SeqCst), 0);
}
#[tokio::test]
async fn cloud_cli_asks_even_in_full_mode() {
    let name = "pandacode_cloud_cli";
    let count = Arc::new(AtomicUsize::new(0));
    let called = count.clone();
    let protected = ToolHost {
        tools: vec![json!({"type":"function","name":name,"description":"Deploy","inputSchema":{"type":"object"}})],
        approval_tools: [name.into()].into(),
        handler: Arc::new(move |_, _| {
            called.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Ok(json!({})) })
        }),
    };
    let (sender, mut events) = tokio::sync::mpsc::unbounded_channel();
    let server = Server::start_with_approvals(protected, "task".into(), Arc::new(move |event| { let _ = sender.send(event); }), "full").await.unwrap();
    let request = request(&server, json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":name,"arguments":{}}}), "");
    let answer = async {
        let pending = loop {
            let event = tokio::time::timeout(Duration::from_secs(2), events.recv()).await.unwrap().unwrap();
            if event.kind == "approval" { break event.request_id.unwrap(); }
        };
        assert_eq!(count.load(Ordering::SeqCst), 0);
        assert!(server.approve(&pending, false));
    };
    let ((_, result), ()) = tokio::join!(request, answer);
    assert_eq!(result["result"]["isError"], true);
    assert_eq!(count.load(Ordering::SeqCst), 0);
}
#[tokio::test]
async fn cancelling_pending_mcp_approval_revokes_it_without_calling_handler() {
    let mut protected = host();
    protected.approval_tools.insert("pandacode_delegate".into());
    let (sender, mut events) = tokio::sync::mpsc::unbounded_channel();
    let server = Server::start_with_approvals(
        protected,
        "task".into(),
        Arc::new(move |event| {
            let _ = sender.send(event);
        }),
        "ask",
    )
    .await
    .unwrap();
    let args = json!({});
    let context = server.current();
    let mut authorization = Box::pin(context.authorize("pandacode_delegate", args.clone()));
    let event = tokio::select! {
        _ = &mut authorization => panic!("Approval resolved before user input"),
        event = events.recv() => event.unwrap(),
    };
    let id = event.request_id.unwrap();
    drop(authorization);
    assert!(!server.approve(&id, true));
    assert!(server.current().approvals.lock().unwrap().is_empty());
    assert_eq!(events.recv().await.unwrap().kind, "approval_cancelled");
}
