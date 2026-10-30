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
