//! Panel focus, keys, kept-alive hidden panels and minimum size (R0304, ADR-0001, contract G3 and "Kept alive").
//!
//! - **Keys.** While a panel has focus every key goes to its page. The client script forwards only what the page
//!   left alone: a key-down it did not `preventDefault()` that is Escape or carries the command modifier, never a key
//!   of an input-method composition. A served shell sends it as `POST /~panda/channel` with kind `key` (or `release`
//!   for `pandaView.releaseFocus()`); the legacy inline shell, whose document pins `connect-src 'none'`, writes it in
//!   its title (`panda-view:key:<n>:<flags>:<code>:<key>`, `panda-view:release:<n>`), the channel the watchdog already
//!   reads. Escape and `release` give the keyboard back to the main window, which focuses the control that had it
//!   before the panel; any other chord is emitted to the main window, which presses it there (`FOCUS_EVENT`). Nothing
//!   a panel sends becomes a native command: the main window only re-dispatches a key-down on its own document.
//! - **Kept alive.** An inspector panel whose view leaves the screen (a tab or task switch) is parked: hidden, its
//!   document and focus kept, its watch paused. At most `RETAINED_LIMIT` parked panels live in the whole app; beyond
//!   that the least recently shown is closed after `GRACE` (time for its last `state`), keeping its instance's state,
//!   and shown again later as a fresh document with `restored: true`. Visible panels are not counted.
//! - **Minimum size.** `rich.minSize` reaches the shell as `#panda-min=<w>x<h>` on its address: the shell gives its
//!   frame that minimum and scrolls, so a smaller mount scrolls and the page is never scaled.
//!
//! These bounds are for memory of the webviews and predictability (ADR-0005), not for security.
use crate::extensions::{packages::Snapshot, rich_views::{runtime_rich_channel as channel, runtime_rich_mount as mount}};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::BTreeMap, sync::{LazyLock, Mutex}, time::{Duration, Instant}};
use tauri::{Emitter, Manager};

/// Hidden inspector panels kept alive in the whole application (memory of the webviews).
pub const RETAINED_LIMIT: usize = 4;
/// What a page gets to deliver its last `state` before its parked panel is closed.
pub const GRACE: Duration = Duration::from_millis(250);
/// Emitted to the main window: `{ mountId, kind: "release" }` or `{ mountId, kind: "key", key, code, ctrlKey, ... }`.
pub const FOCUS_EVENT: &str = "extensions-rich-focus";
/// The end reason of a parked panel closed beyond `RETAINED_LIMIT`.
pub const EVICTED: &str = "evicted";
pub const KEY_LIMIT: usize = 32;
pub const MIN_WIDTH: u64 = 160;
pub const MIN_HEIGHT: u64 = 240;
pub const MAX_SIDE: u64 = 2000;
const MODIFIERS: [&str; 4] = ["Control", "Meta", "Shift", "Alt"];
const DENIED: &str = "PermissionDenied";
const STALE: &str = "StaleContext: this panel is no longer mounted.";

/// A key-down the page left alone.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Chord { pub key: String, pub code: String, pub ctrl: bool, pub meta: bool, pub shift: bool, pub alt: bool }
impl Chord {
    /// Escape, or a key with the command modifier (Ctrl, or Cmd on macOS) that is not itself a modifier.
    pub fn forwardable(&self) -> bool { self.key == "Escape" || ((self.ctrl || self.meta) && !MODIFIERS.contains(&self.key.as_str())) }
    fn json(&self, mount_id: &str) -> Value {
        json!({"mountId": mount_id, "kind": "key", "key": self.key, "code": self.code, "ctrlKey": self.ctrl, "metaKey": self.meta, "shiftKey": self.shift, "altKey": self.alt})
    }
}
/// What a panel hands the host.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Forward { Release, Key(Chord) }
impl Forward {
    /// A forwarded Escape is "return focus" (the same as `releaseFocus`).
    fn from_chord(chord: Chord) -> Self { if chord.key == "Escape" { Self::Release } else { Self::Key(chord) } }
}

fn valid_key(key: &str) -> bool { !key.is_empty() && key.chars().count() <= KEY_LIMIT && !key.chars().any(char::is_control) }
fn valid_code(code: &str) -> bool { code.len() <= KEY_LIMIT && code.bytes().all(|byte| byte.is_ascii_alphanumeric()) }

