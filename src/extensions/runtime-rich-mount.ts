/**
 * Trusted rich panels mounted in host surfaces (R0301, ADR-0001).
 *
 * A view with `rich` content mounts in the inspector, where its host-rendered view mounts, and keeps the separate
 * window. Two techniques, never confused:
 *
 * - `browser-iframe` (browser preview only): a sandboxed `allow-scripts` iframe of the host page whose document is the
 *   same isolated shell as the window. Evidence of this column is PREVIEW, never installed behaviour.
 * - `native-webview` (installed app): a child webview of the main window placed over the panel element
 *   (`extensions_rich_mount_open/bounds/close`), because the app's content policy keeps `frame-src 'none'`.
 *
 * Either way the panel needs an enabled package with trusted executable content and the `ui.richViews` grant; the
 * native side rechecks both on every open and every lifecycle change. A panel that throws, never starts or stops
 * beating is removed and shown as failed with a reload control; tasks, terminals and the draft are never touched.
 */
import { call, preview } from '../bridge';
import { pageZoom } from '../ui-size';
import { extensionsManagementSnapshot, extensionsSnapshot, onExtensionChanged } from './manager';
import { appearanceSnapshot, richViewDocument, type RichAssets } from './rich-views';
import { createRuntimeGrantsPreview, type SyncSnapshot } from './runtime-grants';
import { ASSET_RELOADABLE, assetEndedNote, assetRefusalNote, previewServedUrl, servedSource } from './runtime-rich-assets';
import type { RegisteredView } from './views-state';

export type MountTechnique = 'browser-iframe' | 'native-webview';
export type Authority = 'ok' | 'ExecutableTrustRequired' | 'PermissionDenied';
export const RICH_PERMISSION = 'ui.richViews';
/** Dispatched by the preview's grant command so a mounted panel rechecks its authority at once. */
export const GRANTS_CHANGED = 'pandacode-extension-grants-changed';
export const ENDED_EVENT = 'extensions-rich-mount-ended';
const FIRST_BEAT_MS = 10_000, SILENCE_MS = 6_000;

export const mountTechnique = (): MountTechnique => preview ? 'browser-iframe' : 'native-webview';

/** Preview assets: the preview has no package archive, so only these canonical fixtures can be mounted there. */
const PREVIEW_ASSETS: Record<string, () => Promise<RichAssets>> = {
  'sample.rich-mount/board': async () => ({
    html: (await import('../../tests/fixtures/extensions/runtime-rich-mount/assets/board.html?raw')).default,
    css: (await import('../../tests/fixtures/extensions/runtime-rich-mount/assets/board.css?raw')).default,
    script: (await import('../../tests/fixtures/extensions/runtime-rich-mount/assets/board.js?raw')).default,
  }),
  'sample.rich-view/report': async () => ({
    html: (await import('../../tests/fixtures/extensions/rich-view/assets/view.html?raw')).default,
    css: (await import('../../tests/fixtures/extensions/rich-view/assets/view.css?raw')).default,
    script: (await import('../../tests/fixtures/extensions/rich-view/assets/view.js?raw')).default,
  }),
};
/** R0302: a folder or remote view mounts from its package origin (the preview needs `?rich-assets`, see runtime-rich-assets.ts). */
export const previewMountable = (entry: RegisteredView) => entry.view.id in PREVIEW_ASSETS || !!servedSource(entry.view.rich);

/** The preview twin of `runtime_rich_mount::authorize`: enabled, trusted executable content, `ui.richViews` granted. */
export function previewAuthority(entry: RegisteredView): Authority {
  const snapshot = extensionsSnapshot();
  if (snapshot.safeMode) return 'PermissionDenied';
  const item = snapshot.packages.find(candidate => candidate.enabled && candidate.manifest.id === entry.owner && candidate.manifest.version === entry.version);
  if (!item) return 'PermissionDenied';
  if (!item.executable?.trusted) return 'ExecutableTrustRequired';
  const grants = createRuntimeGrantsPreview();
  grants.sync(extensionsManagementSnapshot() as unknown as SyncSnapshot);
  return grants.check(entry.owner, entry.version, RICH_PERMISSION) === 'ok' ? 'ok' : 'PermissionDenied';
}

