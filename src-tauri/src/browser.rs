//! A single on-demand, unprivileged browser surface. Guest JavaScript never receives an
//! application callback: the element picker is read through WebKit evaluation instead.
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::Duration,
};
use tauri::{Emitter, Manager, Webview};
#[cfg(any(target_os = "windows", target_os = "linux"))]
mod platform;
#[cfg(target_os = "linux")]
use gtk::prelude::*;

const LABEL: &str = "browser-guest";
const MAX_PNG: usize = 5 * 1024 * 1024;
const MAX_BROWSER_RESULT: usize = 128 * 1024;
type Result<T> = std::result::Result<T, String>;

fn parse_browser_result(raw: &str) -> Result<serde_json::Value> {
    if raw.len() > MAX_BROWSER_RESULT {
        return Err("Browser result is too large.".into());
    }
    let value: serde_json::Value =
        serde_json::from_str(raw).map_err(|_| "Could not read the remote browser.".to_string())?;
    match value.as_str() {
        Some(inner) => {
            serde_json::from_str(inner).map_err(|_| "Invalid browser result.".to_owned())
        }
        None => Ok(value),
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
pub struct BrowserBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserStatus {
    pub url: String,
    pub title: String,
    pub loading: bool,
    pub can_go_back: bool,
    pub can_go_forward: bool,
    pub picking: bool,
}

#[derive(Default)]
pub struct BrowserState {
    status: Mutex<BrowserStatus>,
    lifecycle: tokio::sync::Mutex<()>,
    view_generation: AtomicU64,
    load_generation: AtomicU64,
    generation: AtomicU64,
    pick_key: Mutex<Option<String>>,
    remote: Mutex<HashMap<String, RemoteBrowserState>>,
    remote_lifecycle: tokio::sync::Mutex<()>,
}

#[derive(Clone, Default)]
struct RemoteBrowserState {
    status: BrowserStatus,
    sequence: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteFrame {
    #[serde(skip)]
    pub bytes: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub sequence: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct BrowserElement {
    pub url: String,
    pub title: String,
    pub selector: String,
    pub tag: String,
    pub text: String,
    pub html: String,
    pub bounds: BrowserBounds,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserScreenshot {
    pub id: String,
    pub name: String,
    pub path: String,
    pub mime_type: &'static str,
    pub url: String,
    pub title: String,
    pub width: u32,
    pub height: u32,
    pub data_url: String,
}

fn guard(caller: &Webview) -> Result<()> {
    if caller.label() == "main" {
        Ok(())
    } else {
        Err("Browser content has no application access.".into())
    }
}

pub(crate) fn normalize_url(input: &str) -> Result<tauri::Url> {
    if input.chars().any(char::is_control) {
        return Err("Enter an HTTP or HTTPS URL.".into());
    }
    let input = input.trim();
    if input.is_empty() || input.len() > 4096 {
        return Err("Enter an HTTP or HTTPS URL.".into());
    }
    if !input.contains("://") && !input.starts_with('[') {
        if let Some((_, tail)) = input.split_once(':') {
            let port = tail.split('/').next().unwrap_or_default();
            if port.is_empty() || !port.chars().all(|c| c.is_ascii_digit()) {
                return Err("Only HTTP and HTTPS URLs can be opened.".into());
            }
        }
    }
    let candidate = if input.contains("://") {
        input.to_owned()
    } else if input.starts_with("localhost")
        || input.starts_with("127.")
        || input.starts_with("[::1]")
    {
        format!("http://{input}")
    } else {
        format!("https://{input}")
    };
    let url = tauri::Url::parse(&candidate).map_err(|_| "Enter a valid URL.".to_string())?;
    if !allowed_url(&url) || !url.username().is_empty() || url.password().is_some() {
        return Err("Only HTTP and HTTPS URLs without embedded credentials can be opened.".into());
    }
    Ok(url)
}

fn remote_update(app: &tauri::AppHandle, label: &str, f: impl FnOnce(&mut BrowserStatus)) {
    if let Ok(mut remote) = app.state::<BrowserState>().remote.lock() {
        if let Some(state) = remote.get_mut(label) {
            f(&mut state.status);
        }
    }
}

fn remote_view(app: &tauri::AppHandle, label: &str) -> Result<Webview> {
    if !label.starts_with("web-browser-") || label.len() > 80 {
        return Err("Invalid remote browser surface.".into());
    }
    app.get_webview(label)
        .ok_or_else(|| "Remote browser is closed.".into())
}

#[cfg(target_os = "linux")]
fn linux_remote_renderer_available(
    display: Option<&std::ffi::OsStr>,
    wayland_display: Option<&std::ffi::OsStr>,
    session_type: Option<&std::ffi::OsStr>,
) -> bool {
    let present = |value: Option<&std::ffi::OsStr>| {
        value.is_some_and(|value| !value.to_string_lossy().trim().is_empty())
    };
    present(display)
        && !present(wayland_display)
        && !session_type
            .is_some_and(|value| value.to_string_lossy().eq_ignore_ascii_case("wayland"))
}

#[cfg(target_os = "linux")]
fn rectangles_overlap(left: (i32, i32, u32, u32), right: (i32, i32, u32, u32)) -> bool {
    let (left_x, left_y, left_width, left_height) = left;
    let (right_x, right_y, right_width, right_height) = right;
    let (left_x, left_y, right_x, right_y) = (
        i64::from(left_x),
        i64::from(left_y),
        i64::from(right_x),
        i64::from(right_y),
    );
    left_x < right_x + i64::from(right_width)
        && left_x + i64::from(left_width) > right_x
        && left_y < right_y + i64::from(right_height)
        && left_y + i64::from(left_height) > right_y
}

#[cfg(target_os = "linux")]
async fn map_linux_remote_window(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
) -> Result<()> {
    if !linux_remote_renderer_available(
        std::env::var_os("DISPLAY").as_deref(),
        std::env::var_os("WAYLAND_DISPLAY").as_deref(),
        std::env::var_os("XDG_SESSION_TYPE").as_deref(),
    ) {
        return Err(
            "Remote browser frames require PandaCode to run on an isolated X11 display.".into(),
        );
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    let renderer = window.clone();
    app.run_on_main_thread(move || {
        let result = renderer
            .gtk_window()
            .map_err(|_| "Could not access the remote browser renderer.".to_string())
            .and_then(|gtk_window| {
                gtk_window.realize();
                let gdk_window = gtk_window
                    .window()
                    .ok_or_else(|| "Could not realize the remote browser renderer.".to_string())?;
                gdk_window.set_override_redirect(true);
                gdk_window.move_(-30_000, -30_000);
                Ok(())
            });
        let _ = tx.send(result);
    })
    .map_err(|_| "Could not schedule the remote browser renderer.".to_string())?;
    tokio::time::timeout(Duration::from_secs(5), rx)
        .await
        .map_err(|_| "Timed out configuring the remote browser renderer.".to_string())?
        .map_err(|_| "Could not configure the remote browser renderer.".to_string())??;
    window
        .show()
        .map_err(|_| "Could not map the remote browser renderer.".to_string())?;
    // Give X11 and a possible window manager one bounded turn to apply the requested position.
    // Do not call Tao's Linux cursor-ignore API here: it unconditionally unwraps the GDK window
    // and can crash the process while GTK is still realizing this newly mapped surface. The
    // nonfocusable, taskbar-skipped renderer is accepted only when its actual rectangle is fully
    // outside every monitor below, which leaves no physical pointer path to it.
    tokio::time::sleep(Duration::from_millis(50)).await;
    let position = window
        .outer_position()
        .map_err(|_| "Could not verify the remote browser position.".to_string())?;
    let size = window
        .outer_size()
        .map_err(|_| "Could not verify the remote browser size.".to_string())?;
    let monitors = window
        .available_monitors()
        .map_err(|_| "Could not verify the remote browser display.".to_string())?;
    if monitors.is_empty()
        || monitors.iter().any(|monitor| {
            let monitor_position = monitor.position();
            let monitor_size = monitor.size();
            rectangles_overlap(
                (position.x, position.y, size.width, size.height),
                (
                    monitor_position.x,
                    monitor_position.y,
                    monitor_size.width,
                    monitor_size.height,
                ),
            )
        })
    {
        return Err("The remote browser renderer could not be kept off screen.".into());
    }
    Ok(())
}

#[cfg(target_os = "linux")]
async fn remote_linux_status(view: &Webview) -> Result<BrowserStatus> {
    use webkit2gtk::WebViewExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    view.with_webview(move |platform| {
        let native = platform.inner();
        let _ = tx.send(BrowserStatus {
            url: native
                .uri()
                .map(|value| value.to_string())
                .unwrap_or_default(),
            title: native
                .title()
                .map(|value| clip(&value, 300))
                .unwrap_or_default(),
            loading: native.is_loading(),
            can_go_back: native.can_go_back(),
            can_go_forward: native.can_go_forward(),
            picking: false,
        });
    })
    .map_err(|error| error.to_string())?;
    tokio::time::timeout(Duration::from_secs(3), rx)
        .await
        .map_err(|_| "Browser status timed out.".to_string())?
        .map_err(|_| "Remote browser closed while reading its status.".to_string())
}

fn allowed_url(url: &tauri::Url) -> bool {
    matches!(url.scheme(), "http" | "https")
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
}

fn bounded(mut bounds: BrowserBounds, window: &tauri::Window) -> Result<BrowserBounds> {
    if ![bounds.x, bounds.y, bounds.width, bounds.height]
        .iter()
        .all(|v| v.is_finite())
        || bounds.x < 0.0
        || bounds.y < 0.0
        || bounds.width < 1.0
        || bounds.height < 1.0
    {
        return Err("Browser bounds are invalid.".into());
    }
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let size = window
        .inner_size()
        .map_err(|e| e.to_string())?
        .to_logical::<f64>(scale);
    bounds.x = bounds.x.min((size.width - 1.0).max(0.0));
    bounds.y = bounds.y.min((size.height - 1.0).max(0.0));
    bounds.width = bounds.width.min((size.width - bounds.x).max(1.0));
    bounds.height = bounds.height.min((size.height - bounds.y).max(1.0));
    Ok(bounds)
}

fn update(app: &tauri::AppHandle, f: impl FnOnce(&mut BrowserStatus)) {
    if let Ok(mut status) = app.state::<BrowserState>().status.lock() {
        f(&mut status);
        let _ = app.emit_to("main", "browser-state", status.clone());
    }
}

fn guest(app: &tauri::AppHandle) -> Result<Webview> {
    app.get_webview(LABEL)
        .ok_or_else(|| "Open a page in the browser first.".into())
}

fn current_view(app: &tauri::AppHandle, generation: u64) -> bool {
    app.state::<BrowserState>()
        .view_generation
        .load(Ordering::SeqCst)
        == generation
}

fn sync_status(view: &Webview, generation: u64) {
    #[cfg(target_os = "macos")]
    {
        let app = view.app_handle().clone();
        let _ = view.with_webview(move |platform| {
            if !current_view(&app, generation) {
                return;
            }
            // with_webview executes on the main thread; Tauri documents this handle as WKWebView.
            let native = unsafe { &*platform.inner().cast::<objc2_web_kit::WKWebView>() };
            unsafe {
                update(&app, |status| {
                    if let Some(url) = native.URL().and_then(|u| u.absoluteString()) {
                        status.url = url.to_string();
                    }
                    if let Some(title) = native.title() {
                        status.title = clip(&title.to_string(), 300);
                    }
                    status.loading = native.isLoading();
                    status.can_go_back = native.canGoBack();
                    status.can_go_forward = native.canGoForward();
                });
            }
        });
    }
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    platform::sync_status(view, generation);
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        if !current_view(view.app_handle(), generation) {
            return;
        }
        if let Ok(url) = view.url() {
            update(view.app_handle(), |s| s.url = url.to_string());
        }
    }
}

fn watch_loading(app: &tauri::AppHandle, generation: u64) {
    let watch = app
        .state::<BrowserState>()
        .load_generation
        .fetch_add(1, Ordering::SeqCst)
        + 1;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // Tauri has no load-failure callback. Read WebKit's loading flag only during navigation
        // so a failed request also settles the toolbar, without an idle browser polling loop.
        for _ in 0..60 {
            tokio::time::sleep(Duration::from_millis(500)).await;
            let state = app.state::<BrowserState>();
            if !current_view(&app, generation)
                || state.load_generation.load(Ordering::SeqCst) != watch
            {
                return;
            }
            if !state.status.lock().map(|s| s.loading).unwrap_or(false) {
                return;
            }
            if let Ok(view) = guest(&app) {
                sync_status(&view, generation);
            } else {
                return;
            }
        }
    });
}

#[tauri::command]
pub async fn browser_open(
    caller: Webview,
    app: tauri::AppHandle,
    url: String,
    bounds: BrowserBounds,
) -> Result<BrowserStatus> {
    guard(&caller)?;
    let url = app
        .state::<crate::file_preview::FilePreviews>()
        .navigation_url(&normalize_url(&url)?)?;
    let window = caller.window();
    let bounds = bounded(bounds, &window)?;
    let state = app.state::<BrowserState>();
    let _lifecycle = state.lifecycle.lock().await;
    cancel_pick(&app);
    update(&app, |s| {
        s.url = url.to_string();
        s.title = url.host_str().unwrap_or_default().into();
        s.loading = true;
    });
    if let Some(view) = app.get_webview(LABEL) {
        position(&view, bounds)?;
        view.show().map_err(|e| e.to_string())?;
        raise(&view)?;
        view.navigate(url).map_err(|e| e.to_string())?;
    } else {
        let generation = state.view_generation.fetch_add(1, Ordering::SeqCst) + 1;
        let nav_app = app.clone();
        let builder = tauri::webview::WebviewBuilder::new(LABEL, tauri::WebviewUrl::External(url))
            .incognito(true)
            .devtools(false)
            .on_navigation(move |url| {
                if !current_view(&nav_app, generation) || !allowed_url(url) {
                    return false;
                }
                cancel_pick(&nav_app);
                update(&nav_app, |s| {
                    s.url = url.to_string();
                    s.loading = true;
                });
                watch_loading(&nav_app, generation);
                true
            })
            .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
            .on_download(|_, _| false)
            .on_document_title_changed(move |view, title| {
                if !current_view(view.app_handle(), generation) {
                    return;
                }
                update(view.app_handle(), |s| s.title = clip(&title, 300));
                sync_status(&view, generation);
            })
            .on_page_load(move |view, payload| {
                if !current_view(view.app_handle(), generation) {
                    return;
                }
                update(view.app_handle(), |s| {
                    s.url = payload.url().to_string();
                    s.loading = matches!(payload.event(), tauri::webview::PageLoadEvent::Started);
                });
                sync_status(&view, generation);
            });
        let view = window
            .add_child(
                builder,
                tauri::LogicalPosition::new(bounds.x, bounds.y),
                tauri::LogicalSize::new(bounds.width, bounds.height),
            )
            .map_err(|e| {
                state.view_generation.fetch_add(1, Ordering::SeqCst);
                update(&app, |s| s.loading = false);
                format!("Could not open the browser: {e}")
            })?;
        // A recreated guest must not rely on a later host-webview timer to
        // become visible above the native appearance backing.
        view.show().map_err(|e| e.to_string())?;
        raise(&view)?;
    }
    state
        .status
        .lock()
        .map(|s| s.clone())
        .map_err(|e| e.to_string())
}

fn position(view: &Webview, bounds: BrowserBounds) -> Result<()> {
    view.set_bounds(tauri::Rect {
        position: tauri::LogicalPosition::new(bounds.x, bounds.y).into(),
        size: tauri::LogicalSize::new(bounds.width, bounds.height).into(),
    })
    .map_err(|e| e.to_string())
}

fn raise(view: &Webview) -> Result<()> {
    #[cfg(target_os = "macos")]
    view.with_webview(|platform| {
        // Native guest stays above the app's appearance backing after material changes.
        let native = unsafe { &*platform.inner().cast::<objc2_app_kit::NSView>() };
        if let Some(parent) = unsafe { native.superview() } {
            parent.addSubview_positioned_relativeTo(
                native,
                objc2_app_kit::NSWindowOrderingMode::Above,
                None,
            );
        }
    })
    .map_err(|e| e.to_string())?;
    #[cfg(not(target_os = "macos"))]
    let _ = view;
    Ok(())
}

#[tauri::command]
pub async fn browser_bounds(
    caller: Webview,
    app: tauri::AppHandle,
    bounds: BrowserBounds,
    visible: bool,
) -> Result<()> {
    guard(&caller)?;
    let state = app.state::<BrowserState>();
    let _lifecycle = state.lifecycle.lock().await;
    let generation = state.view_generation.load(Ordering::SeqCst);
    if let Some(view) = app.get_webview(LABEL) {
        if visible {
            position(&view, bounded(bounds, &caller.window())?)?;
            view.show().map_err(|e| e.to_string())?;
            raise(&view)?;
            sync_status(&view, generation);
        } else {
            cancel_pick(&app);
            view.hide().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn browser_action(caller: Webview, app: tauri::AppHandle, action: String) -> Result<()> {
    guard(&caller)?;
    if !matches!(action.as_str(), "back" | "forward" | "reload" | "stop") {
        return Err("Unknown browser action.".into());
    }
    cancel_pick(&app);
    let generation = app
        .state::<BrowserState>()
        .view_generation
        .load(Ordering::SeqCst);
    let view = guest(&app)?;
    #[cfg(target_os = "macos")]
    view.with_webview(move |platform| unsafe {
        let native = &*platform.inner().cast::<objc2_web_kit::WKWebView>();
        match action.as_str() {
            "back" => {
                native.goBack();
            }
            "forward" => {
                native.goForward();
            }
            "reload" => {
                native.reload();
            }
            _ => native.stopLoading(),
        }
    })
    .map_err(|e| e.to_string())?;
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    platform::action(&view, &action)?;
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    view.eval(match action.as_str() {
        "back" => "history.back()",
        "forward" => "history.forward()",
        "reload" => "location.reload()",
        _ => "window.stop()",
    })
    .map_err(|e| e.to_string())?;
    sync_status(&view, generation);
    Ok(())
}

fn cancel_pick(app: &tauri::AppHandle) {
    let state = app.state::<BrowserState>();
    state.generation.fetch_add(1, Ordering::SeqCst);
    if let Ok(mut key) = state.pick_key.lock() {
        if let (Some(key), Some(view)) = (key.take(), app.get_webview(LABEL)) {
            let key = serde_json::to_string(&key).unwrap_or_default();
            let _ = view.eval(format!("{{const s=globalThis[{key}];if(s&&typeof s.cancel==='function')s.cancel();delete globalThis[{key}];}}"));
        }
    }
    update(app, |s| s.picking = false);
}

/// A finite browser interface for approved agent actions. Never evaluates code
/// supplied by the agent or grants remote pages application IPC permissions.
#[tauri::command]
pub async fn browser_inspect(
    caller: Webview,
    app: tauri::AppHandle,
    action: String,
    selector: Option<String>,
    text: Option<String>,
) -> Result<serde_json::Value> {
    guard(&caller)?;
    let view = guest(&app)?;
    if !matches!(action.as_str(), "read" | "click" | "type") {
        return Err("Unknown browser operation.".into());
    }
    let selector = selector.unwrap_or_default();
    let text = text.unwrap_or_default();
    if selector.len() > 2048 || text.len() > 8192 {
        return Err("Browser input is too large.".into());
    }
    let args = serde_json::json!({"action":action,"selector":selector,"text":text});
    let script = include_str!("browser_agent.js").replace("__PANDACODE_ARGS__", &args.to_string());
    let raw = evaluate(&view, script).await?;
    if raw.len() > 128 * 1024 {
        return Err("Browser result is too large.".into());
    }
    // Platform evaluate callbacks may encode the returned JSON string once.
    let result: serde_json::Value =
        serde_json::from_str(&raw).map_err(|_| "Could not read the browser page.")?;
    let result = match result.as_str() {
        Some(inner) => serde_json::from_str(inner).map_err(|_| "Invalid browser result.")?,
        None => result,
    };
    if let Some(error) = result.get("error").and_then(serde_json::Value::as_str) {
        return Err(error.to_owned());
    }
    Ok(result)
}

async fn evaluate(view: &Webview, script: String) -> Result<String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let tx = Mutex::new(Some(tx));
    view.eval_with_callback(script, move |value| {
        if let Ok(mut tx) = tx.lock() {
            if let Some(tx) = tx.take() {
                let _ = tx.send(value);
            }
        }
    })
    .map_err(|e| e.to_string())?;
    tokio::time::timeout(Duration::from_secs(3), rx)
        .await
        .map_err(|_| "Browser script timed out.".to_string())?
        .map_err(|_| "Browser closed.".into())
}

#[tauri::command]
pub async fn browser_pick(caller: Webview, app: tauri::AppHandle, enabled: bool) -> Result<()> {
    guard(&caller)?;
    cancel_pick(&app);
    if !enabled {
        return Ok(());
    }
    let view = guest(&app)?;
    let state = app.state::<BrowserState>();
    let generation = state.generation.load(Ordering::SeqCst);
    let key = format!("__pandacode_pick_{}", uuid::Uuid::new_v4().simple());
    *state.pick_key.lock().map_err(|e| e.to_string())? = Some(key.clone());
    let encoded = serde_json::to_string(&key).map_err(|e| e.to_string())?;
    view.eval(include_str!("browser/picker.js").replace("__PANDACODE_PICK_KEY__", &encoded))
        .map_err(|e| e.to_string())?;
    update(&app, |s| s.picking = true);
    view.set_focus().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn(async move {
        // Poll only during a user-armed selection, with a one minute lifetime.
        for _ in 0..240 {
            tokio::time::sleep(Duration::from_millis(250)).await;
            if app
                .state::<BrowserState>()
                .generation
                .load(Ordering::SeqCst)
                != generation
            {
                return;
            }
            let script = format!(
                "(()=>{{const s=globalThis[{encoded}];return s?s.result:{{cancelled:true}}}})()"
            );
            let Ok(raw) = evaluate(&view, script).await else {
                break;
            };
            if app
                .state::<BrowserState>()
                .generation
                .load(Ordering::SeqCst)
                != generation
            {
                return;
            }
            if raw.len() > 24_000 {
                break;
            }
            let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
                break;
            };
            if value.is_null() {
                continue;
            }
            if value.get("cancelled").and_then(|v| v.as_bool()) == Some(true) {
                break;
            }
            if let Ok(element) = serde_json::from_value::<BrowserElement>(value) {
                if let Some(element) = validate_element(element) {
                    let _ = app.emit_to("main", "browser-element", element);
                }
            }
            break;
        }
        if app
            .state::<BrowserState>()
            .generation
            .load(Ordering::SeqCst)
            == generation
        {
            cancel_pick(&app);
        }
    });
    Ok(())
}

fn clip(value: &str, max: usize) -> String {
    value
        .chars()
        .filter(|c| !c.is_control())
        .take(max)
        .collect()
}

fn validate_element(mut element: BrowserElement) -> Option<BrowserElement> {
    if !allowed_url(&tauri::Url::parse(&element.url).ok()?)
        || element.url.len() > 4096
        || ![
            element.bounds.x,
            element.bounds.y,
            element.bounds.width,
            element.bounds.height,
        ]
        .iter()
        .all(|v| v.is_finite())
    {
        return None;
    }
    element.title = clip(&element.title, 300);
    element.selector = clip(&element.selector, 1000);
    element.tag = clip(&element.tag, 80);
    element.text = clip(&element.text, 1200);
    element.html = clip(&element.html, 3000);
    Some(element)
}

#[tauri::command]
pub async fn browser_capture(caller: Webview, app: tauri::AppHandle) -> Result<BrowserScreenshot> {
    guard(&caller)?;
    cancel_pick(&app);
    let state = app.state::<BrowserState>();
    let generation = state.view_generation.load(Ordering::SeqCst);
    let navigation = state.load_generation.load(Ordering::SeqCst);
    let view = guest(&app)?;
    let url = view.url().map_err(|e| e.to_string())?.to_string();
    // Wait for picker removal before asking WebKit to capture its next rendered frame.
    let _ = evaluate(&view, "null".into()).await?;
    ensure_capture_context(&app, &view, generation, navigation, &url)?;
    let mut status = app
        .state::<BrowserState>()
        .status
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    status.url = url.clone();
    let (bytes, width, height) = capture(&view).await?;
    ensure_capture_context(&app, &view, generation, navigation, &url)?;
    if bytes.len() > MAX_PNG {
        return Err(
            "This screenshot exceeds 5 MB. Reduce the browser panel size and try again.".into(),
        );
    }
    let id = uuid::Uuid::new_v4().to_string();
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("browser-captures");
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| e.to_string())?;
    cleanup_captures(&dir).await;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))
            .await
            .map_err(|e| e.to_string())?;
    }
    let path = dir.join(format!("{id}.png"));
    tokio::fs::write(&path, &bytes)
        .await
        .map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
            .await
            .map_err(|e| e.to_string())?;
    }
    if let Err(error) = ensure_capture_context(&app, &view, generation, navigation, &url) {
        let _ = tokio::fs::remove_file(&path).await;
        return Err(error);
    }
    Ok(BrowserScreenshot {
        id,
        name: "Browser screenshot.png".into(),
        path: path.to_string_lossy().into(),
        mime_type: "image/png",
        url: status.url,
        title: status.title,
        width,
        height,
        data_url: format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        ),
    })
}

