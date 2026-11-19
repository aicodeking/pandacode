//! Token saver: detects optional local tools the per-thread saver can lean on, and builds the
//! pack guidance team workers get from `src/token-saver-packs.json`, the text the window's
//! `src/token-saver.ts` also uses. Nothing here runs an agent.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{path::{Path, PathBuf}, process::Command, sync::{atomic::{AtomicBool, Ordering}, LazyLock}, time::Duration};

use crate::workspace::{checked, run_process};

static INSTALLING: AtomicBool = AtomicBool::new(false);

const RTK_INSTALL: &str = "brew install rtk";

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Tools {
    /// RTK (Rust Token Killer) compresses command output before agents read it.
    pub rtk: bool,
    pub rtk_version: String,
    rtk_install: String,
}

/// A CLI from the user's PATH or a standard Homebrew prefix; GUI launches miss shell PATHs.
pub fn find_tool(name: &str) -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|path| std::env::split_paths(&path).collect()).unwrap_or_default();
    dirs.extend(["/opt/homebrew/bin", "/usr/local/bin"].map(PathBuf::from));
    if let Some(home) = std::env::var_os("HOME") {
        dirs.extend([".local/bin", ".cargo/bin"].map(|dir| Path::new(&home).join(dir)));
    }
    let file = if cfg!(windows) { format!("{name}.exe") } else { name.to_string() };
    dirs.into_iter().map(|dir| dir.join(&file)).find(|path| path.is_file())
}

/// `rtk 0.37.1` → `0.37.1`; anything else stays as printed.
fn version_line(output: &str) -> String {
    let line = output.lines().next().unwrap_or_default().trim();
    line.split_whitespace().last().unwrap_or(line).to_string()
}

fn detect() -> Tools {
    let mut tools = Tools { rtk_install: RTK_INSTALL.into(), ..Default::default() };
    if let Some(path) = find_tool("rtk") {
        let mut command = Command::new(path);
        command.arg("--version");
        if let Ok(output) = run_process(command, "rtk", 4096, Duration::from_secs(5)) {
            tools.rtk = output.status.success();
            tools.rtk_version = version_line(&String::from_utf8_lossy(&output.stdout.bytes));
        }
    }
    tools
}

/// Install a tool a saver pack needs. Only RTK, only through Homebrew, one at a time.
#[tauri::command]
pub async fn token_saver_install(tool: String) -> crate::Result<Tools> {
    if tool != "rtk" {
        return Err("Unknown tool.".into());
    }
    if INSTALLING.swap(true, Ordering::SeqCst) {
        return Err("RTK is already being installed.".into());
    }
    let result = crate::blocking(|| {
        let found = detect();
        if found.rtk {
            return Ok(found);
        }
        let brew = find_tool("brew").ok_or_else(|| format!("Homebrew is needed to install RTK. Install Homebrew from brew.sh, or run `{RTK_INSTALL}` another way."))?;
        let mut command = Command::new(brew);
        command
            .args(["install", "rtk"])
            .env("HOMEBREW_NO_AUTO_UPDATE", "1")
            .env("HOMEBREW_NO_INSTALL_CLEANUP", "1")
            .env("HOMEBREW_NO_ENV_HINTS", "1")
            .env("NONINTERACTIVE", "1");
        checked(run_process(command, "Homebrew", 1024 * 1024, Duration::from_secs(600))?)
            .map_err(|error| format!("Could not install RTK: {}", error.lines().last().unwrap_or(&error)))?;
        let tools = detect();
        if !tools.rtk {
            return Err("Homebrew finished, but rtk was not found afterwards.".into());
        }
        Ok(tools)
    })
    .await;
    INSTALLING.store(false, Ordering::SeqCst);
    result
}

pub const HEADER: &str = "Response style (PandaCode token saver";
const PACKS: [&str; 4] = ["caveman", "lean-code", "quiet-tools", "rtk"];
const LEVELS: [&str; 3] = ["lite", "full", "ultra"];

