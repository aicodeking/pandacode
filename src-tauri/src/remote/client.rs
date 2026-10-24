//! Calls from this computer to a task host on another computer.
use super::{remote, socket};
use crate::Result;
use serde_json::{json, Value};
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(20);
const MAX_PARAMS: usize = 110 * 1024;

pub(crate) async fn call(app: &tauri::AppHandle, device_id: &str, method: &str, params: Value) -> Result<Value> {
    call_within(app, device_id, method, params, TIMEOUT).await
}

pub(crate) async fn call_within(app: &tauri::AppHandle, device_id: &str, method: &str, params: Value, timeout: Duration) -> Result<Value> {
    if !super::host::METHODS.contains(&method) {
        return Err("Unknown remote method.".into());
    }
    if params.to_string().len() > MAX_PARAMS {
        return Err("That request is too large.".into());
    }
    let id = uuid::Uuid::new_v4().to_string();
    let (reply, answer) = tokio::sync::oneshot::channel();
    {
        let state = remote(app);
        let mut inner = state.lock();
        if inner.token.is_none() {
            return Err("Sign in to PandaCode Connect first.".into());
        }
        if device_id == inner.settings.device_id {
            return Err("That is this computer.".into());
        }
        inner.callable(device_id)?;
        inner.pending.insert(id.clone(), (device_id.to_owned(), reply));
    }
    let forget = || remote(app).lock().pending.remove(&id);
    // Sealing adds `ts` and a fresh `nonce`, so the host can refuse replays.
    let request = json!({"type": "req", "id": id, "method": method, "params": params});
    if let Err(error) = socket::send_to_device(app, device_id, &request) {
        forget();
        return Err(error);
    }
    match tokio::time::timeout(timeout, answer).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("The connection to the relay was lost.".into()),
        Err(_) => {
            forget();
            Err("That computer did not answer in time.".into())
        }
    }
}

/// Settles a pending call with a host's response; only the device it was sent to may answer.
pub(crate) fn resolve(app: &tauri::AppHandle, from: &str, message: &Value) {
    let Some(id) = message["id"].as_str() else { return };
    let state = remote(app);
    let mut inner = state.lock();
    if inner.pending.get(id).is_none_or(|(device, _)| device != from) {
        return;
    }
    let Some((_, reply)) = inner.pending.remove(id) else { return };
    let result = if message["ok"].as_bool() == Some(true) {
        Ok(message["result"].clone())
    } else {
        Err(message["error"].as_str().unwrap_or("The other computer refused the request.").chars().take(1000).collect())
    };
    let _ = reply.send(result);
}
