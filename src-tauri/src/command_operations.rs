//! Typed, bounded Codex control operations. Never forwards arbitrary RPC or config.
//! Project/task authorization belongs to the native caller; remote credentials,
//! import bodies and hook commands never cross into the webview.
use crate::integrations::ControlClient;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{HashSet, VecDeque},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

const MAX_ITEMS: usize = 200;
const MAX_IMPORTS: usize = 80;
const MAX_IMPORT_BYTES: usize = 1024 * 1024;
const MAX_PAGES: usize = 4;

#[derive(Debug, Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
pub enum Request {
    Usage,
    Hooks,
    Preferences,
    SetPreference {
        id: String,
        value: Value,
    },
    Imports {
        #[serde(default, rename = "includeHome")]
        include_home: bool,
    },
    ImportSelected {
        ids: Vec<String>,
        #[serde(default, rename = "includeHome")]
        include_home: bool,
    },
    Conversations {
        cursor: Option<String>,
        search: Option<String>,
    },
    Plugins,
    Logout,
}

trait Transport {
    async fn request(&mut self, method: &str, params: Value) -> Result<Value, String>;
}
impl Transport for ControlClient {
    async fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        ControlClient::request(self, method, params).await
    }
}

pub async fn execute(cwd: &Path, request: Request) -> Result<Value, String> {
    validate_request(&request)?;
    let cwd = &codex_path(cwd);
    let mut client = ControlClient::start(cwd).await?;
    let result = execute_with(&mut client, cwd, request).await;
    client.finish().await;
    result
}

/// Reads persisted goals without loading a thread or starting its continuation.
pub async fn read_goal(
    cwd: &Path,
    thread_id: &str,
) -> Result<Option<crate::goal_state::GoalState>, String> {
    remote_id(&json!(thread_id))?;
    let mut client = ControlClient::start_with_goals(cwd).await?;
    let result = client
        .request("thread/goal/get", json!({"threadId":thread_id}))
        .await;
    client.finish().await;
    parse_goal(&result?, thread_id)
}
fn parse_goal(
    result: &Value,
    thread_id: &str,
) -> Result<Option<crate::goal_state::GoalState>, String> {
    if result.get("goal") == Some(&Value::Null) {
        return Ok(None);
    }
    let goal: crate::goal_state::GoalState = serde_json::from_value(result["goal"].clone())
        .map_err(|_| "Codex returned an invalid goal.")?;
    if !goal.is_valid() || goal.thread_id != thread_id {
        return Err("Codex returned a goal for a different task.".into());
    }
    Ok(Some(goal))
}

fn validate_request(request: &Request) -> Result<(), String> {
    match request {
        Request::SetPreference { id, value } => {
            if id == "personality" {
                if !matches!(value.as_str(), Some("none" | "friendly" | "pragmatic")) {
                    return Err("Choose a supported Codex personality.".into());
                }
            } else if let Some(feature) = id.strip_prefix("feature:") {
                if !valid_key(feature) || !value.is_boolean() {
                    return Err("Choose a discovered Codex feature and a toggle value.".into());
                }
            } else {
                return Err("This Codex setting cannot be changed here.".into());
            }
        }
        Request::ImportSelected { ids, .. } => {
            if ids.is_empty()
                || ids.len() > MAX_IMPORTS
                || ids.iter().any(|id| uuid::Uuid::parse_str(id).is_err())
                || ids.iter().collect::<HashSet<_>>().len() != ids.len()
            {
                return Err("Select one or more items from the current import preview.".into());
            }
        }
        Request::Conversations { cursor, search }
            if cursor
                .as_ref()
                .is_some_and(|s| s.len() > 4096 || s.chars().any(char::is_control))
                || search
                    .as_ref()
                    .is_some_and(|s| s.len() > 256 || s.chars().any(char::is_control)) =>
        {
            return Err("The conversation search is too long.".into());
        }
        _ => {}
    }
    Ok(())
}

async fn execute_with(
    client: &mut impl Transport,
    cwd: &Path,
    request: Request,
) -> Result<Value, String> {
    match request {
        Request::Usage => usage(client).await,
        Request::Hooks => {
            let result = client.request("hooks/list", json!({"cwds":[cwd]})).await?;
            hooks(&result)
        }
        Request::Preferences => preferences(client, cwd).await,
        Request::SetPreference { id, value } => {
            let key = if id == "personality" {
                "personality".to_owned()
            } else {
                let feature = id.strip_prefix("feature:").ok_or("Unknown setting")?;
                let features = feature_inventory(client).await?;
                if !features
                    .iter()
                    .any(|item| item["name"].as_str() == Some(feature) && editable_feature(item))
                {
                    return Err("This feature is no longer available. Refresh settings.".into());
                }
                format!("features.{feature}")
            };
            let response = client
                .request(
                    "config/value/write",
                    json!({"keyPath":key,"value":value,"mergeStrategy":"replace"}),
                )
                .await?;
            let status = clean(&response["status"], 64);
            let description = if status == "okOverridden" {
                "Saved as the user default. This project or managed configuration overrides that preference."
            } else {
                "Used when the next Codex task starts or resumes."
            };
            Ok(
                json!({"kind":"result","title":"Codex preference saved","description":description,"status":status}),
            )
        }
        Request::Imports { include_home } => {
            let response = detect_imports(client, cwd, include_home).await?;
            import_preview(cwd, include_home, response)
        }
        Request::ImportSelected { ids, include_home } => {
            let selected = selected_imports(cwd, include_home, &ids)?;
            // Detection is repeated before mutation: paths and complete native
            // descriptors must still match the concrete preview the user selected.
            let detected = detect_imports(client, cwd, include_home).await?;
            let available = array(&detected, "items")?;
            if selected.iter().any(|item| !available.contains(item)) {
                return Err(
                    "The source setup changed. Refresh the import preview before importing.".into(),
                );
            }
            let result = client.request("externalAgentConfig/import", json!({"migrationItems":selected,"source":"pandacode","providerId":"pandacode","migrationSource":"claude"})).await?;
            // Invalidate these selections after success; stale clicks cannot import twice.
            remove_imports(cwd, include_home, &ids);
            Ok(
                json!({"kind":"result","title":"Imported into Codex","description":"Refresh commands to load the imported setup.","importId":clean(&result["importId"],160)}),
            )
        }
        Request::Conversations { cursor, search } => {
            let result = client.request("thread/list", json!({"cwd":cwd,"cursor":cursor,"searchTerm":search,"limit":50,"sortKey":"updated_at","sortDirection":"desc","useStateDbOnly":true})).await?;
            conversations(&result, cwd)
        }
        Request::Plugins => {
            let result = client
                .request("plugin/installed", json!({"cwds":[cwd]}))
                .await?;
            plugins(&result)
        }
        Request::Logout => {
            client.request("account/logout", Value::Null).await?;
            crate::agent_usage::invalidate("codex");
            Ok(
                json!({"kind":"result","title":"Signed out of Codex","description":"Sign in using Codex before starting another task."}),
            )
        }
    }
}

