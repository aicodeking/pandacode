//! Virtual machine, simulator and browser guests (`guests.control`, runtime phase R4, slice R0410).
//!
//! A trusted service looks at and drives the guests the app already has with `panda.guests.list()`, `capture(id)`,
//! `input(id, input)` and `control(id, action)`. The permission `guests.control` is global (not project scoped), granted
//! with the trust decision and rechecked natively on every call and again right before anything is captured, sent or
//! changed, so a revoke between the two leaves the guest as it was. A package that holds it is never asked per action
//! (ADR-0005).
//!
//! A guest is `{id, kind, name, state, interactive}`; its id is `<kind>:<name>`: `vm:<tart name>`, `simulator:<udid>` and
//! `browser:page` (the one browser guest, only while a page is open). The kinds are a platform capability, not a trust
//! decision: virtual machines need Apple silicon macOS with Tart, simulators need macOS with Xcode, the browser guest needs
//! a desktop window with a page capture. `list` says which kinds this platform has and why not; a call that names a kind the
//! platform lacks answers `UnsupportedCapability`, and an id of a supported kind that is not there answers `NotFound`.
//!
//! `capture` never sends image bytes through the channel: the image is written into the package's own data directory
//! (`<data>/guests/<kind>-<id>.<png|jpg>`, the newest 32 are kept) and the answer carries the path, the mime type, the size
//! and the pixel size. `input` takes the input the built-in panel takes for the kind (the computer-use action of a VM, the
//! input of a simulator, one of `read | click | type` of the browser guest). `control` starts, stops or suspends a VM, boots
//! or shuts down a simulator or sets its appearance, and navigates the browser guest. Deleting a VM stays in the VM panel
//! (an irreversible deletion keeps the host confirmation).
//!
//! Revoking, disabling or safe mode ends package control only: the guests themselves are never stopped, closed or reset by
//! that, so the user's own VM, simulator and browser keep working as in the original. A guest that is not interactive (a VM
//! the app did not start, a simulator that is not booted) answers `Conflict` to `capture` and `input`.
//!
//! The state is pure (a `Backend` and a `granted` check are injected) so the rules are deterministic to test; the app half
//! (`Native`, `serve`) only adds the grants file, the data directory and the built-in guest controllers.
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

use super::runtime_tasks_start::Refusal;

/// The named permission (global, granted with trust, rechecked on every call).
pub const PERMISSION: &str = "guests.control";
pub const SCHEMA_VERSION: u64 = 1;
pub const KINDS: [&str; 3] = ["vm", "simulator", "browser"];
pub const OPS: [&str; 4] = ["list", "capture", "input", "control"];
/// The one browser guest.
pub const BROWSER_NAME: &str = "page";
/// Largest capture written (bytes), and how many captures a package keeps in its data directory.
pub const MAX_CAPTURE_BYTES: u64 = 16 * 1024 * 1024;
pub const KEPT_CAPTURES: usize = 32;
/// Bounds of an input, for predictability only.
pub const MAX_INPUT_BYTES: usize = 16 * 1024;
pub const MAX_TEXT: usize = 8192;
const VM_ACTIONS: [&str; 9] = ["click", "double_click", "right_click", "middle_click", "move", "drag", "scroll", "type", "key"];
const SIMULATOR_INPUTS: [&str; 7] = ["tap", "longPress", "swipe", "type", "button", "key", "tapLabel"];
const BROWSER_ACTIONS: [&str; 3] = ["read", "click", "type"];

/// The control actions of a kind. `delete` is deliberately not one.
pub fn actions(kind: &str) -> &'static [&'static str] {
    match kind { "vm" => &["start", "stop", "suspend"], "simulator" => &["boot", "shutdown", "light", "dark"], "browser" => &["back", "forward", "reload", "stop"], _ => &[] }
}

fn denied() -> Refusal { Refusal { code: "PermissionDenied".into(), path: PERMISSION.into(), ids: vec![] } }
fn ident(text: &str) -> bool { !text.is_empty() && text.chars().count() <= 200 && !text.chars().any(char::is_control) }

// ---- Platform capabilities -----------------------------------------------------------------------------------------------