#[derive(Deserialize)]
struct Texts {
    caveman: Caveman,
    /// A thread's style should reach the harness's own subagents too; never sent to workers.
    subagents: String,
    exceptions: String,
    guidance: Guidance,
}
#[derive(Deserialize)]
struct Caveman {
    lite: String,
    full: String,
    ultra: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
struct Guidance {
    lean_code: String,
    quiet_tools: String,
    rtk: String,
}
/// The one copy of the pack text, shared with the window.
static TEXTS: LazyLock<Texts> = LazyLock::new(|| serde_json::from_str(include_str!("../../src/token-saver-packs.json")).expect("src/token-saver-packs.json"));

fn caveman(level: &str) -> &'static str {
    let caveman = &TEXTS.caveman;
    match level {
        "lite" => &caveman.lite,
        "ultra" => &caveman.ultra,
        _ => &caveman.full,
    }
}
fn pack_text(id: &str, level: &str) -> &'static str {
    let guidance = &TEXTS.guidance;
    match id {
        "caveman" => caveman(level),
        "lean-code" => &guidance.lean_code,
        "quiet-tools" => &guidance.quiet_tools,
        _ => &guidance.rtk,
    }
}

/// A thread's guidance for a set of packs, or an explicit switch-off; `guidance()` in the window.
/// An active style also asks the agent to pass it on to its own subagents. The window builds
/// thread blocks; this twin pins the shared text (`guidance_snapshot`).
#[cfg(test)]
pub fn guidance(packs: &[String], level: &str, rtk: bool) -> String {
    let packs: Vec<String> = packs.iter().filter(|id| *id != "rtk" || rtk).cloned().collect();
    compose(&packs, level, true)
}

/// A team worker's guidance: the same packs, without the subagent line (workers have none).
/// `rtk` is never checked for workers: its pack says to run a rejected command plainly.
pub fn worker_guidance(packs: &[String], level: &str) -> String {
    compose(packs, level, false)
}

fn compose(packs: &[String], level: &str, subagents: bool) -> String {
    if packs.is_empty() {
        return format!("{HEADER}): off. Answer in your normal style again.");
    }
    let mut lines: Vec<&str> = packs.iter().map(|id| pack_text(id, level)).collect();
    if packs.iter().any(|id| id == "caveman") {
        lines.push(&TEXTS.exceptions);
    }
    if subagents {
        lines.push(&TEXTS.subagents);
    }
    format!("{HEADER}, applies to this whole thread until changed; reader pays per token):\n{}", lines.join("\n\n"))
}

/// The packs a team worker runs with. Empty `packs` is an explicit "none".
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Applied {
    pub packs: Vec<String>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub level: String,
    /// A follow-up turned off packs the worker's previous launch carried: its next launch says so.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub switch_off: bool,
}

impl Applied {
    /// Nothing to carry or say: a worker that never had packs.
    pub fn is_empty(&self) -> bool {
        self.packs.is_empty() && !self.switch_off
    }
    /// `quiet-tools+caveman/lite`, or `none`.
    pub fn label(&self) -> String {
        if self.packs.is_empty() {
            return "none".into();
        }
        let packs: Vec<String> = self.packs.iter().map(|id| if id == "caveman" { format!("caveman/{}", self.level) } else { id.clone() }).collect();
        packs.join("+")
    }
    /// The block for the worker's prompt.
    pub fn block(&self) -> String {
        format!("\n\n{}", worker_guidance(&self.packs, &self.level))
    }
}

