//! PandaConnect methods for the `terminal` feature group: a phone lists, opens, reads,
//! types into, resizes and closes the computer's terminals. Output is polled from the
//! ring buffer `terminal.rs` records next to the webview's `terminal-event` (no new event
//! kinds). See `methods/mod.rs` and docs/remote-access.md, "Adding a method".
use super::files::{resolve, target_param, Target};
use super::{id_param, page_budget, Access, Ctx, Method, Reply, Run};
use crate::terminal::TerminalInfo;
use crate::{AppState, Result};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// The most input one `terminal.write` may send (keys and pasted text, not files).
pub(crate) const MAX_INPUT: usize = 16 * 1024;
/// Room left in a page for the reply's other fields.
const READ_OVERHEAD: usize = 1024;
/// At most this many terminals are listed.
const MAX_LISTED: usize = 100;
/// Shells one phone may have open at once (each is a PTY and a process on the computer).
pub(crate) const MAX_PHONE_TERMINALS: usize = 4;
/// Why `terminal.open` is refused at [`MAX_PHONE_TERMINALS`].
pub(crate) const TOO_MANY_TERMINALS: &str = "This phone already has 4 terminals open on this computer. Close one to open another.";

/// The shells one phone opened that are still open, and opens still starting.
#[derive(Debug, Default)]
struct PhoneTerminals {
    ids: Vec<String>,
    starting: usize,
}

impl PhoneTerminals {
    /// Forgets closed shells, then takes a slot or refuses at [`MAX_PHONE_TERMINALS`].
    fn reserve(&mut self, open: &dyn Fn(&str) -> bool) -> Result<()> {
        self.ids.retain(|id| open(id));
        if self.ids.len() + self.starting >= MAX_PHONE_TERMINALS {
            return Err(TOO_MANY_TERMINALS.into());
        }
        self.starting += 1;
        Ok(())
    }

    /// Ends a reservation, keeping the shell it started (if it did).
    fn settle(&mut self, started: Option<String>) {
        self.starting = self.starting.saturating_sub(1);
        self.ids.extend(started);
    }
}

fn phone_terminals() -> &'static Mutex<HashMap<String, PhoneTerminals>> {
    static OPENED: OnceLock<Mutex<HashMap<String, PhoneTerminals>>> = OnceLock::new();
    OPENED.get_or_init(Default::default)
}

/// A slot for one phone's new shell; dropping it (also when the open fails or is cancelled)
/// settles the slot with whatever shell was started.
struct Reservation {
    device: String,
    started: Option<String>,
}

impl Reservation {
    fn take(device: &str) -> Result<Self> {
        let open: Vec<String> = crate::terminal::output_list().into_iter().map(|info| info.id).collect();
        let mut table = phone_terminals().lock().unwrap_or_else(|e| e.into_inner());
        table.entry(device.to_owned()).or_default().reserve(&|id| open.iter().any(|o| o == id))?;
        Ok(Reservation { device: device.to_owned(), started: None })
    }
}

impl Drop for Reservation {
    fn drop(&mut self) {
        let mut table = phone_terminals().lock().unwrap_or_else(|e| e.into_inner());
        table.entry(self.device.clone()).or_default().settle(self.started.take());
    }
}

/// What a phone may never see: terminals of mirrored tasks (they run elsewhere) and of
/// bot workspaces (bot tasks, or a shell started in a bot project's folder).
#[derive(Debug, Default)]
struct Refused {
    /// Task ids that are mirrored, in a bot project, or unknown.
    sessions: Vec<String>,
    /// Bot projects' workspace folders.
    roots: Vec<PathBuf>,
}

impl Refused {
    fn hides(&self, session_id: Option<&str>, cwd: &str) -> bool {
        if session_id.is_some_and(|id| self.sessions.iter().any(|refused| refused == id)) {
            return true;
        }
        let cwd = Path::new(cwd);
        self.roots.iter().any(|root| cwd.starts_with(root))
    }
}

/// The refusals for `infos`: each tagged task is checked, and every bot workspace listed.
async fn refused(state: &AppState, infos: &[TerminalInfo]) -> Result<Refused> {
    let store = state.store.clone();
    let tagged: Vec<String> = infos.iter().filter_map(|info| info.session_id.clone()).collect();
    crate::blocking(move || {
        let store = store.lock().map_err(|e| e.to_string())?;
        let bots = crate::bots::project_ids(&store)?;
        let roots = bots.iter().filter_map(|project| store.workspace_root(project, None).ok()).collect();
        let sessions = tagged.into_iter().filter(|id| super::local_session_from(&store, id).map_or(true, |task| bots.contains(&task.project_id))).collect();
        Ok(Refused { sessions, roots })
    })
    .await
}