async fn usage(client: &mut impl Transport) -> Result<Value, String> {
    let mut notes = Vec::new();
    let account = match client
        .request("account/read", json!({"refreshToken":false}))
        .await
    {
        Ok(value) => value,
        Err(error) => {
            notes.push(error);
            Value::Null
        }
    };
    let rate_limits = match client.request("account/rateLimits/read", json!({})).await {
        Ok(value) => value,
        Err(error) => {
            notes.push(error);
            Value::Null
        }
    };
    let tokens = match client.request("account/usage/read", json!({})).await {
        Ok(value) => value,
        Err(error) => {
            notes.push(error);
            Value::Null
        }
    };
    if account.is_null() && rate_limits.is_null() && tokens.is_null() {
        return Err(
            "Codex usage is unavailable. Check the installed CLI and its sign-in status.".into(),
        );
    }
    let mut windows = Vec::new();
    if let Some(buckets) = rate_limits["rateLimitsByLimitId"]
        .as_object()
        .filter(|b| !b.is_empty())
    {
        for (id, bucket) in buckets.iter().take(32) {
            add_windows(&mut windows, id, bucket);
        }
    } else if rate_limits["rateLimits"].is_object() {
        add_windows(&mut windows, "codex", &rate_limits["rateLimits"]);
    }
    let mut stats = Vec::new();
    for (key, label) in [
        ("lifetimeTokens", "Lifetime tokens"),
        ("peakDailyTokens", "Peak daily tokens"),
        ("longestRunningTurnSec", "Longest task, seconds"),
        ("currentStreakDays", "Current streak, days"),
    ] {
        if let Some(value) = tokens["summary"][key].as_u64() {
            stats.push(json!({"label":label,"value":value.to_string()}));
        }
    }
    let daily: Vec<_> = tokens["dailyUsageBuckets"]
        .as_array()
        .into_iter()
        .flatten()
        .take(366)
        .filter_map(|bucket| {
            Some(json!({"date":clean(&bucket["startDate"],10),"tokens":bucket["tokens"].as_u64()?}))
        })
        .collect();
    let label = match account["account"]["type"].as_str() {
        Some("chatgpt") => "ChatGPT",
        Some("apiKey") => "API key",
        Some("amazonBedrock") => "Amazon Bedrock",
        _ if account.is_null() => "Account unavailable",
        _ => "Not signed in",
    };
    Ok(
        json!({"kind":"usage","accountLabel":label,"plan":clean(&account["account"]["planType"],64),"windows":windows,"stats":stats,"daily":daily,"notes":notes}),
    )
}

fn add_windows(output: &mut Vec<Value>, id: &str, bucket: &Value) {
    let bucket_name = nonempty(&bucket["limitName"], 128).unwrap_or_else(|| bounded(id, 128));
    for (key, fallback) in [
        ("primary", "Primary window"),
        ("secondary", "Secondary window"),
    ] {
        let window = &bucket[key];
        if !window.is_object() {
            continue;
        }
        let duration = window["windowDurationMins"].as_u64();
        let label = match duration {
            Some(minutes) if minutes % 1440 == 0 => format!("{} days", minutes / 1440),
            Some(minutes) if minutes % 60 == 0 => format!("{} hours", minutes / 60),
            Some(minutes) => format!("{minutes} minutes"),
            None => fallback.into(),
        };
        let used = window["usedPercent"]
            .as_f64()
            .filter(|value| value.is_finite())
            .map(|v| v.clamp(0.0, 100.0));
        output.push(json!({"id":format!("{}:{key}",bounded(id,128)),"label":format!("{bucket_name} · {label}"),"usedPercent":used,"resetsAt":window["resetsAt"].as_i64()}));
    }
}

fn hooks(result: &Value) -> Result<Value, String> {
    let mut items = Vec::new();
    let mut has_warnings = false;
    for group in array(result, "data")?.iter().take(16) {
        has_warnings |= group["warnings"].as_array().is_some_and(|a| !a.is_empty())
            || group["errors"].as_array().is_some_and(|a| !a.is_empty());
        for hook in array(group, "hooks")?
            .iter()
            .take(MAX_ITEMS.saturating_sub(items.len()))
        {
            let title = clean(&hook["eventName"], 64);
            if title.is_empty() {
                continue;
            }
            let handler = clean(&hook["handlerType"], 32);
            let matcher = clean(&hook["matcher"], 128);
            items.push(json!({"id":clean(&hook["key"],160),"title":title,"description":format!("{handler}{}",if matcher.is_empty(){String::new()}else{format!(" · {matcher}")}),"source":clean(&hook["source"],64),"enabled":hook["enabled"].as_bool(),"managed":hook["isManaged"].as_bool(),"trustStatus":clean(&hook["trustStatus"],64)}));
        }
    }
    Ok(
        json!({"kind":"hooks","items":items,"notes":if has_warnings {vec!["Some hooks have configuration warnings. Inspect them in Codex."]}else{vec![]}}),
    )
}

