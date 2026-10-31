//! DigitalOcean droplets for cloud agents (docs/cloud-agents.md): regular VPS boxes in the
//! user's account, driven by the REST API (docs.digitalocean.com/reference/api/digitalocean)
//! with one personal token and reached over SSH (cloud/ssh.rs). Droplets carry the
//! `pandacode` tag; new ones are the smallest 4 GB Ubuntu image in the saved region. Like
//! AWS and Google Cloud VMs they run until stopped, and the panel stops them after idle runs.
use serde_json::{json, Value};
use std::time::Duration;

use super::{http, http::block, sandbox::{Info, Sandbox}, ssh, Machine};
use crate::Result;

const SERVICE: &str = "DigitalOcean";
const DEFAULT_API: &str = "https://api.digitalocean.com/v2";
const REGION: &str = "nyc1";
const SIZE: &str = "s-2vcpu-4gb";
const IMAGE: &str = "ubuntu-24-04-x64";
const TAG: &str = "pandacode";
const KEY_NAME: &str = "pandacode";
/// Cloud-init for a fresh droplet: the Sandbox contract's git and curl.
const USER_DATA: &str = "#cloud-config\npackages:\n  - git\n  - curl\n";
/// A fresh droplet is not usable until cloud-init finished (its apt would race ours).
const CLOUD_INIT_WAIT: &str = "cloud-init status --wait >/dev/null 2>&1; exit 0";
/// A new droplet gets its address and boots within this many polls of `ip`.
const BOOT_TRIES: u32 = 60;
const BOOT_PAUSE: u64 = 5;
/// A power action completes within this many polls.
const ACTION_TRIES: u32 = 60;

pub struct DigitalOcean {
    api: String,
    key: String,
}

impl DigitalOcean {
    pub fn new(api: Option<String>, key: String) -> Self {
        DigitalOcean { api: api.filter(|a| !a.trim().is_empty()).unwrap_or_else(|| DEFAULT_API.into()).trim_end_matches('/').to_string(), key }
    }
    fn connected() -> Result<Self> {
        Ok(DigitalOcean::new(None, super::secret("digitalocean_key").ok_or("Connect DigitalOcean in Settings → Cloud first.")?))
    }
    async fn api(&self, method: reqwest::Method, path: &str, body: Option<Value>) -> Result<Value> {
        let request = http::client(Duration::from_secs(60))?.request(method, format!("{}{path}", self.api)).bearer_auth(&self.key);
        http::send(SERVICE, match body { Some(body) => request.json(&body), None => request }).await
    }

    /// The token works: read the account it belongs to.
    pub async fn verify(&self) -> Result<()> {
        self.api(reqwest::Method::GET, "/account", None).await.map(|_| ())
    }
    /// The saved region, else New York 1.
    fn region() -> String {
        super::settings().providers.get("digitalocean").and_then(|options| options.get("region")).filter(|r| !r.is_empty()).cloned().unwrap_or_else(|| REGION.into())
    }

    pub async fn list(&self) -> Result<Vec<Machine>> {
        let page = self.api(reqwest::Method::GET, "/droplets?tag_name=pandacode&per_page=200", None).await?;
        Ok(page["droplets"].as_array().map(|items| items.iter().filter_map(machine).collect()).unwrap_or_default())
    }

