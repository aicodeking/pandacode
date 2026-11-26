//! Google Colab runtimes for cloud agents, the `pandacode_vm_*` tools and the native
//! `pandacode_colab_*` tools (docs/cloud-agents.md). The protocol is the one Google's own
//! `google-colab-cli` speaks: Colab's tunnel API on colab.research.google.com assigns and
//! releases runtimes (JSON behind an XSSI prefix), and each runtime's proxy serves Jupyter
//! (kernels, contents) and a WebSocket that carries SSH (`colab/tunnel.rs`).
//!
//! Sign-in is Google OAuth2 with the OAuth client of the user's installed Colab CLI, or
//! gcloud's application default credentials (`colab/oauth.rs`); PandaCode ships no client ID
//! or secret. The sign-in lives in the secure store (`colab_oauth`), the non-secret options
//! in `cloud::Settings.providers["colab"]`, and runtimes in `colab-sessions.json`.
pub mod activity;
pub mod jupyter;
mod oauth;
mod settings;
mod sign_in;
pub mod store;
mod tunnel;

use serde_json::Value;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::Url;

use super::http::block;
use super::sandbox::{checked, Info, Sandbox};
use super::Machine;
use settings::{auth_mode, options};
use store::{OAuthSecret, Records, SessionRecord};

pub use oauth::{sign_in_cancel, sign_in_start, SignInOptions};
pub(crate) use settings::{persist, uv_install_command};
#[cfg(test)]
pub(crate) use settings::{apply_options, local_config, signed_in_options};
pub use settings::{colab_mcp_command, config, connect, default_hardware, disconnect, install_cli, is_connected, native_tools_enabled, update_config, usage_summary, ColabConfig, ColabUsage};
pub use sign_in::{SignInStarted, SignInStatus};

/// The current sign-in attempt's last state, for Settings reopened mid-sign-in.
pub fn sign_in_status() -> Option<SignInStatus> {
    sign_in::status()
}

type Result<T> = std::result::Result<T, String>;

pub const PROVIDER: &str = "colab";
pub(crate) const SECRET: &str = "colab_oauth";
pub const ACCELERATORS: [&str; 8] = ["NONE", "T4", "L4", "G4", "A100", "H100", "V5E1", "V6E1"];
pub const GPUS: [&str; 5] = ["T4", "L4", "G4", "A100", "H100"];
pub const TPUS: [&str; 2] = ["V5E1", "V6E1"];
/// Accelerators with a single (high-memory) shape: `shape=hm` is not sent for them.
const HIGH_MEM_ONLY: [&str; 3] = ["L4", "V5E1", "V6E1"];
/// Google's Colab MCP server, pinned to a reviewed commit (`uvx` runs it).
pub const COLAB_MCP_PKG: &str = "git+https://github.com/googlecolab/colab-mcp@b9ab3899e0f1fa493390b1fd6d54aa2e464ecdf1";
/// The Colab CLI whose OAuth client the sign-in uses, pinned (`uv tool install`).
pub const COLAB_CLI_PKG: &str = "google-colab-cli==0.8.0";
/// Starts an error that means the runtime is gone for good: retrying callers (the cloud
/// bridge) stop instead of waiting for it to come back.
pub const MACHINE_GONE: &str = "machine-gone: ";
const COLAB: &str = "https://colab.research.google.com";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const TOKENINFO_URL: &str = "https://oauth2.googleapis.com/tokeninfo";
const REVOKE_URL: &str = "https://oauth2.googleapis.com/revoke";
const XSSI: &str = ")]}'\n";
const CLIENT_AGENT: &str = "colab-cli";
/// Tokens are renewed this many seconds before they expire.
const REFRESH_MARGIN: i64 = 300;
const LIMIT: usize = 16 << 20;
const QUICK: Duration = Duration::from_secs(30);
const ASSIGN_TIMEOUT: Duration = Duration::from_secs(75);
const ASSIGN_BUDGET: Duration = Duration::from_secs(165);
const RECONCILE_RESERVE: Duration = Duration::from_secs(20);
const MIN_POST_BUDGET: Duration = Duration::from_secs(5);
const ASSIGN_RETRIES: u32 = 3;
/// Colab disconnects an idle runtime after about 90 minutes without a client. A keep-alive
/// asking for less (the 15 idle minutes after a cloud run) is not sent, so a finished run
/// does not keep a billed runtime for another 90.
const UNATTENDED_MINUTES: u32 = 90;
const SERVICE: &str = "Google Colab";
const GONE: &str = "That Colab runtime no longer exists. Create a new one.";
const NO_RESTART: &str = "Colab runtimes cannot be restarted once stopped; create a new runtime.";
const INSTALL_HINT: &str = "Install uv (https://docs.astral.sh/uv/) so PandaCode can run `uv tool install google-colab-cli`, or install the Google Cloud CLI (gcloud), then try again.";

