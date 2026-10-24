//! Steering: a message for an agent while its run is open. Steering never stops
//! the run. Claude Code takes it on stream input (mid-turn at the next tool
//! boundary, or as a following turn of the same process); Codex through
//! `turn/steer` on the active turn; Pi through its `steer` command; Muse through
//! MSP `turn/steer` (`muse.rs`); ACP harnesses in `acp.rs`. When no turn can take it (startup, between turns, refused), the
//! run holds it and sends it as the next turn of the same session the moment the
//! current turn ends. Each steer reports `steer` events: `pending` with its mode
//! on acceptance, `delivered` once the harness takes it, and `failed` if the run
//! ends first, so the app can queue it again.

use super::goals::RpcReply;
use super::*;

const MAX_STEER_BYTES: usize = 128 * 1024;
const MAX_STEERS: usize = 16;
/// Codex `turn/steer` request ids, clear of startup ids, cancel (900), ACP steers and goals (10000 up).
const CODEX_STEER_IDS: u64 = 1 << 40;

#[derive(Default)]
pub(super) struct Steers {
    /// Sent into a running turn, waiting for the harness to echo it: (id, text, mode).
    live: Vec<(String, String, &'static str)>,
    /// Waiting for the next turn of this run: (id, text).
    held: Vec<(String, String)>,
    /// Unanswered Codex `turn/steer` requests: (steer id, text, reply).
    requests: HashMap<u64, (String, String, RpcReply)>,
    next_request: u64,
    /// The turn ended while a steer request was unanswered; the answer decides what follows.
    turn_over: bool,
}

/// Text blocks of a user message given as a string or a content array.
fn texts(content: &Value) -> Vec<&str> {
    match content {
        Value::String(text) => vec![text.as_str()],
        Value::Array(blocks) => blocks.iter().filter(|block| block["type"] == "text").filter_map(|block| block["text"].as_str()).collect(),
        _ => Vec::new(),
    }
}

impl Protocol {
    fn claude_family(&self) -> bool {
        matches!(self.config.provider.as_str(), "claude" | "glm" | "mimo")
    }

    pub(super) fn steer(&mut self, id: String, text: String, reply: RpcReply) -> Step {
        if matches!(self.config.provider.as_str(), "kimi" | "opencode" | "antigravity" | "grok" | "deepseek" | "commandcode" | "cline" | "kilo" | "github-copilot") {
            return self.acp_steer(id, text, reply);
        }
        let mut step = Step::default();
        let text = text.trim().to_owned();
        if text.is_empty() || text.len() > MAX_STEER_BYTES {
            let _ = reply.send(Err("Write a steering message under 128 KiB.".into()));
            return step;
        }
        let waiting = self.steers.live.len() + self.steers.held.len() + self.steers.requests.len() + self.pi.steers.len() + self.muse_steer_count();
        if waiting >= MAX_STEERS {
            let _ = reply.send(Err("Too many steering messages are waiting; the message stays queued.".into()));
            return step;
        }
        match self.config.provider.as_str() {
            // Before the opening prompt is written the steer would overtake it; it follows the prompt instead.
            _ if self.claude_family() && self.phase == 0 => self.accept(id, text, "next-turn", reply, &mut step),
            _ if self.claude_family() => {
                step.write.push(self.claude_input(&text));
                self.accept(id, text, "live", reply, &mut step);
            }
            "codex" if !self.remote_id.is_empty() && !self.turn_id.is_empty() => {
                let request = CODEX_STEER_IDS + self.steers.next_request;
                self.steers.next_request += 1;
                step.write.push(json!({"id":request,"method":"turn/steer","params":{"threadId":self.remote_id,"expectedTurnId":self.turn_id,"input":[{"type":"text","text":text,"text_elements":[]}]}}));
                self.steers.requests.insert(request, (id, text, reply));
            }
            "codex" => self.accept(id, text, "next-turn", reply, &mut step),
            "pi" | "omp" => return self.pi_steer(id, text, reply),
            "muse" => return self.muse_steer(id, text, reply),
            _ => {
                let _ = reply.send(Err("This agent cannot be steered; the message stays queued.".into()));
            }
        }
        step
    }

