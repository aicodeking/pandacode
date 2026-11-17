//! What a trusted package that holds `ui.presentation` may put beside two things the host used to keep to itself (runtime
//! phase R10, slice R1003).
//!
//! * **Hook notes on tool and approval rows.** A `note` returned by a hook is shown with the name of the package that wrote
//!   it; the decision line names the package that decided. Both come from the same fold ([`row`]), and the deciding package
//!   must agree with the `decidedBy` the host recorded for the call ([`reconcile`]): a disagreement withholds the decision
//!   label, never the note.
//! * **The extras of eight dialogs that were protected**: remove-project, delete-task, delete-bot, delete-cloud,
//!   worktree-cleanup, provider-connections, machine-link and skill-add. The band is the one of every eligible dialog
//!   (owner-labelled notes and secondary actions after the host content, outside every form), so the host's fields, primary
//!   action, confirmation, Escape policy and initial focus are untouched. `github-behind` (the recovery choice) stays
//!   built-in and `extension-form` stays the owning package's alone.
//!
//! Everything here is for fault isolation and predictability (ADR-0005): a slow or broken extra ([`isolate`]), a disabled
//! package, a revoked grant or safe mode never changes what the host decides or asks; they only remove the extra. The
//! webview twin is src/extensions/runtime-protected-presentation.ts; the shared fixture is
//! tests/fixtures/extensions/runtime-protected-presentation/cases.json.
use serde_json::{json, Value};
use std::{sync::mpsc, time::Duration};

use crate::extensions::runtime_hook_decisions::{Outcome, Verdict};

pub const PERMISSION: &str = "ui.presentation";
pub const CONTRIBUTE: &str = "ui.contribute";
/// Notes shown per dialog across packages; the rest is summarized as a count.
pub const MAX_DIALOG_NOTES: usize = 8;
/// A package's extra gets this long before the host stops waiting for it (the dialog never waits at all).
pub const EXTRA_BUDGET_MS: u64 = 1_500;
/// The eight dialogs this slice opens: `(dialog id, captured target)`.
pub const EXTRA_DIALOGS: [(&str, &str); 8] = [
    ("remove-project", "project"), ("delete-task", "task"), ("delete-bot", "none"), ("delete-cloud", "none"),
    ("worktree-cleanup", "task"), ("provider-connections", "none"), ("machine-link", "none"), ("skill-add", "none"),
];
/// The recovery choice must work when a package is what is broken.
pub const BUILT_IN_ONLY: [&str; 1] = ["github-behind"];
/// A package's own form is itself the accessory surface; another package's content is never placed inside it.
pub const OWNER_ONLY: [&str; 1] = ["extension-form"];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Policy { Extras, BuiltIn, OwnerOnly, Ordinary }
impl Policy {
    pub fn name(self) -> &'static str { match self { Policy::Extras => "extras", Policy::BuiltIn => "built-in", Policy::OwnerOnly => "owner-only", Policy::Ordinary => "ordinary" } }
}
/// How the host treats a dialog id; `Ordinary` is every other dialog (the band of docs/extensions/core-dialogs.md, no extra permission).
pub fn policy(dialog: &str) -> Policy {
    if EXTRA_DIALOGS.iter().any(|(id, _)| *id == dialog) { Policy::Extras }
    else if BUILT_IN_ONLY.contains(&dialog) { Policy::BuiltIn }
    else if OWNER_ONLY.contains(&dialog) { Policy::OwnerOnly }
    else { Policy::Ordinary }
}
/// The captured target of one of the eight (`None` for any other dialog).
pub fn target(dialog: &str) -> Option<&'static str> { EXTRA_DIALOGS.iter().find(|(id, _)| *id == dialog).map(|(_, target)| *target) }
/// The permissions a package must hold for its extra to show in `dialog`.
pub fn required_permissions(dialog: &str) -> Vec<&'static str> {
    if policy(dialog) == Policy::Extras { vec![CONTRIBUTE, PERMISSION] } else { vec![CONTRIBUTE] }
}
/// Whether a manifest may name `dialog` in `dialogExtras` with these permissions (the manifest check of both validators).
pub fn manifest_allows(dialog: &str, permissions: &[String]) -> bool {
    match policy(dialog) {
        Policy::BuiltIn | Policy::OwnerOnly => false,
        _ => required_permissions(dialog).iter().all(|needed| permissions.iter().any(|held| held == needed)),
    }
}

fn one_line(text: &str) -> String { text.split_whitespace().collect::<Vec<_>>().join(" ") }

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Contribution { pub owner: String, pub name: String, pub id: String, pub dialog: String, pub text: String, pub permissions: Vec<String>, pub enabled: bool }
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Note { pub owner: String, pub name: String, pub id: String, pub text: String }
impl Note { pub fn line(&self) -> String { format!("{}: {}", self.name, self.text) } }
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Shown { pub notes: Vec<Note>, pub omitted: usize }
impl Shown {
    /// The summary line of notes past the bound.
    pub fn omitted_line(&self) -> Option<String> { (self.omitted > 0).then(|| format!("{} more extension notes are not shown.", self.omitted)) }
}

