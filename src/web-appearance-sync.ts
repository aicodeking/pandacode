import { appearanceSnapshot, storeAppearance, applyHostClockMetadata, applyWallpaperAccentSeed } from './web-preferences';
import { web } from './web-transport';
import { webJson } from './web-http';

/** Both renderers follow the host's revisioned appearance snapshot. */
export function synchronizeWebAppearance(): () => void {
  if (!web) return () => {};
  let applying = false;
  let previous = JSON.stringify(appearanceSnapshot());
  let pending = 0;
  let revision = -1;
  const accept = (snapshot: { revision: number; preferences: unknown }) => {
    if (!snapshot || typeof snapshot !== 'object' || !Number.isSafeInteger(snapshot.revision) || snapshot.revision <= revision) return;
    revision = snapshot.revision; applyHostClockMetadata(snapshot); applyWallpaperAccentSeed(snapshot);
    applying = true;
    try {
      storeAppearance(snapshot.preferences);
      window.dispatchEvent(new Event('pandacode-appearance-reload'));
      previous = JSON.stringify(appearanceSnapshot());
    } finally { applying = false; }
  };
  const publish = () => {
    if (applying) return;
    window.clearTimeout(pending);
    pending = window.setTimeout(() => {
      const preferences = appearanceSnapshot(), next = JSON.stringify(preferences);
      if (next === previous) return;
      const csrf = document.cookie.split(';').map(item => item.trim()).find(item => item.startsWith('pandacode_csrf='))?.slice('pandacode_csrf='.length) ?? '';
      void webJson('/api/pandacode/preferences', { method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': decodeURIComponent(csrf) },
        body: JSON.stringify({ preferences }) }, { timeoutMs: 50000 }).then(({ response, value }) => {
          if (!response.ok) throw new Error('Host appearance update failed');
          accept(value as { revision: number; preferences: unknown }); previous = JSON.stringify(appearanceSnapshot());
        }).catch(() => window.dispatchEvent(new CustomEvent('pandacode-web-error', { detail: 'Could not save appearance to the host. Reconnect and try again.' })));
    }, 100);
  };
  const names = ['pandacode-theme-change', 'pandacode-palette-change', 'pandacode-ui-scale-change', 'pandacode-wallpaper-change', 'pandacode-compact-change'];
  names.forEach(name => window.addEventListener(name, publish));
  const refresh = () => {
    void webJson('/api/pandacode/preferences', { cache: 'no-store' })
      .then(({ response, value }) => { if (!response.ok) throw new Error('Appearance refresh failed'); accept(value as { revision: number; preferences: unknown }); })
      .catch(() => window.dispatchEvent(new CustomEvent('pandacode-web-error', { detail: 'Could not refresh host appearance.' })));
  };
  window.addEventListener('pandacode-web-runtime-restored', refresh);
  const stop = web.subscribe('web-gateway-preferences-changed', event => accept(event.payload as { revision: number; preferences: unknown }));
  return () => { window.removeEventListener('pandacode-web-runtime-restored', refresh); stop(); window.clearTimeout(pending); names.forEach(name => window.removeEventListener(name, publish)); };
}
