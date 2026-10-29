//! Shared SSH transport for the VPS-style cloud providers (docs/cloud-agents.md): DigitalOcean,
//! Vultr and Hetzner machines are ordinary Linux boxes, so commands and files move over the
//! system `ssh`/`scp` with one PandaCode ed25519 keypair. The keypair lives base64-encoded
//! in the secure store (`vps_key`, private and public halves in one value; the store rejects
//! newlines), and its 0600 file copy sits in the app-data dir (same protection as the secrets
//! file) where `-i` finds it. Host keys are trusted on first use into an app-data
//! `ssh-known-hosts` file. Windows needs its built-in OpenSSH client (an optional feature
//! there).
use std::collections::HashMap;
use std::path::{Path, PathBuf};
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::thread::sleep;
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD, Engine as _};

use super::shell_quote;
use crate::workspace::{run_process, GitOutput};
use crate::Result;

/// The exec contract keeps at least 4 MiB of output.
const OUTPUT: usize = 4 << 20;
/// ssh's own exit code when it could not reach the machine at all.
const SSH_ERROR: i32 = 255;
/// ssh refuses hosts whose key changed; scp and ssh share these options.
const CONNECT_TIMEOUT: u32 = 20;
/// Readiness after create or start: attempts × pause seconds.
const TRIES: u32 = 12;
const PAUSE: u64 = 10;

/// Where and as whom a machine is reached.
pub struct Target {
    pub host: String,
    pub port: u16,
    pub user: &'static str,
}

impl Target {
    /// A standard VPS box: root on port 22.
    pub fn vps(host: impl Into<String>) -> Target {
        Target { host: host.into(), port: 22, user: "root" }
    }
}

/// Serializes reads and generation of the key pair: two tasks preparing at once must not
/// race the store read against the save, nor share `ssh-keygen`'s temp files.
static KEY_LOCK: Mutex<()> = Mutex::new(());

/// The materialized key file and its public key line, generating the pair on first use.
pub fn key_pair() -> Result<(PathBuf, String)> {
    let _guard = KEY_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let dir = store_dir()?;
    let file = dir.join("vps-key");
    let pair = match super::secret("vps_key").and_then(|stored| decode_pair(&stored)) {
        Some(pair) => pair,
        // An undecodable value is not a usable pair, so a fresh pair is the only way forward.
        None => generate(dir, &file)?,
    };
    write_private(&file, pair.0.as_bytes())?;
    Ok((file, pair.1))
}

/// One ed25519 keypair for every VPS provider, made by `ssh-keygen` and saved as one secret
/// (`vps_key`), private and public halves together so they can never disagree.
fn generate(dir: &Path, file: &Path) -> Result<(String, String)> {
    let new = dir.join("vps-key.new");
    let public_path = PathBuf::from(format!("{}.pub", new.display()));
    let _ = std::fs::remove_file(&new);
    let _ = std::fs::remove_file(&public_path);
    let mut command = Command::new("ssh-keygen");
    command.args(["-q", "-t", "ed25519", "-N", "", "-C", "pandacode", "-f"]).arg(&new);
    let made = run(command, Duration::from_secs(30)).map(|_| ()).and_then(|()| {
        let private = std::fs::read_to_string(&new).map_err(|_| "ssh-keygen made no key file.".to_string())?;
        let public = std::fs::read_to_string(&public_path).ok().map(|line| line.trim().to_string()).unwrap_or_default();
        Ok((private, public))
    });
    let _ = std::fs::remove_file(&new);
    let _ = std::fs::remove_file(&public_path);
    let (private, public) = made?;
    if private.is_empty() {
        return Err("ssh-keygen made an empty key.".into());
    }
    if public.is_empty() {
        return Err("ssh-keygen made no public key.".into());
    }
    super::set_secret("vps_key", &encode_pair(&private, &public))?;
    write_private(file, private.as_bytes())?;
    Ok((private, public))
}

/// The saved form of a keypair, `base64:<private payload> <public line>`: the secure store
/// rejects newlines, and the base64 alphabet holds no spaces, so the halves split cleanly.
fn encode_pair(private: &str, public: &str) -> String {
    format!("base64:{} {public}", STANDARD.encode(private.as_bytes()))
}

/// The inverse of [`encode_pair`]; `None` for anything that is not a saved keypair.
fn decode_pair(stored: &str) -> Option<(String, String)> {
    let rest = stored.strip_prefix("base64:")?;
    let (private, public) = rest.split_once(' ')?;
    let private = STANDARD.decode(private).ok().and_then(|bytes| String::from_utf8(bytes).ok())?;
    let public = public.trim();
    if private.is_empty() || !public.starts_with("ssh-") {
        return None;
    }
    Some((private, public.to_string()))
}

