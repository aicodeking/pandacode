//! Headless bot configuration (docs/headless.md): `pandacode serve --import-bots bots.json`
//! applies one declarative file through the same constructors the Settings UI uses, so a
//! server needs no window to set up bots; `--export-bots` writes the secret-free shape
//! back. Applying is pure (Store in, report out) — only starting the added channels needs
//! the AppHandle, which is the caller's job in the serve process.

use crate::bots::{self, channels, guard, schedule};
use crate::storage::Store;
use serde_json::{json, Value};
use std::path::Path;

/// A channel the import added; preview leaves its not-yet-created ID empty.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AddedChannel {
    pub id: String,
    pub bot: String,
    pub kind: String,
    pub label: String,
}

#[derive(Clone, Copy, PartialEq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Status { Created, Updated, Unchanged, Failed }

#[derive(serde::Serialize)]
pub(crate) struct Change {
    pub kind: String,
    pub name: String,
    pub status: Status,
}

#[derive(serde::Serialize)]
pub(crate) struct BotDiff {
    pub name: String,
    pub status: Status,
    pub changes: Vec<Change>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WebLink {
    pub channel_id: String,
    pub url: String,
}

#[derive(Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Report {
    pub lines: Vec<String>,
    pub added_channels: Vec<AddedChannel>,
    pub failed: usize,
    pub bots: Vec<BotDiff>,
    pub links: Vec<WebLink>,
}

/// The inventory advances in memory in preview too, so repeated entries in one
/// document match earlier planned changes without touching storage or secrets.
#[derive(Default)]
struct Inventory {
    id: String,
    profile: Value,
    skills: Vec<String>,
    mcp: Vec<String>,
    channels: Vec<(String, String)>,
    schedules: Vec<(String, String, String)>,
    rules: Vec<(String, String)>,
}

pub(crate) fn preview(store: &Store, doc: &Value, now: i64) -> Report {
    process(store, Path::new(""), doc, now, true)
}

pub(crate) fn apply(store: &Store, root: &Path, doc: &Value, now: i64) -> Report {
    process(store, root, doc, now, false)
}

fn process(store: &Store, root: &Path, doc: &Value, now: i64, dry_run: bool) -> Report {
    let mut run = Run { root, now, dry_run, inventory: std::collections::HashMap::new(), report: Report::default() };
    let Some(entries) = doc.get("bots").and_then(Value::as_array) else {
        run.report.failed = 1;
        run.report.lines.push("The import file needs a \"bots\" array.".into());
        return run.report;
    };
    for entry in entries {
        let name = entry.get("name").and_then(Value::as_str).unwrap_or("").to_owned();
        let mut diff = BotDiff { name, status: Status::Unchanged, changes: Vec::new(), error: None };
        if let Err(error) = process_bot(store, &mut run, entry, &mut diff) {
            run.inventory.retain(|_, saved: &mut Inventory| !saved.profile.is_null());
            run.report.failed += 1;
            run.report.lines.push(format!("bot \"{}\": {error}", diff.name));
            diff.status = Status::Failed;
            diff.error = Some(error);
        }
        run.report.bots.push(diff);
    }
    run.report
}

fn change(diff: &mut BotDiff, kind: &str, name: &str, status: Status) {
    if diff.status == Status::Unchanged && status != Status::Unchanged { diff.status = Status::Updated; }
    diff.changes.push(Change { kind: kind.into(), name: name.into(), status });
}

/// One import run: the shared inventory a document's entries match against, the report being
/// built, and whether this is a preview. Bundled so the per-bot step does not take eight
/// arguments.
struct Run<'a> {
    root: &'a Path,
    now: i64,
    dry_run: bool,
    inventory: std::collections::HashMap<String, Inventory>,
    report: Report,
}

