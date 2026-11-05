use super::*;
use crate::cloud::http::mock;

struct Folder(PathBuf);
impl Folder {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("pandacode-direct-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn history(&self) -> Transcript {
        Transcript {
            path: self.0.join("history.json"),
            messages: vec![],
        }
    }
}
impl Drop for Folder {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn config() -> RunConfig {
    super::super::tests::config(ID)
}
fn sink() -> Sink {
    Arc::new(|_| {})
}

#[tokio::test]
async fn discovers_only_the_entered_server_models_with_optional_authentication() {
    let (base, seen) = mock::serve(|_, _| {
        (
            200,
            r#"{"data":[{"id":"local/a"},{"id":"local/b"},{"id":"local/a"}]}"#,
        )
    });
    let models = discover(&base, None).await.unwrap();
    assert_eq!(
        models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
        ["local/a", "local/b"]
    );
    discover(&base, Some("fixture-token")).await.unwrap();
    let calls = seen.lock().unwrap();
    assert_eq!(calls[0].method, "GET");
    assert_eq!(calls[0].path, "/v1/models");
    assert_eq!(calls[0].authorization, None);
    assert_eq!(
        calls[1].authorization.as_deref(),
        Some("Bearer fixture-token")
    );
    assert!(parse_models(json!({"models":[]})).is_err());
    assert!(parse_models(json!({"data":[{"id":"bad\nmodel"}]})).is_err());
    assert!(parse_models(json!({"data":[]})).unwrap().is_empty());
}

#[tokio::test]
async fn discovery_reports_authentication_and_redacts_error_keys() {
    let (base, _) = mock::serve(|_, _| (401, "{}"));
    assert!(discover(&base, None)
        .await
        .unwrap_err()
        .contains("optional API key"));
    let (base, _) = mock::serve(|_, _| (500, r#"{"error":{"message":"bad fixture-token"}}"#));
    let error = discover(&base, Some("fixture-token")).await.unwrap_err();
    assert!(!error.contains("fixture-token"));
    assert!(error.contains("[redacted]"));
    assert_eq!(
        base_url("http://localhost:8080/").unwrap(),
        "http://localhost:8080/v1"
    );
    for url in [
        "file:///tmp",
        "https://user:key@example.com",
        "https://example.com/?key=x",
    ] {
        assert!(base_url(url).is_err());
    }
}

#[test]
fn fragmented_calls_accumulate_and_duplicate_calls_are_rejected() {
    let mut result = Completion::default();
    result.frame(json!({"choices":[{"delta":{"content":"Hello","tool_calls":[{"index":0,"id":"call1","function":{"name":"read_file","arguments":"{\"pa"}}]}}]}), &config(), &sink()).unwrap();
    result.frame(json!({"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\":\"README.md\"}"}}]},"finish_reason":"tool_calls"}]}), &config(), &sink()).unwrap();
    let message = result.message().unwrap();
    assert_eq!(
        message["tool_calls"][0]["function"]["arguments"],
        r#"{"path":"README.md"}"#
    );
    assert!(result.finished);
    result.calls.insert(1, result.calls[&0].clone());
    assert!(result.message().is_err());
}

