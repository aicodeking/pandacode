//! Docker containers for cloud agents (docs/cloud-agents.md): one machine per task, on this
//! machine's Docker or on any Docker host, through the configured endpoint — a local daemon
//! (no endpoint), `unix:///path`, `ssh://[user@]host[:port]` over the shared SSH transport
//! (cloud/ssh.rs), or a TLS-secured `tcp://` Engine API. Three selectable engines: Docker,
//! Apple Containers (`container`, docker-shaped, local only) and the `lxc` client (LXD or
//! Incus — no labels, so ownership is the `pc-` name prefix, and its own remotes instead of
//! an endpoint). Machines carry the `pandacode` label or prefix and keep running (holding
//! their disk) until stopped, at the cost of the host's own resources — nothing is billed,
//! but a Docker daemon is root-equivalent on its machine, so endpoints are trust decisions
//! like any VPS.
use serde_json::Value;
use std::process::Command;
use std::time::Duration;

use super::{sandbox::{Info, Sandbox}, shell_quote, ssh, Machine};
use crate::workspace::{run_process, GitOutput};
use crate::Result;

const SERVICE: &str = "Docker";
/// The Sandbox contract keeps at least 4 MiB of output.
const OUTPUT: usize = 4 << 20;
const LABEL: &str = "pandacode";
const IMAGE: &str = "ubuntu:24.04";
/// A fresh container pulls its image on first run, which can take minutes.
const CREATE_TIMEOUT: u64 = 600;

/// The local container engine; the CLIs are docker-shaped, differing in flag spelling, list
/// output and the delete verb. The `lxc` client (LXD; Incus uses the same commands) is local
/// only here too — it selects its own remote, so endpoints do not apply. Podman's remote
/// flag is `--url` and its TLS flags differ from Docker's, so it takes local, `unix://` and
/// `ssh://` endpoints (the SSH path runs the remote binary directly, no socket needed).
#[derive(Clone, Copy, PartialEq)]
enum Engine {
    Docker,
    Apple,
    Lxc,
    Podman,
}

pub struct Docker {
    /// None: this machine's daemon.
    endpoint: Option<String>,
    image: String,
    tls: Option<Tls>,
    engine: Engine,
}

#[derive(Clone)]
struct Tls {
    ca: String,
    cert: String,
    key: String,
}

impl Docker {
    fn new(endpoint: Option<String>, image: Option<String>, tls: Option<Tls>, engine: Engine) -> Self {
        Docker {
            endpoint: endpoint.filter(|e| !e.trim().is_empty()).map(|e| e.trim().trim_end_matches('/').to_string()),
            image: image.filter(|i| !i.trim().is_empty()).map(|i| i.trim().to_string()).unwrap_or_else(|| IMAGE.into()),
            tls,
            engine,
        }
    }
    fn connected() -> Result<Self> {
        let settings = super::settings();
        let options = settings.providers.get("docker").ok_or("Connect Docker in Settings → Cloud first.")?;
        let tls = match (options.get("tlsCa"), options.get("tlsCert"), options.get("tlsKey")) {
            (Some(ca), Some(cert), Some(key)) => Some(Tls { ca: ca.clone(), cert: cert.clone(), key: key.clone() }),
            _ => None,
        };
        let engine = match options.get("engine").map(String::as_str) {
            Some("apple") => Engine::Apple,
            Some("lxc") => Engine::Lxc,
            Some("podman") => Engine::Podman,
            _ => Engine::Docker,
        };
        Ok(Docker::new(options.get("endpoint").cloned(), options.get("image").cloned(), tls, engine))
    }

