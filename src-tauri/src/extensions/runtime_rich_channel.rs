//! Panel instances and the panel-service channel (R0303, ADR-0001, contract G1/G2).
//!
//! A rich panel served from its package origin (a folder, or a remote page that includes the client) is an
//! **instance**: its own `instanceId`, document and `state`, a placement and a window. The service of the same
//! package talks to its instances with `panda.views.post/onMessage/on/instances`; the page talks back with
//! `pandaView.postMessage`, keeps `pandaView.state` and calls the package SDK through `pandaView.panda`.
//!
//! - **Transport.** Shell to host: `POST /~panda/channel` on the package origin (the `pandapanel` scheme). The
//!   instance is the requesting webview's label, never a field of the body. Host to shell: `Webview::eval` that
//!   dispatches a `panda-view-host` event on the shell, which checks the session and hands the frame what it
//!   carries. Panels still hold no command grant (R0301); nothing a panel sends becomes a native command.
//! - **Identity.** An inspector instance is the slot `main:<viewId>`: a reload or a failure of the panel reattaches
//!   the same instance and its `state` (`restored: true`). A separate window is its label (a reload of the window
//!   keeps it). State lives in memory for one run of the app; at most `DORMANT_LIMIT` closed instances keep it.
//! - **Bounds** (stability and responsiveness of the main window, ADR-0005): a message is at most 256 KiB of JSON,
//!   `state` at most 256 KiB, twenty messages per second per package in each direction averaged over two seconds
//!   (`LimitExceeded` with what to do). A message posted while no instance is alive is not queued
//!   (`delivered: 0`); a document that is reloading queues at most `OUTBOX_LIMIT`. Closing an instance, a disable,
//!   revoke, untrust, update or safe mode drop its pending messages and its in-flight replies.
//! - **Service-only calls** (`secrets.*`, `auth.*`, `storage.directory`, `internal.*`, and every handler
//!   registration: `events`, `hooks`, `modelTools`, `commands`, `views`, `providers`) answer
//!   `UnsupportedCapability` from a panel: secrets never reach a webview, and a handler must outlive a panel.
//! - The legacy inline form (`html`/`css`/`script`) keeps its presentation-only init and theme; its host-composed
//!   document pins `connect-src 'none'` by hash, so it has no return path (predictability, Q026 retained).
use crate::extensions::runtime_service_lifetime::{Dispatch, DispatchRequest};
use serde_json::{json, Value};
use std::{collections::{BTreeMap, VecDeque}, future::Future, pin::Pin, sync::{Arc, LazyLock, Mutex}, time::{Duration, Instant}};

pub const PERMISSION: &str = "ui.richViews";
/// A panel message, either direction (compact JSON bytes).
pub const MESSAGE_LIMIT: usize = 256 * 1024;
/// `pandaView.state` of one instance (compact JSON bytes).
pub const STATE_LIMIT: usize = 256 * 1024;
/// One request body of the shell: a message or a state plus its envelope.
pub const BODY_LIMIT: usize = MESSAGE_LIMIT + 16 * 1024;
/// Messages per second per package and direction, averaged over `RATE_WINDOW`.
pub const RATE_LIMIT: usize = 20;
pub const RATE_WINDOW: Duration = Duration::from_secs(2);
/// Messages kept for an instance whose document is reloading.
pub const OUTBOX_LIMIT: usize = 64;
/// Closed instances whose `state` is kept for a reopen in this run.
pub const DORMANT_LIMIT: usize = 64;
/// The shell's request path on the package origin and the event the host dispatches on the shell.
pub const CHANNEL_PATH: &str = "/~panda/channel";
pub const HOST_EVENT: &str = "panda-view-host";
/// Namespaces that stay in the service; `storage.directory` too.
pub const SERVICE_ONLY: [&str; 9] = ["secrets", "auth", "internal", "events", "hooks", "modelTools", "commands", "views", "providers"];
pub const TOO_FAST: &str = "LimitExceeded: at most 20 panel messages per second per package in each direction (averaged over 2 s). Batch updates into fewer messages or send them less often.";
pub const NO_SERVICE: &str = "UnsupportedCapability: this package has no background service to receive panel messages. Use pandaView.panda for host calls.";
pub const NOT_RUNNING: &str = "HostUnavailable: the package's service is not running. Try again when it has started.";
pub const CLOSED: &str = "StaleContext: this panel instance was closed.";

pub fn service_only(path: &str) -> bool {
    let namespace = path.split('.').next().unwrap_or_default();
    SERVICE_ONLY.contains(&namespace) || path == "storage.directory"
}
pub fn unsupported_in_panel(path: &str) -> String {
    format!("UnsupportedCapability: {path} is a service-only call. Secrets, sign-in, the data directory, internal calls and handler registrations stay in the package's service.")
}
pub fn bytes(value: &Value) -> usize { serde_json::to_vec(value).map_or(usize::MAX, |bytes| bytes.len()) }
pub fn too_large(what: &str, size: usize) -> String {
    format!("LimitExceeded: {what} is at most 256 KiB of JSON (this one is {size} bytes). Send larger data in chunks.")
}
/// The error envelope of the channel: the code first (as the SDK raises it), the actionable sentence beside it.
pub fn refusal(error: &str) -> Value {
    let code = error.split(':').next().unwrap_or("HostUnavailable");
    json!({"ok": false, "error": {"schemaVersion": 1, "code": code, "message": error, "path": "$", "ids": []}})
}
fn ok(value: Value) -> Value { json!({"ok": true, "value": value}) }