#[tokio::test]
async fn direct_run_executes_tools_and_retains_followup_history() {
    let folder = Folder::new();
    let (base, seen) = mock::serve(|request, _| {
        let request: Value = serde_json::from_str(&request.body).unwrap();
        let has_tool = request["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["role"] == "tool");
        let message = if has_tool {
            json!({"content":"File created."})
        } else {
            json!({"tool_calls":[{"id":"write1","type":"function","function":{"name":"write_file","arguments":"{\"path\":\"hello.txt\",\"content\":\"hello\"}"}}]})
        };
        (200, json!({"choices":[{"message":message,"finish_reason":if has_tool {"stop"} else {"tool_calls"}}]}).to_string())
    });
    let mut config = config();
    config.cwd = folder.0.clone();
    config.mode = "auto".into();
    let (_send, receive) = tokio::sync::mpsc::unbounded_channel();
    run_session(
        config.clone(),
        format!("{base}/v1"),
        None,
        "local/a".into(),
        folder.history(),
        "fixture".into(),
        sink(),
        receive,
        None,
        None,
    )
    .await
    .unwrap();
    assert_eq!(
        std::fs::read_to_string(folder.0.join("hello.txt")).unwrap(),
        "hello"
    );
    let history: History =
        serde_json::from_slice(&std::fs::read(folder.0.join("history.json")).unwrap()).unwrap();
    assert_eq!(history.messages.len(), 4);
    config.prompt = "Continue".into();
    let (_send, receive) = tokio::sync::mpsc::unbounded_channel();
    run_session(
        config,
        format!("{base}/v1"),
        None,
        "local/a".into(),
        Transcript {
            messages: history.messages,
            ..folder.history()
        },
        "fixture".into(),
        sink(),
        receive,
        None,
        None,
    )
    .await
    .unwrap();
    let calls = seen.lock().unwrap();
    assert_eq!(calls.len(), 3);
    let request: Value = serde_json::from_str(&calls[2].body).unwrap();
    assert_eq!(request["model"], "local/a");
    assert_eq!(request["messages"].as_array().unwrap().len(), 6);
    assert_eq!(calls[0].authorization, None);
}

#[tokio::test]
async fn file_tools_obey_approval_plan_and_project_boundaries() {
    let folder = Folder::new();
    let mut config = config();
    config.cwd = folder.0.clone();
    let args = json!({"path":"test.txt","content":"hello"});
    let (send, mut events) = tokio::sync::mpsc::unbounded_channel();
    let host = mcp_host::DirectHost::new(
        local_tools::host(&config, None).unwrap(),
        "test".into(),
        Arc::new(move |event| {
            let _ = send.send(event);
        }),
        "ask",
    )
    .unwrap();
    let work = host.call("write", "write_file", args.clone());
    tokio::pin!(work);
    loop {
        tokio::select! { _ = &mut work => panic!("must wait for approval"), event = events.recv() => { let event = event.unwrap(); if event.kind == "approval" { assert!(!folder.0.join("test.txt").exists()); host.approve(event.request_id.as_deref().unwrap(), true); break; } } }
    }
    assert_eq!(work.await.unwrap()["isError"], false);
    config.mode = "plan".into();
    let host = mcp_host::DirectHost::new(
        local_tools::host(&config, None).unwrap(),
        "test".into(),
        sink(),
        "plan",
    )
    .unwrap();
    assert_eq!(
        host.call(
            "write",
            "write_file",
            json!({"path":"denied.txt","content":"no"})
        )
        .await
        .unwrap()["isError"],
        true
    );
    assert!(!folder.0.join("denied.txt").exists());
    let host = local_tools::host(&config, None).unwrap();
    for path in ["../escape.txt", ".git/config"] {
        assert!(
            (host.handler)("write_file".into(), json!({"path":path,"content":"no"}))
                .await
                .is_err()
        );
    }
    assert!((host.handler)(
        "edit_file".into(),
        json!({"path":"test.txt","old_text":"missing","new_text":"no"})
    )
    .await
    .is_err());
}

#[test]
fn interrupted_tool_calls_are_closed_before_the_next_prompt() {
    let folder = Folder::new();
    let mut history = folder.history();
    history.messages = vec![
        json!({"role":"assistant","tool_calls":[{"id":"a"},{"id":"b"}]}),
        json!({"role":"tool","tool_call_id":"a","content":"done"}),
    ];
    history.repair_interrupted_tools();
    assert_eq!(history.messages.len(), 3);
    assert_eq!(history.messages[2]["tool_call_id"], "b");
    history.repair_interrupted_tools();
    assert_eq!(history.messages.len(), 3);
}

#[tokio::test]
async fn streaming_handles_split_utf8_tool_arguments_and_done() {
    use std::io::{BufRead, BufReader, Read};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let thread = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut length = 0;
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            if line == "\r\n" {
                break;
            }
            if let Some((name, value)) = line.split_once(':') {
                if name.eq_ignore_ascii_case("content-length") {
                    length = value.trim().parse().unwrap();
                }
            }
        }
        reader.read_exact(&mut vec![0; length]).unwrap();
        let frames = [
            json!({"choices":[{"delta":{"content":"héllo", "tool_calls":[{"index":0,"id":"a","function":{"name":"read_file","arguments":"{"}}]}}]}),
            json!({"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"path\":\"a.txt\"}"}}]},"finish_reason":"tool_calls"}]}),
        ];
        let data = format!(
            "data: {}\r\n\r\ndata: {}\n\ndata: [DONE]\n\n",
            frames[0], frames[1]
        );
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\n\r\n",
            data.len()
        )
        .unwrap();
        for chunk in data.as_bytes().chunks(3) {
            stream.write_all(chunk).unwrap();
        }
    });
    let result = completion(
        &client(5).unwrap(),
        &base,
        None,
        json!({}),
        &config(),
        &sink(),
    )
    .await
    .unwrap();
    assert_eq!(result.text, "héllo");
    assert_eq!(
        result.message().unwrap()["tool_calls"][0]["function"]["arguments"],
        "{\"path\":\"a.txt\"}"
    );
    thread.join().unwrap();
}