/// Which guest kinds this platform has.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Capabilities { pub vm: bool, pub simulator: bool, pub browser: bool }
impl Capabilities {
    pub fn supports(&self, kind: &str) -> bool { match kind { "vm" => self.vm, "simulator" => self.simulator, "browser" => self.browser, _ => false } }
}
/// Why a kind is missing, for `list`.
pub fn reason(kind: &str) -> &'static str {
    match kind {
        "vm" => "Virtual machines need an Apple silicon Mac.",
        "simulator" => "Simulators need macOS with Xcode.",
        "browser" => "The browser guest needs the desktop window.",
        _ => "Unknown guest kind.",
    }
}
/// The kinds of the platform this build runs on (`headless`: no window, so no browser guest).
pub fn platform(headless: bool) -> Capabilities {
    Capabilities {
        vm: cfg!(all(target_os = "macos", target_arch = "aarch64")),
        simulator: cfg!(target_os = "macos"),
        browser: !headless && cfg!(any(target_os = "macos", target_os = "windows", target_os = "linux")),
    }
}

// ---- Requests ------------------------------------------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq)]
pub enum Request {
    List,
    Capture { id: String },
    Input { id: String, input: Value },
    Control { id: String, action: String },
}

/// Splits `<kind>:<name>`. A kind outside the three is a kind this platform lacks: `UnsupportedCapability`.
pub fn split_id(id: &str) -> Result<(&str, &str), Refusal> {
    if !ident(id) { return Err("InvalidShape".into()); }
    let (kind, name) = id.split_once(':').filter(|(_, name)| !name.is_empty()).ok_or("InvalidShape")?;
    if KINDS.contains(&kind) { Ok((kind, name)) } else { Err("UnsupportedCapability".into()) }
}

fn text_fits(value: &Value) -> bool {
    match value {
        Value::String(text) => text.len() <= MAX_TEXT,
        Value::Array(items) => items.iter().all(text_fits),
        Value::Object(map) => map.values().all(text_fits),
        _ => true,
    }
}

/// Reads a call: `{op, id?, input?, action?}`. Nothing is looked up here.
pub fn read_request(raw: &Value) -> Result<Request, Refusal> {
    let object = raw.as_object().ok_or("InvalidShape")?;
    let op = object.get("op").and_then(Value::as_str).filter(|op| OPS.contains(op)).ok_or("InvalidShape")?;
    let extra: &[&str] = match op { "capture" => &["id"], "input" => &["id", "input"], "control" => &["id", "action"], _ => &[] };
    if object.keys().any(|key| key != "op" && !extra.contains(&key.as_str())) { return Err("InvalidShape".into()); }
    let id = || object.get("id").and_then(Value::as_str).filter(|id| ident(id)).map(str::to_owned).ok_or_else(|| Refusal::new("InvalidShape"));
    Ok(match op {
        "list" => Request::List,
        "capture" => Request::Capture { id: id()? },
        "input" => {
            let input = object.get("input").filter(|input| input.is_object()).ok_or("InvalidShape")?.clone();
            if input.to_string().len() > MAX_INPUT_BYTES { return Err("LimitExceeded".into()); }
            if !text_fits(&input) { return Err("LimitExceeded".into()); }
            Request::Input { id: id()?, input }
        }
        _ => Request::Control { id: id()?, action: object.get("action").and_then(Value::as_str).filter(|action| !action.is_empty() && action.len() <= 32).ok_or("InvalidShape")?.to_owned() },
    })
}

/// Checks the shape of an input for its kind (the native parsers check it again).
pub fn check_input(kind: &str, input: &Value) -> Result<(), Refusal> {
    let (key, allowed): (&str, &[&str]) = match kind { "vm" => ("action", &VM_ACTIONS), "simulator" => ("kind", &SIMULATOR_INPUTS), "browser" => ("action", &BROWSER_ACTIONS), _ => return Err("UnsupportedCapability".into()) };
    match input.get(key).and_then(Value::as_str) { Some(name) if allowed.contains(&name) => Ok(()), _ => Err("InvalidShape".into()) }
}

