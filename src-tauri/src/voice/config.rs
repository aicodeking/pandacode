use super::*;
use serde::{Deserialize, Serialize};
use std::path::Path;

const FILE: &str = "voice-profiles.json";
const SERVICE: &str = "app.pandacode.voice";

fn credential_account(id: &str, endpoint: &str) -> String {
    use sha2::{Digest, Sha256};
    format!("{id}/{:x}", Sha256::digest(endpoint.as_bytes()))
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Openai,
    Groq,
    Mistral,
    Custom,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub provider: Provider,
    pub endpoint: String,
    pub model: String,
    pub language: Option<String>,
    pub has_key: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfileInput {
    pub id: Option<String>,
    pub name: String,
    pub provider: Provider,
    pub endpoint: String,
    pub model: String,
    pub language: Option<String>,
    pub key: Option<String>,
}

#[derive(Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Config {
    /// Absent in version 1 files; written as `CONFIG_VERSION` by any save.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    version: Option<u32>,
    selected_profile_id: Option<String>,
    profiles: Vec<StoredProfile>,
    /// Absent in version 1 files: derived from `selected_profile_id` (see `preferences_of`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    preferences: Option<Preferences>,
}

/// Version 2 adds `preferences`; version 1 files load unchanged.
pub(super) const CONFIG_VERSION: u32 = 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DestinationMode {
    Local,
    Off,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfileRef {
    pub profile_id: String,
}

/// `"local" | "off" | {"profileId": string}`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Destination {
    Mode(DestinationMode),
    Profile(ProfileRef),
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ShortcutMode {
    #[default]
    Auto,
    Hold,
    Toggle,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UnloadAfter {
    Immediately,
    #[serde(rename = "min_2")]
    Min2,
    #[serde(rename = "min_5")]
    Min5,
    #[serde(rename = "min_10")]
    Min10,
    #[default]
    #[serde(rename = "min_15")]
    Min15,
    #[serde(rename = "hour_1")]
    Hour1,
}

impl UnloadAfter {
    /// `None` unloads right after each transcription.
    pub fn duration(self) -> Option<Duration> {
        let minutes = match self {
            Self::Immediately => return None,
            Self::Min2 => 2,
            Self::Min5 => 5,
            Self::Min10 => 10,
            Self::Min15 => 15,
            Self::Hour1 => 60,
        };
        Some(Duration::from_secs(minutes * 60))
    }
}

/// Persisted and IPC shape of `voice_preferences` (and of the merged result `voice_update_preferences` returns).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Preferences {
    pub destination: Destination,
    #[serde(default)]
    pub device_name: Option<String>,
    #[serde(default)]
    pub shortcut_mode: ShortcutMode,
    /// `"auto"` or a language code.
    #[serde(default = "auto_language")]
    pub language: String,
    #[serde(default)]
    pub unload_after: UnloadAfter,
    #[serde(default)]
    pub selected_model: Option<String>,
}

/// `voice_update_preferences({ patch })`: any subset of `Preferences`. An absent field keeps the
/// stored value; `null` clears the nullable `deviceName` / `selectedModel`.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreferencesPatch {
    #[serde(default)]
    pub destination: Option<Destination>,
    #[serde(default, deserialize_with = "present")]
    pub device_name: Option<Option<String>>,
    #[serde(default)]
    pub shortcut_mode: Option<ShortcutMode>,
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub unload_after: Option<UnloadAfter>,
    #[serde(default, deserialize_with = "present")]
    pub selected_model: Option<Option<String>>,
}

/// A field that is present (even as `null`) becomes `Some(value)`.
fn present<'de, D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(d).map(Some)
}

impl PreferencesPatch {
    pub fn apply(self, prefs: Preferences) -> Preferences {
        Preferences {
            destination: self.destination.unwrap_or(prefs.destination),
            device_name: self.device_name.unwrap_or(prefs.device_name),
            shortcut_mode: self.shortcut_mode.unwrap_or(prefs.shortcut_mode),
            language: self.language.unwrap_or(prefs.language),
            unload_after: self.unload_after.unwrap_or(prefs.unload_after),
            selected_model: self.selected_model.unwrap_or(prefs.selected_model),
        }
    }
}

fn auto_language() -> String {
    "auto".into()
}

/// Existing users keep their remote profile; with none selected voice stays off.
fn preferences_of(config: &Config) -> Preferences {
    config.preferences.clone().unwrap_or_else(|| Preferences {
        destination: match &config.selected_profile_id {
            Some(id) => Destination::Profile(ProfileRef {
                profile_id: id.clone(),
            }),
            None => Destination::Mode(DestinationMode::Off),
        },
        device_name: None,
        shortcut_mode: ShortcutMode::Auto,
        language: auto_language(),
        unload_after: UnloadAfter::Min15,
        selected_model: None,
    })
}

