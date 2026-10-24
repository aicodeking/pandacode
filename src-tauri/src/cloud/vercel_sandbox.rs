//! Vercel Sandbox machines for cloud agents (docs/cloud-agents.md), over the REST API the
//! `@vercel/sandbox` SDK uses (github.com/vercel/sandbox, `api-client.ts`). The connection
//! is the deploy token from Settings → Cloud plus a project (and team) ID for Sandbox.
//!
//! Sandboxes are ephemeral microVMs: a stopped one is gone, so cloud agents recreate and
//! rehydrate. A machine ID is the *session* ID, which is what the command and file routes take.
use serde_json::{json, Value};
use std::time::Duration;

use super::{
    http::{self, block},
    sandbox::{Info, Sandbox},
    Machine,
};
use crate::Result;

const DEFAULT_API: &str = "https://vercel.com/api";
const SERVICE: &str = "Vercel";
const RUNTIME: &str = "node22";
/// Hobby accounts allow 45 minutes per sandbox; `keep_alive` extends it on plans that allow more.
const START_TIMEOUT_MS: u64 = 45 * 60 * 1000;
/// Pro and Enterprise cap a sandbox at five hours.
const MAX_MINUTES: u32 = 300;
const LIMIT: usize = 16 * 1024 * 1024;

pub struct Vercel {
    api: String,
    token: String,
    project: String,
    team: Option<String>,
}

pub fn sandbox() -> Result<Box<dyn Sandbox>> {
    let token = super::secret("vercel_token").ok_or("Connect Vercel in Settings → Cloud first.")?;
    let settings = super::settings();
    let options = settings.providers.get("vercel");
    let option = |key: &str| options.and_then(|o| o.get(key)).map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
    let project = option("projectId").ok_or("Add a Vercel project ID for Sandbox in Settings → Cloud.")?;
    let team = option("teamId").or_else(|| settings.vercel_team.clone().filter(|t| !t.trim().is_empty()));
    Ok(Box::new(Vercel::new(None, token, project, team)))
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

fn machine(session: &Value) -> Machine {
    let id = session["id"].as_str().unwrap_or_default();
    let state = match session["status"].as_str().unwrap_or("unknown") {
        "running" => "running",
        "pending" => "starting",
        "stopping" | "snapshotting" => "stopping",
        "stopped" => "stopped",
        "failed" | "aborted" => "error",
        other => other,
    };
    Machine {
        id: format!("vercel:{id}"),
        provider: "vercel".into(),
        name: id.to_string(),
        state: state.into(),
        os: "linux".into(),
        desktop: false,
        detail: format!("Vercel Sandbox · {} vCPU · {} GB", session["vcpus"].as_u64().unwrap_or(0), session["memory"].as_u64().unwrap_or(0) / 1024),
    }
}

/// The exit code and combined output from a `wait` command's NDJSON stream: a `{command}`
/// line, `{stream, data}` log lines, then `{command}` again with the exit code.
fn parse_stream(text: &str) -> Result<(Option<i32>, String, Option<String>)> {
    let (mut code, mut output, mut id) = (None, String::new(), None);
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        let Ok(value) = serde_json::from_str::<Value>(line) else { continue };
        match value["stream"].as_str() {
            Some("stdout" | "stderr") => output.push_str(value["data"].as_str().unwrap_or_default()),
            Some("error") => return Err(format!("{SERVICE}: {}", value["data"]["message"].as_str().unwrap_or("the command stream failed"))),
            _ => {
                id = id.or_else(|| value["command"]["id"].as_str().map(str::to_string));
                code = value["command"]["exitCode"].as_i64().map(|c| c as i32).or(code);
            }
        }
    }
    Ok((code, output, id))
}

impl Vercel {
    pub fn new(api: Option<String>, token: String, project: String, team: Option<String>) -> Self {
        Vercel { api: api.filter(|a| !a.trim().is_empty()).unwrap_or_else(|| DEFAULT_API.into()).trim_end_matches('/').to_string(), token, project, team }
    }

