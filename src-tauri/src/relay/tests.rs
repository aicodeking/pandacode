use super::*;
use crate::storage::Store;
use std::path::Path;

fn store() -> Store {
    Store::open(Path::new(":memory:")).unwrap()
}

fn task(store: &Store) -> crate::storage::Session {
    let project = store.add_project(&std::env::temp_dir()).unwrap();
    store
        .create_session(&project.id, "codex", "gpt-test", "ask")
        .unwrap()
}

/// The packet's own wire size, the number the 64 KiB guarantee is about.
fn wire(packet: &Packet) -> usize {
    serde_json::to_string(packet).unwrap().len()
}

#[test]
fn a_checkpoint_is_progress_and_never_completion() {
    let store = store();
    let task = task(&store);
    let checkpoint = save_checkpoint(
        &store,
        &task.id,
        "Ship the relay",
        &["Reference by id, never summarize".into()],
        &["Should OriginFold blocks be indexed?".into()],
        &["src-tauri/src/relay.rs".into()],
        &["cargo test --lib relay".into()],
    )
    .unwrap();
    assert_eq!(checkpoint.ordinal, 1);
    assert_eq!(checkpoint.decisions.len(), 1);

    // The task is still not done, and the checkpoint did not pretend otherwise.
    let gate = done_gate(&store, &task.id).unwrap();
    assert!(!gate.done, "a checkpoint must not mark the task done");
    assert_eq!(gate.stage, "pending");
    assert!(gate.blocked, "real progress without done blocks the next task");
    assert_eq!(gate.checkpoint.map(|c| c.ordinal), Some(1));
}

#[test]
fn ordinals_are_sequential_and_the_latest_checkpoint_wins() {
    let store = store();
    let task = task(&store);
    for index in 1..=3 {
        let checkpoint = save_checkpoint(&store, &task.id, &format!("goal {index}"), &[], &[], &[], &[]).unwrap();
        assert_eq!(checkpoint.ordinal, index);
    }
    let latest = latest_checkpoint(&store, &task.id).unwrap().unwrap();
    assert_eq!((latest.ordinal, latest.goal.as_str()), (3, "goal 3"));
    assert_eq!(checkpoints(&store, &task.id).unwrap().len(), 3);
}

#[test]
fn checkpoint_lines_are_bounded_and_blank_ones_dropped() {
    let store = store();
    let task = task(&store);
    let huge = "x".repeat(MAX_LINE_BYTES * 4);
    let many: Vec<String> = (0..100).map(|i| format!("decision {i}")).collect();
    let checkpoint = save_checkpoint(&store, &task.id, "g", &[huge.clone(), "  ".into()], &[], &many, &[]).unwrap();
    assert_eq!(checkpoint.decisions.len(), 1, "blank lines are dropped");
    assert!(checkpoint.decisions[0].len() <= MAX_LINE_BYTES + "\\n[shortened]".len() + 1);
    assert_eq!(checkpoint.files.len(), MAX_CHECKPOINT_LINES, "the list is capped");
}

#[test]
fn a_packet_indexes_the_conversation_and_references_every_message_by_id() {
    let store = store();
    let task = task(&store);
    for index in 0..5 {
        store.message(&task.id, "user", &format!("question {index}")).unwrap();
        store.message(&task.id, "assistant", &format!("answer {index}")).unwrap();
    }
    // Tool output and bookkeeping are never inlined.
    store.message(&task.id, "tool", "megabytes of output").unwrap();
    store.message(&task.id, "system", "bookkeeping").unwrap();

    let packet = build_packet(&store, &task.id, false).unwrap();
    assert_eq!(packet.v, VERSION);
    assert_eq!(packet.messages.len(), 10);
    assert!(
        packet.messages.iter().all(|m| m.role == "user" || m.role == "assistant"),
        "only conversation roles are indexed"
    );
    // Chronological, and every id resolves back to the exact saved row.
    let ids: Vec<i64> = packet.messages.iter().map(|m| m.id).collect();
    assert!(ids.windows(2).all(|pair| pair[0] < pair[1]), "deterministic ordering");
    let expanded = expand(&store, &packet, &ids).unwrap();
    assert_eq!(expanded.len(), 10);
    assert_eq!(expanded[0].content, "question 0");
    assert_eq!(expanded[9].content, "answer 4");
    assert!(packet.checkpoint.is_none(), "no checkpoint yet");
    assert!(packet.truncated.is_none());
}

