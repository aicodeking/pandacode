//! Links (docs/machine-orchestration.md): which of the user's computers agents here may
//! use, the switch that allows it, and agents' requests for the user to link one.
use super::super::{catalog, config::{Access, Link}, remote, valid_device_id, Device, Inner};
use super::threads;
use crate::Result;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::Emitter;
use tokio::sync::Notify;

/// How long a link request waits for the user, whatever its tool calls do.
pub(super) const LINK_TTL: Duration = Duration::from_secs(10 * 60);
/// How long one `pandacode_machine_link` call waits; the harness gives up on a tool at 60 s.
pub(super) const LINK_CALL: Duration = Duration::from_secs(40);
const STILL_PENDING: &str = "Ask the user to answer the Link a machine card; call machine_link again or end your turn";
const OFF: &str = "Agent orchestration is off. The user can turn it on in Settings → Remote access.";
/// A computer that left the account, linked before links kept names.
const REMOVED: &str = "Removed computer";

/// `settings.orchestration`, readable without the remote lock.
static ON: AtomicBool = AtomicBool::new(false);

pub(crate) fn remember_enabled(on: bool) {
    ON.store(on, Ordering::SeqCst);
}

pub(super) fn on() -> bool {
    ON.load(Ordering::SeqCst)
}

/// Agents may use other computers: orchestration is on and the user is signed in.
pub(super) fn ready(inner: &Inner) -> Result<()> {
    if !inner.settings.orchestration {
        return Err(OFF.into());
    }
    if inner.token.is_none() {
        return Err("Sign in to PandaCode Connect first.".into());
    }
    Ok(())
}

/// A link counts only while its device has the key it was linked under and is a target
/// (hosting). Presence reports every offline device as not hosting, so an offline device keeps
/// its link until it comes back with remote control off.
pub(super) fn access(inner: &Inner, device: &Device) -> Option<Access> {
    let target = super::super::is_target(inner, device) || (device.id != inner.settings.device_id && !device.online);
    inner.settings.links.get(&device.id).filter(|link| target && link.counts_for(&device.public_key)).map(|link| link.access)
}

/// How long a host stays offline before its threads report `hostOffline`.
pub(super) const HOST_OFFLINE_AFTER: Duration = Duration::from_secs(5 * 60);

/// What presence last said, readable without the remote lock (the wake claim holds the store
/// lock, and the commit point takes them the other way round): device → offline since (ms).
/// None until the first presence frame.
type Presence = Option<HashMap<String, Option<i64>>>;

fn presence() -> std::sync::MutexGuard<'static, Presence> {
    static PRESENCE: Mutex<Presence> = Mutex::new(None);
    PRESENCE.lock().unwrap_or_else(|e| e.into_inner())
}

pub(crate) fn remember_presence(devices: &[Device]) {
    *presence() = Some(devices.iter().map(|d| (d.id.clone(), if d.online { None } else { d.last_seen.as_i64() })).collect());
}

/// Whether `device` has been offline past the limit at `now` (ms). A device presence no longer
/// lists left the account, so it counts; before any presence nothing is known, so none does.
pub(super) fn offline_past(known: &Presence, device: &str, now: i64) -> bool {
    let Some(known) = known else { return false };
    match known.get(device) {
        None => true,
        Some(since) => since.is_some_and(|since| now.saturating_sub(since) > HOST_OFFLINE_AFTER.as_millis() as i64),
    }
}

/// When the next offline device passes the limit, if one has yet to.
pub(super) fn next_past(known: &Presence, now: i64) -> Option<Duration> {
    let limit = HOST_OFFLINE_AFTER.as_millis() as i64;
    let left = known.as_ref()?.values().flatten().map(|since| since.saturating_add(limit).saturating_sub(now)).filter(|left| *left >= 0).min()?;
    Some(Duration::from_millis(left as u64))
}

pub(super) fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// [`offline_past`] now.
pub(super) fn host_offline(device: &str) -> bool {
    offline_past(&presence(), device, now_ms())
}

/// [`next_past`] now.
pub(super) fn next_host_due() -> Option<Duration> {
    next_past(&presence(), now_ms())
}

