//! iOS Simulator for the inspector and for agents. Xcode's `simctl` boots devices,
//! captures the screen and manages apps; AXe (an optional Homebrew CLI built on
//! Apple's simulator HID interface) supplies touches, typing, hardware buttons and
//! the accessibility tree. Every coordinate is in points, the unit taps use.
pub mod android;
pub mod android_setup;
pub mod commands;
pub mod duo;
pub mod stream;
pub mod tools;
mod tree;

use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Command,
    sync::Mutex,
    time::{Duration, Instant},
};

use crate::workspace::{checked, run_process, Capture};

const OUTPUT_LIMIT: usize = 16 * 1024 * 1024;
const QUICK: Duration = Duration::from_secs(20);
const BOOT: Duration = Duration::from_secs(240);
const INSTALL: Duration = Duration::from_secs(180);
const MAX_TEXT: usize = 2000;
pub const AXE_INSTALL: &str = "brew install cameroncooke/axe/axe";

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub udid: String,
    pub name: String,
    pub runtime: String,
    pub state: String,
    /// `phone` or `pad`.
    pub family: String,
    pub device_type: String,
    /// `ios` or `android`.
    pub platform: String,
    /// iPhone Duo: one simulator with a cover and an inner display.
    pub duo: bool,
}
#[derive(Debug, Serialize, Clone, Copy, PartialEq)]
pub struct Size {
    pub width: f64,
    pub height: f64,
}
/// Screen geometry from the device type's profile.
#[derive(Debug, Serialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Screen {
    pub width: f64,
    pub height: f64,
    pub scale: f64,
    /// Devices without Face ID have a home button and a square-cornered display.
    pub home_button: bool,
    /// iPhone Duo's inner display in points, as held open (landscape).
    pub inner: Option<Size>,
}
impl Screen {
    /// The geometry of the display in use: a Duo on its inner display is `inner`.
    pub fn shown(self, display: Option<&str>) -> Screen {
        match (display, self.inner) {
            (Some(duo::INNER), Some(inner)) => Screen { width: inner.width, height: inner.height, ..self },
            _ => self,
        }
    }
}
#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// Xcode's simulator tools answered.
    pub available: bool,
    pub axe: bool,
    pub axe_install: String,
    /// The Android SDK's emulator is installed.
    pub android: bool,
    pub devices: Vec<Device>,
    pub selected: Option<String>,
    pub screen: Option<Screen>,
    /// A Duo device type and an iOS 27.1+ runtime are installed.
    pub duo_available: bool,
    /// The selected Duo's fold pose.
    pub pose: Option<duo::Pose>,
    pub error: Option<String>,
}
#[derive(Debug, Deserialize, Clone, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Input {
    Tap { x: f64, y: f64 },
    #[serde(rename_all = "camelCase")]
    LongPress { x: f64, y: f64, duration_ms: Option<u64> },
    #[serde(rename_all = "camelCase")]
    Swipe { x: f64, y: f64, end_x: f64, end_y: f64, duration_ms: Option<u64> },
    Type { text: String },
    Button { button: String },
    /// A named key: return, backspace, tab, escape, space or an arrow.
    Key { key: String },
    TapLabel { label: String },
}

#[derive(Default)]
pub struct Simulators {
    selected: Mutex<Option<String>>,
    screens: Mutex<HashMap<String, Screen>>,
    /// Fold pose per Duo as last set here; a Duo is entered here when first listed.
    poses: Mutex<HashMap<String, duo::Pose>>,
    /// Each Duo's displays from `devicectl`, briefly cached: frames ask for them constantly.
    duo_displays: Mutex<HashMap<String, (Instant, Vec<duo::Display>)>>,
    duo_support: Mutex<Option<(Instant, bool)>>,
    /// Folds run one at a time, newest first; status, frames and input never wait on it.
    // ponytail: one queue for every Duo; per-device queues if several Duos fold at once.
    folds: duo::LatestWins,
    pub streams: stream::Streams,
}

pub(crate) fn xcrun(args: &[&str], timeout: Duration) -> Result<Capture, String> {
    let mut command = Command::new("/usr/bin/xcrun");
    command.args(args);
    checked(run_process(command, "Simulator", OUTPUT_LIMIT, timeout).map_err(|error| {
        if error.starts_with("Could not start") { "Install Xcode to use the iOS Simulator.".to_string() } else { error }
    })?)
}

