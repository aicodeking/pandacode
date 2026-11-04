//! Local protocol fixtures exercise real overlapping child processes, without CLI
//! credentials or process-wide PATH changes. The lock only protects tests from
//! the separate forced-application-shutdown test, which intentionally kills all.
use super::*;
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};

pub(crate) fn process_test_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

struct TestRun {
    input: UnboundedSender<RunInput>,
    events: UnboundedReceiver<AgentEvent>,
    observed: Arc<Mutex<Vec<AgentEvent>>>,
    task: tokio::task::JoinHandle<Result<(), String>>,
}
impl Drop for TestRun {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl TestRun {
    fn start(id: &str, script: &str) -> Self {
        Self::start_as("claude", id, script)
    }

    fn start_as(provider: &str, id: &str, script: &str) -> Self {
        let mut config = tests::config(provider);
        config.session_id = id.into();
        let (input, receiver) = unbounded_channel();
        let (emit, events) = unbounded_channel();
        let observed = Arc::new(Mutex::new(Vec::new()));
        let saved = observed.clone();
        let sink: Sink = Arc::new(move |event| {
            saved.lock().unwrap().push(event.clone());
            let _ = emit.send(event);
        });
        let mut command = Command::new("/bin/sh");
        command.args(["-c", script, "pandacode-test", id]);
        let task = tokio::spawn(run_process(config, sink, receiver, command, Vec::new()));
        Self {
            input,
            events,
            observed,
            task,
        }
    }

    async fn event(&mut self, kind: &str) -> AgentEvent {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let event = self.events.recv().await.expect("provider exited too soon");
                if event.kind == kind {
                    return event;
                }
            }
        })
        .await
        .expect("provider did not make independent progress")
    }

    async fn finish(&mut self) -> Result<(), String> {
        tokio::time::timeout(Duration::from_secs(10), &mut self.task)
            .await
            .expect("provider did not finish independently")
            .unwrap()
    }

    fn text(&self) -> String {
        self.observed
            .lock()
            .unwrap()
            .iter()
            .filter(|e| e.kind == "text" || e.kind == "note")
            .map(|e| e.text.as_str())
            .collect()
    }
}

const APPROVAL_SCRIPT: &str = r#"
IFS= read -r init
printf '%s\n' '{"type":"control_response","response":{"request_id":"pandacode-init","subtype":"success","response":{}}}'
IFS= read -r prompt
printf '{"type":"system","subtype":"init","session_id":"%s"}\n' "$$"
printf '{"type":"assistant","message":{"id":"same-message-id","content":[{"type":"text","text":"%s before "}]}}\n' "$1"
printf '%s\n' '{"type":"control_request","request_id":"same-request-id","request":{"subtype":"can_use_tool","tool_name":"Read","input":{"file_path":"fixture.txt"}}}'
IFS= read -r response
case "$response" in
  *'"behavior":"allow"'*)
    if [ "$1" = beta ]; then
      dd if=/dev/zero bs=1024 count=128 2>/dev/null | tr '\000' 'e' >&2
      printf '\nfixture failed\n' >&2
      printf '%s\n' 'malformed fixture JSON'
      exit 1
    fi
    printf '{"type":"result","subtype":"success","result":"%s before after"}\n' "$1"
    ;;
  *) exit 0 ;;
esac
"#;

/// Codex's app-server: the main agent spawns a child (settled when `$1` is `settled`) and ends its turn.
const CODEX_SPAWN_SCRIPT: &str = r#"
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*) printf '%s\n' '{"id":1,"result":{}}' ;;
    *'"method":"thread/start"'*) printf '%s\n' '{"id":2,"result":{"thread":{"id":"root"}}}' ;;
    *'"method":"turn/start"'*)
      id=$(printf '%s' "$line" | sed -E 's/^\{"id":([0-9]+).*/\1/')
      printf '{"id":%s,"result":{"turn":{"id":"t1"}}}\n' "$id"
      printf '%s\n' '{"method":"item/completed","params":{"threadId":"root","turnId":"t1","item":{"type":"collabAgentToolCall","id":"call","tool":"spawnAgent","status":"completed","senderThreadId":"root","receiverThreadIds":["kid"],"prompt":"Review","agentsStates":{"kid":{"status":"running","message":null}}}}}'
      if [ "$1" = settled ]; then
        printf '%s\n' '{"method":"thread/status/changed","params":{"threadId":"kid","status":{"type":"idle"}}}'
      fi
      printf '%s\n' '{"method":"turn/completed","params":{"threadId":"root","turn":{"id":"t1","status":"completed"}}}'
      ;;
  esac
done
"#;

#[tokio::test]
async fn a_codex_run_that_ends_before_its_subagent_says_the_report_was_lost() {
    let _serial = process_test_lock().lock().await;
    let mut running = TestRun::start_as("codex", "running", CODEX_SPAWN_SCRIPT);
    running.finish().await.unwrap();
    assert!(running.text().contains("The report from Subagent did not reach the agent"), "{}", running.text());
    let mut settled = TestRun::start_as("codex", "settled", CODEX_SPAWN_SCRIPT);
    settled.finish().await.unwrap();
    assert!(!settled.text().contains("did not reach"), "{}", settled.text());
}

