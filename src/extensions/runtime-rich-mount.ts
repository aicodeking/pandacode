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
import { followTheme, previewPanelHost } from './runtime-rich-channel';
import { bindPanelFocus, enterNative, forgetParked, fromFrame, minSize, parkNative, resumeNative, visibleBox } from './runtime-rich-focus';
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
  // R0304: the frame keeps rich.minSize and the slot scrolls around it (never scaled, nothing animates).
  const size = minSize(entry.view.rich);
  Object.assign(frame.style, { display: 'block', width: '100%', minWidth: `${size.width}px`, minHeight: `${size.height}px`, border: '0' });
  let last = performance.now(), started = false, ended = false;
  // R0303: a served shell talks to the page's panel host (instance, state, messages); the instance keeps its state
  // for a reload of this slot. Visibility follows the frame's box.
  const unbind = served ? previewPanelHost().bind(id, frame, { owner: entry.owner, version: entry.version, viewId: entry.view.id }) : () => {};
  const shown = new ResizeObserver(() => previewPanelHost().setVisible(id, frame.isConnected && frame.checkVisibility() && frame.clientWidth > 1 && frame.clientHeight > 1));
  if (served) { shown.observe(frame); followTheme(); }
  const dispose = () => { window.clearInterval(timer); window.removeEventListener('message', onMessage); shown.disconnect(); unbind(true); frame.remove(); };
  const end = (reason: string) => { if (ended) return; ended = true; dispose(); report({ kind: 'ended', reason }); };
  // Only the shell (the frame's own window) is heard; the package's nested frame has another source.
  const onMessage = (event: MessageEvent) => {
    if (event.source !== frame.contentWindow || !event.data || typeof event.data !== 'object' || event.data.schemaVersion !== 1) return;
    if (event.data.kind === 'beat') { last = performance.now(); started = true; }
    else if (event.data.kind === 'failed') end(['unresponsive', 'error', 'timeout', 'origin'].includes(event.data.reason) ? event.data.reason : 'error');
    // R0304: a key the page left alone, or releaseFocus.
    else if (!ended) fromFrame(id, event.data);
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

/**
 * An installed panel's webview, attached to one surface at a time. R0304: between surfaces it is parked natively
 * (hidden, document and focus kept; at most four in the app), so a tab or task switch does not reload it.
 */
type NativePanel = { readonly mountId: string; attach(surface: HTMLElement, report: (event: Report) => void): void; park(): void; close(): void };
const pageBox = (surface: HTMLElement) => {
  // The webview covers only what the scrolling ancestors leave visible; its shell scrolls to keep rich.minSize.
  const rect = visibleBox(surface), zoom = pageZoom();
  return { x: Math.max(0, rect.x * zoom), y: Math.max(0, rect.y * zoom), width: Math.max(1, rect.width * zoom), height: Math.max(1, rect.height * zoom) };
};
async function nativePanel(mountId: string, viewId: string): Promise<NativePanel> {
  let surface: HTMLElement | undefined, report: ((event: Report) => void) | undefined;
  let disposed = false, lastKey = '', pending = 0;
  const sync = () => {
    if (disposed || !surface) return;
    const bounds = pageBox(surface);
    // Hidden with the main window too (minimized or hidden), so visibility matches the window's state.
    const visible = !document.hidden && surface.isConnected && surface.checkVisibility() && !obscured(bounds) && bounds.width > 1 && bounds.height > 1;
    const key = JSON.stringify({ ...bounds, visible });
    if (key === lastKey) return;
    lastKey = key;
    void call('extensions_rich_mount_bounds', { request: { mountId, bounds, visible } }).catch(() => {});
  };
  const schedule = () => { if (!disposed && !pending) pending = window.setTimeout(() => { pending = 0; sync(); }, 16); };
  const resize = new ResizeObserver(schedule);
  const overlays = new MutationObserver(records => {
    const selector = '.floating-menu,.file-window,dialog,#settings-page,#inspector';
    if (records.some(record => record.type === 'attributes'
      ? record.target instanceof Element && record.target.matches(selector)
      : [...record.addedNodes, ...record.removedNodes].some(node => node instanceof Element && (node.matches(selector) || node.querySelector(selector))))) schedule();
  });
  const detach = () => {
    window.clearTimeout(pending); pending = 0; resize.disconnect(); overlays.disconnect();
    window.removeEventListener('resize', schedule); document.removeEventListener('visibilitychange', schedule); document.removeEventListener('scroll', schedule, true);
    surface = undefined; report = undefined; lastKey = '';
  };
  const { listen } = await import('@tauri-apps/api/event');
  const unlisten = await listen<{ mountId: string; reason: string }>(ENDED_EVENT, event => {
    if (disposed || event.payload.mountId !== mountId) return;
    // A parked panel that ends (closed beyond the four kept, a failure, a lifecycle end) is shown fresh next time.
    const tell = report; stop(); forgetParked(mountId); tell?.({ kind: 'ended', reason: event.payload.reason });
  });
  const stop = () => { if (disposed) return; disposed = true; detach(); unlisten(); };
  const panel: NativePanel = {
    mountId,
    attach(next, nextReport) {
      if (disposed) return;
      detach(); surface = next; report = nextReport;
      resize.observe(next);
      overlays.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-hidden', 'open', 'style', 'hidden', 'data-popover-state', 'data-leaving'] });
      window.addEventListener('resize', schedule); document.addEventListener('visibilitychange', schedule); document.addEventListener('scroll', schedule, { capture: true, passive: true });
      sync();
    },
    park() { if (disposed) return; detach(); void parkNative(viewId, panel); },
    close() { const live = !disposed; stop(); forgetParked(mountId); if (live) void call('extensions_rich_mount_close', { mountId }).catch(() => {}); },
  };
  return panel;
}

/** Installed app: a child webview of the main window placed over `surface`, in window points. */
async function mountNative(surface: HTMLElement, entry: RegisteredView, report: (event: Report) => void): Promise<(park?: boolean) => void> {
  await nextFrame();
  // R0304: the view's parked panel is shown again with its document; else a new mount (restored from its state).
  let panel = await resumeNative<NativePanel>(entry.view.id);
  if (!panel) {
    let reply: { mounted: boolean; mountId?: string; reason?: string };
    try { reply = await call('extensions_rich_mount_open', { request: { viewId: entry.view.id, version: entry.version, placement: 'inspector', bounds: pageBox(surface) } }); }
    catch (error) { throw new Refusal(String(error)); }
    if (!reply.mounted || !reply.mountId) throw new Refusal(reply.reason ?? 'UnsupportedRuntime');
    panel = await nativePanel(reply.mountId, entry.view.id);
  }
  const mounted = panel;
  report({ kind: 'mounted', id: mounted.mountId });
  // R0303: mounted panels follow the app's appearance (scheme and tokens), sent once and at every palette change.
  followTheme();
  mounted.attach(surface, report);
  return park => { if (park) mounted.park(); else mounted.close(); };
}

/**
 * Mounts `entry`'s panel in `slot` (inside the inspector view). The host-rendered text around it stays; a refusal,
 * a failure or a revoke leaves a note there instead of the panel. Returns the host-owned disposal.
 */
export function mountRichPanel(slot: HTMLElement, entry: RegisteredView): () => void {
  const controller = new AbortController(), { signal } = controller;
  let teardown: ((park?: boolean) => void) | undefined, state: 'idle' | 'loading' | 'mounted' | 'failed' | 'refused' = 'idle', generation = 0;
  slot.classList.add('extension-rich-panel'); slot.dataset.richMount = mountTechnique();
  slot.setAttribute('role', 'region'); slot.setAttribute('aria-label', `${entry.view.title} panel — ${entry.owner}`);
  const surface = document.createElement('div'); surface.className = 'extension-rich-panel-surface';
  // R0304: rich.minSize. The preview frame keeps it and the slot scrolls; an installed webview covers the visible part
  // of the surface and its shell scrolls to keep it (a webview cannot be clipped like an element). No layout animates.
  const size = minSize(entry.view.rich);
  slot.style.overflow = 'auto';
  if (preview) surface.style.minWidth = `${size.width}px`;
  surface.style.minHeight = `${size.height}px`;
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
  // R0304: the installed panel is one tab stop of the app; reaching it moves the keyboard into its webview.
  bindPanelFocus(slot, () => { const id = slot.dataset.mountId; if (state === 'mounted' && id) void enterNative(id); }, signal);
  queueMicrotask(start);
  // R0304: leaving the screen (a tab or task switch) parks a mounted installed panel instead of closing it.
  return () => {
    controller.abort(); generation++; unsubscribe();
    const dispose = teardown; teardown = undefined; dispose?.(state === 'mounted');
    surface.replaceChildren(); slot.replaceChildren();
  };
}

const previewWindows = new Map<Window, () => void>();
window.addEventListener('pagehide', () => { for (const [popup, dispose] of previewWindows) { dispose(); popup.close(); } }, { once: true });

/**
 * The separate window placement. Installed: `extensions_rich_view_open`, which rechecks trust, the grant and the
 * qualification natively. Preview: the mount fixtures open only after trust and grant; other packages keep the
 * legacy characterization of `rich-views.ts`.
 */
export async function openRichWindow(entry: RegisteredView): Promise<string> {
  // R0303: the window's panel follows the app's appearance as an inspector panel does.
  followTheme();
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
