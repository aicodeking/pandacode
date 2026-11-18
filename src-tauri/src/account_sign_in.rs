//! One-click sign-in for a pool account (Settings → Connections → Add account…).
//!
//! Runs the harness's own login (`claude auth login --claudeai`, `codex login`) with the
//! account's config folder, the way the copied terminal command does. Both CLIs work without a
//! terminal: they open the provider's sign-in page in the default browser, wait for it on a
//! localhost callback and print a fallback link. Claude also takes a pasted code on stdin (its
//! fallback page shows one). The webview only ever gets the state, the allowlisted sign-in link
//! and a short fixed reason; the CLI's other output and the credentials it saves stay out of it.
use crate::Result;
use serde::Serialize;
use std::{collections::BTreeMap, future::Future, process::Stdio, sync::Mutex, time::Duration};
use tauri::Emitter;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Child,
    sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender},
};

const EVENT: &str = "account-sign-in";
const TIMEOUT: Duration = Duration::from_secs(10 * 60);
const MAX_CODE: usize = 4096;
/// Output kept for spotting the link and prompts; both appear in the first few hundred bytes.
const MAX_SCAN: usize = 64 * 1024;
/// Hosts a sign-in link may point at. Localhost callbacks are never opened.
const HOSTS: &[&str] = &["claude.ai", "claude.com", "auth.openai.com", "chatgpt.com"];
const HOST_SUFFIXES: &[&str] = &[".claude.ai", ".anthropic.com"];

enum Control {
    Code(String),
    Cancel,
}

/// Running sign-ins by connection id.
static RUNS: Mutex<BTreeMap<String, UnboundedSender<Control>>> = Mutex::new(BTreeMap::new());

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Update {
    id: String,
    /// `waiting`, `needs-code`, `done` or `failed`.
    state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

/// The first allowlisted `https` link in `text` that has been printed in full (whitespace after it).
fn sign_in_url(text: &str) -> Option<String> {
    let mut rest = text;
    while let Some(start) = rest.find("https://") {
        let tail = &rest[start..];
        let end = tail.find(char::is_whitespace)?;
        if let Some(url) = allowed(&tail[..end]) {
            return Some(url);
        }
        rest = &tail[end..];
    }
    None
}

fn allowed(candidate: &str) -> Option<String> {
    let url = tauri::Url::parse(candidate).ok()?;
    let host = url.host_str()?.to_ascii_lowercase();
    let ok = url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && candidate.len() <= 8192
        && (HOSTS.contains(&host.as_str()) || HOST_SUFFIXES.iter().any(|s| host.ends_with(s)));
    ok.then(|| url.to_string())
}

/// A pasted code: one line of printable text.
fn valid_code(code: &str) -> std::result::Result<&str, &'static str> {
    let code = code.trim();
    if code.is_empty() || code.chars().count() > MAX_CODE || code.chars().any(char::is_control) {
        return Err("Paste the code the sign-in page shows: one line, up to 4096 characters.");
    }
    Ok(code)
}

