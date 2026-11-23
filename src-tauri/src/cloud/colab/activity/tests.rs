//! The thread runtime tracker's lifecycle, without an app.
use super::*;

const T0: u64 = 1_700_000_000_000;

fn info(name: &str, hardware: &str) -> Info {
    Info { name: name.into(), hardware: hardware.into(), high_mem: false, started_at: None }
}
fn record(endpoint: &str, accelerator: &str, shape: &str) -> SessionRecord {
    SessionRecord { name: format!("{endpoint}-name"), endpoint: endpoint.into(), accelerator: accelerator.into(), machine_shape: shape.into(), created_at: 1_700_000_000, ..SessionRecord::default() }
}
fn records(list: &[SessionRecord]) -> Records {
    list.iter().map(|r| (r.endpoint.clone(), r.clone())).collect()
}
fn states(list: &[ColabThreadRuntime]) -> Vec<(String, String)> {
    list.iter().map(|r| (r.id.clone(), r.state.clone())).collect()
}
fn agent(stage: &str, machine: Option<&str>, detail: Option<&str>) -> crate::cloud_agents::State {
    crate::cloud_agents::State { provider: "colab".into(), machine: machine.map(str::to_string), stage: stage.into(), detail: detail.map(str::to_string), ..Default::default() }
}

#[test]
fn hardware_labels_read_like_colab_menus() {
    for (code, label) in [("NONE", "CPU"), ("", "CPU"), ("T4", "T4 GPU"), ("L4", "L4 GPU"), ("G4", "G4 GPU"), ("A100", "A100 GPU"), ("H100", "H100 GPU"), ("V5E1", "v5e-1 TPU"), ("V6E1", "v6e-1 TPU"), ("t4", "T4 GPU")] {
        assert_eq!(hardware_label(code), label, "{code}");
    }
    assert_eq!(hardware_label("T4 GPU"), "T4 GPU", "a label passes through");
}

#[test]
fn the_contract_serializes_in_camel_case() {
    let entry = ready_entry("ep-1", &info("demo", "T4 GPU"), T0);
    let value = serde_json::to_value(&entry).unwrap();
    assert_eq!(value["id"], "colab:ep-1");
    assert_eq!(value["highMem"], false);
    assert_eq!(value["startedAt"], T0);
    assert_eq!(value["busySince"], serde_json::Value::Null);
    assert!(value["browserUrl"].as_str().unwrap().contains("ep-1"));
    assert_eq!(value.as_object().unwrap().len(), 11);
}

#[test]
fn a_pending_runtime_becomes_the_created_one_in_place() {
    let tracker = Tracker::default();
    tracker.begin_busy("s", "older", &info("older", "CPU"), "busy", "Running Python", T0);
    let id = tracker.begin_create("s", "trainer", "A100", true, T0 + 1);
    assert!(id.starts_with(PENDING));
    let pending = tracker.snapshot("s")[1].clone();
    assert_eq!((pending.state.as_str(), pending.hardware.as_str(), pending.endpoint.as_str()), ("creating", "A100 GPU", ""));
    assert_eq!(pending.activity.as_deref(), Some("Allocating A100 GPU…"));
    assert_eq!(pending.busy_since, Some(T0 + 1));
    tracker.begin_create("s", "", "NONE", false, T0 + 2);
    tracker.finish_create("s", &id, Ok(("ep-9", &Info::default())), T0 + 50);
    let list = tracker.snapshot("s");
    assert_eq!(states(&list)[1], ("colab:ep-9".into(), "ready".into()));
    let created = &list[1];
    assert_eq!((created.name.as_str(), created.hardware.as_str(), created.high_mem), ("trainer", "A100 GPU", true), "the pending name and hardware carry over");
    assert_eq!((created.started_at, created.busy_since, created.activity.clone()), (T0 + 1, None, None));
    assert_eq!(list[2].name, "New runtime");
    assert_ne!(tracker.begin_create("s", "", "T4", false, T0), id, "pending IDs are unique");
}

#[test]
fn a_failed_create_stays_as_an_error_until_dismissed() {
    let tracker = Tracker::default();
    let id = tracker.begin_create("s", "x", "H100", false, T0);
    tracker.finish_create("s", &id, Err("Google Colab refused the runtime."), T0 + 5);
    let list = tracker.snapshot("s");
    assert_eq!((list[0].state.as_str(), list[0].error.as_deref(), list[0].busy_since), ("error", Some("Google Colab refused the runtime."), None));
    tracker.dismiss("s", &id, &list).unwrap();
    assert!(tracker.snapshot("s").is_empty());
    assert!(tracker.dismiss("s", &id, &[]).is_err(), "nothing left to dismiss");
}

