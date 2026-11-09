use super::{
    auth, browser, commands, console_lifecycle, consoles, dock, events::Replay, preferences,
    DispatchFailure, Gateway,
};
use axum::{
    body::{Body, Bytes},
    extract::{
        ws::{Message, WebSocket},
        Path, Query, State, WebSocketUpgrade,
    },
    http::{header, HeaderMap, HeaderValue, Request, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
    Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::io::AsyncWriteExt;

const WS_SEND_TIMEOUT: Duration = Duration::from_secs(5);
const WS_SESSION_RECHECK: Duration = Duration::from_secs(15);

pub async fn serve(
    gateway: Arc<Gateway>,
    listener: tokio::net::TcpListener,
) -> std::io::Result<()> {
    let router = Router::new()
        .route("/api/pandacode/health", get(health))
        .route("/api/pandacode/login-mode", get(login_mode))
        .route("/api/pandacode/session/details", get(session_details))
        .route(
            "/api/pandacode/session",
            get(session_status).post(login).delete(logout),
        )
        .route(
            "/api/pandacode/preferences",
            get(get_preferences).post(set_preferences),
        )
        .route("/api/pandacode/files/roots", get(file_roots))
        .route("/api/pandacode/files/list", get(file_list))
        .route("/api/pandacode/files/select", post(file_select))
        .route("/api/pandacode/files/locate", post(file_locate))
        .route("/api/pandacode/files/upload", post(file_upload))
        .route("/api/pandacode/files/document", get(file_document))
        .route("/api/pandacode/consoles/open", post(console_open))
        .route("/api/pandacode/consoles/frame", get(console_frame))
        .route("/api/pandacode/consoles/input", post(console_input))
        .route("/api/pandacode/consoles/lifecycle", post(console_lifecycle))
        .route("/api/pandacode/consoles/capture", get(console_capture))
        .route("/api/pandacode/consoles/{lease}", delete(console_close))
        .route("/api/pandacode/dock", post(dock_action))
        .route("/api/pandacode/browser/open", post(browser_open))
        .route("/api/pandacode/browser/{lease}/status", get(browser_status))
        .route("/api/pandacode/browser/{lease}/frame", get(browser_frame))
        .route(
            "/api/pandacode/browser/{lease}/action",
            post(browser_action),
        )
        .route("/api/pandacode/browser/{lease}/input", post(browser_input))
        .route(
            "/api/pandacode/browser/{lease}/inspect",
            post(browser_inspect),
        )
        .route("/api/pandacode/browser/{lease}/pick", post(browser_pick))
        .route("/api/pandacode/browser/{lease}", delete(browser_close))
        .route(
            "/api/pandacode/terminals/{terminal_id}/snapshot",
            get(terminal_snapshot),
        )
        .route("/api/pandacode/runtime-snapshot", get(runtime_snapshot))
        .route("/api/pandacode/events", get(events))
        .route("/api/pandacode/commands/{command}", post(command))
        .fallback(get(asset))
        .with_state(gateway)
        .layer(axum::extract::DefaultBodyLimit::max(
            commands::MAX_JSON_BYTES,
        ));
    axum::serve(listener, router).await
}

async fn health(State(gateway): State<Arc<Gateway>>) -> impl IntoResponse {
    Json(
        json!({ "ok": true, "enabled": gateway.enabled(), "ready": gateway.is_ready(), "version": env!("CARGO_PKG_VERSION") }),
    )
}

async fn login_mode(State(gateway): State<Arc<Gateway>>, headers: HeaderMap) -> Response {
    if let Err(response) = browser_request(&gateway, &headers, false) {
        return *response;
    }
    let mut response = Json(json!({
        "mode": if gateway.password_hash.is_some() { "password" } else { "pairing" }
    })).into_response();
    no_store(response.headers_mut());
    response
}

#[derive(Deserialize)]
struct Login {
    token: String,
}

async fn login(
    State(gateway): State<Arc<Gateway>>,
    headers: HeaderMap,
    Json(login): Json<Login>,
) -> Response {
    if let Err(response) = browser_request(&gateway, &headers, true) {
        return *response;
    }
    if login.token.len() > 128 {
        return error(StatusCode::BAD_REQUEST, "invalid_request", None);
    }
    let now = Instant::now();
    let authorized = {
        let mut guard = super::lock(&gateway.pairing);
        match gateway.password_hash.as_ref() {
            Some(hash) => guard.verify_password(hash, &login.token, now),
            None => guard.consume(&login.token, now).is_ok(),
        }
    };
    if !authorized {
        let reason = if gateway.password_hash.is_some() { "invalid_login" } else { "invalid_pairing" };
        return error(StatusCode::UNAUTHORIZED, reason, None);
    }
    let (session, csrf, max_age) = {
        let mut store = super::lock(&gateway.sessions);
        match store.create() {
            Ok((session, csrf)) => (session, csrf, store.cookie_max_age()),
            Err(_) => return error(StatusCode::INTERNAL_SERVER_ERROR, "internal", None),
        }
    };
    let mut response = (StatusCode::NO_CONTENT, Body::empty()).into_response();
    append_header(
        response.headers_mut(),
        header::SET_COOKIE,
        &format!(
            "{}={}; Path=/; Max-Age={max_age}; Secure; HttpOnly; SameSite=Strict",
            auth::SESSION_COOKIE,
            session.id
        ),
    );
    append_header(
        response.headers_mut(),
        header::SET_COOKIE,
        &format!(
            "{}={}; Path=/; Max-Age={max_age}; Secure; SameSite=Strict",
            auth::CSRF_COOKIE,
            csrf
        ),
    );
    no_store(response.headers_mut());
    response
}

async fn session_status(State(gateway): State<Arc<Gateway>>, headers: HeaderMap) -> Response {
    if host_ok(&gateway, &headers).is_err() {
        return error(StatusCode::MISDIRECTED_REQUEST, "invalid_host", None);
    }
    match authenticate(&gateway, &headers, false) {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(response) => *response,
    }
}

async fn session_details(State(gateway): State<Arc<Gateway>>, headers: HeaderMap) -> Response {
    if let Err(response) = browser_request(&gateway, &headers, false) {
        return *response;
    }
    let session = match authenticate(&gateway, &headers, false) {
        Ok(session) => session,
        Err(response) => return *response,
    };
    let mut response = Json(serde_json::json!({
        "remainingSeconds": session.remaining_seconds(Instant::now()),
        "id": session.management_id(),
    })).into_response();
    no_store(response.headers_mut());
    response
}

async fn logout(State(gateway): State<Arc<Gateway>>, headers: HeaderMap) -> Response {
    if let Err(response) = browser_request(&gateway, &headers, true) {
        return *response;
    }
    let session = match authenticate(&gateway, &headers, true) {
        Ok(session) => session,
        Err(response) => return *response,
    };
    if gateway.revoke_session(&session.id).is_err() {
        return error(StatusCode::INTERNAL_SERVER_ERROR, "logout_failed", None);
    }
    let mut response = StatusCode::NO_CONTENT.into_response();
    append_header(
        response.headers_mut(),
        header::SET_COOKIE,
        &format!(
            "{}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict",
            auth::SESSION_COOKIE
        ),
    );
    append_header(
        response.headers_mut(),
        header::SET_COOKIE,
        &format!(
            "{}=; Path=/; Max-Age=0; Secure; SameSite=Strict",
            auth::CSRF_COOKIE
        ),
    );
    response
}

async fn command(
    State(gateway): State<Arc<Gateway>>,
    Path(command): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Err(response) = browser_request(&gateway, &headers, true) {
        return *response;
    }
    let session = match authenticate(&gateway, &headers, true) {
        Ok(session) => session,
        Err(response) => return *response,
    };
    let Some(policy) = commands::policy(&command) else {
        return error(StatusCode::NOT_FOUND, "unknown_command", None);
    };
    if policy.exposure == commands::Exposure::Blocked {
        return error(
            StatusCode::NOT_IMPLEMENTED,
            "adapter_required",
            Some(policy.reason),
        );
    }
    let args = match serde_json::from_slice::<Value>(&body) {
        Ok(Value::Object(object)) => Value::Object(object),
        _ => return error(StatusCode::BAD_REQUEST, "invalid_arguments", None),
    };
    let request_id = header_text(&headers, "x-request-id");
    match gateway
        .dispatch(&session.id, policy, args, request_id)
        .await
    {
        Ok(result) => json_response(StatusCode::OK, result),
        Err(failure) => dispatch_error(failure),
    }
}

async fn terminal_snapshot(
    State(gateway): State<Arc<Gateway>>,
    Path(terminal_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if let Err(response) = browser_request(&gateway, &headers, false) {
        return *response;
    }
    let session = match authenticate(&gateway, &headers, false) {
        Ok(session) => session,
        Err(response) => return *response,
    };
    if terminal_id.is_empty() || terminal_id.len() > 128 {
        return error(StatusCode::BAD_REQUEST, "invalid_terminal", None);
    }
    let owners = super::lock(&gateway.terminals);
    if owners.check(&terminal_id, &session.id).is_err() {
        return error(StatusCode::FORBIDDEN, "terminal_forbidden", None);
    }
    let snapshot = super::lock(&gateway.terminal_journal).snapshot(&terminal_id);
    drop(owners);
    let mut response = Json(snapshot).into_response();
    no_store(response.headers_mut());
    response
}

async fn get_preferences(State(gateway): State<Arc<Gateway>>, headers: HeaderMap) -> Response {
    if host_ok(&gateway, &headers).is_err() {
        return error(StatusCode::MISDIRECTED_REQUEST, "invalid_host", None);
    }
    if let Err(response) = authenticate(&gateway, &headers, false) {
        return *response;
    }
    let snapshot = super::lock(&gateway.preferences).clone();
    json_response(
        StatusCode::OK,
        serde_json::to_value(snapshot).unwrap_or(Value::Null),
    )
}

async fn set_preferences(
    State(gateway): State<Arc<Gateway>>,
    headers: HeaderMap,
    Json(update): Json<preferences::Update>,
) -> Response {
    if let Err(response) = browser_request(&gateway, &headers, true) {
        return *response;
    }
    if let Err(response) = authenticate(&gateway, &headers, true) {
        return *response;
    }
    match gateway.request_preferences(update.preferences).await {
        Ok(snapshot) => json_response(
            StatusCode::OK,
            serde_json::to_value(snapshot).unwrap_or(Value::Null),
        ),
        Err(failure) => dispatch_error(failure),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeSnapshotQuery {
    session_id: Option<String>,
}

async fn runtime_snapshot(
    State(gateway): State<Arc<Gateway>>,
    headers: HeaderMap,
    Query(query): Query<RuntimeSnapshotQuery>,
) -> Response {
    if host_ok(&gateway, &headers).is_err() {
        return error(StatusCode::MISDIRECTED_REQUEST, "invalid_host", None);
    }
    if let Err(response) = authenticate(&gateway, &headers, false) {
        return *response;
    }
    if query
        .session_id
        .as_ref()
        .is_some_and(|id| id.is_empty() || id.len() > 256 || id.chars().any(char::is_control))
    {
        return error(StatusCode::BAD_REQUEST, "invalid_session", None);
    }
    let snapshot = gateway.events.runtime_snapshot(query.session_id.as_deref());
    json_response(
        StatusCode::OK,
        serde_json::to_value(snapshot).unwrap_or(Value::Null),
    )
}

async fn file_roots(State(gateway): State<Arc<Gateway>>, headers: HeaderMap) -> Response {
    if host_ok(&gateway, &headers).is_err() {
        return error(StatusCode::MISDIRECTED_REQUEST, "invalid_host", None);
    }
    if let Err(response) = authenticate(&gateway, &headers, false) {
        return *response;
    }
    let roots = super::lock(&gateway.files).roots();
    json_response(
        StatusCode::OK,
        serde_json::to_value(roots).unwrap_or(Value::Null),
    )
}

#[derive(Deserialize)]
struct FileListQuery {
    root: String,
    #[serde(default)]
    path: String,
    cursor: Option<String>,
}

async fn file_list(
    State(gateway): State<Arc<Gateway>>,
    headers: HeaderMap,
    Query(query): Query<FileListQuery>,
) -> Response {
    if host_ok(&gateway, &headers).is_err() {
        return error(StatusCode::MISDIRECTED_REQUEST, "invalid_host", None);
    }
    if let Err(response) = authenticate(&gateway, &headers, false) {
        return *response;
    }
    let request =
        super::lock(&gateway.files).prepare_list(&query.root, &query.path, query.cursor.as_deref());
    let result = match request {
        Ok(request) => {
            let Ok(_permit) = gateway.file_admission.clone().try_acquire_owned() else {
                return error(StatusCode::TOO_MANY_REQUESTS, "file_gateway_busy", None);
            };
            tokio::task::spawn_blocking(move || request.run())
                .await
                .unwrap_or(Err("folder unavailable"))
        }
        Err(error) => Err(error),
    };
    match result {
        Ok(listing) => json_response(
            StatusCode::OK,
            serde_json::to_value(listing).unwrap_or(Value::Null),
        ),
        Err(message) => error(StatusCode::BAD_REQUEST, "invalid_file_path", Some(message)),
    }
}

#[derive(Deserialize)]
struct FileSelection {
    root: String,
    #[serde(default)]
    path: String,
    kind: super::files::Kind,
    purpose: super::files::Purpose,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FileLocate {
    path: String,
}

async fn file_locate(
    State(gateway): State<Arc<Gateway>>,
    headers: HeaderMap,
    Json(request): Json<FileLocate>,
) -> Response {
    if let Err(response) = browser_request(&gateway, &headers, true) {
        return *response;
    }
    if let Err(response) = authenticate(&gateway, &headers, true) {
        return *response;
    }
    let request = super::lock(&gateway.files).prepare_locate(&request.path);
    let located = match request {
        Ok(request) => {
            let Ok(_permit) = gateway.file_admission.clone().try_acquire_owned() else {
                return error(StatusCode::TOO_MANY_REQUESTS, "file_gateway_busy", None);
            };
            tokio::task::spawn_blocking(move || request.run())
                .await
                .unwrap_or(Err("path unavailable"))
        }
        Err(error) => Err(error),
    };
    match located {
        Ok(located) => json_response(
            StatusCode::OK,
            serde_json::to_value(located).unwrap_or(Value::Null),
        ),
        Err(_) => error(StatusCode::BAD_REQUEST, "invalid_file_path", None),
    }
}

async fn file_select(
    State(gateway): State<Arc<Gateway>>,
    headers: HeaderMap,
    Json(selection): Json<FileSelection>,
) -> Response {
    if let Err(response) = browser_request(&gateway, &headers, true) {
        return *response;
    }
    let session = match authenticate(&gateway, &headers, true) {
        Ok(session) => session,
        Err(response) => return *response,
    };
    let request = super::lock(&gateway.files).prepare_select(
        &selection.root,
        &selection.path,
        selection.kind,
        selection.purpose,
    );
    let selected = match request {
        Ok(request) => {
            let Ok(_permit) = gateway.file_admission.clone().try_acquire_owned() else {
                return error(StatusCode::TOO_MANY_REQUESTS, "file_gateway_busy", None);
            };
            tokio::task::spawn_blocking(move || request.run())
                .await
                .unwrap_or(Err("path unavailable"))
                .and_then(|selected| {
                    super::lock(&gateway.files).issue_selected(&session.id, selected)
                })
        }
        Err(error) => Err(error),
    };
    match selected {
        Ok(grant) => json_response(
            StatusCode::OK,
            serde_json::to_value(grant).unwrap_or(Value::Null),
        ),
        Err(message) => error(StatusCode::BAD_REQUEST, "invalid_file_path", Some(message)),
    }
}

async fn file_upload(
    State(gateway): State<Arc<Gateway>>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    if let Err(response) = browser_request(&gateway, &headers, true) {
        return *response;
    }
    let session = match authenticate(&gateway, &headers, true) {
        Ok(session) => session,
        Err(response) => return *response,
    };
    let purpose = match header_text(&headers, "x-file-purpose") {
        Some("attachment") => super::files::Purpose::Attachment,
        Some("theme") => super::files::Purpose::Theme,
        _ => return error(StatusCode::BAD_REQUEST, "invalid_upload_purpose", None),
    };
    let name = match header_text(&headers, "x-file-name")
        .and_then(|value| super::files::decode_filename(value).ok())
    {
        Some(name) => name,
        None => return error(StatusCode::BAD_REQUEST, "invalid_upload_name", None),
    };
    let declared = match header_text(&headers, header::CONTENT_LENGTH.as_str())
        .and_then(|value| value.parse::<u64>().ok())
    {
        Some(bytes) if bytes > 0 && bytes <= super::files::MAX_UPLOAD_BYTES => bytes,
        _ => return error(StatusCode::PAYLOAD_TOO_LARGE, "upload_size_required", None),
    };
    if let Err(message) = super::lock(&gateway.files).reserve_upload(&session.id, declared) {
        return error(StatusCode::PAYLOAD_TOO_LARGE, "upload_quota", Some(message));
    }
    let cache = super::lock(&gateway.files).upload_cache();
    let upload_name = name.clone();
    let Ok(_permit) = gateway.file_admission.clone().try_acquire_owned() else {
        super::lock(&gateway.files).cancel_upload(&session.id, declared);
        return error(StatusCode::TOO_MANY_REQUESTS, "file_gateway_busy", None);
    };
    let created = tokio::task::spawn_blocking(move || {
        super::files::FileAccess::create_upload(&cache, &upload_name)
    })
    .await
    .unwrap_or(Err("upload cache unavailable"));
    let (path, file) = match created {
        Ok(created) => created,
        Err(message) => {
            super::lock(&gateway.files).cancel_upload(&session.id, declared);
            return error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "upload_unavailable",
                Some(message),
            );
        }
    };
    let mut file = tokio::fs::File::from_std(file);
    let mut stream = body.into_data_stream();
    let mut received = 0u64;
    let mut failed = None;
    while let Some(chunk) = stream.next().await {
        match chunk {
            Ok(chunk) => {
                received = received.saturating_add(chunk.len() as u64);
                if received > declared || file.write_all(&chunk).await.is_err() {
                    failed = Some("upload length or write failed");
                    break;
                }
            }
            Err(_) => {
                failed = Some("upload stream failed");
                break;
            }
        }
    }
    if received != declared || file.sync_all().await.is_err() {
        failed.get_or_insert("upload length or sync failed");
    }
    drop(file);
    if let Some(message) = failed {
        let _ = tokio::fs::remove_file(&path).await;
        super::lock(&gateway.files).cancel_upload(&session.id, declared);
        return error(StatusCode::BAD_REQUEST, "upload_failed", Some(message));
    }
    let grant = super::lock(&gateway.files).finish_upload(
        &session.id,
        path.clone(),
        &name,
        declared,
        purpose,
    );
    match grant {
        Ok(grant) => json_response(
            StatusCode::CREATED,
            serde_json::to_value(grant).unwrap_or(Value::Null),
        ),
        Err(message) => {
            let _ = tokio::fs::remove_file(path).await;
            super::lock(&gateway.files).cancel_upload(&session.id, declared);
            error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "upload_unavailable",
                Some(message),
            )
        }
    }
}

async fn file_document(
    State(gateway): State<Arc<Gateway>>,
    headers: HeaderMap,
    Query(request): Query<super::documents::DocumentRequest>,
) -> Response {
    if host_ok(&gateway, &headers).is_err() {
        return error(StatusCode::MISDIRECTED_REQUEST, "invalid_host", None);
    }
    if let Err(response) = authenticate(&gateway, &headers, false) {
        return *response;
    }
    if request.validate().is_err() {
        return error(StatusCode::BAD_REQUEST, "invalid_document_request", None);
    }
    let Ok(_permit) = gateway.file_admission.clone().try_acquire_owned() else {
        return error(StatusCode::TOO_MANY_REQUESTS, "file_gateway_busy", None);
    };
    let bytes = match gateway.read_document(request).await {
        Ok(bytes) => bytes,
        Err(failure) => return dispatch_error(failure),
    };
    let length = bytes.len();
    let mut response = Response::new(Body::from(bytes));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    response.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_static("attachment"),
    );
    response.headers_mut().insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("sandbox; default-src 'none'"),
    );
    if let Ok(length) = HeaderValue::from_str(&length.to_string()) {
        response
            .headers_mut()
            .insert(header::CONTENT_LENGTH, length);
    }
    no_store(response.headers_mut());
    security_headers(response.headers_mut());
    response
}

async fn console_open(
    State(gateway): State<Arc<Gateway>>,
    headers: HeaderMap,
    Json(request): Json<consoles::OpenRequest>,
) -> Response {
    if let Err(response) = browser_request(&gateway, &headers, true) {
        return *response;
    }
    let session = match authenticate(&gateway, &headers, true) {
        Ok(session) => session,
        Err(response) => return *response,
    };
    let Some(request_id) = header_text(&headers, "x-request-id") else {
        return dispatch_error(DispatchFailure::BadRequest("x-request-id required"));
    };
    match gateway.open_console(&session.id, request, request_id).await {
        Ok(value) => json_response(StatusCode::CREATED, value),
        Err(failure) => dispatch_error(failure),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ConsoleFrameQuery {
    lease: String,
    #[serde(default)]
    after: u64,
}

async fn console_frame(
    State(gateway): State<Arc<Gateway>>,
    headers: HeaderMap,
    Query(query): Query<ConsoleFrameQuery>,
) -> Response {
    if let Err(response) = browser_request(&gateway, &headers, false) {
        return *response;
    }
    let session = match authenticate(&gateway, &headers, false) {
        Ok(session) => session,
        Err(response) => return *response,
    };
    match gateway
        .console_frame(&session.id, &query.lease, query.after)
        .await
    {
        Ok((frame, expires_at)) => {
            let mut response = Response::new(Body::from(frame.bytes));
            response.headers_mut().insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static(frame.content_type),
            );
            if let Ok(value) = HeaderValue::from_str(&expires_at.to_string()) {
                response.headers_mut().insert("x-console-expires-at", value);
            }
            no_store(response.headers_mut());
            security_headers(response.headers_mut());
            response
        }
        Err(failure) => dispatch_error(failure),
    }
}

async fn console_input(
    State(gateway): State<Arc<Gateway>>,
    headers: HeaderMap,
    Json(request): Json<consoles::InputRequest>,
) -> Response {
    if let Err(response) = browser_request(&gateway, &headers, true) {
        return *response;
    }
    let session = match authenticate(&gateway, &headers, true) {
        Ok(session) => session,
        Err(response) => return *response,
    };
    let Some(request_id) = header_text(&headers, "x-request-id") else {
        return dispatch_error(DispatchFailure::BadRequest("x-request-id required"));
    };
    match gateway
        .console_input(&session.id, request, request_id)
        .await
    {
        Ok(value) => json_response(StatusCode::OK, value),
        Err(failure) => dispatch_error(failure),
    }
}

async fn console_close(
    State(gateway): State<Arc<Gateway>>,
    headers: HeaderMap,
    Path(lease): Path<String>,
) -> Response {
    if let Err(response) = browser_request(&gateway, &headers, true) {
        return *response;
    }
    let session = match authenticate(&gateway, &headers, true) {
        Ok(session) => session,
        Err(response) => return *response,
    };
    let Some(request_id) = header_text(&headers, "x-request-id") else {
        return dispatch_error(DispatchFailure::BadRequest("x-request-id required"));
    };
    match gateway.close_console(&session.id, &lease, request_id) {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(failure) => dispatch_error(failure),
    }
}

async fn console_lifecycle(
    State(gateway): State<Arc<Gateway>>,
    headers: HeaderMap,
    Json(request): Json<console_lifecycle::Request>,
) -> Response {
    if let Err(response) = browser_request(&gateway, &headers, true) {
        return *response;
    }
    let session = match authenticate(&gateway, &headers, true) {
        Ok(session) => session,
        Err(response) => return *response,
    };
    let Some(request_id) = header_text(&headers, "x-request-id") else {
        return dispatch_error(DispatchFailure::BadRequest("x-request-id required"));
    };
    match gateway
        .console_lifecycle(&session.id, request, request_id)
        .await
    {
        Ok(value) => json_response(StatusCode::OK, value),
        Err(failure) => dispatch_error(failure),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ConsoleCaptureQuery {
    lease: String,
}

async fn console_capture(
    State(gateway): State<Arc<Gateway>>,
    headers: HeaderMap,
    Query(query): Query<ConsoleCaptureQuery>,
) -> Response {
    if let Err(response) = browser_request(&gateway, &headers, false) {
        return *response;
    }
    let session = match authenticate(&gateway, &headers, false) {
        Ok(session) => session,
        Err(response) => return *response,
    };
    match gateway.console_capture(&session.id, &query.lease).await {
        Ok(bytes) => {
            let mut response = Response::new(Body::from(bytes));
            response
                .headers_mut()
                .insert(header::CONTENT_TYPE, HeaderValue::from_static("image/png"));
            no_store(response.headers_mut());
            security_headers(response.headers_mut());
            response
        }
        Err(failure) => dispatch_error(failure),
    }
}

async fn dock_action(
    State(gateway): State<Arc<Gateway>>,
    headers: HeaderMap,
    Json(request): Json<dock::Request>,
) -> Response {
    if let Err(response) = browser_request(&gateway, &headers, true) {
        return *response;
    }
    let session = match authenticate(&gateway, &headers, true) {
        Ok(session) => session,
        Err(response) => return *response,
    };
    let Some(request_id) = header_text(&headers, "x-request-id") else {
        return dispatch_error(DispatchFailure::BadRequest("x-request-id required"));
    };
    match gateway.dock_action(&session.id, request, request_id).await {
        Ok(value) => json_response(StatusCode::OK, value),
        Err(failure) => dispatch_error(failure),
    }
}

fn browser_mutation(
    gateway: &Gateway,
    headers: &HeaderMap,
) -> Result<(auth::Session, String), Box<Response>> {
    browser_request(gateway, headers, true)?;
    let session = authenticate(gateway, headers, true)?;
    let id = header_text(headers, "x-request-id")
        .ok_or_else(|| {
            Box::new(dispatch_error(DispatchFailure::BadRequest(
                "x-request-id required",
            )))
        })?
        .to_owned();
    Ok((session, id))
}
async fn browser_open(
    State(gateway): State<Arc<Gateway>>,
    headers: HeaderMap,
    Json(request): Json<browser::OpenRequest>,
) -> Response {
    let (session, id) = match browser_mutation(&gateway, &headers) {
        Ok(v) => v,
        Err(v) => return *v,
    };
    match gateway.open_browser(&session.id, request, &id).await {
        Ok(v) => json_response(StatusCode::CREATED, v),
        Err(e) => dispatch_error(e),
    }
}
async fn browser_status(
    State(gateway): State<Arc<Gateway>>,
    headers: HeaderMap,
    Path(lease): Path<String>,
) -> Response {
    if let Err(v) = browser_request(&gateway, &headers, false) {
        return *v;
    }
    let session = match authenticate(&gateway, &headers, false) {
        Ok(v) => v,
        Err(v) => return *v,
    };
    match gateway.browser_status(&session.id, &lease).await {
        Ok((status, expires)) => {
            let mut v = serde_json::to_value(status).unwrap_or(Value::Null);
            if let Some(o) = v.as_object_mut() {
                o.insert("expiresAt".into(), expires.into());
            }
            json_response(StatusCode::OK, v)
        }
        Err(e) => dispatch_error(e),
    }
}
async fn browser_frame(
    State(gateway): State<Arc<Gateway>>,
    headers: HeaderMap,
    Path(lease): Path<String>,
) -> Response {
    if let Err(v) = browser_request(&gateway, &headers, false) {
        return *v;
    }
    let session = match authenticate(&gateway, &headers, false) {
        Ok(v) => v,
        Err(v) => return *v,
    };
    match gateway.browser_frame(&session.id, &lease).await {
        Ok((frame, expires)) => {
            let mut r = Response::new(Body::from(frame.bytes));
            r.headers_mut()
                .insert(header::CONTENT_TYPE, HeaderValue::from_static("image/png"));
            for (name, value) in [
                ("x-browser-width", frame.width as u64),
                ("x-browser-height", frame.height as u64),
                ("x-browser-sequence", frame.sequence),
                ("x-browser-expires-at", expires),
            ] {
                if let Ok(v) = HeaderValue::from_str(&value.to_string()) {
                    r.headers_mut()
                        .insert(header::HeaderName::from_static(name), v);
                }
            }
            no_store(r.headers_mut());
            security_headers(r.headers_mut());
            r
        }
        Err(e) => dispatch_error(e),
    }
}
async fn browser_op(
    gateway: Arc<Gateway>,
    headers: HeaderMap,
    lease: String,
    operation: &'static str,
    payload: Value,
) -> Response {
    let (session, id) = match browser_mutation(&gateway, &headers) {
        Ok(v) => v,
        Err(v) => return *v,
    };
    match gateway
        .browser_operation(&session.id, &lease, operation, payload, &id)
        .await
    {
        Ok(v) => json_response(StatusCode::OK, v),
        Err(e) => dispatch_error(e),
    }
}
async fn browser_action(
    State(gateway): State<Arc<Gateway>>,
    headers: HeaderMap,
    Path(lease): Path<String>,
    Json(v): Json<Value>,
) -> Response {
    browser_op(gateway, headers, lease, "web_browser_action", v).await
}
async fn browser_input(
    State(gateway): State<Arc<Gateway>>,
    headers: HeaderMap,
    Path(lease): Path<String>,
    Json(v): Json<Value>,
) -> Response {
    browser_op(gateway, headers, lease, "web_browser_input", v).await
}
async fn browser_inspect(
    State(gateway): State<Arc<Gateway>>,
    headers: HeaderMap,
    Path(lease): Path<String>,
    Json(v): Json<Value>,
) -> Response {
    browser_op(gateway, headers, lease, "web_browser_inspect", v).await
}
async fn browser_pick(
    State(gateway): State<Arc<Gateway>>,
    headers: HeaderMap,
    Path(lease): Path<String>,
    Json(v): Json<Value>,
) -> Response {
    browser_op(gateway, headers, lease, "web_browser_pick", v).await
}
async fn browser_close(
    State(gateway): State<Arc<Gateway>>,
    headers: HeaderMap,
    Path(lease): Path<String>,
) -> Response {
    let (session, id) = match browser_mutation(&gateway, &headers) {
        Ok(v) => v,
        Err(v) => return *v,
    };
    match gateway.close_browser(&session.id, &lease, &id).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => dispatch_error(e),
    }
}

async fn events(
    State(gateway): State<Arc<Gateway>>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    if let Err(response) = browser_request(&gateway, &headers, true) {
        return *response;
    }
    let session = match authenticate(&gateway, &headers, false) {
        Ok(session) => session,
        Err(response) => return *response,
    };
    ws.max_message_size(commands::MAX_JSON_BYTES)
        .max_frame_size(commands::MAX_JSON_BYTES)
        .on_upgrade(move |socket| event_socket(gateway, session.id, socket))
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum ClientEvent {
    Resume { sequence: u64 },
    Resync { from: u64 },
}

async fn event_socket(gateway: Arc<Gateway>, session_id: String, socket: WebSocket) {
    struct SocketLease {
        gateway: Arc<Gateway>,
        session: Option<String>,
    }
    impl Drop for SocketLease {
        fn drop(&mut self) {
            if let Some(session) = self.session.take() {
                self.gateway.socket_closed(session);
            }
        }
    }
    gateway.socket_open(&session_id);
    let _lease = SocketLease {
        gateway: gateway.clone(),
        session: Some(session_id.clone()),
    };
    let (mut writer, mut reader) = socket.split();
    let mut receiver = gateway.events.subscribe();
    let mut revocations = gateway.session_revocations();
    let mut session_tick = tokio::time::interval(WS_SESSION_RECHECK);
    session_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let first = tokio::time::timeout(Duration::from_secs(5), reader.next()).await;
    let sequence = match first {
        Ok(Some(Ok(Message::Text(text)))) => match serde_json::from_str::<ClientEvent>(&text) {
            Ok(ClientEvent::Resume { sequence }) => sequence,
            Ok(ClientEvent::Resync { from }) => from,
            Err(_) => return,
        },
        _ => return,
    };
    if super::lock(&gateway.sessions).authenticate(&session_id, Instant::now()).is_err() {
        return;
    }
    let mut sent = match send_replay(&gateway, &session_id, &mut writer, sequence).await {
        Ok(sequence) => sequence,
        Err(()) => return,
    };
    loop {
        tokio::select! {
            incoming = reader.next() => match incoming {
                Some(Ok(Message::Text(text))) => if let Ok(ClientEvent::Resync { from }) = serde_json::from_str::<ClientEvent>(&text) {
                    match send_replay(&gateway, &session_id, &mut writer, from).await {
                        Ok(sequence) => sent = sequence,
                        Err(()) => break,
                    }
                },
                Some(Ok(Message::Ping(payload))) => if send_message(&mut writer, Message::Pong(payload)).await.is_err() { break; },
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                _ => {},
            },
            event = receiver.recv() => match event {
                Ok(event) if event.sequence > sent => {
                    sent = event.sequence;
                    if event_visible(&gateway, &session_id, &event) {
                        if send_json(&mut writer, &event).await.is_err() { break; }
                    } else if send_cursor(&mut writer, event.sequence).await.is_err() { break; }
                }
                Ok(_) => {},
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    let latest = gateway.events.latest();
                    if send_json(&mut writer, &json!({ "type": "resync", "sequence": latest, "payload": { "sequence": latest } })).await.is_err() { break; }
                    sent = latest;
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            },
            revoked = revocations.recv() => match revoked {
                Ok(revoked) if revoked == session_id => break,
                Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {},
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            },
            _ = session_tick.tick() => {
                if super::lock(&gateway.sessions).authenticate(&session_id, Instant::now()).is_err() {
                    let _ = gateway.revoke_session(&session_id);
                    break;
                }
            },
        }
    }
}

async fn send_replay(
    gateway: &Arc<Gateway>,
    session_id: &str,
    writer: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    after: u64,
) -> Result<u64, ()> {
    match gateway.events.replay_after(after) {
        Replay::Events(events) => {
            let mut sent = after;
            for event in events {
                sent = event.sequence;
                if event_visible(gateway, session_id, &event) {
                    send_json(writer, &event).await?;
                } else {
                    send_cursor(writer, event.sequence).await?;
                }
            }
            Ok(sent)
        }
        Replay::Resync { latest } => {
            send_json(
                writer,
                &json!({ "type": "resync", "sequence": latest, "payload": { "sequence": latest } }),
            )
            .await?;
            Ok(latest)
        }
    }
}

async fn send_cursor(
    writer: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    sequence: u64,
) -> Result<(), ()> {
    send_json(
        writer,
        &json!({ "type": "web-gateway-cursor", "sequence": sequence, "payload": null }),
    )
    .await
}

fn event_visible(
    gateway: &Gateway,
    session_id: &str,
    event: &crate::web_gateway::events::Event,
) -> bool {
    if event.event_type != "terminal-event" {
        return true;
    }
    event
        .payload
        .get("terminalId")
        .and_then(Value::as_str)
        .is_some_and(|terminal_id| {
            super::lock(&gateway.terminals)
                .check(terminal_id, session_id)
                .is_ok()
        })
}

async fn send_json(
    writer: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    value: &impl Serialize,
) -> Result<(), ()> {
    let text = serde_json::to_string(value).map_err(|_| ())?;
    send_message(writer, Message::Text(text.into())).await
}

async fn send_message(
    writer: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    message: Message,
) -> Result<(), ()> {
    tokio::time::timeout(WS_SEND_TIMEOUT, writer.send(message))
        .await
        .map_err(|_| ())?
        .map_err(|_| ())
}

async fn asset(
    State(gateway): State<Arc<Gateway>>,
    headers: HeaderMap,
    request: Request<Body>,
) -> Response {
    if host_ok(&gateway, &headers).is_err() {
        return error(StatusCode::MISDIRECTED_REQUEST, "invalid_host", None);
    }
    let path = request.uri().path().trim_start_matches('/');
    if path.starts_with("api/") {
        return error(StatusCode::NOT_FOUND, "not_found", None);
    }
    let requested = if path.is_empty() { "index.html" } else { path };
    let Some(mut asset) = gateway
        .assets
        .as_ref()
        .and_then(|resolver| resolver.get(requested.to_owned()))
    else {
        return error(StatusCode::NOT_FOUND, "not_found", None);
    };
    let html = asset.mime_type.starts_with("text/html");
    if html {
        let text = String::from_utf8_lossy(&asset.bytes);
        asset.bytes = if text.contains("data-pandacode-web") {
            text.into_owned().into_bytes()
        } else {
            text.replacen("<html", "<html data-pandacode-web=\"true\"", 1)
                .into_bytes()
        };
    }
    let mut response = Response::new(Body::from(asset.bytes));
    if let Ok(content_type) = HeaderValue::from_str(&asset.mime_type) {
        response
            .headers_mut()
            .insert(header::CONTENT_TYPE, content_type);
    }
    if let Some(csp) = browser_csp(&gateway, asset.csp_header.as_deref())
        .and_then(|value| HeaderValue::from_str(&value).ok())
    {
        response
            .headers_mut()
            .insert(header::CONTENT_SECURITY_POLICY, csp);
    }
    security_headers(response.headers_mut());
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(if html {
            "no-store"
        } else {
            "public, max-age=31536000, immutable"
        }),
    );
    response
}

/// The asset resolver has already inserted any script nonces/hashes into the native CSP and HTML.
/// Preserve those dynamic values, while replacing native-only IPC/asset sources with the exact
/// browser transport boundary. The desktop webview continues to receive its original CSP.
fn browser_csp(gateway: &Gateway, native: Option<&str>) -> Option<String> {
    let native = native?;
    let url = tauri::Url::parse(&gateway.config.origin).ok()?;
    let websocket_scheme = if url.scheme() == "https" { "wss" } else { "ws" };
    let websocket = format!("{websocket_scheme}://{}", gateway.config.host);
    let mut directives = Vec::new();
    let mut has_connect = false;
    let mut has_images = false;
    let mut has_form_action = false;
    let mut has_frame_ancestors = false;
    for directive in native
        .split(';')
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let name = directive
            .split_ascii_whitespace()
            .next()
            .unwrap_or_default();
        match name {
            "connect-src" => {
                directives.push(format!("connect-src 'self' {websocket}"));
                has_connect = true;
            }
            "img-src" => {
                directives.push("img-src 'self' data:".to_owned());
                has_images = true;
            }
            "form-action" => {
                directives.push("form-action 'self'".to_owned());
                has_form_action = true;
            }
            "frame-ancestors" => {
                directives.push("frame-ancestors 'none'".to_owned());
                has_frame_ancestors = true;
            }
            _ => directives.push(directive.to_owned()),
        }
    }
    if !has_connect {
        directives.push(format!("connect-src 'self' {websocket}"));
    }
    if !has_images {
        directives.push("img-src 'self' data:".to_owned());
    }
    if !has_form_action {
        directives.push("form-action 'self'".to_owned());
    }
    if !has_frame_ancestors {
        directives.push("frame-ancestors 'none'".to_owned());
    }
    Some(directives.join("; "))
}

fn authenticate(
    gateway: &Gateway,
    headers: &HeaderMap,
    csrf: bool,
) -> Result<auth::Session, Box<Response>> {
    let cookie = header_text(headers, header::COOKIE.as_str())
        .and_then(|value| cookie(value, auth::SESSION_COOKIE))
        .ok_or_else(|| Box::new(error(StatusCode::UNAUTHORIZED, "unauthenticated", None)))?;
    let now = Instant::now();
    let session = {
        let mut store = super::lock(&gateway.sessions);
        let result = if csrf {
            let token = header_text(headers, "x-csrf-token")
                .ok_or_else(|| Box::new(error(StatusCode::FORBIDDEN, "invalid_csrf", None)))?;
            store.authenticate_csrf(cookie, token, now)
        } else {
            store.authenticate(cookie, now)
        };
        if let Ok(session) = &result {
            store.observe(session);
        }
        result
    };
    match session {
        Ok(session) => Ok(session),
        Err(reason) => {
            if reason == "expired session" {
                let _ = gateway.revoke_session(cookie);
            }
            Err(Box::new(if reason == "invalid csrf token" {
                error(StatusCode::FORBIDDEN, "invalid_csrf", None)
            } else {
                error(StatusCode::UNAUTHORIZED, "unauthenticated", None)
            }))
        }
    }
}

fn browser_request(
    gateway: &Gateway,
    headers: &HeaderMap,
    require_origin: bool,
) -> Result<(), Box<Response>> {
    host_ok(gateway, headers)
        .map_err(|_| Box::new(error(StatusCode::MISDIRECTED_REQUEST, "invalid_host", None)))?;
    if require_origin
        && header_text(headers, header::ORIGIN.as_str()) != Some(gateway.config.origin.as_str())
    {
        return Err(Box::new(error(
            StatusCode::FORBIDDEN,
            "invalid_origin",
            None,
        )));
    }
    Ok(())
}

fn host_ok(gateway: &Gateway, headers: &HeaderMap) -> Result<(), ()> {
    (header_text(headers, header::HOST.as_str()) == Some(gateway.config.host.as_str()))
        .then_some(())
        .ok_or(())
}

fn cookie<'a>(header: &'a str, name: &str) -> Option<&'a str> {
    header.split(';').map(str::trim).find_map(|part| {
        part.split_once('=')
            .filter(|(key, _)| *key == name)
            .map(|(_, value)| value)
    })
}

fn header_text<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name)?.to_str().ok()
}

