//! Channels connect a bot to where the user already talks: a local web page,
//! Telegram, Slack, Discord and WhatsApp. Each enabled channel runs one connection
//! loop. Senders must be paired before they can drive the bot; secrets stay in the
//! OS secure store.

pub(crate) mod discord;
pub(crate) mod http;
pub(crate) mod slack;
pub(crate) mod telegram;
pub(crate) mod web;
pub(crate) mod whatsapp;

use super::{gateway, secrets};
use crate::{storage::Store, AppState, Result};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{Emitter, Manager, State};

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Channel {
    pub id: String,
    pub bot_id: String,
    pub kind: String,
    pub label: String,
    /// Non-secret settings, such as a Slack respond mode or a WhatsApp phone number ID.
    pub config: Value,
    pub enabled: bool,
    pub status: String,
    /// Which secrets are saved, never their values. Recorded when saved, so listing never touches the keychain.
    pub secrets: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Pairing {
    pub channel_id: String,
    pub sender_id: String,
    pub sender_name: String,
    pub status: String,
    pub code: String,
    pub created_at: i64,
}

/// Who the channel connects as, found by checking its credentials.
#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub name: String,
    /// Where to open the bot (t.me, wa.me, the Slack workspace).
    pub link: Option<String>,
    /// Discord: the link that adds the bot to a server.
    pub invite: Option<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ChannelInput {
    pub kind: String,
    pub label: String,
    pub config: Value,
    /// Secrets to save, by name (token, app_token, signing_secret, access_token).
    pub secrets: HashMap<String, String>,
}

/// Message size limits, so long replies are split instead of rejected.
pub(crate) fn limit(kind: &str) -> usize {
    match kind {
        "telegram" | "whatsapp" => 4000,
        "slack" => 3500,
        "discord" => 1900,
        _ => 20_000,
    }
}

/// Splits text at paragraph, line or word boundaries to fit `limit` characters.
pub(crate) fn chunks(text: &str, limit: usize) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = text.trim();
    while rest.chars().count() > limit {
        let cut = rest.char_indices().nth(limit).map_or(rest.len(), |(i, _)| i);
        let window = &rest[..cut];
        let split = window.rfind("\n\n").or_else(|| window.rfind('\n')).or_else(|| window.rfind(' ')).filter(|i| *i > limit / 3).unwrap_or(cut);
        out.push(rest[..split].trim().to_owned());
        rest = rest[split..].trim_start();
    }
    if !rest.is_empty() {
        out.push(rest.to_owned());
    }
    out
}

/// Catches pasted-in-the-wrong-box and truncated tokens before any network call.
pub(crate) fn check_format(input: &ChannelInput) -> Result<()> {
    let secret = |name: &str| input.secrets.get(name).map(|value| value.trim()).unwrap_or_default();
    match input.kind.as_str() {
        "telegram" => {
            let token = secret("token");
            let valid = token.split_once(':').is_some_and(|(id, rest)| !id.is_empty() && id.chars().all(|c| c.is_ascii_digit()) && rest.len() >= 30);
            if !valid {
                return Err("That doesn't look like a Telegram bot token. It looks like 123456789:AAE… — copy the whole line BotFather sent.".into());
            }
        }
        "slack" => {
            let (bot, app) = (secret("token"), secret("app_token"));
            if bot.starts_with("xapp-") && app.starts_with("xoxb-") {
                return Err("The two Slack tokens are swapped: the bot token starts with xoxb-, the app-level token with xapp-.".into());
            }
            if !bot.starts_with("xoxb-") {
                return Err("The bot token starts with xoxb-. Find it under OAuth & Permissions → Bot User OAuth Token (install the app first).".into());
            }
            if !app.starts_with("xapp-") {
                return Err("The app-level token starts with xapp-. Create it under Basic Information → App-Level Tokens with the connections:write scope.".into());
            }
        }
        "discord" => {
            let token = secret("token");
            if token.split('.').count() != 3 || token.len() < 50 {
                return Err("That doesn't look like a Discord bot token. In the Developer Portal open Bot → Reset Token and copy the whole value. (The Client Secret and Public Key are different values.)".into());
            }
        }
        "whatsapp" if !input.config["phoneNumberId"].as_str().is_some_and(|id| !id.is_empty() && id.chars().all(|c| c.is_ascii_digit())) => {
            return Err("Enter the phone number ID (digits only) from WhatsApp → API Setup. It is not the phone number itself.".into());
        }
        _ => {}
    }
    Ok(())
}

