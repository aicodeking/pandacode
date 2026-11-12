use super::*;

fn ready(prompt: &str) -> Protocol {
    let mut config = tests::config("codex");
    config.prompt = prompt.into();
    Protocol::new(config)
}

fn thread_ready(protocol: &mut Protocol) -> Result<Step, String> {
    protocol.receive(json!({"id":2,"result":{"thread":{"id":"thread"},"model":"test"}}))
}

#[test]
fn compact_dispatches_native_operation_and_waits_for_turn_completion() {
    let mut protocol = ready("/compact");
    let step = thread_ready(&mut protocol).unwrap();
    assert_eq!(
        step.write,
        [json!({"id":3,"method":"thread/compact/start","params":{"threadId":"thread"}})]
    );
    assert!(!step.done);
    assert_eq!(protocol.phase, 1);
    let started = protocol.receive(json!({"method":"turn/started","params":{"threadId":"thread","turn":{"id":"compaction"}}})).unwrap();
    assert!(!started.done);
    assert!(!protocol.receive(json!({"id":3,"result":{}})).unwrap().done);
    assert_eq!(protocol.cancel()["params"]["turnId"], "compaction");
    assert!(protocol.receive(json!({"method":"turn/completed","params":{"threadId":"thread","turn":{"id":"compaction","status":"completed"}}})).unwrap().done);
}

#[test]
fn compact_rejects_arguments_instead_of_sending_an_ordinary_prompt() {
    assert!(thread_ready(&mut ready("/compact unexpected")).is_err());
}

#[test]
fn review_dispatches_inline_with_explicit_target() {
    for (prompt, target) in [
        ("/review", json!({"type":"uncommittedChanges"})),
        (
            "/review  Check race conditions\nand cancellation",
            json!({"type":"custom","instructions":"Check race conditions\nand cancellation"}),
        ),
    ] {
        let mut protocol = ready(prompt);
        let step = thread_ready(&mut protocol).unwrap();
        assert_eq!(
            step.write,
            [
                json!({"id":3,"method":"review/start","params":{"threadId":"thread","target":target,"delivery":"inline"}})
            ]
        );
        assert!(!step.done);
        let step = protocol
            .receive(json!({"id":3,"result":{"turn":{"id":"review"},"reviewThreadId":"thread"}}))
            .unwrap();
        assert!(!step.done);
        assert_eq!(protocol.turn_id, "review");
    }
}

#[test]
fn command_prefixes_do_not_intercept_ordinary_prompt_text() {
    for prompt in [
        "/reviewer investigate",
        "/compactly summarize",
        "Explain /compact",
    ] {
        let mut protocol = ready(prompt);
        let step = thread_ready(&mut protocol).unwrap();
        assert_eq!(step.write[0]["method"], "turn/start");
        assert_eq!(step.write[0]["params"]["input"][0]["text"], prompt);
    }
}

#[test]
fn skills_changed_invalidates_commands_without_forwarding_opaque_payloads() {
    let mut protocol = ready("hello");
    let step = protocol
        .receive(json!({"method":"skills/changed","params":{"opaque":"SECRET"}}))
        .unwrap();
    assert_eq!(step.events.len(), 1);
    assert_eq!(step.events[0].kind, "commands_changed");
    assert!(step.events[0].data.is_none());
}

#[test]
fn explicit_skill_keeps_typed_reference_and_arguments_without_reinterpreting_its_name() {
    let mut protocol = ready("$review Check cancellation");
    protocol.config.skill = Some((
        "review".into(),
        PathBuf::from("/tmp/skills/review/SKILL.md"),
    ));
    let step = thread_ready(&mut protocol).unwrap();
    assert_eq!(step.write[0]["method"], "turn/start");
    assert_eq!(
        step.write[0]["params"]["input"],
        json!([
            {"type":"text","text":"$review Check cancellation","text_elements":[]},
            {"type":"skill","name":"review","path":"/tmp/skills/review/SKILL.md"}
        ])
    );
    assert!(protocol.config.skill.is_none());
    assert!(protocol.config.prompt.is_empty());
}