#[tokio::test]
async fn stop_interrupts_an_inflight_model_request() {
    let folder = Folder::new();
    let mut config = config();
    config.cwd = folder.0.clone();
    let (base, _) = mock::serve(|_, _| {
        std::thread::sleep(Duration::from_secs(1));
        (200, "{}")
    });
    let (send, receive) = tokio::sync::mpsc::unbounded_channel();
    let stop = async {
        tokio::time::sleep(Duration::from_millis(30)).await;
        send.send(RunInput::Stop).unwrap();
    };
    let work = run_session(
        config,
        format!("{base}/v1"),
        None,
        "test".into(),
        folder.history(),
        "fixture".into(),
        sink(),
        receive,
        None,
        None,
    );
    let (result, _) = tokio::time::timeout(Duration::from_millis(500), async {
        tokio::join!(work, stop)
    })
    .await
    .unwrap();
    assert_eq!(result.unwrap_err(), "Stopped");
}

#[cfg(unix)]
#[tokio::test]
async fn cancelling_a_command_kills_its_child_processes() {
    let folder = Folder::new();
    let mut config = config();
    config.cwd = folder.0.clone();
    let host = local_tools::host(&config, None).unwrap();
    let work = (host.handler)(
        "run_command".into(),
        json!({"command":"touch started; sleep 1; touch should-not-exist"}),
    );
    assert!(tokio::time::timeout(Duration::from_millis(150), work)
        .await
        .is_err());
    assert!(folder.0.join("started").exists());
    tokio::time::sleep(Duration::from_millis(1100)).await;
    assert!(!folder.0.join("should-not-exist").exists());
}

#[tokio::test]
async fn images_are_sent_inline_and_retained_without_reopening_source_files() {
    use base64::Engine;
    let folder = Folder::new();
    let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
    let image = folder.0.join("pixel.png");
    std::fs::write(
        &image,
        base64::engine::general_purpose::STANDARD
            .decode(png)
            .unwrap(),
    )
    .unwrap();
    let (base, seen) = mock::serve(|_, _| {
        (
            200,
            r#"{"choices":[{"message":{"content":"A pixel."},"finish_reason":"stop"}]}"#,
        )
    });
    let mut config = config();
    config.cwd = folder.0.clone();
    config.images = vec![image.clone()];
    let (_send, receive) = tokio::sync::mpsc::unbounded_channel();
    run_session(
        config.clone(),
        format!("{base}/v1"),
        None,
        "vision".into(),
        folder.history(),
        "fixture".into(),
        sink(),
        receive,
        None,
        None,
    )
    .await
    .unwrap();
    let history: History =
        serde_json::from_slice(&std::fs::read(folder.0.join("history.json")).unwrap()).unwrap();
    std::fs::remove_file(image).unwrap();
    config.images.clear();
    config.prompt = "What colour was it?".into();
    let (_send, receive) = tokio::sync::mpsc::unbounded_channel();
    run_session(
        config,
        format!("{base}/v1"),
        None,
        "vision".into(),
        Transcript {
            messages: history.messages,
            ..folder.history()
        },
        "fixture".into(),
        sink(),
        receive,
        None,
        None,
    )
    .await
    .unwrap();
    let calls = seen.lock().unwrap();
    assert_eq!(calls.len(), 2);
    for call in calls.iter() {
        let request: Value = serde_json::from_str(&call.body).unwrap();
        assert_eq!(request["messages"][1]["content"][0]["type"], "text");
        assert_eq!(request["messages"][1]["content"][1]["type"], "image_url");
        assert_eq!(
            request["messages"][1]["content"][1]["image_url"]["url"],
            format!("data:image/png;base64,{png}")
        );
        assert!(!call.body.contains(folder.0.to_str().unwrap()));
    }
}