fn process_bot(store: &Store, run: &mut Run, entry: &Value, diff: &mut BotDiff) -> crate::Result<()> {
    let input: bots::BotInput = serde_json::from_value(entry.clone()).map_err(|error| format!("unreadable bot entry: {error}"))?;
    let input = bots::validate(&input)?;
    let canonical = input.name.clone();
    if !run.inventory.contains_key(&canonical) {
        if let Some(bot) = bots::list(store)?.into_iter().find(|bot| bot.name == canonical) {
            let mut profile = serde_json::to_value(&bot).map_err(|e| e.to_string())?;
            let fields = profile_value(&input);
            profile.as_object_mut().unwrap().retain(|field, _| fields.get(field).is_some());
            run.inventory.insert(canonical.clone(), Inventory {
                id: bot.id.clone(), profile, skills: bot.skills, mcp: bot.mcp,
                channels: channels::list(store, &bot.id)?.into_iter().map(|c| (c.kind, c.label)).collect(),
                schedules: schedule::list(store, &bot.id)?.into_iter().map(|s| (s.title, s.prompt, s.kind)).collect(),
                rules: guard::rules(store, &bot.id)?.into_iter().map(|r| (r.pattern, r.decision)).collect(),
            });
        }
    }
    let existed = run.inventory.contains_key(&canonical);
    let saved = run.inventory.entry(canonical.clone()).or_default();
    let profile = profile_value(&input);
    let status = if !existed { Status::Created } else if saved.profile == profile { Status::Unchanged } else { Status::Updated };
    if !run.dry_run {
        let bot = if existed { bots::update(store, &saved.id, &input)? } else { bots::create(store, &input, run.root)? };
        saved.id = bot.id;
    }
    saved.profile = profile;
    diff.name = canonical.clone();
    diff.status = status;
    change(diff, "profile", &canonical, status);
    run.report.lines.push(format!("\"{canonical}\" {}", if existed { "updated" } else { "imported" }));
    if entry.get("skills").is_some() || entry.get("mcp").is_some() {
        let skills = canonical_capabilities(entry.get("skills"))?;
        let mcp = canonical_capabilities(entry.get("mcp"))?;
        let unchanged = existed && same_list(&skills, &saved.skills) && same_list(&mcp, &saved.mcp);
        if !unchanged {
            if !run.dry_run { bots::set_capabilities(store, &saved.id, &skills, &mcp)?; }
            run.report.lines.push(format!("  capabilities: {} skill(s), {} MCP server(s)", skills.len(), mcp.len()));
        }
        change(diff, "capabilities", &canonical, if unchanged { Status::Unchanged } else if existed { Status::Updated } else { Status::Created });
        saved.skills = skills; saved.mcp = mcp;
    }
    if let Some(entries) = entry.get("channels").and_then(Value::as_array) {
        for entry in entries {
            let mut input: channels::ChannelInput = serde_json::from_value(entry.clone()).map_err(|e| format!("unreadable channel entry: {e}"))?;
            let label = input.label.trim().chars().take(60).collect::<String>();
            let pair = (input.kind.clone(), label.clone());
            if saved.channels.contains(&pair) {
                change(diff, "channel", &format!("{}:{label}", input.kind), Status::Unchanged);
                run.report.lines.push(format!("  channel {} \"{label}\" already configured", input.kind));
                continue;
            }
            for (name, value) in &mut input.secrets {
                *value = resolve_secret(&input.kind, name, value, &|var| std::env::var(var).ok())?;
            }
            channels::check_format(&input)?;
            validate_channel(&input)?;
            let id = if run.dry_run { String::new() } else { channels::add(store, &saved.id, &input)?.id };
            run.report.added_channels.push(AddedChannel { id, bot: canonical.clone(), kind: input.kind.clone(), label: label.clone() });
            change(diff, "channel", &format!("{}:{label}", input.kind), Status::Created);
            run.report.lines.push(format!("  channel {} \"{label}\" added", input.kind));
            saved.channels.push(pair);
        }
    }
    if let Some(entries) = entry.get("schedules").and_then(Value::as_array) {
        for entry in entries {
            let input: schedule::ScheduleInput = serde_json::from_value(entry.clone()).map_err(|e| format!("unreadable schedule entry: {e}"))?;
            let title = input.title.trim().chars().take(120).collect::<String>();
            let prompt = input.prompt.trim().chars().take(8000).collect::<String>();
            let exists = saved.schedules.iter().any(|s| if title.is_empty() { s.1 == prompt && s.2 == input.kind } else { s.0 == title });
            let display = if title.is_empty() { &input.prompt } else { &title };
            if exists {
                change(diff, "schedule", display, Status::Unchanged);
                run.report.lines.push(format!("  schedule \"{display}\" already configured"));
                continue;
            }
            validate_schedule(&input, saved.schedules.len(), run.now)?;
            if !run.dry_run { schedule::create(store, &saved.id, &input, "user", run.now)?; }
            let title = if title.is_empty() { prompt.chars().take(60).collect() } else { title };
            change(diff, "schedule", &title, Status::Created);
            run.report.lines.push(format!("  schedule \"{title}\" added"));
            saved.schedules.push((title, prompt, input.kind));
        }
    }
    if let Some(entries) = entry.get("rules").and_then(Value::as_array) {
        for entry in entries {
            let pattern = entry.get("pattern").and_then(Value::as_str).ok_or("Every rule needs a pattern.")?;
            let decision = entry.get("decision").and_then(Value::as_str).ok_or("Every rule needs a decision (allow, ask or deny).")?;
            let pattern = pattern.trim().chars().take(200).collect::<String>();
            if pattern.trim_matches('*').trim().chars().count() < 2 { return Err("A rule needs a pattern of at least two characters.".into()); }
            if !matches!(decision, "allow" | "ask" | "deny") { return Err("A rule allows, asks or denies.".into()); }
            let replaced = saved.rules.iter().any(|r| r.0 == pattern && r.1 != decision);
            let exists = saved.rules.iter().any(|r| r.0 == pattern && r.1 == decision);
            if !run.dry_run {
                for rule in guard::rules(store, &saved.id)?.iter().filter(|r| r.pattern == pattern && r.decision != decision) {
                    guard::delete_rule(store, &saved.id, &rule.id)?;
                }
                if !exists { guard::add_rule(store, &saved.id, &pattern, decision)?; }
            }
            change(diff, "rule", &pattern, if replaced { Status::Updated } else if exists { Status::Unchanged } else { Status::Created });
            run.report.lines.push(format!("  rule \"{pattern}\" {}", if exists && !replaced { "already configured" } else { decision }));
            saved.rules.retain(|r| r.0 != pattern);
            saved.rules.push((pattern, decision.into()));
        }
    }
    Ok(())
}

