//! Tests for the app instructions and launch notes (`app_instructions.rs`).
use super::*;
use crate::providers::{COMPACTED_OUTPUT, COMPACT_CONTEXT_TOOL};
use crate::{EDIT_CLAUDE, EDIT_OTHER};

const LEAD_CAP: usize = 6428;
const WORKER_CAP: usize = 1668;

/// Task instructions with nothing optional on; each test changes only the fields it is about.
const BASE: InstructionOptions = InstructionOptions { chat: false, role: Role::Task, explore: None, tools: false, cloud: false };

fn claude() -> Option<explore::RunExplore> {
    explore::run_name(false, true, "claude")
}

#[test]
fn harnesses_without_a_system_prompt_are_reminded_every_eighth_turn() {
    let reminded: Vec<i64> = (1..=20).filter(|turn| reminder_turn(*turn)).collect();
    assert_eq!(reminded, [1, 9, 17]);
    assert!(!reminder_turn(0));
    // A new conversation hears everything; a reminder turn drops the rich guidance.
    assert_eq!(turn_instructions("full".into(), true, 9), Some("full".into()));
    assert_eq!(turn_instructions(GENERATIVE_UI.into(), false, 9), Some(RICH_REMINDER.into()));
    assert_eq!(turn_instructions("full".into(), false, 10), None);
    let text = app_instructions(&InstructionOptions { explore: claude(), ..BASE });
    for part in ["Sidebar titles:", "Run and preview workflow:", "File change tracking:", "Questions you ask through the request_user_input tool", "Your turn ends when you reply", "Use pandacode_explore to locate", "Generative UI:", "Visual progress:"] {
        assert!(text.contains(part), "{part}");
    }
    let chat = app_instructions(&InstructionOptions { chat: true, ..BASE });
    assert!(!chat.contains("Run and preview workflow:") && chat.contains("Sidebar titles:") && chat.contains("Visual progress:"));
}

#[test]
fn cloud_runs_are_not_told_about_progress_snapshots_they_never_list() {
    for chat in [false, true] {
        let local = app_instructions(&InstructionOptions { chat, tools: true, ..BASE });
        let cloud = app_instructions(&InstructionOptions { chat, tools: true, cloud: true, ..BASE });
        // Local bytes are exactly as before: the visual-progress text closes them.
        assert!(local.ends_with(VISUAL_PROGRESS));
        assert_eq!(cloud, local.strip_suffix(VISUAL_PROGRESS).unwrap());
        assert!(!cloud.contains("Visual progress:") && !cloud.contains("pandacode_progress_snapshot"));
    }
    // Managed workers never heard it, cloud or not.
    let worker = app_instructions(&InstructionOptions { role: Role::Worker, ..BASE });
    assert_eq!(app_instructions(&InstructionOptions { role: Role::Worker, cloud: true, ..BASE }), worker);
    assert!(!worker.contains("Visual progress:"));
}

