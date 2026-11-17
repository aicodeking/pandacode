//! Bots and shared channels for trusted services (`workspace.bots`, `workspace.channels`, runtime phase R4, slice R0406).
//!
//! A trusted service creates, changes and removes bots and shared bot channels with
//! `panda.workspace.bots.create(input)`, `update(botId, input)`, `remove(botId)` and the same three calls on
//! `panda.workspace.channels`. Each call is a thin adapter over the operation the interface itself runs: `bots::create`,
//! `bots::update`, `bots::set_capabilities` and `bots::delete` (with the gateway and channel connections stopped first, as
//! `bot_delete` does), and `bot_shared_channel_create`, `bot_shared_channel_update` and `bot_shared_channel_archive`.
//! Inputs are the camelCase objects the sidebar's forms send (`BotInput`, plus `skills` and `mcp` as `bot_set_capabilities`
//! takes them; a channel is `{ name, memberIds, leadBotId }`). `update` is a patch: a field that is not named keeps its
//! value. Removing a channel archives it (the interface's "Delete channel", restorable under Deleted channels) and stops
//! its pending work, as the interface does.
//!
//! The permission is `workspace.manage`: global (a bot or a channel belongs to no user project, so a grant narrowed to
//! projects does not cover it), granted with the trust decision and checked against the grants file on every call, once at
//! admission and again right before the effect, so a revoke, a disable or a narrowing in between changes nothing. A package
//! that holds it is never asked per action (ADR-0005). The one exception is the irreversible deletion
//! (`bots.remove`, `channels.remove`): the host confirmation is kept by default and the user can turn it off per package
//! (`runtime_family_consents`); a refusal answers `Cancelled` and removes nothing. The refusals are the frozen ones:
//! - no grant, a revoked grant, a disabled package or safe mode: `PermissionDenied`, with the permission name in `path`;
//! - an unknown or already removed bot or channel: `NotFound`; a channel that was archived: `StaleContext`;
//! - a shape or value the form does not take: `InvalidShape` (`path` names the field); a bound: `LimitExceeded`;
//! - a confirmation nobody answered in time, or one that cannot be shown (no window): `Timeout` / `HostUnavailable`.
//!
//! Every effect is attributed. A bot's activity log gets a line naming the package; both bots and channels are recorded
//! in a file-backed ledger (independent of SQLite, so the schema stays as it is) that survives the package, and the
//! window reads it through `extensions_workspace_automation_origins`. Shared-channel posts, stop, continue and reassign
//! are tasks for the `tasks.*` calls (PLAN.md, Scope settled); recipes and wake-ups, moodboards and cloud belong to the
//! sibling slices.
//!
//! Bounds are for predictability and fault isolation, never for trust: a 512 KiB text, four backup models, fifty skill or
//! MCP references (the interface's own bounds), 64 channel members, eight confirmations waiting at once, two per package,
//! 120 s to answer one, and a ledger of 10,000 entries (the oldest goes first). The rules are pure (no app handle) so they
//! are deterministic to test; the app half (`serve` and the three commands) only adds the grants file, the store and the
//! window.
use serde_json::{json, Map, Value};
use std::{collections::BTreeMap, path::{Path, PathBuf}, sync::Mutex, time::Duration};
use tokio::sync::oneshot;

/// The named permission (global, granted with the trust decision, rechecked on every call).
pub const PERMISSION: &str = "workspace.manage";
pub const SCHEMA_VERSION: u64 = 1;
/// The fields of a bot form (`BotInput`), then the two reference lists `bot_set_capabilities` takes.
pub const BOT_FIELDS: [&str; 19] = [
    "name", "role", "instructions", "goals", "soul", "avatar", "provider", "model", "mode", "heartbeatMinutes", "color", "reasoningEffort", "backupModels",
    "fallbackMode", "notify", "whileWorking", "showPlan", "skills", "mcp",
];
const BOT_TEXT: [&str; 12] = ["name", "role", "instructions", "goals", "soul", "avatar", "provider", "model", "mode", "color", "reasoningEffort", "fallbackMode"];
pub const CHANNEL_FIELDS: [&str; 3] = ["name", "memberIds", "leadBotId"];
pub const MAX_TEXT_BYTES: usize = 512 * 1024;
pub const MAX_BACKUPS: usize = 4;
pub const MAX_REFERENCES: usize = 50;
pub const MAX_MEMBERS: usize = 64;
pub const MAX_ORIGINS: usize = 10_000;
pub const MAX_CONFIRMATIONS: usize = 8;
pub const MAX_CONFIRMATIONS_PER_PACKAGE: usize = 2;
pub const CONFIRM_WAIT: Duration = Duration::from_secs(120);

/// A refusal in the broker envelope: `code`, the `path` it names and the `ids` it carries.
pub fn failure_with(code: &str, path: &str, ids: &[String]) -> Value { json!({"ok": false, "error": {"schemaVersion": 1, "code": code, "path": path, "ids": ids}}) }
fn ok(value: Value) -> Value { json!({"ok": true, "value": value}) }

/// What admission may refuse.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Refusal { pub code: String, pub path: String }
impl Refusal {
    pub fn new(code: &str, path: &str) -> Self { Self { code: code.into(), path: path.into() } }
    pub fn envelope(&self) -> Value { failure_with(&self.code, &self.path, &[]) }
}
fn shape(path: &str) -> Refusal { Refusal::new("InvalidShape", path) }

fn ident(text: &str) -> bool { !text.is_empty() && text.chars().count() <= 128 && !text.chars().any(char::is_control) }

// ---- Forms ---------------------------------------------------------------------------------------------------------------

