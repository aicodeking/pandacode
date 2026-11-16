//! Native consent of the BTW and family controls, and the per-package confirmation of irreversible deletions
//! (runtime phase R1).
//!
//! Before the runtime, the consent of the two BTW controls and of the six control families (machines, cloud, moodboards,
//! branches and worktrees, pulls, tasks) was a boolean in a webview closure that a page could set. Now:
//!
//! - A package that **holds the covering permission** (`btw.content`, `btw.taskControl`, `tasks.control`,
//!   `workspace.manage`, `tasks.start` with `tasks.control`) acts without a host-choice prompt (ADR-0005): the answer
//!   comes from `RuntimeGrants`, never from the request.
//! - A package of API 1 that **does not declare** the covering permission keeps the previous host choice: `Prompt`. The
//!   choice is stored here, in `extension-family-consents-v1/consents.json`, and survives a restart.
//! - A choice is only accepted with a **ticket** that the native gate minted for that very package, family and project,
//!   and a ticket is single use and never survives the process. A request that asserts a consent itself (`consent`,
//!   `granted`, `confirmed`, a family name, ...) answers `PermissionDenied` and changes nothing.
//! - Irreversible deletions (`remove` of a project, task, bot, channel, cloud machine, worktree, branch, moodboard,
//!   recipe or wake-up, and `pulls.merge`) confirm by default; the user can turn that off for one package only. A refusal
//!   answers `Cancelled`.
//! - Pairing a machine and granting remote access are not families: they answer `PermissionDenied` to every package.
use super::runtime_grants::{RuntimeGrants, Scope, Target};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    sync::Mutex,
};

type Result<T> = std::result::Result<T, String>;

const DENIED: &str = "PermissionDenied";
const MAX_FILE: u64 = 1024 * 1024;
const MAX_TICKETS: usize = 64;
/// Keys that assert a decision which only the native side may make. A request carrying one is forged.
const FORGED: [&str; 10] = ["consent", "consents", "granted", "allowed", "approved", "confirmed", "userChoice", "trusted", "permission", "permissions"];

/// The BTW controls and the six control families whose consent moved to the native side.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Family { BtwContent, BtwControl, Machine, Cloud, Moodboard, Branch, Pull, Task }

impl Family {
    pub const ALL: [Family; 8] = [Family::BtwContent, Family::BtwControl, Family::Machine, Family::Cloud, Family::Moodboard, Family::Branch, Family::Pull, Family::Task];
    pub fn name(self) -> &'static str {
        match self {
            Family::BtwContent => "btwContent", Family::BtwControl => "btwControl", Family::Machine => "machineControl", Family::Cloud => "cloudControl",
            Family::Moodboard => "moodboardControl", Family::Branch => "branchControl", Family::Pull => "pullControl", Family::Task => "taskControl",
        }
    }
    /// The permissions that cover the family; the package needs all of them to be covered.
    pub fn covering(self) -> &'static [&'static str] {
        match self {
            Family::BtwContent => &["btw.content"],
            Family::BtwControl => &["btw.taskControl"],
            Family::Machine => &["tasks.control"],
            Family::Cloud | Family::Moodboard | Family::Branch | Family::Pull => &["workspace.manage"],
            Family::Task => &["tasks.start", "tasks.control"],
        }
    }
    /// Pairing a machine and granting remote access are the user's alone, so they are no family at all.
    pub fn parse(name: &str) -> Result<Self> {
        if matches!(name, "pairing" | "pair" | "remoteAccess" | "remote") { return Err(DENIED.into()); }
        Self::ALL.into_iter().find(|family| family.name() == name).ok_or_else(|| "UnsupportedCapability".to_string())
    }
}

/// What the legacy control does.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Gate { Granted, Prompt }

/// The irreversible actions: which family guards each (`None`: `workspace.manage` itself).
const IRREVERSIBLE: [(&str, Option<Family>); 11] = [
    ("projects.remove", None), ("tasks.remove", None), ("bots.remove", None), ("channels.remove", None), ("recipes.remove", None), ("wakeups.remove", None),
    ("cloud.machines.remove", Some(Family::Cloud)), ("worktrees.remove", Some(Family::Branch)), ("branches.remove", Some(Family::Branch)),
    ("moodboards.remove", Some(Family::Moodboard)), ("pulls.merge", Some(Family::Pull)),
];

/// The outcome of asking to delete.
#[derive(Debug, PartialEq, Eq)]
pub enum Delete { Proceed, Confirm { ticket: String, what: String } }

