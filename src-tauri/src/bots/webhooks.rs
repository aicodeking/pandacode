//! Signed, loopback-only event triggers. Acceptance is recorded before delivery so
//! retries cannot start the same turn twice, even when launching the agent fails.
//!
//! A webhook accepts an event when every method it requires passes: an HMAC signature, an
//! API token, or a source IP inside its allowlist. At least one must be required, so a URL
//! alone never starts work.

use super::channels::http::{self, Response};
use crate::{storage::Store, AppState, Result};
use hmac::{Hmac, Mac};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
use std::net::IpAddr;
use tauri::{Emitter, Manager, State};

/// The refusal when a webhook would accept any caller that finds its URL.
pub(crate) const NEEDS_METHOD: &str = "A webhook needs a signing secret, an API token or an IP allowlist, so anyone who finds the URL cannot start work.";

/// Accepted events allowed per webhook per minute.
const EVENTS_PER_MINUTE: usize = 60;
/// How far a signature timestamp may sit from now, in either direction.
const FRESHNESS_SECONDS: i64 = 300;
const MAX_RANGES: usize = 64;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Webhook {
    pub id: String,
    pub bot_id: String,
    pub title: String,
    pub prompt: String,
    pub enabled: bool,
    pub last_timestamp: i64,
    pub require_signature: bool,
    pub require_token: bool,
    /// Exact addresses or CIDR ranges; empty allows any address. Never a secret.
    pub allowed_ips: Vec<String>,
    pub trust_forwarded: bool,
    pub allow_public_host: bool,
    /// The last delivery id accepted, so a retrying sender does not run twice.
    pub last_delivery: Option<String>,
    pub created_at: String,
}

/// Settings a caller may change after creation. Only the keys present are applied.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct WebhookSettings {
    pub require_signature: Option<bool>,
    pub require_token: Option<bool>,
    pub allowed_ips: Option<Vec<String>>,
    pub trust_forwarded: Option<bool>,
    pub allow_public_host: Option<bool>,
}

#[cfg(test)]
pub(crate) fn secret_key(id: &str) -> String {
    format!("{id}:signing_secret")
}

const COLUMNS: &str = "id,bot_id,title,prompt,enabled,last_timestamp,require_signature,require_token,allowed_ips,trust_forwarded,allow_public_host,last_delivery,created_at";
fn row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Webhook> {
    let allowed: String = r.get(8)?;
    let last_delivery: String = r.get(11)?;
    Ok(Webhook {
        id: r.get(0)?,
        bot_id: r.get(1)?,
        title: r.get(2)?,
        prompt: r.get(3)?,
        enabled: r.get(4)?,
        last_timestamp: r.get(5)?,
        require_signature: r.get(6)?,
        require_token: r.get(7)?,
        allowed_ips: serde_json::from_str(&allowed).unwrap_or_default(),
        trust_forwarded: r.get(9)?,
        allow_public_host: r.get(10)?,
        last_delivery: (!last_delivery.is_empty()).then_some(last_delivery),
        created_at: r.get(12)?,
    })
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

/// Applies the settings present in `settings`, then refuses a webhook with no method left.
pub(crate) fn update(store: &Store, id: &str, settings: &WebhookSettings) -> Result<Webhook> {
    let current = get(store, id).ok_or("This webhook no longer exists.")?;
    let require_signature = settings.require_signature.unwrap_or(current.require_signature);
    let require_token = settings.require_token.unwrap_or(current.require_token);
    let trust_forwarded = settings.trust_forwarded.unwrap_or(current.trust_forwarded);
    let allow_public_host = settings.allow_public_host.unwrap_or(current.allow_public_host);
    let allowed_ips = match &settings.allowed_ips {
        Some(list) => normalize_ips(list)?,
        None => current.allowed_ips.clone(),
    };
    if !require_signature && !require_token && allowed_ips.is_empty() {
        return Err(NEEDS_METHOD.into());
    }
    store
        .db
        .execute(
            "UPDATE bot_webhooks SET require_signature=?2,require_token=?3,allowed_ips=?4,trust_forwarded=?5,allow_public_host=?6 WHERE id=?1",
            params![id, require_signature, require_token, json!(allowed_ips).to_string(), trust_forwarded, allow_public_host],
        )
        .map_err(|e| e.to_string())?;
    get(store, id).ok_or_else(|| "This webhook no longer exists.".into())
}

/// Trims, validates and de-duplicates an allowlist, keeping the caller's order.
fn normalize_ips(list: &[String]) -> Result<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    for entry in list {
        let trimmed = entry.trim();
        if trimmed.is_empty() { continue; }
        parse_range(trimmed)?;
        if !out.iter().any(|kept| kept == trimmed) {
            out.push(trimmed.to_owned());
        }
    }
    if out.len() > MAX_RANGES {
        return Err(format!("A webhook can allow up to {MAX_RANGES} addresses or ranges."));
    }
    Ok(out)
}