fn write_private(file: &Path, bytes: &[u8]) -> Result<()> {
    if std::fs::read(file).is_ok_and(|existing| existing == bytes) {
        // The mode applies only at create, so a looser file from an older build is tightened.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o600));
        }
        return Ok(());
    }
    use std::io::Write;
    // Mode set at create, so the key is never briefly world-readable; the explicit tighten
    // after the write also covers an existing file, whose mode create would leave alone.
    let mut handle = open_private(file).map_err(|_| "Could not write the SSH key file.".to_string())?;
    handle.write_all(bytes).map_err(|_| "Could not write the SSH key file.".to_string())?;
    drop(handle);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

#[cfg(unix)]
fn open_private(file: &Path) -> std::io::Result<std::fs::File> {
    std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(file)
}
#[cfg(not(unix))]
fn open_private(file: &Path) -> std::io::Result<std::fs::File> {
    std::fs::OpenOptions::new().write(true).create(true).truncate(true).open(file)
}

fn store_dir() -> Result<&'static Path> {
    crate::secret_store::dir().ok_or_else(|| "PandaCode secrets are not available yet.".into())
}

/// Drop a host's remembered key, for machines whose address was recycled (deleted and
/// recreated machines can draw the same address with a new host key, which ssh would
/// refuse forever). OpenSSH records non-default ports as `[host]:port`. Best effort: with
/// no store there is nothing to forget.
pub fn forget_host(host: &str, port: u16) {
    let Ok(dir) = store_dir() else { return };
    let mut command = Command::new("ssh-keygen");
    command.arg("-R").arg(known_hosts_entry(host, port)).arg("-f").arg(dir.join("ssh-known-hosts"));
    let _ = run(command, Duration::from_secs(30));
}

/// How OpenSSH records a host in known_hosts: bare for the default port, bracketed otherwise.
fn known_hosts_entry(host: &str, port: u16) -> String {
    if port == 22 { host.to_string() } else { format!("[{host}]:{port}") }
}

/// The options every ssh and scp call shares: no prompts, trust a new host once, keep its key.
/// The ControlPath is relative and every command runs in the app-data dir: a `ssh-%C` socket
/// beside the key file stays far under the 104-byte unix socket limit the absolute path would
/// blow (and multiplexing turns the many short calls of a run into one login; Windows
/// OpenSSH has no ControlMaster).
fn base_args(key: &Path, known_hosts: &Path, target: &Target, port_flag: &str) -> Vec<String> {
    let mut args = vec![
        "-i".into(), key.display().to_string(),
        port_flag.into(), target.port.to_string(),
        "-o".into(), "BatchMode=yes".into(),
        "-o".into(), "StrictHostKeyChecking=accept-new".into(),
        "-o".into(), format!("UserKnownHostsFile={}", known_hosts.display()),
        "-o".into(), format!("ConnectTimeout={CONNECT_TIMEOUT}"),
    ];
    #[cfg(not(windows))]
    args.extend(["-o".into(), "ControlMaster=auto".into(), "-o".into(), "ControlPath=ssh-%C".into(), "-o".into(), "ControlPersist=10m".into()]);
    args
}

/// ssh arguments running `command` on the target through `sh -c`.
fn exec_args(key: &Path, known_hosts: &Path, target: &Target, command: &str) -> Vec<String> {
    let mut args = base_args(key, known_hosts, target, "-p");
    args.push(format!("{}@{}", target.user, target.host));
    args.extend(["sh".into(), "-c".into(), shell_quote(command)]);
    args
}

/// scp arguments copying a local file to an absolute remote path. Quoting the remote half is
/// only right for the legacy SCP protocol's shell; SFTP mode (the default since OpenSSH 9.0)
/// takes the path literally, so callers try the plain path first and the quoted one as the
/// legacy fallback.
fn copy_args(key: &Path, known_hosts: &Path, target: &Target, from: &Path, to: &str, quoted: bool) -> Vec<String> {
    let mut args = base_args(key, known_hosts, target, "-P");
    args.push(from.display().to_string());
    args.push(format!("{}@{}:{}", target.user, target.host, if quoted { shell_quote(to) } else { to.to_string() }));
    args
}

