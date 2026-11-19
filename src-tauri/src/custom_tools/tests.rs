use super::host::{catalog_text, host, specs, Ctx, CATALOG_BYTES};
use super::*;
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{atomic::AtomicBool, Arc},
};

pub(crate) struct Temp(pub PathBuf);
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
pub(crate) fn temp() -> Temp {
    let dir = std::env::temp_dir().join(format!("pc-custom-tools-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&dir).unwrap();
    Temp(dir)
}

pub(super) fn author(session: &str) -> Author {
    Author { session_id: session.into(), harness: "claude".into(), model: "m".into() }
}

pub(super) fn draft(name: &str, script: &str, params: Vec<Param>) -> Draft {
    Draft { name: name.into(), description: "Prints a thing".into(), when: format!("when {name} fits"), params, script: script.into(), timeout_secs: None }
}

pub(super) fn param(name: &str, required: bool) -> Param {
    Param { name: name.into(), description: String::new(), required }
}

pub(super) fn tool(name: &str, script: &str) -> Tool {
    save(&temp().0, draft(name, script, Vec::new()), author("s"), 1).unwrap()
}

#[test]
fn names_and_limits_are_checked() {
    for good in ["ab", "run-e2e-subset", "0x", &"a".repeat(48)] {
        assert!(valid_name(good), "{good}");
    }
    for bad in ["a", "-ab", "Ab", "a_b", "a b", "../x", &"a".repeat(49), ""] {
        assert!(!valid_name(bad), "{bad}");
    }
    let dir = temp();
    let mut long = draft("ok-name", "echo hi", vec![param("Bad", false), param("x", false), param("x", false)]);
    long.description = "d".repeat(301);
    long.when = String::new();
    let error = save(&dir.0, long, author("s"), 1).unwrap_err();
    for part in ["description is over 300", "when is empty", "param name \"Bad\"", "param x is listed twice"] {
        assert!(error.contains(part), "{error}");
    }
    let many = draft("ok-name", "echo hi", (0..9).map(|i| param(&format!("p{i}"), false)).collect());
    assert!(save(&dir.0, many, author("s"), 1).unwrap_err().contains("at most 8 params"));
    assert!(save(&dir.0, draft("ok-name", &"#".repeat(16 * 1024 + 1), Vec::new()), author("s"), 1).unwrap_err().contains("script is over 16 KB"));
    let mut slow = draft("ok-name", "echo hi", Vec::new());
    slow.timeout_secs = Some(10_000);
    assert_eq!(save(&dir.0, slow, author("s"), 1).unwrap().timeout_secs, 50);
}

#[test]
fn a_syntax_error_is_refused() {
    let dir = temp();
    let error = save(&dir.0, draft("broken", "if then fi (", Vec::new()), author("s"), 1).unwrap_err();
    assert!(error.starts_with("The script has a syntax error"), "{error}");
    assert!(store::load(&dir.0, "broken").is_none());
}

#[test]
fn saving_again_bumps_the_version_and_keeps_the_author() {
    let dir = temp();
    let first = save(&dir.0, draft("build-it", "echo 1", Vec::new()), author("a"), 10).unwrap();
    assert_eq!((first.version, first.created_at, first.updated_by.is_none()), (1, 10, true));
    let second = save(&dir.0, draft("build-it", "echo 2", Vec::new()), author("b"), 20).unwrap();
    assert_eq!((second.version, second.created_at, second.updated_at), (2, 10, 20));
    assert_eq!(second.created_by.session_id, "a");
    assert_eq!(second.updated_by.unwrap().session_id, "b");
    assert_eq!(store::load(&dir.0, "build-it").unwrap().script, "echo 2");
    let file: Value = serde_json::from_str(&std::fs::read_to_string(dir.0.join("build-it.json")).unwrap()).unwrap();
    assert_eq!(file["timeoutSecs"], 50);
    assert_eq!(file["createdBy"]["harness"], "claude");
}

#[test]
fn a_project_tool_hides_a_global_one() {
    let base = temp();
    let global = store::scope_dir(&base.0, None).unwrap();
    let project = store::scope_dir(&base.0, Some("p1")).unwrap();
    save(&global, draft("lint-all", "echo global", Vec::new()), author("s"), 1).unwrap();
    save(&global, draft("only-global", "echo g", Vec::new()), author("s"), 1).unwrap();
    assert_eq!(resolve(&base.0, "p1", "lint-all").unwrap().1, Scope::Global);
    save(&project, draft("lint-all", "echo project", Vec::new()), author("s"), 1).unwrap();
    let (found, scope) = resolve(&base.0, "p1", "lint-all").unwrap();
    assert_eq!((found.script.as_str(), scope), ("echo project", Scope::Project));
    let names: Vec<(String, Scope)> = visible(&base.0, "p1").into_iter().map(|(t, _, s)| (t.name, s)).collect();
    assert_eq!(names, [("lint-all".to_owned(), Scope::Project), ("only-global".to_owned(), Scope::Global)]);
    assert!(store::scope_dir(&base.0, Some("../x")).is_err());
}

#[test]
fn args_reach_the_script_only_as_environment() {
    let dir = temp();
    let marker = dir.0.join("pwned");
    let mut found = tool("echo-arg", "printf '%s' \"$PC_VALUE\"");
    found.params = vec![param("value", true)];
    for value in [format!("$(touch {})", marker.display()), format!("; touch {}", marker.display()), format!("`touch {}`", marker.display())] {
        let outcome = run::execute(&dir.0, &found, &json!({"value": value}), &AtomicBool::new(false));
        let reply = outcome.reply.unwrap();
        assert_eq!(reply["stdout"], value);
        assert_eq!(reply["exit"], 0);
    }
    assert!(!marker.exists(), "an argument was executed");
}

#[test]
fn unknown_and_missing_params_are_refused_together() {
    let params = [param("target", true), param("filter", false)];
    let error = run::environment(&params, &json!({"other": "x"})).unwrap_err();
    assert!(error.contains("unknown param other") && error.contains("missing required param target") && error.contains("Params: target, filter?"), "{error}");
    assert!(run::environment(&params, &json!({"target": 1})).unwrap_err().contains("must be a string"));
    assert!(run::environment(&params, &json!({"target": "x".repeat(1001)})).unwrap_err().contains("at most 1000 bytes"));
    assert!(run::environment(&params, &json!({"target": "x".repeat(1000)})).is_ok());
    let env = run::environment(&params, &json!({"target": "a"})).unwrap();
    assert_eq!(env, [("PC_TARGET".to_owned(), "a".to_owned()), ("PC_FILTER".to_owned(), String::new())]);
    assert!(run::environment(&[], &json!(["x"])).is_err());
}

#[test]
fn a_slow_script_is_stopped_at_its_timeout() {
    let dir = temp();
    let mut slow = tool("sleepy", "sleep 30");
    slow.timeout_secs = 1;
    let started = std::time::Instant::now();
    let outcome = run::execute(&dir.0, &slow, &Value::Null, &AtomicBool::new(false));
    let error = outcome.reply.unwrap_err();
    assert!(error.contains("timed out after 1 s (its timeoutSecs)") && !error.contains("fix:"), "{error}");
    assert!(outcome.exit.is_none() && outcome.timed_out && started.elapsed().as_secs() < 10);
}

/// Whether a live process is left in the group `id`. Signal 0 also counts zombies:
/// Linux may keep an orphan's entry until init reaps it, after SIGKILL and pipe EOF.
#[cfg(unix)]
fn group_alive(id: i32) -> bool {
    let output = std::process::Command::new("ps").args(["-axo", "pgid=,stat="]).output().unwrap();
    assert!(output.status.success(), "ps failed: {}", String::from_utf8_lossy(&output.stderr));
    let processes = String::from_utf8(output.stdout).unwrap();
    processes.lines().any(|line| {
        let mut fields = line.split_whitespace();
        fields.next().and_then(|pgid| pgid.parse::<i32>().ok()) == Some(id)
            && fields.next().is_some_and(|state| !state.starts_with('Z'))
    })
}

#[cfg(unix)]
#[test]
fn group_alive_distinguishes_live_processes_from_unreaped_zombies() {
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};

    // A pipe keeps the shell alive until we close it, without a timed sleep.
    let mut child = Command::new("sh").args(["-c", "read line"])
        .process_group(0).stdin(Stdio::piped()).spawn().unwrap();
    let id = child.id() as i32;
    let live = group_alive(id);
    drop(child.stdin.take());
    // Observe its exit without reaping it, so the zombie cannot disappear under ps.
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    let waited = unsafe { libc::waitid(libc::P_PID, id as libc::id_t, &mut info, libc::WEXITED | libc::WNOWAIT) };
    #[cfg(target_os = "linux")]
    let signal_sees_zombie = unsafe { libc::kill(-id, 0) == 0 };
    let zombie_is_live = group_alive(id);
    child.wait().unwrap();
    assert_eq!(waited, 0);
    assert!(live, "a running shell must be detected");
    #[cfg(target_os = "linux")]
    assert!(signal_sees_zombie, "signal 0 must still see the unreaped shell");
    assert!(!zombie_is_live, "an exited shell cannot run or hold output pipes open");
}

#[cfg(unix)]
#[test]
fn stop_kills_the_script_and_its_background_jobs() {
    let dir = temp();
    let script = tool("two-sleeps", "echo $$ > leader; sleep 30 & sleep 30");
    let stopped = Arc::new(AtomicBool::new(false));
    let flag = stopped.clone();
    let setter = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(200));
        flag.store(true, std::sync::atomic::Ordering::SeqCst);
    });
    let started = std::time::Instant::now();
    let outcome = run::execute(&dir.0, &script, &Value::Null, &stopped);
    setter.join().unwrap();
    assert!(started.elapsed() < std::time::Duration::from_secs(2), "{:?}", started.elapsed());
    assert_eq!(outcome.reply.unwrap_err(), "Task has stopped.");
    let leader: i32 = std::fs::read_to_string(dir.0.join("leader")).unwrap().trim().parse().unwrap();
    assert!(!group_alive(leader), "a sleep from the script's group is still running");
}

