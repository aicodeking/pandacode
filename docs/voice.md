# Voice dictation

A mic button in the composer records your voice and streams the transcript
into the prompt for review before you send — the dictation model (record →
review → send), never auto-send and never a voice conversation. Everything
runs on your computer by default: nothing is bundled, nothing phones home, and
online transcription exists only if you configure a provider yourself.

## How it works

Native side, `src-tauri/src/voice/`:

- `engine` dispatch by setting: **Apple Speech** (macOS) or **local models**
  via sherpa-onnx (all platforms).
- `capture.rs` records the default input device through cpal, downmixes to
  mono and resamples to 16 kHz; the Apple engine captures with AVAudioEngine
  instead and feeds `SFSpeechAudioBufferRecognitionRequest` directly.
- `model.rs` is the catalog of downloadable models; `commands.rs` holds the
  IPC commands and the recording loop; `settings.rs` is `voice.json`.

## Engines

### Apple Speech (macOS, default)

The OS's own recognizer: no download, live punctuated partials. On-device
recognition is required whenever the locale supports it
(`requiresOnDeviceRecognition`); otherwise Apple's service handles it behind
its own consent prompt, and PandaCode itself still sends nothing anywhere.
Needs a bundled build (the usage strings live in `src-tauri/Info.plist`, which
Tauri merges into the generated bundle); an unbundled dev binary refuses
instead of crashing.

### Local models (sherpa-onnx, all platforms)

Two passes, sherpa-onnx's documented streaming pattern:

1. **Live pass** — a streaming zipformer (`live-en` English, `live-zh-en`
   Chinese/English) produces partial text while you speak, restored to
   punctuation and casing by the small `punct-en` model.
2. **Quality pass** — when recording stops, the chosen offline model
   re-decodes the whole buffer for the final transcript. **Fast mode** skips
   this pass and keeps the streaming text.

## Models (downloaded on demand, never bundled)

Settings → Voice lists the catalog with size, languages and license. Files
download from pinned URLs (Hugging Face repos under `csukuangfj/` plus one
k2-fsa GitHub release for the punctuation model) with a size cap, SHA-256
verification where the source publishes digests, and progress events; they
install under `<app data>/voice/models/<id>/`. Downloaded models stay ready;
switching the quality model downloads that one on demand.

| Model | Size | Languages | License |
| --- | --- | --- | --- |
| Moonshine Base / Tiny | ≈287 / 123 MB | en | MIT |
| SenseVoice Small (int8) | ≈239 MB | zh, en, ja, ko, yue | FunASR Model License (attribution required) |
| Parakeet TDT 0.6B v3 (int8) | ≈670 MB | 25 European | CC-BY-4.0 |
| Whisper Small (int8) | ≈375 MB | 99 | MIT |
| Live EN / bilingual ZH-EN streamers | ≈73 / 196 MB | en / zh-en | Apache-2.0 |
| Online punctuation (EN) | ≈31 MB | en | Apache-2.0 |

Defaults follow the language setting: English → Moonshine Base, Chinese/Japanese
/Korean → SenseVoice, anything else → SenseVoice then Whisper Small. Model
credits belong to their authors (Useful Sensors, Alibaba FunAudioLLM, NVIDIA,
OpenAI; runtimes by the k2-fsa sherpa-onnx project).

## Commands and events

Commands (all camelCase args, errors reject as strings): `voice_state`,
`voice_save_settings`, `voice_models`, `voice_download_model`,
`voice_start`, `voice_stop`, `voice_cancel`, `voice_providers`,
`voice_set_key`, `voice_keys`, `voice_test_provider`.

Events: `voice-partial {text}` (replaces the previous live text),
`voice-result {text, engine, fallback}`, `voice-error {message}`,
`voice-level f32` (≈10 Hz, 0..1), `voice-download {id, status, progress,
error?}`. One recording runs at a time; stop/cancel are fire-and-forget and
the worker clears the session itself.

## Interaction

Tap-to-talk (default) or hold-to-talk, per setting. Esc cancels. The recording
bar (level meter, timer, Done/Cancel) mounts on the document body so composer
re-renders never kill a recording, and dictated text works while an agent runs
(it queues or steers like typed text).

## Online providers (opt-in)

Settings → Voice has three modes: **offline** (default), **online**, and
**online with offline fallback**. Online transcription exists only when you
configure it: pick a provider, save its API key (secure store, never the
webview), and choose a model. Audio then goes to that provider — while you
speak for the streaming ones, once on stop for the multipart ones — and
nowhere else.

| Provider | Transport | Live partials | Default model |
| --- | --- | --- | --- |
| OpenAI | `POST /v1/audio/transcriptions` | no | `gpt-4o-mini-transcribe` |
| Groq | OpenAI-compatible multipart | no | `whisper-large-v3-turbo` |
| OpenRouter | OpenAI-compatible multipart | no | `openai/gpt-4o-mini-transcribe` (25+ models) |
| Together | OpenAI-compatible multipart | no | `openai/whisper-large-v3` |
| Deepgram | streaming WebSocket | yes | `nova-3` |
| OpenAI Realtime | streaming WebSocket (Together-compatible) | yes | `gpt-4o-mini-transcribe` |
| Custom | any OpenAI-compatible endpoint (self-hosted incl. localhost) | no | yours |

With fallback on, a failed online attempt (connection error, timeout, mid-stream
error) keeps the recording and settles it with the local quality model — the
result is marked as a fallback and a toast says so. Streaming providers send
16 kHz PCM (Deepgram) or 24 kHz PCM16 (OpenAI Realtime); multipart sends one
16 kHz WAV when you stop. Keys: `voice_set_key`/`voice_keys`/`voice_test_provider`
(the test sends half a second of silence through the real endpoint).

## Mobile

The app uses the phone's own speech recognition (`expo-speech-recognition` →
Apple Speech / Android `SpeechRecognizer`): on-device when the language
supports it, with an **On-device only** setting that forbids the OS's network
service. Partials stream into the composer; only the final transcript is sent,
as ordinary text over Connect. No audio ever reaches PandaCode's relay, and
the mic hides on devices with no speech service.

## Privacy

Audio goes exactly where you chose: nowhere (local models), to Apple/Google's
on-device stack, to the OS's speech service only if you allow it, or — in a
later online mode you configure yourself — to that provider. The one automatic
network request Voice ever makes is a model download you clicked. Both are in
the README privacy table.

## Verification

- `cargo test --lib voice::` — 23 unit tests (settings round-trip, resample,
  level math, download verification, install detection, language defaults).
- `npx playwright test tests/voice.spec.ts` — 4 tests (mic button states,
  live partials into the prompt, cancel, model download and selection, hold
  mode) against the preview mocks; `tests/settings.spec.ts` covers the tab.
- `npx tsc --noEmit`, `npm test` for the desktop webview; `cd mobile &&
  npx tsc --noEmit && npm test && npx expo lint` (4 speech tests).
- Live checks (ignored tests, need hardware): `PANDACODE_MIC=1 cargo test
  --lib -- --ignored voice` exercises real capture and transcription.