/// Run one command on the machine; the exit code and stdout, with ssh's own stderr appended
/// when the command failed. A machine that could not be reached at all is an error carrying
/// the [`UNREACHABLE`] prefix, so callers can tell it from a command that merely failed.
pub fn exec(target: &Target, command: &str, timeout: Duration) -> Result<(Option<i32>, String)> {
    let dir = store_dir()?;
    let known_hosts = dir.join("ssh-known-hosts");
    let (key, _) = key_pair()?;
    let mut ssh = Command::new("ssh");
    ssh.current_dir(dir);
    ssh.args(exec_args(&key, &known_hosts, target, command));
    let out = run(ssh, timeout + Duration::from_secs(30))?;
    let code = out.status.code();
    let stderr = String::from_utf8_lossy(&out.stderr.bytes).into_owned();
    if code == Some(SSH_ERROR) && is_transport_stderr(&stderr) {
        return Err(format!("{UNREACHABLE}{}", friendly(&stderr, &known_hosts, target)));
    }
    let mut text = String::from_utf8_lossy(&out.stdout.bytes).into_owned();
    if !out.status.success() {
        text.push_str(&stderr);
    }
    Ok((code, text))
}

/// Prefix of errors from ssh itself, meaning the machine could not be reached or
/// authenticated to (as opposed to a command that merely exited nonzero).
pub const UNREACHABLE: &str = "unreachable: ";

/// Whether this error was ssh failing to reach the machine — the signal to refresh a cached
/// address and retry, never raised for a command that simply timed out or exited 255.
pub fn transport_error(error: &str) -> bool {
    error.starts_with(UNREACHABLE)
}

fn is_transport_stderr(stderr: &str) -> bool {
    ["REMOTE HOST IDENTIFICATION HAS CHANGED", "Permission denied", "Connection refused", "Connection reset", "Connection closed", "timed out", "Could not resolve hostname", "No route to host", "Network is unreachable"]
        .iter()
        .any(|pattern| stderr.contains(pattern))
}

/// Send one file with scp (the chunked default opens a connection per 44 KiB), creating the
/// parent folder and locking the file down when `private`.
pub fn upload(target: &Target, path: &str, bytes: &[u8], private: bool) -> Result<()> {
    let dir = store_dir()?;
    let known_hosts = dir.join("ssh-known-hosts");
    let (key, _) = key_pair()?;
    let folder = path.rsplit_once('/').map(|(folder, _)| folder).unwrap_or(".");
    super::sandbox::checked(exec(target, &format!("mkdir -p {}", shell_quote(folder)), Duration::from_secs(60))?)?;
    // A unique staging file per call: concurrent tasks upload through the same dir.
    let temporary = dir.join(format!("vps-upload-{}", uuid::Uuid::new_v4()));
    use std::io::Write;
    let mut staged = open_private(&temporary).map_err(|_| "Could not stage the file for the upload.".to_string())?;
    staged.write_all(bytes).map_err(|_| {
        let _ = std::fs::remove_file(&temporary);
        "Could not stage the file for the upload."
    })?;
    let copy = |quoted: bool| {
        let mut scp = Command::new("scp");
        scp.current_dir(dir);
        scp.args(copy_args(&key, &known_hosts, target, &temporary, path, quoted));
        run(scp, Duration::from_secs(600))
    };
    // Plain first (SFTP mode takes paths literally), quoted retry for the legacy protocol.
    let out = match copy(false) {
        Ok(out) if out.status.success() => Ok(out),
        failed => match copy(true) {
            Ok(good) if good.status.success() => Ok(good),
            _ => failed,
        },
    };
    let _ = std::fs::remove_file(&temporary);
    let out = out?;
    if !out.status.success() {
        // A dead address reads the same in either protocol; mark it for the caller's retry.
        let stderr = String::from_utf8_lossy(&out.stderr.bytes);
        let copied = if is_transport_stderr(&stderr) { format!("{UNREACHABLE}Could not copy the file to {}", target.host) } else { format!("Could not copy the file to {}", target.host) };
        return Err(format!("{copied}: {}", stderr.trim().chars().rev().take(300).collect::<String>().chars().rev().collect::<String>()));
    }
    if private {
        super::sandbox::checked(exec(target, &format!("chmod 600 {}", shell_quote(path)), Duration::from_secs(60))?)?;
    }
    Ok(())
}

/// Wait until a new or started machine answers SSH and its setup settled. `ready` is the
/// command that says the machine is usable (a fresh droplet waits out cloud-init); it must
/// exit 0 once done.
pub fn wait_ready(target: &Target, ready: &str) -> Result<()> {
    let mut last = String::new();
    for _ in 0..TRIES {
        match exec(target, ready, Duration::from_secs(60)) {
            Ok((Some(0), _)) => return Ok(()),
            Ok((_, output)) => last = output,
            Err(error) => last = error,
        }
        sleep(Duration::from_secs(PAUSE));
    }
    Err(format!("The machine started but SSH did not come up: {}", last.trim().chars().take(300).collect::<String>()))
}

