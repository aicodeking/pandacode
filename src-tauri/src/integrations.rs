//! Read-only installed Codex inventory. Configuration and credentials stay in Codex.
use crate::providers::{executable, ProcessGroup};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    process::Stdio,
    sync::OnceLock,
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    time::Instant,
};

const MAX_SERVERS: usize = 100;
const MAX_TOOLS: usize = 512;
const MAX_SKILLS: usize = 300;
const MAX_APPS: usize = 128;
const MAX_PAGES: usize = 4;

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub servers: Vec<Server>,
    pub skills: Vec<Skill>,
    pub apps: Vec<App>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Server {
    pub name: String,
    pub description: String,
    pub status: String,
    pub auth_status: String,
    pub tools: Vec<Tool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tool {
    pub name: String,
    pub description: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Skill {
    pub name: String,
    pub description: String,
    pub status: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct App {
    pub name: String,
    pub description: String,
    pub status: String,
}

#[derive(Clone, Copy)]
struct Limits {
    request: Duration,
    total: Duration,
    frame: usize,
    output: usize,
    frames: usize,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            request: Duration::from_secs(5),
            total: Duration::from_secs(20),
            frame: 2 * 1024 * 1024,
            output: 8 * 1024 * 1024,
            frames: 1024,
        }
    }
}

/// No thread, turn, tool execution, OAuth, configuration writes, or login requests.
pub async fn discover(cwd: PathBuf) -> Result<Catalog, String> {
    let _permit = discovery_limit()
        .try_acquire()
        .map_err(|_| "Integration discovery is already running".to_owned())?;
    let path = executable("codex").ok_or("Install Codex to inspect its configured integrations")?;
    let mut command = crate::providers::provider_command("codex", &path)?;
    command.arg("app-server");
    discover_process(command, &cwd, Limits::default()).await
}

pub(crate) async fn discover_skills(cwd: &Path) -> Result<Value, String> {
    let _permit = discovery_limit()
        .try_acquire()
        .map_err(|_| "Integration discovery is already running".to_owned())?;
    let path = executable("codex").ok_or("Install Codex to inspect its skills")?;
    let mut command = crate::providers::provider_command("codex", &path)?;
    command.arg("app-server");
    discover_skills_process(
        command,
        cwd,
        Limits {
            total: Duration::from_secs(8),
            request: Duration::from_secs(4),
            ..Limits::default()
        },
    )
    .await
}

fn discovery_limit() -> &'static tokio::sync::Semaphore {
    static DISCOVERY: OnceLock<tokio::sync::Semaphore> = OnceLock::new();
    DISCOVERY.get_or_init(|| tokio::sync::Semaphore::new(1))
}

/// Native-only transport for typed command operations. Callers must expose a
/// closed command enum, never a frontend-provided JSON-RPC method or parameters.
pub(crate) struct ControlClient {
    rpc: Rpc,
    process: Process,
    deadline: Instant,
    _permit: tokio::sync::SemaphorePermit<'static>,
}

impl ControlClient {
    pub(crate) async fn start(cwd: &Path) -> Result<Self, String> {
        Self::start_configured(cwd, false, &[]).await
    }

    /// Like `start`, with a named connection's variables (such as `CODEX_HOME`).
    pub(crate) async fn start_with_env(cwd: &Path, env: &[(String, String)]) -> Result<Self, String> {
        Self::start_configured(cwd, false, env).await
    }

    pub(crate) async fn start_with_goals(cwd: &Path) -> Result<Self, String> {
        Self::start_configured(cwd, true, &[]).await
    }

