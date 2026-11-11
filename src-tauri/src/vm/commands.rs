//! IPC for the inspector's VM panel.
use serde::Serialize;
use serde_json::Value;
use std::path::PathBuf;
use tauri::{ipc::Response, AppHandle, Emitter, Manager};

use super::{backend, backend::HostIssue, screen, Image, VmStatus, Vms};
use crate::Result;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// This computer can run local VMs at all.
    pub supported: bool,
    pub installed: bool,
    /// `tart` or `lima`.
    pub engine: &'static str,
    /// Something the user must fix first; nothing starts until they have.
    pub host_issue: Option<HostIssue>,
    pub vms: Vec<VmStatus>,
    pub shown: Option<String>,
    pub images: Vec<Image>,
}

pub fn status(vms: &Vms) -> Result<Status> {
    let backend = backend();
    let supported = backend.supported();
    let installed = supported && backend.installed();
    Ok(Status { supported, installed, engine: backend.id(), host_issue: if supported { backend.host_issue() } else { None }, vms: if installed { vms.list()? } else { Vec::new() }, shown: vms.shown(), images: backend.images().to_vec() })
}
fn name(value: &str) -> Result<String> {
    super::check_name(value)?;
    Ok(value.to_string())
}

#[tauri::command]
pub async fn vm_status(app: AppHandle) -> Result<Status> {
    crate::blocking(move || status(&app.state::<Vms>())).await
}

#[tauri::command]
pub async fn vm_show(app: AppHandle, name: Option<String>) -> Result<Status> {
    let name = name.map(|n| self::name(&n)).transpose()?;
    crate::blocking(move || {
        let vms = app.state::<Vms>();
        vms.show(name);
        status(&vms)
    })
    .await
}

#[tauri::command]
pub async fn vm_create(app: AppHandle, image: String, name: String) -> Result<Status> {
    crate::blocking(move || {
        let vms = app.state::<Vms>();
        // A new VM starts at once, shown and claimed throughout; Linux ones then get their desktop.
        vms.create_and_start(&image, &name)?;
        super::desktop::ensure_in_background(app.clone(), name);
        let _ = app.emit("vm-changed", serde_json::json!({}));
        status(&vms)
    })
    .await
}

/// `start` optionally shares a project folder read-only at the guest's `project` mount.
#[tauri::command]
pub async fn vm_power(app: AppHandle, name: String, action: String, share: Option<String>) -> Result<Status> {
    let name = self::name(&name)?;
    let share = share.map(PathBuf::from).filter(|path| path.is_absolute() && path.is_dir());
    crate::blocking(move || {
        let vms = app.state::<Vms>();
        match action.as_str() {
            "start" => {
                vms.start(&name, share.as_deref())?;
                super::desktop::ensure_in_background(app.clone(), name.clone());
            }
            "stop" => vms.stop(&name)?,
            "suspend" => vms.suspend(&name)?,
            "delete" => vms.delete(&name)?,
            _ => return Err("Unknown VM action.".into()),
        }
        let _ = app.emit("vm-changed", serde_json::json!({}));
        status(&vms)
    })
    .await
}

/// The current screen as JPEG, scaled like the agent's screenshots so input coordinates match.
#[tauri::command]
pub async fn vm_frame(app: AppHandle, name: String) -> Result<Response> {
    let name = self::name(&name)?;
    crate::blocking(move || {
        let shot = app.state::<Vms>().with_screen(&name, false, |rfb| screen::screenshot(rfb, 70))?;
        Ok(Response::new(shot.jpeg))
    })
    .await
}

#[tauri::command]
pub async fn vm_input(app: AppHandle, name: String, input: Value) -> Result<String> {
    let name = self::name(&name)?;
    let action = super::tools::action(&input)?;
    crate::blocking(move || app.state::<Vms>().with_screen(&name, true, |rfb| screen::act(rfb, &action))).await
}

/// Give a console-only Linux VM a light desktop for computer use (a few minutes, ~400 MB).
#[tauri::command]
pub async fn vm_desktop(app: AppHandle, name: String) -> Result<String> {
    let name = self::name(&name)?;
    crate::blocking(move || super::tools::install_desktop(&app.state::<Vms>(), &name)).await
}
