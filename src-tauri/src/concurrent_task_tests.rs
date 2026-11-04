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

/// A settled team on a lead with history: a parked worker, a saved request, a board stage.
fn settled_team_lead(provider: &str, stage: &str, status: &str) -> (Arc<AppState>, String) {
    let (state, project_id) = test_state();
    let sid = {
        let store = state.store.lock().unwrap();
        let task = store.create_session(&project_id, provider, "default", "ask").unwrap();
        store.db.execute("UPDATE sessions SET task_stage=?2 WHERE id=?1", rusqlite::params![task.id, stage]).unwrap();
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
        team.status = status.into();
        team.generation = 4;
        team.objective = "Build it".into();
        team.summary = Some("Built it".into());
        team.workers.push(architect::Worker {
            id: "fast".into(),
            session_id: "parked-session".into(),
            name: "Fast worker".into(),
            profile_id: "fast".into(),
            provider: "codex".into(),
            model: "default".into(),
            reasoning_effort: None,
            status: "parked".into(),
            assignment: "Compare the implementations".into(),
            summary: String::new(),
            error: None,
            depends_on: Vec::new(),
            files: Vec::new(),
            read_only: false,
            attempt: 1,
            created_at: 1,
            updated_at: 1,
            keys: Vec::new(),
            abandoned: false,
            result_revision: 0,
            checkpoint: None,
            timed_out: false,
            failovers: 0,
            parent_worker: None,
            resume_prompt: None,
            nudged: false,
            reported: false,
            tool_catalog_version: 0,
        });
        store.db.execute(
            "INSERT INTO architect_teams(session_id,content) VALUES(?1,?2)",
            rusqlite::params![task.id, serde_json::to_string(&team).unwrap()],
        ).unwrap();
        store.db.execute(
            "INSERT INTO architect_requests(parent_session_id,key,kind,content,worker_id) VALUES(?1,'run-tests','dispatch','{}','fast')",
            [&task.id],
        ).unwrap();
        task.id
    };
    (state, sid)
}

/// The harness's real init frame fills the catalog the send path looks commands up in.
fn advertise_claude_commands(state: &AppState, sid: &str) {
    let store = state.store.lock().unwrap();
    let project = store.session(sid).unwrap().project_id;
    let cwd = store.workspace_root(&project, Some(sid)).unwrap();
    assert!(slash_commands::observe_runtime(
        "claude",
        &cwd,
        &serde_json::json!({"type":"system","subtype":"init","slash_commands":["compact","status","help","review"]}),
    ));
}

/// Everything saved for the team, byte for byte, and the number of saved requests.
fn team_record(state: &AppState, sid: &str) -> (String, i64) {
    let store = state.store.lock().unwrap();
    let content = store.db.query_row("SELECT content FROM architect_teams WHERE session_id=?1", [sid], |row| row.get(0)).unwrap();
    let requests = store.db.query_row("SELECT COUNT(*) FROM architect_requests WHERE parent_session_id=?1", [sid], |row| row.get(0)).unwrap();
    (content, requests)
}

fn send_to_lead(state: &AppState, sid: &str, text: &str) -> Result<architect::LeadSend> {
    tauri::async_runtime::block_on(architect::admit_lead_send(state, sid, text, None, None))
}

fn prepare_maintenance(state: &Arc<AppState>, sid: &str, text: &str, command: PreparedCommand) -> Result<PreparedRun> {
    let (tx, _rx) = unbounded_channel();
    prepare_task_run_in_project(
        state,
        sid.to_owned(),
        Some(text.into()),
        vec![],
        tx,
        Arc::new(AtomicBool::new(false)),
        RunAdmission { command: Some(command), ..Default::default() },
    )
}