#[test]
fn team_workers_get_only_change_tracking_and_turn_end() {
    let look = look(claude().unwrap());
    let lead = app_instructions(&InstructionOptions { explore: claude(), ..BASE });
    let worker = app_instructions(&InstructionOptions { role: Role::Worker, explore: claude(), ..BASE });
    assert_eq!(lead, [session_titles::GUIDANCE, run_script::INSTRUCTIONS, turn_changes::instruction(), TURN_ENDS, &look, RICH_QUESTIONS, GENERATIVE_UI, VISUAL_PROGRESS].concat());
    assert_eq!(worker, [turn_changes::instruction(), TURN_ENDS, &look].concat());
    // A harness whose turn end closes its subagents waits for them (it was in main's tests).
    for text in [&lead, &worker] {
        assert!(text.contains("wait for every subagent you started"), "a harness whose turn end closes its subagents waits for them");
    }
    assert!(TURN_ENDS.contains("wait for every subagent you started"));
    // The subagent style hint rides the token saver block, only while a style is active.
    assert!(!lead.contains("Response style:") && !worker.contains("Response style:"));
    assert!(worker.contains("File change tracking:") && worker.contains("Your turn ends when you reply") && worker.contains("pandacode_explore"));
    for gone in ["Sidebar titles:", "Run and preview workflow:", "Generative UI:", "request_user_input"] {
        assert!(!worker.contains(gone), "{gone}");
    }
    // A run without the tool never hears of it, and still gets the rest.
    let without = app_instructions(&InstructionOptions { role: Role::Worker, ..BASE });
    assert_eq!(without, [turn_changes::instruction(), TURN_ENDS].concat());
    assert!(!without.contains("explore"));
    let named = app_instructions(&InstructionOptions { role: Role::Worker, explore: Some(explore::RunExplore { name: "server__tool", claude_code: false }), ..BASE });
    assert!(named.contains("Use server__tool to locate") && !named.contains("{explore}"));
    // The stop rule (batch E: 90 of 253 steps came after the gold was shown).
    assert!(look.contains("search again only for a named gap"));
    // Agent-made tools are mentioned only to runs that have them.
    assert!(!lead.contains("pandacode_tool_save") && !worker.contains("pandacode_tool_save"));
    assert_eq!(app_instructions(&InstructionOptions { role: Role::Worker, tools: true, ..BASE }), [turn_changes::instruction(), TURN_ENDS, REUSE].concat());
    // One fixed sentence: the old empty-project wording is never said.
    assert!(!app_instructions(&InstructionOptions { tools: true, ..BASE }).contains(crate::SAVE));
    // Managed team workers are never offered agent-made tools, so never hear REUSE.
    assert!(!custom_tools_offered(false, true) && !custom_tools_offered(true, false));
    assert_eq!(custom_tools_offered(false, false), custom_tools::offered(false));
    let reuse = app_instructions(&InstructionOptions { tools: true, ..BASE });
    assert!(reuse.contains("If the Project tools note lists a tool") && reuse.contains("or once when it will clearly recur, save it with pandacode_tool_save"));
    assert!(!reuse.contains("pandacode_tool_list"));
    eprintln!("app instructions: lead {} B, worker {} B", lead.len(), worker.len());
}


#[test]
fn read_only_workers_never_hear_of_change_tracking() {
    let writer = app_instructions(&InstructionOptions { role: Role::Worker, explore: claude(), ..BASE });
    let reader = app_instructions(&InstructionOptions { role: Role::ReadOnlyWorker, explore: claude(), ..BASE });
    assert!(writer.contains("File change tracking:"));
    // A reader edits nothing: no edit sentence.
    let reading = look_read_only(claude().unwrap());
    assert_eq!(reader, [TURN_ENDS, &reading].concat());
    assert!(reading.ends_with("for a named gap.") && !reading.contains("Edit") && !reading.contains("edit"));
    assert!(!reader.contains("Read the lines"));
    eprintln!("read-only worker: {} B (writer {} B)", reader.len(), writer.len());
    assert_eq!(app_instructions(&InstructionOptions { role: Role::ReadOnlyWorker, ..BASE }), TURN_ENDS);
    assert_eq!(Role::of(false, true), Role::Task, "only team workers are read-only");
    assert_eq!(Role::of(true, false), Role::Worker);
    assert_eq!(Role::of(true, true), Role::ReadOnlyWorker);
}

