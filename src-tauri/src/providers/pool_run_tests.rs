//! End to end: a pooled Claude run that hits a usage limit continues on the next account.
//! A shell script stands in for `claude`; account A is the harness's own setup and B a named
//! connection, each with its own `CLAUDE_CONFIG_DIR`.
//!
//! Connections and provider settings are process-wide and set once, so each scenario runs in a
//! child test process (`child`, ignored unless the parent starts it).
use super::{tests::config, AgentEvent, RunInput, Sink};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::{Arc, Mutex};
use tokio::sync::{mpsc::UnboundedSender, oneshot};

const SCENARIO: &str = "PANDACODE_POOL_RUN_SCENARIO";
const SESSION: &str = "0199aaaa-pool-run";
const STEER: &str = "also check the tests";

fn run_child(scenario: &str) {
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["providers::pool_run_tests::child", "--exact", "--ignored", "--nocapture", "--test-threads=1"])
        .env(SCENARIO, scenario)
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(output.status.success() && stdout.contains("1 passed"), "{scenario}:\n{stdout}\n{}", String::from_utf8_lossy(&output.stderr));
}

#[test]
fn a_limited_account_hands_the_session_to_the_next() {
    run_child("pooled");
}

#[test]
fn with_the_pool_off_the_limit_reaches_the_user() {
    run_child("off");
}

#[test]
fn with_every_other_account_held_the_limit_reaches_the_user() {
    run_child("held");
}

#[test]
fn an_account_not_signed_in_yet_is_skipped() {
    run_child("signed_out");
}

#[test]
fn a_limit_before_any_session_sends_the_original_request_again() {
    run_child("early");
}

#[test]
fn a_model_family_limit_in_a_finished_turn_stays_and_only_marks_near() {
    run_child("family");
}

#[test]
fn stop_during_a_limited_attempt_starts_no_other_account() {
    run_child("stop");
}

#[test]
fn a_steer_sent_while_the_run_changes_accounts_reaches_the_next() {
    run_child("steer");
}

#[test]
fn an_account_near_its_limit_is_left_before_the_turn() {
    run_child("prepare");
}

#[test]
fn an_excluded_account_is_not_used() {
    run_child("excluded");
}

#[test]
fn a_connection_sharing_the_default_login_is_not_used() {
    run_child("same");
}

#[test]
fn a_task_on_an_excluded_account_starts_on_another() {
    run_child("excluded_task");
}

#[test]
fn a_limit_on_a_same_login_name_holds_the_login_and_moves_on() {
    run_child("dup");
}

#[test]
fn a_new_conversation_starts_on_the_quieter_account() {
    run_child("spread");
}

#[test]
fn stop_before_the_run_starts_launches_nothing() {
    run_child("prestop");
}