export function refusalNote(code: string, owner: string): string {
  const asset = assetRefusalNote(code);
  if (asset) return asset;
  if (code.startsWith('ExecutableTrustRequired')) return `Review the executable trust of ${owner} in Settings → Extensions to show this panel. The host-rendered view stays available.`;
  if (code.startsWith('PermissionDenied')) return `Grant ui.richViews to ${owner} in Settings → Extensions to show this panel. The host-rendered view stays available.`;
  if (code.startsWith('UnsupportedRuntime')) return 'Rich panels are not qualified on this platform yet. The host-rendered view stays available.';
  if (code.startsWith('LimitExceeded')) return 'Too many extension panels are open. Close one, then reload this panel.';
  return 'The extension panel is unavailable. The host-rendered view stays available.';
}
const RELOADABLE = new Set<string>(['unresponsive', 'error', 'timeout', 'changed', ...ASSET_RELOADABLE]);
export function endedNote(reason: string): string {
  const asset = assetEndedNote(reason);
  if (asset) return asset;
  switch (reason) {
    case 'unresponsive': return 'The extension panel stopped responding and was closed. The rest of PandaCode is unaffected.';
    case 'error': return 'The extension panel failed and was closed. The rest of PandaCode is unaffected.';
    case 'timeout': return 'The extension panel did not start. The rest of PandaCode is unaffected.';
    case 'changed': return 'The package changed; reload the panel to show the new version.';
    case 'untrusted': return 'The panel was closed: its executable trust was withdrawn.';
    case 'revoked': return 'The panel was closed: ui.richViews was revoked.';
    case 'safe-mode': return 'The panel was closed: safe mode is on.';
    default: return 'The panel was closed: its package was disabled.';
  }
}

type Report = { kind: 'mounted'; id: string } | { kind: 'ended'; reason: string };
class Refusal extends Error {}
const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));

/** Browser preview: a sandboxed frame of the host page, with a host-side watchdog fed by the shell's beat. */
async function mountFrame(surface: HTMLElement, entry: RegisteredView, report: (event: Report) => void): Promise<() => void> {
  const authority = previewAuthority(entry);
  if (authority !== 'ok') throw new Refusal(authority);
  const served = !!servedSource(entry.view.rich);
  const load = PREVIEW_ASSETS[entry.view.id];
  if (!load && !served) throw new Refusal('UnsupportedRuntime');
  const id = `extension-panel-${crypto.randomUUID()}`;
  // R0302: a folder or remote view is the shell of its package origin (its own storage); a legacy view a composed document.
  const html = served || !load ? '' : await richViewDocument(entry, await load(), id);
  const src = served ? await previewServedUrl(entry, id) : '';
  // Recheck after the asynchronous composition: a disable or revoke in between must not revive the panel.
  const again = previewAuthority(entry);
  if (again !== 'ok') throw new Refusal(again);
  const frame = document.createElement('iframe');
  frame.className = 'extension-rich-panel-frame'; frame.title = `${entry.view.title} — ${entry.owner}`;
  // The served shell keeps its own (package) origin, which is never the app's: it still cannot reach this document.
  frame.setAttribute('sandbox', served ? 'allow-scripts allow-same-origin' : 'allow-scripts'); frame.referrerPolicy = 'no-referrer'; frame.dataset.mountId = id;
  let last = performance.now(), started = false, ended = false;
  const dispose = () => { window.clearInterval(timer); window.removeEventListener('message', onMessage); frame.remove(); };
  const end = (reason: string) => { if (ended) return; ended = true; dispose(); report({ kind: 'ended', reason }); };
  // Only the shell (the frame's own window) is heard; the package's nested frame has another source.
  const onMessage = (event: MessageEvent) => {
    if (event.source !== frame.contentWindow || !event.data || typeof event.data !== 'object' || event.data.schemaVersion !== 1) return;
    if (event.data.kind === 'beat') { last = performance.now(); started = true; }
    else if (event.data.kind === 'failed') end(['unresponsive', 'error', 'timeout', 'origin'].includes(event.data.reason) ? event.data.reason : 'error');
  };
  window.addEventListener('message', onMessage);
  const timer = window.setInterval(() => {
    if (document.hidden) { last = performance.now(); return; }
    if (performance.now() - last > (started ? SILENCE_MS : FIRST_BEAT_MS)) end('unresponsive');
  }, 1000);
  if (served) frame.src = src; else frame.srcdoc = html;
  surface.replaceChildren(frame);
  report({ kind: 'mounted', id });
  return () => { ended = true; dispose(); };
}

/** Native webviews sit above HTML: hide the panel when a modal, Settings or an overlapping menu covers it. */
function obscured(rect: { x: number; y: number; width: number; height: number }): boolean {
  if (document.querySelector('dialog[open], #settings-page:not([hidden]), #inspector[data-leaving]')) return true;
  const zoom = pageZoom();
  return [...document.querySelectorAll<HTMLElement>('.floating-menu:not([aria-hidden="true"]), .file-window:not([hidden])')].some(menu => {
    const box = menu.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && getComputedStyle(menu).visibility !== 'hidden'
      && box.left * zoom < rect.x + rect.width && box.right * zoom > rect.x && box.top * zoom < rect.y + rect.height && box.bottom * zoom > rect.y;
  });
}

