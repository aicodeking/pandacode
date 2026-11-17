//! Tool row replacement and risk signals (`ui.presentation`, runtime phase R10, slice R1004).
//!
//! A trusted package can replace how one kind of built-in tool row reads in the transcript, and can attach risk signals to
//! it, under ADR-0005 (trust and the named grant are the safeguard; nothing here asks again per action). It is declarative:
//! the package names a **selector** (which rows) and a **row** (a sentence and an optional result card of host tokens), never
//! markup or code, so the host draws every pixel and the package never touches the row. The shapes are `contributes.toolRows`
//! in `schema-v1.json`; this module holds what the native side owns and rechecks:
//!
//! - `check_row`/`check_all`: the semantic validators (limits, closed vocabularies, known tokens);
//! - `gate`: the permission recheck (`PermissionDenied` without `ui.presentation` now; the `{input}`/`{output}` tokens also
//!   need `tasks.tools.read`, otherwise they read `[not granted]`);
//! - `select`: which declaration draws a row, falling back to the built-in row for safe mode, a revoked grant, no match, two
//!   packages claiming the same row and a faulted replacement (never an error, never half a row);
//! - `render`: the sentence and card with tokens filled from host facts, one line, bounded, and `[hidden]` whenever the
//!   host marked the call's text secret (the project's privacy and secret requirements are kept as the host holds them);
//! - `signals`: the risk signals a row shows, each with its provenance (`package` or `hook`; a hook-derived signal appears
//!   only when that same package decided the call, so a package cannot borrow another one's decision);
//! - `reconcile`/`risk_view`: the decision line and the risk chips. The native decision (approved, denied, pending) is the
//!   truth and a package's claim never overrides it; a built-in destructive signal is always kept and never lowered.
//!
//! No permanent safety-only exclusion is inferred from the upstream baseline: a destructive or failed row can be replaced
//! like any other, and its built-in badge, exit status and refusal state stay on screen next to the replacement. The state
//! is pure (no I/O, no clock). The interface twin is `src/extensions/runtime-tool-row-replacement.ts`.
use serde_json::Value;

/// The named permission (granted with the trust decision, rechecked on every request).
pub const PERMISSION: &str = "ui.presentation";
/// What `{input}` and `{output}` additionally need: the package may read the project's tool calls.
pub const READ_PERMISSION: &str = "tasks.tools.read";
pub const MAX_ROWS: usize = 16;
pub const MAX_SIGNALS: usize = 8;
pub const MAX_FIELDS: usize = 8;
pub const MAX_TITLE: usize = 80;
pub const MAX_SENTENCE: usize = 160;
pub const MAX_LABEL: usize = 24;
pub const MAX_SELECTOR_VALUE: usize = 96;
/// The text a token expands to is cut here (characters).
pub const MAX_TOKEN_CHARS: usize = 160;
pub const TOKENS: [&str; 8] = ["name", "kind", "family", "server", "status", "target", "input", "output"];
pub const RISKS: [&str; 3] = ["notice", "caution", "destructive"];
pub const WHEN: [&str; 7] = ["always", "failed", "blocked", "hook-approve", "hook-deny", "hook-ask", "hook-rewrite"];
const SELECTOR_KEYS: [&str; 4] = ["kind", "name", "family", "server"];
const ROW_KEYS: [&str; 6] = ["id", "title", "selector", "row", "card", "signals"];

fn chars(text: &str) -> usize { text.chars().count() }
fn text_within(value: &Value, max: usize) -> Option<&str> { value.as_str().filter(|text| !text.is_empty() && chars(text) <= max) }

/// Every `{token}` of `text` is a known token and no brace is left open.
fn tokens_known(text: &str) -> bool {
    let mut rest = text;
    while let Some(open) = rest.find(['{', '}']) {
        if rest.as_bytes()[open] == b'}' { return false; }
        let Some(close) = rest[open..].find('}') else { return false };
        if !TOKENS.contains(&&rest[open + 1..open + close]) { return false; }
        rest = &rest[open + close + 1..];
    }
    true
}

