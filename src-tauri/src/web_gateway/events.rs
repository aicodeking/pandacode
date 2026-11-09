use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    sync::Mutex,
};
use tokio::sync::broadcast;

const EVENT_REPLAY: usize = 2048;
const EVENT_REPLAY_BYTES: usize = 16 * 1024 * 1024;
const EVENT_SUBSCRIBERS: usize = 256;
const ACTIVE_SESSIONS: usize = 64;
const ACTIVE_TEXT_BYTES: usize = 256 * 1024;
const ACTIVE_TOOLS: usize = 128;
const ACTIVE_REQUESTS: usize = 32;
const ACTIVE_VALUE_BYTES: usize = 256 * 1024;
const ACTIVE_SESSION_BYTES: usize = 768 * 1024;
const ACTIVE_TOTAL_BYTES: usize = 8 * 1024 * 1024;

/// Events mirrored to browser clients. Payloads are already JSON values so the gateway never
/// forwards Tauri's internal callback/channel representation.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Event {
    pub sequence: u64,
    #[serde(rename = "type")]
    pub event_type: String,
    pub payload: Value,
}

#[derive(Clone, Debug, Serialize)]
pub struct SnapshotEvent {
    #[serde(rename = "type")]
    pub event_type: &'static str,
    pub payload: Value,
}

/// A coherent reconstruction point for active agent UI state. Records deliberately have no
/// individual sequence: the top-level sequence is the barrier after which WebSocket replay starts.
#[derive(Clone, Debug, Serialize)]
pub struct RuntimeSnapshot {
    pub sequence: u64,
    pub events: Vec<SnapshotEvent>,
    pub truncated: bool,
}

#[derive(Debug, Default)]
struct ActiveSession {
    route: RouteKey,
    last_sequence: u64,
    partial: String,
    thinking: String,
    value_bytes: usize,
    status: Option<Value>,
    usage: Option<Value>,
    tools: HashMap<String, Value>,
    tool_order: VecDeque<String>,
    approvals: HashMap<String, Value>,
    approval_order: VecDeque<String>,
    inputs: HashMap<String, Value>,
    input_order: VecDeque<String>,
    truncated: bool,
}

#[derive(Clone, Debug, Default, Eq, Hash, Ord, PartialEq, PartialOrd)]
struct RouteKey {
    session_id: String,
    worker_id: Option<String>,
    subagent_id: Option<String>,
}

impl RouteKey {
    fn from_payload(payload: &Value) -> Result<Self, ()> {
        let session_id = route_id(payload, "sessionId", true)?.ok_or(())?;
        Ok(Self {
            session_id,
            worker_id: route_id(payload, "workerId", false)?,
            subagent_id: route_id(payload, "subagentId", false)?,
        })
    }
}

impl ActiveSession {
    fn reset(&mut self, sequence: u64, route: &RouteKey) {
        let status = routed_agent_payload(route, "status", "running");
        *self = Self {
            route: route.clone(),
            last_sequence: sequence,
            value_bytes: value_size(&status),
            status: Some(status),
            ..Self::default()
        };
    }

    fn remember(
        values: &mut HashMap<String, Value>,
        order: &mut VecDeque<String>,
        key: String,
        value: Value,
        limit: usize,
        bytes: &mut usize,
    ) -> bool {
        if values.contains_key(&key) {
            if let Some(previous) = values.insert(key.clone(), value) {
                *bytes = bytes.saturating_sub(value_size(&previous));
            }
            *bytes = bytes.saturating_add(values.get(&key).map_or(0, value_size));
            return false;
        }
        let mut dropped = false;
        if order.len() == limit {
            if let Some(oldest) = order.pop_front() {
                if let Some(previous) = values.remove(&oldest) {
                    *bytes = bytes.saturating_sub(value_size(&previous));
                }
                dropped = true;
            }
        }
        order.push_back(key.clone());
        *bytes = bytes.saturating_add(value_size(&value));
        values.insert(key, value);
        dropped
    }

