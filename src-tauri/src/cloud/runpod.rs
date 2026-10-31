//! RunPod pods for cloud agents (docs/cloud-agents.md): GPU machines over the shared SSH
//! transport (cloud/ssh.rs), driven by the GraphQL API (api.runpod.io, one API key). Pods are
//! the odd one out: the container disk is cleared when a pod stops (only the /workspace
//! volume survives), so they are non-persistent — a stopped pod is replaced by a fresh one
//! and rehydrated from the local mirror worktree, like Cloudflare's sandboxes. SSH rides the
//! pod's public IP on the container's port 22, with our key authorized through the documented
//! `SSH_PUBLIC_KEY` pod variable; the image and GPU type are settings, defaulting to RunPod's
//! own Ubuntu 24.04 base image, which ships SSH configured.
use serde_json::{json, Value};
use std::time::Duration;

use super::{http, http::block, sandbox::{Info, Sandbox}, ssh, Machine};
use crate::Result;

const SERVICE: &str = "RunPod";
const DEFAULT_API: &str = "https://api.runpod.io/graphql";
const IMAGE: &str = "runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404";
const GPU: &str = "NVIDIA RTX 3090";
const CLOUD: &str = "SECURE";
/// The documented per-pod override that authorizes our key for the pod's SSH server.
const KEY_VARIABLE: &str = "SSH_PUBLIC_KEY";
/// A pod provisions and gets its SSH port within this many polls.
const BOOT_TRIES: u32 = 90;
const BOOT_PAUSE: u64 = 5;

pub struct RunPod {
    api: String,
    key: String,
}

impl RunPod {
    pub fn new(api: Option<String>, key: String) -> Self {
        RunPod { api: api.filter(|a| !a.trim().is_empty()).unwrap_or_else(|| DEFAULT_API.into()).trim_end_matches('/').to_string(), key }
    }
    fn connected() -> Result<Self> {
        Ok(RunPod::new(None, super::secret("runpod_key").ok_or("Connect RunPod in Settings → Cloud first.")?))
    }
    async fn query(&self, query: &str, variables: Value) -> Result<Value> {
        let request = http::client(Duration::from_secs(120))?.post(&self.api).bearer_auth(&self.key).json(&json!({"query": query, "variables": variables}));
        let reply = http::send(SERVICE, request).await?;
        if let Some(message) = reply["errors"][0]["message"].as_str() {
            return Err(format!("RunPod: {}", message.chars().take(300).collect::<String>()));
        }
        Ok(reply["data"].clone())
    }

    /// A named option of the provider (`image`, `gpu`), else its default.
    fn option(name: &str, default: &str) -> String {
        super::settings().providers.get("runpod").and_then(|options| options.get(name)).filter(|v| !v.is_empty()).cloned().unwrap_or_else(|| default.into())
    }

