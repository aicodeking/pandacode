//! Lima's command line on Linux hosts: QEMU guests with KVM and a VNC screen, in a Lima home
//! PandaCode owns, so the user's own Lima VMs stay out of sight. A guest sees nothing of the
//! host unless a project is shared: no home mount, no keys, no forwarded ports or proxy.
//! Lima keeps a VM up on its own (a background hostagent), so VMs can outlive PandaCode.
mod host;
pub mod install;

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use std::{
    fs,
    net::{IpAddr, SocketAddr},
    path::{Path, PathBuf},
    process::Command,
    sync::OnceLock,
    time::{Duration, Instant},
};

use super::{
    backend::{Details, Exec, HostIssue, Started, Vm, VmBackend},
    Image,
};
use crate::workspace::run_process_with_input;

const QUICK: Duration = Duration::from_secs(60);
/// `limactl create` fetches the guest image into the VM's disk (cached for later VMs).
const PULL: Duration = Duration::from_secs(3 * 60 * 60);
/// `limactl start` returns once the guest is up; its first boot provisions the guest.
const BOOT: Duration = Duration::from_secs(20 * 60);
/// A graceful `limactl stop`; on quit it gets what is left before the deadline.
const STOP: Duration = Duration::from_secs(90);
/// The hostagent's pid file: a start that failed after it appeared launched the VM.
const HOSTAGENT: &str = "ha.pid";
/// The guest's `timeout` ends a command first; this one frees the app if the guest hangs.
const EXEC_GRACE: Duration = Duration::from_secs(15);
/// Limits this long or longer count a guest `timeout` at 90 % of the limit as timed out.
const LATE_FROM: Duration = Duration::from_secs(10);
const MOUNT_POINT: &str = "/mnt/project";
const SCREEN: (u32, u32) = (1280, 800);
const EXEC_HINT: &str = "(local VM: agent, passwordless sudo). Files are separate from this computer. Project shared at start is read-only at /mnt/project (Ubuntu and Fedora guests); copy to change.";
const LIST_TEXT: &str = "List local VMs (Linux guests) and cloud sandboxes (IDs like daytona:…): state, OS, screen, images and providers to create from. Other vm tools take name; default: the shown VM, else the only running one.";
const MANAGE_TEXT: &str = "create (local image: first download ~1 GB; desktop installs in background, commands work now), start, stop, suspend (cloud), delete, show in PandaCode, install_desktop (local). Idle local VMs stop after 10 min. Cloud costs money: confirm with the user before create/start.";
/// Lima's own settings a user's shell could change underneath PandaCode.
const CLEARED: [&str; 8] = ["LIMA_INSTANCE", "LIMA_SHELL", "LIMA_TEMPLATES_PATH", "LIMA_SHELLENV_ALLOW", "LIMA_SHELLENV_BLOCK", "SSH", "QEMU_SYSTEM_X86_64", "QEMU_SYSTEM_AARCH64"];
/// `sun_path` holds 107 characters; `ssh` adds a 17-character suffix to Lima's `ssh.sock`.
const SOCKET_ROOM: usize = 107 - "/".len() - "/ssh.sock".len() - 17;
/// Lima names the guest `lima-<name>`, and a host name holds 63 characters.
const HOSTNAME_ROOM: usize = 63 - "lima-".len();

/// Lima's stock templates, which pin their image URLs and digests per Lima release.
pub const IMAGES: [Image; 3] = [
    Image { id: "ubuntu", name: "Ubuntu 26.04", os: "linux", source: "template://ubuntu-lts", download_gb: 1, memory_mb: 2048, cpus: 2 },
    Image { id: "debian", name: "Debian 13", os: "linux", source: "template://debian", download_gb: 1, memory_mb: 2048, cpus: 2 },
    Image { id: "fedora", name: "Fedora 44", os: "linux", source: "template://fedora", download_gb: 1, memory_mb: 2048, cpus: 2 },
];

pub struct Lima;

