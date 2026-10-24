//! Cloudflare sandboxes: PandaCode deploys a small Worker (`cloudflare_worker/`) to your
//! account once, then each sandbox is a container behind it, addressed by name. The Worker
//! checks a random bearer token kept in the OS keychain; containers stop after 10 idle
//! minutes. Cloudflare cannot list Durable Objects, so PandaCode remembers the names.
use serde_json::{json, Value};
use std::{path::Path, process::Command, time::Duration};

use super::{http, Machine};
use crate::workspace::{checked, run_process, run_process_with_input};

const SERVICE: &str = "Cloudflare";
const FILES: [(&str, &str); 6] = [
    ("wrangler.jsonc", include_str!("cloudflare_worker/wrangler.jsonc")),
    ("Dockerfile", include_str!("cloudflare_worker/Dockerfile")),
    ("package.json", include_str!("cloudflare_worker/package.json")),
    ("tsconfig.json", include_str!("cloudflare_worker/tsconfig.json")),
    ("src/index.ts", include_str!("cloudflare_worker/src/index.ts")),
    (".gitignore", "node_modules\n.wrangler\n"),
];

#[derive(Clone)]
pub struct Cloudflare {
    url: String,
    token: String,
}

/// Sandbox names Cloudflare containers accept, the same rule as the Worker's.
pub fn valid_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 63 && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') && !name.starts_with('-')
}
/// The workers.dev URL `wrangler deploy` prints.
pub fn deployed_url(output: &str) -> Option<String> {
    output.split_whitespace().map(|w| w.trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != ':' && c != '/' && c != '.' && c != '-'))
        .find(|w| w.starts_with("https://pandacode-sandbox.") && w.ends_with(".workers.dev"))
        .map(str::to_string)
}

impl Cloudflare {
    pub fn new(url: String, token: String) -> Self {
        Cloudflare { url: url.trim_end_matches('/').to_string(), token }
    }
    pub fn connected() -> Result<Self, String> {
        let token = super::secret("cloudflare_worker_token").ok_or("Connect Cloudflare in Settings → Cloud first.")?;
        let url = super::settings().cloudflare_worker_url.ok_or("Connect Cloudflare in Settings → Cloud first.")?;
        Ok(Cloudflare::new(url, token))
    }
    async fn call(&self, method: reqwest::Method, path: &str, body: Option<Value>, timeout: Duration) -> Result<Value, String> {
        let client = http::client(timeout)?;
        let request = client.request(method, format!("{}{path}", self.url)).bearer_auth(&self.token);
        http::send(SERVICE, match body { Some(body) => request.json(&body), None => request }).await
    }
    pub async fn health(&self) -> Result<(), String> {
        self.call(reqwest::Method::GET, "/health", None, Duration::from_secs(20)).await.map(|_| ())
    }
    fn machine(name: &str, running: bool) -> Machine {
        Machine { id: format!("cloudflare:{name}"), provider: "cloudflare".into(), name: name.into(), state: if running { "running" } else { "stopped" }.into(), os: "linux".into(), desktop: false, detail: "Cloudflare container · commands only".into() }
    }
    pub async fn list(&self, names: &[String]) -> Result<Vec<Machine>, String> {
        let mut machines = Vec::new();
        for name in names {
            let status = self.call(reqwest::Method::GET, &format!("/sandboxes/{name}"), None, Duration::from_secs(20)).await?;
            machines.push(Self::machine(name, status["running"].as_bool().unwrap_or(false)));
        }
        Ok(machines)
    }
    pub async fn create(&self, name: &str) -> Result<Machine, String> {
        if !valid_name(name) {
            return Err("Sandbox names use lowercase letters, digits and dashes (up to 63).".into());
        }
        self.call(reqwest::Method::POST, &format!("/sandboxes/{name}/start"), None, Duration::from_secs(120)).await?;
        Ok(Self::machine(name, true))
    }
    pub async fn power(&self, name: &str, action: &str) -> Result<(), String> {
        let (method, path) = match action {
            "start" => (reqwest::Method::POST, format!("/sandboxes/{name}/start")),
            "stop" => (reqwest::Method::POST, format!("/sandboxes/{name}/stop")),
            "delete" => (reqwest::Method::DELETE, format!("/sandboxes/{name}")),
            _ => return Err(format!("Cloudflare sandboxes can start, stop or be deleted, not {action}.")),
        };
        self.call(method, &path, None, Duration::from_secs(120)).await.map(|_| ())
    }
    /// Keep the container awake for `minutes` without requests (the Worker's `/keepalive`).
    pub async fn keep_alive(&self, name: &str, minutes: u32) -> Result<(), String> {
        self.call(reqwest::Method::POST, &format!("/sandboxes/{name}/keepalive"), Some(json!({"minutes": minutes})), Duration::from_secs(30)).await.map(|_| ())
    }
    async fn run(&self, name: &str, command: &str, timeout: Duration) -> Result<Value, String> {
        self.call(reqwest::Method::POST, &format!("/sandboxes/{name}/exec"), Some(json!({"command": command, "timeoutMs": timeout.as_millis() as u64})), timeout + Duration::from_secs(30)).await
    }
    /// Exit code and stdout alone, for callers that parse the output (base64 file reads).
    pub async fn exec_stdout(&self, name: &str, command: &str, timeout: Duration) -> Result<(Option<i32>, String), String> {
        let result = self.run(name, command, timeout).await?;
        Ok((result["exitCode"].as_i64().map(|c| c as i32), result["stdout"].as_str().unwrap_or_default().to_string()))
    }
    pub async fn exec(&self, name: &str, command: &str, timeout: Duration) -> Result<(Option<i32>, String), String> {
        let result = self.run(name, command, timeout).await?;
        let mut output = result["stdout"].as_str().unwrap_or_default().to_string();
        if let Some(stderr) = result["stderr"].as_str().filter(|s| !s.is_empty()) {
            output.push_str(&format!("{}[stderr]\n{stderr}", if output.is_empty() || output.ends_with('\n') { "" } else { "\n" }));
        }
        if result["truncated"].as_bool() == Some(true) {
            output.push_str("\n[output truncated to the last 4 MB]");
        }
        Ok((result["exitCode"].as_i64().map(|c| c as i32), output))
    }
}