#[cfg(unix)]
#[test]
fn background_jobs_end_with_the_script() {
    let dir = temp();
    let script = tool("leaves-a-job", "echo $$ > leader; sleep 30 & echo done");
    let started = std::time::Instant::now();
    let reply = run::execute(&dir.0, &script, &Value::Null, &AtomicBool::new(false)).reply.unwrap();
    assert_eq!((reply["stdout"].as_str(), reply["exit"].as_i64()), (Some("done\n"), Some(0)));
    assert!(started.elapsed() < std::time::Duration::from_secs(2));
    let leader: i32 = std::fs::read_to_string(dir.0.join("leader")).unwrap().trim().parse().unwrap();
    assert!(!group_alive(leader));
}

#[test]
fn output_keeps_the_tail_of_each_stream_and_failures_carry_a_fix() {
    let dir = temp();
    let loud = tool("loud", "i=0; while [ $i -lt 3000 ]; do echo \"line $i\"; i=$((i+1)); done; echo last >&2; exit 3");
    let reply = run::execute(&dir.0, &loud, &Value::Null, &AtomicBool::new(false)).reply.unwrap();
    let stdout = reply["stdout"].as_str().unwrap();
    assert!(stdout.len() <= run::KEEP && stdout.ends_with("line 2999\n"));
    assert_eq!((reply["truncated"].as_bool(), reply["exit"].as_i64(), reply["stderr"].as_str()), (Some(true), Some(3), Some("last\n")));
    assert!(reply["fix"].as_str().unwrap().contains("same name"));
    assert_eq!(run::tail("aé".as_bytes(), 1), ("".into(), true));
}