/// Checks credentials with the service itself. Web chat has nothing to check.
pub(crate) async fn verify(input: &ChannelInput) -> Result<Identity> {
    check_format(input)?;
    let secret = |name: &str| input.secrets.get(name).map(|value| value.trim().to_owned()).unwrap_or_default();
    let result = match input.kind.as_str() {
        "telegram" => telegram::verify(&secret("token")).await,
        "slack" => slack::verify(&secret("token"), &secret("app_token")).await,
        "discord" => discord::verify(&secret("token")).await,
        "whatsapp" => whatsapp::verify(input.config["phoneNumberId"].as_str().unwrap_or_default(), &secret("access_token")).await,
        "web" => Ok(Identity { name: "Web chat on this computer".into(), ..Default::default() }),
        _ => Err("Choose web, Telegram, Slack, Discord or WhatsApp.".into()),
    };
    result.map_err(|error| error.trim_start_matches("auth:").to_owned())
}

fn required_secrets(kind: &str) -> &'static [&'static str] {
    match kind {
        "telegram" | "discord" => &["token"],
        "slack" => &["token", "app_token"],
        "whatsapp" => &["access_token", "signing_secret"],
        _ => &[],
    }
}

const COLUMNS: &str = "id,bot_id,kind,label,config,enabled,status,secret_names";
fn row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Channel> {
    let secrets = serde_json::from_str(&r.get::<_, String>(7)?).unwrap_or_default();
    Ok(Channel { id: r.get(0)?, bot_id: r.get(1)?, kind: r.get(2)?, label: r.get(3)?, config: serde_json::from_str(&r.get::<_, String>(4)?).unwrap_or(json!({})), enabled: r.get(5)?, status: r.get(6)?, secrets })
}

/// The web chat's access token. It guards a page on this computer only, like the
/// conversations in the same database, so it lives there rather than in the keychain,
/// where an access prompt after an app update would break every open link.
pub(crate) fn web_token(store: &Store, channel_id: &str) -> Option<String> {
    store.db.query_row("SELECT web_token FROM bot_channels WHERE id=?1 AND kind='web'", [channel_id], |r| r.get::<_, Option<String>>(0)).ok().flatten()
}

pub(crate) fn list(store: &Store, bot_id: &str) -> Result<Vec<Channel>> {
    let mut statement = store.db.prepare(&format!("SELECT {COLUMNS} FROM bot_channels WHERE bot_id=?1 ORDER BY created_at")).map_err(|e| e.to_string())?;
    let rows = statement.query_map([bot_id], row).map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<_>>().map_err(|e| e.to_string())
}

pub(crate) fn get(store: &Store, id: &str) -> Result<Channel> {
    store
        .db
        .query_row(&format!("SELECT {COLUMNS} FROM bot_channels WHERE id=?1"), [id], row)
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "This channel no longer exists.".into())
}

pub(crate) fn kind_of(store: &Store, id: &str) -> Option<String> {
    store.db.query_row("SELECT kind FROM bot_channels WHERE id=?1", [id], |r| r.get(0)).ok()
}

pub(crate) fn add(store: &Store, bot_id: &str, input: &ChannelInput) -> Result<Channel> {
    super::get(store, bot_id)?;
    if !matches!(input.kind.as_str(), "web" | "telegram" | "slack" | "discord" | "whatsapp") {
        return Err("Choose web, Telegram, Slack, Discord or WhatsApp.".into());
    }
    let mut config = if input.config.is_object() { input.config.clone() } else { json!({}) };
    if input.kind == "whatsapp" {
        // The verify token only proves to Meta that the webhook is ours; it is shown so it can be pasted there.
        config["verifyToken"] = json!(format!("pandacode-{}", &uuid::Uuid::new_v4().simple().to_string()[..16]));
    }
    if input.kind == "whatsapp" && config["phoneNumberId"].as_str().is_none_or(|id| id.trim().is_empty() || !id.chars().all(|c| c.is_ascii_digit())) {
        return Err("Enter the WhatsApp phone number ID from Meta's API setup page.".into());
    }
    for name in required_secrets(&input.kind) {
        if input.secrets.get(*name).is_none_or(|value| value.trim().is_empty()) {
            return Err(format!("Enter the {} for this channel.", name.replace('_', " ")));
        }
    }
    let id = crate::storage::id();
    let mut saved = Vec::new();
    for (name, value) in &input.secrets {
        if !secrets::NAMES.contains(&name.as_str()) {
            return Err("Unknown secret name.".into());
        }
        if !value.trim().is_empty() {
            secrets::set(&id, name, value)?;
            saved.push(name.clone());
        }
    }
    saved.sort();
    let token = (input.kind == "web").then(web::new_token);
    let label = input.label.trim().chars().take(60).collect::<String>();
    store
        .db
        .execute(
            "INSERT INTO bot_channels(id,bot_id,kind,label,config,secret_names,web_token,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
            params![id, bot_id, input.kind, label, config.to_string(), json!(saved).to_string(), token, crate::storage::now()],
        )
        .map_err(|e| e.to_string())?;
    super::log(store, bot_id, "channel", &format!("Added a {} channel", input.kind), json!({"channelId": id}))?;
    get(store, &id)
}