/// The frozen failure of one `toolRows` entry (`None` when it is valid).
pub fn check_row(row: &Value) -> Option<&'static str> {
    let Some(object) = row.as_object() else { return Some("InvalidShape") };
    if object.keys().any(|key| !ROW_KEYS.contains(&key.as_str())) { return Some("InvalidShape"); }
    if row["id"].as_str().map_or(true, |id| id.is_empty() || chars(id) > MAX_SELECTOR_VALUE) { return Some("InvalidShape"); }
    match row["title"].as_str() { Some(title) if !title.is_empty() => if chars(title) > MAX_TITLE { return Some("LimitExceeded") }, _ => return Some("InvalidShape") }
    // Selector: at least one of kind, name, family, server; closed keys; bounded text.
    let Some(selector) = row["selector"].as_object() else { return Some("InvalidShape") };
    if selector.is_empty() || selector.keys().any(|key| !SELECTOR_KEYS.contains(&key.as_str())) { return Some("InvalidShape"); }
    for value in selector.values() {
        match value.as_str() { Some(text) if !text.is_empty() => if chars(text) > MAX_SELECTOR_VALUE { return Some("LimitExceeded") }, _ => return Some("InvalidShape") }
    }
    // Row sentence.
    let Some(sentence) = row["row"]["sentence"].as_str() else { return Some("InvalidShape") };
    if sentence.is_empty() { return Some("InvalidShape"); }
    if chars(sentence) > MAX_SENTENCE { return Some("LimitExceeded"); }
    if !tokens_known(sentence) { return Some("InvalidShape"); }
    // Optional card: a title and up to eight label/value fields.
    if !row["card"].is_null() {
        let card = &row["card"];
        if text_within(&card["title"], MAX_TITLE).is_none() { return Some(if card["title"].as_str().is_some_and(|text| chars(text) > MAX_TITLE) { "LimitExceeded" } else { "InvalidShape" }); }
        let Some(fields) = card["fields"].as_array() else { return Some("InvalidShape") };
        if fields.len() > MAX_FIELDS { return Some("LimitExceeded"); }
        for field in fields {
            let label = field["label"].as_str().unwrap_or_default();
            if label.is_empty() { return Some("InvalidShape"); }
            if chars(label) > MAX_LABEL { return Some("LimitExceeded"); }
            let value = field["value"].as_str().unwrap_or_default();
            if value.is_empty() || !tokens_known(value) { return Some("InvalidShape"); }
            if chars(value) > MAX_SENTENCE { return Some("LimitExceeded"); }
        }
    }
    // Signals.
    if !row["signals"].is_null() {
        let Some(signals) = row["signals"].as_array() else { return Some("InvalidShape") };
        if signals.len() > MAX_SIGNALS { return Some("LimitExceeded"); }
        let mut seen: Vec<&str> = Vec::new();
        for signal in signals {
            let Some(id) = signal["id"].as_str().filter(|id| !id.is_empty()) else { return Some("InvalidShape") };
            if seen.contains(&id) { return Some("InvalidShape"); }
            seen.push(id);
            if !signal["risk"].as_str().is_some_and(|risk| RISKS.contains(&risk)) { return Some("InvalidShape"); }
            if !signal["when"].as_str().is_some_and(|when| WHEN.contains(&when)) { return Some("InvalidShape"); }
            match signal["label"].as_str() { Some(label) if !label.is_empty() => if chars(label) > MAX_LABEL { return Some("LimitExceeded") }, _ => return Some("InvalidShape") }
        }
    }
    None
}

/// The failure of a package's whole `toolRows` list: the bound, unique ids, then each entry.
pub fn check_all(list: &[Value]) -> Option<&'static str> {
    if list.len() > MAX_ROWS { return Some("LimitExceeded"); }
    let mut seen: Vec<&str> = Vec::new();
    for row in list {
        let Some(id) = row["id"].as_str() else { return Some("InvalidShape") };
        if seen.contains(&id) { return Some("InvalidShape"); }
        seen.push(id);
        if let Some(code) = check_row(row) { return Some(code); }
    }
    None
}

/// The permission recheck of a replaced row: a package without `ui.presentation` now is refused.
pub fn gate(holds: bool) -> Result<(), &'static str> { if holds { Ok(()) } else { Err("PermissionDenied") } }

/// What the host knows of one tool call, and may therefore hand to a replacement. `target`, `input` and `output` are the
/// host's own bounded, already redacted text; `secret` marks a call whose text must never leave the host.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Facts {
    pub kind: String, pub name: String, pub family: String, pub server: String, pub status: String,
    pub target: String, pub input: Option<String>, pub output: Option<String>,
    pub failed: bool, pub blocked: bool, pub secret: bool, pub builtin_destructive: bool,
}

