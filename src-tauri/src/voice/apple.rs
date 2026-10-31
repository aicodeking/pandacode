//! The macOS engine: Apple's own Speech framework, capturing through
//! AVAudioEngine and feeding `SFSpeechAudioBufferRecognitionRequest`, which
//! streams punctuated partial results as the user speaks — the system
//! dictation experience with no model download. On-device recognition is
//! required when the locale supports it; otherwise Apple's consent-gated
//! service handles it (documented in docs/voice.md and the privacy table).

use std::ptr::NonNull;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use objc2::rc::Retained;
use objc2::AllocAnyThread;
use objc2_avf_audio::{AVAudioEngine, AVAudioFormat, AVAudioPCMBuffer};
use objc2_foundation::{NSBundle, NSLocale, NSString};
use objc2_speech::{
    SFSpeechAudioBufferRecognitionRequest, SFSpeechRecognizer, SFSpeechRecognizerAuthorizationStatus,
};
use tauri::AppHandle;

use super::commands::clear_session;
use super::settings::Settings;
use super::{EVENT_ERROR, EVENT_LEVEL, EVENT_PARTIAL, EVENT_RESULT};

/// True when this Mac can run the Speech framework (authorization may still
/// be pending or denied; `voice_start` reports that to the user).
pub fn available() -> bool {
    true
}

/// Spawns the recognition session on a dedicated thread (AVAudioEngine and the
/// recognizer both prefer a single owner thread). Startup failures — no
/// permission, no recognizer — come back synchronously as Err.
pub fn start_recording(
    app: AppHandle,
    dir: std::path::PathBuf,
    settings: Settings,
    stop: Arc<AtomicBool>,
    cancel: Arc<AtomicBool>,
) -> Result<tauri::async_runtime::JoinHandle<()>, String> {
    let _ = dir; // no model files; kept for symmetry with the sherpa engine
    let locale = locale_for(&settings.language);
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();
    let worker_app = app.clone();
    std::thread::Builder::new()
        .name("voice-apple".into())
        .spawn(move || {
            // Capture ran (events already emitted); only startup errors surface.
            let started = run_session(worker_app.clone(), locale, stop.clone(), cancel.clone());
            let _ = ready_tx.send(started);
            clear_session(&worker_app);
        })
        .map_err(|e| e.to_string())?;
    match ready_rx.recv_timeout(std::time::Duration::from_secs(15)) {
        Ok(Ok(())) => Ok(tauri::async_runtime::spawn(async {})),
        Ok(Err(message)) => Err(message),
        Err(_) => Err("The voice session did not start.".into()),
    }
}

fn locale_for(language: &str) -> String {
    match language {
        "auto" | "" => NSLocale::currentLocale().localeIdentifier().to_string(),
        code => code.replace('_', "-"),
    }
}

