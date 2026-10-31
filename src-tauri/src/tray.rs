//! Menu bar item: a popover (`?view=tray`) with running tasks, finished tasks not yet
//! viewed, and plan usage. Usage is checked only when the popover opens or on Refresh.

use crate::{agent_usage::Usage, storage::Session, AppState};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{
    image::Image,
    menu::{Menu, MenuEvent, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Rect, WebviewWindow,
};

const ID: &str = "pandacode";
const LABEL: &str = "tray";
const WIDTH: f64 = 340.0;
const MAX_HEIGHT: f64 = 560.0;
const GAP: f64 = 6.0;
const SECTION_LIMIT: usize = 10;
/// Finished since last viewed, with whether the turn failed; in memory, so a restart starts clean.
static UNSEEN: Mutex<BTreeMap<String, bool>> = Mutex::new(BTreeMap::new());
static USAGE: Mutex<BTreeMap<String, Usage>> = Mutex::new(BTreeMap::new());
static CHECKING: AtomicUsize = AtomicUsize::new(0);
/// The icon the popover hangs from and its current logical height.
static ANCHOR: Mutex<Option<(Rect, f64)>> = Mutex::new(None);
/// Clicking the icon blurs the open popover first; that click must not reopen it.
static BLURRED: Mutex<Option<Instant>> = Mutex::new(None);

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

pub(crate) fn setup(app: &AppHandle) -> tauri::Result<()> {
    let menu = Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, "show", "Open PandaCode", true, None::<&str>)?,
            &MenuItem::with_id(app, "quit", "Quit PandaCode", true, None::<&str>)?,
        ],
    )?;
    TrayIconBuilder::with_id(ID)
        .icon(Image::from_bytes(include_bytes!("../icons/tray-template@2x.png"))?)
        .icon_as_template(true)
        .tooltip("PandaCode")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(on_menu)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, rect, .. } = event {
                if let Err(error) = toggle(tray.app_handle(), rect) {
                    eprintln!("Menu bar popover failed: {error}");
                }
            }
        })
        .build(app)?;
    refresh(app);
    Ok(())
}

/// Updates the icon title off the caller's thread, so callers may hold any lock.
pub(crate) fn refresh(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || rebuild(&app));
}

pub(crate) fn finished(app: &AppHandle, session_id: &str, stopped: bool, successful: bool) {
    if !stopped {
        lock(&UNSEEN).insert(session_id.into(), !successful);
    }
    refresh(app);
}

#[tauri::command]
pub(crate) fn tray_seen(app: AppHandle, session_id: String) {
    if lock(&UNSEEN).remove(&session_id).is_some() {
        refresh(&app);
    }
}

fn rebuild(app: &AppHandle) {
    let Some(tray) = app.tray_by_id(ID) else { return };
    match crate::listed_sessions(&app.state::<AppState>()) {
        Ok(sessions) => {
            let running = sessions.iter().filter(|s| !s.archived && s.status == "running").count();
            let _ = tray.set_title((running > 0).then(|| running.to_string()));
        }
        Err(error) => eprintln!("Menu bar item could not list tasks: {error}"),
    }
    let _ = app.emit_to(LABEL, "tray-changed", ());
}

fn on_menu(app: &AppHandle, event: MenuEvent) {
    match event.id.as_ref() {
        "show" => show(app),
        "quit" => app.exit(0),
        _ => {}
    }
}

pub fn show(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn hide(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.hide();
    }
}