impl VmBackend for Lima {
    fn id(&self) -> &'static str {
        "lima"
    }
    fn supported(&self) -> bool {
        cfg!(all(target_os = "linux", any(target_arch = "x86_64", target_arch = "aarch64")))
    }
    fn installed(&self) -> bool {
        binary().is_some()
    }
    fn install(&self) -> Result<PathBuf, String> {
        tauri::async_runtime::block_on(install::install())
    }
    fn host_issue(&self) -> Option<HostIssue> {
        host::issue()
    }
    fn has_vms(&self) -> bool {
        home().is_some_and(|home| holds_vms(&home))
    }
    fn engine(&self, installed: bool) -> &'static str {
        if !self.supported() { "Local VMs need a Linux computer on x86_64 or arm64" } else if installed { "Lima installed" } else { "Lima missing: ask the user to set up VMs in PandaCode's VM panel" }
    }
    fn exec_hint(&self) -> &'static str {
        EXEC_HINT
    }
    fn list_text(&self) -> &'static str {
        LIST_TEXT
    }
    fn manage_text(&self) -> &'static str {
        MANAGE_TEXT
    }
    fn images(&self) -> &'static [Image] {
        &IMAGES
    }
    fn list(&self) -> Result<Vec<Vm>, String> {
        Ok(listed()?.iter().map(Listed::vm).collect())
    }
    fn details(&self, name: &str) -> Result<Details, String> {
        Ok(instance(name)?.details())
    }
    fn list_details(&self) -> Result<Vec<(Vm, Option<Details>)>, String> {
        Ok(listed()?.iter().map(|vm| (vm.vm(), Some(vm.details()))).collect())
    }
    fn create(&self, image: &Image, name: &str) -> Result<(), String> {
        ready()?;
        let limit = name_limit(&home().ok_or("Your home folder is unknown.")?);
        if name.len() > limit {
            return Err(format!("VM names can be at most {limit} characters on this computer."));
        }
        // A failed or timed-out create leaves a half-made instance that would list as stopped.
        output(&create_arguments(image, name), PULL).map(|_| ()).inspect_err(|_| {
            if home().is_some_and(|home| home.join(name).exists()) {
                let _ = self.delete(name);
            }
        })
    }
    fn start(&self, name: &str, share: Option<&Path>) -> Result<Started, String> {
        ready()?;
        let guest = instance(name)?;
        if share.is_some() && guest.config.mount_types_unsupported.iter().any(|kind| kind == "9p") {
            return Err(format!("{name} cannot share a project: this guest image has no 9p, and Lima's other mount type would expose the host's files. Use an Ubuntu or Fedora VM, or copy the files in."));
        }
        output(&edit_arguments(name, share)?, QUICK)?;
        if let Err(error) = output(&start_arguments(name), BOOT) {
            // Only a boot this call launched is stopped; one that failed early never ran.
            if error == timed_out(BOOT) || guest.dir.join(HOSTAGENT).exists() {
                let _ = force_stop(name, QUICK);
            }
            return Err(error);
        }
        screen(&guest.dir)
    }
    fn adopt(&self, name: &str, share: Option<&Path>) -> Result<Option<Started>, String> {
        let guest = instance(name)?;
        if !same_share(&guest.config.mounts, share) {
            return Err(format!("{name} is already running with a different shared folder. Stop it, then start it again."));
        }
        screen(&guest.dir).map(Some)
    }
    fn stop(&self, name: &str) -> Result<(), String> {
        output(&["stop", "--tty=false", name].map(String::from), STOP).or_else(|_| force_stop(name, QUICK)).map(|_| ())
    }
    /// Graceful while it leaves the force stop 10 s. A VM still up is adopted on the next launch.
    fn stop_by(&self, name: &str, deadline: Instant) -> Result<(), String> {
        let left = || deadline.saturating_duration_since(Instant::now());
        let graceful = left().saturating_sub(Duration::from_secs(10)).min(STOP);
        if !graceful.is_zero() && output(&["stop", "--tty=false", name].map(String::from), graceful).is_ok() {
            return Ok(());
        }
        force_stop(name, left().max(Duration::from_secs(1))).map(|_| ())
    }
    fn can_suspend(&self, _: bool) -> bool {
        false
    }
    fn suspend(&self, _: &str) -> Result<(), String> {
        Err("Local Linux VMs cannot be suspended. Stop the VM instead.".into())
    }
    fn suspend_by(&self, name: &str, _: Instant) -> Result<(), String> {
        self.suspend(name)
    }
    fn delete(&self, name: &str) -> Result<(), String> {
        output(&["delete", "--tty=false", "--force", name].map(String::from), QUICK).map(|_| ())
    }
    fn exec(&self, name: &str, _: bool, script: &str, timeout: Duration) -> Result<Exec, String> {
        let nonce = uuid::Uuid::new_v4().simple().to_string();
        let mut command = limactl()?;
        command.args(exec_arguments(name, script, timeout, &nonce));
        let started = Instant::now();
        let out = run_process_with_input(command, "Lima", 256 * 1024, timeout + EXEC_GRACE, None)
            .map_err(|error| if error.contains("operation timed out") { format!("{name} did not finish within {}s.", timeout.as_secs()) } else { error })?;
        let ran = Ran {
            stdout: String::from_utf8_lossy(&out.stdout.bytes).into_owned(),
            stderr: String::from_utf8_lossy(&out.stderr.bytes).into_owned(),
            truncated: out.stdout.truncated || out.stderr.truncated,
            stderr_truncated: out.stderr.truncated,
            elapsed: started.elapsed(),
        };
        classify(name, &nonce, ran, timeout)
    }
}

/// `$XDG_DATA_HOME/pandacode`, else `~/.local/share/pandacode`.
pub fn data_dir() -> Option<PathBuf> {
    let xdg = std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).filter(|path| path.is_absolute());
    xdg.or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share"))).map(|dir| dir.join("pandacode"))
}
/// PandaCode's own `LIMA_HOME`, short enough for Lima's sockets.
fn home() -> Option<PathBuf> {
    data_dir().map(|dir| dir.join("lima"))
}
/// The longest VM name whose sockets fit under `home`.
fn name_limit(home: &Path) -> usize {
    SOCKET_ROOM.saturating_sub(home.as_os_str().len()).min(HOSTNAME_ROOM)
}
/// Whether a Lima home holds any VM; `_config` and the like are Lima's own.
fn holds_vms(home: &Path) -> bool {
    fs::read_dir(home).is_ok_and(|mut entries| entries.any(|e| e.is_ok_and(|e| e.path().is_dir() && !e.file_name().to_string_lossy().starts_with('_'))))
}