/// Accepts `10.0.0.1`, `10.0.0.0/8`, `::1` and `2001:db8::/32`, returning the address and prefix.
pub(crate) fn parse_range(text: &str) -> Result<(IpAddr, u8)> {
    let invalid = || format!("{text} is not a valid IP address or range.");
    let (address, prefix) = match text.split_once('/') {
        Some((address, prefix)) => (address.trim(), Some(prefix.trim())),
        None => (text.trim(), None),
    };
    let address: IpAddr = address.parse().map_err(|_| invalid())?;
    let max = if address.is_ipv4() { 32 } else { 128 };
    let prefix = match prefix {
        Some(prefix) => prefix.parse::<u8>().ok().filter(|value| *value <= max).ok_or_else(invalid)?,
        None => max,
    };
    Ok((address, prefix))
}

/// True when `address` sits inside the entry's network.
fn in_range(entry: (IpAddr, u8), address: IpAddr) -> bool {
    let prefix = u32::from(entry.1);
    match (entry.0, address) {
        (IpAddr::V4(net), IpAddr::V4(given)) => prefix == 0 || (u32::from(net) ^ u32::from(given)) >> (32 - prefix) == 0,
        (IpAddr::V6(net), IpAddr::V6(given)) => prefix == 0 || (u128::from(net) ^ u128::from(given)) >> (128 - prefix) == 0,
        _ => false,
    }
}

/// The source address to judge against the allowlist. A forwarded address is only trusted
/// when the owner says a proxy they control sits in front of this computer; otherwise a
/// caller could name any address it likes.
pub(crate) fn client_ip(trust_forwarded: bool, forwarded_for: Option<&str>, connecting_ip: Option<&str>, peer: Option<IpAddr>) -> Option<IpAddr> {
    if trust_forwarded {
        let forwarded = forwarded_for.and_then(|value| value.split(',').next()).map(str::trim).filter(|value| !value.is_empty());
        let named = forwarded.or_else(|| connecting_ip.map(str::trim).filter(|value| !value.is_empty()));
        if let Some(named) = named.and_then(|value| value.parse::<IpAddr>().ok()) {
            return Some(named);
        }
    }
    peer
}

fn allowlisted(allowed: &[String], address: Option<IpAddr>) -> bool {
    if allowed.is_empty() { return true; }
    // An allowlist that cannot name the caller fails closed.
    let Some(address) = address else { return false };
    allowed.iter().filter_map(|entry| parse_range(entry).ok()).any(|entry| in_range(entry, address))
}

/// The token a caller presented, from any of the three headers services usually send.
pub(crate) fn token_from(headers: &HashMap<String, String>) -> Option<String> {
    let bearer = headers.get("authorization").and_then(|value| value.strip_prefix("Bearer ")).map(str::trim);
    let api_key = headers.get("x-api-key").map(String::as_str);
    let own = headers.get("x-pandacode-token").map(String::as_str);
    bearer.or(api_key).or(own).filter(|value| !value.is_empty()).map(str::to_owned)
}

fn hex_hmac(secret: &str, message: &str) -> Result<String> {
    let mut mac = Hmac::<sha2::Sha256>::new_from_slice(secret.as_bytes()).map_err(|e| e.to_string())?;
    mac.update(message.as_bytes());
    Ok(mac.finalize().into_bytes().iter().map(|b| format!("{b:02x}")).collect())
}

fn signature(secret: &str, timestamp: &str, body: &str) -> Result<String> {
    Ok(format!("sha256={}", hex_hmac(secret, &format!("{timestamp}.{body}"))?))
}

fn fresh(timestamp: &str, now: i64) -> bool {
    if timestamp.is_empty() || !timestamp.bytes().all(|b| b.is_ascii_digit()) { return false; }
    timestamp.parse::<i64>().is_ok_and(|at| at.abs_diff(now) <= FRESHNESS_SECONDS as u64)
}