/// AXe from the user's PATH or a standard Homebrew prefix; GUI launches miss shell PATHs.
pub fn axe_path() -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|path| std::env::split_paths(&path).collect()).unwrap_or_default();
    dirs.extend(["/opt/homebrew/bin", "/usr/local/bin"].map(PathBuf::from));
    if let Some(home) = std::env::var_os("HOME") {
        dirs.push(Path::new(&home).join(".local/bin"));
    }
    dirs.into_iter().map(|dir| dir.join("axe")).find(|path| path.is_file())
}
fn axe(args: &[&str], timeout: Duration) -> Result<Capture, String> {
    let path = axe_path().ok_or_else(|| format!("Touch input needs AXe. Install it with `{AXE_INSTALL}`."))?;
    let mut command = Command::new(path);
    command.args(args);
    checked(run_process(command, "AXe", OUTPUT_LIMIT, timeout)?)
}
pub(crate) fn json(capture: &Capture) -> Result<serde_json::Value, String> {
    serde_json::from_slice(&capture.bytes).map_err(|_| "The simulator tools returned an unexpected response.".into())
}

/// `com.apple.CoreSimulator.SimRuntime.iOS-26-2` → `iOS 26.2`.
fn runtime_name(key: &str) -> String {
    let tail = key.rsplit('.').next().unwrap_or(key);
    match tail.split_once('-') {
        Some((os, version)) => format!("{os} {}", version.replace('-', ".")),
        None => tail.to_string(),
    }
}
pub fn parse_devices(value: &serde_json::Value) -> Vec<Device> {
    let mut devices: Vec<Device> = value["devices"]
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(runtime, _)| runtime.contains("SimRuntime.iOS"))
        .flat_map(|(runtime, list)| {
            list.as_array().into_iter().flatten().filter(|d| d["isAvailable"].as_bool() != Some(false)).filter_map(move |d| {
                let device_type = d["deviceTypeIdentifier"].as_str().unwrap_or_default().to_string();
                let name = d["name"].as_str()?.to_string();
                let duo = duo::is_duo_type(&device_type);
                Some(Device {
                    udid: d["udid"].as_str()?.to_string(),
                    name,
                    runtime: runtime_name(runtime),
                    state: d["state"].as_str().unwrap_or("Shutdown").to_string(),
                    family: if device_type.contains("iPad") { "pad" } else { "phone" }.into(),
                    device_type,
                    platform: "ios".into(),
                    duo,
                })
            })
        })
        .collect();
    // Booted first, then newest runtime, then name.
    devices.sort_by(|a, b| (b.state == "Booted").cmp(&(a.state == "Booted")).then(b.runtime.cmp(&a.runtime)).then(a.name.cmp(&b.name)));
    devices
}
/// iOS simulators and Android emulators; either platform alone is enough.
pub fn devices() -> Result<Vec<Device>, String> {
    let ios = xcrun(&["simctl", "list", "devices", "available", "-j"], QUICK).and_then(|output| json(&output)).map(|value| parse_devices(&value));
    let android = android::devices();
    match ios {
        Ok(mut list) => { list.extend(android); Ok(sort(list)) }
        Err(_) if !android.is_empty() => Ok(sort(android)),
        Err(error) => Err(error),
    }
}
/// Running first, then iOS before Android, newest runtime, then name.
fn sort(mut devices: Vec<Device>) -> Vec<Device> {
    devices.sort_by(|a, b| (b.state == "Booted").cmp(&(a.state == "Booted")).then(a.platform.cmp(&b.platform).reverse()).then(b.runtime.cmp(&a.runtime)).then(a.name.cmp(&b.name)));
    devices
}

pub fn valid_udid(udid: &str) -> bool {
    match android::avd(udid) {
        Some(name) => android::valid_name(name),
        None => udid.len() == 36 && udid.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-'),
    }
}

pub fn parse_screen(profile: &serde_json::Value) -> Option<Screen> {
    let scale = profile["mainScreenScale"].as_f64().filter(|s| *s > 0.0)?;
    Some(Screen {
        width: (profile["mainScreenWidth"].as_f64()? / scale).round(),
        height: (profile["mainScreenHeight"].as_f64()? / scale).round(),
        scale,
        home_button: profile["supportedFeatures"]["com.apple.pearl-id"].as_bool() != Some(true),
        inner: None,
    })
}

/// A screen measured from a PNG's header (pixels) at the given scale.
pub fn screen_from_png(png: &[u8], scale: f64, home_button: bool) -> Option<Screen> {
    if png.len() < 24 || &png[1..4] != b"PNG" || scale <= 0.0 { return None; }
    let side = |at: usize| f64::from(u32::from_be_bytes([png[at], png[at + 1], png[at + 2], png[at + 3]]));
    let (width, height) = ((side(16) / scale).round(), (side(20) / scale).round());
    (width > 0.0 && height > 0.0).then_some(Screen { width, height, scale, home_button, inner: None })
}