pub(crate) fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or_default()
}

/// Where Google's APIs live; tests point them at a loopback mock.
#[derive(Clone, Debug)]
pub(crate) struct Urls {
    pub colab: String,
    pub token: String,
    pub tokeninfo: String,
    pub revoke: String,
}
impl Default for Urls {
    fn default() -> Self {
        Urls { colab: COLAB.into(), token: TOKEN_URL.into(), tokeninfo: TOKENINFO_URL.into(), revoke: REVOKE_URL.into() }
    }
}
#[cfg(test)]
impl Urls {
    pub fn mock(base: &str) -> Self {
        Urls { colab: base.into(), token: format!("{base}/token"), tokeninfo: format!("{base}/tokeninfo"), revoke: format!("{base}/revoke") }
    }
}

/// `NONE` is a CPU runtime (variant DEFAULT); TPUs are TPU; the rest GPU.
pub fn variant(accelerator: &str) -> &'static str {
    match accelerator {
        "NONE" => "DEFAULT",
        a if TPUS.contains(&a) => "TPU",
        _ => "GPU",
    }
}
/// The assign URL's `shape` value: `hm` for High-RAM, unless the accelerator has one shape.
pub fn shape_param(accelerator: &str, high_mem: bool) -> Option<&'static str> {
    (high_mem && !HIGH_MEM_ONLY.contains(&accelerator)).then_some("hm")
}
/// An accelerator name as Colab spells it; empty and `CPU` mean `NONE`.
pub fn parse_accelerator(text: &str) -> Result<String> {
    let upper = text.trim().to_ascii_uppercase();
    let upper = if upper.is_empty() || upper == "CPU" { "NONE".to_string() } else { upper };
    ACCELERATORS.contains(&upper.as_str()).then_some(upper).ok_or_else(|| format!("Choose a Colab accelerator: {}.", ACCELERATORS.join(", ")))
}
/// A readable hardware name for a Colab accelerator code (`V5E1` is `v5e-1 TPU`); a
/// label passes through. The one spelling for tools, machines and the thread indicator.
pub fn hardware_label(accelerator: &str) -> String {
    match accelerator.trim().to_ascii_uppercase().as_str() {
        "" | "NONE" | "CPU" => "CPU".into(),
        "V5E1" => "v5e-1 TPU".into(),
        "V6E1" => "v6e-1 TPU".into(),
        code if GPUS.contains(&code) => format!("{code} GPU"),
        _ => accelerator.trim().to_string(),
    }
}
pub(crate) fn shape_label(machine_shape: &str) -> &'static str {
    if machine_shape == "HIGH_RAM" { "High-RAM" } else { "Standard" }
}
/// Colab's notebook hash for an assignment: a UUID with `_` for `-`, padded with `.` to 44.
pub fn nbh(id: uuid::Uuid) -> String {
    let text = id.to_string().replace('-', "_");
    format!("{text:.<44}")
}
pub(crate) fn strip_xssi(text: &str) -> &str {
    text.strip_prefix(XSSI).unwrap_or(text)
}
/// The page that opens a runtime in Colab's own notebook UI.
pub fn browser_url(endpoint: &str) -> String {
    format!("{COLAB}/notebooks/empty.ipynb?dbu=%2Ftun%2Fm%2F{endpoint}#datalabBackendUrl={COLAB}/tun/m/{endpoint}")
}
/// Settings → Cloud's line: the account, then non-default hardware. High-RAM is named only
/// where it is a choice (single-shape accelerators have one size).
pub fn detail(email: &str, accelerator: &str, high_mem: bool) -> String {
    let high_mem = shape_param(accelerator, high_mem).is_some();
    let mut parts = vec![email.to_string()];
    if accelerator != "NONE" || high_mem {
        parts.push(hardware_label(accelerator));
    }
    if high_mem {
        parts.push("High-RAM".into());
    }
    parts.join(" · ")
}
/// A form body (`application/x-www-form-urlencoded`).
pub(crate) fn form(pairs: &[(&str, &str)]) -> String {
    let mut url = Url::parse("http://form.invalid/").expect("static URL");
    url.query_pairs_mut().extend_pairs(pairs);
    url.query().unwrap_or_default().to_string()
}

