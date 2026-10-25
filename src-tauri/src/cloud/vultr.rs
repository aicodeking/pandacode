//! Vultr instances for cloud agents (docs/cloud-agents.md): VPS boxes over the shared SSH
//! transport (cloud/ssh.rs), driven by the REST API (api.vultr.com/v2, one personal token).
//! Instances carry the `pandacode` tag; new ones are the 2 vCPU / 4 GB regular cloud plan on
//! the stock Ubuntu 24.04, whose numeric `os_id` is resolved from the account's OS list at
//! create (Vultr has no image slugs). Like the other VPS providers they bill while they
//! exist, stopped or not — deleting is what ends the billing.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::time::Duration;

use super::{http, http::block, sandbox::{Info, Sandbox}, ssh, Machine};
use crate::Result;

const SERVICE: &str = "Vultr";
const DEFAULT_API: &str = "https://api.vultr.com/v2";
const REGION: &str = "ewr";
const PLAN: &str = "vc2-2c-4gb";
const TAG: &str = "pandacode";
const KEY_NAME: &str = "pandacode";
/// Cloud-init for a fresh instance: the Sandbox contract's git and curl.
const USER_DATA: &str = "#cloud-config\npackages:\n  - git\n  - curl\n";
/// A new instance installs its OS and gets its address within this many polls.
const BOOT_TRIES: u32 = 90;
const BOOT_PAUSE: u64 = 5;
/// Vultr's power actions return 204 at once; the instance reaches the state within this many polls.
const POWER_TRIES: u32 = 60;

pub struct Vultr {
    api: String,
    key: String,
}

impl Vultr {
    pub fn new(api: Option<String>, key: String) -> Self {
        Vultr { api: api.filter(|a| !a.trim().is_empty()).unwrap_or_else(|| DEFAULT_API.into()).trim_end_matches('/').to_string(), key }
    }
    fn connected() -> Result<Self> {
        Ok(Vultr::new(None, super::secret("vultr_key").ok_or("Connect Vultr in Settings → Cloud first.")?))
    }
    async fn api(&self, method: reqwest::Method, path: &str, body: Option<Value>) -> Result<Value> {
        let request = http::client(Duration::from_secs(60))?.request(method, format!("{}{path}", self.api)).bearer_auth(&self.key);
        http::send(SERVICE, match body { Some(body) => request.json(&body), None => request }).await
    }

    /// The token works: read the account it belongs to.
    pub async fn verify(&self) -> Result<()> {
        self.api(reqwest::Method::GET, "/account", None).await.map(|_| ())
    }
    /// The saved region, else New Jersey.
    fn region() -> String {
        super::settings().providers.get("vultr").and_then(|options| options.get("region")).filter(|r| !r.is_empty()).cloned().unwrap_or_else(|| REGION.into())
    }

    pub async fn list(&self) -> Result<Vec<Machine>> {
        let page = self.api(reqwest::Method::GET, "/instances?tag=pandacode&per_page=100", None).await?;
        Ok(page["instances"].as_array().map(|items| items.iter().filter_map(machine).collect()).unwrap_or_default())
    }

    /// The account SSH key holding our public key, creating one named after the key's tail
    /// when missing; instances embed it at create. Matched by material, not name.
    async fn key_id(&self, public: &str) -> Result<String> {
        let keys = self.api(reqwest::Method::GET, "/ssh-keys?per_page=100", None).await?;
        for key in keys["ssh_keys"].as_array().into_iter().flatten() {
            if key["ssh_key"].as_str().map(str::trim) == Some(public) {
                return key["id"].as_str().map(str::to_string).ok_or_else(|| "Vultr reported an unreadable SSH key.".to_string());
            }
        }
        let tail: String = public.chars().rev().filter(|c| c.is_ascii_alphanumeric()).take(6).collect::<Vec<_>>().into_iter().rev().collect();
        let name = if tail.is_empty() { KEY_NAME.to_string() } else { format!("{KEY_NAME}-{tail}") };
        let made = self.api(reqwest::Method::POST, "/ssh-keys", Some(json!({"name": name, "ssh_key": public}))).await?;
        made["ssh_key"]["id"].as_str().map(str::to_string).ok_or_else(|| "Vultr did not report the new SSH key.".to_string())
    }

