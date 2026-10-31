//! The UI language the frontend resolved, persisted so the tray menu and the
//! launcher window open in it before any webview reports back. Cosmetic only:
//! error text and logs stay English.

use std::path::Path;
use std::sync::RwLock;
use tauri::Manager;

const LOCALES: &[&str] = &[
    "en-US", "en-GB", "de", "es", "fr", "it", "pt-BR", "ja", "ko", "pl", "ru",
    "zh-Hans", "zh-Hant-HK", "zh-Hant-TW",
];

/// Empty means English (the source language); only values the frontend sends land here.
static LANGUAGE: RwLock<String> = RwLock::new(String::new());

fn lock<T>(mutex: &RwLock<T>) -> std::sync::RwLockWriteGuard<'_, T> {
    mutex.write().unwrap_or_else(|e| e.into_inner())
}

pub(crate) fn current() -> String {
    lock(&LANGUAGE).clone()
}

fn valid(locale: &str) -> bool {
    LOCALES.contains(&locale)
}

pub(crate) fn load(dir: &Path) {
    let Ok(bytes) = std::fs::read(dir.join("ui-language.json")) else {
        return;
    };
    if let Ok(locale) = serde_json::from_slice::<String>(&bytes) {
        if valid(&locale) {
            *lock(&LANGUAGE) = locale;
        }
    }
}

fn persist(dir: &Path, locale: &str) -> Result<(), String> {
    let path = dir.join("ui-language.json");
    let temporary = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec(locale).map_err(|e| e.to_string())?;
    std::fs::write(&temporary, bytes).map_err(|e| format!("Could not save the UI language: {e}"))?;
    std::fs::rename(&temporary, &path).map_err(|e| format!("Could not save the UI language: {e}"))
}

#[tauri::command]
pub(crate) fn set_ui_language(app: tauri::AppHandle, locale: String) -> Result<(), String> {
    if !valid(&locale) {
        return Err("Unsupported UI language.".into());
    }
    let changed = {
        let mut current = lock(&LANGUAGE);
        if *current == locale {
            false
        } else {
            *current = locale.clone();
            true
        }
    };
    if changed {
        let dir = app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?;
        persist(&dir, &locale)?;
        crate::tray::apply_language(&app);
    }
    Ok(())
}

/// Tray menu labels for the active language. Menu ids stay "show"/"quit".
pub(crate) fn tray_labels() -> (&'static str, &'static str) {
    match current().as_str() {
        "zh-Hans" => ("打开 PandaCode", "退出 PandaCode"),
        "zh-Hant-HK" => ("開啟 PandaCode", "結束 PandaCode"),
        "zh-Hant-TW" => ("開啟 PandaCode", "結束 PandaCode"),
        "de" => ("PandaCode öffnen", "PandaCode beenden"),
        "es" => ("Abrir PandaCode", "Salir de PandaCode"),
        "fr" => ("Ouvrir PandaCode", "Quitter PandaCode"),
        "it" => ("Apri PandaCode", "Esci da PandaCode"),
        "pt-BR" => ("Abrir o PandaCode", "Sair do PandaCode"),
        "ja" => ("PandaCode を開く", "PandaCode を終了"),
        "ko" => ("PandaCode 열기", "PandaCode 종료"),
        "pl" => ("Otwórz PandaCode", "Zakończ PandaCode"),
        "ru" => ("Открыть PandaCode", "Выйти из PandaCode"),
        _ => ("Open PandaCode", "Quit PandaCode"),
    }
}

pub(crate) fn launcher_title() -> &'static str {
    match current().as_str() {
        "zh-Hans" => "PandaCode 启动器",
        "zh-Hant-HK" | "zh-Hant-TW" => "PandaCode 啟動器",
        "de" => "PandaCode Starter",
        "es" => "Lanzador de PandaCode",
        "fr" => "Lanceur PandaCode",
        "it" => "Launcher di PandaCode",
        "pt-BR" => "Iniciador do PandaCode",
        "ja" => "PandaCode ランチャー",
        "ko" => "PandaCode 런처",
        "pl" => "Launcher PandaCode",
        "ru" => "Лаунчер PandaCode",
        _ => "PandaCode launcher",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unknown_locales() {
        assert!(valid("zh-Hant-TW"));
        assert!(valid("en-GB"));
        assert!(!valid("xx-XX"));
        assert!(!valid(""));
    }
}
