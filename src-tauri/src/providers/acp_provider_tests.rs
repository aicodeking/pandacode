use super::*;
use tokio::sync::mpsc::unbounded_channel;

fn workspace() -> PathBuf {
    let path = std::env::temp_dir().join(format!("pandacode-acp-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&path).unwrap();
    path
}

#[test]
fn client_capabilities_and_plan_permissions() {
    assert_eq!(
        Protocol::new(tests::config("antigravity")).initial()["params"]["clientCapabilities"],
        json!({})
    );
    for provider in ["codebuddy", "qoder", "kiro"] {
        let mut cfg = tests::config(provider);
        cfg.mode = "plan".into();
        let mut p = Protocol::new(cfg);
        p.remote_id = "active".into();
        assert_eq!(
            p.initial()["params"]["clientCapabilities"]["terminal"],
            true
        );
        for options in [
            json!([{"optionId":"allow","kind":"allow_once"}]),
            json!([{"optionId":"allow","kind":"allow_once"},{"optionId":"deny","kind":"reject_once"}]),
        ] {
            let step = p.receive(json!({"id":"permission","method":"session/request_permission","params":{"sessionId":"active","toolCall":{"kind":"execute"},"options":options}})).unwrap();
            assert!(!step.events.iter().any(|event| event.kind == "approval"));
            assert!(
                step.write[0]["result"]["outcome"]["outcome"] == "cancelled"
                    || step.write[0]["result"]["outcome"]["optionId"] == "deny"
            );
        }
    }
}

#[cfg(unix)]
#[tokio::test]
async fn callbacks_run_through_the_transport_and_normal_approval_queue() {
    let _lock = concurrent_process_tests::process_test_lock().lock().await;
    for provider in ["codebuddy", "qoder", "kiro"] {
        let root = workspace();
        let mut cfg = tests::config(provider);
        cfg.cwd = root.clone();
        let (sender, receiver) = unbounded_channel();
        let events = Arc::new(Mutex::new(Vec::new()));
        let saved = events.clone();
        let sink: Sink = Arc::new(move |event| {
            if let Some(id) = event
                .request_id
                .clone()
                .filter(|_| event.kind == "approval")
            {
                sender
                    .send(RunInput::Approval {
                        request_id: id,
                        approved: true,
                    })
                    .unwrap();
            }
            saved.lock().unwrap().push(event);
        });
        let mut command = Command::new("/bin/sh");
        command.args(["-c", CALLBACKS, "fixture"]).arg(&root);
        let result = tokio::time::timeout(
            Duration::from_secs(15),
            run_process(cfg, sink, receiver, command, Vec::new()),
        )
        .await
        .unwrap();
        assert!(result.is_ok(), "{provider}: {result:?}");
        assert_eq!(
            std::fs::read_to_string(root.join("output.txt")).unwrap(),
            "written"
        );
        let observed = events.lock().unwrap();
        assert_eq!(
            observed
                .iter()
                .filter(|event| event.kind == "approval")
                .count(),
            2
        );
        assert!(observed
            .iter()
            .any(|event| event.kind == "text" && event.text == "fixture-done"));
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(unix)]
const CALLBACKS: &str = r#"
set -eu
IFS= read -r init
case "$init" in *'"readTextFile":true'*) ;; *) exit 11;; esac
printf '%s\n' '{"id":1,"result":{"protocolVersion":1,"agentCapabilities":{"loadSession":true}}}'
IFS= read -r session
printf '%s\n' '{"id":2,"result":{"sessionId":"active"}}'
IFS= read -r prompt
printf '{"id":"file","method":"fs/write_text_file","params":{"sessionId":"active","path":"%s/output.txt","content":"written"}}\n' "$1"
IFS= read -r written
case "$written" in *'"result":{}'*) ;; *) exit 12;; esac
printf '{"id":"read","method":"fs/read_text_file","params":{"sessionId":"active","path":"%s/output.txt"}}\n' "$1"
IFS= read -r content
case "$content" in *'"content":"written"'*) ;; *) exit 13;; esac
printf '%s\n' '{"id":"create","method":"terminal/create","params":{"sessionId":"active","command":"/bin/sh","args":["-c","printf terminal-ok"]}}'
IFS= read -r terminal
id=$(printf '%s' "$terminal" | sed -n 's/.*"terminalId":"\([^"]*\)".*/\1/p')
test -n "$id"
printf '{"id":"wait","method":"terminal/wait_for_exit","params":{"sessionId":"active","terminalId":"%s"}}\n' "$id"
IFS= read -r exit_status
case "$exit_status" in *'"exitCode":0'*) ;; *) exit 14;; esac
printf '{"id":"output","method":"terminal/output","params":{"sessionId":"active","terminalId":"%s"}}\n' "$id"
IFS= read -r output
case "$output" in *'terminal-ok'*) ;; *) exit 15;; esac
printf '%s\n' '{"method":"session/update","params":{"sessionId":"active","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"fixture-done"}}}}'
printf '%s\n' '{"id":3,"result":{"stopReason":"end_turn"}}'
IFS= read -r finished || true
"#;