    fn forget(
        values: &mut HashMap<String, Value>,
        order: &mut VecDeque<String>,
        key: &str,
        bytes: &mut usize,
    ) {
        if let Some(previous) = values.remove(key) {
            *bytes = bytes.saturating_sub(value_size(&previous));
        }
        if let Some(index) = order.iter().position(|candidate| candidate == key) {
            order.remove(index);
        }
    }

    fn snapshot_events(&self, events: &mut Vec<SnapshotEvent>) {
        let mut push = |payload: Value| {
            events.push(SnapshotEvent {
                event_type: "agent-event",
                payload,
            });
        };
        if let Some(status) = &self.status {
            push(status.clone());
        }
        for id in &self.tool_order {
            if let Some(tool) = self.tools.get(id) {
                push(tool.clone());
            }
        }
        if !self.partial.is_empty() {
            push(routed_agent_payload(&self.route, "message_start", ""));
            push(routed_agent_payload(&self.route, "text", &self.partial));
        }
        if !self.thinking.is_empty() {
            push(routed_agent_payload(
                &self.route,
                "thinking",
                &self.thinking,
            ));
        }
        if let Some(usage) = &self.usage {
            push(usage.clone());
        }
        for id in &self.approval_order {
            if let Some(approval) = self.approvals.get(id) {
                push(approval.clone());
            }
        }
        for id in &self.input_order {
            if let Some(input) = self.inputs.get(id) {
                push(input.clone());
            }
        }
    }
}

#[derive(Debug)]
struct Log {
    next: u64,
    replay: VecDeque<Event>,
    replay_bytes: usize,
    dropped: u64,
    active: HashMap<RouteKey, ActiveSession>,
    truncated: bool,
}

pub struct EventHub {
    log: Mutex<Log>,
    sender: broadcast::Sender<Event>,
}

impl Default for EventHub {
    fn default() -> Self {
        let (sender, _) = broadcast::channel(EVENT_SUBSCRIBERS);
        Self {
            log: Mutex::new(Log {
                next: 0,
                replay: VecDeque::with_capacity(EVENT_REPLAY),
                replay_bytes: 0,
                dropped: 0,
                active: HashMap::new(),
                truncated: false,
            }),
            sender,
        }
    }
}

impl EventHub {
    pub fn push(&self, event_type: impl Into<String>, payload: Value) -> Event {
        let event = {
            let mut log = self.log.lock().unwrap_or_else(|error| error.into_inner());
            log.next = log.next.saturating_add(1);
            let event = Event {
                sequence: log.next,
                event_type: event_type.into(),
                payload,
            };
            reduce_active(&mut log, &event);
            let bytes = event_size(&event);
            while log.replay.len() == EVENT_REPLAY
                || log.replay_bytes.saturating_add(bytes) > EVENT_REPLAY_BYTES
            {
                let Some(removed) = log.replay.pop_front() else {
                    break;
                };
                log.replay_bytes = log.replay_bytes.saturating_sub(event_size(&removed));
                log.dropped = removed.sequence;
            }
            if bytes <= EVENT_REPLAY_BYTES {
                log.replay_bytes = log.replay_bytes.saturating_add(bytes);
                log.replay.push_back(event.clone());
            } else {
                log.dropped = event.sequence;
            }
            event
        };
        let _ = self.sender.send(event.clone());
        event
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.sender.subscribe()
    }

    pub fn replay_after(&self, sequence: u64) -> Replay {
        let log = self.log.lock().unwrap_or_else(|error| error.into_inner());
        let oldest = log
            .replay
            .front()
            .map_or(log.next.saturating_add(1), |event| event.sequence);
        if sequence < log.dropped || sequence.saturating_add(1) < oldest {
            Replay::Resync { latest: log.next }
        } else {
            Replay::Events(
                log.replay
                    .iter()
                    .filter(|event| event.sequence > sequence)
                    .cloned()
                    .collect(),
            )
        }
    }

