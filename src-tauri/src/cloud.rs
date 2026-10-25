//! Cloud sandboxes for agents, beside the local VMs: Daytona (desktop sandboxes with
//! computer use), Cloudflare (container sandboxes behind a Worker in your account), and
//! AWS (EC2 desktops for Linux and Windows, and AgentCore code interpreters).
//!
//! Every machine has an ID `provider:native-id`, so the VM tools and panel address local
//! and cloud machines the same way. Keys live in the OS secure store; settings that are
//! not secret (account IDs, regions, URLs) are kept beside them as one JSON value.
pub mod agentcore;
pub mod aws;
pub mod aws_screen;
pub mod blaxel;
pub mod boat;
pub mod cloudflare;
pub mod codesandbox;
pub mod commands;
pub mod daytona;
pub mod deploy;
pub mod digitalocean;
pub mod e2b;
pub mod freestyle;
pub mod gcloud_vm;
pub mod hetzner;
pub mod http;
pub mod instabox;
pub mod modal;
pub mod railway_sandbox;
pub mod runloop;
pub mod runpod;
pub mod sandbox;
pub mod ssh;
pub mod tensorlake;
pub mod vercel_sandbox;
pub mod vultr;

use serde::{Deserialize, Serialize};

use crate::secret_store;

const SERVICE: &str = "app.pandacode.cloud";
pub const PROVIDERS: [&str; 20] = ["daytona", "digitalocean", "vultr", "hetzner", "runpod", "cloudflare", "aws", "agentcore", "gcloud", "e2b", "modal", "vercel", "codesandbox", "runloop", "blaxel", "tensorlake", "freestyle", "railway", "boat", "instabox"];

/// A cloud machine as the panel and tools see it.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Machine {
    pub id: String,
    pub provider: String,
    pub name: String,
    /// running, stopped, starting, stopping, error or archived.
    pub state: String,
    pub os: String,
    /// Has a screen agents can see and control.
    pub desktop: bool,
    pub detail: String,
}

/// `daytona:abc` → (`daytona`, `abc`) for known providers.
pub fn split(id: &str) -> Option<(&str, &str)> {
    let (provider, native) = id.split_once(':')?;
    (PROVIDERS.contains(&provider) && valid_native(native)).then_some((provider, native))
}

/// Native IDs go into provider URLs and paths, so they are plain names: letters, digits,
/// `-`, `_` and `.` (Google Cloud joins name and zone with one), never a `..` or leading dot.
pub fn valid_native(native: &str) -> bool {
    (1..=200).contains(&native.len())
        && native.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
        && !native.starts_with('.')
        && !native.contains("..")
}

/// Non-secret connection settings, stored as one JSON value in the secure store.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub daytona_api_url: Option<String>,
    pub daytona_organization: Option<String>,
    pub cloudflare_account: Option<String>,
    pub cloudflare_worker_url: Option<String>,
    /// Cloudflare cannot list Durable Objects, so PandaCode remembers its sandboxes.
    pub cloudflare_sandboxes: Vec<String>,
    /// AWS CLI profile (none: the default credential chain) and region.
    pub aws_profile: Option<String>,
    pub aws_region: Option<String>,
    /// Vercel team slug for deploys, when not the personal account.
    pub vercel_team: Option<String>,
    /// Railway workspace for new projects, when the token reaches more than one.
    pub railway_workspace: Option<String>,
    /// Google Cloud uses the gcloud CLI's own login; PandaCode stores the project and region.
    pub gcloud_project: Option<String>,
    pub gcloud_region: Option<String>,
    /// Non-secret options of the providers added for cloud agents, by provider ID
    /// (for example `{"vercel": {"projectId": "prj_…"}}`). Secrets go in `set_secret`.
    pub providers: std::collections::BTreeMap<String, std::collections::BTreeMap<String, String>>,
}
pub fn settings() -> Settings {
    secret_store::get(SERVICE, "settings").and_then(|json| serde_json::from_str(&json).ok()).unwrap_or_default()
}
pub fn save_settings(settings: &Settings) -> crate::Result<()> {
    secret_store::set(SERVICE, "settings", &serde_json::to_string(settings).map_err(|e| e.to_string())?)
}
pub fn secret(name: &str) -> Option<String> {
    secret_store::get(SERVICE, name)
}
pub fn set_secret(name: &str, value: &str) -> crate::Result<()> {
    secret_store::set(SERVICE, name, value)
}
pub fn remove_secret(name: &str) {
    secret_store::remove(SERVICE, name);
}

/// POSIX single-quoting for a command run through `sh -c`.
pub fn shell_quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', r"'\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_known_provider_ids_only() {
        assert_eq!(split("daytona:3f2a"), Some(("daytona", "3f2a")));
        assert_eq!(split("pandacode-ubuntu"), None);
        assert_eq!(split("other:x"), None);
        assert_eq!(split("daytona:"), None);
        assert_eq!(split("gcloud:pc-a.us-central1-a"), Some(("gcloud", "pc-a.us-central1-a")));
        for bad in ["instabox:m_1/exec", "instabox:m_1?x=1", "instabox:m_1#x", "instabox:..", "instabox:a..b", "instabox:.x", "instabox:m 1", "instabox:m%2F1", "instabox:m:1", "instabox:m\\1"] {
            assert_eq!(split(bad), None, "{bad}");
        }
        assert_eq!(split(&format!("e2b:{}", "a".repeat(201))), None);
    }
    #[test]
    fn quotes_for_the_shell() {
        assert_eq!(shell_quote("echo 'hi' && ls"), r"'echo '\''hi'\'' && ls'");
    }
    #[test]
    fn settings_round_trip_through_the_secure_store() {
        let saved = Settings { daytona_api_url: Some("https://example.test/api".into()), cloudflare_sandboxes: vec!["a".into()], ..Settings::default() };
        save_settings(&saved).unwrap();
        assert_eq!(settings(), saved);
    }
}
