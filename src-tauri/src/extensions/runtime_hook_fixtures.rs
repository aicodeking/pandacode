//! Hook fixtures and the provenance of recorded harness frames (runtime phase R5, slice R0501).
//!
//! Hooks are built against three kinds of recorded input, and this module keeps them apart:
//!
//! * `harness-capture`: frames a real, installed harness wrote. Only these can qualify a harness.
//! * `sdk-derived`: frames written by hand from a harness SDK's transport source or documentation (Claude Code's
//!   `initialize.hooks` registration and `hook_callback` request come from the Python Agent SDK's `query.py`).
//! * `synthetic`: frames of the Node fake agent (B5, `tests/fixtures/extensions/backends/fake-agent.mjs`).
//!
//! The ledger `tests/fixtures/extensions/runtime-hook-fixtures/provenance.json` lists every input with its kind, and
//! [`validate`] refuses a ledger in which an input is relabelled: a file's own header must name the same kind, only a
//! harness capture may say `liveCapture: true`, a capture made in this folder lives under `live/` and names the user's
//! authorization, and a file under `live/` that the ledger does not list is an error.
//!
//! The Claude Code hook-callback capture (`initialize.hooks` plus one `hook_callback` answered by a `control_response`)
//! is a named qualification gate, [`CLAUDE_GATE`]. It is computed from the evidence, never read on trust: it is
//! qualified only by an authorized live capture whose frames hold the registration, a callback whose id was registered
//! and the answer to that callback. SDK-derived frames have the same shape and still never qualify. A ledger that
//! claims the gate without that evidence fails validation, so the gate's stored status cannot be a fabricated success.
//! Until the user authorizes a live run the gate is pending; that blocks Claude (and GLM, MiMo) hook qualification,
//! not the implementation against SDK-derived and synthetic frames.
//!
//! The Windows proof that the fake agent runs through PandaCode's declared ACP transport
//! (`runtime_provider_launch::drive`) with scripted approval, denial, structured question, cancelled tool and late
//! answer is the native test module `tests::windows_transport` (feature `extension-runtime-native-tests`).
#![cfg_attr(not(test), allow(dead_code))]
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

/// The provenance ledger, compiled in so the product reports the same gate status the fixtures prove.
pub(crate) const LEDGER: &str = include_str!("../../../tests/fixtures/extensions/runtime-hook-fixtures/provenance.json");
/// Repository-relative folder of the hook fixtures.
pub(crate) const FIXTURE_DIR: &str = "tests/fixtures/extensions/runtime-hook-fixtures/";
/// Repository-relative folder that only authorized live captures may occupy.
pub(crate) const LIVE_DIR: &str = "tests/fixtures/extensions/runtime-hook-fixtures/live/";
/// The Claude Code hook-callback capture gate.
pub(crate) const CLAUDE_GATE: &str = "claude-hook-callback-capture";

/// Where a recorded input came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum Provenance { HarnessCapture, SdkDerived, Synthetic }
impl Provenance {
    pub(crate) fn parse(text: &str) -> Option<Self> {
        match text { "harness-capture" => Some(Self::HarnessCapture), "sdk-derived" => Some(Self::SdkDerived), "synthetic" => Some(Self::Synthetic), _ => None }
    }
    pub(crate) fn name(self) -> &'static str {
        match self { Self::HarnessCapture => "harness-capture", Self::SdkDerived => "sdk-derived", Self::Synthetic => "synthetic" }
    }
    /// Only frames a real harness wrote can qualify that harness.
    pub(crate) fn qualifies(self) -> bool { self == Self::HarnessCapture }
}

/// A qualification gate's state, computed from the evidence.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Gate {
    Pending { reason: String },
    Qualified { input: String, authorization: String },
}
impl Gate {
    pub(crate) fn status(&self) -> &'static str { match self { Self::Pending { .. } => "pending", Self::Qualified { .. } => "qualified" } }
}

