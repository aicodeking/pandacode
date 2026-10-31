//! Short-lived, authenticated loopback MCP for team and opt-in browser tools.
//! No credentials or server definitions are written into the user's configuration.
use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::{
    net::{TcpListener, TcpStream},
    sync::Semaphore,
    task::JoinHandle,
};

const HEADER_LIMIT: usize = 8192;
// Room for a full batch of team assignments (12 × 8 KiB prompts) plus JSON-RPC framing.
const BODY_LIMIT: usize = 160 * 1024;
const RESULT_LIMIT: usize = 128 * 1024;
const SERVER_NAME: &str = "pandacode_architect";

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
                        let Ok((mut stream, peer)) = result else { break };
                        if !peer.ip().is_loopback() || clients.len() >= 16 { continue; }
                        let context = current(&context);
                        clients.spawn(async move {
                            let response = match tokio::time::timeout(Duration::from_secs(5), read_request(&mut stream, &context)).await {
                                // A client that gives up on a call (its own timeout) closes the
                                // connection: the call ends here too, so its pending approval
                                // expires and a late Approve runs nothing.
                                Ok(Ok(body)) => tokio::select! {
                                    response = context.respond(body) => response,
                                    () = closed(&mut stream) => return,
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
    pub(super) fn redact(&self, text: &str) -> String {
        text.replace(&self.token, "[redacted]")
    }
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

fn current(context: &std::sync::RwLock<Arc<Context>>) -> Arc<Context> {
    match context.read() {
        Ok(context) => context.clone(),
        Err(poisoned) => poisoned.into_inner().clone(),
    }
}

struct Context {
    authority: String,
    authorization: String,
    host: ToolHost,
    session_id: String,
    sink: Sink,
    calls: Semaphore,
    active: Mutex<HashMap<String, Arc<tokio::sync::Notify>>>,
    requests: AtomicUsize,
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
            calls: Semaphore::new(8),
            active: Mutex::new(HashMap::new()),
            requests: AtomicUsize::new(0),
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

/// Returns once the client closes the connection (or it fails).
async fn closed(stream: &mut TcpStream) {
    let mut byte = [0; 1];
    while matches!(stream.read(&mut byte).await, Ok(1..)) {}
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
        .is_some_and(|version| !matches!(*version, "2025-03-26" | "2025-06-18"))
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
    if length > BODY_LIMIT {
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
        if self.requests.fetch_add(1, Ordering::Relaxed) >= 4096 {
            return HttpResponse::empty(429);
        }
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
                    .filter(|version| matches!(*version, "2025-03-26" | "2025-06-18"))
                    .unwrap_or("2025-03-26");
                json!({"protocolVersion":version,"capabilities":{"tools":{"listChanged":false}},"serverInfo":{"name":"PandaCode architect","version":"0.1.0"}})
            }
            "ping" => json!({}),
            "tools/list" => {
                let tools:Vec<Value> = self.host.tools.iter().map(|spec| json!({"name":spec["name"],"description":spec["description"],"inputSchema":spec["inputSchema"]})).collect();
                json!({"tools":tools})
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
                // Models often read several workers at once: wait briefly for a slot.
                let Ok(Ok(_permit)) = tokio::time::timeout(Duration::from_secs(30), self.calls.acquire()).await else {
                    return HttpResponse::error(id, -32000, "Too many active architect tools; retry this call alone.");
                };
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
                let result = tokio::select! {
                    result = async {
                        self.authorize(name, &args).await?;
                        tokio::time::timeout(Duration::from_secs(60),(self.host.handler)(name.into(),args)).await
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
                json!({"content":content,"isError":error})
            }
            _ => return HttpResponse::error(id, -32601, "Method not found"),
        };
        HttpResponse::json(json!({"jsonrpc":"2.0","id":id,"result":result}))
    }
    async fn authorize(&self, name: &str, args: &Value) -> Result<(), String> {
        if !self.host.approval_tools.contains(name) {
            return Ok(());
        }
        if self.mode == "plan" {
            return Err("This host action is unavailable in Plan mode".into());
        }
        if self.mode == "full" && !crate::cloud::deploy::ALWAYS_ASK.contains(&name) {
            return Ok(());
        }
        let id = format!("mcp-approval:{}", uuid::Uuid::new_v4());
        let (send, receive) = tokio::sync::oneshot::channel();
        {
            let mut pending = self
                .approvals
                .lock()
                .map_err(|_| "Approval state is unavailable")?;
            if pending.len() >= 8 {
                return Err("Too many pending app approvals".into());
            }
            pending.insert(id.clone(), send);
        }
        let _pending = PendingApproval {
            context: self,
            id: id.clone(),
        };
        (self.sink)(AgentEvent {
            session_id: self.session_id.clone(),
            kind: "approval".into(),
            text: format!("Allow {name}?\n{}", preview_json(args, TOOL_INPUT_LIMIT)),
            request_id: Some(id),
            data: None,
            tool: None,
        });
        let wait = crate::remote::orchestrate::approval_wait(name).unwrap_or(Duration::from_secs(300));
        match tokio::time::timeout(wait, receive).await {
            Ok(Ok(true)) => Ok(()),
            Ok(Ok(false)) => Err("Declined by the user".into()),
            _ => Err("App approval expired or was cancelled".into()),
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
mod tests {
    use super::*;
    fn host() -> ToolHost {
        ToolHost {
            tools: vec![
                json!({"type":"function","name":"pandacode_delegate","description":"Assign a scoped worker","inputSchema":{"type":"object","properties":{"prompt":{"type":"string"}}}}),
            ],
            approval_tools: HashSet::new(),
            handler: Arc::new(|_, args| Box::pin(async move { Ok(args) })),
        }
    }
    async fn server() -> Server {
        Server::start(host(), "parent".into(), Arc::new(|_| {}))
            .await
            .unwrap()
    }
    async fn request(server: &Server, body: Value, extra: &str) -> (u16, Value) {
        let bytes = serde_json::to_vec(&body).unwrap();
        raw(server,format!("POST /mcp HTTP/1.1\r\nHost: {}\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{}\r\n",server.authority,server.token,bytes.len(),extra),bytes).await
    }
    async fn raw(server: &Server, header: String, body: Vec<u8>) -> (u16, Value) {
        let mut stream = TcpStream::connect(&server.authority).await.unwrap();
        stream.write_all(header.as_bytes()).await.unwrap();
        tokio::task::yield_now().await;
        stream.write_all(&body).await.unwrap();
        let mut response = Vec::new();
        let _ = tokio::time::timeout(Duration::from_secs(5), stream.read_to_end(&mut response))
            .await
            .unwrap();
        let boundary = response.windows(4).position(|s| s == b"\r\n\r\n").unwrap() + 4;
        let header = std::str::from_utf8(&response[..boundary]).unwrap();
        (
            header.split_whitespace().nth(1).unwrap().parse().unwrap(),
            serde_json::from_slice(&response[boundary..]).unwrap_or(Value::Null),
        )
    }
    fn call(id: Value, args: Value) -> Value {
        json!({"jsonrpc":"2.0","id":id,"method":"tools/call","params":{"name":"pandacode_delegate","arguments":args}})
    }
    #[tokio::test]
    async fn a_warm_server_keeps_its_address_and_serves_the_turn_it_is_rebound_to() {
        let spec = json!({"type":"function","name":crate::session_titles::TOOL,"description":"Sidebar metadata","inputSchema":{"type":"object"}});
        let placeholder = ToolHost {
            tools: vec![spec.clone()],
            approval_tools: HashSet::new(),
            handler: Arc::new(|_, _| Box::pin(async { Err("not started".to_string()) })),
        };
        let server = Server::start_for_run(placeholder, "task".into(), Arc::new(|_| {}), "ask").await.unwrap().unwrap();
        let address = server.claude_config();
        let call = json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":crate::session_titles::TOOL,"arguments":{"title":"Topic"}}});
        let (_, before) = request(&server, call.clone(), "").await;
        assert_eq!(before["result"]["isError"], true);
        let live = ToolHost {
            tools: vec![spec],
            approval_tools: HashSet::new(),
            handler: Arc::new(|_, _| Box::pin(async { Ok(json!({"staged":true})) })),
        };
        server.rebind(live, "task".into(), Arc::new(|_| {}), "ask").unwrap();
        assert_eq!(server.claude_config(), address, "the agent already holds this address and token");
        let (_, after) = request(&server, call, "").await;
        assert_eq!(after["result"]["isError"], false);
    }
    #[tokio::test]
    async fn title_metadata_is_optional_and_does_not_emit_transcript_activity() {
        let (send, mut events) = tokio::sync::mpsc::unbounded_channel();
        let title_host = ToolHost {
            tools: vec![json!({"type":"function","name":crate::session_titles::TOOL,"description":"Sidebar metadata","inputSchema":{"type":"object"}})],
            approval_tools: HashSet::new(),
            handler: Arc::new(|_, _| Box::pin(async { Ok(json!({"staged":true})) })),
        };
        let server = Server::start_for_run(title_host, "task".into(), Arc::new(move |e| { let _ = send.send(e); }), "plan").await.unwrap().unwrap();
        assert_eq!(server.codex_config()[SERVER_NAME]["required"], false);
        let (_, response) = request(&server, json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":crate::session_titles::TOOL,"arguments":{"title":"Current topic"}}}), "").await;
        assert_eq!(response["result"]["isError"], false);
        assert!(events.try_recv().is_err());
    }
    #[tokio::test]
    async fn title_tool_reference_survives_review_retry_and_manual_rename() {
        use crate::{session_titles, storage::Store};

        let db = Store::open(std::path::Path::new(":memory:")).unwrap();
        let project = db.add_project(&std::env::temp_dir()).unwrap();
        let sid = db.create_session(&project.id, "claude", "sonnet", "ask").unwrap().id;
        db.resume(&sid, "saved-claude-session").unwrap();
        let saved_reference = json!({"type":"tool_reference","tool_name":"mcp__pandacode_architect__pandacode_title"});
        let mut original_spec = None;

        for turn_kind in ["user", "review", "retry", "manual"] {
            if turn_kind == "manual" {
                db.update(&sid, Some("My parser investigation".into()), None, None, None).unwrap();
            }
            let coordination = matches!(turn_kind, "review" | "retry")
                .then_some(crate::architect::internal_turns::CoordinationKind::WorkerReview);
            let turn = db.begin_task_turn_with_kind(&sid, "Inspect the parser architecture", coordination).unwrap();
            let run = session_titles::TitleRun::prepare(&db, &sid, turn).unwrap();
            assert_eq!(run.is_some(), turn_kind == "user");
            let previous_title = db.session(&sid).unwrap().title;
            let stopped = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let catalog = session_titles::with_host(run.as_ref(), Some(host()), stopped.clone());
            let (send, mut events) = tokio::sync::mpsc::unbounded_channel();
            let server = Server::start_for_run(catalog, sid.clone(), Arc::new(move |event| { let _ = send.send(event); }), "ask")
                .await.unwrap().unwrap();
            let (_, initialized) = request(&server, json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}), "").await;
            assert_eq!(initialized["result"]["protocolVersion"], "2025-06-18");
            let (status, list) = request(&server, json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}), "").await;
            assert_eq!(status, 200);
            let config = server.claude_config();
            let server_name = config["mcpServers"].as_object().unwrap().keys().next().unwrap();
            let title_spec = list["result"]["tools"].as_array().unwrap().iter().find(|tool| {
                format!("mcp__{server_name}__{}", tool["name"].as_str().unwrap()) == saved_reference["tool_name"].as_str().unwrap()
            }).expect("saved title reference must resolve in every resumed catalog");
            if let Some(spec) = &original_spec {
                assert_eq!(title_spec, spec);
            } else {
                original_spec = Some(title_spec.clone());
            }
            let suggested_title = if run.is_some() { "Parser architecture" } else { "Internal review update" };
            let (_, response) = request(&server, json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":title_spec["name"],"arguments":{"title":suggested_title}}}), "").await;
            assert_eq!(response["result"]["isError"], false);
            let result: Value = serde_json::from_str(response["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
            assert_eq!(result["staged"], run.is_some());
            assert!(events.try_recv().is_err(), "metadata must not emit activity or approval");
            assert!(server.current().approvals.lock().unwrap().is_empty());
            assert_eq!(db.session(&sid).unwrap().title, previous_title);
            db.message(&sid, "assistant", "Parser inspection finished.").unwrap();
            db.finish_task_turn(&sid, true, false).unwrap();
            if let Some(run) = run {
                assert!(run.finish(&db, true).unwrap());
                assert_eq!(db.session(&sid).unwrap().title, "Parser architecture");
            } else {
                assert_eq!(db.session(&sid).unwrap().title, previous_title);
            }
            let (_, delegated) = request(&server, call(json!(4), json!({"prompt":"Check parser tests"})), "").await;
            assert_eq!(delegated["result"]["isError"], false);
            let result: Value = serde_json::from_str(delegated["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
            assert_eq!(result["prompt"], "Check parser tests");
            assert_eq!(db.session(&sid).unwrap().resume_id.as_deref(), Some("saved-claude-session"));
            stopped.store(true, Ordering::SeqCst);
            drop(server);
        }
    }
    #[tokio::test]
    async fn optional_preview_mcp_keeps_approval_plan_restrictions_and_visible_activity() {
        for name in ["pandacode_run_project", "pandacode_preview_file"] {
            for mode in ["ask", "auto", "plan", "full"] {
                let count = Arc::new(AtomicUsize::new(0));
                let called = count.clone();
                let protected = ToolHost {
                    tools: vec![json!({"type":"function","name":name,"description":"Preview","inputSchema":{"type":"object"}})],
                    approval_tools: [name.into()].into(),
                    handler: Arc::new(move |_, _| {
                        called.fetch_add(1, Ordering::SeqCst);
                        Box::pin(async { Ok(json!({"opened":true})) })
                    }),
                };
                let (sender, mut events) = tokio::sync::mpsc::unbounded_channel();
                let server = Server::start_for_run(protected, "task".into(), Arc::new(move |event| { let _ = sender.send(event); }), mode).await.unwrap().unwrap();
                assert!(!server.required(), "preview availability must not block ordinary turns");
                let request = request(&server, json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":name,"arguments":{}}}), "");
                let answer = async {
                    if matches!(mode, "ask" | "auto") {
                        let pending = loop {
                            let event = tokio::time::timeout(Duration::from_secs(2), events.recv()).await.unwrap().unwrap();
                            if event.kind == "approval" { break event.request_id.unwrap(); }
                        };
                        assert_eq!(count.load(Ordering::SeqCst), 0);
                        // Declining even the static-file preview must prevent UI access.
                        assert!(server.approve(&pending, false));
                    }
                };
                let ((code, result), ()) = tokio::join!(request, answer);
                assert_eq!(code, 200);
                assert_eq!(result["result"]["isError"], mode != "full");
                assert_eq!(count.load(Ordering::SeqCst), usize::from(mode == "full"));
                assert!(server.current().approvals.lock().unwrap().is_empty());
                let mut activity = false;
                while let Ok(event) = events.try_recv() {
                    assert_ne!(event.kind, "approval");
                    activity |= event.kind == "tool";
                }
                assert!(activity, "preview actions must remain visible in the transcript");
            }
        }
    }

    #[tokio::test]
    async fn protected_mcp_tools_wait_for_scoped_approval_and_honor_denial() {
        for mode in ["ask", "auto", "accept"] {
            for approved in [true, false] {
                let count = Arc::new(AtomicUsize::new(0));
                let called = count.clone();
                let mut protected = host();
                protected.approval_tools.insert("pandacode_delegate".into());
                protected.handler = Arc::new(move |_, _| {
                    called.fetch_add(1, Ordering::SeqCst);
                    Box::pin(async { Ok(json!({"started":true})) })
                });
                let (sender, mut events) = tokio::sync::mpsc::unbounded_channel();
                let server = Server::start_with_approvals(
                    protected,
                    "task".into(),
                    Arc::new(move |event| {
                        let _ = sender.send(event);
                    }),
                    mode,
                )
                .await
                .unwrap();
                let request = request(&server, call(json!(1), json!({})), "");
                let answer = async {
                    let pending = loop {
                        let event = tokio::time::timeout(Duration::from_secs(2), events.recv())
                            .await
                            .unwrap()
                            .unwrap();
                        if event.kind == "approval" {
                            break event.request_id.unwrap();
                        }
                    };
                    assert_eq!(
                        count.load(Ordering::SeqCst),
                        0,
                        "callback must not precede approval"
                    );
                    assert!(!server.approve("different-request", true));
                    assert!(server.approve(&pending, approved));
                    assert!(!server.approve(&pending, true), "approval is single use");
                };
                let ((code, result), ()) = tokio::join!(request, answer);
                assert_eq!(code, 200);
                assert_eq!(result["result"]["isError"], !approved);
                assert_eq!(count.load(Ordering::SeqCst), usize::from(approved));
                assert!(server.current().approvals.lock().unwrap().is_empty());
            }
        }
    }
    #[tokio::test]
    async fn protected_mcp_tools_never_execute_in_plan_and_full_mode_needs_no_prompt() {
        for mode in ["plan", "full"] {
            let count = Arc::new(AtomicUsize::new(0));
            let called = count.clone();
            let mut protected = host();
            protected.approval_tools.insert("pandacode_delegate".into());
            protected.handler = Arc::new(move |_, _| {
                called.fetch_add(1, Ordering::SeqCst);
                Box::pin(async { Ok(json!({})) })
            });
            let server = Server::start_with_approvals(
                protected,
                "task".into(),
                Arc::new(|event| assert_ne!(event.kind, "approval")),
                mode,
            )
            .await
            .unwrap();
            let (_, result) = request(&server, call(json!(1), json!({})), "").await;
            assert_eq!(result["result"]["isError"], mode == "plan");
            assert_eq!(count.load(Ordering::SeqCst), usize::from(mode == "full"));
        }
    }
    #[tokio::test]
    async fn a_call_the_client_gave_up_on_expires_its_approval() {
        let count = Arc::new(AtomicUsize::new(0));
        let called = count.clone();
        let mut protected = host();
        protected.approval_tools.insert("pandacode_delegate".into());
        protected.handler = Arc::new(move |_, _| {
            called.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Ok(json!({})) })
        });
        let (sender, mut events) = tokio::sync::mpsc::unbounded_channel();
        let server = Server::start_with_approvals(protected, "task".into(), Arc::new(move |event| { let _ = sender.send(event); }), "ask").await.unwrap();
        let body = serde_json::to_vec(&call(json!(1), json!({}))).unwrap();
        let mut stream = TcpStream::connect(&server.authority).await.unwrap();
        stream.write_all(format!("POST /mcp HTTP/1.1\r\nHost: {}\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n", server.authority, server.token, body.len()).as_bytes()).await.unwrap();
        stream.write_all(&body).await.unwrap();
        async fn next(events: &mut tokio::sync::mpsc::UnboundedReceiver<AgentEvent>, kind: &str) -> String {
            loop {
                let event = tokio::time::timeout(Duration::from_secs(2), events.recv()).await.unwrap().unwrap();
                if event.kind == kind { break event.request_id.unwrap(); }
            }
        }
        let pending = next(&mut events, "approval").await;
        // The harness timed out the call and closed its connection.
        drop(stream);
        assert_eq!(next(&mut events, "approval_cancelled").await, pending);
        assert!(!server.approve(&pending, true), "a late Approve finds nothing");
        tokio::task::yield_now().await;
        assert_eq!(count.load(Ordering::SeqCst), 0);
    }
    #[tokio::test]
    async fn cloud_cli_asks_even_in_full_mode() {
        let name = "pandacode_cloud_cli";
        let count = Arc::new(AtomicUsize::new(0));
        let called = count.clone();
        let protected = ToolHost {
            tools: vec![json!({"type":"function","name":name,"description":"Deploy","inputSchema":{"type":"object"}})],
            approval_tools: [name.into()].into(),
            handler: Arc::new(move |_, _| {
                called.fetch_add(1, Ordering::SeqCst);
                Box::pin(async { Ok(json!({})) })
            }),
        };
        let (sender, mut events) = tokio::sync::mpsc::unbounded_channel();
        let server = Server::start_with_approvals(protected, "task".into(), Arc::new(move |event| { let _ = sender.send(event); }), "full").await.unwrap();
        let request = request(&server, json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":name,"arguments":{}}}), "");
        let answer = async {
            let pending = loop {
                let event = tokio::time::timeout(Duration::from_secs(2), events.recv()).await.unwrap().unwrap();
                if event.kind == "approval" { break event.request_id.unwrap(); }
            };
            assert_eq!(count.load(Ordering::SeqCst), 0);
            assert!(server.approve(&pending, false));
        };
        let ((_, result), ()) = tokio::join!(request, answer);
        assert_eq!(result["result"]["isError"], true);
        assert_eq!(count.load(Ordering::SeqCst), 0);
    }
    #[tokio::test]
    async fn cancelling_pending_mcp_approval_revokes_it_without_calling_handler() {
        let mut protected = host();
        protected.approval_tools.insert("pandacode_delegate".into());
        let (sender, mut events) = tokio::sync::mpsc::unbounded_channel();
        let server = Server::start_with_approvals(
            protected,
            "task".into(),
            Arc::new(move |event| {
                let _ = sender.send(event);
            }),
            "ask",
        )
        .await
        .unwrap();
        let args = json!({});
        let context = server.current();
        let mut authorization = Box::pin(context.authorize("pandacode_delegate", &args));
        let event = tokio::select! {
            _ = &mut authorization => panic!("Approval resolved before user input"),
            event = events.recv() => event.unwrap(),
        };
        let id = event.request_id.unwrap();
        drop(authorization);
        assert!(!server.approve(&id, true));
        assert!(server.current().approvals.lock().unwrap().is_empty());
        assert_eq!(events.recv().await.unwrap().kind, "approval_cancelled");
    }
    #[tokio::test]
    async fn initializes_lists_calls_and_emits_bounded_real_results() {
        let observed = Arc::new(Mutex::new(Vec::new()));
        let saved = observed.clone();
        let server = Server::start(
            host(),
            "parent".into(),
            Arc::new(move |e| saved.lock().unwrap().push(e)),
        )
        .await
        .unwrap();
        let (_,init)=request(&server,json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}),"").await;
        assert_eq!(init["result"]["protocolVersion"], "2025-06-18");
        let (_, list) = request(
            &server,
            json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}),
            "",
        )
        .await;
        assert_eq!(list["result"]["tools"][0]["name"], "pandacode_delegate");
        assert!(list["result"]["tools"][0].get("type").is_none());
        let (_, result) = request(
            &server,
            call(json!("job"), json!({"prompt":"Implement 🐼"})),
            "",
        )
        .await;
        assert_eq!(result["id"], "job");
        assert_eq!(result["result"]["isError"], false);
        assert_eq!(
            serde_json::from_str::<Value>(result["result"]["content"][0]["text"].as_str().unwrap())
                .unwrap()["prompt"],
            "Implement 🐼"
        );
        let events = observed.lock().unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].session_id, "parent");
        assert_eq!(events[1].tool.as_ref().unwrap().status, "completed");
        assert_eq!(
            events[0].tool.as_ref().unwrap().id,
            events[1].tool.as_ref().unwrap().id
        );
        assert!(server.claude_config()["mcpServers"][SERVER_NAME].is_object());
        assert_eq!(server.kimi_config()["type"], "http");
    }
    #[tokio::test]
    async fn rejects_auth_origin_host_smuggling_and_oversized_frames() {
        let server = server().await;
        let other = self::server().await;
        for (header,code) in [
            (format!("POST /mcp HTTP/1.1\r\nHost: {}\r\nContent-Length: 0\r\n\r\n",server.authority),401),
            (format!("POST /mcp HTTP/1.1\r\nHost: evil.example\r\nAuthorization: Bearer {}\r\n\r\n",server.token),403),
            (format!("POST /mcp HTTP/1.1\r\nHost: {}\r\nAuthorization: Bearer {}\r\n\r\n",server.authority,other.token),401),
            (format!("POST /mcp HTTP/1.1\r\nHost: {}\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: 99999999\r\n\r\n",server.authority,server.token),413),
        ] { assert_eq!(raw(&server,header,vec![]).await.0,code); }
        for (extra, code) in [
            ("Origin: https://evil.example\r\n", 403),
            ("Transfer-Encoding: chunked\r\n", 400),
            ("Content-Length: 1\r\n", 400),
            ("MCP-Protocol-Version: invalid\r\n", 400),
        ] {
            assert_eq!(
                request(&server, call(json!(1), json!({})), extra).await.0,
                code
            );
        }
    }
    #[tokio::test]
    async fn rejects_protected_catalog_and_unknown_calls_and_reports_tool_errors() {
        let mut protected = host();
        protected.approval_tools.insert("pandacode_delegate".into());
        assert!(Server::start(protected, "p".into(), Arc::new(|_| {}))
            .await
            .is_err());
        let mut failing = host();
        failing.handler = Arc::new(|_, _| Box::pin(async { Err("Worker unavailable".into()) }));
        let server = Server::start(failing, "p".into(), Arc::new(|_| {}))
            .await
            .unwrap();
        let (_, failed) = request(&server, call(json!(1), json!({})), "").await;
        assert_eq!(failed["result"]["isError"], true);
        assert_eq!(failed["result"]["content"][0]["text"], "Worker unavailable");
        let mut unknown = call(json!(2), json!({}));
        unknown["params"]["name"] = json!("pandacode_open_browser");
        assert_eq!(
            request(&server, unknown, "").await.1["error"]["code"],
            -32602
        );
        assert_eq!(
            request(&server, call(json!(3), json!([])), "").await.1["error"]["code"],
            -32602
        );
        let mut oversized = host();
        oversized.handler =
            Arc::new(|_, _| Box::pin(async { Ok(json!("x".repeat(RESULT_LIMIT + 1))) }));
        let big = Server::start(oversized, "p".into(), Arc::new(|_| {}))
            .await
            .unwrap();
        assert_eq!(
            request(&big, call(json!(4), json!({})), "").await.1["result"]["isError"],
            true
        );
    }
    #[tokio::test]
    async fn moodboard_visual_is_returned_as_mcp_image_not_base64_text() {
        let mut visual = host();
        visual.handler = Arc::new(|_, _| {
            Box::pin(async {
                Ok(
                    json!({"_pandacodeImage":{"mimeType":"image/jpeg","data":"/9j/2Q==","text":"Reference screenshot"}}),
                )
            })
        });
        let server = Server::start(
            visual,
            "p".into(),
            Arc::new(|event| {
                if event.kind == "tool_result" {
                    assert!(!event.text.contains("/9j/"));
                }
            }),
        )
        .await
        .unwrap();
        let (_, response) = request(&server, call(json!(1), json!({})), "").await;
        assert_eq!(response["result"]["isError"], false);
        assert_eq!(response["result"]["content"][1]["type"], "image");
        assert_eq!(response["result"]["content"][1]["mimeType"], "image/jpeg");
    }
    #[tokio::test]
    async fn cancellation_and_drop_release_waiting_callbacks_without_blocking_other_requests() {
        let dropped = Arc::new(std::sync::atomic::AtomicBool::new(false));
        struct Guard(Arc<std::sync::atomic::AtomicBool>);
        impl Drop for Guard {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }
        let signal = dropped.clone();
        let mut waiting = host();
        waiting.handler = Arc::new(move |_, _| {
            let guard = Guard(signal.clone());
            Box::pin(async move {
                let _guard = guard;
                std::future::pending().await
            })
        });
        let server = server_from_host(waiting).await;
        let cancelled = async {
            let result = request(&server, call(json!("wait"), json!({})), "").await.1;
            assert_eq!(result["result"]["isError"], true);
            assert!(result["result"]["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains("canceled"));
        };
        let interrupt = async {
            tokio::time::sleep(Duration::from_millis(30)).await;
            assert_eq!(
                request(&server, call(json!("wait"), json!({})), "").await.1["error"]["code"],
                -32600
            );
            assert!(request(
                &server,
                json!({"jsonrpc":"2.0","id":"ping","method":"ping"}),
                ""
            )
            .await
            .1["result"]
                .is_object());
            assert_eq!(request(&server,json!({"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":"wait"}}),"").await.0,202);
        };
        tokio::join!(cancelled, interrupt);
        assert!(dropped.load(Ordering::SeqCst));
        dropped.store(false, Ordering::SeqCst);
        let call = request(&server, call(json!("next"), json!({})), "");
        tokio::pin!(call);
        tokio::select! {_=&mut call=>panic!("pending tool finished"),_=tokio::time::sleep(Duration::from_millis(30))=>{}}
        let address = server.authority.clone();
        server.stop();
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(dropped.load(Ordering::SeqCst));
        assert!(TcpStream::connect(address).await.is_err());
    }
    async fn server_from_host(host: ToolHost) -> Server {
        Server::start(host, "p".into(), Arc::new(|_| {}))
            .await
            .unwrap()
    }
}

#[cfg(test)]
mod protocol_tests {
    use super::*;
    #[test]
    fn kimi_requires_http_capability_and_injects_on_new_load_and_resume() {
        for (saved, resume, method) in [
            (false, false, "session/new"),
            (true, false, "session/load"),
            (true, true, "session/resume"),
        ] {
            let mut config = super::super::tests::config("kimi");
            config.resume_id = saved.then(|| "saved".into());
            let mut protocol = Protocol::new(config);
            protocol.mcp_server = Some(
                json!({"type":"http","name":SERVER_NAME,"url":"http://127.0.0.1:1/mcp","headers":[]}),
            );
            let mut capabilities = json!({"mcpCapabilities":{"http":true}});
            if resume {
                capabilities["sessionCapabilities"] = json!({"resume":{}});
            }
            let step = protocol
                .receive(
                    json!({"id":1,"result":{"protocolVersion":1,"agentCapabilities":capabilities}}),
                )
                .unwrap();
            assert_eq!(step.write[0]["method"], method);
            assert_eq!(
                step.write[0]["params"]["mcpServers"][0]["name"],
                SERVER_NAME
            );
            assert_eq!(step.write[0]["params"]["cwd"], "/tmp");
        }
        let mut protocol = Protocol::new(super::super::tests::config("kimi"));
        protocol.mcp_server = Some(json!({}));
        assert!(protocol
            .receive(json!({"id":1,"result":{"protocolVersion":1,"agentCapabilities":{}}}))
            .is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn claude_and_kimi_fixture_processes_invoke_the_authenticated_native_bridge() {
        let _lock = concurrent_process_tests::process_test_lock().lock().await;
        const FIXTURE: &str = r#"
import sys,json,urllib.request
provider=sys.argv[1]
def receive():
    return json.loads(sys.stdin.readline())
def emit(value):
    print(json.dumps(value),flush=True)
receive()
if provider == 'claude':
    assert '--strict-mcp-config' not in sys.argv
    server=json.loads(sys.argv[sys.argv.index('--mcp-config')+1])['mcpServers']['pandacode_architect']
    headers=server['headers']
    emit({'type':'control_response','response':{'request_id':'pandacode-init','subtype':'success','response':{}}})
    receive()
else:
    emit({'id':1,'result':{'protocolVersion':1,'agentCapabilities':{'mcpCapabilities':{'http':True}}}})
    session=receive()
    server=session['params']['mcpServers'][0]
    assert server['type']=='http'
    headers={entry['name']:entry['value'] for entry in server['headers']}
    emit({'id':2,'result':{'sessionId':'fixture','modes':{'availableModes':[{'id':'default'}]}}})
    assert receive()['method']=='session/set_mode'
    emit({'id':4,'result':{}})
    assert receive()['method']=='session/prompt'
headers['Content-Type']='application/json'
headers['Accept']='application/json, text/event-stream'
for request in [
    {'jsonrpc':'2.0','id':1,'method':'initialize','params':{'protocolVersion':'2025-06-18'}},
    {'jsonrpc':'2.0','id':2,'method':'tools/list'},
    {'jsonrpc':'2.0','id':3,'method':'tools/call','params':{'name':'pandacode_delegate','arguments':{'prompt':provider}}}
]:
    req=urllib.request.Request(server['url'],data=json.dumps(request).encode(),headers=headers)
    with urllib.request.urlopen(req,timeout=5) as response:
        result=json.load(response)
assert json.loads(result['result']['content'][0]['text'])['prompt']==provider
if provider=='claude':
    emit({'type':'assistant','message':{'id':'message','content':[{'type':'tool_use','id':'native','name':'mcp__pandacode_architect__pandacode_delegate','input':{}},{'type':'text','text':'Worker dispatched'}]}})
    emit({'type':'user','message':{'content':[{'type':'tool_result','tool_use_id':'native','content':'dispatched'}]}})
    emit({'type':'result','subtype':'success','result':'Worker dispatched'})
else:
    emit({'method':'session/update','params':{'sessionId':'fixture','update':{'sessionUpdate':'tool_call','toolCallId':'native','title':'pandacode_delegate','status':'in_progress'}}})
    emit({'method':'session/update','params':{'sessionId':'fixture','update':{'sessionUpdate':'tool_call_update','toolCallId':'native','status':'completed'}}})
    emit({'method':'session/update','params':{'sessionId':'fixture','update':{'sessionUpdate':'agent_message_chunk','content':{'type':'text','text':'Worker dispatched'}}}})
    emit({'id':3,'result':{'stopReason':'end_turn'}})
"#;
        for provider in ["claude", "kimi"] {
            let config = super::super::tests::config(provider);
            let host = ToolHost {
                tools: vec![
                    json!({"type":"function","name":"pandacode_delegate","description":"delegate","inputSchema":{"type":"object"}}),
                ],
                approval_tools: HashSet::new(),
                handler: Arc::new(|_, args| Box::pin(async move { Ok(args) })),
            };
            let observed = Arc::new(Mutex::new(Vec::new()));
            let saved = observed.clone();
            let sink: Sink = Arc::new(move |event| saved.lock().unwrap().push(event));
            let (_sender, input) = tokio::sync::mpsc::unbounded_channel();
            let mut command = Command::new("/usr/bin/python3");
            command.args(["-c", FIXTURE, provider]);
            tokio::time::timeout(
                Duration::from_secs(15),
                run_process_with_tools(config, sink, input, command, vec![], Some(host)),
            )
            .await
            .unwrap()
            .unwrap();
            let events = observed.lock().unwrap();
            assert_eq!(
                events
                    .iter()
                    .filter(|event| event.kind == "text")
                    .map(|event| event.text.as_str())
                    .collect::<String>(),
                "Worker dispatched"
            );
            assert_eq!(
                events.iter().filter(|event| event.kind == "tool").count(),
                2,
                "native and MCP tool events must not duplicate"
            );
        }
    }
}
