//! Claude Code launches: the native tools a worker is denied, the conversation's held deny set,
//! refusal hooks and refused calls that never prompt (moved from `providers.rs`).
use super::tests::config;
use super::*;

#[test]
fn workers_launch_without_the_tools_their_brief_forbids() {
    let launch = |worker: Option<WorkerTrim>| {
        let mut command = tokio::process::Command::new("claude");
        configure_command(&mut command, &RunConfig { worker, ..config("claude") });
        let args: Vec<String> = command.as_std().get_args().map(|arg| arg.to_string_lossy().into()).collect();
        args.into_iter().filter(|arg| arg.starts_with("--disallowedTools")).collect::<Vec<_>>()
    };
    let worker = "--disallowedTools=ScheduleWakeup,Monitor,CronCreate,Agent,Task,Workflow,ListAgents,SendMessage,RemoteTrigger,CronDelete,CronList,EnterWorktree,ExitWorktree";
    // A lead or a plain task is not trimmed.
    assert_eq!(launch(None), ["--disallowedTools=ScheduleWakeup,Monitor,CronCreate"]);
    // Writers and read-only workers differ by the edit tools; Skill goes unless allowed.
    assert_eq!(launch(Some(WorkerTrim { read_only: false, skills: false, trim: true })), [format!("{worker},Skill")]);
    assert_eq!(launch(Some(WorkerTrim { read_only: true, skills: false, trim: true })), [format!("{worker},Edit,Write,Skill")]);
    assert_eq!(launch(Some(WorkerTrim { read_only: false, skills: true, trim: true })), [worker]);
    assert_eq!(launch(Some(WorkerTrim { read_only: true, skills: true, trim: true })), [format!("{worker},Edit,Write")]);
    // Trim off (the default): a worker launches like a plain task, apart from read-only
    // enforcement and the Skill switch.
    let plain = "--disallowedTools=ScheduleWakeup,Monitor,CronCreate";
    assert_eq!(launch(Some(WorkerTrim { read_only: false, skills: true, trim: false })), [plain]);
    assert_eq!(launch(Some(WorkerTrim { read_only: true, skills: true, trim: false })), [format!("{plain},Edit,Write")]);
    assert_eq!(launch(Some(WorkerTrim { read_only: false, skills: false, trim: false })), [format!("{plain},Skill")]);
    let fresh = crate::app_instructions::History::fresh(false);
    assert_eq!(claude_kept_natives(Some(WorkerTrim { read_only: false, skills: true, trim: false }), &fresh), claude_kept_natives(None, &fresh));
    assert!(!claude_refuses_native(Some(WorkerTrim { read_only: false, skills: true, trim: false }), "SendMessage"));
    assert!(claude_refuses_native(Some(WorkerTrim { read_only: false, skills: true, trim: true }), "SendMessage"));
    // TaskStop also stops background Bash; search, web and the shell stay.
    for kept in ["TaskStop", "Bash", "Read", "ToolSearch", "WebFetch", "WebSearch"] {
        assert!(!claude_disallowed_tools(Some(WorkerTrim { read_only: true, skills: false, trim: true }), &crate::app_instructions::History::fresh(false)).split(['=', ',']).any(|tool| tool == kept), "{kept}");
    }
}

#[test]
fn a_resumed_read_only_worker_keeps_the_notebook_definition_and_is_denied_its_calls() {
    let read_only = WorkerTrim { read_only: true, skills: true, trim: true };
    let launch = |resume_id: Option<&str>| {
        let mut command = tokio::process::Command::new("claude");
        configure_command(&mut command, &RunConfig { worker: Some(read_only), resume_id: resume_id.map(str::to_owned), ..config("claude") });
        let args: Vec<String> = command.as_std().get_args().map(|arg| arg.to_string_lossy().into()).collect();
        args.into_iter().find(|arg| arg.starts_with("--disallowedTools")).unwrap()
    };
    let denies = |flag: &str, tool: &str| flag.split(['=', ',']).any(|denied| denied == tool);
    // NotebookEdit stays listed from the first turn so a promotion can use it.
    assert!(!denies(&launch(None), CLAUDE_NOTEBOOK_TOOL));
    // After a restart the history is unknown: it may have loaded it, so it stays defined.
    let resumed = launch(Some("conv-1"));
    assert!(!denies(&resumed, CLAUDE_NOTEBOOK_TOOL), "{resumed}");
    assert!(denies(&resumed, "Edit") && denies(&resumed, "Write"), "{resumed}");
    let call = |worker| {
        let mut p = Protocol::new(RunConfig { worker, resume_id: Some("conv-1".into()), ..config("claude") });
        p.receive(json!({"type":"control_request","request_id":"notebook","request":{"subtype":"can_use_tool","tool_name":CLAUDE_NOTEBOOK_TOOL,"input":{"notebook_path":"a.ipynb"}}})).unwrap()
    };
    let denied = call(Some(read_only));
    assert!(denied.events.is_empty(), "a refused call never asks the user");
    assert_eq!(denied.write[0]["response"]["response"]["behavior"], "deny");
    // A writer still goes through the ordinary approval.
    let writer = call(Some(WorkerTrim { read_only: false, skills: true, trim: true }));
    assert!(writer.write.is_empty() && !writer.events.is_empty());
}