/// Whether a tick should tell the UI: a host with threads on it passed the limit, or one it had
/// counted as past the limit came back. `seen` holds those past it at the last tick; a host
/// whose threads all ended meanwhile just leaves it (their end said so already).
pub(super) fn hosts_crossed(seen: &mut HashSet<String>, with_threads: &[String], offline: impl Fn(&str) -> bool) -> bool {
    let now: HashSet<String> = with_threads.iter().filter(|device| offline(device)).cloned().collect();
    let crossed = now.difference(seen).next().is_some() || seen.iter().any(|device| !now.contains(device) && with_threads.contains(device));
    *seen = now;
    crossed
}

/// A tick has nothing to look at, so a presence burst touches no database: nothing is linked and
/// no machine thread exists. Threads outlive their link, so links alone can't say.
pub(super) fn tick_idle(no_links: bool, no_threads: bool) -> bool {
    no_links && no_threads
}

/// The one sleeper waiting for the next host to pass the limit.
#[derive(Default)]
pub(super) struct Sleeper {
    running: bool,
    wake: Arc<Notify>,
}

impl Sleeper {
    /// Presence changed: re-aims a running sleeper at the earliest deadline. True when none is
    /// running and something is `due`, so the caller starts [`Sleeper::run`].
    pub(super) fn aim(this: &Mutex<Self>, due: Option<Duration>) -> bool {
        let mut sleeper = this.lock().unwrap_or_else(|e| e.into_inner());
        if sleeper.running {
            sleeper.wake.notify_one();
            return false;
        }
        sleeper.running = due.is_some();
        sleeper.running
    }

    /// Sleeps until `due` says, ticking each time one passes, and ends when nothing is due. The
    /// last look and the flag clearing share the lock [`Sleeper::aim`] takes, so an aim either
    /// reaches this loop or sees it gone and starts another.
    pub(super) async fn run(this: &Mutex<Self>, due: impl Fn() -> Option<Duration>, tick: impl Fn()) {
        let wake = this.lock().unwrap_or_else(|e| e.into_inner()).wake.clone();
        loop {
            let left = {
                let mut sleeper = this.lock().unwrap_or_else(|e| e.into_inner());
                let left = due();
                sleeper.running = left.is_some();
                left
            };
            let Some(left) = left else { return };
            tokio::select! {
                _ = tokio::time::sleep(left) => tick(),
                _ = wake.notified() => {}
            }
        }
    }
}

/// What `machine_wait` and `machine_read` may read. A device gone from presence can't be checked
/// any more: its thread's local copy stays readable until the user unlinks it. Before the first
/// presence frame nothing is known, so nothing counts.
pub(super) fn read_access(inner: &Inner, device: &str) -> Option<Access> {
    match inner.devices.iter().find(|d| d.id == device) {
        Some(known) => access(inner, known),
        None => inner.presence.then(|| inner.settings.links.get(device).map(|link| link.access)).flatten(),
    }
}

/// Another computer on the account, by id or by name (case-insensitive).
pub(super) fn resolve<'a>(inner: &'a Inner, machine: &str) -> Result<&'a Device> {
    let machine = machine.trim();
    if machine.is_empty() || machine.len() > 200 {
        return Err("Name a computer from pandacode_machine_list.".into());
    }
    let mut others = inner.devices.iter().filter(|d| d.id != inner.settings.device_id);
    if let Some(device) = others.clone().find(|d| d.id == machine) {
        return Ok(device);
    }
    let first = others.find(|d| d.name.eq_ignore_ascii_case(machine)).ok_or("No other computer on this account has that id or name. Use pandacode_machine_list.")?;
    if inner.devices.iter().filter(|d| d.id != inner.settings.device_id && d.name.eq_ignore_ascii_case(machine)).count() > 1 {
        return Err("Several computers have that name. Use its id from pandacode_machine_list.".into());
    }
    Ok(first)
}

/// Refuses less than `least` access on `device`.
pub(super) fn need(access: Option<Access>, least: Access, name: &str) -> Result<Access> {
    match access {
        None => Err(format!("{name} is not linked to this computer. Ask the user with pandacode_machine_link.")),
        Some(access) if access < least => Err(format!("{name} is linked read only. The user can change its access in Settings → Remote access.")),
        Some(access) => Ok(access),
    }
}

/// What `machine_launch` needs of `device`: a link of ask or more, and the computer online, since
/// a start on an offline one would commit a mirror row that stays `starting`.
pub(super) fn launchable(inner: &Inner, device: &str, access: Option<Access>, name: &str) -> Result<Access> {
    let access = need(access, Access::Ask, name)?;
    if inner.devices.iter().any(|d| d.id == device && !d.online) {
        return Err(format!("{name} is offline."));
    }
    Ok(access)
}