fn profile_value(input: &bots::BotInput) -> Value {
    json!({"name":input.name,"role":input.role,"instructions":input.instructions,"goals":input.goals,
        "soul":input.soul,"avatar":input.avatar,"provider":input.provider,"model":input.model,"mode":input.mode,
        "heartbeatMinutes":input.heartbeat_minutes,"color":input.color,"reasoningEffort":input.reasoning_effort,
        "backupModels":input.backup_models,"fallbackMode":input.fallback_mode,"notify":input.notify,
        "whileWorking":input.while_working,"showPlan":input.show_plan})
}

fn required_secrets(kind: &str) -> &'static [&'static str] {
    match kind {
        "telegram" | "discord" => &["token"],
        "slack" => &["token", "app_token"],
        "whatsapp" => &["access_token", "signing_secret"],
        _ => &[],
    }
}

fn validate_channel(input: &channels::ChannelInput) -> crate::Result<()> {
    if !matches!(input.kind.as_str(), "web" | "telegram" | "slack" | "discord" | "whatsapp") {
        return Err("Choose web, Telegram, Slack, Discord or WhatsApp.".into());
    }
    let config = &input.config;
    if input.kind == "whatsapp" && config["phoneNumberId"].as_str().is_none_or(|id| id.trim().is_empty() || !id.chars().all(|c| c.is_ascii_digit())) {
        return Err("Enter the WhatsApp phone number ID from Meta's API setup page.".into());
    }
    for name in required_secrets(&input.kind) {
        if input.secrets.get(*name).is_none_or(|value| value.trim().is_empty()) {
            return Err(format!("Enter the {} for this channel.", name.replace('_', " ")));
        }
    }
    if input.secrets.keys().any(|name| !matches!(name.as_str(), "token" | "app_token" | "signing_secret" | "access_token")) { return Err("Unknown secret name.".into()); }
    Ok(())
}

fn validate_schedule(input: &schedule::ScheduleInput, count: usize, now: i64) -> crate::Result<()> {
    let prompt = input.prompt.trim().chars().take(8000).collect::<String>();
    if prompt.is_empty() {
        return Err("A schedule needs a prompt: what should the bot do?".into());
    }
    if count >= 50 {
        return Err("A bot can have up to 50 schedules.".into());
    }
    let _next = match input.kind.as_str() {
        "once" => input.run_at.filter(|at| *at > now - 60_000 && *at < now + 366 * 86_400_000),
        kind @ ("interval" | "daily" | "weekdays") => schedule::next_run(kind, input.interval_minutes, input.time_of_day.as_deref(), now, schedule::local_offset_ms(now)),
        _ => return Err("Choose once, every N minutes, daily, or weekdays.".into()),
    }
    .ok_or("Check the schedule's time: intervals are 5 minutes to a week, times are HH:MM, one-off runs are within a year.")?;
    Ok(())
}

/// Capabilities as `references()` stores them: strings, trimmed, empties dropped — the
/// same canonical form the unchanged-skip compares against.
fn canonical_capabilities(value: Option<&Value>) -> crate::Result<Vec<String>> {
    Ok(string_list(value)?
        .into_iter()
        .map(|item| item.trim().to_owned())
        .filter(|item| !item.is_empty())
        .collect())
}

fn same_list(doc: &[String], saved: &[String]) -> bool {
    doc.iter().collect::<std::collections::BTreeSet<_>>() == saved.iter().collect::<std::collections::BTreeSet<_>>()
}

/// A secret is either its value or `env:NAME`, read from the environment at import
/// (the lookup is a parameter so tests never touch the process environment).
fn resolve_secret(kind: &str, name: &str, value: &str, lookup: &dyn Fn(&str) -> Option<String>) -> crate::Result<String> {
    let Some(variable) = value.strip_prefix("env:") else {
        return Ok(value.to_owned());
    };
    let resolved = lookup(variable).ok_or_else(|| format!("{kind} channel ({name}): environment variable {variable} is not set"))?;
    if resolved.trim().is_empty() {
        return Err(format!("{kind} channel ({name}): environment variable {variable} is empty"));
    }
    Ok(resolved)
}

fn string_list(value: Option<&Value>) -> crate::Result<Vec<String>> {
    match value {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| item.as_str().map(str::to_owned).ok_or_else(|| "Capability lists hold strings.".to_string()))
            .collect(),
        Some(_) => Err("Capability lists are arrays of strings.".into()),
    }
}