#[test]
fn busy_runs_end_ready_and_overlapping_ones_wait_for_the_last() {
    let tracker = Tracker::default();
    let first = tracker.begin_busy("s", "ep", &info("box", "T4 GPU"), "busy", "Running Python", T0);
    let second = tracker.begin_busy("s", "ep", &info("box", "T4 GPU"), "busy", "Running shell command", T0 + 10);
    assert_ne!(first, second, "operation IDs are unique");
    let entry = tracker.snapshot("s")[0].clone();
    assert_eq!((entry.state.as_str(), entry.activity.as_deref(), entry.busy_since), ("busy", Some("Running shell command"), Some(T0 + 10)));
    tracker.finish_busy("s", "ep", first, Ok(()));
    let entry = tracker.snapshot("s")[0].clone();
    assert_eq!((entry.state.as_str(), entry.activity.as_deref(), entry.busy_since), ("busy", Some("Running shell command"), Some(T0 + 10)), "the newest operation still shows");
    tracker.finish_busy("s", "ep", second, Err("exit 1"));
    let entry = tracker.snapshot("s")[0].clone();
    assert_eq!((entry.state.as_str(), entry.activity, entry.busy_since, entry.error), ("ready", None, None, None), "an ordinary failure leaves it ready");
    assert_eq!(tracker.snapshot("s").len(), 1, "one entry per runtime");
}

#[test]
fn a_short_overlapping_operation_hands_the_label_back_to_the_long_one() {
    let tracker = Tracker::default();
    let long = tracker.begin_busy("s", "ep", &info("box", "CPU"), "busy", "Running Python", T0);
    let short = tracker.begin_busy("s", "ep", &info("box", "CPU"), "busy", "Listing files", T0 + 5);
    tracker.finish_busy("s", "ep", short, Ok(()));
    let entry = tracker.snapshot("s")[0].clone();
    assert_eq!((entry.state.as_str(), entry.activity.as_deref(), entry.busy_since), ("busy", Some("Running Python"), Some(T0)));
    let restart = tracker.begin_busy("s", "ep", &info("box", "CPU"), "restarting", "Restarting kernel…", T0 + 9);
    tracker.finish_busy("s", "ep", restart, Err("Jupyter refused"));
    assert_eq!(tracker.snapshot("s")[0].activity.as_deref(), Some("Running Python"));
    tracker.finish_busy("s", "ep", long, Ok(()));
    assert_eq!(tracker.snapshot("s")[0].state, "ready");
    tracker.finish_busy("s", "ep", long, Ok(()));
    assert_eq!(tracker.snapshot("s")[0].state, "ready", "finishing twice is harmless");
}

#[test]
fn only_a_vanished_runtime_reads_as_an_error() {
    let tracker = Tracker::default();
    let a = tracker.begin_busy("s", "ep", &info("box", "CPU"), "busy", "Running Python", T0);
    tracker.begin_busy("s", "ep", &info("box", "CPU"), "busy", "Listing files", T0);
    tracker.finish_busy("s", "ep", a, Err(&format!("{}{}", crate::cloud::colab::MACHINE_GONE, crate::cloud::colab::GONE)));
    let entry = tracker.snapshot("s")[0].clone();
    assert_eq!((entry.state.as_str(), entry.error.as_deref(), entry.busy_since), ("error", Some(crate::cloud::colab::GONE), None));
    // A transient restart failure leaves a still-living (billing) runtime ready, not
    // dismissable.
    let restart = tracker.begin_busy("s", "ep2", &info("b", "CPU"), "restarting", "Restarting kernel…", T0);
    tracker.finish_busy("s", "ep2", restart, Err("Jupyter refused"));
    let entry = tracker.snapshot("s")[1].clone();
    assert_eq!((entry.state.as_str(), entry.error.clone()), ("ready", None));
    assert!(tracker.dismiss("s", "ep2", &tracker.snapshot("s")).is_err());
    tracker.finish_busy("s", "missing", 999, Ok(()));
    assert_eq!(tracker.snapshot("s").len(), 2, "finishing never adds an entry");
}