/// Check an API token against the account: account-owned tokens verify under the
/// account, user tokens under the user.
pub async fn verify_token(token: &str, account: &str) -> Result<(), String> {
    let client = http::client(Duration::from_secs(30))?;
    let account_check = http::send(SERVICE, client.get(format!("https://api.cloudflare.com/client/v4/accounts/{account}/tokens/verify")).bearer_auth(token)).await;
    if account_check.is_ok() {
        return Ok(());
    }
    http::send(SERVICE, client.get("https://api.cloudflare.com/client/v4/user/tokens/verify").bearer_auth(token)).await.map(|_| ())
}

fn tool(name: &str) -> Result<std::path::PathBuf, String> {
    crate::token_saver::find_tool(name).ok_or_else(|| format!("{name} was not found. Install Node.js, then try again."))
}
/// Deploy the sandbox Worker with the user's API token, then give it a fresh secret.
/// Returns the Worker's URL and the secret. Needs Docker running to build the image once.
pub fn deploy(api_token: &str, account: &str, progress: &dyn Fn(&str)) -> Result<(String, String), String> {
    let docker = crate::token_saver::find_tool("docker").ok_or("Cloudflare builds the sandbox image with Docker. Install Docker Desktop, start it, and try again.")?;
    let mut info = Command::new(docker);
    info.arg("info");
    if !run_process(info, "Docker", 1 << 16, Duration::from_secs(30))?.status.success() {
        return Err("Docker is installed but not running. Start Docker Desktop and try again.".into());
    }
    let work = std::env::temp_dir().join(format!("pandacode-cloudflare-{}", uuid::Uuid::new_v4()));
    let result = (|| {
        for (path, contents) in FILES {
            let target = work.join(path);
            std::fs::create_dir_all(target.parent().unwrap_or(&work)).map_err(|e| e.to_string())?;
            std::fs::write(&target, contents).map_err(|e| e.to_string())?;
        }
        progress("Installing the Worker's packages…");
        let mut install = Command::new(tool("npm")?);
        install.args(["install", "--no-audit", "--no-fund", "--silent"]).current_dir(&work);
        checked(run_process(install, "npm", 1 << 20, Duration::from_secs(600))?)?;
        progress("Building the sandbox image and deploying (a few minutes)…");
        let output = wrangler(&work, api_token, account, &["deploy"], None, Duration::from_secs(1800))?;
        let url = deployed_url(&output).ok_or("The Worker deployed but its address was not reported. Check workers.dev is enabled for your account.")?;
        progress("Securing the Worker…");
        let secret = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
        wrangler(&work, api_token, account, &["secret", "put", "PANDACODE_TOKEN"], Some(&secret), Duration::from_secs(300))?;
        Ok((url, secret))
    })();
    let _ = std::fs::remove_dir_all(&work);
    result
}
fn wrangler(work: &Path, api_token: &str, account: &str, args: &[&str], input: Option<&str>, timeout: Duration) -> Result<String, String> {
    let wrangler = work.join(if cfg!(windows) { "node_modules/.bin/wrangler.cmd" } else { "node_modules/.bin/wrangler" });
    let mut command = Command::new(&wrangler);
    command.args(args).current_dir(work)
        .env("CLOUDFLARE_API_TOKEN", api_token).env("CLOUDFLARE_ACCOUNT_ID", account)
        .env("WRANGLER_SEND_METRICS", "false").env("CI", "true");
    // run_process drains both pipes while waiting and kills the whole process group
    // (docker, workerd) on timeout.
    let output = run_process_with_input(command, "Wrangler", 1 << 20, timeout, input.map(str::as_bytes))
        .map_err(|e| if e.contains("timed out") { "Wrangler did not finish in time.".into() } else { e })?;
    let text = format!("{}{}", String::from_utf8_lossy(&output.stdout.bytes), String::from_utf8_lossy(&output.stderr.bytes));
    if output.status.success() {
        Ok(text)
    } else {
        let reason = text.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('🪵')).find(|l| l.contains("ERROR") || l.contains('✘')).or_else(|| text.lines().rev().find(|l| !l.trim().is_empty())).unwrap_or("unknown error");
        Err(format!("Wrangler: {}", reason.trim_start_matches(['✘', ' ', '['])))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud::http::mock;

    #[test]
    fn finds_the_workers_dev_address_in_deploy_output() {
        let output = "Uploaded pandacode-sandbox (4.1 sec)\nDeployed pandacode-sandbox triggers (0.4 sec)\n  https://pandacode-sandbox.example-team.workers.dev\nCurrent Version ID: 1";
        assert_eq!(deployed_url(output).as_deref(), Some("https://pandacode-sandbox.example-team.workers.dev"));
        assert_eq!(deployed_url("no url"), None);
        assert!(valid_name("pandacode-1") && !valid_name("Big") && !valid_name("-a") && !valid_name(&"a".repeat(64)));
    }

    #[test]
    fn the_worker_ships_with_auth_and_an_idle_timeout() {
        let worker = FILES.iter().find(|(path, _)| *path == "src/index.ts").unwrap().1;
        assert!(worker.contains("timingSafeEqual") && worker.contains("IDLE_MS = 10 * 60 * 1000"));
        assert!(worker.contains("/keepalive") && worker.contains("keepAlive(minutes: number)") && worker.contains("setInactivityTimeout"));
        assert!(FILES.iter().any(|(path, contents)| *path == "Dockerfile" && contents.contains("cloudflare/sandbox:1.0.1")));
        let package: Value = serde_json::from_str(FILES.iter().find(|(path, _)| *path == "package.json").unwrap().1).unwrap();
        assert_eq!(package["dependencies"]["@cloudflare/sandbox"], "1.0.1");
    }

    #[tokio::test]
    async fn drives_sandboxes_through_the_worker() {
        let (base, seen) = mock::serve(|request, _| match (request.method.as_str(), request.path.as_str()) {
            ("GET", "/sandboxes/a") => (200, String::from(r#"{"running":true}"#)),
            ("GET", "/sandboxes/b") => (200, r#"{"running":false}"#.into()),
            ("POST", "/sandboxes/c/start") => (200, r#"{"running":true}"#.into()),
            ("POST", "/sandboxes/a/exec") => (200, r#"{"exitCode":1,"stdout":"out","stderr":"err","truncated":false}"#.into()),
            ("POST", "/sandboxes/a/keepalive") => (200, r#"{"keepAliveMs":900000}"#.into()),
            ("DELETE", "/sandboxes/b") => (200, r#"{"deleted":true}"#.into()),
            ("GET", "/health") => (401, "Unauthorized".into()),
            _ => (404, r#"{"message":"Not found"}"#.into()),
        });
        let cf = Cloudflare::new(format!("{base}/"), "tok".into());
        let listed = cf.list(&["a".into(), "b".into()]).await.unwrap();
        assert_eq!(listed.iter().map(|m| (m.id.as_str(), m.state.as_str(), m.desktop)).collect::<Vec<_>>(), vec![("cloudflare:a", "running", false), ("cloudflare:b", "stopped", false)]);
        assert_eq!(cf.create("c").await.unwrap().state, "running");
        assert!(cf.create("Bad Name").await.is_err());
        assert_eq!(cf.exec("a", "ls", Duration::from_secs(5)).await.unwrap(), (Some(1), "out\n[stderr]\nerr".into()));
        assert_eq!(cf.exec_stdout("a", "ls", Duration::from_secs(5)).await.unwrap(), (Some(1), "out".into()));
        cf.power("b", "delete").await.unwrap();
        cf.keep_alive("a", 15).await.unwrap();
        assert!(cf.health().await.unwrap_err().contains("refused the credentials"));
        let log = seen.lock().unwrap();
        assert!(log.iter().all(|r| r.authorization.as_deref() == Some("Bearer tok")));
        let exec: Value = serde_json::from_str(&log.iter().find(|r| r.path.ends_with("/exec")).unwrap().body).unwrap();
        assert_eq!(exec, json!({"command":"ls","timeoutMs":5000}));
        let keep: Value = serde_json::from_str(&log.iter().find(|r| r.path.ends_with("/keepalive")).unwrap().body).unwrap();
        assert_eq!(keep, json!({"minutes":15}));
    }
}