#[test]
fn stats_count_runs_and_keep_the_last_fifty_tasks() {
    let dir = temp();
    for at in 0..55 {
        store::record(&dir.0, "t1", &format!("s{at}"), Some(if at % 5 == 0 { 1 } else { 0 }), at).unwrap();
    }
    store::record(&dir.0, "t1", "s10", Some(0), 99).unwrap();
    let stats = store::read_stats(&dir.0).remove("t1").unwrap();
    assert_eq!((stats.uses, stats.failures, stats.last_used_at, stats.last_exit), (56, 11, Some(99), Some(0)));
    assert_eq!(stats.tasks.len(), 50);
    assert_eq!(stats.tasks.last().unwrap(), "s10");
    assert!(!stats.tasks.contains(&"s0".to_owned()));
}

#[test]
fn moving_carries_stats_and_refuses_a_taken_name() {
    let base = temp();
    let project = store::scope_dir(&base.0, Some("p1")).unwrap();
    let global = store::scope_dir(&base.0, None).unwrap();
    save(&project, draft("deploy-it", "echo p", Vec::new()), author("s"), 1).unwrap();
    store::record(&project, "deploy-it", "s", Some(0), 5).unwrap();
    // A drop onto its own scope changes nothing (without the guard it would be "already exists").
    store::move_tool(&project, &project, "deploy-it").unwrap();
    assert_eq!((store::load(&project, "deploy-it").unwrap().script.as_str(), store::read_stats(&project)["deploy-it"].uses), ("echo p", 1));
    store::move_tool(&project, &global, "deploy-it").unwrap();
    assert!(store::load(&project, "deploy-it").is_none());
    assert_eq!(store::read_stats(&global)["deploy-it"].uses, 1);
    assert!(!store::read_stats(&project).contains_key("deploy-it"));
    save(&project, draft("deploy-it", "echo again", Vec::new()), author("s"), 1).unwrap();
    assert_eq!(store::move_tool(&project, &global, "deploy-it").unwrap_err(), "A tool named deploy-it already exists there.");
    let listed = ipc::listing(&base.0, |id| format!("name of {id}")).unwrap();
    assert_eq!((listed.global.len(), listed.projects[0].project_name.as_str()), (1, "name of p1"));
    assert_eq!(serde_json::to_value(&listed.global[0]).unwrap()["scope"], "global");
    store::delete(&project, "deploy-it").unwrap();
    assert!(ipc::listing(&base.0, |id| id.into()).unwrap().projects.is_empty(), "projects without tools are left out");
}