fn object<'a>(value: &'a Value, allowed: &[&str]) -> Result<&'a Map<String, Value>, Refusal> {
    let map = value.as_object().ok_or_else(|| shape("input"))?;
    if let Some(unknown) = map.keys().find(|key| !allowed.contains(&key.as_str())) { return Err(shape(unknown)); }
    Ok(map)
}
fn references(value: &Value, name: &str, skill: bool) -> Result<(), Refusal> {
    let items = value.as_array().ok_or_else(|| shape(name))?;
    if items.len() > MAX_REFERENCES { return Err(Refusal::new("LimitExceeded", name)); }
    for item in items {
        let text = item.as_str().map(str::trim).ok_or_else(|| shape(name))?;
        let valid = !text.is_empty() && text.len() <= if skill { 64 } else { 100 }
            && if skill { text.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-') } else { !text.chars().any(char::is_control) };
        if !valid { return Err(shape(name)); }
    }
    Ok(())
}

/// The fields of a bot form a call names, checked for shape and bound before anything is touched. Values the interface
/// itself decides (a known harness, a permission mode, a color) are decided by the same code when it runs.
pub fn bot_patch(input: &Value, creating: bool) -> Result<Map<String, Value>, Refusal> {
    let map = object(input, &BOT_FIELDS)?;
    for (key, value) in map {
        let key = key.as_str();
        if BOT_TEXT.contains(&key) || key == "whileWorking" {
            let text = value.as_str().ok_or_else(|| shape(key))?;
            if text.len() > MAX_TEXT_BYTES { return Err(Refusal::new("LimitExceeded", key)); }
        } else if key == "heartbeatMinutes" {
            if value.as_i64().is_none() { return Err(shape(key)); }
        } else if key == "notify" || key == "showPlan" {
            if !value.is_boolean() { return Err(shape(key)); }
        } else if key == "backupModels" {
            let items = value.as_array().ok_or_else(|| shape(key))?;
            if items.len() > MAX_BACKUPS { return Err(Refusal::new("LimitExceeded", key)); }
            for item in items {
                let row = object(item, &["provider", "model"]).map_err(|_| shape(key))?;
                if !["provider", "model"].iter().all(|name| row.get(*name).is_some_and(Value::is_string)) { return Err(shape(key)); }
            }
        } else if key == "skills" || key == "mcp" {
            references(value, key, key == "skills")?;
        }
    }
    if creating && !map.get("name").and_then(Value::as_str).is_some_and(|name| !name.trim().is_empty()) { return Err(shape("name")); }
    Ok(map.clone())
}

/// The fields of a channel form a call names. `leadBotId` may be `null` (the first member leads).
pub fn channel_patch(input: &Value, creating: bool) -> Result<Map<String, Value>, Refusal> {
    let map = object(input, &CHANNEL_FIELDS)?;
    if let Some(name) = map.get("name") {
        let name = name.as_str().ok_or_else(|| shape("name"))?;
        if name.len() > MAX_TEXT_BYTES { return Err(Refusal::new("LimitExceeded", "name")); }
    }
    if let Some(members) = map.get("memberIds") {
        let items = members.as_array().ok_or_else(|| shape("memberIds"))?;
        if items.len() > MAX_MEMBERS { return Err(Refusal::new("LimitExceeded", "memberIds")); }
        let mut seen = std::collections::BTreeSet::new();
        for item in items { if !item.as_str().is_some_and(|id| ident(id) && seen.insert(id)) { return Err(shape("memberIds")); } }
    }
    if let Some(lead) = map.get("leadBotId") { if !lead.is_null() && !lead.as_str().is_some_and(ident) { return Err(shape("leadBotId")); } }
    if creating && !(map.contains_key("name") && map.contains_key("memberIds")) { return Err(shape(if map.contains_key("name") { "memberIds" } else { "name" })); }
    Ok(map.clone())
}

/// The bot form to run: the current bot's fields (`base`, `null` when creating) with the named ones laid over them, and
/// the reference lists apart (they are saved by their own operation, and only when named).
pub fn bot_merge(base: &Value, patch: &Map<String, Value>) -> Map<String, Value> {
    let mut merged = Map::new();
    for key in BOT_FIELDS { if let Some(value) = base.get(key) { merged.insert(key.to_owned(), value.clone()); } }
    for (key, value) in patch { merged.insert(key.clone(), value.clone()); }
    merged
}
/// The channel form to run: the current channel with the named fields laid over it. A lead that is no longer a member
/// falls back to the first member, as the interface does.
pub fn channel_merge(base: &Value, patch: &Map<String, Value>) -> Map<String, Value> {
    let mut merged = Map::new();
    for key in CHANNEL_FIELDS { if let Some(value) = base.get(key) { merged.insert(key.to_owned(), value.clone()); } }
    for (key, value) in patch { merged.insert(key.clone(), value.clone()); }
    let members: Vec<&str> = merged.get("memberIds").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).collect();
    let lead_stays = merged.get("leadBotId").and_then(Value::as_str).is_some_and(|lead| members.contains(&lead));
    if !lead_stays { merged.insert("leadBotId".into(), Value::Null); }
    merged
}
/// A string list out of a merged form (`memberIds`, `skills`, `mcp`).
pub fn strings(map: &Map<String, Value>, key: &str) -> Option<Vec<String>> {
    map.get(key).and_then(Value::as_array).map(|items| items.iter().filter_map(Value::as_str).map(str::to_owned).collect())
}

