//! Tart's command line: list, create, configure, start, stop, suspend, delete and exec.
//! Every call goes through the bounded process runner except `run`, which stays alive.
use serde::Deserialize;
use std::{
    io::{BufRead, BufReader},
    net::SocketAddr,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

use super::{
    backend::{Details, Exec, Started, Vm, VmBackend},
    Image,
};
use crate::workspace::{checked, run_process};

const QUICK: Duration = Duration::from_secs(60);
/// Pulling an image can take a long time on a slow connection.
const PULL: Duration = Duration::from_secs(3 * 60 * 60);
const BOOT: Duration = Duration::from_secs(90);
const EXEC_HINT: &str = "(local VM: admin, passwordless sudo). Files are separate from this Mac. Project shared at start is read-only: Linux /mnt/shared/project after `sudo mkdir -p /mnt/shared && sudo mount -t virtiofs com.apple.virtio-fs.automount /mnt/shared`; macOS /Volumes/My Shared Files/project; copy to change.";

/// Cirrus Labs images ship the Tart Guest Agent, so commands work without SSH.
pub const IMAGES: [Image; 5] = [
    Image { id: "ubuntu", name: "Ubuntu 24.04", os: "linux", source: "ghcr.io/cirruslabs/ubuntu:latest", download_gb: 5, memory_mb: 2048, cpus: 2 },
    Image { id: "debian", name: "Debian", os: "linux", source: "ghcr.io/cirruslabs/debian:latest", download_gb: 4, memory_mb: 2048, cpus: 2 },
    Image { id: "fedora", name: "Fedora", os: "linux", source: "ghcr.io/cirruslabs/fedora:latest", download_gb: 5, memory_mb: 2048, cpus: 2 },
    Image { id: "macos-tahoe", name: "macOS Tahoe", os: "darwin", source: "ghcr.io/cirruslabs/macos-tahoe-base:latest", download_gb: 30, memory_mb: 4096, cpus: 4 },
    Image { id: "macos-sequoia", name: "macOS Sequoia", os: "darwin", source: "ghcr.io/cirruslabs/macos-sequoia-base:latest", download_gb: 28, memory_mb: 4096, cpus: 4 },
];

pub struct Tart;

impl VmBackend for Tart {
    fn supported(&self) -> bool {
        cfg!(all(target_os = "macos", target_arch = "aarch64"))
    }
    fn installed(&self) -> bool {
        binary().is_some()
    }
    fn has_vms(&self) -> bool {
        let home = std::env::var_os("TART_HOME").map(PathBuf::from).or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".tart")));
        home.is_some_and(|home| holds_vms(&home))
    }
    fn engine(&self, installed: bool) -> &'static str {
        if !self.supported() { "Local VMs need an Apple silicon Mac" } else if installed { "Tart installed" } else { "Tart missing: ask the user to set up VMs in PandaCode's VM panel" }
    }
    fn exec_hint(&self) -> &'static str {
        EXEC_HINT
    }
    fn images(&self) -> &'static [Image] {
        &IMAGES
    }
    fn list(&self) -> Result<Vec<Vm>, String> {
        list()
    }
    fn details(&self, name: &str) -> Result<Details, String> {
        details(name)
    }
    fn create(&self, image: &Image, name: &str) -> Result<(), String> {
        clone(image.source, name)?;
        configure(name, image.memory_mb, image.cpus)
    }
    fn start(&self, name: &str, share: Option<&Path>) -> Result<Started, String> {
        let macos = details(name)?.os == "darwin";
        let mut child = spawn_run(&run_arguments(name, macos, share))?;
        let url = wait_for_vnc(&mut child, BOOT).inspect_err(|_| {
            let _ = child.kill();
        })?;
        let (password, address) = parse_vnc_url(&url)?;
        Ok(Started { child: Some(child), password, address, macos })
    }
    fn stop(&self, name: &str) -> Result<(), String> {
        stop(name)
    }
    fn can_suspend(&self, macos: bool) -> bool {
        macos
    }
    fn suspend(&self, name: &str) -> Result<(), String> {
        suspend(name)
    }
    fn delete(&self, name: &str) -> Result<(), String> {
        delete(name)
    }
    fn exec(&self, name: &str, macos: bool, script: &str, timeout: Duration) -> Result<Exec, String> {
        exec(name, macos, script, timeout)
    }
}