/// Reads `t=<seconds>,v1=<hex>`, ignoring whitespace and any other key such as a `v0=`.
fn stripe_header(header: &str) -> Option<(String, String)> {
    let (mut timestamp, mut digest) = (None, None);
    for part in header.split(',') {
        let Some((key, value)) = part.split_once('=') else { continue };
        match key.trim() {
            "t" if timestamp.is_none() => timestamp = Some(value.trim().to_owned()),
            "v1" if digest.is_none() => digest = Some(value.trim().to_owned()),
            _ => {}
        }
    }
    Some((timestamp?, digest?))
}

/// Checks either wire form and returns the timestamp that was signed, when one was.
///
/// * `t=<seconds>,v1=<hex>` in the signature header, HMAC-SHA256 over `<t>.<body>` — the
///   convention hosted services send their deliveries with.
/// * the older `sha256=<hex>` in the signature header with the timestamp in its own header.
pub(crate) fn signed_at(secret: &str, timestamp_header: Option<&str>, signature_header: Option<&str>, body: &str, now: i64) -> Option<i64> {
    let header = signature_header?;
    if let Some((timestamp, digest)) = stripe_header(header) {
        if !fresh(&timestamp, now) { return None; }
        let expected = hex_hmac(secret, &format!("{timestamp}.{body}")).ok()?;
        if !http::same(&expected, &digest) { return None; }
        return timestamp.parse::<i64>().ok();
    }
    let given = header.strip_prefix("sha256=")?;
    let timestamp = timestamp_header?;
    if !fresh(timestamp, now) { return None; }
    let expected = hex_hmac(secret, &format!("{timestamp}.{body}")).ok()?;
    if !http::same(&expected, given) { return None; }
    timestamp.parse::<i64>().ok()
}

/// The older signature check, kept as the shape the wire-contract tests assert.
#[cfg(test)]
pub(crate) fn verify(secret: &str, timestamp: &str, body: &str, signature_header: Option<&str>, now: i64) -> bool {
    signed_at(secret, Some(timestamp), signature_header, body, now).is_some()
}

pub(crate) fn parse_event(body: &str) -> Option<String> {
    let payload: serde_json::Value = serde_json::from_str(body).unwrap_or_default();
    for pointer in ["/text", "/message", "/prompt", "/run/prompt", "/run/systemPrompt", "/subject", "/title"] {
        // The first field that carries a string decides the event, even when it is blank:
        // a caller that sent an empty `text` meant nothing, rather than a raw-body event.
        if let Some(value) = payload.pointer(pointer).and_then(|value| value.as_str()) {
            let text = value.trim();
            return (!text.is_empty()).then(|| text.to_owned());
        }
    }
    let text = body.trim();
    (!text.is_empty()).then(|| text.to_owned())
}

/// Accepted events per webhook in the last minute.
fn allow_event(id: &str) -> bool {
    static EVENTS: std::sync::OnceLock<std::sync::Mutex<HashMap<String, Vec<i64>>>> = std::sync::OnceLock::new();
    let Ok(mut map) = EVENTS.get_or_init(Default::default).lock() else { return false };
    let now = crate::storage::now();
    let times = map.entry(id.to_owned()).or_default();
    times.retain(|at| now - *at <= 60_000);
    if times.len() >= EVENTS_PER_MINUTE { return false; }
    times.push(now);
    true
}

/// Everything one delivery presents, so the route keeps a short argument list.
#[derive(Debug, Clone, Default)]
pub struct Auth<'a> {
    pub timestamp: Option<&'a str>,
    pub signature: Option<&'a str>,
    pub token: Option<String>,
    pub peer: Option<IpAddr>,
    pub forwarded_for: Option<&'a str>,
    pub connecting_ip: Option<&'a str>,
    pub loopback_host: bool,
    pub delivery: Option<&'a str>,
    pub body: &'a str,
    pub now: i64,
}

/// The legacy loopback request shape, kept for the tests that pin it.
#[cfg(test)]
pub(crate) fn route(
    app: &tauri::AppHandle<impl tauri::Runtime>, store: &Store, id: &str,
    timestamp_header: Option<&str>, signature_header: Option<&str>, body: &str, now: i64,
) -> Response {
    route_with(app, store, id, &Auth { timestamp: timestamp_header, signature: signature_header, loopback_host: true, body, now, ..Default::default() })
}

