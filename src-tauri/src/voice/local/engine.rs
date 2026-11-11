//! Child-process side of the speech worker: transcribe-cpp behind the `Handler` protocol.
//! Only `__speech-worker` runs this; the app process never links a model into memory.
use super::audio::{speech_only, speech_or_raw, transcribe_chunked, RunError};
use super::worker::{Backend, Handler, LoadRequest, Loaded, TranscribeRequest};
use transcribe_cpp as tc;

#[derive(Default)]
pub struct Engine {
    model: Option<(tc::Model, tc::Session)>,
    vad: Option<(String, tc::VadSession)>,
}

fn classify(error: tc::Error) -> RunError {
    match error {
        tc::Error::InputTooLong(_) => RunError::Split {
            partial: String::new(),
        },
        tc::Error::OutputTruncated { partial, .. } | tc::Error::OutputRepetition { partial, .. } => {
            RunError::Split {
                partial: partial.map(|t| t.text).unwrap_or_default(),
            }
        }
        other => RunError::Fatal(other.to_string()),
    }
}

impl Engine {
    /// `Ok(None)`: the VAD found no speech. Callers fall back to the raw audio then and on errors.
    fn speech(&mut self, path: &str, pcm: &[f32]) -> Result<Option<Vec<f32>>, tc::Error> {
        if self.vad.as_ref().is_none_or(|(p, _)| p != path) {
            let options = tc::ModelOptions {
                backend: tc::Backend::Cpu,
                ..Default::default()
            };
            let session = tc::Model::load_with(path, &options)?.vad_session()?;
            self.vad = Some((path.to_owned(), session));
        }
        let Some((_, vad)) = self.vad.as_mut() else {
            return Ok(Some(pcm.to_vec()));
        };
        let result = vad.run(pcm, &tc::VadOptions::default())?;
        let segments: Vec<(i64, i64)> = result
            .segments
            .iter()
            .map(|s| (s.start_sample, s.end_sample))
            .collect();
        if segments.is_empty() {
            return Ok(None);
        }
        Ok(Some(speech_only(pcm, &segments)))
    }
}

impl Handler for Engine {
    fn load(&mut self, request: LoadRequest) -> Result<Loaded, String> {
        self.model = None;
        let options = tc::ModelOptions {
            backend: match request.backend {
                Backend::Auto => tc::Backend::Auto,
                Backend::Cpu => tc::Backend::Cpu,
            },
            ..Default::default()
        };
        let model = tc::Model::load_with(&request.path, &options).map_err(|e| e.to_string())?;
        let caps = model.capabilities().map_err(|e| e.to_string())?;
        let session = model.session().map_err(|e| e.to_string())?;
        let loaded = Loaded {
            backend: model.backend(),
            languages: caps.languages,
            supports_streaming: caps.supports_streaming,
            supports_long_form: caps.max_audio_ms == 0,
            supports_translation: caps.supports_translate,
        };
        self.model = Some((model, session));
        Ok(loaded)
    }

    fn transcribe(&mut self, request: TranscribeRequest, pcm: Vec<f32>) -> Result<String, String> {
        let audio = match request.vad_path.as_deref().filter(|_| request.filter_silence) {
            Some(path) => {
                let found = self.speech(path, &pcm);
                speech_or_raw(found, pcm)
            }
            None => pcm,
        };
        let (_, session) = self.model.as_mut().ok_or("No speech model is loaded.")?;
        let options = tc::RunOptions {
            language: request.language,
            task: if request.task.as_deref() == Some("translate") {
                tc::Task::Translate
            } else {
                tc::Task::Transcribe
            },
            ..Default::default()
        };
        transcribe_chunked(&audio, request.chunk_samples, &mut |chunk| {
            session.run(chunk, &options).map(|t| t.text).map_err(classify)
        })
    }

    fn reset(&mut self) {
        self.model = None;
        self.vad = None;
    }
}
