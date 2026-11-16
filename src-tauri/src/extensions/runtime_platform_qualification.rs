//! Platform qualification inputs and result parsing for the trusted extension runtime.
//!
//! This module only *prepares* qualification: it defines the runner input and result schemas, the
//! platform matrix and the replayable result parser. It never launches anything and never enables
//! a platform. Only targets listed in `ENABLED_TARGETS` may run trusted code; every other target,
//! a missing runner, an unqualified runtime or a record that belongs to another target stays
//! `UnsupportedRuntime`. See `docs/extensions/runtime-platform-qualification.md`.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const UNSUPPORTED: &str = "UnsupportedRuntime";
pub const SCHEMA_VERSION: u64 = 1;
pub const PINNED_NODE: &str = "v26.1.0";
/// The only target with an executable runtime qualification today.
pub const ENABLED_TARGETS: &[&str] = &["windows-x64"];
/// Targets a runner may be prepared for. Presence here never enables execution.
pub const MATRIX: &[&str] = &["windows-x64", "macos-arm64", "macos-x64", "linux-x64", "linux-arm64"];
/// Scenario ids every complete result must report, in the order of the input.
pub const SCENARIOS: &[&str] = &["executable-host", "service", "rich-panel"];
/// Evidence that counts. Preview and browser results never qualify any target.
pub const COUNTING_EVIDENCE: &str = "installed";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Probe { Passed, Failed }

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Verdict {
    /// A complete, passing installed-app record for its own target.
    Passed,
    /// The record is valid and shows a failure.
    Failed(String),
    /// No runner supplied a record for the target.
    Missing,
    /// The record is malformed, mislabelled or does not count as evidence.
    Invalid(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Evaluation { pub target: String, pub verdict: Verdict, pub qualified_evidence: bool }

pub fn target_for(os: &str, arch: &str) -> Option<&'static str> {
    match (os, arch) {
        ("windows", "x86_64") => Some("windows-x64"),
        ("macos", "aarch64") => Some("macos-arm64"),
        ("macos", "x86_64") => Some("macos-x64"),
        ("linux", "x86_64") => Some("linux-x64"),
        ("linux", "aarch64") => Some("linux-arm64"),
        _ => None,
    }
}

pub fn current_target() -> Option<&'static str> { target_for(std::env::consts::OS, std::env::consts::ARCH) }

/// Explicit runtime selection: a trusted runtime may be launched only for an enabled target.
pub fn select_runtime(target: &str) -> Result<&'static str, &'static str> {
    if !MATRIX.contains(&target) || !ENABLED_TARGETS.contains(&target) { return Err(UNSUPPORTED); }
    Ok(PINNED_NODE)
}

/// The platform matrix as inspectable data for docs, receipts and the preview.
pub fn matrix() -> Value {
    json!(MATRIX.iter().map(|target| json!({
        "target": target,
        "enabled": ENABLED_TARGETS.contains(target),
        "state": if ENABLED_TARGETS.contains(target) { "qualified" } else { "UnsupportedRuntime" },
        "runtime": if ENABLED_TARGETS.contains(target) { json!(PINNED_NODE) } else { Value::Null },
    })).collect::<Vec<_>>())
}

/// Builds the runner input for a target. R2 fields are contract placeholders only: the preparation
/// slice never reads an R2 package, so `r2.packages` is empty and `r2.state` is `"not-adopted"`.
pub fn runner_input(target: &str, runner_id: &str) -> Result<Value, &'static str> {
    if !MATRIX.contains(&target) { return Err(UNSUPPORTED); }
    Ok(json!({
        "schemaVersion": SCHEMA_VERSION,
        "kind": "runtime-platform-qualification-input",
        "target": target,
        "runner": {"id": runner_id},
        "runtime": {"kind": "node", "version": PINNED_NODE},
        "probes": ["bundle", "launch"],
        "scenarios": [
            {"id": "executable-host", "fixture": "tests/fixtures/extensions/runtime-service-lifetime", "backends": []},
            {"id": "service", "fixture": "tests/fixtures/extensions/runtime-service-lifetime", "backends": ["fake-daemon"]},
            {"id": "rich-panel", "fixture": "tests/fixtures/extensions/runtime-service-lifetime", "backends": ["fake-daemon"]}
        ],
        "r2": {"state": "not-adopted", "packages": []},
        "credentials": "none",
    }))
}

fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> { value.get(key).and_then(Value::as_str) }

fn probe(value: &Value, key: &str) -> Option<Probe> {
    match value.get(key).and_then(|probe| text(probe, "status")) { Some("passed") => Some(Probe::Passed), Some("failed") => Some(Probe::Failed), _ => None }
}

/// Parses one runner result against the target it was requested for.
/// `result` is `None` when no runner produced a record.
pub fn evaluate(expected_target: &str, result: Option<&Value>) -> Evaluation {
    let done = |verdict: Verdict, counts: bool| Evaluation { target: expected_target.to_string(), verdict, qualified_evidence: counts };
    let Some(result) = result else { return done(Verdict::Missing, false); };
    let invalid = |why: &str| done(Verdict::Invalid(why.to_string()), false);
    if !MATRIX.contains(&expected_target) { return invalid("target is not in the matrix"); }
    if result.get("schemaVersion").and_then(Value::as_u64) != Some(SCHEMA_VERSION) || text(result, "kind") != Some("runtime-platform-qualification-result") { return invalid("unknown schema"); }
    // A record is bound to its own target; no other platform's result can stand in for it.
    if text(result, "target") != Some(expected_target) { return invalid("record belongs to another target"); }
    let host_target = result.get("host").and_then(|host| target_for(text(host, "os")?, text(host, "arch")?));
    if host_target != Some(expected_target) { return invalid("host does not match the target"); }
    // Preview, browser and native-fixture results are reported but never count.
    if text(result, "evidence") != Some(COUNTING_EVIDENCE) { return invalid("only installed-app evidence counts"); }
    if text(result.get("runtime").unwrap_or(&Value::Null), "version") != Some(PINNED_NODE) { return invalid("runtime is not the pinned version"); }
    let Some(scenarios) = result.get("scenarios").and_then(Value::as_array) else { return invalid("scenarios missing"); };
    let ids: Vec<&str> = scenarios.iter().filter_map(|scenario| text(scenario, "id")).collect();
    if ids.len() != scenarios.len() || ids != SCENARIOS { return invalid("scenario set is incomplete or reordered"); }
    let (Some(bundle), Some(launch)) = (probe(result, "bundle"), probe(result, "launch")) else { return invalid("probe result missing"); };
    if bundle == Probe::Failed { return done(Verdict::Failed("bundle probe failed".into()), true); }
    if launch == Probe::Failed { return done(Verdict::Failed("launch probe failed".into()), true); }
    for scenario in scenarios {
        match text(scenario, "outcome") {
            Some("passed") => {}
            Some("failed") => return done(Verdict::Failed(format!("scenario {} failed", text(scenario, "id").unwrap_or("?"))), true),
            _ => return invalid("scenario outcome missing"),
        }
    }
    done(Verdict::Passed, true)
}

