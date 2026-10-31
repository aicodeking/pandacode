//! The sherpa-onnx engine: local models, two-stage. While recording, a
//! streaming zipformer produces live partials (restored to punctuation by a
//! small online model); when recording stops, the chosen offline model
//! re-decodes the full buffer for the final transcript — sherpa-onnx's own
//! documented two-pass pattern. Fast mode keeps the streaming text instead.

use std::path::Path;

use sherpa_onnx::{
    OfflineRecognizer, OfflineRecognizerConfig, OnlinePunctuation, OnlinePunctuationConfig,
    OnlinePunctuationModelConfig, OnlineRecognizer, OnlineRecognizerConfig,
    OnlineTransducerModelConfig,
};

use super::model::{self};
use super::settings::Settings;

const SAMPLE_RATE: i32 = 16_000;

/// The live stage plus, when installed and not fast mode, the offline stage.
pub struct SherpaRecorder {
    recognizer: OnlineRecognizer,
    stream: sherpa_onnx::OnlineStream,
    punct: Option<OnlinePunctuation>,
    offline: Option<OfflineRecognizer>,
    fast_mode: bool,
    /// Everything captured, for the offline pass.
    all: Vec<f32>,
    /// Live text accumulated across endpoint resets.
    text: String,
    last_partial: String,
}

/// Loads the engine from downloaded models. Fails with the names of missing
/// downloads so the UI can point at them.
pub fn load(dir: &Path, settings: &Settings) -> Result<SherpaRecorder, String> {
    let models = dir.join("voice").join("models");
    let live_id = model::live_for_language(&settings.language);
    let needed = model::required_models(&settings.language, settings.fast_mode, &settings.model);
    let missing: Vec<String> = needed
        .iter()
        .filter(|id| !model::installed(&models, id))
        .map(|id| format!("{} ({})", model::find(id).map(|m| m.label).unwrap_or(id), id))
        .collect();
    if !missing.is_empty() {
        return Err(format!(
            "Download the voice models first: {}",
            missing.join(", ")
        ));
    }

    let live = model::find(live_id).expect("live model exists in catalog");
    let mut config = OnlineRecognizerConfig::default();
    let file = |name: &str| -> String {
        model::file_path(
            &models,
            live,
            live.files
                .iter()
                .find(|f| f.name == name)
                .expect("catalog file name"),
        )
        .to_string_lossy()
        .into_owned()
    };
    let encoder = live
        .files
        .iter()
        .find(|f| f.name.starts_with("encoder"))
        .map(|f| f.name)
        .expect("zipformer encoder");
    let decoder = live
        .files
        .iter()
        .find(|f| f.name.starts_with("decoder"))
        .map(|f| f.name)
        .expect("zipformer decoder");
    let joiner = live
        .files
        .iter()
        .find(|f| f.name.starts_with("joiner"))
        .map(|f| f.name)
        .expect("zipformer joiner");
    config.model_config.transducer = OnlineTransducerModelConfig {
        encoder: Some(file(encoder)),
        decoder: Some(file(decoder)),
        joiner: Some(file(joiner)),
    };
    config.model_config.tokens = Some(file("tokens.txt"));
    config.enable_endpoint = true;
    config.rule1_min_trailing_silence = 1.2;
    config.rule2_min_trailing_silence = 0.6;
    config.decoding_method = Some("greedy_search".into());
    let recognizer = OnlineRecognizer::create(&config)
        .ok_or("The live voice model failed to load.")?;
    let stream = recognizer.create_stream();

    let punct = load_punct(&models);
    let offline = if settings.fast_mode {
        None
    } else {
        load_offline(&models, settings)
    };

    Ok(SherpaRecorder {
        recognizer,
        stream,
        punct,
        offline,
        fast_mode: settings.fast_mode,
        all: Vec::new(),
        text: String::new(),
        last_partial: String::new(),
    })
}

