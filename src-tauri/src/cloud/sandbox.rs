//! One interface over every cloud sandbox provider, so cloud agents (docs/cloud-agents.md)
//! can prepare a machine, run a detached agent in it and read its output the same way on
//! Daytona, Cloudflare, AWS, E2B, Modal and the rest. Calls are blocking; run them from
//! `crate::blocking` or a worker thread.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::Value;
use std::time::Duration;

use super::{aws::Aws, cloudflare::Cloudflare, daytona::Daytona, http::block, Machine};
use crate::Result;

/// Bytes of file content per `exec` call when a provider has no file API. Base64 grows it
/// by 4/3 (44 KiB → 58.7 KiB), so a full command with its paths stays under 60 KiB.
pub const CHUNK: usize = 44 * 1024;
/// The most a command built around one chunk may take (the `exec` contract is < 64 KiB).
pub const COMMAND_MAX: usize = 60 * 1024;

/// What cloud agents need to know about a provider's machines.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Info {
    /// Files (the checkout, installed CLIs, `~/.claude`) survive stop/start. When false, a
    /// stopped machine is recreated and rehydrated from the local mirror worktree.
    pub persistent: bool,
    /// The longest a machine keeps running without any client request, in minutes, once
    /// `keep_alive` asked for it; caps the time an agent can work while the laptop sleeps.
    pub max_unattended_minutes: u32,
}

/// A connected provider. `native` is the ID after `provider:`.
///
/// Contract for `exec`: run `command` with `sh -c` (bash where available) as a user whose
/// HOME is writable, wait for it, and return the exit code and the combined stdout+stderr
/// (at least 4 MiB kept). Commands stay under 64 KiB. Background processes started with
/// `setsid nohup … &` must survive the call returning.
pub trait Sandbox: Send + Sync {
    fn info(&self) -> Info;
    fn list(&self) -> Result<Vec<Machine>>;
    /// A new Linux machine (x86_64 or arm64) with git, curl and sh. `name` is a short slug.
    fn create(&self, name: &str) -> Result<Machine>;
    /// `start`, `stop` or `delete`. Stop may pause/snapshot; providers without stop delete.
    fn power(&self, native: &str, action: &str) -> Result<()>;
    /// Current state as in [`Machine::state`]: running, stopped, starting, stopping, error.
    fn state(&self, native: &str) -> Result<String> {
        self.list()?.into_iter().find(|m| m.id.split_once(':').is_some_and(|(_, id)| id == native)).map(|m| m.state).ok_or_else(|| "That cloud machine no longer exists.".into())
    }
    fn exec(&self, native: &str, command: &str, timeout: Duration) -> Result<(Option<i32>, String)>;
    /// Keep the machine running for at least `minutes` with no client requests (extend a
    /// timeout, turn off auto-stop…), capped at `info().max_unattended_minutes`. Called at
    /// every run start and with a short value after a run ends, so idle machines stop.
    fn keep_alive(&self, native: &str, minutes: u32) -> Result<()>;
    /// Start `command` detached so it outlives the call (and any later client).
    fn spawn(&self, native: &str, command: &str) -> Result<()> {
        let script = format!("setsid nohup sh -c {} >/dev/null 2>&1 </dev/null &", super::shell_quote(command));
        checked(self.exec(native, &script, Duration::from_secs(60))?)
    }
    /// Write a file (parents created, mode 0600 when `private`).
    fn upload(&self, native: &str, path: &str, bytes: &[u8], private: bool) -> Result<()> {
        let quoted = super::shell_quote(path);
        let mut first = true;
        for piece in bytes.chunks(CHUNK).chain(bytes.is_empty().then_some(&[][..])) {
            let (redirect, setup) = if first { (">", format!("mkdir -p \"$(dirname {quoted})\" && umask {} && ", if private { "077" } else { "022" })) } else { (">>", String::new()) };
            let command = format!("{setup}printf %s {} | base64 -d {redirect} {quoted}", STANDARD.encode(piece));
            checked(self.exec(native, &command, Duration::from_secs(120))?)?;
            first = false;
        }
        Ok(())
    }
    /// Read up to `max` bytes (callers keep it ≤ 128 KiB) of a file from `offset`; empty past the end or when missing.
    fn download(&self, native: &str, path: &str, offset: u64, max: usize) -> Result<Vec<u8>> {
        let command = format!("[ -f {p} ] && tail -c +{} {p} 2>/dev/null | head -c {max} | base64 2>/dev/null | tr -d '\\n'", offset + 1, p = super::shell_quote(path));
        let (code, output) = self.exec(native, &command, Duration::from_secs(120))?;
        if code != Some(0) && output.trim().is_empty() {
            return Ok(Vec::new());
        }
        STANDARD.decode(output.trim()).map_err(|_| "The cloud machine sent a file PandaCode could not read.".into())
    }
}

fn download_command(path: &str, offset: u64, max: usize) -> String {
    format!("[ -f {p} ] && tail -c +{} {p} 2>/dev/null | head -c {max} | base64 2>/dev/null | tr -d '\\n'", offset + 1, p = super::shell_quote(path))
}