fn yes() -> bool { true }
#[derive(Default, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct File { schema_version: u8, revision: u64, packages: BTreeMap<String, Entry> }
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Entry {
    /// Family name to the projects the user consented in (`null`: every project).
    #[serde(default)] consents: BTreeMap<String, Option<BTreeSet<String>>>,
    #[serde(default = "yes")] confirm_deletions: bool,
}
impl Entry {
    fn is_default(&self) -> bool { self.consents.is_empty() && self.confirm_deletions }
}
fn valid(file: &File) -> bool {
    file.schema_version == 1 && file.packages.iter().all(|(id, entry)| {
        !id.is_empty() && id.len() <= 128
            && entry.consents.iter().all(|(name, projects)| Family::parse(name).is_ok() && projects.as_ref().is_none_or(|set| !set.is_empty() && set.len() <= 256 && set.iter().all(|p| !p.is_empty() && p.len() <= 256)))
    })
}

enum Kind { Choice, Delete }
struct Ticket { kind: Kind, id: String, family: Option<Family>, project: Option<String>, action: String }
struct Loaded { file: File, corrupt: bool }

/// A package as the grants store knows it right now.
struct Info { version: String, declared: BTreeSet<String>, authorized: bool, grants: BTreeMap<String, Option<BTreeSet<String>>> }
fn info(grants: &RuntimeGrants, id: &str) -> Option<Info> {
    let projection = grants.projection();
    let package = projection["packages"].as_array()?.iter().find(|package| package["id"] == id)?;
    let strings = |value: &Value| value.as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect::<BTreeSet<_>>();
    Some(Info {
        version: package["version"].as_str()?.to_owned(),
        declared: strings(&package["declared"]),
        authorized: package["authorized"] == true,
        grants: package["grants"].as_array()?.iter().filter_map(|grant| Some((grant["permission"].as_str()?.to_owned(), grant["scope"]["projects"].as_array().map(|list| list.iter().filter_map(Value::as_str).map(str::to_owned).collect())))).collect(),
    })
}
fn declares_all(info: &Info, family: Family) -> bool { family.covering().iter().all(|name| info.declared.contains(*name)) }
fn target(project: Option<&str>) -> Target { project.map_or_else(Target::default, Target::project) }
/// The projects after consenting in `project`: `None` stays "every project".
fn widened(current: Option<&Option<BTreeSet<String>>>, project: Option<&str>) -> Option<BTreeSet<String>> {
    match (current, project) {
        (Some(None), _) | (_, None) => None,
        (Some(Some(set)), Some(project)) => { let mut set = set.clone(); set.insert(project.to_owned()); Some(set) }
        (None, Some(project)) => Some(BTreeSet::from([project.to_owned()])),
    }
}
/// What withdrawing `project` leaves of a consent. "Every project" cannot give one project back, so it is removed.
enum Withdraw { Keep, Narrow(BTreeSet<String>), Remove }
fn withdrawn(current: &Option<BTreeSet<String>>, project: Option<&str>) -> Withdraw {
    match (current, project) {
        (Some(set), Some(project)) if !set.contains(project) => Withdraw::Keep,
        (Some(set), Some(project)) if set.len() > 1 => { let mut set = set.clone(); set.remove(project); Withdraw::Narrow(set) }
        _ => Withdraw::Remove,
    }
}
fn bounded(value: &str, max: usize) -> bool { !value.is_empty() && value.len() <= max && !value.chars().any(char::is_control) }

pub struct FamilyConsents { path: PathBuf, state: Mutex<Loaded>, tickets: Mutex<Vec<(String, Ticket)>> }

impl FamilyConsents {
    /// Opens `<dir>/extension-family-consents-v1/consents.json`. A missing file is an empty store; an unreadable or
    /// malformed one is kept as it is, stores nothing and answers `PermissionDenied` to every gate.
    pub fn open(dir: &Path) -> Self {
        let path = dir.join("extension-family-consents-v1").join("consents.json");
        let loaded = match std::fs::metadata(&path) {
            Err(_) => Loaded { file: File { schema_version: 1, ..File::default() }, corrupt: false },
            Ok(meta) if meta.len() > MAX_FILE => Loaded { file: File::default(), corrupt: true },
            Ok(_) => match std::fs::read(&path).ok().and_then(|bytes| serde_json::from_slice::<File>(&bytes).ok()).filter(valid) {
                Some(file) => Loaded { file, corrupt: false },
                None => Loaded { file: File::default(), corrupt: true },
            },
        };
        Self { path, state: Mutex::new(loaded), tickets: Mutex::new(vec![]) }
    }
    fn write(&self, file: &File) -> Result<()> {
        let parent = self.path.parent().ok_or("StorageUnavailable")?;
        std::fs::create_dir_all(parent).map_err(|_| "StorageUnavailable")?;
        let stage = self.path.with_extension("stage");
        std::fs::write(&stage, serde_json::to_vec(file).map_err(|_| "MalformedData")?).map_err(|_| "StorageUnavailable")?;
        std::fs::rename(&stage, &self.path).map_err(|_| "StorageUnavailable".to_string())
    }
    /// Applies `change` to a copy and writes it; nothing changes when the change or the write fails, and a change that
    /// alters nothing is not written.
    fn mutate<T>(&self, change: impl FnOnce(&mut File) -> Result<T>) -> Result<T> {
        let mut state = self.state.lock().map_err(|_| "StorageUnavailable")?;
        if state.corrupt { return Err("MalformedData".into()); }
        let mut next = state.file.clone();
        let value = change(&mut next)?;
        next.packages.retain(|_, entry| !entry.is_default());
        if next.packages == state.file.packages { return Ok(value); }
        next.revision += 1;
        self.write(&next)?;
        state.file = next;
        Ok(value)
    }
    fn entry(&self, id: &str) -> Option<Entry> { self.state.lock().ok().filter(|state| !state.corrupt).and_then(|state| state.file.packages.get(id).cloned()) }
    /// Drops what belongs to packages the grants store no longer knows (an uninstall).
    fn prune(&self, grants: &RuntimeGrants) {
        let projection = grants.projection();
        if projection["available"] != true { return; }
        let present: BTreeSet<String> = projection["packages"].as_array().into_iter().flatten().filter_map(|package| package["id"].as_str().map(str::to_owned)).collect();
        let _ = self.mutate(|file| { file.packages.retain(|id, _| present.contains(id)); Ok(()) });
    }