/// What a valid ledger establishes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Report {
    pub inputs: BTreeMap<String, Provenance>,
    pub gates: BTreeMap<String, Gate>,
}

fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> { value[key].as_str().filter(|text| !text.trim().is_empty()) }

/// The `_fixture` header of a fixture file: the first line of a JSONL file, the top-level field of a JSON file.
fn header(location: &str, content: &str) -> Option<Value> {
    if location.ends_with(".jsonl") {
        let first = content.lines().find(|line| !line.trim().is_empty())?;
        serde_json::from_str::<Value>(first).ok()?.get("_fixture").cloned()
    } else if location.ends_with(".json") {
        serde_json::from_str::<Value>(content).ok()?.get("_fixture").cloned()
    } else {
        None
    }
}

/// The frames of a JSONL recording, without its header.
pub(crate) fn frames(content: &str) -> Vec<Value> {
    content.lines().filter_map(|line| serde_json::from_str::<Value>(line).ok()).filter(|frame| frame.get("_fixture").is_none()).collect()
}

/// Whether `frames` hold a complete Claude Code hook-callback exchange: an `initialize` control request registering at
/// least one callback id, a `hook_callback` control request naming a registered id, and the `control_response` to it.
/// This checks the shape only; whether the frames may qualify the harness is their provenance's business.
pub(crate) fn claude_hook_callback_evidence(frames: &[Value]) -> Result<(), String> {
    let request = |frame: &Value, subtype: &str| frame["type"] == "control_request" && frame["request"]["subtype"] == subtype;
    let mut registered = BTreeSet::new();
    for frame in frames.iter().filter(|frame| request(frame, "initialize")) {
        for matchers in frame["request"]["hooks"].as_object().into_iter().flat_map(|hooks| hooks.values()) {
            for matcher in matchers.as_array().into_iter().flatten() {
                registered.extend(matcher["hookCallbackIds"].as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_owned));
            }
        }
    }
    if registered.is_empty() { return Err("no initialize control request registers a hook callback (initialize.hooks is missing, null or empty)".into()); }
    let callback = frames.iter().filter(|frame| request(frame, "hook_callback"))
        .find(|frame| frame["request"]["callback_id"].as_str().is_some_and(|id| registered.contains(id)))
        .ok_or("no hook_callback control request names a registered callback id")?;
    let id = text(callback, "request_id").ok_or("the hook_callback control request has no request_id")?;
    if !frames.iter().any(|frame| frame["type"] == "control_response" && frame["response"]["request_id"] == id) {
        return Err(format!("the hook_callback {id:?} has no control_response"));
    }
    Ok(())
}