pub fn checked((code, output): (Option<i32>, String)) -> Result<()> {
    match code {
        Some(0) => Ok(()),
        _ => Err(format!("The cloud command failed: {}", output.trim().chars().rev().take(400).collect::<String>().chars().rev().collect::<String>())),
    }
}

/// Every provider cloud agents can run on, with its display name.
pub const AGENT_PROVIDERS: [(&str, &str); 15] = [
    ("daytona", "Daytona"),
    ("cloudflare", "Cloudflare"),
    ("aws", "AWS EC2"),
    ("gcloud", "Google Cloud"),
    ("e2b", "E2B"),
    ("modal", "Modal"),
    ("vercel", "Vercel Sandbox"),
    ("codesandbox", "CodeSandbox"),
    ("runloop", "Runloop"),
    ("blaxel", "Blaxel"),
    ("tensorlake", "Tensorlake"),
    ("freestyle", "Freestyle"),
    ("railway", "Railway"),
    ("boat", "boat"),
    ("agentcore", "AWS AgentCore"),
];

/// The connected sandbox behind a provider ID (as used before the `:` of a machine ID).
pub fn connected(provider: &str) -> Result<Box<dyn Sandbox>> {
    Ok(match provider {
        "daytona" => Box::new(Daytona::connected()?),
        "cloudflare" => Box::new(Cloudflare::connected()?),
        "aws" => Box::new(Aws::connected()?),
        "gcloud" => super::gcloud_vm::sandbox()?,
        "e2b" => super::e2b::sandbox()?,
        "modal" => super::modal::sandbox()?,
        "vercel" => super::vercel_sandbox::sandbox()?,
        "codesandbox" => super::codesandbox::sandbox()?,
        "runloop" => super::runloop::sandbox()?,
        "blaxel" => super::blaxel::sandbox()?,
        "tensorlake" => super::tensorlake::sandbox()?,
        "freestyle" => super::freestyle::sandbox()?,
        "railway" => super::railway_sandbox::sandbox()?,
        "boat" => super::boat::sandbox()?,
        _ => return Err("This provider can't run cloud agents.".into()),
    })
}

/// Settings → Cloud for the providers added with cloud agents: check, then save. Daytona,
/// Cloudflare, AWS, Vercel, Railway and Google Cloud keep their own arms in `commands`.
pub fn connect(provider: &str, key: &str, options: &Value) -> Result<()> {
    match provider {
        "e2b" => super::e2b::connect(key, options),
        "modal" => super::modal::connect(key, options),
        "codesandbox" => super::codesandbox::connect(key, options),
        "runloop" => super::runloop::connect(key, options),
        "blaxel" => super::blaxel::connect(key, options),
        "tensorlake" => super::tensorlake::connect(key, options),
        "freestyle" => super::freestyle::connect(key, options),
        "boat" => super::boat::connect(key, options),
        _ => Err("Unknown cloud provider.".into()),
    }
}
pub fn disconnect(provider: &str) -> Result<()> {
    match provider {
        "e2b" => super::e2b::disconnect(),
        "modal" => super::modal::disconnect(),
        "codesandbox" => super::codesandbox::disconnect(),
        "runloop" => super::runloop::disconnect(),
        "blaxel" => super::blaxel::disconnect(),
        "tensorlake" => super::tensorlake::disconnect(),
        "freestyle" => super::freestyle::disconnect(),
        "boat" => super::boat::disconnect(),
        _ => Err("Unknown cloud provider.".into()),
    }
}
/// Providers whose connect/disconnect live in this registry.
pub const KEYED: [&str; 8] = ["e2b", "modal", "codesandbox", "runloop", "blaxel", "tensorlake", "freestyle", "boat"];

/// Whether a provider is connected well enough to run cloud agents (no network call).
pub fn ready(provider: &str) -> bool {
    match provider {
        "daytona" => Daytona::connected().is_ok(),
        "cloudflare" => Cloudflare::connected().is_ok(),
        "aws" => Aws::connected().is_ok(),
        // Railway has no command API (cloud/railway_sandbox.rs), so it can't host an agent.
        "agentcore" | "railway" => false,
        _ => connected(provider).is_ok(),
    }
}

impl Sandbox for Daytona {
    fn info(&self) -> Info {
        Info { persistent: true, max_unattended_minutes: 24 * 60 }
    }
    fn list(&self) -> Result<Vec<Machine>> {
        block(Daytona::list(self))
    }
    fn create(&self, name: &str) -> Result<Machine> {
        block(Daytona::create(self, name))
    }
    fn power(&self, native: &str, action: &str) -> Result<()> {
        block(Daytona::power(self, native, action))
    }
    fn exec(&self, native: &str, command: &str, timeout: Duration) -> Result<(Option<i32>, String)> {
        block(Daytona::exec(self, native, command, timeout))
    }
    fn keep_alive(&self, native: &str, minutes: u32) -> Result<()> {
        block(self.auto_stop(native, minutes))
    }
}

