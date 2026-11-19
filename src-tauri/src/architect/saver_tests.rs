use super::*;

/// Every worker launch until none is left; each launched worker is marked completed so the
/// fixture's parallel limit never holds the next one back.
fn launches(state: &AppState, sid: &str) -> std::collections::HashMap<String, String> {
    let mut prompts = std::collections::HashMap::new();
    while let Some(launch) = next_action_state(state, &mut |_| {}).unwrap() {
        if launch.sid == sid {
            break;
        }
        let store = state.store.lock().unwrap();
        let mut team = load(&store, sid).unwrap().unwrap();
        team.workers.iter_mut().filter(|w| w.session_id == launch.sid).for_each(|w| w.status = "completed".into());
        save(&store, &mut team).unwrap();
        prompts.insert(launch.sid, launch.prompt);
    }
    prompts
}
#[test]
fn workers_carry_only_the_token_saver_they_are_given() {
    let (state, sid) = state_fixture();
    let packs = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    let with = |key: &str, file: &str, saver: Value| {
        let mut a = assignment(key, "fast", file);
        a["tokenSaver"] = saver;
        a
    };
    // Nothing asked: nothing applies, and the saved request (the idempotency key) is exactly
    // what it was before tokenSaver existed.
    let plain = call(&state, &sid, "pandacode_dispatch_workers", json!({"assignments":[assignment("plain","fast","a")]})).unwrap();
    assert_eq!(plain["tokenSaver"], json!(["plain: none"]));
    let saved: String = state.store.lock().unwrap().db.query_row("SELECT content FROM architect_requests WHERE key='plain'", [], |r| r.get(0)).unwrap();
    assert_eq!(saved, serde_json::to_string(&serde_json::from_value::<Assignment>(assignment("plain", "fast", "a")).unwrap()).unwrap());
    assert!(!saved.contains("tokenSaver"));

    // The lead's own style is not inherited (S1v3: packs saved nothing, inherited blocks cost input).
    let lead = crate::token_saver::guidance(&packs(&["caveman", "quiet-tools"]), "lite", false);
    state.store.lock().unwrap().message(&sid, "user", &format!("Build it\n\n{lead}")).unwrap();
    let result = call(&state, &sid, "pandacode_dispatch_workers", json!({"assignments":[
        assignment("omitted","fast","b"),
        with("lean","c",json!({"packs":["lean-code","quiet-tools"]})),
        with("off","d",json!("none")),
        with("full","e",json!({"packs":["caveman"],"level":"full"})),
    ]})).unwrap();
    assert_eq!(result["tokenSaver"], json!(["omitted: none", "lean: lean-code+quiet-tools", "off: none", "full: caveman/full"]));
    let bad = call(&state, &sid, "pandacode_dispatch_workers", json!({"assignments":[with("bad","e",json!({"packs":["verbose"]}))]})).unwrap_err();
    assert!(bad.contains("Unknown token saver pack"), "{bad}");
    let bad = call(&state, &sid, "pandacode_dispatch_workers", json!({"assignments":[with("bad","e",json!({"packs":["quiet-tools"],"level":"ultra"}))]})).unwrap_err();
    assert!(bad.contains("only with caveman"), "{bad}");

    let team = load(&state.store.lock().unwrap(), &sid).unwrap().unwrap();
    let by_name = |name: &str| team.workers.iter().find(|w| w.name == name).unwrap().clone();
    let prompts = launches(&state, &sid);
    let prompt = |name: &str| prompts[&by_name(name).session_id].clone();
    assert_eq!(prompt("plain"), by_name("plain").assignment, "no block");
    assert_eq!(prompt("omitted"), by_name("omitted").assignment, "the lead's block is not passed on");
    assert_eq!(prompt("off"), by_name("off").assignment, "none on dispatch says nothing");
    // A worker's block never carries the thread's subagent line.
    let worker_lean = crate::token_saver::worker_guidance(&packs(&["lean-code", "quiet-tools"]), "");
    assert!(prompt("lean").ends_with(&worker_lean) && !prompt("lean").contains("subagents"));
    assert!(prompt("full").ends_with(&crate::token_saver::worker_guidance(&packs(&["caveman"]), "full")), "an explicit full stays full");

    // Follow-ups: omitted keeps the worker's packs; "none" switches them off in its conversation.
    let kept = call(&state, &sid, "pandacode_followup_worker", json!({"workerId":by_name("lean").id,"key":"lean2","prompt":"Also the edge case."})).unwrap();
    assert_eq!(kept["tokenSaver"], "lean-code+quiet-tools");
    let off = call(&state, &sid, "pandacode_followup_worker", json!({"workerId":by_name("full").id,"key":"full2","prompt":"Write the release note.","tokenSaver":"none"})).unwrap();
    assert_eq!(off["tokenSaver"], "none");
    let saved: String = state.store.lock().unwrap().db.query_row("SELECT content FROM architect_requests WHERE key='lean2'", [], |r| r.get(0)).unwrap();
    assert!(!saved.contains("tokenSaver"));
    let prompts = launches(&state, &sid);
    let lean = &prompts[&by_name("lean").session_id];
    assert!(lean.starts_with("Also the edge case.\n\nResponse style (PandaCode token saver") && lean.contains("Write the least code"), "{lean}");
    assert_eq!(prompts[&by_name("full").session_id], format!("Write the release note.\n\n{}", crate::token_saver::guidance(&[], "", false)));
}
fn saver_text(packs: &[&str], level: &str) -> String {
    crate::token_saver::guidance(&packs.iter().map(|s| s.to_string()).collect::<Vec<_>>(), level, false)
}
#[test]
fn token_saver_is_typed_on_every_tool_that_takes_it() {
    let typed = json!(["string", "object"]);
    let architect = catalog();
    let tool = |tools: &[Value], name: &str| tools.iter().find(|t| t["name"] == name).unwrap().clone();
    let dispatch = tool(&architect, "pandacode_dispatch_workers");
    assert_eq!(dispatch["inputSchema"]["properties"]["assignments"]["items"]["properties"]["tokenSaver"]["type"], typed);
    assert_eq!(tool(&architect, "pandacode_followup_worker")["inputSchema"]["properties"]["tokenSaver"]["type"], typed);
    let workers = sub_worker_catalog();
    assert_eq!(tool(&workers, "pandacode_dispatch_workers")["inputSchema"]["properties"]["assignments"]["items"]["properties"]["tokenSaver"]["type"], typed);
    assert_eq!(tool(&workers, "pandacode_sub_workers")["inputSchema"]["properties"]["tokenSaver"]["type"], typed);
    // The explanation is never in a schema; it rides the lead rules only when it can matter.
    assert!(!dispatch["description"].as_str().unwrap().contains("tokenSaver"));
}
#[test]
fn the_lead_hears_about_token_saver_only_while_packs_are_on() {
    let (state, sid) = state_fixture();
    let store = state.store.lock().unwrap();
    let team = load(&store, &sid).unwrap().unwrap();
    let rules = |store: &Store| lead_rules(store, &team, &sid).unwrap().text;
    assert!(!rules(&store).contains("tokenSaver"), "off by default");
    store.message(&sid, "user", &format!("Build it\n\n{}", saver_text(&["quiet-tools"], ""))).unwrap();
    assert!(rules(&store).contains(saver::LEAD_SAVER_GUIDANCE), "packs on in the lead's thread");
    store.message(&sid, "user", "Keep going").unwrap();
    assert!(rules(&store).contains(saver::LEAD_SAVER_GUIDANCE), "a later message without a block keeps them on");
    store.message(&sid, "user", &format!("Plainly now\n\n{}", saver_text(&[], ""))).unwrap();
    assert!(!rules(&store).contains("tokenSaver"), "switched off");
    let mut guided = team.clone();
    guided.config.lead_guidance = Some("Give reviewers the quiet-tools token saver.".into());
    assert!(lead_rules(&store, &guided, &sid).unwrap().text.contains(saver::LEAD_SAVER_GUIDANCE), "the team guidance names it");
}
#[test]
fn sub_workers_do_not_inherit_their_threads_saver_either() {
    let (state, sid, _lead, _run, engine) = nested_fixture();
    let engine_thread = team_of(&state, &sid).workers.iter().find(|w| w.id == engine).unwrap().session_id.clone();
    state.store.lock().unwrap().message(&engine_thread, "user", &saver_text(&["caveman"], "lite")).unwrap();
    let child = sub_call(&state, &sid, &engine, "pandacode_dispatch_workers", json!({"assignments":[assignment("lexer","fast","src/lexer")]})).unwrap();
    assert_eq!(child["tokenSaver"], json!(["lexer: none"]));
    let mut encoded = assignment("parser", "fast", "src/parser");
    encoded["tokenSaver"] = json!("{\"packs\":[\"lean-code\"]}");
    let child = sub_call(&state, &sid, &engine, "pandacode_dispatch_workers", json!({"assignments":[encoded]})).unwrap();
    assert_eq!(child["tokenSaver"], json!(["parser: lean-code"]), "a JSON-encoded object is accepted");
    let parser = team_of(&state, &sid).workers.into_iter().find(|w| w.name == "parser").unwrap();
    assert_eq!(saver_block(&parser), format!("\n\n{}", crate::token_saver::worker_guidance(&["lean-code".into()], "")));
}
#[test]
fn switch_offs_follow_packs_only_and_rtk_is_taken_as_asked() {
    let (state, sid) = state_fixture();
    let run = |name: &str, args: Value| {
        let generation = team_of(&state, &sid).generation;
        dispatch_as(&state, &sid, generation, None, name, args, &AtomicBool::new(false), &routing::AutoRoutes::default()).map(|x| x.0)
    };
    let with = |key: &str, file: &str, saver: Value| {
        let mut a = assignment(key, "fast", file);
        a["tokenSaver"] = saver;
        a
    };
    let result = run("pandacode_dispatch_workers", json!({"assignments":[
        with("off","a",json!("none")),
        with("tools","b",json!({"packs":["rtk","quiet-tools"]})),
    ]})).unwrap();
    // rtk is never checked for workers: its pack says to run a rejected command plainly.
    assert_eq!(result["tokenSaver"], json!(["off: none", "tools: quiet-tools+rtk"]));
    let team = team_of(&state, &sid);
    let id = |name: &str| team.workers.iter().find(|w| w.name == name).unwrap().clone();
    let prompts = launches(&state, &sid);
    let rtk = crate::token_saver::worker_guidance(&["quiet-tools".into(), "rtk".into()], "");
    assert!(prompts[&id("tools").session_id].ends_with(&rtk) && rtk.contains("rtk"), "{rtk}");

    // "none", then a follow-up that names nothing: no packs were ever sent, so nothing is said.
    run("pandacode_followup_worker", json!({"workerId":id("off").id,"key":"off2","prompt":"Again."})).unwrap();
    // Packs, then "none": the conversation hears they are off.
    let follow = run("pandacode_followup_worker", json!({"workerId":id("tools").id,"key":"tools2","prompt":"Again.","tokenSaver":"none"})).unwrap();
    assert_eq!(follow["tokenSaver"], "none");
    assert!(follow.get("notes").is_none());
    let prompts = launches(&state, &sid);
    assert_eq!(prompts[&id("off").session_id], "Again.");
    assert_eq!(prompts[&id("tools").session_id], format!("Again.\n\n{}", saver_text(&[], "")));
    // Said once: the next follow-up that names nothing stays quiet.
    run("pandacode_followup_worker", json!({"workerId":id("tools").id,"key":"tools3","prompt":"Once more.","tokenSaver":null})).unwrap();
    assert_eq!(launches(&state, &sid)[&id("tools").session_id], "Once more.");

    // An explicit "none" to a worker that never had packs says nothing either.
    let none = run("pandacode_followup_worker", json!({"workerId":id("off").id,"key":"off3","prompt":"Last pass.","tokenSaver":"none"})).unwrap();
    assert_eq!(none["tokenSaver"], "none");
    assert_eq!(launches(&state, &sid)[&id("off").session_id], "Last pass.");
}
