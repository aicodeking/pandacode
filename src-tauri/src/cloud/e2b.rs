//! E2B sandboxes for cloud agents (docs/cloud-agents.md). The control plane is E2B's REST API
//! (https://e2b.dev/docs/api-reference); commands run through the sandbox's `envd` daemon at
//! `https://49983-<id>.<domain>` using its Connect protocol (`process.Process/Start`, JSON
//! envelopes) and files through envd's `/files`. A paused sandbox keeps its files and memory.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{collections::BTreeMap, time::Duration};

use super::{http, http::block, sandbox::{Info, Sandbox}, Machine};
use crate::Result;

const DEFAULT_API: &str = "https://api.e2b.app";
const SERVICE: &str = "E2B";
const TEMPLATE: &str = "base";
/// Sandbox lifetime at creation; `keep_alive` extends it.
const INITIAL_MINUTES: u32 = 60;
/// Pro plans allow 24 h per session, Hobby 1 h (https://e2b.dev/docs/sandbox#sandbox-timeout).
const MAX_MINUTES: u32 = 24 * 60;
/// Keep this much of a command's output (the tail).
const KEEP: usize = 4 * 1024 * 1024;

pub struct E2b {
    api: String,
    /// Test override for the envd address (`https://49983-<id>.<domain>` otherwise).
    envd: Option<String>,
    key: String,
}

fn machine(sandbox: &Value) -> Machine {
    let id = sandbox["sandboxID"].as_str().unwrap_or_default();
    let resources = match (sandbox["cpuCount"].as_u64(), sandbox["memoryMB"].as_u64()) {
        (Some(cpu), Some(mb)) => format!(" · {cpu} CPU · {} GB", mb / 1024),
        _ => String::new(),
    };
    Machine {
        id: format!("e2b:{id}"),
        provider: "e2b".into(),
        name: sandbox["metadata"]["name"].as_str().filter(|n| !n.is_empty()).unwrap_or(id).to_string(),
        state: state_of(sandbox).into(),
        os: "linux".into(),
        desktop: false,
        detail: format!("E2B{resources}"),
    }
}
fn state_of(sandbox: &Value) -> &'static str {
    match sandbox["state"].as_str() {
        Some("paused") => "stopped",
        Some("running") | None => "running",
        _ => "error",
    }
}

impl E2b {
    pub fn new(api: Option<String>, envd: Option<String>, key: String) -> Self {
        E2b { api: api.filter(|a| !a.trim().is_empty()).unwrap_or_else(|| DEFAULT_API.into()).trim_end_matches('/').to_string(), envd, key }
    }
    fn connected() -> Result<Self> {
        Ok(E2b::new(None, None, super::secret("e2b_key").ok_or("Connect E2B in Settings → Cloud first.")?))
    }
    async fn api(&self, method: reqwest::Method, path: &str, body: Option<Value>) -> Result<Value> {
        let request = http::client(Duration::from_secs(60))?.request(method, format!("{}{path}", self.api)).header("X-API-Key", &self.key);
        http::send(SERVICE, match body { Some(body) => request.json(&body), None => request }).await
    }