/// Validates a provenance ledger. `read` returns a repository-relative file's text; `live_files` lists the
/// repository-relative files present under [`LIVE_DIR`] (its README excluded).
pub(crate) fn validate(ledger: &Value, read: &dyn Fn(&str) -> Option<String>, live_files: &[String]) -> Result<Report, Vec<String>> {
    let mut errors = Vec::new();
    let mut inputs = BTreeMap::new();
    let mut live_inputs: BTreeMap<String, (String, String, String)> = BTreeMap::new();
    if ledger["schema"] != 1 { errors.push("the ledger's schema must be 1".to_owned()); }
    for input in ledger["inputs"].as_array().map(Vec::as_slice).unwrap_or_default() {
        let Some(id) = text(input, "id") else { errors.push("an input has no id".into()); continue };
        let Some(provenance) = input["provenance"].as_str().and_then(Provenance::parse) else { errors.push(format!("{id}: unknown provenance {}", input["provenance"])); continue };
        if inputs.insert(id.to_owned(), provenance).is_some() { errors.push(format!("{id}: listed twice")); }
        let Some(location) = text(input, "location") else { errors.push(format!("{id}: no location")); continue };
        let Some(content) = read(location) else { errors.push(format!("{id}: {location} does not exist")); continue };
        let form = input["capture"]["form"].as_str();
        let live = provenance == Provenance::HarnessCapture && form == Some("live");
        let own = location.starts_with(FIXTURE_DIR);
        if location.starts_with(LIVE_DIR) && !live { errors.push(format!("{id}: only an authorized live harness capture may live under live/, not {}", provenance.name())); }
        if live && !location.starts_with(LIVE_DIR) { errors.push(format!("{id}: a live capture belongs under live/")); }
        if own {
            match header(location, &content) {
                None => errors.push(format!("{id}: {location} has no _fixture header")),
                Some(header) => {
                    if header["provenance"].as_str() != Some(provenance.name()) { errors.push(format!("{id}: the file says {} but the ledger says {}", header["provenance"], provenance.name())); }
                    if header["liveCapture"].as_bool() != Some(live) { errors.push(format!("{id}: liveCapture must be {live}")); }
                    if live && header["authorization"] != input["capture"]["authorization"] { errors.push(format!("{id}: the file's authorization differs from the ledger's")); }
                }
            }
        }
        match provenance {
            Provenance::HarnessCapture => match form {
                Some("live") => {
                    let authorization = text(&input["capture"], "authorization");
                    if authorization.is_none() { errors.push(format!("{id}: a live capture names the user's authorization")); }
                    if text(&input["capture"], "capturedAt").is_none() { errors.push(format!("{id}: a live capture names when it was captured")); }
                    live_inputs.insert(location.to_owned(), (id.to_owned(), input["harness"].as_str().unwrap_or_default().to_owned(), authorization.unwrap_or_default().to_owned()));
                }
                Some("transcribed") => {
                    if own { errors.push(format!("{id}: a transcribed recording points at its existing location, not a new file here")); }
                    if text(&input["capture"], "origin").is_none() { errors.push(format!("{id}: a transcribed recording names its origin")); }
                    if !text(input, "marker").is_some_and(|marker| content.contains(marker)) { errors.push(format!("{id}: the recorded frames were not found in {location}")); }
                }
                _ => errors.push(format!("{id}: a harness capture's form is \"live\" or \"transcribed\"")),
            },
            Provenance::SdkDerived | Provenance::Synthetic => {
                if input.get("capture").is_some() { errors.push(format!("{id}: a {} input cannot carry capture details", provenance.name())); }
                if text(input, "source").is_none() { errors.push(format!("{id}: a {} input names its source", provenance.name())); }
            }
        }
    }
    for file in live_files {
        if !live_inputs.contains_key(file) { errors.push(format!("{file}: a file under live/ that the ledger does not list as an authorized capture")); }
    }
    let mut gates = BTreeMap::new();
    for gate in ledger["gates"].as_array().map(Vec::as_slice).unwrap_or_default() {
        let Some(id) = text(gate, "id") else { errors.push("a gate has no id".into()); continue };
        let computed = if id == CLAUDE_GATE { claude_gate(&live_inputs, read) } else { Gate::Pending { reason: format!("{id}: no evidence rule is defined for this gate") } };
        match (gate["status"].as_str(), &computed) {
            (Some("qualified"), Gate::Pending { reason }) => errors.push(format!("{id}: the ledger claims the gate is qualified without evidence ({reason})")),
            (Some("pending"), Gate::Qualified { input, .. }) => errors.push(format!("{id}: {input} qualifies the gate; record it as qualified with its authorization")),
            (Some("pending" | "qualified"), _) => {}
            _ => errors.push(format!("{id}: a gate's status is \"pending\" or \"qualified\"")),
        }
        match &computed {
            Gate::Qualified { authorization, .. } if gate["authorization"].as_str() != Some(authorization) => errors.push(format!("{id}: the gate's authorization must be the capture's")),
            Gate::Pending { .. } if !gate["authorization"].is_null() => errors.push(format!("{id}: a pending gate records no authorization")),
            Gate::Pending { .. } if text(gate, "reason").is_none() => errors.push(format!("{id}: a pending gate says why")),
            _ => {}
        }
        gates.insert(id.to_owned(), computed);
    }
    if !gates.contains_key(CLAUDE_GATE) { errors.push(format!("the ledger must name the {CLAUDE_GATE} gate")); }
    if errors.is_empty() { Ok(Report { inputs, gates }) } else { Err(errors) }
}

