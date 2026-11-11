//! PandaConnect methods for the computer's settings: harness readiness, model routing, the
//! token saver's tools, a checkout's jj status and the project's moodboards. Read-only except
//! the routing switch (Full) and `moodboards.add` (Full and the host's Full access switch: an
//! image uploaded with `image.put`, claimed like `task.send` claims one). Nothing here returns keys, tokens, environment values or paths
//! beyond an executable's file name; installing or updating harnesses and editing keys stay on
//! the computer. See `methods/mod.rs` and docs/remote-access.md, "Registry methods".
use super::files::{data_page, offset_param, resolve, split_data_url, target_param, Target};
use super::{id_param, Access, Ctx, Method, Reply, Run, PAGE_BUDGET};
use crate::Result;
use serde_json::{json, Value};
use std::path::Path;
use std::time::Duration;
use base64::Engine;
use tauri::{Emitter, Manager};

/// How long `settings.providers` waits for the (usually cached) agent update check.
const UPDATE_WAIT: Duration = Duration::from_secs(8);
/// Longest version text passed through (versions are short; anything longer is noise).
const MAX_VERSION: usize = 64;
/// Harnesses that run on an API key saved in Settings → Providers (or its environment variable).
const KEYED: [&str; 4] = ["glm", "mimo", "deepseek", "commandcode"];

fn short(text: &str) -> String {
    text.trim().chars().take(MAX_VERSION).collect()
}

/// The executable's file name, never the folder it lives in.
fn executable_name(path: Option<&str>) -> Option<String> {
    Path::new(path?).file_name().map(|name| name.to_string_lossy().into_owned())
}

/// Whether a harness can run: `missing`, `ready`, `needsKey` (a keyed harness without one),
/// `signedOut` (Claude without a login) or `installed` (installed, sign-in not checkable here).
/// `keys` is the serialized provider configuration (only its `*KeySaved` booleans are read);
/// `claude` the serialized Claude status.
fn readiness(id: &str, installed: bool, keys: &Value, claude: &Value) -> &'static str {
    if !installed {
        return "missing";
    }
    if KEYED.contains(&id) {
        if keys.is_null() {
            return "installed";
        }
        let set = |suffix: &str| keys[format!("{id}{suffix}")].as_bool() == Some(true);
        return if set("KeySaved") || set("KeyFromEnvironment") { "ready" } else { "needsKey" };
    }
    if id == "claude" {
        if claude["environmentVariables"].as_array().is_some_and(|vars| !vars.is_empty()) {
            return "ready";
        }
        return match claude["savedLogin"].as_str() {
            Some("signedIn" | "otherCredentials") => "ready",
            Some("notSignedIn") => "signedOut",
            _ => "installed",
        };
    }
    "installed"
}

/// One harness row: only what the phone shows.
fn provider_row(info: &crate::providers::ProviderInfo, readiness: &str, update: Option<&crate::agent_updates::AgentUpdate>) -> Value {
    json!({
        "id": info.id,
        "name": info.name,
        "installed": info.installed,
        "executable": executable_name(info.path.as_deref()),
        "version": short(&info.version),
        "models": info.models.len(),
        "status": readiness,
        "update": update.map(|u| json!({
            "status": u.status,
            "latest": u.latest_version.as_deref().map(short),
            "canUpdate": u.can_update,
        })),
    })
}

/// The desktop's cached agent update check; empty when there is no main window or it is slow.
async fn agent_updates(app: &tauri::AppHandle) -> Vec<crate::agent_updates::AgentUpdate> {
    let Some(window) = app.get_webview_window("main") else { return Vec::new() };
    match tokio::time::timeout(UPDATE_WAIT, crate::agent_updates::check_agent_updates(window, Some(false))).await {
        Ok(Ok(rows)) => rows,
        _ => Vec::new(),
    }
}

// ---- settings.providers ----

#[derive(Debug, PartialEq)]
struct Providers;