    fn request(&self, client: &reqwest::Client, method: reqwest::Method, path: &str, query: &[(&str, &str)]) -> reqwest::RequestBuilder {
        let mut pairs = query.to_vec();
        if let Some(team) = &self.team {
            // `team_…` is an ID; anything else is the team's slug.
            pairs.push((if team.starts_with("team_") { "teamId" } else { "slug" }, team.as_str()));
        }
        client.request(method, with_query(format!("{}{path}", self.api), &pairs)).bearer_auth(&self.token)
    }
    async fn call(&self, method: reqwest::Method, path: &str, query: &[(&str, &str)], body: Option<Value>, timeout: Duration) -> Result<Value> {
        let request = self.request(&http::client(timeout)?, method, path, query);
        http::send(SERVICE, match body { Some(body) => request.json(&body), None => request }).await
    }
    async fn api(&self, method: reqwest::Method, path: &str, body: Option<Value>) -> Result<Value> {
        self.call(method, path, &[], body, Duration::from_secs(60)).await
    }
    /// Like `call` but returns the raw body, for NDJSON streams.
    async fn text(&self, method: reqwest::Method, path: &str, query: &[(&str, &str)], body: Value, timeout: Duration) -> Result<String> {
        let response = self.request(&http::client(timeout)?, method, path, query).json(&body).send().await.map_err(|e| {
            if e.is_timeout() { format!("{SERVICE} did not answer in time.") } else { format!("Could not reach {SERVICE}. Check your connection.") }
        })?;
        let status = response.status().as_u16();
        let bytes = response.bytes().await.map_err(|_| format!("{SERVICE} response was cut off."))?;
        if bytes.len() > LIMIT {
            return Err(format!("{SERVICE} sent a response that is too large."));
        }
        let text = String::from_utf8_lossy(&bytes).into_owned();
        if !(200..300).contains(&status) {
            return Err(http::error_message(SERVICE, status, &text));
        }
        Ok(text)
    }

    pub async fn sessions(&self) -> Result<Vec<Machine>> {
        let page = self.call(reqwest::Method::GET, "/v2/sandboxes/sessions", &[("project", &self.project)], None, Duration::from_secs(60)).await?;
        let live = |s: &&Value| matches!(s["status"].as_str(), Some("pending" | "running" | "stopping"));
        Ok(page["sessions"].as_array().map(|all| all.iter().filter(live).map(machine).collect()).unwrap_or_default())
    }
    pub async fn launch(&self) -> Result<Machine> {
        let body = json!({"projectId": self.project, "runtime": RUNTIME, "timeout": START_TIMEOUT_MS});
        Ok(machine(&self.api(reqwest::Method::POST, "/v2/sandboxes", Some(body)).await?["session"]))
    }
    pub async fn status(&self, id: &str) -> Result<String> {
        Ok(machine(&self.api(reqwest::Method::GET, &format!("/v2/sandboxes/sessions/{id}"), None).await?["session"]).state)
    }
    /// Sandboxes cannot be paused or restarted, only stopped for good.
    pub async fn halt(&self, id: &str, action: &str) -> Result<()> {
        match action {
            "stop" | "delete" => match self.api(reqwest::Method::POST, &format!("/v2/sandboxes/sessions/{id}/stop"), None).await {
                // Already gone is the state the caller wanted.
                Err(e) if action == "delete" && e.contains("not found") => Ok(()),
                other => other.map(|_| ()),
            },
            "start" => Err("A stopped Vercel sandbox can't be restarted. Create a new one.".into()),
            _ => Err(format!("Vercel sandboxes can be stopped or deleted, not {action}.")),
        }
    }
    pub async fn run(&self, id: &str, command: &str, timeout: Duration) -> Result<(Option<i32>, String)> {
        let body = json!({"command": "sh", "args": ["-c", command], "sudo": false, "wait": true, "logs": true});
        let path = format!("/v2/sandboxes/sessions/{id}/cmd");
        let text = self.text(reqwest::Method::POST, &path, &[], body, timeout + Duration::from_secs(15)).await?;
        let (mut code, output, command_id) = parse_stream(&text)?;
        if let (None, Some(command_id)) = (code, command_id) {
            let finished = self.call(reqwest::Method::GET, &format!("{path}/{command_id}"), &[("wait", "true")], None, timeout + Duration::from_secs(15)).await?;
            code = finished["command"]["exitCode"].as_i64().map(|c| c as i32);
        }
        Ok((code, output))
    }
    /// Add `minutes` to the sandbox's remaining time. Plans cap the total, so a refusal
    /// falls back to a smaller extension instead of failing the run.
    pub async fn extend(&self, id: &str, minutes: u32) -> Result<()> {
        let path = format!("/v2/sandboxes/sessions/{id}/extend-timeout");
        let wanted = minutes.min(MAX_MINUTES);
        let ask = |m: u32| self.api(reqwest::Method::POST, &path, Some(json!({"duration": u64::from(m) * 60_000})));
        match ask(wanted).await {
            Err(_) if wanted > 30 => ask(30).await.map(|_| ()),
            other => other.map(|_| ()),
        }
    }
}