fn variant_name(value: &Value) -> String {
    match (value.as_i64(), value.as_str()) {
        (Some(1), _) => "GPU".into(),
        (Some(2), _) => "TPU".into(),
        (_, Some(text)) if !text.is_empty() => text.to_string(),
        _ => "DEFAULT".into(),
    }
}
fn shape_name(value: &Value) -> String {
    if value.as_i64() == Some(1) || value.as_str() == Some("HIGH_RAM") { "HIGH_RAM".into() } else { "STANDARD".into() }
}

/// Fold Colab's assignment list into the known runtimes: keep names and kernels, refresh
/// proxy URLs and tokens, drop runtimes Colab no longer has, except ones created at or after
/// `fetched_at` (the list was asked for before they existed).
pub(crate) fn reconcile(known: &Records, assignments: &[Value], now: i64, fetched_at: i64) -> Records {
    let listed: Records = assignments
        .iter()
        .filter_map(|item| {
            let endpoint = item["endpoint"].as_str().filter(|e| super::valid_native(e))?;
            let proxy = &item["runtimeProxyInfo"];
            let old = known.get(endpoint).cloned().unwrap_or_default();
            let record = SessionRecord {
                name: if old.name.is_empty() { endpoint.to_string() } else { old.name },
                endpoint: endpoint.to_string(),
                url: proxy["url"].as_str().map(str::to_string).unwrap_or(old.url),
                token: proxy["token"].as_str().map(str::to_string).unwrap_or(old.token),
                token_expires_at: proxy["tokenExpiresInSeconds"].as_i64().map_or(old.token_expires_at, |seconds| now + seconds),
                accelerator: item["accelerator"].as_str().map(str::to_string).unwrap_or(old.accelerator),
                variant: variant_name(&item["variant"]),
                machine_shape: shape_name(&item["machineShape"]),
                kernel_id: old.kernel_id,
                created_at: old.created_at,
                session_id: old.session_id,
            };
            Some((endpoint.to_string(), record))
        })
        .collect();
    let newer: Records = known.iter().filter(|(endpoint, record)| record.created_at >= fetched_at && !listed.contains_key(*endpoint)).map(|(endpoint, record)| (endpoint.clone(), record.clone())).collect();
    listed.into_iter().chain(newer).collect()
}

pub fn machine(record: &SessionRecord) -> Machine {
    Machine {
        id: format!("colab:{}", record.endpoint),
        provider: PROVIDER.into(),
        name: if record.name.is_empty() { record.endpoint.clone() } else { record.name.clone() },
        state: "running".into(),
        os: "linux".into(),
        desktop: false,
        detail: format!("Google Colab · {} · {}", hardware_label(&record.accelerator), shape_label(&record.machine_shape)),
    }
}

/// A failed request: the HTTP status when there was one, and a readable message.
#[derive(Debug)]
pub(crate) struct Failure {
    pub status: Option<u16>,
    pub timed_out: bool,
    pub transport: bool,
    pub tls: bool,
    pub message: String,
}
impl From<Failure> for String {
    fn from(failure: Failure) -> String {
        failure.message
    }
}
impl From<String> for Failure {
    fn from(message: String) -> Failure {
        Failure { status: None, timed_out: false, transport: false, tls: false, message }
    }
}

/// Send a request and return the body, at most `limit` bytes, XSSI prefix removed.
pub(crate) async fn send_text(service: &str, request: reqwest::RequestBuilder, limit: usize) -> std::result::Result<String, Failure> {
    send_text_until(service, request, limit, None).await
}

