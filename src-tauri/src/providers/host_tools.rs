//! Client-owned tools. These run in the host, so the host must validate scope and
//! arguments; the provider's shell sandbox does not cover these callbacks.
use super::*;
use std::{future::Future, pin::Pin};

pub type ToolFuture = Pin<Box<dyn Future<Output = Result<Value, String>> + Send>>;
pub type ToolHandler = Arc<dyn Fn(String, Value) -> ToolFuture + Send + Sync>;
#[derive(Clone)]
pub struct ToolHost {
    pub tools: Vec<Value>,
    pub handler: ToolHandler,
    pub approval_tools: HashSet<String>,
}

pub(super) struct Call {
    pub id: Value,
    pub tool: String,
    pub arguments: Value,
}

pub(super) struct HostTools {
    pub host: ToolHost,
    catalog: HashSet<(Option<String>, String)>,
    active: HashMap<String, Value>,
    active_calls: HashMap<String, String>,
}
const MAX_CALLS: usize = 64;
/// Approval tools that still ask in Full access mode (cloud CLI runs carry the
/// user's provider credentials, so every call needs an explicit yes).
pub const ALWAYS_ASK_TOOLS: &[&str] = &["pandacode_cloud_cli"];
pub fn asks_in_full_mode(tool: &str) -> bool {
    ALWAYS_ASK_TOOLS.contains(&tool)
}
fn rpc_key(id: &Value) -> Result<String, String> {
    match id {
        Value::String(s) if !s.is_empty() && s.len() <= 256 => Ok(format!("s:{s}")),
        Value::Number(n) if n.is_i64() || n.is_u64() => Ok(format!("n:{n}")),
        _ => Err("Invalid host tool request ID".into()),
    }
}
fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-'))
}
pub(super) fn bounded_json(value: &Value, limit: usize) -> Result<String, String> {
    let mut preview = Preview::new(limit);
    serde_json::to_writer(&mut preview, value)
        .map_err(|_| "Host tool JSON exceeds its size limit".to_string())?;
    Ok(preview.finish())
}
impl HostTools {
    pub fn new(host: ToolHost) -> Result<Self, String> {
        bounded_json(&json!(host.tools), 128 * 1024)?;
        let mut catalog = HashSet::new();
        for spec in &host.tools {
            let namespace = match field(spec, "type") {
                "function" => None,
                "namespace" if valid_name(field(spec, "name")) => {
                    Some(field(spec, "name").to_owned())
                }
                _ => return Err("Invalid host tool specification".into()),
            };
            let entries = if namespace.is_some() {
                spec["tools"]
                    .as_array()
                    .ok_or("Invalid host tool namespace")?
                    .iter()
                    .collect::<Vec<_>>()
            } else {
                vec![spec]
            };
            for entry in entries {
                let name = field(entry, "name");
                if field(entry, "type") != "function"
                    || !valid_name(name)
                    || !entry["inputSchema"].is_object()
                    || !entry["description"].is_string()
                    || !catalog.insert((namespace.clone(), name.into()))
                {
                    return Err("Invalid or duplicate host tool specification".into());
                }
            }
        }
        if catalog.len() > MAX_CALLS
            || host
                .approval_tools
                .iter()
                .any(|name| !catalog.iter().any(|(_, registered)| registered == name))
        {
            return Err("Invalid host tool approval catalog".into());
        }
        Ok(Self {
            host,
            catalog,
            active: HashMap::new(),
            active_calls: HashMap::new(),
        })
    }
    fn parse(&self, request: &Value) -> Result<Call, String> {
        rpc_key(&request["id"])?;
        let params = &request["params"];
        let namespace = match &params["namespace"] {
            Value::Null => None,
            Value::String(name) => Some(name.clone()),
            _ => return Err("Invalid host tool namespace".into()),
        };
        let name = field(params, "tool");
        if !self.catalog.contains(&(namespace, name.into())) {
            return Err("Unknown host tool".into());
        }
        if !params["arguments"].is_object()
            || field(params, "callId").is_empty()
            || field(params, "callId").len() > 256
        {
            return Err("Invalid host tool arguments or call ID".into());
        }
        bounded_json(&params["arguments"], 32 * 1024)?;
        Ok(Call {
            id: request["id"].clone(),
            tool: name.into(),
            arguments: params["arguments"].clone(),
        })
    }
    pub fn reserve(&mut self, request: &Value) -> Result<Call, String> {
        let call = self.parse(request)?;
        let key = rpc_key(&call.id)?;
        if self.active.len() >= MAX_CALLS
            || self.active.contains_key(&key)
            || self
                .active_calls
                .values()
                .any(|id| id == field(&request["params"], "callId"))
        {
            return Err("Too many or duplicate host tool requests".into());
        }
        self.active_calls
            .insert(key.clone(), field(&request["params"], "callId").into());
        self.active.insert(key, call.id.clone());
        Ok(call)
    }
    pub fn approved(&self, request: &Value) -> Result<Call, String> {
        let call = self.parse(request)?;
        if !self.active.contains_key(&rpc_key(&call.id)?) {
            return Err("Host tool request is no longer active".into());
        }
        Ok(call)
    }
    pub fn finish(&mut self, id: &Value) -> bool {
        if let Ok(key) = rpc_key(id) {
            self.active_calls.remove(&key);
            self.active.remove(&key).is_some()
        } else {
            false
        }
    }
    pub fn cancel(&mut self) -> Vec<Value> {
        self.active_calls.clear();
        self.active
            .drain()
            .map(|(_, id)| reply(id, Err("Host tool canceled".into())))
            .collect()
    }
    pub fn launch(&self, call: Call, jobs: &mut tokio::task::JoinSet<(Value, Value)>) {
        let handler = self.host.handler.clone();
        jobs.spawn(async move {
            let result = tokio::time::timeout(Duration::from_secs(60), async move {
                (handler)(call.tool, call.arguments).await
            })
            .await
            .unwrap_or_else(|_| Err("Host tool timed out".into()));
            let response = reply(call.id.clone(), result);
            (call.id, response)
        });
    }
}
/// Only app-owned callbacks create this envelope. Keep image bytes out of tool
/// activity text and render them as protocol image blocks, not a base64 transcript.
pub(super) fn image_content(value: &Value) -> Result<Option<(String, String, String)>, String> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let Some(image) = value.get("_pandacodeImage") else {
        return Ok(None);
    };
    let mime = image["mimeType"].as_str().ok_or("Invalid image response")?;
    let data = image["data"].as_str().ok_or("Invalid image response")?;
    let text = image["text"]
        .as_str()
        .unwrap_or("Moodboard visual reference");
    if mime != "image/jpeg" || data.len() > 2 * 1024 * 1024 * 4 / 3 + 4 || text.len() > 8192 {
        return Err("Image response exceeds the supported limits".into());
    }
    let bytes = STANDARD
        .decode(data)
        .map_err(|_| "Invalid image response")?;
    if bytes.len() > 2 * 1024 * 1024 || !bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        return Err("Invalid image response".into());
    }
    Ok(Some((mime.into(), data.into(), text.into())))
}
pub(super) fn reply(id: Value, result: Result<Value, String>) -> Value {
    let result = result.and_then(|value| {
        if let Some((mime, data, text)) = image_content(&value)? {
            Ok(vec![
                json!({"type":"inputText","text":text}),
                json!({"type":"inputImage","imageUrl":format!("data:{mime};base64,{data}")}),
            ])
        } else {
            bounded_json(&value, 128 * 1024)
                .map(|text| vec![json!({"type":"inputText","text":text})])
        }
    });
    let (success, content) = match result {
        Ok(content) => (true, content),
        Err(error) => (
            false,
            vec![json!({"type":"inputText","text":limited(&error,8192)})],
        ),
    };
    json!({"id":id,"result":{"contentItems":content,"success":success}})
}