/// The terminals a phone may list, read or touch.
async fn visible(state: &AppState, infos: Vec<TerminalInfo>) -> Result<Vec<TerminalInfo>> {
    let refused = refused(state, &infos).await?;
    Ok(infos.into_iter().filter(|info| !refused.hides(info.session_id.as_deref(), &info.cwd)).collect())
}

/// Refuses a terminal the phone may not see (a bot workspace's, a mirrored task's, or gone),
/// so read, write, resize and close all hold to what `terminal.list` shows.
async fn ensure_visible(state: &AppState, terminal_id: &str) -> Result<()> {
    let info = crate::terminal::output_list().into_iter().filter(|info| info.id == terminal_id).collect();
    if visible(state, info).await?.is_empty() {
        return Err("Terminal is closed.".into());
    }
    Ok(())
}

/// Why a shell is refused when the host keeps remote tasks out of Full access.
#[cfg_attr(not(test), allow(dead_code))] // read by tests and docs only
pub(crate) const NEEDS_FULL_ACCESS: &str = "Turn on Full access for remote tasks on this computer to use the terminal.";
/// The actions [`require_full_access_to`] names in its refusal.
pub(crate) const USE_TERMINAL: &str = "use the terminal";
pub(crate) const EDIT_FILES: &str = "edit files";
pub(crate) const RUN_CHECKS: &str = "run checks";
pub(crate) const RUN_SCRIPTS: &str = "run scripts";

/// Refuses `action` unless the host lets remote tasks run with Full access: for effects that
/// can run anything as the user, beyond any task's permission mode.
pub(crate) fn require_full_access_to(full_access: bool, action: &str) -> Result<()> {
    if full_access {
        Ok(())
    } else {
        Err(format!("Turn on Full access for remote tasks on this computer to {action}."))
    }
}

/// A shell runs anything as the user, and its scrollback holds whatever the user typed or
/// printed: a phone may open, read or type into one only with the host's Full access.
pub(crate) fn require_full_access(full_access: bool) -> Result<()> {
    require_full_access_to(full_access, USE_TERMINAL)
}

// ---- terminal.list ----

#[derive(Debug, PartialEq)]
struct List;

impl Run for List {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            require_full_access(ctx.full_access)?;
            let terminals: Vec<_> = visible(&ctx.state(), crate::terminal::output_list()).await?.into_iter().take(MAX_LISTED).collect();
            Ok(json!({ "terminals": terminals }))
        })
    }
}

// ---- terminal.open ----

#[derive(Debug, PartialEq)]
struct Open {
    target: Target,
    cols: u16,
    rows: u16,
}

impl Run for Open {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            require_full_access(ctx.full_access)?;
            // Resolving first refuses bot workspaces and mirrored tasks.
            let (project_id, _) = resolve(&ctx.state(), &self.target).await?;
            let mut slot = Reservation::take(ctx.from)?;
            let session_id = match &self.target {
                Target::Task(session_id) => Some(session_id.clone()),
                Target::Project(_) => None,
            };
            let terminal_id = crate::start_terminal(ctx.app.clone(), ctx.state(), project_id, session_id.clone(), self.cols, self.rows).await?;
            slot.started = Some(terminal_id.clone());
            drop(slot);
            if let Some(session_id) = &session_id {
                crate::terminal::tag_output(&terminal_id, session_id);
            }
            Ok(json!({ "terminalId": terminal_id }))
        })
    }
}

// ---- terminal.read ----

#[derive(Debug, PartialEq)]
struct Read {
    terminal_id: String,
    after: u64,
    budget: usize,
}

impl Run for Read {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            require_full_access(ctx.full_access)?;
            ensure_visible(&ctx.state(), &self.terminal_id).await?;
            let chunk = crate::terminal::read_output(&self.terminal_id, self.after, self.budget)?;
            serde_json::to_value(chunk).map_err(|e| e.to_string())
        })
    }
}

// ---- terminal.write / terminal.resize / terminal.close ----

#[derive(Debug, PartialEq)]
struct Write {
    terminal_id: String,
    data: String,
}