/// Links that count, then stored links whose device left the account: those still serve
/// [`read_access`], so the user must be able to see and cut them. Same rule as there: before the
/// first presence frame nothing is known, so none has left.
pub(super) fn status_of(inner: &Inner) -> Value {
    let current = inner.devices.iter().filter_map(|d| access(inner, d).map(|access| json!({"deviceId": d.id, "name": d.name, "platform": d.platform, "online": d.online, "access": access})));
    let departed = inner.settings.links.iter().filter(|(id, _)| inner.presence && !inner.devices.iter().any(|d| &d.id == *id)).map(|(id, link)| {
        let name = if link.name.is_empty() { REMOVED } else { &link.name };
        json!({"deviceId": id, "name": name, "platform": "", "online": false, "access": link.access, "departed": true})
    });
    json!({"enabled": inner.settings.orchestration, "links": current.chain(departed).collect::<Vec<Value>>()})
}

fn status(app: &tauri::AppHandle) -> Value {
    status_of(&remote(app).lock())
}

pub(crate) fn emit_status(app: &tauri::AppHandle) {
    let _ = app.emit("orchestration://status", status(app));
}

/// How long presence changes are gathered into one `orchestration://status`.
const PRESENCE_COALESCE: Duration = Duration::from_millis(250);

/// Presence changed (online, offline, trust): linked computers' rows may have changed.
/// Emits status once per burst, and only while orchestration is on with links; threads whose
/// link is gone still follow their host.
pub(crate) fn presence_changed(app: &tauri::AppHandle) {
    static SCHEDULED: AtomicBool = AtomicBool::new(false);
    if !on() || SCHEDULED.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(PRESENCE_COALESCE).await;
        SCHEDULED.store(false, Ordering::SeqCst);
        // Turned off during the wait: nothing goes out.
        if on() {
            if !remote(&app).lock().settings.links.is_empty() {
                emit_status(&app);
            }
            warm_linked(&app);
            super::watch_offline(&app);
        }
    });
}

/// The online devices whose link counts, for warming.
pub(super) fn warm_targets(inner: &Inner) -> Vec<String> {
    inner.devices.iter().filter(|d| d.online && access(inner, d).is_some()).map(|d| d.id.clone()).collect()
}

/// Refuses a catalog fetch for a warm: orchestration went off, the user signed out or the link
/// no longer counts. Asked right before the call goes out.
pub(crate) fn may_warm(inner: &Inner, device: &str) -> Result<()> {
    ready(inner)?;
    if !warm_targets(inner).iter().any(|target| target == device) {
        return Err("That computer is no longer linked.".into());
    }
    Ok(())
}

/// Fills linked computers' catalogs in the background, so a launch never waits on the relay.
fn warm_linked(app: &tauri::AppHandle) {
    let targets = warm_targets(&remote(app).lock());
    for device in targets {
        catalog::warm(app, &device);
    }
}

/// Links (`Some`) or unlinks a computer. Only a current target can be linked; anything stored can
/// be unlinked, including a computer that left the account.
pub(super) fn apply_link(inner: &mut Inner, device_id: &str, access: Option<Access>) -> Result<()> {
    let Some(access) = access else {
        inner.settings.links.remove(device_id);
        return Ok(());
    };
    // A linked computer that is offline keeps its link, so its access can still change; it
    // can't be linked anew, and a changed key is never accepted here.
    let asleep = inner.devices.iter().find(|d| d.id == device_id && !d.online).map(|d| d.public_key.clone());
    if let (Some(key), Some(link)) = (asleep, inner.settings.links.get_mut(device_id)) {
        if link.key == key {
            link.access = access;
            return Ok(());
        }
    }
    let target = inner.devices.iter().find(|d| d.id == device_id && super::super::is_target(inner, d)).filter(|d| !d.public_key.is_empty()).map(|d| (d.public_key.clone(), d.name.clone()));
    let Some((key, name)) = target else {
        return Err("Turn on remote control on that computer before linking it.".into());
    };
    inner.settings.links.insert(device_id.to_owned(), Link { access, at: chrono::Utc::now().timestamp_millis(), key, name });
    Ok(())
}