    /// The CLI binary and the human label of the selected engine.
    fn binary(&self) -> &'static str {
        match self.engine {
            Engine::Docker => "docker",
            Engine::Apple => "container",
            Engine::Lxc => "lxc",
            Engine::Podman => "podman",
        }
    }
    fn label(&self) -> &'static str {
        match self.engine {
            Engine::Docker => SERVICE,
            Engine::Apple => "Apple Containers",
            Engine::Lxc => "LXC",
            Engine::Podman => "Podman",
        }
    }

    /// `docker`/`podman` arguments selecting the endpoint: Docker's `-H` (plus, for TLS, the
    /// certificate flags) or Podman's `--url` — never environment variables, so the bounded
    /// runner's sanitized environment is enough.
    fn docker_args(&self) -> Vec<String> {
        let mut args = Vec::new();
        if let Some(endpoint) = &self.endpoint {
            if !endpoint.starts_with("ssh://") {
                args.extend(match self.engine {
                    Engine::Podman => vec!["--url".into(), endpoint.clone()],
                    _ => vec!["-H".into(), endpoint.clone()],
                });
            }
        }
        if let Some(tls) = &self.tls {
            args.extend(["--tlsverify".into(), "--tlscacert".into(), tls.ca.clone(), "--tlscert".into(), tls.cert.clone(), "--tlskey".into(), tls.key.clone()]);
        }
        args
    }

    /// The SSH target of an `ssh://[user@]host[:port]` endpoint.
    fn ssh_target(&self) -> Result<ssh::Target> {
        let endpoint = self.endpoint.as_deref().ok_or("This Docker endpoint is not remote.")?;
        let rest = endpoint.strip_prefix("ssh://").ok_or("This Docker endpoint is not an SSH host.")?;
        let (user, host_port) = match rest.split_once('@') {
            Some((user, host_port)) => (user, host_port),
            None => ("root", rest),
        };
        let (host, port) = match host_port.rsplit_once(':') {
            Some((host, port)) => (host, port.parse::<u16>().map_err(|_| format!("That Docker SSH endpoint has no readable port: {endpoint}"))?),
            None => (host_port, 22),
        };
        if host.is_empty() || host.contains('/') {
            return Err(format!("That does not look like a Docker SSH endpoint: {endpoint}"));
        }
        // The parsed user is cached per endpoint string, so the poll cadence cannot grow it.
        let user: &'static str = static_user(if user.is_empty() { "root" } else { user });
        Ok(ssh::Target { host: host.to_string(), port, user })
    }

    /// Whether the endpoint is a remote SSH host (docker then runs through cloud/ssh.rs).
    fn over_ssh(&self) -> bool {
        self.endpoint.as_deref().is_some_and(|e| e.starts_with("ssh://"))
    }

    /// Run one container command through the endpoint; exit code and stdout, the CLI's
    /// stderr appended on failure. Arguments stay a vector: formats like `{{json .}}` hold
    /// spaces the shell must not split (the SSH path quotes each, behind the binary).
    fn call(&self, args: &[&str], timeout: Duration) -> Result<(Option<i32>, String)> {
        if self.over_ssh() {
            return ssh::exec(&self.ssh_target()?, &self.remote_line(args), timeout);
        }
        let mut command = Command::new(self.binary());
        command.args(self.docker_args());
        command.args(args);
        let out = run_cli(command, timeout)?;        let mut text = String::from_utf8_lossy(&out.stdout.bytes).into_owned();
        if !out.status.success() {
            text.push_str(&String::from_utf8_lossy(&out.stderr.bytes));
        }
        Ok((out.status.code(), text))
    }
    /// The command line an SSH host runs: the container binary in front, every argument
    /// quoted (an SSH endpoint never goes through `-H`; it invokes the remote CLI directly).
    fn remote_line(&self, args: &[&str]) -> String {
        std::iter::once(self.binary()).chain(args.iter().copied()).map(shell_quote).collect::<Vec<_>>().join(" ")
    }
    fn checked(&self, args: &[&str], timeout: Duration) -> Result<()> {
        super::sandbox::checked(self.call(args, timeout)?)
    }
}

/// Run the local container CLI, mapping a missing binary to a readable error.
fn run_cli(command: Command, timeout: Duration) -> Result<GitOutput> {
    run_process(command, "docker", OUTPUT, timeout).map_err(|error| {
        let lowered = error.to_lowercase();
        if lowered.contains("no such file") || lowered.contains("not found") || lowered.contains("cannot find") {
            "The selected container engine is needed for this cloud provider. Install it (Docker, Podman, Apple Containers on macOS, or the lxc client) and try again.".into()
        } else {
            error
        }
    })
}

/// `ssh::Target` wants a `&'static str`; intern the configured SSH users so the poll cadence
/// cannot leak per call.
fn static_user(user: &str) -> &'static str {
    static USERS: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, &'static str>>> = std::sync::OnceLock::new();
    let mut users = USERS.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new())).lock().unwrap();
    users.entry(user.to_string()).or_insert_with(|| Box::leak(user.to_string().into_boxed_str()))
}

/// The containers PandaCode started, from `docker ps` NDJSON.
fn parse_list(output: &str) -> Vec<Machine> {
    output.lines().filter_map(|line| serde_json::from_str::<Value>(line.trim()).ok()).filter_map(|item| machine(&item)).collect()
}

fn machine(item: &Value) -> Option<Machine> {
    // The container name is the native ID: create() returns it, every command takes it, and
    // the trait's default state() must find what create made (the container ID would not).
    let name = item["Names"].as_str()?.split(',').next()?.to_string();
    let image = item["Image"].as_str().unwrap_or("image");
    let state = match item["State"].as_str() {
        Some("running") => "running",
        Some("created" | "exited" | "paused") => "stopped",
        _ => "error",
    };
    Some(Machine { id: format!("docker:{name}"), provider: "docker".into(), name: name.clone(), state: state.into(), os: "linux".into(), desktop: false, detail: format!("{SERVICE} · {image}") })
}