/// Admission of one direction of one package: at most `RATE_LIMIT * 2` messages in any two seconds.
#[derive(Default, Debug)]
pub struct Rate { times: VecDeque<Instant> }
impl Rate {
    pub fn admit(&mut self, now: Instant) -> bool {
        while self.times.front().is_some_and(|at| now.saturating_duration_since(*at) >= RATE_WINDOW) { self.times.pop_front(); }
        if self.times.len() >= RATE_LIMIT * RATE_WINDOW.as_secs() as usize { return false; }
        self.times.push_back(now);
        true
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Direction { ToService, ToPanel }

/// Where a mount lives, from its host-chosen label: `(placement, windowId)`.
pub fn placement_of(label: &str) -> Option<(&'static str, String)> {
    if label.starts_with("extension-panel-") { return Some(("inspector", "main".into())); }
    if label.starts_with("extension-view-") { return Some(("window", label.into())); }
    None
}

/// What a mount was opened for (from the host's mount record, never from the page).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Origin { pub owner: String, pub version: String, pub view_id: String }

#[derive(Clone, Debug)]
struct Instance {
    id: String, origin: Origin, placement: &'static str, window_id: String, slot: Option<String>,
    /// The live mount's webview label and its shell session; `None` while closed (dormant).
    label: Option<String>, session: String,
    /// The document answered `hello` and has not said `bye`; `announced` while the service was told `opened`.
    ready: bool, announced: bool, visible: bool, focused: bool,
    state: Option<Value>, outbox: VecDeque<Value>, seen: u64,
}
impl Instance {
    fn public(&self) -> Value {
        json!({"instanceId": self.id, "viewId": self.origin.view_id, "windowId": self.window_id, "placement": self.placement, "visible": self.visible, "focused": self.focused})
    }
    fn push(&self, mut message: Value) -> Option<Out> {
        let label = self.label.clone()?;
        if let Some(object) = message.as_object_mut() { object.insert("schemaVersion".into(), json!(1)); object.insert("session".into(), json!(self.session)); }
        Some(Out::Panel { label, message })
    }
}
fn event(kind: &str, instance: &Instance) -> Out {
    Out::Service { owner: instance.origin.owner.clone(), params: json!({"kind": kind, "viewId": instance.origin.view_id, "instance": instance.public()}) }
}

/// An effect of the channel, applied by the app (`deliver`) and read directly by the tests.
#[derive(Clone, Debug, PartialEq)]
pub enum Out { Panel { label: String, message: Value }, Service { owner: String, params: Value } }

/// One request of a shell, parsed against its mount's session (closed shapes; `invoke` or a `command` field is not one).
#[derive(Clone, Debug, PartialEq)]
pub enum Request { Hello, Bye, Post { id: u64, message: Value }, State(Value), Focus(bool), Call { id: u64, path: String, args: Vec<Value> } }
pub fn parse(body: &[u8], session: &str) -> Result<Request, String> {
    if body.len() > BODY_LIMIT { return Err(too_large("A panel request", body.len())); }
    let value: Value = serde_json::from_slice(body).map_err(|_| "InvalidShape")?;
    let object = value.as_object().ok_or("InvalidShape")?;
    if object.get("schemaVersion") != Some(&json!(1)) || object.get("session").and_then(Value::as_str) != Some(session) { return Err("InvalidShape".into()); }
    let kind = object.get("kind").and_then(Value::as_str).unwrap_or_default();
    let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
    keys.sort_unstable();
    let expected: &[&str] = match kind {
        "hello" | "bye" => &["kind", "schemaVersion", "session"],
        "post" => &["id", "kind", "message", "schemaVersion", "session"],
        "state" => &["kind", "schemaVersion", "session", "value"],
        "focus" => &["focused", "kind", "schemaVersion", "session"],
        "call" => &["args", "id", "kind", "path", "schemaVersion", "session"],
        _ => return Err("InvalidShape".into()),
    };
    if keys != expected { return Err("InvalidShape".into()); }
    let id = || object.get("id").and_then(Value::as_u64).filter(|id| (1..=(1u64 << 53)).contains(id)).ok_or_else(|| "InvalidShape".to_owned());
    Ok(match kind {
        "hello" => Request::Hello,
        "bye" => Request::Bye,
        "post" => Request::Post { id: id()?, message: object["message"].clone() },
        "state" => Request::State(object["value"].clone()),
        "focus" => Request::Focus(object["focused"].as_bool().ok_or("InvalidShape")?),
        _ => {
            let path = object["path"].as_str().filter(|path| valid_path(path)).ok_or("InvalidShape")?.to_owned();
            let args = object["args"].as_array().filter(|args| args.len() <= 4).ok_or("InvalidShape")?.clone();
            Request::Call { id: id()?, path, args }
        }
    })
}
/// `namespace.call` or `namespace.group.call`: letters only, at most 64 characters.
pub fn valid_path(path: &str) -> bool {
    let parts: Vec<&str> = path.split('.').collect();
    path.len() <= 64 && (2..=3).contains(&parts.len()) && parts.iter().all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_alphabetic()))
}
/// The finite theme of `rich-view-channel.js`: a color scheme and at most 16 known tokens.
pub fn valid_theme(theme: &Value) -> bool {
    const TOKENS: [&str; 8] = ["--bg", "--text", "--accent", "--focus", "--muted", "--panel", "--ds-radius-card", "--ds-row-pad-y"];
    let Some(object) = theme.as_object() else { return false };
    // Sorted explicitly: serde_json may be compiled with preserve_order by another dependency.
    let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
    keys.sort_unstable();
    if !(keys == ["colorScheme", "schemaVersion"] || keys == ["colorScheme", "schemaVersion", "tokens"]) { return false; }
    if object["schemaVersion"] != 1 || !matches!(object["colorScheme"].as_str(), Some("dark" | "light")) { return false; }
    let token = |value: &str| (value.len() == 7 && value.starts_with('#') && value[1..].bytes().all(|byte| byte.is_ascii_hexdigit()))
        || (value.ends_with("px") && (3..=4).contains(&value.len()) && value[..value.len() - 2].bytes().all(|byte| byte.is_ascii_digit()));
    object.get("tokens").is_none_or(|tokens| tokens.as_object().is_some_and(|tokens| tokens.len() <= 16 && tokens.iter().all(|(key, value)| TOKENS.contains(&key.as_str()) && value.as_str().is_some_and(token))))
}

