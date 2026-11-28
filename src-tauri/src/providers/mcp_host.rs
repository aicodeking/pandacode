//! Short-lived, authenticated loopback MCP for team and opt-in browser tools.
//! No credentials or server definitions are written into the user's configuration.
use super::*;
use tokio::{
    net::{TcpListener, TcpStream},
    sync::Semaphore,
    task::JoinHandle,
};

const HEADER_LIMIT: usize = 8192;
const RESULT_LIMIT: usize = 128 * 1024;
const SERVER_NAME: &str = "pandacode_architect";
/// Versions this loopback server speaks. `2026-07-28` is the revision ZCode
/// probes for; the older two are what the other harnesses negotiate.
const MCP_VERSIONS: &[&str] = &["2026-07-28", "2025-06-18", "2025-03-26"];

pub(super) struct Server {
    authority: String,
    token: String,
    task: JoinHandle<()>,
    /// The turn this server serves. A warm agent's server starts with a placeholder and
    /// is rebound to the real turn when the agent is adopted (see `warm`).
    context: Arc<std::sync::RwLock<Arc<Context>>>,
}
impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Server {
    pub(super) async fn start_for_run(
        host: ToolHost,
        session_id: String,
        sink: Sink,
        mode: &str,
    ) -> Result<Option<Self>, String> {
        let required = host.tools.iter().any(|tool| !optional_transport_tool(tool["name"].as_str().unwrap_or_default()));
        match Self::start_with_approvals(host, session_id, sink, mode).await {
            Ok(server) => Ok(Some(server)),
            Err(_) if !required => Ok(None),
            Err(error) => Err(error),
        }
    }

    pub(super) fn required(&self) -> bool {
        self.current().host.tools.iter().any(|tool| !optional_transport_tool(tool["name"].as_str().unwrap_or_default()))
    }
    fn current(&self) -> Arc<Context> {
        current(&self.context)
    }
    /// Serve a new turn at the same address and token, which the agent already knows.
    pub(super) fn rebind(&self, host: ToolHost, session_id: String, sink: Sink, mode: &str) -> Result<(), String> {
        host_tools::HostTools::new(host.clone())?;
        let previous = self.current();
        let next = Arc::new(Context::new(previous.authority.clone(), previous.authorization.clone(), host, session_id, sink, mode));
        *self.context.write().map_err(|_| "Agent tools are unavailable".to_string())? = next;
        Ok(())
    }
    #[cfg(test)]
    pub(super) async fn start(
        host: ToolHost,
        session_id: String,
        sink: Sink,
    ) -> Result<Self, String> {
        // Legacy fixtures intentionally exercise only the unprotected team catalog.
        // Production callers use start_with_approvals for protected callbacks.
        if !host.approval_tools.is_empty() {
            return Err("Protected app tools cannot use the architect MCP transport".into());
        }
        Self::start_with_approvals(host, session_id, sink, "ask").await
    }
    pub(super) async fn start_with_approvals(
        host: ToolHost,
        session_id: String,
        sink: Sink,
        mode: &str,
    ) -> Result<Self, String> {
        host_tools::HostTools::new(host.clone())?;
        if host.tools.iter().any(|tool| tool["type"] != "function") {
            return Err("Architect MCP tools must be individual functions".into());
        }
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .map_err(|_| "Could not open the local architect tools connection".to_string())?;
        let authority = listener
            .local_addr()
            .map_err(|e| e.to_string())?
            .to_string();
        let token = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        let context = Arc::new(std::sync::RwLock::new(Arc::new(Context::new(authority.clone(), format!("Bearer {token}"), host, session_id, sink, mode))));
        let server_context = context.clone();
        let task = tokio::spawn(async move {
            let mut clients = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    result = listener.accept() => {
                        // No connection cap: every subagent of a run may sit in a slow or approval-gated
                        // call here at once. Running out of descriptors passes, so it never ends the server.
                        let Ok((mut stream, peer)) = result else {
                            tokio::time::sleep(Duration::from_millis(100)).await;
                            continue;
                        };
                        if !peer.ip().is_loopback() { continue; }
                        let context = current(&context);
                        clients.spawn(async move {
                            let response = match tokio::time::timeout(Duration::from_secs(5), read_request(&mut stream, &context)).await {
                                // A client that gives up on a call (its own timeout) closes the
                                // connection: the call ends here too, so its pending approval
                                // expires and a late Approve runs nothing.
                                Ok(Ok(body)) => tokio::select! {
                                    response = context.respond(body) => response,
                                    () = closed(&stream) => return,
                                },
                                Ok(Err(status)) => HttpResponse::empty(status),
                                Err(_) => HttpResponse::empty(408),
                            };
                            let _ = tokio::time::timeout(Duration::from_secs(2), response.write(&mut stream)).await;
                        });
                    },
                    _ = clients.join_next(), if !clients.is_empty() => {},
                }
            }
            // Dropping the JoinSet cancels pending callbacks as well as readers.
        });
        Ok(Self {
            authority,
            token,
            task,
            context: server_context,
        })
    }
    pub(super) fn claude_config(&self) -> Value {
        json!({"mcpServers":{SERVER_NAME:{"type":"http","url":format!("http://{}/mcp",self.authority),"headers":{"Authorization":format!("Bearer {}",self.token)}}}})
    }
    pub(super) fn pi_config(&self) -> Value {
        json!({"url":format!("http://{}/mcp",self.authority),"authorization":format!("Bearer {}",self.token)})
    }
    pub(super) fn kimi_config(&self) -> Value {
        json!({"type":"http","name":SERVER_NAME,"url":format!("http://{}/mcp",self.authority),"headers":[{"name":"Authorization","value":format!("Bearer {}",self.token)}]})
    }
    pub(super) fn codex_config(&self) -> Value {
        json!({SERVER_NAME:{"url":format!("http://{}/mcp",self.authority),"http_headers":{"Authorization":format!("Bearer {}",self.token)},"enabled":true,"required":self.required(),"startup_timeout_sec":if self.required() {15} else {3},"tool_timeout_sec":360}})
    }
    /// ZCode's `session/create` `mcpServers` entry. Session isolation keeps the
    /// per-run bridge out of the user's server registry, and `alwaysLoad` is
    /// what lifts the tools into the model's list — ZCode defers every
    /// MCP tool it does not always load behind its tool search.
    pub(super) fn zcode_config(&self) -> Value {
        json!({"type":"http","name":SERVER_NAME,"url":format!("http://{}/mcp",self.authority),
            "headers":[{"name":"Authorization","value":format!("Bearer {}",self.token)}],
            "isolation":"session","alwaysLoad":true})
    }
    pub(super) fn redact(&self, text: &str) -> String {
        text.replace(&self.token, "[redacted]")
    }
}