#[test]
fn a_late_finish_never_revives_a_stopped_or_failed_runtime() {
    let tracker = Tracker::default();
    let op = tracker.begin_busy("s", "ep", &info("box", "CPU"), "busy", "Running Python", T0);
    tracker.reconcile("s", &Records::new(), u64::MAX);
    tracker.finish_busy("s", "ep", op, Ok(()));
    let entry = tracker.snapshot("s")[0].clone();
    assert_eq!((entry.state.as_str(), entry.browser_url.clone()), ("stopped", None), "a stopped runtime has no browser link");
    let a = tracker.begin_busy("s", "ep2", &info("b", "CPU"), "busy", "Running Python", T0);
    let b = tracker.begin_busy("s", "ep2", &info("b", "CPU"), "busy", "Listing files", T0);
    tracker.set_state("s", "ep2", &info("b", "CPU"), ("error", None, Some("broken")), T0);
    tracker.finish_busy("s", "ep2", a, Ok(()));
    tracker.finish_busy("s", "ep2", b, Ok(()));
    assert_eq!(tracker.snapshot("s")[1].state, "error");
    let gone = tracker.begin_busy("s", "ep3", &info("c", "CPU"), "busy", "Running Python", T0);
    tracker.set_state("s", "ep3", &info("c", "CPU"), ("stopped", Some(ENDED), None), T0);
    tracker.finish_busy("s", "ep3", gone, Err(&format!("{}{}", crate::cloud::colab::MACHINE_GONE, crate::cloud::colab::GONE)));
    assert_eq!(tracker.snapshot("s")[2].state, "stopped");
    // An operation still registered when its runtime reads stopped (a refresh adopted it).
    let late = tracker.begin_busy("t", "ep", &info("box", "CPU"), "busy", "Running Python", T0);
    let mut stopped = tracker.snapshot("t")[0].clone();
    assert!(reconcile_entry(&mut stopped, &Records::new(), u64::MAX));
    tracker.adopt("t", stopped);
    tracker.finish_busy("t", "ep", late, Ok(()));
    assert_eq!(tracker.snapshot("t")[0].state, "stopped", "never back to ready");
}

#[test]
fn a_deleted_thread_is_forgotten() {
    let tracker = Tracker::default();
    let op = tracker.begin_busy("s", "ep", &info("box", "CPU"), "busy", "Running Python", T0);
    tracker.begin_busy("other", "ep", &info("box", "CPU"), "busy", "Running Python", T0);
    let shown = tracker.merge("s", from_cloud(&agent("error", Some("colab:agent"), None), &info("a", "CPU"), T0), T0);
    tracker.dismiss("s", "colab:agent", &shown).unwrap();
    let pending = tracker.begin_create("s", "late", "T4", false, T0);
    tracker.forget("s");
    assert!(tracker.snapshot("s").is_empty());
    assert!(tracker.is_forgotten("s") && !tracker.is_forgotten("other"));
    // Tool calls that finish (or start) after the thread was deleted leave no ghost entry.
    tracker.finish_busy("s", "ep", op, Ok(()));
    tracker.finish_create("s", &pending, Ok(("ep-new", &info("late", "T4 GPU"))), T0);
    tracker.begin_busy("s", "ep", &info("box", "CPU"), "busy", "Running Python", T0);
    tracker.begin_create("s", "again", "T4", false, T0);
    tracker.reconcile("s", &Records::new(), u64::MAX);
    tracker.adopt_saved("s", vec![ready_entry("saved", &info("saved", "CPU"), T0)]);
    assert!(tracker.snapshot("s").is_empty(), "nothing brings it back");
    assert!(tracker.merge("s", from_cloud(&agent("error", Some("colab:agent"), None), &info("a", "CPU"), T0), T0).is_empty(), "a deleted thread lists nothing");
    assert_eq!(tracker.snapshot("other")[0].state, "busy", "other threads keep theirs");
}

#[test]
fn a_thread_shows_only_its_own_endpoints() {
    let tracker = Tracker::default();
    tracker.begin_busy("s", "ep", &info("box", "CPU"), "busy", "Running Python", T0);
    let pending = tracker.begin_create("s", "new", "T4", false, T0);
    let list = tracker.snapshot("s");
    assert!(shown(&list, "ep"));
    assert!(!shown(&list, "elsewhere"));
    assert!(!shown(&list, ""), "a pending entry has no endpoint to act on");
    assert!(!shown(&list, &pending));
    // A stopped runtime is still listed but has nothing left to act on.
    tracker.set_state("s", "ep", &info("box", "CPU"), ("stopped", Some(ENDED), None), T0);
    let list = tracker.snapshot("s");
    assert!(list.iter().any(|r| r.endpoint == "ep" && r.state == "stopped"));
    assert!(!shown(&list, "ep"), "a stopped runtime is refused");
}

