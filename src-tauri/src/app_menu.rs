//! macOS app menu: Tauri's default menu, with its Quit item swapped for one that calls
//! `app.exit(0)`. The default Quit sends `terminate:`, and tao has no
//! `applicationShouldTerminate:`, so it skips `RunEvent::ExitRequested` (agent shutdown,
//! `app-quitting`) and goes straight to `RunEvent::Exit`. Every other item stays as Tauri makes it.

use tauri::menu::{Menu, MenuEvent, MenuItem, MenuItemKind};
use tauri::{AppHandle, Wry};

const QUIT_ID: &str = "pandacode-app-quit";
const QUIT_ACCELERATOR: &str = "CmdOrCtrl+Q";

pub(crate) fn build(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let menu = Menu::default(app)?;
    let Some(MenuItemKind::Submenu(app_menu)) = menu.items()?.into_iter().next() else {
        return Ok(menu);
    };
    let texts: Vec<Option<String>> = app_menu
        .items()?
        .iter()
        .map(|item| match item {
            MenuItemKind::Predefined(predefined) => predefined.text().ok(),
            _ => None,
        })
        .collect();
    let Some((index, title)) = quit_item(&texts) else {
        return Ok(menu);
    };
    app_menu.remove_at(index)?;
    let quit = MenuItem::with_id(app, QUIT_ID, title, true, Some(QUIT_ACCELERATOR))?;
    app_menu.insert(&quit, index)?;
    Ok(menu)
}

/// The same exit path as the menu bar item's Quit.
pub(crate) fn on_menu_event(app: &AppHandle, event: MenuEvent) {
    if event.id.as_ref() == QUIT_ID {
        app.exit(0);
    }
}

/// Position and title ("Quit PandaCode") of the predefined Quit item in the app submenu.
fn quit_item(texts: &[Option<String>]) -> Option<(usize, String)> {
    texts.iter().enumerate().find_map(|(index, text)| {
        let text = text.as_deref()?;
        (text == "Quit" || text.starts_with("Quit ")).then(|| (index, text.to_string()))
    })
}

#[cfg(test)]
mod tests {
    use super::quit_item;

    fn texts(items: &[Option<&str>]) -> Vec<Option<String>> {
        items.iter().map(|t| t.map(str::to_string)).collect()
    }

    #[test]
    fn finds_the_quit_item_of_the_default_app_submenu_and_keeps_its_title() {
        // Tauri's default app submenu: About, -, Services, -, Hide, Hide Others, -, Quit.
        let menu = texts(&[
            Some("About PandaCode"), Some(""), Some("Services"), Some(""),
            Some("Hide PandaCode"), Some("Hide Others"), Some(""), Some("Quit PandaCode"),
        ]);
        assert_eq!(quit_item(&menu), Some((7, "Quit PandaCode".to_string())));
        assert_eq!(quit_item(&texts(&[Some("About"), Some("Quit")])), Some((1, "Quit".to_string())));
    }

    #[test]
    fn leaves_the_menu_alone_without_a_quit_item() {
        assert_eq!(quit_item(&texts(&[Some("About PandaCode"), None, Some("Quitting soon")])), None);
        assert_eq!(quit_item(&[]), None);
    }
}