fn ensure_capture_context(
    app: &tauri::AppHandle,
    view: &Webview,
    generation: u64,
    navigation: u64,
    url: &str,
) -> Result<()> {
    if !current_view(app, generation)
        || app
            .state::<BrowserState>()
            .load_generation
            .load(Ordering::SeqCst)
            != navigation
        || view
            .url()
            .map(|current| current.as_str() != url)
            .unwrap_or(true)
    {
        return Err(
            "The page changed while taking the screenshot. Take another screenshot.".into(),
        );
    }
    Ok(())
}

async fn cleanup_captures(dir: &std::path::Path) {
    let Ok(mut entries) = tokio::fs::read_dir(dir).await else {
        return;
    };
    let cutoff = std::time::SystemTime::now() - Duration::from_secs(7 * 24 * 60 * 60);
    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("png")
            || path
                .file_stem()
                .and_then(|s| s.to_str())
                .and_then(|s| uuid::Uuid::parse_str(s).ok())
                .is_none()
        {
            continue;
        }
        let Ok(metadata) = tokio::fs::symlink_metadata(&path).await else {
            continue;
        };
        if metadata.is_file() && metadata.modified().is_ok_and(|time| time < cutoff) {
            let _ = tokio::fs::remove_file(path).await;
        }
    }
}

