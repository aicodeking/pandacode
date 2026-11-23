//! Commands on a Colab runtime over SSH through its runtime proxy: Colab exposes the
//! runtime's sshd as a WebSocket (`wss://<proxy>/colab/ssh`) that takes the client's public
//! key in a header. PandaCode listens on a loopback port, pumps that port's bytes to the
//! WebSocket as binary frames, and runs the system `ssh` against it with the shared
//! PandaCode key (`cloud/ssh.rs`). Colab caps concurrent SSH sessions per runtime, so calls
//! to one runtime take turns, and a busy answer (429) is retried with a short backoff.
//! Commands longer than a few KiB travel on stdin, not the command line, which Windows
//! caps at 32,767 characters.
use futures_util::{SinkExt, StreamExt};
use std::{
    borrow::Cow,
    collections::HashMap,
    future::Future,
    net::Ipv4Addr,
    path::Path,
    process::Command,
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};
use tauri::Url;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio_tungstenite::{
    tungstenite::{
        client::IntoClientRequest,
        http::{HeaderName, HeaderValue},
        Message,
    },
    WebSocketStream,
};

use super::store::SessionRecord;
use super::CLIENT_AGENT;
use crate::workspace::run_process_with_input;

/// The exec contract keeps at least 4 MiB of output.
const OUTPUT: usize = 4 << 20;
const HANDSHAKE: Duration = Duration::from_secs(30);
/// ssh connects to the loopback port within this long, or the bridge gives up.
const ACCEPT: Duration = Duration::from_secs(60);
/// The first wait after a busy or bad-gateway answer; it doubles (1, 2, 4 s) with jitter.
const BUSY_PAUSE: Duration = Duration::from_secs(1);
const BUSY_RETRIES: u32 = 3;
/// How long the bridge has to send its Close frame once ssh is done.
const CLOSE_WAIT: Duration = Duration::from_secs(2);
/// Commands longer than this go to the runtime on stdin (when stdin is free).
const ARG_MAX: usize = 4096;
/// Reads the real command from stdin, then runs it like `sh -c` would.
const FROM_STDIN: &str = "c=$(cat); exec sh -c \"$c\"";
const SSH_ERROR: i32 = 255;
const INVALID_URL: &str = "Google Colab sent an invalid runtime URL.";
#[cfg(windows)]
const DEV_NULL: &str = "NUL";
#[cfg(not(windows))]
const DEV_NULL: &str = "/dev/null";

pub struct Outcome {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Debug)]
pub enum Error {
    /// The runtime-proxy token was refused: fetch a fresh one and retry once.
    Unauthorized,
    Failed(String),
}
impl From<Error> for String {
    fn from(error: Error) -> String {
        match error {
            Error::Unauthorized => "Google Colab refused the runtime's access token (HTTP 401). The runtime may have ended; create a new one.".into(),
            Error::Failed(message) => message,
        }
    }
}

/// One lock per runtime endpoint, process-wide.
fn endpoint_lock(endpoint: &str) -> Arc<Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    let mut locks = LOCKS.get_or_init(Default::default).lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    locks.entry(endpoint.to_string()).or_default().clone()
}

/// Colab's runtime proxies live on these domains; tokens go nowhere else.
const PROXY_DOMAINS: [&str; 2] = [".colab.dev", ".googleusercontent.com"];

/// A runtime proxy URL Colab sent, checked: HTTPS on a Colab proxy domain (tests also
/// serve proxies on loopback).
pub(super) fn proxy_base(proxy_url: &str) -> Result<Url, String> {
    let parsed = Url::parse(proxy_url).map_err(|_| INVALID_URL.to_string())?;
    let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
    let colab = parsed.scheme() == "https" && PROXY_DOMAINS.iter().any(|domain| host.ends_with(domain) && host.len() > domain.len());
    let loopback = cfg!(test) && matches!(parsed.scheme(), "http" | "https") && matches!(host.as_str(), "127.0.0.1" | "localhost");
    if colab || loopback {
        Ok(parsed)
    } else {
        Err(INVALID_URL.into())
    }
}