// ---- Guests and the built-in controllers -----------------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Guest { pub kind: String, pub name: String, pub label: String, pub state: String, pub interactive: bool }
impl Guest {
    pub fn id(&self) -> String { format!("{}:{}", self.kind, self.name) }
    pub fn value(&self) -> Value { json!({"id": self.id(), "kind": self.kind, "name": self.label, "state": self.state, "interactive": self.interactive}) }
}

pub enum Image { Bytes(Vec<u8>), File(PathBuf) }
pub struct Frame { pub image: Image, pub mime: &'static str, pub width: Option<u32>, pub height: Option<u32> }

/// What the app's own guest controllers do. Tests give fakes that record each call.
pub trait Backend {
    /// The guests of a supported kind; an error is "the controller is not usable here".
    fn guests(&self, kind: &str) -> Result<Vec<Guest>, Refusal>;
    fn capture(&self, kind: &str, name: &str) -> Result<Frame, Refusal>;
    fn input(&self, kind: &str, name: &str, input: &Value) -> Result<Value, Refusal>;
    fn control(&self, kind: &str, name: &str, action: &str) -> Result<(), Refusal>;
}

pub struct World<'a> {
    pub caps: Capabilities,
    pub backend: &'a dyn Backend,
    /// The package holds `guests.control` now (grant, version, safe mode and the revoke of work in flight).
    pub granted: &'a dyn Fn() -> bool,
    /// The package's own data directory (global scope).
    pub data_dir: &'a Path,
}

fn find(world: &World, id: &str) -> Result<Guest, Refusal> {
    let (kind, name) = split_id(id)?;
    if !world.caps.supports(kind) { return Err("UnsupportedCapability".into()); }
    world.backend.guests(kind)?.into_iter().find(|guest| guest.name == name).ok_or_else(|| Refusal::new("NotFound"))
}

fn extension(mime: &str) -> &'static str { if mime == "image/jpeg" { "jpg" } else { "png" } }

/// Writes a frame below `<data>/guests` and keeps only the newest `KEPT_CAPTURES`. Answers the path and the size.
pub fn store_frame(data_dir: &Path, kind: &str, frame: &Frame) -> Result<(PathBuf, u64), Refusal> {
    let directory = data_dir.join("guests");
    std::fs::create_dir_all(&directory).map_err(|_| Refusal::new("HostUnavailable"))?;
    let path = directory.join(format!("{kind}-{}.{}", uuid::Uuid::new_v4().simple(), extension(frame.mime)));
    let size = match &frame.image {
        Image::Bytes(bytes) => {
            if bytes.len() as u64 > MAX_CAPTURE_BYTES { return Err("LimitExceeded".into()); }
            std::fs::write(&path, bytes).map_err(|_| Refusal::new("HostUnavailable"))?;
            bytes.len() as u64
        }
        Image::File(source) => {
            let meta = std::fs::metadata(source).map_err(|_| Refusal::new("HostUnavailable"))?;
            if !meta.is_file() { return Err("HostUnavailable".into()); }
            if meta.len() > MAX_CAPTURE_BYTES { return Err("LimitExceeded".into()); }
            std::fs::copy(source, &path).map_err(|_| Refusal::new("HostUnavailable"))?
        }
    };
    prune(&directory, KEPT_CAPTURES);
    Ok((path, size))
}

/// Removes the oldest files of `directory` beyond `keep`.
pub fn prune(directory: &Path, keep: usize) {
    let Ok(entries) = std::fs::read_dir(directory) else { return };
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = entries.filter_map(Result::ok).filter_map(|entry| {
        let meta = entry.metadata().ok().filter(|meta| meta.is_file())?;
        Some((meta.modified().ok()?, entry.path()))
    }).collect();
    files.sort();
    let extra = files.len().saturating_sub(keep);
    for (_, path) in files.into_iter().take(extra) { let _ = std::fs::remove_file(path); }
}

