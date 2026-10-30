use super::*;
use std::sync::Barrier;
use std::time::Instant;

fn pending_approval(agent: &RunningAgent, id: &str) -> String {
    let scoped = format!("{}:{id}", agent.run_id);
    agent.approvals.lock().unwrap().insert(scoped.clone());
    scoped
}

pub(crate) fn test_state() -> (Arc<AppState>, String) {
    let store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let project = store.add_project(&std::env::temp_dir()).unwrap();
    (
        Arc::new(AppState {
            store: Arc::new(Mutex::new(store)),
            agents: Arc::new(Mutex::new(HashMap::new())),
            terminals: Arc::new(Mutex::new(HashMap::new())),
            shutdown: AtomicU8::new(0),
        }),
        project.id,
    )
}

#[test]
fn recovery_admission_sends_previous_code_before_saving_the_new_request() {
    for provider in ["codex", "claude", "kimi"] {
        let (state, project_id) = test_state();
        let code = "#include <iostream>\nint main() { std::cout << \"Hello, world!\"; }";
        let task = {
            let store = state.store.lock().unwrap();
            let task = store
                .create_session(&project_id, provider, "default", "ask")
                .unwrap();
            store
                .message(&task.id, "user", "Write a C++ example in your answer")
                .unwrap();
            store.message(&task.id, "assistant", code).unwrap();
            task
        };
        let (tx, _rx) = unbounded_channel();
        let prepared = prepare_task_run(
            &state,
            task.id.clone(),
            Some("Put this in a file please".into()),
            Vec::new(),
            tx,
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap();
        assert!(prepared.context_handoff.is_some());
        assert!(prepared.context_handoff.unwrap() < prepared.turn_message_id);
        let history = prepared
            .config
            .prompt
            .split_once("Earlier conversation (JSON):\n")
            .unwrap()
            .1;
        let history = history.split_once("\n\nCurrent request:\n").unwrap().0;
        let history: Vec<serde_json::Value> = serde_json::from_str(history).unwrap();
        assert_eq!(history.len(), 2);
        assert_eq!(history[1]["content"], code);
        assert_eq!(
            prepared
                .config
                .prompt
                .matches("Put this in a file please")
                .count(),
            1
        );
        let store = state.store.lock().unwrap();
        let messages = store.messages(&task.id, None).unwrap();
        assert_eq!(messages.len(), 3);
        assert_eq!(messages[2].id, prepared.turn_message_id);
        assert_eq!(messages[2].content, "Put this in a file please");
        assert!(context_recovery::pending(&store, &store.session(&task.id).unwrap()).unwrap());
    }
}

#[test]
fn recovery_admission_keeps_ordinary_native_resume_prompt_unchanged() {
    let (state, project_id) = test_state();
    let task = {
        let store = state.store.lock().unwrap();
        let task = store
            .create_session(&project_id, "codex", "default", "ask")
            .unwrap();
        store.message(&task.id, "user", "Earlier request").unwrap();
        store
            .message(&task.id, "assistant", "Earlier native answer")
            .unwrap();
        store
            .resume(&task.id, "native-thread-with-history")
            .unwrap();
        task
    };
    let (tx, _rx) = unbounded_channel();
    let prepared = prepare_task_run(
        &state,
        task.id.clone(),
        Some("Continue from there".into()),
        Vec::new(),
        tx,
        Arc::new(AtomicBool::new(false)),
    )
    .unwrap();
    assert!(prepared.context_handoff.is_none());
    assert_eq!(prepared.config.prompt, "Continue from there");
    assert_eq!(
        prepared.config.resume_id.as_deref(),
        Some("native-thread-with-history")
    );
    assert_eq!(
        state
            .store
            .lock()
            .unwrap()
            .messages(&task.id, None)
            .unwrap()
            .len(),
        3
    );
}

#[test]
fn recovery_admission_blocks_native_commands_without_claiming_or_recording_a_turn() {
    for name in ["/compact", "/review"] {
        let (state, project_id) = test_state();
        let (task, cwd) = {
            let store = state.store.lock().unwrap();
            let task = store
                .create_session(&project_id, "codex", "default", "ask")
                .unwrap();
            store
                .message(&task.id, "assistant", "The original code")
                .unwrap();
            context_recovery::queue(&store, &task.id).unwrap();
            // A replacement context exists but has not accepted its handoff yet.
            store.resume(&task.id, "replacement-thread").unwrap();
            let cwd = store.workspace_root(&project_id, Some(&task.id)).unwrap();
            (task, cwd)
        };
        let (tx, _rx) = unbounded_channel();
        let result = prepare_task_run_in_project(
            &state,
            task.id.clone(),
            Some(name.into()),
            Vec::new(),
            tx,
            Arc::new(AtomicBool::new(false)),
            RunAdmission {
                command: Some(PreparedCommand {
                    provider: "codex".into(),
                    cwd,
                    original: name.into(),
                    resolution: slash_commands::Resolution {
                        action: None,
                        arguments: String::new(),
                        accepts_attachments: false,
                        maintenance: name == "/compact",
                        prompt: name.into(),
                        skill: None,
                    },
                }),
                ..Default::default()
            },
        );
        assert!(matches!(result, Err(error) if error == context_recovery::RECOVERY_REQUIRED));
        assert!(state.agents.lock().unwrap().is_empty());
        let store = state.store.lock().unwrap();
        assert_eq!(store.session(&task.id).unwrap().status, "idle");
        assert_eq!(store.messages(&task.id, None).unwrap().len(), 1);
        assert!(context_recovery::pending(&store, &store.session(&task.id).unwrap()).unwrap());
    }
}

#[test]
fn recovery_admission_blocks_starting_or_resuming_goals_without_saving_a_request() {
    for goal in [
        goal_state::GoalRequest::Set {
            objective: "Finish the task".into(),
            token_budget: None,
        },
        goal_state::GoalRequest::Resume,
    ] {
        let (state, project_id) = test_state();
        let task = {
            let store = state.store.lock().unwrap();
            let task = store
                .create_session(&project_id, "codex", "default", "ask")
                .unwrap();
            store
                .message(&task.id, "assistant", "Previous context")
                .unwrap();
            context_recovery::queue(&store, &task.id).unwrap();
            store.resume(&task.id, "replacement-thread").unwrap();
            task
        };
        let (tx, _rx) = unbounded_channel();
        let result = prepare_task_run_in_project(
            &state,
            task.id.clone(),
            Some("Finish the task".into()),
            Vec::new(),
            tx,
            Arc::new(AtomicBool::new(false)),
            RunAdmission {
                goal: Some(goal),
                ..Default::default()
            },
        );
        assert!(matches!(result, Err(error) if error == context_recovery::RECOVERY_REQUIRED));
        assert!(state.agents.lock().unwrap().is_empty());
        let store = state.store.lock().unwrap();
        assert_eq!(store.session(&task.id).unwrap().status, "idle");
        assert_eq!(store.messages(&task.id, None).unwrap().len(), 1);
        assert!(context_recovery::pending(&store, &store.session(&task.id).unwrap()).unwrap());
    }
}

#[test]
fn recovery_admission_goal_inspection_pause_and_clear_never_acknowledge_history() {
    for goal in [
        goal_state::GoalRequest::Get,
        goal_state::GoalRequest::Pause,
        goal_state::GoalRequest::Clear,
    ] {
        let (state, project_id) = test_state();
        let task = {
            let store = state.store.lock().unwrap();
            let task = store
                .create_session(&project_id, "codex", "default", "ask")
                .unwrap();
            store
                .message(&task.id, "assistant", "Previous context")
                .unwrap();
            context_recovery::queue(&store, &task.id).unwrap();
            store.resume(&task.id, "replacement-thread").unwrap();
            task
        };
        let (tx, _rx) = unbounded_channel();
        let prepared = prepare_task_run_in_project(
            &state,
            task.id.clone(),
            Some("Goal control".into()),
            Vec::new(),
            tx,
            Arc::new(AtomicBool::new(false)),
            RunAdmission {
                goal: Some(goal),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(prepared.context_handoff.is_none());
        assert_eq!(prepared.turn_message_id, 0);
        assert_eq!(prepared.config.prompt, "Goal control");
        assert!(prepared.config.goal.is_some());
        let store = state.store.lock().unwrap();
        assert_eq!(store.messages(&task.id, None).unwrap().len(), 1);
        assert!(context_recovery::pending(&store, &store.session(&task.id).unwrap()).unwrap());
    }
}

#[test]
fn recovery_admission_insert_failure_keeps_history_pending_without_claiming_the_agent() {
    let (state, project_id) = test_state();
    let task = {
        let store = state.store.lock().unwrap();
        let task = store
            .create_session(&project_id, "codex", "default", "ask")
            .unwrap();
        store
            .message(&task.id, "assistant", "Must remain available")
            .unwrap();
        store.db.execute_batch("CREATE TRIGGER reject_recovery_prompt BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT,'injected failure'); END;").unwrap();
        task
    };
    let (tx, _rx) = unbounded_channel();
    assert!(prepare_task_run(
        &state,
        task.id.clone(),
        Some("Continue".into()),
        Vec::new(),
        tx,
        Arc::new(AtomicBool::new(false)),
    )
    .is_err());
    assert!(state.agents.lock().unwrap().is_empty());
    let store = state.store.lock().unwrap();
    assert_eq!(store.session(&task.id).unwrap().status, "idle");
    assert_eq!(store.messages(&task.id, None).unwrap().len(), 1);
    assert!(context_recovery::pending(&store, &store.session(&task.id).unwrap()).unwrap());
}

#[test]
fn app_tool_start_rechecks_project_before_claiming_or_saving_a_prompt() {
    let (state, project_id) = test_state();
    let task = state
        .store
        .lock()
        .unwrap()
        .create_session(&project_id, "codex", "default", "ask")
        .unwrap();
    let (tx, _rx) = unbounded_channel();
    let result = prepare_task_run_in_project(
        &state,
        task.id.clone(),
        Some("Do not enqueue".into()),
        Vec::new(),
        tx,
        Arc::new(AtomicBool::new(false)),
        RunAdmission {
            expected_project: Some("different-project"),
            ..Default::default()
        },
    );
    assert!(result.is_err());
    assert!(state.agents.lock().unwrap().is_empty());
    assert!(state
        .store
        .lock()
        .unwrap()
        .messages(&task.id, None)
        .unwrap()
        .is_empty());
}

#[test]
fn simultaneous_starts_admit_all_distinct_tasks_without_duplicate_prompts_or_shared_stop() {
    let (state, project_id) = test_state();
    let tasks = (0..12)
        .map(|_| {
            state
                .store
                .lock()
                .unwrap()
                .create_session(&project_id, "codex", "default", "ask")
                .unwrap()
        })
        .collect::<Vec<_>>();
    let barrier = Arc::new(Barrier::new(tasks.len() + 2));
    let mut contenders = tasks.iter().map(|task| task.id.clone()).collect::<Vec<_>>();
    contenders.push(tasks[0].id.clone());
    let threads = contenders
        .into_iter()
        .map(|sid| {
            let state = state.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                let (tx, rx) = unbounded_channel();
                barrier.wait();
                let prepared = prepare_task_run(
                    &state,
                    sid.clone(),
                    Some(format!("Task {sid}")),
                    Vec::new(),
                    tx,
                    Arc::new(AtomicBool::new(false)),
                );
                (sid, prepared, rx)
            })
        })
        .collect::<Vec<_>>();
    barrier.wait();
    let mut started = Vec::new();
    for worker in threads {
        let (sid, result, rx) = worker.join().unwrap();
        if let Ok(prepared) = result {
            assert_eq!(prepared.config.session_id, sid);
            assert_eq!(prepared.config.prompt, format!("Task {sid}"));
            started.push((sid, rx));
        }
    }
    assert_eq!(started.len(), tasks.len());
    let registry = state.agents.lock().unwrap();
    assert_eq!(registry.len(), tasks.len());
    registry[&started[0].0].send(RunInput::Stop).unwrap();
    for (index, (sid, receiver)) in started.iter_mut().enumerate() {
        assert_eq!(registry[sid].stopped.load(Ordering::SeqCst), index == 0);
        if index == 0 {
            assert!(matches!(receiver.try_recv().unwrap(), RunInput::Stop));
        } else {
            assert!(receiver.try_recv().is_err());
        }
    }
    let store = state.store.lock().unwrap();
    for task in tasks {
        let messages = store.messages(&task.id, None).unwrap();
        assert_eq!(messages.len(), usize::from(registry.contains_key(&task.id)));
        assert!(messages.iter().all(
            |message| message.role == "user" && message.content == format!("Task {}", task.id)
        ));
    }
}

#[test]
fn failed_start_releases_admission_and_shutdown_does_not_enqueue_a_prompt() {
    let (state, project_id) = test_state();
    let task = state
        .store
        .lock()
        .unwrap()
        .create_session(&project_id, "codex", "default", "ask")
        .unwrap();
    state.store.lock().unwrap().db.execute_batch("CREATE TRIGGER reject_prompt BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT,'injected storage failure'); END;").unwrap();
    let (tx, _rx) = unbounded_channel();
    assert!(prepare_task_run(
        &state,
        task.id.clone(),
        Some("Try".into()),
        Vec::new(),
        tx,
        Arc::new(AtomicBool::new(false))
    )
    .is_err());
    assert!(state.agents.lock().unwrap().is_empty());
    assert_eq!(
        state
            .store
            .lock()
            .unwrap()
            .session(&task.id)
            .unwrap()
            .status,
        "idle"
    );
    state
        .store
        .lock()
        .unwrap()
        .db
        .execute_batch("DROP TRIGGER reject_prompt;")
        .unwrap();
    state.shutdown.store(1, Ordering::SeqCst);
    let (tx, _rx) = unbounded_channel();
    assert!(prepare_task_run(
        &state,
        task.id.clone(),
        Some("Try again".into()),
        Vec::new(),
        tx,
        Arc::new(AtomicBool::new(false))
    )
    .is_err());
    assert!(state
        .store
        .lock()
        .unwrap()
        .messages(&task.id, None)
        .unwrap()
        .is_empty());
}

#[test]
fn approval_cancellation_and_reused_provider_ids_are_isolated_to_their_run() {
    let (state, project_id) = test_state();
    let tasks = (0..2)
        .map(|_| {
            state
                .store
                .lock()
                .unwrap()
                .create_session(&project_id, "claude", "sonnet", "ask")
                .unwrap()
        })
        .collect::<Vec<_>>();
    let agents = (0..2)
        .map(|_| {
            let (tx, rx) = unbounded_channel();
            (RunningAgent::new(tx, Arc::new(AtomicBool::new(false))), rx)
        })
        .collect::<Vec<_>>();
    let mut scoped_requests = Vec::new();
    for (task, (agent, _)) in tasks.iter().zip(&agents) {
        let mut request = event(&task.id, "approval", "Allow command?");
        request.request_id = Some("1".into());
        save_approval(&state.store, &agent.approvals, &agent.run_id, &mut request).unwrap();
        scoped_requests.push(request.request_id.unwrap());
    }
    assert_ne!(scoped_requests[0], scoped_requests[1]);
    assert!(agents[1]
        .0
        .respond_approval(&state.store, &tasks[1].id, scoped_requests[0].clone(), true)
        .is_err());
    let mut cancelled = event(&tasks[0].id, "approval_cancelled", "");
    cancelled.request_id = Some("1".into());
    save_approval(
        &state.store,
        &agents[0].0.approvals,
        &agents[0].0.run_id,
        &mut cancelled,
    )
    .unwrap();
    assert_eq!(
        cancelled.request_id.as_deref(),
        Some(scoped_requests[0].as_str())
    );
    assert!(agents[0].0.approvals.lock().unwrap().is_empty());
    assert_eq!(agents[1].0.approvals.lock().unwrap().len(), 1);
    assert_eq!(
        state
            .store
            .lock()
            .unwrap()
            .session(&tasks[0].id)
            .unwrap()
            .status,
        "running"
    );
    assert_eq!(
        state
            .store
            .lock()
            .unwrap()
            .session(&tasks[1].id)
            .unwrap()
            .status,
        "waiting"
    );
    assert!(agents[0]
        .0
        .respond_approval(&state.store, &tasks[0].id, scoped_requests[0].clone(), true)
        .is_err());
    agents[1].0.send(RunInput::Stop).unwrap();
    assert!(agents[1]
        .0
        .respond_approval(&state.store, &tasks[1].id, scoped_requests[1].clone(), true)
        .is_err());
}

#[test]
fn approval_replies_keep_other_requests_waiting_and_reject_old_or_foreign_requests() {
    let store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let project = store.add_project(&std::env::temp_dir()).unwrap();
    let task = store
        .create_session(&project.id, "codex", "default", "ask")
        .unwrap();
    store.begin_task_turn(&task.id, "Build something").unwrap();
    store.status(&task.id, "waiting").unwrap();
    let store = Mutex::new(store);
    let (input, mut receiver) = unbounded_channel();
    let agent = RunningAgent::new(input, Arc::new(AtomicBool::new(false)));
    let first = pending_approval(&agent, "1");
    let second = pending_approval(&agent, "2");

    agent
        .respond_approval(&store, &task.id, first.clone(), true)
        .unwrap();
    assert_eq!(
        store.lock().unwrap().session(&task.id).unwrap().status,
        "waiting"
    );
    assert!(
        matches!(receiver.try_recv().unwrap(), RunInput::Approval { request_id, approved: true } if request_id == "1")
    );
    assert!(agent
        .respond_approval(&store, &task.id, first, true)
        .is_err());
    assert!(agent
        .respond_approval(&store, &task.id, "other-run:2".into(), true)
        .is_err());
    assert!(receiver.try_recv().is_err());

    agent
        .respond_approval(&store, &task.id, second, false)
        .unwrap();
    assert_eq!(
        store.lock().unwrap().session(&task.id).unwrap().status,
        "running"
    );
    assert!(
        matches!(receiver.try_recv().unwrap(), RunInput::Approval { request_id, approved: false } if request_id == "2")
    );
    assert!(agent.approvals.lock().unwrap().is_empty());
}

#[test]
fn four_concurrent_task_streams_persist_independent_responses_and_tool_results() {
    let path = std::env::temp_dir().join(format!(
        "pandacode-concurrent-{}.sqlite3",
        uuid::Uuid::new_v4()
    ));
    let store = Store::open(&path).unwrap();
    let project = store.add_project(&std::env::temp_dir()).unwrap();
    let tasks = (0..4)
        .map(|_| {
            store
                .create_session(&project.id, "codex", "default", "ask")
                .unwrap()
        })
        .collect::<Vec<_>>();
    let store = Arc::new(Mutex::new(store));
    let barrier = Arc::new(Barrier::new(5));
    let started = Instant::now();
    let threads = tasks
        .iter()
        .map(|task| {
            let store = store.clone();
            let barrier = barrier.clone();
            let sid = task.id.clone();
            std::thread::spawn(move || {
                barrier.wait();
                let turn = store
                    .lock()
                    .unwrap()
                    .begin_task_turn(&sid, &format!("Task {sid}"))
                    .unwrap();
                let assistant = Mutex::new(String::new());
                let mut latencies = Vec::new();
                for call in 0..10 {
                    for update in 0..20 {
                        let mut activity = event(&sid, "tool", "Command");
                        activity.tool = Some(providers::ToolActivity {
                            id: format!("call-{call}"),
                            name: "Command".into(),
                            status: if update == 19 { "completed" } else { "running" }.into(),
                            input: sid.clone(),
                            output: format!("{sid}:{}", "output ".repeat(512)),
                write_paths: None,
                        });
                        let start = Instant::now();
                        save_agent_activity(
                            &store.lock().unwrap(),
                            &assistant,
                            &mut activity,
                            None,
                        )
                        .unwrap();
                        latencies.push(start.elapsed().as_micros());
                        std::thread::yield_now();
                    }
                    assistant
                        .lock()
                        .unwrap()
                        .push_str(&format!("Response {sid} {call}."));
                }
                let store = store.lock().unwrap();
                flush_assistant(&store, &sid, &assistant).unwrap();
                store.finish_turn(&sid, turn, 100).unwrap();
                store.finish_tools(&sid).unwrap();
                store.finish_task_turn(&sid, true, false).unwrap();
                latencies
            })
        })
        .collect::<Vec<_>>();
    barrier.wait();
    let mut latencies = threads
        .into_iter()
        .flat_map(|thread| thread.join().unwrap())
        .collect::<Vec<_>>();
    latencies.sort_unstable();
    eprintln!(
        "Four native tasks / 800 persisted tool snapshots: {:?}; operation p95={}μs, max={}μs",
        started.elapsed(),
        latencies[latencies.len() * 95 / 100],
        latencies.last().unwrap()
    );
    {
        let store = store.lock().unwrap();
        for task in tasks {
            let saved = store.messages(&task.id, None).unwrap();
            assert_eq!(
                saved
                    .iter()
                    .filter(|message| message.role == "tool")
                    .count(),
                10
            );
            assert_eq!(
                saved
                    .iter()
                    .filter(|message| message.role == "assistant")
                    .count(),
                10
            );
            assert!(
                saved
                    .iter()
                    .all(|message| message.session_id == task.id
                        && message.content.contains(&task.id))
            );
            assert_eq!(saved[0].turn_duration_ms, Some(100));
            assert_eq!(store.session(&task.id).unwrap().task_stage, "review");
        }
    }
    drop(store);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn slash_commands_are_validated_before_claiming_or_saving() {
    let (state, project_id) = test_state();
    let task = state
        .store
        .lock()
        .unwrap()
        .create_session(&project_id, "codex", "default", "ask")
        .unwrap();
    let (tx, _rx) = unbounded_channel();
    let result = prepare_task_run(
        &state,
        task.id.clone(),
        Some("/unknown-command".into()),
        vec![],
        tx,
        Arc::new(AtomicBool::new(false)),
    );
    assert!(result.is_err());
    assert!(state.agents.lock().unwrap().is_empty());
    assert!(state
        .store
        .lock()
        .unwrap()
        .messages(&task.id, None)
        .unwrap()
        .is_empty());
}

fn resolved_command(provider: &str, cwd: PathBuf, original: &str, prompt: &str) -> PreparedCommand {
    PreparedCommand {
        provider: provider.into(),
        cwd,
        original: original.into(),
        resolution: slash_commands::Resolution {
            action: None,
            arguments: String::new(),
            accepts_attachments: true,
            maintenance: false,
            prompt: prompt.into(),
            skill: None,
        },
    }
}

#[test]
fn a_discovered_skill_preserves_user_text_and_uses_the_bound_skill_path() {
    let (state, project_id) = test_state();
    let task = state
        .store
        .lock()
        .unwrap()
        .create_session(&project_id, "codex", "default", "ask")
        .unwrap();
    let cwd = state
        .store
        .lock()
        .unwrap()
        .workspace_root(&project_id, Some(&task.id))
        .unwrap();
    let skill_path = cwd.join("skill/SKILL.md");
    let mut command = resolved_command(
        "codex",
        cwd,
        "/project-guide retain  arguments",
        "$project-guide retain  arguments",
    );
    command.resolution.skill = Some(("project-guide".into(), skill_path.clone()));
    let (tx, _rx) = unbounded_channel();
    let prepared = prepare_task_run_in_project(
        &state,
        task.id.clone(),
        Some(command.original.clone()),
        vec![],
        tx,
        Arc::new(AtomicBool::new(false)),
        RunAdmission {
            command: Some(command),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(prepared.config.prompt, "$project-guide retain  arguments");
    assert_eq!(
        prepared.config.skill,
        Some(("project-guide".into(), skill_path))
    );
    assert_eq!(
        state
            .store
            .lock()
            .unwrap()
            .messages(&task.id, None)
            .unwrap()[0]
            .content,
        "/project-guide retain  arguments"
    );
    assert!(prepared.restore_stage.is_none());
}

#[test]
fn stale_slash_resolution_cannot_follow_a_changed_harness_checkout_or_description() {
    for mismatch in ["provider", "cwd", "text"] {
        let (state, project_id) = test_state();
        let task = state
            .store
            .lock()
            .unwrap()
            .create_session(&project_id, "codex", "default", "ask")
            .unwrap();
        let cwd = state
            .store
            .lock()
            .unwrap()
            .workspace_root(&project_id, Some(&task.id))
            .unwrap();
        let mut command = resolved_command("codex", cwd, "/review", "/review");
        match mismatch {
            "provider" => command.provider = "claude".into(),
            "cwd" => command.cwd = command.cwd.join("other-checkout"),
            _ => command.original = "/compact".into(),
        }
        let (tx, _rx) = unbounded_channel();
        assert!(prepare_task_run_in_project(
            &state,
            task.id.clone(),
            Some("/review".into()),
            vec![],
            tx,
            Arc::new(AtomicBool::new(false)),
            RunAdmission {
                command: Some(command),
                ..Default::default()
            }
        )
        .is_err());
        assert!(state.agents.lock().unwrap().is_empty());
        assert!(state
            .store
            .lock()
            .unwrap()
            .messages(&task.id, None)
            .unwrap()
            .is_empty());
    }
}

#[test]
fn context_commands_restore_the_board_stage_and_reject_unsupported_images() {
    for (successful, stopped) in [(true, false), (false, false), (false, true)] {
        let (state, project_id) = test_state();
        let task = state
            .store
            .lock()
            .unwrap()
            .create_session(&project_id, "codex", "default", "ask")
            .unwrap();
        let cwd = state
            .store
            .lock()
            .unwrap()
            .workspace_root(&project_id, Some(&task.id))
            .unwrap();
        let mut command = resolved_command("codex", cwd, "/compact", "/compact");
        command.resolution.maintenance = true;
        command.resolution.accepts_attachments = false;
        let (tx, _rx) = unbounded_channel();
        let prepared = prepare_task_run_in_project(
            &state,
            task.id.clone(),
            Some("/compact".into()),
            vec![],
            tx,
            Arc::new(AtomicBool::new(false)),
            RunAdmission {
                command: Some(command),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(prepared.restore_stage.as_deref(), Some("pending"));
        let store = state.store.lock().unwrap();
        store
            .finish_task_operation(
                &task.id,
                successful,
                stopped,
                prepared.restore_stage.as_deref(),
            )
            .unwrap();
        assert_eq!(store.session(&task.id).unwrap().task_stage, "pending");
    }
    let (state, project_id) = test_state();
    let task = state
        .store
        .lock()
        .unwrap()
        .create_session(&project_id, "kimi", "default", "ask")
        .unwrap();
    let cwd = state
        .store
        .lock()
        .unwrap()
        .workspace_root(&project_id, Some(&task.id))
        .unwrap();
    let mut command = resolved_command("kimi", cwd, "/skill:review", "/skill:review");
    command.resolution.accepts_attachments = false;
    let (tx, _rx) = unbounded_channel();
    assert!(prepare_task_run_in_project(
        &state,
        task.id.clone(),
        Some(command.original.clone()),
        vec![PathBuf::from("screenshot.png")],
        tx,
        Arc::new(AtomicBool::new(false)),
        RunAdmission {
            command: Some(command),
            ..Default::default()
        }
    )
    .is_err());
    assert!(state
        .store
        .lock()
        .unwrap()
        .messages(&task.id, None)
        .unwrap()
        .is_empty());
}

fn team_lead_state(provider: &str) -> (Arc<AppState>, String) {
    let (state, project_id) = test_state();
    let sid = {
        let store = state.store.lock().unwrap();
        let task = store
            .create_session(&project_id, provider, "default", "ask")
            .unwrap();
        store
            .db
            .execute(
                "UPDATE sessions SET task_stage='in_progress' WHERE id=?1",
                [&task.id],
            )
            .unwrap();
        let mut team = architect::new_team(
            task.id.clone(),
            architect::TeamConfig {
                auto: false,
                roster_only: false,
                name: None,
                workers: vec![architect::WorkerProfile {
                    id: "fast".into(),
                    name: "Fast worker".into(),
                    provider: "codex".into(),
                    model: "default".into(),
                    reasoning_effort: None,
                }],
                catalog: Vec::new(),
                max_parallel: 3,
                max_rounds: 5,
                max_assignments: 10,
                workspace: "shared".into(),
                summary_limit: 2000,
                lead_guidance: None,
            },
        );
        team.status = "running".into();
        team.generation = 1;
        team.objective = "Build it".into();
        store
            .db
            .execute(
                "INSERT INTO architect_teams(session_id,content) VALUES(?1,?2)",
                rusqlite::params![task.id, serde_json::to_string(&team).unwrap()],
            )
            .unwrap();
        task.id
    };
    (state, sid)
}

// The names slash_commands::resolve_from_catalog marks as maintenance: a lead's own
// harness must run them bare even while its team is configured.
#[test]
fn team_lead_maintenance_commands_run_bare_and_stay_maintenance() {
    for provider in ["claude", "codex"] {
        for name in [
            "/compact",
            "/status",
            "/context",
            "/usage",
            "/cost",
            "/mcp",
            "/tasks",
            "/help",
        ] {
            let (state, sid) = team_lead_state(provider);
            let cwd = {
                let store = state.store.lock().unwrap();
                let session = store.session(&sid).unwrap();
                store
                    .workspace_root(&session.project_id, Some(&sid))
                    .unwrap()
            };
            let mut command = resolved_command(provider, cwd, name, name);
            command.resolution.maintenance = true;
            command.resolution.accepts_attachments = false;
            let (tx, _rx) = unbounded_channel();
            let prepared = prepare_task_run_in_project(
                &state,
                sid.clone(),
                Some(name.into()),
                vec![],
                tx,
                Arc::new(AtomicBool::new(false)),
                RunAdmission {
                    command: Some(command),
                    team: Some(architect::Admission {
                        parent: sid.clone(),
                        generation: 1,
                    }),
                    ..Default::default()
                },
            )
            .unwrap();
            assert_eq!(prepared.config.prompt, name, "{provider} {name}");
            assert_eq!(
                prepared.restore_stage.as_deref(),
                Some("in_progress"),
                "{provider} {name}"
            );
        }
    }
}

#[test]
fn team_lead_texts_that_are_not_maintenance_commands_keep_the_team_briefing() {
    for text in [
        "/review",
        "/unknown-command",
        "Continue with the next step.",
    ] {
        let (state, sid) = team_lead_state("codex");
        let (tx, _rx) = unbounded_channel();
        let prepared = prepare_task_run_in_project(
            &state,
            sid.clone(),
            Some(text.into()),
            vec![],
            tx,
            Arc::new(AtomicBool::new(false)),
            RunAdmission {
                team: Some(architect::Admission {
                    parent: sid.clone(),
                    generation: 1,
                }),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(
            prepared.config.prompt.contains("PandaCode architect mode"),
            "{text}"
        );
        assert!(prepared.config.prompt.contains(text), "{text}");
        assert!(prepared.restore_stage.is_none(), "{text}");
    }
}

#[test]
fn maintenance_commands_without_a_team_stay_bare() {
    let (state, project_id) = test_state();
    let task = state
        .store
        .lock()
        .unwrap()
        .create_session(&project_id, "claude", "default", "ask")
        .unwrap();
    let cwd = state
        .store
        .lock()
        .unwrap()
        .workspace_root(&project_id, Some(&task.id))
        .unwrap();
    let mut command = resolved_command("claude", cwd, "/compact", "/compact");
    command.resolution.maintenance = true;
    command.resolution.accepts_attachments = false;
    let (tx, _rx) = unbounded_channel();
    let prepared = prepare_task_run_in_project(
        &state,
        task.id.clone(),
        Some("/compact".into()),
        vec![],
        tx,
        Arc::new(AtomicBool::new(false)),
        RunAdmission {
            command: Some(command),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(prepared.config.prompt, "/compact");
    assert_eq!(prepared.restore_stage.as_deref(), Some("pending"));
}