#[tokio::test]
async fn invalid_images_fail_before_a_request_or_history_write() {
    let folder = Folder::new();
    let image = folder.0.join("invalid.png");
    std::fs::write(&image, b"not an image").unwrap();
    let mut config = config();
    config.cwd = folder.0.clone();
    config.images = vec![image];
    let (_send, receive) = tokio::sync::mpsc::unbounded_channel();
    let result = run_session(
        config,
        "http://127.0.0.1:1/v1".into(),
        None,
        "vision".into(),
        folder.history(),
        "fixture".into(),
        sink(),
        receive,
        None,
        None,
    )
    .await;
    assert!(result.unwrap_err().contains("not a PNG"));
    assert!(!folder.history().path.exists());
}

#[tokio::test]
async fn steering_is_delivered_to_the_next_model_request() {
    let folder = Folder::new();
    let mut config = config();
    config.cwd = folder.0.clone();
    let (started, mut starts) = tokio::sync::mpsc::unbounded_channel();
    let (base, seen) = mock::serve(move |_, _| {
        let _ = started.send(());
        std::thread::sleep(Duration::from_millis(80));
        (
            200,
            r#"{"choices":[{"message":{"content":"Done."},"finish_reason":"stop"}]}"#,
        )
    });
    let (send, receive) = tokio::sync::mpsc::unbounded_channel();
    let (events, log) = (
        Arc::new(Mutex::new(Vec::new())),
        Arc::new(Mutex::new(Vec::new())),
    );
    let output = events.clone();
    let sink: Sink = Arc::new(move |event| output.lock().unwrap().push(event));
    let steer = async {
        starts.recv().await.unwrap();
        let (reply, answer) = tokio::sync::oneshot::channel();
        send.send(RunInput::Steer {
            id: "s1".into(),
            text: "Also explain your change.".into(),
            reply,
        })
        .unwrap();
        let response = answer.await.unwrap().unwrap();
        log.lock().unwrap().push(response);
        // Keep the control channel alive until the run completes.
        starts.recv().await.unwrap();
        tokio::time::sleep(Duration::from_millis(150)).await;
    };
    let run = run_session(
        config,
        format!("{base}/v1"),
        None,
        "test".into(),
        folder.history(),
        "fixture".into(),
        sink,
        receive,
        None,
        None,
    );
    let (result, _) = tokio::join!(run, steer);
    result.unwrap();
    assert_eq!(log.lock().unwrap()[0]["steered"], true);
    let calls = seen.lock().unwrap();
    assert_eq!(calls.len(), 2);
    let request: Value = serde_json::from_str(&calls[1].body).unwrap();
    assert_eq!(
        request["messages"].as_array().unwrap().last().unwrap()["content"],
        "Also explain your change."
    );
    let statuses: Vec<_> = events
        .lock()
        .unwrap()
        .iter()
        .filter(|e| e.kind == "steer")
        .map(|e| e.data.as_ref().unwrap()["status"].clone())
        .collect();
    assert_eq!(statuses, vec![json!("pending"), json!("delivered")]);
}