fn load_punct(models: &Path) -> Option<OnlinePunctuation> {
    model::find(model::PUNCT_DEFAULT)?;
    if !model::installed(models, model::PUNCT_DEFAULT) {
        return None;
    }
    let path = |name: &str| punct_dir(models).join(name).to_string_lossy().into_owned();
    let config = OnlinePunctuationConfig {
        model: OnlinePunctuationModelConfig {
            cnn_bilstm: Some(path("model.int8.onnx")),
            bpe_vocab: Some(path("bpe.vocab")),
            ..Default::default()
        },
    };
    match OnlinePunctuation::create(&config) {
        Some(punctuator) => Some(punctuator),
        None => {
            eprintln!("Voice punctuation model failed to load; live text stays unpunctuated.");
            None
        }
    }
}

/// The punct files live in `<models>/punct-en/` (extracted from the archive).
fn punct_dir(models: &Path) -> std::path::PathBuf {
    models.join(model::PUNCT_DEFAULT)
}

pub(crate) fn load_offline(models: &Path, settings: &Settings) -> Option<OfflineRecognizer> {
    let id = settings
        .resolved_model(&|id| model::installed(models, id));
    let entry = model::find(&id)?;
    if !model::installed(models, &id) {
        return None;
    }
    let path_of = |name: &str| -> String {
        let file = entry
            .files
            .iter()
            .find(|f| f.name == name)
            .unwrap_or_else(|| panic!("catalog model {} is missing file {}", entry.id, name));
        model::file_path(models, entry, file).to_string_lossy().into_owned()
    };
    let tokens = entry
        .files
        .iter()
        .find(|f| f.name.ends_with("tokens.txt"))
        .map(|f| path_of(f.name));
    let mut config = OfflineRecognizerConfig::default();
    config.model_config.tokens = tokens;
    config.model_config.num_threads = 2;
    match entry.id {
        "sense-voice" => {
            config.model_config.sense_voice.model = Some(path_of("model.int8.onnx"));
            let language = match settings.language.split(['-', '_']).next().unwrap_or("auto") {
                "zh" | "ja" | "ko" | "yue" | "en" => Some(settings.language.clone()),
                _ => Some("auto".into()),
            };
            config.model_config.sense_voice.language = language;
            config.model_config.sense_voice.use_itn = true;
        }
        "moonshine-base" | "moonshine-tiny" => {
            config.model_config.moonshine.preprocessor = Some(path_of("preprocess.onnx"));
            config.model_config.moonshine.encoder = Some(path_of("encode.int8.onnx"));
            config.model_config.moonshine.uncached_decoder = Some(path_of("uncached_decode.int8.onnx"));
            config.model_config.moonshine.cached_decoder = Some(path_of("cached_decode.int8.onnx"));
        }
        "parakeet-v3" => {
            config.model_config.transducer.encoder = Some(path_of("encoder.int8.onnx"));
            config.model_config.transducer.decoder = Some(path_of("decoder.int8.onnx"));
            config.model_config.transducer.joiner = Some(path_of("joiner.int8.onnx"));
        }
        "whisper-small" => {
            config.model_config.whisper.encoder = Some(path_of("small-encoder.int8.onnx"));
            config.model_config.whisper.decoder = Some(path_of("small-decoder.int8.onnx"));
            let code = settings.language.split(['-', '_']).next().unwrap_or("auto");
            config.model_config.whisper.language =
                if code == "auto" { None } else { Some(code.into()) };
            config.model_config.whisper.task = Some("transcribe".into());
        }
        _ => return None,
    }
    OfflineRecognizer::create(&config)
}

impl SherpaRecorder {
    /// Feeds 16 kHz mono samples; returns the new live text when it changed.
    /// The text is punctuated when the punctuation model is installed.
    pub fn feed(&mut self, chunk: &[f32]) -> Option<String> {
        if chunk.is_empty() {
            return None;
        }
        self.all.extend_from_slice(chunk);
        self.stream.accept_waveform(SAMPLE_RATE, chunk);
        let mut changed = false;
        while self.recognizer.is_ready(&self.stream) {
            self.recognizer.decode(&self.stream);
            changed = true;
        }
        if self.recognizer.is_endpoint(&self.stream) {
            if let Some(result) = self.recognizer.get_result(&self.stream) {
                if !result.text.trim().is_empty() {
                    self.append_segment(&result.text);
                    changed = true;
                }
            }
            self.recognizer.reset(&self.stream);
        }
        if !changed {
            return None;
        }
        let mut live = self.text.clone();
        if let Some(result) = self.recognizer.get_result(&self.stream) {
            if !result.text.trim().is_empty() {
                let tail = self.punctuate(&result.text);
                if !live.is_empty() && !live.ends_with(' ') && !tail.starts_with(' ') {
                    live.push(' ');
                }
                live.push_str(&tail);
            }
        }
        if live == self.last_partial {
            return None;
        }
        self.last_partial = live.clone();
        Some(live)
    }