async fn send_text_until(
    service: &str,
    request: reqwest::RequestBuilder,
    limit: usize,
    deadline: Option<tokio::time::Instant>,
) -> std::result::Result<String, Failure> {
    let send_result = match deadline {
        Some(until) => match tokio::time::timeout_at(until, request.send()).await {
            Ok(result) => result,
            Err(_) => {
                eprintln!("{service} transport error: timed out");
                return Err(Failure {
                    status: None,
                    timed_out: true,
                    transport: false,
                    tls: false,
                    message: format!("{service} did not answer in time."),
                });
            }
        },
        None => request.send().await,
    };
    let response = send_result.map_err(|e| {
        let tls = super::http::is_tls_error(&e);
        Failure {
            status: None,
            timed_out: !tls && e.is_timeout(),
            transport: !tls && !e.is_timeout() && !e.is_builder() && !e.is_redirect(),
            tls,
            message: super::http::transport_error(service, &e),
        }
    })?;
    let status = response.status().as_u16();
    let too_large = || Failure {
        status: Some(status),
        timed_out: false,
        transport: false,
        tls: false,
        message: format!("{service} sent a response that is too large."),
    };
    if response.content_length().is_some_and(|n| n > limit as u64) {
        return Err(too_large());
    }
    let body_result = match deadline {
        Some(until) => match tokio::time::timeout_at(until, response.bytes()).await {
            Ok(result) => result,
            Err(_) => {
                eprintln!("{service} transport error: timed out");
                let message = if (400..=500).contains(&status) {
                    super::http::error_message(service, status, "")
                } else {
                    format!("{service} did not answer in time.")
                };
                return Err(Failure {
                    status: Some(status),
                    timed_out: true,
                    transport: false,
                    tls: false,
                    message,
                });
            }
        },
        None => response.bytes().await,
    };
    let bytes = body_result.map_err(|e| {
        let tls = super::http::is_tls_error(&e);
        Failure {
            status: Some(status),
            timed_out: !tls && e.is_timeout(),
            transport: !tls && !e.is_timeout() && matches!(status, 200..300 | 502..=504),
            tls,
            message: super::http::body_transport_error(service, status, &e),
        }
    })?;
    if bytes.len() > limit {
        return Err(too_large());
    }
    let text = String::from_utf8_lossy(&bytes);
    let body = strip_xssi(&text).to_string();
    if !(200..300).contains(&status) {
        return Err(Failure {
            status: Some(status),
            timed_out: false,
            transport: false,
            tls: false,
            message: super::http::error_message(service, status, &body),
        });
    }
    Ok(body)
}
pub(crate) fn parse(service: &str, body: &str) -> std::result::Result<Value, Failure> {
    if body.trim().is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(body).map_err(|_| Failure::from(format!("{service} returned an unreadable response.")))
}

/// How requests are signed: the stored sign-in (refreshed as needed), or a token in hand.
#[derive(Clone)]
pub(crate) enum Auth {
    Stored,
    Token(String),
}

static REFRESH: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// A valid Google access token, refreshed and saved back when within 5 minutes of expiry.
pub(crate) async fn access_token(urls: &Urls) -> Result<String> {
    let _guard = REFRESH.lock().await;
    let secret = store::signed_in()?;
    if secret.fresh(now(), REFRESH_MARGIN) {
        return Ok(secret.access_token);
    }
    let source = if auth_mode(&options()) == "adc" { store::load_adc()? } else { secret.clone() };
    let (token, expires_at, rotated) = refresh(urls, &source).await?;
    let refresh_token = if auth_mode(&options()) == "adc" { String::new() } else { rotated.unwrap_or(secret.refresh_token.clone()) };
    OAuthSecret { access_token: token.clone(), expires_at, refresh_token, ..secret }.save()?;
    Ok(token)
}

/// Trade a refresh token for an access token, its expiry and any rotated refresh token.
pub(crate) async fn refresh(urls: &Urls, credentials: &OAuthSecret) -> Result<(String, i64, Option<String>)> {
    if credentials.refresh_token.is_empty() || credentials.client_id.is_empty() {
        return Err("The Google sign-in has no refresh token. Sign in to Google Colab again in Settings → Cloud.".into());
    }
    let body = form(&[("client_id", &credentials.client_id), ("client_secret", &credentials.client_secret), ("refresh_token", &credentials.refresh_token), ("grant_type", "refresh_token")]);
    let reply = token_request(urls, body).await?;
    let token = reply["access_token"].as_str().filter(|t| !t.is_empty()).ok_or("Google did not return an access token.")?;
    Ok((token.to_string(), now() + reply["expires_in"].as_i64().unwrap_or(3600), reply["refresh_token"].as_str().map(str::to_string)))
}

pub(crate) async fn token_request(urls: &Urls, body: String) -> Result<Value> {
    let client = super::http::client(QUICK)?;
    let request = client.post(&urls.token).header(reqwest::header::CONTENT_TYPE, "application/x-www-form-urlencoded").header(reqwest::header::ACCEPT, "application/json").body(body);
    match send_text("Google", request, LIMIT).await {
        Ok(body) => Ok(parse("Google", &body)?),
        Err(failure) if failure.message.contains("invalid_grant") => Err("Your Google sign-in expired or was revoked. Sign in to Google Colab again in Settings → Cloud.".into()),
        Err(failure) => Err(failure.message),
    }
}

/// One Colab account's runtimes.
pub struct Colab {
    urls: Urls,
    auth: Auth,
    sessions: PathBuf,
    backoff: Duration,
    #[cfg(test)]
    root_cert: Option<reqwest::Certificate>,
}