#[test]
fn expand_returns_originals_verbatim_even_when_the_index_shortened_them() {
    let store = store();
    let task = task(&store);
    let original = "竹🌱\"\\\n\t exact text that must come back unchanged";
    store.message(&task.id, "user", original).unwrap();
    // A checkpoint whose high-water covers the row, so the packet indexes it.
    save_checkpoint(&store, &task.id, "g", &[], &[], &[], &[]).unwrap();
    let packet = build_packet(&store, &task.id, true).unwrap();
    let ids: Vec<i64> = packet.messages.iter().map(|m| m.id).collect();
    let expanded = expand(&store, &packet, &ids).unwrap();
    assert_eq!(expanded[0].content, original, "the packet is an index, not a summary");
}

#[test]
fn expand_cannot_read_another_tasks_messages() {
    let store = store();
    let mine = task(&store);
    let other = task(&store);
    store.message(&mine.id, "user", "mine").unwrap();
    let secret = store.insert_message(&other.id, "user", "another task's private text").unwrap();
    let packet = build_packet(&store, &mine.id, false).unwrap();
    assert!(
        expand(&store, &packet, &[secret]).unwrap().is_empty(),
        "a relay id only reaches its own task"
    );
}

#[test]
fn a_packet_stays_inside_its_byte_budget_and_records_truncation() {
    let store = store();
    let task = task(&store);
    for index in 0..300 {
        store.message(&task.id, "user", &format!("older message {index}")).unwrap();
    }
    let huge = "竹🌱\"\\".repeat(40_000);
    store.message(&task.id, "assistant", &huge).unwrap();
    store.message(&task.id, "user", "newest meaningful context").unwrap();

    let packet = build_packet(&store, &task.id, false).unwrap();
    assert!(packet.messages.len() <= PACKET_MESSAGES);
    assert!(wire(&packet) <= PACKET_BYTES + 8 * 1024, "bounded: {} bytes", wire(&packet));
    // The newest context always survives; the oldest is what goes.
    assert_eq!(packet.messages.last().unwrap().excerpt, "newest meaningful context");
    let truncated = packet.truncated.expect("truncation is recorded, never silent");
    assert!(truncated.omitted_messages > 0);
    assert!(packet.token_accounting.before > packet.token_accounting.packet);
}

#[test]
fn the_same_rows_build_the_same_packet() {
    let store = store();
    let task = task(&store);
    for index in 0..20 {
        store.message(&task.id, "user", &format!("m{index}")).unwrap();
    }
    let first = build_packet(&store, &task.id, false).unwrap();
    let second = build_packet(&store, &task.id, false).unwrap();
    // Only the fresh relay id differs: ordering, contents and accounting are deterministic.
    let entries = |packet: &Packet| -> Vec<(i64, String, String)> {
        packet
            .messages
            .iter()
            .map(|m| (m.id, m.role.clone(), m.excerpt.clone()))
            .collect()
    };
    assert_eq!(entries(&first), entries(&second));
    assert_eq!(first.goal, second.goal);
    assert_eq!(first.token_accounting.before, second.token_accounting.before);
    assert_eq!(first.token_accounting.packet, second.token_accounting.packet);
    assert_ne!(first.relay_id, second.relay_id);
}

#[test]
fn requiring_a_checkpoint_refuses_a_task_that_has_none() {
    let store = store();
    let task = task(&store);
    store.message(&task.id, "user", "hello").unwrap();
    assert!(build_packet(&store, &task.id, true).is_err());
    save_checkpoint(&store, &task.id, "g", &[], &[], &[], &[]).unwrap();
    assert!(build_packet(&store, &task.id, true).is_ok());
}