/** Installed app: a child webview of the main window placed over `surface`, in window points. */
async function mountNative(surface: HTMLElement, entry: RegisteredView, report: (event: Report) => void): Promise<() => void> {
  await nextFrame();
  const measure = () => {
    const rect = surface.getBoundingClientRect(), zoom = pageZoom();
    return { x: Math.max(0, rect.x * zoom), y: Math.max(0, rect.y * zoom), width: Math.max(1, rect.width * zoom), height: Math.max(1, rect.height * zoom) };
  };
  let reply: { mounted: boolean; mountId?: string; reason?: string };
  try { reply = await call('extensions_rich_mount_open', { request: { viewId: entry.view.id, version: entry.version, placement: 'inspector', bounds: measure() } }); }
  catch (error) { throw new Refusal(String(error)); }
  if (!reply.mounted || !reply.mountId) throw new Refusal(reply.reason ?? 'UnsupportedRuntime');
  const mountId = reply.mountId;
  let disposed = false, lastKey = '', pending = 0;
  const sync = () => {
    if (disposed) return;
    const bounds = measure(), visible = surface.isConnected && surface.checkVisibility() && !obscured(bounds) && bounds.width > 1 && bounds.height > 1;
    const key = JSON.stringify({ ...bounds, visible });
    if (key === lastKey) return;
    lastKey = key;
    void call('extensions_rich_mount_bounds', { request: { mountId, bounds, visible } }).catch(() => {});
  };
  const schedule = () => { if (!disposed && !pending) pending = window.setTimeout(() => { pending = 0; sync(); }, 16); };
  const resize = new ResizeObserver(schedule); resize.observe(surface);
  const overlays = new MutationObserver(records => {
    const selector = '.floating-menu,.file-window,dialog,#settings-page,#inspector';
    if (records.some(record => record.type === 'attributes'
      ? record.target instanceof Element && record.target.matches(selector)
      : [...record.addedNodes, ...record.removedNodes].some(node => node instanceof Element && (node.matches(selector) || node.querySelector(selector))))) schedule();
  });
  overlays.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-hidden', 'open', 'style', 'hidden', 'data-popover-state', 'data-leaving'] });
  window.addEventListener('resize', schedule);
  const { listen } = await import('@tauri-apps/api/event');
  const unlisten = await listen<{ mountId: string; reason: string }>(ENDED_EVENT, event => {
    if (disposed || event.payload.mountId !== mountId) return;
    stop(); report({ kind: 'ended', reason: event.payload.reason });
  });
  const stop = () => {
    if (disposed) return;
    disposed = true; window.clearTimeout(pending); resize.disconnect(); overlays.disconnect(); window.removeEventListener('resize', schedule); unlisten();
  };
  if (disposed) return () => {};
  report({ kind: 'mounted', id: mountId });
  sync();
  return () => { const live = !disposed; stop(); if (live) void call('extensions_rich_mount_close', { mountId }).catch(() => {}); };
}

/**
 * Mounts `entry`'s panel in `slot` (inside the inspector view). The host-rendered text around it stays; a refusal,
 * a failure or a revoke leaves a note there instead of the panel. Returns the host-owned disposal.
 */
