//! Mirrors: a local task whose agent runs on another computer (docs/remote-access.md).
//! The row, its messages and the UI are ordinary; commands that act on the agent go to
//! the host, its events are re-emitted here under the local id, and its messages are
//! copied here after each run.
use super::{client, host, remote, start::git};
use crate::{providers::AgentEvent, storage::Store, AppState, Result};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};
use tokio::sync::Notify;

/// Cloning and checking out can take a while on the host: its worst case plus margin.
const START_TIMEOUT: Duration = Duration::from_secs(super::start::WORST_CASE.as_secs() + 3 * 60);
/// A burst of presence frames (and renewals) makes one subscribe round.
const SUBSCRIBE_DEBOUNCE: Duration = Duration::from_millis(250);
/// Mirrors per host whose afterId page goes out together with a reconnect's subscribe; with
/// it they fill the host's four read lanes.
const PIPELINED: usize = 3;
/// A host that failed to subscribe while it runs an active mirror is retried after this,
/// doubling up to [`RETRY_MAX`].
const RETRY_FIRST: Duration = Duration::from_secs(2);
const RETRY_MAX: Duration = Duration::from_secs(60);
/// How often a start whose reply was lost asks the host how it went.
const START_POLL: Duration = Duration::from_secs(3);
/// Pages per sync; a longer history continues at the next run end or subscription.
const MAX_PAGES: usize = 50;
/// Messages in a mirror's first, newest page, and its JSON budget: packed, about 12 KB on the
/// wire, one round trip on 3G (docs/connect-benchmark.md). Older hosts ignore `budget`.
pub(super) const TAIL_PAGE: i64 = 30;
pub(super) const TAIL_BUDGET: usize = 32 * 1024;
/// Messages per afterId or older page copied behind it. Hosts pack these for this computer
/// (`"z": 1`), so they may be bigger: the host cuts each until it packs into one frame.
pub(super) const OLDER_PAGE: i64 = 200;
pub(super) const PACKED_BUDGET: usize = host::PACKED_PAGE_MAX;
/// Older pages per backfill round; a round that stops here with more to copy is followed by
/// another. Between pages a round waits (up to [`BACKFILL_YIELD`]) while other calls to the
/// host are pending.
const BACKFILL_PAGES: usize = 8;
const BACKFILL_YIELD: Duration = Duration::from_secs(10);
/// Replay pages per host and subscribe round; a replay longer still becomes a gap.
const MAX_REPLAY_PAGES: usize = 20;
/// Live entries held per host while its subscribe is in flight; past this they are dropped
/// and the host is asked again from where this viewer is.
const MAX_HELD: usize = 4096;
/// Cursors are saved at most this often while events stream, and after every subscribe round.
const SAVE_EVERY: Duration = Duration::from_secs(5);
const NO_REPO: &str = "This project has no GitHub origin, so it can't run on another computer. Add a GitHub remote named origin first.";

#[derive(Debug)]
pub(crate) struct Mirror {
    pub device: String,
    pub session: String,
}

fn lock(state: &AppState) -> Result<std::sync::MutexGuard<'_, Store>> {
    state.store.lock().map_err(|e| e.to_string())
}

/// The host and host task behind a local task, or None for an ordinary task.
pub(crate) fn of(store: &Store, local: &str) -> Result<Option<Mirror>> {
    let row: Option<(Option<String>, Option<String>)> = store.db.query_row("SELECT remote_device,remote_session FROM sessions WHERE id=?1", [local], |r| Ok((r.get(0)?, r.get(1)?))).optional().map_err(|e| e.to_string())?;
    let Some((Some(device), session)) = row else { return Ok(None) };
    let session = session.ok_or_else(|| format!("This task is still starting on {}.", super::device_label(&device)))?;
    Ok(Some(Mirror { device, session }))
}

fn local_id(store: &Store, device: &str, session: &str) -> Option<String> {
    store.db.query_row("SELECT id FROM sessions WHERE remote_device=?1 AND remote_session=?2", [device, session], |r| r.get(0)).optional().ok().flatten()
}

/// Sends a mirror's command to its host, with the host's task id. None for a local task,
/// which the caller then handles as always.
pub(crate) async fn route(app: &tauri::AppHandle, state: &AppState, local: &str, method: &str, params: Value) -> Result<Option<Value>> {
    let Some(routed) = prepare(&*lock(state)?, local, method, params)? else { return Ok(None) };
    let result = client::call(app, &routed.device, method, routed.params).await;
    if let (Err(_), Some(status)) = (&result, routed.before) {
        lock(state)?.status(local, &status)?;
    }
    result.map(Some)
}

/// A prompt for a mirror: its images (this computer's captures) go to the host first, then
/// the message names the ids the host stored them under.
pub(crate) async fn send(app: &tauri::AppHandle, state: &AppState, local: &str, text: String, image_ids: &[String]) -> Result<()> {
    let device = of(&*lock(state)?, local)?.ok_or("That task does not run on another computer.")?.device;
    let image_ids = super::images::send(app, &device, image_ids).await?;
    route(app, state, local, "task.send", json!({"text": text, "imageIds": image_ids})).await?;
    Ok(())
}

/// A command bound for a host: where it goes, its params, and the status to restore if
/// the host refuses a prompt.
#[derive(Debug, PartialEq)]
pub(crate) struct Routed {
    device: String,
    params: Value,
    before: Option<String>,
}

/// Swaps in the host's task id. A prompt marks the mirror running before the host answers,
/// so a run that ends first is never left spinning.
pub(crate) fn prepare(store: &Store, local: &str, method: &str, mut params: Value) -> Result<Option<Routed>> {
    let Some(mirror) = of(store, local)? else { return Ok(None) };
    params["sessionId"] = json!(mirror.session);
    let before = (method == "task.send").then(|| start_turn(store, local)).transpose()?;
    Ok(Some(Routed { device: mirror.device, params, before }))
}

/// Marks a mirror running for a new prompt; returns the status it had.
fn start_turn(store: &Store, local: &str) -> Result<String> {
    let status: String = store.db.query_row("SELECT status FROM sessions WHERE id=?1", [local], |r| r.get(0)).map_err(|e| e.to_string())?;
    store.db.execute("UPDATE sessions SET status='running',task_stage='in_progress',completed_at=NULL,last_prompt_at=?2,updated_at=?2 WHERE id=?1", params![local, crate::storage::now()]).map_err(|e| e.to_string())?;
    Ok(status)
}

/// A host's events as this computer's: each gets its mirror's local id, and events for
/// tasks not mirrored here (or that are not events) are dropped. Run ends come separately.
pub(crate) fn relabel(events: &[Value], mut local: impl FnMut(&str) -> Option<String>) -> Vec<Value> {
    events
        .iter()
        .filter(|event| event["kind"].as_str().is_some_and(|kind| kind != "done" && kind != RUN_END) && event["text"].is_string())
        .filter_map(|event| {
            let id = local(event["sessionId"].as_str()?)?;
            let mut event = event.clone();
            event["sessionId"] = json!(id);
            Some(event)
        })
        .collect()
}

/// The status an event moves a mirror to, if any. Only signs of work start a run: usage,
/// settings or change summaries the host sends after its `run.finished` must not leave an
/// idle mirror running with nothing to end it.
fn status_after(current: &str, kind: &str) -> Option<&'static str> {
    let active = matches!(current, "running" | "waiting");
    let next = match kind {
        "approval" | "input_request" => "waiting",
        "approval_cancelled" | "input_cancelled" if active => "running",
        "turn_start" | "message_start" | "text" | "tool" | "status" if !active => "running",
        _ => return None,
    };
    (next != current).then_some(next)
}

/// What this computer, as a viewer, keeps in memory about its mirrors.
#[derive(Default)]
pub(crate) struct Viewer {
    /// Per host: the journal epoch its `seq`s belong to (new with every host launch).
    epochs: HashMap<String, String>,
    /// The newest event `seq` seen per (host, host task).
    seqs: HashMap<(String, String), u64>,
    /// Approval and question cards shown per local task: request id → kind.
    cards: HashMap<String, HashMap<String, String>>,
    /// Starts not yet answered, by local id.
    starts: HashMap<String, PendingStart>,
    /// Per host with a subscribe (and its replay pages) in flight: the live entries that
    /// arrived meanwhile, shown once the replay is, so none hides an older replayed one.
    held: HashMap<String, Held>,
    /// Cursors were read from the store (they survive a restart of this computer).
    loaded: bool,
    /// Hosts whose cursors changed since they were saved, and when they last were.
    dirty: HashSet<String>,
    saved_at: Option<Instant>,
    save_scheduled: bool,
}

#[derive(Default)]
struct Held {
    /// (epoch, entry) in arrival order.
    entries: Vec<(Option<String>, Value)>,
    /// Some were dropped: ask the host again once this round is over.
    overflow: bool,
}

pub(crate) struct PendingStart {
    device: String,
    start_id: String,
    /// The row was made for this start (else it is the user's draft).
    created: bool,
    /// Ends the `task.start` call still waiting for its reply.
    cancel: Arc<Notify>,
    /// A call for it (the start, or asking how it went) is in flight.
    busy: bool,
    /// The user stopped it but the host has not confirmed: asked again when it is back.
    cancelling: bool,
}

/// The journal entry (and live frame) of a run end.
const RUN_END: &str = "run.finished";

impl Viewer {
    /// Moves to a host's epoch: a new one (the host restarted) forgets its old `seq`s.
    fn epoch(&mut self, device: &str, epoch: Option<&str>) {
        let Some(epoch) = epoch else { return };
        if self.epochs.get(device).map(String::as_str) != Some(epoch) {
            self.epochs.insert(device.to_owned(), epoch.to_owned());
            self.seqs.retain(|(host, _), _| host != device);
            self.dirty.insert(device.to_owned());
        }
    }

    /// Whether an event is new, advancing past it. One without `seq` (older hosts) always is.
    fn fresh(&mut self, device: &str, event: &Value) -> bool {
        let (Some(seq), Some(session)) = (event["seq"].as_u64(), event["sessionId"].as_str()) else { return true };
        let last = self.seqs.entry((device.to_owned(), session.to_owned())).or_default();
        if seq <= *last {
            return false;
        }
        *last = seq;
        self.dirty.insert(device.to_owned());
        true
    }

    fn advance(&mut self, device: &str, session: &str, seq: u64) {
        let last = self.seqs.entry((device.to_owned(), session.to_owned())).or_default();
        if seq > *last {
            *last = seq;
            self.dirty.insert(device.to_owned());
        }
    }

    /// Moves to a subscribe reply's `seq` for a task. One this viewer had no position in was
    /// not replayed, so its live entries held meanwhile set its position instead.
    fn settle(&mut self, device: &str, session: &str, seq: u64) {
        let unknown = !self.seqs.contains_key(&(device.to_owned(), session.to_owned()));
        if unknown && self.held.get(device).is_some_and(|held| held.entries.iter().any(|(_, entry)| entry["sessionId"] == session)) {
            return;
        }
        self.advance(device, session, seq);
    }

    /// Holds a host's live entries from now until [`Viewer::release`].
    fn hold(&mut self, device: &str) {
        self.held.entry(device.to_owned()).or_default();
    }

    /// Keeps live entries while the host is held; false when it is not.
    fn keep(&mut self, device: &str, epoch: Option<&str>, list: &[Value]) -> bool {
        let Some(held) = self.held.get_mut(device) else { return false };
        if held.entries.len() + list.len() > MAX_HELD {
            held.overflow = true;
        } else {
            held.entries.extend(list.iter().map(|entry| (epoch.map(str::to_owned), entry.clone())));
        }
        true
    }

    fn release(&mut self, device: &str) -> Held {
        self.held.remove(device).unwrap_or_default()
    }

    /// Cursors read back from the store, unless this run already has its own for a host.
    fn restore(&mut self, rows: Vec<(String, String, String, u64)>) {
        self.loaded = true;
        for (device, session, epoch, seq) in rows {
            if self.epochs.get(&device).is_some_and(|known| *known != epoch) {
                continue;
            }
            self.epochs.entry(device.clone()).or_insert(epoch);
            let last = self.seqs.entry((device, session)).or_default();
            *last = (*last).max(seq);
        }
    }

    /// What to save: each changed host's epoch and positions.
    #[allow(clippy::type_complexity)]
    fn unsaved(&mut self) -> Vec<(String, String, Vec<(String, u64)>)> {
        let dirty = std::mem::take(&mut self.dirty);
        dirty.into_iter().filter_map(|device| {
            let epoch = self.epochs.get(&device)?.clone();
            let seqs = self.seqs.iter().filter(|((host, _), _)| *host == device).map(|((_, session), seq)| (session.clone(), *seq)).collect();
            Some((device, epoch, seqs))
        }).collect()
    }

    /// `subscribe` params: the tasks, and where this viewer left off in each it has seen.
    fn subscribe_params(&self, device: &str, sessions: &[String]) -> Value {
        let mut params = json!({"sessionIds": sessions});
        if let Some(epoch) = self.epochs.get(device) {
            let after: Map<String, Value> = sessions.iter().filter_map(|id| Some((id.clone(), json!(self.seqs.get(&(device.to_owned(), id.clone()))?)))).collect();
            params["epoch"] = json!(epoch);
            params["afterSeq"] = Value::Object(after);
        }
        params
    }

    /// Notes the card a relabelled event shows or clears.
    fn card(&mut self, event: &Value) {
        let (Some(local), Some(kind), Some(request)) = (event["sessionId"].as_str(), event["kind"].as_str(), event["requestId"].as_str()) else { return };
        match kind {
            "approval" | "input_request" => {
                self.cards.entry(local.to_owned()).or_default().insert(request.to_owned(), kind.to_owned());
            }
            "approval_cancelled" | "input_cancelled" => {
                self.cards.get_mut(local).map(|cards| cards.remove(request));
            }
            _ => {}
        }
    }

    /// The events that make a task's cards match the host's pending requests: a missing
    /// card is shown again (after a restart or a lost frame), an answered one is cleared.
    fn sync_cards(&mut self, local: &str, pending: &[Value]) -> Vec<Value> {
        let shown = self.cards.entry(local.to_owned()).or_default();
        let wanted: HashSet<&str> = pending.iter().filter_map(|item| item["requestId"].as_str()).collect();
        let mut events = Vec::new();
        shown.retain(|request, kind| {
            let keep = wanted.contains(request.as_str());
            if !keep {
                let cancelled = if kind == "approval" { "approval_cancelled" } else { "input_cancelled" };
                events.push(json!({"sessionId": local, "kind": cancelled, "text": "", "requestId": request, "data": null}));
            }
            keep
        });
        for item in pending {
            let (Some(kind @ ("approval" | "input_request")), Some(request)) = (item["kind"].as_str(), item["requestId"].as_str()) else { continue };
            if shown.insert(request.to_owned(), kind.to_owned()).is_some() {
                continue;
            }
            let mut event = json!({"sessionId": local, "kind": kind, "text": item["text"].as_str().unwrap_or_default(), "requestId": request, "data": item["data"]});
            if let Some(tool) = item.get("tool") {
                event["tool"] = tool.clone();
            }
            events.push(event);
        }
        events
    }
}

/// `agent.events` from the task's host. `lagged`: the host dropped events it could not
/// buffer, so this viewer holds what comes next and subscribes again from where it is.
pub(crate) fn events(app: &tauri::AppHandle, from: &str, data: &Value) {
    if let Some(list) = data["events"].as_array() {
        apply(app, from, data["epoch"].as_str(), list, true);
    }
    if data["lagged"] == true {
        super::diagnostics::record("viewer.lagged", super::device_label(from));
        remote(app).lock().viewer.hold(from);
        subscribe_soon(app);
    }
    save_cursors(app, false);
}