/// The proxied SDK call `path(args)` of a panel as the service request it stands for (the same methods and
/// parameters `node-host.cjs` sends), or why it has none.
pub fn route(path: &str, args: &[Value]) -> Result<(&'static str, Value), String> {
    if service_only(path) { return Err(unsupported_in_panel(path)); }
    let arg = |index: usize| args.get(index).cloned().unwrap_or(Value::Null);
    let object = |index: usize| match arg(index) { Value::Null => json!({}), value => value };
    let merged = |base: Value, extra: Value| { let mut base = base; if let (Some(base), Some(extra)) = (base.as_object_mut(), extra.as_object()) { for (key, value) in extra { base.insert(key.clone(), value.clone()); } } base };
    Ok(match path {
        "settings.get" => ("settingsGet", object(0)),
        "context.query" => {
            let mut params = object(0);
            if params.get("limit").is_none() { if let Some(map) = params.as_object_mut() { map.insert("limit".into(), json!(10)); } }
            match params["resource"].as_str() {
                Some("tasks" | "transcript" | "tools" | "changes") => ("contentQuery", params),
                Some("usage" | "limits" | "accounts" | "metrics") => ("usageQuery", params),
                // Other context reads answer for the command they were invoked from; a panel is not one.
                _ => return Err("StaleContext: this context read answers for an owned command's context; a panel has none.".into()),
            }
        }
        "harnesses.refreshLimits" => ("limitsRefresh", object(0)),
        "harnesses.switchAccount" => ("accountSwitch", object(0)),
        "tasks.start" => ("tasksStart", object(0)),
        "tasks.message" => ("tasksMessage", json!({"taskId": arg(0), "message": arg(1)})),
        "tasks.note" => ("tasksNote", json!({"taskId": arg(0), "note": arg(1)})),
        "tasks.queue.list" | "tasks.queue.resume" => ("tasksQueue", json!({"op": &path[12..], "taskId": arg(0)})),
        "tasks.queue.remove" | "tasks.queue.sendNow" => ("tasksQueue", json!({"op": &path[12..], "taskId": arg(0), "entryId": arg(1)})),
        "tasks.queue.update" => ("tasksQueue", json!({"op": "update", "taskId": arg(0), "entryId": arg(1), "change": arg(2)})),
        "tasks.queue.reorder" => ("tasksQueue", json!({"op": "reorder", "taskId": arg(0), "entryIds": arg(1)})),
        "ui.notify" => ("notice", json!({"op": "notify", "notice": arg(0)})),
        "ui.withdraw" => ("notice", json!({"op": "withdraw", "key": arg(0)})),
        "ui.register" => ("ui", json!({"op": "register", "item": arg(0)})),
        "ui.update" | "ui.updateView" => ("ui", json!({"op": &path[3..], "id": arg(0), "patch": arg(1)})),
        "ui.showDialog" => ("uiDialog", arg(0)),
        "ui.reveal" => ("uiReveal", arg(0)),
        "connections.status" | "connections.start" | "connections.poll" | "connections.cancel" => ("connectionsRequest", merged(object(0), json!({"op": &path[12..]}))),
        "workspace.settings.list" => ("workspaceSettings", json!({"op": "list"})),
        "workspace.settings.get" => ("workspaceSettings", json!({"op": "get", "key": arg(0)})),
        "workspace.settings.set" => ("workspaceSettings", merged(json!({"op": "set", "key": arg(0), "value": arg(1)}), arg(2).get("revision").map(|revision| json!({"revision": revision})).unwrap_or(json!({})))),
        _ => return Err(format!("UnsupportedCapability: {path} is not a call of the package SDK in a panel in this release.")),
    })
}

/// Every instance of the app, the rate windows and the current theme. Pure: effects are returned as `Out`.
#[derive(Default)]
pub struct Channel { instances: BTreeMap<String, Instance>, labels: BTreeMap<String, String>, rates: BTreeMap<(String, Direction), Rate>, theme: Option<Value>, clock: u64 }

impl Channel {
    fn rate(&mut self, owner: &str, direction: Direction, now: Instant) -> bool { self.rates.entry((owner.to_owned(), direction)).or_default().admit(now) }
    fn live(&self, label: &str) -> Result<&Instance, String> {
        self.labels.get(label).and_then(|id| self.instances.get(id)).filter(|instance| instance.label.as_deref() == Some(label)).ok_or_else(|| CLOSED.to_owned())
    }
    fn live_mut(&mut self, label: &str) -> Result<&mut Instance, String> {
        let id = self.labels.get(label).cloned().ok_or(CLOSED)?;
        self.instances.get_mut(&id).filter(|instance| instance.label.as_deref() == Some(label)).ok_or_else(|| CLOSED.to_owned())
    }

