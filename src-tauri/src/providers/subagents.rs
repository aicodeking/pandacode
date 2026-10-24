//! Child transcripts use the same protocol parsers, isolated from parent text.
//! Only IDs explicitly linked by provider delegation metadata are accepted.
use super::*;

const CHILD_LIMIT: usize = 64;
const RESPONSE_LIMIT: usize = 32 * 1024;
const CHILD_TOOL_LIMIT: usize = 16;
const CHILD_INPUT_LIMIT: usize = 2 * 1024;
const CHILD_OUTPUT_LIMIT: usize = 4 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SubagentActivity {
    pub id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub prompt: String,
    pub status: String,
    pub response: String,
    pub tools: Vec<ToolActivity>,
    pub started_at: i64,
    pub updated_at: i64,
}

struct Child {
    activity: SubagentActivity,
    parser: Option<Box<Protocol>>,
    background: bool,
    response_from_result: bool,
    last_message_id: Option<String>,
    last_result_hash: Option<u64>,
}

#[derive(Default)]
pub(super) struct Subagents {
    children: HashMap<String, Child>,
    // Claude background task IDs alias the launching tool-use identity.
    aliases: HashMap<String, String>,
    dirty: HashSet<String>,
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}
fn active(status: &str) -> bool {
    matches!(status, "running" | "waiting")
}
fn status(value: &str) -> Option<&'static str> {
    match value {
        "running" | "pendingInit" | "pending" | "started" => Some("running"),
        "waiting" | "paused" => Some("waiting"),
        "completed" => Some("completed"),
        "failed" | "errored" | "notFound" => Some("failed"),
        "stopped" | "shutdown" | "interrupted" | "killed" => Some("stopped"),
        _ => None,
    }
}