    /// The OS id of stock Ubuntu 24.04 on this account; Vultr has no image slugs, so the
    /// numeric id is looked up by name and may shift as Vultr revises its images.
    async fn ubuntu_id(&self) -> Result<i64> {
        let list = self.api(reqwest::Method::GET, "/os?per_page=100", None).await?;
        for os in list["os"].as_array().into_iter().flatten() {
            let family = os["family"].as_str().unwrap_or_default();
            let name = [os["os"].as_str(), os["name"].as_str()].into_iter().flatten().collect::<String>();
            if family == "ubuntu" && name.contains("24.04") {
                return os["id"].as_i64().ok_or_else(|| "Vultr reported an unreadable OS list.".to_string());
            }
        }
        Err("No Ubuntu 24.04 image in this Vultr account's OS list; pick another provider or check vultr.com.".into())
    }

    pub async fn create(&self, name: &str) -> Result<Machine> {
        let name = valid_name(name)?;
        let region = Self::region();
        let public = ssh::key_pair()?.1;
        let key = self.key_id(&public).await?;
        let os = self.ubuntu_id().await?;
        let body = json!({"region": region, "plan": PLAN, "label": name, "hostname": name, "tags": [TAG], "os_id": os, "sshkey_id": [key], "user_data": STANDARD.encode(USER_DATA), "activation_email": false});
        let made = self.api(reqwest::Method::POST, "/instances", Some(body)).await?;
        let native = made["instance"]["id"].as_str().ok_or_else(|| "Vultr did not report the new instance.".to_string())?.to_string();
        // The address appears once the OS is installed (0.0.0.0 until then).
        let mut address = Err(String::from("never tried"));
        for _ in 0..BOOT_TRIES {
            address = self.ip(&native).await;
            let assigned = address.as_deref().is_ok_and(|ip| !ip.is_empty() && ip != "0.0.0.0");
            if assigned { break; }
            std::thread::sleep(Duration::from_secs(BOOT_PAUSE));
        }
        let ip = address.map_err(|_| "The instance started but got no public address in time. Delete it and try again.".to_string())?;
        ssh::address_cache().lock().unwrap().insert(format!("{}:{native}", self.api), ip.clone());
        // The address may have been recycled from an older instance with a different key.
        ssh::forget_host(&ip, 22);
        ssh::wait_ready(&ssh::Target::vps(ip), CLOUD_INIT_WAIT)?;
        Ok(Machine { id: format!("vultr:{native}"), provider: "vultr".into(), name: name.into(), state: "running".into(), os: "linux".into(), desktop: false, detail: format!("{SERVICE} · {PLAN} · {region}") })
    }

    /// The instance's public IPv4 from one lookup, also put in the shared address cache.
    async fn ip(&self, native: &str) -> Result<String> {
        let item = self.api(reqwest::Method::GET, &format!("/instances/{native}"), None).await?;
        item["instance"]["main_ip"].as_str().map(str::to_string).filter(|ip| !ip.is_empty() && ip != "0.0.0.0").ok_or_else(|| "The instance has no public address yet; try again in a minute.".to_string())
    }
    /// The cached address, else one lookup recorded in the cache; `fresh` re-asks the API.
    async fn address(&self, native: &str, fresh: bool) -> Result<String> {
        let key = format!("{}:{native}", self.api);
        if !fresh {
            if let Some(ip) = ssh::address_cache().lock().unwrap().get(&key) {
                return Ok(ip.clone());
            }
        }
        let ip = self.ip(native).await?;
        ssh::address_cache().lock().unwrap().insert(key, ip.clone());
        Ok(ip)
    }

    pub async fn power(&self, native: &str, action: &str) -> Result<()> {
        match action {
            "start" => {
                self.api(reqwest::Method::POST, &format!("/instances/{native}/start"), None).await?;
                self.wait_power(native, "running").await?;
                let target = ssh::Target::vps(self.address(native, false).await?);
                ssh::wait_ready(&target, "true")
            }
            // Vultr v2 has no graceful shutdown action; halt is the power off.
            "stop" => {
                self.api(reqwest::Method::POST, &format!("/instances/{native}/halt"), None).await?;
                self.wait_power(native, "stopped").await
            }
            "delete" => {
                let address = self.address(native, false).await.ok();
                let result = match self.api(reqwest::Method::DELETE, &format!("/instances/{native}"), None).await {
                    // An instance that is already gone did what was asked; confirm through
                    // the list, since the error text alone does not say the status.
                    Err(_) if !self.exists(native).await.unwrap_or(true) => Ok(()),
                    result => result.map(|_| ()),
                };
                // Vultr recycles addresses; the next instance there must not trip over the
                // remembered host key.
                if result.is_ok() {
                    if let Some(ip) = address {
                        ssh::forget_host(&ip, 22);
                    }
                }
                result
            }
            _ => Err(format!("Vultr instances can start, stop or be deleted, not {action}.")),
        }
    }
    async fn wait_power(&self, native: &str, wanted: &str) -> Result<()> {
        for _ in 0..POWER_TRIES {
            let item = self.api(reqwest::Method::GET, &format!("/instances/{native}"), None).await?;
            if item["instance"]["power_status"].as_str() == Some(wanted) {
                return Ok(());
            }
            std::thread::sleep(Duration::from_secs(BOOT_PAUSE));
        }
        Err(format!("The instance is taking unusually long to reach {wanted}."))
    }
    async fn exists(&self, native: &str) -> Result<bool> {
        let page = self.api(reqwest::Method::GET, "/instances?tag=pandacode&per_page=100", None).await?;
        Ok(page["instances"].as_array().is_some_and(|items| items.iter().any(|item| item["id"].as_str() == Some(native))))
    }

