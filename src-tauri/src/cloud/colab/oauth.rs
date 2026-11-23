//! One-click Google sign-in for Colab. PandaCode ships no OAuth client: it uses the client
//! of the user's own Colab CLI (`~/.colab-cli-oauth-config.json`, or `oauth_config.json`
//! inside an installed `google-colab-cli`, installed with `uv` on first use), with the
//! standard installed-app loopback flow and PKCE. Only when the user picks **Use gcloud ADC**
//! (`authMode: "adc"`) does it use gcloud's application default credentials (`gcloud auth
//! application-default login`, which replaces gcloud's ADC file); it never does so on its own.
//!
//! Progress goes to the webview as `colab-sign-in` events, each with the attempt's `id`
//! (`colab/sign_in.rs`): `installing`, `waiting` (with the sign-in `url`), `exchanging`,
//! then `done` (with `detail`), `failed` (with `message`) or `cancelled`. Tokens never
//! leave the native side.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    io::BufRead,
    net::Ipv4Addr,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::Duration,
};
use tauri::{AppHandle, Emitter, Url};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::watch,
};

use super::sign_in::{self, SignInStarted, CANCELLED};
use super::store::{self, OAuthSecret};
use super::{form, send_text, token_request, Auth, Colab, Urls, INSTALL_HINT};
use crate::token_saver::find_tool;
use crate::workspace::run_process;

type Result<T> = std::result::Result<T, String>;

const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
/// Only what Colab's tunnel API and the account's email need.
pub const SCOPES: &str = "openid https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/colaboratory";
/// `gcloud auth application-default login` refuses a scope list without `cloud-platform`.
const ADC_SCOPES: &str = "--scopes=openid,https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/userinfo.email,https://www.googleapis.com/auth/colaboratory";
const COLAB_SCOPE: &str = "https://www.googleapis.com/auth/colaboratory";
const EVENT: &str = "colab-sign-in";
const WAIT: Duration = Duration::from_secs(10 * 60);
const INSTALL_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const REVOKE_TIMEOUT: Duration = Duration::from_secs(5);
const PATH_MAX: usize = 4096;
const NO_CLIENT: &str = "Google Colab sign-in needs the Google Colab CLI's OAuth client. Install uv (https://docs.astral.sh/uv/) so PandaCode can install google-colab-cli, or install google-colab-cli yourself, then try again. To sign in with gcloud instead, click Use gcloud ADC under More options.";
const CONFIG_SCRIPT: &str = "import importlib.resources; print(importlib.resources.files('colab_cli').joinpath('oauth_config.json').read_text())";
const DONE_PAGE: &str = "<!doctype html><meta charset=utf-8><title>PandaCode</title><body style=\"font:16px -apple-system,system-ui,sans-serif;display:grid;place-items:center;height:90vh;margin:0\"><div style=\"text-align:center\"><h2 style=\"font-weight:600\">Signed in to Google Colab</h2><p>You can close this tab and return to PandaCode.</p></div>";
const DENIED_PAGE: &str = "<!doctype html><meta charset=utf-8><title>PandaCode</title><body style=\"font:16px -apple-system,system-ui,sans-serif;display:grid;place-items:center;height:90vh;margin:0\"><div style=\"text-align:center\"><h2 style=\"font-weight:600\">Google Colab sign-in was not completed</h2><p>Return to PandaCode to try again.</p></div>";

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SignInOptions {
    /// An OAuth client file (`{"installed": {"client_id", "client_secret"}}`).
    pub oauth_config_path: Option<String>,
    /// `oauth2` (default) or `adc`.
    pub auth_mode: Option<String>,
}

/// An installed app's OAuth client, read from the user's machine at sign-in.
#[derive(Clone)]
pub(crate) struct Client {
    pub id: String,
    pub secret: String,
}

#[derive(Debug)]
pub(crate) struct SignedIn {
    pub email: String,
    pub mode: &'static str,
    pub secret: OAuthSecret,
}

/// What a flow talks to; tests use a mock and no browser.
struct Env {
    urls: Urls,
    open_browser: bool,
    wait: Duration,
}

type Emit<'a> = &'a (dyn Fn(Value) + Send + Sync);

/// Check the options before anything starts: a known mode, and an OAuth client file that
/// exists (`~/` expands to the home folder).
pub(crate) fn checked_options(options: SignInOptions) -> Result<SignInOptions> {
    if options.auth_mode.as_deref().is_some_and(|mode| !matches!(mode, "oauth2" | "adc")) {
        return Err("Choose oauth2 or adc to sign in to Google Colab.".into());
    }
    let oauth_config_path = match options.oauth_config_path.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
        Some(path) => Some(config_file(path, dirs::home_dir())?.display().to_string()),
        None => None,
    };
    Ok(SignInOptions { oauth_config_path, ..options })
}