/// Whether trusted code may run on `target`. A passing record is necessary evidence for a future
/// enabling change but never sufficient: the target must also be listed in `ENABLED_TARGETS`.
pub fn may_execute(target: &str, result: Option<&Value>) -> Result<&'static str, &'static str> {
    let runtime = select_runtime(target)?;
    match evaluate(target, result).verdict { Verdict::Passed => Ok(runtime), _ => Err(UNSUPPORTED) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fixture(name: &str) -> Value {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/extensions/runtime-platform-qualification").join(name);
        serde_json::from_slice(&std::fs::read(&path).unwrap_or_else(|_| panic!("missing fixture {name}"))).unwrap()
    }

    #[test]
    fn matrix_enables_only_windows_x64() {
        for entry in matrix().as_array().unwrap() {
            let enabled = entry["target"] == "windows-x64";
            assert_eq!(entry["enabled"], enabled);
            assert_eq!(select_runtime(entry["target"].as_str().unwrap()).is_ok(), enabled);
        }
        assert_eq!(select_runtime("freebsd-x64"), Err(UNSUPPORTED));
        assert_eq!(target_for("linux", "riscv64"), None);
    }

    #[test]
    fn runner_input_matches_the_fixture_and_uses_only_adopted_fixtures() {
        let input = runner_input("linux-x64", "runner-a").unwrap();
        assert_eq!(input, fixture("input-linux-x64.json"));
        assert_eq!(runner_input("plan9-x64", "r"), Err(UNSUPPORTED));
        assert_eq!(input["r2"]["packages"], json!([]));
        assert_eq!(input["credentials"], "none");
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
        for scenario in input["scenarios"].as_array().unwrap() {
            assert!(root.join(scenario["fixture"].as_str().unwrap()).join("extension.json").is_file());
            for backend in scenario["backends"].as_array().unwrap() { assert!(root.join("tests/fixtures/extensions/backends").join(backend.as_str().unwrap()).is_dir()); }
        }
    }

    #[test]
    fn replays_success_failure_and_missing_runner() {
        let ok = fixture("result-windows-x64-passed.json");
        assert_eq!(evaluate("windows-x64", Some(&ok)).verdict, Verdict::Passed);
        assert_eq!(may_execute("windows-x64", Some(&ok)), Ok(PINNED_NODE));
        let failed = fixture("result-windows-x64-failed.json");
        assert_eq!(evaluate("windows-x64", Some(&failed)).verdict, Verdict::Failed("scenario service failed".into()));
        assert_eq!(may_execute("windows-x64", Some(&failed)), Err(UNSUPPORTED));
        assert_eq!(evaluate("linux-x64", None).verdict, Verdict::Missing);
        assert_eq!(may_execute("linux-x64", None), Err(UNSUPPORTED));
        assert_eq!(may_execute("windows-x64", None), Err(UNSUPPORTED));
    }

    #[test]
    fn no_windows_or_browser_result_enables_another_os() {
        let windows = fixture("result-windows-x64-passed.json");
        for target in ["macos-arm64", "macos-x64", "linux-x64", "linux-arm64"] {
            assert!(matches!(evaluate(target, Some(&windows)).verdict, Verdict::Invalid(_)));
            assert_eq!(may_execute(target, Some(&windows)), Err(UNSUPPORTED));
        }
        let browser = fixture("result-linux-x64-browser.json");
        let verdict = evaluate("linux-x64", Some(&browser));
        assert!(matches!(verdict.verdict, Verdict::Invalid(_)) && !verdict.qualified_evidence);
        // Even a complete, passing installed Linux record is evidence only; the target stays disabled.
        let linux = fixture("result-linux-x64-passed.json");
        assert_eq!(evaluate("linux-x64", Some(&linux)).verdict, Verdict::Passed);
        assert_eq!(may_execute("linux-x64", Some(&linux)), Err(UNSUPPORTED));
    }

    #[test]
    fn malformed_records_are_invalid_not_passed() {
        let base = fixture("result-windows-x64-passed.json");
        let mutate = |edit: &dyn Fn(&mut Value)| { let mut value = base.clone(); edit(&mut value); evaluate("windows-x64", Some(&value)).verdict };
        assert!(matches!(mutate(&|v| v["runtime"]["version"] = json!("v20.0.0")), Verdict::Invalid(_)));
        assert!(matches!(mutate(&|v| v["scenarios"].as_array_mut().unwrap().pop().map(|_| ()).unwrap_or(())), Verdict::Invalid(_)));
        assert!(matches!(mutate(&|v| v["schemaVersion"] = json!(2)), Verdict::Invalid(_)));
        assert!(matches!(mutate(&|v| v["bundle"] = json!({})), Verdict::Invalid(_)));
        assert_eq!(mutate(&|v| v["launch"]["status"] = json!("failed")), Verdict::Failed("launch probe failed".into()));
        assert!(matches!(evaluate("windows-x64", Some(&json!("passed"))).verdict, Verdict::Invalid(_)));
    }
}