    async fn start_configured(cwd: &Path, goals: bool, env: &[(String, String)]) -> Result<Self, String> {
        let permit = discovery_limit()
            .try_acquire()
            .map_err(|_| "Codex command discovery is busy. Try again in a moment.".to_owned())?;
        let path = executable("codex").ok_or("Install Codex to use this command")?;
        let mut command = crate::providers::provider_command("codex", &path)?;
        command.arg("app-server").envs(env.iter().map(|(k, v)| (k, v)));
        if goals {
            command.args(["--enable", "goals"]);
        }
        let limits = Limits {
            request: Duration::from_secs(10),
            total: Duration::from_secs(30),
            ..Limits::default()
        };
        let (process, mut rpc) = start_process(command, cwd, limits)?;
        let deadline = Instant::now() + limits.total;
        initialize(&mut rpc, deadline).await?;
        Ok(Self {
            rpc,
            process,
            deadline,
            _permit: permit,
        })
    }

    pub(crate) async fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        self.rpc.request(method, params, self.deadline).await.map_err(|error| {
            match error {
                RpcError::Unsupported => "This installed Codex version does not support the requested operation.".into(),
                RpcError::Failed => "Codex rejected the operation. Check the account or project configuration and retry.".into(),
                RpcError::Timeout => "Codex did not finish the operation before the timeout. Refresh its state before retrying a change.".into(),
                _ => "Codex returned an incomplete response. Refresh its state before retrying a change.".into(),
            }
        })
    }

    pub(crate) async fn finish(mut self) {
        self.process.finish().await;
    }
}

// The guard owns both the process group and a child waiter. Cancelling the
// discovery future therefore kills descendants and still reaps the direct child.
struct Process {
    child: Option<Child>,
    group: Option<ProcessGroup>,
}
impl Process {
    async fn finish(&mut self) {
        self.group.take();
        if let Some(child) = self.child.as_mut() {
            let _ = child.start_kill();
            if tokio::time::timeout(Duration::from_secs(1), child.wait())
                .await
                .is_ok()
            {
                self.child.take();
            }
        }
    }
}
impl Drop for Process {
    fn drop(&mut self) {
        self.group.take();
        if let Some(mut child) = self.child.take() {
            let _ = child.start_kill();
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                runtime.spawn(async move {
                    let _ = child.wait().await;
                });
            }
            // Tokio's kill_on_drop also covers destruction outside a live runtime.
        }
    }
}

async fn discover_process(command: Command, cwd: &Path, limits: Limits) -> Result<Catalog, String> {
    let (mut process, mut rpc) = start_process(command, cwd, limits)?;
    let result = inventory(&mut rpc, cwd).await;
    drop(rpc);
    process.finish().await;
    result
}

fn start_process(
    mut command: Command,
    cwd: &Path,
    limits: Limits,
) -> Result<(Process, Rpc), String> {
    if !cwd.is_dir() {
        return Err("Choose an existing project folder to inspect integrations".into());
    }
    command
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    let child = command
        .spawn()
        .map_err(|_| "Could not start the installed Codex integration service".to_owned())?;
    let mut process = Process {
        group: Some(ProcessGroup::register(child.id())),
        child: Some(child),
    };
    let child = process.child.as_mut().unwrap();
    let stdin = child
        .stdin
        .take()
        .ok_or("Codex integration input is unavailable")?;
    let stdout = child
        .stdout
        .take()
        .ok_or("Codex integration output is unavailable")?;
    let rpc = Rpc {
        stdin,
        stdout: BufReader::new(stdout),
        pending: Vec::new(),
        bytes: 0,
        frames: 0,
        id: 0,
        limits,
    };
    Ok((process, rpc))
}

async fn discover_skills_process(
    command: Command,
    cwd: &Path,
    limits: Limits,
) -> Result<Value, String> {
    let (mut process, mut rpc) = start_process(command, cwd, limits)?;
    let result = async {
        let deadline = Instant::now() + limits.total;
        initialize(&mut rpc, deadline).await?;
        rpc.request(
            "skills/list",
            json!({"cwds":[cwd],"forceReload":true}),
            deadline,
        )
        .await
        .map_err(|error| error.warning("Codex skills"))
    }
    .await;
    drop(rpc);
    process.finish().await;
    result
}