    fn mint(&self, ticket: Ticket) -> Result<String> {
        let token = uuid::Uuid::new_v4().to_string();
        let mut tickets = self.tickets.lock().map_err(|_| "StorageUnavailable")?;
        if tickets.len() >= MAX_TICKETS { tickets.remove(0); }
        tickets.push((token.clone(), ticket));
        Ok(token)
    }
    /// A ticket is single use: it is gone whether or not it was the right kind.
    fn take(&self, token: &str, kind: Kind) -> Result<Ticket> {
        let mut tickets = self.tickets.lock().map_err(|_| DENIED)?;
        let position = tickets.iter().position(|(candidate, _)| candidate == token).ok_or(DENIED)?;
        let (_, ticket) = tickets.remove(position);
        if std::mem::discriminant(&ticket.kind) == std::mem::discriminant(&kind) { Ok(ticket) } else { Err(DENIED.into()) }
    }

    /// Whether the control may act now. The covering grants are asked first; otherwise a package that does not declare
    /// the covering permission is covered by the choice the user stored for it. Anything else is the previous prompt.
    pub fn gate(&self, grants: &RuntimeGrants, id: &str, family: Family, project: Option<&str>) -> Result<Gate> {
        let package = info(grants, id).ok_or(DENIED)?;
        let target = target(project);
        if family.covering().iter().all(|name| grants.check(id, &package.version, name, &target).is_ok()) { return Ok(Gate::Granted); }
        if !package.authorized || declares_all(&package, family) { return Ok(Gate::Prompt); }
        let stored = self.entry(id).and_then(|entry| entry.consents.get(family.name()).cloned());
        Ok(match (stored, project) {
            (Some(None), _) => Gate::Granted,
            (Some(Some(set)), Some(project)) if set.contains(project) => Gate::Granted,
            _ => Gate::Prompt,
        })
    }
    /// The gate plus the ticket the user's choice must present when the answer is `Prompt`.
    pub fn offer(&self, grants: &RuntimeGrants, id: &str, family: Family, project: Option<&str>) -> Result<(Gate, Option<String>)> {
        let gate = self.gate(grants, id, family, project)?;
        if gate == Gate::Granted { return Ok((gate, None)); }
        let ticket = self.mint(Ticket { kind: Kind::Choice, id: id.into(), family: Some(family), project: project.map(str::to_owned), action: String::new() })?;
        Ok((gate, Some(ticket)))
    }
    /// Records the user's choice for the package, family and project the ticket was minted for. A package that declares
    /// the covering permissions gets (or loses) the native grant; any other package gets the stored consent.
    pub fn choose(&self, grants: &RuntimeGrants, ticket: &str, allow: bool) -> Result<()> {
        let ticket = self.take(ticket, Kind::Choice)?;
        let family = ticket.family.ok_or(DENIED)?;
        let package = info(grants, &ticket.id).ok_or(DENIED)?;
        if !package.authorized { return Err(DENIED.into()); }
        let project = ticket.project.as_deref();
        if declares_all(&package, family) {
            for name in family.covering() {
                let current = package.grants.get(*name);
                if allow {
                    grants.grant(&ticket.id, name, Scope { projects: widened(current, project), ..Scope::default() })?;
                } else if let Some(current) = current {
                    match withdrawn(current, project) {
                        Withdraw::Keep => {}
                        Withdraw::Narrow(projects) => grants.narrow(&ticket.id, name, Scope { projects: Some(projects), ..Scope::default() })?,
                        Withdraw::Remove => grants.revoke(&ticket.id, name)?,
                    }
                }
            }
            return Ok(());
        }
        self.mutate(|file| {
            let entry = file.packages.entry(ticket.id.clone()).or_insert_with(|| Entry { consents: BTreeMap::new(), confirm_deletions: true });
            let name = family.name();
            if allow {
                let next = widened(entry.consents.get(name), project);
                entry.consents.insert(name.to_owned(), next);
            } else if let Some(current) = entry.consents.get(name).cloned() {
                match withdrawn(&current, project) {
                    Withdraw::Keep => {}
                    Withdraw::Narrow(left) => { entry.consents.insert(name.to_owned(), Some(left)); }
                    Withdraw::Remove => { entry.consents.remove(name); }
                }
            }
            Ok(())
        })
    }

