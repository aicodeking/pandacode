// UI language support: source English is the key, catalogs translate it.
// Kept dependency-free on purpose — entry.ts imports this before any view module,
// so it must not pull in the app, the bridge or the preview mocks.

export type Locale = 'en-US' | 'en-GB' | 'zh-Hans' | 'zh-Hant-HK' | 'zh-Hant-TW';
export type LanguagePref = 'auto' | Locale;

export const LANGUAGE_KEY = 'pandacode.language';
/** sessionStorage prefix for unsent composer text, keyed by session id (survives the language reload). */
export const COMPOSER_DRAFT_PREFIX = 'pandacode.composer-draft.';

const LOCALES: Locale[] = ['en-US', 'en-GB', 'zh-Hans', 'zh-Hant-HK', 'zh-Hant-TW'];

/** Picker entries, each named in its own language; "System default" is translated like any other string. */
export const LANGUAGES: { id: Locale; native: string }[] = [
  { id: 'en-US', native: 'English (US)' },
  { id: 'en-GB', native: 'English (UK)' },
  { id: 'zh-Hans', native: '简体中文' },
  { id: 'zh-Hant-HK', native: '繁體中文（香港）' },
  { id: 'zh-Hant-TW', native: '繁體中文（台灣）' },
];

/** Maps system language tags to a supported locale. Pure so tests (and the mobile app) can share it. */
export function resolveSystemLocale(candidates: readonly string[]): Locale {
  for (const raw of candidates) {
    const tag = raw.toLowerCase();
    const has = (region: string) => new RegExp(`(^|[-_.@])${region}([-_.@]|$)`).test(tag);
    if (tag.startsWith('zh')) {
      if (tag.includes('hant')) {
        if (has('tw')) return 'zh-Hant-TW';
        if (has('hk') || has('mo')) return 'zh-Hant-HK';
        return 'zh-Hant-TW';
      }
      if (has('tw')) return 'zh-Hant-TW';
      if (has('hk') || has('mo')) return 'zh-Hant-HK';
      return 'zh-Hans';
    }
    if (tag.startsWith('en')) {
      if (['gb', 'au', 'ie', 'nz', 'za', 'sg', 'in'].some(has)) return 'en-GB';
      return 'en-US';
    }
  }
  return 'en-US';
}

export function languagePref(): LanguagePref {
  try {
    const value = localStorage.getItem(LANGUAGE_KEY);
    if (value === 'auto' || LOCALES.includes(value as Locale)) return value as LanguagePref;
  } catch { /* storage unavailable — follow the system */ }
  return 'auto';
}

export function resolvedLocale(pref: LanguagePref = languagePref()): Locale {
  if (pref !== 'auto') return pref;
  const nav = navigator as { languages?: readonly string[]; language?: string };
  return resolveSystemLocale(nav.languages?.length ? nav.languages : nav.language ? [nav.language] : []);
}

let active: Locale = 'en-US';
const catalogs = new Map<Locale, Record<string, string>>();
/** Stable Rust error strings, translated at the toast boundary (report/notify); en-US has none. */
const backendCatalogs = new Map<Locale, Record<string, string>>();

export function currentLocale(): Locale { return active; }

export function setActiveLocale(locale: Locale): void {
  active = locale;
  document.documentElement.lang = documentLang(locale);
}

export function registerCatalog(locale: Locale, strings: Record<string, string>): void {
  catalogs.set(locale, strings);
}

export function registerBackendCatalog(locale: Locale, strings: Record<string, string>): void {
  backendCatalogs.set(locale, strings);
}

/** BCP 47 tag for <html lang>. */
export function documentLang(locale: Locale): string {
  return locale === 'en-US' ? 'en' : locale;
}

function lookup(key: string): string | undefined {
  return catalogs.get(active)?.[key];
}

/** Builds the catalog key for a tagged template: t`Remove ${x}?` → "Remove {0}?" */
function taggedKey(strings: TemplateStringsArray): string {
  let key = '';
  for (let i = 0; i < strings.length; i++) {
    if (i) key += `{${i - 1}}`;
    key += strings[i];
  }
  return key;
}

/** Single-pass substitution: values can never inject or consume placeholders, because only the catalog text is split. */
function substitute(text: string, values: unknown[]): string {
  return text.split(/\{(\d+)\}/).map((part, index) => index % 2 ? String(values[Number(part)] ?? '') : part).join('');
}

/** Translates a UI string. Static: t('New task'). Interpolated: t`Remove ${escape(name)}?`. */
export function t(input: string): string;
export function t(strings: TemplateStringsArray, ...values: unknown[]): string;
export function t(input: string | TemplateStringsArray, ...values: unknown[]): string {
  if (typeof input === 'string') {
    const hit = lookup(input);
    return hit === undefined ? input : hit;
  }
  const hit = lookup(taggedKey(input));
  if (hit === undefined) {
    return input.reduce((out, part, i) => i ? out + String(values[i - 1]) + part : part, '');
  }
  return substitute(hit, values);
}

/** Translates a backend (Rust) error string by exact match; anything else — dynamic errors, already-translated text — passes through. */
export function tBackend(text: string): string {
  return backendCatalogs.get(active)?.[text] ?? text;
}

/** Keeps unsent composer text alive across the language-change reload. */
function stashComposerDraft(): void {
  const prompt = document.querySelector<HTMLTextAreaElement>('#prompt');
  if (!prompt || !prompt.value.trim() || !prompt.dataset.sessionId) return;
  try { sessionStorage.setItem(COMPOSER_DRAFT_PREFIX + prompt.dataset.sessionId, prompt.value); } catch { /* best effort */ }
}

/** Consumes drafts stashed before a reload; main.ts re-applies them as sessions render. */
export function takeComposerDrafts(): Map<string, string> {
  const drafts = new Map<string, string>();
  try {
    for (const key of [...Object.keys(sessionStorage)]) {
      if (!key.startsWith(COMPOSER_DRAFT_PREFIX)) continue;
      const value = sessionStorage.getItem(key);
      if (value) drafts.set(key.slice(COMPOSER_DRAFT_PREFIX.length), value);
      sessionStorage.removeItem(key);
    }
  } catch { /* best effort */ }
  return drafts;
}

/** Tells the native side (tray menu, launcher title) which language is active. Preview windows have no Tauri. */
export function notifyNativeLanguage(locale: Locale): void {
  const internals = (window as { __TAURI_INTERNALS__?: { invoke(command: string, args?: Record<string, unknown>): Promise<unknown> } }).__TAURI_INTERNALS__;
  if (!internals) return;
  Promise.resolve(internals.invoke('set_ui_language', { locale })).catch(() => { /* not registered yet — the tray falls back to English */ });
}

/** Lets the app save anything else it loses on reload (per-session drafts) before the language switch. */
let beforeLanguageReload: (() => void) | undefined;
export function setBeforeLanguageReload(fn: () => void): void { beforeLanguageReload = fn; }

/** Saves the choice and reloads every window into the new language. */
export function setLanguagePref(pref: LanguagePref): void {
  try { localStorage.setItem(LANGUAGE_KEY, pref); } catch { /* best effort */ }
  beforeLanguageReload?.();
  stashComposerDraft();
  const locale = resolvedLocale(pref);
  setActiveLocale(locale);
  notifyNativeLanguage(locale);
  location.reload();
}