fn toggle(app: &AppHandle, rect: Rect) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(LABEL) {
        let just_blurred = lock(&BLURRED).is_some_and(|at| at.elapsed() < Duration::from_millis(300));
        if window.is_visible().unwrap_or(false) || just_blurred {
            return window.hide();
        }
        open(app, &window, rect)
    } else {
        let window = tauri::WebviewWindowBuilder::new(app, LABEL, tauri::WebviewUrl::App("index.html?view=tray".into()))
            .title("PandaCode")
            .inner_size(WIDTH, 420.0)
            .resizable(false)
            .decorations(false)
            .transparent(true)
            .shadow(true)
            .always_on_top(true)
            .visible_on_all_workspaces(true)
            .skip_taskbar(true)
            .visible(false)
            .on_navigation(|url| {
                let local = (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
                    || (url.scheme() == "http" && url.host_str() == Some("tauri.localhost"))
                    || (cfg!(debug_assertions)
                        && url.scheme() == "http"
                        && url.host_str() == Some("127.0.0.1")
                        && url.port() == Some(1420));
                local && matches!(url.path(), "/index.html" | "/")
            })
            .build()?;
        if let Err(error) = crate::appearance::setup(&window) {
            eprintln!("Menu bar popover appearance: {error}");
        }
        let handle = app.clone();
        window.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::Focused(false)) {
                *lock(&BLURRED) = Some(Instant::now());
                hide(&handle);
            }
        });
        open(app, &window, rect)
    }
}

fn open(app: &AppHandle, window: &WebviewWindow, rect: Rect) -> tauri::Result<()> {
    let height = lock(&ANCHOR).map_or(420.0, |(_, height)| height);
    *lock(&ANCHOR) = Some((rect, height));
    place(window, rect, height);
    window.show()?;
    window.set_focus()?;
    let _ = app.emit_to(LABEL, "tray-changed", ());
    refresh_usage(app, false);
    Ok(())
}

/// Centered under the icon (above it when the icon sits at the bottom), inside the work area.
fn place(window: &WebviewWindow, rect: Rect, height: f64) {
    let icon = rect.position.to_physical::<f64>(1.0);
    let size = rect.size.to_physical::<f64>(1.0);
    let Some(monitor) = window.monitor_from_point(icon.x + size.width / 2.0, icon.y).ok().flatten() else { return };
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let (width, height) = (WIDTH * scale, height * scale);
    let _ = window.set_size(PhysicalSize::new(width.round() as u32, height.round() as u32));
    let (x, y) = position(
        (icon.x, icon.y, size.width, size.height),
        (width, height),
        (area.position.x as f64, area.position.y as f64, area.size.width as f64, area.size.height as f64),
        GAP * scale,
    );
    let _ = window.set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32));
}