    /// The account SSH key holding our public key, creating one named after the key's tail
    /// when missing; droplets embed it at create. Matched by material, not name: a second
    /// computer (or a reset app dir) must register its own key, not reuse another machine's.
    async fn key_id(&self, public: &str) -> Result<i64> {
        if let Some(id) = self.listed_key(public).await? {
            return Ok(id);
        }
        let tail: String = public.chars().rev().filter(|c| c.is_ascii_alphanumeric()).take(6).collect::<Vec<_>>().into_iter().rev().collect();
        let name = if tail.is_empty() { KEY_NAME.to_string() } else { format!("{KEY_NAME}-{tail}") };
        let made = self.api(reqwest::Method::POST, "/account/keys", Some(json!({"name": name, "public_key": public}))).await;
        // The create replies with the key as `ssh_key` (`key` in an alternate shape).
        if let Ok(made) = &made {
            if let Some(id) = made["ssh_key"]["id"].as_i64().or_else(|| made["key"]["id"].as_i64()) {
                return Ok(id);
            }
        }
        // A reply without the id — or a create that lost a race against another task
        // registering the same material — still leaves the key in the account: match it
        // there rather than failing or registering a duplicate.
        if let Some(id) = self.listed_key(public).await? {
            return Ok(id);
        }
        // Nothing matched: the create's own error, else the reply never named the key.
        Err(made.err().unwrap_or_else(|| "DigitalOcean did not report the new SSH key.".into()))
    }

    /// The id of the account key whose material matches, from one list page.
    async fn listed_key(&self, public: &str) -> Result<Option<i64>> {
        let keys = self.api(reqwest::Method::GET, "/account/keys?per_page=200", None).await?;
        for key in keys["ssh_keys"].as_array().into_iter().flatten() {
            if key["public_key"].as_str().map(str::trim) == Some(public) {
                return key["id"].as_i64().map(Some).ok_or_else(|| "DigitalOcean reported an unreadable SSH key.".to_string());
            }
        }
        Ok(None)
    }

    /// The droplet's public IPv4 from one lookup; a fresh droplet's address appears on retry.
    async fn ip(&self, id: &str) -> Result<String> {
        let item = self.api(reqwest::Method::GET, &format!("/droplets/{id}"), None).await?;
        item["droplet"]["networks"]["v4"].as_array().and_then(|networks| networks.iter().find(|n| n["type"] == "public")).and_then(|n| n["ip_address"].as_str()).map(str::to_string).ok_or_else(|| "The droplet has no public address yet; try again in a minute.".to_string())
    }

    /// The address, cached per machine: one REST lookup instead of one per exec, since the
    /// run's poll cadence would otherwise exhaust the API's rate limits. `fresh` re-asks the
    /// API first, after a cached address stopped answering.
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

    pub async fn create(&self, name: &str) -> Result<Machine> {
        let name = valid_name(name)?;
        let region = Self::region();
        // ssh::key_pair and wait_ready are synchronous; this future already runs on a
        // blocking thread, so nesting `block` here would panic.
        let public = ssh::key_pair()?.1;
        let key = self.key_id(&public).await?;
        let made = self.api(reqwest::Method::POST, "/droplets", Some(create_body(name, &region, key))).await?;
        let id = made["droplet"]["id"].as_u64().ok_or_else(|| "DigitalOcean did not report the new droplet.".to_string())?;
        let native = id.to_string();
        let mut address = Err(String::from("never tried"));
        for _ in 0..BOOT_TRIES {
            address = self.ip(&native).await;
            if address.is_ok() { break; }
            std::thread::sleep(Duration::from_secs(BOOT_PAUSE));
        }
        let ip = address.map_err(|_| "The droplet started but got no public address in time. Delete it and try again.".to_string())?;
        // The address may have been recycled from an older droplet with a different key.
        ssh::forget_host(&ip, 22);
        ssh::wait_ready(&ssh::Target::vps(ip), CLOUD_INIT_WAIT)?;
        Ok(Machine { id: format!("digitalocean:{native}"), provider: "digitalocean".into(), name: name.into(), state: "running".into(), os: "linux".into(), desktop: false, detail: format!("{SERVICE} · {SIZE} · {region}") })
    }