    /// Whether a deletion of this package asks the host first (the default).
    pub fn confirms_deletions(&self, id: &str) -> bool { self.entry(id).is_none_or(|entry| entry.confirm_deletions) }
    /// The per-package switch. Only this package changes.
    pub fn set_confirm_deletions(&self, grants: &RuntimeGrants, id: &str, confirm: bool) -> Result<()> {
        info(grants, id).ok_or(DENIED)?;
        self.mutate(|file| { file.packages.entry(id.to_owned()).or_insert_with(|| Entry { consents: BTreeMap::new(), confirm_deletions: true }).confirm_deletions = confirm; Ok(()) })
    }
    fn authorize_deletion(&self, grants: &RuntimeGrants, id: &str, action: &str, project: Option<&str>) -> Result<()> {
        let family = IRREVERSIBLE.iter().find(|(name, _)| *name == action).ok_or("UnsupportedCapability")?.1;
        let package = info(grants, id).ok_or(DENIED)?;
        match family {
            Some(family) => { if self.gate(grants, id, family, project)? != Gate::Granted { return Err(DENIED.into()); } }
            None => grants.check(id, &package.version, "workspace.manage", &target(project))?,
        }
        Ok(())
    }
    /// Asks to run an irreversible action: `Proceed`, or `Confirm` with a ticket the host's confirmation must answer.
    pub fn delete(&self, grants: &RuntimeGrants, id: &str, action: &str, project: Option<&str>, what: &str) -> Result<Delete> {
        self.authorize_deletion(grants, id, action, project)?;
        if !self.confirms_deletions(id) { return Ok(Delete::Proceed); }
        let ticket = self.mint(Ticket { kind: Kind::Delete, id: id.into(), family: None, project: project.map(str::to_owned), action: action.into() })?;
        Ok(Delete::Confirm { ticket, what: what.chars().filter(|c| !c.is_control()).take(200).collect() })
    }
    /// The host confirmation's answer. A refusal is `Cancelled`; the authority is checked again because it may have been
    /// revoked while the dialog was open.
    pub fn answer(&self, grants: &RuntimeGrants, ticket: &str, accepted: bool) -> Result<()> {
        let ticket = self.take(ticket, Kind::Delete)?;
        if !accepted { return Err("Cancelled".into()); }
        self.authorize_deletion(grants, &ticket.id, &ticket.action, ticket.project.as_deref())
    }

    pub fn projection(&self) -> Value {
        let Ok(state) = self.state.lock() else { return json!({"schemaVersion":1,"available":false,"revision":0,"packages":[]}); };
        let packages: Vec<Value> = state.file.packages.iter().map(|(id, entry)| json!({
            "id": id, "confirmDeletions": entry.confirm_deletions,
            "consents": entry.consents.iter().map(|(name, projects)| json!({"family": name, "projects": projects})).collect::<Vec<_>>(),
        })).collect();
        json!({"schemaVersion":1,"available":!state.corrupt,"revision":state.file.revision,"packages":packages})
    }