/// Name of Google's browser-notebook MCP server in every harness's server list.
pub(super) const COLAB_MCP: &str = "colab-mcp";
/// How long Codex waits for a stdio server to start: a first `uvx` run fetches and builds it.
const STDIO_STARTUP_SECS: u64 = 90;

/// An extra stdio MCP server one run launches beside `pandacode_architect`.
/// Only ever passed on the harness's command line or in a private temp file,
/// never written into the user's own configuration.
#[derive(Clone, Debug, PartialEq)]
pub(super) struct Stdio {
    pub(super) name: String,
    pub(super) command: String,
    pub(super) args: Vec<String>,
}

impl Stdio {
    pub(super) fn new(name: &str, command: String, args: Vec<String>) -> Self {
        Self { name: name.into(), command, args }
    }
    fn claude_entry(&self) -> Value {
        json!({"command": self.command, "args": self.args})
    }
    fn codex_entry(&self) -> Value {
        json!({"command": self.command, "args": self.args, "enabled": true, "required": false,
            "startup_timeout_sec": STDIO_STARTUP_SECS, "tool_timeout_sec": 300})
    }
    /// ACP `McpServerStdio`: stdio is the baseline transport, so it needs no capability.
    fn acp_entry(&self) -> Value {
        json!({"name": self.name, "command": self.command, "args": self.args, "env": []})
    }
    /// ZCode's entry: the ACP one scoped to this session and loaded up front, like the bridge
    /// (`Server::zcode_config`), so its tools reach the model.
    pub(super) fn zcode_entry(&self) -> Value {
        zcode_scoped(self.acp_entry())
    }
    pub(super) fn cline_entry(&self) -> Value {
        json!({"command": self.command, "args": self.args, "disabled": false})
    }
}