#[test]
fn lead_maintenance_commands_leave_the_team_and_board_stage_alone() {
    for (stage, text, prompt) in [
        ("review", "/compact", "/compact"),
        ("in_progress", "/compact", "/compact"),
        ("pending", "/compact keep the auth notes", "/compact keep the auth notes"),
        ("review", "/status", "/status"),
    ] {
        for (successful, stopped) in [(true, false), (false, false), (false, true)] {
            let (state, sid) = settled_team_lead("claude", stage, "completed");
            advertise_claude_commands(&state, &sid);
            let before = team_record(&state, &sid);
            let architect::LeadSend::Maintenance(command) = send_to_lead(&state, &sid, text).unwrap() else {
                panic!("{text} must not start a team turn");
            };
            assert_eq!(team_record(&state, &sid), before, "{text}");
            let prepared = prepare_maintenance(&state, &sid, text, command).unwrap();
            assert_eq!(prepared.config.prompt, prompt);
            assert!(prepared.team.is_none());
            assert_eq!(team_record(&state, &sid), before, "{text}");
            // Stop must reach this run alone: the team's own stop would bump its generation.
            assert!(runs_team_maintenance(&state, &sid).unwrap());
            // The run's end, in the order the run does it.
            state.store.lock().unwrap().finish_task_operation(&sid, successful, stopped, prepared.restore_stage.as_deref()).unwrap();
            state.agents.lock().unwrap().remove(&sid);
            architect::completed_state(&state, &sid, prepared.team.as_ref(), successful, stopped, &mut |_| panic!("the team changed"));
            assert_eq!(team_record(&state, &sid), before, "{text}");
            let store = state.store.lock().unwrap();
            assert_eq!(store.session(&sid).unwrap().task_stage, stage, "{text}");
            let team = architect::load(&store, &sid).unwrap().unwrap();
            assert_eq!((team.objective.as_str(), team.generation, team.status.as_str()), ("Build it", 4, "completed"));
            assert_eq!(team.summary.as_deref(), Some("Built it"));
            assert_eq!(team.workers[0].status, "parked");
        }
    }
}

/// Stop during `/compact` on a settled team: the desktop sends it through the team's control.
#[test]
fn team_stop_during_lead_maintenance_stops_only_that_run() {
    let (state, sid) = settled_team_lead("claude", "review", "completed");
    advertise_claude_commands(&state, &sid);
    let before = team_record(&state, &sid);
    let architect::LeadSend::Maintenance(command) = send_to_lead(&state, &sid, "/compact").unwrap() else {
        panic!("/compact must not start a team turn");
    };
    let (tx, mut rx) = unbounded_channel();
    prepare_task_run_in_project(
        &state,
        sid.clone(),
        Some("/compact".into()),
        vec![],
        tx,
        Arc::new(AtomicBool::new(false)),
        RunAdmission { command: Some(command), ..Default::default() },
    )
    .unwrap();

    let team = architect::control_state(&state, &sid, "stop").unwrap();

    assert!(matches!(rx.try_recv(), Ok(RunInput::Stop)), "the agent never got the stop");
    assert_eq!((team.generation, team.status.as_str()), (4, "completed"));
    assert_eq!(team.workers[0].status, "parked");
    assert_eq!(team_record(&state, &sid), before);

    // Discriminates: once the run is gone, the same action is the team's own stop.
    state.agents.lock().unwrap().remove(&sid);
    let team = architect::control_state(&state, &sid, "stop").unwrap();
    assert_eq!((team.generation, team.status.as_str()), (5, "paused"));
}

#[test]
fn other_lead_messages_still_start_a_team_turn() {
    for text in [
        "/status of the migration",
        "/help me choose a schema",
        "/review",
        "/not-advertised",
        "Continue with the next step.",
    ] {
        let (state, sid) = settled_team_lead("claude", "review", "completed");
        advertise_claude_commands(&state, &sid);
        let architect::LeadSend::Team(team, admission) = send_to_lead(&state, &sid, text).unwrap() else {
            panic!("{text} must go to the team");
        };
        assert_eq!((team.objective.as_str(), team.generation), (text, 5));
        let (tx, _rx) = unbounded_channel();
        let prepared = prepare_task_run_in_project(
            &state,
            sid.clone(),
            Some(text.into()),
            vec![],
            tx,
            Arc::new(AtomicBool::new(false)),
            RunAdmission { team: Some(admission), ..Default::default() },
        )
        .unwrap();
        assert!(prepared.config.prompt.contains("PandaCode architect mode"), "{text}");
        assert!(prepared.config.prompt.contains(text), "{text}");
        assert!(prepared.restore_stage.is_none(), "{text}");
        assert!(!runs_team_maintenance(&state, &sid).unwrap());
    }
}

