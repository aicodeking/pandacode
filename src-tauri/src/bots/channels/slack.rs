//! Slack through Socket Mode: an outbound WebSocket, so no public URL is needed.
//! The Slack app needs Socket Mode on, an app-level token (`xapp-`, scope
//! `connections:write`), a bot token (`xoxb-`, scopes `chat:write`, `app_mentions:read`,
//! `im:history`) and the `app_mention` and `message.im` events.

use super::{client, handle_inbound, secrets, update_status, Channel};
use crate::Result;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message;

const API: &str = "https://slack.com/api";

async fn call(token: &str, method: &str, body: &Value) -> Result<Value> {
    // Slack asks for an explicit charset on JSON bodies.
    let response = client()?
        .post(format!("{API}/{method}"))
        .bearer_auth(token)
        .header(reqwest::header::CONTENT_TYPE, "application/json; charset=utf-8")
        .body(body.to_string())
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let value: Value = response.json().await.map_err(|_| "Slack sent an unreadable response.".to_owned())?;
    if value["ok"].as_bool() != Some(true) {
        let error = value["error"].as_str().unwrap_or("request_failed");
        return Err(match error {
            "invalid_auth" | "not_authed" | "account_inactive" | "token_revoked" | "missing_scope" | "not_allowed_token_type" => format!("auth:Slack refused the token ({error}). Check the app's tokens and scopes."),
            // Slack answers a mangled token this way; it usually means part of it was cut off when copying.
            "internal_error" if method == "auth.test" => "auth:Slack couldn't read that bot token. Copy the whole Bot User OAuth Token again.".into(),
            _ => format!("Slack: {error}"),
        });
    }
    Ok(value)
}

/// What an Events API event asks for: (sender, thread, text), or `None` to ignore it.
pub(crate) fn inbound(event: &Value, bot_user: &str) -> Option<(String, String, String)> {
    if event["bot_id"].is_string() || event["subtype"].is_string() {
        return None;
    }
    let kind = event["type"].as_str()?;
    let direct = event["channel_type"].as_str() == Some("im");
    if !(kind == "app_mention" || kind == "message" && direct) {
        return None;
    }
    let user = event["user"].as_str()?.to_owned();
    let channel = event["channel"].as_str()?;
    let text = event["text"].as_str()?.replace(&format!("<@{bot_user}>"), "").trim().to_owned();
    if text.is_empty() {
        return None;
    }
    // Direct messages are one conversation; channel mentions continue in their thread.
    let thread = if direct { channel.to_owned() } else { format!("{channel}|{}", event["thread_ts"].as_str().or(event["ts"].as_str())?) };
    Some((user, thread, text))
}

pub(crate) async fn run(app: &tauri::AppHandle, channel: &Channel, mut stop: tokio::sync::watch::Receiver<bool>) -> Result<()> {
    let bot_token = secrets::get(&channel.id, "token").ok_or("auth:The Slack bot token is missing.")?;
    let app_token = secrets::get(&channel.id, "app_token").ok_or("auth:The Slack app-level token is missing.")?;
    let me = call(&bot_token, "auth.test", &json!({})).await?;
    let bot_user = me["user_id"].as_str().unwrap_or_default().to_owned();
    let team = me["team"].as_str().unwrap_or("Slack").to_owned();
    let url = call(&app_token, "apps.connections.open", &json!({})).await?["url"].as_str().ok_or("Slack did not return a socket URL.")?.to_owned();
    let (mut socket, _) = tokio_tungstenite::connect_async(url.as_str()).await.map_err(|e| format!("Could not open Slack's socket: {e}"))?;
    update_status(app, &channel.id, &format!("Connected to {team}"));
    loop {
        let frame = tokio::select! {
            frame = socket.next() => frame,
            _ = stop.changed() => { let _ = socket.close(None).await; return Ok(()); }
        };
        let text = match frame {
            Some(Ok(Message::Text(text))) => text.to_string(),
            Some(Ok(Message::Ping(data))) => {
                let _ = socket.send(Message::Pong(data)).await;
                continue;
            }
            Some(Ok(Message::Close(_))) | None => return Ok(()),
            Some(Ok(_)) => continue,
            Some(Err(error)) => return Err(error.to_string()),
        };
        let envelope: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        if let Some(id) = envelope["envelope_id"].as_str() {
            socket.send(Message::text(json!({"envelope_id": id}).to_string())).await.map_err(|e| e.to_string())?;
        }
        match envelope["type"].as_str() {
            Some("disconnect") => return Ok(()),
            Some("events_api") => {
                let Some((user, thread, text)) = inbound(&envelope["payload"]["event"], &bot_user) else { continue };
                let name = display_name(&bot_token, &user).await;
                let (app, channel_id) = (app.clone(), channel.id.clone());
                tauri::async_runtime::spawn(async move { handle_inbound(&app, &channel_id, &user, &name, &thread, &text).await });
            }
            _ => {}
        }
    }
}

