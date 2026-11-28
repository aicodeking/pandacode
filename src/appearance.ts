import { call, nativeDesktop } from './bridge';
import { isMac } from './platform';

type AppearancePreferences = { reducedTransparency: boolean; increasedContrast: boolean; darkMode: boolean };
type NativeAppearance = { platform: 'macos' | 'other'; material: 'liquidGlass' | 'vibrancy' | 'solid' };
type ConfigureAppearance = (preferences: AppearancePreferences) => Promise<NativeAppearance>;

/** One native material, refreshed only for preferences or window activation. */
export function initializeNativeAppearance(
  configure?: ConfigureAppearance,
): () => void {
  const root = document.documentElement;
  // Reserve native window controls before appearance IPC, including its solid fallback.
  root.dataset.nativePlatform = nativeDesktop && isMac ? 'macos' : 'other';
  // Browser tabs have no native window to configure: an opaque surface, no traffic-light gutter.
  if (!nativeDesktop && !configure) { root.dataset.nativeMaterial = 'solid'; return () => { delete root.dataset.nativeMaterial; delete root.dataset.nativePlatform; }; }
  const apply: ConfigureAppearance = configure ?? (preferences => call('configure_window_appearance', preferences));
  const transparency = matchMedia('(prefers-reduced-transparency: reduce)');
  const contrast = matchMedia('(prefers-contrast: more)');
  let disposed = false, busy = false, dirty = false;

  function preferences(): AppearancePreferences {
    return {
      reducedTransparency: transparency.matches,
      increasedContrast: contrast.matches,
      darkMode: root.dataset.theme === 'dark',
    };
  }
  async function synchronize(): Promise<void> {
    busy = true;
    try {
      // Coalesce changes while IPC is pending so an older native request cannot
      // restore glass after a newer request has made the interface opaque.
      while (!disposed && dirty) {
        dirty = false;
        const requested = preferences();
        try {
          const result = await apply(requested);
          if (disposed || dirty) continue;
          root.dataset.nativePlatform = result.platform;
          root.dataset.nativeMaterial = result.platform === 'macos'
            && !requested.reducedTransparency && !requested.increasedContrast
            ? result.material : 'solid';
        } catch (error) {
          if (!disposed) root.dataset.nativeMaterial = 'solid';
          console.warn('Native window material unavailable; using an opaque surface.', error);
        }
      }
    } finally { busy = false; }
  }
  function refresh(): void {
    if (disposed) return;
    dirty = true;
    if (transparency.matches || contrast.matches) root.dataset.nativeMaterial = 'solid';
    if (!busy) void synchronize();
  }
  function dispose(): void {
    disposed = true;
    transparency.removeEventListener('change', refresh);
    contrast.removeEventListener('change', refresh);
    window.removeEventListener('focus', refresh);
    window.removeEventListener('pandacode-theme-change', refresh);
    window.removeEventListener('pagehide', dispose);
    delete root.dataset.nativeMaterial;
    delete root.dataset.nativePlatform;
  }

  transparency.addEventListener('change', refresh);
  contrast.addEventListener('change', refresh);
  window.addEventListener('focus', refresh);
  window.addEventListener('pandacode-theme-change', refresh);
  window.addEventListener('pagehide', dispose, { once: true });
  refresh();
  return dispose;
}
