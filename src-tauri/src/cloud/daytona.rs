//! Daytona sandboxes: create, list, start, stop and delete through the Daytona API, and
//! run commands and computer use through each sandbox's toolbox. Sandboxes PandaCode
//! creates are labelled and stop on their own after `AUTO_STOP` idle minutes.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
    time::Duration,
};

use super::{http, Machine};
use crate::vm::screen::{self, Action};

pub const DEFAULT_API: &str = "https://app.daytona.io/api";
const SERVICE: &str = "Daytona";
/// Daytona stops an unused sandbox after this many minutes, so idle ones cost nothing.
const AUTO_STOP: u32 = 15;

#[derive(Clone)]
pub struct Daytona {
    api: String,
    key: String,
    organization: Option<String>,
}

/// Screenshot pixels → screen pixels, per sandbox, from the last screenshot.
fn factors() -> &'static Mutex<HashMap<String, f64>> {
    static FACTORS: OnceLock<Mutex<HashMap<String, f64>>> = OnceLock::new();
    FACTORS.get_or_init(Default::default)
}

fn machine(sandbox: &Value) -> Machine {
    let id = sandbox["id"].as_str().unwrap_or_default();
    let state = match sandbox["state"].as_str().unwrap_or("unknown") {
        "started" => "running",
        "stopped" | "archived" => "stopped",
        "starting" | "creating" | "restoring" | "pulling_snapshot" | "building_snapshot" => "starting",
        "stopping" | "archiving" | "destroying" => "stopping",
        "error" | "build_failed" => "error",
        other => other,
    };
    let resources = format!("{} CPU · {} GB", sandbox["cpu"].as_u64().unwrap_or(0), sandbox["memory"].as_u64().unwrap_or(0));
    Machine {
        id: format!("daytona:{id}"),
        provider: "daytona".into(),
        name: sandbox["name"].as_str().filter(|n| !n.is_empty()).unwrap_or(id).to_string(),
        state: state.into(),
        os: "linux".into(),
        desktop: true,
        detail: format!("Daytona · {resources}"),
    }
}

/// Our key names → the X11 names Daytona's toolbox expects.
pub fn key_name(key: &str) -> String {
    let lower = key.trim().to_lowercase();
    match lower.as_str() {
        "return" | "enter" => "Return".into(),
        "escape" | "esc" => "Escape".into(),
        "backspace" => "BackSpace".into(),
        "tab" => "Tab".into(),
        "space" => "space".into(),
        "delete" | "del" => "Delete".into(),
        "home" => "Home".into(),
        "end" => "End".into(),
        "pageup" | "page_up" => "Page_Up".into(),
        "pagedown" | "page_down" => "Page_Down".into(),
        "left" | "right" | "up" | "down" => format!("{}{}", lower[..1].to_uppercase(), &lower[1..]),
        "cmd" | "command" | "win" | "meta" => "super".into(),
        "control" => "ctrl".into(),
        "option" | "opt" => "alt".into(),
        _ if lower.len() > 1 && lower.starts_with('f') && lower[1..].parse::<u8>().is_ok() => lower.to_uppercase(),
        _ => key.trim().to_string(),
    }
}

impl Daytona {
    pub fn new(api: Option<String>, key: String, organization: Option<String>) -> Self {
        Daytona { api: api.filter(|a| !a.trim().is_empty()).unwrap_or_else(|| DEFAULT_API.into()).trim_end_matches('/').to_string(), key, organization }
    }
    /// From Settings → Cloud.
    pub fn connected() -> Result<Self, String> {
        let key = super::secret("daytona_key").ok_or("Connect Daytona in Settings → Cloud first.")?;
        let settings = super::settings();
        Ok(Daytona::new(settings.daytona_api_url, key, settings.daytona_organization))
    }

    fn request(&self, client: &reqwest::Client, method: reqwest::Method, url: &str) -> reqwest::RequestBuilder {
        let request = client.request(method, url).bearer_auth(&self.key);
        match &self.organization {
            Some(organization) => request.header("X-Daytona-Organization-ID", organization),
            None => request,
        }
    }
    async fn call(&self, method: reqwest::Method, url: &str, body: Option<Value>, timeout: Duration) -> Result<Value, String> {
        let client = http::client(timeout)?;
        let request = self.request(&client, method, url);
        http::send(SERVICE, match body { Some(body) => request.json(&body), None => request }).await
    }
    async fn api(&self, method: reqwest::Method, path: &str, body: Option<Value>) -> Result<Value, String> {
        self.call(method, &format!("{}{path}", self.api), body, Duration::from_secs(60)).await
    }

