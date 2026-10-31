//! Online transcription. Five transports behind one small surface:
//!
//! - [`transcribe_multipart`]: OpenAI-compatible `POST /v1/audio/transcriptions`
//!   (OpenAI, Groq, OpenRouter, Together, Mistral, and any custom endpoint);
//!   the whole recording goes up as one WAV when the user stops — final text
//!   only.
//! - [`transcribe_minimax`]: MiniMax's `POST /v1/speech_to_text`, same
//!   multipart shape with its own path and a `language` header.
//! - [`transcribe_qwen_chat`]: Alibaba Qwen's OpenAI-compatible
//!   `chat/completions` with the audio as a base64 `input_audio` part.
//! - [`DeepgramStream`]: Deepgram's WebSocket, live interim results while
//!   speaking (binary PCM16 frames out, JSON `Results` in).
//! - [`RealtimeStream`]: OpenAI Realtime transcription (Together-compatible):
//!   base64 PCM16 at 24 kHz, deltas for live partials.
//!
//! The dictation language (`auto` sends nothing) rides every transport: a
//! form field for the multipart endpoints, a header for MiniMax, `asr_options`
//! for Qwen, a query param for Deepgram, and the realtime session config.
//!
//! Keys are never logged and never reach the webview; audio only ever goes to
//! the provider the user configured. docs/voice.md documents the privacy story.

use std::time::Duration;

use base64::Engine as _;
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};

use super::providers::{self, Provider};

pub(crate) const SAMPLE_RATE: i32 = 16_000;
/// Realtime audio is PCM16 at 24 kHz; the 16 kHz capture is upsampled.
const REALTIME_RATE: i32 = 24_000;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// A live streaming transcription. `feed` accepts 16 kHz mono samples; the
/// reader task calls `on_partial` as interim text arrives (full text so far,
/// mirroring `voice-partial` semantics). `finish` closes the stream and
/// resolves to the final transcript.
pub struct OnlineStream {
    sender: futures_util::stream::SplitSink<tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>, Message>,
    final_rx: tokio::sync::oneshot::Receiver<Result<String, String>>,
    /// Downsampling state for the realtime upconverter.
    position: f64,
    realtime: bool,
}

/// A finished-but-not-yet-final multipart recording: call on stop. `language`
/// is the optional ISO-639-1 hint from the dictation setting; every
/// OpenAI-compatible transcription endpoint accepts the field.
pub async fn transcribe_multipart(
    provider: &Provider,
    base_override: &str,
    model: &str,
    key: &str,
    samples: &[f32],
    language: Option<&str>,
) -> Result<String, String> {
    let wav = encode_wav(samples, SAMPLE_RATE)?;
    let url = providers::transcription_url(provider, base_override);
    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?;
    let part = reqwest::multipart::Part::bytes(wav)
        .file_name("audio.wav")
        .mime_str("audio/wav")
        .map_err(|e| e.to_string())?;
    let mut form = reqwest::multipart::Form::new()
        .part("file", part)
        .text("model", model.to_string())
        .text("response_format", "json");
    if let Some(code) = language {
        form = form.text("language", code.to_string());
    }
    let response = client
        .post(&url)
        .header("Authorization", format!("{} {key}", provider.token_scheme))
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("Could not reach {url}: {e}"))?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!(
            "{} returned {}: {}",
            provider.label,
            status.as_u16(),
            truncate(&body, 200)
        ));
    }
    let json: serde_json::Value = serde_json::from_str(&body)
        .map_err(|_| format!("{} returned an unreadable response.", provider.label))?;
    json["text"]
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("{} returned no transcript.", provider.label))
}