/// One call, in the order of the contract: the grant, the shape, the kind and the guest, then the check once more right
/// before the guest is touched.
pub fn handle(world: &World, request: &Request) -> Result<Value, Refusal> {
    if !(world.granted)() { return Err(denied()); }
    match request {
        Request::List => {
            let (mut kinds, mut guests) = (vec![], vec![]);
            for kind in KINDS {
                if !world.caps.supports(kind) { kinds.push(json!({"kind": kind, "supported": false, "reason": reason(kind)})); continue; }
                match world.backend.guests(kind) {
                    Ok(found) => { kinds.push(json!({"kind": kind, "supported": true})); guests.extend(found.iter().map(Guest::value)); }
                    Err(_) => kinds.push(json!({"kind": kind, "supported": true, "available": false})),
                }
            }
            Ok(json!({"schemaVersion": SCHEMA_VERSION, "kinds": kinds, "guests": guests}))
        }
        Request::Capture { id } => {
            let guest = find(world, id)?;
            if !guest.interactive { return Err("Conflict".into()); }
            if !(world.granted)() { return Err(denied()); }
            let frame = world.backend.capture(&guest.kind, &guest.name)?;
            let (path, bytes) = store_frame(world.data_dir, &guest.kind, &frame)?;
            // A revoke while the image was taken wins over its result.
            if !(world.granted)() { let _ = std::fs::remove_file(&path); return Err(denied()); }
            let mut answer = json!({"schemaVersion": SCHEMA_VERSION, "id": guest.id(), "kind": guest.kind, "path": path.to_string_lossy(), "mime": frame.mime, "bytes": bytes});
            if let (Some(width), Some(height)) = (frame.width, frame.height) { answer["width"] = json!(width); answer["height"] = json!(height); }
            Ok(answer)
        }
        Request::Input { id, input } => {
            let guest = find(world, id)?;
            check_input(&guest.kind, input)?;
            if !guest.interactive { return Err("Conflict".into()); }
            if !(world.granted)() { return Err(denied()); }
            let result = world.backend.input(&guest.kind, &guest.name, input)?;
            Ok(json!({"schemaVersion": SCHEMA_VERSION, "result": result}))
        }
        Request::Control { id, action } => {
            let guest = find(world, id)?;
            if !actions(&guest.kind).contains(&action.as_str()) { return Err("InvalidShape".into()); }
            if !(world.granted)() { return Err(denied()); }
            world.backend.control(&guest.kind, &guest.name, action)?;
            Ok(Value::Null)
        }
    }
}

// ---- The app ---------------------------------------------------------------------------------------------------------------

/// The built-in controllers: the VM panel's `Vms`, the Simulator panel's `Simulators` and the browser guest.
struct Native { app: tauri::AppHandle }

fn host(_: String) -> Refusal { Refusal::new("HostUnavailable") }
fn shape(_: String) -> Refusal { Refusal::new("InvalidShape") }

impl Backend for Native {
    fn guests(&self, kind: &str) -> Result<Vec<Guest>, Refusal> {
        use tauri::Manager;
        match kind {
            "vm" => {
                let status = crate::vm::commands::status(&self.app.state::<crate::vm::Vms>()).map_err(host)?;
                if !status.installed { return Err("UnsupportedCapability".into()); }
                Ok(status.vms.into_iter().map(|vm| Guest { kind: "vm".into(), label: vm.name.clone(), state: if vm.running { "running".into() } else { "stopped".into() }, interactive: vm.running && vm.attached, name: vm.name }).collect())
            }
            "simulator" => {
                let devices = crate::simulator::devices().map_err(|_| Refusal::new("UnsupportedCapability"))?;
                Ok(devices.into_iter().map(|device| Guest { kind: "simulator".into(), interactive: device.state == "Booted", state: device.state.to_lowercase(), label: device.name, name: device.udid }).collect())
            }
            _ => Ok(if self.app.get_webview("browser-guest").is_some() { vec![Guest { kind: "browser".into(), name: BROWSER_NAME.into(), label: "Browser".into(), state: "open".into(), interactive: true }] } else { vec![] }),
        }
    }