#[cfg(target_os = "macos")]
async fn capture(view: &Webview) -> Result<(Vec<u8>, u32, u32)> {
    use objc2::AnyThread;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
    use objc2_foundation::{MainThreadMarker, NSDictionary, NSError, NSNumber};
    use objc2_web_kit::{WKSnapshotConfiguration, WKWebView};
    let (tx, rx) = tokio::sync::oneshot::channel();
    view.with_webview(move |platform| {
        let Some(mtm) = MainThreadMarker::new() else { let _ = tx.send(Err("Snapshot must run on the main thread.".into())); return; };
        let tx = Mutex::new(Some(tx));
        let completion = block2::RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
            let result = (|| {
                if !error.is_null() || image.is_null() { return Err("The page could not be captured. Wait for it to finish loading and try again.".into()); }
                let image = unsafe { &*image };
                let tiff = image.TIFFRepresentation().ok_or("Snapshot image is unavailable.")?;
                let bitmap = NSBitmapImageRep::initWithData(NSBitmapImageRep::alloc(), &tiff).ok_or("Snapshot could not be encoded.")?;
                let png = unsafe { bitmap.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new()) }.ok_or("Snapshot could not be encoded as PNG.")?;
                let bytes = png.to_vec();
                let width = bitmap.pixelsWide().max(0) as u32;
                let height = bitmap.pixelsHigh().max(0) as u32;
                Ok((bytes, width, height))
            })();
            if let Ok(mut tx) = tx.lock() { if let Some(tx) = tx.take() { let _ = tx.send(result); } }
        });
        unsafe {
            let native = &*platform.inner().cast::<WKWebView>();
            let config = WKSnapshotConfiguration::new(mtm);
            // WKWebView captures only its visible viewport. Bound output to avoid huge agent images.
            config.setSnapshotWidth(Some(&NSNumber::new_f64(native.bounds().size.width.min(1280.0))));
            native.takeSnapshotWithConfiguration_completionHandler(Some(&config), &completion);
        }
    }).map_err(|e| e.to_string())?;
    tokio::time::timeout(Duration::from_secs(10), rx)
        .await
        .map_err(|_| "Browser screenshot timed out.".to_string())?
        .map_err(|_| "Browser closed before taking a screenshot.".to_string())?
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
async fn capture(view: &Webview) -> Result<(Vec<u8>, u32, u32)> {
    platform::capture(view).await
}
#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
async fn capture(_: &Webview) -> Result<(Vec<u8>, u32, u32)> {
    Err("Browser screenshots are unavailable on this platform.".into())
}

