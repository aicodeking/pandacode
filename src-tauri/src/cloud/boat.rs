//! boat (boat.dev) sandboxes for cloud agents (docs/cloud-agents.md): persistent Ubuntu VMs
//! behind a bearer-token REST API (https://docs.boat.dev/api/v1.md). Sandboxes stop by
//! themselves after `ttlSeconds` (`keep_alive` sets it), snapshot their disk on stop and
//! come back with `resume`. Commands that wait are capped at 600 s by boat, so longer
//! ones run detached and are polled.
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    time::{Duration, Instant},
};

use super::{http, sandbox::{Info, Sandbox}, Machine};
use crate::Result;

const SERVICE: &str = "boat";
pub const DEFAULT_API: &str = "https://boat.dev/api/v1";
const KEY: &str = "boat_key";
/// boat's longest waiting command, in seconds.
const WAIT_MAX: u64 = 600;
/// Auto-stop boat accepts, in seconds (1 s – 30 days).
const TTL_MAX: u64 = 2_592_000;
/// Idle minutes a new machine gets before boat stops it.
const IDLE_MINUTES: u32 = 15;

pub struct Boat {
    api: String,
    key: String,
}

fn machine(sandbox: &Value) -> Machine {
    let id = sandbox["id"].as_str().unwrap_or_default();
    let state = match sandbox["state"].as_str().unwrap_or("unknown") {
        "ready" | "idle" | "running" => "running",
        "provisioning" | "provisioned" | "cloning" => "starting",
        "archiving" => "stopping",
        "archived" => "stopped",
        "error" => "error",
        other => other,
    };
    let size = match (sandbox["vcpu"].as_u64(), sandbox["memoryGB"].as_u64()) {
        (Some(cpu), Some(memory)) => format!(" · {cpu} CPU · {memory} GB"),
        _ => String::new(),
    };
    Machine {
        id: format!("boat:{id}"),
        provider: "boat".into(),
        name: sandbox["name"].as_str().filter(|n| !n.is_empty()).unwrap_or(id).to_string(),
        state: state.into(),
        os: "linux".into(),
        desktop: false,
        detail: format!("boat{size}"),
    }
}

impl Boat {
    pub fn new(api: Option<String>, key: String) -> Self {
        Boat { api: api.unwrap_or_else(|| DEFAULT_API.into()).trim_end_matches('/').to_string(), key }
    }
    fn connected() -> Result<Self> {
        let key = super::secret(KEY).ok_or("Connect boat in Settings → Cloud first.")?;
        Ok(Boat::new(super::settings().providers.get("boat").and_then(|o| o.get("apiUrl")).cloned(), key))
    }
    async fn call(&self, method: reqwest::Method, path: &str, body: Option<Value>, timeout: Duration) -> Result<Value> {
        let request = http::client(timeout)?.request(method, format!("{}{path}", self.api)).bearer_auth(&self.key);
        http::send(SERVICE, match body { Some(body) => request.json(&body), None => request }).await
    }
    /// The signed-in account's login, which also proves the key works.
    pub async fn login(&self) -> Result<String> {
        let me = self.call(reqwest::Method::GET, "/me", None, Duration::from_secs(30)).await?;
        Ok(me["user"]["login"].as_str().unwrap_or("boat account").to_string())
    }
    async fn list(&self) -> Result<Vec<Machine>> {
        let reply = self.call(reqwest::Method::GET, "/sandboxes?limit=200", None, Duration::from_secs(30)).await?;
        Ok(reply["sandboxes"].as_array().map(|all| all.iter().map(machine).collect()).unwrap_or_default())
    }
    async fn create(&self, name: &str) -> Result<Machine> {
        let created = self.call(reqwest::Method::POST, "/sandboxes", Some(json!({"ttlSeconds": IDLE_MINUTES * 60})), Duration::from_secs(60)).await?;
        let id = created["sandbox"]["id"].as_str().ok_or("boat did not return a sandbox ID.")?;
        // boat names sandboxes itself; rename so the machine reads as the cloud task's.
        let renamed = self.call(reqwest::Method::PATCH, &format!("/sandboxes/{id}"), Some(json!({"name": name})), Duration::from_secs(30)).await;
        Ok(machine(renamed.as_ref().ok().map(|r| &r["sandbox"]).filter(|s| s["id"].is_string()).unwrap_or(&created["sandbox"])))
    }
    async fn power(&self, id: &str, action: &str) -> Result<()> {
        let timeout = Duration::from_secs(120);
        match action {
            "start" => self.call(reqwest::Method::POST, &format!("/sandboxes/{id}/resume"), None, timeout).await.map(|_| ()),
            "stop" => self.call(reqwest::Method::POST, &format!("/sandboxes/{id}/stop"), None, timeout).await.map(|_| ()),
            "delete" => {
                let request = http::client(timeout)?.delete(format!("{}/sandboxes/{id}", self.api)).bearer_auth(&self.key).header("X-Ascii-Confirm-Delete", id);
                http::send(SERVICE, request).await.map(|_| ())
            }
            _ => Err(format!("boat sandboxes can start, stop or be deleted, not {action}.")),
        }
    }
    async fn keep_alive(&self, id: &str, minutes: u32) -> Result<()> {
        let seconds = (u64::from(minutes) * 60).clamp(60, TTL_MAX);
        self.call(reqwest::Method::PATCH, &format!("/sandboxes/{id}"), Some(json!({"ttlSeconds": seconds})), Duration::from_secs(30)).await.map(|_| ())
    }
    async fn exec(&self, id: &str, command: &str, timeout: Duration) -> Result<(Option<i32>, String)> {
        let path = format!("/sandboxes/{id}/commands");
        if timeout.as_secs() <= WAIT_MAX {
            let body = json!({"command": command, "timeoutSeconds": timeout.as_secs().max(1)});
            let result = self.call(reqwest::Method::POST, &path, Some(body), timeout + Duration::from_secs(70)).await?;
            if result["timedOut"].as_bool() == Some(true) {
                return Ok((None, format!("Timed out after {} s.", timeout.as_secs())));
            }
            return Ok((result["exitCode"].as_i64().map(|c| c as i32), combined(&result)));
        }
        let started = self.call(reqwest::Method::POST, &path, Some(json!({"command": command, "detached": true})), Duration::from_secs(90)).await?;
        let process = started["processId"].as_u64().ok_or("boat did not start the command.")?;
        let (deadline, mut offsets, mut output) = (Instant::now() + timeout, (0, 0), String::new());
        loop {
            let url = format!("{path}/{process}?stdoutOffset={}&stderrOffset={}", offsets.0, offsets.1);
            let status = self.call(reqwest::Method::GET, &url, None, Duration::from_secs(60)).await?;
            output.push_str(&combined(&status));
            offsets = (status["stdoutNextOffset"].as_u64().unwrap_or(offsets.0), status["stderrNextOffset"].as_u64().unwrap_or(offsets.1));
            if status["running"].as_bool() == Some(false) && status["more"].as_bool() != Some(true) {
                return Ok((status["exitCode"].as_i64().map(|c| c as i32), output));
            }
            if Instant::now() >= deadline {
                let _ = self.call(reqwest::Method::DELETE, &format!("{path}/{process}"), None, Duration::from_secs(30)).await;
                return Ok((None, format!("{output}\nTimed out after {} s.", timeout.as_secs())));
            }
            tokio::time::sleep(Duration::from_secs(if status["more"].as_bool() == Some(true) { 0 } else { 2 })).await;
        }
    }
}