/// `wss://<proxy host>/colab/ssh?…` for a runtime proxy URL.
pub fn ssh_url(proxy_url: &str, token: &str) -> Result<String, String> {
    let parsed = proxy_base(proxy_url)?;
    let scheme = if parsed.scheme() == "https" { "wss" } else { "ws" };
    let host = parsed.host_str().ok_or(INVALID_URL)?;
    let netloc = parsed.port().map_or_else(|| host.to_string(), |port| format!("{host}:{port}"));
    let mut url = Url::parse(&format!("{scheme}://{netloc}/colab/ssh")).map_err(|_| INVALID_URL.to_string())?;
    url.query_pairs_mut().append_pair("colab-runtime-proxy-token", token).append_pair("colab-client-agent", CLIENT_AGENT).append_pair("colab-client-agent", "ssh-mode-cmd");
    Ok(url.to_string())
}

pub(super) fn ensure_crypto() {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
}

/// A failed WebSocket upgrade, as the Colab CLI explains it.
pub fn explain(status: u16, body: &str) -> String {
    let snippet: String = body.trim().chars().take(200).collect();
    match status {
        400 if snippet.contains("unsupported key type") => "Google Colab refused PandaCode's SSH key type (HTTP 400).".into(),
        400 => format!("Google Colab refused the SSH key (HTTP 400): {snippet}"),
        403 => "Google Colab refused SSH to this runtime (HTTP 403).".into(),
        404 => "This Colab runtime has no SSH endpoint (HTTP 404); runtimes made before SSH support lack it. Create a new runtime.".into(),
        429 => "Another SSH session is using this Colab runtime (HTTP 429). Try again when it finishes.".into(),
        502 => "The Colab runtime's SSH server did not answer (HTTP 502). The runtime may be unhealthy; create a new one.".into(),
        _ => format!("Google Colab refused the SSH connection (HTTP {status})."),
    }
}

pub(super) enum Refused {
    Status(u16, String),
    Other(String),
}

/// Open a WebSocket with Colab's headers (plus `extra`), bounded by the handshake timeout.
pub(super) async fn open(url: &str, extra: &[(&str, &str)]) -> Result<WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>, Refused> {
    ensure_crypto();
    let mut request = url.into_client_request().map_err(|_| Refused::Other("Invalid Colab WebSocket URL.".into()))?;
    let headers = request.headers_mut();
    headers.insert("X-Colab-Client-Agent", HeaderValue::from_static(CLIENT_AGENT));
    for (name, value) in extra {
        let invalid = |_| Refused::Other("Invalid Colab header.".into());
        headers.insert(HeaderName::from_bytes(name.as_bytes()).map_err(invalid)?, HeaderValue::from_str(value).map_err(|_| Refused::Other("Invalid Colab header.".into()))?);
    }
    match tokio::time::timeout(HANDSHAKE, tokio_tungstenite::connect_async(request)).await {
        Err(_) => Err(Refused::Other("Google Colab did not open the connection in time.".into())),
        Ok(Ok((socket, _))) => Ok(socket),
        Ok(Err(tokio_tungstenite::tungstenite::Error::Http(response))) => {
            let body = response.body().as_deref().map(|b| String::from_utf8_lossy(b).into_owned()).unwrap_or_default();
            Err(Refused::Status(response.status().as_u16(), body))
        }
        Ok(Err(_)) => Err(Refused::Other("Could not connect to the Colab runtime. Check your connection.".into())),
    }
}

/// The wait before retry `attempt` (0-based): `pause` doubled per attempt, plus up to a
/// quarter more at random, so clients that were refused together do not return together.
pub(super) fn backoff(pause: Duration, attempt: u32) -> Duration {
    let base = pause * 2u32.saturating_pow(attempt);
    let jitter = f64::from(uuid::Uuid::new_v4().as_bytes()[0]) / 1024.0;
    base + base.mul_f64(jitter)
}