impl Protocol {
    pub(super) fn host_tool_request(&mut self, request: Value, step: &mut Step) {
        let params = &request["params"];
        if self.remote_id.is_empty()
            || self.turn_id.is_empty()
            || field(params, "threadId") != self.remote_id
            || field(params, "turnId") != self.turn_id
        {
            step.write.push(reply(
                request["id"].clone(),
                Err("Host tool request does not belong to the active turn".into()),
            ));
            return;
        }
        let Some(host) = &mut self.host else {
            step.write.push(reply(
                request["id"].clone(),
                Err("Host tools are unavailable in this client".into()),
            ));
            return;
        };
        let call = match host.reserve(&request) {
            Ok(call) => call,
            Err(error) => {
                step.write.push(reply(request["id"].clone(), Err(error)));
                return;
            }
        };
        let protected = host.host.approval_tools.contains(&call.tool);
        if protected && self.config.mode == "plan" {
            host.finish(&call.id);
            step.write.push(reply(
                call.id,
                Err("This host action is unavailable in Plan mode".into()),
            ));
        } else if protected && (self.config.mode != "full" || asks_in_full_mode(&call.tool)) {
            let label = format!(
                "Allow {}?\n{}",
                call.tool,
                preview_json(&call.arguments, TOOL_INPUT_LIMIT)
            );
            let pending = json!({"id":call.id,"method":"item/tool/call","params":{"namespace":request["params"]["namespace"],"tool":call.tool,"arguments":call.arguments,"callId":request["params"]["callId"]}});
            if let Err(error) = self.approval(pending, label, step) {
                if let Some(host) = &mut self.host {
                    host.finish(&call.id);
                }
                step.write.push(reply(call.id, Err(error)));
            }
        } else {
            step.calls.push(call);
        }
    }
    pub(super) fn approval_step(&mut self, id: &str, approved: bool) -> Step {
        let mut step = Step::default();
        if self
            .pending
            .get(id)
            .is_some_and(|request| request["method"] == "item/tool/call")
        {
            let request = self.pending.remove(id).unwrap();
            let Some(host) = &mut self.host else {
                return step;
            };
            if approved && self.config.mode != "plan" {
                match host.approved(&request) {
                    Ok(call) => step.calls.push(call),
                    Err(error) => {
                        host.finish(&request["id"]);
                        step.write.push(reply(request["id"].clone(), Err(error)));
                    }
                }
            } else {
                host.finish(&request["id"]);
                step.write.push(reply(
                    request["id"].clone(),
                    Err("Declined by the user".into()),
                ));
            }
        } else if let Some(response) = self.approve(id, approved) {
            step.write.push(response);
        }
        step
    }
    pub(super) fn input_request(&mut self, request: Value, step: &mut Step) {
        let normalized = if self.inputs.len() + self.pending.len() >= 64 {
            Err("Too many pending input requests".into())
        } else if rpc_key(&request["id"]).is_err()
            || self.inputs.values().any(|old| old["id"] == request["id"])
        {
            Err("Invalid or duplicate input request ID".into())
        } else {
            host_inputs::normalize(&request)
        };
        match normalized {
            Ok(data) => {
                let id = uuid::Uuid::new_v4().to_string();
                let mut event = self.event("input_request", "", None);
                event.request_id = Some(id.clone());
                event.data = Some(data);
                // Retain only the bounded fields needed to validate the answer;
                // opaque provider metadata can otherwise dwarf the visible form.
                let data = event.data.as_ref().unwrap();
                let params = match field(data, "kind") {
                    "questions" => json!({"questions":data["questions"]}),
                    "form" => {
                        json!({"mode":"form","message":data["message"],"requestedSchema":data["schema"]})
                    }
                    _ => json!({"mode":"url","message":data["message"],"url":data["url"]}),
                };
                self.inputs.insert(
                    id,
                    json!({"id":request["id"],"method":request["method"],"params":params}),
                );
                step.events.push(event);
            }
            Err(message) => step
                .write
                .push(json!({"id":request["id"],"error":{"code":-32602,"message":message}})),
        }
    }
    pub(super) fn user_input(&mut self, id: &str, response: Value) -> Result<Step, String> {
        let request = self
            .inputs
            .get(id)
            .ok_or("This input request is no longer active")?;
        // Validation finishes before removing pending state. The run loop sends
        // the UI an acknowledgement only after writing this exact response.
        let result = host_inputs::answer(request, response)?;
        let request = self.inputs.remove(id).unwrap();
        let mut event = self.event("input_cancelled", "", None);
        event.request_id = Some(id.into());
        Ok(Step {
            write: vec![json!({"id":request["id"],"result":result})],
            events: vec![event],
            ..Step::default()
        })
    }
    pub(super) fn resolved_request(&mut self, rpc_id: &Value, step: &mut Step) {
        if let Some(host) = &mut self.host {
            host.finish(rpc_id);
        }
        let ids: Vec<_> = self
            .inputs
            .iter()
            .filter(|(_, request)| &request["id"] == rpc_id)
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            self.inputs.remove(&id);
            let mut event = self.event("input_cancelled", "", None);
            event.request_id = Some(id);
            step.events.push(event);
        }
        let ids: Vec<_> = self
            .pending
            .iter()
            .filter(|(_, request)| &request["id"] == rpc_id)
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            self.pending.remove(&id);
            if let Some(host) = &mut self.host {
                host.finish(rpc_id);
            }
            let mut event = self.event("approval_cancelled", "", None);
            event.request_id = Some(id);
            step.events.push(event);
        }
    }
    pub(super) fn cancel_requests(&mut self) -> Step {
        let mut step = Step::default();
        let ids: Vec<_> = self.pending.keys().cloned().collect();
        for id in ids {
            let mut declined = self.approval_step(&id, false);
            step.write.append(&mut declined.write);
            let mut event = self.event("approval_cancelled", "", None);
            event.request_id = Some(id);
            step.events.push(event);
        }
        let requests: Vec<_> = self.inputs.drain().collect();
        for (id, request) in requests {
            let response = if request["method"] == "item/tool/requestUserInput" {
                json!({"answers":{}})
            } else {
                json!({"action":"cancel","content":null})
            };
            if let Ok(result) = host_inputs::answer(&request, response) {
                step.write.push(json!({"id":request["id"],"result":result}));
            }
            let mut event = self.event("input_cancelled", "", None);
            event.request_id = Some(id);
            step.events.push(event);
        }
        if let Some(host) = &mut self.host {
            step.write.extend(host.cancel());
        }
        step
    }
}