impl Sandbox for Vercel {
    fn info(&self) -> Info {
        Info { persistent: false, max_unattended_minutes: MAX_MINUTES }
    }
    fn list(&self) -> Result<Vec<Machine>> {
        block(self.sessions())
    }
    fn create(&self, _name: &str) -> Result<Machine> {
        block(self.launch())
    }
    fn power(&self, native: &str, action: &str) -> Result<()> {
        block(self.halt(native, action))
    }
    fn state(&self, native: &str) -> Result<String> {
        block(self.status(native))
    }
    fn exec(&self, native: &str, command: &str, timeout: Duration) -> Result<(Option<i32>, String)> {
        block(self.run(native, command, timeout))
    }
    fn keep_alive(&self, native: &str, minutes: u32) -> Result<()> {
        block(self.extend(native, minutes))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud::http::mock;

    fn vercel() -> (Vercel, mock::Seen) {
        let (base, seen) = mock::serve(|request, _| {
            let path = request.path.split('?').next().unwrap_or_default();
            match (request.method.as_str(), path) {
                ("GET", "/api/v2/sandboxes/sessions") => (200, r#"{"sessions":[{"id":"sbx_1","status":"running","vcpus":2,"memory":4096},{"id":"sbx_2","status":"stopped","vcpus":2,"memory":4096}]}"#.to_string()),
                ("POST", "/api/v2/sandboxes") => (200, r#"{"sandbox":{"name":"n"},"session":{"id":"sbx_3","status":"pending","vcpus":2,"memory":4096},"routes":[]}"#.to_string()),
                ("GET", "/api/v2/sandboxes/sessions/sbx_1") => (200, r#"{"session":{"id":"sbx_1","status":"running"}}"#.to_string()),
                ("POST", "/api/v2/sandboxes/sessions/sbx_1/stop") => (200, r#"{"session":{"id":"sbx_1","status":"stopping"}}"#.to_string()),
                ("POST", "/api/v2/sandboxes/sessions/sbx_1/cmd") => (200, "{\"command\":{\"id\":\"cmd_1\",\"exitCode\":null}}\n{\"stream\":\"stdout\",\"data\":\"42\\n\"}\n{\"stream\":\"stderr\",\"data\":\"warn\\n\"}\n{\"command\":{\"id\":\"cmd_1\",\"exitCode\":3}}\n".to_string()),
                ("POST", "/api/v2/sandboxes/sessions/sbx_1/extend-timeout") => {
                    let big = request.body.contains("18000000");
                    if big { (400, r#"{"error":{"message":"Too long"}}"#.to_string()) } else { (200, r#"{"session":{"id":"sbx_1","status":"running"}}"#.to_string()) }
                }
                _ => (404, r#"{"error":{"message":"sandbox not found"}}"#.to_string()),
            }
        });
        (Vercel::new(Some(format!("{base}/api/")), "tok-1".into(), "prj_1".into(), Some("team_1".into())), seen)
    }

    #[tokio::test]
    async fn lists_creates_and_stops_with_token_project_and_team() {
        let (api, seen) = vercel();
        let machines = api.sessions().await.unwrap();
        assert_eq!(machines.len(), 1);
        assert_eq!((machines[0].id.as_str(), machines[0].state.as_str(), machines[0].detail.as_str()), ("vercel:sbx_1", "running", "Vercel Sandbox · 2 vCPU · 4 GB"));
        assert_eq!(api.launch().await.unwrap().state, "starting");
        assert_eq!(api.status("sbx_1").await.unwrap(), "running");
        api.halt("sbx_1", "stop").await.unwrap();
        api.halt("gone", "delete").await.unwrap();
        assert!(api.halt("sbx_1", "start").await.unwrap_err().contains("can't be restarted"));
        let log = seen.lock().unwrap();
        assert!(log.iter().all(|r| r.authorization.as_deref() == Some("Bearer tok-1") && r.path.contains("teamId=team_1")));
        assert!(log[0].path.contains("project=prj_1"));
        let body: Value = serde_json::from_str(&log[1].body).unwrap();
        assert_eq!(body, json!({"projectId":"prj_1","runtime":"node22","timeout":2700000}));
    }

    #[tokio::test]
    async fn a_team_slug_is_sent_as_slug_not_team_id() {
        let (base, seen) = mock::serve(|_, _| (200, r#"{"sessions":[]}"#.to_string()));
        for team in ["my-team", "team_9"] {
            Vercel::new(Some(base.clone()), "t".into(), "prj".into(), Some(team.into())).sessions().await.unwrap();
        }
        let paths: Vec<String> = seen.lock().unwrap().iter().map(|r| r.path.clone()).collect();
        assert_eq!(paths, vec!["/v2/sandboxes/sessions?project=prj&slug=my-team", "/v2/sandboxes/sessions?project=prj&teamId=team_9"]);
    }

    #[tokio::test]
    async fn runs_commands_and_returns_exit_code_with_combined_output() {
        let (api, seen) = vercel();
        assert_eq!(api.run("sbx_1", "echo $((6*7))", Duration::from_secs(9)).await.unwrap(), (Some(3), "42\nwarn\n".to_string()));
        let body: Value = serde_json::from_str(&seen.lock().unwrap()[0].body).unwrap();
        assert_eq!(body, json!({"command":"sh","args":["-c","echo $((6*7))"],"sudo":false,"wait":true,"logs":true}));
        assert!(api.run("nope", "ls", Duration::from_secs(5)).await.unwrap_err().contains("sandbox not found"));
    }

    #[tokio::test]
    async fn extends_the_timeout_and_falls_back_when_the_plan_refuses() {
        let (api, seen) = vercel();
        api.extend("sbx_1", 600).await.unwrap();
        let bodies: Vec<String> = seen.lock().unwrap().iter().map(|r| r.body.clone()).collect();
        assert_eq!(bodies, vec![r#"{"duration":18000000}"#, r#"{"duration":1800000}"#]);
    }

    #[test]
    fn parses_streams_without_an_exit_code() {
        let (code, output, id) = parse_stream("{\"command\":{\"id\":\"c\",\"exitCode\":null}}\n{\"stream\":\"stdout\",\"data\":\"hi\"}\n").unwrap();
        assert_eq!((code, output.as_str(), id.as_deref()), (None, "hi", Some("c")));
        assert!(parse_stream("{\"stream\":\"error\",\"data\":{\"code\":\"x\",\"message\":\"boom\"}}").unwrap_err().contains("boom"));
    }

    /// `VERCEL_TOKEN=… VERCEL_PROJECT_ID=… [VERCEL_TEAM_ID=…] cargo test vercel_live -- --ignored`
    #[tokio::test]
    #[ignore]
    async fn vercel_live_smoke() {
        let (Ok(token), Ok(project)) = (std::env::var("VERCEL_TOKEN"), std::env::var("VERCEL_PROJECT_ID")) else { return };
        let api = Vercel::new(None, token, project, std::env::var("VERCEL_TEAM_ID").ok());
        let id = api.launch().await.unwrap().id.trim_start_matches("vercel:").to_string();
        let t = Duration::from_secs(60);
        let result = async {
            assert_eq!(api.run(&id, "echo hi", t).await?, (Some(0), "hi\n".to_string()));
            api.run(&id, "setsid nohup sh -c 'sleep 120' >/dev/null 2>&1 </dev/null &", t).await?;
            let (code, _) = api.run(&id, "pgrep -x sleep", t).await?;
            assert_eq!(code, Some(0));
            Ok::<_, String>(())
        }
        .await;
        api.halt(&id, "delete").await.unwrap();
        result.unwrap();
    }
}