#[test]
fn pending_steering_is_reported_failed_when_a_run_stops() {
    let events = Arc::new(Mutex::new(Vec::new()));
    let output = events.clone();
    let steers = DirectSteers {
        pending: Mutex::new(vec![("pending".into(), "Do more".into())]),
        config: config(),
        sink: Arc::new(move |e| output.lock().unwrap().push(e)),
    };
    drop(steers);
    assert_eq!(
        events.lock().unwrap()[0].data.as_ref().unwrap()["status"],
        "failed"
    );
}

#[tokio::test]
async fn compaction_continues_the_same_saved_chat_at_every_context_size() {
    for window in [8192, 16384, 32768, 65536, 131072, 262144, 524288, 1048576] {
        let folder = Folder::new();
        let (base, seen) = mock::serve(|request, _| {
            let r: Value = serde_json::from_str(&request.body).unwrap();
            if request.path.ends_with("count_tokens") {
                return (
                    200,
                    json!({"input_tokens":r.to_string().len()/3+20}).to_string(),
                );
            }
            let summary = r["messages"][0]["content"]
                .as_str()
                .unwrap()
                .starts_with("Summarize conversation data");
            if summary {
                assert_eq!(r["chat_template_kwargs"]["enable_thinking"], false);
                assert!(r.get("tools").is_none());
            } else {
                assert!(r["messages"].to_string().contains("ORANGE FALCON"));
            }
            (200, json!({"choices":[{"message":{"content":if summary {"Project ORANGE FALCON launches Tuesday. Continue the requested work."} else {"ORANGE FALCON launches Tuesday."}},"finish_reason":"stop"}]}).to_string())
        });
        let mut cfg = config();
        cfg.cwd = folder.0.clone();
        cfg.prompt = "What is the project code?".into();
        let mut history = folder.history();
        for round in 0..3 {
            history.messages.push(json!({"role":"user","content":format!("Project ORANGE FALCON launches Tuesday. {}", "detail ".repeat(window/2))}));
            history
                .messages
                .push(json!({"role":"assistant","content":"Details recorded."}));
            history.save().unwrap();
            let (_sender, receiver) = tokio::sync::mpsc::unbounded_channel();
            let path = history.path.clone();
            run_session(
                cfg.clone(),
                format!("{base}/v1"),
                None,
                "local/a".into(),
                history,
                "same-chat".into(),
                sink(),
                receiver,
                None,
                Some(context::Budget {
                    window,
                    strata: true,
                }),
            )
            .await
            .unwrap();
            let saved: History = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            assert!(
                saved.messages[0]["content"]
                    .as_str()
                    .unwrap()
                    .contains("conversation-summary"),
                "window {window}, round {round}"
            );
            assert_eq!(
                saved.messages.last().unwrap()["content"],
                "ORANGE FALCON launches Tuesday."
            );
            history = Transcript {
                path,
                messages: saved.messages,
            };
        }
        assert!(
            seen.lock()
                .unwrap()
                .iter()
                .filter(|r| r.path.ends_with("chat/completions"))
                .count()
                >= 6
        );
    }
}