/// The importable shape of everything configured, minus secrets: channels list the
/// secret *names* under `secretsNeeded`, web tokens are left out entirely (a re-import
/// mints a fresh one and prints the new link), and fired once-schedules are omitted
/// (their run time is gone; exporting them would fail `schedule::create` on import).
pub(crate) fn export(store: &Store) -> crate::Result<Value> {
    let mut bots_json = Vec::new();
    for bot in bots::list(store)? {
        let mut channels_json = Vec::new();
        for channel in channels::list(store, &bot.id)? {
            let mut config = channel.config.clone();
            if let Some(object) = config.as_object_mut() {
                object.remove("verifyToken");
            }
            channels_json.push(json!({
                "kind": channel.kind, "label": channel.label, "config": config,
                "secretsNeeded": channel.secrets,
            }));
        }
        let schedules_json = schedule::list(store, &bot.id)?
            .iter()
            // A once-schedule whose run time is gone (fired, or drifted past while
            // disabled) cannot re-import: create rejects a stale or missing runAt.
            .filter(|saved| !(saved.kind == "once" && saved.next_run_at.is_none_or(|at| at <= crate::storage::now())))
            .map(|saved| {
                json!({
                    "title": saved.title, "prompt": saved.prompt, "kind": saved.kind,
                    "intervalMinutes": saved.interval_minutes, "timeOfDay": saved.time_of_day,
                    "runAt": (saved.kind == "once").then_some(saved.next_run_at).flatten(),
                })
            })
            .collect::<Vec<_>>();
        let rules_json = guard::rules(store, &bot.id)?
            .iter()
            .map(|rule| json!({"pattern": rule.pattern, "decision": rule.decision}))
            .collect::<Vec<_>>();
        bots_json.push(json!({
            "name": bot.name, "role": bot.role, "instructions": bot.instructions,
            "goals": bot.goals, "soul": bot.soul, "avatar": bot.avatar,
            "provider": bot.provider, "model": bot.model,
            "mode": bot.mode, "heartbeatMinutes": bot.heartbeat_minutes,
            "skills": bot.skills, "mcp": bot.mcp,
            "channels": channels_json, "schedules": schedules_json, "rules": rules_json,
        }));
    }
    Ok(json!({ "bots": bots_json }))
}

/// Reads and applies the import file inside the serve process, starts the added channels
/// live, prints web chat links. Exits non-zero on any failure, after the per-bot report
/// (systemd shows it); what imported before the failure stays, so fixing the file and
/// restarting converges.
pub(crate) fn run_import(app: &tauri::AppHandle, path: &Path) {
    use tauri::Manager;
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) => {
            eprintln!("Could not read the bot import file {}: {error}", path.display());
            std::process::exit(1)
        }
    };
    let doc: Value = match serde_json::from_str(&text) {
        Ok(doc) => doc,
        Err(error) => {
            eprintln!("The bot import file is not valid JSON: {error}");
            std::process::exit(1)
        }
    };
    let state = app.state::<crate::AppState>();
    let report = {
        let Ok(store) = state.store.lock() else {
            eprintln!("Could not open the task store for the bot import.");
            std::process::exit(1)
        };
        apply(&store, &bots::workspace_root(), &doc, crate::storage::now())
    };
    for line in &report.lines {
        println!("{line}");
    }
    if report.failed > 0 {
        eprintln!("The bot import had errors; fix the file and restart — what imported stays.");
        std::process::exit(1)
    }
    for line in start_added_channels(app, &state, &report.added_channels) {
        println!("Web chat: {}", line.url);
    }
}

fn start_added_channels(app: &tauri::AppHandle, state: &crate::AppState, added_channels: &[AddedChannel]) -> Vec<WebLink> {
    let mut links = Vec::new();
    for added in added_channels {
        let channel = {
            let Ok(store) = state.store.lock() else {
                eprintln!("serve: could not re-read an imported channel; it will start on the next restart.");
                continue;
            };
            match channels::get(&store, &added.id) {
                Ok(channel) => channel,
                Err(error) => {
                    eprintln!("serve: an imported channel did not come back: {error}");
                    continue;
                }
            }
        };
        channels::start(app, channel.clone());
        if channel.kind == "web" {
            let port = channels::http::ensure_server(app.clone());
            if port == 0 {
                eprintln!("serve: the local chat server could not bind a port; web chat links are unavailable.");
                continue;
            }
            let token = {
                let Ok(store) = state.store.lock() else { continue };
                channels::web_token(&store, &channel.id)
            };
            if let Some(token) = token {
                links.push(WebLink { channel_id: channel.id.clone(), url: format!("http://127.0.0.1:{port}/chat/{}#{token}", channel.id) });
            }
        }
    }
    links
}

fn parse_document(doc: &str) -> crate::Result<Value> {
    let value: Value = serde_json::from_str(doc).map_err(|e| format!("The bot import document is not valid JSON: {e}"))?;
    if !value.is_object() { return Err("The bot import document must be a JSON object.".into()); }
    Ok(value)
}

fn guard_main(window: &tauri::WebviewWindow) -> crate::Result<()> {
    if window.label() != "main" { return Err("Bots are managed from the main window.".into()); }
    Ok(())
}

