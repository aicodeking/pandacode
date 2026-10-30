//! User-initiated ChatGPT sign-in through the installed Codex CLI. Codex owns
//! browser callbacks, credentials and renewal; credentials never cross IPC.
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    process::Stdio,
    sync::{Mutex, OnceLock},
    time::Duration,
};
use tokio::{process::Command, sync::watch};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Status {
    installed: bool,
    state: &'static str,
    email: Option<String>,
    plan: Option<String>,
}

fn clean(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(|value| {
            value
                .chars()
                .filter(|c| !c.is_control())
                .take(160)
                .collect::<String>()
        })
        .filter(|value| !value.is_empty())
}

fn account_status(value: &Value) -> Status {
    let account = &value["account"];
    Status {
        installed: true,
        state: if account.is_null() {
            "signedOut"
        } else {
            match account["type"].as_str() {
                Some("chatgpt" | "chatgptAuthTokens") => "chatgpt",
                Some("apiKey") => "apiKey",
                _ => "other",
            }
        },
        email: clean(&account["email"]),
        plan: clean(&account["planType"]),
    }
}

fn main_window(window: &tauri::WebviewWindow) -> crate::Result<()> {
    if window.label() != "main" {
        return Err("Manage ChatGPT sign-in in the main window.".into());
    }
    Ok(())
}

async fn status() -> crate::Result<Status> {
    if crate::providers::executable("codex").is_none() {
        return Ok(Status {
            installed: false,
            state: "signedOut",
            email: None,
            plan: None,
        });
    }
    let cwd = crate::agent_usage_providers::home().unwrap_or_else(std::env::temp_dir);
    let mut client = crate::integrations::ControlClient::start(&cwd).await?;
    let result = client
        .request("account/read", json!({"refreshToken": false}))
        .await;
    client.finish().await;
    let account = result?;
    if account.get("account").is_none() {
        return Err(
            "Codex returned an incomplete account status. Update Codex and try again.".into(),
        );
    }
    Ok(account_status(&account))
}

#[tauri::command]
pub(crate) async fn provider_chatgpt_status(window: tauri::WebviewWindow) -> crate::Result<Status> {
    main_window(&window)?;
    status().await
}

type Attempt = (String, watch::Sender<bool>);
fn attempt() -> &'static Mutex<Option<Attempt>> {
    static ATTEMPT: OnceLock<Mutex<Option<Attempt>>> = OnceLock::new();
    ATTEMPT.get_or_init(|| Mutex::new(None))
}
struct LoginGuard;
impl Drop for LoginGuard {
    fn drop(&mut self) {
        *attempt().lock().unwrap_or_else(|p| p.into_inner()) = None;
    }
}

// One credential-changing operation at a time; status reads stay independent.
static MUTATION: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);

async fn login_process(
    mut command: Command,
    mut cancel: watch::Receiver<bool>,
    timeout: Duration,
) -> Result<(), String> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command.spawn().map_err(|_| {
        "Could not start Codex sign-in. Check the Codex executable in this card.".to_owned()
    })?;
    let group = crate::providers::ProcessGroup::register(child.id());
    let result = tokio::select! {
        biased;
        _ = cancel.wait_for(|cancelled| *cancelled) => Err("ChatGPT sign-in cancelled.".to_owned()),
        result = tokio::time::timeout(timeout, child.wait()) => match result {
            Ok(Ok(exit)) if exit.success() => Ok(()),
            Ok(_) => Err("ChatGPT sign-in did not complete. Try again; if no browser opens, use the terminal sign-in under Advanced setup.".to_owned()),
            Err(_) => Err("ChatGPT sign-in timed out. Try again when you are ready to finish in your browser.".to_owned()),
        },
    };
    drop(group);
    let _ = child.start_kill();
    let _ = tokio::time::timeout(Duration::from_secs(1), child.wait()).await;
    result
}

#[tauri::command]
pub(crate) async fn provider_chatgpt_login(
    window: tauri::WebviewWindow,
    login_id: String,
) -> crate::Result<Status> {
    main_window(&window)?;
    uuid::Uuid::parse_str(&login_id).map_err(|_| "Invalid sign-in attempt.")?;
    let _permit = MUTATION
        .try_acquire()
        .map_err(|_| "ChatGPT sign-in is already changing. Wait a moment and try again.")?;
    let path = crate::providers::executable("codex").ok_or(
        "Install Codex first using Advanced setup below, then refresh agents in Settings → Agents.",
    )?;
    let (send, cancel) = watch::channel(false);
    *attempt().lock().unwrap_or_else(|p| p.into_inner()) = Some((login_id, send));
    let _guard = LoginGuard;
    let mut command = crate::providers::provider_command("codex", &path)?;
    command
        .arg("login")
        .current_dir(crate::agent_usage_providers::home().unwrap_or_else(std::env::temp_dir));
    login_process(command, cancel, Duration::from_secs(180)).await?;
    status().await
}

#[tauri::command]
pub(crate) async fn provider_chatgpt_cancel(
    window: tauri::WebviewWindow,
    login_id: String,
) -> crate::Result<()> {
    main_window(&window)?;
    if let Some((id, cancel)) = attempt().lock().unwrap_or_else(|p| p.into_inner()).as_ref() {
        if id == &login_id {
            let _ = cancel.send(true);
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn provider_chatgpt_logout(window: tauri::WebviewWindow) -> crate::Result<Status> {
    main_window(&window)?;
    let _permit = MUTATION
        .try_acquire()
        .map_err(|_| "Finish or cancel ChatGPT sign-in before signing out.")?;
    let cwd = crate::agent_usage_providers::home().unwrap_or_else(std::env::temp_dir);
    let mut client = crate::integrations::ControlClient::start(&cwd).await?;
    let result = client.request("account/logout", json!({})).await;
    client.finish().await;
    result?;
    status().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_exposes_only_safe_account_metadata() {
        let status = account_status(
            &json!({"account":{"type":"chatgpt","email":"me@example.test\n","planType":"plus","access_token":"secret"}}),
        );
        assert_eq!(status.state, "chatgpt");
        assert_eq!(status.email.as_deref(), Some("me@example.test"));
        assert!(!serde_json::to_string(&status).unwrap().contains("secret"));
        assert_eq!(account_status(&json!({"account":null})).state, "signedOut");
        assert_eq!(
            account_status(&json!({"account":{"type":"apiKey"}})).state,
            "apiKey"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn login_handles_success_failure_timeout_and_cancel_without_real_authentication() {
        for (script, cancel, timeout, expected) in [
            ("exit 0", false, 1000, ""),
            ("exit 1", false, 1000, "did not complete"),
            ("sleep 30", false, 20, "timed out"),
            ("sleep 30", true, 1000, "cancelled"),
        ] {
            let (send, receive) = watch::channel(cancel);
            let mut command = Command::new("/bin/sh");
            command.args(["-c", script]);
            let result = login_process(command, receive, Duration::from_millis(timeout)).await;
            if expected.is_empty() {
                assert!(result.is_ok());
            } else {
                assert!(result.unwrap_err().contains(expected));
            }
            drop(send);
        }
    }
}