pub(crate) fn set_status(store: &Store, id: &str, status: &str) {
    let _ = store.db.execute("UPDATE bot_channels SET status=?2 WHERE id=?1", params![id, status.chars().take(200).collect::<String>()]);
}

pub(crate) fn pairings(store: &Store, bot_id: &str) -> Result<Vec<Pairing>> {
    let mut statement = store
        .db
        .prepare("SELECT p.channel_id,p.sender_id,p.sender_name,p.status,p.code,p.created_at FROM bot_pairings p JOIN bot_channels c ON c.id=p.channel_id WHERE c.bot_id=?1 ORDER BY p.created_at DESC")
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([bot_id], |r| Ok(Pairing { channel_id: r.get(0)?, sender_id: r.get(1)?, sender_name: r.get(2)?, status: r.get(3)?, code: r.get(4)?, created_at: r.get(5)? }))
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<_>>().map_err(|e| e.to_string())
}

pub(crate) fn is_approved(store: &Store, channel_id: &str, sender_id: &str) -> Result<bool> {
    store
        .db
        .query_row("SELECT status='approved' FROM bot_pairings WHERE channel_id=?1 AND sender_id=?2", params![channel_id, sender_id], |r| r.get(0))
        .optional()
        .map(|found| found.unwrap_or(false))
        .map_err(|e| e.to_string())
}

fn pairing_code() -> String {
    let bytes = uuid::Uuid::new_v4().into_bytes();
    format!("{:04}", u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) % 10_000)
}