/// Watches a running login until it exits: reports the link (opening it unless the CLI says it
/// opened the browser itself) and the code prompt, passes a pasted code to stdin, and stops on
/// cancel or timeout. `Ok` means the CLI exited successfully.
async fn drive(mut child: Child, mut control: UnboundedReceiver<Control>, timeout: Duration, emit: impl Fn(&'static str, Option<&str>), open: impl Fn(&str)) -> std::result::Result<(), &'static str> {
    let (sender, mut chunks) = unbounded_channel::<Vec<u8>>();
    let pipes: [Option<Box<dyn tokio::io::AsyncRead + Unpin + Send>>; 2] = [child.stdout.take().map(|s| Box::new(s) as _), child.stderr.take().map(|s| Box::new(s) as _)];
    for mut pipe in pipes.into_iter().flatten() {
        let sender = sender.clone();
        tokio::spawn(async move {
            let mut buffer = vec![0; 4096];
            while let Ok(read @ 1..) = pipe.read(&mut buffer).await {
                if sender.send(buffer[..read].to_vec()).is_err() {
                    break;
                }
            }
        });
    }
    drop(sender);
    let mut stdin = child.stdin.take();
    let (mut seen, mut url, mut asked) = (Vec::new(), None::<String>, false);
    let deadline = tokio::time::sleep(timeout);
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            Some(chunk) = chunks.recv() => {
                if seen.len() < MAX_SCAN {
                    seen.extend_from_slice(&chunk);
                }
                let text = String::from_utf8_lossy(&seen);
                if url.is_none() {
                    if let Some(found) = sign_in_url(&text) {
                        // Both CLIs say "browser" when they open it themselves.
                        if !text.contains("browser") {
                            open(&found);
                        }
                        emit("waiting", Some(&found));
                        url = Some(found);
                    }
                }
                if !asked && text.contains("Paste code") {
                    asked = true;
                    emit("needs-code", url.as_deref());
                }
            }
            status = child.wait() => {
                if status.is_ok_and(|s| s.success()) {
                    return Ok(());
                }
                // The reason may still be in the pipes; they close with the process.
                let _ = tokio::time::timeout(Duration::from_secs(1), async { while let Some(chunk) = chunks.recv().await { seen.extend_from_slice(&chunk); } }).await;
                let text = String::from_utf8_lossy(&seen);
                return Err(if text.contains("wasn't accepted") || text.contains("Invalid code") {
                    "That code wasn't accepted. Start the sign-in again to get a new code."
                } else if text.contains("already in use") {
                    "Another sign-in is already running. Finish or close it, then try again."
                } else {
                    "The sign-in didn't finish. Try again, or copy the sign-in command and run it in a terminal."
                });
            }
            message = control.recv() => match message {
                Some(Control::Code(code)) => {
                    let written = match stdin.as_mut() {
                        Some(pipe) => pipe.write_all(format!("{code}\n").as_bytes()).await.and(pipe.flush().await).is_ok(),
                        None => false,
                    };
                    if !written {
                        let _ = child.kill().await;
                        return Err("Could not pass the code to the sign-in. Start it again.");
                    }
                }
                Some(Control::Cancel) | None => {
                    let _ = child.kill().await;
                    return Err("Sign-in cancelled.");
                }
            },
            () = &mut deadline => {
                let _ = child.kill().await;
                return Err("Sign-in timed out after 10 minutes. Start it again.");
            }
        }
    }
}

/// Drives the login to the end and reports `done` only when the account's folder holds a login.
async fn finish<V: Future<Output = bool>>(id: &str, child: Child, control: UnboundedReceiver<Control>, timeout: Duration, emit: impl Fn(Update), open: impl Fn(&str), verify: impl FnOnce() -> V) {
    let update = |state, url: Option<&str>, message: Option<&str>| Update { id: id.to_owned(), state, url: url.map(str::to_owned), message: message.map(str::to_owned) };
    let outcome = drive(child, control, timeout, |state, url| emit(update(state, url, None)), open).await;
    let outcome = match outcome {
        Ok(()) if verify().await => Ok(()),
        Ok(()) => Err("The sign-in finished, but no saved login was found in this account's folder."),
        Err(reason) => Err(reason),
    };
    if let Ok(mut runs) = RUNS.lock() {
        runs.remove(id);
    }
    emit(match outcome {
        Ok(()) => update("done", None, None),
        Err(reason) => update("failed", None, Some(reason)),
    });
}

/// Whether the pool now counts the account as signed in (the check Settings shows).
async fn signed_in(provider: String, id: &str) -> bool {
    let Ok(members) = crate::account_pool::account_pool_status(provider).await else { return false };
    members.iter().filter_map(|m| serde_json::to_value(m).ok()).any(|m| m["id"] == id && m["signedIn"] == true)
}

fn send(id: &str, message: Control) -> Result<()> {
    let runs = RUNS.lock().map_err(|e| e.to_string())?;
    runs.get(id).ok_or("This account isn't signing in.")?.send(message).map_err(|_| "This account isn't signing in.".into())
}

