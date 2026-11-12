/** Dictation has its own providers; agent harnesses and routing do not select speech models. */
export type VoiceProvider = 'openai' | 'groq' | 'mistral' | 'custom';

export interface VoiceProfile {
  id: string;
  name: string;
  provider: VoiceProvider;
  /** Full transcription URL, including the route; permits existing local servers. */
  endpoint: string;
  model: string;
  language: string | null;
  hasKey: boolean;
}

export interface VoiceProfileInput {
  id?: string;
  name: string;
  provider: VoiceProvider;
  endpoint: string;
  model: string;
  language: string | null;
  /** Omitted preserves the stored key; empty removes it. Keys are never returned. */
  key?: string;
}

export interface VoiceConfiguration {
  selectedProfileId: string | null;
  profiles: VoiceProfile[];
  limits: { maxSeconds: number; maxAudioBytes: number };
}

export interface VoiceStarted { captureId: string }
export interface VoiceTranscript { captureId: string; text: string }
/** `voice://transcript`: closing the window stopped and transcribed this dictation (native also returns it to a later
 * `voice_stop` for the capture). A failure arrives as a voice-event "error" instead. */
export interface VoiceClosedTranscript { captureId: string; requestId: string; text: string }
/** `voice://mic-test-level`: the microphone test's live input level, 0..1, ~10–20 Hz. */
export interface VoiceMicLevelEvent { level: number }
/** `voice://test-ended`: native stopped a Settings mic or model test on its own (`closed`: the window was closing).
 * The test card goes back to idle without an error; nothing is left to stop or cancel. */
export interface VoiceTestEnded { kind: 'mic' | 'model'; reason: 'closed' }
/** Stop/Retry rejection; retryable means native retained the original audio and profile. */
export interface VoiceFailure { message: string; retryable: boolean }
export interface VoiceEvent {
  captureId: string;
  requestId: string;
  phase: 'recording' | 'transcribing' | 'error' | 'cancelled';
  elapsedMs: number;
  /** Measured input level, normalized to 0..1. */
  level: number;
  message?: string;
}

/** Suggestions, never contacted or enabled until a user configures and starts dictation. */
export const VOICE_PRESETS: { provider: VoiceProvider; name: string; endpoint: string; models: string[] }[] = [
  { provider: 'openai', name: 'OpenAI', endpoint: 'https://api.openai.com/v1/audio/transcriptions', models: ['gpt-transcribe', 'gpt-4o-transcribe', 'gpt-4o-mini-transcribe', 'whisper-1'] },
  { provider: 'groq', name: 'Groq', endpoint: 'https://api.groq.com/openai/v1/audio/transcriptions', models: ['whisper-large-v3-turbo', 'whisper-large-v3'] },
  { provider: 'mistral', name: 'Mistral', endpoint: 'https://api.mistral.ai/v1/audio/transcriptions', models: ['voxtral-mini-transcribe-3-0'] },
  { provider: 'custom', name: 'Local or custom server', endpoint: 'http://127.0.0.1:8080/inference', models: ['whisper-1'] },
];

/** Built-in local speech models (IPC `voice_local_*`); download and inference run natively. */
export type VoiceLocalModelState = 'downloadable' | 'downloading' | 'verifying' | 'installed';
export interface VoiceLocalAccuracy { grade: string; errorPercent: number }
/** `secondsPer30s` is null when the benchmark measured accuracy but not speed (Voxtral Small 24B, for one). */
export interface VoiceLocalBenchmark { accuracy: Record<string, VoiceLocalAccuracy>; secondsPer30s: number | null }
export interface VoiceLocalModel {
  id: string; revision: string; name: string; description: string; filename: string;
  /** Download size in bytes. */
  size: number; sha256: string; license: string;
  /** Licence text URL, when the catalog knows one; opened in the system browser. */
  licenseUrl?: string;
  /** Language codes (BCP 47 base, such as en or zh). */
  languages: string[];
  benchmark: VoiceLocalBenchmark | null;
  recommended: boolean; supportsStreaming: boolean; supportsLanguageDetection: boolean; supportsTranslation: boolean;
  maxAudioMs?: number; supportsLongForm?: boolean;
  state: VoiceLocalModelState;
  /** Bytes downloaded so far: while downloading, or a resumable partial download of a downloadable model. */
  downloaded?: number;
  active: boolean;
}
/** The Silero voice-activity model, downloaded after the first speech model; reported here, never as a model's state. */
/** `unavailable` (size 0): the catalog ships no voice-activity model, so none is downloaded. */
export interface VoiceLocalVad { state: VoiceLocalModelState | 'unavailable'; downloaded?: number; size: number }
export interface VoiceLocalCatalog {
  models: VoiceLocalModel[]; vad: VoiceLocalVad; platformSupported: boolean; defaultModel?: string | null;
  /** Why local models can't run here (native sets it when `platformSupported` is false), shown in Settings and the setup hint. */
  unsupportedReason?: string | null;
}
/** Event `voice://local-model`: download progress, verification and failures. */
export interface VoiceLocalModelEvent { modelId: string; state: VoiceLocalModelState; downloaded: number; size: number; error?: string }
/** `cancelled` (never set on a normal result) when a Stop ended a start that was still pending: nothing was recorded. */
export interface VoiceLocalTestResult { text: string; cancelled?: true }
/** Native rejects a pending test or dictation Start with exactly this once a Stop, Cancel or newer Start ends it. */
export const VOICE_CANCELLED = 'Voice input was cancelled.';
/** `voice_local_test_model` arguments: start names the card's installed model; stop and cancel end the running test. */
export type VoiceLocalTestRequest = { action: 'start'; modelId: string } | { action: 'stop' | 'cancel' };

export interface VoiceMicDevice { id: string; name: string; isDefault: boolean }
/** `cancelled` (never set on a normal result) when a Stop ended a start that was still pending: no audio. */
export interface VoiceMicTestResult { wavBase64: string; durationMs: number; cancelled?: true }

export type VoiceDestination = 'local' | 'off' | { profileId: string };
export type VoiceShortcutMode = 'auto' | 'hold' | 'toggle';
export type VoiceUnloadAfter = 'immediately' | 'min_2' | 'min_5' | 'min_10' | 'min_15' | 'hour_1';
export interface VoicePreferences {
  destination: VoiceDestination;
  /** Saved input device name; null follows the system default. */
  deviceName: string | null;
  shortcutMode: VoiceShortcutMode;
  language: 'auto' | string;
  unloadAfter: VoiceUnloadAfter;
  selectedModel: string | null;
}
