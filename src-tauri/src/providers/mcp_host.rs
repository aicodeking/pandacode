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
    /// The bearer token, for callers that redact text themselves (`exit::reap`).
    pub(super) fn token(&self) -> &str {
        &self.token
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
                let tools:Vec<Value> = self.host.tools.iter().map(listing).collect();
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
                        let args = self.authorize(name, args).await?;
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
    /// Asks the user when `name` needs it, and returns the arguments the handler gets: an
    /// approved agent-made tool run carries its approval id (`custom_tools::approval`).
    async fn authorize(&self, name: &str, mut args: Value) -> Result<Value, String> {
        // Only an approval below may name an approved snapshot.
        crate::custom_tools::approval::strip(&mut args);
        if !self.host.approval_tools.contains(name) {
            return Ok(args);
        }
        if self.mode == "plan" {
            return Err("This host action is unavailable in Plan mode".into());
        }
        if self.mode == "full" && !crate::cloud::deploy::ALWAYS_ASK.contains(&name) {
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
            if pending.len() >= 8 {
                crate::custom_tools::approval::forget(&id);
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
            text,
            request_id: Some(id.clone()),
            data: None,
            tool: None,
        });
        let wait = crate::remote::orchestrate::approval_wait(name).unwrap_or(Duration::from_secs(300));
        match tokio::time::timeout(wait, receive).await {
            Ok(Ok(true)) => {
                crate::custom_tools::approval::approve(&id, &mut args);
                Ok(args)
            }
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
mod tests;

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
