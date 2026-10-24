//! Google Cloud machines for cloud agents (docs/cloud-agents.md): Compute Engine VMs driven
//! by the user's own `gcloud` login (the connection in Settings → Cloud stores only the
//! project and region; credentials never reach PandaCode). Machines are `e2-standard-2`
//! Debian 12 VMs labelled `pandacode=true`, listed by that label.
//!
//! Commands run with `gcloud compute ssh --tunnel-through-iap`: gcloud creates and
//! publishes its own key and keeps its own known_hosts (it trusts a new VM's key on first use, then checks it), and nothing needs an open SSH port. The
//! one thing IAP needs is a firewall rule admitting Google's IAP range
//! (35.235.240.0/20) on port 22, so `create` adds `pandacode-allow-iap-ssh` to the default
//! network when missing (idempotent). The user also needs IAP-secured Tunnel User rights.
use serde_json::Value;
use std::{process::Command, thread::sleep, time::Duration};

use super::{deploy, sandbox::{Info, Sandbox}, shell_quote, Machine};
use crate::workspace::{run_process, GitOutput};
use crate::Result;

const DEFAULT_ZONE: &str = "us-central1-a";
const FIREWALL: &str = "pandacode-allow-iap-ssh";
const IAP_RANGE: &str = "35.235.240.0/20";
const OUTPUT: usize = 4 << 20;
/// ssh readiness after create/start: attempts × pause.
const SSH_TRIES: u32 = 12;

pub struct Gcloud {
    project: String,
    region: Option<String>,
    zone: String,
}

/// `<region>-a`, else us-central1-a, unless the user chose a zone.
fn zone_for(zone: Option<&str>, region: Option<&str>) -> String {
    zone.filter(|z| !z.is_empty()).map(str::to_string).or_else(|| region.filter(|r| !r.is_empty()).map(|r| format!("{r}-a"))).unwrap_or_else(|| DEFAULT_ZONE.into())
}

