//! Signed, loopback-only event triggers. Acceptance is recorded before delivery so
//! retries cannot start the same turn twice, even when launching the agent fails.

use super::channels::http::{self, Response};
use crate::{storage::Store, AppState, Result};
use hmac::{Hmac, Mac};
use rusqlite::params;
use serde::Serialize;
use serde_json::json;
use tauri::{Emitter, Manager, State};

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Webhook {
    pub id: String,
    pub bot_id: String,
    pub title: String,
    pub prompt: String,
    pub enabled: bool,
    pub last_timestamp: i64,
    pub created_at: String,
}

#[cfg(test)]
pub(crate) fn secret_key(id: &str) -> String {
    format!("{id}:signing_secret")
}

const COLUMNS: &str = "id,bot_id,title,prompt,enabled,last_timestamp,created_at";
fn row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Webhook> {
    Ok(Webhook { id: r.get(0)?, bot_id: r.get(1)?, title: r.get(2)?, prompt: r.get(3)?, enabled: r.get(4)?, last_timestamp: r.get(5)?, created_at: r.get(6)? })
}

pub(crate) fn list(store: &Store, bot_id: &str) -> Result<Vec<Webhook>> {
    let mut statement = store.db.prepare(&format!("SELECT {COLUMNS} FROM bot_webhooks WHERE bot_id=?1 ORDER BY rowid")).map_err(|e| e.to_string())?;
    let rows = statement.query_map([bot_id], row).map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<_>>().map_err(|e| e.to_string())
}

pub(crate) fn create(store: &Store, bot_id: &str, title: &str, prompt: &str) -> Result<Webhook> {
    super::get(store, bot_id)?;
    let prompt: String = prompt.trim().chars().take(8000).collect();
    if prompt.is_empty() { return Err("A webhook needs a prompt: what should the bot do?".into()); }
    let count: i64 = store.db.query_row("SELECT COUNT(*) FROM bot_webhooks WHERE bot_id=?1", [bot_id], |r| r.get(0)).map_err(|e| e.to_string())?;
    if count >= 50 { return Err("A bot can have up to 50 webhooks.".into()); }
    let id = crate::storage::id();
    let title: String = title.trim().chars().take(120).collect();
    let title = if title.is_empty() { prompt.chars().take(60).collect() } else { title };
    let secret = super::channels::web::new_token();
    super::secrets::set(&id, "signing_secret", &secret)?;
    if let Err(error) = store.db.execute("INSERT INTO bot_webhooks(id,bot_id,title,prompt,created_at) VALUES(?1,?2,?3,?4,?5)", params![id, bot_id, title, prompt, chrono::Utc::now().to_rfc3339()]) {
        super::secrets::remove(&id, "signing_secret");
        return Err(error.to_string());
    }
    get(store, &id).ok_or_else(|| "Could not read the new webhook.".into())
}

pub(crate) fn get(store: &Store, id: &str) -> Option<Webhook> {
    store.db.query_row(&format!("SELECT {COLUMNS} FROM bot_webhooks WHERE id=?1"), [id], row).ok()
}

pub(crate) fn set_enabled(store: &Store, id: &str, enabled: bool) -> Result<Webhook> {
    store.db.execute("UPDATE bot_webhooks SET enabled=?2 WHERE id=?1", params![id, enabled]).map_err(|e| e.to_string())?;
    get(store, id).ok_or_else(|| "This webhook no longer exists.".into())
}

pub(crate) fn delete(store: &Store, id: &str) -> Result<()> {
    store.db.execute("DELETE FROM bot_webhooks WHERE id=?1", [id]).map_err(|e| e.to_string())?;
    super::secrets::remove(id, "signing_secret");
    Ok(())
}

pub(crate) fn rotate_secret(store: &Store, id: &str) -> Result<String> {
    get(store, id).ok_or("This webhook no longer exists.")?;
    let secret = super::channels::web::new_token();
    super::secrets::set(id, "signing_secret", &secret)?;
    Ok(secret)
}

fn signature(secret: &str, timestamp: &str, body: &str) -> Result<String> {
    let mut mac = Hmac::<sha2::Sha256>::new_from_slice(secret.as_bytes()).map_err(|e| e.to_string())?;
    mac.update(format!("{timestamp}.{body}").as_bytes());
    let hex: String = mac.finalize().into_bytes().iter().map(|b| format!("{b:02x}")).collect();
    Ok(format!("sha256={hex}"))
}