    pub fn runtime_snapshot(&self, session_id: Option<&str>) -> RuntimeSnapshot {
        let log = self.log.lock().unwrap_or_else(|error| error.into_inner());
        let mut active = log
            .active
            .iter()
            .filter(|(route, _)| {
                session_id.is_none_or(|wanted| wanted == route.session_id.as_str())
            })
            .collect::<Vec<_>>();
        active.sort_by(|(left_route, left), (right_route, right)| {
            (left.last_sequence, *left_route).cmp(&(right.last_sequence, *right_route))
        });
        let mut events = Vec::new();
        let mut truncated = log.truncated;
        for (_, state) in active {
            truncated |= state.truncated;
            state.snapshot_events(&mut events);
        }
        RuntimeSnapshot {
            sequence: log.next,
            events,
            truncated,
        }
    }

    pub fn latest(&self) -> u64 {
        self.log
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .next
    }
}

fn reduce_active(log: &mut Log, event: &Event) {
    if event.event_type != "agent-event" {
        return;
    }
    let route = match RouteKey::from_payload(&event.payload) {
        Ok(route) => route,
        Err(()) => {
            log.truncated = true;
            return;
        }
    };
    let kind = event
        .payload
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if kind == "done" {
        log.active.remove(&route);
        if log.active.is_empty() {
            log.truncated = false;
        }
        return;
    }
    if matches!(kind, "approval_cancelled" | "input_cancelled") {
        let Some(state) = log.active.get_mut(&route) else {
            return;
        };
        if let Some(request_id) = event.payload.get("requestId").and_then(Value::as_str) {
            if kind == "approval_cancelled" {
                ActiveSession::forget(
                    &mut state.approvals,
                    &mut state.approval_order,
                    request_id,
                    &mut state.value_bytes,
                );
            } else {
                ActiveSession::forget(
                    &mut state.inputs,
                    &mut state.input_order,
                    request_id,
                    &mut state.value_bytes,
                );
            }
        }
        state.last_sequence = event.sequence;
        return;
    }
    if !matches!(
        kind,
        "turn_start"
            | "message_start"
            | "text"
            | "thinking"
            | "tool"
            | "status"
            | "usage"
            | "approval"
            | "input_request"
    ) {
        return;
    }
    if !log.active.contains_key(&route) && log.active.len() == ACTIVE_SESSIONS {
        if let Some(oldest) = log
            .active
            .iter()
            .min_by_key(|(_, state)| state.last_sequence)
            .map(|(id, _)| id.clone())
        {
            log.active.remove(&oldest);
            log.truncated = true;
        }
    }
    let state = log.active.entry(route.clone()).or_default();
    if state.route.session_id.is_empty() {
        state.route = route.clone();
    }
    state.last_sequence = event.sequence;
    match kind {
        "turn_start" => state.reset(event.sequence, &route),
        "message_start" => {
            state.partial.clear();
            state.thinking.clear();
        }
        "text" => {
            if let Some(text) = event.payload.get("text").and_then(Value::as_str) {
                state.partial.push_str(text);
                if truncate_tail(&mut state.partial, ACTIVE_TEXT_BYTES) {
                    state.truncated = true;
                }
            }
        }
        "thinking" => {
            if let Some(text) = event.payload.get("text").and_then(Value::as_str) {
                state.thinking.push_str(text);
                if truncate_tail(&mut state.thinking, ACTIVE_TEXT_BYTES) {
                    state.truncated = true;
                }
            }
        }
        "tool" => {
            if value_size(&event.payload) > ACTIVE_VALUE_BYTES {
                state.truncated = true;
                return;
            }
            let key = event
                .payload
                .get("tool")
                .and_then(|tool| tool.get("id"))
                .and_then(Value::as_str)
                .map(str::to_owned)
                .unwrap_or_else(|| format!("event:{}", event.sequence));
            let dropped = ActiveSession::remember(
                &mut state.tools,
                &mut state.tool_order,
                key,
                event.payload.clone(),
                ACTIVE_TOOLS,
                &mut state.value_bytes,
            );
            state.truncated |= dropped;
        }
        "status" => {
            if event.payload.get("text").and_then(Value::as_str) == Some("Stopping agent") {
                state.value_bytes = state
                    .value_bytes
                    .saturating_sub(state.approvals.values().map(value_size).sum::<usize>())
                    .saturating_sub(state.inputs.values().map(value_size).sum::<usize>());
                state.approvals.clear();
                state.approval_order.clear();
                state.inputs.clear();
                state.input_order.clear();
            }
            let status = if value_size(&event.payload) <= ACTIVE_VALUE_BYTES {
                event.payload.clone()
            } else {
                state.truncated = true;
                routed_agent_payload(&route, "status", "Working…")
            };
            if let Some(previous) = state.status.replace(status) {
                state.value_bytes = state.value_bytes.saturating_sub(value_size(&previous));
            }
            state.value_bytes = state
                .value_bytes
                .saturating_add(state.status.as_ref().map_or(0, value_size));
        }
        "usage" => {
            if value_size(&event.payload) <= ACTIVE_VALUE_BYTES {
                if let Some(previous) = state.usage.replace(event.payload.clone()) {
                    state.value_bytes = state.value_bytes.saturating_sub(value_size(&previous));
                }
                state.value_bytes = state
                    .value_bytes
                    .saturating_add(state.usage.as_ref().map_or(0, value_size));
            } else {
                state.truncated = true;
            }
        }
        "approval" | "input_request" => {
            let Some(request_id) = event
                .payload
                .get("requestId")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty() && id.len() <= 256)
                .map(str::to_owned)
            else {
                state.truncated = true;
                return;
            };
            if value_size(&event.payload) > ACTIVE_VALUE_BYTES {
                state.truncated = true;
                return;
            }
            if kind == "approval" {
                let dropped = ActiveSession::remember(
                    &mut state.approvals,
                    &mut state.approval_order,
                    request_id,
                    event.payload.clone(),
                    ACTIVE_REQUESTS,
                    &mut state.value_bytes,
                );
                state.truncated |= dropped;
            } else {
                let dropped = ActiveSession::remember(
                    &mut state.inputs,
                    &mut state.input_order,
                    request_id,
                    event.payload.clone(),
                    ACTIVE_REQUESTS,
                    &mut state.value_bytes,
                );
                state.truncated |= dropped;
            }
        }
        _ => {}
    }
    enforce_active_bounds(log);
}