#[test]
fn native_operations_reject_attachments_instead_of_silently_discarding_them() {
    for prompt in ["/compact", "/review Check code"] {
        let mut protocol = ready(prompt);
        protocol
            .image_blocks
            .push(json!({"type":"image","url":"data:image/png;base64,fixture"}));
        assert!(thread_ready(&mut protocol).is_err());
    }
}

#[test]
fn kimi_early_commands_wait_for_matching_new_session_and_still_sync_before_prompt() {
    for matched in [true, false] {
        let mut protocol = Protocol::new(tests::config("kimi"));
        let early = protocol.receive(json!({"method":"session/update","params":{"sessionId":"new-session","update":{"sessionUpdate":"available_commands_update","availableCommands":[{"name":"fixture-command","description":"Command from provider","input":{"hint":"<message>"}}]}}})).unwrap();
        assert!(early.events.is_empty());
        let step = protocol.receive(json!({"id":2,"result":{"sessionId":if matched {"new-session"} else {"another-session"},"modes":{"availableModes":[{"id":"default"}]}}})).unwrap();
        assert_eq!(
            step.events
                .iter()
                .filter(|event| event.kind == "commands_changed")
                .count(),
            usize::from(matched)
        );
        assert_eq!(protocol.phase, 0, "metadata must not start a prompt");
    }
}

#[test]
fn child_and_foreign_command_updates_cannot_replace_parent_catalogs() {
    let mut claude = Protocol::new(tests::config("claude"));
    let step = claude.receive(json!({"type":"system","subtype":"commands_changed","parent_tool_use_id":"child","commands":[{"name":"foreign"}]})).unwrap();
    assert!(step.events.is_empty());
    let mut kimi = Protocol::new(tests::config("kimi"));
    kimi.remote_id = "parent".into();
    let step = kimi.receive(json!({"method":"session/update","params":{"sessionId":"child","update":{"sessionUpdate":"available_commands_update","availableCommands":[{"name":"foreign"}]}}})).unwrap();
    assert!(step.events.is_empty());
}

#[test]
fn oversized_early_metadata_is_not_retained_until_session_confirmation() {
    let mut protocol = Protocol::new(tests::config("kimi"));
    protocol.receive(json!({"method":"session/update","params":{"sessionId":"new-session","update":{"sessionUpdate":"available_commands_update","availableCommands":[{"name":"fixture","description":"x".repeat(130*1024)}]}}})).unwrap();
    assert!(protocol.early_kimi_commands.is_none());
}

#[test]
fn claude_catalog_frames_publish_only_invalidation_to_the_renderer() {
    for frame in [
        json!({"type":"control_response","response":{"subtype":"success","request_id":"pandacode-init","response":{"commands":[{"name":"fixture","description":"Description","opaque":"SECRET"}]}}}),
        json!({"type":"system","subtype":"init","session_id":"session","slash_commands":["fixture"],"terminal_slash_commands":[]}),
        json!({"type":"system","subtype":"commands_changed","commands":[{"name":"fixture","description":"Updated","opaque":"SECRET"}]}),
    ] {
        let mut protocol = Protocol::new(tests::config("claude"));
        let step = protocol.receive(frame).unwrap();
        let event = step
            .events
            .iter()
            .find(|event| event.kind == "commands_changed")
            .unwrap();
        assert!(event.data.is_none());
        assert!(event.text.is_empty());
    }
}

fn emitted_text(step: &Step) -> String {
    step.events
        .iter()
        .filter(|event| event.kind == "text")
        .map(|event| event.text.as_str())
        .collect()
}