/// PandaCode's own Lima, else a recent enough one from PATH (checked once a run).
pub fn binary() -> Option<PathBuf> {
    static FOUND: OnceLock<Option<PathBuf>> = OnceLock::new();
    install::path().filter(|path| path.is_file()).or_else(|| FOUND.get_or_init(|| crate::token_saver::find_tool("limactl").filter(|path| install::recent_enough(path))).clone())
}
/// `limactl` under PATH and `/usr/bin/env`: the AppImage clean-up in `run_process` resets
/// PATH itself, and Lima must find the system's QEMU before anything else called `qemu-img`.
fn limactl() -> Result<Command, String> {
    let path = binary().ok_or("Lima is not installed. Set up VMs from the VM panel first.")?;
    let home = home().ok_or("Your home folder is unknown.")?;
    fs::create_dir_all(&home).map_err(|error| format!("Could not prepare {}: {error}", home.display()))?;
    let mut search: Vec<PathBuf> = host::SYSTEM_DIRS.iter().map(PathBuf::from).collect();
    search.extend(path.parent().map(Path::to_path_buf));
    let search = std::env::join_paths(search).map_err(|error| error.to_string())?;
    let mut command = Command::new("/usr/bin/env");
    command.arg({
        let mut value = std::ffi::OsString::from("PATH=");
        value.push(search);
        value
    });
    command.arg(path).env("LIMA_HOME", home);
    for name in CLEARED {
        command.env_remove(name);
    }
    Ok(command)
}
/// Lima logs `time=… level=fatal msg="…"`; the message is the part worth showing.
fn failure(stderr: &str) -> String {
    let lines = || stderr.lines().rev().filter(|line| !line.trim().is_empty());
    let line = lines().find(|line| line.contains("level=fatal") || line.contains("level=error")).or_else(|| lines().next()).unwrap_or("Lima failed.");
    let message = line.split_once("msg=\"").map_or(line, |(_, rest)| rest.rsplit_once('"').map_or(rest, |(message, _)| message));
    message.replace("\\\"", "\"").chars().take(400).collect()
}
/// `run_process`'s report of a Lima call it cut off at `limit`.
fn timed_out(limit: Duration) -> String {
    format!("Lima did not finish within {} minutes.", limit.as_secs().div_ceil(60))
}
fn output(args: &[String], timeout: Duration) -> Result<String, String> {
    let mut command = limactl()?;
    command.args(args);
    let out = run_process_with_input(command, "Lima", 1 << 20, timeout, None).map_err(|error| if error.contains("operation timed out") { timed_out(timeout) } else { error })?;
    if !out.status.success() {
        return Err(failure(&String::from_utf8_lossy(&out.stderr.bytes)));
    }
    Ok(String::from_utf8_lossy(&out.stdout.bytes).into_owned())
}
fn force_stop(name: &str, timeout: Duration) -> Result<String, String> {
    output(&["stop", "--tty=false", "--force", name].map(String::from), timeout)
}
/// A missing piece on the host stops here, so nothing ever falls back to slow emulation.
fn ready() -> Result<(), String> {
    host::issue().map_or(Ok(()), |issue| Err(issue.text))
}

#[derive(Deserialize)]
struct Listed {
    name: String,
    status: String,
    #[serde(default)]
    cpus: u64,
    #[serde(default)]
    memory: u64,
    #[serde(default)]
    disk: u64,
    #[serde(default)]
    dir: PathBuf,
    #[serde(default)]
    config: Config,
}
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Config {
    #[serde(default)]
    mounts: Vec<Mount>,
    #[serde(default)]
    mount_types_unsupported: Vec<String>,
}
#[derive(Deserialize)]
struct Mount {
    location: PathBuf,
}
impl Listed {
    fn vm(&self) -> Vm {
        Vm { name: self.name.clone(), running: self.status == "Running", size_gb: disk_used(&self.dir).div_ceil(1 << 30), disk_gb: self.disk >> 30 }
    }
    fn details(&self) -> Details {
        Details { os: "linux".into(), memory_mb: self.memory >> 20, cpus: self.cpus, width: SCREEN.0, height: SCREEN.1 }
    }
}
/// What the instance's sparse disks really take.
#[cfg(unix)]
fn disk_used(dir: &Path) -> u64 {
    use std::os::unix::fs::MetadataExt;
    fs::read_dir(dir).map_or(0, |entries| entries.flatten().filter_map(|entry| entry.metadata().ok()).filter(|meta| meta.is_file()).map(|meta| meta.blocks() * 512).sum())
}
#[cfg(not(unix))]
fn disk_used(_: &Path) -> u64 {
    0
}
/// `limactl list --json` prints one object per line (nothing at all with no VMs).
fn parse_list(json: &str) -> Result<Vec<Listed>, String> {
    serde_json::Deserializer::from_str(json).into_iter().collect::<Result<_, _>>().map_err(|error| format!("Unexpected Lima list output: {error}"))
}
fn listed() -> Result<Vec<Listed>, String> {
    parse_list(&output(&["list".into(), "--json".into()], QUICK)?)
}
fn instance(name: &str) -> Result<Listed, String> {
    listed()?.into_iter().find(|vm| vm.name == name).ok_or_else(|| format!("No VM named {name}."))
}