    pub async fn list(&self) -> Result<Vec<Machine>> {
        let page = self.api(reqwest::Method::GET, "/v2/sandboxes?metadata=pandacode%3Dtrue&limit=100", None).await?;
        Ok(page.as_array().map(|items| items.iter().map(machine).collect()).unwrap_or_default())
    }
    pub async fn create(&self, name: &str) -> Result<Machine> {
        let body = json!({"templateID": TEMPLATE, "timeout": INITIAL_MINUTES * 60, "autoPause": true, "metadata": {"pandacode": "true", "name": name}});
        let mut made = machine(&self.api(reqwest::Method::POST, "/v2/sandboxes", Some(body)).await?);
        made.name = name.into();
        Ok(made)
    }
    pub async fn power(&self, id: &str, action: &str) -> Result<()> {
        let (method, path, body) = match action {
            "start" => (reqwest::Method::POST, format!("/v2/sandboxes/{id}/connect"), Some(json!({"timeout": INITIAL_MINUTES * 60}))),
            "stop" => (reqwest::Method::POST, format!("/sandboxes/{id}/pause"), None),
            "delete" => (reqwest::Method::DELETE, format!("/sandboxes/{id}"), None),
            _ => return Err(format!("E2B sandboxes can start, stop or be deleted, not {action}.")),
        };
        match self.api(method, &path, body).await {
            // Pausing a paused sandbox, or deleting a gone one, already did what was asked.
            Err(e) if action == "stop" && e.contains("paused") => Ok(()),
            result => result.map(|_| ()),
        }
    }
    async fn state(&self, id: &str) -> Result<String> {
        Ok(state_of(&self.api(reqwest::Method::GET, &format!("/sandboxes/{id}"), None).await?).into())
    }
    async fn set_timeout(&self, id: &str, seconds: u32) -> Result<()> {
        self.api(reqwest::Method::POST, &format!("/sandboxes/{id}/timeout"), Some(json!({"timeout": seconds}))).await.map(|_| ())
    }
    /// Plans cap the lifetime (Hobby 1 h); when the long timeout is refused, take the cap.
    pub async fn keep_alive(&self, id: &str, minutes: u32) -> Result<()> {
        let minutes = minutes.clamp(1, MAX_MINUTES);
        match self.set_timeout(id, minutes * 60).await {
            Err(_) if minutes > 60 => self.set_timeout(id, 3600).await,
            result => result,
        }
    }

    /// (envd base URL, access token) of a running sandbox.
    async fn envd(&self, id: &str) -> Result<(String, Option<String>)> {
        let sandbox = self.api(reqwest::Method::GET, &format!("/sandboxes/{id}"), None).await?;
        if state_of(&sandbox) != "running" {
            return Err("This E2B sandbox is paused. Start it first.".into());
        }
        let domain = sandbox["domain"].as_str().filter(|d| !d.is_empty()).unwrap_or("e2b.app");
        let base = self.envd.clone().unwrap_or_else(|| format!("https://49983-{id}.{domain}"));
        Ok((base, sandbox["envdAccessToken"].as_str().map(str::to_string)))
    }

    pub async fn exec(&self, id: &str, command: &str, timeout: Duration) -> Result<(Option<i32>, String)> {
        let (base, token) = self.envd(id).await?;
        let request = json!({"process": {"cmd": "/bin/bash", "args": ["-c", command]}, "stdin": false}).to_string();
        let mut body = vec![0u8];
        body.extend((request.len() as u32).to_be_bytes());
        body.extend(request.as_bytes());
        let mut call = http::client(timeout + Duration::from_secs(15))?
            .post(format!("{base}/process.Process/Start"))
            .header("Content-Type", "application/connect+json")
            .header("Connect-Protocol-Version", "1")
            .header("Connect-Timeout-Ms", (timeout.as_millis() + 10_000).to_string())
            .header("Authorization", format!("Basic {}", STANDARD.encode("user:")))
            .body(body);
        if let Some(token) = token {
            call = call.header("X-Access-Token", token);
        }
        let response = call.send().await.map_err(|e| if e.is_timeout() { "E2B did not answer in time.".to_string() } else { "Could not reach the E2B sandbox. Check your connection.".to_string() })?;
        let status = response.status().as_u16();
        let bytes = response.bytes().await.map_err(|_| "E2B response was cut off.".to_string())?;
        if !(200..300).contains(&status) {
            return Err(http::error_message(SERVICE, status, &String::from_utf8_lossy(&bytes)));
        }
        parse_stream(&bytes)
    }

    pub async fn upload(&self, id: &str, path: &str, bytes: &[u8], private: bool) -> Result<()> {
        let (base, token) = self.envd(id).await?;
        let url = reqwest::Url::parse_with_params(&format!("{base}/files"), [("path", path), ("username", "user")]).map_err(|_| "That file path is not valid.".to_string())?;
        // Multipart works on every envd version; the raw octet-stream upload needs a newer one.
        let boundary = format!("pandacode{}", uuid::Uuid::new_v4().simple());
        let filename: String = path.rsplit('/').next().unwrap_or("file").chars().map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '_' }).collect();
        let mut body = format!("--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\nContent-Type: application/octet-stream\r\n\r\n").into_bytes();
        body.extend(bytes);
        body.extend(format!("\r\n--{boundary}--\r\n").as_bytes());
        let mut call = http::client(Duration::from_secs(120))?
            .post(url)
            .header("Content-Type", format!("multipart/form-data; boundary={boundary}"))
            .body(body);
        if let Some(token) = token {
            call = call.header("X-Access-Token", token);
        }
        http::send(SERVICE, call).await?;
        if private {
            super::sandbox::checked(self.exec(id, &format!("chmod 600 {}", super::shell_quote(path)), Duration::from_secs(30)).await?)?;
        }
        Ok(())
    }
}