    pub async fn power(&self, id: &str, action: &str) -> Result<()> {
        match action {
            "start" => {
                let made = self.api(reqwest::Method::POST, &format!("/droplets/{id}/actions"), Some(json!({"type": "power_on"}))).await?;
                self.wait_action(Self::action_id(&made)?).await?;
                // The API reports active before sshd is up; wait, so the next call cannot fail.
                let target = ssh::Target::vps(self.address(id, false).await?);
                ssh::wait_ready(&target, "true")
            }
            // DO's docs: request a graceful shutdown, then make sure with a hard power_off
            // ("this action guarantees that the command is issued, not that it succeeds") —
            // the droplet's disk is persistent, so a clean stop matters.
            "stop" => {
                let made = self.api(reqwest::Method::POST, &format!("/droplets/{id}/actions"), Some(json!({"type": "shutdown"}))).await?;
                self.wait_action(Self::action_id(&made)?).await?;
                if self.state_of(id).await.ok().as_deref() == Some("off") {
                    return Ok(());
                }
                let made = self.api(reqwest::Method::POST, &format!("/droplets/{id}/actions"), Some(json!({"type": "power_off"}))).await?;
                self.wait_action(Self::action_id(&made)?).await
            }
            "delete" => {
                let address = self.address(id, false).await.ok();
                let result = match self.api(reqwest::Method::DELETE, &format!("/droplets/{id}"), None).await {
                    // A droplet that is already gone did what was asked; the 404 text alone
                    // does not say the status, so confirm through the list.
                    Err(_) if !self.exists(id).await.unwrap_or(true) => Ok(()),
                    result => result.map(|_| ()),
                };
                // DO recycles addresses quickly; the next droplet there must not trip over
                // the remembered host key.
                if result.is_ok() {
                    if let Some(ip) = address {
                        ssh::forget_host(&ip, 22);
                    }
                }
                result
            }
            _ => Err(format!("DigitalOcean droplets can start, stop or be deleted, not {action}.")),
        }
    }
    async fn state_of(&self, id: &str) -> Result<String> {
        Ok(self.api(reqwest::Method::GET, &format!("/droplets/{id}"), None).await?["droplet"]["status"].as_str().unwrap_or_default().to_string())
    }
    fn action_id(made: &Value) -> Result<u64> {
        made["action"]["id"].as_u64().ok_or_else(|| "DigitalOcean did not report the power action.".to_string())
    }
    async fn exists(&self, id: &str) -> Result<bool> {
        let page = self.api(reqwest::Method::GET, "/droplets?tag_name=pandacode&per_page=200", None).await?;
        let native = id.parse::<u64>().ok();
        Ok(page["droplets"].as_array().is_some_and(|items| items.iter().any(|item| item["id"].as_u64() == native)))
    }
    async fn wait_action(&self, id: u64) -> Result<()> {
        for _ in 0..ACTION_TRIES {
            let reply = self.api(reqwest::Method::GET, &format!("/actions/{id}"), None).await?;
            match reply["action"]["status"].as_str() {
                Some("completed") => return Ok(()),
                Some("errored") => return Err("The droplet did not change power state; check it in the DigitalOcean console.".into()),
                _ => std::thread::sleep(Duration::from_secs(BOOT_PAUSE)),
            }
        }
        Err("The droplet is taking unusually long to change power state.".into())
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

fn create_body(name: &str, region: &str, key: i64) -> Value {
    json!({"name": name, "region": region, "size": SIZE, "image": IMAGE, "ssh_keys": [key], "tags": [TAG], "user_data": USER_DATA})
}

fn state(status: &str) -> &'static str {
    match status {
        "active" => "running",
        "new" => "starting",
        "off" | "archive" => "stopped",
        _ => "error",
    }
}
/// The ssh failure without the transport marker, for when a retry cannot run.
fn unreachable_text(error: &str) -> String {
    error.strip_prefix(ssh::UNREACHABLE).map(str::to_string).unwrap_or_else(|| error.to_string())
}
fn machine(item: &Value) -> Option<Machine> {
    let id = item["id"].as_u64()?;
    let region = item["region"]["slug"].as_str().unwrap_or_default();
    let size = item["size_slug"].as_str().unwrap_or("droplet");
    Some(Machine { id: format!("digitalocean:{id}"), provider: "digitalocean".into(), name: item["name"].as_str().unwrap_or("droplet").into(), state: state(item["status"].as_str().unwrap_or_default()).into(), os: "linux".into(), desktop: false, detail: format!("{SERVICE} · {size} · {region}") })
}

/// Droplet names are hostnames: lowercase letters, digits and dashes, starting and ending
/// with a letter or digit.
fn valid_name(name: &str) -> Result<&str> {
    let ok = (1..=63).contains(&name.len())
        && name.starts_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit())
        && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !name.ends_with('-');
    ok.then_some(name).ok_or_else(|| "DigitalOcean names use lowercase letters, digits and dashes, starting with a letter or digit (up to 63).".to_string())
}

