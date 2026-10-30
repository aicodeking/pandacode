//! The engine under local VMs. `Vms`, the tools and the panel only see this trait; what
//! a machine is, where its screen lives and how commands reach it belong to the backend.
use serde::Serialize;
use std::{net::SocketAddr, path::Path, process::Child, time::Duration};

use super::{tart::Tart, Image};

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

pub struct Exec {
    pub code: Option<i32>,
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
    /// Local VMs are possible on this computer.
    fn supported(&self) -> bool;
    fn installed(&self) -> bool;
    /// Whether any local VM exists: one directory read, never a process.
    fn has_vms(&self) -> bool;
    /// One line for `vm_list` on the engine's state.
    fn engine(&self, installed: bool) -> &'static str;
    /// The `vm_exec` description's middle: the guest's user, and how files reach it.
    fn exec_hint(&self) -> &'static str;
    fn images(&self) -> &'static [Image];
    fn image(&self, id: &str) -> Result<Image, String> {
        self.images().iter().copied().find(|image| image.id == id).ok_or_else(|| format!("Unknown VM image {id:?}."))
    }
    fn list(&self) -> Result<Vec<Vm>, String>;
    fn details(&self, name: &str) -> Result<Details, String>;
    fn create(&self, image: &Image, name: &str) -> Result<(), String>;
    /// Boot headless with `share` mounted read-only; returns once the screen answers.
    fn start(&self, name: &str, share: Option<&Path>) -> Result<Started, String>;
    fn stop(&self, name: &str) -> Result<(), String>;
    fn can_suspend(&self, macos: bool) -> bool;
    fn suspend(&self, name: &str) -> Result<(), String>;
    fn delete(&self, name: &str) -> Result<(), String>;
    fn exec(&self, name: &str, macos: bool, script: &str, timeout: Duration) -> Result<Exec, String>;
}

/// This build's engine. Another platform's is one `if cfg!(…) { return &…; }` here.
pub fn backend() -> &'static dyn VmBackend {
    &Tart
}