    pub async fn list(&self) -> Result<Vec<Machine>, String> {
        let page = self.api(reqwest::Method::GET, "/sandbox?limit=100", None).await?;
        let items = page["items"].as_array().or(page.as_array()).cloned().unwrap_or_default();
        Ok(items.iter().map(machine).collect())
    }
    pub async fn create(&self, name: &str) -> Result<Machine, String> {
        let body = json!({"name": name, "labels": {"pandacode": "true"}, "autoStopInterval": AUTO_STOP});
        Ok(machine(&self.api(reqwest::Method::POST, "/sandbox", Some(body)).await?))
    }
    pub async fn power(&self, id: &str, action: &str) -> Result<(), String> {
        let (method, path) = match action {
            "start" => (reqwest::Method::POST, format!("/sandbox/{id}/start")),
            "stop" => (reqwest::Method::POST, format!("/sandbox/{id}/stop")),
            "delete" => (reqwest::Method::DELETE, format!("/sandbox/{id}")),
            _ => return Err(format!("Daytona sandboxes can start, stop or be deleted, not {action}.")),
        };
        self.api(method, &path, None).await.map(|_| ())
    }

    /// Minutes of inactivity before Daytona stops the sandbox; 0 turns auto-stop off.
    pub async fn auto_stop(&self, id: &str, minutes: u32) -> Result<(), String> {
        self.api(reqwest::Method::POST, &format!("/sandbox/{id}/autostop/{minutes}"), None).await.map(|_| ())
    }

    async fn toolbox(&self, id: &str) -> Result<String, String> {
        let sandbox = self.api(reqwest::Method::GET, &format!("/sandbox/{id}"), None).await?;
        if sandbox["state"].as_str().is_some_and(|s| s != "started") {
            return Err(format!("This Daytona sandbox is {}. Start it first.", sandbox["state"].as_str().unwrap_or("not running")));
        }
        let proxy = sandbox["toolboxProxyUrl"].as_str().filter(|u| !u.is_empty()).ok_or("Daytona did not report a toolbox address for this sandbox.")?;
        Ok(format!("{}/{id}", proxy.trim_end_matches('/')))
    }

    pub async fn exec(&self, id: &str, command: &str, timeout: Duration) -> Result<(Option<i32>, String), String> {
        let toolbox = self.toolbox(id).await?;
        let body = json!({"command": format!("sh -c {}", super::shell_quote(command)), "timeout": timeout.as_secs()});
        let result = self.call(reqwest::Method::POST, &format!("{toolbox}/process/execute"), Some(body), timeout + Duration::from_secs(15)).await?;
        Ok((result["exitCode"].as_i64().map(|code| code as i32), result["result"].as_str().unwrap_or_default().to_string()))
    }