fn set_link(app: &tauri::AppHandle, device_id: &str, access: Option<Access>) -> Result<()> {
    valid_device_id(device_id)?;
    let state = remote(app);
    apply_link(&mut state.lock(), device_id, access)?;
    state.save();
    emit_status(app);
    if on() {
        warm_linked(app);
    }
    Ok(())
}

/// The user's answer: a computer and its access, or None to decline.
pub(super) type Answer = Option<(String, Access)>;

/// A request waiting for the user. It outlives the tool calls that wait on it.
struct Pending {
    session_id: String,
    machine: Option<String>,
    reason: String,
    /// Tool calls waiting on it now.
    waiting: usize,
    answered: Arc<Notify>,
    /// The answer, for every call waiting on it.
    outcome: Arc<OnceLock<Value>>,
}

impl Pending {
    fn view(&self, id: &str) -> Value {
        json!({"requestId": id, "sessionId": self.session_id, "machine": self.machine, "reason": self.reason})
    }
}

#[derive(Default)]
struct Requests {
    pending: HashMap<String, Pending>,
    /// Requests taken by an answer that is being saved.
    answering: HashMap<String, Pending>,
    /// Answers not yet picked up, by task: (request id, what it means to the agent).
    answers: HashMap<String, (String, Value)>,
    /// Bumped by every cancellation.
    generation: u64,
}

fn requests() -> std::sync::MutexGuard<'static, Requests> {
    static REQUESTS: OnceLock<Mutex<Requests>> = OnceLock::new();
    REQUESTS.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner())
}

/// Cancels `session`'s request and any answer it hasn't read; returns the requests removed.
/// Allocates nothing when there is none.
pub(super) fn cancel_for(session: &str) -> Vec<String> {
    let mut requests = requests();
    requests.answers.remove(session);
    let mine = |p: &Pending| p.session_id == session;
    if !requests.pending.values().any(mine) && !requests.answering.values().any(mine) {
        return Vec::new();
    }
    requests.generation += 1;
    let ids: Vec<String> = requests.pending.iter().filter(|(_, p)| mine(p)).map(|(id, _)| id.clone()).collect();
    for id in &ids {
        if let Some(entry) = requests.pending.remove(id) {
            entry.answered.notify_waiters();
        }
    }
    requests.answering.retain(|_, p| !mine(p));
    ids
}

/// Signing out cancels every link request.
pub(crate) fn signed_out(app: &tauri::AppHandle) {
    *presence() = None;
    super::watch_offline(app);
    settled(app, &cancel_all());
}

fn cancel_all() -> Vec<String> {
    let mut requests = requests();
    requests.generation += 1;
    requests.answers.clear();
    requests.answering.clear();
    let ids: Vec<String> = requests.pending.keys().cloned().collect();
    for (_, entry) in requests.pending.drain() {
        entry.answered.notify_waiters();
    }
    ids
}

pub(super) fn settled(app: &tauri::AppHandle, ids: &[String]) {
    for id in ids {
        let _ = app.emit("machine-link-settled", json!({"requestId": id}));
    }
}

fn linked(device: &Device, access: Access) -> Value {
    json!({"linked": true, "machine": {"id": device.id, "name": device.name}, "access": access})
}

/// What an answer means to the agent.
fn outcome(app: &tauri::AppHandle, answer: &Answer) -> Value {
    match answer {
        Some((device_id, access)) => {
            let state = remote(app);
            let inner = state.lock();
            match inner.devices.iter().find(|d| &d.id == device_id) {
                Some(device) => linked(device, *access),
                None => json!({"linked": false, "reason": "That computer left the account."}),
            }
        }
        None => json!({"linked": false, "reason": "The user declined."}),
    }
}

/// The wake message for an answer no tool call was waiting for.
pub(super) fn answer_message(result: &Value) -> String {
    if let Some(message) = result["message"].as_str() {
        return message.to_owned();
    }
    let what = if result["linked"] == true {
        format!("The user linked {} with {} access. Use pandacode_machine_list and pandacode_machine_launch.", result["machine"]["name"].as_str().unwrap_or("a computer"), result["access"].as_str().unwrap_or("ask"))
    } else {
        format!("Nothing was linked: {}", result["reason"].as_str().unwrap_or("The user declined."))
    };
    format!("The user answered your request to link a machine. {what}")
}

/// Tasks with an answer nobody read yet.
pub(super) fn answered_sessions() -> Vec<String> {
    requests().answers.keys().cloned().collect()
}