/// One request of a shell, if it is a focus request (`key` or `release`); anything else is the channel's (`None`).
pub fn parse(body: &[u8], session: &str) -> Option<Result<Forward, String>> {
    if body.len() > 1024 { return None; }
    let value: Value = serde_json::from_slice(body).ok()?;
    matches!(value.get("kind").and_then(Value::as_str), Some("key" | "release")).then(|| parse_value(&value, session))
}
/// Closed shapes bound to the mount's session; a key that is not forwardable is a malformed request.
pub fn parse_value(value: &Value, session: &str) -> Result<Forward, String> {
    let object = value.as_object().ok_or("InvalidShape")?;
    if object.get("schemaVersion") != Some(&json!(1)) || object.get("session").and_then(Value::as_str) != Some(session) { return Err("InvalidShape".into()); }
    let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
    keys.sort_unstable();
    match object.get("kind").and_then(Value::as_str) {
        Some("release") if keys == ["kind", "schemaVersion", "session"] => Ok(Forward::Release),
        Some("key") if keys == ["altKey", "code", "ctrlKey", "key", "kind", "metaKey", "schemaVersion", "session", "shiftKey"] => {
            let flag = |name: &str| object[name].as_bool().ok_or_else(|| "InvalidShape".to_owned());
            let key = object["key"].as_str().filter(|key| valid_key(key)).ok_or("InvalidShape")?.to_owned();
            let code = object["code"].as_str().filter(|code| valid_code(code)).ok_or("InvalidShape")?.to_owned();
            let chord = Chord { key, code, ctrl: flag("ctrlKey")?, meta: flag("metaKey")?, shift: flag("shiftKey")?, alt: flag("altKey")? };
            if !chord.forwardable() { return Err("InvalidShape".into()); }
            Ok(Forward::from_chord(chord))
        }
        _ => Err("InvalidShape".into()),
    }
}
/// The inline shell's title signals: `panda-view:release:<n>` and `panda-view:key:<n>:<flags>:<code>:<key>` (flags:
/// Ctrl 1, Cmd 2, Shift 4, Alt 8). Answers the sequence number with the request.
pub fn title_signal(title: &str) -> Option<(u64, Forward)> {
    if let Some(sequence) = title.strip_prefix("panda-view:release:") { return sequence.parse().ok().map(|sequence| (sequence, Forward::Release)); }
    let mut parts = title.strip_prefix("panda-view:key:")?.splitn(4, ':');
    let sequence: u64 = parts.next()?.parse().ok()?;
    let flags: u8 = parts.next()?.parse().ok().filter(|flags| *flags < 16)?;
    let code = parts.next()?;
    let key = parts.next()?;
    if !valid_code(code) || !valid_key(key) { return None; }
    let chord = Chord { key: key.into(), code: code.into(), ctrl: flags & 1 != 0, meta: flags & 2 != 0, shift: flags & 4 != 0, alt: flags & 8 != 0 };
    chord.forwardable().then(|| (sequence, Forward::from_chord(chord)))
}

/// The parked inspector panels, least recently shown first. Pure: the app applies what `park` answers.
#[derive(Default, Debug)]
pub struct Retention { parked: Vec<(String, String)> }
impl Retention {
    /// Parks mount `label` of `slot` (`main:<viewId>`). Answers the mounts to close: an older park of the same slot,
    /// then the least recently shown beyond `RETAINED_LIMIT`.
    pub fn park(&mut self, label: &str, slot: &str) -> Vec<String> {
        self.parked.retain(|(parked, _)| parked != label);
        let mut evicted = vec![];
        self.parked.retain(|(parked, parked_slot)| if parked_slot == slot { evicted.push(parked.clone()); false } else { true });
        self.parked.push((label.to_owned(), slot.to_owned()));
        while self.parked.len() > RETAINED_LIMIT { evicted.push(self.parked.remove(0).0); }
        evicted
    }
    /// Shown again: `false` when it is not parked (closed beyond the limit, or ended meanwhile).
    pub fn resume(&mut self, label: &str) -> bool {
        let Some(index) = self.parked.iter().position(|(parked, _)| parked == label) else { return false };
        self.parked.remove(index);
        true
    }
    pub fn forget(&mut self, label: &str) { self.parked.retain(|(parked, _)| parked != label); }
    pub fn is_parked(&self, label: &str) -> bool { self.parked.iter().any(|(parked, _)| parked == label) }
    pub fn parked(&self) -> Vec<String> { self.parked.iter().map(|(label, _)| label.clone()).collect() }
}

