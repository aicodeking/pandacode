import { icon } from './dom';
import { VOICE_PRESETS, type VoiceProvider } from './voice-types';

const SUMMARY = '<div class="setting-row voice-summary"><div><strong data-voice-readiness>Loading voice input…</strong>'
  + '<small>Speech models are separate from your coding agent.</small></div><div class="settings-row-actions voice-summary-actions">'
  + '<button type="button" class="secondary-button" data-voice-off hidden>Turn off voice input</button></div></div>';
const HEAD = '<div class="voice-editor-head"><h4>New speech profile</h4>'
  + '<button type="button" class="secondary-button" data-voice-new>New profile</button></div>';
const picker = (label: string, name: string, labelled = '') => `<div class="voice-field"><span${labelled}>${label}</span>`
  + `<button type="button" class="settings-select voice-picker" aria-label="${label}" aria-haspopup="dialog" aria-expanded="false" data-voice-${name}>`
  + `<span></span>${icon('down')}</button></div>`;
const KEY = '<div class="voice-field voice-field-wide"><label for="voice-api-key">API key</label><div class="voice-key-controls">'
  + '<input id="voice-api-key" name="key" type="password" autocomplete="new-password" spellcheck="false" autocapitalize="off" aria-describedby="voice-key-hint">'
  + '<button type="button" class="secondary-button" data-voice-remove-key hidden>Remove saved key</button></div><small id="voice-key-hint"></small></div>';
const ENDPOINT = '<div class="voice-field"><label for="voice-endpoint">Transcription endpoint</label>'
  + '<input id="voice-endpoint" name="endpoint" type="url" maxlength="2048" required spellcheck="false" autocomplete="off" aria-describedby="voice-endpoint-hint">'
  + '<small id="voice-endpoint-hint">Full transcription URL. Use HTTPS or a loopback HTTP address.</small></div>';
const LANGUAGE = '<div class="voice-field"><label for="voice-language">Language (optional)</label>'
  + '<input id="voice-language" name="language" maxlength="32" pattern="[A-Za-z0-9_\\-]*" placeholder="Auto-detect" spellcheck="false" autocomplete="off" aria-describedby="voice-language-hint">'
  + '<small id="voice-language-hint">Language code, such as en or ja.</small></div>';
const ADVANCED = `<details class="settings-fold voice-advanced voice-field-wide"><summary>Advanced ${icon('chevron')}</summary><div class="voice-advanced-fields">
        ${ENDPOINT}
        ${LANGUAGE}
      </div></details>`;
const ACTIONS = '<div class="voice-editor-actions voice-field-wide"><button type="button" class="secondary-button" data-voice-save>Save profile</button>'
  + '<button type="button" class="primary-button" data-voice-save-use>Save and use profile</button></div>';
const FEEDBACK = '<p class="voice-status" role="status" aria-live="polite" hidden></p><p class="voice-error" id="voice-settings-error" role="alert" hidden></p>'
  + '<button type="button" class="secondary-button voice-retry" data-voice-retry hidden>Retry loading profiles</button>';

/** The Voice input group: summary, saved profiles and the profile editor. */
export function voiceSettingsHtml(): string {
  return `<div class="settings-group">
    ${SUMMARY}
    <div class="voice-profiles" role="group" aria-label="Saved voice profiles"></div>
    ${HEAD}
    <form class="voice-editor" aria-label="Speech profile" autocomplete="off">
      ${picker('Speech provider', 'provider', ' id="voice-provider-label"')}
      ${picker('Speech model', 'model')}
      <label class="voice-field voice-field-wide" data-voice-custom hidden>Custom model ID<input name="model" maxlength="160" spellcheck="false" autocomplete="off"></label>
      <label class="voice-field voice-field-wide">Profile name<input name="name" maxlength="80" required autocomplete="off"></label>
      ${KEY}
      ${ADVANCED}
      <p class="voice-destination voice-field-wide"></p>
      ${ACTIONS}
    </form>
    ${FEEDBACK}
  </div>`;
}