/// Whether the selector names this row (every key it holds must equal the fact).
pub fn matches(selector: &Value, facts: &Facts) -> bool {
    let Some(object) = selector.as_object() else { return false };
    !object.is_empty() && object.iter().all(|(key, value)| {
        let want = value.as_str().unwrap_or_default();
        match key.as_str() { "kind" => facts.kind == want, "name" => facts.name == want, "family" => facts.family == want, "server" => facts.server == want, _ => false }
    })
}
/// How specific a selector is: a tool name beats a server, a server beats a family, a family beats a kind.
pub fn specificity(selector: &Value) -> u32 {
    [("name", 8), ("server", 4), ("family", 2), ("kind", 1)].iter().map(|(key, weight)| if selector.get(*key).is_some() { *weight } else { 0 }).sum()
}

/// One declaration offered for a row: the package's current standing and its `toolRows` entry.
#[derive(Clone, Debug, PartialEq)]
pub struct Candidate { pub owner: String, pub enabled: bool, pub holds: bool, pub read: bool, pub row: Value }
#[derive(Clone, Debug, PartialEq)]
pub enum Pick<'a> {
    /// The built-in row draws; the reason is one of `SafeMode`, `NoMatch`, `Revoked`, `Conflict`, `Faulted`.
    Builtin(&'static str),
    Replace(&'a Candidate),
}

/// Which declaration draws `facts`. `faulted` pairs (owner, row id) whose replacement failed to draw earlier: they are
/// skipped for the rest of the session. Disabled packages and safe mode leave the built-in row; a revoked grant too.
pub fn select<'a>(candidates: &'a [Candidate], facts: &Facts, safe_mode: bool, faulted: &[(String, String)]) -> Pick<'a> {
    if safe_mode { return Pick::Builtin("SafeMode"); }
    let mut revoked = false;
    let mut broken = false;
    let mut live: Vec<(&Candidate, u32)> = Vec::new();
    for candidate in candidates.iter().filter(|candidate| candidate.enabled) {
        if check_row(&candidate.row).is_some() || !matches(&candidate.row["selector"], facts) { continue; }
        if gate(candidate.holds).is_err() { revoked = true; continue; }
        let id = candidate.row["id"].as_str().unwrap_or_default();
        if faulted.iter().any(|(owner, row)| *owner == candidate.owner && row == id) { broken = true; continue; }
        live.push((candidate, specificity(&candidate.row["selector"])));
    }
    let Some(best) = live.iter().map(|(_, weight)| *weight).max() else { return Pick::Builtin(if broken { "Faulted" } else if revoked { "Revoked" } else { "NoMatch" }) };
    let top: Vec<&Candidate> = live.iter().filter(|(_, weight)| *weight == best).map(|(candidate, _)| *candidate).collect();
    // Two different packages claiming the same row equally is a conflict: neither wins, the built-in row draws.
    if top.iter().any(|candidate| candidate.owner != top[0].owner) { return Pick::Builtin("Conflict"); }
    Pick::Replace(top[0])
}

fn clean(text: &str) -> String {
    let line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let line: String = line.chars().filter(|c| !c.is_control()).collect();
    if chars(&line) > MAX_TOKEN_CHARS { format!("{}…", line.chars().take(MAX_TOKEN_CHARS - 1).collect::<String>()) } else { line }
}
fn token(name: &str, facts: &Facts, read: bool) -> String {
    let private = |text: &str| if facts.secret { "[hidden]".to_owned() } else { clean(text) };
    match name {
        "name" => clean(&facts.name), "kind" => clean(&facts.kind), "family" => clean(&facts.family), "server" => clean(&facts.server), "status" => clean(&facts.status),
        "target" => private(&facts.target),
        "input" => if !read { "[not granted]".to_owned() } else { facts.input.as_deref().map_or_else(String::new, private) },
        "output" => if !read { "[not granted]".to_owned() } else { facts.output.as_deref().map_or_else(String::new, private) },
        _ => String::new(),
    }
}
/// `text` with every `{token}` filled from the host's facts (a valid row only uses known tokens).
pub fn fill(text: &str, facts: &Facts, read: bool) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let Some(close) = rest[open..].find('}') else { break };
        out.push_str(&token(&rest[open + 1..open + close], facts, read));
        rest = &rest[open + close + 1..];
    }
    out.push_str(rest);
    clean(&out)
}
#[derive(Clone, Debug, PartialEq)]
pub struct Rendered { pub sentence: String, pub card_title: Option<String>, pub fields: Vec<(String, String)> }
/// The sentence and card of a replaced row, drawn by the host from the package's declaration.
pub fn render(row: &Value, facts: &Facts, read: bool) -> Rendered {
    let sentence = fill(row["row"]["sentence"].as_str().unwrap_or_default(), facts, read);
    let (card_title, fields) = match row["card"]["fields"].as_array() {
        Some(fields) => (row["card"]["title"].as_str().map(clean), fields.iter().map(|field| (clean(field["label"].as_str().unwrap_or_default()), fill(field["value"].as_str().unwrap_or_default(), facts, read))).collect()),
        None => (None, Vec::new()),
    };
    Rendered { sentence, card_title, fields }
}