/// Marks an `mcpServers` entry for ZCode: session isolation and always-load.
pub(super) fn zcode_scoped(mut entry: Value) -> Value {
    if entry.is_object() {
        entry["isolation"] = json!("session");
        entry["alwaysLoad"] = json!(true);
    }
    entry
}

/// This run's extra stdio servers: Colab's MCP when the user turned it on, for local runs
/// of the user's own tasks only. A cloud run's harness lives on another machine, and a
/// managed team worker keeps to the tools its lead gave it.
pub(super) fn stdio_servers(session_id: &str) -> Vec<Stdio> {
    if crate::cloud_agents::transport::is_cloud(session_id) || crate::providers::is_worker_run(session_id) {
        return Vec::new();
    }
    crate::cloud::colab::colab_mcp_command()
        .map(|(command, args)| Stdio::new(COLAB_MCP, command, args))
        .into_iter()
        .collect()
}

/// `--mcp-config` for Claude-family CLIs: the bridge's config with the stdio servers
/// added to `mcpServers`. Without extras the bridge's config is returned untouched.
pub(super) fn claude_mcp_config(bridge: Option<Value>, extra: &[Stdio]) -> Option<Value> {
    if extra.is_empty() {
        return bridge;
    }
    let mut config = bridge.filter(|config| config["mcpServers"].is_object()).unwrap_or_else(|| json!({"mcpServers":{}}));
    for server in extra {
        config["mcpServers"][&server.name] = server.claude_entry();
    }
    Some(config)
}

/// Codex `mcp_servers.<name>` overrides: the bridge's plus the stdio servers.
pub(super) fn codex_mcp_servers(bridge: Option<Value>, extra: &[Stdio]) -> Option<Value> {
    if extra.is_empty() {
        return bridge;
    }
    let mut servers = bridge.filter(Value::is_object).unwrap_or_else(|| json!({}));
    for server in extra {
        servers[&server.name] = server.codex_entry();
    }
    Some(servers)
}

/// ACP `mcpServers` entries that ride beside the bridge's HTTP entry.
pub(super) fn acp_mcp_servers(extra: &[Stdio]) -> Vec<Value> {
    extra.iter().map(Stdio::acp_entry).collect()
}

/// ZCode `mcpServers` entries that ride beside the bridge's (`Stdio::zcode_entry`).
pub(super) fn zcode_mcp_servers(extra: &[Stdio]) -> Vec<Value> {
    extra.iter().map(Stdio::zcode_entry).collect()
}

impl Server {
    pub(super) fn stop(&self) {
        self.task.abort();
    }
    pub(super) fn approve(&self, id: &str, approved: bool) -> bool {
        let reply = self
            .current()
            .approvals
            .lock()
            .ok()
            .and_then(|mut pending| pending.remove(id));
        if let Some(reply) = reply {
            let _ = reply.send(approved);
            true
        } else {
            false
        }
    }
}

/// One `tools/list` entry. The hints live here, not in the catalog, because the catalog is part
/// of the warm-agent key: `alwaysLoad` keeps Claude Code from spending a ToolSearch step on a tool
/// used in most turns (explore, change tracking and the title, which rides beside another call), and `readOnlyHint` tells harnesses that read annotations not to ask.
fn listing(spec: &Value) -> Value {
    let mut tool = json!({"name":spec["name"],"description":spec["description"],"inputSchema":spec["inputSchema"]});
    let name = spec["name"].as_str().unwrap_or_default();
    if name == EXPLORE_TOOL || name == crate::turn_changes::TRACK_TOOL || name == crate::session_titles::TOOL {
        tool["_meta"] = json!({"anthropic/alwaysLoad":true});
    }
    if name == EXPLORE_TOOL {
        tool["annotations"] = json!({"readOnlyHint":true});
    }
    tool
}