/// Connect the SSH WebSocket, waiting out busy (429) and bad-gateway (502) answers up to
/// three times (about 1, 2 and 4 s).
async fn connect(url: &str, pubkey: &str, pause: Duration) -> Result<WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>, Error> {
    let mut attempt = 0;
    loop {
        match open(url, &[("X-Colab-Ssh-Pubkey", pubkey)]).await {
            Ok(socket) => return Ok(socket),
            Err(Refused::Status(401, _)) => return Err(Error::Unauthorized),
            Err(Refused::Status(429 | 502, _)) if attempt < BUSY_RETRIES => {
                tokio::time::sleep(backoff(pause, attempt)).await;
                attempt += 1;
            }
            Err(Refused::Status(status, body)) => return Err(Error::Failed(explain(status, &body))),
            Err(Refused::Other(message)) => return Err(Error::Failed(message)),
        }
    }
}

/// Carry one accepted TCP connection over the WebSocket until either side closes or `stop`
/// resolves; the WebSocket always ends with a Close frame.
pub(super) async fn pump<S>(listener: tokio::net::TcpListener, mut socket: WebSocketStream<S>, stop: impl Future<Output = ()>)
where
    S: AsyncRead + AsyncWrite + Unpin + Send,
{
    tokio::pin!(stop);
    let accepted = tokio::select! {
        accepted = tokio::time::timeout(ACCEPT, listener.accept()) => accepted,
        () = &mut stop => {
            let _ = tokio::time::timeout(CLOSE_WAIT, socket.close(None)).await;
            return;
        }
    };
    let Ok(Ok((tcp, _))) = accepted else {
        let _ = tokio::time::timeout(CLOSE_WAIT, socket.close(None)).await;
        return;
    };
    drop(listener);
    let (mut tcp_in, mut tcp_out) = tcp.into_split();
    let (mut ws_out, mut ws_in) = socket.split();
    let up = async {
        let mut buffer = vec![0u8; 32 * 1024];
        loop {
            match tcp_in.read(&mut buffer).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if ws_out.send(Message::binary(buffer[..n].to_vec())).await.is_err() {
                        break;
                    }
                }
            }
        }
        let _ = ws_out.close().await;
    };
    let down = async {
        while let Some(Ok(message)) = ws_in.next().await {
            let written = match message {
                Message::Binary(bytes) => tcp_out.write_all(&bytes).await,
                Message::Text(text) => tcp_out.write_all(text.as_bytes()).await,
                Message::Close(_) => break,
                _ => Ok(()),
            };
            if written.is_err() {
                break;
            }
        }
        let _ = tcp_out.shutdown().await;
    };
    tokio::select! {
        () = up => {}
        () = down => {}
        () = &mut stop => {}
    }
    let _ = tokio::time::timeout(CLOSE_WAIT, ws_out.close()).await;
}

/// The command line and stdin for running `command`: as is, or, when it is long and stdin
/// is free, a short reader on the command line with the command itself on stdin.
pub(super) fn invocation<'a>(command: &'a str, stdin: Option<&'a [u8]>) -> (&'a str, Option<Cow<'a, [u8]>>) {
    match stdin {
        None if command.len() > ARG_MAX => (FROM_STDIN, Some(Cow::Borrowed(command.as_bytes()))),
        stdin => (command, stdin.map(Cow::Borrowed)),
    }
}

/// The ssh invocation against the loopback bridge; `command` runs under `sh -c` as root.
pub fn ssh_args(port: u16, key: &Path, command: &str) -> Vec<String> {
    let option = |text: &str| ["-o".to_string(), text.to_string()];
    let mut args = vec!["-F".into(), DEV_NULL.into(), "-p".into(), port.to_string(), "-i".into(), key.display().to_string()];
    for text in ["BatchMode=yes", "StrictHostKeyChecking=no", &format!("UserKnownHostsFile={DEV_NULL}"), "LogLevel=ERROR", "ConnectTimeout=20", "IdentitiesOnly=yes", "ControlMaster=no", "ControlPath=none"] {
        args.extend(option(text));
    }
    args.extend(["-T".into(), "root@127.0.0.1".into(), "--".into(), "sh".into(), "-c".into(), super::super::shell_quote(command)]);
    args
}