/// An OAuth client file path, `~/` expanded against `home`.
pub(crate) fn config_file(path: &str, home: Option<PathBuf>) -> Result<PathBuf> {
    if path.len() > PATH_MAX || path.contains('\0') {
        return Err("Choose an OAuth client JSON file to sign in with.".into());
    }
    let expanded = match path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
        Some(rest) => home.ok_or("PandaCode could not find your home folder.")?.join(rest),
        None => PathBuf::from(path),
    };
    if !expanded.is_absolute() {
        return Err("Choose an OAuth client JSON file to sign in with (a full path such as ~/client.json).".into());
    }
    if !expanded.is_file() {
        return Err("That OAuth client file does not exist.".into());
    }
    Ok(expanded)
}

/// Start a sign-in in the background (cancelling any running one); progress is evented
/// with the returned attempt `id`.
pub fn sign_in_start(app: AppHandle, options: SignInOptions) -> Result<SignInStarted> {
    let options = checked_options(options)?;
    let (id, receiver) = sign_in::begin();
    tauri::async_runtime::spawn(async move {
        let events = app.clone();
        let emit = move |payload: Value| {
            let _ = events.emit(EVENT, sign_in::tag(id, payload));
        };
        let env = Env { urls: Urls::default(), open_browser: true, wait: WAIT };
        let outcome = match run(&env, &emit, receiver.clone(), &options).await {
            // Saved only while this attempt is current: a Cancel or Disconnect during the
            // exchange wins, and nothing is kept.
            Ok(signed) => sign_in::commit(id, &receiver, || super::persist(&signed.email, signed.mode, &signed.secret)),
            Err(error) => Err(error),
        };
        match outcome {
            Ok(detail) => {
                let _ = app.emit("vm-changed", json!({}));
                emit(json!({"state": "done", "detail": detail}));
            }
            Err(_) if sign_in::is_stale(id, &receiver) => emit(json!({"state": "cancelled"})),
            Err(error) => emit(json!({"state": "failed", "message": error})),
        }
        sign_in::finish(id);
    });
    Ok(SignInStarted { id })
}

pub fn sign_in_cancel() {
    sign_in::cancel();
}

/// Resolves once the sign-in is cancelled; never if its sender is gone without cancelling.
async fn cancelled(mut receiver: watch::Receiver<bool>) {
    while !*receiver.borrow_and_update() {
        if receiver.changed().await.is_err() {
            std::future::pending::<()>().await;
        }
    }
}

async fn run(env: &Env, emit: Emit<'_>, cancel: watch::Receiver<bool>, options: &SignInOptions) -> Result<SignedIn> {
    // gcloud's ADC file is shared with the user's other tools: replaced only when asked.
    if options.auth_mode.as_deref() == Some("adc") {
        return adc_sign_in(env, emit, cancel).await;
    }
    match client_config(options.oauth_config_path.as_deref(), emit, cancel.clone()).await? {
        Some(client) => loopback(env, emit, cancel, &client).await,
        None => Err(NO_CLIENT.into()),
    }
}

/// The client in an OAuth client file (`installed`, or `web`).
pub(crate) fn parse_client(text: &str) -> Result<Client> {
    let value: Value = serde_json::from_str(text.trim()).map_err(|_| "The OAuth client file is not readable JSON.".to_string())?;
    let section = if value["installed"].is_object() { &value["installed"] } else { &value["web"] };
    let field = |name: &str| section[name].as_str().map(str::trim).filter(|v| !v.is_empty()).map(str::to_string);
    match (field("client_id"), field("client_secret")) {
        (Some(id), Some(secret)) => Ok(Client { id, secret }),
        _ => Err("The OAuth client file has no client_id and client_secret.".into()),
    }
}

fn read_client_file(path: &Path) -> Result<Client> {
    let text = std::fs::read_to_string(path).map_err(|_| format!("Could not read {}.", path.display()))?;
    parse_client(&text)
}

fn home() -> Option<PathBuf> {
    dirs::home_dir()
}

