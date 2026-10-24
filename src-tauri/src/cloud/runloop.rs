//! Runloop devboxes for cloud agents (docs/cloud-agents.md), through the REST API
//! (https://docs.runloop.ai/api-reference/devboxes). Suspending a devbox keeps its disk.
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    time::{Duration, Instant},
};

use super::{http, http::block, sandbox::{Info, Sandbox}, Machine};
use crate::Result;

const DEFAULT_API: &str = "https://api.runloop.ai";
const SERVICE: &str = "Runloop";
/// A devbox with no activity for this long is suspended (disk kept), never shut down.
/// `keep_alive` restarts the idle clock, so this is also the longest unattended stretch.
const IDLE_SECONDS: u32 = 6 * 3600;

pub struct Runloop {
    api: String,
    key: String,
}

fn machine(devbox: &Value) -> Machine {
    let id = devbox["id"].as_str().unwrap_or_default();
    let state = match devbox["status"].as_str().unwrap_or("unknown") {
        "running" => "running",
        "suspended" => "stopped",
        "scheduled" | "queued" | "provisioning" | "initializing" | "resuming" => "starting",
        "suspending" => "stopping",
        // Shut down and failed devboxes are gone for good; "error" makes callers recreate.
        "failure" | "shutdown" => "error",
        other => other,
    };
    Machine {
        id: format!("runloop:{id}"),
        provider: "runloop".into(),
        name: devbox["name"].as_str().filter(|n| !n.is_empty()).unwrap_or(id).to_string(),
        state: state.into(),
        os: "linux".into(),
        desktop: false,
        detail: "Runloop · 2 CPU · 4 GB".into(),
    }
}

impl Runloop {
    pub fn new(api: Option<String>, key: String) -> Self {
        Runloop { api: api.filter(|a| !a.trim().is_empty()).unwrap_or_else(|| DEFAULT_API.into()).trim_end_matches('/').to_string(), key }
    }
    fn connected() -> Result<Self> {
        Ok(Runloop::new(None, super::secret("runloop_key").ok_or("Connect Runloop in Settings → Cloud first.")?))
    }
    async fn call(&self, method: reqwest::Method, path: &str, body: Option<Value>) -> Result<Value> {
        let request = http::client(Duration::from_secs(60))?.request(method, format!("{}{path}", self.api)).bearer_auth(&self.key);
        http::send(SERVICE, match body { Some(body) => request.json(&body), None => request }).await
    }
    async fn post(&self, path: &str, body: Value) -> Result<Value> {
        self.call(reqwest::Method::POST, path, Some(body)).await
    }

    pub async fn list(&self) -> Result<Vec<Machine>> {
        let page = self.call(reqwest::Method::GET, "/v1/devboxes?limit=100", None).await?;
        let devboxes = page["devboxes"].as_array().cloned().unwrap_or_default();
        // Only PandaCode's own, and not the ones already shut down for good.
        Ok(devboxes.iter().filter(|d| d["metadata"]["pandacode"] == "true" && d["status"] != "shutdown").map(machine).collect())
    }
    pub async fn create(&self, name: &str) -> Result<Machine> {
        let body = json!({"name": name, "metadata": {"pandacode": "true"}, "launch_parameters": {"resource_size_request": "MEDIUM", "lifecycle": {"after_idle": {"idle_time_seconds": IDLE_SECONDS, "on_idle": "suspend"}}}});
        Ok(machine(&self.post("/v1/devboxes", body).await?))
    }
    pub async fn power(&self, id: &str, action: &str) -> Result<()> {
        let verb = match action {
            "start" => "resume",
            "stop" => "suspend",
            "delete" => "shutdown",
            _ => return Err(format!("Runloop devboxes can start, stop or be deleted, not {action}.")),
        };
        self.post(&format!("/v1/devboxes/{id}/{verb}"), json!({})).await.map(|_| ())
    }
    pub async fn state(&self, id: &str) -> Result<String> {
        Ok(machine(&self.call(reqwest::Method::GET, &format!("/v1/devboxes/{id}"), None).await?).state)
    }
    /// Restarts the idle clock set at creation; it can't be shortened or lengthened per call.
    pub async fn keep_alive(&self, id: &str) -> Result<()> {
        self.post(&format!("/v1/devboxes/{id}/keep_alive"), json!({})).await.map(|_| ())
    }