/// `rich.minSize` of a view, with the defaults of an inspector panel (160 by 240) and the schema's bounds.
pub fn min_size(view: &Value) -> (u64, u64) {
    let side = |name: &str, default: u64| view["rich"]["minSize"][name].as_u64().unwrap_or(default).clamp(MIN_WIDTH, MAX_SIDE);
    (side("width", MIN_WIDTH), side("height", MIN_HEIGHT))
}
/// The address of a shell with its minimum size (a fragment: never sent to a server, read by the shell).
pub fn sized(url: &str, (width, height): (u64, u64)) -> String { format!("{}#panda-min={width}x{height}", url.split('#').next().unwrap_or(url)) }
/// The declared view `view_id` of the installed `owner@version`.
pub fn declared_view<'a>(snapshot: &'a Snapshot, owner: &str, version: &str, view_id: &str) -> Option<&'a Value> {
    snapshot.packages.iter().find(|package| package.manifest["id"] == owner && package.manifest["version"] == version)?
        .manifest["contributes"]["views"].as_array()?.iter().find(|view| view["id"] == view_id)
}

// ---- the app ----------------------------------------------------------------------------------------------------

static RETENTION: LazyLock<Mutex<Retention>> = LazyLock::new(Mutex::default);
fn retained<T: Default>(run: impl FnOnce(&mut Retention) -> T) -> T { RETENTION.lock().map(|mut retention| run(&mut retention)).unwrap_or_default() }
/// Per mount: its admission window (forty forwards in any two seconds, like the channel) and the last title sequence.
#[derive(Default)]
struct Source { rate: channel::Rate, sequence: u64 }
static SOURCES: LazyLock<Mutex<BTreeMap<String, Source>>> = LazyLock::new(Mutex::default);

pub fn parked(label: &str) -> bool { retained(|retention| retention.is_parked(label)) }
/// Every teardown of a mount (`runtime_rich_mount::forget_keeping`).
pub fn forget(label: &str) {
    retained(|retention| retention.forget(label));
    if let Ok(mut sources) = SOURCES.lock() { sources.remove(label); }
}
fn admit(label: &str, sequence: Option<u64>) -> bool {
    let Ok(mut sources) = SOURCES.lock() else { return false };
    if sources.len() >= 256 && !sources.contains_key(label) { sources.clear(); }
    let source = sources.entry(label.to_owned()).or_default();
    if let Some(sequence) = sequence { if sequence <= source.sequence { return false; } source.sequence = sequence; }
    source.rate.admit(Instant::now())
}

/// Gives the keyboard back to the main window (its window, then its webview inside it).
fn focus_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") { let _ = window.set_focus(); }
    if let Some(view) = app.get_webview("main") { let _ = view.set_focus(); }
}
fn apply(app: &tauri::AppHandle, label: &str, forward: Forward) {
    match forward {
        Forward::Release => { focus_main(app); let _ = app.emit_to("main", FOCUS_EVENT, json!({"mountId": label, "kind": "release"})); }
        Forward::Key(chord) => { let _ = app.emit_to("main", FOCUS_EVENT, chord.json(label)); }
    }
}

/// `POST /~panda/channel` of a served shell (`runtime_rich_channel::serve_post` asks first): a focus request is
/// answered here, anything else is left to the channel.
pub fn serve_post(app: &tauri::AppHandle, label: &str, session: &str, body: &[u8]) -> Option<Value> {
    let forward = match parse(body, session)? { Ok(forward) => forward, Err(error) => return Some(channel::refusal(&error)) };
    if !admit(label, None) { return Some(channel::refusal(channel::TOO_FAST)); }
    apply(app, label, forward);
    Some(json!({"ok": true, "value": null}))
}
/// The title callback of every panel and window (`runtime_rich_mount::observe_title` asks first): `true` when the
/// title was a focus signal.
pub fn observe_title(app: &tauri::AppHandle, label: &str, title: &str) -> bool {
    if !title.starts_with("panda-view:key:") && !title.starts_with("panda-view:release:") { return false; }
    if let Some((sequence, forward)) = title_signal(title) { if admit(label, Some(sequence)) { apply(app, label, forward); } }
    true
}