impl Colab {
    pub fn connected() -> Result<Self> {
        if !is_connected() {
            return Err(store::signed_in().err().unwrap_or_else(|| "Sign in to Google Colab in Settings → Cloud first.".into()));
        }
        Ok(Colab {
            urls: Urls::default(),
            auth: Auth::Stored,
            sessions: store::path()?,
            backoff: Duration::from_secs(5),
            #[cfg(test)]
            root_cert: None,
        })
    }
    pub(crate) fn with(urls: Urls, auth: Auth, sessions: PathBuf, backoff: Duration) -> Self {
        Colab {
            urls,
            auth,
            sessions,
            backoff,
            #[cfg(test)]
            root_cert: None,
        }
    }
    #[cfg(test)]
    pub(crate) fn with_root_cert(mut self, root: reqwest::Certificate) -> Self {
        self.root_cert = Some(root);
        self
    }

    fn http_client(&self, timeout: Duration) -> Result<reqwest::Client> {
        #[cfg(test)]
        if let Some(root) = &self.root_cert {
            return super::http::client_with_root(timeout, root.clone());
        }
        super::http::client(timeout)
    }

    async fn token(&self) -> Result<String> {
        match &self.auth {
            Auth::Stored => access_token(&self.urls).await,
            Auth::Token(token) => Ok(token.clone()),
        }
    }

    fn url(&self, path: &str, params: &[(&str, &str)]) -> Result<Url> {
        let mut url = Url::parse(&format!("{}{path}", self.urls.colab)).map_err(|_| "Invalid Colab URL.".to_string())?;
        url.query_pairs_mut().extend_pairs(params).append_pair("authuser", "0");
        Ok(url)
    }

    fn build_request(
        client: &reqwest::Client,
        method: reqwest::Method,
        url: Url,
        token: &str,
        headers: &[(&str, &str)],
    ) -> reqwest::RequestBuilder {
        let mut request = client
            .request(method.clone(), url)
            .bearer_auth(token)
            .header(reqwest::header::ACCEPT, "application/json")
            .header("X-Colab-Client-Agent", CLIENT_AGENT);
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        if method == reqwest::Method::POST {
            // hyper treats an empty body as end-of-stream and omits Content-Length on
            // HTTP/1.1, and Colab's frontend answers a POST without it with HTTP 411.
            request = request.header(reqwest::header::CONTENT_LENGTH, 0).body(Vec::<u8>::new());
        }
        request
    }

    async fn call(&self, method: reqwest::Method, url: Url, headers: &[(&str, &str)], timeout: Duration) -> std::result::Result<Value, Failure> {
        let token = self.token().await?;
        let client = self.http_client(timeout)?;
        let request = Self::build_request(&client, method, url, &token, headers);
        parse(SERVICE, &send_text(SERVICE, request, LIMIT).await?)
    }