fn ranked_tool(name: &str, uses: u64, last: i64) -> (Tool, Stats, Scope) {
    let mut found = Tool { name: name.into(), when: "w".repeat(80), ..tool("x-placeholder", "true") };
    found.params = vec![param("a", true), param("b", false)];
    (found, Stats { uses, last_used_at: Some(last), ..Stats::default() }, Scope::Project)
}

#[test]
fn the_catalog_is_listed_by_name_and_capped() {
    let text = catalog_text(vec![ranked_tool("rare", 1, 50), ranked_tool("often", 9, 1), ranked_tool("recent", 1, 60)]);
    let order: Vec<&str> = text.lines().filter_map(|line| line.strip_prefix("- ")).map(|line| line.split('(').next().unwrap()).collect();
    assert_eq!(order, ["often", "rare", "recent"]);
    // More use does not move a line, so the description stays the same from run to run.
    assert_eq!(text, catalog_text(vec![ranked_tool("rare", 7, 90), ranked_tool("often", 9, 1), ranked_tool("recent", 1, 60)]));
    assert!(text.contains("often(a, b?) — www"));
    let many: Vec<_> = (0..40).map(|i| ranked_tool(&format!("tool-{i:02}"), i, 0)).collect();
    let capped = catalog_text(many);
    assert!(capped.len() <= CATALOG_BYTES && capped.lines().count() > 10, "{}", capped.len());
    assert!(!capped.contains("tool-14("), "only the 25 most used are listed");
    let mut off = ranked_tool("off", 99, 0);
    off.0.disabled = true;
    assert!(catalog_text(vec![off]).is_empty());
}

pub(super) fn ctx(base: &Temp, root: &Temp, session: &str) -> Ctx {
    Ctx { base: base.0.clone(), project: "p1".into(), root: root.0.clone(), author: author(session), full: false, changed: Box::new(|| {}) }
}

/// A task in Full access: runs need no approval.
fn full_ctx(base: &Temp, root: &Temp, session: &str) -> Ctx {
    Ctx { full: true, ..ctx(base, root, session) }
}

