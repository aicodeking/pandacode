// Pure helpers for voice dictation (no imports): the start-options shape,
// transcript composition and locale fallback. Tested in tests/speech.test.ts.

/** The options object for `ExpoSpeechRecognitionModule.start`. */
export function startOptions(lang: string, onDeviceOnly: boolean) {
  return {
    lang,
    interimResults: true,
    addsPunctuation: true,
    requiresOnDeviceRecognition: onDeviceOnly,
    androidIntentOptions: { EXTRA_LANGUAGE_MODEL: 'language_model_free_form' as const, EXTRA_PARTIAL_RESULTS: true },
    iosTaskHint: 'dictation' as const,
  };
}

/** The composer text: what was typed before dictation, then settled finals,
    then the live partial — replacing the previous partial in place. */
export function applyTranscript(base: string, settled: string, partial: string): string {
  const gap = (left: string, right: string) => (!left || !right || /\s$/.test(left) || /^\s/.test(right) ? '' : ' ');
  const whole = settled + gap(settled, partial) + partial;
  const trimmed = whole.trim();
  if (!trimmed) return base;
  return `${base}${base && !/\s$/.test(base) ? ' ' : ''}${trimmed}`;
}

/** Finals that arrive in segments (Android's continuous mode) accumulate. */
export function appendFinal(settled: string, final: string): string {
  return applyTranscript('', settled, final).trim();
}

/** Best-effort BCP-47 tag for the phone's locale ("en-US" from "en_US"). */
export function deviceLanguage(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { NativeModules } = require('react-native') as { NativeModules: Record<string, { settings?: { AppleLocale?: string }; localeIdentifier?: string } | undefined> };
    const tag = NativeModules.SettingsManager?.settings?.AppleLocale
      ?? NativeModules.I18nManager?.localeIdentifier
      ?? '';
    return tag ? tag.replace('_', '-') : 'en-US';
  } catch {
    return 'en-US';
  }
}
