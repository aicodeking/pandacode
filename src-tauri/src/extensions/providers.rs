//! Additive v1 built-in provider contract. Core continues to own credentials and runs.
use serde::Serialize;

/// Persisted identity validation deliberately does not depend on package installation.
/// Trust/availability is checked at execution, never while reading historical rows.
pub fn extension_owner(id: &str) -> Option<&str> {
    static ID: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r"^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*/[a-z][a-zA-Z0-9._-]*$").unwrap());
    (id.len() <= 200 && !id.starts_with("panda.") && ID.is_match(id)).then(|| id.split_once('/').unwrap().0)
}

pub fn validate_identity(id: &str) -> Result<(), String> {
    if BuiltinProvider::get(id).is_ok() || extension_owner(id).is_some() { Ok(()) }
    else { Err("Unknown provider.".into()) }
}

pub const PROVIDER_RECOVERY: &str = "This extension provider is unavailable. History is preserved. Reinstall or enable its extension in Settings → Extensions, or change the provider using the model picker to continue.";

pub const CONSOLE_UNSUPPORTED: &str = "UnsupportedCapability: this provider has no core-managed interactive console. Continue in PandaCode task chat.";
pub const SLASH_UNSUPPORTED: &str = "UnsupportedCapability: extension-native slash commands are not supported. Use PandaCode controls or task chat.";

/// A conversation registration cannot authorize a PTY/executable or claim that a
/// terminal enforces core approval policy. Only reviewed native CLI adapters can.
pub fn require_console(id: &str) -> Result<(), String> {
    validate_identity(id)?;
    if matches!(id, "codex" | "claude" | "kimi" | "glm" | "opencode" | "grok" | "mimo" | "pi" | "omp" | "github-copilot" | "muse" | "cline" | "devin" | "hermes") { Ok(()) }
    else { Err(CONSOLE_UNSUPPORTED.into()) }
}

/// Dynamic execution is supplied by the registry adapter, not a built-in CLI fallback.
pub fn require_builtin_execution(id: &str) -> Result<(), String> {
    validate_identity(id)?;
    if extension_owner(id).is_some() { return Err(PROVIDER_RECOVERY.into()); }
    Ok(())
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Operation {
    Discovery, Configuration, Models, Start, Resume, Normalize, Send, Steer, Stop, Approval, Question,
}

pub const OPERATIONS: [Operation; 11] = [Operation::Discovery, Operation::Configuration,
    Operation::Models, Operation::Start, Operation::Resume, Operation::Normalize,
    Operation::Send, Operation::Steer, Operation::Stop, Operation::Approval, Operation::Question];

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Capability {
    Enabled,
    Disabled { reason: &'static str },
}

#[derive(Clone, Copy, Debug)]
pub struct BuiltinProvider {
    pub id: &'static str,
    pub name: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Descriptor {
    api_version: u8,
    id: &'static str,
    name: &'static str,
    operations: Vec<(Operation, Capability)>,
}

impl BuiltinProvider {
    /// Native host seams keep executable/configuration probing out of the contract.
    /// Tests supply recorded observations without starting or signing in a CLI.
    pub(crate) fn discover_with(self, probe: impl FnOnce(&str, &str) -> crate::providers::ProviderInfo) -> crate::providers::ProviderInfo {
        probe(self.id, self.name)
    }

    pub(crate) async fn models_with<F, Fut>(self, catalog: F) -> Result<Vec<crate::providers::ModelInfo>, String>
    where F: FnOnce(&'static str) -> Fut,
        Fut: std::future::Future<Output = Result<Vec<crate::providers::ModelInfo>, String>>,
    {
        self.require(Operation::Models)?;
        catalog(self.id).await
    }

    /// Resolve only the existing core roster. No package, activation or dynamic ID is involved.
    pub fn get(id: &str) -> Result<Self, String> {
        all().find(|provider| provider.id == id).ok_or_else(|| "Unknown provider".into())
    }

    pub fn capability(self, operation: Operation) -> Capability {
        match operation {
            Operation::Question if !matches!(self.id, "codex" | "muse") => Capability::Disabled {
                reason: "This built-in adapter does not support structured question responses",
            },
            _ => Capability::Enabled,
        }
    }

    pub fn require(self, operation: Operation) -> Result<(), String> {
        match self.capability(operation) {
            Capability::Enabled => Ok(()),
            Capability::Disabled { reason } => Err(format!("UnsupportedCapability: {reason}")),
        }
    }

    pub fn descriptor(self) -> Descriptor {
        Descriptor { api_version: 1, id: self.id, name: self.name,
            operations: OPERATIONS.into_iter().map(|op| (op, self.capability(op))).collect() }
    }
}

pub fn all() -> impl Iterator<Item = BuiltinProvider> {
    crate::providers::PROVIDERS.into_iter().map(|(id, name)| BuiltinProvider { id, name })
}
