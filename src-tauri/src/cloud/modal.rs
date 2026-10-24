//! Modal sandboxes for cloud agents (docs/cloud-agents.md). Modal exposes sandboxes only
//! through its gRPC SDKs (https://modal.com/docs/reference/modal.Sandbox), so, as AWS uses
//! the user's AWS CLI, PandaCode drives the user's own `modal` Python package through the
//! small helper in `modal_helper.py` (one JSON request on stdin, one reply on stdout). The
//! token goes only into that process's environment.
//!
//! Sandboxes live in the app `pandacode`, tagged `pandacode=sandbox`, on Debian slim with git
//! and curl. Modal can't stop or restart a sandbox, nor extend its timeout, so each is
//! created with the 24 h maximum and its PID 1 is a watchdog that exits (ending the
//! sandbox) at the deadline `keep_alive` writes.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    io::BufRead,
    path::PathBuf,
    process::Command,
    time::Duration,
};

use super::sandbox::{checked, Info, Sandbox};
use super::Machine;
use crate::workspace::run_process_with_input;

type Result<T> = std::result::Result<T, String>;

const HELPER: &str = include_str!("modal_helper.py");
const MAX_MINUTES: u32 = 24 * 60;
/// Minutes left before the timeout under which a sandbox is too old for a new run.
const RECREATE_BELOW: i64 = 30;
const QUICK: Duration = Duration::from_secs(120);
const INSTALL: &str = "The Modal Python client is not installed. Run `python3 -m pip install modal` (or `pipx install modal`), then try again.";

pub struct Modal {
    python: PathBuf,
    token_id: String,
    secret: String,
    environment: Option<String>,
}

/// The interpreter behind the `modal` CLI (pipx and uv installs have their own), else python3.
fn python() -> Result<PathBuf> {
    let from_cli = crate::token_saver::find_tool("modal")
        .and_then(|cli| std::fs::File::open(cli).ok())
        .and_then(|file| std::io::BufReader::new(file).lines().next()?.ok())
        .and_then(|line| line.strip_prefix("#!").map(|path| PathBuf::from(path.trim())))
        .filter(|path| path.is_file());
    from_cli.or_else(|| crate::token_saver::find_tool("python3")).ok_or_else(|| INSTALL.to_string())
}

fn machine(id: &str, name: &str) -> Machine {
    Machine {
        id: format!("modal:{id}"),
        provider: "modal".into(),
        name: if name.is_empty() { id } else { name }.to_string(),
        state: "running".into(),
        os: "linux".into(),
        desktop: false,
        detail: "Modal · Debian · ends 24 h after creation".into(),
    }
}

impl Modal {
    fn connected() -> Result<Self> {
        let secret = super::secret("modal_key").ok_or("Connect Modal in Settings → Cloud first.")?;
        let options = super::settings().providers.get("modal").cloned().unwrap_or_default();
        let token_id = options.get("tokenId").cloned().ok_or("Connect Modal in Settings → Cloud first.")?;
        Ok(Modal { python: python()?, token_id, secret, environment: options.get("environment").cloned() })
    }

    fn call(&self, request: Value, timeout: Duration) -> Result<Value> {
        let mut command = Command::new(&self.python);
        command.args(["-c", HELPER]).env("MODAL_TOKEN_ID", &self.token_id).env("MODAL_TOKEN_SECRET", &self.secret).env_remove("MODAL_PROFILE").env_remove("MODAL_ENVIRONMENT");
        if let Some(environment) = &self.environment {
            command.env("MODAL_ENVIRONMENT", environment);
        }
        let out = run_process_with_input(command, "Modal", 16 << 20, timeout, Some(request.to_string().as_bytes()))?;
        let stdout = String::from_utf8_lossy(&out.stdout.bytes);
        let Some(reply) = stdout.lines().rev().find_map(|line| serde_json::from_str::<Value>(line).ok()) else {
            let stderr = String::from_utf8_lossy(&out.stderr.bytes);
            return Err(format!("Modal: {}", stderr.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("the helper did not answer.").trim()));
        };
        match reply["error"].as_str() {
            Some("missing-modal") => Err(INSTALL.into()),
            Some(error) if error.starts_with("AuthError") => Err("Modal refused the token. Check the token ID and secret in Settings → Cloud.".into()),
            Some(error) => Err(format!("Modal: {}", error.chars().take(400).collect::<String>())),
            None => Ok(reply),
        }
    }

