//! Connect diagnostics: a bounded in-memory log of connection events and per-route
//! stats (state, RTT, last error), shown in Settings and exportable without secrets.
//!
//! Event kinds the relay summary understands: `socket.connecting` (first attempt),
//! `socket.retry`/`socket.reconnect` (count as a reconnect), `socket.open` (connected), `socket.close`/`socket.error` (last error).
use regex::Regex;
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::sync::{Mutex, OnceLock};

const RING: usize = 500;
const SNAPSHOT_EVENTS: usize = 200;
const DETAIL_MAX: usize = 400;

#[derive(Clone)]
struct Event {
    at: i64,
    kind: String,
    detail: String,
}

#[derive(Default)]
struct Log {
    events: VecDeque<Event>,
    connected_since: Option<i64>,
    last_error: Option<String>,
    reconnects: u64,
}

fn log() -> &'static Mutex<Log> {
    static LOG: OnceLock<Mutex<Log>> = OnceLock::new();
    LOG.get_or_init(|| Mutex::new(Log::default()))
}

fn lock() -> std::sync::MutexGuard<'static, Log> {
    log().lock().unwrap_or_else(|e| e.into_inner())
}

fn secret_pairs() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"(?i)\b(token|secret|key|nonce|password|passwd|authorization|bearer|signature)(["']?\s*[:=]\s*|\s+)["']?(?:bearer\s+)?([^\s,;&"'}\]]+)"#).unwrap())
}

fn long_blob() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?:gh[pousr]_[A-Za-z0-9]{10,}|sk-[A-Za-z0-9_-]{10,}|eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*|[A-Za-z0-9+/_=-]{32,})").unwrap())
}

fn query() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"([a-z][a-z0-9+.-]*://[^\s?#]+)[?#]\S*").unwrap())
}

fn ip_addr() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    // IPv4; IPv6 with `::`, or of 4+ groups so `12:00:00` clock times are kept.
    RE.get_or_init(|| Regex::new(r"(?i)\b(?:\d{1,3}\.){3}\d{1,3}\b|\b[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?|::[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*|\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b").unwrap())
}

/// Absolute paths (Unix after a space, quote, bracket or `=`, or Windows drive paths) left
/// once the home directory became `~`.
fn abs_path() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"(^|[\s"'(\[=])(?:/[^\s"')\]]+|[A-Za-z]:\\[^\s"')\]]*)"#).unwrap())
}

fn home() -> Option<String> {
    std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).ok().map(|h| h.trim_end_matches(['/', '\\']).to_owned()).filter(|h| h.len() > 1)
}

/// Secrets, URL queries, IP addresses and absolute paths out of `text`; the home dir becomes `~`.
fn redact(text: &str, home: Option<&str>) -> String {
    let mut out = text.to_owned();
    if let Some(home) = home {
        out = out.replace(home, "~");
    }
    out = query().replace_all(&out, "$1").into_owned();
    out = secret_pairs().replace_all(&out, "$1$2[redacted]").into_owned();
    out = long_blob().replace_all(&out, "[redacted]").into_owned();
    out = abs_path().replace_all(&out, "$1[path]").into_owned();
    ip_addr().replace_all(&out, "[ip]").into_owned()
}

fn scrub_with(text: &str, home: Option<&str>) -> String {
    let mut out = redact(text, home);
    let mut end = out.len().min(DETAIL_MAX);
    while !out.is_char_boundary(end) {
        end -= 1;
    }
    if end < out.len() {
        out.truncate(end);
        out.push('…');
    }
    out
}

/// Removes tokens, keys, nonces, URL queries, IP addresses and paths from text, cut to [`DETAIL_MAX`].
pub(crate) fn scrub(text: &str) -> String {
    scrub_with(text, home().as_deref())
}