#[test]
fn promoted_read_only_workers_regain_all_edit_tools_without_changing_deferred_definitions() {
    use crate::app_instructions::{remember_catalog, History};
    for trim in [false, true] {
        let session = format!("deny-{}", uuid::Uuid::new_v4());
        let read_only = Some(WorkerTrim { read_only: true, skills: true, trim });
        let writer = Some(WorkerTrim { read_only: false, skills: true, trim });
        let launch = |worker, resume: Option<&str>| {
            let history = History::of(&session, "claude", resume);
            let kept = claude_kept_natives(worker, &history);
            remember_catalog(&session, resume, None, &kept);
            let mut command = Command::new("claude");
            configure_command(&mut command, &RunConfig { session_id: session.clone(), worker, resume_id: resume.map(str::to_owned), ..config("claude") });
            let flag = command.as_std().get_args().find(|arg| arg.to_string_lossy().starts_with("--disallowedTools")).unwrap().to_string_lossy().into_owned();
            (flag, kept)
        };
        let (first, kept) = launch(read_only, None);
        assert!(kept.iter().any(|tool| tool == CLAUDE_NOTEBOOK_TOOL));
        assert!(!first.split(['=', ',']).any(|tool| tool == CLAUDE_NOTEBOOK_TOOL), "{first}");
        assert_eq!(launch(read_only, Some("conv-1")), (first, kept.clone()));
        let (promoted, promoted_kept) = launch(writer, Some("conv-1"));
        assert_eq!(kept, promoted_kept, "promotion must preserve the deferred-tool list");
        for tool in ["Edit", "Write", CLAUDE_NOTEBOOK_TOOL] {
            assert!(!promoted.split(['=', ',']).any(|denied| denied == tool), "{tool}: {promoted}");
        }
        let mut p = Protocol::new(RunConfig { worker: writer, resume_id: Some("conv-1".into()), ..config("claude") });
        let hooks = p.initial();
        assert!(!hooks["request"]["hooks"]["PreToolUse"][0]["matcher"].as_str().unwrap_or("").split('|').any(|tool| tool == CLAUDE_NOTEBOOK_TOOL));
        assert!(!claude_refuses_native(writer, CLAUDE_NOTEBOOK_TOOL));
        let step = p.receive(json!({"type":"control_request","request_id":"hook","request":{"subtype":"hook_callback","callback_id":CLAUDE_REFUSAL_HOOK,"input":{"tool_name":CLAUDE_NOTEBOOK_TOOL}}})).unwrap();
        assert_eq!(step.write[0]["response"]["response"], json!({}));
        let step = p.receive(json!({"type":"control_request","request_id":"tool","request":{"subtype":"can_use_tool","tool_name":CLAUDE_NOTEBOOK_TOOL,"input":{}}})).unwrap();
        assert!(step.write.is_empty() && !step.events.is_empty(), "a promoted writer gets ordinary approval");
        // Turning read-only again keeps the catalog and restores the refusal.
        let (demoted, demoted_kept) = launch(read_only, Some("conv-1"));
        assert_eq!(demoted_kept, kept);
        assert!(!demoted.split(['=', ',']).any(|tool| tool == CLAUDE_NOTEBOOK_TOOL));
        assert!(claude_refuses_native(read_only, CLAUDE_NOTEBOOK_TOOL));
        crate::app_instructions::forget(&[session]);
    }
}