pub(super) async fn write_response(stdin: &mut ChildStdin, response: &Value) -> Result<(), String> {
    // A stalled provider must not hold up Stop behind a large tool result.
    // Timeout ends the run rather than retrying a partially written JSON frame.
    tokio::time::timeout(Duration::from_millis(500), write_json(stdin, response))
        .await
        .map_err(|_| "Provider stopped accepting tool responses".to_string())?
}

pub(super) async fn apply_step(
    protocol: &mut Protocol,
    step: Step,
    sink: &Sink,
    stdin: &mut ChildStdin,
    jobs: &mut tokio::task::JoinSet<(Value, Value)>,
    queued: &mut VecDeque<Call>,
) -> Result<bool, String> {
    for event in step.events {
        sink(event);
    }
    for message in step.write {
        if protocol.config.provider == "codex" && message.get("method").is_none() {
            write_response(stdin, &message).await?;
        } else {
            write_json(stdin, &message).await?;
        }
    }
    if let Some(error) = step.failure {
        return Err(error);
    }
    // Goal state and user-input rows reach the persistence sink before an IPC
    // caller is told that the corresponding operation was acknowledged.
    for reply in step.goal_acknowledgements {
        reply.send();
    }
    queued.extend(step.calls);
    if let Some(host) = &protocol.host {
        while jobs.len() < 8 {
            let Some(call) = queued.pop_front() else {
                break;
            };
            if rpc_key(&call.id).is_ok_and(|key| host.active.contains_key(&key)) {
                host.launch(call, jobs);
            }
        }
    }
    Ok(step.done)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn host() -> ToolHost {
        ToolHost {
            tools: vec![
                json!({"type":"function","name":"pandacode_test","description":"test","inputSchema":{"type":"object"}}),
            ],
            handler: Arc::new(|_, args| Box::pin(async move { Ok(args) })),
            approval_tools: HashSet::new(),
        }
    }
    fn request() -> Value {
        json!({"id":"rpc-1","params":{"namespace":null,"tool":"pandacode_test","arguments":{"ok":true},"callId":"call-1"}})
    }
    #[tokio::test]
    async fn dispatch_preserves_rpc_and_returns_actual_json_result() {
        let mut state = HostTools::new(host()).unwrap();
        let call = state.reserve(&request()).unwrap();
        let mut jobs = tokio::task::JoinSet::new();
        state.launch(call, &mut jobs);
        let (id, result) = jobs.join_next().await.unwrap().unwrap();
        assert_eq!(id, "rpc-1");
        assert_eq!(result["id"], id);
        assert_eq!(result["result"]["success"], true);
        assert_eq!(result["result"]["contentItems"][0]["text"], "{\"ok\":true}");
    }
    #[test]
    fn moodboard_images_use_native_image_blocks_and_remain_bounded() {
        use base64::{engine::general_purpose::STANDARD, Engine};
        let image = json!({"_pandacodeImage":{"mimeType":"image/jpeg","data":STANDARD.encode([0xff,0xd8,0xff,0xd9]),"text":"A visual reference"}});
        let result = reply(json!(1), Ok(image));
        assert_eq!(result["result"]["success"], true);
        assert_eq!(result["result"]["contentItems"][1]["type"], "inputImage");
        assert!(result["result"]["contentItems"][1]["imageUrl"]
            .as_str()
            .unwrap()
            .starts_with("data:image/jpeg;base64,"));
        assert_eq!(
            reply(
                json!(2),
                Ok(json!({"_pandacodeImage":{"mimeType":"image/svg+xml","data":"PHN2Zz4="}}))
            )["result"]["success"],
            false
        );
        assert_eq!(
            reply(
                json!(3),
                Ok(
                    json!({"_pandacodeImage":{"mimeType":"image/jpeg","data":"a".repeat(3*1024*1024)}})
                )
            )["result"]["success"],
            false
        );
    }
    #[test]
    fn unknown_namespace_duplicate_rpc_and_oversized_arguments_are_rejected() {
        let mut state = HostTools::new(host()).unwrap();
        let mut req = request();
        req["params"]["namespace"] = json!("foreign");
        assert!(state.reserve(&req).is_err());
        req = request();
        state.reserve(&req).unwrap();
        assert!(state.reserve(&req).is_err());
        state.finish(&req["id"]);
        req["params"]["arguments"] = json!({"text":"x".repeat(32769)});
        assert!(state.reserve(&req).is_err());
    }
    #[test]
    fn cancellation_replies_once_and_output_is_bounded() {
        let mut state = HostTools::new(host()).unwrap();
        state.reserve(&request()).unwrap();
        let replies = state.cancel();
        assert_eq!(replies.len(), 1);
        assert_eq!(replies[0]["result"]["success"], false);
        assert!(state.cancel().is_empty());
        assert_eq!(
            reply(json!(4), Ok(json!("x".repeat(140000))))["result"]["success"],
            false
        );
    }
}

