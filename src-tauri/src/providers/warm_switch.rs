//! Live switches of a waiting Claude agent: a model, effort or permission-mode change is sent
//! as stream-json control requests instead of restarting the CLI (`switchable`). A switch
//! only writes its requests (`switch`), so the agent is ready for a send at once, even while
//! the CLI is still starting; the adopting run waits for the replies before its first message.
//! One switch runs at a time per task, and a switch landing while the turn-end prewarm is
//! still spawning waits for that agent, so a task never gets a second CLI.
use super::*;

/// Writing a switch's requests gives up after this (a full input pipe); the agent restarts.
const SWITCH: Duration = Duration::from_secs(2);
/// A switch waits at most this long for another switch, or for the agent being spawned; so
/// does a send for an agent being spawned or switched.
pub(super) const SPAWN: Duration = Duration::from_secs(3);
/// Tasks whose agent is being switched right now.
static SWITCHING: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(Default::default);

/// The task's one switch in flight; ends (and wakes a newer switch) when dropped.
struct Switching(String);

impl Drop for Switching {
    fn drop(&mut self) {
        SWITCHING.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).remove(&self.0);
        changed();
    }
}

/// The task's agent is being switched right now.
pub(super) fn in_flight(session_id: &str) -> bool {
    SWITCHING.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).contains(session_id)
}

fn claim_switch(session_id: &str) -> Option<Switching> {
    SWITCHING.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).insert(session_id.to_owned()).then(|| Switching(session_id.to_owned()))
}

/// The task's model, effort, permissions or harness changed after its turn ended: switch its
/// warm agent (or the one still starting) to the new settings, for the same launch. A task
/// that left Claude keeps its agent until the other harness starts one (one spare per task);
/// its inputs stay, so switching back reuses the agent or starts a new one. Returns without
/// waiting for the agent, and `false` when the task has no current inputs.
pub fn retarget(session: &crate::storage::Session) -> bool {
    let job = retargeted(&session.id, |config| {
        config.provider = session.provider.clone();
        config.model = session.model.clone();
        config.reasoning_effort = session.reasoning_effort.clone();
        config.mode = session.mode.clone();
        config.resume_id = session.resume_id.clone();
    });
    let Some(job) = job else { return false };
    if let Some(job) = job {
        tauri::async_runtime::spawn(async move {
            debounce(&job.config.session_id).await;
            if let Err(error) = switch_or_start(job).await {
                eprintln!("Could not prepare a warm Claude agent: {error}");
            }
        });
    }
    true
}

pub(super) struct Job {
    pub(super) config: RunConfig,
    pub(super) tools: Vec<Value>,
    approval_tools: HashSet<String>,
    pub(super) launch: u64,
    pub(super) generation: u64,
}

/// Replace the task's prewarm inputs with the new settings under a fresh generation, so an
/// older prewarm still starting can no longer insert its spare. `None`: no current inputs
/// (none, or stale); `Some(None)`: nothing to start (unchanged, or no longer Claude).
pub(super) fn retargeted(session_id: &str, apply: impl FnOnce(&mut RunConfig)) -> Option<Option<Job>> {
    let mut targets = targets();
    let target = targets.get_mut(session_id)?;
    // A newer launch already began: these inputs describe an older conversation. Not
    // retargeted, so the caller starts afresh from the task's row.
    if epoch(session_id) != target.launch {
        targets.remove(session_id);
        drop(targets);
        spares().remove(session_id);
        changed();
        return None;
    }
    let mut config = target.config.clone();
    apply(&mut config);
    let launch_of = |c: &RunConfig| (c.provider.clone(), c.model.clone(), c.reasoning_effort.clone(), c.mode.clone(), c.resume_id.clone());
    // The same settings picked again: keep the agent that already has them.
    if launch_of(&config) == launch_of(&target.config) {
        return Some(None);
    }
    target.config = config;
    // Any prewarm still starting or debouncing now holds an older generation.
    target.generation = next_generation();
    target.key = None;
    target.busy = supported(&target.config);
    let job = target.busy.then(|| Job {
        config: target.config.clone(),
        tools: target.tools.clone(),
        approval_tools: target.approval_tools.clone(),
        launch: target.launch,
        generation: target.generation,
    });
    // A task that left Claude keeps its agent until the other harness's start begins (after
    // its debounce: `warm::other_start`) or a launch happens (`warm::launched`). Picking Claude
    // again before then cancels that pending start (`warm_launch::plan_rewarm`) and keeps the
    // agent.
    drop(targets);
    changed();
    Some(job)
}