fn run(command: Command, timeout: Duration) -> Result<GitOutput> {
    run_process(command, "ssh", OUTPUT, timeout).map_err(|error| {
        let lowered = error.to_lowercase();
        if lowered.contains("no such file") || lowered.contains("not found") || lowered.contains("cannot find") {
            "OpenSSH is needed to reach this cloud machine. Install it (on Windows: Settings → Apps → Optional features → OpenSSH client) and try again.".into()
        } else {
            error
        }
    })
}

/// A readable reason for an ssh-level failure, from ssh's stderr.
fn friendly(stderr: &str, known_hosts: &Path, target: &Target) -> String {
    let stderr = stderr.trim();
    if stderr.contains("REMOTE HOST IDENTIFICATION HAS CHANGED") {
        return format!("{}'s host key changed since its last use (the machine was probably deleted and recreated at the same address). Remove its old entry from {} and try again.", target.host, known_hosts.display());
    }
    if stderr.contains("Permission denied") {
        return format!("{} refused the PandaCode SSH key. The machine may still be starting; try again in a minute.", target.host);
    }
    if stderr.contains("Connection refused") || stderr.contains("timed out") {
        return format!("{} did not answer SSH. The machine may be stopped or still starting.", target.host);
    }
    if stderr.is_empty() {
        return "The SSH command could not run.".into();
    }
    format!("SSH: {}", stderr.chars().take(300).collect::<String>())
}