#[tauri::command]
pub async fn browser_close(caller: Webview, app: tauri::AppHandle) -> Result<()> {
    guard(&caller)?;
    let state = app.state::<BrowserState>();
    let _lifecycle = state.lifecycle.lock().await;
    state.view_generation.fetch_add(1, Ordering::SeqCst);
    cancel_pick(&app);
    if let Some(view) = app.get_webview(LABEL) {
        view.close().map_err(|e| e.to_string())?;
    }
    update(&app, |s| *s = BrowserStatus::default());
    Ok(())
}

/// Creates a browser surface that is independent of the desktop panel. The external page remains
/// an incognito, IPC-free webview; only the finite gateway adapter can address its opaque label.
pub(crate) async fn remote_open(
    app: tauri::AppHandle,
    label: String,
    input: String,
) -> Result<BrowserStatus> {
    let browser_state = app.state::<BrowserState>();
    let _lifecycle = browser_state.remote_lifecycle.lock().await;
    if app.get_webview(&label).is_some() {
        return Err("Remote browser already exists.".into());
    }
    #[cfg(target_os = "linux")]
    if !linux_remote_renderer_available(
        std::env::var_os("DISPLAY").as_deref(),
        std::env::var_os("WAYLAND_DISPLAY").as_deref(),
        std::env::var_os("XDG_SESSION_TYPE").as_deref(),
    ) {
        return Err(
            "Remote browser frames require PandaCode to run on an isolated X11 display.".into(),
        );
    }
    let url = app
        .state::<crate::file_preview::FilePreviews>()
        .navigation_url(&normalize_url(&input)?)?;
    let initial = BrowserStatus {
        url: url.to_string(),
        title: url.host_str().unwrap_or_default().into(),
        loading: true,
        ..Default::default()
    };
    app.state::<BrowserState>()
        .remote
        .lock()
        .map_err(|e| e.to_string())?
        .insert(
            label.clone(),
            RemoteBrowserState {
                status: initial.clone(),
                sequence: 0,
            },
        );
    let nav_app = app.clone();
    let nav_label = label.clone();
    let title_app = app.clone();
    let title_label = label.clone();
    let load_app = app.clone();
    let load_label = label.clone();
    let builder = tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::External(url))
        .inner_size(1280.0, 800.0)
        .visible(false)
        .focusable(false)
        .skip_taskbar(true)
        .decorations(false)
        .incognito(true)
        .devtools(false)
        .on_navigation(move |url| {
            if !allowed_url(url) {
                return false;
            }
            remote_update(&nav_app, &nav_label, |status| {
                status.url = url.to_string();
                status.loading = true;
            });
            true
        })
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .on_download(|_, _| false)
        .on_document_title_changed(move |_, title| {
            remote_update(&title_app, &title_label, |status| {
                status.title = clip(&title, 300)
            });
        })
        .on_page_load(move |_, payload| {
            remote_update(&load_app, &load_label, |status| {
                status.url = payload.url().to_string();
                status.loading = matches!(payload.event(), tauri::webview::PageLoadEvent::Started);
            });
        });
    #[cfg(target_os = "linux")]
    let builder = builder.position(-30_000.0, -30_000.0);
    let built = builder.build();
    let window = match built {
        Ok(window) => window,
        Err(error) => {
            app.state::<BrowserState>()
                .remote
                .lock()
                .map_err(|e| e.to_string())?
                .remove(&label);
            return Err(format!("Could not open remote browser: {error}"));
        }
    };
    #[cfg(not(target_os = "linux"))]
    drop(window);
    #[cfg(target_os = "linux")]
    if let Err(error) = map_linux_remote_window(&app, &window).await {
        // If the window manager clamped the renderer onto a monitor, hide it before trying to
        // destroy it. Keep its state registered when close fails so the gateway's bounded cleanup
        // can find the same opaque label and retry instead of leaving an untracked renderer.
        let _ = window.hide();
        if window.close().is_ok() {
            app.state::<BrowserState>()
                .remote
                .lock()
                .map_err(|e| e.to_string())?
                .remove(&label);
            return Err(error);
        }
        return Err(format!(
            "{error} The failed renderer was hidden but could not be closed."
        ));
    }
    Ok(initial)
}