fn dispatch_error(failure: DispatchFailure) -> Response {
    match failure {
        DispatchFailure::BadRequest(message) => {
            error(StatusCode::BAD_REQUEST, "invalid_request", Some(message))
        }
        DispatchFailure::Forbidden => error(StatusCode::FORBIDDEN, "forbidden", None),
        DispatchFailure::NotReady => error(
            StatusCode::SERVICE_UNAVAILABLE,
            "native_host_not_ready",
            None,
        ),
        DispatchFailure::Busy => error(StatusCode::TOO_MANY_REQUESTS, "gateway_busy", None),
        DispatchFailure::Blocked(message) => error(
            StatusCode::NOT_IMPLEMENTED,
            "adapter_required",
            Some(message),
        ),
        DispatchFailure::Conflict(message) => {
            error(StatusCode::CONFLICT, "request_conflict", Some(message))
        }
        DispatchFailure::Timeout => error(StatusCode::GATEWAY_TIMEOUT, "command_timeout", None),
        DispatchFailure::CommandFailed => {
            error(StatusCode::UNPROCESSABLE_ENTITY, "command_failed", None)
        }
        DispatchFailure::ResponseTooLarge => {
            error(StatusCode::PAYLOAD_TOO_LARGE, "response_too_large", None)
        }
        DispatchFailure::Internal => error(StatusCode::INTERNAL_SERVER_ERROR, "internal", None),
    }
}