async fn client_config(path: Option<&str>, emit: Emit<'_>, cancel: watch::Receiver<bool>) -> Result<Option<Client>> {
    if let Some(path) = path {
        return read_client_file(Path::new(path)).map(Some);
    }
    if let Some(file) = home().map(|home| home.join(".colab-cli-oauth-config.json")).filter(|file| file.is_file()) {
        return read_client_file(&file).map(Some);
    }
    if let Some(client) = tauri::async_runtime::spawn_blocking(installed_cli_client).await.ok().flatten() {
        return Ok(Some(client));
    }
    let Some(uv) = find_tool("uv") else { return Ok(None) };
    emit(json!({"state": "installing", "message": "Installing Google Colab CLI…"}));
    let install = tauri::async_runtime::spawn_blocking(move || run_install(&uv));
    tokio::select! {
        result = install => result.map_err(|_| "The Google Colab CLI install stopped.".to_string())??,
        () = cancelled(cancel) => return Err(CANCELLED.into()),
    }
    tauri::async_runtime::spawn_blocking(installed_cli_client).await.ok().flatten().map(Some).ok_or_else(|| "The Google Colab CLI was installed, but PandaCode could not read its sign-in configuration.".into())
}

pub(crate) fn run_install(uv: &Path) -> Result<()> {
    let out = run_process(super::uv_install_command(uv), "uv", 1 << 20, INSTALL_TIMEOUT)?;
    if out.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&out.stderr.bytes);
    Err(format!("Could not install the Google Colab CLI: {}", stderr.trim().lines().last().unwrap_or("uv failed.")))
}

/// The interpreter a script's `#!` line names, when it is a real file.
fn shebang_python(script: &Path) -> Option<PathBuf> {
    let file = std::fs::File::open(script).ok()?;
    let line = std::io::BufReader::new(file).lines().next()?.ok()?;
    let path = PathBuf::from(line.strip_prefix("#!")?.split_whitespace().next()?);
    // `#!/usr/bin/env python3` names whichever Python is first on PATH, not the tool's own.
    (path.is_file() && path.file_name().is_some_and(|name| name != "env")).then_some(path)
}

/// `oauth_config.json` of an installed `google-colab-cli`, read straight from disk first
/// (the `colab` command's own environment, then where uv and pipx put tool environments).
/// Only when neither layout has it is the CLI's interpreter asked (`-I`, no site hooks).
fn installed_cli_client() -> Option<Client> {
    let script = find_tool("colab");
    let envs = script.as_deref().map(script_envs).unwrap_or_default().into_iter().chain(tool_envs());
    envs.into_iter().find_map(|env| env_client(&env)).or_else(|| script.as_deref().and_then(shebang_python).and_then(|python| python_client(&python)))
}

/// The client file inside one tool environment, if that environment holds it.
fn env_client(env: &Path) -> Option<Client> {
    site_packages(env).into_iter().find_map(|site| read_client_file(&site.join("colab_cli/oauth_config.json")).ok())
}

fn python_client(python: &Path) -> Option<Client> {
    let mut command = Command::new(python);
    command.args(["-I", "-c", CONFIG_SCRIPT]);
    let out = run_process(command, "Python", 1 << 20, Duration::from_secs(30)).ok().filter(|out| out.status.success())?;
    parse_client(&String::from_utf8_lossy(&out.stdout.bytes)).ok()
}

/// The virtual environments a `colab` script may live in: its real location's `bin/..`
/// (uv and pipx link the script from `~/.local/bin`), and its `#!` interpreter's `bin/..`
/// (not resolved: a venv's python links to the base interpreter).
pub(crate) fn script_envs(script: &Path) -> Vec<PathBuf> {
    let env_of = |file: &Path| file.parent().and_then(Path::parent).map(Path::to_path_buf);
    let real = std::fs::canonicalize(script).ok();
    let mut envs: Vec<PathBuf> = real.as_deref().and_then(env_of).into_iter().chain(shebang_python(script).as_deref().and_then(env_of)).collect();
    envs.dedup();
    envs
}

fn tool_envs() -> Vec<PathBuf> {
    let home = home().unwrap_or_default();
    let data = std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).unwrap_or_else(|| home.join(".local/share"));
    let mut roots: Vec<PathBuf> = std::env::var_os("UV_TOOL_DIR").map(PathBuf::from).into_iter().collect();
    roots.push(data.join("uv/tools"));
    if let Some(appdata) = std::env::var_os("APPDATA") {
        roots.push(PathBuf::from(appdata).join("uv/data/tools"));
    }
    roots.extend([home.join(".local/pipx/venvs"), data.join("pipx/venvs")]);
    roots.into_iter().map(|root| root.join("google-colab-cli")).filter(|env| env.is_dir()).collect()
}

fn site_packages(env: &Path) -> Vec<PathBuf> {
    let mut found: Vec<PathBuf> = std::fs::read_dir(env.join("lib")).into_iter().flatten().flatten().map(|entry| entry.path().join("site-packages")).filter(|p| p.is_dir()).collect();
    found.push(env.join("Lib/site-packages"));
    found
}

/// 64 URL-safe characters from 48 random bytes.
pub(crate) fn pkce_verifier() -> String {
    let bytes: Vec<u8> = (0..3).flat_map(|_| uuid::Uuid::new_v4().into_bytes()).collect();
    URL_SAFE_NO_PAD.encode(bytes)
}
pub(crate) fn pkce_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

