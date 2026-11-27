use super::*;
use crate::cloud::http::mock;
use serde_json::json;
use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicUsize, Ordering};

fn sessions() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("pandacode-colab-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&dir).unwrap();
    dir.join(store::SESSIONS_FILE)
}
fn colab(base: &str, sessions: &std::path::Path) -> Colab {
    Colab::with(Urls::mock(base), Auth::Token("tok".into()), sessions.to_path_buf(), Duration::ZERO)
}
fn query(path: &str) -> HashMap<String, String> {
    Url::parse(&format!("http://x{path}")).unwrap().query_pairs().into_owned().collect()
}
fn header<'a>(request: &'a mock::Request, name: &str) -> Option<&'a str> {
    request.headers.iter().find(|(n, _)| n == name).map(|(_, v)| v.as_str())
}
/// Like Colab's HTTP/1.1 frontend, refuse an (empty) POST without `Content-Length: 0` with HTTP 411.
fn length_required(request: &mock::Request) -> bool {
    request.method == "POST" && header(request, "content-length") != Some("0")
}
const ASSIGNMENT: &str = r#"{"accelerator":"T4","endpoint":"gpu-t4-s-new","variant":1,"machineShape":1,"runtimeProxyInfo":{"token":"proxy","tokenExpiresInSeconds":3600,"url":"https://8080-gpu-t4-s-new.prod.colab.dev"}}"#;

#[test]
fn maps_accelerators_to_variants_and_shapes() {
    assert_eq!(variant("NONE"), "DEFAULT");
    assert_eq!(variant("T4"), "GPU");
    assert_eq!(variant("H100"), "GPU");
    assert_eq!(variant("V5E1"), "TPU");
    assert_eq!(shape_param("T4", true), Some("hm"));
    assert_eq!(shape_param("NONE", true), Some("hm"));
    for single in ["L4", "V5E1", "V6E1"] {
        assert_eq!(shape_param(single, true), None, "{single} has one shape");
    }
    assert_eq!(shape_param("A100", false), None);
    assert_eq!(parse_accelerator(" t4 ").unwrap(), "T4");
    assert_eq!(parse_accelerator("cpu").unwrap(), "NONE");
    assert_eq!(parse_accelerator("").unwrap(), "NONE");
    assert!(parse_accelerator("K80").is_err());
    assert_eq!(hardware_label("NONE"), "CPU");
    assert_eq!(hardware_label("V6E1"), "v6e-1 TPU");
    assert_eq!(hardware_label("A100"), "A100 GPU");
}

#[test]
fn formats_hashes_urls_and_details() {
    let id = uuid::Uuid::parse_str("12345678-1234-4234-8234-123456789abc").unwrap();
    let hash = nbh(id);
    assert_eq!(hash, "12345678_1234_4234_8234_123456789abc........");
    assert_eq!(hash.len(), 44);
    assert_eq!(browser_url("gpu-t4-s-1"), "https://colab.research.google.com/notebooks/empty.ipynb?dbu=%2Ftun%2Fm%2Fgpu-t4-s-1#datalabBackendUrl=https://colab.research.google.com/tun/m/gpu-t4-s-1");
    assert_eq!(strip_xssi(")]}'\n{\"a\":1}"), "{\"a\":1}");
    assert_eq!(strip_xssi("{}"), "{}");
    assert_eq!(detail("a@b.c", "NONE", false), "a@b.c");
    assert_eq!(detail("a@b.c", "T4", false), "a@b.c · T4 GPU");
    assert_eq!(detail("a@b.c", "T4", true), "a@b.c · T4 GPU · High-RAM");
    for single in ["L4", "V5E1", "V6E1"] {
        assert!(!detail("a@b.c", single, true).contains("High-RAM"), "{single} has one shape");
    }
    assert_eq!(detail("a@b.c", "NONE", true), "a@b.c · CPU · High-RAM");
    assert_eq!(form(&[("a", "x y"), ("b", "1/2&3")]), "a=x+y&b=1%2F2%263");
}

#[test]
fn reconciling_keeps_names_and_kernels_and_drops_gone_runtimes() {
    let mut known = Records::new();
    known.insert("gpu-t4-s-1".into(), SessionRecord { name: "pc-mine".into(), endpoint: "gpu-t4-s-1".into(), kernel_id: Some("k".into()), ..SessionRecord::default() });
    known.insert("gone".into(), SessionRecord { name: "pc-gone".into(), endpoint: "gone".into(), ..SessionRecord::default() });
    let list: Value = serde_json::from_str(r#"[
        {"accelerator":"T4","endpoint":"gpu-t4-s-1","variant":1,"machineShape":0,"runtimeProxyInfo":{"token":"t1","tokenExpiresInSeconds":100,"url":"https://a"}},
        {"accelerator":"NONE","endpoint":"m-s-2","variant":0,"machineShape":1,"runtimeProxyInfo":{"token":"t2","tokenExpiresInSeconds":50,"url":"https://b"}},
        {"accelerator":"NONE","endpoint":"../bad","variant":0,"runtimeProxyInfo":{}}
    ]"#).unwrap();
    let next = reconcile(&known, list.as_array().unwrap(), 1000, i64::MAX);
    assert_eq!(next.keys().cloned().collect::<Vec<_>>(), vec!["gpu-t4-s-1", "m-s-2"]);
    let mine = &next["gpu-t4-s-1"];
    assert_eq!((mine.name.as_str(), mine.kernel_id.as_deref(), mine.token.as_str(), mine.token_expires_at, mine.variant.as_str()), ("pc-mine", Some("k"), "t1", 1100, "GPU"));
    let other = &next["m-s-2"];
    assert_eq!((other.name.as_str(), other.machine_shape.as_str(), other.variant.as_str()), ("m-s-2", "HIGH_RAM", "DEFAULT"));
    let machine = machine(other);
    assert_eq!(machine.id, "colab:m-s-2");
    assert_eq!(machine.detail, "Google Colab · CPU · High-RAM");
    assert_eq!((machine.provider.as_str(), machine.os.as_str(), machine.state.as_str(), machine.desktop), ("colab", "linux", "running", false));
}