pub fn connect(key: &str, options: &Value) -> Result<()> {
    let key = key.trim();
    if key.is_empty() {
        return Err("Enter your DigitalOcean API token.".into());
    }
    let region = options["region"].as_str().map(str::trim).filter(|r| !r.is_empty());
    if let Some(region) = region {
        if region.len() > 32 || !region.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') {
            return Err("That does not look like a DigitalOcean region (for example nyc1 or fra1).".into());
        }
    }
    block(DigitalOcean::new(None, key.into()).verify())?;
    super::set_secret("digitalocean_key", key)?;
    let mut settings = super::settings();
    let entry = settings.providers.entry("digitalocean".into()).or_default();
    if let Some(region) = region {
        entry.insert("region".into(), region.into());
    }
    entry.insert("detail".into(), "API token saved".into());
    super::save_settings(&settings)
}
pub fn disconnect() -> Result<()> {
    super::remove_secret("digitalocean_key");
    let mut settings = super::settings();
    settings.providers.remove("digitalocean");
    super::save_settings(&settings)
}
pub fn sandbox() -> Result<Box<dyn Sandbox>> {
    Ok(Box::new(DigitalOcean::connected()?))
}

impl Sandbox for DigitalOcean {
    /// Droplets keep their disk; they run until stopped.
    fn info(&self) -> Info {
        Info { persistent: true, max_unattended_minutes: 24 * 60 }
    }
    fn list(&self) -> Result<Vec<Machine>> {
        block(DigitalOcean::list(self))
    }
    fn create(&self, name: &str) -> Result<Machine> {
        block(DigitalOcean::create(self, name))
    }
    fn power(&self, native: &str, action: &str) -> Result<()> {
        block(DigitalOcean::power(self, native, action))
    }
    fn exec(&self, native: &str, command: &str, timeout: Duration) -> Result<(Option<i32>, String)> {
        block(DigitalOcean::exec(self, native, command, timeout))
    }
    /// Droplets run until stopped; cloud agents stop them themselves after an idle run end.
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