    /// Reports an accepted steer and keeps it until the harness takes it.
    pub(super) fn accept(&mut self, id: String, text: String, mode: &'static str, reply: RpcReply, step: &mut Step) {
        step.events.push(self.steer_event(&id, &text, "pending", mode));
        let _ = reply.send(Ok(json!({"steered":true,"id":id,"mode":mode})));
        if mode == "live" {
            self.steers.live.push((id, text, mode));
        } else {
            self.steers.held.push((id, text));
        }
    }

    fn claude_input(&self, text: &str) -> Value {
        let mut request = json!({"type":"user","message":{"role":"user","content":[{"type":"text","text":text}]},"parent_tool_use_id":null});
        if !self.remote_id.is_empty() {
            request["session_id"] = json!(self.remote_id);
        }
        request
    }

    /// Writes steers that arrived before Claude's opening prompt right after it.
    pub(super) fn claude_send_held(&mut self, step: &mut Step) {
        for (id, text) in std::mem::take(&mut self.steers.held) {
            step.write.push(self.claude_input(&text));
            self.steers.live.push((id, text, "next-turn"));
        }
    }

    /// True while Claude owes a turn for a steer it has not echoed yet.
    pub(super) fn claude_steers_open(&self) -> bool {
        !self.steers.live.is_empty()
    }

    /// The harness echoed a user message: the live steers it carries are delivered.
    pub(super) fn steers_consumed(&mut self, content: &Value, step: &mut Step) -> bool {
        let mut found = false;
        for text in texts(content) {
            if let Some(index) = self.steers.live.iter().position(|(_, steer, _)| steer == text.trim()) {
                let (id, text, mode) = self.steers.live.remove(index);
                step.events.push(self.steer_event(&id, &text, "delivered", mode));
                found = true;
            }
        }
        found
    }

    /// The harness took the live steer `id`.
    pub(super) fn steer_delivered(&mut self, id: &str, step: &mut Step) {
        if let Some(index) = self.steers.live.iter().position(|(steer, _, _)| steer == id) {
            let (id, text, mode) = self.steers.live.remove(index);
            step.events.push(self.steer_event(&id, &text, "delivered", mode));
        }
    }

    /// Claude echoes the opening prompt first; each later echo is a consumed steer.
    pub(super) fn claude_replay(&mut self, content: &Value, step: &mut Step) {
        if self.steers_consumed(content, step) {
            return;
        }
        if !self.prompt_replayed {
            self.prompt_replayed = true;
        } else if !self.steers.live.is_empty() {
            // Claude merged or reworded it; the oldest steer is the one it took.
            let (id, text, mode) = self.steers.live.remove(0);
            step.events.push(self.steer_event(&id, &text, "delivered", mode));
        }
    }

    /// Codex answered a `turn/steer`: steered live, or held for the next turn when its turn was over.
    pub(super) fn codex_steer_response(&mut self, value: &Value, step: &mut Step) -> bool {
        let Some((id, text, reply)) = value["id"].as_u64().and_then(|request| self.steers.requests.remove(&request)) else {
            return false;
        };
        let mode = if value.get("result").is_some() { "live" } else { "next-turn" };
        self.accept(id, text, mode, reply, step);
        self.steer_answered(step);
        true
    }

    /// Called after each steer answer: a turn that ended while it was open continues now.
    pub(super) fn steer_answered(&mut self, step: &mut Step) {
        if self.steers.turn_over && self.steers.requests.is_empty() && self.pi.steers.is_empty() {
            self.steers.turn_over = false;
            self.next_steered_turn(step);
        }
    }

    /// A Codex or Pi turn ended cleanly (Muse calls `next_steered_turn` itself). Held steers become the next turn of this
    /// session instead of the run finishing.
    pub(super) fn steer_turn_end(&mut self, step: &mut Step) {
        if !step.done || step.failure.is_some() {
            return;
        }
        if !self.steers.requests.is_empty() || !self.pi.steers.is_empty() {
            step.done = false;
            self.steers.turn_over = true;
            return;
        }
        self.next_steered_turn(step);
    }