impl Run for Write {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            require_full_access(ctx.full_access)?;
            ensure_visible(&ctx.state(), &self.terminal_id).await?;
            let terms = ctx.state().terminals.clone();
            crate::blocking(move || crate::terminal::write(&terms, &self.terminal_id, &self.data)).await?;
            Ok(json!({}))
        })
    }
}

#[derive(Debug, PartialEq)]
struct Resize {
    terminal_id: String,
    cols: u16,
    rows: u16,
}

impl Run for Resize {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            // Round 12: every terminal method needs the switch, like `runScript.stop`.
            require_full_access(ctx.full_access)?;
            ensure_visible(&ctx.state(), &self.terminal_id).await?;
            crate::terminal::resize(&ctx.state().terminals, &self.terminal_id, self.cols, self.rows)?;
            Ok(json!({}))
        })
    }
}

#[derive(Debug, PartialEq)]
struct Close {
    terminal_id: String,
}

impl Run for Close {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            require_full_access(ctx.full_access)?;
            ensure_visible(&ctx.state(), &self.terminal_id).await?;
            let terms = ctx.state().terminals.clone();
            crate::blocking(move || crate::terminal::close(&terms, &self.terminal_id)).await?;
            Ok(json!({}))
        })
    }
}

/// Why `runScript.stop` refuses a terminal that is not a run script (or is gone or hidden).
pub(crate) const NOT_A_RUN_SCRIPT: &str = "That run script is not running here.";

/// Closes a run-script terminal the phone may see, through [`Close`]'s path: `runScript.stop`
/// never reaches a shell or a harness console (Round 11).
pub(super) async fn close_run_script(state: &AppState, terminal_id: String) -> Result<()> {
    let info: Vec<TerminalInfo> = crate::terminal::output_list().into_iter().filter(|info| info.id == terminal_id).collect();
    if !is_run_script(&info) || visible(state, info).await?.is_empty() {
        return Err(NOT_A_RUN_SCRIPT.into());
    }
    let terms = state.terminals.clone();
    crate::blocking(move || crate::terminal::close(&terms, &terminal_id)).await
}

/// The running run-script terminal in `root` that [`close_run_script`] would close, for
/// `runScript.get` (Round 12). Callers check the host switch first: the id is only useful,
/// and only shown, to a phone that may stop it.
pub(super) async fn running_run_script(state: &AppState, root: &std::path::Path) -> Result<Option<String>> {
    let root = root.to_string_lossy();
    let scripts: Vec<TerminalInfo> = crate::terminal::output_list().into_iter().filter(|info| info.kind == "script" && info.running && info.cwd == root).collect();
    Ok(visible(state, scripts).await?.into_iter().next().map(|info| info.id))
}

fn is_run_script(info: &[TerminalInfo]) -> bool {
    !info.is_empty() && info.iter().all(|info| info.kind == "script")
}

// ---- parsing ----

fn terminal_id(p: &Value) -> Result<String> {
    id_param(p, "terminalId")
}

/// A terminal dimension; `terminal.rs` clamps it to what a PTY accepts.
fn dimension(p: &Value, key: &str) -> Result<u16> {
    let value = p.get(key).and_then(Value::as_u64).filter(|n| (1..=1000).contains(n)).ok_or_else(|| format!("Invalid {key}."))?;
    Ok(value as u16)
}

fn parse_open(p: &Value) -> Result<Box<dyn Run>> {
    Ok(Box::new(Open { target: target_param(p)?, cols: dimension(p, "cols")?, rows: dimension(p, "rows")? }))
}

fn parse_read(p: &Value) -> Result<Box<dyn Run>> {
    let after = match p.get("after").filter(|v| !v.is_null()) {
        None => 0,
        Some(value) => value.as_u64().ok_or("Invalid after.")?,
    };
    let budget = page_budget(p)?.min(super::PAGE_BUDGET) - READ_OVERHEAD;
    Ok(Box::new(Read { terminal_id: terminal_id(p)?, after, budget }))
}

fn parse_write(p: &Value) -> Result<Box<dyn Run>> {
    // Not trimmed: spaces, newlines and control keys are the input.
    let data = p.get("data").and_then(Value::as_str).filter(|data| !data.is_empty() && data.len() <= MAX_INPUT).ok_or("Send between 1 byte and 16 KB of input.")?;
    Ok(Box::new(Write { terminal_id: terminal_id(p)?, data: data.to_owned() }))
}

