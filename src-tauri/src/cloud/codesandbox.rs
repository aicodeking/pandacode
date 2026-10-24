//! CodeSandbox sandboxes (SDK VMs) for cloud agents (docs/cloud-agents.md). The control
//! plane is the REST API at api.codesandbox.io (`openapi.json` in codesandbox/codesandbox-sdk):
//! fork the universal template, start, hibernate and delete VMs. Commands run through the
//! VM's "Pint" HTTP server (`pint-openapi-bundled.json`: `/api/v1/execs`), whose address
//! and token `POST /vm/{id}/start` returns when `use_pint` is true.
//!
//! Limit: the SDK's default transport is the Pitcher WebSocket protocol (binary-framed,
//! version-negotiated messages), which PandaCode doesn't speak. A VM whose start response
//! has no Pint address therefore can't run commands, and says so.
use serde_json::{json, Value};
use std::{collections::HashMap, sync::Mutex, time::{Duration, Instant}};

use super::{
    http::{self, block},
    sandbox::{Info, Sandbox},
    Machine,
};
use crate::Result;

const DEFAULT_API: &str = "https://api.codesandbox.io";
const SERVICE: &str = "CodeSandbox";
/// The SDK's own default template ("universal"): Debian with git, curl and Node.
const TEMPLATE: &str = "pcz35m";
/// Hibernation after this many idle seconds before `keep_alive` asks for more (24 h is the API maximum).
const HIBERNATE_SECONDS: u64 = 15 * 60;
const MAX_HIBERNATE_SECONDS: u64 = 24 * 60 * 60;
const OUTPUT_LIMIT: usize = 8 * 1024 * 1024;

pub struct CodeSandbox {
    api: String,
    key: String,
    /// Pint address and token per VM, so a command doesn't have to wake the VM each time.
    pints: Mutex<HashMap<String, (String, String)>>,
    /// The latest hibernation timeout `keep_alive` asked for, per VM, so a re-start doesn't undo it.
    timeouts: Mutex<HashMap<String, u64>>,
}

pub fn connect(key: &str, _options: &Value) -> Result<()> {
    let key = key.trim();
    let detail = block(CodeSandbox::new(None, key.into()).check())?;
    super::set_secret("codesandbox_key", key)?;
    let mut settings = super::settings();
    settings.providers.insert("codesandbox".into(), [("detail".to_string(), detail)].into());
    super::save_settings(&settings)
}
pub fn disconnect() -> Result<()> {
    super::remove_secret("codesandbox_key");
    let mut settings = super::settings();
    settings.providers.remove("codesandbox");
    super::save_settings(&settings)
}
pub fn sandbox() -> Result<Box<dyn Sandbox>> {
    let key = super::secret("codesandbox_key").ok_or("Connect CodeSandbox in Settings → Cloud first.")?;
    Ok(Box::new(CodeSandbox::new(None, key)))
}

/// One SSE payload per `data:` line.
fn sse_events(text: &str) -> impl Iterator<Item = Value> + '_ {
    text.lines().filter_map(|l| l.strip_prefix("data:")).filter_map(|d| serde_json::from_str(d.trim()).ok())
}

impl CodeSandbox {
    pub fn new(api: Option<String>, key: String) -> Self {
        CodeSandbox { api: api.filter(|a| !a.trim().is_empty()).unwrap_or_else(|| DEFAULT_API.into()).trim_end_matches('/').to_string(), key, pints: Mutex::default(), timeouts: Mutex::default() }
    }

    /// `{success, data}` envelope → `data`.
    async fn call(&self, base: &str, token: &str, method: reqwest::Method, path: &str, body: Option<Value>, timeout: Duration) -> Result<Value> {
        let request = http::client(timeout)?.request(method, format!("{}{path}", base.trim_end_matches('/'))).bearer_auth(token);
        let mut reply = http::send(SERVICE, match body { Some(body) => request.json(&body), None => request }).await?;
        Ok(reply.get_mut("data").map(Value::take).unwrap_or(reply))
    }
    async fn api(&self, method: reqwest::Method, path: &str, body: Option<Value>) -> Result<Value> {
        self.call(&self.api, &self.key, method, path, body, Duration::from_secs(60)).await
    }

