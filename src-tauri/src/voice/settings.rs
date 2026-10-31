//! Voice dictation settings: one `voice.json` beside the other feature settings.
//! Only preferences live here; nothing secret (online keys arrive with the
//! online engines and use the shared secret store). Mirrors `overlay.rs`.

use serde::{Deserialize, Serialize};

use super::model;

pub const FILE: &str = "voice.json";

/// Which engine turns speech into text. `apple` is macOS's own Speech
/// framework (no download); `sherpa` runs downloaded local models.
pub const ENGINE_APPLE: &str = "apple";
pub const ENGINE_SHERPA: &str = "sherpa";

/// How recording starts and stops: click-to-toggle or hold the mic button.
pub const INTERACTION_TOGGLE: &str = "toggle";
pub const INTERACTION_HOLD: &str = "hold";

/// Where transcription happens: `offline` (default), `online` (a configured
/// provider), or `online-fallback` (online first, the offline engine settles).
pub const MODE_OFFLINE: &str = "offline";
pub const MODE_ONLINE: &str = "online";
pub const MODE_ONLINE_FALLBACK: &str = "online-fallback";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub enabled: bool,
    /// `apple` (macOS only) or `sherpa`; empty means the platform default.
    pub engine: String,
    /// Catalog id of the downloaded offline model used for the final pass
    /// (`model::FINAL_DEFAULT` when empty).
    pub model: String,
    /// BCP-47-ish hint (`en`, `zh`, …) or `auto`.
    pub language: String,
    /// `toggle` or `hold` (see the constants above).
    pub interaction: String,
    /// Skip the offline final pass and keep the streaming result: fastest
    /// stop-to-text, slightly lower quality.
    pub fast_mode: bool,
    /// `offline`, `online`, or `online-fallback` (constants above).
    pub mode: String,
    /// Online provider id (`providers::find`); empty means none configured.
    pub online_provider: String,
    /// Online model override; empty uses the provider preset's default.
    pub online_model: String,
    /// Base URL override (required for `custom`; optional elsewhere).
    pub online_base_url: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            enabled: false,
            engine: String::new(),
            model: model::FINAL_DEFAULT.into(),
            language: "auto".into(),
            interaction: INTERACTION_TOGGLE.into(),
            fast_mode: false,
            mode: MODE_OFFLINE.into(),
            online_provider: String::new(),
            online_model: String::new(),
            online_base_url: String::new(),
        }
    }
}

impl Settings {
    /// The engine actually used, filling in the platform default.
    pub fn resolved_engine(&self) -> &'static str {
        if self.engine.is_empty() {
            if cfg!(target_os = "macos") {
                ENGINE_APPLE
            } else {
                ENGINE_SHERPA
            }
        } else if self.engine == ENGINE_APPLE {
            ENGINE_APPLE
        } else {
            ENGINE_SHERPA
        }
    }

    /// The offline model for the final pass, filling in the best default for
    /// the chosen language when the saved pick is not installed.
    pub fn resolved_model(&self, installed: &dyn Fn(&str) -> bool) -> String {
        if !self.model.is_empty() && installed(&self.model) {
            return self.model.clone();
        }
        for candidate in model::defaults_for_language(&self.language) {
            if installed(candidate) {
                return (*candidate).into();
            }
        }
        String::new()
    }

    pub fn normalized(mut self) -> Self {
        if self.engine != ENGINE_APPLE && self.engine != ENGINE_SHERPA {
            self.engine.clear();
        }
        if model::find(&self.model).is_none() {
            self.model = model::FINAL_DEFAULT.into();
        }
        if self.language.is_empty() {
            self.language = "auto".into();
        }
        if self.interaction != INTERACTION_TOGGLE && self.interaction != INTERACTION_HOLD {
            self.interaction = INTERACTION_TOGGLE.into();
        }
        if self.mode != MODE_ONLINE && self.mode != MODE_ONLINE_FALLBACK {
            self.mode = MODE_OFFLINE.into();
        }
        if super::providers::find(&self.online_provider).is_none() {
            self.online_provider.clear();
            self.online_model.clear();
            self.online_base_url.clear();
        }
        // An online mode without a provider yet is kept: the form must stay
        // reachable to pick one; recording refuses until it is configured.
        self
    }

    /// True when the saved mode wants a network provider first.
    pub fn online_first(&self) -> bool {
        self.mode == MODE_ONLINE || self.mode == MODE_ONLINE_FALLBACK
    }

    /// True when a failed online attempt should settle on the offline engine.
    pub fn fallback_allowed(&self) -> bool {
        self.mode == MODE_ONLINE_FALLBACK
    }
}