impl Simulators {
    pub fn selected(&self) -> Option<String> {
        self.selected.lock().ok().and_then(|s| s.clone())
    }
    pub fn select(&self, udid: Option<String>) -> Result<(), String> {
        if udid.as_deref().is_some_and(|u| !valid_udid(u)) {
            return Err("Unknown simulator.".into());
        }
        *self.selected.lock().map_err(|e| e.to_string())? = udid;
        Ok(())
    }
    /// The device a request means: an explicit UDID, the one shown in the inspector, or the first booted one.
    pub fn resolve(&self, udid: Option<&str>, booted: bool) -> Result<Device, String> {
        let list = devices()?;
        self.note_duos(&list);
        let wanted = udid.map(str::to_string).or_else(|| self.selected());
        let device = match wanted {
            Some(udid) => list.into_iter().find(|d| d.udid == udid).ok_or("That simulator is not available.")?,
            None => list
                .into_iter()
                .find(|d| d.state == "Booted")
                .ok_or("No simulator is running. Boot one from the Simulator tab or with pandacode_simulator_manage.")?,
        };
        if booted && device.state != "Booted" {
            return Err(format!("{} is {}. Boot it first.", device.name, device.state.to_lowercase()));
        }
        Ok(device)
    }
    pub fn screen(&self, device: &Device) -> Result<Screen, String> {
        // Android screens are read from the running emulator, so they are cached per device.
        let key = if device.platform == "android" { device.udid.clone() } else { device.device_type.clone() };
        if let Some(screen) = self.screens.lock().map_err(|e| e.to_string())?.get(&key) {
            return Ok(*screen);
        }
        if let Some(name) = android::avd(&device.udid) {
            let screen = android::screen(name)?;
            self.screens.lock().map_err(|e| e.to_string())?.insert(key, screen);
            return Ok(screen);
        }
        let types = json(&xcrun(&["simctl", "list", "devicetypes", "-j"], QUICK)?)?;
        let bundle = types["devicetypes"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|t| t["identifier"] == device.device_type.as_str())
            .and_then(|t| t["bundlePath"].as_str())
            .ok_or("The device type of this simulator is unknown.")?
            .to_string();
        let plist = |name: &str| {
            let mut command = Command::new("/usr/bin/plutil");
            command.args(["-convert", "json", "-o", "-"]).arg(Path::new(&bundle).join("Contents/Resources").join(name));
            json(&checked(run_process(command, "plutil", OUTPUT_LIMIT, QUICK)?)?)
        };
        let profile = plist("profile.plist")?;
        let caps = plist("capabilities.plist").ok();
        let cover = caps.as_ref().and_then(|caps| duo::parse_display(caps, duo::COVER)).map(|(size, scale)| Screen {
            width: size.width,
            height: size.height,
            scale,
            // Touch ID sits in the top button; the displays have rounded corners.
            home_button: false,
            inner: None,
        });
        // Newer device types may omit the main screen size; their capabilities or a captured frame still know it.
        let from_frame = || {
            let png = screenshot(&device.udid, None, None).ok()?;
            let scale = profile["mainScreenScale"].as_f64().or_else(|| caps.as_ref().and_then(|c| duo::parse_display(c, duo::COVER)).map(|(_, s)| s));
            screen_from_png(&png, scale.unwrap_or(3.0), profile["supportedFeatures"]["com.apple.pearl-id"].as_bool() != Some(true))
        };
        let mut screen = parse_screen(&profile).or(cover).or_else(from_frame).ok_or("The device profile has no screen size, and no frame could be read to measure it. Boot the simulator and try again.")?;
        screen.inner = caps.and_then(|caps| duo::parse_inner(&caps));
        self.screens.lock().map_err(|e| e.to_string())?.insert(device.device_type.clone(), screen);
        Ok(screen)
    }
    pub fn status(&self) -> Status {
        let mut status = Status { axe: axe_path().is_some(), axe_install: AXE_INSTALL.into(), android: android::emulator_path().is_some(), selected: self.selected(), ..Default::default() };
        // The Duo probe (two `simctl` lists, once a minute) runs beside the device list.
        let (listed, duo_available) = std::thread::scope(|scope| {
            let probe = scope.spawn(|| self.duo_available());
            (devices(), probe.join().unwrap_or(false))
        });
        match listed {
            Ok(list) => {
                status.available = true;
                if status.selected.as_ref().is_some_and(|u| !list.iter().any(|d| &d.udid == u)) {
                    status.selected = None;
                }
                self.note_duos(&list);
                status.duo_available = duo_available;
                status.pose = status.selected.as_deref().filter(|u| list.iter().any(|d| d.duo && d.udid == *u)).map(|u| self.pose(u));
                let shown = status.selected.clone().and_then(|u| list.iter().find(|d| d.udid == u).cloned());
                status.screen = shown.filter(|d| d.platform == "ios" || d.state == "Booted").and_then(|d| self.screen(&d).ok());
                status.devices = list;
            }
            Err(error) => status.error = Some(error),
        }
        status
    }
    fn note_duos(&self, list: &[Device]) {
        if let Ok(mut poses) = self.poses.lock() {
            for d in list.iter().filter(|d| d.duo) { poses.entry(d.udid.clone()).or_default(); }
        }
    }
    /// Cached for a minute: it costs two `simctl` calls.
    fn duo_available(&self) -> bool {
        let Ok(mut cache) = self.duo_support.lock() else { return false };
        match *cache {
            Some((at, yes)) if at.elapsed() < Duration::from_secs(60) => yes,
            _ => { let yes = duo::probe(); *cache = Some((Instant::now(), yes)); yes }
        }
    }
    /// A Duo listed by an earlier status; asks no simulator tool.
    pub fn known_duo(&self, udid: &str) -> bool {
        self.recorded(udid).is_some()
    }
    fn recorded(&self, udid: &str) -> Option<duo::Pose> {
        self.poses.lock().ok().and_then(|p| p.get(udid).copied())
    }
    /// A Duo's displays (empty for other devices or when `devicectl` cannot answer), cached for a second
    /// so poses changed in Device Hub are followed.
    pub fn duo(&self, udid: &str) -> Vec<duo::Display> {
        if self.recorded(udid).is_none() {
            return Vec::new();
        }
        let cached = self.duo_displays.lock().ok().and_then(|cache| cache.get(udid).filter(|(at, _)| at.elapsed() < Duration::from_secs(1)).map(|(_, list)| list.clone()));
        if let Some(list) = cached {
            return list;
        }
        // Asked without the lock held, so status, frames and input never queue behind `devicectl`.
        let list = duo::displays(udid).unwrap_or_default();
        if let Ok(mut cache) = self.duo_displays.lock() { cache.insert(udid.to_string(), (Instant::now(), list.clone())); }
        list
    }
    /// The pose: the active display wins over the recorded pose, which only tells Book from Open.
    pub fn pose(&self, udid: &str) -> duo::Pose {
        let Some(recorded) = self.recorded(udid) else { return duo::Pose::default() };
        let pose = duo::reconcile(recorded, duo::active(&self.duo(udid)).map(|d| d.inner));
        if let Ok(mut poses) = self.poses.lock() { poses.insert(udid.to_string(), pose); }
        pose
    }
    /// The display to capture and stream: set only for a known Duo.
    pub fn display(&self, udid: &str) -> Option<&'static str> {
        self.recorded(udid)?;
        Some(duo::display_for(self.pose(udid)))
    }
    /// The screen as the device shows it now: a Duo's active display in interface points.
    pub fn shown(&self, device: &Device) -> Result<Screen, String> {
        let screen = self.screen(device)?;
        Ok(match duo::active(&self.duo(&device.udid)) {
            Some(active) => Screen { width: active.ui().0, height: active.ui().1, ..screen },
            None => screen.shown(self.display(&device.udid)),
        })
    }
    /// Move the hinge to the pose, remember it and start the new display's stream at once,
    /// so its first frame is being captured while the window hears back. Folds queue and
    /// only the newest waiting one runs; an overtaken fold returns at once.
    pub fn fold(&self, udid: &str, pose: duo::Pose) -> Result<(), String> {
        self.folds
            .run(|overtaken| {
                // The device's pose, not the record: a sweep from where the hinge is not does not move it.
                let displays = duo::fold(udid, self.pose(udid), pose, overtaken)?;
                self.poses.lock().map_err(|e| e.to_string())?.insert(udid.to_string(), pose);
                let Some(displays) = displays else { return Ok(()) };
                self.duo_displays.lock().map_err(|e| e.to_string())?.insert(udid.to_string(), (Instant::now(), displays));
                self.streams.stop(udid);
                self.streams.start(udid, Some(duo::display_for(pose)));
                Ok(())
            })
            .unwrap_or(Ok(()))
    }
    /// Forget a device's cached screen, e.g. after it boots or shuts down.
    pub fn forget_screen(&self, udid: &str) {
        if let Ok(mut screens) = self.screens.lock() { screens.remove(udid); }
    }
}

