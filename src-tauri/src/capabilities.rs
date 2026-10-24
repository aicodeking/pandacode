//! Read-only local inventories for connected harnesses and PandaCode prompt caching.

use serde::Serialize;
use serde_json::Value;
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};
use tauri::{Manager, State};

const MAX_CONFIG_BYTES: u64 = 2 * 1024 * 1024;
const MAX_USAGE_CACHE_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Harness {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CapabilityEntry {
    pub harness: String,
    pub kind: String,
    pub name: String,
    pub state: String,
    pub source: String,
    pub command: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MatrixCell {
    pub harness: String,
    pub state: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MatrixRow {
    pub kind: String,
    pub name: String,
    pub states: Vec<MatrixCell>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Inventory {
    pub harnesses: Vec<Harness>,
    pub entries: Vec<CapabilityEntry>,
    pub matrix: Vec<MatrixRow>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CacheHarness {
    pub id: String,
    pub name: String,
    pub instruction_delivery: String,
    pub state: String,
    pub cache_tokens: String,
    pub cache_read_tokens: Option<u64>,
    pub cache_creation_tokens: Option<u64>,
    pub cache_token_source: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CacheAlignment {
    pub task_provider: Option<String>,
    pub harnesses: Vec<CacheHarness>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ObservedTokens {
    read: u64,
    created: u64,
}

/// Lists the local harnesses and sanitized metadata without enabling anything.
#[tauri::command]
pub(crate) async fn capabilities_inventory(
    state: State<'_, crate::AppState>,
    task_id: Option<String>,
) -> Result<Inventory, String> {
    let task_scoped = task_id.is_some();
    let home = crate::agent_usage_providers::home()
        .ok_or("Could not locate the user config directory.")?;
    let cwd = workspace_for(&state, task_id.as_deref(), &home)?;
    let providers = tauri::async_runtime::spawn_blocking(crate::providers::discover)
        .await
        .map_err(|_| "Could not inspect installed harnesses.".to_string())?;
    let harnesses: Vec<_> = providers
        .iter()
        .filter(|provider| provider.installed)
        .map(|provider| Harness {
            id: provider.id.clone(),
            name: provider.name.clone(),
        })
        .collect();

    let mut entries = Vec::new();
    let mut warnings = Vec::new();
    let mut pending = tokio::task::JoinSet::new();
    for harness in &harnesses {
        entries.extend(scan_harness_configs(
            &harness.id,
            &home,
            task_scoped.then_some(cwd.as_path()),
        ));
        let id = harness.id.clone();
        let cwd = cwd.clone();
        pending.spawn(async move {
            let catalog = crate::slash_commands::catalog(&id, &cwd, false).await;
            (id, catalog)
        });
    }
    while let Some(result) = pending.join_next().await {
        match result {
            Ok((harness, Ok(catalog))) => entries.extend(
                catalog
                    .commands
                    .into_iter()
                    .filter(|command| command.source != "PandaCode")
                    .filter_map(|command| {
                        let name = safe_label(&command.name)?;
                        Some(CapabilityEntry {
                            harness: harness.clone(),
                            kind: "slash command".into(),
                            state: if command.kind == "native" {
                                "native"
                            } else {
                                "discovered"
                            }
                            .into(),
                            name,
                            source: "Harness command catalog".into(),
                            command: None,
                        })
                    }),
            ),
            Ok((_, Err(_))) | Err(_) => {
                warnings.push("Some harness command catalogs could not be read.".into())
            }
        }
    }
    entries.sort_by(|a, b| (&a.harness, &a.kind, &a.name).cmp(&(&b.harness, &b.kind, &b.name)));
    entries.dedup_by(|a, b| a.harness == b.harness && a.kind == b.kind && a.name == b.name);
    warnings.sort();
    warnings.dedup();
    let matrix = alignment_matrix(&harnesses, &entries);
    Ok(Inventory {
        harnesses,
        entries,
        matrix,
        warnings,
    })
}

/// Shows PandaCode's instruction delivery logic and already-observed local cache counts.
#[tauri::command]
pub(crate) async fn cache_alignment(
    app: tauri::AppHandle,
    state: State<'_, crate::AppState>,
    task_id: Option<String>,
) -> Result<CacheAlignment, String> {
    let task_scoped = task_id.is_some();
    let (task_provider, resume_id) = if let Some(task_id) = task_id.as_deref() {
        let store = state.store.lock().map_err(|error| error.to_string())?;
        let session = store.session(task_id)?;
        (Some(session.provider), session.resume_id)
    } else {
        (None, None)
    };
    let providers = tauri::async_runtime::spawn_blocking(crate::providers::discover)
        .await
        .map_err(|_| "Could not inspect installed harnesses.".to_string())?;
    let usage_cache = app
        .path()
        .app_data_dir()
        .ok()
        .and_then(|directory| read_usage_cache(&directory.join("usage-ledger-cache.json")));

    let harnesses = providers
        .into_iter()
        .filter(|provider| provider.installed)
        .map(|provider| {
            let (instruction_delivery, state) = instruction_delivery(&provider.id);
            // The local usage ledger parses provider-reported cache counts for Claude and Codex.
            // Other harnesses do not currently persist cache read/write counts in PandaCode.
            let observed = match (&usage_cache, provider.id.as_str()) {
                (Some(cache), "claude") if !task_scoped || resume_id.is_some() => {
                    cache_tokens(cache, "claude", resume_id.as_deref())
                }
                (Some(cache), "codex") if !task_scoped || resume_id.is_some() => {
                    cache_tokens(cache, "codex", resume_id.as_deref())
                }
                _ => None,
            };
            CacheHarness {
                id: provider.id,
                name: provider.name,
                instruction_delivery: instruction_delivery.into(),
                state: state.into(),
                cache_tokens: if observed.is_some() {
                    "observed"
                } else {
                    "not exposed"
                }
                .into(),
                cache_read_tokens: observed.as_ref().map(|tokens| tokens.read),
                cache_creation_tokens: observed.as_ref().map(|tokens| tokens.created),
                cache_token_source: if observed.is_some() {
                    "Local usage ledger"
                } else {
                    "Not exposed"
                }
                .into(),
            }
        })
        .collect();
    Ok(CacheAlignment {
        task_provider,
        harnesses,
    })
}

fn workspace_for(
    state: &crate::AppState,
    task_id: Option<&str>,
    home: &Path,
) -> Result<PathBuf, String> {
    let Some(task_id) = task_id else {
        return Ok(home.to_path_buf());
    };
    let project_id = state
        .store
        .lock()
        .map_err(|error| error.to_string())?
        .session(task_id)?
        .project_id;
    state.root(&project_id, Some(task_id))
}

fn read_json(path: &Path) -> Option<Value> {
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_CONFIG_BYTES {
        return None;
    }
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

fn read_text(path: &Path) -> Option<String> {
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_CONFIG_BYTES {
        return None;
    }
    fs::read_to_string(path).ok()
}

fn safe_label(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() || value.len() > 100 || value.chars().any(char::is_control) {
        return None;
    }
    let lower = value.to_ascii_lowercase();
    if [
        "ghp_",
        "github_pat_",
        "sk-",
        "xoxb-",
        "xoxp-",
        "bearer ",
        "secret",
        "token",
        "api_key",
        "api-key",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
    {
        return None;
    }
    if !value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | ':' | '-' | '_' | '.' | '@' | ' '))
    {
        return None;
    }
    Some(value.to_owned())
}

fn command_name(value: &Value) -> Option<String> {
    let executable = match value {
        Value::String(value) => value.split_whitespace().next()?,
        Value::Array(values) => values.first()?.as_str()?,
        _ => return None,
    };
    let basename = Path::new(executable).file_name()?.to_str()?;
    safe_label(basename)
}

fn entry(
    harness: &str,
    kind: &str,
    name: &str,
    source: &str,
    command: Option<String>,
) -> Option<CapabilityEntry> {
    let name = safe_label(name)?;
    if (kind == "slash command" && name.contains('/') && !name.starts_with('/')
        || kind != "slash command" && name.contains('/'))
        || (kind == "slash command"
            && name
                .strip_prefix('/')
                .is_some_and(|tail| tail.contains('/')))
    {
        return None;
    }
    Some(CapabilityEntry {
        harness: harness.to_owned(),
        kind: kind.to_owned(),
        name,
        state: "discovered".into(),
        source: source.to_owned(),
        command,
    })
}

fn parse_mcp_json(harness: &str, source: &str, config: &Value, key: &str) -> Vec<CapabilityEntry> {
    let Some(servers) = config.get(key).and_then(Value::as_object) else {
        return Vec::new();
    };
    servers
        .iter()
        .filter_map(|(name, config)| {
            entry(
                harness,
                "mcp server",
                name,
                source,
                command_name(&config["command"]),
            )
        })
        .collect()
}

fn parse_codex_mcp(config: &str) -> Vec<CapabilityEntry> {
    parse_toml_mcp("codex", config, "mcp_servers", "Codex config.toml")
}

fn parse_toml_mcp(harness: &str, config: &str, key: &str, source: &str) -> Vec<CapabilityEntry> {
    let Ok(config) = toml::from_str::<toml::Value>(config) else {
        return Vec::new();
    };
    let Some(servers) = config.get(key).and_then(toml::Value::as_table) else {
        return Vec::new();
    };
    servers
        .iter()
        .filter_map(|(name, config)| {
            let command_value = config.get("command").and_then(|value| match value {
                toml::Value::String(value) => Some(Value::String(value.clone())),
                toml::Value::Array(values) => Some(Value::Array(
                    values
                        .iter()
                        .filter_map(|value| value.as_str().map(|s| Value::String(s.to_owned())))
                        .collect(),
                )),
                _ => None,
            });
            entry(
                harness,
                "mcp server",
                name,
                source,
                command_value.as_ref().and_then(command_name),
            )
        })
        .collect()
}

fn parse_claude_settings(settings: &Value) -> Vec<CapabilityEntry> {
    let mut entries = Vec::new();
    if let Some(hooks) = settings.get("hooks").and_then(Value::as_object) {
        for event in hooks.keys() {
            if let Some(item) = entry("claude", "hook", event, "~/.claude/settings.json", None) {
                entries.push(item);
            }
        }
    }
    for key in ["enabledPlugins", "plugins"] {
        match settings.get(key) {
            Some(Value::Object(plugins)) => {
                for (name, value) in plugins {
                    let enabled = value.as_bool().unwrap_or_else(|| {
                        value
                            .get("enabled")
                            .and_then(Value::as_bool)
                            .unwrap_or(true)
                    });
                    if enabled {
                        if let Some(item) =
                            entry("claude", "plugin", name, "~/.claude/settings.json", None)
                        {
                            entries.push(item);
                        }
                    }
                }
            }
            Some(Value::Array(plugins)) => {
                for plugin in plugins {
                    if let Some(name) = plugin
                        .as_str()
                        .or_else(|| plugin.get("name").and_then(Value::as_str))
                    {
                        if plugin.get("enabled").and_then(Value::as_bool) != Some(false) {
                            if let Some(item) =
                                entry("claude", "plugin", name, "~/.claude/settings.json", None)
                            {
                                entries.push(item);
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }
    entries
}

fn scan_harness_configs(
    harness: &str,
    home: &Path,
    project: Option<&Path>,
) -> Vec<CapabilityEntry> {
    let mut entries = Vec::new();
    match harness {
        "claude" | "glm" | "mimo" => {
            if let Some(value) = read_json(&home.join(".claude.json")) {
                entries.extend(parse_mcp_json(
                    harness,
                    "~/.claude.json",
                    &value,
                    "mcpServers",
                ));
            }
            if let Some(project) = project {
                if let Some(value) = read_json(&project.join(".mcp.json")) {
                    entries.extend(parse_mcp_json(
                        harness,
                        "Project .mcp.json",
                        &value,
                        "mcpServers",
                    ));
                }
            }
            if harness == "claude" {
                if let Some(value) = read_json(&home.join(".claude/settings.json")) {
                    entries.extend(parse_claude_settings(&value));
                }
            }
        }
        "codex" => {
            let config_dir = std::env::var_os("CODEX_HOME")
                .map(PathBuf::from)
                .filter(|path| path.is_absolute())
                .unwrap_or_else(|| home.join(".codex"));
            if let Some(config) = read_text(&config_dir.join("config.toml")) {
                entries.extend(parse_codex_mcp(&config));
            }
        }
        "opencode" => {
            for (path, source) in [
                (
                    home.join(".config/opencode/opencode.json"),
                    "~/.config/opencode/opencode.json",
                ),
                (
                    home.join(".opencode/opencode.json"),
                    "~/.opencode/opencode.json",
                ),
            ] {
                if let Some(value) = read_json(&path) {
                    entries.extend(parse_mcp_json(harness, source, &value, "mcp"));
                }
            }
            if let Some(project) = project {
                if let Some(value) = read_json(&project.join("opencode.json")) {
                    entries.extend(parse_mcp_json(
                        harness,
                        "Project opencode.json",
                        &value,
                        "mcp",
                    ));
                }
            }
        }
        "kimi" => {
            for path in [
                home.join(".kimi-code/config.toml"),
                home.join(".kimi/config.toml"),
            ] {
                if let Some(config) = read_text(&path) {
                    if let Ok(value) = serde_json::from_str::<Value>(&config) {
                        entries.extend(parse_mcp_json(
                            harness,
                            "Kimi user config",
                            &value,
                            "mcpServers",
                        ));
                    } else {
                        entries.extend(parse_toml_mcp(
                            harness,
                            &config,
                            "mcp_servers",
                            "Kimi user config",
                        ));
                    }
                }
            }
            if let Some(project) = project {
                for path in [
                    project.join(".kimi/config.toml"),
                    project.join(".kimi-code/config.toml"),
                ] {
                    if let Some(config) = read_text(&path) {
                        if let Ok(value) = serde_json::from_str::<Value>(&config) {
                            entries.extend(parse_mcp_json(
                                harness,
                                "Project Kimi config",
                                &value,
                                "mcpServers",
                            ));
                        } else {
                            entries.extend(parse_toml_mcp(
                                harness,
                                &config,
                                "mcp_servers",
                                "Project Kimi config",
                            ));
                        }
                    }
                }
            }
        }
        "cline" => {
            let mut seen_user_mcp = std::collections::HashSet::new();
            for (path, source) in [
                (
                    home.join(".cline/data/settings/cline_mcp_settings.json"),
                    "~/.cline/data/settings/cline_mcp_settings.json",
                ),
                (
                    home.join(".cline/cline_mcp_settings.json"),
                    "~/.cline/cline_mcp_settings.json",
                ),
                (
                    home.join(".cline/mcp_settings.json"),
                    "~/.cline/mcp_settings.json",
                ),
            ] {
                if let Some(value) = read_json(&path) {
                    for entry in parse_mcp_json(harness, source, &value, "mcpServers") {
                        if seen_user_mcp.insert(entry.name.clone()) {
                            entries.push(entry);
                        }
                    }
                }
            }
            if let Some(project) = project {
                let mut seen_project_mcp = std::collections::HashSet::new();
                for (path, source) in [
                    (
                        project.join(".cline/cline_mcp_settings.json"),
                        ".cline/cline_mcp_settings.json",
                    ),
                    (
                        project.join(".cline/mcp_settings.json"),
                        ".cline/mcp_settings.json",
                    ),
                ] {
                    if let Some(value) = read_json(&path) {
                        for entry in parse_mcp_json(harness, source, &value, "mcpServers") {
                            if seen_project_mcp.insert(entry.name.clone()) {
                                entries.push(entry);
                            }
                        }
                    }
                }
            }
        }
        _ => {}
    }
    entries.extend(scan_skill_dirs(harness, home, project));
    entries
}

fn skill_roots(harness: &str, home: &Path, project: Option<&Path>) -> Vec<(PathBuf, &'static str)> {
    let mut roots = Vec::new();
    match harness {
        "claude" | "glm" | "mimo" => {
            roots.push((home.join(".claude/skills"), "~/.claude/skills"));
            if let Some(project) = project {
                roots.push((project.join(".claude/skills"), ".claude/skills"));
            }
        }
        "codex" => {
            roots.push((home.join(".codex/skills"), "~/.codex/skills"));
            if let Some(project) = project {
                roots.push((project.join(".agents/skills"), ".agents/skills"));
            }
        }
        "opencode" => {
            roots.push((
                home.join(".config/opencode/skills"),
                "~/.config/opencode/skills",
            ));
            if let Some(project) = project {
                roots.push((project.join(".opencode/skills"), ".opencode/skills"));
            }
        }
        "kimi" => {
            roots.push((home.join(".kimi-code/skills"), "~/.kimi-code/skills"));
            roots.push((home.join(".kimi/skills"), "~/.kimi/skills"));
            if let Some(project) = project {
                roots.push((project.join(".kimi/skills"), ".kimi/skills"));
            }
        }
        "pi" | "omp" => {
            roots.push((home.join(".pi/agent/skills"), "~/.pi/agent/skills"));
            if let Some(project) = project {
                roots.push((project.join(".pi/skills"), ".pi/skills"));
            }
        }
        "cline" => {
            roots.push((home.join(".cline/skills"), "~/.cline/skills"));
            if let Some(project) = project {
                roots.push((project.join(".cline/skills"), ".cline/skills"));
                roots.push((project.join(".clinerules/skills"), ".clinerules/skills"));
                roots.push((project.join(".claude/skills"), ".claude/skills"));
            }
        }
        _ => {}
    }
    roots
}

fn scan_skill_dirs(harness: &str, home: &Path, project: Option<&Path>) -> Vec<CapabilityEntry> {
    let mut entries = Vec::new();
    for (root, source) in skill_roots(harness, home, project) {
        let Ok(items) = fs::read_dir(root) else {
            continue;
        };
        for item in items.flatten() {
            let Ok(kind) = item.file_type() else {
                continue;
            };
            if !kind.is_dir() {
                continue;
            }
            let Some(name) = item.file_name().to_str().and_then(safe_label) else {
                continue;
            };
            if let Some(item) = entry(harness, "skill", &name, source, None) {
                entries.push(item);
            }
        }
    }
    entries
}

fn alignment_matrix(harnesses: &[Harness], entries: &[CapabilityEntry]) -> Vec<MatrixRow> {
    let mut rows: BTreeMap<(String, String), BTreeMap<String, String>> = BTreeMap::new();
    for capability in entries {
        rows.entry((capability.kind.clone(), capability.name.clone()))
            .or_default()
            .insert(capability.harness.clone(), capability.state.clone());
    }
    rows.into_iter()
        .map(|((kind, name), present)| MatrixRow {
            kind,
            name,
            states: harnesses
                .iter()
                .map(|harness| MatrixCell {
                    harness: harness.id.clone(),
                    state: present
                        .get(&harness.id)
                        .cloned()
                        .unwrap_or_else(|| "missing".into()),
                })
                .collect(),
        })
        .collect()
}

fn instruction_delivery(provider: &str) -> (&'static str, &'static str) {
    if crate::providers::takes_system_instructions(provider) {
        ("cachedSystemPrompt", "supported")
    } else {
        ("messageInjection", "partial")
    }
}

fn read_usage_cache(path: &Path) -> Option<Value> {
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_USAGE_CACHE_BYTES {
        return None;
    }
    let cache: Value = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    (cache["version"].as_u64() == Some(1)).then_some(cache)
}

fn cache_tokens(cache: &Value, agent: &str, resume_id: Option<&str>) -> Option<ObservedTokens> {
    let files = cache.get("files")?.as_object()?;
    let mut tokens = ObservedTokens {
        read: 0,
        created: 0,
    };
    let mut records_seen = 0usize;
    for (path, file) in files {
        if file["agent"].as_str() != Some(agent) || resume_id.is_some_and(|id| !path.contains(id)) {
            continue;
        }
        let Some(records) = file.get("records").and_then(Value::as_array) else {
            continue;
        };
        for record in records {
            tokens.read = tokens
                .read
                .saturating_add(record["cache_read"].as_u64().unwrap_or(0));
            tokens.created = tokens
                .created
                .saturating_add(record["cache_write"].as_u64().unwrap_or(0))
                .saturating_add(record["cache_write_1h"].as_u64().unwrap_or(0));
            records_seen += 1;
        }
    }
    (records_seen > 0).then_some(tokens)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture_home(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "pandacode-capabilities-{name}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn claude_mcp_inventory_keeps_server_names_and_executables_but_drops_args_and_env() {
        let config = json!({"mcpServers": {
            "docs": {"command": "/opt/tools/node", "args": ["-e", "TOKEN=secret"], "env": {"API_KEY": "secret"}},
            "ghp_example-secret": {"command": "ghp_example-secret"}
        }});
        let entries = parse_mcp_json("claude", "User config", &config, "mcpServers");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "docs");
        assert_eq!(entries[0].command.as_deref(), Some("node"));
        let serialized = serde_json::to_string(&entries).unwrap();
        assert!(!serialized.contains("secret"));
        assert!(!serialized.contains("/opt/tools"));
    }

    #[test]
    fn codex_toml_inventory_uses_only_server_name_and_command() {
        let config = r#"
[mcp_servers.docs]
command = "node"
args = ["--token", "secret"]
env = { API_KEY = "secret" }
"#;
        let entries = parse_codex_mcp(config);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "docs");
        assert_eq!(entries[0].command.as_deref(), Some("node"));
        let serialized = serde_json::to_string(&entries).unwrap();
        assert!(!serialized.contains("secret"));
    }

    #[test]
    fn config_files_are_read_from_fixture_home_and_project_without_returning_private_values() {
        let home = fixture_home("config-home");
        let project = fixture_home("config-project");
        fs::create_dir_all(home.join(".claude")).unwrap();
        fs::write(
            home.join(".claude.json"),
            r#"{"mcpServers":{"user-docs":{"command":"/opt/local/node","args":["SECRET"],"env":{"TOKEN":"SECRET"}}}}"#,
        )
        .unwrap();
        fs::write(
            project.join(".mcp.json"),
            r#"{"mcpServers":{"project-docs":{"command":"node","args":["SECRET"]}}}"#,
        )
        .unwrap();
        fs::write(
            home.join(".claude/settings.json"),
            r#"{"hooks":{"PreToolUse":[{"command":"SECRET"}]},"enabledPlugins":{"review@local":true},"env":{"TOKEN":"SECRET"}}"#,
        )
        .unwrap();

        let entries = scan_harness_configs("claude", &home, Some(&project));
        assert!(entries.iter().any(|item| item.name == "user-docs"));
        assert!(entries.iter().any(|item| item.name == "project-docs"));
        assert!(entries.iter().any(|item| item.name == "PreToolUse"));
        assert!(entries.iter().any(|item| item.name == "review@local"));
        let serialized = serde_json::to_string(&entries).unwrap();
        assert!(!serialized.contains("SECRET"));
        assert!(!serialized.contains(home.to_str().unwrap()));
        fs::remove_dir_all(home).unwrap();
        fs::remove_dir_all(project).unwrap();
    }

    #[test]
    fn claude_settings_inventory_keeps_hook_events_and_plugin_names_only() {
        let settings = json!({
            "hooks": {
                "PreToolUse": [{"hooks": [{"command": "echo secret", "env": {"TOKEN": "secret"}}]}],
                "SessionStart": []
            },
            "enabledPlugins": {"review@local": true, "disabled@local": false, "/Users/person/private-plugin": true},
            "env": {"API_KEY": "secret"}
        });
        let entries = parse_claude_settings(&settings);
        assert!(entries
            .iter()
            .any(|item| item.kind == "hook" && item.name == "PreToolUse"));
        assert!(entries
            .iter()
            .any(|item| item.kind == "plugin" && item.name == "review@local"));
        assert!(!entries.iter().any(|item| item.name == "disabled@local"));
        assert!(!entries.iter().any(|item| item.name.contains("Users")));
        assert!(!serde_json::to_string(&entries).unwrap().contains("secret"));
    }

    #[test]
    fn skill_inventory_reads_only_directory_names_from_a_fixture_home_and_project() {
        let home = fixture_home("skills-home"); // Explicit fixture HOME; production passes the resolved HOME here.
        let project = fixture_home("skills-project");
        fs::create_dir_all(home.join(".claude/skills/review")).unwrap();
        fs::create_dir_all(project.join(".claude/skills/release-check")).unwrap();
        fs::write(
            home.join(".claude/skills/review/SKILL.md"),
            "private prompt",
        )
        .unwrap();
        let entries = scan_skill_dirs("claude", &home, Some(&project));
        assert!(entries.iter().any(|item| item.name == "review"));
        assert!(entries.iter().any(|item| item.name == "release-check"));
        assert!(!serde_json::to_string(&entries)
            .unwrap()
            .contains("private prompt"));
        fs::remove_dir_all(home).unwrap();
        fs::remove_dir_all(project).unwrap();
    }

    #[test]
    fn cache_usage_is_task_scoped_and_does_not_return_log_paths() {
        let cache = json!({"version": 1, "files": {
            "/private/path/one.jsonl": {"agent": "claude", "records": [{"cache_read": 100, "cache_write": 10, "cache_write_1h": 5}]},
            "/private/path/two.jsonl": {"agent": "claude", "records": [{"cache_read": 900, "cache_write": 90, "cache_write_1h": 0}]}
        }});
        let observed = cache_tokens(&cache, "claude", Some("one")).unwrap();
        assert_eq!(observed.read, 100);
        assert_eq!(observed.created, 15);
        assert!(!serde_json::to_string(&observed)
            .unwrap()
            .contains("/private"));
    }

    #[test]
    fn instruction_cache_state_comes_from_the_provider_delivery_predicate() {
        assert_eq!(
            instruction_delivery("claude"),
            ("cachedSystemPrompt", "supported")
        );
        assert_eq!(
            instruction_delivery("codex"),
            ("messageInjection", "partial")
        );
        assert_eq!(
            instruction_delivery("cline"),
            ("messageInjection", "partial")
        );
    }

    #[test]
    fn cline_mcp_and_skills_inventory_reads_configured_paths() {
        let home = fixture_home("cline-home");
        let project = fixture_home("cline-project");
        let settings = home.join(".cline/data/settings");
        fs::create_dir_all(&settings).unwrap();
        fs::write(
            settings.join("cline_mcp_settings.json"),
            r#"{"mcpServers":{"local-tool":{"command":"node","args":["server.js"]}}}"#,
        )
        .unwrap();
        // Fallback config has a duplicate server name that should be deduplicated in favor of settings.
        fs::write(
            home.join(".cline/mcp_settings.json"),
            r#"{"mcpServers":{"local-tool":{"command":"node","args":["legacy.js"]}}}"#,
        )
        .unwrap();
        fs::create_dir_all(project.join(".cline/skills/code-review")).unwrap();
        fs::create_dir_all(project.join(".clinerules/skills/doc-gen")).unwrap();
        let entries = scan_harness_configs("cline", &home, Some(&project));
        let local_tools: Vec<_> = entries
            .iter()
            .filter(|item| item.harness == "cline" && item.kind == "mcp server" && item.name == "local-tool")
            .collect();
        assert_eq!(local_tools.len(), 1);
        assert_eq!(local_tools[0].source, "~/.cline/data/settings/cline_mcp_settings.json");
        assert!(entries
            .iter()
            .any(|item| item.harness == "cline" && item.kind == "skill" && item.name == "code-review"));
        assert!(entries
            .iter()
            .any(|item| item.harness == "cline" && item.kind == "skill" && item.name == "doc-gen"));
        fs::remove_dir_all(home).unwrap();
        fs::remove_dir_all(project).unwrap();
    }
}