/// Machine IDs carry the zone (`name.zone`) because every gcloud call needs it.
fn native_id(name: &str, zone: &str) -> String {
    format!("{name}.{zone}")
}
fn split_native(native: &str) -> Result<(&str, &str)> {
    native.rsplit_once('.').filter(|(name, zone)| valid_name(name) && !zone.is_empty()).ok_or_else(|| "Unknown Google Cloud machine.".into())
}
fn valid_name(name: &str) -> bool {
    name.len() <= 63 && name.starts_with(|c: char| c.is_ascii_lowercase()) && !name.ends_with('-') && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn strings(args: &[&str]) -> Vec<String> {
    args.iter().map(|a| a.to_string()).collect()
}
fn create_args(name: &str, zone: &str) -> Vec<String> {
    strings(&["compute", "instances", "create", name, "--zone", zone, "--machine-type", "e2-standard-2", "--image-family", "debian-12", "--image-project", "debian-cloud", "--boot-disk-size", "50GB", "--labels", "pandacode=true", "--format", "json"])
}
fn firewall_args() -> Vec<String> {
    strings(&["compute", "firewall-rules", "create", FIREWALL, "--network", "default", "--direction", "INGRESS", "--allow", "tcp:22", "--source-ranges", IAP_RANGE, "--description", "PandaCode cloud agents: SSH through Identity-Aware Proxy"])
}
fn ssh_args(name: &str, zone: &str, command: &str) -> Vec<String> {
    let mut args = strings(&["compute", "ssh", name, "--zone", zone, "--tunnel-through-iap", "--quiet", "--command"]);
    args.push(format!("sh -c {}", shell_quote(command)));
    args
}
fn power_args(verb: &str, name: &str, zone: &str) -> Vec<String> {
    let mut args = strings(&["compute", "instances", verb, name, "--zone", zone, "--quiet"]);
    if verb == "delete" {
        args.push("--delete-disks=all".into());
    }
    args
}

fn state(status: &str) -> &str {
    match status {
        "RUNNING" => "running",
        "PROVISIONING" | "STAGING" => "starting",
        "STOPPING" | "SUSPENDING" => "stopping",
        "TERMINATED" | "STOPPED" | "SUSPENDED" => "stopped",
        "REPAIRING" => "error",
        _ => "error",
    }
}
fn machine(item: &Value) -> Option<Machine> {
    let name = item["name"].as_str()?;
    let zone = item["zone"].as_str()?.rsplit('/').next()?;
    let kind = item["machineType"].as_str().and_then(|t| t.rsplit('/').next()).unwrap_or("VM");
    Some(Machine { id: format!("gcloud:{}", native_id(name, zone)), provider: "gcloud".into(), name: name.into(), state: state(item["status"].as_str().unwrap_or_default()).into(), os: "linux".into(), desktop: false, detail: format!("Google Cloud · {kind} · {zone}") })
}

impl Gcloud {
    fn connected() -> Result<Self> {
        let settings = super::settings();
        let project = settings.gcloud_project.clone().ok_or("Connect Google Cloud in Settings → Cloud first.")?;
        let zone = zone_for(settings.providers.get("gcloud").and_then(|o| o.get("zone")).map(String::as_str), settings.gcloud_region.as_deref());
        Ok(Gcloud { project, region: settings.gcloud_region, zone })
    }
    fn run(&self, args: &[String], timeout: Duration) -> Result<GitOutput> {
        let mut command: Command = deploy::gcloud(&self.project, self.region.as_deref())?;
        command.args(args);
        run_process(command, "gcloud", OUTPUT, timeout)
    }
    /// stdout of a gcloud call that must succeed; otherwise the scrubbed first error line.
    fn text(&self, args: &[String], timeout: Duration) -> Result<String> {
        let out = self.run(args, timeout)?;
        if out.status.success() {
            return Ok(String::from_utf8_lossy(&out.stdout.bytes).into_owned());
        }
        let error = deploy::scrub_gcloud(&String::from_utf8_lossy(&out.stderr.bytes));
        let reason = error.lines().map(str::trim).rev().find(|l| l.starts_with("ERROR") || !l.is_empty()).unwrap_or("gcloud failed");
        Err(format!("Google Cloud: {}", reason.trim_start_matches("ERROR: ").chars().take(300).collect::<String>()))
    }
    fn ensure_iap_firewall(&self) -> Result<()> {
        let describe = strings(&["compute", "firewall-rules", "describe", FIREWALL, "--format", "value(name)"]);
        if self.run(&describe, Duration::from_secs(60))?.status.success() {
            return Ok(());
        }
        self.text(&firewall_args(), Duration::from_secs(120)).map(|_| ())
    }
    fn wait_for_ssh(&self, name: &str, zone: &str) -> Result<()> {
        let mut last = String::new();
        for _ in 0..SSH_TRIES {
            match self.exec_in(name, zone, "true", Duration::from_secs(60)) {
                Ok((Some(0), _)) => return Ok(()),
                Ok((_, output)) => last = output,
                Err(error) => last = error,
            }
            sleep(Duration::from_secs(10));
        }
        Err(format!("The Google Cloud VM started but SSH through IAP did not come up: {}", last.trim().chars().take(300).collect::<String>()))
    }
    fn exec_in(&self, name: &str, zone: &str, command: &str, timeout: Duration) -> Result<(Option<i32>, String)> {
        let out = self.run(&ssh_args(name, zone, command), timeout)?;
        let mut text = String::from_utf8_lossy(&out.stdout.bytes).into_owned();
        // gcloud's own notices (key creation, "Updating metadata") ride stderr; keep them only on failure.
        if !out.status.success() {
            text.push_str(&deploy::scrub_gcloud(&String::from_utf8_lossy(&out.stderr.bytes)));
        }
        Ok((out.status.code(), text))
    }
}

impl Sandbox for Gcloud {
    /// VMs run until stopped; the disk persists.
    fn info(&self) -> Info {
        Info { persistent: true, max_unattended_minutes: 24 * 60 }
    }
    fn list(&self) -> Result<Vec<Machine>> {
        let text = self.text(&strings(&["compute", "instances", "list", "--filter=labels.pandacode=true", "--format=json"]), Duration::from_secs(90))?;
        let items: Vec<Value> = serde_json::from_str(&text).map_err(|_| "Google Cloud returned an unreadable VM list.".to_string())?;
        Ok(items.iter().filter_map(machine).collect())
    }
    fn create(&self, name: &str) -> Result<Machine> {
        if !valid_name(name) {
            return Err("Google Cloud VM names use lowercase letters, digits and dashes, starting with a letter (up to 63).".into());
        }
        self.ensure_iap_firewall()?;
        let text = self.text(&create_args(name, &self.zone), Duration::from_secs(300))?;
        let created: Vec<Value> = serde_json::from_str(&text).map_err(|_| "Google Cloud created the VM but its reply was unreadable.".to_string())?;
        let machine = created.first().and_then(machine).ok_or("Google Cloud did not report the new VM.")?;
        self.wait_for_ssh(name, &self.zone)?;
        Ok(Machine { state: "running".into(), ..machine })
    }
    fn power(&self, native: &str, action: &str) -> Result<()> {
        let (name, zone) = split_native(native)?;
        let verb = match action { "start" | "stop" | "delete" => action, _ => return Err(format!("Google Cloud VMs can start, stop or be deleted, not {action}.")) };
        self.text(&power_args(verb, name, zone), Duration::from_secs(300))?;
        if verb == "start" {
            self.wait_for_ssh(name, zone)?;
        }
        Ok(())
    }
    fn exec(&self, native: &str, command: &str, timeout: Duration) -> Result<(Option<i32>, String)> {
        let (name, zone) = split_native(native)?;
        self.exec_in(name, zone, command, timeout + Duration::from_secs(30))
    }
    /// VMs keep running until stopped, so there is nothing to extend.
    fn keep_alive(&self, _native: &str, _minutes: u32) -> Result<()> {
        Ok(())
    }
}

pub fn sandbox() -> Result<Box<dyn Sandbox>> {
    Ok(Box::new(Gcloud::connected()?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn picks_the_zone_from_the_setting_then_the_region() {
        assert_eq!(zone_for(Some("europe-west1-b"), Some("us-east1")), "europe-west1-b");
        assert_eq!(zone_for(None, Some("europe-west4")), "europe-west4-a");
        assert_eq!(zone_for(Some(""), None), "us-central1-a");
    }

    #[test]
    fn builds_the_gcloud_commands() {
        let create = create_args("pc-ab12", "us-central1-a").join(" ");
        assert!(create.starts_with("compute instances create pc-ab12 --zone us-central1-a --machine-type e2-standard-2"));
        assert!(create.contains("--image-family debian-12") && create.contains("--labels pandacode=true"));
        let ssh = ssh_args("pc-ab12", "us-central1-a", "echo 'hi' && ls");
        assert!(ssh.contains(&"--tunnel-through-iap".to_string()) && !ssh.iter().any(|a| a.starts_with("--strict-host-key")));
        assert_eq!(ssh.last().unwrap(), r"sh -c 'echo '\''hi'\'' && ls'");
        assert!(firewall_args().join(" ").contains("--source-ranges 35.235.240.0/20"));
        assert!(power_args("delete", "pc-ab12", "z").contains(&"--delete-disks=all".to_string()));
        assert!(!power_args("stop", "pc-ab12", "z").iter().any(|a| a.starts_with("--delete")));
    }

    #[test]
    fn machine_ids_carry_the_zone_and_reject_junk() {
        assert_eq!(split_native("pc-ab12.us-central1-a").unwrap(), ("pc-ab12", "us-central1-a"));
        assert!(split_native("pc-ab12").is_err() && split_native("-x.z").is_err() && split_native("Bad.z").is_err());
        assert!(valid_name("pc-ab12") && !valid_name("1pc") && !valid_name("pc-"));
    }

    #[test]
    fn reads_the_instance_list() {
        let item = json!({"name":"pc-ab12","status":"TERMINATED","zone":"https://www.googleapis.com/compute/v1/projects/p/zones/europe-west1-b","machineType":".../machineTypes/e2-standard-2"});
        let machine = machine(&item).unwrap();
        assert_eq!((machine.id.as_str(), machine.state.as_str()), ("gcloud:pc-ab12.europe-west1-b", "stopped"));
        assert!(machine.detail.contains("e2-standard-2") && machine.detail.contains("europe-west1-b"));
        assert_eq!(state("PROVISIONING"), "starting");
    }
}
