// Voice input for the composer: the phone's own speech recognition (Apple
// Speech on iOS, SpeechRecognizer on Android), on-device when the language
// supports it. Partials stream into the composer text; only the final
// transcript is ever sent, as ordinary text over Connect — audio never leaves
// the phone except when the OS's own consent-gated service is used, and the
// "On-device only" setting forbids even that. docs/voice.md has the details.
import { create } from 'zustand';
import { applyTranscript, appendFinal, deviceLanguage, startOptions } from './speech-text.ts';
import { get, set } from '../connect/secrets.ts';

export { applyTranscript, appendFinal, deviceLanguage, startOptions };

const ON_DEVICE_KEY = 'voiceOnDeviceOnly';

export type VoiceState = {
  /** null until probed; false hides the mic (no speech service on the device). */
  supported: boolean | null;
  recording: boolean;
  onDeviceOnly: boolean;
  error: string;
};

export const useVoice = create<VoiceState>(() => ({ supported: null, recording: false, onDeviceOnly: false, error: '' }));

export function setOnDeviceOnly(value: boolean) {
  useVoice.setState({ onDeviceOnly: value });
  set(ON_DEVICE_KEY, value ? 'true' : 'false').catch(() => undefined);
}

/** Call once at start; a missing value keeps the OS fallback allowed. */
export async function loadVoicePreference() {
  const stored = await get(ON_DEVICE_KEY);
  useVoice.setState({ onDeviceOnly: stored === 'true' });
  void initSpeech();
}

type SpeechModule = {
  start(options: Record<string, unknown>): void;
  stop(): void;
  abort(): void;
  supportsOnDeviceRecognition(): boolean;
  isRecognitionAvailable(): boolean;
  requestPermissionsAsync(): Promise<{ granted: boolean }>;
  addListener(event: string, listener: (event: never) => void): { remove(): void };
};

let speechModule: SpeechModule | null = null;
let base = '', settled = '', subscribed = false;

/** Probes the device once; the composer watches `supported` to show the mic. */
export async function initSpeech(): Promise<boolean> {
  if (speechModule) return useVoice.getState().supported === true;
  try {
    const imported = await import('expo-speech-recognition');
    const speech = imported.ExpoSpeechRecognitionModule as unknown as SpeechModule;
    const available = speech.isRecognitionAvailable();
    speechModule = speech;
    if (!subscribed) {
      subscribed = true;
      speech.addListener('result', event => {
        const result = event as { isFinal: boolean; results: { transcript: string }[] };
        const transcript = result.results?.[0]?.transcript ?? '';
        if (result.isFinal) settled = appendFinal(settled, transcript);
        const partial = result.isFinal ? '' : transcript;
        useVoice.setState({ error: '' });
        onTranscript(applyTranscript(base, settled, partial));
      });
      speech.addListener('error', event => {
        const error = event as { error: string; message?: string };
        const readable = error.error === 'not-authorized'
          ? 'Speech recognition is not permitted for PandaCode.'
          : error.error === 'service-not-allowed'
            ? 'This device has no speech recognition service.'
            : error.error === 'no-speech' ? '' : `Voice input failed (${error.error}).`;
        if (error.error !== 'no-speech' && error.error !== 'aborted') {
          useVoice.setState({ error: readable, recording: false });
          onTranscript(base + (settled ? ` ${settled}` : ''));
          settled = '';
        }
      });
      speech.addListener('end', () => {
        // Android ends the session per segment; iOS ends per task. The settled
        // finals stay either way, so a result arriving after `end` still keeps
        // the earlier segments; startDictation and the error path clear them.
        useVoice.setState({ recording: false });
      });
    }
    useVoice.setState({ supported: available });
    return available;
  } catch {
    useVoice.setState({ supported: false });
    return false;
  }
}

/** The composer registers this to receive composed text as it arrives. */
let onTranscript: (text: string) => void = () => undefined;

export function onDictation(handler: (text: string) => void): () => void {
  onTranscript = handler;
  return () => { if (onTranscript === handler) onTranscript = () => undefined; };
}

export async function startDictation(currentText: string, lang?: string): Promise<boolean> {
  if (!speechModule || useVoice.getState().recording) return false;
  const permission = await speechModule.requestPermissionsAsync();
  if (!permission.granted) {
    useVoice.setState({ error: 'Microphone access is off for PandaCode.' });
    return false;
  }
  base = currentText;
  settled = '';
  const { onDeviceOnly } = useVoice.getState();
  try {
    speechModule.start(startOptions(lang ?? deviceLanguage(), onDeviceOnly));
    useVoice.setState({ recording: true, error: '' });
    return true;
  } catch {
    useVoice.setState({ error: 'Voice input could not start.', recording: false });
    return false;
  }
}

export function stopDictation(): void {
  // stop() lets the recognizer flush its final result before ending.
  speechModule?.stop();
}

export function cancelDictation(): void {
  speechModule?.abort();
  useVoice.setState({ recording: false });
}