pub(crate) fn authorization_url(client_id: &str, redirect: &str, state: &str, challenge: &str) -> String {
    let mut url = Url::parse(AUTH_URL).expect("static URL");
    url.query_pairs_mut().extend_pairs([
        ("client_id", client_id),
        ("redirect_uri", redirect),
        ("response_type", "code"),
        ("scope", SCOPES),
        ("access_type", "offline"),
        ("prompt", "consent"),
        ("state", state),
        ("code_challenge", challenge),
        ("code_challenge_method", "S256"),
    ]);
    url.to_string()
}

/// What one request to the loopback redirect carried.
#[derive(Debug, PartialEq)]
pub(crate) enum Callback {
    /// Not the redirect (a favicon, a stray request): answer and keep waiting.
    Ignore,
    /// A redirect without this flow's state, or without a code: refuse and keep waiting.
    Invalid,
    Code(String),
    Denied(String),
}

pub(crate) fn callback(head: &str, state: &str) -> Callback {
    let mut parts = head.lines().next().unwrap_or_default().split_whitespace();
    let (Some("GET"), Some(target)) = (parts.next(), parts.next()) else { return Callback::Ignore };
    let Some(url) = target.starts_with('/').then(|| Url::parse(&format!("http://127.0.0.1{target}")).ok()).flatten() else { return Callback::Ignore };
    if url.path() != "/" {
        return Callback::Ignore;
    }
    let pairs: HashMap<String, String> = url.query_pairs().into_owned().collect();
    if pairs.get("state").map(String::as_str) != Some(state) {
        return Callback::Invalid;
    }
    if let Some(error) = pairs.get("error") {
        return Callback::Denied(error.chars().take(100).collect());
    }
    match pairs.get("code").filter(|code| !code.is_empty()) {
        Some(code) => Callback::Code(code.clone()),
        None => Callback::Invalid,
    }
}

async fn read_head(stream: &mut TcpStream) -> std::io::Result<String> {
    let mut head = Vec::new();
    let mut buffer = [0u8; 1024];
    while head.len() < 8192 && !head.windows(4).any(|w| w == b"\r\n\r\n") {
        let n = stream.read(&mut buffer).await?;
        if n == 0 {
            break;
        }
        head.extend_from_slice(&buffer[..n]);
    }
    Ok(String::from_utf8_lossy(&head).into_owned())
}

async fn respond(mut stream: TcpStream, status: &str, page: &str) {
    let reply = format!("HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{page}", page.len());
    let _ = stream.write_all(reply.as_bytes()).await;
    let _ = stream.shutdown().await;
}

/// Wait for Google's redirect to the loopback listener and return its code.
async fn wait_for_code(listener: &TcpListener, state: &str) -> Result<String> {
    loop {
        let (mut stream, _) = listener.accept().await.map_err(|_| "The sign-in listener stopped.".to_string())?;
        let Ok(Ok(head)) = tokio::time::timeout(Duration::from_secs(10), read_head(&mut stream)).await else { continue };
        match callback(&head, state) {
            Callback::Ignore => respond(stream, "404 Not Found", "").await,
            Callback::Invalid => respond(stream, "400 Bad Request", DENIED_PAGE).await,
            Callback::Denied(error) => {
                respond(stream, "200 OK", DENIED_PAGE).await;
                return Err(format!("Google sign-in was not completed ({error})."));
            }
            Callback::Code(code) => {
                respond(stream, "200 OK", DONE_PAGE).await;
                return Ok(code);
            }
        }
    }
}

async fn exchange(urls: &Urls, client: &Client, code: &str, redirect: &str, verifier: &str) -> Result<OAuthSecret> {
    let body = form(&[("code", code), ("client_id", &client.id), ("client_secret", &client.secret), ("redirect_uri", redirect), ("grant_type", "authorization_code"), ("code_verifier", verifier)]);
    let reply = token_request(urls, body).await?;
    let text = |name: &str| reply[name].as_str().filter(|v| !v.is_empty()).map(str::to_string);
    let access_token = text("access_token").ok_or("Google did not return an access token.")?;
    let refresh_token = text("refresh_token").ok_or("Google did not return a refresh token. Remove PandaCode's access at myaccount.google.com/permissions and sign in again.")?;
    Ok(OAuthSecret { client_id: client.id.clone(), client_secret: client.secret.clone(), refresh_token, access_token, expires_at: super::now() + reply["expires_in"].as_i64().unwrap_or(3600) })
}

