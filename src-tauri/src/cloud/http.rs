//! JSON over HTTPS for cloud sandbox APIs, with bounded responses and readable errors.
//! Credentials go in headers only and never appear in errors.
use serde_json::Value;
use std::time::Duration;

const LIMIT: usize = 16 * 1024 * 1024;
/// A word this long in a 401/403 message may be a key, so the message is not shown.
const TOKEN_LIKE: usize = 20;

pub fn client(timeout: Duration) -> Result<reqwest::Client, String> {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    reqwest::Client::builder()
        // Tests talk to a loopback server; everything else must be HTTPS.
        .https_only(!cfg!(test))
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(timeout)
        .user_agent(concat!("PandaCode/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| format!("Could not prepare a network client: {e}"))
}

#[cfg(test)]
pub(crate) fn client_with_root(timeout: Duration, root: reqwest::Certificate) -> Result<reqwest::Client, String> {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    reqwest::Client::builder()
        .https_only(true)
        .tls_certs_only([root])
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(timeout)
        .user_agent(concat!("PandaCode/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| format!("Could not prepare a network client: {e}"))
}

/// The service's own message from an error body, else the status.
pub fn error_message(service: &str, status: u16, body: &str) -> String {
    let parsed: Option<Value> = serde_json::from_str(body).ok();
    let structured = parsed.as_ref().and_then(|v| v["message"].as_str().or(v["error"]["message"].as_str()).or(v["error"].as_str()).or(v["errors"][0]["message"].as_str())).map(str::to_string);
    if matches!(status, 401 | 403) {
        return match structured.as_deref().and_then(refusal_detail) {
            Some(detail) => format!("{service} refused the credentials (HTTP {status}): {detail}. Check them in Settings → Cloud."),
            None => format!("{service} refused the credentials (HTTP {status}). Check them in Settings → Cloud."),
        };
    }
    match structured.or_else(|| Some(body.trim().chars().take(300).collect::<String>()).filter(|s| !s.is_empty() && !s.starts_with('<'))) {
        Some(message) => format!("{service}: {message}"),
        None => format!("{service} returned HTTP {status}."),
    }
}

/// A refusal's own message, as one bounded line, unless it could be echoing a credential.
/// ponytail: any long word counts as a token, since this has no access to the secret itself;
/// a refusal naming a long ID or URL falls back to the generic text.
fn refusal_detail(message: &str) -> Option<String> {
    if message.split_whitespace().any(|word| word.chars().count() >= TOKEN_LIKE) {
        return None;
    }
    let line = message.split_whitespace().collect::<Vec<_>>().join(" ");
    let line: String = line.chars().take(300).collect();
    Some(line.trim_end_matches('.').to_string()).filter(|detail| !detail.is_empty())
}

pub(crate) fn transport_error(service: &str, err: &reqwest::Error) -> String {
    report_transport_error(service, err, "connection closed before response")
}

pub(crate) fn body_transport_error(service: &str, status: u16, err: &reqwest::Error) -> String {
    let diagnostic = report_transport_error(service, err, "connection closed while reading response");
    if (400..=500).contains(&status) {
        error_message(service, status, "")
    } else {
        diagnostic
    }
}

fn next_cause<'a>(cause: &'a (dyn std::error::Error + 'static)) -> Option<&'a (dyn std::error::Error + 'static)> {
    // Hyper may wrap an I/O error whose source skips its inner Rustls error.
    cause
        .downcast_ref::<std::io::Error>()
        .and_then(std::io::Error::get_ref)
        .map(|inner| inner as &(dyn std::error::Error + 'static))
        .or_else(|| cause.source())
}

pub(crate) fn is_tls_error(err: &reqwest::Error) -> bool {
    use std::error::Error;

    // Pass 1: real rustls errors (handshake, certificate, protocol, fatal alerts) always fail closed.
    let mut source = err.source();
    while let Some(cause) = source {
        if cause.is::<rustls::Error>()
            || cause
                .downcast_ref::<std::io::Error>()
                .and_then(std::io::Error::get_ref)
                .is_some_and(|inner| inner.is::<rustls::Error>())
        {
            return true;
        }
        source = next_cause(cause);
    }

    // Pass 2: an unclean TCP EOF (such as rustls missing close_notify) without any rustls::Error
    // is a dropped transport connection, not a fatal TLS error.
    let mut source = err.source();
    while let Some(cause) = source {
        if cause
            .downcast_ref::<std::io::Error>()
            .is_some_and(|io| io.kind() == std::io::ErrorKind::UnexpectedEof)
        {
            return false;
        }
        source = next_cause(cause);
    }

    // Pass 3: fallback phrase check in case a non-rustls TLS error occurs.
    let mut source = err.source();
    while let Some(cause) = source {
        let message = cause.to_string().to_ascii_lowercase();
        if ["tls", "handshake", "certificate", "received fatal alert"]
            .iter()
            .any(|phrase| message.contains(phrase))
        {
            return true;
        }
        source = next_cause(cause);
    }
    false
}

fn report_transport_error(service: &str, err: &reqwest::Error, eof: &'static str) -> String {
    let detail = if err.is_timeout() {
        Some("timed out")
    } else if is_tls_error(err) {
        Some("TLS error")
    } else {
        transport_detail(err, eof).or_else(|| {
            if err.is_connect() {
                Some("connection failed")
            } else if err.is_decode() {
                Some("response decode error")
            } else if err.is_body() {
                Some("body transfer interrupted")
            } else {
                None
            }
        })
    };
    let diagnostic = detail.unwrap_or("unknown cause");
    eprintln!("{service} transport error: {diagnostic}");
    if err.is_timeout() {
        format!("{service} did not answer in time.")
    } else if err.is_connect() {
        format!("Could not reach {service}. Check your connection.")
    } else if let Some(detail) = detail {
        format!("{service} request failed ({detail}).")
    } else {
        format!("{service} request failed.")
    }
}

fn transport_detail(err: &reqwest::Error, eof: &'static str) -> Option<&'static str> {
    use std::{error::Error, io::{Error as IoError, ErrorKind}};

    // The top-level reqwest error may include the URL. Only static labels leave this function.
    let mut source = err.source();
    while let Some(cause) = source {
        let kind = cause.downcast_ref::<IoError>().map(IoError::kind);
        let detail = match kind {
            Some(ErrorKind::UnexpectedEof) => Some(eof),
            Some(ErrorKind::ConnectionReset) => Some("connection reset by peer"),
            Some(ErrorKind::ConnectionAborted) => Some("connection aborted"),
            Some(ErrorKind::BrokenPipe) => Some("broken pipe"),
            Some(ErrorKind::TimedOut) => Some("timed out"),
            Some(ErrorKind::Interrupted) => Some("interrupted"),
            _ => {
                let message = cause.to_string().to_ascii_lowercase();
                if ["incomplete message", "connection closed before message completed", "unexpected eof", "end of file before message length reached"]
                    .iter().any(|phrase| message.contains(phrase))
                {
                    Some(eof)
                } else if message.contains("reset") {
                    Some("connection reset by peer")
                } else {
                    None
                }
            }
        };
        if detail.is_some() {
            return detail;
        }
        source = next_cause(cause);
    }
    None
}

pub async fn send(service: &str, request: reqwest::RequestBuilder) -> Result<Value, String> {
    let response = request.send().await.map_err(|e| transport_error(service, &e))?;
    let status = response.status().as_u16();
    if response.content_length().is_some_and(|n| n > LIMIT as u64) {
        return Err(format!("{service} sent a response that is too large."));
    }
    let bytes = response.bytes().await.map_err(|e| body_transport_error(service, status, &e))?;
    if bytes.len() > LIMIT {
        return Err(format!("{service} sent a response that is too large."));
    }
    let text = String::from_utf8_lossy(&bytes);
    if !(200..300).contains(&status) {
        return Err(error_message(service, status, &text));
    }
    if text.trim().is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(&text).map_err(|_| format!("{service} returned an unreadable response."))
}

/// Run an async request from a blocking worker thread.
pub fn block<T>(future: impl std::future::Future<Output = T>) -> T {
    tauri::async_runtime::block_on(future)
}

#[cfg(test)]
pub mod mock {
    //! A loopback HTTP/HTTPS server that answers from a routing function and records requests.
    use base64::Engine;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::{Arc, Mutex},
        thread,
        time::Duration,
    };

    // Test-only self-signed loopback CA (CN=PandaCode Test Loopback CA) and leaf certificate
    // (CN=127.0.0.1, SAN=IP:127.0.0.1, ECDSA P-256, valid 2020-01-01 to 2120-01-01) plus leaf
    // PKCS#8 key in base64-encoded DER. Never a real secret; used only by #[cfg(test)] servers.
    const TEST_LOOPBACK_CA_CERT_DER_B64: &str = "MIIBXzCCAQSgAwIBAgIBATAKBggqhkjOPQQDAjAlMSMwIQYDVQQDDBpQYW5kYUNvZGUgVGVzdCBMb29wYmFjayBDQTAgFw0yMDAxMDEwMDAwMDBaGA8yMTIwMDEwMTAwMDAwMFowJTEjMCEGA1UEAwwaUGFuZGFDb2RlIFRlc3QgTG9vcGJhY2sgQ0EwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAATJDIwjNuyLysPAbkw1FeJoqtgsOS3W/Y5lfTqr+9bxDFNJUhDzHmO1Gj5yggsE6Vh9EIlx7rkWQWiQzWciaFIaoyMwITAPBgNVHRMBAf8EBTADAQH/MA4GA1UdDwEB/wQEAwIBBjAKBggqhkjOPQQDAgNJADBGAiEAqC7OHZBhIKjknDDJHw/HafRxxqkQSkSnLd9chJZuj8ACIQD6CbWKnsbJkL9/WlujYOTmVTUQuT50QzZVVRfx6txtLA==";
    const TEST_LOOPBACK_LEAF_CERT_DER_B64: &str = "MIIBcDCCARagAwIBAgIBAjAKBggqhkjOPQQDAjAlMSMwIQYDVQQDDBpQYW5kYUNvZGUgVGVzdCBMb29wYmFjayBDQTAgFw0yMDAxMDEwMDAwMDBaGA8yMTIwMDEwMTAwMDAwMFowFDESMBAGA1UEAwwJMTI3LjAuMC4xMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEA0owfIyikd12iBLToGePKIJdNm/RrZ3NehGzbNwATEclmsXggFug8w+YyAIR4oCMCgUQ7+J8yrt/cKbEqfQv2KNGMEQwDAYDVR0TAQH/BAIwADAOBgNVHQ8BAf8EBAMCB4AwEwYDVR0lBAwwCgYIKwYBBQUHAwEwDwYDVR0RBAgwBocEfwAAATAKBggqhkjOPQQDAgNIADBFAiEA1EPVZ8LFJgrB/QErkwjmDxnRyDbBeMPb03fj5gk9ZCACIGRWJCYmCp/I0bz5y/Ml/swnbRylZxxg1CUlnXG8I4XP";
    const TEST_LOOPBACK_LEAF_KEY_PKCS8_DER_B64: &str = "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgQNnSTHC0twYNMK/IuvqCfwvdVlUTFBdC2Wc2jzrsO1ShRANCAAQDSjB8jKKR3XaIEtOgZ48ogl02b9Gtnc16EbNs3ABMRyWaxeCAW6DzD5jIAhHigIwKBRDv4nzKu39wpsSp9C/Y";

    fn loopback_ca_cert_der() -> Vec<u8> {
        base64::engine::general_purpose::STANDARD
            .decode(TEST_LOOPBACK_CA_CERT_DER_B64)
            .expect("valid test loopback CA cert DER")
    }

    fn loopback_leaf_cert_der() -> Vec<u8> {
        base64::engine::general_purpose::STANDARD
            .decode(TEST_LOOPBACK_LEAF_CERT_DER_B64)
            .expect("valid test loopback leaf cert DER")
    }

    fn loopback_leaf_key_der() -> Vec<u8> {
        base64::engine::general_purpose::STANDARD
            .decode(TEST_LOOPBACK_LEAF_KEY_PKCS8_DER_B64)
            .expect("valid test loopback leaf key DER")
    }

    /// The test-only root certificate trusted by loopback HTTPS tests.
    pub fn loopback_root_cert() -> reqwest::Certificate {
        reqwest::Certificate::from_der(&loopback_ca_cert_der()).expect("valid test root cert")
    }

    #[derive(Clone, Debug)]
    pub struct Request {
        pub method: String,
        pub path: String,
        pub authorization: Option<String>,
        pub headers: Vec<(String, String)>,
        pub body: String,
    }
    pub type Seen = Arc<Mutex<Vec<Request>>>;

    fn read_request(stream: &mut impl Read) -> Option<Request> {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 1024];
        let header_end = loop {
            if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                break pos + 4;
            }
            let n = stream.read(&mut chunk).ok()?;
            if n == 0 {
                return None;
            }
            buf.extend_from_slice(&chunk[..n]);
        };
        let header_text = String::from_utf8_lossy(&buf[..header_end - 4]);
        let mut lines = header_text.split("\r\n");
        let first = lines.next()?;
        let mut parts = first.split_whitespace();
        let (method, path) = (parts.next().unwrap_or("").to_string(), parts.next().unwrap_or("").to_string());
        let mut headers = Vec::new();
        let mut length = 0usize;
        for line in lines {
            if let Some((name, value)) = line.split_once(':') {
                let (name, value) = (name.trim().to_ascii_lowercase(), value.trim().to_string());
                if name == "content-length" {
                    length = value.parse().unwrap_or(0);
                }
                headers.push((name, value));
            }
        }
        let mut body = buf[header_end..].to_vec();
        if body.len() < length {
            let start = body.len();
            body.resize(length, 0);
            stream.read_exact(&mut body[start..]).ok()?;
        } else {
            body.truncate(length);
        }
        let authorization = headers.iter().find(|(n, _)| n == "authorization").map(|(_, v)| v.clone());
        Some(Request {
            authorization,
            method,
            path,
            headers,
            body: String::from_utf8_lossy(&body).into_owned(),
        })
    }

    /// Serve until the test ends; `route` gets each request and the server's base URL
    /// and returns (status, body).
    pub fn serve<R: Into<Vec<u8>>>(route: impl Fn(&Request, &str) -> (u16, R) + Send + 'static) -> (String, Seen) {
        serve_raw(move |request, base| {
            let (status, reply) = route(request, base);
            let reply = reply.into();
            let mut response = format!("HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", reply.len()).into_bytes();
            response.extend(reply);
            response
        })
    }

    /// Write the exact response bytes, including an empty response to simulate a dropped socket.
    pub fn serve_raw(route: impl Fn(&Request, &str) -> Vec<u8> + Send + 'static) -> (String, Seen) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let seen: Seen = Arc::default();
        let log = seen.clone();
        let own = base.clone();
        thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { return };
                let Some(request) = read_request(&mut stream) else { continue };
                let reply = route(&request, &own);
                log.lock().unwrap().push(request);
                let _ = stream.write_all(&reply);
            }
        });
        (base, seen)
    }

    /// Serve real HTTPS over loopback using rustls, writing the exact response bytes and then
    /// dropping the TCP socket without sending a TLS `close_notify` alert.
    pub fn serve_https_raw(route: impl Fn(&Request, &str) -> Vec<u8> + Send + Sync + 'static) -> (String, Seen) {
        let cert = rustls::pki_types::CertificateDer::from(loopback_leaf_cert_der());
        let key = rustls::pki_types::PrivateKeyDer::Pkcs8(
            rustls::pki_types::PrivatePkcs8KeyDer::from(loopback_leaf_key_der()),
        );
        let config = Arc::new(
            rustls::ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
                .with_safe_default_protocol_versions()
                .unwrap()
                .with_no_client_auth()
                .with_single_cert(vec![cert], key)
                .unwrap(),
        );
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("https://{}", listener.local_addr().unwrap());
        let seen: Seen = Arc::default();
        let log = seen.clone();
        let own = base.clone();
        let route = Arc::new(route);
        thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { return };
                let config = config.clone();
                let log = log.clone();
                let own = own.clone();
                let route = route.clone();
                thread::spawn(move || {
                    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                    let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
                    let Ok(conn) = rustls::ServerConnection::new(config) else { return };
                    let mut tls = rustls::StreamOwned::new(conn, stream);
                    let Some(request) = read_request(&mut tls) else { return };
                    let reply = route(&request, &own);
                    log.lock().unwrap().push(request);
                    if !reply.is_empty() {
                        let _ = tls.write_all(&reply);
                        let _ = tls.flush();
                    }
                    // Intentionally drop without calling send_close_notify() to reproduce
                    // unclean HTTPS EOFs (rustls ErrorKind::UnexpectedEof).
                });
            }
        });
        (base, seen)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transport_errors_classify_dropped_connections_without_echoing_the_request() {
        let (base, _) = mock::serve_raw(|_, _| Vec::new());
        let error = block(async {
            client(Duration::from_secs(5)).unwrap()
                .post(format!("{base}/private?token=private-query"))
                .bearer_auth("private-header")
                .send().await.unwrap_err()
        });
        assert!(error.url().unwrap().as_str().contains("private-query"));
        assert_eq!(transport_error("Sandbox", &error), "Sandbox request failed (connection closed before response).");
    }

    #[test]
    fn transport_errors_label_eof_during_the_response_body() {
        let (base, _) = mock::serve_raw(|_, _| {
            b"HTTP/1.1 200 OK\r\nContent-Length: 200\r\nConnection: close\r\n\r\n0123456789".to_vec()
        });
        let error = block(async {
            let response = client(Duration::from_secs(5)).unwrap()
                .get(format!("{base}/private?token=private-query"))
                .send().await.unwrap();
            response.bytes().await.unwrap_err()
        });
        assert_eq!(body_transport_error("Sandbox", 200, &error), "Sandbox request failed (connection closed while reading response).");
    }

    #[test]
    fn https_pre_header_drop_without_close_notify_is_not_a_tls_error() {
        let (base, _) = mock::serve_https_raw(|_, _| Vec::new());
        let error = block(async {
            client_with_root(Duration::from_secs(5), mock::loopback_root_cert())
                .unwrap()
                .post(format!("{base}/private?token=private-query"))
                .bearer_auth("private-header")
                .send()
                .await
                .unwrap_err()
        });
        assert!(!is_tls_error(&error));
        assert_eq!(transport_error("Sandbox", &error), "Sandbox request failed (connection closed before response).");
    }

    #[test]
    fn https_mid_body_truncation_without_close_notify_is_not_a_tls_error() {
        let (base, _) = mock::serve_https_raw(|_, _| {
            b"HTTP/1.1 200 OK\r\nContent-Length: 200\r\nConnection: close\r\n\r\n0123456789".to_vec()
        });
        let error = block(async {
            let response = client_with_root(Duration::from_secs(5), mock::loopback_root_cert())
                .unwrap()
                .get(format!("{base}/private?token=private-query"))
                .send()
                .await
                .unwrap();
            response.bytes().await.unwrap_err()
        });
        assert!(!is_tls_error(&error));
        assert_eq!(body_transport_error("Sandbox", 200, &error), "Sandbox request failed (connection closed while reading response).");
    }

    #[test]
    fn https_untrusted_self_signed_certificate_is_still_a_tls_error() {
        let (base, _) = mock::serve_https_raw(|_, _| {
            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}".to_vec()
        });
        let error = block(async {
            client(Duration::from_secs(5))
                .unwrap()
                .get(format!("{base}/private?token=private-query"))
                .send()
                .await
                .unwrap_err()
        });
        assert!(is_tls_error(&error));
        assert_eq!(transport_error("Sandbox", &error), "Could not reach Sandbox. Check your connection.");
    }

    #[test]
    fn transport_errors_recognize_a_tls_alert() {
        use std::io::{Read, Write};

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut header = [0; 5];
            stream.read_exact(&mut header).unwrap();
            let mut hello = vec![0; u16::from_be_bytes([header[3], header[4]]) as usize];
            stream.read_exact(&mut hello).unwrap();
            // A fatal access_denied alert has no "TLS" or "certificate" in its label.
            stream.write_all(&[21, 3, 3, 0, 2, 2, 49]).unwrap();
        });
        let error = block(async {
            client(Duration::from_secs(5)).unwrap()
                .get(format!("https://{address}/private?token=private-query"))
                .send().await.unwrap_err()
        });
        server.join().unwrap();
        assert!(is_tls_error(&error));
        assert_eq!(transport_error("Sandbox", &error), "Could not reach Sandbox. Check your connection.");
    }

    #[test]
    fn transport_errors_keep_the_connection_hint() {
        // Port zero asks bind() to allocate a port, so no TCP listener owns port zero.
        let error = block(async {
            client(Duration::from_secs(5)).unwrap()
                .get("http://127.0.0.1:0/private?token=private-query")
                .send().await.unwrap_err()
        });
        assert!(error.is_connect());
        assert_eq!(transport_error("Sandbox", &error), "Could not reach Sandbox. Check your connection.");
    }

    #[test]
    fn errors_name_the_service_and_never_echo_html() {
        assert_eq!(error_message("Daytona", 400, r#"{"message":"Snapshot not found"}"#), "Daytona: Snapshot not found");
        assert!(error_message("AWS", 403, "denied").contains("refused the credentials"));
        assert_eq!(error_message("Cloudflare", 502, "<html>bad gateway</html>"), "Cloudflare returned HTTP 502.");
        assert_eq!(error_message("Cloudflare", 400, r#"{"errors":[{"message":"Bad token"}]}"#), "Cloudflare: Bad token");
    }

    #[test]
    fn refusals_keep_the_providers_message_and_the_hint_but_never_a_token() {
        assert_eq!(error_message("Blaxel", 403, r#"{"error":"Workspace mismatch."}"#), "Blaxel refused the credentials (HTTP 403): Workspace mismatch. Check them in Settings → Cloud.");
        let generic = "Blaxel refused the credentials (HTTP 401). Check them in Settings → Cloud.";
        assert_eq!(error_message("Blaxel", 401, r#"{"message":"Invalid key bl_abcdefghijklmnopqrstuvwxyz"}"#), generic);
        // Only a structured message counts: a raw body could hold anything.
        assert_eq!(error_message("Blaxel", 401, "denied for this key"), generic);
        assert_eq!(error_message("Blaxel", 401, r#"{"message":"  "}"#), generic);
    }
}