/// MiniMax's `POST /v1/speech_to_text`: the multipart shape of the
/// OpenAI-compatible endpoints, but the language hint rides a lowercase
/// header instead of a form field and the path is its own.
pub async fn transcribe_minimax(
    provider: &Provider,
    base_override: &str,
    model: &str,
    key: &str,
    samples: &[f32],
    language: Option<&str>,
) -> Result<String, String> {
    let wav = encode_wav(samples, SAMPLE_RATE)?;
    let part = reqwest::multipart::Part::bytes(wav)
        .file_name("audio.wav")
        .mime_str("audio/wav")
        .map_err(|e| e.to_string())?;
    let form = reqwest::multipart::Form::new()
        .part("file", part)
        .text("model", model.to_string())
        .text("response_format", "json");
    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?;
    let mut request = client
        .post(providers::transcription_url(provider, base_override))
        .header("Authorization", format!("{} {key}", provider.token_scheme));
    if let Some(code) = language {
        request = request.header("language", code);
    }
    let response = request
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("Could not reach the MiniMax endpoint: {e}"))?;
    read_text_answer(provider, response).await
}

/// Alibaba Qwen's OpenAI-compatible transcription: a `chat/completions` call
/// whose user message carries the audio as a base64 `input_audio` part; the
/// transcript comes back in `choices[0].message.content` and the language
/// hint goes into the non-standard `asr_options` object.
pub async fn transcribe_qwen_chat(
    provider: &Provider,
    base_override: &str,
    model: &str,
    key: &str,
    samples: &[f32],
    language: Option<&str>,
) -> Result<String, String> {
    let wav = encode_wav(samples, SAMPLE_RATE)?;
    let mut body = json!({
        "model": model,
        "messages": [{
            "role": "user",
            "content": [{
                "type": "input_audio",
                "input_audio": {
                    "data": format!(
                        "data:audio/wav;base64,{}",
                        base64::engine::general_purpose::STANDARD.encode(wav)
                    ),
                },
            }],
        }],
    });
    if let Some(code) = language {
        body["asr_options"] = json!({ "language": code });
    }
    let url = providers::transcription_url(provider, base_override);
    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?;
    let response = client
        .post(&url)
        .header("Authorization", format!("{} {key}", provider.token_scheme))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Could not reach {url}: {e}"))?;
    let status = response.status();
    let answer = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!(
            "{} returned {}: {}",
            provider.label,
            status.as_u16(),
            truncate(&answer, 200)
        ));
    }
    let json: serde_json::Value = serde_json::from_str(&answer)
        .map_err(|_| format!("{} returned an unreadable response.", provider.label))?;
    json["choices"][0]["message"]["content"]
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("{} returned no transcript.", provider.label))
}

/// Turns a transcription HTTP answer into the transcript, or a provider error
/// (the OpenAI-style `text` field MiniMax's envelope also carries).
async fn read_text_answer(
    provider: &Provider,
    response: reqwest::Response,
) -> Result<String, String> {
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!(
            "{} returned {}: {}",
            provider.label,
            status.as_u16(),
            truncate(&body, 200)
        ));
    }
    let json: serde_json::Value = serde_json::from_str(&body)
        .map_err(|_| format!("{} returned an unreadable response.", provider.label))?;
    json["text"]
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("{} returned no transcript.", provider.label))
}