#[tauri::command]
pub async fn account_sign_in_start(app: tauri::AppHandle, id: String) -> Result<()> {
    let connection = crate::connections::get(&id).ok_or("This account no longer exists.")?;
    let provider = connection.provider.clone();
    if !crate::account_pool::POOLED.contains(&provider.as_str()) {
        return Err("One-click sign-in is available for Claude Code and Codex accounts.".into());
    }
    // Without its own folder the login would replace the main setup's.
    if connection.config_dir.is_none() {
        return Err("Give this account its own config folder first.".into());
    }
    let launch = crate::connections::launch(&connection)?;
    let name = if provider == "codex" { "Codex" } else { "Claude Code" };
    let path = launch.executable.clone().or_else(|| crate::providers::executable(&provider)).ok_or_else(|| format!("Could not find {name}. Install it or set its path in Settings."))?;
    let mut command = crate::providers::provider_command(&provider, &path)?;
    command.args(if provider == "codex" { &["login"][..] } else { &["auth", "login", "--claudeai"][..] });
    command.envs(launch.env.iter().map(|(k, v)| (k, v)));
    command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    let (sender, control) = unbounded_channel();
    let child = {
        let mut runs = RUNS.lock().map_err(|e| e.to_string())?;
        if runs.contains_key(&id) {
            return Err("This account is already signing in.".into());
        }
        let child = command.spawn().map_err(|_| format!("Could not start {name}. Install it or set its path in Settings."))?;
        runs.insert(id.clone(), sender);
        child
    };
    tauri::async_runtime::spawn(async move {
        let emit = |update: Update| { let _ = app.emit(EVENT, update); };
        let open = |url: &str| { tauri::async_runtime::spawn(crate::open_external_url(url.to_owned())); };
        finish(&id, child, control, TIMEOUT, emit, open, || signed_in(provider, &id)).await;
    });
    Ok(())
}

#[tauri::command]
pub async fn account_sign_in_code(id: String, code: String) -> Result<()> {
    let code = valid_code(&code)?.to_owned();
    send(&id, Control::Code(code))
}