/// The VPS providers' cached machine addresses: one REST lookup per machine instead of one
/// per exec (the run's poll cadence would exhaust API rate limits). `digitalocean.rs` keys it.
pub(crate) fn address_cache() -> &'static Mutex<HashMap<String, String>> {
    static CACHE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target() -> Target {
        Target::vps("203.0.113.7")
    }

    #[test]
    fn ssh_commands_share_the_safety_options_and_wrap_in_sh_c() {
        let (key, known) = (Path::new("/data/vps-key"), Path::new("/data/ssh-known-hosts"));
        let args = exec_args(key, known, &target(), "echo hi && ls");
        assert!(args.windows(2).any(|pair| pair[0] == "-i" && pair[1] == "/data/vps-key"));
        assert!(args.windows(2).any(|pair| pair[0] == "-p" && pair[1] == "22"));
        assert!(args.contains(&"BatchMode=yes".to_string()));
        assert!(args.contains(&"StrictHostKeyChecking=accept-new".to_string()));
        assert!(args.iter().any(|a| a == &format!("UserKnownHostsFile={}", known.display())));
        assert!(args.contains(&"ConnectTimeout=20".to_string()));
        // The mux socket name is relative so the path stays short; the command runs in the
        // app-data dir.
        assert!(args.contains(&"ControlPath=ssh-%C".to_string()));
        assert_eq!(&args[args.len() - 4..], &["root@203.0.113.7".to_string(), "sh".into(), "-c".into(), "'echo hi && ls'".into()]);
    }

    #[test]
    fn scp_takes_a_capital_port_flag_and_quotes_only_for_the_legacy_fallback() {
        let (key, known) = (Path::new("/data/vps-key"), Path::new("/data/ssh-known-hosts"));
        let plain = copy_args(key, known, &target(), Path::new("/tmp/f"), "/home/x/a b.txt", false);
        assert!(plain.windows(2).any(|pair| pair[0] == "-P" && pair[1] == "22"));
        assert_eq!(plain.last().unwrap(), "root@203.0.113.7:/home/x/a b.txt");
        let quoted = copy_args(key, known, &target(), Path::new("/tmp/f"), "/home/x/a b.txt", true);
        assert_eq!(quoted.last().unwrap(), "root@203.0.113.7:'/home/x/a b.txt'");
    }

    #[test]
    fn transport_errors_are_marked_not_sniffed_from_command_output() {
        // Only the prefix marks an error as unreachable; a command that exits 255 with
        // look-alike text on its stderr is passed through.
        assert!(transport_error(&format!("{UNREACHABLE}203.0.113.7 did not answer SSH.")));
        assert!(!transport_error("203.0.113.7 did not answer SSH. The machine may be stopped or still starting."));
        assert!(!transport_error("my-tool: fatal: connection refused"));
        assert!(!transport_error("ssh operation timed out. Check the repository before retrying."));
        assert!(!transport_error(""));
    }

    #[test]
    fn known_hosts_entries_are_bracketed_for_non_default_ports() {
        assert_eq!(known_hosts_entry("203.0.113.7", 22), "203.0.113.7");
        assert_eq!(known_hosts_entry("203.0.113.7", 13007), "[203.0.113.7]:13007");
    }

    #[test]
    fn failures_name_the_machine_and_the_fix() {
        let known = Path::new("/data/ssh-known-hosts");
        let changed = friendly("@@@@@@@@\nREMOTE HOST IDENTIFICATION HAS CHANGED!", known, &target());
        assert!(changed.contains("203.0.113.7") && changed.contains(known.to_str().unwrap()));
        assert!(friendly("root@x: Permission denied (publickey).", known, &target()).contains("still be starting"));
        assert!(friendly("ssh: connect to host x port 22: Connection refused", known, &target()).contains("did not answer"));
        assert!(friendly("", known, &target()).contains("could not run"));
        assert!(friendly("kex_exchange_identification: banner line", known, &target()).starts_with("SSH: kex"));
    }

    /// Issue #206: a first VPS cloud task failed twice — the multi-line private key was
    /// rejected by the secure store's control-character check, and re-deriving the public
    /// half with `ssh-keygen -y` failed inside the app. One test because the secure store's
    /// dir is a process-global.
    #[test]
    fn vps_key_survives_the_secure_store_and_self_heals() {
        use super::super::{secret, set_secret};
        let dir = std::env::temp_dir().join(format!("pandacode-vps-key-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        crate::secret_store::setup(&dir);
        let forget = |names: &[&str]| {
            for name in names {
                crate::secret_store::remove(super::super::SERVICE, name);
            }
        };
        forget(&["vps_key"]);

        // First use: generation succeeds, the stored pair is encoded and carries both halves,
        // and the materialized file holds the decoded private half at 0600.
        let (made, public) = key_pair().expect("first use generates and saves a keypair");
        assert!(made.ends_with("vps-key"));
        let stored = secret("vps_key").expect("the keypair is saved");
        assert!(stored.starts_with("base64:"));
        assert!(!stored.chars().any(char::is_control), "the stored pair must pass the secure store's checks");
        use base64::Engine as _;
        let (stored_private, stored_public) = stored.strip_prefix("base64:").unwrap().split_once(' ').unwrap();
        let private = String::from_utf8(
            base64::engine::general_purpose::STANDARD.decode(stored_private).unwrap(),
        ).unwrap();
        assert!(private.contains("PRIVATE KEY"));
        assert_eq!(stored_public, public);
        assert!(public.starts_with("ssh-ed25519 "));
        assert_eq!(std::fs::read_to_string(&made).unwrap(), private);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&made).unwrap().permissions().mode() & 0o777, 0o600);
        }

        // A second call reuses the pair: nothing regenerates.
        let (again, public_again) = key_pair().unwrap();
        assert_eq!(again, made);
        assert_eq!(public_again, public);
        assert_eq!(secret("vps_key").as_deref(), Some(stored.as_str()));

        // The key file's mode is tightened again even when its content already matches.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&made, std::fs::Permissions::from_mode(0o644)).unwrap();
            key_pair().unwrap();
            assert_eq!(std::fs::metadata(&made).unwrap().permissions().mode() & 0o777, 0o600);
        }

        // Self-heal: an undecodable value (never a usable pair) is replaced by a fresh pair
        // instead of blocking every task.
        set_secret("vps_key", "base64:bm90LWEta2V5").unwrap();
        let (healed_file, healed_public) = key_pair().expect("an undecodable key regenerates instead of failing");
        assert_eq!(healed_file, made);
        assert!(healed_public.starts_with("ssh-ed25519 "));
        assert_ne!(healed_public, public);
        assert_ne!(secret("vps_key").as_deref(), Some("base64:bm90LWEta2V5"));

        // Concurrent callers share one pair: the lock keeps parallel task preparations from
        // racing the store read against the save or each other's temp files.
        forget(&["vps_key"]);
        let pairs: Vec<(PathBuf, String)> = std::thread::scope(|scope| {
            (0..4).map(|_| scope.spawn(key_pair)).map(|handle| handle.join().unwrap().expect("concurrent generation succeeds")).collect()
        });
        let (first_file, first_public) = &pairs[0];
        assert!(pairs.iter().all(|(file, public)| file == first_file && public == first_public));

        forget(&["vps_key"]);
        let _ = std::fs::remove_dir_all(dir);
    }
}
