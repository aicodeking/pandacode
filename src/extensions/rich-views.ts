/** Private host service. No window options, raw IPC or package-supplied URLs. */
import { call, preview } from '../bridge';
import { extensionsSnapshot, onExtensionChanged } from './manager';
import channel from './rich-view-channel.js?raw';
import client from './rich-view-client.js?raw';
import host from './rich-view-host.js?raw';
import type { RegisteredView } from './views-state';

export type RichAssets = { html: string; css: string; script: string };
export const RICH_VIEW_UNSUPPORTED = 'Rich HTML views are disabled: installed native isolation qualification is pending. Use the host-rendered view instead.';
const previewWindows = new Map<Window, () => void>();
window.addEventListener('pagehide', () => {
  for (const [popup, dispose] of previewWindows) { dispose(); popup.close(); }
}, { once: true });
const json = (value: unknown) => JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026');
const attribute = (text: string) => text.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
async function hash(source: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source)));
  return `'sha256-${btoa(String.fromCharCode(...bytes))}'`;
}
export async function richViewDocument(entry: RegisteredView, assets: RichAssets, windowId: string): Promise<string> {
  if (Object.values(assets).some(text => new TextEncoder().encode(text).length > 65536) || /<\/script/i.test(assets.script) || /<\/style/i.test(assets.css)) throw new Error('UnsafeAsset');
  const session = crypto.randomUUID(), bootstrap = `${channel}\n${client}`, shell = `${channel}\n${host}`;
  const policy = `default-src 'none'; script-src ${await hash(bootstrap)} ${await hash(assets.script)} ${await hash(shell)}; script-src-attr 'none'; style-src ${await hash(assets.css)}; img-src 'none'; connect-src 'none'; font-src 'none'; media-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src about:; worker-src 'none'`;
  const meta = `<meta http-equiv="Content-Security-Policy" content="${attribute(policy)}"><meta name="referrer" content="no-referrer">`;
  const document = `<!doctype html><html><head>${meta}<style>${assets.css}</style></head><body>${assets.html}<script type="application/json" id="panda-view-session">${json(session)}</script><script>${bootstrap}</script><script>${assets.script}</script></body></html>`;
  const config = { session, document, dto: { schemaVersion: 1, owner: entry.owner, version: entry.version, viewId: entry.view.id, windowId, title: entry.view.title, text: entry.view.text }, theme: { schemaVersion: 1, colorScheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light' } };
  return `<!doctype html><html><head>${meta}<title>Extension view</title></head><body><script type="application/json" id="panda-view-config">${json(config)}</script><script>${shell}</script></body></html>`;
}

/** Browser characterization only; native support never follows from `preview`. */
export async function openRichView(entry: RegisteredView): Promise<string> {
  if (!preview) {
    const reply = await call<{ opened: boolean; reason?: string }>('extensions_rich_view_open', { request: { viewId: entry.view.id, version: entry.version } });
    return reply.reason ?? '';
  }
  const snapshot = extensionsSnapshot();
  const rich = entry.view.rich;
  if (!rich) throw new Error('PermissionDenied');
  const active = snapshot.packages.find(item => item.enabled && item.manifest.id === entry.owner && item.manifest.version === entry.version && item.manifest.permissions?.includes('ui.richViews') && item.manifest.contributes.views?.some(view => view.id === entry.view.id && view.title === entry.view.title && view.text === entry.view.text && view.rich && view.rich.html === rich.html && view.rich.css === rich.css && view.rich.script === rich.script));
  if (snapshot.safeMode || !active) throw new Error('PermissionDenied');
  if (entry.owner !== 'sample.rich-view' || !new URLSearchParams(location.search).has('rich-view-characterization')) return RICH_VIEW_UNSUPPORTED;
  for (const [popup, dispose] of previewWindows) if (popup.closed) dispose();
  if (previewWindows.size >= 8) return 'The isolated extension window limit was reached. Close an extension window first.';
  // Reserve synchronously under a user gesture; assets are canonical fixtures, not localStorage markup.
  const popup = window.open('about:blank', '_blank', 'popup,width=760,height=560');
  if (!popup) return 'The extension window was blocked. Allow this explicit window or use the host-rendered view.';
  const unsubscribe = onExtensionChanged(entry.owner, () => { dispose(); popup.close(); });
  const dispose = () => { unsubscribe(); previewWindows.delete(popup); };
  previewWindows.set(popup, dispose);
  try {
    const assets = { html: (await import('../../tests/fixtures/extensions/rich-view/assets/view.html?raw')).default, css: (await import('../../tests/fixtures/extensions/rich-view/assets/view.css?raw')).default, script: (await import('../../tests/fixtures/extensions/rich-view/assets/view.js?raw')).default };
    const document = await richViewDocument(entry, assets, `extension-view-${crypto.randomUUID()}`);
    // Recheck after async composition: disable/update must not revive a stale window.
    if (popup.closed || !extensionsSnapshot().packages.some(item => item.enabled && item.manifest.id === entry.owner && item.manifest.version === entry.version)) { dispose(); popup.close(); return ''; }
    popup.opener = null; popup.document.open(); popup.document.write(document); popup.document.close();
    popup.addEventListener('pagehide', dispose, { once: true });
    return '';
  } catch (error) { dispose(); popup.close(); throw error; }
}