#[test]
fn host_lists_only_the_tools_each_role_can_use() {
    // Leads and plain tasks want every family, so their catalog (and warm key) is unchanged.
    let all = HostTrim { titles: true, schedules: true, custom: true, explore: true, progress: true, design_writes: true, track: true };
    assert_eq!(Role::Task.wants(), all);
    // Every managed worker drops titles, schedules and agent-made tools; it reports to its lead.
    assert_eq!(Role::Worker.wants(), HostTrim { titles: false, schedules: false, custom: false, ..all });
    // Read-only workers also drop change tracking, progress snapshots and design writes,
    // but keep design list/comments, preview and run_project (no flag can drop them).
    assert_eq!(Role::ReadOnlyWorker.wants(), HostTrim { titles: false, schedules: false, custom: false, explore: true, progress: false, design_writes: false, track: false });
    assert_eq!(DESIGN_WRITES, ["pandacode_design_write", "pandacode_design_resolve"]);
    // Explore follows the setting where the run can list it at all; cloud runs never post progress.
    let config = crate::providers::tests::config("claude");
    let plan = |offered, on| HostPlan::of(&config, false, Role::Task, false, offered, on);
    assert_eq!((plan(true, true).explore, plan(true, true).trim.explore), (Some(false), true));
    assert_eq!((plan(true, false).explore, plan(true, false).trim.explore), (Some(false), false));
    assert_eq!((plan(false, true).explore, plan(false, true).trim.explore), (None, false));
    assert!(!HostPlan::of(&config, false, Role::Task, true, false, false).trim.progress);
    // Agent-made tools are opt-in (the Settings switch); an untrimmed worker never wants them.
    assert!(plan(true, true).custom_tools(true).trim.custom && !plan(true, true).custom_tools(false).trim.custom);
    assert!(!Role::Worker.untrimmed().custom && !Role::ReadOnlyWorker.untrimmed().custom);
}

fn host_of(names: &[&str]) -> Option<ToolHost> {
    let tools = names.iter().map(|name| serde_json::json!({"name": name})).collect();
    let approval_tools = names.iter().map(|name| (*name).to_owned()).collect();
    Some(ToolHost { tools, approval_tools, handler: Arc::new(|name, _| Box::pin(async move { Ok(serde_json::json!(name)) })) })
}

#[test]
fn read_only_workers_keep_the_design_tools_reviewers_read_with() {
    let all = ["pandacode_design_list", "pandacode_design_write", "pandacode_design_comments", "pandacode_design_resolve", "pandacode_preview_file", "pandacode_run_project"];
    let host = without_tools(host_of(&all), &DESIGN_WRITES).unwrap();
    let listed: Vec<_> = host.tools.iter().map(|tool| tool["name"].as_str().unwrap()).collect();
    assert_eq!(listed, ["pandacode_design_list", "pandacode_design_comments", "pandacode_preview_file", "pandacode_run_project"]);
    assert!(!host.approval_tools.contains("pandacode_design_write") && host.approval_tools.contains("pandacode_run_project"));
    let call = |name: &str| tauri::async_runtime::block_on((host.handler)(name.into(), serde_json::Value::Null));
    assert!(call("pandacode_design_write").is_err() && call("pandacode_design_resolve").is_err());
    assert_eq!(call("pandacode_design_comments").unwrap(), "pandacode_design_comments");
    assert!(without_tools(None, &DESIGN_WRITES).is_none());
}

/// The names a role lists over a full catalog (as `run_host` layers it) for a
/// conversation holding `history`, and the calls it refuses.
fn listing(role: Role, history: &History) -> (Vec<String>, Vec<String>) {
    let wants = role.wants();
    let adds = |name: &'static str| move |host: Option<ToolHost>| {
        let mut host = host.unwrap();
        host.tools.push(serde_json::json!({"name": name}));
        host.approval_tools.insert(name.to_owned());
        Some(host)
    };
    let mut layers = Layers::new(history);
    let host = host_of(&["pandacode_design_list", "pandacode_design_comments", "pandacode_preview_file", DESIGN_WRITES[0], DESIGN_WRITES[1]]);
    let host = layers.add(host, wants.schedules, false, adds("pandacode_schedule_wakeup"));
    let host = layers.subset(host, wants.design_writes, true, &DESIGN_WRITES);
    let host = layers.add(host, wants.progress, true, adds("pandacode_progress_snapshot"));
    let host = layers.add(host, wants.custom, false, adds(custom_tools::TOOL_SAVE));
    let host = layers.add(host, wants.track, true, adds(turn_changes::TRACK_TOOL));
    let host = layers.add(host, wants.titles, false, adds(session_titles::TOOL));
    let host = layers.finish(host).unwrap();
    let mut listed: Vec<String> = host.tools.iter().map(|tool| tool["name"].as_str().unwrap().to_owned()).collect();
    listed.sort();
    let call = |name: &str| tauri::async_runtime::block_on((host.handler)(name.into(), serde_json::Value::Null)).is_err();
    let mut refused: Vec<String> = listed.iter().filter(|name| call(name)).cloned().collect();
    refused.sort();
    // A refused tool is never approval-gated: the user is never asked for a call that fails.
    assert!(refused.iter().all(|name| !host.approval_tools.contains(name)));
    (listed, refused)
}