    pub async fn verify(&self) -> Result<()> {
        // The token works: read the account's pod list (empty is fine).
        self.query(r#"query { myself { pods { id } } }"#, json!({})).await.map(|_| ())
    }

    /// Pods PandaCode started (their machines are all named `pc-<short id>`); the API has
    /// no tag filter, so the panel never sees the account's unrelated pods.
    pub async fn list(&self) -> Result<Vec<Machine>> {
        let data = self.query(r#"query Pods { myself { pods { id name gpuCount desiredStatus runtime { ports { ip publicPort privatePort isIpPublic } } } } }"#, json!({})).await?;
        Ok(data["myself"]["pods"].as_array().map(|pods| pods.iter().filter_map(machine).collect()).unwrap_or_default())
    }

    pub async fn create(&self, name: &str) -> Result<Machine> {
        let name = valid_name(name)?;
        let public = ssh::key_pair()?.1;
        let input = deploy_input(name, &Self::option("image", IMAGE), &Self::option("gpu", GPU), &public);
        let data = self.query(r#"mutation Deploy($input: PodFindAndDeployOnDemandInput!) { podFindAndDeployOnDemand(input: $input) { id name gpuCount desiredStatus runtime { ports { ip publicPort privatePort isIpPublic } } } }"#, json!({"input": input})).await?;
        let pod = data["podFindAndDeployOnDemand"].clone();
        let native = pod["id"].as_str().ok_or_else(|| "RunPod did not report the new pod.".to_string())?.to_string();
        // A fresh pod gets its SSH mapping when it finishes provisioning.
        let mut address = Err(String::from("never tried"));
        for _ in 0..BOOT_TRIES {
            address = self.ssh_address(&native).await;
            if address.is_ok() { break; }
            std::thread::sleep(Duration::from_secs(BOOT_PAUSE));
        }
        let (ip, port) = address.map_err(|_| "The pod started but got no SSH address in time. Delete it and try again.".to_string())?;
        ssh::address_cache().lock().unwrap().insert(format!("{}:{native}", self.api), format!("{ip}:{port}"));
        // Ports are recycled between pods; the new container's key is the one to trust.
        ssh::forget_host(&ip, port);
        ssh::wait_ready(&ssh::Target { host: ip, port, user: "root" }, READY)?;
        Ok(machine_with(&pod, &native, "running"))
    }

    /// The pod's public SSH endpoint (its port-22 mapping) from one lookup, also cached.
    async fn ssh_address(&self, native: &str) -> Result<(String, u16)> {
        let pod = self.pod(native).await?;
        ssh_port(&pod).ok_or_else(|| "The pod has no public SSH address yet; try again in a minute.".to_string())
    }
    async fn pod(&self, native: &str) -> Result<Value> {
        let data = self.query(r#"query Pod($podId: String!) { pod(input: {podId: $podId}) { id name gpuCount desiredStatus runtime { ports { ip publicPort privatePort isIpPublic } } } }"#, json!({"podId": native})).await?;
        if data["pod"].is_null() {
            return Err("That RunPod pod no longer exists.".into());
        }
        Ok(data["pod"].clone())
    }
    /// The cached endpoint, else one lookup recorded in the cache; `fresh` re-asks the API.
    async fn address(&self, native: &str, fresh: bool) -> Result<(String, u16)> {
        let key = format!("{}:{native}", self.api);
        if !fresh {
            if let Some(hit) = ssh::address_cache().lock().unwrap().get(&key) {
                if let Some((ip, port)) = hit.rsplit_once(':').and_then(|(ip, port)| port.parse().ok().map(|port: u16| (ip.to_string(), port))) {
                    return Ok((ip, port));
                }
            }
        }
        let (ip, port) = self.ssh_address(native).await?;
        ssh::address_cache().lock().unwrap().insert(key, format!("{ip}:{port}"));
        Ok((ip, port))
    }

    pub async fn power(&self, native: &str, action: &str) -> Result<()> {
        match action {
            "start" => {
                // Resuming needs the pod's GPU count back.
                let gpus = self.pod(native).await?["gpuCount"].as_i64().unwrap_or(1).max(1);
                self.resume(native, gpus).await?;
                // The endpoint is reassigned per start and the container disk was cleared
                // (fresh host keys), so ask afresh and forget the old key unconditionally.
                let (ip, port) = self.address(native, true).await?;
                ssh::forget_host(&ip, port);
                ssh::wait_ready(&ssh::Target { host: ip, port, user: "root" }, READY)
            }
            // Stopping releases the GPU and clears the container disk; the volume stays.
            "stop" => self.query(r#"mutation Stop($podId: String!) { podStop(input: {podId: $podId}) { id } }"#, json!({"podId": native})).await.map(|_| ()),
            "delete" => {
                let endpoint = self.address(native, false).await.ok();
                let result = self.query(r#"mutation Terminate($input: PodTerminateInput!) { podTerminate(input: $input) }"#, json!({"input": {"podId": native}})).await;
                // A pod that is already gone did what was asked; its address may be recycled.
                match result {
                    Err(e) if e.contains("no longer exists") || e.contains("not found") => Ok(()),
                    other => {
                        if other.is_ok() {
                            if let Some((ip, port)) = endpoint {
                                ssh::forget_host(&ip, port);
                            }
                        }
                        other.map(|_| ())
                    }
                }
            }
            _ => Err(format!("RunPod pods can start, stop or be deleted, not {action}.")),
        }
    }

    async fn resume(&self, native: &str, gpus: i64) -> Result<()> {
        self.query(r#"mutation Resume($podId: String!, $gpuCount: Int!) { podResume(input: {podId: $podId, gpuCount: $gpuCount}) { id } }"#, json!({"podId": native, "gpuCount": gpus})).await.map(|_| ())
    }

    pub async fn exec(&self, native: &str, command: &str, timeout: Duration) -> Result<(Option<i32>, String)> {
        let (ip, port) = self.address(native, false).await?;
        let target = ssh::Target { host: ip, port, user: "root" };
        match ssh::exec(&target, command, timeout) {
            // A cached endpoint can be stale after a delete/recreate; re-ask once and retry.
            Err(e) if ssh::transport_error(&e) => match self.address(native, true).await {
                Ok((ip, port)) => {
                    if ip != target.host || port != target.port {
                        ssh::forget_host(&target.host, target.port);
                    }
                    ssh::exec(&ssh::Target { host: ip, port, user: "root" }, command, timeout)
                }
                Err(_) => Err(unreachable_text(&e)),
            },
            result => result,
        }
    }
}

/// The cloud-init wait other providers need does not exist in containers; the official image
/// has its tools preinstalled, so readiness is simply sshd answering.
const READY: &str = "true";

/// The deploy input: public SSH on the container's port 22, our key authorized through the
/// documented pod variable.
fn deploy_input(name: &str, image: &str, gpu: &str, public: &str) -> Value {
    json!({"name": name, "imageName": image, "gpuTypeId": gpu, "cloudType": CLOUD, "supportPublicIp": true, "ports": "22/tcp", "env": [{"key": KEY_VARIABLE, "value": public}]})
}

/// The ssh failure without the transport marker, for when a retry cannot run.
fn unreachable_text(error: &str) -> String {
    error.strip_prefix(ssh::UNREACHABLE).map(str::to_string).unwrap_or_else(|| error.to_string())
}

/// The pod's public SSH mapping: the port-22 port with a public IP.
fn ssh_port(pod: &Value) -> Option<(String, u16)> {
    pod["runtime"]["ports"].as_array()?.iter().find(|p| p["privatePort"].as_i64() == Some(22) && p["isIpPublic"].as_bool() != Some(false))
        .and_then(|p| Some((p["ip"].as_str()?.to_string(), p["publicPort"].as_u64()? as u16)))
}

fn machine_with(pod: &Value, native: &str, forced: &str) -> Machine {
    let gpus = pod["gpuCount"].as_i64().unwrap_or(1);
    Machine { id: format!("runpod:{native}"), provider: "runpod".into(), name: pod["name"].as_str().unwrap_or(native).into(), state: forced.into(), os: "linux".into(), desktop: false, detail: format!("{SERVICE} · {gpus} GPU") }
}
fn machine(pod: &Value) -> Option<Machine> {
    let native = pod["id"].as_str()?.to_string();
    // Only PandaCode's own machines: the pipeline names every one `pc-<short id>` and the
    // API has no tags, so this keeps the account's unrelated pods out of the panel.
    if !pod["name"].as_str()?.starts_with("pc-") {
        return None;
    }
    let state = match pod["desiredStatus"].as_str() {
        Some("RUNNING") if pod["runtime"].is_object() => "running",
        Some("RUNNING" | "CREATED") => "starting",
        Some("EXITED" | "PAUSED") => "stopped",
        _ => "error",
    };
    Some(machine_with(pod, &native, state))
}

/// Pod names become part of their SSH endpoint; keep them host-safe.
fn valid_name(name: &str) -> Result<&str> {
    let ok = (1..=63).contains(&name.len())
        && name.starts_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit())
        && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !name.ends_with('-');
    ok.then_some(name).ok_or_else(|| "RunPod names use lowercase letters, digits and dashes, starting with a letter or digit (up to 63).".to_string())
}

pub fn connect(key: &str, options: &Value) -> Result<()> {
    let key = key.trim();
    if key.is_empty() {
        return Err("Enter your RunPod API key.".into());
    }
    let image = options["image"].as_str().map(str::trim).filter(|v| !v.is_empty());
    let gpu = options["gpu"].as_str().map(str::trim).filter(|v| !v.is_empty());
    block(RunPod::new(None, key.into()).verify())?;
    super::set_secret("runpod_key", key)?;
    let mut settings = super::settings();
    let entry = settings.providers.entry("runpod".into()).or_default();
    for (name, value) in [("image", image), ("gpu", gpu)] {
        if let Some(value) = value {
            entry.insert(name.into(), value.into());
        }
    }
    entry.insert("detail".into(), "API key saved".into());
    super::save_settings(&settings)
}
pub fn disconnect() -> Result<()> {
    super::remove_secret("runpod_key");
    let mut settings = super::settings();
    settings.providers.remove("runpod");
    super::save_settings(&settings)
}
pub fn sandbox() -> Result<Box<dyn Sandbox>> {
    Ok(Box::new(RunPod::connected()?))
}

impl Sandbox for RunPod {
    /// A stopped pod's container disk is cleared; only /workspace survives, which the run
    /// pipeline does not use — so stopped pods are replaced and rehydrated like Cloudflare's.
    fn info(&self) -> Info {
        Info { persistent: false, max_unattended_minutes: 24 * 60 }
    }
    fn list(&self) -> Result<Vec<Machine>> {
        block(RunPod::list(self))
    }
    fn create(&self, name: &str) -> Result<Machine> {
        block(RunPod::create(self, name))
    }
    fn power(&self, native: &str, action: &str) -> Result<()> {
        block(RunPod::power(self, native, action))
    }
    fn exec(&self, native: &str, command: &str, timeout: Duration) -> Result<(Option<i32>, String)> {
        block(RunPod::exec(self, native, command, timeout))
    }
    /// Pods keep running (and billing their GPU) until stopped from the panel or replaced
    /// by the next run of the same task; keep_alive has nothing to extend.
    fn keep_alive(&self, _native: &str, _minutes: u32) -> Result<()> {
        Ok(())
    }
    /// Whole files over scp; the chunked default would open a connection per 44 KiB.
    fn upload(&self, native: &str, path: &str, bytes: &[u8], private: bool) -> Result<()> {
        let (ip, port) = block(self.address(native, false))?;
        let target = ssh::Target { host: ip, port, user: "root" };
        match ssh::upload(&target, path, bytes, private) {
            Err(e) if ssh::transport_error(&e) => match block(self.address(native, true)) {
                Ok((ip, port)) => {
                    if ip != target.host || port != target.port {
                        ssh::forget_host(&target.host, target.port);
                    }
                    ssh::upload(&ssh::Target { host: ip, port, user: "root" }, path, bytes, private)
                }
                Err(_) => Err(unreachable_text(&e)),
            },
            result => result,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud::http::mock;

    fn api() -> (RunPod, mock::Seen) {
        let (base, seen) = mock::serve(|request, _| match (request.method.as_str(), request.path.as_str()) {
            ("POST", "/graphql") => {
                let body: Value = serde_json::from_str(&request.body).unwrap_or_default();
                let query = body["query"].as_str().unwrap_or_default();
                if query.contains("podFindAndDeployOnDemand") {
                    (200, br#"{"data":{"podFindAndDeployOnDemand":{"id":"p1","name":"job","gpuCount":1,"desiredStatus":"RUNNING","runtime":{"ports":[{"ip":"203.0.113.8","publicPort":13007,"privatePort":22,"isIpPublic":true}]}}}}"#.to_vec())
                } else if query.contains("podStop") {
                    (200, br#"{"data":{"podStop":{"id":"p1"}}}"#.to_vec())
                } else if query.contains("podTerminate") {
                    (200, br#"{"data":{"podTerminate":null}}"#.to_vec())
                } else if query.contains("podResume") {
                    (200, br#"{"data":{"podResume":{"id":"p1"}}}"#.to_vec())
                } else if query.contains("myself") {
                    (200, br#"{"data":{"myself":{"pods":[{"id":"p1","name":"pc-abc123","gpuCount":1,"desiredStatus":"RUNNING","runtime":{"ports":[{"ip":"203.0.113.8","publicPort":13007,"privatePort":22,"isIpPublic":true}]}}]}}}"#.to_vec())
                } else if query.contains("query Pod") {
                    (200, br#"{"data":{"pod":{"id":"p1","name":"pc-abc123","gpuCount":1,"desiredStatus":"RUNNING","runtime":{"ports":[{"ip":"203.0.113.8","publicPort":13007,"privatePort":22,"isIpPublic":true}]}}}}"#.to_vec())
                } else {
                    (500, br#"{"errors":[{"message":"unexpected query"}]}"#.to_vec())
                }
            }
            _ => (500, br#"{"message":"unexpected"}"#.to_vec()),
        });
        (RunPod::new(Some(format!("{base}/graphql")), "tok-1".into()), seen)
    }

    #[tokio::test]
    async fn lists_only_its_own_prefix_pods() {
        let (api, seen) = api();
        let machines = api.list().await.unwrap();
        assert_eq!(machines.iter().map(|m| (m.id.as_str(), m.name.as_str(), m.state.as_str())).collect::<Vec<_>>(), vec![("runpod:p1", "pc-abc123", "running")]);
        assert_eq!(machines[0].detail, "RunPod · 1 GPU");
        assert!(!machines[0].desktop && machines[0].os == "linux");
        let log = seen.lock().unwrap();
        assert!(log.iter().all(|r| r.authorization.as_deref() == Some("Bearer tok-1")));
        // The account's unrelated pods are filtered out by the pc- prefix, not shown.
        let pod = json!({"id":"x","name":"my-own-pod","gpuCount":1,"desiredStatus":"RUNNING","runtime":{}});
        assert_eq!(machine(&pod), None);
    }

    #[test]
    fn deploys_with_our_key_and_reads_the_ssh_port() {
        let input = deploy_input("job", "img:1", "g1", "ssh-ed25519 AAAA");
        assert_eq!(input["ports"], "22/tcp");
        assert_eq!(input["supportPublicIp"], true);
        assert_eq!(input["imageName"], "img:1");
        assert_eq!(input["env"], json!([{"key": KEY_VARIABLE, "value": "ssh-ed25519 AAAA"}]));
        let pod = json!({"id":"p1","name":"job","gpuCount":1,"desiredStatus":"RUNNING","runtime":{"ports":[{"ip":"203.0.113.8","publicPort":13007,"privatePort":22,"isIpPublic":true}]}});
        assert_eq!(ssh_port(&pod), Some(("203.0.113.8".to_string(), 13007)));
    }

    #[tokio::test]
    async fn power_stops_resumes_and_terminates() {
        let (api, seen) = api();
        api.power("p2", "stop").await.unwrap();
        api.power("p2", "delete").await.unwrap();
        let log = seen.lock().unwrap();
        let kinds: Vec<String> = log.iter().filter_map(|r| serde_json::from_str::<Value>(&r.body).ok()).filter_map(|b| b["query"].as_str().map(str::to_string)).collect();
        assert!(kinds.iter().any(|q| q.contains("podStop")));
        assert!(kinds.iter().any(|q| q.contains("podTerminate")));
    }

    #[tokio::test]
    async fn resume_sends_the_pod_gpu_count() {
        let (api, seen) = api();
        api.resume("p3", 1).await.unwrap();
        let log = seen.lock().unwrap();
        let resume = log.iter().find(|r| r.body.contains("podResume")).unwrap();
        assert!(resume.body.contains(r#""gpuCount":1"#));
        assert!(resume.body.contains(r#""podId":"p3""#));
    }

    #[tokio::test]
    async fn addresses_are_cached_per_pod() {
        let (api, seen) = api();
        assert_eq!(api.address("p1", false).await.unwrap(), ("203.0.113.8".to_string(), 13007));
        assert_eq!(api.address("p1", false).await.unwrap(), ("203.0.113.8".to_string(), 13007));
        assert_eq!(api.address("p1", true).await.unwrap(), ("203.0.113.8".to_string(), 13007));
        let pod_queries = seen.lock().unwrap().iter().filter(|r| r.body.contains("query Pod")).count();
        assert_eq!(pod_queries, 2);
    }

    #[tokio::test]
    async fn bad_keys_are_refused() {
        let (base, _) = mock::serve(|_, _| (401, br#"{"errors":[{"message":"Invalid API key"}]}"#.to_vec()));
        let api = RunPod::new(Some(format!("{base}/graphql")), "nope".into());
        assert!(api.verify().await.unwrap_err().contains("refused the credentials"));
        assert!(connect(" ", &Value::Null).is_err());
    }

    #[test]
    fn states_and_names() {
        let pod = |desired: &str, runtime: Value| json!({"id":"p","name":"pc-x","gpuCount":2,"desiredStatus":desired,"runtime":runtime});
        assert_eq!(machine(&pod("RUNNING", json!({}))).unwrap().state, "running");
        assert_eq!(machine(&pod("RUNNING", Value::Null)).unwrap().state, "starting");
        assert_eq!(machine(&pod("EXITED", Value::Null)).unwrap().state, "stopped");
        assert_eq!(machine(&pod("WEIRD", Value::Null)).unwrap().state, "error");
        assert_eq!(machine(&pod("RUNNING", json!({}))).unwrap().detail, "RunPod · 2 GPU");
        // Another pod of the account's, without the pc- prefix, is not PandaCode's machine.
        assert_eq!(machine(&json!({"id":"p","name":"other","gpuCount":1,"desiredStatus":"RUNNING","runtime":{}})), None);
        assert_eq!(valid_name("pc-1").unwrap(), "pc-1");
        assert!(valid_name("Pc").is_err() && valid_name("").is_err());
        assert_eq!(ssh_port(&pod("RUNNING", json!({"ports":[{"ip":"1.2.3.4","publicPort":100,"privatePort":22,"isIpPublic":true}]}))), Some(("1.2.3.4".into(), 100)));
        assert_eq!(ssh_port(&pod("RUNNING", json!({"ports":[{"ip":"1.2.3.4","publicPort":100,"privatePort":80}]}))), None);
    }

    /// Needs RUNPOD_API_KEY and a working local ssh; run with `cargo test runpod_live -- --ignored`.
    #[test]
    #[ignore]
    fn runpod_live() {
        let key = std::env::var("RUNPOD_API_KEY").expect("RUNPOD_API_KEY");
        let api = RunPod::new(None, key);
        let made = Sandbox::create(&api, "pandacode-smoke").unwrap();
        let id = made.id.trim_start_matches("runpod:").to_string();
        let run = || -> Result<()> {
            assert_eq!(Sandbox::exec(&api, &id, "echo hi", Duration::from_secs(30))?, (Some(0), "hi\n".into()));
            Sandbox::upload(&api, &id, "/tmp/p.txt", b"x", true)?;
            assert_eq!(Sandbox::download(&api, &id, "/tmp/p.txt", 0, 10)?, b"x");
            Ok(())
        };
        let result = run();
        Sandbox::power(&api, &id, "delete").unwrap();
        result.unwrap();
    }
}