async fn installed(provider: &str) {
    let root = workspace();
    let path = executable(provider).expect("CLI is installed");
    let mut cfg = tests::config(provider);
    cfg.cwd = root.clone();
    cfg.prompt = if provider == "kiro" {
        "/help"
    } else {
        "Reply exactly PANDACODE_OK. Do not use tools or access files."
    }
    .into();
    let mut command = command(&path).unwrap();
    configure_command(&mut command, &cfg);
    let (sender, receiver) = unbounded_channel();
    let events = Arc::new(Mutex::new(Vec::new()));
    let saved = events.clone();
    let sink: Sink = Arc::new(move |event| {
        saved.lock().unwrap().push(event);
    });
    let result = tokio::time::timeout(
        Duration::from_secs(90),
        run_process(cfg.clone(), sink, receiver, command, Vec::new()),
    )
    .await;
    drop(sender);
    assert!(result.is_ok(), "CLI smoke turn timed out");
    assert!(result.unwrap().is_ok(), "CLI smoke turn failed");
    let session = events
        .lock()
        .unwrap()
        .iter()
        .find(|event| event.kind == "session")
        .expect("session was created")
        .text
        .clone();
    assert!(
        events
            .lock()
            .unwrap()
            .iter()
            .any(|event| event.kind == "text"),
        "CLI smoke turn produced no text"
    );

    let mut command = super::command(&path).unwrap();
    configure_command(&mut command, &cfg);
    let mut pipe =
        crate::slash_commands::claude::Pipe::spawn(command, &root, Duration::from_secs(60))
            .unwrap();
    let mut initialize = Protocol::new(cfg).initial();
    initialize["params"]["clientCapabilities"] = json!({});
    pipe.send(&initialize).await.unwrap();
    let resumed = loop {
        let frame = pipe.read().await.expect("resume response");
        if frame["id"] == 1 {
            assert!(frame["error"].is_null(), "initialization failed");
            let capabilities = &frame["result"]["agentCapabilities"];
            let method = if capabilities["sessionCapabilities"].get("resume").is_some() {
                "session/resume"
            } else {
                "session/load"
            };
            pipe.send(&json!({"jsonrpc":"2.0","id":2,"method":method,"params":{"sessionId":session,"cwd":external_path(&root),"mcpServers":[]}})).await.unwrap();
        } else if frame["id"] == 2 {
            break frame["result"].is_object();
        } else if frame.get("method").is_some() && frame.get("id").is_some() {
            pipe.send(&json!({"jsonrpc":"2.0","id":frame["id"],"error":{"code":-32601,"message":"Resume smoke test does not execute tools"}})).await.unwrap();
        }
    };
    pipe.finish().await;
    std::fs::remove_dir_all(root).unwrap();
    assert!(resumed, "CLI could not restore its smoke session");
}

#[tokio::test]
#[ignore = "Uses the installed, signed-in CodeBuddy CLI; sends one small prompt and restores the session"]
async fn installed_codebuddy_turn_and_resume() {
    installed("codebuddy").await;
}

#[tokio::test]
#[ignore = "Uses the installed, signed-in Qoder CLI; sends one small prompt and restores the session"]
async fn installed_qoder_turn_and_resume() {
    installed("qoder").await;
}

#[tokio::test]
#[ignore = "Uses the installed, signed-in Kiro CLI; runs /help and restores the session"]
async fn installed_kiro_help_and_resume() {
    installed("kiro").await;
}