    /// Whether the sandbox runs, and seconds until Modal's timeout ends it (unknown for
    /// sandboxes created before PandaCode tagged the expiry).
    fn status(&self, native: &str) -> Result<(bool, Option<i64>)> {
        let reply = self.call(json!({"op": "running", "id": native}), QUICK)?;
        Ok((reply["running"] == true, reply["remaining"].as_i64()))
    }

    fn run(&self, native: &str, command: &str, stdin: Option<&[u8]>, timeout: Duration) -> Result<(Option<i32>, String)> {
        let mut request = json!({"op": "exec", "id": native, "command": command, "timeout": timeout.as_secs().max(1)});
        if let Some(bytes) = stdin {
            request["stdin"] = STANDARD.encode(bytes).into();
        }
        let reply = self.call(request, timeout + Duration::from_secs(90))?;
        Ok((reply["code"].as_i64().map(|code| code as i32), reply["output"].as_str().unwrap_or_default().to_string()))
    }
}

impl Sandbox for Modal {
    fn info(&self) -> Info {
        Info { persistent: false, max_unattended_minutes: MAX_MINUTES }
    }
    fn list(&self) -> Result<Vec<Machine>> {
        let reply = self.call(json!({"op": "list"}), QUICK)?;
        Ok(reply["sandboxes"].as_array().into_iter().flatten().map(|s| machine(s["id"].as_str().unwrap_or_default(), s["name"].as_str().unwrap_or_default())).collect())
    }
    fn create(&self, name: &str) -> Result<Machine> {
        let reply = self.call(json!({"op": "create", "name": name}), Duration::from_secs(600))?;
        Ok(machine(reply["id"].as_str().ok_or("Modal did not report the new sandbox.")?, name))
    }
    fn power(&self, native: &str, action: &str) -> Result<()> {
        match action {
            "stop" | "delete" => self.call(json!({"op": "terminate", "id": native}), QUICK).map(|_| ()),
            _ => Err("Modal sandboxes can't be restarted. Create a new one.".into()),
        }
    }
    /// "error" once the sandbox is near its 24 h end, so a new run recreates it.
    fn state(&self, native: &str) -> Result<String> {
        let (running, remaining) = self.status(native)?;
        Ok(match (running, remaining) {
            (true, Some(seconds)) if seconds < RECREATE_BELOW * 60 => "error",
            (true, _) => "running",
            _ => "stopped",
        }.into())
    }
    fn exec(&self, native: &str, command: &str, timeout: Duration) -> Result<(Option<i32>, String)> {
        self.run(native, command, None, timeout)
    }
    fn keep_alive(&self, native: &str, minutes: u32) -> Result<()> {
        let seconds = minutes.min(MAX_MINUTES) as i64 * 60;
        if let (_, Some(remaining)) = self.status(native)? {
            if seconds > remaining {
                return Err(format!("This Modal sandbox expires in {} minutes; delete it to start a fresh one.", remaining.max(0) / 60));
            }
        }
        checked(self.exec(native, &format!("echo $(( $(date +%s) + {seconds} )) > /tmp/.pandacode-deadline"), Duration::from_secs(60))?)
    }
    /// One helper call with the bytes on stdin, instead of the 48 KiB `exec` chunks.
    fn upload(&self, native: &str, path: &str, bytes: &[u8], private: bool) -> Result<()> {
        let quoted = super::shell_quote(path);
        let command = format!("mkdir -p \"$(dirname {quoted})\" && umask {} && cat > {quoted}", if private { "077" } else { "022" });
        checked(self.run(native, &command, Some(bytes), Duration::from_secs(300))?)
    }
}

