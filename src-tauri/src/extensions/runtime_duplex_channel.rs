//! Duplex channel between the host and a background service (`runtime.service`, runtime phase R2, slice R0201).
//!
//! Framing: a 4-byte little-endian length, then one JSON object of at most 2 MiB. Two kinds of traffic share the
//! one pipe and never wait for each other:
//! - service to host: `{schemaVersion, token, id, method, params}`, answered by `{id, reply}` (the shape the short
//!   activation protocol already uses, so `panda.context.*` behaves the same);
//! - host to service: `{call: {id, method, params}}`, answered by `{schemaVersion, token, reply: {id, ok, value|error}}`.
//!
//! Each direction has its own bounds, for predictability and fault isolation (never for trust): at most 64 calls
//! pending and an average of 200 requests per second over a 10 second window. The state here is pure (no I/O, an
//! injected clock) so the bounds, id correlation and settlement are deterministic to test; the process loop that
//! uses it lives in `runtime_service_lifetime.rs`, and `src/extensions/runtime-duplex-channel.ts` mirrors the rules
//! for the browser preview.
use serde_json::{json, Map, Value};
use std::{collections::{BTreeMap, BTreeSet, VecDeque}, time::{Duration, Instant}};
use tokio::io::{AsyncRead, AsyncReadExt};

/// Largest frame body either side may send.
pub const MAX_FRAME_BYTES: usize = 2 * 1024 * 1024;
/// Calls pending per direction.
pub const MAX_PENDING: usize = 64;
/// Requests per second, averaged over `RATE_WINDOW`.
pub const RATE_PER_SECOND: usize = 200;
pub const RATE_WINDOW: Duration = Duration::from_secs(10);

pub type Result<T> = std::result::Result<T, &'static str>;

/// Sliding-window request budget: `RATE_PER_SECOND * RATE_WINDOW` requests in any window.
#[derive(Default)]
pub struct Budget { stamps: VecDeque<Instant> }
impl Budget {
    pub fn admit(&mut self, now: Instant) -> Result<()> {
        while self.stamps.front().is_some_and(|stamp| now.saturating_duration_since(*stamp) >= RATE_WINDOW) { self.stamps.pop_front(); }
        if self.stamps.len() >= RATE_PER_SECOND * RATE_WINDOW.as_secs() as usize { return Err("LimitExceeded"); }
        self.stamps.push_back(now);
        Ok(())
    }
}

/// Correlation state of one service connection. `W` is whatever settles a host call (a oneshot sender in the
/// process loop, a plain value in tests).
pub struct Channel<W> {
    next: u64,
    /// Host to service calls awaiting a reply.
    calls: BTreeMap<u64, W>,
    /// Service to host requests being served (ids are unique while in flight).
    served: BTreeSet<u64>,
    outbound: Budget,
    inbound: Budget,
}
impl<W> Default for Channel<W> {
    fn default() -> Self { Self { next: 0, calls: BTreeMap::new(), served: BTreeSet::new(), outbound: Budget::default(), inbound: Budget::default() } }
}
impl<W> Channel<W> {
    pub fn pending_calls(&self) -> usize { self.calls.len() }
    pub fn pending_requests(&self) -> usize { self.served.len() }

    /// Registers a host to service call. The id is never reused in this connection. The waiter comes back with the
    /// refusal so the caller can settle it.
    pub fn begin_call(&mut self, now: Instant, waiter: W) -> std::result::Result<u64, (&'static str, W)> {
        if self.calls.len() >= MAX_PENDING { return Err(("LimitExceeded", waiter)); }
        if let Err(code) = self.outbound.admit(now) { return Err((code, waiter)); }
        self.next += 1;
        self.calls.insert(self.next, waiter);
        Ok(self.next)
    }
    /// Takes the waiter of `id`. A late, repeated or unknown id returns `None` and touches no other call.
    pub fn settle(&mut self, id: u64) -> Option<W> { self.calls.remove(&id) }
    /// Settles every outstanding call (disconnect, disable, trust loss), oldest first.
    pub fn settle_all(&mut self) -> Vec<(u64, W)> { std::mem::take(&mut self.calls).into_iter().collect() }

    /// Admits a service to host request. `InvalidShape` for an id already in flight, `LimitExceeded` over the bounds.
    pub fn begin_request(&mut self, id: u64, now: Instant) -> Result<()> {
        if self.served.contains(&id) { return Err("InvalidShape"); }
        if self.served.len() >= MAX_PENDING { return Err("LimitExceeded"); }
        self.inbound.admit(now)?;
        self.served.insert(id);
        Ok(())
    }
    /// `true` when `id` was in flight.
    pub fn finish_request(&mut self, id: u64) -> bool { self.served.remove(&id) }
}