/// Account A's output after the prompt, per scenario.
fn on_a(scenario: &str, resets_at: i64) -> String {
    let init = format!(r#"echo '{{"type":"system","subtype":"init","session_id":"{SESSION}"}}'"#);
    let id = format!(r#","session_id":"{SESSION}""#);
    let limit = |window: &str, id: &str| format!(r#"echo '{{"type":"rate_limit_event","rate_limit_info":{{"status":"rejected","resetsAt":{resets_at},"rateLimitType":"{window}"}}{id}}}'"#);
    let error = |id: &str| format!(r#"echo '{{"type":"result","subtype":"success","is_error":true,"result":"Claude AI usage limit reached"{id}}}'"#);
    let done = format!(r#"echo '{{"type":"result","subtype":"success","is_error":false,"result":"Done on A","stop_reason":"end_turn"{id}}}'"#);
    let lines = match scenario {
        // No frame names a session.
        "early" => vec![limit("five_hour", ""), error("")],
        // A is only the account the task moves to; its turn ends normally.
        "excluded_task" => vec![init, done],
        "family" => vec![init, limit("seven_day_opus", &id), done],
        // The limit is held back first; the session frame is where the test presses Stop.
        "stop" => vec![limit("five_hour", &id), init, "sleep 3".into(), error(&id)],
        _ => vec![init, limit("five_hour", &id), error(&id)],
    };
    lines.join("\n")
}

/// Answers the initialize request, then logs each launch (config dir, argv, prompt).
/// On A: writes the session file and hits a limit as the scenario asks. On B: logs whether the
/// session file arrived (and a steer, when the scenario sends one), then succeeds.
fn script(log: &Path, a: &Path, resets_at: i64, scenario: &str) -> String {
    let (log, a, on_a) = (log.display(), a.display(), on_a(scenario, resets_at));
    let steer = if scenario == "steer" {
        format!(
            r#"IFS= read -r steer
printf 'steer %s\n' "$steer" >> '{log}'
echo '{{"type":"user","isReplay":true,"message":{{"role":"user","content":[{{"type":"text","text":"{STEER}"}}]}},"session_id":"{SESSION}"}}'"#
        )
    } else {
        String::new()
    };
    format!(
        r#"#!/bin/sh
for arg; do [ "$arg" = --help ] && exit 0; done
IFS= read -r line
echo '{{"type":"control_response","response":{{"subtype":"success","request_id":"pandacode-init","response":{{}}}}}}'
IFS= read -r line
printf 'launch %s|%s|%s\n' "$CLAUDE_CONFIG_DIR" "$*" "$line" >> '{log}'
file="$CLAUDE_CONFIG_DIR/projects/-tmp-app/{SESSION}.jsonl"
if [ "$CLAUDE_CONFIG_DIR" = '{a}' ]; then
mkdir -p "$CLAUDE_CONFIG_DIR/projects/-tmp-app"
echo '{{"type":"user"}}' > "$file"
{on_a}
else
[ -f "$file" ] && echo carried >> '{log}'
{steer}
echo '{{"type":"system","subtype":"init","session_id":"{SESSION}"}}'
echo '{{"type":"assistant","message":{{"id":"m1","role":"assistant","content":[{{"type":"text","text":"Done on B"}}]}},"session_id":"{SESSION}"}}'
echo '{{"type":"result","subtype":"success","is_error":false,"result":"Done on B","stop_reason":"end_turn","session_id":"{SESSION}"}}'
fi
"#
    )
}

type Replies = Arc<Mutex<Vec<oneshot::Receiver<Result<Value, String>>>>>;

/// Collects events and sends the scenario's input at the right moment.
fn sink_for(scenario: &str, events: Arc<Mutex<Vec<AgentEvent>>>, input: UnboundedSender<RunInput>, replies: Replies) -> Sink {
    let scenario = scenario.to_owned();
    Arc::new(move |event: AgentEvent| {
        match (scenario.as_str(), event.kind.as_str()) {
            // A has started and its limit is held back.
            ("stop", "session") => {
                let _ = input.send(RunInput::Stop);
            }
            // The note comes after A has ended and before B starts.
            ("steer", "note") => {
                let (reply, answer) = oneshot::channel();
                let _ = input.send(RunInput::Steer { id: "s1".into(), text: STEER.into(), reply });
                replies.lock().unwrap().push(answer);
            }
            _ => {}
        }
        events.lock().unwrap().push(event);
    })
}

/// Writes the settings and connections files for a scenario and loads them.
fn set_up(root: &Path, a: &Path, b: &Path, exe: &Path, scenario: &str, session_id: &str) {
    let settings = json!({"executablePaths": {"claude": exe}, "environment": {"claude": {"CLAUDE_CONFIG_DIR": a}}});
    std::fs::write(root.join("provider-settings.json"), settings.to_string()).unwrap();
    let pools: &[&str] = if scenario == "off" { &[] } else { &["claude"] };
    let excluded: &[&str] = if matches!(scenario, "excluded" | "excluded_task") { &["claude/b"] } else { &[] };
    // No token of its own and the same folder: the same login as the default setup.
    let b_dir = if scenario == "same" { a } else { b };
    // C has no token and the default setup's folder: a second name for the default login.
    let mut list = vec![json!({"id": "b", "provider": "claude", "name": "Backup", "configDir": b_dir, "revision": 1})];
    if scenario == "dup" {
        list.push(json!({"id": "c", "provider": "claude", "name": "Copy", "configDir": a, "revision": 1}));
    }
    let tasks = match scenario {
        "excluded_task" => json!({session_id: "b"}),
        "dup" => json!({session_id: "c"}),
        _ => json!({}),
    };
    let connections = json!({
        "connections": list,
        "tasks": tasks,
        "pools": pools,
        "poolExcluded": excluded,
    });
    std::fs::write(root.join("connections.json"), connections.to_string()).unwrap();
    crate::provider_settings::setup(root).unwrap();
    crate::connections::setup(root).unwrap();
}

#[tokio::test]
#[ignore = "started by the tests above in their own process"]
async fn child() {
    use std::os::unix::fs::PermissionsExt;
    let Ok(scenario) = std::env::var(SCENARIO) else { return };
    let scenario = scenario.as_str();
    let root = std::env::temp_dir().join(format!("pandacode-pool-run-{}", uuid::Uuid::new_v4()));
    let (a, b, log, exe) = (root.join("a"), root.join("b"), root.join("log"), root.join("claude"));
    std::fs::create_dir_all(&root).unwrap();
    let resets_at = crate::storage::now() / 1000 + 3600;
    std::fs::write(&exe, script(&log, &a, resets_at, scenario)).unwrap();
    std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
    let mut cfg = config("claude");
    cfg.session_id = format!("pool-run-{}", uuid::Uuid::new_v4());
    set_up(&root, &a, &b, &exe, scenario, &cfg.session_id);
    // B is signed in (the file `claude auth login` writes) unless the scenario says otherwise.
    if scenario != "signed_out" {
        std::fs::create_dir_all(&b).unwrap();
        std::fs::write(b.join(".claude.json"), r#"{"oauthAccount":{"emailAddress":"b@example.com"}}"#).unwrap();
    }

    cfg.cwd = root.clone();
    cfg.prompt = "Fix the bug".into();
    match scenario {
        "held" => crate::account_pool::note_limit("claude", "b", None, None),
        "prepare" => {
            std::fs::create_dir_all(a.join("projects/-tmp-app")).unwrap();
            std::fs::write(a.join(format!("projects/-tmp-app/{SESSION}.jsonl")), "{}\n").unwrap();
            cfg.resume_id = Some(SESSION.into());
            crate::account_pool::note_usage(&cfg.session_id, "claude", "five_hour", 95.0, None);
        }
        _ => {}
    }
    // Another task already runs on the default account.
    let _busy = (scenario == "spread").then(|| crate::account_pool::begin("claude", ""));
    let events = Arc::new(Mutex::new(Vec::<AgentEvent>::new()));
    let replies: Replies = Arc::default();
    // A closed input channel means Stop, so the sender lives for the run.
    let (input, receiver) = tokio::sync::mpsc::unbounded_channel();
    let sink = sink_for(scenario, events.clone(), input.clone(), replies.clone());
    if scenario == "prestop" {
        input.send(RunInput::Stop).unwrap();
    }
    let run = super::run_with_tools(cfg.clone(), sink, receiver, None, Default::default());
    let result = tokio::time::timeout(std::time::Duration::from_secs(30), run).await.expect("the run hung");
    let events = events.lock().unwrap().clone();
    let kinds: Vec<&str> = events.iter().map(|e| e.kind.as_str()).collect();
    let log = std::fs::read_to_string(&log).unwrap_or_default();
    let launches: Vec<&str> = log.lines().filter(|l| l.starts_with("launch ")).collect();
    let notes: Vec<&AgentEvent> = events.iter().filter(|e| e.kind == "note").collect();
    let note_texts: Vec<&str> = notes.iter().map(|e| e.text.as_str()).collect();
    let assigned = crate::connections::for_task(&cfg.session_id, "claude").map(|c| c.id);
    let context = format!("{scenario}: {result:?}\nkinds {kinds:?}\nnotes {note_texts:?}\nlog:\n{log}");
    let on = |launch: &str, dir: &Path| launch.starts_with(&format!("launch {}|", dir.display()));
    let carried = log.lines().any(|l| l == "carried");

    match scenario {
        "pooled" | "steer" | "early" | "dup" => {
            assert!(result.is_ok(), "{context}");
            assert!(!kinds.contains(&"limited") && !kinds.contains(&"error"), "{context}");
            assert_eq!(notes.len(), 1, "{context}");
            assert_eq!(note_texts, ["Account switched\nThe default Claude account reached its usage limit, so this task continues on “Backup”."], "{context}");
            assert_eq!(notes[0].data.as_ref().unwrap()["accountPool"]["connectionId"], "b", "{context}");
            assert_eq!(launches.len(), 2, "{context}");
            assert!(on(launches[0], &a) && launches[0].contains("Fix the bug") && !launches[0].contains("--resume"), "{context}");
            assert!(on(launches[1], &b), "{context}");
            assert_eq!(assigned.as_deref(), Some("b"), "{context}");
            if scenario == "early" {
                // No session existed, so the request itself goes again.
                assert!(!launches[1].contains("--resume") && launches[1].contains("Fix the bug") && !launches[1].contains("Continue where"), "{context}");
            } else {
                assert!(launches[1].contains(&format!("--resume={SESSION}")) && launches[1].contains("Continue where you left off."), "{context}");
                assert!(carried, "{context}");
            }
            if scenario == "dup" {
                // C's limit holds the login it shares, the default account.
                let status = serde_json::to_value(crate::account_pool::account_pool_status("claude".into()).await.unwrap()).unwrap();
                let of = |id: &str| status.as_array().unwrap().iter().find(|m| m["id"] == id).unwrap().clone();
                assert!(!of("")["limitedUntil"].is_null(), "{context}\n{status}");
                assert!(of("c")["limitedUntil"].is_null() && of("c")["sameAs"] == "", "{context}\n{status}");
                assert!(of("b")["limitedUntil"].is_null(), "{context}\n{status}");
            }
            if scenario == "steer" {
                assert!(log.lines().any(|l| l.starts_with("steer ") && l.contains(STEER)), "{context}");
                let mut answer = replies.lock().unwrap().pop().expect("a steer was sent");
                assert_eq!(answer.try_recv().expect("the steer was answered").unwrap()["steered"], true, "{context}");
            }
        }
        "prepare" => {
            assert!(result.is_ok(), "{context}");
            assert_eq!(note_texts, ["Account switched\nUsing “Backup” because the default Claude account is near its usage limit."], "{context}");
            assert_eq!(notes[0].data.as_ref().unwrap()["accountPool"]["connectionId"], "b", "{context}");
            assert_eq!(launches.len(), 1, "{context}");
            assert!(on(launches[0], &b) && launches[0].contains(&format!("--resume={SESSION}")) && launches[0].contains("Fix the bug"), "{context}");
            assert!(carried, "{context}");
            assert_eq!(assigned.as_deref(), Some("b"), "{context}");
        }
        "excluded_task" | "spread" => {
            let (to, from, reason, dir, connection) = if scenario == "spread" {
                ("“Backup”", "the default Claude account", "is running more tasks", &b, json!("b"))
            } else {
                ("the default Claude account", "“Backup”", "is out of room or left out of the pool", &a, Value::Null)
            };
            assert!(result.is_ok() && !kinds.contains(&"limited"), "{context}");
            assert_eq!(note_texts, [format!("Account switched\nUsing {to} because {from} {reason}.")], "{context}");
            assert_eq!(notes[0].data.as_ref().unwrap()["accountPool"]["connectionId"], connection, "{context}");
            assert_eq!(launches.len(), 1, "{context}");
            assert!(on(launches[0], dir) && launches[0].contains("Fix the bug") && !launches[0].contains("--resume"), "{context}");
            assert_eq!(assigned, connection.as_str().map(str::to_owned), "{context}");
        }
        "prestop" => {
            assert!(result.is_ok(), "{context}");
            assert!(launches.is_empty() && notes.is_empty() && !kinds.contains(&"limited"), "{context}");
        }
        "stop" => {
            assert_eq!(kinds.iter().filter(|k| **k == "limited").count(), 1, "{context}");
            assert!(notes.is_empty(), "{context}");
            assert_eq!(launches.len(), 1, "{context}");
            assert_eq!(assigned, None, "{context}");
        }
        _ => {
            // off, held, excluded, same, family, signed_out: the limit reaches the user from A.
            assert_eq!(kinds.iter().filter(|k| **k == "limited").count(), 1, "{context}");
            assert!(notes.is_empty(), "{context}");
            assert_eq!(launches.len(), 1, "{context}");
            assert!(on(launches[0], &a), "{context}");
            assert_eq!(assigned, None, "{context}");
            if scenario == "family" {
                assert!(result.is_ok(), "{context}");
                let status = serde_json::to_value(crate::account_pool::account_pool_status("claude".into()).await.unwrap()).unwrap();
                let own = status.as_array().unwrap().iter().find(|m| m["id"] == "").unwrap().clone();
                assert!(own["limitedUntil"].is_null() && !own["nearUntil"].is_null(), "{context}\n{own}");
            }
        }
    }
    drop(input);
    let _ = std::fs::remove_dir_all(root);
}