pub(super) fn has_answer(session: &str) -> bool {
    requests().answers.contains_key(session)
}

/// Takes `session`'s unread answer: (request id, result).
pub(super) fn take_answer(session: &str) -> Option<(String, Value)> {
    requests().answers.remove(session)
}

/// `session`'s unread answer, left in place: (request id, result).
pub(super) fn peek_answer(session: &str) -> Option<(String, Value)> {
    requests().answers.get(session).cloned()
}

/// Takes `session`'s answer to `id` once its wake turn is saved; a newer answer stays.
pub(super) fn take_answer_if(session: &str, id: &str) {
    let mut requests = requests();
    if requests.answers.get(session).is_some_and(|(answer, _)| answer == id) {
        requests.answers.remove(session);
    }
}

/// Puts back the answer a wake turn carried (its saved `message`) when the turn never
/// reached the agent. A newer answer wins. True when it was put back.
pub(super) fn restore_answer(session: &str, message: String) -> bool {
    let mut requests = requests();
    if requests.answers.contains_key(session) {
        return false;
    }
    requests.answers.insert(session.to_owned(), ("restored".into(), json!({"answered": true, "message": message})));
    true
}

/// Waits on a request; on leaving, takes the answer if it came, else stops counting.
struct Attached {
    session: String,
    id: String,
    outcome: Arc<OnceLock<Value>>,
    /// Set by `leave`; a call dropped without leaving (its client closed) is abandoned.
    left: bool,
    /// Wakes the task when a dropped call leaves an answer nobody will read.
    app: Option<tauri::AppHandle>,
}

impl Drop for Attached {
    fn drop(&mut self) {
        if !self.left && self.abandon() {
            if let Some(app) = &self.app {
                super::wake_link(app, self.session.clone());
            }
        }
    }
}

impl Attached {
    /// In one step: the answer (every call joined to the request gets it, and the task is
    /// then not woken for it), else `Err(true)` while the request still waits for the user
    /// or `Err(false)` when it was cancelled or expired.
    fn leave(mut self) -> std::result::Result<Value, bool> {
        self.left = true;
        let mut requests = requests();
        let Requests { pending, answering, answers, .. } = &mut *requests;
        let waiting = pending.get_mut(&self.id).or_else(|| answering.get_mut(&self.id));
        if let Some(entry) = waiting {
            entry.waiting = entry.waiting.saturating_sub(1);
        }
        let Some(result) = self.outcome.get().cloned() else { return Err(pending.contains_key(&self.id) || answering.contains_key(&self.id)) };
        if answers.get(&self.session).is_some_and(|(id, _)| id == &self.id) {
            answers.remove(&self.session);
        }
        Ok(result)
    }

    /// A call that went away without leaving stops counting as a waiter. True when the
    /// answer already came and is still unread, so the task must be woken for it.
    fn abandon(&self) -> bool {
        let mut requests = requests();
        let Requests { pending, answering, answers, .. } = &mut *requests;
        if let Some(entry) = pending.get_mut(&self.id).or_else(|| answering.get_mut(&self.id)) {
            entry.waiting = entry.waiting.saturating_sub(1);
            return false;
        }
        self.outcome.get().is_some() && answers.get(&self.session).is_some_and(|(id, _)| id == &self.id)
    }
}

/// Joins `session`'s request, including one whose answer is being saved, or makes one (the
/// view says it is new).
fn attach(session: &str, machine: Option<String>, reason: String) -> (Attached, Arc<Notify>, Option<Value>) {
    let mut requests = requests();
    let Requests { pending, answering, .. } = &mut *requests;
    if let Some((id, entry)) = pending.iter_mut().chain(answering.iter_mut()).find(|(_, p)| p.session_id == session) {
        entry.waiting += 1;
        return (Attached { session: session.into(), id: id.clone(), outcome: entry.outcome.clone(), left: false, app: None }, entry.answered.clone(), None);
    }
    let id = uuid::Uuid::new_v4().to_string();
    let entry = Pending { session_id: session.to_owned(), machine, reason, waiting: 1, answered: Arc::new(Notify::new()), outcome: Default::default() };
    let (view, answered, outcome) = (entry.view(&id), entry.answered.clone(), entry.outcome.clone());
    requests.pending.insert(id.clone(), entry);
    (Attached { session: session.into(), id, outcome, left: false, app: None }, answered, Some(view))
}

