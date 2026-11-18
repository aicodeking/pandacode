//! Intent rules for the command-line tools of a package (runtime phase R7, slice R0705).
//!
//! * **Declaration.** `contributes.cliIntents[]` (`id`, `command`, `words`, `flags`, `intent`) says what one operation of
//!   a package's command-line tool is, so the host's transcript and approval rows name it. The shape is checked twice
//!   with the same rules and the same first refusal: the schema bounds it, [`check`] (called by `contracts.rs`,
//!   mirrored by `src/extensions/runtime-cli-intent.ts` for `contracts.ts`) applies the rest: every id starts with the
//!   manifest id plus `/` (`InvalidId`, `ReservedId` for `panda.`), at most 64 rules (`LimitExceeded`), `command` is a
//!   bare program name, `words` at most 4 leading positional words, `flags` at most 8 option names, `intent.kind` one
//!   of the host's shell kinds, `verb`/`label`/`object` short plain text (`InvalidShape`), a second rule of the package
//!   with the same match (`DuplicateId`) and the `tools.model` permission declared (`PermissionDenied`).
//! * **A hint, not a gate.** The rule is routed into the host's EXISTING classifier (`describeShell`) and its normal
//!   approval and hook path: [`merge`] lets the author's kind, verb, label and object name the row only where the host
//!   classified the command as the generic `shell`; the host's `destructive`/`risks` and every approval rule are never
//!   changed (an author label can neither lower a risk nor raise a permission). It grants no access to a secret and no
//!   capability: what the package may do stays what its grants say (ADR-0005, ADR-0006).
//! * **Matching.** [`split_segments`] cuts a command line at unquoted `&&`, `||`, `;`, `|` and newlines; each segment is
//!   tokenised (quotes only, no backslash rules, so Windows paths survive). The program is the basename of the first
//!   token without `.exe/.cmd/.bat/.ps1` (leading `NAME=value` words skipped), lower-cased. A rule matches when the
//!   command is equal, its `words` are the first positional (non `-`) arguments in order (an option's separate value
//!   counts as positional, so write it `--name=value`), and any one of its `flags`
//!   is present (`--flag` or `--flag=value`); no `flags` means any.
//! * **Precedence.** The most specific rule wins: more `words`, then more `flags`. A tie goes to the package listed
//!   first by the host, then to its earlier rule. Two packages declaring the same match (command, words and flags):
//!   the later one is a [`Conflict`], unavailable and recorded, like a model tool name. Per-project `tools.model` is
//!   checked on every classification.
//! * **Results.** Each segment answers `Matched`, `Unmatched` (a package declares the command, no rule fits),
//!   `NoRule` (no package declares it) or `Unparseable` (open quote, empty); the first `Matched` segment is the hint.
//!   Nothing here blocks or approves anything; an error leaves the host classification exactly as it was.
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, LazyLock, Mutex},
};

use crate::extensions::runtime_hook_registration::Gate;

/// The permission a package must hold to declare intent rules (per project), the family of its own tools.
pub const PERMISSION: &str = "tools.model";
pub const MAX_RULES: usize = 64;
pub const MAX_WORDS: usize = 4;
pub const MAX_FLAGS: usize = 8;
pub const MAX_TOKEN: usize = 64;
pub const MAX_VERB: usize = 32;
pub const MAX_LABEL: usize = 48;
pub const MAX_OBJECT: usize = 96;
/// Command lines longer than this are not classified (`Unparseable`).
pub const MAX_COMMAND_BYTES: usize = 16 * 1024;
/// The host's `ShellKind` values an author may name.
pub const KINDS: [&str; 18] = ["read", "search", "list", "test", "typecheck", "build", "install", "git", "github", "wait", "fetch", "script", "db", "file", "process", "media", "system", "shell"];
const AT: &str = "contributes/cliIntents";

// ---------------------------------------------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------------------------------------------

/// What an operation is called on the row.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Intent { pub kind: String, pub verb: String, pub label: Option<String>, pub object: Option<String> }
impl Intent {
    pub fn json(&self) -> Value { json!({"kind": self.kind, "verb": self.verb, "label": self.label, "object": self.object}) }
}

