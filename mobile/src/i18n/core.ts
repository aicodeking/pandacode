// The localization core: source English is the key, catalogs translate it.
// Mirrors the desktop's src/i18n.ts (kept behavior-identical by mobile/tests/language.test.ts);
// mobile keeps its own copy because Metro does not bundle files outside mobile/src.

export type Locale =
  | 'en-US' | 'en-GB'
  | 'de' | 'es' | 'fr' | 'it' | 'pt-BR'
  | 'ja' | 'ko' | 'pl' | 'ru'
  | 'zh-Hans' | 'zh-Hant-HK' | 'zh-Hant-TW';
export type LanguageChoice = 'system' | Locale;

export const LOCALES: Locale[] = [
  'en-US', 'en-GB',
  'de', 'es', 'fr', 'it', 'pt-BR',
  'ja', 'ko', 'pl', 'ru',
  'zh-Hans', 'zh-Hant-HK', 'zh-Hant-TW',
];

/** Picker entries, each named in its own language. */
export const LANGUAGES: { id: Locale; native: string }[] = [
  { id: 'en-US', native: 'English (US)' },
  { id: 'en-GB', native: 'English (UK)' },
  { id: 'de', native: 'Deutsch' },
  { id: 'es', native: 'Español' },
  { id: 'fr', native: 'Français' },
  { id: 'it', native: 'Italiano' },
  { id: 'ja', native: '日本語' },
  { id: 'ko', native: '한국어' },
  { id: 'pl', native: 'Polski' },
  { id: 'pt-BR', native: 'Português (Brasil)' },
  { id: 'ru', native: 'Русский' },
  { id: 'zh-Hans', native: '简体中文' },
  { id: 'zh-Hant-HK', native: '繁體中文（香港）' },
  { id: 'zh-Hant-TW', native: '繁體中文（台灣）' },
];

/** Maps system language tags to a supported locale; identical to the desktop mapping. */
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
    if (tag.startsWith('de')) return 'de';
    if (tag.startsWith('es')) return 'es';
    if (tag.startsWith('fr')) return 'fr';
    if (tag.startsWith('it')) return 'it';
    if (tag.startsWith('ja')) return 'ja';
    if (tag.startsWith('ko')) return 'ko';
    if (tag.startsWith('pl')) return 'pl';
    if (tag.startsWith('pt')) return 'pt-BR';
    if (tag.startsWith('ru')) return 'ru';
  }
  return 'en-US';
}

function lookup(catalog: Record<string, string> | undefined, key: string): string | undefined {
  return catalog?.[key];
}

/** Builds the catalog key for a tagged template: t`Copied ${name}` → "Copied {0}". */
function taggedKey(strings: TemplateStringsArray): string {
  let key = '';
  for (let i = 0; i < strings.length; i++) {
    if (i) key += `{${i - 1}}`;
    key += strings[i];
  }
  return key;
}

/** Single-pass substitution: values never inject or consume placeholders. */
function substitute(text: string, values: unknown[]): string {
  return text.split(/\{(\d+)\}/).map((part, index) => index % 2 ? String(values[Number(part)] ?? '') : part).join('');
}

export type Translate = {
  (input: string): string;
  (strings: TemplateStringsArray, ...values: unknown[]): string;
};

/** Binds t() to a catalog. Components call `const t = useT()` so a language change re-renders. */
export function makeTranslate(catalog: Record<string, string> | undefined): Translate {
  const translate = (input: string | TemplateStringsArray, ...values: unknown[]): string => {
    if (typeof input === 'string') return lookup(catalog, input) ?? input;
    const hit = lookup(catalog, taggedKey(input));
    if (hit === undefined) return input.reduce((out, part, i) => (i ? out + String(values[i - 1]) + part : part), '');
    return substitute(hit, values);
  };
  return translate as Translate;
}