/// The notes a dialog shows now. Nothing shows in safe mode, for a built-in-only dialog, or from a package that is disabled or
/// lacks a permission (so disabling, revoking or safe mode clears the extras at the next draw and the host dialog stays whole).
/// An owner-only dialog shows only the notes of `form_owner`. `order` is the user's package order (a package outside it follows,
/// by id).
pub fn visible(contributions: &[Contribution], dialog: &str, safe_mode: bool, order: &[String], form_owner: Option<&str>) -> Shown {
    let kind = policy(dialog);
    if safe_mode || kind == Policy::BuiltIn { return Shown::default(); }
    let required = required_permissions(dialog);
    let rank = |owner: &str| order.iter().position(|item| item == owner).unwrap_or(order.len());
    let mut chosen: Vec<(usize, &Contribution)> = contributions.iter().enumerate()
        .filter(|(_, item)| item.dialog == dialog && item.enabled && required.iter().all(|needed| item.permissions.iter().any(|held| held == needed)))
        .filter(|(_, item)| kind != Policy::OwnerOnly || Some(item.owner.as_str()) == form_owner)
        .collect();
    chosen.sort_by(|(left_at, left), (right_at, right)| rank(&left.owner).cmp(&rank(&right.owner)).then_with(|| left.owner.cmp(&right.owner)).then_with(|| left_at.cmp(right_at)));
    let all: Vec<Note> = chosen.into_iter()
        .map(|(_, item)| Note { owner: item.owner.clone(), name: item.name.clone(), id: item.id.clone(), text: one_line(&item.text) })
        .filter(|note| !note.text.is_empty())
        .collect();
    let omitted = all.len().saturating_sub(MAX_DIALOG_NOTES);
    Shown { notes: all.into_iter().take(MAX_DIALOG_NOTES).collect(), omitted }
}

