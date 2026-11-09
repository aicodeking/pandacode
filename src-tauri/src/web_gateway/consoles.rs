//! Session-bound browser console leases. Raw native frame/input commands stay outside the HTTP
//! command registry; an opaque lease binds every operation to one reviewed target and viewer.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    future::Future,
    pin::Pin,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};

use super::auth;

pub const FRAME_LIMIT: usize = 8 * 1024 * 1024;
pub const LEASE_TTL: Duration = Duration::from_secs(2 * 60);
const MAX_LEASES: usize = 64;
const MAX_SESSION_LEASES: usize = 12;

pub type OperationFuture<T> = Pin<Box<dyn Future<Output = Result<T, String>> + Send>>;

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Simulator,
    Vm,
    Cloud,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenRequest {
    pub kind: Kind,
    pub target: String,
    #[serde(default = "default_control")]
    pub control: bool,
}

fn default_control() -> bool {
    true
}

impl OpenRequest {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.target.is_empty()
            || self.target.len() > 256
            || self.target.chars().any(char::is_control)
        {
            return Err("valid console target required");
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaseInfo {
    pub lease: String,
    pub controller: bool,
    pub expires_at: u64,
}

#[derive(Clone, Debug)]
pub struct Lease {
    pub id: String,
    pub session: String,
    pub kind: Kind,
    pub target: String,
    pub controller: bool,
    expires: Instant,
}

#[derive(Default)]
pub struct ConsoleLeases {
    leases: HashMap<String, Lease>,
    controllers: HashMap<(Kind, String), String>,
}

impl ConsoleLeases {
    pub fn open(
        &mut self,
        session: &str,
        request: &OpenRequest,
    ) -> Result<LeaseInfo, &'static str> {
        self.purge_expired();
        if self.leases.len() >= MAX_LEASES
            || self
                .leases
                .values()
                .filter(|lease| lease.session == session)
                .count()
                >= MAX_SESSION_LEASES
        {
            return Err("console lease limit reached");
        }
        let key = (request.kind, request.target.clone());
        if request.control && self.controllers.contains_key(&key) {
            return Err("console already has a web controller");
        }
        let id = format!(
            "webconsole_{}",
            auth::random_token().map_err(|_| "secure random source unavailable")?
        );
        let expires = Instant::now() + LEASE_TTL;
        let lease = Lease {
            id: id.clone(),
            session: session.to_owned(),
            kind: request.kind,
            target: request.target.clone(),
            controller: request.control,
            expires,
        };
        if request.control {
            self.controllers.insert(key, id.clone());
        }
        self.leases.insert(id.clone(), lease);
        Ok(LeaseInfo {
            lease: id,
            controller: request.control,
            expires_at: auth::unix_seconds().saturating_add(LEASE_TTL.as_secs()),
        })
    }

    pub fn use_lease(
        &mut self,
        session: &str,
        id: &str,
        require_control: bool,
    ) -> Result<(Lease, u64), &'static str> {
        self.purge_expired();
        let lease = self.leases.get_mut(id).ok_or("unknown console lease")?;
        if lease.session != session {
            return Err("console lease belongs to another session");
        }
        if require_control && !lease.controller {
            return Err("viewer lease cannot send input");
        }
        lease.expires = Instant::now() + LEASE_TTL;
        Ok((
            lease.clone(),
            auth::unix_seconds().saturating_add(LEASE_TTL.as_secs()),
        ))
    }