fn parse_resize(p: &Value) -> Result<Box<dyn Run>> {
    Ok(Box::new(Resize { terminal_id: terminal_id(p)?, cols: dimension(p, "cols")?, rows: dimension(p, "rows")? }))
}

pub(crate) const METHODS: &[Method] = &[
    // Every terminal on the computer (desktop shells, harness consoles): Full only, as a
    // shell's output can carry anything the computer holds.
    Method { name: "terminal.list", access: Access::Full, read_only: true, parse: |_| Ok(Box::new(List)) },
    Method { name: "terminal.read", access: Access::Full, read_only: true, parse: parse_read },
    // A shell on the computer is an effect beyond any task: Full only, and opening or typing
    // into one also needs the host's "Full access for remote tasks" (`require_full_access`).
    Method { name: "terminal.open", access: Access::Full, read_only: false, parse: parse_open },
    Method { name: "terminal.write", access: Access::Full, read_only: false, parse: parse_write },
    Method { name: "terminal.resize", access: Access::Full, read_only: false, parse: parse_resize },
    Method { name: "terminal.close", access: Access::Full, read_only: false, parse: |p| Ok(Box::new(Close { terminal_id: terminal_id(p)? })) },
];

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(name: &str, params: Value) -> Result<Box<dyn Run>> {
        (super::super::find(name).unwrap().parse)(&params)
    }

    fn debug(name: &str, params: Value) -> String {
        format!("{:?}", parse(name, params).unwrap())
    }

    #[test]
    fn terminal_scopes_match_what_each_method_does() {
        for method in METHODS {
            let (access, read_only) = match method.name {
                "terminal.list" | "terminal.read" => (Access::Full, true),
                _ => (Access::Full, false),
            };
            assert_eq!((method.access, method.read_only), (access, read_only), "{}", method.name);
        }
        assert_eq!(METHODS.len(), 6);
    }

    #[test]
    fn typing_into_a_shell_needs_full_access_for_remote_tasks() {
        assert_eq!(require_full_access(false).unwrap_err(), NEEDS_FULL_ACCESS);
        assert!(NEEDS_FULL_ACCESS.contains("Full access for remote tasks"));
        assert!(require_full_access(true).is_ok());
        assert_eq!(require_full_access_to(false, EDIT_FILES).unwrap_err(), "Turn on Full access for remote tasks on this computer to edit files.");
        assert!(require_full_access_to(true, EDIT_FILES).is_ok());
        // Every call site checks it before acting; listing and reading expose the user's own
        // shell scrollback, so they are gated too.
        let source = include_str!("terminal.rs");
        for method in ["impl Run for List", "impl Run for Open", "impl Run for Read", "impl Run for Write", "impl Run for Resize", "impl Run for Close"] {
            let body = &source[source.find(method).unwrap()..];
            let body = &body[..body.find("\n}\n").unwrap()];
            let gate = body.find("require_full_access(ctx.full_access)?").unwrap_or_else(|| panic!("{method} checks the switch"));
            if let Some(visible) = body.find("ensure_visible(") {
                assert!(gate < visible, "{method}: the switch comes first");
            }
        }
        for name in ["terminal.list", "terminal.open", "terminal.read", "terminal.write", "terminal.resize", "terminal.close"] {
            assert!(super::super::SWITCH_METHODS.contains(&name), "{name} is listed as switch-gated");
        }
        for method in ["impl Run for Read", "impl Run for Write", "impl Run for Resize", "impl Run for Close"] {
            let body = &source[source.find(method).unwrap()..];
            let body = &body[..body.find("\n}\n").unwrap()];
            assert!(body.contains("ensure_visible(&ctx.state(), &self.terminal_id).await?"), "{method}");
        }
    }

    #[test]
    fn a_phone_may_keep_only_a_few_shells_open() {
        let mut phone = PhoneTerminals::default();
        let open = |_: &str| true;
        for n in 0..MAX_PHONE_TERMINALS {
            phone.reserve(&open).unwrap();
            phone.settle(Some(format!("t{n}")));
        }
        assert_eq!(phone.reserve(&open).unwrap_err(), TOO_MANY_TERMINALS);
        assert!(TOO_MANY_TERMINALS.contains(&MAX_PHONE_TERMINALS.to_string()));
        // Closing one frees a slot.
        assert!(phone.reserve(&|id: &str| id != "t0").is_ok());
        // Opens still starting count too, and a failed open gives its slot back.
        assert_eq!(phone.reserve(&open).unwrap_err(), TOO_MANY_TERMINALS);
        phone.settle(None);
        assert_eq!((phone.ids.len(), phone.starting), (3, 0));
        let source = include_str!("terminal.rs");
        let body = &source[source.find("impl Run for Open").unwrap()..];
        let body = &body[..body.find("\n}\n").unwrap()];
        assert!(body.find("Reservation::take(ctx.from)?").unwrap() < body.find("crate::start_terminal").unwrap());
    }

    #[test]
    fn bot_workspaces_and_mirrored_tasks_stay_hidden() {
        let refused = Refused { sessions: vec!["mirror".into()], roots: vec![PathBuf::from("/bots/b1")] };
        assert!(!refused.hides(None, "/work/app"));
        assert!(!refused.hides(Some("local"), "/work/app"));
        assert!(refused.hides(Some("mirror"), "/work/app"));
        assert!(refused.hides(None, "/bots/b1"));
        assert!(refused.hides(None, "/bots/b1/sub"));
        assert!(!refused.hides(None, "/bots/b10"));
    }

    #[test]
    fn terminal_open_needs_a_target_and_a_size() {
        assert_eq!(debug("terminal.open", json!({"sessionId": "s1", "projectId": "p1", "cols": 40, "rows": 20})), r#"Open { target: Task("s1"), cols: 40, rows: 20 }"#);
        assert!(debug("terminal.open", json!({"projectId": "p1", "cols": 80, "rows": 24})).contains(r#"Project("p1")"#));
        assert!(parse("terminal.open", json!({"cols": 80, "rows": 24})).is_err());
        for (cols, rows) in [(json!(0), json!(24)), (json!(80), json!(-1)), (json!("80"), json!(24)), (json!(80), json!(1001)), (json!(80.5), json!(24))] {
            assert!(parse("terminal.open", json!({"projectId": "p1", "cols": cols, "rows": rows})).is_err(), "{cols} {rows}");
        }
        assert!(parse("terminal.open", json!({"projectId": "bad id", "cols": 80, "rows": 24})).is_err());
    }

    #[test]
    fn terminal_read_validates_the_offset_and_bounds_the_page() {
        assert_eq!(debug("terminal.read", json!({"terminalId": "t1"})), format!("Read {{ terminal_id: \"t1\", after: 0, budget: {} }}", super::super::PAGE_BUDGET - READ_OVERHEAD));
        assert!(debug("terminal.read", json!({"terminalId": "t1", "after": 42})).contains("after: 42"));
        // A packing viewer's bigger budget is still held to one plain page.
        assert!(debug("terminal.read", json!({"terminalId": "t1", "budget": 10_000_000})).contains(&format!("budget: {}", super::super::PAGE_BUDGET - READ_OVERHEAD)));
        for bad in [json!({}), json!({"terminalId": ""}), json!({"terminalId": "t1", "after": -1}), json!({"terminalId": "t1", "after": "3"})] {
            assert!(parse("terminal.read", bad.clone()).is_err(), "{bad}");
        }
    }

    #[test]
    fn terminal_write_keeps_input_verbatim_and_caps_it() {
        assert!(debug("terminal.write", json!({"terminalId": "t1", "data": " \u{3}\r"})).contains(r#"data: " \u{3}\r""#));
        assert!(parse("terminal.write", json!({"terminalId": "t1", "data": ""})).is_err());
        assert!(parse("terminal.write", json!({"terminalId": "t1"})).is_err());
        assert!(parse("terminal.write", json!({"terminalId": "t1", "data": "x".repeat(MAX_INPUT + 1)})).is_err());
        assert!(parse("terminal.write", json!({"terminalId": "t1", "data": "x".repeat(MAX_INPUT)})).is_ok());
    }

    #[test]
    fn terminal_resize_and_close_need_an_id() {
        assert_eq!(debug("terminal.resize", json!({"terminalId": "t1", "cols": 38, "rows": 30})), r#"Resize { terminal_id: "t1", cols: 38, rows: 30 }"#);
        assert!(parse("terminal.resize", json!({"terminalId": "t1", "cols": 38})).is_err());
        assert_eq!(debug("terminal.close", json!({"terminalId": "t1"})), r#"Close { terminal_id: "t1" }"#);
        assert!(parse("terminal.close", json!({})).is_err());
        assert!(debug("terminal.list", json!({})).contains("List"));
    }
}