/// Records an unknown sender as pending (once) and returns its code, or `None` if blocked.
pub(crate) fn request_pairing(store: &Store, channel_id: &str, sender_id: &str, sender_name: &str) -> Result<Option<String>> {
    let existing: Option<(String, String)> = store
        .db
        .query_row("SELECT status,code FROM bot_pairings WHERE channel_id=?1 AND sender_id=?2", params![channel_id, sender_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()
        .map_err(|e| e.to_string())?;
    match existing {
        Some((status, _)) if status == "blocked" => Ok(None),
        Some((_, code)) => Ok(Some(code)),
        None => {
            let pending: i64 = store.db.query_row("SELECT COUNT(*) FROM bot_pairings WHERE channel_id=?1 AND status='pending'", [channel_id], |r| r.get(0)).map_err(|e| e.to_string())?;
            if pending >= 20 {
                return Ok(None);
            }
            let code = pairing_code();
            store
                .db
                .execute("INSERT INTO bot_pairings(channel_id,sender_id,sender_name,status,code,created_at) VALUES(?1,?2,?3,'pending',?4,?5)", params![channel_id, sender_id, sender_name.chars().take(80).collect::<String>(), code, crate::storage::now()])
                .map_err(|e| e.to_string())?;
            Ok(Some(code))
        }
    }
}

pub(crate) fn decide_pairing(store: &Store, channel_id: &str, sender_id: &str, decision: &str) -> Result<()> {
    if !matches!(decision, "approved" | "blocked" | "removed") {
        return Err("Approve, block or remove the sender.".into());
    }
    if decision == "removed" {
        store.db.execute("DELETE FROM bot_pairings WHERE channel_id=?1 AND sender_id=?2", params![channel_id, sender_id]).map_err(|e| e.to_string())?;
    } else {
        store.db.execute("UPDATE bot_pairings SET status=?3 WHERE channel_id=?1 AND sender_id=?2", params![channel_id, sender_id, decision]).map_err(|e| e.to_string())?;
    }
    let channel = get(store, channel_id)?;
    super::log(store, &channel.bot_id, "pairing", &format!("Sender {decision} on {}", channel.kind), json!({"channelId": channel_id}))
}

/// Entry point for every chat channel: pairing first, then the gateway.
pub(crate) async fn handle_inbound(app: &tauri::AppHandle, channel_id: &str, sender_id: &str, sender_name: &str, thread: &str, text: &str) {
    let state = app.state::<AppState>();
    let decision = {
        let Ok(store) = state.store.lock() else { return };
        let Ok(channel) = get(&store, channel_id) else { return };
        if !channel.enabled {
            return;
        }
        match is_approved(&store, channel_id, sender_id) {
            Ok(true) => Ok(channel),
            _ => Err((channel.clone(), request_pairing(&store, channel_id, sender_id, sender_name).ok().flatten(), super::get(&store, &channel.bot_id).map(|bot| bot.name).unwrap_or_default())),
        }
    };
    match decision {
        Ok(channel) => {
            let inbound = gateway::Inbound { bot_id: channel.bot_id, channel_id: channel_id.into(), thread: thread.into(), sender_id: sender_id.into(), sender_name: sender_name.into(), text: text.into(), trusted: false, image_ids: None, moodboard_ids: None };
            if let Err(error) = gateway::deliver(app, inbound).await {
                let _ = send(app, channel_id, thread, &format!("I couldn't start on that: {error}")).await;
            }
        }
        Err((channel, Some(code), bot)) => {
            let _ = app.emit("bots-changed", ());
            let _ = app.emit("bot-pairing", json!({"botId": channel.bot_id, "channelId": channel_id, "senderName": sender_name, "code": code}));
            let _ = send(app, channel_id, thread, &format!("Hi! I'm {bot}. To talk with me, the owner needs to approve pairing code {code} in PandaCode (Bots → {bot} → Channels).")).await;
        }
        Err(_) => {}
    }
}

pub(crate) async fn send(app: &tauri::AppHandle, channel_id: &str, thread: &str, text: &str) -> Result<()> {
    let channel = get(&*app.state::<AppState>().store.lock().map_err(|e| e.to_string())?, channel_id)?;
    for part in chunks(text, limit(&channel.kind)) {
        match channel.kind.as_str() {
            "web" => web::send(&channel, thread, &part),
            "telegram" => telegram::send(&channel, thread, &part).await,
            "slack" => slack::send(&channel, thread, &part).await,
            "discord" => discord::send(&channel, thread, &part).await,
            "whatsapp" => whatsapp::send(&channel, thread, &part).await,
            _ => Err("Unknown channel.".into()),
        }?;
    }
    Ok(())
}

// --- Connection loops ---------------------------------------------------------

type Running = HashMap<String, tokio::sync::watch::Sender<bool>>;
fn running() -> &'static Mutex<Running> {
    static RUNNING: std::sync::OnceLock<Mutex<Running>> = std::sync::OnceLock::new();
    RUNNING.get_or_init(Default::default)
}

/// Shared HTTP client for channel APIs: HTTPS only, bounded time.
pub(crate) fn client() -> Result<reqwest::Client> {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    reqwest::Client::builder()
        .https_only(true)
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(70))
        .user_agent(concat!("PandaCode/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())
}

pub(crate) fn update_status(app: &tauri::AppHandle, channel_id: &str, status: &str) {
    if let Ok(store) = app.state::<AppState>().store.lock() {
        set_status(&store, channel_id, status);
    }
    let _ = app.emit("bots-changed", ());
}

/// Starts (or restarts) one channel's connection loop. Web channels share the local server.
pub(crate) fn start(app: &tauri::AppHandle, channel: Channel) {
    stop(&channel.id);
    if !channel.enabled {
        update_status(app, &channel.id, "Off");
        return;
    }
    if channel.kind == "web" || channel.kind == "whatsapp" {
        http::ensure_server(app.clone());
        update_status(app, &channel.id, if channel.kind == "web" { "Ready on this computer" } else { "Waiting for webhook calls" });
        return;
    }
    let (tx, rx) = tokio::sync::watch::channel(false);
    if let Ok(mut map) = running().lock() {
        map.insert(channel.id.clone(), tx);
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // Reconnect with backoff until stopped; a bad token stops after the first clear error.
        let mut delay = 2u64;
        loop {
            if *rx.borrow() {
                break;
            }
            let result = match channel.kind.as_str() {
                "telegram" => telegram::run(&app, &channel, rx.clone()).await,
                "slack" => slack::run(&app, &channel, rx.clone()).await,
                "discord" => discord::run(&app, &channel, rx.clone()).await,
                _ => Err("Unknown channel.".into()),
            };
            if *rx.borrow() {
                break;
            }
            match result {
                Err(error) if error.starts_with("auth:") => {
                    update_status(&app, &channel.id, error.trim_start_matches("auth:").trim());
                    break;
                }
                Err(error) => update_status(&app, &channel.id, &format!("Reconnecting: {error}")),
                Ok(()) => update_status(&app, &channel.id, "Reconnecting"),
            }
            let mut stop = rx.clone();
            tokio::select! {
                _ = tokio::time::sleep(std::time::Duration::from_secs(delay)) => {},
                _ = stop.changed() => break,
            }
            delay = (delay * 2).min(120);
        }
    });
}

pub(crate) fn stop(channel_id: &str) {
    if let Some(tx) = running().lock().ok().and_then(|mut map| map.remove(channel_id)) {
        let _ = tx.send(true);
    }
}

pub(crate) fn start_all(app: tauri::AppHandle) {
    let channels: Vec<Channel> = {
        let state = app.state::<AppState>();
        let Ok(store) = state.store.lock() else { return };
        super::list(&store).unwrap_or_default().iter().flat_map(|bot| list(&store, &bot.id).unwrap_or_default()).collect()
    };
    for channel in channels {
        start(&app, channel);
    }
}

pub(crate) async fn stop_bot_channels(app: &tauri::AppHandle, bot_id: &str) {
    let ids: Vec<String> = app.state::<AppState>().store.lock().ok().and_then(|store| list(&store, bot_id).ok()).unwrap_or_default().into_iter().map(|c| c.id).collect();
    for id in ids {
        stop(&id);
    }
}

// --- Desktop commands -----------------------------------------------------------

#[tauri::command]
pub async fn bot_channel_add(app: tauri::AppHandle, state: State<'_, AppState>, bot_id: String, input: ChannelInput) -> Result<Channel> {
    // Check credentials first, so a typo is caught here rather than as a silent connection failure.
    let identity = verify(&input).await?;
    let mut input = input;
    if !input.config.is_object() {
        input.config = json!({});
    }
    input.config["identity"] = json!(identity);
    let channel = add(&*state.store.lock().map_err(|e| e.to_string())?, &bot_id, &input)?;
    start(&app, channel.clone());
    let _ = app.emit("bots-changed", ());
    Ok(channel)
}

/// Settings the setup guide may change after connecting: reaching web chat through a
/// tunnel, and the public HTTPS address used to build webhook and phone links.
pub(crate) fn configure(store: &Store, channel_id: &str, patch: &Value) -> Result<Channel> {
    let channel = get(store, channel_id)?;
    let mut config = channel.config.clone();
    for (key, value) in patch.as_object().ok_or("Send settings as an object.")? {
        match key.as_str() {
            "remote" if channel.kind == "web" => config["remote"] = json!(value.as_bool().ok_or("Remote access is on or off.")?),
            "publicUrl" if matches!(channel.kind.as_str(), "web" | "whatsapp") => {
                let url = value.as_str().unwrap_or_default().trim().trim_end_matches('/');
                if !url.is_empty() {
                    let parsed = tauri::Url::parse(url).map_err(|_| "Paste the full address, starting with https://")?;
                    if parsed.scheme() != "https" || parsed.host_str().is_none() || !parsed.username().is_empty() || parsed.password().is_some() || parsed.query().is_some() {
                        return Err("Use the https:// address your tunnel or Tailscale shows, without a path or query.".into());
                    }
                }
                config["publicUrl"] = json!(url);
            }
            _ => return Err(format!("{key} cannot be changed for this channel.")),
        }
    }
    store.db.execute("UPDATE bot_channels SET config=?2 WHERE id=?1", params![channel_id, config.to_string()]).map_err(|e| e.to_string())?;
    get(store, channel_id)
}

#[tauri::command]
pub async fn bot_channel_configure(app: tauri::AppHandle, state: State<'_, AppState>, channel_id: String, config: Value) -> Result<Channel> {
    let channel = configure(&*state.store.lock().map_err(|e| e.to_string())?, &channel_id, &config)?;
    let _ = app.emit("bots-changed", ());
    Ok(channel)
}

/// Checks credentials without saving anything, for the setup guide's Test button.
#[tauri::command]
pub async fn bot_channel_test(input: ChannelInput) -> Result<Identity> {
    verify(&input).await
}

#[tauri::command]
pub async fn bot_channel_set_enabled(app: tauri::AppHandle, state: State<'_, AppState>, channel_id: String, enabled: bool) -> Result<Channel> {
    let channel = {
        let store = state.store.lock().map_err(|e| e.to_string())?;
        store.db.execute("UPDATE bot_channels SET enabled=?2 WHERE id=?1", params![channel_id, enabled]).map_err(|e| e.to_string())?;
        get(&store, &channel_id)?
    };
    start(&app, channel.clone());
    let _ = app.emit("bots-changed", ());
    Ok(channel)
}

#[tauri::command]
pub async fn bot_channel_remove(app: tauri::AppHandle, state: State<'_, AppState>, channel_id: String) -> Result<()> {
    stop(&channel_id);
    secrets::remove_all(&channel_id);
    let store = state.store.lock().map_err(|e| e.to_string())?;
    let channel = get(&store, &channel_id)?;
    store.db.execute("DELETE FROM bot_channels WHERE id=?1", [&channel_id]).map_err(|e| e.to_string())?;
    super::log(&store, &channel.bot_id, "channel", &format!("Removed a {} channel", channel.kind), json!({}))?;
    let _ = app.emit("bots-changed", ());
    Ok(())
}

#[tauri::command]
pub async fn bot_pairing_decide(app: tauri::AppHandle, state: State<'_, AppState>, channel_id: String, sender_id: String, decision: String) -> Result<()> {
    decide_pairing(&*state.store.lock().map_err(|e| e.to_string())?, &channel_id, &sender_id, &decision)?;
    if decision == "approved" {
        let kind = kind_of(&*state.store.lock().map_err(|e| e.to_string())?, &channel_id).unwrap_or_default();
        let _ = send(&app, &channel_id, &direct_thread(&kind, &sender_id), "You're paired. Send me a message to get started.").await;
    }
    let _ = app.emit("bots-changed", ());
    Ok(())
}

/// Where to message a sender directly: their chat on most channels, a DM on Discord.
pub(crate) fn direct_thread(kind: &str, sender_id: &str) -> String {
    if kind == "discord" { format!("dm:{sender_id}") } else { sender_id.to_owned() }
}

/// The web chat link for a web channel, including its access token.
#[tauri::command]
pub async fn bot_web_link(app: tauri::AppHandle, state: State<'_, AppState>, channel_id: String) -> Result<String> {
    let channel = get(&*state.store.lock().map_err(|e| e.to_string())?, &channel_id)?;
    if channel.kind != "web" {
        return Err("Only web channels have a chat link.".into());
    }
    let port = http::ensure_server(app.clone());
    let token = web_token(&*state.store.lock().map_err(|e| e.to_string())?, &channel.id).ok_or("This channel's link is missing. Create a new link.")?;
    Ok(format!("http://127.0.0.1:{port}/chat/{}#{token}", channel.id))
}

/// Replaces the web chat link; pages opened with the old one stop working.
#[tauri::command]
pub async fn bot_web_new_link(app: tauri::AppHandle, state: State<'_, AppState>, channel_id: String) -> Result<String> {
    {
        let store = state.store.lock().map_err(|e| e.to_string())?;
        let channel = get(&store, &channel_id)?;
        if channel.kind != "web" {
            return Err("Only web channels have a chat link.".into());
        }
        store.db.execute("UPDATE bot_channels SET web_token=?2 WHERE id=?1", params![channel_id, web::new_token()]).map_err(|e| e.to_string())?;
        super::log(&store, &channel.bot_id, "channel", "Created a new web chat link; old links stopped working", json!({}))?;
    }
    bot_web_link(app, state, channel_id).await
}