/// Switch the live agent in place when only settings it can change live differ (or keep it
/// when nothing in its launch did); otherwise, or if the switch fails, start a new one. The
/// launch is keyed once, here.
pub(super) async fn switch_or_start(job: Job) -> Result<(), String> {
    let session_id = job.config.session_id.clone();
    // A newer switch, a send or a discard came in during the debounce.
    if !current(&session_id, job.generation) {
        return Ok(());
    }
    // The pick back to Claude stood: the task's Codex or ACP spare goes (one spare per task).
    super::super::handshake_warm::other_start(&session_id);
    let (config, tools) = (job.config.clone(), job.tools.clone());
    let prepared = match crate::blocking(move || Ok(keyed(config, &tools))).await {
        Ok(prepared) => prepared,
        Err(error) => {
            // Nothing is coming: a send must not wait for this generation.
            forget(&session_id, job.generation);
            return Err(error);
        }
    };
    let key = prepared.1.clone();
    expect(&session_id, job.generation, &key);
    // Another switch holds the agent, or the turn-end prewarm is still spawning it: wait for
    // that agent rather than start a second CLI.
    let mut slot = None;
    wait_while(tokio::time::Instant::now() + SPAWN, || {
        if !spares().contains_key(&session_id) && spawning(&session_id) {
            return true;
        }
        slot = claim_switch(&session_id);
        slot.is_none()
    })
    .await;
    if !current(&session_id, job.generation) {
        return Ok(());
    }
    let live = spares().remove(&session_id);
    if let Some(spare) = live {
        if let Some(requests) = switchable(&spare.key, &key) {
            match switch(spare, &requests, &key, job.generation).await {
                Ok(spare) => {
                    adopt(spare, &session_id, job.launch);
                    return Ok(());
                }
                Err(error) => eprintln!("Warm Claude agent could not switch ({error}); restarting it."),
            }
        }
        // Otherwise the old agent is dropped here, which kills its process.
    }
    let result = spawn_spare(prepared, job.tools, job.approval_tools, job.launch, job.generation).await;
    if result.is_err() {
        forget(&session_id, job.generation);
    }
    result
}

/// The control requests that turn a live agent keyed `from` into one keyed `to`, if only its
/// model, effort or permission mode differ (none when nothing does). Checked against Claude
/// Code 2.1.322:
/// - `{"subtype":"set_model","model":M}` sets an explicit model. With no model, `null` or
///   `"default"` it picks Claude Code's built-in default, not the user's settings model that a
///   launch without `--model` uses, so a switch to or from `default` restarts the agent.
/// - `{"subtype":"apply_flag_settings","settings":{"effortLevel":E}}` applies the same effort
///   as `--effort E` (`get_settings` reports it applied), and `"effortLevel":null` the same as
///   no `--effort`. There is no `set_effort` request; `set_max_thinking_tokens` is a thinking
///   budget, not this effort.
/// - `{"subtype":"set_permission_mode","mode":P}`, except into or out of full access, which
///   needs a launch flag (`bypassPermissions` is refused without it, and leaving it would keep
///   it).
pub(super) fn switchable(from: &str, to: &str) -> Option<Vec<Value>> {
    let (Ok(Value::Object(from)), Ok(Value::Object(to))) = (serde_json::from_str::<Value>(from), serde_json::from_str::<Value>(to)) else {
        return None;
    };
    let explicit = |model: &Value| model.as_str().is_some_and(|model| !model.is_empty() && model != "default");
    let mut requests = Vec::new();
    for (field, value) in &to {
        if from.get(field) == Some(value) {
            continue;
        }
        match field.as_str() {
            "model" if explicit(value) && from.get("model").is_some_and(explicit) => {
                requests.push(json!({"subtype": "set_model", "model": value}));
            }
            "effort" => requests.push(json!({"subtype": "apply_flag_settings", "settings": {"effortLevel": value}})),
            "mode" if value != "full" && from.get("mode").is_some_and(|mode| mode != "full") => {
                requests.push(json!({"subtype": "set_permission_mode", "mode": claude_permission_mode(value.as_str()?)}));
            }
            _ => return None,
        }
    }
    (from.len() == to.len()).then_some(requests)
}