fn held(listed: &[String]) -> History {
    History::holding(&listed.iter().map(String::as_str).collect::<Vec<_>>())
}

fn sorted(names: &[&str]) -> Vec<String> {
    let mut names: Vec<String> = names.iter().map(|name| (*name).to_owned()).collect();
    names.sort();
    names
}

#[test]
fn flipping_a_resumed_workers_read_only_keeps_its_catalog() {
    // Writer first, then a read-only follow-up: the same definitions, write calls refused.
    let (first, _) = listing(Role::Worker, &History::fresh(false));
    let (follow_up, refused) = listing(Role::ReadOnlyWorker, &held(&first));
    assert_eq!(first, follow_up, "a resumed session never loses a tool it already listed");
    assert_eq!(refused, sorted(&READ_ONLY_WRITES));
    // Read-only first, then a writer follow-up: the families are added and work.
    let (first, _) = listing(Role::ReadOnlyWorker, &History::fresh(false));
    let (follow_up, refused) = listing(Role::Worker, &held(&first));
    assert!(first.iter().all(|name| follow_up.contains(name)) && follow_up.len() == first.len() + READ_ONLY_WRITES.len());
    assert!(refused.is_empty());
    // ...and a read-only turn after that keeps them, refused.
    let (again, refused) = listing(Role::ReadOnlyWorker, &held(&follow_up));
    assert_eq!(again, follow_up);
    assert_eq!(refused, sorted(&READ_ONLY_WRITES));
    // A resumed read-only worker whose recorded listing never held the writes stays lean.
    let (lean, refused) = listing(Role::ReadOnlyWorker, &held(&first));
    assert_eq!(lean, first);
    assert!(refused.is_empty());
    // Codex lists the writer families from the start, so a writer follow-up can use them.
    let (codex_first, refused) = listing(Role::ReadOnlyWorker, &History::fresh(true));
    assert_eq!(codex_first, follow_up);
    assert_eq!(refused, sorted(&READ_ONLY_WRITES));
}

#[test]
fn a_resumed_worker_that_listed_task_tools_keeps_them_listed_and_refused() {
    // A worker conversation started before workers dropped titles, schedules and agent-made
    // tools (or any resumed worker after a restart, whose history is unknown).
    let (lead, refused) = listing(Role::Task, &History::fresh(false));
    assert!(refused.is_empty());
    for history in [held(&lead), History::unknown(false)] {
        let (worker, refused) = listing(Role::Worker, &history);
        assert_eq!(worker, lead, "{history:?}");
        assert_eq!(refused, sorted(&[session_titles::TOOL, "pandacode_schedule_wakeup", custom_tools::TOOL_SAVE]));
        let (reader, refused) = listing(Role::ReadOnlyWorker, &history);
        assert_eq!(reader, lead, "{history:?}");
        assert_eq!(refused.len(), 3 + READ_ONLY_WRITES.len());
    }
    // A worker's new conversation lists none of them.
    let (fresh, _) = listing(Role::Worker, &History::fresh(false));
    assert!(!fresh.contains(&session_titles::TOOL.to_owned()) && !fresh.contains(&custom_tools::TOOL_SAVE.to_owned()));
}