    fn capture(&self, kind: &str, name: &str) -> Result<Frame, Refusal> {
        use tauri::Manager;
        match kind {
            "vm" => {
                let shot = self.app.state::<crate::vm::Vms>().with_screen(name, false, |rfb| crate::vm::screen::screenshot(rfb, 80)).map_err(host)?;
                Ok(Frame { image: Image::Bytes(shot.jpeg), mime: "image/jpeg", width: Some(shot.width), height: Some(shot.height) })
            }
            "simulator" => {
                let display = self.app.state::<crate::simulator::Simulators>().display(name);
                Ok(Frame { image: Image::Bytes(crate::simulator::screenshot(name, None, display).map_err(host)?), mime: "image/png", width: None, height: None })
            }
            _ => {
                let caller = self.app.get_webview("main").ok_or_else(|| Refusal::new("HostUnavailable"))?;
                let shot = tauri::async_runtime::block_on(crate::browser::browser_capture(caller, self.app.clone())).map_err(host)?;
                // The built-in capture carries a data URL as well; only the file it wrote is used, so no image bytes are held here.
                Ok(Frame { image: Image::File(PathBuf::from(shot.path)), mime: "image/png", width: Some(shot.width), height: Some(shot.height) })
            }
        }
    }

    fn input(&self, kind: &str, name: &str, input: &Value) -> Result<Value, Refusal> {
        use tauri::Manager;
        match kind {
            "vm" => {
                let action = crate::vm::tools::action(input).map_err(shape)?;
                let message = self.app.state::<crate::vm::Vms>().with_screen(name, true, |rfb| crate::vm::screen::act(rfb, &action)).map_err(host)?;
                Ok(json!(message))
            }
            "simulator" => {
                let input: crate::simulator::Input = serde_json::from_value(input.clone()).map_err(|_| Refusal::new("InvalidShape"))?;
                let sims = self.app.state::<crate::simulator::Simulators>();
                let device = sims.resolve(Some(name), true).map_err(host)?;
                let screen = sims.shown(&device).map_err(host)?;
                Ok(json!(crate::simulator::input(name, screen, &sims.duo(name), &input).map_err(host)?))
            }
            _ => {
                let caller = self.app.get_webview("main").ok_or_else(|| Refusal::new("HostUnavailable"))?;
                let text = |key: &str| input.get(key).and_then(Value::as_str).map(str::to_owned);
                let action = text("action").ok_or("InvalidShape")?;
                tauri::async_runtime::block_on(crate::browser::browser_inspect(caller, self.app.clone(), action, text("selector"), text("text"))).map_err(host)
            }
        }
    }

    fn control(&self, kind: &str, name: &str, action: &str) -> Result<(), Refusal> {
        use tauri::{Emitter, Manager};
        match kind {
            "vm" => {
                let vms = self.app.state::<crate::vm::Vms>();
                match action {
                    "start" => { vms.start(name, None).map_err(host)?; crate::vm::desktop::ensure_in_background(self.app.clone(), name.to_owned()); }
                    "stop" => vms.stop(name).map_err(host)?,
                    _ => vms.suspend(name).map_err(host)?,
                }
                let _ = self.app.emit("vm-changed", json!({}));
                Ok(())
            }
            "simulator" => {
                let sims = self.app.state::<crate::simulator::Simulators>();
                match action {
                    "boot" => { sims.forget_screen(name); crate::simulator::boot(name).map_err(host) }
                    "shutdown" => { sims.forget_screen(name); sims.streams.stop(name); crate::simulator::shutdown(name).map_err(host) }
                    mode => crate::simulator::appearance(name, mode).map(|_| ()).map_err(host),
                }
            }
            _ => {
                let caller = self.app.get_webview("main").ok_or_else(|| Refusal::new("HostUnavailable"))?;
                tauri::async_runtime::block_on(crate::browser::browser_action(caller, self.app.clone(), action.to_owned())).map_err(host)
            }
        }
    }
}

/// The enabled version of the package, or why it may not call (safe mode and a disabled package are `PermissionDenied`).
fn version_of(app: &tauri::AppHandle, owner: &str) -> Result<String, Refusal> {
    use tauri::Manager;
    let packages = app.try_state::<crate::extensions::packages::ExtensionPackages>().ok_or("UnsupportedCapability")?;
    let packages = packages.0.try_lock().map_err(|_| Refusal::new("Timeout"))?;
    super::runtime_service_lifetime::runtime_usage_resources::enabled_version(&packages, owner).ok_or_else(denied)
}