#[cfg(test)]
mod protocol_tests {
    use super::*;
    fn host(protected: bool) -> ToolHost {
        ToolHost {
            tools: vec![
                json!({"type":"function","name":"pandacode_test","description":"test","inputSchema":{"type":"object"}}),
            ],
            handler: Arc::new(|_, args| Box::pin(async move { Ok(args) })),
            approval_tools: if protected {
                HashSet::from(["pandacode_test".into()])
            } else {
                HashSet::new()
            },
        }
    }
    fn protocol(mode: &str, protected: bool) -> Protocol {
        let mut cfg = super::super::tests::config("codex");
        cfg.mode = mode.into();
        let mut p = Protocol::new(cfg);
        p.host = Some(HostTools::new(host(protected)).unwrap());
        p.remote_id = "thread".into();
        p.turn_id = "turn".into();
        p
    }
    fn request() -> Value {
        json!({"id":"rpc","method":"item/tool/call","params":{"threadId":"thread","turnId":"turn","namespace":null,"tool":"pandacode_test","arguments":{"ok":true},"callId":"call"}})
    }
    fn question() -> Value {
        json!({"id":7,"method":"item/tool/requestUserInput","params":{"threadId":"thread","turnId":"turn","itemId":"q-item","isBlocking":true,"questions":[{"id":"q","header":"Choice","question":"Which?","isOther":false,"isSecret":false,"options":[{"label":"A","description":"First"}]}]}})
    }
    #[test]
    fn host_catalog_is_advertised_on_new_threads_only() {
        let mut p = protocol("ask", false);
        assert_eq!(
            p.initial()["params"]["capabilities"]["experimentalApi"],
            true
        );
        p.remote_id.clear();
        let step = p.receive(json!({"id":1,"result":{}})).unwrap();
        assert_eq!(
            step.write[1]["params"]["dynamicTools"][0]["name"],
            "pandacode_test"
        );
        p.remote_id = "thread".into();
        let resume = p.receive(json!({"id":1,"result":{}})).unwrap();
        assert!(resume.write[1]["params"].get("dynamicTools").is_none());
    }
    #[test]
    fn protected_host_calls_wait_for_explicit_approval_in_ask_and_auto() {
        for mode in ["ask", "auto"] {
            let mut p = protocol(mode, true);
            let step = p.receive(request()).unwrap();
            assert!(step.calls.is_empty());
            assert!(step.write.is_empty());
            let event = step
                .events
                .iter()
                .find(|event| event.kind == "approval")
                .unwrap();
            let id = event.request_id.as_ref().unwrap();
            let approved = p.approval_step(id, true);
            assert_eq!(approved.calls.len(), 1);
            assert_eq!(approved.calls[0].id, "rpc");
            assert!(p.approval_step(id, true).calls.is_empty());
        }
    }
    #[test]
    fn plan_denies_mutation_full_allows_and_read_only_calls_work_in_plan() {
        let mut p = protocol("plan", true);
        let step = p.receive(request()).unwrap();
        assert!(step.calls.is_empty());
        assert_eq!(step.write[0]["result"]["success"], false);
        assert!(step.events.is_empty());
        let mut p = protocol("full", true);
        assert_eq!(p.receive(request()).unwrap().calls.len(), 1);
        let mut p = protocol("plan", false);
        assert_eq!(p.receive(request()).unwrap().calls.len(), 1);
    }
    #[test]
    fn full_mode_still_asks_for_cloud_cli_only() {
        let mut p = protocol("full", true);
        let cloud = "pandacode_cloud_cli";
        p.host = Some(
            HostTools::new(ToolHost {
                tools: vec![
                    json!({"type":"function","name":cloud,"description":"cloud","inputSchema":{"type":"object"}}),
                    json!({"type":"function","name":"pandacode_test","description":"test","inputSchema":{"type":"object"}}),
                ],
                handler: Arc::new(|_, args| Box::pin(async move { Ok(args) })),
                approval_tools: HashSet::from([cloud.into(), "pandacode_test".into()]),
            })
            .unwrap(),
        );
        let mut req = request();
        req["params"]["tool"] = json!(cloud);
        let step = p.receive(req).unwrap();
        assert!(step.calls.is_empty());
        let id = step
            .events
            .iter()
            .find(|event| event.kind == "approval")
            .unwrap()
            .request_id
            .clone()
            .unwrap();
        assert_eq!(p.approval_step(&id, true).calls.len(), 1);
        let mut other = request();
        other["id"] = json!("rpc-2");
        other["params"]["callId"] = json!("call-2");
        let step = p.receive(other).unwrap();
        assert_eq!(step.calls.len(), 1);
        assert!(step.events.iter().all(|event| event.kind != "approval"));
    }
    #[test]
    fn foreign_and_missing_scope_never_dispatch() {
        for (key, value) in [
            ("threadId", json!("foreign")),
            ("turnId", json!("stale")),
            ("threadId", Value::Null),
            ("turnId", Value::Null),
        ] {
            let mut p = protocol("full", false);
            let mut req = request();
            req["params"][key] = value;
            let step = p.receive(req).unwrap();
            assert!(step.calls.is_empty());
            assert_eq!(step.write.len(), 1);
        }
    }
    #[test]
    fn rejected_and_cancelled_approvals_never_dispatch() {
        let mut p = protocol("ask", true);
        let step = p.receive(request()).unwrap();
        let id = step.events[0].request_id.as_ref().unwrap();
        let denied = p.approval_step(id, false);
        assert!(denied.calls.is_empty());
        assert_eq!(denied.write[0]["id"], "rpc");
        assert_eq!(denied.write[0]["result"]["success"], false);
        let mut p = protocol("ask", true);
        p.receive(request()).unwrap();
        let cancel = p.cancel_requests();
        assert_eq!(cancel.write.len(), 1);
        assert_eq!(cancel.events[0].kind, "approval_cancelled");
        assert!(p.pending.is_empty());
    }
    #[test]
    fn question_reply_preserves_rpc_and_invalid_reply_keeps_pending_for_retry() {
        let mut p = protocol("ask", false);
        let step = p.receive(question()).unwrap();
        let id = step.events[0].request_id.as_ref().unwrap();
        let invalid = p.user_input(id, json!({"answers":{"unknown":["x"]}}));
        assert!(invalid.is_err());
        assert!(p.inputs.contains_key(id));
        assert!(p.user_input("expired", json!({"answers":{}})).is_err());
        let answer = p.user_input(id, json!({"answers":{"q":["A"]}})).unwrap();
        assert_eq!(
            answer.write[0],
            json!({"id":7,"result":{"answers":{"q":{"answers":["A"]}}}})
        );
        assert_eq!(answer.events[0].kind, "input_cancelled");
        assert!(p.inputs.is_empty());
    }
    #[test]
    fn resolved_questions_and_stop_remove_pending_without_secret_answers() {
        let mut p = protocol("ask", false);
        p.receive(question()).unwrap();
        let step=p.receive(json!({"method":"serverRequest/resolved","params":{"threadId":"thread","requestId":7}})).unwrap();
        assert_eq!(step.events[0].kind, "input_cancelled");
        assert!(p.inputs.is_empty());
        p.receive(question()).unwrap();
        let step = p.cancel_requests();
        assert_eq!(step.write[0], json!({"id":7,"result":{"answers":{}}}));
        assert_eq!(step.events[0].data, None);
        assert!(p.inputs.is_empty());
    }
    #[test]
    fn resolved_approved_host_calls_cannot_execute_from_the_queue() {
        let mut p = protocol("ask", true);
        let step = p.receive(request()).unwrap();
        let approved = p.approval_step(step.events[0].request_id.as_ref().unwrap(), true);
        assert_eq!(approved.calls.len(), 1);
        p.resolved_request(&json!("rpc"), &mut Step::default());
        assert!(!p.host.as_ref().unwrap().active.contains_key("s:rpc"));
        assert!(
            !p.host.as_mut().unwrap().finish(&json!("rpc")),
            "late completion must not produce another response"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn host_response_write_is_bounded_when_provider_stops_reading() {
        let _lock = concurrent_process_tests::process_test_lock().lock().await;
        let mut command = Command::new("/bin/sh");
        command
            .args(["-c", "sleep 10"])
            .stdin(Stdio::piped())
            .process_group(0)
            .kill_on_drop(true);
        let mut child = command.spawn().unwrap();
        let group = ProcessGroup::register(child.id());
        let mut stdin = child.stdin.take().unwrap();
        let result = tokio::time::timeout(
            Duration::from_secs(1),
            write_response(
                &mut stdin,
                &json!({"id":"rpc","result":"x".repeat(128*1024)}),
            ),
        )
        .await;
        drop(group);
        let _ = child.wait().await;
        assert!(
            result.is_ok(),
            "host response write delayed cancellation beyond its budget"
        );
        assert!(result.unwrap().is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn suspended_host_callback_does_not_block_text_or_stop() {
        let _lock = concurrent_process_tests::process_test_lock().lock().await;
        let script = r#"
IFS= read -r init
printf '%s\n' '{"id":1,"result":{}}'
IFS= read -r initialized
IFS= read -r start
printf '%s\n' '{"id":2,"result":{"thread":{"id":"thread"}}}'
IFS= read -r turn
printf '%s\n' '{"id":3,"result":{"turn":{"id":"turn"}}}' '{"id":"rpc","method":"item/tool/call","params":{"threadId":"thread","turnId":"turn","namespace":null,"tool":"pandacode_test","arguments":{},"callId":"call"}}' '{"method":"item/agentMessage/delta","params":{"threadId":"thread","turnId":"turn","itemId":"message","delta":"Still streaming"}}'
while IFS= read -r reply; do
case "$reply" in *turn/interrupt*) exit 0;; esac
done
"#;
        let (sender, input) = tokio::sync::mpsc::unbounded_channel();
        let (events_send, mut events) = tokio::sync::mpsc::unbounded_channel();
        let sink: Sink = Arc::new(move |event| {
            let _ = events_send.send(event);
        });
        let dropped = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let started = Arc::new(tokio::sync::Notify::new());
        let mut host = host(false);
        let drop_signal = dropped.clone();
        let start_signal = started.clone();
        struct Guard(Arc<std::sync::atomic::AtomicBool>);
        impl Drop for Guard {
            fn drop(&mut self) {
                self.0.store(true, std::sync::atomic::Ordering::SeqCst);
            }
        }
        host.handler = Arc::new(move |_, _| {
            let guard = Guard(drop_signal.clone());
            let started = start_signal.clone();
            Box::pin(async move {
                let _guard = guard;
                started.notify_one();
                std::future::pending::<Result<Value, String>>().await
            })
        });
        let mut command = Command::new("/bin/sh");
        command.args(["-c", script]);
        let task = tokio::spawn(run_process_with_tools(
            super::super::tests::config("codex"),
            sink,
            input,
            command,
            vec![],
            Some(host),
        ));
        tokio::time::timeout(Duration::from_secs(3), started.notified())
            .await
            .unwrap();
        let text = tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let event = events.recv().await.unwrap();
                if event.kind == "text" {
                    break event.text;
                }
            }
        })
        .await
        .unwrap();
        assert_eq!(text, "Still streaming");
        sender.send(RunInput::Stop).unwrap();
        tokio::time::timeout(Duration::from_secs(5), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(dropped.load(std::sync::atomic::Ordering::SeqCst));
    }
}

#[cfg(all(test, unix))]
mod acknowledgement_tests {
    use super::*;
    #[tokio::test]
    async fn invalid_input_acknowledges_error_then_valid_retry_completes_the_turn() {
        let _lock = concurrent_process_tests::process_test_lock().lock().await;
        let script = r#"
IFS= read -r init
printf '%s\n' '{"id":1,"result":{}}'
IFS= read -r initialized
IFS= read -r start
printf '%s\n' '{"id":2,"result":{"thread":{"id":"thread"}}}'
IFS= read -r turn
printf '%s\n' '{"id":3,"result":{"turn":{"id":"turn"}}}' '{"id":7,"method":"item/tool/requestUserInput","params":{"threadId":"thread","turnId":"turn","itemId":"question","questions":[{"id":"q","header":"Choice","question":"Which?","isOther":false,"isSecret":false,"options":[{"label":"A","description":"First"}]}]}}'
IFS= read -r answer
printf '%s\n' '{"method":"turn/completed","params":{"threadId":"thread","turn":{"id":"turn","status":"completed"}}}'
"#;
        let (sender, input) = tokio::sync::mpsc::unbounded_channel();
        let (event_tx, mut events) = tokio::sync::mpsc::unbounded_channel();
        let sink: Sink = Arc::new(move |event| {
            let _ = event_tx.send(event);
        });
        let mut command = Command::new("/bin/sh");
        command.args(["-c", script]);
        let task = tokio::spawn(run_process(
            super::super::tests::config("codex"),
            sink,
            input,
            command,
            vec![],
        ));
        let request = tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let event = events.recv().await.unwrap();
                if event.kind == "input_request" {
                    break event.request_id.unwrap();
                }
            }
        })
        .await
        .unwrap();
        for (response, valid) in [
            (json!({"answers":{"q":["wrong"]}}), false),
            (json!({"answers":{"q":["A"]}}), true),
        ] {
            let (tx, rx) = tokio::sync::oneshot::channel();
            sender
                .send(RunInput::UserInput {
                    request_id: request.clone(),
                    response,
                    reply: Some(tx),
                })
                .unwrap();
            let result = tokio::time::timeout(Duration::from_secs(2), rx)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(result.is_ok(), valid);
        }
        tokio::time::timeout(Duration::from_secs(3), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
    }
}