/// `pandacode_machine_link`: returns at once when `machine` is linked or an earlier request
/// was answered; else asks the user (once per task: a later call joins the same request)
/// and waits at most `LINK_CALL`. The request itself waits `LINK_TTL`; the task stopping
/// cancels it.
pub(super) async fn request(app: &tauri::AppHandle, session: &str, machine: Option<&str>, reason: &str, stopped: &AtomicBool) -> Result<Value> {
    let reason: String = reason.trim().chars().filter(|c| !c.is_control() || *c == '\n').take(500).collect();
    if reason.is_empty() {
        return Err("Give the user a reason to link a computer.".into());
    }
    let machine = {
        let state = remote(app);
        let inner = state.lock();
        ready(&inner)?;
        match machine {
            Some(machine) => {
                let device = resolve(&inner, machine)?;
                if let Some(access) = access(&inner, device) {
                    return Ok(linked(device, access));
                }
                Some(device.id.clone())
            }
            None => None,
        }
    };
    if let Some((_, result)) = take_answer(session) {
        return Ok(result);
    }
    let (mut attached, answered, created) = attach(session, machine, reason);
    attached.app = Some(app.clone());
    let stop = threads::stop_signal(session);
    let (stopping, answering) = (stop.notified(), answered.notified());
    tokio::pin!(stopping, answering);
    stopping.as_mut().enable();
    answering.as_mut().enable();
    if let Some(view) = created {
        let _ = app.emit("machine-link-request", view);
        let (app, id) = (app.clone(), attached.id.clone());
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(LINK_TTL).await;
            if requests().pending.remove(&id).is_some() {
                settled(&app, &[id]);
            }
        });
    }
    if !stopped.load(Ordering::SeqCst) {
        tokio::select! {
            _ = &mut answering => {}
            _ = &mut stopping => {}
            _ = tokio::time::sleep(LINK_CALL) => {}
        }
    }
    let id = attached.id.clone();
    if stopped.load(Ordering::SeqCst) {
        let _ = attached.leave();
        return Err("Task has stopped.".into());
    }
    match attached.leave() {
        Ok(result) => Ok(result),
        Err(true) => Ok(json!({"linked": false, "pending": true, "requestId": id, "hint": STILL_PENDING})),
        Err(false) => Ok(json!({"linked": false, "reason": "The request was cancelled or expired."})),
    }
}

#[tauri::command]
pub async fn orchestration_status(app: tauri::AppHandle) -> Value {
    status(&app)
}

/// Turning orchestration on delivers wakes that came due while it was off; turning it off
/// cancels every link request.
pub(super) fn toggled(enabled: bool, reconcile: impl FnOnce(), cancel: impl FnOnce()) {
    if enabled { reconcile() } else { cancel() }
}

#[tauri::command]
pub async fn orchestration_set_enabled(app: tauri::AppHandle, enabled: bool) -> Result<Value> {
    let state = remote(&app);
    state.lock().settings.orchestration = enabled;
    remember_enabled(enabled);
    state.save();
    toggled(enabled, || super::reconcile(&app), || settled(&app, &cancel_all()));
    emit_status(&app);
    if enabled {
        warm_linked(&app);
    }
    // Turned off, this ends the sleeper.
    super::watch_offline(&app);
    Ok(status(&app))
}

#[tauri::command]
pub async fn orchestration_set_link(app: tauri::AppHandle, device_id: String, access: Option<String>) -> Result<Value> {
    let access = access.map(|a| Access::parse(&a).ok_or("Unknown access.")).transpose()?;
    set_link(&app, &device_id, access)?;
    Ok(status(&app))
}

#[tauri::command]
pub async fn orchestration_pending() -> Vec<Value> {
    if !on() {
        return Vec::new();
    }
    requests().pending.iter().map(|(id, p)| p.view(id)).collect()
}

/// Takes a request out of the pending list, so exactly one answer wins; returns its task
/// and the cancellation generation.
fn take(request_id: &str) -> Result<(String, u64)> {
    let mut requests = requests();
    let generation = requests.generation;
    let entry = requests.pending.remove(request_id).ok_or("This link request was already answered.")?;
    let session = entry.session_id.clone();
    requests.answering.insert(request_id.to_owned(), entry);
    Ok((session, generation))
}