/// 16 kHz mono f32 → 16-bit PCM WAV in memory.
pub fn encode_wav(samples: &[f32], sample_rate: i32) -> Result<Vec<u8>, String> {
    let mut cursor = std::io::Cursor::new(Vec::new());
    let writer = hound::WavWriter::new(&mut cursor, hound::WavSpec {
        channels: 1,
        sample_rate: sample_rate as u32,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    })
    .map_err(|e| e.to_string())?;
    {
        let mut writer = writer;
        for sample in samples {
            writer
                .write_sample((sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16)
                .map_err(|e| e.to_string())?;
        }
        writer.finalize().map_err(|e| e.to_string())?;
    }
    Ok(cursor.into_inner())
}

/// Opens Deepgram's streaming session.
pub async fn connect_deepgram(
    url: &str,
    key: &str,
    on_partial: impl Fn(String) + Send + 'static,
) -> Result<OnlineStream, String> {
    let mut request = url
        .into_client_request()
        .map_err(|e| format!("Bad Deepgram URL: {e}"))?;
    request.headers_mut().insert(
        "Authorization",
        format!("Token {key}").parse().map_err(|_| "Bad key characters".to_string())?,
    );
    let (stream, _) = tokio::time::timeout(
        CONNECT_TIMEOUT,
        tokio_tungstenite::connect_async(request),
    )
    .await
    .map_err(|_| "Deepgram did not answer in time.".to_string())?
    .map_err(|e| format!("Could not connect to Deepgram: {e}"))?;
    let (sender, mut reader) = stream.split();
    let (final_tx, final_rx) = tokio::sync::oneshot::channel();
    let mut settled = String::new();
    tokio::spawn(async move {
        let mut result: Result<String, String> = Err("The Deepgram stream ended without a transcript.".into());
        loop {
            match tokio::time::timeout(Duration::from_secs(120), reader.next()).await {
                Ok(Some(Ok(Message::Text(text)))) => {
                    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
                    let transcript = value["channel"]["alternatives"][0]["transcript"]
                        .as_str()
                        .unwrap_or_default()
                        .to_string();
                    let is_final = value["is_final"].as_bool().unwrap_or(false);
                    if is_final && !transcript.is_empty() {
                        if !settled.is_empty() && !settled.ends_with(' ') {
                            settled.push(' ');
                        }
                        settled.push_str(&transcript);
                        on_partial(settled.clone());
                    } else if !transcript.is_empty() {
                        let mut live = settled.clone();
                        if !live.is_empty() {
                            live.push(' ');
                        }
                        live.push_str(&transcript);
                        on_partial(live);
                    }
                }
                Ok(Some(Ok(Message::Close(_)))) | Ok(None) | Err(_) => break,
                Ok(Some(Ok(_))) => {}
                Ok(Some(Err(error))) => {
                    result = Err(format!("Deepgram stream error: {error}"));
                    break;
                }
            }
        }
        let _ = final_tx.send(if settled.trim().is_empty() { result } else { Ok(settled.trim().to_string()) });
    });
    Ok(OnlineStream { sender, final_rx, position: 0.0, realtime: false })
}

impl OnlineStream {
    /// Feeds 16 kHz mono samples.
    pub async fn feed(&mut self, chunk: &[f32]) -> Result<(), String> {
        if chunk.is_empty() {
            return Ok(());
        }
        let message = if self.realtime {
            let upsampled = upsample(chunk, SAMPLE_RATE, REALTIME_RATE, &mut self.position);
            let pcm = to_pcm16(&upsampled);
            Message::Text(
                json!({ "type": "input_audio_buffer.append", "audio": base64::engine::general_purpose::STANDARD.encode(pcm) })
                    .to_string()
                    .into(),
            )
        } else {
            Message::Binary(to_pcm16(chunk).into())
        };
        self.sender.send(message).await.map_err(|e| format!("The transcription stream closed: {e}"))
    }

    /// Flushes and waits for the provider's final transcript.
    pub async fn finish(mut self) -> Result<String, String> {
        let close = if self.realtime {
            json!({ "type": "input_audio_buffer.commit" }).to_string()
        } else {
            json!({ "type": "Finalize" }).to_string()
        };
        let _ = self.sender.send(Message::Text(close.into())).await;
        let _ = self
            .sender
            .send(if self.realtime {
                Message::Close(None)
            } else {
                Message::Text(json!({ "type": "CloseStream" }).to_string().into())
            })
            .await;
        match tokio::time::timeout(Duration::from_secs(10), self.final_rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("The transcription stream ended unexpectedly.".into()),
            Err(_) => Err("The provider did not return a final transcript in time.".into()),
        }
    }
}

/// Opens an OpenAI Realtime transcription session (Together-compatible bases).
/// `language` is the optional ISO-639-1 hint from the dictation setting.
pub async fn connect_realtime(
    url: &str,
    key: &str,
    model: &str,
    language: Option<&str>,
    on_partial: impl Fn(String) + Send + 'static,
) -> Result<OnlineStream, String> {
    let mut request = url
        .into_client_request()
        .map_err(|e| format!("Bad realtime URL: {e}"))?;
    request.headers_mut().insert(
        "Authorization",
        format!("Bearer {key}").parse().map_err(|_| "Bad key characters".to_string())?,
    );
    let (stream, _) = tokio::time::timeout(
        CONNECT_TIMEOUT,
        tokio_tungstenite::connect_async(request),
    )
    .await
    .map_err(|_| "The realtime service did not answer in time.".to_string())?
    .map_err(|e| format!("Could not connect to the realtime service: {e}"))?;
    let (mut sender, mut reader) = stream.split();
    let transcription = match language {
        Some(code) => json!({ "model": model, "language": code }),
        None => json!({ "model": model }),
    };
    sender
        .send(Message::Text(
            json!({
                "type": "session.update",
                "session": {
                    "input_audio_format": "pcm16",
                    "input_audio_transcription": transcription,
                    "turn_detection": { "type": "server_vad" }
                }
            })
            .to_string()
            .into(),
        ))
        .await
        .map_err(|e| format!("The realtime session failed to start: {e}"))?;
    let (final_tx, final_rx) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        let mut settled = String::new();
        let mut utterance = String::new();
        let mut failure: Option<String> = None;
        loop {
            match tokio::time::timeout(Duration::from_secs(120), reader.next()).await {
                Ok(Some(Ok(Message::Text(text)))) => {
                    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
                    match value["type"].as_str().unwrap_or_default() {
                        "conversation.item.input_audio_transcription.delta" => {
                            if let Some(delta) = value["delta"].as_str() {
                                utterance.push_str(delta);
                                let mut live = settled.clone();
                                if !live.is_empty() && !utterance.is_empty() {
                                    live.push(' ');
                                }
                                live.push_str(&utterance);
                                on_partial(live);
                            }
                        }
                        "conversation.item.input_audio_transcription.completed" => {
                            let final_text = value["transcript"].as_str().unwrap_or_default();
                            if !final_text.is_empty() {
                                if !settled.is_empty() {
                                    settled.push(' ');
                                }
                                settled.push_str(final_text);
                                on_partial(settled.clone());
                            }
                            utterance.clear();
                        }
                        "conversation.item.input_audio_transcription.failed" | "error" => {
                            failure = Some(
                                value["error"]["message"]
                                    .as_str()
                                    .or(value["message"].as_str())
                                    .unwrap_or("The realtime service reported an error.")
                                    .to_string(),
                            );
                            break;
                        }
                        _ => {}
                    }
                }
                Ok(Some(Ok(Message::Close(_)))) | Ok(None) | Err(_) => break,
                Ok(Some(Ok(_))) => {}
                Ok(Some(Err(error))) => {
                    failure = Some(format!("Realtime stream error: {error}"));
                    break;
                }
            }
        }
        let _ = final_tx.send(match failure {
            Some(error) if settled.trim().is_empty() => Err(error),
            _ if settled.trim().is_empty() => Err("The realtime stream ended without a transcript.".into()),
            _ => Ok(settled.trim().to_string()),
        });
    });
    Ok(OnlineStream { sender, final_rx, position: 0.0, realtime: true })
}

