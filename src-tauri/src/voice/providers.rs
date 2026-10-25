//! The online provider registry: presets for the transcription services a
//! user can configure. Keys live in the secret store under
//! `app.pandacode.voice`; base URL and model are settings. Streaming providers
//! transcribe while you speak; multipart providers finalize once on stop.

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Transport {
    /// OpenAI-compatible `POST …/v1/audio/transcriptions`, final text only.
    Multipart,
    /// Deepgram's streaming WebSocket: live interim results.
    DeepgramWs,
    /// OpenAI Realtime transcription WebSocket (Together-compatible URL).
    RealtimeWs,
}

#[derive(Clone, Copy, Debug)]
pub struct Provider {
    pub id: &'static str,
    pub label: &'static str,
    /// Default endpoint (base URL without the path, for multipart presets).
    pub base_url: &'static str,
    pub default_model: &'static str,
    /// Well-known models for the picker; custom models stay free-text.
    pub models: &'static [&'static str],
    pub transport: Transport,
    /// `Bearer <key>` vs Deepgram's `Token <key>`.
    pub token_scheme: &'static str,
}

pub const PROVIDERS: &[Provider] = &[
    Provider {
        id: "openai",
        label: "OpenAI",
        base_url: "https://api.openai.com",
        default_model: "gpt-4o-mini-transcribe",
        models: &["gpt-4o-mini-transcribe", "gpt-4o-transcribe", "whisper-1"],
        transport: Transport::Multipart,
        token_scheme: "Bearer",
    },
    Provider {
        id: "groq",
        label: "Groq",
        base_url: "https://api.groq.com",
        default_model: "whisper-large-v3-turbo",
        models: &["whisper-large-v3-turbo", "whisper-large-v3"],
        transport: Transport::Multipart,
        token_scheme: "Bearer",
    },
    Provider {
        id: "openrouter",
        label: "OpenRouter",
        base_url: "https://openrouter.ai",
        default_model: "openai/gpt-4o-mini-transcribe",
        models: &[
            "openai/gpt-4o-mini-transcribe",
            "openai/whisper-large-v3-turbo",
            "deepgram/nova-3",
            "elevenlabs/scribe-v2",
        ],
        transport: Transport::Multipart,
        token_scheme: "Bearer",
    },
    Provider {
        id: "together",
        label: "Together",
        base_url: "https://api.together.ai",
        default_model: "openai/whisper-large-v3",
        models: &["openai/whisper-large-v3"],
        transport: Transport::Multipart,
        token_scheme: "Bearer",
    },
    Provider {
        id: "deepgram",
        label: "Deepgram (live)",
        base_url: "wss://api.deepgram.com",
        default_model: "nova-3",
        models: &["nova-3", "nova-2", "base"],
        transport: Transport::DeepgramWs,
        token_scheme: "Token",
    },
    Provider {
        id: "openai-realtime",
        label: "OpenAI Realtime (live)",
        base_url: "wss://api.openai.com",
        default_model: "gpt-4o-mini-transcribe",
        models: &["gpt-4o-mini-transcribe", "gpt-4o-transcribe", "whisper-1"],
        transport: Transport::RealtimeWs,
        token_scheme: "Bearer",
    },
    Provider {
        id: "custom",
        label: "Custom (OpenAI-compatible)",
        base_url: "",
        default_model: "",
        models: &[],
        transport: Transport::Multipart,
        token_scheme: "Bearer",
    },
];

pub fn find(id: &str) -> Option<&'static Provider> {
    PROVIDERS.iter().find(|provider| provider.id == id)
}

/// The multipart transcription URL for a provider (base override honored).
pub fn transcription_url(provider: &Provider, base_override: &str) -> String {
    let base = if base_override.is_empty() { provider.base_url } else { base_override };
    let base = base.trim_end_matches('/');
    if base.ends_with("/v1") {
        format!("{base}/audio/transcriptions")
    } else if provider.id == "openrouter" {
        format!("{base}/api/v1/audio/transcriptions")
    } else {
        format!("{base}/v1/audio/transcriptions")
    }
}

