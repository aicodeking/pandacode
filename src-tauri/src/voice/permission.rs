use super::*;

#[cfg(target_os = "macos")]
pub(super) async fn request() -> Result<()> {
    use objc2_av_foundation::{AVAuthorizationStatus, AVCaptureDevice, AVMediaTypeAudio};
    let denied = "Microphone access is denied. Allow PandaCode in System Settings → Privacy & Security → Microphone, then try again.";
    // This is called only by explicit Start; configuration never touches the microphone.
    let media = unsafe { AVMediaTypeAudio }
        .ok_or("Microphone permission API is unavailable.".to_owned())?;
    let status = unsafe { AVCaptureDevice::authorizationStatusForMediaType(media) };
    if status == AVAuthorizationStatus::Authorized {
        return Ok(());
    }
    if status != AVAuthorizationStatus::NotDetermined {
        return Err(denied.into());
    }
    let rx = {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let tx = Mutex::new(Some(tx));
        let callback = block2::RcBlock::new(move |granted: objc2::runtime::Bool| {
            if let Some(tx) = tx.lock().ok().and_then(|mut tx| tx.take()) {
                let _ = tx.send(granted.as_bool());
            }
        });
        unsafe {
            AVCaptureDevice::requestAccessForMediaType_completionHandler(media, &callback);
        }
        rx
    };
    if rx.await.unwrap_or(false) {
        Ok(())
    } else {
        Err(denied.into())
    }
}

#[cfg(target_os = "windows")]
pub(super) async fn request() -> Result<()> {
    use windows::Devices::Enumeration::{DeviceAccessInformation, DeviceAccessStatus, DeviceClass};
    let status = DeviceAccessInformation::CreateFromDeviceClass(DeviceClass::AudioCapture)
        .and_then(|access| access.CurrentStatus())
        .map_err(|_| {
            "Could not check microphone access. Check Windows microphone privacy settings."
                .to_owned()
        })?;
    if matches!(
        status,
        DeviceAccessStatus::DeniedByUser | DeviceAccessStatus::DeniedBySystem
    ) {
        return Err("Allow microphone access for desktop apps in Windows Settings → Privacy & security → Microphone.".into());
    }
    // Desktop Win32 apps use the OS microphone privacy switch; opening CPAL checks device access.
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub(super) async fn request() -> Result<()> {
    // Desktop Linux grants device access through ALSA/PipeWire; CPAL's open reports denial.
    Ok(())
}