/// Reads `voice.json`, falling back to defaults when absent or unreadable.
pub fn load(dir: &std::path::Path) -> Settings {
    match std::fs::read(dir.join(FILE)) {
        Ok(bytes) => serde_json::from_slice::<Settings>(&bytes)
            .map(Settings::normalized)
            .unwrap_or_default(),
        Err(_) => Settings::default(),
    }
}

/// Writes `voice.json` (best effort: a failed write keeps the session values).
pub fn save(dir: &std::path::Path, settings: &Settings) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(settings).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(FILE), bytes).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn installed(id: &str) -> bool {
        id == "sense-voice"
    }

    #[test]
    fn defaults_are_toggle_sherpa_aware() {
        let settings = Settings::default();
        assert!(!settings.enabled);
        assert_eq!(settings.interaction, INTERACTION_TOGGLE);
        let engine = settings.resolved_engine();
        if cfg!(target_os = "macos") {
            assert_eq!(engine, ENGINE_APPLE);
        } else {
            assert_eq!(engine, ENGINE_SHERPA);
        }
    }

    #[test]
    fn normalization_repairs_unknown_values() {
        let settings = Settings {
            engine: "whisper".into(),
            model: "nope".into(),
            language: "".into(),
            interaction: "shout".into(),
            ..Settings::default()
        }
        .normalized();
        assert_eq!(settings.engine, "");
        assert_eq!(settings.model, model::FINAL_DEFAULT);
        assert_eq!(settings.language, "auto");
        assert_eq!(settings.interaction, INTERACTION_TOGGLE);
    }

    #[test]
    fn resolved_model_keeps_pick_and_falls_back_by_language() {
        let settings = Settings { model: "sense-voice".into(), ..Settings::default() };
        assert_eq!(settings.resolved_model(&installed), "sense-voice");
        // Not installed: fall back to the language default that is installed.
        let settings = Settings { model: "parakeet-v3".into(), language: "zh".into(), ..Settings::default() };
        assert_eq!(settings.resolved_model(&installed), "sense-voice");
        // An installed default still answers for other languages…
        let settings = Settings { model: "parakeet-v3".into(), language: "fr".into(), ..Settings::default() };
        assert_eq!(settings.resolved_model(&installed), "sense-voice");
        // …and nothing is chosen when nothing is installed.
        assert_eq!(settings.resolved_model(&|_| false), "");
    }

    #[test]
    fn online_mode_survives_until_a_provider_is_picked() {
        let settings = Settings { mode: super::MODE_ONLINE.into(), ..Settings::default() }.normalized();
        assert_eq!(settings.mode, super::MODE_ONLINE);
        assert!(settings.online_first());
        // An unknown provider id is still scrubbed, and a known one kept.
        let with_provider = Settings {
            mode: super::MODE_ONLINE_FALLBACK.into(),
            online_provider: "deepgram".into(),
            online_base_url: "".into(),
            ..Settings::default()
        }
        .normalized();
        assert_eq!(with_provider.mode, super::MODE_ONLINE_FALLBACK);
        assert_eq!(with_provider.online_provider, "deepgram");
        let bogus = Settings {
            mode: super::MODE_ONLINE.into(),
            online_provider: "nope".into(),
            online_model: "m".into(),
            ..Settings::default()
        }
        .normalized();
        assert_eq!(bogus.online_provider, "");
        assert_eq!(bogus.online_model, "");
    }

    #[test]
    fn round_trips_through_disk() {
        let dir = std::env::temp_dir().join(format!("pandacode-voice-settings-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let settings = Settings { enabled: true, fast_mode: true, language: "en".into(), ..Settings::default() };
        save(&dir, &settings).unwrap();
        let loaded = load(&dir);
        assert_eq!(loaded, settings);
        std::fs::remove_dir_all(&dir).ok();
    }
}
