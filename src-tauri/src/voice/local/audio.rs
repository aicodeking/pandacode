//! Pure audio shaping for the local engine (no model needed, so it is unit tested directly):
//! fixed-size chunking for models without long-form decoding, recursive halving when a chunk
//! is still too long or its output is cut off, and dropping silence found by the VAD.

/// 16 kHz mono: what every catalog model consumes.
pub const SAMPLE_RATE: usize = 16_000;
/// Halving stops here (0.25 s); shorter audio is never split further.
pub const MIN_SPLIT_SAMPLES: usize = 4_000;

/// Outcome of one engine pass that the chunker can act on.
#[derive(Debug)]
pub enum RunError {
    /// `InputTooLong` / `OutputTruncated` / `OutputRepetition`: try again with half the audio.
    /// `partial` is whatever text the engine kept.
    Split { partial: String },
    /// Anything else ends the transcription.
    Fatal(String),
}

fn join(parts: impl IntoIterator<Item = String>) -> String {
    parts
        .into_iter()
        .map(|p| p.trim().to_owned())
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn split_run(
    pcm: &[f32],
    run: &mut dyn FnMut(&[f32]) -> Result<String, RunError>,
) -> Result<String, String> {
    match run(pcm) {
        Ok(text) => Ok(text),
        Err(RunError::Fatal(error)) => Err(error),
        Err(RunError::Split { partial }) => {
            let mid = pcm.len() / 2;
            if mid < MIN_SPLIT_SAMPLES {
                return if partial.trim().is_empty() {
                    Err("The speech model could not transcribe this audio.".into())
                } else {
                    Ok(partial)
                };
            }
            let first = split_run(&pcm[..mid], run)?;
            let second = split_run(&pcm[mid..], run)?;
            Ok(join([first, second]))
        }
    }
}

/// Runs `run` over `pcm` in chunks of `chunk` samples (`None` = one pass), halving any chunk
/// the engine rejects as too long down to `MIN_SPLIT_SAMPLES`, and joins the texts.
pub fn transcribe_chunked(
    pcm: &[f32],
    chunk: Option<usize>,
    run: &mut dyn FnMut(&[f32]) -> Result<String, RunError>,
) -> Result<String, String> {
    if pcm.is_empty() {
        return Ok(String::new());
    }
    let size = chunk.unwrap_or(pcm.len()).max(MIN_SPLIT_SAMPLES);
    let mut texts = Vec::new();
    for part in pcm.chunks(size) {
        texts.push(split_run(part, run)?);
    }
    Ok(join(texts))
}

/// Keeps only the VAD's speech segments (`[start, end)` in samples), in order. Bounds are
/// clamped; an empty result means the recording held no speech.
pub fn speech_only(pcm: &[f32], segments: &[(i64, i64)]) -> Vec<f32> {
    let len = pcm.len() as i64;
    let mut out = Vec::new();
    let mut last_end = 0i64;
    for &(start, end) in segments {
        let start = start.clamp(last_end, len);
        let end = end.clamp(start, len);
        out.extend_from_slice(&pcm[start as usize..end as usize]);
        last_end = end;
    }
    out
}

/// Seconds of audio, rounded up, for timeouts.
pub fn duration(samples: usize) -> std::time::Duration {
    std::time::Duration::from_millis((samples as u64 * 1000).div_ceil(SAMPLE_RATE as u64))
}

/// What the engine transcribes after the VAD: the speech it kept, else the raw audio. A VAD that
/// finds no speech (or fails) must never turn a real dictation into an empty transcript.
pub fn speech_or_raw<E>(vad: Result<Option<Vec<f32>>, E>, pcm: Vec<f32>) -> Vec<f32> {
    match vad {
        Ok(Some(speech)) if !speech.is_empty() => speech,
        _ => pcm,
    }
}