impl Subagents {
    fn child(&mut self, id: &str, parent: Option<&str>) -> Option<&mut Child> {
        if id.is_empty() || id.len() > 256 {
            return None;
        }
        if !self.children.contains_key(id) {
            // Retire completed previews so later delegates remain visible; the
            // simultaneous active-child bound still never evicts running work.
            if self.children.len() >= CHILD_LIMIT {
                let retired = self
                    .children
                    .iter()
                    .filter(|(_, child)| !active(&child.activity.status))
                    .min_by_key(|(_, child)| child.activity.updated_at)
                    .map(|(id, _)| id.clone())?;
                self.children.remove(&retired);
                self.dirty.remove(&retired);
                self.aliases.retain(|_, id| id != &retired);
            }
            let time = now();
            self.children.insert(
                id.into(),
                Child {
                    activity: SubagentActivity {
                        id: id.into(),
                        parent_id: parent.map(str::to_owned),
                        name: "Subagent".into(),
                        prompt: String::new(),
                        status: "running".into(),
                        response: String::new(),
                        tools: Vec::new(),
                        started_at: time,
                        updated_at: time,
                    },
                    parser: None,
                    background: false,
                    response_from_result: false,
                    last_message_id: None,
                    last_result_hash: None,
                },
            );
            self.dirty.insert(id.into());
        }
        let child = self.children.get_mut(id)?;
        if child.activity.parent_id.is_none() && parent.is_some_and(|parent| parent != id) {
            child.activity.parent_id = parent.map(str::to_owned);
            self.dirty.insert(id.into());
        }
        Some(child)
    }
    fn changed(&mut self, id: &str) {
        if let Some(child) = self.children.get_mut(id) {
            child.activity.updated_at = now();
            self.dirty.insert(id.into());
        }
    }
    pub(super) fn flush(&mut self, protocol: &Protocol) -> Vec<AgentEvent> {
        self.dirty
            .drain()
            .filter_map(|id| {
                let child = self.children.get(&id)?;
                let mut event = protocol.event("subagent", "", None);
                event.data = serde_json::to_value(&child.activity).ok();
                Some(event)
            })
            .collect()
    }
    pub(super) fn observe_tools(
        &mut self,
        events: &[AgentEvent],
        parent: Option<&str>,
        _config: &RunConfig,
    ) {
        for tool in events.iter().filter_map(|event| event.tool.as_ref()) {
            // Kimi ACP titles are `Agent: <key argument>`; Claude uses Agent or Task.
            let name = tool.name.split(':').next().unwrap_or_default();
            if !matches!(name, "Agent" | "Task") && !self.children.contains_key(&tool.id) {
                continue;
            }
            let input: Value = serde_json::from_str(&tool.input).unwrap_or(Value::Null);
            let Some(child) = self.child(&tool.id, parent) else {
                continue;
            };
            let before = child.activity.clone();
            if let Some(name) = ["name", "description", "subagent_type"]
                .iter()
                .find_map(|key| input[*key].as_str().filter(|v| !v.is_empty()))
            {
                child.activity.name = limited(name, 256);
            }
            if let Some(prompt) = input["prompt"].as_str() {
                child.activity.prompt = limited(prompt, TOOL_INPUT_LIMIT);
            }
            child.background |= input["run_in_background"] == true;
            // A completed Agent launch may only mean a background worker was started.
            if active(&child.activity.status) && (!child.background || tool.status == "failed") {
                child.activity.status = tool.status.clone();
            }
            if !tool.output.is_empty() {
                Self::result_text(child, &tool.output);
            }
            if before != child.activity {
                self.changed(&tool.id);
            }
        }
    }
    fn result_text(child: &mut Child, text: &str) {
        use std::hash::{DefaultHasher, Hash, Hasher};
        let text = limited(text, RESPONSE_LIMIT);
        let mut digest = DefaultHasher::new();
        text.hash(&mut digest);
        let hash = digest.finish();
        if child.last_result_hash == Some(hash) {
            return;
        }
        child.last_result_hash = Some(hash);
        if child.activity.response.is_empty() || child.response_from_result {
            child.activity.response = text;
            child.response_from_result = true;
            return;
        }
        if let (Some(parser), Some(id)) = (&mut child.parser, &child.last_message_id) {
            let mut step = Step::default();
            parser.text_snapshot(id, None, &text, &mut step);
            let mut recovered = false;
            for event in step.events.into_iter().filter(|event| event.kind == "text") {
                append_preview(&mut child.activity.response, &event.text, RESPONSE_LIMIT);
                recovered = true;
            }
            if recovered {
                return;
            }
        }
        if child.activity.response.ends_with(&text) {
            return;
        }
        if let Some(suffix) = text.strip_prefix(&child.activity.response) {
            append_preview(&mut child.activity.response, suffix, RESPONSE_LIMIT);
        } else {
            append_preview(&mut child.activity.response, "\n\n", RESPONSE_LIMIT);
            append_preview(&mut child.activity.response, &text, RESPONSE_LIMIT);
        }
    }
    fn child_events(&mut self, id: &str, mut frame: Value, protocol: &Protocol) {
        let Some(child) = self.child(id, None) else {
            return;
        };
        let parser = child.parser.get_or_insert_with(|| {
            let mut config = protocol.config.clone();
            config.prompt.clear();
            config.images.clear();
            config.resume_id = None;
            let mut parser = Protocol::new(config);
            parser.subagents = None;
            parser.remote_id = id.into();
            parser.phase = 1;
            Box::new(parser)
        });
        // Claude's parent marker has already selected this isolated parser.
        if let Some(object) = frame.as_object_mut() {
            object.remove("parent_tool_use_id");
        }
        // A new child turn is unrelated to the parent's active turn.
        if frame["method"] == "turn/started" {
            parser.turn_id.clear();
        }
        let result = parser.receive(frame);
        // Apply the tighter child transcript bounds to retained parser previews too.
        while parser.tools.len() > CHILD_TOOL_LIMIT {
            if let Some(oldest) = parser.tool_order.pop_front() {
                parser.tools.remove(&oldest);
            }
        }
        for tool in parser.tools.values_mut() {
            tool.input = limited(&tool.input, CHILD_INPUT_LIMIT);
            tool.output = limited(&tool.output, CHILD_OUTPUT_LIMIT);
        }
        match result {
            Ok(step) => {
                let before = child.activity.clone();
                for event in &step.events {
                    if event.kind == "message_start" {
                        child.last_message_id = event
                            .data
                            .as_ref()
                            .and_then(|data| data["messageId"].as_str())
                            .map(str::to_owned);
                        if child.response_from_result {
                            child.activity.response.clear();
                            child.response_from_result = false;
                        }
                        if !child.activity.response.is_empty() {
                            append_preview(&mut child.activity.response, "\n\n", RESPONSE_LIMIT);
                        }
                    }
                    if (event.kind == "text" || event.tool.is_some())
                        && child.activity.status == "waiting"
                    {
                        child.activity.status = "running".into();
                    }
                    if event.kind == "text" {
                        append_preview(&mut child.activity.response, &event.text, RESPONSE_LIMIT);
                    }
                    if let Some(tool) = &event.tool {
                        let mut tool = tool.clone();
                        tool.input = limited(&tool.input, CHILD_INPUT_LIMIT);
                        tool.output = limited(&tool.output, CHILD_OUTPUT_LIMIT);
                        if let Some(existing) = child
                            .activity
                            .tools
                            .iter_mut()
                            .find(|old| old.id == tool.id)
                        {
                            *existing = tool;
                        } else {
                            if child.activity.tools.len() >= CHILD_TOOL_LIMIT {
                                child.activity.tools.remove(0);
                            }
                            child.activity.tools.push(tool);
                        }
                    }
                }
                if step.done {
                    child.activity.status = "completed".into();
                }
                if before != child.activity {
                    self.changed(id);
                }
                self.observe_tools(&step.events, Some(id), &protocol.config);
            }
            Err(error) => {
                child.activity.status = "failed".into();
                append_preview(&mut child.activity.response, &error, RESPONSE_LIMIT);
                self.changed(id);
            }
        }
    }
    pub(super) fn route(&mut self, frame: &mut Value, protocol: &Protocol) -> Option<Step> {
        match protocol.config.provider.as_str() {
            "codex" => self.codex(frame, protocol),
            "kimi" | "opencode" | "antigravity" | "grok" | "pi" | "deepseek" | "commandcode" | "cline" | "kilo" | "omp" | "github-copilot" | "muse" => {
                None
            } // ACP providers expose main-session progress; Agent results remain available.
            _ => self.claude(frame, protocol),
        }
    }
    fn claude(&mut self, frame: &mut Value, protocol: &Protocol) -> Option<Step> {
        let parent = field(frame, "parent_tool_use_id");
        if !parent.is_empty()
            && matches!(field(frame, "type"), "stream_event" | "assistant" | "user")
        {
            let parent = parent.to_owned();
            self.child_events(&parent, std::mem::take(frame), protocol);
            return Some(Step::default());
        }
        if frame["type"] == "control_request" && !parent.is_empty() {
            if let Some(child) = self.child(parent, None) {
                child.activity.status = "waiting".into();
                self.changed(parent);
            }
        }
        if frame["type"] != "system" {
            return None;
        }
        let subtype = field(frame, "subtype");
        if !matches!(
            subtype,
            "task_started" | "task_progress" | "task_notification" | "task_updated"
        ) {
            return None;
        }
        let task = field(frame, "task_id");
        let tool = field(frame, "tool_use_id");
        // Background Bash tasks use the same lifecycle envelope; never label them agents.
        let agent_type = matches!(field(frame, "task_type"), "local_agent" | "remote_agent");
        let id = if self.children.contains_key(tool) || agent_type && !tool.is_empty() {
            tool.to_owned()
        } else if let Some(id) = self.aliases.get(task) {
            id.clone()
        } else if agent_type {
            task.to_owned()
        } else {
            return None;
        };
        let child = self.child(&id, None)?;
        child.background = true;
        let before = child.activity.clone();
        if child.activity.name == "Subagent" {
            if let Some(name) = frame["description"].as_str().filter(|v| !v.is_empty()) {
                child.activity.name = limited(name, 256);
            }
        }
        let raw_status = if subtype == "task_updated" {
            field(&frame["patch"], "status")
        } else {
            field(frame, "status")
        };
        if let Some(status) = status(raw_status) {
            child.activity.status = status.into();
        }
        if let Some(summary) = frame["summary"].as_str().filter(|v| !v.is_empty()) {
            Self::result_text(child, summary);
        }
        let changed = before != child.activity;
        // Admission may retire an old alias at capacity; register the new task
        // after that retirement, including starts without a prior Agent block.
        if !task.is_empty() && self.aliases.len() < CHILD_LIMIT {
            self.aliases.insert(limited(task, 256), id.clone());
        }
        if changed {
            self.changed(&id);
        }
        None
    }
    fn codex(&mut self, frame: &mut Value, protocol: &Protocol) -> Option<Step> {
        let params = &frame["params"];
        let method = field(frame, "method");
        if method == "thread/started" {
            let thread = &params["thread"];
            let source = &thread["source"]["subAgent"]["thread_spawn"];
            let parent = field(source, "parent_thread_id");
            if parent == protocol.remote_id || self.children.contains_key(parent) {
                let id = field(thread, "id");
                if let Some(child) =
                    self.child(id, (parent != protocol.remote_id).then_some(parent))
                {
                    if let Some(name) = thread["agentNickname"]
                        .as_str()
                        .filter(|v| !v.is_empty())
                        .or_else(|| source["agent_nickname"].as_str().filter(|v| !v.is_empty()))
                    {
                        child.activity.name = limited(name, 256);
                    }
                    self.changed(id);
                }
            }
        }
        let owner = field(params, "threadId");
        let event_turn = params["turnId"]
            .as_str()
            .or_else(|| params["turn"]["id"].as_str());
        if owner == protocol.remote_id
            && !protocol.turn_id.is_empty()
            && event_turn.is_some_and(|turn| !turn.is_empty() && turn != protocol.turn_id)
        {
            return None;
        }
        let linked =
            owner == protocol.remote_id || self.children.contains_key(owner) || owner.is_empty();
        if linked && matches!(method, "item/started" | "item/completed") {
            self.codex_delegation(&params["item"], owner, protocol);
        }
        if owner.is_empty() || owner == protocol.remote_id || !self.children.contains_key(owner) {
            return None;
        }
        if frame.get("id").is_some() {
            // Keep real approval routing in the root parser.
            if method.ends_with("/requestApproval") {
                if let Some(child) = self.children.get_mut(owner) {
                    child.activity.status = "waiting".into();
                }
                self.changed(owner);
            }
            return None;
        }
        match method {
            "thread/status/changed" => {
                let state = &params["status"];
                let new_status = match field(state, "type") {
                    "active" => {
                        if state["activeFlags"]
                            .as_array()
                            .is_some_and(|flags| !flags.is_empty())
                        {
                            "waiting"
                        } else {
                            "running"
                        }
                    }
                    "systemError" => "failed",
                    "idle" => "completed",
                    "notLoaded" => "stopped",
                    _ => "",
                };
                if let Some(child) = self.children.get_mut(owner) {
                    if !new_status.is_empty() {
                        child.activity.status = new_status.into();
                        self.changed(owner);
                    }
                }
            }
            "turn/started" => {
                if let Some(child) = self.children.get_mut(owner) {
                    child.activity.status = "running".into();
                    self.changed(owner);
                }
                let owner = owner.to_owned();
                self.child_events(&owner, std::mem::take(frame), protocol);
            }
            "turn/completed" if params["turn"]["status"] == "interrupted" => {
                if let Some(child) = self.children.get_mut(owner) {
                    child.activity.status = "stopped".into();
                    self.changed(owner);
                }
            }
            _ => {
                let owner = owner.to_owned();
                self.child_events(&owner, std::mem::take(frame), protocol);
            }
        }
        Some(Step::default())
    }
    fn codex_delegation(&mut self, item: &Value, owner: &str, protocol: &Protocol) {
        let parent = (!owner.is_empty() && owner != protocol.remote_id).then_some(owner);
        match field(item, "type") {
            "collabAgentToolCall" => {
                for id in item["receiverThreadIds"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .take(CHILD_LIMIT)
                    .filter_map(Value::as_str)
                {
                    if id == protocol.remote_id {
                        continue;
                    }
                    let Some(child) = self.child(id, parent) else {
                        continue;
                    };
                    let before = child.activity.clone();
                    if child.activity.prompt.is_empty() {
                        child.activity.prompt = limited(field(item, "prompt"), TOOL_INPUT_LIMIT);
                    }
                    let state = &item["agentsStates"][id];
                    if let Some(status) = status(field(state, "status")) {
                        child.activity.status = status.into();
                    } else if matches!(
                        field(item, "tool"),
                        "sendInput" | "resumeAgent" | "followupTask"
                    ) {
                        child.activity.status = "running".into();
                    } else if item["status"] == "failed" && item["tool"] == "spawnAgent" {
                        child.activity.status = "failed".into();
                    }
                    if let Some(message) = state["message"].as_str().filter(|m| !m.is_empty()) {
                        // agentsStates.message is the child's latest result, useful even when
                        // this server version omits child-stream notifications.
                        Self::result_text(child, message);
                    }
                    if before != child.activity {
                        self.changed(id);
                    }
                }
            }
            "subAgentActivity" => {
                let id = field(item, "agentThreadId");
                let Some(child) = self.child(id, parent) else {
                    return;
                };
                let before = child.activity.clone();
                // agentPath is routing metadata, not the child's display name.
                if let Some(status) = status(field(item, "kind")) {
                    child.activity.status = status.into();
                }
                if before != child.activity {
                    self.changed(id);
                }
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn protocol(provider: &str) -> Protocol {
        let mut p = Protocol::new(super::super::tests::config(provider));
        p.remote_id = "root".into();
        p.turn_id = "turn-root".into();
        p.phase = 1;
        p
    }
    fn snapshot(step: &Step, id: &str) -> SubagentActivity {
        step.events
            .iter()
            .filter(|event| event.kind == "subagent")
            .filter_map(|event| {
                serde_json::from_value::<SubagentActivity>(event.data.clone().unwrap()).ok()
            })
            .find(|child| child.id == id)
            .expect("child snapshot")
    }
    fn spawn(p: &mut Protocol, id: &str) -> Step {
        p.receive(json!({"method":"item/completed","params":{"threadId":"root","turnId":"turn-root","item":{
            "type":"collabAgentToolCall","id":"spawn-call","tool":"spawnAgent","status":"completed","senderThreadId":"root",
            "receiverThreadIds":[id],"prompt":"Review the code","agentsStates":{id:{"status":"running","message":null}}
        }}})).unwrap()
    }
    #[test]
    fn claude_children_stream_text_and_work_independently_from_parent() {
        let mut p = protocol("claude");
        let started=p.receive(json!({"type":"assistant","message":{"id":"parent","content":[
            {"type":"tool_use","id":"agent-a","name":"Agent","input":{"name":"Newton","description":"Review","prompt":"Find the bug"}},
            {"type":"tool_use","id":"agent-b","name":"Task","input":{"description":"Tests","prompt":"Run checks"}}
        ]}})).unwrap();
        assert_eq!(snapshot(&started, "agent-a").name, "Newton");
        assert_eq!(snapshot(&started, "agent-b").prompt, "Run checks");
        for id in ["agent-a", "agent-b"] {
            p.receive(json!({"type":"stream_event","parent_tool_use_id":id,"event":{"type":"message_start","message":{"id":"same-message"}}})).unwrap();
            let streamed=p.receive(json!({"type":"stream_event","parent_tool_use_id":id,"event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":id}}})).unwrap();
            assert_eq!(snapshot(&streamed, id).response, id);
            assert!(!streamed
                .events
                .iter()
                .any(|event| matches!(event.kind.as_str(), "text" | "message_start" | "tool")));
            let final_snapshot=p.receive(json!({"type":"assistant","parent_tool_use_id":id,"message":{"id":"same-message","content":[{"type":"text","text":format!("{id} finished")},{"type":"tool_use","id":"same-tool","name":"Read","input":{"file_path":"README.md"}}]}})).unwrap();
            assert_eq!(
                snapshot(&final_snapshot, id).response,
                format!("{id} finished")
            );
            let work=p.receive(json!({"type":"user","parent_tool_use_id":id,"message":{"content":[{"type":"tool_result","tool_use_id":"same-tool","content":"File contents"}]}})).unwrap();
            assert_eq!(snapshot(&work, id).tools[0].output, "File contents");
        }
        let completed=p.receive(json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"agent-a","content":"agent-a finished"}]}})).unwrap();
        assert_eq!(snapshot(&completed, "agent-a").status, "completed");
        assert_eq!(
            p.subagents.as_ref().unwrap().children["agent-b"]
                .activity
                .status,
            "running"
        );
        let parent=p.receive(json!({"type":"assistant","message":{"id":"parent-answer","content":[{"type":"text","text":"Parent only"}]}})).unwrap();
        assert_eq!(
            parent
                .events
                .iter()
                .filter(|event| event.kind == "text")
                .map(|event| event.text.as_str())
                .collect::<String>(),
            "Parent only"
        );
    }
    #[test]
    fn claude_background_lifecycle_ignores_bash_and_handles_task_updated_without_notification() {
        let mut p = protocol("claude");
        let bash=p.receive(json!({"type":"system","subtype":"task_started","task_id":"shell","task_type":"local_bash","description":"Build"})).unwrap();
        assert!(bash.events.iter().all(|event| event.kind != "subagent"));
        p.receive(json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":"agent-tool","name":"Agent","input":{"name":"Newton","prompt":"Review","run_in_background":true}}]}})).unwrap();
        p.receive(json!({"type":"system","subtype":"task_started","task_id":"background-id","tool_use_id":"agent-tool","task_type":"local_agent","description":"Review code"})).unwrap();
        p.receive(json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"agent-tool","content":"Agent launched"}]}})).unwrap();
        assert_eq!(
            p.subagents.as_ref().unwrap().children["agent-tool"]
                .activity
                .status,
            "running"
        );
        assert_eq!(
            p.subagents.as_ref().unwrap().children["agent-tool"]
                .activity
                .name,
            "Newton"
        );
        let stopped=p.receive(json!({"type":"system","subtype":"task_updated","task_id":"background-id","patch":{"status":"killed","end_time":123}})).unwrap();
        assert_eq!(snapshot(&stopped, "agent-tool").status, "stopped");
        let late=p.receive(json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":"agent-tool","name":"Agent","input":{"prompt":"Review"}}]}})).unwrap();
        assert!(late
            .events
            .iter()
            .filter(|event| event.kind == "subagent")
            .all(|event| event.data.as_ref().unwrap()["status"] != "running"));
    }
    #[test]
    fn codex_spawn_status_is_not_child_completion_and_child_errors_are_isolated() {
        let mut p = protocol("codex");
        assert_eq!(snapshot(&spawn(&mut p, "a"), "a").status, "running");
        spawn(&mut p, "b");
        for id in ["a", "b"] {
            p.receive(json!({"method":"turn/started","params":{"threadId":id,"turn":{"id":format!("turn-{id}")}}})).unwrap();
            let output=p.receive(json!({"method":"item/agentMessage/delta","params":{"threadId":id,"turnId":format!("turn-{id}"),"itemId":"same-message","delta":id}})).unwrap();
            assert_eq!(snapshot(&output, id).response, id);
            assert!(output.events.iter().all(|event| event.kind == "subagent"));
        }
        let failed=p.receive(json!({"method":"turn/completed","params":{"threadId":"a","turn":{"id":"turn-a","status":"failed","error":{"message":"Child failed"}}}})).unwrap();
        assert!(!failed.done);
        assert_eq!(snapshot(&failed, "a").status, "failed");
        assert_eq!(p.turn_id, "turn-root");
        assert_eq!(
            p.subagents.as_ref().unwrap().children["b"].activity.status,
            "running"
        );
        let stopped=p.receive(json!({"method":"turn/completed","params":{"threadId":"b","turn":{"id":"turn-b","status":"interrupted"}}})).unwrap();
        assert_eq!(snapshot(&stopped, "b").status, "stopped");
    }
    #[test]
    fn codex_thread_creation_precedes_spawn_result_and_supports_nested_children() {
        let mut p = protocol("codex");
        let created=p.receive(json!({"method":"thread/started","params":{"thread":{"id":"child","agentNickname":"Newton","source":{"subAgent":{"thread_spawn":{"parent_thread_id":"root","depth":1}}}}}})).unwrap();
        assert_eq!(snapshot(&created, "child").name, "Newton");
        for (id, expected) in [("child", "Newton"), ("unnamed", "Subagent")] {
            let activity = p
                .receive(json!({"method":"item/completed","params":{
                    "threadId":"root","turnId":"turn-root","item":{
                        "type":"subAgentActivity","id":"activity","agentThreadId":id,
                        "agentPath":"/root/reviewer","kind":"waiting"
                    }
                }}))
                .unwrap();
            assert_eq!(snapshot(&activity, id).name, expected);
        }
        let nested=p.receive(json!({"method":"thread/started","params":{"thread":{"id":"nested","agentNickname":"Euler","source":{"subAgent":{"thread_spawn":{"parent_thread_id":"child","depth":2}}}}}})).unwrap();
        assert_eq!(
            snapshot(&nested, "nested").parent_id.as_deref(),
            Some("child")
        );
        let unknown=p.receive(json!({"method":"item/agentMessage/delta","params":{"threadId":"unrelated","itemId":"msg","delta":"Other session"}})).unwrap();
        assert!(unknown.events.is_empty());
        let waiting=p.receive(json!({"method":"thread/status/changed","params":{"threadId":"child","status":{"type":"active","activeFlags":["waitingOnApproval"]}}})).unwrap();
        assert_eq!(snapshot(&waiting, "child").status, "waiting");
        let result=p.receive(json!({"method":"item/completed","params":{"threadId":"root","turnId":"turn-root","item":{"type":"collabAgentToolCall","tool":"wait","id":"wait-call","status":"completed","receiverThreadIds":["child"],"senderThreadId":"root","agentsStates":{"child":{"status":"completed","message":"Review complete"}}}}})).unwrap();
        assert_eq!(snapshot(&result, "child").response, "Review complete");
        assert_eq!(snapshot(&result, "child").status, "completed");
    }
    #[test]
    fn kimi_acp_tracks_agent_invocation_and_result_without_invented_child_streams() {
        let mut p = protocol("kimi");
        let start=p.receive(json!({"method":"session/update","params":{"sessionId":"root","update":{"sessionUpdate":"tool_call","toolCallId":"turn/agent","title":"Agent: explore","status":"in_progress","content":[{"type":"content","content":{"type":"text","text":"{\"subagent_type\":\"explore\",\"prompt\":\"Find files\"}"}}]}}})).unwrap();
        assert_eq!(snapshot(&start, "turn/agent").prompt, "Find files");
        let result=p.receive(json!({"method":"session/update","params":{"sessionId":"root","update":{"sessionUpdate":"tool_call_update","toolCallId":"turn/agent","status":"completed","content":[{"type":"content","content":{"type":"text","text":"Found three files"}}]}}})).unwrap();
        assert_eq!(
            snapshot(&result, "turn/agent").response,
            "Found three files"
        );
        assert_eq!(snapshot(&result, "turn/agent").status, "completed");
        assert!(snapshot(&result, "turn/agent").tools.is_empty());
    }
    #[test]
    fn child_approval_resumes_and_results_recover_suffix_without_duplicate_replays() {
        for provider in ["claude", "codex"] {
            let mut p = protocol(provider);
            if provider == "codex" {
                spawn(&mut p, "child");
            } else {
                p.receive(json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":"child","name":"Agent","input":{}}]}})).unwrap();
            }
            let approval = if provider == "codex" {
                json!({"id":70,"method":"item/commandExecution/requestApproval","params":{"threadId":"child","command":"cargo test"}})
            } else {
                json!({"type":"control_request","request_id":"child-approval","parent_tool_use_id":"child","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"cargo test"}}})
            };
            let waiting = p.receive(approval).unwrap();
            assert_eq!(snapshot(&waiting, "child").status, "waiting");
            let request = waiting
                .events
                .iter()
                .find(|event| event.kind == "approval")
                .unwrap()
                .request_id
                .as_ref()
                .unwrap();
            assert!(p.approve(request, true).is_some());
            if provider == "claude" {
                p.receive(json!({"type":"stream_event","parent_tool_use_id":"child","event":{"type":"message_start","message":{"id":"answer"}}})).unwrap();
            }
            let delta = if provider == "codex" {
                json!({"method":"item/agentMessage/delta","params":{"threadId":"child","itemId":"answer","delta":"Hello"}})
            } else {
                json!({"type":"stream_event","parent_tool_use_id":"child","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}})
            };
            let resumed = p.receive(delta).unwrap();
            assert_eq!(snapshot(&resumed, "child").status, "running");
            let final_result = if provider == "codex" {
                json!({"method":"item/completed","params":{"threadId":"root","turnId":"turn-root","item":{"type":"collabAgentToolCall","tool":"wait","id":"wait","status":"completed","senderThreadId":"root","receiverThreadIds":["child"],"agentsStates":{"child":{"status":"completed","message":"Hello world"}}}}})
            } else {
                json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"child","content":"Hello world"}]}})
            };
            let completed = p.receive(final_result.clone()).unwrap();
            assert_eq!(snapshot(&completed, "child").response, "Hello world");
            assert_eq!(snapshot(&completed, "child").status, "completed");
            p.receive(final_result).unwrap();
            let replay = if provider == "codex" {
                json!({"method":"item/completed","params":{"threadId":"child","item":{"type":"agentMessage","id":"answer","text":"Hello world"}}})
            } else {
                json!({"type":"assistant","parent_tool_use_id":"child","message":{"id":"answer","content":[{"type":"text","text":"Hello world"}]}})
            };
            p.receive(replay).unwrap();
            assert_eq!(
                p.subagents.as_ref().unwrap().children["child"]
                    .activity
                    .response,
                "Hello world"
            );
        }
    }
    #[test]
    fn kimi_final_result_replaces_earlier_output_preview() {
        let mut p = protocol("kimi");
        p.receive(json!({"method":"session/update","params":{"sessionId":"root","update":{"sessionUpdate":"tool_call","toolCallId":"agent","title":"Agent","status":"in_progress","rawInput":{"prompt":"Review"},"rawOutput":"Agent started"}}})).unwrap();
        let result=p.receive(json!({"method":"session/update","params":{"sessionId":"root","update":{"sessionUpdate":"tool_call_update","toolCallId":"agent","title":"Reviewing the implementation","status":"completed","rawOutput":"Review complete"}}})).unwrap();
        assert_eq!(snapshot(&result, "agent").response, "Review complete");
    }
    #[test]
    fn stale_codex_parent_delegation_cannot_create_or_revive_child() {
        let mut p = protocol("codex");
        let stale=p.receive(json!({"method":"item/completed","params":{"threadId":"root","turnId":"old-turn","item":{"type":"collabAgentToolCall","id":"old","tool":"spawnAgent","status":"completed","senderThreadId":"root","receiverThreadIds":["old-child"],"agentsStates":{"old-child":{"status":"running"}}}}})).unwrap();
        assert!(stale.events.is_empty());
        assert!(p.subagents.as_ref().unwrap().children.is_empty());
    }
    #[test]
    fn sequential_children_retire_terminal_entries_and_their_task_aliases() {
        let mut p = protocol("claude");
        for index in 0..CHILD_LIMIT + 12 {
            let id = format!("agent-{index}");
            let task = format!("background-{index}");
            let started = p.receive(json!({"type":"assistant","message":{"id":format!("message-{index}"),"content":[{"type":"tool_use","id":id,"name":"Agent","input":{"description":"Review","run_in_background":true}}]}})).unwrap();
            assert_eq!(snapshot(&started, &id).status, "running");
            p.receive(json!({"type":"system","subtype":"task_started","task_id":task,"tool_use_id":id,"task_type":"local_agent"})).unwrap();
            if index != 0 {
                let completed=p.receive(json!({"type":"system","subtype":"task_notification","task_id":task,"status":"completed","summary":"Done"})).unwrap();
                assert_eq!(snapshot(&completed, &id).status, "completed");
            }
            // Deterministic age ordering without sleeps.
            p.subagents
                .as_mut()
                .unwrap()
                .children
                .get_mut(&id)
                .unwrap()
                .activity
                .updated_at = index as i64;
        }
        let tracker = p.subagents.as_ref().unwrap();
        assert_eq!(tracker.children.len(), CHILD_LIMIT);
        assert_eq!(tracker.children["agent-0"].activity.status, "running");
        assert!(!tracker.children.contains_key("agent-1"));
        assert!(!tracker.aliases.contains_key("background-1"));
        assert!(tracker
            .aliases
            .contains_key(&format!("background-{}", CHILD_LIMIT + 11)));
        assert!(tracker
            .aliases
            .values()
            .all(|id| tracker.children.contains_key(id)));
        p.receive(json!({"type":"system","subtype":"task_started","task_id":"direct-task","tool_use_id":"direct-child","task_type":"local_agent"})).unwrap();
        let completed=p.receive(json!({"type":"system","subtype":"task_notification","task_id":"direct-task","status":"completed","summary":"Done"})).unwrap();
        assert_eq!(snapshot(&completed, "direct-child").status, "completed");
    }
    #[test]
    fn child_storage_is_bounded_and_keeps_existing_active_children() {
        let mut p = protocol("codex");
        for n in 0..CHILD_LIMIT + 10 {
            spawn(&mut p, &format!("child-{n}"));
        }
        assert_eq!(p.subagents.as_ref().unwrap().children.len(), CHILD_LIMIT);
        assert!(p
            .subagents
            .as_ref()
            .unwrap()
            .children
            .contains_key("child-0"));
        for _ in 0..8 {
            p.receive(json!({"method":"item/agentMessage/delta","params":{"threadId":"child-0","itemId":"message","delta":"🦀".repeat(16_384)}})).unwrap();
        }
        for n in 0..40 {
            p.receive(json!({"method":"item/completed","params":{"threadId":"child-0","item":{"type":"commandExecution","id":format!("tool-{n}"),"command":"x".repeat(10_000),"aggregatedOutput":"y".repeat(20_000),"exitCode":0}}})).unwrap();
        }
        let child = &p.subagents.as_ref().unwrap().children["child-0"];
        assert!(child.activity.response.len() <= RESPONSE_LIMIT);
        assert!(child.activity.response.ends_with(PREVIEW_TRUNCATED));
        assert_eq!(child.activity.tools.len(), CHILD_TOOL_LIMIT);
        assert!(child
            .activity
            .tools
            .iter()
            .all(|tool| tool.input.len() <= CHILD_INPUT_LIMIT
                && tool.output.len() <= CHILD_OUTPUT_LIMIT));
        assert_eq!(child.parser.as_ref().unwrap().tools.len(), CHILD_TOOL_LIMIT);
    }
}