/// Shows a host's entries (live or replayed) under their local ids, each once and in
/// order: one at or before the newest `seq` already seen is dropped, and live entries wait
/// while a subscribe to their host is in flight. Run ends end the turn where they fall.
fn apply(app: &tauri::AppHandle, from: &str, epoch: Option<&str>, list: &[Value], live: bool) {
    let list: Vec<Value> = {
        let state = remote(app);
        let mut inner = state.lock();
        if live && inner.viewer.keep(from, epoch, list) {
            return;
        }
        inner.viewer.epoch(from, epoch);
        list.iter().filter(|event| inner.viewer.fresh(from, event)).cloned().collect()
    };
    let mut rest = list.as_slice();
    while !rest.is_empty() {
        let split = rest.iter().position(|entry| entry["kind"] == RUN_END).unwrap_or(rest.len());
        show(app, from, &rest[..split]);
        if let Some(end) = rest.get(split) {
            run_ended(app, from, end);
        }
        rest = &rest[(split + 1).min(rest.len())..];
    }
}

/// Emits a host's agent events under their local ids and moves the mirrors' statuses.
fn show(app: &tauri::AppHandle, from: &str, list: &[Value]) {
    if list.is_empty() {
        return;
    }
    let state = app.state::<AppState>();
    let (events, changed) = {
        let Ok(store) = state.store.lock() else { return };
        let mut ids: HashMap<String, Option<String>> = HashMap::new();
        let events = relabel(list, |remote| ids.entry(remote.to_owned()).or_insert_with(|| local_id(&store, from, remote)).clone());
        save_subagents(&store, &events);
        let mut changed = false;
        for event in &events {
            let (Some(id), Some(kind)) = (event["sessionId"].as_str(), event["kind"].as_str()) else { continue };
            let current: String = store.db.query_row("SELECT status FROM sessions WHERE id=?1", [id], |r| r.get(0)).unwrap_or_default();
            if let Some(next) = status_after(&current, kind) {
                changed |= store.status(id, next).is_ok();
            }
        }
        (events, changed)
    };
    {
        let state = remote(app);
        let mut inner = state.lock();
        events.iter().for_each(|event| inner.viewer.card(event));
    }
    for mut event in events {
        if let Some(event) = event.as_object_mut() {
            event.remove("seq");
        }
        let _ = app.emit("agent-event", event);
    }
    if changed {
        let _ = app.emit("sessions-changed", ());
    }
}

/// Saves the newest snapshot of each child agent among relabelled events, so a mirror's
/// Subagents panel (`list_subagents`) has them after a reload, as a local run's does.
fn save_subagents(store: &Store, events: &[Value]) {
    for (session, data) in newest_subagents(events) {
        let saved = serde_json::from_value::<crate::providers::SubagentActivity>(data.clone()).map_err(|e| e.to_string()).and_then(|activity| store.save_subagent(session, &activity));
        if let Err(error) = saved {
            eprintln!("PandaCode Connect: could not keep a remote subagent: {error}");
        }
    }
}

/// The last `subagent` snapshot per (task, child), in first-seen order.
fn newest_subagents(events: &[Value]) -> Vec<(&str, &Value)> {
    let mut newest: Vec<(&str, &str, &Value)> = Vec::new();
    for event in events.iter().filter(|event| event["kind"] == "subagent") {
        let (Some(session), Some(id)) = (event["sessionId"].as_str(), event["data"]["id"].as_str()) else { continue };
        match newest.iter_mut().find(|(s, i, _)| *s == session && *i == id) {
            Some(slot) => slot.2 = &event["data"],
            None => newest.push((session, id, &event["data"])),
        }
    }
    newest.into_iter().map(|(session, _, data)| (session, data)).collect()
}

/// Forward pages read per call: after a tail page cut to fit, or from an older host.
// ponytail: an older host is read from the start; its workers' newest work past this is missed until it updates.
const WORKER_PAGES: usize = 10;
const WORKER_TAIL: usize = 200;

/// A mirror's architect team, read from its host (`task.team`) in the desktop's
/// TeamSnapshot shape. None for a task without a team or a host too old to say.
#[tauri::command]
pub async fn remote_team(app: tauri::AppHandle, state: tauri::State<'_, AppState>, session_id: String) -> Result<Option<Value>> {
    let Ok(Some(mirror)) = of(&*lock(&state)?, &session_id) else { return Ok(None) };
    match client::call(&app, &mirror.device, "task.team", json!({"sessionId": mirror.session})).await {
        Ok(reply) => Ok(desktop_team(&reply["team"], &session_id)),
        Err(error) if error == "Unknown method." => Ok(None),
        Err(error) => Err(error),
    }
}

/// A worker's transcript on a mirror's host (`task.workerMessages`) as a desktop MessagePage:
/// the newest page, or the one before `before_id`, with the host's `hasOlder`.
#[tauri::command]
pub async fn remote_worker_messages(app: tauri::AppHandle, state: tauri::State<'_, AppState>, session_id: String, worker_id: String, before_id: Option<i64>) -> Result<Value> {
    let mirror = of(&*lock(&state)?, &session_id)?.ok_or("That task does not run on another computer.")?;
    let ask = |key: &str, value: Value| {
        let mut params = json!({"sessionId": mirror.session, "workerId": worker_id});
        params[key] = value;
        client::call(&app, &mirror.device, "task.workerMessages", params)
    };
    worker_pages(ask, before_id).await
}

/// Reads one desktop page of a worker's transcript with `ask(param, value)`. A backward host
/// answers the tail or the page before `before_id` in one call: a page it cut keeps the rows
/// next to the cursor and reports `hasOlder`, so the viewer goes on backward with its next
/// `beforeId`, never forward (the newer rows are already shown). An older host reads forward
/// from the start, following `hasMore`.
pub(crate) async fn worker_pages<Ask, Reply>(ask: Ask, before_id: Option<i64>) -> Result<Value>
where
    Ask: Fn(&str, Value) -> Reply,
    Reply: std::future::Future<Output = Result<Value>>,
{
    let first = match before_id { Some(id) => ask("beforeId", json!(id)), None => ask("tail", json!(true)) }.await?;
    let backward = first["tail"] == true;
    if !backward && before_id.is_some() {
        // An older host pages forward only; its first page was everything it could give.
        return Ok(json!({"messages": [], "hasOlder": false}));
    }
    let mut pages = vec![first];
    while !backward && pages.len() < WORKER_PAGES && pages.last().is_some_and(|page| page["hasMore"] == true) {
        let Some(after) = pages.last().and_then(|page| page["messages"].as_array()?.last()?["id"].as_i64()) else { break };
        pages.push(ask("afterId", json!(after)).await?);
    }
    Ok(worker_page(&pages, backward))
}

/// Joins a worker's pages into one MessagePage. A backward first page reports the host's
/// `hasOlder`. An older host can't page backward, so its forward read never offers older
/// messages, even when only the newest are kept.
fn worker_page(pages: &[Value], backward: bool) -> Value {
    let mut messages: Vec<Value> = Vec::new();
    for message in pages.iter().flat_map(|page| page["messages"].as_array().cloned().unwrap_or_default()) {
        if messages.last().and_then(|last| last["id"].as_i64()) < message["id"].as_i64() {
            messages.push(message);
        }
    }
    let keep = messages.len().saturating_sub(WORKER_TAIL);
    let has_older = backward && (pages.first().is_some_and(|page| page["hasOlder"] == true) || keep > 0);
    json!({"messages": messages.split_off(keep), "hasOlder": has_older})
}

/// The host's `task.team` reply as the desktop's TeamSnapshot, under the local task id.
fn desktop_team(team: &Value, local: &str) -> Option<Value> {
    let text = |value: &Value| json!(value.as_str().unwrap_or_default());
    let number = |value: &Value| json!(value.as_u64().unwrap_or_default());
    let workers: Vec<Value> = team["workers"]
        .as_array()?
        .iter()
        .filter(|worker| worker["id"].is_string() && worker["sessionId"].is_string())
        .map(|w| {
            json!({
                "id": w["id"], "sessionId": w["sessionId"], "name": text(&w["name"]), "profileId": text(&w["profileId"]),
                "provider": text(&w["provider"]), "model": text(&w["model"]), "reasoningEffort": w["reasoningEffort"].as_str(),
                "status": text(&w["status"]), "assignment": text(&w["assignment"]), "summary": text(&w["summary"]), "error": w["error"].as_str(),
                "dependsOn": w["dependsOn"].as_array().map_or_else(Vec::new, |ids| ids.iter().filter(|id| id.is_string()).cloned().collect()),
                "files": w["files"].as_array().map_or_else(Vec::new, |files| files.iter().filter(|file| file.is_string()).cloned().collect()),
                "readOnly": w["readOnly"] == true, "abandoned": w["abandoned"] == true, "attempt": number(&w["attempt"]),
                "checkpoint": w["checkpoint"].is_object().then(|| &w["checkpoint"]), "createdAt": number(&w["createdAt"]), "updatedAt": number(&w["updatedAt"]),
                "parentWorker": w["parentWorker"].as_str(),
            })
        })
        .collect();
    Some(json!({
        "sessionId": local,
        "config": {"auto": team["mode"] == "auto", "workers": [], "maxParallel": 0, "maxRounds": number(&team["rounds"]["max"]), "maxAssignments": 0, "workspace": "shared", "summaryLimit": 0},
        "status": text(&team["status"]), "round": number(&team["round"]), "revision": number(&team["revision"]),
        "workers": workers, "error": null, "summary": team["summary"].as_str(), "updatedAt": number(&team["updatedAt"]),
    }))
}

/// `run.finished` from the task's host. Newer hosts number it like an event (`seq`), so it
/// is held, ordered and shown once like one, and comes back in a replay.
pub(crate) fn finished(app: &tauri::AppHandle, from: &str, data: &Value) {
    if !data.is_object() {
        return;
    }
    let mut entry = data.clone();
    entry["kind"] = json!(RUN_END);
    apply(app, from, None, &[entry], true);
    save_cursors(app, false);
}

/// A run end: copy the run's messages, then end the local turn.
fn run_ended(app: &tauri::AppHandle, from: &str, data: &Value) {
    let Some(session) = data["sessionId"].as_str() else { return };
    let Some(local) = app.state::<AppState>().store.lock().ok().and_then(|store| local_id(&store, from, session)) else { return };
    let (successful, stopped) = (data["successful"].as_bool().unwrap_or(false), data["stopped"].as_bool().unwrap_or(false));
    let text: String = data["text"].as_str().unwrap_or("Turn complete").chars().take(200).collect();
    let app = app.clone();
    tauri::async_runtime::spawn(async move { end_turn(&app, &local, successful, stopped, &text).await });
}

/// Copies the run's messages, always (a turn that ended here first, by Stop or an offline
/// host, still gets them), then ends the turn unless it already ended.
async fn end_turn(app: &tauri::AppHandle, local: &str, successful: bool, stopped: bool, text: &str) {
    if let Err(error) = sync(app, local).await {
        eprintln!("PandaCode Connect: could not copy a remote task's messages: {error}");
    }
    finish(app, local, successful, stopped, text);
}

fn active(state: &AppState, local: &str) -> bool {
    lock(state).is_ok_and(|store| store.db.query_row("SELECT status IN ('running','waiting') FROM sessions WHERE id=?1", [local], |r| r.get(0)).unwrap_or(false))
}

/// Ends a running mirror's turn once: false (and nothing changes) when it already ended.
fn finish_once(store: &Store, local: &str, successful: bool, stopped: bool) -> Result<bool> {
    let running: bool = store.db.query_row("SELECT status IN ('running','waiting') FROM sessions WHERE id=?1", [local], |r| r.get(0)).map_err(|e| e.to_string())?;
    if running {
        store.finish_task_turn(local, successful, stopped)?;
    }
    Ok(running)
}

/// Ends the local turn and emits the window's ordinary `done`, unless it already ended.
fn finish(app: &tauri::AppHandle, local: &str, successful: bool, stopped: bool, text: &str) {
    // The window drops a turn's cards when it ends.
    remote(app).lock().viewer.cards.remove(local);
    match lock(&app.state::<AppState>()).and_then(|store| finish_once(&store, local, successful, stopped)) {
        Ok(true) => {}
        Ok(false) => return,
        Err(error) => eprintln!("PandaCode Connect: could not end a remote task's turn: {error}"),
    }
    let done = AgentEvent { session_id: local.to_owned(), kind: "done".into(), text: text.to_owned(), request_id: None, data: None, tool: None };
    let _ = app.emit("agent-event", done);
    let _ = app.emit("sessions-changed", ());
    // `after` schedules watching a mirror fire like they do for a local run.
    if !stopped {
        crate::schedules::run_finished(app, local, successful);
    }
}

/// Whether a failed call means the host can't be reached at all.
fn unreachable(error: &str, online: bool) -> bool {
    !online || error == super::socket::OFFLINE
}

/// Stops a mirror's run. When its host is offline the run can't be reached, so the local
/// turn ends as stopped and the spinner clears. None for a local task.
pub(crate) async fn stop(app: &tauri::AppHandle, state: &AppState, local: &str) -> Result<Option<()>> {
    // Still starting (its reply was lost): Stop cancels the start, now or once the host is back.
    if remote(app).lock().viewer.starts.contains_key(local) {
        return cancel_start(app, state, local).await.map(|_| Some(()));
    }
    let device = { of(&*lock(state)?, local)?.map(|mirror| mirror.device) };
    let Some(device) = device else { return Ok(None) };
    match route(app, state, local, "task.stop", json!({})).await {
        Ok(_) => Ok(Some(())),
        Err(error) => {
            let online = remote(app).lock().devices.iter().any(|d| d.id == device && d.online);
            if !unreachable(&error, online) {
                return Err(error);
            }
            finish(app, local, false, true, "Turn stopped");
            Ok(Some(()))
        }
    }
}

/// Copies the host's messages after the last one copied, page by page. A mirror with
/// nothing copied yet gets the host's newest page first, so a long thread shows at once
/// on a slow link; older pages follow in the background ([`backfill`]).
pub(crate) async fn sync(app: &tauri::AppHandle, local: &str) -> Result<()> {
    let state = app.state::<AppState>();
    let (mirror, synced) = position(&state, local)?;
    if synced == 0 {
        // Hosts before newest-first paging ignore `tail` and answer the oldest page,
        // without `hasOlder`: that page is the first afterId page.
        if let Ok(page) = client::call(app, &mirror.device, "task.messages", json!({"sessionId": mirror.session, "tail": true, "limit": TAIL_PAGE, "budget": TAIL_BUDGET})).await {
            store_first(&*lock(&state)?, local, 0, &page)?;
            let _ = app.emit("mirror-messages", json!({"sessionId": local, "older": false}));
        }
    }
    let copied = copy_newer(app, local).await;
    // A failed catch-up still repairs cut copies and fills the older history it has.
    fill_in(app, local).await;
    copied
}

/// Copies the host's messages after the last one copied, page by page.
async fn copy_newer(app: &tauri::AppHandle, local: &str) -> Result<()> {
    let state = app.state::<AppState>();
    for _ in 0..MAX_PAGES {
        let (mirror, after) = position(&state, local)?;
        let page = client::call(app, &mirror.device, "task.messages", json!({"sessionId": mirror.session, "afterId": after, "budget": PACKED_BUDGET})).await?;
        if !store_page(&*lock(&state)?, local, after, &page)? {
            break;
        }
    }
    Ok(())
}

/// Fetches cut copies whole, then starts the backfill. A failed fetch is not fatal: the cut
/// copy stays marked and the next sync tries again.
async fn fill_in(app: &tauri::AppHandle, local: &str) {
    if let Err(error) = uncut(app, local).await {
        super::diagnostics::record("mirror.uncut", format!("could not fetch a cut message whole: {error}"));
    }
    backfill_soon(app, local);
}