    /// One request of the webview. `op`: `projection`, `gate`, `choice`, `delete`, `answer` or `preference`. A key that
    /// asserts a decision (a forged consent, confirmation or permission) is `PermissionDenied` and changes nothing.
    pub fn handle(&self, grants: &RuntimeGrants, request: &Value) -> Result<Value> {
        let object = request.as_object().ok_or("InvalidArguments")?;
        let op = object.get("op").and_then(Value::as_str).ok_or("InvalidArguments")?;
        let allowed: &[&str] = match op {
            "projection" => &["op"], "gate" => &["op", "id", "family", "project"], "choice" => &["op", "ticket", "allow"],
            "delete" => &["op", "id", "action", "project", "what"], "answer" => &["op", "ticket", "accepted"], "preference" => &["op", "id", "confirmDeletions"],
            _ => return Err("InvalidArguments".into()),
        };
        for key in object.keys() {
            if allowed.contains(&key.as_str()) { continue; }
            return Err(if FORGED.contains(&key.as_str()) || Family::ALL.iter().any(|family| family.name() == key) { DENIED } else { "InvalidArguments" }.into());
        }
        self.prune(grants);
        let text = |key: &str, max: usize| -> Result<Option<&str>> {
            match object.get(key) { None | Some(Value::Null) => Ok(None), Some(Value::String(value)) if bounded(value, max) => Ok(Some(value.as_str())), _ => Err("InvalidArguments".into()) }
        };
        let required = |key: &str, max: usize| text(key, max)?.ok_or_else(|| "InvalidArguments".to_string());
        let flag = |key: &str| object.get(key).and_then(Value::as_bool).ok_or_else(|| "InvalidArguments".to_string());
        match op {
            "projection" => Ok(self.projection()),
            "gate" => {
                let (id, family, project) = (required("id", 128)?, Family::parse(required("family", 64)?)?, text("project", 256)?);
                Ok(match self.offer(grants, id, family, project)? { (Gate::Granted, _) => json!({"decision":"granted"}), (Gate::Prompt, ticket) => json!({"decision":"prompt","ticket":ticket}) })
            }
            "choice" => { self.choose(grants, required("ticket", 64)?, flag("allow")?)?; Ok(self.projection()) }
            "delete" => {
                let (id, action, project) = (required("id", 128)?, required("action", 64)?, text("project", 256)?);
                let what = match object.get("what") { None | Some(Value::Null) => "", Some(Value::String(value)) if value.len() <= 1024 => value.as_str(), _ => return Err("InvalidArguments".into()) };
                Ok(match self.delete(grants, id, action, project, what)? { Delete::Proceed => json!({"decision":"proceed"}), Delete::Confirm { ticket, what } => json!({"decision":"confirm","ticket":ticket,"what":what}) })
            }
            "answer" => { self.answer(grants, required("ticket", 64)?, flag("accepted")?)?; Ok(json!({"decision":"proceed"})) }
            _ => { self.set_confirm_deletions(grants, required("id", 128)?, flag("confirmDeletions")?)?; Ok(self.projection()) }
        }
    }
}

/// `extensions_family_consents`: the one native entry point of the BTW and family controls; see `FamilyConsents::handle`.
#[tauri::command]
pub fn extensions_family_consents(packages: tauri::State<'_, super::packages::ExtensionPackages>, grants: tauri::State<'_, RuntimeGrants>, store: tauri::State<'_, FamilyConsents>, request: Value) -> Result<Value> {
    let snapshot = serde_json::to_value(packages.0.lock().map_err(|_| "Extension manager unavailable.")?.snapshot()).map_err(|_| "MalformedData")?;
    grants.sync(&snapshot)?;
    store.handle(&grants, &request)
}

#[cfg(test)]
mod tests {
    use super::*;
    const FIXTURE: &str = include_str!("../../../tests/fixtures/extensions/runtime-family-consents/scenario.json");
    struct Dir(PathBuf);
    impl Dir {
        fn new() -> Self { let path = std::env::temp_dir().join(format!("pandacode-family-test-{}", uuid::Uuid::new_v4())); std::fs::create_dir(&path).unwrap(); Self(path) }
        fn file(&self) -> PathBuf { self.0.join("extension-family-consents-v1").join("consents.json") }
    }
    impl Drop for Dir { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }
    fn scenario() -> Value { serde_json::from_str(FIXTURE).unwrap() }
    fn open(dir: &Dir) -> (RuntimeGrants, FamilyConsents) {
        let grants = RuntimeGrants::open(&dir.0);
        grants.sync(&json!({"safeMode":false,"packages":scenario()["packages"]})).unwrap();
        (grants, FamilyConsents::open(&dir.0))
    }
    fn grant(grants: &RuntimeGrants, id: &str, permission: &str) { grants.grant(id, permission, Scope::default()).unwrap(); }
    fn ticket(value: &Value) -> String { value["ticket"].as_str().unwrap().to_owned() }
    const API1: &str = "sample.family-api1";
    const HOLDER: &str = "sample.family-holder";
    const OTHER: &str = "sample.family-other";

    #[test]
    fn the_fixture_and_the_family_table_agree() {
        let scenario = scenario();
        let rows: Vec<(String, Vec<String>)> = scenario["families"].as_array().unwrap().iter().map(|row| (row["family"].as_str().unwrap().to_owned(), row["covering"].as_array().unwrap().iter().map(|name| name.as_str().unwrap().to_owned()).collect())).collect();
        let table: Vec<(String, Vec<String>)> = Family::ALL.iter().map(|family| (family.name().to_owned(), family.covering().iter().map(|name| (*name).to_owned()).collect())).collect();
        assert_eq!(rows, table);
        assert!(Family::ALL.iter().all(|family| family.covering().iter().all(|name| super::super::runtime_grants::PERMISSIONS.contains(name))));
    }