    /// The shell's handshake: attaches (or reattaches) the instance of mount `label` and answers what the page is
    /// initialized with, plus the messages queued while its document was loading. The service hears `opened` once
    /// per live period.
    pub fn hello(&mut self, label: &str, session: &str, origin: Origin) -> Result<(Value, Vec<Out>), String> {
        let (placement, window_id) = placement_of(label).ok_or("PermissionDenied")?;
        self.clock += 1;
        let same = self.labels.get(label).cloned().filter(|id| self.instances.get(id).is_some_and(|instance| instance.origin == origin));
        let (id, restored) = match same {
            Some(id) => (id, true),
            None => {
                if let Some(old) = self.labels.remove(label) { self.instances.remove(&old); }
                let slot = (placement == "inspector").then(|| format!("{window_id}:{}", origin.view_id));
                let dormant = slot.as_ref().and_then(|slot| self.instances.iter().find(|(_, instance)| instance.label.is_none() && instance.slot.as_ref() == Some(slot) && instance.origin == origin).map(|(id, _)| id.clone()));
                match dormant {
                    Some(id) => (id, true),
                    None => {
                        let id = uuid::Uuid::new_v4().to_string();
                        self.instances.insert(id.clone(), Instance { id: id.clone(), origin, placement, window_id, slot, label: None, session: String::new(), ready: false, announced: false, visible: true, focused: false, state: None, outbox: VecDeque::new(), seen: 0 });
                        (id, false)
                    }
                }
            }
        };
        self.labels.insert(label.to_owned(), id.clone());
        let clock = self.clock;
        let theme = self.theme.clone();
        let instance = self.instances.get_mut(&id).ok_or("HostUnavailable")?;
        let opened = !instance.announced;
        if instance.label.as_deref() != Some(label) { instance.visible = true; instance.focused = false; }
        instance.label = Some(label.to_owned()); instance.session = session.to_owned();
        instance.ready = true; instance.announced = true; instance.seen = clock;
        let pending: Vec<Value> = instance.outbox.drain(..).collect();
        let mut init = json!({"instanceId": instance.id, "viewId": instance.origin.view_id, "placement": instance.placement, "restored": restored, "visible": instance.visible, "pending": pending});
        if let Some(state) = &instance.state { init["state"] = state.clone(); }
        if let Some(theme) = theme { init["theme"] = theme; }
        Ok((init, if opened { vec![event("opened", instance)] } else { vec![] }))
    }
    /// The shell's document is going away (a reload or a navigation): later messages wait in the outbox.
    pub fn bye(&mut self, label: &str) { if let Ok(instance) = self.live_mut(label) { instance.ready = false; } }
    pub fn set_state(&mut self, label: &str, value: Value) -> Result<(), String> {
        let size = bytes(&value);
        if size > STATE_LIMIT { return Err(too_large("pandaView.state", size)); }
        self.live_mut(label)?.state = Some(value);
        Ok(())
    }
    pub fn state(&self, label: &str) -> Option<Value> { self.live(label).ok().and_then(|instance| instance.state.clone()) }
    pub fn set_focus(&mut self, label: &str, focused: bool) -> Result<(), String> { self.live_mut(label)?.focused = focused; Ok(()) }
    /// R0305: whether the live instance of mount `label` has the keyboard (its shell's last `focus` report).
    pub fn focused(&self, label: &str) -> bool { self.live(label).is_ok_and(|instance| instance.focused) }
    /// A message of a panel for its service: the bounds, then the host call's parameters.
    pub fn from_panel(&mut self, label: &str, message: Value, now: Instant) -> Result<(String, Value), String> {
        let size = bytes(&message);
        if size > MESSAGE_LIMIT { return Err(too_large("A panel message", size)); }
        let owner = self.live(label)?.origin.owner.clone();
        if !self.rate(&owner, Direction::ToService, now) { return Err(TOO_FAST.into()); }
        let instance = self.live(label)?;
        Ok((owner, json!({"kind": "message", "viewId": instance.origin.view_id, "message": message, "instance": instance.public()})))
    }
    /// A proxied SDK call of a panel: service-only calls never leave the panel's instance.
    pub fn call(&self, label: &str, path: &str) -> Result<Origin, String> {
        let origin = self.live(label)?.origin.clone();
        if service_only(path) { return Err(unsupported_in_panel(path)); }
        Ok(origin)
    }
    /// The answer of a message or a call, for the instance that asked, if it is still the same live document.
    pub fn reply(&self, label: &str, session: &str, id: u64, envelope: &Value) -> Option<Out> {
        let instance = self.live(label).ok().filter(|instance| instance.session == session)?;
        let mut message = json!({"kind": "reply", "id": id, "ok": envelope["ok"] == true});
        if envelope["ok"] == true { message["value"] = envelope.get("value").cloned().unwrap_or(Value::Null); } else { message["error"] = envelope["error"].clone(); }
        instance.push(message)
    }
    /// The mount `label` ended. `keep` leaves an inspector instance's state for a reopen in this run; otherwise
    /// (a window, a lifecycle end) the instance goes. Its pending messages go either way.
    pub fn detach(&mut self, label: &str, keep: bool) -> Vec<Out> {
        let Some(id) = self.labels.remove(label) else { return vec![] };
        let Some(instance) = self.instances.get_mut(&id).filter(|instance| instance.label.as_deref() == Some(label)) else { return vec![] };
        instance.label = None; instance.ready = false; instance.focused = false; instance.visible = false; instance.outbox.clear();
        let closed = instance.announced.then(|| event("closed", instance));
        instance.announced = false;
        if !keep || instance.slot.is_none() { self.instances.remove(&id); }
        self.trim();
        closed.into_iter().collect()
    }
    fn trim(&mut self) {
        loop {
            let dormant: Vec<(u64, String)> = self.instances.values().filter(|instance| instance.label.is_none()).map(|instance| (instance.seen, instance.id.clone())).collect();
            if dormant.len() <= DORMANT_LIMIT { return; }
            if let Some((_, id)) = dormant.into_iter().min() { self.instances.remove(&id); }
        }
    }
    /// Shown or hidden by the host (the inspector's bounds, a minimized or hidden window).
    pub fn set_visible(&mut self, label: &str, visible: bool) -> Vec<Out> {
        let Ok(instance) = self.live_mut(label) else { return vec![] };
        if instance.visible == visible { return vec![]; }
        instance.visible = visible;
        if !instance.announced { return vec![]; }
        let instance = &*instance;
        let mut outs = vec![event(if visible { "visible" } else { "hidden" }, instance)];
        if instance.ready { outs.extend(instance.push(json!({"kind": "visibility", "visible": visible}))); }
        outs
    }
    /// `panda.views.post`: every live instance of `view_id` (or the one `target`), in order. Answers how many
    /// received it; nothing is kept for a closed instance.
    pub fn to_panels(&mut self, owner: &str, view_id: &str, message: Value, target: Option<&str>, now: Instant) -> Result<(usize, Vec<Out>), String> {
        let size = bytes(&message);
        if size > MESSAGE_LIMIT { return Err(too_large("A panel message", size)); }
        if !self.rate(owner, Direction::ToPanel, now) { return Err(TOO_FAST.into()); }
        let mut delivered = 0;
        let mut outs = vec![];
        for instance in self.instances.values_mut() {
            if instance.origin.owner != owner || instance.origin.view_id != view_id || instance.label.is_none() || target.is_some_and(|target| target != instance.id) { continue; }
            if instance.ready { outs.extend(instance.push(json!({"kind": "message", "message": message.clone()}))); delivered += 1; }
            else if instance.outbox.len() < OUTBOX_LIMIT { instance.outbox.push_back(json!({"kind": "message", "message": message.clone()})); delivered += 1; }
        }
        Ok((delivered, outs))
    }
    /// `panda.views.instances`: the live instances of the package (of one view).
    pub fn instances(&self, owner: &str, view_id: Option<&str>) -> Vec<Value> {
        self.instances.values().filter(|instance| instance.origin.owner == owner && instance.label.is_some() && view_id.is_none_or(|view| view == instance.origin.view_id)).map(Instance::public).collect()
    }
    /// The app's appearance changed: every initialized instance follows it.
    pub fn set_theme(&mut self, theme: Value) -> Vec<Out> {
        self.theme = Some(theme.clone());
        self.instances.values().filter(|instance| instance.ready).filter_map(|instance| instance.push(json!({"kind": "theme", "theme": theme.clone()}))).collect()
    }
    /// Lifecycle: closed instances of packages that may no longer show panels lose their state.
    pub fn purge(&mut self, allowed: impl Fn(&Origin) -> bool) { self.instances.retain(|_, instance| instance.label.is_some() || allowed(&instance.origin)); }
    pub fn dormant(&self) -> usize { self.instances.values().filter(|instance| instance.label.is_none()).count() }
}