#[tauri::command]
pub async fn account_sign_in_cancel(id: String) -> Result<()> {
    send(&id, Control::Cancel)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn links_are_taken_only_from_allowed_hosts_once_complete() {
        assert_eq!(sign_in_url("visit: https://claude.com/cai/oauth/authorize?code=true&x=1\n").as_deref(), Some("https://claude.com/cai/oauth/authorize?code=true&x=1"));
        let codex = "Starting local login server on http://localhost:1455.\n\nhttps://auth.openai.com/oauth/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3A1455 \n";
        assert_eq!(sign_in_url(codex).as_deref(), Some("https://auth.openai.com/oauth/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3A1455"));
        // Not printed in full yet.
        assert_eq!(sign_in_url("https://claude.com/cai/oauth/auth"), None);
        for bad in ["https://evil.com/x ", "https://claude.com.evil.com/x ", "https://user@claude.ai/x ", "https://claude.ai:8443/x ", "http://claude.ai/x ", "https://localhost:1455/cb ", "https://notanthropic.com/ "] {
            assert_eq!(sign_in_url(bad), None, "{bad}");
        }
        assert!(sign_in_url("see https://evil.com/a then https://console.anthropic.com/b\n").is_some_and(|u| u.starts_with("https://console.anthropic.com/")));
        assert!(sign_in_url("https://www.claude.ai/x\nhttps://chatgpt.com/y\n").is_some());
    }

    #[test]
    fn codes_must_be_one_printable_line() {
        assert_eq!(valid_code("  abc#def \n"), Ok("abc#def"));
        assert!(valid_code("").is_err());
        assert!(valid_code("a\nb").is_err());
        assert!(valid_code("a\u{7}b").is_err());
        assert!(valid_code(&"x".repeat(MAX_CODE + 1)).is_err());
        assert!(valid_code(&"x".repeat(MAX_CODE)).is_ok());
    }

    fn fake(script: &str) -> Child {
        tokio::process::Command::new("/bin/sh").args(["-c", script]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true).spawn().unwrap()
    }

    type Log = Arc<std::sync::Mutex<Vec<Update>>>;

    /// Runs a fake login to the end; returns the updates and the links PandaCode opened.
    async fn run(id: &str, script: &str, verified: bool, before: impl FnOnce(UnboundedSender<Control>, Log) -> tokio::task::JoinHandle<()>) -> (Vec<Update>, Vec<String>) {
        let (sender, control) = unbounded_channel();
        RUNS.lock().unwrap().insert(id.into(), sender.clone());
        let (log, opened): (Log, Arc<std::sync::Mutex<Vec<String>>>) = Default::default();
        let helper = before(sender, log.clone());
        let emit = { let log = log.clone(); move |u: Update| log.lock().unwrap().push(u) };
        let open = { let opened = opened.clone(); move |u: &str| opened.lock().unwrap().push(u.into()) };
        finish(id, fake(script), control, Duration::from_secs(10), emit, open, || async move { verified }).await;
        helper.abort();
        assert!(!RUNS.lock().unwrap().contains_key(id));
        let updates = log.lock().unwrap().clone();
        let opened = opened.lock().unwrap().clone();
        (updates, opened)
    }

    fn states(updates: &[Update]) -> Vec<&str> {
        updates.iter().map(|u| u.state).collect()
    }

    #[tokio::test]
    async fn a_link_then_a_successful_exit_is_done() {
        // Codex-like: the link on stderr, no word about a browser, so PandaCode opens it.
        let (updates, opened) = run("a", "echo 'SECRET-TOKEN-xyz'; echo 'go to https://auth.openai.com/oauth/authorize?a=1' >&2; sleep 0.3; exit 0", true, |_, _| tokio::spawn(async {})).await;
        assert_eq!(states(&updates), ["waiting", "done"]);
        assert_eq!(updates[0].url.as_deref(), Some("https://auth.openai.com/oauth/authorize?a=1"));
        assert_eq!(opened, ["https://auth.openai.com/oauth/authorize?a=1"]);
        assert!(!serde_json::to_string(&updates).unwrap().contains("SECRET"));
    }

    #[tokio::test]
    async fn a_pasted_code_reaches_stdin_and_finishes() {
        let script = "echo 'Opening browser to sign in'; echo 'visit: https://claude.com/cai/oauth?x=1'; printf 'Paste code here if prompted > '; read code; [ \"$code\" = 'abc#def' ]";
        let (updates, opened) = run("b", script, true, |sender, log| tokio::spawn(async move {
            while !log.lock().unwrap().iter().any(|u| u.state == "needs-code") { tokio::time::sleep(Duration::from_millis(20)).await; }
            sender.send(Control::Code("abc#def".into())).unwrap();
        })).await;
        assert_eq!(states(&updates), ["waiting", "needs-code", "done"]);
        assert_eq!(updates[1].url.as_deref(), Some("https://claude.com/cai/oauth?x=1"));
        // The CLI opened the browser itself.
        assert!(opened.is_empty());
    }

    #[tokio::test]
    async fn a_rejected_code_unsaved_login_and_cancel_fail_with_a_reason() {
        let rejected = "echo 'https://claude.com/a'; echo 'Login failed: That code wasn'\"'\"'t accepted.'; exit 1";
        let (updates, _) = run("c", rejected, true, |_, _| tokio::spawn(async {})).await;
        assert_eq!(updates.last().unwrap().message.as_deref(), Some("That code wasn't accepted. Start the sign-in again to get a new code."));
        let (updates, _) = run("d", "exit 0", false, |_, _| tokio::spawn(async {})).await;
        assert_eq!(states(&updates), ["failed"]);
        let (updates, _) = run("e", "echo 'https://claude.com/a'; sleep 30", true, |sender, log| tokio::spawn(async move {
            while log.lock().unwrap().is_empty() { tokio::time::sleep(Duration::from_millis(20)).await; }
            sender.send(Control::Cancel).unwrap();
        })).await;
        assert_eq!(states(&updates), ["waiting", "failed"]);
        assert_eq!(updates[1].message.as_deref(), Some("Sign-in cancelled."));
    }
}