fn current(context: &std::sync::RwLock<Arc<Context>>) -> Arc<Context> {
    match context.read() {
        Ok(context) => context.clone(),
        Err(poisoned) => poisoned.into_inner().clone(),
    }
}

/// How long a call waits for one of the running slots.
const SLOT_WAIT: Duration = if cfg!(test) { Duration::from_millis(200) } else { Duration::from_secs(30) };

struct Context {
    authority: String,
    authorization: String,
    host: ToolHost,
    session_id: String,
    sink: Sink,
    calls: Semaphore,
    active: Mutex<HashMap<String, Arc<tokio::sync::Notify>>>,
    mode: String,
    approvals: Mutex<HashMap<String, tokio::sync::oneshot::Sender<bool>>>,
}

impl Context {
    fn new(authority: String, authorization: String, host: ToolHost, session_id: String, sink: Sink, mode: &str) -> Self {
        Self {
            authority,
            authorization,
            host,
            session_id,
            sink,
            calls: Semaphore::new(host_tools::MAX_CALLS),
            active: Mutex::new(HashMap::new()),
            mode: mode.into(),
            approvals: Mutex::new(HashMap::new()),
        }
    }
}

struct PendingApproval<'a> {
    context: &'a Context,
    id: String,
}
impl Drop for PendingApproval<'_> {
    fn drop(&mut self) {
        // Approved snapshots have moved on already; anything left was never approved.
        crate::custom_tools::approval::forget(&self.id);
        if let Ok(mut pending) = self.context.approvals.lock() {
            pending.remove(&self.id);
        }
        (self.context.sink)(AgentEvent {
            session_id: self.context.session_id.clone(),
            kind: "approval_cancelled".into(),
            text: String::new(),
            request_id: Some(self.id.clone()),
            data: None,
            tool: None,
        });
    }
}
struct ActiveRequest<'a> {
    active: &'a Mutex<HashMap<String, Arc<tokio::sync::Notify>>>,
    key: String,
}
impl Drop for ActiveRequest<'_> {
    fn drop(&mut self) {
        if let Ok(mut active) = self.active.lock() {
            active.remove(&self.key);
        }
    }
}
struct HttpResponse {
    status: u16,
    body: Vec<u8>,
}
impl HttpResponse {
    fn empty(status: u16) -> Self {
        Self {
            status,
            body: Vec::new(),
        }
    }
    fn json(body: Value) -> Self {
        Self {
            status: 200,
            body: serde_json::to_vec(&body).unwrap_or_default(),
        }
    }
    fn error(id: Value, code: i32, message: &str) -> Self {
        Self::json(json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}}))
    }
    async fn write(self, stream: &mut TcpStream) -> std::io::Result<()> {
        let reason = match self.status {
            200 => "OK",
            202 => "Accepted",
            400 => "Bad Request",
            401 => "Unauthorized",
            403 => "Forbidden",
            405 => "Method Not Allowed",
            408 => "Request Timeout",
            413 => "Payload Too Large",
            429 => "Too Many Requests",
            _ => "Error",
        };
        let header = format!("HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n", self.status, reason, self.body.len());
        stream.write_all(header.as_bytes()).await?;
        stream.write_all(&self.body).await?;
        stream.shutdown().await
    }
}

/// Returns once the client closes the connection (or it fails). It only peeks, so bytes the
/// client sends during a call stay in the socket. EOF can't be seen past unread bytes, so a
/// client that sends some stops being watched and the call ends on its own limits.
async fn closed(stream: &TcpStream) {
    let mut byte = [0; 1];
    if matches!(stream.peek(&mut byte).await, Ok(1..)) {
        std::future::pending::<()>().await;
    }
}