#[test]
fn plan_mode_offers_only_the_list_and_run_needs_approval() {
    let names = |plan| specs(plan).iter().map(|spec| spec["name"].as_str().unwrap().to_owned()).collect::<Vec<_>>();
    assert_eq!(names(true), [TOOL_LIST]);
    assert_eq!(names(false), [TOOL_LIST, TOOL_SAVE, TOOL_RUN]);
    let (base, root) = (temp(), temp());
    test_save(&base.0, "p1", "build-app", "true");
    let full = host(None, ctx(&base, &root, "s"), Arc::default(), false);
    assert!(full.approval_tools.contains(TOOL_RUN) && full.approval_tools.len() == 1);
    let plan = host(None, ctx(&base, &root, "s"), Arc::default(), true);
    assert!(plan.approval_tools.is_empty());
    let refused = tauri::async_runtime::block_on((plan.handler)(TOOL_SAVE.into(), json!({})));
    assert_eq!(refused.unwrap_err(), "Unknown PandaCode tool.");
    assert!(!auto_allowed(TOOL_RUN) && auto_allowed(TOOL_SAVE) && auto_allowed(TOOL_LIST));
    assert!(!offered(true) && offered(false), "cloud agents get nothing");
}

#[test]
fn agents_save_list_and_run_through_the_host() {
    let (base, root) = (temp(), temp());
    let first = host(None, full_ctx(&base, &root, "s1"), Arc::new(AtomicBool::new(false)), false);
    let saved = tauri::async_runtime::block_on((first.handler)(TOOL_SAVE.into(), json!({"name":"greet","description":"Prints a greeting","when":"to greet","params":[{"name":"who","required":true}],"script":"echo \"hi $PC_WHO\""}))).unwrap();
    let tools = host(None, full_ctx(&base, &root, "s1"), Arc::new(AtomicBool::new(false)), false);
    let call = |name: &str, args: Value| tauri::async_runtime::block_on((tools.handler)(name.into(), args));
    assert_eq!(saved, json!({"saved":"greet","version":1,"scope":"project","run":"pandacode_tool_run {name, args}"}));
    assert!(call(TOOL_SAVE, json!({"name":"x1","description":"d","when":"w","script":"true","extra":1})).is_err());
    let ran = call(TOOL_RUN, json!({"name":"greet","args":{"who":"you"}})).unwrap();
    assert_eq!((ran["stdout"].as_str(), ran["version"].as_u64()), (Some("hi you\n"), Some(1)));
    let listed = call(TOOL_LIST, json!({})).unwrap();
    assert_eq!((listed["tools"][0]["uses"].as_u64(), listed["tools"][0]["scope"].as_str()), (Some(1), Some("project")));
    let project = store::scope_dir(&base.0, Some("p1")).unwrap();
    store::set_disabled(&project, "greet", true).unwrap();
    assert!(call(TOOL_RUN, json!({"name":"greet","args":{"who":"x"}})).unwrap_err().contains("disabled"));
    // The per-message catalog lists the saved tool, and leaves it out while disabled.
    assert!(catalog_text(visible(&base.0, "p1")).is_empty(), "disabled tools are not advertised");
    store::set_disabled(&project, "greet", false).unwrap();
    assert!(catalog_text(visible(&base.0, "p1")).contains("- greet(who) — to greet"));
}

#[test]
fn an_empty_catalog_lists_the_same_tools_as_a_full_one() {
    let (base, root) = (temp(), temp());
    let names = |plan| host(None, ctx(&base, &root, "s"), Arc::default(), plan).tools.iter().map(|spec| spec["name"].as_str().unwrap().to_owned()).collect::<Vec<_>>();
    let specs_now = || host(None, ctx(&base, &root, "s"), Arc::default(), false).tools;
    let empty = specs_now();
    assert_eq!(names(false), [TOOL_LIST, TOOL_SAVE, TOOL_RUN]);
    assert_eq!(names(true), [TOOL_LIST]);
    // A run with nothing saved fails like any unknown name.
    let tools = host(None, full_ctx(&base, &root, "s"), Arc::default(), false);
    let missing = tauri::async_runtime::block_on((tools.handler)(TOOL_RUN.into(), json!({"name": "x1"})));
    assert!(missing.unwrap_err().contains("No tool named x1"));
    // The first tool, disabled or global ones change no byte of the listing.
    test_save(&base.0, "p1", "build-app", "true");
    assert_eq!(specs_now(), empty);
    let project = store::scope_dir(&base.0, Some("p1")).unwrap();
    store::set_disabled(&project, "build-app", true).unwrap();
    let global = store::scope_dir(&base.0, None).unwrap();
    save(&global, draft("ship-it", "true", Vec::new()), author("s"), 1).unwrap();
    assert_eq!(specs_now(), empty);
}

