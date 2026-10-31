// Keep the launcher and menu bar popover isolated: importing main loads the full workspace and its listeners.
import { languagePref, registerBackendCatalog, registerCatalog, resolvedLocale, setActiveLocale, notifyNativeLanguage, type Locale } from './i18n.ts';

// The active catalog loads before any view module, so module-level t() calls resolve in the right language.
const catalogs: Partial<Record<Locale, () => Promise<{ default: Record<string, string>; backend?: Record<string, string> }>>> = {
  'de': () => import('./locales/de'),
  'en-GB': () => import('./locales/en-GB'),
  'es': () => import('./locales/es'),
  'fr': () => import('./locales/fr'),
  'it': () => import('./locales/it'),
  'ja': () => import('./locales/ja'),
  'ko': () => import('./locales/ko'),
  'pl': () => import('./locales/pl'),
  'pt-BR': () => import('./locales/pt-BR'),
  'ru': () => import('./locales/ru'),
  'zh-Hans': () => import('./locales/zh-Hans'),
  'zh-Hant-HK': () => import('./locales/zh-Hant-HK'),
  'zh-Hant-TW': () => import('./locales/zh-Hant-TW'),
};

void (async () => {
  const locale = resolvedLocale(languagePref());
  setActiveLocale(locale);
  try {
    const load = catalogs[locale];
    if (load) {
      const module = await load();
      registerCatalog(locale, module.default);
      if (module.backend) registerBackendCatalog(locale, module.backend);
    }
  } catch { /* a missing catalog falls back to the source English strings */ }
  notifyNativeLanguage(locale);
  const view = new URLSearchParams(location.search).get('view');
  if (view === 'launcher') await import('./overlay');
  else if (view === 'tray') await import('./tray-popover');
  else await import('./main');
})();