export interface VoiceSettingsElements {
  host: HTMLElement; form: HTMLFormElement; list: HTMLElement; heading: HTMLElement; readiness: HTMLElement;
  status: HTMLElement; error: HTMLElement; destination: HTMLElement; keyHint: HTMLElement; custom: HTMLElement;
  advanced: HTMLDetailsElement;
  field(name: string): HTMLInputElement;
  button(name: string): HTMLButtonElement;
}
export function voiceSettingsElements(host: HTMLElement): VoiceSettingsElements {
  const form = host.querySelector<HTMLFormElement>('form')!;
  const one = <T extends Element = HTMLElement>(selector: string) => host.querySelector<T>(selector)!;
  return {
    host, form, list: one('.voice-profiles'), heading: one('h4'), readiness: one('[data-voice-readiness]'),
    status: one('[role=status]'), error: one('[role=alert]'), destination: one('.voice-destination'),
    keyHint: one('#voice-key-hint'), custom: one('[data-voice-custom]'), advanced: one<HTMLDetailsElement>('.voice-advanced'),
    field: name => form.elements.namedItem(name) as HTMLInputElement,
    button: name => one<HTMLButtonElement>(`[data-voice-${name}]`),
  };
}

export function presetFor(provider: VoiceProvider) { return VOICE_PRESETS.find(item => item.provider === provider)!; }

/** One message at a time: polite status, or an alert when `failed`. */
export function showMessage(ui: VoiceSettingsElements, text = '', failed = false): void {
  ui.status.textContent = failed ? '' : text; ui.status.hidden = failed || !text;
  ui.error.textContent = failed ? text : ''; ui.error.hidden = !failed || !text;
}
export function clearValidation(ui: VoiceSettingsElements): void {
  for (const input of ui.form.querySelectorAll('input')) {
    input.setCustomValidity(''); input.removeAttribute('aria-invalid');
    const description = (input.getAttribute('aria-describedby') ?? '').split(' ').filter(id => id && id !== ui.error.id).join(' ');
    if (description) input.setAttribute('aria-describedby', description); else input.removeAttribute('aria-describedby');
  }
}
export function markInvalid(ui: VoiceSettingsElements, input: HTMLInputElement, text: string): void {
  if (ui.advanced.contains(input)) ui.advanced.open = true;
  input.setAttribute('aria-invalid', 'true');
  input.setAttribute('aria-describedby', `${input.getAttribute('aria-describedby') ?? ''} ${ui.error.id}`.trim());
  showMessage(ui, text, true); input.focus();
}
/** The editor field a native validation message is about, if any. */
export function fieldForFailure(detail: string): string | undefined {
  if (detail.startsWith('Enter a valid profile name (')) return 'name';
  if (detail.startsWith('Enter a valid model ID (')) return 'model';
  if (detail.startsWith('Use a full HTTPS transcription URL,')) return 'endpoint';
  if (detail.startsWith('Enter a valid language code (') || detail === 'Use a language code such as en or en-US.') return 'language';
  return undefined;
}
/** Reports a failed action with any typed key redacted; edits are always kept. */
export function showFailure(ui: VoiceSettingsElements, cause: unknown, action: string, key = ui.field('key').value): void {
  const detail = String(cause instanceof Error ? cause.message : cause);
  const text = `${action}: ${key ? detail.replaceAll(key, '[key hidden]') : detail} Your edits are kept. Try again.`;
  const name = fieldForFailure(detail);
  if (name) markInvalid(ui, ui.field(name), text); else showMessage(ui, text, true);
}

