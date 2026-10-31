//! Hetzner Cloud servers for cloud agents (docs/cloud-agents.md): VPS boxes over the shared
//! SSH transport (cloud/ssh.rs), driven by the Cloud API (api.hetzner.cloud/v1, one project
//! token). Servers carry the `pandacode=true` label; new ones are the CPX22 on the stock
//! Ubuntu 24.04 image in the saved location. Like the other VPS providers they bill while
//! they exist, off included — deleting is what ends the billing.
use serde_json::{json, Value};
use std::time::Duration;

use super::{http, http::block, sandbox::{Info, Sandbox}, ssh, Machine};
use crate::Result;

const SERVICE: &str = "Hetzner";
const DEFAULT_API: &str = "https://api.hetzner.cloud/v1";
const LOCATION: &str = "fsn1";
const SERVER_TYPE: &str = "cpx22";
const IMAGE: &str = "ubuntu-24.04";
const LABEL: &str = "pandacode";
const KEY_NAME: &str = "pandacode";
/// Cloud-init for a fresh server: the Sandbox contract's git and curl.
const USER_DATA: &str = "#cloud-config\npackages:\n  - git\n  - curl\n";
/// A new server installs and boots within this many polls.
const BOOT_TRIES: u32 = 90;
const BOOT_PAUSE: u64 = 5;
/// A power action completes within this many polls.
const ACTION_TRIES: u32 = 60;

pub struct Hetzner {
    api: String,
    key: String,
}

impl Hetzner {
    pub fn new(api: Option<String>, key: String) -> Self {
        Hetzner { api: api.filter(|a| !a.trim().is_empty()).unwrap_or_else(|| DEFAULT_API.into()).trim_end_matches('/').to_string(), key }
    }
    fn connected() -> Result<Self> {
        Ok(Hetzner::new(None, super::secret("hetzner_key").ok_or("Connect Hetzner in Settings → Cloud first.")?))
    }
    async fn api(&self, method: reqwest::Method, path: &str, body: Option<Value>) -> Result<Value> {
        let request = http::client(Duration::from_secs(60))?.request(method, format!("{}{path}", self.api)).bearer_auth(&self.key);
        http::send(SERVICE, match body { Some(body) => request.json(&body), None => request }).await
    }

    /// The token works: Hetzner has no account endpoint, so read one server.
    pub async fn verify(&self) -> Result<()> {
        self.api(reqwest::Method::GET, "/servers?per_page=1", None).await.map(|_| ())
    }
    /// The saved location, else Falkenstein.
    fn location() -> String {
        super::settings().providers.get("hetzner").and_then(|options| options.get("location")).filter(|l| !l.is_empty()).cloned().unwrap_or_else(|| LOCATION.into())
    }

    pub async fn list(&self) -> Result<Vec<Machine>> {
        let page = self.api(reqwest::Method::GET, "/servers?label_selector=pandacode%3Dtrue&per_page=50", None).await?;
        Ok(page["servers"].as_array().map(|items| items.iter().filter_map(machine).collect()).unwrap_or_default())
    }

    /// The project SSH key holding our public key, creating one named after the key's tail
    /// when missing; servers embed it at create. Matched by material, not name.
    async fn key_name(&self, public: &str) -> Result<String> {
        let keys = self.api(reqwest::Method::GET, "/ssh_keys?per_page=50", None).await?;
        for key in keys["ssh_keys"].as_array().into_iter().flatten() {
            if key["public_key"].as_str().map(str::trim) == Some(public) {
                return key["name"].as_str().map(str::to_string).ok_or_else(|| "Hetzner reported an unreadable SSH key.".to_string());
            }
        }
        let tail: String = public.chars().rev().filter(|c| c.is_ascii_alphanumeric()).take(6).collect::<Vec<_>>().into_iter().rev().collect();
        let name = if tail.is_empty() { KEY_NAME.to_string() } else { format!("{KEY_NAME}-{tail}") };
        let made = self.api(reqwest::Method::POST, "/ssh_keys", Some(json!({"name": name, "public_key": public}))).await?;
        made["ssh_key"]["name"].as_str().map(str::to_string).ok_or_else(|| "Hetzner did not report the new SSH key.".to_string())
    }