/// The account's email and the token's scopes. The token goes in a POST body, never in a
/// URL that proxies and logs might keep.
async fn tokeninfo(urls: &Urls, token: &str) -> Result<(String, String)> {
    let client = super::super::http::client(Duration::from_secs(30))?;
    let request = client.post(&urls.tokeninfo).header(reqwest::header::CONTENT_TYPE, "application/x-www-form-urlencoded").body(form(&[("access_token", token)]));
    let reply = super::parse("Google", &send_text("Google", request, 1 << 20).await?)?;
    let email = reply["email"].as_str().filter(|e| e.contains('@')).ok_or("Google did not share the account's email address.")?;
    Ok((email.to_string(), reply["scope"].as_str().unwrap_or_default().to_string()))
}

/// Ask Google to revoke `token` (best effort, a few seconds at most): Disconnect then ends
/// the grant on Google's side too, not only on this computer.
pub(crate) async fn revoke(urls: &Urls, token: &str) {
    if token.is_empty() {
        return;
    }
    let Ok(client) = super::super::http::client(REVOKE_TIMEOUT) else { return };
    let request = client.post(&urls.revoke).header(reqwest::header::CONTENT_TYPE, "application/x-www-form-urlencoded").body(form(&[("token", token)]));
    let _ = send_text("Google", request, 1 << 16).await;
}

async fn verify_colab(urls: &Urls, token: &str) -> Result<()> {
    let colab = Colab::with(urls.clone(), Auth::Token(token.to_string()), PathBuf::new(), Duration::ZERO);
    colab.assignments().await.map(|_| ()).map_err(|error| format!("Signed in, but Google Colab did not accept the account: {error}"))
}

async fn loopback(env: &Env, emit: Emit<'_>, cancel: watch::Receiver<bool>, client: &Client) -> Result<SignedIn> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.map_err(|_| "Could not open a local port for the sign-in.".to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect = format!("http://127.0.0.1:{port}");
    let state = uuid::Uuid::new_v4().simple().to_string();
    let verifier = pkce_verifier();
    let url = authorization_url(&client.id, &redirect, &state, &pkce_challenge(&verifier));
    if env.open_browser {
        // When the browser does not open, the waiting event still carries the link.
        let _ = crate::open_external_url(url.clone()).await;
    }
    emit(json!({"state": "waiting", "url": url}));
    let code = tokio::select! {
        code = wait_for_code(&listener, &state) => code?,
        () = cancelled(cancel.clone()) => return Err(CANCELLED.into()),
        () = tokio::time::sleep(env.wait) => return Err("Google sign-in timed out. Try again.".into()),
    };
    drop(listener);
    emit(json!({"state": "exchanging"}));
    let finish = async {
        let secret = exchange(&env.urls, client, &code, &redirect, &verifier).await?;
        let (email, _) = tokeninfo(&env.urls, &secret.access_token).await?;
        verify_colab(&env.urls, &secret.access_token).await?;
        Ok(SignedIn { email, mode: "oauth2", secret })
    };
    tokio::select! {
        signed = finish => signed,
        () = cancelled(cancel) => Err(CANCELLED.into()),
    }
}

/// gcloud's application default credentials, checked for Colab's scope and access.
pub(crate) async fn adc_verify(urls: &Urls) -> Result<SignedIn> {
    let credentials = store::load_adc()?;
    let (token, expires_at, _) = super::refresh(urls, &credentials).await?;
    let (email, scope) = tokeninfo(urls, &token).await?;
    if !scope.split_whitespace().any(|s| s == COLAB_SCOPE) {
        return Err("gcloud's application default credentials lack Colab's scope. Sign in with Google again to add it.".into());
    }
    verify_colab(urls, &token).await?;
    Ok(SignedIn { email, mode: "adc", secret: OAuthSecret { access_token: token, expires_at, ..OAuthSecret::default() } })
}