#[test]
fn a_compact_guard_error_returns_before_any_team_change() {
    let (state, sid) = settled_team_lead("codex", "review", "completed");
    let before = team_record(&state, &sid);
    assert_eq!(send_to_lead(&state, &sid, "/compact").err().as_deref(), Some(COMPACT_NEEDS_CONVERSATION));
    assert_eq!(team_record(&state, &sid), before);
    assert_eq!(state.store.lock().unwrap().session(&sid).unwrap().task_stage, "review");
}

#[test]
fn a_failed_command_lookup_leaves_the_message_for_the_team() {
    for error in ["Command discovery timed out.", "Unknown command /x.", "This command opens a PandaCode control. Run it from the message box."] {
        assert!(team_command_gate(Err(error.into())).unwrap().is_none(), "{error}");
    }
    assert!(team_command_gate(Err(COMPACT_NEEDS_CONVERSATION.into())).is_err());
}

#[test]
fn maintenance_is_refused_on_an_active_team_and_on_its_workers() {
    let (state, sid) = settled_team_lead("claude", "in_progress", "waiting");
    advertise_claude_commands(&state, &sid);
    let before = team_record(&state, &sid);
    let architect::LeadSend::Maintenance(command) = send_to_lead(&state, &sid, "/compact").unwrap() else {
        panic!("/compact must not start a team turn");
    };
    assert!(prepare_maintenance(&state, &sid, "/compact", command).is_err());
    assert_eq!(team_record(&state, &sid), before);
    assert!(state.agents.lock().unwrap().is_empty());
    assert!(state.store.lock().unwrap().messages(&sid, None).unwrap().is_empty());

    let (state, lead) = settled_team_lead("claude", "review", "completed");
    let worker = {
        let store = state.store.lock().unwrap();
        let project = store.session(&lead).unwrap().project_id;
        let worker = store.create_session(&project, "claude", "default", "ask").unwrap();
        let mut team = architect::load(&store, &lead).unwrap().unwrap();
        team.workers[0].session_id = worker.id.clone();
        store.db.execute("UPDATE architect_teams SET content=?2 WHERE session_id=?1", rusqlite::params![lead, serde_json::to_string(&team).unwrap()]).unwrap();
        store.db.execute("INSERT INTO architect_workers(parent_session_id,worker_id,session_id) VALUES(?1,'fast',?2)", rusqlite::params![lead, worker.id]).unwrap();
        worker.id
    };
    advertise_claude_commands(&state, &worker);
    let architect::LeadSend::Maintenance(command) = send_to_lead(&state, &worker, "/compact").unwrap() else {
        panic!("a worker has no team of its own to start");
    };
    assert!(prepare_maintenance(&state, &worker, "/compact", command).is_err());
    assert!(state.agents.lock().unwrap().is_empty());
}

// A worker's assignment is model-authored text: even a "/status" opener is briefed verbatim.
#[test]
fn worker_assignments_never_run_as_commands() {
    for text in ["/compact", "/status of the migration: verify each step."] {
        let (state, lead) = settled_team_lead("claude", "in_progress", "running");
        let worker = {
            let store = state.store.lock().unwrap();
            let project = store.session(&lead).unwrap().project_id;
            let worker = store.create_session(&project, "claude", "default", "ask").unwrap();
            let mut team = architect::load(&store, &lead).unwrap().unwrap();
            team.workers[0].session_id = worker.id.clone();
            team.workers[0].status = "running".into();
            store.db.execute("UPDATE architect_teams SET content=?2 WHERE session_id=?1", rusqlite::params![lead, serde_json::to_string(&team).unwrap()]).unwrap();
            worker.id
        };
        let (tx, _rx) = unbounded_channel();
        let prepared = prepare_task_run_in_project(
            &state,
            worker,
            Some(text.into()),
            vec![],
            tx,
            Arc::new(AtomicBool::new(false)),
            RunAdmission { team: Some(architect::Admission { parent: lead, generation: 4 }), ..Default::default() },
        )
        .unwrap();
        assert!(prepared.config.prompt.contains("PandaCode worker named"), "{text}");
        assert!(prepared.config.prompt.contains(text), "{text}");
        assert!(prepared.restore_stage.is_none(), "{text}");
    }
}