    /// Runs asynchronously and polls, so commands may run past the API's synchronous limit.
    pub async fn exec(&self, id: &str, command: &str, timeout: Duration) -> Result<(Option<i32>, String)> {
        let started = self.post(&format!("/v1/devboxes/{id}/execute_async"), json!({"command": format!("sh -c {} 2>&1", super::shell_quote(command))})).await?;
        let execution = started["execution_id"].as_str().ok_or("Runloop did not start the command.")?.to_string();
        let deadline = Instant::now() + timeout;
        loop {
            let view = if started["status"] == "completed" && started.get("exit_status").is_some() { started.clone() } else { self.call(reqwest::Method::GET, &format!("/v1/devboxes/{id}/executions/{execution}"), None).await? };
            if view["status"] == "completed" {
                return Ok((view["exit_status"].as_i64().map(|code| code as i32), view["stdout"].as_str().unwrap_or_default().to_string()));
            }
            if Instant::now() >= deadline {
                let _ = self.post(&format!("/v1/devboxes/{id}/executions/{execution}/kill"), json!({})).await;
                return Err("The command ran past its time limit.".into());
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }
}

impl Sandbox for Runloop {
    /// Idle devboxes suspend with their disk kept, so files persist; running processes may not.
    fn info(&self) -> Info {
        Info { persistent: true, max_unattended_minutes: IDLE_SECONDS / 60 }
    }
    fn list(&self) -> Result<Vec<Machine>> {
        block(Runloop::list(self))
    }
    fn create(&self, name: &str) -> Result<Machine> {
        block(Runloop::create(self, name))
    }
    fn power(&self, native: &str, action: &str) -> Result<()> {
        block(Runloop::power(self, native, action))
    }
    fn state(&self, native: &str) -> Result<String> {
        block(Runloop::state(self, native))
    }
    fn exec(&self, native: &str, command: &str, timeout: Duration) -> Result<(Option<i32>, String)> {
        block(Runloop::exec(self, native, command, timeout))
    }
    fn keep_alive(&self, native: &str, _minutes: u32) -> Result<()> {
        block(Runloop::keep_alive(self, native))
    }
}

pub fn connect(key: &str, _options: &Value) -> Result<()> {
    let key = key.trim();
    if key.is_empty() {
        return Err("Enter your Runloop API key.".into());
    }
    block(Runloop::new(None, key.into()).call(reqwest::Method::GET, "/v1/devboxes?limit=1", None))?;
    super::set_secret("runloop_key", key)?;
    let mut settings = super::settings();
    settings.providers.insert("runloop".into(), BTreeMap::from([("detail".into(), "API key saved".into())]));
    super::save_settings(&settings)
}
pub fn disconnect() -> Result<()> {
    super::remove_secret("runloop_key");
    let mut settings = super::settings();
    settings.providers.remove("runloop");
    super::save_settings(&settings)
}
pub fn sandbox() -> Result<Box<dyn Sandbox>> {
    Ok(Box::new(Runloop::connected()?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud::http::mock;

    fn runloop() -> (Runloop, mock::Seen) {
        let (base, seen) = mock::serve(|request, _| match (request.method.as_str(), request.path.as_str()) {
            ("GET", "/v1/devboxes?limit=100") => (200, r#"{"devboxes":[{"id":"dbx_1","name":"mine","status":"running","metadata":{"pandacode":"true"}},{"id":"dbx_2","status":"suspended","metadata":{"pandacode":"true"}},{"id":"dbx_3","status":"running","metadata":{}},{"id":"dbx_4","status":"shutdown","metadata":{"pandacode":"true"}}],"has_more":false}"#.to_string()),
            ("GET", "/v1/devboxes?limit=1") => (200, r#"{"devboxes":[]}"#.into()),
            ("POST", "/v1/devboxes") => (200, r#"{"id":"dbx_5","name":"job","status":"provisioning"}"#.into()),
            ("POST", "/v1/devboxes/dbx_1/suspend") | ("POST", "/v1/devboxes/dbx_2/resume") | ("POST", "/v1/devboxes/dbx_1/shutdown") | ("POST", "/v1/devboxes/dbx_1/keep_alive") => (200, "{}".into()),
            ("GET", "/v1/devboxes/dbx_2") => (200, r#"{"id":"dbx_2","status":"suspended"}"#.into()),
            ("GET", "/v1/devboxes/dbx_4") => (200, r#"{"id":"dbx_4","status":"shutdown"}"#.into()),
            ("GET", "/v1/devboxes/dbx_6") => (200, r#"{"id":"dbx_6","status":"failure"}"#.into()),
            ("POST", "/v1/devboxes/dbx_1/execute_async") => (200, r#"{"execution_id":"ex1","status":"running"}"#.into()),
            ("GET", "/v1/devboxes/dbx_1/executions/ex1") => (200, r#"{"execution_id":"ex1","status":"completed","exit_status":3,"stdout":"42\n"}"#.into()),
            _ => (500, r#"{"message":"unexpected"}"#.into()),
        });
        (Runloop::new(Some(base), "key-1".into()), seen)
    }

    #[tokio::test]
    async fn lists_only_pandacode_devboxes_and_maps_power() {
        let (api, seen) = runloop();
        let machines = api.list().await.unwrap();
        assert_eq!(machines.iter().map(|m| (m.id.as_str(), m.name.as_str(), m.state.as_str())).collect::<Vec<_>>(), vec![("runloop:dbx_1", "mine", "running"), ("runloop:dbx_2", "dbx_2", "stopped")]);
        let created = api.create("job").await.unwrap();
        assert_eq!((created.id.as_str(), created.state.as_str()), ("runloop:dbx_5", "starting"));
        api.power("dbx_1", "stop").await.unwrap();
        api.power("dbx_2", "start").await.unwrap();
        api.power("dbx_1", "delete").await.unwrap();
        assert!(api.power("dbx_1", "pause").await.is_err());
        assert_eq!(api.state("dbx_2").await.unwrap(), "stopped");
        assert_eq!(api.state("dbx_4").await.unwrap(), "error");
        assert_eq!(api.state("dbx_6").await.unwrap(), "error");
        let log = seen.lock().unwrap();
        assert!(log.iter().all(|r| r.authorization.as_deref() == Some("Bearer key-1")));
        let body: Value = serde_json::from_str(&log[1].body).unwrap();
        assert_eq!(body["metadata"], json!({"pandacode": "true"}));
        assert_eq!(body["launch_parameters"]["lifecycle"], json!({"after_idle": {"idle_time_seconds": 21600, "on_idle": "suspend"}}));
        assert!(body["launch_parameters"].get("keep_alive_time_seconds").is_none());
        assert_eq!(Sandbox::info(&api), Info { persistent: true, max_unattended_minutes: 360 });
    }

    #[tokio::test]
    async fn runs_commands_and_keeps_alive() {
        let (api, seen) = runloop();
        assert_eq!(api.exec("dbx_1", "echo $((6*7))", Duration::from_secs(5)).await.unwrap(), (Some(3), "42\n".to_string()));
        api.keep_alive("dbx_1").await.unwrap();
        let log = seen.lock().unwrap();
        let sent: Value = serde_json::from_str(&log[0].body).unwrap();
        assert_eq!(sent, json!({"command": "sh -c 'echo $((6*7))' 2>&1"}));
        assert!(log.iter().any(|r| r.path == "/v1/devboxes/dbx_1/keep_alive"));
    }

    #[tokio::test]
    async fn commands_past_their_limit_are_killed_and_errors_are_mapped() {
        let (base, seen) = mock::serve(|request, _| match request.path.as_str() {
            "/v1/devboxes/d/execute_async" => (200, r#"{"execution_id":"e","status":"running"}"#.to_string()),
            "/v1/devboxes/d/executions/e" => (200, r#"{"status":"running"}"#.into()),
            _ if request.path.ends_with("/kill") => (200, "{}".into()),
            _ => (401, r#"{"message":"bad"}"#.into()),
        });
        let api = Runloop::new(Some(base.clone()), "k".into());
        assert!(api.exec("d", "sleep 9", Duration::from_millis(100)).await.unwrap_err().contains("time limit"));
        assert!(seen.lock().unwrap().iter().any(|r| r.path.ends_with("/kill")));
        assert!(api.state("x").await.unwrap_err().contains("refused the credentials"));
        assert!(connect("", &Value::Null).is_err());
    }

    /// Needs RUNLOOP_API_KEY; run with `cargo test runloop_live -- --ignored`.
    #[test]
    #[ignore]
    fn runloop_live() {
        let api = Runloop::new(None, std::env::var("RUNLOOP_API_KEY").expect("RUNLOOP_API_KEY"));
        let made = Sandbox::create(&api, "pandacode-smoke").unwrap();
        let id = made.id.trim_start_matches("runloop:").to_string();
        let run = || -> Result<()> {
            for _ in 0..60 {
                if Sandbox::state(&api, &id)? == "running" { break; }
                std::thread::sleep(Duration::from_secs(2));
            }
            assert_eq!(Sandbox::exec(&api, &id, "echo hi", Duration::from_secs(60))?, (Some(0), "hi\n".into()));
            Sandbox::spawn(&api, &id, "sleep 120")?;
            let (_, ps) = Sandbox::exec(&api, &id, "ps -eo args | grep '[s]leep 120'", Duration::from_secs(30))?;
            assert!(ps.contains("sleep 120"));
            Sandbox::keep_alive(&api, &id, 30)
        };
        let result = run();
        Sandbox::power(&api, &id, "delete").unwrap();
        result.unwrap();
    }
}