export interface KeyHintState { removingKey: boolean; typedKey: boolean; changedDestination: boolean; hasKey: boolean; custom: boolean }
export function keyHintText({ removingKey, typedKey, changedDestination, hasKey, custom }: KeyHintState): string {
  if (removingKey) return 'The saved key will be removed when you save.';
  if (typedKey) return 'A new key will be stored securely when you save.';
  if (changedDestination) return 'Destination changed. Re-enter a key for this server; saving removes the old key.';
  if (hasKey) return 'Key saved securely. Leave blank to keep it, or enter a replacement.';
  return custom ? 'Optional if your server accepts requests without authentication.' : 'Enter an API key from this speech provider.';
}
export function destinationText(endpoint: string, custom: boolean): string {
  const local = custom ? 'Local speech requires a running compatible STT service; PandaCode does not install models. ' : '';
  return `Destination: ${endpoint || 'enter a transcription URL'}. Audio sent only when you stop recording. ${local}`
    + 'Saving does not contact the service. Corrected settings apply to a new recording; Retry keeps the original settings.';
}
/** Shows a preset model on the picker, or the custom model field for anything else. */
export function showModelChoice(ui: VoiceSettingsElements, value: string, isCustom: boolean): void {
  ui.custom.hidden = !isCustom; ui.field('model').required = isCustom;
  ui.field('model').value = isCustom ? value : '';
  ui.button('model').querySelector('span')!.textContent = isCustom ? 'Custom model ID…' : value;
}
/** Name and model ID limits, checked in UTF-8 bytes as native storage does; returns the first invalid input. */
export function validateEditor(ui: VoiceSettingsElements): HTMLInputElement | undefined {
  for (const [name, max, label] of [['name', 80, 'profile name'], ['model', 160, 'model ID']] as const) {
    const value = ui.field(name).value.trim();
    if (name === 'model' && ui.custom.hidden) continue;
    const tooLong = !value || new TextEncoder().encode(value).length > max;
    ui.field(name).setCustomValidity(tooLong ? `Enter a valid ${label} (up to ${max} characters).` : '');
  }
  return [...ui.form.querySelectorAll('input')].find(input => !input.validity.valid);
}

const row = (title: string, description: string, controls: string, id: string) => `<div class="ds-row voice-setting-row">`
  + `<div class="ds-row-main"><span class="ds-row-title" id="${id}">${title}</span><span class="voice-setting-description" id="${id}-description">${description}</span></div>`
  + `<div class="voice-setting-controls">${controls}</div></div>`;

/** The id of the hint under the microphone select. */
export const DEVICE_HINT_ID = 'voice-mic-device-hint';
const MIC_DESCRIPTION = 'System default follows the OS. Test microphone records a 10-second test and plays it back here. Test audio stays on this device and is never transcribed.';
/** Both labels share one grid cell, so swapping Test microphone for Stop test never changes the button's width (a
 * narrower button let the controls fit beside the description and squeezed it to more lines). */
const MIC_TEST_BUTTON = '<button type="button" class="ds-btn" data-voice-mic-test aria-describedby="voice-mic-description"><span class="voice-label-swap">'
  + '<span data-voice-mic-test-label="idle">Test microphone</span><span data-voice-mic-test-label="active" aria-hidden="true">Stop test</span></span></button>';
const MIC_CONTROLS = MIC_TEST_BUTTON
  + '<select class="settings-select voice-select" data-voice-device aria-labelledby="voice-mic" aria-describedby="voice-mic-description" title="System default"><option value="">System default</option></select>'
  + `<button type="button" class="ds-btn ds-btn-icon" data-voice-device-refresh aria-label="Refresh microphones" data-tip="Refresh microphones">${icon('refresh')}</button>`
  // The fallback for a saved device that is not connected (joins the select's description while shown), and the
  // polite Refresh result, which stays rendered so its text is announced.
  + `<div class="voice-device-notes"><span id="${DEVICE_HINT_ID}" data-voice-device-hint hidden></span>`
  + '<span data-voice-device-status role="status" aria-live="polite"></span></div>';