async fn feature_inventory(client: &mut impl Transport) -> Result<Vec<Value>, String> {
    let mut items = Vec::new();
    let mut cursor = Value::Null;
    let mut cursors = HashSet::new();
    for _ in 0..MAX_PAGES {
        let result = client
            .request(
                "experimentalFeature/list",
                json!({"limit":50,"cursor":cursor}),
            )
            .await?;
        items.extend(
            array(&result, "data")?
                .iter()
                .take(MAX_ITEMS - items.len())
                .cloned(),
        );
        let Some(next) = nonempty(&result["nextCursor"], 4096) else {
            break;
        };
        if items.len() == MAX_ITEMS || !cursors.insert(next.clone()) {
            break;
        }
        cursor = Value::String(next);
    }
    Ok(items)
}
fn editable_feature(item: &Value) -> bool {
    item["name"].as_str().is_some_and(valid_key)
        && matches!(item["stage"].as_str(), Some("beta" | "stable"))
        && item["enabled"].is_boolean()
}
async fn preferences(client: &mut impl Transport, cwd: &Path) -> Result<Value, String> {
    let config = client
        .request("config/read", json!({"cwd":cwd,"includeLayers":false}))
        .await?;
    let personality = config["config"]["personality"]
        .as_str()
        .filter(|v| matches!(*v, "none" | "friendly" | "pragmatic"))
        .unwrap_or("none");
    let mut fields = vec![
        json!({"id":"personality","label":"Personality","description":"Default response style for new and resumed Codex tasks.","type":"select","value":personality,"options":[{"value":"none","label":"Default"},{"value":"friendly","label":"Friendly"},{"value":"pragmatic","label":"Pragmatic"}]}),
    ];
    let mut notes = vec!["Changes apply when the next Codex task starts or resumes.".to_owned()];
    match feature_inventory(client).await {
        Ok(features) => {
            for feature in features.iter().filter(|f| editable_feature(f)) {
                fields.push(json!({"id":format!("feature:{}",clean(&feature["name"],128)),"label":nonempty(&feature["displayName"],160).unwrap_or_else(||clean(&feature["name"],128)),"description":clean(&feature["description"],512),"type":"toggle","value":feature["enabled"].as_bool()}));
            }
        }
        Err(error) => notes.push(error),
    }
    Ok(json!({"kind":"preferences","fields":fields,"notes":notes}))
}

#[derive(Clone)]
struct ImportPreview {
    cwd: PathBuf,
    include_home: bool,
    created: Instant,
    items: Vec<(String, Value)>,
}
fn import_cache() -> &'static Mutex<VecDeque<ImportPreview>> {
    static CACHE: OnceLock<Mutex<VecDeque<ImportPreview>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(VecDeque::new()))
}
async fn detect_imports(
    client: &mut impl Transport,
    cwd: &Path,
    include_home: bool,
) -> Result<Value, String> {
    client.request("externalAgentConfig/detect",json!({"cwds":[cwd],"includeHome":include_home,"maxSessionAgeDays":30,"maxSessions":50,"migrationSource":"claude"})).await
}
fn import_preview(cwd: &Path, include_home: bool, response: Value) -> Result<Value, String> {
    let candidates = array(&response, "items")?;
    let mut native = Vec::new();
    let mut native_bytes = 0;
    let mut items = Vec::new();
    for item in candidates.iter().take(MAX_IMPORTS) {
        let in_scope = match item["cwd"].as_str() {
            None | Some("") => include_home,
            Some(path) => same_cwd(path, cwd),
        };
        if !in_scope {
            continue;
        }
        let bytes = serde_json::to_vec(item)
            .map_err(|_| "Invalid import preview")?
            .len();
        if native_bytes + bytes > MAX_IMPORT_BYTES {
            break;
        }
        native_bytes += bytes;
        let kind = clean(&item["itemType"], 64);
        if !matches!(
            kind.as_str(),
            "AGENTS_MD"
                | "CONFIG"
                | "SKILLS"
                | "PLUGINS"
                | "MCP_SERVER_CONFIG"
                | "SUBAGENTS"
                | "HOOKS"
                | "COMMANDS"
                | "MEMORY"
                | "SESSIONS"
        ) {
            continue;
        }
        let id = uuid::Uuid::new_v4().to_string();
        let scope = if item["cwd"].as_str().is_none_or(|s| s.is_empty()) {
            "Home"
        } else {
            "Project"
        };
        items.push(json!({"id":id,"title":kind.replace('_'," "),"description":clean(&item["description"],512),"source":format!("Claude · {scope}")}));
        native.push((id, item.clone()));
    }
    let mut cache = import_cache()
        .lock()
        .map_err(|_| "Import preview is unavailable")?;
    cache.retain(|entry| {
        entry.created.elapsed() < Duration::from_secs(300)
            && !(entry.cwd == cwd && entry.include_home == include_home)
    });
    while cache.len() >= 8 {
        cache.pop_front();
    }
    cache.push_back(ImportPreview {
        cwd: cwd.into(),
        include_home,
        created: Instant::now(),
        items: native,
    });
    Ok(
        json!({"kind":"imports","items":items,"notes":["Select the exact items to import into Codex. Existing source setup is retained."],"includeHome":include_home}),
    )
}
fn selected_imports(cwd: &Path, include_home: bool, ids: &[String]) -> Result<Vec<Value>, String> {
    let cache = import_cache()
        .lock()
        .map_err(|_| "Import preview is unavailable")?;
    let entry = cache
        .iter()
        .find(|e| {
            e.cwd == cwd
                && e.include_home == include_home
                && e.created.elapsed() < Duration::from_secs(300)
        })
        .ok_or("The import preview expired. Refresh it before importing.")?;
    ids.iter()
        .map(|id| {
            entry
                .items
                .iter()
                .find(|(key, _)| key == id)
                .map(|(_, item)| item.clone())
                .ok_or_else(|| {
                    "The import selection changed. Refresh it before importing.".to_owned()
                })
        })
        .collect()
}
fn remove_imports(cwd: &Path, include_home: bool, ids: &[String]) {
    if let Ok(mut cache) = import_cache().lock() {
        for entry in cache
            .iter_mut()
            .filter(|e| e.cwd == cwd && e.include_home == include_home)
        {
            entry.items.retain(|(id, _)| !ids.contains(id));
        }
    }
}