async fn read_request(stream: &mut TcpStream, context: &Context) -> Result<Vec<u8>, u16> {
    let mut bytes = Vec::with_capacity(4096);
    let header_end;
    loop {
        if let Some(index) = bytes.windows(4).position(|s| s == b"\r\n\r\n") {
            header_end = index + 4;
            if header_end > HEADER_LIMIT {
                return Err(413);
            }
            break;
        }
        if bytes.len() >= HEADER_LIMIT {
            return Err(413);
        }
        let mut chunk = [0; 2048];
        let count = stream.read(&mut chunk).await.map_err(|_| 400u16)?;
        if count == 0 {
            return Err(400);
        }
        bytes.extend_from_slice(&chunk[..count]);
    }
    let header = std::str::from_utf8(&bytes[..header_end]).map_err(|_| 400u16)?;
    let mut lines = header.split("\r\n");
    let request = lines.next().ok_or(400u16)?;
    let mut fields = request.split(' ');
    let method = fields.next().unwrap_or_default();
    if fields.next() != Some("/mcp") || fields.next() != Some("HTTP/1.1") || fields.next().is_some()
    {
        return Err(400);
    }
    let mut headers = HashMap::new();
    for line in lines.filter(|line| !line.is_empty()) {
        let (name, value) = line.split_once(':').ok_or(400u16)?;
        if name.is_empty() || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
            return Err(400);
        }
        if headers
            .insert(name.to_ascii_lowercase(), value.trim())
            .is_some()
        {
            return Err(400);
        }
    }
    if headers.contains_key("origin") || headers.get("host") != Some(&context.authority.as_str()) {
        return Err(403);
    }
    if headers.get("authorization") != Some(&context.authorization.as_str()) {
        return Err(401);
    }
    // A browser cannot send this authenticated JSON POST without a preflight,
    // which is rejected. DNS rebinding cannot match the literal loopback Host.
    if method != "POST" {
        return Err(405);
    }
    if headers
        .get("mcp-protocol-version")
        .is_some_and(|version| !MCP_VERSIONS.contains(version))
    {
        return Err(400);
    }
    if headers.contains_key("transfer-encoding") || headers.contains_key("expect") {
        return Err(400);
    }
    if headers.get("content-type").is_none_or(|value| {
        value.split(';').next().unwrap_or_default().trim() != "application/json"
    }) {
        return Err(400);
    }
    let length = headers
        .get("content-length")
        .ok_or(400u16)?
        .parse::<usize>()
        .map_err(|_| 400u16)?;
    if length > host_tools::REQUEST_LIMIT {
        return Err(413);
    }
    let expected = header_end + length;
    if bytes.len() > expected {
        return Err(400);
    }
    let received = bytes.len();
    bytes.resize(expected, 0);
    // Read only the remaining frame. One request per connection prevents HTTP
    // pipelining/request-smuggling ambiguity and bounds every allocation.
    stream
        .read_exact(&mut bytes[received..])
        .await
        .map_err(|_| 400u16)?;
    Ok(bytes[header_end..].to_vec())
}