/// Serves `guests` `{op: "list" | "capture" | "input" | "control", id?, input?, action?}` of the service of `request.owner`.
pub async fn serve(app: tauri::AppHandle, request: super::runtime_service_lifetime::DispatchRequest) -> Value {
    let owner = request.owner.clone();
    let result = tauri::async_runtime::spawn_blocking(move || run(&app, &owner, &request.params)).await.unwrap_or_else(|_| Err(Refusal::new("HostUnavailable")));
    match result { Ok(value) => json!({"ok": true, "value": value}), Err(refusal) => refusal.envelope() }
}

fn run(app: &tauri::AppHandle, owner: &str, params: &Value) -> Result<Value, Refusal> {
    use tauri::Manager;
    let version = version_of(app, owner)?;
    let grants = app.try_state::<super::runtime_grants::RuntimeGrants>().ok_or("HostUnavailable")?;
    let target = super::runtime_grants::Target::default();
    if grants.check(owner, &version, PERMISSION, &target).is_err() { return Err(denied()); }
    let request = read_request(params)?;
    let work = grants.begin(owner, &version, PERMISSION, &target).map_err(|_| denied())?;
    let granted = || !work.is_cancelled() && version_of(app, owner).is_ok_and(|now| now == version) && grants.check(owner, &version, PERMISSION, &target).is_ok();
    let app_data = app.path().app_data_dir().map_err(|_| Refusal::new("HostUnavailable"))?;
    let data_dir = super::packages::runtime_code_folders::data_directory(&app_data, owner, "global", None).map_err(Refusal::new)?;
    let native = Native { app: app.clone() };
    let world = World { caps: platform(crate::headless::active()), backend: &native, granted: &granted, data_dir: &data_dir };
    handle(&world, &request)
}