pub(crate) fn verify(secret: &str, timestamp: &str, body: &str, signature_header: Option<&str>, now: i64) -> bool {
    if timestamp.is_empty() || !timestamp.bytes().all(|b| b.is_ascii_digit()) { return false; }
    let Ok(at) = timestamp.parse::<i64>() else { return false };
    if at.abs_diff(now) > 300 { return false; }
    let (Some(given), Ok(expected)) = (signature_header, signature(secret, timestamp, body)) else { return false };
    http::same(&expected, given)
}

pub(crate) fn parse_event(body: &str) -> Option<String> {
    let payload: serde_json::Value = serde_json::from_str(body).unwrap_or_default();
    let text = payload["text"].as_str().unwrap_or(body).trim();
    (!text.is_empty()).then(|| text.to_owned())
}

pub(crate) fn route(
    app: &tauri::AppHandle<impl tauri::Runtime>, store: &Store, id: &str,
    timestamp_header: Option<&str>, signature_header: Option<&str>, body: &str, now: i64,
) -> Response {
    let error = |status, message| Response::json(status, &json!({"error": message}));
    let Some(webhook) = get(store, id) else { return error(404, "Webhook not found.") };
    if !webhook.enabled { return error(403, "This webhook is disabled."); }
    let timestamp = timestamp_header.unwrap_or_default();
    let secret = super::secrets::get(id, "signing_secret").unwrap_or_default();
    if secret.is_empty() || !verify(&secret, timestamp, body, signature_header, now) {
        return error(401, "Invalid or stale signature.");
    }
    let at = timestamp.parse::<i64>().unwrap_or_default();
    if at <= webhook.last_timestamp { return error(401, "Replayed timestamp."); }
    let Some(text) = parse_event(body) else { return error(400, "Send some event text.") };
    match store.db.execute("UPDATE bot_webhooks SET last_timestamp=?2 WHERE id=?1 AND enabled=1 AND last_timestamp<?2", params![id, at]) {
        Ok(1) => {}
        // The 0-row arm also covers a webhook disabled between the checks above and
        // this update: give it the disabled answer rather than the replay one.
        Ok(_) if !get(store, id).is_some_and(|hook| hook.enabled) => return error(403, "This webhook is disabled."),
        Ok(_) => return error(401, "Replayed timestamp."),
        Err(_) => return error(500, "Could not accept this event."),
    }
    if let Err(error) = deliver(app, store, &webhook, &text) {
        let _ = super::log(store, &webhook.bot_id, "error", &format!("Webhook could not start: {error}"), json!({"webhookId": id}));
        eprintln!("Webhook {id} could not start: {error}");
    }
    Response::json(202, &json!({"ok": true}))
}

fn deliver(app: &tauri::AppHandle<impl tauri::Runtime>, store: &Store, webhook: &Webhook, text: &str) -> Result<()> {
    // Agent launching uses the desktop runtime. A mock handle has no launch services.
    let app = (app as &dyn std::any::Any).downcast_ref::<tauri::AppHandle>().ok_or("Agent runtime is unavailable.")?;
    let text = text.trim().chars().take(super::gateway::MAX_INBOUND).collect::<String>();
    app.try_state::<AppState>().ok_or("App state is unavailable.")?;
    let bot = super::get(store, &webhook.bot_id)?;
    if bot.paused { return Err("This bot is paused.".into()); }
    let channel = format!("webhook-{}", webhook.id);
    let (session, _) = super::thread_session(store, &bot, &channel, &channel, &format!("{} · {}", bot.name, webhook.title))?;
    let turn = super::gateway::compose(app, store, &bot, &session, "schedule", "", &format!("{}\n\nEvent:\n{text}", webhook.prompt))?;
    super::log(store, &bot.id, "webhook", &webhook.title, json!({"webhookId": webhook.id, "sessionId": session}))?;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = super::gateway::start_or_queue(&app, &bot, &session, turn, None, "webhook", true).await {
            super::note(&app, &bot.id, "error", &format!("Webhook could not start: {error}"), json!({"sessionId": session}));
        }
        let _ = app.emit("bots-changed", ());
        let _ = app.emit("sessions-changed", ());
    });
    Ok(())
}