impl Run for Providers {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let list = crate::local_providers(false).await;
            let keys = crate::provider_settings::provider_configuration().await.ok().and_then(|c| serde_json::to_value(c).ok()).unwrap_or(Value::Null);
            let claude = if list.iter().any(|p| p.id == "claude" && p.installed) {
                crate::providers::claude_auth::provider_claude_status().await.ok().and_then(|s| serde_json::to_value(s).ok()).unwrap_or(Value::Null)
            } else {
                Value::Null
            };
            let updates = agent_updates(ctx.app).await;
            let rows: Vec<Value> = list
                .iter()
                .map(|p| {
                    let update = updates.iter().find(|u| u.providers.contains(&p.id));
                    provider_row(p, readiness(&p.id, p.installed, &keys, &claude), update)
                })
                .collect();
            Ok(json!({"providers": rows}))
        })
    }
}

// ---- settings.routing / settings.setRouting ----

fn routing_reply(status: crate::model_routing::RoutingStatus) -> Value {
    // `error` can name folders on the computer: only say that preparing failed.
    json!({"on": status.enabled, "mode": status.mode, "profiler": status.profiler, "failed": status.error.is_some()})
}

#[derive(Debug, PartialEq)]
struct Routing;

impl Run for Routing {
    fn run<'a>(self: Box<Self>, _ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move { Ok(routing_reply(crate::model_routing::model_routing_status()?)) })
    }
}

#[derive(Debug, PartialEq)]
struct SetRouting {
    on: bool,
}

impl Run for SetRouting {
    fn run<'a>(self: Box<Self>, _ctx: Ctx<'a>) -> Reply<'a> {
        // Only the switch: the router's files download on the computer when a team first uses it.
        Box::pin(async move { Ok(routing_reply(crate::model_routing::model_routing_configure(Some(self.on), None, None)?)) })
    }
}

// ---- settings.tokenSaver ----

#[derive(Debug, PartialEq)]
struct TokenSaver;

impl Run for TokenSaver {
    fn run<'a>(self: Box<Self>, _ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            // Detection only: installing RTK runs Homebrew, which stays a desktop action.
            let tools = crate::token_saver::token_saver_tools().await?;
            Ok(json!({"rtk": tools.rtk, "rtkVersion": short(&tools.rtk_version)}))
        })
    }
}

// ---- settings.jj ----

#[derive(Debug, PartialEq)]
struct Jj {
    target: Target,
}

impl Run for Jj {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let (_, root) = resolve(&ctx.state(), &self.target).await?;
            // With the switch off jj must not snapshot, sign or read a parent folder's repo.
            let full_access = ctx.full_access;
            let status = crate::blocking(move || if full_access { crate::jj::status(&root) } else { crate::jj::status_untrusted(&root) }).await?;
            let mut reply = serde_json::to_value(status).map_err(|e| e.to_string())?;
            let mut truncated = false;
            if let Some(files) = reply.get_mut("files").and_then(Value::as_array_mut) {
                while !files.is_empty() && json!({ "files": &*files }).to_string().len() > PAGE_BUDGET - 4096 {
                    files.pop();
                    truncated = true;
                }
            }
            reply["truncated"] = json!(truncated);
            Ok(reply)
        })
    }
}

// ---- moodboards.list / moodboards.image ----

#[derive(Debug, PartialEq)]
struct Moodboards {
    target: Target,
}

impl Run for Moodboards {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let state = ctx.state();
            let (project_id, _) = resolve(&state, &self.target).await?;
            let store = state.store.clone();
            let boards = crate::blocking(move || {
                let store = store.lock().map_err(|e| e.to_string())?;
                crate::moodboards::list(&store, &project_id)?
                    .into_iter()
                    .map(|board| crate::moodboards::detail(&store, &project_id, &board.id))
                    .collect::<Result<Vec<_>>>()
            })
            .await?;
            let mut list: Vec<Value> = boards.into_iter().filter_map(|b| serde_json::to_value(b).ok()).collect();
            let mut truncated = false;
            while !list.is_empty() && json!({ "boards": &list }).to_string().len() > PAGE_BUDGET - 1024 {
                list.pop();
                truncated = true;
            }
            Ok(json!({"boards": list, "truncated": truncated}))
        })
    }
}