#[test]
fn fresh_read_only_workers_refuse_listed_notebook_edits_in_every_permission_mode() {
    for trim in [false, true] {
        let worker = Some(WorkerTrim { read_only: true, skills: true, trim });
        let flag = claude_disallowed_tools(worker, &crate::app_instructions::History::fresh(false));
        for tool in ["Edit", "Write"] {
            assert!(flag.split(['=', ',']).any(|denied| denied == tool), "{tool}: {flag}");
        }
        assert!(!flag.split(['=', ',']).any(|denied| denied == CLAUDE_NOTEBOOK_TOOL));
        for mode in ["ask", "auto", "full"] {
            let mut p = Protocol::new(RunConfig { worker, mode: mode.into(), ..config("claude") });
            let initial = p.initial();
            let hook = &initial["request"]["hooks"]["PreToolUse"][0];
            assert_eq!(hook["matcher"], CLAUDE_NOTEBOOK_TOOL);
            assert_eq!(hook["hookCallbackIds"][0], CLAUDE_REFUSAL_HOOK);
            let step = p.receive(json!({"type":"control_request","request_id":"hook","request":{"subtype":"hook_callback","callback_id":CLAUDE_REFUSAL_HOOK,"input":{"tool_name":CLAUDE_NOTEBOOK_TOOL}}})).unwrap();
            assert_eq!(step.write[0]["response"]["response"]["hookSpecificOutput"]["permissionDecision"], "deny");
            assert!(step.events.is_empty());
            let step = p.receive(json!({"type":"control_request","request_id":"tool","request":{"subtype":"can_use_tool","tool_name":CLAUDE_NOTEBOOK_TOOL,"input":{}}})).unwrap();
            assert_eq!(step.write[0]["response"]["response"]["behavior"], "deny");
            assert!(step.events.is_empty());
        }
    }
}

#[test]
fn fresh_trimmed_writers_disallow_deferred_role_tools_without_a_refusal_hook() {
    let worker = Some(WorkerTrim { read_only: false, skills: true, trim: true });
    let flag = claude_disallowed_tools(worker, &crate::app_instructions::History::fresh(false));
    for tool in CLAUDE_DEFERRED_TOOLS.into_iter().filter(|tool| *tool != CLAUDE_NOTEBOOK_TOOL) {
        assert!(flag.split(['=', ',']).any(|denied| denied == tool), "{tool}: {flag}");
    }
    let p = Protocol::new(RunConfig { worker, ..config("claude") });
    assert!(p.initial()["request"]["hooks"].is_null());
}

#[test]
fn unknown_history_keeps_every_deferred_definition() {
    let history = crate::app_instructions::History::unknown(false);
    let flag = claude_disallowed_tools(Some(WorkerTrim { read_only: true, skills: false, trim: true }), &history);
    for tool in CLAUDE_DEFERRED_TOOLS {
        assert!(!flag.split(['=', ',']).any(|denied| denied == tool), "{tool}: {flag}");
    }
    for tool in ["Agent", "Edit", "Write", "Skill", "Monitor"] {
        assert!(flag.split(['=', ',']).any(|denied| denied == tool), "{tool}: {flag}");
    }
}

/// Frames recorded from Claude Code 2.1.322 (`-p`, stream-json, bypassPermissions) driven by
/// a loopback model stub that called `NotebookEdit`: no real API. Temp paths and ids are
/// replaced. The CLI accepted `INIT`, sent `CALLBACK`, and on `REPLY` refused the call without
/// running it.
const CLAUDE_HOOK_INIT: &str = r#"{"type":"control_request","request_id":"pandacode-init","request":{"subtype":"initialize","hooks":{"PreToolUse":[{"matcher":"SendMessage|NotebookEdit","hookCallbackIds":["pandacode-refuse-native"]}]}}}"#;
const CLAUDE_HOOK_CALLBACK: &str = r#"{"type":"control_request","request_id":"00000000-0000-0000-0000-000000000000","request":{"subtype":"hook_callback","callback_id":"pandacode-refuse-native","input":{"session_id":"00000000-0000-0000-0000-000000000000","transcript_path":"/tmp/fixture/config/projects/-tmp-fixture-work/00000000-0000-0000-0000-000000000000.jsonl","cwd":"/tmp/fixture/work","prompt_id":"00000000-0000-0000-0000-000000000000","permission_mode":"bypassPermissions","effort":{"level":"medium"},"hook_event_name":"PreToolUse","tool_name":"NotebookEdit","tool_input":{"notebook_path":"/tmp/fixture/work/n.ipynb","new_source":"x","cell_type":"code","edit_mode":"insert"},"tool_use_id":"toolu_stub"},"tool_use_id":"toolu_stub"}}"#;
const CLAUDE_HOOK_REPLY: &str = r#"{"type":"control_response","response":{"subtype":"success","request_id":"00000000-0000-0000-0000-000000000000","response":{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"NotebookEdit is not available to this worker."}}}}"#;