fn position(icon: (f64, f64, f64, f64), window: (f64, f64), area: (f64, f64, f64, f64), gap: f64) -> (f64, f64) {
    let (ix, iy, iw, ih) = icon;
    let (w, h) = window;
    let (ax, ay, aw, ah) = area;
    let x = (ix + iw / 2.0 - w / 2.0).clamp(ax + gap, (ax + aw - w - gap).max(ax + gap));
    let below = (iy + ih + gap).max(ay + gap);
    let y = if below + h > ay + ah && iy - gap - h >= ay { iy - gap - h } else { below };
    (x, y)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TrayTask {
    id: String,
    title: String,
    project: String,
    provider: String,
    /// Run start for running and waiting tasks, last activity for finished ones (ms).
    at: i64,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    failed: bool,
}

#[derive(Serialize)]
pub(crate) struct TraySnapshot {
    running: Vec<TrayTask>,
    waiting: Vec<TrayTask>,
    finished: Vec<TrayTask>,
    usage: Vec<Usage>,
    checking: bool,
}

#[tauri::command]
pub(crate) fn tray_snapshot(app: AppHandle) -> Result<TraySnapshot, String> {
    let state = app.state::<AppState>();
    let sessions = crate::listed_sessions(&state)?;
    let projects: HashMap<String, String> = state
        .store
        .lock()
        .map_err(|e| e.to_string())?
        .projects()?
        .into_iter()
        .map(|p| (p.id, p.name))
        .collect();
    let unseen = lock(&UNSEEN).clone();
    Ok(snapshot(&sessions, &projects, &unseen, lock(&USAGE).values().cloned().collect()))
}

fn snapshot(sessions: &[Session], projects: &HashMap<String, String>, unseen: &BTreeMap<String, bool>, usage: Vec<Usage>) -> TraySnapshot {
    let task = |s: &Session, at: i64| TrayTask {
        id: s.id.clone(),
        title: s.title.clone(),
        project: projects.get(&s.project_id).cloned().unwrap_or_default(),
        provider: s.provider.clone(),
        at,
        failed: unseen.get(&s.id).copied().unwrap_or(false),
    };
    let live = || sessions.iter().filter(|s| !s.archived);
    let started = |s: &Session| task(s, s.last_prompt_at.unwrap_or(s.updated_at));
    let section = |status: &str| live().filter(|s| s.status == status).take(SECTION_LIMIT).map(started).collect();
    TraySnapshot {
        running: section("running"),
        waiting: section("waiting"),
        finished: live()
            .filter(|s| unseen.contains_key(&s.id) && !matches!(s.status.as_str(), "running" | "waiting"))
            .take(SECTION_LIMIT)
            .map(|s| task(s, s.last_response_at.unwrap_or(s.updated_at)))
            .collect(),
        usage,
        checking: CHECKING.load(Ordering::SeqCst) > 0,
    }
}

#[tauri::command]
pub(crate) fn tray_open(app: AppHandle, session_id: String) {
    lock(&UNSEEN).remove(&session_id);
    hide(&app);
    show(&app);
    let _ = app.emit_to("main", "tray-open-session", session_id);
    refresh(&app);
}

#[tauri::command]
pub(crate) fn tray_refresh_usage(app: AppHandle) {
    refresh_usage(&app, true);
}

#[tauri::command]
pub(crate) fn tray_show_app(app: AppHandle) {
    hide(&app);
    show(&app);
}

#[tauri::command]
pub(crate) fn tray_hide(app: AppHandle) {
    hide(&app);
}

#[tauri::command]
pub(crate) fn tray_quit(app: AppHandle) {
    app.exit(0);
}

/// Fits the window to its content; the page scrolls inside past `MAX_HEIGHT`.
#[tauri::command]
pub(crate) fn tray_resize(app: AppHandle, height: f64) {
    let height = if height.is_finite() { height.clamp(60.0, MAX_HEIGHT) } else { return };
    let mut anchor = lock(&ANCHOR);
    let Some((rect, _)) = *anchor else { return };
    *anchor = Some((rect, height));
    drop(anchor);
    if let Some(window) = app.get_webview_window(LABEL) {
        place(&window, rect, height);
    }
}

/// Claude and Codex, plus every agent a task has used. Each result updates the popover.
fn refresh_usage(app: &AppHandle, refresh_now: bool) {
    let mut providers: BTreeSet<String> = ["claude", "codex"].map(String::from).into();
    if let Ok(store) = app.state::<AppState>().store.lock() {
        if let Ok(mut statement) = store.db.prepare("SELECT DISTINCT provider FROM sessions") {
            if let Ok(rows) = statement.query_map([], |row| row.get::<_, String>(0)) {
                providers.extend(rows.flatten());
            }
        }
    }
    CHECKING.fetch_add(providers.len(), Ordering::SeqCst);
    let _ = app.emit_to(LABEL, "tray-changed", ());
    for provider in providers {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Ok(usage) = crate::agent_usage::query_usage(provider.clone(), refresh_now).await {
                let mut all = lock(&USAGE);
                if usage.windows.is_empty() {
                    all.remove(&provider);
                } else {
                    all.insert(provider, usage);
                }
            }
            CHECKING.fetch_sub(1, Ordering::SeqCst);
            let _ = app.emit_to(LABEL, "tray-changed", ());
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tray_position_centers_under_icon_and_clamps() {
        let area = (0.0, 25.0, 1440.0, 875.0);
        assert_eq!(position((700.0, 0.0, 40.0, 24.0), (340.0, 400.0), area, 6.0), (550.0, 31.0));
        assert_eq!(position((1420.0, 0.0, 20.0, 24.0), (340.0, 400.0), area, 6.0), (1094.0, 31.0));
        assert_eq!(position((0.0, 0.0, 20.0, 24.0), (340.0, 400.0), area, 6.0).0, 6.0);
        // A bottom taskbar icon opens the popover above it.
        assert_eq!(position((700.0, 870.0, 40.0, 30.0), (340.0, 400.0), (0.0, 0.0, 1440.0, 870.0), 6.0), (550.0, 464.0));
    }
}