// ---- the app ----------------------------------------------------------------------------------------------------

static CHANNEL: LazyLock<Mutex<Channel>> = LazyLock::new(Mutex::default);
fn with<T: Default>(run: impl FnOnce(&mut Channel) -> T) -> T { CHANNEL.lock().map(|mut channel| run(&mut channel)).unwrap_or_default() }

/// Hands one panel message or event to the running service of a package (the host call `panel`), resolving when the
/// service has taken it.
pub type PanelCall = Arc<dyn Fn(String, Value) -> Pin<Box<dyn Future<Output = Result<Value, String>> + Send>> + Send + Sync>;
/// What the service side lends the channel: the host call into a service and the server of the service's requests
/// (a panel's proxied calls go through it, so grants are checked per call). `runtime_service_lifetime::reconcile_app`
/// connects them; until then panel messages answer `HostUnavailable`.
#[derive(Clone)]
pub struct Hooks { pub call: PanelCall, pub dispatch: Dispatch }
static HOOKS: Mutex<Option<Hooks>> = Mutex::new(None);
pub fn connect(hooks: Hooks) { if let Ok(mut slot) = HOOKS.lock() { *slot = Some(hooks); } }
fn hooks() -> Option<Hooks> { HOOKS.lock().ok().and_then(|slot| slot.clone()) }
async fn call_service(owner: String, params: Value) -> Result<Value, String> {
    match hooks() { Some(hooks) => (hooks.call)(owner, params).await, None => Err("HostUnavailable".into()) }
}

/// The script that hands `message` to a shell (a JSON literal inside a fixed statement).
pub fn script(message: &Value) -> String { format!("window.dispatchEvent(new CustomEvent({}, {{ detail: {} }}));", json!(HOST_EVENT), message) }

/// Applies effects: pushes into panel webviews, events and messages into the package's service.
pub fn deliver(app: &tauri::AppHandle, outs: Vec<Out>) {
    use tauri::Manager;
    for out in outs {
        match out {
            Out::Panel { label, message } => { if let Some(view) = app.get_webview(&label) { let _ = view.eval(script(&message)); } }
            Out::Service { owner, params } => { tauri::async_runtime::spawn(async move { let _ = call_service(owner, params).await; }); }
        }
    }
}

fn declares_service(app: &tauri::AppHandle, owner: &str) -> bool {
    use tauri::Manager;
    let Some(packages) = app.try_state::<crate::extensions::packages::ExtensionPackages>() else { return false };
    let Ok(packages) = packages.0.try_lock() else { return true };
    packages.snapshot().packages.iter().any(|package| package.manifest["id"] == owner && crate::extensions::runtime_service_lifetime::declares_service(&package.manifest))
}

/// `POST /~panda/channel` from the shell of mount `label` (its host-recorded session and origin). Answers at once;
/// a message's and a call's results arrive later as a `reply` push.
pub fn serve_post(app: &tauri::AppHandle, label: &str, session: &str, origin: Origin, body: &[u8]) -> Value {
    // R0304: keys the page left alone and releaseFocus (kinds `key` and `release`) are `runtime_rich_focus`'s.
    if let Some(answer) = super::runtime_rich_focus::serve_post(app, label, session, body) { return answer; }
    let request = match parse(body, session) { Ok(request) => request, Err(error) => return refusal(&error) };
    match request {
        Request::Hello => match with(|channel| Some(channel.hello(label, session, origin))).unwrap_or_else(|| Err("HostUnavailable".into())) {
            Ok((init, outs)) => { deliver(app, outs); ok(init) }
            Err(error) => refusal(&error),
        },
        Request::Bye => { with(|channel| channel.bye(label)); ok(Value::Null) }
        Request::Focus(focused) => match with(|channel| Some(channel.set_focus(label, focused))).unwrap_or_else(|| Err(CLOSED.into())) { Ok(()) => ok(Value::Null), Err(error) => refusal(&error) },
        Request::State(value) => match with(|channel| Some(channel.set_state(label, value))).unwrap_or_else(|| Err(CLOSED.into())) { Ok(()) => ok(Value::Null), Err(error) => refusal(&error) },
        Request::Post { id, message } => {
            let admitted = with(|channel| Some(channel.from_panel(label, message, Instant::now()))).unwrap_or_else(|| Err(CLOSED.into()));
            let (owner, params) = match admitted { Ok(admitted) => admitted, Err(error) => return refusal(&error) };
            let (app, label, session) = (app.clone(), label.to_owned(), session.to_owned());
            tauri::async_runtime::spawn(async move {
                let result = call_service(owner.clone(), params).await;
                let envelope = match result {
                    Ok(_) => ok(Value::Null),
                    Err(code) if code == "HostUnavailable" => refusal(if declares_service(&app, &owner) { NOT_RUNNING } else { NO_SERVICE }),
                    Err(code) if code == "LimitExceeded" => refusal("LimitExceeded: the service has 64 messages and calls waiting. Send fewer messages or wait for its answers."),
                    Err(code) => refusal(&code),
                };
                // An instance closed mid-response gets nothing: its document is gone.
                let out = with(|channel| channel.reply(&label, &session, id, &envelope));
                deliver(&app, out.into_iter().collect());
            });
            ok(json!({"accepted": true}))
        }
        Request::Call { id, path, args } => {
            let origin = match with(|channel| Some(channel.call(label, &path))).unwrap_or_else(|| Err(CLOSED.into())) { Ok(origin) => origin, Err(error) => return refusal(&error) };
            let (method, params) = match route(&path, &args) { Ok(routed) => routed, Err(error) => return refusal(&error) };
            // R0305: a page of a package without a service made host work, which ends with its panel authority.
            super::runtime_panel_only::note_call(&origin.owner, &origin.version);
            let (app, label, session) = (app.clone(), label.to_owned(), session.to_owned());
            tauri::async_runtime::spawn(async move {
                // The same server as the service's requests: grants are checked per call for the package.
                let request = DispatchRequest { owner: origin.owner, method: method.into(), params, handle: None };
                let envelope = match hooks() { Some(hooks) => (hooks.dispatch)(request).await, None => refusal("HostUnavailable: the extension host is starting. Try again.") };
                let out = with(|channel| channel.reply(&label, &session, id, &envelope));
                deliver(&app, out.into_iter().collect());
            });
            ok(json!({"accepted": true}))
        }
    }
}

