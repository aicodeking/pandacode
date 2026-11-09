//! Finite lifecycle operations layered on session-owned console controller leases.
//! Raw native frame/input/lifecycle commands remain outside the HTTP command registry.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{future::Future, pin::Pin, time::Duration};
use tauri::{AppHandle, Manager};

use super::consoles::{Kind, Lease};

pub const MANAGER: &str = "$manager";
pub const CAPTURE_LIMIT: usize = 16 * 1024 * 1024;
pub type OperationFuture<T> = Pin<Box<dyn Future<Output = Result<T, String>> + Send>>;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Action {
    SimulatorSelect {
        udid: Option<String>,
    },
    SimulatorCreateDuo,
    SimulatorPose {
        pose: crate::simulator::duo::Pose,
    },
    SimulatorPower {
        on: bool,
    },
    SimulatorAppearance {
        mode: Appearance,
    },
    VmShow {
        name: Option<String>,
    },
    VmCreate {
        image: String,
        name: String,
    },
    VmPower {
        operation: VmPower,
        #[serde(default)]
        share_project_id: Option<String>,
        #[serde(default)]
        confirm: Option<String>,
    },
    VmDesktop,
    VmSetup,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Appearance {
    Light,
    Dark,
}
impl Appearance {
    fn as_str(self) -> &'static str {
        match self {
            Self::Light => "light",
            Self::Dark => "dark",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum VmPower {
    Start,
    Stop,
    Suspend,
    Delete,
}
impl VmPower {
    fn as_str(self) -> &'static str {
        match self {
            Self::Start => "start",
            Self::Stop => "stop",
            Self::Suspend => "suspend",
            Self::Delete => "delete",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub lease: String,
    #[serde(flatten)]
    pub action: Action,
}

impl Action {
    pub fn validate_for(&self, lease: &Lease) -> Result<(), &'static str> {
        let manager = lease.target == MANAGER;
        match (lease.kind, self) {
            (Kind::Simulator, Self::SimulatorSelect { udid })
                if manager && udid.as_ref().is_none_or(|v| valid_id(v, 128)) =>
            {
                Ok(())
            }
            (Kind::Simulator, Self::SimulatorCreateDuo) if manager => Ok(()),
            (
                Kind::Simulator,
                Self::SimulatorPose { .. }
                | Self::SimulatorPower { .. }
                | Self::SimulatorAppearance { .. },
            ) if !manager => Ok(()),
            (Kind::Vm, Self::VmShow { name })
                if manager && name.as_ref().is_none_or(|v| valid_id(v, 128)) =>
            {
                Ok(())
            }
            (Kind::Vm, Self::VmCreate { image, name })
                if manager
                    && crate::vm::IMAGES
                        .iter()
                        .any(|candidate| candidate.id == image)
                    && crate::vm::valid_name(name) =>
            {
                Ok(())
            }
            (
                Kind::Vm,
                Self::VmPower {
                    operation,
                    share_project_id,
                    confirm,
                },
            ) if !manager => {
                if share_project_id
                    .as_ref()
                    .is_some_and(|v| !valid_project_id(v))
                {
                    return Err("invalid shared project");
                }
                if !matches!(operation, VmPower::Start) && share_project_id.is_some() {
                    return Err("project sharing is only valid while starting");
                }
                if matches!(operation, VmPower::Delete)
                    && confirm.as_deref() != Some(lease.target.as_str())
                {
                    return Err("VM deletion requires its exact name as confirmation");
                }
                if !matches!(operation, VmPower::Delete) && confirm.is_some() {
                    return Err("unexpected VM confirmation");
                }
                Ok(())
            }
            (Kind::Vm, Self::VmDesktop) if !manager => Ok(()),
            (Kind::Vm, Self::VmSetup) if manager => Ok(()),
            _ => Err("lifecycle action does not match this console lease"),
        }
    }
    pub fn timeout(&self) -> Duration {
        match self {
            Self::VmCreate { .. } | Self::VmDesktop | Self::VmSetup => Duration::from_secs(15 * 60),
            Self::SimulatorPower { .. } => Duration::from_secs(5 * 60),
            Self::SimulatorCreateDuo | Self::SimulatorPose { .. } => Duration::from_secs(3 * 60),
            Self::VmPower { .. } => Duration::from_secs(2 * 60),
            _ => Duration::from_secs(60),
        }
    }
}
fn valid_id(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && !value.starts_with('-')
        && !value.chars().any(char::is_control)
}

fn valid_project_id(value: &str) -> bool {
    valid_id(value, 128)
        && !value
            .chars()
            .any(|character| matches!(character, '/' | '\\'))
}

pub fn validate_native(app: AppHandle, kind: Kind, target: String) -> OperationFuture<()> {
    Box::pin(async move {
        if kind == Kind::Vm && !cfg!(all(target_os = "macos", target_arch = "aarch64")) {
            return Err("local VM lifecycle requires an Apple-silicon Mac host".into());
        }
        if target == MANAGER {
            return match kind {
                Kind::Simulator => Ok(()),
                Kind::Vm => Ok(()),
                Kind::Cloud => Err("cloud lifecycle manager is unavailable".into()),
            };
        }
        crate::blocking(move || match kind {
            Kind::Simulator => app
                .state::<crate::simulator::Simulators>()
                .resolve(Some(&target), false)
                .map(|_| ()),
            Kind::Vm => crate::vm::commands::status(&app.state::<crate::vm::Vms>())?
                .vms
                .iter()
                .any(|vm| vm.name == target)
                .then_some(())
                .ok_or_else(|| "Unknown VM.".into()),
            Kind::Cloud => Err("cloud lifecycle uses its dedicated controls".into()),
        })
        .await
    })
}

pub fn run_native(app: AppHandle, lease: Lease, action: Action) -> OperationFuture<Value> {
    Box::pin(async move {
        action.validate_for(&lease).map_err(str::to_owned)?;
        if lease.kind == Kind::Vm && !cfg!(all(target_os = "macos", target_arch = "aarch64")) {
            return Err("local VM lifecycle requires an Apple-silicon Mac host".into());
        }
        if matches!(
            &action,
            Action::SimulatorCreateDuo | Action::SimulatorPose { .. }
        ) && !cfg!(target_os = "macos")
        {
            return Err("iPhone Duo lifecycle requires a macOS host with Xcode".into());
        }
        let value = match action {
            Action::SimulatorSelect { udid } => {
                serde_json::to_value(crate::simulator::commands::simulator_select(app, udid).await?)
                    .map_err(|e| e.to_string())?
            }
            Action::SimulatorCreateDuo => {
                serde_json::to_value(crate::simulator::commands::simulator_create_duo(app).await?)
                    .map_err(|e| e.to_string())?
            }
            Action::SimulatorPose { pose } => serde_json::to_value(
                crate::simulator::commands::simulator_pose(app, lease.target, pose).await?,
            )
            .map_err(|e| e.to_string())?,
            Action::SimulatorPower { on } => serde_json::to_value(
                crate::simulator::commands::simulator_power(app, lease.target, on).await?,
            )
            .map_err(|e| e.to_string())?,
            Action::SimulatorAppearance { mode } => Value::String(
                crate::simulator::commands::simulator_appearance(
                    lease.target,
                    mode.as_str().into(),
                )
                .await?,
            ),
            Action::VmShow { name } => {
                serde_json::to_value(crate::vm::commands::vm_show(app, name).await?)
                    .map_err(|e| e.to_string())?
            }
            Action::VmCreate { image, name } => {
                serde_json::to_value(crate::vm::commands::vm_create(app, image, name).await?)
                    .map_err(|e| e.to_string())?
            }
            Action::VmPower {
                operation,
                share_project_id,
                ..
            } => {
                let share = share_project_id
                    .map(|id| {
                        app.state::<crate::AppState>()
                            .root(&id, None)
                            .map(|p| p.to_string_lossy().into_owned())
                    })
                    .transpose()?;
                serde_json::to_value(
                    crate::vm::commands::vm_power(
                        app,
                        lease.target,
                        operation.as_str().into(),
                        share,
                    )
                    .await?,
                )
                .map_err(|e| e.to_string())?
            }
            Action::VmDesktop => {
                Value::String(crate::vm::commands::vm_desktop(app, lease.target).await?)
            }
            Action::VmSetup => Value::String(crate::vm::setup::vm_setup().await?),
        };
        Ok(value)
    })
}

pub fn capture_native(app: AppHandle, lease: Lease) -> OperationFuture<Vec<u8>> {
    Box::pin(async move {
        if lease.kind != Kind::Simulator || lease.target == MANAGER {
            return Err("full capture requires a simulator device lease".into());
        }
        crate::blocking(move || {
            let display = app
                .state::<crate::simulator::Simulators>()
                .display(&lease.target);
            crate::simulator::screenshot(&lease.target, None, display)
        })
        .await
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lease(kind: Kind, target: &str, controller: bool) -> Lease {
        let mut leases = super::super::consoles::ConsoleLeases::default();
        let info = leases
            .open(
                "session",
                &super::super::consoles::OpenRequest {
                    kind,
                    target: target.into(),
                    control: controller,
                },
            )
            .unwrap();
        leases.use_lease("session", &info.lease, false).unwrap().0
    }

    #[test]
    fn lifecycle_actions_are_bound_to_manager_or_exact_target_kind() {
        assert!(Action::SimulatorSelect { udid: None }
            .validate_for(&lease(Kind::Simulator, MANAGER, true))
            .is_ok());
        assert!(Action::SimulatorPower { on: true }
            .validate_for(&lease(Kind::Simulator, "device", true))
            .is_ok());
        assert!(Action::SimulatorPower { on: true }
            .validate_for(&lease(Kind::Vm, "device", true))
            .is_err());
        assert!(Action::VmSetup
            .validate_for(&lease(Kind::Vm, MANAGER, true))
            .is_ok());
        assert!(Action::VmDesktop
            .validate_for(&lease(Kind::Vm, MANAGER, true))
            .is_err());
    }

    #[test]
    fn vm_creation_and_deletion_are_finite_and_explicit() {
        assert!(Action::VmCreate {
            image: "ubuntu".into(),
            name: "web-test".into(),
        }
        .validate_for(&lease(Kind::Vm, MANAGER, true))
        .is_ok());
        assert!(Action::VmCreate {
            image: "https://untrusted.invalid/image".into(),
            name: "web-test".into(),
        }
        .validate_for(&lease(Kind::Vm, MANAGER, true))
        .is_err());
        assert!(Action::VmPower {
            operation: VmPower::Delete,
            share_project_id: None,
            confirm: None,
        }
        .validate_for(&lease(Kind::Vm, "web-test", true))
        .is_err());
        assert!(Action::VmPower {
            operation: VmPower::Delete,
            share_project_id: None,
            confirm: Some("web-test".into()),
        }
        .validate_for(&lease(Kind::Vm, "web-test", true))
        .is_ok());
        assert!(Action::VmPower {
            operation: VmPower::Start,
            share_project_id: Some("/tmp/raw-host-path".into()),
            confirm: None,
        }
        .validate_for(&lease(Kind::Vm, "web-test", true))
        .is_err());
    }

    #[test]
    fn wire_fields_are_camel_case_and_long_actions_have_bounded_deadlines() {
        let request: Request = serde_json::from_value(serde_json::json!({
            "lease": "lease",
            "action": "vmPower",
            "operation": "start",
            "shareProjectId": "project",
        }))
        .unwrap();
        match request.action {
            Action::VmPower {
                operation,
                share_project_id,
                ..
            } => {
                assert_eq!(operation, VmPower::Start);
                assert_eq!(share_project_id.as_deref(), Some("project"));
            }
            _ => panic!("wrong lifecycle action"),
        }
        assert_eq!(Action::VmSetup.timeout(), Duration::from_secs(15 * 60));
        assert_eq!(
            Action::SimulatorAppearance {
                mode: Appearance::Dark,
            }
            .timeout(),
            Duration::from_secs(60)
        );
        assert_eq!(
            Action::SimulatorPower { on: true }.timeout(),
            Duration::from_secs(5 * 60)
        );
    }
}