/// Apple's list entries (`container ls --all --format json`): one object per container with
/// `id`, `configuration.image.reference`, `configuration.labels` and `status.state`.
fn apple_machine(item: &Value) -> Option<Machine> {
    let id = item["id"].as_str()?.to_string();
    // Only PandaCode's own containers carry the label.
    if item["configuration"]["labels"][LABEL].as_str() != Some("true") {
        return None;
    }
    let image = item["configuration"]["image"]["reference"].as_str().unwrap_or("image");
    let state = match item["status"]["state"].as_str() {
        Some("running") => "running",
        Some("stopped" | "created") => "stopped",
        _ => "error",
    };
    Some(Machine { id: format!("docker:{id}"), provider: "docker".into(), name: id.clone(), state: state.into(), os: "linux".into(), desktop: false, detail: format!("Apple Containers · {image}") })
}

/// LXC list entries (`lxc list <prefix> --format json`): `name`, Title-case `status`
/// ("Running", "Stopped", …) and `type` ("container" or "virtual-machine"). The prefix was
/// applied server-side; ownership is the name, since LXC has no labels.
/// Podman list entries (`podman ps --format json`): one JSON array with `Id`, `Names` as an
/// array, lowercase `State` ("running", "exited", …) and `Image`. The label filter ran
/// server-side; the first name is the native ID, as with Docker.
fn podman_machine(item: &Value) -> Option<Machine> {
    let name = item["Names"].as_array()?.first()?.as_str()?.to_string();
    let image = item["Image"].as_str().unwrap_or("image");
    let state = match item["State"].as_str() {
        Some("running") => "running",
        Some("created" | "initialized" | "exited" | "stopped" | "paused") => "stopped",
        Some("stopping") => "stopping",
        _ => "error",
    };
    Some(Machine { id: format!("docker:{name}"), provider: "docker".into(), name: name.clone(), state: state.into(), os: "linux".into(), desktop: false, detail: format!("Podman · {image}") })
}

fn lxc_machine(item: &Value) -> Option<Machine> {
    let name = item["name"].as_str()?.to_string();
    if !name.starts_with("pc-") {
        return None;
    }
    let kind = item["type"].as_str().unwrap_or("container");
    let state = match item["status"].as_str() {
        Some("Running" | "Restarting" | "Thawing") => "running",
        Some("Starting") => "starting",
        Some("Stopping" | "Freezing") => "stopping",
        Some("Stopped" | "Frozen") => "stopped",
        _ => "error",
    };
    Some(Machine { id: format!("docker:{name}"), provider: "docker".into(), name: name.clone(), state: state.into(), os: "linux".into(), desktop: false, detail: format!("LXC · {kind}") })
}

/// Container names are stricter in PandaCode than in Docker: the same hostname-safe shape as
/// the other providers, so task machines stay uniform.
fn valid_name(name: &str) -> Result<&str> {
    let ok = (1..=63).contains(&name.len())
        && name.starts_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit())
        && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !name.ends_with('-');
    ok.then_some(name).ok_or_else(|| "Docker names use lowercase letters, digits and dashes, starting with a letter or digit (up to 63).".to_string())
}

