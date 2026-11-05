//! Explicit Google account sign-in through the official Antigravity ACP engine.
//! The engine owns browser OAuth, credential storage and renewal.
use serde_json::{json, Value};
use std::{sync::{Mutex, OnceLock}, time::Duration};
use tokio::sync::watch;
use crate::slash_commands::claude::Pipe;

fn marker() -> Option<std::path::PathBuf> {
    crate::agent_usage_providers::home().map(|home| home.join(".local/share/pandacode/google/account-sign-in-enabled"))
}
/// The user explicitly enabled personal Google login. The official engine still owns credentials.
pub(crate) fn method(metadata: &Value) -> Option<String> {
    if metadata["agentInfo"]["name"] != "antigravity-acp" || !marker().is_some_and(|path| path.is_file()) { return None; }
    metadata["authMethods"].as_array()?.iter().any(|m| m["id"] == "oauth-personal").then(|| "oauth-personal".into())
}

type Attempt = (String, watch::Sender<bool>);
fn attempt() -> &'static Mutex<Option<Attempt>> {
    static ATTEMPT: OnceLock<Mutex<Option<Attempt>>> = OnceLock::new();
    ATTEMPT.get_or_init(|| Mutex::new(None))
}
struct Guard;
impl Drop for Guard { fn drop(&mut self) { *attempt().lock().unwrap_or_else(|p| p.into_inner()) = None; } }
static MUTATION: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);
fn main_window(window: &tauri::WebviewWindow) -> crate::Result<()> {
    if window.label() != "main" { return Err("Manage Google sign-in in the main window.".into()); }
    Ok(())
}
async fn authenticate(pipe: &mut Pipe) -> crate::Result<()> {
    pipe.send(&json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{},"clientInfo":{"name":"pandacode","version":env!("CARGO_PKG_VERSION")}}})).await.map_err(|_| "Could not initialize Google sign-in.")?;
    loop {
        let frame: Value = pipe.read().await.map_err(|_| "Google sign-in ended or timed out. Try again.")?;
        if frame.get("method").is_some() && frame.get("id").is_some() {
            pipe.send(&json!({"jsonrpc":"2.0","id":frame["id"],"error":{"code":-32601,"message":"Sign-in does not execute agent requests"}})).await.map_err(|_| "Google sign-in connection closed.")?;
            continue;
        }
        if frame.get("error").is_some() { return Err("Google sign-in was not completed. Try again in your browser.".into()); }
        if frame["id"] == 1 {
            if frame["result"]["protocolVersion"] != 1 || !frame["result"]["authMethods"].as_array().is_some_and(|methods| methods.iter().any(|m| m["id"] == "oauth-personal")) {
                return Err("This Google engine does not offer personal Google account sign-in. Update the official ACP engine.".into());
            }
            pipe.send(&json!({"jsonrpc":"2.0","id":2,"method":"authenticate","params":{"methodId":"oauth-personal"}})).await.map_err(|_| "Could not start Google sign-in.")?;
        } else if frame["id"] == 2 && frame.get("result").is_some() { return Ok(()); }
    }
}
#[tauri::command]
pub(crate) async fn provider_google_login(window: tauri::WebviewWindow, app: tauri::AppHandle, attempt_id: String) -> crate::Result<()> {
    use tauri::Emitter;
    main_window(&window)?;
    if attempt_id.is_empty() || attempt_id.len() > 128 { return Err("Invalid sign-in attempt.".into()); }
    let _permit = MUTATION.try_acquire().map_err(|_| "Google sign-in is already running.")?;
    let path = crate::providers::executable("antigravity").ok_or("Install the official Google Antigravity ACP engine first.")?;
    let cwd = crate::agent_usage_providers::home().unwrap_or_else(std::env::temp_dir);
    #[allow(unused_mut)]
    let mut command = crate::providers::provider_command("antigravity", &path)?;
    #[cfg(target_os = "linux")]
    command.arg("--uid=");
    let (cancel, mut cancelled) = watch::channel(false);
    *attempt().lock().map_err(|e| e.to_string())? = Some((attempt_id, cancel));
    let _guard = Guard;
    let mut pipe = Pipe::spawn(command, &cwd, Duration::from_secs(180)).map_err(|_| "Could not start Google's sign-in engine.")?;
    let result = tokio::select! {
        result = authenticate(&mut pipe) => result,
        _ = cancelled.changed() => Err("Google sign-in cancelled.".into()),
    };
    pipe.finish().await;
    if result.is_ok() {
        if let Some(path) = marker() {
            if let Some(parent) = path.parent() { std::fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
            std::fs::write(path, b"personal Google sign-in enabled\n").map_err(|e| e.to_string())?;
        }
        crate::agent_usage::invalidate("antigravity");
        crate::providers::acp_catalog::invalidate("antigravity");
        crate::slash_commands::invalidate_provider("antigravity");
        let _ = app.emit("provider-models-changed", json!({"provider":"antigravity"}));
    }
    result
}
#[tauri::command]
pub(crate) async fn provider_google_cancel(window: tauri::WebviewWindow, attempt_id: String) -> crate::Result<()> {
    main_window(&window)?;
    if let Some((id, cancel)) = attempt().lock().map_err(|e| e.to_string())?.as_ref().filter(|(id,_)| id == &attempt_id) {
        let _ = id; let _ = cancel.send(true);
    }
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    #[tokio::test]
    async fn google_login_selects_personal_oauth_without_sending_a_prompt() {
        let mut command = tokio::process::Command::new("sh");
        command.args(["-c", r#"read init
printf '%s\n' '{"id":1,"result":{"protocolVersion":1,"authMethods":[{"id":"oauth-personal"}]}}'
read auth
case "$auth" in *'"method":"authenticate"'*'"methodId":"oauth-personal"'*) ;; *) exit 2;; esac
printf '%s\n' '{"id":2,"result":{}}'
read unexpected
exit 3
"#]);
        let mut pipe = Pipe::spawn(command, &std::env::temp_dir(), Duration::from_secs(3)).unwrap();
        let result = authenticate(&mut pipe).await;
        pipe.finish().await;
        assert!(result.is_ok(), "{result:?}");
    }
}