    /// A cheap authenticated request; returns the text Settings shows.
    pub async fn check(&self) -> Result<String> {
        if self.key.is_empty() {
            return Err("Paste a CodeSandbox API key first.".into());
        }
        let running = self.api(reqwest::Method::GET, "/vm/running", None).await?;
        Ok(format!("CodeSandbox · {} of {} VMs running", running["concurrent_vm_count"].as_u64().unwrap_or(0), running["concurrent_vm_limit"].as_u64().unwrap_or(0)))
    }

    fn machine(id: &str, title: &str, running: bool) -> Machine {
        Machine {
            id: format!("codesandbox:{id}"),
            provider: "codesandbox".into(),
            name: if title.is_empty() { id.into() } else { title.into() },
            state: if running { "running" } else { "stopped" }.into(),
            os: "linux".into(),
            desktop: false,
            detail: "CodeSandbox VM".into(),
        }
    }
    async fn running_ids(&self) -> Result<Vec<String>> {
        let running = self.api(reqwest::Method::GET, "/vm/running", None).await?;
        Ok(running["vms"].as_array().map(|vms| vms.iter().filter_map(|v| v["id"].as_str().map(str::to_string)).collect()).unwrap_or_default())
    }

    pub async fn sandboxes(&self) -> Result<Vec<Machine>> {
        let running = self.running_ids().await?;
        let page = self.api(reqwest::Method::GET, "/sandbox?tags=pandacode&page_size=100", None).await?;
        Ok(page["sandboxes"].as_array().map(|all| all.iter().filter_map(|s| s["id"].as_str().map(|id| Self::machine(id, s["title"].as_str().unwrap_or_default(), running.iter().any(|r| r == id)))).collect()).unwrap_or_default())
    }
    /// Fork the template into a private sandbox and boot it, so we know commands will work.
    pub async fn launch(&self, name: &str) -> Result<Machine> {
        let body = json!({"title": name, "privacy": 2, "tags": ["pandacode"]});
        let forked = self.api(reqwest::Method::POST, &format!("/sandbox/{TEMPLATE}/fork"), Some(body)).await?;
        let id = forked["id"].as_str().ok_or("CodeSandbox did not return a sandbox ID.")?.to_string();
        if let Err(error) = self.pint(&id).await {
            let _ = self.api(reqwest::Method::DELETE, &format!("/vm/{id}"), None).await;
            return Err(error);
        }
        Ok(Self::machine(&id, name, true))
    }
    pub async fn status(&self, id: &str) -> Result<String> {
        Ok(if self.running_ids().await?.iter().any(|r| r == id) { "running" } else { "stopped" }.into())
    }
    pub async fn power(&self, id: &str, action: &str) -> Result<()> {
        // A wake, hibernation or delete invalidates the cached address.
        self.pints.lock().unwrap_or_else(|e| e.into_inner()).remove(id);
        let (method, path, body) = match action {
            "start" => (reqwest::Method::POST, format!("/vm/{id}/start"), Some(json!({"hibernation_timeout_seconds": self.timeout(id)}))),
            "stop" => (reqwest::Method::POST, format!("/vm/{id}/hibernate"), Some(json!({}))),
            "delete" => (reqwest::Method::DELETE, format!("/vm/{id}"), None),
            _ => return Err(format!("CodeSandbox VMs can start, stop or be deleted, not {action}.")),
        };
        self.api(method, &path, body).await.map(|_| ())
    }
    fn timeout(&self, id: &str) -> u64 {
        self.timeouts.lock().unwrap_or_else(|e| e.into_inner()).get(id).copied().unwrap_or(HIBERNATE_SECONDS)
    }
    /// Start (or wake) the VM, remember its Pint address and token, and return them.
    async fn pint(&self, id: &str) -> Result<(String, String)> {
        let started = self.api(reqwest::Method::POST, &format!("/vm/{id}/start"), Some(json!({"hibernation_timeout_seconds": self.timeout(id)}))).await?;
        match (started["use_pint"].as_bool(), started["pint_url"].as_str().filter(|u| !u.is_empty()), started["pint_token"].as_str()) {
            (Some(true), Some(url), Some(token)) => {
                let pint = (url.to_string(), token.to_string());
                self.pints.lock().unwrap_or_else(|e| e.into_inner()).insert(id.to_string(), pint.clone());
                Ok(pint)
            }
            _ => Err("This CodeSandbox VM only offers the Pitcher WebSocket protocol, which PandaCode can't run commands through yet.".into()),
        }
    }
    async fn pint_call(&self, pint: &(String, String), method: reqwest::Method, path: &str, body: Option<Value>) -> Result<Value> {
        self.call(&pint.0, &pint.1, method, path, body, Duration::from_secs(60)).await
    }
    async fn begin(&self, pint: &(String, String), command: &str) -> Result<String> {
        let body = json!({"command": "sh", "args": ["-c", command], "autorun": true, "interactive": false});
        let exec = self.pint_call(pint, reqwest::Method::POST, "/api/v1/execs", Some(body)).await?;
        Ok(exec["id"].as_str().ok_or("CodeSandbox did not start the command.")?.to_string())
    }