pub fn connect(key: &str, options: &Value) -> Result<()> {
    let token_id = options["tokenId"].as_str().map(str::trim).filter(|t| !t.is_empty()).ok_or("Enter the Modal token ID (ak-…) with its secret.")?;
    let environment = options["environment"].as_str().map(str::trim).filter(|e| !e.is_empty()).map(str::to_string);
    let modal = Modal { python: python()?, token_id: token_id.into(), secret: key.trim().into(), environment: environment.clone() };
    modal.call(json!({"op": "check"}), QUICK)?;
    super::set_secret("modal_key", key.trim())?;
    let mut options = BTreeMap::from([("tokenId".to_string(), token_id.to_string()), ("detail".to_string(), format!("Token {token_id}"))]);
    if let Some(environment) = environment {
        options.insert("detail".into(), format!("Token {token_id} · {environment}"));
        options.insert("environment".into(), environment);
    }
    let mut settings = super::settings();
    settings.providers.insert("modal".into(), options);
    super::save_settings(&settings)
}
pub fn disconnect() -> Result<()> {
    super::remove_secret("modal_key");
    let mut settings = super::settings();
    settings.providers.remove("modal");
    super::save_settings(&settings)
}
pub fn sandbox() -> Result<Box<dyn Sandbox>> {
    Ok(Box::new(Modal::connected()?))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fake `modal` package that records what the helper asked for.
    const FAKE: &str = r#"
import os
calls = []
class App:
    app_id = "ap-1"
    @staticmethod
    def lookup(name, create_if_missing, environment_name):
        assert name == "pandacode" and create_if_missing
        assert os.environ["MODAL_TOKEN_ID"] == "ak-1" and os.environ["MODAL_TOKEN_SECRET"] == "as-2"
        assert environment_name == "dev"
        return App()
class Image:
    @staticmethod
    def debian_slim(): return Image()
    def apt_install(self, *packages):
        assert "git" in packages and "curl" in packages
        return self
class _Out:
    def __init__(self, text): self.text = text
    def read(self): return self.text
class _In:
    def __init__(self): self.data = b""
    def write(self, data): self.data += data
    def write_eof(self): pass
    def drain(self): pass
class _Process:
    def __init__(self, command):
        self.stdin = _In()
        self.command = command
        self.returncode = None
    @property
    def stdout(self): return _Out("ran " + self.command.split("\n", 1)[1] + (" with " + self.stdin.data.decode() if self.stdin.data else ""))
    def wait(self): self.returncode = 7
class Sandbox:
    object_id = "sb-1"
    @staticmethod
    def create(*command, app, image, timeout, cpu, memory):
        assert command[:2] == ("sh", "-c") and "pandacode-deadline" in command[2] and timeout == 86400
        return Sandbox()
    @staticmethod
    def list(app_id, tags):
        assert app_id == "ap-1" and tags == {"pandacode": "sandbox"}
        return [Sandbox()]
    @staticmethod
    def from_id(id):
        assert id == "sb-1"
        return Sandbox()
    def set_tags(self, tags):
        import time
        assert tags.pop("expires") == str(int(time.time()) + 86400) and tags == {"pandacode": "sandbox", "name": "box"}
    def get_tags(self):
        # Seconds left before the timeout, written by the test into `left` beside this package.
        import time
        left = os.path.join(os.path.dirname(__file__), "left")
        if not os.path.exists(left): return {"name": "box"}
        return {"name": "box", "expires": str(int(time.time()) + int(open(left).read()))}
    def poll(self): return None
    def terminate(self): pass
    def exec(self, *args, timeout):
        assert args[:2] == ("sh", "-c") and args[2].startswith("exec 2>&1\n")
        return _Process(args[2])
"#;

    fn fake(package: &str) -> Option<(Modal, tempfile_dir::Dir)> {
        // The fake interpreter is a `sh` wrapper; Windows has no shell script runner.
        if !cfg!(unix) {
            return None;
        }
        let python3 = crate::token_saver::find_tool("python3")?;
        let dir = tempfile_dir::Dir::new();
        std::fs::create_dir_all(dir.0.join("modal")).unwrap();
        std::fs::write(dir.0.join("modal/__init__.py"), package).unwrap();
        let wrapper = dir.0.join("python");
        std::fs::write(&wrapper, format!("#!/bin/sh\nPYTHONPATH='{}' exec '{}' \"$@\"\n", dir.0.display(), python3.display())).unwrap();
        #[cfg(unix)]
        std::fs::set_permissions(&wrapper, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        Some((Modal { python: wrapper, token_id: "ak-1".into(), secret: "as-2".into(), environment: Some("dev".into()) }, dir))
    }

    mod tempfile_dir {
        pub struct Dir(pub std::path::PathBuf);
        impl Dir {
            pub fn new() -> Self {
                let path = std::env::temp_dir().join(format!("pandacode-modal-{}", uuid::Uuid::new_v4()));
                std::fs::create_dir_all(&path).unwrap();
                Dir(path)
            }
        }
        impl Drop for Dir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }

    #[test]
    fn the_helper_speaks_json_to_the_modal_package() {
        let Some((modal, _dir)) = fake(FAKE) else { return };
        assert_eq!(modal.call(json!({"op": "check"}), QUICK).unwrap()["app"], "ap-1");
        assert_eq!(modal.list().unwrap(), vec![machine("sb-1", "box")]);
        assert_eq!(modal.create("box").unwrap().id, "modal:sb-1");
        assert_eq!(modal.state("sb-1").unwrap(), "running");
        assert_eq!(modal.exec("sb-1", "echo hi", Duration::from_secs(5)).unwrap(), (Some(7), "ran echo hi".to_string()));
        modal.power("sb-1", "delete").unwrap();
        assert!(modal.power("sb-1", "start").is_err());
        // The upload rides stdin; the fake echoes it back with exit code 7, so it counts as failed.
        let error = modal.upload("sb-1", "/root/a b", b"data", true).unwrap_err();
        assert!(error.contains("umask 077 && cat > '/root/a b' with data"), "{error}");
        assert!(modal.call(json!({"op": "nope", "id": "sb-1"}), QUICK).unwrap_err().contains("unknown request"));
    }

    #[test]
    fn old_sandboxes_refuse_long_runs_and_report_error_near_their_end() {
        let Some((modal, dir)) = fake(FAKE) else { return };
        let left = |seconds: u32| std::fs::write(dir.0.join("modal/left"), seconds.to_string()).unwrap();
        left(4 * 3600);
        assert_eq!(modal.state("sb-1").unwrap(), "running");
        let error = modal.keep_alive("sb-1", 5 * 60).unwrap_err();
        assert!(error.contains("expires in 239 minutes") || error.contains("expires in 240 minutes"), "{error}");
        left(29 * 60);
        assert_eq!(modal.state("sb-1").unwrap(), "error");
    }

    #[test]
    fn a_missing_modal_package_says_how_to_install_it() {
        let Some((modal, _dir)) = fake("raise ImportError('no modal')") else { return };
        assert_eq!(modal.call(json!({"op": "check"}), QUICK).unwrap_err(), INSTALL);
    }

    #[test]
    #[ignore = "needs MODAL_TOKEN_ID, MODAL_TOKEN_SECRET and the modal package"]
    fn live_modal_check() {
        let (Ok(token_id), Ok(secret)) = (std::env::var("MODAL_TOKEN_ID"), std::env::var("MODAL_TOKEN_SECRET")) else { return };
        let modal = Modal { python: python().unwrap(), token_id, secret, environment: std::env::var("MODAL_ENVIRONMENT").ok() };
        modal.call(json!({"op": "check"}), QUICK).unwrap();
        modal.list().unwrap();
    }
}