async fn display_name(token: &str, user: &str) -> String {
    if !user.chars().all(|c| c.is_ascii_alphanumeric()) {
        return user.to_owned();
    }
    // users.info reads its arguments from the query string, not a JSON body.
    let request = client().map(|client| client.get(format!("{API}/users.info?user={user}")).bearer_auth(token));
    let profile = match request {
        Ok(request) => match request.send().await {
            Ok(response) => response.json::<Value>().await.ok().filter(|value| value["ok"].as_bool() == Some(true)),
            Err(_) => None,
        },
        Err(_) => None,
    };
    profile
        .as_ref()
        .and_then(|value| value["user"]["profile"]["display_name"].as_str().filter(|n| !n.is_empty()).or(value["user"]["real_name"].as_str()))
        .unwrap_or(user)
        .to_owned()
}

/// Checks both tokens: the bot token can post, and the app token can open a Socket Mode connection.
pub(crate) async fn verify(bot_token: &str, app_token: &str) -> Result<super::Identity> {
    let me = call(bot_token, "auth.test", &json!({})).await.map_err(|error| {
        if error.contains("invalid_auth") || error.contains("not_authed") || error.contains("token_revoked") {
            "auth:Slack didn't accept the bot token. Copy the Bot User OAuth Token from OAuth & Permissions; if you changed scopes, reinstall the app first.".to_owned()
        } else {
            error
        }
    })?;
    call(app_token, "apps.connections.open", &json!({})).await.map_err(|error| {
        if error.contains("not_allowed_token_type") || error.contains("invalid_auth") {
            "auth:The app-level token was not accepted. Create one under Basic Information → App-Level Tokens with the connections:write scope.".to_owned()
        } else if error.contains("socket") || error.contains("not_enabled") {
            "auth:Turn on Socket Mode for this Slack app (Settings → Socket Mode).".to_owned()
        } else {
            error
        }
    })?;
    let team = me["team"].as_str().unwrap_or("Slack");
    let user = me["user"].as_str().unwrap_or("bot");
    Ok(super::Identity { name: format!("@{user} in {team}"), link: me["url"].as_str().map(str::to_owned), ..Default::default() })
}

/// Text as Slack's API requires it: `&`, `<` and `>` escaped, so an agent's `<!channel>`,
/// `<@U…>` or `<url|label>` shows as typed and never pings anyone or hides a link's target.
pub(crate) fn escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

pub(crate) async fn send(channel: &Channel, thread: &str, text: &str) -> Result<()> {
    let token = secrets::get(&channel.id, "token").ok_or("The Slack bot token is missing.")?;
    let (target, thread_ts) = thread.split_once('|').map_or((thread, None), |(c, ts)| (c, Some(ts)));
    let mut body = json!({"channel": target, "text": escape(text), "unfurl_links": false});
    if let Some(ts) = thread_ts {
        body["thread_ts"] = json!(ts);
    }
    call(&token, "chat.postMessage", &body).await.map(|_| ()).map_err(|e| e.trim_start_matches("auth:").to_owned())
}