    pub async fn run(&self, id: &str, command: &str, timeout: Duration) -> Result<(Option<i32>, String)> {
        let cached = self.pints.lock().unwrap_or_else(|e| e.into_inner()).get(id).cloned();
        let begun = match cached {
            Some(pint) => self.begin(&pint, command).await.map(|exec| (pint, exec)).ok(),
            None => None,
        };
        // No cached address, or it went stale (the VM hibernated, the token expired): wake it once.
        let (pint, exec_id) = match begun {
            Some(begun) => begun,
            None => {
                let pint = self.pint(id).await?;
                let exec = self.begin(&pint, command).await?;
                (pint, exec)
            }
        };
        let started = Instant::now();
        let code = loop {
            let state = self.pint_call(&pint, reqwest::Method::GET, &format!("/api/v1/execs/{exec_id}"), None).await?;
            if !state["status"].as_str().unwrap_or_default().eq_ignore_ascii_case("running") {
                break state["exitCode"].as_i64().map(|c| c as i32);
            }
            if started.elapsed() > timeout {
                let _ = self.pint_call(&pint, reqwest::Method::DELETE, &format!("/api/v1/execs/{exec_id}"), None).await;
                break None;
            }
            tokio::time::sleep(Duration::from_millis(400)).await;
        };
        Ok((code, self.output(&pint.0, &pint.1, &exec_id).await?))
    }
    /// The exec's buffered output (SSE events), read until the server closes or goes quiet.
    async fn output(&self, url: &str, token: &str, exec_id: &str) -> Result<String> {
        let client = http::client(Duration::from_secs(120))?;
        let mut response = client.get(format!("{}/api/v1/execs/{exec_id}/io", url.trim_end_matches('/'))).bearer_auth(token).header("Accept", "text/event-stream").send().await
            .map_err(|_| format!("Could not reach {SERVICE}. Check your connection."))?;
        if !response.status().is_success() {
            return Err(http::error_message(SERVICE, response.status().as_u16(), ""));
        }
        let mut raw = Vec::new();
        // ponytail: a stream that never closes ends after 3 s of silence; fine for finished execs.
        while let Ok(Ok(Some(chunk))) = tokio::time::timeout(Duration::from_secs(3), response.chunk()).await {
            raw.extend_from_slice(&chunk);
            if raw.len() > OUTPUT_LIMIT {
                break;
            }
        }
        let text = String::from_utf8_lossy(&raw);
        Ok(sse_events(&text).filter(|e| matches!(e["type"].as_str(), Some("stdout" | "stderr"))).filter_map(|e| e["output"].as_str().map(str::to_string)).collect())
    }
    pub async fn keep(&self, id: &str, minutes: u32) -> Result<()> {
        let seconds = (u64::from(minutes) * 60).clamp(60, MAX_HIBERNATE_SECONDS);
        self.timeouts.lock().unwrap_or_else(|e| e.into_inner()).insert(id.to_string(), seconds);
        self.api(reqwest::Method::PUT, &format!("/vm/{id}/hibernation_timeout"), Some(json!({"hibernation_timeout_seconds": seconds}))).await.map(|_| ())
    }
}