#[test]
fn a_deleted_threads_runtime_can_be_claimed_by_another_thread() {
    let dir = std::env::temp_dir().join(format!("pandacode-colab-forget-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join(store::SESSIONS_FILE);
    let mut mine = record("ep", "T4", "STANDARD");
    mine.session_id = Some("deleted".into());
    let mut theirs = record("ep-2", "CPU", "STANDARD");
    theirs.session_id = Some("kept".into());
    store::update(&path, |_| (records(&[mine, theirs]), ())).unwrap();
    assert!(!store::claim(&path, "ep", "next").unwrap(), "claimed while its thread exists");
    // A thread that owned nothing leaves the file alone.
    let before = std::fs::read(&path).unwrap();
    disown_saved(&path, &["unrelated".into()]).unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), before);
    disown_saved(&path, &["deleted".into()]).unwrap();
    let saved = store::load(&path);
    assert!(saved_for(&saved, "deleted", T0).is_empty(), "the deleted thread holds nothing");
    assert_eq!(states(&saved_for(&saved, "kept", T0)), vec![("colab:ep-2".into(), "ready".into())]);
    // The second thread claims it, and it returns for that thread after a restart.
    assert!(store::claim(&path, "ep", "next").unwrap());
    let tracker = Tracker::default();
    tracker.adopt_saved("next", saved_for(&store::load(&path), "next", T0));
    assert_eq!(states(&tracker.merge("next", None, T0)), vec![("colab:ep".into(), "ready".into())]);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn stopping_releases_the_runtime_from_every_thread() {
    let tracker = Tracker::default();
    let op = tracker.begin_busy("a", "ep", &info("box", "CPU"), "busy", "Running Python", T0);
    tracker.set_state("b", "ep", &info("box", "CPU"), ("stopping", Some("Releasing runtime…"), None), T0);
    tracker.set_state("b", "other", &info("o", "CPU"), ("ready", None, None), T0);
    assert_eq!(tracker.snapshot("b")[0].busy_since, Some(T0));
    assert_eq!(tracker.release("ep"), vec!["a".to_string(), "b".to_string()]);
    assert!(tracker.snapshot("a").is_empty());
    assert_eq!(states(&tracker.snapshot("b")), vec![("colab:other".into(), "ready".into())]);
    tracker.finish_busy("a", "ep", op, Ok(()));
    assert!(tracker.snapshot("a").is_empty(), "a late finish does not bring it back");
    tracker.remove("b", "other");
    assert!(tracker.snapshot("b").is_empty());
}

#[test]
fn threads_are_isolated() {
    let tracker = Tracker::default();
    let id = tracker.begin_create("a", "one", "T4", false, T0);
    let op = tracker.begin_busy("b", "ep", &info("two", "CPU"), "busy", "Running shell command", T0);
    tracker.finish_create("b", &id, Err("wrong thread"), T0);
    assert_eq!(tracker.snapshot("a")[0].state, "creating");
    tracker.finish_busy("a", "ep", op, Ok(()));
    assert_eq!(tracker.snapshot("b")[0].state, "busy");
    assert!(tracker.snapshot("c").is_empty());
}

#[test]
fn only_finished_entries_can_be_dismissed() {
    let tracker = Tracker::default();
    tracker.set_state("s", "ep", &info("box", "CPU"), ("ready", None, None), T0);
    let shown = tracker.snapshot("s");
    assert!(tracker.dismiss("s", "ep", &shown).unwrap_err().contains("stop it"));
    tracker.set_state("s", "ep", &info("box", "CPU"), ("stopped", Some(ENDED), None), T0);
    tracker.dismiss("s", "colab:ep", &tracker.snapshot("s")).unwrap();
    assert!(tracker.snapshot("s").is_empty());
}

#[test]
fn reconciling_updates_hardware_and_marks_vanished_runtimes_stopped() {
    let tracker = Tracker::default();
    let op = tracker.begin_busy("s", "alive", &info("alive", ""), "busy", "Running Python", T0);
    tracker.set_state("s", "gone", &info("mine", "CPU"), ("ready", None, None), T0);
    let pending = tracker.begin_create("s", "new", "T4", false, T0);
    tracker.reconcile("s", &records(&[record("alive", "L4", "HIGH_RAM")]), u64::MAX);
    let list = tracker.snapshot("s");
    assert_eq!((list[0].hardware.as_str(), list[0].high_mem, list[0].name.as_str(), list[0].state.as_str()), ("L4 GPU", true, "alive-name", "busy"));
    assert_eq!((list[1].state.as_str(), list[1].activity.as_deref(), list[1].name.as_str(), list[1].browser_url.clone()), ("stopped", Some(ENDED), "mine", None));
    assert_eq!((list[2].id.as_str(), list[2].state.as_str()), (pending.as_str(), "creating"), "a pending entry has nothing to reconcile");
    tracker.finish_busy("s", "alive", op, Ok(()));
    assert_eq!(tracker.snapshot("s")[0].state, "ready");
}

#[test]
fn cloud_agent_stages_map_to_runtime_states() {
    let info = info("pc-abc", "T4 GPU");
    let cases = [
        ("creating", None, "creating", Some("Allocating runtime…"), None),
        ("installing", Some("Installing codex…"), "busy", Some("Installing codex…"), None),
        ("credentials", None, "busy", Some("Signing in…"), None),
        ("uploading", None, "busy", Some("Uploading the checkout…"), None),
        ("running", None, "busy", Some("Agent running"), None),
        ("syncing", None, "busy", Some("Bringing changes back…"), None),
        ("ready", Some("note"), "ready", None, None),
        ("stopped", Some("Your next message starts it again."), "stopped", None, None),
        ("error", Some("machine-gone: That Colab runtime no longer exists. Create a new one."), "error", None, Some("That Colab runtime no longer exists. Create a new one.")),
    ];
    for (stage, detail, state, activity, error) in cases {
        let runtime = from_cloud(&agent(stage, Some("colab:ep-1"), detail), &info, T0).unwrap();
        assert_eq!((runtime.state.as_str(), runtime.activity.as_deref(), runtime.error.as_deref()), (state, activity, error), "{stage}");
        assert_eq!(runtime.busy_since.is_some(), BUSY_STATES.contains(&state), "{stage}");
        let expected = if stage == "creating" { (AGENT_PENDING, "") } else { ("colab:ep-1", "ep-1") };
        assert_eq!((runtime.id.as_str(), runtime.endpoint.as_str()), expected, "{stage}");
        assert_eq!(runtime.browser_url.is_some(), !matches!(stage, "creating" | "stopped"), "{stage}");
    }
    let pending = from_cloud(&agent("creating", None, Some("Creating a Google Colab machine…")), &info, T0).unwrap();
    assert_eq!((pending.id.as_str(), pending.endpoint.as_str(), pending.browser_url.clone()), (AGENT_PENDING, "", None));
    // Re-creating: the released old machine is still on the state, but it is never shown.
    let old = Info { started_at: Some(T0 - 60_000), ..info.clone() };
    let recreating = from_cloud(&agent("creating", Some("colab:old"), None), &old, T0).unwrap();
    assert_eq!((recreating.id.as_str(), recreating.endpoint.as_str(), recreating.browser_url.clone(), recreating.started_at), (AGENT_PENDING, "", None, T0));
    assert!(from_cloud(&agent("stopped", None, None), &info, T0).is_none(), "a deleted machine shows nothing");
    let other = crate::cloud_agents::State { provider: "e2b".into(), machine: Some("e2b:x".into()), stage: "running".into(), ..Default::default() };
    assert!(from_cloud(&other, &info, T0).is_none());
}

#[test]
fn the_cloud_agent_runtime_joins_the_list_and_keeps_its_timestamps() {
    let tracker = Tracker::default();
    let info = info("pc-abc", "CPU");
    let first = from_cloud(&agent("running", Some("colab:ep"), None), &info, T0);
    assert_eq!(states(&tracker.merge("s", first, T0)), vec![("colab:ep".into(), "busy".into())]);
    let later = from_cloud(&agent("running", Some("colab:ep"), None), &info, T0 + 9_000);
    let list = tracker.merge("s", later, T0 + 9_000);
    assert_eq!((list[0].started_at, list[0].busy_since), (T0, Some(T0)), "the same stage keeps when it began");
    // A tracked, idle entry for the same runtime yields to the agent's state.
    tracker.set_state("s", "ep", &info, ("ready", None, None), T0);
    let list = tracker.merge("s", from_cloud(&agent("syncing", Some("colab:ep"), None), &info, T0 + 10_000), T0 + 10_000);
    assert_eq!(states(&list), vec![("colab:ep".into(), "busy".into())]);
    assert_eq!(list[0].busy_since, Some(T0 + 10_000), "a new stage starts its own clock");
    tracker.remove("s", "ep");
    assert!(tracker.merge("s", None, T0).is_empty());
}

#[test]
fn a_dismissed_cloud_agent_entry_returns_only_in_a_new_state() {
    let tracker = Tracker::default();
    let info = info("pc-abc", "CPU");
    let failed = || from_cloud(&agent("error", Some("colab:ep"), Some("boom")), &info, T0);
    let shown = tracker.merge("s", failed(), T0);
    tracker.dismiss("s", "colab:ep", &shown).unwrap();
    assert!(tracker.merge("s", failed(), T0).is_empty());
    assert_eq!(states(&tracker.merge("s", from_cloud(&agent("creating", Some("colab:ep"), None), &info, T0), T0)), vec![(AGENT_PENDING.into(), "creating".into())]);
    let running = tracker.merge("s", from_cloud(&agent("running", Some("colab:ep"), None), &info, T0), T0);
    assert!(tracker.dismiss("s", "colab:ep", &running).is_err(), "a running agent's runtime is not dismissed");
}

#[test]
fn a_vanished_cloud_agent_runtime_reads_as_stopped() {
    let mut runtime = from_cloud(&agent("ready", Some("colab:ep"), None), &info("pc", "CPU"), T0).unwrap();
    assert!(reconcile_entry(&mut runtime, &Records::new(), u64::MAX));
    assert_eq!((runtime.state.as_str(), runtime.activity.as_deref()), ("stopped", Some(ENDED)));
    assert!(!reconcile_entry(&mut runtime, &Records::new(), u64::MAX), "already stopped");
    let mut alive = from_cloud(&agent("running", Some("colab:ep"), None), &info("pc", ""), T0).unwrap();
    assert!(reconcile_entry(&mut alive, &records(&[record("ep", "V6E1", "STANDARD")]), u64::MAX));
    assert_eq!((alive.hardware.as_str(), alive.state.as_str(), alive.name.as_str()), ("v6e-1 TPU", "busy", "pc"));
}

#[test]
fn info_comes_from_the_local_record() {
    let info = Info::from_record(&record("ep", "A100", "HIGH_RAM"));
    assert_eq!(info, Info { name: "ep-name".into(), hardware: "A100 GPU".into(), high_mem: true, started_at: Some(1_700_000_000_000) });
    let bare = Info::from_record(&SessionRecord { endpoint: "ep".into(), ..SessionRecord::default() });
    assert_eq!((bare.name.as_str(), bare.hardware.as_str(), bare.started_at), ("ep", "CPU", None));
}

#[test]
fn dismissing_an_agent_error_after_a_kernel_restart_stays_dismissed() {
    let tracker = Tracker::default();
    let info = info("pc", "CPU");
    let restart = tracker.begin_busy("s", "ep", &info, "restarting", "Restarting kernel…", T0);
    tracker.finish_busy("s", "ep", restart, Ok(()));
    let failed = || from_cloud(&agent("error", Some("colab:ep"), Some("boom")), &info, T0);
    let shown = tracker.merge("s", failed(), T0);
    assert_eq!(states(&shown), vec![("colab:ep".into(), "error".into())], "the agent's error replaces the idle entry");
    tracker.dismiss("s", "colab:ep", &shown).unwrap();
    assert!(tracker.snapshot("s").is_empty());
    assert!(tracker.merge("s", failed(), T0 + 1).is_empty(), "the task's state does not bring it back");
}

#[test]
fn dismissing_a_vanished_agent_runtime_never_reverts_to_ready() {
    let tracker = Tracker::default();
    let info = info("pc", "CPU");
    let idle = || from_cloud(&agent("ready", Some("colab:ep"), None), &info, T0);
    // A refresh finds the runtime gone and adopts it as stopped, as `reconcile_live` does.
    let mut stopped = tracker.merge("s", idle(), T0)[0].clone();
    assert!(reconcile_entry(&mut stopped, &Records::new(), u64::MAX));
    tracker.adopt("s", stopped);
    let shown = tracker.merge("s", idle(), T0);
    assert_eq!(states(&shown), vec![("colab:ep".into(), "stopped".into())]);
    tracker.dismiss("s", "colab:ep", &shown).unwrap();
    assert!(tracker.merge("s", idle(), T0 + 1).is_empty(), "it does not come back as ready");
    let next = tracker.merge("s", from_cloud(&agent("running", Some("colab:new"), None), &info, T0 + 2), T0 + 2);
    assert_eq!(states(&next), vec![("colab:new".into(), "busy".into())], "the next run shows");
}

#[test]
fn a_dismissed_error_does_not_hide_the_next_runs_error() {
    let tracker = Tracker::default();
    let info = info("pc", "CPU");
    let failed = || from_cloud(&agent("error", Some("colab:ep"), Some("boom")), &info, T0);
    let shown = tracker.merge("s", failed(), T0);
    tracker.dismiss("s", "colab:ep", &shown).unwrap();
    assert!(tracker.merge("s", failed(), T0).is_empty());
    tracker.merge("s", from_cloud(&agent("creating", Some("colab:ep"), None), &info, T0 + 1), T0 + 1);
    tracker.merge("s", from_cloud(&agent("running", Some("colab:ep"), None), &info, T0 + 2), T0 + 2);
    let again = tracker.merge("s", from_cloud(&agent("error", Some("colab:ep"), Some("boom again")), &info, T0 + 3), T0 + 3);
    assert_eq!(states(&again), vec![("colab:ep".into(), "error".into())]);
    assert_eq!(again[0].error.as_deref(), Some("boom again"));
    // A re-create that fails before a new machine exists still shows its error.
    let shown = tracker.merge("s", failed(), T0 + 4);
    tracker.dismiss("s", "colab:ep", &shown).unwrap();
    tracker.merge("s", from_cloud(&agent("creating", Some("colab:ep"), None), &info, T0 + 5), T0 + 5);
    assert_eq!(states(&tracker.merge("s", failed(), T0 + 6)), vec![("colab:ep".into(), "error".into())]);
}

#[test]
fn every_surface_spells_tpus_the_same_way() {
    assert_eq!(crate::cloud::colab::hardware_label("V5E1"), "v5e-1 TPU");
    assert_eq!(Info::from_record(&record("ep", "V5E1", "HIGH_RAM")).hardware, "v5e-1 TPU");
    assert!(crate::cloud::colab::machine(&record("ep", "V5E1", "HIGH_RAM")).detail.contains("v5e-1 TPU"));
}

#[test]
fn a_released_runtime_keeps_its_last_known_name_and_hardware() {
    let tracker = Tracker::default();
    let live = records(&[record("ep", "T4", "HIGH_RAM")]);
    assert_eq!(tracker.info_for("ep", &live).hardware, "T4 GPU");
    // Colab's record is gone once the runtime was released (`unassign`).
    let gone = tracker.info_for("ep", &Records::new());
    assert_eq!(gone, Info { name: "ep-name".into(), hardware: "T4 GPU".into(), high_mem: true, started_at: Some(1_700_000_000_000) });
    let stopped = from_cloud(&agent("stopped", Some("colab:ep"), None), &gone, T0).unwrap();
    assert_eq!((stopped.name.as_str(), stopped.hardware.as_str(), stopped.high_mem, stopped.started_at), ("ep-name", "T4 GPU", true, 1_700_000_000_000));
    // A never-seen runtime falls back to its endpoint.
    assert_eq!(tracker.info_for("never", &Records::new()), Info { name: "never".into(), ..Info::default() });
    // A created runtime is remembered from its pending entry, and a bare guess never
    // overwrites what is known.
    let id = tracker.begin_create("s", "trainer", "A100", true, T0);
    tracker.finish_create("s", &id, Ok(("ep-2", &Info::default())), T0 + 5);
    let created = tracker.info_for("ep-2", &Records::new());
    assert_eq!((created.name.as_str(), created.hardware.as_str(), created.high_mem, created.started_at), ("trainer", "A100 GPU", true, Some(T0)));
    tracker.begin_busy("s", "ep-2", &Info { name: "ep-2".into(), ..Info::default() }, "busy", "Running Python", T0);
    assert_eq!(tracker.info_for("ep-2", &Records::new()).hardware, "A100 GPU");
    // A refresh teaches it too.
    tracker.reconcile("s", &records(&[record("ep-3", "L4", "HIGH_RAM")]), u64::MAX);
    assert_eq!(tracker.info_for("ep-3", &Records::new()).hardware, "L4 GPU");
}

#[test]
fn a_threads_saved_runtimes_return_after_a_restart() {
    let mut mine = record("ep", "T4", "STANDARD");
    mine.session_id = Some("s".into());
    let mut theirs = record("ep-2", "CPU", "STANDARD");
    theirs.session_id = Some("t".into());
    let saved = records(&[mine.clone(), theirs, record("ep-3", "A100", "STANDARD")]);
    let list = saved_for(&saved, "s", T0);
    assert_eq!(states(&list), vec![("colab:ep".into(), "ready".into())], "only this thread's runtimes");
    assert_eq!((list[0].hardware.as_str(), list[0].started_at), ("T4 GPU", 1_700_000_000_000));
    // A new tracker stands for a restarted app.
    let tracker = Tracker::default();
    tracker.adopt_saved("s", list.clone());
    assert_eq!(states(&tracker.merge("s", None, T0)), vec![("colab:ep".into(), "ready".into())]);
    tracker.adopt_saved("s", list.clone());
    assert_eq!(tracker.snapshot("s").len(), 1, "adopted once");
    // Once removed (released or dismissed) it is not adopted again from the file.
    tracker.release("ep");
    tracker.adopt_saved("s", list);
    assert!(tracker.snapshot("s").is_empty());
    // A Colab list keeps the thread on the record.
    let assignment = serde_json::json!({"endpoint": "ep", "accelerator": "T4"});
    let next = crate::cloud::colab::reconcile(&records(&[mine]), &[assignment], 0, i64::MAX);
    assert_eq!(next["ep"].session_id.as_deref(), Some("s"));
}

#[test]
fn a_retried_agent_create_shows_after_its_failed_one_was_dismissed() {
    let tracker = Tracker::default();
    let info = info("pc", "CPU");
    let creating = || from_cloud(&agent("creating", None, None), &info, T0);
    let shown = tracker.merge("s", creating(), T0);
    assert_eq!(states(&shown), vec![(AGENT_PENDING.into(), "creating".into())]);
    tracker.dismiss("s", AGENT_PENDING, &shown).unwrap();
    assert!(tracker.merge("s", creating(), T0).is_empty());
    // The create failed before any machine existed: the task shows nothing for a while.
    assert!(tracker.merge("s", None, T0 + 1).is_empty());
    assert_eq!(states(&tracker.merge("s", creating(), T0 + 2)), vec![(AGENT_PENDING.into(), "creating".into())], "the retry shows");
}

#[test]
fn a_runtime_colab_still_has_is_never_hidden_by_a_stale_stop() {
    let tracker = Tracker::default();
    tracker.set_state("s", "ep", &info("box", "T4 GPU"), ("ready", None, None), T0);
    tracker.reconcile("s", &Records::new(), u64::MAX);
    let stopped = tracker.snapshot("s")[0].clone();
    assert_eq!((stopped.state.as_str(), stopped.browser_url.clone()), ("stopped", None));
    // A later list still has it: it is ready again, with its link.
    tracker.reconcile("s", &records(&[record("ep", "T4", "STANDARD")]), u64::MAX);
    let revived = tracker.snapshot("s")[0].clone();
    assert_eq!((revived.state.as_str(), revived.activity.clone(), revived.error.clone()), ("ready", None, None));
    assert!(revived.browser_url.unwrap().contains("ep"));
    // Marking an entry stopped clears an old error.
    tracker.set_state("s", "ep", &info("box", "T4 GPU"), ("error", None, Some("boom")), T0);
    tracker.reconcile("s", &Records::new(), u64::MAX);
    let entry = tracker.snapshot("s")[0].clone();
    assert_eq!((entry.state.as_str(), entry.error.clone()), ("stopped", None));
    // A Cloud Agent working on that runtime again replaces the stale entry, keeping its name.
    let list = tracker.merge("s", from_cloud(&agent("running", Some("colab:ep"), None), &info("pc", ""), T0 + 1), T0 + 1);
    assert_eq!(states(&list), vec![("colab:ep".into(), "busy".into())]);
    assert_eq!((list[0].name.as_str(), list[0].hardware.as_str()), ("box", "T4 GPU"));
    // An idle agent does not hide the stopped entry behind a ready one.
    let idle = tracker.merge("s", from_cloud(&agent("ready", Some("colab:ep"), None), &info("pc", ""), T0 + 2), T0 + 2);
    assert_eq!(states(&idle), vec![("colab:ep".into(), "stopped".into())]);
}

#[test]
fn a_refresh_never_stops_a_runtime_created_while_the_list_was_on_its_way() {
    let tracker = Tracker::default();
    let fetched_at = T0;
    // Its record (created after the list was asked for) dates the new runtime.
    let id = tracker.begin_create("s", "new", "T4", false, T0 - 30_000);
    tracker.finish_create("s", &id, Ok(("fresh", &Info { started_at: Some(T0 + 50), ..Info::default() })), T0 + 60);
    tracker.set_state("s", "old", &Info { started_at: Some(T0 - 5_000), ..info("old", "CPU") }, ("ready", None, None), T0);
    tracker.set_state("s", "late", &Info { started_at: Some(T0 + 20), ..info("late", "CPU") }, ("ready", None, None), T0);
    tracker.reconcile("s", &Records::new(), fetched_at);
    let list = tracker.snapshot("s");
    assert_eq!(states(&list), vec![("colab:fresh".into(), "ready".into()), ("colab:old".into(), "stopped".into()), ("colab:late".into(), "ready".into())]);
    // Record times are whole seconds: one dated just before the list may still be newer.
    let mut same_second = ready_entry("x", &Info { started_at: Some(T0 - 400), ..Info::default() }, T0);
    assert!(!reconcile_entry(&mut same_second, &Records::new(), fetched_at));
}

#[test]
fn only_a_live_runtime_can_be_acted_on() {
    let tracker = Tracker::default();
    tracker.set_state("s", "ep", &info("box", "CPU"), ("stopped", Some(ENDED), None), T0);
    tracker.set_state("s", "bad", &info("bad", "CPU"), ("error", None, Some("boom")), T0);
    tracker.set_state("s", "ok", &info("ok", "CPU"), ("ready", None, None), T0);
    let list = tracker.snapshot("s");
    assert!(!shown(&list, "ep"), "a stopped runtime has nothing to open, restart or stop");
    assert!(shown(&list, "bad") && shown(&list, "ok"));
}
