import { VoiceKeyActions, type VoiceKeys } from './voice-key-actions.ts';
export function bindVoiceDictationKeys(host: VoiceKeys) {
  const keys = new VoiceKeyActions(host);
  document.addEventListener('keydown', keys.keydown, true);
  document.addEventListener('keyup', keys.keyup, true);
  window.addEventListener('blur', keys.blur);
  document.addEventListener('submit', keys.submit, true);
  document.addEventListener('click', keys.click);
}