    pub async fn create(&self, name: &str) -> Result<Machine> {
        let name = valid_name(name)?;
        let location = Self::location();
        let public = ssh::key_pair()?.1;
        let key = self.key_name(&public).await?;
        let body = json!({"name": name, "server_type": SERVER_TYPE, "image": IMAGE, "location": location, "ssh_keys": [key], "labels": {LABEL: "true"}, "user_data": USER_DATA, "start_after_create": true});
        let made = self.api(reqwest::Method::POST, "/servers", Some(body)).await?;
        let native = made["server"]["id"].as_u64().ok_or_else(|| "Hetzner did not report the new server.".to_string())?.to_string();
        let mut address = Err(String::from("never tried"));
        for _ in 0..BOOT_TRIES {
            address = self.ip(&native).await;
            if address.is_ok() { break; }
            std::thread::sleep(Duration::from_secs(BOOT_PAUSE));
        }
        let ip = address.map_err(|_| "The server started but got no public address in time. Delete it and try again.".to_string())?;
        ssh::address_cache().lock().unwrap().insert(format!("{}:{native}", self.api), ip.clone());
        // The address may have been recycled from an older server with a different key.
        ssh::forget_host(&ip, 22);
        ssh::wait_ready(&ssh::Target::vps(ip), CLOUD_INIT_WAIT)?;
        Ok(Machine { id: format!("hetzner:{native}"), provider: "hetzner".into(), name: name.into(), state: "running".into(), os: "linux".into(), desktop: false, detail: format!("{SERVICE} · {SERVER_TYPE} · {location}") })
    }