fn conversations(result: &Value, cwd: &Path) -> Result<Value, String> {
    let items:Vec<_>=array(result,"data")?.iter().take(50).filter(|item|item["cwd"].as_str().is_some_and(|path|same_cwd(path,cwd))).filter_map(|item| {
        let id=remote_id(&item["id"]).ok()?;
        Some(json!({"id":id,"title":nonempty(&item["name"],160).or_else(||nonempty(&item["preview"],160)).unwrap_or_else(||"Untitled task".into()),"description":clean(&item["model"],160),"source":"Codex","updatedAt":item["updatedAt"].as_i64()}))
    }).collect();
    Ok(
        json!({"kind":"conversations","mode":"resume","items":items,"cursor":nonempty(&result["nextCursor"],4096),"notes":[]}),
    )
}
fn plugins(result: &Value) -> Result<Value, String> {
    let mut items = Vec::new();
    for marketplace in array(result, "marketplaces")?.iter().take(32) {
        for plugin in array(marketplace, "plugins")?
            .iter()
            .take(MAX_ITEMS.saturating_sub(items.len()))
        {
            items.push(json!({"id":clean(&plugin["id"],160),"title":nonempty(&plugin["interface"]["displayName"],160).unwrap_or_else(||clean(&plugin["name"],160)),"description":clean(&plugin["interface"]["shortDescription"],512),"source":clean(&marketplace["name"],160),"status":if plugin["installed"]==true {if plugin["enabled"]==true{"Enabled"}else{"Disabled"}}else{"Available"}}));
        }
    }
    Ok(json!({"kind":"plugins","items":items,"notes":[]}))
}

/// Only native task-management code calls these functions with a stored remote ID.
/// No inference starts during a fork; an inherited goal is explicitly deferred.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Fork {
    pub id: String,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
}
pub async fn fork_thread(cwd: &Path, thread_id: &str) -> Result<Fork, String> {
    remote_id(&json!(thread_id))?;
    let cwd = &codex_path(cwd);
    let mut client = ControlClient::start(cwd).await?;
    let result=client.request("thread/fork",json!({"threadId":thread_id,"cwd":cwd,"excludeTurns":true,"deferGoalContinuation":true})).await;
    client.finish().await;
    let response = result?;
    let id = remote_id(&response["thread"]["id"])?;
    Ok(Fork {
        id,
        model: nonempty(&response["model"], 160),
        reasoning_effort: nonempty(&response["reasoningEffort"], 32),
    })
}

pub enum ThreadMutation {
    Archive,
    Rename(String),
}
pub async fn mutate_thread(
    cwd: &Path,
    thread_id: &str,
    mutation: ThreadMutation,
) -> Result<(), String> {
    remote_id(&json!(thread_id))?;
    let (method, params) = match mutation {
        ThreadMutation::Archive => ("thread/archive", json!({"threadId":thread_id})),
        ThreadMutation::Rename(name) => {
            if name.trim().is_empty() || name.len() > 256 || name.chars().any(char::is_control) {
                return Err("Choose a task title of 1–256 characters.".into());
            }
            (
                "thread/name/set",
                json!({"threadId":thread_id,"name":name.trim()}),
            )
        }
    };
    let mut client = ControlClient::start(cwd).await?;
    let result = client.request(method, params).await;
    client.finish().await;
    result.map(|_| ())
}

pub async fn validate_conversation(cwd: &Path, thread_id: &str) -> Result<Fork, String> {
    remote_id(&json!(thread_id))?;
    let mut client = ControlClient::start(cwd).await?;
    let result = client
        .request(
            "thread/read",
            json!({"threadId":thread_id,"includeTurns":false}),
        )
        .await;
    client.finish().await;
    let response = result?;
    let thread = &response["thread"];
    if thread["cwd"]
        .as_str()
        .is_none_or(|path| !same_cwd(path, cwd))
        || remote_id(&thread["id"])? != thread_id
    {
        return Err("This Codex conversation belongs to a different project.".into());
    }
    Ok(Fork {
        id: thread_id.into(),
        model: nonempty(&thread["model"], 160),
        reasoning_effort: nonempty(&thread["reasoningEffort"], 32),
    })
}

/// Codex reports a thread's cwd as the process saw it (`C:\a\b`), while paths
/// PandaCode canonicalized or stored carry the Windows verbatim prefix
/// (`\\?\C:\a\b`). On Windows the same folder must compare equal however it is
/// spelled (verbatim prefix, letter case, `/` separators, a trailing separator);
/// genuinely different folders still fail closed.
fn same_cwd(reported: &str, cwd: &Path) -> bool {
    same_cwd_on(reported, cwd, cfg!(windows))
}

fn same_cwd_on(reported: &str, cwd: &Path, windows: bool) -> bool {
    if !windows {
        return Path::new(reported) == cwd;
    }
    let key = |path: &Path| {
        let plain = ordinary_on(path, true).to_string_lossy().replace('/', "\\");
        // Keep a drive root's separator (`C:\`), drop any other trailing one.
        let trimmed = if plain.len() > 3 { plain.trim_end_matches('\\') } else { plain.as_str() };
        trimmed.to_lowercase()
    };
    !reported.is_empty() && key(Path::new(reported)) == key(cwd)
}

/// The folder as Codex itself names it: Codex filters `thread/list` and import
/// detection by exact cwd, and never records the verbatim prefix.
fn codex_path(path: &Path) -> PathBuf {
    ordinary_on(path, cfg!(windows))
}

/// `path` without a Windows verbatim prefix (`\\?\C:\…`, `\\?\UNC\server\share\…`);
/// malformed verbatim forms and every path off Windows are left unchanged.
fn ordinary_on(path: &Path, windows: bool) -> PathBuf {
    let text = path.to_string_lossy();
    if !windows {
        return path.to_path_buf();
    }
    if let Some(unc) = text.strip_prefix(r"\\?\UNC\") {
        if unc.split('\\').filter(|part| !part.is_empty()).count() >= 2 {
            return PathBuf::from(format!(r"\\{unc}"));
        }
    }
    if let Some(drive) = text.strip_prefix(r"\\?\") {
        if drive.as_bytes().get(1..3) == Some(b":\\") && drive.as_bytes()[0].is_ascii_alphabetic() {
            return PathBuf::from(drive);
        }
    }
    path.to_path_buf()
}

/// Read only the selected project's task transcript. Large histories retain the
/// latest bounded text; native tool payloads, paths and MCP metadata stay private.
pub async fn conversation_messages(
    cwd: &Path,
    thread_id: &str,
) -> Result<Vec<(String, String)>, String> {
    remote_id(&json!(thread_id))?;
    let mut client = ControlClient::start(cwd).await?;
    let result = conversation_messages_with(&mut client, cwd, thread_id).await;
    client.finish().await;
    result
}