#[test]
fn the_offered_tools_stay_the_same_whatever_the_catalog_holds() {
    // The warm agent's key holds the tool catalog: no save, failed or not, changes it.
    let (base, root) = (temp(), temp());
    let offered = || host(None, ctx(&base, &root, "s"), Arc::default(), false).tools;
    let before = offered();
    let failed = json!({"name": "bad name", "description": "d", "when": "w", "script": "true"});
    assert!(tauri::async_runtime::block_on((host(None, ctx(&base, &root, "s"), Arc::default(), false).handler)(TOOL_SAVE.into(), failed)).is_err());
    test_save(&base.0, "other", "lint-all", "true");
    assert_eq!(offered(), before, "a failed save or another project's tool keeps it");
    test_save(&base.0, "p1", "build-app", "true");
    assert_eq!(offered(), before, "nor the first tool");
}

#[test]
fn settings_listing_reports_directory_errors_but_allows_absent_folders() {
    let base = temp();
    let fresh = ipc::listing(&base.0.join("absent"), str::to_owned).unwrap();
    assert!(fresh.global.is_empty() && fresh.projects.is_empty());
    for relative in ["global", "projects", "projects/p1"] {
        let path = base.0.join(relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "not a directory").unwrap();
        assert!(ipc::listing(&base.0, str::to_owned).is_err(), "{relative} must report a listing error");
        assert!(store::load_all(&path).is_empty(), "the agent catalog stays fail-soft");
        std::fs::remove_file(path).unwrap();
    }
}

#[cfg(unix)]
struct RestoreMode {
    path: PathBuf,
    mode: u32,
}

#[cfg(unix)]
impl RestoreMode {
    fn set(path: PathBuf, mode: u32, restore: u32) -> Self {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode)).unwrap();
        Self { path, mode: restore }
    }
}

#[cfg(unix)]
impl Drop for RestoreMode {
    fn drop(&mut self) {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&self.path, std::fs::Permissions::from_mode(self.mode));
    }
}

#[cfg(unix)]
#[test]
fn failed_move_leaves_source_and_stats_intact_and_retry_succeeds() {
    if unsafe { libc::geteuid() } == 0 {
        return;
    }
    let base = temp();
    let project = store::scope_dir(&base.0, Some("p1")).unwrap();
    let global = store::scope_dir(&base.0, None).unwrap();
    save(&project, draft("deploy-it", "echo p", Vec::new()), author("s"), 1).unwrap();
    save(&project, draft("no-stats", "echo plain", Vec::new()), author("s"), 1).unwrap();
    store::record(&project, "deploy-it", "s1", Some(1), 10).unwrap();
    store::record(&project, "deploy-it", "s2", Some(0), 42).unwrap();
    let expected_stats = store::read_stats(&project).remove("deploy-it").unwrap();

    // Read-only source dir: move must fail cleanly without leaving copies or stats in global.
    let lock_project = RestoreMode::set(project.clone(), 0o555, 0o755);
    assert!(store::move_tool(&project, &global, "deploy-it").is_err());
    assert!(store::move_tool(&project, &global, "no-stats").is_err());
    assert!(store::load(&global, "deploy-it").is_none());
    assert!(store::load(&global, "no-stats").is_none());
    assert!(!global.join("deploy-it.json").exists());
    assert!(!global.join("no-stats.json").exists());
    assert!(!store::read_stats(&global).contains_key("deploy-it"));
    assert_eq!(store::read_stats(&project)["deploy-it"], expected_stats);
    let listed = ipc::listing(&base.0, str::to_owned).unwrap();
    assert!(listed.global.is_empty(), "failed move must not leave anything in global");
    assert_eq!(listed.projects.len(), 1);
    let project_names: Vec<&str> = listed.projects[0].tools.iter().map(|t| t.tool.name.as_str()).collect();
    assert_eq!(project_names, ["deploy-it", "no-stats"]);
    assert_eq!(listed.projects[0].tools[0].stats, expected_stats);

    // Restoring permissions lets retry succeed with stats intact and nothing left in project.
    drop(lock_project);
    store::move_tool(&project, &global, "deploy-it").unwrap();
    store::move_tool(&project, &global, "no-stats").unwrap();
    let listed = ipc::listing(&base.0, str::to_owned).unwrap();
    assert!(listed.projects.is_empty());
    let global_names: Vec<&str> = listed.global.iter().map(|t| t.tool.name.as_str()).collect();
    assert_eq!(global_names, ["deploy-it", "no-stats"]);
    assert_eq!(listed.global[0].stats, expected_stats);
    assert!(!store::read_stats(&project).contains_key("deploy-it"));

    // Reverse direction (global -> project, where project dir already exists) also rolls back cleanly.
    let lock_global = RestoreMode::set(global.clone(), 0o555, 0o755);
    assert!(store::move_tool(&global, &project, "deploy-it").is_err());
    assert!(store::load(&project, "deploy-it").is_none());
    assert!(!store::read_stats(&project).contains_key("deploy-it"));
    assert_eq!(store::read_stats(&global)["deploy-it"], expected_stats);
    drop(lock_global);
    store::move_tool(&global, &project, "deploy-it").unwrap();
    let listed = ipc::listing(&base.0, str::to_owned).unwrap();
    assert_eq!(listed.global.iter().map(|t| t.tool.name.as_str()).collect::<Vec<_>>(), ["no-stats"]);
    assert_eq!(listed.projects.len(), 1);
    assert_eq!(listed.projects[0].tools[0].tool.name, "deploy-it");
    assert_eq!(listed.projects[0].tools[0].stats, expected_stats);
    assert!(!store::read_stats(&global).contains_key("deploy-it"));
}