/// An assignment's `tokenSaver`: `"none"` or `{packs, level}` (also as a JSON-encoded string),
/// in canonical pack order.
pub fn parse(value: &Value) -> Result<Applied, String> {
    match value.as_str() {
        Some("none") => return Ok(Applied::default()),
        Some(text) => if let Ok(object @ Value::Object(_)) = serde_json::from_str(text) {
            return parse(&object);
        },
        None => {}
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Request {
        packs: Vec<String>,
        level: Option<String>,
    }
    let request: Request = serde_json::from_value(value.clone()).map_err(|_| "tokenSaver is \"none\" or {\"packs\": [...], \"level\": \"lite\"|\"full\"|\"ultra\"}.".to_string())?;
    if let Some(unknown) = request.packs.iter().find(|id| !PACKS.contains(&id.as_str())) {
        return Err(format!("Unknown token saver pack {unknown:?}; use caveman, lean-code, quiet-tools or rtk."));
    }
    let caveman = request.packs.iter().any(|id| id == "caveman");
    let level = match request.level {
        Some(_) if !caveman => return Err("tokenSaver level applies only with caveman.".into()),
        Some(level) if !LEVELS.contains(&level.as_str()) => return Err("tokenSaver level is lite, full or ultra.".into()),
        Some(level) => level,
        None if caveman => "full".into(),
        None => String::new(),
    };
    let packs = PACKS.iter().filter(|id| request.packs.iter().any(|p| p == *id)).map(|id| id.to_string()).collect();
    Ok(Applied { packs, level, ..Default::default() })
}

#[tauri::command]
pub async fn token_saver_tools() -> crate::Result<Tools> {
    crate::blocking(|| Ok(detect())).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_are_read_from_the_first_line() {
        assert_eq!(version_line("rtk 0.37.1\nmore"), "0.37.1");
        assert_eq!(version_line(""), "");
    }

    /// The only test that touches INSTALLING, so it never starts a real install.
    #[test]
    fn only_rtk_installs_one_at_a_time() {
        let unknown = tauri::async_runtime::block_on(token_saver_install("curl".into())).unwrap_err();
        assert_eq!(unknown, "Unknown tool.");
        INSTALLING.store(true, Ordering::SeqCst);
        let busy = tauri::async_runtime::block_on(token_saver_install("rtk".into())).unwrap_err();
        INSTALLING.store(false, Ordering::SeqCst);
        assert!(busy.contains("already being installed"), "{busy}");
    }

    #[test]
    fn assignments_name_known_packs_and_level_only_with_caveman() {
        let ok = parse(&serde_json::json!({"packs":["quiet-tools","caveman"],"level":"lite"})).unwrap();
        assert_eq!(ok.packs, ["caveman", "quiet-tools"]);
        assert_eq!(ok.label(), "caveman/lite+quiet-tools");
        assert_eq!(parse(&serde_json::json!({"packs":["caveman"]})).unwrap().level, "full");
        assert_eq!(parse(&serde_json::json!("none")).unwrap(), Applied::default());
        assert!(parse(&serde_json::json!({"packs":["verbose"]})).unwrap_err().contains("Unknown token saver pack"));
        assert!(parse(&serde_json::json!({"packs":["lean-code"],"level":"ultra"})).unwrap_err().contains("only with caveman"));
        assert!(parse(&serde_json::json!({"packs":["caveman"],"level":"max"})).is_err());
        assert!(parse(&serde_json::json!("off")).is_err());
        assert!(parse(&serde_json::json!({"packs":[],"extra":1})).is_err());
    }

    #[test]
    fn only_an_active_thread_style_asks_to_reach_subagents() {
        let packs = vec!["lean-code".to_string()];
        let thread = guidance(&packs, "full", false);
        assert!(thread.ends_with(&TEXTS.subagents) && thread.contains("Response style:"));
        let worker = worker_guidance(&packs, "full");
        assert_eq!(format!("{worker}\n\n{}", TEXTS.subagents), thread);
        assert!(!worker.contains("subagents"));
        assert!(!guidance(&[], "full", false).contains("subagents"), "a switch-off says nothing of it");
        assert_eq!(Applied { packs, ..Default::default() }.block(), format!("\n\n{worker}"));
    }

    #[test]
    fn quiet_tools_leaves_explore_advice_to_the_app_instructions() {
        let quiet = pack_text("quiet-tools", "");
        assert!(!quiet.contains("explore") && !quiet.contains("Edit tool"), "{quiet}");
        assert!(quiet.starts_with("Keep tool output small. Search with targeted patterns"));
    }

    /// Same 96 outputs, same hash as the window's snapshot in tests/token-saver.test.mjs.
    #[test]
    fn guidance_snapshot() {
        use sha2::{Digest, Sha256};
        let mut out = Vec::new();
        for mask in 0..16 {
            for level in LEVELS {
                for rtk in [false, true] {
                    let packs: Vec<String> = PACKS.iter().enumerate().filter(|(i, _)| mask & (1 << i) != 0).map(|(_, id)| id.to_string()).collect();
                    out.push(guidance(&packs, level, rtk));
                }
            }
        }
        let hash: String = Sha256::digest(out.join("\0")).iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(hash, "6e2a8923af5b48bc63b6ac8cd8b48b19049095e727909c04228da63bd5390502");
    }

    #[test]
    fn assignments_may_send_the_object_as_a_json_string() {
        let applied = parse(&serde_json::json!("{\"packs\":[\"quiet-tools\",\"caveman\"],\"level\":\"lite\"}")).unwrap();
        assert_eq!(applied.label(), "caveman/lite+quiet-tools");
        assert!(parse(&serde_json::json!("{\"packs\":[\"verbose\"]}")).unwrap_err().contains("Unknown token saver pack"));
        assert!(parse(&serde_json::json!("[\"caveman\"]")).is_err());
    }

}