    /// The server's public IPv4 from one lookup, also put in the shared address cache.
    async fn ip(&self, native: &str) -> Result<String> {
        let item = self.api(reqwest::Method::GET, &format!("/servers/{native}"), None).await?;
        item["server"]["public_net"]["ipv4"]["ip"].as_str().map(str::to_string).filter(|ip| !ip.is_empty()).ok_or_else(|| "The server has no public address yet; try again in a minute.".to_string())
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

    async fn status(&self, native: &str) -> Result<String> {
        Ok(self.api(reqwest::Method::GET, &format!("/servers/{native}"), None).await?["server"]["status"].as_str().unwrap_or_default().to_string())
    }
    async fn action(&self, native: &str, kind: &str) -> Result<u64> {
        let made = self.api(reqwest::Method::POST, &format!("/servers/{native}/actions/{kind}"), None).await?;
        made["action"]["id"].as_u64().ok_or_else(|| "Hetzner did not report the power action.".to_string())
    }
    async fn wait_action(&self, id: u64) -> Result<()> {
        for _ in 0..ACTION_TRIES {
            let reply = self.api(reqwest::Method::GET, &format!("/actions/{id}"), None).await?;
            match reply["action"]["status"].as_str() {
                Some("success") => return Ok(()),
                Some("error") => return Err("The server did not change power state; check it in the Hetzner console.".into()),
                _ => std::thread::sleep(Duration::from_secs(BOOT_PAUSE)),
            }
        }
        Err("The server is taking unusually long to change power state.".into())
    }

    pub async fn power(&self, native: &str, action: &str) -> Result<()> {
        match action {
            "start" => {
                self.wait_action(self.action(native, "poweron").await?).await?;
                // The API reports running before sshd is up; wait, so the next call cannot fail.
                let target = ssh::Target::vps(self.address(native, false).await?);
                ssh::wait_ready(&target, "true")
            }
            // Hetzner's shutdown asks the OS (ACPI) and can be refused; poweroff cuts power.
            // The disk is persistent, so a clean stop matters: graceful first, hammer after.
            "stop" => {
                let graceful = match self.action(native, "shutdown").await {
                    Ok(id) => self.wait_action(id).await.is_ok(),
                    Err(_) => false,
                };
                if graceful && self.status(native).await.ok().as_deref() == Some("off") {
                    return Ok(());
                }
                self.wait_action(self.action(native, "poweroff").await?).await
            }
            "delete" => {
                let address = self.address(native, false).await.ok();
                let result = match self.api(reqwest::Method::DELETE, &format!("/servers/{native}"), None).await {
                    // A server that is already gone did what was asked; confirm through the
                    // list, since the error text alone does not say the status.
                    Err(_) if !self.exists(native).await.unwrap_or(true) => Ok(()),
                    result => result.map(|_| ()),
                };
                // Hetzner recycles addresses; the next server there must not trip over the
                // remembered host key.
                if result.is_ok() {
                    if let Some(ip) = address {
                        ssh::forget_host(&ip, 22);
                    }
                }
                result
            }
            _ => Err(format!("Hetzner servers can start, stop or be deleted, not {action}.")),
        }
    }
    async fn exists(&self, native: &str) -> Result<bool> {
        let page = self.api(reqwest::Method::GET, "/servers?label_selector=pandacode%3Dtrue&per_page=50", None).await?;
        Ok(page["servers"].as_array().is_some_and(|items| items.iter().any(|item| item["id"].as_u64() == native.parse().ok())))
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

fn state(status: &str) -> &'static str {
    match status {
        "running" => "running",
        "initializing" | "starting" => "starting",
        "stopping" => "stopping",
        "off" => "stopped",
        _ => "error",
    }
}
fn machine(item: &Value) -> Option<Machine> {
    let id = item["id"].as_u64()?;
    let location = item["datacenter"]["location"]["name"].as_str().unwrap_or_default();
    let kind = item["server_type"]["name"].as_str().unwrap_or("server");
    Some(Machine { id: format!("hetzner:{id}"), provider: "hetzner".into(), name: item["name"].as_str().unwrap_or("server").into(), state: state(item["status"].as_str().unwrap_or_default()).into(), os: "linux".into(), desktop: false, detail: format!("{SERVICE} · {kind} · {location}") })
}

/// Server names become reverse-DNS records: lowercase letters, digits and dashes.
fn valid_name(name: &str) -> Result<&str> {
    let ok = (1..=63).contains(&name.len())
        && name.starts_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit())
        && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !name.ends_with('-');
    ok.then_some(name).ok_or_else(|| "Hetzner names use lowercase letters, digits and dashes, starting with a letter or digit (up to 63).".to_string())
}

pub fn connect(key: &str, options: &Value) -> Result<()> {
    let key = key.trim();
    if key.is_empty() {
        return Err("Enter your Hetzner API token.".into());
    }
    let location = options["location"].as_str().map(str::trim).filter(|l| !l.is_empty());
    if let Some(location) = location {
        if location.len() > 32 || !location.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()) {
            return Err("That does not look like a Hetzner location (for example fsn1, nbg1 or ash).".into());
        }
    }
    block(Hetzner::new(None, key.into()).verify())?;
    super::set_secret("hetzner_key", key)?;
    let mut settings = super::settings();
    let entry = settings.providers.entry("hetzner".into()).or_default();
    if let Some(location) = location {
        entry.insert("location".into(), location.into());
    }
    entry.insert("detail".into(), "API token saved".into());
    super::save_settings(&settings)
}
pub fn disconnect() -> Result<()> {
    super::remove_secret("hetzner_key");
    let mut settings = super::settings();
    settings.providers.remove("hetzner");
    super::save_settings(&settings)
}
pub fn sandbox() -> Result<Box<dyn Sandbox>> {
    Ok(Box::new(Hetzner::connected()?))
}