#[test]
fn claude_local_command_output_is_visible_before_result_and_reconciles_duplicates() {
    for final_text in ["", "Command output.", "Command output.\nAdditional detail."] {
        let mut protocol = Protocol::new(tests::config("claude"));
        let frame = json!({"type":"system","subtype":"local_command_output","uuid":"local-output","session_id":"session","content":"Command output."});
        let first = protocol.receive(frame.clone()).unwrap();
        assert_eq!(emitted_text(&first), "Command output.");
        assert_eq!(first.events[0].kind, "message_start");
        assert!(!first.done);
        assert!(protocol.receive(frame).unwrap().events.is_empty());
        let result = protocol
            .receive(json!({"type":"result","subtype":"success","result":final_text}))
            .unwrap();
        assert_eq!(
            emitted_text(&result),
            final_text.strip_prefix("Command output.").unwrap_or("")
        );
        assert!(result.done);
    }
}

#[test]
fn distinct_local_outputs_have_message_boundaries_and_child_output_is_ignored() {
    let mut protocol = Protocol::new(tests::config("claude"));
    for (uuid, text) in [("first", "First output."), ("second", "Second output.")] {
        let step=protocol.receive(json!({"type":"system","subtype":"local_command_output","uuid":uuid,"content":text})).unwrap();
        assert_eq!(emitted_text(&step), text);
        assert_eq!(step.events[0].kind, "message_start");
    }
    let child=protocol.receive(json!({"type":"system","subtype":"local_command_output","uuid":"child","parent_tool_use_id":"agent","content":"Private child output"})).unwrap();
    assert!(child.events.is_empty());
}

#[test]
fn compaction_completion_has_persistable_activity_without_inventing_assistant_text() {
    let mut claude = Protocol::new(tests::config("claude"));
    let frame = json!({"type":"system","subtype":"compact_boundary","uuid":"compact","compact_metadata":{"trigger":"manual","pre_tokens":100}});
    let step = claude.receive(frame.clone()).unwrap();
    assert!(step.events.iter().any(|event| event
        .tool
        .as_ref()
        .is_some_and(|tool| tool.status == "completed" && tool.output.contains("compacted"))));
    assert!(emitted_text(&step).is_empty());
    assert!(claude.receive(frame).unwrap().events.is_empty());
    let mut codex = ready("/compact");
    thread_ready(&mut codex).unwrap();
    let step=codex.receive(json!({"method":"item/completed","params":{"threadId":"thread","item":{"type":"contextCompaction","id":"compact"}}})).unwrap();
    assert!(step.events.iter().any(|event| event
        .tool
        .as_ref()
        .is_some_and(|tool| tool.status == "completed" && tool.output.contains("compacted"))));
}

#[test]
fn a_claude_compact_boundary_stored_like_a_run_is_found_as_a_compaction() {
    let store = crate::storage::Store::open(Path::new(":memory:")).unwrap();
    let project = store.add_project(&std::env::temp_dir()).unwrap();
    let session = store.create_session(&project.id, "claude", "sonnet", "ask").unwrap().id;
    assert_eq!(crate::app_instructions::new_compaction(&store, &session), None);
    let mut claude = Protocol::new(RunConfig { session_id: session.clone(), ..tests::config("claude") });
    let step = claude.receive(json!({"type":"system","subtype":"compact_boundary","session_id":"remote","uuid":"boundary","compact_metadata":{"trigger":"auto","pre_tokens":167000}})).unwrap();
    assert!(!step.events.is_empty());
    let assistant = std::sync::Mutex::new(String::new());
    for mut event in step.events {
        crate::save_agent_activity(&store, &assistant, &mut event, None).unwrap();
    }
    let row: i64 = store.db.query_row("SELECT id FROM messages WHERE session_id=?1 AND tool_id='compaction:boundary'", [&session], |row| row.get(0)).unwrap();
    assert_eq!(crate::app_instructions::new_compaction(&store, &session), Some(row));
    crate::app_instructions::forget(std::slice::from_ref(&session));
}