fn record_at(log: &mut Log, at: i64, kind: &str, detail: String) {
    let detail = scrub(&detail);
    match kind {
        "socket.open" => {
            log.connected_since = Some(at);
            log.last_error = None;
        }
        "socket.close" | "socket.error" => {
            log.connected_since = None;
            if !detail.is_empty() {
                log.last_error = Some(detail.clone());
            }
        }
        "socket.retry" | "socket.reconnect" => log.reconnects += 1,
        _ => {}
    }
    if log.events.len() >= RING {
        log.events.pop_front();
    }
    log.events.push_back(Event { at, kind: scrub(kind), detail });
}

/// Records one connection event (`kind` like `socket.open`, `route.direct`, `rpc.timeout`).
pub(crate) fn record(kind: &str, detail: impl Into<String>) {
    record_at(&mut lock(), chrono::Utc::now().timestamp_millis(), kind, detail.into());
}

fn route_list(routes: &Value) -> Vec<Value> {
    match routes {
        Value::Array(items) => items.clone(),
        Value::Object(map) => map.values().cloned().collect(),
        _ => Vec::new(),
    }
}

fn route_connected(route: &Value) -> bool {
    matches!(route["state"].as_str(), Some("connected" | "direct" | "open" | "ready" | "active"))
}

fn stage(name: &str, ok: bool, detail: impl Into<String>) -> Value {
    json!({"name": name, "ok": ok, "detail": detail.into()})
}

/// The five connection stages, each with a short reason when it fails.
fn derive_stages(signed_in: bool, relay_connected: bool, relay_error: Option<&str>, devices: &[Value], routes: &Value) -> Vec<Value> {
    let routes = route_list(routes);
    let me = devices.iter().find(|d| d["current"] == true);
    let others = devices.iter().filter(|d| d["current"] != true && d["online"] == true).count();
    let direct = routes.iter().filter(|r| r["route"] == "direct" && route_connected(r)).count();
    let any_route = routes.iter().any(route_connected);
    let encrypted = signed_in && (relay_connected || any_route);
    vec![
        stage("Signed in", signed_in, if signed_in { "GitHub account linked" } else { "Sign in to use Connect" }),
        stage("Relay connected", relay_connected, match (relay_connected, signed_in) {
            (true, _) => "Relay socket open".to_owned(),
            (false, false) => "Waiting for sign-in".to_owned(),
            (false, true) => relay_error.map(|e| format!("Not connected: {e}")).unwrap_or_else(|| "Not connected".into()),
        }),
        stage("Device online", me.is_some_and(|d| d["online"] == true), match me {
            Some(d) if d["online"] == true => format!("This computer is listed; {others} other online"),
            Some(_) => "This computer is listed as offline".into(),
            None => "This computer is not in the device list".into(),
        }),
        stage("Direct route", direct > 0, if direct > 0 { format!("{direct} direct route{} up", if direct == 1 { "" } else { "s" }) } else { "No direct route; using the relay".to_owned() }),
        stage("Encrypted session", encrypted, if encrypted { "End-to-end encrypted with each computer's key" } else { "No live route to encrypt over" }),
    ]
}

fn host_only(url: &str) -> String {
    let rest = url.split_once("://").map_or(url, |(_, r)| r);
    let rest = rest.rsplit_once('@').map_or(rest, |(_, r)| r);
    rest.split(['/', '?', '#', ':']).next().unwrap_or("").to_owned()
}

fn events_json(log: &Log, limit: usize) -> Vec<Value> {
    log.events.iter().rev().take(limit).map(|e| json!({"at": e.at, "kind": e.kind, "detail": e.detail})).collect()
}

