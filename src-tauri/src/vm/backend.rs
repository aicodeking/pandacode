//! The engine under local VMs. `Vms`, the tools and the panel only see this trait; what
//! a machine is, where its screen lives and how commands reach it belong to the backend.
use serde::Serialize;
use std::{
    net::SocketAddr,
    path::{Path, PathBuf},
    process::Child,
    time::{Duration, Instant},
};

use super::{lima::Lima, tart::Tart, Image};

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Vm {
    pub name: String,
    pub running: bool,
    pub size_gb: u64,
    pub disk_gb: u64,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Details {
    pub os: String,
    pub memory_mb: u64,
    pub cpus: u64,
    pub width: u32,
    pub height: u32,
}

/// What keeps local VMs from running on this computer, with a command that fixes it if there is one.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostIssue {
    pub text: String,
    pub command: Option<String>,
}

pub struct Exec {
    /// None when the command ran out of time.
    pub code: Option<i32>,
    pub timed_out: bool,
    pub stdout: String,
    pub stderr: String,
    pub truncated: bool,
}

/// A booted VM's screen. `child` is the process that holds the VM up, if the backend has one.
pub struct Started {
    pub child: Option<Child>,
    pub password: Option<String>,
    pub address: SocketAddr,
    pub macos: bool,
}

pub trait VmBackend: Sync {
    /// The engine's name for the panel.
    fn id(&self) -> &'static str;
    /// Local VMs are possible on this computer.
    fn supported(&self) -> bool;
    fn installed(&self) -> bool;
    /// One-click setup of the engine; returns the binary it installed.
    fn install(&self) -> Result<PathBuf, String>;
    /// Something the user must fix on this computer first.
    fn host_issue(&self) -> Option<HostIssue> {
        None
    }
    /// Whether any local VM exists: one directory read, never a process.
    fn has_vms(&self) -> bool;
    /// One line for `vm_list` on the engine's state.
    fn engine(&self, installed: bool) -> &'static str;
    /// The `vm_exec` description's middle: the guest's user, and how files reach it.
    fn exec_hint(&self) -> &'static str;
    /// The `vm_list` and `vm_manage` descriptions.
    fn list_text(&self) -> &'static str;
    fn manage_text(&self) -> &'static str;
    fn images(&self) -> &'static [Image];
    fn image(&self, id: &str) -> Result<Image, String> {
        self.images().iter().copied().find(|image| image.id == id).ok_or_else(|| format!("Unknown VM image {id:?}."))
    }
    fn list(&self) -> Result<Vec<Vm>, String>;
    fn details(&self, name: &str) -> Result<Details, String>;
    /// Every VM with its details, if the engine can tell them.
    fn list_details(&self) -> Result<Vec<(Vm, Option<Details>)>, String> {
        Ok(self.list()?.into_iter().map(|vm| {
            let details = self.details(&vm.name).ok();
            (vm, details)
        }).collect())
    }
    fn create(&self, image: &Image, name: &str) -> Result<(), String>;
    /// Boot headless with `share` mounted read-only; returns once the screen answers.
    fn start(&self, name: &str, share: Option<&Path>) -> Result<Started, String>;
    /// A VM that outlived PandaCode: its screen again, if this engine can hand it back.
    fn adopt(&self, _name: &str, _share: Option<&Path>) -> Result<Option<Started>, String> {
        Ok(None)
    }
    fn stop(&self, name: &str) -> Result<(), String>;
    /// Stop on quit, giving up at `deadline`.
    fn stop_by(&self, name: &str, deadline: Instant) -> Result<(), String>;
    fn can_suspend(&self, macos: bool) -> bool;
    fn suspend(&self, name: &str) -> Result<(), String>;
    /// Suspend on quit, giving up at `deadline`.
    fn suspend_by(&self, name: &str, deadline: Instant) -> Result<(), String>;
    fn delete(&self, name: &str) -> Result<(), String>;
    fn exec(&self, name: &str, macos: bool, script: &str, timeout: Duration) -> Result<Exec, String>;
}

/// This build's engine. Windows has none; `Tart::supported` says no there.
pub fn backend() -> &'static dyn VmBackend {
    if cfg!(all(target_os = "linux", any(target_arch = "x86_64", target_arch = "aarch64"))) {
        return &Lima;
    }
    &Tart
}
