use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    future::Future,
    pin::Pin,
    time::{Duration, Instant},
};

use super::auth;

pub const FRAME_LIMIT: usize = 5 * 1024 * 1024;
pub const LEASE_TTL: Duration = Duration::from_secs(5 * 60);
const MAX_LEASES: usize = 16;
const MAX_SESSION_LEASES: usize = 2;
pub type OperationFuture<T> = Pin<Box<dyn Future<Output = Result<T, String>> + Send>>;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenRequest {
    pub url: String,
    pub task_id: Option<String>,
    pub session_id: Option<String>,
}
impl OpenRequest {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.url.is_empty() || self.url.len() > 4096 || self.url.chars().any(char::is_control) {
            return Err("valid browser URL required");
        }
        for value in [&self.task_id, &self.session_id].into_iter().flatten() {
            if value.len() > 128 || value.chars().any(char::is_control) {
                return Err("invalid browser context");
            }
        }
        Ok(())
    }
}

#[derive(Clone)]
pub struct Lease {
    pub id: String,
    pub label: String,
    pub session: String,
    expires: Instant,
}
#[derive(Default)]
pub struct BrowserLeases {
    leases: HashMap<String, Lease>,
}
pub enum Expiry {
    Missing,
    Wait(Duration),
    Expired(Lease),
}
impl BrowserLeases {
    pub fn reserve(&mut self, session: &str) -> Result<Lease, &'static str> {
        if self.leases.len() >= MAX_LEASES
            || self
                .leases
                .values()
                .filter(|v| v.session == session)
                .count()
                >= MAX_SESSION_LEASES
        {
            return Err("browser lease limit reached");
        }
        let id = format!(
            "webbrowser_{}",
            auth::random_token().map_err(|_| "secure random source unavailable")?
        );
        let lease = Lease {
            id: id.clone(),
            label: format!("web-browser-{}", uuid::Uuid::new_v4().simple()),
            session: session.into(),
            expires: Instant::now() + LEASE_TTL,
        };
        self.leases.insert(id, lease.clone());
        Ok(lease)
    }
    pub fn use_lease(&mut self, session: &str, id: &str) -> Result<(Lease, u64), &'static str> {
        let lease = self.leases.get_mut(id).ok_or("unknown browser lease")?;
        if lease.session != session {
            return Err("browser lease belongs to another session");
        }
        lease.expires = Instant::now() + LEASE_TTL;
        Ok((lease.clone(), auth::unix_seconds() + LEASE_TTL.as_secs()))
    }
    pub fn remove_id(&mut self, id: &str) {
        self.leases.remove(id);
    }
    pub fn expiry(&mut self, id: &str) -> Expiry {
        let Some(lease) = self.leases.get(id) else {
            return Expiry::Missing;
        };
        let now = Instant::now();
        if lease.expires > now {
            return Expiry::Wait(lease.expires - now);
        }
        self.leases
            .remove(id)
            .map_or(Expiry::Missing, Expiry::Expired)
    }
    pub fn release_session(&mut self, session: &str) -> Vec<Lease> {
        let ids = self
            .leases
            .values()
            .filter(|v| v.session == session)
            .map(|v| v.id.clone())
            .collect::<Vec<_>>();
        ids.into_iter()
            .filter_map(|id| self.leases.remove(&id))
            .collect()
    }
    pub fn purge_expired(&mut self) -> Vec<Lease> {
        let now = Instant::now();
        let ids = self
            .leases
            .iter()
            .filter(|(_, v)| v.expires <= now)
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        ids.into_iter()
            .filter_map(|id| self.leases.remove(&id))
            .collect()
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub url: String,
    pub title: String,
    pub loading: bool,
    pub can_go_back: bool,
    pub can_go_forward: bool,
    pub picking: bool,
    pub width: u32,
    pub height: u32,
    pub frame_sequence: u64,
}
impl From<crate::browser::BrowserStatus> for Status {
    fn from(v: crate::browser::BrowserStatus) -> Self {
        Self {
            url: v.url,
            title: v.title,
            loading: v.loading,
            can_go_back: v.can_go_back,
            can_go_forward: v.can_go_forward,
            picking: v.picking,
            width: 1280,
            height: 800,
            frame_sequence: 0,
        }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenResponse {
    pub lease: String,
    pub expires_at: u64,
    #[serde(flatten)]
    pub status: Status,
}
pub struct Frame {
    pub bytes: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub sequence: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActionRequest {
    pub action: String,
    pub url: Option<String>,
}
impl ActionRequest {
    pub fn validate(&self) -> Result<(), &'static str> {
        match self.action.as_str() {
            "navigate"
                if self
                    .url
                    .as_ref()
                    .is_some_and(|v| !v.is_empty() && v.len() <= 4096) =>
            {
                Ok(())
            }
            "back" | "forward" | "reload" | "stop" if self.url.is_none() => Ok(()),
            _ => Err("invalid browser action"),
        }
    }
}
#[derive(Debug, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum InputRequest {
    Tap {
        x: f64,
        y: f64,
    },
    Scroll {
        delta_x: f64,
        delta_y: f64,
    },
    Type {
        text: String,
    },
    Key {
        key: String,
        #[serde(default)]
        shift: bool,
    },
}
impl InputRequest {
    pub fn validate(&self) -> Result<(), &'static str> {
        match self {
            Self::Tap { x, y }
                if x.is_finite()
                    && y.is_finite()
                    && (0.0..=1.0).contains(x)
                    && (0.0..=1.0).contains(y) =>
            {
                Ok(())
            }
            Self::Scroll { delta_x, delta_y }
                if delta_x.is_finite()
                    && delta_y.is_finite()
                    && delta_x.abs() <= 2000.
                    && delta_y.abs() <= 2000. =>
            {
                Ok(())
            }
            Self::Type { text } if text.len() <= 8192 && !text.contains('\0') => Ok(()),
            Self::Key { key, shift }
                if {
                    let _ = *shift;
                    matches!(
                        key.as_str(),
                        "Enter"
                            | "Tab"
                            | "Escape"
                            | "Backspace"
                            | "Delete"
                            | "ArrowUp"
                            | "ArrowDown"
                            | "ArrowLeft"
                            | "ArrowRight"
                            | "PageUp"
                            | "PageDown"
                            | "Home"
                            | "End"
                    )
                } =>
            {
                Ok(())
            }
            _ => Err("invalid browser input"),
        }
    }
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InspectRequest {
    pub action: String,
    pub selector: Option<String>,
    pub text: Option<String>,
}
impl InspectRequest {
    pub fn validate(&self) -> Result<(), &'static str> {
        if !matches!(self.action.as_str(), "read" | "click" | "type")
            || self.selector.as_ref().is_some_and(|v| v.len() > 2048)
            || self.text.as_ref().is_some_and(|v| v.len() > 8192)
            || (self.action != "read" && self.selector.as_deref().is_none_or(str::is_empty))
        {
            Err("invalid browser inspection")
        } else {
            Ok(())
        }
    }
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PickRequest {
    pub x: f64,
    pub y: f64,
}
impl PickRequest {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.x.is_finite()
            && self.y.is_finite()
            && (0.0..=1.0).contains(&self.x)
            && (0.0..=1.0).contains(&self.y)
        {
            Ok(())
        } else {
            Err("invalid browser coordinates")
        }
    }
}