// Nothing here stops a guest when a service ends: a revoke, a disable or safe mode only ends package control, and the
// user's own VM, simulator and browser keep running (no `service_stopped` hook exists for this reason).

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    struct Fake { calls: RefCell<Vec<String>>, guests: Vec<Guest>, bytes: Vec<u8> }
    fn guest(kind: &str, name: &str, interactive: bool) -> Guest { Guest { kind: kind.into(), name: name.into(), label: name.into(), state: if interactive { "running".into() } else { "stopped".into() }, interactive } }
    fn fake() -> Fake { Fake { calls: RefCell::new(vec![]), guests: vec![guest("vm", "dev", true), guest("vm", "idle", false), guest("simulator", "UDID-1", true), guest("browser", "page", true)], bytes: vec![137, 80, 78, 71, 1, 2, 3] } }
    impl Backend for Fake {
        fn guests(&self, kind: &str) -> Result<Vec<Guest>, Refusal> { Ok(self.guests.iter().filter(|guest| guest.kind == kind).cloned().collect()) }
        fn capture(&self, kind: &str, name: &str) -> Result<Frame, Refusal> { self.calls.borrow_mut().push(format!("capture:{kind}:{name}")); Ok(Frame { image: Image::Bytes(self.bytes.clone()), mime: "image/png", width: Some(4), height: Some(2) }) }
        fn input(&self, kind: &str, name: &str, input: &Value) -> Result<Value, Refusal> { self.calls.borrow_mut().push(format!("input:{kind}:{name}:{input}")); Ok(json!("done")) }
        fn control(&self, kind: &str, name: &str, action: &str) -> Result<(), Refusal> { self.calls.borrow_mut().push(format!("control:{kind}:{name}:{action}")); Ok(()) }
    }
    fn directory(tag: &str) -> PathBuf { let path = std::env::temp_dir().join(format!("panda-guests-{tag}-{}", std::process::id())); let _ = std::fs::remove_dir_all(&path); std::fs::create_dir_all(&path).unwrap(); path }
    const ALL: Capabilities = Capabilities { vm: true, simulator: true, browser: true };
    fn call(backend: &Fake, caps: Capabilities, data: &Path, granted: &dyn Fn() -> bool, raw: Value) -> Result<Value, Refusal> {
        handle(&World { caps, backend, granted, data_dir: data }, &read_request(&raw)?)
    }
    fn code(result: Result<Value, Refusal>) -> String { result.unwrap_err().code }

    #[test]
    fn a_call_reads_its_op_and_fields_and_refuses_the_rest_as_invalid_shape() {
        assert_eq!(read_request(&json!({"op": "list"})).unwrap(), Request::List);
        assert_eq!(read_request(&json!({"op": "capture", "id": "vm:dev"})).unwrap(), Request::Capture { id: "vm:dev".into() });
        assert_eq!(read_request(&json!({"op": "control", "id": "vm:dev", "action": "stop"})).unwrap(), Request::Control { id: "vm:dev".into(), action: "stop".into() });
        for raw in [json!("x"), json!({}), json!({"op": "delete", "id": "vm:dev"}), json!({"op": "list", "id": "vm:dev"}), json!({"op": "capture"}), json!({"op": "capture", "id": ""}), json!({"op": "input", "id": "vm:dev"}), json!({"op": "input", "id": "vm:dev", "input": "tap"}), json!({"op": "control", "id": "vm:dev"}), json!({"op": "control", "id": "vm:dev", "action": ""})] {
            assert_eq!(code(read_request(&raw).map(|_| Value::Null)), "InvalidShape", "{raw}");
        }
        assert_eq!(code(read_request(&json!({"op": "input", "id": "vm:dev", "input": {"action": "type", "text": "x".repeat(MAX_TEXT + 1)}})).map(|_| Value::Null)), "LimitExceeded");
    }

    #[test]
    fn list_enumerates_the_supported_kinds_and_says_why_the_others_are_missing() {
        let data = directory("list");
        let caps = Capabilities { vm: false, simulator: true, browser: true };
        let answer = call(&fake(), caps, &data, &|| true, json!({"op": "list"})).unwrap();
        assert_eq!(answer["kinds"][0], json!({"kind": "vm", "supported": false, "reason": reason("vm")}));
        assert_eq!(answer["kinds"][1], json!({"kind": "simulator", "supported": true}));
        let ids: Vec<&str> = answer["guests"].as_array().unwrap().iter().map(|guest| guest["id"].as_str().unwrap()).collect();
        assert_eq!(ids, ["simulator:UDID-1", "browser:page"]);
        let all = call(&fake(), ALL, &data, &|| true, json!({"op": "list"})).unwrap();
        assert_eq!(all["guests"].as_array().unwrap().len(), 4);
        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn a_capture_lands_in_the_data_directory_and_the_answer_carries_a_path_never_the_image() {
        let data = directory("capture");
        let backend = fake();
        let answer = call(&backend, ALL, &data, &|| true, json!({"op": "capture", "id": "simulator:UDID-1"})).unwrap();
        let path = PathBuf::from(answer["path"].as_str().unwrap());
        assert!(path.starts_with(data.join("guests")) && path.extension().unwrap() == "png");
        assert_eq!(std::fs::read(&path).unwrap(), backend.bytes);
        assert_eq!((answer["bytes"].clone(), answer["mime"].clone(), answer["width"].clone(), answer["schemaVersion"].clone()), (json!(7), json!("image/png"), json!(4), json!(1)));
        // The answer is a few hundred bytes whatever the image: a frame does not fit a channel message.
        assert!(answer.to_string().len() < 512 && answer.get("data").is_none());
        assert_eq!(*backend.calls.borrow(), vec!["capture:simulator:UDID-1"]);
        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn an_unsupported_kind_is_unsupported_capability_and_an_unknown_id_is_not_found() {
        let data = directory("refuse");
        let no_vm = Capabilities { vm: false, simulator: true, browser: true };
        for raw in [json!({"op": "capture", "id": "vm:dev"}), json!({"op": "control", "id": "vm:dev", "action": "start"}), json!({"op": "capture", "id": "docker:x"})] {
            assert_eq!(code(call(&fake(), no_vm, &data, &|| true, raw)), "UnsupportedCapability");
        }
        assert_eq!(code(call(&fake(), ALL, &data, &|| true, json!({"op": "capture", "id": "vm:missing"}))), "NotFound");
        assert_eq!(code(call(&fake(), ALL, &data, &|| true, json!({"op": "capture", "id": "novalidid"}))), "InvalidShape");
        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn input_and_control_reach_the_guest_once_and_only_with_the_shapes_of_their_kind() {
        let data = directory("drive");
        let backend = fake();
        assert_eq!(call(&backend, ALL, &data, &|| true, json!({"op": "input", "id": "vm:dev", "input": {"action": "click", "x": 3, "y": 4}})).unwrap()["result"], json!("done"));
        call(&backend, ALL, &data, &|| true, json!({"op": "input", "id": "simulator:UDID-1", "input": {"kind": "tap", "x": 1.0, "y": 2.0}})).unwrap();
        call(&backend, ALL, &data, &|| true, json!({"op": "input", "id": "browser:page", "input": {"action": "read"}})).unwrap();
        assert_eq!(call(&backend, ALL, &data, &|| true, json!({"op": "control", "id": "vm:idle", "action": "start"})).unwrap(), Value::Null);
        call(&backend, ALL, &data, &|| true, json!({"op": "control", "id": "simulator:UDID-1", "action": "dark"})).unwrap();
        call(&backend, ALL, &data, &|| true, json!({"op": "control", "id": "browser:page", "action": "reload"})).unwrap();
        assert_eq!(backend.calls.borrow().len(), 6);
        // A shape of another kind, an unknown action and deleting a VM are refused before the guest hears of it.
        for raw in [json!({"op": "input", "id": "vm:dev", "input": {"kind": "tap"}}), json!({"op": "input", "id": "simulator:UDID-1", "input": {"action": "click"}}), json!({"op": "control", "id": "vm:dev", "action": "delete"}), json!({"op": "control", "id": "browser:page", "action": "start"})] {
            assert_eq!(code(call(&backend, ALL, &data, &|| true, raw)), "InvalidShape");
        }
        assert_eq!(backend.calls.borrow().len(), 6);
        // A guest that is not interactive cannot be captured or driven, but it can be started.
        assert_eq!(code(call(&backend, ALL, &data, &|| true, json!({"op": "capture", "id": "vm:idle"}))), "Conflict");
        assert_eq!(code(call(&backend, ALL, &data, &|| true, json!({"op": "input", "id": "vm:idle", "input": {"action": "click"}}))), "Conflict");
        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn a_revoke_stops_package_control_and_leaves_the_guest_and_its_data_alone() {
        let data = directory("revoke");
        let backend = fake();
        assert_eq!(call(&backend, ALL, &data, &|| false, json!({"op": "list"})).unwrap_err().path, PERMISSION);
        assert_eq!(code(call(&backend, ALL, &data, &|| false, json!({"op": "control", "id": "vm:dev", "action": "stop"}))), "PermissionDenied");
        assert!(backend.calls.borrow().is_empty());
        // A revoke while the image was taken removes the file and answers PermissionDenied: the grant is read once more after the capture.
        let left = Cell::new(2);
        let flips = || { let now = left.get(); left.set(now - 1); now > 0 };
        assert_eq!(code(call(&backend, ALL, &data, &flips, json!({"op": "capture", "id": "browser:page"}))), "PermissionDenied");
        let kept: Vec<_> = std::fs::read_dir(data.join("guests")).map(|entries| entries.filter_map(Result::ok).collect()).unwrap_or_default();
        assert!(kept.is_empty(), "no capture survives a revoke");
        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn a_package_keeps_only_its_newest_captures() {
        let data = directory("prune");
        let frame = Frame { image: Image::Bytes(vec![1, 2, 3]), mime: "image/jpeg", width: None, height: None };
        for _ in 0..KEPT_CAPTURES + 5 { store_frame(&data, "vm", &frame).unwrap(); }
        assert_eq!(std::fs::read_dir(data.join("guests")).unwrap().count(), KEPT_CAPTURES);
        let huge = Frame { image: Image::Bytes(vec![0; MAX_CAPTURE_BYTES as usize + 1]), mime: "image/png", width: None, height: None };
        assert_eq!(store_frame(&data, "vm", &huge).unwrap_err().code, "LimitExceeded");
        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn the_platform_has_a_browser_guest_only_with_a_window_and_the_vm_only_on_apple_silicon() {
        assert!(!platform(true).browser);
        assert_eq!(platform(false).browser, cfg!(any(target_os = "macos", target_os = "windows", target_os = "linux")));
        assert_eq!(platform(false).vm, cfg!(all(target_os = "macos", target_arch = "aarch64")));
        assert!(actions("vm").iter().all(|action| *action != "delete"));
    }
}
