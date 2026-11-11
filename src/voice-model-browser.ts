import { escape, icon } from './dom.ts';
import type { VoiceDestination, VoiceLocalModel, VoiceProfile } from './voice-types.ts';

/** Widely spoken languages lead the list (T3 Code's ordering); everything else follows alphabetically. */
const COMMON_LANGUAGES = ['en', 'zh', 'es', 'hi', 'ar', 'fr', 'pt', 'ru', 'ja', 'de', 'ko', 'it', 'tr', 'vi', 'pl', 'uk', 'nl', 'id', 'th', 'sv'];

/** English names for catalog codes Chrome's `Intl.DisplayNames` returns as written (checked against the whole
 * catalog; WebKit names them all). Used only when DisplayNames gives back the code itself;
 * `tests/voice-local-settings.spec.ts` fails if a catalog language shows unnamed. */
const FALLBACK_NAMES: Readonly<Record<string, string>> = { ba: 'Bashkir', bo: 'Tibetan' };

let displayNames: Intl.DisplayNames | null | undefined;
/** An English display name for a language code; unknown codes show as written. */
export function languageName(code: string): string {
  if (displayNames === undefined) {
    try { displayNames = new Intl.DisplayNames(['en'], { type: 'language' }); } catch { displayNames = null; }
  }
  let name: string | undefined;
  try { name = displayNames?.of(code); } catch { name = undefined; }
  return name && name.toLowerCase() !== code.toLowerCase() ? name : FALLBACK_NAMES[code] ?? name ?? code;
}

function languageRank(code: string): number {
  const index = COMMON_LANGUAGES.indexOf(code);
  return index < 0 ? COMMON_LANGUAGES.length : index;
}

/** Every language any model supports, common languages first. */
export function catalogLanguages(models: readonly VoiceLocalModel[]): string[] {
  const codes = [...new Set(models.flatMap(model => model.languages))];
  return codes.sort((a, b) => languageRank(a) - languageRank(b) || languageName(a).localeCompare(languageName(b)));
}

const normalize = (text: string) => text.trim().toLocaleLowerCase();

export function filterLanguages(codes: readonly string[], query: string): string[] {
  const needle = normalize(query);
  if (!needle) return [...codes];
  return codes.filter(code => normalize(languageName(code)).includes(needle) || code.toLowerCase() === needle);
}

/** Models supporting every selected language and matching the search by name, description or ID. */
export function filterModels(models: readonly VoiceLocalModel[], selected: readonly string[], query: string): VoiceLocalModel[] {
  const needle = normalize(query);
  return models.filter(model => selected.every(code => model.languages.includes(code))
    && (!needle || [model.name, model.description, model.id].some(text => normalize(text).includes(needle))));
}

/** Why the model list is empty: the search text, the language selection, or both. */
export function emptyModelsText(selected: readonly string[], query: string): string {
  const needle = query.trim();
  if (needle && selected.length) return `No models match “${needle}” and support every selected language.`;
  if (needle) return `No models match “${needle}”.`;
  return 'No models support every selected language.';
}

/** The model dictation would use: installed and selected (same rule as the composer's Set up dictation check). */
export function usableModel(models: readonly VoiceLocalModel[], selectedModel: string | null | undefined): VoiceLocalModel | undefined {
  return models.find(model => model.state === 'installed' && (model.active || model.id === selectedModel));
}

/** The model a first-time setup should download: the catalog default, else the first recommended one. */
export function setupModel(models: readonly VoiceLocalModel[], defaultModel: string | null | undefined): VoiceLocalModel | undefined {
  const sorted = sortModels(models, defaultModel);
  return models.find(model => model.id === defaultModel) ?? sorted.find(model => model.recommended) ?? sorted[0];
}

function sortRank(model: VoiceLocalModel): number {
  if (model.active) return 0;
  if (model.state === 'installed') return 1;
  if (model.state === 'downloading' || model.state === 'verifying') return 2;
  return model.recommended ? 3 : 4;
}

/** Active, installed, downloading, recommended, then by name; within a group the catalog default comes first. */
export function sortModels(models: readonly VoiceLocalModel[], defaultModel?: string | null): VoiceLocalModel[] {
  const isDefault = (model: VoiceLocalModel) => (defaultModel != null && model.id === defaultModel ? 0 : 1);
  return [...models].sort((a, b) => sortRank(a) - sortRank(b) || isDefault(a) - isDefault(b) || a.name.localeCompare(b.name));
}