#[tokio::test]
async fn concurrent_processes_isolate_streams_approvals_stop_and_failure() {
    let _serial = process_test_lock().lock().await;
    let mut runs: Vec<_> = ["alpha", "beta", "gamma", "delta"]
        .into_iter()
        .map(|id| TestRun::start(id, APPROVAL_SCRIPT))
        .collect();
    let mut pids = Vec::new();
    let mut approvals = Vec::new();
    for run in &mut runs {
        pids.push(run.event("session").await.text.parse::<u32>().unwrap());
        approvals.push(run.event("approval").await.request_id.unwrap());
    }
    assert_eq!(approvals.iter().collect::<HashSet<_>>().len(), 4);
    for run in &runs {
        assert!(!run.task.is_finished());
    }

    // A request ID from a different run must never answer this one's approval.
    runs[2]
        .input
        .send(RunInput::Approval {
            request_id: approvals[0].clone(),
            approved: true,
        })
        .unwrap();
    runs[0].input.send(RunInput::Stop).unwrap();
    runs[1]
        .input
        .send(RunInput::Approval {
            request_id: approvals[1].clone(),
            approved: true,
        })
        .unwrap();
    runs[0].finish().await.unwrap();
    let failure = runs[1].finish().await.unwrap_err();
    assert!(failure.starts_with("Invalid provider JSON:"));
    assert!(failure.len() < STDERR_LIMIT + 200);
    assert!(!runs[2].task.is_finished());
    assert!(!runs[3].task.is_finished());

    for index in [2, 3] {
        runs[index]
            .input
            .send(RunInput::Approval {
                request_id: approvals[index].clone(),
                approved: true,
            })
            .unwrap();
    }
    runs[2].finish().await.unwrap();
    runs[3].finish().await.unwrap();
    for (index, id) in ["alpha", "beta", "gamma", "delta"].into_iter().enumerate() {
        let expected = if index < 2 {
            format!("{id} before ")
        } else {
            format!("{id} before after")
        };
        assert_eq!(runs[index].text(), expected);
        assert!(runs[index]
            .observed
            .lock()
            .unwrap()
            .iter()
            .all(|event| event.session_id == id));
        assert!(!process_registry().lock().unwrap().contains(&pids[index]));
        assert_eq!(
            unsafe { libc::kill(pids[index] as i32, 0) },
            -1,
            "child process leaked"
        );
    }
}

const LARGE_FRAME_SCRIPT: &str = r#"
IFS= read -r init
printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"large","name":"Read","input":{}}]}}'
printf '%s' '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"large","content":"'
dd if=/dev/zero bs=1024 count=3072 2>/dev/null | tr '\000' 'x'
printf '%s\n' '"}]}}'
printf '{"type":"result","subtype":"success","result":"%s finished"}\n' "$1"
"#;

#[tokio::test]
async fn concurrent_large_frames_keep_outputs_bounded() {
    let _serial = process_test_lock().lock().await;
    let started = std::time::Instant::now();
    let mut runs: Vec<_> = ["one", "two", "three", "four"]
        .into_iter()
        .map(|id| TestRun::start(id, LARGE_FRAME_SCRIPT))
        .collect();
    for (index, id) in ["one", "two", "three", "four"].into_iter().enumerate() {
        runs[index].finish().await.unwrap();
        assert_eq!(runs[index].text(), format!("{id} finished"));
        let events = runs[index].observed.lock().unwrap();
        let output = events
            .iter()
            .filter_map(|event| event.tool.as_ref())
            .find(|tool| tool.status == "completed")
            .expect("large tool completed");
        assert!(output.output.len() <= TOOL_OUTPUT_LIMIT);
        assert!(output.output.ends_with(PREVIEW_TRUNCATED));
    }
    eprintln!("Four concurrent 3 MiB tool frames: {:?}", started.elapsed());
}

#[tokio::test]
async fn aborting_one_provider_future_reaps_only_its_process_group() {
    let _serial = process_test_lock().lock().await;
    let mut abandoned = TestRun::start("abandoned", APPROVAL_SCRIPT);
    let mut continuing = TestRun::start("continuing", APPROVAL_SCRIPT);
    let abandoned_pid = abandoned
        .event("session")
        .await
        .text
        .parse::<u32>()
        .unwrap();
    abandoned.event("approval").await;
    continuing.event("session").await;
    let approval = continuing.event("approval").await.request_id.unwrap();
    abandoned.task.abort();
    assert!(
        tokio::time::timeout(Duration::from_secs(2), &mut abandoned.task)
            .await
            .unwrap()
            .unwrap_err()
            .is_cancelled()
    );
    assert!(!process_registry().lock().unwrap().contains(&abandoned_pid));
    assert!(!continuing.task.is_finished());
    continuing
        .input
        .send(RunInput::Approval {
            request_id: approval,
            approved: true,
        })
        .unwrap();
    continuing.finish().await.unwrap();
    assert_eq!(continuing.text(), "continuing before after");
}

#[tokio::test]
async fn dropping_a_run_does_not_detach_its_stderr_reader() {
    // A descendant may keep the pipe open after the main CLI exits. The task
    // owner must release its reader even when that writer never sends EOF.
    let (mut writer, reader) = tokio::io::duplex(128);
    let task = StderrReader(tokio::spawn(read_stderr(reader)));
    writer.write_all(b"diagnostic").await.unwrap();
    tokio::task::yield_now().await;
    drop(task);
    let outcome = tokio::time::timeout(Duration::from_secs(2), writer.write_all(&[b'x'; 32768]))
        .await
        .expect("stderr reader was not released");
    assert!(
        outcome.is_err(),
        "stderr drain was detached and still consuming data"
    );
}