/// stdout then stderr, the order Sandbox::exec documents as "combined".
fn combined(result: &Value) -> String {
    format!("{}{}", result["stdout"].as_str().unwrap_or_default(), result["stderr"].as_str().unwrap_or_default())
}

impl Sandbox for Boat {
    /// Snapshots keep the disk for 14 days after a stop; auto-stop reaches 30 days.
    fn info(&self) -> Info {
        Info { persistent: true, max_unattended_minutes: 24 * 60 }
    }
    fn list(&self) -> Result<Vec<Machine>> {
        http::block(Boat::list(self))
    }
    fn create(&self, name: &str) -> Result<Machine> {
        http::block(Boat::create(self, name))
    }
    fn power(&self, native: &str, action: &str) -> Result<()> {
        http::block(Boat::power(self, native, action))
    }
    fn exec(&self, native: &str, command: &str, timeout: Duration) -> Result<(Option<i32>, String)> {
        http::block(Boat::exec(self, native, command, timeout))
    }
    fn keep_alive(&self, native: &str, minutes: u32) -> Result<()> {
        http::block(Boat::keep_alive(self, native, minutes))
    }
}

/// Check the key with a real request, then save it. `options.apiUrl` points at another boat host.
pub fn connect(key: &str, options: &Value) -> Result<()> {
    let key = key.trim();
    if key.is_empty() {
        return Err("Enter a boat API key (`boat api-key create pandacode --preset ci`).".into());
    }
    let api = options["apiUrl"].as_str().map(str::trim).filter(|v| !v.is_empty()).map(str::to_string);
    if api.as_deref().is_some_and(|url| !url.starts_with("https://")) {
        return Err("The boat API URL must start with https://.".into());
    }
    let login = http::block(Boat::new(api.clone(), key.to_string()).login())?;
    super::set_secret(KEY, key)?;
    let mut settings = super::settings();
    let mut saved = BTreeMap::from([("detail".to_string(), login)]);
    saved.extend(api.map(|url| ("apiUrl".to_string(), url)));
    settings.providers.insert("boat".into(), saved);
    super::save_settings(&settings)
}
pub fn disconnect() -> Result<()> {
    super::remove_secret(KEY);
    let mut settings = super::settings();
    settings.providers.remove("boat");
    super::save_settings(&settings)
}
pub fn sandbox() -> Result<Box<dyn Sandbox>> {
    Ok(Box::new(Boat::connected()?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud::http::mock;

    fn boat() -> (Boat, mock::Seen) {
        let (base, seen) = mock::serve(|request, _| -> (u16, String) { match (request.method.as_str(), request.path.as_str()) {
            ("GET", "/v1/me") => (200, r#"{"ok":true,"user":{"login":"octocat"}}"#.into()),
            ("GET", "/v1/sandboxes?limit=200") => (200, r#"{"ok":true,"sandboxes":[{"id":"bx_1","name":"pc-a","state":"idle","vcpu":2,"memoryGB":4},{"id":"bx_2","name":"","state":"archived"}]}"#.into()),
            ("POST", "/v1/sandboxes") => (202, r#"{"ok":true,"sandbox":{"id":"bx_3","name":"Sandbox 1","state":"provisioning"}}"#.into()),
            ("PATCH", "/v1/sandboxes/bx_3") if request.body.contains("name") => (200, r#"{"ok":true,"sandbox":{"id":"bx_3","name":"pc-new","state":"provisioning"}}"#.into()),
            ("PATCH", "/v1/sandboxes/bx_1") => (200, r#"{"ok":true,"sandbox":{"id":"bx_1"}}"#.into()),
            ("POST", "/v1/sandboxes/bx_2/resume") => (202, r#"{"ok":true}"#.into()),
            ("DELETE", "/v1/sandboxes/bx_2") => (202, r#"{"ok":true}"#.into()),
            ("POST", "/v1/sandboxes/bx_1/commands") if request.body.contains("detached") => (200, r#"{"ok":true,"processId":77,"pid":77}"#.into()),
            ("POST", "/v1/sandboxes/bx_1/commands") => (200, r#"{"ok":true,"exitCode":2,"stdout":"out","stderr":"err","timedOut":false}"#.into()),
            ("GET", "/v1/sandboxes/bx_1/commands/77?stdoutOffset=0&stderrOffset=0") => (200, r#"{"running":false,"exitCode":0,"stdout":"long","stderr":"","stdoutNextOffset":4,"stderrNextOffset":0,"more":false}"#.into()),
            _ => (404, r#"{"ok":false,"message":"not found"}"#.into()),
        } });
        (Boat::new(Some(format!("{base}/v1/")), "k".into()), seen)
    }

    #[tokio::test]
    async fn lists_creates_and_controls_sandboxes() {
        let (boat, seen) = boat();
        assert_eq!(boat.login().await.unwrap(), "octocat");
        let listed = boat.list().await.unwrap();
        assert_eq!(listed.iter().map(|m| (m.id.as_str(), m.name.as_str(), m.state.as_str())).collect::<Vec<_>>(), vec![("boat:bx_1", "pc-a", "running"), ("boat:bx_2", "bx_2", "stopped")]);
        assert!(listed[0].detail.contains("2 CPU"));
        let created = boat.create("pc-new").await.unwrap();
        assert_eq!((created.id.as_str(), created.name.as_str(), created.state.as_str()), ("boat:bx_3", "pc-new", "starting"));
        boat.power("bx_2", "start").await.unwrap();
        boat.power("bx_2", "delete").await.unwrap();
        assert!(boat.power("bx_2", "pause").await.is_err());
        boat.keep_alive("bx_1", 90).await.unwrap();
        let log = seen.lock().unwrap();
        assert!(log.iter().all(|r| r.authorization.as_deref() == Some("Bearer k")));
        assert!(log.iter().find(|r| r.method == "DELETE").unwrap().headers.iter().any(|(n, v)| n == "x-ascii-confirm-delete" && v == "bx_2"));
        let ttl: Value = serde_json::from_str(&log.iter().find(|r| r.path == "/v1/sandboxes/bx_1").unwrap().body).unwrap();
        assert_eq!(ttl, json!({"ttlSeconds": 5400}));
        let first: Value = serde_json::from_str(&log.iter().find(|r| r.method == "POST" && r.path == "/v1/sandboxes").unwrap().body).unwrap();
        assert_eq!(first, json!({"ttlSeconds": 900}));
    }

    #[tokio::test]
    async fn runs_short_commands_inline_and_long_ones_detached() {
        let (boat, seen) = boat();
        assert_eq!(boat.exec("bx_1", "ls", Duration::from_secs(30)).await.unwrap(), (Some(2), "outerr".into()));
        assert_eq!(boat.exec("bx_1", "build", Duration::from_secs(1800)).await.unwrap(), (Some(0), "long".into()));
        let log = seen.lock().unwrap();
        let sync: Value = serde_json::from_str(&log.iter().find(|r| r.body.contains("\"ls\"")).unwrap().body).unwrap();
        assert_eq!(sync, json!({"command": "ls", "timeoutSeconds": 30}));
    }

    #[test]
    fn connect_refuses_plain_http_and_empty_keys() {
        assert!(connect("", &json!({})).is_err());
        assert!(connect("k", &json!({"apiUrl": "http://boat.example"})).unwrap_err().contains("https://"));
    }
}
