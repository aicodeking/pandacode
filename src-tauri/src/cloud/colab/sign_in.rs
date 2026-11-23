//! The one Google sign-in in progress: its attempt ID, cancel switch and latest status.
//!
//! Every `colab-sign-in` event carries the attempt's `id`, so the webview ignores events
//! of an attempt it already left, and `cloud_colab_sign_in_status` returns the current
//! attempt's last state when Settings reopens mid-sign-in. A finished sign-in is saved only
//! through [`commit`], which holds the same lock as [`cancel`]: a Cancel or Disconnect that
//! lands while tokens are being exchanged always wins, so nothing is saved after it.
use serde::Serialize;
use serde_json::Value;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex, MutexGuard,
};
use tokio::sync::watch;

type Result<T> = std::result::Result<T, String>;

pub(super) const CANCELLED: &str = "Sign-in was cancelled.";

#[derive(Clone, Copy, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SignInStarted {
    pub id: u64,
}

/// The current attempt's last event, without tokens.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SignInStatus {
    pub id: u64,
    pub state: &'static str,
    pub url: Option<String>,
    pub message: Option<String>,
}

struct Active {
    cancel: watch::Sender<bool>,
    status: SignInStatus,
}

static ACTIVE: Mutex<Option<Active>> = Mutex::new(None);
static NEXT: AtomicU64 = AtomicU64::new(1);

fn active() -> MutexGuard<'static, Option<Active>> {
    ACTIVE.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The event states, as `'static` names (anything unknown reads as `waiting`).
fn state_name(state: &str) -> &'static str {
    match state {
        "installing" => "installing",
        "exchanging" => "exchanging",
        "done" => "done",
        "failed" => "failed",
        "cancelled" => "cancelled",
        _ => "waiting",
    }
}

/// Start a new attempt, cancelling the one before it.
pub(super) fn begin() -> (u64, watch::Receiver<bool>) {
    let (sender, receiver) = watch::channel(false);
    let id = NEXT.fetch_add(1, Ordering::SeqCst);
    let status = SignInStatus { id, state: "waiting", url: None, message: None };
    if let Some(previous) = active().replace(Active { cancel: sender, status }) {
        let _ = previous.cancel.send(true);
    }
    (id, receiver)
}

/// `payload` with the attempt's `id`, remembered as the current status when it still is.
pub(super) fn tag(id: u64, mut payload: Value) -> Value {
    if let Some(object) = payload.as_object_mut() {
        object.insert("id".into(), id.into());
    }
    if let Some(current) = active().as_mut().filter(|current| current.status.id == id) {
        let text = |key: &str| payload[key].as_str().map(str::to_string);
        current.status = SignInStatus { id, state: state_name(payload["state"].as_str().unwrap_or_default()), url: text("url").or_else(|| current.status.url.clone()), message: text("message") };
    }
    payload
}

pub fn status() -> Option<SignInStatus> {
    active().as_ref().map(|current| current.status.clone())
}

/// Cancel the attempt in progress, if any; its ID stops being current at once.
pub fn cancel() {
    if let Some(current) = active().take() {
        let _ = current.cancel.send(true);
    }
}

/// True once the attempt was cancelled or replaced.
pub(super) fn is_stale(id: u64, cancel: &watch::Receiver<bool>) -> bool {
    *cancel.borrow() || active().as_ref().is_none_or(|current| current.status.id != id)
}

/// Run `save` only while attempt `id` is current and not cancelled, holding the lock that
/// [`cancel`] needs, so a cancel either lands first (nothing saved) or after the save.
pub(super) fn commit<T>(id: u64, cancel: &watch::Receiver<bool>, save: impl FnOnce() -> Result<T>) -> Result<T> {
    let guard = active();
    if *cancel.borrow() || guard.as_ref().is_none_or(|current| current.status.id != id) {
        return Err(CANCELLED.into());
    }
    let saved = save();
    drop(guard);
    saved
}

/// Forget attempt `id` once it ended, unless a newer one replaced it.
pub(super) fn finish(id: u64) {
    let mut guard = active();
    if guard.as_ref().is_some_and(|current| current.status.id == id) {
        *guard = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::cell::Cell;

    /// One test: the attempt state is process-wide.
    #[test]
    fn attempts_carry_ids_track_status_and_never_commit_after_a_cancel() {
        let (first, first_cancel) = begin();
        let tagged = tag(first, json!({"state": "waiting", "url": "https://accounts.google.com/x"}));
        assert_eq!(tagged["id"], first);
        assert_eq!(status(), Some(SignInStatus { id: first, state: "waiting", url: Some("https://accounts.google.com/x".into()), message: None }));
        tag(first, json!({"state": "exchanging"}));
        let now = status().unwrap();
        assert_eq!((now.state, now.url.as_deref()), ("exchanging", Some("https://accounts.google.com/x")), "the link stays while exchanging");
        assert_eq!(serde_json::to_value(&now).unwrap()["id"], first);

        // A second attempt cancels the first; the first can no longer save or set the status.
        let (second, second_cancel) = begin();
        assert!(second > first && *first_cancel.borrow());
        assert!(is_stale(first, &first_cancel) && !is_stale(second, &second_cancel));
        let saved = Cell::new(false);
        let save = || -> Result<()> {
            saved.set(true);
            Ok(())
        };
        assert_eq!(commit(first, &first_cancel, save).unwrap_err(), CANCELLED);
        assert!(!saved.get());
        tag(first, json!({"state": "failed", "message": "late"}));
        assert_eq!(status().unwrap().id, second);
        finish(first);
        assert_eq!(status().unwrap().id, second, "an old attempt never clears a newer one");

        // Cancel (also what Disconnect does) during the exchange: nothing is saved.
        tag(second, json!({"state": "exchanging"}));
        cancel();
        assert!(is_stale(second, &second_cancel) && status().is_none());
        assert!(commit(second, &second_cancel, save).is_err());
        assert!(!saved.get());

        // A current attempt commits.
        let (third, third_cancel) = begin();
        assert_eq!(commit(third, &third_cancel, || Ok(7)).unwrap(), 7);
        finish(third);
        assert!(status().is_none());
        assert_eq!(serde_json::to_value(SignInStarted { id: third }).unwrap(), json!({"id": third}));
    }
}