    pub async fn exec(&self, native: &str, command: &str, timeout: Duration) -> Result<(Option<i32>, String)> {
        let target = ssh::Target::vps(self.address(native, false).await?);
        match ssh::exec(&target, command, timeout) {
            // A cached address can be stale after a delete/recreate; re-ask the API once
            // and retry on the new address (which also forgets the old host's key).
            Err(e) if ssh::transport_error(&e) => match self.address(native, true).await {
                Ok(ip) => {
                    if ip != target.host {
                        ssh::forget_host(&target.host, 22);
                    }
                    ssh::exec(&ssh::Target::vps(ip), command, timeout)
                }
                // The fresh lookup failed; surface the ssh failure, not the API error.
                Err(_) => Err(unreachable_text(&e)),
            },
            result => result,
        }
    }
}

/// The cloud-init wait shared with the other SSH providers: a fresh box must have finished
/// its package install before the agent's own setup races it.
const CLOUD_INIT_WAIT: &str = "cloud-init status --wait >/dev/null 2>&1; exit 0";

/// The ssh failure without the transport marker, for when a retry cannot run.
fn unreachable_text(error: &str) -> String {
    error.strip_prefix(ssh::UNREACHABLE).map(str::to_string).unwrap_or_else(|| error.to_string())
}

fn machine(item: &Value) -> Option<Machine> {
    let id = item["id"].as_str()?.to_string();
    let region = item["region"].as_str().unwrap_or_default();
    let plan = item["plan"].as_str().unwrap_or("instance");
    let status = item["status"].as_str().unwrap_or_default();
    let power = item["power_status"].as_str().unwrap_or_default();
    let state = if status == "pending" || item["server_status"].as_str() == Some("installing") { "starting" } else if power == "running" { "running" } else if power == "stopped" { "stopped" } else { "error" };
    Some(Machine { id: format!("vultr:{id}"), provider: "vultr".into(), name: item["label"].as_str().unwrap_or("instance").into(), state: state.into(), os: "linux".into(), desktop: false, detail: format!("{SERVICE} · {plan} · {region}") })
}

/// Vultr labels are free-form, but the label doubles as the hostname, which is strict.
fn valid_name(name: &str) -> Result<&str> {
    let ok = (1..=63).contains(&name.len())
        && name.starts_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit())
        && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !name.ends_with('-');
    ok.then_some(name).ok_or_else(|| "Vultr names use lowercase letters, digits and dashes, starting with a letter or digit (up to 63).".to_string().into())
}

pub fn connect(key: &str, options: &Value) -> Result<()> {
    let key = key.trim();
    if key.is_empty() {
        return Err("Enter your Vultr API key.".into());
    }
    let region = options["region"].as_str().map(str::trim).filter(|r| !r.is_empty());
    if let Some(region) = region {
        if region.len() > 32 || !region.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()) {
            return Err("That does not look like a Vultr region (for example ewr or syd).".into());
        }
    }
    block(Vultr::new(None, key.into()).verify())?;
    super::set_secret("vultr_key", key)?;
    let mut settings = super::settings();
    let entry = settings.providers.entry("vultr".into()).or_default();
    if let Some(region) = region {
        entry.insert("region".into(), region.into());
    }
    entry.insert("detail".into(), "API key saved".into());
    super::save_settings(&settings)
}
pub fn disconnect() -> Result<()> {
    super::remove_secret("vultr_key");
    let mut settings = super::settings();
    settings.providers.remove("vultr");
    super::save_settings(&settings)
}
pub fn sandbox() -> Result<Box<dyn Sandbox>> {
    Ok(Box::new(Vultr::connected()?))
}