#[test]
fn reconciling_keeps_runtimes_created_after_the_list_was_asked_for() {
    let mut known = Records::new();
    known.insert("old".into(), SessionRecord { endpoint: "old".into(), created_at: 100, ..SessionRecord::default() });
    known.insert("brand-new".into(), SessionRecord { name: "pc-new".into(), endpoint: "brand-new".into(), created_at: 500, ..SessionRecord::default() });
    let next = reconcile(&known, &[], 600, 500);
    assert_eq!(next.keys().cloned().collect::<Vec<_>>(), vec!["brand-new"], "another process made it while the list was on its way");
    assert!(reconcile(&known, &[], 600, 501).is_empty());
}

#[test]
fn lists_runtimes_behind_the_xssi_prefix_and_saves_them() {
    let (base, seen) = mock::serve(|request, _| -> (u16, String) {
        match request.path.split('?').next().unwrap() {
            "/tun/m/assignments" => (200, format!(")]}}'\n{{\"assignments\":[{ASSIGNMENT}]}}")),
            _ => (404, "{}".into()),
        }
    });
    let path = sessions();
    store::update(&path, |_| {
        let mut known = Records::new();
        known.insert("gpu-t4-s-new".into(), SessionRecord { name: "pc-abc".into(), endpoint: "gpu-t4-s-new".into(), ..SessionRecord::default() });
        known.insert("stale".into(), SessionRecord { endpoint: "stale".into(), ..SessionRecord::default() });
        (known, ())
    })
    .unwrap();
    let machines = colab(&base, &path).machines().unwrap();
    assert_eq!(machines.len(), 1);
    assert_eq!(machines[0].name, "pc-abc");
    assert_eq!(machines[0].detail, "Google Colab · T4 GPU · High-RAM");
    let saved = store::load(&path);
    assert!(!saved.contains_key("stale"));
    assert_eq!(saved["gpu-t4-s-new"].url, "https://8080-gpu-t4-s-new.prod.colab.dev");
    let log = seen.lock().unwrap();
    let request = &log[0];
    assert_eq!(request.authorization.as_deref(), Some("Bearer tok"));
    assert_eq!(header(request, "x-colab-client-agent"), Some("colab-cli"));
    assert_eq!(header(request, "accept"), Some("application/json"));
    assert_eq!(query(&request.path).get("authuser").map(String::as_str), Some("0"));
}

#[test]
fn assigns_with_the_xsrf_token_and_retries_a_bad_gateway() {
    let posts = AtomicUsize::new(0);
    let (base, seen) = mock::serve(move |request, _| -> (u16, String) {
        if length_required(request) { return (411, "{}".into()); }
        match (request.method.as_str(), request.path.split('?').next().unwrap()) {
            ("GET", "/tun/m/assign") => (200, ")]}'\n{\"acc\":\"T4\",\"nbh\":\"x\",\"token\":\"xsrf-1\",\"variant\":\"GPU\"}".into()),
            ("POST", "/tun/m/assign") if posts.fetch_add(1, Ordering::SeqCst) == 0 => (503, "{}".into()),
            ("POST", "/tun/m/assign") => (200, format!(")]}}'\n{ASSIGNMENT}")),
            _ => (404, "{}".into()),
        }
    });
    let path = sessions();
    let before = now();
    let machine = colab(&base, &path).create_with("pc-train", "t4", true).unwrap();
    assert_eq!(machine.id, "colab:gpu-t4-s-new");
    assert_eq!(machine.name, "pc-train");
    let saved = &store::load(&path)["gpu-t4-s-new"];
    assert!(saved.created_at >= before, "a new runtime remembers when it was made");
    assert_eq!((saved.name.as_str(), saved.token.as_str(), saved.accelerator.as_str()), ("pc-train", "proxy", "T4"));
    let log = seen.lock().unwrap();
    let methods: Vec<&str> = log.iter().map(|r| r.method.as_str()).collect();
    assert_eq!(methods, vec!["GET", "POST", "GET", "POST"]);
    let first = query(&log[0].path);
    assert_eq!(first["nbh"].len(), 44);
    assert_eq!((first["variant"].as_str(), first["accelerator"].as_str(), first["shape"].as_str(), first["authuser"].as_str()), ("GPU", "T4", "hm", "0"));
    assert!(log.iter().filter(|r| r.method == "POST").all(|r| header(r, "x-goog-colab-token") == Some("xsrf-1")));
    assert!(log.iter().filter(|r| r.method == "POST").all(|r| header(r, "content-length") == Some("0")), "empty POSTs carry Content-Length: 0");
    assert!(log.iter().all(|r| r.path == log[0].path), "every attempt reuses the same notebook hash");
}