pub(crate) async fn remote_status(app: tauri::AppHandle, label: String) -> Result<BrowserStatus> {
    let view = remote_view(&app, &label)?;
    #[cfg(target_os = "linux")]
    {
        let observed = remote_linux_status(&view).await?;
        remote_update(&app, &label, |status| {
            if tauri::Url::parse(&observed.url)
                .ok()
                .as_ref()
                .is_some_and(allowed_url)
            {
                status.url = observed.url;
                status.title = observed.title;
            }
            status.loading = observed.loading;
            status.can_go_back = observed.can_go_back;
            status.can_go_forward = observed.can_go_forward;
        });
    }
    #[cfg(not(target_os = "linux"))]
    if let Ok(value) = remote_agent(&view, serde_json::json!({"kind":"status"})).await {
        remote_update(&app, &label, |status| {
            if let Some(url) = value.get("url").and_then(serde_json::Value::as_str) {
                status.url = clip(url, 4096);
            }
            if let Some(title) = value.get("title").and_then(serde_json::Value::as_str) {
                status.title = clip(title, 300);
            }
            if let Some(loading) = value.get("loading").and_then(serde_json::Value::as_bool) {
                status.loading = loading;
            }
            if let Some(back) = value.get("canGoBack").and_then(serde_json::Value::as_bool) {
                status.can_go_back = back;
            }
            if let Some(forward) = value
                .get("canGoForward")
                .and_then(serde_json::Value::as_bool)
            {
                status.can_go_forward = forward;
            }
        });
    }
    app.state::<BrowserState>()
        .remote
        .lock()
        .map_err(|e| e.to_string())?
        .get(&label)
        .map(|state| state.status.clone())
        .ok_or_else(|| "Remote browser is closed.".into())
}

