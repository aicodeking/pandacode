//! IPC for the inspector's Simulator panel. The window shows one device at a time.
use std::time::Duration;
use tauri::{ipc::Response, AppHandle, Manager};

use super::{duo::Pose, Input, Simulators, Status};
use crate::Result;

fn udid(value: &str) -> Result<String> {
    if super::valid_udid(value) { Ok(value.to_string()) } else { Err("Unknown simulator.".into()) }
}

#[tauri::command]
pub async fn simulator_status(app: AppHandle) -> Result<Status> {
    crate::blocking(move || Ok(app.state::<Simulators>().status())).await
}

#[tauri::command]
pub async fn simulator_select(app: AppHandle, udid: Option<String>) -> Result<Status> {
    crate::blocking(move || {
        let sims = app.state::<Simulators>();
        sims.select(udid)?;
        Ok(sims.status())
    })
    .await
}

/// Finds or creates the iPhone Duo simulator and selects it.
#[tauri::command]
pub async fn simulator_create_duo(app: AppHandle) -> Result<Status> {
    crate::blocking(move || {
        let udid = super::duo::create()?;
        let sims = app.state::<Simulators>();
        sims.select(Some(udid))?;
        Ok(sims.status())
    })
    .await
}

/// Fold or unfold an iPhone Duo (`closed`, `book` or `open`) by moving its hinge.
#[tauri::command]
pub async fn simulator_pose(app: AppHandle, udid: String, pose: Pose) -> Result<Status> {
    let udid = self::udid(&udid)?;
    crate::blocking(move || {
        let sims = app.state::<Simulators>();
        // Listing devices again would cost a `simctl` call; the hinge helper fails on a stopped one.
        if !sims.known_duo(&udid) {
            return Err("Only iPhone Duo folds.".into());
        }
        sims.fold(&udid, pose)?;
        Ok(sims.status())
    })
    .await
}

#[tauri::command]
pub async fn simulator_power(app: AppHandle, udid: String, on: bool) -> Result<Status> {
    let udid = self::udid(&udid)?;
    crate::blocking(move || {
        let sims = app.state::<Simulators>();
        sims.forget_screen(&udid);
        if on {
            super::boot(&udid)?;
        } else {
            sims.streams.stop(&udid);
            super::shutdown(&udid)?;
        }
        Ok(sims.status())
    })
    .await
}

/// The newest frame after `after`, long-polled: 8 bytes of little-endian sequence,
/// then the image. Empty when nothing new arrived in time.
#[tauri::command]
pub async fn simulator_frame(app: AppHandle, udid: String, after: u64) -> Result<Response> {
    let udid = self::udid(&udid)?;
    crate::blocking(move || {
        let sims = app.state::<Simulators>();
        let frame = sims.streams.next(&udid, sims.display(&udid), after, Duration::from_millis(1500))?;
        Ok(Response::new(frame.map_or_else(Vec::new, |frame| {
            let mut bytes = Vec::with_capacity(frame.jpeg.len() + 8);
            bytes.extend_from_slice(&frame.seq.to_le_bytes());
            bytes.extend_from_slice(&frame.jpeg);
            bytes
        })))
    })
    .await
}

#[tauri::command]
pub async fn simulator_input(app: AppHandle, udid: String, input: Input) -> Result<String> {
    let udid = self::udid(&udid)?;
    crate::blocking(move || {
        let sims = app.state::<Simulators>();
        let device = sims.resolve(Some(&udid), true)?;
        super::input(&udid, sims.shown(&device)?, &sims.duo(&udid), &input)
    })
    .await
}

#[tauri::command]
pub async fn simulator_appearance(udid: String, mode: String) -> Result<String> {
    let udid = self::udid(&udid)?;
    crate::blocking(move || super::appearance(&udid, &mode)).await
}

/// A full-resolution PNG for copying or attaching.
#[tauri::command]
pub async fn simulator_capture(app: AppHandle, udid: String) -> Result<Response> {
    let udid = self::udid(&udid)?;
    crate::blocking(move || {
        let display = app.state::<Simulators>().display(&udid);
        super::screenshot(&udid, None, display).map(Response::new)
    })
    .await
}

/// The saved Android emulator launch flags: a default plus per-AVD overrides.
#[tauri::command]
pub async fn simulator_emulator_flags() -> Result<super::emulator_flags::EmulatorFlags> {
    crate::blocking(|| Ok(super::emulator_flags::read())).await
}

/// Saves the Android emulator launch flags. Device keys are `android:<AVD>` udids;
/// an AVD with saved flags launches with them instead of the default.
#[tauri::command]
pub async fn simulator_set_emulator_flags(default: String, devices: std::collections::BTreeMap<String, String>) -> Result<()> {
    let flags = super::emulator_flags::clean(
        default,
        devices.into_iter().map(|(udid, text)| {
            super::android::avd(&udid).filter(|avd| super::android::valid_name(avd)).map(str::to_string).ok_or_else(|| "Unknown simulator.".to_string()).map(|avd| (avd, text))
        }).collect::<std::result::Result<std::collections::BTreeMap<_, _>, String>>()?,
    )?;
    crate::blocking(move || super::emulator_flags::write(&flags)).await
}
