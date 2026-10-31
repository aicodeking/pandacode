//! Linux only: the bundled WebKitGTK aborts rendering COLRv1 emoji fonts (issue #179), so hide
//! them from fontconfig; emoji then fall back to the CBDT Noto Color Emoji when installed.
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

const CONFIG: &str = r#"<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig>
  <include ignore_missing="yes">/etc/fonts/fonts.conf</include>
  <selectfont><rejectfont><glob>*COLRv1*.ttf</glob></rejectfont></selectfont>
</fontconfig>
"#;

/// Points `FONTCONFIG_FILE` at a config that rejects COLRv1 fonts, unless the user set one.
/// Call before any GTK/WebKit init. Failures are ignored: startup must never fail.
#[cfg(target_os = "linux")]
pub fn hide_colrv1_fonts() {
    use std::path::PathBuf;
    if std::env::var_os("FONTCONFIG_FILE").is_some() {
        return;
    }
    let Some(base) = std::env::var_os("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".cache")))
    else {
        return;
    };
    let dir = base.join("app.pandacode");
    let file = dir.join("fonts.conf");
    let written = std::fs::create_dir_all(&dir).and_then(|_| std::fs::write(&file, CONFIG));
    match written {
        // Single-threaded here, before anything reads the environment.
        Ok(()) => std::env::set_var("FONTCONFIG_FILE", &file),
        Err(e) => {
            #[cfg(debug_assertions)]
            eprintln!("pandacode: could not write fontconfig override: {e}");
            let _ = e;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::CONFIG;

    #[test]
    fn config_includes_system_and_rejects_colrv1() {
        assert!(CONFIG.contains("<include ignore_missing=\"yes\">/etc/fonts/fonts.conf</include>"));
        assert!(CONFIG.contains("<rejectfont><glob>*COLRv1*.ttf</glob></rejectfont>"));
        assert!(CONFIG.trim_end().ends_with("</fontconfig>"));
    }
}