#[derive(Debug)]
enum RpcError {
    Unsupported,
    Failed,
    Timeout,
    Invalid,
    OutputLimit,
    Closed,
}
impl RpcError {
    fn warning(&self, section: &str) -> String {
        let explanation = match self {
            Self::Unsupported => "is not supported by this installed Codex version",
            Self::Failed => "could not be loaded; check its configuration in Codex",
            Self::Timeout => "did not respond before the discovery timeout",
            Self::Invalid => "returned an invalid inventory response",
            Self::OutputLimit => "exceeded the inventory output limit",
            Self::Closed => "became unavailable while reading its inventory",
        };
        format!("{section} {explanation}.")
    }
}

struct Rpc {
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    // Kept across request timeouts so a late partial frame cannot corrupt the next response.
    pending: Vec<u8>,
    bytes: usize,
    frames: usize,
    id: u64,
    limits: Limits,
}
impl Rpc {
    async fn send(&mut self, message: &Value) -> Result<(), RpcError> {
        let mut bytes = serde_json::to_vec(message).map_err(|_| RpcError::Invalid)?;
        bytes.push(b'\n');
        self.stdin
            .write_all(&bytes)
            .await
            .map_err(|_| RpcError::Closed)
    }

    async fn read(&mut self) -> Result<Value, RpcError> {
        loop {
            let available = self.stdout.fill_buf().await.map_err(|_| RpcError::Closed)?;
            if available.is_empty() {
                return Err(RpcError::Closed);
            }
            let end = available.iter().position(|byte| *byte == b'\n');
            let consumed = end.map_or(available.len(), |index| index + 1);
            self.bytes += consumed;
            if self.bytes > self.limits.output || self.pending.len() + consumed > self.limits.frame
            {
                return Err(RpcError::OutputLimit);
            }
            self.pending.extend_from_slice(&available[..consumed]);
            self.stdout.consume(consumed);
            if end.is_none() {
                continue;
            }
            self.frames += 1;
            if self.frames > self.limits.frames {
                return Err(RpcError::OutputLimit);
            }
            if self.pending.iter().all(u8::is_ascii_whitespace) {
                self.pending.clear();
                continue;
            }
            let parsed = serde_json::from_slice(&self.pending).map_err(|_| RpcError::Invalid);
            self.pending.clear();
            return parsed;
        }
    }

    async fn request(
        &mut self,
        method: &str,
        params: Value,
        deadline: Instant,
    ) -> Result<Value, RpcError> {
        if Instant::now() >= deadline {
            return Err(RpcError::Timeout);
        }
        self.id += 1;
        let id = self.id;
        let deadline = deadline.min(Instant::now() + self.limits.request);
        tokio::time::timeout_at(deadline, async {
            self.send(&json!({"id":id,"method":method,"params":params})).await?;
            loop {
                let mut message = self.read().await?;
                if message.get("method").is_some() {
                    if let Some(request_id) = message.get("id").filter(|id| id.is_string() || id.is_number()) {
                        // A read-only inventory client must never approve or authenticate a reverse request.
                        self.send(&json!({"id":request_id,"error":{"code":-32601,"message":"This read-only inventory client does not handle server requests"}})).await?;
                    }
                    continue;
                }
                if message["id"].as_u64() != Some(id) { continue; }
                if let Some(error) = message.get("error") {
                    return Err(if matches!(error["code"].as_i64(), Some(-32601 | -32602)) { RpcError::Unsupported } else { RpcError::Failed });
                }
                return message.get_mut("result").map(Value::take).filter(Value::is_object).ok_or(RpcError::Invalid);
            }
        }).await.unwrap_or(Err(RpcError::Timeout))
    }
}