    /// Finalizes: flushes the streaming tail, then re-decodes everything with
    /// the offline model when one is loaded (two-pass); fast mode punctuates
    /// the streaming text instead.
    pub fn finish(mut self) -> String {
        self.stream.input_finished();
        while self.recognizer.is_ready(&self.stream) {
            self.recognizer.decode(&self.stream);
        }
        if let Some(result) = self.recognizer.get_result(&self.stream) {
            if !result.text.trim().is_empty() {
                self.append_segment(&result.text);
            }
        }
        if !self.fast_mode {
            if let Some(offline) = &self.offline {
                if !self.all.is_empty() {
                    let stream = offline.create_stream();
                    stream.accept_waveform(SAMPLE_RATE, &self.all);
                    offline.decode(&stream);
                    if let Some(result) = stream.get_result() {
                        let text = result.text.trim().to_string();
                        if !text.is_empty() {
                            return text;
                        }
                    }
                }
            }
        }
        self.text.trim().to_string()
    }

    fn append_segment(&mut self, raw: &str) {
        let segment = self.punctuate(raw);
        if segment.is_empty() {
            return;
        }
        if !self.text.is_empty() && !self.text.ends_with(' ') && !segment.starts_with(' ') {
            self.text.push(' ');
        }
        self.text.push_str(&segment);
    }

    fn punctuate(&self, text: &str) -> String {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return String::new();
        }
        match &self.punct {
            Some(punctuator) => punctuator
                .add_punctuation(trimmed)
                .unwrap_or_else(|| trimmed.to_string()),
            None => trimmed.to_string(),
        }
    }
}

/// The offline quality pass alone, without the streaming stage — used by the
/// online-with-fallback mode to settle a recording when the provider failed.
/// Returns `None` when no quality model is installed.
pub(crate) fn finalize_buffer(dir: &Path, settings: &Settings, samples: &[f32]) -> Option<String> {
    if samples.is_empty() {
        return None;
    }
    let models = dir.join("voice").join("models");
    let offline = load_offline(&models, settings)?;
    let stream = offline.create_stream();
    stream.accept_waveform(SAMPLE_RATE, samples);
    offline.decode(&stream);
    let text = stream.get_result()?.text.trim().to_string();
    if text.is_empty() { None } else { Some(text) }
}

#[cfg(test)]
mod tests {
    use super::model::Kind;
    use super::*;

    #[test]
    fn load_reports_missing_models_by_name() {
        let dir = std::env::temp_dir().join(format!("pandacode-voice-sherpa-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let settings = Settings::default();
        let error = match load(&dir, &settings) {
            Err(error) => error,
            Ok(_) => panic!("loading without models must fail"),
        };
        assert!(error.contains("Download the voice models first"), "{error}");
        assert!(error.contains("live-en"), "{error}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn punct_dir_follows_catalog_id() {
        let dir = Path::new("/tmp/x");
        assert!(punct_dir(dir).ends_with("punct-en"));
    }

    #[test]
    fn required_models_gate_the_offline_pass() {
        // Fast mode lists no final model; covered in model.rs. Here: the
        // loader's missing-list names punct-en only when English/auto.
        let settings = Settings { language: "zh".into(), ..Settings::default() };
        let dir = std::env::temp_dir().join(format!("pandacode-voice-sherpa-zh-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let error = match load(&dir, &settings) {
            Err(error) => error,
            Ok(_) => panic!("loading without models must fail"),
        };
        assert!(error.contains("live-zh-en"), "{error}");
        assert!(!error.contains("punct-en"), "{error}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn kinds_are_stable_for_serialization() {
        assert_eq!(serde_json::to_string(&Kind::Final).unwrap(), "\"final\"");
        assert_eq!(serde_json::to_string(&Kind::Live).unwrap(), "\"live\"");
        assert_eq!(serde_json::to_string(&Kind::Punct).unwrap(), "\"punct\"");
    }
}