pub(crate) async fn remote_action(
    app: tauri::AppHandle,
    label: String,
    action: String,
    url: Option<String>,
) -> Result<BrowserStatus> {
    let view = remote_view(&app, &label)?;
    if action == "navigate" {
        let target = app
            .state::<crate::file_preview::FilePreviews>()
            .navigation_url(&normalize_url(url.as_deref().unwrap_or_default())?)?;
        view.navigate(target.clone()).map_err(|e| e.to_string())?;
        remote_update(&app, &label, |status| {
            status.url = target.to_string();
            status.title = target.host_str().unwrap_or_default().to_owned();
            status.loading = true;
        });
        return app
            .state::<BrowserState>()
            .remote
            .lock()
            .map_err(|e| e.to_string())?
            .get(&label)
            .map(|state| state.status.clone())
            .ok_or_else(|| "Remote browser is closed.".into());
    } else {
        if !matches!(action.as_str(), "back" | "forward" | "reload" | "stop") {
            return Err("Unknown browser action.".into());
        }
        #[cfg(any(target_os = "windows", target_os = "linux"))]
        platform::action(&view, &action)?;
        #[cfg(target_os = "macos")]
        view.eval(match action.as_str() {
            "back" => "history.back()",
            "forward" => "history.forward()",
            "reload" => "location.reload()",
            _ => "window.stop()",
        })
        .map_err(|e| e.to_string())?;
    }
    remote_status(app, label).await
}