fn enforce_active_bounds(log: &mut Log) {
    for state in log.active.values_mut() {
        while active_size(state) > ACTIVE_SESSION_BYTES {
            let removed = if let Some(id) = state.tool_order.pop_front() {
                if let Some(previous) = state.tools.remove(&id) {
                    state.value_bytes = state.value_bytes.saturating_sub(value_size(&previous));
                }
                true
            } else if let Some(id) = state.approval_order.pop_front() {
                if let Some(previous) = state.approvals.remove(&id) {
                    state.value_bytes = state.value_bytes.saturating_sub(value_size(&previous));
                }
                true
            } else if let Some(id) = state.input_order.pop_front() {
                if let Some(previous) = state.inputs.remove(&id) {
                    state.value_bytes = state.value_bytes.saturating_sub(value_size(&previous));
                }
                true
            } else {
                false
            };
            if !removed {
                break;
            }
            state.truncated = true;
        }
    }
    while log.active.values().map(active_size).sum::<usize>() > ACTIVE_TOTAL_BYTES {
        let Some(oldest) = log
            .active
            .iter()
            .min_by_key(|(_, state)| state.last_sequence)
            .map(|(id, _)| id.clone())
        else {
            break;
        };
        log.active.remove(&oldest);
        log.truncated = true;
    }
}

