//! PandaCode's own updates (the updater runs in `src/app-updates.ts`).

/// Whether the updater may install over this copy. On Linux it replaces `$APPIMAGE`, or
/// else the running executable: an unpacked AppImage or a distro package would get a whole
/// AppImage written over its program, so those copies only report updates.
#[tauri::command]
pub fn app_update_install_supported() -> bool {
    install_supported(cfg!(target_os = "linux"), std::env::var_os("APPIMAGE").is_some_and(|path| !path.is_empty()))
}

fn install_supported(linux: bool, appimage: bool) -> bool {
    !linux || appimage
}

#[cfg(test)]
mod tests {
    use super::install_supported;

    #[test]
    fn linux_installs_only_over_an_appimage() {
        assert!(install_supported(false, false));
        assert!(install_supported(true, true));
        assert!(!install_supported(true, false));
    }
}