async fn remote_agent(view: &Webview, args: serde_json::Value) -> Result<serde_json::Value> {
    let script =
        include_str!("browser/remote_agent.js").replace("__PANDACODE_ARGS__", &args.to_string());
    let raw = evaluate(view, script).await?;
    let value = parse_browser_result(&raw)?;
    if let Some(error) = value.get("error").and_then(serde_json::Value::as_str) {
        return Err(error.to_owned());
    }
    Ok(value)
}

pub(crate) async fn remote_input(
    app: tauri::AppHandle,
    label: String,
    input: serde_json::Value,
) -> Result<BrowserStatus> {
    let view = remote_view(&app, &label)?;
    remote_agent(&view, input).await?;
    remote_status(app, label).await
}

pub(crate) async fn remote_inspect(
    app: tauri::AppHandle,
    label: String,
    action: String,
    selector: Option<String>,
    text: Option<String>,
) -> Result<serde_json::Value> {
    let view = remote_view(&app, &label)?;
    if !matches!(action.as_str(), "read" | "click" | "type") {
        return Err("Unknown browser operation.".into());
    }
    let selector = selector.unwrap_or_default();
    let text = text.unwrap_or_default();
    if selector.len() > 2048 || text.len() > 8192 || (action != "read" && selector.is_empty()) {
        return Err("Invalid browser inspection input.".into());
    }
    let args = serde_json::json!({"action":action,"selector":selector,"text":text});
    let script = include_str!("browser_agent.js").replace("__PANDACODE_ARGS__", &args.to_string());
    let raw = evaluate(&view, script).await?;
    let value = parse_browser_result(&raw)?;
    if let Some(error) = value.get("error").and_then(serde_json::Value::as_str) {
        return Err(error.to_owned());
    }
    Ok(value)
}