/// One `contributes.cliIntents[]` entry.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Rule { pub id: String, pub command: String, pub words: Vec<String>, pub flags: Vec<String>, pub intent: Intent }
impl Rule {
    /// The match, ignoring the order of flags: two rules with one key compete for the same operation.
    pub fn key(&self) -> String {
        let flags: BTreeSet<&str> = self.flags.iter().map(String::as_str).collect();
        format!("{}\u{0}{}\u{0}{}", self.command, self.words.join("\u{1}"), flags.into_iter().collect::<Vec<_>>().join("\u{1}"))
    }
    fn specificity(&self) -> (usize, usize) { (self.words.len(), self.flags.len()) }
    pub fn json(&self) -> Value { json!({"id": self.id, "command": self.command, "words": self.words, "flags": self.flags, "intent": self.intent.json()}) }
}

#[derive(Debug, PartialEq, Eq)]
pub struct Refusal { pub code: &'static str, pub at: &'static str, pub ids: Vec<String> }
fn refuse(code: &'static str, at: &'static str, id: &str) -> Refusal { Refusal { code, at, ids: vec![id.to_owned()] } }

fn token_ok(text: &str, extra: &[char]) -> bool {
    let mut chars = text.chars();
    chars.next().is_some_and(|first| first.is_ascii_alphanumeric())
        && text.len() <= MAX_TOKEN
        && chars.all(|c| c.is_ascii_alphanumeric() || extra.contains(&c))
}
/// A bare program name, lower-case compared: `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`.
pub fn valid_command(text: &str) -> bool { token_ok(text, &['.', '_', '-']) }
/// A positional word: `^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$`.
pub fn valid_word(text: &str) -> bool { token_ok(text, &['.', '_', ':', '-']) }
/// An option name: `-x` or `--long-name`.
pub fn valid_flag(text: &str) -> bool {
    let name = text.strip_prefix("--").or_else(|| text.strip_prefix('-')).unwrap_or("");
    !name.is_empty() && text.len() <= MAX_TOKEN && name.chars().next().is_some_and(|c| c.is_ascii_alphanumeric()) && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}
fn plain(text: &str, max: usize) -> bool { !text.trim().is_empty() && text.chars().count() <= max && !text.chars().any(char::is_control) }

fn strings(value: Option<&Value>, max: usize, ok: fn(&str) -> bool) -> Option<Vec<&str>> {
    let Some(value) = value else { return Some(vec![]) };
    let items = value.as_array()?;
    if items.len() > max { return None; }
    let out: Vec<&str> = items.iter().map(Value::as_str).collect::<Option<_>>()?;
    out.iter().all(|item| ok(item)).then_some(out)
}
fn optional_text(value: Option<&Value>, max: usize) -> Option<Option<String>> {
    match value { None => Some(None), Some(Value::String(text)) if plain(text, max) => Some(Some(text.clone())), _ => None }
}