/// Closes a parked panel beyond the limit after the grace, keeping its instance's state for the next show.
fn evict(app: &tauri::AppHandle, label: String) {
    let app = app.clone();
    let spawned = std::thread::Builder::new().name("rich-panel-evict".into()).spawn({
        let (app, label) = (app.clone(), label.clone());
        move || { std::thread::sleep(GRACE); close_evicted(&app, &label); }
    });
    if spawned.is_err() { close_evicted(&app, &label); }
}
fn close_evicted(app: &tauri::AppHandle, label: &str) {
    mount::forget_keeping(app, label, true);
    if let Some(view) = app.get_webview(label) { let _ = view.close(); }
    let _ = app.emit_to("main", mount::ENDED_EVENT, json!({"mountId": label, "reason": EVICTED}));
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FocusRequest { mount_id: String, op: String }

/// The main window's focus and retention operations on one of its inspector panels: `enter` (keyboard focus into the
/// panel, from its tab stop), `park` (hidden, document kept; answers what was closed beyond the limit) and `resume`.
#[tauri::command]
pub async fn extensions_rich_focus(caller: tauri::Webview, app: tauri::AppHandle, request: FocusRequest) -> Result<Value, String> {
    if caller.label() != "main" || !request.mount_id.starts_with(mount::PANEL_PREFIX) || request.mount_id.len() > 80 { return Err(DENIED.into()); }
    if !matches!(request.op.as_str(), "enter" | "park" | "resume") { return Err("InvalidShape".into()); }
    let label = request.mount_id;
    let Some(view_id) = mount::panel_view(&app, &label) else { forget(&label); return Err(STALE.into()) };
    let view = app.get_webview(&label).ok_or(STALE)?;
    match request.op.as_str() {
        "enter" => { view.set_focus().map_err(|_| "HostUnavailable")?; Ok(json!({"focused": true})) }
        "resume" => if retained(|retention| retention.resume(&label)) { Ok(json!({"resumed": true})) } else { Err(STALE.into()) },
        _ => {
            view.hide().map_err(|_| "HostUnavailable")?;
            mount::pause(&app, &label, true);
            // Parked mounts that ended meanwhile (a failure, a lifecycle end) no longer count.
            let gone: Vec<String> = retained(|retention| retention.parked()).into_iter().filter(|parked| mount::panel_view(&app, parked).is_none()).collect();
            let evicted = retained(|retention| { for parked in &gone { retention.forget(parked); } retention.park(&label, &format!("main:{view_id}")) });
            for parked in &evicted { evict(&app, parked.clone()); }
            Ok(json!({"parked": true, "evicted": evicted}))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const TABLE: &str = include_str!("../../../tests/fixtures/extensions/runtime-rich-focus/forwarding.json");
    const MANIFEST: &str = include_str!("../../../tests/fixtures/extensions/runtime-rich-focus/extension.json");

    fn kind(forward: &Forward) -> &'static str { match forward { Forward::Release => "release", Forward::Key(_) => "key" } }

    #[test]
    fn forwarded_requests_are_closed_shapes_and_only_escape_or_command_chords_pass() {
        let table: Value = serde_json::from_str(TABLE).unwrap();
        let session = table["session"].as_str().unwrap();
        for case in table["cases"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let body = serde_json::to_vec(&case["request"]).unwrap();
            let parsed = parse(&body, session).expect(name);
            match case["forward"].as_str() {
                Some(expected) => assert_eq!(kind(&parsed.expect(name)), expected, "{name}"),
                None => assert_eq!(parsed.unwrap_err(), "InvalidShape", "{name}"),
            }
        }
        // Every other kind stays the channel's.
        for other in [json!({"schemaVersion": 1, "session": "s", "kind": "hello"}), json!({"schemaVersion": 1, "session": "s", "kind": "invoke", "command": "read_file"})] {
            assert!(parse(&serde_json::to_vec(&other).unwrap(), "s").is_none(), "{other}");
        }
        assert!(parse(&vec![b' '; 2048], "s").is_none());
        // A chord carries every field the main window re-dispatches.
        let Ok(Forward::Key(chord)) = parse_value(&table["cases"][3]["request"], "s") else { panic!("Ctrl+B") };
        assert_eq!(chord.json("extension-panel-a"), json!({"mountId": "extension-panel-a", "kind": "key", "key": "b", "code": "KeyB", "ctrlKey": true, "metaKey": false, "shiftKey": false, "altKey": false}));
    }

    #[test]
    fn inline_title_signals_carry_the_same_requests_with_a_sequence() {
        let table: Value = serde_json::from_str(TABLE).unwrap();
        for case in table["titles"].as_array().unwrap() {
            let title = case["title"].as_str().unwrap();
            match (title_signal(title), case["forward"].as_str()) {
                (None, None) => {}
                (Some((_, Forward::Release)), Some("release")) => {}
                (Some((_, Forward::Key(chord))), Some("key")) => assert_eq!(
                    (chord.key.as_str(), chord.code.as_str(), chord.ctrl, chord.meta, chord.shift, chord.alt),
                    (case["key"].as_str().unwrap(), case["code"].as_str().unwrap(), case["ctrlKey"] == true, case["metaKey"] == true, case["shiftKey"] == true, case["altKey"] == true),
                    "{title}"),
                (other, expected) => panic!("{title}: {other:?} for {expected:?}"),
            }
        }
        assert_eq!(title_signal("panda-view:release:9").unwrap().0, 9);
        // The watchdog's own signals are not focus signals.
        assert_eq!(mount::signal("panda-view:key:1:1:KeyB:b"), None);
    }

    #[test]
    fn five_parked_panels_keep_four_and_close_the_least_recently_shown() {
        let manifest: Value = serde_json::from_str(MANIFEST).unwrap();
        let views: Vec<String> = manifest["contributes"]["views"].as_array().unwrap().iter().map(|view| view["id"].as_str().unwrap().to_owned()).collect();
        assert_eq!(views.len(), 5);
        let mut retention = Retention::default();
        let mut evicted = vec![];
        for (index, view) in views.iter().enumerate() { evicted.extend(retention.park(&format!("extension-panel-{index}"), &format!("main:{view}"))); }
        assert_eq!(evicted, vec!["extension-panel-0".to_owned()]);
        assert_eq!(retention.parked(), (1..5).map(|index| format!("extension-panel-{index}")).collect::<Vec<_>>());
        // Shown again: no longer parked, so it is not counted (visible panels are not).
        assert!(retention.resume("extension-panel-2") && !retention.is_parked("extension-panel-2") && !retention.resume("extension-panel-2"));
        assert!(retention.park("extension-panel-5", &format!("main:{}", views[0])).is_empty());
        // The evicted one cannot be resumed: it is shown again as a fresh document (restored from state).
        assert!(!retention.resume("extension-panel-0"));
        // A second mount of the same slot replaces the older park; a park of an already parked mount moves it last.
        assert_eq!(retention.park("extension-panel-6", &format!("main:{}", views[0])), vec!["extension-panel-5".to_owned()]);
        retention.park("extension-panel-1", &format!("main:{}", views[1]));
        assert_eq!(retention.parked().last().map(String::as_str), Some("extension-panel-1"));
        assert!(retention.parked().len() <= RETAINED_LIMIT);
        retention.forget("extension-panel-1");
        assert!(!retention.is_parked("extension-panel-1"));
    }

    #[test]
    fn min_size_reaches_the_shell_as_a_fragment_with_the_inspector_defaults() {
        let manifest: Value = serde_json::from_str(MANIFEST).unwrap();
        let views = manifest["contributes"]["views"].as_array().unwrap();
        assert_eq!(views.iter().map(min_size).collect::<Vec<_>>(), vec![(320, 240), (2000, 160), (MIN_WIDTH, MIN_HEIGHT), (480, 360), (160, 200)]);
        assert_eq!(min_size(&json!({"rich": {"minSize": {"width": 9000, "height": 24}}})), (MAX_SIDE, MIN_WIDTH));
        assert_eq!(sized("pandapanel://p0.localhost/~panda/shell/extension-panel-a", (320, 240)), "pandapanel://p0.localhost/~panda/shell/extension-panel-a#panda-min=320x240");
        assert_eq!(sized("data:text/html;base64,AAAA#old", (160, 240)), "data:text/html;base64,AAAA#panda-min=160x240");
        let snapshot = crate::extensions::packages::context_test_snapshot(manifest.clone());
        assert_eq!(declared_view(&snapshot, "sample.rich-focus", "1.0.0", "sample.rich-focus/four").map(min_size), Some((480, 360)));
        assert!(declared_view(&snapshot, "sample.rich-focus", "1.0.1", "sample.rich-focus/four").is_none());
        assert!(declared_view(&snapshot, "sample.other", "1.0.0", "sample.rich-focus/four").is_none());
    }

    #[test]
    fn focus_requests_fail_closed_and_panels_still_hold_no_command_grant() {
        let request = json!({"mountId": "extension-panel-a", "op": "park"});
        assert!(serde_json::from_value::<FocusRequest>(request.clone()).is_ok());
        for key in ["owner", "viewId", "label", "session", "target", "windowId"] {
            let mut forged = request.clone(); forged[key] = json!("main"); assert!(serde_json::from_value::<FocusRequest>(forged).is_err(), "{key}");
        }
        for label in ["extension-panel-canary", "extension-view-canary"] {
            assert!(!crate::extensions::windows::command_allowed(label, "extensions_rich_focus"), "{label}");
        }
        assert!(crate::extensions::windows::command_allowed("main", "extensions_rich_focus"));
    }
}