    pub(super) fn next_steered_turn(&mut self, step: &mut Step) {
        if matches!(self.config.provider.as_str(), "pi" | "omp") {
            // Pi takes a queued steer before its next model call; one still here never reached it.
            let missed: Vec<_> = self.steers.live.drain(..).map(|(id, text, _)| (id, text)).collect();
            self.steers.held.extend(missed);
        }
        if self.steers.held.is_empty() {
            step.done = true;
            return;
        }
        step.done = false;
        let held = std::mem::take(&mut self.steers.held);
        let text = held.iter().map(|(_, text)| text.as_str()).collect::<Vec<_>>().join("\n\n");
        if self.config.provider == "codex" {
            self.config.prompt = text;
            if let Err(error) = self.codex_prompt(step) {
                step.failure = Some(error);
            }
        } else if self.config.provider == "muse" {
            self.config.prompt = text;
            self.muse_turn(step);
        } else {
            self.pi.settled = false;
            step.write.push(json!({"type":"prompt","id":"pandacode-prompt","message":text}));
        }
        for (id, text) in held {
            step.events.push(self.steer_event(&id, &text, "delivered", "next-turn"));
        }
    }

    /// The run ended. Steers it never delivered are reported failed so the app can
    /// queue them again; after a clean finish, an accepted live steer was taken.
    pub(super) fn steers_ended(&mut self, clean: bool) -> Vec<AgentEvent> {
        let mut events = self.acp_steers_failed().events;
        for (id, text, mode) in std::mem::take(&mut self.steers.live) {
            events.push(self.steer_event(&id, &text, if clean { "delivered" } else { "failed" }, mode));
        }
        for (id, text) in std::mem::take(&mut self.steers.held) {
            events.push(self.steer_event(&id, &text, "failed", "next-turn"));
        }
        // Unanswered requests drop their replies; the app keeps those messages queued.
        self.steers.requests.clear();
        self.pi.steers.clear();
        events
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::config;
    use super::*;

    fn steer(protocol: &mut Protocol, text: &str) -> (Step, tokio::sync::oneshot::Receiver<Result<Value, String>>) {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let id = format!("steer-{text}");
        (protocol.steer(id, text.into(), tx), rx)
    }

    fn steer_events(step: &Step) -> Vec<(String, String)> {
        step.events
            .iter()
            .filter(|event| event.kind == "steer")
            .map(|event| {
                let data = event.data.as_ref().unwrap();
                (data["status"].as_str().unwrap().to_owned(), data["mode"].as_str().unwrap().to_owned())
            })
            .collect()
    }

    fn pair(status: &str, mode: &str) -> (String, String) {
        (status.into(), mode.into())
    }

    #[test]
    fn claude_steers_on_stream_input_and_waits_for_a_late_steer_turn() {
        let mut p = Protocol::new(config("claude"));
        p.phase = 1;
        p.remote_id = "session".into();
        let (step, mut reply) = steer(&mut p, "  also add tests  ");
        assert_eq!(step.write.len(), 1);
        assert_eq!(step.write[0]["type"], "user");
        assert_eq!(step.write[0]["message"]["content"][0]["text"], "also add tests");
        assert_eq!(step.write[0]["session_id"], "session");
        assert_eq!(reply.try_recv().unwrap().unwrap(), json!({"steered":true,"id":"steer-  also add tests  ","mode":"live"}));
        assert_eq!(steer_events(&step), [pair("pending", "live")]);
        // The opening prompt is echoed first; it is not a steering message.
        let step = p.receive(json!({"type":"user","isReplay":true,"message":{"role":"user","content":"original"}})).unwrap();
        assert!(steer_events(&step).is_empty());
        // A result before the steer is echoed means Claude will answer it in another turn.
        let early = p.receive(json!({"type":"result","subtype":"success","result":"first answer"})).unwrap();
        assert!(!early.done, "the run stays open for the steered turn");
        let step = p.receive(json!({"type":"user","isReplay":true,"message":{"role":"user","content":[{"type":"text","text":"also add tests"}]}})).unwrap();
        assert_eq!(steer_events(&step), [pair("delivered", "live")]);
        assert!(p.receive(json!({"type":"result","subtype":"success","result":"done"})).unwrap().done);
    }

    #[test]
    fn claude_steer_consumed_mid_turn_finishes_with_one_result() {
        let mut p = Protocol::new(config("glm"));
        p.phase = 1;
        let _ = steer(&mut p, "steer");
        for text in ["prompt", "steer"] {
            p.receive(json!({"type":"user","isReplay":true,"message":{"role":"user","content":[{"type":"text","text":text}]}})).unwrap();
        }
        assert!(p.receive(json!({"type":"result","subtype":"success","result":"ok"})).unwrap().done);
    }

    #[test]
    fn claude_holds_a_steer_until_the_opening_prompt_is_written() {
        let mut p = Protocol::new(config("claude"));
        let (step, mut reply) = steer(&mut p, "early");
        assert!(step.write.is_empty(), "nothing may overtake the opening prompt");
        assert_eq!(reply.try_recv().unwrap().unwrap()["mode"], "next-turn");
        let step = p.receive(json!({"type":"control_response","response":{"subtype":"success","request_id":"pandacode-init","response":{}}})).unwrap();
        let users: Vec<_> = step.write.iter().filter(|frame| frame["type"] == "user").collect();
        assert_eq!(users.len(), 2);
        assert_eq!(users[1]["message"]["content"][0]["text"], "early");
        p.receive(json!({"type":"user","isReplay":true,"message":{"role":"user","content":"Explain this project"}})).unwrap();
        assert!(!p.receive(json!({"type":"result","subtype":"success","result":"a"})).unwrap().done);
        let step = p.receive(json!({"type":"user","isReplay":true,"message":{"role":"user","content":[{"type":"text","text":"early"}]}})).unwrap();
        assert_eq!(steer_events(&step), [pair("delivered", "next-turn")]);
        assert!(p.receive(json!({"type":"result","subtype":"success","result":"b"})).unwrap().done);
    }

    #[test]
    fn a_failed_or_stopped_run_reports_undelivered_steers() {
        let mut p = Protocol::new(config("claude"));
        p.phase = 1;
        let _ = steer(&mut p, "never echoed");
        assert!(p.receive(json!({"type":"result","subtype":"error_during_execution","is_error":true,"result":"boom"})).is_err());
        let events = p.steers_ended(false);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].data.as_ref().unwrap()["status"], "failed");
        assert_eq!(events[0].text, "never echoed");
        assert!(p.steers_ended(false).is_empty(), "reported once");
    }