#[test]
fn worker_instructions_are_resent_until_a_launch_carries_them() {
    let session = "role-flip-test-session";
    // Unknown (a new conversation, or after a restart): say it once.
    assert!(instructions_due(session, Role::Worker));
    // The launch failed to start: nothing was recorded, so the retry says them again.
    assert!(instructions_due(session, Role::Worker), "a launch that never started records nothing");
    instructed_as(session, Role::Worker);
    assert!(!instructions_due(session, Role::Worker), "an unchanged role hears nothing new");
    assert!(instructions_due(session, Role::ReadOnlyWorker));
    // A role-flip turn that failed to spawn: the retry still re-sends the new instructions.
    assert!(instructions_due(session, Role::ReadOnlyWorker));
    instructed_as(session, Role::ReadOnlyWorker);
    assert!(!instructions_due(session, Role::ReadOnlyWorker));
    assert!(instructions_due(session, Role::Worker));
    // A resumed turn hears them only on a flip or a reminder turn.
    let full = app_instructions(&InstructionOptions { role: Role::Worker, ..BASE });
    assert_eq!(turn_instructions(full.clone(), false, 4), None);
    assert_eq!(turn_instructions(full.clone(), true, 4).as_deref(), Some(full.as_str()));
    assert_eq!(turn_instructions(full.clone(), false, 9).as_deref(), Some(full.as_str()));
}

#[test]
fn deleting_a_task_forgets_its_instructed_role() {
    let session = format!("deleted-{}", uuid::Uuid::new_v4());
    instructed_as(&session, Role::Worker);
    assert!(!instructions_due(&session, Role::Worker));
    forget(std::slice::from_ref(&session));
    assert!(crate::session_state::get(&session, |task| task.is_none()), "the entry is pruned");
    assert!(instructions_due(&session, Role::Worker));
}

#[test]
fn the_cached_instructions_are_identical_in_every_mode() {
    use turn_changes::{edits_wait_for_approval as waits, turn_note};
    // Switching Standard, Accept edits, auto review, Plan or Full access (or an allow rule,
    // or a named connection) must not change the cached system prompt: only the turn's
    // message differs, by one line while native edits wait for approval.
    for role in [Role::Task, Role::Worker, Role::ReadOnlyWorker] {
        let system = launch_instructions(&crate::providers::tests::config("claude"), role, None, false);
        assert_eq!(system.contains("File change tracking"), role.writes(), "{role:?}");
        if role.writes() {
            assert!(system.contains("before any file-edit batch (native editing tools, shell commands, or scripts)"), "{role:?}");
        }
        assert!(!system.contains("tracked automatically"), "{role:?}");
    }
    for provider in ["claude", "glm", "mimo", "alibaba", "codex"] {
        for mode in ["ask", "auto", "review", "plan", "full"] {
            let note = turn_note(waits(provider, mode));
            assert_eq!(note.is_some(), provider != "codex" && mode == "ask", "{provider} {mode}");
        }
    }
    // Built as the launch builds them: one sentence in every mode, new or resumed.
    let session = format!("modes-{}", uuid::Uuid::new_v4());
    let launch = |mode: &str, resume: Option<&str>| {
        let config = RunConfig { session_id: session.clone(), mode: mode.into(), resume_id: resume.map(str::to_owned), ..crate::providers::tests::config("claude") };
        launch_instructions(&config, Role::Task, claude(), true)
    };
    let first = launch("ask", None);
    assert!(first.contains(REUSE));
    for mode in ["ask", "auto", "review", "plan", "full"] {
        assert_eq!(launch(mode, Some("resume")), first, "{mode}");
    }
    assert_eq!(launch("plan", None), first, "a new Plan conversation");
    // A run not offered the tools hears no sentence, in any mode.
    let plain = crate::providers::tests::config("claude");
    let none = launch_instructions(&plain, Role::Worker, None, false);
    assert_eq!(none, app_instructions(&InstructionOptions { role: Role::Worker, ..BASE }));
    // Plan's caveat rides the turn's message.
    assert!(plan_tools_note("plan").is_some_and(|note| note.len() < 100));
    for mode in ["ask", "auto", "review", "full"] {
        assert_eq!(plan_tools_note(mode), None, "{mode}");
    }
}