pub fn connect(options: &Value) -> Result<()> {
    let engine = match options["engine"].as_str().map(str::trim).filter(|e| !e.is_empty()) {
        None | Some("docker") => Engine::Docker,
        Some("apple") => Engine::Apple,
        Some("lxc") => Engine::Lxc,
        Some("podman") => Engine::Podman,
        Some(other) => return Err(format!("The engine is docker, apple, lxc or podman, not {other}.")),
    };
    let endpoint = options["endpoint"].as_str().map(str::trim).filter(|e| !e.is_empty()).map(|e| e.trim_end_matches('/').to_string());
    if let Some(endpoint) = &endpoint {
        if !endpoint.starts_with("ssh://") && !endpoint.starts_with("tcp://") && !endpoint.starts_with("unix://") {
            return Err("Docker hosts are ssh://user@host, tcp://host:port (with TLS) or unix:///path — or empty for this machine.".into());
        }
    }
    if let Some(endpoint) = &endpoint {
        if engine == Engine::Apple || engine == Engine::Lxc {
            return Err(match engine {
                Engine::Apple => "Apple Containers run only on this machine — leave the Docker host empty.".into(),
                // The lxc client picks its own remote; PandaCode does not point it anywhere.
                Engine::Lxc => "The lxc client manages its own remotes — leave the Docker host empty (configure one with `lxc remote add`).".into(),
                _ => unreachable!(),
            });
        }
        // Podman's own TLS transport differs from Docker's; its remote hosts take ssh://.
        if engine == Engine::Podman && endpoint.starts_with("tcp://") {
            return Err("Podman remote hosts take an ssh:// endpoint (PandaCode runs the remote podman directly); tcp:// with Docker-style TLS flags is not supported for Podman.".into());
        }
    }
    let tls = match (options["tlsCa"].as_str(), options["tlsCert"].as_str(), options["tlsKey"].as_str()) {
        (None | Some(""), None | Some(""), None | Some("")) => None,
        (Some(ca), Some(cert), Some(key)) => Some(Tls { ca: ca.trim().into(), cert: cert.trim().into(), key: key.trim().into() }),
        _ => return Err("TLS needs all three certificate paths (CA, cert, key).".into()),
    };
    if tls.is_some() && (!endpoint.as_deref().is_some_and(|e| e.starts_with("tcp://")) || engine == Engine::Podman) {
        return Err("TLS certificates apply to tcp:// Docker hosts.".into());
    }
    let image = options["image"].as_str().map(str::trim).filter(|i| !i.is_empty()).map(str::to_string);
    // The endpoint works: ask its daemon for its version (and surface our public key when an
    // SSH host refuses the PandaCode key, since that host is not one we can provision).
    let docker = Docker::new(endpoint.clone(), image.clone(), tls, engine);
    if let Err(error) = docker.version() {
        if docker.over_ssh() {
            if let Ok((_, public)) = ssh::key_pair() {
                return Err(format!("{error} — for an SSH host, authorize PandaCode's key there first: {public}"));
            }
        }
        return Err(error);
    }
    let mut settings = super::settings();
    let entry = settings.providers.entry("docker".into()).or_default();
    if let Some(endpoint) = endpoint {
        entry.insert("endpoint".into(), endpoint);
    } else {
        entry.remove("endpoint");
    }
    if let Some(image) = image {
        entry.insert("image".into(), image);
    } else {
        entry.remove("image");
    }
    match engine {
        Engine::Docker => { entry.remove("engine"); }
        other => { entry.insert("engine".into(), match other { Engine::Apple => "apple", Engine::Lxc => "lxc", Engine::Podman => "podman", Engine::Docker => unreachable!() }.into()); }
    }
    for (name, path) in [("tlsCa", docker.tls.as_ref().map(|t| &t.ca)), ("tlsCert", docker.tls.as_ref().map(|t| &t.cert)), ("tlsKey", docker.tls.as_ref().map(|t| &t.key))] {
        match path {
            Some(path) => { entry.insert(name.into(), path.clone()); }
            None => { entry.remove(name); }
        }
    }
    entry.insert("detail".into(), docker.endpoint.clone().unwrap_or_else(|| match engine { Engine::Apple => "this machine (Apple Containers)".into(), Engine::Lxc => "the lxc client's remote".into(), Engine::Podman => "this machine (Podman)".into(), Engine::Docker => "this machine".into() }));
    super::save_settings(&settings)
}

pub fn disconnect() -> Result<()> {
    let mut settings = super::settings();
    settings.providers.remove("docker");
    super::save_settings(&settings)
}
pub fn sandbox() -> Result<Box<dyn Sandbox>> {
    Ok(Box::new(Docker::connected()?))
}

impl Docker {
    /// The daemon answers.
    fn version(&self) -> Result<()> {
        let args: &[&str] = match self.engine {
            Engine::Docker | Engine::Podman => &["version", "--format", "{{.Server.Version}}"],
            Engine::Apple | Engine::Lxc => &["version"],
        };
        self.checked(args, Duration::from_secs(60))
    }
    /// The arguments that start a labelled, always-on task machine. Docker and Podman label
    /// with `--label`, Apple with `-l`; both keep a sleeping shell alive. An LXC instance
    /// runs its image's own init and has no labels — ownership is the `pc-` name prefix (the
    /// run pipeline names every machine one).
    fn create_args(&self, name: &str) -> Vec<String> {
        match self.engine {
            Engine::Lxc => vec!["launch".into(), self.image.clone(), name.into()],
            _ => {
                let label_flag = match self.engine {
                    Engine::Apple => "-l",
                    _ => "--label",
                };
                vec!["run".into(), "-d".into(), "--name".into(), name.into(), label_flag.into(), LABEL.into(), self.image.clone(), "sh".into(), "-c".into(), "sleep infinity".into()]
            }
        }
    }
    /// LXC's exec takes a `--` separator before the command; the other engines parse
    /// positionally.
    fn exec_prefix(&self, native: &str) -> Vec<String> {
        let mut prefix = vec!["exec".into(), native.into()];
        if self.engine == Engine::Lxc {
            prefix.push("--".into());
        }
        prefix
    }
}