    pub fn close(&mut self, session: &str, id: &str) -> Result<(), &'static str> {
        self.purge_expired();
        let lease = self.leases.get(id).ok_or("unknown console lease")?;
        if lease.session != session {
            return Err("console lease belongs to another session");
        }
        self.remove(id);
        Ok(())
    }

    pub fn release_session(&mut self, session: &str) {
        let ids = self
            .leases
            .values()
            .filter(|lease| lease.session == session)
            .map(|lease| lease.id.clone())
            .collect::<Vec<_>>();
        for id in ids {
            self.remove(&id);
        }
    }

    fn purge_expired(&mut self) {
        let now = Instant::now();
        let ids = self
            .leases
            .values()
            .filter(|lease| lease.expires <= now)
            .map(|lease| lease.id.clone())
            .collect::<Vec<_>>();
        for id in ids {
            self.remove(&id);
        }
    }

    fn remove(&mut self, id: &str) {
        if let Some(lease) = self.leases.remove(id) {
            if lease.controller {
                let key = (lease.kind, lease.target);
                if self.controllers.get(&key).is_some_and(|owner| owner == id) {
                    self.controllers.remove(&key);
                }
            }
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InputRequest {
    pub lease: String,
    pub input: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputResult {
    pub result: String,
    pub expires_at: u64,
}

pub struct Frame {
    pub bytes: Vec<u8>,
    pub content_type: &'static str,
}

pub fn validate_input(kind: Kind, value: &Value) -> Result<(), &'static str> {
    let object = value.as_object().ok_or("console input object required")?;
    let discriminator = match kind {
        Kind::Simulator => "kind",
        Kind::Vm | Kind::Cloud => "action",
    };
    let action = object
        .get(discriminator)
        .and_then(Value::as_str)
        .ok_or("console input action required")?;
    let allowed: &[&str] = match (kind, action) {
        (Kind::Simulator, "tap") => &["kind", "x", "y"],
        (Kind::Simulator, "longPress") => &["kind", "x", "y", "durationMs"],
        (Kind::Simulator, "swipe") => &["kind", "x", "y", "endX", "endY", "durationMs"],
        (Kind::Simulator, "type") => &["kind", "text"],
        (Kind::Simulator, "button") => &["kind", "button"],
        (Kind::Simulator, "key") => &["kind", "key"],
        (Kind::Simulator, "tapLabel") => &["kind", "label"],
        (Kind::Vm | Kind::Cloud, "click") => &["action", "x", "y", "moved"],
        (Kind::Vm | Kind::Cloud, "double_click" | "right_click" | "middle_click") => {
            &["action", "x", "y"]
        }
        (Kind::Vm | Kind::Cloud, "move") => &["action", "x", "y"],
        (Kind::Vm | Kind::Cloud, "drag") => &["action", "x", "y", "endX", "endY"],
        (Kind::Vm | Kind::Cloud, "scroll") => &["action", "x", "y", "direction", "amount"],
        (Kind::Vm | Kind::Cloud, "type") => &["action", "text"],
        (Kind::Vm | Kind::Cloud, "key") => &["action", "keys"],
        _ => return Err("unknown console input action"),
    };
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err("unknown console input argument");
    }
    for key in ["x", "y", "endX", "endY"] {
        if allowed.contains(&key)
            && !object
                .get(key)
                .and_then(Value::as_f64)
                .is_some_and(f64::is_finite)
        {
            return Err("finite console coordinates required");
        }
    }
    if let Some(duration) = object.get("durationMs") {
        if duration.as_u64().is_none() {
            return Err("invalid console input duration");
        }
    }
    if let Some(amount) = object.get("amount") {
        if !amount
            .as_u64()
            .is_some_and(|amount| (1..=30).contains(&amount))
        {
            return Err("invalid console scroll amount");
        }
    }
    if let Some(moved) = object.get("moved") {
        if !moved.is_boolean() {
            return Err("invalid console pointer state");
        }
    }
    for key in ["text", "button", "key", "label", "direction", "keys"] {
        if allowed.contains(&key)
            && !object
                .get(key)
                .and_then(Value::as_str)
                .is_some_and(|text| !text.is_empty() && !text.contains('\0'))
        {
            return Err("valid console input text required");
        }
    }
    Ok(())
}

pub fn validate_native(app: AppHandle, kind: Kind, target: String) -> OperationFuture<()> {
    if kind == Kind::Cloud {
        Box::pin(async move {
            crate::blocking(move || {
                crate::cloud::commands::machines()
                    .machines
                    .iter()
                    .any(|machine| {
                        machine.id == target && machine.desktop && machine.state == "running"
                    })
                    .then_some(())
                    .ok_or_else(|| "Cloud machine has no running desktop.".to_owned())
            })
            .await
        })
    } else {
        super::console_lifecycle::validate_native(app, kind, target)
    }
}

pub fn frame_native(
    app: AppHandle,
    kind: Kind,
    target: String,
    after: u64,
) -> OperationFuture<Frame> {
    Box::pin(async move {
        crate::blocking(move || match kind {
            Kind::Simulator => {
                let sims = app.state::<crate::simulator::Simulators>();
                let device = sims.resolve(Some(&target), true)?;
                let frame = sims.streams.next(
                    &target,
                    sims.display(&target),
                    after,
                    Duration::from_millis(1500),
                )?;
                let bytes = frame.map_or_else(Vec::new, |frame| {
                    let mut bytes = Vec::with_capacity(frame.jpeg.len() + 8);
                    bytes.extend_from_slice(&frame.seq.to_le_bytes());
                    bytes.extend_from_slice(&frame.jpeg);
                    bytes
                });
                let _ = device;
                Ok(Frame {
                    bytes,
                    content_type: "application/octet-stream",
                })
            }
            Kind::Vm => {
                let shot = app
                    .state::<crate::vm::Vms>()
                    .with_screen(&target, false, |rfb| crate::vm::screen::screenshot(rfb, 70))?;
                Ok(Frame {
                    bytes: shot.jpeg,
                    content_type: "image/jpeg",
                })
            }
            Kind::Cloud => {
                let shot = crate::cloud::commands::screenshot(&target)?;
                Ok(Frame {
                    bytes: shot.jpeg,
                    content_type: "image/jpeg",
                })
            }
        })
        .await
    })
}

pub fn input_native(
    app: AppHandle,
    kind: Kind,
    target: String,
    input: Value,
) -> OperationFuture<String> {
    Box::pin(async move {
        crate::blocking(move || match kind {
            Kind::Simulator => {
                let input: crate::simulator::Input = serde_json::from_value(input)
                    .map_err(|_| "Invalid simulator input.".to_owned())?;
                let sims = app.state::<crate::simulator::Simulators>();
                let device = sims.resolve(Some(&target), true)?;
                crate::simulator::input(&target, sims.shown(&device)?, &sims.duo(&target), &input)
            }
            Kind::Vm => {
                let action = crate::vm::tools::action(&input)?;
                app.state::<crate::vm::Vms>()
                    .with_screen(&target, true, |rfb| crate::vm::screen::act(rfb, &action))
            }
            Kind::Cloud => {
                let action = crate::vm::tools::action(&input)?;
                crate::cloud::commands::act(&target, &action)
            }
        })
        .await
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn controller_is_exclusive_and_viewer_cannot_control() {
        let mut leases = ConsoleLeases::default();
        let controller = leases
            .open(
                "a",
                &OpenRequest {
                    kind: Kind::Vm,
                    target: "demo".into(),
                    control: true,
                },
            )
            .unwrap();
        assert!(leases
            .open(
                "b",
                &OpenRequest {
                    kind: Kind::Vm,
                    target: "demo".into(),
                    control: true,
                }
            )
            .is_err());
        let viewer = leases
            .open(
                "b",
                &OpenRequest {
                    kind: Kind::Vm,
                    target: "demo".into(),
                    control: false,
                },
            )
            .unwrap();
        assert!(leases.use_lease("b", &viewer.lease, false).is_ok());
        assert!(leases.use_lease("b", &viewer.lease, true).is_err());
        leases.close("a", &controller.lease).unwrap();
        assert!(leases
            .open(
                "b",
                &OpenRequest {
                    kind: Kind::Vm,
                    target: "demo".into(),
                    control: true,
                }
            )
            .is_ok());
    }

    #[test]
    fn inputs_are_closed_and_reject_unknown_fields() {
        assert!(validate_input(
            Kind::Simulator,
            &serde_json::json!({"kind":"tap", "x":2, "y":3})
        )
        .is_ok());
        assert!(validate_input(
            Kind::Simulator,
            &serde_json::json!({"kind":"tap", "x":2, "y":3, "script":"bad"})
        )
        .is_err());
        assert!(validate_input(
            Kind::Vm,
            &serde_json::json!({"action":"type", "text":"hello"})
        )
        .is_ok());
        assert!(validate_input(
            Kind::Vm,
            &serde_json::json!({"action":"eval", "text":"bad"})
        )
        .is_err());
    }
}