pub(crate) async fn remote_pick(
    app: tauri::AppHandle,
    label: String,
    x: f64,
    y: f64,
) -> Result<serde_json::Value> {
    remote_agent(
        &remote_view(&app, &label)?,
        serde_json::json!({"kind":"pick","x":x,"y":y}),
    )
    .await
}

pub(crate) async fn remote_frame(app: tauri::AppHandle, label: String) -> Result<RemoteFrame> {
    let view = remote_view(&app, &label)?;
    let before = view.url().map_err(|e| e.to_string())?;
    let (bytes, width, height) = capture(&view).await?;
    if bytes.len() > MAX_PNG || view.url().map_err(|e| e.to_string())? != before {
        return Err("The page changed or its frame exceeded 5 MB.".into());
    }
    let sequence = {
        let browser_state = app.state::<BrowserState>();
        let mut remote = browser_state.remote.lock().map_err(|e| e.to_string())?;
        let state = remote.get_mut(&label).ok_or("Remote browser is closed.")?;
        state.sequence = state.sequence.wrapping_add(1).max(1);
        state.sequence
    };
    Ok(RemoteFrame {
        bytes,
        width,
        height,
        sequence,
    })
}

pub(crate) async fn remote_close(app: tauri::AppHandle, label: String) -> Result<()> {
    let browser_state = app.state::<BrowserState>();
    let _lifecycle = browser_state.remote_lifecycle.lock().await;
    #[cfg(target_os = "linux")]
    if let Some(window) = app.get_webview_window(&label) {
        // A failed close must at least retire the mapped X11 surface before callers retry.
        let _ = window.hide();
    }
    if let Some(view) = app.get_webview(&label) {
        view.close().map_err(|e| e.to_string())?;
    }
    browser_state
        .remote
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&label);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_result_parser_bounds_raw_bytes_before_parsing() {
        let valid = format!(
            r#"{{"text":"{}"}}"#,
            "é".repeat((MAX_BROWSER_RESULT - 32) / 2)
        );
        assert!(valid.len() <= MAX_BROWSER_RESULT);
        assert!(parse_browser_result(&valid).is_ok());
        let oversized = format!(r#"{{"text":"{}"}}"#, "x".repeat(MAX_BROWSER_RESULT));
        assert_eq!(
            parse_browser_result(&oversized),
            Err("Browser result is too large.".into())
        );
        assert!(parse_browser_result("not json").is_err());
    }
    #[tokio::test]
    async fn capture_cleanup_keeps_recent_and_unmanaged_files() {
        let dir = std::env::temp_dir().join(format!("pandacode-captures-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let old = dir.join(format!("{}.png", uuid::Uuid::new_v4()));
        let recent = dir.join(format!("{}.png", uuid::Uuid::new_v4()));
        let unmanaged = dir.join("keep.png");
        let cutoff = std::time::SystemTime::now() - Duration::from_secs(8 * 24 * 60 * 60);
        for path in [&old, &recent, &unmanaged] {
            std::fs::write(path, b"test").unwrap();
        }
        for path in [&old, &unmanaged] {
            std::fs::File::options()
                .write(true)
                .open(path)
                .unwrap()
                .set_times(std::fs::FileTimes::new().set_modified(cutoff))
                .unwrap();
        }
        cleanup_captures(&dir).await;
        assert!(!old.exists());
        assert!(recent.exists());
        assert!(unmanaged.exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn accepts_web_urls_and_local_servers_only() {
        assert_eq!(
            normalize_url("localhost:3000/page").unwrap().as_str(),
            "http://localhost:3000/page"
        );
        assert_eq!(
            normalize_url("example.com").unwrap().as_str(),
            "https://example.com/"
        );
        for input in [
            "",
            "javascript:alert(1)",
            "file:///etc/passwd",
            "file:/etc/passwd",
            "tauri://localhost",
            "https://user:pass@example.com",
            "data:text/html,hi",
            "https://example.com\n",
        ] {
            assert!(normalize_url(input).is_err(), "{input}");
        }
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn remote_renderer_requires_plain_x11_and_an_offscreen_rectangle() {
        use std::ffi::OsStr;
        assert!(linux_remote_renderer_available(
            Some(OsStr::new(":23")),
            None,
            Some(OsStr::new("x11")),
        ));
        assert!(!linux_remote_renderer_available(
            Some(OsStr::new(":0")),
            Some(OsStr::new("wayland-1")),
            Some(OsStr::new("wayland")),
        ));
        assert!(!linux_remote_renderer_available(
            None,
            None,
            Some(OsStr::new("x11")),
        ));
        assert!(rectangles_overlap((-10, -10, 20, 20), (0, 0, 1280, 800)));
        assert!(!rectangles_overlap(
            (-30_000, -30_000, 1280, 800),
            (0, 0, 1280, 800)
        ));
    }
    #[test]
    fn element_metadata_is_bounded_and_non_web_origins_are_rejected() {
        let mut element = BrowserElement {
            url: "https://example.com/".into(),
            title: "x".repeat(500),
            selector: "x".repeat(1500),
            tag: "button".into(),
            text: "x".repeat(4000),
            html: "x".repeat(5000),
            bounds: BrowserBounds {
                x: 0.,
                y: 0.,
                width: 100.,
                height: 20.,
            },
        };
        element = validate_element(element).unwrap();
        assert_eq!(element.title.len(), 300);
        assert_eq!(element.text.len(), 1200);
        assert_eq!(element.html.len(), 3000);
        element.url = "file:///tmp/private".into();
        assert!(validate_element(element).is_none());
    }
}