fn build_snapshot(app: &tauri::AppHandle) -> Value {
    let remote = super::remote(app);
    let status = remote.status();
    let devices = remote.devices_view();
    let signed_in = status["signedIn"] == true;
    let connected = status["connected"] == true;
    let routes = super::routes::route_states();
    let log = lock();
    let relay_url = super::config::build().map(|b| host_only(&b.relay)).unwrap_or_default();
    let stages = derive_stages(signed_in, connected, log.last_error.as_deref(), &devices, &routes);
    json!({
        "relay": {
            "state": if connected { "connected" } else if signed_in { "disconnected" } else { "signed-out" },
            "url": relay_url,
            "connectedSince": if connected { log.connected_since.map(Value::from).unwrap_or(Value::Null) } else { Value::Null },
            "lastError": log.last_error,
            "reconnects": log.reconnects,
        },
        "routes": routes,
        "devices": devices.iter().map(|d| json!({"name": d["name"], "platform": d["platform"], "online": d["online"], "current": d["current"], "lastSeen": d["lastSeen"]})).collect::<Vec<_>>(),
        "stages": stages,
        "events": events_json(&log, SNAPSHOT_EVENTS),
    })
}

fn clock(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms).map(|t| t.format("%Y-%m-%d %H:%M:%S%.3f UTC").to_string()).unwrap_or_default()
}

fn text(v: &Value) -> String {
    v.as_str().map(str::to_owned).unwrap_or_else(|| if v.is_null() { "-".into() } else { v.to_string() })
}

fn report(snapshot: &Value) -> String {
    let mut out = format!("PandaCode Connect diagnostics\nVersion: {}\nOS: {} {}\nGenerated: {}\n\nStages\n", env!("CARGO_PKG_VERSION"), std::env::consts::OS, std::env::consts::ARCH, clock(chrono::Utc::now().timestamp_millis()));
    for s in snapshot["stages"].as_array().into_iter().flatten() {
        out += &format!("  [{}] {}: {}\n", if s["ok"] == true { "ok" } else { "FAIL" }, text(&s["name"]), text(&s["detail"]));
    }
    let relay = &snapshot["relay"];
    out += &format!("\nRelay\n  state: {}\n  host: {}\n  connected since: {}\n  reconnects: {}\n  last error: {}\n", text(&relay["state"]), text(&relay["url"]), relay["connectedSince"].as_i64().map(clock).unwrap_or_else(|| "-".into()), text(&relay["reconnects"]), text(&relay["lastError"]));
    out += "\nRoutes\n";
    let routes = route_list(&snapshot["routes"]);
    if routes.is_empty() {
        out += "  none\n";
    }
    for r in &routes {
        out += &format!("  {} via {}: {} rtt={} since={} error={}\n", text(&r["device"]), text(&r["route"]), text(&r["state"]), text(&r["rttMs"]), text(&r["since"]), text(&r["lastError"]));
    }
    out += "\nEvents (newest first)\n";
    for e in snapshot["events"].as_array().into_iter().flatten() {
        out += &format!("  {} {} {}\n", e["at"].as_i64().map(clock).unwrap_or_default(), text(&e["kind"]), text(&e["detail"]));
    }
    // Not `scrub`: that cuts to one detail's length.
    redact(&out, home().as_deref())
}

#[tauri::command]
pub async fn remote_diagnostics(app: tauri::AppHandle) -> Value {
    build_snapshot(&app)
}