/// The service's `panda.views` requests (`views` with `op` `post` or `instances`), under `ui.richViews`.
pub async fn serve(app: tauri::AppHandle, request: DispatchRequest) -> Value {
    tauri::async_runtime::spawn_blocking(move || serve_now(&app, &request)).await.unwrap_or_else(|_| refusal("HostUnavailable"))
}
fn serve_now(app: &tauri::AppHandle, request: &DispatchRequest) -> Value {
    use tauri::Manager;
    let Some(packages) = app.try_state::<crate::extensions::packages::ExtensionPackages>() else { return refusal("HostUnavailable") };
    let snapshot = match packages.0.lock() { Ok(packages) => packages.snapshot(), Err(_) => return refusal("HostUnavailable") };
    let Some(package) = snapshot.packages.iter().find(|package| package.manifest["id"] == request.owner.as_str()) else { return refusal("PermissionDenied") };
    let version = package.manifest["version"].as_str().unwrap_or_default().to_owned();
    if let Err(error) = crate::extensions::rich_views::runtime_rich_mount::authorize_app(app, &snapshot, &request.owner, &version) { return refusal(&error); }
    let declared = |view: &str| package.manifest["contributes"]["views"].as_array().into_iter().flatten().any(|item| item["id"] == view && item.get("rich").is_some());
    let params = &request.params;
    match params["op"].as_str() {
        Some("post") => {
            let Some(view) = params["viewId"].as_str().filter(|view| declared(view)) else { return refusal("NotFound: viewId is not a rich view of this package.") };
            let target = match params.get("instance") { None | Some(Value::Null) => None, Some(Value::String(id)) if id.len() <= 64 => Some(id.as_str()), _ => return refusal("InvalidShape") };
            let Some(message) = params.get("message").cloned() else { return refusal("InvalidShape") };
            match with(|channel| Some(channel.to_panels(&request.owner, view, message, target, Instant::now()))).unwrap_or_else(|| Err("HostUnavailable".into())) {
                Ok((delivered, outs)) => { deliver(app, outs); ok(json!({"delivered": delivered})) }
                Err(error) => refusal(&error),
            }
        }
        Some("instances") => {
            let view = match params.get("viewId") { None | Some(Value::Null) => None, Some(Value::String(view)) if declared(view) => Some(view.as_str()), _ => return refusal("NotFound: viewId is not a rich view of this package.") };
            ok(Value::Array(with(|channel| channel.instances(&request.owner, view))))
        }
        _ => refusal("InvalidShape"),
    }
}

/// The main window's appearance (scheme and tokens), emitted at the first panel and at every palette change. Only
/// the main window may emit events (`core:default` is its capability alone; panels hold no command grant and the
/// auxiliary windows only listen), and the theme is checked against the finite schema before any panel sees it.
pub const THEME_EVENT: &str = "extensions-rich-channel-theme";
static THEME_LISTENER: std::sync::Once = std::sync::Once::new();
/// Listens for `THEME_EVENT` once per app (called from `reconcile_app` at start and after every lifecycle change).
pub fn install(app: &tauri::AppHandle) {
    THEME_LISTENER.call_once(|| {
        use tauri::Listener;
        let handle = app.clone();
        app.listen_any(THEME_EVENT, move |event| { if let Ok(theme) = serde_json::from_str::<Value>(event.payload()) { let _ = set_theme(&handle, theme); } });
    });
}
/// Every initialized instance follows `theme`; a theme outside the finite schema is refused.
pub fn set_theme(app: &tauri::AppHandle, theme: Value) -> Result<(), String> {
    if !valid_theme(&theme) { return Err("InvalidShape".into()); }
    deliver(app, with(|channel| channel.set_theme(theme)));
    Ok(())
}
/// Every teardown of a mount (`runtime_rich_mount::forget` and the window paths).
pub fn detach(app: &tauri::AppHandle, label: &str, keep: bool) { deliver(app, with(|channel| channel.detach(label, keep))); }
pub fn visibility(app: &tauri::AppHandle, label: &str, visible: bool) { deliver(app, with(|channel| channel.set_visible(label, visible))); }
/// R0305: whether the live instance of mount `label` has the keyboard (read before a mount ends).
pub fn focused(label: &str) -> bool { with(|channel| channel.focused(label)) }
/// After every lifecycle change: closed instances of packages that may no longer show panels lose their state.
pub fn reconcile(app: &tauri::AppHandle) {
    use tauri::Manager;
    let Some(packages) = app.try_state::<crate::extensions::packages::ExtensionPackages>() else { return };
    let snapshot = match packages.0.lock() { Ok(packages) => packages.snapshot(), Err(_) => return };
    let allowed = |origin: &Origin| crate::extensions::rich_views::runtime_rich_mount::authorize_app(app, &snapshot, &origin.owner, &origin.version).is_ok();
    // Authorization is read before the channel lock is taken (it syncs the grants file).
    let origins: Vec<Origin> = with(|channel| channel.instances.values().filter(|instance| instance.label.is_none()).map(|instance| instance.origin.clone()).collect());
    let keep: Vec<Origin> = origins.into_iter().filter(|origin| allowed(origin)).collect();
    with(|channel| channel.purge(|origin| keep.contains(origin)));
}

#[cfg(test)]
mod tests {
    use super::*;
    const MANIFEST: &str = include_str!("../../../tests/fixtures/extensions/runtime-rich-channel/extension.json");
    const OWNER: &str = "sample.rich-channel";
    const BOARD: &str = "sample.rich-channel/board";
    fn origin() -> Origin { Origin { owner: OWNER.into(), version: "1.0.0".into(), view_id: BOARD.into() } }
    fn panels(outs: &[Out]) -> Vec<(String, Value)> { outs.iter().filter_map(|out| match out { Out::Panel { label, message } => Some((label.clone(), message.clone())), _ => None }).collect() }
    fn events(outs: &[Out]) -> Vec<String> { outs.iter().filter_map(|out| match out { Out::Service { params, .. } => params["kind"].as_str().map(str::to_owned), _ => None }).collect() }

    #[test]
    fn the_fixture_declares_a_folder_board_and_a_service() {
        let manifest: Value = serde_json::from_str(MANIFEST).unwrap();
        assert_eq!(manifest["id"], OWNER);
        assert!(manifest["permissions"].as_array().unwrap().contains(&json!(PERMISSION)));
        assert_eq!(manifest["contributes"]["views"][0]["id"], BOARD);
        assert!(crate::extensions::runtime_service_lifetime::declares_service(&manifest));
    }