fn to_pcm16(samples: &[f32]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(samples.len() * 2);
    for sample in samples {
        let clamped = sample.clamp(-1.0, 1.0);
        bytes.extend_from_slice(&((clamped * i16::MAX as f32) as i16).to_le_bytes());
    }
    bytes
}

/// Linear 16k → 24k upconverter; `position` carries phase between calls.
pub fn upsample(samples: &[f32], from: i32, to: i32, position: &mut f64) -> Vec<f32> {
    if from == to || samples.is_empty() {
        return samples.to_vec();
    }
    let ratio = to as f64 / from as f64;
    let mut out = Vec::with_capacity((samples.len() as f64 * ratio) as usize);
    let mut index = *position as usize;
    while index + 1 < samples.len() {
        let frac = *position - index as f64;
        let a = samples[index];
        let b = samples[index + 1];
        out.push(a + (b - a) * frac as f32);
        *position += 1.0 / ratio;
        index = *position as usize;
    }
    *position -= index as f64;
    out
}

fn truncate(text: &str, max: usize) -> &str {
    match text.char_indices().nth(max) {
        Some((index, _)) => &text[..index],
        None => text,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wav_encode_round_trips_through_hound() {
        let samples: Vec<f32> = vec![0.0, 0.5, -0.5, 1.0];
        let bytes = encode_wav(&samples, 16_000).unwrap();
        let mut reader = hound::WavReader::new(std::io::Cursor::new(bytes)).unwrap();
        assert_eq!(reader.spec().sample_rate, 16_000);
        assert_eq!(reader.spec().channels, 1);
        let decoded: Vec<i16> = reader.samples::<i16>().map(|s| s.unwrap()).collect();
        assert_eq!(decoded.len(), 4);
        assert!(decoded[3] > 32_000 && decoded[1] > 16_000 && decoded[2] < -16_000);
    }

    #[test]
    fn pcm16_is_little_endian_and_clamped() {
        let bytes = to_pcm16(&[1.5, -1.5, 0.5]);
        assert_eq!(bytes.len(), 6);
        assert_eq!(i16::from_le_bytes([bytes[0], bytes[1]]), i16::MAX);
        assert_eq!(i16::from_le_bytes([bytes[2], bytes[3]]), -i16::MAX);
        assert!(i16::from_le_bytes([bytes[4], bytes[5]]) > 16_000);
    }

    /// A loopback WebSocket server for the streaming clients: runs `handler`
    /// on the accepted socket and answers on an ephemeral port.
    fn ws_server(handler: impl FnOnce(tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> + Send + 'static) -> String {
        use tokio_tungstenite::accept_async;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let (socket, _) = listener.accept().unwrap();
            socket.set_nonblocking(true).unwrap();
            let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
            runtime.block_on(async move {
                let socket = tokio::net::TcpStream::from_std(socket).unwrap();
                let stream = accept_async(socket).await.unwrap();
                handler(stream).await;
            });
        });
        format!("ws://127.0.0.1:{port}")
    }

    #[tokio::test]
    async fn deepgram_stream_sends_pcm_and_composes_results() {
        use futures_util::{SinkExt, StreamExt};
        let url = ws_server(move |stream| Box::pin(async move {
            let (mut sink, mut reader) = stream.split();
            // First message: the client's binary PCM16 feed.
            let first = tokio::time::timeout(Duration::from_secs(5), reader.next()).await;
            if let Ok(Some(Ok(Message::Binary(pcm)))) = first {
                assert_eq!(pcm.len(), 4); // two f32 samples → two i16 frames
            }
            // Interim, then final, then close.
            let _ = sink.send(Message::Text(
                serde_json::json!({"channel":{"alternatives":[{"transcript":"hello"}]},"is_final":false}).to_string().into(),
            )).await;
            let _ = sink.send(Message::Text(
                serde_json::json!({"channel":{"alternatives":[{"transcript":"hello world"}]},"is_final":true}).to_string().into(),
            )).await;
            // The client's Finalize and CloseStream arrive next.
            let _ = tokio::time::timeout(Duration::from_secs(5), reader.next()).await;
            let _ = sink.send(Message::Close(None)).await;
        }));
        let partials = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let seen = partials.clone();
        let mut stream = connect_deepgram(&url, "test-key", move |text| {
            seen.lock().unwrap().push(text);
        })
        .await
        .unwrap();
        stream.feed(&[0.25f32, -0.25]).await.unwrap();
        let text = stream.finish().await.unwrap();
        assert_eq!(text, "hello world");
        // Interims and finals both stream; the last partial is the full text.
        let partials = partials.lock().unwrap();
        assert!(partials.contains(&"hello".to_string()));
        assert_eq!(partials.last().unwrap(), "hello world");
    }

    #[tokio::test]
    async fn realtime_stream_configures_the_session_and_accumulates_deltas() {
        use futures_util::{SinkExt, StreamExt};
        let url = ws_server(move |stream| Box::pin(async move {
            let (mut sink, mut reader) = stream.split();
            // First client message: session.update with the model.
            let first = tokio::time::timeout(Duration::from_secs(5), reader.next()).await;
            match first {
                Ok(Some(Ok(Message::Text(text)))) => {
                    let value: serde_json::Value = serde_json::from_str(text.as_str()).unwrap();
                    assert_eq!(value["type"], "session.update");
                    assert_eq!(value["session"]["input_audio_transcription"]["model"], "gpt-4o-mini-transcribe");
                }
                other => panic!("expected session.update, got {other:?}"),
            }
            // Then the base64 append.
            let second = tokio::time::timeout(Duration::from_secs(5), reader.next()).await;
            if let Ok(Some(Ok(Message::Text(text)))) = second {
                let value: serde_json::Value = serde_json::from_str(text.as_str()).unwrap();
                assert_eq!(value["type"], "input_audio_buffer.append");
                assert!(!value["audio"].as_str().unwrap().is_empty());
            }
            let _ = sink.send(Message::Text(
                serde_json::json!({"type":"conversation.item.input_audio_transcription.delta","delta":"Good"}).to_string().into(),
            )).await;
            let _ = sink.send(Message::Text(
                serde_json::json!({"type":"conversation.item.input_audio_transcription.delta","delta":" morning"}).to_string().into(),
            )).await;
            let _ = sink.send(Message::Text(
                serde_json::json!({"type":"conversation.item.input_audio_transcription.completed","transcript":"Good morning."}).to_string().into(),
            )).await;
            let _ = tokio::time::timeout(Duration::from_secs(5), reader.next()).await;
            let _ = sink.send(Message::Close(None)).await;
        }));
        let partials = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let seen = partials.clone();
        let mut stream = connect_realtime(&url, "test-key", "gpt-4o-mini-transcribe", None, move |text| {
            seen.lock().unwrap().push(text);
        })
        .await
        .unwrap();
        stream.feed(&[0.25f32, -0.25]).await.unwrap();
        let text = stream.finish().await.unwrap();
        assert_eq!(text, "Good morning.");
        // Deltas compose live: "Good", then "Good morning", then the final.
        let partials = partials.lock().unwrap();
        assert!(partials.contains(&"Good".to_string()));
        assert!(partials.contains(&"Good morning".to_string()));
    }

    #[tokio::test]
    async fn a_provider_error_without_a_transcript_fails_the_stream() {
        use futures_util::StreamExt;
        let url = ws_server(move |stream| Box::pin(async move {
            let (sink, mut reader) = stream.split();
            let _ = sink;
            let _ = tokio::time::timeout(Duration::from_secs(5), reader.next()).await;
            let _ = tokio::time::timeout(Duration::from_secs(5), reader.next()).await;
        }));
        let stream = connect_realtime(&url, "test-key", "gpt-4o-mini-transcribe", None, |_| {}).await.unwrap();
        // The server drops without sending a transcript: whatever the exact
        // wording, finish() must fail rather than return empty success.
        let error = stream.finish().await.unwrap_err();
        assert!(!error.trim().is_empty(), "{error}");
    }

    #[test]
    fn upsample_16_to_24k_keeps_the_shape() {
        let input: Vec<f32> = (0..160).map(|i| (i as f32 / 10.0).sin()).collect();
        let mut position = 0.0;
        let out = upsample(&input, 16_000, 24_000, &mut position);
        assert!((out.len() as i64 - 240).abs() <= 1, "{}", out.len());
        // Feeding again continues the stream without panicking.
        let more = upsample(&input, 16_000, 24_000, &mut position);
        assert!(!more.is_empty());
        // Same-rate passthrough.
        assert_eq!(upsample(&input, 16_000, 16_000, &mut 0.0), input);
    }

    #[test]
    fn long_errors_are_truncated() {
        let text = "x".repeat(500);
        assert_eq!(truncate(&text, 200).len(), 200);
    }

    /// A loopback HTTP server: replies with `response` and hands the raw
    /// request (head + body) to `inspect`.
    fn http_server(response: String, inspect: std::sync::mpsc::Sender<String>) -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut head = Vec::new();
            let mut byte = [0u8; 1];
            loop {
                std::io::Read::read(&mut socket, &mut byte).unwrap();
                head.push(byte[0]);
                if head.ends_with(b"\r\n\r\n") {
                    break;
                }
            }
            let head = String::from_utf8_lossy(&head).into_owned();
            let length: usize = head
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length").then(|| value.trim().parse().ok())?
                })
                .unwrap_or(0);
            let mut body = vec![0u8; length];
            std::io::Read::read_exact(&mut socket, &mut body).unwrap();
            let _ = inspect.send(format!("{head}{}", String::from_utf8_lossy(&body)));
            std::io::Write::write_all(&mut socket, response.as_bytes()).unwrap();
        });
        format!("http://127.0.0.1:{port}")
    }

    fn json_ok(body: &str) -> String {
        format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{body}")
    }

    #[tokio::test]
    async fn multipart_request_carries_the_language_hint_when_pinned() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        for (language, expect_field) in [(Some("en"), true), (None, false)] {
            let (tx, rx) = std::sync::mpsc::channel();
            let url = http_server(json_ok("{\"text\":\"hi there\"}"), tx);
            let text = transcribe_multipart(
                providers::find("openai").unwrap(),
                &url,
                "gpt-4o-mini-transcribe",
                "test-key",
                &[0.25f32, -0.25],
                language,
            )
            .await
            .unwrap();
            assert_eq!(text, "hi there");
            let raw = rx.recv_timeout(Duration::from_secs(5)).unwrap();
            let (head, body) = raw.split_once("\r\n\r\n").unwrap();
            assert!(head.contains("authorization: Bearer test-key"), "{head}");
            assert!(body.contains("name=\"model\""), "{body}");
            assert_eq!(body.contains("name=\"language\""), expect_field, "{body}");
            if expect_field {
                assert!(body.contains("name=\"language\"\r\n\r\nen"), "{body}");
            }
        }
    }

    #[tokio::test]
    async fn minimax_sends_the_language_header_and_reads_text() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        for (language, expect_header) in [(Some("en"), true), (None, false)] {
            let (tx, rx) = std::sync::mpsc::channel();
            let url = http_server(json_ok("{\"text\":\"hi there\",\"duration\":0.5}"), tx);
            let text = transcribe_minimax(
                providers::find("minimax").unwrap(),
                &url,
                "asr-1.0",
                "test-key",
                &[0.25f32, -0.25],
                language,
            )
            .await
            .unwrap();
            assert_eq!(text, "hi there");
            let raw = rx.recv_timeout(Duration::from_secs(5)).unwrap();
            let (head, body) = raw.split_once("\r\n\r\n").unwrap();
            assert!(head.contains("POST /v1/speech_to_text"), "{head}");
            assert!(head.contains("authorization: Bearer test-key"), "{head}");
            assert_eq!(head.contains("language: en"), expect_header, "{head}");
            // MiniMax pins the language by header, never a form field.
            assert!(!body.contains("name=\"language\""), "{body}");
        }
    }

    #[tokio::test]
    async fn qwen_chat_sends_base64_audio_and_reads_the_message_content() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        for (language, expect_options) in [(Some("zh"), true), (None, false)] {
            let (tx, rx) = std::sync::mpsc::channel();
            let url = http_server(
                json_ok(
                    "{\"choices\":[{\"message\":{\"role\":\"assistant\",\"content\":\"welcome home\"}}]}",
                ),
                tx,
            );
            let text = transcribe_qwen_chat(
                providers::find("alibaba").unwrap(),
                &url,
                "qwen3-asr-flash",
                "test-key",
                &[0.25f32, -0.25],
                language,
            )
            .await
            .unwrap();
            assert_eq!(text, "welcome home");
            let raw = rx.recv_timeout(Duration::from_secs(5)).unwrap();
            let (head, body) = raw.split_once("\r\n\r\n").unwrap();
            assert!(head.contains("POST /chat/completions"), "{head}");
            assert!(head.contains("content-type: application/json"), "{head}");
            assert!(head.contains("authorization: Bearer test-key"), "{head}");
            let value: serde_json::Value = serde_json::from_str(body).unwrap();
            assert_eq!(value["model"], "qwen3-asr-flash");
            let audio = &value["messages"][0]["content"][0];
            assert_eq!(audio["type"], "input_audio");
            assert!(
                audio["input_audio"]["data"]
                    .as_str()
                    .unwrap()
                    .starts_with("data:audio/wav;base64,"),
                "{audio}"
            );
            assert_eq!(value["asr_options"].is_object(), expect_options, "{body}");
            if expect_options {
                assert_eq!(value["asr_options"]["language"], "zh");
            }
        }
    }
}