    /// The desktop as JPEG, at most 1280 pixels wide. Starts the desktop on first use.
    pub async fn screenshot(&self, id: &str) -> Result<screen::Shot, String> {
        let toolbox = self.toolbox(id).await?;
        let url = format!("{toolbox}/computeruse/screenshot/compressed?format=jpeg&quality=75");
        let response = match self.call(reqwest::Method::GET, &url, None, Duration::from_secs(30)).await {
            Ok(response) => response,
            Err(_) => {
                self.call(reqwest::Method::POST, &format!("{toolbox}/computeruse/start"), None, Duration::from_secs(60)).await?;
                tokio::time::sleep(Duration::from_secs(3)).await;
                self.call(reqwest::Method::GET, &url, None, Duration::from_secs(30)).await?
            }
        };
        let data = response["screenshot"].as_str().ok_or("Daytona sent no screenshot.")?;
        let bytes = STANDARD.decode(data.split_once(",").map_or(data, |(_, b)| b)).map_err(|_| "Daytona sent an unreadable screenshot.")?;
        let image = image::load_from_memory(&bytes).map_err(|_| "Daytona sent an unreadable screenshot.")?;
        let (screen_width, screen_height) = (image.width(), image.height());
        let (width, height, factor) = screen::scaled(screen_width, screen_height);
        factors().lock().map_err(|_| "Screen state is unavailable.")?.insert(id.to_string(), factor);
        let jpeg = if factor == 1.0 { bytes } else {
            let mut out = Vec::new();
            image.resize_exact(width, height, image::imageops::FilterType::Triangle).to_rgb8()
                .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Jpeg).map_err(|e| e.to_string())?;
            out
        };
        Ok(screen::Shot { jpeg, width, height, screen_width, screen_height })
    }

    pub async fn act(&self, id: &str, action: &Action) -> Result<String, String> {
        let toolbox = self.toolbox(id).await?;
        let factor = factors().lock().ok().and_then(|f| f.get(id).copied()).unwrap_or(1.0);
        let at = |v: f64| (v * factor).round() as i64;
        let (path, body, report) = match action {
            Action::Click { x, y, button, count } => ("mouse/click", json!({"x": at(*x), "y": at(*y), "button": match button { 2 => "middle", 3 => "right", _ => "left" }, "double": *count == 2}), format!("Clicked at ({x}, {y}).")),
            Action::Move { x, y } => ("mouse/move", json!({"x": at(*x), "y": at(*y)}), format!("Moved the pointer to ({x}, {y}).")),
            Action::Drag { x, y, end_x, end_y } => ("mouse/drag", json!({"startX": at(*x), "startY": at(*y), "endX": at(*end_x), "endY": at(*end_y), "button": "left"}), format!("Dragged from ({x}, {y}) to ({end_x}, {end_y}).")),
            Action::Scroll { x, y, direction, amount } => ("mouse/scroll", json!({"x": at(*x), "y": at(*y), "direction": direction, "amount": (*amount).clamp(1, 30)}), format!("Scrolled {direction} {amount} at ({x}, {y}).")),
            Action::Type { text } => ("keyboard/type", json!({"text": text}), format!("Typed {} characters.", text.chars().count())),
            Action::Key { keys } if keys.contains('+') && keys.trim() != "+" => ("keyboard/hotkey", json!({"keys": keys.split('+').map(key_name).collect::<Vec<_>>().join("+")}), format!("Pressed {keys}.")),
            Action::Key { keys } => ("keyboard/key", json!({"key": key_name(keys)}), format!("Pressed {keys}.")),
        };
        self.call(reqwest::Method::POST, &format!("{toolbox}/computeruse/{path}"), Some(body), Duration::from_secs(30)).await?;
        Ok(report)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud::http::mock;

    /// A Daytona API and toolbox in one loopback server.
    fn daytona() -> (Daytona, mock::Seen) {
        let (base, seen) = mock::serve(|request, base| match (request.method.as_str(), request.path.as_str()) {
            ("GET", "/api/sandbox?limit=100") => (200, r#"{"items":[{"id":"sb1","name":"pandacode-sandbox","state":"started","cpu":1,"memory":1},{"id":"sb2","name":"","state":"archived","cpu":2,"memory":4}]}"#.into()),
            ("POST", "/api/sandbox") => (200, r#"{"id":"sb3","name":"new","state":"creating","cpu":1,"memory":1}"#.into()),
            ("POST", "/api/sandbox/sb1/stop") => (200, String::new()),
            ("GET", "/api/sandbox/sb1") => (200, format!(r#"{{"id":"sb1","state":"started","toolboxProxyUrl":"{base}/toolbox/"}}"#)),
            ("GET", "/api/sandbox/sb2") => (200, r#"{"id":"sb2","state":"stopped","toolboxProxyUrl":"x"}"#.into()),
            ("POST", "/toolbox/sb1/process/execute") => (200, r#"{"exitCode":3,"result":"42\n"}"#.into()),
            ("POST", path) if path.starts_with("/toolbox/sb1/computeruse/") => (200, "{}".into()),
            ("GET", "/api/sandbox/missing") => (404, r#"{"message":"Sandbox not found"}"#.into()),
            _ => (500, r#"{"message":"unexpected"}"#.into()),
        });
        (Daytona::new(Some(format!("{base}/api/")), "key-123".into(), Some("org-9".into())), seen)
    }

    #[tokio::test]
    async fn lists_creates_and_stops_with_the_key_and_organization() {
        let (api, seen) = daytona();
        let machines = api.list().await.unwrap();
        assert_eq!(machines.iter().map(|m| (m.id.as_str(), m.name.as_str(), m.state.as_str())).collect::<Vec<_>>(), vec![("daytona:sb1", "pandacode-sandbox", "running"), ("daytona:sb2", "sb2", "stopped")]);
        assert!(machines[0].desktop && machines[0].detail.contains("1 CPU"));
        let created = api.create("new").await.unwrap();
        assert_eq!((created.id.as_str(), created.state.as_str()), ("daytona:sb3", "starting"));
        api.power("sb1", "stop").await.unwrap();
        assert!(api.power("sb1", "suspend").await.is_err());
        let log = seen.lock().unwrap();
        assert!(log.iter().all(|r| r.authorization.as_deref() == Some("Bearer key-123")));
        assert!(log.iter().all(|r| r.headers.iter().any(|(n, v)| n == "x-daytona-organization-id" && v == "org-9")));
        let body: Value = serde_json::from_str(&log[1].body).unwrap();
        assert_eq!(body, json!({"name":"new","labels":{"pandacode":"true"},"autoStopInterval":15}));
    }

    #[tokio::test]
    async fn auto_stop_posts_the_interval_in_minutes() {
        let (base, seen) = mock::serve(|_, _| (200, r#"{"id":"sb1"}"#));
        let api = Daytona::new(Some(format!("{base}/api")), "k".into(), None);
        api.auto_stop("sb1", 90).await.unwrap();
        api.auto_stop("sb1", 0).await.unwrap();
        let log = seen.lock().unwrap();
        assert_eq!(log.iter().map(|r| (r.method.as_str(), r.path.as_str())).collect::<Vec<_>>(), vec![("POST", "/api/sandbox/sb1/autostop/90"), ("POST", "/api/sandbox/sb1/autostop/0")]);
    }

    #[tokio::test]
    async fn runs_commands_through_a_shell_and_drives_the_desktop() {
        let (api, seen) = daytona();
        assert_eq!(api.exec("sb1", "echo $((6*7))", Duration::from_secs(9)).await.unwrap(), (Some(3), "42\n".to_string()));
        api.act("sb1", &Action::Click { x: 10.0, y: 20.0, button: 3, count: 1 }).await.unwrap();
        api.act("sb1", &Action::Key { keys: "ctrl+shift+t".into() }).await.unwrap();
        api.act("sb1", &Action::Key { keys: "Return".into() }).await.unwrap();
        let log = seen.lock().unwrap();
        let posts: Vec<(&str, Value)> = log.iter().filter(|r| r.path.starts_with("/toolbox/")).map(|r| (r.path.as_str(), serde_json::from_str(&r.body).unwrap())).collect();
        assert_eq!(posts[0], ("/toolbox/sb1/process/execute", json!({"command":"sh -c 'echo $((6*7))'","timeout":9})));
        assert_eq!(posts[1], ("/toolbox/sb1/computeruse/mouse/click", json!({"x":10,"y":20,"button":"right","double":false})));
        assert_eq!(posts[2], ("/toolbox/sb1/computeruse/keyboard/hotkey", json!({"keys":"ctrl+shift+t"})));
        assert_eq!(posts[3], ("/toolbox/sb1/computeruse/keyboard/key", json!({"key":"Return"})));
    }

    #[tokio::test]
    async fn stopped_sandboxes_and_api_errors_explain_themselves() {
        let (api, _) = daytona();
        assert!(api.exec("sb2", "ls", Duration::from_secs(5)).await.unwrap_err().contains("stopped. Start it first"));
        assert_eq!(api.exec("missing", "ls", Duration::from_secs(5)).await.unwrap_err(), "Daytona: Sandbox not found");
    }

    #[test]
    fn maps_keys_to_x11_names() {
        assert_eq!(key_name("return"), "Return");
        assert_eq!(key_name("pagedown"), "Page_Down");
        assert_eq!(key_name("left"), "Left");
        assert_eq!(key_name("f5"), "F5");
        assert_eq!(key_name("cmd"), "super");
        assert_eq!(key_name("c"), "c");
    }
}
