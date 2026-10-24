//! Freestyle VMs for cloud agents (docs/cloud-agents.md), over the v5 REST API
//! (api.freestyle.sh/openapi.json; docs.freestyle.sh/docs/vms). Freestyle VMs are full Linux
//! machines with `exec-await` (wait for the command), pause/start and idle timeouts.
//!
//! Uploads use the default exec-based writer on purpose: the files API writes as root,
//! while commands run as the image's `ubuntu` user and must be able to edit what we upload.
use serde_json::{json, Value};
use std::time::Duration;

use super::{
    http::{self, block},
    sandbox::{Info, Sandbox},
    Machine,
};
use crate::Result;

const DEFAULT_API: &str = "https://api.freestyle.sh";
const SERVICE: &str = "Freestyle";
/// Pause after this many seconds without network activity until `keep_alive` says otherwise.
const IDLE_SECONDS: u64 = 15 * 60;
const MAX_IDLE_SECONDS: u64 = 24 * 60 * 60;
/// `exec-await` kills a command at this limit unless the agent supports background requests.
const MAX_EXEC_MS: u64 = 300_000;

pub struct Freestyle {
    api: String,
    key: String,
}

pub fn connect(key: &str, _options: &Value) -> Result<()> {
    let key = key.trim();
    let detail = block(Freestyle::new(None, key.into()).check())?;
    super::set_secret("freestyle_key", key)?;
    let mut settings = super::settings();
    settings.providers.insert("freestyle".into(), [("detail".to_string(), detail)].into());
    super::save_settings(&settings)
}
pub fn disconnect() -> Result<()> {
    super::remove_secret("freestyle_key");
    let mut settings = super::settings();
    settings.providers.remove("freestyle");
    super::save_settings(&settings)
}
pub fn sandbox() -> Result<Box<dyn Sandbox>> {
    let key = super::secret("freestyle_key").ok_or("Connect Freestyle in Settings → Cloud first.")?;
    Ok(Box::new(Freestyle::new(None, key)))
}

/// `url` with percent-encoded query pairs appended.
fn with_query(url: String, pairs: &[(&str, &str)]) -> String {
    match tauri::Url::parse(&url) {
        Ok(mut parsed) if !pairs.is_empty() => {
            parsed.query_pairs_mut().extend_pairs(pairs);
            parsed.into()
        }
        _ => url,
    }
}

fn machine(vm: &Value) -> Machine {
    let id = vm["id"].as_str().unwrap_or_default();
    let state = match vm["state"].as_str().unwrap_or("unknown") {
        "running" => "running",
        "starting" => "starting",
        "pausing" => "stopping",
        "paused" | "stopped" => "stopped",
        other => other,
    };
    let resources = &vm["resources"];
    Machine {
        id: format!("freestyle:{id}"),
        provider: "freestyle".into(),
        name: vm["displayName"].as_str().filter(|n| !n.is_empty()).unwrap_or(id).to_string(),
        state: state.into(),
        os: "linux".into(),
        desktop: false,
        detail: format!("Freestyle · {} CPU · {} GB", resources["cpu"].as_u64().unwrap_or(0), resources["memory"].as_u64().unwrap_or(0) / 1024),
    }
}

impl Freestyle {
    pub fn new(api: Option<String>, key: String) -> Self {
        Freestyle { api: api.filter(|a| !a.trim().is_empty()).unwrap_or_else(|| DEFAULT_API.into()).trim_end_matches('/').to_string(), key }
    }

    fn request(&self, client: &reqwest::Client, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        client.request(method, format!("{}/v5{path}", self.api)).bearer_auth(&self.key)
    }
    async fn call(&self, method: reqwest::Method, path: &str, body: Option<Value>, timeout: Duration) -> Result<Value> {
        let request = self.request(&http::client(timeout)?, method, path);
        http::send(SERVICE, match body { Some(body) => request.json(&body), None => request }).await
    }
    async fn api(&self, method: reqwest::Method, path: &str, body: Option<Value>) -> Result<Value> {
        self.call(method, path, body, Duration::from_secs(60)).await
    }