/// Explicit opt-in only: reads installed command metadata, never submits a prompt.
#[tokio::test]
#[ignore = "Set PANDACODE_SMOKE_COMMANDS=1 to inspect installed CLI command metadata"]
async fn installed_command_catalog_smoke() {
    assert_eq!(
        std::env::var("PANDACODE_SMOKE_COMMANDS").as_deref(),
        Ok("1"),
        "Explicit metadata smoke opt-in is required"
    );
    let cwd = std::env::var_os("PANDACODE_SMOKE_CWD")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap()
                .to_path_buf()
        });
    assert!(cwd.is_dir());
    let mut installed = 0;
    let mut failures = Vec::new();
    for provider in ["codex", "claude", "kimi"] {
        if executable(provider).is_none() {
            continue;
        }
        installed += 1;
        let result = tokio::time::timeout(
            Duration::from_secs(30),
            crate::slash_commands::catalog(provider, &cwd, true),
        )
        .await;
        let catalog = match result {
            Ok(Ok(catalog)) => catalog,
            _ => {
                failures.push(format!("{provider}: metadata request failed or timed out"));
                continue;
            }
        };
        let native: Vec<_> = catalog
            .commands
            .iter()
            .filter(|command| {
                matches!(
                    command.invocation,
                    crate::slash_commands::Invocation::Native
                        | crate::slash_commands::Invocation::Skill { .. }
                )
            })
            .collect();
        let names: Vec<_> = native
            .iter()
            .take(3)
            .map(|command| command.name.as_str())
            .collect();
        println!(
            "{provider}: commands={}, native={}, examples={names:?}, warnings={:?}",
            catalog.commands.len(),
            native.len(),
            catalog.warnings
        );
        if native.is_empty()
            || (provider == "codex"
                && catalog.warnings.iter().any(|warning| {
                    warning.starts_with("Installed Codex skills could not be loaded")
                        || warning.starts_with("Codex returned an invalid skill inventory")
                }))
        {
            failures.push(format!(
                "{provider}: installed command metadata was unavailable"
            ));
        }
    }
    assert!(installed > 0, "No installed harness was found");
    assert!(failures.is_empty(), "{}", failures.join("; "));
}

#[test]
fn claude_rechecks_commands_against_fresh_initialization_before_submission() {
    for (commands, expected) in [
        (
            json!([{"name":"project-guide","description":"Project instructions"}]),
            true,
        ),
        (json!([]), false),
        (json!([{"name":"different-command"}]), false),
    ] {
        let mut config = tests::config("claude");
        config.prompt = "/project-guide keep my arguments".into();
        let mut protocol = Protocol::new(config);
        let result = protocol.receive(json!({"type":"control_response","response":{"request_id":"pandacode-init","subtype":"success","response":{"commands":commands}}}));
        assert_eq!(result.is_ok(), expected);
        if let Ok(step) = result {
            assert_eq!(
                step.write[0]["message"]["content"],
                "/project-guide keep my arguments"
            );
        }
    }
    let mut config = tests::config("claude");
    config.prompt = "/terminal-only".into();
    let mut protocol = Protocol::new(config);
    assert!(protocol.receive(json!({"type":"control_response","response":{"request_id":"pandacode-init","subtype":"success","response":{"commands":[{"name":"terminal-only"}],"terminal_slash_commands":["terminal-only"]}}})).is_err());
}

/// One launch of `prompt` through the real instruction path (`instruct_launch`); `command` is
/// what `prepare` derives from the slash-command resolution. Returns the message the harness gets.
fn launched(provider: &str, prompt: &str, resume: Option<&str>, command: bool) -> (RunConfig, crate::app_instructions::Instructed) {
    use crate::app_instructions::{instruct_launch, LaunchText, Role};
    let store = std::sync::Mutex::new(crate::storage::Store::open(std::path::Path::new(":memory:")).unwrap());
    let session = format!("slash-notes-{}", uuid::Uuid::new_v4());
    let mut config = RunConfig { session_id: session, prompt: prompt.into(), resume_id: resume.map(str::to_owned), ..tests::config(provider) };
    let text = LaunchText { role: Role::Task, explore: None, offered: true, maintenance: command };
    let instructed = instruct_launch(&store, &mut config, text);
    (config, instructed)
}