async fn adc_sign_in(env: &Env, emit: Emit<'_>, cancel: watch::Receiver<bool>) -> Result<SignedIn> {
    if let Ok(signed) = adc_verify(&env.urls).await {
        return Ok(signed);
    }
    let gcloud = find_tool("gcloud").ok_or_else(|| format!("gcloud is not installed. {INSTALL_HINT}"))?;
    emit(json!({"state": "waiting", "message": "Finish signing in to Google in your browser…"}));
    let mut child = tokio::process::Command::new(gcloud)
        .args(["auth", "application-default", "login", ADC_SCOPES])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| "Could not start gcloud.".to_string())?;
    tokio::select! {
        status = child.wait() => {
            if !status.is_ok_and(|s| s.success()) {
                return Err("gcloud did not finish signing in.".into());
            }
        }
        () = cancelled(cancel.clone()) => {
            let _ = child.kill().await;
            return Err(CANCELLED.into());
        }
        () = tokio::time::sleep(env.wait) => {
            let _ = child.kill().await;
            return Err("Google sign-in timed out. Try again.".into());
        }
    }
    emit(json!({"state": "exchanging"}));
    tokio::select! {
        signed = adc_verify(&env.urls) => signed,
        () = cancelled(cancel) => Err(CANCELLED.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud::http::mock;

    #[test]
    fn reads_installed_and_web_clients_only_when_complete() {
        let client = parse_client(r#"{"installed":{"client_id":"id.apps","client_secret":"s"}}"#).unwrap();
        assert_eq!((client.id.as_str(), client.secret.as_str()), ("id.apps", "s"));
        assert_eq!(parse_client(r#"{"web":{"client_id":"w","client_secret":"x"}}"#).unwrap().id, "w");
        assert!(parse_client(r#"{"installed":{"client_id":"id"}}"#).is_err());
        assert!(parse_client("[]").is_err());
    }

    #[test]
    fn builds_the_authorization_url_with_pkce() {
        let verifier = pkce_verifier();
        assert_eq!(verifier.len(), 64);
        assert!(verifier.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'));
        assert_ne!(verifier, pkce_verifier());
        assert_eq!(pkce_challenge("pandacode-verifier"), "QvHeFN_Y2akQADORQV7pbkwiw2V3RKJCMgdBn0q2xnY");
        let url = Url::parse(&authorization_url("cid", "http://127.0.0.1:5000", "st", "ch")).unwrap();
        let pairs: HashMap<String, String> = url.query_pairs().into_owned().collect();
        assert_eq!(url.host_str(), Some("accounts.google.com"));
        for (key, value) in [("client_id", "cid"), ("redirect_uri", "http://127.0.0.1:5000"), ("response_type", "code"), ("access_type", "offline"), ("prompt", "consent"), ("state", "st"), ("code_challenge", "ch"), ("code_challenge_method", "S256"), ("scope", SCOPES)] {
            assert_eq!(pairs.get(key).map(String::as_str), Some(value), "{key}");
        }
        let scopes: Vec<&str> = SCOPES.split_whitespace().collect();
        assert_eq!(scopes, ["openid", "https://www.googleapis.com/auth/userinfo.profile", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/colaboratory"], "only what Colab needs");
        assert!(ADC_SCOPES.contains("cloud-platform"), "gcloud requires cloud-platform for ADC");
    }

    #[test]
    fn the_callback_needs_this_flows_state() {
        let state = "abc123";
        assert_eq!(callback("GET /?code=4/xyz&state=abc123 HTTP/1.1\r\n", state), Callback::Code("4/xyz".into()));
        assert_eq!(callback("GET /favicon.ico HTTP/1.1\r\n", state), Callback::Ignore);
        assert_eq!(callback("GET /?code=4/xyz&state=evil HTTP/1.1\r\n", state), Callback::Invalid);
        assert_eq!(callback("GET /?error=access_denied HTTP/1.1\r\n", state), Callback::Invalid, "an error without the state must not end the flow");
        assert_eq!(callback("GET /?error=access_denied&state=abc123 HTTP/1.1\r\n", state), Callback::Denied("access_denied".into()));
        assert_eq!(callback("POST /?code=x&state=abc123 HTTP/1.1\r\n", state), Callback::Ignore);
        assert_eq!(callback("GET http://evil/?code=x&state=abc123 HTTP/1.1\r\n", state), Callback::Ignore);
    }

    #[tokio::test]
    async fn the_loopback_flow_signs_in_end_to_end() {
        let (base, seen) = mock::serve(|request, _| -> (u16, String) {
            match (request.method.as_str(), request.path.split('?').next().unwrap()) {
                ("POST", "/token") => (200, r#"{"access_token":"ya29.a","refresh_token":"1//r","expires_in":3599}"#.into()),
                ("POST", "/tokeninfo") => (200, r#"{"email":"dev@example.test","scope":"openid https://www.googleapis.com/auth/colaboratory"}"#.into()),
                ("GET", "/tun/m/assignments") => (200, ")]}'\n{\"assignments\":[]}".into()),
                _ => (404, "{}".into()),
            }
        });
        let (sender, mut events) = tokio::sync::mpsc::unbounded_channel::<Value>();
        let emit = move |payload: Value| {
            let _ = sender.send(payload);
        };
        let browser = tokio::spawn(async move {
            let waiting = loop {
                let event = events.recv().await.unwrap();
                if event["state"] == "waiting" {
                    break event;
                }
            };
            let url = Url::parse(waiting["url"].as_str().unwrap()).unwrap();
            let pairs: HashMap<String, String> = url.query_pairs().into_owned().collect();
            let redirect = pairs["redirect_uri"].clone();
            let get = |target: String| async move {
                let address = target.trim_start_matches("http://").split('/').next().unwrap().to_string();
                let mut stream = TcpStream::connect(address).await.unwrap();
                let path = target.splitn(4, '/').nth(3).map(|p| format!("/{p}")).unwrap_or_else(|| "/".into());
                stream.write_all(format!("GET {path} HTTP/1.1\r\nHost: x\r\n\r\n").as_bytes()).await.unwrap();
                let mut reply = String::new();
                stream.read_to_string(&mut reply).await.unwrap();
                reply
            };
            assert!(get(format!("{redirect}/favicon.ico")).await.starts_with("HTTP/1.1 404"));
            assert!(get(format!("{redirect}/?code=stolen&state=wrong")).await.starts_with("HTTP/1.1 400"));
            let done = get(format!("{redirect}/?code=4%2Fgood&state={}", pairs["state"])).await;
            assert!(done.contains("Signed in to Google Colab"));
            (pairs["code_challenge"].clone(), redirect, events)
        });
        let env = Env { urls: Urls::mock(&base), open_browser: false, wait: Duration::from_secs(20) };
        let (_keep, receiver) = watch::channel(false);
        let client = Client { id: "cid".into(), secret: "csecret".into() };
        let signed = loopback(&env, &emit, receiver, &client).await.unwrap();
        let (challenge, redirect, mut events) = browser.await.unwrap();
        assert_eq!(signed.email, "dev@example.test");
        assert_eq!(signed.mode, "oauth2");
        assert_eq!((signed.secret.refresh_token.as_str(), signed.secret.access_token.as_str(), signed.secret.client_id.as_str()), ("1//r", "ya29.a", "cid"));
        assert!(signed.secret.expires_at > super::super::now());
        assert_eq!(events.recv().await.unwrap()["state"], "exchanging");
        let log = seen.lock().unwrap();
        let token = log.iter().find(|r| r.path == "/token").unwrap();
        let form: HashMap<String, String> = Url::parse(&format!("http://x/?{}", token.body)).unwrap().query_pairs().into_owned().collect();
        assert_eq!(form["code"], "4/good");
        assert_eq!(form["grant_type"], "authorization_code");
        assert_eq!(form["redirect_uri"], redirect);
        assert_eq!(form["client_secret"], "csecret");
        assert_eq!(pkce_challenge(&form["code_verifier"]), challenge, "the verifier must match the S256 challenge");
        let info = log.iter().find(|r| r.path.starts_with("/tokeninfo")).unwrap();
        assert_eq!((info.method.as_str(), info.path.as_str(), info.body.as_str()), ("POST", "/tokeninfo", "access_token=ya29.a"), "the token stays out of the URL");
        let colab = log.iter().find(|r| r.path.starts_with("/tun/m/assignments")).unwrap();
        assert_eq!(colab.authorization.as_deref(), Some("Bearer ya29.a"));
        assert!(colab.path.contains("authuser=0"));
    }

    #[tokio::test]
    async fn cancelling_ends_the_wait() {
        let env = Env { urls: Urls::mock("http://127.0.0.1:9"), open_browser: false, wait: Duration::from_secs(30) };
        let (sender, receiver) = watch::channel(false);
        let emit = |_: Value| {};
        let client = Client { id: "c".into(), secret: "s".into() };
        let flow = loopback(&env, &emit, receiver, &client);
        let cancel = async {
            tokio::time::sleep(Duration::from_millis(50)).await;
            sender.send(true).unwrap();
        };
        let (result, ()) = tokio::join!(flow, cancel);
        assert_eq!(result.err().as_deref(), Some(CANCELLED));
    }

    #[tokio::test]
    async fn a_timeout_ends_the_wait() {
        let env = Env { urls: Urls::mock("http://127.0.0.1:9"), open_browser: false, wait: Duration::from_millis(50) };
        let (_keep, receiver) = watch::channel(false);
        let emit = |_: Value| {};
        let client = Client { id: "c".into(), secret: "s".into() };
        assert!(loopback(&env, &emit, receiver, &client).await.unwrap_err().contains("timed out"));
    }

    #[tokio::test]
    async fn cancelling_during_the_exchange_returns_cancelled() {
        // Google is slow to answer the token exchange; Cancel lands meanwhile.
        let (base, _) = mock::serve(|request, _| -> (u16, String) {
            if request.path == "/token" {
                std::thread::sleep(Duration::from_millis(400));
            }
            (200, r#"{"access_token":"a","refresh_token":"r","email":"x@y.z"}"#.into())
        });
        let env = Env { urls: Urls::mock(&base), open_browser: false, wait: Duration::from_secs(20) };
        let (sender, receiver) = watch::channel(false);
        let (events, mut seen) = tokio::sync::mpsc::unbounded_channel::<Value>();
        let emit = move |payload: Value| {
            let _ = events.send(payload);
        };
        let client = Client { id: "c".into(), secret: "s".into() };
        let browser = async {
            let waiting = seen.recv().await.unwrap();
            let url = Url::parse(waiting["url"].as_str().unwrap()).unwrap();
            let pairs: HashMap<String, String> = url.query_pairs().into_owned().collect();
            let address = pairs["redirect_uri"].trim_start_matches("http://").to_string();
            let mut stream = TcpStream::connect(address).await.unwrap();
            stream.write_all(format!("GET /?code=c&state={} HTTP/1.1\r\n\r\n", pairs["state"]).as_bytes()).await.unwrap();
            assert_eq!(seen.recv().await.unwrap()["state"], "exchanging");
            sender.send(true).unwrap();
        };
        let (result, ()) = tokio::join!(loopback(&env, &emit, receiver, &client), browser);
        assert_eq!(result.err().as_deref(), Some(CANCELLED));
    }

    #[tokio::test]
    async fn revoking_posts_the_token_in_the_body_and_ignores_failures() {
        let (base, seen) = mock::serve(|_, _| -> (u16, String) { (400, r#"{"error":"invalid_token"}"#.into()) });
        revoke(&Urls::mock(&base), "1//refresh").await;
        revoke(&Urls::mock(&base), "").await;
        revoke(&Urls::mock("http://127.0.0.1:9"), "unreachable").await;
        let log = seen.lock().unwrap();
        assert_eq!(log.len(), 1, "an empty token sends nothing");
        assert_eq!((log[0].method.as_str(), log[0].path.as_str(), log[0].body.as_str()), ("POST", "/revoke", "token=1%2F%2Frefresh"));
    }

    #[test]
    fn oauth_client_paths_expand_home_and_must_exist() {
        let dir = std::env::temp_dir().join(format!("pandacode-colab-client-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("client.json"), "{}").unwrap();
        assert_eq!(config_file("~/client.json", Some(dir.clone())).unwrap(), dir.join("client.json"));
        assert_eq!(config_file(&dir.join("client.json").display().to_string(), None).unwrap(), dir.join("client.json"));
        assert_eq!(config_file("~/missing.json", Some(dir.clone())).unwrap_err(), "That OAuth client file does not exist.");
        assert!(config_file("relative.json", Some(dir.clone())).unwrap_err().contains("full path"));
        assert!(config_file("~/client.json", None).is_err());
        assert!(checked_options(SignInOptions { auth_mode: Some("magic".into()), ..SignInOptions::default() }).is_err());
        let blank = checked_options(SignInOptions { oauth_config_path: Some("  ".into()), auth_mode: Some("adc".into()) }).unwrap();
        assert_eq!(blank.oauth_config_path, None);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn finds_the_client_file_in_the_cli_environment_without_running_it() {
        let root = std::env::temp_dir().join(format!("pandacode-colab-env-{}", uuid::Uuid::new_v4().simple()));
        let env = root.join("google-colab-cli");
        let package = env.join("lib/python3.12/site-packages/colab_cli");
        std::fs::create_dir_all(&package).unwrap();
        std::fs::create_dir_all(env.join("bin")).unwrap();
        std::fs::write(package.join("oauth_config.json"), r#"{"installed":{"client_id":"cli-id","client_secret":"cli-secret"}}"#).unwrap();
        // A script whose interpreter would fail if it were ever run.
        let python = env.join("bin/python3");
        std::fs::write(&python, "").unwrap();
        let script = env.join("bin/colab");
        std::fs::write(&script, format!("#!{}\n", python.display())).unwrap();
        let envs = script_envs(&script);
        assert!(envs.iter().any(|found| found.canonicalize().unwrap() == env.canonicalize().unwrap()), "{envs:?}");
        let client = envs.iter().find_map(|found| env_client(found)).unwrap();
        assert_eq!((client.id.as_str(), client.secret.as_str()), ("cli-id", "cli-secret"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reads_the_interpreter_from_a_shebang() {
        let dir = std::env::temp_dir().join(format!("pandacode-colab-shebang-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let python = dir.join("python3");
        std::fs::write(&python, "").unwrap();
        let script = dir.join("colab");
        std::fs::write(&script, format!("#!{} -I\nimport sys\n", python.display())).unwrap();
        assert_eq!(shebang_python(&script), Some(python));
        std::fs::write(&script, "#!/usr/bin/env python3\n").unwrap();
        assert_eq!(shebang_python(&script), None);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