    /// A cheap authenticated request; returns the text Settings shows.
    pub async fn check(&self) -> Result<String> {
        if self.key.is_empty() {
            return Err("Paste a Freestyle API key first.".into());
        }
        let page = self.api(reqwest::Method::GET, "/vms?limit=1", None).await?;
        Ok(format!("Freestyle · {} VMs ({} running)", page["totalCount"].as_u64().unwrap_or(0), page["runningCount"].as_u64().unwrap_or(0)))
    }

    /// PandaCode's own VMs (tagged at creation). Only list items carry `state`, so state
    /// lookups go through here too.
    pub async fn vms(&self) -> Result<Vec<Machine>> {
        const PAGE: usize = 100;
        let mut found = Vec::new();
        for page in 0..20 {
            let reply = self.api(reqwest::Method::GET, &format!("/vms?limit={PAGE}&offset={}", page * PAGE), None).await?;
            let vms = reply["vms"].as_array().cloned().unwrap_or_default();
            found.extend(vms.iter().filter(|vm| vm["metadata"]["pandacode"] == "true").map(machine));
            if vms.len() < PAGE {
                break;
            }
        }
        Ok(found)
    }
    /// Outbound internet is the only firewall rule: the API requires one, and agents need
    /// package registries and their model's API.
    pub async fn launch(&self, name: &str) -> Result<Machine> {
        let body = json!({
            "displayName": name,
            "firewall": {"rules": [{"action": "allow", "source": {}, "destination": {"public": true}}]},
            "idleTimeoutSeconds": IDLE_SECONDS,
            "metadata": {"pandacode": "true"},
        });
        let mut created = machine(&self.api(reqwest::Method::POST, "/vms", Some(body)).await?);
        if created.state == "unknown" {
            created.state = "starting".into();
        }
        Ok(created)
    }
    pub async fn status(&self, id: &str) -> Result<String> {
        let machine_id = format!("freestyle:{id}");
        self.vms().await?.into_iter().find(|m| m.id == machine_id).map(|m| m.state).ok_or_else(|| "That cloud machine no longer exists.".into())
    }
    pub async fn power(&self, id: &str, action: &str) -> Result<()> {
        let (method, path) = match action {
            "start" => (reqwest::Method::POST, format!("/vms/{id}/start")),
            "stop" => (reqwest::Method::POST, format!("/vms/{id}/pause")),
            "delete" => (reqwest::Method::DELETE, format!("/vms/{id}")),
            _ => return Err(format!("Freestyle VMs can start, stop or be deleted, not {action}.")),
        };
        self.api(method, &path, None).await.map(|_| ())
    }

    pub async fn run(&self, id: &str, command: &str, timeout: Duration) -> Result<(Option<i32>, String)> {
        if self.status(id).await? == "stopped" {
            self.power(id, "start").await?;
        }
        let ms = (timeout.as_millis() as u64).clamp(1000, MAX_EXEC_MS);
        let reply = self.call(reqwest::Method::POST, &format!("/vms/{id}/exec-await"), Some(json!({"command": command, "timeoutMs": ms})), Duration::from_millis(ms) + Duration::from_secs(20)).await?;
        let text = |key: &str| reply[key].as_str().unwrap_or_default();
        // The API returns the two streams separately, so their interleaving is lost.
        Ok((reply["statusCode"].as_i64().map(|c| c as i32), format!("{}{}", text("stdout"), text("stderr"))))
    }
    pub async fn read(&self, id: &str, path: &str, offset: u64, max: usize) -> Result<Vec<u8>> {
        let client = http::client(Duration::from_secs(120))?;
        let range = format!("bytes={offset}-{}", offset + max as u64 - 1);
        let response = client.get(with_query(format!("{}/v5/vms/{id}/fs/read", self.api), &[("path", path)])).bearer_auth(&self.key).header("Range", range).send().await
            .map_err(|_| format!("Could not reach {SERVICE}. Check your connection."))?;
        let status = response.status().as_u16();
        match status {
            200 | 206 => {
                let bytes = response.bytes().await.map_err(|_| format!("{SERVICE} response was cut off."))?;
                // A server that ignores Range sends the whole file.
                Ok(if status == 200 { bytes.iter().skip(offset as usize).take(max).copied().collect() } else { bytes.to_vec() })
            }
            // Missing file, or an offset past the end.
            400 | 404 | 409 | 416 => Ok(Vec::new()),
            _ => Err(http::error_message(SERVICE, status, &response.text().await.unwrap_or_default())),
        }
    }
    /// Seconds of network silence before Freestyle pauses the VM (up to 24 h).
    pub async fn keep(&self, id: &str, minutes: u32) -> Result<()> {
        let seconds = (u64::from(minutes) * 60).clamp(60, MAX_IDLE_SECONDS);
        self.api(reqwest::Method::PATCH, &format!("/vms/{id}"), Some(json!({"idleTimeoutSeconds": seconds}))).await.map(|_| ())
    }
}