/// A mirror's copies the host cut (`cut: true`: the newest message, cut to fit a small first
/// page), as (local id, host id). They stay marked (`messages.remote_cut`) across restarts
/// until [`uncut`] fetches them whole.
fn cut_copies(store: &Store, local: &str) -> Result<Vec<(i64, i64)>> {
    let mut statement = store.db.prepare("SELECT id,remote_cut FROM messages WHERE session_id=?1 AND remote_cut IS NOT NULL ORDER BY id").map_err(|e| e.to_string())?;
    let rows = statement.query_map([local], |r| Ok((r.get(0)?, r.get(1)?))).map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<_>>().map_err(|e| e.to_string())
}

/// Fetches each cut copy of `local` whole (afterId id-1, the full budget) and replaces it.
async fn uncut(app: &tauri::AppHandle, local: &str) -> Result<()> {
    let state = app.state::<AppState>();
    let pending = cut_copies(&*lock(&state)?, local)?;
    if pending.is_empty() {
        return Ok(());
    }
    let (mirror, _) = position(&state, local)?;
    for (id, host_id) in pending {
        let page = client::call(app, &mirror.device, "task.messages", json!({"sessionId": mirror.session, "afterId": host_id - 1, "limit": 1, "budget": PACKED_BUDGET})).await?;
        replace_cut(&*lock(&state)?, local, (id, host_id), &page)?;
    }
    let _ = app.emit("mirror-messages", json!({"sessionId": local, "older": false}));
    Ok(())
}

/// Replaces a cut copy with the page's whole message. The copy is forgotten either way: a
/// message the host no longer has, or cuts again, stays as it is.
pub(crate) fn replace_cut(store: &Store, local: &str, (id, host_id): (i64, i64), page: &Value) -> Result<bool> {
    store.db.execute("UPDATE messages SET remote_cut=NULL WHERE id=?1 AND session_id=?2", params![id, local]).map_err(|e| e.to_string())?;
    let Some(message) = page["messages"].as_array().and_then(|messages| messages.first()).filter(|m| m["id"].as_i64() == Some(host_id) && m["cut"] != true) else { return Ok(false) };
    let (_, role, content, created_at) = valid_message(message)?;
    let changed = store.db.execute("UPDATE messages SET role=?3,content=?4,created_at=?5,turn_duration_ms=?6 WHERE id=?1 AND session_id=?2", params![id, local, role, content, created_at, message["turnDurationMs"].as_i64()]).map_err(|e| e.to_string())?;
    Ok(changed > 0)
}

fn position(state: &AppState, local: &str) -> Result<(Mirror, i64)> {
    let store = lock(state)?;
    let mirror = of(&store, local)?.ok_or("That task does not run on another computer.")?;
    let after: i64 = store.db.query_row("SELECT remote_synced_id FROM sessions WHERE id=?1", [local], |r| r.get(0)).map_err(|e| e.to_string())?;
    Ok((mirror, after))
}

/// Copies older pages, newest first, until the host has none left, in rounds of
/// [`BACKFILL_PAGES`]. One run per mirror; a failure stops it until the next sync.
fn backfill_soon(app: &tauri::AppHandle, local: &str) {
    static RUNNING: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    let running = RUNNING.get_or_init(Default::default);
    if !running.lock().unwrap_or_else(|e| e.into_inner()).insert(local.to_owned()) {
        return;
    }
    let (app, local) = (app.clone(), local.to_owned());
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        let page = |mirror: Mirror, before: i64| {
            let app = app.clone();
            async move {
                yield_to_calls(&app, &mirror.device).await;
                client::call(&app, &mirror.device, "task.messages", json!({"sessionId": mirror.session, "beforeId": before, "limit": OLDER_PAGE, "budget": PACKED_BUDGET})).await
            }
        };
        let stored = || {
            let _ = app.emit("mirror-messages", json!({"sessionId": &local, "older": true}));
        };
        if let Err(error) = backfill(&state.store, &local, page, stored).await {
            eprintln!("PandaCode Connect: could not copy a remote task's older messages: {error}");
        }
        running.lock().unwrap_or_else(|e| e.into_inner()).remove(&local);
    });
}

/// Backfill rounds until nothing older is left (or a page fails): `page` asks the host for the
/// page before a host id, `stored` follows each stored page.
async fn backfill<F, Fut>(store: &Mutex<Store>, local: &str, mut page: F, stored: impl Fn()) -> Result<()>
where
    F: FnMut(Mirror, i64) -> Fut,
    Fut: Future<Output = Result<Value>>,
{
    let lock = || store.lock().map_err(|e| e.to_string());
    loop {
        for _ in 0..BACKFILL_PAGES {
            let (mirror, oldest) = {
                let store = lock()?;
                let Some(oldest) = oldest_copied(&store, local)? else { return Ok(()) };
                (of(&store, local)?.ok_or("That task does not run on another computer.")?, oldest)
            };
            let page = page(mirror, oldest.1).await?;
            let more = store_older(&*lock()?, local, oldest, &page)?;
            stored();
            if !more {
                return Ok(());
            }
        }
        // The round ended on its cap with more to copy: another follows, so an idle mirror
        // never keeps a missing middle.
        tokio::task::yield_now().await;
    }
}

/// Waits while calls to `device` are pending (a thread opening, a prompt), so a backfill page
/// never queues ahead of them on a slow link; at most [`BACKFILL_YIELD`].
async fn yield_to_calls(app: &tauri::AppHandle, device: &str) {
    let started = Instant::now();
    while started.elapsed() < BACKFILL_YIELD && remote(app).lock().pending.values().any(|(to, _)| to == device) {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// The backfill base and the oldest host id copied so far, while older messages remain.
fn oldest_copied(store: &Store, local: &str) -> Result<Option<(i64, i64)>> {
    let base: Option<i64> = store.db.query_row("SELECT remote_backfill_base FROM sessions WHERE id=?1", [local], |r| r.get(0)).map_err(|e| e.to_string())?;
    let Some(base) = base else { return Ok(None) };
    let oldest: Option<i64> = store.db.query_row("SELECT MIN(id) FROM messages WHERE session_id=?1 AND id>?2", params![local, base], |r| r.get(0)).map_err(|e| e.to_string())?;
    Ok(oldest.map(|id| (base, id - base)))
}

/// One copied message, checked: (host id, role, content, created at).
fn valid_message(message: &Value) -> Result<(i64, &str, &str, i64)> {
    let (Some(id), Some(role), Some(content), Some(created_at)) = (message["id"].as_i64(), message["role"].as_str(), message["content"].as_str(), message["createdAt"].as_i64()) else { return Err("The other computer sent an invalid message.".into()) };
    if id <= 0 || role.is_empty() || role.len() > 32 || !role.bytes().all(|b| b.is_ascii_lowercase() || b == b'_') {
        return Err("The other computer sent an invalid message.".into());
    }
    Ok((id, role, content, created_at))
}

fn insert_copy(store: &Store, local: &str, id: Option<i64>, message: &Value) -> Result<()> {
    let (host_id, role, content, created_at) = valid_message(message)?;
    let cut = (message["cut"] == true).then_some(host_id);
    store.db.execute("INSERT INTO messages(id,session_id,role,content,created_at,turn_duration_ms,remote_cut) VALUES (?1,?2,?3,?4,?5,?6,?7)", params![id, local, role, content, created_at, message["turnDurationMs"].as_i64(), cut]).map_err(|e| e.to_string())?;
    Ok(())
}

fn store_title(store: &Store, local: &str, page: &Value) -> Result<()> {
    if let Some(title) = page["title"].as_str().map(str::trim).filter(|title| !title.is_empty() && title.chars().count() <= 200) {
        store.db.execute("UPDATE sessions SET title=?2 WHERE id=?1 AND title<>?2", params![local, title]).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Checks a page's host ids rise strictly, all inside `(low, high)`.
fn ascending(messages: &[Value], low: i64, high: i64) -> Result<()> {
    let mut last = low;
    for message in messages {
        let (id, ..) = valid_message(message)?;
        if id <= last || id >= high {
            return Err("The other computer sent an invalid message.".into());
        }
        last = id;
    }
    Ok(())
}

// ponytail: copies only new ids; a host message rewritten in place after the copy stays stale.
// Add an updated_at column to messages if that shows up.
/// Stores one `task.messages` page copied after `after` and advances the mirror's
/// position, all or nothing. Returns whether to ask for the next page. A page that no
/// longer starts at the stored position (another sync got there first) is skipped.
pub(crate) fn store_page(store: &Store, local: &str, after: i64, page: &Value) -> Result<bool> {
    let transaction = store.db.unchecked_transaction().map_err(|e| e.to_string())?;
    let current: i64 = store.db.query_row("SELECT remote_synced_id FROM sessions WHERE id=?1", [local], |r| r.get(0)).map_err(|e| e.to_string())?;
    if current != after {
        return Ok(false);
    }
    let messages = page["messages"].as_array().map(Vec::as_slice).unwrap_or_default();
    ascending(messages, after, i64::MAX)?;
    for message in messages {
        insert_copy(store, local, None, message)?;
    }
    let last = messages.last().and_then(|m| m["id"].as_i64()).unwrap_or(after);
    store_title(store, local, page)?;
    store.db.execute("UPDATE sessions SET remote_synced_id=?2 WHERE id=?1", params![local, last]).map_err(|e| e.to_string())?;
    transaction.commit().map_err(|e| e.to_string())?;
    Ok(page["hasMore"] == true && last > after)
}

/// Stores the host's newest page into a mirror with nothing copied. Its messages take local
/// ids `base + host id` above every id in use, so the range below them stays free for older
/// pages ([`store_older`]) and the thread still reads in host order. Returns whether it stored.
pub(crate) fn store_tail(store: &Store, local: &str, page: &Value) -> Result<bool> {
    let transaction = store.db.unchecked_transaction().map_err(|e| e.to_string())?;
    let current: i64 = store.db.query_row("SELECT remote_synced_id FROM sessions WHERE id=?1", [local], |r| r.get(0)).map_err(|e| e.to_string())?;
    if current != 0 {
        return Ok(false);
    }
    let messages = page["messages"].as_array().map(Vec::as_slice).unwrap_or_default();
    ascending(messages, 0, i64::MAX)?;
    let Some(last) = messages.last().and_then(|m| m["id"].as_i64()) else { return Ok(false) };
    let base: i64 = store.db.query_row("SELECT MAX(COALESCE((SELECT MAX(id) FROM messages),0),COALESCE((SELECT seq FROM sqlite_sequence WHERE name='messages'),0))", [], |r| r.get(0)).map_err(|e| e.to_string())?;
    base.checked_add(last).ok_or("The other computer sent an invalid message.")?;
    for message in messages {
        insert_copy(store, local, Some(base + message["id"].as_i64().unwrap_or_default()), message)?;
    }
    store_title(store, local, page)?;
    let older = (page["hasOlder"] == true).then_some(base);
    store.db.execute("UPDATE sessions SET remote_synced_id=?2,remote_backfill_base=?3 WHERE id=?1", params![local, last, older]).map_err(|e| e.to_string())?;
    transaction.commit().map_err(|e| e.to_string())?;
    Ok(true)
}

/// Stores one older page (`beforeId` the oldest copied host id) under the copied messages.
/// Returns whether older pages remain. A page for a position that moved is skipped.
pub(crate) fn store_older(store: &Store, local: &str, (base, before): (i64, i64), page: &Value) -> Result<bool> {
    let transaction = store.db.unchecked_transaction().map_err(|e| e.to_string())?;
    if oldest_copied(store, local)? != Some((base, before)) {
        return Ok(false);
    }
    let messages = page["messages"].as_array().map(Vec::as_slice).unwrap_or_default();
    ascending(messages, 0, before)?;
    for message in messages {
        insert_copy(store, local, Some(base + message["id"].as_i64().unwrap_or_default()), message)?;
    }
    let more = page["hasOlder"] == true && !messages.is_empty();
    if !more {
        store.db.execute("UPDATE sessions SET remote_backfill_base=NULL WHERE id=?1", [local]).map_err(|e| e.to_string())?;
    }
    transaction.commit().map_err(|e| e.to_string())?;
    Ok(more)
}

/// What a host's status means for a mirror that shows `local`.
#[derive(Debug, PartialEq)]
enum Reconcile {
    Same,
    Set(String),
    /// The run ended while this computer was not listening.
    Ended { successful: bool, stopped: bool },
}

fn reconcile(local: &str, host: &str) -> Reconcile {
    let active = |status: &str| matches!(status, "running" | "waiting");
    if active(host) {
        return if local == host { Reconcile::Same } else { Reconcile::Set(host.to_owned()) };
    }
    if active(local) {
        return Reconcile::Ended { successful: host == "idle", stopped: host == "interrupted" };
    }
    // Interrupted by this computer's restart: the host knows how the turn really ended.
    if local == "interrupted" && local != host {
        return Reconcile::Set(host.to_owned());
    }
    Reconcile::Same
}

/// Host tasks a subscribe reply says are gone. Older hosts don't list them; there a
/// requested task missing from a reply far too small to have been trimmed is gone.
fn gone(reply: &Value, requested: &[String]) -> Vec<String> {
    if let Some(missing) = reply["missing"].as_array() {
        return missing.iter().filter_map(Value::as_str).filter(|id| requested.iter().any(|r| r == id)).map(str::to_owned).collect();
    }
    if reply.to_string().len() > host::PAGE_BUDGET / 16 {
        return Vec::new();
    }
    let listed: HashSet<&str> = reply["tasks"].as_array().map(|tasks| tasks.iter().filter_map(|task| task["sessionId"].as_str()).collect()).unwrap_or_default();
    requested.iter().filter(|id| !listed.contains(id.as_str())).cloned().collect()
}

#[derive(Default)]
struct Schedule {
    running: bool,
    again: bool,
    retry: bool,
    failures: u32,
    /// The next round follows a reconnect: no debounce, and catch-up pages go with it.
    reconnected: bool,
}

fn schedule() -> MutexGuard<'static, Schedule> {
    static SCHEDULE: OnceLock<Mutex<Schedule>> = OnceLock::new();
    SCHEDULE.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner())
}

/// The wait before retrying after `failures` failed rounds: 2 s, 4 s, 8 s… up to a minute.
fn retry_delay(failures: u32) -> Duration {
    RETRY_FIRST.saturating_mul(1 << failures.saturating_sub(1).min(5)).min(RETRY_MAX)
}

/// Subscribes to every online host soon, one round at a time: calls within the debounce
/// share a round, a call during a round runs one more after it, and a round in which a
/// host running an active mirror failed is retried within seconds. Run on each presence
/// change, every 9 minutes and after a start.
pub(crate) fn subscribe_soon(app: &tauri::AppHandle) {
    {
        let mut schedule = schedule();
        if std::mem::replace(&mut schedule.running, true) {
            schedule.again = true;
            return;
        }
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            if !schedule().reconnected {
                tokio::time::sleep(SUBSCRIBE_DEBOUNCE).await;
            }
            let reconnected = {
                let mut schedule = schedule();
                schedule.again = false;
                std::mem::take(&mut schedule.reconnected)
            };
            let failed = subscribe_all(&app, reconnected).await;
            let retry = {
                let mut schedule = schedule();
                schedule.failures = if failed { schedule.failures.saturating_add(1) } else { 0 };
                if schedule.again {
                    continue;
                }
                schedule.running = false;
                (failed && !std::mem::replace(&mut schedule.retry, true)).then(|| retry_delay(schedule.failures))
            };
            if let Some(delay) = retry {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(delay).await;
                    schedule().retry = false;
                    subscribe_soon(&app);
                });
            }
            break;
        }
    });
}