    #[test]
    fn codex_steers_the_active_turn_live() {
        let mut p = Protocol::new(config("codex"));
        p.phase = 1;
        p.remote_id = "thread-1".into();
        p.turn_id = "turn-7".into();
        let (step, mut reply) = steer(&mut p, "focus on the parser");
        let request = step.write.iter().find(|request| request["method"] == "turn/steer").expect("turn/steer request");
        assert_eq!(request["params"]["expectedTurnId"], "turn-7");
        assert_eq!(request["params"]["threadId"], "thread-1");
        assert_eq!(request["params"]["input"][0]["text"], "focus on the parser");
        let id = request["id"].clone();
        let step = p.receive(json!({"id":id,"result":{"turnId":"turn-7"}})).unwrap();
        assert_eq!(steer_events(&step), [pair("pending", "live")]);
        assert_eq!(reply.try_recv().unwrap().unwrap()["mode"], "live");
        // Recorded from codex app-server: the steer is echoed as a userMessage item when consumed.
        let step = p.receive(json!({"method":"item/started","params":{"threadId":"thread-1","turnId":"turn-7","item":{"type":"userMessage","id":"u2","content":[{"type":"text","text":"focus on the parser","text_elements":[]}]}}})).unwrap();
        assert_eq!(steer_events(&step), [pair("delivered", "live")]);
        let end = p.receive(json!({"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-7","status":"completed"}}})).unwrap();
        assert!(end.done);
    }

    #[test]
    fn codex_holds_a_steer_for_the_next_turn_of_the_same_thread() {
        let mut p = Protocol::new(config("codex"));
        p.phase = 1;
        p.remote_id = "thread-1".into();
        // No turn yet: held instead of refused.
        let (step, mut early) = steer(&mut p, "first steer");
        assert!(step.write.is_empty());
        assert_eq!(early.try_recv().unwrap().unwrap()["mode"], "next-turn");
        p.turn_id = "turn-7".into();
        // A turn/steer that loses the race with the turn's end is refused, then held.
        let (step, mut late) = steer(&mut p, "second steer");
        let id = step.write[0]["id"].clone();
        let end = p.receive(json!({"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-7","status":"completed"}}})).unwrap();
        assert!(!end.done, "the run waits for the steer's answer");
        let next = p.receive(json!({"id":id,"error":{"code":-32600,"message":"no active turn"}})).unwrap();
        assert!(!next.done, "the run continues with the steered turn");
        assert_eq!(late.try_recv().unwrap().unwrap()["mode"], "next-turn");
        let turn = next.write.iter().find(|request| request["method"] == "turn/start").expect("next turn");
        assert_eq!(turn["params"]["threadId"], "thread-1");
        assert_eq!(turn["params"]["input"][0]["text"], "first steer\n\nsecond steer");
        assert_eq!(steer_events(&next), [pair("pending", "next-turn"), pair("delivered", "next-turn"), pair("delivered", "next-turn")]);
        p.receive(json!({"method":"turn/started","params":{"threadId":"thread-1","turn":{"id":"turn-8"}}})).unwrap();
        assert!(p.receive(json!({"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-8","status":"completed"}}})).unwrap().done);
    }

    #[test]
    fn pi_steers_live_and_holds_when_not_streaming() {
        let mut idle = Protocol::new(config("pi"));
        let (step, mut reply) = steer(&mut idle, "too early");
        assert!(step.write.is_empty());
        assert_eq!(reply.try_recv().unwrap().unwrap()["mode"], "next-turn");

        let mut p = Protocol::new(config("pi"));
        p.phase = 1;
        let (step, mut accepted) = steer(&mut p, " check the docs ");
        assert_eq!(step.write[0]["type"], "steer");
        assert_eq!(step.write[0]["message"], "check the docs");
        let id = step.write[0]["id"].as_str().unwrap().to_owned();
        let (step, mut refused) = steer(&mut p, "second");
        let refused_id = step.write[0]["id"].clone();
        let step = p.receive(json!({"type":"response","command":"steer","id":id,"success":true,"data":{"disposition":"queued"}})).unwrap();
        assert_eq!(steer_events(&step), [pair("pending", "live")]);
        assert_eq!(accepted.try_recv().unwrap().unwrap()["mode"], "live");
        // A refused steer never fails the run; it waits for the next turn.
        let step = p.receive(json!({"type":"response","command":"steer","id":refused_id,"success":false,"error":"Not streaming"})).unwrap();
        assert!(!step.done);
        assert_eq!(refused.try_recv().unwrap().unwrap()["mode"], "next-turn");
        let step = p.receive(json!({"type":"message_start","message":{"role":"user","content":[{"type":"text","text":"check the docs"}]}})).unwrap();
        assert_eq!(steer_events(&step), [pair("delivered", "live")]);
        p.receive(json!({"type":"agent_settled","aborted":false})).unwrap();
        let (step, mut late) = steer(&mut p, "after settling");
        assert!(step.write.is_empty());
        assert_eq!(late.try_recv().unwrap().unwrap()["mode"], "next-turn");
        let next = p.receive(json!({"type":"response","command":"get_session_stats","id":"pandacode-usage","success":true,"data":{}})).unwrap();
        assert!(!next.done);
        assert_eq!(next.write[0]["type"], "prompt");
        assert_eq!(next.write[0]["message"], "second\n\nafter settling");
        p.receive(json!({"type":"agent_settled","aborted":false})).unwrap();
        assert!(p.receive(json!({"type":"response","command":"get_session_stats","id":"pandacode-usage","success":true,"data":{}})).unwrap().done);
    }

    #[test]
    fn acp_harnesses_steer_and_empty_messages_are_refused() {
        for provider in ["kimi", "opencode", "kilo", "grok", "antigravity", "deepseek", "commandcode"] {
            let mut p = Protocol::new(config(provider));
            let (_, mut reply) = steer(&mut p, "hello");
            assert!(reply.try_recv().unwrap().is_ok(), "{provider} holds the steer");
        }
        let mut p = Protocol::new(config("claude"));
        p.phase = 1;
        let (_, mut reply) = steer(&mut p, "   ");
        assert!(reply.try_recv().unwrap().is_err());
    }
}