impl Context {
    async fn respond(&self, bytes: Vec<u8>) -> HttpResponse {
        let request: Value = match serde_json::from_slice(&bytes) {
            Ok(request) => request,
            Err(_) => return HttpResponse::error(Value::Null, -32700, "Invalid JSON"),
        };
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        if request.is_object()
            && request["jsonrpc"] == "2.0"
            && request.get("method").is_none()
            && (request.get("result").is_some() || request.get("error").is_some())
        {
            return HttpResponse::empty(202);
        }
        if !request.is_object() || request["jsonrpc"] != "2.0" || !request["method"].is_string() {
            return HttpResponse::error(Value::Null, -32600, "Invalid JSON-RPC request");
        }
        if request.get("id").is_none() {
            if request["method"] == "notifications/cancelled" {
                if let Ok(active) = self.active.lock() {
                    if let Some(cancel) = active.get(&request["params"]["requestId"].to_string()) {
                        cancel.notify_one();
                    }
                }
            }
            // Notifications never invoke tool handlers.
            return HttpResponse::empty(202);
        }
        if !matches!(&id,Value::String(s) if !s.is_empty() && s.len()<=256)
            && !id.is_i64()
            && !id.is_u64()
        {
            return HttpResponse::error(Value::Null, -32600, "Invalid request ID");
        }
        let result = match request["method"].as_str().unwrap() {
            "initialize" => {
                let version = request["params"]["protocolVersion"]
                    .as_str()
                    .filter(|version| MCP_VERSIONS.contains(version))
                    .unwrap_or("2025-03-26");
                json!({"protocolVersion":version,"capabilities":{"tools":{"listChanged":false}},"serverInfo":{"name":"PandaCode architect","version":"0.1.0"}})
            }
            // ZCode (2026-07-28 revision) probes every HTTP server with
            // `server/discover` and drops the ones that cannot name a version it
            // speaks; it never falls back to `initialize` for them. The cache
            // hints are part of that revision's discover result: ttl 0 is
            // immediately stale, and private keeps the answer on this bearer.
            "server/discover" => {
                json!({"resultType":"complete","ttlMs":0,"cacheScope":"private",
                       "supportedVersions":MCP_VERSIONS,
                       "capabilities":{"tools":{"listChanged":false}},
                       "serverInfo":{"name":"PandaCode architect","version":"0.1.0"}})
            }
            "ping" => json!({}),
            // Results carry the revision's wire fields unconditionally: modern
            // clients reject a `tools/list` or `tools/call` without
            // `resultType` outright, and legacy SDKs ignore the extra keys.
            // `ttlMs: 0` means immediately stale, so a client must not replay a
            // host-tool call from cache. Each tool is name, description and
            // input schema from this run's catalog — nothing else.
            "tools/list" => {
                let tools:Vec<Value> = self.host.tools.iter().map(listing).collect();
                json!({"resultType":"complete","ttlMs":0,"cacheScope":"private","tools":tools})
            }
            "tools/call" => {
                let name = request["params"]["name"].as_str().unwrap_or_default();
                if !self.host.tools.iter().any(|spec| spec["name"] == name) {
                    return HttpResponse::error(id, -32602, "Unknown architect tool");
                }
                let args = request["params"]
                    .get("arguments")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                if !args.is_object() {
                    return HttpResponse::error(id, -32602, "Tool arguments must be an object");
                }
                let key = id.to_string();
                let cancel = Arc::new(tokio::sync::Notify::new());
                {
                    let Ok(mut active) = self.active.lock() else {
                        return HttpResponse::error(id, -32603, "Architect tools unavailable");
                    };
                    if active.contains_key(&key) {
                        return HttpResponse::error(id, -32600, "Duplicate active request ID");
                    }
                    active.insert(key.clone(), cancel.clone());
                }
                let _active = ActiveRequest {
                    active: &self.active,
                    key,
                };
                let call_id = format!("mcp-host:{}", uuid::Uuid::new_v4());
                let input = preview_json(&args, TOOL_INPUT_LIMIT);
                self.activity(&call_id, name, "running", &input, "");
                // Keep the handler inside the timeout and select so either can drop it.
                // A saved tool's drop guard signals its shell runner, which owns the reap.
                let result = tokio::select! {
                    result = async {
                        let args = self.authorize(name, args).await?;
                        // Models often read several workers at once: wait briefly for a slot,
                        // which a call waiting on the user's approval does not take up.
                        let Ok(Ok(_permit)) = tokio::time::timeout(SLOT_WAIT, self.calls.acquire()).await else {
                            return Err("Too many PandaCode tools are running at once; retry this call in a moment.".to_string());
                        };
                        let limit = host_tools::tool_timeout(name, &args);
                        tokio::time::timeout(limit,(self.host.handler)(name.into(),args)).await
                            .unwrap_or_else(|_|Err("PandaCode tool timed out".into()))
                    } => result,
                    _ = cancel.notified() => Err("Architect tool canceled".into()),
                };
                let result = result.and_then(|value| {
                    if let Some((mime, data, text)) = host_tools::image_content(&value)? {
                        Ok((
                            text.clone(),
                            vec![
                                json!({"type":"text","text":text}),
                                json!({"type":"image","mimeType":mime,"data":data}),
                            ],
                        ))
                    } else {
                        host_tools::bounded_json(&value, RESULT_LIMIT)
                            .map(|text| (text.clone(), vec![json!({"type":"text","text":text})]))
                    }
                });
                let (error, output, content) = match result {
                    Ok((output, content)) => (false, output, content),
                    Err(message) => {
                        let output = limited(&message, 8192);
                        (
                            true,
                            output.clone(),
                            vec![json!({"type":"text","text":output})],
                        )
                    }
                };
                self.activity(
                    &call_id,
                    name,
                    if error { "failed" } else { "completed" },
                    &input,
                    &output,
                );
                // Same cache hints as tools/list. ttl 0 keeps a call from being
                // served again; the spec's call result allows the extra keys.
                json!({"resultType":"complete","ttlMs":0,"cacheScope":"private","content":content,"isError":error})
            }
            _ => return HttpResponse::error(id, -32601, "Method not found"),
        };
        HttpResponse::json(json!({"jsonrpc":"2.0","id":id,"result":result}))
    }
    /// Asks the user when `name` needs it, and returns the arguments the handler gets: an
    /// approved agent-made tool run carries its approval id (`custom_tools::approval`).
    async fn authorize(&self, name: &str, mut args: Value) -> Result<Value, String> {
        // A team worker never gets an always-ask tool, however the harness words the prompt.
        // A Python run that may create a paid Colab runtime counts as managing one.
        let always_ask = crate::cloud::deploy::always_ask_as(name, &args);
        if let Some(reason) = crate::providers::worker_tool_refusal(&self.session_id, always_ask.unwrap_or(name)) {
            return Err(reason);
        }
        // Only an approval below may name an approved snapshot.
        crate::custom_tools::approval::strip(&mut args);
        if !self.host.approval_tools.contains(name) {
            return Ok(args);
        }
        if self.mode == "plan" {
            return Err("This host action is unavailable in Plan mode".into());
        }
        if self.mode == "full" && always_ask.is_none() {
            return Ok(args);
        }
        let id = format!("mcp-approval:{}", uuid::Uuid::new_v4());
        // An agent-made tool's approval shows its whole script; that snapshot is what runs.
        let text = match crate::custom_tools::approval::prepare(&self.session_id, &id, name, &args) {
            Some(prepared) => prepared?,
            None => format!("Allow {name}?\n{}", preview_json(&args, TOOL_INPUT_LIMIT)),
        };
        let (send, receive) = tokio::sync::oneshot::channel();
        {
            let Ok(mut pending) = self.approvals.lock() else {
                crate::custom_tools::approval::forget(&id);
                return Err("Approval state is unavailable".into());
            };
            pending.insert(id.clone(), send);
        }
        let _pending = PendingApproval {
            context: self,
            id: id.clone(),
        };
        (self.sink)(AgentEvent {
            session_id: self.session_id.clone(),
            kind: "approval".into(),
            text,
            request_id: Some(id.clone()),
            data: None,
            tool: None,
        });
        let wait = crate::remote::orchestrate::approval_wait(name).unwrap_or(Duration::from_secs(300));
        match tokio::time::timeout(wait, receive).await {
            Ok(Ok(false)) => Err(crate::providers::decline_text(&self.session_id, &id)),
            outcome => {
                crate::providers::take_decline_reason(&self.session_id, &id);
                match outcome {
                    Ok(Ok(true)) => {
                        crate::custom_tools::approval::approve(&id, &mut args);
                        Ok(args)
                    }
                    _ => Err("App approval expired or was cancelled".into()),
                }
            }
        }
    }
    fn activity(&self, id: &str, name: &str, status: &str, input: &str, output: &str) {
        // Sidebar metadata is not part of the conversation transcript. Native
        // mirrors are already filtered by the per-run MCP tool catalog.
        if optional_metadata_tool(name) { return; }
        (self.sink)(AgentEvent {
            session_id: self.session_id.clone(),
            kind: "tool".into(),
            text: format!("{name} · {status}"),
            request_id: None,
            data: None,
            tool: Some(ToolActivity {
                id: id.into(),
                name: name.into(),
                status: status.into(),
                input: input.into(),
                output: limited(output, TOOL_OUTPUT_LIMIT),
                write_paths: None,
            }),
        });
    }
}

#[cfg(test)]
mod tests;
