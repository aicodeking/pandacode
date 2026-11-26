//! Every thread's tracked Colab runtimes: the in-memory state behind `colab-runtime`
//! events (operations in flight, Cloud Agent entries, dismissals, deleted threads).
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use super::{clean, dismissable, hardware_label, is_gone, ready_entry, reconcile_entry, ColabThreadRuntime, Info, Result, LIVE_STATES, MEMORY_CAP, OP_STATES, PENDING};
use super::store::Records;

/// One operation in flight on a runtime.
#[derive(Clone, Debug)]
struct Op {
    id: u64,
    state: String,
    activity: String,
    started_at: u64,
}

#[derive(Default)]
struct Inner {
    threads: HashMap<String, Vec<ColabThreadRuntime>>,
    /// Operations in flight per (session, endpoint), oldest first: the runtime shows the
    /// newest, the one before it when that ends, and is ready again after the last.
    ops: HashMap<(String, String), Vec<Op>>,
    next_op: u64,
    next_pending: u64,
    /// The last Cloud Agent entry shown per session, so its timestamps hold between lists.
    derived: HashMap<String, ColabThreadRuntime>,
    /// Cloud Agent entries the user dismissed: (session, id, state).
    dismissed: HashSet<(String, String, String)>,
    /// The last real name and hardware seen per endpoint, for once Colab's record is gone.
    known: HashMap<String, Info>,
    /// Saved (session, endpoint) associations already shown since launch: a removed entry
    /// is not brought back from the file.
    adopted: HashSet<(String, String)>,
    /// Deleted threads: nothing finishing late brings them back.
    forgotten: HashSet<String>,
}

impl Inner {
    fn gone(&self, session_id: &str) -> bool {
        self.forgotten.contains(session_id)
    }
    /// Keeps what `info` says about `endpoint`, field by field.
    fn remember(&mut self, endpoint: &str, info: &Info) {
        if endpoint.is_empty() || !info.is_real(endpoint) {
            return;
        }
        if self.known.len() >= MEMORY_CAP && !self.known.contains_key(endpoint) {
            self.known.clear();
        }
        let known = self.known.entry(endpoint.to_string()).or_default();
        if !info.name.is_empty() && info.name != endpoint {
            known.name = info.name.clone();
        }
        if !info.hardware.is_empty() {
            known.hardware = info.hardware.clone();
            known.high_mem = info.high_mem;
        }
        known.started_at = info.started_at.or(known.started_at);
    }
}

/// Every thread's tracked runtimes.
#[derive(Default)]
pub(crate) struct Tracker {
    inner: Mutex<Inner>,
}