impl Sandbox for Freestyle {
    /// Paused VMs keep their disk.
    fn info(&self) -> Info {
        Info { persistent: true, max_unattended_minutes: 24 * 60 }
    }
    fn list(&self) -> Result<Vec<Machine>> {
        block(self.vms())
    }
    fn create(&self, name: &str) -> Result<Machine> {
        block(self.launch(name))
    }
    fn power(&self, native: &str, action: &str) -> Result<()> {
        block(Freestyle::power(self, native, action))
    }
    fn state(&self, native: &str) -> Result<String> {
        block(self.status(native))
    }
    fn exec(&self, native: &str, command: &str, timeout: Duration) -> Result<(Option<i32>, String)> {
        block(self.run(native, command, timeout))
    }
    fn keep_alive(&self, native: &str, minutes: u32) -> Result<()> {
        block(self.keep(native, minutes))
    }
    fn download(&self, native: &str, path: &str, offset: u64, max: usize) -> Result<Vec<u8>> {
        block(self.read(native, path, offset, max))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud::http::mock;

    fn freestyle() -> (Freestyle, mock::Seen) {
        let (base, seen) = mock::serve(|request, _| {
            let path = request.path.split('?').next().unwrap_or_default();
            match (request.method.as_str(), path) {
                ("GET", "/v5/vms") if request.path.ends_with("limit=1") => (200, r#"{"vms":[],"totalCount":3,"runningCount":1}"#.to_string()),
                ("GET", "/v5/vms") => (200, r#"{"vms":[{"id":"vm1","state":"running","metadata":{"pandacode":"true"},"displayName":"agent","resources":{"cpu":2,"memory":4096,"storage":1}},{"id":"vm2","state":"paused","metadata":{"pandacode":"true"},"resources":{"cpu":1,"memory":1024,"storage":1}},{"id":"other","state":"running","resources":{"cpu":1,"memory":1024,"storage":1}}]}"#.to_string()),
                ("POST", "/v5/vms") => (201, r#"{"id":"vm3","resources":{"cpu":2,"memory":2048,"storage":1}}"#.to_string()),
                ("POST", "/v5/vms/vm2/start") => (200, r#"{"id":"vm2","state":"starting"}"#.to_string()),
                ("POST", "/v5/vms/vm1/pause") | ("PATCH", "/v5/vms/vm1") | ("DELETE", "/v5/vms/vm1") => (200, "{}".to_string()),
                ("POST", "/v5/vms/vm1/exec-await") | ("POST", "/v5/vms/vm2/exec-await") => (200, r#"{"statusCode":3,"stdout":"42\n","stderr":"warn\n"}"#.to_string()),
                ("GET", "/v5/vms/vm1/fs/read") => match request.headers.iter().find(|(n, _)| n == "range").map(|(_, v)| v.as_str()) {
                    Some("bytes=2-5") => (206, "cdef".to_string()),
                    Some("bytes=100-103") => (416, "{}".to_string()),
                    _ => (404, r#"{"message":"no such file"}"#.to_string()),
                },
                _ => (404, r#"{"message":"VM not found"}"#.to_string()),
            }
        });
        (Freestyle::new(Some(base), "fs-key".to_string()), seen)
    }

    #[tokio::test]
    async fn checks_the_key_lists_creates_and_changes_power_with_the_key() {
        let (api, seen) = freestyle();
        assert_eq!(api.check().await.unwrap(), "Freestyle · 3 VMs (1 running)");
        let machines = api.vms().await.unwrap();
        assert_eq!(machines.iter().map(|m| (m.id.as_str(), m.name.as_str(), m.state.as_str())).collect::<Vec<_>>(), vec![("freestyle:vm1", "agent", "running"), ("freestyle:vm2", "vm2", "stopped")]);
        assert_eq!(machines[0].detail, "Freestyle · 2 CPU · 4 GB");
        assert_eq!(api.launch("new").await.unwrap().state, "starting");
        api.power("vm1", "stop").await.unwrap();
        api.keep("vm1", 90).await.unwrap();
        assert!(api.power("vm1", "suspend").await.is_err());
        let log = seen.lock().unwrap();
        assert!(log.iter().all(|r| r.authorization.as_deref() == Some("Bearer fs-key")));
        let create: Value = serde_json::from_str(&log.iter().find(|r| r.method == "POST" && r.path == "/v5/vms").unwrap().body).unwrap();
        assert_eq!(create["firewall"]["rules"][0], json!({"action":"allow","source":{},"destination":{"public":true}}));
        assert_eq!(log.iter().find(|r| r.method == "PATCH").unwrap().body, r#"{"idleTimeoutSeconds":5400}"#);
    }

    #[tokio::test]
    async fn runs_commands_waking_a_paused_vm_first() {
        let (api, seen) = freestyle();
        assert_eq!(api.status("vm2").await.unwrap(), "stopped");
        assert_eq!(api.run("vm1", "echo $((6*7))", Duration::from_secs(9)).await.unwrap(), (Some(3), "42\nwarn\n".to_string()));
        api.run("vm2", "ls", Duration::from_secs(9)).await.unwrap();
        {
            let log = seen.lock().unwrap();
            assert!(!log.iter().any(|r| r.path == "/v5/vms/vm1/start"));
            assert!(log.iter().any(|r| r.path == "/v5/vms/vm2/start"));
            let exec = log.iter().find(|r| r.path == "/v5/vms/vm1/exec-await").unwrap();
            assert_eq!(serde_json::from_str::<Value>(&exec.body).unwrap(), json!({"command":"echo $((6*7))","timeoutMs":9000}));
        }
        assert_eq!(api.run("nope", "ls", Duration::from_secs(5)).await.unwrap_err(), "That cloud machine no longer exists.");
    }

    #[tokio::test]
    async fn downloads_a_byte_range_and_treats_missing_files_as_empty() {
        let (api, _) = freestyle();
        assert_eq!(api.read("vm1", "/f", 2, 4).await.unwrap(), b"cdef");
        assert!(api.read("vm1", "/f", 100, 4).await.unwrap().is_empty());
        assert!(api.read("vm1", "/missing", 0, 4).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn an_empty_key_is_refused_before_any_request() {
        assert!(Freestyle::new(None, String::new()).check().await.unwrap_err().contains("API key"));
    }

    /// `FREESTYLE_API_KEY=… cargo test freestyle_live -- --ignored`
    #[tokio::test]
    #[ignore]
    async fn freestyle_live_smoke() {
        let Ok(key) = std::env::var("FREESTYLE_API_KEY") else { return };
        let api = Freestyle::new(None, key);
        let id = api.launch("pandacode-smoke").await.unwrap().id.trim_start_matches("freestyle:").to_string();
        let t = Duration::from_secs(60);
        let result = async {
            assert_eq!(api.run(&id, "echo hi", t).await?, (Some(0), "hi\n".to_string()));
            api.run(&id, "setsid nohup sh -c 'sleep 120' >/dev/null 2>&1 </dev/null &", t).await?;
            assert_eq!(api.run(&id, "pgrep -x sleep", t).await?.0, Some(0));
            Ok::<_, String>(())
        }
        .await;
        api.power(&id, "delete").await.unwrap();
        result.unwrap();
    }
}