/// The refusal an operation of the interface's own code answers with, from the message it would show the user.
pub fn refusal_of(message: &str) -> Refusal {
    let text = message.to_lowercase();
    if text.contains("no longer exists") { return Refusal::new("NotFound", "$"); }
    if text.contains("is deleted") { return Refusal::new("StaleContext", "$"); }
    let path = if text.contains("channel name") || text.contains("name the bot") || text.contains("a name") { "name" }
        else if text.contains("permission mode") { "mode" }
        else if text.contains("harness and model") { "provider" }
        else if text.contains("check-ins") { "heartbeatMinutes" }
        else if text.contains("personality") { "soul" }
        else if text.contains("color") { "color" }
        else if text.contains("reasoning") { "reasoningEffort" }
        else if text.contains("backup") { "backupModels" }
        else if text.contains("lead") { "leadBotId" }
        else if text.contains("member") || text.contains("bot that belongs") || text.contains("choose bots") { "memberIds" }
        else if text.contains("skill") || text.contains("mcp") { "skills" }
        else if text.contains("setting from the list") { "fallbackMode" }
        else { return Refusal::new("HostUnavailable", "$") };
    Refusal::new("InvalidShape", path)
}

/// What the irreversible-deletion table calls each removal.
pub fn removal_action(family: &str) -> Option<&'static str> {
    match family { "bots" => Some("bots.remove"), "channels" => Some("channels.remove"), _ => None }
}

/// A validated request: the family, the call and what it names.
#[derive(Clone, Debug, PartialEq)]
pub struct Request { pub family: Family, pub op: Op, pub id: Option<String>, pub input: Value }
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Family { Bots, Channels }
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Op { Create, Update, Remove }

/// Reads `{ family, op, id?, input? }` and checks it for shape and bound. Nothing is touched yet.
pub fn read_request(params: &Value) -> Result<Request, Refusal> {
    let map = params.as_object().ok_or_else(|| shape("$"))?;
    if let Some(unknown) = map.keys().find(|key| !matches!(key.as_str(), "family" | "op" | "id" | "input")) { return Err(shape(unknown)); }
    let family = match map.get("family").and_then(Value::as_str) { Some("bots") => Family::Bots, Some("channels") => Family::Channels, _ => return Err(shape("family")) };
    let op = match map.get("op").and_then(Value::as_str) { Some("create") => Op::Create, Some("update") => Op::Update, Some("remove") => Op::Remove, _ => return Err(shape("op")) };
    let id = match (op, map.get("id")) {
        (Op::Create, None | Some(Value::Null)) => None,
        (Op::Create, Some(_)) => return Err(shape("id")),
        (_, Some(Value::String(id))) if ident(id) => Some(id.clone()),
        _ => return Err(shape(if family == Family::Bots { "botId" } else { "channelId" })),
    };
    let input = map.get("input").cloned().unwrap_or(Value::Null);
    match (op, family) {
        (Op::Remove, _) => { if !input.is_null() { return Err(shape("input")); } }
        (_, Family::Bots) => { bot_patch(&input, op == Op::Create)?; }
        (_, Family::Channels) => { channel_patch(&input, op == Op::Create)?; }
    }
    Ok(Request { family, op, id, input })
}

// ---- Attribution and the confirmations waiting for the window -----------------------------------------------------------

/// Who made a change: the package id and the name it showed, kept after the package is gone.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Origin { pub package: String, pub name: String, pub action: String, pub at: u64, seq: u64 }

#[derive(Default)]
struct Ledger { revision: u64, seq: u64, entries: BTreeMap<String, Origin> }
/// One deletion waiting for the user's answer.
struct Waiting { owner: String, name: String, action: String, what: String, sender: Option<oneshot::Sender<Result<(), String>>> }

/// Attribution and pending confirmations (one managed state; the origins are file-backed next to the grants).
pub struct Automation { ledger: Mutex<Ledger>, file: Option<PathBuf>, waiting: Mutex<BTreeMap<String, Waiting>> }
impl Default for Automation { fn default() -> Self { Self { ledger: Mutex::new(Ledger::default()), file: None, waiting: Mutex::new(BTreeMap::new()) } } }