/// Decode a Connect response: 5-byte envelopes (flags, big-endian length) holding JSON events.
fn parse_stream(mut bytes: &[u8]) -> Result<(Option<i32>, String)> {
    let (mut output, mut code) = (Vec::new(), None);
    while bytes.len() >= 5 {
        let length = u32::from_be_bytes([bytes[1], bytes[2], bytes[3], bytes[4]]) as usize;
        let Some(payload) = bytes.get(5..5 + length) else { break };
        let message: Value = serde_json::from_slice(payload).map_err(|_| "E2B sent an unreadable command result.".to_string())?;
        if bytes[0] & 2 != 0 {
            // End of stream; a failure carries {"error": {"message": …}}.
            if let Some(error) = message["error"]["message"].as_str() {
                return Err(format!("E2B: {error}"));
            }
        } else {
            let event = &message["event"];
            for stream in ["stdout", "stderr"] {
                if let Some(chunk) = event["data"][stream].as_str().and_then(|c| STANDARD.decode(c).ok()) {
                    output.extend(chunk);
                }
            }
            if event["end"].is_object() {
                // Proto3 JSON leaves out a zero exit code.
                code = Some(event["end"]["exitCode"].as_i64().unwrap_or(0) as i32);
            }
        }
        bytes = &bytes[5 + length..];
    }
    let start = output.len().saturating_sub(KEEP);
    Ok((code, String::from_utf8_lossy(&output[start..]).into_owned()))
}

impl Sandbox for E2b {
    /// Pause keeps files and memory; sessions last 24 h on Pro and 1 h on Hobby.
    fn info(&self) -> Info {
        Info { persistent: true, max_unattended_minutes: MAX_MINUTES }
    }
    fn list(&self) -> Result<Vec<Machine>> {
        block(E2b::list(self))
    }
    fn create(&self, name: &str) -> Result<Machine> {
        block(E2b::create(self, name))
    }
    fn power(&self, native: &str, action: &str) -> Result<()> {
        block(E2b::power(self, native, action))
    }
    fn state(&self, native: &str) -> Result<String> {
        block(E2b::state(self, native))
    }
    fn exec(&self, native: &str, command: &str, timeout: Duration) -> Result<(Option<i32>, String)> {
        block(E2b::exec(self, native, command, timeout))
    }
    fn keep_alive(&self, native: &str, minutes: u32) -> Result<()> {
        block(E2b::keep_alive(self, native, minutes))
    }
    fn upload(&self, native: &str, path: &str, bytes: &[u8], private: bool) -> Result<()> {
        block(E2b::upload(self, native, path, bytes, private))
    }
}