pub(crate) fn route_with(app: &tauri::AppHandle<impl tauri::Runtime>, store: &Store, id: &str, auth: &Auth<'_>) -> Response {
    let error = |status, message| Response::json(status, &json!({"error": message}));
    let Some(webhook) = get(store, id) else { return error(404, "Webhook not found.") };
    if !webhook.enabled { return error(403, "This webhook is disabled."); }
    if !webhook.allow_public_host && !auth.loopback_host { return error(403, "A loopback Host is required."); }
    let source = client_ip(webhook.trust_forwarded, auth.forwarded_for, auth.connecting_ip, auth.peer);
    if !allowlisted(&webhook.allowed_ips, source) { return error(403, "This IP address is not allowed."); }
    let mut stamped = None;
    if webhook.require_signature {
        let secret = super::secrets::get(id, "signing_secret").unwrap_or_default();
        if secret.is_empty() { return error(401, "Invalid or stale signature."); }
        match signed_at(&secret, auth.timestamp, auth.signature, auth.body, auth.now) {
            Some(at) => stamped = Some(at),
            None => return error(401, "Invalid or stale signature."),
        }
    }
    if webhook.require_token {
        let expected = super::secrets::get(id, "token").unwrap_or_default();
        let given = auth.token.as_deref().unwrap_or_default();
        if expected.is_empty() || given.is_empty() || !http::same(&expected, given) {
            return error(401, "Invalid or missing API token.");
        }
    }
    let delivery = auth.delivery.map(str::trim).filter(|value| !value.is_empty());
    if delivery.is_some_and(|value| webhook.last_delivery.as_deref() == Some(value)) {
        return Response::json(200, &json!({"ok": true, "duplicate": true}));
    }
    let Some(text) = parse_event(auth.body) else { return error(400, "Send some event text.") };
    if !allow_event(id) { return error(429, "Too many events. Wait a minute and try again."); }
    let stored = delivery.unwrap_or_default();
    let accepted = match stamped {
        Some(at) => store.db.execute(
            "UPDATE bot_webhooks SET last_timestamp=?2,last_delivery=?3 WHERE id=?1 AND enabled=1 AND last_timestamp<?2",
            params![id, at, stored],
        ),
        None => store.db.execute("UPDATE bot_webhooks SET last_delivery=?2 WHERE id=?1 AND enabled=1", params![id, stored]),
    };
    match accepted {
        Ok(1) => {}
        // The 0-row arm also covers a webhook disabled between the checks above and this
        // update: give it the disabled answer rather than the replay one.
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
pub async fn bot_webhook_update(app: tauri::AppHandle, state: State<'_, AppState>, id: String, settings: WebhookSettings) -> Result<Webhook> {
    let webhook = update(&*state.store.lock().map_err(|e| e.to_string())?, &id, &settings)?;
    let _ = app.emit("bots-changed", ());
    Ok(webhook)
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
pub async fn bot_webhook_rotate_token(state: State<'_, AppState>, id: String) -> Result<String> {
    rotate_token(&*state.store.lock().map_err(|e| e.to_string())?, &id)
}

pub(crate) fn set_enabled(store: &Store, id: &str, enabled: bool) -> Result<Webhook> {
    store.db.execute("UPDATE bot_webhooks SET enabled=?2 WHERE id=?1", params![id, enabled]).map_err(|e| e.to_string())?;
    get(store, id).ok_or_else(|| "This webhook no longer exists.".into())
}

pub(crate) fn delete(store: &Store, id: &str) -> Result<()> {
    store.db.execute("DELETE FROM bot_webhooks WHERE id=?1", [id]).map_err(|e| e.to_string())?;
    super::secrets::remove(id, "signing_secret");
    super::secrets::remove(id, "token");
    Ok(())
}

pub(crate) fn rotate_secret(store: &Store, id: &str) -> Result<String> {
    get(store, id).ok_or("This webhook no longer exists.")?;
    let secret = super::channels::web::new_token();
    super::secrets::set(id, "signing_secret", &secret)?;
    Ok(secret)
}

pub(crate) fn rotate_token(store: &Store, id: &str) -> Result<String> {
    get(store, id).ok_or("This webhook no longer exists.")?;
    let token = super::channels::web::new_token();
    super::secrets::set(id, "token", &token)?;
    Ok(token)
}

#[tauri::command]
pub async fn bot_webhook_test(app: tauri::AppHandle, state: State<'_, AppState>, id: String) -> Result<TestResult> {
    let webhook = {
        let store = state.store.lock().map_err(|e| e.to_string())?;
        get(&store, &id).ok_or("This webhook no longer exists.")?
    };
    http::ensure_server(app);
    let port = http::port();
    if port == 0 { return Err("Could not start the local webhook server.".into()); }
    let body = r#"{"text":"Test event from PandaCode."}"#;
    let mut request = reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none()).timeout(std::time::Duration::from_secs(40)).user_agent(concat!("PandaCode/", env!("CARGO_PKG_VERSION"))).build().map_err(|e| e.to_string())?.post(format!("http://127.0.0.1:{port}/hook/{id}")).header("Content-Type", "application/json");
    // The test signs and authenticates exactly as this webhook requires, so it proves the
    // settings a caller has to satisfy rather than a fixed path.
    if webhook.require_signature {
        let secret = super::secrets::get(&id, "signing_secret").ok_or("The signing secret is missing. Rotate it and try again.")?;
        let timestamp = (crate::storage::now() / 1000).to_string();
        let signed = signature(&secret, &timestamp, body)?;
        request = request.header("X-PandaCode-Timestamp", timestamp).header("X-PandaCode-Signature", signed);
    }
    if webhook.require_token {
        let token = super::secrets::get(&id, "token").ok_or("The API token is missing. Rotate it and try again.")?;
        request = request.header("X-Api-Key", token);
    }
    let response = request.body(body).send().await.map_err(|e| e.to_string())?;
    let status = response.status().as_u16();
    let error = if (200..300).contains(&status) {
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

    #[test]
    fn ranges_parse_and_match_both_families() {
        assert!(super::in_range(super::parse_range("10.0.0.5").unwrap(), "10.0.0.5".parse().unwrap()));
        assert!(!super::in_range(super::parse_range("10.0.0.5").unwrap(), "10.0.0.6".parse().unwrap()));
        assert!(super::in_range(super::parse_range("10.0.0.0/8").unwrap(), "10.9.9.9".parse().unwrap()));
        assert!(!super::in_range(super::parse_range("10.0.0.0/8").unwrap(), "11.0.0.1".parse().unwrap()));
        assert!(super::in_range(super::parse_range("0.0.0.0/0").unwrap(), "203.0.113.9".parse().unwrap()));
        assert!(super::in_range(super::parse_range("192.168.1.7/32").unwrap(), "192.168.1.7".parse().unwrap()));
        assert!(super::in_range(super::parse_range("2001:db8::/32").unwrap(), "2001:db8:1::5".parse().unwrap()));
        assert!(!super::in_range(super::parse_range("2001:db8::/32").unwrap(), "2001:db9::5".parse().unwrap()));
        assert!(super::in_range(super::parse_range("::1").unwrap(), "::1".parse().unwrap()));
        assert!(!super::in_range(super::parse_range("10.0.0.0/8").unwrap(), "::1".parse().unwrap()), "families never cross");
        assert!(super::parse_range("10.0.0.0/33").is_err());
        assert!(super::parse_range("not-an-ip").is_err());
        assert!(super::parse_range("").is_err());
    }

    #[test]
    fn the_stripe_style_header_is_read_leniently() {
        assert_eq!(super::stripe_header("t=1700000000,v1=abc").unwrap(), ("1700000000".into(), "abc".into()));
        assert_eq!(super::stripe_header("v0=zzz, t=1700000000 , v1=abc").unwrap(), ("1700000000".into(), "abc".into()), "order and spacing do not matter");
        assert!(super::stripe_header("t=1700000000").is_none(), "no digest");
        assert!(super::stripe_header("v1=abc").is_none(), "no timestamp");
        assert!(super::stripe_header("nonsense").is_none());
    }

    #[test]
    fn events_are_found_under_the_names_services_use() {
        assert_eq!(super::parse_event(r#"{"message":"a message"}"#).as_deref(), Some("a message"));
        assert_eq!(super::parse_event(r#"{"prompt":"a prompt"}"#).as_deref(), Some("a prompt"));
        assert_eq!(super::parse_event(r#"{"run":{"prompt":"run prompt"}}"#).as_deref(), Some("run prompt"));
        assert_eq!(super::parse_event(r#"{"run":{"systemPrompt":"sys"}}"#).as_deref(), Some("sys"));
        assert_eq!(super::parse_event(r#"{"subject":"subj"}"#).as_deref(), Some("subj"));
        assert_eq!(super::parse_event(r#"{"title":"ttl"}"#).as_deref(), Some("ttl"));
        assert_eq!(super::parse_event(r#"{"text":"first","message":"second"}"#).as_deref(), Some("first"), "text wins");
    }
}