    #[test]
    fn a_package_holding_the_covering_permission_acts_without_a_prompt_and_one_without_it_still_gets_the_prior_choice() {
        let dir = Dir::new(); let (grants, store) = open(&dir);
        for family in Family::ALL {
            // the holder declares everything and has no grant yet: the prior choice
            grants.revoke_all(HOLDER).unwrap();
            assert_eq!(store.gate(&grants, HOLDER, family, Some("project-a")).unwrap(), Gate::Prompt, "{family:?}");
            for name in family.covering() { grants.grant(HOLDER, name, Scope { projects: Some(["project-a".to_owned()].into()), ..Scope::default() }).unwrap(); }
            assert_eq!(store.gate(&grants, HOLDER, family, Some("project-a")).unwrap(), Gate::Granted, "{family:?}");
            assert_eq!(store.gate(&grants, HOLDER, family, Some("project-b")).unwrap(), Gate::Prompt, "{family:?} narrowed to its project");
            assert_eq!(store.gate(&grants, HOLDER, family, None).unwrap(), Gate::Prompt, "{family:?} without a project");
            // an API-1 package lacking the permission keeps the prior choice and is never granted by a request
            assert_eq!(store.gate(&grants, API1, family, Some("project-a")).unwrap(), Gate::Prompt, "{family:?}");
            assert!(grants.grant(API1, family.covering()[0], Scope::default()).is_err(), "{family:?} is not declared by the API-1 package");
        }
        let task_only_start = OTHER;
        grant(&grants, task_only_start, "workspace.manage");
        assert_eq!(store.gate(&grants, OTHER, Family::Cloud, None).unwrap(), Gate::Granted, "workspace.manage covers cloud");
        assert_eq!(store.gate(&grants, OTHER, Family::Task, None).unwrap(), Gate::Prompt, "tasks.start and tasks.control are both needed");
        assert_eq!(store.gate(&grants, "sample.missing", Family::Cloud, None).unwrap_err(), DENIED);
    }

    #[test]
    fn the_stored_choice_of_an_api_1_package_survives_a_restart_and_is_bounded_by_its_project() {
        let dir = Dir::new(); let (grants, store) = open(&dir);
        let offer = store.handle(&grants, &json!({"op":"gate","id":API1,"family":"machineControl","project":"project-a"})).unwrap();
        assert_eq!(offer["decision"], "prompt");
        store.handle(&grants, &json!({"op":"choice","ticket":ticket(&offer),"allow":true})).unwrap();
        assert_eq!(store.gate(&grants, API1, Family::Machine, Some("project-a")).unwrap(), Gate::Granted);
        assert_eq!(store.gate(&grants, API1, Family::Machine, Some("project-b")).unwrap(), Gate::Prompt);
        assert_eq!(store.gate(&grants, API1, Family::Cloud, Some("project-a")).unwrap(), Gate::Prompt, "one family never covers another");
        // restart: a new process reads the file
        let (grants, store) = open(&dir);
        assert_eq!(store.gate(&grants, API1, Family::Machine, Some("project-a")).unwrap(), Gate::Granted);
        // withdrawing the choice is the user's too, and is persisted
        let offer = store.offer(&grants, API1, Family::Machine, Some("project-b")).unwrap().1.unwrap();
        store.choose(&grants, &offer, true).unwrap();
        let revoke = store.handle(&grants, &json!({"op":"gate","id":API1,"family":"machineControl","project":"project-c"})).unwrap();
        store.choose(&grants, &ticket(&revoke), false).unwrap();
        assert_eq!(store.gate(&grants, API1, Family::Machine, Some("project-a")).unwrap(), Gate::Granted, "withdrawing a project that was never consented changes nothing");
        // an update that disables the package or a safe-mode start leaves no authority
        grants.sync(&json!({"safeMode":true,"packages":scenario()["packages"]})).unwrap();
        assert_eq!(store.gate(&grants, API1, Family::Machine, Some("project-a")).unwrap(), Gate::Prompt);
        grants.sync(&json!({"safeMode":false,"packages":scenario()["packages"]})).unwrap();
        assert_eq!(store.gate(&grants, API1, Family::Machine, Some("project-a")).unwrap(), Gate::Granted);
        // an uninstall drops the stored choice
        grants.sync(&json!({"safeMode":false,"packages":[scenario()["packages"][0].clone()]})).unwrap();
        store.handle(&grants, &json!({"op":"projection"})).unwrap();
        assert!(store.projection()["packages"].as_array().unwrap().is_empty());
    }