impl Sandbox for CodeSandbox {
    /// Hibernation snapshots the whole VM, so files and running processes come back.
    fn info(&self) -> Info {
        Info { persistent: true, max_unattended_minutes: 24 * 60 }
    }
    fn list(&self) -> Result<Vec<Machine>> {
        block(self.sandboxes())
    }
    fn create(&self, name: &str) -> Result<Machine> {
        block(self.launch(name))
    }
    fn power(&self, native: &str, action: &str) -> Result<()> {
        block(CodeSandbox::power(self, native, action))
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud::http::mock;

    /// The REST API and a VM's Pint server in one loopback server.
    fn codesandbox(use_pint: bool) -> (CodeSandbox, mock::Seen) {
        let (base, seen) = mock::serve(move |request, base| match (request.method.as_str(), request.path.as_str()) {
            ("GET", "/vm/running") => (200, r#"{"success":true,"data":{"concurrent_vm_count":1,"concurrent_vm_limit":10,"vms":[{"id":"vm1"}]}}"#.to_string()),
            ("GET", "/sandbox?tags=pandacode&page_size=100") => (200, r#"{"data":{"sandboxes":[{"id":"vm1","title":"agent"},{"id":"vm2","title":""}],"pagination":{}}}"#.to_string()),
            ("POST", "/sandbox/pcz35m/fork") => (200, r#"{"data":{"id":"vm3","alias":"a"}}"#.to_string()),
            ("POST", "/vm/vm1/start") | ("POST", "/vm/vm3/start") => (200, format!(r#"{{"data":{{"use_pint":{use_pint},"pint_url":"{base}/pint/","pint_token":"pt-1"}}}}"#)),
            ("DELETE", "/vm/vm3") | ("POST", "/vm/vm1/hibernate") | ("PUT", "/vm/vm1/hibernation_timeout") => (200, r#"{"success":true}"#.to_string()),
            ("POST", "/pint/api/v1/execs") => (201, r#"{"id":"e1","status":"RUNNING"}"#.to_string()),
            ("GET", "/pint/api/v1/execs/e1") => (200, r#"{"id":"e1","status":"EXITED","exitCode":3}"#.to_string()),
            ("GET", "/pint/api/v1/execs/e1/io") => (200, "data: {\"type\":\"stdout\",\"output\":\"42\\n\",\"sequence\":1}\n\ndata: {\"type\":\"stderr\",\"output\":\"warn\\n\",\"sequence\":2}\n\n".to_string()),
            _ => (404, r#"{"errors":["not found"]}"#.to_string()),
        });
        (CodeSandbox::new(Some(format!("{base}/")), "csb-key".to_string()), seen)
    }

    #[tokio::test]
    async fn checks_the_key_lists_and_forks_private_tagged_sandboxes() {
        let (api, seen) = codesandbox(true);
        assert_eq!(api.check().await.unwrap(), "CodeSandbox · 1 of 10 VMs running");
        let machines = api.sandboxes().await.unwrap();
        assert_eq!(machines.iter().map(|m| (m.id.as_str(), m.name.as_str(), m.state.as_str())).collect::<Vec<_>>(), vec![("codesandbox:vm1", "agent", "running"), ("codesandbox:vm2", "vm2", "stopped")]);
        assert_eq!(api.launch("new").await.unwrap().id, "codesandbox:vm3");
        api.power("vm1", "stop").await.unwrap();
        api.keep("vm1", 90).await.unwrap();
        assert!(api.power("vm1", "pause").await.is_err());
        let log = seen.lock().unwrap();
        assert!(log.iter().all(|r| r.authorization.as_deref() == Some("Bearer csb-key") || r.path.starts_with("/pint")));
        let fork = log.iter().find(|r| r.path.ends_with("/fork")).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&fork.body).unwrap(), json!({"title":"new","privacy":2,"tags":["pandacode"]}));
        assert_eq!(log.iter().find(|r| r.method == "PUT").unwrap().body, r#"{"hibernation_timeout_seconds":5400}"#);
    }

    #[tokio::test]
    async fn runs_commands_through_pint_with_the_vm_token() {
        let (api, seen) = codesandbox(true);
        assert_eq!(api.run("vm1", "echo $((6*7))", Duration::from_secs(9)).await.unwrap(), (Some(3), "42\nwarn\n".to_string()));
        api.keep("vm1", 24 * 60).await.unwrap();
        api.run("vm1", "ls", Duration::from_secs(9)).await.unwrap();
        // The VM is woken once; later commands reuse the address, so the 24 h timeout stays.
        let log = seen.lock().unwrap();
        assert_eq!(log.iter().filter(|r| r.path == "/vm/vm1/start").count(), 1);
        let exec = log.iter().find(|r| r.path == "/pint/api/v1/execs").unwrap();
        assert_eq!(exec.authorization.as_deref(), Some("Bearer pt-1"));
        assert_eq!(serde_json::from_str::<Value>(&exec.body).unwrap(), json!({"command":"sh","args":["-c","echo $((6*7))"],"autorun":true,"interactive":false}));
    }

    #[tokio::test]
    async fn a_stale_address_wakes_the_vm_again_with_the_latest_timeout() {
        let (api, seen) = codesandbox(true);
        api.keep("vm1", 24 * 60).await.unwrap();
        api.pints.lock().unwrap().insert("vm1".into(), ("http://127.0.0.1:1".into(), "old".into()));
        assert_eq!(api.run("vm1", "ls", Duration::from_secs(9)).await.unwrap().0, Some(3));
        let log = seen.lock().unwrap();
        let start = log.iter().find(|r| r.path == "/vm/vm1/start").unwrap();
        assert_eq!(start.body, r#"{"hibernation_timeout_seconds":86400}"#);
        assert_eq!(api.pints.lock().unwrap()["vm1"].1, "pt-1");
    }

    #[tokio::test]
    async fn vms_without_pint_explain_and_are_not_left_behind() {
        let (api, seen) = codesandbox(false);
        assert!(api.run("vm1", "ls", Duration::from_secs(5)).await.unwrap_err().contains("Pitcher WebSocket"));
        assert!(api.launch("new").await.is_err());
        assert!(seen.lock().unwrap().iter().any(|r| r.method == "DELETE" && r.path == "/vm/vm3"));
    }

    #[tokio::test]
    async fn an_empty_key_is_refused_before_any_request() {
        assert!(CodeSandbox::new(None, String::new()).check().await.unwrap_err().contains("API key"));
    }

    /// `CSB_API_KEY=… cargo test codesandbox_live -- --ignored`
    #[tokio::test]
    #[ignore]
    async fn codesandbox_live_smoke() {
        let Ok(key) = std::env::var("CSB_API_KEY") else { return };
        let api = CodeSandbox::new(None, key);
        let id = api.launch("pandacode-smoke").await.unwrap().id.trim_start_matches("codesandbox:").to_string();
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