#[tokio::test]
async fn failed_summary_does_not_replace_saved_history() {
    let folder = Folder::new();
    let mut history = folder.history();
    history.messages = vec![
        json!({"role":"user","content":"old ".repeat(9000)}),
        json!({"role":"assistant","content":"ok"}),
        json!({"role":"user","content":"continue"}),
    ];
    history.save().unwrap();
    let original = std::fs::read(&history.path).unwrap();
    let (base, _) = mock::serve(|_, _| (500, r#"{"error":{"message":"summary unavailable"}}"#));
    let error = context::prepare(
        &client(10).unwrap(),
        &format!("{base}/v1"),
        None,
        "local/a",
        "system",
        &[],
        &mut history,
        &context::Budget {
            window: 8192,
            strata: false,
        },
        &config(),
        &sink(),
        false,
    )
    .await
    .unwrap_err();
    assert!(error.contains("unchanged"));
    assert_eq!(std::fs::read(&history.path).unwrap(), original);
}

#[tokio::test]
async fn partial_output_is_saved_and_incomplete_tools_are_not_executed() {
    let folder = Folder::new();
    let mut cfg = config();
    cfg.cwd = folder.0.clone();
    cfg.mode = "auto".into();
    let (base, _) = mock::serve(|_, _| {
        (200,json!({"choices":[{"message":{"content":"Here is the first part.","tool_calls":[{"id":"bad","function":{"name":"write_file","arguments":"{\"path\":\"bad.txt\""}}]},"finish_reason":"length"}]}).to_string())
    });
    let (_sender, receiver) = tokio::sync::mpsc::unbounded_channel();
    let history = folder.history();
    let path = history.path.clone();
    run_session(
        cfg,
        format!("{base}/v1"),
        None,
        "local/a".into(),
        history,
        "same-chat".into(),
        sink(),
        receiver,
        None,
        None,
    )
    .await
    .unwrap();
    let h: History = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    assert_eq!(
        h.messages.last().unwrap()["content"],
        "Here is the first part."
    );
    assert!(h.messages.last().unwrap().get("tool_calls").is_none());
    assert!(!folder.0.join("bad.txt").exists());
}

#[tokio::test]
async fn reads_the_loaded_strata_window_instead_of_assuming_the_model_maximum() {
    let (base, _) = mock::serve(|request, _| {
        assert_eq!(request.path, "/health");
        (
            200,
            r#"{"service":"strata","max_context":8192,"model":"local/a"}"#,
        )
    });
    let b = context::discover(&format!("{base}/v1"), None, "local/a").await;
    assert_eq!(b.window, 8192);
    assert!(b.strata);
}

#[tokio::test]
async fn server_context_overflow_compacts_and_retries_once() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let folder = Folder::new();
    let normals = Arc::new(AtomicUsize::new(0));
    let count = normals.clone();
    let (base, _) = mock::serve(move |request, _| {
        if request.path.ends_with("count_tokens") {
            return (200, json!({"input_tokens":100}).to_string());
        }
        let r: Value = serde_json::from_str(&request.body).unwrap();
        let summary = r["messages"][0]["content"]
            .as_str()
            .unwrap()
            .starts_with("Summarize conversation data");
        if !summary && count.fetch_add(1, Ordering::SeqCst) == 0 {
            return (
                400,
                json!({"error":{"message":"context length exceeded"}}).to_string(),
            );
        }
        (200,json!({"choices":[{"message":{"content":"The project is ORANGE FALCON."},"finish_reason":"stop"}]}).to_string())
    });
    let mut cfg = config();
    cfg.cwd = folder.0.clone();
    cfg.prompt = "continue".into();
    let mut h = folder.history();
    h.messages = vec![
        json!({"role":"user","content":"Project ORANGE FALCON"}),
        json!({"role":"assistant","content":"Recorded"}),
    ];
    let (_send, receive) = tokio::sync::mpsc::unbounded_channel();
    run_session(
        cfg,
        format!("{base}/v1"),
        None,
        "local/a".into(),
        h,
        "same-chat".into(),
        sink(),
        receive,
        None,
        Some(context::Budget {
            window: 8192,
            strata: true,
        }),
    )
    .await
    .unwrap();
    assert_eq!(normals.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn oversized_tool_result_is_summarized_as_a_complete_group() {
    let folder = Folder::new();
    let mut h = folder.history();
    h.messages = vec![
        json!({"role":"user","content":"Inspect the build results"}),
        json!({"role":"assistant","content":null,"tool_calls":[{"id":"build","function":{"name":"run_command","arguments":"{}"}}]}),
        json!({"role":"tool","tool_call_id":"build","content":"Build passed. ".repeat(5000)}),
    ];
    h.save().unwrap();
    let (base, _) = mock::serve(|_, _| {
        (200,json!({"choices":[{"message":{"content":"User requested build inspection. The build tool completed successfully; report its outcome."},"finish_reason":"stop"}]}).to_string())
    });
    let result = context::prepare(
        &client(10).unwrap(),
        &format!("{base}/v1"),
        None,
        "local/a",
        "system",
        &[],
        &mut h,
        &context::Budget {
            window: 8192,
            strata: false,
        },
        &config(),
        &sink(),
        false,
    )
    .await
    .unwrap();
    assert!(result["messages"]
        .to_string()
        .contains("build tool completed"));
    assert!(h
        .messages
        .iter()
        .all(|m| m["role"] != "tool" && m.get("tool_calls").is_none()));
}

#[tokio::test]
#[ignore = "requires an explicitly selected running local model"]
async fn live_local_summary_preserves_facts() {
    let base = std::env::var("PANDA_CONTEXT_TEST_URL").expect("test endpoint");
    let model = std::env::var("PANDA_CONTEXT_TEST_MODEL").expect("test model");
    let folder = Folder::new();
    let mut h = folder.history();
    h.messages = vec![
        json!({"role":"user","content":format!("Remember that project ORANGE FALCON launches Tuesday. {}", "The launch checklist is approved. ".repeat(35))}),
        json!({"role":"assistant","content":"I have recorded the project details."}),
        json!({"role":"user","content":"What is the project code and launch day? Answer in one short sentence."}),
    ];
    h.save().unwrap();
    let b = context::discover(&base, None, &model).await;
    assert!(b.strata);
    let cfg = config();
    let c = client(300).unwrap();
    let mut request = context::prepare(
        &c,
        &base,
        None,
        &model,
        "Answer briefly.",
        &[],
        &mut h,
        &b,
        &cfg,
        &sink(),
        true,
    )
    .await
    .unwrap();
    request["chat_template_kwargs"] = json!({"enable_thinking":false});
    let answer = completion(&c, &base, None, request, &cfg, &sink())
        .await
        .unwrap();
    println!("Live recall: {}", answer.text);
    assert!(answer.text.to_uppercase().contains("ORANGE FALCON"));
    assert!(answer.text.to_lowercase().contains("tuesday"));
    assert!(h.messages[0]["content"]
        .as_str()
        .unwrap()
        .contains("conversation-summary"));
}

#[tokio::test]
async fn fresh_hey_uses_gateway_metadata_and_real_count_at_8k_through_128k() {
    for window in [8192, 32768, 131072] {
        let folder = Folder::new();
        let (base, seen) = mock::serve(move |request, _| {
            match request.path.as_str() {
                "/health" => (200,"<html>Strata app</html>".to_owned()),
                "/v1/models" => (200,json!({"data":[{"id":"orca-iq3_xxs","owned_by":"strata","context_window":window,"meta":{"token_counting":true}}]}).to_string()),
                "/v1/messages/count_tokens" => (200,json!({"input_tokens":6500}).to_string()),
                "/v1/chat/completions" => {
                    let r:Value=serde_json::from_str(&request.body).unwrap();
                    assert_eq!(r["messages"].as_array().unwrap().len(),2);
                    assert_eq!(r["messages"][1]["content"],"hey");
                    assert!(r["max_tokens"].as_u64().unwrap()+6500 < window as u64);
                    (200,json!({"choices":[{"message":{"content":"Hey!"},"finish_reason":"stop"}]}).to_string())
                },
                _ => panic!("unexpected route {}",request.path),
            }
        });
        let base = format!("{base}/v1");
        let budget = context::discover(&base, None, "orca-iq3_xxs").await;
        assert_eq!(budget.window, window);
        assert!(budget.strata);
        let mut cfg = config();
        cfg.cwd = folder.0.clone();
        cfg.prompt = "hey".into();
        cfg.instructions = "Compressible instructions. ".repeat(800);
        let (_send, receive) = tokio::sync::mpsc::unbounded_channel();
        run_session(
            cfg,
            base,
            None,
            "orca-iq3_xxs".into(),
            folder.history(),
            "same-chat".into(),
            sink(),
            receive,
            None,
            Some(budget),
        )
        .await
        .unwrap();
        let calls = seen.lock().unwrap();
        assert_eq!(
            calls
                .iter()
                .filter(|r| r.path.ends_with("chat/completions"))
                .count(),
            1
        );
        assert!(calls.iter().any(|r| r.path.ends_with("count_tokens")));
    }
}