fn json_response(status: StatusCode, value: Value) -> Response {
    let mut response = (status, Json(value)).into_response();
    no_store(response.headers_mut());
    security_headers(response.headers_mut());
    response
}

fn error(status: StatusCode, code: &str, message: Option<&str>) -> Response {
    json_response(status, json!({ "error": code, "message": message }))
}

fn append_header(headers: &mut HeaderMap, name: header::HeaderName, value: &str) {
    if let Ok(value) = HeaderValue::from_str(value) {
        headers.append(name, value);
    }
}

fn no_store(headers: &mut HeaderMap) {
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
}

fn security_headers(headers: &mut HeaderMap) {
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(
        header::HeaderName::from_static("x-frame-options"),
        HeaderValue::from_static("DENY"),
    );
    headers.insert(
        header::HeaderName::from_static("permissions-policy"),
        HeaderValue::from_static("camera=(), microphone=(), geolocation=()"),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::web_gateway::{commands::BrokerRequest, Config, NativeBroker};
    use std::{sync::Arc, time::Duration};
    use tokio::io::AsyncWriteExt;
    use tokio::sync::mpsc;
    use tokio_tungstenite::{connect_async, tungstenite::client::IntoClientRequest};

    struct FixtureBroker {
        commands: mpsc::UnboundedSender<BrokerRequest>,
        terminal_closes: mpsc::UnboundedSender<String>,
        document_root: Option<std::path::PathBuf>,
        browser_calls: mpsc::UnboundedSender<&'static str>,
        browser_delay: Arc<std::sync::Mutex<Duration>>,
        browser_lifecycle: Arc<tokio::sync::Mutex<()>>,
    }
    impl NativeBroker for FixtureBroker {
        fn command(&self, request: BrokerRequest) -> Result<(), ()> {
            self.commands.send(request).map_err(|_| ())
        }
        fn terminal_close(&self, terminal_id: &str) -> Result<(), ()> {
            self.terminal_closes
                .send(terminal_id.to_owned())
                .map_err(|_| ())
        }
        fn preferences(
            &self,
            _id: &str,
            _preferences: &preferences::PreferenceMap,
        ) -> Result<(), ()> {
            Ok(())
        }
        fn document(
            &self,
            request: super::super::documents::DocumentRequest,
        ) -> super::super::documents::ReadFuture {
            let root = self.document_root.clone();
            Box::pin(async move {
                let root = root.ok_or("fixture document root unavailable")?;
                super::super::documents::read_from_root(&root, &request)
            })
        }
        fn console_validate(
            &self,
            _kind: super::super::consoles::Kind,
            target: String,
        ) -> super::super::consoles::OperationFuture<()> {
            Box::pin(async move {
                if target == "fixture" || target == super::super::console_lifecycle::MANAGER {
                    Ok(())
                } else {
                    Err("unknown fixture console".into())
                }
            })
        }
        fn console_frame(
            &self,
            kind: super::super::consoles::Kind,
            _target: String,
            after: u64,
        ) -> super::super::consoles::OperationFuture<super::super::consoles::Frame> {
            Box::pin(async move {
                let mut bytes = Vec::new();
                let content_type = if kind == super::super::consoles::Kind::Simulator {
                    bytes.extend_from_slice(&(after + 1).to_le_bytes());
                    "application/octet-stream"
                } else {
                    "image/jpeg"
                };
                bytes.extend_from_slice(b"fixture-jpeg");
                Ok(super::super::consoles::Frame {
                    bytes,
                    content_type,
                })
            })
        }
        fn console_input(
            &self,
            _kind: super::super::consoles::Kind,
            _target: String,
            _input: Value,
        ) -> super::super::consoles::OperationFuture<String> {
            Box::pin(async { Ok("fixture input accepted".into()) })
        }
        fn console_lifecycle(
            &self,
            lease: super::super::consoles::Lease,
            action: super::super::console_lifecycle::Action,
        ) -> super::super::console_lifecycle::OperationFuture<Value> {
            Box::pin(async move {
                Ok(json!({
                    "kind": lease.kind,
                    "target": lease.target,
                    "action": action,
                }))
            })
        }
        fn console_capture(
            &self,
            _lease: super::super::consoles::Lease,
        ) -> super::super::console_lifecycle::OperationFuture<Vec<u8>> {
            Box::pin(async { Ok(b"\x89PNG\r\n\x1a\nfixture".to_vec()) })
        }
        fn dock(&self, action: super::super::dock::Action) -> super::super::dock::OperationFuture {
            Box::pin(async move {
                match action {
                    super::super::dock::Action::Save {
                        enabled,
                        keep_on_screen,
                    } => Ok(json!({
                        "enabled": enabled,
                        "keepOnScreen": keep_on_screen,
                        "pinned": false,
                    })),
                    super::super::dock::Action::Pin => {
                        Err("fixture native pin is unavailable".into())
                    }
                }
            })
        }
        fn browser(
            &self,
            request: super::super::browser::NativeRequest,
        ) -> super::super::browser::OperationFuture<super::super::browser::NativeResponse> {
            use super::super::browser::{NativeRequest, NativeResponse};
            let calls = self.browser_calls.clone();
            let delay = *self.browser_delay.lock().unwrap();
            let lifecycle = self.browser_lifecycle.clone();
            Box::pin(async move {
                let _guard = lifecycle.lock().await;
                let name = match &request {
                    NativeRequest::Open { .. } => "open",
                    NativeRequest::Close { .. } => "close",
                    _ => "operation",
                };
                let _ = calls.send(name);
                if matches!(request, NativeRequest::Open { .. }) && !delay.is_zero() {
                    tokio::time::sleep(delay).await;
                }
                let status = crate::browser::BrowserStatus {
                    url: "https://example.test/".into(),
                    title: "Fixture browser".into(),
                    loading: false,
                    can_go_back: true,
                    can_go_forward: false,
                    picking: false,
                };
                match request {
                    NativeRequest::Open { url, .. } if url == "https://example.test/" => {
                        Ok(NativeResponse::Status(status))
                    }
                    NativeRequest::Open { .. } => Err("fixture URL rejected".into()),
                    NativeRequest::Status { .. }
                    | NativeRequest::Action { .. }
                    | NativeRequest::Input { .. } => Ok(NativeResponse::Status(status)),
                    NativeRequest::Frame { .. } => {
                        Ok(NativeResponse::Frame(crate::browser::RemoteFrame {
                            bytes: b"fixture-png".to_vec(),
                            width: 1280,
                            height: 800,
                            sequence: 7,
                        }))
                    }
                    NativeRequest::Inspect { .. } => Ok(NativeResponse::Value(
                        serde_json::json!({"url":"https://example.test/","elements":[]}),
                    )),
                    NativeRequest::Pick { .. } => Ok(NativeResponse::Value(
                        serde_json::json!({"tag":"button","text":"Fixture"}),
                    )),
                    NativeRequest::Close { .. } => Ok(NativeResponse::Closed),
                }
            })
        }
    }

    struct Fixture {
        gateway: Arc<Gateway>,
        address: std::net::SocketAddr,
        commands: mpsc::UnboundedReceiver<BrokerRequest>,
        terminal_closes: mpsc::UnboundedReceiver<String>,
        task: tokio::task::JoinHandle<()>,
        temp: Option<std::path::PathBuf>,
        browser_calls: mpsc::UnboundedReceiver<&'static str>,
        browser_delay: Arc<std::sync::Mutex<Duration>>,
    }

    impl Fixture {
        async fn new(timeout: Duration) -> Self {
            Self::new_with_root(timeout, None).await
        }

        async fn new_with_root(timeout: Duration, root: Option<std::path::PathBuf>) -> Self {
            Self::new_with_root_and_timeouts(timeout, timeout, root).await
        }

        async fn new_with_root_and_timeouts(
            command_timeout: Duration,
            clone_timeout: Duration,
            root: Option<std::path::PathBuf>,
        ) -> Self {
            Self::new_with_auth(command_timeout, clone_timeout, root, None).await
        }

        async fn new_with_auth(
            command_timeout: Duration,
            clone_timeout: Duration,
            root: Option<std::path::PathBuf>,
            password_hash: Option<[u8; 32]>,
        ) -> Self {
            if rustls::crypto::CryptoProvider::get_default().is_none() {
                let _ = rustls::crypto::ring::default_provider().install_default();
            }
            let (sender, commands) = mpsc::unbounded_channel();
            let (terminal_close_sender, terminal_closes) = mpsc::unbounded_channel();
            let (browser_sender, browser_calls) = mpsc::unbounded_channel();
            let browser_delay = Arc::new(std::sync::Mutex::new(Duration::ZERO));
            let config = Config {
                enabled: true,
                port: 0,
                origin: "http://panda.test".into(),
                host: "panda.test".into(),
                root_specs: Vec::new(),
            };
            let mut gateway = Gateway::with_broker(
                config,
                Arc::new(FixtureBroker {
                    commands: sender,
                    terminal_closes: terminal_close_sender,
                    document_root: root.clone(),
                    browser_calls: browser_sender,
                    browser_delay: browser_delay.clone(),
                    browser_lifecycle: Arc::new(tokio::sync::Mutex::new(())),
                }),
                command_timeout,
                clone_timeout,
            );
            gateway.password_hash = password_hash;
            let gateway = Arc::new(gateway);
            let temp = root
                .as_ref()
                .and_then(|root| root.parent())
                .map(std::path::Path::to_path_buf);
            if let Some(root) = root {
                let cache = temp.as_ref().unwrap().join("cache");
                *super::super::lock(&gateway.files) = super::super::files::FileAccess::new(
                    &[format!("Fixture={}", root.display())],
                    std::iter::empty(),
                    cache,
                )
                .unwrap();
            }
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let serving = gateway.clone();
            let task = tokio::spawn(async move { serve(serving, listener).await.unwrap() });
            Self {
                gateway,
                address,
                commands,
                terminal_closes,
                task,
                temp,
                browser_calls,
                browser_delay,
            }
        }

        fn url(&self, path: &str) -> String {
            format!("http://{}{}", self.address, path)
        }

        fn pair_token(&self) -> String {
            super::super::lock(&self.gateway.pairing).issue().unwrap().0
        }

        async fn login(&self, token: &str) -> (String, String) {
            let response = reqwest::Client::new()
                .post(self.url("/api/pandacode/session"))
                .header("host", "panda.test")
                .header("origin", "http://panda.test")
                .json(&json!({ "token": token }))
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::NO_CONTENT);
            let mut session = None;
            let mut csrf = None;
            for header in response
                .headers()
                .get_all("set-cookie")
                .iter()
                .filter_map(|value| value.to_str().ok())
            {
                let pair = header.split(';').next().unwrap_or_default();
                if let Some(value) = pair.strip_prefix(&format!("{}=", auth::SESSION_COOKIE)) {
                    session = Some(value.to_owned());
                }
                if let Some(value) = pair.strip_prefix(&format!("{}=", auth::CSRF_COOKIE)) {
                    csrf = Some(value.to_owned());
                }
            }
            (session.unwrap(), csrf.unwrap())
        }
    }

    #[tokio::test]
    async fn instance_password_creates_independent_sessions_and_disables_pairing() {
        let password = auth::random_token().unwrap();
        let fixture = Fixture::new_with_auth(
            Duration::from_secs(2), Duration::from_secs(2), None,
            Some(auth::password_hash(&password).unwrap()),
        ).await;
        let client = reqwest::Client::new();
        let mode = client.get(fixture.url("/api/pandacode/login-mode"))
            .header("host", "panda.test").send().await.unwrap();
        assert_eq!(mode.json::<serde_json::Value>().await.unwrap(), json!({"mode":"password"}));
        let response = client.post(fixture.url("/api/pandacode/session"))
            .header("host", "panda.test").header("origin", "http://panda.test")
            .json(&json!({"token": fixture.pair_token()})).send().await.unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let (first, csrf) = fixture.login(&password).await;
        let (second, _) = fixture.login(&password).await;
        assert_ne!(first, second);
        let details = fixture.url("/api/pandacode/session/details");
        let response = client.get(&details).header("host", "panda.test").send().await.unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let response = client.get(&details).header("host", "panda.test")
            .header("cookie", format!("{}={second}", auth::SESSION_COOKIE))
            .send().await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(response.headers()["cache-control"].to_str().unwrap().contains("no-store"));
        let summary = response.json::<serde_json::Value>().await.unwrap();
        let id = summary["id"].as_str().unwrap();
        assert_ne!(id, second);
        assert!(summary["remainingSeconds"].as_u64().unwrap() <= auth::SESSION_TTL.as_secs());
        let response = client.delete(fixture.url("/api/pandacode/session"))
            .header("host", "panda.test").header("origin", "http://panda.test")
            .header("cookie", format!("{}={first}", auth::SESSION_COOKIE))
            .header("x-csrf-token", csrf).send().await.unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        for (session, status) in [(first, StatusCode::UNAUTHORIZED), (second, StatusCode::NO_CONTENT)] {
            let response = client.get(fixture.url("/api/pandacode/session"))
                .header("host", "panda.test")
                .header("cookie", format!("{}={session}", auth::SESSION_COOKIE))
                .send().await.unwrap();
            assert_eq!(response.status(), status);
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            self.task.abort();
            if let Some(temp) = &self.temp {
                let _ = std::fs::remove_dir_all(temp);
            }
        }
    }

    #[test]
    fn cookies_are_parsed_by_exact_name() {
        assert_eq!(
            cookie(
                "one=1; __Host-pandacode_session=abc; two=2",
                auth::SESSION_COOKIE
            ),
            Some("abc")
        );
        assert_eq!(
            cookie("not__Host-pandacode_session=abc", auth::SESSION_COOKIE),
            None
        );
    }

    #[tokio::test]
    async fn tcp_enforces_origin_session_csrf_dispatch_and_deduplication() {
        let mut fixture = Fixture::new(Duration::from_secs(2)).await;
        let token = fixture.pair_token();
        let rejected = reqwest::Client::new()
            .post(fixture.url("/api/pandacode/session"))
            .header("host", "panda.test")
            .header("origin", "https://foreign.test")
            .json(&json!({ "token": token }))
            .send()
            .await
            .unwrap();
        assert_eq!(rejected.status(), StatusCode::FORBIDDEN);
        let (session, csrf) = fixture.login(&token).await;
        let cookie = format!(
            "{}={}; {}={}",
            auth::SESSION_COOKIE,
            session,
            auth::CSRF_COOKIE,
            csrf
        );
        let rejected = reqwest::Client::new()
            .post(fixture.url("/api/pandacode/commands/list_projects"))
            .header("host", "panda.test")
            .header("origin", "http://panda.test")
            .header("cookie", &cookie)
            .json(&json!({}))
            .send()
            .await
            .unwrap();
        assert_eq!(rejected.status(), StatusCode::FORBIDDEN);

        let client = reqwest::Client::new();
        let url = fixture.url("/api/pandacode/commands/list_projects");
        let request = client
            .post(&url)
            .header("host", "panda.test")
            .header("origin", "http://panda.test")
            .header("cookie", &cookie)
            .header("x-csrf-token", &csrf)
            .header("x-request-id", "same-request")
            .json(&json!({}));
        let competing = request.try_clone().unwrap();
        let sending = tokio::spawn(async move { request.send().await.unwrap() });
        let competing = tokio::spawn(async move { competing.send().await.unwrap() });
        let broker_request = fixture.commands.recv().await.unwrap();
        assert_eq!(broker_request.command, "list_projects");
        tokio::time::sleep(Duration::from_millis(20)).await;
        fixture
            .gateway
            .resolve(&broker_request.id, Some(json!([{ "id": "p" }])), None);
        let first = sending.await.unwrap();
        let second = competing.await.unwrap();
        let mut statuses = [first.status(), second.status()];
        statuses.sort();
        assert_eq!(statuses, [StatusCode::OK, StatusCode::CONFLICT]);

        let response = client
            .post(url)
            .header("host", "panda.test")
            .header("origin", "http://panda.test")
            .header("cookie", &cookie)
            .header("x-csrf-token", &csrf)
            .header("x-request-id", "same-request")
            .json(&json!({}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(
            tokio::time::timeout(Duration::from_millis(100), fixture.commands.recv())
                .await
                .is_err(),
            "deduplicated request must not reach native broker twice"
        );
    }

    #[tokio::test]
    async fn duplicate_request_id_with_different_body_is_rejected_without_reexecution() {
        let mut fixture = Fixture::new(Duration::from_secs(2)).await;
        let token = fixture.pair_token();
        let (session, csrf) = fixture.login(&token).await;
        let cookie = format!("{}={}", auth::SESSION_COOKIE, session);
        let client = reqwest::Client::new();
        let url = fixture.url("/api/pandacode/commands/list_projects");
        let first = client
            .post(&url)
            .header("host", "panda.test")
            .header("origin", "http://panda.test")
            .header("cookie", &cookie)
            .header("x-csrf-token", &csrf)
            .header("x-request-id", "body-bound-request")
            .json(&json!({"cursor": "one"}));
        let second = client
            .post(&url)
            .header("host", "panda.test")
            .header("origin", "http://panda.test")
            .header("cookie", &cookie)
            .header("x-csrf-token", &csrf)
            .header("x-request-id", "body-bound-request")
            .json(&json!({"cursor": "two"}));
        let first_task = tokio::spawn(async move { first.send().await.unwrap() });
        let broker = fixture.commands.recv().await.unwrap();
        assert_eq!(broker.command, "list_projects");
        let second_response = second.send().await.unwrap();
        assert_eq!(second_response.status(), StatusCode::CONFLICT);
        fixture
            .gateway
            .resolve(&broker.id, Some(json!([{ "id": "p" }])), None);
        assert_eq!(first_task.await.unwrap().status(), StatusCode::OK);
        assert!(
            tokio::time::timeout(Duration::from_millis(100), fixture.commands.recv())
                .await
                .is_err(),
            "body-mismatched duplicate request reached native broker"
        );
    }

    #[tokio::test]
    async fn tcp_times_out_a_real_unanswered_broker_request() {
        let mut fixture = Fixture::new(Duration::from_millis(80)).await;
        let token = fixture.pair_token();
        let (session, csrf) = fixture.login(&token).await;
        let client = reqwest::Client::new();
        let cookie = format!("{}={}", auth::SESSION_COOKIE, session);
        let response = client
            .post(fixture.url("/api/pandacode/commands/list_projects"))
            .header("host", "panda.test")
            .header("origin", "http://panda.test")
            .header("cookie", &cookie)
            .header("x-csrf-token", &csrf)
            .header("x-request-id", "unanswered-request")
            .json(&json!({}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::GATEWAY_TIMEOUT);
        assert!(fixture.commands.recv().await.is_some());
        let retry = client
            .post(fixture.url("/api/pandacode/commands/list_projects"))
            .header("host", "panda.test")
            .header("origin", "http://panda.test")
            .header("cookie", cookie)
            .header("x-csrf-token", csrf)
            .header("x-request-id", "unanswered-request")
            .json(&json!({}))
            .send()
            .await
            .unwrap();
        assert_eq!(retry.status(), StatusCode::CONFLICT);
        assert!(
            tokio::time::timeout(Duration::from_millis(100), fixture.commands.recv())
                .await
                .is_err(),
            "an uncertain request identity reached the native broker twice"
        );
    }

    #[tokio::test]
    async fn runtime_snapshot_is_authenticated_and_uses_one_global_barrier() {
        let fixture = Fixture::new(Duration::from_secs(2)).await;
        fixture.gateway.events.push(
            "agent-event",
            json!({"sessionId":"task-a","kind":"status","text":"Working","requestId":null,"data":null}),
        );
        fixture.gateway.events.push(
            "agent-event",
            json!({"sessionId":"task-a","kind":"text","text":"partial","requestId":null,"data":null}),
        );
        fixture.gateway.events.push(
            "agent-event",
            json!({"sessionId":"task-b","kind":"approval","text":"Run?","requestId":"approval-b","data":null}),
        );
        let client = reqwest::Client::new();
        let denied = client
            .get(fixture.url("/api/pandacode/runtime-snapshot"))
            .header("host", "panda.test")
            .send()
            .await
            .unwrap();
        assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);

        let token = fixture.pair_token();
        let (session, _) = fixture.login(&token).await;
        let response = client
            .get(fixture.url("/api/pandacode/runtime-snapshot"))
            .header("host", "panda.test")
            .header("cookie", format!("{}={}", auth::SESSION_COOKIE, session))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let snapshot = response.json::<Value>().await.unwrap();
        assert_eq!(snapshot["sequence"], 3);
        assert_eq!(snapshot["truncated"], false);
        assert!(snapshot["events"].as_array().is_some_and(|events| {
            events.len() == 4 && events.iter().all(|event| event["type"] == "agent-event")
        }));

        let filtered = client
            .get(fixture.url("/api/pandacode/runtime-snapshot?sessionId=task-b"))
            .header("host", "panda.test")
            .header("cookie", format!("{}={}", auth::SESSION_COOKIE, session))
            .send()
            .await
            .unwrap()
            .json::<Value>()
            .await
            .unwrap();
        assert_eq!(filtered["sequence"], 3);
        assert!(filtered["events"].as_array().is_some_and(|events| {
            events.len() == 1 && events[0]["payload"]["sessionId"] == "task-b"
        }));
    }

    #[tokio::test]
    async fn interrupted_upload_removes_partial_file_and_restores_session_quota() {
        let temp = std::env::temp_dir().join(format!(
            "pandacode-web-interrupted-upload-{}",
            uuid::Uuid::new_v4()
        ));
        let root = temp.join("root");
        std::fs::create_dir_all(&root).unwrap();
        let mut fixture = Fixture::new_with_root(Duration::from_secs(2), Some(root)).await;
        let token = fixture.pair_token();
        let (session, csrf) = fixture.login(&token).await;
        let cookie = format!("{}={}", auth::SESSION_COOKIE, session);
        let cache = fixture.temp.as_ref().unwrap().join("cache");

        let mut stream = tokio::net::TcpStream::connect(fixture.address)
            .await
            .unwrap();
        let headers = format!(
            "POST /api/pandacode/files/upload HTTP/1.1\r\nHost: panda.test\r\nOrigin: http://panda.test\r\nCookie: {cookie}\r\nX-CSRF-Token: {csrf}\r\nX-File-Name: interrupted.bin\r\nX-File-Purpose: attachment\r\nContent-Length: 32\r\nConnection: close\r\n\r\n"
        );
        stream.write_all(headers.as_bytes()).await.unwrap();
        stream.write_all(b"half").await.unwrap();
        stream.flush().await.unwrap();

        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if std::fs::read_dir(&cache)
                    .ok()
                    .is_some_and(|mut entries| entries.next().is_some())
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("upload handler never created its partial file");
        stream.shutdown().await.unwrap();
        drop(stream);

        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if std::fs::read_dir(&cache)
                    .ok()
                    .is_some_and(|mut entries| entries.next().is_none())
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("interrupted upload left a partial file");

        let client = reqwest::Client::new();
        let mut first_grant = None;
        for index in 0..16 {
            let response = client
                .post(fixture.url("/api/pandacode/files/upload"))
                .header("host", "panda.test")
                .header("origin", "http://panda.test")
                .header("cookie", &cookie)
                .header("x-csrf-token", &csrf)
                .header("x-file-name", format!("valid-{index}.bin"))
                .header("x-file-purpose", "attachment")
                .header("content-length", "1")
                .body(vec![index as u8])
                .send()
                .await
                .unwrap();
            assert_eq!(
                response.status(),
                StatusCode::CREATED,
                "interrupted upload retained quota before valid upload {index}"
            );
            let value = response.json::<Value>().await.unwrap();
            if first_grant.is_none() {
                first_grant = value["grant"].as_str().map(str::to_owned);
            }
        }

        let request = client
            .post(fixture.url("/api/pandacode/commands/import_prompt_image"))
            .header("host", "panda.test")
            .header("origin", "http://panda.test")
            .header("cookie", &cookie)
            .header("x-csrf-token", &csrf)
            .header("x-request-id", "post-interruption-image-import")
            .json(&json!({
                "path": first_grant.unwrap(),
                "dataUrl": null,
                "name": "valid-0.bin"
            }));
        let sending = tokio::spawn(async move { request.send().await.unwrap() });
        let broker = fixture.commands.recv().await.unwrap();
        let consumed = std::path::PathBuf::from(broker.args["path"].as_str().unwrap());
        assert!(consumed.exists());
        fixture
            .gateway
            .resolve(&broker.id, Some(json!({"id":"post-interruption"})), None);
        assert_eq!(sending.await.unwrap().status(), StatusCode::OK);
        assert!(!consumed.exists());

        fixture.gateway.revoke_session(&session).unwrap();
        assert!(
            std::fs::read_dir(&cache).unwrap().next().is_none(),
            "session cleanup left upload files behind"
        );
    }

    #[tokio::test]
    async fn file_routes_list_select_materialize_upload_and_cleanup_over_tcp() {
        let temp =
            std::env::temp_dir().join(format!("pandacode-web-files-{}", uuid::Uuid::new_v4()));
        let root = temp.join("root");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("note.txt"), b"hello").unwrap();
        let mut fixture = Fixture::new_with_root_and_timeouts(
            Duration::from_millis(40),
            Duration::from_millis(200),
            Some(root.clone()),
        )
        .await;
        let token = fixture.pair_token();
        let (session, csrf) = fixture.login(&token).await;
        let cookie = format!("{}={}", auth::SESSION_COOKIE, session);
        let client = reqwest::Client::new();

        let roots = client
            .get(fixture.url("/api/pandacode/files/roots"))
            .header("host", "panda.test")
            .header("cookie", &cookie)
            .send()
            .await
            .unwrap()
            .json::<Value>()
            .await
            .unwrap();
        let root_id = roots[0]["id"].as_str().unwrap();
        let listing = client
            .get(fixture.url(&format!("/api/pandacode/files/list?root={root_id}")))
            .header("host", "panda.test")
            .header("cookie", &cookie)
            .send()
            .await
            .unwrap();
        assert_eq!(listing.status(), StatusCode::OK);
        assert_eq!(
            listing.json::<Value>().await.unwrap()["entries"][0]["name"],
            "note.txt"
        );

        let selected = client
            .post(fixture.url("/api/pandacode/files/select"))
            .header("host", "panda.test")
            .header("origin", "http://panda.test")
            .header("cookie", &cookie)
            .header("x-csrf-token", &csrf)
            .json(&json!({ "root": root_id, "path": "note.txt", "kind": "file", "purpose": "attachment" }))
            .send()
            .await
            .unwrap()
            .json::<Value>()
            .await
            .unwrap();
        let grant = selected["grant"].as_str().unwrap();
        let request = client
            .post(fixture.url("/api/pandacode/commands/read_document"))
            .header("host", "panda.test")
            .header("origin", "http://panda.test")
            .header("cookie", &cookie)
            .header("x-csrf-token", &csrf)
            .header("x-request-id", "document-read")
            .json(&json!({ "path": grant }));
        let sending = tokio::spawn(async move { request.send().await.unwrap() });
        let broker = fixture.commands.recv().await.unwrap();
        assert_eq!(broker.command, "read_document");
        assert_eq!(
            broker.args["path"],
            root.join("note.txt").to_string_lossy().as_ref()
        );
        fixture
            .gateway
            .resolve(&broker.id, Some(json!({ "text": "hello" })), None);
        assert_eq!(sending.await.unwrap().status(), StatusCode::OK);

        let uploaded = client
            .post(fixture.url("/api/pandacode/files/upload"))
            .header("host", "panda.test")
            .header("origin", "http://panda.test")
            .header("cookie", &cookie)
            .header("x-csrf-token", &csrf)
            .header("x-file-name", "image.png")
            .header("x-file-purpose", "attachment")
            .header("content-length", "4")
            .body(vec![1u8, 2, 3, 4])
            .send()
            .await
            .unwrap();
        assert_eq!(uploaded.status(), StatusCode::CREATED);
        let grant = uploaded.json::<Value>().await.unwrap()["grant"]
            .as_str()
            .unwrap()
            .to_owned();
        let request = client
            .post(fixture.url("/api/pandacode/commands/import_prompt_image"))
            .header("host", "panda.test")
            .header("origin", "http://panda.test")
            .header("cookie", &cookie)
            .header("x-csrf-token", &csrf)
            .header("x-request-id", "image-import")
            .json(&json!({ "path": grant, "dataUrl": null, "name": "image.png" }));
        let sending = tokio::spawn(async move { request.send().await.unwrap() });
        let broker = fixture.commands.recv().await.unwrap();
        let uploaded_path = std::path::PathBuf::from(broker.args["path"].as_str().unwrap());
        assert!(uploaded_path.exists());
        fixture
            .gateway
            .resolve(&broker.id, Some(json!({ "id": "image" })), None);
        assert_eq!(sending.await.unwrap().status(), StatusCode::OK);
        assert!(
            !uploaded_path.exists(),
            "consumed upload was not cleaned up"
        );
    }

    #[tokio::test]
    async fn file_locate_returns_only_approved_root_coordinates_over_tcp() {
        let temp =
            std::env::temp_dir().join(format!("pandacode-web-locate-{}", uuid::Uuid::new_v4()));
        let root = temp.join("root");
        let folder = root.join("folder");
        let outside = temp.join("outside");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let file = folder.join("note.txt");
        std::fs::write(&file, b"inside").unwrap();
        let secret = outside.join("secret.txt");
        std::fs::write(&secret, b"outside").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, root.join("escape")).unwrap();

        let fixture = Fixture::new_with_root(Duration::from_secs(2), Some(root)).await;
        let token = fixture.pair_token();
        let (session, csrf) = fixture.login(&token).await;
        let cookie = format!("{}={}", auth::SESSION_COOKIE, session);
        let client = reqwest::Client::new();
        let locate = |path: &std::path::Path| {
            client
                .post(fixture.url("/api/pandacode/files/locate"))
                .header("host", "panda.test")
                .header("origin", "http://panda.test")
                .header("cookie", &cookie)
                .header("x-csrf-token", &csrf)
                .json(&json!({"path":path.to_string_lossy()}))
        };

        let located_file = locate(&file).send().await.unwrap();
        assert_eq!(located_file.status(), StatusCode::OK);
        let located_file = located_file.json::<Value>().await.unwrap();
        assert!(located_file["root"]
            .as_str()
            .is_some_and(|root| !root.is_empty()));
        assert_eq!(located_file["path"], "folder");
        assert_eq!(located_file["name"], "note.txt");
        assert!(located_file.get("grant").is_none());

        let located_folder = locate(&folder).send().await.unwrap();
        assert_eq!(located_folder.status(), StatusCode::OK);
        let located_folder = located_folder.json::<Value>().await.unwrap();
        assert_eq!(located_folder["path"], "folder");
        assert_eq!(located_folder["name"], "folder");

        assert_eq!(
            locate(&secret).send().await.unwrap().status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            locate(&temp.join("missing")).send().await.unwrap().status(),
            StatusCode::BAD_REQUEST
        );
        #[cfg(unix)]
        assert_eq!(
            locate(&temp.join("root/escape/secret.txt"))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::BAD_REQUEST
        );
        let unknown_field = client
            .post(fixture.url("/api/pandacode/files/locate"))
            .header("host", "panda.test")
            .header("origin", "http://panda.test")
            .header("cookie", cookie)
            .header("x-csrf-token", csrf)
            .json(&json!({"path":file.to_string_lossy(),"root":"forged"}))
            .send()
            .await
            .unwrap();
        assert!(matches!(
            unknown_field.status(),
            StatusCode::BAD_REQUEST | StatusCode::UNPROCESSABLE_ENTITY
        ));
    }

    #[tokio::test]
    async fn github_clone_materializes_one_project_parent_grant_over_tcp() {
        let temp =
            std::env::temp_dir().join(format!("pandacode-web-clone-{}", uuid::Uuid::new_v4()));
        let root = temp.join("root");
        std::fs::create_dir_all(&root).unwrap();
        let mut fixture = Fixture::new_with_root(Duration::from_secs(2), Some(root.clone())).await;
        let token = fixture.pair_token();
        let (session, csrf) = fixture.login(&token).await;
        let cookie = format!("{}={}", auth::SESSION_COOKIE, session);
        let client = reqwest::Client::new();
        let roots = client
            .get(fixture.url("/api/pandacode/files/roots"))
            .header("host", "panda.test")
            .header("cookie", &cookie)
            .send()
            .await
            .unwrap()
            .json::<Value>()
            .await
            .unwrap();
        let root_id = roots[0]["id"].as_str().unwrap();
        let grant = client
            .post(fixture.url("/api/pandacode/files/select"))
            .header("host", "panda.test")
            .header("origin", "http://panda.test")
            .header("cookie", &cookie)
            .header("x-csrf-token", &csrf)
            .json(&json!({"root":root_id,"path":"","kind":"folder","purpose":"project"}))
            .send()
            .await
            .unwrap()
            .json::<Value>()
            .await
            .unwrap()["grant"]
            .as_str()
            .unwrap()
            .to_owned();
        let clone = client
            .post(fixture.url("/api/pandacode/commands/github_clone_repo"))
            .header("host", "panda.test")
            .header("origin", "http://panda.test")
            .header("cookie", &cookie)
            .header("x-csrf-token", &csrf)
            .header("x-request-id", "clone-granted")
            .json(&json!({"repo":"owner/repo","parent":grant}));
        let clone = tokio::spawn(async move { clone.send().await.unwrap() });
        let broker = fixture.commands.recv().await.unwrap();
        assert_eq!(broker.command, "github_clone_repo");
        assert_eq!(broker.args["repo"], "owner/repo");
        assert_eq!(broker.args["parent"], root.to_string_lossy().as_ref());
        tokio::time::sleep(Duration::from_millis(80)).await;
        fixture.gateway.resolve(
            &broker.id,
            Some(json!({"id":"project","name":"repo","path":root.join("repo")})),
            None,
        );
        assert_eq!(clone.await.unwrap().status(), StatusCode::OK);

        let raw_parent = root.to_string_lossy().into_owned();
        for (request_id, parent) in [
            ("clone-grant-reuse", grant.as_str()),
            ("clone-raw-path", raw_parent.as_str()),
        ] {
            let rejected = client
                .post(fixture.url("/api/pandacode/commands/github_clone_repo"))
                .header("host", "panda.test")
                .header("origin", "http://panda.test")
                .header("cookie", &cookie)
                .header("x-csrf-token", &csrf)
                .header("x-request-id", request_id)
                .json(&json!({"repo":"owner/repo","parent":parent}))
                .send()
                .await
                .unwrap();
            assert_eq!(rejected.status(), StatusCode::BAD_REQUEST);
        }
        assert!(
            tokio::time::timeout(Duration::from_millis(100), fixture.commands.recv())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn document_route_streams_exact_native_scoped_bytes_over_tcp() {
        let temp =
            std::env::temp_dir().join(format!("pandacode-web-document-{}", uuid::Uuid::new_v4()));
        let root = temp.join("root");
        std::fs::create_dir_all(&root).unwrap();
        let expected = b"%PDF-fixture\0binary";
        std::fs::write(root.join("report.pdf"), expected).unwrap();
        let fixture = Fixture::new_with_root(Duration::from_secs(2), Some(root)).await;
        let token = fixture.pair_token();
        let (session, _) = fixture.login(&token).await;
        let client = reqwest::Client::new();
        let mut document_url =
            reqwest::Url::parse(&fixture.url("/api/pandacode/files/document")).unwrap();
        document_url
            .query_pairs_mut()
            .append_pair("projectId", "fixture-project")
            .append_pair("path", "report.pdf");
        let response = client
            .get(document_url)
            .header("host", "panda.test")
            .header("cookie", format!("{}={}", auth::SESSION_COOKIE, session))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()[header::CONTENT_TYPE],
            "application/octet-stream"
        );
        assert_eq!(
            response.headers()[header::CONTENT_DISPOSITION],
            "attachment"
        );
        assert_eq!(
            response.headers()[header::CONTENT_SECURITY_POLICY],
            "sandbox; default-src 'none'"
        );
        assert_eq!(response.bytes().await.unwrap().as_ref(), expected);

        let mut rejected_url =
            reqwest::Url::parse(&fixture.url("/api/pandacode/files/document")).unwrap();
        rejected_url
            .query_pairs_mut()
            .append_pair("projectId", "fixture-project")
            .append_pair("path", "../outside.pdf");
        let rejected = client
            .get(rejected_url)
            .header("host", "panda.test")
            .header("cookie", format!("{}={}", auth::SESSION_COOKIE, session))
            .send()
            .await
            .unwrap();
        assert_eq!(rejected.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn console_leases_bind_controller_frame_input_and_logout_over_tcp() {
        let fixture = Fixture::new(Duration::from_secs(2)).await;
        let token = fixture.pair_token();
        let (session, csrf) = fixture.login(&token).await;
        let client = reqwest::Client::new();
        let open = || {
            client
                .post(fixture.url("/api/pandacode/consoles/open"))
                .header("host", "panda.test")
                .header("origin", "http://panda.test")
                .header("cookie", format!("{}={}", auth::SESSION_COOKIE, session))
                .header("x-csrf-token", &csrf)
                .header("x-request-id", "open-console-1")
                .json(&json!({"kind":"simulator", "target":"fixture"}))
        };
        let response = open().send().await.unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
        let opened: Value = response.json().await.unwrap();
        let lease = opened["lease"].as_str().unwrap().to_owned();
        assert_eq!(opened["controller"], true);

        let repeated: Value = open().send().await.unwrap().json().await.unwrap();
        assert_eq!(repeated["lease"], lease);

        let mut frame_url =
            reqwest::Url::parse(&fixture.url("/api/pandacode/consoles/frame")).unwrap();
        frame_url
            .query_pairs_mut()
            .append_pair("lease", &lease)
            .append_pair("after", "6");
        let frame = client
            .get(frame_url)
            .header("host", "panda.test")
            .header("cookie", format!("{}={}", auth::SESSION_COOKIE, session))
            .send()
            .await
            .unwrap();
        assert_eq!(frame.status(), StatusCode::OK);
        assert_eq!(
            frame.headers()[header::CONTENT_TYPE],
            "application/octet-stream"
        );
        assert!(frame.headers().contains_key("x-console-expires-at"));
        let mut expected = 7u64.to_le_bytes().to_vec();
        expected.extend_from_slice(b"fixture-jpeg");
        assert_eq!(frame.bytes().await.unwrap().as_ref(), expected);

        let input = client
            .post(fixture.url("/api/pandacode/consoles/input"))
            .header("host", "panda.test")
            .header("origin", "http://panda.test")
            .header("cookie", format!("{}={}", auth::SESSION_COOKIE, session))
            .header("x-csrf-token", &csrf)
            .header("x-request-id", "console-input-1")
            .json(&json!({
                "lease": lease,
                "input": {"kind":"tap", "x":12, "y":18}
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(input.status(), StatusCode::OK);
        assert_eq!(
            input.json::<Value>().await.unwrap()["result"],
            "fixture input accepted"
        );

        let logout = client
            .delete(fixture.url("/api/pandacode/session"))
            .header("host", "panda.test")
            .header("origin", "http://panda.test")
            .header("cookie", format!("{}={}", auth::SESSION_COOKIE, session))
            .header("x-csrf-token", &csrf)
            .send()
            .await
            .unwrap();
        assert_eq!(logout.status(), StatusCode::NO_CONTENT);
        assert!(super::super::lock(&fixture.gateway.consoles)
            .use_lease(&session, &lease, false)
            .is_err());
    }

    #[tokio::test]
    async fn console_lifecycle_requires_controller_and_finite_typed_actions_over_tcp() {
        let fixture = Fixture::new(Duration::from_secs(2)).await;
        let token = fixture.pair_token();
        let (session, csrf) = fixture.login(&token).await;
        let client = reqwest::Client::new();
        let cookie = format!("{}={}", auth::SESSION_COOKIE, session);

        let manager = client
            .post(fixture.url("/api/pandacode/consoles/open"))
            .header("host", "panda.test")
            .header("origin", "http://panda.test")
            .header("cookie", &cookie)
            .header("x-csrf-token", &csrf)
            .header("x-request-id", "open-vm-manager")
            .json(&json!({"kind":"vm", "target":"$manager"}))
            .send()
            .await
            .unwrap();
        assert_eq!(manager.status(), StatusCode::CREATED);
        let manager_lease = manager.json::<Value>().await.unwrap()["lease"]
            .as_str()
            .unwrap()
            .to_owned();

        let create = client
            .post(fixture.url("/api/pandacode/consoles/lifecycle"))
            .header("host", "panda.test")
            .header("origin", "http://panda.test")
            .header("cookie", &cookie)
            .header("x-csrf-token", &csrf)
            .header("x-request-id", "create-fixture-vm")
            .json(&json!({
                "lease": &manager_lease,
                "action": "vmCreate",
                "image": "ubuntu",
                "name": "fixture-vm"
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(create.status(), StatusCode::OK);
        let created = create.json::<Value>().await.unwrap();
        assert_eq!(created["result"]["target"], "$manager");
        assert_eq!(created["result"]["action"]["action"], "vmCreate");

        let raw_vm_create = client
            .post(fixture.url("/api/pandacode/commands/vm_create"))
            .header("host", "panda.test")
            .header("origin", "http://panda.test")
            .header("cookie", &cookie)
            .header("x-csrf-token", &csrf)
            .json(&json!({"image":"ubuntu", "name":"bypass"}))
            .send()
            .await
            .unwrap();
        assert_eq!(raw_vm_create.status(), StatusCode::NOT_IMPLEMENTED);

        let wrong_kind = client
            .post(fixture.url("/api/pandacode/consoles/lifecycle"))
            .header("host", "panda.test")
            .header("origin", "http://panda.test")
            .header("cookie", &cookie)
            .header("x-csrf-token", &csrf)
            .header("x-request-id", "wrong-lifecycle-kind")
            .json(&json!({
                "lease": &manager_lease,
                "action": "simulatorCreateDuo"
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(wrong_kind.status(), StatusCode::BAD_REQUEST);

        let viewer = client
            .post(fixture.url("/api/pandacode/consoles/open"))
            .header("host", "panda.test")
            .header("origin", "http://panda.test")
            .header("cookie", &cookie)
            .header("x-csrf-token", &csrf)
            .header("x-request-id", "open-vm-manager-viewer")
            .json(&json!({"kind":"vm", "target":"$manager", "control":false}))
            .send()
            .await
            .unwrap();
        assert_eq!(viewer.status(), StatusCode::CREATED);
        let viewer_lease = viewer.json::<Value>().await.unwrap()["lease"]
            .as_str()
            .unwrap()
            .to_owned();
        let viewer_mutation = client
            .post(fixture.url("/api/pandacode/consoles/lifecycle"))
            .header("host", "panda.test")
            .header("origin", "http://panda.test")
            .header("cookie", &cookie)
            .header("x-csrf-token", &csrf)
            .header("x-request-id", "viewer-vm-setup")
            .json(&json!({"lease":viewer_lease, "action":"vmSetup"}))
            .send()
            .await
            .unwrap();
        assert_eq!(viewer_mutation.status(), StatusCode::FORBIDDEN);

        let vm = client
            .post(fixture.url("/api/pandacode/consoles/open"))
            .header("host", "panda.test")
            .header("origin", "http://panda.test")
            .header("cookie", &cookie)
            .header("x-csrf-token", &csrf)
            .header("x-request-id", "open-vm-target")
            .json(&json!({"kind":"vm", "target":"fixture"}))
            .send()
            .await
            .unwrap();
        let vm_lease = vm.json::<Value>().await.unwrap()["lease"]
            .as_str()
            .unwrap()
            .to_owned();
        let delete_without_confirmation = client
            .post(fixture.url("/api/pandacode/consoles/lifecycle"))
            .header("host", "panda.test")
            .header("origin", "http://panda.test")
            .header("cookie", &cookie)
            .header("x-csrf-token", &csrf)
            .header("x-request-id", "delete-without-confirmation")
            .json(&json!({
                "lease":&vm_lease,
                "action":"vmPower",
                "operation":"delete"
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(
            delete_without_confirmation.status(),
            StatusCode::BAD_REQUEST
        );
        let confirmed_delete = client
            .post(fixture.url("/api/pandacode/consoles/lifecycle"))
            .header("host", "panda.test")
            .header("origin", "http://panda.test")
            .header("cookie", &cookie)
            .header("x-csrf-token", &csrf)
            .header("x-request-id", "delete-with-confirmation")
            .json(&json!({
                "lease":&vm_lease,
                "action":"vmPower",
                "operation":"delete",
                "confirm":"fixture"
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(confirmed_delete.status(), StatusCode::OK);

        let simulator = client
            .post(fixture.url("/api/pandacode/consoles/open"))
            .header("host", "panda.test")
            .header("origin", "http://panda.test")
            .header("cookie", &cookie)
            .header("x-csrf-token", &csrf)
            .header("x-request-id", "open-simulator-capture")
            .json(&json!({"kind":"simulator", "target":"fixture"}))
            .send()
            .await
            .unwrap();
        let simulator_lease = simulator.json::<Value>().await.unwrap()["lease"]
            .as_str()
            .unwrap()
            .to_owned();
        let mut capture_url =
            reqwest::Url::parse(&fixture.url("/api/pandacode/consoles/capture")).unwrap();
        capture_url
            .query_pairs_mut()
            .append_pair("lease", &simulator_lease);
        let capture = client
            .get(capture_url)
            .header("host", "panda.test")
            .header("cookie", &cookie)
            .send()
            .await
            .unwrap();
        assert_eq!(capture.status(), StatusCode::OK);
        assert_eq!(capture.headers()[header::CONTENT_TYPE], "image/png");
        assert!(capture.bytes().await.unwrap().starts_with(b"\x89PNG"));
    }

    #[tokio::test]
    async fn dock_preferences_are_typed_and_native_pin_stays_blocked_over_tcp() {
        let fixture = Fixture::new(Duration::from_secs(2)).await;
        let token = fixture.pair_token();
        let (session, csrf) = fixture.login(&token).await;
        let client = reqwest::Client::new();
        let cookie = format!("{}={}", auth::SESSION_COOKIE, session);
        let save = || {
            client
                .post(fixture.url("/api/pandacode/dock"))
                .header("host", "panda.test")
                .header("origin", "http://panda.test")
                .header("cookie", &cookie)
                .header("x-csrf-token", &csrf)
                .header("x-request-id", "save-dock-preferences")
                .json(&json!({
                    "action":"save",
                    "enabled":true,
                    "keepOnScreen":false
                }))
        };
        let saved = save().send().await.unwrap();
        assert_eq!(saved.status(), StatusCode::OK);
        assert_eq!(
            saved.json::<Value>().await.unwrap(),
            json!({"enabled":true, "keepOnScreen":false, "pinned":false})
        );
        assert_eq!(save().send().await.unwrap().status(), StatusCode::OK);

        let pin = client
            .post(fixture.url("/api/pandacode/dock"))
            .header("host", "panda.test")
            .header("origin", "http://panda.test")
            .header("cookie", &cookie)
            .header("x-csrf-token", &csrf)
            .header("x-request-id", "pin-native-dock")
            .json(&json!({"action":"pin"}))
            .send()
            .await
            .unwrap();
        assert_eq!(pin.status(), StatusCode::NOT_IMPLEMENTED);
    }

    #[tokio::test]
    async fn websocket_authenticates_and_replays_ordered_events_over_tcp() {
        let fixture = Fixture::new(Duration::from_secs(2)).await;
        let token = fixture.pair_token();
        let (session, _) = fixture.login(&token).await;
        super::super::lock(&fixture.gateway.terminals)
            .claim("private-terminal", "another-session")
            .unwrap();
        fixture.gateway.events.push(
            "terminal-event",
            json!({ "terminalId": "private-terminal", "data": "secret output" }),
        );
        fixture
            .gateway
            .events
            .push("sessions-changed", json!({ "source": "test" }));
        let mut request = format!("ws://{}/api/pandacode/events", fixture.address)
            .into_client_request()
            .unwrap();
        request
            .headers_mut()
            .insert("host", HeaderValue::from_static("panda.test"));
        request
            .headers_mut()
            .insert("origin", HeaderValue::from_static("http://panda.test"));
        request.headers_mut().insert(
            "cookie",
            HeaderValue::from_str(&format!("{}={}", auth::SESSION_COOKIE, session)).unwrap(),
        );
        let (mut socket, _) = connect_async(request).await.unwrap();
        socket
            .send(tokio_tungstenite::tungstenite::Message::Text(
                r#"{"type":"resume","sequence":0}"#.into(),
            ))
            .await
            .unwrap();
        let cursor = tokio::time::timeout(Duration::from_secs(1), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let cursor: Value = serde_json::from_str(cursor.to_text().unwrap()).unwrap();
        assert_eq!(cursor["type"], "web-gateway-cursor");
        assert_eq!(cursor["sequence"], 1);
        let message = tokio::time::timeout(Duration::from_secs(1), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let value: Value = serde_json::from_str(message.to_text().unwrap()).unwrap();
        assert_eq!(value["type"], "sessions-changed");
        assert_eq!(value["sequence"], 2);
    }

    #[tokio::test]
    async fn terminal_create_reserves_an_owned_snapshot_before_delayed_output_over_tcp() {
        let mut fixture = Fixture::new(Duration::from_secs(2)).await;
        let token = fixture.pair_token();
        let (session, csrf) = fixture.login(&token).await;
        let cookie = format!("{}={}", auth::SESSION_COOKIE, session);
        let client = reqwest::Client::new();
        let creating = client
            .post(fixture.url("/api/pandacode/commands/start_terminal"))
            .header("host", "panda.test")
            .header("origin", "http://panda.test")
            .header("cookie", &cookie)
            .header("x-csrf-token", &csrf)
            .header("x-request-id", "create-delayed-output-terminal")
            .json(&json!({}));
        let creating = tokio::spawn(async move { creating.send().await.unwrap() });
        let broker = fixture.commands.recv().await.unwrap();
        assert_eq!(broker.command, "start_terminal");
        fixture.gateway.resolve(
            &broker.id,
            Some(Value::String("delayed-output-terminal".into())),
            None,
        );
        let created = creating.await.unwrap();
        assert_eq!(created.status(), StatusCode::OK);
        assert_eq!(
            created.json::<Value>().await.unwrap(),
            Value::String("delayed-output-terminal".into())
        );

        let initial = client
            .get(fixture.url("/api/pandacode/terminals/delayed-output-terminal/snapshot"))
            .header("host", "panda.test")
            .header("cookie", &cookie)
            .send()
            .await
            .unwrap();
        assert_eq!(initial.status(), StatusCode::OK);
        let initial = initial.json::<Value>().await.unwrap();
        assert_eq!(initial["baseSequence"], 0);
        assert_eq!(initial["nextSequence"], 0);
        assert_eq!(initial["data"], "");
        assert_eq!(initial["exit"], false);
        assert_eq!(initial["truncated"], false);

        fixture.gateway.record_native_event(
            "terminal-event",
            json!({
                "terminalId":"delayed-output-terminal",
                "data":"prompt after response\r\n",
                "exit":false
            }),
        );
        let after_output = client
            .get(fixture.url("/api/pandacode/terminals/delayed-output-terminal/snapshot"))
            .header("host", "panda.test")
            .header("cookie", &cookie)
            .send()
            .await
            .unwrap()
            .json::<Value>()
            .await
            .unwrap();
        assert_eq!(after_output["baseSequence"], 1);
        assert_eq!(after_output["nextSequence"], 1);
        assert_eq!(after_output["data"], "prompt after response\r\n");
        assert_eq!(after_output["truncated"], false);
    }

    #[tokio::test]
    async fn terminal_create_closes_native_pty_when_journal_capacity_is_exhausted() {
        let mut fixture = Fixture::new(Duration::from_secs(2)).await;
        let token = fixture.pair_token();
        let (session, csrf) = fixture.login(&token).await;
        let cookie = format!("{}={}", auth::SESSION_COOKIE, session);
        for index in 0..64 {
            fixture.gateway.record_native_event(
                "terminal-event",
                json!({
                    "terminalId":format!("occupied-journal-{index}"),
                    "data":"",
                    "exit":false
                }),
            );
        }

        let client = reqwest::Client::new();
        let creating = client
            .post(fixture.url("/api/pandacode/commands/start_terminal"))
            .header("host", "panda.test")
            .header("origin", "http://panda.test")
            .header("cookie", &cookie)
            .header("x-csrf-token", &csrf)
            .header("x-request-id", "create-terminal-at-journal-capacity")
            .json(&json!({}));
        let creating = tokio::spawn(async move { creating.send().await.unwrap() });
        let broker = fixture.commands.recv().await.unwrap();
        assert_eq!(broker.command, "start_terminal");
        fixture.gateway.resolve(
            &broker.id,
            Some(Value::String("capacity-terminal".into())),
            None,
        );

        assert_eq!(
            creating.await.unwrap().status(),
            StatusCode::TOO_MANY_REQUESTS
        );
        let closed = tokio::time::timeout(Duration::from_secs(1), fixture.terminal_closes.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(closed, "capacity-terminal");
        assert!(super::super::lock(&fixture.gateway.terminals)
            .check("capacity-terminal", &session)
            .is_err());
        assert!(
            !super::super::lock(&fixture.gateway.terminal_journal).contains("capacity-terminal")
        );

        fixture.gateway.record_native_event(
            "terminal-event",
            json!({"terminalId":"capacity-terminal","data":"late","exit":true}),
        );
        assert!(
            !super::super::lock(&fixture.gateway.terminal_journal).contains("capacity-terminal")
        );
    }

    #[tokio::test]
    async fn terminal_snapshot_keeps_startup_output_and_enforces_owner_and_sequence_barrier() {
        let mut fixture = Fixture::new(Duration::from_secs(2)).await;
        let token = fixture.pair_token();
        let (session, csrf) = fixture.login(&token).await;
        let other_token = fixture.pair_token();
        let (other_session, _) = fixture.login(&other_token).await;
        let cookie = format!("{}={}", auth::SESSION_COOKIE, session);

        fixture.gateway.record_native_event(
            "terminal-event",
            json!({"terminalId":"journal-terminal","data":"startup\r\n","exit":false}),
        );
        super::super::lock(&fixture.gateway.terminals)
            .claim("journal-terminal", &session)
            .unwrap();
        fixture.gateway.record_native_event(
            "terminal-event",
            json!({"terminalId":"journal-terminal","data":"live\r\n","exit":false}),
        );
        fixture.gateway.record_native_event(
            "terminal-event",
            json!({"terminalId":"journal-terminal","data":"","exit":true}),
        );

        let client = reqwest::Client::new();
        let snapshot = client
            .get(fixture.url("/api/pandacode/terminals/journal-terminal/snapshot"))
            .header("host", "panda.test")
            .header("cookie", &cookie)
            .send()
            .await
            .unwrap();
        assert_eq!(snapshot.status(), StatusCode::OK);
        assert_eq!(snapshot.headers()[header::CACHE_CONTROL], "no-store");
        let snapshot = snapshot.json::<Value>().await.unwrap();
        assert_eq!(snapshot["terminalId"], "journal-terminal");
        assert_eq!(snapshot["baseSequence"], 1);
        assert_eq!(snapshot["nextSequence"], 3);
        assert_eq!(snapshot["data"], "startup\r\nlive\r\n");
        assert_eq!(snapshot["exit"], true);
        assert_eq!(snapshot["truncated"], false);

        let denied = client
            .get(fixture.url("/api/pandacode/terminals/journal-terminal/snapshot"))
            .header("host", "panda.test")
            .header(
                "cookie",
                format!("{}={}", auth::SESSION_COOKIE, other_session),
            )
            .send()
            .await
            .unwrap();
        assert_eq!(denied.status(), StatusCode::FORBIDDEN);

        let mut request = format!("ws://{}/api/pandacode/events", fixture.address)
            .into_client_request()
            .unwrap();
        request
            .headers_mut()
            .insert("host", HeaderValue::from_static("panda.test"));
        request
            .headers_mut()
            .insert("origin", HeaderValue::from_static("http://panda.test"));
        request
            .headers_mut()
            .insert("cookie", HeaderValue::from_str(&cookie).unwrap());
        let (mut socket, _) = connect_async(request).await.unwrap();
        socket
            .send(tokio_tungstenite::tungstenite::Message::Text(
                r#"{"type":"resume","sequence":0}"#.into(),
            ))
            .await
            .unwrap();
        for expected in 1..=3 {
            let frame = tokio::time::timeout(Duration::from_secs(1), socket.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            let frame: Value = serde_json::from_str(frame.to_text().unwrap()).unwrap();
            assert_eq!(frame["type"], "terminal-event");
            assert_eq!(frame["payload"]["terminalSequence"], expected);
        }

        let closing = client
            .post(fixture.url("/api/pandacode/commands/close_terminal"))
            .header("host", "panda.test")
            .header("origin", "http://panda.test")
            .header("cookie", &cookie)
            .header("x-csrf-token", &csrf)
            .header("x-request-id", "close-journal-terminal")
            .json(&json!({"terminalId":"journal-terminal"}));
        let closing = tokio::spawn(async move { closing.send().await.unwrap() });
        let broker = fixture.commands.recv().await.unwrap();
        assert_eq!(broker.command, "close_terminal");
        fixture.gateway.resolve(&broker.id, Some(Value::Null), None);
        assert_eq!(closing.await.unwrap().status(), StatusCode::OK);
        let after_close = client
            .get(fixture.url("/api/pandacode/terminals/journal-terminal/snapshot"))
            .header("host", "panda.test")
            .header("cookie", &cookie)
            .send()
            .await
            .unwrap();
        assert_eq!(after_close.status(), StatusCode::FORBIDDEN);
        assert!(!super::super::lock(&fixture.gateway.terminal_journal).contains("journal-terminal"));
        fixture.gateway.record_native_event(
            "terminal-event",
            json!({"terminalId":"journal-terminal","data":"","exit":true}),
        );
        assert!(!super::super::lock(&fixture.gateway.terminal_journal).contains("journal-terminal"));
    }

    #[tokio::test]
    async fn terminal_snapshot_truncates_fail_visible_and_logout_cleans_journal() {
        let fixture = Fixture::new(Duration::from_secs(2)).await;
        let token = fixture.pair_token();
        let (session, csrf) = fixture.login(&token).await;
        let cookie = format!("{}={}", auth::SESSION_COOKIE, session);
        super::super::lock(&fixture.gateway.terminals)
            .claim("large-terminal", &session)
            .unwrap();
        fixture.gateway.record_native_event(
            "terminal-event",
            json!({"terminalId":"large-terminal","data":"a".repeat(700 * 1024),"exit":false}),
        );
        fixture.gateway.record_native_event(
            "terminal-event",
            json!({"terminalId":"large-terminal","data":"b".repeat(700 * 1024),"exit":false}),
        );
        let client = reqwest::Client::new();
        let snapshot = client
            .get(fixture.url("/api/pandacode/terminals/large-terminal/snapshot"))
            .header("host", "panda.test")
            .header("cookie", &cookie)
            .send()
            .await
            .unwrap()
            .json::<Value>()
            .await
            .unwrap();
        assert_eq!(snapshot["truncated"], true);
        assert_eq!(snapshot["baseSequence"], 2);
        assert_eq!(snapshot["nextSequence"], 2);
        assert_eq!(snapshot["data"].as_str().unwrap().len(), 700 * 1024);

        let logout = client
            .delete(fixture.url("/api/pandacode/session"))
            .header("host", "panda.test")
            .header("origin", "http://panda.test")
            .header("cookie", &cookie)
            .header("x-csrf-token", csrf)
            .send()
            .await
            .unwrap();
        assert_eq!(logout.status(), StatusCode::NO_CONTENT);
        assert!(!super::super::lock(&fixture.gateway.terminal_journal).contains("large-terminal"));
    }

    #[tokio::test]
    async fn websocket_closes_immediately_when_session_logs_out() {
        let fixture = Fixture::new(Duration::from_secs(2)).await;
        let token = fixture.pair_token();
        let (session, csrf) = fixture.login(&token).await;
        let mut request = format!("ws://{}/api/pandacode/events", fixture.address)
            .into_client_request()
            .unwrap();
        request
            .headers_mut()
            .insert("host", HeaderValue::from_static("panda.test"));
        request
            .headers_mut()
            .insert("origin", HeaderValue::from_static("http://panda.test"));
        request.headers_mut().insert(
            "cookie",
            HeaderValue::from_str(&format!("{}={}", auth::SESSION_COOKIE, session)).unwrap(),
        );
        let (mut socket, _) = connect_async(request).await.unwrap();
        socket
            .send(tokio_tungstenite::tungstenite::Message::Text(
                r#"{"type":"resume","sequence":0}"#.into(),
            ))
            .await
            .unwrap();

        let response = reqwest::Client::new()
            .delete(fixture.url("/api/pandacode/session"))
            .header("host", "panda.test")
            .header("origin", "http://panda.test")
            .header("cookie", format!("{}={}", auth::SESSION_COOKIE, session))
            .header("x-csrf-token", csrf)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert!(
            tokio::time::timeout(Duration::from_secs(1), socket.next())
                .await
                .is_ok(),
            "revoked WebSocket remained open"
        );
    }

    #[tokio::test]
    async fn session_expiry_closes_only_its_websocket_and_releases_only_its_browser_lease() {
        let mut fixture = Fixture::new(Duration::from_secs(2)).await;
        let expired_token = fixture.pair_token();
        let (expired_session, expired_csrf) = fixture.login(&expired_token).await;
        let live_token = fixture.pair_token();
        let (live_session, live_csrf) = fixture.login(&live_token).await;
        let client = reqwest::Client::new();

        let expired_open = client
            .post(fixture.url("/api/pandacode/browser/open"))
            .header("host", "panda.test")
            .header("origin", "http://panda.test")
            .header(
                "cookie",
                format!("{}={}", auth::SESSION_COOKIE, expired_session),
            )
            .header("x-csrf-token", &expired_csrf)
            .header("x-request-id", "expired-session-browser")
            .json(&json!({"url":"https://example.test/"}))
            .send()
            .await
            .unwrap();
        assert_eq!(expired_open.status(), StatusCode::CREATED);
        let expired_lease = expired_open.json::<Value>().await.unwrap()["lease"]
            .as_str()
            .unwrap()
            .to_owned();

        let live_open = client
            .post(fixture.url("/api/pandacode/browser/open"))
            .header("host", "panda.test")
            .header("origin", "http://panda.test")
            .header(
                "cookie",
                format!("{}={}", auth::SESSION_COOKIE, live_session),
            )
            .header("x-csrf-token", &live_csrf)
            .header("x-request-id", "live-session-browser")
            .json(&json!({"url":"https://example.test/"}))
            .send()
            .await
            .unwrap();
        assert_eq!(live_open.status(), StatusCode::CREATED);
        let live_lease = live_open.json::<Value>().await.unwrap()["lease"]
            .as_str()
            .unwrap()
            .to_owned();
        assert_eq!(fixture.browser_calls.recv().await, Some("open"));
        assert_eq!(fixture.browser_calls.recv().await, Some("open"));

        let mut expired_request = format!("ws://{}/api/pandacode/events", fixture.address)
            .into_client_request()
            .unwrap();
        expired_request
            .headers_mut()
            .insert("host", HeaderValue::from_static("panda.test"));
        expired_request
            .headers_mut()
            .insert("origin", HeaderValue::from_static("http://panda.test"));
        expired_request.headers_mut().insert(
            "cookie",
            HeaderValue::from_str(&format!("{}={}", auth::SESSION_COOKIE, expired_session))
                .unwrap(),
        );
        let (mut expired_socket, _) = connect_async(expired_request).await.unwrap();
        expired_socket
            .send(tokio_tungstenite::tungstenite::Message::Text(
                r#"{"type":"resume","sequence":0}"#.into(),
            ))
            .await
            .unwrap();

        let mut live_request = format!("ws://{}/api/pandacode/events", fixture.address)
            .into_client_request()
            .unwrap();
        live_request
            .headers_mut()
            .insert("host", HeaderValue::from_static("panda.test"));
        live_request
            .headers_mut()
            .insert("origin", HeaderValue::from_static("http://panda.test"));
        live_request.headers_mut().insert(
            "cookie",
            HeaderValue::from_str(&format!("{}={}", auth::SESSION_COOKIE, live_session)).unwrap(),
        );
        let (mut live_socket, _) = connect_async(live_request).await.unwrap();
        live_socket
            .send(tokio_tungstenite::tungstenite::Message::Text(
                r#"{"type":"resume","sequence":0}"#.into(),
            ))
            .await
            .unwrap();

        assert!(super::super::lock(&fixture.gateway.sessions).expire_for_test(&expired_session));
        let expired_status = client
            .get(fixture.url("/api/pandacode/session"))
            .header("host", "panda.test")
            .header(
                "cookie",
                format!("{}={}", auth::SESSION_COOKIE, expired_session),
            )
            .send()
            .await
            .unwrap();
        assert_eq!(expired_status.status(), StatusCode::UNAUTHORIZED);

        let expired_end = tokio::time::timeout(Duration::from_secs(1), expired_socket.next())
            .await
            .expect("expired session WebSocket remained open");
        assert!(
            expired_end.is_none()
                || matches!(
                    expired_end,
                    Some(Err(_)) | Some(Ok(tokio_tungstenite::tungstenite::Message::Close(_)))
                ),
            "expired session WebSocket received another application frame"
        );
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(1), fixture.browser_calls.recv())
                .await
                .unwrap(),
            Some("close")
        );
        assert!(super::super::lock(&fixture.gateway.browsers)
            .release_session(&expired_session)
            .is_empty());

        let live_status = client
            .get(fixture.url("/api/pandacode/session"))
            .header("host", "panda.test")
            .header(
                "cookie",
                format!("{}={}", auth::SESSION_COOKIE, live_session),
            )
            .send()
            .await
            .unwrap();
        assert_eq!(live_status.status(), StatusCode::NO_CONTENT);
        let live_browser = client
            .get(fixture.url(&format!("/api/pandacode/browser/{live_lease}/status")))
            .header("host", "panda.test")
            .header(
                "cookie",
                format!("{}={}", auth::SESSION_COOKIE, live_session),
            )
            .send()
            .await
            .unwrap();
        assert_eq!(live_browser.status(), StatusCode::OK);
        assert_ne!(expired_lease, live_lease);

        live_socket
            .send(tokio_tungstenite::tungstenite::Message::Ping(
                vec![7].into(),
            ))
            .await
            .unwrap();
        let pong = tokio::time::timeout(Duration::from_secs(1), live_socket.next())
            .await
            .expect("independent session WebSocket stopped responding")
            .expect("independent session WebSocket closed")
            .expect("independent session WebSocket failed");
        assert!(matches!(
            pong,
            tokio_tungstenite::tungstenite::Message::Pong(_)
        ));
    }

    #[tokio::test]
    async fn browser_lease_enforces_owner_csrf_and_finite_controls_over_tcp() {
        let fixture = Fixture::new(Duration::from_secs(2)).await;
        let token = fixture.pair_token();
        let (session, csrf) = fixture.login(&token).await;
        let cookie = format!("{}={}", auth::SESSION_COOKIE, session);
        let client = reqwest::Client::new();
        let open = client
            .post(fixture.url("/api/pandacode/browser/open"))
            .header("host", "panda.test")
            .header("origin", "http://panda.test")
            .header("cookie", &cookie)
            .header("x-csrf-token", &csrf)
            .header("x-request-id", "browser-open-1")
            .json(&json!({"url":"https://example.test/","taskId":"task","sessionId":"thread"}))
            .send()
            .await
            .unwrap();
        assert_eq!(open.status(), StatusCode::CREATED);
        let opened = open.json::<Value>().await.unwrap();
        let lease = opened["lease"].as_str().unwrap();
        assert_eq!(opened["title"], "Fixture browser");
        let frame = client
            .get(fixture.url(&format!("/api/pandacode/browser/{lease}/frame")))
            .header("host", "panda.test")
            .header("cookie", &cookie)
            .send()
            .await
            .unwrap();
        assert_eq!(frame.status(), StatusCode::OK);
        assert_eq!(frame.headers()["content-type"], "image/png");
        assert_eq!(frame.headers()["x-browser-sequence"], "7");
        let invalid = client
            .post(fixture.url(&format!("/api/pandacode/browser/{lease}/input")))
            .header("host", "panda.test")
            .header("origin", "http://panda.test")
            .header("cookie", &cookie)
            .header("x-csrf-token", &csrf)
            .header("x-request-id", "browser-input-bad")
            .json(&json!({"kind":"eval","script":"alert(1)"}))
            .send()
            .await
            .unwrap();
        assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);
        let input = client
            .post(fixture.url(&format!("/api/pandacode/browser/{lease}/input")))
            .header("host", "panda.test")
            .header("origin", "http://panda.test")
            .header("cookie", &cookie)
            .header("x-csrf-token", &csrf)
            .header("x-request-id", "browser-input-1")
            .json(&json!({"kind":"tap","x":0.5,"y":0.5}))
            .send()
            .await
            .unwrap();
        assert_eq!(input.status(), StatusCode::OK);
        let scroll = client
            .post(fixture.url(&format!("/api/pandacode/browser/{lease}/input")))
            .header("host", "panda.test")
            .header("origin", "http://panda.test")
            .header("cookie", &cookie)
            .header("x-csrf-token", &csrf)
            .header("x-request-id", "browser-scroll-1")
            .json(&json!({"kind":"scroll","deltaX":12,"deltaY":-48}))
            .send()
            .await
            .unwrap();
        assert_eq!(scroll.status(), StatusCode::OK);
        let missing_csrf = client
            .post(fixture.url(&format!("/api/pandacode/browser/{lease}/action")))
            .header("host", "panda.test")
            .header("origin", "http://panda.test")
            .header("cookie", &cookie)
            .header("x-request-id", "browser-action-1")
            .json(&json!({"action":"reload"}))
            .send()
            .await
            .unwrap();
        assert_eq!(missing_csrf.status(), StatusCode::FORBIDDEN);
        let other_token = fixture.pair_token();
        let (other_session, _) = fixture.login(&other_token).await;
        let forbidden = client
            .get(fixture.url(&format!("/api/pandacode/browser/{lease}/status")))
            .header("host", "panda.test")
            .header(
                "cookie",
                format!("{}={}", auth::SESSION_COOKIE, other_session),
            )
            .send()
            .await
            .unwrap();
        assert_eq!(forbidden.status(), StatusCode::FORBIDDEN);
        let closed = client
            .delete(fixture.url(&format!("/api/pandacode/browser/{lease}")))
            .header("host", "panda.test")
            .header("origin", "http://panda.test")
            .header("cookie", &cookie)
            .header("x-csrf-token", &csrf)
            .header("x-request-id", "browser-close-1")
            .send()
            .await
            .unwrap();
        assert_eq!(closed.status(), StatusCode::NO_CONTENT);
    }

    #[tokio::test]
    async fn browser_open_timeout_and_logout_both_close_the_reserved_native_surface() {
        for logout_during_open in [false, true] {
            let mut fixture = Fixture::new(Duration::from_millis(if logout_during_open {
                300
            } else {
                30
            }))
            .await;
            *fixture.browser_delay.lock().unwrap() = Duration::from_millis(100);
            let token = fixture.pair_token();
            let (session, csrf) = fixture.login(&token).await;
            let cookie = format!("{}={}", auth::SESSION_COOKIE, session);
            let client = reqwest::Client::new();
            let request = client
                .post(fixture.url("/api/pandacode/browser/open"))
                .header("host", "panda.test")
                .header("origin", "http://panda.test")
                .header("cookie", &cookie)
                .header("x-csrf-token", &csrf)
                .header(
                    "x-request-id",
                    if logout_during_open {
                        "browser-race-open"
                    } else {
                        "browser-timeout-open"
                    },
                )
                .json(&json!({"url":"https://example.test/"}));
            let open = tokio::spawn(async move { request.send().await.unwrap() });
            assert_eq!(fixture.browser_calls.recv().await, Some("open"));
            if logout_during_open {
                let logout = client
                    .delete(fixture.url("/api/pandacode/session"))
                    .header("host", "panda.test")
                    .header("origin", "http://panda.test")
                    .header("cookie", &cookie)
                    .header("x-csrf-token", &csrf)
                    .send()
                    .await
                    .unwrap();
                assert_eq!(logout.status(), StatusCode::NO_CONTENT);
            }
            let response = open.await.unwrap();
            assert_eq!(
                response.status(),
                if logout_during_open {
                    StatusCode::FORBIDDEN
                } else {
                    StatusCode::GATEWAY_TIMEOUT
                }
            );
            assert_eq!(
                tokio::time::timeout(Duration::from_secs(1), fixture.browser_calls.recv())
                    .await
                    .unwrap(),
                Some("close")
            );
            assert!(super::super::lock(&fixture.gateway.browsers)
                .release_session(&session)
                .is_empty());
        }
    }

    #[test]
    fn browser_csp_keeps_script_nonce_and_removes_native_transports() {
        let (sender, _) = mpsc::unbounded_channel();
        let gateway = Gateway::with_broker(
            Config {
                enabled: true,
                port: 0,
                origin: "https://panda.example.test".into(),
                host: "panda.example.test".into(),
                root_specs: Vec::new(),
            },
            Arc::new(FixtureBroker {
                commands: sender,
                terminal_closes: mpsc::unbounded_channel().0,
                document_root: None,
                browser_calls: mpsc::unbounded_channel().0,
                browser_delay: Arc::new(std::sync::Mutex::new(Duration::ZERO)),
                browser_lifecycle: Arc::new(tokio::sync::Mutex::new(())),
            }),
            Duration::from_secs(1),
            Duration::from_secs(1),
        );
        let csp = browser_csp(
            &gateway,
            Some("default-src 'self'; script-src 'self' 'nonce-abc'; img-src 'self' asset: http://asset.localhost; connect-src ipc: http://ipc.localhost; object-src 'none'"),
        )
        .unwrap();
        assert!(csp.contains("script-src 'self' 'nonce-abc'"));
        assert!(csp.contains("connect-src 'self' wss://panda.example.test"));
        assert!(csp.contains("img-src 'self' data:"));
        assert!(csp.contains("frame-ancestors 'none'"));
        assert!(!csp.contains("ipc:"));
        assert!(!csp.contains("asset:"));
        assert!(!csp.contains("ipc.localhost"));
    }
}