#[test]
fn a_first_saved_tool_or_last_removed_one_keeps_the_cached_instructions() {
    // The catalog's state is not an input at all: every harness, new or resumed, hears the same
    // bytes, and the Project tools note on the message says what exists now.
    for provider in ["claude", "codex"] {
        let launch = |resume: Option<&str>| {
            let config = RunConfig { resume_id: resume.map(str::to_owned), ..crate::providers::tests::config(provider) };
            launch_instructions(&config, Role::Task, None, true)
        };
        assert_eq!(launch(None), launch(Some("resume")), "{provider}");
        assert!(launch(None).contains(REUSE) && !launch(None).contains(crate::SAVE));
    }
}

use crate::{save_compaction as compaction_row, save_tool_row};

fn resumed_codex(store: &Mutex<Store>) -> RunConfig {
    let db = store.lock().unwrap();
    let project = db.add_project(&std::env::temp_dir()).unwrap();
    let session = db.create_session(&project.id, "codex", "gpt-5", "ask").unwrap().id;
    RunConfig { session_id: session, resume_id: Some("thread".into()), ..crate::providers::tests::config("codex") }
}

/// One launch through the real path; returns what its message carried and what it would record.
fn launch_turn(store: &Mutex<Store>, base: &RunConfig, maintenance: bool) -> (String, Instructed) {
    let mut config = RunConfig { prompt: String::new(), ..base.clone() };
    let text = LaunchText { role: Role::Task, explore: None, offered: false, maintenance };
    let instructed = instruct_launch(store, &mut config, text);
    (config.prompt, instructed)
}

#[test]
fn a_stored_compaction_row_resends_the_full_instructions_through_the_launch() {
    let store = Mutex::new(Store::open(std::path::Path::new(":memory:")).unwrap());
    let config = resumed_codex(&store);
    let session = config.session_id.clone();
    let full = app_instructions(&InstructionOptions { chat: crate::chats::is_chat_folder(&config.cwd), ..BASE });
    assert_eq!(launch_turn(&store, &config, false).0, "", "an ordinary resumed turn");

    compaction_row(&store.lock().unwrap(), &session, "run:compaction:1");
    // The row as the app really stores it: flat, under its own name.
    let content: String = store.lock().unwrap().db.query_row("SELECT content FROM messages WHERE session_id=?1 AND role='tool'", [&session], |row| row.get(0)).unwrap();
    let row: serde_json::Value = serde_json::from_str(&content).unwrap();
    assert_eq!((row["type"].as_str(), row["name"].as_str(), row["output"].as_str()), (Some("tool_activity"), Some(COMPACT_CONTEXT_TOOL), Some(COMPACTED_OUTPUT)));
    assert!(row.get("tool").is_none(), "{row}");

    // A maintenance turn's message stays the bare command and leaves the compaction due.
    assert_eq!(launch_turn(&store, &config, true), (String::new(), Instructed::default()));
    let (sent, instructed) = launch_turn(&store, &config, false);
    assert_eq!(sent, full, "the full text, not the short reminder");
    // A failed or stopped run records nothing, so the retry resends in full.
    let (retry, again) = launch_turn(&store, &config, false);
    assert_eq!((retry.as_str(), &again), (full.as_str(), &instructed), "the retry");
    // A clean end records it: said once per compaction.
    compaction_answered(&session, again.compaction.unwrap());
    assert_eq!(launch_turn(&store, &config, false).0, "");
    forget(std::slice::from_ref(&session));
}

