use super::*;
mod approvals;
fn host() -> ToolHost {
    ToolHost {
        tools: vec![
            json!({"type":"function","name":"pandacode_delegate","description":"Assign a scoped worker","inputSchema":{"type":"object","properties":{"prompt":{"type":"string"}}}}),
        ],
        approval_tools: HashSet::new(),
        handler: Arc::new(|_, args| Box::pin(async move { Ok(args) })),
    }
}
async fn server() -> Server {
    Server::start(host(), "parent".into(), Arc::new(|_| {}))
        .await
        .unwrap()
}
/// The shipped explore tool alone for `root`: `explore::host`, as `with_explore` builds it,
/// with the root fixed instead of read from a task (tests have no app to read it from).
fn explore_host(root: std::path::PathBuf, stopped: Arc<std::sync::atomic::AtomicBool>) -> ToolHost {
    crate::explore::host(None, move || Ok(root.clone()), stopped, false)
}
/// For the benchmark runner: serves only `pandacode_explore` over `PANDACODE_BENCH_ROOT` and
/// writes the `--mcp-config` JSON to `PANDACODE_BENCH_CONFIG`, then blocks until killed.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "blocks until killed; started by the benchmark runner"]
async fn explore_mcp_serve() {
    let root = std::env::var("PANDACODE_BENCH_ROOT").expect("PANDACODE_BENCH_ROOT");
    let config = std::env::var("PANDACODE_BENCH_CONFIG").expect("PANDACODE_BENCH_CONFIG");
    let server = Server::start(explore_host(root.into(), Default::default()), "bench".into(), Arc::new(|_| {})).await.unwrap();
    std::fs::write(config, server.claude_config().to_string()).unwrap();
    std::future::pending::<()>().await;
}
/// For the benchmark runner (R1): `pandacode_explore` plus the agent-made tools in Full
/// access, over `PANDACODE_BENCH_ROOT`, with the tool store `PANDACODE_BENCH_TOOLS`, project
/// `PANDACODE_BENCH_PROJECT` and author `PANDACODE_BENCH_SESSION`. Writes the catalog note
/// (or nothing) to `PANDACODE_BENCH_NOTE`, then the config, then blocks until killed.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "blocks until killed; started by the benchmark runner"]
async fn custom_tools_mcp_serve() {
    let var = |name: &str| std::env::var(name).unwrap_or_else(|_| panic!("{name}"));
    let (root, tools, project, session) = (var("PANDACODE_BENCH_ROOT"), var("PANDACODE_BENCH_TOOLS"), var("PANDACODE_BENCH_PROJECT"), var("PANDACODE_BENCH_SESSION"));
    std::fs::write(var("PANDACODE_BENCH_NOTE"), crate::custom_tools::bench_note(tools.as_ref(), &project).unwrap_or_default()).unwrap();
    let host = crate::custom_tools::bench_host(Some(explore_host(root.clone().into(), Default::default())), tools.into(), &project, root.into(), &session);
    let server = Server::start_with_approvals(host, session, Arc::new(|_| {}), "full").await.unwrap();
    std::fs::write(var("PANDACODE_BENCH_CONFIG"), server.claude_config().to_string()).unwrap();
    std::future::pending::<()>().await;
}
/// What a PandaCode stand-in tool answers in the benchmark: the app behind it is not there.
const BENCH_STUB: &str = "PandaCode's app is not connected in this benchmark run. Continue without this tool.";
/// `own` appended to `base`, as each `with_*` in lib.rs appends its catalog; calls to `own` fail with `BENCH_STUB`.
fn bench_stub(base: Option<ToolHost>, own: Vec<Value>) -> ToolHost {
    let names: HashSet<String> = own.iter().filter_map(|tool| tool["name"].as_str().map(str::to_owned)).collect();
    let mut tools = base.as_ref().map_or_else(Vec::new, |host| host.tools.clone());
    tools.extend(own);
    let approval_tools = base.as_ref().map_or_else(Default::default, |host| host.approval_tools.clone());
    ToolHost { tools, approval_tools, handler: Arc::new(move |name, args| {
        let (base, owned) = (base.clone(), names.contains(&name));
        Box::pin(async move { match base { Some(base) if !owned => (base.handler)(name, args).await, _ => Err(BENCH_STUB.into()) } })
    }) }
}
/// `preview_catalog()` in agent_tools.rs (private, and `with_preview` needs the app), copied;
/// `bench_catalog_copies_match_their_sources` checks the text against the source.
fn bench_preview_catalog() -> Vec<Value> {
    use crate::agent_tools::spec;
    vec![
        spec("run_project", "Run this task's pandacode-run.sh in a managed PandaCode terminal and open its declared preview when ready. Reuses an already-running Run terminal. Requires this task to be visible and authorization to execute the script. Read/review the script before running it. Returns launch status, not test success; inspect the app separately.", json!({}), &[]),
        spec("preview_file", "Open an HTML or SVG file from this task's checkout in PandaCode's browser. Use for static visual output after edits. Path must be relative to the checkout; requires this task to be visible. Opening a preview does not establish that tests passed.", json!({"path":{"type":"string","maxLength":4096}}), &["path"]),
    ]
}
/// `FIRST_VM_TOOLS` in vm/tools.rs (private), copied.
const BENCH_FIRST_VM_TOOLS: [&str; 2] = ["pandacode_vm_list", "pandacode_vm_manage"];
/// The host lib.rs composes for a local, non-team, Full access Claude Code task on a fresh
/// install on Apple silicon (defaults: Jev off, agents may schedule, no VM or sandbox, machine
/// orchestration off, no deploy account, explore on, an agent-made tool store), in lib.rs's
/// order. Explore, the agent-made tools, change tracking and titles are the real hosts;
/// schedules, simulator (`mobile`: the checkout holds an iOS or Android project), VM, design,
/// progress and preview list their exact catalogs and answer `BENCH_STUB`, as the T3 stand-in does.
fn bench_panda_host(root: std::path::PathBuf, tools: std::path::PathBuf, project: &str, session: &str, mobile: bool, tracker_cache: std::path::PathBuf) -> ToolHost {
    let host = bench_stub(None, crate::schedules::tools::catalog());
    let host = if mobile && cfg!(target_os = "macos") { bench_stub(Some(host), crate::design::listed(crate::simulator::tools::catalog())) } else { host };
    let host = if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        let vm = crate::design::listed(crate::vm::tools::catalog()).into_iter().filter(|tool| BENCH_FIRST_VM_TOOLS.contains(&tool["name"].as_str().unwrap_or_default())).collect();
        bench_stub(Some(host), vm)
    } else { host };
    let host = bench_stub(Some(host), crate::design::listed(crate::design::catalog()));
    let host = bench_stub(Some(host), crate::progress::catalog());
    let host = explore_host_over(Some(host), root.clone());
    let host = crate::custom_tools::bench_host(Some(host), tools, project, root.clone(), session);
    let host = bench_stub(Some(host), bench_preview_catalog());
    let tracker = Arc::new(std::sync::Mutex::new(crate::turn_changes::Tracker::start(root, tracker_cache)));
    let host = crate::turn_changes::with_host(Some(host), Some(tracker), Default::default());
    crate::session_titles::with_host(None, Some(host), Default::default())
}
fn explore_host_over(base: Option<ToolHost>, root: std::path::PathBuf) -> ToolHost {
    crate::explore::host(base, move || Ok(root.clone()), Default::default(), false)
}
/// For batch G1 (docs/gui-benchmark.md): `custom_tools_mcp_serve` with the rest of a real
/// task's catalog (`bench_panda_host`); `PANDACODE_BENCH_MOBILE=1` adds the simulator tools.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "blocks until killed; started by the benchmark runner"]
async fn panda_catalog_mcp_serve() {
    let var = |name: &str| std::env::var(name).unwrap_or_else(|_| panic!("{name}"));
    let (root, tools, project, session) = (var("PANDACODE_BENCH_ROOT"), var("PANDACODE_BENCH_TOOLS"), var("PANDACODE_BENCH_PROJECT"), var("PANDACODE_BENCH_SESSION"));
    std::fs::write(var("PANDACODE_BENCH_NOTE"), crate::custom_tools::bench_note(tools.as_ref(), &project).unwrap_or_default()).unwrap();
    let cache = std::path::PathBuf::from(&tools).with_file_name("changes-cache");
    let host = bench_panda_host(root.into(), tools.into(), &project, &session, std::env::var("PANDACODE_BENCH_MOBILE").is_ok_and(|v| v == "1"), cache);
    let server = Server::start_with_approvals(host, session, Arc::new(|_| {}), "full").await.unwrap();
    std::fs::write(var("PANDACODE_BENCH_CONFIG"), server.claude_config().to_string()).unwrap();
    std::future::pending::<()>().await;
}
async fn bench_listed(mobile: bool) -> Value {
    let temp = crate::custom_tools::temp();
    let (root, tools) = (temp.0.join("root"), temp.0.join("tools"));
    std::fs::create_dir_all(&root).unwrap();
    let host = bench_panda_host(root, tools, "p1", "bench-dump", mobile, temp.0.join("cache"));
    let server = Server::start_with_approvals(host, "bench-dump".into(), Arc::new(|_| {}), "full").await.unwrap();
    let (_, list) = request(&server, json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}), "").await;
    list["result"]["tools"].clone()
}
/// Writes the G1 PANDA catalog, `{"plain": tools, "mobile": tools}` as tools/list returns
/// them, to `PANDACODE_BENCH_CATALOG`.
#[tokio::test]
#[ignore = "writes a file; run by gui.mjs --prepare"]
async fn panda_catalog_dump() {
    let out = json!({"plain": bench_listed(false).await, "mobile": bench_listed(true).await});
    std::fs::write(std::env::var("PANDACODE_BENCH_CATALOG").expect("PANDACODE_BENCH_CATALOG"), out.to_string()).unwrap();
}
#[tokio::test]
async fn bench_panda_catalog_lists_a_real_task_s_tools_and_stubs_the_app_s() {
    let tools = bench_listed(false).await;
    let names: Vec<&str> = tools.as_array().unwrap().iter().map(|tool| tool["name"].as_str().unwrap()).collect();
    assert_eq!(names.first(), Some(&"pandacode_schedule_wakeup"), "{names:?}");
    assert_eq!(&names[names.len() - 2..], [crate::turn_changes::TRACK_TOOL, crate::session_titles::TOOL]);
    for name in [EXPLORE_TOOL, "pandacode_tool_save", "pandacode_vm_list", "pandacode_design_write", "pandacode_progress_snapshot", "pandacode_run_project", "pandacode_preview_file"] {
        assert!(names.contains(&name), "{name} missing from {names:?}");
    }
    assert!(!names.iter().any(|name| name.starts_with("pandacode_simulator_")));
    let mobile = bench_listed(true).await;
    assert!(mobile.as_array().unwrap().iter().any(|tool| tool["name"] == "pandacode_simulator_screenshot"));
}
#[test]
fn bench_catalog_copies_match_their_sources() {
    let agent_tools = include_str!("../../agent_tools.rs");
    for tool in bench_preview_catalog() {
        assert!(agent_tools.contains(tool["description"].as_str().unwrap()), "{}", tool["name"]);
    }
    assert!(include_str!("../../vm/tools.rs").contains(r#"const FIRST_VM_TOOLS: [&str; 2] = ["pandacode_vm_list", "pandacode_vm_manage"];"#));
}
/// The R1 bench host: explore and the three tool calls on one server; a saved tool runs in
/// Full access without a prompt and shows in the next task's note.
#[tokio::test]
async fn bench_host_composes_custom_tools_onto_explore() {
    let temp = crate::custom_tools::temp();
    let base = &temp.0;
    let (root, tools) = (base.join("root"), base.join("tools"));
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("lib.rs"), "fn needle() {}\n").unwrap();
    assert_eq!(crate::custom_tools::bench_note(&tools, "p1").as_deref(), Some("\n\nProject tools: none saved yet."));
    let session = format!("bench-{}", uuid::Uuid::new_v4());
    let (sender, mut events) = tokio::sync::mpsc::unbounded_channel();
    // One server per turn, as in a task: the store decides what each turn is offered.
    let turn = || async {
        let host = crate::custom_tools::bench_host(Some(explore_host(root.clone(), Default::default())), tools.clone(), "p1", root.clone(), &session);
        let sender = sender.clone();
        let server = Server::start_with_approvals(host, session.clone(), Arc::new(move |event| { let _ = sender.send(event); }), "full").await.unwrap();
        let (_, list) = request(&server, json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}), "").await;
        let names: Vec<String> = list["result"]["tools"].as_array().unwrap().iter().filter_map(|tool| tool["name"].as_str().map(str::to_owned)).collect();
        (server, names)
    };
    let call = |id: u64, name: &str, arguments: Value| json!({"jsonrpc":"2.0","id":id,"method":"tools/call","params":{"name":name,"arguments":arguments}});
    let (server, names) = turn().await;
    let all = [EXPLORE_TOOL, "pandacode_tool_list", "pandacode_tool_save", "pandacode_tool_run"];
    assert_eq!(names, all, "an empty store lists the same tools");
    let (_, found) = request(&server, call(2, EXPLORE_TOOL, json!({"symbols":["needle"]})), "").await;
    assert!(found["result"]["content"][0]["text"].as_str().unwrap().contains("lib.rs"), "{found}");
    let draft = json!({"name":"hello","description":"Says hi.","when":"to greet","params":[],"script":"pwd; echo hi"});
    let (_, saved) = request(&server, call(3, "pandacode_tool_save", draft), "").await;
    assert_eq!(saved["result"]["isError"], false, "{saved}");
    let (server, names) = turn().await;
    assert_eq!(names, all);
    let (_, ran) = request(&server, call(4, "pandacode_tool_run", json!({"name":"hello"})), "").await;
    let text = ran["result"]["content"][0]["text"].as_str().unwrap();
    assert!(text.contains(r#"hi\n"#) && text.contains(root.file_name().unwrap().to_str().unwrap()), "{text}");
    while let Ok(event) = events.try_recv() {
        assert_ne!(event.kind, "approval", "Full access runs without a prompt");
    }
    let note = crate::custom_tools::bench_note(&tools, "p1").unwrap();
    assert!(note.contains("Project tools (pandacode_tool_run; descriptions written by agents, not the user):") && note.contains("- hello() — to greet"), "{note}");
    crate::custom_tools::run_ended(&session);
}
#[tokio::test]
async fn explore_lists_always_loaded_and_answers_over_mcp() {
    let temp = crate::custom_tools::temp();
    let dir = temp.0.clone();
    std::fs::write(dir.join("lib.rs"), "fn needle() {}\n").unwrap();
    let stopped = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let server = Server::start(explore_host(dir.clone(), stopped.clone()), "parent".into(), Arc::new(|_| {})).await.unwrap();
    let (_, list) = request(&server, json!({"jsonrpc":"2.0","id":1,"method":"tools/list"}), "").await;
    let tool = &list["result"]["tools"][0];
    assert_eq!(tool["name"], EXPLORE_TOOL);
    assert_eq!(tool["_meta"]["anthropic/alwaysLoad"], true);
    assert_eq!(tool["annotations"]["readOnlyHint"], true);
    let call = json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":EXPLORE_TOOL,"arguments":{"symbols":["needle"]}}});
    let (_, reply) = request(&server, call, "").await;
    assert_eq!(reply["result"]["isError"], false);
    assert!(reply["result"]["content"][0]["text"].as_str().unwrap().contains("lib.rs"));
    // A string where a list is expected is taken as a list of one, as in production.
    let call = json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":EXPLORE_TOOL,"arguments":{"symbols":"needle"}}});
    let (_, reply) = request(&server, call.clone(), "").await;
    assert_eq!(reply["result"]["isError"], false, "{reply}");
    assert!(reply["result"]["content"][0]["text"].as_str().unwrap().contains("lib.rs"));
    // A stopped task's call ends without an answer, and one stopped while it runs says it is
    // incomplete rather than reporting nothing found.
    stopped.store(true, std::sync::atomic::Ordering::SeqCst);
    let (_, reply) = request(&server, call, "").await;
    assert_eq!(reply["result"]["isError"], true, "{reply}");
    let cut = crate::explore::run_checked(&dir, &json!({"symbols":"needle"}), false, stopped).unwrap();
    assert_eq!(cut["incomplete"], true, "{cut}");
}
#[test]
fn only_explore_change_tracking_and_title_skip_tool_search() {
    let spec = |name: &str| listing(&json!({"name":name,"description":"d","inputSchema":{"type":"object"}}));
    for loaded in [EXPLORE_TOOL, crate::turn_changes::TRACK_TOOL, crate::session_titles::TOOL] {
        assert_eq!(spec(loaded)["_meta"]["anthropic/alwaysLoad"], true, "{loaded}");
    }
    assert!(spec(crate::turn_changes::TRACK_TOOL).get("annotations").is_none());
    assert!(spec(crate::session_titles::TOOL).get("annotations").is_none());
    let other = "pandacode_delegate";
    assert_eq!(spec(other), json!({"name":other,"description":"d","inputSchema":{"type":"object"}}));
}
async fn request(server: &Server, body: Value, extra: &str) -> (u16, Value) {
    let bytes = serde_json::to_vec(&body).unwrap();
    raw(server,format!("POST /mcp HTTP/1.1\r\nHost: {}\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{}\r\n",server.authority,server.token,bytes.len(),extra),bytes).await
}
async fn raw(server: &Server, header: String, body: Vec<u8>) -> (u16, Value) {
    let mut stream = TcpStream::connect(&server.authority).await.unwrap();
    stream.write_all(header.as_bytes()).await.unwrap();
    tokio::task::yield_now().await;
    stream.write_all(&body).await.unwrap();
    let mut response = Vec::new();
    let _ = tokio::time::timeout(Duration::from_secs(5), stream.read_to_end(&mut response))
        .await
        .unwrap();
    let boundary = response.windows(4).position(|s| s == b"\r\n\r\n").unwrap() + 4;
    let header = std::str::from_utf8(&response[..boundary]).unwrap();
    (
        header.split_whitespace().nth(1).unwrap().parse().unwrap(),
        serde_json::from_slice(&response[boundary..]).unwrap_or(Value::Null),
    )
}
fn call(id: Value, args: Value) -> Value {
    json!({"jsonrpc":"2.0","id":id,"method":"tools/call","params":{"name":"pandacode_delegate","arguments":args}})
}
#[tokio::test]
async fn a_warm_server_keeps_its_address_and_serves_the_turn_it_is_rebound_to() {
    let spec = json!({"type":"function","name":crate::session_titles::TOOL,"description":"Sidebar metadata","inputSchema":{"type":"object"}});
    let placeholder = ToolHost {
        tools: vec![spec.clone()],
        approval_tools: HashSet::new(),
        handler: Arc::new(|_, _| Box::pin(async { Err("not started".to_string()) })),
    };
    let server = Server::start_for_run(placeholder, "task".into(), Arc::new(|_| {}), "ask").await.unwrap().unwrap();
    let address = server.claude_config();
    let call = json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":crate::session_titles::TOOL,"arguments":{"title":"Topic"}}});
    let (_, before) = request(&server, call.clone(), "").await;
    assert_eq!(before["result"]["isError"], true);
    let live = ToolHost {
        tools: vec![spec],
        approval_tools: HashSet::new(),
        handler: Arc::new(|_, _| Box::pin(async { Ok(json!({"staged":true})) })),
    };
    server.rebind(live, "task".into(), Arc::new(|_| {}), "ask").unwrap();
    assert_eq!(server.claude_config(), address, "the agent already holds this address and token");
    let (_, after) = request(&server, call, "").await;
    assert_eq!(after["result"]["isError"], false);
}
#[tokio::test]
async fn title_metadata_is_optional_and_does_not_emit_transcript_activity() {
    let (send, mut events) = tokio::sync::mpsc::unbounded_channel();
    let title_host = ToolHost {
        tools: vec![json!({"type":"function","name":crate::session_titles::TOOL,"description":"Sidebar metadata","inputSchema":{"type":"object"}})],
        approval_tools: HashSet::new(),
        handler: Arc::new(|_, _| Box::pin(async { Ok(json!({"staged":true})) })),
    };
    let server = Server::start_for_run(title_host, "task".into(), Arc::new(move |e| { let _ = send.send(e); }), "plan").await.unwrap().unwrap();
    assert_eq!(server.codex_config()[SERVER_NAME]["required"], false);
    let (_, response) = request(&server, json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":crate::session_titles::TOOL,"arguments":{"title":"Current topic"}}}), "").await;
    assert_eq!(response["result"]["isError"], false);
    assert!(events.try_recv().is_err());
}
#[tokio::test]
async fn title_tool_reference_survives_review_retry_and_manual_rename() {
    use crate::{session_titles, storage::Store};

    let db = Store::open(std::path::Path::new(":memory:")).unwrap();
    let project = db.add_project(&std::env::temp_dir()).unwrap();
    let sid = db.create_session(&project.id, "claude", "sonnet", "ask").unwrap().id;
    db.resume(&sid, "saved-claude-session").unwrap();
    let saved_reference = json!({"type":"tool_reference","tool_name":"mcp__pandacode_architect__pandacode_title"});
    let mut original_spec = None;

    for turn_kind in ["user", "review", "retry", "manual"] {
        if turn_kind == "manual" {
            db.update(&sid, Some("My parser investigation".into()), None, None, None).unwrap();
        }
        let coordination = matches!(turn_kind, "review" | "retry")
            .then_some(crate::architect::internal_turns::CoordinationKind::WorkerReview);
        let turn = db.begin_task_turn_with_kind(&sid, "Inspect the parser architecture", coordination).unwrap();
        let run = session_titles::TitleRun::prepare(&db, &sid, turn).unwrap();
        assert_eq!(run.is_some(), turn_kind == "user");
        let previous_title = db.session(&sid).unwrap().title;
        let stopped = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let catalog = session_titles::with_host(run.as_ref(), Some(host()), stopped.clone());
        let (send, mut events) = tokio::sync::mpsc::unbounded_channel();
        let server = Server::start_for_run(catalog, sid.clone(), Arc::new(move |event| { let _ = send.send(event); }), "ask")
            .await.unwrap().unwrap();
        let (_, initialized) = request(&server, json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}), "").await;
        assert_eq!(initialized["result"]["protocolVersion"], "2025-06-18");
        let (status, list) = request(&server, json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}), "").await;
        assert_eq!(status, 200);
        let config = server.claude_config();
        let server_name = config["mcpServers"].as_object().unwrap().keys().next().unwrap();
        let title_spec = list["result"]["tools"].as_array().unwrap().iter().find(|tool| {
            format!("mcp__{server_name}__{}", tool["name"].as_str().unwrap()) == saved_reference["tool_name"].as_str().unwrap()
        }).expect("saved title reference must resolve in every resumed catalog");
        if let Some(spec) = &original_spec {
            assert_eq!(title_spec, spec);
        } else {
            original_spec = Some(title_spec.clone());
        }
        let suggested_title = if run.is_some() { "Parser architecture" } else { "Internal review update" };
        let (_, response) = request(&server, json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":title_spec["name"],"arguments":{"title":suggested_title}}}), "").await;
        assert_eq!(response["result"]["isError"], false);
        let result: Value = serde_json::from_str(response["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(result["staged"], run.is_some());
        assert!(events.try_recv().is_err(), "metadata must not emit activity or approval");
        assert!(server.current().approvals.lock().unwrap().is_empty());
        assert_eq!(db.session(&sid).unwrap().title, previous_title);
        db.message(&sid, "assistant", "Parser inspection finished.").unwrap();
        db.finish_task_turn(&sid, true, false).unwrap();
        if let Some(run) = run {
            assert!(run.finish(&db, true).unwrap());
            assert_eq!(db.session(&sid).unwrap().title, "Parser architecture");
        } else {
            assert_eq!(db.session(&sid).unwrap().title, previous_title);
        }
        let (_, delegated) = request(&server, call(json!(4), json!({"prompt":"Check parser tests"})), "").await;
        assert_eq!(delegated["result"]["isError"], false);
        let result: Value = serde_json::from_str(delegated["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(result["prompt"], "Check parser tests");
        assert_eq!(db.session(&sid).unwrap().resume_id.as_deref(), Some("saved-claude-session"));
        stopped.store(true, Ordering::SeqCst);
        drop(server);
    }
}
#[tokio::test]
async fn optional_preview_mcp_keeps_approval_plan_restrictions_and_visible_activity() {
    for name in ["pandacode_run_project", "pandacode_preview_file"] {
        for mode in ["ask", "auto", "plan", "full"] {
            let count = Arc::new(AtomicUsize::new(0));
            let called = count.clone();
            let protected = ToolHost {
                tools: vec![json!({"type":"function","name":name,"description":"Preview","inputSchema":{"type":"object"}})],
                approval_tools: [name.into()].into(),
                handler: Arc::new(move |_, _| {
                    called.fetch_add(1, Ordering::SeqCst);
                    Box::pin(async { Ok(json!({"opened":true})) })
                }),
            };
            let (sender, mut events) = tokio::sync::mpsc::unbounded_channel();
            let server = Server::start_for_run(protected, "task".into(), Arc::new(move |event| { let _ = sender.send(event); }), mode).await.unwrap().unwrap();
            assert!(!server.required(), "preview availability must not block ordinary turns");
            let request = request(&server, json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":name,"arguments":{}}}), "");
            let answer = async {
                if matches!(mode, "ask" | "auto") {
                    let pending = loop {
                        let event = tokio::time::timeout(Duration::from_secs(2), events.recv()).await.unwrap().unwrap();
                        if event.kind == "approval" { break event.request_id.unwrap(); }
                    };
                    assert_eq!(count.load(Ordering::SeqCst), 0);
                    // Declining even the static-file preview must prevent UI access.
                    assert!(server.approve(&pending, false));
                }
            };
            let ((code, result), ()) = tokio::join!(request, answer);
            assert_eq!(code, 200);
            assert_eq!(result["result"]["isError"], mode != "full");
            assert_eq!(count.load(Ordering::SeqCst), usize::from(mode == "full"));
            assert!(server.current().approvals.lock().unwrap().is_empty());
            let mut activity = false;
            while let Ok(event) = events.try_recv() {
                assert_ne!(event.kind, "approval");
                activity |= event.kind == "tool";
            }
            assert!(activity, "preview actions must remain visible in the transcript");
        }
    }
}

#[tokio::test]
async fn initializes_lists_calls_and_emits_bounded_real_results() {
    let observed = Arc::new(Mutex::new(Vec::new()));
    let saved = observed.clone();
    let server = Server::start(
        host(),
        "parent".into(),
        Arc::new(move |e| saved.lock().unwrap().push(e)),
    )
    .await
    .unwrap();
    let (_,init)=request(&server,json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}),"").await;
    assert_eq!(init["result"]["protocolVersion"], "2025-06-18");
    let (_, list) = request(
        &server,
        json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}),
        "",
    )
    .await;
    assert_eq!(list["result"]["tools"][0]["name"], "pandacode_delegate");
    assert!(list["result"]["tools"][0].get("type").is_none());
    let (_, result) = request(
        &server,
        call(json!("job"), json!({"prompt":"Implement 🐼"})),
        "",
    )
    .await;
    assert_eq!(result["id"], "job");
    assert_eq!(result["result"]["isError"], false);
    assert_eq!(
        serde_json::from_str::<Value>(result["result"]["content"][0]["text"].as_str().unwrap())
            .unwrap()["prompt"],
        "Implement 🐼"
    );
    let events = observed.lock().unwrap();
    assert_eq!(events.len(), 2);
    assert_eq!(events[0].session_id, "parent");
    assert_eq!(events[1].tool.as_ref().unwrap().status, "completed");
    assert_eq!(
        events[0].tool.as_ref().unwrap().id,
        events[1].tool.as_ref().unwrap().id
    );
    assert!(server.claude_config()["mcpServers"][SERVER_NAME].is_object());
    assert_eq!(server.kimi_config()["type"], "http");
}
#[tokio::test]
async fn rejects_auth_origin_host_smuggling_and_oversized_frames() {
    let server = server().await;
    let other = self::server().await;
    for (header,code) in [
        (format!("POST /mcp HTTP/1.1\r\nHost: {}\r\nContent-Length: 0\r\n\r\n",server.authority),401),
        (format!("POST /mcp HTTP/1.1\r\nHost: evil.example\r\nAuthorization: Bearer {}\r\n\r\n",server.token),403),
        (format!("POST /mcp HTTP/1.1\r\nHost: {}\r\nAuthorization: Bearer {}\r\n\r\n",server.authority,other.token),401),
        (format!("POST /mcp HTTP/1.1\r\nHost: {}\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: 99999999\r\n\r\n",server.authority,server.token),413),
    ] { assert_eq!(raw(&server,header,vec![]).await.0,code); }
    for (extra, code) in [
        ("Origin: https://evil.example\r\n", 403),
        ("Transfer-Encoding: chunked\r\n", 400),
        ("Content-Length: 1\r\n", 400),
        ("MCP-Protocol-Version: invalid\r\n", 400),
    ] {
        assert_eq!(
            request(&server, call(json!(1), json!({})), extra).await.0,
            code
        );
    }
}
#[tokio::test]
async fn rejects_protected_catalog_and_unknown_calls_and_reports_tool_errors() {
    let mut protected = host();
    protected.approval_tools.insert("pandacode_delegate".into());
    assert!(Server::start(protected, "p".into(), Arc::new(|_| {}))
        .await
        .is_err());
    let mut failing = host();
    failing.handler = Arc::new(|_, _| Box::pin(async { Err("Worker unavailable".into()) }));
    let server = Server::start(failing, "p".into(), Arc::new(|_| {}))
        .await
        .unwrap();
    let (_, failed) = request(&server, call(json!(1), json!({})), "").await;
    assert_eq!(failed["result"]["isError"], true);
    assert_eq!(failed["result"]["content"][0]["text"], "Worker unavailable");
    let mut unknown = call(json!(2), json!({}));
    unknown["params"]["name"] = json!("pandacode_open_browser");
    assert_eq!(
        request(&server, unknown, "").await.1["error"]["code"],
        -32602
    );
    assert_eq!(
        request(&server, call(json!(3), json!([])), "").await.1["error"]["code"],
        -32602
    );
    let mut oversized = host();
    oversized.handler =
        Arc::new(|_, _| Box::pin(async { Ok(json!("x".repeat(RESULT_LIMIT + 1))) }));
    let big = Server::start(oversized, "p".into(), Arc::new(|_| {}))
        .await
        .unwrap();
    assert_eq!(
        request(&big, call(json!(4), json!({})), "").await.1["result"]["isError"],
        true
    );
}
#[tokio::test]
async fn moodboard_visual_is_returned_as_mcp_image_not_base64_text() {
    let mut visual = host();
    visual.handler = Arc::new(|_, _| {
        Box::pin(async {
            Ok(
                json!({"_pandacodeImage":{"mimeType":"image/jpeg","data":"/9j/2Q==","text":"Reference screenshot"}}),
            )
        })
    });
    let server = Server::start(
        visual,
        "p".into(),
        Arc::new(|event| {
            if event.kind == "tool_result" {
                assert!(!event.text.contains("/9j/"));
            }
        }),
    )
    .await
    .unwrap();
    let (_, response) = request(&server, call(json!(1), json!({})), "").await;
    assert_eq!(response["result"]["isError"], false);
    assert_eq!(response["result"]["content"][1]["type"], "image");
    assert_eq!(response["result"]["content"][1]["mimeType"], "image/jpeg");
}
#[tokio::test]
async fn cancellation_and_drop_release_waiting_callbacks_without_blocking_other_requests() {
    let dropped = Arc::new(std::sync::atomic::AtomicBool::new(false));
    struct Guard(Arc<std::sync::atomic::AtomicBool>);
    impl Drop for Guard {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }
    let signal = dropped.clone();
    let mut waiting = host();
    waiting.handler = Arc::new(move |_, _| {
        let guard = Guard(signal.clone());
        Box::pin(async move {
            let _guard = guard;
            std::future::pending().await
        })
    });
    let server = server_from_host(waiting).await;
    let cancelled = async {
        let result = request(&server, call(json!("wait"), json!({})), "").await.1;
        assert_eq!(result["result"]["isError"], true);
        assert!(result["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("canceled"));
    };
    let interrupt = async {
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert_eq!(
            request(&server, call(json!("wait"), json!({})), "").await.1["error"]["code"],
            -32600
        );
        assert!(request(
            &server,
            json!({"jsonrpc":"2.0","id":"ping","method":"ping"}),
            ""
        )
        .await
        .1["result"]
            .is_object());
        assert_eq!(request(&server,json!({"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":"wait"}}),"").await.0,202);
    };
    tokio::join!(cancelled, interrupt);
    assert!(dropped.load(Ordering::SeqCst));
    dropped.store(false, Ordering::SeqCst);
    let call = request(&server, call(json!("next"), json!({})), "");
    tokio::pin!(call);
    tokio::select! {_=&mut call=>panic!("pending tool finished"),_=tokio::time::sleep(Duration::from_millis(30))=>{}}
    let address = server.authority.clone();
    server.stop();
    // Stopping drops the pending call and closes the port; poll for both, generously.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    while !dropped.load(Ordering::SeqCst) || TcpStream::connect(&address).await.is_ok() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "stop left the call running ({}) or the port open",
            !dropped.load(Ordering::SeqCst)
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}
async fn server_from_host(host: ToolHost) -> Server {
    Server::start(host, "p".into(), Arc::new(|_| {}))
        .await
        .unwrap()
}