fn claude_gate(live: &BTreeMap<String, (String, String, String)>, read: &dyn Fn(&str) -> Option<String>) -> Gate {
    let mut reasons = Vec::new();
    for (location, (id, harness, authorization)) in live {
        if harness != "claude-code" || authorization.is_empty() { continue; }
        match read(location).map(|content| claude_hook_callback_evidence(&frames(&content))) {
            Some(Ok(())) => return Gate::Qualified { input: id.clone(), authorization: authorization.clone() },
            Some(Err(reason)) => reasons.push(format!("{id}: {reason}")),
            None => reasons.push(format!("{id}: unreadable")),
        }
    }
    let reason = if reasons.is_empty() {
        "no authorized live Claude Code capture of initialize.hooks and hook_callback exists; recording one needs the user's separate authorization".to_owned()
    } else {
        reasons.join("; ")
    };
    Gate::Pending { reason }
}

/// The Claude hook-callback gate as the shipped ledger records it. The fixture tests prove the ledger cannot record a
/// qualification its evidence does not support, so a build reports pending until an authorized capture lands.
pub(crate) fn claude_gate_status() -> Gate {
    let ledger: Value = serde_json::from_str(LEDGER).unwrap_or(Value::Null);
    let gate = ledger["gates"].as_array().and_then(|gates| gates.iter().find(|gate| gate["id"] == CLAUDE_GATE));
    match gate {
        Some(gate) if gate["status"] == "qualified" && text(gate, "authorization").is_some() => Gate::Qualified {
            input: gate["evidence"].as_str().unwrap_or(CLAUDE_GATE).to_owned(),
            authorization: gate["authorization"].as_str().unwrap_or_default().to_owned(),
        },
        Some(gate) => Gate::Pending { reason: text(gate, "reason").unwrap_or("pending").to_owned() },
        None => Gate::Pending { reason: "the ledger names no Claude hook-callback gate".into() },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::PathBuf;

    fn root() -> PathBuf { PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..") }
    fn disk(location: &str) -> Option<String> { std::fs::read_to_string(root().join(location)).ok() }
    fn live_on_disk() -> Vec<String> {
        std::fs::read_dir(root().join(LIVE_DIR)).into_iter().flatten().filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned()).filter(|name| name != "README.md")
            .map(|name| format!("{LIVE_DIR}{name}")).collect()
    }
    fn shipped() -> Value { serde_json::from_str(LEDGER).unwrap() }
    const SDK: &str = "tests/fixtures/extensions/runtime-hook-fixtures/sdk-derived/claude-hook-callback.jsonl";

    #[test]
    fn shipped_inputs_keep_their_provenance_and_the_claude_gate_is_pending() {
        let report = validate(&shipped(), &disk, &live_on_disk()).unwrap_or_else(|errors| panic!("{errors:#?}"));
        let kinds: BTreeSet<Provenance> = report.inputs.values().copied().collect();
        assert_eq!(kinds, [Provenance::HarnessCapture, Provenance::SdkDerived, Provenance::Synthetic].into(), "all three kinds are recorded and told apart");
        assert_eq!(report.inputs["claude-sdk-hook-callback"], Provenance::SdkDerived);
        assert_eq!(report.inputs["fake-agent-scenarios"], Provenance::Synthetic);
        assert!(!Provenance::SdkDerived.qualifies() && !Provenance::Synthetic.qualifies() && Provenance::HarnessCapture.qualifies());
        let Gate::Pending { reason } = &report.gates[CLAUDE_GATE] else { panic!("the Claude gate must stay pending without an authorized capture") };
        assert!(reason.contains("authorization"), "{reason}");
        assert_eq!(claude_gate_status().status(), "pending");
        assert!(live_on_disk().is_empty(), "no live capture was recorded in this task");
    }

    #[test]
    fn sdk_frames_have_the_callback_shape_but_never_qualify_and_cannot_be_relabelled() {
        let sdk = frames(&disk(SDK).unwrap());
        claude_hook_callback_evidence(&sdk).expect("the SDK-derived frames hold the registration, a callback and its answer");
        // Claiming the gate on SDK-derived evidence is a fabricated success.
        let mut claimed = shipped();
        claimed["gates"][0]["status"] = json!("qualified");
        claimed["gates"][0]["authorization"] = json!("pretend");
        let errors = validate(&claimed, &disk, &[]).unwrap_err();
        assert!(errors.iter().any(|error| error.contains("without evidence")), "{errors:#?}");
        // Relabelling the SDK file as a live capture: its own header disagrees and it is not under live/.
        let mut relabelled = shipped();
        let input = relabelled["inputs"].as_array_mut().unwrap().iter_mut().find(|input| input["id"] == "claude-sdk-hook-callback").unwrap();
        input["provenance"] = json!("harness-capture");
        input["capture"] = json!({"form":"live","authorization":"pretend","capturedAt":"2026-11-17"});
        let errors = validate(&relabelled, &disk, &[]).unwrap_err();
        assert!(errors.iter().any(|error| error.contains("the file says")), "{errors:#?}");
        assert!(errors.iter().any(|error| error.contains("belongs under live/")), "{errors:#?}");
        // Calling the synthetic scenarios a transcribed capture is refused too.
        let mut transcribed = shipped();
        let input = transcribed["inputs"].as_array_mut().unwrap().iter_mut().find(|input| input["id"] == "fake-agent-scenarios").unwrap();
        input["provenance"] = json!("harness-capture");
        input["capture"] = json!({"form":"transcribed","origin":"pretend"});
        input["marker"] = json!("scenarios");
        assert!(validate(&transcribed, &disk, &[]).is_err());
    }

    /// An in-memory live capture: qualification needs the authorization, the header and complete frames.
    fn live_ledger(authorization: Option<&str>, status: &str) -> Value {
        let mut ledger = shipped();
        ledger["inputs"].as_array_mut().unwrap().push(json!({
            "id":"claude-live","provenance":"harness-capture","harness":"claude-code","location":format!("{LIVE_DIR}claude.jsonl"),
            "covers":["initialize.hooks","hook_callback"],"capture":{"form":"live","authorization":authorization,"capturedAt":"2026-11-17T10:00:00Z","harnessVersion":"fixture"}
        }));
        ledger["gates"][0]["status"] = json!(status);
        ledger["gates"][0]["authorization"] = authorization.map_or(Value::Null, |text| json!(text));
        ledger
    }
    fn live_file(authorization: &str, body: &str) -> String {
        format!("{}\n{body}", json!({"_fixture":{"provenance":"harness-capture","liveCapture":true,"harness":"claude-code","capturedAt":"2026-11-17T10:00:00Z","harnessVersion":"fixture","authorization":authorization}}))
    }

    #[test]
    fn only_an_authorized_complete_live_capture_qualifies_the_claude_gate() {
        let body: String = disk(SDK).unwrap().lines().skip(1).map(|line| format!("{line}\n")).collect();
        let live = format!("{LIVE_DIR}claude.jsonl");
        let reader = |content: String| { let live = live.clone(); move |location: &str| if location == live { Some(content.clone()) } else { disk(location) } };
        // Complete, authorized and recorded as qualified.
        let report = validate(&live_ledger(Some("user, 2026-11-17, chat"), "qualified"), &reader(live_file("user, 2026-11-17, chat", &body)), std::slice::from_ref(&live)).unwrap_or_else(|errors| panic!("{errors:#?}"));
        assert_eq!(report.gates[CLAUDE_GATE], Gate::Qualified { input: "claude-live".into(), authorization: "user, 2026-11-17, chat".into() });
        // The evidence qualifies but the ledger still says pending: it must be updated, not silently ignored.
        assert!(validate(&live_ledger(Some("user, 2026-11-17, chat"), "pending"), &reader(live_file("user, 2026-11-17, chat", &body)), std::slice::from_ref(&live)).is_err());
        // No authorization: never qualified.
        let errors = validate(&live_ledger(None, "qualified"), &reader(live_file("", &body)), std::slice::from_ref(&live)).unwrap_err();
        assert!(errors.iter().any(|error| error.contains("authorization")), "{errors:#?}");
        // Registration only, no callback: pending, so claiming it is refused.
        let registration: String = body.lines().take(2).map(|line| format!("{line}\n")).collect();
        let errors = validate(&live_ledger(Some("ok"), "qualified"), &reader(live_file("ok", &registration)), std::slice::from_ref(&live)).unwrap_err();
        assert!(errors.iter().any(|error| error.contains("hook_callback")), "{errors:#?}");
        // A callback that was never registered does not count.
        let foreign = body.replace("\"callback_id\":\"hook_0\"", "\"callback_id\":\"hook_9\"");
        assert!(claude_hook_callback_evidence(&frames(&foreign)).is_err());
        // A null registration (what PandaCode sends today) does not count.
        assert!(claude_hook_callback_evidence(&[json!({"type":"control_request","request_id":"pandacode-init","request":{"subtype":"initialize","hooks":null}})]).is_err());
    }

    #[test]
    fn unlisted_or_mislabelled_live_files_and_live_claims_on_synthetic_files_are_refused() {
        let stray = format!("{LIVE_DIR}stray.jsonl");
        let errors = validate(&shipped(), &disk, std::slice::from_ref(&stray)).unwrap_err();
        assert!(errors.iter().any(|error| error.contains("does not list")), "{errors:#?}");
        // A synthetic file whose header claims a live capture.
        let synthetic = "tests/fixtures/extensions/runtime-hook-fixtures/synthetic/fake-agent-acp.jsonl";
        let lying = |location: &str| if location == synthetic { disk(location).map(|text| text.replacen("\"liveCapture\":false", "\"liveCapture\":true", 1)) } else { disk(location) };
        let errors = validate(&shipped(), &lying, &[]).unwrap_err();
        assert!(errors.iter().any(|error| error.contains("liveCapture must be false")), "{errors:#?}");
        // A synthetic file placed under live/.
        let mut moved = shipped();
        let input = moved["inputs"].as_array_mut().unwrap().iter_mut().find(|input| input["id"] == "fake-agent-acp-frames").unwrap();
        input["location"] = json!(format!("{LIVE_DIR}fake-agent-acp.jsonl"));
        let errors = validate(&moved, &|location: &str| if location.starts_with(LIVE_DIR) { disk(synthetic) } else { disk(location) }, &[format!("{LIVE_DIR}fake-agent-acp.jsonl")]).unwrap_err();
        assert!(errors.iter().any(|error| error.contains("only an authorized live harness capture")), "{errors:#?}");
        // An unknown kind is not silently accepted.
        let mut unknown = shipped();
        unknown["inputs"][0]["provenance"] = json!("recorded");
        assert!(validate(&unknown, &disk, &[]).is_err());
    }

    /// The Node fake agent (B5) launched through PandaCode's declared ACP transport on Windows, scripted with approval,
    /// denial, a structured question, a tool cancelled while it waits for approval and a late answer. Each scenario
    /// comes from the synthetic fixture `synthetic/scenarios.json`; the fake agent's received-frame log is the oracle.
    #[cfg(all(feature = "extension-runtime-native-tests", target_os = "windows"))]
    mod windows_transport {
        use super::*;
        use crate::{extensions::runtime_provider_launch as launch, providers::RunInput};
        use std::{path::Path, sync::{Arc, atomic::{AtomicBool, Ordering}}, time::Duration};
        use tokio::sync::mpsc;

        const AGENT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/fixtures/extensions/backends/fake-agent.mjs");
        const SCENARIOS: &str = include_str!("../../../tests/fixtures/extensions/runtime-hook-fixtures/synthetic/scenarios.json");
        const OWNER: &str = "sample.hook-fixtures";
        const WAIT: Duration = Duration::from_secs(30);

        struct Dir(PathBuf);
        impl Dir { fn new() -> Self { let path = std::env::temp_dir().join(format!("pandacode-hook-fixtures-{}", uuid::Uuid::new_v4())); std::fs::create_dir(&path).unwrap(); Self(path) } }
        impl Drop for Dir { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }

        fn node() -> PathBuf {
            crate::extensions::supervisor::Runtime::packaged(&root().join("_work/00-tmp/extensibility-trusted-runtime")).ok().map(|runtime| runtime.binary)
                .or_else(|| crate::providers::tool_path("node"))
                .expect("a Node runtime for the fake agent")
        }

        struct Running { events: mpsc::UnboundedReceiver<Value>, seen: Vec<Value>, inputs: mpsc::Sender<RunInput>, task: tokio::task::JoinHandle<Result<(), String>>, dir: Dir }
        impl Running {
            fn start(prompt: &str) -> Self {
                let dir = Dir::new();
                let spec = json!({"protocol":"acp","command":["{node}", AGENT],"env":{"FAKE_AGENT_LOG":"{data}/frames.log"}});
                let resolved = launch::resolve(&spec, &launch::Places { node: Some(node()), package: None, data: Some(dir.0.clone()) }).unwrap();
                let (sink, events) = mpsc::unbounded_channel();
                let (inputs, received) = mpsc::channel(16);
                let cancel = Arc::new(AtomicBool::new(false));
                let stop = cancel.clone();
                let (cwd, prompt) = (dir.0.clone(), prompt.to_owned());
                let task = tokio::spawn(async move {
                    launch::drive(OWNER, resolved, &cwd, &prompt, None,
                        move |value| { let _ = sink.send(value); Ok(Value::Null) },
                        // Core's own stale-request check is bypassed on purpose: every approval is forwarded, so the
                        // transport alone must refuse to answer a permission request that is no longer pending.
                        move |input| match input {
                            RunInput::Stop => { stop.store(true, Ordering::Release); None }
                            RunInput::Approval { approved, .. } => Some(json!({"kind":"approval","approved":approved})),
                            _ => None,
                        },
                        received, cancel).await
                });
                Self { events, seen: Vec::new(), inputs, task, dir }
            }
            async fn until(&mut self, what: &str, matches: impl Fn(&Value) -> bool) {
                let found = tokio::time::timeout(WAIT, async {
                    loop {
                        match self.events.recv().await {
                            Some(value) => { let hit = matches(&value); self.seen.push(value); if hit { return true; } }
                            None => return false,
                        }
                    }
                }).await.unwrap_or_else(|_| panic!("timed out waiting for {what}: {:?}", self.seen));
                assert!(found, "the run ended before {what}: {:?}", self.seen);
            }
            async fn answer(&self, approved: bool) { self.inputs.send(RunInput::Approval { request_id: "fixture".into(), approved }).await.unwrap(); }
            async fn finish(mut self) -> (Result<(), String>, Vec<Value>, Vec<Value>) {
                let result = tokio::time::timeout(WAIT, &mut self.task).await.expect("the run finishes").expect("the run task does not panic");
                while let Ok(value) = self.events.try_recv() { self.seen.push(value); }
                let log = std::fs::read_to_string(self.dir.0.join("frames.log")).unwrap_or_default();
                let frames = log.lines().filter_map(|line| serde_json::from_str::<Value>(line).ok()).collect();
                (result, std::mem::take(&mut self.seen), frames)
            }
        }

        fn texts(events: &[Value]) -> Vec<String> { events.iter().filter(|event| event["kind"] == "text").filter_map(|event| event["text"].as_str().map(str::to_owned)).collect() }
        fn is_approval(event: &Value) -> bool { event["kind"] == "approval" }

        async fn scenario(id: &str, spec: &Value) {
            let mut run = Running::start(spec["prompt"].as_str().unwrap());
            let mut approvals_answered = 0;
            for action in spec["host"].as_array().unwrap().iter().filter_map(Value::as_str) {
                match action {
                    "approve" | "deny" => { run.until("an approval request", is_approval).await; run.answer(action == "approve").await; approvals_answered += 1; }
                    "approve-again" => {
                        let expected = spec["expect"]["texts"][0].as_str().unwrap().to_owned();
                        run.until("the approved tool's result", move |event| event["text"] == expected.as_str()).await;
                        // The permission request was already answered: a second, late answer must not reach the agent.
                        run.answer(true).await;
                    }
                    "stop" => { run.until("an approval request", is_approval).await; run.inputs.send(RunInput::Stop).await.unwrap(); }
                    "none" => {}
                    other => panic!("{id}: unknown host action {other}"),
                }
            }
            let (result, events, frames) = run.finish().await;
            assert!(result.is_ok(), "{id}: {result:?} {events:?}");
            let said = texts(&events);
            let expect = &spec["expect"];
            let mut from = 0;
            for wanted in expect["texts"].as_array().into_iter().flatten().filter_map(Value::as_str) {
                let at = said[from..].iter().position(|text| text == wanted).unwrap_or_else(|| panic!("{id}: {wanted:?} missing or out of order in {said:?}"));
                from += at + 1;
            }
            for never in expect["neverTexts"].as_array().into_iter().flatten().filter_map(Value::as_str) { assert!(!said.iter().any(|text| text == never), "{id}: {never:?} in {said:?}"); }
            if let Some(status) = expect["toolStatus"].as_str() { assert!(events.iter().any(|event| event["kind"] == "tool" && event["tool"]["status"] == status), "{id}: no {status} tool in {events:?}"); }
            if expect["noApproval"] == true { assert!(!events.iter().any(is_approval), "{id}: a structured question became an approval: {events:?}"); }
            let answers: Vec<&Value> = frames.iter().filter(|frame| frame.get("method").is_none() && frame["result"].get("outcome").is_some()).collect();
            if expect["noSelectedAnswer"] == true { assert!(answers.iter().all(|frame| frame["result"]["outcome"]["outcome"] != "selected"), "{id}: a cancelled tool was answered: {answers:?}"); }
            if let Some(count) = expect["responsesToPermission"].as_u64() { assert_eq!(answers.len() as u64, count, "{id}: {answers:?} ({approvals_answered} answered by the host)"); }
            if expect["stop"] == "cancelled" { assert!(frames.iter().any(|frame| frame["method"] == "session/cancel"), "{id}: no session/cancel in {frames:?}"); }
            assert!(frames.iter().any(|frame| frame["method"] == "initialize") && frames.iter().any(|frame| frame["method"] == "session/prompt"), "{id}: {frames:?}");
        }

        #[tokio::test]
        async fn the_fake_agent_runs_scripted_hook_scenarios_through_the_declared_acp_transport_on_windows() {
            assert!(Path::new(AGENT).is_file());
            launch::forget(OWNER);
            let fixture: Value = serde_json::from_str(SCENARIOS).unwrap();
            assert_eq!(fixture["_fixture"]["provenance"], "synthetic");
            let scenarios = fixture["scenarios"].as_array().unwrap();
            let ids: BTreeSet<&str> = scenarios.iter().filter_map(|scenario| scenario["id"].as_str()).collect();
            assert_eq!(ids, ["approval-allow", "approval-deny", "structured-question", "cancel-pending-tool", "late-answer"].into());
            for spec in scenarios { scenario(spec["id"].as_str().unwrap(), spec).await; }
            let state = launch::snapshot(OWNER);
            assert_eq!((state.active, state.finished), (0, scenarios.len() as u64), "{state:?}");
            launch::forget(OWNER);
        }
    }
}