/// The rules of `contributes.cliIntents` after the schema checked the shape. The order of the checks is the order of
/// `checkCliIntentDeclarations` in `runtime-cli-intent.ts`, so both validators answer the same first refusal.
pub fn check(manifest: &Value) -> Result<Vec<Rule>, Refusal> {
    let Some(rules) = manifest["contributes"]["cliIntents"].as_array().filter(|rules| !rules.is_empty()) else { return Ok(vec![]) };
    let package = manifest["id"].as_str().unwrap_or_default();
    if rules.len() > MAX_RULES { return Err(refuse("LimitExceeded", AT, package)); }
    let permissions: BTreeSet<&str> = manifest["permissions"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
    let (mut ids, mut keys, mut out) = (BTreeSet::new(), BTreeSet::new(), Vec::new());
    for rule in rules {
        let id = rule["id"].as_str().unwrap_or_default();
        if id.starts_with("panda.") { return Err(refuse("ReservedId", AT, id)); }
        if !id.starts_with(&format!("{package}/")) { return Err(refuse("InvalidId", AT, id)); }
        if !ids.insert(id) { return Err(refuse("DuplicateId", AT, id)); }
        let command = rule["command"].as_str().filter(|command| valid_command(command)).ok_or_else(|| refuse("InvalidShape", AT, id))?;
        let words = strings(rule.get("words"), MAX_WORDS, valid_word).ok_or_else(|| refuse("InvalidShape", AT, id))?;
        let flags = strings(rule.get("flags"), MAX_FLAGS, valid_flag).ok_or_else(|| refuse("InvalidShape", AT, id))?;
        if flags.iter().collect::<BTreeSet<_>>().len() != flags.len() { return Err(refuse("InvalidShape", AT, id)); }
        let intent = &rule["intent"];
        let Some(fields) = intent.as_object() else { return Err(refuse("InvalidShape", AT, id)) };
        if fields.keys().any(|key| !["kind", "verb", "label", "object"].contains(&key.as_str())) { return Err(refuse("InvalidShape", AT, id)); }
        let kind = intent["kind"].as_str().filter(|kind| KINDS.contains(kind)).ok_or_else(|| refuse("InvalidShape", AT, id))?;
        let verb = intent["verb"].as_str().filter(|verb| plain(verb, MAX_VERB)).ok_or_else(|| refuse("InvalidShape", AT, id))?;
        let label = optional_text(intent.get("label"), MAX_LABEL).ok_or_else(|| refuse("InvalidShape", AT, id))?;
        let object = optional_text(intent.get("object"), MAX_OBJECT).ok_or_else(|| refuse("InvalidShape", AT, id))?;
        let declared = Rule {
            id: id.to_owned(),
            command: command.to_owned(),
            words: words.iter().map(|word| (*word).to_owned()).collect(),
            flags: flags.iter().map(|flag| (*flag).to_owned()).collect(),
            intent: Intent { kind: kind.to_owned(), verb: verb.to_owned(), label, object },
        };
        if !keys.insert(declared.key().to_ascii_lowercase()) { return Err(refuse("DuplicateId", AT, id)); }
        out.push(declared);
    }
    if !permissions.contains(PERMISSION) { return Err(refuse("PermissionDenied", "permissions", package)); }
    Ok(out)
}

// ---------------------------------------------------------------------------------------------------------------
// Tokens and segments
// ---------------------------------------------------------------------------------------------------------------

/// Cuts a command line at unquoted `&&`, `||`, `;`, `|` and newlines. `None` when a quote is left open.
pub fn split_segments(line: &str) -> Option<Vec<String>> {
    let (mut segments, mut current, mut quote) = (Vec::new(), String::new(), None::<char>);
    let chars: Vec<char> = line.chars().collect();
    let mut index = 0;
    while index < chars.len() {
        let c = chars[index];
        match quote {
            Some(open) => { current.push(c); if c == open { quote = None; } }
            None => match c {
                '\'' | '"' => { quote = Some(c); current.push(c); }
                ';' | '\n' | '\r' => { segments.push(std::mem::take(&mut current)); }
                '&' | '|' => {
                    if chars.get(index + 1) == Some(&c) { index += 1; }
                    else if c == '&' { current.push(c); index += 1; continue; }
                    segments.push(std::mem::take(&mut current));
                }
                _ => current.push(c),
            },
        }
        index += 1;
    }
    if quote.is_some() { return None; }
    segments.push(current);
    Some(segments.into_iter().map(|segment| segment.trim().to_owned()).filter(|segment| !segment.is_empty()).collect())
}

/// The arguments of one segment (quotes removed). `None` when a quote is left open.
pub fn tokens(segment: &str) -> Option<Vec<String>> {
    let (mut out, mut current, mut quote, mut started) = (Vec::new(), String::new(), None::<char>, false);
    for c in segment.chars() {
        match quote {
            Some(open) => { if c == open { quote = None; } else { current.push(c); } }
            None => match c {
                '\'' | '"' => { quote = Some(c); started = true; }
                c if c.is_whitespace() => { if started { out.push(std::mem::take(&mut current)); started = false; } }
                _ => { current.push(c); started = true; }
            },
        }
    }
    if quote.is_some() { return None; }
    if started { out.push(current); }
    Some(out)
}

/// `C:\tools\Tracker.EXE` -> `tracker`.
pub fn program(token: &str) -> String {
    let name = token.rsplit(['/', '\\']).next().unwrap_or(token).to_ascii_lowercase();
    for suffix in [".exe", ".cmd", ".bat", ".ps1"] { if let Some(stem) = name.strip_suffix(suffix) { if !stem.is_empty() { return stem.to_owned(); } } }
    name
}

fn is_assignment(token: &str) -> bool {
    token.split_once('=').is_some_and(|(name, _)| !name.is_empty() && name.chars().next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_') && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'))
}

