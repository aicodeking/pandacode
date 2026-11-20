//! `pandacode://open?session=<id>`: lets another app (Tuck's notch, a script, a launcher)
//! bring up a task, the way `vscode://anthropic.claude-code/open?session=<id>` does in VS Code.
//! `id` is a PandaCode task id, or the agent's own session id (Claude Code's `session_id`,
//! a Codex thread id), which PandaCode keeps as the task's resume id.
//!
//! macOS hands the link to the running app as `RunEvent::Opened`; the scheme is declared in
//! `Info.plist`. Opening a link only shows a task: it never sends, starts or changes anything.

use tauri::{AppHandle, Emitter, Manager, Url};

/// Opens the task each `pandacode://open` link names. Other links are ignored.
pub fn open_urls(app: &AppHandle, urls: &[Url]) {
    for url in urls {
        match requested_session(url) {
            Some(id) => open(app, &id),
            None => eprintln!("pandacode: ignored link {}", url.scheme()),
        }
    }
}

/// The session a link asks for: `pandacode://open?session=<id>` (also `pandacode://open/<id>`).
fn requested_session(url: &Url) -> Option<String> {
    if url.scheme() != "pandacode" || url.host_str() != Some("open") {
        return None;
    }
    let id = url
        .query_pairs()
        .find(|(key, _)| key == "session")
        .map(|(_, value)| value.into_owned())
        .or_else(|| url.path_segments()?.find(|s| !s.is_empty()).map(str::to_owned))?;
    let valid = !id.is_empty()
        && id.len() <= 128
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    valid.then_some(id)
}

/// The PandaCode task for an id: the task itself, else the task resuming that agent session.
fn resolve(app: &AppHandle, id: &str) -> Option<String> {
    let state = app.try_state::<crate::AppState>()?;
    let store = state.store.lock().ok()?;
    if let Ok(session) = store.session(id) {
        return Some(session.id);
    }
    ["claude", "codex"]
        .iter()
        .find_map(|provider| store.imported_task(provider, id).ok().flatten())
}

fn open(app: &AppHandle, id: &str) {
    let task = resolve(app, id);
    let Some(main) = app.get_webview_window("main") else { return };
    let _ = main.show();
    let _ = main.unminimize();
    let _ = main.set_focus();
    // Unknown id: still come to the front, as a plain Dock click would.
    if let Some(task) = task {
        let _ = main.emit("overlay-open-task", serde_json::json!({ "sessionId": task }));
    }
}

#[cfg(test)]
mod tests {
    use super::requested_session;
    use tauri::Url;

    fn id(link: &str) -> Option<String> {
        requested_session(&Url::parse(link).unwrap())
    }

    #[test]
    fn reads_the_session_from_an_open_link() {
        let uuid = "1d7ccb3a-409e-4ee8-87af-44ee349b6cc5";
        assert_eq!(id(&format!("pandacode://open?session={uuid}")).as_deref(), Some(uuid));
        assert_eq!(id(&format!("pandacode://open/{uuid}")).as_deref(), Some(uuid));
    }

    #[test]
    fn ignores_other_links_and_odd_ids() {
        assert_eq!(id("pandacode://settings?session=abc"), None);
        assert_eq!(id("https://open?session=abc"), None);
        assert_eq!(id("pandacode://open?session=../etc"), None);
        assert_eq!(id("pandacode://open?session="), None);
        assert_eq!(id(&format!("pandacode://open?session={}", "a".repeat(129))), None);
    }
}