pub fn boot(udid: &str) -> Result<(), String> {
    if let Some(name) = android::avd(udid) { return android::boot(name); }
    if let Err(error) = xcrun(&["simctl", "boot", udid], BOOT) {
        if !error.contains("current state: Booted") {
            return Err(error);
        }
    }
    xcrun(&["simctl", "bootstatus", udid, "-b"], BOOT).map(|_| ())
}
pub fn shutdown(udid: &str) -> Result<(), String> {
    if let Some(name) = android::avd(udid) { return android::shutdown(name); }
    match xcrun(&["simctl", "shutdown", udid], QUICK) {
        Err(error) if !error.contains("current state: Shutdown") => Err(error),
        _ => Ok(()),
    }
}

/// A frame for the live view: a JPEG straight from `simctl` (a Duo's inner display
/// as PNG took 1.5 s and 4.8 MB, as JPEG 0.5 s and 0.4 MB); Android stays PNG.
pub fn frame(udid: &str, display: Option<&str>) -> Result<Vec<u8>, String> {
    if android::avd(udid).is_some() {
        return screenshot(udid, None, display);
    }
    let dir = std::env::temp_dir().join("pandacode-simulator");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{}-{}.jpg", udid, crate::storage::id()));
    let display = display.map(|d| format!("--display={d}"));
    let file = path.to_string_lossy();
    let mut args = vec!["simctl", "io", udid, "screenshot", "--type=jpeg"];
    args.extend(display.as_deref());
    args.push(&file);
    let result = xcrun(&args, QUICK).and_then(|_| std::fs::read(&path).map_err(|e| e.to_string()));
    let _ = std::fs::remove_file(&path);
    result
}