async fn initialize(rpc: &mut Rpc, deadline: Instant) -> Result<(), String> {
    rpc.request("initialize", json!({"clientInfo":{"name":"pandacode","title":"PandaCode","version":env!("CARGO_PKG_VERSION")},"capabilities":{"experimentalApi":true,"requestAttestation":false}}), deadline)
        .await.map_err(|error| error.warning("Codex integration discovery"))?;
    tokio::time::timeout_at(
        deadline,
        rpc.send(&json!({"method":"initialized","params":{}})),
    )
    .await
    .map_err(|_| RpcError::Timeout.warning("Codex integration discovery"))?
    .map_err(|error| error.warning("Codex integration discovery"))?;
    Ok(())
}

async fn inventory(rpc: &mut Rpc, cwd: &Path) -> Result<Catalog, String> {
    let deadline = Instant::now() + rpc.limits.total;
    initialize(rpc, deadline).await?;
    let mut catalog = Catalog::default();
    let mut cursor: Option<String> = None;
    let mut cursors = HashSet::new();
    // Leave time for skills and apps even if an MCP server is slow to initialize.
    let mcp_deadline = deadline.min(Instant::now() + rpc.limits.request);
    for page in 0..MAX_PAGES {
        let response = rpc
            .request(
                "mcpServerStatus/list",
                json!({"cursor":cursor,"limit":50,"detail":"toolsAndAuthOnly"}),
                mcp_deadline,
            )
            .await;
        let result = match response {
            Ok(result) => result,
            Err(error) => {
                warn(&mut catalog, error.warning("MCP servers"));
                break;
            }
        };
        if let Err(error) = append_servers(&mut catalog, &result) {
            warn(&mut catalog, error.warning("MCP servers"));
            break;
        }
        let next = match result.get("nextCursor") {
            None | Some(Value::Null) => break,
            Some(Value::String(value)) if !value.is_empty() && value.len() <= 4096 => value.clone(),
            _ => {
                warn(
                    &mut catalog,
                    "MCP servers returned an invalid pagination cursor.".into(),
                );
                break;
            }
        };
        if page + 1 == MAX_PAGES
            || catalog.servers.len() == MAX_SERVERS
            || !cursors.insert(next.clone())
        {
            warn(
                &mut catalog,
                "MCP server inventory was limited; additional servers may be configured.".into(),
            );
            break;
        }
        cursor = Some(next);
    }
    match rpc
        .request(
            "skills/list",
            json!({"cwds":[cwd],"forceReload":false}),
            deadline,
        )
        .await
    {
        Ok(result) => {
            if let Err(error) = append_skills(&mut catalog, &result) {
                warn(&mut catalog, error.warning("Skills"));
            }
        }
        Err(error) => warn(&mut catalog, error.warning("Skills")),
    }
    match rpc
        .request("app/installed", json!({"forceRefresh":false}), deadline)
        .await
    {
        Ok(result) => {
            if let Err(error) = append_apps(&mut catalog, &result) {
                warn(&mut catalog, error.warning("Apps"));
            }
        }
        Err(error) => warn(&mut catalog, error.warning("Apps")),
    }
    Ok(catalog)
}

fn warn(catalog: &mut Catalog, warning: String) {
    if catalog.warnings.len() < 16 && !catalog.warnings.contains(&warning) {
        catalog.warnings.push(warning);
    }
}
fn text(value: Option<&str>, limit: usize) -> String {
    value
        .unwrap_or_default()
        .chars()
        .filter(|character| !character.is_control())
        .take(limit)
        .collect::<String>()
        .trim()
        .to_owned()
}
fn name(value: &Value) -> String {
    text(value["name"].as_str(), 160)
}

