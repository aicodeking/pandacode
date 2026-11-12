use super::*;

#[test]
fn forget_drops_in_flight_briefs_of_deleted_teams_and_conversations_only() {
    let tag = uuid::Uuid::new_v4().simple().to_string();
    let id = |name: &str| format!("{name}-{tag}");
    let keys = [(id("team"), id("worker")), (id("other-team"), id("team")), (id("other-team"), id("kept"))];
    for (parent, sid) in &keys {
        unconfirmed().insert((parent.clone(), sid.clone()), 1);
        brief_pending(parent, sid, briefing::Briefing::default());
        pending_cursors().insert((parent.clone(), sid.clone()), ("actor".into(), 1));
    }
    forget(&[id("team")]);
    for (index, key) in keys.iter().enumerate() {
        let kept = index == 2;
        assert_eq!(unconfirmed().contains_key(key), kept);
        assert_eq!(pending_briefings().contains_key(key), kept);
        assert_eq!(pending_cursors().contains_key(key), kept);
    }
    forget(&[id("kept")]);
}

const FULL_RULES: &str = "You are a PandaCode worker named Writer.";
const REMINDER: &str = "You are still the PandaCode worker named Writer.";

fn worker(session_id: &str) -> Worker {
    Worker {
        id: "w1".into(),
        session_id: session_id.into(),
        name: "Writer".into(),
        profile_id: "fast".into(),
        provider: "codex".into(),
        model: "default".into(),
        reasoning_effort: None,
        status: "running".into(),
        assignment: "Small task".into(),
        summary: String::new(),
        error: None,
        depends_on: vec![],
        files: vec![],
        read_only: false,
        attempt: 1,
        created_at: 1,
        updated_at: 1,
        keys: vec!["key-w1".into()],
        abandoned: false,
        result_revision: 0,
        checkpoint: None,
        timed_out: false,
        failovers: 0,
        resume_prompt: None,
        tool_catalog_version: TOOL_CATALOG_VERSION,
        parent_worker: None,
        token_saver: Default::default(),
    }
}

/// A team with one worker on a resumed conversation.
fn team_state() -> (AppState, String, Admission) {
    let store = Store::open(std::path::Path::new(":memory:")).unwrap();
    let project = store.add_project(&std::env::temp_dir()).unwrap();
    let parent = store.create_session(&project.id, "claude", "default", "ask").unwrap().id;
    let sid = store.create_session(&project.id, "codex", "default", "ask").unwrap().id;
    store.db.execute("UPDATE sessions SET resume_id='native-1' WHERE id=?1", [&sid]).unwrap();
    let mut team = new_team(parent.clone(), TeamConfig { auto: false, roster_only: false, name: None, workers: vec![], catalog: vec![], max_parallel: 3, max_rounds: 5, max_assignments: 10, workspace: "shared".into(), summary_limit: 2000, lead_guidance: None });
    team.generation = 1;
    team.status = "running".into();
    team.workers.push(worker(&sid));
    save(&store, &mut team).unwrap();
    let state = AppState {
        store: Arc::new(std::sync::Mutex::new(store)),
        agents: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
        terminals: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
        shutdown: std::sync::atomic::AtomicU8::new(0),
    };
    (state, sid, Admission { parent, generation: 1 })
}

fn compaction(state: &AppState, sid: &str, id: &str) {
    crate::save_compaction(&state.store.lock().unwrap(), sid, id);
}

fn brief(state: &AppState, sid: &str, admission: &Admission) -> String {
    prompt(&state.store.lock().unwrap(), sid, "Continue", Some(admission)).unwrap()
}

/// How a run's end reaches the team: `successful` is a clean end.
fn ended(state: &AppState, sid: &str, admission: &Admission, successful: bool, stopped: bool) {
    completed_state(state, sid, Some(admission), successful, stopped, &mut |_| {});
}

#[test]
fn a_failed_launch_leaves_the_compaction_due_for_the_retry() {
    let (state, sid, admission) = team_state();
    assert!(brief(&state, &sid, &admission).contains(FULL_RULES));
    ended(&state, &sid, &admission, true, false);
    assert!(brief(&state, &sid, &admission).contains(REMINDER), "an ordinary resumed turn");
    ended(&state, &sid, &admission, true, false);

    compaction(&state, &sid, "compaction:1");
    assert!(brief(&state, &sid, &admission).contains(FULL_RULES));
    ended(&state, &sid, &admission, false, false);
    assert!(brief(&state, &sid, &admission).contains(FULL_RULES), "a failed launch is retried in full");
    ended(&state, &sid, &admission, false, true);
    assert!(brief(&state, &sid, &admission).contains(FULL_RULES), "so is a stopped one");
    ended(&state, &sid, &admission, true, false);
    let after = brief(&state, &sid, &admission);
    assert!(after.contains(REMINDER) && !after.contains(FULL_RULES), "a clean end answers it: {after}");
    ended(&state, &sid, &admission, true, false);
}

#[test]
fn only_a_clean_end_saves_the_mark() {
    let (state, sid, admission) = team_state();
    let parent = admission.parent.clone();
    brief(&state, &sid, &admission);
    ended(&state, &sid, &admission, true, false);
    compaction(&state, &sid, "compaction:1");
    brief(&state, &sid, &admission);
    // A restart during the launch loses what was unconfirmed, and the compaction is still due.
    brief_refused(&parent, &sid);
    let store = state.store.lock().unwrap();
    assert!(compacted(&store, &parent, &sid).unwrap());
    drop(store);
    brief(&state, &sid, &admission);
    // A compaction during the clean run is newer than the mark, so it counts next turn.
    compaction(&state, &sid, "compaction:2");
    ended(&state, &sid, &admission, true, false);
    assert!(compacted(&state.store.lock().unwrap(), &parent, &sid).unwrap());
    assert!(unconfirmed().get(&(parent, sid)).is_none(), "nothing stays behind");
}

#[test]
fn workers_hear_about_skills_only_while_the_setting_is_off() {
    assert!(!worker_skills_clause(true).contains("Skill"));
    let clause = worker_skills_clause(false);
    assert!(clause.contains("no Skill tool") && clause.len() < 100, "{clause}");
    let (state, sid, admission) = team_state();
    let team = load(&state.store.lock().unwrap(), &admission.parent).unwrap().unwrap();
    let rules = worker_rules(&team, &sid, false).unwrap().text;
    assert!(rules.contains(clause), "{rules}");
    let rules = worker_rules(&team, &sid, true).unwrap().text;
    assert!(!rules.contains("Skill"), "{rules}");
    // The setting is on unless its off marker is known to exist.
    assert!(worker_skills_from(Ok(false)));
    assert!(worker_skills_from(Err("unreadable".into())));
    assert!(!worker_skills_from(Ok(true)));
}

#[test]
fn a_launch_end_without_the_store_refuses_its_brief() {
    let (state, sid, admission) = team_state();
    let key = (admission.parent.clone(), sid.clone());
    unconfirmed().insert(key.clone(), 1);
    brief_pending(&admission.parent, &sid, briefing::Briefing::default());
    pending_cursors().insert(key.clone(), ("w1".into(), 1));
    let store = state.store.clone();
    let _ = std::thread::spawn(move || {
        let _guard = store.lock().unwrap();
        panic!("poison the store lock");
    })
    .join();
    assert!(state.store.lock().is_err());
    completed_state(&state, &sid, Some(&admission), true, false, &mut |_| {});
    assert!(!unconfirmed().contains_key(&key));
    assert!(!pending_briefings().contains_key(&key));
    assert!(!pending_cursors().contains_key(&key));
}