/// Runs the whole session on the calling thread and emits the event stream.
/// Returns Err only when capture could not start.
fn run_session(
    app: AppHandle,
    locale: String,
    stop: Arc<AtomicBool>,
    cancel: Arc<AtomicBool>,
) -> Result<(), String> {
    // Requesting authorization without the usage strings crashes (Apple's
    // documented behavior), which is exactly the unbundled dev binary's state.
    if !usage_keys_present() {
        return Err(
            "Voice needs a bundled app build (the microphone usage strings are missing)."
                .into(),
        );
    }
    let status = request_authorization();
    if status != SFSpeechRecognizerAuthorizationStatus::Authorized {
        return Err(
            "Speech recognition is not permitted. Allow it for PandaCode in System Settings → Privacy & Security → Speech Recognition."
                .into(),
        );
    }
    let identifier = NSString::from_str(&locale);
    let ns_locale = NSLocale::localeWithLocaleIdentifier(&identifier);
    let Some(recognizer) =
        (unsafe { SFSpeechRecognizer::initWithLocale(SFSpeechRecognizer::alloc(), &ns_locale) })
    else {
        return Err("Speech recognition is unavailable for this language.".into());
    };
    if !unsafe { recognizer.isAvailable() } {
        return Err("Speech recognition is busy or unavailable right now.".into());
    }
    let on_device = unsafe { recognizer.supportsOnDeviceRecognition() };

    let engine = unsafe { AVAudioEngine::new() };
    let input = unsafe { engine.inputNode() };
    let format: Retained<AVAudioFormat> = unsafe { input.outputFormatForBus(0) };
    if unsafe { format.channelCount() } == 0 {
        return Err("No microphone is available on this computer.".into());
    }

    let request = unsafe { SFSpeechAudioBufferRecognitionRequest::new() };
    unsafe {
        request.setShouldReportPartialResults(true);
        request.setAddsPunctuation(true);
        if on_device {
            request.setRequiresOnDeviceRecognition(true);
        }
    }

    let (result_tx, result_rx) = std::sync::mpsc::channel::<(String, bool)>();
    let handler = block2::RcBlock::new(
        move |result: *mut objc2_speech::SFSpeechRecognitionResult,
              error: *mut objc2_foundation::NSError| {
            if !error.is_null() {
                return;
            }
            let Some(result) = (unsafe { result.as_ref() }) else { return };
            let transcription = unsafe { result.bestTranscription() };
            let text = unsafe { transcription.formattedString() }.to_string();
            let is_final = unsafe { result.isFinal() };
            let _ = result_tx.send((text, is_final));
        },
    );
    let task = unsafe { recognizer.recognitionTaskWithRequest_resultHandler(&request, &handler) };

    // The tap must outlive the session: `tap` lives to the end of this function.
    let level_app = app.clone();
    let tap_request = request.clone();
    let tap = block2::RcBlock::new(
        move |buffer: NonNull<AVAudioPCMBuffer>, _: NonNull<objc2_avf_audio::AVAudioTime>| {
            let buffer = unsafe { buffer.as_ref() };
            unsafe { tap_request.appendAudioPCMBuffer(buffer) };
            static SINCE_LEVEL: std::sync::atomic::AtomicUsize =
                std::sync::atomic::AtomicUsize::new(0);
            if SINCE_LEVEL.fetch_add(1, Ordering::Relaxed).is_multiple_of(4) {
                super::emit(&level_app, EVENT_LEVEL, buffer_level(buffer));
            }
        },
    );
    unsafe {
        input.installTapOnBus_bufferSize_format_block(
            0,
            2_048,
            Some(&format),
            std::ptr::from_ref(&*tap).cast_mut(),
        );
        engine
            .startAndReturnError()
            .map_err(|error| error.localizedDescription().to_string())?;
    }

    // Capture is live; the startup contract is fulfilled.
    let _ = task; // recognition task lives until endAudio; dropped after

    let mut last_partial = String::new();
    let mut apple_ended = false;
    loop {
        if stop.load(Ordering::SeqCst) {
            break;
        }
        match result_rx.try_recv() {
            Ok((text, is_final)) => {
                if is_final {
                    // Apple detected the end of speech on its own.
                    apple_ended = true;
                    break;
                }
                if text != last_partial {
                    last_partial = text.clone();
                    super::emit(&app, EVENT_PARTIAL, serde_json::json!({ "text": text }));
                }
            }
            Err(_) => std::thread::sleep(std::time::Duration::from_millis(60)),
        }
    }

    let cancelled = cancel.load(Ordering::SeqCst);
    unsafe {
        engine.stop();
        input.removeTapOnBus(0);
        request.endAudio();
    }
    if cancelled {
        return Ok(());
    }
    let mut final_text = if apple_ended { last_partial.clone() } else { String::new() };
    if !apple_ended {
        // Normal stop: wait briefly for the final transcript after endAudio.
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(1_500);
        while std::time::Instant::now() < deadline {
            match result_rx.try_recv() {
                Ok((text, is_final)) => {
                    final_text = text;
                    if is_final {
                        break;
                    }
                }
                Err(_) => std::thread::sleep(std::time::Duration::from_millis(40)),
            }
        }
        if final_text.trim().is_empty() {
            final_text = last_partial;
        }
    }
    let final_text = final_text.trim().to_string();
    if final_text.is_empty() {
        super::emit(
            &app,
            EVENT_ERROR,
            serde_json::json!({ "message": "No speech was detected." }),
        );
    } else {
        super::emit(
            &app,
            EVENT_RESULT,
            serde_json::json!({ "text": final_text, "engine": "apple", "fallback": false }),
        );
    }
    Ok(())
}

/// True when the running bundle carries the microphone usage strings —
/// bundled releases always do (src-tauri/Info.plist), `tauri dev` does not.
fn usage_keys_present() -> bool {
    NSBundle::mainBundle()
        .infoDictionary()
        .is_some_and(|info| {
            info.objectForKey(&NSString::from_str("NSMicrophoneUsageDescription"))
                .is_some()
        })
}

/// Requests authorization, prompting once when needed.
fn request_authorization() -> SFSpeechRecognizerAuthorizationStatus {    let (tx, rx) = std::sync::mpsc::channel();
    let handler = block2::RcBlock::new(move |status: SFSpeechRecognizerAuthorizationStatus| {
        let _ = tx.send(status);
    });
    unsafe { SFSpeechRecognizer::requestAuthorization(&handler) };
    rx.recv_timeout(std::time::Duration::from_secs(15))
        .unwrap_or(SFSpeechRecognizerAuthorizationStatus::NotDetermined)
}

/// Rough level from the first channel of an interleaved float buffer.
fn buffer_level(buffer: &AVAudioPCMBuffer) -> f32 {
    unsafe {
        let frames = buffer.frameLength() as usize;
        if frames == 0 {
            return 0.0;
        }
        let data = buffer.floatChannelData();
        if data.is_null() {
            return 0.0;
        }
        let samples = std::slice::from_raw_parts((*data).as_ptr(), frames);
        let sum: f32 = samples.iter().map(|s| s * s).sum();
        ((sum / frames as f32).sqrt() * 4.0).min(1.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locale_maps_language_codes() {
        assert_eq!(locale_for("en"), "en");
        assert_eq!(locale_for("zh_CN"), "zh-CN");
        assert!(!locale_for("auto").is_empty());
    }
}