/// A PNG of the screen at full resolution, or JPEG resized to points when `points` is set.
/// `display` picks a Duo's `primary` (cover) or `primary-1` (inner) display.
pub fn screenshot(udid: &str, points: Option<Screen>, display: Option<&str>) -> Result<Vec<u8>, String> {
    let dir = std::env::temp_dir().join("pandacode-simulator");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stem = dir.join(format!("{}-{}", udid, crate::storage::id()));
    let (raw, out) = (stem.with_extension("png"), stem.with_extension("jpg"));
    let result = (|| {
        match android::avd(udid) {
            Some(name) => {
                let png = android::screenshot(name)?;
                if points.is_none() || !Path::new("/usr/bin/sips").is_file() { return Ok(png); }
                std::fs::write(&raw, png).map_err(|e| e.to_string())?;
            }
            None => {
                let display = display.map(|d| format!("--display={d}"));
                let path = raw.to_string_lossy();
                let mut args = vec!["simctl", "io", udid, "screenshot", "--type=png"];
                args.extend(display.as_deref());
                args.push(&path);
                xcrun(&args, QUICK)?;
            }
        }
        let Some(screen) = points else { return std::fs::read(&raw).map_err(|e| e.to_string()) };
        let mut command = Command::new("/usr/bin/sips");
        command
            .args(["-s", "format", "jpeg", "-s", "formatOptions", "80", "--resampleHeightWidth"])
            .arg(screen.height.to_string())
            .arg(screen.width.to_string())
            .arg(&raw)
            .arg("--out")
            .arg(&out);
        checked(run_process(command, "sips", 64 * 1024, QUICK)?)?;
        std::fs::read(&out).map_err(|e| e.to_string())
    })();
    let _ = std::fs::remove_file(&raw);
    let _ = std::fs::remove_file(&out);
    result
}

fn point(value: f64, limit: f64, axis: &str) -> Result<String, String> {
    if !value.is_finite() || value < 0.0 || value > limit {
        return Err(format!("{axis} must be within the screen (0–{limit} points)."));
    }
    Ok(format!("{value:.1}"))
}
const BUTTONS: [&str; 5] = ["home", "lock", "side-button", "siri", "apple-pay"];
/// HID usage IDs for the keys an agent or the panel can press.
pub const KEYS: [(&str, u8); 10] = [("return", 40), ("escape", 41), ("backspace", 42), ("tab", 43), ("space", 44), ("right", 79), ("left", 80), ("down", 81), ("up", 82), ("delete", 76)];