impl Automation {
    /// Opens (or starts) the ledger in `dir`; an unreadable file starts empty and is replaced on the next change.
    pub fn open(dir: &Path) -> Self {
        let file = dir.join("workspace-automation-origins.json");
        let mut ledger = Ledger::default();
        if let Some(root) = std::fs::read_to_string(&file).ok().and_then(|text| serde_json::from_str::<Value>(&text).ok()) {
            ledger.revision = root["revision"].as_u64().unwrap_or(0);
            for (key, row) in root["entries"].as_object().into_iter().flatten().take(MAX_ORIGINS) {
                let (Some(package), Some(name), Some(action)) = (row["package"].as_str(), row["name"].as_str(), row["action"].as_str()) else { continue };
                ledger.seq += 1;
                ledger.entries.insert(key.clone(), Origin { package: package.into(), name: name.into(), action: action.into(), at: row["at"].as_u64().unwrap_or(0), seq: ledger.seq });
            }
        }
        Self { ledger: Mutex::new(ledger), file: Some(file), waiting: Mutex::new(BTreeMap::new()) }
    }
    fn save(&self, ledger: &Ledger) {
        let Some(file) = &self.file else { return };
        let mut rows: Vec<(&String, &Origin)> = ledger.entries.iter().collect();
        rows.sort_by_key(|(_, origin)| origin.seq);
        let entries: Map<String, Value> = rows.into_iter().map(|(key, origin)| (key.clone(), json!({"package": origin.package, "name": origin.name, "action": origin.action, "at": origin.at}))).collect();
        let temporary = file.with_extension("json.tmp");
        if std::fs::write(&temporary, json!({"schemaVersion": SCHEMA_VERSION, "revision": ledger.revision, "entries": entries}).to_string()).is_ok() { let _ = std::fs::rename(&temporary, file); }
    }
    /// Records that `package` made `action` on `key` (`bot:<id>` or `channel:<id>`); the newest record per key stays.
    pub fn record(&self, key: &str, package: &str, name: &str, action: &str) {
        let Ok(mut ledger) = self.ledger.lock() else { return };
        ledger.seq += 1;
        ledger.revision += 1;
        let (seq, at) = (ledger.seq, std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_secs()));
        ledger.entries.insert(key.to_owned(), Origin { package: package.into(), name: name.chars().filter(|c| !c.is_control()).take(120).collect(), action: action.into(), at, seq });
        while ledger.entries.len() > MAX_ORIGINS {
            let Some(oldest) = ledger.entries.iter().min_by_key(|(_, origin)| origin.seq).map(|(key, _)| key.clone()) else { break };
            ledger.entries.remove(&oldest);
        }
        self.save(&ledger);
    }
    pub fn revision(&self) -> u64 { self.ledger.lock().map_or(0, |ledger| ledger.revision) }
    /// `{ schemaVersion, revision, origins: { "bot:<id>": { package, name, action, at } } }`.
    pub fn origins(&self) -> Value {
        let Ok(ledger) = self.ledger.lock() else { return json!({"schemaVersion": SCHEMA_VERSION, "revision": 0, "origins": {}}) };
        let origins: Map<String, Value> = ledger.entries.iter().map(|(key, origin)| (key.clone(), json!({"package": origin.package, "name": origin.name, "action": origin.action, "at": origin.at}))).collect();
        json!({"schemaVersion": SCHEMA_VERSION, "revision": ledger.revision, "origins": origins})
    }

    /// Registers a deletion that waits for the user's answer. Eight wait at once and two per package.
    pub fn begin(&self, ticket: &str, owner: &str, name: &str, action: &str, what: &str) -> Result<oneshot::Receiver<Result<(), String>>, &'static str> {
        let mut waiting = self.waiting.lock().map_err(|_| "HostUnavailable")?;
        if waiting.len() >= MAX_CONFIRMATIONS || waiting.values().filter(|entry| entry.owner == owner).count() >= MAX_CONFIRMATIONS_PER_PACKAGE { return Err("LimitExceeded"); }
        let (sender, receiver) = oneshot::channel();
        waiting.insert(ticket.to_owned(), Waiting { owner: owner.into(), name: name.chars().filter(|c| !c.is_control()).take(120).collect(), action: action.into(), what: what.into(), sender: Some(sender) });
        Ok(receiver)
    }
    /// Delivers the user's answer to the call that waits for it; `false` when nothing waits (it timed out).
    pub fn resolve(&self, ticket: &str, answer: Result<(), String>) -> bool {
        let Ok(mut waiting) = self.waiting.lock() else { return false };
        let Some(mut entry) = waiting.remove(ticket) else { return false };
        entry.sender.take().is_some_and(|sender| sender.send(answer).is_ok())
    }
    pub fn abandon(&self, ticket: &str) { if let Ok(mut waiting) = self.waiting.lock() { waiting.remove(ticket); } }
    /// The deletions the window must still ask about (it asks at start, and when it hears of one).
    pub fn pending(&self) -> Value {
        let Ok(waiting) = self.waiting.lock() else { return json!({"schemaVersion": SCHEMA_VERSION, "pending": []}) };
        let pending: Vec<Value> = waiting.iter().map(|(ticket, entry)| json!({"ticket": ticket, "owner": entry.owner, "name": entry.name, "action": entry.action, "what": entry.what})).collect();
        json!({"schemaVersion": SCHEMA_VERSION, "pending": pending})
    }
}

// ---- The app -------------------------------------------------------------------------------------------------------------

type Outcome<T> = Result<T, Refusal>;

fn automation(app: &tauri::AppHandle) -> Option<tauri::State<'_, Automation>> { use tauri::Manager; app.try_state::<Automation>() }

/// What the package is right now: its version, the name it shows and the snapshot the grants were read against.
fn resolve_package(app: &tauri::AppHandle, owner: &str) -> Outcome<(String, String, Value)> {
    use tauri::Manager;
    let denied = || Refusal::new("PermissionDenied", PERMISSION);
    let packages = app.try_state::<crate::extensions::packages::ExtensionPackages>().ok_or_else(|| Refusal::new("UnsupportedCapability", "$"))?;
    let packages = packages.0.try_lock().map_err(|_| Refusal::new("Timeout", "$"))?;
    let snapshot = packages.snapshot();
    if snapshot.safe_mode { return Err(denied()); }
    let package = snapshot.packages.iter().find(|package| package.enabled && package.manifest["id"] == owner).ok_or_else(denied)?;
    let version = package.manifest["version"].as_str().ok_or_else(denied)?.to_owned();
    let name = package.manifest["name"].as_str().unwrap_or(owner).to_owned();
    Ok((version, name, serde_json::to_value(&snapshot).unwrap_or(Value::Null)))
}

/// The bot a call names, as the interface lists it.
fn current_bot(app: &tauri::AppHandle, id: &str) -> Outcome<Value> {
    use tauri::Manager;
    let state = app.state::<crate::AppState>();
    let store = state.store.lock().map_err(|_| Refusal::new("HostUnavailable", "$"))?;
    crate::bots::get(&store, id).map(|bot| serde_json::to_value(bot).unwrap_or(Value::Null)).map_err(|message| refusal_of(&message))
}
fn current_channel(app: &tauri::AppHandle, id: &str) -> Outcome<Value> {
    use tauri::Manager;
    let state = app.state::<crate::AppState>();
    let store = state.store.lock().map_err(|_| Refusal::new("HostUnavailable", "$"))?;
    let channels = crate::bots::shared_channels::list(&store).map_err(|message| refusal_of(&message))?;
    channels.into_iter().find(|channel| channel.id == id).map(|channel| serde_json::to_value(channel).unwrap_or(Value::Null)).ok_or_else(|| Refusal::new("NotFound", "channelId"))
}