#[derive(Debug, PartialEq)]
struct MoodboardImage {
    target: Target,
    board_id: String,
    image_id: String,
    full: bool,
    offset: usize,
}

impl Run for MoodboardImage {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let (project_id, _) = resolve(&ctx.state(), &self.target).await?;
            // The board must belong to the project: moodboards.rs checks membership in one query.
            let image = crate::moodboards::moodboard_image(ctx.state(), project_id, self.board_id, self.image_id, Some(!self.full)).await?;
            let (mime, data) = split_data_url(&image.data_url)?;
            data_page(mime, data, self.offset)
        })
    }
}

// ---- moodboards.add ----

/// Longest image name `moodboards.add` keeps (the desktop's own label limit is larger).
const MAX_IMAGE_NAME: usize = 120;
/// The name an image from the phone gets when it sends none.
const PHONE_IMAGE_NAME: &str = "Image from phone.png";

#[derive(Debug, PartialEq)]
struct MoodboardAdd {
    project_id: String,
    board_id: String,
    image_id: String,
    name: String,
    /// A retry with the same id answers the first add (`once_per_action`), not "image missing":
    /// the first add spent the upload.
    send_id: Option<String>,
}

impl Run for MoodboardAdd {
    fn run<'a>(self: Box<Self>, ctx: Ctx<'a>) -> Reply<'a> {
        Box::pin(async move {
            let target = super::moodboard_add_target(&self.project_id, &self.board_id, &self.image_id);
            let send_id = self.send_id.clone();
            super::once_per_action(ctx.from, "moodboards.add", &target, send_id.as_deref(), add_moodboard_image(ctx, *self)).await
        })
    }
}

/// `moodboards.add` itself.
async fn add_moodboard_image(ctx: Ctx<'_>, this: MoodboardAdd) -> Result<Value> {
    // It adds to what the project's agents read as references: the switch, as for a full task.
    if !ctx.full_access {
        return Err(super::full_access_off());
    }
    let MoodboardAdd { project_id, board_id, image_id, name, .. } = this;
    let (project_id, _) = resolve(&ctx.state(), &Target::Project(project_id)).await?;
    let dir = ctx.app.path().app_cache_dir().map_err(|e| e.to_string())?.join("browser-captures");
    // Only an image this phone just sent with `image.put`; it is now the board's.
    let ids = vec![image_id.clone()];
    crate::remote::images::claim(ctx.app, ctx.from, &ids)?;
    let (read_dir, id) = (dir.clone(), image_id.clone());
    let added = async {
        let data_url = crate::blocking(move || moodboard_data_url(&read_dir, &id)).await?;
        crate::moodboards::add_moodboard_image(ctx.state(), project_id.clone(), board_id.clone(), name, data_url).await
    }
    .await;
    let detail = match added {
        Ok(detail) => detail,
        Err(error) => {
            crate::remote::images::restore(ctx.app, ctx.from, &ids);
            return Err(error);
        }
    };
    // The board keeps its own copy (app storage); the upload is spent.
    let _ = std::fs::remove_file(dir.join(format!("{}.png", image_id)));
    let _ = ctx.app.emit("moodboards-changed", json!({"projectId": project_id, "boardId": board_id}));
    let mut board = serde_json::to_value(detail).map_err(|e| e.to_string())?;
    if let Some(images) = board.get_mut("images").and_then(Value::as_array_mut) {
        while !images.is_empty() && json!({ "board": &*images }).to_string().len() > PAGE_BUDGET - 4096 {
            images.remove(0);
        }
    }
    Ok(json!({"board": board}))
}