export function browserTitle(selected: readonly string[]): string {
  if (!selected.length) return 'Models for all languages';
  const names = selected.map(languageName);
  if (names.length <= 3) return `Models for ${new Intl.ListFormat('en', { type: 'conjunction' }).format(names)}`;
  return `Models for ${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
}

/** The roving-focus key of the All languages row. */
export const ALL_LANGUAGES = '*';

function languageOption(key: string, label: string, selected: boolean, focusable: boolean): string {
  const data = key === ALL_LANGUAGES ? 'data-voice-language-all' : `data-voice-language="${escape(key)}"`;
  return `<div role="option" class="ds-row voice-language-row" data-interactive ${data} aria-selected="${selected}" tabindex="${focusable ? 0 : -1}">`
    + `<span class="ds-row-title">${escape(label)}</span><span class="voice-language-check" aria-hidden="true">${selected ? icon('check') : ''}</span></div>`;
}

/** The language listbox: an All languages option, then each matching language. One option is the Tab stop
 * (roving tabindex): `focused` when it is still listed, else All languages. */
export function languagesHtml(codes: readonly string[], selected: readonly string[], query: string, focused = ALL_LANGUAGES): string {
  const matching = filterLanguages(codes, query);
  const stop = matching.includes(focused) ? focused : ALL_LANGUAGES;
  const all = languageOption(ALL_LANGUAGES, 'All languages', !selected.length, stop === ALL_LANGUAGES);
  const rows = matching.map(code => languageOption(code, languageName(code), selected.includes(code), stop === code));
  return all + (rows.join('') || '<p class="voice-browser-empty" role="none">No languages match.</p>');
}

/** Destination select values: `local`, `off`, or `profile:<id>`. */
export function destinationValue(destination: VoiceDestination): string {
  return typeof destination === 'string' ? destination : `profile:${destination.profileId}`;
}
export function parseDestination(value: string): VoiceDestination {
  return value.startsWith('profile:') ? { profileId: value.slice('profile:'.length) } : value === 'local' ? 'local' : 'off';
}

export function destinationOptionsHtml(profiles: readonly VoiceProfile[], supported: boolean, current: VoiceDestination): string {
  const local = `<option value="local"${supported ? '' : ' disabled'}>This device${supported ? '' : ' (not supported on this computer)'}</option>`;
  const remote = profiles.map(profile => `<option value="profile:${escape(profile.id)}">${escape(profile.name)}</option>`).join('');
  const missing = typeof current === 'object' && !profiles.some(profile => profile.id === current.profileId)
    ? `<option value="${escape(destinationValue(current))}" disabled>Removed speech service</option>` : '';
  return `${local}<option value="off">Off</option>${remote}${missing}`;
}

/** Whether `model` can transcribe the saved language (auto-detect counts when the model detects languages). */
function supportsLanguage(model: VoiceLocalModel, language: string): boolean {
  return language === 'auto' ? true : model.languages.includes(language);
}

/** What native uses instead of an unsupported saved language: auto-detect if the model detects languages, else
 * English if it has it, else its first language. */
export function fallbackLanguageName(model: VoiceLocalModel): string {
  if (model.supportsLanguageDetection) return 'auto-detect';
  if (model.languages.includes('en')) return languageName('en');
  return model.languages[0] ? languageName(model.languages[0]) : 'its default language';
}

/** Auto-detect plus the languages of the model in use; a saved language the model lacks stays listed, marked unsupported. */
export function languageOptionsHtml(model: VoiceLocalModel | undefined, current: string): string {
  const codes = model ? catalogLanguages([model]) : [];
  const unsupported = current !== 'auto' && !codes.includes(current);
  if (unsupported) codes.push(current);
  const option = (code: string) => code === current && unsupported && model
    ? `<option value="${escape(code)}" data-unsupported>${escape(languageName(code))} (not supported)</option>`
    : `<option value="${escape(code)}">${escape(languageName(code))}</option>`;
  return `<option value="auto">Auto-detect</option>${codes.map(option).join('')}`;
}

export function languageNote(model: VoiceLocalModel | undefined, language: string): string {
  if (!model) return 'Download or select a model below to choose its language.';
  if (!supportsLanguage(model, language)) return `${languageName(language)} isn’t supported by ${model.name}; it will use ${fallbackLanguageName(model)}.`;
  if (language !== 'auto') return `${model.name} transcribes ${languageName(language)}.`;
  if (model.supportsLanguageDetection) return `${model.name} detects the language automatically.`;
  if (model.languages.length === 1) return `${model.name} transcribes ${languageName(model.languages[0])}.`;
  // Native's rule for a model that can't detect: English if it has it, else its first language.
  return `${model.name} can’t detect the language; it will transcribe ${fallbackLanguageName(model)}.`;
}