/// [`subscribe_soon`] for the socket's first presence: the round starts at once (presence
/// comes with the upgrade, so there is no burst to wait out) and copies the newest messages
/// of recent mirrors alongside the subscribe instead of after its reply.
pub(crate) fn subscribe_reconnected(app: &tauri::AppHandle) {
    schedule().reconnected = true;
    subscribe_soon(app);
}

/// A followed mirror: host task, local task, last host id copied, running or waiting.
struct Followed {
    session: String,
    local: String,
    synced: i64,
    active: bool,
}

/// The mirrors whose first page goes with a reconnect's subscribe, at most [`PIPELINED`]:
/// running ones with messages copied (their afterId page), then one with nothing copied yet
/// (its tail: running first, else the most recently updated, so a first open waits one round
/// trip, not two), then the most recently updated copied ones (the order given).
fn pipelined(mirrors: &[Followed]) -> Vec<&Followed> {
    let copied = || mirrors.iter().filter(|m| m.synced > 0);
    let fresh = mirrors.iter().filter(|m| m.synced == 0);
    let first = fresh.clone().find(|m| m.active).or_else(|| fresh.clone().next());
    copied().filter(|m| m.active).chain(first).chain(copied().filter(|m| !m.active)).take(PIPELINED).collect()
}

/// Asks every online host (all at once) for the events of the tasks mirrored from it,
/// and catches up on what changed meanwhile; also follows up starts whose reply was lost.
/// Returns whether a host running an active mirror could not be reached.
async fn subscribe_all(app: &tauri::AppHandle, reconnected: bool) -> bool {
    let mirrors: Vec<(String, Followed)> = {
        let state = app.state::<AppState>();
        let Ok(store) = state.store.lock() else { return false };
        let Ok(mut statement) = store.db.prepare("SELECT remote_device,remote_session,id,remote_synced_id,status IN ('running','waiting') FROM sessions WHERE remote_session IS NOT NULL AND archived=0 ORDER BY updated_at DESC") else { return false };
        statement.query_map([], |r| Ok((r.get(0)?, Followed { session: r.get(1)?, local: r.get(2)?, synced: r.get(3)?, active: r.get(4)? }))).map(|rows| rows.filter_map(std::result::Result::ok).collect()).unwrap_or_default()
    };
    let mut hosts: HashMap<String, Vec<Followed>> = HashMap::new();
    for (device, mirror) in mirrors {
        let followed = hosts.entry(device).or_default();
        if followed.len() < host::MAX_IDS {
            followed.push(mirror);
        }
    }
    load_cursors(app);
    let online: HashSet<String> = remote(app).lock().devices.iter().filter(|d| d.online).map(|d| d.id.clone()).collect();
    resume_starts(app, &online);
    let followed: HashSet<String> = hosts.keys().filter(|device| online.contains(*device)).cloned().collect();
    // A host held after `lagged` that is not asked this round shows what it holds now.
    let idle: Vec<String> = remote(app).lock().viewer.held.keys().filter(|device| !followed.contains(*device)).cloned().collect();
    for device in idle {
        show_held(app, &device);
    }
    let rounds = hosts.into_iter().filter(|(device, _)| online.contains(device)).map(|(device, followed)| async move {
        let sessions: Vec<String> = followed.iter().map(|m| m.session.clone()).collect();
        let active = followed.iter().any(|m| m.active);
        let early = if reconnected { pipelined(&followed) } else { Vec::new() };
        match follow_host(app, &device, &sessions, &early).await {
            Ok(()) => false,
            Err(error) => {
                eprintln!("PandaCode Connect: could not follow tasks on {}: {error}", super::device_label(&device));
                if client::maybe_ran(&error) {
                    super::diagnostics::record("rpc.timeout", format!("subscribe to {}", super::device_label(&device)));
                }
                active
            }
        }
    });
    let failed = futures_util::future::join_all(rounds).await.into_iter().any(|failed| failed);
    save_cursors(app, true);
    failed
}

/// Subscribes to one host and follows its replay pages (`more`), holding live entries
/// meanwhile; then the snapshot's statuses and cards, what arrived meanwhile, and last the
/// messages copies of tasks that need them. The `early` mirrors' afterId pages are asked
/// right behind the first subscribe and stored before its snapshot's `lastId` is checked,
/// whatever order the host answered in, so a mirror they caught up needs no copy after it:
/// one round trip less on a reconnect. Any host takes them; one that fails is copied as before.
async fn follow_host(app: &tauri::AppHandle, device: &str, sessions: &[String], early: &[&Followed]) -> Result<()> {
    remote(app).lock().viewer.hold(device);
    let (mut asked, mut latest, mut first) = (sessions.to_vec(), Vec::<Value>::new(), None);
    let (mut failure, mut cut) = (None, None);
    // Polled after the subscribe below, so its request leaves first.
    let pages = futures_util::future::join_all(early.iter().map(|m| async move {
        let params = if m.synced == 0 {
            json!({"sessionId": m.session, "tail": true, "limit": TAIL_PAGE, "budget": TAIL_BUDGET})
        } else {
            json!({"sessionId": m.session, "afterId": m.synced, "budget": PACKED_BUDGET})
        };
        (m.local.as_str(), m.synced, client::call(app, device, "task.messages", params).await)
    }));
    let subscribed = async {
        for page in 1..=MAX_REPLAY_PAGES {
            let params = remote(app).lock().viewer.subscribe_params(device, &asked);
            let reply = match client::call(app, device, "subscribe", params).await {
                Ok(reply) => reply,
                Err(error) => {
                    failure = Some(error);
                    break;
                }
            };
            let more = replay(app, device, &reply);
            let tasks = reply["tasks"].as_array().cloned().unwrap_or_default();
            // Later pages carry newer snapshots of the tasks they continue.
            latest.retain(|task: &Value| !tasks.iter().any(|newer| newer["sessionId"] == task["sessionId"]));
            latest.extend(tasks);
            first.get_or_insert(reply.clone());
            if reply["more"] != true || more.is_empty() {
                break;
            }
            asked = more;
            if page == MAX_REPLAY_PAGES {
                cut = Some(format!("the replay went past {MAX_REPLAY_PAGES} pages"));
            }
        }
    };
    let ((), pages) = futures_util::join!(subscribed, pages);
    let mut changed = store_early(app, pages);
    let Some(first) = first else {
        if changed {
            let _ = app.emit("sessions-changed", ());
        }
        show_held(app, device);
        return Err(failure.unwrap_or_default());
    };
    if let Some(error) = cut.as_ref().or(failure.as_ref()) {
        // A replay cut short: the messages copy catches those tasks up.
        super::diagnostics::record("replay.gap", format!("{} tasks on {}: {error}", asked.len(), super::device_label(device)));
        for task in latest.iter_mut().filter(|task| task["sessionId"].as_str().is_some_and(|id| asked.iter().any(|a| a == id))) {
            task["gap"] = json!(true);
        }
    }
    let pending = catch_up(app, device, &first, sessions, &latest);
    show_held(app, device);
    for (local, ended) in pending {
        match ended {
            Some((successful, stopped)) => end_turn(app, &local, successful, stopped, if successful { "Turn complete" } else if stopped { "Turn stopped" } else { "Turn failed" }).await,
            None => changed |= sync(app, &local).await.is_ok(),
        }
    }
    if changed {
        let _ = app.emit("sessions-changed", ());
    }
    failure.map_or(Ok(()), Err)
}

/// Stores the pages asked with a subscribe; whether any stored messages. A page whose mirror
/// moved meanwhile is skipped ([`store_page`] and [`store_tail`] check the position).
fn store_early(app: &tauri::AppHandle, pages: Vec<(&str, i64, Result<Value>)>) -> bool {
    let state = app.state::<AppState>();
    let mut changed = false;
    for (local, after, page) in pages {
        let Ok(page) = page else { continue };
        let stored = lock(&state).and_then(|store| store_first(&store, local, after, &page).map(|_| synced_id(&store, local) > after));
        if stored.unwrap_or(false) {
            changed = true;
            let _ = app.emit("mirror-messages", json!({"sessionId": local, "older": false}));
            let (app, local) = (app.clone(), local.to_owned());
            tauri::async_runtime::spawn(async move { fill_in(&app, &local).await });
        }
    }
    changed
}

/// Stores a mirror's first page of a sync: a tail into one with nothing copied (older hosts
/// answer the oldest page, without `hasOlder`), else an afterId page.
fn store_first(store: &Store, local: &str, after: i64, page: &Value) -> Result<bool> {
    if after == 0 && page.get("hasOlder").is_some() {
        store_tail(store, local, page)
    } else {
        store_page(store, local, after, page)
    }
}

fn synced_id(store: &Store, local: &str) -> i64 {
    store.db.query_row("SELECT remote_synced_id FROM sessions WHERE id=?1", [local], |r| r.get(0)).unwrap_or(0)
}

/// Shows a subscribe reply's replayed entries in order and moves this viewer's positions;
/// the tasks whose replay continues in another page.
fn replay(app: &tauri::AppHandle, device: &str, reply: &Value) -> Vec<String> {
    let epoch = reply["epoch"].as_str();
    let mut more = Vec::new();
    for task in reply["tasks"].as_array().map(Vec::as_slice).unwrap_or_default() {
        let Some(session) = task["sessionId"].as_str() else { continue };
        // What this viewer missed while away, in order, before the snapshot.
        if let Some(events) = task["events"].as_array() {
            apply(app, device, epoch, events, false);
        }
        if let Some(seq) = task["seq"].as_u64() {
            let state = remote(app);
            let mut inner = state.lock();
            inner.viewer.epoch(device, epoch);
            inner.viewer.settle(device, session, seq);
        }
        if task["more"] == true {
            more.push(session.to_owned());
        }
        if task["gap"] == true {
            super::diagnostics::record("replay.gap", format!("a task on {}", super::device_label(device)));
        }
    }
    more
}

/// Shows the live entries held for a host while it was being subscribed to.
fn show_held(app: &tauri::AppHandle, device: &str) {
    let held = remote(app).lock().viewer.release(device);
    for (epoch, entry) in held.entries {
        apply(app, device, epoch.as_deref(), std::slice::from_ref(&entry), false);
    }
    if held.overflow {
        subscribe_soon(app);
    }
}

/// Applies a subscribe's snapshot: gone tasks end, statuses and cards follow the host.
/// Returns the mirrors still to finish (`Some(successful, stopped)`) or copy messages for.
fn catch_up(app: &tauri::AppHandle, device: &str, reply: &Value, requested: &[String], tasks: &[Value]) -> Vec<(String, Option<(bool, bool)>)> {
    let mut changed = false;
    let mut pending = Vec::new();
    // A task deleted on the host (or never made there) would otherwise spin forever.
    for session in gone(reply, requested) {
        let state = app.state::<AppState>();
        let local = lock(&state).ok().and_then(|store| local_id(&store, device, &session));
        if let Some(local) = local.filter(|local| active(&state, local)) {
            finish(app, &local, false, false, &format!("This task is no longer on {}.", super::device_label(device)));
        }
    }
    for task in tasks {
        let (Some(session), Some(status)) = (task["sessionId"].as_str(), task["status"].as_str()) else { continue };
        let row = app.state::<AppState>().store.lock().ok().and_then(|store| {
            let local = local_id(&store, device, session)?;
            // Unfinished: a backfill or a cut copy left by an earlier run (say, before a quit).
            store.db.query_row("SELECT status,remote_synced_id,remote_backfill_base IS NOT NULL OR EXISTS(SELECT 1 FROM messages WHERE session_id=sessions.id AND remote_cut IS NOT NULL) FROM sessions WHERE id=?1", [&local], |r| Ok((local.clone(), r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, bool>(2)?))).ok()
        });
        let Some((local, current, synced, unfinished)) = row else { continue };
        match reconcile(&current, status) {
            Reconcile::Ended { successful, stopped } => {
                pending.push((local, Some((successful, stopped))));
                continue;
            }
            Reconcile::Set(status) => changed |= lock(&app.state::<AppState>()).and_then(|store| store.status(&local, &status)).is_ok(),
            Reconcile::Same => {}
        }
        // Approvals and questions still waiting come back after a restart or a lost frame.
        if let Some(requests) = task["pending"].as_array() {
            let shown = remote(app).lock().viewer.sync_cards(&local, requests);
            for event in shown {
                let _ = app.emit("agent-event", event);
            }
        }
        // Child agents still at work: the snapshot covers events this viewer missed.
        if let Some(children) = task["subagents"].as_array() {
            let events: Vec<Value> = children.iter().map(|data| json!({"sessionId": local, "kind": "subagent", "text": "", "requestId": null, "data": data})).collect();
            if let Ok(store) = lock(&app.state::<AppState>()) {
                save_subagents(&store, &events);
            }
            for event in events {
                let _ = app.emit("agent-event", event);
            }
        }
        // A gap means events were lost: the messages copy is the full catch-up.
        if task["gap"] == true || task["lastId"].as_i64().is_some_and(|last| last > synced) || (unfinished && synced > 0) {
            pending.push((local, None));
        }
    }
    if changed {
        let _ = app.emit("sessions-changed", ());
    }
    pending
}

/// Reads the cursors saved by an earlier run, once per sign-in.
fn load_cursors(app: &tauri::AppHandle) {
    if remote(app).lock().viewer.loaded {
        return;
    }
    let rows = lock(&app.state::<AppState>()).and_then(|store| store.remote_cursors());
    if let Err(error) = &rows {
        eprintln!("PandaCode Connect: could not read saved event positions: {error}");
    }
    remote(app).lock().viewer.restore(rows.unwrap_or_default());
}

/// Saves changed cursors: with `force` now, else at most every [`SAVE_EVERY`] (a save is
/// then scheduled), so a restart of this computer replays instead of copying everything.
fn save_cursors(app: &tauri::AppHandle, force: bool) {
    let unsaved = {
        let state = remote(app);
        let mut inner = state.lock();
        let viewer = &mut inner.viewer;
        if !viewer.loaded || viewer.dirty.is_empty() {
            return;
        }
        if !force && viewer.saved_at.is_some_and(|at| at.elapsed() < SAVE_EVERY) {
            if !std::mem::replace(&mut viewer.save_scheduled, true) {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(SAVE_EVERY).await;
                    remote(&app).lock().viewer.save_scheduled = false;
                    save_cursors(&app, true);
                });
            }
            return;
        }
        viewer.saved_at = Some(Instant::now());
        viewer.unsaved()
    };
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let Ok(store) = state.store.lock() else { return };
        for (device, epoch, seqs) in unsaved {
            if let Err(error) = store.save_remote_cursors(&device, &epoch, &seqs) {
                eprintln!("PandaCode Connect: could not save event positions: {error}");
            }
        }
    });
}

/// Follows up, on each host that is online, every start whose reply was lost.
fn resume_starts(app: &tauri::AppHandle, online: &HashSet<String>) {
    let ready: Vec<String> = {
        let state = remote(app);
        let mut inner = state.lock();
        inner.viewer.starts.iter_mut().filter(|(_, start)| !start.busy && online.contains(&start.device)).map(|(local, start)| {
            start.busy = true;
            local.clone()
        }).collect()
    };
    for local in ready {
        tauri::async_runtime::spawn(resume_start(app.clone(), local));
    }
}

/// How a start stands, from `task.startStatus` (or from its failure).
#[derive(Debug, PartialEq)]
enum StartState {
    Running,
    /// The host task, and its worktree note (see [`start_note`]).
    Done(String, Option<String>),
    Failed(String),
    /// Ask again once the host is back.
    Unreachable,
}

/// A start still running on its host when this viewer stops polling is not a failure: it
/// stays waiting (and stoppable), asked again when the host is next seen, linked if it ends.
fn past_deadline(outcome: StartState, late: bool) -> StartState {
    match outcome {
        StartState::Running if late => StartState::Unreachable,
        outcome => outcome,
    }
}