fn active_size(state: &ActiveSession) -> usize {
    state
        .partial
        .len()
        .saturating_add(state.thinking.len())
        .saturating_add(state.value_bytes)
}

fn route_id(payload: &Value, name: &str, required: bool) -> Result<Option<String>, ()> {
    match payload.get(name) {
        None | Some(Value::Null) if !required => Ok(None),
        Some(Value::String(id))
            if !id.is_empty() && id.len() <= 256 && !id.chars().any(char::is_control) =>
        {
            Ok(Some(id.clone()))
        }
        _ => Err(()),
    }
}

fn routed_agent_payload(route: &RouteKey, kind: &str, text: &str) -> Value {
    let mut payload = json!({
        "sessionId": route.session_id.clone(),
        "kind": kind,
        "text": text,
        "requestId": null,
        "data": null
    });
    if let Some(worker_id) = &route.worker_id {
        payload["workerId"] = Value::String(worker_id.clone());
    }
    if let Some(subagent_id) = &route.subagent_id {
        payload["subagentId"] = Value::String(subagent_id.clone());
    }
    payload
}

#[cfg(test)]
fn agent_payload(session_id: &str, kind: &str, text: &str) -> Value {
    routed_agent_payload(
        &RouteKey {
            session_id: session_id.to_owned(),
            ..RouteKey::default()
        },
        kind,
        text,
    )
}

fn value_size(value: &Value) -> usize {
    serde_json::to_vec(value).map_or(usize::MAX, |bytes| bytes.len())
}

fn event_size(event: &Event) -> usize {
    event
        .event_type
        .len()
        .saturating_add(value_size(&event.payload))
        .saturating_add(32)
}

fn truncate_tail(text: &mut String, limit: usize) -> bool {
    if text.len() <= limit {
        return false;
    }
    let mut start = text.len() - limit;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    text.drain(..start);
    true
}

pub enum Replay {
    Events(Vec<Event>),
    Resync { latest: u64 },
}