// ---- Tool and approval rows ----------------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind { Approve, Deny, Ask, None }
impl Kind { pub fn name(self) -> &'static str { match self { Kind::Approve => "approve", Kind::Deny => "deny", Kind::Ask => "ask", Kind::None => "none" } } }
/// A tool or approval row: its notes (each with the name of the package that wrote it) and the package that decided.
#[derive(Clone, Debug, PartialEq)]
pub struct Row { pub kind: Kind, pub decider: Option<Verdict>, pub rewritten: bool, pub notes: Vec<(String, String)> }

/// The row of one call from the fold's outcome and its `(package name, note)` pairs.
pub fn row(outcome: &Outcome, notes: &[(String, String)]) -> Row {
    let (kind, decider, rewritten) = match outcome {
        Outcome::None => (Kind::None, None, false),
        Outcome::Approve { by, input } => (Kind::Approve, Some(by.clone()), input.as_ref().is_some_and(|value| !value.is_null())),
        Outcome::Deny(by) => (Kind::Deny, Some(by.clone()), false),
        Outcome::Ask(by) => (Kind::Ask, Some(by.clone()), false),
    };
    let notes = notes.iter().map(|(name, text)| (name.clone(), one_line(text))).filter(|(_, text)| !text.is_empty()).collect();
    Row { kind, decider, rewritten, notes }
}
/// The deciding package must be the one the host recorded for the call (`tool.after`'s `decidedBy`); otherwise the decision
/// label is withheld.
pub fn reconcile(source: &Row, decided_by: Option<&str>) -> Row {
    match (&source.decider, decided_by) {
        (Some(by), Some(recorded)) if by.owner != recorded => Row { kind: Kind::None, decider: None, rewritten: false, notes: source.notes.clone() },
        _ => source.clone(),
    }
}
/// An approve or a deny names `decided_by`; an ask records none (the user decides); no decider means none recorded.
pub fn agrees(source: &Row, decided_by: Option<&str>) -> bool {
    match &source.decider {
        None => decided_by.is_none(),
        Some(by) if source.kind == Kind::Ask => decided_by.is_none() || decided_by == Some(by.owner.as_str()),
        Some(by) => decided_by == Some(by.owner.as_str()),
    }
}
/// The lines of a tool or approval row: the notes first, each named, then what the deciding package did, named.
pub fn lines(source: &Row, tool: &str) -> Vec<String> {
    let mut out: Vec<String> = source.notes.iter().map(|(name, text)| format!("{name}: {text}")).collect();
    let Some(by) = &source.decider else { return out };
    let reason = by.reason.as_deref().filter(|text| !text.is_empty()).map(|text| format!(" {text}")).unwrap_or_default();
    match source.kind {
        Kind::Approve => out.push(format!("{tool} approved by {}{}.{reason}", by.name, if source.rewritten { " with rewritten arguments" } else { "" })),
        Kind::Deny => out.push(format!("{tool} denied by {}.{reason}", by.name)),
        Kind::Ask => out.push(match by.reason.as_deref().filter(|text| !text.is_empty()) {
            Some(text) if !by.failed => format!("{} asks you to decide: {text}", by.name),
            Some(text) => format!("{text} Decide yourself."),
            None => format!("{} asks you to decide.", by.name),
        }),
        Kind::None => {}
    }
    out
}
/// What the approval prompt appends to its text: the lines of an `ask` or of a call nobody decided (a note on a prompt the
/// user still answers). Decisions the host already acted on go to the transcript instead.
pub fn prompt_suffix(source: &Row, tool: &str) -> Option<String> {
    if !matches!(source.kind, Kind::Ask | Kind::None) { return None; }
    let all = lines(source, tool);
    (!all.is_empty()).then(|| all.join("\n"))
}
pub fn row_json(source: &Row, tool: &str, decided_by: Option<&str>) -> Value {
    json!({"kind": source.kind.name(), "decidedBy": source.decider.as_ref().map(|by| by.owner.clone()), "agrees": agrees(source, decided_by), "lines": lines(source, tool)})
}

// ---- A slow or broken extra ----------------------------------------------------------------------------------------------

/// Runs one package's extra apart from the host. A panic or a missed budget becomes a code (`Failed`, `Timeout`), never an
/// exception, and the caller keeps its own decision. A late worker is left to finish on its own thread and its answer is dropped.
pub fn isolate<T: Send + 'static>(budget: Duration, work: impl FnOnce() -> T + Send + 'static) -> Result<T, &'static str> {
    let (send, receive) = mpsc::channel();
    let spawned = std::thread::Builder::new().name("extension-extra".into()).spawn(move || {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(work));
        let _ = send.send(result);
    });
    if spawned.is_err() { return Err("Failed"); }
    match receive.recv_timeout(budget) {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(_)) => Err("Failed"),
        Err(mpsc::RecvTimeoutError::Timeout) => Err("Timeout"),
        Err(mpsc::RecvTimeoutError::Disconnected) => Err("Failed"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CASES: &str = include_str!("../../../tests/fixtures/extensions/runtime-protected-presentation/cases.json");
    fn cases() -> Value { serde_json::from_str(CASES).unwrap() }
    fn text(value: &Value, key: &str) -> String { value[key].as_str().unwrap().to_owned() }
    fn list(value: &Value) -> Vec<String> { value.as_array().unwrap().iter().map(|item| item.as_str().unwrap().to_owned()).collect() }

    fn contribution(value: &Value) -> Contribution {
        Contribution { owner: text(value, "owner"), name: text(value, "name"), id: text(value, "id"), dialog: text(value, "dialog"), text: text(value, "text"), permissions: list(&value["permissions"]), enabled: value["enabled"].as_bool().unwrap() }
    }
    fn verdict(value: &Value) -> Verdict {
        Verdict { owner: text(value, "owner"), name: text(value, "name"), reason: value["reason"].as_str().map(str::to_owned), failed: value["failed"].as_bool().unwrap() }
    }
    fn outcome(value: &Value) -> Outcome {
        match value["kind"].as_str().unwrap() {
            "approve" => Outcome::Approve { by: verdict(&value["by"]), input: value.get("input").cloned() },
            "deny" => Outcome::Deny(verdict(&value["by"])),
            "ask" => Outcome::Ask(verdict(&value["by"])),
            _ => Outcome::None,
        }
    }

    #[test]
    fn the_policy_of_every_dialog_matches_the_fixture() {
        for case in cases()["policy"].as_array().unwrap() {
            let dialog = text(case, "dialog");
            assert_eq!(policy(&dialog).name(), case["policy"].as_str().unwrap(), "{dialog}");
            assert_eq!(required_permissions(&dialog), list(&case["required"]), "{dialog}");
            assert_eq!(target(&dialog), case["target"].as_str(), "{dialog}");
        }
        assert_eq!(EXTRA_DIALOGS.len(), 8);
    }

    #[test]
    fn a_manifest_names_a_protected_dialog_only_with_ui_presentation() {
        let both = vec![CONTRIBUTE.to_owned(), PERMISSION.to_owned()];
        let plain = vec![CONTRIBUTE.to_owned()];
        for (dialog, _) in EXTRA_DIALOGS { assert!(manifest_allows(dialog, &both), "{dialog}"); assert!(!manifest_allows(dialog, &plain), "{dialog}"); }
        for dialog in ["github-behind", "extension-form"] { assert!(!manifest_allows(dialog, &both), "{dialog}"); }
        assert!(manifest_allows("usage", &plain));
    }

    #[test]
    fn the_notes_of_a_dialog_follow_the_fixture() {
        for case in cases()["visible"].as_array().unwrap() {
            let label = text(case, "id");
            let mut all: Vec<Contribution> = case.get("contributions").and_then(Value::as_array).map(|items| items.iter().map(contribution).collect()).unwrap_or_default();
            if let Some(fill) = case.get("fill") {
                let permissions = list(&fill["permissions"]);
                for index in 1..=fill["count"].as_u64().unwrap() {
                    all.push(Contribution { owner: format!("sample.n{index:02}"), name: format!("Pkg {index:02}"), id: format!("sample.n{index:02}/note"), dialog: text(case, "dialog"), text: format!("note {index:02}"), permissions: permissions.clone(), enabled: true });
                }
            }
            let order = case.get("order").map(list).unwrap_or_default();
            let shown = visible(&all, &text(case, "dialog"), case["safeMode"].as_bool().unwrap(), &order, case["formOwner"].as_str());
            let expect = &case["expect"];
            if let Some(ids) = expect.get("ids") { assert_eq!(shown.notes.iter().map(|note| note.id.clone()).collect::<Vec<_>>(), list(ids), "{label}"); }
            if let Some(expected) = expect.get("lines") { assert_eq!(shown.notes.iter().map(Note::line).collect::<Vec<_>>(), list(expected), "{label}"); }
            if let Some(count) = expect.get("count") { assert_eq!(shown.notes.len() as u64, count.as_u64().unwrap(), "{label}"); }
            assert_eq!(shown.omitted as u64, expect["omitted"].as_u64().unwrap(), "{label}");
            assert_eq!(shown.omitted_line(), expect["omittedLine"].as_str().map(str::to_owned), "{label}");
        }
    }

    #[test]
    fn tool_and_approval_rows_name_the_deciding_package_and_agree_with_decided_by() {
        for case in cases()["rows"].as_array().unwrap() {
            let label = text(case, "id");
            let notes: Vec<(String, String)> = case["notes"].as_array().unwrap().iter().map(|pair| (pair[0].as_str().unwrap().to_owned(), pair[1].as_str().unwrap().to_owned())).collect();
            let source = row(&outcome(&case["resolution"]), &notes);
            let recorded = case["decidedBy"].as_str();
            let expect = &case["expect"];
            assert_eq!(source.kind.name(), expect["kind"].as_str().unwrap(), "{label}");
            assert_eq!(source.decider.as_ref().map(|by| by.owner.as_str()), expect["decidedBy"].as_str(), "{label}");
            assert_eq!(agrees(&source, recorded), expect["agrees"].as_bool().unwrap(), "{label}");
            assert_eq!(lines(&source, &text(case, "tool")), list(&expect["lines"]), "{label}");
            if let Some(kind) = expect["reconciledKind"].as_str() {
                let kept = reconcile(&source, recorded);
                assert_eq!(kept.kind.name(), kind, "{label}");
                assert!(kept.decider.is_none(), "{label}");
                assert_eq!(lines(&kept, &text(case, "tool")), list(&expect["reconciledLines"]), "{label}");
                assert!(agrees(&kept, None), "{label}");
            } else {
                assert_eq!(reconcile(&source, recorded), source, "{label}");
            }
        }
    }

    #[test]
    fn only_an_ask_or_an_undecided_call_adds_to_the_prompt() {
        let by = Verdict { owner: "sample.guard".into(), name: "Guard".into(), reason: Some("Unusual flag.".into()), failed: false };
        let asked = row(&Outcome::Ask(by.clone()), &[("Watcher".into(), "Saw rm.".into())]);
        assert_eq!(prompt_suffix(&asked, "Bash").unwrap(), "Watcher: Saw rm.\nGuard asks you to decide: Unusual flag.");
        assert_eq!(prompt_suffix(&row(&Outcome::None, &[("Watcher".into(), "Saw rm.".into())]), "Bash").unwrap(), "Watcher: Saw rm.");
        assert!(prompt_suffix(&row(&Outcome::Deny(by.clone()), &[]), "Bash").is_none());
        assert!(prompt_suffix(&row(&Outcome::None, &[]), "Bash").is_none());
    }

    #[test]
    fn a_slow_or_broken_extra_is_reported_and_never_throws() {
        assert_eq!(isolate(Duration::from_millis(500), || 7).unwrap(), 7);
        assert_eq!(isolate(Duration::from_millis(50), || { std::thread::sleep(Duration::from_millis(400)); 1 }).unwrap_err(), "Timeout");
        assert_eq!(isolate::<u8>(Duration::from_millis(500), || panic!("broken extra")).unwrap_err(), "Failed");
    }
}