#[test]
fn the_refusal_hook_matches_frames_recorded_from_claude_code() {
    let recorded = |frame: &str| serde_json::from_str::<Value>(frame).unwrap();
    let read_only = Some(WorkerTrim { read_only: true, skills: true, trim: true });
    let mut p = Protocol::new(RunConfig { worker: read_only, mode: "full".into(), resume_id: Some("conv-1".into()), ..config("claude") });
    let (init, sent) = (recorded(CLAUDE_HOOK_INIT), p.initial());
    assert_eq!(sent["type"], init["type"]);
    assert_eq!(sent["request"]["subtype"], init["request"]["subtype"]);
    let (ours, theirs) = (&sent["request"]["hooks"]["PreToolUse"][0], &init["request"]["hooks"]["PreToolUse"][0]);
    let keys = |entry: &Value| entry.as_object().unwrap().keys().cloned().collect::<Vec<_>>();
    assert_eq!(keys(ours), keys(theirs));
    assert_eq!(ours["hookCallbackIds"], theirs["hookCallbackIds"]);
    let step = p.receive(recorded(CLAUDE_HOOK_CALLBACK)).unwrap();
    assert_eq!(step.write, [recorded(CLAUDE_HOOK_REPLY)]);
    assert!(step.events.is_empty(), "a refused call never asks the user");
}

#[test]
fn kept_deferred_tools_are_refused_in_every_permission_mode() {
    let read_only = Some(WorkerTrim { read_only: true, skills: true, trim: true });
    for mode in ["ask", "auto", "full"] {
        let resumed = RunConfig { worker: read_only, mode: mode.into(), resume_id: Some("conv-1".into()), ..config("claude") };
        let mut p = Protocol::new(resumed);
        let hooks = &p.initial()["request"]["hooks"]["PreToolUse"][0];
        assert_eq!(hooks["hookCallbackIds"][0], CLAUDE_REFUSAL_HOOK);
        let matcher = hooks["matcher"].as_str().unwrap().to_owned();
        assert!(matcher.split('|').any(|tool| tool == CLAUDE_NOTEBOOK_TOOL) && matcher.split('|').any(|tool| tool == "SendMessage"), "{matcher}");
        let step = p.receive(json!({"type":"control_request","request_id":"hook","request":{"subtype":"hook_callback","callback_id":CLAUDE_REFUSAL_HOOK,"input":{"hook_event_name":"PreToolUse","tool_name":CLAUDE_NOTEBOOK_TOOL,"tool_input":{}}}})).unwrap();
        assert_eq!(step.write[0]["response"]["response"]["hookSpecificOutput"]["permissionDecision"], "deny", "{mode}");
        assert!(step.events.is_empty(), "a refused call never asks the user");
    }
    // A writer may use the notebook tool; a plain task needs no hook.
    let writer = Some(WorkerTrim { read_only: false, skills: true, trim: true });
    let mut p = Protocol::new(RunConfig { worker: writer, resume_id: Some("conv-1".into()), ..config("claude") });
    let step = p.receive(json!({"type":"control_request","request_id":"hook","request":{"subtype":"hook_callback","callback_id":CLAUDE_REFUSAL_HOOK,"input":{"tool_name":CLAUDE_NOTEBOOK_TOOL}}})).unwrap();
    assert_eq!(step.write[0]["response"]["response"], json!({}));
    assert!(Protocol::new(RunConfig { resume_id: Some("conv-1".into()), ..config("claude") }).initial()["request"]["hooks"].is_null());
}

#[test]
fn held_custom_tools_do_not_change_the_warm_key() {
    use crate::app_instructions::{build_host, fake::{FakeLayers, CUSTOM}, History, HostPlan, Role};
    let dir = crate::custom_tools::temp();
    crate::custom_tools::test_save(&dir.0, "project", "build-app", "true");
    let specs = |mode: &str| crate::custom_tools::test_host(dir.0.clone(), "project", dir.0.clone(), "warm-key", mode).tools;
    let standard = specs("ask");
    let plan = HostPlan { team: false, codex: false, cloud: false, trim: Role::of(false, false).wants(), explore: None };
    let tools = |listed: Vec<Value>| build_host(&plan, &History::holding(&CUSTOM), &mut FakeLayers { custom: true, custom_specs: Some(listed), definitions: standard.clone(), ..Default::default() }).host.unwrap().tools;
    let cfg = RunConfig { resume_id: Some("conv-1".into()), ..config("claude") };
    assert_eq!(warm::key(&cfg, &tools(standard.clone())), warm::key(&cfg, &tools(specs("plan"))));
}