/// One risk signal on a row with its provenance: `package` (declared, drawn from the row's own state) or `hook` (derived from
/// a decision this package returned for the call, named in `decision`).
#[derive(Clone, Debug, PartialEq)]
pub struct Signal { pub id: String, pub risk: String, pub label: String, pub source: &'static str, pub owner: String, pub decision: Option<String> }
/// What a hook decided for the call: the decision and the package that returned it (`decidedBy`, runtime_hook_decisions).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HookClaim<'a> { pub decision: &'a str, pub by: &'a str }
/// The signals `owner`'s row shows now. A `hook-*` signal needs a claim by this very package for that decision.
pub fn signals(row: &Value, owner: &str, facts: &Facts, claim: Option<HookClaim>) -> Vec<Signal> {
    let mut out = Vec::new();
    for signal in row["signals"].as_array().map(Vec::as_slice).unwrap_or_default() {
        let when = signal["when"].as_str().unwrap_or_default();
        let (live, source, decision) = match when {
            "always" => (true, "package", None),
            "failed" => (facts.failed, "package", None),
            "blocked" => (facts.blocked, "package", None),
            hook => {
                let wanted = hook.strip_prefix("hook-").unwrap_or_default();
                match claim { Some(held) if held.by == owner && held.decision == wanted => (true, "hook", Some(wanted.to_owned())), _ => (false, "hook", None) }
            }
        };
        if live { out.push(Signal { id: signal["id"].as_str().unwrap_or_default().to_owned(), risk: signal["risk"].as_str().unwrap_or("notice").to_owned(), label: clean(signal["label"].as_str().unwrap_or_default()), source, owner: owner.to_owned(), decision }); }
    }
    out
}

/// A chip on a row: `builtin` for the host's own destructive badge, else the signal's provenance.
#[derive(Clone, Debug, PartialEq)]
pub struct Chip { pub label: String, pub risk: String, pub source: &'static str, pub owner: Option<String>, pub decision: Option<String> }
fn level(risk: &str) -> u8 { RISKS.iter().position(|name| *name == risk).map_or(0, |at| at as u8) }
/// The chips of a row, highest risk first. The host's destructive badge is always first and always kept: a package adds
/// signals, it never hides, lowers or replaces the built-in one.
pub fn risk_view(builtin_destructive: bool, signals: &[Signal]) -> Vec<Chip> {
    let mut out = Vec::new();
    if builtin_destructive { out.push(Chip { label: "destructive".to_owned(), risk: "destructive".to_owned(), source: "builtin", owner: None, decision: None }); }
    let mut added: Vec<&Signal> = signals.iter().collect();
    added.sort_by_key(|signal| std::cmp::Reverse(level(&signal.risk)));
    out.extend(added.into_iter().map(|signal| Chip { label: signal.label.clone(), risk: signal.risk.clone(), source: signal.source, owner: Some(signal.owner.clone()), decision: signal.decision.clone() }));
    out
}

/// The decision line of a row.
#[derive(Clone, Debug, PartialEq)]
pub struct Line { pub state: String, pub by: String, pub overruled: Option<String> }
/// What the row says about approval. The native state (`approved`, `denied`, `pending`, `none`) is the truth; `decided_by` is
/// the package the host recorded for it (`decidedBy`) or `None` for the user or the mode. A package's claim only fills in
/// who decided when it agrees with the native state; when it disagrees the claim is listed as `overruled` and never shown as
/// the outcome, so a native denial or approval is never misreported.
pub fn reconcile(native: &str, decided_by: Option<&str>, claim: Option<HookClaim>) -> Line {
    let agrees = |claimed: &str| matches!((claimed, native), ("approve" | "rewrite", "approved") | ("deny", "denied") | ("ask", "pending"));
    let by = decided_by.map_or_else(|| "host".to_owned(), str::to_owned);
    let overruled = claim.filter(|held| !agrees(held.decision)).map(|held| format!("{} {}", held.by, held.decision));
    Line { state: native.to_owned(), by, overruled }
}

/// A fault while a replacement draws is remembered for the session and the row falls back to the built-in one.
pub fn remember_fault(faulted: &mut Vec<(String, String)>, owner: &str, row_id: &str) {
    if !faulted.iter().any(|(who, id)| who == owner && id == row_id) { faulted.push((owner.to_owned(), row_id.to_owned())); }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn row(id: &str, selector: Value) -> Value {
        json!({"id": id, "title": "Shell", "selector": selector, "row": {"sentence": "{name} ran {target}"},
               "card": {"title": "Run", "fields": [{"label": "Status", "value": "{status}"}, {"label": "Output", "value": "{output}"}]},
               "signals": [{"id": "d", "risk": "destructive", "label": "Wipes data", "when": "hook-deny"}, {"id": "f", "risk": "caution", "label": "Failed", "when": "failed"}]})
    }
    fn facts() -> Facts { Facts { kind: "shell".into(), name: "Bash".into(), status: "completed".into(), target: "git status".into(), output: Some("clean".into()), ..Facts::default() } }
    fn candidate(owner: &str, row: Value) -> Candidate { Candidate { owner: owner.into(), enabled: true, holds: true, read: true, row } }

    #[test]
    fn a_row_is_valid_only_with_a_closed_selector_known_tokens_and_bounded_text() {
        assert_eq!(check_row(&row("a", json!({"kind": "shell"}))), None);
        assert_eq!(check_row(&row("a", json!({}))), Some("InvalidShape"));
        assert_eq!(check_row(&row("a", json!({"color": "red"}))), Some("InvalidShape"));
        let mut bad = row("a", json!({"kind": "shell"})); bad["row"]["sentence"] = json!("{secret} ran");
        assert_eq!(check_row(&bad), Some("InvalidShape"));
        bad["row"]["sentence"] = json!("x".repeat(161)); assert_eq!(check_row(&bad), Some("LimitExceeded"));
        let mut open = row("a", json!({"kind": "shell"})); open["row"]["sentence"] = json!("{name"); assert_eq!(check_row(&open), Some("InvalidShape"));
        let mut risk = row("a", json!({"kind": "shell"})); risk["signals"][0]["risk"] = json!("fatal"); assert_eq!(check_row(&risk), Some("InvalidShape"));
        let mut when = row("a", json!({"kind": "shell"})); when["signals"][0]["when"] = json!("hook-teleport"); assert_eq!(check_row(&when), Some("InvalidShape"));
        let mut long = row("a", json!({"kind": "shell"})); long["signals"][0]["label"] = json!("x".repeat(25)); assert_eq!(check_row(&long), Some("LimitExceeded"));
        let many: Vec<Value> = (0..17).map(|n| row(&format!("r{n}"), json!({"kind": "shell"}))).collect();
        assert_eq!(check_all(&many), Some("LimitExceeded"));
        assert_eq!(check_all(&many[..16]), None);
        assert_eq!(check_all(&[many[0].clone(), many[0].clone()]), Some("InvalidShape"));
    }

    #[test]
    fn the_most_specific_declaration_draws_and_equal_claims_by_two_packages_fall_back() {
        let broad = candidate("a.b", row("broad", json!({"kind": "shell"})));
        let narrow = candidate("a.b", row("narrow", json!({"kind": "shell", "name": "Bash"})));
        assert_eq!(select(&[broad.clone(), narrow.clone()], &facts(), false, &[]), Pick::Replace(&narrow));
        let rival = candidate("c.d", row("rival", json!({"kind": "shell"})));
        assert_eq!(select(&[broad.clone(), rival.clone()], &facts(), false, &[]), Pick::Builtin("Conflict"));
        // A more specific one from another package wins without conflict.
        assert_eq!(select(&[rival, narrow.clone()], &facts(), false, &[]), Pick::Replace(&narrow));
        let stale = candidate("a.b", row("stale", json!({"name": "Gone"})));
        assert_eq!(select(&[stale], &facts(), false, &[]), Pick::Builtin("NoMatch"));
    }

    #[test]
    fn safe_mode_disable_revoke_and_a_fault_restore_the_built_in_row() {
        let live = candidate("a.b", row("r", json!({"kind": "shell"})));
        assert_eq!(select(&[live.clone()], &facts(), true, &[]), Pick::Builtin("SafeMode"));
        let mut off = live.clone(); off.enabled = false;
        assert_eq!(select(&[off], &facts(), false, &[]), Pick::Builtin("NoMatch"));
        let mut revoked = live.clone(); revoked.holds = false;
        assert_eq!(select(&[revoked], &facts(), false, &[]), Pick::Builtin("Revoked"));
        let mut faulted = Vec::new();
        remember_fault(&mut faulted, "a.b", "r"); remember_fault(&mut faulted, "a.b", "r");
        assert_eq!(faulted.len(), 1);
        assert_eq!(select(&[live.clone()], &facts(), false, &faulted), Pick::Builtin("Faulted"));
        assert_eq!(gate(true), Ok(())); assert_eq!(gate(false), Err("PermissionDenied"));
        // A destructive or failed row is replaceable like any other: no safety-only exclusion.
        let mut danger = facts(); danger.builtin_destructive = true; danger.failed = true;
        assert!(matches!(select(&[live], &danger, false, &[]), Pick::Replace(_)));
    }

    #[test]
    fn tokens_are_filled_from_host_facts_one_line_and_never_leak_a_secret() {
        let declared = row("r", json!({"kind": "shell"}));
        let drawn = render(&declared, &facts(), true);
        assert_eq!(drawn.sentence, "Bash ran git status");
        assert_eq!(drawn.fields, vec![("Status".to_owned(), "completed".to_owned()), ("Output".to_owned(), "clean".to_owned())]);
        // Without tasks.tools.read the output is not handed over.
        assert_eq!(render(&declared, &facts(), false).fields[1].1, "[not granted]");
        let mut secret = facts(); secret.secret = true;
        let hidden = render(&declared, &secret, true);
        assert_eq!(hidden.sentence, "Bash ran [hidden]");
        assert_eq!(hidden.fields[1].1, "[hidden]");
        let mut wide = facts(); wide.target = format!("a\n\tb{}", "x".repeat(400));
        let line = render(&declared, &wide, true).sentence;
        assert!(!line.contains('\n') && line.chars().count() <= MAX_TOKEN_CHARS);
    }

    #[test]
    fn hook_signals_need_the_deciding_package_and_the_built_in_badge_is_kept() {
        let declared = row("r", json!({"kind": "shell"}));
        let mut failed = facts(); failed.failed = true;
        let own = HookClaim { decision: "deny", by: "a.b" };
        let found = signals(&declared, "a.b", &failed, Some(own));
        assert_eq!(found.iter().map(|signal| (signal.id.as_str(), signal.source)).collect::<Vec<_>>(), vec![("d", "hook"), ("f", "package")]);
        // Another package's decision never lights this package's hook signal.
        let theirs = HookClaim { decision: "deny", by: "c.d" };
        assert_eq!(signals(&declared, "a.b", &facts(), Some(theirs)), vec![]);
        assert_eq!(signals(&declared, "a.b", &facts(), Some(HookClaim { decision: "ask", by: "a.b" })), vec![]);
        let chips = risk_view(true, &found);
        assert_eq!(chips[0].source, "builtin");
        assert_eq!(chips.iter().map(|chip| chip.risk.as_str()).collect::<Vec<_>>(), vec!["destructive", "destructive", "caution"]);
        // A package that declares only a "notice" cannot hide the built-in destructive chip.
        assert_eq!(risk_view(true, &[])[0].label, "destructive");
        assert_eq!(risk_view(false, &[]), vec![]);
    }

    #[test]
    fn the_native_decision_is_the_truth_and_a_package_claim_never_overrides_it() {
        let claim = Some(HookClaim { decision: "approve", by: "a.b" });
        assert_eq!(reconcile("approved", Some("a.b"), claim), Line { state: "approved".into(), by: "a.b".into(), overruled: None });
        // The user denied after the package approved: the row says denied.
        let overruled = reconcile("denied", None, claim);
        assert_eq!((overruled.state.as_str(), overruled.by.as_str(), overruled.overruled.as_deref()), ("denied", "host", Some("a.b approve")));
        let denied = reconcile("denied", Some("a.b"), Some(HookClaim { decision: "deny", by: "a.b" }));
        assert_eq!(denied.overruled, None);
        // No claim: the native line stands alone.
        assert_eq!(reconcile("pending", None, None), Line { state: "pending".into(), by: "host".into(), overruled: None });
    }
}