/// Reproduced with Claude Code 2.1.322 and a project command `.claude/commands/foo.md` whose
/// body is `ARGS=[$ARGUMENTS]`: everything after the name became the arguments, so the
/// Standard-mode tracking note produced `ARGS=[(This turn your native edit tools are tracked
/// automatically…)]` and `/foo hello` got the note appended. The init frame below is the shape
/// Claude advertises such a command in. A native command's message now reaches it bare.
#[test]
fn hidden_notes_never_become_a_custom_commands_arguments() {
    let init = json!({"type":"control_response","response":{"request_id":"pandacode-init","subtype":"success","response":{"commands":[{"name":"foo","description":"Echo arguments (project)","argumentHint":""}]}}});
    for (typed, arguments) in [("/foo", ""), ("/foo hello", "hello")] {
        // GLM launches with no settings file, so Standard mode always waits for its edits.
        let (ordinary, _) = launched("glm", typed, Some("conv-1"), false);
        assert!(ordinary.prompt.starts_with(typed) && ordinary.prompt.len() > typed.len(), "the regression: {:?}", ordinary.prompt);
        let (config, instructed) = launched("glm", typed, Some("conv-1"), true);
        assert_eq!(config.prompt, typed);
        assert_eq!(instructed, crate::app_instructions::Instructed::default(), "nothing is recorded as sent");
        assert!(!config.instructions.is_empty(), "the cached system prompt (and warm key) stay");
        assert_eq!(crate::slash_commands::split_command(&config.prompt).map(|(_, args)| args), Some(arguments));
        // What Claude receives for it.
        let mut protocol = Protocol::new(RunConfig { provider: "claude".into(), ..config });
        let step = protocol.receive(init.clone()).unwrap();
        assert_eq!(step.write[0]["message"]["content"], typed);
    }
}

/// Codex parses the text after `/review` as custom review instructions; a new conversation's app
/// instructions (in the message for Codex) must not turn a bare `/review` into a custom review.
/// They are owed to the next ordinary message instead.
#[test]
fn a_bare_review_stays_an_uncommitted_changes_review_and_owes_its_instructions() {
    let (config, instructed) = launched("codex", "/review", None, true);
    assert_eq!(config.prompt, "/review");
    assert_eq!(instructed, crate::app_instructions::Instructed::default());
    let mut protocol = Protocol::new(config.clone());
    let step = thread_ready(&mut protocol).unwrap();
    assert_eq!(step.write[0]["params"]["target"], json!({"type":"uncommittedChanges"}));
    // The next ordinary message, now on a resumed thread, carries the full instructions once.
    let store = std::sync::Mutex::new(crate::storage::Store::open(std::path::Path::new(":memory:")).unwrap());
    let next = |prompt: &str| {
        let mut next = RunConfig { prompt: prompt.into(), resume_id: Some("thread".into()), ..config.clone() };
        let text = crate::app_instructions::LaunchText { role: crate::app_instructions::Role::Task, explore: None, offered: true, maintenance: false };
        let instructed = crate::app_instructions::instruct_launch(&store, &mut next, text);
        (next.prompt, instructed)
    };
    let (sent, instructed) = next("fix it");
    assert!(sent.starts_with("fix it") && sent.contains("File change tracking:"), "{sent}");
    let (retry, _) = next("fix it");
    assert_eq!(retry, sent, "a failed turn still owes them");
    crate::app_instructions::instructed_as(&config.session_id, instructed.role.unwrap());
    assert_eq!(next("and again").0, "and again", "paid once");
    crate::app_instructions::forget(std::slice::from_ref(&config.session_id));
}