/// Puts a request back after a failed answer, unless orchestration went off or the
/// request was cancelled meanwhile.
fn restore(request_id: &str, generation: u64) -> bool {
    let mut requests = requests();
    let Some(entry) = requests.answering.remove(request_id) else { return false };
    if !on() || requests.generation != generation {
        entry.answered.notify_waiters();
        return false;
    }
    requests.pending.insert(request_id.to_owned(), entry);
    true
}

/// Records the answer. True when no tool call is waiting, so the task should be woken.
fn deliver(request_id: &str, result: Value) -> bool {
    let mut requests = requests();
    let Some(entry) = requests.answering.remove(request_id) else { return false };
    let _ = entry.outcome.set(result.clone());
    requests.answers.insert(entry.session_id.clone(), (request_id.to_owned(), result));
    entry.answered.notify_waiters();
    entry.waiting == 0
}

#[tauri::command]
pub async fn orchestration_link_respond(app: tauri::AppHandle, request_id: String, device_id: Option<String>, access: Option<String>) -> Result<Value> {
    super::super::host::valid_id(&request_id)?;
    let answer = match (device_id, access) {
        (None, None) => None,
        (Some(device_id), Some(access)) => {
            valid_device_id(&device_id)?;
            Some((device_id, Access::parse(&access).ok_or("Unknown access.")?))
        }
        _ => return Err("Pick a computer and its access, or decline.".into()),
    };
    let (session, generation) = take(&request_id)?;
    if let Some((device_id, access)) = &answer {
        if let Err(error) = set_link(&app, device_id, Some(*access)) {
            // Not linked: the request waits for another answer, unless it was cancelled.
            if !restore(&request_id, generation) {
                settled(&app, &[request_id]);
            }
            return Err(error);
        }
    }
    if deliver(&request_id, outcome(&app, &answer)) {
        super::wake_link(&app, session);
    }
    settled(&app, &[request_id]);
    Ok(status(&app))
}

#[cfg(test)]
pub(super) fn insert_for_test(session: &str) -> String {
    attach(session, None, "r".into()).0.id.clone()
}

#[cfg(test)]
pub(super) fn pending_for_test(id: &str) -> bool {
    requests().pending.contains_key(id)
}

/// Answers like `orchestration_link_respond`, without linking: true when nobody waited.
#[cfg(test)]
pub(super) fn answer_for_test(id: &str, result: Value) -> Result<bool> {
    take(id)?;
    Ok(deliver(id, result))
}

/// Joins `session`'s request like a second tool call: (request id, the call).
#[cfg(test)]
pub(super) fn join_for_test(session: &str) -> (String, impl FnOnce() -> std::result::Result<Value, bool>) {
    let (attached, _, _) = attach(session, None, "r".into());
    (attached.id.clone(), move || attached.leave())
}

/// A call on `id` that leaves: what it gets.
#[cfg(test)]
pub(super) fn detach_for_test(session: &str, id: &str) -> Option<Value> {
    let outcome = {
        let requests = requests();
        requests.pending.get(id).or_else(|| requests.answering.get(id)).map(|p| p.outcome.clone()).unwrap_or_default()
    };
    Attached { session: session.into(), id: id.into(), outcome, left: false, app: None }.leave().ok()
}

/// A call on `id` dropped without leaving (its client closed): whether it asks for a wake.
#[cfg(test)]
pub(super) fn abandon_for_test(session: &str, id: &str) -> bool {
    let outcome = {
        let requests = requests();
        requests.pending.get(id).or_else(|| requests.answering.get(id)).map(|p| p.outcome.clone())
    };
    let outcome = outcome.unwrap_or_else(|| requests().answers.get(session).map(|(_, v)| Arc::new(OnceLock::from(v.clone()))).unwrap_or_default());
    let mut attached = Attached { session: session.into(), id: id.into(), outcome, left: false, app: None };
    attached.left = true;
    attached.abandon()
}

#[cfg(test)]
pub(super) fn take_for_test(id: &str) {
    take(id).unwrap();
}

#[cfg(test)]
pub(super) fn deliver_for_test(id: &str, result: Value) -> bool {
    deliver(id, result)
}

#[cfg(test)]
pub(super) fn restore_for_test(id: &str, cancel: bool) -> bool {
    let (session, generation) = take(id).unwrap();
    if cancel {
        cancel_for(&session);
    }
    restore(id, generation)
}