    #[test]
    fn a_package_that_declares_the_permission_gets_the_native_grant_from_the_choice_and_btw_is_covered_like_the_families() {
        let dir = Dir::new(); let (grants, store) = open(&dir);
        for (family, permission) in [("btwContent", "btw.content"), ("btwControl", "btw.taskControl")] {
            let offer = store.handle(&grants, &json!({"op":"gate","id":HOLDER,"family":family,"project":"project-a"})).unwrap();
            assert_eq!(offer["decision"], "prompt", "{family}");
            store.handle(&grants, &json!({"op":"choice","ticket":ticket(&offer),"allow":true})).unwrap();
            assert!(grants.check(HOLDER, "1.0.0", permission, &Target::project("project-a")).is_ok(), "{family} is a native grant now");
            assert!(grants.check(HOLDER, "1.0.0", permission, &Target::project("project-b")).is_err(), "{family}");
            assert_eq!(store.handle(&grants, &json!({"op":"gate","id":HOLDER,"family":family,"project":"project-a"})).unwrap()["decision"], "granted", "{family}");
        }
        // restart: the grants file keeps it
        let (grants, store) = open(&dir);
        assert_eq!(store.gate(&grants, HOLDER, Family::BtwContent, Some("project-a")).unwrap(), Gate::Granted);
        // the choice to withdraw revokes the grant
        let offer = store.offer(&grants, HOLDER, Family::BtwContent, Some("project-b")).unwrap().1.unwrap();
        store.choose(&grants, &offer, true).unwrap();
        let again = (Family::BtwContent, "project-a");
        assert_eq!(store.gate(&grants, HOLDER, again.0, Some(again.1)).unwrap(), Gate::Granted);
        let scope = grants.projection()["packages"].as_array().unwrap().iter().find(|package| package["id"] == HOLDER).unwrap()["grants"].as_array().unwrap().iter().find(|grant| grant["permission"] == "btw.content").unwrap()["scope"]["projects"].clone();
        assert_eq!(scope, json!(["project-a", "project-b"]));
    }

    #[test]
    fn a_forged_consent_is_rejected_natively_in_every_family_and_changes_nothing() {
        let dir = Dir::new(); let (grants, store) = open(&dir);
        let before = grants.projection();
        for family in Family::ALL {
            for key in ["consent", "granted", "confirmed", "approved", family.name(), "permission"] {
                let mut request = json!({"op":"gate","id":API1,"family":family.name(),"project":"project-a"});
                request[key] = json!(true);
                assert_eq!(store.handle(&grants, &request).unwrap_err(), DENIED, "{family:?} {key}");
            }
            // a choice without a ticket minted by the native gate, a made-up ticket and a reused ticket
            assert_eq!(store.handle(&grants, &json!({"op":"choice","ticket":"forged","allow":true})).unwrap_err(), DENIED, "{family:?}");
            let offer = store.handle(&grants, &json!({"op":"gate","id":API1,"family":family.name(),"project":"project-a"})).unwrap();
            let token = ticket(&offer);
            store.handle(&grants, &json!({"op":"choice","ticket":token,"allow":false})).unwrap();
            assert_eq!(store.handle(&grants, &json!({"op":"choice","ticket":token,"allow":true})).unwrap_err(), DENIED, "{family:?} a ticket is single use");
            assert_eq!(store.gate(&grants, API1, family, Some("project-a")).unwrap(), Gate::Prompt, "{family:?}");
        }
        assert_eq!(grants.projection(), before, "no forged request reached the grants");
        assert_eq!(store.handle(&grants, &json!({"op":"gate","id":API1,"family":"machineControl","consents":{"machineControl":true}})).unwrap_err(), DENIED);
        assert_eq!(store.handle(&grants, &json!({"op":"gate","id":API1,"family":"machineControl","extra":1})).unwrap_err(), "InvalidArguments");
        assert_eq!(store.handle(&grants, &json!({"op":"delete","id":HOLDER,"action":"projects.remove","confirmed":true})).unwrap_err(), DENIED);
        // a ticket of one package never answers for another, and a delete ticket is not a choice ticket
        let offer = store.offer(&grants, API1, Family::Machine, Some("project-a")).unwrap().1.unwrap();
        grant(&grants, HOLDER, "workspace.manage");
        let Delete::Confirm { ticket: confirm, .. } = store.delete(&grants, HOLDER, "projects.remove", None, "x").unwrap() else { panic!("must confirm") };
        assert_eq!(store.choose(&grants, &confirm, true).unwrap_err(), DENIED);
        store.choose(&grants, &offer, true).unwrap();
        assert_eq!(store.gate(&grants, OTHER, Family::Machine, Some("project-a")).unwrap(), Gate::Prompt, "the choice stayed with its package");
        // pairing and remote access are not families: they are the user's alone
        for name in ["pairing", "pair", "remoteAccess"] {
            assert_eq!(store.handle(&grants, &json!({"op":"gate","id":HOLDER,"family":name})).unwrap_err(), DENIED, "{name}");
        }
        assert_eq!(store.handle(&grants, &json!({"op":"gate","id":HOLDER,"family":"credentials.read"})).unwrap_err(), "UnsupportedCapability");
    }