const SHORTCUT_CONTROLS = '<select class="settings-select voice-select" data-voice-shortcut-mode aria-labelledby="voice-shortcut" aria-describedby="voice-shortcut-description">'
  + '<option value="auto">Auto: press to toggle, hold to record</option><option value="hold">Hold to record</option><option value="toggle">Press to toggle</option></select>';

/** Input: microphone choice and test, and how the dictation shortcut records. */
export function voiceInputCardHtml(): string {
  return `<section class="ds-card voice-card" aria-labelledby="voice-input-title"><h3 class="voice-card-title" id="voice-input-title">Input</h3><div class="ds-card-inner">`
    + row('Microphone', MIC_DESCRIPTION, MIC_CONTROLS, 'voice-mic')
    + '<div class="voice-mic-test" data-voice-mic-panel hidden></div>'
    + row('Dictation shortcut', 'How the dictation shortcut starts and stops recording.', SHORTCUT_CONTROLS, 'voice-shortcut')
    + '<p class="voice-error" role="alert" data-voice-input-error hidden></p></div></section>';
}

const DESTINATION_DESCRIPTION = 'Microphone audio is sent to this destination to transcribe, then discarded. Choose Off to turn voice input off on this device.';
/** Linked like the model licences: external-links.ts opens it in the system browser. */
const BENCHMARK_LINK = '<a href="https://github.com/handy-computer/models" target="_blank" rel="noopener noreferrer">Handy models benchmark</a>';
const EXPLAINER = 'Pick languages to see models that support all of them. Accuracy is word or character error rate: lower is better. '
  + `Speed is the time to transcribe 30 seconds of audio, measured on the Handy project’s benchmark GPU. Grades and speeds come from the ${BENCHMARK_LINK}.`;
const search = (label: string, name: string) => `<label class="voice-search">${icon('search')}<input type="search" data-voice-${name}-search aria-label="${label}" placeholder="${label}" spellcheck="false" autocomplete="off"></label>`;

function browserHtml(): string {
  return '<div class="voice-browser">'
    + `<div class="ds-card-inset voice-browser-pane"><h4 class="voice-browser-title" id="voice-languages-title">Languages</h4>${search('Search languages', 'language')}`
    + '<div class="voice-browser-list voice-language-list" role="listbox" aria-multiselectable="true" aria-labelledby="voice-languages-title" data-voice-languages></div></div>'
    + `<div class="ds-card-inset voice-browser-pane"><h4 class="voice-browser-title" id="voice-models-title" data-voice-models-title>Models for all languages</h4>${search('Search models', 'model')}`
    + '<div class="voice-browser-list voice-model-list" role="list" aria-labelledby="voice-models-title" data-voice-models></div></div></div>';
}

/** Transcription: where audio goes, the language, and the local model browser. */
export function voiceTranscriptionCardHtml(): string {
  const destination = '<select class="settings-select voice-select" data-voice-destination aria-labelledby="voice-destination" aria-describedby="voice-destination-description"></select>';
  const language = '<select class="settings-select voice-select" data-voice-language-select aria-labelledby="voice-language-pick" aria-describedby="voice-language-pick-description"><option value="auto">Auto-detect</option></select>';
  return `<section class="ds-card voice-card" aria-labelledby="voice-transcription-title"><h3 class="voice-card-title" id="voice-transcription-title">Transcription</h3><div class="ds-card-inner">`
    + row('Send microphone audio to', DESTINATION_DESCRIPTION, destination, 'voice-destination')
    + `<div data-voice-language-row>${row('Language', '', language, 'voice-language-pick')}</div>`
    + `<p class="voice-explainer">${EXPLAINER}</p>${browserHtml()}`
    + '<p class="voice-status" role="status" aria-live="polite" data-voice-local-status hidden></p><p class="voice-error" role="alert" data-voice-local-error hidden></p>'
    // Always present and never hidden, so model test results inserted later are announced.
    + '<p class="voice-sr-only" role="status" aria-live="polite" data-voice-model-announcer></p>'
    + '</div></section>';
}