impl Sandbox for Hetzner {
    /// Servers keep their disk; they bill while they exist, off included.
    fn info(&self) -> Info {
        Info { persistent: true, max_unattended_minutes: 24 * 60 }
    }
    fn list(&self) -> Result<Vec<Machine>> {
        block(Hetzner::list(self))
    }
    fn create(&self, name: &str) -> Result<Machine> {
        block(Hetzner::create(self, name))
    }
    fn power(&self, native: &str, action: &str) -> Result<()> {
        block(Hetzner::power(self, native, action))
    }
    fn exec(&self, native: &str, command: &str, timeout: Duration) -> Result<(Option<i32>, String)> {
        block(Hetzner::exec(self, native, command, timeout))
    }
    /// Servers run until stopped; cloud agents stop them themselves after an idle run end.
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

    fn api() -> (Hetzner, mock::Seen) {
        let (base, seen) = mock::serve(|request, _| match (request.method.as_str(), request.path.as_str()) {
            ("GET", "/servers?per_page=1") => (200, br#"{"servers":[]}"#.to_vec()),
            ("GET", "/ssh_keys?per_page=50") => (200, br#"{"ssh_keys":[{"id":7,"name":"other","public_key":"ssh-rsa ZZZ"},{"id":9,"name":"pandacode","public_key":"ssh-ed25519 AAAA pandacode"}]}"#.to_vec()),
            ("POST", "/ssh_keys") => (201, br#"{"ssh_key":{"id":11,"name":"pandacode"}}"#.to_vec()),
            ("GET", "/servers?label_selector=pandacode%3Dtrue&per_page=50") => (200, br#"{"servers":[{"id":1,"name":"job","status":"running","server_type":{"name":"cpx22"},"datacenter":{"location":{"name":"fsn1"}}},{"id":2,"name":"wip","status":"starting","server_type":{"name":"cpx22"},"datacenter":{"location":{"name":"fsn1"}}},{"id":3,"name":"off","status":"off","server_type":{"name":"cpx22"},"datacenter":{"location":{"name":"ash"}}}]}"#.to_vec()),
            ("POST", "/servers") => (201, br#"{"server":{"id":42,"status":"initializing","public_net":{"ipv4":{"ip":"203.0.113.8"}}},"action":{"id":60,"status":"running"}}"#.to_vec()),
            ("GET", "/servers/42") => (200, br#"{"server":{"id":42,"status":"running","public_net":{"ipv4":{"ip":"203.0.113.8"}}}}"#.to_vec()),
            ("POST", "/servers/1/actions/shutdown") => (201, br#"{"action":{"id":71,"status":"running"}}"#.to_vec()),
            ("POST", "/servers/1/actions/poweroff") => (201, br#"{"action":{"id":72,"status":"running"}}"#.to_vec()),
            ("POST", "/servers/3/actions/shutdown") => (201, br#"{"action":{"id":73,"status":"running"}}"#.to_vec()),
            ("GET", "/actions/71") | ("GET", "/actions/72") | ("GET", "/actions/73") => (200, br#"{"action":{"status":"success"}}"#.to_vec()),
            ("GET", "/servers/1") => (200, br#"{"server":{"id":1,"status":"running"}}"#.to_vec()),
            ("GET", "/servers/3") => (200, br#"{"server":{"id":3,"status":"off"}}"#.to_vec()),
            ("DELETE", "/servers/1") => (201, br#"{"action":{"id":74,"status":"running"}}"#.to_vec()),
            ("DELETE", "/servers/gone") => (404, br#"{"error":{"code":"not_found","message":"server not found"}}"#.to_vec()),
            _ => (500, br#"{"error":{"code":"internal","message":"unexpected"}}"#.to_vec()),
        });
        (Hetzner::new(Some(base), "tok-1".into()), seen)
    }

    #[tokio::test]
    async fn lists_labelled_servers_with_readable_states() {
        let (api, seen) = api();
        let machines = api.list().await.unwrap();
        assert_eq!(machines.iter().map(|m| (m.id.as_str(), m.name.as_str(), m.state.as_str())).collect::<Vec<_>>(), vec![("hetzner:1", "job", "running"), ("hetzner:2", "wip", "starting"), ("hetzner:3", "off", "stopped")]);
        assert_eq!(machines[0].detail, "Hetzner · cpx22 · fsn1");
        assert!(!machines[0].desktop && machines[0].os == "linux");
        let log = seen.lock().unwrap();
        assert!(log.iter().all(|r| r.authorization.as_deref() == Some("Bearer tok-1")));
        assert!(log.iter().any(|r| r.path == "/servers?label_selector=pandacode%3Dtrue&per_page=50"));
    }

    #[tokio::test]
    async fn keys_match_by_material_and_addresses_are_cached() {
        let (api, seen) = api();
        assert_eq!(api.key_name("ssh-ed25519 AAAA pandacode").await.unwrap(), "pandacode");
        assert_eq!(api.ip("42").await.unwrap(), "203.0.113.8");
        assert_eq!(api.address("42", false).await.unwrap(), "203.0.113.8");
        assert_eq!(api.address("42", false).await.unwrap(), "203.0.113.8");
        // One GET for the raw ip() probe and one for the first cached address; the second
        // address() call hits the cache.
        assert_eq!(seen.lock().unwrap().iter().filter(|r| r.path == "/servers/42").count(), 2);
    }

    #[tokio::test]
    async fn power_shuts_down_gracefully_then_hammers() {
        let (api, seen) = api();
        api.power("3", "stop").await.unwrap();
        api.power("1", "stop").await.unwrap();
        assert!(api.power("1", "suspend").await.unwrap_err().contains("suspend"));
        api.power("1", "delete").await.unwrap();
        api.power("gone", "delete").await.unwrap();
        let log = seen.lock().unwrap();
        let kinds: Vec<String> = log.iter().filter(|r| r.path.starts_with("/servers/1/actions/")).map(|r| r.path.rsplit('/').next().unwrap().to_string()).collect();
        // Server 1 reported "running" after the graceful shutdown, so the hard poweroff followed.
        assert_eq!(kinds, vec!["shutdown", "poweroff"]);
        // Server 3 answered "off" after the graceful shutdown, so no hammer followed.
        assert_eq!(log.iter().filter(|r| r.path.starts_with("/servers/3/actions/")).count(), 1);
    }

    #[tokio::test]
    async fn bad_tokens_are_refused_before_anything_is_saved() {
        let (base, _) = mock::serve(|_, _| (403, br#"{"error":{"code":"unauthorized","message":"invalid token"}}"#.to_vec()));
        let api = Hetzner::new(Some(base), "nope".into());
        assert!(api.verify().await.unwrap_err().contains("refused the credentials"));
        assert!(connect(" ", &Value::Null).is_err());
        assert!(connect("tok", &json!({"location": "BAD PLACE"})).is_err());
    }

    #[test]
    fn names_and_states() {
        assert_eq!(valid_name("pc-1").unwrap(), "pc-1");
        assert!(valid_name("Pc-1").is_err() && valid_name("-pc").is_err() && valid_name("pc-").is_err());
        assert_eq!(state("running"), "running");
        assert_eq!(state("starting"), "starting");
        assert_eq!(state("off"), "stopped");
        assert_eq!(state("migrating"), "error");
        let item = json!({"id":5,"name":"x","status":"running","server_type":{"name":"cpx22"},"datacenter":{"location":{"name":"nbg1"}}});
        assert_eq!(machine(&item).unwrap().id, "hetzner:5");
    }

    /// Needs HETZNER_API_KEY and a working local ssh; run with `cargo test hetzner_live -- --ignored`.
    #[test]
    #[ignore]
    fn hetzner_live() {
        let key = std::env::var("HETZNER_API_KEY").expect("HETZNER_API_KEY");
        let api = Hetzner::new(None, key);
        let made = Sandbox::create(&api, "pandacode-smoke").unwrap();
        let id = made.id.trim_start_matches("hetzner:").to_string();
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