impl Sandbox for Cloudflare {
    fn info(&self) -> Info {
        Info { persistent: false, max_unattended_minutes: 24 * 60 }
    }
    fn list(&self) -> Result<Vec<Machine>> {
        block(Cloudflare::list(self, &super::settings().cloudflare_sandboxes))
    }
    fn create(&self, name: &str) -> Result<Machine> {
        super::commands::create("cloudflare", name)
    }
    fn power(&self, native: &str, action: &str) -> Result<()> {
        super::commands::power(&format!("cloudflare:{native}"), action)
    }
    fn exec(&self, native: &str, command: &str, timeout: Duration) -> Result<(Option<i32>, String)> {
        block(Cloudflare::exec(self, native, command, timeout))
    }
    fn keep_alive(&self, native: &str, minutes: u32) -> Result<()> {
        block(Cloudflare::keep_alive(self, native, minutes))
    }
    /// Reads stdout only: `exec` appends a `[stderr]` section that would break the base64.
    fn download(&self, native: &str, path: &str, offset: u64, max: usize) -> Result<Vec<u8>> {
        let command = download_command(path, offset, max);
        let (code, output) = block(Cloudflare::exec_stdout(self, native, &command, Duration::from_secs(120)))?;
        if code != Some(0) && output.trim().is_empty() {
            return Ok(Vec::new());
        }
        STANDARD.decode(output.trim()).map_err(|_| "The cloud machine sent a file PandaCode could not read.".into())
    }
}

impl Sandbox for Aws {
    fn info(&self) -> Info {
        Info { persistent: true, max_unattended_minutes: 24 * 60 }
    }
    fn list(&self) -> Result<Vec<Machine>> {
        Ok(Aws::list(self)?.into_iter().filter(|m| m.os == "linux").collect())
    }
    fn create(&self, name: &str) -> Result<Machine> {
        super::commands::create("aws-linux", name)
    }
    fn power(&self, native: &str, action: &str) -> Result<()> {
        super::commands::power(&format!("aws:{native}"), action)
    }
    fn exec(&self, native: &str, command: &str, timeout: Duration) -> Result<(Option<i32>, String)> {
        Aws::exec(self, native, false, command, timeout)
    }
    /// EC2 runs until stopped; cloud agents stop it themselves after an idle run end.
    fn keep_alive(&self, _native: &str, _minutes: u32) -> Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// Records every command and runs none.
    #[derive(Default)]
    struct Recorder(Mutex<Vec<String>>);
    impl Sandbox for Recorder {
        fn info(&self) -> Info {
            Info { persistent: true, max_unattended_minutes: 1 }
        }
        fn list(&self) -> Result<Vec<Machine>> {
            Ok(Vec::new())
        }
        fn create(&self, _name: &str) -> Result<Machine> {
            Err("no".into())
        }
        fn power(&self, _native: &str, _action: &str) -> Result<()> {
            Ok(())
        }
        fn exec(&self, _native: &str, command: &str, _timeout: Duration) -> Result<(Option<i32>, String)> {
            self.0.lock().unwrap().push(command.to_owned());
            Ok((Some(0), String::new()))
        }
        fn keep_alive(&self, _native: &str, _minutes: u32) -> Result<()> {
            Ok(())
        }
    }

    #[test]
    fn uploads_split_into_commands_under_60_kib() {
        let recorder = Recorder::default();
        let path = format!("/home/user/{}/file", "long-folder-name/".repeat(10));
        recorder.upload("m", &path, &vec![7u8; 3 * CHUNK + 5], true).unwrap();
        let commands = recorder.0.lock().unwrap();
        assert_eq!(commands.len(), 4);
        assert!(commands.iter().all(|command| command.len() < COMMAND_MAX), "{:?}", commands.iter().map(String::len).collect::<Vec<_>>());
    }
}

#[cfg(test)]
mod cloudflare_tests {
    use super::*;
    use crate::cloud::http::mock;

    #[test]
    fn cloudflare_uploads_and_downloads_ignore_stderr_and_fit_the_worker_cap() {
        let (base, seen) = mock::serve(|request, _| -> (u16, String) {
            if request.body.contains("tail -c") {
                (200, r#"{"exitCode":0,"stdout":"aGVsbG8=","stderr":"warning","truncated":false}"#.into())
            } else {
                (200, r#"{"exitCode":0,"stdout":"","stderr":"","truncated":false}"#.into())
            }
        });
        let cf = Cloudflare::new(base, "t".into());
        assert_eq!(Sandbox::download(&cf, "a", "/x", 0, 10).unwrap(), b"hello");
        Sandbox::upload(&cf, "a", "/x", &vec![7u8; 100 * 1024], true).unwrap();
        let log = seen.lock().unwrap();
        let commands: Vec<String> = log.iter().map(|r| serde_json::from_str::<Value>(&r.body).unwrap()["command"].as_str().unwrap().to_string()).collect();
        assert_eq!(commands.len(), 4);
        assert!(commands.iter().all(|c| c.len() <= 65536));
    }
}