fn validate_preferences(prefs: &Preferences, ids: &std::collections::HashSet<&String>) -> Result<()> {
    if let Destination::Profile(p) = &prefs.destination {
        if !ids.contains(&p.profile_id) {
            return Err("The selected voice profile is missing.".into());
        }
    }
    if let Some(name) = &prefs.device_name {
        if name.is_empty() || name.len() > 256 || name.chars().any(char::is_control) {
            return Err("Invalid microphone name.".into());
        }
    }
    if prefs.language != "auto" {
        language(Some(&prefs.language))?.ok_or("Use a language code such as en or en-US.")?;
    }
    if let Some(model) = &prefs.selected_model {
        if model.is_empty() || model.len() > 160 || model.chars().any(char::is_control) {
            return Err("Invalid speech model.".into());
        }
    }
    Ok(())
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredProfile {
    id: String,
    name: String,
    provider: Provider,
    endpoint: String,
    model: String,
    language: Option<String>,
    key_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Configuration {
    selected_profile_id: Option<String>,
    profiles: Vec<Profile>,
    limits: Limits,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Limits {
    max_seconds: u64,
    max_audio_bytes: usize,
}

#[derive(Clone)]
pub(super) struct Snapshot {
    pub endpoint: String,
    pub model: String,
    pub language: Option<String>,
    pub key: Option<String>,
}

pub(super) fn validate_endpoint(value: &str) -> Result<reqwest::Url> {
    let error = "Use a full HTTPS transcription URL, or HTTP with a literal loopback address; omit credentials, query and fragment.";
    if value.len() > 2048 || value.trim() != value || value.chars().any(char::is_control) {
        return Err(error.into());
    }
    let url = reqwest::Url::parse(value).map_err(|_| error.to_owned())?;
    let loopback = url
        .host_str()
        .and_then(|host| {
            host.trim_matches(['[', ']'])
                .parse::<std::net::IpAddr>()
                .ok()
        })
        .is_some_and(|ip| ip.is_loopback());
    if url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() == "/"
        || !matches!(url.scheme(), "https" | "http")
        || (url.scheme() == "http" && !loopback)
    {
        return Err(error.into());
    }
    Ok(url)
}

fn field(value: &str, max: usize, label: &str) -> Result<String> {
    let value = value.trim();
    if value.is_empty() || value.len() > max || value.chars().any(char::is_control) {
        return Err(format!("Enter a valid {label} (up to {max} characters)."));
    }
    Ok(value.to_owned())
}

fn language(value: Option<&str>) -> Result<Option<String>> {
    value
        .filter(|s| !s.trim().is_empty())
        .map(|s| {
            let s = field(s, 32, "language code")?;
            if !s
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            {
                return Err("Use a language code such as en or en-US.".into());
            }
            Ok(s)
        })
        .transpose()
}

/// The index of the profile being edited (`None` adds one, up to 32).
fn profile_index(config: &Config, id: Option<&str>) -> Result<Option<usize>> {
    match id {
        Some(id) => Ok(Some(
            config
                .profiles
                .iter()
                .position(|p| p.id == id)
                .ok_or("Voice profile no longer exists.")?,
        )),
        None if config.profiles.len() >= 32 => Err("You can save up to 32 voice profiles.".into()),
        None => Ok(None),
    }
}

/// An entered key: blank removes it; otherwise it is stored under a new account bound to
/// `endpoint`. Returns the profile's key id and the account created (to undo a failed save).
fn store_key(key: &str, endpoint: &str) -> Result<(Option<String>, Option<String>)> {
    let key = key.trim();
    if key.is_empty() {
        return Ok((None, None));
    }
    if key.len() > 4096 || !key.bytes().all(|b| (0x21..=0x7e).contains(&b)) {
        return Err("The voice API key is malformed.".into());
    }
    let account = uuid::Uuid::new_v4().to_string();
    let credential = credential_account(&account, endpoint);
    crate::secret_store::set(SERVICE, &credential, key)?;
    Ok((Some(account), Some(credential)))
}

fn load(dir: &Path) -> Result<Config> {
    if std::fs::metadata(dir.join(FILE)).is_ok_and(|meta| meta.len() > 128 * 1024) {
        return Err("Voice profiles file is too large.".into());
    }
    let config: Config =
        crate::secret_store::load(&dir.join(FILE), "voice profiles").map_err(|_| {
            "Could not read voice profiles. Your saved profiles were left unchanged.".to_owned()
        })?;
    if config.profiles.len() > 32 {
        return Err("Too many voice profiles.".into());
    }
    let mut ids = std::collections::HashSet::new();
    for p in &config.profiles {
        uuid::Uuid::parse_str(&p.id).map_err(|_| "Invalid saved voice profile.".to_owned())?;
        if !ids.insert(&p.id) {
            return Err("Duplicate saved voice profile.".into());
        }
        validate_endpoint(&p.endpoint)?;
        field(&p.name, 80, "profile name")?;
        field(&p.model, 160, "model ID")?;
        language(p.language.as_deref())?;
        if p.key_id
            .as_ref()
            .is_some_and(|id| uuid::Uuid::parse_str(id).is_err())
        {
            return Err("Invalid voice credential reference.".into());
        }
    }
    if config
        .selected_profile_id
        .as_ref()
        .is_some_and(|id| !ids.contains(id))
    {
        return Err("The selected voice profile is missing.".into());
    }
    if config.version.is_some_and(|v| v == 0 || v > CONFIG_VERSION) {
        return Err("Voice settings were saved by a newer PandaCode. Update to change them.".into());
    }
    if let Some(prefs) = &config.preferences {
        validate_preferences(prefs, &ids)?;
    }
    Ok(config)
}

fn persist(dir: &Path, config: Config) -> Result<()> {
    let config = Config {
        version: Some(CONFIG_VERSION),
        ..config
    };
    crate::secret_store::update::<Config>(dir, FILE, "voice profiles", |_| config).map_err(|_| {
        "Could not save voice profiles. Your saved profiles were left unchanged.".to_owned()
    })
}

fn public(config: Config) -> Configuration {
    Configuration {
        selected_profile_id: config.selected_profile_id,
        profiles: config
            .profiles
            .into_iter()
            .map(|p| Profile {
                has_key: p.key_id.as_ref().is_some_and(|id| {
                    crate::secret_store::get(SERVICE, &credential_account(id, &p.endpoint))
                        .is_some()
                }),
                id: p.id,
                name: p.name,
                provider: p.provider,
                endpoint: p.endpoint,
                model: p.model,
                language: p.language,
            })
            .collect(),
        limits: Limits {
            max_seconds: MAX_SECONDS,
            max_audio_bytes: MAX_AUDIO_BYTES,
        },
    }
}

impl Voice {
    pub(super) fn configuration(&self) -> Result<Configuration> {
        let _guard = self
            .config_lock
            .lock()
            .map_err(|_| "Voice settings are unavailable.".to_owned())?;
        Ok(public(load(&self.dir)?))
    }

    pub(super) fn save_profile(&self, input: ProfileInput) -> Result<Configuration> {
        let _guard = self
            .config_lock
            .lock()
            .map_err(|_| "Voice settings are unavailable.".to_owned())?;
        let mut config = load(&self.dir)?;
        let name = field(&input.name, 80, "profile name")?;
        let model = field(&input.model, 160, "model ID")?;
        let endpoint = validate_endpoint(&input.endpoint)?.to_string();
        let language = language(input.language.as_deref())?;
        let index = profile_index(&config, input.id.as_deref())?;
        let old = index.map(|i| &config.profiles[i]);
        let id = old
            .map(|p| p.id.clone())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let old_key = old.and_then(|p| p.key_id.clone());
        let old_account = old.and_then(|p| {
            p.key_id
                .as_ref()
                .map(|id| credential_account(id, &p.endpoint))
        });
        // Credentials stay bound to the full endpoint, including its route.
        let kept = old
            .filter(|p| p.endpoint == endpoint)
            .and_then(|p| p.key_id.clone());
        let (key_id, created_key) = match input.key {
            Some(key) => store_key(&key, &endpoint)?,
            None => (kept, None),
        };
        let next = StoredProfile {
            id,
            name,
            provider: input.provider,
            endpoint,
            model,
            language,
            key_id: key_id.clone(),
        };
        match index {
            Some(i) => config.profiles[i] = next,
            None => config.profiles.push(next),
        }
        if let Err(error) = persist(&self.dir, config.clone()) {
            if let Some(id) = created_key {
                crate::secret_store::remove(SERVICE, &id);
            }
            return Err(error);
        }
        if old_key != key_id {
            if let Some(id) = old_account {
                crate::secret_store::remove(SERVICE, &id);
            }
        }
        Ok(public(config))
    }

    pub(super) fn select_profile(&self, id: Option<String>) -> Result<Configuration> {
        let _guard = self
            .config_lock
            .lock()
            .map_err(|_| "Voice settings are unavailable.".to_owned())?;
        let mut config = load(&self.dir)?;
        if id
            .as_ref()
            .is_some_and(|id| !config.profiles.iter().any(|p| &p.id == id))
        {
            return Err("Voice profile no longer exists.".into());
        }
        // Choosing a profile (or none) in the profile list is a destination choice too.
        let prefs = preferences_of(&config);
        let local = prefs.destination == Destination::Mode(DestinationMode::Local);
        if !(local && id.is_none()) {
            config.preferences = Some(Preferences {
                destination: match &id {
                    Some(id) => Destination::Profile(ProfileRef {
                        profile_id: id.clone(),
                    }),
                    None => Destination::Mode(DestinationMode::Off),
                },
                ..prefs
            });
        }
        config.selected_profile_id = id;
        persist(&self.dir, config.clone())?;
        Ok(public(config))
    }

    pub(super) fn delete_profile(&self, id: &str) -> Result<Configuration> {
        let _guard = self
            .config_lock
            .lock()
            .map_err(|_| "Voice settings are unavailable.".to_owned())?;
        let mut config = load(&self.dir)?;
        let index = config
            .profiles
            .iter()
            .position(|p| p.id == id)
            .ok_or("Voice profile no longer exists.")?;
        let old = config.profiles.remove(index);
        if config.selected_profile_id.as_deref() == Some(id) {
            config.selected_profile_id = None;
        }
        let prefs = preferences_of(&config);
        if matches!(&prefs.destination, Destination::Profile(p) if p.profile_id == id) {
            config.preferences = Some(Preferences {
                destination: Destination::Mode(DestinationMode::Off),
                ..prefs
            });
        }
        persist(&self.dir, config.clone())?;
        if let Some(id) = old.key_id {
            crate::secret_store::remove(SERVICE, &credential_account(&id, &old.endpoint));
        }
        Ok(public(config))
    }

    pub(super) fn snapshot(&self, id: &str) -> Result<Snapshot> {
        let _guard = self
            .config_lock
            .lock()
            .map_err(|_| "Voice settings are unavailable.".to_owned())?;
        let config = load(&self.dir)?;
        let p = config
            .profiles
            .iter()
            .find(|p| p.id == id)
            .ok_or("Choose a saved voice profile in Settings.")?;
        let key = p
            .key_id
            .as_ref()
            .map(|id| {
                crate::secret_store::get(SERVICE, &credential_account(id, &p.endpoint))
                    .ok_or("Re-enter this voice profile's API key in Settings.")
            })
            .transpose()?;
        if p.provider != Provider::Custom && key.is_none() {
            return Err("Add this speech provider's API key in Settings before recording.".into());
        }
        Ok(Snapshot {
            endpoint: p.endpoint.clone(),
            model: p.model.clone(),
            language: p.language.clone(),
            key,
        })
    }
}

impl Voice {
    pub(super) fn preferences(&self) -> Result<Preferences> {
        let _guard = self
            .config_lock
            .lock()
            .map_err(|_| "Voice settings are unavailable.".to_owned())?;
        Ok(preferences_of(&load(&self.dir)?))
    }

    /// `check` vets fields that need other state (the speech catalog) before anything is written.
    #[cfg(test)]
    pub(super) fn save_preferences(
        &self,
        prefs: Preferences,
        check: impl FnOnce(&Preferences) -> Result<()>,
    ) -> Result<Preferences> {
        let _guard = self
            .config_lock
            .lock()
            .map_err(|_| "Voice settings are unavailable.".to_owned())?;
        self.write_preferences(prefs, check)
    }

    /// Caller holds `config_lock`.
    fn write_preferences(
        &self,
        prefs: Preferences,
        check: impl FnOnce(&Preferences) -> Result<()>,
    ) -> Result<Preferences> {
        let mut config = load(&self.dir)?;
        let ids = config.profiles.iter().map(|p| &p.id).collect();
        validate_preferences(&prefs, &ids)?;
        check(&prefs)?;
        if let Destination::Profile(p) = &prefs.destination {
            config.selected_profile_id = Some(p.profile_id.clone());
        }
        config.preferences = Some(prefs.clone());
        persist(&self.dir, config)?;
        Ok(prefs)
    }

    /// Read-modify-write under one hold of the config lock (model selection, deletion), so a
    /// concurrent save can never overwrite the change with a stale copy.
    pub(super) fn update_preferences(
        &self,
        change: impl FnOnce(Preferences) -> Result<Preferences>,
    ) -> Result<Preferences> {
        let _guard = self
            .config_lock
            .lock()
            .map_err(|_| "Voice settings are unavailable.".to_owned())?;
        let next = change(preferences_of(&load(&self.dir)?))?;
        self.write_preferences(next, |_| Ok(()))
    }
}