fn append_servers(catalog: &mut Catalog, result: &Value) -> Result<(), RpcError> {
    let entries = result["data"].as_array().ok_or(RpcError::Invalid)?;
    let mut remaining_tools = MAX_TOOLS.saturating_sub(
        catalog
            .servers
            .iter()
            .map(|server| server.tools.len())
            .sum::<usize>(),
    );
    for entry in entries {
        if catalog.servers.len() == MAX_SERVERS {
            warn(
                catalog,
                "MCP server inventory was limited; additional servers may be configured.".into(),
            );
            break;
        }
        let server_name = name(entry);
        if server_name.is_empty()
            || catalog
                .servers
                .iter()
                .any(|server| server.name == server_name)
        {
            continue;
        }
        let mut tools = Vec::new();
        if let Some(entries) = entry["tools"].as_object() {
            for (key, tool) in entries {
                if remaining_tools == 0 {
                    warn(
                        catalog,
                        "Tool summaries were limited; additional tools may be available in Codex."
                            .into(),
                    );
                    break;
                }
                let tool_name = text(
                    tool["title"]
                        .as_str()
                        .or(tool["name"].as_str())
                        .or(Some(key)),
                    160,
                );
                if tool_name.is_empty() {
                    continue;
                }
                tools.push(Tool {
                    name: tool_name,
                    description: text(tool["description"].as_str(), 512),
                });
                remaining_tools -= 1;
            }
        }
        let status = match entry["runtimeStatus"].as_str() {
            Some(
                status @ ("notStarted"
                | "starting"
                | "connected"
                | "authenticationRequired"
                | "failed"
                | "cancelled"
                | "disabled"),
            ) => status,
            _ if entry["toolsError"].is_string() => "unavailable",
            _ => "unknown",
        };
        if entry["toolsError"].is_string() {
            warn(
                catalog,
                "Some MCP tool catalogs could not be loaded; check their configuration in Codex."
                    .into(),
            );
        }
        let auth_status = entry["authStatus"]
            .as_str()
            .filter(|status| {
                matches!(
                    *status,
                    "unknown" | "unsupported" | "notLoggedIn" | "bearerToken" | "oAuth"
                )
            })
            .unwrap_or("unknown");
        catalog.servers.push(Server {
            name: server_name,
            description: text(entry["serverInfo"]["description"].as_str(), 512),
            status: status.into(),
            auth_status: auth_status.into(),
            tools,
        });
    }
    Ok(())
}

fn append_skills(catalog: &mut Catalog, result: &Value) -> Result<(), RpcError> {
    let groups = result["data"].as_array().ok_or(RpcError::Invalid)?;
    for group in groups {
        if group["errors"]
            .as_array()
            .is_some_and(|errors| !errors.is_empty())
        {
            warn(
                catalog,
                "Some skills could not be loaded; check their definitions in Codex.".into(),
            );
        }
        let entries = group["skills"].as_array().ok_or(RpcError::Invalid)?;
        for entry in entries {
            if catalog.skills.len() == MAX_SKILLS {
                warn(
                    catalog,
                    "Skill inventory was limited; additional skills may be configured.".into(),
                );
                return Ok(());
            }
            let skill_name = text(
                entry["interface"]["displayName"]
                    .as_str()
                    .or(entry["name"].as_str()),
                160,
            );
            if skill_name.is_empty() || catalog.skills.iter().any(|skill| skill.name == skill_name)
            {
                continue;
            }
            catalog.skills.push(Skill {
                name: skill_name,
                description: text(
                    entry["interface"]["shortDescription"]
                        .as_str()
                        .or(entry["shortDescription"].as_str())
                        .or(entry["description"].as_str()),
                    512,
                ),
                status: match entry["enabled"].as_bool() {
                    Some(true) => "enabled",
                    Some(false) => "disabled",
                    None => "unknown",
                }
                .into(),
            });
        }
    }
    Ok(())
}