async fn conversation_messages_with(
    client: &mut impl Transport,
    cwd: &Path,
    thread_id: &str,
) -> Result<Vec<(String, String)>, String> {
    conversation_messages_with_on(client, cwd, thread_id, cfg!(windows)).await
}

async fn conversation_messages_with_on(
    client: &mut impl Transport,
    cwd: &Path,
    thread_id: &str,
    windows: bool,
) -> Result<Vec<(String, String)>, String> {
    let result = client
        .request(
            "thread/read",
            json!({"threadId":thread_id,"includeTurns":false}),
        )
        .await?;
    let thread = &result["thread"];
    if remote_id(&thread["id"])? != thread_id
        || thread["cwd"]
            .as_str()
            .is_none_or(|value| !same_cwd_on(value, cwd, windows))
    {
        return Err("This Codex conversation belongs to a different project.".into());
    }
    let mut messages = VecDeque::new();
    let mut total = 0;
    let mut entries = Vec::new();
    let mut cursor = Value::Null;
    let mut cursors = HashSet::new();
    let mut truncated = false;
    for page in 0..MAX_PAGES {
        let response = client
            .request(
                "thread/items/list",
                json!({"threadId":thread_id,"cursor":cursor,"limit":100,"sortDirection":"desc"}),
            )
            .await?;
        entries.extend(
            array(&response, "data")?
                .iter()
                .take(100)
                .map(|entry| entry["item"].clone()),
        );
        let Some(next) = nonempty(&response["nextCursor"], 4096) else {
            break;
        };
        if page + 1 == MAX_PAGES || !cursors.insert(next.clone()) {
            truncated = true;
            break;
        }
        cursor = Value::String(next);
    }
    for item in entries.iter().rev() {
        let message = match item["type"].as_str() {
            Some("userMessage") => {
                let text = item["content"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|block| block["type"] == "text")
                    .filter_map(|block| block["text"].as_str())
                    .take(64)
                    .collect::<Vec<_>>()
                    .join("\n");
                Some(("user", text))
            }
            Some("agentMessage") => item["text"].as_str().map(|text| ("assistant", text.into())),
            Some("commandExecution") => Some((
                "tool",
                match item["exitCode"].as_i64() {
                    Some(code) => format!("Command finished · exit {code}"),
                    None => "Command executed".into(),
                },
            )),
            Some("fileChange") => Some(("tool", "Updated project files".into())),
            Some("mcpToolCall" | "dynamicToolCall") => {
                Some(("tool", format!("Tool: {}", clean(&item["tool"], 160))))
            }
            Some("functionCallOutput") => {
                Some(("tool", format!("Tool: {}", clean(&item["name"], 160))))
            }
            _ => None,
        };
        if let Some((role, text)) = message {
            let text: String = text
                .chars()
                .filter(|c| !c.is_control() || matches!(c, '\n' | '\t'))
                .take(32_768)
                .collect();
            if text.trim().is_empty() {
                continue;
            }
            total += text.len();
            messages.push_back((role.to_owned(), text));
            while messages.len() > 400 || total > 1024 * 1024 {
                if let Some((_, old)) = messages.pop_front() {
                    total -= old.len();
                    truncated = true;
                }
            }
        }
    }
    if truncated {
        messages.push_front((
            "tool".into(),
            "Earlier history remains available to Codex when this task resumes.".into(),
        ));
    }
    Ok(messages.into())
}

/// Fast is a catalog capability, never an invented model setting.
pub async fn fast_service_tier(cwd: &Path, model: &str) -> Result<String, String> {
    if model.len() > 200 || model.chars().any(char::is_control) {
        return Err("Invalid Codex model.".into());
    }
    let mut client = ControlClient::start(cwd).await?;
    let result = fast_tier_with(&mut client, model).await;
    client.finish().await;
    result
}

pub async fn resolved_model(cwd: &Path, model: &str) -> Result<String, String> {
    if model.len() > 200 || model.chars().any(char::is_control) {
        return Err("Invalid Codex model.".into());
    }
    let mut client = ControlClient::start(cwd).await?;
    let result = model_metadata(&mut client, model).await;
    client.finish().await;
    let item = result?;
    nonempty(&item["model"], 200).ok_or_else(|| "Codex did not return the model identifier.".into())
}

async fn fast_tier_with(client: &mut impl Transport, model: &str) -> Result<String, String> {
    let item = model_metadata(client, model).await?;
    let tier = item["serviceTiers"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|tier| {
            tier["id"].as_str() == Some("fast")
                || tier["name"]
                    .as_str()
                    .is_some_and(|name| name.eq_ignore_ascii_case("fast"))
        });
    tier.and_then(|tier| tier["id"].as_str())
        .filter(|id| !id.is_empty() && id.len() <= 128 && !id.chars().any(char::is_control))
        .map(str::to_owned)
        .ok_or_else(|| {
            "Fast mode is not available for this model in the installed Codex catalog.".into()
        })
}

async fn model_metadata(client: &mut impl Transport, model: &str) -> Result<Value, String> {
    let mut cursor = Value::Null;
    let mut cursors = HashSet::new();
    for _ in 0..MAX_PAGES {
        let result = client
            .request(
                "model/list",
                json!({"cursor":cursor,"limit":100,"includeHidden":true}),
            )
            .await?;
        for item in array(&result, "data")?.iter().take(100) {
            let matches = if model.is_empty() || model == "default" {
                item["isDefault"] == true
            } else {
                item["id"] == model || item["model"] == model
            };
            if matches {
                return Ok(item.clone());
            }
        }
        let Some(next) = nonempty(&result["nextCursor"], 4096) else {
            break;
        };
        if !cursors.insert(next.clone()) {
            break;
        }
        cursor = Value::String(next);
    }
    Err("The selected model was not found in the current Codex catalog. Refresh models.".into())
}