fn bot_effect(app: &tauri::AppHandle, request: &Request, owner: &str, label: &str) -> Outcome<Value> {
    use tauri::{Emitter, Manager};
    let patch = bot_patch(&request.input, request.op == Op::Create)?;
    let base = match &request.id { Some(id) => current_bot(app, id)?, None => Value::Null };
    let merged = bot_merge(&base, &patch);
    let (skills, mcp) = (strings(&patch, "skills"), strings(&patch, "mcp"));
    let mut form = merged.clone();
    form.remove("skills");
    form.remove("mcp");
    let input: crate::bots::BotInput = serde_json::from_value(Value::Object(form)).map_err(|_| shape("input"))?;
    let state = app.state::<crate::AppState>();
    let bot = {
        let store = state.store.lock().map_err(|_| Refusal::new("HostUnavailable", "$"))?;
        let bot = match &request.id {
            Some(id) => crate::bots::update(&store, id, &input),
            None => crate::bots::create(&store, &input, &crate::bots::workspace_root()),
        }.map_err(|message| refusal_of(&message))?;
        let bot = if skills.is_some() || mcp.is_some() {
            let skills = skills.or_else(|| strings(&base.as_object().cloned().unwrap_or_default(), "skills")).unwrap_or_default();
            let mcp = mcp.or_else(|| strings(&base.as_object().cloned().unwrap_or_default(), "mcp")).unwrap_or_default();
            crate::bots::set_capabilities(&store, &bot.id, &skills, &mcp).map_err(|message| refusal_of(&message))?
        } else { bot };
        let summary = if request.id.is_some() { format!("Settings changed by extension {label}") } else { format!("Created by extension {label}") };
        let _ = crate::bots::log(&store, &bot.id, "extension", &summary, json!({"package": owner}));
        bot
    };
    if let Some(automation) = automation(app) { automation.record(&format!("bot:{}", bot.id), owner, label, if request.id.is_some() { "updated" } else { "created" }); }
    let _ = app.emit("bots-changed", ());
    let _ = app.emit("extensions-workspace-automation-origins", automation(app).map_or(0, |automation| automation.revision()));
    Ok(serde_json::to_value(bot).unwrap_or(Value::Null))
}

async fn bot_remove(app: &tauri::AppHandle, id: &str, owner: &str, label: &str) -> Outcome<Value> {
    use tauri::{Emitter, Manager};
    // The gateway and the channel connections stop first, as `bot_delete` does; the workspace folder stays on disk.
    crate::bots::gateway::stop_bot(app, id).await;
    crate::bots::channels::stop_bot_channels(app, id).await;
    {
        let state = app.state::<crate::AppState>();
        let store = state.store.lock().map_err(|_| Refusal::new("HostUnavailable", "$"))?;
        crate::bots::delete(&store, id).map_err(|message| refusal_of(&message))?;
    }
    if let Some(automation) = automation(app) { automation.record(&format!("bot:{id}"), owner, label, "removed"); }
    let _ = app.emit("bot-shared-channel-changed", json!({}));
    let _ = app.emit("bots-changed", ());
    let _ = app.emit("sessions-changed", ());
    let _ = app.emit("extensions-workspace-automation-origins", automation(app).map_or(0, |automation| automation.revision()));
    Ok(Value::Null)
}

async fn channel_effect(app: &tauri::AppHandle, request: &Request, owner: &str, label: &str) -> Outcome<Value> {
    use tauri::{Emitter, Manager};
    let patch = channel_patch(&request.input, request.op == Op::Create)?;
    let base = match &request.id { Some(id) => current_channel(app, id)?, None => Value::Null };
    let merged = channel_merge(&base, &patch);
    let name = merged.get("name").and_then(Value::as_str).unwrap_or_default().to_owned();
    let members = strings(&merged, "memberIds").unwrap_or_default();
    let lead = merged.get("leadBotId").and_then(Value::as_str).map(str::to_owned);
    let state = app.state::<crate::AppState>();
    let channel = match &request.id {
        // The interface's own commands: a removed member's pending work stops and the window is told.
        Some(id) => crate::bots::shared_channels::bot_shared_channel_update(app.clone(), state, id.clone(), name, members, lead).await,
        None => crate::bots::shared_channels::bot_shared_channel_create(app.clone(), state, name, members).await,
    }.map_err(|message| refusal_of(&message))?;
    if let Some(automation) = automation(app) { automation.record(&format!("channel:{}", channel.id), owner, label, if request.id.is_some() { "updated" } else { "created" }); }
    let _ = app.emit("extensions-workspace-automation-origins", automation(app).map_or(0, |automation| automation.revision()));
    Ok(serde_json::to_value(channel).unwrap_or(Value::Null))
}

async fn channel_remove(app: &tauri::AppHandle, id: &str, owner: &str, label: &str) -> Outcome<Value> {
    use tauri::{Emitter, Manager};
    let state = app.state::<crate::AppState>();
    // Archiving is the interface's "Delete channel": pending work stops and the channel stays restorable.
    crate::bots::shared_channels::bot_shared_channel_archive(app.clone(), state, id.to_owned(), true).await.map_err(|message| refusal_of(&message))?;
    if let Some(automation) = automation(app) { automation.record(&format!("channel:{id}"), owner, label, "removed"); }
    let _ = app.emit("extensions-workspace-automation-origins", automation(app).map_or(0, |automation| automation.revision()));
    Ok(Value::Null)
}