    #[test]
    fn irreversible_deletion_confirms_by_default_a_refusal_is_cancelled_and_the_switch_is_per_package() {
        let dir = Dir::new(); let (grants, store) = open(&dir);
        for id in [HOLDER, OTHER] { grant(&grants, id, "workspace.manage"); }
        for (action, _) in IRREVERSIBLE {
            let ask = json!({"op":"delete","id":HOLDER,"action":action,"what":"Project\u{0007} Alpha"});
            let first = store.handle(&grants, &ask).unwrap();
            assert_eq!(first["decision"], "confirm", "{action}");
            assert_eq!(first["what"], "Project Alpha", "{action}");
            assert_eq!(store.handle(&grants, &json!({"op":"answer","ticket":ticket(&first),"accepted":false})).unwrap_err(), "Cancelled", "{action}");
            let second = store.handle(&grants, &ask).unwrap();
            assert_eq!(store.handle(&grants, &json!({"op":"answer","ticket":ticket(&second),"accepted":true})).unwrap()["decision"], "proceed", "{action}");
            assert_eq!(store.handle(&grants, &json!({"op":"answer","ticket":ticket(&second),"accepted":true})).unwrap_err(), DENIED, "{action} a confirmation answers once");
        }
        assert_eq!(store.handle(&grants, &json!({"op":"delete","id":HOLDER,"action":"packages.format"})).unwrap_err(), "UnsupportedCapability");
        // turning the confirmation off affects only this package, survives a restart and can be turned back on
        store.handle(&grants, &json!({"op":"preference","id":HOLDER,"confirmDeletions":false})).unwrap();
        assert_eq!(store.handle(&grants, &json!({"op":"delete","id":HOLDER,"action":"tasks.remove"})).unwrap()["decision"], "proceed");
        assert_eq!(store.handle(&grants, &json!({"op":"delete","id":OTHER,"action":"tasks.remove"})).unwrap()["decision"], "confirm");
        let (grants, store) = open(&dir);
        assert_eq!(store.handle(&grants, &json!({"op":"delete","id":HOLDER,"action":"tasks.remove"})).unwrap()["decision"], "proceed");
        assert_eq!(store.handle(&grants, &json!({"op":"delete","id":OTHER,"action":"tasks.remove"})).unwrap()["decision"], "confirm");
        store.handle(&grants, &json!({"op":"preference","id":HOLDER,"confirmDeletions":true})).unwrap();
        assert_eq!(store.handle(&grants, &json!({"op":"delete","id":HOLDER,"action":"tasks.remove"})).unwrap()["decision"], "confirm");
        assert!(store.projection()["packages"].as_array().unwrap().is_empty(), "the default is not stored");
        // a package without the covering permission cannot delete at all, with or without the switch
        store.handle(&grants, &json!({"op":"preference","id":API1,"confirmDeletions":false})).unwrap();
        for action in ["projects.remove", "cloud.machines.remove", "pulls.merge"] { assert_eq!(store.handle(&grants, &json!({"op":"delete","id":API1,"action":action})).unwrap_err(), DENIED, "{action}"); }
        // revoked while the dialog is open: the answer is refused
        let pending = store.handle(&grants, &json!({"op":"delete","id":OTHER,"action":"pulls.merge"})).unwrap();
        grants.revoke(OTHER, "workspace.manage").unwrap();
        assert_eq!(store.handle(&grants, &json!({"op":"answer","ticket":ticket(&pending),"accepted":true})).unwrap_err(), DENIED);
    }

    #[test]
    fn a_corrupt_file_is_kept_and_answers_denied_and_a_failed_write_changes_nothing() {
        let dir = Dir::new(); let (grants, store) = open(&dir);
        let offer = store.offer(&grants, API1, Family::Pull, None).unwrap().1.unwrap();
        std::fs::create_dir_all(dir.file().parent().unwrap()).unwrap();
        std::fs::create_dir(dir.file().with_extension("stage")).unwrap();
        assert_eq!(store.choose(&grants, &offer, true).unwrap_err(), "StorageUnavailable");
        assert_eq!(store.gate(&grants, API1, Family::Pull, None).unwrap(), Gate::Prompt);
        std::fs::remove_dir(dir.file().with_extension("stage")).unwrap();
        std::fs::write(dir.file(), b"{malformed").unwrap();
        let corrupt = FamilyConsents::open(&dir.0);
        assert_eq!(corrupt.projection()["available"], false);
        assert_eq!(corrupt.gate(&grants, API1, Family::Pull, None).unwrap(), Gate::Prompt);
        assert_eq!(corrupt.set_confirm_deletions(&grants, API1, false).unwrap_err(), "MalformedData");
        assert_eq!(std::fs::read(dir.file()).unwrap(), b"{malformed");
        std::fs::write(dir.file(), br#"{"schemaVersion":1,"revision":0,"packages":{"x":{"consents":{"credentials.read":null}}}}"#).unwrap();
        assert_eq!(FamilyConsents::open(&dir.0).projection()["available"], false, "an unknown family is refused, not trusted");
    }
}