/// Everything an agent's VM may not get from Lima's defaults: mounts stay empty until `start`,
/// and no setting of the host's reaches the guest: keys, agent, X11, proxy variables, port
/// forwards, user name or comment, or time zone.
fn settings(image: &Image) -> String {
    let memory = image.memory_mb;
    let cpus = image.cpus;
    [
        ".vmType=\"qemu\"".to_string(),
        ".mounts=[]".into(),
        ".ssh.loadDotSSHPubKeys=false".into(),
        ".ssh.forwardAgent=false".into(),
        ".ssh.forwardX11=false".into(),
        ".ssh.forwardX11Trusted=false".into(),
        ".containerd.system=false".into(),
        ".containerd.user=false".into(),
        ".propagateProxyEnv=false".into(),
        ".timezone=\"UTC\"".into(),
        ".portForwards=[{\"guestIP\":\"0.0.0.0\",\"guestIPMustBeZero\":false,\"proto\":\"any\",\"ignore\":true}]".into(),
        ".user.name=\"agent\"".into(),
        ".user.comment=\"PandaCode\"".into(),
        ".user.home=\"/home/agent\"".into(),
        ".video.display=\"vnc\"".into(),
        format!(".memory=\"{memory}MiB\""),
        format!(".cpus={cpus}"),
    ]
    .join(" | ")
}
fn create_arguments(image: &Image, name: &str) -> Vec<String> {
    ["create", "--tty=false", &format!("--name={name}"), &format!("--set={}", settings(image)), image.source].map(String::from).to_vec()
}
/// The share as a yq assignment. JSON strings are valid yq literals, so any path survives;
/// Lima expands `{{…}}` in a location, which could point a mount anywhere else. The type is
/// always 9p: Lima's fallback, reverse-sshfs, serves SFTP unjailed to the shared folder, so
/// root in the guest could read the whole host.
fn mounts(share: Option<&Path>) -> Result<String, String> {
    let Some(path) = share else { return Ok(".mounts=[]".into()) };
    let location = path.to_str().ok_or("This folder's name cannot be shared.")?;
    if location.contains("{{") {
        return Err("A folder with {{ in its path cannot be shared.".into());
    }
    // QEMU reads the path inside `-virtfs …,path=<location>,…`, where a comma starts an option.
    if location.contains(',') || location.chars().any(char::is_control) {
        return Err("A folder with a comma or a control character in its path cannot be shared. Rename it or copy the files in.".into());
    }
    let mount = serde_json::json!([{ "location": location, "mountPoint": MOUNT_POINT, "writable": false }]);
    Ok(format!(".mountType=\"9p\" | .mounts={mount}"))
}
fn edit_arguments(name: &str, share: Option<&Path>) -> Result<Vec<String>, String> {
    Ok(["edit", "--tty=false", &format!("--set={}", mounts(share)?), name].map(String::from).to_vec())
}
fn start_arguments(name: &str) -> Vec<String> {
    ["start", "--tty=false", "--timeout=15m", name].map(String::from).to_vec()
}
fn same_share(mounts: &[Mount], share: Option<&Path>) -> bool {
    match (mounts, share) {
        ([], None) => true,
        ([mount], Some(path)) => mount.location == path,
        _ => false,
    }
}

/// QEMU's `vncdisplay` file: `127.0.0.1:0`, a display number on 5900.
fn parse_display(text: &str) -> Result<SocketAddr, String> {
    let (host, display) = text.trim().rsplit_once(':').ok_or("The VM's screen address is not host:display.")?;
    let ip: IpAddr = host.parse().map_err(|_| "The VM's screen address is not host:display.")?;
    let port = display.parse::<u16>().ok().and_then(|display| display.checked_add(5900)).ok_or("The VM's screen address is not host:display.")?;
    if !ip.is_loopback() {
        return Err("PandaCode only connects to VM screens on this computer.".into());
    }
    Ok(SocketAddr::new(ip, port))
}
/// A booted VM's screen, from the files Lima leaves in its instance folder.
fn screen(dir: &Path) -> Result<Started, String> {
    let read = |file: &str| fs::read_to_string(dir.join(file)).map_err(|error| format!("Could not read the VM's {file}: {error}"));
    let address = parse_display(&read("vncdisplay")?)?;
    let password = Some(read("vncpassword")?.trim().to_string()).filter(|password| !password.is_empty());
    Ok(Started { child: None, password, address, macos: false })
}