    #[test]
    fn two_instances_get_distinct_ids_shared_updates_visibility_and_targeted_replies() {
        let mut channel = Channel::default();
        let now = Instant::now();
        let (a, opened_a) = channel.hello("extension-panel-a", "s-a", origin()).unwrap();
        let (b, opened_b) = channel.hello("extension-view-b", "s-b", origin()).unwrap();
        assert_ne!(a["instanceId"], b["instanceId"]);
        assert_eq!((a["placement"].as_str(), b["placement"].as_str()), (Some("inspector"), Some("window")));
        assert_eq!((events(&opened_a), events(&opened_b)), (vec!["opened".to_owned()], vec!["opened".to_owned()]));
        assert_eq!(channel.instances(OWNER, Some(BOARD)).len(), 2);
        assert_eq!(channel.instances(OWNER, None)[0]["windowId"], "main");
        // A shared update reaches both, in order, each with its own session.
        let (delivered, outs) = channel.to_panels(OWNER, BOARD, json!({"revision": 1}), None, now).unwrap();
        assert_eq!(delivered, 2);
        let pushed = panels(&outs);
        assert_eq!(pushed.iter().map(|(label, message)| (label.as_str(), message["session"].as_str().unwrap())).collect::<Vec<_>>(), vec![("extension-panel-a", "s-a"), ("extension-view-b", "s-b")]);
        // A targeted response reaches only its instance.
        let target = b["instanceId"].as_str().unwrap();
        let (delivered, outs) = channel.to_panels(OWNER, BOARD, json!({"ack": 7}), Some(target), now).unwrap();
        assert_eq!((delivered, panels(&outs).len(), panels(&outs)[0].0.as_str()), (1, 1, "extension-view-b"));
        // Another package's instance or an unknown one receives nothing.
        assert_eq!(channel.to_panels("sample.other", BOARD, json!({}), None, now).unwrap().0, 0);
        assert_eq!(channel.to_panels(OWNER, BOARD, json!({}), Some("unknown"), now).unwrap().0, 0);
        // Visibility: once per change, to the panel and to the service.
        let outs = channel.set_visible("extension-panel-a", false);
        assert_eq!(events(&outs), vec!["hidden"]);
        assert_eq!(panels(&outs)[0].1["kind"], "visibility");
        assert!(channel.set_visible("extension-panel-a", false).is_empty());
        assert_eq!(events(&channel.set_visible("extension-panel-a", true)), vec!["visible"]);
        // A message from a panel names its instance.
        let (owner, params) = channel.from_panel("extension-view-b", json!({"claim": "T-1"}), now).unwrap();
        assert_eq!((owner.as_str(), params["instance"]["instanceId"].as_str()), (OWNER, Some(target)));
    }

    #[test]
    fn state_survives_reload_and_failure_of_an_inspector_panel_but_not_a_lifecycle_end() {
        let mut channel = Channel::default();
        let (first, _) = channel.hello("extension-panel-1", "s1", origin()).unwrap();
        assert_eq!(first["restored"], false);
        channel.set_state("extension-panel-1", json!({"selected": "T-2"})).unwrap();
        // The panel failed or was reloaded: a new mount of the same slot is the same instance with its state.
        assert_eq!(events(&channel.detach("extension-panel-1", true)), vec!["closed"]);
        let (again, outs) = channel.hello("extension-panel-2", "s2", origin()).unwrap();
        assert_eq!((again["instanceId"].clone(), again["restored"].clone(), again["state"].clone()), (first["instanceId"].clone(), json!(true), json!({"selected": "T-2"})));
        assert_eq!(events(&outs), vec!["opened"]);
        // A lifecycle end drops it.
        channel.detach("extension-panel-2", false);
        assert_eq!(channel.dormant(), 0);
        let (fresh, _) = channel.hello("extension-panel-3", "s3", origin()).unwrap();
        assert_ne!(fresh["instanceId"], first["instanceId"]);
        assert!(fresh.get("state").is_none());
        // Purge keeps only what is still allowed.
        channel.detach("extension-panel-3", true);
        channel.purge(|_| false);
        assert_eq!(channel.dormant(), 0);
    }

    #[test]
    fn state_and_messages_are_bounded_at_256_kib_and_twenty_per_second_with_actionable_errors() {
        let mut channel = Channel::default();
        let now = Instant::now();
        channel.hello("extension-panel-a", "s", origin()).unwrap();
        let big = json!("x".repeat(STATE_LIMIT));
        let error = channel.set_state("extension-panel-a", big.clone()).unwrap_err();
        assert!(error.starts_with("LimitExceeded") && error.contains("256 KiB"), "{error}");
        channel.set_state("extension-panel-a", json!("x".repeat(STATE_LIMIT - 2))).unwrap();
        assert!(channel.from_panel("extension-panel-a", big.clone(), now).unwrap_err().contains("chunks"));
        assert!(channel.to_panels(OWNER, BOARD, big, None, now).unwrap_err().starts_with("LimitExceeded"));
        // Forty in two seconds per direction, then LimitExceeded until the window moves.
        for index in 0..40 { channel.from_panel("extension-panel-a", json!(index), now).unwrap(); }
        assert_eq!(channel.from_panel("extension-panel-a", json!(41), now).unwrap_err(), TOO_FAST);
        // The other direction has its own window.
        channel.to_panels(OWNER, BOARD, json!(1), None, now).unwrap();
        channel.from_panel("extension-panel-a", json!(42), now + RATE_WINDOW).unwrap();
        let mut rate = Rate::default();
        assert!((0..40).all(|_| rate.admit(now)) && !rate.admit(now + Duration::from_millis(1999)) && rate.admit(now + RATE_WINDOW));
    }