/// Asks the host to confirm an irreversible deletion, when the package's preference says so, and waits for the answer.
async fn confirmed(app: &tauri::AppHandle, owner: &str, label: &str, request: &Request, what: &str, snapshot: &Value) -> Outcome<()> {
    use tauri::{Emitter, Manager};
    let (Some(consents), Some(grants)) = (app.try_state::<crate::extensions::runtime_family_consents::FamilyConsents>(), app.try_state::<crate::extensions::runtime_grants::RuntimeGrants>()) else { return Err(Refusal::new("UnsupportedCapability", "$")) };
    let _ = grants.sync(snapshot);
    let action = removal_action(if request.family == Family::Bots { "bots" } else { "channels" }).ok_or_else(|| shape("family"))?;
    match consents.delete(&grants, owner, action, None, what).map_err(|code| Refusal::new(if code == "UnsupportedCapability" { "UnsupportedCapability" } else { "PermissionDenied" }, PERMISSION))? {
        crate::extensions::runtime_family_consents::Delete::Proceed => Ok(()),
        crate::extensions::runtime_family_consents::Delete::Confirm { ticket, what } => {
            // A host with no window cannot ask: the user turns the confirmation off for the package, or removes it by hand.
            if crate::headless::active() { return Err(Refusal::new("HostUnavailable", "confirmation")); }
            let Some(store) = automation(app) else { return Err(Refusal::new("UnsupportedCapability", "$")) };
            let receiver = store.begin(&ticket, owner, label, action, &what).map_err(|code| Refusal::new(code, "confirmation"))?;
            let _ = app.emit("extensions-workspace-automation-confirm", json!({"ticket": ticket, "owner": owner, "name": label, "action": action, "what": what}));
            match tokio::time::timeout(CONFIRM_WAIT, receiver).await {
                Ok(Ok(Ok(()))) => Ok(()),
                Ok(Ok(Err(code))) => Err(Refusal::new(if code == "Cancelled" { "Cancelled" } else { "PermissionDenied" }, if code == "Cancelled" { "confirmation" } else { PERMISSION })),
                Ok(Err(_)) => Err(Refusal::new("Revoked", "confirmation")),
                Err(_) => { store.abandon(&ticket); Err(Refusal::new("Timeout", "confirmation")) }
            }
        }
    }
}

/// Serves `workspaceAutomation` `{ family: "bots" | "channels", op: "create" | "update" | "remove", id?, input? }` of the
/// service of `request.owner`.
pub async fn serve(app: tauri::AppHandle, request: crate::extensions::runtime_service_lifetime::DispatchRequest) -> Value {
    use tauri::Manager;
    let owner = request.owner.clone();
    let granted = |app: &tauri::AppHandle| match resolve_package(app, &owner) {
        Ok((version, _, _)) => app.try_state::<crate::extensions::runtime_grants::RuntimeGrants>().is_some_and(|grants| grants.check(&owner, &version, PERMISSION, &crate::extensions::runtime_grants::Target::default()).is_ok()),
        Err(_) => false,
    };
    let (_, label, snapshot) = match resolve_package(&app, &owner) { Ok(found) => found, Err(refusal) => return refusal.envelope() };
    if !granted(&app) { return Refusal::new("PermissionDenied", PERMISSION).envelope(); }
    let parsed = match read_request(&request.params) { Ok(parsed) => parsed, Err(refusal) => return refusal.envelope() };
    let result: Outcome<Value> = async {
        if parsed.op == Op::Remove {
            let id = parsed.id.clone().unwrap_or_default();
            // The thing must exist before anyone is asked about removing it.
            let what = match parsed.family {
                Family::Bots => format!("Delete the bot {} for the extension {label}", current_bot(&app, &id)?["name"].as_str().unwrap_or("")),
                Family::Channels => format!("Delete the channel #{} for the extension {label}", current_channel(&app, &id)?["name"].as_str().unwrap_or("")),
            };
            confirmed(&app, &owner, &label, &parsed, &what, &snapshot).await?;
            // The grant is read again after the wait: a revoke or a disable while the dialog was open removes nothing.
            if !granted(&app) { return Err(Refusal::new("PermissionDenied", PERMISSION)); }
            return match parsed.family { Family::Bots => bot_remove(&app, &id, &owner, &label).await, Family::Channels => channel_remove(&app, &id, &owner, &label).await };
        }
        if !granted(&app) { return Err(Refusal::new("PermissionDenied", PERMISSION)); }
        match parsed.family {
            Family::Bots => bot_effect(&app, &parsed, &owner, &label),
            Family::Channels => channel_effect(&app, &parsed, &owner, &label).await,
        }
    }.await;
    match result { Ok(value) => ok(value), Err(refusal) => refusal.envelope() }
}