pub(crate) fn start(app: &tauri::AppHandle) {
    let enabled = app.state::<AppState>().store.lock().ok().is_some_and(|store| store.db.query_row("SELECT EXISTS(SELECT 1 FROM bot_webhooks WHERE enabled=1)", [], |r| r.get::<_, bool>(0)).unwrap_or(false));
    if enabled { http::ensure_server(app.clone()); }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebhookList { webhooks: Vec<Webhook>, server_port: u16 }

#[derive(Serialize)]
pub struct TestResult { status: u16, #[serde(skip_serializing_if = "Option::is_none")] error: Option<String> }

#[tauri::command]
pub async fn bot_webhook_create(app: tauri::AppHandle, state: State<'_, AppState>, bot_id: String, title: String, prompt: String) -> Result<Webhook> {
    let webhook = create(&*state.store.lock().map_err(|e| e.to_string())?, &bot_id, &title, &prompt)?;
    http::ensure_server(app.clone());
    let _ = app.emit("bots-changed", ());
    Ok(webhook)
}

#[tauri::command]
pub async fn bot_webhook_list(app: tauri::AppHandle, state: State<'_, AppState>, bot_id: String) -> Result<WebhookList> {
    let webhooks = list(&*state.store.lock().map_err(|e| e.to_string())?, &bot_id)?;
    // Read-only: report the shared server's port without starting it. Only create,
    // enable and boot start the listener, so a fresh install with no webhooks has none.
    let server_port = if webhooks.iter().any(|hook| hook.enabled) { http::ensure_server(app) } else { http::port() };
    Ok(WebhookList { webhooks, server_port })
}

#[tauri::command]
pub async fn bot_webhook_set_enabled(app: tauri::AppHandle, state: State<'_, AppState>, id: String, enabled: bool) -> Result<Webhook> {
    let webhook = set_enabled(&*state.store.lock().map_err(|e| e.to_string())?, &id, enabled)?;
    if enabled { http::ensure_server(app.clone()); }
    let _ = app.emit("bots-changed", ());
    Ok(webhook)
}

#[tauri::command]
pub async fn bot_webhook_delete(app: tauri::AppHandle, state: State<'_, AppState>, id: String) -> Result<()> {
    delete(&*state.store.lock().map_err(|e| e.to_string())?, &id)?;
    let _ = app.emit("bots-changed", ());
    Ok(())
}

#[tauri::command]
pub async fn bot_webhook_rotate_secret(state: State<'_, AppState>, id: String) -> Result<String> {
    rotate_secret(&*state.store.lock().map_err(|e| e.to_string())?, &id)
}

#[tauri::command]
pub async fn bot_webhook_test(app: tauri::AppHandle, state: State<'_, AppState>, id: String) -> Result<TestResult> {
    {
        let store = state.store.lock().map_err(|e| e.to_string())?;
        get(&store, &id).ok_or("This webhook no longer exists.")?;
    }
    http::ensure_server(app);
    let port = http::port();
    if port == 0 { return Err("Could not start the local webhook server.".into()); }
    let secret = super::secrets::get(&id, "signing_secret").ok_or("The signing secret is missing. Rotate it and try again.")?;
    let timestamp = (crate::storage::now() / 1000).to_string();
    let body = r#"{"text":"Test event from PandaCode."}"#;
    let signature = signature(&secret, &timestamp, body)?;
    let client = reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none()).timeout(std::time::Duration::from_secs(40)).user_agent(concat!("PandaCode/", env!("CARGO_PKG_VERSION"))).build().map_err(|e| e.to_string())?;
    let response = client.post(format!("http://127.0.0.1:{port}/hook/{id}")).header("X-PandaCode-Timestamp", timestamp).header("X-PandaCode-Signature", signature).header("Content-Type", "application/json").body(body).send().await.map_err(|e| e.to_string())?;
    let status = response.status().as_u16();
    let error = if status == 202 {
        None
    } else {
        let raw = response.text().await.map_err(|e| e.to_string())?;
        // The route answers with {"error": "..."}: surface the message, not the JSON.
        Some(serde_json::from_str::<serde_json::Value>(&raw).ok().and_then(|body| body["error"].as_str().map(str::to_owned)).unwrap_or(raw))
    };
    Ok(TestResult { status, error })
}

#[cfg(test)]
mod tests {
    #[test]
    fn webhook_test_signature_matches_the_wire_contract() {
        let body = r#"{"text":"Test event from PandaCode."}"#;
        let signed = super::signature("secret", "1700000000", body).unwrap();
        assert_eq!(signed, "sha256=430277e905b1443101f298bbbfc422c5e09692057780a6f2fe664404977b0963");
        assert!(super::verify("secret", "1700000000", body, Some(&signed), 1700000000));
    }
}