    fn api() -> (DigitalOcean, mock::Seen) {
        let (base, seen) = mock::serve(|request, _| match (request.method.as_str(), request.path.as_str()) {
            ("GET", "/account") => (200, br#"{"account":{"status":"active","email":"me@example.com"}}"#.to_vec()),
            ("GET", "/account/keys?per_page=200") => (200, br#"{"ssh_keys":[{"id":7,"name":"other","public_key":"ssh-rsa ZZZ"},{"id":9,"name":"pandacode","public_key":"ssh-ed25519 AAAA pandacode"}]}"#.to_vec()),
            ("POST", "/account/keys") => (201, br#"{"ssh_key":{"id":11,"name":"pandacode"}}"#.to_vec()),
            ("GET", "/droplets?tag_name=pandacode&per_page=200") => (200, br#"{"droplets":[{"id":1,"name":"job","status":"active","size_slug":"s-2vcpu-4gb","region":{"slug":"nyc1"}},{"id":2,"name":"wip","status":"new","size_slug":"s-2vcpu-4gb","region":{"slug":"fra1"}},{"id":3,"name":"off","status":"off","size_slug":"s-2vcpu-4gb","region":{"slug":"nyc1"}},{"id":5,"name":"done","status":"off","size_slug":"s-2vcpu-4gb","region":{"slug":"nyc1"}}]}"#.to_vec()),
            ("POST", "/droplets") => (202, br#"{"droplet":{"id":42,"name":"job","status":"new"}}"#.to_vec()),
            ("GET", "/droplets/42") => (200, br#"{"droplet":{"id":42,"status":"active","networks":{"v4":[{"type":"private","ip_address":"10.0.0.2"},{"type":"public","ip_address":"203.0.113.9"}]}}}"#.to_vec()),
            ("GET", "/droplets/5") => (200, br#"{"droplet":{"id":5,"status":"off"}}"#.to_vec()),
            ("POST", "/droplets/1/actions") => {
                let kind = if request.body.contains("power_off") { 79 } else { 77 };
                (201, format!(r#"{{"action":{{"id":{kind},"status":"in-progress"}}}}"#).into_bytes())
            }
            ("POST", "/droplets/2/actions") => (201, br#"{"action":{"id":78,"status":"in-progress"}}"#.to_vec()),
            ("POST", "/droplets/5/actions") => (201, br#"{"action":{"id":80,"status":"in-progress"}}"#.to_vec()),
            ("GET", "/actions/77") | ("GET", "/actions/79") | ("GET", "/actions/80") => (200, br#"{"action":{"status":"completed"}}"#.to_vec()),
            ("GET", "/actions/78") => (200, br#"{"action":{"status":"errored"}}"#.to_vec()),
            ("DELETE", "/droplets/1") => (204, Vec::new()),
            ("DELETE", "/droplets/9") => (404, br#"{"id":"not_found","message":"The resource you were accessing could not be found."}"#.to_vec()),
            _ => (500, br#"{"message":"unexpected"}"#.to_vec()),
        });
        (DigitalOcean::new(Some(base), "tok-1".into()), seen)
    }

    #[tokio::test]
    async fn lists_tagged_droplets_with_readable_states() {
        let (api, seen) = api();
        let machines = api.list().await.unwrap();
        assert_eq!(machines.iter().map(|m| (m.id.as_str(), m.name.as_str(), m.state.as_str())).collect::<Vec<_>>(), vec![("digitalocean:1", "job", "running"), ("digitalocean:2", "wip", "starting"), ("digitalocean:3", "off", "stopped"), ("digitalocean:5", "done", "stopped")]);
        assert_eq!(machines[0].detail, "DigitalOcean · s-2vcpu-4gb · nyc1");
        assert!(!machines[0].desktop && machines[0].os == "linux");
        let log = seen.lock().unwrap();
        assert!(log.iter().all(|r| r.authorization.as_deref() == Some("Bearer tok-1")));
        assert!(log.iter().any(|r| r.path == "/droplets?tag_name=pandacode&per_page=200"));
    }

    #[tokio::test]
    async fn reuses_the_pandacode_key_and_creates_with_it() {
        let (api, seen) = api();
        assert_eq!(api.key_id("ssh-ed25519 AAAA pandacode").await.unwrap(), 9);
        let (base, seen2) = mock::serve(|request, _| match (request.method.as_str(), request.path.as_str()) {
            ("GET", "/account/keys?per_page=200") => (200, br#"{"ssh_keys":[]}"#.to_vec()),
            ("POST", "/account/keys") => (201, br#"{"ssh_key":{"id":11,"name":"pandacode"}}"#.to_vec()),
            _ => (500, br#"{"message":"unexpected"}"#.to_vec()),
        });
        let fresh = DigitalOcean::new(Some(base), "t".into());
        assert_eq!(fresh.key_id("ssh-ed25519 BBBB").await.unwrap(), 11);
        assert_eq!(create_body("job", "fra1", 9), json!({"name":"job","region":"fra1","size":SIZE,"image":IMAGE,"ssh_keys":[9],"tags":[TAG],"user_data":USER_DATA}));
        assert_eq!(api.ip("42").await.unwrap(), "203.0.113.9");
        let log = seen2.lock().unwrap();
        let post = log.iter().find(|r| r.method == "POST").unwrap();
        let body: Value = serde_json::from_str(&post.body).unwrap();
        assert_eq!(body["public_key"], "ssh-ed25519 BBBB");
        // A key with different material gets its own account entry, named after the key.
        assert!(body["name"].as_str().unwrap_or_default().starts_with("pandacode-"));
        let _ = seen;
    }

    /// One mock whose account list starts without our key and holds it from the first create
    /// attempt on, answering creates with the given reply. Returns the base URL, the request
    /// log and the number of list reads.
    fn key_race_mock(create: (u16, &'static str), key: &'static str, id: i64) -> (String, mock::Seen, std::sync::Arc<std::sync::atomic::AtomicUsize>) {
        let lists = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counted = lists.clone();
        let (base, seen) = mock::serve(move |request, _| match (request.method.as_str(), request.path.as_str()) {
            ("GET", "/account/keys?per_page=200") => {
                if counted.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                    (200, br#"{"ssh_keys":[]}"#.to_vec())
                } else {
                    (200, format!(r#"{{"ssh_keys":[{{"id":{id},"name":"pandacode","public_key":"{key}"}}]}}"#).into_bytes())
                }
            }
            ("POST", "/account/keys") => (create.0, create.1.as_bytes().to_vec()),
            _ => (500, br#"{"message":"unexpected"}"#.to_vec()),
        });
        (base, seen, lists)
    }

    /// A create that is refused (another task registered the same material first) or answers
    /// without the key still leaves the key in the account: the re-list hands back its id
    /// instead of failing or registering a duplicate (issue #206's third failure).
    #[tokio::test]
    async fn a_refused_or_unreadable_create_relists_the_registered_key() {
        let (base, seen, lists) = key_race_mock((422, r#"{"id":"unprocessable","message":"SSH Key is already in use on your account"}"#), "ssh-ed25519 CCCC pandacode", 12);
        assert_eq!(DigitalOcean::new(Some(base), "t".into()).key_id("ssh-ed25519 CCCC pandacode").await.unwrap(), 12);
        assert_eq!(lists.load(std::sync::atomic::Ordering::SeqCst), 2);
        assert_eq!(seen.lock().unwrap().iter().filter(|r| r.method == "POST").count(), 1, "the refused create must not be retried into a duplicate");

        let (base, seen, lists) = key_race_mock((201, r#"{"ssh_key":{}}"#), "ssh-ed25519 DDDD pandacode", 13);
        assert_eq!(DigitalOcean::new(Some(base), "t".into()).key_id("ssh-ed25519 DDDD pandacode").await.unwrap(), 13);
        assert_eq!(lists.load(std::sync::atomic::Ordering::SeqCst), 2);
        let _ = seen;
    }

    /// A create reply carrying the key as `key` instead of `ssh_key` still parses.
    #[tokio::test]
    async fn an_alternate_create_reply_shape_still_parses() {
        let (base, _) = mock::serve(|request, _| match (request.method.as_str(), request.path.as_str()) {
            ("GET", "/account/keys?per_page=200") => (200, br#"{"ssh_keys":[]}"#.to_vec()),
            ("POST", "/account/keys") => (201, br#"{"key":{"id":11,"name":"pandacode"}}"#.to_vec()),
            _ => (500, br#"{"message":"unexpected"}"#.to_vec()),
        });
        assert_eq!(DigitalOcean::new(Some(base), "t".into()).key_id("ssh-ed25519 BBBB").await.unwrap(), 11);
    }

    #[tokio::test]
    async fn power_shuts_down_gracefully_then_hammers() {
        let (api, seen) = api();
        api.power("5", "stop").await.unwrap();
        api.power("1", "stop").await.unwrap();
        assert!(api.power("2", "stop").await.unwrap_err().contains("did not change power state"));
        assert!(api.power("1", "suspend").await.unwrap_err().contains("suspend"));
        api.power("1", "delete").await.unwrap();
        api.power("9", "delete").await.unwrap();
        let log = seen.lock().unwrap();
        let kinds: Vec<String> = log.iter().filter(|r| r.path == "/droplets/1/actions").filter_map(|r| serde_json::from_str::<Value>(&r.body).ok()).filter_map(|b| b["type"].as_str().map(str::to_string)).collect();
        // Droplet 1 reported "active" after the graceful shutdown, so the hard power_off followed.
        assert_eq!(kinds, vec!["shutdown", "power_off"]);
        // Droplet 5 answered "off" after the graceful shutdown, so no hammer followed.
        assert_eq!(log.iter().filter(|r| r.path == "/droplets/5/actions").count(), 1);
    }

    #[tokio::test]
    async fn addresses_are_cached_per_machine_not_per_call() {
        let (api, seen) = api();
        assert_eq!(api.address("42", false).await.unwrap(), "203.0.113.9");
        assert_eq!(api.address("42", false).await.unwrap(), "203.0.113.9");
        assert_eq!(api.address("42", true).await.unwrap(), "203.0.113.9");
        let gets = seen.lock().unwrap().iter().filter(|r| r.path == "/droplets/42").count();
        // A miss and one forced refresh; a cache hit costs no API call at all.
        assert_eq!(gets, 2);
    }

    #[tokio::test]
    async fn bad_tokens_are_refused_before_anything_is_saved() {
        let (base, _) = mock::serve(|_, _| (401, br#"{"message":"Unable to authenticate you"}"#.to_vec()));
        let api = DigitalOcean::new(Some(base), "nope".into());
        assert!(api.verify().await.unwrap_err().contains("refused the credentials"));
        assert!(connect(" ", &Value::Null).is_err());
        assert!(connect("tok", &json!({"region": "BAD REGION"})).is_err());
    }

    #[test]
    fn names_are_hostnames() {
        assert_eq!(valid_name("pc-1").unwrap(), "pc-1");
        assert!(valid_name("Pc-1").is_err() && valid_name("-pc").is_err() && valid_name("pc-").is_err() && valid_name("").is_err());
        assert!(valid_name(&"a".repeat(64)).is_err());
    }

    #[test]
    fn maps_droplet_states() {
        assert_eq!(state("active"), "running");
        assert_eq!(state("new"), "starting");
        assert_eq!(state("off"), "stopped");
        assert_eq!(state("archive"), "stopped");
        assert_eq!(state("weird"), "error");
    }

    /// Needs DIGITALOCEAN_TOKEN and a working local ssh; run with `cargo test digitalocean_live -- --ignored`.
    #[test]
    #[ignore]
    fn digitalocean_live() {
        let key = std::env::var("DIGITALOCEAN_TOKEN").expect("DIGITALOCEAN_TOKEN");
        let api = DigitalOcean::new(None, key);
        let made = Sandbox::create(&api, "pandacode-smoke").unwrap();
        let id = made.id.trim_start_matches("digitalocean:").to_string();
        let run = || -> Result<()> {
            assert_eq!(Sandbox::exec(&api, &id, "echo hi", Duration::from_secs(30))?, (Some(0), "hi\n".into()));
            Sandbox::spawn(&api, &id, "sleep 120")?;
            let (_, ps) = Sandbox::exec(&api, &id, "ps -eo args | grep '[s]leep 120'", Duration::from_secs(30))?;
            assert!(ps.contains("sleep 120"));
            Sandbox::upload(&api, &id, "/tmp/p.txt", b"x", true)?;
            assert_eq!(Sandbox::download(&api, &id, "/tmp/p.txt", 0, 10)?, b"x");
            Ok(())
        };
        let result = run();
        Sandbox::power(&api, &id, "delete").unwrap();
        result.unwrap();
    }
}