/// The realtime WebSocket URL (Together's compatible endpoint via override).
pub fn realtime_url(provider: &Provider, base_override: &str, model: &str) -> String {
    let base = if base_override.is_empty() { provider.base_url } else { base_override };
    let base = base.trim_end_matches('/');
    if provider.id == "openai-realtime" && base.contains("together") {
        format!("{base}/v1/realtime?model={model}&input_audio_format=pcm_s16le_16000")
    } else {
        format!("{base}/v1/realtime?intent=transcription")
    }
}

/// Deepgram's listen URL with the dictation query set.
pub fn deepgram_url(provider: &Provider, base_override: &str, model: &str) -> String {
    let base = if base_override.is_empty() { provider.base_url } else { base_override };
    let base = base.trim_end_matches('/');
    format!(
        "{base}/v1/listen?model={model}&interim_results=true&smart_format=true&encoding=linear16&sample_rate=16000&channels=1&endpointing=300"
    )
}

/// The effective model: the saved pick or the preset default.
pub fn resolved_model<'a>(provider: &Provider, saved: &'a str) -> &'a str {
    if saved.is_empty() { provider.default_model } else { saved }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_covers_the_presets() {
        assert_eq!(PROVIDERS.len(), 7);
        for provider in PROVIDERS {
            assert!(!provider.id.is_empty() && !provider.label.is_empty());
        }
        assert!(find("deepgram").unwrap().transport == Transport::DeepgramWs);
        assert!(find("openai-realtime").unwrap().transport == Transport::RealtimeWs);
        assert!(find("groq").unwrap().transport == Transport::Multipart);
        assert!(find("nope").is_none());
    }

    #[test]
    fn multipart_urls_follow_each_provider_shape() {
        let openai = find("openai").unwrap();
        assert_eq!(
            transcription_url(openai, ""),
            "https://api.openai.com/v1/audio/transcriptions"
        );
        let groq = find("groq").unwrap();
        assert_eq!(
            transcription_url(groq, ""),
            "https://api.groq.com/v1/audio/transcriptions"
        );
        let openrouter = find("openrouter").unwrap();
        assert_eq!(
            transcription_url(openrouter, ""),
            "https://openrouter.ai/api/v1/audio/transcriptions"
        );
        // A base that already carries /v1 does not get it doubled.
        assert_eq!(
            transcription_url(openai, "https://proxy.example/v1/"),
            "https://proxy.example/v1/audio/transcriptions"
        );
        // Custom endpoints are absolute URLs under /v1.
        assert_eq!(
            transcription_url(find("custom").unwrap(), "http://127.0.0.1:8080"),
            "http://127.0.0.1:8080/v1/audio/transcriptions"
        );
    }

    #[test]
    fn websocket_urls_match_the_protocols() {
        let deepgram = find("deepgram").unwrap();
        let url = deepgram_url(deepgram, "", "nova-3");
        assert!(url.starts_with("wss://api.deepgram.com/v1/listen?model=nova-3"));
        assert!(url.contains("interim_results=true"));
        assert!(url.contains("encoding=linear16&sample_rate=16000"));
        let realtime = find("openai-realtime").unwrap();
        assert_eq!(
            realtime_url(realtime, "", "gpt-4o-mini-transcribe"),
            "wss://api.openai.com/v1/realtime?intent=transcription"
        );
        // A Together base switches to the compatible realtime route.
        assert!(realtime_url(realtime, "wss://api.together.ai", "openai/whisper-large-v3")
            .contains("api.together.ai/v1/realtime?model=openai/whisper-large-v3&input_audio_format=pcm_s16le_16000"));
    }

    #[test]
    fn resolved_model_falls_back_to_the_preset() {
        let groq = find("groq").unwrap();
        assert_eq!(resolved_model(groq, ""), "whisper-large-v3-turbo");
        assert_eq!(resolved_model(groq, "whisper-large-v3"), "whisper-large-v3");
    }
}