#[test]
fn system_prompt_harnesses_keep_their_instructions_on_maintenance_turns() {
    let store = Mutex::new(Store::open(std::path::Path::new(":memory:")).unwrap());
    let text = |maintenance| LaunchText { role: Role::Task, explore: None, offered: false, maintenance };
    let launch = |maintenance| {
        let mut config = RunConfig { prompt: "/context".into(), resume_id: Some("conv".into()), ..crate::providers::tests::config("claude") };
        assert_eq!(instruct_launch(&store, &mut config, text(maintenance)), Instructed::default());
        config
    };
    let (ordinary, maintenance) = (launch(false), launch(true));
    assert!(!maintenance.instructions.is_empty());
    assert_eq!(maintenance.instructions, ordinary.instructions, "the same warm key");
    assert_eq!(maintenance.prompt, "/context", "the message stays the bare command");
}

#[test]
fn a_reported_compaction_resends_the_full_instructions_once() {
    let store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let project = store.add_project(&std::env::temp_dir()).unwrap();
    let session = store.create_session(&project.id, "codex", "gpt-5", "ask").unwrap().id;
    let full = app_instructions(&BASE);
    // What the launch does on a resumed turn that is neither flipped nor a reminder.
    let turn = |store: &Store| {
        let compaction = new_compaction(store, &session);
        (turn_instructions(full.clone(), compaction.is_some(), 4), compaction)
    };
    assert_eq!(turn(&store), (None, None), "no compaction, no resend");
    // Text that only mentions compaction is not a report of one.
    store.message(&session, "assistant", COMPACTED_OUTPUT).unwrap();
    assert_eq!(turn(&store).1, None);
    compaction_row(&store, &session, "compaction:1");
    let (sent, compaction) = turn(&store);
    assert_eq!(sent.as_deref(), Some(full.as_str()), "the full text, not the short reminder");
    assert!(sent.is_some_and(|text| text.contains(GENERATIVE_UI) && !text.contains(RICH_REMINDER)));
    // A launch that never started records nothing, so the retry resends.
    assert!(turn(&store).0.is_some());
    compaction_answered(&session, compaction.unwrap());
    assert_eq!(turn(&store), (None, None), "said once per compaction");
    compaction_row(&store, &session, "compaction:2");
    assert!(turn(&store).0.is_some(), "a later compaction resends again");
    forget(std::slice::from_ref(&session));
    assert!(crate::session_state::get(&session, |task| task.is_none()));
}

#[test]
fn compaction_scans_read_only_new_rows_until_a_restart() {
    let mark = |session: &str| crate::session_state::get(session, |task| task.and_then(|task| task.compaction)).unwrap().scanned;
    let store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let project = store.add_project(&std::env::temp_dir()).unwrap();
    let session = store.create_session(&project.id, "codex", "gpt-5", "ask").unwrap().id;
    save_tool_row(&store, &session, "read:1", "Read", "text");
    assert_eq!(new_compaction(&store, &session), None, "a thread that never compacted");
    let scanned = mark(&session);
    assert!(scanned > 0, "the scan advances without finding a compaction");
    // A row at or below the mark is not read again, which the rewrite below would reveal.
    save_tool_row(&store, &session, "read:1", COMPACT_CONTEXT_TOOL, COMPACTED_OUTPUT);
    assert_eq!(new_compaction(&store, &session), None, "only rows past the mark are read");
    assert_eq!(mark(&session), scanned, "no new rows, no movement");
    // Malformed content in a new row is skipped and still counted as read.
    store.tool_message(&session, "broken:1", "not json").unwrap();
    assert_eq!(new_compaction(&store, &session), None);
    assert!(mark(&session) > scanned);
    // A found compaction stays due across turns until a launch answers it.
    compaction_row(&store, &session, "compaction:1");
    let found = new_compaction(&store, &session);
    assert!(found.is_some());
    assert_eq!(new_compaction(&store, &session), found, "a failed launch's retry still sees it");
    compaction_answered(&session, found.unwrap());
    assert_eq!(new_compaction(&store, &session), None);
    // A deleted task's mark goes with it: everything would be read once more.
    forget(std::slice::from_ref(&session));
    assert_eq!(new_compaction(&store, &session), found);
    forget(std::slice::from_ref(&session));
}