pub enum NativeRequest {
    Open {
        label: String,
        url: String,
    },
    Status {
        label: String,
    },
    Frame {
        label: String,
    },
    Action {
        label: String,
        request: ActionRequest,
    },
    Input {
        label: String,
        input: Value,
    },
    Inspect {
        label: String,
        request: InspectRequest,
    },
    Pick {
        label: String,
        x: f64,
        y: f64,
    },
    Close {
        label: String,
    },
}
pub enum NativeResponse {
    Status(crate::browser::BrowserStatus),
    Frame(crate::browser::RemoteFrame),
    Value(Value),
    Closed,
}
pub fn native(app: tauri::AppHandle, request: NativeRequest) -> OperationFuture<NativeResponse> {
    Box::pin(async move {
        match request {
            NativeRequest::Open { label, url } => crate::browser::remote_open(app, label, url)
                .await
                .map(NativeResponse::Status),
            NativeRequest::Status { label } => crate::browser::remote_status(app, label)
                .await
                .map(NativeResponse::Status),
            NativeRequest::Frame { label } => crate::browser::remote_frame(app, label)
                .await
                .map(NativeResponse::Frame),
            NativeRequest::Action { label, request } => {
                crate::browser::remote_action(app, label, request.action, request.url)
                    .await
                    .map(NativeResponse::Status)
            }
            NativeRequest::Input { label, input } => {
                crate::browser::remote_input(app, label, input)
                    .await
                    .map(NativeResponse::Status)
            }
            NativeRequest::Inspect { label, request } => crate::browser::remote_inspect(
                app,
                label,
                request.action,
                request.selector,
                request.text,
            )
            .await
            .map(NativeResponse::Value),
            NativeRequest::Pick { label, x, y } => crate::browser::remote_pick(app, label, x, y)
                .await
                .map(NativeResponse::Value),
            NativeRequest::Close { label } => crate::browser::remote_close(app, label)
                .await
                .map(|_| NativeResponse::Closed),
        }
    })
}