/// The main window's answer to a deletion it asked the user about. The authority is checked again natively (it may have
/// been revoked while the dialog was open) and a refusal is `Cancelled`.
#[tauri::command]
pub fn extensions_workspace_automation_confirm_answer(window: tauri::WebviewWindow, app: tauri::AppHandle, ticket: String, accepted: bool) -> Result<(), String> {
    use tauri::Manager;
    if crate::headless::active() || window.label() != "main" { return Err("PermissionDenied".into()); }
    let (Some(consents), Some(grants), Some(store)) = (app.try_state::<crate::extensions::runtime_family_consents::FamilyConsents>(), app.try_state::<crate::extensions::runtime_grants::RuntimeGrants>(), automation(&app)) else { return Err("UnsupportedCapability".into()) };
    if let Some(packages) = app.try_state::<crate::extensions::packages::ExtensionPackages>() {
        if let Ok(packages) = packages.0.lock() { if let Ok(snapshot) = serde_json::to_value(packages.snapshot()) { let _ = grants.sync(&snapshot); } }
    }
    let answer = consents.answer(&grants, &ticket, accepted);
    let delivered = store.resolve(&ticket, answer.clone());
    match (answer, delivered) { (Err(code), _) => Err(code), (Ok(()), true) => Ok(()), (Ok(()), false) => Err("Timeout".into()) }
}
/// The deletions the main window must still ask the user about.
#[tauri::command]
pub fn extensions_workspace_automation_pending(window: tauri::WebviewWindow, app: tauri::AppHandle) -> Result<Value, String> {
    if crate::headless::active() || window.label() != "main" { return Err("PermissionDenied".into()); }
    Ok(automation(&app).map_or_else(|| json!({"schemaVersion": SCHEMA_VERSION, "pending": []}), |store| store.pending()))
}
/// Which package made each bot and channel it created, changed or removed (the window labels them).
#[tauri::command]
pub fn extensions_workspace_automation_origins(app: tauri::AppHandle) -> Result<Value, String> {
    Ok(automation(&app).map_or_else(|| json!({"schemaVersion": SCHEMA_VERSION, "revision": 0, "origins": {}}), |store| store.origins()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bot_form_takes_only_its_characterized_fields_with_their_shapes() {
        assert!(bot_patch(&json!({"name": "Scout", "provider": "claude", "model": "sonnet", "mode": "ask", "heartbeatMinutes": 0, "backupModels": [{"provider": "codex", "model": "gpt"}], "skills": ["review-code"], "mcp": ["files"], "notify": false, "showPlan": true}), true).is_ok());
        for (input, path, code) in [
            (json!({"name": "A", "secret": 1}), "secret", "InvalidShape"), (json!({"name": 5}), "name", "InvalidShape"), (json!({"heartbeatMinutes": "5"}), "heartbeatMinutes", "InvalidShape"),
            (json!({"notify": "yes"}), "notify", "InvalidShape"), (json!({"backupModels": [{"provider": "codex"}]}), "backupModels", "InvalidShape"),
            (json!({"backupModels": (0..5).map(|_| json!({"provider": "a", "model": "b"})).collect::<Vec<_>>()}), "backupModels", "LimitExceeded"), (json!({"skills": ["Not A Slug"]}), "skills", "InvalidShape"),
            (json!({"skills": (0..51).map(|index| format!("s{index}")).collect::<Vec<_>>()}), "skills", "LimitExceeded"), (json!({"soul": "x".repeat(MAX_TEXT_BYTES + 1)}), "soul", "LimitExceeded"),
            (json!([]), "input", "InvalidShape"),
        ] {
            let refusal = bot_patch(&input, false).unwrap_err();
            assert_eq!((refusal.code.as_str(), refusal.path.as_str()), (code, path), "{input}");
        }
        assert_eq!(bot_patch(&json!({"role": "x"}), true).unwrap_err().path, "name");
        assert_eq!(bot_patch(&json!({"name": "  "}), true).unwrap_err().path, "name");
    }

    #[test]
    fn a_bot_update_is_a_patch_over_the_current_bot() {
        let base = json!({"id": "b1", "projectId": "p", "name": "Scout", "role": "r", "provider": "claude", "model": "sonnet", "mode": "ask", "heartbeatMinutes": 30, "notify": true, "skills": ["a"], "createdAt": 1});
        let merged = bot_merge(&base, &bot_patch(&json!({"role": "new", "heartbeatMinutes": 0}), false).unwrap());
        assert_eq!((merged["name"].clone(), merged["role"].clone(), merged["heartbeatMinutes"].clone(), merged["model"].clone()), (json!("Scout"), json!("new"), json!(0), json!("sonnet")));
        // Only the form's fields travel: ids and timestamps are never part of it.
        assert!(!merged.contains_key("id") && !merged.contains_key("projectId") && !merged.contains_key("createdAt"));
        assert_eq!(strings(&merged, "skills"), Some(vec!["a".to_owned()]));
    }

    #[test]
    fn a_channel_form_takes_a_name_members_and_a_lead_and_a_lead_who_left_falls_back() {
        assert!(channel_patch(&json!({"name": "launch", "memberIds": ["a", "b"], "leadBotId": "b"}), true).is_ok());
        for (input, path, code) in [
            (json!({"name": "x", "memberIds": ["a", "a"]}), "memberIds", "InvalidShape"), (json!({"name": "x", "memberIds": "a"}), "memberIds", "InvalidShape"),
            (json!({"name": "x", "memberIds": (0..65).map(|index| format!("b{index}")).collect::<Vec<_>>()}), "memberIds", "LimitExceeded"),
            (json!({"name": "x", "memberIds": [], "channel": 1}), "channel", "InvalidShape"), (json!({"name": "x", "memberIds": [], "leadBotId": 3}), "leadBotId", "InvalidShape"),
        ] {
            let refusal = channel_patch(&input, true).unwrap_err();
            assert_eq!((refusal.code.as_str(), refusal.path.as_str()), (code, path), "{input}");
        }
        assert_eq!(channel_patch(&json!({"name": "x"}), true).unwrap_err().path, "memberIds");
        let base = json!({"id": "c1", "name": "launch", "memberIds": ["a", "b"], "leadBotId": "b", "archived": false});
        assert_eq!(channel_merge(&base, &channel_patch(&json!({"name": "ship"}), false).unwrap())["leadBotId"], "b");
        assert_eq!(channel_merge(&base, &channel_patch(&json!({"memberIds": ["a", "c"]}), false).unwrap())["leadBotId"], Value::Null);
        assert_eq!(channel_merge(&base, &channel_patch(&json!({"memberIds": ["a", "c"], "leadBotId": "c"}), false).unwrap())["leadBotId"], "c");
    }

    #[test]
    fn a_request_names_a_family_a_call_and_only_what_that_call_takes() {
        let read = |value: Value| read_request(&value);
        assert_eq!(read(json!({"family": "bots", "op": "create", "input": {"name": "A"}})).unwrap().id, None);
        assert_eq!(read(json!({"family": "channels", "op": "remove", "id": "c1"})).unwrap().id.as_deref(), Some("c1"));
        for (value, path) in [
            (json!({"family": "bots", "op": "create", "id": "b1", "input": {"name": "A"}}), "id"), (json!({"family": "bots", "op": "update", "input": {}}), "botId"),
            (json!({"family": "channels", "op": "remove"}), "channelId"), (json!({"family": "bots", "op": "remove", "id": "b1", "input": {"name": "A"}}), "input"),
            (json!({"family": "recipes", "op": "create"}), "family"), (json!({"family": "bots", "op": "archive", "id": "b"}), "op"), (json!({"family": "bots", "op": "remove", "id": "b", "confirmed": true}), "confirmed"),
        ] { assert_eq!(read(value.clone()).unwrap_err().path, path, "{value}"); }
    }

    #[test]
    fn the_interfaces_own_messages_become_the_frozen_refusals() {
        for (message, code, path) in [
            ("This bot no longer exists.", "NotFound", "$"), ("This channel is deleted. Restore it to change it.", "StaleContext", "$"), ("Give the bot a name.", "InvalidShape", "name"), ("The database is busy.", "HostUnavailable", "$"),
            ("Choose a permission mode for the bot.", "InvalidShape", "mode"), ("Choose a harness and model for the bot.", "InvalidShape", "provider"),
            ("Use a channel name up to 48 characters.", "InvalidShape", "name"), ("Choose a lead from the channel members.", "InvalidShape", "leadBotId"),
            ("Check-ins run at most once a week and at least every minute.", "InvalidShape", "heartbeatMinutes"),
        ] { let refusal = refusal_of(message); assert_eq!((refusal.code.as_str(), refusal.path.as_str()), (code, path), "{message}"); }
    }

    #[test]
    fn only_the_two_removals_are_irreversible_and_every_other_family_has_no_action_here() {
        assert_eq!((removal_action("bots"), removal_action("channels"), removal_action("recipes")), (Some("bots.remove"), Some("channels.remove"), None));
    }

    #[test]
    fn the_ledger_keeps_the_newest_origin_per_key_bounded_and_survives_a_restart() {
        let dir = std::env::temp_dir().join(format!("pandacode-workspace-automation-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        {
            let store = Automation::open(&dir);
            store.record("bot:b1", "sample.pkg", "Sample", "created");
            store.record("bot:b1", "other.pkg", "Other", "updated");
            store.record("channel:c1", "sample.pkg", "Sample", "removed");
            assert_eq!(store.revision(), 3);
        }
        let again = Automation::open(&dir);
        let origins = again.origins();
        assert_eq!((origins["origins"]["bot:b1"]["package"].clone(), origins["origins"]["bot:b1"]["action"].clone(), origins["origins"]["channel:c1"]["action"].clone()), (json!("other.pkg"), json!("updated"), json!("removed")));
        assert_eq!(origins["revision"], 3);
        let _ = std::fs::remove_dir_all(&dir);
        let bounded = Automation::default();
        for index in 0..MAX_ORIGINS + 5 { bounded.record(&format!("bot:{index}"), "p", "P", "created"); }
        let rows = bounded.origins();
        assert_eq!(rows["origins"].as_object().unwrap().len(), MAX_ORIGINS);
        assert!(rows["origins"].get("bot:0").is_none() && rows["origins"].get(format!("bot:{}", MAX_ORIGINS + 4)).is_some());
    }

    #[test]
    fn confirmations_wait_in_a_bounded_registry_and_one_answer_reaches_one_call() {
        let store = Automation::default();
        let mut receivers = vec![];
        for index in 0..MAX_CONFIRMATIONS_PER_PACKAGE { receivers.push(store.begin(&format!("t{index}"), "pkg.a", "A", "bots.remove", "Delete").unwrap()); }
        assert_eq!(store.begin("t9", "pkg.a", "A", "bots.remove", "Delete").unwrap_err(), "LimitExceeded");
        for index in 0..MAX_CONFIRMATIONS - MAX_CONFIRMATIONS_PER_PACKAGE { receivers.push(store.begin(&format!("o{index}"), &format!("pkg.{index}"), "O", "channels.remove", "Delete").unwrap()); }
        assert_eq!(store.begin("late", "pkg.z", "Z", "bots.remove", "Delete").unwrap_err(), "LimitExceeded");
        assert_eq!(store.pending()["pending"].as_array().unwrap().len(), MAX_CONFIRMATIONS);
        assert!(store.resolve("t0", Err("Cancelled".into())));
        assert!(!store.resolve("t0", Ok(())), "an answer is delivered once");
        assert_eq!(receivers.remove(0).try_recv().unwrap(), Err("Cancelled".to_owned()));
        store.abandon("t1");
        assert!(!store.resolve("t1", Ok(())), "an abandoned wait receives nothing");
        assert_eq!(store.pending()["pending"].as_array().unwrap().len(), MAX_CONFIRMATIONS - 2);
    }

    #[test]
    fn the_refusal_envelope_names_the_code_and_the_path() {
        assert_eq!(failure_with("PermissionDenied", PERMISSION, &[]), json!({"ok": false, "error": {"schemaVersion": 1, "code": "PermissionDenied", "path": "workspace.manage", "ids": []}}));
        assert_eq!(Refusal::new("Cancelled", "confirmation").envelope()["error"]["code"], "Cancelled");
    }
}