#[test]
fn assign_returns_an_existing_assignment_and_skips_shape_for_single_shape_hardware() {
    let (base, seen) = mock::serve(|_, _| -> (u16, String) { (200, ASSIGNMENT.into()) });
    let path = sessions();
    let machine = colab(&base, &path).create_with("", "L4", true).unwrap();
    assert!(machine.name.starts_with("pc-") && machine.name.len() == 9);
    let log = seen.lock().unwrap();
    assert_eq!(log.len(), 1);
    assert!(!query(&log[0].path).contains_key("shape"));
}

#[test]
fn explains_assignment_refusals() {
    let (base, _) = mock::serve(|request, _| -> (u16, String) {
        if length_required(request) { return (411, "{}".into()); }
        match request.method.as_str() {
            "GET" => (200, r#"{"token":"x"}"#.into()),
            _ if request.path.contains("accelerator=A100") => (400, "{}".into()),
            _ => (412, "{}".into()),
        }
    });
    let path = sessions();
    assert!(colab(&base, &path).create_with("a", "A100", false).unwrap_err().contains("no quota or entitlement for accelerator A100"));
    assert!(colab(&base, &path).create_with("a", "NONE", false).unwrap_err().contains("too many active Colab sessions"));
}

#[test]
fn unassigns_with_the_xsrf_token_and_forgets_the_runtime() {
    let (base, seen) = mock::serve(|request, _| -> (u16, String) {
        if length_required(request) { return (411, "{}".into()); }
        match (request.method.as_str(), request.path.split('?').next().unwrap()) {
            ("GET", "/tun/m/unassign/gpu-1") => (200, ")]}'\n{\"token\":\"un-xsrf\"}".into()),
            ("POST", "/tun/m/unassign/gpu-1") => (200, String::new()),
            ("GET", "/tun/m/unassign/gone-1") => (404, "{}".into()),
            _ => (500, "{}".into()),
        }
    });
    let path = sessions();
    store::update(&path, |_| (Records::from([("gpu-1".to_string(), SessionRecord { endpoint: "gpu-1".into(), ..SessionRecord::default() })]), ())).unwrap();
    let client = colab(&base, &path);
    Sandbox::power(&client, "gpu-1", "stop").unwrap();
    assert!(store::load(&path).is_empty());
    Sandbox::power(&client, "gone-1", "delete").unwrap();
    assert!(Sandbox::power(&client, "gpu-1", "start").unwrap_err().contains("cannot be restarted"));
    assert!(client.unassign("../x").is_err());
    let log = seen.lock().unwrap();
    let post = log.iter().find(|r| r.method == "POST").unwrap();
    assert_eq!(header(post, "x-goog-colab-token"), Some("un-xsrf"));
    assert_eq!(header(post, "content-length"), Some("0"), "an empty POST carries Content-Length: 0");
}

#[test]
fn keeps_alive_and_reads_compute_units() {
    let (base, seen) = mock::serve(|request, _| -> (u16, String) {
        match request.path.split('?').next().unwrap() {
            "/tun/m/gpu-1/keep-alive/" => (200, String::new()),
            "/tun/m/ccu-info" => (200, ")]}'\n{\"currentBalance\":97.5,\"consumptionRateHourly\":1.76,\"assignmentsCount\":1}".into()),
            _ => (404, "{}".into()),
        }
    });
    let path = sessions();
    let client = colab(&base, &path);
    // The 15 idle minutes after a run are not worth another 90 billed minutes: no request.
    Sandbox::keep_alive(&client, "gpu-1", 15).unwrap();
    assert!(seen.lock().unwrap().is_empty());
    Sandbox::keep_alive(&client, "gpu-1", UNATTENDED_MINUTES).unwrap();
    assert_eq!(client.usage().unwrap(), Some((97.5, 1.76)));
    let log = seen.lock().unwrap();
    assert_eq!(log[0].path.split('?').next(), Some("/tun/m/gpu-1/keep-alive/"));
    assert_eq!(header(&log[0], "x-colab-tunnel"), Some("Google"));
    assert_eq!(log[0].authorization.as_deref(), Some("Bearer tok"));
}

#[test]
fn a_runtime_colab_no_longer_lists_is_reported_as_gone_for_good() {
    let (base, _) = mock::serve(|_, _| -> (u16, String) { (200, r#"{"assignments":[]}"#.into()) });
    let client = colab(&base, &sessions());
    let error = Sandbox::exec(&client, "gpu-ended", "true", Duration::from_secs(5)).unwrap_err();
    assert_eq!(error, format!("{MACHINE_GONE}{GONE}"));
    assert!(Sandbox::upload(&client, "gpu-ended", "/root/x", b"x", false).unwrap_err().starts_with(MACHINE_GONE));
    // The native tools keep the plain message.
    assert_eq!(client.runtime("gpu-ended").unwrap_err(), GONE);
    assert_eq!(tag_gone("Could not reach Google Colab.".into()), "Could not reach Google Colab.");
}

#[test]
fn packages_are_pinned_and_the_config_is_local() {
    assert!(COLAB_MCP_PKG.starts_with("git+https://github.com/googlecolab/colab-mcp@") && COLAB_MCP_PKG.len() == "git+https://github.com/googlecolab/colab-mcp@".len() + 40);
    assert_eq!(COLAB_CLI_PKG, "google-colab-cli==0.8.0");
    let command = uv_install_command(std::path::Path::new("/bin/uv"));
    assert_eq!(command.get_args().collect::<Vec<_>>(), ["tool", "install", "google-colab-cli==0.8.0"]);
    let config = local_config(&BTreeMap::new(), false);
    assert_eq!((config.ccu_balance, config.ccu_rate), (None, None));
    let usage = serde_json::to_value(ColabUsage { ccu_balance: Some(1.5), ccu_rate: None }).unwrap();
    assert_eq!(usage, json!({"ccuBalance": 1.5, "ccuRate": null}));
}

#[test]
fn disconnect_revokes_only_pandacodes_own_grant() {
    let secret = OAuthSecret { refresh_token: "1//r".into(), access_token: "ya29".into(), ..OAuthSecret::default() };
    assert_eq!(settings::token_to_revoke("oauth2", &secret).as_deref(), Some("1//r"));
    assert_eq!(settings::token_to_revoke("oauth2", &OAuthSecret { refresh_token: String::new(), ..secret.clone() }).as_deref(), Some("ya29"));
    assert_eq!(settings::token_to_revoke("adc", &secret), None, "gcloud's grant is shared with the user's other tools");
    assert_eq!(settings::token_to_revoke("oauth2", &OAuthSecret::default()), None);
}

#[test]
fn a_runtime_token_is_reused_while_fresh_and_refreshed_near_expiry() {
    let calls = AtomicUsize::new(0);
    let (base, _) = mock::serve(move |_, _| -> (u16, String) {
        calls.fetch_add(1, Ordering::SeqCst);
        (200, format!("{{\"assignments\":[{ASSIGNMENT}]}}"))
    });
    let path = sessions();
    let fresh = SessionRecord { name: "n".into(), endpoint: "gpu-t4-s-new".into(), url: "https://cached".into(), token: "cached".into(), token_expires_at: now() + 3000, ..SessionRecord::default() };
    store::update(&path, |_| (Records::from([("gpu-t4-s-new".to_string(), fresh.clone())]), ())).unwrap();
    let client = colab(&base, &path);
    assert_eq!(client.runtime("gpu-t4-s-new").unwrap().token, "cached");
    store::update(&path, |_| (Records::from([("gpu-t4-s-new".to_string(), SessionRecord { token_expires_at: now() + 60, ..fresh.clone() })]), ())).unwrap();
    let renewed = client.runtime("gpu-t4-s-new").unwrap();
    assert_eq!((renewed.token.as_str(), renewed.name.as_str()), ("proxy", "n"));
    assert!(client.runtime("other").unwrap_err().contains("no longer exists"));
}

#[tokio::test]
async fn refreshes_access_tokens_with_the_refresh_grant() {
    let (base, seen) = mock::serve(|request, _| -> (u16, String) {
        if request.body.contains("refresh_token=revoked") {
            (400, r#"{"error":"invalid_grant","error_description":"Token has been expired or revoked."}"#.into())
        } else {
            (200, r#"{"access_token":"new","expires_in":3599}"#.into())
        }
    });
    let urls = Urls::mock(&base);
    let credentials = OAuthSecret { client_id: "c".into(), client_secret: "s".into(), refresh_token: "r".into(), ..OAuthSecret::default() };
    let (token, expires_at, rotated) = refresh(&urls, &credentials).await.unwrap();
    assert_eq!((token.as_str(), rotated), ("new", None));
    assert!(expires_at > now() + 3000);
    let revoked = OAuthSecret { refresh_token: "revoked".into(), ..credentials.clone() };
    assert!(refresh(&urls, &revoked).await.unwrap_err().contains("Sign in to Google Colab again"));
    assert!(refresh(&urls, &OAuthSecret::default()).await.is_err());
    let log = seen.lock().unwrap();
    assert_eq!(log[0].path, "/token");
    assert!(header(&log[0], "content-type").is_some_and(|v| v.starts_with("application/x-www-form-urlencoded")));
    assert!(log[0].body.contains("grant_type=refresh_token") && log[0].body.contains("client_id=c"));
}

#[test]
fn options_validate_and_keep_choices_on_a_new_sign_in() {
    let first = signed_in_options(&BTreeMap::new(), "a@b.c", "oauth2").unwrap();
    assert_eq!(first["nativeTools"], "true");
    assert_eq!(first["colabMcp"], "false");
    assert_eq!(first["accelerator"], "NONE");
    assert_eq!(first["highMem"], "false");
    assert_eq!(first["detail"], "a@b.c");
    let chosen = apply_options(&first, &json!({"accelerator": "a100", "highMem": true, "colabMcp": "true", "nativeTools": false})).unwrap();
    assert_eq!(chosen["accelerator"], "A100");
    assert_eq!(chosen["detail"], "a@b.c · A100 GPU · High-RAM");
    assert_eq!(chosen["nativeTools"], "false");
    let again = signed_in_options(&chosen, "new@b.c", "adc").unwrap();
    assert_eq!((again["accelerator"].as_str(), again["colabMcp"].as_str(), again["authMode"].as_str(), again["email"].as_str()), ("A100", "true", "adc", "new@b.c"));
    assert!(apply_options(&first, &json!({"accelerator": "K80"})).is_err());
    assert!(apply_options(&first, &json!({"highMem": "yes"})).is_err());
    let config = local_config(&chosen, true);
    assert!(config.connected && config.high_mem && config.colab_mcp && !config.native_tools);
    assert_eq!(config.accelerator, "A100");
}

#[test]
fn colab_runtimes_are_not_persistent_and_stop_when_idle() {
    let client = colab("http://127.0.0.1:9", &sessions());
    let info = Sandbox::info(&client);
    assert!(!info.persistent);
    assert_eq!(info.max_unattended_minutes, 90);
}

/// Live: lists the signed-in account's runtimes and compute units. Run with
/// `cargo test --lib cloud::colab::tests::live -- --ignored` after signing in in the app.
#[test]
#[ignore = "requires a signed-in Google Colab account"]
fn live_lists_runtimes_and_compute_units() {
    let colab = Colab::connected().expect("sign in to Google Colab in Settings → Cloud first");
    let machines = colab.machines().unwrap();
    assert!(machines.iter().all(|machine| machine.provider == PROVIDER && machine.id.starts_with("colab:")));
    let usage = usage_summary().unwrap();
    assert!(usage.ccu_balance.is_none_or(|balance| balance >= 0.0));
}

fn raw_reply(body: &str) -> Vec<u8> {
    format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).into_bytes()
}

fn recovers_committed_assignment(dropped_reply: &'static [u8]) {
    let requests = AtomicUsize::new(0);
    let (base, seen) = mock::serve_raw(move |request, _| {
        assert_eq!(request.path.split('?').next(), Some("/tun/m/assign"));
        match requests.fetch_add(1, Ordering::SeqCst) {
            0 => raw_reply(r#"{"token":"initial"}"#),
            1 => dropped_reply.to_vec(),
            _ => raw_reply(ASSIGNMENT),
        }
    });
    let machine = colab(&base, &sessions()).create_with("pc-train", "T4", false).unwrap();
    assert_eq!(machine.id, "colab:gpu-t4-s-new");
    let log = seen.lock().unwrap();
    assert_eq!(log.iter().map(|r| r.method.as_str()).collect::<Vec<_>>(), ["GET", "POST", "GET"]);
    assert!(log.iter().all(|r| r.path == log[0].path));
}

#[test]
fn dropped_assign_headers_reconcile_an_existing_runtime() {
    recovers_committed_assignment(b"");
}

#[test]
fn truncated_assign_body_reconciles_an_existing_runtime() {
    recovers_committed_assignment(b"HTTP/1.1 200 OK\r\nContent-Length: 200\r\nConnection: close\r\n\r\n0123456789");
}

#[test]
fn dropped_assign_retries_with_a_fresh_token() {
    let requests = AtomicUsize::new(0);
    let (base, seen) = mock::serve_raw(move |_, _| {
        match requests.fetch_add(1, Ordering::SeqCst) {
            0 => raw_reply(r#"{"token":"initial"}"#),
            1 => Vec::new(),
            2 => raw_reply(r#"{"token":"fresh"}"#),
            _ => raw_reply(ASSIGNMENT),
        }
    });
    let machine = colab(&base, &sessions()).create_with("pc-train", "T4", false).unwrap();
    assert_eq!(machine.id, "colab:gpu-t4-s-new");
    let log = seen.lock().unwrap();
    assert_eq!(log.iter().map(|r| r.method.as_str()).collect::<Vec<_>>(), ["GET", "POST", "GET", "POST"]);
    assert_eq!(header(&log[1], "x-goog-colab-token"), Some("initial"));
    assert_eq!(header(&log[3], "x-goog-colab-token"), Some("fresh"));
    assert!(log.iter().all(|r| r.path == log[0].path));
}

#[test]
fn dropped_reconcile_get_retries_before_posting_again() {
    let requests = AtomicUsize::new(0);
    let (base, seen) = mock::serve_raw(move |_, _| {
        match requests.fetch_add(1, Ordering::SeqCst) {
            0 => raw_reply(r#"{"token":"initial"}"#),
            1 | 2 => Vec::new(),
            _ => raw_reply(ASSIGNMENT),
        }
    });
    let machine = colab(&base, &sessions()).create_with("pc-train", "T4", false).unwrap();
    assert_eq!(machine.id, "colab:gpu-t4-s-new");
    assert_eq!(seen.lock().unwrap().iter().map(|r| r.method.as_str()).collect::<Vec<_>>(), ["GET", "POST", "GET", "GET"]);
}

#[test]
fn repeated_assign_drops_exhaust_retries_without_leaking_credentials() {
    let (base, seen) = mock::serve_raw(|request, _| {
        if request.method == "POST" { Vec::new() } else { raw_reply(r#"{"token":"private-xsrf"}"#) }
    });
    let client = Colab::with(Urls::mock(&base), Auth::Token("private-auth".into()), sessions(), Duration::ZERO);
    let error = client.create_with("pc-train", "T4", false).err().unwrap();
    assert_eq!(error, "Google Colab request failed (connection closed before response).");
    for secret in ["private-auth", "private-xsrf", "nbh", "127.0.0.1"] {
        assert!(!error.contains(secret));
    }
    let log = seen.lock().unwrap();
    assert_eq!(log.iter().filter(|r| r.method == "POST").count(), ASSIGN_RETRIES as usize + 1);
    assert_eq!(log.len(), 2 + 2 * (ASSIGN_RETRIES as usize + 1));
    assert_eq!(log.last().unwrap().method, "GET");
    assert!(log.iter().all(|r| r.path == log[0].path));
}

#[test]
fn final_dropped_post_can_recover_the_runtime() {
    let posts = AtomicUsize::new(0);
    let (base, seen) = mock::serve_raw(move |request, _| {
        if request.method == "POST" {
            posts.fetch_add(1, Ordering::SeqCst);
            Vec::new()
        } else if posts.load(Ordering::SeqCst) > ASSIGN_RETRIES as usize {
            raw_reply(ASSIGNMENT)
        } else {
            raw_reply(r#"{"token":"xsrf"}"#)
        }
    });
    let machine = colab(&base, &sessions()).create_with("pc-train", "T4", false).unwrap();
    assert_eq!(machine.id, "colab:gpu-t4-s-new");
    let log = seen.lock().unwrap();
    assert_eq!(log.len(), 1 + 2 * (ASSIGN_RETRIES as usize + 1));
    assert_eq!(log.last().unwrap().method, "GET");
    assert!(log.iter().all(|r| r.path == log[0].path));
}

#[test]
fn budget_preserves_reconciliation_after_backoff_leaves_no_time_to_post() {
    let requests = AtomicUsize::new(0);
    let (base, seen) = mock::serve_raw(move |_, _| {
        match requests.fetch_add(1, Ordering::SeqCst) {
            0 => raw_reply(r#"{"token":"initial"}"#),
            1 => Vec::new(),
            2 => raw_reply(r#"{"token":"fresh"}"#),
            _ => raw_reply(ASSIGNMENT),
        }
    });
    let client = Colab::with(Urls::mock(&base), Auth::Token("tok".into()), sessions(), Duration::from_millis(550));
    let reply = block(async {
        let deadline = tokio::time::Instant::now() + RECONCILE_RESERVE + MIN_POST_BUDGET + Duration::from_millis(450);
        client.assign_until("T4", false, deadline).await.unwrap()
    });
    assert_eq!(reply["endpoint"], "gpu-t4-s-new");
    let log = seen.lock().unwrap();
    assert_eq!(log.iter().map(|r| r.method.as_str()).collect::<Vec<_>>(), ["GET", "POST", "GET", "GET"]);
    assert!(log.iter().all(|r| r.path == log[0].path));
}

#[test]
fn truncated_assignment_refusals_preserve_the_status_and_do_not_retry() {
    for (status, expected) in [
        (412, "Google Colab refused the runtime: too many active Colab sessions, or a usage or capacity limit. Stop a runtime, wait and retry, or pick other hardware."),
        (400, "Google Colab has no quota or entitlement for accelerator T4 on this account. Pick another (for example T4) or use a CPU runtime."),
        (401, "Google Colab refused the credentials (HTTP 401). Check them in Settings → Cloud."),
        (403, "Google Colab refused the credentials (HTTP 403). Check them in Settings → Cloud."),
        (500, "Google Colab returned HTTP 500."),
    ] {
        let (base, seen) = mock::serve_raw(move |request, _| {
            if request.method == "POST" {
                format!("HTTP/1.1 {status} Refused\r\nContent-Length: 200\r\nConnection: close\r\n\r\n0123456789").into_bytes()
            } else {
                raw_reply(r#"{"token":"xsrf"}"#)
            }
        });
        let error = colab(&base, &sessions()).create_with("pc-train", "T4", false).err().unwrap();
        assert_eq!(error, expected);
        let log = seen.lock().unwrap();
        assert_eq!(log.iter().map(|r| r.method.as_str()).collect::<Vec<_>>(), ["GET", "POST"]);
    }
}

fn recovers_committed_https_assignment(dropped_reply: &'static [u8]) {
    let requests = AtomicUsize::new(0);
    let (base, seen) = mock::serve_https_raw(move |request, _| {
        assert_eq!(request.path.split('?').next(), Some("/tun/m/assign"));
        match requests.fetch_add(1, Ordering::SeqCst) {
            0 => raw_reply(r#"{"token":"initial"}"#),
            1 => dropped_reply.to_vec(),
            _ => raw_reply(ASSIGNMENT),
        }
    });
    let client = colab(&base, &sessions()).with_root_cert(mock::loopback_root_cert());
    let machine = client.create_with("pc-train", "T4", false).unwrap();
    assert_eq!(machine.id, "colab:gpu-t4-s-new");
    let log = seen.lock().unwrap();
    assert_eq!(log.iter().map(|r| r.method.as_str()).collect::<Vec<_>>(), ["GET", "POST", "GET"]);
    assert!(log.iter().all(|r| r.path == log[0].path));
}

#[test]
fn https_pre_header_drop_without_close_notify_reconciles_runtime() {
    recovers_committed_https_assignment(b"");
}

#[test]
fn https_mid_body_truncation_without_close_notify_reconciles_runtime() {
    recovers_committed_https_assignment(
        b"HTTP/1.1 200 OK\r\nContent-Length: 200\r\nConnection: close\r\n\r\n0123456789",
    );
}

#[test]
fn stalled_error_bodies_hitting_deadline_preserve_status_without_retrying() {
    use std::io::{Read, Write};
    use std::net::TcpListener;

    let spawn_stalled = |status: u16| -> (String, Arc<Mutex<Vec<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let methods = Arc::new(Mutex::new(Vec::new()));
        let recorded = methods.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { return };
                let recorded = recorded.clone();
                std::thread::spawn(move || {
                    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
                    let mut buf = Vec::new();
                    let mut chunk = [0u8; 512];
                    loop {
                        if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                            break;
                        }
                        let Ok(n) = stream.read(&mut chunk) else { return };
                        if n == 0 {
                            return;
                        }
                        buf.extend_from_slice(&chunk[..n]);
                    }
                    let line = String::from_utf8_lossy(&buf);
                    let method = line.split_whitespace().next().unwrap_or("").to_string();
                    recorded.lock().unwrap().push(method.clone());
                    if method == "POST" {
                        let headers = format!(
                            "HTTP/1.1 {status} Stalled\r\nContent-Length: 200\r\nConnection: close\r\n\r\n"
                        );
                        let _ = stream.write_all(headers.as_bytes());
                        let _ = stream.flush();
                        // Hold the socket open past the client's assignment deadline so the body stalls.
                        let mut drain = [0u8; 16];
                        let _ = stream.read(&mut drain);
                    } else {
                        let _ = stream.write_all(&raw_reply(r#"{"token":"xsrf"}"#));
                        let _ = stream.flush();
                    }
                });
            }
        });
        (base, methods)
    };

    let (base_412, methods_412) = spawn_stalled(412);
    let (base_500, methods_500) = spawn_stalled(500);
    let client_412 = colab(&base_412, &sessions());
    let client_500 = colab(&base_500, &sessions());

    // Run both concurrently so the MIN_POST_BUDGET deadline expires in ~5.2s total.
    let (err_412, err_500) = block(async {
        let deadline = tokio::time::Instant::now() + RECONCILE_RESERVE + MIN_POST_BUDGET + Duration::from_millis(250);
        let (r412, r500) = tokio::join!(
            client_412.assign_until("T4", false, deadline),
            client_500.assign_until("T4", false, deadline),
        );
        (r412.unwrap_err(), r500.unwrap_err())
    });

    assert_eq!(
        err_412,
        "Google Colab refused the runtime: too many active Colab sessions, or a usage or capacity limit. Stop a runtime, wait and retry, or pick other hardware."
    );
    assert_eq!(err_500, "Google Colab returned HTTP 500.");
    assert_eq!(*methods_412.lock().unwrap(), vec!["GET", "POST"]);
    assert_eq!(*methods_500.lock().unwrap(), vec!["GET", "POST"]);
}

#[test]
fn retryable_fails_closed_on_tls_and_non_retryable_statuses() {
    let fail = |status, timed_out, transport, tls| Failure {
        status,
        timed_out,
        transport,
        tls,
        message: String::new(),
    };

    // TLS errors always fail closed, even on 502..=504 or pre-header drops.
    for status in [None, Some(200), Some(502), Some(503), Some(504)] {
        assert!(!retryable(&fail(status, false, true, true)));
        assert!(!retryable(&fail(status, true, false, true)));
    }

    // 3xx, 4xx, 500, 501, 505 never retry, even on body timeout or truncation.
    for status in [302, 400, 401, 403, 412, 500, 501, 505] {
        assert!(!retryable(&fail(Some(status), true, false, false)), "status {status} timed_out");
        assert!(!retryable(&fail(Some(status), false, true, false)), "status {status} transport");
    }

    // Pre-header drops/timeouts, truncated/timed-out 2xx bodies, and 502..=504 retry.
    assert!(retryable(&fail(None, true, false, false)));
    assert!(retryable(&fail(None, false, true, false)));
    assert!(!retryable(&fail(None, false, false, false)));
    assert!(retryable(&fail(Some(200), true, false, false)));
    assert!(retryable(&fail(Some(200), false, true, false)));
    assert!(!retryable(&fail(Some(200), false, false, false)));
    for status in [502, 503, 504] {
        assert!(retryable(&fail(Some(status), false, false, false)));
    }
}

#[test]
fn close_delimited_truncated_success_reconciles_without_replay() {
    reconciles_unusable_post(
        b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n)]}'\n{\"endpoint\":\"m-cut".to_vec(),
    );
}

#[test]
fn complete_success_without_runtime_reconciles_without_replay() {
    reconciles_unusable_post(raw_reply(")]}'\n{}"));
}

fn reconciles_unusable_post(post_reply: Vec<u8>) {
    let requests = AtomicUsize::new(0);
    let (base, seen) = mock::serve_raw(move |_, _| {
        match requests.fetch_add(1, Ordering::SeqCst) {
            0 => raw_reply(r#"{"token":"initial"}"#),
            1 => post_reply.clone(),
            _ => raw_reply(ASSIGNMENT),
        }
    });
    let machine = colab(&base, &sessions()).create_with("pc-train", "T4", false).unwrap();
    assert_eq!(machine.id, "colab:gpu-t4-s-new");
    let log = seen.lock().unwrap();
    assert_eq!(log.iter().map(|r| r.method.as_str()).collect::<Vec<_>>(), ["GET", "POST", "GET"]);
    assert!(log.iter().all(|r| r.path == log[0].path));
}

#[test]
fn colab_and_oauth_errors_only_report_allowlisted_identifiers() {
    for status in [400, 401, 403, 500] {
        for (body, code) in [
            (r#"{"message":"pin spaced secret","error":"key spaced secret","error_description":"pwd spaced secret"}"#, None),
            ("pin key pwd spaced secret", None),
            (r#"{"error":"invalid_grant","error_description":"pin spaced secret"}"#, Some("invalid_grant")),
            (r#"{"error":{"status":"RESOURCE_EXHAUSTED","message":"pin spaced secret"}}"#, Some("RESOURCE_EXHAUSTED")),
            (r#"{"error":{"status":"PERMISSION_DENIED","message":"pin spaced secret"}}"#, Some("PERMISSION_DENIED")),
        ] {
            let (base, _) = mock::serve(move |_, _| (status, format!(")]}}'\n{body}")));
            let client = colab(&base, &sessions());
            let oauth = Urls::mock(&base);
            let with_code = code.map_or_else(String::new, |code| format!(" ({code})"));
            let suffix = code.map_or_else(String::new, |code| format!(", {code}"));
            let expected = |service: &str| {
                if matches!(status, 401 | 403) {
                    format!("{service} refused the credentials (HTTP {status}{suffix}). Check them in Settings → Cloud.")
                } else {
                    format!("{service} returned HTTP {status}{with_code}.")
                }
            };
            block(async {
                assert_eq!(client.assignments().await.unwrap_err(), expected("Google Colab"));
                let oauth_error = token_request(&oauth, String::new()).await.unwrap_err();
                if code == Some("invalid_grant") {
                    assert_eq!(oauth_error, "Your Google sign-in expired or was revoked. Sign in to Google Colab again in Settings → Cloud.");
                } else {
                    assert_eq!(oauth_error, expected("Google"));
                }
            });
        }
    }
}

fn partial_reply(status: u16) -> Vec<u8> {
    format!("HTTP/1.1 {status} X\r\nContent-Length: 200\r\nConnection: close\r\n\r\npartial").into_bytes()
}

#[test]
fn https_assignment_tls_failure_stops_post_and_reconciliation() {
    for (failure_request, expected_methods) in [
        (1, &["GET", "POST"][..]),
        (2, &["GET", "POST", "GET"][..]),
    ] {
        let requests = AtomicUsize::new(0);
        let (base, seen) = mock::serve_https_mid_body_tls_alert(move |_, _| {
            match requests.fetch_add(1, Ordering::SeqCst) {
                0 => (raw_reply(r#"{"token":"initial"}"#), false),
                request if request == failure_request => (partial_reply(502), true),
                1 => (Vec::new(), false),
                _ => (raw_reply(ASSIGNMENT), false),
            }
        });
        let client = colab(&base, &sessions()).with_root_cert(mock::loopback_root_cert());
        assert_eq!(
            client.create_with("pc-train", "T4", false).err().unwrap(),
            "Google Colab request failed (TLS error).",
        );
        let log = seen.lock().unwrap();
        assert_eq!(log.iter().map(|r| r.method.as_str()).collect::<Vec<_>>(), expected_methods);
        assert!(log.iter().all(|r| r.path == log[0].path));
    }
}

#[test]
fn https_unassign_404_tls_failure_preserves_session() {
    let (base, seen) = mock::serve_https_mid_body_tls_alert(|_, _| (partial_reply(404), true));
    let sessions = sessions();
    let client = colab(&base, &sessions).with_root_cert(mock::loopback_root_cert());
    let endpoint = "gpu-t4-s-new";
    store::update(&sessions, |mut known| {
        known.insert(endpoint.into(), SessionRecord { endpoint: endpoint.into(), ..SessionRecord::default() });
        (known, ())
    }).unwrap();
    let before = std::fs::read(&sessions).unwrap();
    assert_eq!(client.unassign(endpoint).unwrap_err(), "Google Colab request failed (TLS error).");
    assert_eq!(std::fs::read(&sessions).unwrap(), before);
    let log = seen.lock().unwrap();
    assert_eq!(log.len(), 1);
    assert_eq!(log[0].method, "GET");
    assert_eq!(log[0].path.split('?').next(), Some("/tun/m/unassign/gpu-t4-s-new"));
}