fn start_state(reply: &Result<Value>) -> StartState {
    match reply {
        Err(error) if client::maybe_ran(error) || error == super::socket::OFFLINE => StartState::Unreachable,
        // Older hosts refuse `task.startStatus` as an unknown method: the start can't be found.
        Err(error) => StartState::Failed(error.clone()),
        Ok(reply) => match reply["state"].as_str() {
            Some("running") => StartState::Running,
            Some("done") => started_session(reply).map_or_else(StartState::Failed, |session| StartState::Done(session, start_note(reply))),
            Some("failed") => StartState::Failed(reply["error"].as_str().unwrap_or("The other computer could not start the task.").chars().take(1000).collect()),
            _ => StartState::Failed("The other computer lost track of this start.".into()),
        },
    }
}

/// A start whose reply was lost: asks its host by `startId` how it went until it ends,
/// then links the mirror or puts the row back.
async fn resume_start(app: tauri::AppHandle, local: String) {
    let deadline = Instant::now() + START_TIMEOUT;
    // The host can't cancel (an older one): follow the start instead, stopping it once made.
    let mut uncancellable = false;
    loop {
        let start = remote(&app).lock().viewer.starts.get(&local).map(|start| (start.device.clone(), start.start_id.clone(), start.created, start.cancelling));
        let Some((device, start_id, created, cancelling)) = start else { return };
        let state = app.state::<AppState>();
        // Stopped while the host could not be reached: ask it again to cancel.
        if cancelling && !uncancellable {
            let reply = client::call(&app, &device, "task.cancelStart", json!({"startId": start_id})).await;
            match cancel_outcome(&reply) {
                // Too late (the host is making the task now): follow it and stop it once made.
                Cancel::Unsupported | Cancel::TooLate => {
                    uncancellable = true;
                    continue;
                }
                // Made before the cancel arrived: the user asked for it to stop.
                Cancel::Started(session) => {
                    remote(&app).lock().viewer.starts.remove(&local);
                    if let Err(error) = linked(&app, &state, &local, &session, true) {
                        eprintln!("PandaCode Connect: could not link a remote task: {error}");
                    }
                    let _ = app.emit("sessions-changed", ());
                }
                outcome => {
                    if let Err(error) = settle_cancel(&app, &state, &local, outcome) {
                        eprintln!("PandaCode Connect: could not cancel a start on {}: {error}", super::device_label(&device));
                    }
                }
            }
            if let Some(start) = remote(&app).lock().viewer.starts.get_mut(&local) {
                start.busy = false;
            }
            return;
        }
        let reply = client::call(&app, &device, "task.startStatus", json!({"startId": start_id})).await;
        let outcome = past_deadline(start_state(&reply), Instant::now() >= deadline);
        match outcome {
            StartState::Running => {
                tokio::time::sleep(START_POLL).await;
                continue;
            }
            StartState::Unreachable => {
                if let Some(start) = remote(&app).lock().viewer.starts.get_mut(&local) {
                    start.busy = false;
                }
                waiting_for(&app, &device, &start_id, None);
                return;
            }
            StartState::Done(session, note) => {
                let stop_now = remote(&app).lock().viewer.starts.remove(&local).is_some_and(|start| start.cancelling);
                if let Err(error) = linked(&app, &state, &local, &session, stop_now) {
                    eprintln!("PandaCode Connect: could not link a remote task: {error}");
                }
                // The note the lost `task.start` reply carried, shown under the prompt as then.
                if let Some(note) = note {
                    let _ = app.emit("remote://start-note", json!({"sessionId": local, "note": note}));
                }
            }
            StartState::Failed(error) => {
                remote(&app).lock().viewer.starts.remove(&local);
                abandon(&state, &local, created);
                super::diagnostics::record("start.failed", error.chars().take(200).collect::<String>());
                let _ = app.emit("remote://start-progress", json!({"deviceId": device, "startId": start_id, "repo": null, "stage": "error", "percent": null, "detail": error}));
            }
        }
        let _ = app.emit("sessions-changed", ());
        return;
    }
}

/// While a start's outcome is unknown (its reply was lost or the host is away), the row
/// says what it waits for.
fn waiting_for(app: &tauri::AppHandle, device: &str, start_id: &str, repo: Option<&str>) {
    let _ = app.emit("remote://start-progress", json!({"deviceId": device, "startId": start_id, "repo": repo, "stage": "starting", "percent": null, "detail": format!("Waiting for {}…", super::device_label(device))}));
}

/// Links a started mirror; one the user stopped meanwhile is stopped on its host now.
fn linked(app: &tauri::AppHandle, state: &AppState, local: &str, session: &str, stop_now: bool) -> Result<()> {
    attach(state, local, session)?;
    subscribe_soon(app);
    if stop_now {
        let (app, local) = (app.clone(), local.to_owned());
        tauri::async_runtime::spawn(async move {
            if let Err(error) = stop(&app, &app.state::<AppState>(), &local).await {
                eprintln!("PandaCode Connect: could not stop a cancelled remote task: {error}");
            }
        });
    }
    Ok(())
}

/// What a `task.cancelStart` call settled.
#[derive(Debug, PartialEq)]
enum Cancel {
    /// The host confirmed it stopped it (or never had it): put the row back.
    Cancelled,
    /// The host had already made its task.
    Started(String),
    /// The host is making its task now: it can't be cancelled, so it is linked and stopped
    /// once its start reply (or `task.startStatus`) names it.
    TooLate,
    /// The call may not have arrived (or the host is gone from the account): keep the start
    /// and ask again when the host is back.
    Pending,
    /// An older host can't cancel: keep the start, follow it with `task.startStatus`, and
    /// stop it once it is made.
    Unsupported,
    /// The host answered with an error; the start stays as it was.
    Refused(String),
}

fn cancel_outcome(reply: &Result<Value>) -> Cancel {
    match reply {
        Ok(reply) if reply["cancelled"] == false && reply["pending"] == true => Cancel::TooLate,
        Ok(reply) if reply["cancelled"] == false => started_session(reply).map_or_else(Cancel::Refused, Cancel::Started),
        Ok(_) => Cancel::Cancelled,
        // Only the host's own answer cancels: one that can't be reached stays pending.
        Err(error) if client::maybe_ran(error) || error == super::socket::OFFLINE || error == super::UNKNOWN_DEVICE => Cancel::Pending,
        Err(error) if error == "Unknown method." => Cancel::Unsupported,
        Err(error) => Cancel::Refused(error.clone()),
    }
}

/// Acts on a cancel's outcome; the `remote_cancel_start` reply.
fn settle_cancel(app: &tauri::AppHandle, state: &AppState, local: &str, outcome: Cancel) -> Result<Value> {
    match outcome {
        Cancel::Started(session) => {
            remote(app).lock().viewer.starts.remove(local);
            attach(state, local, &session)?;
            subscribe_soon(app);
            let _ = app.emit("sessions-changed", ());
            Ok(json!({"cancelled": false}))
        }
        Cancel::Cancelled => {
            let start = remote(app).lock().viewer.starts.remove(local);
            if let Some(start) = start {
                start.cancel.notify_one();
                abandon(state, local, start.created);
            }
            let _ = app.emit("sessions-changed", ());
            Ok(json!({"cancelled": true}))
        }
        Cancel::Pending | Cancel::Unsupported | Cancel::TooLate => Ok(json!({"cancelled": false, "pending": true})),
        Cancel::Refused(error) => {
            if let Some(start) = remote(app).lock().viewer.starts.get_mut(local) {
                start.cancelling = false;
            }
            Err(error)
        }
    }
}

/// The host task id in a `task.start` (or `task.startStatus`) reply.
/// Why the host started the task somewhere other than asked (its busy main checkout gave way
/// to a worktree), cut to one short line. Older hosts send none.
fn start_note(reply: &Value) -> Option<String> {
    reply["note"].as_str().map(|note| note.lines().next().unwrap_or_default().chars().take(300).collect::<String>()).filter(|note| !note.trim().is_empty())
}

fn started_session(reply: &Value) -> Result<String> {
    reply["sessionId"].as_str().filter(|id| host::valid_id(id).is_ok()).map(str::to_owned).ok_or_else(|| "The other computer did not start the task.".to_string())
}

/// Links a mirror row to its host task, unless it already is.
fn attach(state: &AppState, local: &str, session: &str) -> Result<()> {
    link(&*lock(state)?, local, session)
}

fn link(store: &Store, local: &str, session: &str) -> Result<()> {
    store.db.execute("UPDATE sessions SET remote_session=?2 WHERE id=?1 AND remote_session IS NULL", params![local, session]).map(|_| ()).map_err(|e| e.to_string())
}

/// Puts back what a start that did not happen left, while the row still waits for its
/// host task: a new row goes, a reused draft is a local draft again.
fn abandon(state: &AppState, local: &str, created: bool) {
    let waiting = lock(state).ok().and_then(|store| store.db.query_row("SELECT remote_device IS NOT NULL AND remote_session IS NULL FROM sessions WHERE id=?1", [local], |r| r.get::<_, bool>(0)).ok()).unwrap_or(false);
    if !waiting {
        return;
    }
    if created {
        let _ = crate::task_deletion::delete_state(state, local);
    } else if let Ok(store) = lock(state) {
        let _ = store.db.execute("UPDATE sessions SET remote_device=NULL,remote_session=NULL,draft=1,status='idle' WHERE id=?1", [local]);
    }
}

/// `{repo, branch, ahead, dirty, pushed}` for a checkout, from git's own output.
pub(crate) fn repo_summary(origin: &str, branch: &str, status: &str, ahead: Option<&str>, pushed: bool) -> Value {
    json!({
        "repo": crate::github_hub::repo_from_remote(origin),
        "branch": branch.trim(),
        "ahead": ahead.and_then(|count| count.trim().parse::<u64>().ok()).unwrap_or(0),
        "dirty": !status.trim().is_empty(),
        "pushed": pushed,
    })
}

/// What another computer would see of this checkout. Reads only local refs (no fetch).
fn repo_status(root: &Path) -> Result<Value> {
    let quick = Duration::from_secs(10);
    let origin = git(root, &["config", "--get", "remote.origin.url"], quick).unwrap_or_default();
    let branch = git(root, &["symbolic-ref", "--quiet", "--short", "HEAD"], quick).unwrap_or_default();
    let status = git(root, &["status", "--porcelain"], quick)?;
    let ahead = git(root, &["rev-list", "--count", "@{u}..HEAD"], quick).ok();
    let pushed = !branch.is_empty() && git(root, &["rev-parse", "--verify", "--quiet", &format!("refs/remotes/origin/{branch}")], quick).is_ok();
    Ok(repo_summary(&origin, &branch, &status, ahead.as_deref(), pushed))
}