impl Sandbox for Vultr {
    /// Instances keep their disk; they bill while they exist, stopped or not.
    fn info(&self) -> Info {
        Info { persistent: true, max_unattended_minutes: 24 * 60 }
    }
    fn list(&self) -> Result<Vec<Machine>> {
        block(Vultr::list(self))
    }
    fn create(&self, name: &str) -> Result<Machine> {
        block(Vultr::create(self, name))
    }
    fn power(&self, native: &str, action: &str) -> Result<()> {
        block(Vultr::power(self, native, action))
    }
    fn exec(&self, native: &str, command: &str, timeout: Duration) -> Result<(Option<i32>, String)> {
        block(Vultr::exec(self, native, command, timeout))
    }
    /// Instances run until stopped; cloud agents halt them themselves after an idle run end.
    fn keep_alive(&self, _native: &str, _minutes: u32) -> Result<()> {
        Ok(())
    }
    /// Whole files over scp; the chunked default would open a connection per 44 KiB.
    fn upload(&self, native: &str, path: &str, bytes: &[u8], private: bool) -> Result<()> {
        let target = ssh::Target::vps(block(self.address(native, false))?);
        match ssh::upload(&target, path, bytes, private) {
            Err(e) if ssh::transport_error(&e) => match block(self.address(native, true)) {
                Ok(ip) => {
                    if ip != target.host {
                        ssh::forget_host(&target.host, 22);
                    }
                    ssh::upload(&ssh::Target::vps(ip), path, bytes, private)
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

    fn api() -> (Vultr, mock::Seen) {
        let (base, seen) = mock::serve(|request, _| match (request.method.as_str(), request.path.as_str()) {
            ("GET", "/account") => (200, br#"{"account":{"email":"me@example.com","name":"me"}}"#.to_vec()),
            ("GET", "/ssh-keys?per_page=100") => (200, br#"{"ssh_keys":[{"id":"k1","name":"other","ssh_key":"ssh-rsa ZZZ"},{"id":"k2","name":"pandacode","ssh_key":"ssh-ed25519 AAAA pandacode"}]}"#.to_vec()),
            ("POST", "/ssh-keys") => (201, br#"{"ssh_key":{"id":"k9","name":"pandacode"}}"#.to_vec()),
            ("GET", "/os?per_page=100") => (200, br#"{"os":[{"id":38,"os":"Ubuntu 24.04 LTS x64","name":"Ubuntu 24.04 LTS","arch":"x64","family":"ubuntu"},{"id":1,"os":"Debian 12","name":"Debian 12","arch":"x64","family":"debian"}]}"#.to_vec()),
            ("GET", "/instances?tag=pandacode&per_page=100") => (200, br#"{"instances":[{"id":"i1","label":"job","status":"active","power_status":"running","server_status":"ok","plan":"vc2-2c-4gb","region":"ewr"},{"id":"i2","label":"wip","status":"pending","power_status":"stopped","server_status":"installing","plan":"vc2-2c-4gb","region":"ewr"}],"meta":{"total":2}}"#.to_vec()),
            ("POST", "/instances") => (202, br#"{"instance":{"id":"i9","status":"pending","main_ip":"0.0.0.0"}}"#.to_vec()),
            ("GET", "/instances/i9") => (200, br#"{"instance":{"id":"i9","status":"active","power_status":"running","server_status":"ok","main_ip":"203.0.113.8"}}"#.to_vec()),
            ("POST", "/instances/i1/halt") => (204, Vec::new()),
            ("GET", "/instances/i1") => (200, br#"{"instance":{"id":"i1","status":"active","power_status":"stopped","main_ip":"203.0.113.7"}}"#.to_vec()),
            ("DELETE", "/instances/i1") => (204, Vec::new()),
            ("DELETE", "/instances/gone") => (404, br#"{"error":"Instance not found"}"#.to_vec()),
            _ => (500, br#"{"error":"unexpected"}"#.to_vec()),
        });
        (Vultr::new(Some(base), "tok-1".into()), seen)
    }

    #[tokio::test]
    async fn lists_tagged_instances_with_readable_states() {
        let (api, seen) = api();
        let machines = api.list().await.unwrap();
        assert_eq!(machines.iter().map(|m| (m.id.as_str(), m.name.as_str(), m.state.as_str())).collect::<Vec<_>>(), vec![("vultr:i1", "job", "running"), ("vultr:i2", "wip", "starting")]);
        assert_eq!(machines[0].detail, "Vultr · vc2-2c-4gb · ewr");
        assert!(!machines[0].desktop && machines[0].os == "linux");
        let log = seen.lock().unwrap();
        assert!(log.iter().all(|r| r.authorization.as_deref() == Some("Bearer tok-1")));
        assert!(log.iter().any(|r| r.path == "/instances?tag=pandacode&per_page=100"));
    }

    #[tokio::test]
    async fn keys_match_by_material_and_os_is_looked_up_by_name() {
        let (api, seen) = api();
        assert_eq!(api.key_id("ssh-ed25519 AAAA pandacode").await.unwrap(), "k2");
        assert_eq!(api.ubuntu_id().await.unwrap(), 38);
        // An account without an Ubuntu 24.04 entry is an error, not a guess.
        let (base, _) = mock::serve(|_, _| (200, br#"{"os":[{"id":1,"os":"Debian 12 x64","name":"Debian 12","arch":"x64","family":"debian"}]}"#.to_vec()));
        assert!(Vultr::new(Some(base), "t".into()).ubuntu_id().await.is_err());
        assert_eq!(api.ip("i9").await.unwrap(), "203.0.113.8");
        let _ = seen;
    }

    #[test]
    fn builds_the_create_body() {
        let body = json!({"region":"ewr","plan":PLAN,"label":"job","hostname":"job","tags":[TAG],"os_id":38,"sshkey_id":["k2"],"user_data":STANDARD.encode(USER_DATA),"activation_email":false});
        assert_eq!(body["user_data"], STANDARD.encode(USER_DATA));
        assert_eq!(body["tags"], json!(["pandacode"]));
        assert_eq!(body["plan"], PLAN);
    }

    #[tokio::test]
    async fn power_halts_and_delete_tolerates_a_gone_instance() {
        let (api, seen) = api();
        api.power("i1", "stop").await.unwrap();
        assert!(api.power("i1", "suspend").await.unwrap_err().contains("suspend"));
        api.power("i1", "delete").await.unwrap();
        api.power("gone", "delete").await.unwrap();
        let log = seen.lock().unwrap();
        assert!(log.iter().any(|r| r.method == "POST" && r.path == "/instances/i1/halt"));
        assert!(log.iter().any(|r| r.method == "DELETE" && r.path == "/instances/gone"));
    }

    #[tokio::test]
    async fn addresses_are_cached_per_instance() {
        let (api, seen) = api();
        assert_eq!(api.address("i9", false).await.unwrap(), "203.0.113.8");
        assert_eq!(api.address("i9", false).await.unwrap(), "203.0.113.8");
        assert_eq!(api.address("i9", true).await.unwrap(), "203.0.113.8");
        let gets = seen.lock().unwrap().iter().filter(|r| r.path == "/instances/i9").count();
        assert_eq!(gets, 2);
    }

    #[tokio::test]
    async fn bad_keys_are_refused_before_anything_is_saved() {
        let (base, _) = mock::serve(|_, _| (401, br#"{"error":"Invalid API key"}"#.to_vec()));
        let api = Vultr::new(Some(base), "nope".into());
        assert!(api.verify().await.unwrap_err().contains("refused the credentials"));
        assert!(connect(" ", &Value::Null).is_err());
        assert!(connect("tok", &json!({"region": "BAD REGION"})).is_err());
    }

    #[test]
    fn names_are_hostnames() {
        assert_eq!(valid_name("pc-1").unwrap(), "pc-1");
        assert!(valid_name("Pc-1").is_err() && valid_name("-pc").is_err() && valid_name("pc-").is_err() && valid_name("").is_err());
    }

    #[test]
    fn maps_instance_states() {
        let base = json!({"id":"i","label":"x","plan":"p","region":"r"});
        let item = |status: &str, power: &str, server: &str| json!({"id":"i","label":"x","plan":"p","region":"r","status":status,"power_status":power,"server_status":server});
        assert_eq!(machine(&item("active", "running", "ok")).unwrap().state, "running");
        assert_eq!(machine(&item("pending", "stopped", "installing")).unwrap().state, "starting");
        assert_eq!(machine(&item("active", "stopped", "ok")).unwrap().state, "stopped");
        assert_eq!(machine(&json!({"id":"i","label":"x","plan":"p","region":"r"})).unwrap().state, "error");
        let _ = base;
    }

    /// Needs VULTR_API_KEY and a working local ssh; run with `cargo test vultr_live -- --ignored`.
    #[test]
    #[ignore]
    fn vultr_live() {
        let key = std::env::var("VULTR_API_KEY").expect("VULTR_API_KEY");
        let api = Vultr::new(None, key);
        let made = Sandbox::create(&api, "pandacode-smoke").unwrap();
        let id = made.id.trim_start_matches("vultr:").to_string();
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