#[test]
fn periodic_reminders_send_rich_guidance_once_per_conversation() {
    let full = app_instructions(&BASE);
    let periodic = periodic_instructions(&full);
    assert!(full.contains(GENERATIVE_UI) && full.contains(RICH_QUESTIONS));
    assert!(!periodic.contains(GENERATIVE_UI) && !periodic.contains(RICH_QUESTIONS));
    assert!(periodic.ends_with(RICH_REMINDER) && !RICH_REMINDER.trim().contains('\n'));
    // It names every block itself, never an earlier message a compaction may have dropped.
    for block in ["```ui", "```chart", "```svg", "```html", "![alt]("] {
        assert!(RICH_REMINDER.contains(block), "{block}");
    }
    assert!(!RICH_REMINDER.contains("start of this conversation"));
    for kept in ["Sidebar titles:", "Run and preview workflow:", "File change tracking:", "Your turn ends when you reply", "Visual progress:"] {
        assert!(periodic.contains(kept), "{kept}");
    }
    // Workers never had the rich guidance, so their reminder is unchanged and gains no line.
    let worker = app_instructions(&InstructionOptions { role: Role::Worker, ..BASE });
    assert_eq!(periodic_instructions(&worker), worker);
    assert_eq!(full.len() - periodic.len(), RICH_QUESTIONS.len() + GENERATIVE_UI.len() - RICH_REMINDER.len());
    eprintln!("periodic reminder: full {} B, periodic {} B", full.len(), periodic.len());
}

#[test]
fn edit_text_follows_the_harness_and_role() {
    eprintln!("edit text: EDIT_CLAUDE {} B, EDIT_OTHER {} B", EDIT_CLAUDE.len(), EDIT_OTHER.len());
    let gap = " for a named gap. ";
    for provider in ["claude", "glm", "mimo", "alibaba"] {
        let config = crate::providers::tests::config(provider);
        let text = launch_instructions(&config, Role::Worker, explore::run_name(false, true, provider), false);
        assert!(text.contains(&[gap, EDIT_CLAUDE].concat()), "{provider}");
        assert!(!text.contains(EDIT_OTHER), "{provider}");
        let reader = launch_instructions(&config, Role::ReadOnlyWorker, explore::run_name(false, true, provider), false);
        assert!(reader.contains("search again only for a named gap.") && !reader.contains("edit calls"), "{provider}");
    }
    for provider in ["codex", "kimi", "opencode", "pi", "omp", "grok"] {
        let text = app_instructions(&InstructionOptions { role: Role::Worker, explore: explore::run_name(false, true, provider), ..BASE });
        assert!(text.contains(&[gap, EDIT_OTHER].concat()), "{provider}");
        assert!(!text.contains(EDIT_CLAUDE), "{provider}");
    }
    // The edit text rides the explore clause: a run without the tool gets none.
    assert!(!app_instructions(&InstructionOptions { role: Role::Worker, ..BASE }).contains("edit calls"));
}

#[test]
fn instruction_sizes_stay_within_budget() {
    let lead = app_instructions(&InstructionOptions { explore: claude(), ..BASE }).len();
    let worker = app_instructions(&InstructionOptions { role: Role::Worker, explore: claude(), ..BASE }).len();
    eprintln!("budget: lead {lead} B, worker {worker} B");
    assert!(lead <= LEAD_CAP, "lead instructions are {lead} B, cap {LEAD_CAP} B");
    assert!(worker <= WORKER_CAP, "worker instructions are {worker} B, cap {WORKER_CAP} B");
}