export function mountRichPanel(slot: HTMLElement, entry: RegisteredView): () => void {
  const controller = new AbortController(), { signal } = controller;
  let teardown: (() => void) | undefined, state: 'idle' | 'loading' | 'mounted' | 'failed' | 'refused' = 'idle', generation = 0;
  slot.classList.add('extension-rich-panel'); slot.dataset.richMount = mountTechnique();
  slot.setAttribute('role', 'region'); slot.setAttribute('aria-label', `${entry.view.title} panel — ${entry.owner}`);
  const surface = document.createElement('div'); surface.className = 'extension-rich-panel-surface';
  const size = entry.view.rich?.minSize;
  surface.style.minWidth = `${size?.width ?? 160}px`; surface.style.minHeight = `${size?.height ?? 240}px`;
  const note = document.createElement('p'); note.className = 'extension-rich-panel-note'; note.setAttribute('aria-live', 'polite');
  const reload = document.createElement('button'); reload.type = 'button'; reload.className = 'ds-btn'; reload.textContent = 'Reload panel'; reload.hidden = true;
  slot.replaceChildren(surface, note, reload);
  const clear = () => { teardown?.(); teardown = undefined; surface.replaceChildren(); };
  const say = (text: string, canReload: boolean) => { note.textContent = text; reload.hidden = !canReload; };
  const report = (ticket: number) => (event: Report) => {
    if (signal.aborted || ticket !== generation) return;
    if (event.kind === 'mounted') { state = 'mounted'; slot.dataset.mountId = event.id; say('', true); return; }
    clear(); delete slot.dataset.mountId; state = RELOADABLE.has(event.reason) ? 'failed' : 'refused';
    slot.dataset.richState = event.reason;
    say(endedNote(event.reason), RELOADABLE.has(event.reason));
  };
  const start = () => {
    if (signal.aborted) return;
    clear(); const ticket = ++generation; state = 'loading'; delete slot.dataset.richState;
    say('Loading the extension panel…', false);
    (preview ? mountFrame : mountNative)(surface, entry, report(ticket)).then(dispose => {
      if (signal.aborted || ticket !== generation) dispose(); else teardown = dispose;
    }, error => {
      if (signal.aborted || ticket !== generation) return;
      state = 'refused'; const code = error instanceof Error ? error.message : String(error);
      slot.dataset.richState = code.split(':')[0];
      say(refusalNote(code, entry.owner), false);
    });
  };
  // Lifecycle: a change of this package (disable, trust, update, safe mode) or of the grants rechecks the authority.
  const recheck = () => {
    if (signal.aborted) return;
    if (preview) {
      const authority = previewAuthority(entry);
      if (authority !== 'ok' && (state === 'mounted' || state === 'loading')) { generation++; clear(); delete slot.dataset.mountId; state = 'refused'; slot.dataset.richState = authority; say(refusalNote(authority, entry.owner), false); return; }
      if (authority === 'ok' && state === 'refused') start();
      return;
    }
    // Native: the host ends a mount it no longer allows (`extensions-rich-mount-ended`); a refused one may now open.
    if (state === 'refused') start();
  };
  const unsubscribe = onExtensionChanged(entry.owner, recheck);
  window.addEventListener(GRANTS_CHANGED, recheck, { signal });
  reload.addEventListener('click', start, { signal });
  queueMicrotask(start);
  return () => { controller.abort(); generation++; unsubscribe(); clear(); slot.replaceChildren(); };
}

const previewWindows = new Map<Window, () => void>();
window.addEventListener('pagehide', () => { for (const [popup, dispose] of previewWindows) { dispose(); popup.close(); } }, { once: true });

/**
 * The separate window placement. Installed: `extensions_rich_view_open`, which rechecks trust, the grant and the
 * qualification natively. Preview: the mount fixtures open only after trust and grant; other packages keep the
 * legacy characterization of `rich-views.ts`.
 */
export async function openRichWindow(entry: RegisteredView): Promise<string> {
  if (!preview || !previewMountable(entry) || entry.owner === 'sample.rich-view') return (await import('./rich-views')).openRichView(entry);
  const authority = previewAuthority(entry);
  if (authority !== 'ok') return refusalNote(authority, entry.owner);
  for (const [popup, dispose] of previewWindows) if (popup.closed) dispose();
  if (previewWindows.size >= 8) return 'The isolated extension window limit was reached. Close an extension window first.';
  const popup = window.open('about:blank', '_blank', 'popup,width=760,height=560');
  if (!popup) return 'The extension window was blocked. Allow this explicit window or use the host-rendered view.';
  const regrant = () => { if (previewAuthority(entry) !== 'ok') close(); };
  const updateTheme = () => { if (!popup.closed) popup.dispatchEvent(new CustomEvent('panda-view-theme', { detail: appearanceSnapshot() })); };
  const unsubscribe = onExtensionChanged(entry.owner, () => close());
  window.addEventListener(GRANTS_CHANGED, regrant); window.addEventListener('pandacode-palette-change', updateTheme);
  const dispose = () => { unsubscribe(); window.removeEventListener(GRANTS_CHANGED, regrant); window.removeEventListener('pandacode-palette-change', updateTheme); previewWindows.delete(popup); };
  const close = () => { dispose(); popup.close(); };
  previewWindows.set(popup, dispose);
  try {
    const label = `extension-view-${crypto.randomUUID()}`;
    // R0302: a folder or remote view opens the shell of its package origin (the same origin as its inspector panel).
    if (servedSource(entry.view.rich)) {
      const url = await previewServedUrl(entry, label);
      if (popup.closed || previewAuthority(entry) !== 'ok') { close(); return ''; }
      popup.opener = null; popup.location.href = url;
      return '';
    }
    const html = await richViewDocument(entry, await PREVIEW_ASSETS[entry.view.id](), label);
    if (popup.closed || previewAuthority(entry) !== 'ok') { close(); return ''; }
    popup.opener = null; popup.document.open(); popup.document.write(html); popup.document.close();
    popup.addEventListener('pagehide', dispose, { once: true });
    return '';
  } catch (error) {
    close();
    if (servedSource(entry.view.rich) && error instanceof Error) return refusalNote(error.message, entry.owner);
    throw error;
  }
}