/// Write the control requests to the waiting agent's stdin and remember their ids; nothing is
/// awaited. Claude Code reads its input in order, so the requests are applied before anything
/// a turn writes after them, even while it is still starting; the turn that adopts the agent
/// waits for their replies before its first message (`set_model` replies only once applied)
/// and fails clearly if one is refused.
pub(super) async fn switch(mut spare: Spare, requests: &[Value], key: &str, generation: u64) -> Result<Spare, String> {
    if requests.is_empty() {
        spare.key = key.to_owned();
        spare.generation = generation;
        return Ok(spare);
    }
    let stdin = spare.child.stdin.as_mut().ok_or("its input is unavailable")?;
    let mut ids = Vec::new();
    let written = tokio::time::timeout(SWITCH, async {
        for (index, request) in requests.iter().enumerate() {
            let id = format!("pandacode-warm-{generation}-{index}");
            write_json(stdin, &json!({"type": "control_request", "request_id": id, "request": request})).await?;
            ids.push(id);
        }
        Ok::<_, String>(())
    })
    .await;
    written.map_err(|_| "its input is full".to_string())??;
    spare.unanswered.extend(ids);
    spare.key = key.to_owned();
    spare.generation = generation;
    Ok(spare)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spare(key: String, generation: u64, (child, group): (Child, ProcessGroup)) -> Spare {
        Spare { key, child, group, server: None, born: std::time::Instant::now(), generation, pending: Vec::new(), unanswered: HashSet::new() }
    }

    #[test]
    fn only_model_and_ordinary_permission_changes_switch_a_live_agent() {
        let base = crate::providers::tests::config("claude");
        let from = key(&RunConfig { model: "claude-sonnet-5-5".into(), mode: "auto".into(), ..base.clone() }, &[]);
        let to = |edit: fn(&mut RunConfig)| {
            let mut config = RunConfig { model: "claude-sonnet-5-5".into(), mode: "auto".into(), ..base.clone() };
            edit(&mut config);
            switchable(&from, &key(&config, &[]))
        };
        assert_eq!(
            to(|c| { c.model = "claude-opus-5-5".into(); c.mode = "plan".into(); }),
            Some(vec![
                json!({"subtype": "set_permission_mode", "mode": "plan"}),
                json!({"subtype": "set_model", "model": "claude-opus-5-5"}),
            ])
        );
        assert_eq!(to(|_| {}), Some(Vec::new()));
        // Effort, set or cleared, is applied live too.
        assert_eq!(
            to(|c| c.reasoning_effort = Some("xhigh".into())),
            Some(vec![json!({"subtype": "apply_flag_settings", "settings": {"effortLevel": "xhigh"}})])
        );
        let high = key(&RunConfig { model: "claude-sonnet-5-5".into(), mode: "auto".into(), reasoning_effort: Some("high".into()), ..base.clone() }, &[]);
        assert_eq!(switchable(&high, &from), Some(vec![json!({"subtype": "apply_flag_settings", "settings": {"effortLevel": null}})]));
        for respawn in [
            to(|c| c.model = "default".into()),
            to(|c| c.mode = "full".into()),
            to(|c| c.resume_id = Some("other".into())),
        ] {
            assert_eq!(respawn, None);
        }
    }

    /// A stand-in for `claude -p --input-format stream-json` that runs its startup for `delay`
    /// seconds, then answers each control request (or refuses it when `$1` is `refuse`) after
    /// a status line.
    #[cfg(unix)]
    fn fake_cli_after(mode: &str, delay: u64) -> (Child, ProcessGroup) {
        let script = r#"echo '{"type":"system","subtype":"hook_started"}'
sleep "$2"
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p')
  printf '{"type":"system","subtype":"status","status":null}\n{"type":"system","subtype":"partial'
  if [ "$1" = refuse ]; then
    printf '"}\n{"type":"control_response","response":{"subtype":"error","request_id":"%s","error":"no"}}\n' "$id"
  else
    printf '"}\n{"type":"control_response","response":{"subtype":"success","request_id":"%s"}}\n' "$id"
  fi
done"#;
        let child = Command::new("sh")
            .args(["-c", script, "fake-claude", mode, &delay.to_string()])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        (child, ProcessGroup::register(None))
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn two_quick_switches_switch_the_same_agent_twice() {
        let base = RunConfig { session_id: "warm-two-switches".into(), model: "claude-sonnet-5-5".into(), ..crate::providers::tests::config("claude") };
        let id = base.session_id.clone();
        let launch = epoch(&id);
        let generation = record(&base, &[], &HashSet::new(), launch);
        let keyed_for = |config: &RunConfig| keyed(config.clone(), &[]).1;
        // A CLI that answers its first request after a second: the first switch is in flight
        // when the second one comes.
        let (child, group) = fake_cli_after("answer", 1);
        let pid = child.id();
        assert!(adopt(spare(keyed_for(&base), generation, (child, group)), &id, launch));
        let first = retargeted(&id, |c| c.model = "claude-opus-5-5".into()).unwrap().unwrap();
        let second = retargeted(&id, |c| c.model = "claude-haiku-5-5".into()).unwrap().unwrap();
        let expected = keyed_for(&second.config);
        let (a, b) = tokio::join!(switch_or_start(first), async {
            tokio::time::sleep(Duration::from_millis(100)).await;
            switch_or_start(second).await
        });
        a.unwrap();
        b.unwrap();
        let spares = spares();
        let spare = spares.get(&id).expect("an agent is waiting");
        assert_eq!(spare.key, expected, "it carries the latest model");
        assert_eq!(spare.child.id(), pid, "the same process: no second CLI was started");
        drop(spares);
        discard(&id);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_switch_only_writes_its_requests_so_a_slow_cli_is_ready_at_once() {
        let base = RunConfig { model: "claude-sonnet-5-5".into(), ..crate::providers::tests::config("claude") };
        let to_config = RunConfig { model: "claude-opus-5-5".into(), reasoning_effort: Some("high".into()), mode: "plan".into(), ..base.clone() };
        let (from, to) = (key(&base, &[]), key(&to_config, &[]));
        let requests = switchable(&from, &to).unwrap();
        // Still starting for 3 s: the switch does not wait for it.
        let started = std::time::Instant::now();
        let mut switched = switch(spare(from, 1, fake_cli_after("answer", 3)), &requests, &to, 2).await.expect("switched");
        assert!(started.elapsed() < Duration::from_millis(500));
        assert_eq!((switched.key.as_str(), switched.generation), (to.as_str(), 2));
        assert_eq!(switched.unanswered.len(), 3, "the adopting run waits for these replies");
        // The CLI got them, in order, and answers once started.
        let mut stdout = switched.child.stdout.take().unwrap();
        let mut seen = Vec::new();
        let mut buffer = [0u8; 4096];
        while !switched.unanswered.iter().all(|id| String::from_utf8_lossy(&seen).contains(id.as_str())) {
            let count = tokio::time::timeout(Duration::from_secs(10), stdout.read(&mut buffer)).await.unwrap().unwrap();
            assert!(count > 0);
            seen.extend_from_slice(&buffer[..count]);
        }
    }

    /// Exercise the real adopting protocol with init before, between and after the replies.
    fn check_first_message_waits_for_switch_replies(orders: &[&[&str]]) {
        let init = json!({"type":"control_response","response":{"request_id":"pandacode-init","subtype":"success"}});
        let reply = |id: &str| json!({"type":"control_response","response":{"request_id":id,"subtype":"success"}});
        for order in orders {
            for init_at in 0..=order.len() {
                let mut protocol = Protocol::new(RunConfig { prompt: "original user content".into(), ..crate::providers::tests::config("claude") });
                protocol.warm_switch = order.iter().map(|id| (*id).to_owned()).collect();
                let mut writes = Vec::new();
                for at in 0..=order.len() {
                    if at == init_at {
                        writes.extend(protocol.receive(init.clone()).unwrap().write);
                    }
                    if at < order.len() {
                        assert!(writes.is_empty(), "no prompt before the final acknowledgment");
                        writes.extend(protocol.receive(reply(order[at])).unwrap().write);
                        assert!(!protocol.warm_switch.contains(order[at]), "the acknowledged id is removed");
                        if at + 1 < order.len() {
                            assert!(writes.is_empty(), "no prompt while switch replies remain");
                            assert_eq!(protocol.held_start.as_ref(), (init_at <= at).then_some(&init), "held init survives every early acknowledgment");
                        }
                        assert!(protocol.receive(reply(order[at])).unwrap().write.is_empty(), "a duplicate acknowledgment never sends a prompt");
                    }
                }
                assert_eq!(writes.len(), 1, "one prompt for order {order:?}, init at {init_at}");
                assert_eq!(writes[0]["type"], "user");
                assert_eq!(writes[0]["message"]["content"], "original user content");
                assert!(protocol.held_start.is_none() && protocol.warm_switch.is_empty());
                assert!(protocol.config.prompt.is_empty());
                assert!(!protocol.warm_refused);
            }
        }
    }

    #[test]
    fn the_first_message_waits_for_the_switch_replies() {
        check_first_message_waits_for_switch_replies(&[
            &["pandacode-warm-2-0", "pandacode-warm-2-1"],
            &["pandacode-warm-2-1", "pandacode-warm-2-0"],
        ]);
    }

    #[test]
    fn the_first_message_waits_for_three_switch_replies() {
        check_first_message_waits_for_switch_replies(&[
            &["pandacode-warm-3-0", "pandacode-warm-3-1", "pandacode-warm-3-2"],
            &["pandacode-warm-3-0", "pandacode-warm-3-2", "pandacode-warm-3-1"],
            &["pandacode-warm-3-1", "pandacode-warm-3-0", "pandacode-warm-3-2"],
            &["pandacode-warm-3-1", "pandacode-warm-3-2", "pandacode-warm-3-0"],
            &["pandacode-warm-3-2", "pandacode-warm-3-0", "pandacode-warm-3-1"],
            &["pandacode-warm-3-2", "pandacode-warm-3-1", "pandacode-warm-3-0"],
        ]);
    }

    #[test]
    fn a_refused_switch_clears_held_init_and_keeps_the_prompt_for_cold_start() {
        let init = json!({"type":"control_response","response":{"request_id":"pandacode-init","subtype":"success"}});
        let reply = |id: &str, subtype: &str| json!({"type":"control_response","response":{"request_id":id,"subtype":subtype,"error":"no"}});
        for count in [2, 3] {
            for refuse_at in 0..count {
                let ids: Vec<_> = (0..count).map(|at| format!("pandacode-warm-4-{at}")).collect();
                let mut protocol = Protocol::new(RunConfig { prompt: "original user content".into(), ..crate::providers::tests::config("claude") });
                protocol.warm_switch = ids.iter().cloned().collect();
                assert!(protocol.receive(init.clone()).unwrap().write.is_empty());
                for id in &ids[..refuse_at] {
                    assert!(protocol.receive(reply(id, "success")).unwrap().write.is_empty());
                }
                assert_eq!(protocol.held_start.as_ref(), Some(&init));
                assert!(protocol.receive(reply(&ids[refuse_at], "error")).unwrap().write.is_empty());
                assert!(protocol.warm_refused && protocol.held_start.is_none() && protocol.warm_switch.is_empty());
                assert_eq!(protocol.config.prompt, "original user content");
                // The run consumes this flag, drops the warm process, then initializes cold.
                assert!(std::mem::take(&mut protocol.warm_refused));
                let cold = protocol.receive(init.clone()).unwrap();
                assert_eq!(cold.write.len(), 1);
                assert_eq!(cold.write[0]["message"]["content"], "original user content");
            }
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_switch_during_the_turn_end_spawn_switches_that_agent() {
        let base = RunConfig { session_id: "warm-switch-spawning".into(), model: "claude-sonnet-5-5".into(), ..crate::providers::tests::config("claude") };
        let id = base.session_id.clone();
        let launch = epoch(&id);
        // The turn-end prewarm recorded its inputs and is spawning its CLI.
        let generation = record(&base, &[], &HashSet::new(), launch);
        let spawning = Spawning::mark(&id);
        let job = retargeted(&id, |c| c.model = "claude-opus-5-5".into()).unwrap().unwrap();
        let expected = keyed(job.config.clone(), &[]).1;
        let (child, group) = fake_cli_after("answer", 0);
        let pid = child.id();
        let original = keyed(base.clone(), &[]).1;
        let landing = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(300)).await;
            // The spawn ends: superseded by the switch, its agent is kept for it.
            assert!(adopt(spare(original, generation, (child, group)), "warm-switch-spawning", launch));
            drop(spawning);
        });
        switch_or_start(job).await.unwrap();
        landing.await.unwrap();
        let spares = spares();
        let spare = spares.get(&id).expect("an agent is waiting");
        assert_eq!(spare.child.id(), pid, "the spawning agent was switched; no second CLI");
        assert_eq!(spare.key, expected);
        assert_eq!(spare.unanswered.len(), 1);
        drop(spares);
        discard(&id);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_send_keeps_waiting_for_an_agent_being_spawned() {
        let base = RunConfig { session_id: "warm-spawning-send".into(), ..crate::providers::tests::config("claude") };
        let (id, wanted) = (base.session_id.clone(), key(&base, &[]));
        let launch = epoch(&id);
        let generation = record(&base, &[], &HashSet::new(), launch);
        expect(&id, generation, &wanted);
        let spawning = Spawning::mark(&id);
        // Its spawn ends past the grace: the send still adopts it rather than start a second CLI.
        let ready = wanted.clone();
        tokio::spawn(async move {
            tokio::time::sleep(GRACE + Duration::from_millis(800)).await;
            assert!(adopt(spare(ready, generation, sleeper()), "warm-spawning-send", launch));
            drop(spawning);
        });
        let mut adopted = take(&id, &wanted).await.expect("the spawning agent is adopted");
        adopted.child.kill().await.unwrap();
        launch_settled(&id);
    }

    #[test]
    fn a_claude_record_left_behind_on_another_harness_is_not_a_warm_agent() {
        let base = RunConfig { session_id: "warm-left-claude".into(), ..crate::providers::tests::config("claude") };
        record(&base, &[], &HashSet::new(), epoch(&base.session_id));
        assert!(present(&base.session_id), "starting");
        assert!(retargeted(&base.session_id, |c| c.provider = "codex".into()).expect("inputs").is_none());
        assert!(!present(&base.session_id), "the inputs alone do not make `warm_task` a no-op");
        discard(&base.session_id);
    }

    /// The waiting agent refuses every switch request; it would answer a prompt `warm reply`.
    #[cfg(unix)]
    const REFUSING: &str = r#"while IFS= read -r line; do
  case "$line" in
    *pandacode-warm*)
      id=$(printf '%s' "$line" | sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p')
      printf '{"type":"control_response","response":{"subtype":"error","request_id":"%s","error":"no such model"}}\n' "$id" ;;
    *pandacode-init*) printf '%s\n' '{"type":"control_response","response":{"request_id":"pandacode-init","subtype":"success","response":{}}}' ;;
    *) printf '%s\n' '{"type":"assistant","message":{"id":"w","content":[{"type":"text","text":"warm reply"}]}}' '{"type":"result","subtype":"success","result":"warm reply"}' ;;
  esac
done"#;

    /// The cold launch: answers `initialize`, then the prompt with `cold reply`.
    #[cfg(unix)]
    const COLD: &str = r#"IFS= read -r init
printf '%s\n' '{"type":"control_response","response":{"request_id":"pandacode-init","subtype":"success","response":{}}}'
IFS= read -r prompt
printf '%s\n' '{"type":"system","subtype":"init","session_id":"cold"}' '{"type":"assistant","message":{"id":"c","content":[{"type":"text","text":"cold reply"}]}}' '{"type":"result","subtype":"success","result":"cold reply"}'
"#;

    #[cfg(unix)]
    #[tokio::test]
    async fn a_refused_switch_starts_the_turn_cold_without_failing_it() {
        let _serial = super::super::super::concurrent_process_tests::process_test_lock().lock().await;
        let host = ToolHost {
            tools: vec![json!({"type":"function","name":"pandacode_noop","description":"Does nothing.","inputSchema":{"type":"object","properties":{}}})],
            approval_tools: HashSet::new(),
            handler: Arc::new(|_, args| Box::pin(async move { Ok(args) })),
        };
        let config = RunConfig { session_id: "warm-refused".into(), model: "claude-sonnet-5-5".into(), prompt: "hi".into(), ..crate::providers::tests::config("claude") };
        let wanted = key(&config, &host.tools);
        // The waiting agent was switched; it will refuse.
        let child = Command::new("sh").args(["-c", REFUSING]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true).spawn().unwrap();
        let requests = [json!({"subtype": "set_model", "model": "claude-sonnet-5-5"})];
        let switched = switch(spare(wanted, 1, (child, ProcessGroup::register(None))), &requests, &key(&config, &host.tools), 1).await.unwrap();
        spares().insert(config.session_id.clone(), switched);
        let events = Arc::new(Mutex::new(Vec::new()));
        let seen = events.clone();
        let sink: Sink = Arc::new(move |event: AgentEvent| seen.lock().unwrap().push(event));
        let (_input, receiver) = tokio::sync::mpsc::unbounded_channel();
        let mut cold = Command::new("sh");
        cold.args(["-c", COLD]);
        let run = super::super::super::run_process_with_tools(config.clone(), sink, receiver, cold, Vec::new(), Some(host));
        tokio::time::timeout(Duration::from_secs(10), run).await.expect("the turn ends").expect("the turn succeeds");
        let text: String = events.lock().unwrap().iter().filter(|event| event.kind == "text" || event.kind == "delta").map(|event| event.text.clone()).collect();
        let all = format!("{:?}", events.lock().unwrap().iter().map(|event| (&event.kind, &event.text)).collect::<Vec<_>>());
        assert!(all.contains("cold reply"), "{all}");
        assert!(!all.contains("warm reply") && !text.contains("warm reply"), "{all}");
        assert!(!waiting(&config.session_id), "the refusing agent is gone");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_cold_claude_send_uses_the_tool_server_started_while_it_looked_for_an_agent() {
        let _serial = super::super::super::concurrent_process_tests::process_test_lock().lock().await;
        let host = ToolHost {
            tools: vec![json!({"type":"function","name":"pandacode_noop","description":"Does nothing.","inputSchema":{"type":"object","properties":{}}})],
            approval_tools: HashSet::new(),
            handler: Arc::new(|_, args| Box::pin(async move { Ok(args) })),
        };
        // No warm agent: the send goes cold, with the server started alongside the lookup
        // (its `--mcp-config` reaches the cold launch).
        let config = RunConfig { session_id: "warm-cold-server".into(), prompt: "hi".into(), ..crate::providers::tests::config("claude") };
        let events = Arc::new(Mutex::new(Vec::new()));
        let seen = events.clone();
        let sink: Sink = Arc::new(move |event: AgentEvent| seen.lock().unwrap().push(event));
        let (_input, receiver) = tokio::sync::mpsc::unbounded_channel();
        let script = format!("case \"$*\" in *--mcp-config*) ;; *) exit 3 ;; esac\n{COLD}");
        let mut cold = Command::new("sh");
        cold.args(["-c", &script, "fake-claude"]);
        let run = super::super::super::run_process_with_tools(config, sink, receiver, cold, Vec::new(), Some(host));
        tokio::time::timeout(Duration::from_secs(10), run).await.expect("the turn ends").expect("the turn succeeds");
        let all = format!("{:?}", events.lock().unwrap().iter().map(|event| (&event.kind, &event.text)).collect::<Vec<_>>());
        assert!(all.contains("cold reply"), "{all}");
    }

    /// Explicitly opt in (starts the installed Claude Code, sends no prompt):
    /// cargo test --lib live_switch_of_a_waiting_claude -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn live_switch_of_a_waiting_claude_applies_model_and_effort() {
        let config = RunConfig { model: "claude-sonnet-5-5".into(), reasoning_effort: Some("high".into()), cwd: std::env::temp_dir(), ..crate::providers::tests::config("claude") };
        let switched = RunConfig { model: "claude-opus-5-5".into(), reasoning_effort: Some("low".into()), ..config.clone() };
        let mut command = Command::new(executable("claude").expect("Claude Code is installed"));
        super::super::super::configure_command(&mut command, &config);
        command.current_dir(&config.cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
        let child = command.spawn().unwrap();
        let (from, to) = (key(&config, &[]), key(&switched, &[]));
        let requests = switchable(&from, &to).expect("model and effort switch live");
        let mut agent = switch(spare(from, 1, (child, ProcessGroup::register(None))), &requests, &to, 2).await.unwrap();
        let mut stdin = agent.child.stdin.take().unwrap();
        let mut stdout = agent.child.stdout.take().unwrap();
        let (mut seen, mut buffer) = (Vec::new(), [0u8; 8192]);
        let mut asked = false;
        // `set_model` replies once applied: ask for the applied settings only after every reply.
        let applied = loop {
            let lines: Vec<Value> = String::from_utf8_lossy(&seen).lines().filter_map(|line| serde_json::from_str(line).ok()).collect();
            let answered = |id: &str| lines.iter().find(|line| line["response"]["request_id"] == id).cloned();
            if let Some(check) = answered("check") {
                break check["response"]["response"]["applied"].clone();
            }
            if !asked && agent.unanswered.iter().all(|id| answered(id).is_some_and(|reply| reply["response"]["subtype"] == "success")) {
                write_json(&mut stdin, &json!({"type":"control_request","request_id":"check","request":{"subtype":"get_settings"}})).await.unwrap();
                asked = true;
            }
            let count = tokio::time::timeout(Duration::from_secs(30), stdout.read(&mut buffer)).await.unwrap().unwrap();
            assert!(count > 0, "Claude Code exited: {}", String::from_utf8_lossy(&seen));
            seen.extend_from_slice(&buffer[..count]);
        };
        println!("applied after the switch: {applied}");
        assert_eq!(applied["model"], "claude-opus-5-5");
        assert_eq!(applied["effort"], "low");
    }

    fn sleeper() -> (Child, ProcessGroup) {
        let child = Command::new("sleep").arg("30").kill_on_drop(true).spawn().unwrap();
        (child, ProcessGroup::register(None))
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_retargeted_warm_agent_carries_the_new_model_and_the_latest_switch_wins() {
        let base = RunConfig { session_id: "warm-retarget".into(), ..crate::providers::tests::config("claude") };
        let launch = epoch(&base.session_id);
        // The turn ended: the prewarm for the old model is still starting.
        let older = record(&base, &[], &HashSet::new(), launch);
        // Two quick switches: only the second may keep a spare.
        let first = retargeted(&base.session_id, |c| c.model = "claude-sonnet-5-5".into()).unwrap().unwrap();
        let newest = retargeted(&base.session_id, |c| c.model = "claude-haiku-5-5".into()).unwrap().unwrap();
        assert_eq!(first.config.model, "claude-sonnet-5-5");
        assert!(!current(&base.session_id, first.generation), "the debounced first switch gives way");
        assert_eq!(newest.launch, launch, "the launch epoch carries over");
        let switched: Value = serde_json::from_str(&key(&newest.config, &[])).unwrap();
        assert_eq!(switched["model"], "claude-haiku-5-5");
        // The newest finishes first; the late older prewarm cannot replace it.
        assert!(adopt(spare(key(&newest.config, &[]), newest.generation, sleeper()), &base.session_id, launch));
        assert!(!adopt(spare(key(&base, &[]), older, sleeper()), &base.session_id, launch));
        assert_eq!(spares().get(&base.session_id).map(|spare| spare.key.clone()), Some(key(&newest.config, &[])));
        // Picking the same settings again keeps that agent.
        assert!(retargeted(&base.session_id, |c| c.model = "claude-haiku-5-5".into()).expect("inputs").is_none());
        assert!(current(&base.session_id, newest.generation) && waiting(&base.session_id));
        // Looking at another harness keeps the agent...
        assert!(retargeted(&base.session_id, |c| c.provider = "codex".into()).expect("inputs").is_none());
        assert!(waiting(&base.session_id));
        // ...so a quick round trip back to Claude keeps the same agent, without a restart.
        let back = retargeted(&base.session_id, |c| c.provider = "claude".into()).unwrap().unwrap();
        assert_eq!(back.config.model, "claude-haiku-5-5");
        let pid = spares()[&base.session_id].child.id();
        // (The agent was keyed with `key`; the switch compares the launch as it will run.)
        spares().get_mut(&base.session_id).unwrap().key = keyed(back.config.clone(), &[]).1;
        switch_or_start(back).await.unwrap();
        assert_eq!(spares().get(&base.session_id).map(|spare| spare.child.id()), Some(pid));
        // Once the other harness's start begins, the Claude agent goes: one spare per task.
        assert!(retargeted(&base.session_id, |c| c.provider = "codex".into()).expect("inputs").is_none());
        other_start(&base.session_id);
        assert!(!waiting(&base.session_id));
        discard(&base.session_id);
        assert!(retargeted(&base.session_id, |c| c.model = "x".into()).is_none(), "nothing left to retarget");
    }

    #[test]
    fn a_retargeted_spare_is_keyed_exactly_like_the_cold_launch_it_replaces() {
        let tools = vec![json!({"type":"function","name":"pandacode_title"})];
        let row = RunConfig {
            session_id: "warm-retarget-key".into(),
            resume_id: Some("conversation".into()),
            ..crate::providers::tests::config("claude")
        };
        // The turn that ended: lib.rs keeps its launch with the prompt cleared.
        let finished = RunConfig { prompt: String::new(), ..row.clone() };
        record(&finished, &tools, &HashSet::new(), epoch(&row.session_id));
        let switched = RunConfig { model: "claude-opus-5-5".into(), reasoning_effort: Some("high".into()), mode: "full".into(), ..row.clone() };
        let next = retargeted(&row.session_id, |c| {
            c.model = switched.model.clone();
            c.reasoning_effort = switched.reasoning_effort.clone();
            c.mode = switched.mode.clone();
        })
        .expect("warm inputs")
        .expect("an agent to start");
        let (_, spare_key, _) = keyed(next.config, &next.tools);
        assert_eq!(spare_key, super::super::tests::cold_key(&switched, "next message", &tools));
        assert_ne!(spare_key, super::super::tests::cold_key(&row, "next message", &tools), "the old settings would miss");
        discard(&row.session_id);
    }

    #[test]
    fn switching_back_to_claude_warms_the_handoff_launch() {
        let tools = vec![json!({"type":"function","name":"pandacode_title"})];
        let row = RunConfig {
            session_id: "warm-harness-round-trip".into(),
            resume_id: Some("conversation".into()),
            ..crate::providers::tests::config("claude")
        };
        record(&RunConfig { prompt: String::new(), ..row.clone() }, &tools, &HashSet::new(), epoch(&row.session_id));
        // Away to Codex: no spare, but the inputs stay.
        assert!(retargeted(&row.session_id, |c| { c.provider = "codex".into(); c.resume_id = None; }).expect("inputs").is_none());
        assert!(!waiting(&row.session_id));
        // Back to Claude: the task row has no resume id and context_recovery restores the
        // earlier messages in the prompt only, so a fresh spare matches the first launch.
        let back = RunConfig { resume_id: None, ..row.clone() };
        let next = retargeted(&row.session_id, |c| c.provider = "claude".into()).unwrap().unwrap();
        assert_eq!(next.config.resume_id, None);
        let (_, spare_key, _) = keyed(next.config, &next.tools);
        let handoff = "PandaCode restored earlier messages from this same task after its harness context changed.\n\nCurrent request:\nhi";
        assert_eq!(spare_key, super::super::tests::cold_key(&back, handoff, &tools));
        // A launch on the other harness in between drops the inputs at once: a later switch
        // reports nothing retargeted, so `rewarm` starts afresh from the task's row.
        launched(&row.session_id);
        assert!(!targets().contains_key(&row.session_id));
        assert!(retargeted(&row.session_id, |c| c.model = "claude-haiku-5-5".into()).is_none());
    }
}