pub fn connect(key: &str, _options: &Value) -> Result<()> {
    let key = key.trim();
    if key.is_empty() {
        return Err("Enter your E2B API key.".into());
    }
    block(E2b::new(None, None, key.into()).api(reqwest::Method::GET, "/v2/sandboxes?limit=1", None))?;
    super::set_secret("e2b_key", key)?;
    let mut settings = super::settings();
    settings.providers.insert("e2b".into(), BTreeMap::from([("detail".into(), "API key saved".into())]));
    super::save_settings(&settings)
}
pub fn disconnect() -> Result<()> {
    super::remove_secret("e2b_key");
    let mut settings = super::settings();
    settings.providers.remove("e2b");
    super::save_settings(&settings)
}
pub fn sandbox() -> Result<Box<dyn Sandbox>> {
    Ok(Box::new(E2b::connected()?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud::http::mock;

    fn frame(flags: u8, json: &str) -> Vec<u8> {
        let mut out = vec![flags];
        out.extend((json.len() as u32).to_be_bytes());
        out.extend(json.as_bytes());
        out
    }
    fn e2b() -> (E2b, mock::Seen) {
        let (base, seen) = mock::serve(|request, base| match (request.method.as_str(), request.path.as_str()) {
            ("GET", "/v2/sandboxes?metadata=pandacode%3Dtrue&limit=100") => (200, br#"[{"sandboxID":"s1","state":"running","metadata":{"name":"mine"},"cpuCount":2,"memoryMB":2048},{"sandboxID":"s2","state":"paused","metadata":{}}]"#.to_vec()),
            ("GET", "/v2/sandboxes?limit=1") => (200, b"[]".to_vec()),
            ("POST", "/v2/sandboxes") => (201, br#"{"sandboxID":"s3","domain":null}"#.to_vec()),
            ("POST", "/sandboxes/s1/pause") => (204, Vec::new()),
            ("POST", "/sandboxes/s2/pause") => (409, br#"{"message":"Sandbox is already paused"}"#.to_vec()),
            ("POST", "/v2/sandboxes/s2/connect") => (201, b"{}".to_vec()),
            ("DELETE", "/sandboxes/s1") => (204, Vec::new()),
            ("POST", "/sandboxes/s1/timeout") => (204, Vec::new()),
            ("POST", "/sandboxes/s9/timeout") => (400, br#"{"message":"Timeout too long"}"#.to_vec()),
            ("GET", "/sandboxes/s1") => (200, br#"{"sandboxID":"s1","state":"running","domain":"e2b.app","envdAccessToken":"tok"}"#.to_vec()),
            ("GET", "/sandboxes/s2") => (200, br#"{"sandboxID":"s2","state":"paused"}"#.to_vec()),
            ("POST", "/envd/process.Process/Start") => {
                let mut out = frame(0, r#"{"event":{"start":{"pid":7}}}"#);
                out.extend(frame(0, &format!(r#"{{"event":{{"data":{{"stdout":"{}"}}}}}}"#, STANDARD.encode("hi\n"))));
                out.extend(frame(0, &format!(r#"{{"event":{{"data":{{"stderr":"{}"}}}}}}"#, STANDARD.encode("oops\n"))));
                out.extend(frame(0, r#"{"event":{"end":{"exitCode":3,"exited":true}}}"#));
                out.extend(frame(2, "{}"));
                (200, out)
            }
            ("POST", p) if p.starts_with("/envd/files") => (200, br#"[{"path":"/x","name":"x","type":"file"}]"#.to_vec()),
            _ => { let _ = base; (500, br#"{"message":"unexpected"}"#.to_vec()) }
        });
        (E2b::new(Some(format!("{base}/")), Some(format!("{base}/envd")), "key-1".into()), seen)
    }

    #[tokio::test]
    async fn lists_creates_and_changes_power_with_the_key() {
        let (api, seen) = e2b();
        let machines = api.list().await.unwrap();
        assert_eq!(machines.iter().map(|m| (m.id.as_str(), m.name.as_str(), m.state.as_str())).collect::<Vec<_>>(), vec![("e2b:s1", "mine", "running"), ("e2b:s2", "s2", "stopped")]);
        assert_eq!(machines[0].detail, "E2B · 2 CPU · 2 GB");
        assert!(!machines[0].desktop && machines[0].os == "linux");
        assert_eq!(api.create("job").await.unwrap().id, "e2b:s3");
        api.power("s1", "stop").await.unwrap();
        api.power("s2", "stop").await.unwrap();
        api.power("s2", "start").await.unwrap();
        api.power("s1", "delete").await.unwrap();
        assert!(api.power("s1", "suspend").await.is_err());
        assert_eq!(api.state("s2").await.unwrap(), "stopped");
        let log = seen.lock().unwrap();
        assert!(log.iter().all(|r| r.headers.iter().any(|(n, v)| n == "x-api-key" && v == "key-1")));
        let body: Value = serde_json::from_str(&log[1].body).unwrap();
        assert_eq!(body, json!({"templateID":"base","timeout":3600,"autoPause":true,"metadata":{"pandacode":"true","name":"job"}}));
    }

    #[tokio::test]
    async fn runs_commands_through_envd_and_reads_the_exit_code() {
        let (api, seen) = e2b();
        assert_eq!(api.exec("s1", "echo hi", Duration::from_secs(5)).await.unwrap(), (Some(3), "hi\noops\n".to_string()));
        assert!(api.exec("s2", "ls", Duration::from_secs(5)).await.unwrap_err().contains("paused"));
        api.upload("s1", "/home/user/a.txt", b"abc", false).await.unwrap();
        let log = seen.lock().unwrap();
        let start = log.iter().find(|r| r.path == "/envd/process.Process/Start").unwrap();
        assert!(start.headers.iter().any(|(n, v)| n == "x-access-token" && v == "tok"));
        assert!(start.headers.iter().any(|(n, v)| n == "content-type" && v == "application/connect+json"));
        assert!(start.body.contains(r#""args":["-c","echo hi"]"#));
        assert!(log.iter().any(|r| r.path.starts_with("/envd/files?path=%2Fhome%2Fuser%2Fa.txt") && r.body.contains("name=\"file\"; filename=\"a.txt\"") && r.body.contains("\r\n\r\nabc\r\n--") && r.headers.iter().any(|(n, v)| n == "content-type" && v.starts_with("multipart/form-data; boundary="))));
    }

    #[tokio::test]
    async fn keep_alive_extends_the_timeout_and_falls_back_to_the_plan_cap() {
        let (api, seen) = e2b();
        api.keep_alive("s1", 600).await.unwrap();
        assert_eq!(seen.lock().unwrap().last().unwrap().body, r#"{"timeout":36000}"#);
        // Refused long timeouts retry at one hour (the Hobby cap) and report that failure too.
        assert!(api.keep_alive("s9", 600).await.is_err());
        let bodies: Vec<String> = seen.lock().unwrap().iter().filter(|r| r.path == "/sandboxes/s9/timeout").map(|r| r.body.clone()).collect();
        assert_eq!(bodies, vec![r#"{"timeout":36000}"#, r#"{"timeout":3600}"#]);
    }

    #[tokio::test]
    async fn bad_keys_and_stream_errors_are_readable() {
        let (base, _) = mock::serve(|_, _| (401, br#"{"message":"bad key"}"#.to_vec()));
        let api = E2b::new(Some(base), None, "nope".into());
        assert!(api.api(reqwest::Method::GET, "/v2/sandboxes?limit=1", None).await.unwrap_err().contains("refused the credentials"));
        let error = frame(2, r#"{"error":{"code":"deadline_exceeded","message":"timed out"}}"#);
        assert_eq!(parse_stream(&error).unwrap_err(), "E2B: timed out");
        assert!(connect(" ", &Value::Null).is_err());
    }

    /// Needs E2B_API_KEY; run with `cargo test e2b_live -- --ignored`.
    #[test]
    #[ignore]
    fn e2b_live() {
        let key = std::env::var("E2B_API_KEY").expect("E2B_API_KEY");
        let api = E2b::new(None, None, key);
        let made = Sandbox::create(&api, "pandacode-smoke").unwrap();
        let id = made.id.trim_start_matches("e2b:").to_string();
        let run = || -> Result<()> {
            assert_eq!(Sandbox::exec(&api, &id, "echo hi", Duration::from_secs(30))?, (Some(0), "hi\n".into()));
            Sandbox::spawn(&api, &id, "sleep 120")?;
            let (_, ps) = Sandbox::exec(&api, &id, "ps -eo args | grep '[s]leep 120'", Duration::from_secs(30))?;
            assert!(ps.contains("sleep 120"));
            Sandbox::keep_alive(&api, &id, 30)?;
            Sandbox::upload(&api, &id, "/tmp/p.txt", b"x", true)?;
            assert_eq!(Sandbox::download(&api, &id, "/tmp/p.txt", 0, 10)?, b"x");
            Ok(())
        };
        let result = run();
        Sandbox::power(&api, &id, "delete").unwrap();
        result.unwrap();
    }
}