    async fn call_until(
        &self,
        method: reqwest::Method,
        url: Url,
        headers: &[(&str, &str)],
        deadline: tokio::time::Instant,
    ) -> std::result::Result<Value, Failure> {
        let timed_out = || {
            eprintln!("{SERVICE} transport error: timed out");
            Failure {
                status: None,
                timed_out: true,
                transport: false,
                tls: false,
                message: format!("{SERVICE} did not answer in time."),
            }
        };
        if deadline.saturating_duration_since(tokio::time::Instant::now()).is_zero() {
            return Err(timed_out());
        }
        let token = match tokio::time::timeout_at(deadline, self.token()).await {
            Ok(result) => result?,
            Err(_) => return Err(timed_out()),
        };
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Err(timed_out());
        }
        let client = self.http_client(remaining)?;
        let request = Self::build_request(&client, method, url, &token, headers);
        parse(SERVICE, &send_text_until(SERVICE, request, LIMIT, Some(deadline)).await?)
    }

    pub(crate) async fn assignments(&self) -> Result<Vec<Value>> {
        let reply = self.call(reqwest::Method::GET, self.url("/tun/m/assignments", &[])?, &[], QUICK).await?;
        Ok(reply["assignments"].as_array().cloned().unwrap_or_default())
    }

    /// Fetch the account's runtimes and fold them into the sessions file, under its lock,
    /// keeping runtimes another process created while the list was on its way.
    pub fn records(&self) -> Result<Records> {
        let fetched_at = now();
        let assignments = block(self.assignments())?;
        store::update(&self.sessions, |known| {
            let next = reconcile(&known, &assignments, now(), fetched_at);
            (next.clone(), next)
        })
    }

    pub fn machines(&self) -> Result<Vec<Machine>> {
        Ok(self.records()?.values().map(machine).collect())
    }

    pub fn create_with(&self, name: &str, accelerator: &str, high_mem: bool) -> Result<Machine> {
        let accelerator = parse_accelerator(accelerator)?;
        let reply = block(self.assign(&accelerator, high_mem))?;
        let endpoint = reply["endpoint"].as_str().filter(|e| super::valid_native(e)).ok_or("Google Colab did not report the new runtime.")?.to_string();
        let name = if name.trim().is_empty() { format!("pc-{}", &uuid::Uuid::new_v4().simple().to_string()[..6]) } else { name.trim().to_string() };
        let fresh = reconcile(&Records::new(), std::slice::from_ref(&reply), now(), i64::MAX);
        let mut record = fresh.get(&endpoint).cloned().unwrap_or_default();
        record.name = name;
        record.created_at = now();
        if reply["accelerator"].is_null() {
            record.accelerator = accelerator.clone();
        }
        if reply["machineShape"].is_null() && shape_param(&accelerator, high_mem).is_some() {
            record.machine_shape = "HIGH_RAM".into();
        }
        let saved = record.clone();
        store::update(&self.sessions, move |known| {
            let mut next = known;
            next.insert(saved.endpoint.clone(), saved);
            (next, ())
        })?;
        Ok(machine(&record))
    }

    async fn assign(&self, accelerator: &str, high_mem: bool) -> Result<Value> {
        self.assign_until(accelerator, high_mem, tokio::time::Instant::now() + ASSIGN_BUDGET).await
    }

    async fn assign_until(&self, accelerator: &str, high_mem: bool, deadline: tokio::time::Instant) -> Result<Value> {
        use tokio::time::Instant;

        let hash = nbh(uuid::Uuid::new_v4());
        let mut params = vec![("nbh", hash.as_str()), ("variant", variant(accelerator)), ("accelerator", accelerator)];
        if let Some(shape) = shape_param(accelerator, high_mem) {
            params.push(("shape", shape));
        }
        let url = self.url("/tun/m/assign", &params)?;
        let post_deadline = deadline - RECONCILE_RESERVE;
        let remaining = || post_deadline.saturating_duration_since(Instant::now());
        let get = |until| self.assign_request(reqwest::Method::GET, url.clone(), &[], until);
        let mut reply = get(post_deadline.min(Instant::now() + QUICK)).await.map_err(|f| assign_error(f, accelerator))?;
        if is_assignment(&reply) {
            return Ok(reply);
        }
        if remaining() < MIN_POST_BUDGET {
            return Err(format!("{SERVICE} did not answer in time."));
        }
        for attempt in 0..=ASSIGN_RETRIES {
            let xsrf = reply["token"].as_str().filter(|t| !t.is_empty()).ok_or("Google Colab did not return an assignment token.")?;
            let post_until = post_deadline.min(Instant::now() + ASSIGN_TIMEOUT);
            let failure = match self.assign_request(reqwest::Method::POST, url.clone(), &[("X-Goog-Colab-Token", xsrf)], post_until).await {
                Ok(assigned) if is_assignment(&assigned) => return Ok(assigned),
                Ok(_) => return Err("Google Colab did not report the new runtime.".into()),
                Err(failure) if retryable(&failure) => failure,
                Err(failure) => return Err(assign_error(failure, accelerator)),
            };
            if attempt < ASSIGN_RETRIES {
                tokio::time::sleep((self.backoff * 2u32.pow(attempt)).min(remaining())).await;
            }

            // Look up the same notebook even after the last POST. Leave room for a
            // second GET if the first reconciliation itself drops or times out.
            let reconcile_until = deadline.min(Instant::now() + RECONCILE_RESERVE / 2);
            let reconciled = match get(reconcile_until).await {
                Err(failure) if retryable(&failure) && Instant::now() < deadline => {
                    get(deadline.min(Instant::now() + QUICK)).await
                }
                result => result,
            };
            reply = match reconciled {
                Ok(assigned) if is_assignment(&assigned) => return Ok(assigned),
                Ok(reply) if attempt < ASSIGN_RETRIES && remaining() >= MIN_POST_BUDGET => reply,
                _ => return Err(assign_error(failure, accelerator)),
            };
        }
        unreachable!("the final POST either succeeded or was reconciled")
    }

    async fn assign_request(&self, method: reqwest::Method, url: Url, headers: &[(&str, &str)], deadline: tokio::time::Instant) -> std::result::Result<Value, Failure> {
        self.call_until(method, url, headers, deadline).await
    }

    /// Release a runtime (Colab has no stop; it ends and its files go with it).
    pub fn unassign(&self, native: &str) -> Result<()> {
        valid(native)?;
        block(async {
            let url = self.url(&format!("/tun/m/unassign/{native}"), &[])?;
            match self.call(reqwest::Method::GET, url.clone(), &[], QUICK).await {
                Err(Failure { status: Some(404), .. }) => Ok(()),
                Err(failure) => Err(failure.message),
                Ok(reply) => {
                    let xsrf = reply["token"].as_str().unwrap_or_default().to_string();
                    self.call(reqwest::Method::POST, url, &[("X-Goog-Colab-Token", &xsrf)], QUICK).await.map(|_| ()).map_err(String::from)
                }
            }
        })?;
        store::remove(&self.sessions, native)
    }

    pub fn keep_alive_now(&self, native: &str) -> Result<()> {
        valid(native)?;
        let url = self.url(&format!("/tun/m/{native}/keep-alive/"), &[])?;
        match block(self.call(reqwest::Method::GET, url, &[("X-Colab-Tunnel", "Google")], Duration::from_secs(15))) {
            Ok(_) | Err(Failure { timed_out: true, .. }) => Ok(()),
            Err(failure) => Err(failure.message),
        }
    }

    /// Compute units left and spent per hour, when Colab reports them.
    pub fn usage(&self) -> Result<Option<(f64, f64)>> {
        let reply = block(self.call(reqwest::Method::GET, self.url("/tun/m/ccu-info", &[])?, &[], QUICK))?;
        Ok(reply["currentBalance"].as_f64().map(|balance| (balance, reply["consumptionRateHourly"].as_f64().unwrap_or_default())))
    }

    /// The runtime with a proxy token good for at least 5 more minutes.
    pub(crate) fn runtime(&self, native: &str) -> Result<SessionRecord> {
        valid(native)?;
        match store::load(&self.sessions).get(native) {
            Some(record) if !record.token.is_empty() && !record.url.is_empty() && record.token_expires_at - now() > REFRESH_MARGIN => Ok(record.clone()),
            _ => self.refreshed(native),
        }
    }
    fn refreshed(&self, native: &str) -> Result<SessionRecord> {
        self.records()?.get(native).cloned().ok_or_else(|| GONE.into())
    }
    /// True only when Colab answered and no longer lists the runtime.
    fn confirmed_gone(&self, native: &str) -> bool {
        self.records().is_ok_and(|records| !records.contains_key(native))
    }

    /// Run `command` with `sh -c` over the runtime's SSH WebSocket, feeding `stdin`. A
    /// failed connection checks whether the runtime still exists, so a runtime that ended
    /// reads as gone rather than as a network error worth retrying.
    pub fn shell(&self, native: &str, command: &str, stdin: Option<&[u8]>, timeout: Duration) -> Result<tunnel::Outcome> {
        let record = self.runtime(native)?;
        let result = match tunnel::run(&record, command, stdin, timeout) {
            Err(tunnel::Error::Unauthorized) => tunnel::run(&self.refreshed(native)?, command, stdin, timeout),
            other => other,
        };
        result.map_err(|error| if self.confirmed_gone(native) { GONE.into() } else { String::from(error) })
    }

    /// Run Python on the runtime's persistent kernel (made on first use, remade if gone).
    pub fn execute_python(&self, native: &str, code: &str, timeout: Duration) -> Result<jupyter::Output> {
        let record = self.runtime(native)?;
        let kernel = self.kernel(&record)?;
        block(jupyter::execute(&record, &kernel, code, timeout))
    }
    pub fn restart_kernel(&self, native: &str) -> Result<()> {
        let record = self.runtime(native)?;
        let kernel = self.kernel(&record)?;
        block(jupyter::restart(&record, &kernel))
    }
    /// The runtime's kernel, made at most once at a time per runtime: the kernel ID is read
    /// again under the runtime's lock, so two first calls share one new kernel.
    fn kernel(&self, record: &SessionRecord) -> Result<String> {
        let lock = kernel_lock(&record.endpoint);
        let _turn = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let saved = store::load(&self.sessions).get(&record.endpoint).and_then(|saved| saved.kernel_id.clone());
        let current = SessionRecord { kernel_id: saved.or_else(|| record.kernel_id.clone()), ..record.clone() };
        let kernel = block(jupyter::ensure_kernel(&current))?;
        if current.kernel_id.as_deref() != Some(kernel.as_str()) {
            let (endpoint, id) = (record.endpoint.clone(), kernel.clone());
            store::update(&self.sessions, move |known| {
                let next = known
                    .into_iter()
                    .map(|(key, item)| {
                        let item = if key == endpoint { SessionRecord { kernel_id: Some(id.clone()), ..item } } else { item };
                        (key, item)
                    })
                    .collect();
                (next, ())
            })?;
        }
        Ok(kernel)
    }
    pub fn contents_list(&self, native: &str, path: &str) -> Result<Value> {
        block(jupyter::list(&self.runtime(native)?, path))
    }
    pub fn contents_upload(&self, native: &str, bytes: &[u8], remote_path: &str) -> Result<()> {
        block(jupyter::upload(&self.runtime(native)?, bytes, remote_path))
    }
    pub fn contents_download(&self, native: &str, remote_path: &str) -> Result<Vec<u8>> {
        block(jupyter::download(&self.runtime(native)?, remote_path))
    }
    pub fn contents_delete(&self, native: &str, remote_path: &str) -> Result<()> {
        block(jupyter::delete(&self.runtime(native)?, remote_path))
    }
}

