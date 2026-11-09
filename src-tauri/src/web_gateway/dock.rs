//! Browser-safe running-agents widget preferences.
//!
//! Persisting the shared enabled/keep-on-screen preferences is meaningful in both native and web
//! views. Native dock pinning creates a separate operating-system window, so it deliberately has
//! no web implementation.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{future::Future, pin::Pin};
use tauri::{AppHandle, Manager};

pub type OperationFuture = Pin<Box<dyn Future<Output = Result<Value, String>> + Send>>;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Action {
    Save { enabled: bool, keep_on_screen: bool },
    Pin,
}

#[derive(Debug, Deserialize)]
pub struct Request {
    #[serde(flatten)]
    pub action: Action,
}

pub fn run_native(app: AppHandle, action: Action) -> OperationFuture {
    Box::pin(async move {
        match action {
            Action::Save {
                enabled,
                keep_on_screen,
            } => {
                let value = crate::agents_dock::agents_dock_save_preferences(
                    app.clone(),
                    app.state::<crate::agents_dock::DockState>(),
                    enabled,
                    keep_on_screen,
                )
                .await?;
                serde_json::to_value(value).map_err(|error| error.to_string())
            }
            Action::Pin => Err(
                "native dock pinning creates an operating-system window and is unavailable in the web UI"
                    .into(),
            ),
        }
    })
}