/// What the service wrote.
#[derive(Debug, PartialEq)]
pub enum Incoming {
    Request { schema_version: u64, token: String, id: u64, method: String, params: Value },
    Reply { schema_version: u64, token: String, id: u64, result: std::result::Result<Value, String> },
}

fn exact(object: &Map<String, Value>, keys: &[&str]) -> bool { object.len() == keys.len() && keys.iter().all(|key| object.contains_key(*key)) }

/// Classifies one frame. Anything that is not exactly a request or a reply is `InvalidShape`; the checks of the
/// token and of the request sequence stay with the caller.
pub fn classify(raw: &Value) -> Result<Incoming> {
    let object = raw.as_object().ok_or("InvalidShape")?;
    let schema_version = object.get("schemaVersion").and_then(Value::as_u64).ok_or("InvalidShape")?;
    let token = object.get("token").and_then(Value::as_str).ok_or("InvalidShape")?.to_owned();
    if let Some(reply) = object.get("reply") {
        if !exact(object, &["schemaVersion", "token", "reply"]) { return Err("InvalidShape"); }
        let reply = reply.as_object().ok_or("InvalidShape")?;
        let id = reply.get("id").and_then(Value::as_u64).ok_or("InvalidShape")?;
        let result = match reply.get("ok").and_then(Value::as_bool).ok_or("InvalidShape")? {
            true if exact(reply, &["id", "ok", "value"]) => Ok(reply["value"].clone()),
            false if exact(reply, &["id", "ok", "error"]) => Err(reply["error"]["code"].as_str().filter(|code| !code.is_empty() && code.len() <= 64 && code.chars().all(|c| c.is_ascii_alphanumeric())).unwrap_or("HostUnavailable").to_owned()),
            _ => return Err("InvalidShape"),
        };
        return Ok(Incoming::Reply { schema_version, token, id, result });
    }
    if !exact(object, &["schemaVersion", "token", "id", "method", "params"]) { return Err("InvalidShape"); }
    let id = object["id"].as_u64().ok_or("InvalidShape")?;
    let method = object["method"].as_str().ok_or("InvalidShape")?.to_owned();
    Ok(Incoming::Request { schema_version, token, id, method, params: object["params"].clone() })
}

/// Maps a settled call's error code onto the static vocabulary of the host; anything else is `HostUnavailable`.
pub fn known_code(code: &str) -> &'static str {
    ["PermissionDenied", "LimitExceeded", "Cancelled", "HostUnavailable", "StaleContext", "InvalidShape", "Timeout", "UnsupportedCapability", "UnsupportedRuntime", "IncompatibleApi"]
        .into_iter().find(|known| *known == code).unwrap_or("HostUnavailable")
}

/// The host to service frame of one call.
pub fn call_frame(id: u64, method: &str, params: &Value) -> Value { json!({"call": {"id": id, "method": method, "params": params}}) }
/// The host's answer to a service request (`reply` is the broker envelope `{ok, value|error}`).
pub fn answer_frame(id: u64, reply: &Value) -> Value { json!({"id": id, "reply": reply}) }

/// Serialises one frame body. `LimitExceeded` over 2 MiB (exactly 2 MiB still fits).
pub fn encode(value: &Value) -> Result<Vec<u8>> {
    let body = serde_json::to_vec(value).map_err(|_| "InvalidShape")?;
    if body.len() > MAX_FRAME_BYTES { return Err("LimitExceeded"); }
    let mut frame = Vec::with_capacity(body.len() + 4);
    frame.extend_from_slice(&(body.len() as u32).to_le_bytes());
    frame.extend_from_slice(&body);
    Ok(frame)
}