/// Only these application events cross the web boundary. Adding an event requires reviewing its
/// payload for credentials, local-only paths and viewer ownership.
pub const ALLOWED_EVENTS: &[&str] = &[
    "agent-event",
    "agent-ui-action",
    "agent-update-progress",
    "architect-event",
    "bot-failover",
    "bot-messages-changed",
    "bot-model-switch",
    "bot-notification",
    "bot-pairing",
    "bot-shared-channel-changed",
    "bots-changed",
    "cloud-setup",
    "design-changed",
    "jev-frame",
    "jev-install",
    "jev-run",
    "machine-link-request",
    "machine-link-settled",
    "mirror-messages",
    "orchestration://status",
    "provider-models-changed",
    "queue-changed",
    "remote://device-grants",
    "remote://device-pending",
    "remote://pair-code-used",
    "remote://presence",
    "remote://start-note",
    "remote://start-progress",
    "remote://status",
    "schedules-changed",
    "sessions-changed",
    "sessions-deleted",
    "simulator-changed",
    "terminal-event",
    "vm-changed",
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_are_ordered_and_replayable() {
        let hub = EventHub::default();
        assert_eq!(hub.push("one", json!(1)).sequence, 1);
        assert_eq!(hub.push("two", json!(2)).sequence, 2);
        let Replay::Events(events) = hub.replay_after(1) else {
            panic!("unexpected resync")
        };
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_type, "two");
    }

    #[test]
    fn runtime_snapshot_reduces_active_agent_state_at_one_sequence() {
        let hub = EventHub::default();
        hub.push("agent-event", agent_payload("one", "turn_start", ""));
        hub.push("agent-event", agent_payload("one", "text", "Hello "));
        hub.push("agent-event", agent_payload("one", "text", "world"));
        hub.push(
            "agent-event",
            json!({"sessionId":"one","kind":"tool","text":"Read","tool":{"id":"tool-1","name":"Read","status":"running","input":"a","output":""}}),
        );
        hub.push(
            "agent-event",
            json!({"sessionId":"one","kind":"tool","text":"Read","tool":{"id":"tool-1","name":"Read","status":"complete","input":"a","output":"ok"}}),
        );
        hub.push(
            "agent-event",
            json!({"sessionId":"one","kind":"approval","text":"Run?","requestId":"ask-1","data":null}),
        );
        hub.push("sessions-changed", json!(null));

        let snapshot = hub.runtime_snapshot(None);
        assert_eq!(snapshot.sequence, 7);
        assert!(!snapshot.truncated);
        assert_eq!(snapshot.events.len(), 5);
        assert_eq!(snapshot.events[0].payload["kind"], "status");
        assert_eq!(snapshot.events[1].payload["tool"]["status"], "complete");
        assert_eq!(snapshot.events[2].payload["kind"], "message_start");
        assert_eq!(snapshot.events[3].payload["text"], "Hello world");
        assert_eq!(snapshot.events[4].payload["requestId"], "ask-1");

        hub.push(
            "agent-event",
            json!({"sessionId":"one","kind":"approval_cancelled","text":"","requestId":"ask-1","data":null}),
        );
        assert_eq!(hub.runtime_snapshot(None).events.len(), 4);
        hub.push("agent-event", agent_payload("one", "done", "complete"));
        assert!(hub.runtime_snapshot(None).events.is_empty());
    }

    #[test]
    fn runtime_snapshot_filter_uses_the_same_global_barrier() {
        let hub = EventHub::default();
        hub.push("agent-event", agent_payload("one", "text", "one"));
        hub.push("agent-event", agent_payload("two", "text", "two"));
        let snapshot = hub.runtime_snapshot(Some("two"));
        assert_eq!(snapshot.sequence, 2);
        assert!(snapshot
            .events
            .iter()
            .all(|event| event.payload["sessionId"] == "two"));
    }

    #[test]
    fn runtime_snapshot_keeps_worker_routes_and_live_text_separate() {
        let hub = EventHub::default();
        for (worker, text) in [("worker-a", "alpha"), ("worker-b", "beta")] {
            hub.push(
                "agent-event",
                json!({"sessionId":"parent","workerId":worker,"kind":"turn_start","text":""}),
            );
            hub.push(
                "agent-event",
                json!({"sessionId":"parent","workerId":worker,"kind":"text","text":text}),
            );
        }
        hub.push(
            "agent-event",
            json!({"sessionId":"parent","workerId":"worker-b","kind":"thinking","text":"checking"}),
        );
        hub.push(
            "agent-event",
            json!({"sessionId":"parent","workerId":"worker-b","kind":"usage","text":"","data":{"used":12}}),
        );

        let snapshot = hub.runtime_snapshot(Some("parent"));
        let routed = snapshot
            .events
            .iter()
            .filter_map(|event| {
                let worker = event.payload["workerId"].as_str()?;
                let kind = event.payload["kind"].as_str()?;
                Some((
                    worker,
                    kind,
                    event.payload["text"].as_str().unwrap_or_default(),
                ))
            })
            .collect::<Vec<_>>();
        assert!(routed.contains(&("worker-a", "text", "alpha")));
        assert!(routed.contains(&("worker-b", "text", "beta")));
        assert!(routed.contains(&("worker-b", "thinking", "checking")));
        assert!(snapshot.events.iter().any(|event| {
            event.payload["workerId"] == "worker-b" && event.payload["kind"] == "usage"
        }));
        assert!(!routed
            .iter()
            .any(|(worker, _, text)| *worker == "worker-a" && text.contains("beta")));

        hub.push(
            "agent-event",
            json!({"sessionId":"parent","workerId":"worker-a","kind":"done","text":"complete"}),
        );
        let remaining = hub.runtime_snapshot(Some("parent"));
        assert!(remaining
            .events
            .iter()
            .all(|event| { event.payload["workerId"].as_str() == Some("worker-b") }));
    }
}