    #[test]
    fn closing_removes_pending_messages_and_in_flight_replies() {
        let mut channel = Channel::default();
        let now = Instant::now();
        channel.hello("extension-view-w", "s", origin()).unwrap();
        // The window reloads: messages wait in the outbox and arrive with the next hello.
        channel.bye("extension-view-w");
        assert_eq!(channel.to_panels(OWNER, BOARD, json!({"n": 1}), None, now).unwrap(), (1, vec![]));
        let (init, _) = channel.hello("extension-view-w", "s2", origin()).unwrap();
        assert_eq!(init["pending"], json!([{"kind": "message", "message": {"n": 1}}]));
        assert_eq!(init["restored"], true);
        // Closed mid-response: the outbox goes, the reply is dropped, a later post reaches nobody.
        channel.bye("extension-view-w");
        channel.to_panels(OWNER, BOARD, json!({"n": 2}), None, now).unwrap();
        assert_eq!(events(&channel.detach("extension-view-w", true)), vec!["closed"]);
        assert!(channel.reply("extension-view-w", "s2", 5, &json!({"ok": true, "value": null})).is_none());
        assert_eq!(channel.to_panels(OWNER, BOARD, json!({"n": 3}), None, now).unwrap(), (0, vec![]));
        // A window instance never stays dormant.
        assert_eq!(channel.dormant(), 0);
        // A reply to a live instance carries its id and outcome.
        channel.hello("extension-panel-a", "s", origin()).unwrap();
        let Some(Out::Panel { message, .. }) = channel.reply("extension-panel-a", "s", 9, &refusal(TOO_FAST)) else { panic!("no reply") };
        assert_eq!((message["id"].as_u64(), message["ok"].as_bool(), message["error"]["code"].as_str()), (Some(9), Some(false), Some("LimitExceeded")));
        assert!(channel.reply("extension-panel-a", "other-session", 9, &json!({"ok": true})).is_none());
    }

    #[test]
    fn service_only_calls_answer_unsupported_capability_and_others_route_like_the_service() {
        let mut channel = Channel::default();
        channel.hello("extension-panel-a", "s", origin()).unwrap();
        for path in ["secrets.get", "auth.signIn", "storage.directory", "internal.invoke", "events.on", "hooks.on", "modelTools.register", "commands.register", "views.post", "providers.update"] {
            assert!(channel.call("extension-panel-a", path).unwrap_err().starts_with("UnsupportedCapability"), "{path}");
            assert!(route(path, &[]).unwrap_err().starts_with("UnsupportedCapability"), "{path}");
        }
        assert_eq!(route("tasks.start", &[json!({"projectId": "p"})]).unwrap(), ("tasksStart", json!({"projectId": "p"})));
        assert_eq!(route("tasks.queue.reorder", &[json!("t"), json!(["a"])]).unwrap(), ("tasksQueue", json!({"op": "reorder", "taskId": "t", "entryIds": ["a"]})));
        assert_eq!(route("context.query", &[json!({"resource": "tasks"})]).unwrap(), ("contentQuery", json!({"resource": "tasks", "limit": 10})));
        assert_eq!(route("ui.updateView", &[json!("i"), json!({"text": "x"})]).unwrap(), ("ui", json!({"op": "updateView", "id": "i", "patch": {"text": "x"}})));
        assert_eq!(route("connections.poll", &[json!({"id": "c"})]).unwrap(), ("connectionsRequest", json!({"id": "c", "op": "poll"})));
        assert!(route("context.query", &[json!({"resource": "files"})]).unwrap_err().starts_with("StaleContext"));
        assert!(channel.call("extension-panel-zz", "tasks.start").unwrap_err().starts_with("StaleContext"));
    }

    #[test]
    fn shell_requests_are_closed_shapes_bound_to_the_mount_session() {
        let request = |value: Value| serde_json::to_vec(&value).unwrap();
        assert_eq!(parse(&request(json!({"schemaVersion": 1, "session": "s", "kind": "hello"})), "s").unwrap(), Request::Hello);
        assert_eq!(parse(&request(json!({"schemaVersion": 1, "session": "s", "kind": "post", "id": 1, "message": {"a": 1}})), "s").unwrap(), Request::Post { id: 1, message: json!({"a": 1}) });
        for forged in [
            json!({"schemaVersion": 1, "session": "other", "kind": "hello"}),
            json!({"schemaVersion": 2, "session": "s", "kind": "hello"}),
            json!({"schemaVersion": 1, "session": "s", "kind": "invoke", "command": "read_file"}),
            json!({"schemaVersion": 1, "session": "s", "kind": "hello", "command": "read_file"}),
            json!({"schemaVersion": 1, "session": "s", "kind": "post", "id": 0, "message": 1}),
            json!({"schemaVersion": 1, "session": "s", "kind": "post", "id": 1, "message": 1, "instance": "x"}),
            json!({"schemaVersion": 1, "session": "s", "kind": "call", "id": 1, "path": "../x", "args": []}),
            json!({"schemaVersion": 1, "session": "s", "kind": "call", "id": 1, "path": "tasks.start", "args": {}}),
        ] { assert!(parse(&request(forged.clone()), "s").is_err(), "{forged}"); }
        assert!(parse(&vec![b' '; BODY_LIMIT + 1], "s").unwrap_err().starts_with("LimitExceeded"));
        assert!(placement_of("main").is_none() && placement_of("extension-panel-x").is_some());
        assert!(valid_theme(&json!({"schemaVersion": 1, "colorScheme": "dark", "tokens": {"--accent": "#336699", "--ds-radius-card": "12px"}})));
        for theme in [json!({"schemaVersion": 1, "colorScheme": "url(x)"}), json!({"schemaVersion": 1, "colorScheme": "dark", "tokens": {"--bg": "red"}}), json!({"schemaVersion": 1, "colorScheme": "dark", "extra": 1})] { assert!(!valid_theme(&theme), "{theme}"); }
        assert!(script(&json!({"kind": "theme"})).starts_with("window.dispatchEvent(new CustomEvent(\"panda-view-host\""));
    }

    #[test]
    fn theme_follows_every_initialized_instance_and_dormant_state_is_bounded() {
        let mut channel = Channel::default();
        channel.hello("extension-panel-a", "s", origin()).unwrap();
        let theme = json!({"schemaVersion": 1, "colorScheme": "light"});
        assert_eq!(panels(&channel.set_theme(theme.clone()))[0].1["theme"], theme);
        let (init, _) = channel.hello("extension-view-b", "s", origin()).unwrap();
        assert_eq!(init["theme"], theme);
        for index in 0..(DORMANT_LIMIT + 5) {
            let view = format!("{OWNER}/v{index}");
            let label = format!("extension-panel-{index}");
            channel.hello(&label, "s", Origin { view_id: view, ..origin() }).unwrap();
            channel.detach(&label, true);
        }
        assert_eq!(channel.dormant(), DORMANT_LIMIT);
    }
}