async fn project_status(state: &AppState, project_id: &str) -> Result<Value> {
    let root = lock(state)?.workspace_root(project_id, None)?;
    tauri::async_runtime::spawn_blocking(move || repo_status(&root)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn remote_repo_check(state: tauri::State<'_, AppState>, project_id: String) -> Result<Value> {
    project_status(&state, &project_id).await
}

/// Starts a task on another computer and returns its local mirror, like `create_session`
/// (the session, plus `sessionId`). An empty New task draft given as `sessionId` becomes
/// the mirror.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn remote_start_task(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    device_id: String,
    project_id: String,
    prompt: String,
    provider: String,
    model: String,
    mode: Option<String>,
    effort: Option<String>,
    worktree: Option<bool>,
    branch: Option<String>,
    session_id: Option<String>,
    start_id: Option<String>,
    image_ids: Option<Vec<String>>,
) -> Result<Value> {
    super::valid_device_id(&device_id)?;
    {
        let state = remote(&app);
        let inner = state.lock();
        inner.callable(&device_id)?;
        if !inner.devices.iter().any(|d| d.id == device_id && d.host) {
            return Err(format!("{} does not allow remote control.", super::device_label(&device_id)));
        }
    }
    super::catalog::check(&app, &device_id, &provider, &model)?;
    let prompt = prompt.trim().to_owned();
    if prompt.is_empty() || prompt.len() > host::MAX_TEXT {
        return Err("Send between 1 byte and 100 KB of text.".into());
    }
    let check = project_status(&state, &project_id).await?;
    let repo = check["repo"].as_str().ok_or(NO_REPO)?.to_owned();
    let branch = branch.filter(|b| !b.trim().is_empty()).or_else(|| check["branch"].as_str().filter(|b| !b.is_empty()).map(str::to_owned));
    // Images go first, before any row exists: a failed upload leaves the New task as it was.
    let image_ids = super::images::send(&app, &device_id, image_ids.as_deref().unwrap_or_default()).await?;
    let (local, created) = mirror_row(&*lock(&state)?, &device_id, &project_id, &provider, &model, mode.as_deref(), effort.as_deref(), session_id.as_deref())?;
    // The host echoes `startId` in its `task.progress` events (remote/start.rs), runs a
    // repeated start once, and reports or cancels it by this id.
    let start_id = start_id.filter(|id| host::valid_id(id).is_ok());
    let cancel = Arc::new(Notify::new());
    if let Some(start_id) = &start_id {
        remote(&app).lock().viewer.starts.insert(local.clone(), PendingStart { device: device_id.clone(), start_id: start_id.clone(), created, cancel: cancel.clone(), busy: true, cancelling: false });
    }
    let request = json!({"repo": repo, "branch": branch, "worktree": worktree.unwrap_or(false), "prompt": prompt, "provider": provider, "model": model, "mode": mode, "effort": effort, "startId": start_id, "imageIds": image_ids});
    let started = tokio::select! {
        reply = client::call_within(&app, &device_id, "task.start", request, START_TIMEOUT) => reply,
        _ = cancel.notified() => Err(super::start::CANCELLED.into()),
    }
    .and_then(|reply| Ok((started_session(&reply)?, start_note(&reply))));
    let note = started.as_ref().ok().and_then(|(_, note)| note.clone());
    let started = started.map(|(session, _)| session);
    match started {
        // The reply was lost, maybe not the start: the row stays (running) in `starts`, so
        // Stop cancels it, and the host is asked by `startId` how it went once it is back
        // (`resume_start`). Meanwhile the row says what it waits for.
        Err(error) if start_id.is_some() && client::maybe_ran(&error) => {
            let kept = {
                let state = remote(&app);
                let mut inner = state.lock();
                inner.viewer.starts.get_mut(&local).map(|start| {
                    start.busy = false;
                    start.start_id.clone()
                })
            };
            if let Some(start_id) = kept {
                waiting_for(&app, &device_id, &start_id, Some(&repo));
            }
            super::diagnostics::record("rpc.timeout", format!("task.start on {}: {error}", super::device_label(&device_id)));
            eprintln!("PandaCode Connect: lost the reply to a start ({error}); asking the host again when it is back.");
        }
        started => {
            let stop_now = remote(&app).lock().viewer.starts.remove(&local).is_some_and(|start| start.cancelling);
            match started.and_then(|session| linked(&app, &state, &local, &session, stop_now)) {
                Ok(()) => {}
                Err(error) => {
                    // Leave nothing behind: a new row goes, a reused draft is a local draft again.
                    abandon(&state, &local, created);
                    if error != super::start::CANCELLED {
                        super::diagnostics::record("start.failed", error.chars().take(200).collect::<String>());
                    }
                    let _ = app.emit("sessions-changed", ());
                    return Err(error);
                }
            }
        }
    }
    subscribe_soon(&app);
    let _ = app.emit("sessions-changed", ());
    let mut session = serde_json::to_value(lock(&state)?.session(&local)?).map_err(|e| e.to_string())?;
    session["sessionId"] = json!(local);
    if let Some(note) = note {
        session["note"] = json!(note);
    }
    Ok(session)
}

/// Cancels a start that has not made its host task yet (`sessionId` is the local row),
/// also one whose reply was lost: once the host confirms, it stops it, clone included, and
/// the row is put back (a new row goes, a reused draft is a draft again). `cancelled:
/// false` when the host had already made the task; the mirror then runs as usual and Stop
/// ends it. When the cancel may not have arrived, the start is kept and cancelled again
/// once the host is back: `{cancelled: false, pending: true}` (the row keeps "Stopping").
#[tauri::command]
pub async fn remote_cancel_start(app: tauri::AppHandle, state: tauri::State<'_, AppState>, session_id: String) -> Result<Value> {
    cancel_start(&app, &state, &session_id).await
}

async fn cancel_start(app: &tauri::AppHandle, state: &AppState, local: &str) -> Result<Value> {
    let start = remote(app).lock().viewer.starts.get_mut(local).map(|start| {
        start.cancelling = true;
        (start.device.clone(), start.start_id.clone())
    });
    let Some((device, start_id)) = start else { return Err("That task is not starting.".into()) };
    let reply = client::call(app, &device, "task.cancelStart", json!({"startId": start_id})).await;
    let outcome = cancel_outcome(&reply);
    if let Err(error) = &reply {
        eprintln!("PandaCode Connect: could not cancel a start on {}: {error}", super::device_label(&device));
        if client::maybe_ran(error) {
            super::diagnostics::record("rpc.timeout", format!("task.cancelStart on {}: {error}", super::device_label(&device)));
        }
    }
    settle_cancel(app, state, local, outcome)
}

/// Makes (or converts an empty draft into) the local mirror row, published and running.
#[allow(clippy::too_many_arguments)]
fn mirror_row(store: &Store, device: &str, project_id: &str, provider: &str, model: &str, mode: Option<&str>, effort: Option<&str>, draft: Option<&str>) -> Result<(String, bool)> {
    // A draft with its own local worktree keeps it; the mirror gets a fresh row.
    let reuse = draft.filter(|id| store.is_empty_draft(id).unwrap_or(false) && store.session(id).is_ok_and(|task| task.project_id == project_id && task.worktree_path.is_none()));
    // `create_user_task` commits its own transaction, so a new row is made before this one.
    let (id, created) = match reuse {
        Some(id) => (id.to_owned(), false),
        None => (crate::architect::profiles::create_user_task(store, project_id, provider, model, mode, None)?.id, true),
    };
    let transaction = store.db.unchecked_transaction().map_err(|e| e.to_string())?;
    if !created {
        store.configure(&id, provider, model, None)?;
        if let Some(mode) = mode {
            store.update(&id, None, None, None, Some(mode.to_owned()))?;
        }
    }
    if effort.is_some() {
        store.set_reasoning_effort(&id, effort)?;
    }
    store.db.execute("UPDATE sessions SET remote_device=?2,remote_session=NULL,remote_synced_id=0,draft=0 WHERE id=?1", params![id, device]).map_err(|e| e.to_string())?;
    // A default team was saved on the new task (or the draft); its agents would need this
    // computer's checkout, so the mirror is a single agent on the host.
    store.db.execute("DELETE FROM architect_teams WHERE session_id=?1", [&id]).map_err(|e| e.to_string())?;
    start_turn(store, &id)?;
    transaction.commit().map_err(|e| e.to_string())?;
    Ok((id, created))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (Store, String) {
        let store = Store::open(Path::new(":memory:")).unwrap();
        let project = store.add_project(&std::env::temp_dir()).unwrap();
        let task = store.create_session(&project.id, "claude", "sonnet", "full").unwrap();
        store.db.execute("UPDATE sessions SET remote_device='host',remote_session='h1' WHERE id=?1", [&task.id]).unwrap();
        (store, task.id)
    }

    #[test]
    fn a_worktree_fallback_note_is_one_short_line() {
        assert_eq!(start_note(&json!({"sessionId": "s"})), None);
        assert_eq!(start_note(&json!({"note": "  "})), None);
        assert_eq!(start_note(&json!({"note": "Started in a worktree: busy.\nmore"})).as_deref(), Some("Started in a worktree: busy."));
        assert_eq!(start_note(&json!({"note": "x".repeat(500)})).map(|note| note.len()), Some(300));
    }

    #[test]
    fn subagent_snapshots_keep_the_newest_per_child() {
        let events = [
            json!({"sessionId": "l", "kind": "subagent", "data": {"id": "r:a", "status": "running"}}),
            json!({"sessionId": "l", "kind": "text", "text": "x"}),
            json!({"sessionId": "l", "kind": "subagent", "data": {"id": "r:b", "status": "running"}}),
            json!({"sessionId": "l", "kind": "subagent", "data": {"id": "r:a", "status": "completed"}}),
            json!({"sessionId": "l", "kind": "subagent", "data": {}}),
        ];
        let newest = newest_subagents(&events);
        assert_eq!(newest.iter().map(|(s, d)| (*s, d["id"].as_str().unwrap(), d["status"].as_str().unwrap())).collect::<Vec<_>>(), [("l", "r:a", "completed"), ("l", "r:b", "running")]);
    }

    #[test]
    fn a_mirror_never_gets_a_local_team() {
        let (store, mirror) = store();
        assert!(crate::architect::refuse_mirror(&store, &mirror).unwrap_err().starts_with("This task's team runs on "));
        let project = store.add_project(&std::env::temp_dir()).unwrap();
        let local = store.create_session(&project.id, "claude", "sonnet", "full").unwrap();
        assert_eq!(crate::architect::refuse_mirror(&store, &local.id), Ok(()));
    }

    #[test]
    fn worker_pages_join_in_order_and_say_when_older_ones_exist() {
        let page = |ids: &[i64], older: bool| json!({"messages": ids.iter().map(|id| json!({"id": id})).collect::<Vec<_>>(), "hasOlder": older, "tail": true});
        let ids = |page: &Value| page["messages"].as_array().unwrap().iter().map(|m| m["id"].as_i64().unwrap()).collect::<Vec<_>>();
        let joined = worker_page(&[page(&[5, 6], true), page(&[6, 7], true)], true);
        assert_eq!((ids(&joined), joined["hasOlder"].as_bool()), (vec![5, 6, 7], Some(true)), "a repeat is dropped, the host's hasOlder kept");
        assert_eq!(worker_page(&[page(&[1], false)], true)["hasOlder"], false);
        let long: Vec<i64> = (1..=(WORKER_TAIL as i64 + 3)).collect();
        let legacy = worker_page(&[page(&long, false)], false);
        assert_eq!((ids(&legacy).len(), ids(&legacy)[0], legacy["hasOlder"].as_bool()), (WORKER_TAIL, 4, Some(false)), "an older host's read keeps the newest and offers nothing older it cannot page back to");
    }

    #[test]
    fn a_host_team_becomes_a_desktop_snapshot_under_the_local_id() {
        assert_eq!(desktop_team(&Value::Null, "local"), None, "no team");
        let host = json!({"sessionId": "h1", "status": "running", "round": 2, "revision": 7, "mode": "auto", "rounds": {"used": 2, "max": 6}, "summary": null, "updatedAt": 5, "messages": [{"id": 1}],
            "workers": [{"id": "w1", "sessionId": "hw1", "name": "Docs", "provider": "codex", "model": "gpt", "status": "running", "attempt": 1, "summary": "", "files": ["a.md", 3], "dependsOn": [], "checkpoint": {"summary": "half", "nextSteps": "", "blocker": null, "updatedAt": 4}, "createdAt": 1, "updatedAt": 2, "profileId": "auto", "assignment": "Write", "error": null, "readOnly": true, "abandoned": false},
                {"name": "no id"}]});
        let team = desktop_team(&host, "local").unwrap();
        assert_eq!(team["sessionId"], "local");
        assert_eq!(team["config"]["auto"], true);
        assert_eq!(team["config"]["maxRounds"], 6);
        assert_eq!((team["status"].as_str(), team["round"].as_u64(), team["revision"].as_u64()), (Some("running"), Some(2), Some(7)));
        assert!(team.get("messages").is_none() && team.get("mode").is_none());
        let workers = team["workers"].as_array().unwrap();
        assert_eq!(workers.len(), 1, "a row without ids is dropped");
        assert_eq!(workers[0]["files"], json!(["a.md"]));
        assert_eq!(workers[0]["checkpoint"]["summary"], "half");
        assert_eq!((workers[0]["readOnly"].as_bool(), workers[0]["reasoningEffort"].is_null()), (Some(true), true));
        assert!(workers[0]["parentWorker"].is_null());
        let sub = json!({"workers": [{"id": "s1", "sessionId": "hs1", "status": "parked", "parentWorker": "w1"}]});
        let sub = &desktop_team(&sub, "local").unwrap()["workers"][0];
        assert_eq!((sub["status"].as_str(), sub["parentWorker"].as_str()), (Some("parked"), Some("w1")));
    }

    #[test]
    fn version_26_adds_the_mirror_columns() {
        let path = std::env::temp_dir().join(format!("pandacode-mirror-{}.sqlite3", uuid::Uuid::new_v4()));
        {
            let store = Store::open(&path).unwrap();
            store.db.execute_batch("DROP INDEX sessions_remote; ALTER TABLE sessions DROP COLUMN remote_device; ALTER TABLE sessions DROP COLUMN remote_session; ALTER TABLE sessions DROP COLUMN remote_synced_id; PRAGMA user_version=25;").unwrap();
        }
        let store = Store::open(&path).unwrap();
        assert_eq!((crate::storage::SCHEMA_VERSION, store.db.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0)).unwrap()), (crate::storage::SCHEMA_VERSION, crate::storage::SCHEMA_VERSION));
        let columns: i64 = store.db.query_row("SELECT COUNT(*) FROM pragma_table_info('sessions') WHERE name IN ('remote_device','remote_session','remote_synced_id')", [], |r| r.get(0)).unwrap();
        assert_eq!(columns, 3);
        let project = store.add_project(&std::env::temp_dir()).unwrap();
        let task = store.create_session(&project.id, "claude", "sonnet", "full").unwrap();
        let synced: i64 = store.db.query_row("SELECT remote_synced_id FROM sessions WHERE id=?1", [&task.id], |r| r.get(0)).unwrap();
        assert_eq!((synced, task.remote_device), (0, None));
        drop(store);
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    }

    #[test]
    fn a_mirror_knows_its_host_task() {
        let (store, local) = store();
        let mirror = of(&store, &local).unwrap().unwrap();
        assert_eq!((mirror.device.as_str(), mirror.session.as_str()), ("host", "h1"));
        assert_eq!(local_id(&store, "host", "h1"), Some(local.clone()));
        assert_eq!(local_id(&store, "other", "h1"), None, "only the host that runs it");
        let task = store.session(&local).unwrap();
        assert_eq!(task.remote_device.map(|d| d.id), Some("host".into()));
        assert_eq!(serde_json::to_value(store.session(&local).unwrap()).unwrap()["remoteDevice"]["name"], "another computer");
        // The checkout is on the host: git and worktree commands never reach this disk.
        assert_eq!(store.workspace_root(&task.project_id, Some(&local)), Err("This task runs on another computer.".into()));
        store.db.execute("UPDATE sessions SET remote_session=NULL WHERE id=?1", [&local]).unwrap();
        assert!(of(&store, &local).unwrap_err().contains("still starting"));
        let plain = store.create_session(&task.project_id, "claude", "sonnet", "full").unwrap();
        assert!(of(&store, &plain.id).unwrap().is_none());
        assert!(serde_json::to_value(plain).unwrap().get("remoteDevice").is_none());
    }

    #[test]
    fn a_mirror_send_goes_to_its_host_task() {
        let (store, local) = store();
        let routed = prepare(&store, &local, "task.send", json!({"text": "hi"})).unwrap().unwrap();
        assert_eq!(routed, Routed { device: "host".into(), params: json!({"text": "hi", "sessionId": "h1"}), before: Some("idle".into()) });
        let task = store.session(&local).unwrap();
        assert_eq!((task.status.as_str(), task.task_stage.as_str()), ("running", "in_progress"), "running before the host answers");
        // Other commands carry the host id and leave the status alone.
        let stop = prepare(&store, &local, "task.stop", json!({})).unwrap().unwrap();
        assert_eq!((stop.params, stop.before), (json!({"sessionId": "h1"}), None));
        // A local task is not routed: the command runs here as always.
        let plain = store.create_session(&task.project_id, "claude", "sonnet", "full").unwrap();
        assert_eq!(prepare(&store, &plain.id, "task.send", json!({"text": "hi"})).unwrap(), None);
        assert_eq!(store.session(&plain.id).unwrap().status, "idle");
    }

    #[test]
    fn a_follow_up_on_a_mirror_with_a_saved_team_goes_to_its_host() {
        // A default team is saved on every new task. The first prompt starts the mirror on
        // the host; a follow-up must not start that team here, in a checkout this computer
        // does not have ("This task runs on …").
        let store = Store::open(Path::new(":memory:")).unwrap();
        let project = store.add_project(&std::env::temp_dir()).unwrap();
        let draft = store.create_session(&project.id, "claude", "sonnet", "full").unwrap();
        store.mark_draft(&draft.id).unwrap();
        let team = |id: &str| json!({"sessionId": id, "config": {"auto": true, "workers": [], "maxParallel": 0, "maxRounds": 8, "maxAssignments": 24, "workspace": "shared", "summaryLimit": 3072}, "status": "idle", "round": 0, "revision": 1, "workers": [], "error": null, "summary": null, "updatedAt": 0}).to_string();
        store.db.execute("INSERT INTO architect_teams(session_id,content) VALUES (?1,?2)", params![draft.id, team(&draft.id)]).unwrap();
        let (local, _) = mirror_row(&store, "host", &project.id, "claude", "sonnet", None, None, Some(&draft.id)).unwrap();
        let teams: i64 = store.db.query_row("SELECT COUNT(*) FROM architect_teams WHERE session_id=?1", [&local], |r| r.get(0)).unwrap();
        assert_eq!(teams, 0, "the mirror is a single agent on the host");
        store.db.execute("UPDATE sessions SET remote_session='h1' WHERE id=?1", [&local]).unwrap();
        store.finish_task_turn(&local, true, false).unwrap();
        // A mirror made before this fix still has its team row: it is routed anyway.
        store.db.execute("INSERT INTO architect_teams(session_id,content) VALUES (?1,?2)", params![local, team(&local)]).unwrap();
        assert!(crate::architect::load(&store, &local).unwrap().is_some());
        assert_eq!(crate::send_target(&store, &local), Ok(crate::SendTarget::Mirror));
        assert!(store.workspace_root(&project.id, Some(&local)).is_err(), "nothing local may run it");
        let second = prepare(&store, &local, "task.send", json!({"text": "and now the tests"})).unwrap().unwrap();
        assert_eq!(second.params, json!({"text": "and now the tests", "sessionId": "h1"}));
        let plain = store.create_session(&project.id, "claude", "sonnet", "full").unwrap();
        assert_eq!(crate::send_target(&store, &plain.id), Ok(crate::SendTarget::Local));
    }

    #[test]
    fn events_take_the_local_id() {
        let events = [
            json!({"sessionId": "h1", "kind": "text", "text": "Hel", "requestId": null, "data": null}),
            json!({"sessionId": "h2", "kind": "text", "text": "other task", "requestId": null, "data": null}),
            json!({"sessionId": "h1", "kind": "done", "text": "Turn complete"}),
            json!({"sessionId": "h1", "kind": "approval", "text": "Run ls", "requestId": "run:r1", "data": null}),
            json!({"kind": "text", "text": "no id"}),
        ];
        let out = relabel(&events, |id| (id == "h1").then(|| "local".to_string()));
        assert_eq!(out, vec![json!({"sessionId": "local", "kind": "text", "text": "Hel", "requestId": null, "data": null}), json!({"sessionId": "local", "kind": "approval", "text": "Run ls", "requestId": "run:r1", "data": null})]);
    }

    #[test]
    fn only_an_empty_draft_without_a_worktree_becomes_the_mirror() {
        let store = Store::open(Path::new(":memory:")).unwrap();
        let project = store.add_project(&std::env::temp_dir()).unwrap();
        let draft = store.create_session(&project.id, "claude", "sonnet", "full").unwrap();
        store.mark_draft(&draft.id).unwrap();
        let (id, created) = mirror_row(&store, "host", &project.id, "codex", "gpt", None, None, Some(&draft.id)).unwrap();
        assert_eq!((id.as_str(), created), (draft.id.as_str(), false));
        let mirror = store.session(&id).unwrap();
        assert_eq!((mirror.provider.as_str(), mirror.status.as_str(), mirror.draft), ("codex", "running", false));
        let other = store.create_session(&project.id, "claude", "sonnet", "full").unwrap();
        store.mark_draft(&other.id).unwrap();
        store.attach_worktree(&other.id, &std::env::temp_dir(), "pandacode/x").unwrap();
        let (fresh, created) = mirror_row(&store, "host", &project.id, "claude", "sonnet", None, None, Some(&other.id)).unwrap();
        assert!(created && fresh != other.id);
        assert_eq!(store.session(&other.id).unwrap().remote_device, None, "the worktree draft stays local");
    }

    #[test]
    fn a_turn_ends_once() {
        let (store, local) = store();
        store.status(&local, "running").unwrap();
        assert!(finish_once(&store, &local, false, true).unwrap());
        assert_eq!(store.session(&local).unwrap().status, "interrupted");
        assert!(!finish_once(&store, &local, true, false).unwrap(), "a second end changes nothing");
        assert_eq!(store.session(&local).unwrap().status, "interrupted");
    }

    #[test]
    fn a_stop_ends_locally_only_when_the_host_is_unreachable() {
        assert!(unreachable(super::super::socket::OFFLINE, true));
        assert!(unreachable("anything", false));
        assert!(!unreachable("That computer did not answer in time.", true));
        assert!(!unreachable("This agent is no longer running.", true));
    }

    #[test]
    fn events_move_the_status() {
        assert_eq!(status_after("idle", "text"), Some("running"));
        assert_eq!(status_after("running", "text"), None);
        assert_eq!(status_after("running", "approval"), Some("waiting"));
        assert_eq!(status_after("waiting", "tool"), None);
        assert_eq!(status_after("waiting", "approval_cancelled"), Some("running"));
        // A remote answer is now forwarded as a cancel event: the mirror leaves waiting.
        assert_eq!(status_after("waiting", "input_cancelled"), Some("running"));
        assert_eq!(status_after("running", "input_cancelled"), None);
        // What a host sends after its run ended never restarts an idle mirror.
        for kind in ["usage", "session", "task_settings", "turn_changes", "turn_complete", "commands_changed", "goal", "approval_cancelled"] {
            assert_eq!(status_after("idle", kind), None, "{kind}");
        }
        assert_eq!(status_after("review", "turn_start"), Some("running"));
        assert_eq!(reconcile("idle", "running"), Reconcile::Set("running".into()));
        assert_eq!(reconcile("running", "running"), Reconcile::Same);
        assert_eq!(reconcile("running", "idle"), Reconcile::Ended { successful: true, stopped: false });
        // A mirror interrupted by this computer's restart takes the host's real outcome.
        assert_eq!(reconcile("interrupted", "idle"), Reconcile::Set("idle".into()));
        assert_eq!(reconcile("interrupted", "error"), Reconcile::Set("error".into()));
        assert_eq!(reconcile("interrupted", "interrupted"), Reconcile::Same);
        assert_eq!(reconcile("idle", "error"), Reconcile::Same);
    }

    #[test]
    fn replayed_and_repeated_events_show_once() {
        let mut viewer = Viewer::default();
        let event = |session: &str, seq: Option<u64>| {
            let mut event = json!({"sessionId": session, "kind": "text", "text": "x"});
            if let Some(seq) = seq {
                event["seq"] = json!(seq);
            }
            event
        };
        viewer.epoch("host", Some("e1"));
        assert!(viewer.fresh("host", &event("h1", Some(3))));
        assert!(!viewer.fresh("host", &event("h1", Some(3))), "a duplicate");
        assert!(!viewer.fresh("host", &event("h1", Some(2))), "older than the newest seen");
        assert!(viewer.fresh("host", &event("h2", Some(2))), "positions are per task");
        assert!(viewer.fresh("host", &event("h1", None)), "an older host sends no seq");
        assert!(viewer.fresh("other", &event("h1", Some(1))), "and per host");
        // The next subscribe says where this viewer left off.
        let params = viewer.subscribe_params("host", &["h1".into(), "h3".into()]);
        assert_eq!(params, json!({"sessionIds": ["h1", "h3"], "epoch": "e1", "afterSeq": {"h1": 3}}));
        assert_eq!(viewer.subscribe_params("other", &["h1".into()]), json!({"sessionIds": ["h1"]}), "no epoch yet: no replay");
        viewer.advance("host", "h1", 10);
        viewer.advance("host", "h1", 4);
        assert!(!viewer.fresh("host", &event("h1", Some(9))));
        // A restarted host numbers from 1 again under a new epoch.
        viewer.epoch("host", Some("e2"));
        assert!(viewer.fresh("host", &event("h1", Some(1))));
        assert!(viewer.fresh("other", &event("h1", Some(2))), "another host keeps its place");
    }

    /// What `apply` lets through: held while the host is held, else each new entry once.
    fn through(viewer: &mut Viewer, live: bool, list: &[Value]) -> Vec<u64> {
        if live && viewer.keep("host", Some("e1"), list) {
            return Vec::new();
        }
        viewer.epoch("host", Some("e1"));
        list.iter().filter(|event| viewer.fresh("host", event)).filter_map(|event| event["seq"].as_u64()).collect()
    }

    #[test]
    fn a_live_frame_before_the_subscribe_reply_hides_no_replayed_event() {
        let event = |seq: u64| json!({"sessionId": "h1", "kind": "text", "text": "x", "seq": seq});
        let mut viewer = Viewer::default();
        assert_eq!(through(&mut viewer, true, &[event(80)]), [80]);
        // Subscribe sent (afterSeq 80); a live frame (105) beats the reply (replay 90..100).
        viewer.hold("host");
        assert_eq!(through(&mut viewer, true, &[event(105)]), Vec::<u64>::new(), "held, not shown yet");
        assert_eq!(through(&mut viewer, false, &[event(90), event(100)]), [90, 100], "the replay is shown in full");
        viewer.settle("host", "h1", 104);
        let held = viewer.release("host");
        assert!(!held.overflow);
        let live: Vec<Value> = held.entries.into_iter().map(|(_, entry)| entry).collect();
        assert_eq!(through(&mut viewer, false, &live), [105], "then what came meanwhile");
        assert_eq!(through(&mut viewer, true, &[event(100), event(106)]), [106], "and duplicates stay out");
        // Holding is bounded: past it entries are dropped and the host is asked again.
        viewer.hold("host");
        let many: Vec<Value> = (0..MAX_HELD as u64 + 1).map(|i| event(200 + i)).collect();
        assert!(viewer.keep("host", None, &many));
        assert!(viewer.release("host").overflow);
    }

    #[test]
    fn a_task_without_a_position_takes_it_from_its_held_entries() {
        let mut viewer = Viewer::default();
        viewer.epoch("host", Some("e1"));
        viewer.hold("host");
        // A task followed a moment ago: its first live event waits for the reply, which
        // replays nothing for it (no afterSeq) and says seq 9.
        viewer.keep("host", Some("e1"), &[json!({"sessionId": "new", "kind": "text", "text": "x", "seq": 7})]);
        viewer.settle("host", "new", 9);
        viewer.settle("host", "old", 9);
        assert_eq!(viewer.seqs.get(&("host".into(), "new".into())), None, "its held event sets it");
        assert_eq!(viewer.seqs[&("host".into(), "old".into())], 9);
        let held = viewer.release("host");
        assert!(viewer.fresh("host", &held.entries[0].1));
    }

    #[test]
    fn cursors_survive_a_restart_of_this_computer() {
        let path = std::env::temp_dir().join(format!("pandacode-cursors-{}.sqlite3", uuid::Uuid::new_v4()));
        {
            let store = Store::open(&path).unwrap();
            let mut viewer = Viewer { loaded: true, ..Default::default() };
            viewer.epoch("host", Some("e1"));
            viewer.advance("host", "h1", 41);
            viewer.advance("host", "h2", 7);
            viewer.epoch("other", Some("x9"));
            viewer.advance("other", "h1", 3);
            for (device, epoch, seqs) in viewer.unsaved() {
                store.save_remote_cursors(&device, &epoch, &seqs).unwrap();
            }
            assert!(viewer.unsaved().is_empty(), "nothing changed since");
            // The host restarted: its old positions are replaced, not kept beside the new.
            viewer.epoch("host", Some("e2"));
            viewer.advance("host", "h1", 2);
            for (device, epoch, seqs) in viewer.unsaved() {
                store.save_remote_cursors(&device, &epoch, &seqs).unwrap();
            }
        }
        let store = Store::open(&path).unwrap();
        let mut viewer = Viewer::default();
        viewer.restore(store.remote_cursors().unwrap());
        assert!(viewer.loaded);
        assert_eq!(viewer.subscribe_params("host", &["h1".into(), "h2".into()]), json!({"sessionIds": ["h1", "h2"], "epoch": "e2", "afterSeq": {"h1": 2}}));
        assert_eq!(viewer.subscribe_params("other", &["h1".into()]), json!({"sessionIds": ["h1"], "epoch": "x9", "afterSeq": {"h1": 3}}));
        // What this run already learned wins over what was saved.
        let mut live = Viewer::default();
        live.epoch("host", Some("e3"));
        live.restore(store.remote_cursors().unwrap());
        assert_eq!(live.subscribe_params("host", &["h1".into()]), json!({"sessionIds": ["h1"], "epoch": "e3", "afterSeq": {}}));
        drop(store);
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    }

    #[test]
    fn only_a_definite_answer_cancels_a_start() {
        assert_eq!(cancel_outcome(&Ok(json!({"cancelled": true}))), Cancel::Cancelled);
        assert_eq!(cancel_outcome(&Ok(json!({"cancelled": false, "sessionId": "h1"}))), Cancel::Started("h1".into()));
        assert_eq!(cancel_outcome(&Ok(json!({"cancelled": false, "pending": true}))), Cancel::TooLate, "the host is making the task: keep the start, stop it once linked");
        assert!(matches!(cancel_outcome(&Ok(json!({"cancelled": false}))), Cancel::Refused(_)));
        // The cancel may not have arrived: keep the start and ask again when the host is back.
        for error in [client::TIMED_OUT, client::LOST, super::super::socket::OFFLINE] {
            assert_eq!(cancel_outcome(&Err(error.into())), Cancel::Pending, "{error}");
        }
        // Nothing but the host's own answer counts as cancelled.
        assert_eq!(cancel_outcome(&Err("Unknown method.".into())), Cancel::Unsupported, "an older host can't cancel: keep following it");
        assert_eq!(cancel_outcome(&Err(super::super::UNKNOWN_DEVICE.into())), Cancel::Pending, "a host gone from the account can't confirm");
        assert_eq!(cancel_outcome(&Err("Invalid startId.".into())), Cancel::Refused("Invalid startId.".into()));
    }

    #[test]
    fn run_ends_are_not_agent_events() {
        let events = [json!({"sessionId": "h1", "kind": "run.finished", "text": "Turn complete", "successful": true, "seq": 4})];
        assert!(relabel(&events, |_| Some("local".into())).is_empty());
    }

    #[test]
    fn cards_come_back_after_a_restart_and_clear_when_answered_elsewhere() {
        let mut viewer = Viewer::default();
        let pending = [json!({"kind": "approval", "requestId": "run:a1", "text": "Run ls", "data": null}), json!({"kind": "input_request", "requestId": "run:q1", "text": "Which?", "data": {"questions": []}, "tool": "ask"})];
        // A viewer that restarted shows nothing: both cards come back, once.
        let shown = viewer.sync_cards("local", &pending);
        assert_eq!(shown.iter().map(|e| (e["kind"].as_str().unwrap(), e["requestId"].as_str().unwrap(), e["sessionId"].as_str().unwrap())).collect::<Vec<_>>(), [("approval", "run:a1", "local"), ("input_request", "run:q1", "local")]);
        assert_eq!((shown[0]["text"].as_str(), shown[1]["tool"].as_str()), (Some("Run ls"), Some("ask")));
        assert!(viewer.sync_cards("local", &pending).is_empty(), "a renewal repeats nothing");
        // Answered on another device while this one missed the cancel event.
        let cleared = viewer.sync_cards("local", &pending[1..]);
        assert_eq!(cleared, vec![json!({"sessionId": "local", "kind": "approval_cancelled", "text": "", "requestId": "run:a1", "data": null})]);
        // Live events keep the record current.
        viewer.card(&json!({"sessionId": "local", "kind": "input_cancelled", "requestId": "run:q1"}));
        viewer.card(&json!({"sessionId": "local", "kind": "approval", "requestId": "run:a2"}));
        assert_eq!(viewer.sync_cards("local", &[json!({"kind": "approval", "requestId": "run:a2", "text": "", "data": null})]), Vec::<Value>::new());
    }

    #[test]
    fn tasks_gone_from_the_host_are_named() {
        let requested = ["h1".to_string(), "h2".into(), "h3".into()];
        assert_eq!(gone(&json!({"tasks": [{"sessionId": "h1"}], "missing": ["h2", "x"]}), &requested), ["h2"], "a newer host lists them");
        // An older host: what a small reply leaves out is gone, but not from a trimmed one.
        assert_eq!(gone(&json!({"tasks": [{"sessionId": "h1"}]}), &requested), ["h2", "h3"]);
        let big = json!({"tasks": [{"sessionId": "h1", "title": "x".repeat(host::PAGE_BUDGET / 8)}]});
        assert!(gone(&big, &requested).is_empty());
    }

    #[test]
    fn a_reconnect_pipelines_copied_mirrors_running_first() {
        let m = |id: &str, synced: i64, active: bool| Followed { session: id.into(), local: format!("l{id}"), synced, active };
        let mirrors = [m("a", 5, false), m("b", 0, true), m("c", 9, true), m("d", 3, false), m("e", 1, false), m("f", 2, true)];
        let picked: Vec<&str> = pipelined(&mirrors).iter().map(|m| m.session.as_str()).collect();
        // Running c and f, then b's tail (nothing copied yet), not a fourth.
        assert_eq!(picked, ["c", "f", "b"]);
        // One uncopied mirror goes with the subscribe, a running one before the newest.
        let fresh = [m("x", 0, false), m("y", 0, true), m("z", 4, false), m("w", 0, false)];
        let picked: Vec<&str> = pipelined(&fresh).iter().map(|m| m.session.as_str()).collect();
        assert_eq!(picked, ["y", "z"]);
        assert_eq!(pipelined(&[m("x", 0, false)]).len(), 1, "a first-ever open pipelines its tail");
    }

    #[test]
    fn backfill_keeps_going_past_a_round_until_the_middle_is_filled() {
        let (host, host_task) = store();
        let (viewer, local) = store();
        for i in 0..40 {
            host.message(&host_task, "user", &format!("m{i:02}")).unwrap();
        }
        let tail = host::messages_page_with(&host.db, &host_task, host::MessagePaging::Tail { limit: 4 }).unwrap();
        assert!(store_tail(&viewer, &local, &tail).unwrap());
        let viewer = Mutex::new(viewer);
        let (pages, shown) = (std::cell::Cell::new(0), std::cell::Cell::new(0));
        let page = |_: Mirror, before: i64| {
            pages.set(pages.get() + 1);
            let page = host::messages_page_with(&host.db, &host_task, host::MessagePaging::Before { before_id: before, limit: 2 });
            async move { page }
        };
        let runtime = tokio::runtime::Builder::new_current_thread().build().unwrap();
        runtime.block_on(backfill(&viewer, &local, page, || shown.set(shown.get() + 1))).unwrap();
        // 36 older messages two per page: well past one round of BACKFILL_PAGES.
        assert_eq!((pages.get(), shown.get()), (18, 18));
        assert!(pages.get() > BACKFILL_PAGES);
        let viewer = viewer.into_inner().unwrap();
        assert_eq!(oldest_copied(&viewer, &local).unwrap(), None);
        assert_eq!(viewer.messages(&local, None).unwrap().len(), 40);
    }

    #[test]
    fn a_cut_copy_stays_marked_across_a_restart_until_fetched_whole() {
        let (host, host_task) = store();
        host.message(&host_task, "assistant", &"word ".repeat(20_000)).unwrap();
        let tail = host::messages_page_fit(&host.db, &host_task, host::MessagePaging::Tail { limit: TAIL_PAGE }, TAIL_BUDGET).unwrap();
        let path = std::env::temp_dir().join(format!("pandacode-cut-{}.sqlite3", uuid::Uuid::new_v4()));
        let local = {
            let viewer = Store::open(&path).unwrap();
            let project = viewer.add_project(&std::env::temp_dir()).unwrap();
            let local = viewer.create_session(&project.id, "claude", "sonnet", "full").unwrap().id;
            viewer.db.execute("UPDATE sessions SET remote_device='host',remote_session='h1' WHERE id=?1", [&local]).unwrap();
            assert!(store_tail(&viewer, &local, &tail).unwrap());
            local
        };
        // A sync whose fetch failed (or a restart before it) leaves the mark for the next one.
        let viewer = Store::open(&path).unwrap();
        let [(id, host_id)] = cut_copies(&viewer, &local).unwrap()[..] else { panic!("the cut copy survives the restart") };
        let page = host::messages_page_fit(&host.db, &host_task, host::MessagePaging::After { after_id: host_id - 1, limit: 1 }, PACKED_BUDGET).unwrap();
        assert!(replace_cut(&viewer, &local, (id, host_id), &page).unwrap());
        assert!(cut_copies(&viewer, &local).unwrap().is_empty());
        drop(viewer);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn failed_subscribes_retry_within_seconds() {
        let s = Duration::from_secs;
        assert_eq!([1, 2, 3, 4, 9].map(retry_delay), [s(2), s(4), s(8), s(16), s(60)]);
        assert!(SUBSCRIBE_DEBOUNCE < s(1));
    }

    #[test]
    fn a_lost_start_is_asked_about_until_it_ends() {
        assert_eq!(start_state(&Ok(json!({"state": "running"}))), StartState::Running);
        assert_eq!(start_state(&Ok(json!({"state": "done", "sessionId": "h1"}))), StartState::Done("h1".into(), None));
        assert_eq!(start_state(&Ok(json!({"state": "done", "sessionId": "h1", "worktree": true, "note": "Started in a worktree: busy.\nmore"}))), StartState::Done("h1".into(), Some("Started in a worktree: busy.".into())), "a resumed start keeps its note");
        assert_eq!(start_state(&Ok(json!({"state": "failed", "error": "Cloning failed."}))), StartState::Failed("Cloning failed.".into()));
        assert!(matches!(start_state(&Ok(json!({"state": "unknown"}))), StartState::Failed(_)));
        assert!(matches!(start_state(&Ok(json!({"state": "done"}))), StartState::Failed(_)));
        // A timeout or a lost socket: ask again when the host is back.
        for error in [client::TIMED_OUT, client::LOST, super::super::socket::OFFLINE] {
            assert_eq!(start_state(&Err(error.into())), StartState::Unreachable, "{error}");
        }
        // An older host without task.startStatus.
        assert_eq!(start_state(&Err("Unknown method.".into())), StartState::Failed("Unknown method.".into()));
        assert!(client::maybe_ran(client::TIMED_OUT) && !client::maybe_ran(super::super::socket::OFFLINE));
    }

    #[test]
    fn a_start_still_running_at_the_deadline_keeps_waiting() {
        assert_eq!(past_deadline(StartState::Running, true), StartState::Unreachable, "not a failure: asked again later");
        assert_eq!(past_deadline(StartState::Running, false), StartState::Running);
        assert_eq!(past_deadline(StartState::Done("h1".into(), None), true), StartState::Done("h1".into(), None), "linked whenever the host reports it");
    }

    #[test]
    fn a_start_quit_halfway_is_a_draft_again_at_launch() {
        let path = std::env::temp_dir().join(format!("pandacode-mirror-start-{}.sqlite3", uuid::Uuid::new_v4()));
        let (waiting, linked) = {
            let store = Store::open(&path).unwrap();
            let project = store.add_project(&std::env::temp_dir()).unwrap();
            let waiting = store.create_session(&project.id, "claude", "sonnet", "full").unwrap().id;
            let linked = store.create_session(&project.id, "claude", "sonnet", "full").unwrap().id;
            store.db.execute("UPDATE sessions SET remote_device='host',remote_session=NULL,status='running' WHERE id=?1", [&waiting]).unwrap();
            store.db.execute("UPDATE sessions SET remote_device='host',remote_session='h1',status='running' WHERE id=?1", [&linked]).unwrap();
            // A late second answer (the start's own reply after a status poll) changes nothing.
            assert_eq!(link(&store, &linked, "h2"), Ok(()));
            (waiting, linked)
        };
        let store = Store::open(&path).unwrap();
        let task = store.session(&waiting).unwrap();
        assert_eq!((task.remote_device, task.status.as_str(), task.draft), (None, "idle", true));
        assert!(store.is_empty_draft(&waiting).unwrap(), "discarded with the other empty drafts");
        let mirror = of(&store, &linked).unwrap().unwrap();
        assert_eq!((mirror.session.as_str(), store.session(&linked).unwrap().status.as_str()), ("h1", "interrupted"), "a linked mirror stays");
        drop(store);
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    }

    #[test]
    fn pages_are_stored_once_and_advance_the_sync() {
        let (host, host_task) = store();
        let (viewer, local) = store();
        for i in 0..5 {
            host.message(&host_task, if i % 2 == 0 { "user" } else { "assistant" }, &format!("{i}{}", "x".repeat(60 * 1024))).unwrap();
        }
        host.db.execute("UPDATE sessions SET title='Fix the build' WHERE id=?1", [&host_task]).unwrap();
        let first = host::messages_page(&host.db, &host_task, 0).unwrap();
        assert_eq!((first["messages"].as_array().unwrap().len(), first["hasMore"].as_bool()), (2, Some(true)), "a page fits one frame");
        assert!(first.to_string().len() <= host::PAGE_BUDGET);
        assert!(store_page(&viewer, &local, 0, &first).unwrap());
        let synced: i64 = viewer.db.query_row("SELECT remote_synced_id FROM sessions WHERE id=?1", [&local], |r| r.get(0)).unwrap();
        assert_eq!(synced, first["messages"][1]["id"].as_i64().unwrap());
        // A page from a stale position (a concurrent sync) is skipped, never duplicated.
        assert!(!store_page(&viewer, &local, 0, &first).unwrap());
        let mut after = synced;
        loop {
            let page = host::messages_page(&host.db, &host_task, after).unwrap();
            let more = store_page(&viewer, &local, after, &page).unwrap();
            after = viewer.db.query_row("SELECT remote_synced_id FROM sessions WHERE id=?1", [&local], |r| r.get(0)).unwrap();
            if !more {
                break;
            }
        }
        let copied = viewer.messages(&local, None).unwrap();
        assert_eq!(copied.iter().map(|m| m.content.chars().next().unwrap()).collect::<String>(), "01234");
        assert_eq!(copied[0].role, "user");
        assert_eq!(viewer.session(&local).unwrap().title, "Fix the build");
        let empty = host::messages_page(&host.db, &host_task, after).unwrap();
        assert_eq!((empty["messages"].as_array().unwrap().len(), empty["hasMore"].as_bool()), (0, Some(false)));
        assert!(store_page(&viewer, &local, after, &json!({"messages": [{"id": 1, "role": "user", "content": "old", "createdAt": 0}]})).is_err(), "ids only move forward");
    }

    #[test]
    fn the_newest_page_shows_first_and_older_pages_fill_in_below_it() {
        use host::MessagePaging::{Before, Tail};
        let (host, host_task) = store();
        let (viewer, local) = store();
        // Another task's messages on the viewer: local ids are shared by every task.
        let other = viewer.create_session(&viewer.projects().unwrap()[0].id, "claude", "sonnet", "full").unwrap();
        viewer.message(&other.id, "user", "elsewhere").unwrap();
        for i in 0..25 {
            host.message(&host_task, if i % 2 == 0 { "user" } else { "assistant" }, &format!("m{i:02}")).unwrap();
        }
        let tail = host::messages_page_with(&host.db, &host_task, Tail { limit: 10 }).unwrap();
        assert_eq!(tail["hasOlder"], true);
        assert!(store_tail(&viewer, &local, &tail).unwrap());
        assert!(!store_tail(&viewer, &local, &tail).unwrap(), "only a mirror with nothing copied takes a tail");
        let text = |viewer: &Store| viewer.messages(&local, None).unwrap().iter().map(|m| m.content.clone()).collect::<Vec<_>>().join(",");
        assert_eq!(text(&viewer), (15..25).map(|i| format!("m{i:02}")).collect::<Vec<_>>().join(","));
        // A message made here meanwhile (another task) and a newer one on the host, caught up by afterId.
        viewer.message(&other.id, "user", "meanwhile").unwrap();
        host.message(&host_task, "user", "m25").unwrap();
        let after: i64 = viewer.db.query_row("SELECT remote_synced_id FROM sessions WHERE id=?1", [&local], |r| r.get(0)).unwrap();
        let page = host::messages_page(&host.db, &host_task, after).unwrap();
        assert!(!store_page(&viewer, &local, after, &page).unwrap());
        // Older pages, newest first, land below what is shown.
        loop {
            let oldest = oldest_copied(&viewer, &local).unwrap().expect("older messages remain");
            let page = host::messages_page_with(&host.db, &host_task, Before { before_id: oldest.1, limit: 6 }).unwrap();
            assert!(!store_older(&viewer, &local, (oldest.0, oldest.1 + 1), &page).unwrap(), "a moved position is skipped");
            if !store_older(&viewer, &local, oldest, &page).unwrap() {
                break;
            }
        }
        assert_eq!(oldest_copied(&viewer, &local).unwrap(), None);
        assert_eq!(text(&viewer), (0..26).map(|i| format!("m{i:02}")).collect::<Vec<_>>().join(","));
        assert_eq!(viewer.messages(&other.id, None).unwrap().len(), 2);
        // New local ids still go above every copied one.
        viewer.message(&local, "error", "later").unwrap();
        assert!(text(&viewer).ends_with("m25,later"));
    }

    #[test]
    fn a_budgeted_tail_shows_the_newest_few_and_packed_pages_fill_in_the_rest() {
        use host::MessagePaging::{Before, Tail};
        let (host, host_task) = store();
        let (viewer, local) = store();
        for i in 0..60 {
            host.message(&host_task, "assistant", &format!("m{i:02} {}", "the tests pass ".repeat(400))).unwrap();
        }
        let tail = host::messages_page_fit(&host.db, &host_task, Tail { limit: TAIL_PAGE }, TAIL_BUDGET).unwrap();
        let shown = tail["messages"].as_array().unwrap().len();
        assert!(tail.to_string().len() <= TAIL_BUDGET && (1..TAIL_PAGE as usize).contains(&shown));
        assert!(store_tail(&viewer, &local, &tail).unwrap());
        assert!(viewer.messages(&local, None).unwrap().last().unwrap().content.starts_with("m59 "));
        let mut pages = 0;
        while let Some(oldest) = oldest_copied(&viewer, &local).unwrap() {
            let page = host::messages_page_fit(&host.db, &host_task, Before { before_id: oldest.1, limit: OLDER_PAGE }, PACKED_BUDGET).unwrap();
            pages += 1;
            if !store_older(&viewer, &local, oldest, &page).unwrap() {
                break;
            }
        }
        assert_eq!(pages, 1, "the rest packs into one page");
        let copied = viewer.messages(&local, None).unwrap();
        assert_eq!(copied.len(), 60);
        assert!(copied.iter().enumerate().all(|(i, m)| m.content.starts_with(&format!("m{i:02} "))));
    }

    #[test]
    fn a_whole_thread_in_its_tail_needs_no_backfill() {
        let (host, host_task) = store();
        let (viewer, local) = store();
        host.message(&host_task, "user", "only").unwrap();
        let tail = host::messages_page_with(&host.db, &host_task, host::MessagePaging::Tail { limit: 30 }).unwrap();
        assert!(store_tail(&viewer, &local, &tail).unwrap());
        assert_eq!(oldest_copied(&viewer, &local).unwrap(), None);
        let (fresh, fresh_local) = store();
        assert!(store_tail(&fresh, &fresh_local, &json!({"messages": [{"id": 2, "role": "user", "content": "a", "createdAt": 0}, {"id": 1, "role": "user", "content": "b", "createdAt": 0}]})).is_err(), "ids rise");
    }

    #[test]
    fn a_newest_message_cut_for_the_tail_is_fetched_whole_later() {
        let (host, host_task) = store();
        let (viewer, local) = store();
        host.message(&host_task, "user", "hello").unwrap();
        let whole = "word ".repeat(20_000);
        host.message(&host_task, "assistant", &whole).unwrap();
        let tail = host::messages_page_fit(&host.db, &host_task, host::MessagePaging::Tail { limit: TAIL_PAGE }, TAIL_BUDGET).unwrap();
        assert!(tail.to_string().len() <= TAIL_BUDGET, "a 100 KB message no longer makes the tail 120 KB");
        let newest = tail["messages"].as_array().unwrap().last().unwrap().clone();
        assert_eq!(newest["cut"], true);
        assert!(store_tail(&viewer, &local, &tail).unwrap());
        let host_id = newest["id"].as_i64().unwrap();
        let [(id, _)] = cut_copies(&viewer, &local).unwrap()[..] else { panic!("the cut copy is remembered") };
        let page = host::messages_page_fit(&host.db, &host_task, host::MessagePaging::After { after_id: host_id - 1, limit: 1 }, PACKED_BUDGET).unwrap();
        assert!(replace_cut(&viewer, &local, (id, host_id), &page).unwrap());
        let content: String = viewer.db.query_row("SELECT content FROM messages WHERE id=?1", [id], |r| r.get(0)).unwrap();
        assert_eq!(content, whole);
        assert!(cut_copies(&viewer, &local).unwrap().is_empty());
    }

    #[test]
    fn the_repo_check_reads_git_output() {
        assert_eq!(repo_summary("git@github.com:orbit-labs/orbit.git\n", "feature\n", " M src/a.rs\n", Some("3\n"), true), json!({"repo": "orbit-labs/orbit", "branch": "feature", "ahead": 3, "dirty": true, "pushed": true}));
        assert_eq!(repo_summary("", "", "", None, false), json!({"repo": null, "branch": "", "ahead": 0, "dirty": false, "pushed": false}));
        assert_eq!(repo_summary("https://gitlab.com/a/b.git", "main", "", Some("x"), false)["repo"], Value::Null);
    }
}