pub(crate) fn remote_id(value: &Value) -> Result<String, String> {
    let id = value
        .as_str()
        .ok_or("Codex returned an invalid task identifier")?;
    if uuid::Uuid::parse_str(id).is_err() {
        return Err("Codex returned an invalid task identifier".into());
    }
    Ok(id.into())
}
fn array<'a>(value: &'a Value, key: &str) -> Result<&'a Vec<Value>, String> {
    value[key]
        .as_array()
        .ok_or_else(|| "Codex returned an invalid command response.".into())
}
pub(crate) fn clean(value: &Value, limit: usize) -> String {
    bounded(value.as_str().unwrap_or_default(), limit)
}
fn bounded(value: &str, limit: usize) -> String {
    value
        .chars()
        .filter(|c| !c.is_control())
        .take(limit)
        .collect::<String>()
        .trim()
        .to_owned()
}
pub(crate) fn nonempty(value: &Value, limit: usize) -> Option<String> {
    let value = clean(value, limit);
    (!value.is_empty()).then_some(value)
}
fn valid_key(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fake {
        responses: VecDeque<(&'static str, Value)>,
        calls: Vec<(String, Value)>,
    }
    impl Fake {
        fn new(responses: Vec<(&'static str, Value)>) -> Self {
            Self {
                responses: responses.into(),
                calls: Vec::new(),
            }
        }
    }
    impl Transport for Fake {
        async fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
            self.calls.push((method.into(), params));
            let Some((expected, response)) = self.responses.pop_front() else {
                return Err("No fixture".into());
            };
            assert_eq!(method, expected);
            Ok(response)
        }
    }
    #[test]
    fn persisted_goal_read_rejects_foreign_or_malformed_state() {
        let id = uuid::Uuid::new_v4().to_string();
        let result = json!({"goal":{"threadId":id,"objective":"Finish the task","status":"paused","tokenBudget":null,"tokensUsed":12,"timeUsedSeconds":3,"createdAt":1,"updatedAt":2,"secret":"not exposed"}});
        let goal = parse_goal(&result, &id).unwrap().unwrap();
        assert_eq!(goal.tokens_used, 12);
        assert!(!json!(goal).to_string().contains("not exposed"));
        assert!(parse_goal(&result, &uuid::Uuid::new_v4().to_string()).is_err());
        assert!(parse_goal(&json!({}), &id).is_err());
        assert!(parse_goal(&json!({"goal":null}), &id).unwrap().is_none());
    }
    #[test]
    fn import_preview_excludes_unrequested_home_and_foreign_project_scopes() {
        let cwd = PathBuf::from(format!("/import-scope/{}", uuid::Uuid::new_v4()));
        let response = json!({"items":[{"itemType":"SKILLS","description":"Home","cwd":null},{"itemType":"SKILLS","description":"Other","cwd":"/other"},{"itemType":"SKILLS","description":"Current","cwd":cwd}]});
        let view = import_preview(&cwd, false, response).unwrap();
        assert_eq!(view["items"].as_array().unwrap().len(), 1);
        assert_eq!(view["items"][0]["description"], "Current");
    }
    #[tokio::test]
    async fn fast_mode_uses_the_selected_models_actual_catalog_tier() {
        let mut fake = Fake::new(vec![(
            "model/list",
            json!({"data":[{"id":"one","model":"model-one","serviceTiers":[{"id":"priority","name":"Fast"}]},{"id":"two","model":"model-two","serviceTiers":[]}],"nextCursor":null}),
        )]);
        assert_eq!(
            fast_tier_with(&mut fake, "model-one").await.unwrap(),
            "priority"
        );
        let mut fake = Fake::new(vec![(
            "model/list",
            json!({"data":[{"id":"two","model":"model-two","serviceTiers":[]}],"nextCursor":null}),
        )]);
        assert!(fast_tier_with(&mut fake, "model-two").await.is_err());
    }
    #[tokio::test]
    async fn imported_transcript_uses_bounded_pages_in_chronological_order() {
        let id = uuid::Uuid::new_v4().to_string();
        let mut fake = Fake::new(vec![
            (
                "thread/read",
                json!({"thread":{"id":id,"cwd":"/project","path":"SECRET"}}),
            ),
            (
                "thread/items/list",
                json!({"data":[{"item":{"type":"agentMessage","text":"Done\nVerified.","memoryCitation":"SECRET"}},{"item":{"type":"mcpToolCall","tool":"read","arguments":{"token":"SECRET"}}},{"item":{"type":"userMessage","content":[{"type":"text","text":"Build it"},{"type":"skill","path":"SECRET"}]}}],"nextCursor":null}),
            ),
        ]);
        let messages = conversation_messages_with(&mut fake, Path::new("/project"), &id)
            .await
            .unwrap();
        assert_eq!(
            messages,
            vec![
                ("user".into(), "Build it".into()),
                ("tool".into(), "Tool: read".into()),
                ("assistant".into(), "Done\nVerified.".into())
            ]
        );
        assert_eq!(fake.calls[0].1["includeTurns"], false);
        assert_eq!(fake.calls[1].1["limit"], 100);
        assert!(!json!(messages).to_string().contains("SECRET"));
    }
    #[test]
    fn control_boundary_is_closed_and_preference_keys_are_whitelisted() {
        assert!(
            serde_json::from_value::<Request>(json!({"action":"rpc","method":"command/exec"}))
                .is_err()
        );
        // Extra keys on unit variants cannot be retained or forwarded by this
        // typed request, including frontend-supplied remote task identifiers.
        assert!(matches!(
            serde_json::from_value::<Request>(json!({"action":"usage","threadId":"external"}))
                .unwrap(),
            Request::Usage
        ));
        for (id, value) in [
            ("model_provider", json!("malicious")),
            ("feature:mcp.server", json!(true)),
            ("feature:xyz", json!("true")),
            ("personality", json!("invented")),
        ] {
            assert!(validate_request(&Request::SetPreference {
                id: id.into(),
                value
            })
            .is_err());
        }
        assert!(validate_request(&Request::SetPreference {
            id: "feature:multi_agent".into(),
            value: json!(true)
        })
        .is_ok());
    }
    #[tokio::test]
    async fn usage_preserves_unknowns_and_excludes_tokens_and_account_identifiers() {
        let mut fake = Fake::new(vec![
            (
                "account/read",
                json!({"account":{"type":"chatgpt","email":"SECRET","planType":"pro","accessToken":"SECRET"}}),
            ),
            (
                "account/rateLimits/read",
                json!({"accountId":"SECRET","rateLimitsByLimitId":{"codex":{"limitName":"Codex","primary":{"usedPercent":17,"windowDurationMins":300,"resetsAt":null},"secondary":{"usedPercent":null,"windowDurationMins":10080}}},"rateLimits":{"primary":{"usedPercent":99}}}),
            ),
            (
                "account/usage/read",
                json!({"summary":{"lifetimeTokens":1000,"longestRunningTurnSec":null},"dailyUsageBuckets":[{"startDate":"2026-09-15","tokens":30}],"token":"SECRET"}),
            ),
        ]);
        let view = usage(&mut fake).await.unwrap();
        assert!(!view.to_string().contains("SECRET"));
        assert_eq!(view["windows"].as_array().unwrap().len(), 2);
        assert_eq!(view["windows"][0]["usedPercent"], 17.0);
        assert!(view["windows"][1]["usedPercent"].is_null());
        assert!(view["windows"][0]["resetsAt"].is_null());
        assert_eq!(fake.calls[0].1, json!({"refreshToken":false}));
    }
    #[test]
    fn hook_plugin_presentations_do_not_leak_commands_paths_or_credentials() {
        let view=hooks(&json!({"data":[{"cwd":"SECRET","warnings":["SECRET"],"errors":[],"hooks":[{"key":"1","eventName":"preToolUse","handlerType":"command","command":"export TOKEN=SECRET","sourcePath":"SECRET","source":"user","enabled":true,"currentHash":"SECRET","matcher":"Bash"}]}]})).unwrap();
        assert!(!view.to_string().contains("SECRET"));
        assert_eq!(view["items"][0]["description"], "command · Bash");
        let view=plugins(&json!({"marketplaces":[{"name":"Local","path":"SECRET","plugins":[{"id":"plugin-1","name":"Notes","installed":true,"enabled":true,"source":{"token":"SECRET"},"interface":{"shortDescription":"Take notes","logo":"SECRET"}}]}]})).unwrap();
        assert!(!view.to_string().contains("SECRET"));
        assert_eq!(view["items"][0]["status"], "Enabled");
    }
    #[tokio::test]
    async fn writes_only_a_discovered_feature_and_does_not_run_terminal_enablement() {
        let mut fake = Fake::new(vec![
            (
                "experimentalFeature/list",
                json!({"data":[{"name":"multi_agent","stage":"beta","enabled":false}],"nextCursor":null}),
            ),
            (
                "config/value/write",
                json!({"status":"ok","filePath":"SECRET","version":"x"}),
            ),
        ]);
        let view = execute_with(
            &mut fake,
            Path::new("/project"),
            Request::SetPreference {
                id: "feature:multi_agent".into(),
                value: json!(true),
            },
        )
        .await
        .unwrap();
        assert_eq!(
            fake.calls[1].1,
            json!({"keyPath":"features.multi_agent","value":true,"mergeStrategy":"replace"})
        );
        assert!(!view.to_string().contains("SECRET"));
        let mut fake = Fake::new(vec![(
            "experimentalFeature/list",
            json!({"data":[{"name":"removed","stage":"removed","enabled":false}],"nextCursor":null}),
        )]);
        assert!(execute_with(
            &mut fake,
            Path::new("/project"),
            Request::SetPreference {
                id: "feature:removed".into(),
                value: json!(true)
            }
        )
        .await
        .is_err());
        assert_eq!(fake.calls.len(), 1);
    }
    #[tokio::test]
    async fn preference_reader_drops_all_non_presentational_configuration() {
        let mut fake = Fake::new(vec![
            (
                "config/read",
                json!({"config":{"personality":"pragmatic","mcp_servers":{"x":{"env":{"TOKEN":"SECRET"}}},"developer_instructions":"SECRET"},"layers":["SECRET"]}),
            ),
            (
                "experimentalFeature/list",
                json!({"data":[{"name":"supported","stage":"beta","enabled":true,"displayName":"Supported"},{"name":"hidden","stage":"underDevelopment","enabled":true}],"nextCursor":null}),
            ),
        ]);
        let view = preferences(&mut fake, Path::new("/project")).await.unwrap();
        assert!(!view.to_string().contains("SECRET"));
        assert_eq!(view["fields"].as_array().unwrap().len(), 2);
        assert_eq!(view["fields"][0]["value"], "pragmatic");
    }
    #[tokio::test]
    async fn exact_import_selection_revalidates_native_descriptors_and_cannot_be_replayed() {
        let cwd = PathBuf::from(format!("/test/{}", uuid::Uuid::new_v4()));
        let candidate = json!({"itemType":"MCP_SERVER_CONFIG","description":"One configured server","cwd":cwd,"details":{"mcpServers":[{"token":"SECRET"}]}});
        let preview = import_preview(&cwd, false, json!({"items":[candidate.clone()]})).unwrap();
        assert!(!preview.to_string().contains("SECRET"));
        let id = preview["items"][0]["id"].as_str().unwrap().to_owned();
        assert!(selected_imports(Path::new("/other"), false, std::slice::from_ref(&id)).is_err());
        assert!(selected_imports(&cwd, true, std::slice::from_ref(&id)).is_err());
        let mut changed = Fake::new(vec![("externalAgentConfig/detect", json!({"items":[]}))]);
        assert!(execute_with(
            &mut changed,
            &cwd,
            Request::ImportSelected {
                ids: vec![id.clone()],
                include_home: false
            }
        )
        .await
        .is_err());
        assert_eq!(changed.calls.len(), 1);
        let mut fake = Fake::new(vec![
            (
                "externalAgentConfig/detect",
                json!({"items":[candidate.clone()]}),
            ),
            ("externalAgentConfig/import", json!({"importId":"import-1"})),
        ]);
        execute_with(
            &mut fake,
            &cwd,
            Request::ImportSelected {
                ids: vec![id.clone()],
                include_home: false,
            },
        )
        .await
        .unwrap();
        assert_eq!(fake.calls[1].1["migrationItems"], json!([candidate]));
        assert!(selected_imports(&cwd, false, &[id]).is_err());
    }
    #[test]
    fn conversation_inventory_rejects_foreign_projects_and_invalid_ids() {
        let id = uuid::Uuid::new_v4().to_string();
        let response = json!({"data":[{"id":id,"cwd":"/project","name":"Task","path":"SECRET","turns":["SECRET"]},{"id":uuid::Uuid::new_v4(),"cwd":"/other","name":"SECRET"},{"id":"not-an-id","cwd":"/project","name":"SECRET"}],"nextCursor":"next"});
        let view = conversations(&response, Path::new("/project")).unwrap();
        assert_eq!(view["items"].as_array().unwrap().len(), 1);
        assert!(!view.to_string().contains("SECRET"));
        assert_eq!(view["cursor"], "next");
    }
    #[test]
    fn same_cwd_matches_verbatim_and_plain_forms_only_on_windows() {
        assert!(same_cwd_on(r"C:\project", Path::new(r"C:\project"), false));
        assert!(same_cwd_on(r"C:\project", Path::new(r"C:\project"), true));
        assert!(same_cwd("/project", Path::new("/project")));
        // Windows canonicalize returns \\?\ paths; either side may carry the prefix.
        assert!(same_cwd_on(r"C:\project", Path::new(r"\\?\C:\project"), true));
        assert!(same_cwd_on(r"\\?\C:\project", Path::new(r"C:\project"), true));
        assert!(same_cwd_on(
            r"\\server\share\project",
            Path::new(r"\\?\UNC\server\share\project"),
            true
        ));
        assert!(same_cwd_on(
            r"\\?\UNC\server\share\project",
            Path::new(r"\\server\share\project"),
            true
        ));
        // Off Windows the prefix is a literal name and is never stripped.
        assert!(!same_cwd_on(r"\\?\C:\project", Path::new(r"C:\project"), false));
        assert!(!same_cwd_on(r"\\?\home\project", Path::new(r"/home/project"), false));
        // Malformed verbatim forms fall through unchanged and fail closed.
        assert!(!same_cwd_on(r"\\?\UNC\server", Path::new(r"\\server"), true));
        assert!(!same_cwd_on(r"\\?\C:", Path::new(r"C:"), true));
    }
    #[test]
    fn same_cwd_rejects_foreign_folders_empty_and_near_misses() {
        assert!(!same_cwd_on(r"C:\other", Path::new(r"\\?\C:\project"), true));
        assert!(!same_cwd_on(r"/other", Path::new(r"/project"), false));
        assert!(!same_cwd_on("", Path::new(r"\\?\C:\project"), true));
        // Stripping must not turn a prefix of one path into the other path.
        assert!(!same_cwd_on(r"C:\prefix", Path::new(r"\\?\C:\pre"), true));
        assert!(!same_cwd_on(r"\\?\C:\pre", Path::new(r"C:\prefix"), true));
        assert!(!same_cwd("", Path::new("/project")));
        assert!(!same_cwd("/other", Path::new("/project")));
    }
    #[tokio::test]
    async fn imported_transcript_accepts_a_verbatim_windows_cwd_only_on_windows() {
        let id = uuid::Uuid::new_v4().to_string();
        let mut fake = Fake::new(vec![
            (
                "thread/read",
                json!({"thread":{"id":id,"cwd":r"C:\Users\me\project"}}),
            ),
            (
                "thread/items/list",
                json!({"data":[{"item":{"type":"agentMessage","text":"Done"}}],"nextCursor":null}),
            ),
        ]);
        let messages = conversation_messages_with_on(
            &mut fake,
            Path::new(r"\\?\C:\Users\me\project"),
            &id,
            true,
        )
        .await
        .unwrap();
        assert_eq!(messages, vec![("assistant".into(), "Done".into())]);
        let mut off_windows = Fake::new(vec![(
            "thread/read",
            json!({"thread":{"id":id,"cwd":r"C:\Users\me\project"}}),
        )]);
        assert_eq!(
            conversation_messages_with_on(
                &mut off_windows,
                Path::new(r"\\?\C:\Users\me\project"),
                &id,
                false
            )
            .await
            .unwrap_err(),
            "This Codex conversation belongs to a different project."
        );
    }
    #[tokio::test]
    async fn imported_transcript_rejects_foreign_or_missing_project_folders() {
        let id = uuid::Uuid::new_v4().to_string();
        let mut fake = Fake::new(vec![(
            "thread/read",
            json!({"thread":{"id":id,"cwd":"/other"}}),
        )]);
        assert_eq!(
            conversation_messages_with(&mut fake, Path::new("/project"), &id)
                .await
                .unwrap_err(),
            "This Codex conversation belongs to a different project."
        );
        let mut missing = Fake::new(vec![(
            "thread/read",
            json!({"thread":{"id":id}}),
        )]);
        assert_eq!(
            conversation_messages_with(&mut missing, Path::new("/project"), &id)
                .await
                .unwrap_err(),
            "This Codex conversation belongs to a different project."
        );
    }
    #[test]
    fn same_cwd_on_windows_ignores_case_separators_and_trailing_slashes() {
        let cwd = Path::new(r"\\?\C:\Users\me\project");
        for spelling in [r"c:\users\ME\Project", r"C:/Users/me/project", r"C:\Users\me\project\", r"C:/Users/me/project/"] {
            assert!(same_cwd_on(spelling, cwd, true), "{spelling}");
        }
        assert!(same_cwd_on(r"c:\", Path::new(r"\\?\C:\"), true));
        assert!(!same_cwd_on(r"C:\Users\me\project2", cwd, true));
        assert!(!same_cwd_on(r"D:\Users\me\project", cwd, true));
        assert!(!same_cwd_on(r"C:\Users\me", cwd, true));
        // Off Windows paths stay exact: case is significant.
        assert!(!same_cwd_on("/Users/me/Project", Path::new("/Users/me/project"), false));
    }
    #[test]
    fn codex_receives_the_folder_without_the_verbatim_prefix() {
        assert_eq!(ordinary_on(Path::new(r"\\?\C:\Users\me\project"), true), PathBuf::from(r"C:\Users\me\project"));
        assert_eq!(ordinary_on(Path::new(r"\\?\UNC\server\share\p"), true), PathBuf::from(r"\\server\share\p"));
        assert_eq!(ordinary_on(Path::new(r"\\?\Volume{x}\p"), true), PathBuf::from(r"\\?\Volume{x}\p"));
        assert_eq!(ordinary_on(Path::new(r"\\?\C:\p"), false), PathBuf::from(r"\\?\C:\p"));
        assert_eq!(codex_path(Path::new("/project")), PathBuf::from("/project"));
    }

}