impl Sandbox for Docker {
    /// Stopped containers keep their filesystem; they occupy the host until removed.
    fn info(&self) -> Info {
        Info { persistent: true, max_unattended_minutes: 24 * 60 }
    }
    fn list(&self) -> Result<Vec<Machine>> {
        let filter = format!("label={LABEL}");
        let (code, output) = match self.engine {
            Engine::Docker => self.call(&["ps", "-a", "--filter", filter.as_str(), "--format", "{{json .}}"], Duration::from_secs(60))?,
            // Podman's JSON list is one array with lowercase states and array names.
            Engine::Podman => self.call(&["ps", "-a", "--filter", filter.as_str(), "--format", "json"], Duration::from_secs(60))?,
            // Apple's list is one JSON array; filtering by the label happens in code.
            Engine::Apple => self.call(&["ls", "--all", "--format", "json"], Duration::from_secs(60))?,
            // The lxc client filters by name prefix server-side ("pc-" is ours) and returns
            // Title-case statuses.
            Engine::Lxc => self.call(&["list", "pc-", "--format", "json"], Duration::from_secs(60))?,
        };
        if code != Some(0) {
            return Err(super::sandbox::checked((code, output)).unwrap_err());
        }
        match self.engine {
            Engine::Docker => Ok(parse_list(&output)),
            Engine::Podman | Engine::Apple => {
                let items: Vec<Value> = serde_json::from_str(&output).map_err(|_| format!("{} returned an unreadable container list.", self.label()))?;
                Ok(items.iter().filter_map(|item| match self.engine {
                    Engine::Podman => podman_machine(item),
                    _ => apple_machine(item),
                }).collect())
            }
            Engine::Lxc => {
                let items: Vec<Value> = serde_json::from_str(&output).map_err(|_| "LXC returned an unreadable instance list.".to_string())?;
                Ok(items.iter().filter_map(lxc_machine).collect())
            }
        }
    }
    fn create(&self, name: &str) -> Result<Machine> {
        let name = valid_name(name)?;
        // sleep infinity keeps the container alive; the harness runtime is installed into it
        // by the ordinary cloud-agent setup, and the first run may pull the image.
        let created = self.create_args(name);
        let args: Vec<&str> = created.iter().map(String::as_str).collect();
        self.checked(&args, Duration::from_secs(CREATE_TIMEOUT))?;
        Ok(Machine { id: format!("docker:{name}"), provider: "docker".into(), name: name.into(), state: "running".into(), os: "linux".into(), desktop: false, detail: format!("{} · {}", self.label(), self.image) })
    }
    fn power(&self, native: &str, action: &str) -> Result<()> {
        match action {
            "start" | "stop" => self.checked(&[action, native], Duration::from_secs(120)),
            "delete" => {
                let args: &[&str] = match self.engine {
                    Engine::Docker => &["rm", "-f", native],
                    // Podman's --ignore makes a missing container a no-op by flag.
                    Engine::Podman => &["rm", "-f", "--ignore", native],
                    Engine::Apple | Engine::Lxc => &["delete", "--force", native],
                };
                match self.checked(args, Duration::from_secs(120)) {
                    // A machine that is already gone did what was asked.
                    Err(e) if e.contains("No such container") || e.contains("no such container") || e.contains("not found") => Ok(()),
                    result => result,
                }
            }
            _ => Err(format!("Docker containers can start, stop or be deleted, not {action}.")),
        }
    }
    fn exec(&self, native: &str, command: &str, timeout: Duration) -> Result<(Option<i32>, String)> {
        let prefix = self.exec_prefix(native);
        let mut args: Vec<&str> = prefix.iter().map(String::as_str).collect();
        args.extend(["sh", "-c", command]);
        self.call(&args, timeout + Duration::from_secs(30))
    }
    /// Containers run until stopped; cloud agents stop them themselves after an idle run end.
    fn keep_alive(&self, _native: &str, _minutes: u32) -> Result<()> {
        Ok(())
    }
    /// Whole files: `cp` for Docker and Apple, `file push --create-dirs` for LXC (whose
    /// source/destination separator is a slash). On the SSH path the daemon reads its own
    /// filesystem, so the file is staged there through the SSH transport first.
    fn upload(&self, native: &str, path: &str, bytes: &[u8], private: bool) -> Result<()> {
        if self.engine != Engine::Lxc {
            let folder = path.rsplit_once('/').map(|(folder, _)| folder).unwrap_or(".");
            super::sandbox::checked(self.exec(native, &format!("mkdir -p {}", shell_quote(folder)), Duration::from_secs(60))?)?;
        }
        let staging = format!("pandacode-docker-{}", uuid::Uuid::new_v4());
        let (source, cleanup): (String, Box<dyn FnOnce() -> Result<()>>) = if self.over_ssh() {
            let target = self.ssh_target()?;
            let remote = format!("/tmp/{staging}");
            ssh::upload(&target, &remote, bytes, false)?;
            let for_cleanup = remote.clone();
            let cleanup = move || ssh::exec(&target, &format!("rm -f {}", shell_quote(&for_cleanup)), Duration::from_secs(60)).map(|_| ());
            (remote, Box::new(cleanup))
        } else {
            let temporary = std::env::temp_dir().join(&staging);
            std::fs::write(&temporary, bytes).map_err(|_| "Could not stage the file for the upload.".to_string())?;
            let for_cleanup = temporary.display().to_string();
            let path_for_cleanup = for_cleanup.clone();
            let cleanup = move || { let _ = std::fs::remove_file(&path_for_cleanup); Ok(()) };
            (for_cleanup, Box::new(cleanup))
        };
        let destination = match self.engine {
            Engine::Lxc => format!("{native}{path}"),
            _ => format!("{native}:{path}"),
        };
        let args: Vec<&str> = match self.engine {
            Engine::Lxc => vec!["file", "push", "--create-dirs", source.as_str(), destination.as_str()],
            _ => vec!["cp", source.as_str(), destination.as_str()],
        };
        let copy = self.call(&args, Duration::from_secs(600));
        drop(args);
        cleanup()?;
        super::sandbox::checked(copy?)?;
        if private {
            super::sandbox::checked(self.exec(native, &format!("chmod 600 {}", shell_quote(path)), Duration::from_secs(60))?)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn docker(endpoint: Option<&str>, tls: Option<(&str, &str, &str)>) -> Docker {
        Docker::new(endpoint.map(str::to_string), None, tls.map(|(ca, cert, key)| Tls { ca: ca.into(), cert: cert.into(), key: key.into() }), Engine::Docker)
    }

    fn apple() -> Docker {
        Docker::new(None, None, None, Engine::Apple)
    }

    fn lxc() -> Docker {
        Docker::new(None, None, None, Engine::Lxc)
    }

    #[test]
    fn the_engines_pick_their_shapes() {
        assert_eq!(docker(None, None).binary(), "docker");
        assert_eq!(apple().binary(), "container");
        assert_eq!(lxc().binary(), "lxc");
        assert_eq!(podman().binary(), "podman");
        assert!(docker(None, None).create_args("pc-x").contains(&"--label".to_string()));
        assert!(podman().create_args("pc-x").contains(&"--label".to_string()));
        assert!(apple().create_args("pc-x").contains(&"-l".to_string()));
        assert_eq!(apple().create_args("pc-x").last().unwrap(), "sleep infinity");
        // LXC has no labels and keeps its own init alive: just launch by name.
        assert_eq!(lxc().create_args("pc-x"), vec!["launch".to_string(), "ubuntu:24.04".to_string(), "pc-x".to_string()]);
        assert_eq!(apple().label(), "Apple Containers");
        assert_eq!(lxc().label(), "LXC");
        assert_eq!(podman().label(), "Podman");
        // LXC's exec separates the command with `--`.
        assert_eq!(lxc().exec_prefix("pc-x"), vec!["exec".to_string(), "pc-x".to_string(), "--".to_string()]);
        assert_eq!(docker(None, None).exec_prefix("pc-x"), vec!["exec".to_string(), "pc-x".to_string()]);
        assert_eq!(podman().exec_prefix("pc-x"), vec!["exec".to_string(), "pc-x".to_string()]);
        // Podman selects endpoints with --url, not Docker's -H.
        assert_eq!(Docker::new(Some("unix:///run/podman.sock".into()), None, None, Engine::Podman).docker_args(), vec!["--url".to_string(), "unix:///run/podman.sock".to_string()]);
    }

    fn podman() -> Docker {
        Docker::new(None, None, None, Engine::Podman)
    }

    #[test]
    fn podman_lists_its_array_shape_with_lowercase_states() {
        let item = serde_json::json!({"Id":"abc123def","Names":["pc-abc123def"],"State":"running","Image":"ubuntu:24.04"});
        let mine = podman_machine(&item).unwrap();
        assert_eq!((mine.id.as_str(), mine.name.as_str(), mine.state.as_str()), ("docker:pc-abc123def", "pc-abc123def", "running"));
        assert_eq!(mine.detail, "Podman · ubuntu:24.04");
        assert_eq!(podman_machine(&serde_json::json!({"Names":["pc-x"],"State":"exited","Image":"i"})).unwrap().state, "stopped");
        assert_eq!(podman_machine(&serde_json::json!({"Names":["pc-x"],"State":"weird","Image":"i"})).unwrap().state, "error");
        assert_eq!(podman_machine(&serde_json::json!({"Id":"x","State":"running"})), None);
    }

    #[test]
    fn lxc_lists_only_its_own_prefix_instances_by_title_case_status() {
        let item = serde_json::json!({"name":"pc-abc123","status":"Running","type":"container"});
        let mine = lxc_machine(&item).unwrap();
        assert_eq!((mine.id.as_str(), mine.name.as_str(), mine.state.as_str()), ("docker:pc-abc123", "pc-abc123", "running"));
        assert_eq!(mine.detail, "LXC · container");
        assert_eq!(lxc_machine(&serde_json::json!({"name":"pc-x","status":"Stopped","type":"virtual-machine"})).unwrap().state, "stopped");
        assert_eq!(lxc_machine(&serde_json::json!({"name":"pc-x","status":"Frozen","type":"container"})).unwrap().state, "stopped");
        assert_eq!(lxc_machine(&serde_json::json!({"name":"pc-x","status":"Starting","type":"container"})).unwrap().state, "starting");
        // Another instance of the account's, without the pc- prefix, is not PandaCode's machine.
        assert_eq!(lxc_machine(&serde_json::json!({"name":"web-1","status":"Running","type":"container"})), None);
        assert_eq!(lxc_machine(&serde_json::json!({"status":"Running"})), None);
    }

    #[test]
    fn apple_lists_only_labelled_containers() {
        // Trimmed from a real `container ls --all --format json` entry.
        let item = serde_json::json!({"id":"pc-abc123","configuration":{"image":{"reference":"docker.io/library/ubuntu:24.04"},"labels":{"pandacode":"true"}},"status":{"state":"stopped"}});
        let mine = apple_machine(&item).unwrap();
        assert_eq!((mine.id.as_str(), mine.name.as_str(), mine.state.as_str()), ("docker:pc-abc123", "pc-abc123", "stopped"));
        assert_eq!(mine.detail, "Apple Containers · docker.io/library/ubuntu:24.04");
        // A running one maps to running; an unlabelled one (the account's other work) is not ours.
        let mut running = item.clone();
        running["status"]["state"] = serde_json::json!("running");
        assert_eq!(apple_machine(&running).unwrap().state, "running");
        let mut other = item.clone();
        other["configuration"]["labels"] = serde_json::json!({});
        assert_eq!(apple_machine(&other), None);
        assert_eq!(apple_machine(&serde_json::json!({"id":"x","configuration":{"labels":{}}})), None);
    }

    #[test]
    fn endpoints_select_the_transport() {
        // Local daemon: no selection flags at all.
        assert!(docker(None, None).docker_args().is_empty());
        // SSH endpoints never go through -H; they run over cloud/ssh.rs.
        assert!(docker(Some("ssh://me@box"), None).docker_args().is_empty());
        assert!(docker(Some("ssh://me@box"), None).over_ssh());
        // A socket or TCP endpoint rides -H; TLS adds the certificate flags.
        assert_eq!(docker(Some("unix:///run/docker.sock"), None).docker_args(), ["-H".to_string(), "unix:///run/docker.sock".to_string()]);
        let tls = docker(Some("tcp://box:2376"), Some(("ca.pem", "cert.pem", "key.pem")));
        assert_eq!(tls.docker_args(), vec!["-H".to_string(), "tcp://box:2376".to_string(), "--tlsverify".to_string(), "--tlscacert".to_string(), "ca.pem".to_string(), "--tlscert".to_string(), "cert.pem".to_string(), "--tlskey".to_string(), "key.pem".to_string()]);
        assert!(!tls.over_ssh());
    }

    #[test]
    fn ssh_targets_parse_users_hosts_and_ports() {
        assert_eq!(docker(Some("ssh://box"), None).ssh_target().unwrap().host, "box");
        let target = docker(Some("ssh://me@box:2222"), None).ssh_target().unwrap();
        assert_eq!((target.host.as_str(), target.port, target.user), ("box", 2222, "me"));
        assert_eq!(docker(Some("ssh://box"), None).ssh_target().unwrap().user, "root");
        assert!(docker(Some("ssh://box:zzz"), None).ssh_target().is_err());
        assert!(docker(Some("ssh://"), None).ssh_target().is_err());
    }

    #[test]
    fn the_ssh_line_names_the_binary_and_quotes_every_argument() {
        let line = docker(Some("ssh://box"), None).remote_line(&["exec", "pc-x", "sh", "-c", "echo hi && ls"]);
        assert_eq!(line, "'docker' 'exec' 'pc-x' 'sh' '-c' 'echo hi && ls'");
        assert!(docker(Some("ssh://box"), None).remote_line(&["version"]).starts_with("'docker' "));
    }

    #[test]
    fn lists_containers_from_ndjson() {
        let output = concat!(
            r#"{"Command":"\"sleep infinity\"","ID":"abc123def","Image":"ubuntu:24.04","Names":"pc-abc123def","State":"running","Status":"Up"}"#, "\n",
            r#"{"Command":"\"sleep infinity\"","ID":"fff000","Image":"ubuntu:24.04","Names":"pc-fff000","State":"exited","Status":"Exited"}"#, "\n",
            "not json at all\n",
        );
        let machines = parse_list(output);
        // The name is the native ID, so state() finds what create() made.
        assert_eq!(machines.iter().map(|m| (m.id.as_str(), m.name.as_str(), m.state.as_str())).collect::<Vec<_>>(), vec![("docker:pc-abc123def", "pc-abc123def", "running"), ("docker:pc-fff000", "pc-fff000", "stopped")]);
        assert_eq!(machines[0].detail, "Docker · ubuntu:24.04");
        assert!(!machines[0].desktop && machines[0].os == "linux");
        assert_eq!(machine(&serde_json::json!({"ID":"x","Names":"x","State":"weird"})).unwrap().state, "error");
    }

    #[test]
    fn names_are_hostnames() {
        assert_eq!(valid_name("pc-1").unwrap(), "pc-1");
        assert!(valid_name("Pc-1").is_err() && valid_name("-pc").is_err() && valid_name("pc-").is_err() && valid_name("").is_err());
    }

    #[test]
    fn connect_validates_the_endpoint_and_engine() {
        assert!(connect(&serde_json::json!({"endpoint": "ftp://box"})).is_err());
        assert!(connect(&serde_json::json!({"endpoint": "tcp://box:2376", "tlsCa": "ca.pem"})).is_err());
        assert!(connect(&serde_json::json!({"endpoint": "tcp://box:2376", "tlsCa": "ca", "tlsCert": "c"})).is_err());
        assert!(connect(&serde_json::json!({"engine": "apple", "endpoint": "ssh://box"})).is_err());
        assert!(connect(&serde_json::json!({"engine": "lxc", "endpoint": "ssh://box"})).is_err());
        // Podman takes ssh:// and unix:// endpoints; only tcp:// is refused, by name.
        assert!(connect(&serde_json::json!({"engine": "podman", "endpoint": "tcp://box:2376"})).unwrap_err().contains("Podman remote hosts take an ssh:// endpoint"));
        // The happy paths reach for the daemon, which CI cannot run; only shape checks here.
    }

    #[test]
    fn connected_rebuilds_the_saved_engine() {
        let mut settings = super::super::settings();
        settings.providers.insert("docker".into(), std::collections::BTreeMap::from([("engine".into(), "podman".into())]));
        super::super::save_settings(&settings).unwrap();
        assert_eq!(Docker::connected().unwrap().binary(), "podman");
        // Restore for the other tests sharing the memory store.
        let mut settings = super::super::settings();
        settings.providers.remove("docker");
        super::super::save_settings(&settings).unwrap();
    }

    /// Needs a working local docker; run with `cargo test docker_live -- --ignored`.
    #[test]
    #[ignore]
    fn docker_live() {
        let api = Docker::new(None, None, None, Engine::Docker);
        Sandbox::create(&api, "pandacode-smoke").unwrap();
        let run = || -> Result<()> {
            assert_eq!(Sandbox::exec(&api, "pandacode-smoke", "echo hi", Duration::from_secs(30))?, (Some(0), "hi\n".into()));
            Sandbox::spawn(&api, "pandacode-smoke", "sleep 120")?;
            let (_, ps) = Sandbox::exec(&api, "pandacode-smoke", "ps -eo args | grep '[s]leep 120'", Duration::from_secs(30))?;
            assert!(ps.contains("sleep 120"), "the detached run must survive its exec session");
            Sandbox::upload(&api, "pandacode-smoke", "/tmp/p.txt", b"x", true)?;
            assert_eq!(Sandbox::download(&api, "pandacode-smoke", "/tmp/p.txt", 0, 10)?, b"x");
            Ok(())
        };
        let result = run();
        Sandbox::power(&api, "pandacode-smoke", "delete").unwrap();
        result.unwrap();
    }
}