/// Run `command` on the runtime, feeding `stdin`; exit code, stdout and stderr.
pub fn run(record: &SessionRecord, command: &str, stdin: Option<&[u8]>, timeout: Duration) -> Result<Outcome, Error> {
    let lock = endpoint_lock(&record.endpoint);
    let _turn = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let (key, public) = super::super::ssh::key_pair().map_err(Error::Failed)?;
    let url = ssh_url(&record.url, &record.token).map_err(Error::Failed)?;
    let socket = super::block(connect(&url, &public, BUSY_PAUSE))?;
    let listener = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).map_err(|_| Error::Failed("Could not open a local port for the Colab SSH bridge.".into()))?;
    let port = listener.local_addr().map_err(|e| Error::Failed(e.to_string()))?.port();
    listener.set_nonblocking(true).map_err(|e| Error::Failed(e.to_string()))?;
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let mut bridge = tauri::async_runtime::spawn(async move {
        if let Ok(listener) = tokio::net::TcpListener::from_std(listener) {
            pump(listener, socket, async {
                let _ = stopped.await;
            })
            .await;
        }
    });
    let (line, input) = invocation(command, stdin);
    let result = ssh(port, &key, line, input.as_deref(), timeout);
    // Let the bridge say goodbye with a Close frame, then make sure it is gone.
    let _ = stop.send(());
    super::block(async {
        if tokio::time::timeout(CLOSE_WAIT * 2, &mut bridge).await.is_err() {
            bridge.abort();
        }
    });
    result
}

/// A failure to run ssh, in Colab's words: never the generic timeout hint about a repository.
pub(super) fn ssh_failure(error: String, timeout: Duration) -> String {
    let lowered = error.to_lowercase();
    if lowered.contains("timed out") {
        format!("The command on the Colab runtime did not finish within {} s and was stopped.", timeout.as_secs())
    } else if lowered.contains("no such file") || lowered.contains("not found") || lowered.contains("cannot find") {
        "OpenSSH is needed to reach Colab runtimes. Install it (on Windows: Settings → Apps → Optional features → OpenSSH client) and try again.".into()
    } else {
        error
    }
}

