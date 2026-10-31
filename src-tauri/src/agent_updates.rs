//! Read-only release checks and explicitly requested updates of known agent installs.
//!
//! Not telemetry: a check is a plain anonymous GET of each agent vendor's public
//! release metadata (npm, PyPI, Homebrew, GitHub or the vendor's release URL).
//! No identifier, usage, workspace or account data is sent, and no PandaCode
//! server is involved.
use crate::Result;
use serde::Serialize;
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        OnceLock,
    },
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};
use tokio::sync::{Mutex, Semaphore};

#[path = "agent_updates_install.rs"]
mod install;

/// Set while an agent CLI is being replaced, so no task or console starts it mid-install.
static INSTALLING: AtomicBool = AtomicBool::new(false);

pub(crate) fn ensure_not_installing() -> Result<()> {
    if INSTALLING.load(Ordering::SeqCst) {
        return Err("An agent update is being installed. Try again when it finishes.".into());
    }
    Ok(())
}

pub(crate) struct InstallGuard;
impl Drop for InstallGuard {
    fn drop(&mut self) {
        INSTALLING.store(false, Ordering::SeqCst);
    }
}

/// Claims the agent-install slot only while no agent, console, assessment, goal or team runs.
pub(crate) fn reserve_install(state: &crate::AppState) -> Result<InstallGuard> {
    // The same registry lock guards agent admission and harness reservations.
    let agents = state
        .agents
        .lock()
        .map_err(|_| "Agent state is unavailable.")?;
    if state.shutdown.load(Ordering::SeqCst) != 0 {
        return Err("PandaCode is shutting down.".into());
    }
    if crate::jev::is_busy() {
        return Err("Finish Jev browser tests and setup before updating an agent.".into());
    }
    let terminals_open = !state
        .terminals
        .lock()
        .map_err(|_| "Terminal state is unavailable.")?
        .is_empty();
    if !agents.is_empty() || terminals_open {
        return Err("Finish running agents and close terminals before updating an agent.".into());
    }
    let store = state
        .store
        .lock()
        .map_err(|_| "Task state is unavailable.")?;
    if crate::jev_decisions::active_for_store(&store)? {
        return Err("Finish Jev assessments before updating an agent.".into());
    }
    let busy = |sql: &str, what: &str| -> Result<bool> {
        store.db.query_row(sql, [], |row| row.get(0)).map_err(|_| format!("{what} state is unavailable."))
    };
    if busy("SELECT EXISTS(SELECT 1 FROM sessions WHERE json_valid(goal_state) AND json_extract(goal_state,'$.status')='active')", "Goal")? {
        return Err("Pause active goals before updating an agent.".into());
    }
    // Admission must inspect every team, including coordinators between turns.
    if busy("SELECT EXISTS(SELECT 1 FROM architect_teams WHERE json_extract(content,'$.status') IN ('running','waiting'))", "Team")? {
        return Err("Pause active teams before updating an agent.".into());
    }
    if INSTALLING.swap(true, Ordering::SeqCst) {
        return Err("An agent update is already being installed.".into());
    }
    Ok(InstallGuard)
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUpdate {
    pub provider: String,
    pub name: String,
    pub providers: Vec<String>,
    pub installed_version: Option<String>,
    pub latest_version: Option<String>,
    pub status: String,
    pub method: Option<String>,
    pub can_update: bool,
    pub message: Option<String>,
    pub checked_at: i64,
    pub docs_url: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct Version {
    numbers: [u64; 3],
    pre: Option<String>,
    text: String,
}

impl Version {
    fn at_least(&self, other: &Self) -> bool {
        self.numbers > other.numbers
            || (self.numbers == other.numbers && (self.pre.is_none() || self.pre == other.pre))
    }
}

fn parse_version(input: &str) -> Option<Version> {
    if input.len() > 4096 {
        return None;
    }
    input.split_whitespace().take(12).find_map(|word| {
        let word = word
            .strip_prefix("rust-v")
            .or_else(|| word.strip_prefix('v'))
            .unwrap_or(word);
        if word.len() > 80
            || !word
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b".-+".contains(&c))
        {
            return None;
        }
        let (main, _) = word.split_once('+').unwrap_or((word, ""));
        let (base, pre) = main
            .split_once('-')
            .map_or((main, None), |(a, b)| (a, Some(b)));
        let pieces: Vec<_> = base.split('.').collect();
        if pieces.len() != 3
            || pieces
                .iter()
                .any(|p| p.is_empty() || !p.bytes().all(|c| c.is_ascii_digit()))
        {
            return None;
        }
        if pre.is_some_and(str::is_empty) {
            return None;
        }
        Some(Version {
            numbers: [
                pieces[0].parse().ok()?,
                pieces[1].parse().ok()?,
                pieces[2].parse().ok()?,
            ],
            pre: pre.map(str::to_owned),
            text: word.to_owned(),
        })
    })
}

/// Every harness PandaCode can start, so a new one is checked without touching this file.
use crate::providers::PROVIDERS;

/// Families with a verified release feed and updater; every other agent is listed as manual.
const UPDATABLE: [&str; 6] = ["claude", "codex", "kimi", "opencode", "grok", "cline"];

fn family(provider: &str) -> &str {
    if matches!(provider, "glm" | "mimo") {
        "claude"
    } else {
        provider
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Installation {
    provider: String,
    name: String,
    providers: Vec<String>,
    path: PathBuf,
    canonical: PathBuf,
    modified: Option<std::time::SystemTime>,
    size: u64,
    compatible: bool,
}

fn group_installations(found: Vec<(String, String, PathBuf)>) -> Vec<Installation> {
    let mut groups: Vec<Installation> = Vec::new();
    for (provider, name, path) in found {
        let Ok(canonical) = path.canonicalize() else {
            continue;
        };
        let canonical = crate::providers::external_path(&canonical);
        let path = crate::providers::external_path(&path);
        let Ok(metadata) = canonical.metadata() else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        // A custom alias directly naming a version file stays pinned even when
        // the normal launcher advances. Only aliases sharing that launcher merge.
        if let Some(group) = groups
            .iter_mut()
            .find(|g| g.canonical == canonical && g.path == path)
        {
            group.compatible &= family(&group.provider) == family(&provider);
            group.providers.push(provider);
        } else {
            groups.push(Installation {
                provider: provider.clone(),
                name,
                providers: vec![provider],
                path,
                canonical,
                modified: metadata.modified().ok(),
                size: metadata.len(),
                compatible: true,
            });
        }
    }
    groups
}

fn installed() -> Vec<Installation> {
    group_installations(
        PROVIDERS
            .iter()
            .filter_map(|(id, name)| {
                crate::providers::executable(id).map(|path| ((*id).into(), (*name).into(), path))
            })
            .collect(),
    )
}

#[derive(Clone)]
struct Checked {
    install: Installation,
    row: AgentUpdate,
    source: Option<String>,
}

#[derive(Default)]
struct Cache {
    installations: Vec<Installation>,
    result: Vec<Checked>,
    attempted: Option<Instant>,
    generation: u64,
}
fn cache() -> &'static Mutex<Cache> {
    static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}
static GENERATION: AtomicU64 = AtomicU64::new(0);
fn invalidate() {
    GENERATION.fetch_add(1, Ordering::SeqCst);
}

/// Whether a cache entry can still be used. The age is given rather than
/// measured, so the six-hour edge can be checked on any machine: an instant six
/// hours old does not exist on one that has been up for less than that.
fn reusable_at(
    cache: &Cache,
    installations: &[Installation],
    force: bool,
    generation: u64,
    age: Option<Duration>,
) -> bool {
    cache.generation == generation
        && cache.installations == installations
        && age.is_some_and(|age| age < Duration::from_secs(if force { 10 } else { 6 * 60 * 60 }))
}

fn reusable(cache: &Cache, installations: &[Installation], force: bool, generation: u64) -> bool {
    reusable_at(
        cache,
        installations,
        force,
        generation,
        cache.attempted.map(|at| at.elapsed()),
    )
}

fn metadata_endpoint(source: &str) -> Option<(&'static str, &'static str)> {
    match source {
        "claude" => Some((
            "https://downloads.claude.ai/claude-code-releases/latest",
            "text",
        )),
        "claude:stable" => Some((
            "https://downloads.claude.ai/claude-code-releases/stable",
            "text",
        )),
        "npm:claude" => Some((
            "https://registry.npmjs.org/@anthropic-ai%2fclaude-code/latest",
            "version",
        )),
        "codex" => Some((
            "https://releases.openai.com/codex/channels/latest",
            "tag_name",
        )),
        "npm:codex" => Some((
            "https://registry.npmjs.org/@openai%2fcodex/latest",
            "version",
        )),
        "opencode" => Some((
            "https://api.github.com/repos/anomalyco/opencode/releases/latest",
            "tag_name",
        )),
        "npm:opencode" => Some(("https://registry.npmjs.org/opencode-ai/latest", "version")),
        "npm:cline" => Some(("https://registry.npmjs.org/cline/latest", "version")),
        "kimi" => Some(("https://cdn.kimi.com/kimi-code/latest", "text")),
        "kimi-python" => Some(("https://pypi.org/pypi/kimi-cli/json", "info.version")),
        "grok" => Some((
            "https://storage.googleapis.com/grok-build-public-artifacts/cli/stable",
            "text",
        )),
        "grok:alpha" => Some((
            "https://storage.googleapis.com/grok-build-public-artifacts/cli/alpha",
            "text",
        )),
        "grok:enterprise" => Some((
            "https://storage.googleapis.com/grok-build-public-artifacts/cli/enterprise",
            "text",
        )),
        "brew:cask:codex" => Some(("https://formulae.brew.sh/api/cask/codex.json", "version")),
        "brew:cask:claude-code" => Some((
            "https://formulae.brew.sh/api/cask/claude-code.json",
            "version",
        )),
        "brew:cask:claude-code@latest" => Some((
            "https://formulae.brew.sh/api/cask/claude-code@latest.json",
            "version",
        )),
        "brew:formula:opencode" => Some((
            "https://formulae.brew.sh/api/formula/opencode.json",
            "versions.stable",
        )),
        _ => None,
    }
}

fn latest_version(bytes: &[u8], format: &str) -> Option<Version> {
    let value;
    let raw = if format == "text" {
        std::str::from_utf8(bytes).ok()?.trim()
    } else {
        value = serde_json::from_slice::<serde_json::Value>(bytes).ok()?;
        match format {
            "info.version" => value["info"]["version"].as_str()?,
            "versions.stable" => value["versions"]["stable"].as_str()?,
            "tag_name" => value["tag_name"].as_str()?,
            _ => value["version"].as_str()?,
        }
    };
    let parsed = parse_version(raw)?;
    let normalized = raw
        .strip_prefix("rust-v")
        .or_else(|| raw.strip_prefix('v'))
        .unwrap_or(raw);
    (parsed.text == normalized && parsed.pre.is_none()).then_some(parsed)
}

async fn latest(source: &str) -> Result<Version> {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    let (url, format) =
        metadata_endpoint(source).ok_or("This agent does not expose a supported release feed.")?;
    let client = reqwest::Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(10))
        .connect_timeout(Duration::from_secs(4))
        .user_agent("PandaCode agent update checker")
        .build()
        .map_err(|_| "Could not create the release checker.")?;
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|_| "Could not reach the official release service. Try again later.")?;
    if !response.status().is_success() {
        return Err(
            "The official release service is unavailable or rate limited. Try again later.".into(),
        );
    }
    const LIMIT: usize = 512 * 1024;
    if response.content_length().is_some_and(|n| n > LIMIT as u64) {
        return Err("The release response exceeded its size limit.".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Could not read the release response.")?
    {
        if bytes.len() + chunk.len() > LIMIT {
            return Err("The release response exceeded its size limit.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    latest_version(&bytes, format)
        .ok_or("The official release service did not return a stable version.".into())
}

fn base_row(install: &Installation) -> AgentUpdate {
    AgentUpdate {
        provider: install.provider.clone(),
        name: install.name.clone(),
        providers: install.providers.clone(),
        installed_version: None,
        latest_version: None,
        status: "unsupported".into(),
        method: None,
        can_update: false,
        message: None,
        checked_at: crate::storage::now(),
        docs_url: install::docs(family(&install.provider)).map(Into::into),
    }
}

async fn inspect(installation: Installation) -> Checked {
    let mut row = base_row(&installation);
    if !installation.compatible {
        row.message = Some("This executable is selected for incompatible agents. Choose the correct executable in each agent's settings.".into());
        return Checked {
            install: installation,
            row,
            source: None,
        };
    }
    if family(&installation.provider) == "antigravity" {
        row.message = Some("Antigravity's ACP server is maintained separately from the agy CLI. Use its official installer to update this server.".into());
        return Checked {
            install: installation,
            row,
            source: None,
        };
    }
    if !UPDATABLE.contains(&family(&installation.provider)) {
        row.message = Some(
            "PandaCode cannot update this agent. Use its own updater or package manager.".into(),
        );
        let local = installation.clone();
        if let Ok(Ok(version)) = tokio::task::spawn_blocking(move || {
            install::version(&local.path, family(&local.provider))
        })
        .await
        {
            row.installed_version = Some(version.text);
        }
        return Checked {
            install: installation,
            row,
            source: None,
        };
    }
    let local = installation.clone();
    let details = tokio::task::spawn_blocking(move || {
        let version = install::version(&local.path, family(&local.provider))?;
        let method = install::detect(&local, &version);
        let source = install::source(&local, &version, method.as_ref().ok());
        Ok::<_, String>((version, method, source))
    })
    .await;
    let (version, method, source) = match details {
        Ok(Ok(details)) => details,
        _ => {
            row.status = "error".into();
            row.message = Some(
                "Could not read this agent's version. Check its installation in Settings.".into(),
            );
            return Checked {
                install: installation,
                row,
                source: None,
            };
        }
    };
    row.installed_version = Some(version.text.clone());
    let source = match source {
        Ok(source) => source,
        Err(message) => {
            row.message = Some(message);
            return Checked {
                install: installation,
                row,
                source: None,
            };
        }
    };
    match latest(&source).await {
        Ok(latest) => {
            row.latest_version = Some(latest.text.clone());
            match method {
                Ok(plan) => {
                    row.method = Some(plan.label().into());
                    row.can_update = !version.at_least(&latest);
                    row.status = if row.can_update {
                        "available"
                    } else {
                        "current"
                    }
                    .into();
                }
                Err(message) => {
                    row.status = if version.at_least(&latest) {
                        "current"
                    } else {
                        "available"
                    }
                    .into();
                    row.message = Some(message);
                }
            }
        }
        Err(message) => {
            row.status = "error".into();
            row.message = Some(message);
        }
    }
    Checked {
        install: installation,
        row,
        source: Some(source),
    }
}

async fn check(force: bool) -> Result<Vec<Checked>> {
    let installations = crate::blocking(|| Ok(installed())).await?;
    let mut cached = cache().lock().await;
    let generation = GENERATION.load(Ordering::SeqCst);
    if reusable(&cached, &installations, force, generation) {
        return Ok(cached.result.clone());
    }
    let semaphore = std::sync::Arc::new(Semaphore::new(3));
    let mut tasks = tokio::task::JoinSet::new();
    for (index, installation) in installations.iter().cloned().enumerate() {
        let semaphore = semaphore.clone();
        tasks.spawn(async move {
            let _permit = semaphore
                .acquire()
                .await
                .expect("update check semaphore stays open");
            (index, inspect(installation).await)
        });
    }
    let mut results = Vec::new();
    while let Some(result) = tasks.join_next().await {
        results.push(result.map_err(|_| "An agent update check stopped unexpectedly.")?);
    }
    results.sort_by_key(|(index, _)| *index);
    let mut result: Vec<_> = results.into_iter().map(|(_, row)| row).collect();
    if GENERATION.load(Ordering::SeqCst) == generation {
        *cached = Cache {
            installations,
            result: result.clone(),
            attempted: Some(Instant::now()),
            generation,
        };
    } else {
        for checked in &mut result {
            checked.row.status = "error".into();
            checked.row.can_update = false;
            checked.row.message = Some(
                "An agent changed during this check. Refresh to read its current version.".into(),
            );
        }
    }
    Ok(result)
}

#[tauri::command]
pub async fn check_agent_updates(
    window: tauri::WebviewWindow,
    force: Option<bool>,
) -> Result<Vec<AgentUpdate>> {
    if window.label() != "main" {
        return Err("Only the main window can check agent updates.".into());
    }
    Ok(check(force.unwrap_or(false))
        .await?
        .into_iter()
        .map(|checked| checked.row)
        .collect())
}

#[derive(Clone, Serialize)]
struct Progress {
    provider: String,
    phase: &'static str,
    message: Option<String>,
}

#[tauri::command]
pub async fn update_agent(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    provider: String,
) -> Result<AgentUpdate> {
    if window.label() != "main" {
        return Err("Only the main window can update agents.".into());
    }
    if !PROVIDERS.iter().any(|(id, _)| *id == provider) {
        return Err("Unknown agent.".into());
    }
    let checked = check(false)
        .await?
        .into_iter()
        .find(|checked| checked.row.providers.contains(&provider))
        .ok_or("This agent is not installed.")?;
    if !checked.row.can_update {
        return Ok(checked.row);
    }
    crate::blocking(move || {
        let state = app.state::<crate::AppState>();
        // Keep the guard inside the bounded worker: cancelling IPC cannot drop
        // admission while its package manager is still changing executable files.
        let _installing = reserve_install(&state)?;
        let mut row = checked.row;
        let current = installed()
            .into_iter()
            .find(|item| item.providers.contains(&provider))
            .ok_or("The agent installation changed. Check for updates again.")?;
        if current != checked.install {
            return Err("The agent installation changed. Check for updates again.".into());
        }
        let before = install::version(&current.path, family(&provider))?;
        let target = parse_version(row.latest_version.as_deref().unwrap_or(""))
            .ok_or("Check the latest version before updating.")?;
        let plan = install::detect(&current, &before)?;
        if Some(install::source(&current, &before, Some(&plan))?).as_ref()
            != checked.source.as_ref()
        {
            return Err("The agent's release channel changed. Check for updates again.".into());
        }
        let progress = |phase, message| {
            let _ = app.emit(
                "agent-update-progress",
                Progress {
                    provider: provider.clone(),
                    phase,
                    message,
                },
            );
        };
        progress("updating", None);
        let result = install::apply(
            &plan,
            &current.path,
            family(&provider),
            &before,
            &target,
            || progress("verifying", None),
        );
        invalidate();
        for alias in &row.providers {
            crate::providers::acp_catalog::invalidate(alias);
            crate::slash_commands::invalidate_provider(alias);
            crate::agent_usage::invalidate(alias);
            let _ = app.emit(
                "provider-models-changed",
                serde_json::json!({"provider":alias}),
            );
        }
        row.checked_at = crate::storage::now();
        match result {
            Ok(version) => {
                row.installed_version = Some(version.text);
                row.status = "current".into();
                row.can_update = false;
                row.message = None;
                progress("completed", None);
            }
            Err(message) => {
                let message = format!("{message} Check updates to retry.");
                row.status = "error".into();
                row.can_update = false;
                row.message = Some(message.clone());
                progress("error", Some(message));
            }
        }
        Ok(row)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_bounded_agent_versions_without_lexical_order_or_command_fragments() {
        for (banner, expected) in [
            ("codex-cli 0.154.0", [0, 154, 0]),
            ("2.1.280 (Claude Code)", [2, 1, 280]),
            ("v1.4.12", [1, 4, 12]),
            ("kimi, version 1.28.0", [1, 28, 0]),
        ] {
            assert_eq!(parse_version(banner).unwrap().numbers, expected);
        }
        for invalid in [
            "",
            "latest",
            "1.2.3;touch",
            "$(curl bad)",
            "999999999999999999999999999.0.0",
        ] {
            assert!(parse_version(invalid).is_none(), "{invalid}");
        }
    }

    #[test]
    fn release_feeds_are_fixed_and_reject_arbitrary_metadata_or_commands() {
        assert_eq!(
            latest_version(
                br#"{"tag_name":"rust-v0.156.1","assets":[{"url":"https://untrusted.test"}]}"#,
                "tag_name"
            )
            .unwrap()
            .text,
            "0.156.1"
        );
        assert_eq!(
            latest_version(br#"{"info":{"version":"1.28.0"}}"#, "info.version")
                .unwrap()
                .numbers,
            [1, 28, 0]
        );
        assert_eq!(
            latest_version(br#"{"versions":{"stable":"1.18.32"}}"#, "versions.stable")
                .unwrap()
                .text,
            "1.18.32"
        );
        for body in [
            br#"{"version":"1.2.3; rm"}"#.as_slice(),
            br#"{"version":"version 1.2.3"}"#,
            br#"{"version":"1.2.3-alpha"}"#,
        ] {
            assert!(latest_version(body, "version").is_none());
        }
        assert!(metadata_endpoint("https://arbitrary.test").is_none());
        assert_ne!(metadata_endpoint("codex"), metadata_endpoint("npm:codex"));
        assert_ne!(metadata_endpoint("kimi"), metadata_endpoint("kimi-python"));
        assert_ne!(
            metadata_endpoint("claude"),
            metadata_endpoint("claude:stable")
        );
    }

    #[test]
    fn checks_cache_for_six_hours_but_throttles_forced_checks_for_ten_seconds() {
        let cache = Cache {
            attempted: Some(Instant::now()),
            generation: 2,
            ..Default::default()
        };
        assert!(reusable(&cache, &[], false, 2));
        assert!(reusable(&cache, &[], true, 2));
        assert!(!reusable(&cache, &[], false, 3));
        // The ages are given, not measured: an instant that old cannot exist on a
        // machine that has been up for less than that.
        assert!(reusable_at(
            &cache,
            &[],
            false,
            2,
            Some(Duration::from_secs(11))
        ));
        assert!(!reusable_at(
            &cache,
            &[],
            true,
            2,
            Some(Duration::from_secs(11))
        ));
        assert!(reusable_at(
            &cache,
            &[],
            false,
            2,
            Some(Duration::from_secs(6 * 3600 - 1))
        ));
        assert!(!reusable_at(
            &cache,
            &[],
            false,
            2,
            Some(Duration::from_secs(6 * 3600))
        ));
        assert!(!reusable_at(&cache, &[], false, 2, None));
    }

    #[test]
    fn compares_numeric_versions_and_never_offers_a_downgrade() {
        let parse = |s| parse_version(s).unwrap();
        assert!(parse("1.10.0").at_least(&parse("1.9.99")));
        assert!(!parse("1.9.99").at_least(&parse("1.10.0")));
        assert!(parse("2.0.0").at_least(&parse("2.0.0-beta")));
        assert!(!parse("2.0.0-beta").at_least(&parse("2.0.0")));
    }

    #[cfg(unix)]
    #[test]
    fn shared_claude_launcher_merges_aliases_but_pinned_mimo_stays_separate() {
        let dir =
            std::env::temp_dir().join(format!("pandacode-update-groups-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let pinned = dir.join("2.1.280");
        let launcher = dir.join("claude");
        std::fs::write(&pinned, "fixture").unwrap();
        std::os::unix::fs::symlink(&pinned, &launcher).unwrap();
        let groups = group_installations(vec![
            ("claude".into(), "Claude Code".into(), launcher.clone()),
            ("glm".into(), "GLM".into(), launcher),
            ("mimo".into(), "MiMo".into(), pinned),
        ]);
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0].providers, ["claude", "glm"]);
        assert_eq!(groups[1].providers, ["mimo"]);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn every_harness_gets_an_update_row_and_unsupported_ones_stay_manual() {
        use std::os::unix::fs::PermissionsExt;
        let dir =
            std::env::temp_dir().join(format!("pandacode-update-all-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let found = PROVIDERS
            .iter()
            .map(|(id, name)| {
                let path = dir.join(id);
                std::fs::write(&path, "#!/bin/sh\necho 'agent 1.2.3'\n").unwrap();
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
                ((*id).into(), (*name).into(), path)
            })
            .collect();
        let groups = group_installations(found);
        let ids: Vec<_> = groups.iter().map(|group| group.provider.as_str()).collect();
        assert_eq!(ids, PROVIDERS.iter().map(|(id, _)| *id).collect::<Vec<_>>());
        for group in groups {
            let family = family(&group.provider).to_owned();
            if UPDATABLE.contains(&family.as_str()) || family == "antigravity" {
                continue;
            }
            let row = inspect(group).await.row;
            assert_eq!(row.status, "unsupported", "{}", row.provider);
            assert_eq!(
                row.installed_version.as_deref(),
                Some("1.2.3"),
                "{}",
                row.provider
            );
            assert!(row.message.is_some() && !row.can_update);
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    #[ignore = "Read-only official release requests and installed version probes; never installs updates"]
    async fn live_installed_agent_update_checks() {
        for checked in check(true).await.unwrap() {
            println!(
                "{} status={} method={} installed={} latest={}",
                checked.row.provider,
                checked.row.status,
                checked.row.method.as_deref().unwrap_or("manual"),
                checked
                    .row
                    .installed_version
                    .as_deref()
                    .unwrap_or("unknown"),
                checked.row.latest_version.as_deref().unwrap_or("unknown")
            );
            assert!(matches!(
                checked.row.status.as_str(),
                "current" | "available" | "unsupported" | "error"
            ));
        }
    }
}