fn append_apps(catalog: &mut Catalog, result: &Value) -> Result<(), RpcError> {
    let entries = result["apps"].as_array().ok_or(RpcError::Invalid)?;
    for entry in entries {
        if catalog.apps.len() == MAX_APPS {
            warn(
                catalog,
                "App inventory was limited; additional apps may be installed.".into(),
            );
            break;
        }
        let app_name = text(entry["runtimeName"].as_str().or(entry["id"].as_str()), 160);
        if app_name.is_empty() || catalog.apps.iter().any(|app| app.name == app_name) {
            continue;
        }
        let (status, description) = match (entry["enabled"].as_bool(), entry["callable"].as_bool())
        {
            (Some(false), _) => ("disabled", "Disabled in the current Codex configuration."),
            (Some(true), Some(true)) => (
                "available",
                "Callable tools are available in the installed Codex runtime.",
            ),
            (Some(true), Some(false)) => (
                "unavailable",
                "Enabled, but no callable tools are exposed by the current configuration.",
            ),
            _ => ("unknown", "Availability was not reported by Codex."),
        };
        catalog.apps.push(App {
            name: app_name,
            description: description.into(),
            status: status.into(),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn projects_only_bounded_presentation_fields_and_drops_sensitive_metadata() {
        let mut catalog = Catalog::default();
        append_servers(&mut catalog, &json!({"data":[{"name":"docs", "runtimeStatus":"connected", "authStatus":"bearerToken", "serverInfo":{"description":"Read documentation", "websiteUrl":"SECRET"}, "tools":{"read":{"name":"read","description":"a".repeat(700),"inputSchema":{"secret":"SECRET"},"_meta":{"token":"SECRET"}}},"toolsError":null,"resources":[{"uri":"SECRET"}]}]})).unwrap();
        append_skills(&mut catalog, &json!({"data":[{"cwd":"SECRET", "skills":[{"name":"skill","path":"SECRET","enabled":true,"interface":{"displayName":"Skill title","shortDescription":"Short summary","defaultPrompt":"SECRET"}}],"errors":[{"path":"SECRET","message":"SECRET"}]}]})).unwrap();
        append_apps(&mut catalog, &json!({"apps":[{"id":"app-1","runtimeName":"Tasks","enabled":false,"callable":false,"token":"SECRET"}]})).unwrap();
        let serialized = serde_json::to_string(&catalog).unwrap();
        assert!(!serialized.contains("SECRET"));
        assert_eq!(catalog.servers[0].tools[0].description.len(), 512);
        assert_eq!(catalog.skills[0].name, "Skill title");
        assert_eq!(catalog.apps[0].status, "disabled");
        assert_eq!(catalog.warnings.len(), 1);
    }

    #[test]
    fn malformed_sections_do_not_erase_successful_sections_or_invent_availability() {
        let mut catalog = Catalog::default();
        append_apps(&mut catalog, &json!({"apps":[{"id":"a","enabled":true,"callable":false},{"id":"b","enabled":true,"callable":true},{"id":"c"}]})).unwrap();
        assert!(append_skills(&mut catalog, &json!({"data":{}})).is_err());
        assert_eq!(
            catalog
                .apps
                .iter()
                .map(|app| app.status.as_str())
                .collect::<Vec<_>>(),
            ["unavailable", "available", "unknown"]
        );
        assert_eq!(text(Some(" hello\u{0000}\nworld "), 160), "helloworld");
    }

    #[test]
    fn inventory_caps_entries_and_deduplicates_pages() {
        let mut catalog = Catalog::default();
        let skills: Vec<_> = (0..MAX_SKILLS + 10)
            .map(|index| json!({"name":format!("skill-{index}"),"enabled":true}))
            .collect();
        append_skills(&mut catalog, &json!({"data":[{"skills":skills}]})).unwrap();
        assert_eq!(catalog.skills.len(), MAX_SKILLS);
        let tools: serde_json::Map<_, _> = (0..MAX_TOOLS + 10)
            .map(|index| {
                (
                    format!("tool-{index}"),
                    json!({"name":format!("tool-{index}")}),
                )
            })
            .collect();
        let response = json!({"data":[{"name":"one","tools":tools},{"name":"two","tools":{"extra":{"name":"extra"}}}]});
        append_servers(&mut catalog, &response).unwrap();
        append_servers(&mut catalog, &response).unwrap();
        assert_eq!(catalog.servers.len(), 2);
        assert_eq!(
            catalog
                .servers
                .iter()
                .map(|server| server.tools.len())
                .sum::<usize>(),
            MAX_TOOLS
        );
        assert_eq!(catalog.warnings.len(), 2);
    }

    #[cfg(unix)]
    fn fake(script: &str) -> Command {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", script]);
        command
    }

    #[cfg(unix)]
    const INITIALIZE: &str = r#"
IFS= read -r request
case "$request" in *'"method":"initialize"'*'"experimentalApi":true'*|*'"experimentalApi":true'*'"method":"initialize"'*) ;; *) exit 1;; esac
printf '%s\n' '{"id":1,"result":{}}'
IFS= read -r request
case "$request" in *'"method":"initialized"'*) ;; *) exit 1;; esac
"#;

    #[cfg(unix)]
    #[tokio::test]
    async fn fake_stdio_discovers_pages_and_rejects_reverse_requests_without_running_a_turn() {
        let _serial = crate::providers::concurrent_process_tests::process_test_lock()
            .lock()
            .await;
        let script = format!(
            "{INITIALIZE}{}",
            r#"
IFS= read -r request
case "$request" in *'"method":"mcpServerStatus/list"'*'"detail":"toolsAndAuthOnly"'*) ;; *) exit 2;; esac
printf '%s\n' '{"id":"auth-check","method":"account/login/start","params":{}}'
IFS= read -r request
case "$request" in *'"code":-32601'*) ;; *) exit 3;; esac
printf '%s\n' '{"id":2,"result":{"data":[{"name":"first","tools":{},"authStatus":"unsupported"}],"nextCursor":"next"}}'
IFS= read -r request
case "$request" in *'"method":"mcpServerStatus/list"'*'"cursor":"next"'*) ;; *) exit 4;; esac
printf '%s\n' '{"id":3,"result":{"data":[{"name":"second","tools":{"find":{"name":"find","description":"Find a note"}},"authStatus":"oAuth"}],"nextCursor":null}}'
IFS= read -r request
case "$request" in *'"method":"skills/list"'*'"cwds":'*) ;; *) exit 5;; esac
printf '%s\n' '{"id":4,"result":{"data":[{"skills":[{"name":"planning","description":"Plan work","enabled":true}],"errors":[]}]}}'
IFS= read -r request
case "$request" in *'"method":"app/installed"'*'"forceRefresh":false'*) ;; *) exit 6;; esac
printf '%s\n' '{"id":5,"result":{"apps":[{"id":"app-id","runtimeName":"Calendar","enabled":true,"callable":true}]}}'
sleep 30
"#
        );
        let catalog = discover_process(fake(&script), &std::env::temp_dir(), Limits::default())
            .await
            .unwrap();
        assert_eq!(catalog.servers.len(), 2);
        assert_eq!(catalog.skills[0].name, "planning");
        assert_eq!(catalog.apps[0].name, "Calendar");
        assert!(catalog.warnings.is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn skill_discovery_refreshes_only_skills_and_preserves_native_binding_paths() {
        let _serial = crate::providers::concurrent_process_tests::process_test_lock()
            .lock()
            .await;
        let script = format!(
            "{INITIALIZE}{}",
            r#"
IFS= read -r request
case "$request" in *'"method":"skills/list"'*'"forceReload":true'*|*'"forceReload":true'*'"method":"skills/list"'*) ;; *) exit 2;; esac
printf '%s\n' '{"id":2,"result":{"data":[{"cwd":"/tmp","skills":[{"name":"fixture","path":"/tmp/fixture/SKILL.md","enabled":true}],"errors":[]}]}}'
sleep 30
"#
        );
        let response =
            discover_skills_process(fake(&script), &std::env::temp_dir(), Limits::default())
                .await
                .unwrap();
        assert_eq!(
            response["data"][0]["skills"][0]["path"],
            "/tmp/fixture/SKILL.md"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn fake_stdio_preserves_partial_results_and_never_exposes_rpc_error_details() {
        let _serial = crate::providers::concurrent_process_tests::process_test_lock()
            .lock()
            .await;
        let script = format!(
            "{INITIALIZE}{}",
            r#"
IFS= read -r request
printf '%s\n' '{"id":2,"error":{"code":-32601,"message":"SECRET credential details"}}'
IFS= read -r request
printf '%s\n' '{"id":3,"result":{"data":[{"skills":[{"name":"still-available","enabled":true}]}]}}'
IFS= read -r request
printf '%s\n' '{"id":4,"error":{"code":500,"message":"SECRET auth data"}}'
sleep 30
"#
        );
        let catalog = discover_process(fake(&script), &std::env::temp_dir(), Limits::default())
            .await
            .unwrap();
        assert_eq!(catalog.skills[0].name, "still-available");
        assert_eq!(catalog.warnings.len(), 2);
        assert!(catalog.warnings[0].contains("not supported"));
        assert!(!serde_json::to_string(&catalog).unwrap().contains("SECRET"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn fake_stdio_limits_oversized_frames_and_notification_floods() {
        let _serial = crate::providers::concurrent_process_tests::process_test_lock()
            .lock()
            .await;
        for (script, limits) in [
            (
                "IFS= read -r request; printf '%0800d' 1; sleep 30",
                Limits {
                    frame: 128,
                    ..Limits::default()
                },
            ),
            (
                "IFS= read -r request; while :; do printf '%s\\n' '{\"method\":\"notice\"}'; done",
                Limits {
                    frames: 8,
                    ..Limits::default()
                },
            ),
        ] {
            let error = discover_process(fake(script), &std::env::temp_dir(), limits)
                .await
                .unwrap_err();
            assert!(error.contains("output limit"), "{error}");
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn fake_stdio_timeout_and_cancellation_kill_and_reap_the_process_group() {
        let _serial = crate::providers::concurrent_process_tests::process_test_lock()
            .lock()
            .await;
        for cancelled in [false, true] {
            let file = std::env::temp_dir()
                .join(format!("pandacode-inventory-pid-{}", uuid::Uuid::new_v4()));
            let mut command = Command::new("/bin/sh");
            command
                .args([
                    "-c",
                    "sleep 30 & printf '%s %s' \"$$\" \"$!\" > \"$1\"; wait",
                    "pandacode-fixture",
                ])
                .arg(&file);
            let limits = Limits {
                request: Duration::from_millis(200),
                total: Duration::from_millis(250),
                ..Limits::default()
            };
            let task = tokio::spawn(async move {
                discover_process(command, &std::env::temp_dir(), limits).await
            });
            let pids = tokio::time::timeout(Duration::from_secs(2), async {
                loop {
                    if let Ok(text) = std::fs::read_to_string(&file) {
                        let pids: Vec<i32> = text
                            .split_whitespace()
                            .filter_map(|pid| pid.parse().ok())
                            .collect();
                        if pids.len() == 2 {
                            break pids;
                        }
                    }
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            })
            .await
            .unwrap();
            if cancelled {
                task.abort();
                assert!(task.await.unwrap_err().is_cancelled());
            } else {
                assert!(task.await.unwrap().unwrap_err().contains("timeout"));
            }
            tokio::time::timeout(Duration::from_secs(2), async {
                loop {
                    if pids.iter().all(|pid| unsafe { libc::kill(*pid, 0) } != 0) {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .expect("discovery left a child process running");
            let _ = std::fs::remove_file(file);
        }
    }
}