fn ssh(port: u16, key: &Path, command: &str, stdin: Option<&[u8]>, timeout: Duration) -> Result<Outcome, Error> {
    let mut ssh = Command::new("ssh");
    ssh.args(ssh_args(port, key, command));
    let out = run_process_with_input(ssh, "ssh", OUTPUT, timeout + Duration::from_secs(30), stdin).map_err(|error| Error::Failed(ssh_failure(error, timeout)))?;
    let stderr = String::from_utf8_lossy(&out.stderr.bytes).into_owned();
    let code = out.status.code();
    if code == Some(SSH_ERROR) && ["Permission denied", "Connection closed", "Connection reset", "kex_exchange_identification", "Connection refused"].iter().any(|p| stderr.contains(p)) {
        return Err(Error::Failed(format!("Could not open SSH on the Colab runtime: {}", stderr.trim().chars().take(300).collect::<String>())));
    }
    Ok(Outcome { code, stdout: String::from_utf8_lossy(&out.stdout.bytes).into_owned(), stderr })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use tokio::net::TcpListener;
    use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};

    #[test]
    fn builds_the_ssh_websocket_url() {
        let url = ssh_url("https://8080-gpu-t4-s-abc.prod.colab.dev", "to/ken").unwrap();
        assert_eq!(url, "wss://8080-gpu-t4-s-abc.prod.colab.dev/colab/ssh?colab-runtime-proxy-token=to%2Fken&colab-client-agent=colab-cli&colab-client-agent=ssh-mode-cmd");
        assert!(ssh_url("ftp://x", "t").is_err());
        assert!(ssh_url("not a url", "t").is_err());
    }

    #[test]
    fn runtime_proxies_must_be_https_on_colab_domains() {
        for good in ["https://8080-gpu-t4-s-abc.prod.colab.dev", "https://x.colab.googleusercontent.com/", "http://127.0.0.1:4000"] {
            assert!(proxy_base(good).is_ok(), "{good}");
        }
        for bad in ["http://8080-gpu.prod.colab.dev", "https://colab.dev.evil.test", "https://evil.test/x.colab.dev", "https://.colab.dev", "https://attacker.example", "https://notcolab.dev"] {
            assert!(proxy_base(bad).is_err(), "{bad}");
            assert!(ssh_url(bad, "t").is_err(), "{bad}");
        }
    }

    #[test]
    fn long_commands_travel_on_stdin_not_the_command_line() {
        let short = "echo hi";
        assert_eq!(invocation(short, None), (short, None));
        let long = format!("printf %s {} | base64 -d > inbox.part", "QUFB".repeat(15_000));
        let (line, input) = invocation(&long, None);
        assert_eq!(line, FROM_STDIN);
        assert_eq!(input.as_deref(), Some(long.as_bytes()));
        let args = ssh_args(22, Path::new("/k"), line);
        assert!(args.iter().map(String::len).sum::<usize>() < 1024, "the ssh command line stays short");
        // Stdin already carries data (an upload): the command stays on the line.
        let (line, input) = invocation(&long, Some(b"bytes"));
        assert_eq!((line, input.as_deref()), (long.as_str(), Some(&b"bytes"[..])));
    }

    #[cfg(unix)]
    #[test]
    fn the_stdin_reader_runs_the_command_like_sh_c() {
        use std::io::Write;
        let command = format!("x='{}'; printf '%s|%s' \"${{#x}}\" \"$(echo ok)\"", "a".repeat(ARG_MAX));
        let mut child = Command::new("sh").args(["-c", FROM_STDIN]).stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).spawn().unwrap();
        child.stdin.take().unwrap().write_all(command.as_bytes()).unwrap();
        let out = child.wait_with_output().unwrap();
        assert_eq!(String::from_utf8(out.stdout).unwrap(), format!("{}|ok", ARG_MAX));
    }

    #[test]
    fn backoff_doubles_with_a_little_jitter_and_timeouts_read_as_colab() {
        for (attempt, base) in [(0, 1000), (1, 2000), (2, 4000)] {
            let wait = backoff(Duration::from_secs(1), attempt).as_millis();
            assert!((base..=base + base / 4).contains(&wait), "attempt {attempt}: {wait} ms");
        }
        assert_eq!(backoff(Duration::ZERO, 2), Duration::ZERO);
        let timeout = ssh_failure("ssh operation timed out. Check the repository before retrying.".into(), Duration::from_secs(90));
        assert_eq!(timeout, "The command on the Colab runtime did not finish within 90 s and was stopped.");
        assert!(ssh_failure("No such file or directory (os error 2)".into(), Duration::ZERO).contains("OpenSSH"));
        assert_eq!(ssh_failure("other".into(), Duration::ZERO), "other");
    }

    #[test]
    fn ssh_runs_sh_c_with_the_command_quoted_and_no_host_trust() {
        let args = ssh_args(4022, Path::new("/keys/vps-key"), "echo 'hi' && cd $HOME");
        let joined = args.join(" ");
        assert!(joined.contains("-p 4022 -i /keys/vps-key"));
        assert!(joined.contains("StrictHostKeyChecking=no") && joined.contains("BatchMode=yes") && joined.contains("LogLevel=ERROR") && joined.contains("ConnectTimeout=20"));
        assert_eq!(&args[args.len() - 5..], ["root@127.0.0.1", "--", "sh", "-c", r"'echo '\''hi'\'' && cd $HOME'"]);
        assert!(!joined.contains("/content"), "Sandbox::exec must not force a directory");
    }

    #[test]
    fn explains_handshake_refusals() {
        assert!(explain(429, r#"{"error":"already-active-session","limit":1}"#).contains("Another SSH session"));
        assert!(explain(404, "").contains("Create a new runtime"));
        assert!(explain(400, "unsupported key type").contains("key type"));
        assert!(explain(418, "").contains("HTTP 418"));
    }

    #[tokio::test]
    async fn sends_the_pubkey_header_and_pumps_bytes_both_ways() {
        let server = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = server.local_addr().unwrap();
        let seen: Arc<Mutex<Vec<(String, String)>>> = Arc::default();
        let log = seen.clone();
        tokio::spawn(async move {
            let (stream, _) = server.accept().await.unwrap();
            // tungstenite fixes this callback's error type; it cannot be boxed.
            #[allow(clippy::result_large_err)]
            let callback = move |request: &Request, response: Response| {
                *log.lock().unwrap() = request.headers().iter().map(|(n, v)| (n.as_str().to_string(), v.to_str().unwrap_or_default().to_string())).collect();
                Ok(response)
            };
            let mut socket = tokio_tungstenite::accept_hdr_async(stream, callback).await.unwrap();
            // An echo server that upper-cases, standing in for sshd.
            while let Some(Ok(message)) = socket.next().await {
                if let Message::Binary(bytes) = message {
                    socket.send(Message::binary(bytes.to_ascii_uppercase())).await.unwrap();
                }
            }
        });
        let url = format!("ws://{address}/colab/ssh?colab-runtime-proxy-token=t");
        let socket = connect(&url, "ssh-ed25519 AAAA pandacode", Duration::ZERO).await.unwrap();
        let headers = seen.lock().unwrap().clone();
        assert!(headers.contains(&("x-colab-ssh-pubkey".into(), "ssh-ed25519 AAAA pandacode".into())));
        assert!(headers.contains(&("x-colab-client-agent".into(), "colab-cli".into())));

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let local = listener.local_addr().unwrap();
        let bridge = tokio::spawn(pump(listener, socket, std::future::pending()));
        let mut client = tokio::net::TcpStream::connect(local).await.unwrap();
        client.write_all(b"hello colab").await.unwrap();
        let mut reply = vec![0u8; 11];
        client.read_exact(&mut reply).await.unwrap();
        assert_eq!(reply, b"HELLO COLAB");
        drop(client);
        tokio::time::timeout(Duration::from_secs(5), bridge).await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn a_refused_upgrade_reports_the_status_and_401_asks_for_a_new_token() {
        async fn refuse(status: &'static str) -> String {
            let server = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = server.local_addr().unwrap();
            tokio::spawn(async move {
                while let Ok((mut stream, _)) = server.accept().await {
                    let mut buffer = vec![0u8; 4096];
                    let _ = stream.read(&mut buffer).await;
                    let body = r#"{"error":"already-active-session","limit":1}"#;
                    let _ = stream.write_all(format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await;
                }
            });
            format!("ws://{address}/colab/ssh")
        }
        let busy = refuse("429 Too Many Requests").await;
        match connect(&busy, "k", Duration::ZERO).await {
            Err(Error::Failed(message)) => assert!(message.contains("HTTP 429"), "{message}"),
            _ => panic!("expected a refusal"),
        }
        let expired = refuse("401 Unauthorized").await;
        assert!(matches!(connect(&expired, "k", Duration::ZERO).await, Err(Error::Unauthorized)));
    }

    #[tokio::test]
    async fn a_busy_runtime_is_retried_three_times_then_answers() {
        let server = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = server.local_addr().unwrap();
        let attempts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let count = attempts.clone();
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = server.accept().await {
                if count.fetch_add(1, std::sync::atomic::Ordering::SeqCst) < 3 {
                    let mut buffer = vec![0u8; 4096];
                    let _ = stream.read(&mut buffer).await;
                    let _ = stream.write_all(b"HTTP/1.1 429 Too Many Requests\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
                } else {
                    let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
                    while socket.next().await.is_some() {}
                }
            }
        });
        let socket = connect(&format!("ws://{address}/colab/ssh"), "k", Duration::ZERO).await;
        assert!(socket.is_ok());
        assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 4, "three retries after the first refusal");
    }

    #[tokio::test]
    async fn stopping_the_bridge_sends_a_close_frame() {
        let server = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = server.local_addr().unwrap();
        let (closed, saw_close) = tokio::sync::oneshot::channel::<bool>();
        tokio::spawn(async move {
            let (stream, _) = server.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            let mut close = false;
            while let Some(Ok(message)) = socket.next().await {
                if matches!(message, Message::Close(_)) {
                    close = true;
                    break;
                }
            }
            let _ = closed.send(close);
        });
        let socket = connect(&format!("ws://{address}/colab/ssh"), "k", Duration::ZERO).await.unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let local = listener.local_addr().unwrap();
        let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
        let bridge = tokio::spawn(pump(listener, socket, async {
            let _ = stopped.await;
        }));
        // ssh connected and is still talking when the run ends.
        let _client = tokio::net::TcpStream::connect(local).await.unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;
        stop.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(5), bridge).await.unwrap().unwrap();
        assert!(tokio::time::timeout(Duration::from_secs(5), saw_close).await.unwrap().unwrap(), "the server saw a Close frame");
    }
}