/// One lock per runtime for making its kernel, process-wide.
fn kernel_lock(endpoint: &str) -> Arc<Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    let mut locks = LOCKS.get_or_init(Default::default).lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    locks.entry(endpoint.to_string()).or_default().clone()
}

/// `error` marked with [`MACHINE_GONE`] when it says the runtime no longer exists.
pub(crate) fn tag_gone(error: String) -> String {
    if error == GONE {
        format!("{MACHINE_GONE}{error}")
    } else {
        error
    }
}

fn valid(native: &str) -> Result<()> {
    super::valid_native(native).then_some(()).ok_or_else(|| "Unknown Colab runtime.".into())
}
fn is_assignment(reply: &Value) -> bool {
    reply["endpoint"].is_string() && reply["runtimeProxyInfo"].is_object()
}
fn retryable(failure: &Failure) -> bool {
    if failure.tls {
        return false;
    }
    match failure.status {
        None => failure.timed_out || failure.transport,
        Some(200..300) => failure.timed_out || failure.transport,
        Some(502..=504) => true,
        Some(_) => false,
    }
}
fn assign_error(failure: Failure, accelerator: &str) -> String {
    match failure.status {
        Some(412) => "Google Colab refused the runtime: too many active Colab sessions, or a usage or capacity limit. Stop a runtime, wait and retry, or pick other hardware.".into(),
        Some(400) if accelerator != "NONE" => format!("Google Colab has no quota or entitlement for accelerator {accelerator} on this account. Pick another (for example T4) or use a CPU runtime."),
        _ => failure.message,
    }
}