#[tauri::command]
pub(crate) async fn bots_import_preview(window: tauri::WebviewWindow, state: tauri::State<'_, crate::AppState>, doc: String) -> crate::Result<Report> {
    guard_main(&window)?;
    let doc = parse_document(&doc)?;
    let store = state.store.lock().map_err(|e| e.to_string())?;
    Ok(preview(&store, &doc, crate::storage::now()))
}

#[tauri::command]
pub(crate) async fn bots_import(app: tauri::AppHandle, window: tauri::WebviewWindow, state: tauri::State<'_, crate::AppState>, doc: String) -> crate::Result<Report> {
    use tauri::Emitter;
    guard_main(&window)?;
    let doc = parse_document(&doc)?;
    let mut report = {
        let store = state.store.lock().map_err(|e| e.to_string())?;
        apply(&store, &bots::workspace_root(), &doc, crate::storage::now())
    };
    report.links = start_added_channels(&app, &state, &report.added_channels);
    let _ = app.emit("bots-changed", ());
    Ok(report)
}

#[tauri::command]
pub(crate) async fn bots_export(state: tauri::State<'_, crate::AppState>) -> crate::Result<Value> {
    let store = state.store.lock().map_err(|e| e.to_string())?;
    export(&store)
}

/// Writes the export document to `path` (pretty-printed, newline-terminated).
pub(crate) fn run_export(app: &tauri::AppHandle, path: &Path) -> crate::Result<()> {
    use tauri::Manager;
    let state = app.state::<crate::AppState>();
    let doc = {
        let store = state.store.lock().map_err(|e| e.to_string())?;
        export(&store)?
    };
    let text = serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?;
    std::fs::write(path, text + "\n").map_err(|e| format!("Could not write {}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secret_store;

    fn store() -> Store {
        Store::open(Path::new(":memory:")).unwrap()
    }

    fn root() -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("pandacode-bot-import-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    /// A per-test variable name that is never set: reading a missing variable is safe
    /// in parallel tests; writing the environment is not.
    fn token_doc(var: &str) -> Value {
        serde_json::from_str(&format!(
            r#"{{"bots": [{{
                "name": "build-bot", "role": "builder", "instructions": "Build things.",
                "goals": "Ship it", "provider": "claude", "model": "sonnet", "mode": "auto",
                "avatar": "panda:3",
                "heartbeatMinutes": 30, "skills": ["skill-a"], "mcp": ["server-a"],
                "channels": [
                    {{"kind": "telegram", "label": "main", "config": {{}}, "secrets": {{"token": "{var}"}}}},
                    {{"kind": "web"}}
                ],
                "schedules": [{{"title": "Standup", "prompt": "What is next?", "kind": "daily", "timeOfDay": "09:00"}}],
                "rules": [{{"pattern": "npm test*", "decision": "allow"}}]
            }}]}}"#
        ))
        .unwrap()
    }

    #[test]
    fn preview_writes_nothing_and_import_matches_its_plan() {
        let store = store();
        let root = root();
        let doc = token_doc("123456:AAtesttokenvalueaaaaaaaaaaaaaaaaa");
        let before = store.db.total_changes();
        let first = preview(&store, &doc, 1_000_000);
        let repeated = preview(&store, &doc, 1_000_000);
        assert_eq!(first.failed, 0, "{:?}", first.lines);
        assert!(first.bots[0].status == Status::Created);
        assert_eq!(serde_json::to_value(&first).unwrap(), serde_json::to_value(&repeated).unwrap());
        assert_eq!(store.db.total_changes(), before, "preview executes no database writes");
        assert!(bots::list(&store).unwrap().is_empty());
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 0);
        assert_eq!(first.added_channels.len(), 2);
        assert!(first.added_channels.iter().all(|channel| channel.id.is_empty()));
        let applied = apply(&store, &root, &doc, 1_000_000);
        assert_eq!(applied.failed, 0, "{:?}", applied.lines);
        assert_eq!(serde_json::to_value(&first.bots).unwrap(), serde_json::to_value(&applied.bots).unwrap());
        assert_eq!(applied.added_channels.len(), first.added_channels.len());
        assert!(applied.added_channels.iter().all(|channel| !channel.id.is_empty()));
        let bot = bots::list(&store).unwrap().remove(0);
        assert_eq!(channels::list(&store, &bot.id).unwrap().len(), 2);
        assert_eq!(schedule::list(&store, &bot.id).unwrap().len(), 1);
        assert_eq!(guard::rules(&store, &bot.id).unwrap().len(), 1);
        let second = preview(&store, &doc, 1_000_000);
        assert_eq!(second.failed, 0, "{:?}", second.lines);
        assert!(second.bots[0].status == Status::Unchanged);
        assert!(second.bots[0].changes.iter().all(|change| change.status == Status::Unchanged));
        assert!(second.added_channels.is_empty());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn preview_reports_malformed_documents_without_panicking() {
        let store = store();
        for doc in [json!(null), json!({"bots": "bad"}), json!({"bots": [{"name":42}]}),
            json!({"bots":[{"name":"bad", "provider":"nope", "mode":"auto"}]})] {
            assert_eq!(preview(&store, &doc, 1_000_000).failed, 1);
        }
        assert!(bots::list(&store).unwrap().is_empty());
        assert!(parse_document("[]").unwrap_err().contains("JSON object"));
        assert!(parse_document("{").is_err());
    }

    #[test]
    fn preview_tracks_duplicate_entries_and_changed_rules() {
        let store = store();
        let root = root();
        let entry = json!({"name":"  bot  ","provider":"claude","model":"sonnet","mode":"auto",
            "channels":[{"kind":"web"},{"kind":"web"}],
            "schedules":[{"title":"daily","prompt":"hi","kind":"daily","timeOfDay":"09:00"}],
            "rules":[{"pattern":"npm test*","decision":"allow"}]});
        let doc = json!({"bots":[entry.clone(),entry]});
        let planned = preview(&store, &doc, 1_000_000);
        assert_eq!(planned.failed, 0);
        assert!(planned.bots[0].status == Status::Created);
        assert!(planned.bots[1].status == Status::Unchanged);
        assert_eq!(planned.added_channels.len(), 1);
        let applied = apply(&store, &root, &doc, 1_000_000);
        assert_eq!(applied.failed, 0);
        let mut changed = doc.clone();
        changed["bots"][0]["role"] = json!("changed");
        changed["bots"][0]["rules"][0]["decision"] = json!("deny");
        let planned = preview(&store, &changed, 1_000_000);
        assert!(planned.bots[0].status == Status::Updated);
        assert!(planned.bots[0].changes.iter().any(|c| c.kind == "rule" && c.status == Status::Updated));
        assert_eq!(guard::rules(&store, &bots::list(&store).unwrap()[0].id).unwrap()[0].decision, "allow");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn import_creates_bot_channel_secrets_schedule_and_rule() {
        let store = store();
        let root = root();
        let report = apply(&store, &root, &token_doc("123456:AAtesttokenvalueaaaaaaaaaaaaaaaaa"), 1_000_000);
        assert_eq!(report.failed, 0, "{:?}", report.lines);
        assert_eq!(report.added_channels.len(), 2);
        let list = bots::list(&store).unwrap();
        assert_eq!(list.len(), 1);
        let bot = &list[0];
        assert_eq!((bot.provider.as_str(), bot.mode.as_str(), bot.heartbeat_minutes), ("claude", "auto", 30));
        assert_eq!(bot.skills, vec!["skill-a".to_owned()]);
        assert_eq!(bot.goals, "Ship it");
        assert_eq!(bot.avatar, "panda:3");
        // The telegram channel saved the token under the file backend's key.
        let channel = channels::list(&store, &bot.id).unwrap().into_iter().find(|c| c.kind == "telegram").unwrap();
        assert_eq!(channel.secrets, vec!["token".to_owned()]);
        assert_eq!(secret_store::get("app.pandacode.bots", &format!("{}:token", channel.id)).as_deref(), Some("123456:AAtesttokenvalueaaaaaaaaaaaaaaaaa"));
        // The web channel minted a link token.
        let web = channels::list(&store, &bot.id).unwrap().into_iter().find(|c| c.kind == "web").unwrap();
        let token = channels::web_token(&store, &web.id).unwrap();
        assert_eq!(token.len(), 64);
        // The schedule got a computed next run and the rule stored its decision.
        let schedules = schedule::list(&store, &bot.id).unwrap();
        assert_eq!(schedules.len(), 1);
        assert!(schedules[0].next_run_at.is_some());
        assert_eq!(schedules[0].created_by, "user");
        assert_eq!(guard::rules(&store, &bot.id).unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn reapplying_the_same_file_converges() {
        let store = store();
        let root = root();
        let doc = token_doc("123456:AAtesttokenvalueaaaaaaaaaaaaaaaaa");
        apply(&store, &root, &doc, 1_000_000);
        let report = apply(&store, &root, &doc, 2_000_000);
        assert_eq!(report.failed, 0, "{:?}", report.lines);
        assert_eq!(report.added_channels.len(), 0, "channels are matched, not re-added");
        let bots = bots::list(&store).unwrap();
        assert_eq!(bots.len(), 1);
        // Unchanged capabilities skip the write: the brief is not re-broadcast.
        assert_eq!(bots[0].memory_version, 1);
        assert_eq!(channels::list(&store, &bots[0].id).unwrap().len(), 2);
        assert_eq!(schedule::list(&store, &bots[0].id).unwrap().len(), 1);
        assert_eq!(guard::rules(&store, &bots[0].id).unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_failing_bot_does_not_block_the_others() {
        let store = store();
        let root = root();
        let doc: Value = serde_json::from_str(
            r#"{"bots": [
                {"name": "good", "provider": "claude", "model": "sonnet", "mode": "auto"},
                {"name": "bad", "provider": "nope", "model": "x", "mode": "auto"}
            ]}"#,
        )
        .unwrap();
        let report = apply(&store, &root, &doc, 1_000_000);
        assert_eq!(report.failed, 1);
        assert!(report.lines.iter().any(|line| line.contains("bad")));
        let bots = bots::list(&store).unwrap();
        assert_eq!(bots.len(), 1);
        assert_eq!(bots[0].name, "good");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn export_is_config_only_and_secret_free() {
        let store = store();
        let root = root();
        apply(&store, &root, &token_doc("123456:AAtesttokenvalueaaaaaaaaaaaaaaaaa"), 1_000_000);
        let exported = export(&store).unwrap();
        let text = serde_json::to_string(&exported).unwrap();
        assert!(!text.contains("AAtesttokenvalue"), "secret values never export");
        assert!(!text.to_lowercase().contains("webtoken"), "web tokens never export");
        let bot = &exported["bots"][0];
        assert_eq!(bot["name"], "build-bot");
        assert_eq!(bot["avatar"], "panda:3", "the avatar round-trips instead of being wiped");
        assert_eq!(bot["channels"][0]["secretsNeeded"], serde_json::json!(["token"]));
        assert_eq!(bot["rules"][0]["decision"], "allow");
        // An export re-imports cleanly on the same server: the profile updates and the
        // existing channels match by kind+label, so no secret is needed again. (On a
        // fresh server the missing secret is the named per-bot error instead.)
        let report = apply(&store, &root, &exported, 3_000_000);
        assert_eq!(report.failed, 0, "{:?}", report.lines);
        assert!(report.lines.iter().any(|line| line.contains("already configured")));
        assert_eq!(bots::list(&store).unwrap().len(), 1);
        assert_eq!(bots::list(&store).unwrap()[0].avatar, "panda:3", "the avatar survives the round trip");
        assert_eq!(channels::list(&store, &bots::list(&store).unwrap()[0].id).unwrap().len(), 2);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn missing_env_and_malformed_entries_report_per_bot() {
        let store = store();
        let root = root();
        let var = format!("TEST_TOKEN_{}", uuid::Uuid::new_v4().simple());
        let doc: Value = serde_json::from_str(&format!(
            r#"{{"bots": [
                {{"name": "tg", "provider": "claude", "model": "sonnet", "mode": "auto",
                 "channels": [{{"kind": "telegram", "secrets": {{"token": "env:{var}"}}}}]}},
                {{"name": 42}}
            ]}}"#
        ))
        .unwrap();
        let report = apply(&store, &root, &doc, 1_000_000);
        assert_eq!(report.failed, 2);
        assert!(report.lines.iter().any(|line| line.contains(&var)));
        assert!(report.lines.iter().any(|line| line.contains("unreadable bot entry")));
        // Not a document: no bots array.
        let report = apply(&store, &root, &serde_json::json!({"nope": true}), 1_000_000);
        assert_eq!(report.failed, 1);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn non_canonical_names_and_truncations_converge() {
        let store = store();
        let root = root();
        // Constructors store the cleaned name; the match must use the same form.
        let doc: Value = serde_json::from_str(
            r#"{"bots": [{"name": "  build-bot ", "provider": "claude", "model": "sonnet", "mode": "auto"}]}"#,
        )
        .unwrap();
        apply(&store, &root, &doc, 1_000_000);
        let report = apply(&store, &root, &doc, 2_000_000);
        assert_eq!(report.failed, 0, "{:?}", report.lines);
        assert!(report.lines.iter().any(|line| line.contains("updated")), "{:?}", report.lines);
        assert_eq!(bots::list(&store).unwrap().len(), 1);
        // A >60-char name is capped by the constructor and must still converge.
        let long: Value = serde_json::from_str(&format!(
            r#"{{"bots": [{{"name": "{}", "provider": "claude", "model": "sonnet", "mode": "auto"}}]}}"#,
            "x".repeat(80)
        ))
        .unwrap();
        apply(&store, &root, &long, 3_000_000);
        let report = apply(&store, &root, &long, 4_000_000);
        assert_eq!(report.failed, 0);
        assert_eq!(bots::list(&store).unwrap().len(), 2, "the long-named bot updates instead of duplicating");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn rule_decision_edits_replace_instead_of_stack() {
        let store = store();
        let root = root();
        let v1: Value = serde_json::from_str(
            r#"{"bots": [{"name": "bot", "provider": "claude", "model": "sonnet", "mode": "auto",
                "rules": [{"pattern": "npm test*", "decision": "deny"}]}]}"#,
        )
        .unwrap();
        let v2: Value = serde_json::from_str(
            r#"{"bots": [{"name": "bot", "provider": "claude", "model": "sonnet", "mode": "auto",
                "rules": [{"pattern": "npm test*", "decision": "allow"}]}]}"#,
        )
        .unwrap();
        let bot = || bots::list(&store).unwrap().remove(0);
        apply(&store, &root, &v1, 1_000_000);
        let report = apply(&store, &root, &v2, 2_000_000);
        assert_eq!(report.failed, 0, "{:?}", report.lines);
        let rules = guard::rules(&store, &bot().id).unwrap();
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].decision, "allow", "the edited decision must take effect");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn stale_once_schedules_do_not_export() {
        let store = store();
        let root = root();
        // Three once-schedules: "Deploy check" stays pending (exports); "Fired" gets its
        // run time cleared by advance (next_run_at NULL); "Old" drifts into the past
        // while disabled. The two stale ones cannot re-import and must not export.
        // Real clock throughout: export filters stale runAt against it.
        let now = crate::storage::now();
        let future = now + 30 * 86400 * 1000;
        let doc: Value = serde_json::from_str(&format!(
            r#"{{"bots": [{{"name": "bot", "provider": "claude", "model": "sonnet", "mode": "auto",
                "schedules": [
                    {{"title": "Deploy check", "prompt": "go", "kind": "once", "runAt": {future}}},
                    {{"title": "Fired", "prompt": "done", "kind": "once", "runAt": {future}}},
                    {{"title": "Old", "prompt": "gone", "kind": "once", "runAt": {future}}}
                ]}}]}}"#
        ))
        .unwrap();
        apply(&store, &root, &doc, now);
        let bot = bots::list(&store).unwrap().remove(0);
        store.db.execute("UPDATE bot_schedules SET next_run_at=NULL,enabled=0 WHERE title='Fired'", []).unwrap();
        store.db.execute("UPDATE bot_schedules SET next_run_at=1000,enabled=0 WHERE title='Old'", []).unwrap();
        let exported = export(&store).unwrap();
        let schedules = exported["bots"][0]["schedules"].as_array().unwrap();
        assert_eq!(schedules.len(), 1, "{schedules:?}");
        assert_eq!(schedules[0]["title"], "Deploy check");
        // Re-importing the export converges (the stale rows stay history, not config).
        let report = apply(&store, &root, &exported, 2_000_000);
        assert_eq!(report.failed, 0, "{:?}", report.lines);
        assert_eq!(schedule::list(&store, &bot.id).unwrap().len(), 3);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_typoed_decision_does_not_destroy_the_stored_rule() {
        let store = store();
        let root = root();
        let good: Value = serde_json::from_str(
            r#"{"bots": [{"name": "bot", "provider": "claude", "model": "sonnet", "mode": "auto",
                "rules": [{"pattern": "npm test*", "decision": "allow"}]}]}"#,
        )
        .unwrap();
        let typo: Value = serde_json::from_str(
            r#"{"bots": [{"name": "bot", "provider": "claude", "model": "sonnet", "mode": "auto",
                "rules": [{"pattern": "npm test*", "decision": "alow"}]}]}"#,
        )
        .unwrap();
        apply(&store, &root, &good, 1_000_000);
        let report = apply(&store, &root, &typo, 2_000_000);
        assert_eq!(report.failed, 1);
        let rules = guard::rules(&store, &bots::list(&store).unwrap().remove(0).id).unwrap();
        assert_eq!(rules.len(), 1, "the invalid file must not delete the working rule");
        assert_eq!(rules[0].decision, "allow");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn bad_token_shapes_fail_the_import() {
        let store = store();
        let root = root();
        // Slack's two tokens pasted in the wrong boxes: exactly what check_format exists to catch.
        let bad: Value = serde_json::from_str(
            r#"{"bots": [{"name": "bot", "provider": "claude", "model": "sonnet", "mode": "auto",
                "channels": [{"kind": "slack", "secrets": {"token": "xapp-notabottoken0123456789", "app_token": "xoxb-notanapptoken0123456789"}}]}]}"#,
        )
        .unwrap();
        let report = apply(&store, &root, &bad, 1_000_000);
        assert_eq!(report.failed, 1, "{:?}", report.lines);
        assert!(report.lines.iter().any(|line| line.to_lowercase().contains("swap")), "{:?}", report.lines);
        // The bot itself was created before its channel failed: fixing the file and
        // re-applying converges (update the profile, add the channel).
        let good: Value = serde_json::from_str(
            r#"{"bots": [{"name": "bot", "provider": "claude", "model": "sonnet", "mode": "auto",
                "channels": [{"kind": "slack", "label": "main", "secrets": {"token": "xoxb-realbottokenvalue012345678", "app_token": "xapp-realtokenvalue0123456789"}}]}]}"#,
        )
        .unwrap();
        let report = apply(&store, &root, &good, 2_000_000);
        assert_eq!(report.failed, 0, "{:?}", report.lines);
        let bot = bots::list(&store).unwrap().remove(0);
        assert_eq!(channels::list(&store, &bot.id).unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn secrets_resolve_from_the_environment_or_pass_through() {
        let lookup = |name: &str| Some(format!("value-for-{name}"));
        assert_eq!(resolve_secret("telegram", "token", "plain", &lookup).unwrap(), "plain");
        assert_eq!(resolve_secret("telegram", "token", "env:TOKEN", &lookup).unwrap(), "value-for-TOKEN");
        assert!(resolve_secret("telegram", "token", "env:MISSING", &|_| None).unwrap_err().contains("MISSING"));
        assert!(resolve_secret("telegram", "token", "env:EMPTY", &|_| Some("  ".into())).unwrap_err().contains("EMPTY"));
    }
}