/// What one segment is made of: the program, its leading positional words and its options.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Parsed { pub command: String, pub words: Vec<String>, pub flags: Vec<String> }
pub fn parse_segment(segment: &str) -> Option<Parsed> {
    let all = tokens(segment)?;
    let mut rest = all.iter().skip_while(|token| is_assignment(token));
    let command = program(rest.next()?);
    let (mut words, mut flags) = (Vec::new(), Vec::new());
    for token in rest {
        if token.len() > 1 && token.starts_with('-') { flags.push(token.split('=').next().unwrap_or(token).to_ascii_lowercase()); }
        else if words.len() < MAX_WORDS { words.push(token.to_ascii_lowercase()); }
    }
    Some(Parsed { command, words, flags })
}

fn fits(rule: &Rule, parsed: &Parsed) -> bool {
    rule.command.eq_ignore_ascii_case(&parsed.command)
        && parsed.words.len() >= rule.words.len()
        && rule.words.iter().zip(&parsed.words).all(|(want, got)| want.eq_ignore_ascii_case(got))
        && (rule.flags.is_empty() || rule.flags.iter().any(|flag| parsed.flags.iter().any(|got| got.eq_ignore_ascii_case(flag))))
}

// ---------------------------------------------------------------------------------------------------------------
// Inventory and classification
// ---------------------------------------------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub struct Entry { pub owner: String, pub version: String, pub package_name: String, pub rules: Vec<Rule> }
pub type Source = Arc<dyn Fn() -> Vec<Entry> + Send + Sync>;

/// A rule a run may use.
#[derive(Clone, Debug, PartialEq)]
pub struct Listed { pub owner: String, pub version: String, pub package_name: String, pub rule: Rule }
/// A rule that is unavailable because an earlier package declared the same match.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Conflict { pub owner: String, pub id: String, pub command: String, pub held_by: String }

/// Splits the declared rules into those available and those that lost their match to an earlier package.
pub fn resolve(entries: &[Entry]) -> (Vec<Listed>, Vec<Conflict>) {
    let (mut held, mut available, mut conflicts): (BTreeMap<String, &str>, Vec<Listed>, Vec<Conflict>) = (BTreeMap::new(), vec![], vec![]);
    for entry in entries {
        for rule in &entry.rules {
            let key = rule.key().to_ascii_lowercase();
            match held.get(&key).copied() {
                Some(owner) if owner != entry.owner => conflicts.push(Conflict { owner: entry.owner.clone(), id: rule.id.clone(), command: rule.command.clone(), held_by: owner.to_owned() }),
                _ => {
                    held.insert(key, &entry.owner);
                    available.push(Listed { owner: entry.owner.clone(), version: entry.version.clone(), package_name: entry.package_name.clone(), rule: rule.clone() });
                }
            }
        }
    }
    (available, conflicts)
}