impl Sandbox for Colab {
    fn info(&self) -> Info {
        Info { persistent: false, max_unattended_minutes: UNATTENDED_MINUTES }
    }
    fn list(&self) -> Result<Vec<Machine>> {
        self.machines()
    }
    fn create(&self, name: &str) -> Result<Machine> {
        let (accelerator, high_mem) = default_hardware();
        self.create_with(name, &accelerator, high_mem)
    }
    fn power(&self, native: &str, action: &str) -> Result<()> {
        match action {
            "stop" | "delete" => self.unassign(native),
            "start" => Err(NO_RESTART.into()),
            _ => Err("Unknown action for a Colab runtime.".into()),
        }
    }
    fn exec(&self, native: &str, command: &str, timeout: Duration) -> Result<(Option<i32>, String)> {
        let outcome = self.shell(native, command, None, timeout).map_err(tag_gone)?;
        let mut text = outcome.stdout;
        if outcome.code != Some(0) {
            text.push_str(&outcome.stderr);
        }
        Ok((outcome.code, text))
    }
    /// Only a keep-alive for Colab's full idle window is sent (see `UNATTENDED_MINUTES`).
    fn keep_alive(&self, native: &str, minutes: u32) -> Result<()> {
        if minutes < UNATTENDED_MINUTES {
            return Ok(());
        }
        self.keep_alive_now(native)
    }
    /// One SSH connection with the bytes on stdin, so git bundles go up in one piece.
    fn upload(&self, native: &str, path: &str, bytes: &[u8], private: bool) -> Result<()> {
        let quoted = super::shell_quote(path);
        let command = format!("mkdir -p \"$(dirname {quoted})\" && umask {} && cat > {quoted}", if private { "077" } else { "022" });
        let outcome = self.shell(native, &command, Some(bytes), Duration::from_secs(600)).map_err(tag_gone)?;
        checked((outcome.code, format!("{}{}", outcome.stdout, outcome.stderr)))
    }
}

pub fn sandbox() -> Result<Box<dyn Sandbox>> {
    Ok(Box::new(Colab::connected()?))
}

#[cfg(test)]
mod tests;