/// `limactl shell` quotes each argument, then a shell runs them. The script travels as base64
/// so no layer ever reads it, and the guest's `timeout` kills it there: stopping the local
/// `limactl` alone would leave it running. The guest then writes `PANDACODE-<nonce>:<code>`
/// on stderr, so an exit code the guest never wrote is Lima's or SSH's own.
fn exec_arguments(name: &str, script: &str, timeout: Duration, nonce: &str) -> Vec<String> {
    let run = format!("eval \"$(echo {} | base64 -d)\"", STANDARD.encode(script));
    let wrap = format!("timeout -k 5 \"$1\" bash -lc \"$2\"; c=$?; echo \"PANDACODE-{nonce}:$c\" >&2; exit $c");
    ["shell", "--tty=false", "--workdir", "/", name, "--", "sh", "-c", &wrap, "sh", &timeout.as_secs().max(1).to_string(), &run].map(String::from).to_vec()
}
/// What came back from `limactl shell`.
struct Ran {
    stdout: String,
    stderr: String,
    truncated: bool,
    /// The marker comes last, so a cut-off stderr lost it and any marker left was printed by the command.
    stderr_truncated: bool,
    elapsed: Duration,
}
/// The guest's result, its exit marker removed. Without the marker the guest never finished
/// the command (SSH failed, the guest rebooted). More than one marker means the command printed
/// the nonce itself (it can read its own command line), and a cut-off stderr lost the real one,
/// so both results are refused rather than guessed. Only the guest's `timeout` (124, or 137 after
/// `-k`) at the limit counts as a timeout. A freshly booted guest's clock runs ahead (its
/// `timeout` fired at 1.93 s of a 2 s limit), so from `LATE_FROM` on 90 % of the limit counts;
/// a shorter limit must pass in full, so a quick 124 stays an exit code.
fn classify(name: &str, nonce: &str, ran: Ran, timeout: Duration) -> Result<Exec, String> {
    let Ran { stdout, mut stderr, truncated, stderr_truncated, elapsed } = ran;
    if stderr_truncated {
        return Err(format!("{name} ran the command, but its result could not be trusted: its error output passed 256 KiB and was cut off before PandaCode's exit marker. Send less to stderr (for example redirect it to a file)."));
    }
    let marker = format!("PANDACODE-{nonce}:");
    if stderr.matches(&marker).nth(1).is_some() {
        return Err(format!("{name} ran the command, but its output could not be trusted: it repeated PandaCode's exit marker."));
    }
    let guest = match stderr.rfind(&marker) {
        Some(at) => {
            let rest = &stderr[at + marker.len()..];
            let end = rest.find('\n').map_or(rest.len(), |line| line + 1);
            let guest = rest[..end].trim().parse::<i32>().ok();
            stderr.replace_range(at..at + marker.len() + end, "");
            guest
        }
        None => return Err(format!("{name} did not answer: {}", failure(&stderr))),
    };
    let limit = if timeout >= LATE_FROM { timeout * 9 / 10 } else { timeout };
    let timed_out = matches!(guest, Some(124 | 137)) && elapsed >= limit;
    Ok(Exec { code: guest.filter(|_| !timed_out), timed_out, stdout, stderr, truncated })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Recorded from `limactl list --json` (Lima 2.2.1), trimmed to what is read plus neighbours.
    const LISTED: &str = r#"{"name":"pc","hostname":"lima-pc","status":"Running","dir":"/data/lima/pc","vmType":"qemu","arch":"x86_64","cpus":2,"memory":2147483648,"disk":107374182400,"sshLocalPort":40413,"config":{"vmType":"qemu","mounts":[{"location":"/home/me/app","mountPoint":"/mnt/project","writable":false,"9p":{"securityModel":"none"}}],"mountType":"9p"}}
{"name":"t1","hostname":"lima-t1","status":"Stopped","dir":"/data/lima/t1","vmType":"qemu","arch":"x86_64","cpus":4,"memory":4294967296,"disk":107374182400,"config":{"mounts":[],"mountTypesUnsupported":["9p"]}}
"#;

    #[test]
    fn lists_line_delimited_instances() {
        let vms = parse_list(LISTED).unwrap();
        assert_eq!(vms.iter().map(Listed::vm).collect::<Vec<_>>(), vec![
            Vm { name: "pc".into(), running: true, size_gb: 0, disk_gb: 100 },
            Vm { name: "t1".into(), running: false, size_gb: 0, disk_gb: 100 },
        ]);
        assert_eq!((vms[0].cpus, vms[0].memory >> 20), (2, 2048));
        assert_eq!(vms[1].config.mount_types_unsupported, ["9p"]);
        assert!(parse_list("").unwrap().is_empty());
        assert!(parse_list("nope").is_err());
    }
    #[test]
    fn a_vm_gets_nothing_from_the_host_by_default() {
        let image = Lima.image("ubuntu").unwrap();
        assert_eq!(settings(&image), concat!(
            r#".vmType="qemu" | .mounts=[]"#,
            r#" | .ssh.loadDotSSHPubKeys=false | .ssh.forwardAgent=false | .ssh.forwardX11=false | .ssh.forwardX11Trusted=false"#,
            r#" | .containerd.system=false | .containerd.user=false | .propagateProxyEnv=false | .timezone="UTC""#,
            r#" | .portForwards=[{"guestIP":"0.0.0.0","guestIPMustBeZero":false,"proto":"any","ignore":true}]"#,
            r#" | .user.name="agent" | .user.comment="PandaCode" | .user.home="/home/agent""#,
            r#" | .video.display="vnc" | .memory="2048MiB" | .cpus=2"#,
        ));
        let args = create_arguments(&image, "pc");
        assert_eq!(&args[..3], ["create", "--tty=false", "--name=pc"]);
        assert_eq!(args[4], "template://ubuntu-lts");
    }
    #[test]
    fn shares_read_only_or_not_at_all() {
        assert_eq!(mounts(None).unwrap(), ".mounts=[]");
        let shared = mounts(Some(Path::new("/p/it's a \"dir\" $x"))).unwrap();
        let json = shared.strip_prefix(".mountType=\"9p\" | .mounts=").unwrap();
        let value: serde_json::Value = serde_json::from_str(json).unwrap();
        assert_eq!(value, serde_json::json!([{ "location": "/p/it's a \"dir\" $x", "mountPoint": "/mnt/project", "writable": false }]));
        assert!(mounts(Some(Path::new("/p/{{.Home}}"))).is_err());
        // A comma would add QEMU -virtfs options: the last `path=` wins.
        for path in ["/p/x,path=/home/u/.ssh", "/p/a,b", "/p/line\nbreak", "/p/tab\there", "/p/\u{7f}"] {
            assert!(mounts(Some(Path::new(path))).unwrap_err().contains("comma or a control character"), "{path:?}");
        }
        assert!(edit_arguments("pc", Some(Path::new("/p/x,path=/etc"))).is_err());
        assert_eq!(edit_arguments("pc", None).unwrap(), ["edit", "--tty=false", "--set=.mounts=[]", "pc"]);
    }
    #[test]
    fn a_running_vm_is_only_adopted_with_the_share_it_has() {
        let shared = [Mount { location: "/p/app".into() }];
        assert!(same_share(&[], None) && same_share(&shared, Some(Path::new("/p/app"))));
        assert!(!same_share(&shared, None) && !same_share(&[], Some(Path::new("/p/app"))) && !same_share(&shared, Some(Path::new("/p/other"))));
    }
    #[test]
    fn exec_carries_any_script_as_base64_and_bounds_it_in_the_guest() {
        let script = "printf '%s\\n' \"$HOME\" 'it''s'\necho `id` $((6*7))\n";
        let args = exec_arguments("pc", script, Duration::from_secs(30), "n0nce");
        assert_eq!(&args[..8], ["shell", "--tty=false", "--workdir", "/", "pc", "--", "sh", "-c"]);
        assert_eq!(args[8], r#"timeout -k 5 "$1" bash -lc "$2"; c=$?; echo "PANDACODE-n0nce:$c" >&2; exit $c"#);
        assert_eq!(&args[9..11], ["sh", "30"]);
        let run = args[11].strip_prefix("eval \"$(echo ").unwrap().strip_suffix(" | base64 -d)\"").unwrap();
        assert!(run.bytes().all(|b| b.is_ascii_alphanumeric() || b"+/=".contains(&b)));
        assert_eq!(STANDARD.decode(run).unwrap(), script.as_bytes());
    }
    #[test]
    fn only_the_guests_own_exit_marker_makes_a_result() {
        let limit = Duration::from_secs(30);
        let ran = |_exit: i32, stdout: &str, stderr: &str, secs: u64| Ran { stdout: stdout.into(), stderr: stderr.into(), truncated: false, stderr_truncated: false, elapsed: Duration::from_secs(secs) };
        let run = |ran: Ran| classify("pc", "abc", ran, limit);
        // A guest program's logrus line is its own output, not Lima's.
        let out = run(ran(1, "out\n", "time=x level=fatal msg=y\nPANDACODE-abc:1\n", 1)).unwrap();
        assert_eq!((out.code, out.timed_out, out.stdout.as_str(), out.stderr.as_str()), (Some(1), false, "out\n", "time=x level=fatal msg=y\n"));
        // 124 and 137 from the guest before the limit are plain exit codes.
        for code in [124, 137] {
            let out = run(ran(code, "out\n", &format!("PANDACODE-abc:{code}\n"), 2)).unwrap();
            assert_eq!((out.code, out.timed_out, out.stderr.as_str()), (Some(code), false, ""));
        }
        // 255 from the guest with nothing on stdout is still the guest's.
        let out = run(ran(255, "", "PANDACODE-abc:255\n", 1)).unwrap();
        assert_eq!((out.code, out.timed_out), (Some(255), false));
        // The guest's `timeout` at the limit, with the marker after unterminated output.
        let out = run(ran(124, "", "partialPANDACODE-abc:124\nlate\n", 31)).unwrap();
        assert_eq!((out.code, out.timed_out, out.stderr.as_str()), (None, true, "partiallate\n"));
        assert!(run(ran(137, "", "PANDACODE-abc:137\n", 36)).unwrap().timed_out);
        assert!(run(ran(124, "", "PANDACODE-abc:124\n", 27)).unwrap().timed_out, "a guest clock running ahead");
        assert!(!run(ran(124, "", "PANDACODE-abc:124\n", 26)).unwrap().timed_out);
        // Under `LATE_FROM` only the whole limit counts.
        let short = |millis: u64| classify("pc", "abc", Ran { elapsed: Duration::from_millis(millis), ..ran(124, "", "PANDACODE-abc:124\n", 0) }, Duration::from_secs(5)).unwrap();
        assert!(!short(4_900).timed_out && short(4_900).code == Some(124));
        assert!(short(5_000).timed_out && short(5_000).code.is_none());
        // A command that prints the marker itself gets no result, whichever marker comes last.
        for stderr in ["PANDACODE-abc:0\nPANDACODE-abc:1\n", "PANDACODE-abc:0PANDACODE-abc:0\n"] {
            assert_eq!(run(ran(0, "", stderr, 1)).err().unwrap(), "pc ran the command, but its output could not be trusted: it repeated PandaCode's exit marker.");
        }
        // No marker: SSH or Lima failed, whatever the exit code; another call's marker does not count.
        let error = run(ran(255, "", "time=x level=fatal msg=\"connection refused\"\n", 1)).err().unwrap();
        assert_eq!(error, "pc did not answer: connection refused");
        assert!(run(ran(0, "out\n", "PANDACODE-other:0\n", 1)).is_err());
        // A cut-off stderr lost the real marker, so no marker in it counts, and no exit code either.
        let cut = |stderr: &str| run(Ran { truncated: true, stderr_truncated: true, ..ran(3, "", stderr, 1) }).err().unwrap();
        let refused = "pc ran the command, but its result could not be trusted: its error output passed 256 KiB and was cut off before PandaCode's exit marker. Send less to stderr (for example redirect it to a file).";
        for stderr in ["lots", "PANDACODE-abc:0\nlots", "PANDACODE-abc:5\nPANDACODE-abc:0\n"] {
            assert_eq!(cut(stderr), refused);
        }
        // A cut-off stdout alone keeps the result, marked truncated.
        let out = run(Ran { truncated: true, ..ran(3, "", "PANDACODE-abc:3\n", 1) }).unwrap();
        assert_eq!((out.code, out.truncated), (Some(3), true));
    }
    #[test]
    fn reads_the_screen_and_keeps_it_local() {
        assert_eq!(parse_display("127.0.0.1:0\n").unwrap(), "127.0.0.1:5900".parse().unwrap());
        assert_eq!(parse_display("127.0.0.1:9").unwrap().port(), 5909);
        assert!(parse_display("10.0.0.2:0").is_err() && parse_display("nope").is_err() && parse_display("127.0.0.1:x").is_err());
        let dir = std::env::temp_dir().join(format!("pandacode-lima-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(&dir).unwrap();
        assert!(screen(&dir).is_err());
        fs::write(dir.join("vncdisplay"), "127.0.0.1:3\n").unwrap();
        fs::write(dir.join("vncpassword"), "abcd1234").unwrap();
        let started = screen(&dir).unwrap();
        assert_eq!((started.address.port(), started.password.as_deref(), started.macos), (5903, Some("abcd1234"), false));
        assert!(started.child.is_none());
        let _ = fs::remove_dir_all(&dir);
    }
    #[test]
    fn names_fit_lima_sockets_and_the_home_holds_only_its_vms() {
        assert_eq!(name_limit(Path::new("/home/me/.local/share/pandacode/lima")), 44);
        assert_eq!(name_limit(Path::new("/h")), 58);
        assert_eq!(name_limit(Path::new(&"/x".repeat(60))), 0);
        let home = std::env::temp_dir().join(format!("pandacode-lima-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(home.join("_config")).unwrap();
        fs::write(home.join("stray"), "").unwrap();
        assert!(!holds_vms(&home));
        fs::create_dir(home.join("pc")).unwrap();
        assert!(holds_vms(&home));
        assert!(!holds_vms(&home.join("missing")));
        let _ = fs::remove_dir_all(&home);
    }
    #[test]
    fn shows_limas_own_message() {
        assert_eq!(failure("time=\"x\" level=info msg=\"Starting\"\ntime=\"x\" level=fatal msg=\"instance \\\"pc\\\" not found\"\n"), "instance \"pc\" not found");
        assert_eq!(failure("plain\n\n"), "plain");
        assert_eq!(failure(""), "Lima failed.");
    }
    #[test]
    fn images_match_tart_ids_and_use_lima_templates() {
        assert_eq!(IMAGES.map(|image| image.id), ["ubuntu", "debian", "fedora"]);
        assert!(IMAGES.iter().all(|image| image.source.starts_with("template://") && image.memory_mb == 2048 && image.cpus == 2 && image.os == "linux"));
        assert!(Lima.image("macos-tahoe").is_err());
    }
    #[test]
    fn linux_tool_text_never_mentions_a_mac() {
        for text in [LIST_TEXT, MANAGE_TEXT, EXEC_HINT, Lima.engine(true), Lima.engine(false)] {
            assert!(!text.contains("macOS") && !text.contains("Mac") && !text.contains("Apple"), "{text}");
        }
    }
    /// The longest name allowed here still gets working sockets: `cargo test --lib -- --ignored vm::lima::tests::longest`
    #[test]
    #[ignore]
    fn longest_name_boots() {
        use crate::vm::Vms;
        let limit = name_limit(&home().unwrap());
        let name = format!("pc{}", "x".repeat(limit - 2));
        assert!(Lima.create(&Lima.image("ubuntu").unwrap(), &format!("{name}x")).unwrap_err().contains(&limit.to_string()));
        let vms = Vms::default();
        vms.create("ubuntu", &name).unwrap();
        vms.start(&name, None).unwrap();
        let out = Lima.exec(&name, false, "echo ok", Duration::from_secs(30)).unwrap();
        vms.delete(&name).unwrap();
        assert_eq!(out.stdout, "ok\n");
    }
    /// Lima-only checks on a VM of its own: `cargo test --lib -- --ignored vm::lima::tests::live --nocapture`.
    /// `PANDACODE_IMAGE` picks the image.
    #[test]
    #[ignore]
    fn live_keeps_the_host_out_and_reattaches() {
        use crate::vm::Vms;
        let name = "pandacode-lima-check";
        let run = |script: &str| Lima.exec(name, false, script, Duration::from_secs(60)).unwrap();
        let vms = Vms::default();
        let _ = vms.delete(name);
        let image = std::env::var("PANDACODE_IMAGE").unwrap_or_else(|_| "ubuntu".into());
        vms.create(&image, name).unwrap();
        vms.start(name, None).unwrap();
        // Scripts survive every layer: quotes, newlines, `$` and the exit code.
        let tricky = "x='a \"b\" $HOME'\nprintf '%s\\n' \"$x\" \"it's\" `echo $((6*7))`\nexit 7\n";
        let out = run(tricky);
        assert_eq!((out.code, out.stdout.as_str()), (Some(7), "a \"b\" $HOME\nit's\n42\n"), "{}", out.stderr);
        let script = "set -eu\nprintf '%s' \"$(id -un)\"\n";
        assert_eq!(run(script).stdout, "agent");
        // The guest's `timeout` ends a runaway command there, and the tool reports a timeout.
        let out = Lima.exec(name, false, "sleep 300; echo late", Duration::from_secs(2)).unwrap();
        assert!(out.code.is_none() && out.timed_out, "{:?} {} {:?} {:?}", out.code, out.timed_out, out.stdout, out.stderr);
        assert_eq!(run("pgrep -c -x sleep || true").stdout.trim(), "0");
        // Nothing of the host: no home, no mounts, no real name.
        let host_home = std::env::var("HOME").unwrap();
        let out = run(&format!("mount; ls -d '{host_home}' /mnt/project 2>&1 | wc -l; getent passwd agent; ls -a ~/.ssh; env"));
        assert!(!out.stdout.contains(&host_home), "{}", out.stdout);
        assert!(!out.stdout.contains(" 9p ") && out.stdout.contains("agent:x:") && out.stdout.contains(":PandaCode:"), "{}", out.stdout);
        assert_eq!(run(&format!("test -e '{host_home}' -o -e /mnt/project; echo $?")).stdout, "1\n");
        // A guest port stays in the guest.
        run("nohup python3 -m http.server --bind 127.0.0.1 18765 >/dev/null 2>&1 &\nnohup python3 -m http.server --bind 0.0.0.0 18766 >/dev/null 2>&1 &");
        std::thread::sleep(Duration::from_secs(5));
        assert_eq!(run("ss -tln | grep -c 1876").stdout, "2\n", "both guest servers listen");
        for port in ["127.0.0.1:18765", "127.0.0.1:18766"] {
            assert!(std::net::TcpStream::connect_timeout(&port.parse().unwrap(), Duration::from_secs(1)).is_err(), "guest port {port} reached the host");
        }
        // Dropping the manager leaves the VM up; a new one adopts it and keeps its screen.
        drop(vms);
        let vms = Vms::default();
        assert!(!vms.attached(name));
        vms.start(name, None).unwrap();
        assert!(vms.attached(name));
        let shot = vms.with_screen(name, true, |rfb| crate::vm::screen::screenshot(rfb, 70)).unwrap();
        assert!(shot.width >= 640);
        assert!(vms.start(name, None).is_ok(), "attached with the same share is a no-op");
        assert!(vms.start(name, Some(Path::new("/tmp"))).unwrap_err().contains("different shared folder"));
        drop(vms);
        let vms = Vms::default();
        assert!(vms.start(name, Some(Path::new("/tmp"))).unwrap_err().contains("different shared folder"));
        vms.stop(name).unwrap();
        if image == "debian" {
            // Its kernel has no 9p, and the fallback would show the guest the whole host.
            assert!(vms.start(name, Some(Path::new("/tmp"))).unwrap_err().contains("no 9p"));
            vms.delete(name).unwrap();
            return;
        }
        // A share is read-only, even for root remounting it, and gone on the next plain start.
        let share = std::env::temp_dir().join(format!("pandacode-share-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(&share).unwrap();
        fs::write(share.join("hello.txt"), "from the host").unwrap();
        vms.start(name, Some(&share)).unwrap();
        assert_eq!(run("cat /mnt/project/hello.txt").stdout, "from the host");
        let out = run("touch /mnt/project/x; echo $?; sudo touch /mnt/project/y; echo $?; sudo mount -o remount,rw /mnt/project; sudo touch /mnt/project/z; echo $?; findmnt -no FSTYPE /mnt/project");
        assert_eq!(out.stdout.lines().filter(|line| *line == "0").count(), 0, "{}\n{}", out.stdout, out.stderr);
        assert!(out.stdout.contains("9p"), "{}", out.stdout);
        assert_eq!(fs::read_dir(&share).unwrap().count(), 1, "the guest wrote to the share");
        vms.stop(name).unwrap();
        vms.start(name, None).unwrap();
        assert_eq!(run("test -e /mnt/project/hello.txt; echo $?").stdout, "1\n");
        vms.delete(name).unwrap();
        let _ = fs::remove_dir_all(&share);
    }
    /// The review's checks on a VM of its own: `cargo test --lib -- --ignored vm::lima::tests::live_review --nocapture`.
    #[test]
    #[ignore]
    fn live_review_starts_once_classifies_exec_and_keeps_frames_quick() {
        use crate::vm::Vms;
        use std::time::Instant;
        let name = "pandacode-review";
        let vms = Vms::default();
        let _ = vms.delete(name);
        vms.create("ubuntu", name).unwrap();
        let dir = instance(name).unwrap().dir;
        // Lima 2.2.1 downloads the image at create, so a first start needs no download time.
        assert!(dir.join("disk").exists(), "create made the disk");
        // Two starts at once: one boots, the other refuses and stops nothing.
        let started = Instant::now();
        let results = std::thread::scope(|scope| {
            let first = scope.spawn(|| vms.start(name, None));
            std::thread::sleep(Duration::from_millis(200));
            let second = vms.start(name, None);
            (first.join().unwrap(), second)
        });
        eprintln!("first start {:?}: {results:?}", started.elapsed());
        assert!(results.0.is_ok() && results.1.as_ref().unwrap_err() == &format!("{name} is already starting."));
        assert!(Lima.list().unwrap().iter().any(|vm| vm.name == name && vm.running));
        assert!(vms.attached(name));
        // A guest exit of 137 with a logrus line is the guest's own result.
        let out = Lima.exec(name, false, "echo out; echo 'time=x level=fatal msg=y' >&2; exit 137", Duration::from_secs(60)).unwrap();
        eprintln!("exit 137: {:?} {:?} {:?} {}", out.code, out.stdout, out.stderr, out.timed_out);
        assert_eq!((out.code, out.stdout.as_str(), out.stderr.as_str(), out.timed_out), (Some(137), "out\n", "time=x level=fatal msg=y\n", false));
        let out = Lima.exec(name, false, "exit 255", Duration::from_secs(60)).unwrap();
        assert_eq!(out.code, Some(255));
        // A real timeout.
        let started = Instant::now();
        let out = Lima.exec(name, false, "sleep 60", Duration::from_secs(3)).unwrap();
        eprintln!("timeout after {:?}: {:?} {}", started.elapsed(), out.code, out.timed_out);
        assert!(out.timed_out && out.code.is_none());
        // A comma in a share path is refused before Lima sees it.
        vms.stop(name).unwrap();
        let comma = std::env::temp_dir().join("pandacode-a,path=etc");
        fs::create_dir_all(&comma).unwrap();
        let error = vms.start(name, Some(&comma)).unwrap_err();
        eprintln!("comma share: {error}");
        assert!(error.contains("comma"));
        let _ = fs::remove_dir(&comma);
        vms.start(name, None).unwrap();
        // A still console (no blinking cursor), polled like the panel for a minute, then changes.
        Lima.exec(name, false, "sudo sh -c 'echo 0 > /sys/class/graphics/fbcon/cursor_blink; setterm --cursor off > /dev/tty1; clear > /dev/tty1'", Duration::from_secs(30)).unwrap();
        let capture = || {
            let started = Instant::now();
            let frame = vms.with_screen(name, false, |rfb| rfb.capture()).unwrap();
            (started.elapsed(), frame)
        };
        let (_, mut last) = capture();
        let idle = Instant::now();
        let (mut polls, mut slow) = (0, Duration::ZERO);
        while idle.elapsed() < Duration::from_secs(60) {
            let (took, frame) = capture();
            polls += 1;
            slow = slow.max(took);
            last = frame;
            std::thread::sleep(Duration::from_millis(220));
        }
        eprintln!("{polls} still polls, slowest {slow:?}");
        // QEMU's refresh slows to 3 s when idle, so poll until a change shows; time the capture that got it.
        let mut changed = Vec::new();
        for i in 0..5 {
            Lima.exec(name, false, &format!("sudo sh -c 'echo change {i} > /dev/tty1'"), Duration::from_secs(30)).unwrap();
            for _ in 0..20 {
                let (took, frame) = capture();
                if frame != last {
                    changed.push(took);
                    last = frame;
                    break;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            std::thread::sleep(Duration::from_millis(220));
        }
        eprintln!("captures that got a change after the idle minute: {changed:?}");
        vms.delete(name).unwrap();
        assert_eq!(changed.len(), 5, "a change never showed");
        // A change waits at most one quiet window, for the capture's own request (the frame stays current).
        assert!(changed.iter().all(|took| *took < Duration::from_millis(500)), "{changed:?}");
    }
}