/// What Claude's permission check does with a call to PandaCode's `tool`: `true` when it
/// lets it through without asking.
fn allowed_unasked(p: &mut Protocol, tool: &str) -> bool {
    let name = format!("mcp__pandacode_architect__{tool}");
    let step = p.receive(json!({"type":"control_request","request_id":"refused","request":{"subtype":"can_use_tool","tool_name":name,"input":{}}})).unwrap();
    step.events.is_empty() && step.write.first().is_some_and(|write| write["response"]["response"]["behavior"] == "allow")
}

#[test]
fn a_resumed_read_only_workers_refused_tools_never_prompt_the_user() {
    // The write tools stay listed for a resumed read-only worker, and their handler refuses
    // every call: Claude's own permission check must not ask the user to approve one.
    let tools = ["pandacode_progress_snapshot", "pandacode_design_write", "pandacode_design_resolve", crate::custom_tools::TOOL_RUN];
    for tool in tools {
        for (refused, silent) in [(true, true), (false, false)] {
            let mut p = Protocol::new(RunConfig { worker: Some(WorkerTrim { read_only: true, skills: false, trim: true }), ..config("claude") });
            p.mcp_tool_names.insert(format!("mcp__pandacode_architect__{tool}"));
            if refused {
                p.refused_tools.insert(tool.to_owned());
            }
            assert_eq!(allowed_unasked(&mut p, tool), silent, "{tool} refused={refused}");
        }
    }
    // Only PandaCode's own registered server is exempt.
    let mut p = Protocol::new(config("claude"));
    p.refused_tools.insert("pandacode_progress_snapshot".into());
    assert!(!allowed_unasked(&mut p, "pandacode_progress_snapshot"));
}

#[test]
fn every_tool_claude_lets_through_as_refused_is_refused_by_the_real_host() {
    use crate::app_instructions::{build_host, fake::{FakeLayers, CUSTOM}, History, HostPlan, Role, READ_ONLY_WRITES};
    let names = |specs: Vec<Value>| specs.iter().filter_map(|spec| spec["name"].as_str().map(str::to_owned)).collect::<Vec<_>>();
    let task_only: HashSet<String> = names(crate::schedules::tools::catalog()).into_iter().chain(CUSTOM.map(String::from)).chain([crate::session_titles::TOOL.to_owned()]).collect();
    for provider in ["claude", "codex"] {
        for read_only in [false, true] {
            for resumed in [false, true] {
                let codex = provider == "codex";
                let role = Role::of(true, read_only);
                let worker = RunConfig { worker: Some(WorkerTrim { read_only, skills: false, trim: true }), ..config(provider) };
                // A resumed conversation after a restart: everything it may hold is kept.
                let history = if resumed { History::unknown(codex) } else { History::fresh(codex) };
                let plan = HostPlan::of(&worker, true, role, false, true, true);
                let built = build_host(&plan, &history, &mut FakeLayers { custom: true, ..Default::default() });
                let host = built.host.expect("a worker always has a host");
                let listed: HashSet<String> = names(host.tools.clone()).into_iter().collect();
                let case = format!("{provider} read_only={read_only} resumed={resumed}");
                // Which names are refused: what the worker does not want but may hold.
                let mut expected: HashSet<String> = if resumed { task_only.clone() } else { HashSet::new() };
                if read_only && (resumed || codex) {
                    expected.extend(READ_ONLY_WRITES.map(String::from));
                }
                assert_eq!(built.refused, expected, "{case}");
                let call = |name: &str| tauri::async_runtime::block_on((host.handler)(name.to_owned(), json!({})));
                for name in &listed {
                    let refusal = call(name).err().is_some_and(|error| error.contains("is not available in this turn"));
                    assert_eq!(refusal, built.refused.contains(name), "{case}: {name}");
                }
                assert!(built.refused.iter().all(|name| listed.contains(name) && !host.approval_tools.contains(name)), "{case}");
                // Claude's permission check lets exactly the refused set through on that
                // account (Codex's own permission layer does not read it).
                let mut p = Protocol::new(RunConfig { provider: "claude".into(), ..worker.clone() });
                p.mcp_tool_names = listed.iter().flat_map(|name| [name.clone(), format!("mcp__pandacode_architect__{name}")]).collect();
                p.refused_tools = built.refused.clone();
                for name in &built.refused {
                    assert!(allowed_unasked(&mut p, name), "{case}: {name}");
                }
                for gated in ["pandacode_vm_exec", "pandacode_run_project"] {
                    assert!(!allowed_unasked(&mut p, gated), "{case}: {gated} still asks");
                }
            }
        }
    }
}
