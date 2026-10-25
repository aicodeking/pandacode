// Settings → Language: follow the phone, or pick a locale for this app only.
// Unlike the desktop there is no reload; components read `useT()`, so a change re-renders.
import * as Localization from 'expo-localization';
import { useSyncExternalStore } from 'react';
import { create } from 'zustand';
import { get, set } from '../connect/secrets.ts';
import { LOCALES, makeTranslate, resolveSystemLocale, type LanguageChoice, type Locale } from '../i18n/core.ts';
import { CATALOGS } from '../i18n/catalogs.ts';

const KEY = 'language';
export const useLanguage = create<{ choice: LanguageChoice }>(() => ({ choice: 'system' }));

export function setLanguage(choice: LanguageChoice) {
  useLanguage.setState({ choice });
  set(KEY, choice).catch(() => undefined);
}

/** Call once at start; an unknown or missing value means System. */
export async function loadLanguage() {
  const stored = await get(KEY);
  if (stored === 'system' || LOCALES.includes(stored as Locale)) useLanguage.setState({ choice: stored as LanguageChoice });
}

export function currentLocale(): Locale {
  const choice = useLanguage.getState().choice;
  if (choice !== 'system') return choice;
  const tags = Localization.getLocales().map(l => l.languageTag ?? l.languageCode ?? '').filter(Boolean);
  return resolveSystemLocale(tags.length ? tags : ['en']);
}

/** Reactive translator for components: `const t = useT();` Re-renders on language change. */
export function useT() {
  useSyncExternalStore(useLanguage.subscribe, () => useLanguage.getState().choice);
  return makeTranslate(CATALOGS[currentLocale()]);
}

/** One-off lookups outside render (alerts, handlers). */
export function tNow() {
  return makeTranslate(CATALOGS[currentLocale()]);
}