#[derive(Clone, Debug, PartialEq)]
pub struct Segment { pub text: String, pub status: &'static str, pub matched: Option<Listed>, pub candidates: Vec<String> }
impl Segment {
    pub fn json(&self) -> Value {
        json!({"text": self.text, "status": self.status, "rule": self.matched.as_ref().map(|listed| listed.rule.id.clone()), "owner": self.matched.as_ref().map(|listed| listed.owner.clone()),
            "package": self.matched.as_ref().map(|listed| listed.package_name.clone()), "intent": self.matched.as_ref().map(|listed| listed.rule.intent.json()), "candidates": self.candidates})
    }
}
/// The classification of one command line: every segment and the hint (the first `Matched` segment).
#[derive(Clone, Debug, PartialEq)]
pub struct Classification { pub segments: Vec<Segment>, pub hint: Option<Listed>, pub status: &'static str }
impl Classification {
    pub fn json(&self) -> Value {
        json!({"schemaVersion": 1, "status": self.status, "segments": self.segments.iter().map(Segment::json).collect::<Vec<_>>(),
            "hint": self.hint.as_ref().map(|listed| json!({"rule": listed.rule.id, "owner": listed.owner, "package": listed.package_name, "intent": listed.rule.intent.json()}))})
    }
}

/// Classifies `line` against `usable` rules (grants already applied, in host order).
pub fn classify(usable: &[Listed], line: &str) -> Classification {
    let none = |status| Classification { segments: vec![], hint: None, status };
    if line.len() > MAX_COMMAND_BYTES { return none("Unparseable"); }
    let Some(texts) = split_segments(line) else { return none("Unparseable") };
    if texts.is_empty() { return none("Unparseable"); }
    let mut segments = Vec::new();
    for text in texts {
        let Some(parsed) = parse_segment(&text) else { segments.push(Segment { text, status: "Unparseable", matched: None, candidates: vec![] }); continue };
        let declared: Vec<&Listed> = usable.iter().filter(|listed| listed.rule.command.eq_ignore_ascii_case(&parsed.command)).collect();
        if declared.is_empty() { segments.push(Segment { text, status: "NoRule", matched: None, candidates: vec![] }); continue; }
        let fitting: Vec<&Listed> = declared.into_iter().filter(|listed| fits(&listed.rule, &parsed)).collect();
        // Most specific first; the stable sort keeps the host's package order and a package's own order on a tie.
        let best = fitting.iter().map(|listed| listed.rule.specificity()).max();
        let winners: Vec<&Listed> = fitting.iter().copied().filter(|listed| Some(listed.rule.specificity()) == best).collect();
        match winners.first() {
            Some(winner) => segments.push(Segment { text, status: "Matched", matched: Some((*winner).clone()), candidates: winners.iter().skip(1).map(|listed| listed.rule.id.clone()).collect() }),
            None => segments.push(Segment { text, status: "Unmatched", matched: None, candidates: vec![] }),
        }
    }
    let hint = segments.iter().find_map(|segment| segment.matched.clone());
    let status = if hint.is_some() { "Matched" } else if segments.iter().any(|segment| segment.status == "Unmatched") { "Unmatched" } else if segments.iter().all(|segment| segment.status == "Unparseable") { "Unparseable" } else { "NoRule" };
    Classification { segments, hint, status }
}

/// What the host's classifier answered for a command (`describeShell`): the fields the merge reads.
/// The author's hint names the row only when the host found nothing more specific than the generic `shell`; the host's
/// `destructive` and `risks` are never touched. The answer carries `packageIntent` with the package attribution.
pub fn merge(host: &Value, classification: &Classification) -> Value {
    let mut out = host.clone();
    let (Some(fields), Some(hint)) = (out.as_object_mut(), classification.hint.as_ref()) else { return out };
    let intent = &hint.rule.intent;
    let generic = host["kind"].as_str().is_none_or(|kind| kind == "shell");
    if generic {
        fields.insert("kind".into(), json!(intent.kind));
        fields.insert("verb".into(), json!(intent.verb));
        if let Some(label) = &intent.label { fields.insert("label".into(), json!(label)); }
        if let Some(object) = &intent.object { fields.insert("object".into(), json!(object)); }
    }
    fields.insert("packageIntent".into(), json!({"applied": generic, "owner": hint.owner, "package": hint.package_name, "rule": hint.rule.id, "intent": intent.json()}));
    out
}

// ---------------------------------------------------------------------------------------------------------------
// The registry and the app
// ---------------------------------------------------------------------------------------------------------------

#[derive(Default)]
pub struct CliIntents {
    gate: Mutex<Option<Gate>>,
    source: Mutex<Option<Source>>,
}
impl CliIntents {
    pub fn set_gate(&self, gate: Gate) { if let Ok(mut slot) = self.gate.lock() { *slot = Some(gate); } }
    pub fn set_source(&self, source: Source) { if let Ok(mut slot) = self.source.lock() { *slot = Some(source); } }
    fn entries(&self) -> Vec<Entry> { self.source.lock().ok().and_then(|slot| slot.clone()).map(|source| source()).unwrap_or_default() }
    fn holds(&self, owner: &str, version: &str, project: Option<&str>) -> bool {
        self.gate.lock().ok().and_then(|slot| slot.clone()).is_some_and(|gate| gate(owner, version, PERMISSION, project))
    }
    /// The rules a run of `project` may use, by the grant checked now.
    pub fn usable(&self, project: Option<&str>) -> Vec<Listed> {
        resolve(&self.entries()).0.into_iter().filter(|listed| self.holds(&listed.owner, &listed.version, project)).collect()
    }
    pub fn conflicts(&self) -> Vec<Conflict> { resolve(&self.entries()).1 }
    pub fn classify(&self, project: Option<&str>, line: &str) -> Classification { classify(&self.usable(project), line) }
}

static REGISTRY: LazyLock<CliIntents> = LazyLock::new(CliIntents::default);
static INSTALLED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
pub fn registry() -> &'static CliIntents { &REGISTRY }

/// The enabled, trusted packages outside safe mode with intent rules, in the manager's order.
fn app_entries(app: &tauri::AppHandle) -> Vec<Entry> {
    use tauri::Manager;
    let Some(packages) = app.try_state::<crate::extensions::packages::ExtensionPackages>() else { return vec![] };
    let Some(snapshot) = packages.0.lock().ok().and_then(|packages| serde_json::to_value(packages.snapshot()).ok()) else { return vec![] };
    if snapshot["safeMode"] == true { return vec![]; }
    snapshot["packages"].as_array().into_iter().flatten()
        .filter(|package| package["enabled"] == true && package["executable"]["trusted"] == true)
        .filter_map(|package| {
            let manifest = &package["manifest"];
            let rules = check(manifest).ok().filter(|rules| !rules.is_empty())?;
            let owner = manifest["id"].as_str()?.to_owned();
            let package_name = manifest["name"].as_str().filter(|name| !name.trim().is_empty()).unwrap_or(&owner).to_owned();
            Some(Entry { version: manifest["version"].as_str()?.to_owned(), package_name, owner, rules })
        }).collect()
}

fn install(app: &tauri::AppHandle) {
    if INSTALLED.swap(true, std::sync::atomic::Ordering::AcqRel) { return; }
    use tauri::Manager;
    let gated = app.clone();
    REGISTRY.set_gate(Arc::new(move |owner, version, permission, project| {
        gated.try_state::<crate::extensions::runtime_grants::RuntimeGrants>().is_some_and(|grants| crate::extensions::runtime_hook_registration::holds(&grants, owner, version, permission, project))
    }));
    let listing = app.clone();
    REGISTRY.set_source(Arc::new(move || app_entries(&listing)));
}

/// Adds the package's intent to a shell tool call's hook payload and to the host's classification: `payload.intent` is
/// the [`Classification`] when a rule matched (the deciding hooks and the transcript read it with the package
/// attribution) and `host` (the classifier's answer for the same command) is merged. The call itself is untouched:
/// approval, hooks and grants run exactly as they would without the rule. Returns the merged host classification.
pub fn annotate(app: &tauri::AppHandle, project: Option<&str>, command: &str, payload: &mut Value, host: &Value) -> Value {
    install(app);
    let classification = REGISTRY.classify(project, command);
    if classification.hint.is_none() { return host.clone(); }
    if let Some(fields) = payload.as_object_mut() { fields.insert("intent".into(), classification.json()); }
    merge(host, &classification)
}

/// The preview mock's and the tests' view of the inventory as the SDK shows it.
pub fn inventory_json(registry: &CliIntents, project: Option<&str>) -> Value {
    json!({
        "rules": registry.usable(project).iter().map(|listed| json!({"owner": listed.owner, "package": listed.package_name, "rule": listed.rule.json()})).collect::<Vec<_>>(),
        "conflicts": registry.conflicts().iter().map(|conflict| json!({"owner": conflict.owner, "id": conflict.id, "command": conflict.command, "heldBy": conflict.held_by})).collect::<Vec<_>>(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const CASES: &str = include_str!("../../../tests/fixtures/extensions/runtime-cli-intent/cases.json");
    const MANIFEST: &str = include_str!("../../../tests/fixtures/extensions/runtime-cli-intent/extension.json");

    fn entries(manifests: &[(&str, Value)]) -> Vec<Entry> {
        manifests.iter().map(|(owner, manifest)| Entry { owner: (*owner).to_owned(), version: "1.0.0".into(), package_name: (*owner).to_owned(), rules: check(manifest).expect("fixture rules") }).collect()
    }
    fn usable(manifests: &[(&str, Value)]) -> Vec<Listed> { resolve(&entries(manifests)).0 }

    #[test]
    fn fixture_declarations_and_refusals() {
        let manifest: Value = serde_json::from_str(MANIFEST).unwrap();
        let cases: Value = serde_json::from_str(CASES).unwrap();
        assert_eq!(check(&manifest).unwrap().len(), manifest["contributes"]["cliIntents"].as_array().unwrap().len());
        for case in cases["refusals"].as_array().unwrap() {
            let mut changed = manifest.clone();
            let mut rule = changed["contributes"]["cliIntents"][0].clone();
            for (key, value) in case["set"].as_object().into_iter().flatten() { rule[key] = value.clone(); }
            for key in case["drop"].as_array().into_iter().flatten().filter_map(Value::as_str) { rule.as_object_mut().unwrap().remove(key); }
            let mut list = vec![rule];
            if let Some(extra) = case.get("duplicate") { let mut second = list[0].clone(); for (key, value) in extra.as_object().unwrap() { second[key] = value.clone(); } list.push(second); }
            changed["contributes"]["cliIntents"] = json!(list);
            if let Some(permissions) = case.get("permissions") { changed["permissions"] = permissions.clone(); }
            let refusal = check(&changed).expect_err(case["name"].as_str().unwrap());
            assert_eq!(refusal.code, case["code"].as_str().unwrap(), "{}", case["name"]);
        }
    }

    #[test]
    fn classification_cases() {
        let manifest: Value = serde_json::from_str(MANIFEST).unwrap();
        let cases: Value = serde_json::from_str(CASES).unwrap();
        let listed = usable(&[("sample.tracker", manifest)]);
        for case in cases["classify"].as_array().unwrap() {
            let result = classify(&listed, case["command"].as_str().unwrap());
            assert_eq!(result.status, case["status"].as_str().unwrap(), "{}", case["command"]);
            assert_eq!(result.hint.as_ref().map(|hint| hint.rule.id.as_str()), case["rule"].as_str(), "{}", case["command"]);
        }
    }

    #[test]
    fn collision_goes_to_the_earlier_package() {
        let manifest: Value = serde_json::from_str(MANIFEST).unwrap();
        let mut other = manifest.clone();
        other["id"] = json!("sample.other");
        for rule in other["contributes"]["cliIntents"].as_array_mut().unwrap() { let id = rule["id"].as_str().unwrap().replace("sample.tracker", "sample.other"); rule["id"] = json!(id); }
        let (available, conflicts) = resolve(&entries(&[("sample.tracker", manifest.clone()), ("sample.other", other)]));
        assert!(!conflicts.is_empty() && conflicts.iter().all(|conflict| conflict.held_by == "sample.tracker"));
        assert!(available.iter().all(|listed| listed.owner == "sample.tracker"));
    }

    #[test]
    fn host_risk_is_never_changed() {
        let manifest: Value = serde_json::from_str(MANIFEST).unwrap();
        let listed = usable(&[("sample.tracker", manifest)]);
        let host = json!({"kind": "shell", "verb": "Ran", "label": "tracker", "destructive": true, "risks": ["Deleted src"]});
        let merged = merge(&host, &classify(&listed, "tracker close 7"));
        assert_eq!(merged["destructive"], json!(true));
        assert_eq!(merged["risks"], host["risks"]);
        assert_eq!(merged["packageIntent"]["owner"], json!("sample.tracker"));
        let specific = json!({"kind": "git", "verb": "Pushed", "label": "origin", "destructive": false, "risks": []});
        let kept = merge(&specific, &classify(&listed, "tracker close 7"));
        assert_eq!(kept["verb"], json!("Pushed"));
        assert_eq!(kept["packageIntent"]["applied"], json!(false));
    }
}