#[cfg(unix)]
#[test]
fn settings_listing_reports_unsearchable_scope_and_unreadable_tool_files() {
    if unsafe { libc::geteuid() } == 0 {
        return;
    }
    let base = temp();
    let global = store::scope_dir(&base.0, None).unwrap();
    let project = store::scope_dir(&base.0, Some("p1")).unwrap();
    save(&global, draft("global-tool", "echo g", Vec::new()), author("s"), 1).unwrap();
    save(&project, draft("proj-tool", "echo p", Vec::new()), author("s"), 1).unwrap();

    // Enumerable but unsearchable (0444) global dir containing a valid tool must error in Settings.
    let lock_global = RestoreMode::set(global.clone(), 0o444, 0o755);
    assert!(ipc::listing(&base.0, str::to_owned).is_err(), "0444 global dir must not silently list empty");
    assert!(store::try_load_all(&global).is_err());
    assert!(store::load_all(&global).is_empty(), "agent catalog stays fail-soft");
    drop(lock_global);

    // Enumerable but unsearchable (0444) project dir containing a valid tool must error in Settings.
    let lock_project = RestoreMode::set(project.clone(), 0o444, 0o755);
    assert!(ipc::listing(&base.0, str::to_owned).is_err(), "0444 project dir must not silently list empty");
    assert!(store::try_load_all(&project).is_err());
    assert!(store::load_all(&project).is_empty(), "agent catalog stays fail-soft");
    drop(lock_project);

    // Enumerable but unsearchable (0444) projects root must also error in Settings.
    let lock_projects = RestoreMode::set(base.0.join("projects"), 0o444, 0o755);
    assert!(ipc::listing(&base.0, str::to_owned).is_err(), "0444 projects root must report an access error");
    drop(lock_projects);

    // An unreadable tool file inside a normal directory must also error in Settings.
    let lock_file = RestoreMode::set(project.join("proj-tool.json"), 0o000, 0o644);
    assert!(ipc::listing(&base.0, str::to_owned).is_err(), "0000 tool file must report an access error");
    assert!(store::load_all(&project).is_empty(), "agent catalog stays fail-soft");
    drop(lock_file);

    // Symlinks, invalid JSON and non-UTF-8 files stay ignored instead of failing Settings.
    std::os::unix::fs::symlink(project.join("proj-tool.json"), project.join("link-tool.json")).unwrap();
    std::fs::write(project.join("broken-tool.json"), "{not json").unwrap();
    std::fs::write(project.join("binary-tool.json"), [0xff, 0xfe, 0x00]).unwrap();
    let listed = ipc::listing(&base.0, str::to_owned).unwrap();
    assert_eq!(listed.global.len(), 1);
    assert_eq!(listed.projects.len(), 1);
    assert_eq!(listed.projects[0].tools.len(), 1);
    assert_eq!(listed.projects[0].tools[0].tool.name, "proj-tool");
}