/// Deliver one input through AXe. Coordinates are points within `screen`. On an
/// iPhone Duo (`duo` lists its displays) touches go through the helper to the active
/// display, since AXe only reaches the cover.
pub fn input(udid: &str, screen: Screen, duo: &[duo::Display], input: &Input) -> Result<String, String> {
    if let Some(name) = android::avd(udid) { return android::input(name, screen, input); }
    let (w, h) = (screen.width, screen.height);
    if let Some(display) = duo::active(duo) {
        let at = |x: f64, y: f64| -> Result<(f64, f64), String> { point(x, w, "x")?; point(y, h, "y")?; Ok((x, y)) };
        match input {
            Input::Tap { x, y } => {
                duo::helper(udid, &duo::tap_args(display, at(*x, *y)?, 0.08))?;
                return Ok(format!("Tapped ({x:.0}, {y:.0})."));
            }
            Input::LongPress { x, y, duration_ms } => {
                let hold = duration_ms.unwrap_or(800).clamp(100, 10_000) as f64 / 1000.0;
                duo::helper(udid, &duo::tap_args(display, at(*x, *y)?, hold))?;
                return Ok(format!("Long-pressed ({x:.0}, {y:.0}) for {hold:.2}s."));
            }
            Input::Swipe { x, y, end_x, end_y, duration_ms } => {
                let seconds = duration_ms.unwrap_or(300).clamp(50, 5_000) as f64 / 1000.0;
                duo::helper(udid, &duo::swipe_args(display, at(*x, *y)?, at(*end_x, *end_y)?, seconds))?;
                return Ok(format!("Swiped from ({x:.0}, {y:.0}) to ({end_x:.0}, {end_y:.0})."));
            }
            Input::TapLabel { label } if !label.trim().is_empty() && label.len() <= 500 => {
                let (x, y) = tree::find_label(&ui_tree(udid, duo)?, label, display.ui()).ok_or_else(|| format!("No element labeled \"{label}\" is on the {} display.", display.name()))?;
                duo::helper(udid, &duo::tap_args(display, (x, y), 0.08))?;
                return Ok(format!("Tapped \"{label}\" at ({x:.0}, {y:.0})."));
            }
            // AXe's home button does nothing on a Duo; the helper presses it on the active display.
            Input::Button { button } if button == "home" => {
                duo::helper(udid, &["home".into()])?;
                return Ok("Pressed home.".into());
            }
            _ => {}
        }
    }
    match input {
        Input::Tap { x, y } => {
            axe(&["tap", "-x", &point(*x, w, "x")?, "-y", &point(*y, h, "y")?, "--udid", udid], QUICK)?;
            Ok(format!("Tapped ({x:.0}, {y:.0})."))
        }
        Input::LongPress { x, y, duration_ms } => {
            let hold = format!("{:.2}", duration_ms.unwrap_or(800).clamp(100, 10_000) as f64 / 1000.0);
            axe(&["touch", "-x", &point(*x, w, "x")?, "-y", &point(*y, h, "y")?, "--down", "--up", "--delay", &hold, "--udid", udid], QUICK)?;
            Ok(format!("Long-pressed ({x:.0}, {y:.0}) for {hold}s."))
        }
        Input::Swipe { x, y, end_x, end_y, duration_ms } => {
            let duration = format!("{:.2}", duration_ms.unwrap_or(300).clamp(50, 5_000) as f64 / 1000.0);
            axe(&["swipe", "--start-x", &point(*x, w, "x")?, "--start-y", &point(*y, h, "y")?, "--end-x", &point(*end_x, w, "endX")?, "--end-y", &point(*end_y, h, "endY")?, "--duration", &duration, "--udid", udid], QUICK)?;
            Ok(format!("Swiped from ({x:.0}, {y:.0}) to ({end_x:.0}, {end_y:.0})."))
        }
        Input::Type { text } => {
            if text.is_empty() || text.chars().count() > MAX_TEXT || text.contains('\0') {
                return Err(format!("Type between 1 and {MAX_TEXT} characters."));
            }
            // `--` keeps text such as `-v` from being read as an option.
            axe(&["type", "--udid", udid, "--", text], Duration::from_secs(60))?;
            Ok(format!("Typed {} characters.", text.chars().count()))
        }
        Input::Button { button } => {
            if !BUTTONS.contains(&button.as_str()) {
                return Err(format!("Press one of: {}.", BUTTONS.join(", ")));
            }
            axe(&["button", button, "--udid", udid], QUICK)?;
            Ok(format!("Pressed {button}."))
        }
        Input::Key { key } => {
            let code = KEYS.iter().find(|(name, _)| name == key).map(|(_, code)| code.to_string()).ok_or_else(|| format!("Press one of: {}.", KEYS.map(|(name, _)| name).join(", ")))?;
            axe(&["key", &code, "--udid", udid], QUICK)?;
            Ok(format!("Pressed {key}."))
        }
        Input::TapLabel { label } => {
            if label.trim().is_empty() || label.len() > 500 {
                return Err("Give the accessibility label to tap.".into());
            }
            let output = axe(&["tap", "--label", label, "--wait-timeout", "2", "--udid", udid], QUICK)?;
            let report = String::from_utf8_lossy(&output.bytes).trim().to_string();
            Ok(if report.is_empty() { format!("Tapped \"{label}\".") } else { report })
        }
    }
}

/// AXe's tree; for a Duo, only the active display's elements, in its interface points.
fn ui_tree(udid: &str, duo: &[duo::Display]) -> Result<serde_json::Value, String> {
    let tree = json(&axe(&["describe-ui", "--udid", udid], Duration::from_secs(45))?)?;
    let Some(shown) = duo::active(duo) else { return Ok(tree) };
    let hidden = duo.iter().find(|d| !d.active).map_or(shown.native, |d| d.native);
    let (rotation, native) = (shown.rotation, shown.native);
    let tree = tree::for_display(&tree, shown.native, hidden, shown.ui(), &|rect| duo::rect_to_ui(rotation, native, rect));
    if !shown.inner {
        return Ok(tree);
    }
    // Read right after AXe, which turns accessibility on for the helper's hit tests.
    Ok(tree::with_frames(&tree, &duo::elements(udid, shown)?))
}
/// The accessibility tree as compact lines, or the element at one point.
pub fn describe(udid: &str, at: Option<(f64, f64)>, duo: &[duo::Display]) -> Result<String, String> {
    if let Some(name) = android::avd(udid) { return android::describe(name, android::screen(name)?.scale); }
    if duo::active(duo).is_some() {
        // AXe's `--point` misses the inner display, so the point is looked up here.
        let tree = ui_tree(udid, duo)?;
        return Ok(match at {
            Some(point) => tree::at_point(&tree, point).map_or_else(|| "No labeled element at that point.".to_string(), |node| tree::summarize(&node)),
            None => tree::summarize(&tree),
        });
    }
    let at = at.map(|(x, y)| format!("{x:.1},{y:.1}"));
    let mut args = vec!["describe-ui", "--udid", udid];
    if let Some(at) = at.as_deref() {
        args.extend(["--point", at]);
    }
    Ok(tree::summarize(&json(&axe(&args, Duration::from_secs(45))?)?))
}