/// A claimed upload as the data URL `add_moodboard_image` takes (uploads are PNG).
fn moodboard_data_url(dir: &Path, id: &str) -> Result<String> {
    let bytes = crate::remote::images::read_capture(dir, id)?;
    let kind = crate::remote::images::kind(&bytes).ok_or("Only PNG, JPEG and WebP images can be added to a moodboard.")?;
    Ok(format!("data:image/{kind};base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes)))
}

/// An image name for a board: a plain file name (no folders, `..`, leading dot or control
/// characters), or [`PHONE_IMAGE_NAME`] when none is sent.
fn image_name_param(p: &Value) -> Result<String> {
    let Some(value) = p.get("name").filter(|v| !v.is_null()) else { return Ok(PHONE_IMAGE_NAME.into()) };
    let name = value.as_str().ok_or("Invalid name.")?.trim();
    if name.is_empty() {
        return Ok(PHONE_IMAGE_NAME.into());
    }
    let bad = name.len() > MAX_IMAGE_NAME || name.starts_with('.') || name.contains(['/', '\\', ':']) || name.contains("..") || name.chars().any(char::is_control);
    if bad {
        return Err("Use a plain image name without folders.".into());
    }
    Ok(name.to_owned())
}

fn parse_moodboard_add(p: &Value) -> Result<Box<dyn Run>> {
    let image_id = p.get("imageId").and_then(Value::as_str).filter(|id| crate::remote::images::valid_image_id(id)).ok_or("Invalid imageId.")?.to_owned();
    // A board id as moodboards.rs makes it: letters, digits, `-` and `_` only (no path tricks).
    let board_id = id_param(p, "board")?;
    if !board_id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
        return Err("Invalid board.".into());
    }
    Ok(Box::new(MoodboardAdd { project_id: id_param(p, "projectId")?, board_id, image_id, name: image_name_param(p)?, send_id: super::send_id_param(p)? }))
}

// ---- parsing ----

fn on_param(p: &Value) -> Result<bool> {
    p.get("on").and_then(Value::as_bool).ok_or_else(|| "Missing on.".into())
}

fn parse_moodboard_image(p: &Value) -> Result<Box<dyn Run>> {
    let full = match p.get("full").filter(|v| !v.is_null()) {
        None => false,
        Some(v) => v.as_bool().ok_or("Invalid full.")?,
    };
    Ok(Box::new(MoodboardImage { target: target_param(p)?, board_id: id_param(p, "boardId")?, image_id: id_param(p, "imageId")?, full, offset: offset_param(p)? }))
}

pub(crate) const METHODS: &[Method] = &[
    Method { name: "settings.providers", access: Access::View, read_only: true, parse: |_| Ok(Box::new(Providers)) },
    Method { name: "settings.routing", access: Access::View, read_only: true, parse: |_| Ok(Box::new(Routing)) },
    // Routing changes how every team on the computer picks models: Full only.
    Method { name: "settings.setRouting", access: Access::Full, read_only: false, parse: |p| Ok(Box::new(SetRouting { on: on_param(p)? })) },
    Method { name: "settings.tokenSaver", access: Access::View, read_only: true, parse: |_| Ok(Box::new(TokenSaver)) },
    Method { name: "settings.jj", access: Access::View, read_only: true, parse: |p| Ok(Box::new(Jj { target: target_param(p)? })) },
    Method { name: "moodboards.list", access: Access::View, read_only: true, parse: |p| Ok(Box::new(Moodboards { target: target_param(p)? })) },
    Method { name: "moodboards.image", access: Access::View, read_only: true, parse: parse_moodboard_image },
    // Adds an image the project's agents read as a reference: Full, and the host's switch.
    Method { name: "moodboards.add", access: Access::Full, read_only: false, parse: parse_moodboard_add },
];

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::{ModelInfo, ProviderInfo};

    fn parse(name: &str, params: Value) -> Result<Box<dyn Run>> {
        (super::super::find(name).unwrap().parse)(&params)
    }

    fn info(id: &str, path: Option<&str>) -> ProviderInfo {
        let model = ModelInfo { id: "m".into(), name: "M".into(), description: String::new(), reasoning_efforts: Vec::new(), default_reasoning_effort: None, context_window: None };
        ProviderInfo { id: id.into(), name: "Codex".into(), installed: path.is_some(), path: path.map(Into::into), version: "1.2.3".into(), models: vec![model.clone(), model] }
    }

    #[test]
    fn provider_rows_carry_no_paths_keys_or_environment() {
        let row = provider_row(&info("codex", Some("/Users/someone/.secret-dir/bin/codex")), "installed", None);
        assert_eq!(row["executable"], "codex");
        assert_eq!(row["models"], 2);
        assert_eq!(row["version"], "1.2.3");
        let text = row.to_string();
        assert!(!text.contains("/Users") && !text.contains("secret-dir"), "{text}");
        let keys: Vec<&str> = row.as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(keys.len(), 8);
        for key in keys {
            assert!(["id", "name", "installed", "executable", "version", "models", "status", "update"].contains(&key), "{key}");
        }
        assert!(provider_row(&info("codex", None), "missing", None)["executable"].is_null());
        assert_eq!(short(&"9".repeat(500)).len(), MAX_VERSION);
    }

    #[test]
    fn readiness_reads_only_booleans_and_login_state() {
        let keys = json!({"glmKeySaved": true, "mimoKeySaved": false, "mimoKeyFromEnvironment": true, "deepseekKeySaved": false, "environment": {"x": ["SECRET"]}});
        assert_eq!(readiness("glm", true, &keys, &Value::Null), "ready");
        assert_eq!(readiness("mimo", true, &keys, &Value::Null), "ready");
        assert_eq!(readiness("deepseek", true, &keys, &Value::Null), "needsKey");
        assert_eq!(readiness("commandcode", true, &Value::Null, &Value::Null), "installed");
        assert_eq!(readiness("codex", false, &keys, &Value::Null), "missing");
        assert_eq!(readiness("codex", true, &keys, &Value::Null), "installed");
        assert_eq!(readiness("claude", true, &keys, &json!({"savedLogin": "signedIn", "environmentVariables": []})), "ready");
        assert_eq!(readiness("claude", true, &keys, &json!({"savedLogin": "notSignedIn", "environmentVariables": []})), "signedOut");
        assert_eq!(readiness("claude", true, &keys, &json!({"savedLogin": "notSignedIn", "environmentVariables": ["ANTHROPIC_API_KEY"]})), "ready");
        assert_eq!(readiness("claude", true, &keys, &Value::Null), "installed");
    }

    #[test]
    fn routing_replies_hide_error_text() {
        let status = crate::model_routing::RoutingStatus { enabled: true, mode: crate::panda_router::Mode::Balanced, min_p: 0.5, profiler: "failed", error: Some("Could not create /Users/someone/x".into()) };
        let reply = routing_reply(status);
        assert_eq!(reply["on"], true);
        assert_eq!(reply["failed"], true);
        assert!(!reply.to_string().contains("/Users"));
    }

    #[test]
    fn scopes_and_params() {
        for name in ["settings.providers", "settings.routing", "settings.tokenSaver", "settings.jj", "moodboards.list", "moodboards.image"] {
            let method = super::super::find(name).unwrap();
            assert_eq!(method.access, Access::View, "{name}");
            assert!(method.read_only, "{name}");
        }
        let set = super::super::find("settings.setRouting").unwrap();
        assert_eq!(set.access, Access::Full);
        assert!(!set.read_only);
        assert!(super::super::find("settings.setTokenSaver").is_none(), "the token saver's switch lives in the desktop window");
        assert!(parse("settings.setRouting", json!({"on": true})).is_ok());
        for bad in [json!({}), json!({"on": "yes"}), json!({"on": 1})] {
            assert!(parse("settings.setRouting", bad).is_err());
        }
        assert!(parse("settings.jj", json!({})).is_err());
        assert!(parse("settings.jj", json!({"projectId": "p1"})).is_ok());
        // Round 8: moodboards.add takes one uploaded image id, a board id and a plain name.
        let image = "0b5c8a4e-3f7d-4a8e-9c1b-2d3e4f5a6b7c";
        assert!(parse("moodboards.add", json!({"projectId": "p1", "board": "b1", "imageId": image})).is_ok());
        assert!(parse("moodboards.add", json!({"projectId": "p1", "board": "b1", "imageId": image, "name": "Hero shot.png"})).is_ok());
        for bad in [
            json!({"board": "b1", "imageId": image}),
            json!({"projectId": "p1", "imageId": image}),
            json!({"projectId": "p1", "board": "../b1", "imageId": image}),
            json!({"projectId": "p1", "board": "a/b", "imageId": image}),
            json!({"projectId": "p1", "board": "b1", "imageId": "../x"}),
            json!({"projectId": "p1", "board": "b1", "imageId": image.to_uppercase()}),
            json!({"projectId": "p1", "board": "b1", "imageId": image, "name": "../x.png"}),
            json!({"projectId": "p1", "board": "b1", "imageId": image, "name": "a/b.png"}),
            json!({"projectId": "p1", "board": "b1", "imageId": image, "name": "a\\b.png"}),
            json!({"projectId": "p1", "board": "b1", "imageId": image, "name": ".hidden"}),
            json!({"projectId": "p1", "board": "b1", "imageId": image, "name": "a\nb"}),
            json!({"projectId": "p1", "board": "b1", "imageId": image, "name": 5}),
        ] {
            assert!(parse("moodboards.add", bad.clone()).is_err(), "{bad}");
        }
        assert_eq!(image_name_param(&json!({"name": "  "})).unwrap(), PHONE_IMAGE_NAME);
        let add = super::super::find("moodboards.add").unwrap();
        assert_eq!(add.access, Access::Full);
        assert!(!add.read_only);
        assert_eq!(super::super::lane_for("moodboards.add"), Some(super::super::Lane::Background));
        let source = include_str!("settings.rs");
        let body = &source[source.find("async fn add_moodboard_image(ctx").unwrap()..];
        let (switch, claim) = (body.find("if !ctx.full_access").unwrap(), body.find("images::claim(").unwrap());
        assert!(switch < claim && claim < body.find("moodboards::add_moodboard_image(").unwrap(), "the switch, then the claim, then the write");
        // Round 9: once per sendId, so a retry after a lost reply answers the first add.
        let run = &source[source.find("impl Run for MoodboardAdd").unwrap()..];
        assert!(run[..run.find("\n}\n").unwrap()].contains("once_per_action(ctx.from, \"moodboards.add\""));
        assert!(body.find("images::restore(").is_some(), "a failed add gives the upload back");
        assert!(parse("moodboards.list", json!({"sessionId": "s1"})).is_ok());
        assert!(parse("moodboards.list", json!({"projectId": ""})).is_err());
        assert!(parse("moodboards.image", json!({"projectId": "p", "boardId": "b", "imageId": "i", "offset": 8, "full": true})).is_ok());
        for bad in [json!({"projectId": "p", "boardId": "b"}), json!({"projectId": "p", "imageId": "i"}), json!({"boardId": "b", "imageId": "i"}), json!({"projectId": "p", "boardId": "b", "imageId": "i", "full": "x"}), json!({"projectId": "p", "boardId": "b c", "imageId": "i"})] {
            assert!(parse("moodboards.image", bad.clone()).is_err(), "{bad}");
        }
    }
}