/// Whether a Tart home holds any local VM: one directory read, never a `tart` call.
fn holds_vms(tart_home: &Path) -> bool {
    std::fs::read_dir(tart_home.join("vms")).is_ok_and(|mut entries| entries.any(|e| e.is_ok_and(|e| e.path().is_dir())))
}

/// Parse Tart's `vnc://:password@127.0.0.1:port` into a password and a loopback address.
pub fn parse_vnc_url(url: &str) -> Result<(Option<String>, SocketAddr), String> {
    let rest = url.trim().strip_prefix("vnc://").ok_or("Not a VNC URL.")?;
    let (credentials, host) = rest.rsplit_once('@').map_or((None, rest), |(c, h)| (Some(c), h));
    let password = credentials.and_then(|c| c.split_once(':').map(|(_, p)| p.to_string())).filter(|p| !p.is_empty());
    let address: SocketAddr = host.trim_end_matches('/').parse().map_err(|_| "The VNC address is not host:port.")?;
    if !address.ip().is_loopback() {
        return Err("PandaCode only connects to VM screens on this Mac.".into());
    }
    Ok((password, address))
}

/// Tart from PATH, or the app bundle PandaCode's setup installs in ~/Applications.
pub fn binary() -> Option<PathBuf> {
    let bundles = ["Applications/tart.app/Contents/MacOS/tart"];
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .into_iter()
        .flat_map(|home| bundles.map(|bundle| home.join(bundle)))
        .chain([PathBuf::from("/Applications/tart.app/Contents/MacOS/tart")])
        .find(|path| path.is_file())
        .or_else(|| crate::token_saver::find_tool("tart"))
}
fn tart() -> Result<Command, String> {
    let path = binary().ok_or("Tart is not installed. Set up VMs from the VM panel first.")?;
    Ok(Command::new(path))
}
fn output(mut command: Command, timeout: Duration) -> Result<String, String> {
    command.env("TART_NO_AUTO_PRUNE", "1");
    let output = checked(run_process(command, "Tart", 1 << 20, timeout)?).map_err(|error| if error == "Git operation failed" { "Tart failed.".into() } else { error })?;
    Ok(String::from_utf8_lossy(&output.bytes).into_owned())
}

#[derive(Deserialize)]
struct Listed {
    #[serde(rename = "Name")]
    name: String,
    #[serde(rename = "Running")]
    running: bool,
    #[serde(rename = "Size", default)]
    size: u64,
    #[serde(rename = "Disk", default)]
    disk: u64,
    #[serde(rename = "Source")]
    source: String,
}
/// Local VMs only; pulled images (OCI entries) are a cache, not machines.
pub fn parse_list(json: &str) -> Result<Vec<Vm>, String> {
    let listed: Vec<Listed> = serde_json::from_str(json).map_err(|e| format!("Unexpected Tart list output: {e}"))?;
    Ok(listed.into_iter().filter(|vm| vm.source == "local").map(|vm| Vm { name: vm.name, running: vm.running, size_gb: vm.size, disk_gb: vm.disk }).collect())
}
pub fn list() -> Result<Vec<Vm>, String> {
    let mut command = tart()?;
    command.args(["list", "--format", "json"]);
    parse_list(&output(command, QUICK)?)
}

pub fn parse_details(json: &str) -> Result<Details, String> {
    let value: serde_json::Value = serde_json::from_str(json).map_err(|e| format!("Unexpected Tart output: {e}"))?;
    let (width, height) = value["Display"].as_str().and_then(|d| d.split_once('x')).map_or((1024, 768), |(w, h)| (w.parse().unwrap_or(1024), h.parse().unwrap_or(768)));
    Ok(Details {
        os: value["OS"].as_str().unwrap_or("linux").to_string(),
        memory_mb: value["Memory"].as_u64().unwrap_or(0),
        cpus: value["CPU"].as_u64().unwrap_or(0),
        width,
        height,
    })
}
pub fn details(name: &str) -> Result<Details, String> {
    let mut command = tart()?;
    command.args(["get", name, "--format", "json"]);
    parse_details(&output(command, QUICK)?)
}