/// Reads one frame. An empty or over-2-MiB length is `LimitExceeded` before any body is read.
pub async fn read_frame(reader: &mut (impl AsyncRead + Unpin)) -> Result<Value> {
    let length = reader.read_u32_le().await.map_err(|_| "HostUnavailable")? as usize;
    if length == 0 || length > MAX_FRAME_BYTES { return Err("LimitExceeded"); }
    let mut bytes = vec![0; length];
    reader.read_exact(&mut bytes).await.map_err(|_| "HostUnavailable")?;
    serde_json::from_slice(&bytes).map_err(|_| "InvalidShape")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(now: Instant, millis: u64) -> Instant { now + Duration::from_millis(millis) }

    #[test]
    fn calls_are_correlated_by_id_and_a_late_or_repeated_reply_resolves_nothing() {
        let now = Instant::now();
        let mut channel = Channel::<&str>::default();
        let (a, b, c) = (channel.begin_call(now, "a").unwrap(), channel.begin_call(now, "b").unwrap(), channel.begin_call(now, "c").unwrap());
        assert_eq!((a, b, c), (1, 2, 3));
        // Out of order: the second call answers first.
        assert_eq!(channel.settle(b), Some("b"));
        assert_eq!(channel.settle(b), None, "a repeated id resolves nothing");
        assert_eq!(channel.settle(99), None, "an unknown id resolves nothing");
        assert_eq!(channel.settle(0), None);
        assert_eq!(channel.pending_calls(), 2);
        assert_eq!(channel.settle(c), Some("c")); assert_eq!(channel.settle(a), Some("a"));
        // Ids are never reused after a settle.
        assert_eq!(channel.begin_call(now, "d").unwrap(), 4);
    }

    #[test]
    fn the_64_pending_calls_bound_is_per_direction_and_frees_with_each_settle() {
        let now = Instant::now();
        let mut channel = Channel::<u64>::default();
        for index in 0..MAX_PENDING as u64 { channel.begin_call(now, index).unwrap(); }
        assert_eq!(channel.begin_call(now, 64).unwrap_err(), ("LimitExceeded", 64), "the refused waiter comes back");
        for id in 0..MAX_PENDING as u64 { channel.begin_request(id, now).unwrap(); }
        assert_eq!(channel.begin_request(64, now), Err("LimitExceeded"), "the request direction has its own 64");
        assert!(channel.finish_request(0)); assert!(!channel.finish_request(0));
        channel.begin_request(64, now).unwrap();
        assert!(channel.settle(1).is_some());
        channel.begin_call(now, 65).unwrap();
    }

    #[test]
    fn a_duplicate_request_id_in_flight_is_refused_without_disturbing_the_first() {
        let now = Instant::now();
        let mut channel = Channel::<()>::default();
        channel.begin_request(7, now).unwrap();
        assert_eq!(channel.begin_request(7, now), Err("InvalidShape"));
        assert_eq!(channel.pending_requests(), 1);
        assert!(channel.finish_request(7));
        channel.begin_request(7, now).unwrap();
    }

    #[test]
    fn two_hundred_requests_per_second_averaged_over_ten_seconds_per_direction() {
        let start = Instant::now();
        let budget = RATE_PER_SECOND * RATE_WINDOW.as_secs() as usize;
        let mut channel = Channel::<()>::default();
        // Settle each call at once so only the rate, never the pending bound, can refuse.
        for index in 0..budget as u64 {
            let id = channel.begin_call(at(start, index / 4), ()).unwrap(); channel.settle(id);
            channel.begin_request(index, at(start, index / 4)).unwrap(); channel.finish_request(index);
        }
        assert_eq!(channel.begin_call(at(start, 600), ()).unwrap_err().0, "LimitExceeded");
        assert_eq!(channel.begin_request(budget as u64, at(start, 600)), Err("LimitExceeded"));
        // The window slides: once the oldest stamps are 10 s old, budget returns.
        assert!(channel.begin_call(at(start, 10_000), ()).is_ok(), "the oldest request left the window");
        assert!(channel.begin_request(budget as u64 + 1, at(start, 10_000)).is_ok());
        // A burst above 200 in one second is fine while the 10 s average stays at or below 200.
        let mut quiet = Channel::<()>::default();
        for index in 0..400u64 { let id = quiet.begin_call(at(start, index), ()).unwrap(); quiet.settle(id); }
    }

    #[test]
    fn disconnect_settles_every_outstanding_call_oldest_first_and_leaves_nothing() {
        let now = Instant::now();
        let mut channel = Channel::<&str>::default();
        for name in ["a", "b", "c"] { channel.begin_call(now, name).unwrap(); }
        channel.begin_request(1, now).unwrap();
        assert_eq!(channel.settle_all(), vec![(1, "a"), (2, "b"), (3, "c")]);
        assert_eq!(channel.pending_calls(), 0);
        assert_eq!(channel.settle(1), None);
        assert!(channel.settle_all().is_empty());
    }

    #[test]
    fn the_frame_boundary_is_two_mebibytes_exactly() {
        let body = |size: usize| { let overhead = serde_json::to_vec(&json!({"v": ""})).unwrap().len(); json!({"v": "x".repeat(size - overhead)}) };
        let exact = encode(&body(MAX_FRAME_BYTES)).unwrap();
        assert_eq!(exact.len(), MAX_FRAME_BYTES + 4);
        assert_eq!(u32::from_le_bytes(exact[..4].try_into().unwrap()) as usize, MAX_FRAME_BYTES);
        assert_eq!(encode(&body(MAX_FRAME_BYTES + 1)), Err("LimitExceeded"));
    }

    #[tokio::test]
    async fn reading_refuses_an_oversized_or_empty_length_before_the_body_and_survives_the_boundary() {
        let inside = encode(&json!({"v": "x".repeat(MAX_FRAME_BYTES - 8)})).unwrap();
        assert_eq!(read_frame(&mut &inside[..]).await.unwrap()["v"].as_str().unwrap().len(), MAX_FRAME_BYTES - 8);
        let over = ((MAX_FRAME_BYTES + 1) as u32).to_le_bytes();
        assert_eq!(read_frame(&mut &over[..]).await, Err("LimitExceeded"), "the body is never read");
        assert_eq!(read_frame(&mut &0u32.to_le_bytes()[..]).await, Err("LimitExceeded"));
        assert_eq!(read_frame(&mut &[1u8, 0][..]).await, Err("HostUnavailable"), "a cut header is a disconnect");
        let truncated = [&10u32.to_le_bytes()[..], b"{}"].concat();
        assert_eq!(read_frame(&mut &truncated[..]).await, Err("HostUnavailable"));
        let malformed = [&3u32.to_le_bytes()[..], b"{{{"].concat();
        assert_eq!(read_frame(&mut &malformed[..]).await, Err("InvalidShape"));
    }

    #[test]
    fn frames_classify_exactly_and_a_malformed_one_never_becomes_a_reply() {
        let request = json!({"schemaVersion": 1, "token": "t", "id": 3, "method": "context", "params": {"op": "query"}});
        assert_eq!(classify(&request).unwrap(), Incoming::Request { schema_version: 1, token: "t".into(), id: 3, method: "context".into(), params: json!({"op": "query"}) });
        let reply = json!({"schemaVersion": 1, "token": "t", "reply": {"id": 5, "ok": true, "value": [1]}});
        assert_eq!(classify(&reply).unwrap(), Incoming::Reply { schema_version: 1, token: "t".into(), id: 5, result: Ok(json!([1])) });
        let failed = json!({"schemaVersion": 1, "token": "t", "reply": {"id": 5, "ok": false, "error": {"code": "PermissionDenied"}}});
        assert_eq!(classify(&failed).unwrap(), Incoming::Reply { schema_version: 1, token: "t".into(), id: 5, result: Err("PermissionDenied".into()) });
        let odd = json!({"schemaVersion": 1, "token": "t", "reply": {"id": 5, "ok": false, "error": {"code": "not a code!"}}});
        assert!(matches!(classify(&odd).unwrap(), Incoming::Reply { result: Err(code), .. } if code == "HostUnavailable"));
        for bad in [
            json!(null), json!([]), json!({"token": "t", "id": 1, "method": "m", "params": null}),
            json!({"schemaVersion": 1, "token": "t", "reply": {"id": "5", "ok": true, "value": null}}),
            json!({"schemaVersion": 1, "token": "t", "reply": {"id": 5, "ok": true}}),
            json!({"schemaVersion": 1, "token": "t", "reply": {"id": 5, "ok": true, "value": null, "extra": 1}}),
            json!({"schemaVersion": 1, "token": "t", "reply": {"id": 5, "ok": "yes", "value": null}}),
            json!({"schemaVersion": 1, "token": "t", "reply": {"id": 5, "ok": false, "value": null}}),
            json!({"schemaVersion": 1, "token": "t", "reply": {"id": -1, "ok": true, "value": null}}),
            json!({"schemaVersion": 1, "token": "t", "reply": {"id": 5, "ok": true, "value": null}, "id": 9}),
            json!({"schemaVersion": 1, "token": "t", "id": 1, "method": "m"}),
            json!({"schemaVersion": 1, "token": "t", "id": 1.5, "method": "m", "params": null}),
            json!({"schemaVersion": 1, "token": 7, "id": 1, "method": "m", "params": null}),
        ] { assert_eq!(classify(&bad), Err("InvalidShape"), "{bad}"); }
    }

    #[test]
    fn host_frames_have_the_documented_shape() {
        assert_eq!(call_frame(2, "command", &json!({"commandId": "a/b", "args": {"n": 1}})), json!({"call": {"id": 2, "method": "command", "params": {"commandId": "a/b", "args": {"n": 1}}}}));
        assert_eq!(answer_frame(4, &json!({"ok": true, "value": null})), json!({"id": 4, "reply": {"ok": true, "value": null}}));
    }
}