#[test]
fn a_checkpoint_bounds_the_packet_at_its_high_water() {
    let store = store();
    let task = task(&store);
    store.message(&task.id, "user", "before the checkpoint").unwrap();
    let checkpoint = save_checkpoint(&store, &task.id, "g", &[], &[], &[], &[]).unwrap();
    store.message(&task.id, "user", "after the checkpoint").unwrap();
    let packet = build_packet(&store, &task.id, true).unwrap();
    assert_eq!(
        packet
            .checkpoint
            .as_ref()
            .map(|c| c.message_high_water),
        Some(checkpoint.message_high_water)
    );
    assert!(
        packet.messages.iter().all(|m| m.id <= checkpoint.message_high_water),
        "a relay from a checkpoint carries only what the checkpoint knew"
    );
}

#[test]
fn resume_is_attempted_once_then_relay() {
    let store = store();
    let task = task(&store);
    assert_eq!(escalation(&store, &task.id).unwrap().next_step(), EscalationStep::Resume);
    assert_eq!(record_death(&store, &task.id, EndKind::Harness).unwrap(), EscalationStep::Resume);
    // The second death in a row relays: resume gets one attempt, as the issue requires.
    assert_eq!(record_death(&store, &task.id, EndKind::Harness).unwrap(), EscalationStep::Relay);
    assert_eq!(record_death(&store, &task.id, EndKind::Crashed).unwrap(), EscalationStep::Relay);
    let ladder = escalation(&store, &task.id).unwrap();
    assert_eq!((ladder.resumes, ladder.relays), (1, 2));
    assert_eq!(ladder.last_end, Some(EndKind::Crashed));
}

#[test]
fn a_checkpoint_resets_the_escalation_ladder() {
    let store = store();
    let task = task(&store);
    record_death(&store, &task.id, EndKind::Harness).unwrap();
    record_death(&store, &task.id, EndKind::Harness).unwrap();
    assert_eq!(escalation(&store, &task.id).unwrap().next_step(), EscalationStep::Relay);
    // Real progress earns a fresh resume, so a task that recovers is never stuck on "relay".
    save_checkpoint(&store, &task.id, "g", &[], &[], &[], &[]).unwrap();
    assert_eq!(escalation(&store, &task.id).unwrap().next_step(), EscalationStep::Resume);
}

#[test]
fn delivery_is_idempotent_across_retries_and_restarts() {
    let store = store();
    let task = task(&store);
    store.message(&task.id, "user", "carry this").unwrap();
    let packet = build_packet(&store, &task.id, false).unwrap();
    queue_relay(&store, &task.id, &packet).unwrap();

    let (prompt, relay_id) = apply_to_prompt(&store, &task.id, "Continue");
    assert!(prompt.contains("Relay packet (JSON):"));
    assert!(prompt.ends_with("Current request:\nContinue"));
    assert_eq!(prompt.matches("Continue").count(), 1, "the request appears once");
    let relay_id = relay_id.expect("a queued packet is injected once");

    // Delivering twice is the same as once; a second ack reports nothing was changed.
    assert!(acknowledge_relay(&store, &relay_id).unwrap());
    assert!(!acknowledge_relay(&store, &relay_id).unwrap(), "ack is idempotent");
    let (plain, none) = apply_to_prompt(&store, &task.id, "Continue");
    assert_eq!(plain, "Continue");
    assert!(none.is_none(), "no second injection after the ack");
}