#[tauri::command]
pub async fn remote_diagnostics_export(app: tauri::AppHandle) -> String {
    report(&build_snapshot(&app))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ring_is_bounded_and_keeps_newest() {
        let mut l = Log::default();
        for i in 0..(RING + 50) {
            record_at(&mut l, i as i64, "x", format!("n{i}"));
        }
        assert_eq!(l.events.len(), RING);
        assert_eq!(l.events.front().unwrap().detail, "n50");
        let events = events_json(&l, SNAPSHOT_EVENTS);
        assert_eq!(events.len(), SNAPSHOT_EVENTS);
        assert_eq!(events[0]["detail"], format!("n{}", RING + 49));
    }

    #[test]
    fn scrubs_secrets_paths_and_queries() {
        let s = scrub_with("open wss://relay.example.com/ws?token=abc123&x=1 token=hunter2 Authorization: Bearer abc.def nonce \"zzzz\" in /Users/me/proj", Some("/Users/me"));
        assert!(!s.contains("abc123") && !s.contains("hunter2") && !s.contains("abc.def") && !s.contains("zzzz"), "{s}");
        assert!(s.contains("~/proj"), "{s}");
        assert!(s.contains("wss://relay.example.com/ws"), "{s}");
        let blob = scrub_with("key ghp_abcdefghijklmnopqrstuv and eyJhbGciOi.eyJzdWIi.sig plus AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", None);
        assert!(!blob.contains("ghp_") && !blob.contains("eyJ") && !blob.contains("AAAAAAAA"), "{blob}");
        assert!(scrub_with(&"é".repeat(1000), None).chars().count() <= DETAIL_MAX + 1);
    }

    #[test]
    fn scrubs_addresses_and_paths_outside_home() {
        let s = scrub_with("a1 direct via 192.168.1.20:4000, b2 via [fe80::1c2a:3b]:4000 and 2001:db8:0:0:1:0:0:1; opened /Volumes/Work/proj and C:\\Data\\x at 12:00:00.000", Some("/Users/me"));
        for leaked in ["192.168", "fe80", "2001:db8", "/Volumes", "Data"] {
            assert!(!s.contains(leaked), "{leaked} in {s}");
        }
        assert!(s.contains("[ip]:4000") && s.contains("12:00:00.000") && s.contains("[path]"), "{s}");
        assert!(scrub_with("wss://relay.example.com/ws remote::route ~/proj", Some("/Users/me")).contains("wss://relay.example.com/ws remote::route ~/proj"));
        let mut l = Log::default();
        record_at(&mut l, 1, "route.up", "a1 direct via 10.0.0.7:4000".into());
        assert_eq!(l.events[0].detail, "a1 direct via [ip]:4000");
        let long = report(&json!({"events": (0..20).map(|n| json!({"at": n, "kind": "route.up", "detail": format!("event {n}")})).collect::<Vec<_>>()}));
        assert!(long.contains("event 19") && long.contains("event 0"), "the export is not cut to one detail's length");
    }

    #[test]
    fn relay_summary_follows_socket_events() {
        let mut l = Log::default();
        record_at(&mut l, 1, "socket.connecting", String::new());
        record_at(&mut l, 2, "socket.open", String::new());
        assert_eq!(l.connected_since, Some(2));
        record_at(&mut l, 3, "socket.close", "closed by peer".into());
        assert_eq!((l.connected_since, l.last_error.as_deref(), l.reconnects), (None, Some("closed by peer"), 0));
        record_at(&mut l, 4, "socket.reconnect", String::new());
        assert_eq!(l.reconnects, 1, "only attempts after the first count");
    }

    #[test]
    fn stages_follow_state() {
        let me = json!({"current": true, "online": true});
        let other = json!({"current": false, "online": true});
        let ok = |s: &[Value]| s.iter().map(|s| s["ok"].as_bool().unwrap()).collect::<Vec<_>>();
        assert_eq!(ok(&derive_stages(false, false, None, &[], &json!([]))), [false; 5]);
        let direct = json!([{"device": "a", "route": "direct", "state": "connected"}]);
        assert_eq!(ok(&derive_stages(true, true, None, &[me.clone(), other.clone()], &direct)), [true; 5]);
        assert_eq!(ok(&derive_stages(true, true, None, std::slice::from_ref(&me), &json!([]))), [true, true, true, false, true]);
        let down = derive_stages(true, false, Some("timeout"), &[me], &json!([]));
        assert_eq!(ok(&down), [true, false, true, false, false]);
        assert!(down[1]["detail"].as_str().unwrap().contains("timeout"));
    }

    #[test]
    fn host_only_drops_everything_else() {
        assert_eq!(host_only("https://user:pw@relay.example.com:8443/path?x=1"), "relay.example.com");
    }
}