pub fn clone(image: &str, name: &str) -> Result<(), String> {
    let mut command = tart()?;
    command.args(["clone", image, name]);
    output(command, PULL).map(|_| ())
}
pub fn configure(name: &str, memory_mb: u64, cpus: u64) -> Result<(), String> {
    let mut command = tart()?;
    command.args(["set", name, "--memory", &memory_mb.to_string(), "--cpu", &cpus.to_string()]);
    output(command, QUICK).map(|_| ())
}
pub fn stop(name: &str) -> Result<(), String> {
    let mut command = tart()?;
    command.args(["stop", name, "--timeout", "20"]);
    output(command, QUICK).map(|_| ())
}
/// macOS guests only: frees the VM's memory and resumes in seconds.
pub fn suspend(name: &str) -> Result<(), String> {
    let mut command = tart()?;
    command.args(["suspend", name]);
    output(command, QUICK).map(|_| ())
}
pub fn delete(name: &str) -> Result<(), String> {
    let mut command = tart()?;
    command.args(["delete", name]);
    output(command, QUICK).map(|_| ())
}

/// How a VM is started: headless, with the framework's own VNC server for its screen.
pub fn run_arguments(name: &str, macos: bool, share: Option<&Path>) -> Vec<String> {
    let mut args = vec!["run".to_string(), name.to_string(), "--no-graphics".into(), "--vnc-experimental".into()];
    if macos {
        args.push("--suspendable".into());
    }
    if let Some(path) = share {
        args.push(format!("--dir=project:{}:ro", path.display()));
    }
    args
}
pub fn spawn_run(args: &[String]) -> Result<Child, String> {
    let mut command = tart()?;
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut command, 0);
    command.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).env("TART_NO_AUTO_PRUNE", "1");
    command.spawn().map_err(|error| format!("Could not start the VM: {error}"))
}
/// Read `tart run` output until it prints the VNC URL; keep draining afterwards.
fn wait_for_vnc(child: &mut Child, timeout: Duration) -> Result<String, String> {
    let stdout = child.stdout.take().ok_or("The VM's output is unavailable.")?;
    let stderr = child.stderr.take().ok_or("The VM's output is unavailable.")?;
    let (tx, rx) = mpsc::channel::<String>();
    for reader in [Box::new(stdout) as Box<dyn std::io::Read + Send>, Box::new(stderr)] {
        let tx = tx.clone();
        thread::spawn(move || {
            for line in BufReader::new(reader).lines().map_while(Result::ok) {
                let _ = tx.send(line);
            }
        });
    }
    drop(tx);
    let deadline = Instant::now() + timeout;
    let mut last = String::new();
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        match rx.recv_timeout(left) {
            Ok(line) => {
                if let Some(start) = line.find("vnc://") {
                    return Ok(line[start..].split_whitespace().next().unwrap_or_default().to_string());
                }
                if !line.trim().is_empty() {
                    last = line;
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => return Err("The VM did not start within 90 seconds.".into()),
            Err(mpsc::RecvTimeoutError::Disconnected) => return Err(if last.is_empty() { "The VM stopped while starting.".into() } else { format!("The VM could not start: {last}") }),
        }
    }
}

/// Run a shell command in the guest through the Tart Guest Agent (no SSH needed).
pub fn exec(name: &str, macos: bool, script: &str, timeout: Duration) -> Result<Exec, String> {
    let mut command = tart()?;
    command.args(["exec", name, if macos { "/bin/zsh" } else { "/bin/bash" }, "-lc", script]);
    let out = run_process(command, "Tart", 256 * 1024, timeout)?;
    let stderr = String::from_utf8_lossy(&out.stderr.bytes).into_owned();
    if stderr.contains("guest agent") && !out.status.success() {
        return Err("This VM has no Tart Guest Agent, so commands cannot run in it. Use a Cirrus Labs base image.".into());
    }
    Ok(Exec { code: out.status.code(), stdout: String::from_utf8_lossy(&out.stdout.bytes).into_owned(), stderr, truncated: out.stdout.truncated || out.stderr.truncated })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_local_vms_and_skips_the_image_cache() {
        let json = r#"[{"State":"running","Name":"pandacode-ubuntu","Size":5,"Disk":20,"Running":true,"Source":"local"},{"State":"stopped","Name":"ghcr.io/cirruslabs/ubuntu:latest","Size":5,"Disk":20,"Running":false,"Source":"OCI"}]"#;
        assert_eq!(parse_list(json).unwrap(), vec![Vm { name: "pandacode-ubuntu".into(), running: true, size_gb: 5, disk_gb: 20 }]);
        assert!(parse_list("nope").is_err());
    }
    #[test]
    fn reads_os_memory_and_display() {
        let json = r#"{"Memory":2048,"CPU":2,"Display":"1024x768","Running":true,"OS":"linux"}"#;
        assert_eq!(parse_details(json).unwrap(), Details { os: "linux".into(), memory_mb: 2048, cpus: 2, width: 1024, height: 768 });
    }
    #[test]
    fn runs_headless_and_shares_the_project_read_only() {
        let args = run_arguments("vm", true, Some(std::path::Path::new("/p/app")));
        assert_eq!(&args[..4], ["run", "vm", "--no-graphics", "--vnc-experimental"]);
        assert!(args.contains(&"--suspendable".into()));
        assert!(args.contains(&"--dir=project:/p/app:ro".into()));
        let linux = run_arguments("vm", false, None);
        assert!(!linux.iter().any(|a| a.contains("suspend") || a.contains("--dir")));
    }
    #[test]
    fn parses_tarts_vnc_url_and_keeps_it_local() {
        let (password, address) = parse_vnc_url("vnc://:august-symptom-bulb-panda@127.0.0.1:64282").unwrap();
        assert_eq!(password.as_deref(), Some("august-symptom-bulb-panda"));
        assert_eq!(address.port(), 64282);
        assert_eq!(parse_vnc_url("vnc://127.0.0.1:5900").unwrap().0, None);
        assert!(parse_vnc_url("vnc://:x@10.0.0.2:5900").is_err());
        assert!(parse_vnc_url("http://127.0.0.1:1").is_err());
    }
    #[test]
    fn images_are_memory_conscious() {
        assert!(IMAGES.iter().filter(|i| i.os == "linux").all(|i| i.memory_mb <= 2048));
        assert!(IMAGES.iter().all(|i| i.source.starts_with("ghcr.io/cirruslabs/")));
        assert!(Tart.image("ubuntu").is_ok() && Tart.image("windows").is_err());
    }
    #[test]
    fn tools_need_a_local_vm_on_disk() {
        let home = std::env::temp_dir().join(format!("pandacode-tart-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(home.join("vms")).unwrap();
        assert!(!holds_vms(&home));
        std::fs::write(home.join("vms/stray"), "").unwrap();
        assert!(!holds_vms(&home), "a file is not a VM");
        std::fs::create_dir(home.join("vms/ubuntu")).unwrap();
        assert!(holds_vms(&home));
        assert!(!holds_vms(&home.join("missing")));
        let _ = std::fs::remove_dir_all(&home);
    }
    #[cfg(unix)]
    #[test]
    fn reads_the_vnc_url_from_tart_output() {
        let mut child = std::process::Command::new("/bin/sh")
            .args(["-c", "echo booting; echo 'VNC server is running at vnc://:pw@127.0.0.1:5901'; sleep 5"])
            .stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).spawn().unwrap();
        assert_eq!(wait_for_vnc(&mut child, Duration::from_secs(5)).unwrap(), "vnc://:pw@127.0.0.1:5901");
        let _ = child.kill();
        let mut failed = std::process::Command::new("/bin/sh").args(["-c", "echo 'Error: no such VM' >&2"])
            .stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).spawn().unwrap();
        assert_eq!(wait_for_vnc(&mut failed, Duration::from_secs(5)).unwrap_err(), "The VM could not start: Error: no such VM");
    }
}