#[test]
fn an_undelivered_relay_is_injected_again_after_a_restart() {
    let dir = std::env::temp_dir().join(format!("pandacode-relay-{}", crate::storage::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("state.sqlite");
    let (sid, relay_id);
    {
        let store = Store::open(&path).unwrap();
        let task = task(&store);
        sid = task.id.clone();
        store.message(&sid, "user", "work in progress").unwrap();
        let packet = build_packet(&store, &sid, false).unwrap();
        queue_relay(&store, &sid, &packet).unwrap();
        let (_, id) = apply_to_prompt(&store, &sid, "Continue");
        relay_id = id.unwrap();
    }
    {
        // The run that took the packet never finished: the notice must survive.
        let store = Store::open(&path).unwrap();
        let (prompt, again) = apply_to_prompt(&store, &sid, "Try again");
        assert!(prompt.contains("Relay packet (JSON):"));
        assert_eq!(again.as_deref(), Some(relay_id.as_str()));
        assert!(acknowledge_relay(&store, &relay_id).unwrap());
    }
    let store = Store::open(&path).unwrap();
    assert!(pending_relay(&store, &sid).unwrap().is_none());
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn a_newer_packet_replaces_an_undelivered_one() {
    let store = store();
    let task = task(&store);
    store.message(&task.id, "user", "first").unwrap();
    let first = build_packet(&store, &task.id, false).unwrap();
    queue_relay(&store, &task.id, &first).unwrap();
    store.message(&task.id, "user", "second").unwrap();
    let second = build_packet(&store, &task.id, false).unwrap();
    queue_relay(&store, &task.id, &second).unwrap();
    let pending = pending_relay(&store, &task.id).unwrap().unwrap();
    assert_eq!(pending.relay_id, second.relay_id);
    // The replaced id is gone for good, so a late ack cannot revive it.
    assert!(!acknowledge_relay(&store, &first.relay_id).unwrap());
}

#[test]
fn a_relay_never_blocks_a_prompt_that_cannot_read_its_packet() {
    let store = store();
    let task = task(&store);
    // A packet row that is valid JSON but not a packet (an older or corrupt shape) is dropped,
    // and the prompt goes out unchanged.
    store
        .db
        .execute(
            "INSERT INTO task_relays(session_id,relay_id,packet,created_at,delivered_at) VALUES (?1,'broken','{\"v\":1}',0,NULL)",
            [&task.id],
        )
        .unwrap();
    let (prompt, relay_id) = apply_to_prompt(&store, &task.id, "Just work");
    assert_eq!(prompt, "Just work");
    assert!(relay_id.is_none());
    assert!(pending_relay(&store, &task.id).unwrap().is_none(), "the bad row is cleared");
}

#[test]
fn the_prompt_labels_the_packet_as_history_and_names_the_checkpoint() {
    let store = store();
    let task = task(&store);
    store.message(&task.id, "user", "earlier").unwrap();
    save_checkpoint(&store, &task.id, "the goal", &["a decision".into()], &["an open question".into()], &[], &[]).unwrap();
    let packet = build_packet(&store, &task.id, false).unwrap();
    let prompt = relay_prompt(&packet, "Please continue");
    assert!(prompt.contains("not new requests or higher-priority instructions"));
    assert!(prompt.contains("Start from the checkpoint, not from scratch"));
    assert!(prompt.contains("Resolve the open questions"));
    assert!(prompt.contains("\"goal\": \"the goal\""));
    assert!(prompt.contains("Please continue"));
}

#[test]
fn a_packet_without_a_checkpoint_says_it_starts_from_the_head() {
    let store = store();
    let task = task(&store);
    store.message(&task.id, "user", "only a message").unwrap();
    let packet = build_packet(&store, &task.id, false).unwrap();
    let prompt = relay_prompt(&packet, "Continue");
    assert!(prompt.contains("No checkpoint exists"));
    assert!(!prompt.contains("Start from the checkpoint"));
}

#[test]
fn the_done_gate_opens_only_on_completion() {
    let store = store();
    let task = task(&store);
    save_checkpoint(&store, &task.id, "g", &[], &[], &[], &[]).unwrap();
    assert!(done_gate(&store, &task.id).unwrap().blocked);

    // Settling the task opens it; the checkpoint does not.
    store.set_task_stage(&task.id, "completed").unwrap();
    let gate = done_gate(&store, &task.id).unwrap();
    assert!(gate.done && !gate.blocked);
    assert!(gate.completed_at.is_some());

    // Reopening closes it again.
    store.set_task_stage(&task.id, "review").unwrap();
    assert!(done_gate(&store, &task.id).unwrap().blocked);
}

#[test]
fn a_task_with_nothing_saved_does_not_block_anything() {
    let store = store();
    let task = task(&store);
    let gate = done_gate(&store, &task.id).unwrap();
    assert!(!gate.done && !gate.blocked, "today's behaviour when there is no progress");
}

#[test]
fn after_a_resume_a_second_death_queues_the_packet_the_next_run_carries() {
    let store = store();
    let task = task(&store);
    store.message(&task.id, "user", "the original task").unwrap();
    store.message(&task.id, "assistant", "progress so far").unwrap();
    save_checkpoint(&store, &task.id, "finish the relay", &["keep ids".into()], &[], &[], &[]).unwrap();

    // First death: the ladder spends its one resume, and nothing is queued yet.
    store.finish_task_operation(&task.id, false, false, None).unwrap();
    assert!(pending_relay(&store, &task.id).unwrap().is_none(), "resume first, not relay");

    // Second death in a row: the next run must be a handoff, so a packet is queued for it.
    store.finish_task_operation(&task.id, false, false, None).unwrap();
    let queued = pending_relay(&store, &task.id).unwrap().expect("a packet is queued");
    assert_eq!(queued.packet.goal, "finish the relay");
    assert!(!queued.packet.messages.is_empty());

    // The next prompt carries it, and a successful run acknowledges exactly once.
    let (prompt, relay_id) = apply_to_prompt(&store, &task.id, "keep going");
    assert!(prompt.contains("Relay packet (JSON):"));
    assert!(prompt.ends_with("Current request:\nkeep going"));
    store.finish_task_operation(&task.id, true, false, None).unwrap();
    assert!(acknowledge_relay(&store, &relay_id.unwrap()).unwrap());
    assert!(pending_relay(&store, &task.id).unwrap().is_none());
    // A clean run also clears the ladder, so the next failure starts from a resume again.
    assert_eq!(escalation(&store, &task.id).unwrap().next_step(), EscalationStep::Resume);
}

#[test]
fn a_users_stop_never_queues_a_relay_or_advances_the_ladder() {
    let store = store();
    let task = task(&store);
    store.message(&task.id, "user", "work").unwrap();
    for _ in 0..3 {
        store.finish_task_operation(&task.id, false, true, None).unwrap();
    }
    assert_eq!(escalation(&store, &task.id).unwrap().last_end, None);
    assert!(pending_relay(&store, &task.id).unwrap().is_none());
}

#[test]
fn the_preferences_change_the_ladder_the_gate_and_automatic_relay() {
    let store = store();
    let task = task(&store);
    assert_eq!(settings(&store), Settings::default(), "nothing saved reads as the defaults");

    // "Retry the same agent first" off: the very first death relays.
    set_settings(&store, &Settings { retry_same_agent_first: false, ..Settings::default() }).unwrap();
    assert_eq!(record_death(&store, &task.id, EndKind::Harness).unwrap(), EscalationStep::Relay);
    clear_escalation(&store, &task.id).unwrap();

    // "Auto-relay on crash" off: a death queues nothing, so the task waits for the user.
    set_settings(&store, &Settings { auto_relay_on_crash: false, ..Settings::default() }).unwrap();
    store.message(&task.id, "user", "work").unwrap();
    store.finish_task_operation(&task.id, false, false, None).unwrap();
    store.finish_task_operation(&task.id, false, false, None).unwrap();
    assert!(pending_relay(&store, &task.id).unwrap().is_none(), "automatic relay is off");
    assert!(queue_from_checkpoint(&store, &task.id).unwrap().is_none(), "skipped, not an error");

    // "Hold tasks until done" off: progress without completion no longer blocks.
    save_checkpoint(&store, &task.id, "g", &[], &[], &[], &[]).unwrap();
    set_settings(&store, &Settings { done_gate: false, ..Settings::default() }).unwrap();
    assert!(!done_gate(&store, &task.id).unwrap().blocked);

    // A row whose values are the wrong shape reads as the defaults rather than failing.
    store
        .db
        .execute(
            "UPDATE relay_settings SET content=json('{\"autoRelayOnCrash\":\"yes\",\"doneGate\":null}') WHERE id=1",
            [],
        )
        .unwrap();
    assert_eq!(settings(&store), Settings::default());
}

#[test]
fn requiring_a_checkpoint_stops_an_automatic_relay_but_not_a_users_own() {
    let store = store();
    let task = task(&store);
    store.message(&task.id, "user", "no checkpoint here").unwrap();
    set_settings(&store, &Settings { require_checkpoint_before_relay: true, ..Settings::default() }).unwrap();
    assert!(queue_from_checkpoint(&store, &task.id).is_err(), "the preference refuses it");
    // The user asking for a relay explicitly is not refused: they chose it.
    assert!(queue_packet(&store, &task.id, true).is_ok());
}

#[test]
fn a_crash_counts_as_a_death_only_when_the_task_is_resumed() {
    let dir = std::env::temp_dir().join(format!("pandacode-relay-crash-{}", crate::storage::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("state.sqlite");
    let (crashed, stopped);
    {
        let store = Store::open(&path).unwrap();
        crashed = task(&store).id;
        stopped = task(&store).id;
        store.message(&crashed, "user", "mid-run work").unwrap();
        store.message(&stopped, "user", "also mid-run").unwrap();
        // A running task the app dies under: startup recovery marks it interrupted.
        store.status(&crashed, "running").unwrap();
        store.status(&stopped, "running").unwrap();
        store.request_stop(&stopped).unwrap();
    }
    // Opening the app after a crash writes nothing: the ladder is still empty.
    let store = Store::open(&path).unwrap();
    assert_eq!(escalation(&store, &crashed).unwrap().last_end, None, "opening never writes");
    assert_eq!(escalation(&store, &crashed).unwrap().resumes, 0);

    // Resuming the crashed task records the death, so one resume is spent and the next death relays.
    store.message(&crashed, "user", "Continue").unwrap();
    store.begin_task_turn(&crashed, "Continue").unwrap();
    let ladder = escalation(&store, &crashed).unwrap();
    assert_eq!(ladder.last_end, Some(EndKind::Crashed));
    assert_eq!((ladder.resumes, ladder.relays), (1, 0));
    assert_eq!(ladder.next_step(), EscalationStep::Relay);

    // A Stop the user asked for is not the agent dying, so starting it again records nothing.
    store.begin_task_turn(&stopped, "Continue").unwrap();
    assert_eq!(escalation(&store, &stopped).unwrap().last_end, None);
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn a_database_from_before_relay_gains_its_tables_and_keeps_user_version_37() {
    // Relay's tables are additive at the current schema version, so an install that predates the
    // feature must still get them without moving `user_version` (older releases keep opening it).
    let dir = std::env::temp_dir().join(format!("pandacode-relay-migrate-{}", crate::storage::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("state.sqlite");
    let sid;
    {
        let store = Store::open(&path).unwrap();
        sid = task(&store).id;
        // What an older build left behind: no relay tables at all, already at the current version.
        store
            .db
            .execute_batch("DROP TABLE task_checkpoints; DROP TABLE task_relays; DROP TABLE task_escalations;")
            .unwrap();
    }
    let store = Store::open(&path).unwrap();
    let version: i64 = store
        .db
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap();
    assert_eq!(version, crate::storage::SCHEMA_VERSION, "relay never moves the schema version");
    for table in ["task_checkpoints", "task_relays", "task_escalations"] {
        let present: bool = store
            .db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
                [table],
                |row| row.get(0),
            )
            .unwrap();
        assert!(present, "{table} is created on open");
    }
    // And the feature works on the reopened database.
    save_checkpoint(&store, &sid, "after upgrade", &[], &[], &[], &[]).unwrap();
    assert_eq!(latest_checkpoint(&store, &sid).unwrap().unwrap().goal, "after upgrade");
    std::fs::remove_dir_all(&dir).unwrap();
}