impl Tracker {
    fn with<T>(&self, change: impl FnOnce(&mut Inner) -> T) -> T {
        change(&mut self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner()))
    }

    pub fn snapshot(&self, session_id: &str) -> Vec<ColabThreadRuntime> {
        self.with(|inner| inner.threads.get(session_id).cloned().unwrap_or_default())
    }

    /// What is known about `endpoint`: its record in `records`, else the last real name
    /// and hardware seen (a released runtime's record leaves `colab-sessions.json`).
    pub fn info_for(&self, endpoint: &str, records: &Records) -> Info {
        self.with(|inner| match records.get(endpoint) {
            Some(record) => {
                let info = Info::from_record(record);
                inner.remember(endpoint, &info);
                info
            }
            None => {
                let known = inner.known.get(endpoint).cloned().unwrap_or_default();
                Info { name: if known.name.is_empty() { endpoint.to_string() } else { known.name.clone() }, ..known }
            }
        })
    }

    /// Whether the thread was deleted.
    pub fn is_forgotten(&self, session_id: &str) -> bool {
        self.with(|inner| inner.gone(session_id))
    }

    /// A pending `creating` entry; its ID goes to `finish_create`.
    pub fn begin_create(&self, session_id: &str, name: &str, hardware: &str, high_mem: bool, now: u64) -> String {
        self.with(|inner| {
            inner.next_pending += 1;
            let id = format!("{PENDING}{}", inner.next_pending);
            if inner.gone(session_id) {
                return id;
            }
            let hardware = hardware_label(hardware);
            let entry = ColabThreadRuntime {
                id: id.clone(),
                endpoint: String::new(),
                name: if name.trim().is_empty() { "New runtime".into() } else { name.trim().to_string() },
                activity: Some(format!("Allocating {hardware}…")),
                hardware,
                high_mem,
                state: "creating".into(),
                browser_url: None,
                started_at: now,
                busy_since: Some(now),
                error: None,
            };
            inner.threads.entry(session_id.to_string()).or_default().push(entry);
            id
        })
    }

    /// The pending entry becomes the new runtime, ready, or an `error` entry.
    pub fn finish_create(&self, session_id: &str, pending_id: &str, outcome: std::result::Result<(&str, &Info), &str>, now: u64) {
        self.with(|inner| {
            if inner.gone(session_id) {
                return;
            }
            let mut learned = None;
            let list = inner.threads.entry(session_id.to_string()).or_default();
            let at = list.iter().position(|r| r.id == pending_id);
            match outcome {
                Ok((endpoint, info)) => {
                    let pending = at.map(|i| list.remove(i));
                    list.retain(|r| r.endpoint != endpoint);
                    let mut entry = ready_entry(endpoint, info, now);
                    entry.started_at = info.started_at.or(pending.as_ref().map(|p| p.started_at)).unwrap_or(now);
                    if let Some(pending) = &pending {
                        if info.name.is_empty() {
                            entry.name = pending.name.clone();
                        }
                        if info.hardware.is_empty() {
                            entry.hardware = pending.hardware.clone();
                            entry.high_mem = pending.high_mem;
                        }
                    }
                    if pending.is_some() || info.is_real(endpoint) {
                        learned = Some(Info::of(&entry));
                    }
                    let index = at.unwrap_or(list.len()).min(list.len());
                    list.insert(index, entry);
                }
                Err(error) => {
                    if let Some(entry) = at.and_then(|i| list.get_mut(i)) {
                        entry.state = "error".into();
                        entry.activity = None;
                        entry.busy_since = None;
                        entry.error = Some(clean(error));
                    }
                }
            }
            if let (Ok((endpoint, _)), Some(info)) = (outcome, learned) {
                inner.remember(endpoint, &info);
            }
        })
    }

    /// The runtime enters `state` (busy, restarting, stopping) doing `activity`; it is
    /// added to the thread when the thread had not used it before. The returned operation
    /// ID goes to `finish_busy`.
    pub fn begin_busy(&self, session_id: &str, endpoint: &str, info: &Info, state: &str, activity: &str, now: u64) -> u64 {
        self.with(|inner| {
            inner.next_op += 1;
            if inner.gone(session_id) {
                return inner.next_op;
            }
            inner.remember(endpoint, info);
            let op = Op { id: inner.next_op, state: state.into(), activity: activity.into(), started_at: now };
            inner.ops.entry((session_id.to_string(), endpoint.to_string())).or_default().push(op.clone());
            let list = inner.threads.entry(session_id.to_string()).or_default();
            let index = match list.iter().position(|r| r.endpoint == endpoint) {
                Some(index) => index,
                None => {
                    list.push(ready_entry(endpoint, info, now));
                    list.len() - 1
                }
            };
            show_op(&mut list[index], &op);
            list[index].error = None;
            op.id
        })
    }

    /// Operation `op` ended. The runtime shows the operation still running before it, or
    /// is ready once none is left; an error that says it is gone leaves it in `error`. A
    /// stopped or failed runtime stays so, an unknown (late) operation changes nothing, and
    /// an entry is never added.
    pub fn finish_busy(&self, session_id: &str, endpoint: &str, op: u64, outcome: std::result::Result<(), &str>) {
        self.with(|inner| {
            if inner.gone(session_id) {
                return;
            }
            let key = (session_id.to_string(), endpoint.to_string());
            let Some(ops) = inner.ops.get_mut(&key) else { return };
            let Some(at) = ops.iter().position(|o| o.id == op) else { return };
            ops.remove(at);
            let failed = outcome.err().filter(|error| is_gone(error));
            let current = if failed.is_some() { None } else { ops.last().cloned() };
            if current.is_none() {
                inner.ops.remove(&key);
            }
            let Some(entry) = inner.threads.get_mut(session_id).and_then(|list| list.iter_mut().find(|r| r.endpoint == endpoint)) else { return };
            if !OP_STATES.contains(&entry.state.as_str()) {
                return;
            }
            match (failed, current) {
                (Some(error), _) => {
                    entry.state = "error".into();
                    entry.error = Some(clean(error));
                    entry.activity = None;
                    entry.busy_since = None;
                }
                (None, Some(current)) => show_op(entry, &current),
                (None, None) => {
                    entry.state = "ready".into();
                    entry.activity = None;
                    entry.busy_since = None;
                }
            }
        })
    }

    /// Forgets everything about a deleted thread.
    pub fn forget(&self, session_id: &str) {
        self.with(|inner| {
            inner.threads.remove(session_id);
            inner.derived.remove(session_id);
            inner.ops.retain(|(sid, _), _| sid != session_id);
            inner.dismissed.retain(|(sid, _, _)| sid != session_id);
            inner.adopted.retain(|(sid, _)| sid != session_id);
            if inner.forgotten.len() >= MEMORY_CAP {
                inner.forgotten.clear();
            }
            inner.forgotten.insert(session_id.to_string());
        })
    }

    /// Shows the thread's saved runtimes (`saved`, from `colab-sessions.json`) that it does
    /// not track yet, once per launch: a runtime it dismissed or released stays gone.
    pub fn adopt_saved(&self, session_id: &str, saved: Vec<ColabThreadRuntime>) {
        self.with(|inner| {
            if inner.gone(session_id) {
                return;
            }
            for runtime in saved {
                if runtime.endpoint.is_empty() || !inner.adopted.insert((session_id.to_string(), runtime.endpoint.clone())) {
                    continue;
                }
                inner.remember(&runtime.endpoint, &Info::of(&runtime));
                let list = inner.threads.entry(session_id.to_string()).or_default();
                if !list.iter().any(|r| r.id == runtime.id) {
                    list.push(runtime);
                }
            }
        })
    }

    /// Sets a runtime's state outright, adding it to the thread if needed.
    #[cfg(test)]
    pub fn set_state(&self, session_id: &str, endpoint: &str, info: &Info, (state, activity, error): (&str, Option<&str>, Option<&str>), now: u64) {
        self.with(|inner| {
            let list = inner.threads.entry(session_id.to_string()).or_default();
            if !list.iter().any(|r| r.endpoint == endpoint) {
                list.push(ready_entry(endpoint, info, now));
            }
            let entry = list.iter_mut().find(|r| r.endpoint == endpoint).expect("just added");
            entry.busy_since = super::BUSY_STATES.contains(&state).then(|| entry.busy_since.filter(|_| entry.state == state).unwrap_or(now));
            entry.state = state.into();
            entry.activity = activity.map(str::to_string);
            entry.error = error.map(clean);
            if !super::BUSY_STATES.contains(&state) {
                inner.ops.remove(&(session_id.to_string(), endpoint.to_string()));
            }
        })
    }

    /// Takes an entry (by ID or endpoint) off one thread.
    #[cfg(test)]
    pub fn remove(&self, session_id: &str, key: &str) {
        self.with(|inner| {
            if let Some(list) = inner.threads.get_mut(session_id) {
                list.retain(|r| r.id != key && (r.endpoint.is_empty() || r.endpoint != key));
            }
            inner.ops.retain(|(sid, endpoint), _| sid != session_id || endpoint != key);
        })
    }

    /// A released runtime leaves every thread; the threads that showed it are returned.
    pub fn release(&self, endpoint: &str) -> Vec<String> {
        self.with(|inner| {
            let mut touched = Vec::new();
            for (sid, list) in inner.threads.iter_mut() {
                let before = list.len();
                list.retain(|r| r.endpoint != endpoint);
                if list.len() != before {
                    touched.push(sid.clone());
                }
            }
            inner.ops.retain(|(_, key), _| key != endpoint);
            touched.sort();
            touched
        })
    }

    /// Adds (or replaces) a whole entry, as a refresh does for a vanished cloud runtime.
    pub(super) fn adopt(&self, session_id: &str, runtime: ColabThreadRuntime) {
        self.with(|inner| {
            if inner.gone(session_id) {
                return;
            }
            let list = inner.threads.entry(session_id.to_string()).or_default();
            list.retain(|r| r.id != runtime.id);
            list.push(runtime);
        })
    }

    /// Folds Colab's live list (asked for at `fetched_at`) into one thread's tracked entries.
    pub fn reconcile(&self, session_id: &str, live: &Records, fetched_at: u64) {
        self.with(|inner| {
            if inner.gone(session_id) {
                return;
            }
            for (endpoint, record) in live {
                inner.remember(endpoint, &Info::from_record(record));
            }
            let Some(list) = inner.threads.get_mut(session_id) else { return };
            for runtime in list.iter_mut() {
                if reconcile_entry(runtime, live, fetched_at) && runtime.state == "stopped" {
                    inner.ops.remove(&(session_id.to_string(), runtime.endpoint.clone()));
                }
            }
        })
    }

    /// The thread's list: tracked entries plus its Cloud Agent runtime, unless dismissed or
    /// already tracked. A tracked entry that is merely `ready` yields to the agent's own
    /// state (creating, running), which says more.
    pub fn merge(&self, session_id: &str, derived: Option<ColabThreadRuntime>, now: u64) -> Vec<ColabThreadRuntime> {
        self.with(|inner| {
            if inner.gone(session_id) {
                return Vec::new();
            }
            let mut list = inner.threads.get(session_id).cloned().unwrap_or_default();
            let Some(mut derived) = derived else {
                // No agent runtime to hide any more: a later one (say a retried create)
                // shows whatever state it is in.
                inner.derived.remove(session_id);
                inner.dismissed.retain(|(sid, _, _)| sid != session_id);
                return list;
            };
            if let Some(previous) = inner.derived.get(session_id).filter(|p| p.id == derived.id) {
                derived.started_at = previous.started_at.min(derived.started_at);
                if previous.state == derived.state && previous.activity == derived.activity {
                    derived.busy_since = previous.busy_since.or(derived.busy_since);
                }
            }
            derived.busy_since = derived.busy_since.map(|since| since.min(now));
            inner.derived.insert(session_id.to_string(), derived.clone());
            // A dismissal holds only while the agent's runtime still reads the same: once it
            // moves on (a new run, a new runtime), a later error shows again.
            inner.dismissed.retain(|(sid, id, state)| sid != session_id || (*id == derived.id && *state == derived.state));
            if inner.dismissed.contains(&(session_id.to_string(), derived.id.clone(), derived.state.clone())) {
                return list;
            }
            match list.iter().position(|r| r.id == derived.id) {
                // An idle tracked entry yields to the agent's state, and a stale stopped or
                // failed one to an agent working on the runtime again.
                Some(i) if (list[i].state == "ready" && derived.state != "ready") || (matches!(list[i].state.as_str(), "stopped" | "error") && LIVE_STATES.contains(&derived.state.as_str())) => {
                    let tracked = &list[i];
                    derived.name = tracked.name.clone();
                    derived.hardware = tracked.hardware.clone();
                    derived.high_mem = tracked.high_mem;
                    list[i] = derived;
                }
                Some(_) => {}
                None => list.push(derived),
            }
            list
        })
    }

    /// Dismisses a stopped, failed or pending entry of `shown` (the thread's merged list).
    pub fn dismiss(&self, session_id: &str, key: &str, shown: &[ColabThreadRuntime]) -> Result<()> {
        let entry = shown.iter().find(|r| r.id == key || (!r.endpoint.is_empty() && r.endpoint == key)).ok_or("That runtime is not shown in this thread.")?;
        if !dismissable(entry) {
            return Err("Only a stopped or failed runtime can be dismissed; stop it instead.".into());
        }
        self.with(|inner| {
            let list = inner.threads.entry(session_id.to_string()).or_default();
            let before = list.len();
            list.retain(|r| r.id != entry.id);
            let removed = list.len() != before;
            // The agent's own runtime would come back from its task's state on the next list,
            // so its dismissal is recorded against the state that task shows.
            let state = match inner.derived.get(session_id).filter(|derived| derived.id == entry.id) {
                Some(derived) => Some(derived.state.clone()),
                None => (!removed).then(|| entry.state.clone()),
            };
            if let Some(state) = state {
                inner.dismissed.insert((session_id.to_string(), entry.id.clone(), state));
            }
        });
        Ok(())
    }
}

/// Shows operation `op` on the entry.
fn show_op(entry: &mut ColabThreadRuntime, op: &Op) {
    entry.state = op.state.clone();
    entry.activity = Some(op.activity.clone());
    entry.busy_since = Some(op.started_at);
}