fn valid_bundle_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 255 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-') || id.starts_with('-') {
        return Err("Give a bundle identifier such as com.example.App.".into());
    }
    Ok(())
}
pub fn launch(udid: &str, bundle_id: &str) -> Result<String, String> {
    if let Some(name) = android::avd(udid) { return android::launch(name, bundle_id); }
    valid_bundle_id(bundle_id)?;
    xcrun(&["simctl", "launch", "--terminate-running-process", udid, bundle_id], QUICK)?;
    Ok(format!("Launched {bundle_id}."))
}
pub fn terminate(udid: &str, bundle_id: &str) -> Result<String, String> {
    if let Some(name) = android::avd(udid) { return android::terminate(name, bundle_id); }
    valid_bundle_id(bundle_id)?;
    xcrun(&["simctl", "terminate", udid, bundle_id], QUICK)?;
    Ok(format!("Terminated {bundle_id}."))
}
pub fn open_url(udid: &str, url: &str) -> Result<String, String> {
    if let Some(name) = android::avd(udid) { return android::open_url(name, url); }
    let scheme_ok = url.split_once(':').is_some_and(|(scheme, _)| !scheme.is_empty() && scheme.bytes().all(|b| b.is_ascii_alphanumeric() || b"+-.".contains(&b)));
    if url.len() > 4096 || url.chars().any(char::is_whitespace) || !scheme_ok {
        return Err("Give a URL such as https://example.com or myapp://path.".into());
    }
    xcrun(&["simctl", "openurl", udid, url], QUICK)?;
    Ok(format!("Opened {url}."))
}
/// Install a built `.app` bundle, e.g. from Xcode's DerivedData.
pub fn install(udid: &str, path: &Path) -> Result<String, String> {
    if let Some(name) = android::avd(udid) { return android::install(name, path); }
    let path = path.canonicalize().map_err(|_| "That app bundle does not exist.".to_string())?;
    if path.extension().and_then(|e| e.to_str()) != Some("app") || !path.is_dir() {
        return Err("Give the path of a built .app bundle for the simulator.".into());
    }
    xcrun(&["simctl", "install", udid, &path.to_string_lossy()], INSTALL)?;
    Ok(format!("Installed {}.", path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()))
}
pub fn appearance(udid: &str, mode: &str) -> Result<String, String> {
    if let Some(name) = android::avd(udid) { return android::appearance(name, mode); }
    if !["light", "dark"].contains(&mode) {
        return Err("Appearance is light or dark.".into());
    }
    xcrun(&["simctl", "ui", udid, "appearance", mode], QUICK)?;
    Ok(format!("Appearance set to {mode}."))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn devices_list_ios_simulators_booted_first() {
        let value = serde_json::json!({"devices":{
            "com.apple.CoreSimulator.SimRuntime.iOS-26-2":[
                {"udid":"3720D4A0-B8C5-4DAC-9425-6A4685BC533E","name":"iPhone 17 Pro","state":"Shutdown","isAvailable":true,"deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro"},
                {"udid":"73BD9B70-5E3A-49BD-B2C9-AA7256897283","name":"iPad Air","state":"Booted","isAvailable":true,"deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPad-Air-11-inch-M3"},
                {"udid":"FD7CC5DD-38EC-4008-A6BA-D62FF4BC3728","name":"Broken","state":"Shutdown","isAvailable":false,"deviceTypeIdentifier":"x"}],
            "com.apple.CoreSimulator.SimRuntime.watchOS-26-0":[{"udid":"AAAAAAAA-B8C5-4DAC-9425-6A4685BC533E","name":"Watch","state":"Booted","isAvailable":true,"deviceTypeIdentifier":"w"}]}});
        let list = parse_devices(&value);
        assert_eq!(list.iter().map(|d| (d.name.as_str(), d.family.as_str(), d.runtime.as_str())).collect::<Vec<_>>(), vec![("iPad Air", "pad", "iOS 26.2"), ("iPhone 17 Pro", "phone", "iOS 26.2")]);
    }

    #[test]
    fn screen_falls_back_to_the_frame_size() {
        let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        png.extend([0, 0, 4, 198, 0, 0, 9, 0x90]); // 1222 x 2448 px
        let screen = screen_from_png(&png, 3.0, false).unwrap();
        assert_eq!((screen.width, screen.height, screen.scale), (407.0, 816.0, 3.0));
        assert!(screen_from_png(b"nope", 3.0, false).is_none());
        assert!(parse_screen(&serde_json::json!({"mainScreenScale": 3.0})).is_none());
    }

    #[test]
    fn duo_is_the_native_type() {
        let value = serde_json::json!({"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-27-1":[
            {"udid":"3720D4A0-B8C5-4DAC-9425-6A4685BC533E","name":"iPhone Duo","state":"Shutdown","deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-Duo"},
            {"udid":"73BD9B70-5E3A-49BD-B2C9-AA7256897283","name":"Fold","state":"Shutdown","deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.V68"},
            {"udid":"FD7CC5DD-38EC-4008-A6BA-D62FF4BC3728","name":"iPhone Duo","state":"Shutdown","deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPad-A16"}]}});
        let list = parse_devices(&value);
        assert_eq!(list.iter().map(|d| (d.udid.as_str(), d.duo, d.family.as_str())).collect::<Vec<_>>(), vec![("73BD9B70-5E3A-49BD-B2C9-AA7256897283", true, "phone"), ("3720D4A0-B8C5-4DAC-9425-6A4685BC533E", true, "phone"), ("FD7CC5DD-38EC-4008-A6BA-D62FF4BC3728", false, "pad")]);
    }

    #[test]
    fn the_inner_display_replaces_the_size_only_when_shown() {
        let screen = Screen { width: 466.0, height: 678.0, scale: 3.0, home_button: false, inner: Some(Size { width: 951.0, height: 669.0 }) };
        assert_eq!(screen.shown(Some("primary-1")).width, 951.0);
        assert_eq!(screen.shown(Some("primary")), screen);
        assert_eq!(screen.shown(None), screen);
    }

    #[test]
    fn screens_come_from_device_profiles() {
        let profile = serde_json::json!({"mainScreenScale":3,"mainScreenWidth":1206,"mainScreenHeight":2622,"supportedFeatures":{"com.apple.pearl-id":true}});
        assert_eq!(parse_screen(&profile), Some(Screen { width: 402.0, height: 874.0, scale: 3.0, home_button: false, inner: None }));
        let se = serde_json::json!({"mainScreenScale":2,"mainScreenWidth":750,"mainScreenHeight":1334,"supportedFeatures":{}});
        assert!(parse_screen(&se).unwrap().home_button);
        assert!(parse_screen(&serde_json::json!({"mainScreenScale":0})).is_none());
    }

    #[test]
    fn inputs_are_bounded_before_any_process_runs() {
        assert!(point(10.0, 402.0, "x").is_ok());
        assert!(point(403.0, 402.0, "x").is_err());
        assert!(point(f64::NAN, 402.0, "x").is_err());
        assert!(valid_bundle_id("com.example.App").is_ok());
        assert!(valid_bundle_id("-rf").is_err());
        assert!(valid_bundle_id("com.example App").is_err());
        assert!(valid_udid("3720D4A0-B8C5-4DAC-9425-6A4685BC533E"));
        assert!(!valid_udid("booted"));
        assert_eq!(runtime_name("com.apple.CoreSimulator.SimRuntime.iOS-26-2"), "iOS 26.2");
        let input: Input = serde_json::from_value(serde_json::json!({"kind":"swipe","x":1,"y":2,"endX":3,"endY":4})).unwrap();
        assert_eq!(input, Input::Swipe { x: 1.0, y: 2.0, end_x: 3.0, end_y: 4.0, duration_ms: None });
    }

    /// Drives a booted simulator end to end; run with `cargo test -- --ignored simulator::tests::live` with one booted and AXe installed.
    #[test]
    #[ignore]
    fn live_booted_simulator_answers_every_call() {
        let sims = Simulators::default();
        let device = sims.resolve(None, true).expect("boot a simulator first");
        let screen = sims.screen(&device).unwrap();
        assert!(screen.width > 300.0 && screen.scale >= 2.0, "{screen:?}");
        let jpeg = screenshot(&device.udid, Some(screen), None).unwrap();
        assert_eq!(&jpeg[..2], &[0xFF, 0xD8]);
        input(&device.udid, screen, &[], &Input::Button { button: "home".into() }).unwrap();
        let tree = describe(&device.udid, None, &[]).unwrap();
        assert!(tree.contains(&format!("Screen {}×{}", screen.width, screen.height)), "{tree}");
        input(&device.udid, screen, &[], &Input::Swipe { x: 300.0, y: 500.0, end_x: 60.0, end_y: 500.0, duration_ms: None }).unwrap();
        input(&device.udid, screen, &[], &Input::Button { button: "home".into() }).unwrap();
        let streams = stream::Streams::default();
        let frame = streams.next(&device.udid, None, 0, Duration::from_secs(10)).unwrap().expect("a live frame");
        assert_eq!(&frame.jpeg[..2], &[0xFF, 0xD8]);
        let later = streams.next(&device.udid, None, frame.seq, Duration::from_secs(5)).unwrap().expect("frames keep coming");
        assert!(later.seq > frame.seq);
        streams.stop(&device.udid);
    }

}
